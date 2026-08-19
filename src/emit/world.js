/**
 * Building the world as authored map cells.
 *
 * The order of the passes is the whole design, and each step exists because of
 * something the game does rather than something that seemed tidy:
 *
 *   1. **Surfaces.** A material per square over the whole footprint — grass, tarmac,
 *      pavement, water — decided from land cover and roads. Nothing is drawn yet. This
 *      grid is what the blend pass and the biome map both read, so they cannot disagree.
 *   2. **Buildings.** Stamped whole, every level, rooms registered in the header.
 *      They go first because a building owns its floor and the ground pass must not
 *      paint grass over a kitchen.
 *   3. **Roads and pavements**, on squares no building claimed.
 *   4. **Ground**, filling every square still empty at level 0.
 *   5. **Blends**, the edge and corner tiles between surfaces, laid over the base.
 *   6. **Biome map**, so the game does not discard what we just wrote.
 *
 * Step 6 is not optional and not cosmetic. `WorldGenChunk.genMapSquare` **discards and
 * regenerates** any square whose biome-map entry reads `$random` — grey 96, the value
 * the blank canvas ships everywhere. Authored squares must say something else.
 *
 * Step 4 is not optional either. `IsoChunk.hasEmptySquaresOnLevelZero()` is true if
 * *any* of a chunk's 64 columns is empty, and `generateChunks` then throws the whole 8x8
 * chunk at the procedural generator. A single missing floor square reverts its chunk.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CELL_SIZE, emptyLotHeader, readLotHeader, writeLotHeader } from '../formats/lotheader.js';
import { emptyLotPack, writeLotPack } from '../formats/lotpack.js';
import { encodeIndexedPng } from '../formats/png.js';
import { CellGrid } from './lotpack.js';
import { encodeChunkData } from './chunkdata.js';
import { loadBlendSets, baseTile, blendOverlays } from '../plan/blends.js';
import {
  plantAt,
  vegetationFields,
  PLANTABLE,
  PLANT_POOLS,
  DENSITY_TOWN,
  DENSITY_WILD,
} from '../plan/vegetation.js';
import { roadWearAt, WEAR_EFFECTS } from '../plan/decay.js';
import {
  loadSemanticRegistry,
  resolveSemantic,
  selectSemanticVariant,
} from '../catalogue/semantic-registry.js';
import { terrainFields } from '../plan/terrain-fields.js';
import { FLOOR, FLOOR_FURNITURE, FLOOR_OVERLAY, FURNITURE } from '../prefab/layers.js';
import { blockTiles } from '../extract/building.js';

/** `$random` in `BiomeMapConfig.lua` — what the blank canvas says everywhere. */
const BLANK_BIOME = 96;

/**
 * The surfaces the generator can lay, and how each maps into the blend system.
 *
 * `blend` is a `FloorMaterial` from `blends_*`; a surface without one is outside the
 * blend system entirely — it receives overlays from its neighbours but never paints one,
 * which is what vanilla does with pavement (it uses kerbs there instead).
 *
 * ## The biome value decides whether anything grows, and it was wrong
 *
 * `media/lua/server/metazones/BiomeMapConfig.lua` is the whole table, and two of the
 * values here spawned nothing at all:
 *
 *     64   zone = ForagingNav, **no biome key**     — nothing grows
 *     254  biome = dirt        "will not spawn anything", says the file itself
 *     115  biome = townhouse,  zone = TownZone      — sparse town planting
 *     255  biome = primary_forest, ore = map_deep_forest, zone = DeepForest
 *     243  biome = organic_forest                   — lighter woodland
 *     96   biome = $random                          — the blank canvas; unusable here,
 *                                                     `genMapSquare` discards authored
 *                                                     squares marked with it
 *
 * Grass was 115 everywhere, so the entire authored footprint — town and countryside
 * alike — was one continuous `TownZone` of townhouse planting: no trees, no shrubs, no
 * rocks, and a zombie distribution spread over 31 million squares instead of over the
 * town.
 *
 * So grass carries two values and the built-up mask picks between them: the town is
 * `TownZone`, everything else is forest. `biomeWild` is what a surface becomes outside
 * the town; a surface with only `biome` means the same either way.
 */
