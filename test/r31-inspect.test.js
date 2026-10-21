'use strict';
// Ревизия 31: контроль геометрии по облаку — пол (FF/FL по ASTM E1155, уклон, рейка 2 м), стены (вертикаль, неровность,
// сторона помещения по маршруту), углы, сравнение с планом DXF, проход по файлу (eachPoint), задание 'inspect' на синтетическом LAS,
// окно (CloudInspectUI: палитры, CSV, вывод), PDF-отчёт (CloudReport.inspect) и проводка IPC / preload / ленты / index.html.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const CI = require(path.join(ROOT, 'renderer', 'cloud-inspect.js'));
const UI = require(path.join(ROOT, 'renderer', 'cloud-inspect-ui.js'));
const REP = require(path.join(ROOT, 'renderer', 'cloud-report.js'));
const DP = require(path.join(ROOT, 'renderer', 'dxfparse.js'));
const OV = require(path.join(ROOT, 'cloud-overview.js'));
const Seg = require(path.join(ROOT, 'cloud-segments.js'));
const JOB = require(path.join(ROOT, 'cloud-inspect-job.js'));
const G = require('./r27-synthetic.helper.js');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ': ' + a + ' ≠ ' + b + ' ± ' + tol);
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-r31-'));

// пол 12 × 8 м, клетка 10 см, 12 точек на клетку, шум 0,5 мм
function floorRep(fz, seed) {
  const r = rng(seed || 5), acc = CI.floorAcc({ u0: 0, v0: 0, u1: 12, v1: 8, h0: -0.1, h1: 0.15, cell: 0.1 });
  for (let x = 0; x < 12; x += 0.1) for (let y = 0; y < 8; y += 0.1) for (let k = 0; k < 12; k++) { const u = x + r() * 0.1, v = y + r() * 0.1; acc.add(u, v, fz(u, v) + 0.0005 * gauss(r)); }
  return CI.floorReport(CI.floorGrid(acc), { phi: 0, tol: 4 });
}

test('пол: ровная плита — FF высокий, уклона нет, просвет под рейкой меньше 2 мм', () => {
  const f = floorRep(() => 0);
  assert.ok(f.ok); near(f.area, 96, 1, 'площадь');
  assert.ok(f.F.FF > 50, 'FF ' + f.F.FF); assert.ok(f.F.FL > 100, 'FL ' + f.F.FL);
  assert.ok(f.plane.mmPerM < 0.1, 'уклон ' + f.plane.mmPerM);
  assert.ok(f.rail.n > 100 && f.rail.max < 2 && f.rail.over === 0, 'рейка ' + f.rail.max);
  assert.ok(f.sigma > 0 && f.sigma < 0.5, 'шум средних по клеткам, мм: ' + f.sigma);
});

test('пол: уклон 2 мм/м вдоль X — найден уклон и направление понижения, FL падает', () => {
  const f = floorRep((u) => 0.002 * u);
  near(f.plane.mmPerM, 2, 0.05, 'мм/м'); near(Math.abs(f.plane.downDir), 180, 1, 'понижение к −X');
  near(f.plane.deg, Math.atan(0.002) * 180 / Math.PI, 0.005, 'градусы');
  assert.ok(f.F.FF > 50, 'плоскостность не страдает от ровного уклона: ' + f.F.FF);
  assert.ok(f.F.FL < 40, 'FL ' + f.F.FL);
  assert.ok(f.rail.max < 2, 'рейка не видит ровный уклон');
});

test('пол: волна ±3 мм и бугор 8 мм — FF падает, рейка находит просвет больше 4 мм', () => {
  const s = floorRep((u) => 0.003 * Math.sin(Math.PI * u));
  assert.ok(s.F.FF < 35 && s.F.FF > 15, 'FF волны ' + s.F.FF);
  assert.ok(s.rail.max > 5 && s.rail.over > 0.1, 'рейка ' + s.rail.max + ' / ' + s.rail.over);
  const b = floorRep((u, v) => { const d = Math.hypot(u - 6, v - 4); return d < 0.6 ? 0.008 * Math.cos(d / 0.6 * Math.PI / 2) ** 2 : 0; });
  assert.ok(b.rail.max > 4 && b.rail.over > 0 && b.rail.over < 0.05, 'бугор: ' + b.rail.max + ' / ' + b.rail.over);
  assert.ok(b.flat.max > 7, 'наибольшее отклонение от плоскости ' + b.flat.max);
  const w = b.rail.worst[0]; near(w.u, 6, 0.8, 'место бугра X'); near(w.v, 4, 0.8, 'место бугра Y');
});

