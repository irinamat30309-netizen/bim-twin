/* ============================================================
   Панель «Сцена»: дерево данных, этажи и документация этажа.
   Живые этажи (диапазон высот + изоляция срезом), глазки видимости и
   вложения. Данные сохраняются в состоянии проекта; в дереве рисуются
   только реально подключённые слои (облако точек и этажи).
   ============================================================ */
(function () {
  'use strict';

  var LS_FLOORS = 'bim.lixel.floors.v1081';
  var LS_LAYERS = 'bim.lixel.layers.v1081';

  // Узлы сцены — точные термины LixelStudio
  // В дереве показываются только слои с рабочим переключателем (shown); остальные хранятся в состоянии проекта.
  var LAYERS = [
    { id: 'cloud',  icon: 'cloud',  name: 'Облако точек', shown: true },
    { id: 'mesh',   icon: 'box',    name: 'Mesh' },
    { id: 'traj',   icon: 'route',  name: 'Траектория' },
    { id: 'pano',   icon: 'circle-dot', name: 'Панорамный' },
    { id: 'vector', icon: 'vector-square', name: 'Векторные данные' }
  ];
  var ui = { root: true, floors: true };

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
  function toast(m, opts) {
    try {
      if (window.__lxKit && window.__lxKit.toast) { window.__lxKit.toast(m, opts); return; }
      var el = document.getElementById('toast'); if (el) { el.textContent = m; el.classList.add('show'); setTimeout(function () { el.classList.remove('show'); }, 2600); }
    } catch (e) {}
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  // ---------------- Правое дерево «Управление данными» ----------------
  function ico(name, size) { return '<span data-ico="' + name + '" data-ico-size="' + (size || 16) + '" aria-hidden="true"></span>'; }
  function eyeBtn(attr, id, on, what) {
    var t = (on ? 'Скрыть' : 'Показать') + (what ? ': ' + what : '');
    return '<button type="button" class="lx-eye' + (on ? ' on' : '') + '" ' + attr + '="' + id + '" aria-pressed="' + (on ? 'true' : 'false') + '" title="' + esc(t) + '" aria-label="' + esc(t) + '">' + ico(on ? 'eye' : 'eye-off', 15) + '</button>';
  }
  function miniBtn(attr, id, icon, title, cls) {
    return '<button type="button" class="lx-mini' + (cls ? ' ' + cls : '') + '" ' + attr + '="' + id + '" title="' + esc(title) + '" aria-label="' + esc(title) + '">' + ico(icon, 15) + '</button>';
  }
  function twHtml(key, open, label) {
    return '<span class="lx-tw' + (open ? '' : ' closed') + '" data-tw="' + key + '" role="button" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '" aria-label="' + esc(label) + '">' + ico('chevron-down', 14) + '</span>';
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
    var pane = document.getElementById('inspScene') || document.querySelector('.inspector');
    if (!pane) return;
    var host = document.getElementById('lxScene');
    if (!host) {
      host = document.createElement('div');
      host.id = 'lxScene';
      host.className = 'lx-scene';
      pane.insertBefore(host, pane.firstChild);
    }
    var html = '<div class="lx-tree" role="tree" aria-label="Сцена">';
    // Корень — проект
    html += '<div class="lx-node lx-root" role="treeitem" aria-expanded="' + ui.root + '">' + twHtml('root', ui.root, 'Свернуть или развернуть сцену') +
      '<span class="lx-ico">' + ico('folder') + '</span><span class="lx-nm">Обработка облака точек</span></div>';
    html += '<div class="lx-children" id="lxSceneChildren" role="group"' + (ui.root ? '' : ' hidden') + '>';
    LAYERS.forEach(function (L) {
      if (!L.shown) return;
      var on = layerVisible(L.id);
      if (L.id === 'cloud' && viewer() && viewer().cloudVisible === false) on = false;
      html += '<div class="lx-node" data-layer="' + L.id + '" role="treeitem">' +
        '<span class="lx-tw" data-tw="' + L.id + '"></span><span class="lx-ico">' + ico(L.icon) + '</span>' +
        '<span class="lx-nm" title="' + esc(L.name) + '">' + esc(L.name) + '</span>' +
        eyeBtn('data-eye', L.id, on, L.name) +
        '</div>';
    });
    // Узел Этажи (диапазоны высот с изоляцией)
    var fon = layerVisible('floors');
    html += '<div class="lx-node lx-floors-head" data-layer="floors" role="treeitem" aria-expanded="' + ui.floors + '">' +
      twHtml('floors', ui.floors, 'Свернуть или развернуть этажи') + '<span class="lx-ico">' + ico('building-2') + '</span>' +
      '<span class="lx-nm">Этажи</span>' +
      miniBtn('id', 'lxAddFloorTree', 'plus', 'Создать этаж') +
      eyeBtn('data-eye', 'floors', fon, 'этажи') +
      '</div>';
    html += '<div class="lx-children lx-floorlist" role="group"' + (ui.floors ? '' : ' hidden') + '>';
    if (!state.floors.length) {
      html += '<div class="lx-empty">Нет этажей. Нажмите «+», чтобы добавить диапазон высот.</div>';
    } else {
      state.floors.forEach(function (f) {
        var vis = f.visible !== false;
        var act = state.activeFloor === f.id;
        var range = f.zmin + '…' + f.zmax;
        html += '<div class="lx-node lx-floor' + (act ? ' active' : '') + '" data-floor="' + f.id + '" role="treeitem" tabindex="0" aria-selected="' + act + '">' +
          '<span class="lx-tw"></span><span class="lx-ico">' + ico('layers') + '</span>' +
          '<span class="lx-nm" title="' + esc(f.name) + ' · Y ' + esc(range) + ' м">' + esc(f.name) + '</span>' +
          '<span class="lx-z">' + esc(range) + '</span>' +
          miniBtn('data-iso', f.id, 'scan-line', 'Изолировать этаж (сечением)') +
          miniBtn('data-ren', f.id, 'pencil', 'Переименовать') +
          miniBtn('data-del', f.id, 'trash-2', 'Удалить', 'danger') +
          eyeBtn('data-feye', f.id, vis, f.name) +
          '</div>';
      });
    }
    html += '</div>'; // floorlist
    html += '</div></div>'; // children + tree
    host.innerHTML = html;
    if (window.__lxKit && window.__lxKit.hydrate) window.__lxKit.hydrate(host);
    wireTree(host);
    window.dispatchEvent(new Event("lx-scene-built"));
  }

  function wireTree(host) {
    // глазки слоёв
    host.querySelectorAll('[data-eye]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = b.getAttribute('data-eye');
        var on = id === 'cloud' && viewer() ? viewer().cloudVisible === false : !(state.layerVis[id] !== false);
        state.layerVis[id] = on;
        if (id === 'floors') state.floors.forEach(function (f) { f.visible = on; });
        save();
        if (id !== 'floors') applyLayerVisibility(id, on);
        buildTree();
      });
    });
    // сворачивание корня и этажей
    host.querySelectorAll('.lx-tw[data-tw="root"],.lx-tw[data-tw="floors"]').forEach(function (tw) {
      var toggle = function (e) {
        if (e) e.stopPropagation();
        var key = tw.getAttribute('data-tw');
        ui[key] = !ui[key];
        tw.classList.toggle('closed', !ui[key]);
        tw.setAttribute('aria-expanded', String(ui[key]));
        var target = key === 'root' ? host.querySelector('#lxSceneChildren') : host.querySelector('.lx-floorlist');
        if (target) target.hidden = !ui[key];
        var row = tw.closest('.lx-node'); if (row) row.setAttribute('aria-expanded', String(ui[key]));
      };
      tw.addEventListener('click', toggle);
      tw.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } });
    });
    var add = host.querySelector('#lxAddFloorTree');
    if (add) add.addEventListener('click', function (e) { e.stopPropagation(); addFloor(); });
    host.querySelectorAll('[data-feye]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); var f = byId(b.getAttribute('data-feye')); if (f) { f.visible = !(f.visible !== false); save(); buildTree(); } }); });
    host.querySelectorAll('[data-iso]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); isolateFloor(b.getAttribute('data-iso')); }); });
    host.querySelectorAll('[data-ren]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); renameFloor(b.getAttribute('data-ren')); }); });
    host.querySelectorAll('[data-del]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); delFloor(b.getAttribute('data-del')); }); });
    host.querySelectorAll('.lx-floor').forEach(function (n) {
      n.addEventListener('click', function () { selectFloor(n.getAttribute('data-floor')); });
      n.addEventListener('keydown', function (e) { if (e.target === n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectFloor(n.getAttribute('data-floor')); } });
    });
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

  // Небольшое диалоговое окно этажа
  function modalFloor(title, init, onOk) {
    var back = document.createElement('div');
    back.className = 'lx-modal-back';
    back.innerHTML =
      '<div class="lx-modal" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
      '<div class="lx-modal-h">' + esc(title) + '</div>' +
      '<label class="lx-fld"><span>Название</span><input id="lxfName" type="text" value="' + esc(init.name || '') + '" autocomplete="off"></label>' +
      '<div class="lx-fld2">' +
      '<label class="lx-fld"><span>Y мин, м</span><input id="lxfMin" type="number" step="0.01" value="' + esc(init.zmin) + '"></label>' +
      '<label class="lx-fld"><span>Y макс, м</span><input id="lxfMax" type="number" step="0.01" value="' + esc(init.zmax) + '"></label>' +
      '</div>' +
      '<div class="lx-modal-a"><button type="button" class="btn" id="lxfCancel"><span class="lbl">Отмена</span></button><button type="button" class="btn primary" id="lxfOk"><span class="lbl">ОК</span></button></div>' +
      '</div>';
    document.body.appendChild(back);
    var prev = document.activeElement;
    var close = function () { try { document.body.removeChild(back); } catch (e) {} try { if (prev && prev.focus) prev.focus({ preventScroll: true }); } catch (e) {} };
    var submit = function () {
      var name = (back.querySelector('#lxfName').value || '').trim() || 'Этаж';
      var zmin = back.querySelector('#lxfMin').value, zmax = back.querySelector('#lxfMax').value;
      onOk({ name: name, zmin: zmin === '' ? '' : (+zmin), zmax: zmax === '' ? '' : (+zmax) });
      close();
    };
    back.querySelector('#lxfCancel').addEventListener('click', close);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    back.querySelector('#lxfOk').addEventListener('click', submit);
    back.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); submit(); } });
    setTimeout(function () { try { var n = back.querySelector('#lxfName'); n.focus(); n.select(); } catch (e) {} }, 30);
  }

  // ---------------- Документация ----------------
  function renderDocs() {
    var host = document.getElementById('lxDocs');
    if (!host) return;
    var f = state.activeFloor ? byId(state.activeFloor) : null;
    host.hidden = !state.floors.length;
    var head = '<div class="lx-docs-h">' + ico('folder-open', 15) + '<b>Документация</b><span>' + (f ? esc(f.name) : 'общая') + '</span></div>';
    if (!f) { host.innerHTML = head + '<div class="lx-empty">Выберите этаж в дереве, чтобы прикреплять документы и собирать отчёт.</div>'; if (window.__lxKit) window.__lxKit.hydrate(host); return; }
    var rows = (f.docs || []).map(function (d, i) {
      return '<div class="lx-doc"><span class="lx-doc-ic">' + ico(d.kind === 'note' ? 'flag' : 'paperclip', 15) + '</span>' +
        '<span class="lx-doc-nm" title="' + esc(d.name) + '">' + esc(d.name) + '</span>' +
        miniBtn('data-docdel', i, 'x', 'Удалить вложение', 'danger') + '</div>';
    }).join('');
    host.innerHTML = head +
      '<div class="lx-docs-a"><button type="button" class="btn sm" id="lxDocAttach"><span data-ico="paperclip" data-ico-size="15"></span><span class="lbl">Прикрепить</span></button>' +
      '<button type="button" class="btn sm" id="lxDocReport"><span data-ico="file-text" data-ico-size="15"></span><span class="lbl">Отчёт</span></button></div>' +
      (rows || '<div class="lx-empty">Нет вложений.</div>');
    if (window.__lxKit) window.__lxKit.hydrate(host);
    host.querySelector('#lxDocAttach').addEventListener('click', function () { attachDoc(f); });
    host.querySelector('#lxDocReport').addEventListener('click', function () { report(f); });
    host.querySelectorAll('[data-docdel]').forEach(function (b) { b.addEventListener('click', function () { f.docs.splice(+b.getAttribute('data-docdel'), 1); save(); renderDocs(); }); });
  }

  function ensureDocsPanel() {
    var pane = document.getElementById('inspScene') || document.querySelector('.inspector');
    if (!pane) return;
    if (document.getElementById('lxDocs')) return;
    var host = document.createElement('div');
    host.id = 'lxDocs';
    host.className = 'lx-docs';
    pane.appendChild(host);
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
  function report(f) {
    var lines = ['Отчёт по этажу: ' + f.name, 'Диапазон высот Z: ' + f.zmin + '…' + f.zmax + ' м', 'Вложений: ' + ((f.docs || []).length)];
    (f.docs || []).forEach(function (d) { lines.push(' • ' + (d.kind === 'note' ? '[замечание] ' : '[док] ') + d.name); });
    try { navigator.clipboard.writeText(lines.join('\n')).then(function () { toast('Отчёт скопирован в буфер', { tone: 'ok' }); }, function () { toast('Отчёт готов'); }); } catch (e) { toast('Отчёт готов'); }
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

  // Строимся, когда панель «Сцена» уже есть в документе
  function boot() { if (document.getElementById('inspScene') || document.querySelector('.inspector')) build(); else setTimeout(boot, 120); }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 60); });
  else setTimeout(boot, 60);
})();
