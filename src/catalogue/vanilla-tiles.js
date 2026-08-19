const STRUCTURAL_PREFIXES = [
  'walls_',
  'fixtures_doors',
  'fixtures_windows',
  'fixtures_stairs',
  'fixtures_railings',
  'fencing_',
  'roofs_',
];

function hasPrefix(name, prefixes) {
  return prefixes.some((prefix) => name.startsWith(prefix));
}

/** Split the conventional `<sheet>_<index>` tile name. */
export function splitTileName(name) {
  const match = /^(.*)_([0-9]+)$/.exec(name);
  if (!match) return { tileset: null, index: null };
  return { tileset: match[1], index: Number(match[2]) };
}

/**
 * Broad visual family used by the asset pipeline. Categories are deliberately
 * exclusive so coverage totals can be compared without double counting.
 */
export function classifyTileFamily(name, props = {}) {
  const lower = name.toLowerCase();
  if (lower.startsWith('street_trafficlines') || lower.includes('roadmarking')) return 'marking';
  if (lower.startsWith('street_curbs')) return 'curb';
  if (
    lower.startsWith('street_roadsigns') ||
    lower.startsWith('signs_') ||
    lower.includes('_signs_') ||
    lower.startsWith('advertising_') ||
    lower.startsWith('papernotices_') ||
    lower.startsWith('constructedobjects_signs_')
  ) return 'signage';
  if (
    lower.startsWith('blends_street_') ||
    lower.startsWith('floors_exterior_street_') ||
    lower.startsWith('floors_overlay_street_') ||
    lower.startsWith('blends_streetoverlays_')
  ) return 'road';
  if (
    lower.startsWith('overlay_') ||
    lower.startsWith('blends_grassoverlays_') ||
    lower.startsWith('floors_overlay_') ||
    lower.startsWith('d_floor') ||
    lower.startsWith('d_street') ||
    lower.startsWith('d_wall') ||
    lower.startsWith('f_wallvines_') ||
    'WallOverlay' in props
  ) return 'overlay';
  if (
    lower.startsWith('vegetation_') ||
    lower.startsWith('e_') ||
    lower.startsWith('f_bushes_') ||
    lower.startsWith('f_flowerbed_') ||
    lower.startsWith('d_plants_') ||
    lower.startsWith('jumbo_tree_')
  ) return 'vegetation';
  if (
    lower.startsWith('floors_') ||
    lower.startsWith('blends_natural_') ||
    lower.startsWith('floor_') ||
    'FloorMaterial' in props ||
    'solidfloor' in props
  ) return 'floor';
  if (hasPrefix(lower, STRUCTURAL_PREFIXES) || Object.keys(props).some((key) => /^(Wall|Window|DoorWall)/.test(key))) {
    return 'structural';
  }
  return 'decorative';
}

/** Slots in which the tile can safely be considered by renderers. */
export function layerSuitability(name, props, family) {
  const layers = [];
  const roleKeys = Object.keys(props);
  if (family === 'floor' || family === 'road' || 'FloorMaterial' in props || 'solidfloor' in props) layers.push('floor');
  if (family === 'overlay' || family === 'marking') layers.push('floor-overlay');
  if (family === 'structural') layers.push('structure');
  if (roleKeys.some((key) => /^Wall/.test(key)) || name.includes('_wall_')) layers.push('wall');
  if (family === 'signage') layers.push(name.includes('_wall') ? 'wall-overlay' : 'object');
  if (family === 'curb') layers.push('object', 'road-edge');
  if (family === 'vegetation' || family === 'decorative') layers.push('object');
  if (!layers.length) layers.push('object');
  return [...new Set(layers)];
}

/** Property keys that explicitly declare a behavioural or directional role. */
export function declaredRoles(props) {
  return Object.keys(props)
    .filter((key) =>
      /^(Wall|Window|Door|Floor|Roof|Curtain|Stairs|Hoppable|CanPath|container|IsoType|water|tree|vegetation)/i.test(key),
    )
    .sort();
}

/**
 * Build the serialisable inventory. `observations` maps a tile name to map and
 * cell sets gathered from lotheader tile dictionaries.
 */
export function buildVanillaTileCatalogue(cat, observations, metadata = {}) {
  const names = new Set(observations.keys());
  for (const [tileset, count] of cat.sheetSize) {
    for (let index = 0; index < count; index++) names.add(`${tileset}_${index}`);
  }
  for (const name of cat.tiles.keys()) names.add(name);

  const familyCounts = {};
  const sourceCounts = { declaredSheetSlots: 0, propertyDefinitions: 0, observedLotheaders: 0, observedOnly: 0 };
  const tiles = [];
  for (const name of [...names].sort()) {
    const def = cat.get(name);
    const parsed = splitTileName(name);
    const tileset = def?.tileset ?? parsed.tileset;
    const index = Number.isInteger(def?.index) ? def.index : parsed.index;
    const dimensions = tileset ? cat.sheetDimensions.get(tileset) ?? null : null;
    const inDeclaredSheet = Boolean(tileset && Number.isInteger(index) && index >= 0 && index < (cat.sheetSize.get(tileset) ?? 0));
    const observed = observations.get(name);
    const props = def ? Object.fromEntries(Object.entries(def.props).sort(([a], [b]) => a.localeCompare(b))) : {};
    const family = classifyTileFamily(name, props);
    familyCounts[family] = (familyCounts[family] ?? 0) + 1;
    if (inDeclaredSheet) sourceCounts.declaredSheetSlots++;
    if (def) sourceCounts.propertyDefinitions++;
    if (observed) sourceCounts.observedLotheaders++;
    if (observed && !inDeclaredSheet && !def) sourceCounts.observedOnly++;

    tiles.push({
      name,
      tileset,
      index,
      sheet: dimensions ? { ...dimensions, size: dimensions.width * dimensions.height } : null,
      sources: {
        declaredSheet: inDeclaredSheet,
        properties: Boolean(def),
        lotheader: Boolean(observed),
        absentFromTileDefinitions: Boolean(observed && !def),
        outsideDeclaredSheet: Boolean(observed && !inDeclaredSheet),
      },
      properties: props,
      declaredRoles: declaredRoles(props),
      family,
      layerSuitability: layerSuitability(name, props, family),
      lotheaderUsage: {
        maps: observed ? [...observed.maps].sort() : [],
        mapCount: observed?.maps.size ?? 0,
        cellCount: observed?.cells.size ?? 0,
      },
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ...metadata,
    summary: {
      tiles: tiles.length,
      tilesets: cat.sheetSize.size,
      families: Object.fromEntries(Object.entries(familyCounts).sort(([a], [b]) => a.localeCompare(b))),
      sources: sourceCounts,
    },
    tilesets: [...cat.sheetSize]
      .map(([name, size]) => ({ name, ...(cat.sheetDimensions.get(name) ?? {}), size }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    tiles,
  };
}
