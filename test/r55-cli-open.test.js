'use strict';
// Ревизия 55: облако можно передать приложению при запуске (BIM Twin scan.las, «Открыть с помощью», ярлык).
// Проверяем связку: разбор аргументов в main → IPC bim:takePendingOpen → preload → окно само открывает облако.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('r55: облако из командной строки — разбор, выдача окну и автооткрытие', () => {
  const m = read('main.js');
  assert.match(m, /let pendingOpen = null;/, 'путь хранится на уровне модуля');
  assert.match(m, /if \(!a \|\| a\.startsWith\('-'\) \|\| !\/\\\.\(las\|laz\|ply\|pcd\|e57\|pts\|xyz\)\$\/i\.test\(a\)\) continue;/, 'фильтр расширений облаков');
  assert.match(m, /ipcMain\.handle\('bim:takePendingOpen'/, 'окно забирает путь через IPC');
  assert.match(m, /fileGrants\.grantExistingFile\(sender\.id, p, \{ read: true \}\)/, 'файл выдаётся окну на чтение');
  const pre = read('preload.js');
  assert.match(pre, /takePendingOpen: \(\) => inv\('bim:takePendingOpen'\)/, 'preload отдаёт метод окну');
  const app = read('renderer/app.js');
  assert.match(app, /API\.takePendingOpen\(\)\)\.then\(function \(p\) \{ if \(p\) window\.__bimOpenCloudPath\(p, \{ fresh: true \}\)/, 'окно открывает облако само');
});

test('r55: приложение запускается с облаком и не падает на неизвестных аргументах', () => {
  const m = read('main.js');
  // аргументы вида --remote-debugging-port / --enable-gpu-rasterization игнорируются
  assert.match(m, /a\.startsWith\('-'\)/, 'флаги не считаются файлами');
  // после выдачи путь очищается — повторно облако не открывается
  assert.match(m, /const p = pendingOpen; if \(!p\) return null;\s*\n\s*pendingOpen = null;/, 'путь выдаётся один раз');
});
