/**
 * Will Project Zomboid show our world in the picker?
 *
 * `WorldSelect:hasChoices()` returns `MapGroups.getNumberOfGroups() > 1`, so a
 * standalone world exists only if our map forms a group of its own. Answering
 * that by launching the game costs a full restart per attempt, so
 * tools/mapgroups.js reimplements `createGroups` on the filesystem and these
 * tests pin the behaviour that reimplementation depends on.
 *
 * Every rule asserted here was read out of the bytecode with tools/classdump.js:
 *
 *   MapGroups.getLotDirectories   null when map.info is absent
 *   MapGroups.handleMapDirectory  a null lot list DISCARDS the map
 *   MapGroups.getDirsRecursively  follows lots= by directory name, guarding cycles
 *   MapGroups.createGroups        share a directory -> share a group, else new group
 *   ChooseGameInfo$Mod.<init>     versionDir = <mod>/<getModVersionDirName()>
 *                                 commonDir  = <mod>/common
 *   ZomboidFileSystem.getModVersionDirName
 *                                 highest version dir with
 *                                 minRequiredVersion <= v <= gameVersion
 *   ChooseGameInfo.<clinit>       minRequiredVersion = GameVersion(42, 0) = 42000
 *   getGameVersionIntFromName     "42" -> 42000, "42.12" -> 42012
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGroups, getLotDirectories, readModInfo, isAvailable } from '../tools/mapgroups.js';
import { findInstall } from '../src/lib/pzinstall.js';

let INSTALL = null;
try {
  INSTALL = findInstall();
} catch {
  /* skipped below */
}
const skip = INSTALL ? false : 'Project Zomboid install not found';

/** Build a throwaway mod tree so the tests do not depend on what is installed. */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pzw-mapgroups-'));
  return {
    dir,
    /** @param {string} rel @param {string} body */
    write(rel, body) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body, 'utf8');
      return p;
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a map with no map.info is discarded entirely', () => {
  const s = scratch();
  try {
    fs.mkdirSync(path.join(s.dir, 'nothing'), { recursive: true });
    // handleMapDirectory returns early on null, so the map never registers.
    assert.equal(getLotDirectories(path.join(s.dir, 'nothing')), null);
  } finally {
    s.cleanup();
  }
});

test('lots= lines become the lot directory list', () => {
  const s = scratch();
  try {
    s.write('m/map.info', 'title=X\nlots=Muldraugh, KY\nfixed2x=true\n');
    assert.deepEqual(getLotDirectories(path.join(s.dir, 'm')), ['Muldraugh, KY']);

    s.write('n/map.info', 'title=Y\nfixed2x=true\n');
    // Present but empty — registers the map with no dependencies.
    assert.deepEqual(getLotDirectories(path.join(s.dir, 'n')), []);
  } finally {
    s.cleanup();
  }
});

test('a mod.info inside the version dir is found', () => {
  const s = scratch();
  try {
    s.write('mymod/42/mod.info', 'name=m\nid=m\nversionMin=42.0.0\n');
    const mod = readModInfo(path.join(s.dir, 'mymod'));
    assert.ok(mod, 'a 42-only mod must be readable');
    assert.equal(mod.id, 'm');
    assert.equal(path.basename(mod.versionDir), '42');
    assert.ok(isAvailable(mod, '42.20.2'), 'versionMin 42.0.0 must satisfy 42.20.2');
    // A mod demanding a newer build is unavailable, and an unavailable mod's
    // maps are never scanned even though its Lua still loads.
    assert.equal(isAvailable({ versionMin: '42.99.0' }, '42.20.2'), false);
  } finally {
    s.cleanup();
  }
});

test('a map declaring its own directory forms its own group', () => {
  const s = scratch();
  try {
    s.write('standalone/42/mod.info', 'name=s\nid=s\nversionMin=42.0.0\n');
    s.write('standalone/42/media/maps/MyWorld/map.info', 'title=MyWorld\nlots=MyWorld\n');

    s.write('addon/42/mod.info', 'name=a\nid=a\nversionMin=42.0.0\n');
    s.write('addon/42/media/maps/MyTown/map.info', 'title=MyTown\nlots=Muldraugh, KY\n');

    // A stand-in for the vanilla world, so the test does not need the install.
    s.write('base/42/mod.info', 'name=b\nid=b\nversionMin=42.0.0\n');
    s.write('base/42/media/maps/Muldraugh, KY/map.info', 'title=Muldraugh\n');

    const { groups } = createGroups({
      install: s.dir,
      modDirs: ['standalone', 'addon', 'base'].map((d) => path.join(s.dir, d)),
      gameVersion: '42.20.2',
      includeVanilla: false,
    });

    const named = groups.map((g) => g.map((d) => d.name).sort());
    assert.equal(groups.length, 2, `expected 2 groups, got ${JSON.stringify(named)}`);

    const own = named.find((g) => g.includes('MyWorld'));
    assert.deepEqual(own, ['MyWorld'], 'the standalone map must be alone in its group');

    const knox = named.find((g) => g.includes('Muldraugh, KY'));
    assert.ok(knox.includes('MyTown'), 'an add-on map must join the base world group');
  } finally {
    s.cleanup();
  }
});

test('a self-referencing lots= does not loop forever', () => {
  const s = scratch();
  try {
    s.write('a/42/mod.info', 'name=a\nid=a\n');
    s.write('a/42/media/maps/Loop/map.info', 'title=Loop\nlots=Loop\n');
    const { groups } = createGroups({
      install: s.dir,
      modDirs: [path.join(s.dir, 'a')],
      gameVersion: '42.20.2',
      includeVanilla: false,
    });
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].map((d) => d.name), ['Loop']);
  } finally {
    s.cleanup();
  }
});

/**
 * The real question, against the real install: does the mod as shipped produce
 * a second group? If this fails, the world picker cannot appear and there is no
 * point testing in-game.
 */
test('the installed pz-world mod forms its own world group', { skip }, () => {
  const modDir = path.join(os.homedir(), 'Zomboid', 'mods', 'pzworld');
  if (!fs.existsSync(modDir)) {
    assert.fail(`pz-world is not installed at ${modDir}`);
  }

  const { groups, realDirectories } = createGroups({
    install: INSTALL,
    modDirs: [modDir],
    gameVersion: '42.20.2',
  });

  const ours = realDirectories.find((d) => d.name === 'PZWorld');
  assert.ok(ours, 'PZWorld was not registered as a map directory at all');
  assert.deepEqual(ours.lotDirs, ['PZWorld'], 'PZWorld must declare its own directory');

  const ourGroup = groups.find((g) => g.some((d) => d.name === 'PZWorld'));
  assert.ok(ourGroup, 'PZWorld is in no group');
  assert.deepEqual(
    ourGroup.map((d) => d.name),
    ['PZWorld'],
    'PZWorld must be alone in its group, or it is part of Knox County',
  );

  assert.ok(
    groups.length > 1,
    `WorldSelect:hasChoices() needs more than one group, got ${groups.length}`,
  );
});
