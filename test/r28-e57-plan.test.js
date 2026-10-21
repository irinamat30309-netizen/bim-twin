'use strict';
// Ревизия 28: карта до загрузки и план для E57, выбор окна при чтении E57, этажи по маршруту, размеры DIMENSION в DXF,
// несколько этажей в одном DXF, отсев мусорных граней, отчёт по этажам.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const G = require('./r27-synthetic.helper.js');
const Seg = require(path.join(ROOT, 'cloud-segments.js'));
const OV = require(path.join(ROOT, 'cloud-overview.js'));
const E57 = require(path.join(ROOT, 'e57-core.js'));
const Cloud = require(path.join(ROOT, 'las-node.js'));
const AP = require(path.join(ROOT, 'renderer', 'auto-plan.js'));
const CP = require(path.join(ROOT, 'renderer', 'cloud-preview.js'));
const CR = require(path.join(ROOT, 'renderer', 'cloud-report.js'));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-r28-'));
let SC = null;
function scene() {
  if (SC) return SC;
  const b = G.building({ step: 0.03, theta: 17, noise: 0.003 });
  // выбросы: 40 одиночных точек далеко от стен (шум)
  for (let i = 0; i < 40; i++) b.pts.push([500000 + 12.34 + 3 + i * 0.37, 4000000 - 5.67 + 3 + (i % 7) * 0.41, 100 + 1.0 + (i % 5) * 0.13]);
  const las = path.join(TMP, 'b.las'); G.writeLas(las, b.pts);
  const n = b.pts.length, pos = new Float64Array(n * 3), col = new Float32Array(n * 3), inten = new Float32Array(n);
  b.pts.forEach((p, i) => { pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; col[i * 3] = 0.6; col[i * 3 + 1] = 0.5; col[i * 3 + 2] = (p[2] - 100) / 3; inten[i] = 0.4; });
  const half = Math.floor(n / 2);
  const u8 = E57.write({ pos, col, intensity: inten, count: n, scans: [
    { name: 'Станция 1', start: 0, count: half, pose: { T: [500000 + 13, 4000000 - 4, 101.5], quaternion: { w: 1, x: 0, y: 0, z: 0 } } },
    { name: 'Станция 2', start: half, count: n - half, pose: { T: [500000 + 18, 4000000 - 2, 101.5], quaternion: { w: Math.cos(0.3), x: 0, y: 0, z: Math.sin(0.3) } } }] });
  const e57 = path.join(TMP, 'b.e57'); fs.writeFileSync(e57, u8);
  const dl = Seg.openSegmentSource(las).desc, ovL = OV.overview(dl, { samples: 4e6 });
  const de = OV.openE57(e57, fs.statSync(e57).size), ovE = OV.overview(Object.assign({}, de), { samples: 4e6 });
  Object.assign(de, { cx: ovE.origin.cx, cy: ovE.origin.cy, cz: ovE.origin.cz });
  SC = { b, n, las, e57, dl, ovL, de, ovE };
  return SC;
}

test('E57: заголовок без чтения точек, карта до загрузки, уровни как у LAS, станции сканов', () => {
  const s = scene();
  assert.equal(s.de.count, s.n, 'число точек — из XML E57');
  assert.equal(s.de.scans, 2);
  assert.ok(s.de.hasColor && s.de.hasIntensity);
  const ov = s.ovE;
  assert.ok(ov.ok, ov.message);
  assert.equal(ov.file.points, s.n);
  assert.match(ov.file.format, /^E57 \(2 скан\.\)$/);
  assert.equal(ov.origin.zup, true); assert.equal(ov.origin.hShift, 0);
  assert.ok(ov.grid.rgb && ov.grid.inten, 'цвет и интенсивность на карте');
  assert.equal(ov.stations.length, 2);
  assert.equal(ov.stations[0].name, 'Станция 1');
  assert.ok(Math.abs(ov.stations[0].u + ov.origin.cx - (500000 + 13)) < 1e-6, 'станция — в координатах карты');
  assert.ok(Math.abs(ov.stations[1].h + ov.origin.cz - 101.5) < 1e-6);
  // уровни (пол и потолок) — те же, что по LAS того же облака
  const hl = s.ovL.levels.map(l => l.h + s.dl.cz), he = ov.levels.map(l => l.h + ov.origin.cz);
  assert.ok(he.length >= 2);
  for (const h of hl) assert.ok(he.some(x => Math.abs(x - h) < 0.03), 'уровень ' + h);
  assert.ok(Math.abs(ov.stats.footprint - s.ovL.stats.footprint) / s.ovL.stats.footprint < 0.05, 'площадь застройки');
});

