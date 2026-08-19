#!/usr/bin/env node
/**
 * pz-world — generate a Project Zomboid map from a real city.
 *
 *   pz-world extract                      harvest prefabs from your PZ install
 *   pz-world generate --lat .. --lon ..   build a map mod
 *   pz-world verify <mod>                 re-read a generated mod and check it
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findInstall, findUserFolder, readVersion } from './lib/pzinstall.js';
import { loadTileCatalogue } from './formats/tiledefs.js';
import { fetchArea, normalise, checkRadius } from './sources/osm.js';
import { bboxAround } from './geo/project.js';
import { buildPlan } from './plan/index.js';
import { Library } from './plan/buildings.js';
import { emitMod } from './emit/worldgen.js';
import { runExtract, DEFAULT_LIBRARY } from './extract/run.js';
import { verifyMod } from './verify.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const log = (m) => process.stdout.write(`${m}\n`);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        args[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
        else {
          args[a.slice(2)] = next;
          i++;
        }
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

const USAGE = `pz-world — real-city maps for Project Zomboid B42

  pz-world extract [--install <path>] [--out <dir>] [--maps "Muldraugh, KY"]
      Harvest building prototypes from your own Project Zomboid install.
      Runs locally; nothing it produces is redistributable.

  pz-world generate --lat <deg> --lon <deg> [options]
      --lat, --lon     centre of the map (required)
      --radius <m>     half-width of the area to take, default 1500
      --name <text>    map name, default "PZWorld"
      --seed <text>    world seed, default the name
      --out <dir>      output directory, default ./out/<name>
      --install <dir>  Project Zomboid install
      --library <dir>  prefab library, default ./library/extracted
      --bearing <deg>  override the world rotation the solver picks
      --refresh        re-query Overpass instead of using the cache
      --install-mod    also copy the result into your Zomboid/mods folder

  pz-world verify <mod-dir> [--install <path>]
      Re-read a generated mod with the same readers that wrote it.
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!cmd || cmd === 'help' || args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (cmd === 'extract') {
    await runExtract({
      install: args.install,
      out: args.out,
      maps: args.maps ? [args.maps] : undefined,
      log,
    });
    return 0;
  }

  if (cmd === 'verify') {
    const dir = args._[0] ?? args.mod;
    if (!dir) throw new Error('verify needs a mod directory');
    const result = verifyMod(dir, {
      install: args.install,
      cacheDir: path.join(ROOT, 'cache'),
      log,
    });
    if (result.problems.length) {
      log(`verification found ${result.problems.length} problem(s):`);
      for (const problem of result.problems) log(`  ${problem}`);
    } else {
      log('verification passed');
    }
    return result.problems.length ? 1 : 0;
  }

  if (cmd !== 'generate') {
    process.stdout.write(USAGE);
    throw new Error(`unknown command ${cmd}`);
  }

  // ---- generate ---------------------------------------------------------
  const lat = Number(args.lat);
  const lon = Number(args.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('generate needs --lat and --lon');
  }
  const radiusM = Number(args.radius ?? 1500);
  checkRadius(radiusM);

  const name = args.name ?? 'PZWorld';
  const seed = args.seed ?? name;
  const out = args.out ?? path.join(ROOT, 'out', name);
  const libraryDir = args.library ?? DEFAULT_LIBRARY;

  const install = findInstall(args.install);
  log(`Project Zomboid ${readVersion(install)}`);
  log(`generating "${name}" at ${lat}, ${lon} (radius ${radiusM} m, seed ${seed})`);

  const catalogue = loadTileCatalogue(install);
  const library = Library.open(libraryDir, { cat: catalogue, log });

  const bbox = bboxAround(lat, lon, radiusM);
  const raw = await fetchArea(bbox, { cacheDir: path.join(ROOT, 'cache'), refresh: !!args.refresh, log });
  const features = normalise(raw);
  log(
    `OpenStreetMap: ${features.buildings.length} buildings, ${features.roads.length} roads, ` +
      `${features.ground.length} land-cover polygons`,
  );
  if (!features.buildings.length && !features.roads.length) {
    throw new Error('nothing to build here — try a different centre or a larger radius');
  }

  const plan = buildPlan(features, {
    lat,
    lon,
    radiusM,
    bbox,
    seed,
    name,
    bearing: args.bearing !== undefined ? Number(args.bearing) : undefined,
    metresPerTile: Number(args.metresPerTile ?? 1),
    library,
    catalogue,
    log,
  });

  if (fs.existsSync(out)) fs.rmSync(out, { recursive: true, force: true });
  const emitted = emitMod(plan, { out, name, author: args.author, log });

  log('');
  log(`wrote ${emitted.modId} to ${out}`);
  log(`  ${emitted.prefabs} prefabs, ${emitted.modules} placements, ${emitted.cells} cells`);

  const r = plan.stats.residual;
  log(
    `  building snap residual: median ${r.median.toFixed(1)}°, ` +
      `90th ${r.p90.toFixed(1)}°, worst ${r.max.toFixed(1)}°`,
  );

  const missing = [...plan.stats.buildings.noPrototype].sort((a, b) => b[1] - a[1]);
  if (missing.length) {
    log(`  no prototype fitted: ${missing.map(([c, n]) => `${c}×${n}`).join(', ')}`);
  }

  const check = verifyMod(out, {
    install,
    cacheDir: path.join(ROOT, 'cache'),
    log: () => {},
  });
  if (check.problems.length) {
    log('');
    log(`verification found ${check.problems.length} problem(s):`);
    for (const p of check.problems.slice(0, 20)) log(`  ${p}`);
  } else {
    log('  verification passed');
  }

  if (args['install-mod']) {
    const user = findUserFolder(args.user);
    const dest = path.join(user, 'mods', emitted.modId);
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(out, dest, { recursive: true });
    log(`installed to ${dest}`);
  } else {
    log('');
    log(`To play: copy ${out} into your Zomboid/mods folder, or re-run with --install-mod.`);
  }

  return check.problems.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(`\nerror: ${err.message}\n`);
    if (process.env.PZ_WORLD_DEBUG) process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
