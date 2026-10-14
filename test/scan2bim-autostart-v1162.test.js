const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const CLIENT = fs.readFileSync(path.join(ROOT, 'renderer', 'scan2bim-ai-client.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const SRV = fs.readFileSync(path.join(ROOT, 'scan2bim-server.js'), 'utf8');

test('CSP разрешает подключение к локальному Scan2BIM серверу', () => {
  const m = HTML.match(/Content-Security-Policy" content="([^"]+)"/);
  const csp = (m && m[1]) || '';
  assert.ok(/connect-src[^;]*127\.0\.0\.1:8765/.test(csp), 'connect-src не разрешает 127.0.0.1:8765');
  assert.ok(/connect-src[^;]*localhost:8765/.test(csp), 'connect-src не разрешает localhost:8765');
});

test('Клиент нормализует localhost → 127.0.0.1 (обход IPv6 ::1)', () => {
  assert.ok(CLIENT.includes('resolveHost'), 'нет функции resolveHost');
  assert.ok(CLIENT.includes('127.0.0.1'), 'нет IPv4-адреса');
  assert.ok(CLIENT.includes('v1170'), 'версия клиента не поднята до v1170');
  assert.ok(HTML.includes('scan2bim-ai-client.js?v=1220'), 'index.html не обновлён до актуального клиента');
});

test('main.js автозапускает Scan2BIM сервер и глушит его при выходе', () => {
  assert.ok(MAIN.includes("require('./scan2bim-server')"), 'main.js не подключает scan2bim-server');
  assert.ok(/\.start\(\)/.test(MAIN), 'main.js не запускает сервер');
  assert.ok(MAIN.includes("app.on('before-quit'"), 'нет остановки сервера при выходе');
  assert.ok(MAIN.includes('bim:s2bStatus'), 'нет IPC статуса сервера');
});

test('preload пробрасывает статус сервера в renderer', () => {
  assert.ok(PRELOAD.includes('s2bStatus'), 'preload не отдаёт s2bStatus');
});

test('scan2bim-server.js: корректный модуль автозапуска', () => {
  assert.ok(SRV.includes('module.exports'), 'нет экспорта');
  assert.ok(SRV.includes('uvicorn') && SRV.includes('server:app'), 'не запускает uvicorn server:app');
  assert.ok(SRV.includes('127.0.0.1') && SRV.includes('8765'), 'неверный host/port');
  assert.ok(/function start\b/.test(SRV) && /function stop\b/.test(SRV) && /function status\b/.test(SRV), 'нет start/stop/status');
  assert.ok(SRV.includes('requirements-cpu.txt'), 'нет фолбэк-бутстрапа зависимостей');
});
