'use strict';
/*
 * r110 — Фаза 4 ROADMAP-IDEAL (D3): ручной редактор BIM-модели в приложении.
 * Проверяем:
 *   • модуль renderer/lixel-scan2bim-editor.js существует и экспортирует API
 *     (editMoveWall, editThickness, editWallEnd, editOpeningMove, deleteOpening, addDoor,
 *      snapWall, undo, redo, exportEditedIfc);
 *   • панель редактора создаёт элементы с data-атрибутами (data-lx-edit, data-act,
 *     data-wall-index, data-opening-index);
 *   • кнопка «Редактор модели» рядом с «Построить BIM», редактор грузится по требованию,
 *     модель передаётся в window.Scan2BIM.toIFC;
 *   • правки меняют геометрию модели, snap привязывается к облаку по двум модам и
 *     отклоняет смещение > 0.25 м; undo/redo/reset работают и глубина истории ≥ 20;
 *   • IFC на отредактированной модели содержит новые координаты.
 * Часть проверок — source-level (как в других r*-тестах приложения), часть — исполнение
 * чистых функций модуля в Node (без DOM).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }

const ROOT = path.join(__dirname, '..');
const R = path.join(ROOT, 'renderer');
const SRC = fs.readFileSync(path.join(R, 'lixel-scan2bim-editor.js'), 'utf8');
const UI = fs.readFileSync(path.join(R, 'lixel-scan2bim-ui.js'), 'utf8');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const EDITOR = require(path.join(R, 'lixel-scan2bim-editor.js'));
const S = require(path.join(R, 'scan2bim.js'));

// Минимальная модель «стена 4 м по X с одной дверью», Y вверх (план X,Z).
function makeModel() {
  return {
    ok: true,
    units: 'm',
    storey: { floorY: 0, ceilY: 3, height: 3 },
    footprint: [[0, 0], [4, 0], [4, 3], [0, 3]],
    walls: [{
      a: [0, 0], b: [4, 0], dir: [1, 0], thickness: 0.15, faces: 2, rms: 0.002,
      length: 4, angleDeg: 0, base: 0, top: 3, height: 3, material: 'concrete',
      openings: [{ along: 1.5, width: 0.9, sill: 0, head: 2.1, kind: 'door' }]
    }],
    slabs: [
      { type: 'floor', level: 0, polygon: [[0, 0], [4, 0], [4, 3], [0, 3]], thickness: 0.2, area: 12 },
      { type: 'ceiling', level: 3, polygon: [[0, 0], [4, 0], [4, 3], [0, 3]], thickness: 0.2, area: 12 }
    ],
    rooms: [{ polygon: [[0.1, 0.1], [3.9, 0.1], [3.9, 2.9], [0.1, 2.9]], area: 10.24, cx: 2, cz: 1.5 }],
    stats: { wallCount: 1, openingCount: 1, roomCount: 1, roomsArea: 10.24, totalWallLength: 4, floorArea: 12 }
  };
}
// Модель без проёмов — для проверки координат в IFC.
function makePlainModel() {
  const m = makeModel();
  m.walls[0].openings = [];
  m.stats.openingCount = 0;
  return m;
}
// Облако: точки двух граней стены z1/z2 (полоса вокруг оси, y в пределах стены).
function faceCloud(z1, z2) {
  const pts = [];
  for (let s = 0.2; s <= 3.8; s += 0.1) {
    for (let k = 0; k < 4; k++) { pts.push([s, 1.0, z1]); pts.push([s, 1.0, z2]); }
  }
  return pts;
}

// ===================== source-level: подключение и API =====================
test('r110: кнопка «Редактор модели» стоит рядом с «Построить BIM»', () => {
  assert.match(UI, /bBuild\.id = 'lxScan2BimBuildBtn'/);
  assert.match(UI, /bEdit\.id = 'lxScan2BimEditorBtn'/);
  assert.ok(UI.includes('Редактор модели'), 'нет подписи кнопки');
  assert.ok(UI.indexOf('lxScan2BimBuildBtn') < UI.indexOf('lxScan2BimEditorBtn'), 'кнопка редактора должна идти после построения');
});

test('r110: редактор грузится по требованию (без правки index.html)', () => {
  assert.ok(UI.includes("s.src = 'lixel-scan2bim-editor.js?v=1233'"), 'нет динамической загрузки редактора');
  assert.ok(UI.includes('window.__lxS2BEditor'), 'UI не знает публичный API редактора');
  assert.ok(UI.includes('E.open(state.model)'), 'модель не передаётся в редактор');
  assert.ok(UI.includes('refreshPreview'), 'нет восстановления штатного предпросмотра');
  assert.ok(!HTML.includes('lixel-scan2bim-editor.js'), 'index.html не должен требовать правок (чужая зона)');
});

test('r110: модуль экспортирует функции редактора', () => {
  const API = ['open', 'close', 'attach', 'setModel', 'getModel',
    'editMoveWall', 'editThickness', 'editWallEnd', 'editOpeningMove', 'deleteOpening', 'addDoor',
    'snapWall', 'undo', 'redo', 'reset', 'canUndo', 'canRedo',
    'modelJson', 'saveJson', 'exportEditedIfc', 'refreshStats', 'refreshOverlay'];
  for (const name of API) assert.strictEqual(typeof EDITOR[name], 'function', 'нет функции ' + name);
  assert.ok(EDITOR.historyLimit >= 20, 'глубина истории меньше 20: ' + EDITOR.historyLimit);
  assert.ok(SRC.includes('window.__lxS2BEditor'), 'нет публичного API в окне');
  assert.ok(SRC.includes('module.exports'), 'нет module.exports для node --test');
  // Правки — в памяти, без Python/сети.
  assert.ok(!/require\(\s*['"]child_process['"]\s*\)/.test(SRC), 'редактор не должен запускать процессы');
  assert.ok(!/\bspawn\s*\(/.test(SRC), 'редактор не должен spawn-ить Python');
  assert.ok(!/\bfetch\s*\(/.test(SRC), 'редактор не должен ходить в сеть');
});

test('r110: панель создаёт элементы с data-атрибутами', () => {
  assert.match(SRC, /data-lx-edit="panel"|setAttribute\('data-lx-edit',\s*'panel'\)/, 'нет data-lx-edit="panel"');
  for (const edit of ['body', 'walls', 'wall-edit', 'openings', 'opening-edit', 'rooms', 'stats', 'actions', 'status', 'snap-status']) {
    assert.ok(SRC.includes('data-lx-edit="' + edit + '"'), 'нет data-lx-edit="' + edit + '"');
  }
  for (const act of ['undo', 'redo', 'wall-move', 'wall-thick', 'wall-end', 'snap', 'op-move', 'op-del', 'op-add-door', 'reset', 'save-json', 'export-ifc']) {
    assert.ok(SRC.includes('data-act="' + act + '"'), 'нет data-act="' + act + '"');
  }
  assert.ok(SRC.includes('data-wall-index="'), 'нет data-wall-index');
  assert.ok(SRC.includes('data-opening-index="'), 'нет data-opening-index');
  assert.ok(SRC.includes('data-room-index="'), 'нет data-room-index');
  assert.ok(SRC.includes("p.id = 'lxS2BEditorPanel'") && SRC.includes("getElementById('lxS2BEditorPanel')"), 'нет id панели');
});

test('r110: оверлей редактора — линии граней стены через _setOverlay', () => {
  assert.ok(SRC.includes('_setOverlay'), 'нет работы с оверлеем вьюера');
  assert.match(SRC, /gkind:\s*'wire'/, 'оверлей не рисует линии');
  assert.ok(SRC.includes('pushWallEdges') && SRC.includes('pushOpeningEdges'), 'нет линий граней стены/проёма');
  assert.ok(SRC.includes('_setOverlay(objs)'), 'оверлей не обновляется');
});

test('r110: оформление — токены tokens.css, без синего/белого/градиентов', () => {
  assert.ok(SRC.includes('var(--accent)') && SRC.includes('var(--bg-2)') && SRC.includes('var(--txt-3)'), 'нет токенов палитры');
  assert.ok(!/linear-gradient|radial-gradient/.test(SRC), 'градиенты запрещены дизайн-системой');
  assert.ok(!/#fff(?:fff)?\b/i.test(SRC), 'чистый белый запрещён дизайн-системой');
});

// ===================== исполнение: правки стены =====================
test('r110: editMoveWall — сдвиг по нормали n=(-dz,dx)', () => {
  const m = makeModel();
  const r = EDITOR.editMoveWall(m, 0, 0.05);
  assert.ok(r.ok, 'сдвиг не выполнен: ' + r.reason);
  assert.ok(Math.abs(m.walls[0].a[1] - 0.05) < 1e-9 && Math.abs(m.walls[0].b[1] - 0.05) < 1e-9, 'стена не сдвинулась по +Z');
  assert.ok(Math.abs(m.walls[0].a[0]) < 1e-9, 'сдвиг не должен менять X для стены по X');
  assert.ok(Math.abs(m.walls[0].length - 4) < 1e-9, 'длина изменилась при сдвиге');

  const v = makeModel();
  v.walls[0].a = [0, 0]; v.walls[0].b = [0, 4]; v.walls[0].dir = [0, 1]; // стена по Z
  EDITOR.editMoveWall(v, 0, 0.05);
  assert.ok(Math.abs(v.walls[0].a[0] + 0.05) < 1e-9, 'нормаль стены по Z должна давать сдвиг по -X');
});

test('r110: editThickness — ±0.01 и пределы движка', () => {
  const m = makeModel();
  let r = EDITOR.editThickness(m, 0, 0.01);
  assert.ok(r.ok && Math.abs(m.walls[0].thickness - 0.16) < 1e-9, 'толщина не прибавилась: ' + m.walls[0].thickness);
  r = EDITOR.editThickness(m, 0, -0.01);
  assert.ok(r.ok && Math.abs(m.walls[0].thickness - 0.15) < 1e-9, 'толщина не убавилась');
  EDITOR.editThickness(m, 0, 10);
  assert.ok(m.walls[0].thickness <= 0.6 + 1e-9, 'толщина вышла за максимум движка: ' + m.walls[0].thickness);
  EDITOR.editThickness(m, 0, -10);
  assert.ok(m.walls[0].thickness >= 0.05 - 1e-9, 'толщина вышла за минимум: ' + m.walls[0].thickness);
});

test('r110: editWallEnd — торцы ±0.1, along проёма не уезжает', () => {
  const m = makeModel();
  const r = EDITOR.editWallEnd(m, 0, 'a', 0.1);
  assert.ok(r.ok, 'удлинение начала не выполнено: ' + r.reason);
  assert.ok(Math.abs(m.walls[0].a[0] + 0.1) < 1e-9, 'начало не удлинилось: ' + m.walls[0].a);
  assert.ok(Math.abs(m.walls[0].length - 4.1) < 1e-6, 'длина не выросла: ' + m.walls[0].length);
  assert.ok(Math.abs(m.walls[0].openings[0].along - 1.6) < 1e-9, 'along проёма не пересчитан: ' + m.walls[0].openings[0].along);

  const r2 = EDITOR.editWallEnd(m, 0, 'b', 0.1);
  assert.ok(r2.ok && Math.abs(m.walls[0].length - 4.2) < 1e-6, 'конец не удлинился');

  const n = makeModel();
  n.walls[0].openings[0].along = 0.2; // дверь у самого начала
  const r3 = EDITOR.editWallEnd(n, 0, 'a', -0.5);
  assert.ok(!r3.ok, 'укорачивание, выталкивающее проём, должно быть отклонено');
  assert.ok(Math.abs(n.walls[0].length - 4) < 1e-9, 'модель изменилась при отклонённой правке');
});

// ===================== исполнение: проёмы =====================
test('r110: editOpeningMove — along/width/sill/head ±0.05 с зажимами', () => {
  const m = makeModel();
  assert.ok(EDITOR.editOpeningMove(m, 0, 0, 'along', 0.05).ok);
  assert.ok(Math.abs(m.walls[0].openings[0].along - 1.55) < 1e-9, 'along не сдвинулся');
  assert.ok(EDITOR.editOpeningMove(m, 0, 0, 'width', 0.05).ok);
  assert.ok(Math.abs(m.walls[0].openings[0].width - 0.95) < 1e-9, 'ширина не изменилась');
  const r = EDITOR.editOpeningMove(m, 0, 0, 'sill', 0.05);
  assert.ok(r.ok && Math.abs(m.walls[0].openings[0].sill - 0.05) < 1e-9, 'подоконник не поднялся');
  const rh = EDITOR.editOpeningMove(m, 0, 0, 'head', 10);
  assert.ok(rh.ok, 'верх должен клампиться к высоте стены, а не падать');
  assert.ok(m.walls[0].openings[0].head <= m.walls[0].height + 1e-9, 'head выше стены: ' + m.walls[0].openings[0].head);
  assert.ok(!EDITOR.editOpeningMove(m, 0, 0, 'head', 10).ok, 'повторный +10 при уже максимальном head — без изменений');
});

test('r110: deleteOpening / addDoor 0.9×2.1', () => {
  const m = makePlainModel();
  const add = EDITOR.addDoor(m, 0);
  assert.ok(add.ok, 'дверь не добавлена: ' + add.reason);
  const door = m.walls[0].openings[add.opening];
  assert.ok(door && door.kind === 'door', 'добавлен не дверной проём');
  assert.ok(Math.abs(door.width - 0.9) < 1e-9 && Math.abs(door.head - 2.1) < 1e-9, 'размеры двери не 0.9×2.1');
  assert.strictEqual(m.stats.openingCount, 1, 'статистика проёмов не пересчитана');
  const del = EDITOR.deleteOpening(m, 0, add.opening);
  assert.ok(del.ok && m.walls[0].openings.length === 0, 'проём не удалён');
  assert.strictEqual(m.stats.openingCount, 0, 'статистика после удаления не пересчитана');
});

// ===================== исполнение: привязка к облаку =====================
test('r110: snapWall — медианы по двум модам, сдвиг ≤ 0.25 м', () => {
  const m = makePlainModel();
  const r = EDITOR.snapWall(m, 0, faceCloud(-0.05, 0.25));
  assert.ok(r.ok, 'привязка не выполнена: ' + r.reason);
  assert.ok(Math.abs(r.shift - 0.1) < 1e-6, 'смещение оси неверно: ' + r.shift);
  assert.ok(Math.abs(m.walls[0].a[1] - 0.1) < 1e-6, 'стена не сдвинулась к облаку: ' + m.walls[0].a);
  assert.ok(Math.abs(m.walls[0].thickness - 0.3) < 1e-6, 'толщина по облаку неверна: ' + m.walls[0].thickness);
  assert.ok(r.points >= 2 * 24 && r.bands.lo > 0 && r.bands.hi > 0, 'нет статистики по модам');

  const far = makePlainModel();
  const a0 = far.walls[0].a.slice();
  const bad = EDITOR.snapWall(far, 0, faceCloud(0.25, 0.35));
  assert.ok(!bad.ok, 'смещение > 0.25 м должно быть отклонено');
  assert.deepStrictEqual(far.walls[0].a, a0, 'модель изменилась при отклонённой привязке');

  // Float32Array из вьюера (v.base[0].pos) тоже принимается
  const f = makePlainModel();
  const f32 = new Float32Array(faceCloud(-0.05, 0.25).flat());
  const rf = EDITOR.snapWall(f, 0, f32);
  assert.ok(rf.ok && Math.abs(rf.shift - 0.1) < 1e-3, 'Float32Array не поддерживается: ' + (rf.reason || rf.shift));
});

// ===================== исполнение: undo / redo / reset =====================
test('r110: undo/redo ≥ 20 снимков, reset к исходной модели', () => {
  const m = makeModel();
  const initialZ = m.walls[0].a[1];
  EDITOR.attach(m);
  assert.strictEqual(EDITOR.getModel(), m, 'attach не запомнил модель');

  for (let i = 0; i < 25; i++) assert.ok(EDITOR.editMoveWall(m, 0, 0.01).ok, 'правка ' + i + ' не выполнена');
  assert.ok(Math.abs(m.walls[0].a[1] - 0.25) < 1e-6, '25 сдвигов не применились: ' + m.walls[0].a[1]);
  assert.ok(EDITOR.getState().undo >= 20, 'глубина истории меньше 20: ' + EDITOR.getState().undo);

  for (let i = 0; i < 20; i++) assert.ok(EDITOR.undo(), 'undo ' + i + ' не сработал');
  assert.ok(Math.abs(m.walls[0].a[1] - 0.05) < 1e-6, 'после 20 undo ожидался сдвиг 0.05: ' + m.walls[0].a[1]);
  assert.ok(EDITOR.redo(), 'redo не сработал');
  assert.ok(Math.abs(m.walls[0].a[1] - 0.06) < 1e-6, 'redo не вернул правку: ' + m.walls[0].a[1]);

  assert.ok(EDITOR.reset(), 'reset не выполнился');
  assert.strictEqual(EDITOR.getModel(), m, 'reset потерял ссылку на модель');
  assert.ok(Math.abs(m.walls[0].a[1] - initialZ) < 1e-9, 'reset не вернул исходную геометрию: ' + m.walls[0].a[1]);
  assert.strictEqual(m.walls[0].openings.length, 1, 'reset не вернул проёмы');
});

// ===================== исполнение: IFC =====================
test('r110: toIFC на модели с изменённой стеной содержит новые координаты', () => {
  const m = makePlainModel();
  const before = S.toIFC(m, { name: 'before.ifc' });
  assert.ok(before.includes('IFCCARTESIANPOINT((2.,0.,0.))'), 'в IFC нет исходной оси стены');
  assert.ok(!before.includes('IFCCARTESIANPOINT((2.,0.05,0.))'), 'исходный IFC уже содержит сдвиг');

  const r = EDITOR.editMoveWall(m, 0, 0.05);
  assert.ok(r.ok);
  const after = S.toIFC(m, { name: 'after.ifc' });
  assert.ok(after.includes('IFCCARTESIANPOINT((2.,0.05,0.))'), 'в IFC нет новых координат стены');
  assert.ok(!after.includes('IFCCARTESIANPOINT((2.,0.,0.))'), 'в IFC остались старые координаты');
  assert.ok(after.includes('IFCWALLSTANDARDCASE'), 'стена исчезла из IFC');
  assert.ok(after.trim().endsWith('END-ISO-10303-21;'), 'IFC не завершён');
});

test('r110: exportEditedIfc передаёт отредактированную модель в window.Scan2BIM.toIFC', () => {
  const m = makePlainModel();
  EDITOR.attach(m);
  EDITOR.editMoveWall(m, 0, 0.05);
  const ifc = EDITOR.exportEditedIfc();      // без аргумента — текущая модель редактора
  assert.ok(ifc.includes('ISO-10303-21'), 'экспорт не вернул STEP');
  assert.ok(ifc.includes('IFCCARTESIANPOINT((2.,0.05,0.))'), 'toIFC получил неотредактированную модель');
  assert.ok(ifc.includes('IFCWALLSTANDARDCASE'));

  const m2 = makePlainModel();
  EDITOR.editMoveWall(m2, 0, 0.05);
  assert.ok(EDITOR.exportEditedIfc(m2).includes('IFCCARTESIANPOINT((2.,0.05,0.))'), 'явная модель не передана в toIFC');
  assert.throws(() => EDITOR.exportEditedIfc({ ok: false }), /модель не построена/);
});

test('r110: «Сохранить JSON» и «Сбросить» в исходнике панели', () => {
  assert.ok(SRC.includes('scan2bim-edited.json'), 'нет имени JSON-файла');
  assert.ok(SRC.includes('scan2bim-edited.ifc'), 'нет имени IFC-файла');
  assert.ok(SRC.includes('modelJson'), 'нет JSON-сериализации модели');
  assert.ok(SRC.includes('initialJson'), 'нет исходного снимка для «Сбросить»');
  assert.ok(SRC.includes('JSON.stringify(model || st.model)') || SRC.includes('JSON.stringify'), 'история должна хранить JSON-снимки');
});

// ===================== jsdom: реальная панель редактора =====================
// Настоящий renderer/lixel-scan2bim-editor.js исполняется в jsdom; вьюер — заглушка
// с base[0].pos (как window.__viewer в приложении) и перехватом _setOverlay.
function makeEditorEnv() {
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div id="stageSideR"></div><div id="lxLegacy"></div></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const log = { overlays: [], toasts: [] };
  const viewer = {
    base: [{ pos: new Float32Array(faceCloud(-0.05, 0.25).flat()) }],
    _setOverlay(objs) { log.overlays.push(objs); },
    render() {}
  };
  w.__viewer = viewer;
  w.__toast = (msg) => { log.toasts.push(String(msg)); };
  w.__lxScan2BIM = { open() {}, refreshPreview() {} };
  w.eval(SRC);
  return { w, log, viewer, E: w.__lxS2BEditor };
}
const q = (w, sel) => w.document.querySelector(sel);
const qa = (w, sel) => Array.from(w.document.querySelectorAll(sel));
const clickEl = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

test('r110: панель редактора (jsdom) — элементы с data-атрибутами и подсветка', { skip: !JSDOM && 'jsdom не установлен' }, () => {
  const { w, log, E } = makeEditorEnv();
  assert.ok(E && typeof E.open === 'function', 'редактор не установил window.__lxS2BEditor');
  const model = makeModel();
  E.open(model);

  const panel = q(w, '#lxS2BEditorPanel');
  assert.ok(panel, 'панель не создана');
  assert.strictEqual(panel.style.display, 'block');
  assert.strictEqual(panel.getAttribute('aria-label'), 'Редактор BIM-модели');
  assert.ok(q(w, '[data-lx-edit="panel"]') === panel, 'нет data-lx-edit=panel');

  // список стен и помещений
  const wallRows = qa(w, '[data-lx-edit="walls"] [data-wall-index]');
  assert.strictEqual(wallRows.length, 1, 'нет строки стены');
  assert.strictEqual(wallRows[0].getAttribute('aria-selected'), 'true', 'выбранная стена не помечена');
  assert.ok(/Стена 1/.test(wallRows[0].textContent));
  assert.strictEqual(qa(w, '[data-lx-edit="rooms"] [data-room-index]').length, 1, 'нет строки помещения');

  // редактор стены
  assert.ok(q(w, '[data-lx-edit="wall-edit"]'), 'нет блока правки стены');
  for (const act of ['wall-move', 'wall-thick', 'wall-end', 'snap']) {
    assert.ok(qa(w, '[data-act="' + act + '"]').length >= 1, 'нет кнопок data-act=' + act);
  }
  // проёмы
  assert.ok(q(w, '[data-lx-edit="openings"]'), 'нет блока проёмов');
  assert.strictEqual(qa(w, '[data-lx-edit="openings"] [data-opening-index][role="option"]').length, 1, 'нет строки выбора проёма');
  assert.ok(qa(w, '[data-act="op-del"]').length >= 1, 'нет кнопки удаления проёма');
  assert.ok(q(w, '[data-act="op-move"]') && q(w, '[data-act="op-del"]') && q(w, '[data-act="op-add-door"]'), 'нет кнопок правки проёмов');
  // статистика/файл/история
  assert.ok(q(w, '[data-lx-edit="stats"]'), 'нет статистики');
  for (const act of ['undo', 'redo', 'reset', 'save-json', 'export-ifc']) {
    assert.ok(q(w, '[data-act="' + act + '"]'), 'нет кнопки data-act=' + act);
  }

  // оверлей: линии граней и подсветка выбранной стены
  assert.ok(log.overlays.length > 0, 'оверлей ни разу не обновлён');
  const last = log.overlays[log.overlays.length - 1];
  assert.ok(Array.isArray(last) && last.length >= 2, 'ожидались каркас стен + подсветка');
  assert.ok(last.every((o) => o && o.line === true && o.gkind === 'wire' && o.pos instanceof w.Float32Array), 'оверлей не из wire-линий');
});

test('r110: панель редактора (jsdom) — кнопки двигают стену, snap, undo и «нет модели»', { skip: !JSDOM && 'jsdom не установлен' }, () => {
  const { w, log, E } = makeEditorEnv();
  const model = makeModel();
  E.open(model);

  // сдвиг +0.05 по нормали кнопкой
  const plus = qa(w, '[data-act="wall-move"]').find((b) => +b.getAttribute('data-delta') > 0);
  assert.ok(plus, 'нет кнопки +0.05');
  clickEl(w, plus);
  assert.ok(Math.abs(model.walls[0].a[1] - 0.05) < 1e-9, 'кнопка не сдвинула стену: ' + model.walls[0].a);
  assert.strictEqual(E.getState().undo, 1, 'правка не попала в историю');
  assert.ok(qa(w, '[data-lx-edit="wall-edit"]').length === 1, 'панель не перерисовалась после правки');

  // толщина +0.01
  const tPlus = qa(w, '[data-act="wall-thick"]').find((b) => +b.getAttribute('data-delta') > 0);
  clickEl(w, tPlus);
  assert.ok(Math.abs(model.walls[0].thickness - 0.16) < 1e-9, 'толщина не изменилась: ' + model.walls[0].thickness);

  // привязка к облаку (viewer.base[0].pos) — сдвиг и толщина по двум граням
  clickEl(w, q(w, '[data-act="snap"]'));
  const snapText = q(w, '[data-lx-edit="snap-status"]').textContent;
  assert.match(snapText, /Привязано/, 'snap не сработал: ' + snapText);
  assert.ok(Math.abs(model.walls[0].a[1] - 0.1) < 1e-6, 'snap не сдвинул стену к облаку: ' + model.walls[0].a);
  assert.ok(Math.abs(model.walls[0].thickness - 0.3) < 1e-6, 'snap не подобрал толщину: ' + model.walls[0].thickness);

  // undo кнопкой
  const beforeUndo = model.walls[0].a[1];
  clickEl(w, q(w, '[data-act="undo"]'));
  assert.ok(Math.abs(model.walls[0].a[1] - beforeUndo) > 1e-9 || model.walls[0].thickness !== 0.3, 'undo кнопкой не отменил правку');
  assert.ok(log.overlays.length >= 4, 'оверлей не обновлялся после правок');

  // нет модели — подсказка (и кнопка открыть «Скан → BIM»)
  E.attach(null);
  E.open(null);
  assert.ok(q(w, '[data-lx-edit="hint"]') && /построена/i.test(q(w, '[data-lx-edit="hint"]').textContent), 'нет подсказки «модель не построена»');
  assert.ok(q(w, '[data-act="open-build"]'), 'нет кнопки перехода к построению');
  assert.strictEqual(qa(w, '[data-wall-index]').length, 0, 'при отсутствии модели не должно быть списка стен');
});

test('r110: панель редактора (jsdom) — удаление проёма из строки списка', { skip: !JSDOM && 'jsdom не установлен' }, () => {
  const { w, E } = makeEditorEnv();
  const model = makeModel();
  model.walls[0].openings.push({ along: 2.8, width: 0.7, sill: 0.9, head: 2.2, kind: 'window' });
  model.stats.openingCount = 2;
  E.open(model);

  const delBtns = qa(w, '[data-lx-edit="openings"] [data-act="op-del"]');
  assert.strictEqual(delBtns.length, 2, 'ожидались кнопки удаления у обеих строк проёмов');
  clickEl(w, delBtns[1]);              // удаляем окно (индекс 1), а не выбранную дверь (0)
  assert.strictEqual(model.walls[0].openings.length, 1, 'проём не удалён');
  assert.strictEqual(model.walls[0].openings[0].kind, 'door', 'удалена не та строка списка');
  assert.strictEqual(model.stats.openingCount, 1, 'статистика проёмов не пересчитана');
  assert.strictEqual(E.getState().undo, 1, 'удаление не попало в историю');
});

test('r110: интеграция (jsdom) — кнопка «Редактор модели» в панели «Скан → BIM» грузит модуль по требованию', { skip: !JSDOM && 'jsdom не установлен' }, () => {
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div id="lxLegacy"></div>' +
    '<div class="stage"><div id="stageSideL"></div><div id="stageSideR"></div></div></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const toasts = [];
  w.__toast = (m) => toasts.push(String(m));
  w.__viewer = { base: [{ points: true, pos: new Float32Array([0, 1, 0, 4, 1, 0]) }], _setOverlay() {}, render() {} };
  w.eval(UI);                       // настоящий renderer/lixel-scan2bim-ui.js
  const api = w.__lxScan2BIM;
  assert.ok(api, 'UI не установил window.__lxScan2BIM');
  assert.strictEqual(typeof api.editor, 'function', 'нет пункта открытия редактора в API');
  api.open();
  const btn = w.document.getElementById('lxScan2BimEditorBtn');
  assert.ok(btn, 'нет кнопки «Редактор модели» в панели «Скан → BIM»');
  assert.match(btn.textContent, /Редактор модели/);

  // клик по кнопке подключает скрипт динамически (index.html не правили)
  btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const tag = w.document.querySelector('script[src*="lixel-scan2bim-editor.js"]');
  assert.ok(tag, 'динамический <script> редактора не создан');
  // эмулируем загрузку файла: в Electron его отдаёт диск, в jsdom — eval + onload
  w.eval(SRC);
  tag.onload();
  assert.ok(w.__lxS2BEditor && typeof w.__lxS2BEditor.open === 'function', 'редактор не установлен в окне после загрузки');
  const panel = w.document.getElementById('lxS2BEditorPanel');
  assert.ok(panel && panel.style.display === 'block', 'панель редактора не открылась после загрузки');

  // модель, построенная кнопкой «Построить BIM», передаётся в редактор через setModel
  const model = makeModel();
  w.__lxS2BEditor.setModel(model);
  assert.strictEqual(w.document.querySelectorAll('[data-lx-edit="walls"] [data-wall-index]').length, 1, 'модель не попала в список редактора');
  assert.strictEqual(w.document.querySelectorAll('[data-lx-edit="rooms"] [data-room-index]').length, 1, 'помещения не попали в список');
  // закрытие панели «Скан → BIM» не закрывает редактор
  api.close();
  assert.strictEqual(w.__lxS2BEditor.isOpen(), true, 'редактор закрылся вместе с панелью «Скан → BIM»');
  assert.ok(toasts.every((t) => !/Не удалось загрузить редактор/.test(t)), 'были ошибки загрузки: ' + toasts.join('; '));
});;
