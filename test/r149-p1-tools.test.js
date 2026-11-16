'use strict';
/*
 * r149 — P1-функции UI и ускорение первого кадра:
 *   • «Пакетная обработка проекта»: очередь .xbin → чистка → цвет → экспорт, фон, прогресс, отмена,
 *     понятные заглушки, если API phase1/phase2 ещё нет;
 *   • «Совместить облака» → __lxToolsExt.ops.opMerge / [data-cmd="opMerge"], иначе понятное сообщение;
 *   • «Классификация» → __lxClassify / показ классов, иначе понятное сообщение;
 *   • первый кадр: облако из командной строки стартует сразу после viewer (не до него), без окна
 *     «Перед загрузкой» (skipPreview) и без лишнего вопроса «Показать все?» (noAllAsk).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }
const ROOT = path.join(__dirname, '..');
const R = path.join(ROOT, 'renderer');
const P1 = fs.readFileSync(path.join(R, 'ui', 'p1-tools.js'), 'utf8');
const APP = fs.readFileSync(path.join(R, 'app.js'), 'utf8');

test('r149: первый кадр — pending-облако стартует после viewer, без preview-окна и лишних вопросов', () => {
  assert.match(APP, /function startPendingCloudOpen\(\)/, 'нет отложенного старта облака');
  assert.match(APP, /startPendingCloudOpen\(\)/, 'pending-облако не запускается из init');
  assert.match(APP, /skipPreview:\s*true,\s*noAllAsk:\s*true/, 'CLI-облако должно обходить preview/вопрос (иначе +секунды до кадра)');
  assert.match(APP, /const popts = opts && opts\.allPoints \? \{ allPoints: true \} : \{ skipPreview: !!\(opts && opts\.skipPreview\), noAllAsk: !!\(opts && opts\.noAllAsk\), forceParts: !!\(opts && opts\.forceParts\) \}/, 'флаги не передаются в parseCloudWithProgress');
  assert.match(APP, /function ensureP1Tools\(\)/, 'нет загрузки P1-панели');
  assert.match(APP, /p1-tools\.js\?v=149/);
  assert.match(APP, /window\.__bimCurrentCloudPath = p/, 'нет пути текущего облака для очереди');
});

test('r149: P1 — панель, очередь, три кнопки и палитра токенов', () => {
  for (const s of ['Сборка облака из .xbin', 'Чистка облака', 'Цвет по фото камер', 'Экспорт результата']) assert.ok(P1.includes(s), 'нет стадии ' + s);
  for (const b of ['Пакетная обработка проекта', 'Совместить облака', 'Классификация']) assert.ok(P1.includes(b), 'нет кнопки ' + b);
  assert.match(P1, /data-p1="run"/);
  assert.match(P1, /data-p1="cancel"/);
  assert.match(P1, /data-p1="merge"/);
  assert.match(P1, /data-p1="classify"/);
  assert.match(P1, /data-p1-progress/);
  assert.match(P1, /window\.__lxP1/);
  assert.ok(P1.includes('var(--accent)') && P1.includes('var(--bg-2)'));
  assert.ok(!/linear-gradient|radial-gradient/.test(P1), 'градиенты запрещены');
  assert.ok(!/#(?:4c8dff|2f6bff)\b/i.test(P1), 'синий вне палитры');
});

function makeEnv(opts) {
  opts = opts || {};
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [], toasts = [];
  w.__toast = (m, tone) => toasts.push({ m: String(m), tone });
  w.__lxIcons = { svg: (n, s) => '<svg data-ico="' + n + '"></svg>' };
  const ops = opts.ops === false ? null : {
    opMerge: () => calls.push(['opMerge']),
    opAutoClean: () => calls.push(['opAutoClean']),
    opPhotoColor: () => calls.push(['opPhotoColor']),
    opWriteData: () => calls.push(['opWriteData']),
    opExportE57: () => calls.push(['opExportE57']),
    ...(opts.ops || {})
  };
  if (ops) w.__lxToolsExt = { ops };
  if (opts.classify) w.__lxClassify = { open: () => calls.push(['classifyOpen']) };
  w.__viewer = { base: [{ _gpuCount: 589900000, count: 589900000 }], getAvailableColorModes: () => (opts.modes || ['rgb', 'classification']), setColorMode: (m) => calls.push(['colorMode', m]) };
  w.__bimCurrentCloudPath = opts.path !== undefined ? opts.path : 'D:/scan/2026-09-03-110319.xbin';
  w.eval(P1);
  return { w, dom, calls, toasts, api: w.__lxP1 };
}

test('r149: P1 (jsdom) — кнопки в панели, очередь выполняет доступные стадии', { skip: !JSDOM && 'jsdom' }, async () => {
  const env = makeEnv();
  try {
    const bar = env.w.document.getElementById('lxP1Bar');
    assert.ok(bar, 'нет панели P1');
    assert.strictEqual(bar.querySelectorAll('[data-p1]').length >= 3, true);
    env.api.mount();
    env.api.openBatch();
    const p = env.w.document.getElementById('lxP1Panel');
    assert.ok(p && !p.hidden, 'панель очереди не открылась');
    // сборка .xbin: кликаем существующий обработчик, если он есть в DOM
    const xb = env.w.document.createElement('button'); xb.setAttribute('data-cmd', 'opXbinCloud'); xb.onclick = () => env.calls.push(['opXbinCloud']);
    env.w.document.body.appendChild(xb);
    const ok = await env.api.runBatch();
    assert.strictEqual(ok, true, 'очередь не дошла до конца');
    for (const c of ['opXbinCloud', 'opAutoClean', 'opPhotoColor', 'opWriteData']) assert.ok(env.calls.some((x) => x[0] === c), 'стадия не вызвана: ' + c);
    assert.match(p.querySelector('[data-p1-status]').textContent, /очередь передана|готова|передана/i);
    assert.match(p.querySelector('[data-p1-progress]').style.width, /100%/);
  } finally { try { env.dom.window.close(); } catch (e) { } }
});

test('r149: P1 (jsdom) — отмена очереди, merge и классификация', { skip: !JSDOM && 'jsdom' }, async () => {
  const env = makeEnv();
  try {
    env.api.mount();
    env.api.openBatch();
    env.api.cancelBatch();
    assert.strictEqual(env.api.cancelBatch(), false, 'отмена без запуска не требуется');
    assert.strictEqual(env.api.mergeClouds(), true);
    assert.ok(env.calls.some((c) => c[0] === 'opMerge'), 'merge не вызвал opMerge');
    // классификация: __lxClassify есть → открывается
    const env2 = makeEnv({ classify: true });
    try {
      env2.api.mount();
      assert.strictEqual(env2.api.classify(), true);
      assert.ok(env2.calls.some((c) => c[0] === 'classifyOpen'));
    } finally { try { env2.dom.window.close(); } catch (e) { } }
    // без API — понятная заглушка, не молчание
    const env3 = makeEnv({ ops: false, modes: ['rgb', 'elev'] });
    try {
      env3.api.mount(); env3.api.openBatch();
      assert.strictEqual(env3.api.classify(), false);
      assert.ok(env3.toasts.some((t) => /phase1\/phase2|заглушк|Классификация/i.test(t.m)), 'нет понятного сообщения о заглушке');
      assert.strictEqual(env3.api.mergeClouds(), false);
      assert.ok(env3.toasts.some((t) => /phase1\/phase2|Совместить/i.test(t.m)));
    } finally { try { env3.dom.window.close(); } catch (e) { } }
  } finally { try { env.dom.window.close(); } catch (e) { } }
});