test('E57: срез плана и план (помещения, проёмы) совпадают с планом по LAS', () => {
  const s = scene();
  const fl = s.ovE.levels[0].h, slE = OV.planSlice(s.de, { h0: fl + 1.15, h1: fl + 1.25 });
  assert.ok(slE.ok && slE.count > 1000);
  const flL = s.ovL.levels[0].h, slL = OV.planSlice(s.dl, { h0: flL + 1.15, h1: flL + 1.25 });
  const pE = AP.extract(slE.uv, {}), pL = AP.extract(slL.uv, {});
  assert.ok(pE.ok && pL.ok);
  assert.equal(pE.rooms.length, pL.rooms.length);
  const aE = pE.rooms.map(r => r.area).sort((a, b) => a - b), aL = pL.rooms.map(r => r.area).sort((a, b) => a - b);
  aE.forEach((a, i) => assert.ok(Math.abs(a - aL[i]) < 0.15, 'площадь помещения ' + a + ' / ' + aL[i]));
  assert.equal(pE.openings.length, pL.openings.length);
  // без карты (нет начала координат) — понятный отказ
  const raw = OV.openE57(s.e57, fs.statSync(s.e57).size);
  assert.equal(OV.planSlice(raw, { h0: 1, h1: 1.1 }).ok, false);
});

test('E57: выбор окна «Перед загрузкой» применяется при чтении (область, высоты, участок маршрута, шум)', () => {
  const s = scene(), ov = s.ovE, o = { cx: s.de.cx, cy: s.de.cy, cz: s.de.cz };
  const all = Cloud.parseCloudFile(s.e57, { maxPoints: 5e6 });
  assert.ok(all.ok); assert.equal(all.count, s.n); assert.equal(all.meta.filtered, null);
  const rect = { u0: ov.bbox.core.u0, u1: (ov.bbox.core.u0 + ov.bbox.core.u1) / 2, v0: ov.bbox.core.v0, v1: ov.bbox.core.v1 };
  const r = Cloud.parseCloudFile(s.e57, { maxPoints: 5e6, filter: { rect, h: { min: 0.5, max: 2 }, origin: o } });
  assert.ok(r.ok, r.message);
  assert.ok(r.count > 1000 && r.count < s.n / 2);
  assert.deepEqual([r.meta.filtered.rect, r.meta.filtered.h, r.meta.filtered.route], [true, true, false]);
  const off = r.meta.offset;
  for (let i = 0; i < r.count; i++) {
    const u = r.pos[i * 3] + off.cx - o.cx, h = r.pos[i * 3 + 1] + off.mnz - o.cz, v = -r.pos[i * 3 + 2] + off.cy - o.cy;
    assert.ok(u >= rect.u0 - 1e-3 && u <= rect.u1 + 1e-3 && v >= rect.v0 - 1e-3 && v <= rect.v1 + 1e-3 && h >= 0.5 - 1e-3 && h <= 2 + 1e-3, 'точка ' + i);
  }
  assert.ok(r.col && r.intensity && r.intensity.length === r.count, 'цвет и интенсивность — у оставшихся точек');
  // шум: одиночные выбросы уходят, стены остаются
  const nz = Cloud.parseCloudFile(s.e57, { maxPoints: 5e6, filter: { noise: { voxel: 0.1, min: 3 }, origin: o } });
  assert.ok(nz.ok && s.n - nz.count >= 30 && s.n - nz.count < s.n * 0.03, 'убрано ' + (s.n - nz.count));
  // маршрут: маска клеток около первой половины пути
  const text = s.b.poses.map(p => p.join(',')).join('\n'), tr = OV.trajectoryInfo(text, ov.origin, ov.bbox);
  assert.ok(tr && tr.aligned);
  const mask = OV.routeMask(tr.route, ov.bbox, { radius: 1, from: 0, to: 0.3 });
  const rr = Cloud.parseCloudFile(s.e57, { maxPoints: 5e6, filter: { mask, origin: o } });
  assert.ok(rr.ok && rr.count > 100 && rr.count < s.n * 0.8);
  // filterKeep = отбор частей LAS (одинаковый результат на тех же координатах окна)
  const P = new Float32Array([0, 0, 0, 1, 1, -1, 5, 0, -5, 2, 3, 0]);
  const f = { rect: { u0: -0.5, u1: 3, v0: -0.5, v1: 2 }, h: { min: 0, max: 2 } };
  assert.deepEqual(Array.from(Seg.filterKeep(P, 4, f).keep), [1, 1, 0, 0]);
  const seg = Seg.filterSegment({ ok: true, count: 4, chunkPoints: 4, pos: P, col: new Uint8Array(12) }, f);
  assert.equal(seg.count, 2);
  // ничего не прошло — сообщение, а не пустое облако
  const none = Cloud.parseCloudFile(s.e57, { maxPoints: 5e6, filter: { h: { min: 50, max: 60 }, origin: o } });
  assert.equal(none.ok, false); assert.match(none.message, /ни одна точка/);
});

