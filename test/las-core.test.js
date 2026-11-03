'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const core = require('../las-core');

function hdr(fmt, count, recLen, extendedCount) {
  const b = Buffer.alloc(400);
  b.write('LASF', 0, 'ascii');
  b.writeUInt8(4, 25);            // version minor 1.4
  b.writeUInt32LE(400, 96);       // offset to point data
  b.writeUInt8(fmt, 104);         // point data record format
  b.writeUInt16LE(recLen, 105);  // record length
  b.writeUInt32LE(count, 107);   // legacy point count
  b.writeDoubleLE(0.001, 131); b.writeDoubleLE(0.002, 139); b.writeDoubleLE(0.003, 147);
  b.writeDoubleLE(10, 155); b.writeDoubleLE(20, 163); b.writeDoubleLE(30, 171);
  if (extendedCount != null) b.writeBigUInt64LE(BigInt(extendedCount), 247);
  return {
    u8: (o) => b.readUInt8(o), u16: (o) => b.readUInt16LE(o), u32: (o) => b.readUInt32LE(o),
    i32: (o) => b.readInt32LE(o), f64: (o) => b.readDoubleLE(o), big64: (o) => Number(b.readBigUInt64LE(o)),
  };
}

test('parseLasHeader reads core fields', () => {
  const H = core.parseLasHeader(hdr(3, 1000, 34));
  assert.equal(H.fmt, 3);
  assert.equal(H.recLen, 34);
  assert.equal(H.count, 1000);
  assert.equal(H.offToPts, 400);
  assert.equal(H.colorOff, 28);
  assert.equal(H.hasColor, true);
  assert.equal(H.scale.x, 0.001);
  assert.equal(H.offset.z, 30);
});

test('format 0 has no color offset', () => {
  const H = core.parseLasHeader(hdr(0, 5, 20));
  assert.equal(H.hasColor, false);
  assert.equal(H.colorOff, undefined);
});

test('LAS 1.4 extended point count is authoritative when populated', () => {
  const H = core.parseLasHeader(hdr(7, 123, 36, 5000000123));
  assert.equal(H.count, 5000000123);
});

test('bad signature throws', () => {
  const b = Buffer.alloc(400); b.write('XXXX', 0, 'ascii');
  const r = { u8: (o) => b.readUInt8(o), u16: () => 0, u32: () => 0, i32: () => 0, f64: () => 0 };
  assert.throws(() => core.parseLasHeader(r), /LASF/);
});

test('elevationRamp stays within [0,1] and is clamped', () => {
  for (const t of [-1, 0, 0.25, 0.5, 0.75, 1, 2]) {
    const c = core.elevationRamp(t);
    assert.equal(c.length, 3);
    for (const v of c) { assert.ok(v >= 0 && v <= 1, 'channel in range for t=' + t); }
  }
});

test('decideColorDivisor picks depth', () => {
  assert.deepEqual(core.decideColorDivisor(0), { hasColor: false, colDiv: 65535 });
  assert.deepEqual(core.decideColorDivisor(200), { hasColor: true, colDiv: 255 });
  assert.deepEqual(core.decideColorDivisor(5000), { hasColor: true, colDiv: 65535 });
});