// три стены: 1 — завал 3 мм/м и шкаф перед ней; 2 — вертикальна, впадина 5 мм; 3 — с плинтусом и перегородкой в 8 см за ней
function wallsRep() {
  const r = rng(9), faces = [{ a: [0, 0], b: [6, 0] }, { a: [6, 0], b: [6, 4] }, { a: [0, 0.1], b: [0, 4] }];
  const acc = CI.wallAcc(faces, { floor: 0, top: 2.9 });
  for (let i = 0; i < 300000; i++) { const x = r() * 6, h = r() * 2.8; acc.add(x, 0.003 * h + 0.002 * gauss(r), h); }
  for (let i = 0; i < 200000; i++) { const y = r() * 4, h = r() * 2.8, d = Math.hypot(y - 2, h - 1.4) < 0.4 ? -0.005 : 0; acc.add(6 + d + 0.002 * gauss(r), y, h); }
  for (let i = 0; i < 30000; i++) { const x = 2 + r(), h = r() * 2; acc.add(x, 0.035 + 0.002 * gauss(r), h); }
  for (let i = 0; i < 150000; i++) { const y = 0.1 + r() * 3.9, h = r() * 2.8; acc.add(0.002 * gauss(r), y, h); acc.add(-0.08 + 0.002 * gauss(r), y, h); }
  for (let i = 0; i < 20000; i++) { const y = 0.1 + r() * 3.9, h = r() * 0.1; acc.add(0.015 + 0.001 * gauss(r), y, h); }
  const route = new Float32Array([3, 2, 0, 0, 3.5, 2, 0, 1, 4, 2.2, 0, 2, 4.5, 2.5, 0, 3]);
  const side = CI.sidesFromRoute(faces, route, { radius: 10, minLen: 1 });
  return { faces, side, rep: CI.wallReport(acc, { side, plumbPerM: 2, plumbMax: 10, tol: 3 }) };
}

test('стены: завал 3 мм/м, впадина 5 мм; шкаф, плинтус и соседняя перегородка не мешают', () => {
  const { side, rep } = wallsRep();
  assert.deepEqual(side, { 0: 1, 1: 1, 2: -1 }, 'сторона помещения по маршруту');
  assert.ok(rep.ok); assert.equal(rep.checked, 3);
  const [a, b, c] = rep.walls;
  near(a.plumb, 3, 0.15, 'завал, мм/м'); near(a.lean, 3 * a.height, 0.5, 'завал на высоту, мм'); assert.equal(a.toward, 'room', 'верх наклонён в помещение');
  assert.equal(a.okPlumb, false); assert.equal(a.okRail, true, 'шкаф в 35 мм от стены не считается неровностью');
  assert.ok(b.plumb < 0.3, 'вторая стена вертикальна: ' + b.plumb); assert.equal(b.okPlumb, true);
  assert.ok(b.rail > 3.5 && b.rail < 6, 'впадина 5 мм под рейкой: ' + b.rail); assert.equal(b.okRail, false);
  assert.ok(c.plumb < 0.3 && c.rms < 0.5 && c.rail < 1.5, 'перегородка в 8 см и плинтус не попали в стену: ' + c.plumb + ' / ' + c.rms + ' / ' + c.rail);
  assert.ok(c.hFrom >= 0.1, 'низ стены (плинтус) пропущен: ' + c.hFrom);
  for (const w of rep.walls) { assert.ok(w.noise > 0 && w.noise < 0.5, 'шум клеток ' + w.noise); assert.ok(w.cover > 0.8, 'покрытие ' + w.cover); }
  assert.equal(rep.bad, 2);
  assert.deepEqual([UI.wallStatus(a), UI.wallStatus(b), UI.wallStatus(c)], ['plumb', 'rail', 'ok']);
});

