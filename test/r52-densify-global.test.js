'use strict';
// Ревизия 52: уплотнение — общая для всей съёмки карта занятых ячеек (globalOcc). Место, пройденное сканером дважды,
// не получает двойной плотности: второй проход добавляет точки только туда, где по всему облаку ещё пусто.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XL = require('../xbin-lidar');
const D = require('../cloud-densify-core');

let s32 = 12345;
const rnd = () => { s32 = (s32 + 0x6D2B79F5) | 0; let t = Math.imul(s32 ^ (s32 >>> 15), 1 | s32); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) * Math.SQRT2; };
function writeLas(f, pts) {
  const h = XL.lasHeader({ n: pts.length, ox: 0, oy: 0, oz: 0, min: [0, 0, 0], max: [1, 1, 1] }), B = Buffer.alloc(pts.length * 34);
  pts.forEach((p, i) => { const q = i * 34; B.writeInt32LE(Math.round(p.x * 1000), q); B.writeInt32LE(Math.round(p.y * 1000), q + 4); B.writeInt32LE(Math.round(p.z * 1000), q + 8);
    B.writeUInt16LE(100, q + 12); B[q + 14] = 9; B[q + 15] = 2; B.writeDoubleLE(p.t, q + 20); for (let a = 0; a < 3; a++) B.writeUInt16LE(p.c[a], q + 28 + a * 2); });
  fs.writeFileSync(f, Buffer.concat([h, B]));
}
function cells(f, cell) {
  const b = fs.readFileSync(f), n = b.readUInt32LE(107), off = b.readUInt32LE(96), rl = b.readUInt16LE(105), sx = b.readDoubleLE(131), m = new Map();
  for (let i = 0, q = off; i < n; i++, q += rl) {
    const k = Math.floor(b.readInt32LE(q) * sx / cell) + ',' + Math.floor(b.readInt32LE(q + 4) * sx / cell) + ',' + Math.floor(b.readInt32LE(q + 8) * sx / cell);
    m.set(k, (m.get(k) || 0) + 1);
  }
  let multi = 0; for (const v of m.values()) if (v > 1) multi++;
  return { n, cells: m.size, multi };
}

test('r52: два прохода по одной стене — без общей карты точки дублируются, с ней каждая ячейка занята не больше одной точкой', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r52-')), g = path.join(d, 'g.las'), w = path.join(d, 'raw.las');
  const T = 1788423000, gp = [], rp = [];
  // стена y = 2,0005 (x 0…1, z 0…1); опора шагом 1 см — половина точек из прохода 1 (t 0…10 с), половина из прохода 2 (t 600…610 с)
  for (let i = 0; i < 100; i++) for (let j = 0; j < 100; j++) gp.push({ x: i * 0.01 + 0.0025, y: 2.0005, z: j * 0.01 + 0.0025, t: T + ((i + j) % 2 ? 600 : 0) + ((i * 100 + j) % 10), c: [40000, 30000, 20000] });
  for (const t0 of [0, 600]) for (let k = 0; k < 30000; k++) rp.push({ x: rnd(), y: 2.0005 + gauss() * 0.006, z: rnd(), t: T + t0 + k / 3000, c: [0, 0, 0] });
  writeLas(g, gp); writeLas(w, rp);
  const on = path.join(d, 'on.las'), off = path.join(d, 'off.las');
  const a = await D.densifyLas(g, on, { lasPath: w }, { tmpDir: d, cell: 0.006 });
  const b = await D.densifyLas(g, off, { lasPath: w }, { tmpDir: d, cell: 0.006, globalOcc: false });
  const A = cells(on, 0.006), B = cells(off, 0.006);
  assert.strictEqual(A.n, a.points); assert.strictEqual(B.n, b.points);
  assert.strictEqual(A.multi, 0, 'с общей картой нет ячеек с двумя точками');
  assert.strictEqual(A.cells, A.n);
  assert.ok(B.multi > 5000, 'без общей карты второй проход дублирует: ' + B.multi);
  assert.ok(b.added > a.added * 1.5, 'без карты добавлено ' + b.added + ', с картой ' + a.added);
  assert.ok(A.cells >= B.cells * 0.99, 'покрытие не хуже: ' + A.cells + ' / ' + B.cells);
  assert.ok(A.cells > 20000, 'стена заполнена: ' + A.cells);
  assert.ok(a.dupGlobal > 0 && b.dupGlobal === 0);
  assert.strictEqual(a.kept, a.added);
  fs.rmSync(d, { recursive: true, force: true });
});

test('r52: начало куска кратно ячейке; ячейка новой точки считается по записанным в LAS координатам', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'cloud-densify-core.js'), 'utf8');
  assert.match(src, /ox: Math\.round\(x \/ g\) \* g/);
  assert.match(src, /GO\.take\(rec\.readInt32LE\(0\) \* H\.sx \+ H\.ox/);
  assert.match(src, /globalOcc === false \? null : globalOcc\(H\.n, o\.cell\)/);
});

test('r52: ячейка по умолчанию 5 мм (предел ~40 тыс. точек/м² на плоскости — выше эталона ~36 тыс.), карта ~24 бита на точку опоры', () => {
  assert.strictEqual(D.DEF.cell, 0.005);
  const src = fs.readFileSync(path.join(__dirname, '..', 'cloud-densify-core.js'), 'utf8');
  assert.match(src, /Math\.log2\(Math\.max\(1, n\) \* 24\)/);
});