test('E57: связка окна, главного процесса и загрузки', () => {
  const main = read('main.js'), pre = read('preload.js'), app = read('renderer/app.js'), cp = read('renderer/cloud-preview.js'), wk = read('cloud-parse-worker.js'), ln = read('las-node.js');
  assert.match(main, /function openOverviewSource\(abs\)/);
  assert.equal((main.match(/openOverviewSource\(abs\)/g) || []).length, 3, 'карта и план — через общий вход');
  assert.match(main, /payload\.pre === true/);
  assert.match(main, /e57Filter\.origin = \{ cx: d\.cx, cy: d\.cy, cz: d\.cz \}/);
  assert.match(main, /filter: e57Filter/);
  assert.match(pre, /pre: true, filter: opts\.pre\.filter/);
  assert.match(app, /pre: preE57/);
  assert.match(app, /pre: mode\.pre \|\| null/);
  assert.match(cp, /\\\.\(las\|ply\|e57\)\$/);
  assert.match(wk, /filter: workerData\.filter/);
  assert.match(ln, /filter: opts\.filter \|\| null/);
});

test('Этажи: по маршруту сканера (реальный сценарий: шесть уровней, маршрут на высоте 3,18 м)', () => {
  // уровни реального скана (map.las): пол 1,703; антресоль, перекрытия, потолок 5,865
  const levels = [{ h: 1.703, area: 251 }, { h: 2.909, area: 40 }, { h: 3.906, area: 45 }, { h: 4.144, area: 50 }, { h: 4.966, area: 60 }, { h: 5.865, area: 106 }];
  const route = new Float32Array(400 * 4);
  for (let i = 0; i < 400; i++) { route[i * 4] = i * 0.1; route[i * 4 + 1] = 0; route[i * 4 + 2] = 3.18 + Math.sin(i) * 0.03; route[i * 4 + 3] = i / 399; }
  const st = CP.storeys(levels, { h1: 6.1, core: { h1: 6.0 } }, route);
  assert.equal(st.length, 1, 'одна отметка пола у маршрута');
  assert.ok(Math.abs(st[0].floor - 1.703) < 1e-6, 'пол — 1,703, а не верхнее перекрытие');
  assert.ok(Math.abs(st[0].ceiling - 5.865) < 1e-6);
  // два этажа по маршруту: часть пути на втором этаже
  const r2 = new Float32Array(800 * 4);
  for (let i = 0; i < 800; i++) { r2[i * 4 + 2] = i < 400 ? 1.3 : 4.5; r2[i * 4 + 3] = i / 799; }
  const st2 = CP.storeys([{ h: 0, area: 100 }, { h: 2.9, area: 90 }, { h: 3.2, area: 95 }, { h: 6.1, area: 80 }], { h1: 6.3 }, r2);
  assert.equal(st2.length, 2);
  assert.equal(st2[0].floor, 0); assert.equal(st2[1].floor, 3.2);
  // без маршрута — прежнее правило (перекрытие 2,8–3,1 — одно)
  assert.equal(CP.storeys([{ h: 0, area: 100 }, { h: 2.8, area: 90 }, { h: 3.1, area: 95 }, { h: 5.9, area: 80 }], { h1: 6.1 }).length, 2);
});