test('углы между гранями: прямой угол и наклонный на 1°', () => {
  const { faces } = wallsRep();
  const k = CI.corners(faces);
  assert.equal(k.length, 2); for (const x of k) near(x.angle, 90, 0.01, 'угол');
  const t = Math.tan(91 * Math.PI / 180), f2 = [{ a: [0, 0], b: [5, 0] }, { a: [5, 0], b: [5 + 3 / t, 3] }];
  const k2 = CI.corners(f2); assert.equal(k2.length, 1); near(k2[0].dev, 1, 0.02, 'отклонение'); near(k2[0].mmPerM, 17.45, 0.3, 'мм на 1 м');
});

// срез: прямоугольник 10 × 6 м и перегородка x = 6 (точки через 1 см, шум 3 мм), в локальных метрах облака
function sliceUV(seed) {
  const r = rng(seed || 11), P = [], lines = [[[0, 0], [10, 0]], [[10, 0], [10, 6]], [[10, 6], [0, 6]], [[0, 6], [0, 0]], [[6, 0], [6, 6]]];
  for (const [a, b] of lines) { const L = Math.hypot(b[0] - a[0], b[1] - a[1]), nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
    for (let t = 0; t < L; t += 0.01) for (let k = 0; k < 3; k++) { const e = gauss(r) * 0.003; P.push(a[0] + (b[0] - a[0]) * t / L + nx * e, a[1] + (b[1] - a[1]) * t / L + ny * e); } }
  return { uv: Float32Array.from(P), lines };
}
// DXF: линии проекта в мм, повёрнуты на rot° и сдвинуты; moved — номер линии, сдвинутой на 50 мм
function dxfText(lines, o) {
  o = o || {}; const a = (o.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), k = o.scale || 1000;
  const T = (p) => [k * (c * p[0] - s * p[1]) + (o.tx || 0), k * (s * p[0] + c * p[1]) + (o.ty || 0)];
  let out = '0\nSECTION\n2\nENTITIES\n';
  lines.forEach((ln, i) => {
    let [A, B] = ln;
    if (i === o.moved) { const L = Math.hypot(B[0] - A[0], B[1] - A[1]), nx = -(B[1] - A[1]) / L, ny = (B[0] - A[0]) / L; A = [A[0] + nx * 0.05, A[1] + ny * 0.05]; B = [B[0] + nx * 0.05, B[1] + ny * 0.05]; }
    const P = T(A), Q = T(B); out += '0\nLINE\n8\nA-WALL\n10\n' + P[0] + '\n20\n' + P[1] + '\n11\n' + Q[0] + '\n21\n' + Q[1] + '\n';
  });
  // проём и размер — не стены, пропускаются
  out += '0\nLINE\n8\nA-OPEN\n10\n0\n20\n0\n11\n' + 9000 + '\n21\n' + 5000 + '\n';
  out += '0\nLINE\n8\nA-DIMS\n10\n0\n20\n0\n11\n' + 5000 + '\n21\n' + 9000 + '\n';
  return out + '0\nENDSEC\n0\nEOF\n';
}

test('DXF: слои проёмов и размеров пропускаются, LWPOLYLINE разбивается на отрезки', () => {
  const { lines } = sliceUV();
  const segs = CI.dxfSegments(DP.parse(dxfText(lines)));
  assert.equal(segs.length, 5); assert.ok(segs.every(s => s.layer === 'A-WALL'));
  const poly = '0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n8\nWALLS\n90\n4\n70\n1\n10\n0\n20\n0\n10\n4\n20\n0\n10\n4\n20\n3\n10\n0\n20\n3\n0\nENDSEC\n0\nEOF\n';
  const ps = CI.dxfSegments(DP.parse(poly)); assert.equal(ps.length, 4, 'замкнутая полилиния — 4 отрезка');
  assert.equal(CI.dxfSegments(DP.parse(dxfText(lines)), { skipLayers: false }).length, 7);
});

