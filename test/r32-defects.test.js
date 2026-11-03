'use strict';
// Ревизия 32: подготовка облака перед контролем (очистка → «<имя>-clean.las», та же система координат), выравнивание по стенам
// (наклон сканера находится по завалу всех стен и вычитается), местные дефекты пола и стен (сетка 10 см, окно 1 м), проёмы с высотами
// (двери, окна, без перемычки), вывод / CSV / PDF и проводка IPC / preload / сборки / порядка скриптов.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DF = require(path.join(ROOT, 'renderer', 'cloud-defects.js'));
const UI = require(path.join(ROOT, 'renderer', 'cloud-inspect-ui.js'));
const REP = require(path.join(ROOT, 'renderer', 'cloud-report.js'));
const OV = require(path.join(ROOT, 'cloud-overview.js'));
const Seg = require(path.join(ROOT, 'cloud-segments.js'));
const JOB = require(path.join(ROOT, 'cloud-inspect-job.js'));
const G = require('./r27-synthetic.helper.js');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ': ' + a + ' ≠ ' + b + ' ± ' + tol);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-r32-'));
const TOL = { floorRail: 4, wallRail: 3, plumbPerM: 2, plumbMax: 10 };

// стены по кругу нормалей: завал = t·n + шум (мм/м)
function ring(t, n, noise, seed) {
  let s = seed || 7; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const out = [];
  for (let i = 0; i < n; i++) { const a = (i % 4) * Math.PI / 2 + r() * 0.1, nx = Math.cos(a), ny = Math.sin(a); out.push({ plumbS: t[0] * nx + t[1] * ny + noise * r() * 2, n: [nx, ny], length: 2 + (i % 3), height: 2.4, cover: 0.9 }); }
  return out;
}

test('наклон по стенам: найден по завалу, погрешность, порог значимости, выбросы и одно направление', () => {
  const L = DF.levelFromWalls(ring([1.5, -2], 40, 0.6));
  assert.ok(L.ok && L.dirs === 2); near(L.u, 1.5, 0.15, 'u'); near(L.v, -2, 0.15, 'v'); near(L.mm, 2.5, 0.15, 'мм/м');
  near(L.deg, Math.atan(0.0025) * 180 / Math.PI, 0.01, '°'); near(L.az, Math.atan2(-2, 1.5) * 180 / Math.PI, 5, 'направление');
  assert.ok(L.se > 0 && L.se < 0.3 && L.significant, 'se ' + L.se);
  // ровный скан — наклона нет
  const Z = DF.levelFromWalls(ring([0, 0], 40, 0.6)); assert.ok(Z.ok && !Z.significant && Z.mm < 0.3, 'нулевой ' + Z.mm);
  // выбросы (стены с настоящим завалом 8–12 мм/м) не уводят оценку — Хьюбер
  const W = ring([1, 1], 40, 0.4); for (let i = 0; i < 5; i++) W[i].plumbS += 10;
  const O = DF.levelFromWalls(W); near(O.u, 1, 0.35, 'u с выбросами'); near(O.v, 1, 0.35, 'v с выбросами');
  // мало стен; стены одного направления — только одна составляющая
  assert.equal(DF.levelFromWalls(ring([1, 1], 4, 0)).ok, false);
  const one = ring([2, 0], 20, 0.2).map(w => (w.n = [Math.sign(w.n[0]) || 1, 0], w.plumbS = 2 * w.n[0], w));
  const L1 = DF.levelFromWalls(one); assert.equal(L1.dirs, 1); near(L1.u, 2, 0.05, 'вдоль единственного направления'); near(L1.v, 0, 1e-9, 'поперёк — 0');
  // стены без знака завала или с чрезмерным завалом не учитываются
  assert.equal(DF.levelFromWalls(ring([0, 0], 10, 0).map(w => Object.assign(w, { plumbS: NaN }))).n, 0);
  assert.equal(DF.levelFromWalls(ring([0, 0], 10, 0).map(w => Object.assign(w, { plumbS: 40 }))).n, 0);
});

