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

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function setOn(b, on) { if (!b) return; b.classList.toggle('on', !!on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }

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
  function row(k, v) { return '<div class="lx-stat"><span>' + k + '</span><b>' + v + '</b></div>'; }
  function renderStats(m, dt) {
    if (!statsEl) return;
    var s = m.stats, st = m.storey;
    statsEl.innerHTML =
      '<div class="lx-stats-h"><span data-ico="circle-check"></span>Модель построена</div>' +
      row('Стен', s.wallCount) +
      row('Высота этажа', nfmt(st.height) + ' м') +
      row('Площадь пола', nfmt(s.floorArea) + ' м²') +
      row('Сумм. длина стен', nfmt(s.totalWallLength) + ' м') +
      row('Ср. RMS подгонки', nfmt(s.meanWallRms * 1000, 1) + ' мм') +
      row('Точек (вход/обр.)', s.pointsIn + ' / ' + s.pointsUsed) +
      (dt != null ? row('Время', nfmt(dt, 0) + ' мс') : '');
    if (window.__lxKit && window.__lxKit.hydrate) window.__lxKit.hydrate(statsEl);
  }

  function numField(label, key, step) {
    var wrap = el('label', 'lx-param');
    wrap.appendChild(el('span', null, label));
    var inp = document.createElement('input'); inp.type = 'number'; inp.step = step || '0.01'; inp.value = state.opts[key];
    inp.addEventListener('change', function () { var val = parseFloat(inp.value); if (isFinite(val)) state.opts[key] = val; });
    wrap.appendChild(inp); return wrap;
  }
  function chkField(label, key) {
    var wrap = el('label', 'lx-cp-check');
    var inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!state.opts[key];
    inp.addEventListener('change', function () { state.opts[key] = inp.checked; });
    wrap.appendChild(inp); wrap.appendChild(document.createTextNode(label)); return wrap;
  }
  function actBtn(label, ico, cls, fn) {
    var b = el('button', 'btn sm' + (cls ? ' ' + cls : '')); b.type = 'button'; b.setAttribute('data-ico', ico); b.textContent = label; b.onclick = fn; return b;
  }

  function buildPanel() {
    if (panel) return panel;
    panel = el('section', 'fpanel fp-left'); panel.id = 'lxScan2BimPanel'; panel.setAttribute('aria-label', 'Скан → BIM'); panel.setAttribute('data-esc', '1');
    panel.style.display = 'none';
    panel.innerHTML = '<div class="fpanel-inner"><header class="fpanel-head"><span class="fpanel-ico" data-ico="building"></span><h3>Скан → BIM</h3>' +
      '<div class="fpanel-actions"><button id="lxScan2BimClose" class="icon-btn" type="button" data-panel-close data-ico="x" data-tip="Закрыть" aria-label="Закрыть"></button></div></header>' +
      '<div class="fpanel-body lx-sec-body"></div></div>';
    var body = panel.querySelector('.fpanel-body');
    body.appendChild(el('p', 'sec-note', 'Реконструкция стен, пола и потолка по облаку точек.'));
    body.appendChild(numField('Воксель, м', 'voxel'));
    body.appendChild(numField('Порог стены, м', 'wallThreshold'));
    body.appendChild(numField('Мин. длина стены, м', 'minWallLen'));
    body.appendChild(numField('Толщина по умолч., м', 'defaultThickness'));
    body.appendChild(chkField('Выравнивать углы (90°)', 'snapAngles'));
    body.appendChild(chkField('Замыкать углы', 'closeCorners'));

    var bBuild = actBtn('Построить BIM', 'building', 'primary', build); bBuild.id = 'lxScan2BimBuildBtn';
    body.appendChild(bBuild);
    statusEl = el('div', 'sec-note', ''); statusEl.setAttribute('role', 'status'); statusEl.setAttribute('aria-live', 'polite');
    body.appendChild(statusEl);
    statsEl = el('div', 'lx-stats'); body.appendChild(statsEl);

    body.appendChild(el('div', 'lx-obj-h', 'Экспорт'));
    var exp = el('div', 'lx-btnrow');
    exp.appendChild(actBtn('IFC', 'download', '', function () { exportModel('ifc'); }));
    exp.appendChild(actBtn('OBJ', 'download', '', function () { exportModel('obj'); }));
    exp.appendChild(actBtn('DXF', 'download', '', function () { exportModel('dxf'); }));
    exp.appendChild(actBtn('Убрать каркас', 'eraser', '', function () { clearPreview(mainV()); }));
    body.appendChild(exp);
    panel.querySelector('#lxScan2BimClose').onclick = close;
    (document.getElementById('stageSideL') || document.querySelector('.stage') || document.body).appendChild(panel);
    if (window.__lxKit && window.__lxKit.hydrate) window.__lxKit.hydrate(panel);
    return panel;
  }
  var btn = null;
  function open() { buildPanel().style.display = 'block'; setOn(btn, true); }
  function close() { if (panel) panel.style.display = 'none'; clearPreview(mainV()); setOn(btn, false); }

  function mountButton() {
    if (document.getElementById('lxScan2BimBtn')) return;
    btn = el('button', '', 'Скан → BIM');
    btn.type = 'button'; btn.id = 'lxScan2BimBtn';
    btn.setAttribute('data-tip', 'Распознать стены, проёмы и плиты по облаку');
    btn.onclick = function () { if (panel && panel.style.display === 'block') close(); else open(); };
    (document.getElementById('lxLegacy') || document.body).appendChild(btn);
  }

  function boot() { try { mountButton(); } catch (e) { console.error('[scan2bim] boot', e); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.addEventListener('lx-viewer-ready', boot);
  window.addEventListener('lx-pctools-ready', boot);

  window.__lxScan2BIM = { open: open, close: close, build: build, exportModel: exportModel, state: state };
})();
