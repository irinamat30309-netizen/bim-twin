'use strict';
/*
 * r114 — Фаза 5 ROADMAP-IDEAL (D2): панель качества BIM-модели в приложении.
 * Проверяем:
 *   • кнопка «Качество модели» рядом с «Построить BIM»/«Редактор модели» и динамическая
 *     загрузка renderer/lixel-scan2bim-quality.js (index.html не правим);
 *   • панель #lxS2BQualityPanel в стиле lx-*, палитра на токенах tokens.css
 *     (violet #a78bfa/#6a52cb, graphite #1c1b1a/#232221), без синего/белого/градиентов;
 *   • метрики из модели: высота этажа; стены N/длина; толщина медиана/мин/макс;
 *     проёмы N (двери/окна); помещения N/площадь/доля от этажа; плиты N;
 *   • покрытие стен облаком: доля шагов 0.5 м, где в полосе ±(t/2+0.1) и по высоте
 *     ≥2 точки; без облака — прочерк;
 *   • строки-метрики с источником «из модели» / «нужен обмер облаком» и PASS/FAIL/—;
 *   • автоматический пересчёт после правок модели (опрос сигнатуры), ручной refresh;
 *   • экспорт отчёта JSON.
 * Часть проверок — source-level, часть — исполнение чистых функций в Node, часть — jsdom
 * (настоящий модуль панели + настоящий renderer/lixel-scan2bim-ui.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }

const ROOT = path.join(__dirname, '..');
const R = path.join(ROOT, 'renderer');
const SRC = fs.readFileSync(path.join(R, 'lixel-scan2bim-quality.js'), 'utf8');
const UI = fs.readFileSync(path.join(R, 'lixel-scan2bim-ui.js'), 'utf8');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const Q = require(path.join(R, 'lixel-scan2bim-quality.js'));

// ---------- тестовые модели ----------
// Комната 6×4 м, 4 стены (20 м), дверь + окно, помещение 20 м² из 24 м² этажа, пол+потолок.
function roomModel() {
  return {
    ok: true, units: 'm',
    storey: { floorY: 0, ceilY: 3, height: 3 },
    footprint: [[0, 0], [6, 0], [6, 4], [0, 4]],
    walls: [
      { a: [0, 0], b: [6, 0], thickness: 0.2, base: 0, height: 3, openings: [{ along: 1, width: 0.9, sill: 0, head: 2.1, kind: 'door' }] },
      { a: [6, 0], b: [6, 4], thickness: 0.2, base: 0, height: 3, openings: [{ along: 1, width: 1.2, sill: 0.9, head: 2.2, kind: 'window' }] },
      { a: [6, 4], b: [0, 4], thickness: 0.2, base: 0, height: 3, openings: [] },
      { a: [0, 4], b: [0, 0], thickness: 0.2, base: 0, height: 3, openings: [] }
    ],
    rooms: [{ polygon: [[0.1, 0.1], [5.9, 0.1], [5.9, 3.9], [0.1, 3.9]], area: 20 }],
    slabs: [{ type: 'floor', level: 0, area: 24 }, { type: 'ceiling', level: 3, area: 24 }],
    stats: { wallCount: 4, openingCount: 2, roomCount: 1, roomsArea: 20, totalWallLength: 20, floorArea: 24 }
  };
}
// Плохая модель: высота вне диапазона, 2 короткие стены, толщина 0.9, нет проёмов/помещений/плит.
function badModel() {
  return {
    ok: true, units: 'm',
    storey: { floorY: 0, ceilY: 6.5, height: 6.5 },
    walls: [
      { a: [0, 0], b: [1, 0], thickness: 0.9, base: 0, height: 3, openings: [] },
      { a: [1, 0], b: [1, 1], thickness: 0.9, base: 0, height: 3, openings: [] }
    ],
    rooms: [], slabs: [], stats: { floorArea: 10 }
  };
}
// Облако ровно по осям стен: шаг 0.1 м, по 2 точки на высоте — каждый шаг 0.5 м покрыт.
function roomCloud(model) {
  const pts = [];
  model.walls.forEach((w) => {
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const ux = (w.b[0] - w.a[0]) / L, uz = (w.b[1] - w.a[1]) / L;
    for (let s = 0.1; s < L; s += 0.1) {
      for (const y of [1.0, 2.0]) pts.push([w.a[0] + ux * s, y, w.a[1] + uz * s]);
    }
  });
  return pts;
}
const f32 = (triples) => new Float32Array(triples.flat());
const q1 = (w, sel) => w.document.querySelector(sel);
const qa = (w, sel) => Array.from(w.document.querySelectorAll(sel));
const clickEl = (w, node) => node.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

// jsdom-окружение панели качества: настоящий модуль в window, вьюер — заглушка.
function makeQualityEnv(opts) {
  opts = opts || {};
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div id="lxLegacy"></div>' +
    '<div id="stageSideL"></div><div id="stageSideR"></div></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const log = { toasts: [], openedBuild: 0 };
  w.__toast = (m) => log.toasts.push(String(m));
  const state = { model: opts.model || null };
  w.__lxScan2BIM = { state: state, open() { log.openedBuild++; }, refreshPreview() {} };
  if (opts.cloud) w.__viewer = { base: [{ points: true, pos: f32(opts.cloud) }], _setOverlay() {}, render() {} };
  w.eval(SRC);
  return { w, log, state, Q: w.__lxS2BQuality };
}

// ===================== source-level =====================
test('r114: кнопка «Качество модели» рядом с «Построить BIM» и «Редактор модели»', () => {
  assert.match(UI, /bQuality\.id = 'lxScan2BimQualityBtn'/);
  assert.ok(UI.includes('Качество модели'), 'нет подписи кнопки');
  const iBuild = UI.indexOf('lxScan2BimBuildBtn'), iEdit = UI.indexOf('lxScan2BimEditorBtn'), iQuality = UI.indexOf('lxScan2BimQualityBtn');
  assert.ok(iBuild > 0 && iEdit > iBuild && iQuality > iEdit, 'порядок кнопок: построить → редактор → качество');
  assert.ok(UI.includes("s.src = 'lixel-scan2bim-quality.js?v=114'"), 'нет динамической загрузки панели качества');
  assert.ok(UI.includes('Q.open(state.model)'), 'модель не передаётся в панель качества');
  assert.ok(UI.includes('syncQualityModel'), 'модель не синхронизируется после построения');
  assert.ok(!HTML.includes('lixel-scan2bim-quality.js'), 'index.html не должен требовать правок (чужая зона)');
});

test('r114: модуль — панель, data-атрибуты, API', () => {
  assert.ok(SRC.includes("p.id = 'lxS2BQualityPanel'") && SRC.includes("getElementById('lxS2BQualityPanel')"), 'нет панели #lxS2BQualityPanel');
  assert.ok(SRC.includes('window.__lxS2BQuality'), 'нет публичного API в окне');
  assert.ok(SRC.includes('module.exports'), 'нет module.exports для node --test');
  for (const attr of ['data-q-panel', 'data-q-body', 'data-q-row=', 'data-q-metric=', 'data-q-status=', 'data-q-source=', 'data-q-score', 'data-q-value', 'data-q-badge']) {
    assert.ok(SRC.includes(attr), 'нет атрибута ' + attr);
  }
  for (const act of ['refresh', 'export-report', 'open-build']) {
    assert.ok(SRC.includes('data-act="' + act + '"'), 'нет кнопки data-act=' + act);
  }
  assert.ok(SRC.includes('__lxS2BQuality'), 'нет API');
  for (const fn of ['modelMetrics', 'thicknessStats', 'openingsStats', 'roomsStats', 'coverageStats', 'buildRows', 'scoreOf', 'signatureOf', 'buildReport', 'reportJson', 'exportReport', 'checkForChanges']) {
    assert.strictEqual(typeof Q[fn], 'function', 'нет функции ' + fn);
  }
  // Правки — только чтение модели, без Python/процессов/сети.
  assert.ok(!/require\(\s*['"]child_process['"]\s*\)/.test(SRC), 'не должно быть child_process');
  assert.ok(!/\bspawn\s*\(/.test(SRC), 'не должно быть spawn(');
  assert.ok(!/\bfetch\s*\(/.test(SRC), 'не должно быть fetch(');
});

test('r114: оформление — палитра токенов, без синего/белого/градиентов', () => {
  assert.ok(SRC.includes('var(--accent)') && SRC.includes('var(--bg-2)') && SRC.includes('var(--txt-3)'), 'нет токенов палитры');
  assert.ok(SRC.includes('#a78bfa') && SRC.includes('#6a52cb') && SRC.includes('#1c1b1a') && SRC.includes('#232221'), 'в исходнике должна быть зафиксирована палитра задания');
  assert.ok(!/linear-gradient|radial-gradient/.test(SRC), 'градиенты запрещены дизайн-системой');
  assert.ok(!/#fff(?:fff)?\b/i.test(SRC), 'чистый белый запрещён дизайн-системой');
});

test('r114: авто-пересчёт после правок — опрос сигнатуры модели', () => {
  assert.ok(SRC.includes('setInterval') && SRC.includes('checkForChanges') && SRC.includes('signatureOf'), 'нет опроса изменения модели');
  assert.ok(SRC.includes('WATCH_MS'), 'нет периода опроса');
});

// ===================== чистые функции =====================
test('r114: толщина — медиана/мин/макс', () => {
  const odd = Q.thicknessStats([{ thickness: 0.1 }, { thickness: 0.2 }, { thickness: 0.3 }]);
  assert.deepStrictEqual([odd.count, odd.median, odd.min, odd.max], [3, 0.2, 0.1, 0.3]);
  const even = Q.thicknessStats([{ thickness: 0.1 }, { thickness: 0.3 }]);
  assert.strictEqual(even.median, 0.2, 'медиана чётного набора — среднее двух центральных');
  assert.deepStrictEqual(Q.thicknessStats([]), { count: 0, median: NaN, min: NaN, max: NaN });
});

test('r114: проёмы — двери/окна/прочие', () => {
  const m = roomModel();
  const op = Q.openingsStats(m.walls);
  assert.deepStrictEqual(op, { count: 2, doors: 1, windows: 1, other: 0 });
  m.walls[2].openings = [{ kind: 'opening' }];
  assert.strictEqual(Q.openingsStats(m.walls).other, 1);
});

test('r114: помещения — площадь и доля от этажа (fallback на контур)', () => {
  const m = roomModel();
  const rm = Q.roomsStats(m);
  assert.ok(Math.abs(rm.area - 20) < 1e-9 && Math.abs(rm.floorArea - 24) < 1e-9);
  assert.ok(Math.abs(rm.share - 20 / 24) < 1e-9, 'доля помещений неверна: ' + rm.share);
  const noStats = roomModel();
  noStats.stats = {};
  noStats.rooms[0].polygon = [[0, 0], [5, 0], [5, 4], [0, 4]]; // 20 м² по контуру
  const rm2 = Q.roomsStats(noStats);
  assert.ok(Math.abs(rm2.floorArea - 24) < 1e-6, 'площадь этажа должна браться из footprint: ' + rm2.floorArea);
});

test('r114: метрики модели — высота, стены, проёмы, помещения, плиты', () => {
  const m = Q.modelMetrics(roomModel());
  assert.strictEqual(m.storey.height, 3);
  assert.strictEqual(m.walls.count, 4);
  assert.ok(Math.abs(m.walls.totalLength - 20) < 1e-9);
  assert.strictEqual(m.thickness.median, 0.2);
  assert.deepStrictEqual([m.openings.count, m.openings.doors, m.openings.windows], [2, 1, 1]);
  assert.strictEqual(m.rooms.count, 1);
  assert.deepStrictEqual([m.slabs.count, m.slabs.floorCount, m.slabs.ceilingCount], [2, 1, 1]);
  assert.strictEqual(Q.modelMetrics(null), null);
  // метрики не мутируют модель
  const mm = roomModel(), before = JSON.stringify(mm);
  Q.buildReport(mm, { cloud: roomCloud(mm) });
  assert.strictEqual(JSON.stringify(mm), before, 'buildReport не должен менять модель');
});

test('r114: покрытие стен — нет облака → прочерк', () => {
  const cov = Q.coverageStats(roomModel(), null);
  assert.strictEqual(cov.available, false);
  assert.ok(cov.reason, 'нет причины прочерка');
});

test('r114: покрытие стен — шаги 0.5 м, полоса ±(t/2+0.1), ≥2 точки по высоте', () => {
  const model = roomModel();
  const cov = Q.coverageStats(model, roomCloud(model));
  assert.strictEqual(cov.available, true, 'покрытие должно считаться');
  assert.strictEqual(cov.walls.length, 4);
  assert.strictEqual(cov.steps, 40, 'шагов 0.5 м по 4 стенам: 12+8+12+8');
  assert.strictEqual(cov.overall, 1, 'облако по осям стен должно давать 100 %');
  assert.strictEqual(cov.median, 1);
  assert.strictEqual(cov.min, 1);
  assert.ok(cov.points > 0, 'нет счётчика точек');

  // одна стена 4 м = 8 шагов; точки только в первых 4 шагах → 50 %
  const m = { ok: true, storey: { floorY: 0, ceilY: 3, height: 3 }, walls: [{ a: [0, 0], b: [4, 0], thickness: 0.2, base: 0, height: 3, openings: [] }], rooms: [], slabs: [] };
  const half = [];
  for (let s = 0.25; s < 2; s += 0.5) { half.push([s, 1, 0]); half.push([s, 2, 0]); } // по 2 точки в шагах 0..3
  const cov2 = Q.coverageStats(m, half);
  assert.strictEqual(cov2.steps, 8);
  assert.strictEqual(cov2.covered, 4);
  assert.strictEqual(cov2.overall, 0.5, 'ожидалось 50 %: ' + cov2.overall);

  // полоса: t=0.2 → ±0.2; точка на 0.19 учитывается, на 0.21 — уже нет
  const inBand = [], outBand = [];
  for (let s = 0.1; s < 4; s += 0.1) { inBand.push([s, 1, 0.19], [s, 2, -0.19]); outBand.push([s, 1, 0.21], [s, 2, -0.21]); }
  assert.strictEqual(Q.coverageStats(m, inBand).overall, 1, 'точки в полосе ±(t/2+0.1) не учтены');
  assert.strictEqual(Q.coverageStats(m, outBand).overall, 0, 'точки вне полосы учтены');

  // высота: точки вне отметок стены не считаются
  const outY = [];
  for (let s = 0.1; s < 4; s += 0.1) outY.push([s, -1, 0], [s, 4.5, 0]);
  assert.strictEqual(Q.coverageStats(m, outY).overall, 0, 'точки вне высоты стены учтены');

  // ≥2 точки на шаг: по одной точке — шаг не покрыт
  const one = [];
  for (let s = 0.25; s < 4; s += 0.5) one.push([s, 1, 0]);
  assert.strictEqual(Q.coverageStats(m, one).overall, 0, 'шаг с 1 точкой не должен считаться покрытым');
});

test('r114: покрытие стен — принимает Float32Array и тройки', () => {
  const m = roomModel();
  const triples = roomCloud(m);
  const a = Q.coverageStats(m, triples);
  const b = Q.coverageStats(m, f32(triples));
  assert.strictEqual(a.overall, b.overall, 'Float32Array и массив троек дают разное покрытие');
  assert.strictEqual(Math.round(b.overall * 1000) / 1000, 1);
});

test('r114: строки-метрики — PASS/FAIL/прочерк и источники', () => {
  const m = roomModel();
  const good = Q.buildRows(Q.modelMetrics(m), Q.coverageStats(m, roomCloud(m)));
  assert.strictEqual(good.length, 7, 'ожидались 7 строк-метрик');
  const byId = {};
  good.forEach((r) => { byId[r.id] = r; });
  for (const id of ['height', 'walls', 'thickness', 'openings', 'rooms', 'slabs', 'coverage']) assert.ok(byId[id], 'нет строки ' + id);
  for (const r of good) assert.strictEqual(r.status, Q.STATUS.PASS, 'хорошая модель: ' + r.id + ' должна быть PASS');
  assert.strictEqual(byId.height.source, 'model');
  assert.strictEqual(byId.height.sourceLabel, 'из модели');
  assert.strictEqual(byId.coverage.source, 'cloud');
  assert.strictEqual(byId.coverage.sourceLabel, 'обмер облаком');
  assert.match(byId.thickness.value, /0\.20 \/ 0\.20 \/ 0\.20 м/);
  assert.match(byId.openings.value, /двери 1/);
  assert.match(byId.rooms.value, /м² · 83 % этажа/);

  const noCloud = Q.buildRows(Q.modelMetrics(m), Q.coverageStats(m, null));
  const covRow = noCloud.filter((r) => r.id === 'coverage')[0];
  assert.strictEqual(covRow.status, Q.STATUS.NA, 'без облака покрытие — прочерк');
  assert.strictEqual(covRow.value, '—');
  assert.strictEqual(covRow.sourceLabel, 'нужен обмер облаком');

  const bad = Q.buildRows(Q.modelMetrics(badModel()), Q.coverageStats(badModel(), null));
  const badById = {};
  bad.forEach((r) => { badById[r.id] = r; });
  assert.strictEqual(badById.height.status, Q.STATUS.FAIL, 'высота 6.5 м должна быть FAIL');
  assert.strictEqual(badById.walls.status, Q.STATUS.FAIL);
  assert.strictEqual(badById.thickness.status, Q.STATUS.FAIL);
  assert.strictEqual(badById.openings.status, Q.STATUS.FAIL);
  assert.strictEqual(badById.rooms.status, Q.STATUS.FAIL);
  assert.strictEqual(badById.slabs.status, Q.STATUS.FAIL);
  assert.strictEqual(badById.coverage.status, Q.STATUS.NA);
});

test('r114: скор — взвешенный PASS, прочерки не штрафуются', () => {
  const m = roomModel();
  const rows = Q.buildRows(Q.modelMetrics(m), Q.coverageStats(m, roomCloud(m)));
  const good = Q.scoreOf(rows);
  assert.strictEqual(good.value, 100);
  assert.deepStrictEqual([good.pass, good.fail, good.na], [7, 0, 0]);
  const rowsNoCloud = Q.buildRows(Q.modelMetrics(m), Q.coverageStats(m, null));
  const sc = Q.scoreOf(rowsNoCloud);
  assert.strictEqual(sc.value, 100, 'прочерк не должен занижать скор');
  assert.strictEqual(sc.na, 1);
  const bad = Q.scoreOf(Q.buildRows(Q.modelMetrics(badModel()), Q.coverageStats(badModel(), null)));
  assert.strictEqual(bad.value, 0);
  assert.deepStrictEqual([bad.pass, bad.fail, bad.na], [0, 6, 1]);
});

test('r114: сигнатура модели ловит правки редактора', () => {
  const m = roomModel();
  const s0 = Q.signatureOf(m);
  m.walls[0].thickness = 0.3;
  const s1 = Q.signatureOf(m);
  assert.notStrictEqual(s1, s0, 'толщина не попала в сигнатуру');
  m.storey.height = 3.2;
  assert.notStrictEqual(Q.signatureOf(m), s1, 'высота не попала в сигнатуру');
  m.walls[1].openings.push({ kind: 'door', along: 2, width: 0.9, sill: 0, head: 2.1 });
  assert.notStrictEqual(Q.signatureOf(m), Q.signatureOf(roomModel()), 'проёмы не попали в сигнатуру');
  assert.strictEqual(Q.signatureOf(null), 'none');
});

test('r114: отчёт JSON — поля и пороги', () => {
  const m = roomModel();
  const rep = Q.buildReport(m, { cloud: roomCloud(m), generatedAt: '2026-11-15T12:00:00.000Z' });
  assert.strictEqual(rep.tool, 'lixel-scan2bim-quality');
  assert.strictEqual(rep.version, '114');
  assert.strictEqual(rep.created_at, '2026-11-15T12:00:00.000Z');
  assert.strictEqual(rep.source, 'model+cloud');
  assert.strictEqual(rep.model.walls.count, 4);
  assert.strictEqual(rep.coverage.available, true);
  assert.strictEqual(rep.rows.length, 7);
  assert.strictEqual(rep.score.value, 100);
  assert.ok(rep.thresholds.A1 && rep.thresholds.A2 && rep.thresholds.A3 && rep.thresholds.A5, 'нет порогов A1/A2/A3/A5');
  const json = Q.reportJson(m, { cloud: roomCloud(m) });
  const parsed = JSON.parse(json);
  assert.strictEqual(parsed.score.value, 100, 'JSON-отчёт не парсится/не содержит скор');
  const noCloud = Q.buildReport(m, { cloud: null });
  assert.strictEqual(noCloud.source, 'model');
  assert.strictEqual(noCloud.coverage.available, false);
});

// ===================== jsdom: реальная панель =====================
test('r114: панель (jsdom) — открывается на модели с облаком, все метрики PASS', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const model = roomModel();
  const { w, Q: q, log } = makeQualityEnv({ model: model, cloud: roomCloud(model) });
  t.after(() => { try { q.close(); } catch (e) { } });
  assert.ok(q && typeof q.open === 'function', 'модуль не установил window.__lxS2BQuality');
  q.open(model);
  const panel = q1(w, '#lxS2BQualityPanel');
  assert.ok(panel, 'панель не создана');
  assert.strictEqual(panel.style.display, 'block');
  assert.strictEqual(panel.getAttribute('aria-label'), 'Качество модели');
  assert.ok(q1(w, '[data-q-panel]') === panel, 'нет data-q-panel');

  const rows = qa(w, '[data-q-metric]');
  assert.strictEqual(rows.length, 7, 'ожидались 7 строк-метрик, а не ' + rows.length);
  assert.strictEqual(qa(w, '[data-q-status="pass"]').length, 7, 'на хорошей модели все строки PASS');
  assert.strictEqual(qa(w, '[data-q-source="model"]').length, 6);
  assert.strictEqual(qa(w, '[data-q-source="cloud"]').length, 1);
  assert.strictEqual(q1(w, '[data-q-row="coverage"]').getAttribute('data-q-source'), 'cloud');

  assert.match(q1(w, '[data-q-row="height"] [data-q-value]').textContent, /3\.00 м/);
  assert.match(q1(w, '[data-q-row="walls"] [data-q-value]').textContent, /4 шт · 20\.0 м/);
  assert.match(q1(w, '[data-q-row="thickness"] [data-q-value]').textContent, /0\.20 \/ 0\.20 \/ 0\.20 м/);
  assert.match(q1(w, '[data-q-row="openings"] [data-q-value]').textContent, /двери 1 · окна 1/);
  assert.match(q1(w, '[data-q-row="rooms"] [data-q-value]').textContent, /20\.0 м²/);
  assert.match(q1(w, '[data-q-row="slabs"] [data-q-value]').textContent, /пол 1 · потолок 1/);
  assert.match(q1(w, '[data-q-row="coverage"] [data-q-value]').textContent, /100 %/);

  assert.strictEqual(q1(w, '[data-q-score-value]').textContent, '100');
  assert.strictEqual(q1(w, '[data-q-score]').getAttribute('data-q-score'), '100');
  assert.match(q1(w, '[data-q-count="pass"]').textContent, /PASS 7/);
  assert.match(q1(w, '[data-q-count="fail"]').textContent, /FAIL 0/);
  assert.strictEqual(q1(w, '[data-q-count="na"]').textContent.trim(), '— 0');
  // подписи источника
  assert.match(q1(w, '[data-q-row="height"] [data-q-source-label]').textContent, /из модели/);
  assert.match(q1(w, '[data-q-row="coverage"] [data-q-source-label]').textContent, /обмер облаком/);
  assert.ok(q1(w, '[data-act="refresh"]') && q1(w, '[data-act="export-report"]'), 'нет кнопок обновления/экспорта');
  assert.strictEqual(log.toasts.filter((t) => /Ошибка/.test(t)).length, 0);
});

test('r114: панель (jsdom) — FAIL и прочерк на плохой модели/без облака', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const { w, Q: q } = makeQualityEnv({ model: badModel() });
  t.after(() => { try { q.close(); } catch (e) { } });
  q.open(badModel());
  assert.strictEqual(qa(w, '[data-q-status="fail"]').length, 6, 'ожидались 6 FAIL');
  const cov = q1(w, '[data-q-row="coverage"]');
  assert.strictEqual(cov.getAttribute('data-q-status'), 'na', 'без облака покрытие — прочерк');
  assert.strictEqual(q1(w, '[data-q-row="coverage"] [data-q-value]').textContent, '—');
  assert.strictEqual(q1(w, '[data-q-row="coverage"] [data-q-badge]').textContent, '—');
  assert.match(q1(w, '[data-q-row="coverage"] [data-q-source-label]').textContent, /нужен обмер облаком/);
  assert.strictEqual(q1(w, '[data-q-score-value]').textContent, '0');
  // у плохой модели нет помещений/проёмов — соответствующие строки FAIL, а не PASS
  assert.strictEqual(q1(w, '[data-q-row="rooms"]').getAttribute('data-q-status'), 'fail');
  assert.strictEqual(q1(w, '[data-q-row="openings"]').getAttribute('data-q-status'), 'fail');
  // модель совсем без стен: толщина/проёмы — прочерки
  const empty = { ok: true, storey: { floorY: 0, ceilY: 3, height: 3 }, walls: [], rooms: [], slabs: [], stats: {} };
  q.setModel(empty);
  assert.strictEqual(q1(w, '[data-q-row="thickness"]').getAttribute('data-q-status'), 'na');
  assert.strictEqual(q1(w, '[data-q-row="thickness"] [data-q-value]').textContent, '—');
  assert.strictEqual(q1(w, '[data-q-row="openings"]').getAttribute('data-q-status'), 'na');
});

test('r114: панель (jsdom) — автоматический пересчёт после правки модели', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const model = roomModel();
  const { w, Q: q } = makeQualityEnv({ model: model, cloud: roomCloud(model) });
  t.after(() => { try { q.close(); } catch (e) { } });
  q.open(model);
  assert.strictEqual(q1(w, '[data-q-row="height"]').getAttribute('data-q-status'), 'pass');
  const before = q1(w, '[data-q-score-value]').textContent;
  // «правка редактора»: объект модели тот же, меняется геометрия → сигнатура другая
  model.storey.height = 6.5;
  model.storey.ceilY = 6.5;
  assert.strictEqual(q.checkForChanges(), true, 'изменение модели не замечено');
  assert.strictEqual(q1(w, '[data-q-row="height"]').getAttribute('data-q-status'), 'fail');
  assert.notStrictEqual(q1(w, '[data-q-score-value]').textContent, before);
  assert.strictEqual(q.checkForChanges(), false, 'без изменений пересчёт не нужен');
});

test('r114: панель (jsdom) — экспорт отчёта JSON', { skip: !JSDOM && 'jsdom не установлен' }, async (t) => {
  const model = roomModel();
  const { w, Q: q, log } = makeQualityEnv({ model: model, cloud: roomCloud(model) });
  t.after(() => { try { q.close(); } catch (e) { } });
  let captured = null;
  w.URL.createObjectURL = (blob) => { captured = blob; return 'blob:quality'; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () {};
  q.open(model);
  clickEl(w, q1(w, '[data-act="export-report"]'));
  assert.ok(captured, 'экспорт JSON не создал Blob');
  const text = await new Promise((resolve, reject) => {
    const fr = new w.FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = reject;
    fr.readAsText(captured);
  });
  const rep = JSON.parse(text);
  assert.strictEqual(rep.tool, 'lixel-scan2bim-quality');
  assert.strictEqual(rep.model.walls.count, 4, 'в отчёте нет метрик модели');
  assert.strictEqual(rep.rows.length, 7);
  assert.strictEqual(rep.score.value, 100);
  assert.strictEqual(rep.coverage.available, true);
  assert.ok(rep.thresholds.A2, 'в отчёте нет порогов');
  assert.ok(log.toasts.some((t) => /Отчёт качества сохранён/.test(t)), 'нет уведомления об экспорте');
  // JSON собирается и без DOM (API):
  const again = JSON.parse(q.reportJson(model, { cloud: roomCloud(model) }));
  assert.strictEqual(again.score.value, 100);
});

test('r114: панель (jsdom) — без модели показывает подсказку', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const { w, log, Q: q } = makeQualityEnv({ model: null });
  t.after(() => { try { q.close(); } catch (e) { } });
  q.open(null);
  assert.ok(q1(w, '#lxS2BQualityPanel'), 'панель не создана без модели');
  assert.ok(q1(w, '[data-q-hint="no-model"]'), 'нет подсказки «модель не построена»');
  assert.ok(q1(w, '[data-act="open-build"]'), 'нет кнопки перехода к построению');
  assert.strictEqual(qa(w, '[data-q-metric]').length, 0, 'без модели не должно быть метрик');
  clickEl(w, q1(w, '[data-act="open-build"]'));
  assert.strictEqual(log.openedBuild, 1, 'кнопка не открыла панель «Скан → BIM»');
});

test('r114: интеграция (jsdom) — кнопка «Качество модели» в панели «Скан → BIM»', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const model = roomModel();
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div id="lxLegacy"></div>' +
    '<div class="stage"><div id="stageSideL"></div><div id="stageSideR"></div></div></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  t.after(() => { try { if (w.__lxS2BQuality) w.__lxS2BQuality.close(); } catch (e) { } });
  const toasts = [];
  w.__toast = (m) => toasts.push(String(m));
  w.__viewer = { base: [{ points: true, pos: f32(roomCloud(model)) }], _setOverlay() {}, render() {} };
  w.eval(UI);                                  // настоящий renderer/lixel-scan2bim-ui.js
  const api = w.__lxScan2BIM;
  assert.ok(api && typeof api.quality === 'function', 'нет пункта открытия панели качества в API');
  api.open();
  const btn = w.document.getElementById('lxScan2BimQualityBtn');
  assert.ok(btn, 'нет кнопки «Качество модели» в панели «Скан → BIM»');
  assert.match(btn.textContent, /Качество модели/);

  api.state.model = model;                     // модель после «Построить BIM»
  clickEl(w, btn);                             // динамическая загрузка модуля
  const tag = w.document.querySelector('script[src*="lixel-scan2bim-quality.js"]');
  assert.ok(tag, 'динамический <script> панели качества не создан');
  w.eval(SRC);
  tag.onload();
  assert.ok(w.__lxS2BQuality, 'модуль качества не установлен в окне');
  const panel = w.document.getElementById('lxS2BQualityPanel');
  assert.ok(panel && panel.style.display === 'block', 'панель качества не открылась');
  assert.strictEqual(w.document.querySelectorAll('[data-q-metric]').length, 7, 'модель не попала в панель');
  assert.strictEqual(w.document.querySelector('[data-q-row="coverage"]').getAttribute('data-q-status'), 'pass');
  assert.strictEqual(w.__lxS2BQuality.isOpen(), true);
  // закрытие «Скан → BIM» не закрывает панель качества
  api.close();
  assert.strictEqual(w.__lxS2BQuality.isOpen(), true, 'панель качества закрылась вместе с «Скан → BIM»');
  assert.ok(toasts.every((t) => !/Не удалось загрузить панель качества/.test(t)), 'были ошибки загрузки: ' + toasts.join('; '));
});
