/**
 * Re-read every emitted cell and assert the invariants the game will not check.
 *
 * `src/verify.js` checks that a cell *parses*. That is not the same question. A
 * lotpack can parse perfectly and still hand `IsoCell.PlaceLot` a room id that
 * indexes past the end of the room table, a room rect of zero width, or a tile
 * index with no entry in the header — none of which throw here and any of which
 * are the sort of thing that ends in a native fault rather than a stack trace.
 *
 * So this reads what was written with the readers that read vanilla, and checks
 * the things the writers are trusted about:
 *
 *   - every tile index in every square resolves to a name in the header table
 *   - every tile name resolves to a real tile in the install
 *   - every room id in every building graph exists
 *   - every room rect is positive and its level is inside min/maxLevel
 *   - every square's room id is -1 or a valid room
 *   - every chunk that has any authored square has all 64 columns filled at z=0,
 *     because a chunk with one hole reverts to procedural and takes the rest with it
 *   - the lotpack's level count matches the header's, or every read walks off the end
 *
 * Run: node tools/audit-cells.js [mapDir]
 */

import fs from 'node:fs';
import path from 'node:path';

import { readLotHeader, CELL_SIZE, CHUNK_SIZE, CHUNKS_PER_CELL } from '../src/formats/lotheader.js';
import { readLotPack } from '../src/formats/lotpack.js';
import { decodeChunkData } from '../src/emit/chunkdata.js';
import { loadTileCatalogue } from '../src/formats/tiledefs.js';
import { findInstall, findUserFolder, readMapTileNames } from '../src/lib/pzinstall.js';

const MOD_ID = 'pzworld';
const MAP_NAME = 'pzworld';

