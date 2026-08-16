/**
 * From the round Earth to Project Zomboid's square grid.
 *
 * Terrula needed a planet-scale grid with millimetre-accurate cell squareness
 * everywhere (PREMISE.md §3.2), because it renders the whole globe. None of
 * that applies here. A Project Zomboid map is a single city, tens of kilometres
 * across at most, and it is *flat by construction* — the game has no terrain
 * height, only stacked storeys. So the right projection is the simplest one
 * that is accurate over a city: a local tangent plane through the chosen
 * centre.
 *
 * Error at 15 km from the origin is under a metre, which is under one square.
 * Nothing downstream can see it.
 */

/** Mean Earth radius, metres. */
const R = 6371008.8;

const DEG = Math.PI / 180;

export class Projection {
  /**
   * @param {{lat: number, lon: number, metresPerTile?: number, bearing?: number,
   *          originTileX?: number, originTileY?: number}} spec
   */
  constructor({ lat, lon, metresPerTile = 1, bearing = 0, originTileX = 0, originTileY = 0 }) {
    this.lat0 = lat;
    this.lon0 = lon;
    this.metresPerTile = metresPerTile;
    /**
     * World rotation, degrees clockwise. The orientation solver picks this so
     * the city's dominant street bearing lands on the grid axes — see
     * src/geo/orient.js and docs/ORIENTATION.md.
     */
    this.bearing = bearing;
    this.originTileX = originTileX;
    this.originTileY = originTileY;

    this.cosLat = Math.cos(lat * DEG);
    const b = bearing * DEG;
    this.cosB = Math.cos(b);
    this.sinB = Math.sin(b);
  }

  /**
   * Longitude/latitude to local metres, east and north of the origin, before
   * rotation.
   */
  toLocalMetres(lon, lat) {
    return [(lon - this.lon0) * DEG * R * this.cosLat, (lat - this.lat0) * DEG * R];
  }

  toLonLat(east, north) {
    return [this.lon0 + east / (DEG * R * this.cosLat), this.lat0 + north / (DEG * R)];
  }

  /**
   * Longitude/latitude to continuous tile coordinates.
   *
   * Two things happen here beyond the scale change:
   *
   *   * the world is rotated by `bearing`, so that a city whose streets run
   *     north-east/south-west can still be laid on an axis-aligned grid;
   *   * **north becomes −y**. Project Zomboid's y axis increases southward, and
   *     forgetting this mirrors the entire city, which looks plausible until
   *     you compare it with a map.
   */
  toTile(lon, lat) {
    const [e, n] = this.toLocalMetres(lon, lat);
    const rx = e * this.cosB + n * this.sinB;
    const ry = -e * this.sinB + n * this.cosB;
    return [this.originTileX + rx / this.metresPerTile, this.originTileY - ry / this.metresPerTile];
  }

  /** Rounded to whole squares. */
  toSquare(lon, lat) {
    const [x, y] = this.toTile(lon, lat);
    return [Math.round(x), Math.round(y)];
  }

  /** Inverse of {@link toTile}, for writing a world position back onto a map. */
  fromTile(x, y) {
    const rx = (x - this.originTileX) * this.metresPerTile;
    const ry = -(y - this.originTileY) * this.metresPerTile;
    const e = rx * this.cosB - ry * this.sinB;
    const n = rx * this.sinB + ry * this.cosB;
    return this.toLonLat(e, n);
  }

  /** A copy with a different rotation and origin, keeping the same centre. */
  with({ bearing = this.bearing, originTileX = this.originTileX, originTileY = this.originTileY }) {
    return new Projection({
      lat: this.lat0,
      lon: this.lon0,
      metresPerTile: this.metresPerTile,
      bearing,
      originTileX,
      originTileY,
    });
  }
}

/**
 * A square bounding box around a point, given a radius in metres. Overpass
 * wants (south, west, north, east).
 */
export function bboxAround(lat, lon, radiusM) {
  const dLat = (radiusM / R) / DEG;
  const dLon = (radiusM / (R * Math.cos(lat * DEG))) / DEG;
  return {
    south: lat - dLat,
    west: lon - dLon,
    north: lat + dLat,
    east: lon + dLon,
  };
}

/** Metres between two lon/lat points, good enough at city scale. */
export function distanceM(lon1, lat1, lon2, lat2) {
  const x = (lon2 - lon1) * DEG * R * Math.cos(((lat1 + lat2) / 2) * DEG);
  const y = (lat2 - lat1) * DEG * R;
  return Math.hypot(x, y);
}