/** Materials that take a grime or cracked overlay on top of their own tile. */
const WEARABLE_SURFACES = new Set(['road', 'roadWorn', 'roadPatched', 'gravel']);

export const SURFACES = {
  grass: { blend: 'Grass_Dark', biome: 115, biomeWild: 255 },
  grassLight: { blend: 'Grass_Light', biome: 115, biomeWild: 243 },
  meadow: { blend: 'Grass_Medium', biome: 115, biomeWild: 243 },
  // Worn earth showing through grass. 4.5% of Muldraugh's natural ground, and
  // the reason its fields do not read as one flat colour.
  dirtGrass: { blend: 'Dirt_Grass', biome: 115, biomeWild: 243 },
  dirt: { blend: 'Dirt', biome: 254 },
  sand: { blend: 'Sand', biome: 254 },
  gravel: { blend: 'Road_04', biome: 254 },
  road: { blend: 'Road_06', biome: 254 },
  // Two more asphalts, because a vanilla town road is 46% Road_06, 34% Road_07
  // and 20% Road_04 laid in patches — that mottling is what "the road decays"
  // looks like, and one flat material is what it looked like without them.
  roadWorn: { blend: 'Road_07', biome: 254 },
  roadPatched: { blend: 'Road_04', biome: 254 },
  water: { blend: 'Water', biome: 0 },
  pavement: { blend: null, biome: 254 },
};

const SURFACE_IDS = Object.keys(SURFACES);
const SURFACE_ID = new Map(SURFACE_IDS.map((name, i) => [name, i + 1]));

/** Compact provenance labels used to keep later decoration inside its ownership lane. */
const OWNER_IDS = ['natural', 'managed', 'farmland', 'water', 'built', 'road'];
const OWNER_ID = new Map(OWNER_IDS.map((name, i) => [name, i + 1]));

const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'residential', 'service', 'track', 'footway', 'cycleway'];
const ROAD_CLASS_ID = new Map(ROAD_CLASSES.map((name, i) => [name, i + 1]));
const ROAD_CONDITIONS = ['excellent', 'good', 'average', 'worn', 'poor', 'damaged'];
const ROAD_CONDITION_ID = new Map(ROAD_CONDITIONS.map((name, i) => [name, i + 1]));
const clamp01 = (value) => Math.max(0, Math.min(1, value));

/**
 * A material per square across the authored footprint.
 *
 * One byte a square: 26 MB for a 2,500 m city, which is nothing beside the cell data it
 * produces and far cheaper than asking the planner the same question eight times.
 */
export class SurfaceGrid {
  constructor(bounds) {
    this.minX = bounds.minX;
    this.minY = bounds.minY;
    this.w = bounds.maxX - bounds.minX + 1;
    this.h = bounds.maxY - bounds.minY + 1;
    this.data = new Uint8Array(this.w * this.h);
    this.owners = new Uint8Array(this.w * this.h);
    // Allocated lazily by the road planner. Keeping the contextual fields compact avoids
    // a Map/object allocation for every carriageway square in a city-sized footprint.
    this.roadClasses = null;
    this.roadTraffic = null;
    this.roadConditions = null;
    this.roadEdges = null;
    this.roadJunctions = null;
  }

  inside(x, y) {
    return x >= this.minX && y >= this.minY && x < this.minX + this.w && y < this.minY + this.h;
  }

  set(x, y, surface, owner = null) {
    if (!this.inside(x, y)) return;
    const i = (y - this.minY) * this.w + (x - this.minX);
    this.data[i] = SURFACE_ID.get(surface) ?? 0;
    if (owner !== null) this.owners[i] = OWNER_ID.get(owner) ?? 0;
  }

  get(x, y) {
    if (!this.inside(x, y)) return null;
    const id = this.data[(y - this.minY) * this.w + (x - this.minX)];
    return id ? SURFACE_IDS[id - 1] : null;
  }

