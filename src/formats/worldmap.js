/**
 * `worldmap.xml.bin` — the file Project Zomboid actually draws the map from.
 *
 * ## Why this exists rather than just shipping the XML
 *
 * `WorldMapDataAssetManager.startLoading` picks the reader like this:
 *
 *     if (Files.exists(path + ".bin")) new FileTask_LoadWorldMapBinary(...)
 *     else                             new FileTask_LoadWorldMapXML(...)
 *
 * Every shipped map has a `.bin`, so the XML reader is never exercised — and it
 * is broken. Compare the two readers at the point they hand a ring of points to
 * `WorldMapPoints.setPoints(short firstPoint, short pointCount)`:
 *
 *     WorldMapBinary.parseGeometryCoordinates:
 *         short n = readShort();                  // a POINT count
 *         setPoints((short)buffer.position(), (short)n);
 *
 *     WorldMapXML.parseGeometryCoordinates:
 *         int before = buffer.position();
 *         ...write 2 shorts per point...
 *         setPoints((short)before, (short)(buffer.position() - before));
 *                                              // ^ a SHORT count, i.e. 2n
 *
 * `WorldMapPoints.getX(i)` reads `buffer.get(firstPoint + i * 2)` and
 * `calculateBounds` loops `i` to `numPoints()`, so the XML path walks twice as
 * far as it wrote and runs off the end of the cell's point buffer. Every
 * feature throws `IndexOutOfBoundsException` out of `WorldMapXML.parseFeature`,
 * and the map comes up blank — 32,670 of them in one session here.
 *
 * No arrangement of XML avoids it: the over-read is exactly proportional to the
 * data, so padding cannot outrun it. The binary form is the only one that works.
 *
 * ## Why the helper writes it and the mod does not
 *
 * `getModFileWriter` returns an `OutputStreamWriter` over **UTF-8**
 * (DEV_GUIDE §1.6), so any byte above 0x7F comes out as two, and a map
 * coordinate of 200 is 0xC8. Lua can write the XML and nothing else. This is
 * the same reason the helper does the network fetch: it is the half of the mod
 * that is allowed to touch bytes and sockets.
 *
 * ## Layout (version 2)
 *
 * All integers little-endian. Traced from `zombie.worldMap.WorldMapBinary`.
 *
 *     "IGMB"                         magic
 *     int32   version                must be 2; version 1 is rejected by name
 *                                    as "cell size 300", i.e. Build 41
 *     int32   cellSize               must be 256
 *     int32   widthInCells
 *     int32   heightInCells
 *     int32   stringCount
 *       stringCount x:
 *         int16 byteLength
 *         byteLength bytes           UTF-8, read by GameWindow.ReadString
 *     widthInCells * heightInCells records, y-major:
 *         int32 cellX                -1 means "no cell here", nothing follows
 *         int32 cellY
 *         int32 featureCount
 *           featureCount x:
 *             int16 typeStringIndex  "Polygon" / "LineString" / "Point"
 *             int8  ringCount        rings of coordinates in this geometry
 *               ringCount x:
 *                 int16 pointCount
 *                   pointCount x: int16 x, int16 y     cell-local squares
 *             int8  propertyCount
 *               propertyCount x: int16 keyIndex, int16 valueIndex
 *
 * ## The record grid does not start at cell 0,0
 *
 * `widthInCells`/`heightInCells` are a *count of records*, and the `cellX`,
 * `cellY` inside each record are **absolute** world cell coordinates. The grid
 * covers `[originX, originX+width) x [originY, originY+height)` where the origin
 * is the map's own minimum cell — Kingsmouth is 5x5 records covering cells
 * 117..121, and Studio is 3x2 covering 1..3 by 1..2.
 *
 * Muldraugh starts at 0,0, so treating the grid as slot-indexed from the origin
 * happens to reproduce it exactly and silently drops every cell of the other
 * four shipped files. That is why `test/worldmap.test.js` round-trips all six
 * and not just the big one.
 */

const MAGIC = 'IGMB';
export const VERSION = 2;
export const CELL_SIZE = 256;

