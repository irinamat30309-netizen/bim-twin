'use strict';
// Phase 1 (v1149) регресс: обрезка без защит, авто-сохранение, счётчик процентов.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', 'renderer');
const PCEdit = require(path.join(R, 'pointcloud-edit.js'));

test('toPLYBinaryAsync экспортирует валидный бинарный PLY и зовёт onProgress до 1', async () => {
  const n = 5000;
  const pos = new Float32Array(n * 3);
  const col = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { pos[i*3]=i*0.01; pos[i*3+1]=-i*0.02; pos[i*3+2]=i*0.03; col[i*3]=i&255; col[i*3+1]=(i*2)&255; col[i*3+2]=(i*3)&255; }
  assert.strictEqual(typeof PCEdit.toPLYBinaryAsync, 'function', 'toPLYBinaryAsync должен экспортироваться');
  let last = 0, calls = 0;
  const out = await PCEdit.toPLYBinaryAsync({ pos, col }, f => { calls++; assert.ok(f >= last - 1e-9, 'прогресс не убывает'); last = f; });
  assert.ok(out instanceof Uint8Array && out.length > 0, 'возвращает Uint8Array');
  assert.ok(calls > 0, 'onProgress вызывался');
  assert.ok(Math.abs(last - 1) < 1e-6, 'прогресс доходит до 100%');
  const head = Buffer.from(out.slice(0, 200)).toString('binary');
  assert.ok(head.startsWith('ply'), 'PLY-заголовок');
  assert.ok(/element vertex 5000/.test(head), 'кол-во точек в заголовке');
  assert.ok(/format binary_little_endian/.test(head), 'бинарный little-endian');
});

test('toPLYBinaryAsync и toPLYBinary дают идентичные байты', async () => {
  const n = 777;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) pos[i] = Math.sin(i) * 3.14;
  const a = PCEdit.toPLYBinary({ pos, col: null });
  const b = await PCEdit.toPLYBinaryAsync({ pos, col: null }, null);
  assert.strictEqual(a.length, b.length, 'одинаковая длина');
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { assert.fail('расхождение байт на ' + i); }
});

test('webgl-viewer: deleteSelectionForce отключает защиту и латание дыр', () => {
  const src = fs.readFileSync(path.join(R, 'webgl-viewer.js'), 'utf8');
  assert.ok(/deleteSelectionForce\s*\(\s*\)\s*\{/.test(src), 'метод deleteSelectionForce есть');
  const m = src.match(/deleteSelectionForce\s*\(\)\s*\{[\s\S]*?\n    \}/);
  assert.ok(m, 'тело метода найдено');
  assert.ok(/_planeProtect = false/.test(m[0]) && /_holeFill = false/.test(m[0]), 'отключает защиту и латание');
  assert.ok(/_applyEdit\(false\)/.test(m[0]), 'вызывает удаление');
  assert.ok(/finally/.test(m[0]) && /wasProtect/.test(m[0]), 'восстанавливает прежние флаги');
});

test('main.js: реализованы IPC-обработчики авто-сохранения', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  for (const h of ['bim:autosaveCloud', 'bim:autosaveLoad', 'bim:autosaveClear']) {
    assert.ok(src.includes("ipcMain.handle('" + h + "'"), 'есть обработчик ' + h);
  }
  assert.ok(/new CloudAutosaveStore/.test(src), 'автосохранение использует отдельный versioned store');
  assert.ok(/autosave-clouds/.test(src), 'каталог черновиков в userData');
  const autosave = fs.readFileSync(path.join(__dirname, '..', 'db', 'cloud-autosave.js'), 'utf8');
  assert.ok(/atomicWriteFileSync\(file, bytes/.test(autosave), 'снимок записывается атомарно и отдельно от manifest');
  assert.ok(/_writeManifest\(key, next\)/.test(autosave), 'указатель версии фиксируется после durable-снимка');
});

test('app.js: авто-сохранение, save-on-exit, восстановление и % прогресс', () => {
  const src = fs.readFileSync(path.join(R, 'app.js'), 'utf8');
  assert.ok(/window\.__pcAutosave\s*=/.test(src), 'экспонирован __pcAutosave');
  assert.ok(/API\.autosaveCloud\(/.test(src), 'вызов autosaveCloud');
  assert.ok(/beforeunload/.test(src), 'сохранение перед выходом');
  assert.ok(/offerRecovery/.test(src), 'восстановление черновика');
  assert.ok(/stop\.set\s*=\s*\(frac, lab\)/.test(src), 'beginProgress поддерживает проценты');
  assert.ok(/geomBarFill/.test(src) && /geomPct/.test(src), 'есть полоса и счётчик процентов');
  assert.ok(/edBtn\('edForceDelete'/.test(src), 'кнопка обрезки без защит подключена');
  assert.ok(/deleteSelectionForce\(\)/.test(src), 'вызов принудительного удаления');
  assert.ok(/toPLYBinaryAsync/.test(src), 'сохранение использует асинхронный экспорт с прогрессом');
});

test('index.html: кнопка «Обрезка без защит» и версии 1149', () => {
  const src = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
  assert.ok(/id="edForceDelete"/.test(src), 'кнопка edForceDelete в панели');
  // версии не замораживаем — проверяем лишь, что скрипты подключены с актуальной (≥1149) версией
  function verAtLeast(name, min) { var m = new RegExp(name.replace('.', '\\.') + '\\?v=(\\d+)').exec(src); assert.ok(m, name + ' подключён'); assert.ok(parseInt(m[1], 10) >= min, name + ' версия ≥' + min + ', есть ' + m[1]); }
  verAtLeast('app.js', 1149);
  verAtLeast('webgl-viewer.js', 1149);
  verAtLeast('pointcloud-edit.js', 1149);
});

test('preload.js: авто-сохранение проброшено в renderer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  for (const k of ['autosaveCloud', 'autosaveLoad', 'autosaveClear']) assert.ok(src.includes(k), 'preload: ' + k);
});
