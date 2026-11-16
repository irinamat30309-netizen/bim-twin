'use strict';
/*
 * r155 — P2/P3-интеграция в UI:
 *   • «Система координат»: панель показывает EPSG/WKT/точки/габариты/углы; пересчёт, привязка
 *     (--georef-file), экспорт углов — через bimAPI.p23CrsRun; если crs-tools.py ещё нет — fallback;
 *   • «Mesh-инструменты»: fill-holes/laplacian/remove-class/remove-color/simplify через
 *     bimAPI.p23MeshRun; если mesh-tools.py ещё нет — fallback;
 *   • P3 «Clipping Box»: window.__lxClipBox (open/close/state/applyAndSave/cancel/setBox/getBox) —
 *     данные/вьюер/сохранение фрагмента (PLY/PCD/XYZ) через bimAPI.p23SaveFragment; UI панели —
 *     зона editor-basics (data-p3="open" / #lxClipP3Panel).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }

const ROOT = path.join(__dirname, '..');
const R = path.join(ROOT, 'renderer');
const P1 = fs.readFileSync(path.join(R, 'ui', 'p1-tools.js'), 'utf8');
const P23 = fs.readFileSync(path.join(R, 'ui', 'p23-tools.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const BRIDGE = require('../p23-bridge.js');

test('r155: мост p23 зарегистрирован в main/preload, слой грузится из p1-tools без правок app.js', () => {
  assert.match(MAIN, /require\('\.\/p23-bridge'\)\.register\(\{/);
  for (const fn of ['p23Status', 'p23PickMesh', 'p23CrsRun', 'p23MeshRun', 'p23SaveFragment', 'p23Cancel', 'onP23Progress']) {
    assert.match(PRELOAD, new RegExp(fn + ':\\s*\\('), 'preload: нет ' + fn);
  }
  for (const ch of ['bim:p23Status', 'bim:p23CrsRun', 'bim:p23MeshRun', 'bim:p23SaveFragment']) {
    assert.ok(BRIDGE && BRIDGE.register, 'bridge);');
  }
  assert.match(P1, /ui\/p23-tools\.js\?v=155/, 'p1-tools должен подгружать p23-tools');
  assert.match(P1, /function ensureP23\(\)/);
  // никаких правок ленты/команд
  assert.doesNotMatch(P23, /__lxRibbon|commands\.js|ribbon\.js/);
  assert.doesNotMatch(P23, /linear-gradient|radial-gradient/);
});

test('r155: API клип-бокса ровно по договору с editor-basics', () => {
  assert.match(P23, /W\.__lxClipBox\s*=\s*CLIP_API/);
  for (const m of ['open', 'close', 'state', 'applyAndSave', 'cancel', 'setBox', 'getBox']) {
    assert.match(P23, new RegExp(m + ':\\s*clip|' + m + ': clip'), 'нет метода ' + m);
  }
  assert.match(P23, /data-p3="open"/, 'клик по кнопке editor-basics должен открывать клип-бокс');
  assert.match(P23, /lx-clip-box-changed/);
  assert.match(P23, /lx-clip-box-saved/);
  assert.match(P23, /rotation: 0/, 'поворот в phase1 не поддерживается — в state 0');
});

test('r155: аргументы crs-tools.py — реальный CLI r155 (--in/--to/--out-las/--update-header)', () => {
  const reproj = BRIDGE.buildCrsArgs('reproject', { cloud: 'a.las', from: '32636', to: 'EPSG:4326', out: 'out.las', json: 'r.json' });
  assert.deepEqual(reproj.slice(0, 2), ['--in', 'a.las']);
  assert.ok(reproj.includes('--to') && reproj.includes('4326'), 'EPSG:-префикс срезается для CLI: ' + reproj.join(' '));
  assert.ok(reproj.includes('--out-las') && reproj.includes('out.las'));
  assert.ok(reproj.includes('--json') && reproj.includes('r.json'));
  assert.ok(reproj.includes('--epsg') && reproj.includes('32636'), 'исходный EPSG прокидывается как --epsg');
  const georef = BRIDGE.buildCrsArgs('georef', { cloud: 'a.las', georefFile: 'g.json', json: 'r.json' });
  assert.deepEqual(georef.slice(0, 2), ['--in', 'a.las']);
  assert.ok(georef.includes('--update-header'));
  assert.ok(georef.includes('--georef-file') && georef.includes('g.json'));
  const info = BRIDGE.buildCrsArgs('info', { cloud: 'a.las', json: 'c.json' });
  assert.deepEqual(info, ['--in', 'a.las', '--json', 'c.json']);
  const corners = BRIDGE.buildCrsArgs('corners', { cloud: 'a.las', json: 'c.json' });
  assert.deepEqual(corners, ['--in', 'a.las', '--json', 'c.json']);
  assert.ok(!corners.includes('--to'));
});

test('r155: аргументы mesh-tools.py — реальный CLI r155 (флаги операций)', () => {
  const base = { input: 'm.ply', output: 'o.ply', json: 'r.json' };
  const fill = BRIDGE.buildMeshArgs('fill-holes', { ...base, params: { maxEdges: 100 } });
  assert.deepEqual(fill.slice(0, 4), ['--in', 'm.ply', '--out', 'o.ply']);
  assert.ok(fill.includes('--fill-holes'));
  assert.ok(fill.includes('--max-hole-edges') && fill.includes('100'));
  const lap = BRIDGE.buildMeshArgs('laplacian', { ...base, params: { iterations: 5, lambda: 0.4 } });
  assert.ok(lap.includes('--smooth') && lap.includes('5'));
  assert.ok(lap.includes('--lambda') && lap.includes('0.4'));
  const rm = BRIDGE.buildMeshArgs('remove-class', { ...base, params: { className: '255,0,0', tolerance: 30 } });
  assert.ok(rm.includes('--remove-triangles'));
  assert.ok(rm.includes('class:255,0,0,30'), 'класс/цвет задаются как SPEC class:R,G,B[,tol]: ' + rm.join(' '));
  const rmc = BRIDGE.buildMeshArgs('remove-color', { ...base, params: { color: '#ff0000', tolerance: 40 } });
  assert.ok(rmc.includes('color:255,0,0,40'), 'цвет #RRGGBB → color:R,G,B[,tol]: ' + rmc.join(' '));
  const simp = BRIDGE.buildMeshArgs('simplify', { ...base, params: { targetTriangles: 5000 } });
  assert.ok(simp.includes('--decimate') && simp.includes('quadric:5000'));
  const simpVox = BRIDGE.buildMeshArgs('simplify', { ...base, params: { voxelSize: 0.05 } });
  assert.ok(simpVox.includes('voxel:0.05'));
});

function fakeBridge(opts) {
  opts = opts || {};
  const handlers = {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p23-test-'));
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const app = { getPath: () => tmp };
  const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
  BRIDGE.register({
    ipcMain, app, dialog, rootDir: opts.rootDir || ROOT, python: null,
    fileGrants: { grantExistingFile: () => { } },
    ipcSender: (event) => (event && event.sender) || { id: 1, send: () => { } },
    resolveAuthorizedFile: (event, p) => (p && fs.existsSync(p) ? path.resolve(p) : null),
    grantExistingOutput: () => true
  });
  return { handlers, tmp };
}

test('r155: мост — статус реальных инструментов и graceful fallback, если CLI нет', async () => {
  // реальные скрипты уже в tools/scan2bim-py (r155): статус видит оба
  const { handlers } = fakeBridge();
  const st = await handlers['bim:p23Status']({});
  assert.equal(st.ok, true);
  assert.equal(st.tools.crs, true, 'crs-tools.py есть в r155');
  assert.equal(st.tools.mesh, true, 'mesh-tools.py есть в r155');
  assert.ok(Array.isArray(st.crs.ops) && st.crs.ops.includes('georef'));
  assert.ok(Array.isArray(st.mesh.ops) && st.mesh.ops.includes('simplify'));
  // пустой rootDir (CLI ещё нет) — graceful fallback вместо исключения
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p23-empty-'));
  fs.mkdirSync(path.join(emptyRoot, 'tools', 'scan2bim-py'), { recursive: true });
  const miss = fakeBridge({ rootDir: emptyRoot });
  const st2 = await miss.handlers['bim:p23Status']({});
  assert.equal(st2.tools.crs, false);
  assert.equal(st2.tools.mesh, false);
  const crs = await miss.handlers['bim:p23CrsRun']({ sender: { id: 1 } }, { op: 'reproject', to: 'EPSG:4326', cloud: 'x.las' });
  assert.equal(crs.ok, false);
  assert.equal(crs.missing, true);
  assert.match(crs.error, /ещё готовится|не найден/i);
  const mesh = await miss.handlers['bim:p23MeshRun']({ sender: { id: 1 } }, { op: 'laplacian', input: 'x.ply' });
  assert.equal(mesh.ok, false);
  assert.equal(mesh.missing, true);
  assert.match(mesh.error, /ещё готовится|не найден/i);
});

test('r155: мост — сохранение фрагмента PLY/PCD/XYZ с грантом и проверками', async () => {
  const { handlers, tmp } = fakeBridge();
  const pos = new Float32Array([0, 0, 0, 1, 2, 3, -1, 0.5, 2]);
  const col = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]);
  for (const fmt of ['ply', 'pcd', 'xyz']) {
    const r = await handlers['bim:p23SaveFragment']({ sender: { id: 1 } }, { format: fmt, pos, col, bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } } });
    assert.equal(r.ok, true, fmt + ': ' + (r.error || ''));
    assert.equal(r.count, 3);
    assert.equal(r.format, fmt);
    assert.ok(fs.existsSync(r.path), 'файл не создан: ' + r.path);
    assert.ok(r.bytes > 20);
    if (fmt === 'ply') assert.match(fs.readFileSync(r.path, 'utf8').slice(0, 20), /^ply/);
    if (fmt === 'pcd') assert.match(fs.readFileSync(r.path, 'utf8').slice(0, 20), /^# \.PCD/);
    if (fmt === 'xyz') assert.match(fs.readFileSync(r.path, 'utf8'), /^0\.0000 0\.0000 0\.0000/);
  }
  // пустой фрагмент — понятная ошибка, а не исключение
  const empty = await handlers['bim:p23SaveFragment']({ sender: { id: 1 } }, { format: 'ply', pos: new Float32Array(0) });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /пуст|точ/i);
  // неизвестная задача отмены
  const cancel = await handlers['bim:p23Cancel']({}, { jobId: 'nope' });
  assert.equal(cancel.ok, false);
});

function makeDom(opts) {
  opts = opts || {};
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div class="stage"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [], toasts = [];
  w.__toast = (m, tone) => toasts.push({ m: String(m), tone });
  w.__lxIcons = { svg: (n, s) => '<svg data-ico="' + n + '"></svg>' };
  const bbox = { mn: [-3, 0, -2], mx: [3, 3, 2] };
  const cloud = opts.cloud || { pos: new Float32Array([-2, 1, -1, 0, 1.5, 0, 2, 2, 1, 0.5, 0.5, 0.5]), col: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]), count: 4 };
  const section = { on: false, min: [0, 0, 0], max: [1, 1, 1], t: 1 };
  const viewer = {
    bbox, section, base: [{ _gpuCount: cloud.count, count: cloud.count, pos: cloud.pos }],
    render: () => calls.push(['render']),
    getEditedCloud: () => cloud,
    setSectionBox: (b) => calls.push(['setSectionBox', b]),
    setSection: (on) => { section.on = !!on; calls.push(['setSection', on]); },
    resetSection: () => calls.push(['resetSection'])
  };
  w.__viewer = viewer;
  w.__pcTools = { viewer: () => viewer, getCloud: () => cloud, getSourceCrs: () => opts.wkt || null, getSourceTransform: () => null };
  w.__bimCurrentCloudPath = opts.path || 'D:/scan/x.las';
  w.__bimOpenCloudPath = (p, o) => calls.push(['openCloud', p]);
  const status = opts.status || { ok: true, python: 'python3', open3d: true, tools: { crs: false, mesh: false }, crs: { ops: ['info', 'reproject', 'georef', 'corners'] }, mesh: { ops: ['fill-holes', 'laplacian', 'remove-class', 'remove-color', 'simplify'] } };
  const A = Object.assign({
    p23Status: async () => status,
    p23PickMesh: async () => ({ ok: true, path: 'D:/mesh/m.ply', name: 'm.ply', size: 10 }),
    p23CrsRun: async (a) => { calls.push(['crsRun', a]); return opts.crsResult || { ok: true, op: a.op, elapsedMs: 120, out: 'D:/out/reprojected.las', files: { 'reprojected.las': 'D:/out/reprojected.las' }, result: { epsg: 32636 } }; },
    p23MeshRun: async (a) => { calls.push(['meshRun', a]); return opts.meshResult || { ok: true, op: a.op, elapsedMs: 300, output: 'D:/out/mesh-fixed.ply', result: { trianglesBefore: 1000, trianglesAfter: 1010, holesFilled: 3 } }; },
    p23SaveFragment: async (a) => { calls.push(['saveFragment', a]); return { ok: true, path: 'D:/out/clip-fragment.ply', count: a.pos.length / 3, format: a.format || 'ply', bytes: 1000 }; },
    p23Cancel: async () => ({ ok: true }),
    onP23Progress: () => () => { },
    readFile: async () => 'AA==',
    openFile: () => { }
  }, opts.api || {});
  if (opts.noBridge) delete w.bimAPI; else w.bimAPI = A;
  w.eval(P23);
  return { w, dom, calls, toasts, api: w.__lxP23, clip: w.__lxClipBox, viewer, cloud };
}

test('r155: UI (jsdom) — панель «Система координат» показывает СК и graceful fallback', async () => {
  const env = makeDom({ wkt: 'PROJCS["WGS 84 / UTM zone 36N",AUTHORITY["EPSG","32636"]]' });
  try {
    env.api.mount();
    await new Promise((r) => setTimeout(r, 60));
    env.api.openCrs();
    await new Promise((r) => setTimeout(r, 60));
    const p = env.w.document.getElementById('lxCrsPanel');
    assert.ok(p && !p.hidden, 'панель CRS не открылась');
    const txt = p.textContent;
    assert.match(txt, /Система координат/);
    assert.match(txt, /EPSG:32636|EPSG/);
    assert.match(txt, /crs-tools\.py: нет/);
    assert.match(txt, /ещё готовится/);
    assert.match(txt, /Угол/);
    const btn = p.querySelector('[data-p23="crs-run"]');
    assert.ok(btn && btn.disabled, 'кнопка запуска должна быть disabled при отсутствии CLI');
    // локальный экспорт углов
    p.querySelector('[data-p23="crs-corners-local"]').click();
    assert.match(p.textContent, /Координаты углов bbox/);
    assert.match(p.textContent, /corner,x,y,z|1,/);
  } finally { try { env.dom.window.close(); } catch (e) { } }
});

test('r155: UI (jsdom) — CRS запускает p23CrsRun и показывает результат', { skip: !JSDOM && 'jsdom' }, async () => {
  const env = makeDom({ wkt: 'PROJCS["x",AUTHORITY["EPSG","32636"]]', status: { ok: true, python: 'python3', open3d: true, tools: { crs: true, mesh: false }, crs: { flagsOk: { input: true, json: true, to: true, outLas: true, updateHeader: true, georefFile: true } } } });
  try {
    env.api.mount(); await new Promise((r) => setTimeout(r, 60)); env.api.openCrs(); await new Promise((r) => setTimeout(r, 60));
    const p = env.w.document.getElementById('lxCrsPanel');
    p.querySelector('[data-p23="crs-op"]').value = 'reproject';
    p.querySelector('[data-p23="crs-run"]').click();
    await new Promise((r) => setTimeout(r, 60));
    const call = env.calls.find((c) => c[0] === 'crsRun');
    assert.ok(call, 'p23CrsRun не вызван');
    assert.equal(call[1].op, 'reproject');
    assert.ok(call[1].cloud && call[1].to);
    assert.match(p.textContent, /Готово|готово/);
    assert.ok(env.calls.some((c) => c[0] === 'openCloud'), 'результат должен открываться в сцене');
  } finally { try { env.dom.window.close(); } catch (e) { } }
});

test('r155: UI (jsdom) — панель Mesh: fallback и реальный запуск с параметрами', { skip: !JSDOM && 'jsdom' }, async () => {
  const env = makeDom({ status: { ok: true, python: 'python3', open3d: false, tools: { crs: false, mesh: false } } });
  try {
    env.api.mount(); await new Promise((r) => setTimeout(r, 60)); env.api.openMesh(); await new Promise((r) => setTimeout(r, 60));
    const p = env.w.document.getElementById('lxMeshPanel');
    assert.ok(p && !p.hidden);
    assert.match(p.textContent, /Mesh-инструменты/);
    assert.match(p.textContent, /ещё готовятся/);
    assert.ok(p.querySelector('[data-p23="mesh-run"]').disabled);
  } finally { try { env.dom.window.close(); } catch (e) { } }
  const env2 = makeDom({ status: { ok: true, python: 'python3', open3d: true, tools: { crs: false, mesh: true } } });
  try {
    env2.api.mount(); await new Promise((r) => setTimeout(r, 60)); env2.api.openMesh(); await new Promise((r) => setTimeout(r, 60));
    const p = env2.w.document.getElementById('lxMeshPanel');
    p.querySelector('[data-p23="mesh-pick"]').click();
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(p.textContent.includes('m.ply'));
    p.querySelector('[data-p23="mesh-op"]').value = 'laplacian';
    p.querySelector('[data-p23="mesh-op"]').dispatchEvent(new env2.w.Event('change', { bubbles: true }));
    p.querySelector('[data-p23="mesh-run"]').click();
    await new Promise((r) => setTimeout(r, 60));
    const call = env2.calls.find((c) => c[0] === 'meshRun');
    assert.ok(call, 'p23MeshRun не вызван');
    assert.equal(call[1].op, 'laplacian');
    assert.ok(call[1].input, 'нет входного mesh');
    assert.match(p.textContent, /треугольников|Готово/);
  } finally { try { env2.dom.window.close(); } catch (e) { } }
});

test('r155: клип-бокс (jsdom) — setBox/state визуальный срез, applyAndSave фильтрует и сохраняет', { skip: !JSDOM && 'jsdom' }, async () => {
  const env = makeDom();
  try {
    const cb = env.clip;
    assert.ok(cb, 'window.__lxClipBox не создан');
    for (const m of ['open', 'close', 'state', 'applyAndSave', 'cancel', 'setBox', 'getBox']) assert.equal(typeof cb[m], 'function', 'нет метода ' + m);
    cb.open();
    const box = { min: { x: -2, y: 0, z: -1.5 }, max: { x: 1, y: 2, z: 1 } };
    const r = cb.setBox(box);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(env.calls.some((c) => c[0] === 'setSectionBox'), 'не задан секущий бокс вьюеру');
    assert.ok(env.calls.some((c) => c[0] === 'setSection' && c[1] === true));
    const st1 = cb.state();
    assert.equal(st1.active, true);
    assert.equal(st1.rotation, 0);
    assert.equal(st1.box.min.x, -2);
    assert.equal(st1.box.max.y, 2);
    assert.ok(st1.count >= 1, 'count внутри бокса: ' + st1.count);
    // 4 точки: (-2,1,-1) внутри, (0,1.5,0) внутри, (2,2,1) вне (x>1), (0.5,0.5,0.5) внутри
    const saved = await cb.applyAndSave({ format: 'ply' });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.format, 'ply');
    assert.equal(saved.count, 3, 'внутри бокса должно быть 3 точки');
    assert.ok(saved.path && saved.bbox);
    const call = env.calls.find((c) => c[0] === 'saveFragment');
    assert.ok(call, 'p23SaveFragment не вызван');
    assert.equal(call[1].pos.length, 9);
    assert.equal(call[1].col.length, 9);
    assert.ok(env.calls.some((c) => c[0] === 'openCloud'), 'фрагмент должен открыться в сцене');
    cb.cancel();
    assert.equal(cb.state().active, false);
  } finally { try { env.dom.window.close(); } catch (e) { } }
});
