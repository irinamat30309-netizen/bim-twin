'use strict';
/*
 * r131 — интеграция панели «Документация» с объединённым отчётом compare-full-v5.json
 * (schema_version=1, rows с group, score=80.8/A, score_docs=91.7, score_doc_dimensions=70)
 * и обратная совместимость со старой схемой compare.json (v4 92.7/A, v5 91.7/A).
 *
 * Проверяем:
 *   • парсер на РЕАЛЬНОМ файле tools/scan2bim-py/compare-full-v5.json: 28 строк
 *     (PASS 16 / WARN 4 / FAIL 0 / UNVERIFIED 8), score 80.8/A, группы docs-compare (20)
 *     и «документация ↔ облако/модель» (8), score_doc_dimensions=70, score_docs=91.7,
 *     8 строк verify, inputs.model строкой-путём;
 *   • group в таблице панели (заголовки групп + data-d-group на строках);
 *   • «Проверка по документации»: score_doc_dimensions (70,0), 8 строк verify со статусами
 *     PASS/WARN/UNVERIFIED, пояснение «документация ↔ модель» / «документация ↔ облако»;
 *     кнопка сворачивает/разворачивает блок;
 *   • обратная совместимость: старые compare.json без group не дают заголовков групп,
 *     verify-блока нет, панель работает как раньше (v4 92.7/A и v5 91.7/A).
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
const D = require(path.join(R, 'lixel-scan2bim-docs.js'));

const FULL = path.join(ROOT, 'tools', 'scan2bim-py', 'compare-full-v5.json');
const OLD_V4 = 'D:\\BIM-TWIN-TEST\\docs\\compare.json';
const OLD_V5 = 'D:\\BIM-TWIN-TEST\\docs\\compare-v5.json';
const fullText = fs.existsSync(FULL) ? fs.readFileSync(FULL, 'utf8') : null;
const oldV4Text = fs.existsSync(OLD_V4) ? fs.readFileSync(OLD_V4, 'utf8') : null;
const oldV5Text = fs.existsSync(OLD_V5) ? fs.readFileSync(OLD_V5, 'utf8') : null;

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
  const log = { toasts: [] };
  w.__toast = (m, k) => log.toasts.push({ msg: String(m), kind: k });
  const state = { model: opts.model || null };
  w.__lxScan2BIM = { state: state, open() { }, refreshPreview() { } };
  w.URL.createObjectURL = () => 'blob:docs';
  w.URL.revokeObjectURL = () => { };
  w.HTMLAnchorElement.prototype.click = function () { };
  w.eval(SRC);
  return { w, D: w.__lxS2BDocs, log, state, dom };
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
function openWithFull(env) {
  env.D.open(appModel());
  const res = env.D.importJson(fullText, { fileName: 'compare-full-v5.json' });
  assert.ok(res && res.ok, 'combine-full-v5.json должен импортироваться: ' + (res && res.reason));
  return res;
}

// ===================== 1. Парсер реального объединённого отчёта =====================
test('r131: парсер compare-full-v5.json — 28 строк, score 80.8/A, группы, seed-поля', { skip: !fullText && 'нет файла compare-full-v5.json' }, () => {
  const res = D.parseCompareJson(fullText);
  assert.ok(res.ok, res.reason);
  const r = res.report;
  assert.strictEqual(r.score, 80.8, 'score объединённого отчёта');
  assert.strictEqual(r.grade, 'A');
  assert.strictEqual(r.rows.length, 28, '28 строк сравнения');
  // summary приходит в ВЕРХНЕМ регистре (PASS/WARN/FAIL/UNVERIFIED) — парсер должен принять
  assert.deepStrictEqual(
    { pass: r.summary.pass, warn: r.summary.warn, fail: r.summary.fail, unverified: r.summary.unverified },
    { pass: 16, warn: 4, fail: 0, unverified: 8 });
  // группы: 20 docs-compare + 8 проверки по документации
  assert.deepStrictEqual(r.groups, ['docs-compare', 'документация ↔ облако/модель']);
  assert.strictEqual(r.rows.filter((x) => x.group === 'docs-compare').length, 20);
  assert.strictEqual(r.verifyRows.length, 8, '8 строк verify');
  assert.ok(r.verifyRows.every((x) => x.group === 'документация ↔ облако/модель'), 'verify-строки в своей группе');
  // под-скоры и заголовок
  assert.strictEqual(r.scoreDocs, 91.7, 'score_docs');
  assert.strictEqual(r.scoreDocDimensions, 70, 'score_doc_dimensions');
  assert.match(r.title, /объединённый отчёт/i);
  assert.strictEqual(r.coverage, 90);
  // inputs.model в объединённом отчёте — строка-путь, а не объект
  assert.match(r.model.path, /py2-final-v5\.json/);
  assert.strictEqual(r.docs.object, '');
  // статусы verify: PASS/WARN/UNVERIFIED (FAIL нет)
  const st = r.verifyRows.reduce((a, x) => { a[x.status] = (a[x.status] || 0) + 1; return a; }, {});
  assert.deepStrictEqual(st, { pass: 4, warn: 2, na: 2 });
  // рекомендации/ограничения/непроверенные
  assert.strictEqual(r.recommendations.length, 6);
  assert.strictEqual(r.limitations.length, 5);
  assert.strictEqual(r.unverified.length, 8);
});

test('r131: парсер — строки group читаются, строки без group остаются совместимыми', () => {
  const mixed = {
    schema_version: 1, score: 50, rows: [
      { id: 'a', label: 'A', group: 'docs-compare', project: { value: 1, unit: 'mm' }, model: { value: 1, unit: 'mm' }, status: 'PASS' },
      { id: 'b', label: 'B', group: 'проверка', project: 'x', model: 'y', cloud: 'z', status: 'WARN' },
      { id: 'c', label: 'C', status: 'UNVERIFIED' }
    ]
  };
  const res = D.parseCompareJson(mixed);
  assert.ok(res.ok, res.reason);
  assert.deepStrictEqual(res.report.groups, ['docs-compare', 'проверка']);
  assert.deepStrictEqual(res.report.verifyRows.map((x) => x.id), ['b']);
  assert.strictEqual(res.report.rows[2].group, '');
  // без group — одна группа и verifyRows пуст
  const plain = D.parseCompareJson({ score: 40, rows: [{ label: 'A', status: 'PASS' }] });
  assert.ok(plain.ok);
  assert.deepStrictEqual(plain.report.groups, []);
  assert.strictEqual(plain.report.verifyRows.length, 0);
});

// ===================== 2. Обратная совместимость =====================
test('r131: обратная совместимость — старый compare.json v4 92.7/A не ломается', { skip: !oldV4Text && 'нет D:\\BIM-TWIN-TEST\\docs\\compare.json' }, () => {
  const res = D.parseCompareJson(oldV4Text);
  assert.ok(res.ok, res.reason);
  assert.strictEqual(res.report.score, 92.7);
  assert.strictEqual(res.report.grade, 'A');
  assert.strictEqual(res.report.rows.length, 25);
  assert.deepStrictEqual(res.report.groups, [], 'в старой схеме групп нет');
  assert.strictEqual(res.report.verifyRows.length, 0);
  assert.strictEqual(res.report.scoreDocs, null);
  assert.strictEqual(res.report.scoreDocDimensions, null);
});

test('r131: обратная совместимость — compare-v5.json 91.7/A не ломается', { skip: !oldV5Text && 'нет D:\\BIM-TWIN-TEST\\docs\\compare-v5.json' }, () => {
  const res = D.parseCompareJson(oldV5Text);
  assert.ok(res.ok, res.reason);
  assert.strictEqual(res.report.score, 91.7);
  assert.strictEqual(res.report.grade, 'A');
  assert.strictEqual(res.report.rows.length, 20);
  assert.deepStrictEqual(res.report.groups, []);
  assert.strictEqual(res.report.verifyRows.length, 0);
});

test('r131: старая схема в панели (jsdom) — без заголовков групп и без кнопки проверки', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const env = makeDocsEnv({ model: appModel() });
  t.after(() => { try { env.dom.window.close(); } catch (e) { } });
  env.D.open(appModel());
  const old = {
    schema_version: 1, score: 92.7, grade: 'A',
    rows: [
      { id: 'floor_height', category: 'floors', label: 'Высота этажа', project: { value: 3300, unit: 'mm' }, model: { value: 3278, unit: 'mm' }, cloud: { value: 3276, unit: 'mm' }, delta_mp: { abs: -22, unit: 'mm', pct: -0.67 }, status: 'PASS' },
      { id: 'wall_t_250', label: 'Толщина 250', project: { value: 250, unit: 'mm' }, model: { value: 257, unit: 'mm' }, cloud: null, delta_mp: { abs: 7, unit: 'mm' }, status: 'PASS' }
    ],
    recommendations: [{ severity: 'info', text: 'Всё в допуске' }]
  };
  const res = env.D.setReport(JSON.stringify(old));
  assert.ok(res.ok);
  const w = env.w;
  assert.strictEqual(qa(w, '[data-d-row]').length, 2);
  assert.strictEqual(qa(w, '[data-d-group-row]').length, 0, 'старая схема не должна рисовать заголовки групп');
  assert.ok(!q1(w, '[data-d-verify-block]'), 'в старой схеме нет блока проверки по документации');
  assert.ok(!q1(w, '[data-act="toggle-verify"]'), 'нет кнопки проверки для старой схемы');
  assert.ok(q1(w, '[data-d-score]'));
  assert.match(q1(w, '[data-d-score-value]').textContent, /92,7/);
});

// ===================== 3. Панель с объединённым отчётом (jsdom) =====================
test('r131: панель (jsdom) — group выводится в таблице (2 группы, 20+8 строк)', { skip: (!JSDOM || !fullText) && 'jsdom/файл не установлен' }, (t) => {
  const env = makeDocsEnv({ model: appModel() });
  t.after(() => { try { env.dom.window.close(); } catch (e) { } });
  openWithFull(env);
  const w = env.w;
  assert.strictEqual(qa(w, '[data-d-row]').length, 28, 'в таблице 28 строк');
  const heads = qa(w, '[data-d-group-row]');
  assert.deepStrictEqual(heads.map((h) => h.getAttribute('data-d-group-row')), ['docs-compare', 'документация ↔ облако/модель']);
  assert.match(heads[0].textContent, /docs-compare/);
  assert.match(heads[0].textContent, /20 строк/);
  assert.match(heads[1].textContent, /8 строк/);
  // у всех строк проставлена группа
  const g1 = qa(w, '[data-d-row][data-d-group="docs-compare"]').length;
  const g2 = qa(w, '[data-d-row][data-d-group="документация ↔ облако/модель"]').length;
  assert.strictEqual(g1, 20);
  assert.strictEqual(g2, 8);
  // заголовки групп идут в порядке отчёта
  const order = qa(w, '[data-d-group-row], [data-d-row]').map((n) => n.hasAttribute('data-d-group-row') ? 'H:' + n.getAttribute('data-d-group-row') : 'R:' + n.getAttribute('data-d-group'));
  assert.deepStrictEqual(order.slice(0, 2), ['H:docs-compare', 'R:docs-compare']);
  assert.ok(order.indexOf('H:документация ↔ облако/модель') > order.indexOf('R:docs-compare'), 'вторая группа после первой');
  assert.ok(order.indexOf('H:документация ↔ облако/модель') < order.indexOf('R:документация ↔ облако/модель'), 'заголовок перед своими строками');
});

test('r131: панель (jsdom) — score 80,8/A, под-скоры 91,7 и 70, заголовок отчёта', { skip: (!JSDOM || !fullText) && 'jsdom/файл не установлен' }, (t) => {
  const env = makeDocsEnv({ model: appModel() });
  t.after(() => { try { env.dom.window.close(); } catch (e) { } });
  openWithFull(env);
  const w = env.w;
  const score = q1(w, '[data-d-score]');
  assert.strictEqual(score.getAttribute('data-d-score'), '80.8');
  assert.strictEqual(score.getAttribute('data-d-grade'), 'A');
  assert.match(q1(w, '[data-d-score-value]').textContent, /80,8/);
  assert.match(q1(w, '[data-d-grade]').textContent, /· A/);
  assert.match(q1(w, '[data-d-count="pass"]').textContent, /PASS 16/);
  assert.match(q1(w, '[data-d-count="warn"]').textContent, /WARN 4/);
  assert.match(q1(w, '[data-d-count="fail"]').textContent, /FAIL 0/);
  assert.match(q1(w, '[data-d-count="na"]').textContent, /— 8/);
  // под-скоры объединённого отчёта видны сразу
  assert.strictEqual(q1(w, '[data-d-score-docs]').getAttribute('data-d-score-docs'), '91.7');
  assert.match(q1(w, '[data-d-score-docs]').textContent, /документация ↔ модель 91,7/);
  assert.strictEqual(q1(w, '[data-d-score-dims]').getAttribute('data-d-score-dims'), '70');
  assert.match(q1(w, '[data-d-score-dims]').textContent, /проверка по документации 70/);
  assert.match(q1(w, '[data-d-object]').textContent, /объединённый отчёт/i);
  assert.match(q1(w, '[data-d-file]').textContent, /compare-full-v5\.json/);
  assert.strictEqual(qa(w, '[data-d-rec]').length, 6, 'рекомендации');
  assert.strictEqual(qa(w, '[data-d-unv]').length, 8, 'непроверенные пункты');
});

test('r131: панель (jsdom) — «Проверка по документации»: 70,0, 8 строк verify, статусы, пояснения', { skip: (!JSDOM || !fullText) && 'jsdom/файл не установлен' }, (t) => {
  const env = makeDocsEnv({ model: appModel() });
  t.after(() => { try { env.dom.window.close(); } catch (e) { } });
  const res = openWithFull(env);
  const w = env.w;
  assert.strictEqual(res.report.scoreDocDimensions, 70);
  const block = q1(w, '[data-d-verify-block]');
  assert.ok(block, 'блок проверки по документации должен быть виден сразу после загрузки объединённого отчёта');
  const vscore = q1(w, '[data-d-verify-score]');
  assert.strictEqual(vscore.getAttribute('data-d-verify-score'), '70');
  assert.match(vscore.textContent, /70,0/, 'score_doc_dimensions показывается как 70,0');
  assert.match(block.textContent, /score_doc_dimensions/);
  // 8 строк verify (в таблице основного отчёта + в блоке проверки)
  assert.strictEqual(qa(w, '[data-d-verify-row]').length, 8);
  const statuses = qa(w, '[data-d-verify-row]').map((x) => x.getAttribute('data-d-row-status'));
  assert.deepStrictEqual(statuses, ['warn', 'pass', 'pass', 'na', 'pass', 'warn', 'pass', 'na']);
  assert.ok(statuses.includes('pass') && statuses.includes('warn') && statuses.includes('na'));
  // счётчики блока
  assert.match(q1(w, '[data-d-verify-count="pass"]').textContent, /PASS 4/);
  assert.match(q1(w, '[data-d-verify-count="warn"]').textContent, /WARN 2/);
  assert.match(q1(w, '[data-d-verify-count="na"]').textContent, /— 2/);
  // пояснение разницы «документация ↔ модель» и «документация ↔ облако»
  const dm = q1(w, '[data-d-explain="docs-model"]');
  const dc = q1(w, '[data-d-explain="docs-cloud"]');
  assert.ok(dm && dc, 'нужны оба пояснения');
  assert.match(dm.textContent, /Документация ↔ модель/);
  assert.match(dm.textContent, /score_docs 91,7/);
  assert.match(dc.textContent, /Документация ↔ облако/);
  assert.match(dc.textContent, /70,0/);
  assert.match(dc.textContent, /коридор, ячейки, высота, толщины, двери/i);
  // кнопка-переключатель: сворачивает и снова разворачивает блок
  const btn = q1(w, '[data-act="toggle-verify"]');
  assert.ok(btn, 'нет кнопки «Проверка по документации»');
  assert.match(btn.textContent, /Скрыть проверку по документации/);
  assert.strictEqual(btn.getAttribute('aria-pressed'), 'true');
  clickEl(w, btn);
  assert.ok(!q1(w, '[data-d-verify-block]'), 'блок должен свернуться');
  const btn2 = q1(w, '[data-act="toggle-verify"]');
  assert.match(btn2.textContent, /Проверка по документации 70|Проверка по документации · 70/);
  clickEl(w, btn2);
  assert.ok(q1(w, '[data-d-verify-block]'), 'блок должен развернуться снова');
  assert.strictEqual(qa(w, '[data-d-verify-row]').length, 8);
});

test('r131: getState — группы, под-скоры и проверка доступны другим модулям', { skip: (!JSDOM || !fullText) && 'jsdom/файл не установлен' }, (t) => {
  const env = makeDocsEnv({ model: appModel() });
  t.after(() => { try { env.dom.window.close(); } catch (e) { } });
  openWithFull(env);
  const s = env.D.getState();
  assert.strictEqual(s.score, 80.8);
  assert.strictEqual(s.scoreDocs, 91.7);
  assert.strictEqual(s.scoreDocDimensions, 70);
  assert.strictEqual(s.rows, 28);
  assert.deepStrictEqual(Array.from(s.groups), ['docs-compare', 'документация ↔ облако/модель']);
  assert.strictEqual(s.verifyRows, 8);
  assert.strictEqual(s.verifyOpen, true);
  assert.match(s.title, /объединённый отчёт/i);
});
