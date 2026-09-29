/* ============================================================
   LixelStudio shell details for BIM Twin — v1085.
   Самодостаточный аддитивный модуль (3 пункта):
     1) Гизмо осей X/Y/Z + кнопка «дом» (верх-справа вьюпорта)
     2) Тайтлбар: логотип, «Настройки», переключатель темы, «Не авторизовано»
     3) Дерево «Управление данными»: точные SVG-иконки + узел LCC
   Активен только под html[data-lxskin="on"]. Идемпотентен.
   ============================================================ */
(function () {
  'use strict';

  function s(inner, w) {
    w = w || 24;
    return '<svg viewBox="0 0 24 24" width="' + w + '" height="' + w + '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }

  // ---- иконки узлов дерева ----
  var TICO = {
    cloud:  s('<path d="M6 16a4 4 0 0 1 .5-8 5 5 0 0 1 9.6 1.3A3.5 3.5 0 0 1 18 16z"/><circle cx="8.5" cy="13" r=".6" fill="currentColor"/><circle cx="12" cy="12" r=".6" fill="currentColor"/><circle cx="14.5" cy="13.5" r=".6" fill="currentColor"/>', 16),
    mesh:   s('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 3v18M4 7.5l8 4.5 8-4.5M4 16.5l8-4.5 8 4.5"/>', 16),
    traj:   s('<path d="M3 15c3 0 3-6 6-6s3 6 6 6 3-6 6-6"/><circle cx="3" cy="15" r="1.3" fill="currentColor" stroke="none"/><circle cx="21" cy="9" r="1.3" fill="currentColor" stroke="none"/>', 16),
    pano:   s('<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>', 16),
    vector: s('<path d="M4 20L20 4"/><rect x="2" y="18" width="4" height="4" rx=".6" fill="currentColor" stroke="none"/><rect x="18" y="2" width="4" height="4" rx=".6" fill="currentColor" stroke="none"/><rect x="10" y="10" width="4" height="4" rx=".6" fill="currentColor" stroke="none"/>', 16),
    lcc:    s('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>', 16)
  };

  function eyeSvg(on) {
    return on
      ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 12 1 12a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22"/></svg>';
  }

  function skinOn() { return document.documentElement.getAttribute('data-lxskin') === 'on'; }
  function viewer() { return window.__viewer || null; }
  function toast(m) { try { var el = document.getElementById('toast'); if (el) { el.textContent = m; el.classList.add('show'); setTimeout(function () { el.classList.remove('show'); }, 2200); return; } } catch (e) {} try { console.log('[LX]', m); } catch (e) {} }
  function clickBtn(id) { var b = document.getElementById(id); if (b) { b.click(); return true; } return false; }

  // =========================================================
  // 1) ГИЗМО ОСЕЙ + КНОПКА «ДОМ»
  // =========================================================
  function setView(axis) {
    var v = viewer();
    try {
      if (v && typeof v.setStandardView === 'function') { v.setStandardView({ x: 'right', y: 'top', z: 'front' }[axis] || axis); return true; }
      if (v && typeof v.setView === 'function') { v.setView(axis); return true; }
      if (v && typeof v.setCameraView === 'function') { v.setCameraView(axis); return true; }
      if (v && typeof v.viewAxis === 'function') { v.viewAxis(axis); return true; }
    } catch (e) {}
    toast('Вид: ' + axis.toUpperCase());
    return false;
  }

  function buildGizmo() {
    var stage = document.querySelector('.stage');
    if (!stage || document.getElementById('lxGizmo')) return;
    var g = document.createElement('div');
    g.id = 'lxGizmo';
    g.className = 'lx-gizmo';
    g.innerHTML =
      '<button class="lx-home" id="lxHome" title="Сбросить вид (домой)">' +
        s('<path d="M3 11l9-7 9 7"/><path d="M5 10v9h5v-5h4v5h5v-9"/>', 20) + '</button>' +
      '<div class="lx-cube" title="Оси X / Y / Z">' +
        '<svg viewBox="0 0 80 80" width="70" height="70">' +
          '<line x1="40" y1="44" x2="70" y2="52" stroke="#ff4d4d" stroke-width="2.4"/>' +
          '<line x1="40" y1="44" x2="12" y2="56" stroke="#4e4cff" stroke-width="2.4"/>' +
          '<line x1="40" y1="44" x2="40" y2="10" stroke="#4e4cff" stroke-width="2.4"/>' +
          '<circle cx="40" cy="44" r="3.2" fill="#e6e6e6"/>' +
          '<text class="lx-ax" data-ax="x" x="73" y="55" fill="#ff4d4d" font-size="13" font-weight="700" font-family="sans-serif">X</text>' +
          '<text class="lx-ax" data-ax="y" x="4" y="60" fill="#8ea0ff" font-size="13" font-weight="700" font-family="sans-serif">Y</text>' +
          '<text class="lx-ax" data-ax="z" x="36" y="9" fill="#8ea0ff" font-size="13" font-weight="700" font-family="sans-serif">Z</text>' +
        '</svg>' +
      '</div>';
    stage.appendChild(g);
    var home = g.querySelector('#lxHome');
    if (home) home.addEventListener('click', function () { if (!clickBtn('btnReset')) { var v = viewer(); try { if (v && v.resetView) v.resetView(); } catch (e) {} toast('Сброс вида'); } });
    g.querySelectorAll('.lx-ax').forEach(function (t) {
      t.style.cursor = 'pointer';
      t.addEventListener('click', function () { setView(t.getAttribute('data-ax')); });
    });
  }

  // =========================================================
  // 2) ТАЙТЛБАР
  // =========================================================
  function decorateTitlebar() {
    var tb = document.getElementById('titlebar');
    if (!tb || tb.dataset.lxdecor === '1') return;
    var winbtns = tb.querySelector('.tb-winbtns');
    var title = tb.querySelector('.tb-title');

    // логотип перед названием
    if (title && !tb.querySelector('.lx-tblogo')) {
      var logo = document.createElement('span');
      logo.className = 'lx-tblogo';
      logo.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 2l9 5v10l-9 5-9-5V7z" fill="none" stroke="#1f47ca" stroke-width="2"/><path d="M12 7l4.5 2.5v5L12 17l-4.5-2.5v-5z" fill="#1f47ca"/></svg>';
      title.parentNode.insertBefore(logo, title);
    }
    // меню «Настройки» после названия
    if (title && !tb.querySelector('.lx-tbmenu')) {
      var menu = document.createElement('span');
      menu.className = 'lx-tbmenu';
      menu.textContent = 'Настройки';
      menu.title = 'Настройки';
      menu.addEventListener('click', function () { if (!clickBtn('btnSettings')) toast('Настройки'); });
      var ref = tb.querySelector('.tb-room') || title.nextSibling;
      title.parentNode.insertBefore(menu, title.nextSibling);
    }
    // центральный заголовок проекта
    if (!tb.querySelector('.lx-tbcenter')) {
      var c = document.createElement('div');
      c.className = 'lx-tbcenter';
      var rt = document.getElementById('roomTitle');
      c.textContent = (rt && rt.textContent && rt.textContent.trim()) || 'Обработка проекта';
      tb.appendChild(c);
    }
    // правый кластер: тема + авторизация (перед кнопками окна)
    if (winbtns && !tb.querySelector('.lx-tbright')) {
      var right = document.createElement('div');
      right.className = 'lx-tbright';
      var theme = document.createElement('button');
      theme.className = 'lx-tbtheme';
      theme.title = 'Переключить тему';
      theme.innerHTML = s('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/>', 16);
      theme.addEventListener('click', function () {
        var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        if (window.__bimSetTheme) window.__bimSetTheme(next);
      });
      var auth = document.createElement('span');
      auth.className = 'lx-tbauth';
      auth.textContent = 'Не авторизовано';
      right.appendChild(theme);
      right.appendChild(auth);
      winbtns.parentNode.insertBefore(right, winbtns);
    }
    tb.dataset.lxdecor = '1';
  }

  // =========================================================
  // 3) ДЕРЕВО: SVG-иконки + узел LCC
  // =========================================================
  function decorateTree() {
    var host = document.getElementById('lxScene');
    if (!host) return;
    // замена emoji-иконок на SVG
    host.querySelectorAll('.lx-node[data-layer]').forEach(function (n) {
      var id = n.getAttribute('data-layer');
      var ico = n.querySelector('.lx-ico');
      if (ico && TICO[id] && ico.getAttribute('data-lxsvg') !== '1') {
        ico.innerHTML = TICO[id];
        ico.setAttribute('data-lxsvg', '1');
        ico.classList.add('lx-svgico');
      }
    });
    // узел LCC после «Векторные данные» (декоративный)
    if (!host.querySelector('[data-layer="lcc"]')) {
      var vec = host.querySelector('.lx-node[data-layer="vector"]');
      if (vec) {
        var lccOn = true;
        try { lccOn = localStorage.getItem('bim.lixel.lcc.v1085') !== '0'; } catch (e) {}
        var d = document.createElement('div');
        d.className = 'lx-node lx-lcc';
        d.setAttribute('data-layer', 'lcc');
        d.innerHTML =
          '<span class="lx-tw"></span>' +
          '<span class="lx-ico lx-svgico" data-lxsvg="1">' + TICO.lcc + '</span>' +
          '<span class="lx-nm">LCC</span>' +
          '<span class="lx-badge">3DGS</span>' +
          '<button class="lx-eye' + (lccOn ? ' on' : '') + '" data-lxeye="lcc" title="Показать/скрыть">' + eyeSvg(lccOn) + '</button>';
        vec.parentNode.insertBefore(d, vec.nextSibling);
        var eb = d.querySelector('[data-lxeye]');
        if (eb) { eb.disabled = true; eb.title = 'Видимость LCC пока не подключена'; }
        if (eb) eb.addEventListener('click', function (e) {
          e.stopPropagation();
          var on = !eb.classList.contains('on');
          eb.classList.toggle('on', on);
          eb.innerHTML = eyeSvg(on);
          try { localStorage.setItem('bim.lixel.lcc.v1085', on ? '1' : '0'); } catch (e2) {}
        });
      }
    }
  }

  // =========================================================
  function applyAll() {
    if (!skinOn()) return;
    try { buildGizmo(); } catch (e) {}
    try { decorateTitlebar(); } catch (e) {}
    try { decorateTree(); } catch (e) {}
  }

  var pending = null;
  function schedule() { if (pending) return; pending = setTimeout(function () { pending = null; applyAll(); }, 60); }

  function boot() {
    applyAll();
    try {
      var mo = new MutationObserver(function () { schedule(); });
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-lxskin'] });
    } catch (e) {}
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__lxShell = { applyAll: applyAll, buildGizmo: buildGizmo, decorateTitlebar: decorateTitlebar, decorateTree: decorateTree, TICO: TICO };
})();
