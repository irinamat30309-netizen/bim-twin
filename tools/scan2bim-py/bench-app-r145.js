'use strict';
/*
 * bench-app-r145.js — бенчмарк приложения BIM Twin на реальных облаках заказчика (r145).
 *
 * Открывает настоящий Electron со штатным «Открыть с помощью» (файл передаётся в argv: main.js
 * разрешает путь и выдаёт грант — это единственный санкционированный путь без диалога), входит
 * в рабочую область и измеряет: старт приложения, первый кадр облака, полную загрузку, FPS при
 * вращении 10 с (rAF), память (JS heap, RSS Electron, VRAM GPU), задержку event-loop; сохраняет
 * JSON + скриншоты с runtime-HUD. Исходники приложения не меняются.
 *
 * Запуск:
 *   node tools/scan2bim-py/bench-app-r145.js --all
 *   node tools/scan2bim-py/bench-app-r145.js --file D:\Skan\port\map.las --label lixel --out D:\BIM-TWIN-TEST\r55\bench-r145
 */
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const DEFAULT_OUT = 'D:\\BIM-TWIN-TEST\\r55\\bench-r145';
const LIXEL = 'D:\\Skan\\port\\map.las';
const OURS = 'D:\\BIM-TWIN-TEST\\xbin-verify\\interior-ours-full-r132.las';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes('--' + name);
function fmt(n, d) { return (n == null || !Number.isFinite(Number(n))) ? '—' : Number(n).toFixed(d == null ? 1 : d); }

async function gpuMemMB() {
  try {
    const out = await new Promise((res, rej) => execFile('nvidia-smi',
      ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { timeout: 5000 },
      (e, so) => e ? rej(e) : res(String(so).trim())));
    return Number(String(out).split(/\r?\n/)[0]);
  } catch (_) { return null; }
}
async function electronRssMB() {
  try {
    const out = await new Promise((res, rej) => execFile('powershell', ['-NoProfile', '-Command',
      "(Get-Process electron -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum"],
    { timeout: 8000 }, (e, so) => e ? rej(e) : res(String(so).trim())));
    const v = Number(out);
    return Number.isFinite(v) ? Math.round(v / 1048576) : null;
  } catch (_) { return null; }
}
function startSampler() {
  const samples = []; let stopped = false;
  (async () => {
    while (!stopped) {
      const t = now();
      const [rss, gpu] = await Promise.all([electronRssMB(), gpuMemMB()]);
      samples.push({ t, rssMB: rss, gpuMB: gpu });
      await sleep(900);
    }
  })();
  return { samples, stop() { stopped = true; } };
}

async function connect(port, filter, timeoutMs) {
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && filter.test(t.url));
      if (p && p.webSocketDebuggerUrl) {
        const ws = new WebSocket(p.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
        let id = 0; const pend = new Map(); let closed = false;
        ws.addEventListener('close', () => { closed = true; });
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
          if (m.id && pend.has(m.id)) { const q = pend.get(m.id); pend.delete(m.id); m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result); }
        });
        const send = (method, params) => new Promise((res, rej) => {
          if (closed) return rej(new Error('CDP closed'));
          const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} }));
        });
        await send('Page.enable'); await send('Runtime.enable');
        return { ws, send, isClosed: () => closed };
      }
    } catch (_) { }
    await sleep(300);
  }
  throw new Error('CDP: страница не появилась (' + filter + ')');
}
async function ev(send, expression, timeoutMs) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs || 120000 });
  if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result && r.result.value;
}
async function shot(send, file) {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
  return fs.statSync(file).size;
}