test('DXF: совпадающий проект в мм — единицы найдены, 95 % точек ближе 20 мм', () => {
  const { uv, lines } = sliceUV();
  const c = CI.compareDxf(CI.dxfSegments(DP.parse(dxfText(lines))), uv, { align: 'none' });
  assert.ok(c.ok, c.message); assert.equal(c.units, 'mm');
  assert.ok(c.within > 0.95, 'within ' + c.within); assert.ok(c.median < 5, 'медиана ' + c.median);
  assert.equal(c.shifted, 0); assert.equal(c.missing, 0);
  for (const x of c.lines) assert.equal(UI.lineStatus(x, c.tol), 'совпадает');
});

test('DXF: проект повёрнут на 7° и сдвинут — совмещение по облаку находит поворот, сдвинутая на 50 мм стена видна', () => {
  const { uv, lines } = sliceUV();
  const segs = CI.dxfSegments(DP.parse(dxfText(lines, { rot: 7, tx: 3200, ty: -1700, moved: 4 })));
  const c = CI.compareDxf(segs, uv, {});
  assert.ok(c.ok, c.message);
  near(((c.transform.rot % 90) + 90) % 90, 83, 0.05, 'поворот, по модулю 90°');
  const sh = c.lines.map((x, i) => [i, x]).filter(([, x]) => UI.lineStatus(x, c.tol) === 'смещена');
  assert.deepEqual(sh.map(([i]) => i), [4], 'смещена только перегородка');
  near(Math.abs(sh[0][1].offset), 50, 3, 'смещение, мм');
  assert.ok(c.within > 0.75, 'остальные стены совпадают: ' + c.within);
});

test('DXF: линия, которой нет в облаке, и направление стен облака', () => {
  const { uv, lines } = sliceUV();
  const extra = lines.concat([[[2, 2], [4, 2]]]);
  const c = CI.compareDxf(CI.dxfSegments(DP.parse(dxfText(extra))), uv, { align: 'none' });
  assert.equal(c.missing, 1); assert.equal(UI.lineStatus(c.lines[5], c.tol), 'нет в облаке');
  const a = 23 * Math.PI / 180, R = new Float32Array(uv.length);
  for (let i = 0; i < uv.length; i += 2) { R[i] = Math.cos(a) * uv[i] - Math.sin(a) * uv[i + 1]; R[i + 1] = Math.sin(a) * uv[i] + Math.cos(a) * uv[i + 1]; }
  near(CI.cloudDir(R, R.length >> 1) * 180 / Math.PI, 23, 0.15, 'направление стен облака');
  assert.equal(CI.compareDxf([], uv, {}).ok, false);
});

// синтетическое здание (ревизия 27): два помещения 6 × 6 и 3,88 × 6 м, повёрнуто на 17°, шум 3 мм
let BLD = null;
function building() {
  if (BLD) return BLD;
  const b = G.building({ step: 0.03, theta: 17, noise: 0.003 }), file = path.join(TMP, 'b.las'); G.writeLas(file, b.pts);
  const d = Seg.openSegmentSource(file).desc, ov = OV.overview(d, {});
  BLD = { b, file, d, ov, fl: ov.levels[0].h };
  return BLD;
}

test('eachPoint: проход по LAS с высотами и рамкой отдаёт ровно те точки, что попали в фильтр', () => {
  const { d, fl } = building();
  let all = 0, inside = 0; const rect = { u0: -2, u1: 2, v0: -2, v1: 2 };
  const r1 = OV.eachPoint(d, { h0: fl - 0.1, h1: fl + 3 }, () => { all++; });
  assert.ok(r1.ok); assert.equal(r1.used, all); assert.equal(r1.read, d.count || r1.read);
  const r2 = OV.eachPoint(d, { h0: fl + 1, h1: fl + 1.5, rect }, (u, v, h) => {
    inside++; assert.ok(u >= rect.u0 && u <= rect.u1 && v >= rect.v0 && v <= rect.v1 && h >= fl + 1 && h <= fl + 1.5);
  });
  assert.ok(r2.ok && inside > 0 && inside < all && r2.used === inside);
  assert.equal(OV.eachPoint(d, { h0: 2, h1: 1 }, () => {}).ok, false, 'пустой диапазон высот');
});

