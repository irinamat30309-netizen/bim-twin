'use strict';
/*
 * tools/recolor-cli.js — «Цвет по фото камер» без окна приложения (ревизия 55).
 *
 *   electron tools/recolor-cli.js in.las out.las scan.xbin poses.csv [json-опции]
 *
 * Делает то же, что кнопка «Цвет по фото»: кадры H.264 из .xbin декодируются WebCodecs в скрытом окне
 * (recolor-host.html + recolor-host-preload.js), расчёт — recolor-core.js. Нужен Electron, поэтому запуск:
 *
 *   ELECTRON_RUN_AS_NODE= node_modules/.bin/electron tools/recolor-cli.js …
 *
 * Прогресс — в stderr, итог — строкой JSON в stdout.
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const [src, dst, xbin, posesPath, optJson] = process.argv.slice(2);
if (!src || !dst || !xbin || !posesPath) {
  console.error('нужно: electron tools/recolor-cli.js in.las out.las scan.xbin poses.csv [json]');
  process.exit(2);
}
const opt = optJson ? JSON.parse(optJson) : {};
const posesText = fs.readFileSync(path.resolve(posesPath), 'utf8');
const LOG = path.resolve(dst) + '.log';
try { fs.writeFileSync(LOG, ''); } catch (_) {}
const say = (s) => { try { console.log(s); } catch (_) {} try { fs.appendFileSync(LOG, s + '\n'); } catch (_) {} };
const t0 = Date.now();
let lastP = -1;
const log = (f, label) => {
  const p = Math.floor(f * 40);
  if (p !== lastP) { lastP = p; say(`[${((Date.now() - t0) / 60000).toFixed(1)} мин] ${label || ''} ${Math.round(f * 100)}%`); }
};

app.disableHardwareAcceleration();   // декодирование кадров — программное, видеокарта не нужна
app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false, width: 320, height: 240, skipTaskbar: true, title: 'BIM Twin: цвет по фото',
    webPreferences: { preload: path.join(__dirname, '..', 'recolor-host-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false, spellcheck: false, webgl: false, devTools: false }
  });
  let finished = false;
  const done = (r) => { if (finished) return; finished = true; say(JSON.stringify(r)); try { win.destroy(); } catch (_) {} app.exit(r && r.ok ? 0 : 1); };
  ipcMain.on('recolor:progress', (_e, m) => { if (m) log(Math.max(0, Math.min(1, Number(m.f) || 0)), String(m.label || '')); });
  ipcMain.on('recolor:done', (_e, m) => done(Object.assign({ sec: Math.round((Date.now() - t0) / 1000) }, m)));
  ipcMain.on('recolor:ready', () => {
    win.webContents.send('recolor:start', {
      appDir: path.join(__dirname, '..'), src: path.resolve(src), dst: path.resolve(dst), xbin: path.resolve(xbin),
      posesText, tmpDir: path.dirname(path.resolve(dst)), opt
    });
  });
  win.loadFile(path.join(__dirname, '..', 'recolor-host.html')).catch((e) => done({ ok: false, error: String((e && e.message) || e) }));
  win.on('closed', () => done({ ok: false, error: 'окно декодера закрылось' }));
  setTimeout(() => done({ ok: false, error: 'таймаут 4 ч' }), 4 * 60 * 60 * 1000);
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });
