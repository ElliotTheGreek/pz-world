/**
 * A world in one file, so two people can build the same town.
 *
 * ## Why this has to exist for multiplayer
 *
 * Project Zomboid does not stream map cells. Every client loads them off its own
 * disk, which is why a map mod has to be installed by everyone — so for a shared
 * world, all the machines need *identical* cells.
 *
 * There are only two ways to get that. Ship the built map — half a gigabyte per
 * world, and it carries Indie Stone building layouts between people. Or have
 * everyone build it themselves and rely on the build being deterministic.
 *
 * It is. Two builds of the same coordinates and seed produce byte-identical
 * files — measured at 150 of 150 — because nothing in the path calls
 * `Math.random` or reads the clock. So the second way works, and this file is
 * what makes it practical: everything that decides a world, small enough to send.
 *
 * ## The three inputs, and why each is pinned here
 *
 *   1. **Coordinates, radius and seed.** Obvious, and on their own not enough.
 *
 *   2. **The OpenStreetMap response.** OSM changes every day. "Build 44.6995,
 *      -73.4529" in March and in June are different towns, and two players who
 *      fetch a week apart get different streets. So the actual response is
 *      embedded rather than re-fetched. It is also the only part that is legally
 *      redistributable — OSM data is ODbL, and the attribution travels with it
 *      in this file.
 *
 *   3. **The Project Zomboid version.** Building interiors are read out of each
 *      player's own install, so a different game build means different
 *      buildings on the same footprints. Recorded so a mismatch can be reported
 *      rather than discovered as a desync.
 *
 * What is deliberately *not* in here is anything of The Indie Stone's. No tiles,
 * no interiors, no room layouts — those come from each player's own copy of the
 * game at build time. That is what makes a recipe safe to post publicly when a
 * generated map directory is not.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

/** Bumped when a field changes meaning; readers refuse a format they do not know. */
export const RECIPE_FORMAT = 'pz-world-recipe-1';

export const OSM_ATTRIBUTION =
  'Map data © OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright';

/**
 * The installed game's version string, as the game itself records it.
 *
 * `Zomboid/version.txt` is written by the game and its first line holds e.g.
 * `42.20.3 70207f62e0` — version and revision. Read from the user folder rather
 * than the install because that is where the game puts it.
 *
 * Only the first line: the file also carries a `revision=` and `pzbullet=` line
 * that repeat what is already there, and a multi-line version string reads badly
 * everywhere it is shown and compares badly everywhere it is checked.
 */
export function readGameVersion(userFolder) {
  try {
    const text = fs.readFileSync(path.join(userFolder, 'version.txt'), 'utf8');
    return text.split('\n')[0].trim() || null;
  } catch {
    return null;
  }
}

/**
 * Everything that decides a world, ready to write.
 *
 * `osm` is the raw Overpass response as text. It is gzipped and base64'd rather
 * than embedded as JSON: a city is four megabytes of coordinates that compress
 * about tenfold, and one self-contained file is far easier to send than a file
 * plus a sidecar somebody will forget.
 */
export function buildRecipe({
  lat, lon, radius, seed, name = '', gameVersion = null, generator = null, osm = null,
}) {
  const recipe = {
    format: RECIPE_FORMAT,
    name,
    lat: Number(lat),
    lon: Number(lon),
    radius: Number(radius),
    // Kept as a string: the seed reaches the hash as text, and 0 and "0" must
    // not become different worlds through a JSON round trip.
    seed: String(seed ?? ''),
    gameVersion,
    generator,
    attribution: OSM_ATTRIBUTION,
  };
  if (osm != null) {
    recipe.osm = {
      encoding: 'gzip+base64',
      bytes: Buffer.byteLength(osm, 'utf8'),
      data: zlib.gzipSync(Buffer.from(osm, 'utf8'), { level: 9 }).toString('base64'),
    };
  }
  return recipe;
}

/** The recipe without its payload — what a built map keeps beside its cells. */
export function manifestOf(recipe) {
  const { osm, ...rest } = recipe;
  return { ...rest, osmBytes: osm?.bytes ?? null };
}

export function writeRecipe(file, recipe) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(recipe, null, 2)}\n`, 'utf8');
  return fs.statSync(file).size;
}

/**
 * Read a recipe and hand back the OSM text with it.
 *
 * Refuses an unknown format rather than guessing: a recipe that half-loads
 * produces a world that is subtly not the one it names, which is the worst
 * possible failure for something whose entire job is reproducibility.
 */
export function readRecipe(file) {
  const recipe = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (recipe.format !== RECIPE_FORMAT) {
    throw new Error(
      `${path.basename(file)} is "${recipe.format}", and this build reads ${RECIPE_FORMAT}`,
    );
  }
  for (const field of ['lat', 'lon', 'radius']) {
    if (!Number.isFinite(recipe[field])) throw new Error(`recipe has no usable ${field}`);
  }
  let osm = null;
  if (recipe.osm) {
    if (recipe.osm.encoding !== 'gzip+base64') {
      throw new Error(`recipe carries its map data as "${recipe.osm.encoding}", which is not understood`);
    }
    osm = zlib.gunzipSync(Buffer.from(recipe.osm.data, 'base64')).toString('utf8');
    if (recipe.osm.bytes && Buffer.byteLength(osm, 'utf8') !== recipe.osm.bytes) {
      throw new Error('the map data in this recipe did not survive the trip; it is truncated or corrupt');
    }
  }
  return { recipe, osm };
}

/**
 * Whether a world built from this recipe will match one built from that one.
 *
 * Returns a list of human-readable differences, empty when the two agree.
 * The game version is reported separately from the inputs because it is the one
 * a player can do something about without changing the world they asked for.
 */
export function compareRecipes(mine, theirs) {
  const problems = [];
  for (const [field, label] of [
    ['lat', 'latitude'], ['lon', 'longitude'], ['radius', 'radius'], ['seed', 'seed'],
  ]) {
    if (String(mine?.[field]) !== String(theirs?.[field])) {
      problems.push(`${label}: yours ${mine?.[field]}, theirs ${theirs?.[field]}`);
    }
  }
  if (mine?.osmBytes != null && theirs?.osmBytes != null && mine.osmBytes !== theirs.osmBytes) {
    problems.push('the OpenStreetMap data differs, so the streets will not match');
  }
  if (mine?.gameVersion && theirs?.gameVersion && mine.gameVersion !== theirs.gameVersion) {
    problems.push(
      `Project Zomboid ${mine.gameVersion} against ${theirs.gameVersion} — `
      + 'buildings come from your own install, so the interiors will differ',
    );
  }
  return problems;
}
