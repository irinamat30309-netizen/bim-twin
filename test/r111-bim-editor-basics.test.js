'use strict';
/*
 * r111 — Фаза 4 ROADMAP-IDEAL (D3): базовый полноценный редактор BIM-модели.
 * Проверяем то, что добавлено поверх r110-редактора:
 *   • СМОТРЕТЬ: режимы «Контур» / «3D-объём» (кнопки, плотный каркас стен, рёбра проёмов,
 *     сетка пола по помещениям, опциональный потолок, заливка стен треугольниками, если
 *     вьюер умеет меши; бюджет оверлея ≤ 20000 сегментов);
 *   • УДАЛЯТЬ: deleteWall/deleteRoom/clearOpenings/clearModel (статистика пересчитывается,
 *     undo/redo покрывает удаления), кнопки панели и клавиша Delete, confirm для удалений;
 *   • ЭКСПОРТ: JSON и IFC (были) + OBJ и DXF через window.Scan2BIM.toOBJ/toDXF + download;
 *   • ИМПОРТ: «Загрузить JSON» — input[type=file], парсинг, валидация схемы
 *     (walls/rooms/slabs/storey), setModel + сброс истории; ошибка не меняет модель;
 *   • СТАТУС: счётчики «стены/проёмы/помещения/площадь» + подсказка «Ctrl+Z / Delete».
 * Часть проверок — source-level, часть — исполнение чистых функций в Node (без DOM),
 * часть — настоящая панель в jsdom (как в r110).
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
const EDITOR = require(path.join(R, 'lixel-scan2bim-editor.js'));
const S = require(path.join(R, 'scan2bim.js'));

// Модель для тестов: 2 стены (дверь + окно), 2 помещения, плита, контур этажа.
function makeModel() {
  return {
    ok: true,
    units: 'm',
    storey: { floorY: 0, ceilY: 3, height: 3 },
    footprint: [[0, 0], [4, 0], [4, 3], [0, 3]],
    walls: [
      {
        a: [0, 0], b: [4, 0], dir: [1, 0], thickness: 0.15, faces: 2, rms: 0.002,
        length: 4, angleDeg: 0, base: 0, top: 3, height: 3, material: 'concrete',
        openings: [{ along: 1.5, width: 0.9, sill: 0, head: 2.1, kind: 'door' }]
      },
      {
        a: [0, 0], b: [0, 3], dir: [0, 1], thickness: 0.2, faces: 2, rms: 0.003,
        length: 3, angleDeg: 90, base: 0, top: 3, height: 3, material: 'brick',
        openings: [{ along: 0.8, width: 0.7, sill: 0.9, head: 2.2, kind: 'window' }]
      }
    ],
    slabs: [
      { type: 'floor', level: 0, polygon: [[0, 0], [4, 0], [4, 3], [0, 3]], thickness: 0.2, area: 12 },
      { type: 'ceiling', level: 3, polygon: [[0, 0], [4, 0], [4, 3], [0, 3]], thickness: 0.2, area: 12 }
    ],
    rooms: [
      { polygon: [[0.1, 0.1], [3.9, 0.1], [3.9, 2.9], [0.1, 2.9]], area: 10.24, cx: 2, cz: 1.5 },
      { polygon: [[0.1, 2.9], [1.4, 2.9], [1.4, 2.99], [0.1, 2.99]], area: 0.12, cx: 0.7, cz: 2.95 }
    ],
    stats: { wallCount: 2, openingCount: 2, roomCount: 2, roomsArea: 10.36, totalWallLength: 7, floorArea: 12 }
  };
}
function makeMinimalModel() {
  return { ok: true, storey: { floorY: 0, ceilY: 3, height: 3 }, walls: [], rooms: [], slabs: [], footprint: [], stats: {} };
}

function requireEditor() {
  // Общий module state редактора в node --test: каждому тесту — чистая модель через attach.
  return EDITOR;
}

// ===================== source-level: кнопки, подписи, контракт =====================
test('r111: УДАЛЯТЬ — кнопки стены/помещения/проёмов/очистки и встроенный диалог', () => {
  for (const act of ['delete-wall', 'delete-room', 'op-clear', 'clear-model']) {
    assert.ok(SRC.includes('data-act="' + act + '"'), 'нет кнопки data-act=' + act);
  }
  assert.ok(SRC.includes('Удалить стену'), 'нет подписи «Удалить стену»');
  assert.ok(SRC.includes('Удалить помещение'), 'нет подписи «Удалить помещение»');
  assert.ok(SRC.includes('Удалить все проёмы'), 'нет подписи «Удалить все проёмы»');
  assert.ok(SRC.includes('Очистить модель'), 'нет подписи «Очистить модель»');
  // подтверждение — встроенный диалог приложения (ui-dialogs.test.js запрещает нативные confirm/alert)
  assert.match(SRC, /__lxKit/, 'нет встроенного диалога подтверждения');
  assert.match(SRC, /\.ask\(\{/, 'подтверждение должно идти через __lxKit.ask');
  assert.match(SRC, /function doDeleteSelected\s*\(/, 'нет удаления выбранного элемента');
  assert.match(SRC, /k === 'delete'/, 'клавиша Delete не обрабатывается');
  assert.match(SRC, /function deleteWall\s*\(/, 'нет чистой функции deleteWall');
  assert.match(SRC, /function deleteRoom\s*\(/, 'нет чистой функции deleteRoom');
  assert.match(SRC, /function clearOpenings\s*\(/, 'нет чистой функции clearOpenings');
  assert.match(SRC, /function clearModel\s*\(/, 'нет чистой функции clearModel');
});

test('r111: ИМПОРТ/ЭКСПОРТ — input[type=file], OBJ/DXF, подписи кнопок', () => {
  assert.match(SRC, /<input type="file"[^>]*data-lx-edit="import-input"/, 'нет input[type=file] для импорта');
  assert.ok(SRC.includes('accept=".json,application/json"'), 'input должен принимать .json');
  for (const act of ['import-json', 'export-obj', 'export-dxf', 'save-json', 'export-ifc']) {
    assert.ok(SRC.includes('data-act="' + act + '"'), 'нет кнопки data-act=' + act);
  }
  assert.ok(SRC.includes('Загрузить JSON'), 'нет подписи «Загрузить JSON»');
  assert.ok(SRC.includes('Экспорт OBJ') && SRC.includes('Экспорт DXF'), 'нет подписей OBJ/DXF');
  assert.ok(SRC.includes('toOBJ') && SRC.includes('toDXF'), 'OBJ/DXF должны идти через Scan2BIM.toOBJ/toDXF');
  assert.ok(SRC.includes("'scan2bim-edited.obj'") && SRC.includes("'scan2bim-edited.dxf'"),
    'нет имён файлов OBJ/DXF');
  assert.match(SRC, /function importJson\s*\(/, 'нет importJson');
  assert.match(SRC, /function parseModelJson\s*\(/, 'нет parseModelJson');
  assert.match(SRC, /function importSelectedFile\s*\(/, 'нет чтения выбранного файла');
});

test('r111: СМОТРЕТЬ — режимы «Контур»/«3D-объём», потолок, заливка, бюджет 20k', () => {
  assert.ok(SRC.includes('data-act="view-mode"'), 'нет переключателя режима просмотра');
  assert.ok(SRC.includes("'3D-объём'") && SRC.includes("'Контур'"), 'нет подписей режимов');
  assert.ok(SRC.includes('toggle-ceiling') && SRC.includes('toggle-fill'), 'нет переключателей потолка/заливки');
  assert.match(SRC, /MAX_OVERLAY_SEGMENTS\s*=\s*20000/, 'бюджет сегментов должен быть 20000');
  assert.match(SRC, /function buildOverlay\s*\(/, 'нет чистого построителя оверлея');
  assert.match(SRC, /gkind:\s*'solid'/, 'заливка должна отдаваться как solid-меш');
  assert.match(SRC, /function pushOpeningWireVolume\s*\(/, 'нет плотных рёбер проёмов');
  assert.match(SRC, /function pushPolyGrid\s*\(/, 'нет сетки пола по помещениям');
  assert.match(SRC, /viewerSupportsSolid\s*\(/, 'нет определения поддержки мешей вьюером');
  // дизайн-система: палитра на токенах, без градиентов/чистого белого
  assert.ok(SRC.includes('var(--accent)') && SRC.includes('var(--bg-2)') && SRC.includes('var(--txt-3)'), 'нет токенов палитры');
  assert.ok(!/linear-gradient|radial-gradient/.test(SRC), 'градиенты запрещены дизайн-системой');
  assert.ok(!/#fff(?:fff)?\b/i.test(SRC), 'чистый белый запрещён дизайн-системой');
});

test('r111: СТАТУС — счётчики стены/проёмы/помещения/площадь и подсказка Ctrl+Z/Delete', () => {
  assert.ok(SRC.includes('data-lx-edit="statusbar"'), 'нет статус-строки со счётчиками');
  assert.ok(SRC.includes('Ctrl+Z — отменить') && SRC.includes('Delete — удалить выбранное'),
    'нет подсказки «Ctrl+Z / Delete»');
  assert.ok(SRC.includes('Площадь'), 'нет счётчика площади в статусе');
  const m = makeModel();
  const text = EDITOR.statusBarText(m);
  assert.match(text, /Стены/); assert.match(text, /Проёмы/);
  assert.match(text, /Помещения/); assert.match(text, /Площадь/);
  assert.match(text, /Ctrl\+Z/); assert.match(text, /Delete/);
  assert.match(EDITOR.modelCounts(m).walls === 2 ? '2' : 'x', /2/);
});

// ===================== исполнение: удаление и статистика =====================
test('r111: deleteWall — удаляет стену с проёмами, пересчитывает статистику', () => {
  const m = makeModel();
  const r = requireEditor().deleteWall(m, 0);
  assert.ok(r.ok, 'удаление не выполнено: ' + r.reason);
  assert.strictEqual(m.walls.length, 1, 'стена не удалена');
  assert.strictEqual(m.walls[0].material, 'brick', 'удалена не та стена');
  assert.strictEqual(r.openings, 1, 'нет счётчика удалённых проёмов');
  assert.strictEqual(m.stats.wallCount, 1, 'stats.wallCount не пересчитан');
  assert.strictEqual(m.stats.openingCount, 1, 'stats.openingCount не пересчитан (окно осталось)');
  assert.strictEqual(r.remaining, 1, 'нет remaining');

  const m2 = makeModel();
  const bad = requireEditor().deleteWall(m2, 99);
  assert.ok(!bad.ok, 'несуществующая стена должна отклоняться');
  assert.strictEqual(m2.walls.length, 2, 'модель изменилась при отклонённом удалении');
});

test('r111: deleteRoom — удаляет помещение, пересчитывает площадь', () => {
  const m = makeModel();
  const r = requireEditor().deleteRoom(m, 0);
  assert.ok(r.ok, 'удаление помещения не выполнено: ' + r.reason);
  assert.strictEqual(m.rooms.length, 1, 'помещение не удалено');
  assert.strictEqual(m.stats.roomCount, 1, 'stats.roomCount не пересчитан');
  assert.ok(Math.abs(m.stats.roomsArea - 0.12) < 1e-6, 'площадь не пересчитана: ' + m.stats.roomsArea);
  assert.ok(Math.abs(r.area - 10.24) < 1e-6, 'нет площади удалённого помещения');

  const bad = requireEditor().deleteRoom(m, 5);
  assert.ok(!bad.ok && m.rooms.length === 1, 'несуществующее помещение должно отклоняться');
});

test('r111: clearOpenings — удаляет все проёмы стены, стена остаётся', () => {
  const m = makeModel();
  const r = requireEditor().clearOpenings(m, 0);
  assert.ok(r.ok, 'очистка проёмов не выполнена: ' + r.reason);
  assert.strictEqual(r.removed, 1, 'неверный счётчик удалённых проёмов');
  assert.strictEqual(m.walls.length, 2, 'стена не должна удаляться');
  assert.strictEqual(m.walls[0].openings.length, 0, 'проёмы не удалены');
  assert.strictEqual(m.stats.openingCount, 1, 'stats.openingCount не пересчитан');

  const bad = requireEditor().clearOpenings(m, 0);
  assert.ok(!bad.ok && /нет проёмов/.test(bad.reason), 'повторная очистка должна отклоняться с причиной');
});

test('r111: clearModel — очищает стены/проёмы/помещения/плиты, модель остаётся рабочей', () => {
  const m = makeModel();
  const r = requireEditor().clearModel(m);
  assert.ok(r.ok, 'очистка не выполнена: ' + r.reason);
  assert.strictEqual(m.walls.length, 0);
  assert.strictEqual(m.rooms.length, 0);
  assert.strictEqual(m.slabs.length, 0);
  assert.strictEqual(m.footprint.length, 0);
  assert.strictEqual(m.stats.wallCount, 0);
  assert.strictEqual(m.stats.openingCount, 0);
  assert.strictEqual(m.stats.roomCount, 0);
  assert.strictEqual(m.stats.roomsArea, 0);
  assert.strictEqual(m.stats.floorArea, 0);
  assert.strictEqual(m.ok, true, 'модель должна остаться ok:true — чтобы можно было загрузить JSON');
  assert.ok(m.storey && m.storey.height > 0, 'этаж не должен теряться');
  assert.strictEqual(r.removed.walls, 2, 'нет счётчика удалённых стен');
});

test('r111: undo/redo покрывает удаления (стена и очистка модели)', () => {
  const m = makeModel();
  const E = requireEditor();
  E.attach(m);
  assert.strictEqual(E.getState().undo, 0);

  assert.ok(E.deleteWall(m, 0).ok);
  assert.strictEqual(m.walls.length, 1);
  assert.ok(E.getState().undo >= 1, 'удаление не попало в историю');
  assert.ok(E.undo(), 'undo удаления не сработал');
  assert.strictEqual(m.walls.length, 2, 'undo не вернул стену');
  assert.strictEqual(m.walls[0].openings.length, 1, 'undo не вернул проёмы');
  assert.strictEqual(m.stats.wallCount, 2, 'undo не вернул статистику');
  assert.ok(E.redo(), 'redo удаления не сработал');
  assert.strictEqual(m.walls.length, 1, 'redo не удалил стену повторно');

  assert.ok(E.clearModel(m).ok);
  assert.strictEqual(m.walls.length, 0);
  assert.ok(E.undo(), 'undo очистки модели не сработал');
  assert.strictEqual(m.walls.length, 1, 'undo очистки не вернул стены');
});

// ===================== исполнение: импорт JSON =====================
test('r111: parseModelJson — валидация схемы walls/rooms/slabs/storey', () => {
  const E = requireEditor();
  const good = E.parseModelJson(JSON.stringify(makeModel()));
  assert.ok(good.ok, 'валидный JSON отклонён: ' + good.reason);
  assert.strictEqual(good.model.walls.length, 2);
  assert.strictEqual(good.model.rooms.length, 2);
  assert.strictEqual(good.model.slabs.length, 2);
  assert.ok(good.model.storey.height > 0, 'этаж не выведен');
  assert.strictEqual(good.model.stats.wallCount, 2, 'stats не пересчитаны при импорте');

  // минимальный JSON: этаж выводится из стен, толщина/высота по умолчанию
  const minimal = E.parseModelJson('{"walls":[{"a":[0,0],"b":[2,0],"height":2.7}]}');
  assert.ok(minimal.ok, 'минимальный JSON отклонён: ' + minimal.reason);
  assert.ok(Math.abs(minimal.model.storey.ceilY - 2.7) < 1e-9, 'этаж не выведен из высоты стены');
  assert.ok(Math.abs(minimal.model.walls[0].thickness - 0.15) < 1e-9, 'толщина по умолчанию не 0.15');

  const cases = [
    ['', /пуст/i],
    ['{', /синтаксис/i],
    ['null', /объект/i],
    ['[]', /объект/i],
    ['{"ok":false,"walls":[]}', /ok:false/i],
    ['{}', /раздел/i],
    ['{"walls":{}}', /walls/i],
    ['{"walls":[{"a":[0,0]}]}', /a и b/i],
    ['{"walls":[{"a":[0,0],"b":[1,0],"openings":[{"along":0,"width":0}]}]}', /width/i],
    ['{"rooms":[{"polygon":[[0,0],[1,0]]}]}', /полигон/i],
    ['{"walls":[],"storey":{"floorY":2,"ceilY":1}}', /ceilY/i],
    ['{"walls":[],"footprint":[[0,0]]}', /footprint/i]
  ];
  for (const [text, re] of cases) {
    const r = E.parseModelJson(text);
    assert.ok(!r.ok, 'должно отклоняться: ' + text);
    assert.match(String(r.reason), re, 'непонятная причина для ' + text + ': ' + r.reason);
  }
});

test('r111: importJson — при ошибке модель не меняется, при успехе сбрасывает историю', () => {
  const E = requireEditor();
  const m = makeModel();
  E.attach(m);
  E.editMoveWall(m, 0, 0.05);
  assert.strictEqual(E.getState().undo, 1);
  const before = JSON.stringify(m);

  const bad = E.importJson('{"walls":[{"a":[0,0]}]}');
  assert.ok(!bad.ok, 'невалидный JSON принят');
  assert.strictEqual(JSON.stringify(m), before, 'модель изменилась при невалидном импорте');
  assert.strictEqual(E.getState().undo, 1, 'история изменилась при невалидном импорте');
  assert.match(String(bad.reason), /схема|JSON/i);

  const imported = makeModel();
  imported.walls = [imported.walls[1]];
  imported.rooms = [imported.rooms[1]];
  imported.slabs = [];
  const good = E.importJson(JSON.stringify(imported));
  assert.ok(good.ok, 'валидный импорт не выполнен: ' + good.reason);
  assert.strictEqual(E.getModel(), m, 'импорт должен обновлять модель на месте (ссылка теряется)');
  assert.strictEqual(m.walls.length, 1, 'модель не заменена импортом');
  assert.strictEqual(m.walls[0].material, 'brick');
  assert.strictEqual(m.stats.wallCount, 1, 'stats импортированной модели не пересчитаны');
  assert.strictEqual(E.getState().undo, 0, 'история не сброшена при импорте');
  assert.strictEqual(E.getState().redo, 0, 'redo не сброшен при импорте');
  assert.strictEqual(E.getState().hasInitial, true, 'исходная модель импорта не запомнена для «Сбросить»');
});

// ===================== исполнение: экспорт OBJ/DXF =====================
test('r111: экспорт OBJ/DXF — строки через Scan2BIM.toOBJ/toDXF', () => {
  const E = requireEditor();
  const m = makeModel();
  const obj = E.exportEditedObj(m);
  assert.match(obj, /^# BIM-Twin Scan2BIM/, 'OBJ без заголовка');
  assert.match(obj, /^v /m, 'OBJ без вершин');
  assert.match(obj, /^f /m, 'OBJ без граней');
  assert.ok((obj.match(/^v /gm) || []).length >= 8, 'в OBJ мало вершин');

  const dxf = E.exportEditedDxf(m);
  for (const token of ['SECTION', 'ENTITIES', 'WALLS', 'OPENINGS', 'EOF']) {
    assert.ok(dxf.includes(token), 'в DXF нет ' + token);
  }
  assert.ok(dxf.includes('LINE'), 'в DXF нет линий');
  assert.ok(dxf.includes(m.walls[0].a[0].toFixed(4)), 'координаты стены не попали в DXF');

  assert.throws(() => E.exportEditedObj({ ok: false }), /модель не построена/);
  assert.throws(() => E.exportEditedDxf({ ok: false }), /модель не построена/);
  assert.ok(E.exportEditedIfc(m).includes('IFCWALLSTANDARDCASE'), 'IFC-экспорт сломан');
});

// ===================== исполнение: оверлей (режимы просмотра) =====================
test('r111: buildOverlay — «Контур» только линии, «3D-объём» плотный каркас и сетка пола', () => {
  const E = requireEditor();
  const m = makeModel();
  const contour = E.buildOverlay(m, { mode: 'contour', wall: 0, opening: 0, room: 0, supportsSolid: false });
  const volume = E.buildOverlay(m, { mode: 'volume', wall: 0, opening: 0, room: 0, supportsSolid: false });
  assert.strictEqual(contour.mode, 'contour');
  assert.strictEqual(volume.mode, 'volume');
  assert.ok(contour.segments > 0 && volume.segments > 0, 'оверлей пуст');
  assert.ok(contour.objs.every((o) => o.line === true && o.gkind === 'wire'), 'контур должен быть только из линий');
  assert.ok(contour.objs.every((o) => o.pos instanceof Float32Array), 'позиции должны быть Float32Array');
  assert.ok(volume.objs.every((o) => o.line === true && o.gkind === 'wire'), 'без мешей — только линии');
  assert.ok(volume.segments > contour.segments,
    '3D-объём должен быть плотнее контура: ' + volume.segments + ' vs ' + contour.segments);
  assert.ok(!volume.truncated, 'маленькая модель не должна упираться в бюджет');

  // потолок опционален
  const withCeil = E.buildOverlay(m, { mode: 'volume', ceiling: true, wall: 0, room: 0 });
  assert.ok(withCeil.segments > volume.segments, 'потолок не добавил сегментов');

  // пол: без помещений сетки пола нет
  const noRooms = makeModel(); noRooms.rooms = [];
  const volNoRooms = E.buildOverlay(noRooms, { mode: 'volume', wall: 0, ceiling: true });
  assert.ok(volume.segments > volNoRooms.segments, 'сетка пола по помещениям не даёт сегментов');

  // выбранная стена/помещение окрашены акцентом
  const selColor = E.overlayColors().sel;
  assert.ok(volume.objs.some((o) => o.color === selColor), 'нет акцентной подсветки выбранной стены');
  assert.ok(volume.objs.some((o) => o.color === E.overlayColors().room), 'нет подсветки выбранного помещения');
});

test('r111: buildOverlay — заливка стен solid-мешами только при поддержке вьюера', () => {
  const E = requireEditor();
  const m = makeModel();
  const lines = E.buildOverlay(m, { mode: 'volume', wall: 0, supportsSolid: false });
  assert.strictEqual(lines.solid, false, 'без поддержки мешей заливки быть не должно');
  assert.ok(lines.objs.every((o) => o.gkind === 'wire'), 'без поддержки мешей только линии');

  const solid = E.buildOverlay(m, { mode: 'volume', wall: 0, supportsSolid: true });
  assert.strictEqual(solid.solid, true, 'заливка не построена при поддержке мешей');
  const solids = solid.objs.filter((o) => o.gkind === 'solid');
  assert.ok(solids.length >= 1, 'нет solid-объектов');
  assert.ok(solid.triangles > 0, 'нет треугольников заливки');
  for (const o of solids) {
    assert.ok(o.pos instanceof Float32Array && o.nor instanceof Float32Array, 'solid без pos/nor');
    assert.strictEqual(o.pos.length % 9, 0, 'треугольники должны быть кратны 9 координатам');
    assert.strictEqual(o.nor.length, o.pos.length, 'нормалей должно быть столько же, сколько координат');
    assert.ok(o.color && o.color.length === 3, 'нет цвета заливки');
  }
  // заливка вырезает проёмы: частей стены должно быть больше одной
  assert.ok(solid.triangles / 12 >= 3, 'заливка не учитывает вырез проёма (мало боксов)');

  // в контурном режиме заливки нет даже при поддержке мешей
  const contourSolid = E.buildOverlay(m, { mode: 'contour', supportsSolid: true });
  assert.strictEqual(contourSolid.solid, false, 'в режиме «Контур» заливка не нужна');
});

test('r111: buildOverlay — бюджет ≤ 20000 сегментов, выбранная стена видна даже при упрощении', () => {
  const E = requireEditor();
  const big = makeMinimalModel();
  for (let i = 0; i < 3000; i++) {
    big.walls.push({
      a: [i % 50, Math.floor(i / 50)], b: [i % 50 + 1.2, Math.floor(i / 50)], dir: [1, 0],
      thickness: 0.15, base: 0, height: 3, material: 'concrete', openings: []
    });
  }
  const built = E.buildOverlay(big, { mode: 'volume', wall: 2999 });
  assert.strictEqual(built.segments, E.MAX_OVERLAY_SEGMENTS, 'бюджет должен быть исчерпан ровно до лимита');
  assert.ok(built.truncated, 'для тяжёлой модели должно выставляться truncated');
  assert.ok(built.segments <= 20000, 'сегментов больше лимита: ' + built.segments);
  const selColor = E.overlayColors().sel;
  assert.ok(built.objs.some((o) => o.color === selColor), 'выбранная стена пропала при упрощении');
});

test('r111: setViewMode/getViewState/setCeiling/setSolid — состояние просмотра', () => {
  const E = requireEditor();
  E.attach(makeModel());
  E.setViewMode('contour');
  assert.strictEqual(E.getViewMode(), 'contour');
  const st0 = E.getViewState();
  assert.strictEqual(st0.maxSegments, 20000);
  assert.strictEqual(st0.ceiling, false);
  assert.strictEqual(typeof st0.supportsSolid, 'boolean');

  E.setViewMode('volume');
  E.setCeiling(true);
  E.setSolid(false);
  const st1 = E.getState();
  assert.strictEqual(st1.viewMode, 'volume');
  assert.strictEqual(st1.ceiling, true);
  assert.strictEqual(st1.solid, false, 'заливка выключена — в состоянии false');
  assert.strictEqual(E.setViewMode('unknown'), 'contour', 'неизвестный режим должен откатываться в «Контур»');
  E.setCeiling(false);
  E.setSolid(true);
});

// ===================== jsdom: настоящая панель редактора =====================
// Настоящий renderer/lixel-scan2bim-editor.js исполняется в jsdom; вьюер — заглушка
// с перехватом _setOverlay; для проверки заливки — заглушка с _makeObj (как webgl-viewer).
function makeEditorEnv(opts) {
  const withSolid = !!(opts && opts.solid);
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div id="stageSideR"></div></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const log = { overlays: [], toasts: [], confirms: [] };
  const viewer = {
    base: [{ pos: new Float32Array([0, 1, 0, 4, 1, 0]) }],
    _setOverlay(objs) { log.overlays.push(objs); },
    render() { }
  };
  if (withSolid) viewer._makeObj = function (o) { return o; };
  w.__viewer = viewer;
  w.__toast = function (msg, kind) { log.toasts.push({ msg: String(msg), kind: kind }); };
  // встроенный диалог подтверждения (ui/kit.js → __lxKit.ask); нативные confirm в renderer запрещены
  w.__lxKit = {
    hydrate() { },
    ask(o) {
      log.confirms.push(String((o && (o.message || o.title)) || ''));
      return Promise.resolve(w.__confirmAnswer !== false);
    }
  };
  w.__lxScan2BIM = { open() { }, refreshPreview() { }, state: {} };
  w.Scan2BIM = S;
  w.URL.createObjectURL = function () { return 'blob:test'; };
  w.URL.revokeObjectURL = function () { };
  w.HTMLAnchorElement.prototype.click = function () { };
  w.eval(SRC);
  return { w, log, viewer, E: w.__lxS2BEditor };
}
const q = (w, sel) => w.document.querySelector(sel);
const qa = (w, sel) => Array.from(w.document.querySelectorAll(sel));
const clickEl = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const lastOverlay = (log) => log.overlays[log.overlays.length - 1] || [];
// подтверждение встроенного диалога асинхронное — даём промису __lxKit.ask разрешиться
const flush = () => new Promise((r) => setTimeout(r, 0));

test('r111: jsdom — кнопки удаления/импорта/экспорта и статус-строка в панели', { skip: !JSDOM && 'jsdom не установлен' }, () => {
  const { w, E, log } = makeEditorEnv();
  const model = makeModel();
  E.open(model);
  const panel = q(w, '#lxS2BEditorPanel');
  assert.ok(panel, 'панель не создана');
  assert.strictEqual(panel.style.display, 'block');

  // удаление
  for (const act of ['delete-wall', 'delete-room', 'op-clear', 'clear-model']) {
    assert.ok(q(w, '[data-act="' + act + '"]'), 'нет кнопки data-act=' + act);
  }
  assert.match(q(w, '[data-act="delete-wall"]').textContent, /Удалить стену/);
  assert.match(q(w, '[data-act="op-clear"]').textContent, /Удалить все проёмы/);
  assert.match(q(w, '[data-act="clear-model"]').textContent, /Очистить модель/);

  // импорт/экспорт
  assert.ok(q(w, 'input[type="file"][data-lx-edit="import-input"]'), 'нет input[type=file]');
  assert.match(q(w, 'input[data-lx-edit="import-input"]').getAttribute('accept'), /json/i);
  assert.match(q(w, '[data-act="import-json"]').textContent, /Загрузить JSON/);
  assert.match(q(w, '[data-act="export-obj"]').textContent, /OBJ/);
  assert.match(q(w, '[data-act="export-dxf"]').textContent, /DXF/);

  // статус: счётчики и подсказки
  const statusbar = q(w, '[data-lx-edit="statusbar"]').textContent;
  assert.match(statusbar, /Стены 2/);
  assert.match(statusbar, /Проёмы 2/);
  assert.match(statusbar, /Помещения 2/);
  assert.match(statusbar, /Площадь 10\.4/);
  assert.match(statusbar, /Ctrl\+Z/);
  assert.match(statusbar, /Delete/);

  // режимы просмотра: кнопки и aria-pressed
  const vm = qa(w, '[data-act="view-mode"]');
  assert.strictEqual(vm.length, 2, 'ожидались две кнопки режима');
  assert.ok(vm.some((b) => b.getAttribute('data-mode') === 'volume' && /3D-объём/.test(b.textContent)));
  assert.ok(vm.some((b) => b.getAttribute('data-mode') === 'contour' && /Контур/.test(b.textContent) && b.getAttribute('aria-pressed') === 'true'));
  assert.ok(q(w, '[data-act="toggle-ceiling"]'), 'нет кнопки «Потолок»');
  assert.ok(!q(w, '[data-act="toggle-fill"]'), 'без поддержки мешей кнопки заливки быть не должно');
  assert.ok(log.overlays.length > 0, 'оверлей не обновлялся при открытии');
});

test('r111: jsdom — переключение «Контур»/«3D-объём» меняет оверлей и сегменты', { skip: !JSDOM && 'jsdom не установлен' }, () => {
  const { w, E, log } = makeEditorEnv();
  E.open(makeModel());
  const contourObjs = lastOverlay(log);
  assert.ok(contourObjs.every((o) => o.line === true && o.gkind === 'wire'), 'контур должен быть линиями');
  const contourSegs = E.getState().overlaySegments;
  assert.ok(contourSegs > 0, 'контур не дал сегментов');

  const volumeBtn = qa(w, '[data-act="view-mode"]').find((b) => b.getAttribute('data-mode') === 'volume');
  clickEl(w, volumeBtn);
  assert.strictEqual(E.getViewMode(), 'volume');
  const volumeObjs = lastOverlay(log);
  assert.ok(volumeObjs.every((o) => o.line === true && o.gkind === 'wire'), 'без мешей — только линии');
  assert.ok(E.getState().overlaySegments > contourSegs, '3D-объём не плотнее контура');
  assert.strictEqual(qa(w, '[data-act="view-mode"][data-mode="volume"]')[0].getAttribute('aria-pressed'), 'true');

  // потолок
  const segsBeforeCeil = E.getState().overlaySegments;
  clickEl(w, q(w, '[data-act="toggle-ceiling"]'));
  assert.strictEqual(E.getState().ceiling, true);
  assert.ok(E.getState().overlaySegments > segsBeforeCeil, 'потолок не добавил сегментов');

  // обратно в контур
  clickEl(w, qa(w, '[data-act="view-mode"]').find((b) => b.getAttribute('data-mode') === 'contour'));
  assert.strictEqual(E.getViewMode(), 'contour');
  assert.ok(lastOverlay(log).every((o) => o.line === true), 'в контуре остались нелинейные объекты');
});

test('r111: jsdom — заливка стен при поддержке мешей вьюером', { skip: !JSDOM && 'jsdom не установлен' }, () => {
  const { w, E, log } = makeEditorEnv({ solid: true });
  E.open(makeModel());
  assert.ok(q(w, '[data-act="toggle-fill"]'), 'вьюер с мешами — должна быть кнопка «Заливка»');
  clickEl(w, qa(w, '[data-act="view-mode"]').find((b) => b.getAttribute('data-mode') === 'volume'));
  const withFills = lastOverlay(log).filter((o) => o.gkind === 'solid');
  assert.ok(withFills.length >= 1, 'нет solid-заливки в 3D-объёме');
  assert.ok(withFills.every((o) => o.pos.length % 9 === 0 && o.nor.length === o.pos.length), 'битые треугольники заливки');

  clickEl(w, q(w, '[data-act="toggle-fill"]'));
  assert.strictEqual(E.getState().solid, false);
  assert.strictEqual(lastOverlay(log).filter((o) => o.gkind === 'solid').length, 0, 'заливка не выключилась');
});

test('r111: jsdom — кнопки удаления меняют счётчики, отказ в диалоге отменяет, Delete удаляет', { skip: !JSDOM && 'jsdom не установлен' }, async () => {
  const { w, E, log } = makeEditorEnv();
  const model = makeModel();
  E.open(model);

  // удаление стены с подтверждением
  w.__confirmAnswer = true;
  clickEl(w, q(w, '[data-act="delete-wall"]'));
  await flush();
  assert.strictEqual(model.walls.length, 1, 'кнопка не удалила стену');
  assert.strictEqual(model.stats.wallCount, 1, 'счётчики не обновились');
  assert.strictEqual(model.stats.openingCount, 1, 'счётчик проёмов не обновился');
  assert.strictEqual(E.getState().undo, 1, 'удаление не попало в историю');
  assert.match(log.confirms[log.confirms.length - 1], /Удалить стену 1/);
  assert.match(q(w, '[data-lx-edit="statusbar"]').textContent, /Стены 1/, 'статус-строка не обновилась');

  // отмена удаления
  w.__confirmAnswer = false;
  const wallsBefore = model.walls.length;
  clickEl(w, q(w, '[data-act="delete-wall"]'));
  await flush();
  assert.strictEqual(model.walls.length, wallsBefore, 'отказ от подтверждения не должен менять модель');
  assert.match(q(w, '[data-lx-edit="status"]').textContent, /отменено/);

  // клавиша Delete удаляет выбранную стену
  w.__confirmAnswer = true;
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  await flush();
  assert.strictEqual(model.walls.length, 0, 'клавиша Delete не удалила стену');
  assert.ok(E.getState().undo >= 2);
  assert.ok(E.undo(), 'undo после Delete не сработал');
  assert.strictEqual(model.walls.length, 1, 'undo не вернул стену');

  // удаление помещения: сначала выбор строки, затем кнопка
  const roomRows = qa(w, '[data-lx-edit="rooms"] [data-room-index]');
  assert.strictEqual(roomRows.length, 2, 'нет строк помещений');
  clickEl(w, roomRows[0]);
  assert.strictEqual(E.getState().room, 0);
  assert.strictEqual(q(w, '[data-act="delete-room"]').disabled, false, 'кнопка удаления помещения должна включиться после выбора');
  clickEl(w, q(w, '[data-act="delete-room"]'));
  await flush();
  assert.strictEqual(model.rooms.length, 1, 'помещение не удалено');
  assert.strictEqual(model.stats.roomCount, 1);
  assert.match(log.confirms[log.confirms.length - 1], /Удалить помещение 1/);

  // все проёмы выбранной стены
  const openBefore = model.walls[0].openings.length;
  clickEl(w, q(w, '[data-act="op-clear"]'));
  await flush();
  assert.strictEqual(model.walls[0].openings.length, 0, 'проёмы не удалены');
  assert.ok(openBefore >= 1);

  // «Очистить модель» — без диалога, отменяется undo
  const confirmsBefore = log.confirms.length;
  clickEl(w, q(w, '[data-act="clear-model"]'));
  assert.strictEqual(model.walls.length, 0, 'очистка модели не сработала');
  assert.strictEqual(log.confirms.length, confirmsBefore, '«Очистить» не должна спрашивать подтверждение');
  assert.ok(E.undo(), 'undo очистки не сработал');
  assert.strictEqual(model.walls.length, 1, 'undo не вернул модель после очистки');
});

test('r111: jsdom — невалидный JSON из API не меняет модель, файл-импорт загружает валидный', { skip: !JSDOM && 'jsdom не установлен' }, async () => {
  const { w, E, log } = makeEditorEnv();
  const model = makeModel();
  E.open(model);
  const before = JSON.stringify(model);

  // «Загрузить JSON» открывает input[type=file]
  let inputClicks = 0;
  const input0 = q(w, 'input[data-lx-edit="import-input"]');
  input0.addEventListener('click', () => { inputClicks++; });
  clickEl(w, q(w, '[data-act="import-json"]'));
  assert.strictEqual(inputClicks, 1, 'кнопка импорта не открыла выбор файла');

  // невалидный JSON — понятное сообщение, модель не меняется
  const bad = E.importJson('{"walls":[{"a":[0,0]}]}');
  assert.ok(!bad.ok, 'невалидный JSON принят');
  assert.strictEqual(JSON.stringify(model), before, 'модель изменилась при невалидном импорте');
  const status = q(w, '[data-lx-edit="status"]').textContent;
  assert.match(status, /Импорт отклонён/);
  assert.match(status, /модель не изменена/);

  // валидный JSON через настоящий input[type=file] (FileReader)
  const fileModel = makeModel();
  fileModel.walls = [fileModel.walls[1]];
  fileModel.rooms = [fileModel.rooms[1]];
  fileModel.stats.wallCount = 1;
  const input = q(w, 'input[data-lx-edit="import-input"]');
  const file = new w.File([JSON.stringify(fileModel)], 'scan2bim-edited.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new w.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(model.walls.length, 1, 'импорт из файла не применил модель');
  assert.strictEqual(model.stats.wallCount, 1, 'статистика импорта не пересчитана');
  assert.strictEqual(E.getState().undo, 0, 'история не сброшена импортом');
  assert.strictEqual(qa(w, '[data-lx-edit="walls"] [data-wall-index]').length, 1, 'панель не перерисована после импорта');
  assert.ok(log.toasts.length > 0, 'импорт не сообщил результат');
});

test('r111: jsdom — кнопки «Экспорт OBJ/DXF» вызывают download и не падают', { skip: !JSDOM && 'jsdom не установлен' }, () => {
  const { w, E, log } = makeEditorEnv();
  E.open(makeModel());
  const before = log.toasts.length;
  clickEl(w, q(w, '[data-act="export-obj"]'));
  clickEl(w, q(w, '[data-act="export-dxf"]'));
  const msgs = log.toasts.slice(before).map((t) => t.msg).join(' | ');
  assert.match(msgs, /OBJ/);
  assert.match(msgs, /DXF/);
  assert.ok(!log.toasts.slice(before).some((t) => /не удался/.test(t.msg) && t.kind === 'error'),
    'экспорт OBJ/DXF сообщил об ошибке: ' + msgs);
});

test('r111: jsdom — «нет модели»: подсказка и импорт JSON доступны без построения', { skip: !JSDOM && 'jsdom не установлен' }, () => {
  const { w, E } = makeEditorEnv();
  E.open(null);
  assert.ok(q(w, '[data-lx-edit="hint"]'), 'нет подсказки «модель не построена»');
  assert.ok(q(w, '[data-act="import-json"]'), 'импорт должен быть доступен без модели');
  assert.ok(q(w, 'input[type="file"][data-lx-edit="import-input"]'), 'нет input[type=file] без модели');
  assert.strictEqual(qa(w, '[data-wall-index]').length, 0, 'без модели не должно быть списка стен');
  assert.match(q(w, '[data-lx-edit="statusbar"]').textContent, /Ctrl\+Z/);

  // импорт модели без предварительного построения
  const res = E.importJson(JSON.stringify(makeModel()));
  assert.ok(res.ok, 'импорт без модели не выполнен: ' + res.reason);
  assert.strictEqual(qa(w, '[data-lx-edit="walls"] [data-wall-index]').length, 2, 'стены импортированной модели не показаны');
  assert.strictEqual(E.getState().hasModel, true);
});
