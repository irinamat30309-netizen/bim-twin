'use strict';
/*
 * r151 — P1/P2-интеграция готовых Python-инструментов в UI:
 *   • «Совместить облака» → bimAPI.p1Register → cloud-register.py (ICP/пары/GCP), LAS+JSON, strict-fail;
 *   • «Классификация» → bimAPI.p1Classify → cloud-classify.py: проценты классов, превью,
 *     «оставить только классы» (фильтр по classification), подсветка классов цветом;
 *   • «Пакетная обработка проекта» → реальный конвейер xbinBuildCloud → photoColorCloud →
 *     cleanCloud → p1Export с прогрессом/отменой/логом;
 *   • P2 «Отчёт о точности» → bimAPI.p1Accuracy → quality-compare.py + cloud-diff.py
 *     (3D-разница, RMSE плоскостей) + PDF (saveReportPdf).
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
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const BRIDGE = require('../p1-bridge.js');

test('r151: мост p1-bridge зарегистрирован в main и API в preload', () => {
  assert.match(MAIN, /require\('\.\/p1-bridge'\)\.register\(\{/);
  for (const fn of ['p1Status', 'p1PickClouds', 'p1PickPairs', 'p1Register', 'p1Classify', 'p1Accuracy', 'p1Export', 'p1Cancel', 'onP1Progress']) {
    assert.match(PRELOAD, new RegExp(fn + ':\\s*\\(|' + fn + ':\\s*\\(jobId'), 'preload: нет ' + fn);
  }
  for (const ch of ['bim:p1Status', 'bim:p1PickClouds', 'bim:p1Register', 'bim:p1Classify', 'bim:p1Accuracy', 'bim:p1Export', 'bim:p1Cancel']) {
    assert.ok(P1.includes(ch.replace('bim:', 'p1')) || PRELOAD.includes("inv('" + ch + "'"), 'нет канала ' + ch);
  }
});

test('r151: аргументы инструментов строятся корректно (pure builders)', () => {
  const reg = BRIDGE.buildRegisterArgs({ ref: 'ref.las', src: ['a.las', 'b.las'], mode: 'manual-points', pairs: 'p.json', strict: true, out: 'r.json', outLas: 'o.las' });
  assert.deepEqual(reg.slice(0, 2), ['--ref', 'ref.las']);
  assert.ok(reg.includes('--src') && reg.includes('a.las') && reg.includes('b.las'));
  assert.ok(reg.includes('--mode') && reg.includes('manual-points'));
  assert.ok(reg.includes('--pairs') && reg.includes('--strict') && reg.includes('--out') && reg.includes('--out-las'));
  const regIcp = BRIDGE.buildRegisterArgs({ ref: 'r.las', src: ['s.las'], mode: 'icp', autoInit: true });
  assert.ok(regIcp.includes('--auto-init'));
  assert.ok(!regIcp.includes('--pairs'));
  const cls = BRIDGE.buildClassifyArgs({ cloud: 'a.las', outLas: 'c.las', json: 'c.json', preview: 'c.png', refineDynamic: true });
  assert.deepEqual(cls[0], 'a.las');
  for (const a of ['--out-las', '--json', '--preview', '--refine-dynamic']) assert.ok(cls.includes(a), 'classify: нет ' + a);
  const q = BRIDGE.buildQualityArgs({ our: 'a.las', ref: 'b.las', out: 'q.json', heatmaps: 'hm', label: 'test' });
  assert.deepEqual(q.slice(0, 4), ['--our', 'a.las', '--ref', 'b.las']);
  const d = BRIDGE.buildDiffArgs({ our: 'a.las', ref: 'b.las', out: 'd.json', heatmap: 'h.png' });
  assert.deepEqual(d.slice(0, 4), ['--our', 'a.las', '--ref', 'b.las']);
  assert.ok(d.includes('--heatmap') && d.includes('h.png'));
  assert.equal(BRIDGE.SCRIPTS.diff, 'cloud-diff.py');
});

function fakeBridgeDeps(opts) {
  opts = opts || {};
  const handlers = {};
  const events = [];
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; }, on: () => { } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-test-'));
  const app = { getPath: () => tmp };
  const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
  const fileGrants = { grantExistingFile: () => { } };
  const ipcSender = (event) => (event && event.sender) || { id: 1, send: (ch, p) => events.push({ ch, p }) };
  const resolveAuthorizedFile = (event, p) => (opts.resolve === false ? null : (p && fs.existsSync(p) ? path.resolve(p) : null));
  const grantExistingOutput = () => true;
  const mod = BRIDGE.register({ ipcMain, app, dialog, rootDir: ROOT, python: opts.python === undefined ? null : opts.python, fileGrants, ipcSender, resolveAuthorizedFile, grantExistingOutput });
  return { mod, handlers, events, tmp };
}

test('r151: мост — статус, валидация и понятные ошибки без запуска Python', async () => {
  const { handlers } = fakeBridgeDeps();
  assert.ok(handlers['bim:p1Status']);
  const status = await handlers['bim:p1Status']({ sender: { id: 1 } });
  assert.equal(status.ok, true);
  assert.ok(status.tools.register && status.tools.classify && status.tools.quality && status.tools.diff, 'все 4 скрипта на месте');
  assert.deepEqual(status.register.modes.sort(), ['gcp', 'icp', 'manual-points']);
  // нет ref → понятная ошибка, а не исключение
  let r = await handlers['bim:p1Register']({ sender: { id: 1 } }, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /эталон|ref/i);
  // есть ref, но нет src
  const tmpLas = path.join(os.tmpdir(), 'p1-empty.las');
  fs.writeFileSync(tmpLas, 'LASF');
  const resolveAuthorizedFile = (event, p) => p === tmpLas ? tmpLas : null;
  const handlers2 = {};
  BRIDGE.register({ ipcMain: { handle: (ch, fn) => { handlers2[ch] = fn; } }, app: { getPath: () => os.tmpdir() }, dialog: { showOpenDialog: async () => ({ canceled: true }) }, rootDir: ROOT, python: null, ipcSender: (e) => ({ id: 1, send: () => { } }), resolveAuthorizedFile, grantExistingOutput: () => true });
  r = await handlers2['bim:p1Register']({ sender: { id: 1 } }, { ref: tmpLas });
  assert.equal(r.ok, false);
  assert.match(r.error, /исходн|src/i);
  try { fs.unlinkSync(tmpLas); } catch (e) { }
});

test('r151: мост — ICP без Open3D даёт понятную подсказку про режимы пар/GCP', async () => {
  const tmpLas = path.join(os.tmpdir(), 'p1-icp.las');
  fs.writeFileSync(tmpLas, 'LASF');
  const handlers = {};
  BRIDGE.register({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, app: { getPath: () => os.tmpdir() }, dialog: { showOpenDialog: async () => ({ canceled: true }) },
    rootDir: ROOT, python: null, ipcSender: (e) => ({ id: 1, send: () => { } }),
    resolveAuthorizedFile: (e, p) => (p === tmpLas ? tmpLas : null), grantExistingOutput: () => true
  });
  const r = await handlers['bim:p1Register']({ sender: { id: 1 } }, { ref: tmpLas, src: [tmpLas], mode: 'icp' });
  assert.equal(r.ok, false);
  assert.equal(r.needOpen3D, true);
  assert.match(r.error, /Open3D/);
  assert.match(r.error, /Пары точек|GCP/);
  try { fs.unlinkSync(tmpLas); } catch (e) { }
});

function makeDom(opts) {
  opts = opts || {};
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [], toasts = [];
  w.__toast = (m, tone) => toasts.push({ m: String(m), tone });
  w.__lxIcons = { svg: (n, s) => '<svg data-ico="' + n + '"></svg>' };
  w.__bimCurrentCloudPath = opts.path !== undefined ? opts.path : 'D:/scan/x.las';
  w.__pcTools = { viewer: () => w.__viewer, getCloud: () => opts.cloud || null };
  w.__viewer = { base: [{ _gpuCount: 120000, count: 120000 }], loadCloud: (c, o) => calls.push(['loadCloud', (c && c.count) || 0, o && o.sourceName]), setColorMode: (m) => calls.push(['colorMode', m]) };
  const P = opts.bridge === false ? {} : Object.assign({
    p1Register: async (a) => { calls.push(['p1Register', a]); return opts.registerResult || { ok: true, mode: a.mode, outLas: 'D:/out/reg.las', reportPath: 'D:/out/reg.json', elapsed_s: 0.2, results: [{ strictPass: true, strictThreshold: 0.05, yawDeg: 1.2, translation: [0.1, 0.2, 0.3], rms: { rms_inlier_m: 0.012, inlier_ratio: 0.9 } }] }; },
    p1Classify: async (a) => { calls.push(['p1Classify', a]); return opts.classifyResult || { ok: true, inputIsLas: true, outLas: 'D:/out/classified.las', jsonPath: 'D:/out/classify.json', previewDataUrl: 'data:image/png;base64,AAA', stats: { points: 1000, classes: { ground_floor: 300, wall: 500, roof: 100, vegetation: 80, people: 0, clutter: 20, other: 0 }, pct: { ground_floor: 30, wall: 50, roof: 10, vegetation: 8, people: 0, clutter: 2, other: 0 }, confidence: { mean: 0.9, p10: 0.8 } } }; },
    p1Accuracy: async (a) => { calls.push(['p1Accuracy', a]); return opts.accuracyResult || { ok: true, our: 'D:/scan/x.las', ref: 'D:/ref.las', diff: { dist_m: { mean_m: 0.008, rmse_m: 0.013, median_m: 0.001, p95_m: 0.028, max_m: 0.081, within_2cm_pct: 84.7, within_5cm_pct: 99.9, within_10cm_pct: 100 }, planes_mm: { floor: { our: 5.9, ref: 6.1, delta: -0.2 }, walls: { our: 27.7, ref: 27.8, delta: -0.1 } } }, quality: { verdicts: { blur: { pass: false }, color_coverage: { pass: false } } }, files: { diffJson: 'D:/out/diff.json' }, heatmaps: [{ name: 'diff.png', dataUrl: 'data:image/png;base64,AAA' }] }; },
    p1PickClouds: async () => ({ ok: true, paths: ['D:/picked/cloud.las'] }),
    p1PickPairs: async () => ({ ok: true, path: 'D:/picked/pairs.json' }),
    p1Status: async () => ({ ok: true, python: 'python', open3d: true, tools: { register: true, classify: true, quality: true, diff: true } }),
    p1Export: async (a) => { calls.push(['p1Export', a]); return { ok: true, path: 'D:/out/export.las', bytes: 1024 }; },
    p1Cancel: async () => ({ ok: true }),
    onP1Progress: (id, cb) => { calls.push(['onP1Progress']); return () => { }; },
    saveReportPdf: async (a) => { calls.push(['saveReportPdf', a.html.length, a.name]); return { ok: true, path: 'D:/out/report.pdf' }; }
  }, opts.api || {});
  if (opts.bridge !== false) w.bimAPI = P;
  if (opts.legacyOps) w.__lxToolsExt = { ops: opts.legacyOps };
  w.eval(P1);
  return { w, dom, calls, toasts, api: w.__lxP1 };
}

test('r151: P1 UI — полоса и панели «Совместить облака», «Классификация», «Отчёт о точности»', () => {
  const env = makeDom();
  try {
    const bar = env.w.document.getElementById('lxP1Bar');
    assert.ok(bar, 'нет панели P1');
    for (const a of ['batch', 'merge', 'classify', 'accuracy']) assert.ok(bar.querySelector('[data-p1="' + a + '"]'), 'нет кнопки ' + a);
    assert.equal(env.api.openMerge(), true);
    let panel = env.w.document.getElementById('lxP1Panel');
    assert.ok(panel && !panel.hidden);
    for (const a of ['pick-ref', 'pick-src', 'run-merge']) assert.ok(panel.querySelector('[data-p1="' + a + '"]'), 'merge: нет ' + a);
    assert.equal(env.api.openClassify(), true);
    assert.ok(env.w.document.querySelector('[data-p1="run-classify"]'));
    assert.equal(env.api.openAccuracy(), true);
    for (const a of ['pick-acc-ref', 'run-accuracy']) assert.ok(env.w.document.querySelector('[data-p1="' + a + '"]'), 'accuracy: нет ' + a);
    assert.match(P1, /Отчёт о точности/);
    assert.match(P1, /Сверка с эталоном/);
  } finally { try { env.dom.window.close(); } catch (e) { } }
});

test('r151: P1 UI — совмещение вызывает p1Register и показывает RMS/strict', { skip: !JSDOM && 'jsdom' }, async () => {
  const env = makeDom();
  try {
    env.api.openMerge();
    const p = env.w.document.getElementById('lxP1Panel');
    const set = (sel, v) => { const el = p.querySelector(sel); if (el) el.value = v; };
    // выберем файлы через фейковые диалоги (st.refPath/st.srcPath заполняются кликами)
    p.querySelector('[data-p1="pick-ref"]').click(); await new Promise((r) => setTimeout(r, 20));
    p.querySelector('[data-p1="pick-src"]').click(); await new Promise((r) => setTimeout(r, 20));
    set('[data-p1="mode"]', 'manual-points');
    p.querySelector('[data-p1="mode"]').dispatchEvent(new env.w.Event('change', { bubbles: true }));
    p.querySelector('[data-p1="pick-pairs"]').click(); await new Promise((r) => setTimeout(r, 20));
    p.querySelector('[data-p1="run-merge"]').click();
    await new Promise((r) => setTimeout(r, 80));
    const call = env.calls.find((c) => c[0] === 'p1Register');
    assert.ok(call, 'p1Register не вызван');
    assert.equal(call[1].mode, 'manual-points');
    assert.ok(call[1].ref && call[1].src && call[1].src.length === 1);
    const resBox = p.querySelector('[data-p1-merge-result]');
    assert.match(resBox.textContent, /RMS|строгий порог/i);
    assert.match(resBox.textContent, /12\.0|12|мм/i);
  } finally { try { env.dom.window.close(); } catch (e) { } }
});

test('r151: P1 UI — классификация показывает проценты классов и фильтр «оставить только»', { skip: !JSDOM && 'jsdom' }, async () => {
  const env = makeDom();
  try {
    env.api.openClassify();
    const p = env.w.document.getElementById('lxP1Panel');
    p.querySelector('[data-p1="run-classify"]').click();
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(env.calls.some((c) => c[0] === 'p1Classify'), 'p1Classify не вызван');
    const box = p.querySelector('[data-p1-classify-result]');
    assert.match(box.textContent, /Пол/);
    assert.match(box.textContent, /Стены/);
    assert.match(box.textContent, /50%/);
    assert.ok(p.querySelector('[data-p1="apply-classes"]'), 'нет кнопки «оставить только классы»');
    assert.ok(p.querySelector('[data-p1="show-classified"]'), 'нет кнопки подсветки классов');
    assert.ok(p.querySelector('img[data-p1-preview]'), 'нет превью классов');
  } finally { try { env.dom.window.close(); } catch (e) { } }
});

test('r151: P1 UI — пакетная очередь: build → color → clean → export, прогресс и лог', { skip: !JSDOM && 'jsdom' }, async () => {
  const calls = [];
  const env = makeDom({
    path: 'D:/scan/project.xbin',
    api: {
      xbinBuildCloud: async (p, jobId, density, opts) => { calls.push(['xbinBuildCloud', p]); return { ok: true, path: 'D:/scan/built.las', points: 5000, name: 'built.las' }; },
      photoColorCloud: async (p, jobId, opts) => { calls.push(['photoColorCloud', p]); return { ok: true, path: 'D:/scan/built-color.las', points: 5000 }; },
      cleanCloud: async (a) => { calls.push(['cleanCloud', a.path]); return { ok: true, path: 'D:/scan/clean.ply', removed: 123 }; },
      onP1Progress: (id, cb) => { calls.push(['onP1Progress']); return () => { }; }
    }
  });
  try {
    env.api.openBatch();
    const p = env.w.document.getElementById('lxP1Panel');
    const ok = await env.api.runBatch();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(ok, true, 'очередь не завершилась успешно');
    assert.deepEqual(calls.filter((c) => ['xbinBuildCloud', 'photoColorCloud', 'cleanCloud'].includes(c[0])).map((c) => c[0]), ['xbinBuildCloud', 'photoColorCloud', 'cleanCloud']);
    assert.ok(env.calls.some((c) => c[0] === 'p1Export'), 'p1Export не вызван');
    assert.match(p.querySelector('[data-p1-status]').textContent, /готово/i);
    assert.match(p.querySelector('[data-p1-progress]').style.width, /100%/);
    for (const st of ['build', 'color', 'clean', 'export']) {
      const row = p.querySelector('[data-p1-stage="' + st + '"]');
      assert.ok(row && (row.classList.contains('done') || row.classList.contains('skip')), 'стадия не отмечена: ' + st);
    }
    assert.match(p.querySelector('[data-p1-batch-result]').textContent, /Экспорт|export/i);
    assert.ok(p.querySelector('[data-p1-log]').textContent.length >= 0);
  } finally { try { env.dom.window.close(); } catch (e) { } }
});

test('r151: P1 UI — отчёт о точности: числа, heatmap и PDF', { skip: !JSDOM && 'jsdom' }, async () => {
  const env = makeDom({ path: 'D:/scan/x.las' });
  try {
    env.api.openAccuracy();
    const p = env.w.document.getElementById('lxP1Panel');
    p.querySelector('[data-p1="pick-acc-ref"]').click();
    await new Promise((r) => setTimeout(r, 20));
    p.querySelector('[data-p1="run-accuracy"]').click();
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(env.calls.some((c) => c[0] === 'p1Accuracy'), 'p1Accuracy не вызван');
    const box = p.querySelector('[data-p1-acc-result]');
    assert.match(box.textContent, /RMSE/);
    assert.match(box.textContent, /13\.0|13,0|13/);
    assert.match(box.textContent, /Пол|Стены/);
    assert.ok(box.querySelector('img'), 'нет heatmap');
    p.querySelector('[data-p1="save-pdf"]').click();
    await new Promise((r) => setTimeout(r, 40));
    const pdf = env.calls.find((c) => c[0] === 'saveReportPdf');
    assert.ok(pdf, 'PDF не сформирован');
    assert.ok(pdf[1] > 1000, 'PDF HTML слишком короткий');
    assert.match(String(pdf[2]), /\.pdf$/);
  } finally { try { env.dom.window.close(); } catch (e) { } }
});
