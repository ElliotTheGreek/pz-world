/**
 * Parsing `media/*.tiles.txt` — the game's own tile catalogue.
 *
 * We need two things out of it that cannot be guessed:
 *
 * 1. **Which tiles exist.** A prefab that names a tile the game does not have
 *    renders as a blank square with no error, so every emitted tile name is
 *    checked against this catalogue.
 *
 * 2. **Which way a tile faces.** Project Zomboid expresses walls only as the
 *    north and west edges of a square, so rotating a building 90° means
 *    swapping every north wall for its west counterpart. The tileset layout
 *    makes that derivable rather than hand-tabulated:
 *
 *        walls_interior_house_01_0   WallW
 *        walls_interior_house_01_1   WallN
 *        walls_interior_house_01_2   WallNW  CornerNorthWall=..._1
 *                                            CornerWestWall=..._0
 *        walls_interior_house_01_3   WallSE
 *        ..._8  WindowW   ..._9  WindowN
 *        ..._10 DoorWallW ..._11 DoorWallN
 *
 *    The corner tile *names its own north and west partners*, which is an
 *    authoritative pairing straight from the data. Where a corner is absent we
 *    fall back to adjacency within the tileset, which the layout above makes
 *    reliable.
 *
 * The file format is a brace-delimited key/value tree; the tile's name is
 * carried in a `//` comment above each `tile` block and is also derivable from
 * `xy` and the tileset `size`, so the two are cross-checked on parse.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Directional roles a tile can carry, keyed by the property that declares it.
 *
 * The `*Trans` variants are the see-through walls — railings, glass, fence panels — and
 * they are a separate property name, not a modifier. Leaving them out does not make a
 * railing unrecognised in an obvious way: `splitCorner` still works, because a railing
 * corner declares `CornerNorthWall`/`CornerWestWall` like any other, so a corner would be
 * taken apart into two halves that `role()` then refused to recognise, and the pieces
 * could never be put back. `fixtures_railings_01_74` was doing exactly that.
 *
 * 347 `WallWTrans`, 347 `WallNTrans`, 93 `WallNWTrans` and one `DoorWall*Trans` pair are
 * declared in the shipped definitions.
 */
const ROLE_PROPS = {
  WallW: { kind: 'wall', dir: 'W' },
  WallN: { kind: 'wall', dir: 'N' },
  WallNW: { kind: 'wall', dir: 'NW' },
  WallSE: { kind: 'wall', dir: 'SE' },
  WallWTrans: { kind: 'wall', dir: 'W' },
  WallNTrans: { kind: 'wall', dir: 'N' },
  WallNWTrans: { kind: 'wall', dir: 'NW' },
  WallSETrans: { kind: 'wall', dir: 'SE' },
  WindowW: { kind: 'window', dir: 'W' },
  WindowN: { kind: 'window', dir: 'N' },
  DoorWallW: { kind: 'door', dir: 'W' },
  DoorWallN: { kind: 'door', dir: 'N' },
  DoorWallWTrans: { kind: 'door', dir: 'W' },
  DoorWallNTrans: { kind: 'door', dir: 'N' },
};

/**
 * @typedef {{name: string, tileset: string, index: number, x: number, y: number,
 *            props: Record<string,string>}} TileDef
 */

export class TileCatalogue {
  constructor() {
    /** @type {Map<string, TileDef>} */
    this.tiles = new Map();
    /** @type {Map<string, TileDef[]>} */
    this.tilesets = new Map();
    /** name -> name, north variant <-> west variant */
    this.northToWest = new Map();
    this.westToNorth = new Map();
    /** "northTile|westTile" -> the corner tile that combines them */
    this.corners = new Map();
    /** corner tile -> {north, west} */
    this.cornerParts = new Map();
    /** tileset name -> number of tiles on the sheet (width × height) */
    this.sheetSize = new Map();
    /** tileset name -> the declared sheet geometry */
    this.sheetDimensions = new Map();
  }

