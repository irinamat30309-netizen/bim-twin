'use strict';
/*
 * r119 — Блок 3 ROADMAP-DOCS-AI: панель «Документация» в приложении.
 * Проверяем:
 *   • кнопку «Документация» рядом с «Построить BIM»/«Редактор модели»/«Качество модели»
 *     и динамическую загрузку renderer/lixel-scan2bim-docs.js (index.html не правим);
 *   • панель #lxS2BDocsPanel в стиле lx-*, палитра на токенах tokens.css
 *     (violet #a78bfa / #6a52cb, graphite #1c1b1a / #232221), без синего/белого/градиентов;
 *   • загрузку compare.json (input[type=file]) и валидацию схемы: валидный отчёт даёт
 *     заголовок объекта/адреса, скор 0–100 с цветом статуса и оценкой, таблицу
 *     проект↔модель↔облако (PASS/WARN/FAIL/—), Δмм/%, рекомендации, ограничения,
 *     непроверенные пункты; невалидный JSON — понятное сообщение и НЕ ломает состояние;
 *   • кнопки «Обновить» (перечитать файл), «Сохранить отчёт» (JSON download),
 *     «Загрузить отчёт сравнения», «Как получить отчёт» (модалка с пошаговой инструкцией
 *     и готовыми CLI-командами docs-extract.py/docs-compare.py + «Копировать команду»);
 *   • пустое состояние: порядок «1. Загрузите документацию → 2. Сравните с моделью →
 *     3. Исправьте» и напоминание, что облако/модель уже в приложении.
 * Часть проверок — source-level, часть — чистые функции в Node (обе схемы compare.json:
 * docs-compare.py и упрощённая), часть — jsdom (настоящий модуль + настоящий UI).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }

const ROOT = path.join(__dirname, '..');
const R = path.join(ROOT, 'renderer');
const SRC = fs.readFileSync(path.join(R, 'lixel-scan2bim-docs.js'), 'utf8');
const UI = fs.readFileSync(path.join(R, 'lixel-scan2bim-ui.js'), 'utf8');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const D = require(path.join(R, 'lixel-scan2bim-docs.js'));

// ---------- тестовые данные ----------
// Реальная схема docs-compare.py (schema_version=1): inputs.docs/model/cloud, rows с id/label.
function realReport() {
  return {
    schema_version: 1,
    generated_at: '2026-11-15T12:00:00Z',
    inputs: {
      docs: { path: 'D:\\docs', primary_pdf: 'main.pdf', pages: 245, object: 'Корпус', address: 'ул. Амосова, 6' },
      model: { path: 'py2-final-v4.json', md5: '74C97F0C', walls: 85, rooms: 23, storey_height_m: 3.278 },
      cloud: { path: 'cloud.bin', measured: true, floor_y: 0.182, ceil_y: 3.458, height_m: 3.276, floor_visible_m2: 127.9 }
    },
    score: 87,
    grade: 'A',
    coverage_pct: 66,
    summary: { checks: 4, pass: 1, warn: 1, fail: 1, unverified: 1 },
    rows: [
      {
        id: 'floor_height', category: 'floors', label: 'Высота этажа (чистая)',
        project: { value: 3300, unit: 'mm', source: 'docs.json:floors', page: 15 },
        model: { value: 3278, unit: 'mm', source: 'py2-final-v4.json:storey.height' },
        cloud: { value: 3276, unit: 'mm', source: 'ruler:cloud.height' },
        delta_mp: { abs: -22, unit: 'mm', pct: -0.67 }, delta_cm: { abs: -2, unit: 'mm', pct: -0.06 },
        tolerance: { abs: 50, unit: 'mm' }, status: 'PASS', note: 'в допуске'
      },
      {
        id: 'wall_t_250', category: 'walls', label: 'Толщина стен 250',
        project: { value: 276, unit: 'mm' }, model: { value: 257, unit: 'mm' }, cloud: null,
        delta_mp: { abs: -19, unit: 'mm', pct: -6.9 }, tolerance: { abs: 10, unit: 'mm' }, status: 'WARN'
      },
      {
        id: 'door_w_900', category: 'doors', label: 'Дверь 900',
        project: { value: 1000, unit: 'mm' }, model: { value: 880, unit: 'mm' }, cloud: null,
        delta_mp: { abs: -120, unit: 'mm', pct: -12 }, tolerance: { abs: 10, unit: 'mm' }, status: 'FAIL'
      },
      {
        id: 'bbox_x', category: 'dims', label: 'Габарит по X',
        project: { value: 43200, unit: 'mm' }, model: null, cloud: null,
        delta_mp: null, status: 'UNVERIFIED', note: 'нет облака'
      }
    ],
    recommendations: [
      { severity: 'warn', code: 'A3', text: 'Толщины стен: 257 вместо 276 мм' },
      { severity: 'fail', code: 'A7', text: 'Дверь 900: проём уже проекта' }
    ],
    limitations: ['Нет привязки к осям проекта'],
    unverified: [{ id: 'bbox_x', label: 'Габарит по X', reason: 'нет облака' }]
  };
}
// Упрощённая схема из постановки Блока 3: docs/model + rows[{name, project, model, cloud, delta_mm, delta_pct, status}].
function simpleReport() {
  return {
    docs: { object: 'Объект', address: 'Адрес' },
    model: { stats: { wallCount: 5 } },
    score: 50,
    rows: [
      { name: 'A', project: '100', model: '90', cloud: '—', delta_mm: -10, delta_pct: -10, status: 'FAIL' },
      { name: 'B', project: 10, model: 10, cloud: 10, delta_mm: 0, delta_pct: 0, status: 'PASS' },
      { name: 'C' }
    ],
    recommendations: ['Исправить расхождение A']
  };
}
function appModel() {
  return {
    ok: true, units: 'm', storey: { floorY: 0, ceilY: 3.28, height: 3.28 },
    footprint: [[0, 0], [10, 0], [10, 8], [0, 8]],
    walls: [{ a: [0, 0], b: [10, 0], thickness: 0.2, base: 0, height: 3.28, openings: [] }],
    rooms: [{ polygon: [[0, 0], [10, 0], [10, 8], [0, 8]], area: 79.1 }],
    slabs: [], stats: { wallCount: 1, roomCount: 1, roomsArea: 79.1, floorArea: 80 }
  };
}

// ---------- jsdom-окружение панели ----------
const q1 = (w, sel) => w.document.querySelector(sel);
const qa = (w, sel) => Array.from(w.document.querySelectorAll(sel));
const clickEl = (w, node) => node.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms || 0));

function makeDocsEnv(opts) {
  opts = opts || {};
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div id="lxLegacy"></div>' +
    '<div id="stageSideL"></div><div id="stageSideR"></div></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const log = { toasts: [], opened: 0, copied: [] };
  w.__toast = (m, k) => log.toasts.push({ msg: String(m), kind: k });
  const state = { model: opts.model || null };
  w.__lxScan2BIM = { state: state, open() { log.opened++; }, refreshPreview() { } };
  w.URL.createObjectURL = () => 'blob:docs';
  w.URL.revokeObjectURL = () => { };
  w.HTMLAnchorElement.prototype.click = function () { };
  if (opts.clipboard) {
    Object.defineProperty(w.navigator, 'clipboard', {
      value: { writeText: (t) => { log.copied.push(String(t)); return Promise.resolve(); } },
      configurable: true
    });
  }
  w.eval(SRC);
  return { w, log, state, D: w.__lxS2BDocs };
}
function loadFileInto(input, w, text, name) {
  const file = new w.File([text], name || 'compare.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new w.Event('change', { bubbles: true }));
}

// ===================== source-level =====================
test('r119: кнопка «Документация» рядом с построением/редактором/качеством и динамическая загрузка', () => {
  assert.match(UI, /bDocs\.id = 'lxScan2BimDocsBtn'/);
  assert.ok(UI.includes('Документация'), 'нет подписи кнопки «Документация»');
  const iBuild = UI.indexOf('lxScan2BimBuildBtn'), iEdit = UI.indexOf('lxScan2BimEditorBtn');
  const iQuality = UI.indexOf('lxScan2BimQualityBtn'), iDocs = UI.indexOf('lxScan2BimDocsBtn');
  assert.ok(iBuild > 0 && iEdit > iBuild && iQuality > iEdit && iDocs > iQuality,
    'порядок кнопок: построить → редактор → качество → документация');
  assert.ok(UI.includes("s.src = 'lixel-scan2bim-docs.js?v=119'"), 'нет динамической загрузки панели документации');
  assert.ok(UI.includes('D.open(state.model)'), 'модель не передаётся в панель документации');
  assert.ok(UI.includes('syncDocsModel'), 'модель не синхронизируется после построения');
  assert.match(UI, /docs:\s*openDocsModel/, 'в API «Скан → BIM» нет пункта docs');
  assert.ok(!HTML.includes('lixel-scan2bim-docs.js'), 'index.html не должен требовать правок (чужая зона)');
});

test('r119: модуль — панель #lxS2BDocsPanel, data-атрибуты, API', () => {
  assert.ok(SRC.includes("p.id = 'lxS2BDocsPanel'") && SRC.includes("getElementById('lxS2BDocsPanel')"), 'нет панели #lxS2BDocsPanel');
  assert.ok(SRC.includes('window.__lxS2BDocs'), 'нет публичного API в окне');
  assert.ok(SRC.includes('module.exports'), 'нет module.exports для node --test');
  for (const attr of ['data-d-panel', 'data-d-body', 'data-d-row=', 'data-d-row-status=', 'data-d-score',
    'data-d-score-value', 'data-d-grade', 'data-d-count=', 'data-d-badge', 'data-d-import-input',
    'data-d-status', 'data-d-rec', 'data-d-model-summary', 'data-d-title', 'data-d-object',
    'data-d-address', 'data-d-modal', 'data-d-help-step', 'data-d-cmd=', 'data-d-table']) {
    assert.ok(SRC.includes(attr), 'нет атрибута ' + attr);
  }
  for (const act of ['load-report', 'refresh', 'save-report', 'show-help', 'copy-command', 'close-help']) {
    assert.ok(SRC.includes('data-act="' + act + '"'), 'нет кнопки data-act=' + act);
  }
  for (const fn of ['parseCompareJson', 'scoreOf', 'rowToStatus', 'gradeOf', 'statusOfScore', 'summaryOf',
    'cellText', 'instructions', 'buildCommand', 'copyCommand', 'showHelp', 'loadFile', 'importJson',
    'refresh', 'saveReport', 'reportJson', 'getState']) {
    assert.strictEqual(typeof D[fn], 'function', 'нет функции ' + fn);
  }
  // только чтение файла: без Python/процессов/сети
  assert.ok(!/require\(\s*['"]child_process['"]\s*\)/.test(SRC), 'не должно быть child_process');
  assert.ok(!/\bspawn\s*\(/.test(SRC), 'не должно быть spawn(');
  assert.ok(!/\bfetch\s*\(/.test(SRC), 'не должно быть fetch(');
  // подтверждения — встроенные, не нативные prompt/confirm/alert (правило ui-dialogs)
  assert.ok(!/(?:window\.)?\b(?:prompt|confirm|alert)\s*\(/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')),
    'нативные prompt/confirm/alert запрещены');
});

test('r119: оформление — палитра токенов, без синего/белого/градиентов', () => {
  assert.ok(SRC.includes('var(--accent)') && SRC.includes('var(--bg-2)') && SRC.includes('var(--txt-3)'), 'нет токенов палитры');
  assert.ok(SRC.includes('#a78bfa') && SRC.includes('#6a52cb') && SRC.includes('#1c1b1a') && SRC.includes('#232221'),
    'в исходнике должна быть зафиксирована палитра задания (violet/graphite)');
  assert.ok(!/linear-gradient|radial-gradient/.test(SRC), 'градиенты запрещены дизайн-системой');
  assert.ok(!/#fff(?:fff)?\b/i.test(SRC), 'чистый белый запрещён дизайн-системой');
  assert.ok(SRC.includes('lx-s2bd') && SRC.includes('fpanel fp-right'), 'панель должна быть в стиле lx-*');
});

test('r119: пустое состояние — порядок 1-2-3 и напоминание про модель/облако в приложении', () => {
  assert.ok(SRC.includes('data-d-step="1"') && SRC.includes('data-d-step="2"') && SRC.includes('data-d-step="3"'),
    'нет трёх шагов пустого состояния');
  assert.ok(SRC.includes('Загрузите документацию') && SRC.includes('Сравните с моделью') && SRC.includes('Исправьте'),
    'нет текстов шагов');
  assert.ok(SRC.includes('__lxScan2BIM.state.model'), 'нет напоминания, что модель уже в приложении');
  assert.ok(SRC.includes('Облако и модель уже в приложении'), 'нет пояснения про облако/модель');
  assert.ok(SRC.includes('data-d-model-summary'), 'нет сводки модели приложения рядом со скором');
});

test('r119: инструкция «Как получить отчёт» — команды docs-extract/docs-compare и Python из DSH', () => {
  const ext = D.buildCommand('extract');
  const cmp = D.buildCommand('compare');
  assert.match(ext, /docs-extract\.py/, 'в команде извлечения нет docs-extract.py');
  assert.match(ext, /--input/, 'в команде извлечения нет --input');
  assert.match(ext, /--out/, 'в команде извлечения нет --out');
  assert.match(cmp, /docs-compare\.py/, 'в команде сравнения нет docs-compare.py');
  for (const flag of ['--docs', '--model', '--cloud', '--out']) assert.ok(cmp.includes(flag), 'в команде сравнения нет ' + flag);
  assert.ok(ext.includes(D.PYTHON_DEFAULT) && cmp.includes(D.PYTHON_DEFAULT), 'нет реального пути Python из DSH');
  assert.match(cmp, /D:\\BIM-TWIN-TEST\\docs\\compare\.json/, 'нет выходного compare.json');
  assert.ok(cmp.includes('PYTHONUTF8'), 'нет UTF-8 окружения (кириллица в PDF/JSON)');
  const instr = D.instructions();
  assert.strictEqual(instr.steps.length, 3);
  assert.strictEqual(instr.commands.length, 2);
  assert.ok(instr.notes.some((n) => /--strict/.test(n)), 'нет пояснения про --strict');
});

// ===================== чистые функции: парсинг/валидация =====================
test('r119: parseCompareJson — реальная схема docs-compare.py (inputs/rows/score/recommendations)', () => {
  const rep = realReport();
  const before = JSON.stringify(rep);
  const res = D.parseCompareJson(JSON.stringify(rep));
  assert.ok(res.ok, 'валидный отчёт отклонён: ' + res.reason);
  assert.strictEqual(JSON.stringify(rep), before, 'парсер не должен менять входной объект');
  const r = res.report;
  assert.strictEqual(r.score, 87);
  assert.strictEqual(r.score_derived, false);
  assert.strictEqual(r.grade, 'A');
  assert.strictEqual(r.coverage, 66);
  assert.strictEqual(r.docs.object, 'Корпус');
  assert.strictEqual(r.docs.address, 'ул. Амосова, 6');
  assert.strictEqual(r.docs.pages, 245);
  assert.strictEqual(r.rows.length, 4);
  assert.deepStrictEqual(r.rows.map((x) => x.status), ['pass', 'warn', 'fail', 'na']);
  assert.strictEqual(r.rows[0].project.text, '3300 мм');
  assert.strictEqual(r.rows[0].model.text, '3278 мм');
  assert.strictEqual(r.rows[0].cloud.text, '3276 мм');
  assert.match(D.deltaText(r.rows[0].delta), /−22 мм/);
  assert.match(D.deltaText(r.rows[0].delta), /−0,67 %/);
  assert.strictEqual(r.rows[0].tolerance.abs, 50);
  assert.strictEqual(r.rows[2].label, 'Дверь 900');
  assert.strictEqual(r.rows[3].cloud.text, '—');
  assert.strictEqual(r.recommendations.length, 2);
  assert.deepStrictEqual(r.recommendations.map((x) => x.severity), ['warn', 'fail']);
  assert.strictEqual(r.recommendations[0].code, 'A3');
  assert.deepStrictEqual(r.limitations, ['Нет привязки к осям проекта']);
  assert.strictEqual(r.unverified.length, 1);
  assert.strictEqual(r.unverified[0].reason, 'нет облака');
  assert.strictEqual(r.model.walls, 85);
  assert.strictEqual(r.model.rooms, 23);
  assert.strictEqual(r.cloud.measured, true);
  assert.strictEqual(r.summary.pass, 1);
  assert.strictEqual(r.summary.fail, 1);
});

test('r119: parseCompareJson — упрощённая схема постановки (docs/model/rows name/status)', () => {
  const res = D.parseCompareJson(simpleReport());
  assert.ok(res.ok, 'упрощённая схема отклонена: ' + res.reason);
  const r = res.report;
  assert.strictEqual(r.score, 50);
  assert.strictEqual(r.docs.object, 'Объект');
  assert.strictEqual(r.docs.address, 'Адрес');
  assert.strictEqual(r.rows.length, 3);
  assert.deepStrictEqual(r.rows.map((x) => x.status), ['fail', 'pass', 'na']);
  assert.strictEqual(r.rows[0].label, 'A');
  assert.strictEqual(r.rows[0].project.text, '100');
  assert.strictEqual(r.rows[0].delta.abs, -10);
  assert.strictEqual(r.rows[0].delta.pct, -10);
  assert.strictEqual(r.rows[2].project.text, '—');
  assert.strictEqual(r.recommendations.length, 1);
  assert.strictEqual(r.recommendations[0].text, 'Исправить расхождение A');
  assert.strictEqual(r.model.walls, 5);
  // без явного score скор выводится из строк: 1 PASS / 1 FAIL → 50
  const noScore = simpleReport();
  delete noScore.score;
  const derived = D.parseCompareJson(noScore);
  assert.ok(derived.ok);
  assert.strictEqual(derived.report.score, 50);
  assert.strictEqual(derived.report.score_derived, true);
});

test('r119: parseCompareJson — невалидный JSON отклоняется с понятной причиной', () => {
  const cases = [
    ['', /пуст/i],
    ['{', /синтаксис/i],
    ['null', /объект/i],
    ['[]', /объект/i],
    ['{}', /rows/i],
    ['{"rows":"no"}', /rows/i],
    ['{"rows":[{}]}', /название|label/i],
    ['{"rows":[{"name":"x"}],"score":"высокий"}', /score/i],
    ['{"rows":[{"name":"x"}],"score":{}}', /score/i],
    ['{"rows":[{"name":"x"}],"recommendations":"no"}', /recommendations/i],
    ['{"rows":[{"name":"x"}],"recommendations":[42]}', /recommendations/i],
    ['{"rows":[{"name":"x"}],"docs":"no"}', /docs/i],
    ['{"rows":[{"name":"x"}],"inputs":"no"}', /inputs/i],
    ['{"rows":[{"name":"x"}],"limitations":{}}', /limitations/i],
    ['{"rows":[{"name":"x"}],"unverified":"no"}', /unverified/i],
    ['{"rows":[{"name":"x"}],"schema_version":"v1"}', /schema_version/i]
  ];
  for (const [text, re] of cases) {
    const r = D.parseCompareJson(text);
    assert.ok(!r.ok, 'должно отклоняться: ' + JSON.stringify(text).slice(0, 50));
    assert.match(String(r.reason), re, 'непонятная причина для ' + JSON.stringify(text).slice(0, 50) + ': ' + r.reason);
  }
  // модель не должна ломаться на пустом массиве строк (это валидный «пустой» отчёт)
  const emptyRows = D.parseCompareJson('{"rows":[]}');
  assert.ok(emptyRows.ok, 'пустой rows должен приниматься: ' + emptyRows.reason);
  assert.strictEqual(emptyRows.report.rows.length, 0);
  assert.strictEqual(emptyRows.report.score, 0);
});

test('r119: rowToStatus — явный статус и вычисление из Δ/допуска', () => {
  assert.strictEqual(D.rowToStatus('PASS'), 'pass');
  assert.strictEqual(D.rowToStatus('pass'), 'pass');
  assert.strictEqual(D.rowToStatus('OK'), 'pass');
  assert.strictEqual(D.rowToStatus('WARN'), 'warn');
  assert.strictEqual(D.rowToStatus('WARNING'), 'warn');
  assert.strictEqual(D.rowToStatus('FAIL'), 'fail');
  assert.strictEqual(D.rowToStatus('ERROR'), 'fail');
  assert.strictEqual(D.rowToStatus('UNVERIFIED'), 'na');
  assert.strictEqual(D.rowToStatus('SKIP'), 'na');
  assert.strictEqual(D.rowToStatus('—'), 'na');
  assert.strictEqual(D.rowToStatus('???'), 'na');
  assert.strictEqual(D.rowToStatus(null), 'na');
  // derive: Δ в пределах допуска — PASS, вне — FAIL; без данных — «—»
  assert.strictEqual(D.rowToStatus({ delta_mm: -10 }), 'pass');
  assert.strictEqual(D.rowToStatus({ delta_mm: -50 }), 'fail');
  assert.strictEqual(D.rowToStatus({ delta_mm: -10, tolerance: { abs: 5 } }), 'fail');
  assert.strictEqual(D.rowToStatus({ delta_mp: { abs: 4, unit: 'mm' }, tolerance: 5 }), 'pass');
  assert.strictEqual(D.rowToStatus({ delta_pct: -1 }), 'pass');
  assert.strictEqual(D.rowToStatus({ delta_pct: -5 }), 'fail');
  assert.strictEqual(D.rowToStatus({}), 'na');
  // явный статус важнее Δ
  assert.strictEqual(D.rowToStatus({ delta_mm: -100, status: 'PASS' }), 'pass');
});

test('r119: scoreOf / gradeOf / statusOfScore / summaryOf', () => {
  assert.strictEqual(D.scoreOf({ score: 87 }), 87);
  assert.strictEqual(D.scoreOf({ score: { value: 42 } }), 42);
  assert.strictEqual(D.scoreOf({ score: 120 }), 100, 'скор клампится к 100');
  assert.strictEqual(D.scoreOf({ score: -5 }), 0, 'скор клампится к 0');
  assert.strictEqual(D.scoreOf([{ status: 'PASS' }, { status: 'PASS' }, { status: 'FAIL' }]), 67);
  assert.strictEqual(D.scoreOf([{ status: 'PASS' }, { status: 'WARN' }, { status: 'FAIL' }]), 50, 'WARN весит 0.5');
  assert.strictEqual(D.scoreOf([{ status: 'UNVERIFIED' }]), 0, 'только непроверенное — 0');
  assert.strictEqual(D.scoreOf([]), 0);
  assert.deepStrictEqual([95, 85, 80, 70, 60, 55, 45, 40, 10].map(D.gradeOf), ['A', 'A', 'B', 'B', 'C', 'C', 'D', 'D', 'E']);
  assert.strictEqual(D.statusOfScore(90), 'ok');
  assert.strictEqual(D.statusOfScore(70), 'warn');
  assert.strictEqual(D.statusOfScore(30), 'err');
  const sum = D.summaryOf({ rows: [{ status: 'PASS' }, { status: 'FAIL' }, { status: 'UNVERIFIED' }] });
  assert.deepStrictEqual([sum.checks, sum.pass, sum.fail, sum.unverified], [3, 1, 1, 1]);
  const explicit = D.summaryOf({ rows: [{ status: 'PASS' }], summary: { checks: 12, pass: 8, warn: 3, fail: 1, unverified: 2 } });
  assert.deepStrictEqual([explicit.checks, explicit.pass, explicit.warn, explicit.fail, explicit.unverified], [12, 8, 3, 1, 2]);
});

test('r119: cellText/modelSummaryOf — значения ячеек и сводка модели приложения', () => {
  assert.strictEqual(D.cellText({ value: 3300, unit: 'mm' }), '3300 мм');
  assert.strictEqual(D.cellText({ value: '3300', unit: 'mm' }), '3300 мм', 'число строкой тоже форматируется с единицей');
  assert.strictEqual(D.cellText({ value: 3.278, unit: 'm' }), '3,278 м');
  assert.strictEqual(D.cellText({ value: null }), '—');
  assert.strictEqual(D.cellText(null), '—');
  assert.strictEqual(D.cellText(42), '42');
  assert.strictEqual(D.cellText('—'), '—');
  const ms = D.modelSummaryOf(appModel());
  assert.strictEqual(ms.ok, true);
  assert.strictEqual(ms.walls, 1);
  assert.strictEqual(ms.rooms, 1);
  assert.ok(Math.abs(ms.area - 79.1) < 1e-6);
  assert.ok(Math.abs(ms.height - 3.28) < 1e-6);
  assert.strictEqual(D.modelSummaryOf(null).ok, false);
});

test('r119: setReport/reportJson/clearReport — состояние, round-trip, ошибки не сбрасывают отчёт', () => {
  const text = JSON.stringify(realReport());
  const good = D.setReport(text);
  assert.ok(good.ok, 'setReport не принял отчёт: ' + good.reason);
  assert.strictEqual(D.reportJson(), text, 'reportJson должен возвращать исходный JSON');
  assert.strictEqual(D.getReport().score, 87);
  const bad = D.setReport('{"rows":[{}]}');
  assert.ok(!bad.ok, 'невалидный отчёт принят');
  assert.strictEqual(D.getReport().score, 87, 'при ошибке прежний отчёт должен сохраняться');
  assert.ok(D.getState().error, 'нет сообщения об ошибке');
  assert.strictEqual(D.clearReport(), true);
  assert.strictEqual(D.getReport(), null);
  assert.strictEqual(D.reportJson(), null);
});

// ===================== jsdom: панель =====================
test('r119: панель (jsdom) — пустое состояние, шаги, импорт и сводка модели приложения', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const { w, D: d } = makeDocsEnv({ model: appModel() });
  t.after(() => { try { d.close(); } catch (e) { } });
  d.open();                                  // без аргумента — модель берётся из приложения
  const panel = q1(w, '#lxS2BDocsPanel');
  assert.ok(panel, 'панель не создана');
  assert.strictEqual(panel.style.display, 'block');
  assert.strictEqual(panel.getAttribute('aria-label'), 'Документация: сравнение с моделью');
  assert.ok(q1(w, '[data-d-panel]') === panel, 'нет data-d-panel');
  assert.ok(qa(w, '[data-d-step]').length === 3, 'в пустом состоянии должны быть 3 шага');
  assert.match(q1(w, '[data-d-hint="empty"]').textContent, /отчёт сравнения/i);
  assert.match(q1(w, '[data-d-note="source"]').textContent, /state\.model/);
  assert.ok(q1(w, 'input[type="file"][data-d-import-input]'), 'нет input[type=file]');
  assert.ok(q1(w, '[data-act="load-report"]') && /Загрузить отчёт сравнения/.test(q1(w, '[data-act="load-report"]').textContent));
  assert.ok(q1(w, '[data-act="show-help"]'), 'нет кнопки «Как получить отчёт»');
  // сводка модели приложения (построена)
  const ms = q1(w, '[data-d-model-summary]');
  assert.ok(ms && ms.getAttribute('data-d-model-summary') !== 'none', 'нет сводки загруженной модели');
  assert.match(ms.textContent, /Стены 1/);
  assert.match(ms.textContent, /Помещения 1/);
  assert.match(ms.textContent, /79,1 м²/);
  // клик по «Загрузить отчёт» открывает выбор файла
  let clicks = 0;
  q1(w, 'input[data-d-import-input]').addEventListener('click', () => { clicks++; });
  clickEl(w, q1(w, '[data-act="load-report"]'));
  assert.strictEqual(clicks, 1, 'кнопка импорта не открыла выбор файла');
});

test('r119: панель (jsdom) — загрузка compare.json: скор, таблица, рекомендации', { skip: !JSDOM && 'jsdom не установлен' }, async (t) => {
  const { w, D: d } = makeDocsEnv({ model: appModel() });
  t.after(() => { try { d.close(); } catch (e) { } });
  d.open();
  loadFileInto(q1(w, 'input[data-d-import-input]'), w, JSON.stringify(realReport()), 'compare.json');
  await sleep(180);
  assert.ok(q1(w, '[data-d-title]'), 'нет заголовка отчёта');
  assert.match(q1(w, '[data-d-object]').textContent, /Корпус/);
  assert.match(q1(w, '[data-d-address]').textContent, /Амосова/);
  // скор и цвет статуса
  assert.strictEqual(q1(w, '[data-d-score]').getAttribute('data-d-score'), '87');
  assert.strictEqual(q1(w, '[data-d-score]').getAttribute('data-d-grade'), 'A');
  assert.strictEqual(q1(w, '[data-d-score-value]').textContent, '87');
  assert.match(q1(w, '[data-d-score]').className, /ok/, 'скор 87 должен быть в зелёной зоне');
  const counts = Object.fromEntries(qa(w, '[data-d-count]').map((n) => [n.getAttribute('data-d-count'), n.textContent.trim()]));
  assert.match(counts.pass, /PASS 1/);
  assert.match(counts.warn, /WARN 1/);
  assert.match(counts.fail, /FAIL 1/);
  assert.match(counts.na, /— 1/);
  assert.match(q1(w, '[data-d-coverage]').textContent.trim(), /66/);
  // таблица проект↔модель↔облако
  const rows = qa(w, '[data-d-row]');
  assert.strictEqual(rows.length, 4, 'ожидались 4 строки сравнения, а не ' + rows.length);
  assert.deepStrictEqual(rows.map((r) => r.getAttribute('data-d-row-status')), ['pass', 'warn', 'fail', 'na']);
  const row0 = q1(w, '[data-d-row="floor_height"]');
  assert.strictEqual(row0.querySelector('[data-d-cell="project"]').textContent, '3300 мм');
  assert.strictEqual(row0.querySelector('[data-d-cell="model"]').textContent, '3278 мм');
  assert.strictEqual(row0.querySelector('[data-d-cell="cloud"]').textContent, '3276 мм');
  assert.match(row0.querySelector('[data-d-cell="delta"]').textContent, /−22 мм/);
  assert.strictEqual(row0.querySelector('[data-d-cell="delta"]').getAttribute('data-d-delta-abs'), '-22');
  assert.strictEqual(q1(w, '[data-d-row="door_w_900"] [data-d-badge]').textContent, 'FAIL');
  assert.strictEqual(q1(w, '[data-d-row="bbox_x"] [data-d-badge]').textContent, '—');
  assert.strictEqual(q1(w, '[data-d-row="bbox_x"] [data-d-cell="project"]').textContent, '43200 мм');
  // рекомендации / ограничения / непроверенное
  assert.strictEqual(qa(w, '[data-d-rec]').length, 2);
  assert.deepStrictEqual(qa(w, '[data-d-rec]').map((r) => r.getAttribute('data-d-severity')), ['warn', 'fail']);
  assert.match(qa(w, '[data-d-rec]')[1].textContent, /Дверь 900/);
  assert.strictEqual(qa(w, '[data-d-limit]').length, 1);
  assert.strictEqual(qa(w, '[data-d-unv]').length, 1);
  // кнопки и статус
  assert.ok(q1(w, '[data-act="refresh"]') && q1(w, '[data-act="save-report"]') && q1(w, '[data-act="show-help"]'));
  assert.match(q1(w, '[data-d-status]').textContent, /скор 87\/100/);
  assert.match(q1(w, '[data-d-file]').textContent, /compare\.json/);
});

test('r119: панель (jsdom) — невалидный JSON не ломает загруженный отчёт', { skip: !JSDOM && 'jsdom не установлен' }, async (t) => {
  const { w, D: d } = makeDocsEnv({ model: appModel() });
  t.after(() => { try { d.close(); } catch (e) { } });
  d.open();
  loadFileInto(q1(w, 'input[data-d-import-input]'), w, JSON.stringify(realReport()), 'compare.json');
  await sleep(150);
  assert.strictEqual(qa(w, '[data-d-row]').length, 4);
  const before = q1(w, '[data-d-score]').getAttribute('data-d-score');
  // битый JSON
  loadFileInto(q1(w, 'input[data-d-import-input]'), w, '{"rows":[{}]}', 'bad.json');
  await sleep(150);
  assert.ok(q1(w, '[data-d-error]'), 'нет сообщения об ошибке импорта');
  assert.match(q1(w, '[data-d-error]').textContent, /Импорт отклонён/);
  assert.match(q1(w, '[data-d-error]').textContent, /назван|label|нет/i);
  assert.strictEqual(qa(w, '[data-d-row]').length, 4, 'таблица должна остаться прежней');
  assert.strictEqual(q1(w, '[data-d-score]').getAttribute('data-d-score'), before, 'скор не должен меняться');
  // невалидная схема — тоже не ломает
  loadFileInto(q1(w, 'input[data-d-import-input]'), w, '{"rows":"no"}', 'bad2.json');
  await sleep(150);
  assert.strictEqual(qa(w, '[data-d-row]').length, 4);
  // снова валидный — обновляет
  const changed = realReport();
  changed.score = 42;
  changed.rows = [changed.rows[0]];
  loadFileInto(q1(w, 'input[data-d-import-input]'), w, JSON.stringify(changed), 'compare2.json');
  await sleep(150);
  assert.strictEqual(q1(w, '[data-d-score]').getAttribute('data-d-score'), '42');
  assert.strictEqual(qa(w, '[data-d-row]').length, 1);
  assert.ok(!q1(w, '[data-d-error]'), 'после успешного импорта сообщение об ошибке должно убираться');
});

test('r119: панель (jsdom) — «Обновить» перечитывает файл, «Сохранить отчёт» скачивает JSON', { skip: !JSDOM && 'jsdom не установлен' }, async (t) => {
  const { w, D: d, log } = makeDocsEnv({ model: appModel() });
  t.after(() => { try { d.close(); } catch (e) { } });
  d.open();
  loadFileInto(q1(w, 'input[data-d-import-input]'), w, JSON.stringify(realReport()), 'compare.json');
  await sleep(150);
  assert.strictEqual(qa(w, '[data-d-row]').length, 4);
  // «Обновить» — перечитать тот же файл
  clickEl(w, q1(w, '[data-act="refresh"]'));
  await sleep(180);
  assert.strictEqual(qa(w, '[data-d-row]').length, 4, 'после «Обновить» таблица должна остаться');
  assert.match(q1(w, '[data-d-status]').textContent, /скор 87\/100|Загружено/);
  // «Сохранить отчёт» — Blob с исходным JSON
  let captured = null;
  w.URL.createObjectURL = (blob) => { captured = blob; return 'blob:save'; };
  clickEl(w, q1(w, '[data-act="save-report"]'));
  await sleep(30);
  assert.ok(captured, 'экспорт не создал Blob');
  const text = await new Promise((resolve, reject) => {
    const fr = new w.FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = reject;
    fr.readAsText(captured);
  });
  const saved = JSON.parse(text);
  assert.strictEqual(saved.score, 87);
  assert.strictEqual(saved.rows.length, 4);
  assert.ok(saved.recommendations.length === 2, 'в сохранённом отчёте нет рекомендаций');
  assert.ok(log.toasts.some((x) => /Отчёт сохранён/.test(x.msg)), 'нет уведомления о сохранении');
});

test('r119: панель (jsdom) — модалка «Как получить отчёт»: шаги, команды, «Копировать»', { skip: !JSDOM && 'jsdom не установлен' }, async (t) => {
  const { w, D: d, log } = makeDocsEnv({ model: appModel(), clipboard: true });
  t.after(() => { try { d.close(); } catch (e) { } });
  d.open();
  clickEl(w, q1(w, '[data-act="show-help"]'));
  await sleep(30);
  const modal = q1(w, '[data-d-modal="help"]');
  assert.ok(modal, 'модалка инструкции не открылась');
  assert.strictEqual(qa(w, '[data-d-help-step]').length, 3, 'в модалке нет 3 шагов');
  assert.strictEqual(qa(w, '[data-d-cmd]').length, 2, 'в модалке нет 2 команд');
  const extract = q1(w, '[data-d-cmd="extract"]').textContent;
  const compare = q1(w, '[data-d-cmd="compare"]').textContent;
  assert.match(extract, /docs-extract\.py/);
  assert.match(compare, /docs-compare\.py/);
  assert.match(compare, /--cloud/);
  assert.match(compare, /\.dsh/, 'в команде нет реального пути Python из DSH');
  assert.match(compare, /compare\.json/);
  assert.ok(q1(w, '[data-act="copy-command"]'), 'нет кнопки «Копировать»');
  // копирование в буфер
  clickEl(w, q1(w, '[data-act="copy-command"][data-cmd="compare"]'));
  await sleep(30);
  assert.strictEqual(log.copied.length, 1, 'команда не скопирована');
  assert.match(log.copied[0], /docs-compare\.py/);
  assert.match(log.copied[0], /--out/);
  assert.match(q1(w, '[data-d-help-status]').textContent, /скопирована/);
  // закрытие по кнопке и по Esc
  clickEl(w, q1(w, '[data-act="close-help"]'));
  assert.ok(!q1(w, '[data-d-modal="help"]'), 'модалка не закрылась');
  d.showHelp();
  await sleep(10);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(!q1(w, '[data-d-modal="help"]'), 'Esc не закрывает модалку');
});

test('r119: панель (jsdom) — без модели показывает «модель не построена» и импорт доступен', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const { w, D: d } = makeDocsEnv({ model: null });
  t.after(() => { try { d.close(); } catch (e) { } });
  d.open(null);
  const ms = q1(w, '[data-d-model-summary]');
  assert.ok(ms, 'нет блока сводки модели');
  assert.strictEqual(ms.getAttribute('data-d-model-summary'), 'none');
  assert.ok(q1(w, '[data-d-hint="empty"]'), 'нет подсказки пустого состояния');
  assert.ok(q1(w, '[data-act="import-json"]') || q1(w, '[data-act="load-report"]'), 'импорт должен быть доступен без модели');
  assert.strictEqual(qa(w, '[data-d-row]').length, 0, 'без отчёта строк быть не должно');
});

test('r119: интеграция (jsdom) — кнопка «Документация» в панели «Скан → BIM»', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div id="lxLegacy"></div>' +
    '<div class="stage"><div id="stageSideL"></div><div id="stageSideR"></div></div></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  t.after(() => { try { if (w.__lxS2BDocs) w.__lxS2BDocs.close(); } catch (e) { } });
  const toasts = [];
  w.__toast = (m) => toasts.push(String(m));
  w.__viewer = { base: [], _setOverlay() { }, render() { } };
  w.eval(UI);                                   // настоящий renderer/lixel-scan2bim-ui.js
  const api = w.__lxScan2BIM;
  assert.ok(api, 'UI не установил window.__lxScan2BIM');
  assert.strictEqual(typeof api.docs, 'function', 'нет пункта открытия панели документации в API');
  api.open();
  const btn = w.document.getElementById('lxScan2BimDocsBtn');
  assert.ok(btn, 'нет кнопки «Документация» в панели «Скан → BIM»');
  assert.match(btn.textContent, /Документация/);
  api.state.model = appModel();                 // модель после «Построить BIM»
  btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const tag = w.document.querySelector('script[src*="lixel-scan2bim-docs.js"]');
  assert.ok(tag, 'динамический <script> панели документации не создан');
  w.eval(SRC);
  tag.onload();
  assert.ok(w.__lxS2BDocs, 'модуль документации не установлен в окне');
  const panel = w.document.getElementById('lxS2BDocsPanel');
  assert.ok(panel && panel.style.display === 'block', 'панель документации не открылась');
  assert.strictEqual(w.__lxS2BDocs.isOpen(), true);
  // закрытие «Скан → BIM» не закрывает панель документации
  api.close();
  assert.strictEqual(w.__lxS2BDocs.isOpen(), true, 'панель документации закрылась вместе с «Скан → BIM»');
  assert.ok(toasts.every((x) => !/Не удалось загрузить панель документации/.test(x)), 'были ошибки загрузки: ' + toasts.join('; '));
});
