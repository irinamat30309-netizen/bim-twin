'use strict';
// Ревизия 54: замер качества облака вместо «на глаз» (tools/cloud-quality.js), вырезание куска для замеров
// (tools/las-crop.js) и выключатель уплотнения в окне «Чистовая обработка» (main.js, renderer/lixel-tools-ext.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const XL = require('../xbin-lidar');
const R = require('../scan-refine-core');
const CROP = require('../tools/las-crop');
const Q = require('../tools/cloud-quality');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let seed = 5; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) * Math.SQRT2; };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'r54-'));

/** LAS 1.2 формата 3 из точек { x, y, z, t } (34 байта). */
function writeLas(f, pts) {
  const h = XL.lasHeader({ n: pts.length, ox: 0, oy: 0, oz: 0, min: [0, 0, 0], max: [1, 1, 1] }), B = Buffer.alloc(pts.length * 34);
  pts.forEach((p, i) => {
    const q = i * 34;
    B.writeInt32LE(Math.round(p.x * 1000), q); B.writeInt32LE(Math.round(p.y * 1000), q + 4); B.writeInt32LE(Math.round(p.z * 1000), q + 8);
    B.writeUInt16LE(100, q + 12); B[q + 14] = 9; B[q + 15] = 2; B.writeDoubleLE(p.t || 0, q + 20);
  });
  fs.writeFileSync(f, Buffer.concat([h, B]));
  return f;
}

