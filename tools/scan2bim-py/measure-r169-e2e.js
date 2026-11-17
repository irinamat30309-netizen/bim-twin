'use strict';
/* r169. E2E: настоящий Electron + «Инспектор объекта» через CDP (без puppeteer).
 *
 * Что делает:
 *  1) читает реальные облака D:\BIM-TWIN-TEST\interior\koridor-local-rgb.bin и map-mapcrop-facade.bin;
 *  2) вырезает кропы известных элементов (стена коридора 3.60 м по оси, двери 690–1500 мм,
 *     окно, фасадная стена/дверь);
 *  3) запускает штатное приложение (node_modules/electron/dist/electron.exe) с
 *     --remote-debugging-port, открывает инспектор, вкладку «Автоматически», вливает облако,
 *     нажимает «Измерить автоматически», снимает скриншоты окна инспектора в
 *     D:\BIM-TWIN-TEST\r55\measure-r169\;
 *  4) сверяет тип/размеры с эталоном, пишет measure-r169.json.
 *
 * Запуск: node tools/scan2bim-py/measure-r169-e2e.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const INT = 'D:\\BIM-TWIN-TEST\\interior';
const KOR = path.join(INT, 'koridor-local-rgb.bin');
const FAC = path.join(INT, 'map-mapcrop-facade.bin');
const OUT = 'D:\\BIM-TWIN-TEST\\r55\\measure-r169';
const PORT = 9419;
let AM = null;
try { AM = require(path.join(ROOT, 'renderer', 'auto-measure.js')); } catch (e) { AM = null; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
const r4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);

/* ---------- облака ---------- */
const binCache = {};
function binInfo(file) { if (!binCache[file]) { const buf = fs.readFileSync(file); binCache[file] = { buf, n: Math.floor(buf.length / 24) }; } return binCache[file]; }
function cropBin(file, c, u, nrm, hu, hn, y0, y1, maxPts) {
  const { buf, n } = binInfo(file), out = [];
  for (let i = 0; i < n; i++) {
    const o = i * 24, x = buf.readFloatLE(o), y = buf.readFloatLE(o + 4), z = buf.readFloatLE(o + 8);
    if (y < y0 || y > y1) continue;
    const dx = x - c[0], dz = z - c[2], a = dx * u[0] + dz * u[1], b = dx * nrm[0] + dz * nrm[1];
    if (Math.abs(a) > hu || Math.abs(b) > hn) continue;
    out.push(x, y, z);
  }
  let pos = new Float32Array(out);
  if (maxPts && pos.length / 3 > maxPts) {
    const st = Math.ceil(pos.length / 3 / maxPts), o2 = [];
    for (let i = 0; i < pos.length / 3; i += st) o2.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    pos = new Float32Array(o2);
  }
  return pos;
}
function dirOf(a, b) { const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz); return { u: [dx / L, dz / L], nrm: [-dz / L, dx / L], L }; }
function along(w, al) { const d = dirOf(w.a, w.b); return [w.a[0] + d.u[0] * al, w.a[1] + d.u[1] * al]; }

/* ---------- известные элементы ---------- */
// коридор: модели D:\BIM-TWIN-TEST\interior\koridor-details.json и py2-final-v5.json
const W0 = { a: [-0.7101, -7.8845], b: [-1.6631, 4.7045], th: 0.150, door: { along: 11.2366, w: 1.2159 } };
const W2 = { a: [-3.6148, -4.4629], b: [5.9745, -3.7817], th: 0.1587, door: { along: 4.1569, w: 0.8901 } };
const W5 = { a: [-1.1156, 1.9831], b: [-1.2713, 6.5084], th: 0.120, win: { along: 0.45, w: 1.392 } };   // окно витринного типа
// фасад: model py2-facade-mapcrop.json — толщина стены 0.2; стена 13.1 м
const FW = { a: [-5.7382, -2.2292], b: [7.2961, -3.5406], th: 0.200, L: 13.10 };

