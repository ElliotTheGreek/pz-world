#!/usr/bin/env node
/**
 * A minimal Java class-file reader and bytecode tracer.
 *
 * Exists because the answers to "how does Project Zomboid decide what a map is"
 * are in compiled methods, there is no JDK or decompiler on this machine, and
 * guessing from field names has already cost two failed tests. Reading the
 * bytecode is slower than guessing and it is correct.
 *
 * It does not decompile. It resolves the constant pool and prints, in order,
 * every method call, field access and string constant a method executes, plus
 * the branch structure — which is enough to follow the logic.
 *
 *   node tools/classdump.js <file.class>                  list methods
 *   node tools/classdump.js <file.class> <methodName>     trace one method
 */

import fs from 'node:fs';

const TAG = {
  UTF8: 1, INT: 3, FLOAT: 4, LONG: 5, DOUBLE: 6, CLASS: 7, STRING: 8,
  FIELDREF: 9, METHODREF: 10, IFACEREF: 11, NAMETYPE: 12, MHANDLE: 15,
  MTYPE: 16, DYNAMIC: 17, INVOKEDYN: 18, MODULE: 19, PACKAGE: 20,
};

class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  u1() { return this.b[this.o++]; }
  u2() { const v = this.b.readUInt16BE(this.o); this.o += 2; return v; }
  u4() { const v = this.b.readUInt32BE(this.o); this.o += 4; return v; }
  bytes(n) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
}

