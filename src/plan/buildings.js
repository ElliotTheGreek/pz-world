/**
 * Choosing a building for a footprint, and putting it on the grid.
 *
 * Two things have to be true at once for the map to feel like the real place:
 *
 *   * a footprint gets a building of the **right type** — the supermarket on
 *     the corner becomes a shop, not a bungalow;
 *   * it gets one of roughly the **right size and orientation**, so the street
 *     still reads as the street.
 *
 * Type comes from OSM tags (config/osm-tags.jsonc) falling back to footprint
 * area. Size and orientation come from the oriented bounding box in
 * src/geo/orient.js, snapped to a quarter-turn because Project Zomboid has no
 * other option for a wall.
 *
 * The choice is drawn from a stream keyed by the footprint's geometry hash, so
 * the same building in the same city always gets the same prototype however
 * many times it is regenerated — Terrula's decision D16, for the same reason.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJsonc } from '../lib/jsonc.js';
import { streamFor } from '../lib/rng.js';
import { deserialise } from '../extract/harvest.js';
import { rotate } from '../prefab/schematic.js';
import { snapFootprint } from '../geo/orient.js';
import { loadBuildingClasses } from '../prefab/classify.js';
import { buildStarterLibrary } from '../prefab/starter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OSM_TAGS = path.resolve(HERE, '../../config/osm-tags.jsonc');

let tagTable = null;

export function loadTagTable(file = OSM_TAGS) {
  if (tagTable && tagTable.file === file) return tagTable;
  const raw = readJsonc(file);
  tagTable = { file, ...raw };
  return tagTable;
}

/**
 * OSM tags to a building class, falling back to footprint area.
 *
 * `building=yes` is both extremely common and completely uninformative, which
 * is why the area fallback is not an edge case here any more than the storey
 * fallback is in Terrula's FEMA ingest.
 */
export function classifyFromTags(tags, areaSquares, table = loadTagTable()) {
  for (const rule of table.buildings) {
    const value = tags[rule.tag];
    if (value === undefined) continue;
    if (rule.value === '*' || rule.value === value) return rule.class;
  }
  const classes = loadBuildingClasses();
  const bySize = classes.areaFallback.find((r) => areaSquares <= r.maxArea);
  return bySize?.class ?? classes.fallback;
}

/**
 * The prefab library, indexed for lookup by class and size.
 */
export class Library {
  /**
   * @param {string|null} dir  a harvested library, or null for the built-in set
   * @param {import('../formats/tiledefs.js').TileCatalogue} [cat]
   *   required for the built-in set, which derives its wall kits from it
   */
  constructor(dir, cat = null) {
    this.dir = dir;
    /** @type {Map<string, import('../prefab/schematic.js').Schematic>} */
    this.loaded = new Map();
    this.entries = [];
    this.source = 'starter';

    if (dir) {
      const indexFile = path.join(dir, 'index.json');
      if (!fs.existsSync(indexFile)) {
        throw new Error(
          `no prefab library at ${dir}. Run \`npm run extract\` to harvest one from your ` +
            'Project Zomboid install, or pass --library starter for the built-in set.',
        );
      }
      this.entries = JSON.parse(fs.readFileSync(indexFile, 'utf8')).buildings ?? [];
      this.source = 'extracted';
    } else {
      // The built-in set lives in memory: it is generated from rules, so there
      // is nothing to read and nothing to keep in sync on disk.
      for (const { schematic, cls } of buildStarterLibrary(cat)) {
        this.entries.push({ name: schematic.name, cls, w: schematic.w, h: schematic.h });
        this.loaded.set(schematic.name, schematic);
      }
    }

    /** @type {Map<string, object[]>} */
    this.byClass = new Map();
    for (const e of this.entries) {
      let list = this.byClass.get(e.cls);
      if (!list) this.byClass.set(e.cls, (list = []));
      list.push(e);
    }
  }

  /**
   * Prefer a harvested library, fall back to the built-in one. This is what
   * makes `generate` work on a fresh clone before `extract` has ever run.
   */
  static open(dir, { cat = null, log = () => {} } = {}) {
    if (dir && dir !== 'starter' && fs.existsSync(path.join(dir, 'index.json'))) {
      const lib = new Library(dir);
      log(`prefab library: ${lib.size} harvested buildings across ${lib.classes().length} classes`);
      return lib;
    }
    const lib = new Library(null, cat);
    log(
      `prefab library: ${lib.size} built-in buildings across ${lib.classes().length} classes ` +
        '(run `npm run extract` for the full set)',
    );
    return lib;
  }

  get size() {
    return this.entries.length;
  }

  classes() {
    return [...this.byClass.keys()].sort();
  }

  count(cls) {
    return this.byClass.get(cls)?.length ?? 0;
  }

  /** Load and cache one prototype's full schematic. */
  schematic(entry) {
    let s = this.loaded.get(entry.name);
    if (!s) {
      if (!entry.file) throw new Error(`prototype ${entry.name} has no file and is not preloaded`);
      const obj = JSON.parse(fs.readFileSync(path.join(this.dir, entry.file), 'utf8'));
      s = deserialise(obj);
      this.loaded.set(entry.name, s);
    }
    return s;
  }

