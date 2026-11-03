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
  for (const k of ['meta', 'rows', 'row', 'add', 'update', 'candidates', 'accept', 'setDefaultUnits', 'setContext', 'remove', 'requirements', 'run', 'runAll', 'details', 'openDocument', 'exportCsv', 'fields', 'manual']) {
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

test('окно сверки: строка, обрезанная многоточием, получает подсказку с полным текстом и теряет её, когда текст помещается', () => {
  const js = read('ui/verify.js');
  assert.match(js, /function tipClipped\(/);
  assert.match(js, /e\.scrollWidth > e\.clientWidth \+ 1/, 'подсказка нужна, только если текст действительно обрезан');
  assert.match(js, /hydrate\(bodyEl\);\s*tipClipped\(bodyEl\);/, 'после каждой перерисовки таблицы');
  assert.match(js, /addEventListener\('resize'/, 'и при изменении ширины окна');
  assert.match(js, /removeAttribute\('data-tip'\)/, 'снимается и подсказка, которую kit уже перенёс из title в data-tip');
  const mk = (sw, cw, extra) => { const attrs = Object.assign({}, extra); return { scrollWidth: sw, clientWidth: cw, textContent: ' Сертификат огнестойкости ', closest: () => null, hasAttribute: (k) => k in attrs, setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, attrs }; };
  const src = js.slice(js.indexOf('var CLIP_SEL'), js.indexOf('function chip('));
  const fn = new Function('const W = null;' + src + 'return tipClipped;')();
  const cut = mk(300, 200), fit = mk(200, 200), stale = mk(100, 200, { title: 'старое', 'data-vf-clip': '1', 'data-tip': 'старое' });
  fn({ querySelectorAll: () => [cut, fit, stale] });
  assert.equal(cut.attrs.title, 'Сертификат огнестойкости', 'обрезанное: полный текст без пробелов по краям');
  assert.equal(fit.attrs.title, undefined, 'помещающееся не получает подсказку');
  assert.deepEqual(Object.keys(stale.attrs), [], 'то, что теперь помещается, лишается нашей подсказки');
});

/* ---------- Свои размеры и «Сравнить со своим размером» ---------- */
const C = require('../renderer/measurement-doc-compare.js');
const vm = require('node:vm');

test('свои размеры: единицы, причины отказа и тексты результата', () => {
  assert.deepEqual(V.MAN_UNITS.map((u) => u[0]), ['мм', 'см', 'м', 'ft', 'in', '\u00b0', '%', 'м\u00b2']);
  for (const reason of ['no-label', 'bad-size', 'no-field', 'kind-mismatch', 'units', 'no-result', 'no-measurement']) {
    const t = V.manualReason(reason);
    assert.ok(/[а-я]/i.test(t) && t.length > 25, 'у причины «' + reason + '» есть понятный текст');
    assert.match(APP, new RegExp("reason: '" + reason + "'"), 'app.js отдаёт причину «' + reason + '», а окно её объясняет');
  }
  assert.match(V.manualReason('что-то-новое'), /^Не получилось/);
  assert.equal(V.compareMessage({ ok: true, status: 'within-tolerance', actualText: '905.0 мм', deltaText: '0.0 мм' }), 'В допуске: замер 905.0 мм, разница 0.0 мм');
  assert.equal(V.compareMessage({ ok: true, status: 'outside-tolerance', actualText: '915 мм', deltaText: '+10 мм' }), 'Отклонение: замер 915 мм, разница +10 мм');
  assert.match(V.compareMessage({ ok: true, status: 'tolerance-not-specified', actualText: '905 мм', deltaText: '+5 мм' }), /^Допуск не указан, разница посчитана: замер 905 мм/);
  assert.equal(V.compareMessage({ ok: true, status: 'within-tolerance' }), 'В допуске: замер —', 'нет чисел — не выдумываем их');
  assert.equal(V.compareMessage({ ok: false, reason: 'units' }), V.manualReason('units'));
  assert.equal(V.compareMessage(null), V.manualReason(''));
});

test('свои размеры: единицы по виду величины и следующий тип размера в форме', () => {
  assert.equal(V.unitForKind('linear'), 'мм');
  assert.equal(V.unitForKind('angle'), '\u00b0');
  assert.equal(V.unitForKind('area'), 'м\u00b2');
  assert.equal(V.unitForKind('slope'), '%');
  assert.equal(V.unitForKind(undefined), 'мм');
  assert.deepEqual(V.newSize('height'), { dimension: 'height', value: '', unit: 'мм', tolerance: '' });
  assert.deepEqual(V.newSize('angle', '\u00b0'), { dimension: 'angle', value: '', unit: '\u00b0', tolerance: '' });
  assert.deepEqual(V.newSize(), { dimension: 'width', value: '', unit: 'мм', tolerance: '' });
  assert.equal(V.nextDimension([]), 'width');
  assert.equal(V.nextDimension([{ dimension: 'width' }]), 'height');
  assert.equal(V.nextDimension([{ dimension: 'height' }, { dimension: 'width' }]), 'thickness');
  assert.equal(V.nextDimension(['width', 'height', 'thickness', 'length', 'gap', 'diameter'].map((d) => ({ dimension: d }))), 'unspecified');
});

/* Настоящая dcManualRequirement из app.js + настоящий сравниватель: проверяем числа, а не пересказ кода */
function manualEnv() {
  const a = APP.indexOf('  const DC_MANUAL_DIMS'), dims = APP.slice(a, APP.indexOf('\n', a));
  const f0 = APP.indexOf('  function dcManualRequirement('), f1 = APP.indexOf('  function dcManualEntries()');
  assert.ok(a > 0 && f0 > 0 && f1 > f0, 'функции ручных размеров найдены в app.js');
  const sb = { window: { MeasurementDocCompare: C }, comparisonDimensionLabel: (d) => d };
  sb.globalThis = sb; vm.createContext(sb);
  vm.runInContext(dims + '\n' + APP.slice(f0, f1) + '\n;globalThis.__req = dcManualRequirement;', sb);
  return sb.__req;
}
const PLANE = { mode: 'plane', length: 2.1, width: 0.905, rectArea: 1.9, kind: 'стена', dip: 89.6 };
function manualCompare(req, m) {
  const fields = C.measurementFields(m), f = C.suggestField(req, fields), u = C.suggestMeasurementUnit('м', f.kind);
  return { field: f, res: C.compareMeasurement({ measurement: m, requirement: req, fields, fieldKey: f.key, unit: u.unit, requirementConfirmed: true, unitConfirmed: true }) };
}

test('свои размеры: номинал и допуск становятся требованием и сравниваются так же, как числа из документов', () => {
  const mk = manualEnv();
  const req = mk('Дверной проём Д-1', { dimension: 'width', value: '905', unit: 'мм', tolerance: '10' }, 'x', 0);
  assert.equal(req.kind, 'linear'); assert.equal(req.dimension, 'width');
  assert.equal(req.baseValue, 0.905); assert.equal(req.tolerance, 0.01); assert.equal(req.toleranceMode, 'symmetric');
  assert.equal(req.source.documentId, 'manual'); assert.match(req.source.excerpt, /Дверной проём Д-1/);
  assert.equal(req.needsConfirmation, false, 'человек сам ввёл число: подтверждать нечего');
  const ok = manualCompare(req, PLANE);
  assert.equal(ok.field.key, 'width', 'ширина проёма подбирается к короткой стороне плоскости');
  assert.equal(ok.res.status, 'within-tolerance');
  for (const [v, t, status] of [['915', '10', 'within-tolerance'], ['895', '10', 'within-tolerance'], ['920', '10', 'outside-tolerance'], ['906', '0.5', 'outside-tolerance'], ['905.5', '0.5', 'within-tolerance']]) {
    const r = manualCompare(mk('x', { dimension: 'width', value: v, unit: 'мм', tolerance: t }, 'x', 0), PLANE).res;
    assert.equal(r.status, status, v + ' ± ' + t + ' (граница допуска включена)');
  }
  assert.equal(manualCompare(mk('x', { dimension: 'width', value: '905', unit: 'мм', tolerance: '' }, 'x', 0), PLANE).res.status, 'tolerance-not-specified', 'без допуска вердикта нет');
  assert.equal(mk('x', { dimension: 'width', value: '0.905', unit: 'м', tolerance: '0,01' }, 'x', 0).baseValue, 0.905, 'метры и запятая вместо точки');
  assert.equal(mk('x', { dimension: 'width', value: '905,5', unit: 'мм', tolerance: '1' }, 'x', 0).baseValue, 0.9055);
  assert.equal(mk('x', { dimension: 'width', value: '90.5', unit: 'см', tolerance: '1' }, 'x', 0).baseValue, 0.905, 'сантиметры');
});

test('свои размеры: бессмысленные числа отвергаются, а не превращаются в вердикт', () => {
  const mk = manualEnv();
  for (const [v, u, t] of [['0', 'мм', '1'], ['-5', 'мм', '1'], ['abc', 'мм', '1'], ['', 'мм', ''], ['905', 'мм', '-1'], ['905', 'мм', 'abc'], ['905', 'мм', '1 мм'], ['905', 'кг', '']]) {
    assert.equal(mk('x', { dimension: 'width', value: v, unit: u, tolerance: t }, 'x', 0), null, JSON.stringify([v, u, t]));
  }
  assert.ok(mk('x', { dimension: 'angle', value: '0', unit: '\u00b0', tolerance: '1' }, 'x', 0), 'угол 0° допустим');
  assert.equal(mk('x', { dimension: 'width', value: '905', unit: 'мм', tolerance: '' }, 'x', 0).tolerance, null);
  assert.equal(mk('x', { dimension: 'нет-такого', value: '905', unit: 'мм', tolerance: '' }, 'x', 0).dimension, 'unspecified', 'неизвестный тип размера — «Размер»');
  const angle = mk('x', { dimension: 'angle', value: '90', unit: '\u00b0', tolerance: '1' }, 'x', 0);
  assert.equal(angle.kind, 'angle');
  const widthReq = mk('x', { dimension: 'width', value: '905', unit: 'мм', tolerance: '10' }, 'x', 0);
  assert.ok(!C.suggestField(widthReq, C.measurementFields({ mode: 'angle', deg: 91.4 })), 'у угла нет ширины: причина «no-field», а не вердикт');
  assert.ok(!C.suggestField(angle, C.measurementFields({ mode: 'distance', d3: 6.02, horizontal: 6.02, vertical: 0.01 })), 'угол нельзя сравнить с длиной');
});

test('свои размеры: окно сверки — блок «Свои размеры», «Сравнить со своим размером», фокус и доступность', () => {
  const js = read('ui/verify.js'), css = read('ui/verify.css');
  assert.match(js, /bodyEl\.appendChild\(manualNode\(\)\)/, 'блок «Свои размеры» на вкладке «Найдено в документах»');
  assert.match(js, /var own = compareNode\(r\); if \(own\) box\.appendChild\(own\)/, 'в раскрытой строке есть «Сравнить со своим размером»');
  assert.match(js, /id = 'lxVfManAdd'/); assert.match(js, /id = 'lxVfCmpGo'/);
  assert.match(js, /documentId !== 'manual'/, 'у введённого вручную нет документа, который можно открыть');
  assert.match(js, /dataset\.fk = key/, 'поля ввода помечены ключом фокуса');
  assert.match(js, /ae\.dataset\.fk[\s\S]{0,1500}back\.focus\(/, 'фокус и позиция курсора переживают перерисовку окна');
  assert.match(js, /setAttribute\('role', 'status'\)[\s\S]{0,80}aria-live/, 'результат объявляется скринридеру');
  assert.match(js, /setAttribute\('aria-label', aria\)/, 'у полей ввода есть подписи');
  assert.match(js, /e\.key === 'Enter'[\s\S]{0,80}onEnter\(\)/, 'Enter в поле отправляет форму');
  assert.match(js, /st\.sizes\.length >= 6/, 'не больше шести размеров у одного объекта');
  assert.match(css, /\.vf-size\b/); assert.match(css, /\.vf-own\b/); assert.match(css, /\.vf-own-msg\.ok/);
  for (const ico of ['pencil-ruler', 'plus', 'list-plus', 'trash-2', 'scale']) assert.match(js, new RegExp("'" + ico + "'"), 'иконка ' + ico);
});

test('свои размеры (app.js): сохраняются в проект, читаются и без помещения, результат помечен как введённый человеком', () => {
  assert.match(APP, /md\.docCheck = Object\.assign\(\{\}, md\.docCheck \|\| \{\}, \{ manual: __manualCache \}\)/, 'в метаданные проекта');
  assert.match(APP, /localStorage\.setItem\(DC_MANUAL_KEY/, 'запасной вариант — localStorage');
  assert.match(APP, /function dcManualScan\(\)/, 'сверка работает и без документов помещения');
  assert.match(APP, /record\.automation\.mode = 'user-entered'/);
  assert.match(APP, /record\.confirmations\.autoConfirmed = false/, 'вручную введённый размер не выдаётся за автоподтверждённый');
  assert.match(APP, /record\.confirmations\.method = 'user-entered-size'/);
  assert.match(APP, /field\.kind !== req\.kind\) return \{ ok: false, reason: 'kind-mismatch'/, 'длину нельзя сравнить с углом');
  assert.match(APP, /if \(!ranked\.unit\) return \{ ok: false, reason: 'units'/, 'без единиц облака вердикта нет');
  assert.match(APP, /slice\(0, 6\)\.map\(sz =>/, 'не больше шести размеров в записи');
  assert.match(APP, /\.slice\(0, 200\)/, 'не больше двухсот записей');
});
