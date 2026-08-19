#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { findUserFolder } from '../src/lib/pzinstall.js';

const file = path.join(findUserFolder(), 'mods', 'default.txt');
const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const body = [
  'VERSION = 1,',
  '',
  'mods',
  '{',
  '    mod = pzworld,',
  '}',
  '',
  'maps',
  '{',
  '}',
  '',
].join('\r\n');
fs.writeFileSync(file, body, 'utf8');
console.log(JSON.stringify({ file, before, after: body }, null, 2));
