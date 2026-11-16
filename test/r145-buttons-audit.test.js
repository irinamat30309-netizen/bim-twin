'use strict';
/*
 * r145 — аудит кнопок (CDP-прогон 71 кнопки, 0 JS-исключений).
 * Регрессия найденного бага: «Сверка»/«Проверить НС» (qa/btnVerify) вызывала полный
 * refresh() → openRoom() → viewer.loadRoom() и подменяла открытое облако точек демо-
 * геометрией помещения. После этого 39 кнопок с needs:'cloud' (контроль/экспорт)
 * становились aria-disabled и показывали «Сначала откройте облако точек».
 * Теперь refresh/openRoom умеют keepScene: true — данные обновляются, 3D-сцена и
 * облако остаются.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const read = (p) => fs.readFileSync(path.join(R, p), 'utf8');
const APP = read('app.js');
const C = require('../renderer/ui/commands.js');

test('r145: openRoom и refresh поддерживают keepScene (не перезагружать 3D-сцену)', () => {
  assert.match(APP, /async function openRoom\(id, opts\)/, 'openRoom(id, opts)');
  assert.match(APP, /const keepScene = !!\(opts && opts\.keepScene\)/, 'openRoom читает keepScene');
  assert.match(APP, /if \(!keepScene\) \{\s*viewer\.loadRoom\(current\)/, 'viewer.loadRoom только без keepScene');
  assert.match(APP, /async function refresh\(preserveId, opts\)/, 'refresh(preserveId, opts)');
  assert.match(APP, /openRoom\(id, opts\)/, 'refresh прокидывает opts в openRoom');
  assert.match(APP, /openRoom\(DB\.rooms\[0\]\.id, opts\)/, 'refresh прокидывает opts и в fallback');
});

test('r145: «Сверка» и «Проверить НС» обновляют данные, сохраняя открытое облако', () => {
  // обычный пользовательский сценарий: refresh(current.id, { keepScene: true })
  assert.match(APP, /await refresh\(current\.id, \{ keepScene: true \}\)/);
  assert.match(APP, /await refresh\(current && current\.id, \{ keepScene: true \}\)/);
  assert.equal((APP.match(/keepScene: true/g) || []).length, 2, 'ровно два места: runVerify и runVerifyAll');
  // старый вызов без keepScene (подменял облако демо-геометрией) не должен вернуться
  assert.doesNotMatch(APP, /await refresh\(current\.id\);/);
});

test('r145: обычная навигация по помещениям по-прежнему перезагружает сцену', () => {
  // клик по строке дерева/кнопка «К помещению»/первичный открытый этаж — без keepScene
  assert.match(APP, /row\.onclick = \(\) => openRoom\(r\.id\)/);
  assert.match(APP, /if \(DB\.rooms\.length\) openRoom\(DB\.rooms\[0\]\.id\)/);
});

test('r145: реестр команд цел — id уникальны, у каждой кнопки есть способ запуска', () => {
  const seen = new Set();
  for (const { item } of C.all()) {
    assert.ok(!seen.has(item.id), 'повтор id: ' + item.id);
    seen.add(item.id);
    assert.ok(item.sel || item.call || item.slot || item.special || item.kind === 'select', item.id + ': нет обработчика');
  }
  assert.equal(C.TABS.length, 11, '11 вкладок ленты');
  assert.ok(C.all().length >= 120, 'команд не меньше, чем до аудита: ' + C.all().length);
});
