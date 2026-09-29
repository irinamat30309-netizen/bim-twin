/*
 * lixel-object-extract.js — v1153
 * «Выделить объект срезом» (как в FARO): горизонтальный или вертикальный срез облака,
 * умный захват нужного объекта, извлечение его отдельной моделью и сохранение (PLY / открыть как облако).
 * Кнопку запуска (#lxObjExtractBtn) создаёт этот модуль, размещает и оформляет лента (ui/ribbon.js).
 * Панель — плавающая .fpanel в #stageSideL; оформление — ui/tools.css.
 */
(function () {
  'use strict';
  var panel = null, btn = null, state = { axis: 'y', ranges: { x: { lo: 49, hi: 51 }, y: { lo: 49, hi: 51 }, z: { lo: 49, hi: 51 } }, smart: true, wired: false };

  function V() { try { return (window.__pcTools && window.__pcTools.viewer && window.__pcTools.viewer()) || window.__viewer || null; } catch (e) { return null; } }
  function API() { try { return (window.__pcTools && window.__pcTools.api && window.__pcTools.api()) || window.API || null; } catch (e) { return null; } }
  function toast(m, tone) {
    try { if (window.__lxKit && window.__lxKit.toast) return window.__lxKit.toast(m, { tone: tone }); } catch (e) {}
    try { if (window.__pcTools && window.__pcTools.toast) return window.__pcTools.toast(m); } catch (e) {}
    try { console.log('[obj-extract]', m); } catch (e) {}
  }
  function el(tag, cls, html) { var d = document.createElement(tag); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function iconBtn(ico, tip, cls) {
    var b = el('button', 'icon-btn xs' + (cls ? ' ' + cls : '')); b.type = 'button';
    b.setAttribute('data-ico', ico); b.setAttribute('data-tip', tip); b.setAttribute('aria-label', tip);
    return b;
  }
  function setOn(b, on) { if (!b) return; b.classList.toggle('on', !!on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  function nfmt(n) { try { return (n || 0).toLocaleString('ru-RU'); } catch (e) { return String(n || 0); } }

  function axisIndex(axis) { return axis === 'x' ? 0 : (axis === 'y' ? 1 : 2); }
  function axisLabel(axis) { return axis === 'y' ? 'Горизонтальный · план (Y)' : (axis === 'z' ? 'Вертикальный · фасад (Z)' : 'Вертикальный · сбоку (X)'); }
  function axisBounds(v, axis) {
    v = v || V(); axis = axis || state.axis;
    var b = v && v.bbox, i = axisIndex(axis);
    if (!b || !b.mn || !b.mx) return null;
    var lo = Number(b.mn[i]), hi = Number(b.mx[i]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null;
    return { min: lo, max: hi, span: hi - lo };
  }
  function clampPct(v) { return Math.max(0, Math.min(100, Number(v) || 0)); }
  function rangeFor(axis) { return state.ranges[axis] || (state.ranges[axis] = { lo: 49, hi: 51 }); }
  function syncRangeControls() {
    if (!panel) return;
    var r = rangeFor(state.axis), b = axisBounds(V(), state.axis);
    var lo = panel.querySelector('#lxObjLo'), hi = panel.querySelector('#lxObjHi');
    var loV = panel.querySelector('#lxObjLoV'), hiV = panel.querySelector('#lxObjHiV');
    var loCoord = panel.querySelector('#lxObjLoCoord'), hiCoord = panel.querySelector('#lxObjHiCoord');
    var axisName = panel.querySelector('#lxObjAxisName'), summary = panel.querySelector('#lxObjSliceSummary');
    if (axisName) axisName.textContent = state.axis.toUpperCase();
    if (lo) lo.value = String(Math.round(clampPct(r.lo) * 100));
    if (hi) hi.value = String(Math.round(clampPct(r.hi) * 100));
    if (!b) {
      if (loV) loV.textContent = '—'; if (hiV) hiV.textContent = '—';
      if (loCoord) loCoord.value = ''; if (hiCoord) hiCoord.value = '';
      if (summary) summary.textContent = 'Границы облака недоступны.';
      return;
    }
    var a = b.min + b.span * clampPct(r.lo) / 100, z = b.min + b.span * clampPct(r.hi) / 100;
    if (loV) loV.textContent = clampPct(r.lo).toFixed(2) + '% · ' + a.toFixed(3) + ' м';
    if (hiV) hiV.textContent = clampPct(r.hi).toFixed(2) + '% · ' + z.toFixed(3) + ' м';
    [loCoord, hiCoord].forEach(function (el) {
      if (!el) return;
      el.min = String(b.min); el.max = String(b.max);
      el.step = String(Math.max(0.001, b.span / 10000));
    });
    if (loCoord) loCoord.value = a.toFixed(3);
    if (hiCoord) hiCoord.value = z.toFixed(3);
    if (summary) summary.textContent = axisLabel(state.axis) + ' · ' + a.toFixed(3) + '–' + z.toFixed(3) + ' м · толщина ' + Math.max(0, z - a).toFixed(3) + ' м (локальные координаты)';
  }
  function applySlice() {
    var v = V(), r = rangeFor(state.axis);
    if (v && v.sliceSetup) {
      try { v.sliceSetup(state.axis, clampPct(r.lo) / 100, clampPct(r.hi) / 100); }
      catch (e) { toast(e && e.message ? e.message : 'Не удалось применить срез', 'err'); }
    }
    syncRangeControls();
  }
  function setRange(which, pct) {
    var r = rangeFor(state.axis), n = clampPct(pct);
    r[which] = n;
    if (r.lo > r.hi) { if (which === 'lo') r.hi = r.lo; else r.lo = r.hi; }
    syncRangeControls(); applySlice();
  }
  function setRangeFromCoordinate(which, value) {
    var b = axisBounds(V(), state.axis), n = Number(value);
    if (!b || !Number.isFinite(n)) return;
    var pct = b.span > 0 ? (n - b.min) / b.span * 100 : 50;
    setRange(which, pct);
  }
  function sourceCloud(cloud, v) {
    if (!cloud || !cloud.pos) return cloud;
    var meta = cloud.meta || {}, tr = meta.srcXform || (v && v._srcXform);
    if (!tr || (tr.axis !== 'zup' && tr.axis !== 'yup') || !tr.t || tr.t.length < 3) return cloud;
    var t = Array.prototype.slice.call(tr.t, 0, 3).map(Number);
    if (!t.every(Number.isFinite)) return cloud;
    var n = cloud.count != null ? cloud.count : Math.floor(cloud.pos.length / 3), p = new Float64Array(n * 3);
    for (var i = 0; i < n; i++) {
      var x = cloud.pos[i * 3], y = cloud.pos[i * 3 + 1], z = cloud.pos[i * 3 + 2];
      if (tr.axis === 'zup') { p[i * 3] = x + t[0]; p[i * 3 + 1] = -z + t[1]; p[i * 3 + 2] = y + t[2]; }
      else { p[i * 3] = x + t[0]; p[i * 3 + 1] = y + t[1]; p[i * 3 + 2] = z + t[2]; }
    }
    return { pos: p, col: cloud.col || null, count: n, meta: { srcXform: { axis: tr.axis, t: t }, crsWkt: meta.crsWkt || (v && v._srcCrs) || null } };
  }
  function fallbackPLYDouble(cloud) {
    var n = cloud.count != null ? cloud.count : Math.floor(cloud.pos.length / 3), col = cloud.col || null;
    var up = cloud.meta && cloud.meta.srcXform && cloud.meta.srcXform.axis === 'zup' ? 'z' : 'y';
    var h = ['ply', 'format binary_little_endian 1.0', 'comment BIM Twin extracted object', 'comment up=' + up, 'element vertex ' + n, 'property double x', 'property double y', 'property double z'];
    if (col) h.push('property uchar red', 'property uchar green', 'property uchar blue');
    h.push('end_header', '');
    var header = new TextEncoder().encode(h.join('\\n')), stride = 24 + (col ? 3 : 0);
    if (!Number.isSafeInteger(n * stride) || n * stride > 0x7fffffff) throw new RangeError('Объект слишком велик для экспорта одним файлом');
    var body = new ArrayBuffer(n * stride), dv = new DataView(body), scaled = false;
    if (col) { var cm = 0; for (var k = 0; k < Math.min(col.length, 3000); k++) if (col[k] > cm) cm = col[k]; scaled = cm <= 1.0001; }
    var off = 0;
    for (var i = 0; i < n; i++) {
      dv.setFloat64(off, cloud.pos[i * 3], true); off += 8;
      dv.setFloat64(off, cloud.pos[i * 3 + 1], true); off += 8;
      dv.setFloat64(off, cloud.pos[i * 3 + 2], true); off += 8;
      if (col) for (var a = 0; a < 3; a++) dv.setUint8(off++, Math.max(0, Math.min(255, Math.round(scaled ? col[i * 3 + a] * 255 : col[i * 3 + a]))));
    }
    var out = new Uint8Array(header.length + body.byteLength); out.set(header); out.set(new Uint8Array(body), header.length); return out;
  }

  function refreshList() {
    if (!panel) return;
    var v = V(), wrap = panel.querySelector('#lxObjList'); if (!wrap) return;
    var objs = (v && v.getExtractedObjects) ? v.getExtractedObjects() : [];
    wrap.innerHTML = '';
    if (!objs.length) { wrap.appendChild(el('div', 'lx-obj-empty', 'Пока нет извлечённых объектов')); return; }
    objs.forEach(function (o) {
      var row = el('div', 'lx-obj-row'); row.setAttribute('role', 'listitem');
      var nm = el('div', 'lx-obj-main', '<b>' + esc(o.name || o.id) + '</b><small>' + nfmt(o.count) + ' т.</small>');
      var acts = el('div', 'lx-obj-acts');
      var bMeas = iconBtn('ruler', 'Измерить в окне инспектора');
      var bOpen = iconBtn('folder-open', 'Открыть как активную модель');
      var bPly = iconBtn('download', 'Сохранить в PLY');
      var bDel = iconBtn('trash-2', 'Удалить объект', 'danger');
      bMeas.onclick = function () { try { var c = v.getExtractedObjectCloud && v.getExtractedObjectCloud(o.id); if (window.__lxObjectInspector && c) window.__lxObjectInspector.openWithCloud(c, o.name || o.id); else toast('Инспектор недоступен', 'warn'); } catch (e) { toast('Не удалось открыть инспектор', 'err'); } };
      bOpen.onclick = function () { if (v.loadExtractedObjectAsCloud && v.loadExtractedObjectAsCloud(o.id)) toast('Объект открыт как модель: ' + (o.name || o.id), 'ok'); };
      bPly.onclick = function () { savePly(o.id, o.name); };
      bDel.onclick = function () { if (v.removeExtractedObject) v.removeExtractedObject(o.id); refreshList(); };
      [bMeas, bOpen, bPly, bDel].forEach(function (b) { acts.appendChild(b); });
      row.appendChild(nm); row.appendChild(acts);
      wrap.appendChild(row);
    });
    if (window.__lxKit && window.__lxKit.hydrate) window.__lxKit.hydrate(wrap);
  }

  async function savePly(id, name) {
    var v = V(); if (!v || !v.getExtractedObjectCloud) return;
    var c = v.getExtractedObjectCloud(id); if (!c || !c.pos || !c.pos.length) { toast('Пустой объект', 'warn'); return; }
    var src = sourceCloud(c, v), bytes, stop = null;
    try {
      if (window.__pcTools && window.__pcTools.beginProgress) stop = window.__pcTools.beginProgress('Экспорт PLY объекта…');
      if (window.ExportHub && window.ExportHub.exportPLYAsync) bytes = await window.ExportHub.exportPLYAsync(src, function (f) { if (stop && stop.set) stop.set(f, 'Кодирование PLY…'); });
      else if (window.ExportHub && window.ExportHub.exportPLY) bytes = window.ExportHub.exportPLY(src);
      else bytes = fallbackPLYDouble(src);
    } catch (e) { toast('Ошибка формирования PLY: ' + (e && e.message ? e.message : 'неизвестная ошибка'), 'err'); return; }
    finally { try { if (stop) stop(); } catch (e) {} }
    var fname = (name ? String(name).replace(/[^\w\-]+/g, '_') : 'object') + '.ply';
    var api = API();
    if (api && api.saveCloud) {
      try { var r = await api.saveCloud({ binary: bytes, name: fname }); if (r && r.ok) toast('Сохранено: ' + r.path, 'ok'); else if (!(r && r.canceled)) toast('Ошибка сохранения', 'err'); }
      catch (e) { toast('Ошибка сохранения', 'err'); }
    } else {
      try { var blob = new Blob([bytes], { type: 'application/octet-stream' }); var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname; a.click(); toast('PLY скачан: ' + fname, 'ok'); }
      catch (e) { toast('Сохранение недоступно', 'err'); }
    }
  }

  function wireSmartClick() {
    var v = V(); if (!v || !v.canvas || state.wired) return; state.wired = true;
    var cv = v.canvas, dx = 0, dy = 0, down = false;
    cv.addEventListener('mousedown', function (e) { if (e.button === 0) { down = true; dx = e.clientX; dy = e.clientY; } });
    window.addEventListener('mouseup', function (e) {
      if (!down || e.button !== 0) { down = false; return; } down = false;
      if (!state.smart || !panel || panel.style.display === 'none') return;
      if (Math.hypot(e.clientX - dx, e.clientY - dy) >= 5) return;
      if (document.elementFromPoint(e.clientX, e.clientY) !== cv) return;
      var vv = V(); if (!vv || !vv.smartObjectAt) return;
      var _cx = e.clientX, _cy = e.clientY;
      var _t = (window.__pcTools && window.__pcTools.beginProgress) ? window.__pcTools.beginProgress('Захват объекта…') : null;
      setTimeout(function () { var n = 0; try { n = vv.smartObjectAt(_cx, _cy, { maxPts: 500000 }); } catch (err) {} try { if (_t) _t(); } catch (e2) {} if (n) toast('Захвачено точек объекта: ' + nfmt(n) + ' — нажмите «Извлечь объект»', 'ok'); else toast('Объект не найден — кликните по нему в срезе', 'warn'); }, 30);
    });
  }

  function build() {
    if (panel) return panel;
    panel = el('section', 'fpanel fp-left lx-objpanel'); panel.id = 'lxObjPanel'; panel.setAttribute('aria-label', 'Выделение объекта срезом');
    panel.style.display = 'none';
    panel.innerHTML = '<div class="fpanel-inner"><header class="fpanel-head"><span class="fpanel-ico" data-ico="box-select"></span><h3>Выделить объект срезом</h3>'
      + '<div class="fpanel-actions"><button id="lxObjClose" class="icon-btn" type="button" data-ico="x" data-tip="Закрыть и сбросить срез" aria-label="Закрыть"></button></div></header>'
      + '<div class="fpanel-body lx-sec-body">'
      + '<p class="sec-note">Задайте плоскость среза, поймайте объект кликом и сохраните его отдельной моделью.</p>'
      + '<div id="lxObjAxis" class="seg-group lx-obj-axis" role="group" aria-label="Направление среза"></div>'
      + '<div class="lx-slice"><div class="lx-slice-row"><span>Начало среза</span><output id="lxObjLoV"></output></div>'
      + '<input id="lxObjLo" type="range" min="0" max="10000" step="1" aria-label="Начало среза">'
      + '<label class="lx-slice-coord">Координата, м<input id="lxObjLoCoord" type="number" step="0.001"></label></div>'
      + '<div class="lx-slice"><div class="lx-slice-row"><span>Конец среза</span><output id="lxObjHiV"></output></div>'
      + '<input id="lxObjHi" type="range" min="0" max="10000" step="1" aria-label="Конец среза">'
      + '<label class="lx-slice-coord">Координата, м<input id="lxObjHiCoord" type="number" step="0.001"></label></div>'
      + '<div id="lxObjSliceSummary" class="sec-note" role="status" aria-live="polite"></div>'
      + '<label class="lx-cp-check"><input id="lxObjSmart" type="checkbox">Умный захват — клик по объекту в срезе</label>'
      + '<div class="lx-obj-actions">'
      + '<button id="lxObjExtract" class="btn sm primary" type="button" data-ico="scissors">Извлечь объект</button>'
      + '<button id="lxObjAll" class="btn sm" type="button" data-ico="box-select">Выделить весь срез</button>'
      + '<button id="lxObjClear" class="btn sm" type="button" data-ico="eraser">Снять выделение</button>'
      + '<button id="lxObjReset" class="btn sm" type="button" data-ico="rotate-ccw">Сбросить срез</button></div>'
      + '<div class="lx-obj-h">Извлечённые объекты</div><div id="lxObjList" class="lx-obj-list" role="list"></div>'
      + '</div></div>';
    (document.getElementById('stageSideL') || document.querySelector('.stage') || document.body).appendChild(panel);

    var axisWrap = panel.querySelector('#lxObjAxis');
    [['y', 'План', 'Y'], ['x', 'Сбоку', 'X'], ['z', 'Фасад', 'Z']].forEach(function (a) {
      var b = el('button', 'hbtn', '<span class="lbl">' + a[1] + ' · ' + a[2] + '</span>'); b.dataset.axis = a[0]; b.type = 'button';
      b.setAttribute('aria-pressed', String(a[0] === state.axis)); b.classList.toggle('on', a[0] === state.axis); b.setAttribute('data-tip', axisLabel(a[0]));
      b.onclick = function () {
        state.axis = a[0];
        Array.prototype.forEach.call(axisWrap.children, function (c) { setOn(c, c.dataset.axis === state.axis); });
        syncRangeControls(); applySlice();
      };
      axisWrap.appendChild(b);
    });
    var lo = panel.querySelector('#lxObjLo'), hi = panel.querySelector('#lxObjHi');
    var loCoord = panel.querySelector('#lxObjLoCoord'), hiCoord = panel.querySelector('#lxObjHiCoord');
    syncRangeControls();
    lo.oninput = function () { setRange('lo', Number(lo.value) / 100); };
    hi.oninput = function () { setRange('hi', Number(hi.value) / 100); };
    loCoord.onchange = function () { setRangeFromCoordinate('lo', loCoord.value); };
    hiCoord.onchange = function () { setRangeFromCoordinate('hi', hiCoord.value); };
    var sm = panel.querySelector('#lxObjSmart'); sm.checked = state.smart; sm.onchange = function () { state.smart = sm.checked; };
    panel.querySelector('#lxObjClose').onclick = function () { close(); };
    panel.querySelector('#lxObjAll').onclick = function () {
      var v = V();
      if (v && v.selectInSlice) {
        var n = v.selectInSlice(); toast('Выделен весь срез: ' + nfmt(n) + ' т.', 'ok');
        var st = panel.querySelector('#lxObjSliceSummary'); if (st) st.textContent = 'Выделено точек в срезе: ' + nfmt(n) + ' · ' + axisLabel(state.axis);
      }
    };
    panel.querySelector('#lxObjReset').onclick = function () { var v = V(); if (v) { if (v.resetSection) v.resetSection(); if (v.setSection) v.setSection(false); if (v.clearSelection) v.clearSelection(); } };
    panel.querySelector('#lxObjClear').onclick = function () { var v = V(); if (v && v.clearSelection) { v.clearSelection(); toast('Выделение снято'); } };
    panel.querySelector('#lxObjExtract').onclick = function () {
      var v = V(); if (!v || !v.extractSelectionAsObject) return;
      if (!v.selectionCount || !v.selectionCount()) { toast('Сначала поймайте объект (клик в срезе) или «Выделить весь срез»', 'warn'); return; }
      var idx = (((v.getExtractedObjects && v.getExtractedObjects().length) || 0) + 1);
      var r = v.extractSelectionAsObject('Объект ' + idx);
      if (r) { toast('Объект извлечён: ' + nfmt(r.count) + ' т. — сохраните его как модель в списке ниже', 'ok'); refreshList(); }
      else toast('Не удалось извлечь объект', 'err');
    };
    if (window.__lxKit && window.__lxKit.hydrate) window.__lxKit.hydrate(panel);
    refreshList();
    return panel;
  }

  function isOpen() { return !!panel && panel.style.display !== 'none'; }
  function open() {
    build(); wireSmartClick();
    panel.style.display = 'block'; applySlice(); refreshList(); setOn(btn, true);
  }
  function close() {
    if (panel) panel.style.display = 'none';
    var v = V(); if (v) { if (v.resetSection) v.resetSection(); if (v.setSection) v.setSection(false); }
    setOn(btn, false);
  }
  function toggle() { if (isOpen()) close(); else open(); }

  function mountButton() {
    if (btn) return;
    btn = el('button', '', 'Сечение объекта');
    btn.type = 'button'; btn.id = 'lxObjExtractBtn';
    btn.setAttribute('data-tip', 'Срез облака, захват объекта и сохранение его отдельной моделью');
    btn.onclick = toggle;
    (document.getElementById('lxLegacy') || document.body).appendChild(btn);
  }

  function boot() { try { mountButton(); } catch (e) { console.warn('obj-extract boot', e); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.addEventListener('lx-viewer-ready', function () { try { wireSmartClick(); } catch (e) {} });
  window.addEventListener('lx-pctools-ready', boot);
  window.__lxObjectExtract = { open: open, close: close, toggle: toggle, build: build, refresh: refreshList, state: state, sourceCloud: sourceCloud };
})();
