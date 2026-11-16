'use strict';
/*
 * r159 — приёмка P2/P3: открытие Mesh-операций при установленном Open3D,
 * прогресс/ошибки, программный выбор mesh (E2E), .xcord и форматы фрагмента.
 * Плюс source-level инварианты: мост ищет Python с Open3D, панель не блокируется,
 * clip-p3.js editor-basics использует наш __lxClipBox.
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
const P23 = fs.readFileSync(path.join(R, 'ui', 'p23-tools.js'), 'utf8');
const CLIP = fs.readFileSync(path.join(R, 'ui', 'clip-p3.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const BRIDGE = require('../p23-bridge.js');

function fakeBridge(opts) {
  opts = opts || {};
  const handlers = {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p23-r159-'));
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const app = { getPath: () => tmp };
  const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
  const deps = {
    ipcMain, app, dialog, rootDir: opts.rootDir || ROOT, python: null,
    fileGrants: { grantExistingFile: () => { } },
    ipcSender: (event) => (event && event.sender) || { id: 1, send: () => { } },
    resolveAuthorizedFile: (event, p) => (p && fs.existsSync(p) ? path.resolve(p) : null),
    grantExistingOutput: () => true
  };
  if (Object.prototype.hasOwnProperty.call(opts, 'open3dPython')) deps.open3dPython = opts.open3dPython;
  BRIDGE.register(deps);
  return { handlers, tmp };
}

test('r159: мост умеет искать Python с Open3D (Mesh) отдельно от обычного Python (CRS)', () => {
  assert.equal(typeof BRIDGE.findOpen3dPython, 'function');
  assert.equal(typeof BRIDGE.findPython, 'function');
  assert.equal(typeof BRIDGE.pythonCandidates, 'function');
  const cands = BRIDGE.pythonCandidates();
  assert.ok(Array.isArray(cands) && cands.length >= 3);
  assert.ok(cands.some((c) => /Python311[\\/]python\.exe/i.test(c)), 'известный путь Python 3.11 в кандидатах: ' + cands.join(' | '));
  assert.match(P23, /setMeshFile/, 'UI должен уметь программно выбрать mesh для автотестов/E2E');
  assert.match(P23, /lcc2ReadFile/, 'результат mesh читается по грантам (lcc2ReadFile), bim:readFile ограничен uploads');
  assert.match(PRELOAD, /p23GrantMesh:/);
  assert.match(MAIN, /require\('\.\/p23-bridge'\)\.register\(\{/);
});

test('r159: status.open3d отражает переданный Open3D-Python, а mesh не возвращает needOpen3D', async () => {
  const mesh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p23-mesh-')), 'hole.ply');
  fs.writeFileSync(mesh, 'ply\nformat ascii 1.0\nelement vertex 0\nend_header\n');
  const fakePy = 'C:/definitely/not/python.exe';
  const { handlers } = fakeBridge({ open3dPython: fakePy });
  const st = await handlers['bim:p23Status']({});
  assert.equal(st.open3d, true, 'status.open3d должен быть true при найденном Open3D');
  // грант mesh-файла
  const g = await handlers['bim:p23GrantMesh']({ sender: { id: 1 } }, { paths: [mesh] });
  assert.equal(g.ok, true, JSON.stringify(g));
  const badExt = path.join(path.dirname(mesh), 'x.las');
  fs.writeFileSync(badExt, 'x');
  const g2 = await handlers['bim:p23GrantMesh']({ sender: { id: 1 } }, { paths: [badExt] });
  assert.equal(g2.ok, false);
  assert.match(g2.error, /mesh|PLY|OBJ|STL/i);
  // запуск с open3d-python (несуществующий): ошибка запуска, но НЕ needOpen3D
  const run = await handlers['bim:p23MeshRun']({ sender: { id: 1 } }, { op: 'fill-holes', input: mesh });
  assert.equal(run.ok, false);
  assert.equal(!!run.needOpen3D, false, 'при найденном Open3D needOpen3D быть не должно: ' + JSON.stringify(run));
});

test('r159: без Open3D mesh честно просит движок (fallback сохранён)', async () => {
  const { handlers } = fakeBridge(); // python задан null, open3dPython не задан → нет Open3D
  const st = await handlers['bim:p23Status']({});
  assert.equal(st.open3d, false);
  const mesh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p23-mesh2-')), 'm.ply');
  fs.writeFileSync(mesh, 'ply\nformat ascii 1.0\nelement vertex 0\nend_header\n');
  await handlers['bim:p23GrantMesh']({ sender: { id: 1 } }, { paths: [mesh] });
  const run = await handlers['bim:p23MeshRun']({ sender: { id: 1 } }, { op: 'laplacian', input: mesh });
  assert.equal(run.ok, false);
  assert.equal(run.needOpen3D, true);
  assert.match(run.error, /Open3D/);
});

test('r159: источник clip-UI editor-basics использует наш API, форматы PLY/PCD/XYZ и .xcord', () => {
  for (const m of ['open', 'close', 'setBox', 'applyAndSave', 'cancel', 'state', 'getBox']) {
    assert.ok(CLIP.includes('.' + m), 'clip-p3.js не использует __lxClipBox.' + m);
  }
  assert.match(CLIP, /data-p3-format/);
  assert.match(CLIP, /PLY/); assert.match(CLIP, /PCD/); assert.match(CLIP, /XYZ/);
  assert.match(CLIP, /xcordCSV/); assert.match(CLIP, /xcordXML/);
  assert.match(CLIP, /download\(/, '.xcord должен скачиваться файлом');
  // никаких правок ленты
  assert.doesNotMatch(P23, /__lxRibbon|ribbon\.js/);
});

function makeDom(opts) {
  opts = opts || {};
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div class="stage"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [], toasts = [];
  w.__toast = (m, tone) => toasts.push({ m: String(m), tone });
  w.__lxIcons = { svg: () => '' };
  const bbox = { mn: [-3, 0, -2], mx: [3, 3, 2] };
  const cloud = { pos: new Float32Array([-2, 1, -1, 0, 1.5, 0, 2, 2, 1, 0.5, 0.5, 0.5]), col: new Uint8Array(12), count: 4 };
  const section = { on: false, min: [0, 0, 0], max: [1, 1, 1], t: 1 };
  const viewer = { bbox, section, base: [{}], render: () => { }, getEditedCloud: () => cloud, setSectionBox: () => { }, setSection: (on) => { section.on = !!on; }, resetSection: () => { } };
  w.__viewer = viewer;
  w.__pcTools = { viewer: () => viewer, getCloud: () => cloud, getSourceCrs: () => null, getSourceTransform: () => null };
  w.__bimCurrentCloudPath = 'D:/scan/x.las';
  w.__bimOpenCloudPath = (p) => calls.push(['openCloud', p]);
  const status = opts.status || { ok: true, python: 'python3', open3d: true, tools: { crs: true, mesh: true } };
  const A = {
    p23Status: async () => status,
    p23GrantMesh: async (a) => { calls.push(['grantMesh', a]); return { ok: true, paths: a.paths }; },
    p23PickMesh: async () => ({ ok: true, path: 'D:/mesh/m.ply' }),
    p23MeshRun: opts.p23MeshRun || (async (a) => { calls.push(['meshRun', a]); return { ok: true, op: a.op, output: 'D:/out/mesh.ply', result: { before: { triangles: 160 }, after: { triangles: 240 }, operations: [{ op: 'fill-holes', holes_filled: 5 }] } }; }),
    p23CrsRun: async (a) => { calls.push(['crsRun', a]); return { ok: true, op: a.op, result: { source: { epsg: 32636, wkt: 'PROJCRS[...]' }, points_file: 100 } }; },
    p23SaveFragment: async (a) => ({ ok: true, path: 'D:/out/clip.ply', count: a.pos.length / 3, format: a.format || 'ply' }),
    readFile: async () => 'AA==',
    onP23Progress: () => () => { }
  };
  w.bimAPI = A;
  w.eval(P23);
  return { w, dom, calls, toasts, api: w.__lxP23, clip: w.__lxClipBox };
}

test('r159: jsdom — при Open3D панель Mesh разрешает запуск, показывает прогресс и программный выбор файла', { skip: !JSDOM && 'jsdom' }, async () => {
  let resolveRun;
  const pending = new Promise((r) => { resolveRun = r; });
  const env = makeDom({ p23MeshRun: (a) => { env.calls.push(['meshRun', a]); return pending; } });
  try {
    env.api.mount();
    await new Promise((r) => setTimeout(r, 60));
    env.api.openMesh();
    await new Promise((r) => setTimeout(r, 60));
    const p = env.w.document.getElementById('lxMeshPanel');
    const runBtn = p.querySelector('[data-p23="mesh-run"]');
    assert.equal(runBtn.disabled, false, 'с Open3D кнопка запуска должна быть доступна');
    const gr = await env.api.setMeshFile('D:/mesh/cube-hole.ply');
    assert.equal(gr.ok, true);
    assert.ok(env.calls.some((c) => c[0] === 'grantMesh'), 'setMeshFile должен выдать грант');
    assert.match(p.textContent, /cube-hole\.ply/);
    runBtn.click();
    await new Promise((r) => setTimeout(r, 450));
    const box = p.querySelector('[data-p23-mesh-result]');
    assert.match(box.textContent, /Выполняется .*с/, 'во время операции должен идти прогресс-таймер: ' + box.textContent);
    resolveRun({ ok: true, op: 'laplacian', output: 'D:/out/mesh-smooth.ply', result: { before: { triangles: 160 }, after: { triangles: 160 }, operations: [{ op: 'smooth', moved_vertices: 130 }] } });
    await new Promise((r) => setTimeout(r, 80));
    assert.match(box.textContent, /Готово/);
    assert.match(box.textContent, /smooth|перемещ|сдвинут/i);
    assert.ok(env.calls.some((c) => c[0] === 'meshRun'));
  } finally { try { env.dom.window.close(); } catch (e) { } }
});

test('r159: jsdom — без Open3D кнопка Mesh заблокирована с понятным сообщением', { skip: !JSDOM && 'jsdom' }, async () => {
  const env = makeDom({ status: { ok: true, python: 'python3', open3d: false, tools: { crs: true, mesh: true } } });
  try {
    env.api.mount(); await new Promise((r) => setTimeout(r, 60)); env.api.openMesh(); await new Promise((r) => setTimeout(r, 60));
    const p = env.w.document.getElementById('lxMeshPanel');
    assert.ok(p.querySelector('[data-p23="mesh-run"]').disabled);
    assert.match(p.textContent, /Open3D/);
  } finally { try { env.dom.window.close(); } catch (e) { } }
});
