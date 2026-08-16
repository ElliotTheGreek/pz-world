/**
 * A worldgen prefab — the unit Project Zomboid stamps into the world.
 *
 * The shape is fixed by the game. `zombie/iso/worldgen/PrefabStructure.class`
 * declares exactly four categories and nothing else:
 *
 *     categories = [ "Floor", "FloorFurniture", "FloorOverlay", "Furniture" ]
 *     dimensions : int[]         { width, height }
 *     tiles      : List<String>  the palette
 *     schematic  : Map<String,int[][]>   1-based indices, 0 = empty
 *     zombies    : float
 *
 * Two consequences run through this whole file:
 *
 *   * **One storey.** There is no level axis, so a prefab is a ground floor.
 *   * **Four tiles per square, in fixed roles.** A vanilla building square
 *     carries up to twelve tiles (measured on Muldraugh cell 51_7), so lifting
 *     one into a prefab is lossy by construction. What survives is chosen by
 *     priority in `src/prefab/layers.js`, and the rest is dropped.
 *
 * Walls live in `Furniture` — the vanilla `highway_NS_00` prefab puts
 * `walls_garage_02_20` there, which is the only direct evidence of where the
 * game expects them.
 */

import { LAYERS, FURNITURE, FLOOR_FURNITURE } from './layers.js';

export { LAYERS };

export class Schematic {
  /**
   * @param {{name: string, cls?: string, w: number, h: number, zombies?: number,
   *          rooms?: {name: string, rects: number[][]}[]}} spec
   */
  /**
   * `margin` is the number of squares of padding on the **east and south**
   * edges, and it is load-bearing rather than cosmetic.
   *
   * Project Zomboid stores a wall on the north or west edge of a square, so a
   * building's south wall lives on the row below its last interior row and its
   * east wall on the column right of its last interior column. A building with
   * a w×h interior therefore needs a (w+1)×(h+1) grid to hold all four of its
   * walls, and rotation has to pivot about the *interior* box rather than the
   * padded one or the north wall lands outside the grid and is lost.
   *
   * Prefabs with no walls — a stretch of road, a car park — set margin 0.
   */
  constructor({ name, cls = 'unknown', w, h, zombies = 0, rooms = [], margin = 1 }) {
    this.name = name;
    this.cls = cls;
    this.w = w;
    this.h = h;
    this.margin = margin;
    this.zombies = zombies;
    this.rooms = rooms;
    /** @type {Map<string, (string|null)[]>} flat, row-major, length w*h */
    this.layers = new Map();
    for (const layer of LAYERS) this.layers.set(layer, new Array(w * h).fill(null));
  }

