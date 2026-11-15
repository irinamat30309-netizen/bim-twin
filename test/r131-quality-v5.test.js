'use strict';
/*
 * r131 — панель «Качество модели» на реальной модели v5
 * (D:\BIM-TWIN-TEST\interior\py2-final-v5.json: 100 стен, из них 18 измеренных и
 * 82 дорисованных inference, 9 помещений, 122.9 м², 5 проёмов, 2 плиты, высота 3.278 м).
 *
 * Проверяем:
 *   • modelMetrics: стены 100 всего / 18 измеренных / 82 inferred; толщина считается по
 *     измеренным (медиана 0.12, мин 0.06, макс 0.536; 18 из 100), площадь помещений 122.9 м²,
 *     доля этажа ~100 %, проёмы/плиты/высота — без падения;
 *   • покрытие стен облаком: для модели с inference считается по измеренным стенам
 *     (measuredOnly, 18 из 100), на синтетическом облаке по измеренным стенам — ~100 %;
 *   • обратная совместимость: модель без inferred-флагов даёт thickness.scope='all'
 *     и measuredOnly=false (поведение r114 не меняется);
 *   • buildReport: метрики/scope в JSON-отчёте, строки walls/thickness/rooms/coverage
 *     с правильными значениями и пояснениями;
 *   • jsdom: панель открывается на модели v5, показывает 100/18, 0.12/0.06/0.54, 122.9 м²,
 *     строку покрытия (— без облака и PASS с облаком), не падает.
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
const Q = require(path.join(R, 'lixel-scan2bim-quality.js'));

const V5 = 'D:\\BIM-TWIN-TEST\\interior\\py2-final-v5.json';
const v5Text = fs.existsSync(V5) ? fs.readFileSync(V5, 'utf8') : null;
const v5 = v5Text ? JSON.parse(v5Text) : null;

// ---------- тестовые модели/облако ----------
function measuredWalls(model) {
  return (model.walls || []).filter((w) => !Q.isInferredWall(w));
}
function cloudForWalls(walls) {
  const pts = [];
  walls.forEach((w) => {
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (!(L > 0)) return;
    const ux = (w.b[0] - w.a[0]) / L, uz = (w.b[1] - w.a[1]) / L;
    const base = w.base || 0;
    for (let s = 0.05; s < L; s += 0.1) {
      for (const dy of [0.6, 1.5]) pts.push([w.a[0] + ux * s, base + dy, w.a[1] + uz * s]);
    }
  });
  return pts;
}
function typed(triples) {
  const a = new Float32Array(triples.length * 3);
  triples.forEach((p, i) => { a[i * 3] = p[0]; a[i * 3 + 1] = p[1]; a[i * 3 + 2] = p[2]; });
  return a;
}
function plainModel() {
  // модель без inference-флагов: 2 стены, 1 помещение, как в ранних версиях
  return {
    ok: true, units: 'm',
    storey: { floorY: 0, ceilY: 3, height: 3 },
    walls: [
      { a: [0, 0], b: [6, 0], thickness: 0.2, base: 0, height: 3, openings: [{ along: 1, width: 0.9, sill: 0, head: 2.1, kind: 'door' }] },
      { a: [6, 0], b: [6, 4], thickness: 0.2, base: 0, height: 3, openings: [] }
    ],
    rooms: [{ polygon: [[0, 0], [6, 0], [6, 4], [0, 4]], area: 20 }],
    slabs: [{ type: 'floor', level: 0, area: 24 }, { type: 'ceiling', level: 3, area: 24 }],
    stats: { wallCount: 2, openingCount: 1, roomCount: 1, roomsArea: 20, floorArea: 24 }
  };
}

// ---------- jsdom-окружение панели качества ----------
const q1 = (w, sel) => w.document.querySelector(sel);
const qa = (w, sel) => Array.from(w.document.querySelectorAll(sel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms || 0));

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
  if (opts.cloud) w.__viewer = { base: [{ points: true, pos: typed(opts.cloud) }], _setOverlay() {}, render() {} };
  w.eval(SRC);
  return { w, dom, log, state, Q: w.__lxS2BQuality };
}

// ===================== 1. Метрики модели v5 =====================
test('r131: modelMetrics v5 — 100 стен (18 измеренных, 82 inferred), 9 помещений, 122.9 м²', { skip: !v5 && 'нет модели py2-final-v5.json' }, () => {
  const m = Q.modelMetrics(v5);
  assert.ok(m, 'modelMetrics не должен падать на модели v5');
  assert.strictEqual(m.walls.count, 100, 'всего стен');
  assert.strictEqual(m.walls.measured, 18, 'измеренных стен');
  assert.strictEqual(m.walls.inferred, 82, 'дорисованных inference стен');
  assert.ok(Math.abs(m.walls.totalLength - 178.024) < 0.01, 'суммарная длина стен');
  assert.ok(Math.abs(m.walls.measuredLength - 97.141) < 0.01, 'длина измеренных стен');
  // толщина — только по измеренным стенам, иначе медиану задаёт толщина по умолчанию
  assert.strictEqual(m.thickness.scope, 'measured');
  assert.strictEqual(m.thickness.measured, 18);
  assert.strictEqual(m.thickness.total, 100);
  assert.strictEqual(m.thickness.inferred, 82);
  assert.strictEqual(m.thickness.count, 18);
  assert.strictEqual(m.thickness.median, 0.12);
  assert.strictEqual(m.thickness.min, 0.06);
  assert.strictEqual(m.thickness.max, 0.536);
  // помещения и доля этажа
  assert.strictEqual(m.rooms.count, 9);
  assert.strictEqual(m.rooms.area, 122.924);
  assert.strictEqual(m.rooms.floorArea, 122.9);
  assert.ok(m.rooms.share > 0.999 && m.rooms.share < 1.01, 'доля помещений от площади этажа ~100 %');
  // проёмы/плиты/высота
  assert.deepStrictEqual({ count: m.openings.count, doors: m.openings.doors, windows: m.openings.windows }, { count: 5, doors: 2, windows: 1 });
  assert.strictEqual(m.slabs.count, 2);
  assert.strictEqual(m.slabs.floorCount, 1);
  assert.strictEqual(m.slabs.ceilingCount, 1);
  assert.ok(Math.abs(m.storey.height - 3.278) < 1e-9);
});

test('r131: modelMetrics — модель без inference-флагов работает как раньше (scope=all)', () => {
  const m = Q.modelMetrics(plainModel());
  assert.strictEqual(m.thickness.scope, 'all');
  assert.strictEqual(m.thickness.count, 2);
  assert.strictEqual(m.thickness.median, 0.2);
  assert.strictEqual(m.walls.measured, 2);
  assert.strictEqual(m.walls.inferred, 0);
  const cov = Q.coverageStats(plainModel(), cloudForWalls(plainModel().walls));
  assert.strictEqual(cov.measuredOnly, false, 'без inference флагов покрытие по всем стенам');
  assert.strictEqual(cov.walls.length, 2);
});

// ===================== 2. Покрытие =====================
test('r131: coverageStats v5 — считается по 18 измеренным стенам, а не по 100', { skip: !v5 && 'нет модели py2-final-v5.json' }, () => {
  const cloud = cloudForWalls(measuredWalls(v5));
  const cov = Q.coverageStats(v5, cloud);
  assert.strictEqual(cov.available, true);
  assert.strictEqual(cov.measuredOnly, true, 'покрытие по измеренным стенам');
  assert.strictEqual(cov.wallsTotal, 100);
  assert.strictEqual(cov.wallsMeasured, 18);
  assert.strictEqual(cov.walls.length, 18, 'в покрытии только измеренные стены');
  assert.ok(cov.overall >= 0.99, 'синтетическое облако по измеренным стенам покрывает их: ' + cov.overall);
  assert.ok(cov.min >= 0.99, 'минимальное покрытие по стене: ' + cov.min);
  assert.ok(cov.steps > 0 && cov.points > 0);
  // без облака — честный прочерк, но с объёмом расчёта
  const none = Q.coverageStats(v5, null);
  assert.strictEqual(none.available, false);
  assert.strictEqual(none.wallsTotal, 100);
  assert.strictEqual(none.measuredOnly, true);
});

// ===================== 3. Строки и отчёт =====================
test('r131: buildRows/buildReport v5 — толщина/площадь/покрытие и метрики в отчёте', { skip: !v5 && 'нет модели py2-final-v5.json' }, () => {
  const cloud = cloudForWalls(measuredWalls(v5));
  const rep = Q.buildReport(v5, { cloud: cloud, generatedAt: '2026-11-15T00:00:00Z' });
  assert.strictEqual(rep.source, 'model+cloud');
  assert.strictEqual(rep.model.walls.count, 100);
  assert.strictEqual(rep.model.walls.measured, 18);
  assert.strictEqual(rep.model.walls.inferred, 82);
  assert.strictEqual(rep.model.thickness.scope, 'measured');
  // r131: явный объём расчёта в отчёте
  assert.deepStrictEqual(rep.scope, {
    wallsTotal: 100, wallsMeasured: 18, wallsInferred: 82, thicknessScope: 'measured',
    rooms: 9, roomsArea: 122.924, floorArea: 122.9, roomsShare: rep.model.rooms.share,
    coverageMeasuredOnly: true
  });
  const by = {};
  rep.rows.forEach((r) => { by[r.id] = r; });
  for (const id of ['height', 'walls', 'thickness', 'openings', 'rooms', 'slabs', 'coverage']) assert.ok(by[id], 'нет строки ' + id);
  // стены: 100 шт, но видно 18 измеренных
  assert.match(by.walls.value, /100 шт/);
  assert.match(by.walls.value, /измерено 18/);
  assert.match(by.walls.detail, /измерено 18 из 100/);
  assert.match(by.walls.detail, /\(inferred\) 82/);
  // толщина: медиана/мин/макс по измеренным и пояснение
  assert.match(by.thickness.value, /0\.12 \/ 0\.06 \/ 0\.54 м/);
  assert.match(by.thickness.detail, /измерено 18 из 100/);
  assert.match(by.thickness.detail, /дорисованные 82 не учитываются/);
  assert.strictEqual(by.thickness.status, Q.STATUS.PASS);
  // площадь помещений
  assert.match(by.rooms.value, /9 · 122\.9 м²/);
  assert.match(by.rooms.value, /100 % этажа/);
  assert.match(by.rooms.detail, /122\.9 м²/);
  assert.strictEqual(by.rooms.status, Q.STATUS.PASS);
  // покрытие по измеренным стенам
  assert.strictEqual(by.coverage.status, Q.STATUS.PASS);
  assert.match(by.coverage.detail, /измеренные из 100/);
  assert.match(by.coverage.value, /%/);
  // отчёт сериализуется и содержит метрики
  const json = JSON.parse(Q.reportJson(v5, { cloud: cloud }));
  assert.strictEqual(json.model.walls.measured, 18);
  assert.strictEqual(json.scope.thicknessScope, 'measured');
});

test('r131: buildReport v5 без облака — не падает, покрытие — прочерк, скор по модели', { skip: !v5 && 'нет модели py2-final-v5.json' }, () => {
  const rep = Q.buildReport(v5, { cloud: null, generatedAt: '2026-11-15T00:00:00Z' });
  assert.strictEqual(rep.source, 'model');
  assert.strictEqual(rep.coverage.available, false);
  assert.strictEqual(rep.coverage.measuredOnly, true);
  const cov = rep.rows.find((r) => r.id === 'coverage');
  assert.strictEqual(cov.status, Q.STATUS.NA);
  assert.strictEqual(cov.value, '—');
  assert.match(cov.detail, /облако точек не найдено/);
  assert.strictEqual(rep.score.fail, 0);
  assert.ok(rep.score.value >= 80, 'модель без облака не должна получать низкий скор: ' + rep.score.value);
});

// ===================== 4. Панель (jsdom) =====================
test('r131: панель (jsdom) — модель v5: 100/18 стен, 0.12/0.06/0.54, 122.9 м², не падает', { skip: (!JSDOM || !v5) && 'jsdom/модель не установлен' }, (t) => {
  const env = makeQualityEnv({ model: v5 });
  t.after(() => { try { env.dom.window.close(); } catch (e) { } });
  env.Q.open(v5);
  const w = env.w;
  assert.ok(q1(w, '[data-q-panel]'), 'панель не открылась');
  assert.ok(q1(w, '[data-q-score]'), 'нет блока скора');
  const walls = q1(w, '[data-q-row="walls"]');
  const thickness = q1(w, '[data-q-row="thickness"]');
  const rooms = q1(w, '[data-q-row="rooms"]');
  assert.ok(walls && thickness && rooms);
  assert.match(walls.querySelector('[data-q-value]').textContent, /100 шт/);
  assert.match(walls.querySelector('[data-q-value]').textContent, /измерено 18/);
  assert.match(walls.querySelector('[data-q-detail]').textContent, /измерено 18 из 100/);
  assert.match(thickness.querySelector('[data-q-value]').textContent, /0\.12 \/ 0\.06 \/ 0\.54 м/);
  assert.match(thickness.querySelector('[data-q-detail]').textContent, /дорисованные 82 не учитываются/);
  assert.match(rooms.querySelector('[data-q-value]').textContent, /9 · 122\.9 м²/);
  // строка покрытия без облака — прочерк, панель не падает
  const coverage = q1(w, '[data-q-row="coverage"]');
  assert.ok(coverage);
  assert.strictEqual(coverage.getAttribute('data-q-status'), Q.STATUS.NA);
  assert.strictEqual(coverage.querySelector('[data-q-value]').textContent, '—');
  // в источнике панели видно объём: «стены: измерено 18 из 100»
  assert.match(q1(w, '[data-q-source-line]').textContent, /стены: измерено 18 из 100/);
  assert.ok(qa(w, '[data-q-row]').length >= 7, 'все строки метрик на месте');
});

test('r131: панель (jsdom) — модель v5 + облако: покрытие PASS по 18 измеренным стенам', { skip: (!JSDOM || !v5) && 'jsdom/модель не установлен' }, (t) => {
  const cloud = cloudForWalls(measuredWalls(v5));
  const env = makeQualityEnv({ model: v5, cloud: cloud });
  t.after(() => { try { env.dom.window.close(); } catch (e) { } });
  env.Q.open(v5);
  const w = env.w;
  const coverage = q1(w, '[data-q-row="coverage"]');
  assert.strictEqual(coverage.getAttribute('data-q-source'), 'cloud');
  assert.strictEqual(coverage.getAttribute('data-q-status'), Q.STATUS.PASS, 'покрытие должно быть PASS');
  assert.match(coverage.querySelector('[data-q-value]').textContent, /%/);
  assert.match(coverage.querySelector('[data-q-detail]').textContent, /измеренные из 100/);
  // отчёт после refresh содержит model+cloud и измеренные метрики
  const rep = env.Q.getReport();
  assert.strictEqual(rep.source, 'model+cloud');
  assert.strictEqual(rep.model.walls.measured, 18);
  assert.strictEqual(rep.scope.coverageMeasuredOnly, true);
});
