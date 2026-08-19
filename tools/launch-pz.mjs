#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findInstall } from '../src/lib/pzinstall.js';

const install = findInstall();
const candidates = fs.readdirSync(install)
  .filter((name) => /^ProjectZomboid.*\.(exe|bat)$/i.test(name))
  .sort();
console.log(`install: ${install}`);
console.log(`launchers: ${candidates.join(', ')}`);
const preferred = [
  'ProjectZomboid64.exe',
  'ProjectZomboid64.bat',
  'ProjectZomboid.exe',
  'ProjectZomboid32.exe',
].find((name) => candidates.includes(name));
if (!preferred) throw new Error('No Project Zomboid launcher found');
const executable = path.join(install, preferred);
const child = preferred.endsWith('.bat')
  ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', executable], {
      cwd: install,
      detached: true,
      stdio: 'ignore',
    })
  : spawn(executable, [], { cwd: install, detached: true, stdio: 'ignore' });
child.unref();
console.log(`launched ${preferred} as pid ${child.pid}`);