test('задание inspect на синтетическом LAS: план, пол и стены за два прохода', () => {
  const { d, fl } = building();
  const steps = [];
  const r = JOB.run({ desc: d, opts: { h0: fl + 1.1, h1: fl + 1.3, floor: fl, top: fl + 2.6, plan: {}, tol: { floorRail: 4, wallRail: 3, plumbPerM: 2, plumbMax: 10 } } }, (p, l) => steps.push([p, l]));
  assert.ok(r.ok, r.message);
  assert.ok(r.plan.ok && r.plan.rooms.length >= 2, 'помещения');
  assert.ok(steps.length > 3 && steps[steps.length - 1][0] === 1, 'прогресс до 100 %');
  assert.ok(steps.every((s, i) => !i || s[0] >= steps[i - 1][0]), 'прогресс не убывает');
  const f = r.floor; assert.ok(f.ok, 'пол');
  near(f.area, 59.3, 4, 'площадь пола, м²');
  assert.ok(f.plane.mmPerM < 0.5, 'уклон ' + f.plane.mmPerM);
  // ровная плита со сканерным шумом 3 мм: FF ограничен шумом, поправка на шум его поднимает
  assert.ok(f.F.FF > 0.6 * f.FFnoise && f.F.FFcorr > f.F.FF && f.F.FFcorr > 25, 'FF ' + f.F.FF + ' / ' + f.F.FFcorr + ' / ' + f.FFnoise);
  assert.ok(f.F.FL > 50, 'FL ' + f.F.FL);
  assert.ok(f.rooms.length >= 2, 'пол по помещениям');
  assert.ok(f.grid && f.grid.flag.length === f.grid.nx * f.grid.ny && f.maps.plane.length === f.grid.nx * f.grid.ny, 'сетка для карты');
  const w = r.walls; assert.ok(w.ok && w.checked >= 6, 'стены: ' + (w && w.checked));
  const plumbs = w.walls.map(x => x.plumb).sort((a, b) => a - b);
  assert.ok(plumbs[plumbs.length >> 1] < 1, 'вертикальные стены: медиана ' + plumbs[plumbs.length >> 1]);
  assert.ok(r.corners.length >= 4 && r.corners.filter(k => k.dev < 0.5).length >= 4, 'прямые углы');
  assert.ok(r.slice.preview instanceof Float32Array && r.slice.preview.length > 1000);
  assert.ok(r.points.used > 0 && r.points.used <= r.points.read);
  // результат передаётся из потока без копирования больших массивов
  const tl = JOB.transferList(r); assert.ok(Array.isArray(tl) && tl.length >= 2 && tl.every(b => b instanceof ArrayBuffer));
  assert.equal(new Set(tl).size, tl.length, 'буферы без повторов');
  // проверка только пола — стены не считаются
  const r2 = JOB.run({ desc: d, opts: { h0: fl + 1.1, h1: fl + 1.3, floor: fl, top: fl + 2.6, doWalls: false } }, () => {});
  assert.ok(r2.ok && r2.floor && r2.floor.ok && !r2.walls);
  assert.equal(JOB.run({ desc: d, opts: { h0: fl + 1.1, h1: fl + 1.3, floor: fl, top: fl + 0.2 } }, () => {}).ok, false, 'верх ниже пола + 0,5 м');
});