function buildCases() {
  const cases = [];
  const d0 = dirOf(W0.a, W0.b), p0 = along(W0, 7.90);
  cases.push({
    id: '01-koridor-wall-3600',
    label: 'Стена коридора, участок 3.60 м по оси',
    cloud: 'koridor-local-rgb.bin',
    pos: cropBin(KOR, [p0[0], 1.7, p0[1]], d0.u, d0.nrm, 1.8, 0.60, 0.2, 3.4, 240000),
    ref: { type: 'wall', dims: { 'wall-length': { v: 3.60, tol: 0.02 } }, note: 'кроп 3.60 м по оси стены (коридор)' }
  });
  const d2 = dirOf(W2.a, W2.b), p2 = along(W2, W2.door.along + W2.door.w / 2);
  cases.push({
    id: '02-koridor-door-890',
    label: 'Дверь коридора (проектная ширина 890–1500 мм)',
    cloud: 'koridor-local-rgb.bin',
    pos: cropBin(KOR, [p2[0], 1.2, p2[1]], d2.u, d2.nrm, 1.4, 0.50, 0.0, 2.7, 240000),
    ref: { type: 'opening', dims: { width: { range: [0.69, 1.5], model: W2.door.w, tol: 0.15 } }, note: 'дверь W2: модель 0.890 м, проектный ряд 690–1500 мм' }
  });
  const p0d = along(W0, W0.door.along + W0.door.w / 2);
  cases.push({
    id: '03-koridor-door-1216',
    label: 'Дверь коридора (проектная ширина 690–1500 мм)',
    cloud: 'koridor-local-rgb.bin',
    pos: cropBin(KOR, [p0d[0], 1.2, p0d[1]], d0.u, d0.nrm, 1.3, 0.45, 0.0, 2.7, 240000),
    ref: { type: 'opening', dims: { width: { range: [0.69, 1.5], model: W0.door.w, tol: 0.18 } }, note: 'дверь W0: модель 1.216 м' }
  });
  const d5 = dirOf(W5.a, W5.b), p5 = along(W5, W5.win.along + W5.win.w / 2);
  cases.push({
    id: '04-koridor-window-1392',
    label: 'Окно коридора (модель 1392 мм)',
    cloud: 'koridor-local-rgb.bin',
    pos: cropBin(KOR, [p5[0], 1.6, p5[1]], d5.u, d5.nrm, 1.6, 0.80, 0.0, 3.4, 240000),
    focus: [p5[0], 1.6, p5[1]],   // «Указать объект»: точка в проёме окна
    ref: { type: 'opening', dims: { width: { model: W5.win.w, tol: 0.18 } }, note: 'окно W5: модель 1.392 м' }
  });
  const dF = dirOf(FW.a, FW.b), pF = along(FW, 11.5);
  cases.push({
    id: '05-facade-wall',
    label: 'Фасадная стена (толщина 200 мм, вид снаружи)',
    cloud: 'map-mapcrop-facade.bin',
    pos: cropBin(FAC, [pF[0], 2.7, pF[1]], dF.u, dF.nrm, 1.8, 0.35, 0.5, 5.0, 240000),
    ref: { type: 'wall', note: 'плоский участок фасада; толщину с одной стороны не измерить' }
  });
  return cases;
}

