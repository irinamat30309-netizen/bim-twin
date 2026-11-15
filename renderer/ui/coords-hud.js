/*
 * coords-hud.js — r130 · координаты точки облака под курсором в статус-баре.
 *
 * Что делает: на hover по 3D-вьюеру показывает в правой части нижнего статус-бара
 * (#lxStatus) координаты точки облака под курсором в формате
 *   X: 12.345  Y: 3.210  Z: -8.120 м
 * Нет точки рядом/курсор вне вьюера/облако скрыто → прочерки «—».
 *
 * Как получаем точку (см. отчёт PHASE7-COORDS.md):
 *   1) GPU-pick вьюера — v._pickGPU(x, y, radiusPx): WYSIWYG depth-buffer picking,
 *      реальная видимая точка по gl_VertexID (с окклюзией/клип-боксом);
 *   2) CPU-сэмплинг вьюера — v._pickPoint(x, y): ближайшая точка облака в радиусе 22 px,
 *      при >300k точек подвыборка (тот же путь, что у измерений/снапа);
 *   3) v.pick(x, y) для potree/three-вьюеров (если такие подключены);
 *   4) собственный сэмплинг по проекции base[0].pos (на случай вьюера без picking).
 * Всё это — в обработчике pointermove с троттлингом 80 мс (60–100 по заданию) и
 * ранним выходом, поэтому событие стоит доли миллисекунды; сам пик — не чаще 12 раз/с.
 * Во время орбиты/панорамы (v._interacting) пик пропускается, чтобы не ронять FPS.
 *
 * Отключаемо: клик по координатам скрывает их; флаг localStorage['lxCoordsHud']='0'
 * (вернуть — __lxCoordsHud.setEnabled(true)). Единицы: м (3 знака) / мм (1 знак) —
 * localStorage['lxCoordsHudUnits'], __lxCoordsHud.setUnits('m'|'mm').
 * Ось Y — вверх (сцена BIM Twin Y-up): показываем координаты внутреннего кадра
 * проекта, как в измерении точки (mmPoint) и в старом #lxX/#lxY/#lxZ.
 *
 * API: window.__lxCoordsHud = { mount, dispose, refresh, setEnabled, isEnabled, toggle,
 *   setUnits, getUnits, setThrottle, getThrottle, updateAt, current, formatPoint,
 *   formatText, formatCoordValue, pickPointAt, pickByProjection, getViewer,
 *   STORAGE_KEY, UNITS_KEY, DEFAULT_THROTTLE_MS, PICK_RADIUS_PX, version }.
 * Для node --test доступен через module.exports (чистые функции без DOM).
 */
