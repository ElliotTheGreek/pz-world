/**
 * `streets.xml` — the street names on the in-game map.
 *
 * `MapUtils.initDirectoryStreetData` reads this for every directory
 * `getLotDirectories()` returns, so a generated map only has to put the file in its own
 * map folder. Three things about it decide how this is written:
 *
 * **It is XML, and only XML.** Unlike worldmap data, `WorldMapStreets.read`
 * unconditionally constructs the XML parser — there is no `Files.exists(path + ".bin")`
 * branch and no binary reader class anywhere in `zombie/worldMap/streets/`. So this is
 * the one map file that does not need the helper's byte-writing.
 *
 * **Coordinates are absolute world squares, as floats.** Muldraugh's span x 0-15900,
 * y 900-15503 across the whole map. This is a different space from `worldmap.xml`,
 * whose points are cell-local shorts, and the two must not share code.
 *
 * **The parser is strict and takes the whole map down with it.** A `version` other than
 * 1, any unrecognised child of `<streets>`, a blank name or an empty point list throws
 * `PZXmlParserException`, and nothing catches it below `getOrCreateData` — which turns
 * it into a `RuntimeException` on the map screen. One malformed street and there is no
 * map at all. So everything here is validated before it is written, and anything that
 * does not validate is dropped rather than emitted and hoped for.
 */

import fs from 'node:fs';

/**
 * A street polyline is cut at this many points.
 *
 * `WorldMapStreet.clipToObscuredCells` writes every point as two floats into
 * `IsoMetaGrid.clipperBuffer`, a fixed `ByteBuffer.allocateDirect(3072)` — 384 points.
 * Vanilla's longest street is 66. Inferred from the allocation rather than tested, so
 * the cut is well inside it.
 */
export const MAX_POINTS = 256;

/** Below this a name is not worth a label and the parser would reject an empty one. */
const MIN_POINTS = 2;

/** How wide the map draws a street, by class. */
export const MAP_WIDTH = {
  motorway: 12,
  trunk: 10,
  primary: 10,
  secondary: 8,
  tertiary: 6,
  residential: 6,
  service: 4,
  track: 3,
  footway: 3,
  cycleway: 3,
};

/** XML text escaping. Street names are OSM data and do contain `&` and apostrophes. */
export function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Turn named roads into street records.
 *
 * @param {{name?: string, cls?: string, points: number[][]}[]} roads  world squares
 * @returns {{name: string, width: number, points: number[][]}[]}
 */
export function toStreets(roads, { maxPoints = MAX_POINTS } = {}) {
  const out = [];
  for (const road of roads) {
    const name = (road.name ?? '').trim();
    if (!name) continue; // an unnamed way has no label to draw

    const width = MAP_WIDTH[road.cls] ?? 5;
    const points = road.points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (points.length < MIN_POINTS) continue;

    // Cut rather than drop, so a long avenue keeps its name along its whole length.
    for (let i = 0; i < points.length; i += maxPoints - 1) {
      const run = points.slice(i, i + maxPoints);
      if (run.length < MIN_POINTS) break;
      out.push({ name, width, points: run });
    }
  }
  return out;
}

/**
 * @param {{name: string, width: number, points: number[][]}[]} streets
 * @returns {string}
 */
export function encodeStreetsXml(streets) {
  const lines = ['<streets version="1">'];
  let written = 0;

  for (const street of streets) {
    // Re-check rather than trust the caller: the cost of a bad record is the whole
    // map screen, and this is the last place that can stop one.
    const name = (street.name ?? '').trim();
    if (!name) continue;
    const points = (street.points ?? []).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (points.length < MIN_POINTS || points.length > MAX_POINTS) continue;
    const width = Number.isFinite(street.width) ? Math.max(1, Math.round(street.width)) : 5;

    lines.push(`    <street name="${escapeXml(name)}" width="${width}">`);
    lines.push('        <points>');
    for (const [x, y] of points) {
      lines.push(`            <point x="${x.toFixed(1)}" y="${y.toFixed(1)}"/>`);
    }
    lines.push('        </points>');
    lines.push('    </street>');
    written++;
  }

  lines.push('</streets>');
  lines.push('');
  return { xml: lines.join('\n'), written };
}

export function writeStreets(file, roads, opts = {}) {
  const streets = toStreets(roads, opts);
  const { xml, written } = encodeStreetsXml(streets);
  fs.writeFileSync(file, xml, 'utf8');
  return { written, bytes: xml.length, named: new Set(streets.map((s) => s.name)).size };
}