/** Every geometry type `WorldMapGeometry$Type` declares. */
export const GEOMETRY_TYPES = new Set(['Point', 'LineString', 'Polygon']);

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.at = 0;
  }

  int32() {
    this.need(4);
    const v = this.buf.readInt32LE(this.at);
    this.at += 4;
    return v;
  }

  int16() {
    this.need(2);
    const v = this.buf.readInt16LE(this.at);
    this.at += 2;
    return v;
  }

  uint8() {
    this.need(1);
    return this.buf[this.at++];
  }

  bytes(n) {
    this.need(n);
    const v = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return v;
  }

  need(n) {
    // A mis-parsed length must be rejected at the read, with the offset, rather
    // than allowed to allocate (DEV_GUIDE §5).
    if (this.at + n > this.buf.length) {
      throw new Error(`worldmap.bin truncated: wanted ${n} bytes at ${this.at} of ${this.buf.length}`);
    }
  }
}

/**
 * @typedef {{type: string, rings: number[][], properties: [string, string][]}} MapFeature
 * @typedef {{x: number, y: number, features: MapFeature[]}} MapCell
 * @typedef {{width: number, height: number, originX: number, originY: number,
 *            cells: MapCell[]}} MapDoc
 */

/**
 * Where the record grid starts.
 *
 * The origin is not stored, and it is **not** the smallest cell in the file:
 * `Muldraugh, KY/worldmap-forest.xml.bin` declares 78 x 63 records and its
 * lowest cell is at y = 4, because the first four rows are empty and written
 * out as -1. Taking the minimum instead shifts the whole map four cells north.
 *
 * It is recoverable exactly, though, because the records are laid out y-major:
 * the position of the first non-empty record says where the grid began.
 */
function originFrom(width, firstIndex, firstCell) {
  if (!firstCell || width <= 0) return { originX: 0, originY: 0 };
  return {
    originX: firstCell.x - (firstIndex % width),
    originY: firstCell.y - Math.floor(firstIndex / width),
  };
}