(function () {
  'use strict';

  var VERSION = '130';
  var STORAGE_KEY = 'lxCoordsHud';        // '0' — выключено, иначе включено
  var UNITS_KEY = 'lxCoordsHudUnits';     // 'm' | 'mm'
  var DEFAULT_THROTTLE_MS = 80;           // 60–100 мс по заданию
  var PICK_RADIUS_PX = 20;                // радиус захвата точки под курсором, px
  var AXES = ['X', 'Y', 'Z'];
  var UNITS = {
    m: { key: 'm', label: 'м', decimals: 3, scale: 1 },
    mm: { key: 'mm', label: 'мм', decimals: 1, scale: 1000 }
  };

  function isFiniteNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { var v = Number(x); return isFinite(v) ? v : NaN; }
  function nowMs() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }
  function hasDoc() { return typeof document !== 'undefined' && !!document; }
  function hasWin() { return typeof window !== 'undefined' && !!window; }

  // ===================== ФОРМАТИРОВАНИЕ (чистые функции) =====================
  /** Округление до decimals знаков (устойчиво к -0). */
  function roundCoord(v, decimals) {
    if (!isFiniteNum(v)) return NaN;
    var d = decimals == null ? 3 : decimals;
    var k = Math.pow(10, d);
    var r = Math.round(v * k) / k;
    return r === 0 ? 0 : r;
  }
  /** Одно значение координаты в строку: 12.345 / -8.120 / 0.000 / 12345.0 (мм) / «—». */
  function formatCoordValue(v, decimals, scale) {
    var val = num(v);
    if (!isFinite(val)) return '—';
    var d = decimals == null ? 3 : decimals;
    var r = roundCoord(val * (scale == null ? 1 : scale), d);
    if (!isFinite(r)) return '—';
    if (r === 0) r = 0;                       // -0 → 0
    var s = r.toFixed(d);
    if (/^-0(\.0+)?$/.test(s)) s = s.slice(1); // -0.000 → 0.000
    return s;
  }
  function unitOptions(units) {
    var key = String(units || '').toLowerCase();
    if (key === 'мм' || key === 'mm') return UNITS.mm;
    return UNITS.m;
  }
  /**
   * Форматирование точки в части и строку формата «X: 12.345  Y: 3.210  Z: -8.120 м».
   * @param {Array|Float32Array|null} point — [x,y,z]
   * @param {{units?:'m'|'mm', decimals?:number}} [opts]
   * @returns {{ok:boolean, units:string, unit:string, decimals:number, parts:Array, text:string}}
   */
  function formatPoint(point, opts) {
    opts = opts || {};
    var u = unitOptions(opts.units);
    var decimals = opts.decimals == null ? u.decimals : Math.max(0, opts.decimals | 0);
    var p = point && point.length >= 3 ? point : null;
    var parts = [];
    var ok = true;
    for (var i = 0; i < 3; i++) {
      var value = '—';
      if (p) {
        var raw = num(p[i]);
        if (isFinite(raw)) value = formatCoordValue(raw, decimals, u.scale);
        else ok = false;
      } else ok = false;
      parts.push({ axis: AXES[i], raw: p ? num(p[i]) : null, value: value });
    }
    var text = parts.map(function (q) { return q.axis + ': ' + q.value; }).join('  ') + ' ' + u.label;
    return { ok: ok, units: u.key, unit: u.label, decimals: decimals, parts: parts, text: text };
  }
  function formatText(point, opts) { return formatPoint(point, opts).text; }

  // ===================== ПИКИНГ ТОЧКИ =====================
  function getViewer() {
    try {
      if (hasWin() && window.__pcTools && window.__pcTools.viewer) {
        var v = window.__pcTools.viewer();
        if (v) return v;
      }
      if (hasWin() && window.__viewer) return window.__viewer;
      if (hasWin() && window.__lxViewer) return window.__lxViewer;
    } catch (e) { }
    return null;
  }
  function canvasOf(v) {
    try { return (v && (v.canvas || (v.gl && v.gl.canvas))) || null; } catch (e) { return null; }
  }
  function rectOf(v) {
    try {
      var c = canvasOf(v);
      return c && c.getBoundingClientRect ? c.getBoundingClientRect() : null;
    } catch (e) { return null; }
  }
  function cloudHidden(v) {
    try {
      if (!v) return true;
      if (v.cloudVisible === false) return true;
      if (v._cloudDisplay && v._cloudDisplay.opacity === 0) return true;
    } catch (e) { }
    return false;
  }
  function inRect(r, x, y) {
    return !!r && r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }
  // Собственный сэмплинг по проекции: ближайшая к курсору точка base[0].pos (для вьюеров без picking).
  function pickByProjection(viewer, clientX, clientY, radiusPx) {
    try {
      var v = viewer;
      if (!v || !v.base || !v.base.length) return null;
      var bo = v.base[0];
      if (!bo || !bo.pos || !bo.pos.length) return null;
      var rect = rectOf(v);
      if (!inRect(rect, clientX, clientY)) return null;
      var M = v._lastVP || (typeof v._vp === 'function' ? v._vp() : null);
      if (!M || M.length < 16) return null;
      var P = bo.pos, n = (P.length / 3) | 0;
      var cxN = (clientX - rect.left) / rect.width * 2 - 1;
      var cyN = 1 - (clientY - rect.top) / rect.height * 2;
      var R = radiusPx || PICK_RADIUS_PX;
      var rx = R / rect.width * 2, ry = R / rect.height * 2;
      var best = null, bestScore = Infinity;
      var step = n > 300000 ? Math.ceil(n / 300000) : 1;
      for (var i = 0; i < n; i += step) {
        var x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        var cw = M[3] * x + M[7] * y + M[11] * z + M[15];
        if (cw <= 0) continue;
        var nx = (M[0] * x + M[4] * y + M[8] * z + M[12]) / cw;
        var ny = (M[1] * x + M[5] * y + M[9] * z + M[13]) / cw;
        var dx = (nx - cxN) / rx, dy = (ny - cyN) / ry;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) continue;
        var score = dx * dx + dy * dy + Math.max(0, cw) * 1e-6;
        if (score < bestScore) { bestScore = score; best = [x, y, z]; }
      }
      return best;
    } catch (e) { return null; }
  }
  /**
   * Точка облака под курсором: GPU-pick → CPU-сэмплинг вьюера → v.pick → свой сэмплинг.
   * @returns {{ok:boolean, point?:number[], source:string, ms:number, reason?:string}}
   */
  function pickPointAt(viewer, clientX, clientY, opts) {
    opts = opts || {};
    var t0 = nowMs();
    var fail = function (reason) { return { ok: false, source: 'none', reason: reason || 'рядом нет точек облака', ms: nowMs() - t0 }; };
    var ok = function (point, source) {
      return { ok: true, point: [+point[0], +point[1], +point[2]], source: source, ms: nowMs() - t0 };
    };
    var v = viewer;
    if (!v) return fail('нет активного вьюера');
    if (cloudHidden(v)) return fail('облако скрыто');
    var x = num(clientX), y = num(clientY);
    if (!isFinite(x) || !isFinite(y)) return fail('нет координат курсора');
    // 1) GPU-pick вьюера: реальная видимая точка под курсором (WYSIWYG, с окклюзией)
    if (!opts.cpuOnly && typeof v._pickGPU === 'function') {
      try {
        var g = v._pickGPU(x, y, opts.radiusPx || PICK_RADIUS_PX);
        if (g && g.point) return ok(g.point, 'gpu');
      } catch (e) { }
    }
    // 2) CPU-сэмплинг вьюера: ближайшая точка облака в радиусе ~22 px (подвыборка больших облаков)
    if (typeof v._pickPoint === 'function') {
      try {
        var p = v._pickPoint(x, y);
        if (p && p.point) return ok(p.point, 'cpu');
      } catch (e) { }
    }
    // 3) potree/three-вьюеры
    if (typeof v.pick === 'function') {
      try {
        var r = v.pick(x, y);
        var pos = r && (r.position || r.point);
        if (pos && pos.length >= 3) return ok(pos, 'pick');
      } catch (e) { }
    }
    // 4) собственный сэмплинг по проекции (если у вьюера нет своего picking)
    var own = opts.cpuOnly ? pickByProjection(v, x, y, opts.radiusPx) : null;
    if (own) return ok(own, 'sample');
    if (!opts.cpuOnly && typeof v._pickGPU !== 'function' && typeof v._pickPoint !== 'function' && typeof v.pick !== 'function') {
      own = pickByProjection(v, x, y, opts.radiusPx);
      if (own) return ok(own, 'sample');
    }
    return fail();
  }

  // ===================== СОСТОЯНИЕ =====================
  function readEnabled() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return true;
      var s = localStorage.getItem(STORAGE_KEY);
      return !(s === '0' || s === 'false' || s === 'off');
    } catch (e) { return true; }
  }
  function readUnits() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return 'm';
      var s = String(localStorage.getItem(UNITS_KEY) || '').toLowerCase();
      return (s === 'mm' || s === 'мм') ? 'mm' : 'm';
    } catch (e) { return 'm'; }
  }

  var st = {
    mounted: false, bound: false, panel: null, el: null, valEls: null, unitEl: null,
    enabled: readEnabled(), units: readUnits(), throttle: DEFAULT_THROTTLE_MS,
    timer: 0, lastRun: 0, lastXY: null, current: null, listeners: []
  };

  // ===================== DOM =====================
  function toast(msg) {
    try { if (hasWin() && window.__toast) return window.__toast(msg, 'info'); } catch (e) { }
  }
  var CSS_ID = 'lxCoordsHudStyles';
  var CSS = [
    '.lx-coords-hud { display: inline-flex; flex: none; align-items: center; gap: 4px; padding: 0 2px; color: var(--txt-2); font: 11px/1 var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }',
    '.lx-coords-hud[hidden] { display: none !important; }',
    '.lx-coords-hud .lx-ch-axis { margin-left: 7px; color: var(--txt-3); font-weight: 600; }',
    '.lx-coords-hud .lx-ch-axis:first-child { margin-left: 0; }',
    '.lx-coords-hud .lx-ch-val { min-width: 58px; color: var(--txt); text-align: right; }',
    '.lx-coords-hud[data-coords-ok="0"] .lx-ch-val { color: var(--txt-3); }',
    '.lx-coords-hud .lx-ch-unit { margin-left: 3px; color: var(--txt-3); }'
  ].join('\n');
  function ensureStyles() {
    if (!hasDoc()) return;
    try {
      if (document.getElementById(CSS_ID)) return;
      var s = document.createElement('style');
      s.id = CSS_ID;
      s.textContent = CSS;
      (document.head || document.documentElement || document.body).appendChild(s);
    } catch (e) { }
  }
  function statusHost() {
    if (!hasDoc()) return null;
    return document.getElementById('lxStatus') || document.querySelector('.lx-status') || document.querySelector('footer') || null;
  }
  function ensureEl() {
    if (!hasDoc()) return null;
    var ex = document.getElementById('lxCoordsHud');
    if (ex) {
      st.el = ex;
      st.valEls = {
        X: ex.querySelector('[data-coords="x"]'),
        Y: ex.querySelector('[data-coords="y"]'),
        Z: ex.querySelector('[data-coords="z"]')
      };
      st.unitEl = ex.querySelector('[data-coords-unit]');
      return ex;
    }
    var host = statusHost();
    if (!host) return null;
    var el = document.createElement('div');
    el.id = 'lxCoordsHud';
    el.className = 'lx-coords-hud';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'off');
    el.setAttribute('data-coords-hud', '1');
    el.setAttribute('title', 'Координаты точки облака под курсором, м · клик — скрыть (вернуть: __lxCoordsHud.setEnabled(true))');
    el.innerHTML =
      '<span class="lx-ch-axis" data-coords-axis="x">X:</span> <span class="lx-ch-val" data-coords="x">—</span>' +
      ' <span class="lx-ch-axis" data-coords-axis="y">Y:</span> <span class="lx-ch-val" data-coords="y">—</span>' +
      ' <span class="lx-ch-axis" data-coords-axis="z">Z:</span> <span class="lx-ch-val" data-coords="z">—</span>' +
      ' <span class="lx-ch-unit" data-coords-unit>м</span>';
    var anchor = document.getElementById('lxSaveState');
    try { if (anchor && anchor.parentNode === host) host.insertBefore(el, anchor); else host.appendChild(el); }
    catch (e) { try { host.appendChild(el); } catch (e2) { return null; } }
    el.addEventListener('click', function () { setEnabled(false); toast('Координаты под курсором скрыты (__lxCoordsHud.setEnabled(true) — вернуть)'); });
    st.el = el;
    st.valEls = {
      X: el.querySelector('[data-coords="x"]'),
      Y: el.querySelector('[data-coords="y"]'),
      Z: el.querySelector('[data-coords="z"]')
    };
    st.unitEl = el.querySelector('[data-coords-unit]');
    return el;
  }
  function render() {
    if (!st.el) return;
    var fmt = formatPoint(st.current && st.current.ok ? st.current.point : null, { units: st.units });
    try {
      st.el.hidden = !st.enabled;
      if (st.valEls) {
        for (var i = 0; i < 3; i++) {
          var node = st.valEls[AXES[i]];
          if (node) node.textContent = fmt.parts[i] ? fmt.parts[i].value : '—';
        }
      }
      if (st.unitEl) st.unitEl.textContent = fmt.unit;
      st.el.setAttribute('data-coords-ok', fmt.ok ? '1' : '0');
      st.el.setAttribute('data-coords-source', st.current ? st.current.source : 'none');
      st.el.setAttribute('data-coords-ms', String(st.current ? Math.round(st.current.ms || 0) : 0));
      st.el.setAttribute('data-coords-units', st.units);
      st.el.setAttribute('data-coords-enabled', st.enabled ? '1' : '0');
    } catch (e) { }
  }
  function textOf() {
    if (!st.el) return '';
    return String(st.el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // ===================== ТРОТТЛИНГ / ОБРАБОТЧИКИ =====================
  function runPick(x, y) {
    st.runCount = (st.runCount || 0) + 1;
    st.lastRun = nowMs();
    var v = getViewer();
    if (!v) { setCurrent(null); return null; }
    var res = pickPointAt(v, x, y);
    setCurrent(res, x, y);
    return res;
  }
  function setCurrent(res, x, y) {
    st.current = res && res.ok
      ? { ok: true, point: res.point, source: res.source, ms: res.ms, at: Date.now(), x: x, y: y }
      : { ok: false, point: null, source: (res && res.source) || 'none', reason: (res && res.reason) || '', ms: (res && res.ms) || 0, at: Date.now(), x: x, y: y };
    render();
  }
  function setDash() {
    st.current = null;
    render();
  }
  function onPointerMove(e) {
    try {
      if (!st.enabled) return;
      // Мышь в Chromium присылает и pointermove, и mousemove; не пикируем дважды.
      if (e.type === 'mousemove' && hasWin() && typeof window.PointerEvent !== 'undefined') return;
      var x = num(e.clientX), y = num(e.clientY);
      if (!isFinite(x) || !isFinite(y)) return;
      var v = getViewer();
      if (!v) { setDash(); return; }
      var rect = rectOf(v);
      if (!inRect(rect, x, y)) { setDash(); return; }
      if (v._interacting) return;  // во время орбиты/панорамы — не мешаем кадру
      st.lastXY = [x, y];
      var wait = st.throttle - (nowMs() - st.lastRun);
      if (wait > 0) { scheduleTrailing(wait); return; }
      runPick(x, y);
    } catch (err) {
      st.lastError = String((err && err.message) || err);
      if (typeof console !== 'undefined') console.error('[coords-hud] pointermove', err);
    }
  }
  function scheduleTrailing(wait) {
    if (st.timer) return;
    st.timer = setTimeout(function () {
      st.timer = 0;
      if (!st.enabled || !hasDoc()) return;
      var p = st.lastXY;
      if (!p) return;
      var v = getViewer();
      if (!v || v._interacting) return;
      if (!inRect(rectOf(v), p[0], p[1])) { setDash(); return; }
      runPick(p[0], p[1]);
    }, Math.max(16, wait | 0));
  }
  function onPointerLeave(e) {
    if (!st.enabled) return;
    var v = getViewer();
    var canvas = canvasOf(v);
    if (v && canvas && e && e.target && e.target !== canvas) return;   // не наш канвас
    setDash();
  }

  function bind() {
    if (!hasDoc() || st.bound) return;
    st.bound = true;
    st.listeners = [];
    st.lastRun = nowMs() - st.throttle;   // первый pointermove не должен ждать троттлинг
    var on = function (target, type, fn, capture) {
      try { target.addEventListener(type, fn, capture); st.listeners.push([target, type, fn, capture]); } catch (e) { }
    };
    on(document, 'pointermove', onPointerMove, { passive: true });
    on(document, 'mousemove', onPointerMove, { passive: true });   // фолбэк для сред без PointerEvent
    on(document, 'pointerleave', onPointerLeave, true);
    on(document, 'pointerout', onPointerLeave, true);
    if (hasWin()) on(window, 'blur', function () { setDash(); });
    // отключаемый флаг из других модулей/меню
    if (hasWin()) on(window, 'lx-coords-hud-toggle', function () { toggle(); });
  }
  function unbind() {
    for (var i = 0; i < st.listeners.length; i++) {
      try { st.listeners[i][0].removeEventListener(st.listeners[i][1], st.listeners[i][2], st.listeners[i][3]); } catch (e) { }
    }
    st.listeners = [];
    st.bound = false;
    if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
  }

  // ===================== ПУБЛИЧНОЕ УПРАВЛЕНИЕ =====================
  function mount() {
    if (!hasDoc()) return null;
    ensureStyles();
    var el = ensureEl();
    if (!el) return null;
    st.mounted = true;
    bind();
    render();
    return el;
  }
  function dispose() {
    unbind();
    try { if (st.el && st.el.parentNode) st.el.parentNode.removeChild(st.el); } catch (e) { }
    try { var s = hasDoc() && document.getElementById(CSS_ID); if (s && s.parentNode) s.parentNode.removeChild(s); } catch (e2) { }
    st.el = null; st.valEls = null; st.unitEl = null; st.mounted = false; st.current = null;
  }
  function setEnabled(on) {
    st.enabled = !!on;
    try { if (typeof localStorage !== 'undefined' && localStorage) localStorage.setItem(STORAGE_KEY, st.enabled ? '1' : '0'); } catch (e) { }
    if (st.enabled && !st.mounted) mount();
    render();
    return st.enabled;
  }
  function isEnabled() { return st.enabled; }
  function toggle() { return setEnabled(!st.enabled); }
  function setUnits(units) {
    var u = unitOptions(units).key;
    st.units = u;
    try { if (typeof localStorage !== 'undefined' && localStorage) localStorage.setItem(UNITS_KEY, u); } catch (e) { }
    render();
    return u;
  }
  function getUnits() { return st.units; }
  function setThrottle(ms) {
    var v = num(ms);
    st.throttle = isFinite(v) ? Math.max(0, Math.min(1000, v)) : DEFAULT_THROTTLE_MS;
    st.lastRun = nowMs() - st.throttle;   // ближайшее движение обрабатывается сразу
    return st.throttle;
  }
  function getThrottle() { return st.throttle; }
  /** Немедленный пик координат (без троттлинга) — для тестов и внешних инструментов. */
  function updateAt(clientX, clientY) {
    if (!st.enabled) return null;
    var v = getViewer();
    if (!v) { setDash(); return null; }
    var x = num(clientX), y = num(clientY);
    if (!inRect(rectOf(v), x, y)) { setDash(); return null; }
    return runPick(x, y);
  }
  function current() {
    return st.current ? {
      ok: !!st.current.ok, point: st.current.point ? st.current.point.slice() : null,
      source: st.current.source, reason: st.current.reason || '', ms: st.current.ms,
      at: st.current.at, x: st.current.x, y: st.current.y, text: textOf(),
      units: st.units, enabled: st.enabled
    } : { ok: false, point: null, source: 'none', text: textOf(), units: st.units, enabled: st.enabled };
  }
  function refresh() {
    st.enabled = readEnabled();
    st.units = readUnits();
    if (!st.mounted) mount(); else render();
    return { enabled: st.enabled, units: st.units };
  }

  // ===================== BOOT =====================
  function boot() {
    try {
      if (!hasDoc()) return;
      // статус-бар статичен — монтируемся сразу; если его ещё нет — ждём DOMContentLoaded
      if (!statusHost()) {
        document.addEventListener('DOMContentLoaded', function () { try { mount(); } catch (e) { } });
        return;
      }
      mount();
    } catch (e) {
      if (typeof console !== 'undefined') console.error('[coords-hud] boot', e);
    }
  }
  if (hasWin()) {
    window.addEventListener('lx-pctools-ready', function () { try { if (!st.mounted) mount(); } catch (e) { } });
    window.addEventListener('lx-viewer-ready', function () { setDash(); });
  }
  if (hasDoc()) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  var API = {
    version: VERSION,
    STORAGE_KEY: STORAGE_KEY,
    UNITS_KEY: UNITS_KEY,
    DEFAULT_THROTTLE_MS: DEFAULT_THROTTLE_MS,
    PICK_RADIUS_PX: PICK_RADIUS_PX,
    mount: mount,
    dispose: dispose,
    refresh: refresh,
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    toggle: toggle,
    setUnits: setUnits,
    getUnits: getUnits,
    setThrottle: setThrottle,
    getThrottle: getThrottle,
    updateAt: updateAt,
    current: current,
    formatPoint: formatPoint,
    formatText: formatText,
    formatCoordValue: formatCoordValue,
    roundCoord: roundCoord,
    pickPointAt: pickPointAt,
    pickByProjection: pickByProjection,
    getViewer: getViewer,
    _state: function () { return { mounted: st.mounted, bound: st.bound, listeners: st.listeners.length, runCount: st.runCount || 0, lastError: st.lastError || '', enabled: st.enabled, units: st.units, throttle: st.throttle, el: !!st.el }; }
  };
  if (hasWin()) window.__lxCoordsHud = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof globalThis !== 'undefined' && typeof window === 'undefined') {
    try { globalThis.__lxCoordsHud = API; } catch (e) { }
  }
})();
