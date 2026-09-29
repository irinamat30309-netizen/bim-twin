/*
 * lixel-scan2bim-ui.js — v1155
 * UI для Scan-to-BIM: кнопка + панель параметров, построение BIM из активного облака,
 * предпросмотр стен/плит накладкой в 3D и экспорт IFC/OBJ/DXF.
 * window.__lxScan2BIM = { open, close, build, exportModel, state }.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  var state = { model: null, opts: { voxel: 0.03, wallThreshold: 0.05, minWallLen: 0.4, defaultThickness: 0.15, snapAngles: true, closeCorners: true }, previewOn: true };

  function mainV() { try { if (window.__pcTools && window.__pcTools.viewer) return window.__pcTools.viewer(); } catch (e) {} return window.__viewer || null; }
  function toast(msg, err) { try { if (window.__toast) return window.__toast(msg, err ? 'error' : 'info'); } catch (e) {} console[err ? 'error' : 'log']('[scan2bim] ' + msg); }
  function nfmt(x, d) { return (x == null || !isFinite(x)) ? '—' : (+x).toFixed(d == null ? 2 : d); }

  function el(tag, css, html) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (html != null) e.innerHTML = html; return e; }
  function bcss(bg) { return 'display:inline-flex;align-items:center;gap:6px;justify-content:center;padding:7px 10px;margin:3px 3px 0 0;border:none;border-radius:8px;background:' + bg + ';color:#fff;font:600 12px/1.1 system-ui,Segoe UI,Arial;cursor:pointer'; }
  var TONE = { blue: 'var(--lx-blue)', green: 'var(--lx-green)', purple: 'var(--lx-purple)', orange: 'var(--lx-orange)', neutral: 'var(--lx-neutral)' };

  // --------- чтение активного облака (все точки базы) ---------
  function collectPoints(v) {
    if (!v || !v.base) return null;
    var chunks = [], total = 0;
    for (var i = 0; i < v.base.length; i++) { var o = v.base[i]; if (o && o.points && o.pos && o.pos.length) { chunks.push(o.pos); total += o.pos.length; } }
    if (!total) return null;
    if (chunks.length === 1) return chunks[0];
    var out = new Float32Array(total), off = 0;
    for (var c = 0; c < chunks.length; c++) { out.set(chunks[c], off); off += chunks[c].length; }
    return out;
  }

  // --------- предпросмотр: каркас стен + контур пола накладкой ---------
  function boxEdgesXform(cx, cy, cz, ax, ay, hx, hy, hz, out) {
    var nx = -ay, nz = ax;
    function V(sx, sy, sz) { return [cx + ax * sx * hx + nx * sz * hz, cy + sy * hy, cz + ay * sx * hx + nz * sz * hz]; }
    var c = [V(-1, -1, -1), V(1, -1, -1), V(1, -1, 1), V(-1, -1, 1), V(-1, 1, -1), V(1, 1, -1), V(1, 1, 1), V(-1, 1, 1)];
    var E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (var i = 0; i < E.length; i++) { var a = c[E[i][0]], b = c[E[i][1]]; out.push(a[0], a[1], a[2], b[0], b[1], b[2]); }
  }
  function showPreview(v, model) {
    if (!v || !v._setOverlay || !model || !model.ok) return;
    var objs = [];
    var wpos = [];
    (model.walls || []).forEach(function (w) {
      var mx = (w.a[0] + w.b[0]) / 2, mz = (w.a[1] + w.b[1]) / 2, L = Math.hypot(w.dir[0], w.dir[1]) || 1;
      boxEdgesXform(mx, w.base + w.height / 2, mz, w.dir[0] / L, w.dir[1] / L, w.length / 2, w.height / 2, w.thickness / 2, wpos);
    });
    if (wpos.length) objs.push({ line: true, gkind: 'wire', pos: new Float32Array(wpos), color: [0.2, 0.85, 1] });
    var foot = model.footprint || [];
    var fpos = [];
    for (var i = 0; i < foot.length; i++) {
      var a = foot[i], b = foot[(i + 1) % foot.length];
      fpos.push(a[0], model.storey.floorY, a[1], b[0], model.storey.floorY, b[1]);
      fpos.push(a[0], model.storey.ceilY, a[1], b[0], model.storey.ceilY, b[1]);
    }
    if (fpos.length) objs.push({ line: true, gkind: 'wire', pos: new Float32Array(fpos), color: [1, 0.75, 0.2] });
    try { v._setOverlay(objs); v.render && v.render(); } catch (e) {}
  }
  function clearPreview(v) { try { v && v._setOverlay && v._setOverlay([]); v && v.render && v.render(); } catch (e) {} }

  // --------- построение ---------
  function build() {
    var v = mainV();
    if (!v) { toast('Нет активного вьюера', true); return null; }
    if (!window.Scan2BIM) { toast('Движок Scan2BIM не загружен', true); return null; }
    var pts = collectPoints(v);
    if (!pts) { toast('Сначала откройте облако точек', true); return null; }
    setStatus('Считаю геометрию…');
    var _stop = (window.__pcTools && window.__pcTools.beginProgress) ? window.__pcTools.beginProgress('Построение BIM…') : null;
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    setTimeout(function () {
      var model;
      try { model = window.Scan2BIM.reconstruct(pts, state.opts); }
      catch (e) { try { if (_stop) _stop(); } catch (e2) {} toast('Ошибка реконструкции: ' + (e && e.message || e), true); setStatus('Ошибка'); return; }
      var dt = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
      try { if (_stop) _stop(); } catch (e2) {}
      if (!model || !model.ok) { toast((model && model.error) || 'Не удалось построить', true); setStatus((model && model.error) || 'Нет результата'); return; }
      state.model = model;
      if (state.previewOn) showPreview(v, model);
      renderStats(model, dt);
      toast('BIM построен: стен ' + model.stats.wallCount);
    }, 30);
    return null;
  }

  // --------- экспорт ---------
  function download(text, name, mime) {
    try {
      var blob = new Blob([text], { type: mime || 'text/plain' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 400);
    } catch (e) { toast('Не удалось сохранить: ' + (e && e.message || e), true); }
  }
  function exportModel(fmt) {
    var m = state.model; if (!m || !m.ok) { toast('Сначала постройте модель', true); return; }
    var S = window.Scan2BIM;
    if (fmt === 'ifc') {
      download(S.toIFC(m, { name: 'scan2bim.ifc', includeBeams: false, includePipes: false }), 'scan2bim.ifc', 'application/x-step');
      var skipped = [], stats = m.stats || {};
      if (stats.beamCount) skipped.push('балок ' + stats.beamCount);
      if (stats.pipeCount) skipped.push('труб ' + stats.pipeCount);
      if (stats.cableCount) skipped.push('кабелей ' + stats.cableCount);
      toast('IFC4 сохранён; непроверенные авто-кандидаты не включены' + (skipped.length ? ': ' + skipped.join(', ') : ''));
    }
    else if (fmt === 'obj') download(S.toOBJ(m), 'scan2bim.obj', 'text/plain');
    else if (fmt === 'dxf') download(S.toDXF(m, { includeCandidates: false }), 'scan2bim.dxf', 'application/dxf');
  }

  // --------- панель ---------
  var panel = null, statusEl = null, statsEl = null;
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }
  function renderStats(m, dt) {
    if (!statsEl) return;
    var s = m.stats, st = m.storey;
    statsEl.innerHTML =
      '<div style="font:600 12px system-ui;color:var(--ok);margin-bottom:4px">✅ Модель построена</div>' +
      row('Стен', s.wallCount) +
      row('Высота этажа', nfmt(st.height) + ' м') +
      row('Площадь пола', nfmt(s.floorArea) + ' м²') +
      row('Сумм. длина стен', nfmt(s.totalWallLength) + ' м') +
      row('Ср. RMS подгонки', nfmt(s.meanWallRms * 1000, 1) + ' мм') +
      row('Точек (вход/обр.)', s.pointsIn + ' / ' + s.pointsUsed) +
      (dt != null ? row('Время', nfmt(dt, 0) + ' мс') : '');
  }
  function row(k, v) { return '<div style="display:flex;justify-content:space-between;gap:8px;font:12px system-ui;color:var(--muted);padding:1px 0"><span>' + k + '</span><b style="color:var(--txt)">' + v + '</b></div>'; }

  function numField(label, key, step) {
    var wrap = el('label', 'display:flex;align-items:center;justify-content:space-between;gap:8px;font:12px system-ui;color:var(--muted);margin:4px 0');
    wrap.appendChild(el('span', null, label));
    var inp = document.createElement('input'); inp.type = 'number'; inp.step = step || '0.01'; inp.value = state.opts[key];
    inp.style.cssText = 'width:78px;padding:4px 6px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--txt);font:12px system-ui';
    inp.addEventListener('change', function () { var val = parseFloat(inp.value); if (isFinite(val)) state.opts[key] = val; });
    wrap.appendChild(inp); return wrap;
  }
  function chkField(label, key) {
    var wrap = el('label', 'display:flex;align-items:center;gap:8px;font:12px system-ui;color:var(--muted);margin:4px 0;cursor:pointer');
    var inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!state.opts[key];
    inp.addEventListener('change', function () { state.opts[key] = inp.checked; });
    wrap.appendChild(inp); wrap.appendChild(el('span', null, label)); return wrap;
  }

  function buildPanel() {
    if (panel) return panel;
    panel = el('div', ''); panel.className = 'lx-tool-panel'; panel.style.cssText = 'left:14px;bottom:92px;width:280px;max-height:calc(100vh - 130px);overflow-y:auto;padding:12px;display:none';
    var head = el('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px');
    head.appendChild(el('div', 'font:700 13px system-ui;color:var(--txt)', '🏗 Скан → BIM'));
    var x = el('button', 'border:none;background:transparent;color:var(--muted);font-size:18px;cursor:pointer;line-height:1', '×'); x.onclick = close; head.appendChild(x);
    panel.appendChild(head);
    panel.appendChild(el('div', 'font:11px system-ui;color:var(--muted);margin-bottom:6px', 'Высокоточная реконструкция стен, пола и потолка из облака точек.'));
    panel.appendChild(numField('Воксель, м', 'voxel'));
    panel.appendChild(numField('Порог стены, м', 'wallThreshold'));
    panel.appendChild(numField('Мин. длина стены, м', 'minWallLen'));
    panel.appendChild(numField('Толщина по умолч., м', 'defaultThickness'));
    panel.appendChild(chkField('Выравнивать углы (90°)', 'snapAngles'));
    panel.appendChild(chkField('Замыкать углы', 'closeCorners'));

    var bBuild = el('button', bcss(TONE.blue) + ';width:100%;margin-top:8px', '🏗 Построить BIM'); bBuild.id = 'lxScan2BimBuildBtn'; bBuild.onclick = build;
    panel.appendChild(bBuild);
    statusEl = el('div', 'font:11px system-ui;color:var(--muted);margin-top:6px;min-height:14px', '');
    panel.appendChild(statusEl);
    statsEl = el('div', 'margin-top:8px'); panel.appendChild(statsEl);

    panel.appendChild(el('div', 'height:1px;background:var(--line);margin:10px 0'));
    panel.appendChild(el('div', 'font:600 11px system-ui;color:var(--muted);margin-bottom:2px', 'ЭКСПОРТ'));
    var exp = el('div', 'display:flex;flex-wrap:wrap');
    var bIfc = el('button', bcss(TONE.green), 'IFC'); bIfc.onclick = function () { exportModel('ifc'); };
    var bObj = el('button', bcss(TONE.purple), 'OBJ'); bObj.onclick = function () { exportModel('obj'); };
    var bDxf = el('button', bcss(TONE.orange), 'DXF'); bDxf.onclick = function () { exportModel('dxf'); };
    var bClr = el('button', bcss(TONE.neutral), 'Очистить'); bClr.onclick = function () { clearPreview(mainV()); };
    exp.appendChild(bIfc); exp.appendChild(bObj); exp.appendChild(bDxf); exp.appendChild(bClr);
    panel.appendChild(exp);
    document.body.appendChild(panel);
    return panel;
  }
  function open() { buildPanel().style.display = 'block'; }
  function close() { if (panel) panel.style.display = 'none'; clearPreview(mainV()); }

  function mountButton() {
    if (document.getElementById('lxScan2BimBtn')) return;
    var b = el('button', 'position:fixed;left:14px;bottom:52px;z-index:99998;' + bcss(TONE.green), '🏗 Скан→BIM');
    b.id = 'lxScan2BimBtn';
    b.onclick = function () { if (panel && panel.style.display === 'block') close(); else open(); };
    document.body.appendChild(b);
  }

  function boot() { try { mountButton(); } catch (e) { console.error('[scan2bim] boot', e); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.addEventListener('lx-viewer-ready', boot);
  window.addEventListener('lx-pctools-ready', boot);

  window.__lxScan2BIM = { open: open, close: close, build: build, exportModel: exportModel, state: state };
})();
