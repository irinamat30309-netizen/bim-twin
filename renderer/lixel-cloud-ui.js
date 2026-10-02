/* Свойства активного облака точек и его запись в дереве сцены.
 * Одно резидентное облако: без мнимого менеджера нескольких облаков.
 * Панель живёт на вкладке «Сцена» справа, меню действий — общий всплывающий список ui/kit.js. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const V = () => window.__viewer || window.__lxViewer;
  const D = window.CloudDisplay;
  const kit = () => window.__lxKit;
  const ico = (name, size) => '<span data-ico="' + name + '" data-ico-size="' + (size || 16) + '" aria-hidden="true"></span>';
  const PALETTES = ['rainbow', 'gray', 'warm'];
  const GRADIENTS = [
    'linear-gradient(90deg,#000080,#0080ff,#00ff80,#ffff00,#800000)',
    'linear-gradient(90deg,#000,#fff)',
    'linear-gradient(90deg,#ff0,#f00)'
  ];
  let histKey = null, hist = null, lastSource = null, entriesOpen = true;

  function closeMenu(focus) {
    if (!$('lxCloudMenu')) return false;
    return !!(kit() && kit().closePopover(focus));
  }
  function select(reveal) {
    const chrome = window.__lxChrome;
    if (chrome && chrome.showPane) chrome.showPane('scene', { reveal: !!reveal, persist: false });
    const p = $('lxCloudProperties');
    if (p && p.scrollIntoView) p.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function openMenu(anchor) {
    const v = V(), info = v && v.getCloudInfo && v.getCloudInfo(), streaming = !!(info && info.streaming);
    const items = [
      { id: 'cpVisibility', label: 'Показать / скрыть', ico: 'eye', onClick: () => V().setCloudVisible(V().cloudVisible === false) },
      { id: 'cpFit', label: 'Вписать в окно', ico: 'maximize', onClick: () => V().resetView() },
      { id: 'cpEdit', label: 'Правка точек', ico: 'brush', disabled: streaming, tip: streaming ? 'Недоступно в потоковом режиме' : '', onClick: () => { if (!V().editSelect) { const b = $('vtEdit'); if (b) b.click(); } } },
      { id: 'cpSave', label: 'Сохранить копию PLY', ico: 'save', disabled: streaming, tip: streaming ? 'Недоступно в потоковом режиме' : '', onClick: () => { const b = $('edSave'); if (b) b.click(); } },
      { sep: true },
      { id: 'cpReset', label: 'Сбросить отображение', ico: 'rotate-ccw', onClick: resetDisplay }
    ];
    kit().menu(anchor, items, { id: 'lxCloudMenu', align: 'end', minWidth: 220 });
  }
  function resetDisplay() {
    const v = V(), b = v.bbox;
    v.setCloudPointSize(1); v.setCloudOpacity(1); v.setColorMode('rgb'); v.setCloudHideOutside(false);
    v.setCloudHeightRange(b.mn[1], b.mx[1]); v.setCloudPalette('rainbow'); v.setBrightness(1); v.setGrade(false); v.setCloudVisible(true);
  }

  function mount() {
    const scene = $('lxScene');
    if (!scene) return;
    if ($('lxCloudProperties')) return;
    const panel = document.createElement('section');
    panel.id = 'lxCloudProperties'; panel.className = 'lx-props'; panel.setAttribute('aria-label', 'Свойства облака');
    panel.innerHTML =
      '<div class="lx-props-head"><span>Свойства облака</span><span class="lx-type-badge">POINT CLOUD</span></div>' +
      '<div id="lxCloudEmpty" class="lx-cloud-empty">Откройте облако точек — здесь появятся имя файла и параметры отображения.</div>' +
      '<div id="lxCloudFields" hidden>' +
      '<div class="lx-cloud-name"><span id="cpName"></span><button type="button" id="lxCloudMore" class="icon-btn sm" data-ico="ellipsis" title="Действия с облаком" aria-label="Действия с облаком" aria-haspopup="menu" aria-expanded="false"></button></div>' +
      '<label class="lx-cp-row"><span>Размер точки</span><input id="cpSize" aria-label="Размер точки, пиксели" type="range" min="1" max="10" step=".1"><input id="cpSizeNum" aria-label="Точный размер точки, пиксели" type="number" min="1" max="10" step=".1"></label>' +
      '<div class="lx-cp-scale"><span>1 px</span><span>10 px</span></div>' +
      '<label class="lx-cp-row" title="0 — невидимое облако, 1 — полностью непрозрачное. Экранная маска без сортировки миллионов точек."><span>Непрозрачность</span><input id="cpOpacity" aria-label="Непрозрачность" type="range" min="0" max="1" step=".01"><input id="cpOpacityNum" aria-label="Точная непрозрачность" type="number" min="0" max="1" step=".01"></label>' +
      '<div class="lx-cp-scale"><span>0.00</span><span>1.00</span></div>' +
      '<label class="lx-cp-select"><span>Отображение</span><select id="cpMode"><option value="rgb">RGB</option><option value="elev">Высота</option></select></label>' +
      '<div id="cpHeight" hidden>' +
      '<label class="lx-cp-select"><span>Палитра</span><select id="cpPalette"><option value="rainbow">Спектр</option><option value="gray">Серая</option><option value="warm">Жёлтый → красный</option></select></label>' +
      '<div id="cpGradient" aria-hidden="true"></div><svg id="cpHistogram" viewBox="0 0 256 68" role="img" aria-label="Распределение точек по локальной высоте Y"></svg>' +
      '<div class="lx-height-ranges"><input id="cpMinRange" aria-label="Нижняя граница высоты" type="range" step="any"><input id="cpMaxRange" aria-label="Верхняя граница высоты" type="range" step="any"></div>' +
      '<div class="lx-height-numbers"><label>Начало<input id="cpMin" type="number" step=".001"></label><label>Конец<input id="cpMax" type="number" step=".001"></label><button type="button" id="cpRangeReset" data-ico="rotate-ccw" data-ico-size="15" title="Полный диапазон высот" aria-label="Полный диапазон высот"></button></div>' +
      '<label class="lx-cp-check"><input id="cpHide" type="checkbox">Скрыть точки вне диапазона</label><div id="cpHistNote" class="lx-cp-note"></div>' +
      '</div>' +
      '<div id="cpError" role="alert"></div>' +
      '<dl class="lx-cloud-stats"><dt>В исходном файле</dt><dd id="cpTotal"></dd><dt>Загружено точек</dt><dd id="cpLoaded"></dd></dl>' +
      '<div id="cpShareNote" class="lx-cp-note" hidden></div>' +
      '<div class="lx-cp-caption">Габариты загруженных точек, м</div><div id="cpDimensions"></div>' +
      '<div class="lx-cp-note">Локальные оси · Y — высота</div><div id="cpColorNote" class="lx-cp-note"></div>' +
      '</div>';
    scene.after(panel);
    if (kit()) kit().hydrate(panel);
    $('lxCloudMore').onclick = e => { e.stopPropagation(); if ($('lxCloudMenu')) closeMenu(); else openMenu($('lxCloudMore')); };
    const bindPair = (slider, num, method) => {
      for (const id of [slider, num]) {
        $(id).addEventListener(id === num ? 'change' : 'input', () => {
          if ($(id).value === '') { sync(); return; }
          try { V()[method]($(id).value); $('cpError').textContent = ''; sync(); } catch (e) { $('cpError').textContent = e.message; }
        });
      }
    };
    bindPair('cpSize', 'cpSizeNum', 'setCloudPointSize');
    bindPair('cpOpacity', 'cpOpacityNum', 'setCloudOpacity');
    $('cpMode').onchange = () => V().setColorMode($('cpMode').value);
    $('cpPalette').onchange = () => V().setCloudPalette($('cpPalette').value);
    $('cpHide').onchange = () => V().setCloudHideOutside($('cpHide').checked);
    for (const id of ['cpMin', 'cpMax', 'cpMinRange', 'cpMaxRange']) {
      $(id).addEventListener(id.endsWith('Range') ? 'input' : 'change', () => {
        const v = V(), d = v.getCloudInfo().display;
        const a = id === 'cpMinRange' ? Math.min(Number($(id).value), d.max) : Number($('cpMin').value);
        const b = id === 'cpMaxRange' ? Math.max(Number($(id).value), d.min) : Number($('cpMax').value);
        try {
          if ($('cpMin').value === '' || $('cpMax').value === '') throw new Error('Укажите обе границы диапазона');
          v.setCloudHeightRange(a, b); $('cpError').textContent = ''; sync();
        } catch (e) { $('cpError').textContent = e.message; }
      });
    }
    $('cpRangeReset').onclick = () => { const b = V().bbox; V().setCloudHeightRange(b.mn[1], b.mx[1]); $('cpError').textContent = ''; };
  }

  function setVal(id, value) { const e = $(id); if (e && document.activeElement !== e) e.value = value; }

  function drawHist(info) {
    const bo = V().base.find(o => o.points), key = bo && bo.pos;
    if (key !== histKey) { histKey = key; hist = key ? D.histogram(key, [info.bounds.mn[1], info.bounds.mx[1]], 64, 100000) : null; }
    const h = hist, s = $('cpHistogram'); s.replaceChildren();
    if (!h) return;
    const max = Math.max(1, ...h.bins), palette = PALETTES[info.display.palette];
    const NS = s.namespaceURI;
    h.bins.forEach((n, i) => {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', i * 4); r.setAttribute('y', 66 - n / max * 62); r.setAttribute('width', 3.4); r.setAttribute('height', n / max * 62);
      r.setAttribute('fill', 'rgb(' + D.color(i / 63, palette).map(x => Math.round(x * 255)).join(',') + ')');
      s.append(r);
    });
    for (const level of [info.display.min, info.display.max]) {
      const x = 256 * D.normalize(level, h.min, h.max), l = document.createElementNS(NS, 'line');
      l.setAttribute('class', 'lx-hist-mark'); l.setAttribute('x1', x); l.setAttribute('x2', x); l.setAttribute('y1', 0); l.setAttribute('y2', 68);
      s.append(l);
    }
    $('cpHistNote').textContent = h.approximate ? 'Гистограмма: выборка ' + h.sampled.toLocaleString('ru-RU') + ' точек' : 'Гистограмма загруженных точек';
  }

  /* Запись облака в дереве сцены: значок, имя файла; двойной щелчок вписывает облако, правая кнопка открывает меню. */
  function ensureEntry(parent) {
    let list = $('lxCloudEntries');
    if (parent && !list) {
      list = document.createElement('div'); list.id = 'lxCloudEntries'; list.setAttribute('role', 'group'); list.hidden = !entriesOpen;
      parent.after(list);
      const tw = parent.querySelector('.lx-tw');
      if (tw) {
        tw.classList.toggle('closed', !entriesOpen);
        tw.setAttribute('role', 'button'); tw.tabIndex = 0; tw.title = 'Развернуть / свернуть облака'; tw.setAttribute('aria-label', 'Развернуть или свернуть облака'); tw.setAttribute('aria-expanded', String(entriesOpen));
        tw.innerHTML = ico('chevron-down', 14);
        if (kit()) kit().hydrate(tw);
        const toggle = () => {
          entriesOpen = !entriesOpen; list.hidden = !entriesOpen;
          tw.classList.toggle('closed', !entriesOpen); tw.setAttribute('aria-expanded', String(entriesOpen));
        };
        tw.onclick = e => { e.stopPropagation(); toggle(); };
        tw.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
      }
    }
    return list;
  }
  function ensureRow(list) {
    if (!list || $('lxCloudEntry')) return;
    const row = document.createElement('div');
    row.id = 'lxCloudEntry'; row.className = 'lx-cloud-entry active'; row.tabIndex = 0; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-selected', 'true');
    row.innerHTML = '<span class="lx-cloud-ico">' + ico('cloud', 16) + '</span><span class="lx-cloud-filename"></span>';
    if (kit()) kit().hydrate(row);
    row.onclick = () => select(true);
    row.ondblclick = () => { select(true); V().resetView(); };
    row.oncontextmenu = e => { e.preventDefault(); select(true); openMenu($('lxCloudMore') || row); };
    row.onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); select(true); }
      if (e.key === 'F2' || (e.key === 'ContextMenu')) { e.preventDefault(); const b = $('lxCloudMore'); if (b) b.click(); }
    };
    list.append(row);
  }

  function sync() {
    mount();
    if (!$('lxCloudProperties')) return;
    const v = V(), info = v && v.getCloudInfo && v.getCloudInfo();
    const parent = document.querySelector('#lxScene [data-layer="cloud"]');
    const list = ensureEntry(parent);
    $('lxCloudEmpty').hidden = !!info; $('lxCloudFields').hidden = !info;
    $('lxCloudProperties').classList.toggle('is-empty', !info);
    if (!info) { if (list) list.replaceChildren(); histKey = null; lastSource = null; closeMenu(); return; }
    if (info.sourceName !== lastSource) { select(false); lastSource = info.sourceName; }
    const name = D.fileName(info.sourceName);
    ensureRow(list);
    const row = $('lxCloudEntry');
    if (row) { row.querySelector('.lx-cloud-filename').textContent = name; row.title = name; row.classList.toggle('invisible', !info.visible); }
    const pe = parent && parent.querySelector('[data-eye="cloud"]');
    if (pe) {
      pe.classList.toggle('on', info.visible); pe.setAttribute('aria-pressed', String(info.visible));
      const want = info.visible ? 'eye' : 'eye-off', holder = pe.firstElementChild;
      if (holder && holder.getAttribute('data-ico') !== want) holder.setAttribute('data-ico', want);
      if (kit()) kit().hydrate(pe);
    }
    $('cpName').textContent = name; $('cpName').title = name;
    const d = info.display, px = d.pointSize || Math.max(1, ((v.base[0] && v.base[0].pointSize) || 1) * v._ptSizeMul);
    setVal('cpSize', px); setVal('cpSizeNum', Number(px.toFixed(1))); setVal('cpOpacity', d.opacity); setVal('cpOpacityNum', d.opacity.toFixed(2));
    setVal('cpMode', d.mode); setVal('cpPalette', PALETTES[d.palette]);
    $('cpHeight').hidden = d.mode !== 'elev'; $('cpHide').checked = d.hideOutside;
    for (const id of ['cpMinRange', 'cpMaxRange']) { $(id).min = info.bounds.mn[1]; $(id).max = info.bounds.mx[1]; }
    setVal('cpMin', Number(d.min.toFixed(6))); setVal('cpMax', Number(d.max.toFixed(6))); setVal('cpMinRange', d.min); setVal('cpMaxRange', d.max);
    $('cpGradient').style.background = GRADIENTS[d.palette];
    if (d.mode === 'elev') drawHist(info);
    if (info.streaming) $('cpHistNote').textContent = 'Гистограмма недоступна в потоковом режиме';
    $('cpTotal').textContent = Number.isSafeInteger(info.sourceCount) ? info.sourceCount.toLocaleString('ru-RU') : 'Неизвестно';
    $('cpLoaded').textContent = info.streaming ? 'Потоковый режим' : info.loadedCount.toLocaleString('ru-RU');
    {
      // Загружена только часть точек файла (доля в настройках или предел памяти): показываем процент и куда идти за всеми точками
      const part = !info.streaming && Number.isSafeInteger(info.sourceCount) && info.sourceCount > info.loadedCount && info.loadedCount > 0;
      if (part) {
        const pct = info.loadedCount / info.sourceCount * 100;
        $('cpLoaded').textContent = info.loadedCount.toLocaleString('ru-RU') + ' (' + (pct >= 10 ? Math.round(pct) : pct.toFixed(1)) + ' %)';
      }
      const note = $('cpShareNote');
      if (note) {
        note.hidden = !part;
        note.textContent = part ? 'Загружена часть точек файла. Все точки: кнопка «Потоковый LOD» (индекс на диске по всем точкам) или Настройки → Облака точек → «100 %».' : '';
      }
    }
    $('cpDimensions').textContent = info.bounds.mx.map((x, i) => 'XYZ'[i] + ': ' + (x - info.bounds.mn[i]).toFixed(3)).join('  ·  ');
    if (window.__bimRefreshQuality) window.__bimRefreshQuality();
    $('cpColorNote').textContent = info.hasRGB ? '' : 'В исходнике нет RGB: используется цвет парсера. Доступна окраска по высоте.';
  }

  window.__lxCloudUI = { sync, closeMenu, select };
  ['bim-cloud-change', 'bim-app-ready', 'lx-scene-built'].forEach(e => window.addEventListener(e, sync));
  if (document.readyState !== 'loading') sync(); else window.addEventListener('DOMContentLoaded', () => setTimeout(sync, 200));
})();
