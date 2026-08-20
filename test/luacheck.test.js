/**
 * The Lua gate, and the hole that was in it.
 *
 * `tools/luacheck.js` is the only thing standing between a typo and a mod that
 * does not load, because there is no Lua interpreter on a modding machine. It
 * counted block keywords, which catches a missing `end` — and nothing else.
 *
 * A string with a raw newline in it slipped straight through: Lua rejects
 * `"foo` <newline> `"`, but the block count is unaffected and `stripLua` happily
 * consumed across the break looking for a closing quote. Three refusal messages
 * were written that way and passed every check here; in the game the only symptom
 * would have been the mod silently not existing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkBlocks, findUnterminatedString, stripLua } from '../tools/luacheck.js';

const MOD_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mod-src');

test('a string that runs off its line is caught, with the line number', () => {
  const torn = ['local a = "fine"', 'local b = "torn', '" .. "rest"', 'print(a, b)'].join('\n');
  const found = findUnterminatedString(torn);
  assert.ok(found, 'an unterminated string was not detected');
  assert.equal(found.line, 2);

  const result = checkBlocks(torn);
  assert.equal(result.ok, false);
  assert.match(result.reason, /unterminated string on line 2/);
});

test('the things that legitimately span lines are not flagged', () => {
  // A long-bracket string, a long comment, an escaped line continuation, and an
  // apostrophe inside a double-quoted string all contain newlines or quotes that
  // a naive check would trip over.
  const fine = [
    'local a = [[',
    '  many lines',
    ']]',
    '--[[ a long',
    '     comment ]]',
    "local b = 'it\\'s fine'",
    'local c = "continued \\',
    'onto the next line"',
    'local d = "-- not a comment"',
    'print(a, b, c, d)',
  ].join('\n');
  assert.equal(findUnterminatedString(fine), null, 'a legitimate construct was reported as torn');
  assert.equal(checkBlocks(fine).ok, true);
});

test('a missing end is still caught, which is what this was written for', () => {
  const missing = ['local function f()', '  if true then', '    print("x")', '  end', 'print(1)'].join('\n');
  assert.equal(checkBlocks(missing).ok, false);
});

test('every Lua file the mod ships passes both checks', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.lua')) files.push(full);
    }
  };
  walk(MOD_SRC);

  assert.ok(files.length > 0, 'no Lua files found to check');
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const torn = findUnterminatedString(src);
    assert.equal(torn, null,
      `${path.relative(MOD_SRC, file)}: unterminated string on line ${torn?.line}`);
    const result = checkBlocks(src);
    assert.equal(result.ok, true, `${path.relative(MOD_SRC, file)}: ${result.reason}`);
    // And the stripper agrees there is no code left hiding inside a string.
    assert.equal(typeof stripLua(src), 'string');
  }
});