function main() {
  const mapDir =
    process.argv[2] ?? path.join(findUserFolder(), 'mods', MOD_ID, 'common/media/maps', MAP_NAME);
  const install = findInstall();
  const cat = loadTileCatalogue(install);
  const fromMaps = readMapTileNames(install);
  const tileExists = (n) => cat.tileExists(n) || fromMaps.has(n);

  const headers = fs
    .readdirSync(mapDir)
    .filter((f) => /^\d+_\d+\.lotheader$/.test(f))
    .sort();

  const problems = [];
  const note = (msg) => {
    if (problems.length < 40) problems.push(msg);
    else if (problems.length === 40) problems.push('...');
  };

  const stats = {
    cells: 0,
    authored: 0,
    rooms: 0,
    buildings: 0,
    squares: 0,
    maxTilesPerSquare: 0,
    maxLevelSeen: 0,
    unknownTiles: new Set(),
    partialChunks: 0,
    // Loot is distributed by room name onto container sprites, so "did the buildings
    // arrive whole" is answerable as a number rather than an assurance.
    containers: 0,
    roomNames: new Map(),
  };

  for (const file of headers) {
    const [cx, cy] = file.replace('.lotheader', '').split('_').map(Number);
    const header = readLotHeader(fs.readFileSync(path.join(mapDir, file)));
    stats.cells++;

    const levels = header.maxLevel - header.minLevel + 1;
    const isContainer = new Set();
    for (let i = 0; i < header.tiles.length; i++) {
      const name = header.tiles[i];
      if (!name) continue;
      if (!tileExists(name)) stats.unknownTiles.add(name);
      if (cat.tiles.get(name)?.props?.container) isContainer.add(i);
    }

    // --- rooms and the building graph ---------------------------------
    header.rooms.forEach((room, i) => {
      stats.rooms++;
      stats.roomNames.set(room.name, (stats.roomNames.get(room.name) ?? 0) + 1);
      if (room.level < header.minLevel || room.level > header.maxLevel) {
        note(`${file}: room ${i} "${room.name}" is on level ${room.level}, outside ${header.minLevel}..${header.maxLevel}`);
      }
      if (!room.rects.length) note(`${file}: room ${i} "${room.name}" has no rects`);
      for (const [x, y, w, h] of room.rects) {
        if (w <= 0 || h <= 0) note(`${file}: room ${i} "${room.name}" has a ${w}x${h} rect`);
        if (x < 0 || y < 0) note(`${file}: room ${i} "${room.name}" rect starts at ${x},${y}`);
      }
    });
    for (const building of header.buildings) {
      stats.buildings++;
      for (const id of building) {
        if (!(id >= 0 && id < header.rooms.length)) {
          note(`${file}: a building references room ${id}, and there are ${header.rooms.length}`);
        }
      }
    }

    // --- tile data ------------------------------------------------------
    const packFile = path.join(mapDir, `world_${cx}_${cy}.lotpack`);
    if (!fs.existsSync(packFile)) {
      note(`${file}: no world_${cx}_${cy}.lotpack beside it`);
      continue;
    }
    const pack = readLotPack(fs.readFileSync(packFile), { levels });
    if (pack.levels !== levels) {
      note(`${file}: header says ${levels} levels, lotpack read as ${pack.levels}`);
    }

    let cellHasContent = false;
    for (let ci = 0; ci < pack.chunks.length; ci++) {
      const chunk = pack.chunks[ci];
      if (!chunk) continue;

      let filledAtZero = 0;
      let anySquare = false;
      // World level 0, not level *index* 0 — a cell with a basement declares a negative
      // minLevel and its ground floor sits partway up the stack.
      const groundIndex = -header.minLevel;
      for (let li = 0; li < levels; li++) {
        for (let s = 0; s < CHUNK_SIZE * CHUNK_SIZE; s++) {
          const sq = chunk[li * CHUNK_SIZE * CHUNK_SIZE + s];
          if (!sq) continue;
          anySquare = true;
          stats.squares++;
          if (li === groundIndex) filledAtZero++;
          if (sq.tiles.length > stats.maxTilesPerSquare) stats.maxTilesPerSquare = sq.tiles.length;
          if (li + header.minLevel > stats.maxLevelSeen) stats.maxLevelSeen = li + header.minLevel;

          if (sq.roomId !== -1 && !(sq.roomId >= 0 && sq.roomId < header.rooms.length)) {
            note(`${file}: a square carries room id ${sq.roomId}, and there are ${header.rooms.length}`);
          }
          for (const t of sq.tiles) {
            if (!(t >= 0 && t < header.tiles.length)) {
              note(`${file}: tile index ${t} does not resolve (table has ${header.tiles.length})`);
            }
            if (isContainer.has(t)) stats.containers++;
          }
        }
      }
      if (!anySquare) continue;
      cellHasContent = true;
      if (filledAtZero !== CHUNK_SIZE * CHUNK_SIZE) {
        stats.partialChunks++;
        if (stats.partialChunks < 6) {
          const ccx = ci % CHUNKS_PER_CELL;
          const ccy = Math.floor(ci / CHUNKS_PER_CELL);
          note(
            `${file}: chunk ${ccx},${ccy} has ${filledAtZero} of 64 columns at z=0 — ` +
              'the game will discard the whole chunk and generate it procedurally',
          );
        }
      }
    }
    if (cellHasContent) stats.authored++;

    // --- chunkdata --------------------------------------------------------
    const cdFile = path.join(mapDir, `chunkdata_${cx}_${cy}.bin`);
    if (!fs.existsSync(cdFile)) {
      note(`${file}: no chunkdata_${cx}_${cy}.bin beside it`);
    } else {
      const buf = fs.readFileSync(cdFile);
      try {
        const decoded = decodeChunkData(buf);
        if (decoded.consumed !== buf.length) {
          note(`chunkdata_${cx}_${cy}.bin: ${buf.length - decoded.consumed} bytes left over`);
        }
      } catch (err) {
        note(`chunkdata_${cx}_${cy}.bin: ${err.message}`);
      }
    }
  }

  console.log(`audited ${stats.cells} cells in ${mapDir}`);
  console.log(
    `  ${stats.authored} carry tile data, ${stats.squares.toLocaleString()} squares, ` +
      `${stats.rooms.toLocaleString()} rooms in ${stats.buildings.toLocaleString()} buildings`,
  );
  console.log(`  deepest level ${stats.maxLevelSeen}, densest square ${stats.maxTilesPerSquare} tiles`);
  console.log(`  ${stats.containers.toLocaleString()} container tiles for the loot system to fill`);
  const rooms = [...stats.roomNames].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`  commonest room names: ${rooms.map(([k, v]) => `${k}:${v}`).join('  ')}`);
  if (stats.unknownTiles.size) {
    const sample = [...stats.unknownTiles].slice(0, 10).join(', ');
    console.log(`  ${stats.unknownTiles.size} tile names unknown to the install: ${sample}`);
  }
  if (stats.partialChunks) console.log(`  ${stats.partialChunks} partly filled chunks`);

  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems) console.log(`  ${p}`);
    process.exitCode = 1;
  } else {
    console.log('\nno problems found');
  }
}

main();