  /**
   * Does the game have a tile by this name?
   *
   * Not the same question as `has()`. A `.tiles.txt` lists only tiles that
   * carry *properties* — `walls_detailing_02` starts at index 4 because
   * indices 0..3 are plain decorative sprites with nothing to declare. So
   * membership in `tiles` proves a tile exists, but absence proves nothing.
   *
   * The complete test is the sheet: a tileset declares `size = w,h`, and every
   * index below w×h is a real tile.
   */
  tileExists(name) {
    if (this.tiles.has(name)) return true;
    const cut = name.lastIndexOf('_');
    if (cut < 0) return false;
    const sheet = name.slice(0, cut);
    const index = Number(name.slice(cut + 1));
    if (!Number.isInteger(index) || index < 0) return false;
    const size = this.sheetSize.get(sheet);
    return size !== undefined && index < size;
  }

  /**
   * Is this tile a structural wall, window frame or door frame?
   *
   * Two traps here, both found by measurement rather than by reading:
   *
   *   * `WallType` is *not* a reliable marker. Some sheets declare it
   *     (`walls_interior_house_01`) and some do not (`walls_exterior_house_01`
   *     carries only `WallN` and a lowercase `wall`). Facing is the property
   *     every wall sheet does have.
   *   * facing alone over-counts. `overlay_grime_wall_01_*` are dirt decals
   *     painted onto walls; they carry wall-ish properties and are declared
   *     `WallOverlay`, which is what separates them.
   */
  isWall(name) {
    const t = this.tiles.get(name);
    if (!t) return false;
    if ('WallOverlay' in t.props) return false;
    if (name.startsWith('overlay_')) return false;
    if (this.cornerParts.has(name)) return true;
    return this.role(name) !== null;
  }

  /**
   * Every tile in a sheet that plays a given structural role, in sheet order.
   * This is what lets a building kit be *derived* from the catalogue rather
   * than hard-coded: sheets do not share a layout, and assuming they do puts
   * windows where walls should be.
   *
   * @param {string} tileset
   * @param {string} kind  'wall' | 'window' | 'door'
   * @param {string} dir   'N' | 'W'
   */
  byRole(tileset, kind, dir) {
    const tiles = this.tilesets.get(tileset) ?? [];
    return tiles
      .filter((t) => {
        const r = this.role(t.name);
        return r && r.kind === kind && r.dir === dir;
      })
      .sort((a, b) => a.index - b.index);
  }

  /** The first corner tile in a sheet, i.e. its plain one. */
  firstCorner(tileset) {
    const tiles = this.tilesets.get(tileset) ?? [];
    for (const t of [...tiles].sort((a, b) => a.index - b.index)) {
      if (this.cornerParts.has(t.name)) return t.name;
    }
    return null;
  }

  /**
   * The single tile that draws both a north and a west wall on one square.
   *
   * This matters for rotation. A square carrying a corner needs two wall tiles,
   * but a worldgen prefab has only one Furniture slot per square, so the corner
   * has to be re-expressed as the one tile that contains both. The mapping is
   * read straight out of the corner tile's own `CornerNorthWall` /
   * `CornerWestWall` properties rather than assumed from sheet positions.
   */
  cornerFor(northTile, westTile) {
    return this.corners.get(`${northTile}|${westTile}`) ?? null;
  }

  /** Inverse of {@link cornerFor}: split a corner tile into its two walls. */
  splitCorner(name) {
    return this.cornerParts.get(name) ?? null;
  }

  has(name) {
    return this.tiles.has(name);
  }

  get(name) {
    return this.tiles.get(name);
  }

  get size() {
    return this.tiles.size;
  }

  /** @returns {{kind: string, dir: string}|null} */
  role(name) {
    const t = this.tiles.get(name);
    if (!t) return null;
    for (const [prop, role] of Object.entries(ROLE_PROPS)) {
      if (prop in t.props) return role;
    }
    return null;
  }

  /**
   * The counterpart of a directional tile across the N/W axis. Returns the
   * input unchanged for tiles that have no facing, which is most of them.
   */
  mirrorNorthWest(name) {
    return this.northToWest.get(name) ?? this.westToNorth.get(name) ?? name;
  }