  /**
   * Best prototype for a footprint of `w`×`h` squares.
   *
   * A prototype may be used at either of its two aspects, since a quarter-turn
   * is free. It must fit inside the footprint — a building spilling past its
   * own plot would overwrite the pavement and its neighbour — but not be so
   * much smaller that the plot reads as empty.
   *
   * @returns {{entry: object, turns: number, w: number, h: number}|null}
   */
  fit(cls, w, h, rng) {
    const pool = this.byClass.get(cls);
    if (!pool?.length) return null;

    const candidates = [];
    for (const e of pool) {
      // Unrotated, then rotated a quarter-turn.
      for (const turns of [0, 1]) {
        const pw = turns === 0 ? e.w : e.h;
        const ph = turns === 0 ? e.h : e.w;
        if (pw > w || ph > h) continue;
        const waste = w * h - pw * ph;
        candidates.push({ entry: e, turns, w: pw, h: ph, waste });
      }
    }
    if (!candidates.length) return null;

    // Prefer a snug fit, but choose randomly among the snuggest so that a
    // street of identical plots does not become a street of identical houses.
    candidates.sort((a, b) => a.waste - b.waste);
    const best = candidates[0].waste;
    const slack = Math.max(16, best * 0.35);
    const shortlist = candidates.filter((c) => c.waste <= best + slack);
    const chosen = rng.pick(shortlist);
    return { entry: chosen.entry, turns: chosen.turns, w: chosen.w, h: chosen.h };
  }
}

/**
 * Place every building.
 *
 * @param {object[]} buildings normalised OSM buildings, points already in world squares
 * @param {Library} library
 * @param {import('../formats/tiledefs.js').TileCatalogue} cat
 * @param {{seed: number|string, log?: Function}} opts
 */
export function placeBuildings(buildings, library, cat, opts) {
  const { seed, log = () => {} } = opts;
  const placements = [];
  const stats = {
    total: buildings.length,
    placed: 0,
    noPrototype: new Map(),
    tooSmall: 0,
    residuals: [],
    byClass: new Map(),
  };

  for (const b of buildings) {
    const snap = snapFootprint(b.points);
    const w = Math.round(snap.w);
    const h = Math.round(snap.h);

    // Below this a footprint is source noise — a bin store, a map error —
    // rather than a building. Terrula draws the same line at 9 m².
    if (w < 3 || h < 3) {
      stats.tooSmall++;
      continue;
    }

    const cls = classifyFromTags(b.tags, w * h);
    const rng = streamFor(seed, 'building', b.fid);

    // The library is thin in some classes — 11 education buildings against
    // 4,974 houses — so falling back keeps a school-shaped plot occupied
    // instead of leaving a hole in the town.
    let chosen = null;
    let usedClass = cls;
    for (const candidate of [cls, ...fallbackClasses(cls)]) {
      chosen = library.fit(candidate, w, h, rng);
      if (chosen) {
        usedClass = candidate;
        break;
      }
    }
    if (!chosen) {
      stats.noPrototype.set(cls, (stats.noPrototype.get(cls) ?? 0) + 1);
      continue;
    }

    const schematic = rotate(library.schematic(chosen.entry), cat, chosen.turns);

    // Centre the prototype on the footprint's own centre so it sits where the
    // real building sits, rather than in the corner of its bounding box.
    const x = Math.round(snap.cx - chosen.w / 2);
    const y = Math.round(snap.cy - chosen.h / 2);

    placements.push({
      fid: b.fid,
      cls: usedClass,
      requestedClass: cls,
      name: b.name,
      x,
      y,
      w: chosen.w,
      h: chosen.h,
      turns: chosen.turns,
      schematic,
      residualDeg: snap.residualDeg,
    });

    stats.placed++;
    stats.residuals.push(Math.abs(snap.residualDeg));
    stats.byClass.set(usedClass, (stats.byClass.get(usedClass) ?? 0) + 1);
  }

  stats.residuals.sort((a, b) => a - b);
  log(`placed ${stats.placed} of ${stats.total} buildings`);
  return { placements, stats };
}

/**
 * Where to look when a class has no prototype that fits. Ordered by how little
 * the substitution lies about the place: a clinic standing in for a hospital is
 * a smaller untruth than a house standing in for one.
 */
function fallbackClasses(cls) {
  const chain = {
    medical: ['office', 'civic'],
    education: ['office', 'civic'],
    civic: ['office'],
    fire: ['garage', 'industrial'],
    police: ['office', 'civic'],
    church: ['civic', 'house'],
    grocery: ['retail'],
    restaurant: ['retail', 'bar'],
    bar: ['restaurant', 'retail'],
    gas_station: ['retail', 'garage'],
    apartment: ['office', 'house'],
    warehouse: ['industrial', 'garage'],
    industrial: ['warehouse', 'garage'],
    retail: ['office'],
    office: ['retail'],
    farm: ['shed', 'garage'],
    garage: ['shed'],
    house: ['shed'],
    unknown: ['house', 'shed'],
  };
  return chain[cls] ?? ['house', 'shed'];
}
