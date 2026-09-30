/* BIM Twin — лента команд.
 * Строит вкладки и панели из реестра ui/commands.js ДО запуска app.js, «усыновляет» существующие
 * элементы (со всеми слушателями), принимает элементы других модулей через __lxRibbon.mount(),
 * следит за состоянием (активно / нет облака / скрыто) и не содержит ни одного текстового поиска кнопок. */
(function () {
  'use strict';
  var W = window, D = document, R = D.documentElement;
  var C = W.__lxCommands;
  var tabsEl = D.getElementById('lxTabs'), ribbonEl = D.getElementById('lxRibbon');
  if (!C || !tabsEl || !ribbonEl) return;
  R.setAttribute('data-lxskin', 'on');

  var KEY_TAB = 'bim.ui.tab', KEY_COLLAPSED = 'bim.ui.ribbonCollapsed';
  var IDLE_TIP = {
    cloud: 'Сначала откройте облако точек: вкладка «Импорт» → «Открыть облако»',
    bim: 'Сначала постройте BIM-модель: вкладка «BIM» → «Скан → BIM»'
  };
  /* Команды-инструменты: клик по активной кнопке или Esc выключают инструмент (см. ui/modes.js). */
  var MODE_TOOLS = { btnMeasure: 1, btnSection: 1, vtEdit: 1, vtWalk: 1, vtTour: 1, lxObjInspectBtn: 1, lxObjExtractBtn: 1, 'draw.sect': 1 };

  var cells = Object.create(null);   // id → { item, cell, btn, group }
  var pending = [];                  // команды, чьи элементы создаёт другой модуль позже
  var tabBtns = {}, panels = {}, current = '';
  var $ = function (id) { return D.getElementById(id); };
  var raf = W.requestAnimationFrame ? W.requestAnimationFrame.bind(W) : function (f) { return setTimeout(f, 16); };

  function kit() { return W.__lxKit; }
  function toast(msg, tone) { var k = kit(); if (k && k.toast) k.toast(msg, { tone: tone }); }
  function store(k, v) { try { if (v === undefined) return W.localStorage.getItem(k); W.localStorage.setItem(k, v); } catch (e) {} return null; }

  function icon(name, size) {
    var s = D.createElement('span');
    s.className = 'lx-ico'; s.setAttribute('data-ico', name); s.setAttribute('data-ico-size', String(size));
    if (W.__lxIcons) { s.innerHTML = W.__lxIcons.svg(name, size); s.setAttribute('data-ico-done', name); }
    return s;
  }
  function el(tag, cls, attrs) {
    var e = D.createElement(tag); if (cls) e.className = cls;
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  /* ---------- Вызов команды по пути «__lxScene.addFloor» ---------- */
  function resolvePath(path) {
    var parts = String(path).split('.'), ctx = W, fn = W;
    for (var i = 0; i < parts.length; i++) { ctx = fn; fn = fn == null ? undefined : fn[parts[i]]; }
    return typeof fn === 'function' ? { fn: fn, ctx: ctx } : null;
  }
  function cloneArgs(a) { try { return JSON.parse(JSON.stringify(a || [])); } catch (e) { return []; } }
  function fail(item, e) {
    try { console.warn('[ribbon] ' + item.id, e); } catch (x) {}
    toast('Не удалось выполнить «' + (item.label || item.id) + '»' + (e && e.message ? ': ' + e.message : ''), 'err');
  }
  function runCall(item, btn) {
    var r = resolvePath(item.call);
    if (!r) { toast('Команда «' + (item.label || item.id) + '» недоступна: модуль ещё не загружен', 'warn'); return; }
    var res;
    try { res = r.fn.apply(r.ctx, cloneArgs(item.args)); } catch (e) { fail(item, e); return; }
    if (res && typeof res.then === 'function') {
      var k = kit(); if (k) k.busy(btn, true);
      res.then(null, function (e) { fail(item, e); }).then(function () { if (k) k.busy(btn, false); });
    }
  }

  /* ---------- Кнопка команды ---------- */
  function textOf(node) {
    var l = node.querySelector && node.querySelector(':scope > .lbl');
    return String((l || node).textContent || '').replace(/\s+/g, ' ').trim();
  }
  function skin(item, b) {
    var size = item.size || 'lg';
    var text = item.label == null ? (b.__lxLabel || textOf(b)) : item.label;
    b.__lxLabel = text;
    var hadI18n = b.getAttribute('data-i18n');
    var hadI18nTitle = b.getAttribute('data-i18n-title');
    var hidden = b.hasAttribute('data-hidden');
    var badge = null;
    if (item.badge) { badge = $(item.badge.slice(1)) || el('span', 'lx-count', { id: item.badge.slice(1) }); }
    b.className = 'lx-rb lx-' + size + (item.primary ? ' lx-primary' : '');
    b.removeAttribute('style');
    if (hidden) b.style.display = 'none';
    b.textContent = '';
    b.appendChild(icon(item.ico, size === 'lg' ? 24 : 16));
    var l = el('span', 'lbl'); l.textContent = text; b.appendChild(l);
    if (item.special === 'autosave') b.appendChild(el('span', 'lx-sub'));
    if (item.menu) {   // кнопка открывает меню: стрелка + aria-haspopup (меню, а не действие)
      var cv = icon('chevron-down', 10); cv.classList.add('lx-caret'); cv.setAttribute('aria-hidden', 'true'); b.appendChild(cv);
      b.setAttribute('aria-haspopup', 'menu');
    }
    if (badge) { badge.className = 'lx-count'; b.appendChild(badge); }
    if (hadI18n && item.label != null) b.removeAttribute('data-i18n');
    b.setAttribute('data-cmd', item.id);
    if (item.needs) b.setAttribute('data-needs', item.needs);
    if (item.toggle && !b.hasAttribute('aria-pressed')) b.setAttribute('aria-pressed', 'false');
    if (MODE_TOOLS[item.id]) b.setAttribute('data-mode-tool', '1');
    var tip = item.tip || '';
    if (hadI18nTitle) { tip = ''; }  // перевод подсказки из словаря важнее
    else if (!tip) tip = b.getAttribute('title') || b.getAttribute('data-tip') || '';
    if (tip) { b.setAttribute('data-tip', tip); b.removeAttribute('title'); }
    else if (!hadI18nTitle) b.removeAttribute('title');
    if (item.keys) b.setAttribute('data-keys', item.keys);
    if (item.needs) b.setAttribute('data-idle-tip', IDLE_TIP[item.needs] || '');
    if (b.tagName === 'LABEL') {
      b.setAttribute('role', 'button'); b.tabIndex = 0;
      if (!b.__lxKey) { b.__lxKey = 1; b.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.click(); } }); }
    }
    return b;
  }
  function callButton(item) {
    var b = el('button', '', { type: 'button' });
    skin(item, b);
    if (item.special === 'autosave') b.addEventListener('click', cycleAutosave);
    else if (item.call) b.addEventListener('click', function () { runCall(item, b); });
    return b;
  }

  /* ---------- Селектор (проекция, СК) ---------- */
  function selectBox(item, select) {
    var wrap = el('label', 'lx-selbox');
    var cap = el('span'); cap.textContent = item.label;
    select.removeAttribute('style'); select.className = '';
    wrap.appendChild(cap); wrap.appendChild(select);
    return wrap;
  }

  /* ---------- Размещение элемента в ячейке ---------- */
  function place(rec, node) {
    rec.cell.textContent = '';
    rec.cell.appendChild(node);
    rec.cell.hidden = false;
    rec.btn = node;
    schedule();
  }
  function adopt(item, node) {
    var rec = cells[item.id]; if (!rec || !node) return false;
    if (item.kind === 'select') place(rec, selectBox(item, node));
    else place(rec, skin(item, node));
    return true;
  }
  /** Публичный вход для модулей, создающих элемент самостоятельно (чертёж и т. п.). */
  function mount(id, node) {
    var rec = cells[id]; if (!rec) return false;
    return adopt(rec.item, node);
  }
  function findLegacy(sel) {
    var root = $('lxLegacy'), n = root ? root.querySelector(sel) : null;
    return n || D.querySelector(sel);
  }
  function adoptPending() {
    if (!pending.length) return;
    var left = [];
    pending.forEach(function (item) {
      var node = findLegacy(item.sel);
      if (node) adopt(item, node); else left.push(item);
    });
    pending = left;
  }

  /* ---------- Построение вкладок и панелей ---------- */
  function makeCell(item, group) {
    var cell = el('div', 'lx-cell', { 'data-cell': item.id });
    var rec = cells[item.id] = { item: item, cell: cell, btn: null, group: group };
    if (item.slot || item.kind === 'select') { cell.hidden = true; return cell; }
    if (item.sel) {
      var n = findLegacy(item.sel);
      if (n) { rec.btn = skin(item, n); cell.appendChild(n); }
      else { cell.hidden = true; pending.push(item); }
      return cell;
    }
    rec.btn = callButton(item); cell.appendChild(rec.btn);
    return cell;
  }
  function buildGroup(g, tabId) {
    var items = g.items || [];
    if (g.dynamic) {
      var S = W.__lxSmartSave, list = (S && S.formats) || [];
      items = list.filter(function (f) { return f.kind === g.dynamic; }).map(C.formatItem);
      g.items = items;
      items.forEach(function (i) { i.tab = tabId; i.group = g.id; C.byId[i.id] = i; });
    }
    var box = el('div', 'lx-group', { 'data-group': g.id, role: 'group', 'aria-label': g.label });
    var body = el('div', 'lx-gbody');
    var stack = null;
    items.forEach(function (item) {
      var cell = makeCell(item, box);
      if ((item.size || 'lg') === 'sm' && item.kind !== 'select') {
        if (!stack) { stack = el('div', 'lx-stack'); body.appendChild(stack); }
        stack.appendChild(cell);
      } else { stack = null; body.appendChild(cell); }
    });
    var lab = el('div', 'lx-glabel'); lab.textContent = g.label;
    box.appendChild(body); box.appendChild(lab);
    return box;
  }
  function build() {
    tabsEl.textContent = ''; ribbonEl.textContent = '';
    tabsEl.setAttribute('role', 'tablist');
    C.TABS.forEach(function (t) {
      var b = el('button', 'lx-tab', { type: 'button', role: 'tab', id: 'lxTab-' + t.id, 'data-tab': t.id, 'aria-controls': 'lxPanel-' + t.id, 'aria-selected': 'false', tabindex: '-1' });
      b.textContent = t.label;
      b.addEventListener('click', function () {
        if (R.classList.contains('lx-ribbon-collapsed')) collapse(false);
        select(t.id, { user: true });
      });
      b.addEventListener('dblclick', function () { collapse(!R.classList.contains('lx-ribbon-collapsed')); });
      tabsEl.appendChild(b); tabBtns[t.id] = b;
      var p = el('div', 'lx-panel', { id: 'lxPanel-' + t.id, role: 'tabpanel', 'aria-labelledby': 'lxTab-' + t.id, 'data-panel': t.id });
      t.groups.forEach(function (g) { p.appendChild(buildGroup(g, t.id)); });
      ribbonEl.appendChild(p); panels[t.id] = p;
    });
    ['prev', 'next'].forEach(function (dir) {
      var nb = el('button', 'icon-btn lx-rib-nav ' + dir, { type: 'button', tabindex: '-1', 'aria-label': dir === 'prev' ? 'Прокрутить ленту влево' : 'Прокрутить ленту вправо' });
      nb.appendChild(icon(dir === 'prev' ? 'chevron-left' : 'chevron-right', 16));
      nb.addEventListener('click', function () { scrollPanel(dir === 'prev' ? -1 : 1); });
      ribbonEl.appendChild(nb);
    });
    tabsEl.appendChild(el('span', 'lx-tab-fill'));
    var tg = el('button', 'icon-btn lx-ribbon-toggle', { type: 'button', id: 'lxRibbonToggle', 'aria-label': 'Свернуть ленту', 'data-tip': 'Свернуть или развернуть ленту', 'aria-expanded': 'true' });
    tg.appendChild(icon('chevron-up', 16));
    tg.addEventListener('click', function () { collapse(!R.classList.contains('lx-ribbon-collapsed')); });
    tabsEl.appendChild(tg);
    tabsEl.addEventListener('keydown', onTabKey);
  }

  /* Прокрутка широких вкладок: стрелки по краям, затухание края, колесо мыши = горизонтальная прокрутка. */
  function scrollPanel(sign) {
    var p = panels[current]; if (!p) return;
    var reduce = W.matchMedia && W.matchMedia('(prefers-reduced-motion: reduce)').matches;
    p.scrollBy({ left: sign * Math.max(200, Math.round(p.clientWidth * 0.6)), behavior: reduce ? 'auto' : 'smooth' });
  }
  function navUpdate() {
    var p = panels[current]; if (!p) return;
    var max = p.scrollWidth - p.clientWidth - 1;
    ribbonEl.classList.toggle('can-prev', p.scrollLeft > 1);
    ribbonEl.classList.toggle('can-next', p.scrollLeft < max);
  }
  function collapse(on) {
    R.classList.toggle('lx-ribbon-collapsed', !!on);
    var tg = $('lxRibbonToggle');
    if (tg) { tg.setAttribute('aria-expanded', String(!on)); tg.setAttribute('aria-label', on ? 'Развернуть ленту' : 'Свернуть ленту'); }
    store(KEY_COLLAPSED, on ? '1' : '0');
    setTimeout(function () { try { W.dispatchEvent(new Event('resize')); } catch (e) {} }, 320);
  }
  function select(id, opts) {
    if (!panels[id]) id = C.TABS[0].id;
    opts = opts || {};
    if (opts.user && id !== current) {
      try { if (W.__lxWorkspace) { W.__lxWorkspace.exitTools(); W.__lxWorkspace.menusClose(); } } catch (e) {}
      if (kit()) kit().closePopover();
    }
    current = id;
    Object.keys(tabBtns).forEach(function (k) {
      var on = k === id;
      tabBtns[k].setAttribute('aria-selected', String(on)); tabBtns[k].tabIndex = on ? 0 : -1; tabBtns[k].classList.toggle('active', on);
      panels[k].classList.toggle('active', on);
    });
    R.setAttribute('data-ribbon-tab', id);
    store(KEY_TAB, id);
    raf(navUpdate);
    if (opts.user && W.__lxChrome && W.__lxChrome.onTab) W.__lxChrome.onTab(id);
    schedule();
    try { var t = tabBtns[id]; if (t && t.scrollIntoView && opts.user) t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
  }
  function onTabKey(e) {
    var ids = C.TABS.map(function (t) { return t.id; }), i = ids.indexOf(current), n = i;
    if (e.key === 'ArrowRight') n = (i + 1) % ids.length; else if (e.key === 'ArrowLeft') n = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = ids.length - 1; else return;
    e.preventDefault(); select(ids[n], { user: true }); tabBtns[ids[n]].focus();
  }

  /* ---------- Состояния ---------- */
  function hasCloud() {
    var known = false, yes = false, v = W.__viewer;
    try { if (W.MultiCloud && W.MultiCloud.totalPoints) { known = true; if (W.MultiCloud.totalPoints() > 0) yes = true; } } catch (e) {}
    try {
      if (v) {
        known = true;
        if (v.pointCount > 0) yes = true;
        if (v.base && v.base.some && v.base.some(function (o) { return o && o.points; })) yes = true;
      }
    } catch (e) {}
    try { var t = W.__pcTools; if (t && t.isOctreeStreamActive && t.isOctreeStreamActive()) yes = true; } catch (e) {}
    return known ? yes : true;
  }
  function hasBim() {
    try { return !!(W.__lxScan2BIM && W.__lxScan2BIM.state && W.__lxScan2BIM.state.model); } catch (e) { return false; }
  }
  function shown(node) { return !!node && D.body.contains(node) && W.getComputedStyle(node).display !== 'none'; }
  var STATE = {
    btnMeasure: function (v) { return !!v.measuring; },
    mmSnap: function (v) { return !!v.measureSnap; },
    btnSection: function (v) { return !!(v.section && v.section.on); },
    btnLOD: function (v) { return !!v.lod; },
    vtEdit: function (v) { return !!v.editSelect; },
    vtTour: function (v) { return !!v.tour; },
    mmList: function () { return shown($('measureListPanel')); },
    vtQuality: function () { return shown($('qualityBar')); },
    'view.ortho': function (v) { return !!(v.isOrtho && v.isOrtho()); },
    'view.xray': function () { try { return !!(W.XrayView && W.XrayView.isXray && W.XrayView.isXray()); } catch (e) { return false; } }
  };
  ['distance', 'point', 'polyline', 'angle', 'area', 'plane', 'deviation', 'corner'].forEach(function (m) {
    var id = 'mm' + m.charAt(0).toUpperCase() + m.slice(1);
    STATE[id] = function (v) { return !!v.measuring && (v.measureMode || 'distance') === m; };
  });
  function setPressed(b, on) {
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  }
  function paintAutosave() {
    var rec = cells.autosave; if (!rec || !rec.btn) return;
    var S = W.__lxSmartSave, m = 0;
    try { m = S && S.status ? (S.status().intervalMin || 0) : 0; } catch (e) {}
    var sub = rec.btn.querySelector('.lx-sub'); if (sub) sub.textContent = m > 0 ? m + ' мин' : 'выкл';
    setPressed(rec.btn, m > 0);
  }
  function cycleAutosave() {
    var S = W.__lxSmartSave; if (!S || !S.setInterval) { toast('Автосохранение недоступно', 'warn'); return; }
    var cur = 0; try { cur = S.status().intervalMin || 0; } catch (e) {}
    var seq = [0, 1, 2, 5, 10], next = seq[(seq.indexOf(cur) + 1) % seq.length];
    S.setInterval(next); paintAutosave();
    toast(next > 0 ? 'Автосохранение: каждые ' + next + ' мин' : 'Автосохранение выключено', next > 0 ? 'ok' : 'info');
  }
  var syncing = false;
  function sync() {
    if (syncing) return; syncing = true;
    try {
      var v = W.__viewer, cloud = hasCloud(), bim = hasBim();
      Object.keys(cells).forEach(function (id) {
        var rec = cells[id], b = rec.btn, item = rec.item;
        if (!b) return;
        if (item.needs) {
          var ok = item.needs === 'bim' ? bim : cloud;
          b.classList.toggle('is-idle', !ok);
          if (ok) b.removeAttribute('aria-disabled'); else b.setAttribute('aria-disabled', 'true');
        }
        if (v && STATE[id]) { try { setPressed(b, !!STATE[id](v)); } catch (e) {} }
        var hide = !shown(b);
        if (rec.cell.hidden !== hide) rec.cell.hidden = hide;
      });
      Object.keys(panels).forEach(function (pid) {
        var groups = panels[pid].querySelectorAll('.lx-group');
        for (var i = 0; i < groups.length; i++) {
          var g = groups[i], any = !!g.querySelector('.lx-cell:not([hidden])');
          if (g.hidden === any) g.hidden = !any;
        }
      });
      paintAutosave();
      navUpdate();
    } finally { syncing = false; }
  }
  var queued = false;
  function schedule() { if (queued) return; queued = true; raf(function () { queued = false; adoptPending(); sync(); }); }

  /* Динамические группы экспорта: форматы могут появиться позже скрипта. */
  function refreshDynamic() {
    C.TABS.forEach(function (t) {
      t.groups.forEach(function (g) {
        if (!g.dynamic || (g.items && g.items.length)) return;
        var S = W.__lxSmartSave; if (!S || !S.formats || !S.formats.length) return;
        var old = panels[t.id].querySelector('[data-group="' + g.id + '"]');
        var fresh = buildGroup(g, t.id);
        if (old) old.replaceWith(fresh);
      });
    });
  }

  /* ---------- События ---------- */
  function wire() {
    // Команды с needs без данных: мягкая блокировка с понятным пояснением
    ribbonEl.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-needs]');
      if (!b || b.getAttribute('aria-disabled') !== 'true') return;
      e.preventDefault(); e.stopImmediatePropagation();
      toast(b.getAttribute('data-idle-tip') || 'Команда пока недоступна', 'warn');
    }, true);
    // Режим измерения включается сам при выборе конкретного замера
    D.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-mm]'); if (!b) return;
      var v = W.__viewer;
      if (v && !v.measuring && W.__bimSetMeasuring) W.__bimSetMeasuring(true);
    }, true);
    ribbonEl.addEventListener('click', function () { setTimeout(schedule, 0); setTimeout(schedule, 220); });
    ['lx-cloud-loaded', 'mc-changed', 'bim-cloud-change', 'lx-viewer-ready', 'lx-pctools-ready', 'lx-tools-cancelled', 'lx-scene-built', 'bim-app-ready', 'bim-language-change', 'lx-save-state']
      .forEach(function (n) { W.addEventListener(n, function () { schedule(); if (n === 'bim-app-ready' || n === 'lx-pctools-ready') { refreshDynamic(); adoptPending(); } }); });
    if (W.MutationObserver) {
      new MutationObserver(schedule).observe(ribbonEl, { attributes: true, subtree: true, attributeFilter: ['style', 'hidden', 'class', 'disabled'] });
      new MutationObserver(function () { if (pending.length && pending.some(function (i) { return !!findLegacy(i.sel); })) schedule(); }).observe(D.body, { childList: true, subtree: true });
    }
    Object.keys(panels).forEach(function (k) { panels[k].addEventListener('scroll', navUpdate, { passive: true }); });
    ribbonEl.addEventListener('wheel', function (e) {
      var p = panels[current]; if (!p || p.scrollWidth <= p.clientWidth + 1 || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault(); p.scrollLeft += e.deltaY;
    }, { passive: false });
    W.addEventListener('resize', navUpdate);
    if (W.ResizeObserver) new W.ResizeObserver(navUpdate).observe(ribbonEl);
    setInterval(function () { if (!D.hidden) sync(); }, 700);
    D.addEventListener('DOMContentLoaded', function () { refreshDynamic(); schedule(); });
  }

  build();
  wire();
  select(store(KEY_TAB) || 'import');
  if (store(KEY_COLLAPSED) === '1') collapse(true);
  schedule();

  W.__lxRibbon = {
    build: build, mount: mount, adopt: function (id, node) { var r = cells[id]; return r ? adopt(r.item, node) : false; },
    select: select, collapse: collapse, sync: schedule, hasCloud: hasCloud, hasBim: hasBim,
    cells: cells, tabs: function () { return C.TABS.map(function (t) { return t.id; }); },
    get current() { return current; },
    button: function (id) { var r = cells[id]; return r ? r.btn : null; }
  };
  /* Совместимость со старыми вызовами */
  W.__lxToolbar = W.__lxToolbar || { build: function () {} };
  W.__lxShell = W.__lxShell || { applyAll: function () {} };
})();
