'use strict';
// Ревизия 9: статические проверки главного процесса и интерфейса потокового режима (Electron в тестах не запускается).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const cfg = require('../app-config.js');

test('конфиг: пороги быстрого предпросмотра и размер кэша индексов', () => {
  const c = cfg.APP_CONFIG || cfg;
  assert.equal(c.STREAM_FIRST_POINTS, 50000000);
  assert.equal(c.PREVIEW_POINTS, 6000000);
  assert.equal(c.OCTREE_CACHE_KEEP, 2);
  assert.ok(c.PREVIEW_POINTS < c.STREAM_FIRST_POINTS);
});

test('main.js: предпросмотр включается только по запросу окна, при 100 % точек и настройке streamFirst', () => {
  const s = read('main.js');
  assert.match(s, /payload\.preview\s*===\s*true/);
  assert.match(s, /streamFirst\s*!==\s*false/);
  assert.match(s, /result\.previewOnly\s*=\s*true/);
  assert.match(s, /peek\s*>\s*\(APP_CFG\.STREAM_FIRST_POINTS/);
});

test('main.js: кэш индексов — отпечаток, вытеснение, защита от удаления', () => {
  const s = read('main.js');
  assert.match(s, /createHash\('sha256'\)\.update\(JSON\.stringify\(\['r9', abs, st\.size, Math\.round\(st\.mtimeMs\)/);
  assert.match(s, /octreeCache\s*!==\s*false/);
  assert.match(s, /pruneOctreeCache\(base, Math\.max\(0, \(APP_CFG\.OCTREE_CACHE_KEEP \|\| 2\) - 1\)\)/);
  assert.match(s, /\^c-\[a-f0-9\]\{16\}\$/);
  assert.match(s, /kept:\s*true/);
  assert.match(s, /cached:\s*true/);
  // readOctreeNode не ищет узел линейно на каждое чтение
  const fn = s.slice(s.indexOf('readOctreeNode'), s.indexOf('readOctreeNode') + 4000);
  assert.ok(!/nodes\.find\(/.test(fn.split('octreeNodeMaps')[0] || ''), 'нет линейного find до Map');
  assert.match(s, /octreeNodeMaps/);
});

test('preload: parseCloud передаёт признак preview только как булево', () => {
  const s = read('preload.js');
  assert.match(s, /preview:\s*!!\(opts && opts\.preview\)/);
});

test('app.js: открытие файла просит предпросмотр, а огромный файл автоматически строит индекс в фоне', () => {
  const s = read('renderer/app.js');
  assert.match(s, /API\.parseCloud\(filePath, jobId, \{ onProgress:[^\n]*preview: true \}\)/);
  assert.match(s, /if \(result\.previewOnly\)/);
  assert.match(s, /window\.__lxStreamBg = true/);
  assert.match(s, /preserveView:\s*bgBuild/);
  assert.match(s, /Индекс из кэша/);
  assert.match(s, /decodeNodeGpu/);
});

test('панель «Загружено точек» в потоке говорит «Все точки файла» и показывает, сколько на экране', () => {
  const s = read('renderer/lixel-cloud-ui.js');
  assert.match(s, /Все точки файла/);
  assert.match(s, /bim-octree-stats/);
  assert.match(s, /streamLoadedText/);
});
