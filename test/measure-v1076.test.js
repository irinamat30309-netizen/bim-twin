const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = p => fs.readFileSync(path.join(__dirname, '..', 'renderer', p), 'utf8');
const HTML = read('index.html');
const CSS = read('styles.css');
const APP = read('app.js');

// —— панель инструментов = отдельный блок с группами ——
test('index.html: measureBar — отдельный блок mtoolbox с заголовком', () => {
  assert.ok(HTML.includes('id="measureBar" class="measure mtoolbox"'), 'measureBar не mtoolbox');
  assert.ok(HTML.includes('class="mtoolbox-head"'), 'нет заголовка панели');
});

test('index.html: 4 группы с подписями mglabel', () => {
  const groups = (HTML.match(/class="mgroup"/g) || []).length;
  assert.ok(groups >= 4, 'ожидалось ≥ 4 групп, найдено ' + groups);
  const labels = (HTML.match(/class="mglabel"/g) || []).length;
  assert.ok(labels >= 4, 'ожидалось ≥ 4 подписей, найдено ' + labels);
  for (const g of ['Геометрия', 'Математика плоскостей', 'Привязка', 'Управление']) {
    assert.ok(HTML.includes(g), 'нет группы: ' + g);
  }
});

test('index.html: все 15 кнопок измерения на месте внутри панели', () => {
  for (const id of ['mmDistance', 'mmPoint', 'mmPolyline', 'mmAngle', 'mmArea', 'mmPlane', 'mmDeviation', 'mmCorner', 'mmSnap', 'mmSave', 'mmList', 'mmCsv', 'mmNotion', 'mmFinish', 'mmClear']) {
    assert.ok(HTML.includes('id="' + id + '"'), 'нет кнопки ' + id);
  }
});

test('index.html: баланс <div> внутри measureBar', () => {
  const start = HTML.indexOf('id="measureBar"');
  const end = HTML.indexOf('id="measureListPanel"');
  const block = HTML.slice(start, end);
  const opens = (block.match(/<div/g) || []).length;
  const closes = (block.match(/<\/div>/g) || []).length;
  assert.strictEqual(opens, closes, 'небаланс div: ' + opens + ' вс ' + closes);
});

test('styles.css: стили панели mtoolbox/mgroup/mglabel', () => {
  assert.ok(CSS.includes('.mtoolbox'), 'нет .mtoolbox');
  assert.ok(CSS.includes('.mgroup'), 'нет .mgroup');
  assert.ok(CSS.includes('.mglabel'), 'нет .mglabel');
});

test('app.js: выбор режимов через #measureBar [data-mm] (работает с вложенными группами)', () => {
  assert.ok(APP.includes("querySelectorAll('#measureBar [data-mm]')"), 'селектор режимов изменён');
});
