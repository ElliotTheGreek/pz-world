/**
 * Deciding which of a prefab's four layers a tile belongs to.
 *
 * A vanilla building square carries up to twelve tiles; a prefab square has
 * four slots with fixed meanings. Something has to be thrown away, and this is
 * where that judgement lives — deliberately in one place, driven by a table in
 * `config/tile-layers.jsonc` rather than scattered through the extractor.
 *
 * The ordering evidence comes from the map data itself. Sampling every
 * ground-floor room square in Muldraugh cell 51_7 gives:
 *
 *   slot 0  floors_interior_tilesandwood, floors_interior_carpet   — always the floor
 *   slot 1  overlay_grime_floor, furniture_seating, floors_rugs
 *   slot 2  walls_interior_*, overlay_grime_*
 *   slot 3  overlay_grime_wall, fixtures_doors
 *   slot 4  fixtures_counters, fixtures_stairs, lighting, appliances
 *
 * So the floor is reliably first, and everything after it is a mix of grime
 * overlays (visual noise, cheapest to lose) and structure (walls and doors,
 * which must survive or the building has holes in it).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonc } from '../lib/jsonc.js';

export const FLOOR = 'Floor';
export const FLOOR_FURNITURE = 'FloorFurniture';
export const FLOOR_OVERLAY = 'FloorOverlay';
export const FURNITURE = 'Furniture';

/** The exact list and order the game declares in PrefabStructure. */
export const LAYERS = [FLOOR, FLOOR_FURNITURE, FLOOR_OVERLAY, FURNITURE];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.resolve(HERE, '../../config/tile-layers.jsonc');

let cached = null;

export function loadLayerRules(file = CONFIG) {
  if (cached && cached.file === file) return cached;
  const raw = readJsonc(file);
  const rules = raw.rules.map((r) => ({
    match: new RegExp(r.match),
    layer: r.layer,
    priority: r.priority ?? 0,
    note: r.note,
  }));
  cached = { file, rules, fallback: raw.fallback };
  return cached;
}

/**
 * @returns {{layer: string, priority: number}}
 */
export function classifyTile(tileName, rules = loadLayerRules()) {
  for (const rule of rules.rules) {
    if (rule.match.test(tileName)) return { layer: rule.layer, priority: rule.priority };
  }
  return { layer: rules.fallback.layer, priority: rules.fallback.priority ?? 0 };
}

/**
 * Reduce a square's full tile stack to at most one tile per layer.
 *
 * Within a layer the highest priority wins, and ties go to the tile that
 * appeared first in the square — draw order in the lotpack is meaningful, so
 * the earlier tile is the one underneath and more likely to be structural.
 *
 * @param {string[]} tiles  in the order the lotpack stored them
 * @returns {{assigned: Record<string,string>, dropped: string[]}}
 */
export function assignSquare(tiles, rules = loadLayerRules()) {
  /** @type {Record<string, {tile: string, priority: number}>} */
  const best = {};
  const dropped = [];

  for (const tile of tiles) {
    const { layer, priority } = classifyTile(tile, rules);
    const cur = best[layer];
    if (!cur) {
      best[layer] = { tile, priority };
    } else if (priority > cur.priority) {
      dropped.push(cur.tile);
      best[layer] = { tile, priority };
    } else {
      dropped.push(tile);
    }
  }

  const assigned = {};
  for (const [layer, v] of Object.entries(best)) assigned[layer] = v.tile;
  return { assigned, dropped };
}
