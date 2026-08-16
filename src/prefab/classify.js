/**
 * Turning a building's rooms into a class.
 *
 * The room graph in a lotheader is semantic — "grocerystorage", "prisoncells",
 * "kidsbedroom" — because Project Zomboid's own loot distribution keys off
 * those names. That makes it a far better classifier than footprint size, and
 * it is the reason extracting from the vanilla map gives us type-correct
 * prototypes for free.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonc } from '../lib/jsonc.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.resolve(HERE, '../../config/building-classes.jsonc');

let cached = null;

export function loadBuildingClasses(file = CONFIG) {
  if (cached && cached.file === file) return cached;
  const raw = readJsonc(file);
  const classes = new Map();
  for (const [name, spec] of Object.entries(raw.classes)) {
    classes.set(name, {
      name,
      note: spec.note,
      rooms: (spec.rooms ?? []).map((r) => ({ match: new RegExp(r.match), weight: r.weight ?? 1 })),
    });
  }
  cached = {
    file,
    classes,
    fallback: raw.fallback ?? 'unknown',
    areaFallback: raw.areaFallback ?? [],
    names: [...classes.keys()],
  };
  return cached;
}

/**
 * Score a building's rooms against every class and return the winner.
 *
 * @param {string[]} roomNames
 * @param {number} area  in squares, used only when the rooms say nothing
 * @returns {{cls: string, score: number, scores: Record<string, number>}}
 */
export function classifyBuilding(roomNames, area = 0, table = loadBuildingClasses()) {
  const scores = {};
  for (const [name, spec] of table.classes) {
    let total = 0;
    for (const room of roomNames) {
      for (const rule of spec.rooms) {
        if (rule.match.test(room)) total += rule.weight;
      }
    }
    if (total > 0) scores[name] = total;
  }

  let bestName = null;
  let bestScore = 0;
  for (const [name, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestName = name;
    }
  }

  // Weak evidence: a couple of generic rooms ("hall", "kitchen") is not enough
  // to call something a restaurant. Fall back to size, the way Terrula's
  // feature profile does when FEMA's occupancy class is Unclassified.
  if (!bestName || bestScore < 3) {
    const bySize = table.areaFallback.find((r) => area <= r.maxArea);
    if (bySize && (!bestName || bestScore < 2)) {
      return { cls: bySize.class, score: 0, scores };
    }
  }

  return { cls: bestName ?? table.fallback, score: bestScore, scores };
}