export function parseClass(buf) {
  const r = new Reader(buf);
  if (r.u4() !== 0xcafebabe) throw new Error('not a class file');
  r.u2(); r.u2(); // minor, major

  const count = r.u2();
  const pool = new Array(count);
  for (let i = 1; i < count; i++) {
    const tag = r.u1();
    switch (tag) {
      case TAG.UTF8: pool[i] = { tag, value: r.bytes(r.u2()).toString('utf8') }; break;
      case TAG.INT: case TAG.FLOAT: pool[i] = { tag, value: r.u4() }; break;
      case TAG.LONG: case TAG.DOUBLE:
        pool[i] = { tag, hi: r.u4(), lo: r.u4() }; i++; break; // takes two slots
      case TAG.CLASS: case TAG.STRING: case TAG.MTYPE: case TAG.MODULE: case TAG.PACKAGE:
        pool[i] = { tag, index: r.u2() }; break;
      case TAG.FIELDREF: case TAG.METHODREF: case TAG.IFACEREF:
      case TAG.NAMETYPE: case TAG.DYNAMIC: case TAG.INVOKEDYN:
        pool[i] = { tag, a: r.u2(), b: r.u2() }; break;
      case TAG.MHANDLE: pool[i] = { tag, kind: r.u1(), index: r.u2() }; break;
      default: throw new Error(`unknown constant tag ${tag} at ${i}`);
    }
  }

  const utf8 = (i) => pool[i]?.value ?? `#${i}`;
  const className = (i) => utf8(pool[i]?.index).replace(/\//g, '.');
  const resolve = (i) => {
    const e = pool[i];
    if (!e) return `#${i}`;
    switch (e.tag) {
      case TAG.UTF8: return e.value;
      case TAG.STRING: return JSON.stringify(utf8(e.index));
      case TAG.CLASS: return className(i);
      case TAG.INT: case TAG.FLOAT: return String(e.value);
      case TAG.NAMETYPE: return `${utf8(e.a)}${utf8(e.b)}`;
      case TAG.FIELDREF: case TAG.METHODREF: case TAG.IFACEREF: {
        const owner = className(e.a);
        const nt = pool[e.b];
        return `${owner}.${utf8(nt.a)}${utf8(nt.b)}`;
      }
      case TAG.INVOKEDYN: case TAG.DYNAMIC: {
        const nt = pool[e.b];
        return `dynamic ${utf8(nt.a)}${utf8(nt.b)}`;
      }
      default: return `<tag${e.tag}>`;
    }
  };

  r.u2(); // access
  const thisClass = className(r.u2());
  r.u2(); // super
  const ifaceCount = r.u2();
  for (let i = 0; i < ifaceCount; i++) r.u2();

  const readAttrs = () => {
    const n = r.u2();
    const out = [];
    for (let i = 0; i < n; i++) {
      const name = utf8(r.u2());
      const len = r.u4();
      out.push({ name, data: r.bytes(len) });
    }
    return out;
  };

  const fieldCount = r.u2();
  for (let i = 0; i < fieldCount; i++) { r.u2(); r.u2(); r.u2(); readAttrs(); }

  const methodCount = r.u2();
  const methods = [];
  for (let i = 0; i < methodCount; i++) {
    r.u2();
    const name = utf8(r.u2());
    const desc = utf8(r.u2());
    const attrs = readAttrs();
    const code = attrs.find((a) => a.name === 'Code');
    methods.push({ name, desc, code: code?.data ?? null });
  }

  return { thisClass, pool, resolve, utf8, methods };
}

/** Operand widths for the opcodes that appear in ordinary compiled code. */
const OPS = {
  0x10: ['bipush', 1], 0x11: ['sipush', 2],
  0x12: ['ldc', 1, 'cp'], 0x13: ['ldc_w', 2, 'cp'], 0x14: ['ldc2_w', 2, 'cp'],
  0x15: ['iload', 1], 0x16: ['lload', 1], 0x17: ['fload', 1], 0x18: ['dload', 1], 0x19: ['aload', 1],
  0x36: ['istore', 1], 0x37: ['lstore', 1], 0x38: ['fstore', 1], 0x39: ['dstore', 1], 0x3a: ['astore', 1],
  0x84: ['iinc', 2],
  0x99: ['ifeq', 2, 'br'], 0x9a: ['ifne', 2, 'br'], 0x9b: ['iflt', 2, 'br'],
  0x9c: ['ifge', 2, 'br'], 0x9d: ['ifgt', 2, 'br'], 0x9e: ['ifle', 2, 'br'],
  0x9f: ['if_icmpeq', 2, 'br'], 0xa0: ['if_icmpne', 2, 'br'], 0xa1: ['if_icmplt', 2, 'br'],
  0xa2: ['if_icmpge', 2, 'br'], 0xa3: ['if_icmpgt', 2, 'br'], 0xa4: ['if_icmple', 2, 'br'],
  0xa5: ['if_acmpeq', 2, 'br'], 0xa6: ['if_acmpne', 2, 'br'],
  0xa7: ['goto', 2, 'br'], 0xa8: ['jsr', 2, 'br'],
  0xb2: ['getstatic', 2, 'cp'], 0xb3: ['putstatic', 2, 'cp'],
  0xb4: ['getfield', 2, 'cp'], 0xb5: ['putfield', 2, 'cp'],
  0xb6: ['invokevirtual', 2, 'cp'], 0xb7: ['invokespecial', 2, 'cp'],
  0xb8: ['invokestatic', 2, 'cp'], 0xb9: ['invokeinterface', 4, 'cp'],
  0xba: ['invokedynamic', 4, 'cp'],
  0xbb: ['new', 2, 'cp'], 0xbc: ['newarray', 1], 0xbd: ['anewarray', 2, 'cp'],
  0xc0: ['checkcast', 2, 'cp'], 0xc1: ['instanceof', 2, 'cp'],
  0xc6: ['ifnull', 2, 'br'], 0xc7: ['ifnonnull', 2, 'br'],
  0xc5: ['multianewarray', 3],
};

const SIMPLE = {
  0x00: 'nop', 0x01: 'aconst_null', 0x02: 'iconst_m1', 0x03: 'iconst_0', 0x04: 'iconst_1',
  0x05: 'iconst_2', 0x06: 'iconst_3', 0x07: 'iconst_4', 0x08: 'iconst_5',
  0x09: 'lconst_0', 0x0a: 'lconst_1', 0x0b: 'fconst_0', 0x0e: 'dconst_0', 0x0f: 'dconst_1',
  0x1a: 'iload_0', 0x1b: 'iload_1', 0x1c: 'iload_2', 0x1d: 'iload_3',
  0x2a: 'aload_0', 0x2b: 'aload_1', 0x2c: 'aload_2', 0x2d: 'aload_3',
  0x3b: 'istore_0', 0x3c: 'istore_1', 0x3d: 'istore_2', 0x3e: 'istore_3',
  0x4b: 'astore_0', 0x4c: 'astore_1', 0x4d: 'astore_2', 0x4e: 'astore_3',
  0x57: 'pop', 0x59: 'dup', 0x5a: 'dup_x1',
  0x60: 'iadd', 0x64: 'isub', 0x68: 'imul',
  0xac: 'ireturn', 0xb0: 'areturn', 0xb1: 'return',
  0xbe: 'arraylength', 0xbf: 'athrow',
  0x32: 'aaload', 0x53: 'aastore', 0x2e: 'iaload', 0x4f: 'iastore',
};

export function trace(cls, methodName) {
  const out = [];
  for (const m of cls.methods) {
    if (m.name !== methodName || !m.code) continue;
    const r = new Reader(m.code);
    r.u2(); r.u2();                 // max_stack, max_locals
    const len = r.u4();
    const code = r.bytes(len);

    out.push(`### ${cls.thisClass}.${m.name}${m.desc}`);
    let i = 0;
    while (i < code.length) {
      const pc = i;
      const op = code[i++];
      if (SIMPLE[op]) { out.push(`  ${pc}: ${SIMPLE[op]}`); continue; }
      const spec = OPS[op];
      if (!spec) { out.push(`  ${pc}: <op 0x${op.toString(16)}>`); continue; }
      const [name, width, kind] = spec;
      let operand;
      if (width === 1) operand = code[i];
      else if (width === 2) operand = code.readUInt16BE(i);
      else operand = code.readUInt16BE(i);
      i += width;

      if (kind === 'cp') out.push(`  ${pc}: ${name} ${cls.resolve(operand)}`);
      else if (kind === 'br') out.push(`  ${pc}: ${name} -> ${pc + (operand << 16 >> 16)}`);
      else out.push(`  ${pc}: ${name} ${operand}`);
    }
  }
  return out.join('\n');
}

const file = process.argv[2];
const method = process.argv[3];
if (file) {
  const cls = parseClass(fs.readFileSync(file));
  if (!method) {
    process.stdout.write(`${cls.thisClass}\n`);
    for (const m of cls.methods) process.stdout.write(`  ${m.name}${m.desc}\n`);
  } else {
    process.stdout.write(`${trace(cls, method)}\n`);
  }
}