function dxfPairs(text) { const L = text.split(/\r?\n/), out = []; for (let i = 0; i + 1 < L.length; i += 2) out.push([L[i].trim(), L[i + 1]]); return out; }
test('DXF: размеры — объекты DIMENSION с блоками *Dn; несколько этажей — слои F1-/F2-; прежний режим линий', () => {
  const s = scene();
  const fl = s.ovL.levels[0].h, plan = AP.extract(OV.planSlice(s.dl, { h0: fl + 1.15, h1: fl + 1.25 }).uv, {});
  const dxf = AP.toDXF(plan, { units: 'mm', origin: 'local', title: 'План' });
  const P = dxfPairs(dxf);
  const dims = P.filter(p => p[0] === '0' && p[1] === 'DIMENSION').length;
  assert.ok(dims >= plan.faces.length, 'размер у каждой грани: ' + dims + ' / ' + plan.faces.length);
  const blocks = (dxf.match(/\n2\n\*D\d+\n/g) || []).length;
  assert.ok(blocks >= dims * 2 - 1, 'блок *Dn у каждого размера (имя в BLOCK и в DIMENSION)');
  assert.match(dxf, /\nDIMSTYLE\n/); assert.match(dxf, /\nDEFPOINTS\n/); assert.match(dxf, /\n70\n129\n/);
  assert.match(dxf, /\$DIMSTYLE\n2\nSTANDARD/);
  assert.ok(dxf.indexOf('SECTION\n  2\nBLOCKS') >= 0 || /SECTION\r?\n\s*2\r?\nBLOCKS/.test(dxf), 'секция BLOCKS');
  // измерение DIMENSION — расстояние между точками 13 и 14 (мм) = длина грани
  const meas = [];
  P.forEach((p, i) => { if (p[0] === '0' && p[1] === 'DIMENSION') { const e = P.slice(i + 1, i + 40), g = (c) => Number((e.find(q => q[0] === c) || [])[1]); meas.push(Math.hypot(g('14') - g('13'), g('24') - g('23'))); } });
  for (const f of plan.faces) assert.ok(meas.some(m => Math.abs(m - f.length * 1000) < 0.6), 'грань ' + f.length);
  const lines = AP.toDXF(plan, { units: 'mm', dims: 'lines' });
  assert.doesNotMatch(lines, /\nDIMENSION\n/, 'режим линий — без DIMENSION');
  const multi = AP.toDXF([{ plan, title: 'Этаж 1' }, { plan, title: 'Этаж 2' }], { units: 'mm', origin: 'local' });
  assert.match(multi, /\nF1-A-WALL\n/); assert.match(multi, /\nF2-A-WALL\n/); assert.match(multi, /\nF2-A-DIMS\n/);
  assert.equal(dxfPairs(multi).filter(p => p[0] === '0' && p[1] === 'DIMENSION').length, dims * 2);
  // этажи в местных координатах — рядом по X, не друг на друге
  const xs = (layer) => dxfPairs(multi).reduce((a, p, i, arr) => { if (p[0] === '8' && p[1] === layer) { const x = arr.slice(i, i + 4).find(q => q[0] === '10'); if (x) a.push(Number(x[1])); } return a; }, []);
  const x1 = xs('F1-A-WALL'), x2 = xs('F2-A-WALL');
  assert.ok(Math.min(...x2) > Math.max(...x1), 'второй этаж правее первого');
});

