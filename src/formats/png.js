/**
 * Minimal PNG codec, just enough for Project Zomboid biome maps.
 *
 * A biome map is a 256×256 8-bit **indexed** PNG (colour type 3), one pixel per
 * world square, and the pixel value selects a biome and a zone through
 * `media/lua/server/metazones/BiomeMapConfig.lua`. That is the whole reason
 * this file exists — we need to write indexed PNGs with an exact byte per
 * square, and no dependency is worth taking for that.
 *
 * Encoding writes a greyscale ramp palette, so entry *i* is rgb(i,i,i). That
 * makes the file readable as an image by a human and keeps the palette index
 * and the visible grey value identical, so it does not matter whether a
 * consumer reads the index or the red channel.
 */

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

/**
 * @param {{width: number, height: number, pixels: Uint8Array, palette?: Buffer}} img
 *   `pixels` is one byte per pixel, row-major.
 * @returns {Buffer}
 */
export function encodeIndexedPng({ width, height, pixels, palette }) {
  if (pixels.length !== width * height) {
    throw new Error(`pixels is ${pixels.length}, expected ${width * height}`);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // colour type: indexed
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  let plte = palette;
  if (!plte) {
    plte = Buffer.alloc(256 * 3);
    for (let i = 0; i < 256; i++) {
      plte[i * 3] = i;
      plte[i * 3 + 1] = i;
      plte[i * 3 + 2] = i;
    }
  }

  // Filter type 0 (None) on every scanline. The data is categorical — adjacent
  // biome ids have no numeric relationship — so a predictive filter would
  // enlarge it, not shrink it.
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * width, width).copy(
      raw,
      y * (width + 1) + 1,
    );
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Decode an 8-bit indexed or greyscale PNG. Used to read vanilla biome maps
 * when checking our own output against theirs.
 *
 * @returns {{width: number, height: number, bitDepth: number, colorType: number,
 *            pixels: Uint8Array, palette: Buffer|null}}
 */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');

  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette = null;
  const idat = [];

  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG is not supported');
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8 || (colorType !== 3 && colorType !== 0)) {
    throw new Error(`unsupported PNG: bitDepth ${bitDepth}, colorType ${colorType}`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(width * height);

  // One byte per pixel for both supported colour types, so the filter's
  // "previous byte" distance is 1.
  let prev = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (width + 1)];
    const row = raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1));
    const cur = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
      const a = x > 0 ? cur[x - 1] : 0;
      const b = prev[x];
      const c = x > 0 ? prev[x - 1] : 0;
      let v = row[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      cur[x] = v & 0xff;
    }
    pixels.set(cur, y * width);
    prev = cur;
  }

  return { width, height, bitDepth, colorType, pixels, palette };
}
