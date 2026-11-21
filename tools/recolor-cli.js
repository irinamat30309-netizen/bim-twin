'use strict';
/*
 * tools/recolor-cli.js — «Цвет по фото камер» без окна приложения (ревизия 55, r179 — параллельно по тайлам).
 *
 *   electron tools/recolor-cli.js in.las out.las scan.xbin poses.csv [json-опции]
 *
 * Делает то же, что кнопка «Цвет по фото»: кадры H.264 из .xbin декодируются WebCodecs в скрытом окне
 * (recolor-host.html + recolor-host-preload.js), расчёт — recolor-core.js. Нужен Electron, поэтому запуск:
 *
 *   ELECTRON_RUN_AS_NODE= node_modules/.bin/electron tools/recolor-cli.js …
 *
 * r179: облако режется на N тайлов по времени (строки LAS из xbin-lidar упорядочены по времени), тайлы
 * красятся параллельно в N скрытых окнах (каждое со своим пулом декодеров) и склеиваются обратно.
 * По умолчанию workers = min(4, ядра-1); opt.workers=1 или opt.parallel=false — прежний одиночный режим.
 * opt.workers=N — N воркеров; опции читаются из json-аргумента или BIM_RECOLOR_OPT.
 *
 * Прогресс — в stdout (и рядом с dst в .log), итог — строкой JSON в stdout.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
// r179: окна-воркеры закрываются по одному — нельзя выходить, пока идёт склейка/пост-обработка
try { app.on('window-all-closed', () => {}); } catch (_) {}
const RP = require('../recolor-parallel');

const [src, dst, xbin, posesPath, optJson] = process.argv.slice(2);
if (!src || !dst || !xbin || !posesPath) {
  console.error('нужно: electron tools/recolor-cli.js in.las out.las scan.xbin poses.csv [json]');
  process.exit(2);
}
// Опции: JSON-строкой в аргументе или в переменной окружения BIM_RECOLOR_OPT (удобно из PowerShell, где кавычки
// в аргументах теряются). Ключи без кавычек тоже принимаются: {hardwareDecode:false}.
function parseOpt(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch (_) {}
  try { return JSON.parse(String(s).replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":').replace(/'/g, '"')); } catch (_) {}
  console.error('не понял опции: ' + s); process.exit(2);
}
const opt = parseOpt(optJson || process.env.BIM_RECOLOR_OPT);
// r145: по умолчанию включён улучшенный цвет (лучший кадр, нормализация по кадрам,
// заполнение серых зон, цветокоррекция «как в Lixel»); opt.improve:false — прежнее поведение
if (opt.improve === undefined) opt.improve = true;
if (opt.improve && opt.dither === undefined) opt.dither = false;
const posesText = fs.readFileSync(path.resolve(posesPath), 'utf8');
const LOG = path.resolve(dst) + '.log';
try { fs.writeFileSync(LOG, ''); } catch (_) {}
const say = (s) => { try { console.log(s); } catch (_) {} try { fs.appendFileSync(LOG, s + '\n'); } catch (_) {} };
const T0 = Date.now();

// Ревизия 56: аппаратное декодирование (NVDEC) требует включённого GPU — выключаем ускорение только в софтверном режиме
if (!opt.hardwareDecode) app.disableHardwareAcceleration();

// одно скрытое окно-воркер: декодирует кадры и считает recolor-core для переданного LAS
function runOneWindow(cfg, onProgress) {
  return new Promise((resolve) => {
    let win = null, finished = false;
    const finish = (r) => {
      if (finished) return; finished = true;
      try { ipcMain.removeListener('recolor:progress', onProg); ipcMain.removeListener('recolor:done', onDone); ipcMain.removeListener('recolor:ready', onReady); } catch (_) {}
      const w = win; win = null; if (w && !w.isDestroyed()) { try { w.destroy(); } catch (_) {} }
      resolve(r);
    };
    const mine = (e) => !!(win && !win.isDestroyed() && e && e.sender === win.webContents);
    const onProg = (e, m) => { if (mine(e) && m && onProgress) { try { onProgress(Math.max(0, Math.min(1, Number(m.f) || 0)), String(m.label || '')); } catch (_) {} } };
    const onDone = (e, m) => { if (mine(e)) finish(m && typeof m === 'object' ? m : { ok: false, error: 'no_result' }); };
    const onReady = (e) => { if (mine(e)) { try { win.webContents.send('recolor:start', cfg); } catch (err) { finish({ ok: false, error: String((err && err.message) || err) }); } } };
    ipcMain.on('recolor:progress', onProg);
    ipcMain.on('recolor:done', onDone);
    ipcMain.on('recolor:ready', onReady);
    try {
      win = new BrowserWindow({
        show: false, width: 320, height: 240, skipTaskbar: true, title: 'BIM Twin: цвет по фото',
        webPreferences: { preload: path.join(__dirname, '..', 'recolor-host-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false, spellcheck: false, webgl: false, devTools: false }
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (ev) => { try { ev.preventDefault(); } catch (_) {} });
      win.webContents.on('render-process-gone', (_e, d) => finish({ ok: false, error: 'окно декодера закрылось (' + ((d && d.reason) || 'сбой') + ')' }));
      win.on('closed', () => finish({ ok: false, error: 'окно декодера закрылось' }));
      win.loadFile(path.join(__dirname, '..', 'recolor-host.html')).catch((e) => finish({ ok: false, error: String((e && e.message) || e) }));
    } catch (e) { finish({ ok: false, error: String((e && e.message) || e) }); }
    setTimeout(() => finish({ ok: false, error: 'таймаут 4 ч' }), 4 * 60 * 60 * 1000);
  });
}

function lasPoints(p) {
  let fd = null;
  try {
    fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(375); let got = 0;
    while (got < 375) { const n = fs.readSync(fd, b, got, 375 - got, got); if (!n) break; got += n; }
    let n = b.readUInt32LE(107);
    if (b[25] >= 4) { const n2 = Number(b.readBigUInt64LE(247)); if (n2 > 0) n = n2; }
    return n;
  } catch (_) { return 0; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } }
}

let lastP = -1;
const logProg = (f, label) => {
  const p = Math.floor(f * 40);
  if (p !== lastP) { lastP = p; say(`[${((Date.now() - T0) / 60000).toFixed(1)} мин] ${label || ''} ${Math.round(f * 100)}%`); }
};

app.whenReady().then(async () => {
  const srcAbs = path.resolve(src), dstAbs = path.resolve(dst), xbinAbs = path.resolve(xbin);
  if (!fs.existsSync(srcAbs)) { say(JSON.stringify({ ok: false, error: 'нет входного LAS: ' + srcAbs })); app.exit(1); return; }
  if (!fs.existsSync(xbinAbs)) { say(JSON.stringify({ ok: false, error: 'нет .xbin: ' + xbinAbs })); app.exit(1); return; }
  // кэш результата: если dst уже цветной и не старее src/.xbin — просто сообщаем (повторная раскраска = 0)
  if (opt.cache !== false && fs.existsSync(dstAbs)) {
    try {
      const ds = fs.statSync(dstAbs), ss = fs.statSync(srcAbs), xs = fs.statSync(xbinAbs);
      if (ds.size > 0 && ds.mtimeMs >= Math.max(ss.mtimeMs, xs.mtimeMs)) {
        say(JSON.stringify({ ok: true, cached: true, points: lasPoints(dstAbs), path: dstAbs, sec: 0 }));
        app.exit(0); return;
      }
    } catch (_) {}
  }
  const points = lasPoints(srcAbs);
  const cores = (() => { try { return os.availableParallelism ? os.availableParallelism() : os.cpus().length; } catch (_) { return 4; } })();
  let workers = opt.workers != null ? Math.max(1, opt.workers | 0) : Math.max(1, Math.min(6, cores - 1));
  if (opt.parallel === false || workers <= 1 || points < (opt.parallelMinPoints || 200000)) workers = 1;
  // r179: в параллельном режиме тайлы красят только точки; заполнение серых зон и денойз делаются
  // ПОСЛЕ склейки глобально (recolor-post.js) — иначе на границах тайлов теряются плотность/качество.
  const tileOpt = Object.assign({}, opt);
  if (workers > 1) {
    tileOpt.decodePool = Math.max(1, Math.min(opt.decodePool || 6, Math.floor(Math.max(1, cores - 1) / workers) + (cores >= 12 ? 1 : 0)));
    tileOpt.pilotFrames = Math.max(32, Math.min(opt.pilotFrames || 160, Math.round(160 / workers)));
    tileOpt.fill = false; tileOpt.denoise = false;
  }
  const appDir = path.join(__dirname, '..');
  const tmpDir = path.dirname(dstAbs);
  if (workers <= 1) {
    try {
      const r = await runOneWindow({ appDir, src: srcAbs, dst: dstAbs, xbin: xbinAbs, posesText, tmpDir, opt }, (f, label) => logProg(f, label));
      if (r && r.ok) r.sec = Math.round((Date.now() - T0) / 1000);
      say(JSON.stringify(r || { ok: false }));
      app.exit(r && r.ok ? 0 : 1);
    } catch (e) { say(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); app.exit(1); }
    return;
  }
  say(JSON.stringify({ note: 'parallel', workers, points, cores }));
  try {
    const r = await RP.parallelRecolor({
      src: srcAbs, dst: dstAbs, xbin: xbinAbs, posesText, tmpDir, opt: tileOpt, workers,
      runOne: (cfg, onProgress) => runOneWindow(Object.assign({ appDir }, cfg), onProgress),
      onProgress: (f, label) => logProg(f, label),
      job: { cancelled: false },
      log: (m) => say(m)
    });
    if (r && r.ok && opt.post !== false) {
      let post = null;
      try {
        const postTmp = dstAbs + '.post.tmp';
        const PP = require('../recolor-post');
        const tiles = (r.stats && r.stats.tiles) || [];
        if (tiles.length > 1) {
          const ranges = tiles.map(T => ({ start: T.rows, count: T.count, margin: Math.max(20000, Math.round(T.count * 0.06)) }));
          post = await PP.postParallel({ gray: srcAbs, colorIn: dstAbs, colorOut: postTmp, ranges, workers: Math.min(workers, ranges.length), opt,
            log: (m) => say('[' + ((Date.now() - T0) / 60000).toFixed(1) + ' мин] ' + m) });
        } else {
          post = await PP.postColor(srcAbs, dstAbs, postTmp, opt, (m) => say('[' + ((Date.now() - T0) / 60000).toFixed(1) + ' мин] ' + m));
        }
        fs.rmSync(dstAbs, { force: true }); fs.renameSync(postTmp, dstAbs);
        r.stats.post = post;
        r.stats.colored = post.colored; r.stats.filled = (post.fill && post.fill.filled) || 0;
        say(JSON.stringify({ note: 'post', ms: post.ms, colored: post.colored, filled: r.stats.filled, denoise: post.denoise }));
      } catch (e) { r.postWarning = String((e && e.message) || e); say(JSON.stringify({ note: 'post_failed', error: r.postWarning })); }
    }
    r.sec = Math.round((Date.now() - T0) / 1000);
    say(JSON.stringify(r));
    app.exit(r && r.ok ? 0 : 1);
  } catch (e) {
    say(JSON.stringify({ ok: false, error: String((e && e.message) || e), sec: Math.round((Date.now() - T0) / 1000) }));
    app.exit(1);
  }
}).catch((e) => { console.error(e && e.stack || e); app.exit(1); });