  #idx(x, y) {
    return y * this.w + x;
  }

  inside(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  get(layer, x, y) {
    if (!this.inside(x, y)) return null;
    return this.layers.get(layer)[this.#idx(x, y)];
  }

  set(layer, x, y, tile) {
    if (!this.inside(x, y)) return false;
    this.layers.get(layer)[this.#idx(x, y)] = tile ?? null;
    return true;
  }

  /** Every tile name used, in first-seen order — this becomes the palette. */
  palette() {
    const seen = [];
    const index = new Map();
    for (const layer of LAYERS) {
      const cells = this.layers.get(layer);
      for (const t of cells) {
        if (t && !index.has(t)) {
          index.set(t, seen.length + 1); // 1-based; 0 means empty
          seen.push(t);
        }
      }
    }
    return { tiles: seen, index };
  }

  /** True if nothing at all was placed. */
  get isEmpty() {
    for (const layer of LAYERS) {
      if (this.layers.get(layer).some(Boolean)) return false;
    }
    return true;
  }

  /** Count of squares carrying at least one tile. */
  get filledSquares() {
    let n = 0;
    for (let i = 0; i < this.w * this.h; i++) {
      for (const layer of LAYERS) {
        if (this.layers.get(layer)[i]) {
          n++;
          break;
        }
      }
    }
    return n;
  }

  clone(name = this.name) {
    const s = new Schematic({
      name,
      cls: this.cls,
      w: this.w,
      h: this.h,
      margin: this.margin,
      zombies: this.zombies,
      rooms: this.rooms,
    });
    for (const layer of LAYERS) s.layers.set(layer, [...this.layers.get(layer)]);
    return s;
  }

  /**
   * Emit the Lua the game loads. Matches the shape of the shipped
   * `media/lua/server/WorldGen/prefabs/highway_NS_00.lua` exactly, because that
   * is the only worked example of the format.
   */
  toLua() {
    const { tiles, index } = this.palette();
    const lines = [];
    lines.push(`local ${this.name} = {`);
    lines.push(`    dimensions = { ${this.w}, ${this.h} },`);
    lines.push(`    zombies = ${formatFloat(this.zombies)},`);
    lines.push('    tiles = {');
    lines.push(tiles.map((t) => `        "${t}"`).join(',\n'));
    lines.push('    },');
    lines.push('    schematic = {');

    const used = LAYERS.filter((l) => this.layers.get(l).some(Boolean));
    used.forEach((layer, li) => {
      const cells = this.layers.get(layer);
      lines.push(`        ${layer} = {`);
      const rows = [];
      for (let y = 0; y < this.h; y++) {
        const row = [];
        for (let x = 0; x < this.w; x++) {
          const t = cells[y * this.w + x];
          row.push(t ? index.get(t) : 0);
        }
        rows.push(`            "${row.join(',')}"`);
      }
      lines.push(rows.join(',\n'));
      lines.push(`        }${li === used.length - 1 ? '' : ','}`);
    });

    lines.push('    }');
    lines.push('}');
    lines.push('');
    lines.push(`worldgen.prefabs["${this.name}"] = ${this.name}`);
    lines.push('');
    return lines.join('\n');
  }
}

function formatFloat(v) {
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

/**
 * Rotate a prefab by `turns` quarter-turns clockwise.
 *
 * This is the piece the whole project turns on: real buildings sit at arbitrary
 * bearings and Project Zomboid can only place them on four. Rotating the grid
 * is trivial; rotating the *walls* is not, because a wall is not a property of
 * a square, it is a property of a square's north or west **edge**, and those
 * are the only two edges that exist.
 *
 * So walls are decomposed into edges, the edges are rotated, and the result is
 * recomposed:
 *
 *   90° clockwise maps direction (dx,dy) -> (-dy,dx), so
 *     a north edge becomes an east edge — which *is* the west edge of the
 *     square to its right — and a west edge becomes a north edge.
 *
 * Each moved edge also swaps to its opposite-facing artwork via the catalogue's
 * north/west pairing, and a square that ends up carrying both a north and a
 * west wall is re-expressed as the single corner tile that draws both, since a
 * prefab has only one Furniture slot per square.
 *
 * @param {Schematic} src
 * @param {import('../formats/tiledefs.js').TileCatalogue} cat
 * @param {number} turns 0..3
 * @returns {Schematic}
 */
export function rotate(src, cat, turns) {
  const t = ((turns % 4) + 4) % 4;
  if (t === 0) return src.clone();

  let cur = src;
  for (let i = 0; i < t; i++) cur = rotateOnce(cur, cat);
  cur.name = `${src.name}_r${t * 90}`;
  cur.cls = src.cls;
  cur.zombies = src.zombies;
  return cur;
}

/**
 * One quarter-turn clockwise.
 *
 * Walls are treated as **lattice edges**, not as cell contents, which is what
 * makes the transform exactly closed. For an interior of iw×ih squares the
 * lattice has (iw+1)×(ih+1) points, a north wall stored at cell (x,y) is the
 * horizontal edge at lattice point (x,y), and a west wall is the vertical edge
 * there. Rotating the lattice a quarter-turn clockwise sends point (x,y) to
 * (ih-y, x), and carrying the two edge orientations through that gives
 *
 *     north wall at (x,y)  ->  west wall  at (ih - y,     x)
 *     west  wall at (x,y)  ->  north wall at (ih - y - 1, x)
 *
 * with the artwork swapped to its opposite facing in both cases. Every
 * destination lands inside the (ih+1)×(iw+1) grid, including the padded east
 * column and south row — which is precisely why the margin has to exist.
 */
function rotateOnce(src, cat) {
  const m = src.margin;
  const iw = src.w - m;
  const ih = src.h - m;

  const out = new Schematic({
    name: src.name,
    cls: src.cls,
    w: ih + m,
    h: iw + m,
    margin: m,
    zombies: src.zombies,
    rooms: rotateRooms(src.rooms, iw, ih),
  });

  /** Interior square (x,y) -> its position after the turn. */
  const mapSquare = (x, y) => [ih - 1 - y, x];

  let dropped = 0;

  // Floors and overlays are cell contents, not edges, so they simply move.
  // Anything sitting in the margin is ground *outside* the footprint; the
  // harvester strips it, and refusing to carry it here keeps a prefab from
  // painting grass over the pavement the planner laid down.
  for (const layer of LAYERS) {
    if (layer === FURNITURE) continue;
    const cells = src.layers.get(layer);
    for (let y = 0; y < ih; y++) {
      for (let x = 0; x < iw; x++) {
        const tile = cells[y * src.w + x];
        if (!tile) continue;
        const [nx, ny] = mapSquare(x, y);
        const role = cat?.role(tile);
        // Kerbs and similar floor-level tiles do face; swap those too.
        const moved =
          role && (role.dir === 'N' || role.dir === 'W') ? cat.mirrorNorthWest(tile) : tile;
        out.set(layer, nx, ny, moved);
      }
    }
  }

  /** @type {Map<number, {north: string|null, west: string|null, plain: string|null}>} */
  const dest = new Map();
  const at = (x, y) => {
    if (x < 0 || y < 0 || x >= out.w || y >= out.h) return null;
    const k = y * out.w + x;
    let e = dest.get(k);
    if (!e) dest.set(k, (e = { north: null, west: null, plain: null }));
    return e;
  };

  const furniture = src.layers.get(FURNITURE);
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const tile = furniture[y * src.w + x];
      if (!tile) continue;

      const corner = cat?.splitCorner(tile);
      const role = cat?.role(tile);

      const putNorth = (art) => {
        const slot = at(ih - y, x);
        if (slot) slot.west = cat ? cat.mirrorNorthWest(art) : art;
        else dropped++;
      };
      const putWest = (art) => {
        const slot = at(ih - y - 1, x);
        if (slot) slot.north = cat ? cat.mirrorNorthWest(art) : art;
        else dropped++;
      };

      if (corner) {
        putNorth(corner.north);
        putWest(corner.west);
      } else if (role?.dir === 'N') {
        putNorth(tile);
      } else if (role?.dir === 'W') {
        putWest(tile);
      } else {
        // Not a wall: a table, an appliance, an unsplittable corner variant.
        // These are cell contents and only exist on interior squares.
        if (x < iw && y < ih) {
          const [nx, ny] = mapSquare(x, y);
          const slot = at(nx, ny);
          if (slot) slot.plain = tile;
          else dropped++;
        } else {
          dropped++;
        }
      }
    }
  }

  for (const [k, e] of dest) {
    const x = k % out.w;
    const y = (k / out.w) | 0;
    if (e.north && e.west) {
      const combined = cornerJoining(cat, e.north, e.west);
      out.set(FURNITURE, x, y, combined ?? e.north);
      if (!combined) dropped++;
      if (e.plain) dropped++;
    } else if (e.north || e.west) {
      out.set(FURNITURE, x, y, e.north ?? e.west);
      if (e.plain) dropped++;
    } else if (e.plain) {
      out.set(FURNITURE, x, y, e.plain);
    }
  }

  out.droppedOnRotate = (src.droppedOnRotate ?? 0) + dropped;
  return out;
}

/**
 * The single tile that draws a north wall and a west wall on one square.
 *
 * A prefab square has one Furniture slot, so a corner has to be one tile. The
 * exact pair usually has a corner in the catalogue, but real buildings put
 * different wall sheets on adjoining faces — an interior partition meeting an
 * exterior wall — and no corner tile joins two different sheets.
 *
 * When that happens, take the corner from the north wall's own sheet. The
 * result draws a proper corner in the north wall's style, which is a far better
 * failure than the alternatives: dropping the west wall leaves a hole a
 * survivor walks through, and putting it on a floor layer draws a wall flat on
 * the ground.
 */
function cornerJoining(cat, north, west) {
  if (!cat) return null;
  return (
    cat.cornerFor(north, west) ??
    cat.cornerFor(north, cat.mirrorNorthWest(north)) ??
    cat.cornerFor(cat.mirrorNorthWest(west), west) ??
    null
  );
}

/** Room rectangles follow the same interior square mapping as the tiles. */
function rotateRooms(rooms, iw, ih) {
  if (!rooms?.length) return [];
  return rooms.map((room) => ({
    name: room.name,
    rects: room.rects.map(([x, y, rw, rh]) => [ih - y - rh, x, rh, rw]),
  }));
}

/** All four rotations, named `<base>_r0/_r90/_r180/_r270`. */
export function allRotations(src, cat) {
  return [0, 1, 2, 3].map((t) => {
    const r = rotate(src, cat, t);
    r.name = `${src.name}_r${t * 90}`;
    return r;
  });
}