/* фасадная дверь: положение берём из полного анализа облака движком (эталон = вся геометрия) */
function facadeDoorCase() {
  if (!AM) return null;
  const { buf, n } = binInfo(FAC), step = Math.ceil(n / 260000), out = [];
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i += step) {
    const o = i * 24, x = buf.readFloatLE(o), y = buf.readFloatLE(o + 4), z = buf.readFloatLE(o + 8);
    out.push(x, y, z);
    if (x < mn[0]) mn[0] = x; if (y < mn[1]) mn[1] = y; if (z < mn[2]) mn[2] = z;
    if (x > mx[0]) mx[0] = x; if (y > mx[1]) mx[1] = y; if (z > mx[2]) mx[2] = z;
  }
  const r = AM.analyze(new Float32Array(out), {});
  if (!r.ok || !r.main || r.main.type !== 'opening') return null;
  const m = r.main, c0 = r.info.c0;
  const wd = m.dims.find((d) => d.key === 'width'), hd = m.dims.find((d) => d.key === 'height');
  if (!wd || !wd.a || !wd.b) return null;
  let c = [(wd.a[0] + wd.b[0]) / 2, (wd.a[1] + wd.b[1]) / 2, (wd.a[2] + wd.b[2]) / 2];
  const inBox = (p) => p[0] >= mn[0] - 0.1 && p[0] <= mx[0] + 0.1 && p[1] >= mn[1] - 0.1 && p[1] <= mx[1] + 0.1 && p[2] >= mn[2] - 0.1 && p[2] <= mx[2] + 0.1;
  if (!inBox(c)) c = c.map((v, k) => v - c0[k]);   // у проёма-«дыры» центр может быть в двойной системе координат
  const dx = wd.b[0] - wd.a[0], dz = wd.b[2] - wd.a[2], L = Math.hypot(dx, dz);
  const u = L > 0.05 ? [dx / L, dz / L] : [1, 0];
  const nrm = [-u[1], u[0]];
  const got = r.objects.filter((o) => o.type === 'opening').map((o) => ({ title: o.title, width: (o.dims.find((d) => d.key === 'width') || {}).value }));
  return {
    id: '06-facade-door', label: 'Фасадная дверь (по полному анализу облака)',
    cloud: 'map-mapcrop-facade.bin',
    pos: cropBin(FAC, c, u, nrm, 1.5, 0.55, Math.max(0, c[1] - 1.1), c[1] + 1.4, 240000),
    ref: { type: 'opening', dims: { width: { model: wd.value, tol: 0.15 } }, note: 'эталон — ширина проёма по полному облаку: ' + r3(wd.value) + ' м; центр ' + c.map((v) => r3(v)).join(',') },
    extra: got.slice(0, 4)
  };
}

/* ---------- CDP ---------- */
async function connect(port, filter, timeoutMs) {
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
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
        return { ws, send };
      }
    } catch (_) { }
    await sleep(300);
  }
  throw new Error('CDP: страница не появилась (' + filter + ')');
}
async function ev(send, expression, timeoutMs) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs || 180000 });
  if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r.result && r.result.value;
}
async function shot(send, file, clip) {
  const params = { format: 'png' };
  if (clip) params.clip = { x: Math.max(0, clip.x), y: Math.max(0, clip.y), width: Math.max(50, clip.w), height: Math.max(50, clip.h), scale: 1 };
  const s = await send('Page.captureScreenshot', params);
  fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
  return fs.statSync(file).size;
}
async function waitFor(send, expression, timeoutMs, everyMs) {
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    try { if (await ev(send, expression, 30000)) return true; } catch (_) { }
    await sleep(everyMs || 250);
  }
  return false;
}
async function modalRect(send) {
  try {
    return await ev(send, `(() => { const w = document.querySelector('.lx-win'); if (!w) return null; const r = w.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`, 15000);
  } catch (_) { return null; }
}
function posB64(pos) { return Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength).toString('base64'); }
function summaryOf() {
  // выполняется в странице: краткая сводка результата автозамера
  return `(() => {
    const st = window.__lxObjectInspector && window.__lxObjectInspector.state;
    if (!st || !st.auto || !st.auto.res) return null;
    const res = st.auto.res;
    const dims = (ob) => (ob && ob.dims ? ob.dims.map((d) => ({ key: d.key, label: d.label, value: d.value, sigma: d.sigma, level: d.level, how: d.how, ref: !!d.ref })) : []);
    const m = res.main;
    const cls = res.info && res.info.classification;
    return {
      ok: res.ok, error: res.error || null, used: res.info && res.info.used, ms: res.info && res.info.ms,
      classification: cls ? { type: cls.type, kind: cls.kind, shape: cls.shape, confidence: cls.confidence,
        probabilities: (cls.probabilities || []).map((p) => ({ type: p.type, kind: p.kind, probability: p.probability })),
        other: cls.otherProbability, hypotheses: (cls.hypotheses || []).slice(0, 4) } : null,
      main: m ? { title: m.title, type: m.type, clsType: m.clsType || null, pts: m.pointsUsed, dims: dims(m) } : null,
      objects: (res.objects || []).slice(0, 6).map((o) => ({ title: o.title, type: o.type, clsType: o.clsType || null, rank: o.rank, pts: o.pointsUsed, dims: dims(o) })),
      savedDims: Object.keys(st.auto.saved || {}).length,
      cards: document.querySelectorAll('#lxInsAutoOut .lx-auto-card').length,
      stateText: (document.querySelector('#lxInsAutoState') || {}).textContent || ''
    };
  })()`;
}

