'use strict';
// Ревизия 27: карта площадки до загрузки (обзор, уровни, траектория, маска маршрута), фильтр частей и
// автоматический обмерный план (AutoPlan) на синтетическом здании с известными размерами.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const G = require('./r27-synthetic.helper.js');
const Seg = require(path.join(ROOT, 'cloud-segments.js'));
const OV = require(path.join(ROOT, 'cloud-overview.js'));
const AP = require(path.join(ROOT, 'renderer', 'auto-plan.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-r27-'));
const cache = new Map();
function scene(step, theta) {
  const key = step + '/' + theta;
  if (cache.has(key)) return cache.get(key);
  const b = G.building({ step, theta, noise: 0.003 });
  const file = path.join(TMP, 'b-' + String(step).replace('.', '_') + '-' + theta + '.las');
  G.writeLas(file, b.pts);
  const d = Seg.openSegmentSource(file).desc;
  const ov = OV.overview(d, { samples: 4e6 });
  const fl = ov.levels[0].h;
  const sl = OV.planSlice(d, { h0: fl + 1.15, h1: fl + 1.25 });
  const plan = AP.extract(sl.uv, {});
  const out = { b, file, d, ov, sl, plan };
  cache.set(key, out);
  return out;
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ': ' + a + ' ≠ ' + b + ' ± ' + tol);
const sorted = (arr) => arr.slice().sort((x, y) => y - x);

test('обзор: число точек, уровни пола и потолка, площадь застройки, плотность', () => {
  const s = scene(0.015, 17), ov = s.ov;
  assert.equal(ov.ok, true);
  assert.equal(ov.file.points, s.b.pts.length);
  assert.ok(ov.levels.length >= 2, 'найдены пол и потолок');
  const hs = ov.levels.map(l => l.h).sort((a, b) => a - b);
  near(hs[hs.length - 1] - hs[0], 2.80, 0.01, 'высота помещения');
  // два помещения 6×6 и 3,88×6 + стены: застройка ≈ 60 м²
  near(ov.stats.footprint, 60.1, 1.5, 'площадь застройки');
  near(ov.stats.spacing, 0.015, 0.004, 'шаг точек');
  assert.ok(ov.grid.nx > 10 && ov.grid.ny > 10, 'сетка карты');
  assert.ok(ov.pts instanceof Float32Array && ov.pts.length % 3 === 0, 'выборка для оценки');
});

test('траектория: длина маршрута, доля внутри облака, маска «около маршрута»', () => {
  const s = scene(0.015, 17);
  const text = 'timestamp,x,y,z,qx,qy,qz,qw\n' + s.b.poses.map(p => p.concat([0, 0, 0, 1]).join(',')).join('\n');
  const tr = OV.trajectoryInfo(text, s.ov.origin, s.ov.bbox);
  near(tr.length, 4 + 1.45 + 3 + 2.55 + 5 + Math.hypot(2, 4), 0.1, 'длина маршрута');
  assert.ok(tr.inside > 0.95, 'маршрут внутри облака');
  assert.equal(tr.aligned, true);
  const m = OV.routeMask(tr.route, s.ov.bbox, { radius: 1 });
  assert.ok(m.cells > 0 && m.cells < m.nx * m.ny, 'маска покрывает часть площади');
  // точка маршрута в маске, угол площадки (далеко от маршрута) — нет
  const on = (u, v) => { const cx = Math.floor((u - m.u0) / m.cell), cy = Math.floor((v - m.v0) / m.cell); return !!m.bits[cy * m.nx + cx]; };
  assert.equal(on(tr.route[0], tr.route[1]), true);
  assert.equal(on(s.ov.bbox.u0 + 0.05, s.ov.bbox.v0 + 0.05), false);
  // участок маршрута: первая половина по времени
  const half = OV.routeMask(tr.route, s.ov.bbox, { radius: 1, from: 0, to: 0.5 });
  assert.ok(half.cells < m.cells, 'участок меньше всего маршрута');
});

test('filterSegment: область, высоты, маска и доля точек на кирпич', () => {
  const n = 20000, pos = new Float32Array(n * 3), col = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { const u = (i % 200) / 10, v = Math.floor(i / 200) / 10; pos[i * 3] = u; pos[i * 3 + 1] = (i % 7) * 0.5; pos[i * 3 + 2] = -v; col[i * 3] = i & 255; }
  const res = { ok: true, count: n, chunkPoints: 1000, pos, col };
  const r1 = Seg.filterSegment(res, { rect: { u0: 0, u1: 9.95, v0: 0, v1: 9.95 } });
  assert.equal(r1.count, 100 * 100, 'рамка 10×10 м');
  const r2 = Seg.filterSegment(res, { h: { min: 1, max: 2 } });
  for (let i = 0; i < r2.count; i++) assert.ok(r2.pos[i * 3 + 1] >= 1 && r2.pos[i * 3 + 1] <= 2);
  const r3 = Seg.filterSegment(res, { ratio: 0.25 });
  near(r3.count, n * 0.25, n * 0.01, 'доля 25 %');
  assert.equal(r3.col.length, r3.count * 3, 'цвет следует за точками');
  // одиночная точка вдали от остальных — шум
  const pn = new Float32Array((n + 1) * 3); pn.set(pos); pn[n * 3] = 500; pn[n * 3 + 1] = 500; pn[n * 3 + 2] = -500;
  const r4 = Seg.filterSegment({ ok: true, count: n + 1, chunkPoints: 1000, pos: pn }, { noise: { voxel: 0.15, min: 2 } });
  assert.ok(r4.count < n + 1, 'одиночная точка удалена');
  for (let i = 0; i < r4.count; i++) assert.ok(r4.pos[i * 3] < 100);
});

for (const theta of [0, 17]) {
  test('автоплан (шаг 1,5 см, поворот ' + theta + '°): грани, проёмы, толщины, помещения', () => {
    const { plan } = scene(0.015, theta);
    assert.equal(plan.ok, true);
    // направления стен — по повороту здания
    const dirs = plan.directions.map(d => ((d % 90) + 90) % 90);
    assert.ok(dirs.some(d => Math.min(Math.abs(d - theta), 90 - Math.abs(d - theta)) < 0.05), 'направление ' + plan.directions.join(', '));
    const L = sorted(plan.faces.map(f => f.length));
    near(L[0], 10.0, 0.005, 'северная грань 10 м');
    const sixes = L.filter(x => Math.abs(x - 6) < 0.05);
    assert.ok(sixes.length >= 2, 'грани 6 м: ' + L.join(' '));
    sixes.forEach(x => near(x, 6.0, 0.005, 'грань 6 м'));
    const ops = sorted(plan.openings.map(o => o.width));
    assert.equal(ops.length, 3, 'окно и дверь с двух сторон перегородки');
    near(ops[0], 1.50, 0.01, 'окно');
    near(ops[1], 0.90, 0.015, 'дверь'); near(ops[2], 0.90, 0.015, 'дверь');
    assert.ok(plan.walls.length >= 1);
    plan.walls.forEach(w => near(w.thickness, 0.12, 0.003, 'толщина перегородки'));
    const rooms = plan.rooms.map(r => r.area).sort((a, b) => b - a);
    assert.equal(rooms.length, 2);
    near(rooms[0], 36.0, 0.05, 'помещение 6×6');
    near(rooms[1], 23.28, 0.05, 'помещение 3,88×6');
  });
}

test('план в DXF R12: секции, слои, стены, проёмы, размеры и площади', () => {
  const { plan } = scene(0.015, 17);
  const dxf = AP.toDXF(plan, { units: 'mm' });
  const L = dxf.split(/\r?\n/);
  assert.equal(L[L.length - 1] === '' ? L[L.length - 2].trim() : L[L.length - 1].trim(), 'EOF');
  const count = {}, texts = [], dims = [];
  for (let i = 0; i < L.length - 1; i += 2) {
    if (L[i].trim() !== '0') continue;
    const ent = L[i + 1].trim(); let j = i + 2, layer = '', txt = '';
    while (j < L.length - 1 && L[j].trim() !== '0') { if (L[j].trim() === '8') layer = L[j + 1].trim(); if (L[j].trim() === '1') txt = L[j + 1]; j += 2; }
    count[ent + '@' + layer] = (count[ent + '@' + layer] || 0) + 1;
    if (txt && layer === 'A-ROOM') texts.push(txt);
    if (txt && layer === 'A-DIMS') dims.push(txt);
  }
  assert.equal(count['SECTION@'], count['ENDSEC@'], 'секции закрыты');
  assert.match(dxf, /\$ACADVER\s+1\s+AC1009/, 'формат R12');
  assert.equal(count['LINE@A-WALL'], plan.faces.length, 'грани стен');
  assert.equal(count['LINE@A-OPEN'], plan.openings.length, 'проёмы');
  assert.ok(count['LINE@A-DIMS'] > 20 && count['TEXT@A-DIMS'] >= plan.faces.length, 'размеры');
  assert.equal(count['TEXT@A-THK'], plan.walls.length, 'толщины');
  assert.ok(texts.some(t => /^36,0 /.test(t)) && texts.some(t => /^23,[23] /.test(t)), 'площади помещений: ' + texts.join(' | '));
  assert.ok(texts.some(t => t === '6000 x 6000'), 'размеры помещения в мм');
  // габариты вдоль осей здания (повёрнуто на 17°): 10 000 × 6 000 мм — грань и габарит дают по два одинаковых текста
  assert.ok(dims.filter(t => t === '10000').length >= 2 && dims.filter(t => t === '6000').length >= 3, 'габаритные размеры: ' + dims.join(' '));
});

test('редкое облако (шаг 3 см): план строится, ошибка проёмов не больше 3 см', () => {
  const b = G.building({ step: 0.03, theta: 17, noise: 0.003 });
  const file = path.join(TMP, 'sparse.las'); G.writeLas(file, b.pts);
  const d = Seg.openSegmentSource(file).desc, ov = OV.overview(d, {}), fl = ov.levels[0].h;
  const plan = AP.extract(OV.planSlice(d, { h0: fl + 1.1, h1: fl + 1.3 }).uv, {});
  const ops = sorted(plan.openings.map(o => o.width));
  assert.ok(ops.length >= 2, 'окно и дверь найдены');
  near(ops[0], 1.50, 0.03, 'окно');
  const rooms = plan.rooms.map(r => r.area).sort((a, b) => b - a);
  near(rooms[0], 36.0, 0.15, 'помещение 6×6');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });
