/* ============================================================
   LixelStudio-style left viewport toolbar + window tab + version tag
   BIM Twin v1083.  Self-contained additive module (no deps on the
   existing lixel-ui IIFE).  Reproduces the floating vertical tool
   column on the left edge of the 3D view, the «Окно 0» viewport tab
   (top-left) and the «Версия ПО» tag (bottom-right), exactly as in
   LixelStudio 4.0.1.6.  Activates only under html[data-lxskin="on"].
   ============================================================ */
(function () {
  'use strict';

  var SW_VERSION = '1.1.17 · review v10.1';

  // SVG line icons (22×22, stroke=currentColor) matching LixelStudio glyphs
  var IC = {
    nav: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3 4h-6z"/><path d="M12 22l-3-4h6z"/><path d="M2 12l4-3v6z"/><path d="M22 12l-4 3v-6z"/><circle cx="12" cy="12" r="2.3"/></svg>',
    measure: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19V5h4v14z"/><path d="M5 19h14v-4H5"/><path d="M9 8H7M9 11H7M9 14H7M12 15v2M15 15v2M18 15v2"/></svg>',
    grid: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>',
    edl: '<svg viewBox="0 0 24 24" width="22" height="22"><text x="12" y="11" text-anchor="middle" font-size="8" font-weight="700" fill="currentColor" font-family="sans-serif">EDL</text><text x="12" y="20" text-anchor="middle" font-size="9" font-weight="700" fill="currentColor" font-family="sans-serif">+</text></svg>',
    xray: '<svg viewBox="0 0 24 24" width="22" height="22"><text x="12" y="15" text-anchor="middle" font-size="8" font-weight="700" fill="currentColor" font-family="sans-serif">X-ray</text></svg>',
    section: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8l8-4 8 4-8 4z"/><path d="M4 8v8l8 4V12"/><path d="M20 8v8l-8 4"/></svg>',
    full: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>'
  };

  // Tool column: id, icon, title, and the existing action to trigger
  var TOOLS = [
    { id: 'nav',     ic: 'nav',     title: 'Навигация / сброс вида', btn: 'btnReset' },
    { id: 'measure', ic: 'measure', title: 'Измерение',              btn: 'btnMeasure' },
    { id: 'grid',    ic: 'grid',    title: 'Сетка / масштаб',        btn: 'btnLOD' },
    { id: 'edl',     ic: 'edl',     title: 'EDL-затенение (глубина)', act: 'edl' },
    { id: 'xray',    ic: 'xray',    title: 'Рентген / прозрачность', act: 'xray' },
    { id: 'section', ic: 'section', title: 'Сечение (бокс)',      btn: 'btnSection' },
    { id: 'full',    ic: 'full',    title: 'Полный экран',            act: 'full' }
  ];

  function viewer() { return window.__viewer || null; }
  function toast(m) {
    try { var el = document.getElementById('toast'); if (el) { el.textContent = m; el.classList.add('show'); setTimeout(function () { el.classList.remove('show'); }, 2200); return; } } catch (e) {}
    try { console.log('[LX]', m); } catch (e) {}
  }

  function clickBtn(id) {
    var b = document.getElementById(id);
    if (b) { b.click(); return true; }
    return false;
  }

  function doAct(t, el) {
    if (window.__lxWorkspace) { window.__lxWorkspace.toolbarAction(t, el); return; }
    // toggle visual active state for stateful tools
    if (t.id === 'measure' || t.id === 'section' || t.id === 'edl' || t.id === 'xray' || t.id === 'grid') {
      el.classList.toggle('active');
    }
    if (t.btn) {
      if (clickBtn(t.btn)) return;
    }
    var v = viewer();
    if (t.act === 'edl') {
      try {
        if (v && typeof v.setEDL === 'function') { v.setEDL(el.classList.contains('active')); return; }
        if (v && typeof v.setGrade === 'function') { toast('EDL: затенение по глубине ' + (el.classList.contains('active') ? 'вкл' : 'выкл')); return; }
      } catch (e) {}
      toast('EDL: затенение по глубине');
    } else if (t.act === 'xray') {
      try { if (v && typeof v.setXray === 'function') { v.setXray(el.classList.contains('active')); return; } } catch (e) {}
      toast('Рентген / прозрачность');
    } else if (t.act === 'full') {
      try {
        var stage = document.querySelector('.stage');
        if (!document.fullscreenElement && stage && stage.requestFullscreen) stage.requestFullscreen();
        else if (document.exitFullscreen) document.exitFullscreen();
      } catch (e) { toast('Полный экран'); }
    } else {
      toast(t.title);
    }
  }

  function build() {
    if (document.documentElement.getAttribute('data-lxskin') !== 'on') return;
    var stage = document.querySelector('.stage');
    if (!stage) return;
    if (document.getElementById('lxLtbar')) return;

    // Left vertical tool column
    var bar = document.createElement('div');
    bar.className = 'lx-ltbar';
    bar.id = 'lxLtbar';
    TOOLS.forEach(function (t) {
      var el = document.createElement('button');
      el.className = 'lx-ltbtn';
      el.type = 'button';
      el.dataset.tool = t.id;
      el.title = t.title;
      el.innerHTML = IC[t.ic] || '';
      el.addEventListener('click', function () { doAct(t, el); });
      bar.appendChild(el);
    });
    stage.appendChild(bar);

    // «Окно 0» viewport tab (top-left)
    if (!document.getElementById('lxWinTab')) {
      var wt = document.createElement('div');
      wt.className = 'lx-wintab';
      wt.id = 'lxWinTab';
      wt.textContent = 'Окно 0';
      stage.appendChild(wt);
    }

    // «Версия ПО» tag (bottom-right)
    if (!document.getElementById('lxVerTag')) {
      var vt = document.createElement('div');
      vt.className = 'lx-vertag';
      vt.id = 'lxVerTag';
      vt.innerHTML = '<span class="lx-vt-ic">ⓘ</span> Версия ПО:' + SW_VERSION;
      stage.appendChild(vt);
      // Prefer the package's actual Electron version, not the stale mock version
      // that used to be hardcoded in this visual toolbar.
      try {
        if (window.bimAPI && typeof window.bimAPI.getVersion === 'function') {
          window.bimAPI.getVersion().then(function (version) {
            if (!version || !document.getElementById('lxVerTag')) return;
            SW_VERSION = String(version) + ' · review v10.1';
            document.getElementById('lxVerTag').innerHTML = '<span class="lx-vt-ic">ⓘ</span> Версия ПО:' + SW_VERSION;
          }).catch(function () {});
        }
      } catch (e) {}
    }
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', function () { setTimeout(build, 30); });
  else setTimeout(build, 30);

  // Re-build if the skin turns on later
  try {
    var mo = new MutationObserver(function () { if (document.documentElement.getAttribute('data-lxskin') === 'on') build(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-lxskin'] });
  } catch (e) {}

  window.__lxToolbar = { build: build, TOOLS: TOOLS, version: SW_VERSION };
})();
