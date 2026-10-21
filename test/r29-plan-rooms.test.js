'use strict';
// Ревизия 29: план по срезу — коридоры с недоснятыми торцами и щелями замыкаются в помещения, стены дальних (редких) комнат
// и стены под небольшим углом находятся, мебель и стеллажи у стен (нет точек во втором, верхнем срезе) уходят из плана в слой A-FURN.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const AP = require(path.join(__dirname, '..', 'renderer', 'auto-plan.js'));

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
// срез: точки на отрезках-гранях, плотность — точек на метр, шум 3 мм поперёк
function slice(lines, seed) {
  const r = rng(seed || 5), out = [];
  for (const L of lines) {
    const [x0, y0, x1, y1, dens] = L, len = Math.hypot(x1 - x0, y1 - y0), n = Math.round(len * (dens || 400));
    const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
    for (let i = 0; i < n; i++) { const t = r(), e = gauss(r) * 0.003; out.push(x0 + (x1 - x0) * t + nx * e, y0 + (y1 - y0) * t + ny * e); }
  }
  return new Float32Array(out);
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ': ' + a + ' ≠ ' + b + ' ± ' + tol);
const byArea = (p) => p.rooms.slice().sort((a, b) => b.area - a.area);

// Коридор 2,4 × 16 м между комнатами; у западного торца — щель 1,8 м в углу, восточный торец закрыт; у комнаты R2 (глубже соседних
// на 0,2 м) недоснят северо-западный угол: щель 1,8 м по диагонали между концами граней, соосного продолжения нет — проём не
// находится. Прежний поиск отдавал такие области «наружу».
function corridorScene() {
  const L = [];
  const H = (x0, x1, y) => L.push([x0, y, x1, y]), V = (x, y0, y1) => L.push([x, y0, x, y1]);
  // северная стена коридора (сторона коридора y=2.4, сторона комнат y=2.52) с дверями 0,9 м
  [[0, 1.5], [2.4, 6.5], [7.4, 11.5], [12.4, 16]].forEach(([a, b]) => { H(a, b, 2.4); H(a, b, 2.52); });
  // южная стена коридора (y=0 и y=-0.12) с дверями
  [[0, 3], [3.9, 10], [10.9, 16]].forEach(([a, b]) => { H(a, b, 0); H(a, b, -0.12); });
  // торцы: западный — только низ 0…0,6 м (щель 1,8 м до угла), восточный — целиком
  V(0, 0, 0.6); V(16, 0, 2.4);
  // комнаты к северу: R1 x 0..5, R3 x 10.12..16 — y 2.52..7; R2 x 5.12..10 — y 2.52..7.2
  V(0, 2.52, 7); H(0, 5, 7); V(5, 2.52, 7); V(5.12, 2.52, 5.8); H(6.3, 10, 7.2); V(10, 2.52, 7.2); V(10.12, 2.52, 7); H(10.12, 16, 7); V(16, 2.52, 7);
  // комнаты к югу: S1 x 0..8, S2 x 8.12..16, y -4.12..-0.12
  V(0, -4.12, -0.12); H(0, 8, -4.12); V(8, -4.12, -0.12); V(8.12, -4.12, -0.12); H(8.12, 16, -4.12); V(16, -4.12, -0.12);
  return slice(L, 11);
}