test('окно контроля: классы отделки, палитры, шкала и класс пола по FF', () => {
  const P = UI.presets();
  assert.deepEqual([P.high.plumbPerM, P.high.plumbMax, P.high.wallRail], [1, 5, 2]);
  assert.deepEqual([P.improved.plumbPerM, P.improved.plumbMax, P.improved.wallRail], [2, 10, 3]);
  assert.deepEqual([P.simple.plumbPerM, P.simple.plumbMax, P.simple.wallRail], [3, 15, 5]);
  assert.deepEqual(UI.diverging(-5, 5), [33, 102, 172]); assert.deepEqual(UI.diverging(5, 5), [178, 24, 43]); assert.deepEqual(UI.diverging(0, 5), [247, 247, 247]);
  assert.equal(UI.diverging(NaN, 5), null);
  assert.deepEqual(UI.sequential(0, 20), [34, 197, 94]); assert.deepEqual(UI.sequential(20, 20), [234, 179, 8]); assert.deepEqual(UI.sequential(100, 20), [220, 38, 38]);
  assert.equal(UI.limitOf([1, -1.5, 1.8, NaN]), 2); assert.equal(UI.limitOf([12, -3]), 15); assert.equal(UI.limitOf([]), 10); assert.equal(UI.limitOf([1000]), 300);
  assert.equal(UI.ffClass(18), 'ниже обычного'); assert.match(UI.ffClass(24.7), /FF20/); assert.match(UI.ffClass(40), /FF35/); assert.match(UI.ffClass(70), /FF60/); assert.equal(UI.ffClass(NaN), '—');
  assert.equal(UI.lineStatus({ length: 0.3, cover: 1, points: 100, offset: 0 }, 0.02), 'короткая');
  assert.equal(UI.lineStatus({ length: 2, cover: 0.1, points: 5, offset: 0 }, 0.02), 'нет в облаке');
  assert.equal(UI.lineStatus({ length: 2, cover: 1, points: 10, offset: 40 }, 0.02), 'совпадает', 'мало точек — смещение не утверждаем');
  assert.equal(UI.lineStatus({ length: 2, cover: 1, points: 100, offset: -40 }, 0.02), 'смещена');
});

test('окно контроля: вывод и CSV для Excel по результату задания', () => {
  const { d, fl } = building();
  const r = JOB.run({ desc: d, opts: { h0: fl + 1.1, h1: fl + 1.3, floor: fl, top: fl + 2.6 } }, () => {});
  const v = UI.verdict(r);
  assert.equal(v.length, 2); assert.match(v[0], /^Пол: FF \d+,\d \/ FL \d+,\d — /); assert.match(v[1], /^Стены: проверено \d+, в допуске \d+, вне допуска \d+/);
  const { uv, lines } = sliceUV(), cmp = CI.compareDxf(CI.dxfSegments(DP.parse(dxfText(lines))), uv, { align: 'none' });
  const t = UI.csv(r, cmp);
  assert.equal(t.charCodeAt(0), 0xfeff, 'BOM для Excel'); assert.ok(t.includes('\r\n'));
  const L = t.slice(1).split('\r\n');
  assert.equal(L[0], 'Пол'); assert.match(L[2], /^\d+,\d;\d+,\d;\d,\d\d;/, 'десятичная запятая, разделитель «;»');
  const wh = L.findIndex(x => x.startsWith('Стена;')); assert.ok(wh > 0);
  assert.equal(L[wh].split(';').length, L[wh + 1].split(';').length, 'строка стены — по столбцам заголовка');
  assert.ok(L.some(x => x.startsWith('Угол;'))); assert.ok(L.some(x => x.startsWith('Линия проекта;')));
  assert.equal(L.filter(x => /^\d+;"A-WALL";/.test(x)).length, 5);
});

test('PDF «Контроль геометрии»: разделы, вывод, только встроенные картинки, без скриптов и внешних ссылок', () => {
  const { d, fl } = building();
  const r = JOB.run({ desc: d, opts: { h0: fl + 1.1, h1: fl + 1.3, floor: fl, top: fl + 2.6, tol: { floorRail: 4, wallRail: 3, plumbPerM: 2, plumbMax: 10 } } }, () => {});
  const { uv, lines } = sliceUV(), cmp = CI.compareDxf(CI.dxfSegments(DP.parse(dxfText(lines, { moved: 4 }))), uv, { align: 'none' });
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const html = REP.inspect({ fileName: 'склад<1>.las', project: 'Склад', res: r, cmp, dxfName: 'план.dxf', verdict: UI.verdict(r), cls: 'Улучшенная', appVersion: '1.2.0-rc.3',
    maps: [{ title: 'Пол', src: png }, { title: 'чужая', src: 'https://example.com/a.png' }, { title: 'скрипт', src: 'javascript:alert(1)' }],
    dev: [{ n: 1, lim: 5, src: png, w: r.walls.walls[0] }] });
  for (const h of ['Контроль геометрии по облаку точек', 'Параметры проверки', 'Карты отклонений', '<h2 class="pb">Пол</h2>', 'По помещениям', '<h2 class="pb">Стены</h2>', 'Развёртки граней вне допуска', 'Углы между стенами', 'Облако против проекта — план.dxf', 'класс «улучшенная»'])
    assert.ok(html.includes(h), 'раздел: ' + h);
  assert.ok(html.includes('склад&lt;1&gt;.las'), 'имя файла экранировано');
  assert.equal((html.match(/<img /g) || []).length, 2, 'только две встроенные картинки');
  assert.ok(!/<script|https?:\/\/|javascript:/i.test(html), 'без скриптов и внешних ссылок');
  assert.ok(html.includes('class="bad"'), 'строки вне допуска выделены');
  assert.match(html, /смещено 1/);
  const empty = REP.inspect({}); assert.ok(empty.startsWith('<!doctype html>') && empty.includes('не заменяет инструментальный контроль'));
  assert.equal(typeof REP.build, 'function', 'обычный отчёт по облаку на месте');
});

