#!/usr/bin/env node
/**
 * The pz-world helper.
 *
 * Project Zomboid's Lua sandbox has no HTTP client and writes text only
 * (DEV_GUIDE.md §1.6), so the network half of the mod lives here. It watches
 * `Zomboid/Lua/pzworld_request.txt`, fetches OpenStreetMap, and writes back a
 * compact text payload the mod can parse without a JSON parser.
 *
 * It deliberately stops short of deciding the world. Bearing, snapping,
 * prototype choice and rasterisation happen in Lua, in front of the player.
 * See helper/protocol.md.
 *
 *   node helper/serve.js            watch forever
 *   node helper/serve.js --once     handle one request and exit
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { findUserFolder } from '../src/lib/pzinstall.js';
import { parseWorldMapXml, encodeWorldMapBin } from '../src/formats/worldmap.js';
import { MAP_NAME, MOD_ID, CANVAS_CELLS } from '../tools/make-canvas.js';

const BUILD = 'pzworld_build.txt';
const PROGRESS = 'pzworld_progress.txt';
const LOCK = 'pzworld_helper.lock';

/** getFileWriter/getFileReader resolve relative to Zomboid/Lua, not Zomboid. */
export function exchangeDir(userFolder = findUserFolder()) {
  const dir = path.join(userFolder, 'Lua');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readRequest(file) {
  const text = fs.readFileSync(file, 'utf8');
  // The mod terminates the file with `end`; without it the write is still in
  // flight and reading now would give a truncated request.
  if (!/^end\s*$/m.test(text)) return null;
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\w+)\s+(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function writeDirect(file, body) {
  try {
    fs.writeFileSync(file, body, 'utf8');
    return true;
  } catch (err) {
    // Losing one status update is not a reason to end a download.
    process.stderr.write(`  (could not write ${path.basename(file)}: ${err.code || err.message})\n`);
    return false;
  }
}

/**
 * Keep `worldmap.xml.bin` in step with the `worldmap.xml` beside it.
 *
 * The build writes both, and writes them so that compiling one gives exactly
 * the other (`assertXmlMatchesBin` in src/formats/worldmap.js proves it per
 * build). So in the normal case this is a no-op that rewrites identical bytes.
 *
 * It still earns its place: the `.xml` is the file the game finds by name at
 * mod-scan time, and if anything ever edits it, the `.bin` the game actually
 * draws from would otherwise silently disagree with it.
 *
 * Watched by modification time rather than driven by a message, because the
 * build is a separate process and there is no message to wait for.
 */
export function compileMapIfChanged(state, { log = () => {}, userFolder } = {}) {
  const xmlFile = path.join(
    findUserFolder(userFolder),
    'mods',
    MOD_ID,
    'common/media/maps',
    MAP_NAME,
    'worldmap.xml',
  );

  let stat;
  try {
    stat = fs.statSync(xmlFile);
  } catch {
    return false; // no map written yet
  }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  if (state.mapStamp === stamp) return false;

  // Claim it before the work, so a build still writing the file is retried
  // rather than compiled twice.
  state.mapStamp = stamp;

  const binFile = `${xmlFile}.bin`;
  try {
    const text = fs.readFileSync(xmlFile, 'utf8');
    if (!text.includes('</world>')) {
      // Still being written; forget the stamp so the next tick tries again.
      state.mapStamp = null;
      return false;
    }
    const doc = parseWorldMapXml(text, { width: CANVAS_CELLS, height: CANVAS_CELLS });
    doc.originX = 0;
    doc.originY = 0;
    doc.width = CANVAS_CELLS;
    doc.height = CANVAS_CELLS;

    const bytes = encodeWorldMapBin(doc);
    fs.writeFileSync(binFile, bytes);
    const features = doc.cells.reduce((n, c) => n + c.features.length, 0);
    log(`compiled the map: ${features} features in ${doc.cells.length} cells, ${(bytes.length / 1e6).toFixed(2)} MB`);
    return true;
  } catch (err) {
    // A map that will not compile must not leave a stale one behind claiming to
    // be this city.
    try {
      fs.rmSync(binFile, { force: true });
    } catch {
      /* nothing useful to do */
    }
    log(`could not compile the map: ${err.message}`);
    return false;
  }
}

/**
 * Report a build's progress back to the build screen.
 *
 * The mod reads this every frame while its modal is up, so it is written whole and small.
 * `end` terminates it for the same reason the mod terminates its own files that way: the
 * reader can be part-way through a write, and a truncated read must be recognisable.
 */
function writeProgress(dir, { stage = '', progress = 0, message = '', done = false, err = '' }) {
  const body = [
    `progress ${progress.toFixed(4)}`,
    `done ${done ? 1 : 0}`,
    `error ${err}`,
    `stage ${stage}`,
    `message ${message}`,
    'end',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(dir, PROGRESS), body, 'utf8');
}

/**
 * Run a build ordered from inside the game.
 *
 * This is the same build `npm run world` runs — the *only* build there is. It happens
 * while the player is still on the build screen at the main menu, which is the one window
 * in which it is safe: `MapFiles.load()` re-lists the map directory at world init so a
 * cell rewritten now is picked up, while `IsoLot.pool` keeps handles open once the world
 * starts streaming and on Windows rewriting an open file fails outright.
 *
 * ## Why a child process and not a function call
 *
 * The build is memory-hungry — a 2,500 m city is 33 million squares held at once — and
 * `npm run world` has always given it `--max-old-space-size=8192`. Calling it in-process
 * made the helper inherit whatever heap the helper was started with, and the first
 * in-game build died with `FATAL ERROR: Reached heap limit`, taking the helper with it
 * and leaving the player staring at a progress bar that would never move again.
 *
 * A child gets the flag whatever the helper was launched with, and a build that dies
 * kills only itself. The child writes the progress file directly, so a crash still
 * reports — the helper only ever sees an exit code.
 */
function handleBuildOrder(order, dir, { log }) {
  const script = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..', 'tools', 'build-world.js');
  const progressFile = path.join(dir, PROGRESS);
  log(`build ordered: ${order.name || 'unnamed'} at ${order.lat}, ${order.lon}, radius ${order.radius} m`);
  writeProgress(dir, { stage: 'fetching', progress: 0.01, message: 'Starting' });

  const args = [
    '--max-old-space-size=8192',
    script,
    '--lat', String(order.lat),
    '--lon', String(order.lon),
    '--radius', String(order.radius),
    '--progress', progressFile,
  ];
  if (order.name) args.push('--name', String(order.name));
  if (order.seed) args.push('--seed', String(order.seed));

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const relay = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) if (line.trim()) log(`  ${line}`);
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    child.on('error', (err) => {
      log(`could not start the build: ${err.message}`);
      writeProgress(dir, { stage: 'extras', done: true, message: 'Build failed', err: err.message });
      resolve(false);
    });
    child.on('exit', (code) => {
      if (code === 0) {
        log('build finished');
        resolve(true);
        return;
      }
      log(`build exited with code ${code}`);
      // The child writes its own failure when it can. If it was killed outright — out of
      // memory, or the user closed the window — nothing was written and the screen would
      // wait for ever, so say so here.
      let reported = false;
      try {
        reported = /^done 1/m.test(fs.readFileSync(progressFile, 'utf8'));
      } catch {
        /* no progress file at all */
      }
      if (!reported) {
        writeProgress(dir, {
          stage: 'extras',
          done: true,
          message: 'Build failed',
          err: `the build stopped with exit code ${code}`,
        });
      }
      resolve(false);
    });
  });
}

