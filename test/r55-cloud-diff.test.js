'use strict';
// Ревизия 55: tools/cloud-diff.js — показывает, что «вырезала» обработка: точки, у которых в новом облаке
// нет ни одной точки в ячейке 0,5 м. Проверяем на синтетике: стена остаётся, одиночный мусор попадает в файл.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const XL = require('../xbin-lidar');
const R = require('../scan-refine-core');
const ROOT = path.join(__dirname, '..');

function writeLas(f, pts) {
  const h = XL.lasHeader({ n: pts.length, ox: 0, oy: 0, oz: 0, min: [0, 0, 0], max: [1, 1, 1] }), B = Buffer.alloc(pts.length * 34);
  pts.forEach((p, i) => {
    const q = i * 34;
    B.writeInt32LE(Math.round(p[0] * 1000), q); B.writeInt32LE(Math.round(p[1] * 1000), q + 4); B.writeInt32LE(Math.round(p[2] * 1000), q + 8);
    B.writeUInt16LE(100, q + 12); B[q + 14] = 9; B[q + 15] = 2; B.writeDoubleLE(0, q + 20);
  });
  fs.writeFileSync(f, Buffer.concat([h, B]));
  return f;
}

test('r55: cloud-diff показывает только вырезанные точки', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r55diff-'));
  try {
    const wall = [];
    for (let i = 0; i < 100; i++) for (let j = 0; j < 100; j++) wall.push([0, j * 0.01, i * 0.01]);   // стена 1 × 1 м
    const junk = [[5, 5, 5], [5.2, 5, 5], [-3, -3, 2]];
    const before = writeLas(path.join(d, 'before.las'), wall.concat(junk));
    const after = writeLas(path.join(d, 'after.las'), wall);
    const out = path.join(d, 'diff.las');
    const res = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'tools/cloud-diff.js'), before, after, out, '--cell', '0.5'], { encoding: 'utf8' }));
    assert.strictEqual(res.written, junk.length, 'вырезано ровно мусорные точки: ' + res.written);
    assert.strictEqual(res.kept, wall.length, 'стена не попала в вырезанное: ' + res.kept);
    const fd = fs.openSync(out, 'r'); const H = R.readHeader(fd); fs.closeSync(fd);
    assert.strictEqual(H.n, junk.length, 'в файле вырезанного — только мусор');
    // когда ничего не вырезано, файл не создаётся
    const out2 = path.join(d, 'diff2.las');
    const res2 = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'tools/cloud-diff.js'), after, after, out2], { encoding: 'utf8' }));
    assert.strictEqual(res2.written, 0); assert.ok(!fs.existsSync(out2), 'пустой результат не пишется');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
