/* BIM Twin — стартовый экран: выбор проекта и переход в рабочую область.
 * Работает поверх window.bimAPI (listProjects / createProject / switchProject / окно) и UI-кита (ui/kit.js):
 * значки, подсказки, тосты и диалог ввода — без window.prompt/alert, которых в Electron нет или которые выбиваются из дизайна. */
(function () {
  'use strict';
  var W = window, D = document, ROOT = D.documentElement;
  var $ = function (id) { return D.getElementById(id); };
  var api = W.bimAPI || null, kit = W.__lxKit || null;
  var projects = [], selected = null, query = '', opening = false, loadSeq = 0;
  var STATUS = { active: 'Активный', draft: 'Черновик', archived: 'В архиве', done: 'Завершён' };   // служебные значения статуса → подписи

  /* ---------- Мелкие помощники ---------- */
  function el(tag, cls, text) { var n = D.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function glyph(cls, name, size) { var n = el('span', cls); n.setAttribute('data-ico', name); if (size) n.setAttribute('data-ico-size', String(size)); return n; }
  function hydrate(scope) { if (kit && kit.hydrate) kit.hydrate(scope || D); else if (W.__lxIcons) W.__lxIcons.hydrate(scope || D); }
  function plural(n, forms) { var a = Math.abs(n) % 100, b = a % 10; return forms[a > 10 && a < 20 ? 2 : b > 1 && b < 5 ? 1 : b === 1 ? 0 : 2]; }
  function say(text, tone) { if (kit && kit.toast) kit.toast(text, tone ? { tone: tone } : undefined); }
  function why(e) { return (e && e.message) || String(e || 'ошибка'); }
  function store(key, value) { try { W.localStorage.setItem(key, value); } catch (e) { /* хранилище недоступно — выбор просто не запомнится */ } }
  function load1(key) { try { return W.localStorage.getItem(key); } catch (e) { return null; } }

  /* ---------- Тема: общая с рабочей областью (bim.settings), чтобы окна не отличались цветом ---------- */
  function readSettings() { try { var o = JSON.parse(load1('bim.settings') || 'null'); return o && typeof o === 'object' ? o : null; } catch (e) { return null; } }
  function initialTheme() { var s = readSettings(), t = (s && s.theme) || load1('bim.start.theme'); return t === 'light' ? 'light' : 'dark'; }
  function paintTheme() {
    var light = ROOT.getAttribute('data-theme') === 'light', b = $('theme');
    b.innerHTML = W.__lxIcons ? W.__lxIcons.svg(light ? 'moon' : 'sun', 17) : '';
    b.setAttribute('data-tip', light ? 'Включить тёмную тему' : 'Включить светлую тему');
    [].forEach.call(D.querySelectorAll('[data-theme-set]'), function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-theme-set') === (light ? 'light' : 'dark'))); });
  }
  function setTheme(t) {
    ROOT.setAttribute('data-theme', t); paintTheme();
    store('bim.start.theme', t);
    var s = readSettings() || {}; s.theme = t; store('bim.settings', JSON.stringify(s));
    if (api && api.setSettings) { try { var r = api.setSettings({ theme: t }); if (r && r.catch) r.catch(function () {}); } catch (e) { /* настройки сохранятся локально */ } }
  }

  /* ---------- Состояния списка ---------- */
  function hideState() { var s = $('state'); s.hidden = true; s.textContent = ''; s.className = 'st-state'; }
  function showState(kind, ico, title, text, action) {
    var s = $('state'); s.textContent = ''; s.className = 'st-state' + (kind ? ' ' + kind : ''); s.hidden = false;
    s.appendChild(glyph('st-state-ico', ico)); s.appendChild(el('h2', null, title));
    if (text) s.appendChild(el('p', null, text));
    if (action) { var b = el('button', 'btn ' + (action.primary ? 'primary' : ''), action.label); b.type = 'button'; b.addEventListener('click', action.run); s.appendChild(b); }
    hydrate(s);
  }
  function skeleton() {
    var host = $('projects'); host.textContent = ''; host.hidden = false; host.setAttribute('aria-busy', 'true');
    for (var i = 0; i < 3; i++) {
      var s = el('div', 'st-skel'); s.setAttribute('aria-hidden', 'true');
      for (var j = 0; j < 3; j++) s.appendChild(el('i', 'lx-skel'));
      host.appendChild(s);
    }
  }

  /* ---------- Карточки ---------- */
  function visible() {
    var q = query.trim().toLowerCase();
    return q ? projects.filter(function (p) { return ((p.name || '') + ' ' + (p.address || '')).toLowerCase().indexOf(q) > -1; }) : projects;
  }
  function cards() { return [].slice.call($('projects').querySelectorAll('.st-card[role="radio"]')); }
  function card(p, i) {
    var b = el('button', 'st-card'); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', 'false'); b.tabIndex = -1;
    b.dataset.id = p.id; b.style.setProperty('--i', String(Math.min(i, 12)));
    var text = el('span', 'st-card-text');
    text.appendChild(el('span', 'st-card-name', p.name || 'Без названия'));
    text.appendChild(el('span', 'st-card-addr', p.address || 'Адрес не указан'));
    var meta = el('span', 'st-card-meta');
    if (p.status) meta.appendChild(el('span', 'badge', STATUS[p.status] || p.status));
    if (typeof p.rooms === 'number') meta.appendChild(el('span', null, p.rooms + ' ' + plural(p.rooms, ['помещение', 'помещения', 'помещений'])));
    if (p.active) meta.appendChild(el('span', 'badge ok', 'Последний'));
    b.appendChild(glyph('st-card-ico', 'building-2')); b.appendChild(text); b.appendChild(meta); b.appendChild(glyph('st-card-check', 'check'));
    b.addEventListener('click', function () { choose(p.id); });
    b.addEventListener('dblclick', function () { choose(p.id); openSelected(); });
    return b;
  }
  function tipTruncated() {   // длинное имя или адрес — полный текст в подсказке
    cards().forEach(function (c) {
      var n = c.querySelector('.st-card-name'), a = c.querySelector('.st-card-addr');
      var cut = n.scrollWidth > n.clientWidth + 1 || a.scrollWidth > a.clientWidth + 1;
      if (cut) c.setAttribute('data-tip', n.textContent + (a.textContent && a.textContent !== 'Адрес не указан' ? ' · ' + a.textContent : '')); else c.removeAttribute('data-tip');
    });
  }
  function choose(id, focus) {
    selected = id;
    var list = cards(), any = false;
    list.forEach(function (c) {
      var on = c.dataset.id === id; any = any || on;
      c.setAttribute('aria-checked', String(on)); c.tabIndex = on ? 0 : -1;
      if (on && focus) { c.focus(); if (c.scrollIntoView) c.scrollIntoView({ block: 'nearest' }); }
    });
    if (!any && list[0]) list[0].tabIndex = 0;
    var p = projects.filter(function (x) { return x.id === id; })[0], sel = $('selection');
    sel.textContent = ''; sel.title = p ? (p.name || 'Без названия') : '';
    if (p) { sel.appendChild(D.createTextNode('Выбран: ')); sel.appendChild(el('b', null, p.name || 'Без названия')); } else sel.textContent = 'Проект не выбран';
    if (!opening) $('openProject').disabled = !p;
  }
  function move(dir) {
    var list = cards(); if (!list.length) return;
    var i = list.map(function (c) { return c.dataset.id; }).indexOf(selected); if (i < 0) i = 0;
    var cur = list[i], target = null;
    if (dir === 'left') target = list[i - 1]; else if (dir === 'right') target = list[i + 1];
    else if (dir === 'home') target = list[0]; else if (dir === 'end') target = list[list.length - 1];
    else {   // вверх/вниз по сетке: ближайшая карточка в соседней строке
      var r0 = cur.getBoundingClientRect(), best = Infinity;
      list.forEach(function (c) {
        if (c === cur) return; var r = c.getBoundingClientRect(), dy = dir === 'down' ? r.top - r0.top : r0.top - r.top;
        if (dy < 10) return; var score = dy * 1000 + Math.abs(r.left - r0.left); if (score < best) { best = score; target = c; }
      });
    }
    if (target) choose(target.dataset.id, true);
  }

  function render() {
    var host = $('projects'); host.textContent = ''; host.setAttribute('aria-busy', 'false'); hideState();
    $('searchWrap').hidden = projects.length < 5;   // поиск нужен, когда проектов много
    if (!projects.length) {
      host.hidden = true; $('selection').textContent = 'Проект не выбран'; $('openProject').disabled = true; selected = null;
      showState('', 'folder-plus', 'Проектов пока нет', 'Создайте первый проект — в нём будут облака точек, этажи, помещения и документы.', { label: 'Создать проект', primary: true, run: createProject });
      return;
    }
    host.hidden = false;
    var list = visible();
    if (!list.length) { host.hidden = true; showState('', 'search', 'Ничего не найдено', 'Измените запрос или очистите поиск.', { label: 'Сбросить поиск', run: function () { $('search').value = ''; query = ''; render(); } }); return; }
    list.forEach(function (p, i) { host.appendChild(card(p, i)); });
    if (!query.trim()) {
      var nb = el('button', 'st-card st-new'); nb.type = 'button'; nb.style.setProperty('--i', String(Math.min(list.length, 12)));
      nb.appendChild(glyph('st-card-ico', 'plus')); nb.appendChild(el('b', null, 'Новый проект'));
      nb.addEventListener('click', createProject); host.appendChild(nb);
    }
    hydrate(host);
    var keep = list.some(function (p) { return p.id === selected; });
    var act = list.filter(function (p) { return p.active; })[0];
    choose(keep ? selected : (act || list[0]).id);
    tipTruncated();
  }

  async function load() {
    var seq = ++loadSeq; hideState(); skeleton(); $('searchWrap').hidden = true;
    try {
      if (!api || !api.listProjects) throw new Error('список проектов доступен только в приложении');
      var list = await api.listProjects();
      if (seq !== loadSeq) return;
      projects = Array.isArray(list) ? list : [];
      render();
    } catch (e) {
      if (seq !== loadSeq) return;
      $('projects').textContent = ''; $('projects').hidden = true; $('projects').setAttribute('aria-busy', 'false');
      showState('error', 'triangle-alert', 'Не удалось загрузить проекты', why(e), { label: 'Повторить', run: load });
    }
  }

  /* ---------- Действия ---------- */
  async function openSelected() {
    if (opening || !selected) return;
    opening = true;
    var btn = $('openProject'); btn.classList.add('busy'); btn.setAttribute('aria-busy', 'true');
    try {
      store('bim.onboarded', '1');
      await api.switchProject(selected);
      try { W.sessionStorage.setItem('bim.autoFloorOnOpen', $('autoFloors').checked ? '1' : '0'); } catch (e) { /* без автораскладки по этажам */ }
      D.body.classList.add('st-leaving');   // плавное затухание перед переходом в рабочую область
      setTimeout(function () { W.location.replace('index.html?fromStart=1&v=1300'); }, 210);
    } catch (e) {
      opening = false; btn.classList.remove('busy'); btn.removeAttribute('aria-busy');
      say('Не удалось открыть проект: ' + why(e), 'err');
    }
  }
  async function createProject() {
    if (!kit || !kit.ask || !api || !api.createProject) return;
    var name = await kit.ask({
      title: 'Новый проект', message: 'Название появится в списке проектов и в заголовке рабочей области.', input: true,
      placeholder: 'Например: ЖК «Северный», корпус А', okLabel: 'Создать',
      validate: function (v) { return String(v).trim() ? null : 'Введите название проекта'; }
    });
    if (name == null) return;
    name = String(name).trim(); if (!name) return;
    var btn = $('newProject'); btn.classList.add('busy');
    try {
      var p = await api.createProject({ name: name, address: '' });
      await load();
      if (p && p.id) choose(p.id);
      say('Проект «' + name + '» создан', 'ok');
    } catch (e) { say('Не удалось создать проект: ' + why(e), 'err'); }
    finally { btn.classList.remove('busy'); }
  }

  /* ---------- Раздел «Настройки» ---------- */
  function show(view) {
    var s = view === 'settings';
    $('viewProjects').hidden = s; $('viewSettings').hidden = !s;
    if (s) { $('navSettings').setAttribute('aria-current', 'page'); $('navProjects').removeAttribute('aria-current'); }
    else { $('navProjects').setAttribute('aria-current', 'page'); $('navSettings').removeAttribute('aria-current'); tipTruncated(); }
  }
  async function loadAbout() {
    if (!api) return;
    try {
      var v = api.getVersion ? await api.getVersion() : null;
      if (v) { $('stVersion').textContent = 'v' + v; $('stVersion').hidden = false; $('aboutVersion').textContent = 'BIM Twin ' + v; }
    } catch (e) { /* версия не критична */ }
    try {
      var paths = api.getPaths ? await api.getPaths() : null;
      if (paths) {
        var mode = { sqlite: 'SQLite', json: 'JSON-файл' }[paths.mode] || paths.mode;
        if (mode) $('storeMode').textContent = 'Проекты хранятся локально на этом компьютере (' + mode + ').';
        if (paths.userData) {
          $('storePath').textContent = paths.userData; $('storePath').hidden = false;
          if (api.openPath) { $('openData').hidden = false; $('openData').onclick = function () { api.openPath(paths.userData); }; }
        }
      }
    } catch (e) { /* путь к данным не критичен */ }
  }

  /* ---------- Подключение ---------- */
  function init() {
    if (api && api.platform === 'darwin') ROOT.classList.add('st-mac');
    ROOT.setAttribute('data-theme', initialTheme()); paintTheme();
    hydrate(D);
    $('theme').addEventListener('click', function () { setTheme(ROOT.getAttribute('data-theme') === 'light' ? 'dark' : 'light'); });
    [].forEach.call(D.querySelectorAll('[data-theme-set]'), function (b) { b.addEventListener('click', function () { setTheme(b.getAttribute('data-theme-set')); }); });
    $('min').addEventListener('click', function () { if (api && api.winMin) api.winMin(); });
    $('max').addEventListener('click', function () { if (api && api.winMax) api.winMax(); });
    $('close').addEventListener('click', function () { if (api && api.winClose) api.winClose(); });
    $('navProjects').addEventListener('click', function () { show('projects'); });
    $('navSettings').addEventListener('click', function () { show('settings'); });
    $('openProject').addEventListener('click', openSelected);
    $('newProject').addEventListener('click', createProject);
    $('search').addEventListener('input', function (e) { query = e.target.value; render(); });
    $('autoFloors').checked = load1('bim.start.autoFloors') !== '0';
    $('autoFloors').addEventListener('change', function (e) { store('bim.start.autoFloors', e.target.checked ? '1' : '0'); });
    $('projects').addEventListener('keydown', function (e) {
      var k = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'home', End: 'end' }[e.key];
      if (k && e.target && e.target.getAttribute && e.target.getAttribute('role') === 'radio') { e.preventDefault(); move(k); }
    });
    D.addEventListener('keydown', function (e) {
      if (D.querySelector('.lx-ask') || $('viewProjects').hidden) return;
      var typing = e.target && /^(input|textarea|select)$/i.test(e.target.tagName);
      if (e.key === 'Enter' && !typing && selected && !(e.target && e.target.closest && e.target.closest('button:not(.st-card)'))) { e.preventDefault(); openSelected(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N' || e.key === 'т' || e.key === 'Т')) { e.preventDefault(); createProject(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && !$('searchWrap').hidden) { e.preventDefault(); $('search').focus(); }
    });
    W.addEventListener('resize', tipTruncated);
    loadAbout();
    load();
  }
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', init); else init();
})();
