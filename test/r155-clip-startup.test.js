'use strict';
/*
 * r155 — старт (ленивый startup-UI, предзагрузка LAS-заголовка) и P3 Clipping Box UI + .xcord/экспорт.
 *  • startup: kit/ProjectStorageUI не в <script>-критическом пути, грузятся после первого кадра; startup.html
 *    не содержит их тегов; main предзагружает LAS-заголовок/bbox из argv и отдаёт через bim:preloadedCloudHead;
 *  • P3: UI-слой clip-p3.js (min/max X/Y/Z, поворот-заглушка, PLY/PCD/XYZ через __lxClipBox.applyAndSave,
 *    .xcord CSV/XML с 8 углами), честные пометки RCP/Protobuf/LAS/E57;
 *  • чистая функция filterBox — 120 млн точек за <2 с (замер в STARTUP-CLIP-r155.md).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }
const ROOT = path.join(__dirname, '..');
const R = path.join(ROOT, 'renderer');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MAIN = read('main.js');
const PRELOAD = read('preload.js');
const STARTUP_HTML = read('renderer/startup.html');
const STARTUP_JS = read('renderer/startup.js');
const APP = read('renderer/app.js');
const CLIP = read('renderer/ui/clip-p3.js');
const Clip = require(path.join(R, 'ui', 'clip-p3.js'));

test('r155: старт — тяжёлый startup-UI (kit/ProjectStorageUI) вне критического пути', () => {
  assert.ok(!/<script src="ui\/kit\.js/.test(STARTUP_HTML), 'kit.js не должен блокировать стартовую страницу');
  assert.ok(!/<script src="project-storage-ui\.js/.test(STARTUP_HTML), 'project-storage-ui.js не должен блокировать страницу');
  assert.match(STARTUP_JS, /function loadLazyUi\(\)/, 'нет ленивой загрузки startup-UI');
  assert.match(STARTUP_JS, /setTimeout\(loadLazyUi, 0\)/, 'ленивая загрузка не запускается после первого кадра');
  assert.match(STARTUP_JS, /'ui\/kit\.js\?v=1330'/, 'kit.js должен подключаться динамически');
  assert.match(STARTUP_JS, /function K\(\)/, 'обращения к kit должны быть отложенными');
});

test('r155: старт — предзагрузка LAS-заголовка/bbox в main и IPC в preload', () => {
  assert.match(MAIN, /let preloadedCloudHead = null;/, 'нет кэша заголовка облака');
  assert.match(MAIN, /cs\.openSegmentSource\(pendingOpen\)/, 'main не читает заголовок облака до старта UI');
  assert.match(MAIN, /ipcMain\.handle\('bim:preloadedCloudHead'/, 'нет IPC предзагруженного заголовка');
  assert.match(PRELOAD, /preloadedCloudHead: \(\) => inv\('bim:preloadedCloudHead'\)/, 'preload не отдаёт заголовок');
});

test('r155: P3 — UI панель, кнопка, форматы, .xcord, заглушки', () => {
  for (const t of ['Clipping Box', 'Сохранить фрагмент', 'Применить', 'Отмена', '.xcord']) assert.ok(CLIP.includes(t), 'нет «' + t + '»');
  assert.match(CLIP, /lxClipP3Btn/);
  assert.match(CLIP, /data-p3="save"/);
  assert.match(CLIP, /window\.__lxClipBox/);
  assert.match(CLIP, /applyAndSave/);
  assert.match(CLIP, /data-p3-format/);
  assert.match(CLIP, /value="PLY"[\s\S]{0,200}value="PCD"[\s\S]{0,200}value="XYZ"/);
  // честные пометки: RCP/Protobuf проприетарные, LAS — через экспорт, E57 — чтение
  assert.match(CLIP, /RCP\/Protobuf — проприетарные, недоступны/);
  assert.match(CLIP, /LAS — через экспорт\/конвертацию/);
  assert.match(CLIP, /E57 — только чтение/);
  // поворот: поле есть, но выключено (axis-aligned)
  assert.match(CLIP, /data-p3-rotation[^>]*disabled/);
  assert.match(APP, /clip-p3\.js\?v=155/);
  assert.match(APP, /function ensureClipP3\(\)/);
});

test('r155: filterBox — границы включительно, count/indices', () => {
  const pts = new Float32Array([
    0, 0, 0,      // внутри
    1.5, 0, 0,    // на границе max.x — включительно
    -1.1, 0, 0,   // снаружи
    0, 2, 0,      // снаружи по Y
    0, 0, -1      // на границе min.z
  ]);
  const r = Clip.filterBox(pts, { min: { x: -1, y: -1, z: -1 }, max: { x: 1.5, y: 1, z: 1 } }, { copy: false });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 3);
  assert.deepStrictEqual([...r.indices], [0, 1, 4]);
  const copy = Clip.filterBox(pts, { min: { x: -1, y: -1, z: -1 }, max: { x: 1.5, y: 1, z: 1 } });
  assert.deepStrictEqual([...copy.pos], [0, 0, 0, 1.5, 0, 0, 0, 0, -1]);
  assert.strictEqual(Clip.filterBox(null, {}).ok, false);
});

test('r155: .xcord — CSV/XML с 8 углами и min/max', () => {
  const box = { min: { x: -1, y: -2, z: -3 }, max: { x: 4, y: 5, z: 6 } };
  const csv = Clip.xcordCSV(box, 'scan.las');
  const lines = csv.trim().split('\n');
  assert.strictEqual(lines[0], '# xcord,BIM Twin r155');
  assert.strictEqual(lines[1], 'project,scan.las');
  assert.ok(lines.includes('min,-1.000000,-2.000000,-3.000000'));
  assert.ok(lines.includes('max,4.000000,5.000000,6.000000'));
  assert.strictEqual(lines.filter((l) => /^\d,/.test(l)).length, 8, '8 углов');
  const xml = Clip.xcordXML(box, 'scan.las');
  assert.match(xml, /<xcord version="155" project="scan.las"/);
  assert.strictEqual((xml.match(/<corner /g) || []).length, 8);
  assert.match(xml, /<min x="-1.000000"/);
  // нормализация перепутанных min/max
  const n = Clip.xcordCSV({ min: { x: 5, y: 0, z: 0 }, max: { x: 1, y: 0, z: 0 } });
  assert.ok(n.includes('min,1.000000'));
});

test('r155: P3 (jsdom) — панель, применение бокса, сохранение фрагмента, .xcord', { skip: !JSDOM && 'jsdom' }, async () => {
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; const calls = [], toasts = [];
  w.__toast = (m, tone) => toasts.push({ m: String(m), tone });
  w.__lxIcons = { svg: () => '<svg></svg>' };
  w.__viewer = { bbox: { mn: [-10, -2, -10], mx: [10, 5, 10] } };
  w.__bimCurrentCloudPath = 'D:/scan/test.las';
  w.__lxClipBox = {
    open: () => calls.push(['open']), close: () => calls.push(['close']), cancel: () => calls.push(['cancel']),
    getBox: () => ({ min: { x: -10, y: -2, z: -10 }, max: { x: 10, y: 5, z: 10 }, rotation: 0 }),
    setBox: (b) => { calls.push(['setBox', b.min.x, b.max.x]); return b; },
    applyAndSave: (o) => { calls.push(['save', o && o.format]); return { ok: true, count: 12345, path: 'D:/out/clip.ply' }; },
    state: () => ({ active: true, points: 12345, count: 12345 })
  };
  w.eval(CLIP);
  try {
    const api = w.__lxClipP3;
    assert.ok(api, 'нет __lxClipP3');
    api.mount(); api.open();
    const panel = w.document.getElementById('lxClipP3Panel');
    assert.ok(panel && !panel.hidden);
    assert.ok(w.document.getElementById('lxClipP3Btn'));
    // поля заполнены из getBox/viewer bbox
    assert.strictEqual(w.document.querySelector('[data-p3-min-x]').value, '-10');
    // изменить бокс и применить
    w.document.querySelector('[data-p3-max-x]').value = '5';
    w.document.querySelector('[data-p3="apply"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert.ok(calls.some((c) => c[0] === 'setBox'), 'setBox не вызван');
    // сохранить фрагмент PLY
    await api.save();
    assert.ok(calls.some((c) => c[0] === 'save' && c[1] === 'PLY'), 'applyAndSave не вызван');
    assert.match(w.document.querySelector('[data-p3-stat]').textContent, /Фрагмент сохранён|12345/);
    // .xcord скачивание (не проверяем download, только генерацию)
    assert.ok(api.xcordCSV({ min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }).includes('0,0.000000,0.000000,0.000000'));
    // отмена
    api.cancel();
    assert.ok(calls.some((c) => c[0] === 'cancel'));
  } finally { try { dom.window.close(); } catch (e) { } }
});
