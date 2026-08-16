#!/usr/bin/env node
/**
 * A block-structure sanity check for Lua.
 *
 * There is no Lua interpreter on this machine, and a syntax error in a mod
 * script means the whole file silently fails to load — which, when the file is
 * a one-shot diagnostic, wastes the only run you get. This does not parse Lua;
 * it strips comments and strings and checks that block openers and closers
 * balance, which catches the mistake that actually happens (a missing or extra
 * `end`).
 *
 * In Lua the block openers are `function`, `if`, `do` and `repeat`. `for` and
 * `while` are *not* counted, because each is terminated by the `do` that
 * follows it, and `elseif`/`else` continue a block rather than opening one.
 */

import fs from 'node:fs';

export function stripLua(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    // Long bracket comment or string: --[[ ... ]] / [[ ... ]]
    const long = /^(--)?\[(=*)\[/.exec(src.slice(i));
    if (long) {
      const close = `]${long[2]}]`;
      const end = src.indexOf(close, i + long[0].length);
      i = end < 0 ? src.length : end + close.length;
      out += ' ';
      continue;
    }
    if (src.startsWith('--', i)) {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    const q = src[i];
    if (q === '"' || q === "'") {
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      out += ' ';
      continue;
    }
    out += src[i++];
  }
  return out;
}

export function checkBlocks(src) {
  const code = stripLua(src);
  const tokens = code.match(/\b[a-zA-Z_]\w*\b/g) ?? [];
  let depth = 0;
  const opens = { function: 0, if: 0, do: 0, repeat: 0 };
  let ends = 0;
  let untils = 0;

  for (const t of tokens) {
    if (t === 'function' || t === 'if' || t === 'do' || t === 'repeat') {
      opens[t]++;
      depth++;
    } else if (t === 'end') {
      ends++;
      depth--;
    } else if (t === 'until') {
      untils++;
      depth--;
    }
    if (depth < 0) return { ok: false, reason: 'an `end` with no matching opener', depth, opens, ends };
  }

  const totalOpens = opens.function + opens.if + opens.do + opens.repeat;
  return {
    ok: depth === 0,
    depth,
    opens,
    ends,
    untils,
    totalOpens,
    reason: depth === 0 ? 'balanced' : `${depth} unclosed block(s)`,
  };
}

const file = process.argv[2];
if (file) {
  const r = checkBlocks(fs.readFileSync(file, 'utf8'));
  process.stdout.write(
    `${file}\n  openers ${JSON.stringify(r.opens)} = ${r.totalOpens}\n` +
      `  end=${r.ends} until=${r.untils}\n  ${r.ok ? 'OK: balanced' : `FAIL: ${r.reason}`}\n`,
  );
  process.exit(r.ok ? 0 : 1);
}
