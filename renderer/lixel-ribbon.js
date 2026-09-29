/* ============================================================
   LixelStudio-style ribbon buttons for BIM Twin — v1084.
   Self-contained additive module: превращает текстовые
   кнопки верхней ленты в «большие» вертикальные (иконка
   сверху + подпись снизу), как в LixelStudio 4.0.1.6.
   Меняет только innerHTML кнопок — обработчики на самих
   элементах сохраняются. Активен под html[data-lxskin="on"].
   ============================================================ */
(function () {
  'use strict';

  // Монохромные линейные иконки (24×24, stroke=currentColor)
  function svg(inner) {
    return '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }
  var ICON = {
    cloudOpen: svg('<path d="M6 16a4 4 0 0 1 .5-8 5 5 0 0 1 9.6 1.3A3.5 3.5 0 0 1 18 16z"/><path d="M12 12v6m0 0l-2.2-2.2M12 18l2.2-2.2"/>'),
    ifc: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 8v6m0 0l-2.5-2.5M12 14l2.5-2.5"/>'),
    model: svg('<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 12l9-5M12 12v10M12 12L3 7"/>'),
    doc: svg('<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v4h4M9 13h6M9 17h6M9 9h3"/>'),
    ai: svg('<path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/><path d="M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z"/>'),
    verify: svg('<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>'),
    reset: svg('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4h4"/>'),
    compare: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" opacity=".28"/>'),
    section: svg('<path d="M4 8l8-4 8 4-8 4z"/><path d="M4 8v8l8 4V12M20 8v8l-8 4"/><path d="M2 14h20" stroke-dasharray="2 2"/>'),
    measure: svg('<path d="M5 19V5h4v14z"/><path d="M5 19h14v-4H5"/><path d="M9 8H7M9 11H7M9 14H7M12 15v2M15 15v2M18 15v2"/>'),
    isolate: svg('<circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>'),
    lod: svg('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5M3 17l9 5 9-5"/>'),
    edit: svg('<path d="M4 20l4-1L20 7l-3-3L5 16z"/><path d="M14 6l3 3"/>'),
    settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.3l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2.2-1.3L14 2h-4l-.4 2.5a7 7 0 0 0-2.2 1.3l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.3l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2.2 1.3L10 22h4l.4-2.5a7 7 0 0 0 2.2-1.3l2.3 1 2-3.4-2-1.5A7 7 0 0 0 19 12z"/>'),
    backup: svg('<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>'),
    back: svg('<path d="M15 5l-7 7 7 7"/>'),
    tour: svg('<path d="M4 12a8 8 0 1 1 16 0 8 8 0 0 1-16 0z"/><path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none"/>')
  };

  ICON.floor  = svg('<path d="M3 8l9-4 9 4-9 4z"/><path d="M3 13l9 4 9-4"/>');
  ICON.isoObj = svg('<rect x="5" y="5" width="14" height="14" rx="1"/><path d="M9 9h6v6H9z" fill="currentColor" stroke="none" opacity=".3"/>');
  ICON.slice  = svg('<path d="M4 7h16M4 12h16M4 17h16" stroke-dasharray="3 2"/><path d="M4 4v16"/>');
  ICON.attach = svg('<path d="M8 12l6-6a3 3 0 0 1 4 4l-7 7a4 4 0 0 1-6-6l7-7"/>');
  ICON.note   = svg('<path d="M4 5h16v11H9l-4 3z"/><path d="M12 8v3M12 13v.5"/>');
  ICON.report = svg('<path d="M6 2h9l3 3v17H6z"/><path d="M9 12h6M9 16h6M9 8h3"/>');
  ICON.lcc    = svg('<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>');
  ICON.tool   = svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>');

  // Кнопки вкладки «Объект» без id — сопоставление по тексту
  var LABELMAP = [
    { kw: 'Этаж', icon: 'floor', label: 'Этаж' },
    { kw: 'Изоляция', icon: 'isoObj', label: 'Изоляция' },
    { kw: 'Нарезка', icon: 'slice', label: 'Нарезка' },
    { kw: 'Прикрепить', icon: 'attach', label: 'Прикрепить' },
    { kw: 'Замечание', icon: 'note', label: 'Замечание' },
    { kw: 'Отчёт', icon: 'report', label: 'Отчёт' }
  ];

  // id кнопки -> { icon, label, primary? }
  var MAP = {
    btnOpenCloud: { icon: 'cloudOpen', label: 'Открыть облако', primary: true },
    ifcInput:     { icon: 'ifc',       label: 'Импорт IFC', forLabel: true },
    modelInput:   { icon: 'model',     label: 'Модель', forLabel: true },
    docInput:     { icon: 'doc',       label: 'Документ', forLabel: true },
    btnAI:        { icon: 'ai',        label: 'Подсветка НС' },
    btnVerify:    { icon: 'verify',    label: 'Проверить НС', primary: true },
    btnReset:     { icon: 'reset',     label: 'Сброс вида' },
    btnCompare:   { icon: 'compare',   label: 'Сравнить' },
    btnSection:   { icon: 'section',   label: 'Сечение' },
    btnMeasure:   { icon: 'measure',   label: 'Измерение' },
    btnIsolate:   { icon: 'isolate',   label: 'Изоляция' },
    btnLOD:       { icon: 'lod',       label: 'LOD' },
    btnEdit:      { icon: 'edit',      label: 'Правка' },
    btnSettings:  { icon: 'settings',  label: 'Настройки' },
    btnBackup:    { icon: 'backup',    label: 'Бэкап' },
    btnBackRoom:  { icon: 'back',      label: 'К помещению' },
    tsSplatTop:   { icon: 'tour',      label: '3DGS-тур' },
    tsSplatLcc2:  { icon: 'lcc',       label: 'LCC2' }
  };

  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]; }); }

  function decorate(el, spec) {
    if (!el || (el.dataset.lxbig === '1' && el.querySelector('.lx-bic'))) return;
    var icon = ICON[spec.icon] || '';
    el.innerHTML = '<span class="lx-bic">' + icon + '</span><span class="lx-blabel">' + esc(spec.label) + '</span>';
    el.classList.add('lx-bigbtn');
    if (spec.primary) el.classList.add('lx-primary');
    el.dataset.lxbig = '1';
    if (!el.title) el.title = spec.label;
  }

  // Подбор иконки по тексту/подсказке для кнопок без явной карты.
  function guessIcon(txt) {
    var t = (txt || '').toLowerCase();
    if (t.indexOf('lcc') >= 0) return 'lcc';
    if (t.indexOf('тур') >= 0 || t.indexOf('3dgs') >= 0 || t.indexOf('splat') >= 0) return 'tour';
    if (t.indexOf('облак') >= 0) return 'cloudOpen';
    if (t.indexOf('ifc') >= 0) return 'ifc';
    if (t.indexOf('модел') >= 0) return 'model';
    if (t.indexOf('документ') >= 0) return 'doc';
    if (t.indexOf('сеч') >= 0) return 'section';
    if (t.indexOf('измер') >= 0) return 'measure';
    if (t.indexOf('настрой') >= 0) return 'settings';
    if (t.indexOf('сброс') >= 0 || t.indexOf('вид') >= 0) return 'reset';
    if (t.indexOf('сравн') >= 0) return 'compare';
    if (t.indexOf('правк') >= 0) return 'edit';
    return 'tool';
  }

  function build() {
    if (document.documentElement.getAttribute('data-lxskin') !== 'on') return;
    var tb = document.querySelector('.toolbar .tbtns');
    if (!tb) return;
    Object.keys(MAP).forEach(function (id) {
      var spec = MAP[id];
      var el = spec.forLabel ? document.querySelector('label[for="' + id + '"]') : document.getElementById(id);
      if (el) decorate(el, spec);
    });
    // Вкладка «Объект»: большие кнопки с SVG-иконками (по тексту)
    var objBtns = tb.querySelectorAll('.tgroup[data-lxtab="object"] .btn');
    Array.prototype.forEach.call(objBtns, function (b) {
      if (b.dataset.lxbig === '1') return;
      var txt = b.textContent || '';
      for (var i = 0; i < LABELMAP.length; i++) {
        if (txt.indexOf(LABELMAP[i].kw) >= 0) { decorate(b, { icon: LABELMAP[i].icon, label: LABELMAP[i].label }); break; }
      }
    });
    // Гарантируем иконку и единый размер ЛЮБОЙ оставшейся кнопке ленты (ровные ряды, без «голых» кнопок).
    var rest = tb.querySelectorAll('.tgroup .btn, .tgroup label.btn');
    Array.prototype.forEach.call(rest, function (b) {
      if (b.dataset.lxbig === '1') return;
      if (b.id === 'btnBackRoom' || b.id === 'btnBackup') return; // скрытые служебные
      var raw = (b.textContent || '').trim();
      var label = raw.replace(/^[^0-9A-Za-zА-Яа-яЁё]+/, '').trim() || (b.title || 'Кнопка').trim();
      decorate(b, { icon: guessIcon(raw + ' ' + (b.title || '')), label: label });
    });
    // помечаем контейнер, чтобы CSS применился ко всей ленте
    tb.classList.add('lx-bigribbon');
  }

  function boot() { setTimeout(build, 60); }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
  else boot();

  try {
    var mo = new MutationObserver(function () { if (document.documentElement.getAttribute('data-lxskin') === 'on') build(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-lxskin'] });
  } catch (e) {}

  window.__lxRibbon = { build: build, MAP: MAP, ICON: ICON };
})();
// v1091: Новые иконки для спринтов 0–7
// v1153: иконка LCC2 + fallback-иконка для любых кнопок ленты (ровные ряды, все с иконками).