test('коридор с недоснятым торцом и комната со щелью в углу замыкаются в помещения', () => {
  const p = AP.extract(corridorScene(), {});
  assert.equal(p.ok, true);
  const R = byArea(p);
  const cor = R.filter(r => r.kind === 'corridor');
  assert.equal(cor.length, 1, 'один коридор: ' + R.map(r => r.name + ' ' + r.area.toFixed(2)).join(', '));
  assert.equal(cor[0].name, 'Коридор 1');
  near(cor[0].area, 2.4 * 16, 1.2, 'площадь коридора');
  assert.ok(cor[0].typWidth > 2.0 && cor[0].typWidth < 2.8, 'типичная ширина коридора ' + cor[0].typWidth);
  const rooms = R.filter(r => r.kind === 'room').map(r => r.area).sort((a, b) => b - a);
  assert.equal(rooms.length, 5, 'пять комнат: ' + rooms.join(' '));
  near(rooms[0], 8 * 4, 0.3, 'S1'); near(rooms[1], 7.88 * 4, 0.3, 'S2');
  near(rooms[2], 5.88 * 4.48, 0.3, 'R3'); near(rooms[3], 4.88 * 4.68, 0.5, 'R2 со щелью в углу'); near(rooms[4], 5 * 4.48, 0.3, 'R1');
  // R2 замкнута на крупном масштабе и отмечена как открытая наружу (условная граница по щели)
  const r2 = R.find(r => r.kind === 'room' && Math.abs(r.area - 4.88 * 4.68) < 0.2);
  assert.ok(r2.scale >= 0.4 && r2.outside === true, 'R2: масштаб ' + r2.scale + ', наружу ' + r2.outside);
  assert.equal(p.stats.corridors, 1);
  // имена помещений — «Пом. N» по убыванию площади, у коридоров своя нумерация
  assert.deepStrictEqual(R.filter(r => r.kind === 'room').map(r => r.name), ['Пом. 1', 'Пом. 2', 'Пом. 3', 'Пом. 4', 'Пом. 5']);
  // центр подписи — внутри своего помещения (самая удалённая от стен точка)
  const c = cor[0].center; assert.ok(c[0] > 0 && c[0] < 16 && c[1] > 0 && c[1] < 2.4, 'подпись коридора внутри: ' + c);
});

test('масштабы закрытия щелей: без крупных масштабов комната со щелью уходит наружу', () => {
  const p = AP.extract(corridorScene(), { scales: [0] });
  assert.equal(p.rooms.length, 5, 'только замкнутые без щелей: ' + p.rooms.map(r => r.area.toFixed(2)).join(' '));
  assert.ok(!p.rooms.some(r => Math.abs(r.area - 4.88 * 4.68) < 0.2), 'R2 ушла наружу');
});

test('стены дальней комнаты в 20 раз реже стен у сканера находятся (местный порог)', () => {
  const L = [];
  // A — плотная (1200 т/м), B — редкая (60 т/м), общая стена x=6 (плотная со стороны A, редкая со стороны B)
  [[0, 0, 6, 0], [6, 0, 6, 5], [6, 5, 0, 5], [0, 5, 0, 0]].forEach(s => L.push(s.concat(1200)));
  [[6.12, 0, 11, 0], [11, 0, 11, 5], [11, 5, 6.12, 5], [6.12, 5, 6.12, 0]].forEach(s => L.push(s.concat(60)));
  const uv = slice(L, 3);
  const p = AP.extract(uv, {});
  const longB = p.faces.filter(f => Math.min(f.a[0], f.b[0]) > 6.05 && f.length > 4.5);
  assert.ok(longB.length >= 4, 'грани редкой комнаты: ' + p.faces.map(f => f.length.toFixed(2)).join(' '));
  const areas = p.rooms.map(r => r.area).sort((a, b) => b - a);
  near(areas[0], 30, 0.2, 'A'); near(areas[1], 4.88 * 5, 0.3, 'B');
  // без местного порога редкие стены теряются
  const p0 = AP.extract(uv, { localThr: false });
  assert.ok(p0.faces.filter(f => Math.min(f.a[0], f.b[0]) > 6.05 && f.length > 4.5).length < 4, 'общий порог теряет редкие стены');
});