test('План: мусорные короткие грани без соседей отсеиваются (clutter), стены остаются', () => {
  const s = scene();
  const fl = s.ovL.levels[0].h, sl = OV.planSlice(s.dl, { h0: fl + 1.15, h1: fl + 1.25 });
  // добавляем «мебель»: три коротких отрезка по 0,4 м посреди помещения
  const extra = [];
  for (const [x0, y0] of [[-1.5, -0.5], [-0.8, 0.6], [0.4, -1.2]]) for (let k = 0; k < 400; k++) extra.push(x0 + (k % 200) * 0.002, y0 + (k < 200 ? 0 : 0.002));
  const uv = new Float32Array(sl.uv.length + extra.length); uv.set(sl.uv); uv.set(extra, sl.uv.length);
  const p1 = AP.extract(uv, {}), p0 = AP.extract(uv, { clutter: false });
  assert.ok(p1.ok && p0.ok);
  assert.ok(p1.stats.clutter >= 1, 'отсеяно: ' + p1.stats.clutter);
  assert.ok(p1.faces.length < p0.faces.length);
  assert.equal(p1.rooms.length, p0.rooms.length, 'помещения не теряются');
});

test('PDF-отчёт: раздел на каждый этаж, длинные списки проёмов — одной строкой, подписи граней не налезают', () => {
  const s = scene();
  const fl = s.ovL.levels[0].h, plan = AP.extract(OV.planSlice(s.dl, { h0: fl + 1.15, h1: fl + 1.25 }).uv, {});
  const html = CR.build({ ov: s.ovL, plan, plans: [{ plan, title: 'Этаж 1' }, { plan, title: 'Этаж 2' }], fileName: 'b.las' });
  assert.match(html, /План из облака — Этаж 1/); assert.match(html, /План из облака — Этаж 2/);
  const many = Object.assign({}, plan, { openings: Array.from({ length: 30 }, (_, i) => ({ a: [0, 0], b: [1, 0], width: 0.8 + i * 0.01 })) });
  const h2 = CR.build({ ov: s.ovL, plan: many, fileName: 'b.las' });
  assert.match(h2, /30 шт\. · 800–1[\s\u00a0]?090 мм, медиана/);
  // подписи граней: попарно не ближе 6 px по вертикали при пересечении по горизонтали (оценка по координатам текста в SVG)
  const svg = CR.planSvg(plan), T = [];
  svg.replace(/<text x="([\d.-]+)" y="([\d.-]+)"[^>]*>([^<]*)<\/text>/g, (m, x, y, t) => { T.push({ x: +x, y: +y, w: t.length * 5.2 }); return m; });
  assert.ok(T.length >= 4, 'подписей: ' + T.length);
  let clash = 0;
  for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) if (Math.abs(T[i].x - T[j].x) < (T[i].w + T[j].w) / 2 && Math.abs(T[i].y - T[j].y) < 6) clash++;
  assert.equal(clash, 0);
});

test('Окна: «Последние действия» — вкладки Облако/Проект/Сеанс и отмена иконкой; «Папка проекта» — компактно', () => {
  const hp = read('renderer/history-panel.js'), pw = read('renderer/project-workspace.js'), css = read('renderer/ui/cloud-tools.css');
  assert.match(hp, /\['cloud', 'Облако'/); assert.match(hp, /\['proj', 'Проект'/); assert.match(hp, /\['sess', 'Сеанс'/);
  assert.match(hp, /data-undo="' \+ e\.steps \+ '" title="' \+ esc\(t\) \+ '" aria-label="' \+ esc\(t\) \+ '">' \+ ic\('undo-2', 15\) \+ '<\/button>/, 'отмена — кнопка-иконка с подписью в title');
  assert.doesNotMatch(hp, /Хранится до 6 последних правок/, 'длинные примечания убраны');
  assert.match(pw, /class="pw-seg" role="radiogroup"/); assert.match(pw, /data-a="inplace"/); assert.match(pw, /data-a="asnew"/);
  assert.doesNotMatch(pw, /Копия нужна, чтобы вернуть файл после неудачной перезаписи\. Для облаков/);
  for (const c of ['.hp-seg', '.hp-cnt', '.hp-ib', '.hp-empty', '.pw-row', '.pw-opt', '.pw-ib']) assert.ok(css.includes(c), c);
});