const INIT = `(() => {
  if (window.__bench145) return 'already';
  const B = { wallAtInit: Date.now() - performance.now(), frames: 0, events: [], matched: null,
              firstDataWall: null, firstFrameWall: null, longtasks: [] };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) B.longtasks.push({ t: Math.round(e.startTime), ms: Math.round(e.duration) }); }).observe({ entryTypes: ['longtask'] }); } catch (_) {}
  window.addEventListener('lx-cloud-loaded', (e) => {
    const d = (e && e.detail) || {};
    const count = Number(d.count || d.points || d.n || 0) || 0;
    const name = d.sourceName || d.name || d.source || null;
    const rec = { t: performance.now(), wall: B.wallAtInit + performance.now(), count, name };
    B.events.push(rec);
    // r149: прогрессивный первый кадр (первая часть облака уже на экране) — фиксируем его как first-frame,
    // но полную загрузку ждём по финальному событию endCloudStream.
    if (d.progressive === true) {
      if (B.firstDataWall == null) B.firstDataWall = rec.wall;
      if (!B.progressive) B.progressive = rec;
      return;
    }
    if (!B.matched && (count >= 1000 || (name && String(name).indexOf(B.targetName) >= 0))) {
      B.matched = rec;
      if (B.firstDataWall == null) B.firstDataWall = rec.wall;
    }
  }, false);
  let n = 0;
  function tick() {
    n++; B.frames = n;
    if (B.firstDataWall != null && B.firstFrameWall == null) B.firstFrameWall = B.wallAtInit + performance.now();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  window.__bench145 = B;
  return 'ok';
})()`;

const STATE = `(() => {
  const B = window.__bench145 || {};
  const v = window.__viewer || window.__lxViewer || null;
  let count = 0, octN = 0, oct = false, total = null;
  if (v) {
    oct = !!v._octActive;
    if (v._octIndex) octN = Number(v._octIndex.pointCount) || 0;
    if (Array.isArray(v.base)) for (const o of v.base) { if (o && o.pos) count += o.pos.length / 3; }
    total = Number(v._cloudTotal || v._octTotalPoints || (v._stream && v._stream.srcTot) || (v._srcMeta && v._srcMeta.points) || 0) || null;
  }
  const panel = document.querySelector('.lx-progress-modal,.lx-operation,[class*=progress]');
  const toasts = Array.from(document.querySelectorAll('[class*=toast],[id*=toast]'))
    .filter((x) => x.offsetParent !== null).map((x) => (x.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 3);
  let dialog = null;
  const ds = Array.from(document.querySelectorAll('[role="dialog"],[class*=dialog],[class*=modal],[class*=kit]'))
    .filter((x) => x.offsetParent !== null && (x.innerText || '').trim().length > 8)
    .map((x) => (x.innerText || '').replace(/\\s+/g, ' ').trim());
  if (ds.length) dialog = ds.sort((a, b) => b.length - a.length)[0].slice(0, 300);
  return {
    t: performance.now(), count, octN, oct, total, frames: B.frames || 0,
    matched: B.matched ? { wall: B.matched.wall, count: B.matched.count, name: B.matched.name } : null,
    firstDataWall: B.firstDataWall == null ? null : B.firstDataWall,
    firstFrameWall: B.firstFrameWall == null ? null : B.firstFrameWall,
    events: (B.events || []).slice(-8),
    prog: (window.__lxProgress && window.__lxProgress.active) ? 1 : 0,
    busy: !!document.querySelector('.lx-operation-busy') || !!document.querySelector('.lx-topprogress:not([hidden])'),
    panelText: panel && panel.offsetParent !== null ? (panel.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200) : null,
    toasts, dialog
  };
})()`;

const HUD_INIT = `(() => {
  let h = document.getElementById('bench145Hud');
  if (!h) {
    h = document.createElement('div'); h.id = 'bench145Hud';
    h.style.cssText = 'position:fixed;right:14px;top:64px;z-index:99999;background:rgba(10,13,17,.88);color:#d8ffd8;' +
      'font:12px/1.45 Consolas,monospace;padding:10px 13px;border:1px solid #3c7a44;border-radius:8px;' +
      'white-space:pre;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,.45)';
    document.body.appendChild(h);
  }
  window.__benchHud = (txt) => { h.textContent = String(txt); };
  return true;
})()`;

async function consentScan(send, log) {
  const clicked = await ev(send, `(() => {
    const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.offsetParent !== null);
    const t = btns.find((b) => /Открыть максимум|Показать все|Продолжить|Да, загрузить|Загрузить всё|Всё равно/i.test((b.textContent || '')));
    if (t) { t.click(); return (t.textContent || '').trim().slice(0, 80); }
    return null;
  })()`, 20000);
  if (clicked) log.push({ t: now(), event: 'consent', text: clicked });
  return clicked;
}

