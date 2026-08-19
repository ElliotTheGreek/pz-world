import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJsonc } from '../lib/jsonc.js';
import { hashString } from '../lib/rng.js';
import { LAYERS } from '../prefab/layers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SEMANTIC_REGISTRY = path.resolve(HERE, '../../config/semantic-mappings.jsonc');

const LAYER_SUITABILITY = {
  Floor: new Set(['floor']),
  FloorFurniture: new Set(['object', 'road-edge']),
  FloorOverlay: new Set(['floor-overlay', 'road-edge']),
  Furniture: new Set(['object']),
};

let cached = null;

function assert(condition, message) {
  if (!condition) throw new Error(`semantic mapping registry: ${message}`);
}

function normaliseVariant(variant) {
  if (typeof variant === 'string') return { tile: variant, weight: 1 };
  return { weight: 1, ...variant };
}

function normaliseOrientations(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

const ORIENTATION_ALIASES = new Map([
  ['n', 'north'], ['north', 'north'],
  ['e', 'east'], ['east', 'east'],
  ['s', 'south'], ['south', 'south'],
  ['w', 'west'], ['west', 'west'],
  ['ns', 'north-south'], ['north-south', 'north-south'],
  ['ew', 'east-west'], ['east-west', 'east-west'],
  ['nesw', 'ne-sw'], ['ne-sw', 'ne-sw'],
  ['nwse', 'nw-se'], ['nw-se', 'nw-se'],
  ['northeast', 'north-east'], ['north-east', 'north-east'],
  ['southeast', 'south-east'], ['south-east', 'south-east'],
  ['southwest', 'south-west'], ['south-west', 'south-west'],
  ['northwest', 'north-west'], ['north-west', 'north-west'],
]);

function canonicalOrientation(value) {
  if (typeof value !== 'string') return null;
  return ORIENTATION_ALIASES.get(value.toLowerCase().replaceAll('_', '-')) ?? null;
}

function assetAllowed(asset) {
  return Boolean(
    asset &&
    !['incompatible', 'intentionally-excluded'].includes(asset.supportStatus) &&
    !['incompatible', 'excluded'].includes(asset.safetyStatus)
  );
}

function observedInLotheader(asset) {
  return Boolean(asset?.sources?.lotheader || asset?.observed?.vanillaLotheaders);
}

function declaredInInventory(asset) {
  return Boolean(asset?.sources?.declaredSheet);
}

/**
 * Create an availability lookup backed by the installed tile-sheet dimensions and by
 * vanilla lotheader observations. Lotheader evidence is deliberately still accepted
 * when a tile is absent from definitions: Build 42 maps contain a small number of real,
 * observed-only sprites. Safety/support exclusions always win over either source.
 */
export function createAssetCompatibility(inventory, installedCatalogue = null) {
  const assets = new Map((inventory?.assets ?? []).map((asset) => [asset.name, asset]));
  const evidence = (tile) => {
    const asset = assets.get(tile);
    const installedSheet = Boolean(installedCatalogue?.tileExists(tile));
    const lotheader = observedInLotheader(asset);
    const declaredSheet = declaredInInventory(asset);
    return {
      asset: asset ?? null,
      installedSheet,
      lotheader,
      declaredSheet,
      allowed: assetAllowed(asset),
      available: assetAllowed(asset) && (installedCatalogue ? installedSheet || lotheader : declaredSheet || lotheader),
    };
  };
  return {
    assets,
    installedCatalogue,
    evidence,
    has(tile) {
      return evidence(tile).available;
    },
    asset(tile) {
      return assets.get(tile) ?? null;
    },
  };
}

/** Load and structurally validate the data-driven semantic-to-asset registry. */
export function loadSemanticRegistry(file = DEFAULT_SEMANTIC_REGISTRY) {
  if (cached?.file === file) return cached;
  const raw = readJsonc(file);
  assert(raw.schemaVersion === 1, `unsupported schemaVersion ${raw.schemaVersion}`);
  assert(Array.isArray(raw.mappings), 'mappings must be an array');

  const ids = new Set();
  const mappings = raw.mappings.map((entry, index) => {
    assert(entry && typeof entry === 'object', `mappings[${index}] must be an object`);
    assert(typeof entry.id === 'string' && entry.id, `mappings[${index}] has no id`);
    assert(!ids.has(entry.id), `duplicate mapping id ${entry.id}`);
    ids.add(entry.id);
    assert(typeof entry.semantic === 'string' && entry.semantic, `${entry.id} has no semantic key`);
    assert(entry.layer == null || LAYERS.includes(entry.layer), `${entry.id} has invalid layer ${entry.layer}`);
    assert(entry.mandatory == null || typeof entry.mandatory === 'boolean', `${entry.id}.mandatory must be boolean`);
    assert(entry.variants == null || Array.isArray(entry.variants), `${entry.id}.variants must be an array`);
    const variants = (entry.variants ?? []).map(normaliseVariant);
    for (const variant of variants) {
      assert(typeof variant.tile === 'string' && variant.tile, `${entry.id} has a variant without a tile`);
      assert(Number.isFinite(variant.weight) && variant.weight > 0, `${entry.id}/${variant.tile} has invalid weight`);
      const orientations = normaliseOrientations(variant.orientation);
      assert(orientations.every((orientation) => canonicalOrientation(orientation)), `${entry.id}/${variant.tile} has invalid orientation`);
    }
    const mappingOrientations = normaliseOrientations(entry.when?.orientation);
    assert(mappingOrientations.every((orientation) => canonicalOrientation(orientation)), `${entry.id} has invalid orientation requirement`);
    const chance = entry.chance ?? 1;
    assert(Number.isFinite(chance) && chance >= 0 && chance <= 1, `${entry.id} chance must be in [0,1]`);
    return { priority: 0, when: {}, exclusions: [], mandatory: false, ...entry, chance, variants };
  });

  const byId = new Map(mappings.map((entry) => [entry.id, entry]));
  for (const entry of mappings) {
    if (!entry.fallback) continue;
    const fallback = byId.get(entry.fallback);
    assert(fallback, `${entry.id} refers to missing fallback ${entry.fallback}`);
    assert(fallback.semantic === entry.semantic, `${entry.id} fallback ${fallback.id} changes semantic key`);
    resolveFallback({ byId }, entry);
  }

  cached = { file, schemaVersion: raw.schemaVersion, metadata: raw.metadata ?? {}, mappings, byId };
  return cached;
}

function conditionMatches(expected, actual) {
  if (expected === '*') return actual !== undefined && actual !== null;
  if (Array.isArray(expected)) return expected.includes(actual);
  return expected === actual;
}

function matches(entry, semantic, context) {
  if (entry.semantic !== semantic) return false;
  return Object.entries(entry.when).every(([key, expected]) => conditionMatches(expected, context[key]));
}

/**
 * Resolve a semantic class plus directional/topological/procedural context.
 * The most constrained matching rule wins; priority breaks equal-specificity ties.
 */
export function resolveSemantic(registry, semantic, context = {}) {
  const candidates = registry.mappings.filter((entry) => matches(entry, semantic, context));
  candidates.sort((a, b) =>
    b.priority - a.priority ||
    Object.keys(b.when).length - Object.keys(a.when).length ||
    a.id.localeCompare(b.id),
  );
  const selected = candidates[0] ?? null;
  if (!selected) return null;
  if (selected.variants.length || !selected.fallback) return selected;
  return resolveFallback(registry, selected);
}

function resolveFallback(registry, entry, seen = new Set()) {
  assert(!seen.has(entry.id), `fallback cycle at ${entry.id}`);
  seen.add(entry.id);
  if (!entry.fallback || entry.variants.length) return entry;
  return resolveFallback(registry, registry.byId.get(entry.fallback), seen);
}

function resolveAvailableFallback(registry, entry, compatibility, seen = new Set()) {
  assert(!seen.has(entry.id), `fallback cycle at ${entry.id}`);
  seen.add(entry.id);
  const variants = entry.variants.filter((variant) => compatibility.has(variant.tile));
  if (variants.length) return variants.length === entry.variants.length ? entry : { ...entry, variants };
  if (!entry.fallback) return { ...entry, variants: [] };
  return resolveAvailableFallback(registry, registry.byId.get(entry.fallback), compatibility, seen);
}

/**
 * Resolve a mapping and discard unavailable variants. If none remain, follow the
 * declared fallback chain. Filtering preserves order and weights, so selection stays
 * deterministic for a given installation and placement key.
 */
export function resolveCompatibleSemantic(registry, semantic, context, compatibility) {
  const selected = resolveSemantic(registry, semantic, context);
  if (!selected) return null;
  return resolveAvailableFallback(registry, selected, compatibility);
}

/**
 * Return an installation-specific registry whose variant pools contain only available
 * assets. Existing planners can use this exactly like the source registry; empty rules
 * still follow their declared fallback through `resolveSemantic`. The source registry is
 * never mutated, and filtering preserves variant order and weights.
 */
export function compatibleSemanticRegistry(registry, compatibility) {
  const mappings = registry.mappings.map((mapping) => ({
    ...mapping,
    variants: mapping.variants.filter((variant) => compatibility.has(variant.tile)),
  }));
  return { ...registry, mappings, byId: new Map(mappings.map((mapping) => [mapping.id, mapping])) };
}

/** Deterministically choose a weighted variant, including an optional placement chance. */
export function selectSemanticVariant(mapping, key) {
  if (!mapping?.variants.length) return null;
  const chanceRoll = hashString(`semantic-chance:${mapping.id}:${key}`) / 0x100000000;
  if (chanceRoll >= mapping.chance) return null;
  const total = mapping.variants.reduce((sum, variant) => sum + variant.weight, 0);
  let roll = hashString(`semantic-variant:${mapping.id}:${key}`) % total;
  for (const variant of mapping.variants) {
    if (roll < variant.weight) return variant.tile;
    roll -= variant.weight;
  }
  return mapping.variants.at(-1).tile;
}

export function variantsFor(registry, semantic, context = {}) {
  return resolveSemantic(registry, semantic, context)?.variants ?? [];
}

/**
 * Cross-check every registry variant against library/asset-inventory.json and,
 * when supplied, the installed tile catalogue. Context-required artwork is accepted
 * only from rules that explicitly preserve context.
 */
/**
 * Orientations that name the direction a feature *runs*, in the same vocabulary
 * the asset inventory uses. Facing vocabularies (`north`, `south-east`, `ne-sw`)
 * are deliberately excluded: a curb faces one way and runs the other, and the
 * two tables have never meant the same thing by them.
 */
const RUN_DIRECTIONS = new Set(['north-south', 'east-west']);

/** Below this the inventory's measurement is not strong enough to contradict a declaration. */
const ORIENTATION_CONFIDENCE = 0.8;

export function validateSemanticRegistry(registry, inventory, options = {}) {
  const compatibility = options.compatibility ?? createAssetCompatibility(inventory, options.installedCatalogue);
  const assets = compatibility.assets;
  const errors = [];
  const warnings = [];
  const referenced = new Set();

  for (const mapping of registry.mappings) {
    if (!mapping.variants.length && !mapping.fallback && !mapping.exclusions.length) {
      errors.push(`${mapping.id}: has no variants, fallback, or explicit exclusions`);
    }
    const requiredOrientations = normaliseOrientations(mapping.when.orientation);
    for (const variant of mapping.variants) {
      referenced.add(variant.tile);
      const asset = assets.get(variant.tile);
      if (!asset) {
        errors.push(`${mapping.id}: unknown tile ${variant.tile}`);
        continue;
      }
      if (!compatibility.has(variant.tile)) {
        warnings.push(`${mapping.id}/${variant.tile}: unavailable in installed tilesets and has no observed lotheader evidence`);
      }
      if (variant.family && asset.assetFamily !== variant.family) {
        errors.push(`${mapping.id}/${variant.tile}: family ${asset.assetFamily}, expected ${variant.family}`);
      }
      if (mapping.role && asset.role !== mapping.role) {
        errors.push(`${mapping.id}/${variant.tile}: role ${asset.role}, expected ${mapping.role}`);
      }
      if (mapping.layer) {
        const accepted = LAYER_SUITABILITY[mapping.layer];
        if (!asset.layerSuitability?.some((layer) => accepted.has(layer))) {
          errors.push(`${mapping.id}/${variant.tile}: unsuitable for ${mapping.layer} (${asset.layerSuitability?.join(', ') || 'none'})`);
        }
      }
      if (requiredOrientations.length) {
        const declared = normaliseOrientations(variant.orientation);
        if (!declared.length) {
          errors.push(`${mapping.id}/${variant.tile}: directional mapping requires variant.orientation (${requiredOrientations.join(', ')})`);
        } else if (!requiredOrientations.every((orientation) => declared.includes(orientation))) {
          errors.push(`${mapping.id}/${variant.tile}: orientation ${declared.join(', ')} does not satisfy ${requiredOrientations.join(', ')}`);
        }
        // A declaration is a claim about the sprite, and the inventory measured
        // the same thing from tens of thousands of vanilla placements. Where both
        // speak the run-direction vocabulary they have to agree: `road.marking.ew`
        // once declared east-west over a tile measured north-south at 0.98
        // confidence, and every east-west street in the world got the wrong line.
        if (RUN_DIRECTIONS.has(declared[0]) && RUN_DIRECTIONS.has(asset.orientation) &&
          declared[0] !== asset.orientation &&
          (asset.evidence?.orientationConfidence ?? 0) >= ORIENTATION_CONFIDENCE) {
          errors.push(
            `${mapping.id}/${variant.tile}: declared ${declared[0]} but the inventory measured ` +
            `${asset.orientation} on ${asset.observed?.contextualPlacements ?? 0} placements ` +
            `at ${(asset.evidence.orientationConfidence).toFixed(2)} confidence`,
          );
        }
      }
      if (['incompatible', 'excluded'].includes(asset.safetyStatus)) {
        errors.push(`${mapping.id}/${variant.tile}: asset safety is ${asset.safetyStatus}`);
      } else if (asset.safetyStatus === 'unknown') {
        warnings.push(`${mapping.id}/${variant.tile}: asset safety is unknown`);
      } else if (asset.safetyStatus === 'context-required' && !mapping.contextRequired) {
        errors.push(`${mapping.id}/${variant.tile}: context-required asset used without contextRequired=true`);
      }
      if (['incompatible', 'intentionally-excluded'].includes(asset.supportStatus)) {
        errors.push(`${mapping.id}/${variant.tile}: asset support is ${asset.supportStatus}`);
      }
    }

    if (mapping.mandatory) {
      const resolved = resolveAvailableFallback(registry, mapping, compatibility);
      if (!resolved.variants.length) {
        const chain = [];
        let current = mapping;
        const seen = new Set();
        while (current && !seen.has(current.id)) {
          seen.add(current.id);
          chain.push(current.id);
          current = current.fallback ? registry.byId.get(current.fallback) : null;
        }
        errors.push(`${mapping.id}: mandatory mapping has no available variants${chain.length > 1 ? ` (fallback chain: ${chain.join(' -> ')})` : ''}`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings, referencedAssets: referenced.size };
}

export function assertValidSemanticRegistry(registry, inventory, options = {}) {
  const result = validateSemanticRegistry(registry, inventory, options);
  if (!result.valid) throw new Error(`semantic mapping registry validation failed:\n- ${result.errors.join('\n- ')}`);
  return result;
}
