import { splitTileName } from './vanilla-tiles.js';

export const CARDINALS = [
  ['north', 0, -1, 1],
  ['east', 1, 0, 2],
  ['south', 0, 1, 4],
  ['west', -1, 0, 8],
];

const TOPOLOGY = new Map([
  [0, 'isolated'],
  [1, 'dead-end'], [2, 'dead-end'], [4, 'dead-end'], [8, 'dead-end'],
  [3, 'corner'], [6, 'corner'], [9, 'corner'], [12, 'corner'],
  [5, 'straight-ns'], [10, 'straight-ew'],
  [7, 't-junction'], [11, 't-junction'], [13, 't-junction'], [14, 't-junction'],
  [15, 'cross'],
]);

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function topEntries(map, limit) {
  return [...map]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function tileMeta(name, catalogue) {
  const known = catalogue.get(name);
  if (known) return known;
  const { tileset, index } = splitTileName(name);
  return { name, tileset, index, family: 'unknown', declaredRoles: [], properties: {} };
}

function surfaceOn(names, catalogue) {
  for (const name of names) {
    const family = tileMeta(name, catalogue).family;
    if (family === 'road' || family === 'floor') return name;
  }
  return null;
}

function isRoadSurface(name, catalogue) {
  return name != null && tileMeta(name, catalogue).family === 'road';
}

function sameSheet(a, b, catalogue) {
  const as = tileMeta(a, catalogue).tileset;
  return as != null && as === tileMeta(b, catalogue).tileset;
}

function runPosition(mask) {
  const ns = Boolean(mask & 1) + Boolean(mask & 4);
  const ew = Boolean(mask & 2) + Boolean(mask & 8);
  const count = ns + ew;
  if (count === 0) return 'isolated';
  if (count === 1) return 'end';
  if (count >= 3) return count === 4 ? 'cross' : 'branch';
  if (ns === 2) return 'middle-ns';
  if (ew === 2) return 'middle-ew';
  return 'corner';
}

function orientation(mask) {
  const ns = Boolean(mask & 1) + Boolean(mask & 4);
  const ew = Boolean(mask & 2) + Boolean(mask & 8);
  if (ns > ew) return 'north-south';
  if (ew > ns) return 'east-west';
  if (ns && ew) return 'corner-or-junction';
  return 'isolated';
}

function emptyUsage(meta) {
  return {
    meta,
    placements: 0,
    squares: 0,
    maps: new Set(),
    cells: new Set(),
    levels: new Map(),
    stackPositions: new Map(),
    cooccurrence: new Map(),
    surfaces: new Map(),
    neighborSurfaces: Object.fromEntries(CARDINALS.map(([direction]) => [direction, new Map()])),
    neighborFamilies: Object.fromEntries(CARDINALS.map(([direction]) => [direction, new Map()])),
    sameSheetMasks: new Map(),
    runPositions: new Map(),
    orientations: new Map(),
    roadContext: new Map(),
    roadTopology: new Map(),
  };
}

/**
 * Aggregate contextual evidence from one decoded cell.
 * `squares(x,y,z)` returns ordered tile names. Cell-edge neighbors are marked
 * unobserved rather than guessed; callers can merge any number of cells.
 */
export function analyzeCellUsage({ map, cell, width, height, minLevel = 0, maxLevel = 0, squares }, catalogue, usages = new Map()) {
  for (let z = minLevel; z <= maxLevel; z++) {
    const grid = new Array(width * height);
    const surfaces = new Array(width * height);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const i = x * height + y;
        const names = squares(x, y, z) ?? [];
        grid[i] = names;
        surfaces[i] = surfaceOn(names, catalogue);
      }
    }

    const at = (x, y) => x < 0 || y < 0 || x >= width || y >= height ? null : grid[x * height + y];
    const surfaceAt = (x, y) => x < 0 || y < 0 || x >= width || y >= height ? null : surfaces[x * height + y];

    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const names = at(x, y);
        if (!names?.length) continue;
        const unique = [...new Set(names)];
        const surface = surfaceAt(x, y);
        let roadMask = 0;
        for (const [, dx, dy, bit] of CARDINALS) if (isRoadSurface(surfaceAt(x + dx, y + dy), catalogue)) roadMask |= bit;
        const roadHere = isRoadSurface(surface, catalogue);

        for (const name of unique) {
          let usage = usages.get(name);
          if (!usage) usages.set(name, (usage = emptyUsage(tileMeta(name, catalogue))));
          const occurrences = names.filter((candidate) => candidate === name).length;
          usage.placements += occurrences;
          usage.squares++;
          usage.maps.add(map);
          usage.cells.add(`${map}/${cell}`);
          increment(usage.levels, String(z), occurrences);
          names.forEach((candidate, index) => {
            if (candidate === name) increment(usage.stackPositions, String(index), 1);
          });
          for (const other of unique) if (other !== name) increment(usage.cooccurrence, other);
          increment(usage.surfaces, surface ?? '(none)');

          let sheetMask = 0;
          for (const [direction, dx, dy, bit] of CARDINALS) {
            const neighborNames = at(x + dx, y + dy);
            if (neighborNames == null) continue;
            const neighborSurface = surfaceAt(x + dx, y + dy);
            increment(usage.neighborSurfaces[direction], neighborSurface ?? '(none)');
            const families = new Set(neighborNames.map((neighbor) => tileMeta(neighbor, catalogue).family));
            if (!families.size) families.add('(empty)');
            for (const family of families) increment(usage.neighborFamilies[direction], family);
            if (neighborNames.some((neighbor) => sameSheet(name, neighbor, catalogue))) sheetMask |= bit;
          }
          increment(usage.sameSheetMasks, sheetMask.toString(16).toUpperCase());
          increment(usage.runPositions, runPosition(sheetMask));
          increment(usage.orientations, orientation(sheetMask));

          const context = roadHere ? 'on-road' : roadMask ? 'road-edge' : 'off-road';
          increment(usage.roadContext, context);
          if (roadHere) increment(usage.roadTopology, TOPOLOGY.get(roadMask) ?? 'unknown');
        }
      }
    }
  }
  return usages;
}

