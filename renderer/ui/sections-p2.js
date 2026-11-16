/* BIM Twin — r151 P2: «Профили / сечения».
 *  • горизонтальный срез облака (слайдер высоты, viewer.setSection/setSectionValue);
 *  • вертикальное сечение/сетка по линии (X1..X2 при Z=const) с профилем рельефа;
 *  • экспорт профиля по линии в PNG и TIFF (без внешних библиотек — несжатый RGB TIFF).
 * Отдельный слой (грузится из app.js через ui/sections-p2.js?v=151), r130/редизайн/P1 не тронуты.
 * API: window.__lxSections = { open, close, build, exportPNG, exportTIFF, profile, tiffRGB, _profileFromPoints }
 */
(function () {
  'use strict';
  var W = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
  var D = (typeof document !== 'undefined') ? document : null;
  var st = { mounted: false, open: false, canvas: null, profile: null, mode: 'horizontal' };

  function icon(n, s) { try { return W.__lxIcons && W.__lxIcons.svg ? W.__lxIcons.svg(n, s || 16) : ''; } catch (e) { return ''; } }
  function toast(m, tone) { try { if (W.__toast) W.__toast(m, tone); else if (W.__lxKit && W.__lxKit.toast) W.__lxKit.toast(m, { tone: tone }); } catch (e) { } }
  function $(id) { return D.getElementById(id); }
  function viewer() { return W.__viewer || W.__lxViewer || null; }
  function seedPos() {
    var v = viewer(); if (!v) return null;
    var b = v.base && v.base[0];
    if (b && b._stream && b._stream.pos && b._stream.filled) return b._stream.pos.subarray(0, b._stream.filled * 3);
    if (b && b.pos && b.pos.length) return b.pos;
    return null;
  }
  function bbox() { var v = viewer(); return (v && v.bbox) || { mn: [-1, 0, -1], mx: [1, 3, 1] }; }

  // Чистая функция: профиль по линии. pts — xyz-массив; линия (x1,z1)-(x2,z2); ширина полосы band.
  function profileFromPoints(pts, line, opts) {
    opts = opts || {};
    var x1 = +line.x1, z1 = +line.z1, x2 = +line.x2, z2 = +line.z2;
    var dx = x2 - x1, dz = z2 - z1, L = Math.hypot(dx, dz);
    if (!pts || !pts.length || !(L > 1e-9)) return { ok: false, reason: 'нет точек или нулевая линия', bins: [], length: L || 0 };
    var ux = dx / L, uz = dz / L, band = Math.max(0.01, +opts.band || 0.5), bins = Math.max(8, Math.min(2048, +opts.bins || 256));
    var ymin = opts.ymin, ymax = opts.ymax;
    if (!isFinite(ymin) || !isFinite(ymax)) { ymin = Infinity; ymax = -Infinity; }
    var min = new Float32Array(bins).fill(Infinity), max = new Float32Array(bins).fill(-Infinity), sum = new Float64Array(bins), cnt = new Uint32Array(bins);
    var used = 0;
    for (var i = 0; i + 2 < pts.length; i += 3) {
      var x = pts[i], y = pts[i + 1], z = pts[i + 2];
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
      var px = x - x1, pz = z - z1;
      var s = px * ux + pz * uz; if (s < 0 || s > L) continue;
      var perp = -px * uz + pz * ux; if (Math.abs(perp) > band / 2) continue;
      var bi = Math.min(bins - 1, Math.max(0, Math.floor(s / L * bins)));
      if (y < min[bi]) min[bi] = y; if (y > max[bi]) max[bi] = y; sum[bi] += y; cnt[bi]++;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y; used++;
    }
    var out = [];
    for (var k = 0; k < bins; k++) out.push({ s: (k + 0.5) / bins * L, count: cnt[k], min: cnt[k] ? +min[k].toFixed(3) : null, max: cnt[k] ? +max[k].toFixed(3) : null, mean: cnt[k] ? +(sum[k] / cnt[k]).toFixed(3) : null });
    return { ok: used > 0, bins: out, length: L, used: used, band: band, ymin: isFinite(ymin) ? ymin : null, ymax: isFinite(ymax) ? ymax : null };
  }

  // Несжатый RGB TIFF (little-endian), width×height, rgba — Uint8ClampedArray/Array.
  function tiffRGB(width, height, rgba) {
    var Wd = width | 0, Ht = height | 0;
    if (!(Wd > 0) || !(Ht > 0) || !rgba || rgba.length < Wd * Ht * 4) throw new Error('bad image');
    var pix = Wd * Ht * 3;
    var entries = 13, ifdOffset = 8;
    var extra = entries * 12 + 4;
    var bitsPos = ifdOffset + extra;                 // 6 байт (8,8,8)
    var stripPos = bitsPos + 6;                      // зарезервировано
    var xresPos = stripPos + 4;
    var yresPos = xresPos + 8;
    var pixPos = yresPos + 8;
    var out = new Uint8Array(pixPos + pix);
    var dv = new DataView(out.buffer);
    out[0] = 0x49; out[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, ifdOffset, true);
    dv.setUint16(ifdOffset, entries, true);
    var p = ifdOffset + 2;
    function ent(tag, type, count, value) { dv.setUint16(p, tag, true); dv.setUint16(p + 2, type, true); dv.setUint32(p + 4, count, true); dv.setUint32(p + 8, value, true); p += 12; }
    var bitsPos = ifdOffset + extra;                  // 6 байт
    var stripPos = bitsPos + 6;
    var xresPos = stripPos + 4;
    var yresPos = xresPos + 8;
    var pixPos = yresPos + 8;
    ent(256, 4, 1, Wd);            // ImageWidth
    ent(257, 4, 1, Ht);            // ImageLength
    ent(258, 3, 3, bitsPos);       // BitsPerSample → offset
    ent(259, 3, 1, 1);             // Compression none
    ent(262, 3, 1, 2);             // Photometric RGB
    ent(273, 4, 1, pixPos);        // StripOffsets
    ent(277, 3, 1, 3);             // SamplesPerPixel
    ent(278, 4, 1, Ht);            // RowsPerStrip
    ent(279, 4, 1, pix);           // StripByteCounts
    ent(282, 5, 1, xresPos);       // XResolution rational
    ent(283, 5, 1, yresPos);       // YResolution
    ent(284, 3, 1, 1);             // PlanarConfig
    ent(296, 3, 1, 2);             // ResolutionUnit inch
    dv.setUint32(p, 0, true);
    dv.setUint16(bitsPos, 8, true); dv.setUint16(bitsPos + 2, 8, true); dv.setUint16(bitsPos + 4, 8, true);
    dv.setUint32(xresPos, 72, true); dv.setUint32(xresPos + 4, 1, true);
    dv.setUint32(yresPos, 72, true); dv.setUint32(yresPos + 4, 1, true);
    var q = pixPos;
    for (var i = 0; i < Wd * Ht; i++) { out[q++] = rgba[i * 4]; out[q++] = rgba[i * 4 + 1]; out[q++] = rgba[i * 4 + 2]; }
    return out;
  }

  var CSS = [
    '.lx-sec-bar { position: fixed; left: 54px; bottom: 34px; z-index: 519; display: flex; gap: 6px; }',
    '.lx-sec-bar button { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--glass); color: var(--txt-2); font: 500 11px/1 var(--font); cursor: pointer; }',
    '.lx-sec-bar button:hover { color: var(--txt); border-color: var(--accent-line); }',
    '.lx-sec-panel { position: fixed; left: 54px; bottom: 70px; z-index: 520; width: 400px; max-width: calc(100vw - 28px); border: 1px solid var(--accent-line); border-radius: var(--r-3); background: var(--bg-1); color: var(--txt); box-shadow: var(--shadow-3); font: 11px/1.35 var(--font); }',
    '.lx-sec-panel[hidden] { display: none; }',
    '.lx-sec-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--line); background: var(--bg-2); }',
    '.lx-sec-head b { flex: 1; font-size: 11.5px; }',
    '.lx-sec-x { width: 22px; height: 22px; border: 0; border-radius: 6px; background: transparent; color: var(--txt-3); font: 600 15px/1 var(--font); cursor: pointer; }',
    '.lx-sec-body { display: flex; flex-direction: column; gap: 7px; padding: 9px 10px 10px; }',
    '.lx-sec-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }',
    '.lx-sec-row label { display: flex; align-items: center; gap: 5px; color: var(--txt-2); font-size: 10.5px; }',
    '.lx-sec-row input[type="number"], .lx-sec-row input[type="range"] { accent-color: var(--accent); }',
    '.lx-sec-row input[type="number"] { width: 74px; height: 24px; padding: 0 5px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg-2); color: var(--txt); font: 10.5px/1 var(--mono); }',
    '.lx-sec-row select { height: 24px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg-2); color: var(--txt); font: 10.5px/1 var(--font); }',
    '.lx-sec-seg { display: flex; gap: 4px; }',
    '.lx-sec-seg button { height: 24px; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--txt-2); font: 500 10px/1 var(--font); cursor: pointer; }',
    '.lx-sec-seg button.on { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent); }',
    '.lx-sec-canvas { width: 100%; height: 150px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg-2); display: block; }',
    '.lx-sec-actions { display: flex; gap: 6px; flex-wrap: wrap; }',
    '.lx-sec-actions button { height: 26px; padding: 0 9px; border: 1px solid var(--accent-line); border-radius: 6px; background: var(--accent-soft); color: var(--accent); font: 600 10.5px/1 var(--font); cursor: pointer; }',
    '.lx-sec-actions button.sub { border-color: var(--line); background: transparent; color: var(--txt-2); }',
    '.lx-sec-note { margin: 0; color: var(--txt-3); font-size: 9.5px; line-height: 1.4; }',
    '@media (max-width: 1100px) { .lx-sec-bar { display: none; } }'
  ].join('\n');
  function styles() { if (D.getElementById('lxSecStyles')) return; var s = D.createElement('style'); s.id = 'lxSecStyles'; s.textContent = CSS; (D.head || D.documentElement).appendChild(s); }

  function panel() {
    var p = $('lxSecPanel'); if (p) return p;
    styles();
    p = D.createElement('section'); p.className = 'lx-sec-panel'; p.id = 'lxSecPanel'; p.hidden = true; p.setAttribute('data-sec-panel', '1');
    p.innerHTML = '<div class="lx-sec-head"><span>' + icon('columns-2', 16) + '</span><b>Профили / сечения</b><button class="lx-sec-x" data-sec="close" aria-label="Закрыть">×</button></div>' +
      '<div class="lx-sec-body">' +
      '<div class="lx-sec-row lx-sec-seg"><button type="button" data-sec="mode-h" class="on">Горизонтальный срез</button><button type="button" data-sec="mode-v">Вертикальное сечение</button></div>' +
      '<div class="lx-sec-row" data-sec-h><label>Высота среза <input type="range" min="0" max="1" step="0.005" value="0.5" data-sec-z><output data-sec-z-out>50 %</output></label><button type="button" class="lx-sec-actions" data-sec="slice-on" style="height:24px;padding:0 8px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--txt-2);font:500 10px/1 var(--font);cursor:pointer">Вкл/выкл</button></div>' +
      '<div class="lx-sec-row" data-sec-v hidden><label>Линия: X1 <input type="number" step="0.1" data-sec-x1></label><label>Z1 <input type="number" step="0.1" data-sec-z1></label><label>X2 <input type="number" step="0.1" data-sec-x2></label><label>Z2 <input type="number" step="0.1" data-sec-z2></label></div>' +
      '<div class="lx-sec-row"><label>Полоса, м <input type="number" step="0.1" min="0.1" value="0.6" data-sec-band></label><button type="button" data-sec="build" style="height:26px;padding:0 9px;border:1px solid var(--accent-line);border-radius:6px;background:var(--accent-soft);color:var(--accent);font:600 10.5px/1 var(--font);cursor:pointer">Построить профиль</button></div>' +
      '<canvas class="lx-sec-canvas" data-sec-canvas width="640" height="300"></canvas>' +
      '<p class="lx-sec-note" data-sec-note>Горизонтальный срез режет облако по высоте; вертикальное сечение строит профиль по линии (X/Z) и экспортирует его в PNG/TIFF.</p>' +
      '<div class="lx-sec-actions"><button type="button" data-sec="png">Экспорт PNG</button><button type="button" data-sec="tiff" class="sub">Экспорт TIFF</button><button type="button" data-sec="grid" class="sub">Сетка вкл/выкл</button></div>' +
      '</div>';
    p.addEventListener('click', onClick);
    p.addEventListener('input', onInput);
    D.body.appendChild(p);
    return p;
  }
  function bar() {
    var b = $('lxSecBar'); if (b) return b;
    styles();
    b = D.createElement('div'); b.className = 'lx-sec-bar'; b.id = 'lxSecBar'; b.setAttribute('data-sec-bar', '1');
    b.innerHTML = '<button type="button" data-sec="open" title="Профили и сечения: горизонтальный срез, вертикальный профиль, экспорт PNG/TIFF">' + icon('columns-2', 15) + '<span>Профили / сечения</span></button>';
    b.addEventListener('click', onClick);
    D.body.appendChild(b);
    return b;
  }
  function note(t) { var p = panel(); var n = p.querySelector('[data-sec-note]'); if (n) n.textContent = t; }
  function openPanel() { styles(); panel().hidden = false; st.open = true; bar(); syncLineDefaults(); return true; }
  function closePanel() { var p = panel(); p.hidden = true; st.open = false; }
  function syncLineDefaults() {
    var p = panel(), b = bbox();
    function set(sel, val) { var e = p.querySelector(sel); if (e && !e.value) e.value = String(val); }
    set('[data-sec-x1]', (b.mn[0] + (b.mx[0] - b.mn[0]) * 0.15).toFixed(2));
    set('[data-sec-z1]', (b.mn[2] + (b.mx[2] - b.mn[2]) * 0.5).toFixed(2));
    set('[data-sec-x2]', (b.mn[0] + (b.mx[0] - b.mn[0]) * 0.85).toFixed(2));
    set('[data-sec-z2]', (b.mn[2] + (b.mx[2] - b.mn[2]) * 0.5).toFixed(2));
  }
  function currentLine() {
    var p = panel();
    function num(sel, d) { var e = p.querySelector(sel); var v = e ? parseFloat(e.value) : NaN; return isFinite(v) ? v : d; }
    return { x1: num('[data-sec-x1]', -5), z1: num('[data-sec-z1]', 0), x2: num('[data-sec-x2]', 5), z2: num('[data-sec-z2]', 0) };
  }
  function drawProfile(prof) {
    try {
      var p = panel(), c = p.querySelector('[data-sec-canvas]'); if (!c || !c.getContext) return;
      var ctx = c.getContext('2d'); if (!ctx) return;
      var Wd = c.width || 640, Ht = c.height || 300;
      ctx.clearRect(0, 0, Wd, Ht);
      ctx.fillStyle = 'rgba(28,27,26,0.9)'; ctx.fillRect(0, 0, Wd, Ht);
      var lo = Number(prof.ymin), hi = Number(prof.ymax);
      if (!isFinite(lo)) lo = 0; if (!isFinite(hi)) hi = lo + 1;
      if (hi - lo < 0.01) hi = lo + 1;
      function Y(y) { y = Number(y); if (!isFinite(y)) y = lo; return Ht - 8 - (y - lo) / (hi - lo) * (Ht - 16); }
      function X(k, n) { return 8 + k / Math.max(1, n - 1) * (Wd - 16); }
      var n = prof.bins.length;
      if (gridOn) {
        ctx.strokeStyle = 'rgba(167,139,250,0.28)'; ctx.lineWidth = 1;
        for (var gx = 0; gx <= 10; gx++) { var x = 8 + gx / 10 * (Wd - 16); ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, Ht - 4); ctx.stroke(); }
        for (var gy = 0; gy <= 5; gy++) { var y = 4 + gy / 5 * (Ht - 8); ctx.beginPath(); ctx.moveTo(4, y); ctx.lineTo(Wd - 4, y); ctx.stroke(); }
      }
      ctx.strokeStyle = '#a78bfa'; ctx.lineWidth = 2; ctx.beginPath();
      var started = false;
      for (var k = 0; k < n; k++) { var b = prof.bins[k]; if (!b || !b.count) continue; var yy = Y(b.mean); var xx = X(k, n); if (!started) { ctx.moveTo(xx, yy); started = true; } else ctx.lineTo(xx, yy); }
      ctx.stroke();
      ctx.fillStyle = 'rgba(167,139,250,0.25)';
      for (var k2 = 0; k2 < n; k2++) { var b2 = prof.bins[k2]; if (!b2 || !b2.count) continue; var x2 = X(k2, n), yl = Y(b2.max), yh = Y(b2.min); ctx.fillRect(x2 - 1, yl, 2, Math.max(1, yh - yl)); }
      ctx.fillStyle = '#cfc9d9'; ctx.font = '11px monospace';
      try { ctx.fillText('профиль: ' + (prof.used || 0) + ' точек, ' + (Number(prof.length) || 0).toFixed(1) + ' м, y ' + lo.toFixed(2) + '…' + hi.toFixed(2) + ' м', 10, 16); } catch (e2) { }
    } catch (e) { try { note('Не удалось нарисовать профиль: ' + ((e && e.message) || e)); } catch (e3) { } }
  }
  var gridOn = true;
  function build() {
    var pts = seedPos();
    if (!pts) { note('Нет точечных данных: откройте облако точек.'); toast('Профиль: откройте облако точек', 'warn'); return null; }
    var prof = profileFromPoints(pts, currentLine(), { band: parseFloat(panel().querySelector('[data-sec-band]').value) || 0.6, bins: 320 });
    st.profile = prof;
    drawProfile(prof);
    note(prof.ok ? ('Профиль по линии: ' + prof.used + ' точек, длина ' + prof.length.toFixed(1) + ' м, полоса ' + prof.band + ' м') : 'В полосе линии нет точек — увеличьте полосу или сдвиньте линию.');
    return prof;
  }
  function downloadBlob(blob, name) {
    try {
      var a = D.createElement('a'); var url = W.URL.createObjectURL(blob); a.href = url; a.download = name; D.body.appendChild(a); a.click();
      setTimeout(function () { try { D.body.removeChild(a); W.URL.revokeObjectURL(url); } catch (e) { } }, 300); return true;
    } catch (e) { return false; }
  }
  function exportPNG() {
    if (!st.profile) build(); if (!st.profile) return false;
    try {
      var c = panel().querySelector('[data-sec-canvas]');
      var a = D.createElement('a'); a.href = c.toDataURL('image/png'); a.download = 'profile-r151.png'; D.body.appendChild(a); a.click();
      setTimeout(function () { try { D.body.removeChild(a); } catch (e) { } }, 200);
      toast('Профиль сохранён: PNG'); return true;
    } catch (e) { toast('Не удалось сохранить PNG', 'warn'); return false; }
  }
  function exportTIFF() {
    if (!st.profile) build(); if (!st.profile) return false;
    try {
      var c = panel().querySelector('[data-sec-canvas]'), ctx = c.getContext('2d');
      var img = ctx.getImageData(0, 0, c.width, c.height);
      var bytes = tiffRGB(c.width, c.height, img.data);
      var ok = downloadBlob(new W.Blob([bytes], { type: 'image/tiff' }), 'profile-r151.tiff');
      if (ok) toast('Профиль сохранён: TIFF (RGB, без сжатия)');
      return ok;
    } catch (e) { toast('Не удалось сохранить TIFF: ' + ((e && e.message) || e), 'warn'); return false; }
  }
  function onClick(e) {
    var t = e.target && e.target.closest && e.target.closest('[data-sec]');
    if (!t) return;
    var a = t.getAttribute('data-sec');
    if (a === 'open') { openPanel(); return; }
    if (a === 'close') { closePanel(); return; }
    if (a === 'mode-h') { st.mode = 'horizontal'; applyMode(); return; }
    if (a === 'mode-v') { st.mode = 'vertical'; applyMode(); return; }
    if (a === 'slice-on') { toggleSlice(); return; }
    if (a === 'build') { build(); return; }
    if (a === 'png') { exportPNG(); return; }
    if (a === 'tiff') { exportTIFF(); return; }
    if (a === 'grid') { gridOn = !gridOn; if (st.profile) drawProfile(st.profile); return; }
  }
  function applyMode() {
    var p = panel();
    p.querySelector('[data-sec-h]').hidden = st.mode !== 'horizontal';
    p.querySelector('[data-sec-v]').hidden = st.mode !== 'vertical';
    Array.prototype.slice.call(p.querySelectorAll('[data-sec="mode-h"],[data-sec="mode-v"]')).forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-sec') === (st.mode === 'horizontal' ? 'mode-h' : 'mode-v')); });
  }
  function toggleSlice() {
    var v = viewer(); if (!v || !v.setSection) { toast('Сечение доступно в 3D-режиме', 'warn'); return false; }
    var isOn = !!(v.section && v.section.on);
    try { v.setSection(!isOn); } catch (e) { }
    var p = panel(), z = p.querySelector('[data-sec-z]');
    if (z) { try { v.setSectionValue(parseFloat(z.value)); } catch (e) { } }
    note(isOn ? 'Горизонтальный срез выключен.' : 'Горизонтальный срез включён — двигайте слайдер высоты.');
    return true;
  }
  function onInput(e) {
    var t = e.target;
    if (t && t.matches && t.matches('[data-sec-z]')) {
      var p = panel(), out = p.querySelector('[data-sec-z-out]'); if (out) out.textContent = Math.round(parseFloat(t.value) * 100) + ' %';
      var v = viewer(); if (v && v.setSectionValue) { try { v.setSectionValue(parseFloat(t.value)); } catch (e) { } }
    }
  }
  function mount() {
    if (st.mounted) return true; st.mounted = true;
    try { bar(); } catch (e) { }
    return true;
  }
  var API = { version: '151', mount: mount, open: openPanel, close: closePanel, build: build, exportPNG: exportPNG, exportTIFF: exportTIFF, tiffRGB: tiffRGB, profile: profileFromPoints, _profileFromPoints: profileFromPoints, state: function () { return { open: st.open, mode: st.mode, hasProfile: !!st.profile }; } };
  W.__lxSections = API;
  function boot() { try { if (!D || !D.body) { if (D) D.addEventListener('DOMContentLoaded', mount); return; } mount(); } catch (e) { } }
  boot();
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof globalThis !== 'undefined' && typeof window === 'undefined') { try { globalThis.__lxSections = API; } catch (e) { } }
})();
