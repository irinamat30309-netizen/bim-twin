'use strict';
// Ревизия 45: чистовая обработка на нескольких ядрах (scan-refine-parallel.js) даёт побайтно тот же LAS, что однопоточный refine
// (со сведением проходов по траектории, выравниванием цвета, движущимися вокселями, мелкими плитками); сбой потока — понятная
// ошибка без временных файлов; число потоков — по ядрам и памяти; новые модули попадают в сборку; цвет мягче (blend).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../scan-refine-core');
const RP = require('../scan-refine-parallel');
const SC = require('./helpers/r20-scenes');

// комната 10×8×3 м, два прохода (второй сдвинут и темнее), как в r21
function roomLas(file, n) {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pts = new Array(n * 4), rgb = new Array(n * 3);
  const paint = (x, y, z) => { const k = (Math.floor(x * 1.3) + Math.floor(y * 1.7) + Math.floor(z * 2.1)) % 3; return k === 0 ? [150, 70, 55] : (k === 1 ? [140, 140, 140] : [80, 120, 170]); };
  for (let i = 0; i < n; i++) {
    const s = rnd() * 22; let x, y, z;
    if (s < 8) { x = rnd() * 10; y = rnd() * 8; z = 0; } else if (s < 11) { x = 0; y = rnd() * 8; z = rnd() * 3; } else if (s < 14) { x = 10; y = rnd() * 8; z = rnd() * 3; }
    else if (s < 18) { x = rnd() * 10; y = 0; z = rnd() * 3; } else { x = rnd() * 10; y = 8; z = rnd() * 3; }
    const b = rnd() < 0.5, c = paint(x, y, z), g = b ? 0.7 : 1;
    pts[i * 4] = x + (b ? 0.03 : 0) + (rnd() - 0.5) * 0.002; pts[i * 4 + 1] = y + (b ? -0.02 : 0) + (rnd() - 0.5) * 0.002; pts[i * 4 + 2] = z + (b ? 0.01 : 0) + (rnd() - 0.5) * 0.002;
    pts[i * 4 + 3] = b ? 200 + rnd() * 100 : rnd() * 100;
    for (let a = 0; a < 3; a++) rgb[i * 3 + a] = Math.round(Math.min(255, c[a] * g * (0.95 + 0.1 * rnd())));
  }
  SC.writeLas(file, pts, rgb);
}
const poses = () => { const L = []; for (let t = -1; t <= 301; t += 0.5) L.push([t, 2 + 6 * (t / 300), 4 + Math.sin(t / 20), 1.5].join(',')); return L.join('\n'); };
const dyn = () => { const grid = { gx: 0, gy: 0, gz: 0, v: 0.1, nx: 110, ny: 90, nz: 40 }, keys = []; for (let ix = 40; ix < 45; ix++) for (let iz = 0; iz < 12; iz++) keys.push(ix + 110 * 90 * iz, ix + 110 * (1 + 90 * iz)); return { sets: [{ keys, grid }] }; };