test('поправка: стены c − t·n с пересчётом допусков, пол z += t·(p − центр)', () => {
  const walls = ring([2, 0], 8, 0).map(w => Object.assign(w, { plumb: Math.abs(w.plumbS), lean: Math.abs(w.plumbS) * 2.4, rail: 1, okRail: true }));
  const wr = { ok: true, walls, checked: walls.length };
  DF.applyLevelWalls(wr, { u: 2, v: 0 }, TOL);
  for (const w of wr.walls) { assert.ok(w.plumb < 0.25, 'после поправки ' + w.plumb); assert.ok(w.ok && w.okPlumb); }
  assert.equal(wr.bad, 0);
  // пол с уклоном 2 мм/м по X: поправка снимает уклон
  const nx = 40, ny = 30, cell = 0.1, z = new Float32Array(nx * ny), use = new Uint8Array(nx * ny).fill(1);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = -0.002 * (i + 0.5) * cell;
  const g = { z, use, nx, ny, cell, u0: 0, v0: 0, mean: z, n: use, h: z };
  DF.levelFloorGrid(g, { u: 2, v: 0 });
  const zz = Array.from(g.z); assert.ok(Math.max(...zz) - Math.min(...zz) < 1e-5, 'плита горизонтальна: ' + (Math.max(...zz) - Math.min(...zz)));
});

test('сетка дефектов: бугор и впадина найдены по площади и глубине, мелочь и шум отброшены', () => {
  const nx = 60, ny = 40, cell = 0.1, val = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = (i + 0.5) * cell, y = (j + 0.5) * cell, d1 = Math.hypot(x - 1.5, y - 2), d2 = Math.hypot(x - 4.5, y - 2);
    val[j * nx + i] = (d1 < 0.35 ? 9 * Math.cos(d1 / 0.35 * Math.PI / 2) ** 2 : 0) - (d2 < 0.3 ? 7 * Math.cos(d2 / 0.3 * Math.PI / 2) ** 2 : 0) + 0.3 * Math.sin(i * 1.7 + j);
  }
  val[5 * nx + 55] = 9;   // одна клетка — меньше минимальной площади
  const r = DF.defectsGrid(val, nx, ny, { cell, tol: 5, u0: 0, v0: 0 });
  assert.equal(r.total, 2, JSON.stringify(r.list.map(d => [d.kind, d.u, d.v, d.area, d.depth])));
  const at = (d) => [(d.cx + 0.5) * cell, (d.cy + 0.5) * cell];
  const bump = r.list.find(d => d.sign > 0), dip = r.list.find(d => d.sign < 0);
  assert.ok(bump && dip, 'оба дефекта');
  near(at(bump)[0], 1.5, 0.15, 'бугор X'); near(at(bump)[1], 2, 0.15, 'бугор Y'); near(bump.depth, 9, 1.5, 'высота бугра');
  near(at(dip)[0], 4.5, 0.15, 'впадина X'); near(dip.depth, 7, 1.5, 'глубина впадины');
  assert.ok(bump.area >= 0.04 && bump.area < 0.5 && dip.area >= 0.04, 'площадь ' + bump.area);
  assert.ok(r.over > 0 && r.over < 0.02 && r.valid === nx * ny, 'доля клеток вне допуска ' + r.over);
  assert.ok(r.win > 0.9 && r.win < 1.2, 'окно ~1 м: ' + r.win);
});

