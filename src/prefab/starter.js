/**
 * The built-in prefab library.
 *
 * `pz-world extract` harvests thousands of hand-authored buildings from the
 * player's own install, and that is what a real map should be built from. But
 * extraction takes a few minutes, and a generator that produces nothing until
 * it has run is a generator nobody can try. So this builds a small set of plain
 * buildings from rules: unencumbered, since no vanilla layout is copied, only
 * vanilla tile *names* — which is what every Project Zomboid map mod does.
 *
 * The buildings are deliberately plain. They exist so the pipeline runs end to
 * end, not to compete with Knox County.
 *
 * ## Kits are derived, never hard-coded
 *
 * The obvious way to write this is to name the tiles directly — index 0 is the
 * west wall, 1 the north wall, 2 the corner, 10 and 11 the doors. That is true
 * of `walls_exterior_house_01` and **false of most other sheets**:
 * `walls_commercial_01` has windows at 0 and 1 and doors at 8 and 9, and
 * `walls_garage_01`'s corner is at index 34. Hard-coding the house layout
 * across every kit builds walls out of windows.
 *
 * So a kit is looked up from the tile catalogue by declared role. That also
 * means a future build renaming or reordering a sheet degrades to "this kit is
 * unavailable" rather than to a building with holes in it.
 */

import { Schematic } from './schematic.js';

/**
 * Sheets to build kits from, and which classes each serves. Every one was
 * checked to carry a complete set — north and west walls, a corner, and a door
 * pair — by the query in test/starter.test.js.
 */
const KITS = {
  house: 'walls_exterior_house_01',
  house2: 'walls_exterior_house_02',
  wooden: 'walls_exterior_wooden_01',
  brick: 'walls_commercial_01',
  brick2: 'walls_commercial_03',
  industrial: 'industry_01',
  garage: 'walls_garage_01',
};

const FLOORS = {
  house: ['floors_interior_tilesandwood_01_0', 'floors_interior_carpet_01_0'],
  house2: ['floors_interior_tilesandwood_01_0', 'floors_interior_carpet_01_0'],
  wooden: ['floors_interior_tilesandwood_01_0', 'floors_interior_tilesandwood_01_16'],
  brick: ['floors_interior_tilesandwood_01_16', 'floors_interior_tilesandwood_01_16'],
  brick2: ['floors_interior_tilesandwood_01_16', 'floors_interior_tilesandwood_01_16'],
  industrial: ['floors_exterior_tilesandstone_01_3', 'floors_exterior_tilesandstone_01_3'],
  garage: ['floors_exterior_tilesandstone_01_3', 'floors_exterior_tilesandstone_01_3'],
};

/** Interior sizes in squares, by class. */
const CATALOGUE = [
  { cls: 'house', kit: 'house', sizes: [[6, 5], [8, 6], [10, 7], [12, 9], [9, 12]] },
  { cls: 'house', kit: 'house2', sizes: [[7, 6], [11, 8], [8, 11]] },
  { cls: 'shed', kit: 'wooden', sizes: [[3, 3], [4, 3], [5, 4]] },
  { cls: 'garage', kit: 'garage', sizes: [[6, 6], [8, 6], [6, 8]] },
  { cls: 'farm', kit: 'wooden', sizes: [[10, 8], [14, 10]] },
  { cls: 'retail', kit: 'brick', sizes: [[12, 10], [16, 12], [20, 14]] },
  { cls: 'grocery', kit: 'brick', sizes: [[18, 14], [24, 18]] },
  { cls: 'office', kit: 'brick2', sizes: [[14, 12], [18, 16], [12, 18]] },
  { cls: 'warehouse', kit: 'industrial', sizes: [[20, 16], [28, 20]] },
  { cls: 'industrial', kit: 'industrial', sizes: [[24, 18], [18, 24]] },
];

/**
 * Look a kit up from the catalogue by declared role.
 * @returns {object|null} null when the sheet does not carry a full set
 */