  ownerAt(x, y) {
    if (!this.inside(x, y)) return null;
    const id = this.owners[(y - this.minY) * this.w + (x - this.minX)];
    return id ? OWNER_IDS[id - 1] : null;
  }

  /** Retain compact road semantics for decoration passes after geometry is complete. */
  setRoadContext(x, y, context) {
    if (!this.inside(x, y)) return;
    if (!this.roadClasses) {
      const size = this.w * this.h;
      this.roadClasses = new Uint8Array(size);
      this.roadTraffic = new Uint8Array(size);
      this.roadConditions = new Uint8Array(size);
      this.roadEdges = new Uint8Array(size);
      this.roadJunctions = new Uint8Array(size).fill(255);
    }
    const i = (y - this.minY) * this.w + (x - this.minX);
    const classId = ROAD_CLASS_ID.get(context.roadClass) ?? 0;
    // At overlaps retain the busier/higher-class road and the nearest junction.
    if (!this.roadClasses[i] || (context.traffic ?? 0) >= this.roadTraffic[i] / 255) {
      this.roadClasses[i] = classId;
      this.roadTraffic[i] = Math.round(clamp01(context.traffic ?? 0) * 255);
      this.roadConditions[i] = ROAD_CONDITION_ID.get(context.condition) ?? ROAD_CONDITION_ID.get('average');
      this.roadEdges[i] = Math.round(clamp01(context.edge ?? 0) * 255);
    } else {
      this.roadEdges[i] = Math.max(this.roadEdges[i], Math.round(clamp01(context.edge ?? 0) * 255));
    }
    this.roadJunctions[i] = Math.min(this.roadJunctions[i], Math.round(Math.min(254, context.junctionDistance ?? 254)));
  }

  roadContextAt(x, y) {
    if (!this.inside(x, y) || !this.roadClasses) return null;
    const i = (y - this.minY) * this.w + (x - this.minX);
    if (!this.roadClasses[i]) return null;
    return {
      roadClass: ROAD_CLASSES[this.roadClasses[i] - 1],
      traffic: this.roadTraffic[i] / 255,
      condition: ROAD_CONDITIONS[this.roadConditions[i] - 1] ?? 'average',
      edge: this.roadEdges[i] / 255,
      junctionDistance: this.roadJunctions[i],
    };
  }

  fill(surface, owner = null) {
    this.data.fill(SURFACE_ID.get(surface) ?? 0);
    this.owners.fill(OWNER_ID.get(owner) ?? 0);
  }

  /** The blend material of a square, for the autotiler. */
  materialAt(x, y) {
    const s = this.get(x, y);
    return s ? SURFACES[s].blend : null;
  }
}

/**
 * @param {object} opts
 * @param {SurfaceGrid} opts.surfaces
 * @param {{block: object, x: number, y: number, cls: string}[]} opts.buildings  placed, already rotated
 * @param {import('../formats/tiledefs.js').TileCatalogue} opts.catalogue
 * @param {string} opts.mapDir  where to write
 */
