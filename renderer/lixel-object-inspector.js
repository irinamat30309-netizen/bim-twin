/*
 * lixel-object-inspector.js — v1158
 * CHCNAV CoProcess-подобный «Инспектор объекта».
 * Выделяешь объект в облаке точек → открывается отдельное окно только с этим объектом
 * (отдельный 3D-вьюер), где удобно мерять стены, трубы и т.д. со всех сторон.
 * Аддитивно: собственный экземпляр Viewer3DGL, основной вьюер и остальной UI не трогает.
 * v1158: выделение объекта РАМКОЙ (region-select) вместо клика; режимы отображения (RGB/Высота/EDL/размер);
 *        меньший таргет даунсэмпла для больших объектов (не крашится).
 */
(function () {
  'use strict';
  var modal = null, iv = null, ivCanvas = null, launchBtn = null;
  var state = { mode: 'distance', pick: false, hist: [], n: 0, lastCloud: null };
  var disp = { mode: 'rgb', edl: false, size: 1 };
  var bandEl = null;

  function mainV() { try { return (window.__pcTools && window.__pcTools.viewer && window.__pcTools.viewer()) || window.__viewer || null; } catch (e) { return null; } }
  function toast(m) { try { if (window.__pcTools && window.__pcTools.toast) return window.__pcTools.toast(m); } catch (e) {} try { console.log('[obj-inspector]', m); } catch (e) {} }
  function el(tag, css, html) { var d = document.createElement(tag); if (css) d.style.cssText = css; if (html != null) d.innerHTML = html; return d; }
  function nfmt(n) { try { return (n || 0).toLocaleString('ru-RU'); } catch (e) { return String(n || 0); } }
  function bcss(bg) { return 'background:' + bg + ';color:#fff;border:0;border-radius:7px;padding:6px 10px;font-size:12px;cursor:pointer'; }
  var TONE = { blue: 'var(--lx-blue)', green: 'var(--lx-green)', red: 'var(--lx-red)', neutral: 'var(--lx-neutral)' };

  var MODES = [['distance', 'П Расстояние'], ['point', 'Координата'], ['polyline', 'Полилиния'], ['angle', 'Угол'], ['area', 'Площадь'], ['plane', 'Плоскость'], ['deviation', 'Зазор'], ['corner', 'Ребро/угол']];
  var MNAME = { distance: 'Расст.', point: 'Точка', polyline: 'Полилиния', angle: 'Угол', area: 'Площадь', plane: 'Плоскость', deviation: 'Зазор', corner: 'Ребро/угол' };

  function buildModal() {
    if (modal) return modal;
    modal = el('div', 'position:fixed;inset:0;z-index:100000;background:rgba(6,7,9,.62);display:none;align-items:center;justify-content:center;font-family:system-ui,Segoe UI,Roboto,sans-serif');
    var win = el('div', ''); win.className = 'lx-tool-panel'; win.style.cssText = 'width:min(1180px,94vw);height:min(760px,90vh);display:flex;flex-direction:column;overflow:hidden';
    var head = el('div', 'display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line)');
    head.appendChild(el('div', 'font-weight:700;font-size:15px;flex:0 0 auto', '📐 Инспектор объекта'));
    var titleEl = el('div', 'flex:1;min-width:0;color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', '—'); titleEl.id = 'lxInsTitle';
    var closeB = el('button', 'background:var(--panel2);border:0;color:var(--txt);border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:15px', '✕'); closeB.id = 'lxInsClose'; closeB.onclick = close;
    head.appendChild(titleEl); head.appendChild(closeB);

    var body = el('div', 'flex:1;display:flex;min-height:0');
    var stage = el('div', 'flex:1;position:relative;min-width:0;background:#0d0e10');
    ivCanvas = el('canvas', 'position:absolute;inset:0;width:100%;height:100%;display:block'); ivCanvas.id = 'lxInsCanvas';
    stage.appendChild(ivCanvas);
    var vbar = el('div', 'position:absolute;left:10px;bottom:10px;display:flex;gap:6px;flex-wrap:wrap');
    [['reset', 'Кадр'], ['front', 'Спереди'], ['side', 'Сбоку'], ['top', 'Сверху']].forEach(function (p) { var b = el('button', bcss(TONE.neutral), p[1]); b.dataset.preset = p[0]; b.onclick = function () { setPreset(p[0]); }; vbar.appendChild(b); });
    stage.appendChild(vbar);
    // Режимы отображения (не только RGB): цвет по высоте, EDL-подсветка, размер точки.
    var dbar = el('div', 'position:absolute;left:10px;top:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center'); dbar.id = 'lxInsDisp';
    [['rgb', 'RGB'], ['elev', 'Высота']].forEach(function (m) { var b = el('button', bcss(m[0] === disp.mode ? TONE.blue : TONE.neutral), m[1]); b.dataset.cmode = m[0]; b.onclick = function () { setColor(m[0]); }; dbar.appendChild(b); });
    var edlB = el('button', bcss(disp.edl ? TONE.blue : TONE.neutral), 'EDL'); edlB.id = 'lxInsEdl'; edlB.title = 'Объёмная подсветка (Eye-Dome Lighting)'; edlB.onclick = function () { toggleEDL(); }; dbar.appendChild(edlB);
    var szMinus = el('button', bcss(TONE.neutral), '−'); szMinus.title = 'Мельче точки'; szMinus.onclick = function () { setSize(-1); }; dbar.appendChild(szMinus);
    var szPlus = el('button', bcss(TONE.neutral), '+'); szPlus.title = 'Крупнее точки'; szPlus.onclick = function () { setSize(1); }; dbar.appendChild(szPlus);
    stage.appendChild(dbar);
    body.appendChild(stage);

    var side = el('div', 'flex:0 0 300px;max-width:44%;border-left:1px solid var(--line);display:flex;flex-direction:column;min-height:0');
    var tools = el('div', 'padding:12px;border-bottom:1px solid var(--line)');
    tools.appendChild(el('div', 'font-weight:600;font-size:12px;color:var(--muted);margin-bottom:8px', 'Инструменты измерения'));
    var mgrid = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:6px'); mgrid.id = 'lxInsModes';
    MODES.forEach(function (m) { var b = el('button', bcss(m[0] === state.mode ? TONE.blue : TONE.neutral), m[1]); b.dataset.mode = m[0]; b.onclick = function () { setMode(m[0]); }; mgrid.appendChild(b); });
    tools.appendChild(mgrid);
    var actions = el('div', 'display:flex;gap:6px;margin-top:8px');
    var finB = el('button', bcss(TONE.green) + ';flex:1', 'Завершить'); finB.onclick = function () { if (iv) iv.finishMeasure(); };
    var clrB = el('button', bcss(TONE.red) + ';flex:1', 'Очистить'); clrB.onclick = function () { if (iv) iv.setMeasureMode(state.mode); refreshReadout(null); };
    actions.appendChild(finB); actions.appendChild(clrB); tools.appendChild(actions);
    tools.appendChild(el('div', 'margin-top:8px;font-size:11px;color:var(--muted);line-height:1.4', 'Клик по облаку добавляет точку. Колёсико — зум, ЛКМ — вращение, Shift+ЛКМ — панорама.'));
    side.appendChild(tools);

    var read = el('div', 'padding:12px;min-height:0;overflow:auto;flex:1');
    read.appendChild(el('div', 'font-weight:600;font-size:12px;color:var(--muted);margin-bottom:6px', 'Результат'));
    var cur = el('div', 'font-size:15px;font-weight:700;color:var(--txt);min-height:22px', '—'); cur.id = 'lxInsCur'; read.appendChild(cur);
    read.appendChild(el('div', 'font-weight:600;font-size:12px;color:var(--muted);margin:12px 0 6px', 'История измерений'));
    var hist = el('div', 'display:flex;flex-direction:column;gap:4px'); hist.id = 'lxInsHist'; read.appendChild(hist);
    side.appendChild(read);
    body.appendChild(side);

    win.appendChild(head); win.appendChild(body);
    modal.appendChild(win);
    modal.addEventListener('mousedown', function (e) { if (e.target === modal) close(); });
    document.body.appendChild(modal);
    return modal;
  }

  function ensureViewer() {
    if (iv) return iv;
    if (!(window.Viewer3DGL && window.Viewer3DGL.isSupported && window.Viewer3DGL.isSupported())) { toast('WebGL2 недоступен — инспектор не запущен'); return null; }
    try { iv = new window.Viewer3DGL(ivCanvas, function () {}); } catch (e) { toast('Не удалось создать 3D-инспектор'); iv = null; return null; }
    try { iv.setTheme('dark'); } catch (e) {}
    iv.onMeasure = function (res) { refreshReadout(res); };
    return iv;
  }

  function setMode(m) {
    state.mode = m;
    if (iv) { iv.setMeasureMode(m); iv.setMeasure(true); }
    var g = modal && modal.querySelector('#lxInsModes');
    if (g) Array.prototype.forEach.call(g.children, function (c) { c.style.background = (c.dataset.mode === m) ? TONE.blue : TONE.neutral; });
  }

  function setPreset(p) {
    if (!iv) return;
    try {
      if (p === 'reset') { iv.resetView(); return; }
      if (iv._frame) iv._frame();
      if (p === 'top') { iv.pitch = -1.45; iv.yaw = -0.0001; }
      else if (p === 'front') { iv.pitch = -0.05; iv.yaw = 0; }
      else if (p === 'side') { iv.pitch = -0.05; iv.yaw = -Math.PI / 2; }
      iv.render();
    } catch (e) {}
  }

  function setColor(m) { disp.mode = m; if (iv && iv.setColorMode) { try { iv.setColorMode(m === 'elev' ? 'elev' : 'rgb'); } catch (e) {} } var g = modal && modal.querySelector('#lxInsDisp'); if (g) Array.prototype.forEach.call(g.querySelectorAll('[data-cmode]'), function (c) { c.style.background = (c.dataset.cmode === disp.mode) ? TONE.blue : TONE.neutral; }); }
  function toggleEDL() { disp.edl = !disp.edl; if (iv && iv.setEDL) { try { iv.setEDL(disp.edl); } catch (e) {} } var b = modal && modal.querySelector('#lxInsEdl'); if (b) b.style.background = disp.edl ? TONE.blue : TONE.neutral; }
  function setSize(d) { disp.size = Math.max(0.4, Math.min(4, (disp.size || 1) + d * 0.3)); if (iv && iv.setPointSizeScale) { try { iv.setPointSizeScale(disp.size); } catch (e) {} } }
  function applyDisp() { if (!iv) return; try { if (iv.setColorMode) iv.setColorMode(disp.mode === 'elev' ? 'elev' : 'rgb'); } catch (e) {} try { if (iv.setEDL) iv.setEDL(disp.edl); } catch (e) {} try { if (iv.setPointSizeScale) iv.setPointSizeScale(disp.size); } catch (e) {} }

  function refreshReadout(res) {
    var cur = modal && modal.querySelector('#lxInsCur'); if (!cur) return;
    if (!res) { cur.textContent = '—'; cur.style.color = 'var(--txt)'; return; }
    if (res.error) { cur.textContent = res.error; cur.style.color = 'var(--err)'; return; }
    var txt = '';
    try { txt = (window.Measure && window.Measure.measureValueText) ? window.Measure.measureValueText(res) : ''; } catch (e) {}
    cur.style.color = 'var(--txt)'; cur.textContent = txt || '—';
    if (txt) { state.hist.unshift({ mode: res.mode, txt: txt }); state.hist = state.hist.slice(0, 12); renderHist(); }
  }

  function renderHist() {
    var h = modal && modal.querySelector('#lxInsHist'); if (!h) return;
    h.innerHTML = '';
    if (!state.hist.length) { h.appendChild(el('div', 'color:var(--muted);font-size:12px', 'Пока пусто')); return; }
    state.hist.forEach(function (it) {
      var row = el('div', 'display:flex;gap:8px;font-size:12px;padding:4px 6px;background:var(--panel2);border-radius:6px');
      row.appendChild(el('div', 'color:var(--muted);flex:0 0 84px', MNAME[it.mode] || it.mode));
      row.appendChild(el('div', 'flex:1;min-width:0', it.txt));
      h.appendChild(row);
    });
  }

  function _strideDown(c, target) { var n = c.pos.length / 3; if (n <= target) return c; var step = Math.ceil(n / target); var m = Math.floor(n / step) + 1; var p = new Float32Array(m * 3); var col = c.col ? new c.col.constructor(m * 3) : null; var w = 0; for (var i = 0; i < n && w < m; i += step) { p[w * 3] = c.pos[i * 3]; p[w * 3 + 1] = c.pos[i * 3 + 1]; p[w * 3 + 2] = c.pos[i * 3 + 2]; if (col) { col[w * 3] = c.col[i * 3]; col[w * 3 + 1] = c.col[i * 3 + 1]; col[w * 3 + 2] = c.col[i * 3 + 2]; } w++; } return { pos: p.subarray(0, w * 3), col: col ? col.subarray(0, w * 3) : null, count: w }; }

  function openWithCloud(cloud, title) {
    if (!cloud || !cloud.pos || !cloud.pos.length) { toast('Пустой объект — нечего измерять'); return false; }
    buildModal();
    modal.style.display = 'flex';
    var v = ensureViewer(); if (!v) return false;
    state.lastCloud = cloud;
    var t = modal.querySelector('#lxInsTitle'); if (t) t.textContent = (title || 'Объект') + ' · ' + nfmt(cloud.count || cloud.pos.length / 3) + ' т.';
    state.hist = []; renderHist(); refreshReadout(null);
    try { var _cl = cloud, _cnt = cloud.count || cloud.pos.length / 3; if (_cnt > 900000) { _cl = _strideDown(cloud, 900000); } v.loadCloud({ pos: _cl.pos, col: _cl.col || null, count: _cl.pos.length / 3 }); } catch (e) { toast('Ошибка загрузки объекта'); }
    setTimeout(function () {
      try { window.dispatchEvent(new Event('resize')); if (v._resize) v._resize(); if (v._frame) v._frame(); } catch (e) {}
      setMode(state.mode);
      applyDisp();
      try { v.render(); } catch (e) {}
    }, 30);
    return true;
  }

  function close() { if (modal) modal.style.display = 'none'; try { if (iv) iv.setMeasure(false); } catch (e) {} }

  function startPick() {
    var mv = mainV(); if (!mv || !mv.canvas) { toast('Сначала откройте облако точек'); return; }
    if (!mv.extractRegionAsObject && !mv.smartObjectAt) { toast('Захват недоступен в этой сборке'); return; }
    state.pick = true;
    if (launchBtn) { launchBtn.classList.add('on'); launchBtn.textContent = '🎛️ Обведите объект рамкой…'; }
    try { mv.canvas.style.cursor = 'crosshair'; } catch (e) {}
    toast('Обведите объект рамкой (зажмите ЛКМ и растяните) — откроется окно измерения');
  }
  function stopPick() { state.pick = false; var mv = mainV(); try { if (mv && mv.canvas) mv.canvas.style.cursor = ''; } catch (e) {} if (bandEl) bandEl.style.display = 'none'; if (launchBtn) { launchBtn.classList.remove('on'); launchBtn.textContent = '📐 Измерить объект'; } }

  function ensureBand() { if (bandEl) return bandEl; bandEl = el('div', 'position:fixed;border:1.5px dashed var(--lx-blue);background:color-mix(in srgb, var(--lx-blue) 12%, transparent);z-index:100001;pointer-events:none;display:none'); document.body.appendChild(bandEl); return bandEl; }

  // Region-select: обводим объект рамкой (а не кликом). Короткий клик — фоллбэк на автозахват.
  function wirePick() {
    var mv = mainV(); if (!mv || !mv.canvas || wirePick._wired) return; wirePick._wired = true;
    var cv = mv.canvas, dx = 0, dy = 0, down = false, moved = false;
    cv.addEventListener('mousedown', function (e) {
      if (!state.pick || e.button !== 0) return;
      down = true; moved = false; dx = e.clientX; dy = e.clientY;
      ensureBand(); bandEl.style.left = dx + 'px'; bandEl.style.top = dy + 'px'; bandEl.style.width = '0px'; bandEl.style.height = '0px'; bandEl.style.display = 'block';
      e.preventDefault(); e.stopImmediatePropagation();
    }, true);
    window.addEventListener('mousemove', function (e) {
      if (!down || !state.pick) return;
      var x0 = Math.min(dx, e.clientX), y0 = Math.min(dy, e.clientY), w = Math.abs(e.clientX - dx), h = Math.abs(e.clientY - dy);
      if (w + h > 6) moved = true;
      if (bandEl) { bandEl.style.left = x0 + 'px'; bandEl.style.top = y0 + 'px'; bandEl.style.width = w + 'px'; bandEl.style.height = h + 'px'; }
    }, true);
    window.addEventListener('mouseup', function (e) {
      if (!down || e.button !== 0) { down = false; return; } down = false;
      if (bandEl) bandEl.style.display = 'none';
      if (!state.pick) return;
      var v = mainV(); if (!v) return;
      var _x0 = dx, _y0 = dy, _x1 = e.clientX, _y1 = e.clientY;
      var dist = Math.hypot(_x1 - _x0, _y1 - _y0);
      var name = 'Инспекция ' + (state.n + 1);
      var _t = (window.__pcTools && window.__pcTools.beginProgress) ? window.__pcTools.beginProgress('Захват области…') : null;
      setTimeout(function () {
        var r = null;
        try {
          if (dist >= 8 && v.extractRegionAsObject) { r = v.extractRegionAsObject(_x0, _y0, _x1, _y1, name); }
          else if (v.smartObjectAt) { var nn = v.smartObjectAt(_x1, _y1, { maxPts: 500000 }); if (nn) r = v.extractSelectionAsObject(name); }
        } catch (err) {}
        var cloud = (r && v.getExtractedObjectCloud) ? v.getExtractedObjectCloud(r.id) : null;
        try { if (v.clearSelection) v.clearSelection(); } catch (e2) {}
        try { if (_t) _t(); } catch (e2) {}
        if (cloud) { state.n++; stopPick(); openWithCloud(cloud, name); }
        else { toast('Ничего не выделено — обведите объект рамкой'); }
      }, 30);
      e.preventDefault();
    }, true);
  }

  function mountButton() {
    if (launchBtn) return;
    launchBtn = el('button', '', '📐 Измерить объект');
    launchBtn.className = 'lx-tool-btn'; launchBtn.style.cssText = 'left:14px;bottom:14px';
    launchBtn.id = 'lxObjInspectBtn'; launchBtn.title = 'Выделить объект в облаке и открыть окно измерения (как в CHCNAV CoProcess)';
    launchBtn.onclick = function () { if (state.pick) stopPick(); else startPick(); };
    document.body.appendChild(launchBtn);
  }

  function boot() { try { mountButton(); wirePick(); } catch (e) { console.warn('obj-inspector boot', e); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.addEventListener('lx-viewer-ready', function () { try { wirePick(); } catch (e) {} });
  window.addEventListener('lx-pctools-ready', boot);

  window.__lxObjectInspector = { open: openWithCloud, openWithCloud: openWithCloud, close: close, startPick: startPick, stopPick: stopPick, setMode: setMode, state: state };
})();