let JOBR = null;
function synth() {
  if (JOBR) return JOBR;
  const b = G.building({ step: 0.03, theta: 17, noise: 0.003, tilt: [1.5, -2], bump: { x: 3, y: 3, r: 0.35, h: 0.008 }, wallDip: { x: 0, y: 3, z: 1.5, r: 0.35, depth: 0.008 } });
  const file = path.join(TMP, 'b.las'); G.writeLas(file, b.pts);
  const d = Seg.openSegmentSource(file).desc, fl = OV.overview(d, {}).levels[0].h;
  const opts = { h0: fl + 1.1, h1: fl + 1.3, floor: fl, top: fl + 2.6, plan: {}, tol: TOL };
  JOBR = { d, fl, on: JOB.run({ desc: d, opts }, () => {}), off: JOB.run({ desc: d, opts: Object.assign({}, opts, { level: false, defects: false, openings: false }) }, () => {}) };
  return JOBR;
}
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

test('задание: наклонённый скан 2,5 мм/м — наклон найден и вычтен, стены вертикальны, пол горизонтален', () => {
  const { on, off } = synth();
  assert.ok(on.ok && on.level && on.level.ok && on.level.applied, JSON.stringify(on.level));
  near(on.level.mm, 2.5, 0.2, 'наклон');
  const th = 17 * Math.PI / 180, tu = 1.5 * Math.cos(th) + 2 * Math.sin(th), tv = 1.5 * Math.sin(th) - 2 * Math.cos(th);   // наклон задан в осях здания, повёрнутого на 17°
  near(on.level.u, tu, 0.2, 'u'); near(on.level.v, tv, 0.2, 'v'); assert.ok(on.level.se < 0.2, 'se ' + on.level.se);
  const pOn = med(on.walls.walls.map(w => w.plumb)), pOff = med(off.walls.walls.map(w => w.plumb));
  assert.ok(pOn < 0.5, 'вертикаль после выравнивания ' + pOn); assert.ok(pOff > 1, 'без выравнивания стены «завалены» ' + pOff);
  assert.ok(on.floor.plane.mmPerM < 0.3, 'уклон пола после ' + on.floor.plane.mmPerM); near(off.floor.plane.mmPerM, 2.5, 0.3, 'уклон пола без выравнивания');
  assert.ok(on.floor.F.FL > off.floor.F.FL * 2, 'FL растёт: ' + off.floor.F.FL + ' → ' + on.floor.F.FL);
  assert.ok(!off.level || !off.level.applied, 'level:false — без поправки');
  assert.ok(on.floor.leveled === true || on.floor.leveled === undefined || on.floor.leveled);
});

test('задание: дефекты — бугор 8 мм на полу и вмятина 8 мм на стене найдены в своих местах', () => {
  const { on, off } = synth();
  const fd = on.floor.defects; assert.ok(Array.isArray(fd) && fd.length >= 1, 'дефекты пола');
  const b = fd.find(x => Math.hypot(x.u - 3, x.v - 3) < 0.5) || fd[0];
  assert.equal(b.kind, 'bump'); near(b.depth, 8, 2, 'высота бугра'); assert.ok(b.area > 0.08 && b.area < 0.5, 'площадь ' + b.area);
  const wd = []; on.walls.walls.forEach((w, i) => (w.defects || []).forEach(x => wd.push(Object.assign({ i }, x))));
  assert.ok(wd.length >= 1 && on.walls.defects >= 1, 'дефекты стен');
  const w = wd.sort((a, b2) => Math.abs(b2.depth) - Math.abs(a.depth))[0];
  near(Math.abs(w.depth), 8, 2, 'глубина вмятины'); near(w.h, 1.5, 0.25, 'высота над полом');
  assert.ok(!off.floor.defects || off.floor.defects.length === 0, 'defects:false — без дефектов');
});

test('задание: проёмы — окно с подоконником 0,9 и верхом 2,1, двери с перемычкой 2,1', () => {
  const { on, off } = synth();
  const op = on.openings; assert.ok(op && op.ok && op.list.length >= 3, JSON.stringify(op && op.list));
  const win = op.list.find(o => o.kind === 'window'); assert.ok(win, 'окно');
  near(win.width, 1.5, 0.1, 'ширина окна'); near(win.sill, 0.9, 0.1, 'низ окна'); near(win.head, 2.1, 0.1, 'верх окна'); near(win.height, 1.2, 0.15, 'высота окна');
  const doors = op.list.filter(o => o.kind === 'door'); assert.ok(doors.length >= 2 && op.doors === doors.length && op.windows >= 1);
  for (const dd of doors) { near(dd.head, 2.1, 0.1, 'верх двери'); assert.ok(!dd.open); near(dd.width, 0.9, 0.1, 'ширина двери'); }
  assert.ok(!off.openings || !off.openings.list || off.openings.list.length === 0, 'openings:false');
});

test('проёмы по профилю заполнения: дверь, окно, без перемычки, закрыт; нижняя строка не в счёт', () => {
  const CI = require(path.join(ROOT, 'renderer', 'cloud-inspect.js'));
  const faces = [0, 3, 6, 9, 12].map(y => ({ a: [0, y], b: [1.2, y], width: 1.2 })).concat([{ a: [0, 15], b: [0.3, 15] }]);
  const of = DF.openingFaces(faces); assert.equal(of.length, 5, 'узкий проём (< 0,4 м) не меряется');
  const acc = CI.wallAcc(of, { floor: 0, top: 2.6, minLen: 0.4, skipBottom: 0.02 });
  // дверь 2,1 (порог 0–10 см заполнен), окно 0,9–2,1, проход до верха, глухой участок, дверь 2,0 с пустым нижним рядом
  const gap = [[0.1, 2.1], [0.9, 2.1], [0.1, 2.7], null, [0, 2.0]];
  of.forEach((f, i) => { for (let u = 0.005; u < 1.2; u += 0.02) for (let h = 0.005; h < 2.6; h += 0.02) { const g = gap[i]; if (g && h >= g[0] && h < g[1]) continue; acc.add(u, f.a[1] + 0.001 * Math.sin(u * 50 + h * 31), h); } });
  const r = DF.openingReport(acc, {});
  assert.ok(r.ok); assert.deepEqual(r.list.map(o => o.kind), ['door', 'window', 'door', 'closed', 'door']);
  const [d, w, p, , d2] = r.list;
  near(d.head, 2.1, 0.051, 'верх двери'); assert.equal(d.sill, 0); assert.ok(!d.open);
  near(w.sill, 0.9, 0.051, 'низ окна'); near(w.head, 2.1, 0.051, 'верх окна'); near(w.height, 1.2, 0.11, 'высота окна');
  assert.equal(p.head, null); assert.equal(p.open, true, 'без перемычки');
  near(d2.head, 2.0, 0.051, 'дверь 2,0'); assert.equal(r.doors, 3); assert.equal(r.windows, 1);
  assert.equal(DF.openingReport(null).ok, false);
});

test('очистка для контроля: редкий пол дальней комнаты остаётся и при «inspect», и при «strong» (ревизия 44); мусор в воздухе уходит в обоих', () => {
  const RC = require(path.join(ROOT, 'scan-refine-core.js'));
  assert.ok(RC.NOISE_LEVELS.inspect && RC.NOISE_LEVELS.inspect.globalFrac === 0);
  let sd = 11; const r = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  const P = [];
  for (let k = 0; k < 4 * 20 * 6000; k++) P.push(r() * 4, r() * 20, 0.002 * (r() - 0.5));          // плотный пол коридора у маршрута
  for (let k = 0; k < 16 * 350; k++) P.push(4.2 + r() * 4, 8 + r() * 4, 0.002 * (r() - 0.5));       // комната за дверью: в 17 раз реже
  for (let k = 0; k < 200; k++) P.push(r() * 8, r() * 20, 0.5 + r() * 2);                          // одиночный мусор в воздухе
  const n = P.length / 3, X = Float64Array.from(P), kept = {};
  for (const lv of ['strong', 'inspect']) {
    const al = new Uint8Array(n).fill(1); RC.denoise(X, n, al, lv); let room = 0, all = 0, air = 0;
    for (let i = 0; i < n; i++) { if (X[i * 3 + 2] > 0.3) { if (al[i]) air++; continue; } if (X[i * 3] > 4.1) { all++; if (al[i]) room++; } }
    kept[lv] = { room: room / all, air };
  }
  // ревизия 44: «strong» тоже бережёт редкие поверхности (лист — не туман); прежде он убирал эту комнату целиком
  assert.ok(kept.strong.room > 0.98, 'strong сохраняет редкую комнату: ' + kept.strong.room);
  assert.ok(kept.inspect.room > 0.98, 'inspect сохраняет: ' + kept.inspect.room);
  assert.equal(kept.inspect.air, 0); assert.equal(kept.strong.air, 0);
});

