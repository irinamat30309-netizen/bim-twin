/*
 * lixel-object-inspector.js — v1158
 * «Инспектор объекта» в духе CHCNAV CoProcess.
 * Обводите объект рамкой в облаке точек — открывается отдельное окно только с этим объектом
 * (собственный 3D-вьюер), где удобно мерить стены, трубы и т. д. со всех сторон.
 * Аддитивно: свой экземпляр Viewer3DGL, основной вьюер и остальной интерфейс не трогает.
 * v1158: выделение объекта РАМКОЙ (region-select) вместо клика; режимы отображения (RGB/Высота/EDL/размер);
 *        меньший таргет даунсэмпла для больших объектов (не крашится).
 * Кнопку запуска (#lxObjInspectBtn) создаёт этот модуль, размещает и оформляет лента (ui/ribbon.js).
 */
(function () {
  'use strict';
  var modal = null, iv = null, ivCanvas = null, launchBtn = null;
  var state = { mode: 'distance', pick: false, hist: [], n: 0, lastCloud: null, kind: '', live: null };
  var disp = { mode: 'rgb', edl: false, size: 1 };
  var bandEl = null, prevFocus = null;

  function mainV() { try { return (window.__pcTools && window.__pcTools.viewer && window.__pcTools.viewer()) || window.__viewer || null; } catch (e) { return null; } }
  function toast(m, opts) {
    try { if (window.__lxKit && window.__lxKit.toast) return window.__lxKit.toast(m, opts); } catch (e) {}
    try { if (window.__pcTools && window.__pcTools.toast) return window.__pcTools.toast(m); } catch (e) {}
    try { console.log('[obj-inspector]', m); } catch (e) {}
  }
  function el(tag, cls, html) { var d = document.createElement(tag); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; }
  function ico(name, size) { return '<span data-ico="' + name + '" data-ico-size="' + (size || 16) + '" aria-hidden="true"></span>'; }
  function nfmt(n) { try { return (n || 0).toLocaleString('ru-RU'); } catch (e) { return String(n || 0); } }
  function setOn(b, on) { if (!b) return; b.classList.toggle('on', !!on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  /** Кнопка окна: значок + подпись в .lbl (подпись подменяет i18n). */
  function button(text, icon, cls, title) {
    var b = el('button', 'btn sm' + (cls ? ' ' + cls : ''), (icon ? ico(icon, 15) : '') + '<span class="lbl">' + text + '</span>');
    b.type = 'button'; if (title) { b.setAttribute('data-tip', title); }
    return b;
  }

  var MODES = [['distance', 'Расстояние', 'ruler'], ['point', 'Координата', 'crosshair'], ['polyline', 'Полилиния', 'polyline'], ['angle', 'Угол', 'angle'], ['area', 'Площадь', 'vector-square'], ['plane', 'Плоскость', 'brick-wall'], ['deviation', 'Зазор', 'arrow-up-down'], ['corner', 'Ребро/угол', 'cuboid']];
  var MNAME = { distance: 'Расст.', point: 'Точка', polyline: 'Полилиния', angle: 'Угол', area: 'Площадь', plane: 'Плоскость', deviation: 'Зазор', corner: 'Ребро/угол' };

  /* Тип объекта: по нему приложение выбирает, какое требование искать в документах (стена, труба, проём…). */
  var KINDS = [['', 'Авто'], ['стена', 'Стена'], ['колонна', 'Колонна'], ['балка', 'Балка'], ['перекрытие', 'Перекрытие'], ['пол', 'Пол'], ['потолок', 'Потолок'], ['проём', 'Проём'], ['дверь', 'Дверь'], ['окно', 'Окно'], ['труба', 'Труба'], ['воздуховод', 'Воздуховод'], ['оборудование', 'Оборудование']];
  function docCheck() { return window.__lxDocCheck || null; }

  function buildModal() {
    if (modal) return modal;
    modal = el('div', 'lx-win-back'); modal.id = 'lxInsModal'; modal.hidden = true;
    var win = el('div', 'lx-win'); win.setAttribute('role', 'dialog'); win.setAttribute('aria-modal', 'true'); win.setAttribute('aria-labelledby', 'lxInsHeading');
    var head = el('header', 'lx-win-head');
    head.appendChild(el('div', 'lx-win-title', ico('ruler', 18) + '<span id="lxInsHeading">Инспектор объекта</span>'));
    var titleEl = el('div', 'lx-win-sub', '—'); titleEl.id = 'lxInsTitle';
    var closeB = el('button', 'icon-btn', ico('x', 18)); closeB.type = 'button'; closeB.id = 'lxInsClose'; closeB.setAttribute('aria-label', 'Закрыть'); closeB.setAttribute('data-tip', 'Закрыть · Esc'); closeB.onclick = close;
    head.appendChild(titleEl); head.appendChild(closeB);

    var body = el('div', 'lx-win-body');
    var stage = el('div', 'lx-win-stage');
    ivCanvas = el('canvas'); ivCanvas.id = 'lxInsCanvas';
    stage.appendChild(ivCanvas);

    // Режимы отображения (не только RGB): цвет по высоте, EDL-подсветка, размер точки.
    var dbar = el('div', 'lx-win-float tl'); dbar.id = 'lxInsDisp';
    var colors = el('div', 'seg-group'); colors.setAttribute('role', 'group'); colors.setAttribute('aria-label', 'Цвет точек');
    [['rgb', 'RGB'], ['elev', 'Высота']].forEach(function (m) {
      var b = el('button', 'hbtn', '<span class="lbl">' + m[1] + '</span>'); b.type = 'button'; b.dataset.cmode = m[0]; setOn(b, m[0] === disp.mode); b.onclick = function () { setColor(m[0]); }; colors.appendChild(b);
    });
    dbar.appendChild(colors);
    var opts = el('div', 'seg-group'); opts.setAttribute('role', 'group');
    var edlB = el('button', 'hbtn', '<span class="lbl">EDL</span>'); edlB.type = 'button'; edlB.id = 'lxInsEdl'; setOn(edlB, disp.edl); edlB.setAttribute('data-tip', 'Объёмная подсветка (Eye-Dome Lighting)'); edlB.onclick = function () { toggleEDL(); }; opts.appendChild(edlB);
    var szMinus = el('button', 'hbtn', ico('minus', 16)); szMinus.type = 'button'; szMinus.setAttribute('aria-label', 'Мельче точки'); szMinus.setAttribute('data-tip', 'Мельче точки'); szMinus.onclick = function () { setSize(-1); }; opts.appendChild(szMinus);
    var szPlus = el('button', 'hbtn', ico('plus', 16)); szPlus.type = 'button'; szPlus.setAttribute('aria-label', 'Крупнее точки'); szPlus.setAttribute('data-tip', 'Крупнее точки'); szPlus.onclick = function () { setSize(1); }; opts.appendChild(szPlus);
    dbar.appendChild(opts);
    stage.appendChild(dbar);

    var vbar = el('div', 'lx-win-float bl seg-group'); vbar.setAttribute('role', 'group'); vbar.setAttribute('aria-label', 'Вид');
    [['reset', 'Кадр', 'maximize'], ['front', 'Спереди', 'view-front'], ['side', 'Сбоку', 'view-side'], ['top', 'Сверху', 'view-top']].forEach(function (p) {
      var b = el('button', 'hbtn', ico(p[2], 16) + '<span class="lbl">' + p[1] + '</span>'); b.type = 'button'; b.dataset.preset = p[0]; b.onclick = function () { setPreset(p[0]); }; vbar.appendChild(b);
    });
    stage.appendChild(vbar);
    body.appendChild(stage);

    var side = el('aside', 'lx-win-side');
    var tools = el('section', 'lx-win-sec');
    tools.appendChild(el('h4', 'lx-win-h', 'Инструменты измерения'));
    var mgrid = el('div', 'lx-win-modes'); mgrid.id = 'lxInsModes';
    MODES.forEach(function (m) {
      var b = button(m[1], m[2]); b.dataset.mode = m[0]; setOn(b, m[0] === state.mode); b.onclick = function () { setMode(m[0]); }; mgrid.appendChild(b);
    });
    tools.appendChild(mgrid);
    var actions = el('div', 'lx-win-actions');
    var finB = button('Завершить', 'check', 'ok'); finB.onclick = function () { if (iv) iv.finishMeasure(); state.live = null; };
    var clrB = button('Очистить', 'eraser', 'danger'); clrB.onclick = function () { state.live = null; if (iv) iv.setMeasureMode(state.mode); refreshReadout(null); };
    actions.appendChild(finB); actions.appendChild(clrB); tools.appendChild(actions);
    tools.appendChild(el('p', 'lx-win-hint', 'Клик по облаку добавляет точку. Колёсико — зум, ЛКМ — вращение, Shift+ЛКМ — панорама.'));
    side.appendChild(tools);

    var kindSec = el('section', 'lx-win-sec');
    kindSec.appendChild(el('h4', 'lx-win-h', 'Что вы измеряете'));
    var kinds = el('div', 'lx-win-kinds'); kinds.id = 'lxInsKinds'; kinds.setAttribute('role', 'group'); kinds.setAttribute('aria-label', 'Тип объекта');
    KINDS.forEach(function (k) {
      var b = el('button', 'chip', k[1]); b.type = 'button'; b.dataset.kind = k[0]; setOn(b, k[0] === state.kind); b.classList.toggle('sel', k[0] === state.kind);
      b.onclick = function () { setKind(k[0]); }; kinds.appendChild(b);
    });
    kindSec.appendChild(kinds);
    kindSec.appendChild(el('p', 'lx-win-hint', 'Тип помогает найти нужное требование в документации помещения. Каждое измерение попадает в список проекта и сверяется автоматически.'));
    side.appendChild(kindSec);

    var read = el('section', 'lx-win-sec grow');
    read.appendChild(el('h4', 'lx-win-h', 'Результат'));
    var cur = el('div', 'lx-win-cur', '—'); cur.id = 'lxInsCur'; read.appendChild(cur);
    read.appendChild(el('h4', 'lx-win-h', 'Измерения и сверка'));
    var hist = el('div', 'lx-win-hist'); hist.id = 'lxInsHist'; read.appendChild(hist);
    var openV = button('Открыть сверку', 'clipboard-check', '', 'Таблица измерений и требований из документации'); openV.id = 'lxInsOpenVerify'; openV.style.marginTop = '10px';
    openV.onclick = function () { if (window.__lxVerify) window.__lxVerify.open({}); };
    read.appendChild(openV);
    side.appendChild(read);
    body.appendChild(side);

    win.appendChild(head); win.appendChild(body);
    modal.appendChild(win);
    modal.addEventListener('mousedown', function (e) { if (e.target === modal) close(); });
    document.body.appendChild(modal);
    if (window.__lxKit) window.__lxKit.hydrate(modal);
    return modal;
  }

  function ensureViewer() {
    if (iv) return iv;
    if (!(window.Viewer3DGL && window.Viewer3DGL.isSupported && window.Viewer3DGL.isSupported())) { toast('WebGL2 недоступен — инспектор не запущен', { tone: 'warn' }); return null; }
    try { iv = new window.Viewer3DGL(ivCanvas, function () {}); } catch (e) { toast('Не удалось создать 3D-инспектор', { tone: 'err' }); iv = null; return null; }
    try { iv.setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'); } catch (e) {}
    iv.onMeasure = function (res) { refreshReadout(res); };
    return iv;
  }

  function setMode(m) {
    state.mode = m; state.live = null;
    if (iv) { iv.setMeasureMode(m); iv.setMeasure(true); }
    var g = modal && modal.querySelector('#lxInsModes');
    if (g) Array.prototype.forEach.call(g.children, function (c) { setOn(c, c.dataset.mode === m); });
  }

  function setKind(k) {
    state.kind = k || '';
    var g = modal && modal.querySelector('#lxInsKinds');
    if (g) Array.prototype.forEach.call(g.children, function (c) { var on = c.dataset.kind === state.kind; setOn(c, on); c.classList.toggle('sel', on); });
    var dc = docCheck();
    if (dc && state.hist.length && state.hist[0].idx != null) {
      // Смена типа относится к последнему измерению: оно сразу пересверяется.
      dc.setContext(state.hist[0].idx, { objectType: state.kind });
    }
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

  function setColor(m) {
    disp.mode = m;
    if (iv && iv.setColorMode) { try { iv.setColorMode(m === 'elev' ? 'elev' : 'rgb'); } catch (e) {} }
    var g = modal && modal.querySelector('#lxInsDisp');
    if (g) Array.prototype.forEach.call(g.querySelectorAll('[data-cmode]'), function (c) { setOn(c, c.dataset.cmode === disp.mode); });
  }
  function toggleEDL() {
    disp.edl = !disp.edl;
    if (iv && iv.setEDL) { try { iv.setEDL(disp.edl); } catch (e) {} }
    setOn(modal && modal.querySelector('#lxInsEdl'), disp.edl);
  }
  function setSize(d) { disp.size = Math.max(0.4, Math.min(4, (disp.size || 1) + d * 0.3)); if (iv && iv.setPointSizeScale) { try { iv.setPointSizeScale(disp.size); } catch (e) {} } }
  function applyDisp() { if (!iv) return; try { if (iv.setColorMode) iv.setColorMode(disp.mode === 'elev' ? 'elev' : 'rgb'); } catch (e) {} try { if (iv.setEDL) iv.setEDL(disp.edl); } catch (e) {} try { if (iv.setPointSizeScale) iv.setPointSizeScale(disp.size); } catch (e) {} }

  function hasNumbers(res) {
    try { return !!(window.MeasurementDocCompare && window.MeasurementDocCompare.measurementFields(res).length); } catch (e) { return false; }
  }
  /** Результат идёт в общий список проекта: polyline/area обновляют одну запись, пока измерение не завершено. */
  function saveToProject(res) {
    var dc = docCheck(); if (!dc || !hasNumbers(res)) return null;
    var liveMode = res.mode === 'polyline' || res.mode === 'area';
    var meta = { objectType: state.kind || null, objectName: state.title || null, origin: 'inspector' };
    try {
      if (liveMode && state.live && state.live.mode === res.mode && dc.row(state.live.idx)) { dc.update(state.live.idx, res); return { idx: state.live.idx, fresh: false }; }
      var idx = dc.add(res, meta);
      state.live = liveMode ? { mode: res.mode, idx: idx } : null;
      return idx >= 0 ? { idx: idx, fresh: true } : null;
    } catch (e) { return null; }
  }

  function refreshReadout(res) {
    var cur = modal && modal.querySelector('#lxInsCur'); if (!cur) return;
    cur.classList.remove('err');
    if (!res) { cur.textContent = '—'; return; }
    if (res.error) { cur.textContent = res.error; cur.classList.add('err'); return; }
    var txt = '';
    try { txt = (window.Measure && window.Measure.measureValueText) ? window.Measure.measureValueText(res) : ''; } catch (e) {}
    cur.textContent = txt || '—';
    if (!txt) return;
    var saved = saveToProject(res);
    if (saved && !saved.fresh) {
      for (var i = 0; i < state.hist.length; i++) if (state.hist[i].idx === saved.idx) { state.hist[i].txt = txt; state.hist[i].mode = res.mode; break; }
    } else {
      state.hist.unshift({ mode: res.mode, txt: txt, idx: saved ? saved.idx : null });
      state.hist = state.hist.slice(0, 12);
    }
    renderHist();
  }

  function statusChip(idx) {
    var dc = docCheck(); var V = window.__lxVerify;
    if (!dc || idx == null || !V) return null;
    var row = dc.row(idx); if (!row) return null;
    var info = V.statusInfo(row.status, row.how);
    var b = el('button', 'vf-chip ' + info.tone, (info.busy ? '<span class="vf-spin" aria-hidden="true"></span>' : '') + '<span class="lbl"></span>');
    b.querySelector('.lbl').textContent = info.short; b.type = 'button';
    b.setAttribute('data-tip', row.expectedText ? 'Требование: ' + row.expectedText + (row.deltaText ? ' · отклонение ' + row.deltaText : '') : info.hint);
    b.setAttribute('aria-label', 'Сверка: ' + info.label + '. Открыть таблицу сверки');
    b.onclick = function () { V.open({ focus: idx }); };
    return b;
  }

  function renderHist() {
    var h = modal && modal.querySelector('#lxInsHist'); if (!h) return;
    h.innerHTML = '';
    if (!state.hist.length) { h.appendChild(el('div', 'lx-win-empty', 'Пока пусто. Поставьте точки на объекте: результат сохранится в проект и сверится с документами.')); return; }
    state.hist.forEach(function (it) {
      var row = el('div', 'lx-win-hrow');
      row.appendChild(el('div', '', MNAME[it.mode] || it.mode));
      var val = el('div', 'lx-win-hval'); val.appendChild(el('div', '', '')); val.firstChild.textContent = it.txt;
      var chip = statusChip(it.idx); if (chip) val.appendChild(chip);
      row.appendChild(val);
      h.appendChild(row);
    });
    if (window.__lxKit) window.__lxKit.hydrate(h);
  }
  window.addEventListener('lx-measurements-changed', function () { if (modal && !modal.hidden) renderHist(); });

  function _strideDown(c, target) { var n = c.pos.length / 3; if (n <= target) return c; var step = Math.ceil(n / target); var m = Math.floor(n / step) + 1; var p = new Float32Array(m * 3); var col = c.col ? new c.col.constructor(m * 3) : null; var w = 0; for (var i = 0; i < n && w < m; i += step) { p[w * 3] = c.pos[i * 3]; p[w * 3 + 1] = c.pos[i * 3 + 1]; p[w * 3 + 2] = c.pos[i * 3 + 2]; if (col) { col[w * 3] = c.col[i * 3]; col[w * 3 + 1] = c.col[i * 3 + 1]; col[w * 3 + 2] = c.col[i * 3 + 2]; } w++; } return { pos: p.subarray(0, w * 3), col: col ? col.subarray(0, w * 3) : null, count: w }; }

  function openWithCloud(cloud, title) {
    if (!cloud || !cloud.pos || !cloud.pos.length) { toast('Пустой объект — нечего измерять', { tone: 'warn' }); return false; }
    buildModal();
    prevFocus = document.activeElement;
    modal.hidden = false;
    var v = ensureViewer(); if (!v) { modal.hidden = true; return false; }
    state.lastCloud = cloud; state.title = title || 'Объект'; state.live = null;
    var t = modal.querySelector('#lxInsTitle'); if (t) t.textContent = (title || 'Объект') + ' · ' + nfmt(cloud.count || cloud.pos.length / 3) + ' т.';
    state.hist = []; renderHist(); refreshReadout(null);
    try { var _cl = cloud, _cnt = cloud.count || cloud.pos.length / 3; if (_cnt > 900000) { _cl = _strideDown(cloud, 900000); } v.loadCloud({ pos: _cl.pos, col: _cl.col || null, count: _cl.pos.length / 3 }); } catch (e) { toast('Ошибка загрузки объекта', { tone: 'err' }); }
    setTimeout(function () {
      try { window.dispatchEvent(new Event('resize')); if (v._resize) v._resize(); if (v._frame) v._frame(); } catch (e) {}
      setMode(state.mode);
      applyDisp();
      try { v.render(); } catch (e) {}
    }, 30);
    return true;
  }

  function close() {
    if (modal) modal.hidden = true;
    try { if (iv) iv.setMeasure(false); } catch (e) {}
    try { if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true }); } catch (e) {}
    prevFocus = null;
  }

  function startPick() {
    var mv = mainV(); if (!mv || !mv.canvas) { toast('Сначала откройте облако точек', { tone: 'warn' }); return; }
    if (!mv.extractRegionAsObject && !mv.smartObjectAt) { toast('Захват недоступен в этой сборке', { tone: 'warn' }); return; }
    state.pick = true;
    setOn(launchBtn, true);
    try { mv.canvas.style.cursor = 'crosshair'; } catch (e) {}
    toast('Обведите объект рамкой (зажмите ЛКМ и растяните) — откроется окно измерения', { tone: 'info', ms: 4200 });
  }
  function stopPick() {
    state.pick = false; var mv = mainV();
    try { if (mv && mv.canvas) mv.canvas.style.cursor = ''; } catch (e) {}
    if (bandEl) bandEl.hidden = true;
    setOn(launchBtn, false);
    if (launchBtn) launchBtn.classList.remove('lx-mode-active');
    try { if (window.__lxModes && window.__lxModes.release) window.__lxModes.release('lxObjInspectBtn'); } catch (e) {}
  }

  function ensureBand() { if (bandEl) return bandEl; bandEl = el('div', 'lx-band'); bandEl.hidden = true; document.body.appendChild(bandEl); return bandEl; }

  // Region-select: обводим объект рамкой (а не кликом). Короткий клик — фоллбэк на автозахват.
  function wirePick() {
    var mv = mainV(); if (!mv || !mv.canvas || wirePick._wired) return; wirePick._wired = true;
    var cv = mv.canvas, dx = 0, dy = 0, down = false, moved = false;
    cv.addEventListener('mousedown', function (e) {
      if (!state.pick || e.button !== 0) return;
      down = true; moved = false; dx = e.clientX; dy = e.clientY;
      ensureBand(); bandEl.style.left = dx + 'px'; bandEl.style.top = dy + 'px'; bandEl.style.width = '0px'; bandEl.style.height = '0px'; bandEl.hidden = false;
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
      if (bandEl) bandEl.hidden = true;
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
        else { toast('Ничего не выделено — обведите объект рамкой', { tone: 'warn' }); }
      }, 30);
      e.preventDefault();
    }, true);
  }

  function mountButton() {
    if (launchBtn) return;
    launchBtn = el('button', '', 'Измерить объект');
    launchBtn.type = 'button'; launchBtn.id = 'lxObjInspectBtn';
    launchBtn.setAttribute('data-tip', 'Выделить объект в облаке и открыть окно измерения (как в CHCNAV CoProcess)');
    launchBtn.onclick = function () { if (state.pick) stopPick(); else startPick(); };
    (document.getElementById('lxLegacy') || document.body).appendChild(launchBtn);
  }

  function boot() { try { mountButton(); wirePick(); } catch (e) { console.warn('obj-inspector boot', e); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.addEventListener('lx-viewer-ready', function () { try { wirePick(); } catch (e) {} });
  window.addEventListener('lx-pctools-ready', boot);

  window.__lxObjectInspector = { open: openWithCloud, openWithCloud: openWithCloud, close: close, startPick: startPick, stopPick: stopPick, setMode: setMode, state: state };
})();
