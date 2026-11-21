'use strict';
// r181: регрессия «нажал Раскрасить по фото — облако осталось серым». Проверяем проводку:
//  - результат раскраски открывается БЕЗ диалога предпросмотра (иначе на экране остаётся старое серое облако);
//  - пост-обработка в приложении идёт в worker_threads, а не в main-процессе (иначе окно зависает);
//  - оценка свободного места учитывает пик параллельной раскраски (тайлы+склейка+пост ≈ 2× исходника).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('r181: «Цвет по фото» открывает результат без диалога предпросмотра', () => {
  const app = read('renderer/app.js');
  const i = app.indexOf('window.__bimPhotoColor = async function');
  assert.ok(i > 0, 'есть __bimPhotoColor');
  const fn = app.slice(i, i + 9000);
  assert.match(fn, /return window\.__bimOpenCloudPath\(r\.path, \{ fresh: true, skipPreview: true, noAllAsk: true \}\)/,
    'после успеха результат открывается с skipPreview — иначе старое серое облако остаётся на экране');
  assert.match(fn, /Цвет по фото: '\s*\+\s*\(ph\.points/, 'тост с процентом цветных точек');
});

test('r181: пост-обработка в приложении — worker_threads, не main-процесс', () => {
  const main = read('main.js');
  const i = main.indexOf('async function photoColorAuto');
  assert.ok(i > 0);
  const fn = main.slice(i, main.indexOf('async function photoColorLas'));
  assert.match(fn, /PP\.postParallel\(/, 'пост идёт через postParallel (worker_threads)');
  assert.match(fn, /onProgress\(0\.87/, 'прогресс пост-обработки отдаётся в UI');
  assert.doesNotMatch(fn, /await require\('\.\/recolor-post'\)\.postColor\(/, 'нет блокирующего postColor в main');
});

test('r181: оценка места под параллельную раскраску учитывает пик 2× исходника', () => {
  const main = read('main.js');
  const m = main.match(/function photoColorNeed\([\s\S]*?\n/);
  assert.ok(m, 'photoColorNeed есть');
  const fn = new Function(m[0] + '; return photoColorNeed;')();
  assert.ok(fn(1e9, 3e7) > 2e9, 'на 1 ГБ облако нужно >2 ГБ места: ' + fn(1e9, 3e7));
  assert.ok(fn(2.4e10, 6.4e8) > 5e10, 'на 24 ГБ / 640 млн точек нужно >50 ГБ: ' + fn(2.4e10, 6.4e8));
});
