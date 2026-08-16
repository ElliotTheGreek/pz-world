/**
 * Rotating a whole building.
 *
 * `schematic.js` already solves the hard half of this and the reasoning there applies
 * unchanged: a wall is not a property of a square, it is a property of a square's north
 * or west **edge**, and those are the only two edges Project Zomboid has. So walls are
 * decomposed into lattice edges, the edges are rotated, and the result is recomposed.
 *
 * For an interior of `iw x ih` squares the lattice has `(iw+1) x (ih+1)` points, and a
 * quarter-turn clockwise sends point `(x,y)` to `(ih-y, x)`, giving
 *
 *     north wall at (x,y)  ->  west wall  at (ih - y,     x)
 *     west  wall at (x,y)  ->  north wall at (ih - y - 1, x)
 *
 * with the artwork swapped to its opposite facing in both cases.
 *
 * ## What is different here
 *
 * Two things, and both make the result *better* than the prefab route rather than merely
 * bigger:
 *
 *   1. **A square holds a list of tiles, not four fixed slots.** The prefab rotation had
 *      one `Furniture` slot per square, so a corner that landed on a square already
 *      holding a wall had to be merged into a single corner tile or dropped — that is
 *      what `droppedOnRotate` counted. Here both simply coexist, and a corner tile is
 *      used when the catalogue has one because it draws a proper join, not because there
 *      is no room for two.
 *   2. **Every level rotates.** Rotation is a 2D transform, so each level is independent
 *      and the roof turns with the walls under it.
 */

import { emptyBlock, blockTiles, setBlockTiles, MARGIN } from '../extract/building.js';

/**
 * Which lattice edge a tile occupies: `'N'`, `'W'`, `'NW'`, `'SE'`, or null for
 * something that stands on the square rather than on one of its edges.
 *
 * **The declared facing is the only test, and `CornerNorthWall` is not a facing.**
 * Getting this wrong in either direction breaks rotation, and it did, twice:
 *
 *   - `overlay_grime_wall_01_18` is a dirt decal. It declares `CornerNorthWall` and
 *     `CornerWestWall` but no `Wall*` property at all. Splitting it because it looked
 *     like a corner sent its two halves to two different squares as ordinary contents,
 *     where nothing could ever put them back.
 *   - `walls_commercial_02_40` is a shopfront trim: `WallOverlay` **and** `WallWTrans`.
 *     Excluding every `WallOverlay` — DEV_GUIDE §2.9's rule, which is about telling
 *     walls from decals when *counting* them — dropped it, because the reader had kept
 *     it as a west-facing margin tile and the rotator then had nowhere to put it.
 *
 * So: route by `role().dir`, and consult `splitCorner` only when that says `NW`.
 * Reader and rotator must agree, which is why both call this.
 */
export function wallFacing(cat, tile) {
  return cat?.role(tile)?.dir ?? null;
}

/** The two walls a corner tile draws, or null if it is not a corner. */
export function cornerParts(cat, tile) {
  if (wallFacing(cat, tile) !== 'NW') return null;
  return cat.splitCorner(tile);
}

/**
 * Rotate a building by `turns` quarter-turns clockwise.
 *
 * @param {import('../extract/building.js').BuildingBlock} src
 * @param {import('../formats/tiledefs.js').TileCatalogue} cat
 * @param {number} turns 0..3
 */
export function rotateBlock(src, cat, turns) {
  const t = ((turns % 4) + 4) % 4;
  let cur = cloneBlock(src);
  for (let i = 0; i < t; i++) cur = rotateBlockOnce(cur, cat);
  return cur;
}

export function cloneBlock(src) {
  const out = emptyBlock(src.ref, src.w, src.h, src.minLevel, src.maxLevel, src.rooms.map(cloneRoom));
  for (let i = 0; i < src.squares.length; i++) {
    out.squares[i] = src.squares[i] ? [...src.squares[i]] : null;
  }
  return out;
}

const cloneRoom = (r) => ({
  name: r.name,
  level: r.level,
  rects: r.rects.map((rect) => [...rect]),
  objects: r.objects.map((o) => [...o]),
});

