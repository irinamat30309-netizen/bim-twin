/* ============================================================
   LixelStudio-style UI controller for BIM Twin (v1080)
   Аддитивный: строит верхнюю ленту вкладок над тулбаром,
   распределяет существующие группы кнопок по вкладкам (без потери
   обработчиков), добавляет вкладку «Объект» (Этажи + Документация),
   нижнюю строку X/Y/Z и заголовок «Управление данными».
   ============================================================ */
(function () {
  'use strict';
  var TABS = [
    { id: 'home',    label: 'Главная страница' },
    { id: 'process', label: 'Обработка проекта' },
    { id: 'tool',    label: 'Инструмент' },
    { id: 'draw',    label: 'Рисование плоскости' },
    { id: 'object',  label: 'Объект', star: true },
    { id: 'app',     label: 'Приложение' }
  ];
  // Соответствие: id кнопки внутри группы -> вкладка
  var GROUP_MAP = [
    { tab: 'home',    ids: ['btnOpenCloud', 'ifcInput', 'modelInput', 'docInput'] },
    { tab: 'process', ids: ['btnEdit', 'btnBackup', 'btnBackRoom', 'tsSplatTop'] },
    { tab: 'tool',    ids: ['btnReset', 'btnCompare', 'btnSection', 'btnMeasure', 'btnIsolate', 'btnLOD'] },
    { tab: 'app',     ids: ['btnAI', 'btnVerify', 'btnSettings'] }
  ];

  function toast(msg) {
    try {
      var el = document.getElementById('toast');
      if (el) { el.textContent = msg; el.classList.add('show'); setTimeout(function () { el.classList.remove('show'); }, 2600); return; }
    } catch (e) {}
    try { console.log('[LX]', msg); } catch (e) {}
  }

  function classifyGroup(group) {
    for (var i = 0; i < GROUP_MAP.length; i++) {
      var m = GROUP_MAP[i];
      for (var j = 0; j < m.ids.length; j++) {
        if (group.querySelector('#' + m.ids[j])) return m.tab;
      }
    }
    return 'home';
  }

  function makeBtn(label, title, onClick) {
    var b = document.createElement('button');
    b.className = 'btn';
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function makeGroup(tab, title, extraClass) {
    var g = document.createElement('div');
    g.className = 'tgroup' + (extraClass ? ' ' + extraClass : '');
    g.dataset.lxtab = tab;
    var lab = document.createElement('div');
    lab.className = 'tglabel';
    lab.textContent = title;
    var row = document.createElement('div');
    row.className = 'tgrow';
    g.appendChild(lab); g.appendChild(row);
    g._row = row;
    return g;
  }

  function build() {
    var html = document.documentElement;
    html.setAttribute('data-lxskin', 'on');

    var center = document.querySelector('.center');
    var toolbar = document.querySelector('.toolbar');
    var tbtns = document.querySelector('.toolbar .tbtns');
    if (!center || !toolbar || !tbtns) return;

    // 1) Распределяем существующие группы по вкладкам
    var groups = tbtns.querySelectorAll('.tgroup');
    for (var i = 0; i < groups.length; i++) {
      if (!groups[i].dataset.lxtab) groups[i].dataset.lxtab = classifyGroup(groups[i]);
    }

    // 2) Новая вкладка «Объект» — Этажи + Документация
    if (!tbtns.querySelector('[data-lxtab="object"]')) {
      var gFloors = makeGroup('object', 'Этажи', 'lx-newgroup');
      gFloors._row.appendChild(makeBtn('＋ Этаж', 'Создать этаж (диапазон высот)', function () { if (window.__lxScene) window.__lxScene.addFloor(); else openFloorsPanel(); }));
      gFloors._row.appendChild(makeBtn('◈ Изоляция', 'Показать только выбранный этаж', function () { if (window.__lxScene) window.__lxScene.isolateActive(); else toast('Выберите этаж в дереве справа'); }));
      gFloors._row.appendChild(makeBtn('⬍ Нарезка', 'Авто-нарезка по этажам по высоте', function () { if (window.__lxScene) window.__lxScene.autoSlice(); else toast('Авто-нарезка по этажам'); }));
      tbtns.appendChild(gFloors);

      var gDocs = makeGroup('object', 'Документация', 'lx-newgroup');
      gDocs._row.appendChild(makeBtn('📎 Прикрепить', 'Прикрепить документ к этажу', function () { if (window.__lxScene) window.__lxScene.attachDoc(); else { var di = document.getElementById('docInput'); if (di) di.click(); } }));
      gDocs._row.appendChild(makeBtn('⚑ Замечание', 'Добавить замечание к этажу', function () { if (window.__lxScene) window.__lxScene.attachDoc(); else toast('Выберите этаж'); }));
      gDocs._row.appendChild(makeBtn('📄 Отчёт', 'Отчёт по этажу', function () { if (window.__lxScene) window.__lxScene.report(); else { var e = document.getElementById('btnExport'); if (e) e.click(); } }));
      tbtns.appendChild(gDocs);
    }

    // 3) Вкладка «Рисование плоскости» — плейсхолдер (Спринт 1)
    if (!tbtns.querySelector('[data-lxtab="draw"]')) {
      var gDraw = makeGroup('draw', '2D-черчение по облаку', 'lx-newgroup');
      var soon = document.createElement('div');
      soon.className = 'lx-soon';
      soon.innerHTML = '<b>Скоро (Спринт 1):</b> черчение линий/полилиний по облаку с привязкой, рентген/орто-проекция сверху и экспорт DXF.';
      gDraw._row.appendChild(soon);
      tbtns.appendChild(gDraw);
    }

    // 4) Строим ленту вкладок над тулбаром
    var tabsEl = document.createElement('div');
    tabsEl.className = 'lx-tabs';
    tabsEl.id = 'lxTabs';
    TABS.forEach(function (t) {
      var el = document.createElement('div');
      el.className = 'lx-tab';
      el.dataset.tab = t.id;
      el.textContent = t.label;
      if (t.star) { var s = document.createElement('span'); s.className = 'lx-star'; s.textContent = '★'; el.appendChild(s); }
      el.addEventListener('click', function () { activate(t.id); });
      tabsEl.appendChild(el);
    });
    center.insertBefore(tabsEl, toolbar);

    // 5) Нижняя строка координат X/Y/Z
    buildStatusBar();

    // 6) Заголовок «Управление данными» в правой панели
    var insp = document.querySelector('.inspector');
    if (insp && !insp.querySelector('.lx-datahdr')) {
      var hdr = document.createElement('div');
      hdr.className = 'lx-datahdr';
      hdr.innerHTML = '<span class="lx-dot"></span> Управление данными';
      insp.insertBefore(hdr, insp.firstChild);
    }

    activate('home');
    hookCoords();
  }

  function activate(tabId) {
    var tabs = document.querySelectorAll('.lx-tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].dataset.tab === tabId);
    var groups = document.querySelectorAll('.toolbar .tbtns .tgroup');
    for (var j = 0; j < groups.length; j++) {
      groups[j].dataset.lxhidden = (groups[j].dataset.lxtab === tabId) ? '0' : '1';
    }
  }

  function openFloorsPanel() {
    toast('Этажи: создание/диапазон высот — подключаем к дереву данных');
  }

  // ---- Нижняя строка ----
  function buildStatusBar() {
    if (document.getElementById('lxStatus')) return;
    var bar = document.createElement('div');
    bar.className = 'lx-status';
    bar.id = 'lxStatus';
    bar.innerHTML =
      '<span class="lx-cell lx-x"><span class="lx-axis">X</span><span class="lx-val" id="lxX">—</span></span>' +
      '<span class="lx-cell lx-y"><span class="lx-axis">Y</span><span class="lx-val" id="lxY">—</span></span>' +
      '<span class="lx-cell lx-z"><span class="lx-axis">Z</span><span class="lx-val" id="lxZ">—</span></span>' +
      '<span class="lx-spacer"></span>' +
      '<span class="lx-info" id="lxInfo">СК: локальная · ед.: м</span>';
    var app = document.querySelector('.app');
    if (app && app.parentNode) app.parentNode.insertBefore(bar, app.nextSibling);
    else document.body.appendChild(bar);
  }

  function setCoords(x, y, z) {
    var ex = document.getElementById('lxX'), ey = document.getElementById('lxY'), ez = document.getElementById('lxZ');
    if (ex) ex.textContent = (x == null) ? '—' : (+x).toFixed(3);
    if (ey) ey.textContent = (y == null) ? '—' : (+y).toFixed(3);
    if (ez) ez.textContent = (z == null) ? '—' : (+z).toFixed(3);
  }
  // Глобальный хук: вьюер может вызывать window.__lxSetCoords(x,y,z)
  window.__lxSetCoords = setCoords;

  function hookCoords() {
    // Зеркалим координаты из ридаута измерений (X/Y/Z в метрах)
    var ro = document.getElementById('measureReadout');
    if (!ro) return;
    var rx = /X[:=]\s*(-?\d+(?:[.,]\d+)?)/i, ry = /Y[:=]\s*(-?\d+(?:[.,]\d+)?)/i, rz = /Z[:=]\s*(-?\d+(?:[.,]\d+)?)/i;
    function parse() {
      var s = ro.textContent || '';
      var mx = s.match(rx), my = s.match(ry), mz = s.match(rz);
      if (mx || my || mz) {
        setCoords(mx ? mx[1].replace(',', '.') : null, my ? my[1].replace(',', '.') : null, mz ? mz[1].replace(',', '.') : null);
      }
    }
    try { new MutationObserver(parse).observe(ro, { childList: true, subtree: true, characterData: true }); } catch (e) {}
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', function () { setTimeout(build, 0); });
  else setTimeout(build, 0);
})();
