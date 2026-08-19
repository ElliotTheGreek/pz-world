import { splitTileName } from './vanilla-tiles.js';

export const SUPPORT_STATUSES = [
  'used',
  'mapped-but-unused',
  'unknown',
  'incompatible',
  'intentionally-excluded',
];

export const SAFETY_STATUSES = ['safe', 'context-required', 'unknown', 'incompatible', 'excluded'];

const CONTEXT_REQUIRED_FAMILIES = new Set(['structural', 'decorative', 'signage', 'curb', 'marking']);
const MAPPED_FAMILIES = new Set(['floor', 'road', 'overlay', 'vegetation', 'curb', 'marking', 'signage']);

function increment(object, key) {
  object[key] = (object[key] ?? 0) + 1;
}

function sortedCounts(values) {
  const counts = {};
  for (const value of values) increment(counts, value);
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function attachmentDirections(properties = {}) {
  return ['N', 'E', 'S', 'W'].filter((direction) => `FloorAttachment${direction}` in properties);
}

export function inferAssetRole(tile) {
  const properties = tile.properties ?? {};
  const directions = attachmentDirections(properties);
  if (tile.family === 'road' || tile.family === 'floor') {
    if ('IsFloorAttached' in properties) return directions.length > 1 ? 'surface-corner' : 'surface-edge';
    return tile.family === 'road' ? 'road-surface' : 'ground-or-floor';
  }
  if (tile.family === 'overlay') return 'surface-overlay';
  if (tile.family === 'marking') return 'road-marking';
  if (tile.family === 'curb') return 'road-edge';
  if (tile.family === 'signage') return 'signage';
  if (tile.family === 'vegetation') return 'vegetation';
  if (tile.family === 'structural') {
    const keys = Object.keys(properties);
    if (keys.some((key) => /^Door/i.test(key))) return 'door';
    if (keys.some((key) => /^Window/i.test(key))) return 'window';
    if (keys.some((key) => /^Stairs/i.test(key))) return 'stairs';
    if (keys.some((key) => /^Roof/i.test(key))) return 'roof';
    return 'structure';
  }
  return 'decoration';
}

export function inferOrientation(tile, contextual = null) {
  const directions = attachmentDirections(tile.properties);
  if (directions.length) return directions.join('');
  const inferred = contextual?.orientationEvidence?.inferred;
  if (inferred && inferred !== 'unobserved') return inferred;
  const keys = Object.keys(tile.properties ?? {});
  const declared = ['N', 'E', 'S', 'W'].filter((direction) =>
    keys.some((key) => new RegExp(`(?:Wall|Window|Door).*${direction}(?:$|[^A-Za-z])`, 'i').test(key)),
  );
  return declared.length ? declared.join('') : 'unoriented';
}

export function variantOf(tile) {
  const parsed = Number.isInteger(tile.index) ? tile.index : splitTileName(tile.name).index;
  if (!Number.isInteger(parsed)) return { index: null, group: 'unindexed', offset: null };
  return { index: parsed, group: `block-${Math.floor(parsed / 16)}`, offset: parsed % 16 };
}

function excludedReason(tile) {
  const index = tile.index;
  if (tile.tileset === 'blends_natural_01' && Number.isInteger(index) && index >= 112 && index <= 127) {
    return 'malformed Clay blend block has edges but no usable base';
  }
  if (tile.tileset === 'blends_street_01' && Number.isInteger(index) && index >= 8 && index <= 11) {
    return 'Road_01 edge declarations conflict with measured neighboring surfaces';
  }
  return null;
}

/**
 * Classify one catalogue tile against the asset paths currently implemented by
 * the generator. `usedNames` includes direct selection pools and prefab content.
 */
export function classifyAssetCoverage(tile, usedNames = new Set(), usableBlendMaterials = new Set()) {
  const excluded = excludedReason(tile);
  if (excluded) return { supportStatus: 'intentionally-excluded', safetyStatus: 'excluded', reason: excluded };

  const unresolved = !tile.tileset || !Number.isInteger(tile.index);
  const outsideSheet = Boolean(tile.sources?.outsideDeclaredSheet);
  if ((unresolved || outsideSheet) && !usedNames.has(tile.name)) {
    return {
      supportStatus: 'incompatible',
      safetyStatus: 'incompatible',
      reason: unresolved ? 'name has no resolvable tileset and numeric index' : 'index is outside its declared sheet',
    };
  }

  const blendMaterial = tile.properties?.FloorMaterial;
  const dynamicallyUsed = Boolean(blendMaterial && usableBlendMaterials.has(blendMaterial));
  if (usedNames.has(tile.name) || dynamicallyUsed) {
    return {
      supportStatus: 'used',
      safetyStatus: CONTEXT_REQUIRED_FAMILIES.has(tile.family) ? 'context-required' : 'safe',
      reason: dynamicallyUsed ? 'selected by the property-driven surface blend renderer' : 'selected directly or retained in a placeable prefab',
    };
  }

  if (MAPPED_FAMILIES.has(tile.family)) {
    return {
      supportStatus: 'mapped-but-unused',
      safetyStatus: CONTEXT_REQUIRED_FAMILIES.has(tile.family) ? 'context-required' : 'safe',
      reason: `catalogued for the ${tile.family} role but no current emitter selects it`,
    };
  }

  if (tile.family === 'structural' || tile.family === 'decorative') {
    if (!tile.sources?.properties && !tile.sources?.lotheader) {
      return {
        supportStatus: 'unknown',
        safetyStatus: 'unknown',
        reason: 'declared sheet slot has no behavioural properties or vanilla placement evidence',
      };
    }
    return {
      supportStatus: 'intentionally-excluded',
      safetyStatus: 'context-required',
      reason: 'not emitted loose; structural and decorative assets are only supported through retained prefabs',
    };
  }

  return { supportStatus: 'unknown', safetyStatus: 'unknown', reason: 'no compatibility or emitter rule is known' };
}

/** Build the serialisable, searchable inventory from prior-task catalogues. */
export function buildAssetInventory(catalogue, contextualUsage, options = {}) {
  const usedNames = options.usedNames ?? new Set();
  const usableBlendMaterials = options.usableBlendMaterials ?? new Set();
  const contextByName = new Map((contextualUsage?.tiles ?? []).map((tile) => [tile.name, tile]));
  const assets = catalogue.tiles.map((tile) => {
    const contextual = contextByName.get(tile.name) ?? null;
    const coverage = classifyAssetCoverage(tile, usedNames, usableBlendMaterials);
    return {
      name: tile.name,
      assetFamily: tile.tileset ?? '(unresolved)',
      catalogueFamily: tile.family,
      role: inferAssetRole(tile),
      orientation: inferOrientation(tile, contextual),
      variant: variantOf(tile),
      safetyStatus: coverage.safetyStatus,
      supportStatus: coverage.supportStatus,
      statusReason: coverage.reason,
      layerSuitability: tile.layerSuitability,
      sources: tile.sources,
      observed: {
        vanillaLotheaders: Boolean(tile.sources?.lotheader),
        vanillaMapCount: tile.lotheaderUsage?.mapCount ?? 0,
        vanillaCellCount: tile.lotheaderUsage?.cellCount ?? 0,
        contextualPlacements: contextual?.frequency?.placements ?? 0,
        contextualCells: contextual?.frequency?.cellCount ?? 0,
      },
      evidence: contextual ? {
        orientationConfidence: contextual.orientationEvidence?.confidence ?? 0,
        roadContext: contextual.roadContext ?? [],
        runPosition: contextual.runPosition ?? [],
      } : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const byFamily = new Map();
  for (const asset of assets) {
    let group = byFamily.get(asset.assetFamily);
    if (!group) byFamily.set(asset.assetFamily, (group = []));
    group.push(asset);
  }
  const families = [...byFamily].map(([name, members]) => ({
    name,
    assetCount: members.length,
    roles: sortedCounts(members.map((asset) => asset.role)),
    orientations: sortedCounts(members.map((asset) => asset.orientation)),
    variants: sortedCounts(members.map((asset) => asset.variant.group)),
    safetyStatuses: sortedCounts(members.map((asset) => asset.safetyStatus)),
    supportStatuses: sortedCounts(members.map((asset) => asset.supportStatus)),
    observedAssets: members.filter((asset) => asset.observed.vanillaLotheaders).length,
    contextualPlacements: members.reduce((sum, asset) => sum + asset.observed.contextualPlacements, 0),
  })).sort((a, b) => a.name.localeCompare(b.name));

  const summary = {
    assets: assets.length,
    assetFamilies: families.length,
    catalogueFamilies: sortedCounts(assets.map((asset) => asset.catalogueFamily)),
    roles: sortedCounts(assets.map((asset) => asset.role)),
    orientations: sortedCounts(assets.map((asset) => asset.orientation)),
    safetyStatuses: sortedCounts(assets.map((asset) => asset.safetyStatus)),
    supportStatuses: sortedCounts(assets.map((asset) => asset.supportStatus)),
  };

  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    gameVersion: catalogue.gameVersion ?? null,
    source: options.source ?? {},
    methodology: {
      family: 'tileset name; unresolved observed names are grouped under (unresolved)',
      role: 'derived from catalogue family and behavioural tile properties',
      orientation: 'declared attachment directions, then contextual same-sheet adjacency evidence, then directional structural properties',
      variant: 'numeric tile index grouped into conventional 16-slot blocks; exact index and offset are retained',
      safety: 'safe assets may be emitted directly; context-required assets are safe only through a prefab or topology-aware renderer',
      support: 'used takes precedence over exclusions and mappings except for explicitly rejected blend ranges',
    },
    summary,
    families,
    assets,
  };
}

export function renderAssetCoverageReport(inventory) {
  const lines = [
    '# Asset inventory and coverage report',
    '',
    `Generated from vanilla Build ${inventory.gameVersion ?? 'unknown'} catalogue and contextual-use evidence.`,
    '',
    '## Summary',
    '',
    `- **${inventory.summary.assets.toLocaleString()} assets** in **${inventory.summary.assetFamilies.toLocaleString()} asset families**.`,
    `- Support: ${SUPPORT_STATUSES.map((status) => `${status} **${(inventory.summary.supportStatuses[status] ?? 0).toLocaleString()}**`).join('; ')}.`,
    `- Safety: ${SAFETY_STATUSES.map((status) => `${status} **${(inventory.summary.safetyStatuses[status] ?? 0).toLocaleString()}**`).join('; ')}.`,
    '',
    '## Status definitions',
    '',
    '- `used`: selected by a current emitter, a property-driven blend set, or retained in a placeable extracted prefab.',
    '- `mapped-but-unused`: has a known pipeline role but no current emitter selects it.',
    '- `unknown`: discovered, but no compatibility or support rule is known.',
    '- `incompatible`: cannot currently be addressed safely because its name/index is unresolved or outside its declared sheet.',
    '- `intentionally-excluded`: deliberately rejected artwork or loose assets that require prefab/topology context.',
    '- `context-required`: valid only when its surrounding structure or road topology is preserved.',
    '',
    '## Coverage by asset family',
    '',
    '| Asset family | Assets | Roles | Orientations | Variants | Safety | Support | Vanilla-observed | Context placements |',
    '|---|---:|---|---|---|---|---|---:|---:|',
  ];
  const compact = (counts) => Object.entries(counts).map(([key, count]) => `${key}:${count}`).join(', ');
  for (const family of inventory.families) {
    lines.push(`| ${family.name.replaceAll('|', '\\|')} | ${family.assetCount} | ${compact(family.roles)} | ${compact(family.orientations)} | ${compact(family.variants)} | ${compact(family.safetyStatuses)} | ${compact(family.supportStatuses)} | ${family.observedAssets} | ${family.contextualPlacements} |`);
  }
  lines.push(
    '',
    '## Search and audit',
    '',
    '`library/asset-inventory.json` is the authoritative machine-readable report. Search `assets[]` by `name`, `assetFamily`, `catalogueFamily`, `role`, `orientation`, `variant`, `safetyStatus`, or `supportStatus`. The `families[]` records provide distributions over those same dimensions without dropping mixed-status families.',
    '',
    'Generation is deterministic apart from `generatedAt`; rerun `npm run inventory-assets`. Validation is available as `npm run verify-inventory-assets`.',
    '',
  );
  return lines.join('\n');
}
