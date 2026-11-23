/* BIM Twin — r145: панель «Производительность» (FPS/точки/память/бюджет)
 * + настройка качества отображения «авто / высокое / быстрое» и цветокоррекция
 * «Яркость / Контраст / Насыщенность» + пресет «Как в Lixel».
 *
 * Отдельный оверлей в стиле lx-* (палитра violet #a78bfa / #6a52cb, graphite #1c1b1a / #232221,
 * без синего/чистого белого/градиентов). Загружается из app.js динамически (index.html не правится).
 * Не мешает r130: крупные подписи ленты, светлая тема с тёмным 3D и привязка off остаются.
 *
 * API: window.__lxPerf = { open, close, toggle, isOpen, state, attach, apply }
 */
(function () {
  'use strict';
  var W = window, D = document;
  var Wkey = 'bim.perf.';
  var st = { panel: null, pill: null, open: false, timer: 0, raf: 0, frames: 0, fps: 0, last: 0, lastTick: 0, installed: false };

  function store(k, v) {
    try {
      if (v === undefined) return W.localStorage.getItem(Wkey + k);
      W.localStorage.setItem(Wkey + k, String(v));
    } catch (e) { }
    return null;
  }
  function num(k, d) { var v = Number(store(k, d)); return isFinite(v) ? v : d; }
  function bool(k, d) { var v = store(k, d); return v === null ? d : v !== '0'; }
  function viewer() { return W.__viewer || W.__lxViewer || null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtMln(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' млн';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.', ',') + ' тыс.';
    return String(Math.round(n));
  }
  function pct(v, d) { return isFinite(v) ? (v * 100).toFixed(d == null ? 0 : d) + ' %' : '—'; }

  var CSS = [
    '.lx-perf-pill { position: fixed; left: 10px; bottom: 34px; z-index: 520; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px; border: 1px solid var(--line, #3a3642); border-radius: 999px; background: var(--glass, rgba(28,27,26,.86)); color: var(--txt-2, #cfc9d9); font: 500 10.5px/1 var(--mono, monospace); cursor: pointer; box-shadow: var(--shadow-3, 0 8px 24px rgba(0,0,0,.35)); }',
    '.lx-perf-pill:hover { color: var(--txt, #f2eff7); border-color: var(--accent-line, #6a52cb); }',
    '.lx-perf-pill b { color: var(--accent, #a78bfa); font-weight: 700; font-variant-numeric: tabular-nums; }',
    '.lx-perf { position: fixed; left: 12px; bottom: 66px; z-index: 521; width: 300px; max-width: calc(100vw - 24px); max-height: min(68vh, 560px); overflow: auto; border: 1px solid var(--accent-line, #6a52cb); border-radius: var(--r-3, 10px); background: var(--bg-1, #1c1b1a); color: var(--txt, #f2eff7); box-shadow: var(--shadow-3, 0 18px 48px rgba(0,0,0,.45)); font: 11px/1.35 var(--font, sans-serif); }',
    '.lx-perf[hidden] { display: none; }',
    '.lx-perf-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--line, #3a3642); background: var(--bg-2, #232221); }',
    '.lx-perf-head b { flex: 1; color: var(--txt, #f2eff7); font-size: 11.5px; font-weight: 600; letter-spacing: .02em; }',
    '.lx-perf-head .lx-perf-x { width: 20px; height: 20px; border: 0; border-radius: 6px; background: transparent; color: var(--txt-3, #9a93a8); font: 600 14px/1 var(--font); cursor: pointer; }',
    '.lx-perf-head .lx-perf-x:hover { background: var(--bg-3, #2e2c30); color: var(--txt, #f2eff7); }',
    '.lx-perf-body { display: flex; flex-direction: column; gap: 7px; padding: 9px 10px 10px; }',
    '.lx-perf-kpi { display: grid; grid-template-columns: 1fr auto; gap: 6px 8px; padding: 7px 8px; border: 1px solid var(--line, #3a3642); border-radius: var(--r-2, 8px); background: var(--bg-2, #232221); font-variant-numeric: tabular-nums; }',
    '.lx-perf-kpi .k { color: var(--txt-3, #9a93a8); font-size: 10.5px; }',
    '.lx-perf-kpi .v { color: var(--txt, #f2eff7); font: 600 11px/1.2 var(--mono, monospace); text-align: right; }',
    '.lx-perf-kpi .v.ok { color: var(--ok, #5cc98b); }',
    '.lx-perf-kpi .v.warn { color: var(--warn, #e0a63c); }',
    '.lx-perf-kpi .v.err { color: var(--err, #e06c75); }',
    '.lx-perf-fps { display: flex; align-items: baseline; gap: 8px; }',
    '.lx-perf-fps b { color: var(--accent, #a78bfa); font: 600 22px/1 var(--font, sans-serif); font-variant-numeric: tabular-nums; }',
    '.lx-perf-fps small { color: var(--txt-3, #9a93a8); font: 10px/1 var(--mono, monospace); }',
    '.lx-perf-sec { color: var(--txt-3, #9a93a8); font: 600 9.5px/1.3 var(--mono, monospace); letter-spacing: .08em; text-transform: uppercase; margin-top: 2px; }',
    '.lx-perf-row { display: flex; align-items: center; gap: 7px; }',
    '.lx-perf-row > span.l { flex: 0 0 96px; color: var(--txt-2, #cfc9d9); font-size: 10.5px; }',
    '.lx-perf-row input[type="range"] { flex: 1; min-width: 0; accent-color: var(--accent, #a78bfa); }',
    '.lx-perf-row output { flex: 0 0 38px; color: var(--txt-3, #9a93a8); font: 10px/1 var(--mono, monospace); text-align: right; font-variant-numeric: tabular-nums; }',
    '.lx-perf-sel { width: 100%; height: 26px; padding: 0 7px; border: 1px solid var(--line, #3a3642); border-radius: var(--r-1, 6px); background: var(--bg-2, #232221); color: var(--txt, #f2eff7); font: 11px/1 var(--font, sans-serif); }',
    '.lx-perf-btn { height: 26px; padding: 0 9px; border: 1px solid var(--accent-line, #6a52cb); border-radius: var(--r-1, 6px); background: var(--accent-soft, rgba(106,82,203,.18)); color: var(--accent, #a78bfa); font: 600 10.5px/1 var(--font, sans-serif); cursor: pointer; }',
    '.lx-perf-btn:hover { background: var(--accent-fill, #6a52cb); color: var(--on-accent, #fff); }',
    '.lx-perf-btn.sub { border-color: var(--line, #3a3642); background: transparent; color: var(--txt-2, #cfc9d9); font-weight: 500; }',
    '.lx-perf-note { margin: 0; color: var(--txt-3, #9a93a8); font-size: 9.5px; line-height: 1.4; }',
    '.lx-perf-chk { display: flex; align-items: center; gap: 7px; color: var(--txt-2, #cfc9d9); font-size: 10.5px; cursor: pointer; }',
    '.lx-perf-chk input { accent-color: var(--accent, #a78bfa); }',
    '.lx-perf .lx-btnrow { display: flex; gap: 6px; flex-wrap: wrap; }',
    '@media (max-width: 900px) { .lx-perf { width: calc(100vw - 24px); } }'
  ].join('\n');

  function ensureStyles() {
    if (!D || D.getElementById('lxPerfStyles')) return;
    var s = D.createElement('style'); s.id = 'lxPerfStyles'; s.textContent = CSS;
    (D.head || D.documentElement).appendChild(s);
  }

  function metrics() {
    var v = viewer(), b = v && v.base && v.base[0];
    var loaded = 0, total = 0, cs = null;
    if (b) {
      loaded = (b._gpuCount | 0) || (b.count | 0) || 0;
      total = b._stream && b._stream.total ? b._stream.total : loaded;
      if (b._stream && b._stream.srcTotal && b._stream.srcTotal > total) total = b._stream.srcTotal;
    }
    try { cs = v && v.getCullStats ? v.getCullStats() : null; } catch (e) { }
    var heapMB = null;
    try { if (W.performance && performance.memory) heapMB = Math.round(performance.memory.usedJSHeapSize / 1048576); } catch (e) { }
    var vramMB = Math.round(loaded * 15 / 1048576);   // 12 Б позиции + 3 Б цвета на точку (оценка видеопамяти)
    var budget = (v && (v._interPts | 0)) || 0;
    var moving = !!(v && v._interacting);
    return {
      fps: st.fps, frameMs: st.fps > 0 ? +(1000 / st.fps).toFixed(1) : 0,
      loaded: loaded, total: total, drawn: cs ? (cs.drawn | 0) : loaded, visible: cs ? (cs.visible | 0) : loaded,
      budget: budget, interBudget: (v && (v._interBudget | 0)) || 0,
      moving: moving, renderScale: v ? (v.getRenderScale ? v.getRenderScale() : (v._renderScale || 1)) : 1,
      heapMB: heapMB, vramMB: vramMB, quality: v ? (v.qualityMode ? v.qualityMode() : (v._qualityMode || 'auto')) : 'auto',
      autoPoint: !!(v && v._autoPointSize), grade: !!(v && v._grade && v._grade.on), bright: v ? (v._ptBright || 1) : 1,
      pointSize: b && v && v._cloudDisplay ? (v._cloudDisplay.pointSize == null ? 'авто' : v._cloudDisplay.pointSize) : null
    };
  }

  function readPrefs() {
    function g(k, d) { try { var v = W.localStorage.getItem(Wkey + k); return v == null ? d : v; } catch (e) { return d; } }
    var q = g('quality', 'auto'); if (['auto', 'high', 'fast'].indexOf(q) < 0) q = 'auto';
    var look = g('look', 'neutral'); if (['lixel', 'neutral', 'custom'].indexOf(look) < 0) look = 'neutral';
    var b = Number(g('brightness', 1.0)); if (!isFinite(b)) b = 1.0;
    var c = Number(g('contrast', 1.0)); if (!isFinite(c)) c = 1.0;
    var s = Number(g('saturation', 1.0)); if (!isFinite(s)) s = 1.0;
    return { quality: q, look: look, autoPoint: g('autoPoint', '1') !== '0', brightness: b, contrast: c, saturation: s };
  }
  function applyPrefs() {
    var v = viewer(); if (!v) return null;
    var p = readPrefs();
    try { if (v.setQualityMode) v.setQualityMode(p.quality); } catch (e) { }
    try { if (v.setAutoPointSize) v.setAutoPointSize(p.autoPoint); } catch (e) { }
    try {
      if (p.look === 'lixel') { if (v.setLixelLook) v.setLixelLook(true); }
      else if (p.look === 'neutral') { if (v.setBrightness) v.setBrightness(1.0); if (v.setGrade) v.setGrade(false); }
      else {
        if (v.setBrightness) v.setBrightness(p.brightness);
        if (v.setGrade) v.setGrade({ on: true, exposure: 1, contrast: p.contrast, saturation: p.saturation, gamma: 1, tone: 0 });
      }
    } catch (e) { }
    return p;
  }
  function savePrefs(part) {
    for (var k in part) if (Object.prototype.hasOwnProperty.call(part, k)) store(k, part[k] === true ? '1' : part[k] === false ? '0' : part[k]);
  }

  function html() {
    var p = readPrefs();
    return '<div class="lx-perf-head"><b>Производительность</b><button type="button" class="lx-perf-x" data-perf="close" aria-label="Закрыть">×</button></div>' +
      '<div class="lx-perf-body">' +
      '<div class="lx-perf-kpi"><span class="lx-perf-fps"><b data-perf-fps>' + Math.round(st.fps) + '</b><small>FPS</small><small data-perf-frame>—</small></span>' +
      '<span class="v" data-perf-mode>—</span></div>' +
      '<div class="lx-perf-kpi">' +
      '<span class="k">Показано точек</span><span class="v" data-perf-points>—</span>' +
      '<span class="k">Всего в облаке</span><span class="v" data-perf-total>—</span>' +
      '<span class="k">Бюджет при движении</span><span class="v" data-perf-budget>—</span>' +
      '<span class="k">Эффективный бюджет VRAM (≤5 ГБ)</span><span class="v" data-perf-vram>—</span>' +
      '<span class="k">Память JS / VRAM (оценка)</span><span class="v" data-perf-mem>—</span>' +
      '<span class="k">Разрешение рендера</span><span class="v" data-perf-scale>—</span>' +
      '<span class="k">GPU</span><span class="v" data-perf-gpu style="max-width:170px;overflow:hidden;text-overflow:ellipsis">—</span>' +
      '</div>' +
      '<div class="lx-perf-sec">Качество отображения</div>' +
      '<select class="lx-perf-sel" data-perf-quality aria-label="Качество отображения">' +
      '<option value="auto">Авто — баланс качества и FPS</option>' +
      '<option value="high">Высокое — все точки в покое, резко</option>' +
      '<option value="fast">Быстрое — максимум FPS при вращении</option>' +
      '</select>' +
      '<div class="lx-perf-sec">Цвет и яркость</div>' +
      '<div class="lx-perf-row"><span class="l">Яркость</span><input type="range" data-perf-bright min="0.5" max="2.2" step="0.01" value="' + p.brightness + '"><output data-perf-bright-out>' + p.brightness.toFixed(2) + '</output></div>' +
      '<div class="lx-perf-row"><span class="l">Контраст</span><input type="range" data-perf-contrast min="0.6" max="1.8" step="0.01" value="' + p.contrast + '"><output data-perf-contrast-out>' + p.contrast.toFixed(2) + '</output></div>' +
      '<div class="lx-perf-row"><span class="l">Насыщенность</span><input type="range" data-perf-sat min="0.4" max="2" step="0.01" value="' + p.saturation + '"><output data-perf-sat-out>' + p.saturation.toFixed(2) + '</output></div>' +
      '<div class="lx-perf .lx-btnrow" style="display:flex;gap:6px;flex-wrap:wrap">' +
      '<button type="button" class="lx-perf-btn" data-perf="lixel" title="Яркость ×1.36, насыщенность ×1.29 — под эталон Lixel, точки не размываются">Как в Lixel</button>' +
      '<button type="button" class="lx-perf-btn sub" data-perf="neutral">Нейтрально</button>' +
      '<button type="button" class="lx-perf-btn sub" data-perf="reset" title="Сбросить настройки рендера">Сброс</button>' +
      '</div>' +
      '<label class="lx-perf-chk"><input type="checkbox" data-perf-autopoint ' + (p.autoPoint ? 'checked' : '') + '>Адаптивный размер точки (2–3 px, в движении не меньше 2 px)</label>' +
      '<p class="lx-perf-note">Слева внизу — кнопка «FPS»; горячая клавиша F2. «Показано» при вращении — бюджет, в покое — все загруженные точки. VRAM — оценка по 15 Б/точку.</p>' +
      '</div>';
  }

  function panel() {
    if (st.panel && st.panel.isConnected) return st.panel;
    ensureStyles();
    var p = D.createElement('section');
    p.className = 'lx-perf'; p.id = 'lxPerfPanel'; p.setAttribute('data-perf-panel', '1'); p.hidden = true;
    p.innerHTML = html();
    D.body.appendChild(p);
    p.addEventListener('click', onClick);
    p.addEventListener('input', onInput);
    p.addEventListener('change', onChange);
    st.panel = p;
    return p;
  }
  function pill() {
    if (st.pill && st.pill.isConnected) return st.pill;
    ensureStyles();
    var b = D.createElement('button');
    b.type = 'button'; b.className = 'lx-perf-pill'; b.id = 'lxPerfPill'; b.setAttribute('data-perf-pill', '1');
    b.innerHTML = '<span>FPS</span><b data-perf-pill-fps>—</b>';
    b.title = 'Производительность: FPS, точки, память, бюджет (F2)';
    b.addEventListener('click', function () { toggle(); });
    D.body.appendChild(b);
    st.pill = b;
    return b;
  }

  function paint() {
    if (!st.open || !st.panel) return;
    var p = st.panel, m = metrics();
    function q(sel) { return p.querySelector(sel); }
    var fpsEl = q('[data-perf-fps]'); if (fpsEl) fpsEl.textContent = String(Math.round(m.fps));
    var fr = q('[data-perf-frame]'); if (fr) fr.textContent = m.frameMs ? m.frameMs + ' мс' : '—';
    var mode = q('[data-perf-mode]'); if (mode) { mode.textContent = m.moving ? 'вращение' : 'покой'; mode.className = 'v ' + (m.moving ? 'warn' : 'ok'); }
    var pts = q('[data-perf-points]'); if (pts) pts.textContent = fmtMln(m.drawn) + ' из ' + fmtMln(m.loaded);
    var tot = q('[data-perf-total]'); if (tot) tot.textContent = fmtMln(m.total);
    var bud = q('[data-perf-budget]'); if (bud) bud.textContent = m.budget ? fmtMln(m.budget) : 'все';
    var vramBud = q('[data-perf-vram]');
    if (vramBud) { try { var eb = (W.__bimEffectiveBudget && W.__bimEffectiveBudget()) || 0; vramBud.textContent = eb ? fmtMln(eb) + ' ≈ ' + ((eb * 15) / 1073741824).toFixed(1).replace('.', ',') + ' ГБ' : '—'; } catch (e) { vramBud.textContent = '—'; } }
    var mem = q('[data-perf-mem]'); if (mem) mem.textContent = (m.heapMB != null ? m.heapMB + ' МБ' : '—') + ' / ~' + fmtMln(m.vramMB * 1048576);
    var sc = q('[data-perf-scale]'); if (sc) sc.textContent = Math.round(m.renderScale * 100) + ' %';
    var gpu = q('[data-perf-gpu]'); if (gpu && !gpu.title) { try { var c = D.createElement('canvas'); var gl = c.getContext('webgl2'); var d = gl && gl.getExtension('WEBGL_debug_renderer_info'); gpu.textContent = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'WebGL2'; gpu.title = gpu.textContent; } catch (e) { gpu.textContent = 'WebGL2'; } }
  }
  function tick() {
    var now = (W.performance && performance.now) ? performance.now() : Date.now();
    st.frames++;
    if (!st.lastTick) { st.lastTick = now; st.last = now; }
    if (now - st.lastTick >= 500) {
      st.fps = +(st.frames * 1000 / (now - st.lastTick)).toFixed(1);
      st.frames = 0; st.lastTick = now;
      var pf = st.pill && st.pill.querySelector('[data-perf-pill-fps]'); if (pf) pf.textContent = st.fps ? String(Math.round(st.fps)) : '—';
      paint();
    }
    st.raf = W.requestAnimationFrame ? W.requestAnimationFrame(tick) : setTimeout(tick, 16);
  }

  function onClick(e) {
    var n = e.target && e.target.closest && e.target.closest('[data-perf]');
    if (!n) return;
    var act = n.getAttribute('data-perf');
    if (act === 'close') { close(); return; }
    if (act === 'lixel') { savePrefs({ look: 'lixel', brightness: 1.36, saturation: 1.29, contrast: 1, autoPoint: true }); applyPrefs(); syncInputs(); paint(); return; }
    if (act === 'neutral') { savePrefs({ look: 'neutral' }); applyPrefs(); syncInputs(); paint(); return; }
    if (act === 'reset') {
      savePrefs({ quality: 'auto', look: 'neutral', autoPoint: true, brightness: 1.0, contrast: 1.0, saturation: 1.0 });
      applyPrefs(); syncInputs(); paint();
    }
  }
  function onInput(e) {
    var t = e.target; if (!t || !t.matches) return;
    if (t.matches('[data-perf-bright]')) { savePrefs({ look: 'custom', brightness: +t.value }); applyPrefs(); syncInputs(); }
    else if (t.matches('[data-perf-contrast]')) { savePrefs({ look: 'custom', contrast: +t.value }); applyPrefs(); syncInputs(); }
    else if (t.matches('[data-perf-sat]')) { savePrefs({ look: 'custom', saturation: +t.value }); applyPrefs(); syncInputs(); }
    else if (t.matches('[data-perf-autopoint]')) { savePrefs({ autoPoint: !!t.checked }); applyPrefs(); }
  }
  function onChange(e) {
    var t = e.target;
    if (t && t.matches && t.matches('[data-perf-quality]')) {
      savePrefs({ quality: t.value });
      var v = viewer(); try { if (v && v.setQualityMode) v.setQualityMode(t.value); } catch (e2) { }
      paint();
    }
  }
  function syncInputs() {
    if (!st.panel) return;
    var p = st.panel, r = readPrefs();
    var b = p.querySelector('[data-perf-bright]'); if (b) { b.value = String(r.brightness); }
    var c = p.querySelector('[data-perf-contrast]'); if (c) c.value = String(r.contrast);
    var s = p.querySelector('[data-perf-sat]'); if (s) s.value = String(r.saturation);
    var bo = p.querySelector('[data-perf-bright-out]'); if (bo) bo.textContent = r.brightness.toFixed(2);
    var co = p.querySelector('[data-perf-contrast-out]'); if (co) co.textContent = r.contrast.toFixed(2);
    var so = p.querySelector('[data-perf-sat-out]'); if (so) so.textContent = r.saturation.toFixed(2);
    var q = p.querySelector('[data-perf-quality]'); if (q) q.value = r.quality;
    var ap = p.querySelector('[data-perf-autopoint]'); if (ap) ap.checked = r.autoPoint;
  }
  function refreshPanel() { var p = panel(); p.innerHTML = html(); syncInputs(); paint(); return p; }

  function open() {
    var p = refreshPanel(); p.hidden = false; st.open = true; pill(); syncInputs(); paint();
    if (!st.installed) { st.installed = true; }
    if (!st.timer) st.timer = setInterval(paint, 500);
    return true;
  }
  function close() { st.open = false; if (st.panel) st.panel.hidden = true; if (st.timer) { clearInterval(st.timer); st.timer = 0; } return true; }
  function toggle() { return st.open ? close() : open(); }

  function attach() {
    if (st.attachDone) { applyPrefs(); return true; }
    st.attachDone = true;
    try { pill(); } catch (e) { }
    try { applyPrefs(); } catch (e) { }
    if (!st.raf) st.raf = W.requestAnimationFrame ? W.requestAnimationFrame(tick) : setTimeout(tick, 16);
    if (!st.timer) st.timer = setInterval(function () { if (st.open) paint(); }, 500);
    W.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'F2') { e.preventDefault(); toggle(); }
    }, true);
    W.addEventListener('lx-cloud-loaded', function () { setTimeout(function () { try { applyPrefs(); } catch (e) { } }, 120); });
    return true;
  }

  function api() {
    return {
      version: '145',
      open: open, close: close, toggle: toggle, isOpen: function () { return !!st.open; },
      state: metrics, attach: attach, apply: applyPrefs,
      readPrefs: readPrefs, savePrefs: savePrefs,
      // для тестов/диагностики
      _metrics: metrics, _store: store
    };
  }
  W.__lxPerf = api();
  function boot() {
    try {
      if (viewer()) attach();
      else { var n = 0, t = setInterval(function () { if (viewer()) { clearInterval(t); attach(); } if (++n > 400) clearInterval(t); }, 150); }
    } catch (e) { }
  }
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', boot); else boot();
  if (typeof module !== 'undefined' && module.exports) module.exports = api();
  if (typeof globalThis !== 'undefined' && typeof window === 'undefined') { try { globalThis.__lxPerf = api(); } catch (e) { } }
})();

