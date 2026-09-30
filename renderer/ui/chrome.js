/* BIM Twin — оболочка окна: загрузка, тема, боковые панели, статус-бар, палитра команд.
 * Выполняется после всех модулей; сама логика инструментов сюда не входит (ui/modes.js). */
(function () {
  'use strict';
  var W = window, D = document, R = D.documentElement;
  var C = W.__lxCommands;
  var $ = function (id) { return D.getElementById(id); };
  var raf = W.requestAnimationFrame ? W.requestAnimationFrame.bind(W) : function (f) { return setTimeout(f, 16); };
  var K = function () { return W.__lxKit; };
  var KEY = { side: 'bim.ui.side', insp: 'bim.ui.insp', pane: 'bim.ui.pane' };
  var DRAWER_MAX = 1100;
  var t0 = Date.now();

  function store(k, v) { try { if (v === undefined) return W.localStorage.getItem(k); W.localStorage.setItem(k, v); } catch (e) {} return null; }
  function viewer() { return W.__viewer || W.__lxViewer || null; }
  function toast(m, tone) { var k = K(); if (k) k.toast(m, { tone: tone }); }
  function ic(name, size) { return W.__lxIcons ? W.__lxIcons.svg(name, size || 16) : ''; }
  function setIcon(btn, name, size) { if (!btn) return; btn.innerHTML = ic(name, size || 17); btn.setAttribute('data-ico', name); btn.setAttribute('data-ico-done', name); }
  function drawer() { return W.innerWidth <= DRAWER_MAX; }

  /* ---------- Скрытые по умолчанию блоки (их показывает прежний код через style.display) ---------- */
  ['measureReadout', 'measureBar', 'measureListPanel', 'editBar', 'tourBar', 'qualityBar', 'elProps', 'sectionRange'].forEach(function (id) {
    var e = $(id); if (e) e.style.display = 'none';
  });

  /* ---------- Экран загрузки ---------- */
  var readyDone = false;
  function ready() {
    if (readyDone) return; readyDone = true;
    var wait = Math.max(0, 420 - (Date.now() - t0));
    setTimeout(function () {
      R.classList.add('lx-ready', 'ui-ready'); D.body.classList.remove('lx-booting');
      var b = $('workspaceBoot'); if (b) setTimeout(function () { b.hidden = true; }, 480);
    }, wait);
  }
  function bootText(t) { var s = $('workspaceBootSub'); if (s) s.textContent = t; }
  bootText('Загрузка интерфейса…');
  W.addEventListener('bim-app-ready', function () { bootText('Открываем рабочую область…'); ready(); });
  W.addEventListener('load', function () { setTimeout(ready, 5000); });
  setTimeout(ready, 9000);

  /* ---------- Тема ---------- */
  function paintTheme() {
    var b = $('tbTheme'); if (!b) return;
    var light = R.getAttribute('data-theme') === 'light';
    setIcon(b, light ? 'moon' : 'sun');
    b.setAttribute('data-tip', light ? 'Включить тёмную тему' : 'Включить светлую тему');
    b.removeAttribute('title');
  }
  function initTheme() {
    var b = $('tbTheme'); if (!b) return;
    b.addEventListener('click', function () {
      var next = R.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      if (W.__bimSetTheme) W.__bimSetTheme(next); else R.setAttribute('data-theme', next);
      paintTheme();
    });
    if (W.MutationObserver) new MutationObserver(paintTheme).observe(R, { attributes: true, attributeFilter: ['data-theme'] });
    paintTheme();
  }

  /* ---------- Боковые панели ---------- */
  function paintPanels() {
    var s = $('tbSide'), i = $('tbInspector');
    if (s) s.setAttribute('aria-pressed', String(!R.classList.contains('lx-side-closed')));
    if (i) i.setAttribute('aria-pressed', String(!R.classList.contains('lx-insp-closed')));
  }
  function setSide(open, persist) {
    R.classList.toggle('lx-side-closed', !open);
    if (open && drawer()) R.classList.add('lx-insp-closed');
    if (persist !== false && !drawer()) store(KEY.side, open ? '1' : '0');
    paintPanels();
  }
  function setInsp(open, persist) {
    R.classList.toggle('lx-insp-closed', !open);
    if (open && drawer()) R.classList.add('lx-side-closed');
    if (persist !== false && !drawer()) store(KEY.insp, open ? '1' : '0');
    paintPanels();
  }
  function initPanels() {
    var s = $('tbSide'), i = $('tbInspector');
    if (drawer()) { R.classList.add('lx-side-closed', 'lx-insp-closed'); }
    else {
      if (store(KEY.side) === '0') R.classList.add('lx-side-closed');
      if (store(KEY.insp) === '0') R.classList.add('lx-insp-closed');
    }
    if (s) s.addEventListener('click', function () { setSide(R.classList.contains('lx-side-closed')); });
    if (i) i.addEventListener('click', function () { setInsp(R.classList.contains('lx-insp-closed')); });
    var wasDrawer = drawer();
    W.addEventListener('resize', function () {
      var d = drawer();
      if (d === wasDrawer) return;
      wasDrawer = d;
      if (d) R.classList.add('lx-side-closed', 'lx-insp-closed');
      else { R.classList.toggle('lx-side-closed', store(KEY.side) === '0'); R.classList.toggle('lx-insp-closed', store(KEY.insp) === '0'); }
      paintPanels();
    });
    D.addEventListener('pointerdown', function (e) {
      if (!drawer()) return;
      if (e.target.closest && e.target.closest('.sidebar, .inspector, .titlebar, .lx-pop, .modal, .lx-palette')) return;
      if (!R.classList.contains('lx-side-closed') || !R.classList.contains('lx-insp-closed')) { R.classList.add('lx-side-closed', 'lx-insp-closed'); paintPanels(); }
    }, true);
    paintPanels();
  }

  /* ---------- Правая панель: «Сцена» | «Документы» ---------- */
  function showPane(name, opts) {
    var scene = $('inspScene'), docs = $('inspDocs');
    if (!scene || !docs) return;
    var isScene = name !== 'docs';
    scene.hidden = !isScene; docs.hidden = isScene;
    [['segScene', isScene], ['segDocs', !isScene]].forEach(function (p) {
      var b = $(p[0]); if (!b) return; b.classList.toggle('active', p[1]); b.setAttribute('aria-selected', String(p[1])); b.tabIndex = p[1] ? 0 : -1;
    });
    if (!opts || opts.persist !== false) store(KEY.pane, isScene ? 'scene' : 'docs');
    if (opts && opts.reveal && R.classList.contains('lx-insp-closed')) setInsp(true, false);
  }
  function initPane() {
    var a = $('segScene'), b = $('segDocs');
    if (a) a.addEventListener('click', function () { showPane('scene'); });
    if (b) b.addEventListener('click', function () { showPane('docs'); });
    var seg = D.querySelector('.insp-seg');
    if (seg) seg.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault(); var to = (a && a.classList.contains('active')) ? 'docs' : 'scene'; showPane(to); ($(to === 'docs' ? 'segDocs' : 'segScene') || a).focus();
    });
    showPane(store(KEY.pane) === 'docs' ? 'docs' : 'scene', { persist: false });
    // выбор помещения в дереве проекта открывает его документы
    var tree = $('tree');
    if (tree) tree.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.room') && !e.target.closest('.row-actions')) showPane('docs', { reveal: true, persist: false });
    });
  }

  /* ---------- Закрытие плавающих панелей: [data-close="id"] ---------- */
  var OWNER = { qualityBar: 'vtQuality', measureListPanel: 'mmList', sectionPanel: 'btnSection' };
  function initClose() {
    D.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-close]'); if (!b) return;
      var id = b.getAttribute('data-close'), p = $(id); if (!p) return;
      var owner = OWNER[id] && $(OWNER[id]);
      // штатный переключатель сам скроет панель и снимет состояние с кнопки
      if (owner && owner.classList.contains('on')) { owner.click(); return; }
      if (id === 'lxSectionControls' && W.__lxWorkspace && W.__lxWorkspace.exitTools) { W.__lxWorkspace.exitTools(); return; }
      p.style.display = 'none';
    });
  }

  /* ---------- Нижняя док-зона: её высота нужна колонкам панелей, чтобы не перекрывать HUD ---------- */
  function initDock() {
    var dock = $('hudDock'), stage = $('stage'); if (!dock || !stage) return;
    var last = -1;
    function measure() {
      var h = dock.offsetHeight, v = h > 0 ? h + 24 : 0;
      if (v !== last) { last = v; stage.style.setProperty('--dock-h', v + 'px'); }
    }
    if (W.ResizeObserver) new ResizeObserver(measure).observe(dock);
    if (W.MutationObserver) new MutationObserver(function () { raf(measure); }).observe(dock, { attributes: true, attributeFilter: ['style', 'hidden'], subtree: true });
    measure();
  }

  /* ---------- Плавающие панели: сворачиваются по шапке; когда места не хватает, старые сворачиваются сами ---------- */
  function initFloatPanels() {
    var cols = [$('stageSideL'), $('stageSideR')].filter(Boolean); if (!cols.length) return;
    var reduce = !!(W.matchMedia && W.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var pending = false;
    function panelsOf(col) { return [].slice.call(col.children).filter(function (n) { return n.classList && n.classList.contains('fpanel'); }); }
    function shown(p) { return p.style.display !== 'none' && !p.hidden && p.offsetParent !== null; }
    function setFolded(p, on, animate) {
      if (p.classList.contains('folded') === on) return;
      var from = p.offsetHeight;
      p.classList.toggle('folded', on);
      var b = p.querySelector('.fp-fold');
      if (b) { b.setAttribute('aria-expanded', String(!on)); b.setAttribute('aria-label', on ? 'Развернуть панель' : 'Свернуть панель'); }
      if (!animate || reduce || !p.animate) return;
      var to = p.offsetHeight; if (from === to) return;
      p.style.overflow = 'hidden';
      var a = p.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
      a.onfinish = a.oncancel = function () { p.style.overflow = ''; };
    }
    function decorate(p) {
      if (p.__lxFold) return;
      var head = p.querySelector('.fpanel-head'), acts = head && head.querySelector('.fpanel-actions');
      if (!acts) return;
      p.__lxFold = true;
      var b = D.createElement('button'); b.type = 'button'; b.className = 'icon-btn fp-fold'; b.setAttribute('data-ico', 'chevron-up'); b.setAttribute('data-ico-size', '16');
      b.setAttribute('aria-label', 'Свернуть панель'); b.setAttribute('aria-expanded', 'true'); b.setAttribute('data-tip', 'Свернуть / развернуть');
      var close = acts.querySelector('[data-close], [data-panel-close]');
      acts.insertBefore(b, close || null);
      b.addEventListener('click', function (e) { e.stopPropagation(); setFolded(p, !p.classList.contains('folded'), true); });
      head.addEventListener('dblclick', function (e) { if (!e.target.closest('button')) setFolded(p, !p.classList.contains('folded'), true); });
      if (K()) K().hydrate(b);
      if (W.MutationObserver) new MutationObserver(schedule).observe(p, { attributes: true, attributeFilter: ['style', 'hidden'] });
    }
    function arrange(col) {
      var all = panelsOf(col); all.forEach(decorate);
      var list = all.filter(shown), fresh = list.filter(function (p) { return !p.__lxSeen; });
      all.forEach(function (p) { p.__lxSeen = shown(p); });
      if (!fresh.length) return;
      fresh.forEach(function (p) { if (p.classList.contains('folded')) setFolded(p, false, true); });
      for (var guard = 0; guard < 8 && col.scrollHeight - col.clientHeight > 2; guard++) {
        var old = list.filter(function (p) { return fresh.indexOf(p) < 0 && !p.classList.contains('folded'); })[0];
        if (!old) break;
        setFolded(old, true, false);
      }
    }
    function run() { pending = false; cols.forEach(arrange); }
    function schedule() { if (!pending) { pending = true; raf(run); } }
    cols.forEach(function (c) { if (W.MutationObserver) new MutationObserver(schedule).observe(c, { childList: true }); });
    W.addEventListener('lx-cloud-loaded', schedule);
    run();
  }

  /* ---------- aria-pressed повторяет состояние «включено» (.on / .lx-mode-active) ---------- */
  function initPressedMirror() {
    var sync = function (el) {
      if (!el.hasAttribute || !el.hasAttribute('aria-pressed')) return;
      var on = el.classList.contains('on') || el.classList.contains('lx-mode-active');
      if (el.getAttribute('aria-pressed') !== String(on)) el.setAttribute('aria-pressed', String(on));
    };
    D.querySelectorAll('[aria-pressed]').forEach(sync);
    if (W.MutationObserver) new MutationObserver(function (muts) { for (var i = 0; i < muts.length; i++) if (muts[i].target.nodeType === 1) sync(muts[i].target); }).observe(D.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
  }

  /* ---------- Подписи вкладок инспектора: текст виден только у активной, остальные — подсказкой ---------- */
  function labelTabs() {
    D.querySelectorAll('.tabs .tab').forEach(function (t) {
      var l = t.querySelector('.lbl'); if (!l) return;
      var txt = l.textContent.trim(); if (!txt) return;
      t.setAttribute('aria-label', txt); t.setAttribute('data-tip', txt); t.removeAttribute('title');
    });
  }

  /* ---------- Скелетон дерева проекта ---------- */
  function initSkeleton() {
    var tree = $('tree'), sk = $('treeSkeleton');
    if (!tree || !sk) return;
    function done() { if (tree.childElementCount > 0 && !sk.classList.contains('done')) { sk.classList.add('done'); setTimeout(function () { sk.hidden = true; }, 260); return true; } return false; }
    if (done()) return;
    if (W.MutationObserver) { var mo = new MutationObserver(function () { if (done()) mo.disconnect(); }); mo.observe(tree, { childList: true }); }
    setTimeout(function () { sk.classList.add('done'); sk.hidden = true; }, 8000);
  }

  /* ---------- Полный экран ---------- */
  function initFullscreen() {
    var b = $('vtFull'), stage = $('stage'); if (!b || !stage) return;
    function paint() {
      var on = !!D.fullscreenElement;
      b.setAttribute('aria-pressed', String(on)); setIcon(b, on ? 'minimize-2' : 'maximize-2', 17);
      b.setAttribute('data-tip', on ? 'Выйти из полного экрана' : 'Полный экран'); b.removeAttribute('title');
    }
    b.addEventListener('click', function () {
      var p = D.fullscreenElement ? D.exitFullscreen() : stage.requestFullscreen();
      if (p && p.catch) p.catch(function () { toast('Полноэкранный режим недоступен', 'warn'); });
    });
    D.addEventListener('fullscreenchange', paint);
    paint();
  }

  /* ---------- Статус-бар ---------- */
  var MODES = [
    { id: 'measure', text: 'Измерение', on: function (v) { return !!v.measuring; } },
    { id: 'edit', text: 'Правка облака', on: function (v) { return !!v.editSelect; } },
    { id: 'walk', text: 'Прогулка', on: function (v) { return !!v.walk; } },
    { id: 'tour', text: 'Станции', on: function (v) { return !!v.tour; } },
    { id: 'section', text: 'Сечение', on: function (v) { return !!(v.section && v.section.on); } }
  ];
  function nfmt(n) { try { return Math.round(n).toLocaleString('ru-RU'); } catch (e) { return String(n); } }
  function cloudPoints() {
    var n = 0, v = viewer();
    try { n = Number(v && v.pointCount) || 0; } catch (e) {}
    try { if (!n && W.MultiCloud && W.MultiCloud.totalPoints) n = W.MultiCloud.totalPoints() || 0; } catch (e) {}
    return n;
  }
  var lastMode = '', lastInfo = '';
  function updateStatus() {
    var v = viewer(), mode = { id: 'view', text: 'Обзор' };
    if (v) { for (var i = 0; i < MODES.length; i++) { try { if (MODES[i].on(v)) { mode = MODES[i]; break; } } catch (e) {} } }
    if (mode.id === 'view' && W.__lxDraw && W.__lxDraw.active) mode = { id: 'draw', text: 'Чертёж' };
    var m = $('lxMode'), t = $('lxModeText');
    if (m && lastMode !== mode.id) { lastMode = mode.id; m.setAttribute('data-mode', mode.id); if (t) t.textContent = mode.text; R.setAttribute('data-tool', mode.id); }
    var info = $('lxCloudInfo');
    if (info) {
      var n = cloudPoints(), txt = n > 0 ? (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace('.', ',') + ' млн точек' : nfmt(n) + ' точек') : '';
      if (txt !== lastInfo) { lastInfo = txt; info.textContent = txt; info.hidden = !txt; }
    }
    paintHud(v);
  }
  function paintHud(v) {
    var name = $('hudMeasureName'), ico = $('hudMeasureIco');
    if (!name || !v || !v.measuring) return;
    var mode = v.measureMode || 'distance', id = 'mm' + mode.charAt(0).toUpperCase() + mode.slice(1);
    var it = C && C.byId && C.byId[id];
    if (it && name.textContent !== it.label) { name.textContent = it.label; if (ico) { ico.innerHTML = ic(it.ico, 18); ico.setAttribute('data-ico', it.ico); ico.setAttribute('data-ico-done', it.ico); } }
  }
  function setCoords(x, y, z) {
    [['lxX', x], ['lxY', y], ['lxZ', z]].forEach(function (p) { var e = $(p[0]); if (e) e.textContent = p[1] == null ? '—' : (+p[1]).toFixed(3); });
  }
  W.__lxSetCoords = setCoords;
  function initStatus() {
    var ro = $('measureReadout');
    if (ro && W.MutationObserver) {
      var rx = /(?<![\wΔ])X\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)/, ry = /(?<![\wΔ])Y\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)/, rz = /(?<![\wΔ])Z\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)/;
      new MutationObserver(function () {
        var s = ro.textContent || '', a = s.match(rx), b = s.match(ry), c = s.match(rz);
        if (a || b || c) setCoords(a ? a[1].replace(',', '.') : null, b ? b[1].replace(',', '.') : null, c ? c[1].replace(',', '.') : null);
      }).observe(ro, { childList: true, subtree: true, characterData: true });
    }
    var log = $('vtLog');
    if (log && W.MutationObserver) {
      var dc = $('devConsole');
      var sync = function () { var on = !!dc && dc.classList.contains('open') || (!!dc && W.getComputedStyle(dc).display !== 'none'); log.classList.toggle('on', on); log.setAttribute('aria-pressed', String(on)); };
      if (dc) new MutationObserver(sync).observe(dc, { attributes: true, attributeFilter: ['class', 'style'] });
      sync();
    }
    updateStatus();
    setInterval(function () { if (!D.hidden) updateStatus(); }, 450);
    ['lx-cloud-loaded', 'mc-changed', 'lx-tools-cancelled'].forEach(function (n) { W.addEventListener(n, updateStatus); });
    D.addEventListener('click', function () { setTimeout(updateStatus, 30); }, true);
  }

  /* ---------- Состояние сохранения в статус-баре ---------- */
  var SAVE_LABEL = { idle: 'Готово', saving: 'Сохранение…', dirty: 'Не сохранено', saved: 'Сохранено', error: 'Ошибка сохранения' };
  function saveState(state, text, title) {
    var s = $('lxSaveState'), t = $('lxSaveText'); if (!s) return;
    s.setAttribute('data-state', state); if (t) t.textContent = text || SAVE_LABEL[state] || '';
    if (title) s.setAttribute('data-tip', title);
    s.removeAttribute('title');
  }
  W.__lxSaveState = saveState;

  /* ---------- Палитра команд ---------- */
  var palette = null;
  function paletteEntries() {
    var out = [];
    if (!C) return out;
    var rib = W.__lxRibbon;
    C.TABS.forEach(function (t) {
      out.push({ kind: 'tab', id: 'tab.' + t.id, ico: 'layout-list', label: 'Вкладка «' + t.label + '»', group: 'Навигация', text: 'вкладка ' + t.label, run: function () { if (rib) rib.select(t.id, { user: true }); } });
    });
    C.all().forEach(function (e) {
      var it = e.item, rec = rib && rib.cells[it.id];
      if (rec && rec.cell && rec.cell.hidden && !rec.item.slot) return;
      if (rec && !rec.btn) return;
      var btn = rec && rec.btn;
      var label = (btn && btn.__lxLabel) || it.label || it.id;
      var idle = !!(btn && btn.getAttribute('aria-disabled') === 'true');
      out.push({ kind: 'cmd', id: it.id, ico: it.ico, label: label, group: e.tab.label + ' · ' + e.group.label, idle: idle, idleTip: btn && btn.getAttribute('data-idle-tip'),
        text: [label, e.tab.label, e.group.label, it.tip || ''].join(' '), keys: it.keys,
        run: function () { if (rib) rib.select(e.tab.id); if (btn) { btn.click(); if (btn.tagName !== 'BUTTON' && btn.tagName !== 'LABEL') return; } } });
    });
    return out;
  }
  function closePalette() {
    if (!palette) return; var p = palette; palette = null;
    D.removeEventListener('keydown', p.onKey, true); p.el.classList.add('leaving');
    setTimeout(function () { if (p.el.parentNode) p.el.parentNode.removeChild(p.el); }, 120);
    if (p.prev && p.prev.focus) try { p.prev.focus({ preventScroll: true }); } catch (e) {}
  }
  function openPalette() {
    if (palette) { closePalette(); return; }
    if (K()) K().closePopover();
    var wrap = D.createElement('div'); wrap.className = 'lx-palette'; wrap.id = 'lxPalette';
    wrap.innerHTML = '<div class="lx-palette-card" role="dialog" aria-modal="true" aria-label="Поиск команд">' +
      '<div class="lx-palette-q"><span class="lx-palette-ico">' + ic('search', 18) + '</span>' +
      '<input id="lxPaletteInput" type="text" role="combobox" aria-expanded="true" aria-controls="lxPaletteList" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Команда или вкладка: расстояние, экспорт, этаж…" /></div>' +
      '<div class="lx-palette-list" id="lxPaletteList" role="listbox"></div>' +
      '<div class="lx-palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> выбор</span><span><kbd>Enter</kbd> выполнить</span><span><kbd>Esc</kbd> закрыть</span></div></div>';
    D.body.appendChild(wrap);
    var input = wrap.querySelector('input'), list = wrap.querySelector('.lx-palette-list');
    var entries = paletteEntries(), shownList = [], sel = 0;
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function render() {
      var q = input.value.trim();
      shownList = entries.filter(function (e) { return C.match(q, e.text); });
      if (q) {
        var ql = q.toLowerCase();
        shownList.sort(function (a, b) { return score(b, ql) - score(a, ql); });
      }
      shownList = shownList.slice(0, 40);
      if (sel >= shownList.length) sel = Math.max(0, shownList.length - 1);
      if (!shownList.length) { list.innerHTML = '<div class="lx-palette-empty">Ничего не найдено. Попробуйте другое слово.</div>'; return; }
      list.innerHTML = shownList.map(function (e, i) {
        return '<button type="button" class="lx-palette-item' + (e.idle ? ' idle' : '') + '" role="option" id="lxp' + i + '" data-i="' + i + '" aria-selected="' + (i === sel) + '">' +
          '<span class="p-ico">' + ic(e.ico, 18) + '</span><span class="p-t">' + esc(e.label) + '</span>' +
          (e.idle ? '<span class="p-idle">нужно облако</span>' : '') + '<span class="p-g">' + esc(e.group) + '</span>' + (e.keys ? '<kbd>' + esc(e.keys) + '</kbd>' : '') + '</button>';
      }).join('');
      input.setAttribute('aria-activedescendant', 'lxp' + sel);
    }
    function score(e, q) { var l = e.label.toLowerCase(); return (l === q ? 100 : l.indexOf(q) === 0 ? 60 : l.indexOf(q) > -1 ? 30 : 0) + (e.kind === 'cmd' ? 1 : 0); }
    function mark() {
      var items = list.querySelectorAll('.lx-palette-item');
      for (var i = 0; i < items.length; i++) items[i].setAttribute('aria-selected', String(i === sel));
      var cur = items[sel]; if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
      input.setAttribute('aria-activedescendant', 'lxp' + sel);
    }
    function run(i) {
      var e = shownList[i]; if (!e) return; closePalette();
      setTimeout(function () { try { e.run(); } catch (err) { toast('Не удалось выполнить команду', 'err'); } }, 60);
    }
    input.addEventListener('input', function () { sel = 0; render(); });
    list.addEventListener('click', function (e) { var b = e.target.closest('.lx-palette-item'); if (b) run(+b.getAttribute('data-i')); });
    list.addEventListener('pointermove', function (e) { var b = e.target.closest('.lx-palette-item'); if (b) { var i = +b.getAttribute('data-i'); if (i !== sel) { sel = i; mark(); } } });
    wrap.addEventListener('pointerdown', function (e) { if (e.target === wrap) closePalette(); });
    var onKey = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shownList.length - 1, sel + 1); mark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
      else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
      else if (e.key === 'Tab') { e.preventDefault(); }
    };
    D.addEventListener('keydown', onKey, true);
    palette = { el: wrap, onKey: onKey, prev: D.activeElement };
    render(); input.focus();
  }
  function initPalette() {
    var b = $('tbCmd'); if (b) b.addEventListener('click', openPalette);
    D.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K' || e.code === 'KeyK')) { e.preventDefault(); e.stopPropagation(); openPalette(); }
    }, true);
  }

  /* ---------- Первичная подгонка вида после загрузки облака ---------- */
  var fitSig = '';
  function fitCloud(force) {
    var v = W.__viewer; if (!v || !v.bbox) return false;
    var b = v.bbox, vals = [].concat(b.mn || [], b.mx || []);
    if (vals.length < 6 || !vals.every(Number.isFinite)) return false;
    var points = Number(v.pointCount || (W.MultiCloud && W.MultiCloud.totalPoints && W.MultiCloud.totalPoints()) || 0);
    if (points <= 0) return false;
    var sig = points + ':' + vals.map(function (x) { return x.toFixed(3); }).join(',');
    if (!force && sig === fitSig) return true;
    fitSig = sig;
    try {
      if (v.setCloudVisible) v.setCloudVisible(true);
      if (W.MultiCloud && W.MultiCloud.list) W.MultiCloud.list().forEach(function (c) { if (c.visible === false) W.MultiCloud.setVisible(c.id, true); });
      if (v.resetView) v.resetView();
    } catch (e) {}
    return true;
  }
  function initCloudFit() {
    W.addEventListener('lx-cloud-loaded', function () { setTimeout(function () { fitCloud(false); }, 120); setTimeout(function () { fitCloud(false); }, 750); });
    W.addEventListener('mc-changed', function () { setTimeout(function () { fitCloud(false); }, 120); });
    // Проект открыт со стартового экрана с просьбой проверить распределение по этажам
    var fromStart = /(?:^|[?&])fromStart=/.test(W.location.search), auto = false;
    try { auto = fromStart && W.sessionStorage.getItem('bim.autoFloorOnOpen') === '1'; if (auto) W.sessionStorage.removeItem('bim.autoFloorOnOpen'); } catch (e) {}
    if (auto) {
      var n = 0, t = setInterval(function () {
        n++;
        var ok = false; try { ok = W.MultiCloud && W.MultiCloud.totalPoints && W.MultiCloud.totalPoints() > 0 && W.__lxScene && W.__lxScene.autoSlice; } catch (e) {}
        if (ok) { clearInterval(t); W.__lxScene.autoSlice(); } else if (n > 30) clearInterval(t);
      }, 500);
    }
  }

  /* ---------- Вкладки ленты влияют на правую панель ---------- */
  function onTab(id) {
    if (id === 'floors') showPane('scene', { reveal: !drawer(), persist: false });
  }

  function init() {
    initTheme(); initPanels(); initPane(); initSkeleton(); initFullscreen(); initStatus(); initPalette(); initCloudFit(); initClose(); initDock(); initFloatPanels(); initPressedMirror(); labelTabs();
    W.addEventListener('bim-language-change', function () { setTimeout(labelTabs, 0); });
    if (K()) K().hydrate(D);
  }
  W.__lxChrome = { onTab: onTab, showPane: showPane, setSide: setSide, setInspector: setInsp, openPalette: openPalette, closePalette: closePalette, saveState: saveState, updateStatus: updateStatus, fitCloud: fitCloud, ready: ready };
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', init); else init();
})();