test('стена под углом 0,5° к остальным — одна грань по своему углу', () => {
  const a = 0.5 * Math.PI / 180, L = [];
  [[0, 0, 10, 0], [10, 0, 10, 8], [0, 8, 0, 0]].forEach(s => L.push(s.concat(500)));
  // северная стена 10 м под углом 0,5° (уход 8,7 см за длину) + ещё одна комната для устойчивого направления
  L.push([0, 8, 10, 8 + 10 * Math.tan(a), 500]);
  [[10.12, 0, 16, 0], [16, 0, 16, 8], [16, 8, 10.12, 8], [10.12, 8, 10.12, 0]].forEach(s => L.push(s.concat(500)));
  const p = AP.extract(slice(L, 9), {});
  const top = p.faces.filter(f => f.length > 9 && Math.abs((f.a[1] + f.b[1]) / 2 - (8 + 5 * Math.tan(a))) < 0.05);
  assert.equal(top.length, 1, 'грань найдена целиком: ' + p.faces.map(f => f.length.toFixed(2)).join(' '));
  near(top[0].length, 10, 0.05, 'длина наклонной грани');
  const ang = Math.atan2(top[0].b[1] - top[0].a[1], top[0].b[0] - top[0].a[0]) * 180 / Math.PI, d = Math.abs(((ang % 180) + 180) % 180);
  near(Math.min(d, 180 - d), 0.5, 0.05, 'угол грани');
});

// Комната 6 × 5 м, стена с дверью толщиной 0,3 м (откосы 0,3 м), стеллаж 3 × 0,4 м у северной стены высотой 1,8 м.
function shelfScene() {
  const low = [], high = [], both = (s) => { low.push(s); high.push(s); };
  both([0, 0, 2, 0]); both([2.9, 0, 6, 0]); both([0, -0.3, 2, -0.3]); both([2.9, -0.3, 6, -0.3]);
  both([6, 0, 6, 5]); both([6, 5, 0, 5]); both([0, 5, 0, 0]);
  both([6, -0.3, 6, 0]); both([0, -0.3, 0, 0]);
  // откосы двери — только в нижнем срезе (над дверью их нет)
  low.push([2, -0.3, 2, 0]); low.push([2.9, -0.3, 2.9, 0]);
  // стеллаж: фасад и боковины — только нижний срез
  low.push([1.5, 4.5, 4.5, 4.5]); low.push([1.5, 4.5, 1.5, 4.95]); low.push([4.5, 4.5, 4.5, 4.95]);
  return { low: slice(low, 21), high: slice(high, 22) };
}

test('стеллаж у стены ниже 2 м уходит из плана (второй срез), откосы двери остаются, помещение — целиком', () => {
  const s = shelfScene();
  const p0 = AP.extract(s.low, {});
  const p = AP.extract(s.low, { uvHigh: s.high });
  assert.ok(p.stats.lowCheck && p.stats.lowCheck.checked, 'проверка верхним срезом выполнена');
  assert.ok(p.low.length >= 1 && p.stats.low === p.low.length, 'низкие грани');
  const front = p.low.find(f => f.length > 2.8 && Math.abs(f.a[1] - 4.5) < 0.02);
  assert.ok(front, 'фасад стеллажа в low: ' + p.low.map(f => f.length.toFixed(2)).join(' '));
  assert.ok(!p.faces.some(f => f.length > 2.8 && Math.abs(f.a[1] - 4.5) < 0.02), 'фасада нет среди стен');
  const jambs = p.faces.filter(f => Math.abs(f.length - 0.3) < 0.03 && Math.abs(f.a[0] - f.b[0]) < 0.01);
  assert.equal(jambs.length, 2, 'откосы двери остались стенами');
  const a0 = byArea(p0)[0].area, a1 = byArea(p)[0].area;
  near(a1, 30, 0.2, 'помещение целиком');
  assert.ok(a0 < 29.5, 'без верхнего среза стеллаж отрезает часть помещения: ' + a0);
  // DXF: стеллаж — в слое A-FURN, не в A-WALL
  const dxf = AP.toDXF(p, { units: 'mm' });
  const cnt = (layer) => (dxf.match(new RegExp('\\nLINE\\n8\\n' + layer + '\\n', 'g')) || []).length;
  assert.equal(cnt('A-FURN'), p.low.length);
  assert.equal(cnt('A-WALL'), p.faces.length);
  assert.match(dxf, /\nLAYER\n2\nA-FURN\n70\n0\n62\n8\n/, 'слой A-FURN серый');
});