export function emitWorld({
  surfaces,
  buildings = [],
  roadworks = null,
  catalogue,
  mapDir,
  log = () => {},
  onProgress = () => {},
  builtUp = () => true,
  seed = '',
  semanticRegistry = loadSemanticRegistry(),
}) {
  const sets = loadBlendSets(catalogue);
  // No level range: each cell takes the one its content needs, so a building with a
  // basement keeps it and a cell of plain grass declares a single level.
  const grid = new CellGrid();
  const wearStats = Object.fromEntries(WEAR_EFFECTS.map((effect) => [effect, 0]));
  const stats = {
    buildings: 0,
    buildingSquares: 0,
    ground: 0,
    blends: 0,
    rooms: 0,
    vegetation: 0,
    rocks: 0,
    decay: 0,
    roadSurfaces: 0,
    roadOverlays: 0,
    roadFurniture: 0,
    roadWear: wearStats,
  };

  /**
   * The sprites the road renderer chose, indexed by square.
   *
   * `Floor` entries replace the ground pass's own choice on hard surfaces, so a
   * carriageway square carries the asphalt variant the renderer picked rather
   * than a second, unrelated one. Soft bands — a planted median, a grassy verge
   * — deliberately fall through to the terrain-driven base tile instead, so they
   * read as the countryside they interrupt rather than as a stripe of one tile.
   */
  const paint = roadworks?.canvas ?? null;
  const paintAt = (x, y) => (paint ? paint.get(x, y) : null);

  /**
   * Where a building stands, kept apart from what the ground is made of.
   *
   * These are two different questions and folding them into one grid answered both
   * wrongly. A building is not a *surface*: it does not blend with the grass around it,
   * but the squares under it still need ground wherever the building itself has no
   * floor — an unroofed courtyard, or a margin square carrying only a wall. Marking the
   * footprint as its own surface with no tile left exactly those squares empty, and an
   * empty square at level 0 hands its whole 8x8 chunk back to the procedural generator.
   */
  const occupied = new Uint8Array(surfaces.w * surfaces.h);
  const markOccupied = (x, y) => {
    if (!surfaces.inside(x, y)) return;
    occupied[(y - surfaces.minY) * surfaces.w + (x - surfaces.minX)] = 1;
  };
  const isOccupied = (x, y) =>
    surfaces.inside(x, y) && occupied[(y - surfaces.minY) * surfaces.w + (x - surfaces.minX)] === 1;

  for (const { block, x, y } of buildings) {
    for (let by = 0; by < block.h; by++) {
      for (let bx = 0; bx < block.w; bx++) markOccupied(x + bx, y + by);
    }
  }

  // ---- 2. buildings ------------------------------------------------------
  for (const placed of buildings) {
    const { block, x, y } = placed;
    for (let level = block.minLevel; level <= block.maxLevel; level++) {
      for (let by = 0; by < block.h; by++) {
        for (let bx = 0; bx < block.w; bx++) {
          const tiles = blockTiles(block, bx, by, level);
          if (!tiles?.length) continue;
          if (grid.setSquare(x + bx, y + by, level, tiles)) stats.buildingSquares++;
        }
      }
    }
    if (block.rooms.length) stats.rooms += grid.addBuilding(x, y, block.rooms);
    stats.buildings++;
    // Every loop in this file reports as it runs. A build screen showing one
    // unchanging line for minutes is indistinguishable from a crash, and was
    // reported as one twice.
    if (stats.buildings % 100 === 0) {
      onProgress({
        stage: 'stamping',
        progress: 0.66 + 0.04 * (stats.buildings / Math.max(1, buildings.length)),
        message: `Stamping building ${stats.buildings} of ${buildings.length}`,
      });
    }
  }
  log(`stamped ${stats.buildings} buildings, ${stats.buildingSquares} squares, ${stats.rooms} rooms`);

  // ---- 4. ground ---------------------------------------------------------
  // Every square the footprint covers that nothing has claimed. Without this the
  // chunk is incomplete at level 0 and the game regenerates it procedurally.
  //
  // Which of a material's four variants lands on a square is a plain per-square
  // choice, because that is what vanilla measurably does — see `baseTile`. The
  // patches a player sees are the *material* changing, and that decision was
  // already made in `src/plan/surfaces.js` before a tile was laid. Roads then
  // take a finer field of wear on top.
  const terrain = terrainFields(seed);
  onProgress({ stage: 'stamping', progress: 0.70, message: 'Laying the ground' });
  for (let y = surfaces.minY; y < surfaces.minY + surfaces.h; y++) {
    if ((y - surfaces.minY) % 128 === 0) {
      onProgress({
        stage: 'stamping',
        progress: 0.70 + 0.02 * ((y - surfaces.minY) / surfaces.h),
        message: `Laying the ground  (${Math.round(100 * (y - surfaces.minY) / surfaces.h)}%)`,
      });
    }
    for (let x = surfaces.minX; x < surfaces.minX + surfaces.w; x++) {
      if (grid.hasSquare(x, y, 0)) continue;
      const name = surfaces.get(x, y);
      if (!name) continue;
      const surface = SURFACES[name];
      // A material inside the blend system takes its own dithered variant, so a
      // verge is the same grass as the field it runs through and tarmac varies
      // the way vanilla's does. Only a material outside that system — pavement —
      // takes the sprite the road renderer chose for it.
      const painted = surface.blend ? null : paintAt(x, y)?.[FLOOR];
      const tile = painted ?? (surface.blend
        ? baseTile(sets.get(surface.blend), x, y)
        : selectSemanticVariant(
          resolveSemantic(semanticRegistry, 'surface.base', { surface: name }),
          `${seed}:${x},${y}`,
        ));
      if (!tile) continue;
      if (grid.putSquare(x, y, 0, [tile])) stats.ground++;
      if (painted) stats.roadSurfaces++;

      if (WEARABLE_SURFACES.has(name)) {
        const context = surfaces.roadContextAt(x, y) ?? {};
        const wear = roadWearAt(
          x,
          y,
          terrain,
          { ...context, surface: name === 'gravel' ? 'gravel' : 'road' },
          seed,
          semanticRegistry,
        );
        if (wear && grid.setSquare(x, y, 0, [wear.tile])) {
          stats.decay++;
          stats.roadWear[wear.effect]++;
        }
      }
    }
  }
  log(`laid ${stats.ground} squares of ground, ${stats.decay} of them worn`);

  onProgress({ stage: 'stamping', progress: 0.72, message: 'Blending the edges between surfaces' });

  // ---- 5. blends ---------------------------------------------------------
  // Only on squares whose floor we laid — a building's own floor is interior and
  // takes no edge tiles.
  const materialAt = (x, y) => surfaces.materialAt(x, y);
  /** Squares the road renderer put something on top of; nothing may be planted there. */
  const decorated = new Set();
  for (let y = surfaces.minY; y < surfaces.minY + surfaces.h; y++) {
    if ((y - surfaces.minY) % 128 === 0) {
      onProgress({
        stage: 'stamping',
        progress: 0.72 + 0.03 * ((y - surfaces.minY) / surfaces.h),
        message: `Blending the edges between surfaces  (${Math.round(100 * (y - surfaces.minY) / surfaces.h)}%)`,
      });
    }
    for (let x = surfaces.minX; x < surfaces.minX + surfaces.w; x++) {
      // A building's own floor is interior and takes no edge tiles.
      if (isOccupied(x, y)) continue;
      const overlays = blendOverlays(sets, materialAt, x, y);
      if (!overlays.length) continue;
      grid.setSquare(x, y, 0, overlays);
      stats.blends += overlays.length;
    }
  }
  log(`laid ${stats.blends} blend overlays`);

  // ---- 5a. road artwork --------------------------------------------------
  // Kerbs, lane lines, the grass feathering onto the outer edge of a pavement,
  // bridge barriers, stop signs and street lamps. These go on *after* the blend
  // pass, because a blend overlay describes the ground and these describe what
  // is standing on it — and a kerb under a grass edge is a kerb nobody sees.
  //
  // Nothing is stamped on a square a building owns: a placed prefab is complete,
  // and a kerb laid through its wall is the defect that made pavements run
  // across junctions the first time round.
  if (paint) {
    for (const { x, y, layers } of paint.entries()) {
      if (!surfaces.inside(x, y) || isOccupied(x, y)) continue;
      const overlay = layers[FLOOR_OVERLAY];
      const furniture = layers[FLOOR_FURNITURE];
      const object = layers[FURNITURE];
      if (!overlay && !furniture && !object) continue;
      // Order is draw order: the ground overlay first, then what stands on it.
      const tiles = [overlay, furniture, object].filter(Boolean);
      if (!grid.hasSquare(x, y, 0)) continue;
      grid.setSquare(x, y, 0, tiles);
      if (overlay) stats.roadOverlays++;
      if (furniture || object) stats.roadFurniture++;
      decorated.add(`${x},${y}`);
    }
  }
  log(
    `laid ${stats.roadSurfaces} road surfaces, ${stats.roadOverlays} markings and edges, ` +
      `${stats.roadFurniture} kerbs, signs and lamps`,
  );

  // ---- 5b. vegetation ----------------------------------------------------
  // Trees, shrubs and groundcover, as tiles on top of the grass. The biome map does
  // not put them on authored ground — see src/plan/vegetation.js for the measurement
  // that settled it. Nothing is planted on tarmac, on pavement, or under a building.
  onProgress({ stage: 'stamping', progress: 0.75, message: 'Planting trees and undergrowth' });
  const fields = vegetationFields(seed, terrain);
  for (let y = surfaces.minY; y < surfaces.minY + surfaces.h; y++) {
    if ((y - surfaces.minY) % 128 === 0) {
      onProgress({
        stage: 'stamping',
        progress: 0.75 + 0.03 * ((y - surfaces.minY) / surfaces.h),
        message: `Planting trees and undergrowth  (${Math.round(100 * (y - surfaces.minY) / surfaces.h)}%)`,
      });
    }
    for (let x = surfaces.minX; x < surfaces.minX + surfaces.w; x++) {
      if (isOccupied(x, y)) continue;
      if (!PLANTABLE.has(surfaces.get(x, y))) continue;
      // A verge is plantable and a verge carrying a street lamp is not.
      if (decorated.has(`${x},${y}`)) continue;
      const owner = surfaces.ownerAt(x, y);
      // Farmland and hard authored features retain exclusive ownership. Generic trees
      // must not occupy future crop rows, water, parking, roads, or construction sites.
      if (owner === 'farmland' || owner === 'water' || owner === 'built' || owner === 'road') continue;
      const inTown = builtUp(x, y);
      const density = owner === 'managed' || inTown ? DENSITY_TOWN : DENSITY_WILD;
      const pool = owner === 'managed' ? PLANT_POOLS.managed : inTown ? PLANT_POOLS.town : PLANT_POOLS.wild;
      const tile = plantAt(x, y, density, seed, fields, pool);
      if (!tile) continue;
      if (grid.setSquare(x, y, 0, [tile])) {
        if (tile.startsWith('boulders')) stats.rocks++;
        else stats.vegetation++;
      }
    }
  }
  log(`planted ${stats.vegetation} trees, shrubs and groundcover; ${stats.rocks} boulders on outcrops`);

  // ---- write -------------------------------------------------------------
  // The zombie intensity field is laid over the finished cells rather than
  // stamped as each building lands, because it decays for twelve chunks outward
  // from built-up land and has to cross cell boundaries to do it.
  const population = grid.applyPopulation(seed);
  if (population) {
    log(`zombie intensity: ${population.populated} of ${population.chunks} chunks populated `
      + `(${(100 * population.populated / population.chunks).toFixed(1)}%), mean ${population.mean.toFixed(2)}`);
    stats.populatedChunks = population.populated;
  }
  onProgress({ stage: 'cells', progress: 0.78, message: `Writing ${grid.cells.size} map cells` });
  const written = grid.write(mapDir, {
    log,
    onCell: (done, total) => {
      if (done % 16 !== 0) return;
      onProgress({
        stage: 'cells',
        progress: 0.78 + 0.10 * (done / total),
        message: `Writing map cell ${done} of ${total}`,
      });
    },
  });
  onProgress({ stage: 'cells', progress: 0.88, message: 'Writing the biome maps' });
  writeBiomeMaps(surfaces, grid, mapDir, log, builtUp, (done, total) => onProgress({
    stage: 'cells',
    progress: 0.88 + 0.04 * (done / total),
    message: `Writing biome map ${done} of ${total}`,
  }));
  const cleared = clearStaleCells(mapDir, grid, log);

  return { ...stats, ...written, cleared };
}

