'use strict';
/* Ревизия 5 — вкладка «Измерения»: точность на синтетической сцене с известными размерами (труба Ø220, пол, стена), габариты плоскостей,
 * привязка к трубе, «Диаметр», отмена шага, CSV и ключевые места вьюера (лаг при наведении: кэш pick-буфера и статичной сцены).
 * Сцена небольшая (≈200 тыс. точек), тест укладывается в пару секунд. Большой аудит — dev/ui-lab/measure-audit.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PS = require('../renderer/precision-snap.js');
const M = require('../renderer/measure.js');
const R_ = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const VIEWER = R_('renderer', 'webgl-viewer.js');

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r) { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

const R = 0.11, CY = 1.4, CZ = 1.5, SP = 0.01, SG = 0.002;
let SCENE = null;
function scene() {
  if (SCENE) return SCENE;
  const r = rng(11), pts = [], nFloor = [];
  for (let x = 0; x <= 4; x += SP) for (let z = 0; z <= 3; z += SP) { pts.push([x + (r() - .5) * SP, gauss(r) * SG, z + (r() - .5) * SP]); }
  const floorN = pts.length;
  for (let y = 0; y <= 2.5; y += SP) for (let z = 0; z <= 3; z += SP) pts.push([gauss(r) * SG, y + (r() - .5) * SP, z + (r() - .5) * SP]);
  const arc = 200 * Math.PI / 180;
  for (let x = 0.5; x <= 3.5; x += SP) for (let a = -arc / 2; a <= arc / 2; a += SP / R) { const rr = R + gauss(r) * SG; pts.push([x + (r() - .5) * SP, CY + rr * Math.sin(a), CZ + rr * Math.cos(a)]); }
  const pos = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => { pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; });
  const index = PS.buildIndex(pos);
  const near = (w) => { let b = -1, bd = 1e30; for (let i = 0; i < pts.length; i++) { const d = (pts[i][0] - w[0]) ** 2 + (pts[i][1] - w[1]) ** 2 + (pts[i][2] - w[2]) ** 2; if (d < bd) { bd = d; b = i; } } return pts[b]; };
  const snapAt = (w, grow) => PS.snap(near(w), index, { snapDist: 0.1, radius: 0.35, grow: grow !== false, spacing: index.spacing });
  SCENE = { pts, pos, index, floorN, near, snapAt, nFloor };
  return SCENE;
}
const pipePt = (x, deg) => { const f = deg * Math.PI / 180; return [x, CY + R * Math.sin(f), CZ + R * Math.cos(f)]; };

test('труба: привязка находит цилиндр и радиус с ошибкой < 1 мм при любом месте клика на дуге', () => {
  const S = scene();
  for (const [deg, x] of [[90, 1.5], [-90, 2.2], [75, 1.2], [-75, 2.9], [0, 2], [45, 1.1], [-45, 3]]) {
    const s = S.snapAt(pipePt(x, deg));
    assert.equal(s.kind, 'curve', 'угол ' + deg + ': ожидалась труба, а не «' + s.kind + '»');
    assert.ok(Math.abs(s.cylinder.radius - R) < 0.001, 'угол ' + deg + ': радиус ' + s.cylinder.radius);
    assert.ok(Math.abs(Math.hypot(s.point[1] - CY, s.point[2] - CZ) - R) < 0.0015, 'точка привязки должна лежать на поверхности трубы');
  }
});

test('труба: два клика по краям/сверху и снизу дают диаметр 220 мм (раньше — на 7–16 мм больше)', () => {
  const S = scene();
  for (const [d, x1, x2] of [[90, 1.5, 2.2], [75, 1.2, 2.9], [70, 1.0, 3.2]]) {
    const a = S.snapAt(pipePt(x1, d)), b = S.snapAt(pipePt(x2, -d)), g = PS.pairGap(a, b);
    assert.ok(g && g.kind === 'pipe', 'ожидался вид «pipe», получено ' + (g && g.kind));
    assert.ok(g.diameterLike, 'противоположные стороны — это диаметр');
    assert.ok(Math.abs(g.value - 2 * R) < 0.0015, 'Ø ' + g.value);
    assert.equal(g.value, g.diameter);
  }
});

test('труба: точки в одной полуокружности — не диаметр (diameterLike=false)', () => {
  const S = scene(), g = PS.pairGap(S.snapAt(pipePt(1.5, 0)), S.snapAt(pipePt(1.5, 60)));
  assert.ok(g && g.kind === 'pipe' && !g.diameterLike, 'хорда не должна считаться диаметром');
});

test('adoptOnCylinder: сырая точка на той же трубе получает такой же результат «curve»; посторонняя — нет', () => {
  const S = scene(), a = S.snapAt(pipePt(1.5, 90));
  const raw = S.near(pipePt(2.2, -90)), ad = PS.adoptOnCylinder(a, raw);
  assert.ok(ad && ad.kind === 'curve' && ad.adopted, 'точка на трубе должна быть принята');
  const dc = [0, 1, 2].map(k => ad.point[k] - ad.cylinder.center[k]);
  assert.ok(Math.abs(Math.hypot(dc[0], dc[1], dc[2]) - a.cylinder.radius) < 1e-9 && Math.abs(dc[0] * a.cylinder.axis[0] + dc[1] * a.cylinder.axis[1] + dc[2] * a.cylinder.axis[2]) < 1e-9, 'принятая точка лежит на поверхности того же цилиндра, перпендикулярно оси');
  assert.ok(Math.abs(Math.hypot(ad.point[1] - CY, ad.point[2] - CZ) - R) < 0.0015, 'и на настоящей трубе');
  const g = PS.pairGap(a, ad);
  assert.ok(g && g.kind === 'pipe' && g.diameterLike && Math.abs(g.value - 2 * a.cylinder.radius) < 1e-9, 'обе точки по одной подгонке: Ø = 2R');
  assert.equal(PS.adoptOnCylinder(a, [2, CY - R - 0.03, CZ]), null, '3 см снаружи трубы — это не труба');
  assert.equal(PS.adoptOnCylinder({ kind: 'plane' }, raw), null);
  assert.equal(PS.adoptOnCylinder(null, raw), null);
});

test('pipeGap: параллельные трубы разных осей → «pipes» (между осями и зазор), непараллельные → null', () => {
  const mk = (cy, cz, ax) => ({ kind: 'curve', point: [0, cy + R, cz], normal: [0, 1, 0], cylinder: { axis: ax, center: [0, cy, cz], radius: R, rms: 0.002, count: 900, sigma: 0.0008, tau: 0.01 } });
  const g = PS.pairGap(mk(1.0, 1.0, [1, 0, 0]), mk(1.0, 1.6, [1, 0, 0]));
  assert.equal(g.kind, 'pipes');
  assert.ok(Math.abs(g.value - 0.6) < 1e-9 && Math.abs(g.gap - (0.6 - 2 * R)) < 1e-9);
  assert.equal(PS.pairGap(mk(1.0, 1.0, [1, 0, 0]), mk(1.0, 1.6, [0, 0, 1])), null);
});

test('плоскость: рост по всей поверхности (keepIds) и габариты пола 4×3 м с точностью ≈1 см', () => {
  const S = scene(), sn = S.snapAt([2.0, 0, 1.0]);
  assert.equal(sn.kind, 'plane');
  const pl = sn.planes[0], view = Object.create(S.index);
  const g = PS.growPlane(view, pl, { foot: [2, 0, 1], r0: 6 * S.index.spacing, rmax: Infinity, cap: 2500000, passes: 4, siblings: [], keepIds: true });
  assert.ok(g && g.ids && g.ids.length > 0.9 * S.floorN, 'плоскость пола должна охватить весь пол, а не клочок: ' + (g && g.ids && g.ids.length) + ' из ' + S.floorN);
  const ids = PS.collectPlanePoints(view, g, [2, 0, 1], g.tau, 3000000, 6 * S.index.spacing, [], Infinity, true);
  const e = M.planeExtents({ pos: S.pos, ids }, Object.assign({ spacing: S.index.spacing }, g, { e1: M.planeBasis(g.normal)[0], e2: M.planeBasis(g.normal)[1] }));
  assert.ok(Math.abs(e.length - 4) < 0.02 && Math.abs(e.width - 3) < 0.02, 'габариты ' + e.length.toFixed(3) + '×' + e.width.toFixed(3));
});

function rectPoints(rot, hole, spur) {
  const r = rng(5), pts = [], c = Math.cos(rot), s = Math.sin(rot);
  for (let x = 0; x <= 6; x += 0.012) for (let z = 0; z <= 4; z += 0.012) {
    if (hole && x > 4.45 && x < 4.95 && z > 2.55 && z < 3.05) continue;
    pts.push([x * c - z * s + (r() - .5) * .002, (r() - .5) * .004, x * s + z * c]);
  }
  if (spur) for (let z = -0.2; z < 0; z += 0.012) pts.push([2 * c - z * s, 0, 2 * s + z * c]);   // «ус» шириной в одну точку — как полоса соседнего пола у кромки
  return pts;
}
function extOf(pts, extra) {
  const n = pts.length, cen = pts.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n, a[2] + p[2] / n], [0, 0, 0]), b = M.planeBasis([0, 1, 0]);
  return M.planeExtents(pts, Object.assign({ normal: [0, 1, 0], centroid: cen, e1: b[0], e2: b[1] }, extra || {}));
}
test('planeExtents: пол 6×4 с вырезом под колонну — габариты по кромкам, а не по осям инерции (раньше 6,04×4,06)', () => {
  for (const rot of [0, 0.3, 1.2]) {
    const e = extOf(rectPoints(rot, true, false), { spacing: 0.012 });
    assert.ok(Math.abs(e.length - 6) < 0.02 && Math.abs(e.width - 4) < 0.02, 'поворот ' + rot + ': ' + e.length.toFixed(3) + '×' + e.width.toFixed(3));
    assert.ok(e.size1 >= e.size2, 'ось 1 — длинная сторона');
  }
});
test('planeExtents: «ус» шириной в одну точку вдоль кромки не растягивает габарит', () => {
  const e = extOf(rectPoints(0, true, true), { spacing: 0.012 });
  assert.ok(e.width < 4.03, 'ширина ' + e.width.toFixed(3) + ' — «ус» должен быть отсечён');
});
test('planeExtents: без spacing и на малых наборах точек не падает и даёт разумный размер', () => {
  const pts = [[0, 0, 0], [1, 0, 0], [1, 0, 0.5], [0, 0, 0.5], [0.5, 0, 0.25]];
  const e = extOf(pts);
  assert.ok(Math.abs(e.length - 1) < 1e-6 && Math.abs(e.width - 0.5) < 1e-6);
  const e2 = extOf(rectPoints(0, false, false));
  assert.ok(Math.abs(e2.length - 6) < 0.02);
});

test('CSV и текст значения: у расстояния между плоскостями/рёбрами/на трубе заголовочное значение — ⊥ (как в окне), d3 — в деталях', () => {
  const r = { mode: 'distance', a: [0, 0, 0], b: [0, 2.8, 0.3], d3: 2.8161, dx: 0, dy: 2.8, dz: 0.3, horizontal: 0.3, vertical: 2.8, perp: 2.8, perpKind: 'planes' };
  const row = M.measureToCsvRow(r);
  assert.ok(/,distance,2\.8000,м,/.test(row), row);
  assert.ok(row.includes('d3=2.8161'), row);
  assert.ok(/⊥|пло/.test(M.measureValueText(r)));
  const p = { mode: 'distance', d3: 0.2201, perp: 0.22, perpKind: 'pipe', diameter: 0.22 };
  assert.ok(/,distance,0\.2200,м,/.test(M.measureToCsvRow(p)));
  assert.ok(M.measureValueText(p).startsWith('Ø'));
});
test('режим «Диаметр»: значение, CSV и масштабирование', () => {
  const d = { mode: 'diameter', diameter: 0.22, radius: 0.11, point: [0, 0, 0], center: [0, 0, 0], axis: [1, 0, 0], count: 900, rms: 0.002, arc: 200 };
  assert.ok(M.measureValueText(d).startsWith('Ø 220') || /Ø/.test(M.measureValueText(d)));
  assert.ok(/,diameter,0\.2200,м,/.test(M.measureToCsvRow(d)));
  const s = M.scaleMeasurement(d, 2);
  assert.ok(Math.abs(s.diameter - 0.44) < 1e-9 && Math.abs(s.radius - 0.22) < 1e-9);
});

test('вьюер: общий расчёт пары для клика и предпросмотра, «Диаметр», отмена шага, кэши против лага', () => {
  for (const needle of [
    '_pairPlacement(', '_distancePreviewAt(', '_smartDistancePreview(previewPt, gap, A0)', '_diameterClick(', 'undoMeasurePoint()', 'hasMeasureProgress()', 'cancelMeasure()', '_measKey',
    '_localPlaneAt(', '_fitPlaneRansacAt(', '_deviationClick(', '_cornerClick(', '_cornerSummary(', "mode === 'diameter'",
    '_sceneCacheUsable', '_renderCached', 'renderOverlay()', '_yQuantiles()', '_psPump', 'adoptOnCylinder'
  ]) assert.ok(VIEWER.includes(needle), 'во вьюере нет ' + needle);
  assert.ok(/pickCacheOff/.test(VIEWER) && /_pickStat/.test(VIEWER), 'кэш pick-буфера');
  assert.ok(!/cap\s*\|\|\s*60000\)\s*;\s*\n\s*const\s+r\s*=\s*this\._sceneDiag\(\)\s*\*\s*0\.05/.test(VIEWER), 'плоскость не должна браться шаром 5 % диагонали сцены');
});

test('интерфейс: кнопка «Диаметр» есть в разметке, реестре команд и ленте; иконка существует', () => {
  const html = R_('renderer', 'index.html'), cmds = R_('renderer', 'ui', 'commands.js'), ribbon = R_('renderer', 'ui', 'ribbon.js'), icons = R_('renderer', 'icons.js');
  assert.ok(/id="mmDiameter"[^>]*data-mm="diameter"/.test(html));
  assert.ok(cmds.includes('mmDiameter') && ribbon.includes("'diameter'"));
  assert.ok(/"diameter":\s*"<circle/.test(icons));
  assert.ok(!/<[a-z][^>]*\sstyle=/i.test(html), 'inline style= в index.html запрещён');
});

test('защита от потери данных: неготовый замер не сохраняется, «Очистить всё» требует повторного нажатия, угол без сторон не падает', () => {
  const APP = R_('renderer', 'app.js');
  const i = APP.indexOf('function saveMeasurement()');
  assert.ok(i > 0);
  const body = APP.slice(i, i + 900);
  assert.ok(/res\.mode === 'deviation' && res\.signed === undefined/.test(body) && /res\.mode === 'corner' && !\(res\.planeCount >= 2\)/.test(body), 'saveMeasurement: неготовые замеры');
  assert.ok(/bind\('mlClearAll'[\s\S]{0,260}clearArm/.test(APP), 'mlClearAll: повторное нажатие');
  const a = M.angleAt([0, 0, 0], [0, 0, 0], [1, 0, 0]);
  assert.equal(a.deg, 0);
  assert.ok(Number.isFinite(a.lenA) && Number.isFinite(a.lenC));
});