test('проводка: IPC, preload, поток, сборка, лента, кнопка в окне облака и порядок скриптов', () => {
  const main = read('main.js'), pre = read('preload.js'), wk = read('cloud-overview-worker.js'), pkg = JSON.parse(read('package.json'));
  assert.match(main, /ipcMain\.handle\('bim:cloudInspect'/); assert.match(main, /ipcMain\.handle\('bim:pickDxfText'/);
  assert.match(main, /runOverviewWorker\('inspect'/);
  assert.match(pre, /cloudInspect: \(payload\) => inv\('bim:cloudInspect'/); assert.match(pre, /pickDxfText: \(\) => inv\('bim:pickDxfText'/);
  assert.match(wk, /d\.job === 'inspect'/); assert.match(wk, /require\('\.\/cloud-inspect-job'\)/);
  assert.ok(pkg.build.files.includes('cloud-inspect-job.js'));
  for (const f of ['cloud-inspect-job.js', 'renderer/cloud-inspect.js']) assert.ok(pkg.build.asarUnpack.includes(f), 'asarUnpack: ' + f);
  const C = require(path.join(ROOT, 'renderer', 'ui', 'commands.js'));
  const it = C.byId.cpInspect; assert.ok(it, 'команда «Контроль геометрии»');
  assert.equal(it.tab, 'qa'); assert.equal(it.call, 'CloudPreview.inspect'); assert.equal(it.needs, 'cloud');
  const icons = read('renderer/icons.js'); assert.ok(icons.includes('"' + it.ico + '"'), 'иконка есть в наборе: ' + it.ico);
  const cp = read('renderer/cloud-preview.js');
  assert.match(cp, /data-act="inspect"/); assert.match(cp, /W\.CloudInspectUI\.open\(path, ov, st\)/); assert.match(cp, /inspect: async function/);
  const html = read('renderer/index.html'), at = (s) => html.indexOf(s);
  for (const s of ['cloud-inspect.js?v=1331', 'cloud-inspect-ui.js?v=1331', 'cloud-preview.js?v=1331', 'cloud-report.js?v=1331', 'ui/cloud-tools.css?v=1331']) assert.ok(at(s) > 0, s);
  assert.ok(at('dxfparse.js?v=') < at('cloud-inspect.js?v=') && at('auto-plan.js?v=') < at('cloud-inspect.js?v='));
  assert.ok(at('cloud-inspect.js?v=') < at('cloud-inspect-ui.js?v=') && at('cloud-inspect-ui.js?v=') < at('cloud-preview.js?v='));
  const css = read('renderer/ui/cloud-tools.css'); for (const c of ['.ins-card', '.ins-tab', '.ins-devscale', '.ins-verdict']) assert.ok(css.includes(c), 'стиль ' + c);
  // без эмодзи в новых модулях; иконки окна — только из набора
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  for (const f of ['renderer/cloud-inspect.js', 'renderer/cloud-inspect-ui.js', 'cloud-inspect-job.js', 'renderer/cloud-report.js']) assert.ok(!emoji.test(read(f)), 'эмодзи в ' + f);
  const ui = read('renderer/cloud-inspect-ui.js');
  for (const m of ui.matchAll(/ic\('([a-z0-9-]+)'/g)) assert.ok(icons.includes('"' + m[1] + '"'), 'иконка ' + m[1]);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });
