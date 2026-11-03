'use strict';
// Ревизия 39: BIM-модель по облаку — задание scan2bim (этажи, стены, проёмы, материалы, колонны, перекрытия, объекты площадки)
// на синтетическом цветном LAS, выгрузка IFC4 / OBJ / DXF, разбор IFC с кириллицей (\X2\), окно CloudBimUI и проводка IPC.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'scan2bim-core.js'));
const JOB = require(path.join(ROOT, 'scan2bim-job.js'));
const X = require(path.join(ROOT, 'renderer', 'scan2bim-export.js'));
const UI = require(path.join(ROOT, 'renderer', 'cloud-bim-ui.js'));
const Seg = require(path.join(ROOT, 'cloud-segments.js'));
const IFC = require(path.join(ROOT, 'db', 'ifcImport.js'));
const DP = require(path.join(ROOT, 'renderer', 'dxfparse.js'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r39-'));

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
// LAS 1.2, формат 3 (цвет 16 бит), смещение 0
function writeLas(file, P) {
  const n = P.length / 6, H = 227, rec = 34, hd = Buffer.alloc(H), sc = 0.001, body = Buffer.alloc(n * rec);
  hd.write('LASF', 0); hd.writeUInt8(1, 24); hd.writeUInt8(2, 25); hd.writeUInt16LE(H, 94); hd.writeUInt32LE(H, 96); hd.writeUInt8(3, 104); hd.writeUInt16LE(rec, 105); hd.writeUInt32LE(n, 107);
  hd.writeDoubleLE(sc, 131); hd.writeDoubleLE(sc, 139); hd.writeDoubleLE(sc, 147);
  const mn = [1e18, 1e18, 1e18], mx = [-1e18, -1e18, -1e18];
  for (let i = 0; i < n; i++) {
    const b = i * rec;
    for (let k = 0; k < 3; k++) { const v = Math.round(P[i * 6 + k] / sc); body.writeInt32LE(v, b + k * 4); const w = v * sc; if (w < mn[k]) mn[k] = w; if (w > mx[k]) mx[k] = w; }
    body.writeUInt16LE(30000, b + 12);
    for (let k = 0; k < 3; k++) body.writeUInt16LE(P[i * 6 + 3 + k] * 257, b + 28 + k * 2);
  }
  hd.writeDoubleLE(mx[0], 179); hd.writeDoubleLE(mn[0], 187); hd.writeDoubleLE(mx[1], 195); hd.writeDoubleLE(mn[1], 203); hd.writeDoubleLE(mx[2], 211); hd.writeDoubleLE(mn[2], 219);
  fs.writeFileSync(file, Buffer.concat([hd, body]));
}
// здание 20 × 12 м, два этажа по 3,3 м, стены 0,3 м (обе грани), 1 этаж — кирпич, 2 этаж — штукатурка;
// окна 1,5 × 1,5 м (парапет 0,9 м) по 4 на длинных стенах (у двери — 1,0 м), дверь 1,0 × 2,1 м; круглая колонна d 0,4 м; дерево у здания
const BLD = { x0: 0, x1: 20, y0: 0, y1: 12, t: 0.3, hs: 3.3, n: 2 };
const WIN = [3, 7, 11, 15].map((s) => ({ s0: s, s1: s + 1.5 }));
function inHole(wall, s, z, storey) {
  if (wall === 'S' && storey === 0 && s >= 9 && s <= 10 && z < 2.1) return true;    // дверь
  if ((wall === 'S' || wall === 'N') && !(wall === 'S' && storey === 0 && s > 8 && s < 11)) {
    const zl = z - storey * BLD.hs; if (zl > 0.9 && zl < 2.4) for (const w of WIN) if (s > w.s0 && s < w.s1) return true;
  }
  return false;
}
function scene() {
  const r = rng(39), P = [], step = 0.04, J = () => (r() - 0.5) * step, N = () => (r() - 0.5) * 0.004;
  const push = (x, y, z, c) => { P.push(x, y, z, c[0], c[1], c[2]); };
  const brick = [150, 70, 50], plaster = [225, 220, 210], ground = [120, 118, 112], conc = [170, 170, 165], green = [60, 130, 50], bark = [90, 65, 40];
  const H = BLD.hs * BLD.n;
  // земля вокруг здания
  for (let x = -12; x < 32; x += step) for (let y = -10; y < 22; y += step) {
    const px = x + J(), py = y + J(); if (px > BLD.x0 && px < BLD.x1 && py > BLD.y0 && py < BLD.y1) continue; push(px, py, N(), ground);
  }
  // полы этажей и покрытие внутри
  for (let k = 0; k <= BLD.n; k++) for (let x = BLD.x0 + BLD.t; x < BLD.x1 - BLD.t; x += step) for (let y = BLD.y0 + BLD.t; y < BLD.y1 - BLD.t; y += step) push(x + J(), y + J(), k * BLD.hs + N(), conc);
  // стены: наружная и внутренняя грани
  const walls = [['S', [BLD.x0, BLD.y0], [1, 0], [0, -1], 20], ['N', [BLD.x1, BLD.y1], [-1, 0], [0, 1], 20], ['W', [BLD.x0, BLD.y1], [0, -1], [-1, 0], 12], ['E', [BLD.x1, BLD.y0], [0, 1], [1, 0], 12]];
  for (const [name, a, u, nrm, L] of walls) for (const off of [0, -BLD.t]) {
    for (let s = 0; s < L; s += step) for (let z = 0; z < H; z += step) {
      const ss = s + J(), zz = z + J(); if (ss < 0 || ss > L || zz < 0 || zz > H) continue;
      const st = Math.min(BLD.n - 1, Math.floor(zz / BLD.hs)), sAlong = name === 'S' || name === 'N' ? ss : ss;
      if (inHole(name, sAlong, zz, st)) continue;
      push(a[0] + u[0] * ss + nrm[0] * (off + N()), a[1] + u[1] * ss + nrm[1] * (off + N()), zz, st === 0 ? brick : plaster);
    }
  }
  // колонна d 0,4 в центре 1 этажа
  for (let z = 0; z < BLD.hs; z += step) for (let k = 0; k < 32; k++) { const f = (k + r()) / 32 * 2 * Math.PI; push(10 + 0.2 * Math.cos(f), 6 + 0.2 * Math.sin(f), z + J(), conc); }
  // дерево у западного торца: ствол 0,3 м до 2 м, крона r 1,6 м до 5,5 м
  for (let z = 0; z < 2.2; z += step) for (let k = 0; k < 20; k++) { const f = r() * 2 * Math.PI; push(-6 + 0.15 * Math.cos(f), 5 + 0.15 * Math.sin(f), z, bark); }
  for (let i = 0; i < 40000; i++) { const f = r() * 2 * Math.PI, e = Math.acos(2 * r() - 1), rr = 1.6 * Math.cbrt(r()); push(-6 + rr * Math.sin(e) * Math.cos(f), 5 + rr * Math.sin(e) * Math.sin(f), 3.9 + rr * Math.cos(e), green); }
  return new Float64Array(P);
}

let RUN = null;
function model() {
  if (RUN) return RUN;
  const file = path.join(TMP, 'bld.las'); writeLas(file, scene());
  const desc = Seg.openSegmentSource(file).desc, prog = [];
  const m = JOB.run({ desc, opts: { cell: 0.05, cover: 0.4, slabT: 0.25 } }, (p, l) => prog.push([p, l]));
  RUN = { m, prog, file };
  return RUN;
}
const walls = (m) => m.walls.filter((w) => w.role === 'wall');

test('scan2bim: два этажа по 3,3 м — уровни, стены по периметру, длина и высота', () => {
  const { m, prog } = model();
  assert.ok(m.ok, m.message);
  assert.strictEqual(m.format, 'bimtwin-scan2bim');
  assert.strictEqual(m.storeys.length, 2, 'этажей: ' + m.storeys.length + ' уровни ' + m.levels);
  assert.ok(Math.abs(m.levels[0]) < 0.1 && Math.abs(m.levels[1] - 3.3) < 0.1, 'уровни ' + m.levels);
  const W = walls(m);
  assert.ok(W.length >= 8, 'стен ' + W.length);
  for (const s of [0, 1]) {
    const L = W.filter((w) => w.storey === s).reduce((a, w) => a + w.length, 0);
    assert.ok(L > 55 && L < 72, 'длина стен этажа ' + (s + 1) + ': ' + L.toFixed(1));
  }
  assert.ok(prog.length > 5 && prog[prog.length - 1][0] >= 0.9, 'прогресс');
});

test('scan2bim: толщина стен с двух граней измерена, материал — кирпич на 1 этаже, штукатурка на 2', () => {
  const { m } = model();
  const W = walls(m).filter((w) => w.length > 5);
  const two = W.filter((w) => w.thicknessMeasured);
  assert.ok(two.length >= 4, 'стен с измеренной толщиной: ' + two.length);
  two.forEach((w) => assert.ok(Math.abs(w.thickness - 0.3) < 0.08, w.id + ' толщина ' + w.thickness));
  const s0 = W.filter((w) => w.storey === 0), s1 = W.filter((w) => w.storey === 1);
  assert.ok(s0.filter((w) => w.material === 'brick').length >= s0.length / 2, '1 этаж: ' + s0.map((w) => w.material));
  assert.ok(s1.filter((w) => w.material !== 'brick').length >= s1.length / 2, '2 этаж: ' + s1.map((w) => w.material));
});

test('scan2bim: окна и дверь на длинных стенах — ширина и подоконник', () => {
  const { m } = model();
  let win = 0, door = 0;
  walls(m).forEach((w) => w.openings.forEach((q) => {
    if (q.kind === 'window') { win++; assert.ok(q.width > 0.9 && q.width < 1.9, 'окно ' + q.width); assert.ok(q.sill > 0.6 && q.sill < 1.2, 'подоконник ' + q.sill); }
    else { door++; assert.ok(q.width > 0.7 && q.width < 1.4 && q.height > 1.7, 'дверь ' + q.width + '×' + q.height); }
  }));
  assert.ok(win >= 10, 'окон ' + win + ' (в облаке 15)');
  assert.ok(door >= 1, 'дверей ' + door);
});

test('scan2bim: колонна d 0,4 в здании, дерево вне, перекрытия по контуру', () => {
  const { m } = model();
  const O = m.origin, wx = (p) => [p[0] + O.cx, p[1] + O.cy];   // модель — в местных координатах от центра облака
  const col = m.columns.find((c) => Math.hypot(wx(c.c)[0] - 10, wx(c.c)[1] - 6) < 0.3);
  assert.ok(col, 'колонна: ' + JSON.stringify(m.columns.map((c) => c.c)));
  assert.ok(col.shape === 'round' && Math.abs(col.d - 0.4) < 0.06, 'сечение ' + col.shape + ' ' + col.d);
  const tree = m.objects.find((o) => (o.kind === 'tree' || o.kind === 'shrub') && Math.hypot(wx(o.c)[0] + 6, wx(o.c)[1] - 5) < 1.5);
  assert.ok(tree, 'дерево: ' + JSON.stringify(m.objects.map((o) => [o.kind, o.c])));
  assert.ok(tree.height > 4 && tree.height < 6.5, 'высота дерева ' + tree.height);
  assert.ok(m.slabs.length >= 2, 'перекрытий ' + m.slabs.length);
  m.slabs.forEach((s) => { assert.ok(s.area > 180 && s.area < 300, 'площадь ' + s.area); assert.strictEqual(s.thickness, 0.25); });
  assert.ok(m.slabs.some((s) => s.kind === 'roof'), 'покрытие');
});

test('scan2bim: IFC4 — элементы, проёмы с заполнением, кириллица \\X2\\ и разбор db/ifcImport', () => {
  const { m } = model();
  const r = X.toIFC(m, { name: 'Тест: здание', fileName: 'model.ifc', seed: 'r39', time: 1700000000 });
  assert.ok(/^ISO-10303-21;/.test(r.text) && /FILE_SCHEMA\(\('IFC4'\)\)/.test(r.text));
  for (const e of ['IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCWALL', 'IFCOPENINGELEMENT', 'IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT', 'IFCWINDOW', 'IFCDOOR', 'IFCSLAB', 'IFCCOLUMN', 'IFCMATERIAL', 'IFCRELASSOCIATESMATERIAL'])
    assert.ok(r.text.indexOf(e + '(') > 0, 'нет ' + e);
  assert.strictEqual((r.text.match(/IFCBUILDINGSTOREY\(/g) || []).length, 2);
  assert.ok(/\\X2\\[0-9A-F]+\\X0\\/.test(r.text), 'кириллица кодируется \\X2\\');
  assert.ok(!/[^\x00-\x7f]/.test(r.text), 'файл IFC — только ASCII');
  const again = X.toIFC(m, { name: 'Тест: здание', fileName: 'model.ifc', seed: 'r39', time: 1700000000 });
  assert.strictEqual(again.text, r.text, 'детерминированный GUID и текст');
  const p = IFC.parseIFC ? IFC.parseIFC(r.text) : IFC.parse(r.text);
  const s = JSON.stringify(p);
  assert.ok(/Этаж 1/.test(s), 'имя этажа раскодировано: ' + s.slice(0, 300));
});

test('scan2bim: OBJ + MTL и DXF планов по этажам', () => {
  const { m } = model();
  const o = X.toOBJ(m, { mtlName: 'model.mtl', local: true });
  assert.ok(o.vertices > 500 && o.elements > 20, 'OBJ ' + o.vertices + ' / ' + o.elements);
  assert.ok(/^mtllib model\.mtl/m.test(o.obj) && /^usemtl /m.test(o.obj) && /^newmtl /m.test(o.mtl));
  const fl = o.obj.split('\n').filter((l) => l.startsWith('f ')), nv = (o.obj.match(/^v /gm) || []).length;
  assert.ok(fl.every((l) => l.split(' ').slice(1).every((k) => +k >= 1 && +k <= nv)), 'индексы граней в пределах');
  const dxf = X.toDXF(m, { local: true });
  const parsed = DP.parse ? DP.parse(dxf) : DP.parseDxf(dxf);
  const txt = JSON.stringify(parsed).slice(0, 200000);
  assert.ok(/S2B_01_STENY/.test(dxf) && /S2B_02_STENY/.test(dxf) && /S2B_01_OKNA/.test(dxf) && /S2B_01_KOLONNY/.test(dxf), 'слои DXF');
  assert.ok(txt.length > 100);
  const sum = X.summary(m); assert.ok(/этажей 2/.test(sum) && /Кирпич/.test(sum), sum);
  const rep = JSON.parse(X.report(m)); assert.strictEqual(rep.walls.length, m.walls.length);
});

test('scan2bim-core: декодирование STEP-строк в обоих разборщиках IFC', () => {
  const txt = "ISO-10303-21;\nDATA;\n#1=IFCBUILDINGSTOREY('0aaaaaaaaaaaaaaaaaaaaa',$,'\\X2\\042D04420430043604\\X0\\ 1',$,$,$,$,$,.ELEMENT.,0.);\nENDSEC;\nEND-ISO-10303-21;\n";
  const a = JSON.stringify(IFC.parseIFC ? IFC.parseIFC(txt) : IFC.parse(txt));
  assert.ok(a.indexOf('Этаж 1') >= 0, a.slice(0, 300));
  const vm = require('vm'), sb = { window: {} }; vm.runInNewContext(read('renderer/ifc-import.js'), sb);
  const b = JSON.stringify(sb.window.IFCImport.parseIFC(txt));
  assert.ok(b.indexOf('Этаж 1') >= 0, 'renderer/ifc-import.js: ' + b.slice(0, 300));
  assert.strictEqual(X.ifcStr("Стена 'А'"), "'\\X2\\042104420435043D0430\\X0\\ ''\\X2\\0410\\X0\\'''");
});

test('окно CloudBimUI: сцена превью, сводка этажей и материалов', () => {
  const { m } = model();
  const sc = UI.buildScene(m);
  assert.ok(sc && sc.faces.length > 200, 'граней ' + (sc && sc.faces.length));
  assert.ok(sc.hi[2] - sc.lo[2] > 6, 'высота сцены');
  const rows = UI.storeyRows(m); assert.strictEqual(rows.length, 2); assert.ok(rows[0].windows + rows[0].doors >= 4);
  const mats = UI.materials(m); assert.ok(mats.length >= 1 && mats[0].length > 10);
  const k = UI.kpis(m); assert.strictEqual(k[0][0], 2);
  // отрисовка на поддельном canvas: число заливок = число видимых граней
  let fills = 0; const ctx = new Proxy({}, { get: (t, p) => p === 'fill' ? () => { fills++; } : (typeof t[p] !== 'undefined' ? t[p] : () => {}), set: (t, p, v) => { t[p] = v; return true; } });
  const cv = { width: 400, height: 300, getContext: () => ctx };
  UI.drawScene(cv, sc, { yaw: -0.7, pitch: 0.5, zoom: 1, px: 0, py: 0, storey: -1, layers: { walls: true, open: true, slabs: true, columns: true, site: true } });
  assert.ok(fills >= sc.faces.length * 0.9, 'заливок ' + fills);
  fills = 0; UI.drawScene(cv, sc, { yaw: 0, pitch: 0.5, zoom: 1, px: 0, py: 0, storey: 1, layers: { walls: true, open: false, slabs: false, columns: true, site: true } });
  assert.ok(fills > 0 && fills < sc.faces.length / 2, 'этаж 2 без проёмов: ' + fills);
});

test('проводка: IPC bim:scan2bim и показ папки, preload, поток, кнопка BIM, index.html, package.json', () => {
  const main = read('main.js'), pre = read('preload.js'), wk = read('cloud-overview-worker.js'), cp = read('renderer/cloud-preview.js'), html = read('renderer/index.html'), pkg = JSON.parse(read('package.json'));
  assert.ok(/ipcMain\.handle\('bim:scan2bim'/.test(main) && /runOverviewWorker\('scan2bim'/.test(main));
  assert.ok(/ipcMain\.handle\('bim:scan2bimReveal'/.test(main) && /scan2bimDirs\.has\(/.test(main), 'папка — только созданная выгрузкой');
  assert.ok(/put\('model\.ifc'/.test(main) && /put\('plans\.dxf'/.test(main) && /put\('model\.obj'/.test(main));
  assert.ok(/cloudScan2Bim: \(payload\) => inv\('bim:scan2bim'/.test(pre) && /cloudScan2BimReveal:/.test(pre));
  assert.ok(/d\.job === 'scan2bim'/.test(wk) && /require\('\.\/scan2bim-job'\)/.test(wk));
  assert.ok(/data-act="bim"/.test(cp) && /W\.CloudBimUI\.open\(path, ov, st\)/.test(cp));
  const iE = html.indexOf('scan2bim-export.js?v='), iU = html.indexOf('cloud-bim-ui.js?v='), iP = html.indexOf('cloud-preview.js?v='), iD = html.indexOf('dxf.js?v=');
  assert.ok(iD > 0 && iE > iD && iU > iE && iP > iU, 'порядок скриптов');
  for (const f of ['scan2bim-core.js', 'scan2bim-job.js']) { assert.ok(pkg.build.files.includes(f), 'files ' + f); assert.ok(pkg.build.asarUnpack.includes(f), 'asarUnpack ' + f); }
});