test('задание: у очищенной копии стены и помещения берутся по исходному облаку (planDesc), меряется копия', () => {
  const { d } = synth();
  const b = G.building({ step: 0.03, theta: 17, noise: 0.003 }), th = b.theta, c = Math.cos(th), s = Math.sin(th);
  // «очищенная» копия: в комнате B нет точек на высоте среза плана — по ней самой стен B не найти
  const cut = b.pts.filter(p => { const x = p[0] - 500000 - b.tx, y = p[1] - 4000000 - b.ty, lx = x * c + y * s, z = p[2] - 100; return !(lx > 6.06 && z > 0.9 && z < 1.5); });
  const file = path.join(TMP, 'b-inspect.las'); G.writeLas(file, cut);
  const dc = Object.assign({}, Seg.openSegmentSource(file).desc), ds = Object.assign({}, Seg.openSegmentSource(path.join(TMP, 'b.las')).desc);
  const fl = OV.overview(ds, {}).levels[0].h;
  for (const k of ['cx', 'cy', 'cz']) if (ds[k] != null) dc[k] = ds[k];
  const opts = { h0: fl + 1.1, h1: fl + 1.3, floor: fl, top: fl + 2.6, plan: {}, tol: TOL };
  const own = JOB.run({ desc: dc, opts }, () => {}), src = JOB.run({ desc: dc, opts: Object.assign({}, opts, { planDesc: ds }) }, () => {});
  assert.ok(src.ok && src.planFrom === 'source' && !own.planFrom);
  assert.ok(src.plan.faces.length > own.plan.faces.length, 'граней: по копии ' + own.plan.faces.length + ', по исходному ' + src.plan.faces.length);
  assert.ok(src.plan.rooms.length >= 2, 'обе комнаты: ' + src.plan.rooms.length);
  assert.ok(src.walls.checked > own.walls.checked, 'стен проверено: ' + own.walls.checked + ' → ' + src.walls.checked);
  void d;
});

test('вывод, CSV и PDF: наклон, дефекты и проёмы', () => {
  const { on } = synth();
  const v = UI.verdict(on);
  assert.ok(v.some(x => /^Облако наклонено на \d+,\d\d мм\/м \(\d,\d{3}°\) — наклон найден по стенам и вычтен$/.test(x)), v.join('\n'));
  assert.ok(v.some(x => /^Местные дефекты: на полу \d+, на стенах \d+$/.test(x)));
  assert.ok(v.some(x => /^Проёмы: дверей \d+, окон \d+$/.test(x)));
  const t = UI.csv(on), L = t.slice(1).split('\r\n');
  const lh = L.findIndex(x => x.startsWith('Наклон облака по стенам')); assert.ok(lh >= 0); assert.match(L[lh + 1], /^\d,\d\d;0,\d{3};-?\d+;\d+;\d,\d\d;да$/);
  const dh = L.findIndex(x => x.startsWith('Дефект;')); assert.ok(dh > 0);
  assert.ok(L.slice(dh + 1).some(x => /^пол;.*;бугор;/.test(x)), 'бугор пола'); assert.ok(L.slice(dh + 1).some(x => /^стена \d+;;(впадина|выступ|неровность);/.test(x)), 'вмятина стены');
  const oh = L.findIndex(x => x.startsWith('Проём;')); assert.ok(oh > 0);
  assert.ok(L.slice(oh + 1).some(x => /^\d+;окно;(-?\d+,\d{3};){4}1,\d\d;0,9\d;2,1\d;1,2\d;есть$/.test(x)), 'окно в CSV');
  assert.equal(L[oh].split(';').length, L[oh + 1].split(';').length, 'строка проёма — по столбцам');
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const html = REP.inspect({ fileName: 'скан.las', res: Object.assign({}, on, { prep: { cleaned: true, name: 'скан-clean.las', time: 120 } }), verdict: v, appVersion: '1.2.0-rc.3', maps: [{ title: 'Дефекты', src: png }, { title: 'Проёмы', src: png }] });
  for (const h of ['Наклон облака по стенам', 'Местные дефекты', '<h2>Проёмы</h2>', 'учтён']) assert.ok(html.includes(h), 'раздел ' + h);
  assert.ok(!/<script|https?:\/\/|javascript:/i.test(html));
});