test('r54: вырезание куска LAS — рамка, время, число точек и заголовок; пустая рамка — ошибка', () => {
  const d = tmpDir();
  try {
    const pts = [];
    for (let i = 0; i < 3000; i++) pts.push({ x: rnd() * 4, y: rnd() * 4, z: rnd() * 3, t: 1000 + i * 0.1 });
    const src = writeLas(path.join(d, 'a.las'), pts);
    const out = path.join(d, 'w.las');
    const r = CROP.crop(src, out, { box: [1, 1, 0, 2, 2, 3], time: [1000, 1120] });
    const H = R.readHeader(fs.openSync(out, 'r'));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.points, H.n, 'в заголовке — вырезанное число точек');
    assert.ok(r.points > 50 && r.points < 3000 / 16 * 1.5, 'вырезана доля по рамке: ' + r.points);
    assert.ok(r.t0 >= 1000 && r.t1 <= 1120.0001, 'время в окне: ' + r.t0 + '…' + r.t1);
    // все точки файла — внутри рамки и времени
    const P = Q.readPoints(out, { box: [-1e6, -1e6, -1e6, 1e6, 1e6, 1e6] });
    assert.strictEqual(P.n, r.points);
    for (let i = 0; i < P.n; i++) {
      assert.ok(P.X[i] >= 1 && P.X[i] <= 2 && P.Y[i] >= 1 && P.Y[i] <= 2, 'x/y в рамке');
      assert.ok(P.T[i] >= 1000 && P.T[i] <= 1120.0001, 'время в окне');
    }
    assert.throws(() => CROP.crop(src, path.join(d, 'x.las'), { box: [50, 50, 0, 51, 51, 1] }), /нет точек/);
    assert.ok(!fs.existsSync(path.join(d, 'x.las')), 'пустой результат не остаётся');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('r54: замер качества — плотность, толщина и пустые пиксели 1 см сходятся с известными цифрами', () => {
  const d = tmpDir();
  try {
    const SP = 0.005, SIG = 0.0012, HOLE = 100;   // шаг 5 мм, шум 1,2 мм, 100 пустых клеток 1 см на окно 0,5 × 0,5 м (4 %)
    const pts = [];
    for (let i = 0; i < 200; i++) for (let j = 0; j < 200; j++) {
      if ((i >> 1) % 5 === 2 && (j >> 1) % 5 === 2) continue;   // целая клетка 1 см (2 × 2 точки) вырезана: 4 % в каждом окне
      pts.push({ x: 5 + gauss() * SIG, y: (j + 0.5) * SP, z: (i + 0.5) * SP, t: 0 });
    }
    const f = writeLas(path.join(d, 'wall.las'), pts);
    const m = Q.measure(f, { box: [4.9, -0.1, -0.1, 5.1, 2.1, 2.1], tile: 0.5, pixel: 0.01 });
    const s = m.summary;
    assert.strictEqual(s.tiles, 4, 'окна 0,5 × 0,5 м внутри стены 1 × 1 м: ' + s.tiles);
    assert.ok(Math.abs(s.perWindow - (10000 - 4 * HOLE)) <= 2, 'точек в окне: ' + s.perWindow);
    assert.ok(Math.abs(s.densityPerM2 - Math.round((10000 - 4 * HOLE) / 0.25)) <= 10, 'плотность: ' + s.densityPerM2);
    assert.ok(Math.abs(s.rmsMm - SIG * 1000) < 0.2, 'толщина СКО: ' + s.rmsMm);
    assert.ok(s.p95Mm > SIG * 1000 * 1.4 && s.p95Mm < SIG * 1000 * 2.0, 'толщина 95 %: ' + s.p95Mm);
    assert.ok(Math.abs(s.emptyPct - 4) <= 1.5, 'пустые пиксели: ' + s.emptyPct + ' %');
    assert.ok(Math.abs(s.spacingMm - 5) < 0.3, 'шаг точек: ' + s.spacingMm);
    // подложка без шума и дырок — идеальные цифры (проверка «нет ложных пустот»)
    const clean = []; for (let i = 0; i < 200; i++) for (let j = 0; j < 200; j++) clean.push({ x: 5, y: (j + 0.5) * SP, z: (i + 0.5) * SP, t: 0 });
    const mc = Q.measure(writeLas(path.join(d, 'clean.las'), clean), { box: [4.9, -0.1, -0.1, 5.1, 2.1, 2.1] });
    assert.strictEqual(mc.summary.emptyPct, 0, 'без дырок пустых пикселей нет: ' + mc.summary.emptyPct);
    assert.ok(mc.summary.rmsMm < 0.01, 'идеально плоская стена: ' + mc.summary.rmsMm);
    // заданная нормаль (стена по x) даёт те же цифры, что и «auto»
    const mn = Q.measure(f, { box: [4.9, -0.1, -0.1, 5.1, 2.1, 2.1], normal: 'x' });
    assert.ok(Math.abs(mn.summary.rmsMm - s.rmsMm) < 0.01 && Math.abs(mn.summary.emptyPct - s.emptyPct) < 0.01, 'normal x = auto');
    // сравнение с эталоном: разница считается и попадает в JSON
    const out = path.join(d, 'q.json');
    const { execFileSync } = require('node:child_process');
    execFileSync(process.execPath, [path.join(ROOT, 'tools/cloud-quality.js'), f, '--box=4.9,-0.1,-0.1,5.1,2.1,2.1', '--ref=' + f, '--json=' + out], { stdio: 'pipe' });
    const J = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(J.delta && J.delta.rmsMm === 0 && J.delta.emptyPct === 0, 'сравнение с собой — нулевая разница');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('r54: утончение стен не стирает ступень 1,5 см между панелями', () => {
  // стена x = 0, три панели по 0,4 м, средняя выступает на 1,5 см; шаг точек 6 мм, шум 1,5 мм
  const SP = 0.006, SIG = 0.0015, STEP = 0.015, PZ = 1.2, PY = 1.2, nz = Math.round(PZ / SP), ny = Math.round(PY / SP);
  const X = new Float64Array(nz * ny * 3); let n = 0;
  for (let i = 0; i < nz; i++) for (let j = 0; j < ny; j++) {
    const z = (i + 0.5) * SP, y = (j + 0.5) * SP, dz = z < PZ / 3 ? 0 : (z < 2 * PZ / 3 ? STEP : 0);
    X[n * 3] = dz + gauss() * SIG; X[n * 3 + 1] = y; X[n * 3 + 2] = z; n++;
  }
  const alive = new Uint8Array(n).fill(1);
  const moved = R.thinSurfaces(X, n, alive, { cell: 0.04, planar: 0.06 });
  // ревизия 132: moved считает только реально сдвинутые точки (|d|>1 мм) — при шуме 1,5 мм это ~половина,
  // а не «почти все» (раньше счётчик увеличивался для любой точки в плоской ячейке)
  assert.ok(moved > n * 0.2, 'утончение сдвигает точки с невязкой >1 мм: ' + moved);
  assert.ok(moved < n, 'не все точки считаются сдвинутыми: ' + moved);
  const pan = (z0, z1) => { let s = 0, c = 0; for (let i = 0; i < n; i++) { const z = X[i * 3 + 2], y = X[i * 3 + 1]; if (z < z0 || z > z1 || y < 0.05 || y > PY - 0.05) continue; s += X[i * 3]; c++; } return s / c; };
  const a = pan(0.05, PZ / 3 - 0.03), b = pan(PZ / 3 + 0.03, 2 * PZ / 3 - 0.03);
  assert.ok(Math.abs((b - a) - STEP) < 0.001, 'ступень между панелями сохранена: ' + ((b - a) * 1000).toFixed(2) + ' мм');
  let ss = 0, c2 = 0;   // толщина внутри панели
  for (let i = 0; i < n; i++) { const z = X[i * 3 + 2], y = X[i * 3 + 1]; if (y < 0.05 || y > PY - 0.05 || z < 0.05 || z > PZ - 0.05) continue; if (Math.abs(z - PZ / 3) < 0.09 || Math.abs(z - 2 * PZ / 3) < 0.09) continue; const d = X[i * 3] - (z < PZ / 3 ? a : (z < 2 * PZ / 3 ? b : a)); ss += d * d; c2++; }
  const rms = Math.sqrt(ss / c2);
  assert.ok(rms < 0.0012, 'панели стали тоньше 1,2 мм: ' + (rms * 1000).toFixed(2) + ' мм');
});

test('r54: уплотнение в окне «Чистовая обработка» — галочка, выключатель и предупреждение видны', () => {
  const m = read('main.js');
  assert.match(m, /densify: a\.densify !== false, densifyOpt: a\.densifyOpt && typeof a\.densifyOpt === 'object'/, 'выключатель доходит до обработки');
  assert.match(m, /densifyWarning: r\.densifyWarning/, 'предупреждение уплотнения возвращается в окно');
  const ui = read('renderer/lixel-tools-ext.js');
  assert.match(ui, /key: 'densify', main: densifyReady, label: 'Заполнить просветы точками сырого лидара'/, 'галочка в окне');
  assert.match(ui, /var densifyReady = !!\(xb && xb\.path\)/, 'видно, когда уплотнение возможно');
  assert.match(ui, /densify: densifyOn, densifyOpt: o\.densifyOpt/, 'выбор окна уходит в обработку');
  assert.match(ui, /else if \(densifyOn\) parts\.push\('уплотнение не выполнено'\)/, 'честный итог, если не вышло');
  assert.match(ui, /parts\.push\('просветы заполнены \(\+' \+ nfmt\(st\.densify\.added\)/, 'итог: сколько точек добавлено');
  assert.match(ui, /if \(res\.densifyWarning\) msg \+= '\\n\\nУплотнение не выполнено: '/, 'причина предупреждения в итоге');
  // без .xbin галочки нет — не обещаем того, чего не будет
  assert.match(ui, /showIf: function \(v\) \{ return densifyReady && v\.traj !== 'off' && v\.traj !== 'none'; \}/);
  const w = read('scan-refine-worker.js');
  assert.match(w, /o\.densify === false \|\| o\.noiseLevel === 'inspect'/, 'выключение и бережный режим уважаются');
});
