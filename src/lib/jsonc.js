/**
 * JSON with comments.
 *
 * The class tables in `config/` are the part of this project a user is most
 * likely to edit — which road becomes which tile, which OSM tag becomes which
 * building type — and a table you cannot annotate is a table nobody trusts.
 * Plain JSON forbids comments and a YAML parser is a dependency and a footgun,
 * so this strips `//` and block comments and hands the rest to JSON.parse.
 */

import fs from 'node:fs';

/**
 * Strip comments without touching anything inside a string literal. Tracking
 * the string state is the whole trick: a `//` inside a URL or a regex-looking
 * value must survive.
 */
export function stripComments(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

export function parseJsonc(text, label = '<jsonc>') {
  try {
    return JSON.parse(stripComments(text));
  } catch (err) {
    throw new Error(`${label}: ${err.message}`);
  }
}

export function readJsonc(file) {
  return parseJsonc(fs.readFileSync(file, 'utf8'), file);
}
