/* BIM Twin — жизненный цикл инструментов и прогресс тяжёлых операций.
 *  • __lxProgress.begin(label) — модальная карточка прогресса (появляется, только если операция длится дольше ~200 мс);
 *  • мост к ToolManager: одновременно активен один инструмент; повторный клик по активной кнопке и Esc выключают его;
 *  • подключение прогресса к __pcTools и PlyToSplat.
 * Кнопки-инструменты помечает лента (атрибут data-mode-tool), поиска по тексту кнопок здесь нет. */
(function () {
  'use strict';
  var W = window, D = document, R = D.documentElement;
  var $ = function (id) { return D.getElementById(id); };
  var SHOW_DELAY = 200;

  function fmt(s) { s = Math.max(0, Math.round(s || 0)); var m = Math.floor(s / 60), r = s % 60; return m + ':' + (r < 10 ? '0' : '') + r; }
  function el(tag, cls) { var e = D.createElement(tag); if (cls) e.className = cls; return e; }

  /* ---------- Прогресс ---------- */
  var seq = 0, active = null, cancelAllRef = function () {};
  function progressDom() {
    var m = $('lxProgressModal'); if (m) return m;
    m = el('div', 'lx-progress'); m.id = 'lxProgressModal';
    m.setAttribute('role', 'alertdialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-live', 'polite'); m.setAttribute('aria-labelledby', 'lxProgressTitle');
    m.innerHTML = '<div class="lx-progress-card">' +
      '<div class="lx-progress-head"><span class="lx-spin" aria-hidden="true"></span><div class="lx-progress-title" id="lxProgressTitle">Обработка</div></div>' +
      '<div class="lx-progress-msg">Подготовка…</div>' +
      '<div class="lx-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="lx-progress-fill"></div></div>' +
      '<div class="lx-progress-meta"><b class="lx-progress-pct">0%</b><span class="lx-progress-time">Прошло 0:00 · осталось —</span></div>' +
      '<div class="lx-progress-actions"><button type="button" class="btn sm lx-progress-cancel"><span class="lbl">Отмена</span></button><kbd>Esc</kbd></div></div>';
    D.body.appendChild(m); return m;
  }
  function begin(label, opts) {
    opts = opts || {};
    var m = progressDom(), token = ++seq, start = performance.now();
    var frac = 0, done = false, timer = 0, reveal = 0;
    var q = function (s) { return m.querySelector(s); };
    var title = q('.lx-progress-title'), msg = q('.lx-progress-msg'), fill = q('.lx-progress-fill'), track = q('.lx-progress-track'),
      pct = q('.lx-progress-pct'), time = q('.lx-progress-time'), cancel = q('.lx-progress-cancel'), cancelLbl = cancel.querySelector('.lbl');
    cancel.disabled = false; if (cancelLbl) cancelLbl.textContent = 'Отмена';
    title.textContent = String(label || 'Обработка').replace(/…+$/, '');
    msg.textContent = label || 'Подготовка…';
    m.classList.remove('open', 'leaving'); m.classList.toggle('indeterminate', true);
    R.classList.add('lx-operation-busy');
    var paint = function () {
      var elapsed = (performance.now() - start) / 1000, eta = frac > 0.025 && frac < 1 ? elapsed * (1 - frac) / frac : null;
      var p = Math.round(frac * 100);
      fill.style.width = p + '%'; pct.textContent = p + '%'; track.setAttribute('aria-valuenow', String(p));
      m.classList.toggle('indeterminate', frac <= 0.005);
      time.textContent = 'Прошло ' + fmt(elapsed) + ' · осталось ' + (eta == null ? '—' : fmt(eta));
    };
    var close = function () {
      if (done) return; done = true; clearInterval(timer); clearTimeout(reveal);
      if (active && active.token === token) active = null;
      R.classList.remove('lx-operation-busy');
      if (m.classList.contains('open')) { m.classList.add('leaving'); setTimeout(function () { if (!active) m.classList.remove('open', 'leaving'); }, 180); }
    };
    var stop = function () { frac = 1; paint(); setTimeout(close, 140); };
    stop.token = token;
    stop.set = function (f, text) { if (done) return; frac = Math.max(0, Math.min(1, Number(f) || 0)); if (text) msg.textContent = text; paint(); };
    stop.text = function (text) { if (text) msg.textContent = text; };
    stop.cancel = function () {
      // Операция сама управляет отменой (например, импорт файла): просим остановиться и ждём её завершения
      if (opts.onCancel) { if (cancel.disabled) return; cancel.disabled = true; if (cancelLbl) cancelLbl.textContent = 'Отмена…'; try { opts.onCancel(); } catch (e) {} return; }
      W.dispatchEvent(new CustomEvent('lx-progress-cancel', { detail: { token: token, label: label } })); cancelAllRef(); close();
    };
    cancel.onclick = stop.cancel;
    active = { token: token, stop: stop };
    reveal = setTimeout(function () { if (!done) { m.classList.add('open'); try { cancel.focus({ preventScroll: true }); } catch (e) {} } }, SHOW_DELAY);
    timer = setInterval(paint, 500); paint();
    return stop;
  }
  W.__lxProgress = { begin: begin, get active() { return active; } };

  /* ---------- Мост к ToolManager ---------- */
  var toolManager = W.__lxToolManager || null, managed = {}, managerCancelling = false, epoch = 0;
  function viewer() { return W.__viewer || W.__lxViewer || null; }
  function modeButton(target) { var b = target.closest && target.closest('[data-mode-tool]'); return b || null; }
  function pressed(b) { return b.classList.contains('lx-mode-active') || b.classList.contains('on') || b.getAttribute('aria-pressed') === 'true'; }
  function engineActive() {
    var v = viewer();
    return !!(v && (v.measuring || v.editSelect || v.walk || v.tour || v.lod || (v.section && v.section.on))) || !!(W.__lxDraw && W.__lxDraw.active);
  }
  function clearMarks() {
    D.querySelectorAll('[data-mode-tool]').forEach(function (x) { x.classList.remove('lx-mode-active', 'on'); x.setAttribute('aria-pressed', 'false'); });
  }
  function legacyCancelAll() {
    epoch++;
    try { if (W.__lxWorkspace) W.__lxWorkspace.exitTools(); } catch (e) {}
    var v = viewer();
    try {
      if (v) {
        if (v.setMeasuring) v.setMeasuring(false); if (v.setMeasure) v.setMeasure(false); if (v.setEditSelect) v.setEditSelect(false);
        if (v.setWalk) v.setWalk(false); if (v.setTour) v.setTour(false); if (v.setSection) v.setSection(false);
        if (v.lod && v.setLOD) v.setLOD(false); if (v.clearSelection) v.clearSelection();
      }
    } catch (e) {}
    try { if (W.__lxObjectExtract && W.__lxObjectExtract.close) W.__lxObjectExtract.close(); } catch (e) {}
    try { if (W.__lxObjectInspector && W.__lxObjectInspector.close) W.__lxObjectInspector.close(); } catch (e) {}
    try { if (W.__lxDraw && W.__lxDraw.active && W.__lxDrawUI && W.__lxDrawUI.deactivate) W.__lxDrawUI.deactivate(true); } catch (e) {}
    clearMarks();
    ['measureBar', 'measureListPanel', 'measureReadout', 'editBar', 'tourBar', 'sectionPanel', 'sectionRange', 'qualityBar', 'lxSectionControls'].forEach(function (id) { var e = $(id); if (e) e.style.display = 'none'; });
    W.dispatchEvent(new CustomEvent('lx-tools-cancelled'));
  }
  function managedId(b) { return 'tool:' + (b.getAttribute('data-cmd') || b.id || 'unknown'); }
  function ensureManaged(id) {
    if (!toolManager || managed[id]) return;
    toolManager.register(id, { activate: function () {}, deactivate: function () { if (managerCancelling) return; managerCancelling = true; try { legacyCancelAll(); } finally { managerCancelling = false; } } });
    managed[id] = 1;
  }
  function cancelAll(reason) {
    if (toolManager && toolManager.activeId && !managerCancelling) { toolManager.cancel(reason || 'cancel'); return; }
    legacyCancelAll();
  }
  cancelAllRef = cancelAll;
  function installModeExit() {
    W.addEventListener('click', function (e) {
      var b = modeButton(e.target); if (!b) return;
      var id = managedId(b); ensureManaged(id);
      if ((toolManager && toolManager.activeId === id) || pressed(b)) { e.preventDefault(); e.stopImmediatePropagation(); cancelAll('toggle'); return; }
      if (toolManager && toolManager.activeId) toolManager.cancel('switch'); else if (engineActive()) legacyCancelAll();
      var token = epoch;
      setTimeout(function () {
        if (token === epoch && (pressed(b) || engineActive())) {
          if (toolManager) { ensureManaged(id); toolManager.activate(id, { buttonId: b.id || null }); }
          b.classList.add('lx-mode-active'); b.setAttribute('aria-pressed', 'true');
        }
      }, 0);
    }, true);
    W.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var tag = e.target && e.target.tagName;
      if (/INPUT|TEXTAREA|SELECT/.test(tag || '') && !active) return;
      if (D.getElementById('lxPalette') || (W.__lxKit && W.__lxKit.popoverOpen)) return;
      if (active) { e.preventDefault(); active.stop.cancel(); return; }
      /* Esc снимает по одному слою: окно → меню → панель → выделение → инструмент. */
      var WS = W.__lxWorkspace;
      if (WS && WS.escape && WS.escape()) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (engineActive() || (toolManager && toolManager.activeId)) { e.preventDefault(); cancelAll('escape'); }
    }, true);
    W.addEventListener('beforeunload', function () { if (toolManager && toolManager.dispose) toolManager.dispose(); }, { once: true });
  }
  installModeExit();

  /* ---------- Прогресс тяжёлых операций ---------- */
  function bridgeProgress() {
    var t = W.__pcTools; if (!t || (t.beginProgress && t.beginProgress.__lxBridge)) return !!t;
    var f = function (label) { return begin(label); }; f.__lxBridge = true;
    t.beginProgress = f; return true;
  }
  function patchPly() {
    var p = W.PlyToSplat; if (!p || p.__lxBridge || typeof p.convert !== 'function') return;
    p.__lxBridge = true;
    var original = p.convert.bind(p);
    p.convert = async function (buf, opts) {
      opts = opts || {};
      var stop = begin('PLY → 3DGS'), cb = opts.progress;
      try {
        return await original(buf, Object.assign({}, opts, { progress: function (n, m) { stop.set((Number(n) || 0) / 100, m); if (cb) cb(n, m); } }));
      } finally { stop(); }
    };
  }
  function removeXgrids() { D.querySelectorAll('#tsSplatXgrids,#vtXgrids,[data-tool="xgrids"],.xgrids-button').forEach(function (x) { x.remove(); }); }
  function init() {
    bridgeProgress(); patchPly(); removeXgrids();
    var n = 0, t = setInterval(function () { bridgeProgress(); patchPly(); removeXgrids(); if (++n > 40) clearInterval(t); }, 300);
    W.addEventListener('lx-pctools-ready', function () { bridgeProgress(); });
    W.addEventListener('lx-cloud-loaded', function () { setTimeout(function () { var v = W.__viewer; if (v && v._resize) v._resize(); }, 80); });
  }
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', init); else init();
  W.__lxModes = { cancelAll: cancelAll, engineActive: engineActive, begin: begin };
})();