test('r45: несколько потоков — тот же LAS байт в байт, что один поток; временные файлы убраны', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r45-'));
  try {
    const src = path.join(dir, 'room.las'); roomLas(src, 200000);
    const cases = [{ noiseLevel: 'strong', tileMax: 30000, posesText: poses(), dynamic: dyn() }, { noiseLevel: 'normal', tileMax: 45000, color: false, align: false }];
    for (const o of cases) {
      const a = path.join(dir, 'a.las'), b = path.join(dir, 'b.las');
      const sa = R.refine(src, a, Object.assign({ tmpDir: dir }, o));
      const sb = await RP.refineParallel(src, b, Object.assign({ tmpDir: dir, threads: 3 }, o));
      assert.ok(sa.tiles >= 6, 'плиток: ' + sa.tiles); assert.strictEqual(sb.threads, 3);
      assert.ok(Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0, 'LAS различается: ' + JSON.stringify(o.noiseLevel));
      for (const k of ['written', 'noise', 'moved', 'recolored', 'dynamic', 'tiles']) assert.strictEqual(sb[k], sa[k], k);
      assert.deepStrictEqual(sb.align, sa.align);
      if (o.posesText) { assert.ok(sa.align.trajectory === true, 'сведение по траектории: ' + JSON.stringify(sa.align)); assert.ok(sa.dynamic > 100, 'движущихся: ' + sa.dynamic); }
    }
    assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.startsWith('.refine-')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('r45: сбой потока — понятная ошибка, временные файлы убраны', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r45f-'));
  try {
    const src = path.join(dir, 'room.las'); roomLas(src, 60000);
    const bad = path.join(dir, 'bad-worker.js'), tw = JSON.stringify(path.join(__dirname, '..', 'scan-refine-tile-worker.js'));
    fs.writeFileSync(bad, `const wt = require('node:worker_threads'); const TW = require(${tw}); const ctx = TW.makeCtx(wt.workerData);
wt.parentPort.on('message', (m) => { if (m.t === 2) { if (require('node:fs').existsSync(${JSON.stringify(path.join(dir, 'exit.flag'))})) process.exit(3); wt.parentPort.postMessage({ type: 'error', t: m.t, error: 'сбой' }); return; }
  wt.parentPort.postMessage(Object.assign({ type: 'done' }, TW.runTile(ctx, wt.workerData.tmp, m.t, m.T))); });
wt.parentPort.postMessage({ type: 'ready' });`);
    for (const [mode, re] of [['msg', /обработка плитки 2: сбой/], ['exit', /завершился с кодом 3/]]) {
      if (mode === 'exit') fs.writeFileSync(path.join(dir, 'exit.flag'), '1');   // поток падает на плитке 2 сообщением или выходом
      await assert.rejects(RP.refineParallel(src, path.join(dir, 'o.las'), { tmpDir: dir, tileMax: 10000, threads: 2, _workerPath: bad }), re);
      assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.startsWith('.refine-')), []);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// стена 1×1 м с шумом цвета ±4, 5 % «соли» (±90), тёмный провод z = 0,5 и светлый шов x = 0,3 (как в r21)
function denseWall(dens) {
  let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const n = Math.round(dens), X = new Float64Array(n * 3), C = new Float32Array(n * 3), TC = new Float32Array(n * 3), K = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = rnd(), z = rnd(); X[i * 3] = x; X[i * 3 + 1] = (rnd() - 0.5) * 0.002; X[i * 3 + 2] = z;
    let c = [150, 150, 150], k = 0; if (Math.abs(z - 0.5) < 0.005) { c = [40, 40, 45]; k = 2; } else if (Math.abs(x - 0.3) < 0.005) { c = [210, 205, 200]; k = 3; }
    for (let a = 0; a < 3; a++) { TC[i * 3 + a] = c[a]; C[i * 3 + a] = c[a] + (rnd() - 0.5) * 8; }
    if (k === 0 && rnd() < 0.05) { const s = rnd() < 0.5 ? -90 : 90; for (let a = 0; a < 3; a++) C[i * 3 + a] = Math.max(0, Math.min(255, C[i * 3 + a] + s)); k = 1; }
    K[i] = k;
  }
  return { n, X, C, TC, K };
}

test('r45: цвет мягче — мелкий шум на стене почти вдвое меньше, провод и шов не размываются; уровни очистки', () => {
  const W = denseWall(60000), alive = new Uint8Array(W.n).fill(1);
  const err = (Cx, k) => { let e = 0, c = 0; for (let i = 0; i < W.n; i++) { if (W.K[i] !== k) continue; e += (Math.abs(Cx[i * 3] - W.TC[i * 3]) + Math.abs(Cx[i * 3 + 1] - W.TC[i * 3 + 1]) + Math.abs(Cx[i * 3 + 2] - W.TC[i * 3 + 2])) / 3; c++; } return e / c; };
  const C0 = W.C.slice(), C1 = W.C.slice();
  R.clampColors(W.X, C0, W.n, alive, { T: 12 }); R.clampColors(W.X, C1, W.n, alive, { T: 12, blend: 0.5 });
  assert.ok(err(C1, 0) < err(C0, 0) * 0.65, 'поверхность: ' + err(C0, 0).toFixed(2) + ' → ' + err(C1, 0).toFixed(2));
  assert.ok(err(C1, 1) < err(C0, 1) * 0.7, '«соль»: ' + err(C0, 1).toFixed(2) + ' → ' + err(C1, 1).toFixed(2));
  assert.ok(err(C1, 2) < err(W.C, 2) + 6 && err(C1, 3) < err(W.C, 3) + 6, 'провод ' + err(C1, 2).toFixed(2) + ', шов ' + err(C1, 3).toFixed(2));
  // без blend — прежнее поведение (только ограничение ±T)
  const C2 = W.C.slice(); R.clampColors(W.X, C2, W.n, alive, { T: 12, blend: 0 }); assert.deepStrictEqual(C2, C0);
  assert.strictEqual(R.NOISE_LEVELS.strong.blend, 0.5); assert.ok(!R.NOISE_LEVELS.soft.blend && !R.NOISE_LEVELS.inspect.blend);
});

test('r45: число потоков — ядра − 1 (не меньше двух), не больше, чем позволяет память', () => {
  const P = (c, gb, tiles, m) => RP.pickThreads({ _cpus: c, _freeMem: gb * 1e9 }, tiles, m);
  assert.strictEqual(P(8, 16, 20, 4e6), 7); assert.strictEqual(P(2, 3.5, 20, 1.5e6), 2); assert.strictEqual(P(16, 64, 40, 4e6), 15);
  assert.strictEqual(P(32, 128, 40, 4e6), 16); assert.strictEqual(P(8, 4, 20, 4e6), 2); assert.strictEqual(P(8, 1.2, 20, 4e6), 1);
  assert.strictEqual(P(8, 16, 1, 4e6), 1); assert.strictEqual(P(1, 8, 5, 1e6), 1);
  assert.strictEqual(RP.pickThreads({ threads: 5 }, 3, 1e6), 3);
});

test('r45: пул потоков попадает в сборку и распаковывается для worker_threads; фоновая обработка использует его', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  for (const f of ['scan-refine-parallel.js', 'scan-refine-tile-worker.js']) { assert.ok(pkg.build.files.includes(f), 'files: ' + f); assert.ok(pkg.build.asarUnpack.includes(f), 'asarUnpack: ' + f); }
  const w = fs.readFileSync(path.join(__dirname, '..', 'scan-refine-worker.js'), 'utf8');
  assert.ok(/refineParallel\(/.test(w), 'scan-refine-worker вызывает refineParallel');
});