  /** Already part of a pair, in either direction. */
  #linked(name) {
    return this.northToWest.has(name) || this.westToNorth.has(name);
  }

  /**
   * Record one north/west pair, refusing to attach a tile that is already
   * paired. Without that refusal a tile can end up as the north partner of one
   * pair and the west partner of another, and `mirrorNorthWest` stops being an
   * involution — rotating a building four times would not return it to its
   * original tiles.
   */
  #pair(north, west) {
    if (north === west) return;
    if (this.#linked(north) || this.#linked(west)) return;
    this.northToWest.set(north, west);
    this.westToNorth.set(west, north);
  }

  /**
   * Build the N<->W index once every tileset is loaded.
   */
  linkFacings() {
    /** @type {Map<string, TileDef[]>} */
    const candidates = new Map();

    for (const [, tiles] of this.tilesets) {
      // Authoritative: a corner tile names both partners.
      for (const t of tiles) {
        const n = t.props.CornerNorthWall;
        const w = t.props.CornerWestWall;
        if (n && w && this.tiles.has(n) && this.tiles.has(w)) {
          this.#pair(n, w);
          // Many tiles can name the same north/west pair: a sheet carries
          // alternate and damaged corner variants, and unrelated `location_*`
          // sheets reuse the standard house walls for their own corners.
          // Collect the candidates and choose between them once everything is
          // loaded, in #resolveCorners.
          const key = `${n}|${w}`;
          let list = candidates.get(key);
          if (!list) candidates.set(key, (list = []));
          list.push(t);
          this.cornerParts.set(t.name, { north: n, west: w });
        }
      }
      // Fallback: pair positionally within each kind. Tilesets use two
      // different layouts — walls interleave (W,N,corner,corner, W,N,…) while
      // roof sheets block them (W,W,W,W, N,N,N,N) — and pairing the k-th west
      // tile with the k-th north tile of the same kind is correct for both.
      const byKind = new Map();
      for (const t of tiles) {
        const role = this.role(t.name);
        if (!role || (role.dir !== 'N' && role.dir !== 'W')) continue;
        let slot = byKind.get(role.kind);
        if (!slot) byKind.set(role.kind, (slot = { N: [], W: [] }));
        slot[role.dir].push(t);
      }
      // Pair as many as the sheet has of both, rather than insisting on equal
      // counts. `walls_exterior_wooden_01` declares nine west doorways and eight
      // north ones — index 78 simply has no north variant — and requiring
      // equality threw away all eight usable pairs with it. Every door in that
      // sheet was then its own mirror, so rotating a building turned a west door
      // into a west door standing in a north wall, and the next quarter-turn read
      // its declared facing and sent it somewhere that no longer existed.
      //
      // Doors were the whole `door` kind on two of the commonest wall sheets.
      for (const { N, W } of byKind.values()) {
        N.sort((a, b) => a.index - b.index);
        W.sort((a, b) => a.index - b.index);
        for (let i = 0; i < Math.min(N.length, W.length); i++) this.#pair(N[i].name, W[i].name);

        // Last resort: neighbouring indices. Some sheets are irregular enough
        // that positional pairing slips — `fencing_01` declares 32 north panels
        // and 28 west ones, interleaved, so everything after the first
        // misalignment paired with the wrong partner or not at all.
        //
        // A tile with no partner is worse than one with an imperfect partner: it
        // is its own mirror, so rotation leaves it facing the way it started
        // while storing it on the opposite edge, and the *next* quarter-turn
        // reads its declared facing, routes it as the wrong kind, and drops it
        // off the grid. Whole fence panels vanished at 180°.
        const byIndex = new Map();
        for (const t of [...N, ...W]) byIndex.set(t.index, t);
        for (const w of W) {
          if (this.#linked(w.name)) continue;
          for (const delta of [-1, 1]) {
            const n = byIndex.get(w.index + delta);
            if (!n || this.#linked(n.name)) continue;
            if (this.role(n.name)?.dir !== 'N') continue;
            this.#pair(n.name, w.name);
            break;
          }
        }
      }
    }

    this.#resolveCorners(candidates);
  }

  /**
   * Pick one corner tile per north/west pair.
   *
   * The corner that belongs to the *same sheet as the walls it joins* is the
   * right answer — otherwise splitting a house corner and recomposing it can
   * hand back a corner from a restaurant sheet, and rotating a building four
   * times quietly re-skins it. Within a sheet, the lowest index is the plain
   * variant rather than a damaged or alternate one.
   */
  #resolveCorners(candidates) {
    for (const [key, list] of candidates) {
      const northTile = this.tiles.get(key.slice(0, key.indexOf('|')));
      const sheet = northTile?.tileset;
      let best = null;
      for (const cand of list) {
        if (!best) {
          best = cand;
          continue;
        }
        const bestSameSheet = best.tileset === sheet;
        const candSameSheet = cand.tileset === sheet;
        if (candSameSheet !== bestSameSheet) {
          if (candSameSheet) best = cand;
        } else if (cand.index < best.index) {
          best = cand;
        }
      }
      if (best) this.corners.set(key, best.name);
    }
  }
}

