'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const SRC = fs.readFileSync(path.join(R, 'scan2bim-ai-client.js'), 'utf8');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');

test('AI-client: подключён в index.html', () => {
  assert.ok(HTML.includes('scan2bim-ai-client.js?v=1220'), 'клиент не подключён в index.html');
});

test('AI-client: ключевые элементы присутствуют', () => {
  assert.ok(SRC.includes('__lxScan2BIMAI'), 'нет публичного API');
  assert.ok(SRC.includes('s2bAiServerUrl'), 'нет ключа localStorage для URL сервера');
  assert.ok(SRC.includes('/health'), 'нет проверки /health');
  assert.ok(SRC.includes('binary_little_endian'), 'PLY не бинарный LE');
  assert.ok(SRC.includes("id = 'lxScan2BimAiBtn'"), 'нет кнопки AI');
  // v1170: единый режим «1:1» — отправка на сервер (/reconstruct, FormData) убрана, строим встроенным движком.
  assert.ok(SRC.includes('buildLocal'), 'нет офлайн-построения buildLocal');
});

test('AI-client v1161: офлайн-фолбэк на встроенный движок Scan2BIM', () => {
  // Клиент должен уметь строить BIM без сервера, через window.Scan2BIM.
  assert.ok(SRC.includes('buildLocal'), 'нет офлайн-функции buildLocal');
  assert.ok(SRC.includes('window.Scan2BIM'), 'не использует встроенный движок Scan2BIM');
  assert.ok(SRC.includes('.reconstruct('), 'не вызывает Scan2BIM.reconstruct');
  // v1170: единый режим «1:1» — главная кнопка всегда строит офлайн-движком (без селектора режимов).
  assert.ok(/function reconstruct\(\)[\s\S]*?buildLocal\(pts, v\); return;/.test(SRC), 'reconstruct не строит офлайн напрямую');
  assert.ok(SRC.includes('modeSel = null'), 'селектор режимов не убран');
  // экспорт офлайн-модели тоже доступен (IFC/OBJ/DXF из движка).
  assert.ok(SRC.includes('Scan2BIM.toIFC') && SRC.includes('Scan2BIM.toOBJ') && SRC.includes('Scan2BIM.toDXF'), 'нет экспорта офлайн-модели');
  assert.ok(SRC.includes('v1170'), 'версия не поднята до v1170');
});

test('AI-client: buildPLY даёт корректный бинарный PLY', () => {
  // Минимальный DOM-шим, чтобы выполнить IIFE в Node.
  const store = {};
  const fakeEl = () => ({ style: {}, appendChild() {}, addEventListener() {}, setAttribute() {}, set onclick(_) {}, get onclick() { return null; }, set id(_) {}, set type(_) {}, set value(_) {}, set textContent(_) {}, set innerHTML(_) {} });
  global.window = global;
  global.document = {
    readyState: 'complete',
    body: { appendChild() {} },
    createElement: fakeEl,
    getElementById: () => null,
    addEventListener() {},
  };
  global.addEventListener = () => {};
  global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };

  delete require.cache[require.resolve(path.join(R, 'scan2bim-ai-client.js'))];
  require(path.join(R, 'scan2bim-ai-client.js'));
  const api = global.window.__lxScan2BIMAI;
  assert.ok(api && typeof api.buildPLY === 'function', 'нет buildPLY в API');

  const xyz = new Float32Array([0, 0, 0, 1, 2, 3]); // 2 точки
  const blob = api.buildPLY(xyz);
  const header = 'ply\nformat binary_little_endian 1.0\ncomment BIM Twin AI client export\n' +
    'element vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n';
  const headerLen = new TextEncoder().encode(header).length;
  assert.strictEqual(blob.size, headerLen + 2 * 12, 'размер PLY-блоба неверен: ' + blob.size);

  // Дефолтный URL сервера
  assert.strictEqual(api.getServer(), 'http://localhost:8765', 'неверный URL по умолчанию');
  api.setServer('http://192.168.1.50:8765');
  assert.strictEqual(api.getServer(), 'http://192.168.1.50:8765', 'setServer не сохранил URL');
});
