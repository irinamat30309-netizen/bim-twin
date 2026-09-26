/*
 * lixel-object-extract.js — v1153
 * FARO-подобное «Выделить объект срезом»: горизонтальный/вертикальный срез облака,
 * умный захват нужного объекта, извлечение его как отдельной модели и сохранение (PLY / открыть как облако).
 * Отдельная кнопка + компактная панель. Аддитивно — остальной UI не трогает.
 */
(function () {
  'use strict';
  var panel = null, btn = null, state = { axis: 'y', ranges: { x: { lo: 49, hi: 51 }, y: { lo: 49, hi: 51 }, z: { lo: 49, hi: 51 } }, smart: true, wired: false };

  function V() { try { return (window.__pcTools && window.__pcTools.viewer && window.__pcTools.viewer()) || window.__viewer || null; } catch (e) { return null; } }
  function API() { try { return (window.__pcTools && window.__pcTools.api && window.__pcTools.api()) || window.API || null; } catch (e) { return null; } }
  function toast(m) { try { if (window.__pcTools && window.__pcTools.toast) return window.__pcTools.toast(m); } catch (e) {} try { console.log('[obj-extract]', m); } catch (e) {} }
  function el(tag, css, html) { var d = document.createElement(tag); if (css) d.style.cssText = css; if (html != null) d.innerHTML = html; return d; }
  function btnCss(bg) { return 'background:' + bg + ';color:#fff;border:0;border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer'; }
  var TONE = { blue: 'var(--lx-blue)', green: 'var(--lx-green)', red: 'var(--lx-red)', orange: 'var(--lx-orange)', purple: 'var(--lx-purple)', neutral: 'var(--lx-neutral)' };
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
      catch (e) { toast(e && e.message ? e.message : 'Не удалось применить срез'); }
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
    if (!objs.length) { wrap.appendChild(el('div', 'color:var(--muted);font-size:12px;padding:6px 2px', 'Пока нет извлечённых объектов')); return; }
    objs.forEach(function (o) {
      var row = el('div', 'display:flex;align-items:center;gap:6px;padding:4px 0;border-top:1px solid var(--line)');
      var nm = el('div', 'flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', (o.name || o.id) + ' · ' + nfmt(o.count) + ' т.');
      var bMeas = el('button', btnCss(TONE.purple), '📐'); bMeas.title = 'Открыть объект в окне измерения (инспектор)';
      var bOpen = el('button', btnCss(TONE.blue), 'Открыть'); bOpen.title = 'Открыть объект как активную модель';
      var bPly = el('button', btnCss(TONE.green), 'PLY'); bPly.title = 'Сохранить объект в PLY';
      var bDel = el('button', btnCss(TONE.red), '✕'); bDel.title = 'Удалить объект';
      bMeas.onclick = function () { try { var c = v.getExtractedObjectCloud && v.getExtractedObjectCloud(o.id); if (window.__lxObjectInspector && c) window.__lxObjectInspector.openWithCloud(c, o.name || o.id); else toast('Инспектор недоступен'); } catch (e) { toast('Не удалось открыть инспектор'); } };
      bOpen.onclick = function () { if (v.loadExtractedObjectAsCloud && v.loadExtractedObjectAsCloud(o.id)) toast('Объект открыт как модель: ' + (o.name || o.id)); };
      bPly.onclick = function () { savePly(o.id, o.name); };
      bDel.onclick = function () { if (v.removeExtractedObject) v.removeExtractedObject(o.id); refreshList(); };
      row.appendChild(nm); row.appendChild(bMeas); row.appendChild(bOpen); row.appendChild(bPly); row.appendChild(bDel);
      wrap.appendChild(row);
    });
  }

  async function savePly(id, name) {
    var v = V(); if (!v || !v.getExtractedObjectCloud) return;
    var c = v.getExtractedObjectCloud(id); if (!c || !c.pos || !c.pos.length) { toast('Пустой объект'); return; }
    var src = sourceCloud(c, v), bytes, stop = null;
    try {
      if (window.__pcTools && window.__pcTools.beginProgress) stop = window.__pcTools.beginProgress('Экспорт PLY объекта…');
      if (window.ExportHub && window.ExportHub.exportPLYAsync) bytes = await window.ExportHub.exportPLYAsync(src, function (f) { if (stop && stop.set) stop.set(f, 'Кодирование PLY…'); });
      else if (window.ExportHub && window.ExportHub.exportPLY) bytes = window.ExportHub.exportPLY(src);
      else bytes = fallbackPLYDouble(src);
    } catch (e) { toast('Ошибка формирования PLY: ' + (e && e.message ? e.message : 'неизвестная ошибка')); return; }
    finally { try { if (stop) stop(); } catch (e) {} }
    var fname = (name ? String(name).replace(/[^\w\-]+/g, '_') : 'object') + '.ply';
    var api = API();
    if (api && api.saveCloud) {
      try { var r = await api.saveCloud({ binary: bytes, name: fname }); if (r && r.ok) toast('Сохранено: ' + r.path); else if (!(r && r.canceled)) toast('Ошибка сохранения'); }
      catch (e) { toast('Ошибка сохранения'); }
    } else {
      try { var blob = new Blob([bytes], { type: 'application/octet-stream' }); var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname; a.click(); toast('PLY скачан: ' + fname); }
      catch (e) { toast('Сохранение недоступно'); }
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
      setTimeout(function () { var n = 0; try { n = vv.smartObjectAt(_cx, _cy, { maxPts: 500000 }); } catch (err) {} try { if (_t) _t(); } catch (e2) {} toast(n ? ('Захвачено точек объекта: ' + nfmt(n) + ' — нажмите «Извлечь объект»') : 'Объект не найден — кликните по нему в срезе'); }, 30);
    });
  }

  function build() {
    if (panel) return panel;
    panel = el('div', '', ''); panel.className = 'lx-tool-panel'; panel.style.cssText = 'right:16px;top:96px;width:294px;max-height:calc(100vh - 130px);overflow-y:auto;padding:12px;display:none';
    panel.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><div style="font-weight:700;font-size:14px;flex:1">✂️ Выделить объект (срез)</div><button id="lxObjClose" style="background:var(--panel2);border:0;color:var(--txt);border-radius:6px;width:24px;height:24px;cursor:pointer">✕</button></div>'
      + '<div style="font-size:12px;color:var(--muted);margin-bottom:6px">Срез как в FARO: задайте плоскость, поймайте объект и сохраните его отдельной моделью.</div>'
      + '<div style="display:flex;gap:6px;margin-bottom:8px" id="lxObjAxis" role="group" aria-label="Направление среза"></div>'
      + '<div style="font-size:12px;margin:2px 0">Начало среза · <span id="lxObjLoV"></span></div><input id="lxObjLo" type="range" min="0" max="10000" step="1" aria-label="Начало среза" style="width:100%">'
      + '<label style="display:flex;align-items:center;gap:8px;font-size:12px;margin:2px 0 8px">Координата, м<input id="lxObjLoCoord" type="number" step="0.001" style="width:110px;margin-left:auto"></label>'
      + '<div style="font-size:12px;margin:6px 0 2px">Конец среза · <span id="lxObjHiV"></span></div><input id="lxObjHi" type="range" min="0" max="10000" step="1" aria-label="Конец среза" style="width:100%">'
      + '<label style="display:flex;align-items:center;gap:8px;font-size:12px;margin:2px 0 8px">Координата, м<input id="lxObjHiCoord" type="number" step="0.001" style="width:110px;margin-left:auto"></label>'
      + '<div id="lxObjSliceSummary" role="status" style="font-size:11px;color:var(--muted);line-height:1.45;margin:6px 0 8px"></div>'
      + '<label style="display:flex;align-items:center;gap:8px;margin:10px 0;font-size:13px;cursor:pointer"><input id="lxObjSmart" type="checkbox"> Умный захват (клик по объекту в срезе)</label>'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"><button id="lxObjAll" style="' + btnCss(TONE.neutral) + '">Выделить весь срез</button><button id="lxObjExtract" style="' + btnCss(TONE.blue) + '">Извлечь объект</button><button id="lxObjReset" style="' + btnCss(TONE.neutral) + '">Сброс среза</button><button id="lxObjClear" style="' + btnCss(TONE.orange) + '">Снять выделение</button></div>'
      + '<div style="font-weight:600;font-size:12px;margin:6px 0 2px">Извлечённые объекты</div><div id="lxObjList"></div>';
    document.body.appendChild(panel);

    var axisWrap = panel.querySelector('#lxObjAxis');
    [['y', 'Горизонт.'], ['x', 'Вертик. X'], ['z', 'Вертик. Z']].forEach(function (a) {
      var b = el('button', btnCss(a[0] === state.axis ? TONE.blue : TONE.neutral) + ';flex:1', a[1]); b.dataset.axis = a[0]; b.type = 'button'; b.setAttribute('aria-pressed', String(a[0] === state.axis)); b.title = axisLabel(a[0]);
      b.onclick = function () { state.axis = a[0]; Array.prototype.forEach.call(axisWrap.children, function (c) { var active = c.dataset.axis === state.axis; c.style.background = active ? TONE.blue : TONE.neutral; c.setAttribute('aria-pressed', String(active)); }); syncRangeControls(); applySlice(); };
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
    panel.querySelector('#lxObjAll').onclick = function () { var v = V(); if (v && v.selectInSlice) { var n = v.selectInSlice(); toast('Выделен весь срез: ' + nfmt(n) + ' т.'); var st = panel.querySelector('#lxObjSliceSummary'); if (st) st.textContent = 'Выделено точек в срезе: ' + nfmt(n) + ' · ' + axisLabel(state.axis); } };
    panel.querySelector('#lxObjReset').onclick = function () { var v = V(); if (v) { if (v.resetSection) v.resetSection(); if (v.setSection) v.setSection(false); if (v.clearSelection) v.clearSelection(); } };
    panel.querySelector('#lxObjClear').onclick = function () { var v = V(); if (v && v.clearSelection) { v.clearSelection(); toast('Выделение снято'); } };
    panel.querySelector('#lxObjExtract').onclick = function () {
      var v = V(); if (!v || !v.extractSelectionAsObject) return;
      if (!v.selectionCount || !v.selectionCount()) { toast('Сначала поймайте объект (клик в срезе) или «Выделить весь срез»'); return; }
      var idx = (((v.getExtractedObjects && v.getExtractedObjects().length) || 0) + 1);
      var r = v.extractSelectionAsObject('Объект ' + idx);
      if (r) { toast('Объект извлечён: ' + nfmt(r.count) + ' т. — сохраните как модель ниже'); refreshList(); }
      else toast('Не удалось извлечь объект');
    };
    refreshList();
    return panel;
  }

  function open() { build(); wireSmartClick(); panel.style.display = 'block'; applySlice(); refreshList(); if (btn) btn.classList.add('on'); }
  function close() { if (panel) panel.style.display = 'none'; var v = V(); if (v) { if (v.resetSection) v.resetSection(); if (v.setSection) v.setSection(false); } if (btn) btn.classList.remove('on'); }
  function toggle() { if (panel && panel.style.display === 'block') close(); else open(); }

  function mountButton() {
    if (btn) return;
    btn = el('button', '', '✂️ Объект (срез)');
    btn.className = 'lx-tool-btn'; btn.style.cssText = 'right:16px;top:56px';
    btn.id = 'lxObjExtractBtn'; btn.title = 'FARO-подобное выделение объекта срезом и сохранение как модель';
    btn.onclick = toggle;
    document.body.appendChild(btn);
  }

  function boot() { try { mountButton(); } catch (e) { console.warn('obj-extract boot', e); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.addEventListener('lx-viewer-ready', function () { try { wireSmartClick(); } catch (e) {} });
  window.addEventListener('lx-pctools-ready', boot);
  window.__lxObjectExtract = { open: open, close: close, toggle: toggle, build: build, refresh: refreshList, state: state, sourceCloud: sourceCloud };
})();