export function kitFromTileset(cat, tileset) {
  const pick = (kind, dir) => cat.byRole(tileset, kind, dir)[0]?.name ?? null;

  const doorN = pick('door', 'N');
  const doorW = pick('door', 'W');
  if (!doorN || !doorW) return null;

  // Take the walls **from the corner**, not the other way round.
  //
  // Picking the first north wall and the first west wall independently and then
  // hoping a corner joins them does not work on every sheet: `walls_garage_01`
  // declares its plain walls at 3 and 2 but its corner at 34, which names 33 and
  // 32. `cornerFor(3, 2)` is null, so the old code fell back to the sheet's first
  // corner and produced a kit whose corner belonged to different walls — the join
  // is visibly wrong, and it is the sort of wrong that only shows up as a seam in
  // a screenshot.
  // ...and only from a corner whose two halves are themselves real walls facing
  // the right way. A sheet carries corner-shaped tiles that are not wall corners
  // — grime decals declare `CornerNorthWall` too — and one of those names parts
  // with no facing at all.
  let corner = null;
  let parts = null;
  for (const t of cat.tilesets.get(tileset) ?? []) {
    if (cat.role(t.name)?.dir !== 'NW') continue;
    const split = cat.splitCorner(t.name);
    if (!split) continue;
    // Both halves must be plain walls. `walls_commercial_01` puts *windows* at 0
    // and 1 and doors at 8 and 9 (DEV_GUIDE §2.8), and its first corner joins the
    // windows — a kit built from that has window frames for walls.
    const north = cat.role(split.north);
    const west = cat.role(split.west);
    if (north?.dir !== 'N' || north.kind !== 'wall') continue;
    if (west?.dir !== 'W' || west.kind !== 'wall') continue;
    corner = t.name;
    parts = split;
    break;
  }

  const wallN = parts?.north ?? pick('wall', 'N');
  const wallW = parts?.west ?? pick('wall', 'W');
  corner ??= cat.cornerFor(wallN, wallW) ?? cat.firstCorner(tileset);
  if (!wallN || !wallW || !corner) return null;

  return {
    tileset,
    wallN,
    wallW,
    corner,
    windowN: pick('window', 'N'),
    windowW: pick('window', 'W'),
    doorN,
    doorW,
  };
}

/**
 * A plain rectangular building: four walls, one door on the south face,
 * windows on a rhythm, and a floor.
 *
 * The grid is the interior plus one square on the east and south, because that
 * is where Project Zomboid stores those two walls. See Schematic#margin.
 */
export function makeBuilding(name, cls, kit, floors, iw, ih) {
  const s = new Schematic({ name, cls, w: iw + 1, h: ih + 1, margin: 1, zombies: 0.02 });

  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      s.set('Floor', x, y, (x + y) % 7 === 0 ? floors[1] : floors[0]);
    }
  }

  for (let x = 0; x < iw; x++) {
    s.set('Furniture', x, 0, windowOr(kit, 'N', x, iw));
    s.set('Furniture', x, ih, kit.wallN); // south wall, on the margin row
  }
  for (let y = 0; y < ih; y++) {
    s.set('Furniture', 0, y, windowOr(kit, 'W', y, ih));
    s.set('Furniture', iw, y, kit.wallW); // east wall, on the margin column
  }

  s.set('Furniture', 0, 0, kit.corner);

  // One door, in the middle of the south wall — the face a player walking up a
  // street most often approaches.
  s.set('Furniture', Math.floor(iw / 2), ih, kit.doorN);

  return s;
}

/**
 * Windows on a rhythm, but never on a corner square: a window tile there would
 * replace the corner and open a hole in two walls at once.
 */
function windowOr(kit, dir, i, extent) {
  const wall = dir === 'N' ? kit.wallN : kit.wallW;
  const win = dir === 'N' ? kit.windowN : kit.windowW;
  if (!win) return wall;
  if (i === 0 || i >= extent - 1) return wall;
  return i % 3 === 1 ? win : wall;
}

/**
 * Build the whole built-in set.
 * @param {import('../formats/tiledefs.js').TileCatalogue} cat
 */
export function buildStarterLibrary(cat) {
  if (!cat) throw new Error('the built-in library needs the game tile catalogue');

  const kits = new Map();
  for (const [name, tileset] of Object.entries(KITS)) {
    const kit = kitFromTileset(cat, tileset);
    if (kit) kits.set(name, kit);
  }

  const out = [];
  for (const spec of CATALOGUE) {
    const kit = kits.get(spec.kit);
    if (!kit) continue; // sheet missing or incomplete in this build
    const floors = FLOORS[spec.kit];
    for (const [iw, ih] of spec.sizes) {
      const name = `pzwstarter_${spec.cls}_${spec.kit}_${iw}x${ih}`;
      out.push({ schematic: makeBuilding(name, spec.cls, kit, floors, iw, ih), cls: spec.cls, rooms: [] });
    }
  }
  return out;
}

/** Every tile name the built-in set can emit, for validation. */
export function starterTileNames(cat) {
  const names = new Set();
  for (const list of Object.values(FLOORS)) for (const f of list) names.add(f);
  for (const tileset of Object.values(KITS)) {
    const kit = kitFromTileset(cat, tileset);
    if (!kit) continue;
    for (const [k, v] of Object.entries(kit)) if (k !== 'tileset' && v) names.add(v);
  }
  return names;
}

export { KITS };
