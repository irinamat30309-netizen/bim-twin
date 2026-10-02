'use strict';
/* Реестр команд (renderer/ui/commands.js) и поведение ленты: каждая кнопка лежит на вкладке по своей функции,
 * а разметка, лента и режимы связаны только явными селекторами. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const R = path.join(__dirname, '..', 'renderer');
const read = (p) => fs.readFileSync(path.join(R, p), 'utf8');
const C = require('../renderer/ui/commands.js');
const HTML = read('index.html');
const RIBBON = read('ui/ribbon.js');
const MODES = read('ui/modes.js');
const CHROME = read('ui/chrome.js');
const APP = read('app.js');

const TAB_LABELS = { project: 'Проект', import: 'Импорт', cloud: 'Облако', floors: 'Этажи', measure: 'Измерения', draw: 'Чертёж', bim: 'BIM', view: 'Вид', tour: '3D-тур', qa: 'Контроль', export: 'Экспорт' };

test('лента: вкладки идут по рабочему процессу и имеют понятные подписи', () => {
  assert.deepEqual(C.TABS.map((t) => t.id), Object.keys(TAB_LABELS));
  for (const t of C.TABS) {
    assert.equal(t.label, TAB_LABELS[t.id]);
    assert.ok(t.groups.length >= 1, t.id + ': есть группы');
    for (const g of t.groups) assert.ok(g.label && g.label.length <= 26, `${t.id}/${g.id}: подпись группы короткая`);
  }
});

test('реестр: идентификаторы команд уникальны, у каждой есть иконка и способ запуска', () => {
  const seen = new Set();
  const all = C.all();
  assert.ok(all.length >= 110, 'команды на месте: ' + all.length);
  for (const { item, tab, group } of all) {
    assert.ok(!seen.has(item.id), 'повтор id: ' + item.id);
    seen.add(item.id);
    assert.ok(item.ico, item.id + ': иконка');
    assert.ok(item.sel || item.call || item.slot || item.special, `${tab.id}/${group.id}/${item.id}: нет способа запуска`);
    assert.ok(item.label === null || (typeof item.label === 'string' && item.label.length <= 22), item.id + ': подпись не длиннее 22 знаков');
    assert.ok(item.size === 'lg' || item.size === 'sm', item.id + ': размер lg | sm');
  }
});

test('реестр: все иконки команд есть в наборе icons.js', () => {
  const ctx = { window: null }; ctx.window = ctx; ctx.globalThis = ctx;
  vm.runInNewContext(read('icons.js'), ctx);
  const have = new Set(ctx.__lxIcons.names());
  const lack = [];
  for (const { item } of C.all()) if (!ctx.__lxIcons.has(item.ico) && !have.has(item.ico)) lack.push(item.id + ':' + item.ico);
  assert.deepEqual(lack, []);
  assert.match(ctx.__lxIcons.svg('нет-такой', 18), /data-icon-missing/, 'неизвестное имя помечается в разметке');
});

test('реестр: селекторы кнопок существуют в разметке или создаются модулями', () => {
  const ids = new Set([...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const CREATED = { lxObjInspectBtn: 'lixel-object-inspector.js', lxScan2BimBtn: 'lixel-scan2bim-ui.js', lxScan2BimAiBtn: 'scan2bim-ai-client.js', lxObjExtractBtn: 'lixel-object-extract.js' };
  for (const { item } of C.all()) {
    if (!item.sel) continue;
    const id = (/^#([\w-]+)$/.exec(item.sel) || [])[1];
    if (!id) { assert.match(item.sel, /^label\[for="\w+"\]$/, item.id + ': селектор label[for]'); assert.ok(ids.has(/for="(\w+)"/.exec(item.sel)[1]), item.id); continue; }
    if (CREATED[id]) assert.ok(read(CREATED[id]).includes("'" + id + "'"), `${id} создаётся в ${CREATED[id]}`);
    else assert.ok(ids.has(id), `${item.id}: в index.html нет #${id}`);
  }
});

test('реестр: вызываемые функции определены в модулях', () => {
  const OWNER = { __lxToolsExt: 'lixel-tools-ext.js', __lxSprintsExt: 'lixel-sprints-ext.js', __lxDrawExt: 'lixel-draw-ext.js', __lxSmartSave: 'lixel-smart-save.js',
    __lxScene: 'lixel-scene.js', __lxDrawUI: 'lixel-draw.js', __lxCloudUI: 'lixel-cloud-ui.js', __lxVerify: 'ui/verify.js' };
  const bad = [];
  for (const { item } of C.all()) {
    if (!item.call) continue;
    const parts = item.call.split('.');
    const owner = OWNER[parts[0]];
    if (!owner) { bad.push(item.id + ': неизвестный владелец ' + parts[0]); continue; }
    const src = read(owner);
    if (!src.includes(parts[0])) bad.push(`${item.id}: ${parts[0]} не объявлен в ${owner}`);
    const fn = parts[parts.length - 1];
    if (!new RegExp('\\b' + fn + '\\b').test(src)) bad.push(`${item.id}: ${fn} не найден в ${owner}`);
  }
  assert.deepEqual(bad, []);
});

test('каждая кнопка лежит на вкладке по своей функции', () => {
  const PLACE = {
    project: ['save', 'saveAs', 'autosave', 'btnProjectUndo', 'btnProjectRedo', 'drafts', 'btnNewProject', 'btnBackup', 'btnSettings', 'btnUsers', 'btnSync'],
    import: ['btnOpenCloud', 'vtStream', 'opPotree', 'modelInput', 'ifcInput', 'docInput'],
    cloud: ['vtQuality', 'vtClean', 'vtEdit', 'opResample', 'opDenoise', 'opPeople', 'opSmooth', 'opFlatten', 'opFloor', 'opWall', 'opMerge', 'opOverlay', 'vtConvert', 'vtGeom', 'opDSM', 'opDTM', 'opContours', 'opGround', 'opGeoref'],
    floors: ['floorAdd', 'floorIsolate', 'floorSlice', 'floorAttach', 'floorReport', 'btnBackRoom', 'btnEdit'],
    measure: ['btnMeasure', 'mmDistance', 'mmPoint', 'mmPolyline', 'mmAngle', 'mmArea', 'mmDiameter', 'mmPlane', 'mmDeviation', 'mmCorner', 'mmSnap', 'mmList', 'mmCsv', 'mmQaReport', 'mmNotion', 'vfOpen', 'lxObjInspectBtn'],
    draw: ['draw.pline', 'draw.line', 'draw.rect', 'draw.circle', 'draw.arc', 'draw.point', 'draw.dim', 'draw.text', 'draw.door', 'draw.window', 'draw.extend', 'draw.split', 'draw.snap', 'draw.ortho', 'draw.top', 'draw.sect', 'draw.ai', 'opWalls', 'draw.imp', 'draw.dxf'],
    bim: ['lxScan2BimBtn', 'lxScan2BimAiBtn', 'lxObjExtractBtn'],
    view: ['btnReset', 'view.top', 'view.front', 'view.side', 'view.iso', 'view.ortho', 'view.xray', 'btnSection', 'btnIsolate', 'btnLOD'],
    tour: ['tsSplatTop', 'tsSplatLcc2', 'tsMesh', 'tsConv3dgs', 'vtTour', 'tsPhoto', 'tsPhotoDemo'],
    qa: ['btnAI', 'btnVerify', 'btnCompare', 'vfOpenQa', 'opVolume', 'opCompareVolumes', 'opClosedVolume'],
    export: ['btnExport', 'opRCP', 'opMesh', 'opIFC4', 'opIFC']
  };
  const wrong = [];
  for (const [tab, ids] of Object.entries(PLACE)) for (const id of ids) if (!C.byId[id] || C.byId[id].tab !== tab) wrong.push(`${id}: ожидалась вкладка ${tab}, а не ${C.byId[id] && C.byId[id].tab}`);
  assert.deepEqual(wrong, []);
  // Ни одной команды вне этого списка «вслепую»: у каждой есть вкладка и группа.
  for (const { item } of C.all()) assert.ok(item.tab && item.group, item.id);
});

test('операции над облаком неактивны, пока облако не загружено', () => {
  for (const id of ['vtQuality', 'vtClean', 'vtEdit', 'opResample', 'opDenoise', 'opPeople', 'opSmooth', 'opFlatten', 'opFloor', 'opWall', 'opMerge', 'opOverlay', 'vtGeom', 'opDSM', 'opDTM', 'opContours',
    'opGround', 'opGeoref', 'floorSlice', 'opVolume', 'opCompareVolumes', 'opClosedVolume', 'opIFC4', 'opIFC', 'opRCP', 'opMesh']) {
    assert.equal(C.byId[id].needs, 'cloud', id + ' требует облако');
  }
  assert.match(RIBBON, /aria-disabled/, 'недоступная команда объясняется, а не молча не работает');
  assert.match(RIBBON, /Сначала откройте облако точек/, 'подсказка: как сделать команду доступной');
});

test('измерения: экспорт результатов остаётся в группе «Результаты»', () => {
  const g = C.TABS.find((t) => t.id === 'measure').groups.find((x) => x.id === 'results' || /Результат/.test(x.label));
  assert.ok(g, 'группа результатов есть');
  assert.deepEqual(g.items.map((i) => i.id), ['mmList', 'mmCsv', 'mmQaReport', 'mmNotion']);
});

test('этажи: кнопки связаны с публичным API дерева сцены', () => {
  for (const [id, fn] of [['floorAdd', 'addFloor'], ['floorIsolate', 'isolateActive'], ['floorSlice', 'autoSlice'], ['floorAttach', 'attachDoc'], ['floorReport', 'report']]) {
    assert.equal(C.byId[id].call, '__lxScene.' + fn);
    assert.ok(new RegExp(fn + '\\s*:').test(read('lixel-scene.js')), fn + ' экспортируется из lixel-scene.js');
  }
  const css = read('ui/panels.css');
  for (const cls of ['.lx-scene', '.lx-eye', '.lx-modal', '.lx-floor.active']) assert.ok(css.includes(cls), 'стили ' + cls);
});

test('лента усыновляет только известные кнопки и не перебирает все кнопки страницы', () => {
  assert.match(RIBBON, /function findLegacy\(sel\)/);
  assert.match(RIBBON, /\$\('lxLegacy'\)/, 'сначала ищет в контейнере исходных кнопок');
  assert.doesNotMatch(RIBBON, /querySelectorAll\(['"]button['"]\)/, 'глобального перебора кнопок нет');
  assert.doesNotMatch(RIBBON, /cloneNode/, 'кнопки переносятся вместе со слушателями, а не копируются');
  assert.match(RIBBON, /function place\(/);
  assert.match(HTML, /id="lxLegacy"/);
});

test('лента: доступность — роли, выбранная вкладка, стрелки, видимый фокус', () => {
  assert.match(RIBBON, /role: 'tab'/);
  assert.match(RIBBON, /'aria-selected'/);
  assert.match(RIBBON, /role: 'tabpanel'/);
  assert.match(RIBBON, /ArrowRight/);
  assert.match(RIBBON, /lx-rib-nav/, 'широкие вкладки прокручиваются кнопками-стрелками');
  const shell = read('ui/shell.css');
  assert.match(shell, /\.lx-tabs\s*\{[^}]*align-items:\s*stretch/s, 'вкладка растягивается на всю высоту полосы (крупная зона клика)');
  assert.match(shell, /\.lx-tabs\s*\{[^}]*height:\s*var\(--h-tabs\)/s, 'высота полосы вкладок задана токеном');
  assert.match(shell, /\.lx-sm\s*\{[^}]*min-height:\s*32px/s, 'малые кнопки не ниже 32 px');
  assert.match(shell, /overflow-x:\s*auto/, 'вкладки шире окна прокручиваются');
  assert.match(read('ui/base.css'), /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/s, 'видимый фокус с клавиатуры');
});

test('лента: кнопки, открывающие меню, помечены (menu) и получают стрелку и aria-haspopup', () => {
  const withMenu = C.TABS.flatMap((t) => t.groups.flatMap((g) => g.items)).filter((i) => i.menu).map((i) => i.id).sort();
  assert.deepEqual(withMenu, ['vtGeom', 'vtTools'], 'меню открывают «Чистка» и «Геометрия»');
  assert.match(RIBBON, /if \(item\.menu\)[\s\S]{0,240}lx-caret[\s\S]{0,160}aria-haspopup/);
  const shell = read('ui/shell.css');
  assert.match(shell, /\.lx-ico\.lx-caret/, 'стрелка оформлена');
  assert.match(shell, /\.lx-rb\[aria-expanded="true"\]/, 'открытое меню подсвечивает кнопку');
  assert.match(APP, /const gb = \$\('vtGeom'\)/, 'меню «Геометрия» открывается из app.js');
  assert.match(APP, /popover\(\{ anchor: tbTools/, 'меню «Чистка» открывается из app.js');
});

test('прогресс: карточка не мигает — показ с задержкой и минимальное время показа', () => {
  assert.match(MODES, /SHOW_DELAY\s*=\s*400/);
  assert.match(MODES, /MIN_SHOW\s*=\s*450/);
  assert.match(MODES, /shownAt\s*=\s*performance\.now\(\)/, 'момент показа запоминается');
  assert.match(MODES, /MIN_SHOW - \(performance\.now\(\) - shownAt\)/, 'закрытие ждёт остаток минимального времени');
  assert.match(read('ui/motion.css'), /\.lx-topprogress:not\(\[hidden\]\)\s*\{[^}]*animation:[^}]*300ms/, 'верхняя полоса появляется не сразу');
});

test('режимы: отмена снимает только инструменты, а не посторонние переключатели', () => {
  assert.match(MODES, /epoch\+\+/);
  assert.match(MODES, /token === epoch/);
  assert.match(MODES, /setMeasuring\(false\)/);
  assert.match(MODES, /__lxObjectExtract\.close/);
  assert.match(MODES, /__lxObjectInspector\.close/);
  assert.match(MODES, /W\.addEventListener\('keydown'/);
  assert.match(MODES, /\[data-mode-tool\]/, 'инструменты помечены атрибутом');
  assert.doesNotMatch(MODES, /querySelectorAll\(['"][^'"]*\.on[,'"]/, 'глобального снятия .on нет (AI-подсветка и параметры отображения не выключаются)');
  assert.match(RIBBON, /MODE_TOOLS/);
});

test('кнопка AI-подсветки берёт состояние из вьювера', () => {
  assert.ok(APP.includes("const aiBtn = $('btnAI'); const aiOn = !!viewer.showAI;"));
  assert.ok(APP.includes("aiBtn.setAttribute('aria-pressed', String(aiOn))"));
});

test('кнопки построения Скан → BIM имеют стабильные селекторы', () => {
  assert.ok(read('scan2bim-ai-client.js').includes("bGo.id = 'lxS2BBuildBtn'"));
  assert.ok(read('lixel-scan2bim-ui.js').includes("bBuild.id = 'lxScan2BimBuildBtn'"));
});

test('палитра команд (Ctrl+K): ищет по реестру и умеет нечёткий поиск', () => {
  assert.match(CHROME, /__lxCommands/);
  assert.ok(C.match('изм расст', 'Расстояние: измерение'));
  assert.ok(!C.match('чертёж дверь', 'Измерения'));
  assert.ok(C.match('', 'что угодно'));
});

test('адаптивность: ниже 1280 и 1100 px боковые панели сужаются, ниже 900 px панели инструментов уходят в поток', () => {
  const shell = read('ui/shell.css');
  assert.match(shell, /@media \(max-width: 1280px\)/);
  assert.match(shell, /@media \(max-width: 1100px\)/);
  assert.match(read('ui/tools.css'), /@media \(max-width: 900px\)/);
  assert.match(read('ui/tools.css'), /\.stage-side-l\s*\{[^}]*max-height:\s*calc\(100%/s, 'плавающие панели не выходят за экран');
});
