'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const INS = fs.readFileSync(path.join(R, 'lixel-object-inspector.js'), 'utf8');
const EXT = fs.readFileSync(path.join(R, 'lixel-object-extract.js'), 'utf8');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(R, 'app.js'), 'utf8');
const Measure = require(path.join(R, 'measure.js'));

// v1154: CHCNAV CoProcess-подобный «Инспектор объекта»: отдельное окно со своим 3D-вьюером.

test('inspector: отдельный экземпляр Viewer3DGL в своём канвасе', () => {
  assert.ok(INS.includes('window.Viewer3DGL.isSupported'), 'нет проверки поддержки WebGL2');
  assert.ok(INS.includes('new window.Viewer3DGL('), 'не создаёт второй вьюер');
  assert.ok(INS.includes("id = 'lxInsCanvas'") || INS.includes("'lxInsCanvas'"), 'нет собственного canvas инспектора');
  assert.ok(INS.includes('loadCloud('), 'не загружает облако объекта');
});

test('inspector: измерение работает в окне (режимы + onMeasure + чтение)', () => {
  for (const s of ['setMeasureMode(', 'setMeasure(', 'finishMeasure(', 'onMeasure', 'measureValueText']) {
    assert.ok(INS.includes(s), 'нет вызова ' + s);
  }
  for (const m of ['distance', 'plane', 'angle', 'area', 'polyline', 'point', 'deviation', 'corner']) {
    assert.ok(INS.includes("'" + m + "'"), 'нет режима измерения ' + m);
  }
});

test('inspector: видовые ракурсы (со стороны / сверху / спереди)', () => {
  for (const p of ['reset', 'front', 'side', 'top']) {
    assert.ok(INS.includes("'" + p + "'"), 'нет ракурса ' + p);
  }
  assert.ok(INS.includes('resetView('), 'нет кадрирования объекта');
});

test('inspector: выделение объекта кликом по облаку (smart pick)', () => {
  for (const s of ['smartObjectAt(', 'extractSelectionAsObject(', 'getExtractedObjectCloud(']) {
    assert.ok(INS.includes(s), 'нет вызова ' + s);
  }
  assert.ok(INS.includes("id = 'lxObjInspectBtn'"), 'нет кнопки запуска');
  assert.ok(INS.includes('__lxObjectInspector'), 'нет публичного API');
  assert.ok(/openWithCloud\s*:/.test(INS) && INS.includes('function openWithCloud('), 'нет openWithCloud');
});

test('inspector: недеструктивен — не трогает активное облако основного вьюера', () => {
  // инспектор загружает только в свой iv, не в mainV
  assert.ok(!/mainV\(\)[^;]*\.loadCloud\(/.test(INS), 'инспектор не должен менять активное облако');
});

test('extract: в списке объектов есть кнопка «измерить в инспекторе»', () => {
  assert.ok(EXT.includes('__lxObjectInspector'), 'список не открывает инспектор');
  assert.ok(EXT.includes('bMeas'), 'нет кнопки измерения в строке');
});

test('регистрация и версии v1154', () => {
  assert.ok(HTML.includes('lixel-object-inspector.js?v=1154'), 'инспектор не подключён в index.html');
  assert.ok(HTML.includes('lixel-object-extract.js?v=1218'), 'object-extract не обновлён');
  assert.ok(APP.includes('готова · v1160'), 'баннер не v1155');
});

test('measure: measureValueText форматирует результат для чтения в инспекторе', () => {
  assert.ok(typeof Measure.measureValueText === 'function', 'measureValueText не экспортирован');
  const d = Measure.distance([0, 0, 0], [3, 0, 4]);
  const txt = Measure.measureValueText({ mode: 'distance', d3: d.d3, horizontal: d.horizontal, vertical: d.vertical });
  assert.ok(/5\.0/.test(txt) || txt.includes('5'), 'текст расстояния некорректен: ' + txt);
});
