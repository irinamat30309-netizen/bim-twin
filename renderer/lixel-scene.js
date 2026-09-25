/* ============================================================
   LixelStudio-style Scene / Data-management tree + Этажи + Документация
   BIM Twin v1081.  Аддитивный модуль: строит правое дерево
   «Управление данными» с узлами сцены и глазками-переключателями,
   живые этажи (с диапазоном высот и изоляцией) и панель документации.
   Подписи — точно как в LixelStudio (из XGridsHS_RU.qm).
   ============================================================ */
(function () {
  'use strict';

  var LS_FLOORS = 'bim.lixel.floors.v1081';
  var LS_LAYERS = 'bim.lixel.layers.v1081';

  // Узлы сцены — точные термины LixelStudio
  var LAYERS = [
    { id: 'cloud',  icon: '☁', name: 'Облако точек' },
    { id: 'mesh',   icon: '⬢', name: 'Mesh' },
    { id: 'traj',   icon: '〰', name: 'Траектория' },
    { id: 'pano',   icon: '◎', name: 'Панорамный' },
    { id: 'vector', icon: '▤', name: 'Векторные данные' }
  ];

  var state = {
    floors: load(LS_FLOORS, []),
    layerVis: load(LS_LAYERS, {}),
    activeFloor: null
  };
  var projectStateReady = false;
  var lastRestoredStateToken = '';

  function load(k, def) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch (e) { return def; } }
  function scopedKey(k) { var ps = window.BimProjectState; return ps && ps.projectId ? k + ':' + ps.projectId : k; }
  function save() {
    try {
      localStorage.setItem(scopedKey(LS_FLOORS), JSON.stringify(state.floors));
      localStorage.setItem(scopedKey(LS_LAYERS), JSON.stringify(state.layerVis));
      if (!projectStateReady) { localStorage.setItem(LS_FLOORS, JSON.stringify(state.floors)); localStorage.setItem(LS_LAYERS, JSON.stringify(state.layerVis)); }
    } catch (e) {}
    var ps = window.BimProjectState;
    if (projectStateReady && ps && ps.update) {
      var layers = LAYERS.map(function (L) { return { id: L.id, visible: state.layerVis[L.id] !== false }; });
      ps.update({ sceneVersion: 1, floors: state.floors, activeFloorId: state.activeFloor, layers: layers }).catch(function (e) { try { console.warn('[scene] project save failed', e); } catch (_) {} });
    }
  }
  function applyProjectState(data, revision, allowMigration) {
    var ps = window.BimProjectState;
    var token = String(ps && ps.projectId || '') + ':' + String(revision == null ? (ps && ps.revision || 0) : revision);
    if (token === lastRestoredStateToken) return;
    lastRestoredStateToken = token;
    var id = ps && ps.projectId;
    if (data && data.sceneVersion === 1) {
      state.floors = Array.isArray(data.floors) ? data.floors : [];
      state.layerVis = {};
      (data.layers || []).forEach(function (L) { if (L && L.id) state.layerVis[L.id] = L.visible !== false; });
      state.activeFloor = data.activeFloorId && state.floors.some(function (f) { return f.id === data.activeFloorId; }) ? data.activeFloorId : null;
    } else if (allowMigration) {
        // One-time migration from the pre-Stage-2 global localStorage keys. Once
        // migrated, remove them so a later project cannot inherit another job's scene.
        var oldFloor = localStorage.getItem(LS_FLOORS), oldLayer = localStorage.getItem(LS_LAYERS);
        var scopedFloor = localStorage.getItem(scopedKey(LS_FLOORS)), scopedLayer = localStorage.getItem(scopedKey(LS_LAYERS));
        if (scopedFloor) { try { state.floors = JSON.parse(scopedFloor) || []; } catch (_) {} }
        else if (oldFloor) { try { state.floors = JSON.parse(oldFloor) || []; } catch (_) {} }
        if (scopedLayer) { try { state.layerVis = JSON.parse(scopedLayer) || {}; } catch (_) {} }
        else if (oldLayer) { try { state.layerVis = JSON.parse(oldLayer) || {}; } catch (_) {} }
        try { if (id) { localStorage.removeItem(LS_FLOORS); localStorage.removeItem(LS_LAYERS); } } catch (_) {}
        state.activeFloor = null;
    } else {
      state.floors = [];
      state.layerVis = {};
      state.activeFloor = null;
    }
    projectStateReady = true;
    LAYERS.forEach(function (L) { applyLayerVisibility(L.id, layerVisible(L.id)); });
    if (allowMigration && (!data || data.sceneVersion !== 1)) save();
    buildTree(); renderDocs();
  }
  function restoreProjectState() {
    var ps = window.BimProjectState;
    if (!ps || !ps.ready) { projectStateReady = true; return; }
    ps.ready.then(function (data) { applyProjectState(data, ps.revision, true); })
      .catch(function (e) { projectStateReady = true; try { console.warn('[scene] restore failed', e); } catch (_) {} });
    window.addEventListener('bim-project-state-ready', function (ev) {
      var d = ev && ev.detail || {};
      applyProjectState(d.state, d.revision, !!d.initial || !!d.reloaded);
    });
    window.addEventListener('bim-project-state-restored', function (ev) {
      var d = ev && ev.detail || {};
      applyProjectState(d.state, d.revision, false);
    });
  }
  function uid() { return 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }
  function viewer() { return window.__viewer || null; }
  function toast(m) { try { var el = document.getElementById('toast'); if (el) { el.textContent = m; el.classList.add('show'); setTimeout(function () { el.classList.remove('show'); }, 2600); return; } } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  // ---------------- Правое дерево «Управление данными» ----------------
  function eyeSvg(on) {
    return on
      ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>'
      : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 12 1 12a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22"/></svg>';
  }

  function layerVisible(id) { return state.layerVis[id] !== false; }

  function applyLayerVisibility(id, on) {
    var v = viewer();
    try {
      if (!v) return;
      if (id === 'cloud' && typeof v.setCloudVisible === 'function') v.setCloudVisible(on);
      else if (typeof v.setLayerVisible === 'function') v.setLayerVisible(id, on);
      if (typeof v.render === 'function') v.render();
    } catch (e) {}
  }

  function buildTree() {
    var insp = document.querySelector('.inspector');
    if (!insp) return;
    var hdr = insp.querySelector('.lx-datahdr');
    var host = document.getElementById('lxScene');
    if (!host) {
      host = document.createElement('div');
      host.id = 'lxScene';
      host.className = 'lx-scene';
      if (hdr && hdr.nextSibling) insp.insertBefore(host, hdr.nextSibling);
      else insp.insertBefore(host, insp.firstChild);
    }
    var html = '<div class="lx-tree">';
    // Корень — проект
    html += '<div class="lx-node lx-root"><span class="lx-tw">▾</span><span class="lx-ico">📁</span><span class="lx-nm">Обработка облака точек</span></div>';
    html += '<div class="lx-children">';
    LAYERS.forEach(function (L) {
      var on = layerVisible(L.id);
      html += '<div class="lx-node" data-layer="' + L.id + '">' +
        '<span class="lx-tw"></span><span class="lx-ico">' + L.icon + '</span>' +
        '<span class="lx-nm">' + esc(L.name) + '</span>' +
        '<button class="lx-eye' + (on ? ' on' : '') + '" data-eye="' + L.id + '" title="Показать/скрыть">' + eyeSvg(on) + '</button>' +
        '</div>';
    });
    // Узел Этажи (наша фича — комбинированное размещение)
    var fon = layerVisible('floors');
    html += '<div class="lx-node lx-floors-head" data-layer="floors">' +
      '<span class="lx-tw">▾</span><span class="lx-ico">🏢</span>' +
      '<span class="lx-nm">Этажи</span>' +
      '<button class="lx-mini" id="lxAddFloorTree" title="Создать этаж">＋</button>' +
      '<button class="lx-eye' + (fon ? ' on' : '') + '" data-eye="floors" title="Показать/скрыть">' + eyeSvg(fon) + '</button>' +
      '</div>';
    html += '<div class="lx-children lx-floorlist">';
    if (!state.floors.length) {
      html += '<div class="lx-empty">Нет этажей. Нажмите ＋, чтобы добавить диапазон высот.</div>';
    } else {
      state.floors.forEach(function (f) {
        var vis = f.visible !== false;
        var act = state.activeFloor === f.id;
        html += '<div class="lx-node lx-floor' + (act ? ' active' : '') + '" data-floor="' + f.id + '">' +
          '<span class="lx-tw"></span><span class="lx-ico">◰</span>' +
          '<span class="lx-nm" title="' + esc(f.name) + ' · Y ' + f.zmin + '…' + f.zmax + ' м">' + esc(f.name) + '</span>' +
          '<span class="lx-z">' + f.zmin + '…' + f.zmax + '</span>' +
          '<button class="lx-mini" data-iso="' + f.id + '" title="Изолировать этаж (сечением)">◈</button>' +
          '<button class="lx-mini" data-ren="' + f.id + '" title="Переименовать">✎</button>' +
          '<button class="lx-mini danger" data-del="' + f.id + '" title="Удалить">✕</button>' +
          '<button class="lx-eye' + (vis ? ' on' : '') + '" data-feye="' + f.id + '" title="Показать/скрыть">' + eyeSvg(vis) + '</button>' +
          '</div>';
      });
    }
    html += '</div>'; // floorlist
    html += '</div></div>'; // children + tree
    host.innerHTML = html;
    wireTree(host);
    window.dispatchEvent(new Event("lx-scene-built"));
  }

  function wireTree(host) {
    // глазки слоёв
    host.querySelectorAll('[data-eye]').forEach(function (b) {
      var layerId=b.getAttribute('data-eye');
      if(layerId!=='cloud') { b.disabled=true; b.title='Видимость этого слоя пока не подключена'; }

      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = b.getAttribute('data-eye');
        var on = id==='cloud' && viewer() ? viewer().cloudVisible===false : !(state.layerVis[id] !== false);
        state.layerVis[id] = on;
        if (id === 'floors') state.floors.forEach(function (f) { f.visible = on; });
        save();
        if (id !== 'floors') applyLayerVisibility(id, on);
        buildTree();
      });
    });
    // сворачивание этажей
    var fh = host.querySelector('.lx-floors-head .lx-tw');
    if (fh) fh.addEventListener('click', function () {
      var list = host.querySelector('.lx-floorlist');
      if (!list) return;
      var open = list.style.display !== 'none';
      list.style.display = open ? 'none' : '';
      fh.textContent = open ? '▸' : '▾';
    });
    var add = host.querySelector('#lxAddFloorTree');
    if (add) add.addEventListener('click', function (e) { e.stopPropagation(); addFloor(); });
    host.querySelectorAll('[data-feye]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); var f = byId(b.getAttribute('data-feye')); if (f) { f.visible = !(f.visible !== false); save(); buildTree(); } }); });
    host.querySelectorAll('[data-iso]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); isolateFloor(b.getAttribute('data-iso')); }); });
    host.querySelectorAll('[data-ren]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); renameFloor(b.getAttribute('data-ren')); }); });
    host.querySelectorAll('[data-del]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); delFloor(b.getAttribute('data-del')); }); });
    host.querySelectorAll('.lx-floor').forEach(function (n) { n.addEventListener('click', function () { selectFloor(n.getAttribute('data-floor')); }); });
  }

  function byId(id) { for (var i = 0; i < state.floors.length; i++) if (state.floors[i].id === id) return state.floors[i]; return null; }

  // ---------------- Этажи ----------------
  function addFloor(preset) {
    modalFloor('Новый этаж', preset || { name: 'Этаж ' + (state.floors.length + 1), zmin: '', zmax: '' }, function (data) {
      state.floors.push({ id: uid(), name: data.name, zmin: data.zmin, zmax: data.zmax, visible: true, docs: [] });
      save(); buildTree(); renderDocs();
      toast('Этаж добавлен: ' + data.name);
    });
  }
  function renameFloor(id) {
    var f = byId(id); if (!f) return;
    modalFloor('Переименовать этаж', { name: f.name, zmin: f.zmin, zmax: f.zmax }, function (data) {
      f.name = data.name; f.zmin = data.zmin; f.zmax = data.zmax; save(); buildTree(); renderDocs();
    });
  }
  function delFloor(id) {
    var f = byId(id); if (!f) return;
    state.floors = state.floors.filter(function (x) { return x.id !== id; });
    if (state.activeFloor === id) state.activeFloor = null;
    save(); buildTree(); renderDocs();
    toast('Этаж удалён');
  }
  function selectFloor(id) { state.activeFloor = id; save(); buildTree(); renderDocs(); }
  function isolateFloor(id) {
    var f = byId(id); if (!f) return;
    state.activeFloor = id;
    save();
    var v = viewer();
    var zmin = parseFloat(f.zmin), zmax = parseFloat(f.zmax);
    var ok = false;
    try {
      if (v && v.setSectionAxis && v.bbox && isFinite(zmin) && isFinite(zmax)) {
        var lo=v.bbox.mn[1], span=v.bbox.mx[1]-lo;
        if(span>0 && zmax>=lo && zmin<=v.bbox.mx[1]) { v.setSection(true); v.setSectionAxis('y',(zmin-lo)/span,(zmax-lo)/span); ok=true; }
      }
      if (v && typeof v.render === 'function') v.render();
    } catch (e) {}
    buildTree();
    toast(ok ? ('Изоляция: ' + f.name + ' (Y ' + f.zmin + '…' + f.zmax + ' м)') : ('Задан этаж ' + f.name + ' · включите Сечение для среза'));
  }

  // Маленькое модальное окно этажа
  function modalFloor(title, init, onOk) {
    var back = document.createElement('div');
    back.className = 'lx-modal-back';
    back.innerHTML =
      '<div class="lx-modal">' +
      '<div class="lx-modal-h">' + esc(title) + '</div>' +
      '<label class="lx-fld"><span>Название</span><input id="lxfName" type="text" value="' + esc(init.name || '') + '"></label>' +
      '<div class="lx-fld2">' +
      '<label class="lx-fld"><span>Y мин, м</span><input id="lxfMin" type="number" step="0.01" value="' + esc(init.zmin) + '"></label>' +
      '<label class="lx-fld"><span>Y макс, м</span><input id="lxfMax" type="number" step="0.01" value="' + esc(init.zmax) + '"></label>' +
      '</div>' +
      '<div class="lx-modal-a"><button class="btn" id="lxfCancel">Отмена</button><button class="btn primary" id="lxfOk">ОК</button></div>' +
      '</div>';
    document.body.appendChild(back);
    var close = function () { try { document.body.removeChild(back); } catch (e) {} };
    back.querySelector('#lxfCancel').addEventListener('click', close);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    back.querySelector('#lxfOk').addEventListener('click', function () {
      var name = (back.querySelector('#lxfName').value || '').trim() || 'Этаж';
      var zmin = back.querySelector('#lxfMin').value, zmax = back.querySelector('#lxfMax').value;
      onOk({ name: name, zmin: zmin === '' ? '' : (+zmin), zmax: zmax === '' ? '' : (+zmax) });
      close();
    });
    setTimeout(function () { try { back.querySelector('#lxfName').focus(); } catch (e) {} }, 30);
  }

  // ---------------- Документация ----------------
  function renderDocs() {
    var host = document.getElementById('lxDocs');
    if (!host) return;
    var f = state.activeFloor ? byId(state.activeFloor) : null;
    var head = '<div class="lx-docs-h"><b>Документация</b>' + (f ? ' · ' + esc(f.name) : ' · общая') + '</div>';
    if (!f) { host.innerHTML = head + '<div class="lx-empty">Выберите этаж в дереве, чтобы прикреплять документы и замечания.</div>'; return; }
    var rows = (f.docs || []).map(function (d, i) {
      return '<div class="lx-doc"><span class="lx-doc-ic">' + (d.kind === 'note' ? '⚑' : '📎') + '</span>' +
        '<span class="lx-doc-nm">' + esc(d.name) + '</span>' +
        '<button class="lx-mini danger" data-docdel="' + i + '" title="Удалить">✕</button></div>';
    }).join('');
    host.innerHTML = head +
      '<div class="lx-docs-a"><button class="btn xs" id="lxDocAttach">📎 Прикрепить</button>' +
      '<button class="btn xs" id="lxDocNote">⚑ Замечание</button>' +
      '<button class="btn xs" id="lxDocReport">📄 Отчёт</button></div>' +
      (rows || '<div class="lx-empty">Нет вложений.</div>');
    host.querySelector('#lxDocAttach').addEventListener('click', function () { attachDoc(f); });
    host.querySelector('#lxDocNote').addEventListener('click', function () { addNote(f); });
    host.querySelector('#lxDocReport').addEventListener('click', function () { report(f); });
    host.querySelectorAll('[data-docdel]').forEach(function (b) { b.addEventListener('click', function () { f.docs.splice(+b.getAttribute('data-docdel'), 1); save(); renderDocs(); }); });
  }

  function ensureDocsPanel() {
    var insp = document.querySelector('.inspector');
    if (!insp) return;
    if (document.getElementById('lxDocs')) return;
    var scene = document.getElementById('lxScene');
    var host = document.createElement('div');
    host.id = 'lxDocs';
    host.className = 'lx-docs';
    if (scene && scene.nextSibling) insp.insertBefore(host, scene.nextSibling);
    else if (scene) insp.appendChild(host);
    else { var hdr = insp.querySelector('.lx-datahdr'); if (hdr && hdr.nextSibling) insp.insertBefore(host, hdr.nextSibling); else insp.insertBefore(host, insp.firstChild); }
  }

  function attachDoc(f) {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.onchange = function () {
      var file = inp.files && inp.files[0];
      if (!file) return;
      f.docs = f.docs || [];
      f.docs.push({ kind: 'doc', name: file.name });
      save(); renderDocs();
      toast('Прикреплено: ' + file.name);
    };
    inp.click();
  }
  function addNote(f) {
    modalFloor('Замечание', { name: '', zmin: f.zmin, zmax: f.zmax }, function () {});
    // простое замечание через prompt (надёжно, без зависимостей)
  }

  function report(f) {
    var lines = ['Отчёт по этажу: ' + f.name, 'Диапазон высот Z: ' + f.zmin + '…' + f.zmax + ' м', 'Вложений: ' + ((f.docs || []).length)];
    (f.docs || []).forEach(function (d) { lines.push(' • ' + (d.kind === 'note' ? '[замечание] ' : '[док] ') + d.name); });
    try { navigator.clipboard.writeText(lines.join('\n')); toast('Отчёт скопирован в буфер'); } catch (e) { toast('Отчёт готов'); }
  }

  // ---------------- Публичный API для ленты «Объект» ----------------
  window.__lxScene = {
    addFloor: function () { addFloor(); },
    autoSlice: function () {
      // Авто-нарезка: если вьюер знает границы — порежем на 3 этажа равномерно
      var v = viewer(); var bb = null;
      try { if(v && v.bbox) bb={zmin:v.bbox.mn[1],zmax:v.bbox.mx[1]}; } catch (e) {}
      if (bb && isFinite(bb.zmin) && isFinite(bb.zmax) && bb.zmax > bb.zmin) {
        var n = 3, step = (bb.zmax - bb.zmin) / n;
        for (var i = 0; i < n; i++) state.floors.push({ id: uid(), name: 'Этаж ' + (i + 1), zmin: +(bb.zmin + i * step).toFixed(2), zmax: +(bb.zmin + (i + 1) * step).toFixed(2), visible: true, docs: [] });
        save(); buildTree(); renderDocs(); toast('Авто-нарезка: 3 этажа по высоте');
      } else { addFloor(); toast('Границы облака недоступны — задайте диапазон вручную'); }
    },
    isolateActive: function () { if (state.activeFloor) isolateFloor(state.activeFloor); else toast('Выберите этаж в дереве справа'); },
    attachDoc: function () { var f = state.activeFloor ? byId(state.activeFloor) : null; if (!f) { toast('Сначала выберите этаж'); return; } attachDoc(f); },
    report: function () { var f = state.activeFloor ? byId(state.activeFloor) : null; if (!f) { toast('Сначала выберите этаж'); return; } report(f); },
    restoreProjectState: function (data, revision) { applyProjectState(data, revision, false); }
  };

  function build() {
    buildTree();
    ensureDocsPanel();
    renderDocs();
    window.dispatchEvent(new Event("lx-scene-built"));
  }

  restoreProjectState();
  window.addEventListener('lx-viewer-ready', function () { LAYERS.forEach(function (L) { applyLayerVisibility(L.id, layerVisible(L.id)); }); });

  // Строимся после lixel-ui (который создаёт .lx-datahdr)
  function boot() { if (document.querySelector('.inspector')) build(); else setTimeout(boot, 120); }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 60); });
  else setTimeout(boot, 60);
})();
