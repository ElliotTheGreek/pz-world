/**
 * Locating the player's Project Zomboid install and user folder.
 *
 * Everything that reads vanilla data — the prefab extractor, the tile-name
 * validator — goes through here, so there is exactly one place that knows
 * where the game lives and exactly one error message when it doesn't.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APP_ID = '108600';

/** Steam's default install roots, in the order worth trying. */
function defaultSteamRoots() {
  const roots = [];
  if (process.platform === 'win32') {
    for (const base of ['C:/Program Files (x86)/Steam', 'C:/Program Files/Steam']) roots.push(base);
    for (const drive of ['C', 'D', 'E', 'F']) roots.push(`${drive}:/SteamLibrary`);
  } else if (process.platform === 'darwin') {
    roots.push(path.join(os.homedir(), 'Library/Application Support/Steam'));
  } else {
    roots.push(path.join(os.homedir(), '.steam/steam'));
    roots.push(path.join(os.homedir(), '.local/share/Steam'));
  }
  return roots;
}

/**
 * Steam records extra library folders in `libraryfolders.vdf`. Parsing it is
 * what makes a D:\SteamLibrary install discoverable without the user telling
 * us. The file is Valve's KeyValues format; we only need the `path` entries,
 * so a line scan beats a real parser here.
 */
function libraryFoldersFrom(steamRoot) {
  const vdf = path.join(steamRoot, 'steamapps/libraryfolders.vdf');
  if (!fs.existsSync(vdf)) return [];
  const text = fs.readFileSync(vdf, 'utf8');
  const out = [];
  for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) {
    out.push(m[1].replace(/\\\\/g, '/').replace(/\\/g, '/'));
  }
  return out;
}

/**
 * @param {string} [hint] explicit install path from `--install`
 * @returns {string} absolute path to the ProjectZomboid directory
 */
export function findInstall(hint) {
  const candidates = [];
  if (hint) candidates.push(hint);
  if (process.env.PZ_INSTALL) candidates.push(process.env.PZ_INSTALL);

  const roots = new Set(defaultSteamRoots());
  for (const r of [...roots]) for (const lib of libraryFoldersFrom(r)) roots.add(lib);
  for (const r of roots) candidates.push(path.join(r, 'steamapps/common/ProjectZomboid'));

  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'media/maps'))) return path.resolve(c);
  }

  throw new Error(
    'Could not find Project Zomboid. Pass --install "<path to ProjectZomboid>" ' +
      'or set PZ_INSTALL. Looked in:\n  ' +
      candidates.filter(Boolean).join('\n  '),
  );
}

/** The `Zomboid` user folder, where mods are installed. */
export function findUserFolder(hint) {
  const candidates = [hint, process.env.PZ_USER];
  if (process.platform === 'win32') {
    candidates.push(path.join(os.homedir(), 'Zomboid'));
    candidates.push(path.join(process.env.USERPROFILE ?? '', 'Zomboid'));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Zomboid'));
  } else {
    candidates.push(path.join(os.homedir(), 'Zomboid'));
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return path.resolve(c);
  }
  throw new Error('Could not find the Zomboid user folder. Pass --user "<path>".');
}

/** Version string from the install, e.g. "42.20.2". */
export function readVersion(install) {
  // The user folder carries version.txt; the install itself does not.
  try {
    const user = findUserFolder();
    const txt = fs.readFileSync(path.join(user, 'version.txt'), 'utf8');
    return txt.trim().split(/\s+/)[0];
  } catch {
    return 'unknown';
  }
}

/** Absolute paths of every shipped map directory. */
export function listVanillaMaps(install) {
  const dir = path.join(install, 'media/maps');
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'challengemaps')
    .map((d) => path.join(dir, d.name));
}

/**
 * Every tile name the shipped maps actually reference.
 *
 * The tile definition files are not a complete register. `jumbo_tree_01_0`
 * appears in 1,804 of Muldraugh's 4,065 cells and is declared in no `.tiles`
 * or `.tiles.txt` at all — the game resolves it some other way. So a name
 * missing from the catalogue is not proof that it is invalid, and the shipped
 * map data is the second, independent source of truth: whatever Knox County
 * draws with is a real tile.
 *
 * Scanning every lotheader's tile table takes a second or so, so the result is
 * cached to disk and keyed by the install's version.
 *
 * @param {string} install
 * @param {string} [cacheDir]
 * @returns {Set<string>}
 */
export function readMapTileNames(install, cacheDir) {
  const version = readVersion(install);
  const cacheFile = cacheDir ? path.join(cacheDir, `vanilla-tiles-${version}.json`) : null;
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      return new Set(JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
    } catch {
      /* fall through and rebuild */
    }
  }

  const names = new Set();
  for (const dir of listVanillaMaps(install)) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/^\d+_\d+\.lotheader$/.test(f)) continue;
      const buf = fs.readFileSync(path.join(dir, f));
      if (buf.toString('ascii', 0, 4) !== 'LOTH') continue;
      const count = buf.readInt32LE(8);
      let off = 12;
      for (let i = 0; i < count; i++) {
        const end = buf.indexOf(0x0a, off);
        if (end < 0) break;
        names.add(buf.toString('ascii', off, end));
        off = end + 1;
      }
    }
  }

  if (cacheFile) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify([...names]));
    } catch {
      /* a cache we cannot write is not an error */
    }
  }
  return names;
}