/**
 * Parse one `.tiles.txt`. The grammar is small enough to walk line by line,
 * which matters — `newtiledefinitions.tiles.txt` is 6.8 MB.
 *
 * @param {string} text
 * @param {TileCatalogue} cat
 */
export function parseTileDefs(text, cat) {
  const lines = text.split(/\r?\n/);
  let tileset = null;
  let sheetW = 0;
  let sheetH = 0;
  let pendingName = null;
  let cur = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('//')) {
      pendingName = line.slice(2).trim();
      continue;
    }
    if (line === 'tileset') {
      tileset = null;
      sheetW = 0;
      sheetH = 0;
      continue;
    }
    if (line === 'tile') {
      cur = { props: {} };
      continue;
    }
    if (line === '{' || line === '}') {
      if (line === '}' && cur) {
        finishTile(cat, tileset, sheetW, pendingName, cur);
        cur = null;
        pendingName = null;
      }
      continue;
    }

    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (cur) {
      cur.props[key] = value;
    } else if (key === 'file') {
      tileset = value;
    } else if (key === 'size') {
      const [w, h] = value.split(',');
      sheetW = parseInt(w, 10) || 0;
      sheetH = parseInt(h, 10) || 0;
      if (tileset && sheetW && sheetH) {
        cat.sheetSize.set(tileset, sheetW * sheetH);
        cat.sheetDimensions.set(tileset, { width: sheetW, height: sheetH });
      }
    }
  }
}

/**
 * Record one tile, **merging** into any earlier definition of the same name.
 *
 * A tile can be declared more than once. `tiledefinitions_noiseworks.patch.tiles.txt`
 * re-declares a long list of tiles carrying only `FootstepMaterial`, to patch that
 * one property onto tiles that already exist in `newtiledefinitions.tiles.txt`.
 *
 * This used to be `cat.tiles.set(name, def)`, which meant the patch file **replaced**
 * the original and every other property vanished. `blends_natural_01_21` is declared
 * with `FloorMaterial = Grass_Dark` and `FloorAttachmentN/W`, and after loading the
 * whole `media` directory it had neither — leaving the catalogue quietly wrong about
 * exactly the tiles the autotiler and the wall-facing logic read.
 *
 * Nothing failed. `role()` returned null, `mirrorNorthWest` became the identity for
 * those tiles, and the blend table would have come out empty. That is the failure
 * mode DEV_GUIDE §6.4 is about: a wrong tile renders blank rather than erroring.
 *
 * Later declarations win per property, which is what "patch" means.
 */
function finishTile(cat, tileset, sheetW, name, cur) {
  if (!tileset || !name) return;
  const xy = (cur.props.xy ?? '').split(',');
  const x = parseInt(xy[0], 10);
  const y = parseInt(xy[1], 10);
  const index = Number.isFinite(x) && Number.isFinite(y) && sheetW ? y * sheetW + x : NaN;

  const existing = cat.tiles.get(name);
  if (existing) {
    Object.assign(existing.props, cur.props);
    // A patch file need not repeat `xy`, so keep the first real position we saw.
    if (Number.isFinite(index) && !Number.isFinite(existing.index)) {
      existing.index = index;
      existing.x = x;
      existing.y = y;
    }
    return;
  }

  const def = { name, tileset, index, x, y, props: cur.props };
  cat.tiles.set(name, def);
  let list = cat.tilesets.get(tileset);
  if (!list) cat.tilesets.set(tileset, (list = []));
  list.push(def);
}

/**
 * Load every tile definition the install ships.
 *
 * @param {string} install
 * @returns {TileCatalogue}
 */
export function loadTileCatalogue(install) {
  const dir = path.join(install, 'media');
  const cat = new TileCatalogue();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.tiles.txt')) continue;
    parseTileDefs(fs.readFileSync(path.join(dir, f), 'utf8'), cat);
  }
  cat.linkFacings();
  return cat;
}