/** One quarter-turn clockwise. */
function rotateBlockOnce(src, cat) {
  const m = MARGIN;
  const iw = src.w - m;
  const ih = src.h - m;

  const out = emptyBlock(
    src.ref,
    ih + m,
    iw + m,
    src.minLevel,
    src.maxLevel,
    rotateRooms(src.rooms, ih),
  );
  out.dropped = src.dropped ?? 0;

  /** An interior square's position after the turn. */
  const mapSquare = (x, y) => [ih - 1 - y, x];

  for (let level = src.minLevel; level <= src.maxLevel; level++) {
    /** destination key -> {north: [], west: [], plain: []} */
    const dest = new Map();
    const slotAt = (x, y) => {
      if (x < 0 || y < 0 || x >= out.w || y >= out.h) return null;
      const k = y * out.w + x;
      let e = dest.get(k);
      if (!e) dest.set(k, (e = { north: [], west: [], plain: [] }));
      return e;
    };

    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const tiles = blockTiles(src, x, y, level);
        if (!tiles) continue;

        for (const tile of tiles) {
          const corner = cornerParts(cat, tile);
          // A wall with no north/west counterpart cannot be re-faced, and routing
          // it to the opposite edge anyway is what makes it disappear: it keeps
          // its declared facing, so the next quarter-turn reads that facing,
          // routes it as the other kind, and eventually sends it off the grid.
          // Twenty-six tiles in the whole install are like this. Carrying them as
          // cell contents leaves them facing the wrong way, which is visible;
          // losing them leaves a hole, which is worse.
          const dir = corner || cat?.mirrorNorthWest(tile) !== tile ? wallFacing(cat, tile) : null;

          // A north edge becomes an east edge, which *is* the west edge of the
          // square to its right; a west edge becomes a north edge.
          const putNorth = (art) => slotAt(ih - y, x)?.west.push(cat ? cat.mirrorNorthWest(art) : art);
          const putWest = (art) => slotAt(ih - y - 1, x)?.north.push(cat ? cat.mirrorNorthWest(art) : art);

          if (corner) {
            putNorth(corner.north);
            putWest(corner.west);
          } else if (dir === 'N') {
            putNorth(tile);
          } else if (dir === 'W') {
            putWest(tile);
          } else {
            // Cell contents: furniture, floors, roofs, ceilings, decals. These move
            // with their square. Anything that has a north/west counterpart still
            // swaps artwork, so a kerb, a directional floor overlay or a patch of
            // wall grime ends up facing the way its square now faces.
            const moved = cat ? cat.mirrorNorthWest(tile) : tile;
            if (x < iw && y < ih) {
              const [nx, ny] = mapSquare(x, y);
              slotAt(nx, ny)?.plain.push(moved);
            } else {
              // Nothing should reach here. `readBuilding` strips non-edge tiles
              // from the margin precisely so that rotation has nowhere to lose
              // anything — if this fires, that filter has stopped matching and
              // buildings are quietly shedding tiles on every quarter-turn.
              out.dropped++;
            }
          }
        }
      }
    }

    for (const [k, e] of dest) {
      const x = k % out.w;
      const y = (k / out.w) | 0;
      const tiles = [];

      // Where the catalogue has a tile that draws both faces, use it — it joins
      // properly. Otherwise keep both walls, which a tile list can do and a
      // four-slot prefab could not.
      //
      // **Only if the join comes apart again.** `cornerFor` will happily pair a
      // door with a wall and hand back a corner whose own facing is not `WallNW`,
      // which `cornerParts` then refuses to split — so the next quarter-turn
      // treats it as furniture and the door is gone. Requiring the corner to
      // decompose to exactly the two tiles it was built from makes every merge
      // reversible by construction.
      let north = e.north;
      let west = e.west;
      if (north.length && west.length) {
        const joined = cat?.cornerFor(north[0], west[0]) ?? null;
        const parts = joined ? cornerParts(cat, joined) : null;
        if (parts && parts.north === north[0] && parts.west === west[0]) {
          tiles.push(joined);
          north = north.slice(1);
          west = west.slice(1);
        }
      }
      tiles.push(...north, ...west, ...e.plain);
      if (tiles.length) setBlockTiles(out, x, y, level, tiles);
    }
  }

  return out;
}

/** Room rectangles and objects follow the same interior square mapping as the tiles. */
function rotateRooms(rooms, ih) {
  return rooms.map((room) => ({
    name: room.name,
    level: room.level,
    rects: room.rects.map(([x, y, w, h]) => [ih - y - h, x, h, w]),
    objects: room.objects.map(([type, x, y]) => [type, ih - 1 - y, x]),
  }));
}

/** All four rotations of a building. */
export function allRotations(block, cat) {
  return [0, 1, 2, 3].map((t) => rotateBlock(block, cat, t));
}