/** Convert mutable aggregates to a bounded, deterministic JSON document. */
export function serializeContextualUsage(usages, metadata = {}, limit = 24) {
  const tiles = [...usages]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, usage]) => {
      const undeclared = !(usage.meta.declaredRoles?.length);
      const orientationEvidence = topEntries(usage.orientations, 4);
      return {
        name,
        tileset: usage.meta.tileset ?? null,
        index: usage.meta.index ?? null,
        family: usage.meta.family,
        declaredRoles: usage.meta.declaredRoles ?? [],
        evidencePriority: undeclared && ['curb', 'road', 'overlay', 'marking', 'unknown'].includes(usage.meta.family) ? 'high' : undeclared ? 'normal' : 'declared',
        frequency: {
          placements: usage.placements,
          occupiedSquares: usage.squares,
          mapCount: usage.maps.size,
          cellCount: usage.cells.size,
          maps: [...usage.maps].sort(),
          levels: topEntries(usage.levels, limit),
          stackPositions: topEntries(usage.stackPositions, limit),
        },
        cooccurrence: topEntries(usage.cooccurrence, limit),
        surfaceContext: topEntries(usage.surfaces, limit),
        neighboringSurfaces: Object.fromEntries(CARDINALS.map(([direction]) => [direction, topEntries(usage.neighborSurfaces[direction], limit)])),
        neighboringFamilies: Object.fromEntries(CARDINALS.map(([direction]) => [direction, topEntries(usage.neighborFamilies[direction], limit)])),
        orientationEvidence: {
          inferred: orientationEvidence[0]?.value ?? 'unobserved',
          confidence: usage.squares ? (orientationEvidence[0]?.count ?? 0) / usage.squares : 0,
          distributions: orientationEvidence,
          sameSheetNeighborMasks: topEntries(usage.sameSheetMasks, 16),
        },
        runPosition: topEntries(usage.runPositions, 8),
        roadContext: topEntries(usage.roadContext, 3),
        intersectionTopology: topEntries(usage.roadTopology, 8),
      };
    });

  const families = {};
  let placements = 0;
  let highPriorityEvidence = 0;
  for (const tile of tiles) {
    placements += tile.frequency.placements;
    families[tile.family] = (families[tile.family] ?? 0) + tile.frequency.placements;
    if (tile.evidencePriority === 'high') highPriorityEvidence++;
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ...metadata,
    methodology: {
      neighborDirections: 'screen/grid cardinal directions: north y-1, east x+1, south y+1, west x-1',
      orientation: 'inferred from cardinal adjacency to any tile on the same tileset sheet',
      runPosition: 'classified from the same-sheet cardinal-neighbor mask',
      roadTopology: 'classified from cardinal neighboring squares whose primary surface family is road',
      cellEdges: 'neighbors outside each decoded cell are unobserved and excluded from directional totals',
      boundedRelations: limit,
    },
    summary: {
      observedTiles: tiles.length,
      placements,
      highPriorityUndeclaredEvidence: highPriorityEvidence,
      placementsByFamily: Object.fromEntries(Object.entries(families).sort(([a], [b]) => a.localeCompare(b))),
    },
    tiles,
  };
}
