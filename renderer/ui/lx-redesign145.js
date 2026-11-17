/* BIM Twin — r145: UI-редизайн «ближе к Lixel, с нашим акцентом».
 *  1) левая вертикальная панель инструментов (иконки + тултипы) — дублирует основные вкладки ленты;
 *  2) правая панель «Управление данными» — дерево Облако точек / Этажи / Модель / Документы / Сцена / Свойства
 *     с чекбоксами видимости (облако — реально скрывает/показывает точки);
 *  3) панель «Свойства» выбранного объекта: имя, точек, габариты X/Y/Z, размер точки, прозрачность,
 *     режим отображения RGB / высота / интенсивность.
 * Новые элементы — только этот файл (динамически грузится из app.js). r130 (крупные подписи ленты,
 * светлая тема с тёмным 3D, привязка off) не трогаем. Палитра: violet #a78bfa/#6a52cb, graphite
 * #1c1b1a/#232221, на токенах tokens.css; без синего/чистого белого/градиентов.
 * API: window.__lxDesign145 = { mount, refresh, isMounted }
 */
(function () {
  'use strict';
  var W = window, D = document;
  var st = { mounted: false, rail: null, data: null, props: null, timer: 0, cloudOn: true };
  function $id(id) { return D.getElementById(id); }
  function viewer() { return W.__viewer || W.__lxViewer || null; }
  function icon(name, size) {
    try { return W.__lxIcons && W.__lxIcons.svg ? W.__lxIcons.svg(name, size || 18) : ''; } catch (e) { return ''; }
  }
  function el(tag, cls, attrs) {
    var e = D.createElement(tag); if (cls) e.className = cls;
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) { if (k === 'text') e.textContent = attrs[k]; else if (k === 'html') e.innerHTML = attrs[k]; else e.setAttribute(k, attrs[k]); }
    return e;
  }
  function fmtMln(n) { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' млн'; if (n >= 1e3) return (n / 1e3).toFixed(0).replace('.', ',') + ' тыс.'; return String(Math.round(n)); }
  function fmtM(n) { var x = Number(n); return isFinite(x) ? x.toFixed(2).replace('.', ',') : '—'; }
  function clickTab(id) {
    try {
      var b = D.querySelector('.lx-tab[data-tab="' + id + '"]');
      if (b) { b.click(); return true; }
      var p = D.querySelector('[data-tab="' + id + '"]');
      if (p) { p.click(); return true; }
    } catch (e) { }
    return false;
  }

  var CSS = [
    '.lx145-rail { position: fixed; left: 8px; top: 196px; z-index: 60; display: flex; flex-direction: column; gap: 4px; padding: 4px; border: 1px solid var(--line); border-radius: 12px; background: var(--glass); box-shadow: var(--shadow-2); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }',
    '.lx145-rail button { position: relative; display: grid; place-items: center; width: 38px; height: 38px; padding: 0; border: 0; border-radius: 9px; background: transparent; color: var(--txt-2); cursor: pointer; transition: background var(--t-fast), color var(--t-fast); }',
    '.lx145-rail button:hover { background: var(--bg-3); color: var(--txt); }',
    '.lx145-rail button.active { background: var(--accent-soft); color: var(--accent); }',
    '.lx145-rail button svg { width: 19px; height: 19px; }',
    '.lx145-side { display: flex; flex-direction: column; gap: 6px; width: 100%; min-width: 0; padding: 8px; border: 1px solid var(--line); border-radius: var(--r-3); background: var(--bg-1); color: var(--txt); font: 11px/1.35 var(--font); }',
    '.lx145-side h3 { display: flex; align-items: center; gap: 6px; margin: 0; padding: 2px 2px 6px; color: var(--txt); font-size: 11.5px; font-weight: 600; letter-spacing: .02em; border-bottom: 1px solid var(--line); }',
    '.lx145-side h3 .ico { color: var(--accent); }',
    '.lx145-tree { display: flex; flex-direction: column; gap: 1px; }',
    '.lx145-row { display: flex; align-items: center; gap: 7px; min-height: 26px; padding: 2px 4px; border: 0; border-radius: 6px; background: transparent; color: var(--txt-2); font: 11px/1.3 var(--font); text-align: left; cursor: pointer; }',
    '.lx145-row:hover { background: var(--bg-2); color: var(--txt); }',
    '.lx145-row .chk { width: 13px; height: 13px; flex: none; accent-color: var(--accent); }',
    '.lx145-row .ic { flex: none; color: var(--txt-3); }',
    '.lx145-row .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.lx145-row .cnt { color: var(--txt-3); font: 10px/1 var(--mono); font-variant-numeric: tabular-nums; }',
    '.lx145-props { display: flex; flex-direction: column; gap: 6px; }',
    '.lx145-name { display: flex; align-items: center; gap: 6px; padding: 5px 6px; border-radius: 6px; background: var(--bg-2); color: var(--txt); font-weight: 500; }',
    '.lx145-name .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; }',
    '.lx145-name .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.lx145-kv { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 2px 8px; color: var(--txt-2); font: 10.5px/1.45 var(--mono); }',
    '.lx145-kv .k { color: var(--txt-3); }',
    '.lx145-kv .v { color: var(--txt); text-align: right; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.lx145-lbl { display: flex; align-items: center; gap: 6px; color: var(--txt-2); font-size: 10.5px; }',
    '.lx145-lbl > span { flex: 0 0 86px; }',
    '.lx145-lbl input[type="range"] { flex: 1; min-width: 0; accent-color: var(--accent); }',
    '.lx145-lbl output { flex: 0 0 34px; color: var(--txt-3); font: 10px/1 var(--mono); text-align: right; }',
    '.lx145-lbl select { flex: 1; min-width: 0; height: 24px; padding: 0 5px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg-2); color: var(--txt); font: 11px/1 var(--font); }',
    '.lx145-lbl select:focus-visible, .lx145-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }',
    '.lx145-note { margin: 0; color: var(--txt-3); font-size: 9.5px; line-height: 1.4; }',
    '@media (max-width: 1100px) { .lx145-rail { display: none; } }',
    '@media (min-width: 2560px) { .lx145-rail button { width: 44px; height: 44px; } .lx145-rail button svg { width: 22px; height: 22px; } .lx145-side { font-size: 12px; } }'
  ].join('\n');

  function ensureStyles() {
    if (D.getElementById('lx145Styles')) return;
    var s = el('style'); s.id = 'lx145Styles'; s.textContent = CSS;
    (D.head || D.documentElement).appendChild(s);
  }

  var TOOLS = [
    { id: 'project', label: 'Проект / облако', ico: 'cloud' },
    { id: 'import', label: 'Импорт облака', ico: 'upload' },
    { id: 'measure', label: 'Измерения', ico: 'ruler' },
    { id: 'draw', label: 'Чертёж', ico: 'pencil' },
    { id: 'bim', label: 'BIM-модель', ico: 'building' },
    { id: 'view', label: 'Вид / качество', ico: 'eye' },
    { id: 'qa', label: 'Контроль качества', ico: 'clipboard-check' }
  ];

  function buildRail() {
    if (st.rail && st.rail.isConnected) return st.rail;
    ensureStyles();
    var r = el('nav', 'lx145-rail'); r.id = 'lx145Rail'; r.setAttribute('aria-label', 'Инструменты');
    TOOLS.forEach(function (t) {
      var b = el('button', '', { type: 'button', title: t.label, 'data-lx145-tool': t.id, 'aria-label': t.label });
      b.innerHTML = icon(t.ico, 19) || '<span>' + t.label.slice(0, 1) + '</span>';
      b.addEventListener('click', function () {
        if (t.id === 'import') {
          var oc = $id('btnOpenCloud'); if (oc) { oc.click(); return; }
        }
        clickTab(t.id);
        markActive();
      });
      r.appendChild(b);
    });
    D.body.appendChild(r);
    st.rail = r;
    markActive();
    return r;
  }
  function markActive() {
    if (!st.rail) return;
    var active = '';
    try { var a = D.querySelector('.lx-tab.active'); if (a) active = a.getAttribute('data-tab') || ''; } catch (e) { }
    Array.prototype.slice.call(st.rail.querySelectorAll('[data-lx145-tool]')).forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-lx145-tool') === active);
    });
  }

  function cloudInfo() {
    var v = viewer(); try { return v && v.getCloudInfo ? v.getCloudInfo() : null; } catch (e) { return null; }
  }
  function rowsSpec() {
    var ci = cloudInfo();
    return [
      { key: 'cloud', label: 'Облако точек', ico: 'cloud', count: ci ? (ci.loadedCount || ci.sourceCount) : 0, check: true },
      { key: 'floors', label: 'Этажи', ico: 'layers', count: '' },
      { key: 'model', label: 'Модель', ico: 'building', count: '' },
      { key: 'docs', label: 'Документы', ico: 'file-text', count: '' },
      { key: 'scene', label: 'Сцена', ico: 'map-pin', count: '' },
      { key: 'props', label: 'Свойства', ico: 'sliders-horizontal', count: '' }
    ];
  }
  function buildData() {
    if (st.data && st.data.isConnected) return st.data;
    ensureStyles();
    var host = $id('stageSideR') || D.querySelector('.inspector');
    var d = el('section', 'lx145-side lx145-data'); d.id = 'lx145Data'; d.setAttribute('data-lx145-panel', 'data');
    var h = el('h3'); h.innerHTML = '<span class="ico">' + icon('layers', 15) + '</span><span>Управление данными</span>'; d.appendChild(h);
    var tree = el('div', 'lx145-tree'); tree.setAttribute('data-lx145-tree', '1'); d.appendChild(tree);
    d.addEventListener('change', onTreeChange);
    d.addEventListener('click', onTreeClick);
    (host || D.body).appendChild(d);
    st.data = d; st.tree = tree;
    return d;
  }
  function paintTree() {
    if (!st.tree) return;
    var ci = cloudInfo();
    st.tree.textContent = '';
    rowsSpec().forEach(function (r) {
      var row = el('div', 'lx145-row', { 'data-lx145-row': r.key, role: 'treeitem' });
      if (r.check) {
        var cb = el('input', 'chk', { type: 'checkbox', 'data-lx145-chk': r.key, 'aria-label': 'Показывать: ' + r.label });
        cb.checked = !viewer() || viewer().cloudVisible !== false;
        row.appendChild(cb);
      }
      var ic = el('span', 'ic'); ic.innerHTML = icon(r.ico, 14) || ''; row.appendChild(ic);
      var nm = el('span', 'nm', { text: r.label }); row.appendChild(nm);
      var cnt = el('span', 'cnt', { text: r.key === 'cloud' && ci ? fmtMln(ci.loadedCount || ci.sourceCount) : (r.count || '') });
      row.appendChild(cnt);
      st.tree.appendChild(row);
    });
  }
  function onTreeChange(e) {
    var t = e.target;
    if (t && t.matches && t.matches('[data-lx145-chk="cloud"]')) {
      var v = viewer(); if (!v) return;
      try { if (v.setCloudVisible) v.setCloudVisible(!!t.checked); } catch (e2) { }
      st.cloudOn = !!t.checked;
    }
  }
  function onTreeClick(e) {
    var row = e.target && e.target.closest && e.target.closest('[data-lx145-row]');
    if (!row) return;
    var key = row.getAttribute('data-lx145-row');
    if (key === 'floors') clickTab('floors');
    else if (key === 'model') clickTab('bim');
    else if (key === 'scene') { try { if (W.__lxChrome && W.__lxChrome.showPane) W.__lxChrome.showPane('scene', { reveal: true }); } catch (e2) { } }
    else if (key === 'props') { try { if (W.__lxChrome && W.__lxChrome.setInspector) W.__lxChrome.setInspector(!D.documentElement.classList.contains('lx-insp-closed')); } catch (e2) { } }
    else if (key === 'docs') {
      try {
        if (W.__lxS2BDocs && W.__lxS2BDocs.open) W.__lxS2BDocs.open(viewer() && viewer().getCloudInfo ? null : null);
        else if (W.__lxScan2BIM && W.__lxScan2BIM.open) { W.__lxScan2BIM.open(); setTimeout(function () { var b = $id('lxScan2BimDocsBtn'); if (b) b.click(); }, 400); }
      } catch (e2) { }
    }
  }

  function buildProps() {
    if (st.props && st.props.isConnected) return st.props;
    ensureStyles();
    var host = $id('stageSideR') || D.querySelector('.inspector') || D.body;
    var p = el('section', 'lx145-side lx145-props'); p.id = 'lx145Props'; p.setAttribute('data-lx145-panel', 'props');
    p.innerHTML = '<h3><span class="ico">' + icon('sliders-horizontal', 15) + '</span><span>Свойства</span></h3>' +
      '<div class="lx145-name"><span class="dot"></span><span class="nm" data-lx145-name>Облако не загружено</span></div>' +
      '<div class="lx145-kv">' +
      '<span class="k">Точек</span><span class="v" data-lx145-points>—</span>' +
      '<span class="k">Габариты X / Y / Z</span><span class="v" data-lx145-bbox>—</span>' +
      '<span class="k">Размер точки</span><span class="v" data-lx145-size>авто · 2–3 px</span>' +
      '</div>' +
      '<label class="lx145-lbl"><span>Размер точки</span><input type="range" min="0.5" max="3" step="0.1" value="1" data-lx145-psize><output data-lx145-psize-o>1.0</output></label>' +
      '<label class="lx145-lbl"><span>Прозрачность</span><input type="range" min="0" max="1" step="0.05" value="1" data-lx145-op><output data-lx145-op-o>1.00</output></label>' +
      '<label class="lx145-lbl"><span>Отображение</span><select data-lx145-color><option value="rgb">RGB</option><option value="elev">Высота (Z)</option><option value="intensity">Интенсивность</option></select></label>' +
      '<p class="lx145-note">Свойства облака: имя, количество точек, габариты и параметры отображения. Для выбранного объекта показываются имя и тип.</p>';
    p.addEventListener('input', onPropsInput);
    p.addEventListener('change', onPropsInput);
    host.appendChild(p);
    st.props = p;
    return p;
  }
  function onPropsInput(e) {
    var t = e.target; if (!t || !t.matches) return;
    var v = viewer(); if (!v) return;
    try {
      if (t.matches('[data-lx145-psize]')) {
        var m = +t.value; if (v.setPointSizeScale) v.setPointSizeScale(m); else if (v.setCloudPointSize) v.setCloudPointSize(m);
        var o = st.props.querySelector('[data-lx145-psize-o]'); if (o) o.textContent = m.toFixed(1);
      } else if (t.matches('[data-lx145-op]')) {
        if (v.setCloudOpacity) v.setCloudOpacity(+t.value);
        var o2 = st.props.querySelector('[data-lx145-op-o]'); if (o2) o2.textContent = (+t.value).toFixed(2);
      } else if (t.matches('[data-lx145-color]')) {
        if (v.setColorMode) v.setColorMode(t.value);
        refresh();
      }
    } catch (e2) { }
  }
  function paintProps() {
    if (!st.props) return;
    var ci = cloudInfo();
    function q(s) { return st.props.querySelector(s); }
    var nm = q('[data-lx145-name]');
    if (ci) {
      if (nm) nm.textContent = ci.sourceName || 'Облако точек';
      var pts = q('[data-lx145-points]');
      if (pts) pts.textContent = fmtMln(ci.loadedCount) + (ci.sourceCount > ci.loadedCount ? ' из ' + fmtMln(ci.sourceCount) : '');
      var bb = q('[data-lx145-bbox]');
      if (bb && ci.bounds) bb.textContent = fmtM(ci.bounds.mx[0] - ci.bounds.mn[0]) + ' × ' + fmtM(ci.bounds.mx[1] - ci.bounds.mn[1]) + ' × ' + fmtM(ci.bounds.mx[2] - ci.bounds.mn[2]) + ' м';
      var sz = q('[data-lx145-size]');
      if (sz) sz.textContent = (viewer() && viewer()._autoPointSize) ? 'авто · 2–3 px' : ('фикс. ' + (+((viewer() && viewer()._cloudDisplay && viewer()._cloudDisplay.pointSize) || 1)).toFixed(1) + ' px');
      var cm = q('[data-lx145-color]');
      if (cm) { var mode = viewer() && viewer().getColorMode ? viewer().getColorMode() : 'rgb'; if (cm.value !== mode) cm.value = mode; var opts = viewer() && viewer().getAvailableColorModes ? viewer().getAvailableColorModes() : ['rgb', 'elev']; Array.prototype.slice.call(cm.options).forEach(function (o) { o.disabled = opts.indexOf(o.value) < 0; }); }
    } else {
      if (nm) nm.textContent = 'Облако не загружено';
    }
  }

  function mount() {
    if (st.mounted) { refresh(); return true; }
    st.mounted = true;
    try { buildRail(); buildData(); buildProps(); paintTree(); paintProps(); } catch (e) { console.warn('lx145 mount', e); }
    st.timer = setInterval(refresh, 800);
    try { W.addEventListener('lx-cloud-loaded', function () { paintTree(); paintProps(); }); } catch (e) { }
    if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', function () { paintTree(); paintProps(); }); 
    try { var mo = new MutationObserver(function () { markActive(); }); mo.observe(D.body, { subtree: true, attributes: true, attributeFilter: ['class'] }); } catch (e) { }
    return true;
  }
  function refresh() {
    if (!st.mounted) return;
    try { paintTree(); paintProps(); markActive(); } catch (e) { }
  }
  function isMounted() { return !!st.mounted; }

  var API = { version: '145', mount: mount, refresh: refresh, isMounted: isMounted, TOOLS: TOOLS.slice() };
  W.__lxDesign145 = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof globalThis !== 'undefined' && typeof window === 'undefined') { try { globalThis.__lxDesign145 = API; } catch (e) { } }
})();

