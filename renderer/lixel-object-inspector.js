/*
 * lixel-object-inspector.js — v1160
 * «Инспектор объекта» в духе CHCNAV CoProcess.
 * Обводите объект рамкой в облаке точек — открывается отдельное окно только с этим объектом
 * (собственный 3D-вьюер), где удобно мерить стены, трубы и т. д. со всех сторон.
 * Аддитивно: свой экземпляр Viewer3DGL, основной вьюер и остальной интерфейс не трогает.
 * v1158: выделение объекта РАМКОЙ (region-select) вместо клика; режимы отображения (RGB/Высота/EDL/размер);
 *        меньший таргет даунсэмпла для больших объектов (не крашится).
 * v1160: кнопка «Измерить автоматически» (#lxInsAutoBtn): renderer/auto-measure.js сам находит размеры выделенного объекта
 *        (проём, стена, труба, лоток…), показывает ±σ, способ и уровень уверенности; надёжные размеры сохраняются в проект
 *        и сверяются с документами, сомнительные ждут нажатия «Сохранить». Тип «Лоток» добавлен.
 * Кнопку запуска (#lxObjInspectBtn) создаёт этот модуль, размещает и оформляет лента (ui/ribbon.js).
 */
(function () {
  'use strict';
  var modal = null, iv = null, ivCanvas = null, launchBtn = null;
  var state = { mode: 'distance', pick: false, hist: [], n: 0, lastCloud: null, kind: '', live: null, tab: 'manual', focus: null, pickObj: false, auto: { res: null, busy: false, kind: '', saved: {}, more: false, shown: null, note: '' } };
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

  var MODES = [['distance', 'Расстояние', 'ruler'], ['point', 'Координата', 'crosshair'], ['polyline', 'Полилиния', 'polyline'], ['angle', 'Угол', 'angle'], ['area', 'Площадь', 'vector-square'], ['diameter', 'Диаметр', 'diameter'], ['plane', 'Плоскость', 'brick-wall'], ['deviation', 'Зазор', 'arrow-up-down'], ['corner', 'Ребро/угол', 'cuboid']];
  var MNAME = { distance: 'Расст.', point: 'Точка', polyline: 'Полилиния', angle: 'Угол', area: 'Площадь', diameter: 'Диаметр', plane: 'Плоскость', deviation: 'Зазор', corner: 'Ребро/угол' };

  /* Тип объекта: по нему приложение выбирает, какое требование искать в документах (стена, труба, проём…). */
  var KINDS = [['', 'Авто'], ['стена', 'Стена'], ['колонна', 'Колонна'], ['балка', 'Балка'], ['перекрытие', 'Перекрытие'], ['пол', 'Пол'], ['потолок', 'Потолок'], ['проём', 'Проём'], ['дверь', 'Дверь'], ['окно', 'Окно'], ['труба', 'Труба'], ['воздуховод', 'Воздуховод'], ['лоток', 'Лоток'], ['оборудование', 'Оборудование']];
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
    var tabs = el('div', 'lx-win-tabs'); tabs.id = 'lxInsTabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Способ измерения');
    [['manual', 'Вручную', 'ruler'], ['auto', 'Автоматически', 'wand-sparkles']].forEach(function (t) {
      var b = el('button', 'lx-win-tab', ico(t[2], 15) + '<span class="lbl">' + t[1] + '</span>'); b.type = 'button'; b.id = 'lxInsTab-' + t[0]; b.dataset.tab = t[0];
      b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', 'lxInsPane-' + t[0]); b.onclick = function () { setTab(t[0]); }; tabs.appendChild(b);
    });
    side.appendChild(tabs);
    var manualPane = el('div', 'lx-win-pane'); manualPane.id = 'lxInsPane-manual'; manualPane.dataset.pane = 'manual'; manualPane.setAttribute('role', 'tabpanel'); manualPane.setAttribute('aria-labelledby', 'lxInsTab-manual');
    var autoPane = el('div', 'lx-win-pane'); autoPane.id = 'lxInsPane-auto'; autoPane.dataset.pane = 'auto'; autoPane.setAttribute('role', 'tabpanel'); autoPane.setAttribute('aria-labelledby', 'lxInsTab-auto');
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
    manualPane.appendChild(tools);

    var kindSec = el('section', 'lx-win-sec');
    kindSec.appendChild(el('h4', 'lx-win-h', 'Что вы измеряете'));
    var kinds = el('div', 'lx-win-kinds'); kinds.id = 'lxInsKinds'; kinds.setAttribute('role', 'group'); kinds.setAttribute('aria-label', 'Тип объекта');
    KINDS.forEach(function (k) {
      var b = el('button', 'chip', k[1]); b.type = 'button'; b.dataset.kind = k[0]; setOn(b, k[0] === state.kind); b.classList.toggle('sel', k[0] === state.kind);
      b.onclick = function () { setKind(k[0]); }; kinds.appendChild(b);
    });
    kindSec.appendChild(kinds);
    kindSec.appendChild(el('p', 'lx-win-hint', 'Тип помогает найти требование в документации; измерения сверяются сами.'));
    side.appendChild(kindSec);

    var autoSec = el('section', 'lx-win-sec'); autoSec.id = 'lxInsAuto';
    autoSec.appendChild(el('h4', 'lx-win-h', 'Автоматический замер'));
    var autoB = button('Измерить автоматически', 'wand-sparkles', 'primary lx-auto-btn', 'Найти размеры выделенного объекта по облаку: проём, стена, труба, лоток. Каждый размер идёт с погрешностью и уровнем уверенности');
    autoB.id = 'lxInsAutoBtn'; autoB.onclick = function () { runAuto(); };
    autoSec.appendChild(autoB);
    var pickB = button('Указать объект', 'crosshair', 'lx-auto-pick', 'Кликните в окне по нужному объекту (по самой трубе, проёму, стене): замер выберет именно его, а не землю или стену вокруг');
    pickB.id = 'lxInsAutoPick'; pickB.setAttribute('aria-pressed', 'false'); pickB.onclick = function () { pickObject(); };
    autoSec.appendChild(pickB);
    var autoSt = el('p', 'lx-win-hint', 'Размеры найдутся сами, надёжные сохранятся в проект и сверятся с документами.'); autoSt.id = 'lxInsAutoState'; autoSt.setAttribute('role', 'status'); autoSt.setAttribute('aria-live', 'polite');
    autoSec.appendChild(autoSt);
    autoPane.appendChild(autoSec);
    var autoGrow = el('section', 'lx-win-sec grow');
    var autoOut = el('div', 'lx-auto-out'); autoOut.id = 'lxInsAutoOut'; autoOut.hidden = true; autoGrow.appendChild(autoOut);
    autoGrow.appendChild(el('p', 'lx-win-hint lx-auto-intro', 'Обведите объект рамкой и нажмите кнопку: проём, дверь, стена, труба, лоток. Если в рамку попали земля, стена или соседние объекты, выберите тип объекта или нажмите «Указать объект». Надёжные размеры самого объекта сохраняются в проект и сверяются с документами; сомнительные ждут вашего решения.'));
    autoPane.appendChild(autoGrow);

    var read = el('section', 'lx-win-sec grow');
    read.appendChild(el('h4', 'lx-win-h', 'Результат'));
    var cur = el('div', 'lx-win-cur', '—'); cur.id = 'lxInsCur'; read.appendChild(cur);
    read.appendChild(el('h4', 'lx-win-h', 'Измерения и сверка'));
    var hist = el('div', 'lx-win-hist'); hist.id = 'lxInsHist'; read.appendChild(hist);
    var openV = button('Открыть сверку', 'clipboard-check', '', 'Таблица измерений и требований из документации'); openV.id = 'lxInsOpenVerify'; openV.style.marginTop = '10px';
    openV.onclick = function () { if (window.__lxVerify) window.__lxVerify.open({}); };
    read.appendChild(openV);
    manualPane.appendChild(read);
    side.appendChild(manualPane); side.appendChild(autoPane);
    body.appendChild(side);

    win.appendChild(head); win.appendChild(body);
    modal.appendChild(win);
    modal.addEventListener('mousedown', function (e) { if (e.target === modal) close(); });
    document.body.appendChild(modal);
    if (window.__lxKit) window.__lxKit.hydrate(modal);
    setTab(state.tab);
    return modal;
  }

  function ensureViewer() {
    if (iv) return iv;
    if (!(window.Viewer3DGL && window.Viewer3DGL.isSupported && window.Viewer3DGL.isSupported())) { toast('WebGL2 недоступен — инспектор не запущен', { tone: 'warn' }); return null; }
    try { iv = new window.Viewer3DGL(ivCanvas, function () {}); } catch (e) { toast('Не удалось создать 3D-инспектор', { tone: 'err' }); iv = null; return null; }
    try { iv.setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'); } catch (e) {}
    iv.onMeasure = function (res) { onViewerMeasure(res); };
    return iv;
  }

  function setMode(m) {
    state.mode = m; state.live = null;
    if (iv) { iv.setMeasureMode(m); iv.setMeasure(true); }
    var g = modal && modal.querySelector('#lxInsModes');
    if (g) Array.prototype.forEach.call(g.children, function (c) { setOn(c, c.dataset.mode === m); });
  }

  function setTab(t) {
    state.tab = t === 'auto' ? 'auto' : 'manual';
    if (!modal) return;
    ['manual', 'auto'].forEach(function (n) {
      var on = n === state.tab, b = modal.querySelector('.lx-win-tab[data-tab="' + n + '"]'), p = modal.querySelector('.lx-win-pane[data-pane="' + n + '"]');
      if (b) { b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; }
      if (p) p.hidden = !on;
    });
  }

  function setKind(k) {
    state.kind = k || '';
    var g = modal && modal.querySelector('#lxInsKinds');
    if (g) Array.prototype.forEach.call(g.children, function (c) { var on = c.dataset.kind === state.kind; setOn(c, on); c.classList.toggle('sel', on); });
    if (state.auto.res && !state.auto.busy) renderAuto();
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
  window.addEventListener('lx-measurements-changed', function () { if (modal && !modal.hidden) { renderHist(); if (state.auto.res && !state.auto.busy) renderAuto(); } });


  /* ---------- Автоматический замер ---------- */
  var LVL_RU = { high: 'высокая', medium: 'средняя', low: 'низкая' };
  function Me() { return window.Measure || null; }
  function autoVal(d) { var m = Me(); return m && m.autoValue ? m.autoValue(d) : String(d.value); }
  function autoSig(d) { var m = Me(); return m && m.autoSigma ? m.autoSigma(d).trim() : ''; }
  /** Устойчивый ключ размера: при повторном замере того же облака запись в проекте обновляется, а не дублируется. */
  function autoKey(ob, d) { var c = ob.center || [0, 0, 0]; return [ob.title, d.key, Math.round(c[0] * 10), Math.round(c[1] * 10), Math.round(c[2] * 10)].join('|'); }
  /** Тип объекта для сверки: выбранный человеком — только если подходит найденному объекту, иначе по самому объекту. */
  function autoType(ob) {
    var AM = window.AutoMeasure, fam = AM && AM.KIND_FAMILY ? AM.KIND_FAMILY[state.kind] : null;
    var keys = ob.dims.map(function (d) { return d.key; }).join(' ');
    if (ob.type === 'pair' && /room-/.test(keys)) return 'помещение';
    if (state.kind && fam && (fam === ob.family || (fam === 'box' && ob.family === 'panel'))) return state.kind;
    if (ob.type === 'opening') return /Дверн/.test(ob.title) ? 'дверь' : 'проём';
    if (ob.type === 'cylinder' || ob.type === 'pipes') return 'труба';
    if (/inner-width/.test(keys)) return 'лоток';
    if (/slab-thickness/.test(keys)) return 'перекрытие';
    if (/wall-thickness/.test(keys)) return 'стена';
    return state.kind || null;
  }
  function autoSetState(text) { var p = modal && modal.querySelector('#lxInsAutoState'); if (p) p.textContent = text || ''; }
  function autoBusy(on) {
    var b = modal && modal.querySelector('#lxInsAutoBtn'); if (!b) return;
    b.classList.toggle('busy', !!on); b.disabled = !!on; b.setAttribute('aria-busy', on ? 'true' : 'false');
    var l = b.querySelector('.lbl'); if (l) l.textContent = on ? 'Анализ облака…' : (state.auto.res ? 'Измерить заново' : 'Измерить автоматически');
  }
  /** Сохранить один размер в проект. Повтор обновляет ту же запись. Возвращает { idx, fresh } или null. */
  function saveAutoDim(ob, d) {
    var dc = docCheck(), AM = window.AutoMeasure; if (!dc || !AM) return null;
    var res = AM.toMeasurement(d, { object: ob.title });
    var label = (ob.title + ': ' + d.label).slice(0, 120), type = autoType(ob), key = autoKey(ob, d), sv = state.auto.saved[key];
    try {
      var row = sv ? dc.row(sv.idx) : null;
      if (row && row.origin === 'auto' && row.label === label) {
        if (!dc.update(sv.idx, res)) return null;
        if (sv.type !== type) { dc.setContext(sv.idx, { objectType: type || '' }); sv.type = type; }
        return { idx: sv.idx, fresh: false };
      }
      var idx = dc.add(res, { objectType: type, objectName: ob.title + (state.title ? ' · ' + state.title : ''), origin: 'auto', label: label });
      if (idx < 0) return null;
      state.auto.saved[key] = { idx: idx, type: type };
      return { idx: idx, fresh: true };
    } catch (e) { return null; }
  }
  function autoSavedIdx(ob, d) {
    var dc = docCheck(), sv = state.auto.saved[autoKey(ob, d)]; if (!dc || !sv) return null;
    var row = dc.row(sv.idx); return row && row.origin === 'auto' ? sv.idx : null;
  }
  /** Надёжные размеры главного объекта (высокая и средняя уверенность) сохраняются сами; низкая — только по кнопке.
   *  Привязки к окружению (высота над «полом» и т.п. — не размер самого объекта) и находки не того типа сами не сохраняются никогда. */
  function autoSaveReliable(ob) {
    var n = 0; if (!ob || ob.offType) return 0;
    ob.dims.forEach(function (d) { if (d.ref || d.level === 'low') return; var r = saveAutoDim(ob, d); if (r) n++; });
    return n;
  }
  function autoSaveAll() {
    var res = state.auto.res, n = 0, skipped = 0, refs = 0, off = 0; if (!res || !res.ok) return;
    res.objects.forEach(function (ob) {
      if (ob.offType) { off++; return; }
      ob.dims.forEach(function (d) { if (d.ref) { refs++; return; } if (d.level === 'low') { skipped++; return; } if (saveAutoDim(ob, d)) n++; });
    });
    var rest = [];
    if (skipped) rest.push('низкую уверенность оставил на ваше решение: ' + skipped);
    if (refs) rest.push('привязки к окружению не сохраняю: ' + refs);
    if (off) rest.push('находки другого типа пропущены: ' + off);
    toast('В проект сохранено размеров: ' + n + (rest.length ? ' (' + rest.join('; ') + ')' : ''), { tone: n ? 'ok' : 'info' });
    renderAuto();
  }
  var ROLE_RU = { pipe: 'трубы', opening: 'проём', wall: 'стена', slab: 'перекрытие', 'room-height': 'помещение', 'room-width': 'помещение', tray: 'лоток', other: 'прочее' };
  function rolesText(list) { var seen = {}, out = []; (list || []).forEach(function (r) { var t = ROLE_RU[r] || r; if (!seen[t]) { seen[t] = 1; out.push(t); } }); return out.join(', '); }
  /** Точка, по которой выбирать объект: указанная человеком в окне, иначе точка клика «умного захвата» в основном вьювере. */
  function autoFocus() {
    if (state.focus && state.focus.length >= 3) return state.focus;
    var m = state.lastCloud && state.lastCloud.meta; return m && m.seed && m.seed.length >= 3 ? m.seed : null;
  }
  function runAuto() {
    var a = state.auto, AM = window.AutoMeasure;
    if (!AM || !AM.analyze) { toast('Модуль автозамера не загружен', { tone: 'err' }); return; }
    if (!state.lastCloud || !state.lastCloud.pos || !state.lastCloud.pos.length) { toast('Нет облака для замера', { tone: 'warn' }); return; }
    if (a.busy) return;
    var focus = autoFocus();
    a.busy = true; a.more = false; autoBusy(true); autoSetState('Ищу плоскости, откосы и окружности в ' + nfmt(state.lastCloud.count || state.lastCloud.pos.length / 3) + ' точках…'); renderAuto();
    setTimeout(function () {
      var res = null;
      try { res = AM.analyze(state.lastCloud.pos, { kind: state.kind, focus: focus }); } catch (e) { res = { ok: false, error: String(e && e.message || e), objects: [] }; }
      a.busy = false; a.res = res; a.kind = state.kind; a.shown = null; a.focus = focus; a.focusUser = !!state.focus;
      var main = res && res.ok ? (res.main !== undefined ? res.main : (res.objects[0] || null)) : null, saved = 0;
      if (main) saved = autoSaveReliable(main);
      autoBusy(false);
      if (!res || !res.ok) autoSetState(res && res.error || 'Автозамер не удался.');
      else if (!res.objects.length) autoSetState('Размеров не нашлось: обведите объект так, чтобы были видны его грани или окружность.');
      else if (!main) autoSetState('Объект типа \u00ab' + (state.kind || '') + '\u00bb в рамке не найден, ничего не сохранено. Обведите объект плотнее, смените тип или укажите объект точкой.');
      else autoSetState((saved ? 'В проект сохранено: ' + saved + ' (размеры самого объекта). ' : 'Ничего не сохранено автоматически: уверенность низкая. ') + 'Проверьте значения ниже.');
      renderAuto();
      if (main) showOutline(main);
      if (saved) toast('Автозамер: в проект сохранено размеров: ' + saved, { tone: 'ok' });
    }, 40);
  }
  /** «Указать объект»: следующий клик по облаку в окне — точка, по которой автозамер выбирает объект среди найденного. */
  function pickObject() {
    if (!iv) return;
    state.pickObj = !state.pickObj;
    var b = modal && modal.querySelector('#lxInsAutoPick'); setOn(b, state.pickObj);
    if (state.pickObj) { try { iv.setMeasureMode('point'); iv.setMeasure(true); } catch (e) {} autoSetState('Кликните по нужному объекту (по самой трубе, проёму, стене) \u2014 замер повторится именно по нему.'); }
    else { setMode(state.mode); autoSetState('Выбор точки отменён.'); }
  }
  function onViewerMeasure(res) {
    if (state.pickObj && res && res.mode === 'point' && res.point) {
      var pt = [res.point[0], res.point[1], res.point[2]];
      setTimeout(function () {
        state.pickObj = false; state.focus = pt; setOn(modal && modal.querySelector('#lxInsAutoPick'), false);
        setMode(state.mode); runAuto();
      }, 0);
      return;
    }
    refreshReadout(res);
  }
  function autoClear() {
    state.auto = { res: null, busy: false, kind: state.kind, saved: {}, more: false, shown: null, note: '' };
    state.focus = null; state.pickObj = false; setOn(modal && modal.querySelector('#lxInsAutoPick'), false);
    autoBusy(false); autoSetState('Размеры найдутся сами, надёжные сохранятся в проект и сверятся с документами.'); renderAuto();
  }
  /** Контур найденного объекта (ось/кольца трубы, рамка проёма, куски плоскостей) — чтобы видеть, ЧТО именно измерено. */
  function outlineObj(ob) {
    var o = ob && ob.outline; if (!o || o.length < 2) return null;
    var n = o.length - (o.length % 2), pos = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) { pos[i * 3] = o[i][0]; pos[i * 3 + 1] = o[i][1]; pos[i * 3 + 2] = o[i][2]; }
    return { line: true, pos: pos, color: [0.35, 0.78, 1] };
  }
  function focusMarker() {
    var f = state.focus; if (!f || f.length < 3) return null;
    return { points: true, pos: new Float32Array([f[0], f[1], f[2]]), col: null, color: [1, 0.85, 0.2], pointSize: 13, status: 'none', _isSel: true, _spacing: 0, _ptMax: 22 };
  }
  function showOutline(ob) {
    if (!iv || !ob) return;
    var ov = [], ol = outlineObj(ob), fm = focusMarker();
    if (ol) ov.push(ol); if (fm) ov.push(fm);
    try { iv._setOverlay(ov); iv._measLabels = []; iv._renderMeasLabels(); iv.render(); state.auto.shown = 'outline:' + ob.id; } catch (e) {}
  }
  /** Показать размер на облаке: отрезок между точками измерения, точки и подпись; контур объекта остаётся рядом. */
  function showAuto(ob, d) {
    if (!iv || !d.a || !d.b) return;
    var col = d.level === 'high' ? [0.2, 0.85, 0.45] : d.level === 'medium' ? [1, 0.75, 0.2] : [1, 0.35, 0.35];
    try {
      var ov = [iv._mkLine(d.a, d.b, col), { points: true, pos: new Float32Array([d.a[0], d.a[1], d.a[2], d.b[0], d.b[1], d.b[2]]), col: null, color: col, pointSize: 15, status: 'none', _isSel: true, _spacing: 0, _ptMax: 22 }];
      var ol = outlineObj(ob); if (ol) ov.push(ol);
      iv._setOverlay(ov);
      iv._measLabels = [{ p: [(d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2, (d.a[2] + d.b[2]) / 2], t: autoVal(d) + (autoSig(d) ? ' ' + autoSig(d) : '') }];
      iv._renderMeasLabels(); iv.render();
      state.auto.shown = autoKey(ob, d);
    } catch (e) {}
  }
  function dimTip(ob, d) {
    var parts = ['Способ: ' + (d.how || '—') + '.'];
    parts.push('Погрешность \u00b1 считается по разбросу точек облака; точность самого скана (обычно \u00b12\u20135 мм) в неё не входит.');
    if (d.range && d.range.length === 2) parts.push('Значение по длине меняется от ' + autoVal({ dimension: d.dimension, value: d.range[0] }) + ' до ' + autoVal({ dimension: d.dimension, value: d.range[1] }) + '.');
    (d.notes || []).forEach(function (n) { parts.push(n); });
    return parts.join(' ');
  }
  function autoRow(ob, d) {
    var row = el('div', 'lx-auto-row ' + d.level);
    var lbl = el('div', 'lx-auto-lbl'); lbl.textContent = d.label; row.appendChild(lbl);
    var val = el('div', 'lx-auto-val'); val.textContent = autoVal(d); row.appendChild(val);
    var meta = el('div', 'lx-auto-meta');
    var sg = autoSig(d); if (sg) { var s1 = el('span', 'lx-auto-sig'); s1.textContent = sg; meta.appendChild(s1); }
    var how = el('span', 'lx-auto-how'); how.textContent = d.how || ''; meta.appendChild(how);
    var lv = el('span', 'lx-lvl ' + d.level); lv.textContent = 'уверенность: ' + (LVL_RU[d.level] || d.level); lv.setAttribute('data-tip', 'Уровень уверенности: ' + (LVL_RU[d.level] || d.level) + '. Высокая — размер подтверждён несколькими гранями с малым разбросом; низкая — проверьте вручную.'); meta.appendChild(lv);
    row.appendChild(meta);
    if (d.level === 'low' && d.notes && d.notes.length) { var nt = el('div', 'lx-auto-warn'); nt.textContent = d.notes[0].split(/\.\s/)[0].replace(/\.$/, '') + '. Подробности \u2014 в подсказке строки.'; row.appendChild(nt); }
    var acts = el('div', 'lx-auto-acts');
    var showB = button('Показать', 'eye', '', 'Показать этот размер на облаке: отрезок, точки и подпись'); showB.dataset.autoShow = d.key; showB.onclick = function () { showAuto(ob, d); }; acts.appendChild(showB);
    var idx = autoSavedIdx(ob, d);
    if (idx == null) { var sv = button('Сохранить', 'save', '', 'Сохранить размер в проект и сверить с документами'); sv.dataset.autoSave = d.key; sv.onclick = function () { var r = saveAutoDim(ob, d); if (r) { toast('Размер сохранён в проект', { tone: 'ok' }); renderAuto(); } else toast('Не удалось сохранить размер', { tone: 'err' }); }; acts.appendChild(sv); }
    else { var ok = el('span', 'lx-auto-saved', ico('check', 14) + '<span class="lbl">в проекте</span>'); acts.appendChild(ok); var chip = statusChip(idx); if (chip) acts.appendChild(chip); }
    row.appendChild(acts);
    row.setAttribute('data-tip', dimTip(ob, d));
    return row;
  }
  function autoCard(ob, main) {
    var card = el('div', 'lx-auto-card' + (main ? ' main' : '') + (ob.offType ? ' off' : ''));
    var head = el('div', 'lx-auto-head'); var t = el('span', ''); t.textContent = ob.title; head.appendChild(t);
    var tag = main ? 'главный объект' : (ob.offType ? 'другой тип' : '');
    if (tag) { var sm = el('small', ''); sm.textContent = tag; head.appendChild(sm); }
    card.appendChild(head);
    if (ob.outline && ob.outline.length > 1) {
      var line = el('div', 'lx-auto-objline');
      var tx = el('span', 'lx-auto-objtxt'); tx.textContent = 'Измерено по этому объекту' + (ob.pointsUsed ? ' \u00b7 ' + nfmt(ob.pointsUsed) + ' т.' : ''); line.appendChild(tx);
      var ob1 = button('Показать объект', 'eye', '', 'Подсветить в окне контур этого объекта: видно, что именно измерено'); ob1.dataset.autoOutline = String(ob.id); ob1.onclick = function () { showOutline(ob); }; line.appendChild(ob1);
      card.appendChild(line);
    }
    var own = ob.dims.filter(function (d) { return !d.ref; }), refs = ob.dims.filter(function (d) { return d.ref; });
    own.forEach(function (d) { card.appendChild(autoRow(ob, d)); });
    if (refs.length) {
      var g = el('div', 'lx-auto-grp'); g.textContent = 'Привязка к окружению \u2014 не размер объекта, сама в проект не сохраняется'; card.appendChild(g);
      refs.forEach(function (d) { card.appendChild(autoRow(ob, d)); });
    }
    (ob.notes || []).forEach(function (n) { var p = el('div', 'lx-auto-warn'); p.textContent = n; card.appendChild(p); });
    return card;
  }
  function renderAuto() {
    var out = modal && modal.querySelector('#lxInsAutoOut'); if (!out) return;
    var a = state.auto, res = a.res;
    var intro = modal.querySelector('.lx-auto-intro'); if (intro) intro.hidden = !!(res || a.busy);
    out.innerHTML = '';
    if (!res && !a.busy) { out.hidden = true; return; }
    out.hidden = false;
    if (a.busy) { out.appendChild(el('div', 'lx-auto-sum', '<span class="vf-spin" aria-hidden="true"></span> Идёт анализ облака…')); return; }
    if (!res.ok || !res.objects.length) { var e = el('div', 'lx-auto-sum err'); e.textContent = res.ok ? 'Размеров не найдено. Обведите объект так, чтобы были видны его грани (проём \u2014 вместе с откосами, трубу \u2014 с большей частью окружности).' : (res.error || 'Автозамер не удался.'); out.appendChild(e); return; }
    var main = res.main !== undefined ? res.main : res.objects[0];
    var sum = el('div', 'lx-auto-sum');
    var ghosts = res.info && res.info.ghosts ? res.info.ghosts : 0;
    sum.textContent = 'Найдено объектов: ' + res.objects.length + ' \u00b7 точек: ' + nfmt(res.info.used || res.info.points || 0) + ' \u00b7 ' + (res.info.ms || 0) + ' мс' + (ghosts ? ' \u00b7 отброшено ложных находок: ' + ghosts : '');
    if (ghosts && res.rejected && res.rejected.length) sum.setAttribute('data-tip', 'Отброшено как «не труба»: ' + res.rejected.slice(0, 5).map(function (r) { return r.title + ' (' + r.why + ')'; }).join('; ') + '. Причина: подгонка по огибающей пучка, по земле или по стене.');
    out.appendChild(sum);
    if (a.kind !== state.kind) { var st = el('div', 'lx-auto-sum warn'); st.textContent = 'Тип объекта изменён после замера: нажмите «Измерить заново», чтобы пересчитать приоритет.'; out.appendChild(st); }
    if (res.noMatch) {
      var nm = el('div', 'lx-auto-sum err'); nm.id = 'lxInsAutoNoMatch';
      nm.textContent = 'Объект типа \u00ab' + res.noMatch.kind + '\u00bb в рамке не найден. Нашлось другое: ' + res.noMatch.found.join('; ') + '. Это не размеры вашего объекта, в проект они сами не сохраняются. Обведите объект плотнее, смените тип или нажмите «Указать объект».';
      out.appendChild(nm);
    } else if (main) {
      var roles = res.info && res.info.roles ? res.info.roles : [];
      if (!res.kind && roles.length > 1) {
        var hn = el('div', 'lx-auto-sum hint'); hn.textContent = 'В рамке разные объекты (' + rolesText(roles) + '). Главным выбран \u00ab' + main.title + '\u00bb \u2014 самый уверенный. Нужен другой: выберите тип объекта сверху или нажмите «Указать объект».'; out.appendChild(hn);
      }
      if (res.focus && res.focus.far) {
        var fn0 = el('div', 'lx-auto-sum warn'); fn0.textContent = 'Найденный объект в ' + Math.round(100 * res.focus.distance) + ' см от указанной точки \u2014 возможно, это не тот. Нажмите «Указать объект» и кликните по самой трубе, проёму или стене.'; out.appendChild(fn0);
      } else if (res.focus && a.focusUser) {
        var fn1 = el('div', 'lx-auto-sum hint'); fn1.textContent = 'Объект выбран по вашей точке' + (res.focus.distance != null ? ' (в ' + Math.round(100 * res.focus.distance) + ' см от неё)' : '') + '.'; out.appendChild(fn1);
      }
      out.appendChild(autoCard(main, true));
    }
    var rest = res.objects.filter(function (ob) { return ob !== main; });
    if (rest.length) {
      var more = el('button', 'lx-auto-more', ico(a.more ? 'chevron-down' : 'chevron-right', 14) + '<span class="lbl">' + (res.noMatch ? 'Другое в рамке' : 'Ещё найдено') + ' (' + rest.length + ')</span>');
      more.type = 'button'; more.id = 'lxInsAutoMore'; more.setAttribute('aria-expanded', a.more ? 'true' : 'false');
      more.onclick = function () { a.more = !a.more; renderAuto(); };
      out.appendChild(more);
      if (a.more) rest.forEach(function (ob) { out.appendChild(autoCard(ob, false)); });
    }
    var fn = el('div', 'lx-auto-sum'); fn.textContent = 'Погрешность \u00b1 считается по разбросу точек облака; точность самого скана (обычно \u00b12\u20135 мм) в неё не входит. «Низкая» уверенность: проверьте размер вручную.'; out.appendChild(fn);
    var all = button('Сохранить всё найденное', 'save-all', '', 'Сохранить в проект размеры объектов выбранного типа: без привязок к окружению, без находок другого типа и без низкой уверенности'); all.id = 'lxInsAutoSaveAll'; all.onclick = autoSaveAll; out.appendChild(all);
    if (window.__lxKit) window.__lxKit.hydrate(out);
  }

  function _strideDown(c, target) { var n = c.pos.length / 3; if (n <= target) return c; var step = Math.ceil(n / target); var m = Math.floor(n / step) + 1; var p = new Float32Array(m * 3); var col = c.col ? new c.col.constructor(m * 3) : null; var w = 0; for (var i = 0; i < n && w < m; i += step) { p[w * 3] = c.pos[i * 3]; p[w * 3 + 1] = c.pos[i * 3 + 1]; p[w * 3 + 2] = c.pos[i * 3 + 2]; if (col) { col[w * 3] = c.col[i * 3]; col[w * 3 + 1] = c.col[i * 3 + 1]; col[w * 3 + 2] = c.col[i * 3 + 2]; } w++; } return { pos: p.subarray(0, w * 3), col: col ? col.subarray(0, w * 3) : null, count: w }; }

  function openWithCloud(cloud, title) {
    if (!cloud || !cloud.pos || !cloud.pos.length) { toast('Пустой объект — нечего измерять', { tone: 'warn' }); return false; }
    buildModal();
    prevFocus = document.activeElement;
    modal.hidden = false;
    var v = ensureViewer(); if (!v) { modal.hidden = true; return false; }
    state.lastCloud = cloud; state.title = title || 'Объект'; state.live = null;
    var t = modal.querySelector('#lxInsTitle'); if (t) t.textContent = (title || 'Объект') + ' · ' + nfmt(cloud.count || cloud.pos.length / 3) + ' т.';
    state.hist = []; renderHist(); refreshReadout(null); autoClear();
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
