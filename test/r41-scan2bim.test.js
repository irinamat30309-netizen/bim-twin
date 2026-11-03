'use strict';
// Ревизия 41: инженерные сети по облаку — лестничный лоток (две боковины, поперечины), пучок кабелей, две трубы друг над
// другом, признак «под перекрытием» (сеть без конструкции над ней отбрасывается), стояк по слоям плана, соединение трасс
// (слияние соосных обрывков, отвод, тройник, переход); выгрузка фитингов и стояков в IFC4, OBJ, DXF, сводка и окно.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'scan2bim-mep.js'));
const X = require(path.join(ROOT, 'renderer', 'scan2bim-export.js'));
const UI = require(path.join(ROOT, 'renderer', 'cloud-bim-ui.js'));
const IFC = require(path.join(ROOT, 'db', 'ifcImport.js'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
// помещение 10 × 6 м, потолок 3,5 м только над полосой y < 4,6 (дальше — проём в перекрытии, труба в 1,2 м от его края);
// лестничный лоток 400 мм (боковины 15 × 80 мм, поперечины через 0,3 м, внутри три кабеля); пучок кабелей;
// две трубы друг над другом; труба под проёмом без перекрытия над ней — не сеть
function scene() {
  const r = rng(41), P = [], J = () => (r() - 0.5) * 0.004;
  const push = (x, y, z, c) => P.push(x + J(), y + J(), z + J(), c[0], c[1], c[2]);
  const G = [150, 150, 150];
  for (let x = 0; x < 10; x += 0.02) for (let y = 0; y < 4.6; y += 0.02) push(x, y, 3.5, [200, 200, 195]);
  for (let z = 1.9; z < 3.5; z += 0.02) for (let x = 0; x < 10; x += 0.02) push(x, 0, z, [190, 190, 185]);
  const pipe = (y, z, rr, c, x0, x1) => { const k = Math.max(16, Math.ceil(2 * Math.PI * rr / 0.006)); for (let x = x0; x < x1; x += 0.01) for (let i = 0; i < k; i++) { const a = -Math.PI * 1.1 + i / k * Math.PI * 1.2; push(x, y + rr * Math.cos(a), z + rr * Math.sin(a), c); } };
  // лестничный лоток: боковины y = 3.8 и 4.2, низ 2.9, высота 0.08
  for (let x = 1; x < 9; x += 0.01) for (let z = 2.9; z <= 2.98; z += 0.006) for (const y of [3.8, 3.815, 4.185, 4.2]) push(x, y, z, [170, 172, 175]);
  for (let x = 1.05; x < 9; x += 0.3) for (let y = 3.8; y <= 4.2; y += 0.008) for (const dx of [0, 0.01, 0.02]) push(x + dx, y, 2.9, [170, 172, 175]);
  [3.9, 4.0, 4.1].forEach((y) => pipe(y, 2.915, 0.012, [30, 30, 30], 1, 9));
  // пучок кабелей ~ 90 × 50 мм
  [[0, 0], [0.025, 0.004], [0.05, -0.003], [0.012, 0.024], [0.04, 0.026], [0.065, 0.015], [0.028, 0.045]].forEach((o) => pipe(1.0 + o[0], 3.1 + o[1], 0.011, [25, 25, 25], 2, 8));
  // две трубы друг над другом: Ø 60 (DN50) и выше Ø 89 (DN80)
  pipe(2.2, 2.85, 0.030, G, 1, 9);
  pipe(2.2, 3.1, 0.0445, G, 1, 9);
  // труба под проёмом (нет перекрытия над ней)
  pipe(5.8, 3.0, 0.030, G, 1, 9);
  return P;
}
let RES = null;
function run(opts) {
  if (RES && !opts) return RES;
  const P = scene(), acc = M.mepAcc({ axes: [0, Math.PI / 2], zones: [{ storey: 0, h0: 1.9, h1: 3.56, ceil: 3.5 }], rect: { u0: -0.3, u1: 10.3, v0: -0.3, v1: 6.3 } });
  const o = { r: 0, g: 0, b: 0 };
  for (let i = 0; i < P.length; i += 6) { o.r = P[i + 3]; o.g = P[i + 4]; o.b = P[i + 5]; acc.add(P[i], P[i + 1], P[i + 2], o); }
  const res = { acc, list: M.mepFind(acc, opts || {}) };
  if (!opts) RES = res;
  return res;
}
const at = (e, y, z, tol) => Math.abs(e.path[0][1] - y) < (tol || 0.04) && Math.abs(e.path[0][2] - z) < (tol || 0.04);
const dump = (L) => JSON.stringify(L.map((e) => [e.kind, e.d || e.w, e.path[0], e.cover, e.ladder || e.bundle || '']));

test('r41 сети: лестничный лоток — две боковины без сплошного дна, кабели внутри — его содержимое', () => {
  const { list } = run();
  const t = list.find((e) => e.kind === 'tray' && e.ladder);
  assert.ok(t, 'лестничный лоток: ' + dump(list));
  assert.ok(Math.abs(t.w - 0.415) <= 0.04 && Math.abs(t.path[0][1] - 4.0) < 0.03 && Math.abs(t.path[0][2] - 2.9) < 0.03 && t.length >= 7, JSON.stringify(t));
  assert.ok(!list.some((e) => e.kind === 'cable' && !e.bundle && Math.abs(e.path[0][1] - 4.0) < 0.25 && Math.abs(e.path[0][2] - 2.92) < 0.05), 'кабели в лотке — не отдельные трассы: ' + dump(list));
});

test('r41 сети: пучок кабелей; две трубы друг над другом; труба без перекрытия над ней отброшена', () => {
  const { list } = run();
  const b = list.find((e) => e.kind === 'cable' && e.bundle);
  assert.ok(b && Math.abs(b.path[0][1] - 1.035) < 0.05 && b.d >= 0.04 && b.d <= 0.15 && b.length >= 5, 'пучок: ' + dump(list));
  const lo = list.find((e) => e.kind === 'pipe' && at(e, 2.2, 2.85)), hi = list.find((e) => e.kind === 'pipe' && at(e, 2.2, 3.1));
  assert.ok(lo && lo.dn === 50 && hi && hi.dn === 80, 'две трубы: ' + dump(list));
  assert.ok(lo.cover >= 0.9 && hi.cover >= 0.9);
  assert.ok(!list.some((e) => Math.abs(e.path[0][1] - 5.8) < 0.1), 'труба под проёмом: ' + dump(list));
  const all = run({ needCeiling: false }).list.find((e) => e.kind === 'pipe' && at(e, 5.8, 3.0));
  assert.ok(all && all.cover < 0.5, 'без признака — найдена, доля перекрытия ' + (all && all.cover));
  const nol = run({ ladder: false }).list;
  assert.ok(!nol.some((e) => e.ladder), 'опция ladder: false');
});

// стояк DN80 у стены (сканер из помещения — видна сторона к помещению), стены и шкаф (длинные прямые серии)
test('r41 стояки: вертикальная труба по слоям плана — DN, высота, цвет; стены и шкаф не стояки', () => {
  const r = rng(7), acc = M.riserAcc({ axes: [0], zones: [{ storey: 0, h0: 0.15, h1: 3.4 }], rect: { u0: -0.3, u1: 6.3, v0: -0.3, v1: 4.3 } });
  const o = { r: 0, g: 0, b: 0 }, J = () => (r() - 0.5) * 0.004;
  const add = (x, y, z, c) => { o.r = c[0]; o.g = c[1]; o.b = c[2]; acc.add(x + J(), y + J(), z + J(), o); };
  for (let z = 0.15; z < 3.4; z += 0.02) { for (let x = 0; x < 6; x += 0.015) add(x, 0, z, [190, 190, 185]); for (let y = 0; y < 4; y += 0.015) add(0, y, z, [190, 190, 185]); }
  for (let z = 0.15; z < 2.0; z += 0.02) for (let x = 3; x < 4.2; x += 0.015) add(x, 1.5, z, [120, 90, 60]);
  const R = 0.0445, cx = 1.5, cy = 0.12;
  for (let z = 0.15; z < 3.37; z += 0.01) for (let a = -0.2; a <= Math.PI + 0.2; a += 0.006 / R) add(cx + R * Math.cos(a), cy + R * Math.sin(a), z, [200, 35, 30]);
  const L = M.riserFind(acc, {});
  assert.strictEqual(L.length, 1, JSON.stringify(L));
  const e = L[0];
  assert.ok(e.riser && e.kind === 'pipe' && e.dn === 80 && e.color === 'red', JSON.stringify(e));
  assert.ok(Math.hypot(e.path[0][0] - cx, e.path[0][1] - cy) < 0.01 && e.path[0][2] <= 0.4 && e.path[1][2] >= 3.2 && e.length >= 2.8, JSON.stringify(e.path));
});

test('r41 соединение трасс: слияние обрывков, отвод стояк — труба, тройник, переход', () => {
  const pipe = (id, path, d, extra) => Object.assign({ id, kind: 'pipe', storey: 0, path, d, length: 0, hits: 10, points: 100, color: 'gray' }, extra || {});
  const L = [
    pipe('a', [[0, 0, 3], [3, 0, 3]], 0.089), pipe('b', [[3.6, 0.01, 3.0], [8, 0.01, 3.0]], 0.089), // разрыв 0,6 м → одна труба
    pipe('r', [[-0.3, 0, 0.3], [-0.3, 0, 2.95]], 0.089, { riser: true }), // стояк под началом трубы → отвод 90°
    pipe('t', [[5, 2, 3], [5, 0.12, 3]], 0.06), // ответвление в середину трубы → тройник
    pipe('u', [[8.3, 0, 3], [12, 0, 3]], 0.168), // DN150 соосно после разрыва 0,3 м → переход
    { id: 'c', kind: 'cable', storey: 0, path: [[0, 3, 3.2], [4, 3, 3.2]], d: 0.02, length: 4 }
  ];
  const r = M.mepConnect(L, {});
  assert.strictEqual(r.list.filter((e) => e.kind === 'pipe').length, 4, JSON.stringify(r.list.map((e) => e.path)));
  const main = r.list.find((e) => e.kind === 'pipe' && !e.riser && e.d < 0.1 && e.length > 7);
  assert.ok(main && main.merged === 2, 'слияние: ' + JSON.stringify(main));
  const el = r.fittings.find((f) => f.type === 'elbow'), tee = r.fittings.find((f) => f.type === 'tee'), tr = r.fittings.find((f) => f.type === 'transition');
  assert.ok(el && Math.abs(el.angle - 90) <= 2 && Math.abs(el.at[0] + 0.3) < 0.02 && Math.abs(el.at[2] - 3) < 0.03, 'отвод: ' + JSON.stringify(r.fittings));
  assert.ok(el.links.includes(main) && el.links.some((x) => x.riser));
  assert.ok(tee && Math.abs(tee.at[0] - 5) < 0.02 && Math.abs(tee.at[1]) < 0.02 && tee.parts.length === 2, 'тройник: ' + JSON.stringify(tee));
  const br = r.list.find((e) => e.d === 0.06); assert.ok(Math.abs(br.path[br.path.length - 1][1]) < 0.02, 'ответвление доведено до оси');
  assert.ok(tr && tr.d0 && tr.d1 && Math.max(tr.d0, tr.d1) === 0.168, 'переход: ' + JSON.stringify(tr));
  assert.strictEqual(r.fittings.length, 3);
  const ll = M.lineLine([0, 0, 0], [1, 0, 0], [2, -1, 0.5], [0, 1, 0]);
  assert.ok(Math.abs(ll.s - 2) < 1e-9 && Math.abs(ll.t - 1) < 1e-9 && Math.abs(ll.dist - 0.5) < 1e-9);
});

function expModel() {
  const mep = [
    { id: 'N1', kind: 'pipe', storey: 0, path: [[0, 0, 3], [8, 0, 3]], d: 0.089, dn: 80, dNom: 0.0889, length: 8, base: 3, color: 'red', hits: 40, cover: 1 },
    { id: 'N2', kind: 'pipe', riser: true, storey: 0, path: [[-0.3, 0, 0.3], [-0.3, 0, 3]], d: 0.089, dn: 80, length: 2.7, base: 1.65, color: 'red', hits: 14 },
    { id: 'N3', kind: 'tray', ladder: true, storey: 0, path: [[1, 4, 2.9], [9, 4, 2.9]], w: 0.415, hgt: 0.08, length: 8, base: 2.9, cover: 1 },
    { id: 'N4', kind: 'cable', bundle: true, storey: 0, path: [[2, 1, 3.1], [8, 1, 3.1]], d: 0.09, length: 6, base: 3.1, cover: 1 },
    { id: 'F1', kind: 'fitting', type: 'elbow', host: 'pipe', storey: 0, d: 0.089, color: 'red', at: [-0.3, 0, 3], parts: [[[-0.3, 0, 2.87], [-0.3, 0, 3], [-0.17, 0, 3]]], path: [[-0.3, 0, 2.87], [-0.3, 0, 3], [-0.17, 0, 3]], links: ['N2', 'N1'], angle: 90, length: 0, base: 3 },
    { id: 'F2', kind: 'fitting', type: 'tee', host: 'tray', storey: 0, w: 0.415, hgt: 0.08, at: [5, 4, 2.9], parts: [[[4.4, 4, 2.9], [5.6, 4, 2.9]], [[5, 4, 2.9], [5, 4.6, 2.9]]], path: [[4.4, 4, 2.9], [5.6, 4, 2.9]], links: ['N3'], length: 0, base: 2.9 }
  ];
  return { ok: true, format: 'bimtwin-scan2bim', origin: { cx: 0, cy: 0, cz: 0 }, bbox: { u0: -1, u1: 10, v0: 0, v1: 6, h0: 0, h1: 3.5 }, levels: [0, 3.5],
    storeys: [{ index: 0, name: 'Этаж 1', h: 0, z: 0, height: 3.5, walls: 0 }], walls: [], columns: [], slabs: [], objects: [], mep, warnings: [],
    stats: { storeys: 1, walls: 0, curtainWalls: 0, windows: 0, doors: 0, gates: 0, columns: 0, slabs: 0, objects: 0, wallLength: 0,
      mep: 4, pipes: 2, trays: 1, cables: 1, ducts: 0, beams: 0, pipeLength: 10.7, trayLength: 8, cableLength: 6, risers: 1, riserLength: 2.7, fittings: 2, elbows: 1, tees: 1, transitions: 0, ladderTrays: 1, bundles: 1 } };
}

test('r41 выгрузка: IFC4 — фитинги (IfcPipeFitting .BEND., IfcCableCarrierFitting .TEE.) и связи, стояк; OBJ, DXF, сводка', () => {
  const m = expModel(), r = X.toIFC(m, { seed: 'r41', time: 1700000000 });
  assert.ok(/IFCPIPEFITTING\(.*\.BEND\.\)/.test(r.text) && /IFCCABLECARRIERFITTING\(.*\.TEE\.\)/.test(r.text), 'фитинги');
  assert.strictEqual((r.text.match(/IFCRELCONNECTSELEMENTS\(/g) || []).length, 3);
  assert.strictEqual(r.counts.fittings, 2); assert.strictEqual(r.counts.pipes, 2); assert.strictEqual(r.counts.trays, 1);
  assert.ok(r.text.indexOf(X.ifcStr('Стояк')) > 0 && r.text.indexOf(X.ifcStr('Лоток лестничный N3')) > 0 && r.text.indexOf(X.ifcStr('Пучок кабелей N4')) > 0 && r.text.indexOf(X.ifcStr('Отвод трубы F1')) > 0);
  assert.ok(!/[^\x00-\x7f]/.test(r.text));
  const s = JSON.stringify(IFC.parseIFC ? IFC.parseIFC(r.text) : IFC.parse(r.text)); assert.ok(/Этаж 1/.test(s));
  const S = X.solids(m), rs = S.find((e) => e.id === 'N2');
  assert.ok(rs && rs.parts.length === 1 && rs.parts[0].vertical && Math.abs(rs.parts[0].z1 - rs.parts[0].z0 - 2.7) < 1e-6, 'стояк — вертикальное тело');
  const f1 = S.find((e) => e.id === 'F1'); assert.ok(f1 && f1.type === 'pipefitting' && f1.parts.length === 2 && f1.mat === 'pipe_red');
  assert.ok(S.find((e) => e.id === 'F2').type === 'cabletrayfitting');
  const o = X.toOBJ(m, { local: true }); assert.ok(/^o F1_pipefitting_elbow$/m.test(o.obj), 'OBJ');
  const dxf = X.toDXF(m, { local: true }); assert.ok(/S2B_01_SETI_FITINGI/.test(dxf) && /S2B_01_SETI_STOYAKI/.test(dxf));
  const sum = X.summary(m); assert.ok(/Стояков 1 \(2\.7 м\); узлов соединения 2 \(отводов 1, тройников 1, переходов 0\); лестничных лотков 1, пучков кабелей 1/.test(sum), sum);
  const rep = JSON.parse(X.report(m)); assert.ok(rep.mep.some((e) => e.kind === 'Стояк' && e.riser) && rep.mep.some((e) => e.kind === 'Отвод трубы' && e.angle === 90));
});

test('r41 окно и проводка: фитинги в слое «Сети», строки сводки; задание — стояки, перекрытие, соединения', () => {
  const m = expModel(), sc = UI.buildScene(m);
  assert.ok(sc.faces.filter((f) => f.L === 'mep').length >= 30);
  const ui = read('renderer/cloud-bim-ui.js'), job = read('scan2bim-job.js'), kb = read('ai/assistant-kb.js');
  assert.ok(/pipefitting: 'mep'/.test(ui) && /\['Стояки', /.test(ui) && /Узлы \(отводы, тройники, переходы\)/.test(ui));
  assert.ok(/MEP\.riserAcc\(/.test(job) && /MEP\.riserFind\(/.test(job) && /MEP\.mepConnect\(/.test(job) && /needCeiling: o\.mepNeedCeiling !== false/.test(job));
  assert.ok(/стояк/i.test(kb) && /тройник/i.test(kb));
});
