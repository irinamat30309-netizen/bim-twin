'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const SS = require(path.join(R, 'lixel-smart-save.js'));
const UI = fs.readFileSync(path.join(R, 'lixel-smart-save.js'), 'utf8');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(R, 'app.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

function cloud() {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1]);
  const col = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]);
  return { pos, col };
}

test('реестр форматов покрывает все наши форматы', () => {
  const ids = SS.FORMATS.map((f) => f.id);
  ['ply', 'las', 'xyz', 'pts', 'pcd', 'csv', 'obj', 'bim-ifc', 'bim-obj', 'bim-dxf'].forEach((id) => {
    assert.ok(ids.includes(id), 'нет формата ' + id);
  });
  SS.FORMATS.forEach((f) => { assert.ok(f.ext && f.label && (f.kind === 'cloud' || f.kind === 'bim'), 'неполный формат ' + f.id); });
});

test('toPTSText: первая строка — количество, далее координаты+цвет', () => {
  const txt = SS.toPTSText(cloud());
  const lines = txt.trim().split('\n');
  assert.strictEqual(lines[0], '4', 'первая строка не число точек');
  assert.strictEqual(lines.length, 5, 'неверное число строк');
  assert.strictEqual(lines[1].split(' ').length, 7, 'строка не x y z i r g b');
});

test('toPCDText: валидный ASCII PCD заголовок', () => {
  const txt = SS.toPCDText(cloud());
  assert.ok(txt.includes('VERSION 0.7'), 'нет версии');
  assert.ok(txt.includes('FIELDS x y z rgb'), 'нет полей');
  assert.ok(txt.includes('POINTS 4'), 'неверное число точек');
  assert.ok(txt.includes('DATA ascii'), 'нет DATA ascii');
});

test('toCSVText: named columns, metadata comments and per-point fields', () => {
  const c = cloud();
  c.intensity = new Float32Array([0, 0.25, 0.5, 1]);
  c.classification = new Uint8Array([2, 5, 42, 255]);
  c.meta = { srcXform: { axis: 'zup' }, units: 'm', crsWkt: 'PROJCRS["test"]' };
  const text = SS.toCSVText(c);
  assert.match(text, /^# BIM_TWIN_UP=z$/m);
  assert.match(text, /^# BIM_TWIN_UNITS=m$/m);
  assert.match(text, /^# BIM_TWIN_CRS_WKT_URI=/m);
  assert.match(text, /^x,y,z,intensity,red,green,blue,classification$/m);
  assert.match(text, /0,0,0,0,255,0,0,2/);
});

test('cloudToOBJ: генерирует вершины', () => {
  const txt = SS.cloudToOBJ(cloud());
  const vs = txt.split('\n').filter((l) => l.startsWith('v '));
  assert.strictEqual(vs.length, 4, 'неверное число вершин');
});

test('colScale255: различает float и uchar цвет', () => {
  assert.strictEqual(SS.colScale255(new Float32Array([1, 0, 0.5])), false);
  assert.strictEqual(SS.colScale255(new Float32Array([255, 0, 128])), true);
});

test('UI: публичный API и ключевые хуки', () => {
  assert.ok(UI.includes('window.__lxSmartSave'), 'нет публичного API');
  assert.ok(UI.includes('saveCloudToPath'), 'нет тихого сохранения');
  assert.ok(UI.includes('A.exportFile('), 'нет экспорта');
  assert.ok(UI.includes('onDoSaveThenClose'), 'нет обработки закрытия');
  assert.ok(UI.includes('A.setDirty(') || UI.includes('.setDirty('), 'не сообщает dirty');
  assert.ok(UI.includes("'lxSmartSaveMin'") || UI.includes('LS_MIN'), 'нет настройки интервала');
  assert.ok(UI.includes('armTimer'), 'нет таймера авто-сохранения');
  assert.ok(UI.includes("k === 's'"), 'нет Ctrl+S');
  assert.ok(UI.includes('__pcAutosave') && UI.includes('as.onEdit'), 'не перехватывает правки');
});

test('main.js: IPC умного сохранения и вопрос при закрытии', () => {
  assert.ok(MAIN.includes("ipcMain.handle('bim:exportFile'"), 'нет exportFile');
  assert.ok(MAIN.includes("ipcMain.handle('bim:saveCloudToPath'"), 'нет saveCloudToPath');
  assert.ok(MAIN.includes("ipcMain.on('bim:setDirty'"), 'нет setDirty');
  assert.ok(MAIN.includes("ipcMain.on('bim:closeConfirmed'"), 'нет closeConfirmed');
  assert.ok(MAIN.includes("win.on('close'"), 'нет обработчика закрытия');
  assert.ok(MAIN.includes('showMessageBoxSync'), 'нет диалога вопроса');
  assert.ok(MAIN.includes('doSaveThenClose'), 'нет сохранить-и-закрыть');
});

test('preload.js: мосты умного сохранения', () => {
  ['exportFile', 'saveCloudToPath', 'setDirty', 'closeConfirmed', 'onDoSaveThenClose'].forEach((k) => {
    assert.ok(PRELOAD.includes(k + ':'), 'нет моста ' + k);
  });
});

test('регистрация и версия v1156', () => {
  assert.ok(HTML.includes('lixel-smart-save.js?v=1226'), 'модуль не подключён');
  assert.ok(APP.includes('готова · v1160'), 'баннер не v1156');
});
