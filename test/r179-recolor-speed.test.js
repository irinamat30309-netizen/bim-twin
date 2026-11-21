'use strict';
// r179: ускорение «Цвет по фото» — отбор кадров, параллельная раскраска по тайлам времени, потоковое заполнение.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const RC = require('../recolor-core');
const RP = require('../recolor-parallel');
const { writeLas } = require('./helpers/r20-scenes');
const S = require('./helpers/r22-photo-scene');

const dirs = [];
function tmpdir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r179-')); dirs.push(d); return d; }
test.after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } });

test('r179: дефолты ускорения — шаг кадров 2, дизеринг выключен, заполнение/денойз включены', () => {
  assert.equal(RC.DEF.frameStride, 2, 'frameStride=2 по умолчанию');
  assert.equal(RC.DEF.dither, false, 'дизеринг выключен');
  assert.equal(RC.DEF.fill, true);
  assert.equal(RC.DEF.denoise, true);
  assert.ok(RC.DEF.fillMaxPts >= 60000000, 'заполнение не отключается на больших облаках');
});

test('r179: selectFrames — каждый 2-й кадр своего канала, первый и последний сохранены', () => {
  let txt = '';
  for (let i = 0; i < 100; i++) txt += [i * 0.1, i * 0.01, 0, 0, 0, 0, 0, 1].join(',') + '\n';
  const P = RC.parsePoses(txt);
  const frames = [];
  for (let i = 0; i < 40; i++) {
    frames.push({ t: i * 0.1, R: { ch: 'a' } });
    frames.push({ t: i * 0.1 + 0.001, R: { ch: 'b' } });
  }
  frames.sort((p, q) => p.t - q.t);
  const sel = RC.selectFrames(frames, P, { frameStride: 2 });
  for (const ch of ['a', 'b']) {
    const idx = sel.frames.filter(f => f.R.ch === ch).map(f => +f.t.toFixed(3));
    const allT = frames.filter(f => f.R.ch === ch).map(f => +f.t.toFixed(3));
    assert.equal(idx.length, 21, ch + ': 20/2 + последний = 21, получено ' + idx.length);
    assert.equal(idx[0], allT[0], ch + ': первый кадр на месте');
    assert.equal(idx[idx.length - 1], allT[allT.length - 1], ch + ': последний кадр на месте');
    assert.ok(Math.abs(idx[1] - idx[0] - 0.2) < 1e-6, ch + ': шаг 0.2 с');
  }
  const all = RC.selectFrames(frames, P, { frameStride: 1, frameStepM: 0, frameStepDeg: 0 });
  assert.equal(all.frames.length, frames.length, 'без опций — все кадры');
});

// маленький LAS fmt3 с монотонным временем (для split/merge)
function makeSmallLas(file, n) {
  const rl = 34, hsz = 227;
  const b = Buffer.alloc(hsz + n * rl);
  b.write('LASF', 0, 'latin1'); b[24] = 1; b[25] = 2;
  b.writeUInt16LE(hsz, 94); b.writeUInt32LE(hsz, 96); b[104] = 3; b.writeUInt16LE(rl, 105); b.writeUInt32LE(n, 107);
  b.writeDoubleLE(0.001, 131); b.writeDoubleLE(0.001, 139); b.writeDoubleLE(0.001, 147);
  for (let i = 0; i < n; i++) {
    const p = hsz + i * rl;
    b.writeInt32LE(i * 7 % 100000, p); b.writeInt32LE(i % 1000, p + 4); b.writeInt32LE(i % 500, p + 8);
    b.writeDoubleLE(1000 + i * 0.01, p + 20);
    b.writeUInt16LE(100, p + 28); b.writeUInt16LE(50, p + 30); b.writeUInt16LE(25, p + 32);
  }
  fs.writeFileSync(file, b);
  return n;
}

test('r179: splitByTime + mergeTiles — тайлы склеиваются байт-в-байт (порядок строк сохранён)', () => {
  const dir = tmpdir();
  const src = path.join(dir, 'in.las');
  const n = makeSmallLas(src, 4000);
  const split = RP.splitByTime(src, dir, 4);
  assert.equal(split.tiles.length, 4);
  assert.equal(split.tiles.reduce((a, t) => a + t.count, 0), n);
  for (const T of split.tiles) fs.copyFileSync(T.path, T.out);   // «раскраска» без изменений
  const dst = path.join(dir, 'merged.las');
  const m = RP.mergeTiles(split, dst);
  assert.equal(m.total, n);
  const a = fs.readFileSync(src), b = fs.readFileSync(dst);
  assert.equal(a.length, b.length);
  assert.ok(a.equals(b), 'склейка восстанавливает исходный LAS байт-в-байт');
  RP.cleanup(split);
});

test('r179: parallelRecolor — параллельные тайлы и склейка (runOne-копия)', async () => {
  const dir = tmpdir();
  const src = path.join(dir, 'in.las');
  makeSmallLas(src, 3000);
  const dst = path.join(dir, 'out.las');
  let calls = 0;
  const r = await RP.parallelRecolor({
    src, dst, xbin: '/x.xbin', posesText: 'p', tmpDir: dir, opt: {}, workers: 3,
    runOne: async (cfg) => { calls++; fs.copyFileSync(cfg.src, cfg.dst); return { ok: true, stats: { colored: 10 } }; },
    onProgress: () => {}, job: {}, log: () => {}
  });
  assert.equal(r.ok, true);
  assert.equal(calls, 3, 'по одному вызову на тайл');
  assert.ok(fs.readFileSync(dst).equals(fs.readFileSync(src)), 'итог совпадает с исходником');
});

test('r179: recolor с improve и frameStride=2 эквивалентен по покрытию (синтетика)', async () => {
  const dir = tmpdir(), src = path.join(dir, 'in.las'), dst1 = path.join(dir, 'out1.las'), dst2 = path.join(dir, 'out2.las');
  const C = S.cloud(5); writeLas(src, C.pts, C.rgb);
  const frames = S.frames(5), cache = new Map();
  const index = { path: null, calib: S.calib(), frames: { 8: frames } };
  const mk = (dst, opt) => RC.recolor(src, dst, {
    index, posesText: S.posesText(), tmpDir: dir, readFrame: (f) => Buffer.from([f.off]),
    decode: async (b) => { const k = b[0]; if (!cache.has(k)) cache.set(k, S.render(frames[k].t)); return cache.get(k); },
    opt: Object.assign({ cell: 4, dMax: 12, improve: true, frameStrideMinFrames: 1 }, opt || {}),
  });
  const a = await mk(dst1, { frameStride: 1 });
  const b = await mk(dst2, { frameStride: 2 });
  assert.ok(b.framesSelected <= a.framesSelected * 0.6, 'кадров вдвое меньше: ' + a.framesSelected + ' → ' + b.framesSelected);
  assert.ok(b.colored >= a.colored * 0.97, 'покрытие не падает: ' + a.colored + ' → ' + b.colored);
});
