'use strict';
// Ревизия 33: балки, трубы, короба и лотки под потолком по облаку (сечения, пучки труб, высота в свету), выгрузка DXF / IFC / CSV,
// классы точек в новый LAS (в том числе вырезка с пересчётом заголовка), проводка IPC / интерфейса / сборки / порядка скриптов.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const MEP = require(path.join(ROOT, 'renderer', 'cloud-mep.js'));
const DXF = require(path.join(ROOT, 'renderer', 'dxf.js'));
const UI = require(path.join(ROOT, 'renderer', 'cloud-inspect-ui.js'));
const REP = require(path.join(ROOT, 'renderer', 'cloud-report.js'));
const CL = require(path.join(ROOT, 'cloud-classify-core.js'));
const Seg = require(path.join(ROOT, 'cloud-segments.js'));
const JOB = require(path.join(ROOT, 'cloud-inspect-job.js'));
const G = require('./r27-synthetic.helper.js');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ': ' + a + ' ≠ ' + b + ' ± ' + tol);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-r33-'));

// под потолком: одиночная труба Ø110, пучок из трёх труб Ø80, балка у перекрытия 300×350, короб 500×300, лоток 300×60,
// низкая труба Ø100 (низ 2,01 при пределе 2,1), светильник 0,6 м и шкаф от пола — не элементы
const MEPS = [
  { type: 'pipe', x0: 0.5, y0: 1.5, x1: 4.0, y1: 1.5, zc: 2.5, d: 0.11 },
  { type: 'pipe', x0: 0.5, y0: 3.0, x1: 4.0, y1: 3.0, zc: 2.45, d: 0.08 }, { type: 'pipe', x0: 0.5, y0: 3.1, x1: 4.0, y1: 3.1, zc: 2.45, d: 0.08 },
  { type: 'pipe', x0: 0.5, y0: 3.2, x1: 4.0, y1: 3.2, zc: 2.45, d: 0.08 },
  { type: 'box', x0: 4.5, y0: 0.2, x1: 4.5, y1: 5.8, w: 0.3, z0: 2.45, z1: 2.8 },
  { type: 'box', x0: 8.0, y0: 0.5, x1: 8.0, y1: 5.5, w: 0.5, z0: 2.3, z1: 2.6 },
  { type: 'box', x0: 6.5, y0: 1.2, x1: 9.5, y1: 1.2, w: 0.3, z0: 2.65, z1: 2.71 },
  { type: 'pipe', x0: 6.5, y0: 4.8, x1: 9.5, y1: 4.8, zc: 2.06, d: 0.1 },
  { type: 'box', x0: 1.0, y0: 4.5, x1: 1.6, y1: 4.5, w: 0.2, z0: 2.6, z1: 2.7 },
  { type: 'box', x0: 1.0, y0: 5.6, x1: 2.5, y1: 5.6, w: 0.6, z0: 0, z1: 2.2, lid: true, floor: true },
];
let JR = null;
function synth() {
  if (JR) return JR;
  const b = G.building({ step: 0.03, theta: 17, noise: 0.003, mep: MEPS });
  const file = path.join(TMP, 'm.las'); G.writeLas(file, b.pts);
  const desc = Seg.openSegmentSource(file).desc;
  desc.cx = 500000 + b.tx; desc.cy = 4000000 + b.ty; desc.cz = 100;
  const c = Math.cos(b.theta), s = Math.sin(b.theta), loc = (p) => [p[0] * c + p[1] * s, -p[0] * s + p[1] * c];
  const opts = { h0: 1.15, h1: 1.25, maxPoints: 12e6, plan: {}, floor: 0, top: 2.7, mep: true, mepTop: 3.15, clear: 2.1, classOut: path.join(TMP, 'm-classified.las') };
  const r = JOB.run({ desc, opts }, () => {});
  const off = JOB.run({ desc, opts: Object.assign({}, opts, { mep: false, classOut: undefined }) }, () => {});
  JR = { b, file, desc, r, off, loc };
  return JR;
}
// элемент по середине в осях здания
function at(list, loc, x, y, tol) {
  let best = null, bd = Infinity;
  for (const e of list) { const m = loc([(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]), d = Math.hypot(m[0] - x, m[1] - y); if (d < bd) { bd = d; best = e; } }
  return bd <= (tol || 0.25) ? best : null;
}

test('задание: найдены все элементы под потолком с сечениями, длинами и высотой в свету', () => {
  const { r, off, loc } = synth();
  assert.ok(r.ok && r.mep && r.mep.ok, r.message);
  const L = r.mep.list, by = r.mep.summary.by;
  assert.equal(L.length, 8, L.map((e) => e.kind + ' ' + MEP.sizeText(e)).join(', '));
  assert.deepEqual([by.beam && by.beam.n, by.pipe && by.pipe.n, by.duct && by.duct.n, by.tray && by.tray.n], [1, 5, 1, 1]);
  assert.ok(!by.rack, 'одиночные трубы не сливаются в трассу');
  const beam = at(L, loc, 4.5, 3.0, 0.4); assert.ok(beam && beam.kind === 'beam' && beam.touch, 'балка у перекрытия');
  near(beam.width, 0.30, 0.02, 'ширина балки'); near(beam.length, 5.6, 0.25, 'длина балки');
  const duct = at(L, loc, 8.0, 3.0, 0.4); assert.ok(duct && duct.kind === 'duct', 'короб');
  near(duct.width, 0.5, 0.02, 'ширина короба'); near(duct.depth, 0.3, 0.03, 'высота короба'); near(duct.bottom, 2.3, 0.02, 'низ короба'); near(duct.length, 5.0, 0.25, 'длина короба');
  const tray = at(L, loc, 8.0, 1.2, 0.4); assert.ok(tray && tray.kind === 'tray', 'лоток');
  near(tray.width, 0.3, 0.02, 'ширина лотка'); near(tray.depth, 0.06, 0.02, 'борт лотка');
  const p110 = at(L, loc, 2.25, 1.5); assert.ok(p110 && p110.kind === 'pipe'); near(p110.d, 0.11, 0.01, 'Ø110'); near(p110.length, 3.5, 0.2, 'длина трубы');
  const bundle = [3.0, 3.1, 3.2].map((y) => at(L, loc, 2.25, y, 0.05));
  for (const p of bundle) { assert.ok(p && p.kind === 'pipe', 'труба пучка'); near(p.d, 0.08, 0.01, 'Ø80'); assert.ok(p.group && p.group === bundle[0].group && p.groupN === 3, 'один пучок из трёх'); }
  const low = at(L, loc, 8.0, 4.8); assert.ok(low && low.kind === 'pipe'); near(low.d, 0.1, 0.01, 'Ø100'); near(low.clear, 2.01, 0.02, 'низ над полом');
  assert.ok(low.warn && L.filter((e) => e.warn).length === 1 && r.mep.summary.warn === 1, 'замечание только у низкой трубы');
  near(r.mep.summary.minClear, 2.01, 0.02, 'наименьшая высота в свету');
  assert.ok(!at(L, loc, 1.3, 4.5, 0.4), 'светильник 0,6 м — не элемент'); assert.ok(!at(L, loc, 1.75, 5.6, 0.5), 'шкаф от пола — не элемент');
  assert.ok(!off.mep, 'mep:false — без поиска');
});

test('выгрузка: IFC4 (балка, трубы, короб, лоток), DXF по слоям, CSV, итоги', () => {
  const { r, desc } = synth(), L = r.mep.list, org = { cx: desc.cx, cy: desc.cy, cz: desc.cz };
  const ifc = MEP.toIfc(L, { origin: org, name: 'синтетика', storey: 0, storeyName: 'Этаж 1', date: '2025-01-01T00:00:00' });
  assert.ok(ifc.startsWith('ISO-10303-21;') && ifc.trim().endsWith('END-ISO-10303-21;') && ifc.includes("FILE_SCHEMA(('IFC4'))"));
  for (const k of ['IFCBEAM(', 'IFCPIPESEGMENT(', 'IFCDUCTSEGMENT(', 'IFCCABLECARRIERSEGMENT(', 'IFCCIRCLEPROFILEDEF', 'IFCRECTANGLEPROFILEDEF', 'IFCRELCONTAINEDINSPATIALSTRUCTURE', "'BIMTwin_Scan'"]) assert.ok(ifc.includes(k), k);
  assert.equal((ifc.match(/=IFC(BEAM|PIPESEGMENT|DUCTSEGMENT|CABLECARRIERSEGMENT)\(/g) || []).length, L.length);
  assert.equal((ifc.match(/IFCBOOLEAN\(\.T\.\)/g) || []).length, 1, 'LowClearance у одной трубы');
  assert.ok(/^[\x00-\x7f]*$/.test(ifc), 'только ASCII (кириллица — \\X2\\)');
  const data = ifc.slice(ifc.indexOf('DATA;'));
  for (const ln of data.split('\n').filter((x) => x.startsWith('#'))) { let d = 0; for (const ch of ln.replace(/'(?:[^']|'')*'/g, '')) { if (ch === '(') d++; else if (ch === ')') d--; } assert.equal(d, 0, ln); }
  const refs = new Set((data.match(/^#\d+/gm) || []));
  for (const m of data.match(/#\d+/g)) assert.ok(refs.has(m), 'ссылка ' + m);
  // DXF: слои по типам, оси и подписи, мировые координаты
  const ents = MEP.toDxfEntities(L, { origin: org }), dxf = DXF.toDxf(ents);
  for (const lay of ['S-BEAM', 'P-PIPE', 'M-DUCT', 'E-TRAY', 'P-PIPE-AXIS', 'P-PIPE-TEXT']) assert.ok(dxf.includes('\n' + lay + '\n'), 'слой ' + lay);
  assert.equal(ents.filter((e) => e.type === 'polyline').length, L.length);
  assert.ok(ents.every((e) => (e.points || [e.a || e.p]).every((p) => Math.abs(p[0] - org.cx) < 30 && Math.abs(p[2] - org.cz) < 5)), 'мировые координаты');
  assert.ok(ents.some((e) => e.type === 'text' && /^D100 H2,0|^D100 H2\.0/.test(e.text)), 'подпись низкой трубы');
  // CSV
  const rows = MEP.csvRows(L, { clear: 2.1, origin: org });
  assert.equal(rows.length, L.length + 1); assert.ok(rows.every((x) => x.split(';').length === 14));
  assert.ok(rows.some((x) => /;труба;Ø100;/i.test(x) && /низ ниже 2,10 м$/.test(x)));
  assert.ok(rows.some((x) => /;пучок \d+ \(3\);/.test(x)));
  const t = UI.csv(r); assert.ok(t.includes('№;Тип;Размер, мм;Длина, м'), 'CSV контроля — с таблицей элементов');
  // вывод и отчёт
  const v = UI.verdict(r);
  assert.ok(v.some((x) => /^Под потолком: балок 1, труб 5, коробов 1, лотков 1; низ ниже 2,10 м — 1$/.test(x)), v.join('\n'));
  assert.ok(v.some((x) => /^Классы точек записаны: .*\(\d+ точек\)$/.test(x)), 'вывод о классах точек');
  const html = REP.inspect({ fileName: 'скан.las', res: Object.assign({}, r, { classify: Object.assign({ name: 'm-classified.las' }, r.classify) }), verdict: v, appVersion: '1.2.0-rc.3', maps: [] });
  for (const h of ['Балки и трубы под потолком', 'Трубы по диаметрам', 'Классы точек', 'Ø100']) assert.ok(html.includes(h), h);
  assert.ok(!/<script|https?:\/\/|javascript:/i.test(html));
});

test('классы точек: новый LAS — исходник не меняется, классы по элементам, полу, стенам и потолку', () => {
  const { r, file } = synth(), c = r.classify;
  assert.ok(c && c.ok, c && c.message); assert.equal(c.crop, false); assert.equal(c.written, c.points);
  const src = fs.readFileSync(file), out = fs.readFileSync(c.path), d = Seg.openSegmentSource(c.path).desc;
  assert.equal(out.length, src.length); assert.equal(d.count, c.points);
  const k = d.fmt >= 6 ? 16 : 15, rl = d.recLen, cnt = {};
  let diff = 0;
  for (let i = 0; i < d.count; i++) {
    const o = d.offToPts + i * rl; cnt[out[o + k] & 0x1f] = (cnt[out[o + k] & 0x1f] || 0) + 1;
    if (src.compare(out, o, o + k, o, o + k) !== 0) diff++;
  }
  assert.equal(diff, 0, 'координаты и прочие поля — без изменений');
  for (const [cl, n] of Object.entries(c.counts)) assert.equal(cnt[cl], n, 'класс ' + cl);
  for (const cl of [2, 6, 24, 25, 26, 27, 28]) assert.ok(c.counts[cl] > 1000, 'класс ' + cl + ' (' + CL.CLASSES[cl] + '): ' + c.counts[cl]);
  assert.ok(c.counts[26] > 1000 && c.counts[27] > c.counts[28], 'трубы; короб больше лотка');
  assert.equal(CL.BY_KIND.rack, 26);
});

test('классы точек: вырезка рамкой — только точки в рамке, заголовок пересчитан', () => {
  const { file } = synth();
  const desc = Seg.openSegmentSource(file).desc, out = path.join(TMP, 'crop.las'), rect = { u0: -2, u1: 2, v0: -1, v1: 1 };
  const w = CL.writeClassified(desc, out, (u, v, h) => (h < 1 ? 2 : 1), { rect });
  assert.ok(w.ok && w.crop && w.written > 1000 && w.written < w.points);
  assert.equal(w.counts[1] + w.counts[2], w.written);
  const d = Seg.openSegmentSource(out).desc, b = fs.readFileSync(out);
  assert.equal(d.count, w.written); assert.equal(b.length, d.offToPts + w.written * d.recLen);
  let byRet = 0; for (let i = 0; i < 5; i++) byRet += b.readUInt32LE(111 + 4 * i);
  assert.ok(byRet <= w.written, 'по возвратам не больше записанных: ' + byRet);
  const mx = b.readDoubleLE(179), mn = b.readDoubleLE(187);
  assert.ok(mx > mn && mx - mn <= 4.01, 'границы X пересчитаны: ' + (mx - mn));
  assert.ok(!fs.existsSync(out + '.part'));
  assert.equal(CL.writeClassified(Object.assign({}, desc, { kind: 'e57' }), out, () => 1, {}).ok, false);
});

test('сечение: окружность по нижней дуге, разбиение профиля на трубы', () => {
  const pts = []; for (let a = -1.9; a <= 1.9; a += 0.05) pts.push([0.4 + 0.05 * Math.sin(a), 2.5 - 0.05 * Math.cos(a)]);
  const f = MEP.circleFit(pts.map((p) => [p[0], p[1], 1]));
  assert.ok(f, 'окружность найдена'); near(f.r, 0.05, 0.003, 'радиус');
  assert.equal(typeof MEP.splitProfile, 'function');
  assert.equal(MEP.KIND.rack ? true : !!MEP.KIND_LONG.rack, true); assert.ok(/трасса/i.test(MEP.KIND_LONG.rack));
  assert.equal(MEP.LAYER.rack, 'P-RACK');
});

test('проводка: IPC, preload, форма и вкладка, сборка, порядок скриптов', () => {
  const main = read('main.js'), pre = read('preload.js'), pkg = JSON.parse(read('package.json')), ui = read('renderer/cloud-inspect-ui.js'), job = read('cloud-inspect-job.js');
  assert.match(main, /clear = lim\(a && a\.clear, 2\.0, 1\.5, 6\)/);
  assert.match(main, /path\.basename\(abs\)\.replace\(\/\\\.las\$\/i, ''\) \+ '-classified'/);
  assert.match(main, /mep, mepTop: Number\.isFinite\(mepTop\)/); assert.match(main, /classRect: classOut && rect \? rect : null/);
  assert.match(main, /недостаточно места на диске для классов точек/);
  assert.match(pre, /cloudInspect: \(payload\) => inv\('bim:cloudInspect'/);
  assert.match(job, /require\('\.\/cloud-classify-core\.js'\)/); assert.match(job, /MEP\.refine\(list, racc/);
  for (const k of ["key: 'mep'", "key: 'clear'", "key: 'classify'", "modes.push(['mep', 'Балки и трубы'])", 'data-pane="mep"', 'function mepExport', 'toIfc(mepL', 'toDxfEntities(mepL', 'mepTop: mepTopOf(f)']) assert.ok(ui.includes(k), k);
  for (const f of ['renderer/cloud-mep.js', 'cloud-classify-core.js']) assert.ok(pkg.build.asarUnpack.includes(f), 'asarUnpack ' + f);
  assert.ok(pkg.build.files.includes('cloud-classify-core.js'));
  const html = read('renderer/index.html'), at = (s) => html.indexOf(s);
  for (const s of ['cloud-mep.js?v=1333', 'cloud-report.js?v=1333', 'cloud-inspect-ui.js?v=1333', 'cloud-tools.css?v=1333']) assert.ok(at(s) > 0, s);
  assert.ok(at('cloud-mep.js?v=') < at('cloud-report.js?v=') && at('cloud-mep.js?v=') < at('cloud-inspect-ui.js?v='), 'порядок скриптов');
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  for (const f of ['renderer/cloud-mep.js', 'cloud-classify-core.js', 'renderer/cloud-inspect-ui.js', 'cloud-inspect-job.js', 'renderer/cloud-report.js']) assert.ok(!emoji.test(read(f)), 'эмодзи в ' + f);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

// проверка на реальном облаке фасада: кроны деревьев и решётки давали ложные «трубы» и «трассы».
// Сцена: ряд из трёх труб Ø60 на одной высоте (остаётся), решётка из трёх прутьев Ø30 одна над другой и дерево у здания —
// рыхлая крона без перекрытия над ней (отсеиваются).
test('отсев: крона дерева и решётка не дают элементов, ряд труб на одной высоте остаётся', () => {
  const r0 = ((s) => () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; })(11);
  const extra = [];
  for (let i = 0; i < 150000; i++) {   // дерево у здания: крона 2 × 2 × 2 м от 1,7 до 3,7 м (выше полосы поиска), листва по всему объёму
    let x, y, z; do { x = r0() * 2 - 1; y = r0() * 2 - 1; z = r0() * 2 - 1; } while (x * x + y * y + z * z > 1);
    extra.push([13.0 + 1.0 * x, 3.0 + 1.0 * y, 2.7 + 1.0 * z]);
  }
  for (let z = 0; z < 1.7; z += 0.01) for (let k = 0; k < 12; k++) extra.push([13.0 + 0.1 * Math.cos(k / 2), 3.0 + 0.1 * Math.sin(k / 2), z]);   // ствол
  const mep = [
    { type: 'pipe', x0: 0.5, y0: 2.0, x1: 4.0, y1: 2.0, zc: 2.5, d: 0.06 }, { type: 'pipe', x0: 0.5, y0: 2.25, x1: 4.0, y1: 2.25, zc: 2.5, d: 0.06 },
    { type: 'pipe', x0: 0.5, y0: 2.5, x1: 4.0, y1: 2.5, zc: 2.5, d: 0.06 },
    { type: 'pipe', x0: 1.0, y0: 4.5, x1: 4.0, y1: 4.5, zc: 2.1, d: 0.03 }, { type: 'pipe', x0: 1.0, y0: 4.5, x1: 4.0, y1: 4.5, zc: 2.3, d: 0.03 },
    { type: 'pipe', x0: 1.0, y0: 4.5, x1: 4.0, y1: 4.5, zc: 2.5, d: 0.03 },
  ];
  const b = G.building({ step: 0.03, theta: 17, noise: 0.003, mep, extra });
  const file = path.join(TMP, 'm2.las'); G.writeLas(file, b.pts);
  const desc = Seg.openSegmentSource(file).desc;
  desc.cx = 500000 + b.tx; desc.cy = 4000000 + b.ty; desc.cz = 100;
  const c = Math.cos(b.theta), s = Math.sin(b.theta), loc = (p) => [p[0] * c + p[1] * s, -p[0] * s + p[1] * c];
  const r = JOB.run({ desc, opts: { h0: 1.15, h1: 1.25, maxPoints: 12e6, plan: {}, floor: 0, top: 2.7, mep: true, mepTop: 3.15, clear: 2.0 } }, () => {});
  assert.ok(r.ok && r.mep && r.mep.ok, r.message);
  const L = r.mep.list, mid = (e) => loc([(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]);
  const txt = L.map((e) => e.kind + ' ' + MEP.sizeText(e) + ' @' + mid(e).map((x) => x.toFixed(2)).join(',')).join('; ');
  // ряд труб: три трубы Ø60 (пучок) — остаётся
  const row = L.filter((e) => { const m = mid(e); return m[0] > 0.3 && m[0] < 4.2 && m[1] > 1.85 && m[1] < 2.65; });
  assert.ok(row.length >= 1 && row.every((e) => e.bottom > 2.4 && e.bottom < 2.5), 'ряд труб: ' + txt);
  assert.equal(row.filter((e) => e.kind === 'pipe').length, 3, 'три трубы ряда: ' + txt);
  // решётка и крона — не элементы
  assert.ok(!L.some((e) => { const m = mid(e); return m[1] > 4.2 && m[1] < 4.8 && m[0] < 4.5; }), 'решётка: ' + txt);
  assert.ok(!L.some((e) => { const m = mid(e); return Math.hypot(m[0] - 13.0, m[1] - 3.0) < 1.3; }), 'крона: ' + txt);
  assert.ok(r.mep.stats.grille >= 3 || r.mep.stats.clutter >= 1, JSON.stringify(r.mep.stats));
  assert.ok(typeof MEP.dropGrille === 'function');
});