async function benchOne(file, label, outDir, opts) {
  const port = opts.port;
  const result = { label, file, fileSize: fs.existsSync(file) ? fs.statSync(file).size : null, ok: false,
    startedAt: new Date().toISOString(), port, log: [], error: null,
    times: {}, load: {}, fps: {}, memory: {}, ui: {}, screenshots: {} };
  fs.mkdirSync(outDir, { recursive: true });
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const _profile = process.env.BENCH_PROFILE || '';
const _args = ['.', file, '--remote-debugging-port=' + port];
if (_profile) _args.push('--user-data-dir=' + _profile);
const child = spawn(EXE, _args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  const tSpawn = now();
  const sampler = startSampler();
  let ws = null, send = null;
  let targetName = path.basename(file);
  try {
    const startup = await connect(port, /startup\.html/, 30000);
    result.times.startupMs = now() - tSpawn;
    // r151 lazy startup: страница появляется очень быстро (0,8 с) — ждём, пока её JS реально нарисует
    // кнопки/список проектов, иначе клик уходит в пустоту и рабочая область не открывается.
    // r164: с быстрым авто-входом (CLI-облако) startup-страница может уйти в workspace ещё до клика.
    // Тогда её CDP-таргет исчезает — не ждём 25 с в цикле готовности, а сразу переходим к index.html.
    let earlyNav = false;
    for (let w = 0; w < 100; w++) {
      let ui = null;
      try {
        ui = await ev(startup.send, `(() => {
          const b = document.getElementById('openProject');
          const cards = document.querySelectorAll('.st-card:not(.st-new)').length;
          return { ready: !!b, disabled: !!(b && b.disabled), cards, text: (document.body && document.body.innerText || '').slice(0, 120) };
        })()`, 15000);
      } catch (_) { earlyNav = true; break; }
      if (ui && ui.ready && !ui.disabled && (ui.cards > 0 || /Новый проект|Проекты/.test(ui.text || ''))) break;
      await sleep(250);
    }
    let opened = null;
    if (!earlyNav) {
      try {
        opened = await ev(startup.send, `(() => {
          const btn = document.getElementById('openProject');
          const cards = Array.from(document.querySelectorAll('.st-card:not(.st-new)'));
          if (btn && !btn.disabled) { btn.click(); return 'openProject'; }
          if (cards.length) { cards[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 'card-dblclick'; }
          const nb = document.getElementById('newProject'); if (nb) { nb.click(); return 'newProject'; }
          return null;
        })()`, 20000);
      } catch (_) { earlyNav = true; }
    }
    result.log.push({ t: now(), event: 'open-workspace', how: earlyNav ? 'auto-nav' : opened });
    try { startup.ws.close(); } catch (_) { }
    await sleep(earlyNav ? 60 : 300);
    let idx;
    try {
      idx = await connect(port, /index\.html/, 25000);
    } catch (e) {
      result.log.push({ t: now(), event: 'open-retry', error: String((e && e.message) || e) });
      const s2 = await connect(port, /startup\.html/, 15000);
      await sleep(1500);
      await ev(s2.send, `(() => { const b = document.getElementById('openProject'); if (b && !b.disabled) { b.click(); return true; } const c = document.querySelector('.st-card:not(.st-new)'); if (c) { c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; } return false; })()`, 15000);
      try { s2.ws.close(); } catch (_) { }
      idx = await connect(port, /index\.html/, 180000);
    }
    ws = idx.ws; send = idx.send;
    result.times.workspaceMs = now() - tSpawn;
    await ev(send, `window.__bench145 = window.__bench145 || null; window.__benchTargetName = ${JSON.stringify(targetName)}; true`, 20000);
    await ev(send, INIT.replace('B.targetName', JSON.stringify(targetName)), 60000);
    await ev(send, HUD_INIT, 20000);
    const timeline = [];
    let st = null, tLast = 0, lastConsent = 0, openStartWall = null;
    const loadTimeout = opts.loadTimeoutMs || 900000;
    const tLoop = now();
    let lastEvents = 0;
    let lastProgressAt = now();
    let lastProgressKey = '';
    while (now() - tLoop < loadTimeout) {
      try { st = await ev(send, STATE, 30000); } catch (e) { result.log.push({ t: now(), event: 'state-error', message: String(e.message || e) }); break; }
      if (!st) { await sleep(300); continue; }
      if (openStartWall == null && (st.prog || st.matched || st.count > 1000)) openStartWall = now();
      if (st.events && st.events.length && st.events.length > lastEvents) { lastEvents = st.events.length; result.log.push({ t: now(), event: 'cloud-loaded-events', events: st.events }); }
      if (now() - tLast > 500) {
        tLast = now();
        timeline.push({ tMs: Math.round(now() - tSpawn), count: st.count, octN: st.octN, prog: st.prog, busy: st.busy, matched: !!(st.matched), panel: st.panelText });
      }
      if (st.dialog || (st.toasts || []).some((t) => /Не удалось открыть облако|не загружен|ошибк|path_not_authorized/i.test(t))) {
        if (st.toasts && st.toasts.length) result.log.push({ t: now(), event: 'toasts', text: st.toasts.join(' | ') });
        if (st.dialog) result.log.push({ t: now(), event: 'dialog', text: st.dialog });
        if (now() - lastConsent > 3000) { lastConsent = now(); await consentScan(send, result.log); }
      }
      if (st.matched) break;
      const progressKey = [st.prog ? 1 : 0, st.count || 0, st.octN || 0, st.matched ? 1 : 0, st.panelText || ''].join('|');
      if (progressKey !== lastProgressKey) { lastProgressKey = progressKey; lastProgressAt = now(); }
      if (now() - lastProgressAt > 120000) {
        result.log.push({ t: now(), event: 'stall', panel: st.panelText, toasts: st.toasts, dialog: st.dialog });
        break;
      }
      if (!st.prog && !st.busy && (now() - tLoop) > 45000 && !st.matched) {
        if (now() - lastConsent > 4000) {
          lastConsent = now();
          await consentScan(send, result.log);
          const buttons = await ev(send, `Array.from(document.querySelectorAll('button')).filter((b) => b.offsetParent !== null).map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 40)`, 20000);
          result.log.push({ t: now(), event: 'idle-diagnostics', buttons, toasts: st.toasts, panel: st.panelText });
        }
      }
      await sleep(250);
    }
    const finalState = st || {};
    result.times.loadStartMs = openStartWall ? (openStartWall - tSpawn) : null;
    const m = finalState.matched;
    result.times.firstFrameMs = m && finalState.firstFrameWall ? Math.round(finalState.firstFrameWall - tSpawn) : null;
    result.times.fullLoadMs = m ? Math.round(m.wall - tSpawn) : null;
    result.load = {
      loadedPoints: m ? m.count : null,
      sourceName: m ? m.name : null,
      sourceCount: m ? m.count : null,
      octIndexPoints: finalState.octN || null,
      totalPoints: finalState.total || null,
      streaming: !!finalState.oct,
      cloudLoaded: !!m,
      timeline: timeline.slice(-500),
    };
    if (!m) throw new Error('облако не загрузилось за ' + Math.round(loadTimeout / 1000) + ' с (prog=' + finalState.prog + ', count=' + finalState.count + ')');
    // -------- «Успокоение» после загрузки (индексация/LOD/UI)
    try { await ev(send, '(() => { const v = window.__viewer || window.__lxViewer; try { v._frame && v._frame(); } catch (_) {} return true; })()', 30000); } catch (_) {}
    let settleMs = null;
    for (let i = 0; i < 160; i++) {
      let probe = null;
      try {
        probe = await ev(send, `(async () => {
          await new Promise((r) => setTimeout(r, 350));
          const dts = []; let last = performance.now();
          await new Promise((res) => { let n = 0; function f(ts) { dts.push(ts - last); last = ts; n++; if (n < 20) requestAnimationFrame(f); else res(); } requestAnimationFrame(f); });
          const s = dts.slice().sort((a, b) => a - b);
          return { p95: s[Math.floor(s.length * 0.95)] || 0, max: s[s.length - 1] || 0 };
        })()`, 60000);
      } catch (_) { }
      if (probe && probe.p95 < 40) { settleMs = Math.round(now() - tSpawn - (result.times.fullLoadMs || 0)); break; }
      await sleep(300);
    }
    result.times.settleMs = settleMs;
    // -------- r172: скриншоты «до/во время/после» вращения + состояние по умолчанию
    const baseName = label.replace(/[^\w.-]+/g, '_');
    const cap = async (suffix) => { const f = path.join(outDir, baseName + '-' + suffix + '.png'); const b = await shot(send, f); return { file: f, bytes: b }; };
    const probe = await ev(send, `(() => {
      const val = (sel) => { const e = document.querySelector(sel); return e ? Number(e.value) : null; };
      const rows = [];
      try {
        document.querySelectorAll('input[type=range]').forEach((e) => {
          const r = e.closest('.lx-cp-row, .q-row, .row, .fx-row');
          const lab = r ? (r.textContent || '').trim().slice(0, 48) : (e.getAttribute('aria-label') || e.id || '');
          rows.push({ id: e.id || null, label: lab, value: Number(e.value), min: e.min != null ? Number(e.min) : null, max: e.max != null ? Number(e.max) : null });
        });
      } catch (_) { }
      const v = window.__viewer || window.__lxViewer || null;
      const c = v && v.canvas ? v.canvas.getBoundingClientRect() : null;
      const g = (o, k, d) => (o && o[k] != null ? o[k] : d);
      return {
        ranges: rows.slice(0, 60),
        cpSize: val('#cpSize'),
        shownNote: (document.getElementById('cpShareNote') || {}).textContent || '',
        cpLoaded: (document.getElementById('cpLoaded') || {}).textContent || '',
        cpTotal: (document.getElementById('cpTotal') || {}).textContent || '',
        perfPoints: (document.querySelector('[data-perf-points]') || {}).textContent || '',
        viewer: v ? {
          pointSizeScale: g(v, 'pointSizeScale', null), exposure: g(v, 'exposure', null), brightness: g(v, 'brightness', null),
          toneMap: g(v, '_toneMap', null), colorMode: g(v, 'colorMode', null), attenuate: g(v, 'attenuate', null),
          adaptivePoint: g(v, '_adaptivePoint', null), pointSize: g(v, 'pointSize', null), dispSize: (v.disp ? v.disp.size : null)
        } : null,
        canvas: c ? { x: c.left, y: c.top, w: c.width, h: c.height } : null,
        dpr: window.devicePixelRatio || 1,
        budgets: (() => { try { return { gpuPointBudget: window.__bimGpuPointBudget ? window.__bimGpuPointBudget() : null,
          lodDrawBudget: (window.APP_CONFIG && window.APP_CONFIG.LOD_DRAW_BUDGET) || null,
          cfg: window.APP_CONFIG ? { GPU_POINT_BUDGET: window.APP_CONFIG.GPU_POINT_BUDGET || null, LOD_DRAW_BUDGET: window.APP_CONFIG.LOD_DRAW_BUDGET || null, MAX_POINT_BUDGET: window.APP_CONFIG.MAX_POINT_BUDGET || null } : null,
          ls: (() => { const o = {}; for (const k of ['bim.perf.quality', 'bim.perf.look', 'bim.perfRev', 'bim.gpuBudgetRev', 'bim.gpuPointBudget', 'bim.gpuShowAll', 'bim.gpuResetAt', 'bim.preloadPoints']) { try { o[k] = localStorage.getItem(k); } catch (e) { } } return o; })() }; } catch (e) { return null; } })(),
        vkeys: (() => { const o = {}; try { for (const k of Object.keys(v || {})) { if (!/size|bright|expos|tone|color|disp|qual|atten|point|scale|luma|gamma|budget/i.test(k)) continue; const x = v[k]; if (typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') o[k] = x; } } catch (_) { } return o; })(),
        cloudInfo: (() => { try { const ci = window.__pcTools && window.__pcTools.cloudInfo ? window.__pcTools.cloudInfo() : null; return ci ? { loaded: ci.loadedCount, source: ci.sourceCount, streaming: !!ci.streaming } : null; } catch (_) { return null; } })(),
        loadedVsSource: (() => { try { const vv = window.__viewer || window.__lxViewer; const rec = vv && vv._cloudRecord; const src = vv && (vv._sourceTotal || vv._cloudTotal); return { record: rec ? { name: rec.name, count: rec.count, sourceCount: rec.sourceCount } : null, sourceTotal: src || null }; } catch (_) { return null; } })()
      };
    })()`, 30000);
    result.ui = Object.assign(result.ui || {}, probe);
    result.screenshots.before = (await cap('before')).file;
    // -------- FPS: вращение (кадр «во время» снимается снаружи, пока идёт rAF-цикл)
    await ev(send, `(() => {
      const v = window.__viewer || window.__lxViewer; if (!v) return { error: 'нет __viewer' };
      const MS = ${Number(opts.rotateSec || 10) * 1000};
      const st = window.__benchRot = { done: false, frames: 0, dts: [], maxLag: 0, ms: 0, t0: 0 };
      let last = performance.now(), exp = performance.now() + 16;
      const lagTick = () => { const t = performance.now(); const d = t - exp; if (d > st.maxLag) st.maxLag = d; exp += 16; if (!st.done) setTimeout(lagTick, 16); };
      setTimeout(lagTick, 16);
      st.t0 = performance.now();
      const loop = (ts) => { if (st.done) return; st.frames++; const dt = ts - last; last = ts; if (st.dts.length < 200000) st.dts.push(dt); try { v.yaw = (v.yaw || 0) + 0.012; } catch (_) {} try { v.render(); } catch (_) {} if (performance.now() - st.t0 < MS) requestAnimationFrame(loop); else st.done = true; };
      requestAnimationFrame(loop);
      return true;
    })()`, 20000);
    await sleep(Math.max(1200, Math.min(4500, Number(opts.rotateSec || 10) * 400)));
    result.screenshots.during = (await cap('during')).file;
    await sleep(Math.max(800, Math.min(2500, Number(opts.rotateSec || 10) * 220)));
    result.screenshots.during2 = (await cap('during2')).file;
    let rot = null;
    const rotDeadline = Date.now() + (Number(opts.rotateSec || 10) + 20) * 1000;
    while (Date.now() < rotDeadline) {
      try {
        rot = await ev(send, `(() => { const R = window.__benchRot; if (!R || !R.done) return null;
          const sorted = (R.dts || []).slice().sort((a, b) => a - b);
          const pct = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
          const ms = performance.now() - R.t0;
          return { frames: R.frames, ms, avgFps: R.frames ? R.frames / (ms / 1000) : null, p95FrameMs: pct(0.95), maxFrameMs: sorted.length ? sorted[sorted.length - 1] : null,
                   minFps: sorted.length ? 1000 / sorted[sorted.length - 1] : null, maxLag: R.maxLag,
                   heapMB: (performance.memory && performance.memory.usedJSHeapSize) ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null }; })()`, 30000);
      } catch (_) { rot = null; }
      if (rot) break;
      await sleep(250);
    }
    result.fps = rot || {};
    result.screenshots.after = (await cap('after')).file;
    result.ui.rotationMaxLagMs = result.fps.maxLag;

    // -------- HUD и скриншот
    const loaded = result.load.loadedPoints || 0;
    const hudText = ['BIM Twin — бенчмарк r172', 'файл: ' + path.basename(file),
      'точек: ' + Number(loaded).toLocaleString('ru-RU'),
      'FPS: ' + fmt(result.fps.avgFps, 1),
      'кадр p95: ' + fmt(result.fps.p95FrameMs, 1) + ' мс',
      'загрузка: ' + fmt(result.times.fullLoadMs / 1000, 1) + ' с'].join('\n');
    await ev(send, `window.__benchHud(${JSON.stringify(hudText)})`, 20000);
    result.screenshots.hud = path.join(outDir, baseName + '-hud.png');
    result.screenshots.hudBytes = await shot(send, result.screenshots.hud);
    result.memory = {
      heapMB: result.fps.heapMB,
      finalRssMB: sampler.samples.length ? sampler.samples[sampler.samples.length - 1].rssMB : null,
      peakRssMB: Math.max(0, ...sampler.samples.map((s) => s.rssMB || 0)),
      finalGpuMB: sampler.samples.length ? sampler.samples[sampler.samples.length - 1].gpuMB : null,
      peakGpuMB: Math.max(0, ...sampler.samples.map((s) => s.gpuMB || 0)),
      samples: sampler.samples.slice(-160),
    };
    result.ok = true;
  } catch (e) {
    result.error = String((e && e.message) || e);
    result.stderrTail = stderr.slice(-4000);
  } finally {
    sampler.stop();
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { try { child.kill(); } catch (_) { } }
    await sleep(700);
    try { fs.writeFileSync(path.join(outDir, 'bench-' + label.replace(/[^\w.-]+/g, '_') + '.json'), JSON.stringify(result, null, 1), 'utf8'); } catch (_) { }
  }
  return result;
}

function table(rows) {
  const lines = [];
  lines.push('| Метрика | ' + rows.map((r) => r.label).join(' | ') + ' |');
  lines.push('|---|---|' + rows.map(() => '---|').join(''));
  const add = (name, fn) => lines.push('| ' + name + ' | ' + rows.map((r) => { try { return fn(r); } catch (_) { return '—'; } }).join(' | ') + ' |');
  add('Файл', (r) => path.basename(r.file));
  add('Размер файла', (r) => r.fileSize ? (r.fileSize / 1e9).toFixed(2) + ' ГБ' : '—');
  add('Точек загружено', (r) => r.load.loadedPoints ? r.load.loadedPoints.toLocaleString('ru-RU') : '—');
  add('Старт приложения, с', (r) => fmt(r.times.startupMs / 1000, 2));
  add('Рабочая область, с', (r) => fmt(r.times.workspaceMs / 1000, 2));
  add('Начало загрузки облака, с', (r) => fmt(r.times.loadStartMs / 1000, 2));
  add('Первый кадр облака, с', (r) => fmt(r.times.firstFrameMs / 1000, 2));
  add('Полная загрузка, с', (r) => fmt(r.times.fullLoadMs / 1000, 2));
  add('Успокоение после загрузки, с', (r) => fmt((r.times.settleMs || 0) / 1000, 2));
  add('FPS вращение (10 с), avg', (r) => fmt(r.fps.avgFps, 1));
  add('FPS min / p95 кадра', (r) => fmt(r.fps.minFps, 1) + ' / ' + fmt(r.fps.p95FrameMs, 1) + ' мс');
  add('Задержка event-loop, макс', (r) => fmt(r.fps.maxLag, 1) + ' мс');
  add('JS heap', (r) => fmt(r.memory.heapMB, 0) + ' МБ');
  add('RSS Electron (пик/конец)', (r) => fmt(r.memory.peakRssMB, 0) + ' / ' + fmt(r.memory.finalRssMB, 0) + ' МБ');
  add('VRAM GPU (пик/конец)', (r) => fmt(r.memory.peakGpuMB, 0) + ' / ' + fmt(r.memory.finalGpuMB, 0) + ' МБ');
  add('HUD-скриншот', (r) => r.screenshots.hud ? path.basename(r.screenshots.hud) : '—');
  add('Статус', (r) => r.ok ? 'PASS' : ('FAIL: ' + String(r.error || '')).slice(0, 70));
  return lines.join('\n');
}

(async () => {
  const outDir = path.resolve(arg('out', DEFAULT_OUT));
  fs.mkdirSync(outDir, { recursive: true });
  const rotateSec = Number(arg('rotate-sec', '10'));
  const loadTimeoutMs = Number(arg('load-timeout-sec', '900')) * 1000;
  let jobs;
  if (has('all')) {
    jobs = [
      { file: arg('lixel', LIXEL), label: 'Lixel map.las', port: Number(arg('port', '9531')), opts: { rotateSec, loadTimeoutMs } },
      { file: arg('ours', OURS), label: 'Наш interior-r132', port: Number(arg('port', '9531')) + 1, opts: { rotateSec, loadTimeoutMs } },
    ];
  } else {
    const file = path.resolve(arg('file', LIXEL));
    jobs = [{ file, label: arg('label', path.basename(file, path.extname(file))), port: Number(arg('port', '9531')), opts: { rotateSec, loadTimeoutMs } }];
  }
  const rows = [];
  for (const j of jobs) {
    console.log('=== бенчмарк:', j.label, '|', j.file, '| порт', j.port);
    if (!fs.existsSync(j.file)) { console.error('ФАЙЛ НЕ НАЙДЕН:', j.file); continue; }
    const r = await benchOne(j.file, j.label, outDir, Object.assign({ port: j.port }, j.opts));
    rows.push(r);
    console.log(r.ok ? '  PASS: загрузка ' + fmt(r.times.fullLoadMs / 1000, 1) + ' с, FPS ' + fmt(r.fps.avgFps, 1) + ', HUD ' + r.screenshots.hud : '  FAIL: ' + r.error);
  }
  const summary = { generatedAt: new Date().toISOString(), app: ROOT, outDir, rows, table: table(rows) };
  fs.writeFileSync(path.join(outDir, 'bench-r145.json'), JSON.stringify(summary, null, 1), 'utf8');
  console.log('\n' + summary.table);
  console.log('\nJSON:', path.join(outDir, 'bench-r145.json'));
  process.exit(rows.filter((r) => !r.ok).length ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', (e && e.stack) || e); process.exit(1); });
