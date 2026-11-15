'use strict';
/*
 * r131 — e2e-проверка редактора модели v5 + IFC-импорта (в приложении).
 * Проверяем:
 *   • публичное API редактора: импорт JSON модели v5 (100 стен / 5 проёмов / 9 помещений),
 *     режим «3D-объём», сдвиг стены +0.05, undo, удаление проёма, экспорт IFC-строки и JSON;
 *   • jsdom: настоящий renderer/lixel-scan2bim-editor.js с моделью v5 — счётчики,
 *     правка стены кнопкой панели, undo, удаление проёма, IFC-строка с новыми координатами;
 *   • source-level: в UI есть «Загрузить JSON» / «Сохранить JSON» / «Экспорт IFC» /
 *     «3D-объём»; если в окружении есть настоящий D:\BIM-TWIN-TEST\interior\py2-final-v5.json —
 *     он тоже прогоняется через parseModelJson (иначе используется синтетическая модель
 *     той же формы со счётчиками 100/5/9/2).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }

const ROOT = path.join(__dirname, '..');
const R = path.join(ROOT, 'renderer');
const EDITOR_SRC = fs.readFileSync(path.join(R, 'lixel-scan2bim-editor.js'), 'utf8');
const UI = fs.readFileSync(path.join(R, 'lixel-scan2bim-ui.js'), 'utf8');
const EDITOR = require(path.join(R, 'lixel-scan2bim-editor.js'));
const S = require(path.join(R, 'scan2bim.js'));

const V5_PATH = 'D:/BIM-TWIN-TEST/interior/py2-final-v5.json';
const HAS_REAL_V5 = fs.existsSync(V5_PATH);
function v5Text() {
  if (HAS_REAL_V5) return fs.readFileSync(V5_PATH, 'utf8');
  return JSON.stringify(v5LikeModel());
}
// Синтетическая модель «формы v5»: те же счётчики 100 стен / 5 проёмов / 9 помещений / 2 плиты.
function v5LikeModel() {
  const walls = [];
  for (let i = 0; i < 100; i++) {
    const gx = (i % 10) * 2.2, gz = Math.floor(i / 10) * 2.2;
    const wall = { a: [gx, gz], b: [gx + 1.6, gz], thickness: 0.2, base: 0.182, height: 3.278, material: 'concrete', openings: [] };
    if (i < 5) wall.openings.push({ along: 0.2, width: 0.9, sill: 0, head: 2.1, kind: 'door' });
    walls.push(wall);
  }
  const rooms = [];
  for (let i = 0; i < 9; i++) {
    const x = (i % 3) * 3.3, z = Math.floor(i / 3) * 3.3;
    rooms.push({ polygon: [[x, z], [x + 2.8, z], [x + 2.8, z + 2.8], [x, z + 2.8]], area: 7.84 });
  }
  const poly = [[-2, -2], [26, -2], [26, 24], [-2, 24]];
  return {
    ok: true, units: 'm',
    storey: { floorY: 0.182, ceilY: 3.46, height: 3.278 },
    footprint: poly,
    walls, rooms,
    slabs: [
      { type: 'floor', level: 0.182, polygon: poly, thickness: 0.2, area: 588 },
      { type: 'ceiling', level: 3.46, polygon: poly, thickness: 0.2, area: 588 }
    ],
    stats: { wallCount: 100, openingCount: 5, roomCount: 9, roomsArea: 70.56, totalWallLength: 160, floorArea: 588 }
  };
}
function fnum(x) {
  if (!isFinite(x)) x = 0;
  let s = (Math.round(x * 1e6) / 1e6).toString();
  if (s.indexOf('.') < 0 && s.indexOf('e') < 0 && s.indexOf('E') < 0) s += '.';
  return s;
}
const q = (w, sel) => w.document.querySelector(sel);
const qa = (w, sel) => Array.from(w.document.querySelectorAll(sel));
const clickEl = (w, node) => node.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

// jsdom-окружение с настоящим редактором; вьюер — заглушка с перехватом оверлея.
function makeEditorEnv() {
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div id="lxLegacy"></div>' +
    '<div class="stage"><div id="stageSideL"></div><div id="stageSideR"></div></div></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  const log = { toasts: [], overlays: [] };
  w.__toast = (m) => log.toasts.push(String(m));
  const viewer = {
    base: [],
    _setOverlay(objs) { log.overlays.push(objs); },
    render() { },
    _supportsSolid: false
  };
  w.__pcTools = { viewer: () => viewer };
  w.__viewer = viewer;
  w.Scan2BIM = S;
  w.__lxScan2BIM = { state: { model: null }, open() { }, refreshPreview() { } };
  w.eval(EDITOR_SRC);
  const E = w.__lxS2BEditor;
  return { w, E, log, viewer };
}
function importV5(env) {
  const res = env.E.importJson(v5Text());
  assert.ok(res && res.ok, 'импорт v5 отклонён: ' + (res && res.reason));
  return res;
}

// ===================== source-level =====================
test('r131: редактор умеет JSON-импорт/экспорт и 3D-объём (source-level)', () => {
  for (const act of ['import-json', 'save-json', 'export-ifc', 'view-mode']) {
    assert.ok(EDITOR_SRC.includes('data-act="' + act + '"'), 'нет кнопки data-act=' + act);
  }
  assert.ok(EDITOR_SRC.includes('data-act="view-mode"') && EDITOR_SRC.includes('setViewMode'), 'нет переключателя режима просмотра');
  assert.ok(EDITOR_SRC.includes("'volume'") && /3D-объём/.test(EDITOR_SRC), 'нет режима «3D-объём»');
  assert.ok(EDITOR_SRC.includes('data-lx-edit="import-input"'), 'нет input для загрузки JSON');
  for (const fn of ['parseModelJson', 'importJson', 'exportEditedIfc', 'saveJson', 'modelJson', 'modelCounts', 'setViewMode', 'deleteOpening', 'undo']) {
    assert.strictEqual(typeof EDITOR[fn], 'function', 'нет API ' + fn);
  }
  assert.ok(UI.includes('lxScan2BimEditorBtn'), 'в приложении нет кнопки «Редактор модели»');
});

test('r131: parseModelJson принимает модель v5 (100/5/9)', () => {
  const res = EDITOR.parseModelJson(v5Text());
  assert.ok(res.ok, 'схема отклонила модель v5: ' + (res.reason || ''));
  const c = EDITOR.modelCounts(res.model);
  assert.deepStrictEqual({ walls: c.walls, openings: c.openings, rooms: c.rooms }, { walls: 100, openings: 5, rooms: 9 });
  assert.ok((res.model.slabs || []).length === 2, 'нет двух плит (пол/потолок)');
  assert.ok(Math.abs((res.model.storey && res.model.storey.height) - 3.278) < 1e-6, 'высота этажа не 3.278');
});

test('r131: битый JSON отклоняется, модель не меняется', () => {
  const m = EDITOR.parseModelJson(v5Text()).model;
  EDITOR.attach(m);
  const before = JSON.stringify(EDITOR.getModel().walls[0].a);
  const bad = EDITOR.importJson('{ "walls": [ { "a": "нет" } ] }');
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.reason, 'нет причины отказа');
  assert.strictEqual(JSON.stringify(EDITOR.getModel().walls[0].a), before, 'битый импорт изменил модель');
});

// ===================== jsdom: редактор с моделью v5 =====================
test('r131: jsdom — загрузка v5, счётчики 100 стен / 5 проёмов / 9 помещений', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const { w, E, log } = makeEditorEnv();
  t.after(() => { try { E.close && E.close(); } catch (e) { } });
  E.open(null);
  importV5({ E: E });
  const counts = E.getState().counts;
  assert.deepStrictEqual({ walls: counts.walls, openings: counts.openings, rooms: counts.rooms }, { walls: 100, openings: 5, rooms: 9 });
  const status = q(w, '[data-lx-edit="statusbar"]');
  assert.ok(status, 'нет строки статуса редактора');
  const txt = status.textContent.replace(/\s+/g, ' ');
  assert.match(txt, /Стены\s*100/);
  assert.match(txt, /Проёмы\s*5/);
  assert.match(txt, /Помещения\s*9/);
  assert.match(txt, /122\.9|122\.92/);
  assert.strictEqual(qa(w, '[data-lx-edit="walls"] [data-wall-index]').length, 100, 'в списке не 100 стен');
  assert.ok(log.toasts.some((m) => /JSON модели загружен/.test(m)), 'нет уведомления об импорте: ' + log.toasts.join('; '));
});

test('r131: jsdom — режим «3D-объём» строит оверлей', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const { w, E, log } = makeEditorEnv();
  t.after(() => { try { E.close && E.close(); } catch (e) { } });
  E.open(null); importV5({ E: E });
  clickEl(w, q(w, '[data-act="view-mode"][data-mode="volume"]'));
  const vs = E.getViewState();
  assert.strictEqual(vs.mode, 'volume');
  assert.ok(vs.segments > 0, '3D-объём не построил сегменты: ' + JSON.stringify(vs));
  assert.ok(vs.objects > 0, 'нет объектов оверлея');
  const last = log.overlays[log.overlays.length - 1] || [];
  assert.ok(last.length >= 2, 'оверлей пуст');
  assert.ok(last.every((o) => o && (o.line === true || o.gkind === 'wire')), 'оверлей не линии');
});

test('r131: jsdom — сдвиг стены +0.05, undo и удаление проёма (кнопки панели)', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const { w, E } = makeEditorEnv();
  t.after(() => { try { E.close && E.close(); } catch (e) { } });
  E.open(null); importV5({ E: E });

  const before = { a: E.getModel().walls[0].a.slice(), dir: E.getModel().walls[0].dir.slice() };
  clickEl(w, q(w, '[data-act="wall-move"][data-delta="0.05"]'));
  const wall = E.getModel().walls[0];
  const dx = wall.a[0] - before.a[0], dz = wall.a[1] - before.a[1];
  // нормаль n = (-dz, dx): сдвиг на +0.05 по нормали
  const normalShift = dx * (-before.dir[1]) + dz * before.dir[0];
  assert.ok(Math.abs(normalShift - 0.05) < 1e-6, 'сдвиг стены не 0.05 м: ' + normalShift);
  assert.strictEqual(E.getState().undo, 1, 'правка не попала в историю');

  clickEl(w, q(w, '[data-act="undo"]'));
  assert.ok(Math.abs(E.getModel().walls[0].a[0] - before.a[0]) < 1e-9 && Math.abs(E.getModel().walls[0].a[1] - before.a[1]) < 1e-9,
    'undo не вернул положение стены');
  assert.strictEqual(E.getState().redo, 1, 'undo не положил правку в redo');

  const openBefore = E.getState().counts.openings;
  const del = qa(w, '[data-lx-edit="openings"] [data-act="op-del"]')[0];
  assert.ok(del, 'нет кнопки удаления проёма в списке');
  clickEl(w, del);
  assert.strictEqual(E.getState().counts.openings, openBefore - 1, 'проём не удалён');
  assert.strictEqual(E.getModel().walls[0].openings.length, 0, 'у стены 1 остался проём');
});

test('r131: jsdom — экспорт IFC-строки содержит стену, проёмы и новые координаты', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const { w, E } = makeEditorEnv();
  t.after(() => { try { E.close && E.close(); } catch (e) { } });
  E.open(null); importV5({ E: E });
  const m = E.getModel();
  const wall = m.walls[0];
  const b0 = wall.a.slice(), dir = wall.dir.slice();
  const op = wall.openings[0];
  const L = Math.hypot(wall.b[0] - b0[0], wall.b[1] - b0[1]);
  const segLen = Math.min(op.along, L);
  const cOld = [b0[0] + dir[0] * segLen / 2, b0[1] + dir[1] * segLen / 2];
  const n = [-dir[1], dir[0]];
  const cNew = [cOld[0] + n[0] * 0.05, cOld[1] + n[1] * 0.05];
  const base = wall.base;

  const ifcBefore = S.toIFC(m, { name: 'v5-before.ifc' });
  const strOld = 'IFCCARTESIANPOINT((' + fnum(cOld[0]) + ',' + fnum(cOld[1]) + ',' + fnum(base) + '))';
  assert.ok(ifcBefore.includes(strOld), 'в исходном IFC нет старой оси стены: ' + strOld);
  assert.strictEqual((ifcBefore.match(/IFCWALLSTANDARDCASE/g) || []).length, 100, 'в IFC не 100 стен');
  assert.strictEqual((ifcBefore.match(/IFCOPENINGELEMENT/g) || []).length, 5, 'в IFC не 5 проёмов');

  clickEl(w, q(w, '[data-act="wall-move"][data-delta="0.05"]'));
  const ifcAfter = S.toIFC(E.getModel(), { name: 'v5-after.ifc' });
  const strNew = 'IFCCARTESIANPOINT((' + fnum(cNew[0]) + ',' + fnum(cNew[1]) + ',' + fnum(base) + '))';
  assert.ok(ifcAfter.includes(strNew), 'в IFC нет новых координат стены: ' + strNew);
  assert.ok(!ifcAfter.includes(strOld), 'в IFC остались старые координаты');
  assert.ok(ifcAfter.trim().endsWith('END-ISO-10303-21;'), 'IFC не завершён');
});

test('r131: jsdom — «Сохранить JSON» (modelJson) валиден после правок', { skip: !JSDOM && 'jsdom не установлен' }, (t) => {
  const { w, E } = makeEditorEnv();
  t.after(() => { try { E.close && E.close(); } catch (e) { } });
  E.open(null); importV5({ E: E });
  const del = qa(w, '[data-lx-edit="openings"] [data-act="op-del"]')[0];
  clickEl(w, del);
  const text = E.modelJson();
  assert.ok(text, 'modelJson вернул null');
  const parsed = JSON.parse(text);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.walls.length, 100);
  assert.strictEqual(parsed.rooms.length, 9);
  assert.strictEqual(parsed.slabs.length, 2);
  const openings = parsed.walls.reduce((s, x) => s + ((x.openings || []).length), 0);
  assert.strictEqual(openings, 4, 'в JSON не 4 проёма после удаления: ' + openings);
  assert.ok(parsed.storey && Math.abs(parsed.storey.height - 3.278) < 1e-6);
});

test('r131: настоящий py2-final-v5.json (если файл есть в окружении)', { skip: !HAS_REAL_V5 && 'нет D:/BIM-TWIN-TEST/interior/py2-final-v5.json' }, () => {
  const m = JSON.parse(fs.readFileSync(V5_PATH, 'utf8'));
  assert.strictEqual(m.ok, true);
  assert.strictEqual(m.walls.length, 100);
  assert.strictEqual(m.walls.reduce((s, w) => s + (w.openings || []).length, 0), 5);
  assert.strictEqual(m.rooms.length, 9);
  assert.strictEqual(m.slabs.length, 2);
  assert.strictEqual(m.stats.wallCount, 100);
  assert.strictEqual(m.stats.openingCount, 5);
  assert.strictEqual(m.stats.roomCount, 9);
  const res = EDITOR.parseModelJson(JSON.stringify(m));
  assert.ok(res.ok, 'редактор отклонил реальный v5: ' + res.reason);
  assert.strictEqual(EDITOR.modelCounts(res.model).openings, 5);
});
