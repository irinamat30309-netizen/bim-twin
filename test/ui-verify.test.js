'use strict';
/* Окно «Сверка с документацией» (renderer/ui/verify.js), мост app.js → window.__lxDocCheck и связка с окном «Инспектор объекта». */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const read = (p) => fs.readFileSync(path.join(R, p), 'utf8');
const V = require('../renderer/ui/verify.js');
const APP = read('app.js');
const INS = read('lixel-object-inspector.js');
const HTML = read('index.html');

const row = (status, extra) => Object.assign({ index: 0, status, mode: 'distance' }, extra || {});

test('статусы: у каждого статуса есть тон, группа, короткая и полная подпись', () => {
  for (const k of Object.keys(V.STATUS)) {
    const s = V.statusInfo(k);
    assert.ok(['ok', 'err', 'warn', 'accent', 'muted'].includes(s.tone), k + ': тон');
    assert.ok(['ok', 'err', 'review', 'busy', 'none'].includes(s.bucket), k + ': группа');
    assert.ok(s.short.length <= 12, k + ': короткая подпись умещается в чип: ' + s.short);
    assert.ok(s.label.length > s.short.length - 1 && s.hint, k + ': есть полная подпись и подсказка');
  }
  assert.equal(V.statusInfo('что-то-новое').short, V.STATUS['not-checked'].short, 'неизвестный статус = не сверено');
  assert.equal(V.statusInfo('within-tolerance').tone, 'ok');
  assert.equal(V.statusInfo('outside-tolerance').tone, 'err');
  assert.equal(V.statusInfo('analyzing').busy, true);
  assert.equal(V.statusInfo('no-match').short, 'Не найдено');
});

test('группы и фильтры: «Проверить» включает идущий анализ, «Все» не теряет строк', () => {
  const rows = [row('within-tolerance', { index: 0 }), row('outside-tolerance', { index: 1 }), row('needs-review', { index: 2 }), row('tolerance-not-specified', { index: 3 }),
    row('analyzing', { index: 4 }), row('no-match', { index: 5 }), row('units-unconfirmed', { index: 6 }), row('not-checked', { index: 7 })];
  assert.deepEqual(V.countBuckets(rows), { all: 8, ok: 1, err: 1, review: 3, none: 2, busy: 1 });
  assert.equal(V.filterRows(rows, 'all').length, 8);
  assert.deepEqual(V.filterRows(rows, 'ok').map((r) => r.index), [0]);
  assert.deepEqual(V.filterRows(rows, 'err').map((r) => r.index), [1]);
  assert.deepEqual(V.filterRows(rows, 'review').map((r) => r.index), [2, 3, 4, 6]);
  assert.deepEqual(V.filterRows(rows, 'none').map((r) => r.index), [5, 7]);
  assert.deepEqual(V.filterRows(null, 'ok'), []);
});

test('быстрое «Принять»: только предложения, по которым уже посчитан результат', () => {
  const ok = row('needs-review', { how: 'proposal', previewStatus: 'within-tolerance' });
  assert.equal(V.canAcceptRow(ok), true);
  assert.equal(V.canAcceptRow(row('needs-review', { how: 'proposal', previewStatus: 'outside-tolerance' })), true);
  assert.equal(V.canAcceptRow(row('needs-review', { how: 'proposal', previewStatus: 'tolerance-not-specified' })), true);
  assert.equal(V.canAcceptRow(row('needs-review', { how: 'proposal', previewStatus: 'units-unconfirmed' })), false, 'без единиц принимать нечего');
  assert.equal(V.canAcceptRow(row('needs-review', { how: 'proposal' })), false);
  assert.equal(V.canAcceptRow(row('within-tolerance', { how: 'auto', previewStatus: 'within-tolerance' })), false, 'уже сверено');
  assert.equal(V.canAcceptRow(row('needs-review', { how: 'proposal', previewStatus: 'within-tolerance', confirmed: true })), false);
  assert.equal(V.acceptableRows([ok, row('no-match')]).length, 1);
});

