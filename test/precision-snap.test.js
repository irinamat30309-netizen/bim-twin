'use strict';
/* Точный захват (renderer/precision-snap.js): угол, ребро, плоскость, расстояния между плоскостями и рёбрами.
 * Комната собрана из плоскостей с шумом лазера (σ = 3 мм) и шагом сетки 2 см; точные размеры известны, поэтому
 * ошибка захвата считается прямо: сравнением с настоящим углом/стеной/проёмом, а не с эталонной точкой облака. */
const test = require('node:test');
const assert = require('node:assert/strict');
const PS = require('../renderer/precision-snap.js');

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r) { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

const OPT = { W: 2.4, H: 2.6, L: 3.6, sp: 0.02, sigma: 0.003, z0: 1.2, z1: 2.1, hd: 2.05, T: 0.3, scale: 1 };
function makeRoom(seed, o) {
  const opt = Object.assign({}, OPT, o || {}), r = rng(seed), pts = [];
  const { W, H, L, z0, z1, hd, T, sp, sigma } = opt;
  function rect(org, u, v, lu, lv, n, skip) {
    for (let a = 0; a < lu; a += sp) for (let b = 0; b < lv; b += sp) {
      const aa = a + (r() - 0.5) * sp * 0.9, bb = b + (r() - 0.5) * sp * 0.9;
      if (aa < 0 || bb < 0 || aa > lu || bb > lv) continue;
      const g = gauss(r) * sigma;
      const p = [0, 1, 2].map(k => org[k] + u[k] * aa + v[k] * bb + n[k] * g);
      if (skip && skip(p)) continue;
      pts.push(p);
    }
  }
  const inDoor = p => p[2] > z0 && p[2] < z1 && p[1] < hd;
  rect([0, 0, 0], [1, 0, 0], [0, 0, 1], W, L, [0, 1, 0]);
  rect([0, H, 0], [1, 0, 0], [0, 0, 1], W, L, [0, -1, 0]);
  rect([0, 0, 0], [0, 1, 0], [0, 0, 1], H, L, [1, 0, 0]);
  rect([0, 0, 0], [1, 0, 0], [0, 1, 0], W, H, [0, 0, 1]);
  rect([0, 0, L], [1, 0, 0], [0, 1, 0], W, H, [0, 0, -1]);
  rect([W, 0, 0], [0, 1, 0], [0, 0, 1], H, L, [-1, 0, 0], inDoor);
  rect([W, 0, z0], [1, 0, 0], [0, 1, 0], T, hd, [0, 0, 1]);
  rect([W, 0, z1], [1, 0, 0], [0, 1, 0], T, hd, [0, 0, -1]);
  rect([W, hd, z0], [1, 0, 0], [0, 0, 1], T, z1 - z0, [0, -1, 0]);
  const k = opt.scale, pos = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => { pos[i * 3] = p[0] * k; pos[i * 3 + 1] = p[1] * k; pos[i * 3 + 2] = p[2] * k; });
  return { pos, opt, index: PS.buildIndex(pos) };
}
function nearestTo(rm, t) {
  const ni = rm.index.nearest(t[0], t[1], t[2], 0.06 * rm.opt.scale);
  return ni < 0 ? null : [rm.index.pos[ni * 3], rm.index.pos[ni * 3 + 1], rm.index.pos[ni * 3 + 2]];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mm = v => (v * 1000).toFixed(2) + ' мм';

const ROOM = makeRoom(11);

test('индекс: шаг облака оценён верно, запрос по радиусу совпадает с полным перебором', () => {
  const idx = ROOM.index;
  assert.ok(idx.spacing > 0.012 && idx.spacing < 0.03, 'spacing ' + idx.spacing);
  const c = [1.1, 1.3, 1.7], ids = idx.query(c[0], c[1], c[2], 0.15, 0), P = ROOM.pos;
  let brute = 0;
  for (let i = 0; i < P.length / 3; i++) if (Math.hypot(P[i * 3] - c[0], P[i * 3 + 1] - c[1], P[i * 3 + 2] - c[2]) <= 0.15) brute++;
  assert.equal(ids.length, brute);
});

test('угол комнаты: клик рядом с углом даёт точный угол (пересечение трёх плоскостей)', () => {
  const rnd = rng(3), errs = [];
  for (let k = 0; k < 12; k++) {
    const seed = nearestTo(ROOM, [rnd() * 0.02, rnd() * 0.02, rnd() * 0.02]); if (!seed) continue;
    const s = PS.snap(seed, ROOM.index, { snapDist: 0.06, grow: true });
    assert.equal(s.kind, 'corner', 'ожидали угол, получили ' + s.kind);
    errs.push(dist(s.point, [0, 0, 0]));
    assert.equal(s.planes.length, 3);
  }
  assert.ok(errs.length >= 8);
  assert.ok(Math.max.apply(null, errs) < 0.0012, 'угол: максимум ' + mm(Math.max.apply(null, errs)));
});

test('угол без роста плоскостей всё равно точнее клика по шумной точке', () => {
  const rnd = rng(5), local = [], raw = [];
  for (let k = 0; k < 12; k++) {
    const seed = nearestTo(ROOM, [rnd() * 0.02, rnd() * 0.02, rnd() * 0.02]); if (!seed) continue;
    const s = PS.snap(seed, ROOM.index, { snapDist: 0.06 });
    assert.ok(s.kind === 'corner' || s.kind === 'edge');
    raw.push(dist(seed, [0, 0, 0]));
    if (s.kind === 'corner') local.push(dist(s.point, [0, 0, 0]));
  }
  const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
  assert.ok(local.length >= 4);
  assert.ok(med(local) < 0.5 * med(raw), 'по плоскостям ' + mm(med(local)) + ' против клика ' + mm(med(raw)));
});

test('ребро: точка ложится на линию стыка пол/стена, направление вдоль ребра', () => {
  const rnd = rng(7);
  for (let k = 0; k < 10; k++) {
    const z = 0.8 + rnd() * 2, seed = nearestTo(ROOM, [rnd() * 0.02, rnd() * 0.02, z]); if (!seed) continue;
    const s = PS.snap(seed, ROOM.index, { snapDist: 0.06, grow: true });
    assert.equal(s.kind, 'edge');
    assert.ok(Math.hypot(s.point[0], s.point[1]) < 0.0008, 'ребро ' + mm(Math.hypot(s.point[0], s.point[1])));
    assert.ok(Math.abs(s.dir[2]) > 0.9995, 'направление ребра');
    assert.ok(Math.abs(s.point[2] - seed[2]) < 0.03, 'вдоль ребра точка остаётся у курсора');
  }
});

test('плоскость: середина стены — проекция на вписанную плоскость, а не случайная точка', () => {
  const rnd = rng(9);
  for (let k = 0; k < 10; k++) {
    const seed = nearestTo(ROOM, [0, 0.6 + rnd() * 1.4, 0.6 + rnd() * 2.4]); if (!seed) continue;
    const s = PS.snap(seed, ROOM.index, { snapDist: 0.03, grow: true });
    assert.equal(s.kind, 'plane');
    assert.ok(Math.abs(s.point[0]) < 0.0006, 'плоскость ' + mm(Math.abs(s.point[0])));
    assert.ok(s.count > 3000, 'стена вписана по всей поверхности: ' + s.count);
    assert.equal(s.quality, 'high');
    assert.ok(s.rms > 0.002 && s.rms < 0.004, 'шум ' + s.rms);
  }
});

test('одинаковый результат при любом клике рядом: разброс углов меньше 0,3 мм', () => {
  const rnd = rng(13), pts = [];
  for (let k = 0; k < 10; k++) {
    const seed = nearestTo(ROOM, [ROOM.opt.W - rnd() * 0.02, ROOM.opt.H - rnd() * 0.02, rnd() * 0.02]); if (!seed) continue;
    const s = PS.snap(seed, ROOM.index, { snapDist: 0.06, grow: true });
    if (s.kind === 'corner') pts.push(s.point);
  }
  assert.ok(pts.length >= 4);
  const c = pts[0]; let worst = 0; pts.forEach(p => { worst = Math.max(worst, dist(p, c)); });
  assert.ok(worst < 0.0003, 'разброс ' + mm(worst));
});

test('стена–стена и пол–потолок: расстояние по нормали, а не по клику «на глаз»', () => {
  const rnd = rng(17), { W, H } = ROOM.opt;
  for (let k = 0; k < 8; k++) {
    const a = nearestTo(ROOM, [0, 0.4 + rnd() * 1.2, 0.3 + rnd() * 0.8]), b = nearestTo(ROOM, [W, 0.3 + rnd() * 1.4, 2.3 + rnd() * 1.2]);
    const g = PS.pairGap(PS.snap(a, ROOM.index, { snapDist: 0.03, grow: true }), PS.snap(b, ROOM.index, { snapDist: 0.03, grow: true }));
    assert.equal(g.kind, 'planes');
    assert.ok(Math.abs(g.value - W) < 0.0006, 'ширина ' + mm(Math.abs(g.value - W)));
    const c = nearestTo(ROOM, [0.3 + rnd() * 1.8, 0, 0.3 + rnd() * 1.2]), d = nearestTo(ROOM, [0.3 + rnd() * 1.8, H, 2.4 + rnd() * 1.1]);
    const h = PS.pairGap(PS.snap(c, ROOM.index, { snapDist: 0.03, grow: true }), PS.snap(d, ROOM.index, { snapDist: 0.03, grow: true }));
    assert.equal(h.kind, 'planes');
    assert.ok(Math.abs(h.value - H) < 0.0006, 'высота ' + mm(Math.abs(h.value - H)));
    // заявленная погрешность включает запас на неровность стены (0,08·rms² на плоскость): при шуме 3 мм это около 1 мм на пару, при реальных 1–1,5 мм — 0,3–0,6 мм
    assert.ok(g.uncertainty >= 0.0002 && g.uncertainty < 0.002, 'погрешность пары ' + mm(g.uncertainty));
    assert.ok(Math.abs(g.value - W) <= 2 * g.uncertainty, 'ошибка внутри заявленных ±2σ');
  }
});

test('слабый угол: третья плоскость из нескольких десятков точек помечается «low» и получает большую погрешность', () => {
  function corner(lu, lv) {
    const r = rng(5), pts = [], sp = 0.02, sg = 0.003;
    const add = (org, u, v, a1, b1, n) => { for (let a = 0; a < a1; a += sp) for (let b = 0; b < b1; b += sp) {
      const aa = a + (r() - 0.5) * sp * 0.9, bb = b + (r() - 0.5) * sp * 0.9; if (aa < 0 || bb < 0 || aa > a1 || bb > b1) continue;
      const g = gauss(r) * sg; pts.push([0, 1, 2].map(k => org[k] + u[k] * aa + v[k] * bb + n[k] * g)); } };
    add([0, 0, 0], [1, 0, 0], [0, 0, 1], 2.4, 3.6, [0, 1, 0]);      // пол
    add([0, 0, 0], [0, 1, 0], [0, 0, 1], 2.6, 3.6, [1, 0, 0]);      // стена
    add([0, 0, 0], [1, 0, 0], [0, 1, 0], lu, lv, [0, 0, 1]);        // торец: маленькая плоскость
    const pos = new Float32Array(pts.length * 3); pts.forEach((p, i) => { pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; });
    const index = PS.buildIndex(pos), ni = index.nearest(0.01, 0.01, 0.01, 0.06);
    return PS.snap([pos[ni * 3], pos[ni * 3 + 1], pos[ni * 3 + 2]], index, { snapDist: 0.06, grow: true });
  }
  const weak = corner(0.3, 0.3), strong = corner(0.6, 0.6);
  assert.equal(weak.kind, 'corner'); assert.equal(strong.kind, 'corner');
  assert.ok(weak.count < 64, 'опора третьей плоскости: ' + weak.count);
  assert.equal(weak.weak, true); assert.equal(weak.quality, 'low');
  assert.ok(weak.sigma > 0.03, 'слабый угол: ±' + mm(weak.sigma));
  assert.ok(!strong.weak && strong.quality === 'high', 'полноценный угол: ' + strong.quality);
  assert.ok(strong.sigma < weak.sigma / 2, 'полноценный ±' + mm(strong.sigma) + ' против слабого ±' + mm(weak.sigma));
});

test('проём: ширина между откосами измеряется по двум рёбрам с точностью около 0,5 мм', () => {
  const rnd = rng(19), { W, z0, z1 } = ROOM.opt;
  for (let k = 0; k < 6; k++) {
    const y = 0.7 + rnd() * 0.8, a = nearestTo(ROOM, [W - rnd() * 0.02, y, z0 - rnd() * 0.02]), b = nearestTo(ROOM, [W - rnd() * 0.02, y + 0.1, z1 + rnd() * 0.02]);
    const sa = PS.snap(a, ROOM.index, { snapDist: 0.05, grow: true }), sb = PS.snap(b, ROOM.index, { snapDist: 0.05, grow: true });
    assert.equal(sa.kind, 'edge'); assert.equal(sb.kind, 'edge');
    const g = PS.pairGap(sa, sb);
    assert.equal(g.kind, 'edges');
    assert.ok(Math.abs(g.value - (z1 - z0)) < 0.0007, 'проём ' + mm(Math.abs(g.value - (z1 - z0))));
  }
});

test('детерминизм: одинаковый клик — побитово одинаковый результат', () => {
  const seed = nearestTo(ROOM, [0.01, 0.01, 0.01]);
  const a = PS.snap(seed, ROOM.index, { snapDist: 0.06, grow: true }), b = PS.snap(seed, ROOM.index, { snapDist: 0.06, grow: true });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('масштаб не важен: та же комната в миллиметрах даёт ту же относительную точность', () => {
  const mmRoom = makeRoom(11, { scale: 1000 });
  const seed = nearestTo(mmRoom, [10, 10, 10]);
  const s = PS.snap(seed, mmRoom.index, { snapDist: 60, grow: true });
  assert.equal(s.kind, 'corner');
  assert.ok(dist(s.point, [0, 0, 0]) < 1.2, 'угол в мм: ' + dist(s.point, [0, 0, 0]));
});

test('ровная стена не превращается в ребро; пустое место возвращает точку клика', () => {
  const seed = nearestTo(ROOM, [0, 1.3, 1.8]);
  const s = PS.snap(seed, ROOM.index, { snapDist: 0.03 });
  assert.equal(s.kind, 'plane');
  const far = PS.snap([9, 9, 9], ROOM.index, { snapDist: 0.05 });
  assert.equal(far.kind, 'raw'); assert.deepEqual(far.point, [9, 9, 9]);
  const empty = PS.snap([0, 0, 0], PS.buildIndex(new Float32Array(0)), {});
  assert.equal(empty.kind, 'raw');
  const few = PS.snap([0, 0, 0], PS.buildIndex(new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0])), {});
  assert.ok(few.kind === 'point' || few.kind === 'raw');
});

test('быстро: захват без роста укладывается в кадр, с ростом — в доли секунды', () => {
  const seed = nearestTo(ROOM, [0.01, 0.01, 0.01]);
  let t = process.hrtime.bigint();
  for (let k = 0; k < 5; k++) PS.snap(seed, ROOM.index, { snapDist: 0.06 });
  const local = Number(process.hrtime.bigint() - t) / 1e6 / 5;
  t = process.hrtime.bigint();
  PS.snap(seed, ROOM.index, { snapDist: 0.06, grow: true });
  const grown = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(local < 60, 'без роста ' + local.toFixed(1) + ' мс');
  assert.ok(grown < 800, 'с ростом ' + grown.toFixed(1) + ' мс');
});

/* ---------- Кромка проёма без откосов (стена с дырой) ---------- */
/* Проём в плоской стене без откосов: ни ребра из двух плоскостей, ни угла нет — есть только конец набора точек плоскости.
 * Точность здесь ниже (по плотности точек), поэтому допуски в тестах — миллиметры, а не доли миллиметра. */
function makeWallWithHole(seed, o) {
  const opt = Object.assign({ sp: 0.013, sigma: 0.002, z0: 2.5, z1: 3.5, hd: 2.1, poisson: false }, o || {}), r = rng(seed), pts = [];
  const { sp, sigma, z0, z1, hd } = opt, hole = (y, z) => z > z0 && z < z1 && y < hd;
  if (opt.poisson) {
    for (let q = 0, N = Math.round(18 / (sp * sp)); q < N; q++) { const y = r() * 3, z = r() * 6; if (!hole(y, z)) pts.push([gauss(r) * sigma, y, z]); }
  } else {
    for (let a = 0; a < 3; a += sp) for (let b = 0; b < 6; b += sp) {
      const y = a + (r() - 0.5) * sp * 0.9, z = b + (r() - 0.5) * sp * 0.9;
      if (y < 0 || z < 0 || y > 3 || z > 6 || hole(y, z)) continue;
      pts.push([gauss(r) * sigma, y, z]);
    }
  }
  for (let a = 0; a < 3; a += sp * 1.2) for (let b = 0; b < 6; b += sp * 1.2) pts.push([-a + (r() - 0.5) * sp, gauss(r) * sigma, b + (r() - 0.5) * sp]);   // пол (x < 0)
  const pos = new Float32Array(pts.length * 3); pts.forEach((p, i) => { pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; });
  return { pos, opt, index: PS.buildIndex(pos) };
}
const HOLE = makeWallWithHole(7);
const nearestW = (rm, t) => { const i = rm.index.nearest(t[0], t[1], t[2], 0.06); return i < 0 ? null : [rm.index.pos[i * 3], rm.index.pos[i * 3 + 1], rm.index.pos[i * 3 + 2]]; };

test('кромка проёма без откосов: клик у края даёт линию края, а не точку на стене', () => {
  const rnd = rng(3), errL = [], errT = [], dirs = [];
  for (let k = 0; k < 14; k++) {
    const a = nearestW(HOLE, [0, 0.8 + rnd() * 0.8, 2.5 + (rnd() - 0.5) * 0.03]);
    const b = nearestW(HOLE, [0, 2.1 + (rnd() - 0.5) * 0.03, 2.8 + rnd() * 0.4]);
    const sa = PS.snap(a, HOLE.index, { snapDist: 0.033, grow: true }), sb = PS.snap(b, HOLE.index, { snapDist: 0.033, grow: true });
    assert.equal(sa.kind, 'edge'); assert.equal(sa.contour, true, 'вертикальная кромка: контур');
    assert.equal(sb.kind, 'edge'); assert.equal(sb.contour, true, 'горизонтальная кромка: контур');
    errL.push(sa.point[2] - 2.5); errT.push(sb.point[1] - 2.1);
    dirs.push(Math.abs(sa.dir[1]), Math.abs(sb.dir[2]));
    assert.ok(sa.sigma > 0.0008 && sa.sigma < 0.012, 'σ кромки ' + mm(sa.sigma));
    assert.notEqual(sa.quality, 'high', 'кромка по плотности точек не может быть «высокого» качества');
  }
  const med = a => a.map(Math.abs).sort((x, y) => x - y)[a.length >> 1];
  assert.ok(med(errL) < 0.002 && Math.max.apply(null, errL.map(Math.abs)) < 0.004, 'левая кромка: медиана ' + mm(med(errL)));
  assert.ok(med(errT) < 0.002 && Math.max.apply(null, errT.map(Math.abs)) < 0.004, 'верх проёма: медиана ' + mm(med(errT)));
  assert.ok(Math.min.apply(null, dirs) > 0.99, 'направление вдоль кромки');
});

test('кромка проёма: ширина по двум кромкам и высота «кромка — пол» совпадают с настоящими размерами', () => {
  const rnd = rng(9), wErr = [], hErr = [], floorSeed = nearestW(HOLE, [-1.2, 0, 1.0]);
  const fl = PS.snap(floorSeed, HOLE.index, { snapDist: 0.033, grow: true });
  assert.equal(fl.kind, 'plane');
  for (let k = 0; k < 10; k++) {
    const a = nearestW(HOLE, [0, 0.8 + rnd() * 0.8, 2.5 + (rnd() - 0.5) * 0.03]), b = nearestW(HOLE, [0, 0.9 + rnd() * 0.8, 3.5 + (rnd() - 0.5) * 0.03]);
    const t = nearestW(HOLE, [0, 2.1 + (rnd() - 0.5) * 0.03, 2.8 + rnd() * 0.4]);
    const sa = PS.snap(a, HOLE.index, { snapDist: 0.033, grow: true }), sb = PS.snap(b, HOLE.index, { snapDist: 0.033, grow: true }), st = PS.snap(t, HOLE.index, { snapDist: 0.033, grow: true });
    const w = PS.pairGap(sa, sb), h = PS.pairGap(st, fl);
    assert.equal(w.kind, 'edges'); assert.equal(h.kind, 'point-plane');
    wErr.push(Math.abs(w.value - 1.0)); hErr.push(Math.abs(h.value - 2.1));
    assert.ok(w.uncertainty > 0.001 && w.uncertainty < 0.02, 'погрешность ширины ' + mm(w.uncertainty));
  }
  assert.ok(Math.max.apply(null, wErr) < 0.005, 'ширина проёма: максимум ' + mm(Math.max.apply(null, wErr)));
  assert.ok(Math.max.apply(null, hErr) < 0.004, 'высота проёма: максимум ' + mm(Math.max.apply(null, hErr)));
});

test('кромка проёма: случайное (не сеточное) расположение точек тоже даёт край в пределах 4 мм', () => {
  const pr = makeWallWithHole(5, { poisson: true, sp: 0.011 }), rnd = rng(21), errs = [];
  for (let k = 0; k < 12; k++) {
    const a = nearestW(pr, [0, 0.8 + rnd() * 0.8, 3.5 + (rnd() - 0.5) * 0.03]);
    const s = PS.snap(a, pr.index, { snapDist: 0.033, grow: true });
    if (s.kind === 'edge' && s.contour) errs.push(Math.abs(s.point[2] - 3.5));
  }
  assert.ok(errs.length >= 8, 'кромку нашли в ' + errs.length + ' из 12');
  assert.ok(Math.max.apply(null, errs) < 0.004, 'максимум ' + mm(Math.max.apply(null, errs)));
});

test('кромку проёма можно отключить; сплошная стена кромкой не считается', () => {
  const a = nearestW(HOLE, [0, 1.2, 2.5]);
  const off = PS.snap(a, HOLE.index, { snapDist: 0.033, grow: true, contour: false });
  assert.notEqual(off.contour, true); assert.equal(off.kind, 'plane');
  const mid = nearestW(HOLE, [0, 1.2, 1.0]);
  const s = PS.snap(mid, HOLE.index, { snapDist: 0.033, grow: true });
  assert.equal(s.kind, 'plane'); assert.notEqual(s.contour, true);
  const hi = nearestW(HOLE, [0, 2.8, 3.0]);   // над проёмом — сплошная стена
  const t = PS.snap(hi, HOLE.index, { snapDist: 0.033, grow: true });
  assert.equal(t.kind, 'plane'); assert.notEqual(t.contour, true);
});

test('подсказка у курсора: слабый угол подписан «оценка грубая», а не выдан за точный', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'webgl-viewer.js'), 'utf8');
  assert.match(src, /kind === 'corner'\) l2 = snap\.weak \? '3 плоскости · оценка грубая' : '3 плоскости'/);
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'ui', 'viewers.css'), 'utf8');
  assert.match(css, /\.meas-snap-tip\.q-low span:last-child \{ color: var\(--err\)/);
});