test('верхний срез без точек на стенах (выше потолка) — проверка не применяется', () => {
  const s = shelfScene();
  const far = new Float32Array(2000); for (let i = 0; i < 1000; i++) { far[i * 2] = 100 + (i % 10); far[i * 2 + 1] = 100 + i * 0.01; }
  const p = AP.extract(s.low, { uvHigh: far });
  assert.equal(p.stats.lowCheck.checked, false);
  assert.equal(p.low.length, 0);
});

// Сквозной путь: LAS со стеллажом у стены → planSlice с верхней полосой (тот же проход по файлу) → поток плана (как в приложении)
test('LAS: верхний срез читается тем же проходом, поток плана убирает стеллаж в A-FURN', async () => {
  const fs = require('fs'), os = require('os');
  const { Worker } = require('worker_threads');
  const G = require('./r27-synthetic.helper.js');
  const Seg = require(path.join(__dirname, '..', 'cloud-segments.js'));
  const OV = require(path.join(__dirname, '..', 'cloud-overview.js'));
  const b = G.building({ step: 0.02, theta: 0, noise: 0.003, seed: 29 });
  // стеллаж 3 × 0,4 × 1,8 м у северной стены помещения A (y = 6): фасад y = 5,6 и боковины
  const r = rng(77), add = (x0, y0, x1, y1) => {
    const L = Math.hypot(x1 - x0, y1 - y0);
    for (let t = 0; t < L; t += 0.02) for (let z = 0; z < 1.8; z += 0.02) b.pts.push([500000 + b.tx + x0 + (x1 - x0) * (t + r() * 0.01) / L + gauss(r) * 0.002, 4000000 + b.ty + y0 + (y1 - y0) * (t + r() * 0.01) / L + gauss(r) * 0.002, 100 + z]);
  };
  add(1.5, 5.6, 4.5, 5.6); add(1.5, 5.6, 1.5, 6); add(4.5, 5.6, 4.5, 6);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-r29-')), file = path.join(dir, 'shelf.las');
  G.writeLas(file, b.pts);
  const d = Seg.openSegmentSource(file).desc, ov = OV.overview(d, { samples: 4e6 }), fl = ov.levels[0].h;
  const sl = OV.planSlice(d, { h0: fl + 1.15, h1: fl + 1.25, high: { h0: fl + 2.3, h1: fl + 2.4 } });
  assert.ok(sl.countHigh > 1000 && sl.uvHigh.length === sl.countHigh * 2 && sl.hi0 === fl + 2.3, 'верхний срез: ' + sl.countHigh);
  // без верхнего среза стеллаж — «стена», помещение A меньше на его глубину
  const pa = (p) => byArea(p)[0].area;
  const p0 = AP.extract(sl.uv, {});
  assert.ok(pa(p0) < 35, 'без второго среза: ' + pa(p0));
  const res = await new Promise((ok, bad) => {
    const w = new Worker(path.join(__dirname, '..', 'cloud-overview-worker.js'), { workerData: { job: 'plan', desc: d, opts: { h0: fl + 1.15, h1: fl + 1.25, high: { h0: fl + 2.3, h1: fl + 2.4 }, plan: {} } } });
    w.on('message', (m) => { if (m.type === 'result') { ok(m.result); w.terminate(); } });
    w.on('error', bad);
  });
  assert.equal(res.ok, true, res.message);
  assert.ok(res.slice.high && res.slice.high.count === sl.countHigh, 'сводка верхнего среза');
  const p = res.plan;
  assert.ok(p.stats.lowCheck.checked, 'проверка выполнена');
  assert.ok(p.low.some(f => Math.abs(f.length - 3) < 0.05 && Math.abs(f.a[1] - f.b[1]) < 0.02), 'фасад стеллажа (3 м, координаты от центра облака) в low: ' + p.low.map(f => f.length.toFixed(2)).join(' '));
  near(pa(p), 36, 0.3, 'помещение A целиком');
  near(byArea(p)[1].area, 3.88 * 6, 0.3, 'помещение B');
  const dxf = AP.toDXF(p, {});
  assert.ok(/\nLINE\n8\nA-FURN\n/.test(dxf), 'слой A-FURN в DXF');
  fs.rmSync(dir, { recursive: true, force: true });
});