/**
 * Return to blank canvas every cell an earlier build authored and this one does not.
 *
 * Cells are rewritten **in place** over the shipped canvas, which is what makes the
 * whole approach work — but it also means nothing is ever removed. Two builds of the
 * same city with different footprints leave both of them in the map directory, and the
 * player gets a second, older copy of the town a few kilometres away, written by
 * whatever the code did last time. Measured after moving the city from the canvas corner
 * to the centre: 483 stale cells, a complete duplicate Plattsburgh at cells 0..21.
 *
 * The biome map has to go back too, or the abandoned ground stays marked as town and
 * `genMapSquare` populates it as such.
 */
export function clearStaleCells(mapDir, grid, log = () => {}) {
  const keep = new Set([...grid.cells.values()].map((b) => `${b.cx}_${b.cy}`));
  const blankHeader = writeLotHeader(emptyLotHeader([]));
  const blankPack = writeLotPack(emptyLotPack(1));
  const blankChunkData = encodeChunkData(new Uint8Array(CELL_SIZE * CELL_SIZE));
  const blankBiome = encodeIndexedPng({
    width: CELL_SIZE,
    height: CELL_SIZE,
    pixels: new Uint8Array(CELL_SIZE * CELL_SIZE).fill(BLANK_BIOME),
  });

  let cleared = 0;
  for (const file of fs.readdirSync(mapDir)) {
    const m = /^(\d+)_(\d+)\.lotheader$/.exec(file);
    if (!m) continue;
    const key = `${m[1]}_${m[2]}`;
    if (keep.has(key)) continue;
    // A cell that is already blank is the overwhelming majority; reading the header is
    // far cheaper than rewriting 4,000 files that are already right.
    const header = readLotHeader(fs.readFileSync(path.join(mapDir, file)));
    if (!header.tiles.length && !header.rooms.length) continue;

    fs.writeFileSync(path.join(mapDir, file), blankHeader);
    fs.writeFileSync(path.join(mapDir, `world_${key}.lotpack`), blankPack);
    fs.writeFileSync(path.join(mapDir, `chunkdata_${key}.bin`), blankChunkData);
    fs.writeFileSync(path.join(mapDir, 'maps', `biomemap_${key}.png`), blankBiome);
    cleared++;
  }
  if (cleared) log(`cleared ${cleared} cells left behind by an earlier build`);
  return cleared;
}

/**
 * A biome PNG per authored cell.
 *
 * 96 is `$random`, and a square marked `$random` is thrown away and regenerated by
 * `genMapSquare` no matter what we authored there. So every square inside the footprint
 * gets a real value, taken from the same surface grid the tiles came from.
 */
export function writeBiomeMaps(
  surfaces, grid, mapDir, log = () => {}, builtUp = () => true, onProgress = () => {},
) {
  const biomeDir = path.join(mapDir, 'maps');
  fs.mkdirSync(biomeDir, { recursive: true });

  let cells = 0;
  const total = grid.cells.size;
  const counts = new Map();
  for (const builder of grid.cells.values()) {
    // A PNG per cell, each 65,536 pixels: twenty seconds on a city, and it used
    // to be twenty seconds of an unchanging screen.
    if (cells % 16 === 0) onProgress(cells, total);
    const pixels = new Uint8Array(CELL_SIZE * CELL_SIZE).fill(96);
    const ox = builder.cx * CELL_SIZE;
    const oy = builder.cy * CELL_SIZE;
    for (let ly = 0; ly < CELL_SIZE; ly++) {
      for (let lx = 0; lx < CELL_SIZE; lx++) {
        const name = surfaces.get(ox + lx, oy + ly);
        if (!name) continue;
        const surface = SURFACES[name];
        // Town or countryside. Only the planted surfaces differ; tarmac is tarmac.
        const pixel =
          surface.biomeWild !== undefined && !builtUp(ox + lx, oy + ly)
            ? surface.biomeWild
            : surface.biome;
        pixels[ly * CELL_SIZE + lx] = pixel;
        counts.set(pixel, (counts.get(pixel) ?? 0) + 1);
      }
    }
    fs.writeFileSync(
      path.join(biomeDir, `biomemap_${builder.cx}_${builder.cy}.png`),
      encodeIndexedPng({ width: CELL_SIZE, height: CELL_SIZE, pixels }),
    );
    cells++;
  }
  const breakdown = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${p}:${(n / 1e6).toFixed(1)}M`)
    .join('  ');
  log(`wrote ${cells} biome maps — ${breakdown}`);
  return cells;
}