/**
 * Claim the exchange directory for this process.
 *
 * The lock records a pid, and startup checks whether that pid is still alive
 * rather than trusting the file: a helper killed with the window close button
 * never gets to clean up, and a stale lock that refuses every future run is
 * worse than no lock at all.
 *
 * @returns {(() => void)|null} a release function, or null if somebody else holds it
 */
function takeLock(dir, log) {
  const file = path.join(dir, LOCK);
  try {
    const held = Number(fs.readFileSync(file, 'utf8').trim());
    if (Number.isInteger(held) && held > 0 && held !== process.pid) {
      let alive = false;
      try {
        process.kill(held, 0);
        alive = true;
      } catch (err) {
        alive = err.code === 'EPERM'; // running, just not ours to signal
      }
      if (alive) {
        log(`another pz-world helper is already running (pid ${held}).`);
        log('  Close that one first — two helpers run two builds over the same files.');
        return null;
      }
      log(`clearing the lock left by pid ${held}, which is gone`);
    }
  } catch {
    /* no lock file, or an unreadable one: take it */
  }
  try {
    fs.writeFileSync(file, String(process.pid), 'utf8');
  } catch {
    return () => {}; // cannot lock; better to run than to refuse
  }
  return () => {
    try {
      if (Number(fs.readFileSync(file, 'utf8').trim()) === process.pid) fs.rmSync(file, { force: true });
    } catch {
      /* someone else's now, or already gone */
    }
  };
}

export async function serve({ once = false, log = () => {}, userFolder } = {}) {
  let releaseLock = null;
  const dir = exchangeDir(userFolder);
  const buildFile = path.join(dir, BUILD);

  // One helper, or none. A second instance is not a redundant spare: both see
  // the same build order, both spawn a build, and the two builds write the same
  // cells and the same map at the same time. Measured with four helpers up by
  // accident — three concurrent builds, 1.3 GB each, and a progress file being
  // rewritten by all of them, which reads from the game as a hang.
  releaseLock = takeLock(dir, log);
  if (!releaseLock) return null;
  const drop = () => { if (releaseLock) { releaseLock(); releaseLock = null; } };
  for (const signal of ['exit', 'SIGINT', 'SIGTERM']) process.once(signal, drop);

  log(`pz-world helper watching ${dir}`);
  log('  leave this running: it is what builds the world when you press "Build this world"');
  // Clear a stale order so an old one is not answered on startup.
  if (fs.existsSync(buildFile)) fs.writeFileSync(buildFile, '');

  const state = { mapStamp: null };
  let busy = false;
  const tick = async () => {
    if (busy) return;

    // A build order first: it is what the player is actually waiting on.
    if (fs.existsSync(buildFile)) {
      const order = readRequest(buildFile);
      if (order && Number.isFinite(Number(order.lat)) && Number.isFinite(Number(order.lon))) {
        busy = true;
        // Emptied rather than deleted, and emptied *before* the build: the mod's
        // `getFileReader` on a missing file is a different code path from an empty one,
        // and clearing first means a build that throws is not retried for ever.
        fs.writeFileSync(buildFile, '');
        try {
          await handleBuildOrder(order, dir, { log });
        } finally {
          busy = false;
          if (once) process.exit(0);
        }
        return;
      }
    }

    // No build running, so this is the moment to notice a finished map.
    try {
      compileMapIfChanged(state, { log, userFolder });
    } catch (err) {
      log(`map watcher: ${err.message}`);
    }
  };

  setInterval(tick, 400);
  await tick();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve({
    once: process.argv.includes('--once'),
    log: (m) => process.stdout.write(`${m}\n`),
  }).catch((err) => {
    process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
}
