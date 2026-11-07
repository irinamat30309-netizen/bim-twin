'use strict';
// Ревизия 57: два исправления по отчёту пользователя.
//  1) «загрузил новое облако — открылось прошлое»: фоновое восстановление облака проекта больше не применяется,
//     если пользователь успел сделать свой импорт (номер импорта), а новое облако сохраняется активным в проекте.
//  2) «пусть предлагает выбрать папку, где будет храниться проект»: при первой загрузке у проекта без папки
//     приложение спрашивает и запоминает папку (облака, LAS, индексы, отчёты — туда).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('r57: импорт пользователя отменяет восстановление облака проекта', () => {
  const app = read('renderer/app.js');
  assert.match(app, /window\.__bimImportSerial = \(Number\(window\.__bimImportSerial\) \|\| 0\) \+ 1;/, 'номер импорта растёт');
  assert.match(app, /window\.__bimOpenCloudPath = async function[\s\S]{0,400}?__bimImportSerial/, 'в открытии облака');
  const mc = read('renderer/multicloud.js');
  assert.match(mc, /var importSerial = Number\(window\.__bimImportSerial\) \|\| 0;/, 'номер запоминается в начале восстановления');
  assert.match(mc, /&& \(Number\(window\.__bimImportSerial\) \|\| 0\) === importSerial/, 'и проверяется перед применением');
  assert.match(app, /window\.MultiCloud\.syncFromViewer\(String\(p\)\.split\(\/\[\\\\\/\]\/\)\.pop\(\), p\)/, 'новое облако становится активным в проекте');
});

test('r57: папку проекта предлагаем выбрать один раз и запоминаем', () => {
  const app = read('renderer/app.js');
  assert.match(app, /async function ensureProjectFolder\(\)/, 'есть проверка папки проекта');
  assert.match(app, /sessionStorage\.getItem\(key\) === '1'/, 'спрашиваем один раз за сеанс');
  assert.match(app, /action: 'choose', projectId: pid/, 'выбор папки через projectStorage');
  assert.match(app, /if \(inf\.projectDir\) return inf\.projectDir;/, 'если папка уже есть — не спрашиваем');
  assert.match(app, /window\.__bimOpenScanFolder = async function[\s\S]{0,300}?await ensureProjectFolder\(\)/, 'перед открытием папки сканера');
  assert.match(app, /window\.__bimXbinCloud = async function[\s\S]{0,300}?await ensureProjectFolder\(\)/, 'перед сборкой облака из .xbin');
  assert.match(app, /async function openPendingCloud\(\)[\s\S]{0,200}?await ensureProjectFolder\(\)/, 'перед открытием облака помещения');
});