test('название строки: своё имя, иначе режим и номер', () => {
  assert.equal(V.rowTitle({ label: 'Стена A', mode: 'distance', index: 3 }), 'Стена A');
  assert.equal(V.rowTitle({ mode: 'plane', index: 0 }), 'Плоскость 1');
  assert.equal(V.rowTitle({ mode: 'distance', index: 4 }), 'Расстояние 5');
  assert.equal(V.rowTitle({ index: 1 }), 'Измерение 2');
});

test('типы объектов: список в окне сверки и в инспекторе совпадает', () => {
  const m = INS.match(/var KINDS = (\[\[[\s\S]*?\]\]);/);
  assert.ok(m, 'в инспекторе есть KINDS');
  const inspectorKinds = eval(m[1]).map((p) => p[0]).filter(Boolean);
  assert.deepEqual(inspectorKinds, V.KINDS);
});

test('мост app.js: окно сверки и инспектор получают всё нужное через window.__lxDocCheck', () => {
  const bridge = APP.match(/window\.__lxDocCheck = \{([\s\S]*?)\n  \};/);
  assert.ok(bridge, 'мост объявлен');
  for (const k of ['meta', 'rows', 'row', 'add', 'update', 'candidates', 'accept', 'setDefaultUnits', 'setContext', 'remove', 'requirements', 'run', 'runAll', 'details', 'openDocument', 'exportCsv']) {
    assert.match(bridge[1], new RegExp('\\b' + k + '\\s*:'), 'метод моста: ' + k);
  }
  assert.match(APP, /lx-measurements-changed/, 'событие обновления списка измерений');
  assert.match(APP, /objectTypeChosenByUser/, 'выбранный вами тип объекта помечается в контексте измерения');
  assert.match(APP, /unitsConfirmedByUser/, 'подтверждённые единицы помечаются в контексте измерения');
  assert.match(APP, /user-accepted-suggestion/, 'принятое предложение записывается как подтверждённое вами');
});

test('инспектор: каждое измерение сохраняется в проект и открывает сверку', () => {
  assert.match(INS, /__lxDocCheck/, 'инспектор работает с мостом');
  assert.match(INS, /\.add\(/, 'новое измерение отправляется в список проекта');
  assert.match(INS, /__lxVerify/, 'статус-чип открывает окно сверки');
  assert.match(INS, /lxInsKinds/, 'есть выбор «Что вы измеряете»');
});

test('окно сверки подключено в index.html в правильном порядке', () => {
  assert.match(HTML, /ui\/verify\.css/);
  assert.match(HTML, /ui\/verify\.js/);
  assert.ok(HTML.indexOf('ui/tools.css') < HTML.indexOf('ui/verify.css'), 'CSS после tools.css');
  assert.ok(HTML.indexOf('ui/modes.js') < HTML.indexOf('ui/verify.js') && HTML.indexOf('ui/verify.js') < HTML.lastIndexOf('ui/chrome.js'), 'JS между modes.js и chrome.js');
  assert.match(HTML, /id="mlOpenVerify"/, 'в списке измерений есть кнопка «Таблица»');
});

test('окно сверки: доступность и правила интерфейса', () => {
  const js = read('ui/verify.js'), css = read('ui/verify.css');
  assert.match(js, /role', 'dialog'/);
  assert.match(js, /aria-modal/);
  assert.match(js, /aria-labelledby/);
  assert.match(js, /'Escape'/, 'Esc закрывает окно');
  assert.match(js, /lx-measurements-changed/, 'таблица обновляется сама');
  assert.doesNotMatch(js, /[\u2713\u2715\u2264\u2265\u2192\u00d7]/, 'в коде нет символов-пиктограмм: только иконки набора');
  assert.doesNotMatch(js + css, /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u, 'нет эмодзи');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'цвета только из токенов');
  assert.match(css, /prefers-reduced-motion/, 'учтено «уменьшить анимацию»');
  assert.doesNotMatch(js, /\.onclick\s*=\s*[^;]*innerHTML/, 'нет динамической разметки из текста документов');
  assert.doesNotMatch(js, /\binnerHTML\s*=(?!\s*['"])/, 'innerHTML только для очистки');
});