/** The record grid's extent, from the cells themselves. */
function boundsOf(cells) {
  if (!cells.length) return { originX: 0, originY: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of cells) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
  }
  return { originX: minX, originY: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** @returns {MapDoc} */
export function decodeWorldMapBin(buf) {
  const r = new Reader(buf);
  if (r.bytes(4).toString('latin1') !== MAGIC) throw new Error('not a worldmap binary (bad magic)');

  const version = r.int32();
  if (version !== VERSION) throw new Error(`unsupported worldmap.bin version ${version}`);
  const cellSize = r.int32();
  if (cellSize !== CELL_SIZE) throw new Error(`unsupported cell size ${cellSize}`);

  const width = r.int32();
  const height = r.int32();

  const stringCount = r.int32();
  const strings = [];
  for (let i = 0; i < stringCount; i++) {
    const len = r.int16();
    if (len < 0 || len > 4096) throw new Error(`implausible string length ${len} at ${r.at - 2}`);
    strings.push(r.bytes(len).toString('utf8'));
  }
  const str = (i) => {
    if (i < 0 || i >= strings.length) throw new Error(`string index ${i} outside the table`);
    return strings[i];
  };

  const cells = [];
  let firstIndex = -1;
  for (let record = 0; record < width * height; record++) {
    {
      const cellX = r.int32();
      if (cellX === -1) continue;
      if (firstIndex < 0) firstIndex = record;
      const cellY = r.int32();
      const featureCount = r.int32();
      if (featureCount < 0 || featureCount > 1e6) {
        throw new Error(`implausible feature count ${featureCount} at ${r.at - 4}`);
      }

      const features = [];
      for (let f = 0; f < featureCount; f++) {
        const type = str(r.int16());
        const ringCount = r.uint8();
        const rings = [];
        for (let g = 0; g < ringCount; g++) {
          const pointCount = r.int16();
          const ring = new Array(pointCount * 2);
          for (let p = 0; p < pointCount * 2; p++) ring[p] = r.int16();
          rings.push(ring);
        }
        const propertyCount = r.uint8();
        const properties = [];
        for (let p = 0; p < propertyCount; p++) properties.push([str(r.int16()), str(r.int16())]);
        features.push({ type, rings, properties });
      }
      cells.push({ x: cellX, y: cellY, features });
    }
  }
  const { originX, originY } = originFrom(width, firstIndex, cells[0]);
  return { width, height, originX, originY, cells };
}

class Writer {
  constructor() {
    this.parts = [];
    this.length = 0;
  }

  push(buf) {
    this.parts.push(buf);
    this.length += buf.length;
    return this;
  }

  int32(v) {
    const b = Buffer.allocUnsafe(4);
    b.writeInt32LE(v | 0);
    return this.push(b);
  }

  int16(v) {
    const b = Buffer.allocUnsafe(2);
    // Coordinates are stored as signed shorts, so a value outside the range is
    // a silent wrap into the wrong place on the map. Reject it here instead.
    if (v < -32768 || v > 32767) throw new Error(`worldmap value ${v} does not fit in a short`);
    b.writeInt16LE(v);
    return this.push(b);
  }

  uint8(v) {
    if (v < 0 || v > 255) throw new Error(`worldmap byte ${v} out of range`);
    return this.push(Buffer.from([v]));
  }

  finish() {
    return Buffer.concat(this.parts, this.length);
  }
}

/**
 * @param {MapDoc} doc
 * @returns {Buffer}
 */
export function encodeWorldMapBin(doc) {
  // The string table is built in first-seen order, which is what makes a
  // decode/encode round-trip byte-exact against the shipped files.
  const index = new Map();
  const strings = [];
  const intern = (s) => {
    let i = index.get(s);
    if (i === undefined) {
      i = strings.length;
      index.set(s, i);
      strings.push(s);
    }
    return i;
  };

  const byPos = new Map();
  for (const cell of doc.cells) {
    for (const f of cell.features) {
      intern(f.type);
      for (const [k, v] of f.properties) {
        intern(k);
        intern(v);
      }
    }
    byPos.set(`${cell.x},${cell.y}`, cell);
  }

  // The grid covers the cells' own extent, wherever that sits in the world.
  const bounds = boundsOf(doc.cells);
  const originX = doc.originX ?? bounds.originX;
  const originY = doc.originY ?? bounds.originY;
  const width = doc.width ?? bounds.width;
  const height = doc.height ?? bounds.height;

  const w = new Writer();
  w.push(Buffer.from(MAGIC, 'latin1'));
  w.int32(VERSION);
  w.int32(CELL_SIZE);
  w.int32(width);
  w.int32(height);

  w.int32(strings.length);
  for (const s of strings) {
    const b = Buffer.from(s, 'utf8');
    w.int16(b.length);
    w.push(b);
  }

  let written = 0;
  for (let y = originY; y < originY + height; y++) {
    for (let x = originX; x < originX + width; x++) {
      const cell = byPos.get(`${x},${y}`);
      if (cell) written++;
      if (!cell) {
        w.int32(-1);
        continue;
      }
      w.int32(cell.x);
      w.int32(cell.y);
      w.int32(cell.features.length);
      for (const f of cell.features) {
        w.int16(intern(f.type));
        w.uint8(f.rings.length);
        for (const ring of f.rings) {
          w.int16(ring.length / 2);
          for (const v of ring) w.int16(v);
        }
        w.uint8(f.properties.length);
        for (const [k, v] of f.properties) {
          w.int16(intern(k));
          w.int16(intern(v));
        }
      }
    }
  }

  // A cell outside the declared grid would be written nowhere and lost without
  // a word, which is the failure mode this format is most prone to.
  if (written !== doc.cells.length) {
    throw new Error(
      `worldmap: ${doc.cells.length - written} cell(s) fall outside the ` +
        `${width}x${height} grid at ${originX},${originY}`,
    );
  }
  return w.finish();
}

/**
 * Read the subset of `worldmap.xml` this project writes.
 *
 * Not a general XML parser: the input is machine-written by
 * `PZWorld/WorldMap.lua` with a fixed shape, so a scanner is enough and a
 * dependency is not worth taking. Anything it does not recognise is an error
 * rather than something quietly skipped — a map that silently loses half its
 * buildings is exactly the failure this whole file exists to end.
 *
 * @returns {MapDoc}
 */
export function parseWorldMapXml(text, { width, height } = {}) {
  const cells = [];
  let maxX = -1;
  let maxY = -1;

  const cellRe = /<cell\s+x="(-?\d+)"\s+y="(-?\d+)"\s*>([\s\S]*?)<\/cell>/g;
  const featureRe = /<feature\s*>([\s\S]*?)<\/feature>/g;
  const geometryRe = /<geometry\s+type="(\w+)"\s*>([\s\S]*?)<\/geometry>/;
  const coordsRe = /<coordinates\s*>([\s\S]*?)<\/coordinates>/g;
  const pointRe = /<point\s+x="(-?\d+)"\s+y="(-?\d+)"\s*\/>/g;
  const propertyRe = /<property\s+name="([^"]*)"\s+value="([^"]*)"\s*\/>/g;

  let cellMatch;
  while ((cellMatch = cellRe.exec(text))) {
    const cx = Number(cellMatch[1]);
    const cy = Number(cellMatch[2]);
    if (cx > maxX) maxX = cx;
    if (cy > maxY) maxY = cy;

    const features = [];
    const body = cellMatch[3];
    featureRe.lastIndex = 0;
    let featureMatch;
    while ((featureMatch = featureRe.exec(body))) {
      const inner = featureMatch[1];
      const geometry = geometryRe.exec(inner);
      if (!geometry) throw new Error(`feature in cell ${cx},${cy} has no <geometry>`);
      if (!GEOMETRY_TYPES.has(geometry[1])) throw new Error(`unknown geometry type "${geometry[1]}"`);

      const rings = [];
      coordsRe.lastIndex = 0;
      let coordsMatch;
      while ((coordsMatch = coordsRe.exec(geometry[2]))) {
        const ring = [];
        pointRe.lastIndex = 0;
        let pointMatch;
        while ((pointMatch = pointRe.exec(coordsMatch[1]))) {
          ring.push(Number(pointMatch[1]), Number(pointMatch[2]));
        }
        if (ring.length) rings.push(ring);
      }
      if (!rings.length) throw new Error(`feature in cell ${cx},${cy} has no points`);

      const properties = [];
      propertyRe.lastIndex = 0;
      let propertyMatch;
      while ((propertyMatch = propertyRe.exec(inner))) {
        properties.push([propertyMatch[1], propertyMatch[2]]);
      }

      features.push({ type: geometry[1], rings, properties });
    }
    if (features.length) cells.push({ x: cx, y: cy, features });
  }

  const bounds = boundsOf(cells);
  return {
    width: width ?? bounds.width,
    height: height ?? bounds.height,
    originX: bounds.originX,
    originY: bounds.originY,
    cells,
  };
}

/** Convenience: XML text in, `.bin` bytes out. */
export function compileWorldMapXml(text, geometry) {
  return encodeWorldMapBin(parseWorldMapXml(text, geometry));
}

/**
 * The same document as XML, in exactly the dialect `parseWorldMapXml` reads and
 * `PZWorld/WorldMap.lua` writes.
 *
 * ## Why the authored build writes this at all
 *
 * The helper watches `worldmap.xml` and recompiles `worldmap.xml.bin` from it
 * whenever it changes (`helper/serve.js compileMapIfChanged`), because the
 * in-game build can only write text — Lua's `getModFileWriter` hands back an
 * `OutputStreamWriter`. That watcher does not know or care which half of the
 * project produced the file.
 *
 * So there were two sources of truth for one file, and the XML always won. An
 * authored build that wrote a real `.bin` and left a *stub* beside it got the
 * stub compiled over the top, and the map went blank. Deleting the XML instead
 * hid the problem and caused a different one: both map screens resolve the name
 * through `ZomboidFileSystem.activeFileMap`, a table built while the mods are
 * scanned, so a map directory with no `worldmap.xml` at startup is never asked
 * for its data at all, however good the `.bin` next to it is.
 *
 * Writing the real map as XML removes the conflict rather than arbitrating it:
 * the name is there for the scan, and whatever the helper compiles from it is
 * the same map. `assertXmlMatchesBin` below is what proves that per build.
 *
 * ## Round-trip constraints, enforced not assumed
 *
 * `parseWorldMapXml` reads points with `x="(-?\d+)"` and properties with
 * `name="([^"]*)" value="([^"]*)"`, and does **no** entity decoding. So a
 * coordinate must be an integer and a property must contain no character that
 * would need escaping — true of every property this generator emits, since they
 * all come from the fixed enums in `src/emit/worldmap.js`. Anything else throws
 * here rather than silently producing a file that reads back as something else.
 */
export function encodeWorldMapXml(doc) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>\r\n<world version="1.0">\r\n'];
  for (const cell of doc.cells) {
    if (!Number.isInteger(cell.x) || !Number.isInteger(cell.y)) {
      throw new Error(`cell position ${cell.x},${cell.y} is not a pair of integers`);
    }
    out.push(` <cell x="${cell.x}" y="${cell.y}">\r\n`);
    for (const feature of cell.features) {
      if (!GEOMETRY_TYPES.has(feature.type)) {
        throw new Error(`unknown geometry type "${feature.type}"`);
      }
      out.push(`  <feature>\r\n   <geometry type="${feature.type}">\r\n`);
      for (const ring of feature.rings) {
        out.push('    <coordinates>\r\n');
        for (let i = 0; i < ring.length; i += 2) {
          const x = ring[i];
          const y = ring[i + 1];
          if (!Number.isInteger(x) || !Number.isInteger(y)) {
            throw new Error(`point ${x},${y} in cell ${cell.x},${cell.y} is not a pair of integers`);
          }
          out.push(`     <point x="${x}" y="${y}"/>\r\n`);
        }
        out.push('    </coordinates>\r\n');
      }
      out.push('   </geometry>\r\n   <properties>\r\n');
      for (const [name, value] of feature.properties) {
        for (const text of [name, value]) {
          if (/["&<>]/.test(String(text))) {
            throw new Error(
              `property "${name}"="${value}" contains a character the map XML reader does not decode`,
            );
          }
        }
        out.push(`    <property name="${name}" value="${value}"/>\r\n`);
      }
      out.push('   </properties>\r\n  </feature>\r\n');
    }
    out.push(' </cell>\r\n');
  }
  out.push('</world>\r\n');
  return out.join('');
}

/**
 * Parse the XML into exactly the document the helper builds from it.
 *
 * `helper/serve.js compileMapIfChanged` does not use the geometry the file
 * describes: it overrides all four numbers with the canvas, because the mod's
 * Lua writer emits no extent at all and `boundsOf` would otherwise size the grid
 * to whichever cells happen to have features in them. Anything that wants to
 * predict what the helper will write has to do the same four assignments, so
 * they live here rather than being repeated and drifting.
 */
export function compileLikeHelper(xmlText, { width, height } = {}) {
  const doc = parseWorldMapXml(xmlText, { width, height });
  doc.width = width ?? doc.width;
  doc.height = height ?? doc.height;
  doc.originX = 0;
  doc.originY = 0;
  return doc;
}

/**
 * Prove that the XML beside the `.bin` compiles to the `.bin`.
 *
 * This is the check that would have caught a blank map before it shipped, twice.
 * It compiles the XML exactly the way the helper does — same forced geometry —
 * and compares bytes, so "the helper might overwrite the map" stops being a
 * thing that can go wrong rather than a thing to be careful about.
 */
export function assertXmlMatchesBin(xmlText, binBytes, geometry) {
  const recompiled = encodeWorldMapBin(compileLikeHelper(xmlText, geometry));
  if (!recompiled.equals(Buffer.from(binBytes))) {
    throw new Error(
      `worldmap.xml does not compile to the bytes in worldmap.xml.bin `
        + `(${recompiled.length} vs ${binBytes.length} bytes) — the helper would replace the map`,
    );
  }
  return true;
}