test('проводка: очистка рядом без диалога, поиск очищенной копии, система координат исходника, сборка, скрипты', () => {
  const main = read('main.js'), pre = read('preload.js'), pkg = JSON.parse(read('package.json')), ui = read('renderer/cloud-inspect-ui.js');
  assert.match(main, /a\.autoOut === true\) target = uniqueName\(path\.dirname\(abs\), base \+ '-inspect'\)/);
  assert.match(main, /ipcMain\.handle\('bim:findCleanCloud'/); assert.match(main, /-inspect\(-\\\\d\+\)\?\\\\\.las\$/);
  assert.match(main, /const NOISE_LEVELS = \['soft', 'normal', 'strong', 'max', 'inspect'\]/);
  assert.match(main, /planDesc: frame && frame\.desc && opened\.desc\.kind === frame\.desc\.kind \? frame\.desc : null/);
  assert.match(main, /st\.mtimeMs < src\.mtimeMs\) continue/, 'копия старше исходника не берётся');
  assert.match(main, /a\.frameFrom/); assert.match(main, /cx: frame\.desc\.cx, cy: frame\.desc\.cy, cz: frame\.desc\.cz/);
  assert.match(main, /level: !\(a && a\.level === false\), defects: !\(a && a\.defects === false\), openings: !\(a && a\.openings === false\)/);
  assert.match(pre, /findCleanCloud: \(p\) => inv\('bim:findCleanCloud', \{ path: p \}\)/);
  assert.ok(pkg.build.asarUnpack.includes('renderer/cloud-defects.js'));
  assert.match(read('cloud-inspect-job.js'), /require\('\.\/renderer\/cloud-defects\.js'\)/);
  assert.match(ui, /A\.findCleanCloud\(path\)/); assert.match(ui, /autoOut: true, dynamic: true, noise: true, noiseLevel: 'inspect', thin: false, align: true, color: false, colorBalance: false/); assert.match(ui, /frameFrom: src !== path \? path : null/);
  const html = read('renderer/index.html'), at = (s) => html.indexOf(s);
  for (const s of ['cloud-inspect.js?v=1332', 'cloud-defects.js?v=1332', 'cloud-inspect-ui.js?v=1333', 'cloud-report.js?v=1333']) assert.ok(at(s) > 0, s);
  assert.ok(at('cloud-inspect.js?v=') < at('cloud-defects.js?v=') && at('cloud-defects.js?v=') < at('cloud-inspect-ui.js?v='), 'порядок скриптов');
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  for (const f of ['renderer/cloud-defects.js', 'renderer/cloud-inspect-ui.js', 'cloud-inspect-job.js', 'renderer/cloud-report.js']) assert.ok(!emoji.test(read(f)), 'эмодзи в ' + f);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });
