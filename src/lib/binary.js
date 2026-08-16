/**
 * Little-endian binary cursors.
 *
 * Every Project Zomboid map file is little-endian with newline-terminated
 * strings, so the whole formats layer is built on these two.
 */

export class Reader {
  /** @param {Buffer} buf */
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.off = offset;
  }

  get remaining() {
    return this.buf.length - this.off;
  }

  get eof() {
    return this.off >= this.buf.length;
  }

  i32() {
    const v = this.buf.readInt32LE(this.off);
    this.off += 4;
    return v;
  }

  i64() {
    const v = this.buf.readBigInt64LE(this.off);
    this.off += 8;
    return Number(v);
  }

  u8() {
    return this.buf[this.off++];
  }

  ascii(n) {
    const s = this.buf.toString('ascii', this.off, this.off + n);
    this.off += n;
    return s;
  }

  bytes(n) {
    const b = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return b;
  }

  /**
   * A newline-terminated string. This is how PZ stores every name — tile
   * names in a lotheader, room names in a RoomDef. There is no length prefix,
   * so a name may not itself contain a newline.
   */
  line() {
    const end = this.buf.indexOf(0x0a, this.off);
    if (end < 0) throw new Error(`unterminated string at offset ${this.off}`);
    const s = this.buf.toString('ascii', this.off, end);
    this.off = end + 1;
    return s;
  }
}

export class Writer {
  constructor(initial = 1 << 16) {
    this.buf = Buffer.alloc(initial);
    this.off = 0;
  }

  #room(n) {
    if (this.off + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.off + n) size *= 2;
    const next = Buffer.alloc(size);
    this.buf.copy(next, 0, 0, this.off);
    this.buf = next;
  }

  i32(v) {
    this.#room(4);
    this.buf.writeInt32LE(v | 0, this.off);
    this.off += 4;
    return this;
  }

  i64(v) {
    this.#room(8);
    this.buf.writeBigInt64LE(BigInt(v), this.off);
    this.off += 8;
    return this;
  }

  u8(v) {
    this.#room(1);
    this.buf[this.off++] = v & 0xff;
    return this;
  }

  ascii(s) {
    const n = Buffer.byteLength(s, 'ascii');
    this.#room(n);
    this.buf.write(s, this.off, 'ascii');
    this.off += n;
    return this;
  }

  /** Write a name plus its terminating newline. */
  line(s) {
    if (s.includes('\n')) throw new Error(`name contains a newline: ${JSON.stringify(s)}`);
    return this.ascii(s).u8(0x0a);
  }

  bytes(b) {
    this.#room(b.length);
    Buffer.from(b).copy(this.buf, this.off);
    this.off += b.length;
    return this;
  }

  /** Reserve space and return the offset, for patching a value written later. */
  reserve(n) {
    this.#room(n);
    const at = this.off;
    this.buf.fill(0, this.off, this.off + n);
    this.off += n;
    return at;
  }

  patchI64(at, v) {
    this.buf.writeBigInt64LE(BigInt(v), at);
    return this;
  }

  done() {
    return Buffer.from(this.buf.subarray(0, this.off));
  }
}