/* ---------- main ---------- */
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const log = [];
  const say = (s) => { console.log(s); log.push({ t: new Date().toISOString(), msg: s }); };
  say('r169 E2E: старт, папка ' + OUT);
  const cases = buildCases();
  say('кропы: ' + cases.map((c) => c.id + '=' + Math.round(c.pos.length / 3) + 'т').join(', '));
  let fd = null;
  try { fd = facadeDoorCase(); } catch (e) { say('фасадная дверь: ' + e.message); }
  if (fd) { cases.push(fd); say('фасадная дверь кроп: ' + Math.round(fd.pos.length / 3) + 'т, эталон ' + (fd.ref && fd.ref.dims.width.model)); }

  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const PLY = path.join(INT, 'koridor-local-rgb.ply');
  const child = spawn(EXE, ['.', fs.existsSync(PLY) ? PLY : '', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (d) => { stderr = (stderr + String(d)).slice(-8000); });
  say('electron pid ' + child.pid + ', порт ' + PORT);
  let send = null;
  try {
    let page = null;
    try { page = await connect(PORT, /index\.html/, 90000); }
    catch (e) {
      say('index.html не появился, пробую startup → открыть проект');
      const st = await connect(PORT, /startup\.html/, 30000);
      await sleep(1200);
      await ev(st.send, `(() => { const b = document.getElementById('openProject'); if (b && !b.disabled) { b.click(); return 'open'; } const c = document.querySelector('.st-card:not(.st-new)'); if (c) { c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 'card'; } const n = document.getElementById('newProject'); if (n) { n.click(); return 'new'; } return null; })()`, 30000);
      try { st.ws.close(); } catch (_) { }
      page = await connect(PORT, /index\.html/, 120000);
    }
    send = page.send;
    say('workspace открыт');
    // закрыть возможные стартовые диалоги
    try {
      await ev(send, `(() => { const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.offsetParent !== null); const t = btns.find((b) => /Продолжить|Показать все|Все равно|Всё равно|Открыть максимум|Да, загрузить|Загрузить всё/i.test(b.textContent || '')); if (t) { t.click(); return t.textContent.trim(); } return null; })()`, 20000);
    } catch (_) { }
    const ready = await waitFor(send, `!!(window.__lxObjectInspector && window.AutoMeasure && window.AutoMeasure.analyze)`, 90000, 400);
    say('инспектор готов: ' + ready);
    if (!ready) throw new Error('инспектор не загрузился');

    const results = [];
    for (const c of cases) {
      say('\n== ' + c.id + ' — ' + c.label + ' (' + Math.round(c.pos.length / 3) + ' точек) ==');
      const b64 = posB64(c.pos);
      try {
        await ev(send, `(() => {
          const bin = atob(${JSON.stringify(b64)}), u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          const pos = new Float32Array(u8.buffer.slice(0));
          window.__lxObjectInspector.open({ pos: pos, count: pos.length / 3 }, ${JSON.stringify(c.label)});
          document.querySelector('#lxInsTab-auto').click();
          window.__lxObjectInspector.state.focus = ${JSON.stringify(c.focus || null)};
          document.querySelector('#lxInsAutoBtn').click();
          return { count: pos.length / 3 };
        })()`, 300000);
        const done = await waitFor(send, `(() => { const a = window.__lxObjectInspector.state.auto; return !!(a && !a.busy && a.res); })()`, 60000, 300);
        if (!done) throw new Error('автозамер не завершился');
        await sleep(500);
        const sum = await ev(send, summaryOf(), 60000);
        // раскрыть «Ещё найдено» для информативного скриншота, если есть
        try { await ev(send, `(() => { const b = document.querySelector('#lxInsAutoMore'); if (b && b.getAttribute('aria-expanded') === 'false') b.click(); return true; })()`, 15000); await sleep(250); } catch (_) { }
        const rect = await modalRect(send);
        const png = path.join(OUT, c.id + '.png');
        await shot(send, png, rect || undefined);
        // второй кадр: прокрутить панель к размерам (чтобы в скриншоте были значения)
        let pngDims = null;
        try {
          await ev(send, `(() => {
            const row = document.querySelector('#lxInsAutoOut .lx-auto-card.main .lx-auto-row');
            let el = row;
            while (el && el !== document.documentElement) {
              if (el.scrollHeight > el.clientHeight + 12 && getComputedStyle(el).overflowY !== 'visible') { el.scrollTop = Math.min(el.scrollHeight, 300); return true; }
              el = el.parentElement;
            }
            const side = document.querySelector('.lx-win-side'); if (side) { side.scrollTop = 300; return true; }
            return false;
          })()`, 15000);
          await sleep(300);
          const rect2 = await modalRect(send);
          pngDims = path.join(OUT, c.id + '-dims.png');
          await shot(send, pngDims, rect2 || undefined);
        } catch (_) { }
        say('  классификатор: ' + (sum.classification ? sum.classification.type + ' (' + sum.classification.kind + ', ' + Math.round(100 * sum.classification.confidence) + '%)' : '—'));
        say('  главный: ' + (sum.main ? sum.main.title + ' [' + sum.main.dims.map((d) => d.key + '=' + r3(d.value) + '(' + d.level + ')').join(', ') + ']' : '—'));
        // вердикт
        const ref = c.ref || {}, dims = ref.dims || {}, mainDims = {};
        (sum.main ? sum.main.dims : []).forEach((d) => { mainDims[d.key] = d; });
        const checks = [];
        if (ref.type) checks.push({ what: 'тип', expect: ref.type, got: sum.classification ? sum.classification.type : sum.main && sum.main.type, pass: (sum.classification ? sum.classification.type : sum.main && sum.main.type) === ref.type || (sum.main && sum.main.clsType) === ref.type });
        Object.keys(dims).forEach((k) => {
          const spec = dims[k], d = mainDims[k];
          if (!d) { checks.push({ what: k, expect: spec, got: null, pass: false }); return; }
          let pass = false, delta = null;
          if (spec.range) pass = d.value >= spec.range[0] && d.value <= spec.range[1];
          else if (spec.model != null && spec.tol != null) { delta = d.value - spec.model; pass = Math.abs(delta) <= spec.tol; }
          else if (spec.v != null && spec.tol != null) { delta = d.value - spec.v; pass = Math.abs(delta) <= spec.tol; }
          checks.push({ what: k, expect: spec, got: r4(d.value), delta: delta == null ? null : r4(delta), pass: pass });
        });
        // главное не «труба» на не-трубных элементах
        if (ref.type && ref.type !== 'pipe') checks.push({ what: 'не труба', expect: 'не cylinder', got: sum.main ? sum.main.type : null, pass: !sum.main || sum.main.type !== 'cylinder' });
        const pass = checks.every((x) => x.pass);
        say('  вердикт: ' + (pass ? 'PASS' : 'FAIL') + ' ' + checks.map((x) => x.what + (x.pass ? '✓' : '✗(' + JSON.stringify(x.got) + ')')).join(' '));
        results.push({ id: c.id, label: c.label, cloud: c.cloud, points: Math.round(c.pos.length / 3), ref: c.ref, focus: c.focus || null, summary: sum, checks, pass, screenshot: png, screenshotDims: pngDims, ms: sum.ms });
        // повторный замер кнопкой «Измерить заново» — для второго кейса (проверка, что тип/размеры те же и нет дублей)
        if (c.id === '02-koridor-door-890') {
          const before = await ev(send, `(() => ({ cards: document.querySelectorAll('#lxInsAutoOut .lx-auto-card').length, saved: Object.keys(window.__lxObjectInspector.state.auto.saved || {}).length, label: (document.querySelector('#lxInsAutoBtn .lbl') || {}).textContent }))()`, 15000);
          await ev(send, `(() => { document.querySelector('#lxInsAutoBtn').click(); return true; })()`, 15000);
          await waitFor(send, `(() => { const a = window.__lxObjectInspector.state.auto; return !!(a && !a.busy && a.res); })()`, 60000, 300);
          await sleep(500);
          const sum2 = await ev(send, summaryOf(), 60000);
          const after = await ev(send, `(() => ({ cards: document.querySelectorAll('#lxInsAutoOut .lx-auto-card').length, saved: Object.keys(window.__lxObjectInspector.state.auto.saved || {}).length, label: (document.querySelector('#lxInsAutoBtn .lbl') || {}).textContent }))()`, 15000);
          const rect2 = await modalRect(send);
          const png2 = path.join(OUT, c.id + '-repeat.png');
          await shot(send, png2, rect2 || undefined);
          const same = sum2.main && sum.main && sum2.main.title === sum.main.title && Math.abs((sum2.main.dims.find((d) => d.key === 'width') || {}).value - (sum.main.dims.find((d) => d.key === 'width') || {}).value) < 1e-6;
          const noDup = after.saved === before.saved && after.cards >= 1;
          say('  повтор: ' + (same ? 'те же тип/размер' : 'ИЗМЕНИЛОСЬ') + ', карточек ' + before.cards + '→' + after.cards + ', сохранено ' + before.saved + '→' + after.saved + ', кнопка «' + after.label + '»');
          results.push({ id: c.id + '-repeat', label: 'повтор «Измерить заново»', before, after, same, pass: !!same && noDup, screenshot: png2, summary: sum2 });
        }
      } catch (e) {
        say('  ОШИБКА: ' + e.message);
        results.push({ id: c.id, label: c.label, pass: false, error: e.message });
      }
    }
    const passed = results.filter((x) => x.pass).length;
    const report = { tool: 'measure-r169-e2e.js', created_at: new Date().toISOString(), app: 'BIM Twin Electron (CDP)', port: PORT, out: OUT, results, summary: { total: results.length, pass: passed, fail: results.length - passed, electronStderrTail: stderr.slice(-1500) } };
    fs.writeFileSync(path.join(OUT, 'measure-r169.json'), JSON.stringify(report, null, 1), 'utf8');
    fs.writeFileSync(path.join(OUT, 'measure-r169.log'), log.map((l) => l.msg).join('\n'), 'utf8');
    console.log('\nИТОГ: PASS ' + passed + ' / ' + results.length + '; JSON: ' + path.join(OUT, 'measure-r169.json'));
    for (const r of results) console.log('  ' + (r.pass ? 'PASS' : 'FAIL') + '  ' + r.id + (r.error ? ' — ' + r.error : ''));
  } catch (e) {
    console.error('E2E ОШИБКА:', e && e.stack || e);
    fs.writeFileSync(path.join(OUT, 'measure-r169.log'), log.map((l) => l.msg).join('\n') + '\nE2E ERROR: ' + (e && e.stack || e), 'utf8');
    process.exitCode = 1;
  } finally {
    try { if (send && child.pid) await ev(send, 'true', 5000); } catch (_) { }
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { try { child.kill(); } catch (_) { } }
    await sleep(1200);
  }
})();
