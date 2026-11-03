'use strict';
// Ревизия 40: облако интерьера → BIM с инженерными сетями (scan2bim-mep.js: трубы с DN и цветом, лотки, кабели) и
// членение окон и витражей (рама, импосты, стеклопакеты); выгрузка IFC4 (IfcPipeSegment / IfcCableCarrierSegment / IfcCableSegment,
// IfcSweptDiskSolid, IfcMember .MULLION., IfcPlate .CURTAIN_PANEL.), OBJ, DXF, отчёт; окно CloudBimUI (слой «Сети») и проводка.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'scan2bim-core.js'));
const M = require(path.join(ROOT, 'scan2bim-mep.js'));
const X = require(path.join(ROOT, 'renderer', 'scan2bim-export.js'));
const UI = require(path.join(ROOT, 'renderer', 'cloud-bim-ui.js'));
const IFC = require(path.join(ROOT, 'db', 'ifcImport.js'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
// помещение 10 × 6 м, потолок 3,5 м; под потолком: красная труба Ø 114 (DN100), серая Ø 60 (DN50), кабель Ø 20, лоток 300 × 60;
// сканер снизу — видна нижняя часть труб
function mepScene() {
  const r = rng(40), P = [], J = () => (r() - 0.5) * 0.004;
  const push = (x, y, z, c) => P.push(x + J(), y + J(), z + J(), c[0], c[1], c[2]);
  for (let x = 0; x < 10; x += 0.02) for (let y = 0; y < 6; y += 0.02) push(x, y, 3.5, [200, 200, 195]);
  for (let z = 1.9; z < 3.5; z += 0.02) {
    for (let x = 0; x < 10; x += 0.02) { push(x, 0, z, [190, 190, 185]); push(x, 6, z, [190, 190, 185]); }
    for (let y = 0; y < 6; y += 0.02) { push(0, y, z, [190, 190, 185]); push(10, y, z, [190, 190, 185]); }
  }
  const pipe = (y, z, rr, c, x0, x1) => { const k = Math.max(16, Math.ceil(2 * Math.PI * rr / 0.006)); for (let x = x0; x < x1; x += 0.01) for (let i = 0; i < k; i++) { const a = -Math.PI * 1.1 + i / k * Math.PI * 1.2; push(x, y + rr * Math.cos(a), z + rr * Math.sin(a), c); } };
  pipe(2.0, 3.0, 0.057, [200, 30, 25], 1, 9);
  pipe(2.6, 3.1, 0.030, [150, 150, 150], 1, 9);
  pipe(1.0, 3.2, 0.010, [30, 30, 30], 2, 8);
  for (let x = 1; x < 9; x += 0.01) {
    for (let y = 3.85; y <= 4.15; y += 0.008) push(x, y, 2.9, [170, 172, 175]);
    for (let z = 2.9; z <= 2.96; z += 0.008) { push(x, 3.85, z, [170, 172, 175]); push(x, 4.15, z, [170, 172, 175]); }
  }
  return P;
}
let MEPRES = null;
function mepRun() {
  if (MEPRES) return MEPRES;
  const P = mepScene(), acc = M.mepAcc({ axes: [0, Math.PI / 2], zones: [{ storey: 0, h0: 1.9, h1: 3.56, ceil: 3.5 }], rect: { u0: -0.3, u1: 10.3, v0: -0.3, v1: 6.3 } });
  const o = { r: 0, g: 0, b: 0 };
  for (let i = 0; i < P.length; i += 6) { o.r = P[i + 3]; o.g = P[i + 4]; o.b = P[i + 5]; acc.add(P[i], P[i + 1], P[i + 2], o); }
  MEPRES = { acc, list: M.mepFind(acc, {}) };
  return MEPRES;
}
const near = (e, y, z) => Math.abs(e.path[0][1] - y) < 0.03 && Math.abs(e.path[0][2] - z) < 0.03;

test('scan2bim-mep: трубы под потолком — диаметр, DN и цвет; ось трассы и длина', () => {
  const { list } = mepRun();
  const red = list.find((e) => e.kind === 'pipe' && near(e, 2.0, 3.0));
  assert.ok(red, 'красная труба: ' + JSON.stringify(list.map((e) => [e.kind, e.path[0]])));
  assert.ok(Math.abs(red.d - 0.114) <= 0.012 && red.dn === 100 && red.color === 'red', JSON.stringify(red));
  assert.ok(red.length >= 7 && red.length <= 8.4 && red.axis === 0, 'длина ' + red.length);
  const gray = list.find((e) => e.kind === 'pipe' && near(e, 2.6, 3.1));
  assert.ok(gray && gray.dn === 50 && gray.color === 'gray', JSON.stringify(gray));
});

test('scan2bim-mep: лоток с плоским дном — не труба; кабель; обрывков потолка и стен нет', () => {
  const { list } = mepRun();
  const tray = list.find((e) => e.kind === 'tray');
  assert.ok(tray && Math.abs(tray.w - 0.3) <= 0.03 && Math.abs(tray.path[0][1] - 4.0) < 0.03 && Math.abs(tray.path[0][2] - 2.9) < 0.03, JSON.stringify(tray));
  assert.ok(!list.some((e) => e.kind === 'pipe' && near(e, 4.0, 3.07)), 'лоток принят за трубу');
  const cab = list.find((e) => e.kind === 'cable' && near(e, 1.0, 3.2));
  assert.ok(cab && cab.d <= 0.035 && cab.length >= 5, JSON.stringify(cab));
  assert.strictEqual(list.length, 4, 'лишние элементы: ' + JSON.stringify(list.map((e) => [e.kind, e.w || e.d, e.path[0]])));
  assert.ok(list.every((e, i) => e.id === 'N' + (i + 1)));
});

test('scan2bim-mep: направления по стенам, DN, упрощение полилинии', () => {
  const w = (a, L) => ({ kind: 'line', a: [0, 0], b: [Math.cos(a) * L, Math.sin(a) * L] });
  const ax = M.axesFrom([w(Math.PI / 6, 20), w(Math.PI / 6 + Math.PI / 2, 10), w(Math.PI / 6, 8)]).map((a) => a * 180 / Math.PI);
  assert.ok(ax.length === 2 && ax.some((a) => Math.abs(a - 30) <= 1) && ax.some((a) => Math.abs(a - 120) <= 1), String(ax));
  assert.strictEqual(M.snapDN(0.0603).dn, 50); assert.strictEqual(M.snapDN(0.168).dn, 150); assert.strictEqual(M.snapDN(0.5), null);
  const pts = []; for (let i = 0; i <= 50; i++) pts.push([i * 0.1, i < 25 ? 0 : (i - 25) * 0.1, 3]);
  assert.strictEqual(M.dp(pts, 0.025).length, 3);
});

// развёртка окна 1,5 × 1,5 м (клетка 5 см): светлая рама 5 см, светлый импост 10 см посередине, тёмное стекло
function winElev(withMullion) {
  const ns = 40, nh = 40, F = new Float32Array(ns * nh), rgb = new Float32Array(ns * nh * 3), r = rng(7);
  for (let rr = 0; rr < nh; rr++) for (let x = 0; x < ns; x++) {
    const c = rr * ns + x, ix = x - 5, iz = rr - 5; F[c] = 1;
    let v = 120;
    if (ix >= 0 && ix < 30 && iz >= 0 && iz < 30) { const frame = ix < 1 || ix > 28 || iz < 1 || iz > 28, mul = withMullion && (ix === 14 || ix === 15); v = frame || mul ? 235 : 55 + r() * 10; }
    rgb[c * 3] = v; rgb[c * 3 + 1] = v; rgb[c * 3 + 2] = v;
  }
  return { ns, F, rgb, hb: 0 };
}
test('scan2bim-core: членение окна — рама, импост посередине, две створки', () => {
  const g = C.windowGrid(winElev(true), { x0: 5, x1: 35, r0: 5, r1: 35 });
  assert.ok(g && g.colored, 'сетка окна');
  assert.strictEqual(g.mullions, 1); assert.strictEqual(g.transoms, 0);
  const m = g.members.find((q) => !q.frame && q.dir === 'v');
  assert.ok(Math.abs((m.s0 + m.s1) / 2 - 1.0) < 0.06 && m.s1 - m.s0 <= 0.15, JSON.stringify(m));
  assert.strictEqual(g.panels.length, 2);
  assert.ok(g.members.filter((q) => q.frame).every((q) => (q.dir === 'v' ? q.s1 - q.s0 : q.z1 - q.z0) >= 0.049 && (q.dir === 'v' ? q.s1 - q.s0 : q.z1 - q.z0) <= 0.151));
  const g0 = C.windowGrid(winElev(false), { x0: 5, x1: 35, r0: 5, r1: 35 });
  assert.strictEqual(g0.mullions, 0); assert.strictEqual(g0.panels.length, 1);
});

function expModel() {
  const { list } = mepRun();
  const grid = { members: [{ dir: 'v', frame: true, s0: 0, s1: 0.1, z0: 0, z1: 3 }, { dir: 'v', frame: false, s0: 1.95, s1: 2.05, z0: 0, z1: 3 }, { dir: 'h', frame: false, s0: 0, s1: 4, z0: 1.45, z1: 1.55 }, { dir: 'v', frame: true, s0: 3.9, s1: 4, z0: 0, z1: 3 }],
    panels: [{ kind: 'vision', mat: 'glass', s0: 0.1, s1: 1.95, z0: 0, z1: 1.45 }, { kind: 'spandrel', mat: 'glass', s0: 2.05, s1: 3.9, z0: 1.55, z1: 3 }] };
  const win = { kind: 'window', s0: 1, s1: 2.5, z0: 0.9, z1: 2.4, width: 1.5, height: 1.5, sill: 0.9,
    grid: { members: [{ dir: 'v', frame: true, s0: 1, s1: 1.06, z0: 0.9, z1: 2.4 }, { dir: 'v', frame: false, s0: 1.7, s1: 1.8, z0: 0.96, z1: 2.34 }, { dir: 'v', frame: true, s0: 2.44, s1: 2.5, z0: 0.9, z1: 2.4 }],
      panels: [{ kind: 'vision', mat: 'glass', s0: 1.06, s1: 1.7, z0: 0.96, z1: 2.34 }, { kind: 'vision', mat: 'glass', s0: 1.8, s1: 2.44, z0: 0.96, z1: 2.34 }] } };
  const wall = (id, a, b, extra) => Object.assign({ id, kind: 'line', a, b, storey: 0, role: 'wall', length: Math.hypot(b[0] - a[0], b[1] - a[1]), thickness: 0.25, thicknessMeasured: true, sides: 2, base: 0, height: 3.5, top: 3.5, material: 'brick', materialConf: 0.8, rms: 0.005, plumb: 0.001, coverage: 0.9, openings: [] }, extra || {});
  return { ok: true, format: 'bimtwin-scan2bim', origin: { cx: 0, cy: 0, cz: 0 }, bbox: { u0: 0, u1: 10, v0: 0, v1: 6, h0: 0, h1: 3.5 }, levels: [0, 3.5],
    storeys: [{ index: 0, name: 'Этаж 1', h: 0, z: 0, height: 3.5, walls: 2 }],
    walls: [wall('W1', [0, 0], [10, 0], { openings: [win] }), wall('W2', [10, 6], [6, 6], { curtain: true, material: 'glass', grid, thickness: 0.15 })],
    columns: [], slabs: [], objects: [], mep: list, warnings: [],
    stats: { storeys: 1, walls: 2, curtainWalls: 1, windows: 1, doors: 0, gates: 0, columns: 0, slabs: 0, objects: 0, wallLength: 14, mullions: 3, glassPanels: 3,
      mep: list.length, pipes: 2, trays: 1, cables: 1, ducts: 0, beams: 0, pipeLength: 15.4, trayLength: 7.8, cableLength: 5.8 } };
}

test('scan2bim-export: IFC4 — трубы IfcSweptDiskSolid, лоток, кабель; витраж из профилей и заполнений; окно с импостом', () => {
  const m = expModel();
  const r = X.toIFC(m, { seed: 'r40', time: 1700000000 });
  assert.ok(/IFCPIPESEGMENT\(.*\.RIGIDSEGMENT\.\)/.test(r.text) && /IFCCABLECARRIERSEGMENT\(.*\.CABLETRAYSEGMENT\.\)/.test(r.text) && /IFCCABLESEGMENT\(.*\.CABLESEGMENT\.\)/.test(r.text));
  assert.strictEqual((r.text.match(/IFCSWEPTDISKSOLID\(/g) || []).length, 3, 'две трубы и кабель — тело по оси');
  assert.ok(/'AdvancedSweptSolid'/.test(r.text));
  assert.strictEqual(r.counts.pipes, 2); assert.strictEqual(r.counts.trays, 1); assert.strictEqual(r.counts.cables, 1);
  assert.ok(/IFCMEMBER\(.*\.MULLION\.\)/.test(r.text) && /IFCPLATE\(.*\.CURTAIN_PANEL\.\)/.test(r.text) && /IFCCURTAINWALL\(/.test(r.text));
  assert.strictEqual(r.counts.members, 4); assert.strictEqual(r.counts.plates, 2);
  assert.ok(/BIMTwin_\\X2\\/.test(r.text) && r.text.indexOf(X.ifcStr('Условный проход DN')) > 0, 'свойства сетей');
  assert.ok(!/[^\x00-\x7f]/.test(r.text));
  const s = JSON.stringify(IFC.parseIFC ? IFC.parseIFC(r.text) : IFC.parse(r.text));
  assert.ok(/Этаж 1/.test(s));
  // без сетей и без членения — прежняя модель
  const r0 = X.toIFC(m, { seed: 'r40', time: 1700000000, mep: false, grid: false });
  assert.ok(!/IFCPIPESEGMENT/.test(r0.text) && !/IFCMEMBER\(/.test(r0.text));
});

test('scan2bim-export: OBJ (восьмигранные трубы), DXF слои сетей, сводка и отчёт', () => {
  const m = expModel();
  const o = X.toOBJ(m, { local: true });
  assert.ok(/^usemtl pipe_red$/m.test(o.obj) && /^usemtl tray$/m.test(o.obj) && /^usemtl mullion$/m.test(o.obj) && /^usemtl pane$/m.test(o.obj));
  const nv = (o.obj.match(/^v /gm) || []).length;
  assert.ok(o.obj.split('\n').filter((l) => l.startsWith('f ')).every((l) => l.split(' ').slice(1).every((k) => +k >= 1 && +k <= nv)));
  const S = X.solids(m), red = S.find((e) => e.type === 'pipe' && e.mat === 'pipe_red');
  assert.ok(red && red.parts[0].tube && Math.abs(red.parts[0].r - red.ref.d / 2) < 1e-9);
  assert.ok(S.some((e) => e.type === 'cabletray') && S.some((e) => e.type === 'cable'));
  const dxf = X.toDXF(m, { local: true });
  assert.ok(/S2B_01_SETI_TRUBY/.test(dxf) && /S2B_01_SETI_LOTKI/.test(dxf) && /S2B_01_SETI_KABELI/.test(dxf));
  const sum = X.summary(m); assert.ok(/Инженерные сети: труб 2/.test(sum) && /Членение окон и витражей/.test(sum), sum);
  const rep = JSON.parse(X.report(m)); assert.strictEqual(rep.mep.length, 4); assert.ok(rep.mep.some((e) => e.kind === 'Труба' && e.dn === 100));
});

test('окно CloudBimUI: слой «Сети» в превью, сводка сетей; форма и проводка опции mep', () => {
  const m = expModel(), sc = UI.buildScene(m);
  const mf = sc.faces.filter((f) => f.L === 'mep').length;
  assert.ok(mf >= 20, 'граней сетей ' + mf);
  let fills = 0; const ctx = new Proxy({}, { get: (t, p) => p === 'fill' ? () => { fills++; } : (typeof t[p] !== 'undefined' ? t[p] : () => {}), set: (t, p, v) => { t[p] = v; return true; } });
  const cv = { width: 400, height: 300, getContext: () => ctx };
  UI.drawScene(cv, sc, { yaw: 0, pitch: 0.5, zoom: 1, px: 0, py: 0, storey: -1, layers: { walls: false, open: false, slabs: false, columns: false, mep: true, site: false } });
  assert.ok(fills > 0 && fills <= mf + 2, 'только сети: ' + fills + ' / ' + mf);
  const ui = read('renderer/cloud-bim-ui.js'), main = read('main.js'), job = read('scan2bim-job.js'), pkg = JSON.parse(read('package.json'));
  assert.ok(/key: 'mep', label: 'Инженерные сети под потолком'/.test(ui) && /mep: v\.mep !== false/.test(ui) && /\['mep', 'Сети'\]/.test(ui));
  assert.ok(/mep: !\(a && a\.mep === false\)/.test(main), 'IPC передаёт опцию mep');
  assert.ok(/require\('\.\/scan2bim-mep'\)/.test(job) && /MEP\.mepFind\(/.test(job) && /mep: mepList/.test(job));
  assert.ok(pkg.build.files.includes('scan2bim-mep.js') && pkg.build.asarUnpack.includes('scan2bim-mep.js'));
});
