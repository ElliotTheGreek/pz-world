import fs from 'node:fs';
import path from 'node:path';
import { findInstall, findUserFolder, readVersion } from '../src/lib/pzinstall.js';

const install = findInstall();
const user = findUserFolder();
const lua = path.join(user, 'Lua');
const names = [
  'pzworld_build.txt',
  'pzworld_progress.txt',
  'pzworld_settings.txt',
  'pzworld_request.txt',
  'pzworld_status.txt',
  'pzworld_data.txt',
];
const bridge = {};
for (const name of names) {
  const file = path.join(lua, name);
  bridge[name] = fs.existsSync(file)
    ? {
        mtime: fs.statSync(file).mtime.toISOString(),
        size: fs.statSync(file).size,
        body: fs.readFileSync(file, 'utf8').slice(0, 4000),
      }
    : null;
}
const consoleFile = path.join(user, 'console.txt');
console.log(JSON.stringify({
  install,
  user,
  version: readVersion(install),
  bridge,
  saveTypes: fs.existsSync(path.join(user, 'Saves')) ? fs.readdirSync(path.join(user, 'Saves')) : [],
  console: fs.existsSync(consoleFile)
    ? { mtime: fs.statSync(consoleFile).mtime.toISOString(), size: fs.statSync(consoleFile).size }
    : null,
}, null, 2));
