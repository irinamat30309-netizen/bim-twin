'use strict';
// Ревизия 13: облако открывается ЦЕЛИКОМ в обычном режиме (без автоматического «Потокового LOD»), при движении срезается лишь часть.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('main: без явной просьбы потоковый режим/предпросмотр не включается; нехватка памяти — вопрос, а не молчаливое урезание', () => {
  const m = read('main.js');
  const i = m.indexOf("ipcMain.handle('bim:parseCloud'"), j = m.indexOf("ipcMain.handle('bim:readCloudChunk'");
  const h = m.slice(i, j);
  assert.match(h, /const wantStream = !!\(payload && typeof payload === 'object' && payload\.preview === true\)/);
  assert.match(h, /if \(streamable && wantStream\)/, 'предпросмотр только по явной просьбе окна');
  assert.ok(!/STREAM_FIRST_POINTS/.test(h) && !/streamFirst/.test(h), 'порог «большой файл → предпросмотр» удалён');
  assert.match(h, /tooBig: true, streamable: true/);
  assert.match(h, /pointShare = 1/);
});

test('окно: parseCloud сначала без потока; поток и «часть точек» — только после согласия в диалоге', () => {
  const a = read('renderer/app.js');
  assert.match(a, /parseCloudWithProgressOnce\(filePath, label, \{ stream: false, allowReduced: false \}\)/);
  assert.match(a, /Открыть все точки \(потоковый режим\)/);
  assert.match(a, /preview: !!mode\.stream, allowReduced: allowReduced/);
  assert.ok(!/preview: true/.test(a.slice(a.indexOf('async function parseCloudWithProgressOnce'), a.indexOf('async function parseCloudWithProgressOnce') + 2500)));
});

test('вьюер: предел одного буфера 170 млн (102 млн точек больше не прореживаются вдвое), порционная загрузка, цвет 3 байта', () => {
  const w = read('renderer/webgl-viewer.js');
  assert.match(w, /this\._maxSingleBuffer = 170000000/);
  assert.match(w, /_bigBufferData\(data\)/); assert.match(w, /gl\.bufferSubData\(T, i \* data\.BYTES_PER_ELEMENT/);
  assert.match(w, /_bigColorBuffer\(col\)/); assert.match(w, /u8 \? gl\.UNSIGNED_BYTE : gl\.FLOAT, !!u8/);
});

test('вьюер: при движении — выбранный процент или авто (не меньше 2 %), замер скорости и в покое', () => {
  const w = read('renderer/webgl-viewer.js');
  assert.match(w, /this\._octMovePct > 0 \? Math\.max\(100000, Math\.round\(o\.count \* this\._octMovePct \/ 100\)\)/);
  assert.match(w, /Math\.max\(want, total \* 0\.02\)/);
  assert.match(w, /idleProbe/);
  assert.match(w, /this\._probeDrawn = 0; this\._probeTotal = 0;/, 'суммарное число точек кадра не копится между кадрами');
  const { Viewer3DGL } = (() => { globalThis.window = { dispatchEvent() {} }; return require('../renderer/webgl-viewer.js'); })();
  const v = Object.create(Viewer3DGL.prototype); v._perfProfile = 'balanced';
  v._adaptInter(100, 10000000, 100000000);               // 100 мс на 10 млн: видеокарта тянет ≈1,6 млн за 16 мс
  assert.ok(v._interPts >= 2000000 && v._interPts <= 2100000, 'не ниже 2 % облака: ' + v._interPts);
  const v2 = Object.create(Viewer3DGL.prototype); v2._perfProfile = 'balanced';
  v2._adaptInter(4, 10000000, 10000000);                 // быстро — всё облако
  assert.equal(v2.interactivePointBudget(10000000), 10000000);
});

test('«При движении» видна всегда и в обычном режиме (75/50/25/10/5/2 %)', () => {
  const h = read('renderer/index.html'), a = read('renderer/app.js');
  assert.ok(/<label class="q-row q-stream" title=/.test(h) && !/q-stream" hidden/.test(h));
  assert.match(a, /\['75', '75 % точек'\]/);
  assert.match(a, /addEventListener\('lx-cloud-loaded', apply\)/);
});
