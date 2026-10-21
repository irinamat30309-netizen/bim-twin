/*
 * cloud-preview.js — окно «Перед загрузкой» (ревизия 27): карта площадки и параметры загрузки облака, как в Lixel Studio / CoPre.
 *
 * До загрузки облака в видеопамять главный процесс читает равномерную выборку файла (bim:cloudOverview, cloud-overview.js) и
 * траекторию сканера (poses.csv) — окно показывает:
 *   - карту сверху (плотность / высота / цвет / интенсивность) с маршрутом сканера, стартом и финишем, масштабной линейкой;
 *   - сведения: длительность съёмки, длина пути, площадь, габариты, число точек, плотность, сканер и программа;
 *   - мощность компьютера (видеопамять, оперативная память) и рекомендуемое число точек;
 *   - параметры загрузки: число точек (ползунок), область на карте, диапазон высот и этажи, участок маршрута и дальность от него,
 *     удаление шума, окраска после загрузки; живая оценка, сколько точек будет загружено;
 *   - план из облака в DXF (renderer/auto-plan.js в потоке main) и PDF-отчёт (renderer/cloud-report.js).
 * Файл облака не меняется: фильтры действуют только на чтение (cloud-segments.filterSegment).
 *
 *   CloudPreview.maybeOpen(path, { label, force }) → Promise<null | { cancelled } | { maxPoints, filter, estimate, colorMode }>
 *   CloudPreview.afterLoad(pre, result) — окраска после загрузки; CloudPreview.lastFor(path) — параметры прошлой загрузки
 *   CloudPreview.openNext() — следующий выбор облака откроется с картой (команда «Карта перед загрузкой»)
 *   CloudPreview.report() / CloudPreview.planDxf() — для открытого облака
 *   чистые функции (тесты): sliderToPoints, pointsToSlider, estimate, storeys, routeMaskJS, niceScale, turbo
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudPreview = api;
})(typeof window !== 'undefined' ? window : null, function (W) {
  'use strict';

  // ------------------------------------------------------------------ чистые функции
  var MIN_POINTS = 1000000;
  function sliderToPoints(x, total) {   // x 0..1000 → точки (логарифмическая шкала 1 млн … все)
    var lo = Math.min(MIN_POINTS, total), hi = Math.max(lo, total);
    if (hi <= lo) return hi;
    var v = lo * Math.pow(hi / lo, Math.max(0, Math.min(1000, x)) / 1000);
    return x >= 1000 ? hi : Math.round(v);
  }
  function pointsToSlider(p, total) {
    var lo = Math.min(MIN_POINTS, total), hi = Math.max(lo, total);
    if (hi <= lo) return 1000;
    return Math.max(0, Math.min(1000, Math.round(1000 * Math.log(Math.max(lo, Math.min(hi, p)) / lo) / Math.log(hi / lo))));
  }
  // клетки не дальше radius от участка маршрута [from, to] (доли времени 0..1) — для оценки числа точек в окне
  function routeMaskJS(route, bbox, radius, from, to) {
    if (!route || route.length < 8) return null;
    var R = Math.max(0.5, +radius || 10), cell = Math.max(0.25, R / 12);
    var u0 = bbox.u0 - 1, v0 = bbox.v0 - 1, nx = Math.max(1, Math.ceil((bbox.u1 - bbox.u0 + 2) / cell)), ny = Math.max(1, Math.ceil((bbox.v1 - bbox.v0 + 2) / cell));
    if (nx * ny > 8e6) { cell *= Math.sqrt(nx * ny / 8e6); nx = Math.ceil((bbox.u1 - bbox.u0 + 2) / cell); ny = Math.ceil((bbox.v1 - bbox.v0 + 2) / cell); }
    var dist = new Float32Array(nx * ny).fill(Infinity), q = [], m = route.length / 4, j, s;
    function seed(u, v) { var cx = Math.floor((u - u0) / cell), cy = Math.floor((v - v0) / cell); if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) return; var c = cy * nx + cx; if (dist[c] !== 0) { dist[c] = 0; q.push(c); } }
    for (j = 0; j < m; j++) {
      var t = route[j * 4 + 3]; if (t < from || t > to) continue;
      seed(route[j * 4], route[j * 4 + 1]);
      if (j + 1 < m && route[(j + 1) * 4 + 3] <= to) {
        var ua = route[j * 4], va = route[j * 4 + 1], ub = route[(j + 1) * 4], vb = route[(j + 1) * 4 + 1], k = Math.ceil(Math.hypot(ub - ua, vb - va) / (cell * 0.5));
        for (s = 1; s < k; s++) seed(ua + (ub - ua) * s / k, va + (vb - va) * s / k);
      }
    }
    var rc = R / cell;
    for (var qi = 0; qi < q.length; qi++) {
      var c = q[qi], d = dist[c], x = c % nx, y = (c - x) / nx;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        var X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= nx || Y >= ny) continue;
        var nd = d + (dx && dy ? Math.SQRT2 : 1); if (nd > rc) continue;
        var kk = Y * nx + X; if (nd < dist[kk]) { dist[kk] = nd; q.push(kk); }
      }
    }
    var bits = new Uint8Array(nx * ny); for (var i = 0; i < nx * ny; i++) if (dist[i] <= rc) bits[i] = 1;
    return { u0: u0, v0: v0, cell: cell, nx: nx, ny: ny, bits: bits };
  }
  // доля точек выборки (u, v, h), проходящих фильтр; оценка числа точек после фильтра
  function estimate(pts, total, f, mask) {
    if (!pts || !pts.length) return { frac: 1, points: total };
    var n = pts.length / 3, pass = 0, r = f && f.rect, h = f && f.h;
    for (var i = 0; i < n; i++) {
      var u = pts[i * 3], v = pts[i * 3 + 1], z = pts[i * 3 + 2];
      if (r && (u < r.u0 || u > r.u1 || v < r.v0 || v > r.v1)) continue;
      if (h && (z < h.min || z > h.max)) continue;
      if (mask) { var cx = Math.floor((u - mask.u0) / mask.cell), cy = Math.floor((v - mask.v0) / mask.cell); if (cx < 0 || cy < 0 || cx >= mask.nx || cy >= mask.ny || !mask.bits[cy * mask.nx + cx]) continue; }
      pass++;
    }
    var frac = pass / n;
    return { frac: frac, points: Math.round(total * frac), sample: pass };
  }
  // этажи. По маршруту сканера (если есть): сканер идёт на высоте 0,4–2,3 м над полом, поэтому пол каждого этажа —
  // самый большой горизонтальный уровень в этом окне под высотой маршрута, потолок — самый большой уровень над ней.
  // Без маршрута: этаж — крупный уровень (≥ 35 % площади наибольшего), над которым есть ещё ≥ 1,8 м облака;
  // соседние уровни ближе 0,6 м — одно перекрытие (потолок ниже + пол выше). Верх облака — по ядру (без одиночных выбросов).
  function storeys(levels, bbox, route) {
    var L = (levels || []).slice().sort(function (a, b) { return a.h - b.h; });
    if (!L.length) return [];
    bbox = bbox || {};
    var top = bbox.core && isFinite(bbox.core.h1) ? bbox.core.h1 : bbox.h1;
    var maxA = L.reduce(function (m, x) { return Math.max(m, x.area || 0); }, 0) || 1;
    var bigOf = function (lo, hi, minA) { var best = null; L.forEach(function (l) { if (l.h > lo && l.h < hi && (l.area || 0) >= minA && (!best || (l.area || 0) > (best.area || 0))) best = l; }); return best; };
    var out = [], i;
    var walks = route && route.length >= 32 ? walkLevels(route) : [];
    if (walks.length) {
      var fl = [];
      walks.forEach(function (hr) { var f = bigOf(hr - 2.3, hr - 0.3, maxA * 0.1); if (f && !fl.some(function (x) { return Math.abs(x.h - f.h) < 0.5; })) fl.push({ h: f.h, area: f.area || 0, walk: hr }); });
      fl.sort(function (a, b) { return a.h - b.h; });
      for (i = 0; i < fl.length; i++) {
        var nf = fl[i + 1], c = bigOf(fl[i].walk + 0.3, nf ? nf.h - 0.05 : Infinity, maxA * 0.1);
        var ceil = c ? c.h : null;
        out.push({ name: 'Этаж ' + (i + 1), floor: fl[i].h, ceiling: ceil, min: fl[i].h - 0.1, max: ceil != null ? ceil + 0.1 : (nf ? nf.h - 0.1 : (top != null ? top : fl[i].h + 3)) + (nf ? 0 : 0.1), area: fl[i].area, walk: fl[i].walk });
      }
      if (out.length) return out;
    }
    var big = L.filter(function (l) { return (l.area || 0) >= maxA * 0.35; });
    var slabs = [], cur = null;
    big.forEach(function (l) { if (cur && l.h - cur.top <= 0.6) { cur.top = l.h; cur.items.push(l); } else { cur = { bottom: l.h, top: l.h, items: [l] }; slabs.push(cur); } });
    for (i = 0; i < slabs.length; i++) {
      var floorH = slabs[i].top, next = null;
      for (var j = i + 1; j < slabs.length; j++) if (slabs[j].bottom - floorH >= 1.6) { next = slabs[j]; break; }
      var roof = next ? next.bottom : top;
      if (roof == null || roof - floorH < 1.6) continue;   // ниже 1,6 м — не этаж (антресоль, приямок, кровля)
      out.push({ name: 'Этаж ' + (out.length + 1), floor: floorH, ceiling: next ? next.bottom : null, min: floorH - 0.1, max: roof + 0.1,
        area: slabs[i].items.reduce(function (m, x) { return Math.max(m, x.area || 0); }, 0) });
      if (next) i = slabs.indexOf(next) - 1;
    }
    return out;
  }
  // высоты, на которых сканер шёл по этажу (пики высот маршрута; лестницы между ними — редкие значения)
  function walkLevels(route) {
    var m = route.length / 4, hs = [], i;
    for (i = 0; i < m; i++) { var h = route[i * 4 + 2]; if (isFinite(h)) hs.push(h); }
    if (hs.length < 8) return [];
    var lo = Math.min.apply(null, hs), bin = 0.25, nb = Math.floor((Math.max.apply(null, hs) - lo) / bin) + 1, cnt = new Array(nb).fill(0);
    hs.forEach(function (h) { cnt[Math.floor((h - lo) / bin)]++; });
    var mx = Math.max.apply(null, cnt), out = [], run = null;
    for (i = 0; i <= nb; i++) {
      var on = i < nb && cnt[i] >= Math.max(3, mx * 0.08);
      if (on) { if (!run) run = []; run.push(i); }
      else if (run) {
        var a = lo + run[0] * bin, b = lo + (run[run.length - 1] + 1) * bin, sel = hs.filter(function (h) { return h >= a && h < b; }).sort(function (x, y) { return x - y; });
        if (sel.length) out.push(sel[Math.floor(sel.length / 2)]);
        run = null;
      }
    }
    return out;
  }
  function ovRoute(ov) { var tr = ov && ov.trajectory; return tr && tr.route && tr.aligned !== false ? tr.route : null; }
  function niceScale(px, metersPerPx) {   // длина масштабной линейки: 1, 2, 5 × 10^k метров около px пикселей
    var m = px * metersPerPx, p = Math.pow(10, Math.floor(Math.log10(Math.max(1e-9, m)))), best = p;
    [1, 2, 5, 10].forEach(function (k) { if (k * p <= m) best = k * p; });
    return best;
  }
  function turbo(t) {   // палитра высот (приближение Turbo), t 0..1 → [r, g, b]
    t = Math.max(0, Math.min(1, t));
    var r = 34.61 + t * (1172.33 - t * (10793.56 - t * (33300.12 - t * (38394.49 - t * 14825.05))));
    var g = 23.31 + t * (557.33 + t * (1225.33 - t * (3574.96 - t * (1073.77 + t * 707.56))));
    var b = 27.2 + t * (3211.1 - t * (15327.97 - t * (27814 - t * (22569.18 - t * 6838.66))));
    return [Math.max(0, Math.min(255, r)) | 0, Math.max(0, Math.min(255, g)) | 0, Math.max(0, Math.min(255, b)) | 0];
  }
  function fmtInt(n) { return Math.round(+n || 0).toLocaleString('ru-RU'); }
  function fmtMln(n) { n = +n || 0; return n >= 1e7 ? Math.round(n / 1e6).toLocaleString('ru-RU') : (n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 }); }
  function fmtNum(x, d) { return (+x || 0).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function fmtBytes(b) { b = +b || 0; return b >= 1073741824 ? fmtNum(b / 1073741824, 1) + ' ГБ' : fmtNum(b / 1048576, 0) + ' МБ'; }
  function fmtDur(s) { s = Math.max(0, Math.round(+s || 0)); var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60; return (h ? h + ' ч ' : '') + (h || m ? m + ' мин ' : '') + ss + ' с'; }
  // сведения об облаке для окна и отчёта: [подпись, значение]
  function facts(ov) {
    var f = ov.file || {}, st = ov.stats || {}, tr = ov.trajectory, rows = [];
    rows.push(['Файл', f.name || '']);
    rows.push(['Формат', (f.format || '') + ' · ' + fmtBytes(f.size)]);
    rows.push(['Точек в файле', fmtInt(f.points)]);
    if (f.system || f.software) rows.push(['Сканер / программа', [f.system, f.software].filter(Boolean).join(' · ')]);
    if (f.created) rows.push(['Дата съёмки (из файла)', f.created]);
    if (tr) {
      rows.push(['Длительность съёмки', fmtDur(tr.duration)]);
      rows.push(['Длина пути сканера', fmtNum(tr.length, 1) + ' м']);
      rows.push(['Средняя скорость', fmtNum(tr.speed, 2) + ' м/с']);
      rows.push(['Старт — финиш', fmtNum(tr.loopGap, 2) + ' м' + (tr.loopGap < 1 ? ' (маршрут замкнут)' : '')]);
    } else if (ov.time && ov.time.duration > 0 && ov.time.duration < 86400) rows.push(['Длительность съёмки (по времени точек)', fmtDur(ov.time.duration)]);
    rows.push(['Габариты (Ш × Г × В)', fmtNum(st.w, 2) + ' × ' + fmtNum(st.d, 2) + ' × ' + fmtNum(st.h, 2) + ' м']);
    rows.push(['Площадь застройки (вид сверху)', fmtNum(st.footprint, 1) + ' м²']);
    rows.push(['Площадь поверхностей', '≈ ' + fmtNum(st.surface, 0) + ' м²']);
    rows.push(['Плотность', fmtInt(st.perM2) + ' точек/м² плана · шаг ≈ ' + fmtNum((st.spacing || 0) * 1000, 1) + ' мм']);
    if (ov.stations && ov.stations.length) rows.push(['Станции сканов', String(ov.stations.length)]);
    rows.push(['Атрибуты', ['XYZ', f.colored ? 'цвет RGB' : '', f.intensity ? 'интенсивность' : '', f.classification ? 'классы' : '', f.crs ? 'система координат' : ''].filter(Boolean).join(', ')]);
    return rows;
  }

  var pure = { sliderToPoints: sliderToPoints, pointsToSlider: pointsToSlider, routeMaskJS: routeMaskJS, estimate: estimate, storeys: storeys, walkLevels: walkLevels,
    niceScale: niceScale, turbo: turbo, facts: facts, fmtMln: fmtMln, fmtNum: fmtNum, fmtDur: fmtDur, fmtBytes: fmtBytes };
  if (!W || typeof document === 'undefined') return pure;

  // ------------------------------------------------------------------ окно
  var D = document;
  var LS_MODE = 'bim.preloadWindow', LS_POINTS = 'bim.preloadPoints', LARGE = 20000000;
  var forceNext = false, lastPre = new Map(), lastOv = new Map(), capacity = null, capacityAt = 0;
  function api() { return W.bimAPI || null; }
  function kit() { return W.__lxKit || null; }
  function toast(m, err) { var k = kit(); if (k && k.toast) { try { return k.toast(m, err ? { tone: 'err' } : undefined); } catch (_) {} } try { console.log('[preview] ' + m); } catch (_) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ic(n, s) { var k = kit(); return k && k.ic ? k.ic(n, s || 16) : ''; }
  function viewer() { try { return (W.__pcTools && W.__pcTools.viewer && W.__pcTools.viewer()) || W.__viewer || null; } catch (_) { return W.__viewer || null; } }
  function mode() { try { return localStorage.getItem(LS_MODE) || 'always'; } catch (_) { return 'always'; } }
  function jobId() { return 'ov-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function glRenderer() {
    try { var c = D.createElement('canvas'), gl = c.getContext('webgl2') || c.getContext('webgl'); if (!gl) return ''; var e = gl.getExtension('WEBGL_debug_renderer_info'); return String(e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); } catch (_) { return ''; }
  }
  async function getCapacity() {
    var A = api(); if (!A || !A.systemCapacity) return null;
    if (capacity && Date.now() - capacityAt < 60000) return capacity;
    try { var r = await A.systemCapacity({ renderer: glRenderer() }); if (r && r.ok) { capacity = r; capacityAt = Date.now(); W.__bimPcCapacity = r; } } catch (_) {}
    return capacity;
  }
  function baseName(p) { return String(p || '').split(/[\\/]/).pop(); }
  function joinPath(dir, name) { var sep = String(dir).indexOf('\\') >= 0 ? '\\' : '/'; return String(dir).replace(/[\\/]+$/, '') + sep + name; }
  function stem(p) { return baseName(p).replace(/\.[^.]+$/, ''); }

  // карта: изображение сетки в выбранной окраске (для окна и отчёта)
  function gridImage(ov, how, hf) {
    var g = ov.grid, nx = g.nx, ny = g.ny, cv = D.createElement('canvas'); cv.width = nx; cv.height = ny;
    var cx = cv.getContext('2d'), img = cx.createImageData(nx, ny), px = img.data, i, c, y, x, k;
    var core = ov.bbox.core || ov.bbox, h0 = hf ? hf.min : core.h0, h1 = hf ? hf.max : core.h1;
    if (hf && ov.pts) {
      // плотность точек выбранного диапазона высот — по выборке окна (клетка крупнее, чтобы выборки хватало)
      var n = ov.pts.length / 3, f = Math.max(1, Math.min(8, Math.round(Math.sqrt(nx * ny * 0.25 / Math.max(1, n * 0.3))))), cnt = new Uint32Array(nx * ny), mx = 1;
      for (i = 0; i < n; i++) {
        var hz = ov.pts[i * 3 + 2]; if (hz < hf.min || hz > hf.max) continue;
        x = Math.floor((ov.pts[i * 3] - g.u0) / g.cell / f) * f; y = Math.floor((ov.pts[i * 3 + 1] - g.v0) / g.cell / f) * f;
        if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
        k = y * nx + x; cnt[k]++; if (cnt[k] > mx) mx = cnt[k];
      }
      for (y = 0; y < ny; y++) for (x = 0; x < nx; x++) {
        var b = cnt[Math.floor(y / f) * f * nx + Math.floor(x / f) * f]; if (!b) continue;
        var t = Math.log(1 + b) / Math.log(1 + mx), o = ((ny - 1 - y) * nx + x) * 4;
        px[o] = 40 + 200 * t; px[o + 1] = 90 + 160 * t; px[o + 2] = 160 + 95 * t; px[o + 3] = 255;
      }
      cx.putImageData(img, 0, 0); return cv;
    }
    var maxC = 1; for (i = 0; i < nx * ny; i++) if (g.count[i] > maxC) maxC = g.count[i];
    var lmax = Math.log(1 + maxC);
    for (c = 0; c < nx * ny; c++) {
      var cntc = g.count[c]; if (!cntc) continue;
      x = c % nx; y = (c - x) / nx; var o2 = ((ny - 1 - y) * nx + x) * 4, rgb;
      if (how === 'height') rgb = turbo((g.hmax[c] - h0) / Math.max(0.01, h1 - h0));
      else if (how === 'rgb' && g.rgb) rgb = [g.rgb[c * 3], g.rgb[c * 3 + 1], g.rgb[c * 3 + 2]];
      else if (how === 'intensity' && g.inten) { var iv = g.inten[c]; rgb = [iv, iv, iv]; }
      else { var tt = Math.log(1 + cntc) / lmax; rgb = [30 + 210 * tt, 70 + 180 * tt, 120 + 135 * tt]; }
      px[o2] = rgb[0]; px[o2 + 1] = rgb[1]; px[o2 + 2] = rgb[2]; px[o2 + 3] = 255;
    }
    cx.putImageData(img, 0, 0); return cv;
  }
  // вид карты: метры → пиксели холста
  function fitView(ov, w, h, pad) {
    var g = ov.grid, W0 = g.nx * g.cell, H0 = g.ny * g.cell, s = Math.min((w - 2 * pad) / W0, (h - 2 * pad) / H0);
    return { s: s, ox: (w - W0 * s) / 2, oy: (h - H0 * s) / 2, u0: g.u0, v1: g.v0 + H0,
      to: function (u, v) { return [this.ox + (u - this.u0) * this.s, this.oy + (this.v1 - v) * this.s]; },
      from: function (X, Y) { return [this.u0 + (X - this.ox) / this.s, this.v1 - (Y - this.oy) / this.s]; } };
  }
  // отрисовка карты со слоями: маршрут, область, план, линейка, север
  function drawMap(cv, ov, st, opt) {
    opt = opt || {};
    var dpr = opt.dpr || 1, w = cv.width / dpr, h = cv.height / dpr, cx = cv.getContext('2d');
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.fillStyle = opt.bg || '#0f141b'; cx.fillRect(0, 0, w, h);
    var vw = fitView(ov, w, h, 24), g = ov.grid;
    if (!st._img || st._imgKey !== st.view + '|' + (st.hf ? st.hf.min + ':' + st.hf.max : '')) { st._img = gridImage(ov, st.view, st.view === 'density' ? st.hf : null); st._imgKey = st.view + '|' + (st.hf ? st.hf.min + ':' + st.hf.max : ''); }
    cx.imageSmoothingEnabled = false;
    cx.drawImage(st._img, vw.ox, vw.oy, g.nx * g.cell * vw.s, g.ny * g.cell * vw.s);
    // вне области — притушено
    if (st.rect) {
      var a = vw.to(st.rect.u0, st.rect.v1), b = vw.to(st.rect.u1, st.rect.v0);
      cx.save(); cx.fillStyle = 'rgba(8,10,14,.55)'; cx.beginPath(); cx.rect(0, 0, w, h); cx.rect(a[0], a[1], b[0] - a[0], b[1] - a[1]); cx.fill('evenodd');
      cx.setLineDash([6, 4]); cx.strokeStyle = '#ffd166'; cx.lineWidth = 1.5; cx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); cx.setLineDash([]);
      cx.fillStyle = '#ffd166'; cx.font = '600 12px Inter, Arial, sans-serif';
      cx.fillText(fmtNum(st.rect.u1 - st.rect.u0, 2) + ' × ' + fmtNum(st.rect.v1 - st.rect.v0, 2) + ' м', a[0] + 4, a[1] - 6);
      cx.restore();
    }
    // маршрут сканера: цвет по времени (зелёный — начало, красный — конец), выбранный участок ярче
    var tr = ov.trajectory;
    if (tr && tr.route && tr.aligned !== false && st.showRoute !== false) {
      var R = tr.route, m = R.length / 4, from = st.route ? st.route.from : 0, to = st.route ? st.route.to : 1;
      cx.lineCap = 'round'; cx.lineJoin = 'round';
      cx.strokeStyle = 'rgba(0,0,0,.55)'; cx.lineWidth = 4.5; cx.beginPath();
      for (var j = 0; j < m; j++) { var p = vw.to(R[j * 4], R[j * 4 + 1]); if (j) cx.lineTo(p[0], p[1]); else cx.moveTo(p[0], p[1]); }
      cx.stroke();
      for (var k = 1; k < m; k++) {
        var t = R[k * 4 + 3], on = !st.route || (t >= from && t <= to);
        var p0 = vw.to(R[(k - 1) * 4], R[(k - 1) * 4 + 1]), p1 = vw.to(R[k * 4], R[k * 4 + 1]);
        cx.strokeStyle = on ? 'hsl(' + Math.round(120 - 120 * t) + ',85%,55%)' : 'rgba(160,170,185,.35)'; cx.lineWidth = on ? 2.4 : 1.4;
        cx.beginPath(); cx.moveTo(p0[0], p0[1]); cx.lineTo(p1[0], p1[1]); cx.stroke();
      }
      var s0 = vw.to(R[0], R[1]), s1 = vw.to(R[(m - 1) * 4], R[(m - 1) * 4 + 1]);
      cx.fillStyle = '#22c55e'; cx.strokeStyle = '#fff'; cx.lineWidth = 1.5; cx.beginPath(); cx.arc(s0[0], s0[1], 6, 0, Math.PI * 2); cx.fill(); cx.stroke();
      cx.fillStyle = '#ef4444'; cx.fillRect(s1[0] - 5, s1[1] - 5, 10, 10); cx.strokeRect(s1[0] - 5, s1[1] - 5, 10, 10);
      cx.font = '600 11px Inter, Arial, sans-serif'; cx.fillStyle = '#e8edf5';
      cx.fillText('Старт', s0[0] + 9, s0[1] - 8); cx.fillText('Финиш', s1[0] + 9, s1[1] + 14);
    }
    // станции сканов E57 (позы сканов): белые ромбы с номером
    if (ov.stations && ov.stations.length > 1 && ov.stations.length <= 500) {
      cx.font = '600 10px Inter, Arial, sans-serif'; cx.lineWidth = 1.5;
      ov.stations.forEach(function (sn, i) {
        var q = vw.to(sn.u, sn.v);
        cx.fillStyle = '#f8fafc'; cx.strokeStyle = '#0f141b'; cx.beginPath();
        cx.moveTo(q[0], q[1] - 5); cx.lineTo(q[0] + 5, q[1]); cx.lineTo(q[0], q[1] + 5); cx.lineTo(q[0] - 5, q[1]); cx.closePath(); cx.fill(); cx.stroke();
        if (ov.stations.length <= 60) { cx.fillStyle = '#e8edf5'; cx.fillText(String(i + 1), q[0] + 7, q[1] - 5); }
      });
    }
    // план из облака поверх карты
    if (st.plan && st.plan.ok) {
      // мебель и стеллажи у стен (второй срез) — тонкие серые линии под стенами
      cx.strokeStyle = 'rgba(148,163,184,.75)'; cx.lineWidth = 1;
      (st.plan.low || []).forEach(function (f) { var a1 = vw.to(f.a[0], f.a[1]), b1 = vw.to(f.b[0], f.b[1]); cx.beginPath(); cx.moveTo(a1[0], a1[1]); cx.lineTo(b1[0], b1[1]); cx.stroke(); });
      cx.strokeStyle = '#38bdf8'; cx.lineWidth = 2;
      st.plan.faces.forEach(function (f) { var a1 = vw.to(f.a[0], f.a[1]), b1 = vw.to(f.b[0], f.b[1]); cx.beginPath(); cx.moveTo(a1[0], a1[1]); cx.lineTo(b1[0], b1[1]); cx.stroke(); });
      cx.strokeStyle = '#fb923c'; cx.setLineDash([4, 3]);
      st.plan.openings.forEach(function (f) { var a1 = vw.to(f.a[0], f.a[1]), b1 = vw.to(f.b[0], f.b[1]); cx.beginPath(); cx.moveTo(a1[0], a1[1]); cx.lineTo(b1[0], b1[1]); cx.stroke(); });
      cx.setLineDash([]); cx.fillStyle = '#e0f2fe'; cx.font = '600 11px Inter, Arial, sans-serif'; cx.textAlign = 'center';
      st.plan.rooms.forEach(function (r) { var c0 = vw.to(r.center[0], r.center[1]); cx.fillText(r.name + ' · ' + fmtNum(r.area, 2) + ' м²', c0[0], c0[1]); });
      cx.textAlign = 'left';
    }
    // масштабная линейка и север
    var L = niceScale(120, 1 / vw.s), lp = L * vw.s, x0 = 16, y0 = h - 18;
    cx.fillStyle = 'rgba(8,10,14,.7)'; cx.fillRect(x0 - 8, y0 - 22, lp + 70, 32);
    cx.strokeStyle = '#e8edf5'; cx.lineWidth = 2; cx.beginPath(); cx.moveTo(x0, y0 - 5); cx.lineTo(x0, y0); cx.lineTo(x0 + lp, y0); cx.lineTo(x0 + lp, y0 - 5); cx.stroke();
    cx.fillStyle = '#e8edf5'; cx.font = '600 11px Inter, Arial, sans-serif'; cx.fillText((L >= 1 ? fmtNum(L, 0) + ' м' : fmtNum(L * 100, 0) + ' см'), x0 + lp + 8, y0 + 1);
    if (ov.origin && ov.origin.zup) { var nxp = w - 26, nyp = 60; cx.beginPath(); cx.moveTo(nxp, nyp - 14); cx.lineTo(nxp - 7, nyp + 6); cx.lineTo(nxp, nyp + 2); cx.lineTo(nxp + 7, nyp + 6); cx.closePath(); cx.fill(); cx.fillText('С', nxp - 4, nyp + 20); }
    if (opt.drag) {
      var d0 = vw.to(opt.drag.u0, opt.drag.v1), d1 = vw.to(opt.drag.u1, opt.drag.v0);
      cx.strokeStyle = '#ffd166'; cx.lineWidth = 1.5; cx.strokeRect(d0[0], d0[1], d1[0] - d0[0], d1[1] - d0[1]);
    }
    return vw;
  }
  // снимок карты для отчёта
  function mapImage(ov, how, extra) {
    var cv = D.createElement('canvas'); cv.width = 1400; cv.height = Math.round(1400 * Math.min(1.2, Math.max(0.45, (ov.grid.ny / ov.grid.nx)))) ;
    drawMap(cv, ov, Object.assign({ view: how, showRoute: true }, extra || {}), { dpr: 1 });
    return cv.toDataURL('image/png');
  }
  W.__cloudPreviewMap = mapImage;

  // ------------------------------------------------------------------ окно «Перед загрузкой»
  function openDialog(path, ov, cap, label) {
    return new Promise(function (resolve) {
      var total = ov.file.points, rec = cap && cap.recommendation ? cap.recommendation : null;
      var budget = W.__bimGpuPointBudget ? W.__bimGpuPointBudget() : 300000000;
      var saved = 0; try { saved = Number(localStorage.getItem(LS_POINTS)) || 0; } catch (_) {}
      var recPts = rec ? rec.points : budget, safePts = rec ? rec.safeMax : budget;
      var st = { view: ov.grid.rgb && ov.file.colored ? 'rgb' : 'density', rect: null, hf: null, route: null, radius: 15, noise: 'none',
        color: ov.file.colored ? 'rgb' : 'elev', points: Math.min(total, saved >= 1e6 ? saved : Math.min(recPts, budget)), showRoute: true, plan: null };
      var tr = ov.trajectory, hasRoute = !!(tr && tr.route && tr.aligned !== false), floors = storeys(ov.levels, ov.bbox, ovRoute(ov));
      var back = D.createElement('div'); back.className = 'modal bp-modal';
      var F = ov.file || {}, S = ov.stats || {};
      // плитки сверху панели: главное о скане одним взглядом (подробности — во вкладке «Сведения»)
      var kpis = [[fmtMln(total), 'млн точек', fmtInt(total) + ' точек в файле'], [fmtNum(S.footprint, 0), 'м² плана', 'Площадь застройки (вид сверху)'],
        tr ? [fmtNum(tr.length, 0), 'м · ' + fmtDur(tr.duration).replace(/ \d+ с$/, ''), 'Путь сканера и длительность съёмки'] : [fmtNum(S.h, 1), 'м высота', 'Высота облака'],
        [fmtNum((S.spacing || 0) * 1000, (S.spacing || 0) < 0.01 ? 1 : 0), 'мм шаг', 'Средний шаг точек']];
      var noiseSeg = [['none', 'Нет', 'Шум не удалять'], ['low', 'Слабо', 'Убрать одиночные точки (воксель 15 см)'], ['mid', 'Средне', 'Воксель 10 см, не меньше 3 точек'], ['high', 'Сильно', 'Воксель 8 см, не меньше 5 точек']];
      back.innerHTML =
        '<div class="modal-card bp-card" role="dialog" aria-modal="true" aria-labelledby="bpTitle">' +
        '<div class="modal-head"><span id="bpTitle">' + esc(label || baseName(path)) + '</span><span class="bp-headsub">' + esc((F.format || '') + ' · ' + fmtBytes(F.size)) + '</span>' +
          '<button type="button" class="x" data-ico="x" aria-label="Закрыть"></button></div>' +
        '<div class="bp-body">' +
          '<div class="bp-mapcol">' +
            '<div class="bp-map"><canvas></canvas>' +
              '<div class="bp-over bp-tl"><div class="bp-seg" role="group" aria-label="Окраска карты">' +
                '<button type="button" data-view="density">Плотность</button><button type="button" data-view="height">Высота</button>' +
                (ov.grid.rgb ? '<button type="button" data-view="rgb">Цвет</button>' : '') + (ov.grid.inten ? '<button type="button" data-view="intensity">Интенсивность</button>' : '') +
              '</div></div>' +
              '<div class="bp-over bp-tr">' +
                (hasRoute ? '<label class="bp-pill" title="Показать маршрут сканера"><input type="checkbox" data-k="showRoute" checked><span>Маршрут</span></label>' : '') +
                '<button type="button" class="bp-pill" data-act="clearRect" title="Сбросить рамку — вся площадь">' + ic('map', 14) + '<span>Вся площадь</span></button>' +
              '</div>' +
              '<div class="bp-maphint">Рамка мышью — область загрузки</div>' +
            '</div>' +
          '</div>' +
          '<div class="bp-side">' +
            '<div class="bp-kpis">' + kpis.map(function (k) { return '<div class="bp-kpi" title="' + esc(k[2]) + '"><b>' + esc(k[0]) + '</b><span>' + esc(k[1]) + '</span></div>'; }).join('') + '</div>' +
            '<div class="bp-tabs" role="tablist"><button type="button" role="tab" data-tab="load" class="on">Загрузка</button><button type="button" role="tab" data-tab="info">Сведения</button></div>' +
            '<div class="bp-pane" data-pane="load">' +
              '<section><h4>Точки на экране</h4><div class="bp-pts">' +
                '<div class="bp-ptsval"><b></b><span></span></div>' +
                '<div class="bp-range"><input type="range" min="0" max="1000" step="1" aria-label="Число точек"><i class="bp-mk rec" title="Рекомендовано для этого компьютера"></i><i class="bp-mk max" title="Наибольшее надёжное"></i></div>' +
                '<div class="bp-seg bp-presets" role="group" aria-label="Предел точек"><button type="button" data-pre="fast" title="До 20 млн точек — быстро">Быстро</button><button type="button" data-pre="rec" title="Рекомендовано для этого компьютера">Рекоменд.</button><button type="button" data-pre="max" title="Наибольшее надёжное для этого компьютера">Максимум</button><button type="button" data-pre="all" title="Все точки файла">Все</button></div>' +
                '<p class="bp-warn" hidden></p></div></section>' +
              '<section><h4>Высота</h4><canvas class="bp-hist" height="56"></canvas>' +
                '<div class="bp-floors"></div>' +
                '<div class="bp-row"><label>от <input type="number" step="0.05" data-k="hmin"></label><label>до <input type="number" step="0.05" data-k="hmax"> м</label><button type="button" class="btn xs ghost" data-act="clearH" title="Все высоты">Сброс</button></div></section>' +
              (hasRoute ? '<section><h4>Маршрут</h4>' +
                '<div class="bp-row"><label class="bp-chk" title="Загрузить только точки около маршрута сканера"><input type="checkbox" data-k="routeOn"> Около маршрута</label>' +
                  '<label title="Дальность от маршрута"><input type="number" min="1" max="200" step="1" data-k="radius" value="15"> м</label></div>' +
                '<div class="bp-row bp-span"><input type="range" min="0" max="100" value="0" data-k="rfrom" aria-label="Участок с" title="Начало участка"><input type="range" min="0" max="100" value="100" data-k="rto" aria-label="Участок по" title="Конец участка"></div>' +
                '<p class="bp-note bp-routeinfo"></p></section>' : '') +
              '<section><h4>Очистка</h4>' +
                '<div class="bp-seg bp-noise" role="group" aria-label="Шум">' + noiseSeg.map(function (x) { return '<button type="button" data-noise="' + x[0] + '" title="' + esc(x[2]) + '">' + x[1] + '</button>'; }).join('') + '</div>' +
                '<select data-k="noise" hidden aria-hidden="true">' + noiseSeg.map(function (x) { return '<option value="' + x[0] + '">' + x[1] + '</option>'; }).join('') + '</select>' +
                '<div class="bp-row"><label>Окраска <select data-k="color">' + (F.colored ? '<option value="rgb">Цвет сканера</option>' : '') + '<option value="elev">Высота</option>' +
                  (F.intensity ? '<option value="intensity">Интенсивность</option>' : '') + (F.classification ? '<option value="classification">Классы</option>' : '') + '</select></label></div>' +
                '<label class="bp-chk" title="Небольшие облака будут открываться сразу"><input type="checkbox" data-k="dontAsk"> Только для облаков больше 20 млн</label></section>' +
            '</div>' +
            '<div class="bp-pane" data-pane="info" hidden>' +
              '<section><table class="bp-facts"></table></section>' +
              '<section><h4>Компьютер</h4><div class="bp-pc"></div></section>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="form-actions bp-actions">' +
          '<button type="button" class="btn sm ghost" data-act="plan" title="План этажа из облака: стены, проёмы, размеры">' + ic('pencil-ruler', 15) + ' DXF</button>' +
          '<button type="button" class="btn sm ghost" data-act="report" title="PDF-отчёт по облаку">' + ic('file-text', 15) + ' PDF</button>' +
          '<div class="bp-est" aria-live="polite"></div>' +
          '<button type="button" class="btn sm" data-act="cancel">Отмена</button>' +
          '<button type="button" class="btn sm primary" data-act="load">Загрузить</button></div>' +
        '</div>';
      var card = back.querySelector('.bp-card'), cv = back.querySelector('.bp-map canvas'), q = function (s) { return back.querySelector(s); };
      var range = q('.bp-range input'), hist = q('.bp-hist');
      // сведения
      q('.bp-facts').innerHTML = facts(ov).map(function (r) { return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>'; }).join('');
      if (cap && cap.ok) {
        var gpu = cap.gpu || {}, ram = cap.ram || {};
        q('.bp-pc').innerHTML = '<div>' + esc(gpu.name || 'Видеокарта не определена') + (gpu.vramTotal ? ' · ' + fmtBytes(gpu.vramTotal) + (gpu.vramFree ? ' (свободно ' + fmtBytes(gpu.vramFree) + ')' : '') : '') + '</div>' +
          '<div>Память ' + fmtBytes(ram.total) + ' (свободно ' + fmtBytes(ram.free) + ')</div>' +
          (rec ? '<div class="bp-rec">Рекомендовано <b>' + fmtMln(rec.points) + ' млн</b> · максимум <b>' + fmtMln(rec.safeMax) + ' млн</b></div>' +
            (rec.notes && rec.notes.length ? '<div class="bp-note">' + esc(rec.notes.join('; ')) + '</div>' : '') : '');
      } else q('.bp-pc').textContent = 'Сведения о компьютере недоступны — предел ' + fmtMln(budget) + ' млн точек.';
      // вкладки
      back.querySelectorAll('[data-tab]').forEach(function (t) { t.onclick = function () { var k = t.getAttribute('data-tab'); back.querySelectorAll('[data-tab]').forEach(function (x) { x.classList.toggle('on', x === t); x.setAttribute('aria-selected', x === t ? 'true' : 'false'); }); back.querySelectorAll('[data-pane]').forEach(function (p) { p.hidden = p.getAttribute('data-pane') !== k; }); if (k === 'load') paintHist(); }; });
      // этажи
      var fl = q('.bp-floors');
      fl.innerHTML = floors.map(function (f, i) { return '<button type="button" class="btn xs" data-floor="' + i + '" title="' + esc(f.name) + ': пол ' + fmtNum(f.floor, 2) + ' м, высоты ' + fmtNum(f.min, 2) + '…' + fmtNum(f.max, 2) + ' м">' + esc(f.name.replace(/^Этаж /, 'Эт. ')) + ' <small>' + fmtNum(f.floor, 1) + '</small></button>'; }).join('') +
        (floors.length ? '<button type="button" class="btn xs" data-act="noCeil" title="Срезать потолок выбранного этажа (15 см ниже перекрытия)">Без потолка</button>' : '<span class="bp-note">Этажи не найдены — высоты вручную</span>');
      function setView(v) { st.view = v; back.querySelectorAll('[data-view]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-view') === v); }); paint(); }
      var mask = null, maskKey = '';
      function curFilter() {
        var f = {};
        if (st.rect) f.rect = st.rect;
        if (st.hf) f.h = st.hf;
        if (st.route) f.route = { radius: st.radius, from: st.route.from, to: st.route.to };
        if (st.noise !== 'none') f.noise = { low: { voxel: 0.15, min: 2 }, mid: { voxel: 0.1, min: 3 }, high: { voxel: 0.08, min: 5 } }[st.noise];
        return Object.keys(f).length ? f : null;
      }
      function est() {
        var key = st.route ? st.radius + ':' + st.route.from + ':' + st.route.to : '';
        if (key !== maskKey) { maskKey = key; mask = st.route ? routeMaskJS(tr.route, ov.bbox, st.radius, st.route.from, st.route.to) : null; }
        return estimate(ov.pts, total, { rect: st.rect, h: st.hf }, mask);
      }
      function update() {
        var e = est(), after = e.points, load = Math.min(after, st.points);
        q('.bp-ptsval b').textContent = st.points >= total ? 'Все точки' : fmtMln(st.points) + ' млн';
        q('.bp-ptsval span').textContent = 'из ' + fmtMln(total) + ' млн';
        var warn = q('.bp-warn');
        if (st.points > safePts) { warn.hidden = false; warn.textContent = 'Больше надёжного максимума (' + fmtMln(safePts) + ' млн) — возможен белый экран'; warn.title = 'Видеокарта этого компьютера может сбросить изображение'; }
        else warn.hidden = true;
        var share = after > 0 ? load / after : 1;
        var fl0 = curFilter(), estEl = q('.bp-est');
        estEl.innerHTML = (fl0 ? '<span>' + fmtNum(e.frac * 100, e.frac < 0.1 ? 1 : 0) + ' % файла</span>' : '') +
          (share < 0.999 ? '<span>1 из ' + fmtNum(1 / Math.max(1e-6, share), 1) + '</span>' : '') + '<span>' + fmtBytes(load * 16) + ' видео</span>';
        estEl.title = 'Будет загружено ≈ ' + fmtMln(load) + ' млн точек' + (fl0 ? ' (после области и фильтров ≈ ' + fmtMln(after) + ' млн)' : '') +
          (share < 0.999 ? ', равномерно 1 из ' + fmtNum(1 / Math.max(1e-6, share), 1) : '') + '; ≈ ' + fmtBytes(load * 16) + ' видеопамяти, ≈ ' + fmtBytes(load * 20) + ' оперативной' + (st.noise !== 'none' ? '; шум убирается при чтении' : '');
        var lb = q('[data-act="load"]'); lb.textContent = 'Загрузить ' + fmtMln(load) + ' млн';
        lb.disabled = after <= 0;
        if (hasRoute) {
          var ri = q('.bp-routeinfo');
          if (ri) { var a0 = st.route ? st.route.from : 0, a1 = st.route ? st.route.to : 1; ri.textContent = fmtDur(tr.duration * a0) + ' — ' + fmtDur(tr.duration * a1) + ' · ' + fmtNum(tr.length * (a1 - a0), 0) + ' м'; ri.title = 'Участок маршрута от начала съёмки'; }
        }
        paintHist();
      }
      function paintHist() {
        var H = ov.hist, dpr = W.devicePixelRatio || 1, w = hist.clientWidth || 300, h = 64; hist.width = w * dpr; hist.height = h * dpr;
        var cx = hist.getContext('2d'); cx.setTransform(dpr, 0, 0, dpr, 0, 0); cx.clearRect(0, 0, w, h);
        var core = ov.bbox.core || ov.bbox, h0 = core.h0, h1 = core.h1, mx = 1, i;
        for (i = 0; i < H.counts.length; i++) if (H.counts[i] > mx) mx = H.counts[i];
        var X = function (z) { return (z - h0) / Math.max(0.01, h1 - h0) * w; };
        if (st.hf) { cx.fillStyle = 'rgba(56,189,248,.16)'; cx.fillRect(X(st.hf.min), 0, X(st.hf.max) - X(st.hf.min), h); }
        cx.fillStyle = '#7c8aa0';
        for (i = 0; i < H.counts.length; i++) { var z = H.h0 + i * H.step; if (z < h0 || z > h1) continue; var bh = Math.sqrt(H.counts[i] / mx) * (h - 14); cx.fillRect(X(z), h - 12 - bh, Math.max(1, X(z + H.step) - X(z)), bh); }
        cx.fillStyle = '#38bdf8'; (ov.levels || []).forEach(function (l) { var x = X(l.h); cx.beginPath(); cx.moveTo(x - 4, 0); cx.lineTo(x + 4, 0); cx.lineTo(x, 6); cx.closePath(); cx.fill(); });
        cx.fillStyle = '#9aa6b8'; cx.font = '10px Inter, Arial, sans-serif'; cx.fillText(fmtNum(h0, 1) + ' м', 0, h - 1); var t1 = fmtNum(h1, 1) + ' м'; cx.fillText(t1, w - cx.measureText(t1).width, h - 1);
      }
      var vw = null, drag = null;
      function paint() {
        var dpr = W.devicePixelRatio || 1, box = cv.parentNode.getBoundingClientRect();
        cv.width = Math.max(200, box.width) * dpr; cv.height = Math.max(200, box.height) * dpr; cv.style.width = box.width + 'px'; cv.style.height = box.height + 'px';
        vw = drawMap(cv, ov, st, { dpr: dpr, drag: drag });
      }
      function setPoints(p) { st.points = Math.max(Math.min(total, MIN_POINTS), Math.min(total, Math.round(p))); range.value = String(pointsToSlider(st.points, total)); paintRange(); update(); }
      function paintRange() {
        range.style.setProperty('--f', String(range.value / 1000));
        var near = function (x) { return Math.abs(pointsToSlider(x, total) - (+range.value)) <= 2; };
        var val = { fast: Math.min(20e6, recPts), rec: recPts, max: safePts, all: total }, pick = ['all', 'max', 'rec', 'fast'].filter(function (k) { return near(val[k]); })[0] || '';
        back.querySelectorAll('[data-pre]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-pre') === pick); });
      }
      var mkRec = q('.bp-mk.rec'), mkMax = q('.bp-mk.max');
      mkRec.style.left = (pointsToSlider(recPts, total) / 10) + '%'; mkMax.style.left = (pointsToSlider(safePts, total) / 10) + '%';
      if (recPts >= total) mkRec.hidden = true; if (safePts >= total) mkMax.hidden = true;
      range.addEventListener('input', function () { st.points = sliderToPoints(+range.value, total); paintRange(); update(); });
      back.querySelectorAll('[data-pre]').forEach(function (b) { b.onclick = function () { var k = b.getAttribute('data-pre'); setPoints(k === 'fast' ? Math.min(20e6, recPts) : k === 'rec' ? recPts : k === 'max' ? safePts : total); }; });
      back.querySelectorAll('[data-view]').forEach(function (b) { b.onclick = function () { setView(b.getAttribute('data-view')); }; });
      var hminI = q('[data-k="hmin"]'), hmaxI = q('[data-k="hmax"]');
      function setH(a, b) { if (a == null) { st.hf = null; hminI.value = ''; hmaxI.value = ''; } else { st.hf = { min: Math.min(a, b), max: Math.max(a, b) }; hminI.value = st.hf.min.toFixed(2); hmaxI.value = st.hf.max.toFixed(2); } st._imgKey = ''; update(); paint(); }
      function readH() { var a = parseFloat(String(hminI.value).replace(',', '.')), b = parseFloat(String(hmaxI.value).replace(',', '.')); if (isFinite(a) && isFinite(b) && b > a) setH(a, b); else if (!hminI.value && !hmaxI.value) setH(null); }
      hminI.addEventListener('change', readH); hmaxI.addEventListener('change', readH);
      var curFloor = null;
      fl.querySelectorAll('[data-floor]').forEach(function (b) { b.onclick = function () { curFloor = floors[+b.getAttribute('data-floor')]; setH(curFloor.min, curFloor.max); fl.querySelectorAll('[data-floor]').forEach(function (x) { x.classList.toggle('on', x === b); }); }; });
      var nc = fl.querySelector('[data-act="noCeil"]'); if (nc) nc.onclick = function () { var f = curFloor || floors[0]; curFloor = f; setH(f.min, f.ceiling != null ? f.ceiling - 0.15 : Math.min(f.max, f.floor + 2.4)); };
      if (hasRoute) {
        var ron = q('[data-k="routeOn"]'), rad = q('[data-k="radius"]'), rf = q('[data-k="rfrom"]'), rt = q('[data-k="rto"]');
        var syncRoute = function () {
          st.radius = Math.max(1, Math.min(200, parseFloat(rad.value) || 15));
          var a = (+rf.value) / 100, b = (+rt.value) / 100; if (b < a) { var t = a; a = b; b = t; }
          st.route = ron.checked ? { from: a, to: Math.max(b, a + 0.01) } : null; update(); paint();
        };
        [ron, rad, rf, rt].forEach(function (e) { e.addEventListener('input', syncRoute); e.addEventListener('change', syncRoute); });
        q('[data-k="showRoute"]').addEventListener('change', function (e) { st.showRoute = e.target.checked; paint(); });
      }
      var noiseSel = q('[data-k="noise"]');
      function setNoise(v) { st.noise = v; noiseSel.value = v; back.querySelectorAll('[data-noise]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-noise') === v); }); update(); }
      noiseSel.addEventListener('change', function (e) { setNoise(e.target.value); });
      back.querySelectorAll('[data-noise]').forEach(function (b) { b.onclick = function () { setNoise(b.getAttribute('data-noise')); }; });
      var colorSel = q('[data-k="color"]'); colorSel.value = st.color; colorSel.addEventListener('change', function () { st.color = colorSel.value; });
      q('[data-act="clearRect"]').onclick = function () { st.rect = null; update(); paint(); };
      q('[data-act="clearH"]').onclick = function () { curFloor = null; fl.querySelectorAll('[data-floor]').forEach(function (x) { x.classList.remove('on'); }); setH(null); };
      // рамка области мышью
      cv.addEventListener('mousedown', function (e) {
        if (!vw || e.button !== 0) return;
        var r = cv.getBoundingClientRect(), p = vw.from(e.clientX - r.left, e.clientY - r.top); drag = { a: p, u0: p[0], u1: p[0], v0: p[1], v1: p[1] };
        var mv = function (ev) { var p2 = vw.from(ev.clientX - r.left, ev.clientY - r.top); drag.u0 = Math.min(drag.a[0], p2[0]); drag.u1 = Math.max(drag.a[0], p2[0]); drag.v0 = Math.min(drag.a[1], p2[1]); drag.v1 = Math.max(drag.a[1], p2[1]); paint(); };
        var up = function () { D.removeEventListener('mousemove', mv); D.removeEventListener('mouseup', up); if (drag && drag.u1 - drag.u0 > 0.5 && drag.v1 - drag.v0 > 0.5) st.rect = { u0: drag.u0, u1: drag.u1, v0: drag.v0, v1: drag.v1 }; drag = null; update(); paint(); };
        D.addEventListener('mousemove', mv); D.addEventListener('mouseup', up);
      });
      var done = false;
      function finish(v) {
        if (done) return; done = true;
        D.removeEventListener('keydown', onKey, true); W.removeEventListener('resize', paint);
        back.classList.add('closing'); setTimeout(function () { if (back.parentNode) back.parentNode.removeChild(back); }, 140);
        resolve(v);
      }
      function onKey(e) { if (e.key === 'Escape' && back.parentNode && !D.querySelector('.modal.lx-ask')) { e.preventDefault(); e.stopPropagation(); finish({ cancelled: true }); } }
      q('.modal-head .x').onclick = function () { finish({ cancelled: true }); };
      q('[data-act="cancel"]').onclick = function () { finish({ cancelled: true }); };
      q('[data-act="load"]').onclick = function () {
        var e = est(), f = curFilter();
        try { localStorage.setItem(LS_POINTS, String(st.points)); if (q('[data-k="dontAsk"]').checked) localStorage.setItem(LS_MODE, 'large'); } catch (_) {}
        finish({ maxPoints: st.points >= total ? 0 : st.points, filter: f, estimate: f ? Math.max(1, e.points) : total, colorMode: st.color, view: { rect: st.rect, hf: st.hf, route: st.route, radius: st.radius, noise: st.noise } });
      };
      q('[data-act="plan"]').onclick = function () { planDxf(path, ov, st, paint, q('[data-act="plan"]')); };
      q('[data-act="report"]').onclick = function () { report(path, ov, cap, st, q('[data-act="report"]')); };
      D.addEventListener('keydown', onKey, true); W.addEventListener('resize', paint);
      D.body.appendChild(back); if (kit() && kit().hydrate) kit().hydrate(back); back.classList.add('open');
      if (ov.file.points < LARGE) { var da = q('[data-k="dontAsk"]'); if (da) da.closest('label').hidden = true; }
      setView(st.view); setPoints(st.points); setNoise(st.noise);
      requestAnimationFrame(function () { paint(); paintHist(); });
      void card;
    });
  }

  // ------------------------------------------------------------------ план из облака → DXF (текущий этаж или все этажи в одном файле)
  async function planDxf(path, ov, st, repaint, btn) {
    var A = api(), k = kit(); if (!A || !A.cloudPlan || !k || !k.form) { toast('План из облака доступен в настольной версии', true); return; }
    var floors = storeys(ov.levels, ov.bbox, ovRoute(ov)), floor = st && st.hf ? (floors.find(function (f) { return f.min <= st.hf.min + 0.2 && f.max >= st.hf.min; }) || floors[0]) : floors[0];
    var floorH = floor ? floor.floor : (ov.levels && ov.levels[0] ? ov.levels[0].h : (ov.bbox.core || ov.bbox).h0);
    var hasRoute = !!ovRoute(ov), fields = [];
    if (floors.length > 1) fields.push({ key: 'which', label: 'Этажи', type: 'select', value: 'cur', options: [{ value: 'cur', label: (floor ? floor.name : 'Текущий') + ' (пол +' + fmtNum(floorH, 2) + ' м)' }, { value: 'all', label: 'Все этажи (' + floors.length + ') — в одном DXF' }] });
    fields.push(
      { key: 'hc', label: 'Срез над полом', type: 'number', value: 1.2, step: 0.05, min: 0.2, max: 4, unit: 'м', hint: 'Выше мебели, ниже верха окон: 1,1–1,3 м' },
      { key: 'th', label: 'Толщина среза', type: 'number', value: 0.1, step: 0.01, min: 0.02, max: 0.5, unit: 'м' },
      { key: 'units', label: 'Единицы', type: 'select', value: 'mm', options: [{ value: 'mm', label: 'миллиметры' }, { value: 'm', label: 'метры' }] },
      { key: 'origin', label: 'Координаты', type: 'select', value: ov.file.crs || (ov.origin && ov.origin.zup && Math.abs(ov.origin.cx) > 1000) ? 'world' : 'local', options: [{ value: 'local', label: 'местные (от угла плана)' }, { value: 'world', label: 'как в облаке' }] },
      { key: 'ortho', label: 'Стены под прямым углом', type: 'checkbox', value: false },
      { key: 'furn', label: 'Убирать мебель (второй срез)', type: 'checkbox', value: true, hint: 'Колонка над срезом до 2,45 м: грани с разрывом над собой — стеллажи, шкафы, мебель под антресолью и трубами — уходят в слой A-FURN' });
    if (hasRoute) fields.push({ key: 'route', label: 'Маршрут сканера', type: 'checkbox', value: true });
    if (st && st.rect) fields.push({ key: 'onlyRect', label: 'Только область с карты', type: 'checkbox', value: true });
    var v = await k.form({ title: 'План в DXF', wide: true, className: 'lx-compact', message: floors.length ? 'Пол ' + (floor ? floor.name.toLowerCase() : '') + ': +' + fmtNum(floorH, 2) + ' м. Размеры — объекты DIMENSION.' : 'Этажи не найдены — срез от низа облака.', fields: fields, okLabel: 'Построить' });
    if (!v) return;
    var list = v.which === 'all' ? floors : [floor || { name: 'Этаж 1', floor: floorH }];
    var act = k.activity ? k.activity('План из облака…') : null;
    if (btn && k.busy) k.busy(btn, true);
    var items = [], fails = [], tot = 0;
    try {
      for (var i = 0; i < list.length; i++) {
        var f = list[i], id = jobId(), h0 = f.floor + v.hc - v.th / 2, h1 = f.floor + v.hc + v.th / 2, lab = list.length > 1 ? f.name + ' (' + (i + 1) + ' из ' + list.length + ')' : 'План из облака…';
        var off = A.onCloudPlanProgress ? A.onCloudPlanProgress(id, function (p, l) { if (act) act.set((i + Math.max(0, Math.min(1, +p || 0))) / list.length, lab); }) : function () {};
        var r, hi = v.furn ? highBand(f, h1) : null;
        try { r = await A.cloudPlan({ path: path, jobId: id, h0: h0, h1: h1, hi0: hi ? hi[0] : null, hi1: hi ? hi[1] : null, hiBands: hi ? hi[2] : null, rect: v.onlyRect && st && st.rect ? st.rect : null, plan: { ortho: !!v.ortho, lowFilter: v.furn ? undefined : false } }); } finally { off(); }
        if (!r || !r.ok || !r.plan || !r.plan.ok) { fails.push(f.name + ': ' + ((r && (r.message || (r.plan && r.plan.message))) || 'нет стен в срезе')); continue; }
        tot += (r.slice && r.slice.count) || 0;
        items.push({ plan: r.plan, floor: f, title: (list.length > 1 || floors.length > 1 ? f.name + ' — ' : stem(path) + ' — ') + 'план на +' + fmtNum(v.hc, 2) + ' м над полом',
          subtitle: 'BIM Twin · ' + stem(path) + ' · срез ' + fmtNum(h0, 2) + '…' + fmtNum(h1, 2) + ' м · точек ' + fmtInt(r.slice && r.slice.count) });
      }
      if (!items.length) { toast('План не построен — ' + fails.join('; '), true); return; }
      var plan = items[0].plan; if (st) { st.plan = plan; if (repaint) repaint(); }
      lastPlan.set(path, plan); lastPlans.set(path, items);
      var AP = W.AutoPlan, o = { units: v.units, origin: v.origin, world: { cx: ov.origin.cx, cy: ov.origin.cy }, route: v.route && hasRoute ? ov.trajectory.route : null };
      var text = items.length > 1 ? AP.toDXF(items.map(function (x) { return { plan: x.plan, title: x.title, subtitle: x.subtitle }; }), o)
        : AP.toDXF(plan, Object.assign(o, { title: items[0].title, subtitle: items[0].subtitle }));
      var dirs = A.projectFolder ? await A.projectFolder('get') : null;
      var name = stem(path) + (items.length > 1 ? '-планы.dxf' : '-план.dxf'), def = dirs && dirs.ok ? joinPath(dirs.drawings, name) : name;
      var sv = await A.exportFile({ text: text, ext: 'dxf', name: def, title: 'Сохранить план DXF', filterName: 'Чертёж AutoCAD DXF' });
      var sum = items.length > 1 ? plural(items.length, 'этаж', 'этажа', 'этажей') + ': ' + items.map(function (x) { return x.floor.name + ' — ' + summary(x.plan); }).join('; ') : summary(plan);
      if (fails.length) sum += '. Не построено: ' + fails.join('; ');
      if (sv && sv.ok) toast('Готово: ' + baseName(sv.path) + ' (' + sum + ')');
      else if (!(sv && sv.canceled)) toast('Не удалось сохранить DXF: ' + ((sv && sv.error) || ''), true);
      else toast('План построен (' + sum + '), файл не сохранён');
    } catch (e) { toast('Ошибка плана: ' + (e && e.message || e), true); }
    finally { if (act) act.done(); if (btn && k.busy) k.busy(btn, false); }
  }
  // колонка над срезом для отбора мебели (ревизия 30): от верха среза до 2,45 м над полом (низкий потолок — до 15 см под ним),
  // полосы по 12–15 см: мебель под антресолью и трубами отличается от стен по разрыву над ней
  function highBand(f, h1) {
    var a = h1 + 0.05, b = f.floor + 2.45;
    if (f.ceiling != null && f.ceiling - f.floor > 1.5) b = Math.min(b, f.ceiling - 0.15);
    if (b - a < 0.3) return null;
    return [a, b, Math.max(2, Math.min(8, Math.round((b - a) / 0.13)))];
  }
  function plural(n, a, b, c) { var m = Math.abs(n) % 100, d = m % 10; return n + ' ' + (m > 10 && m < 20 ? c : d === 1 ? a : d >= 2 && d <= 4 ? b : c); }
  function summary(plan) {
    var nc = plan.stats.corridors || 0, nl = plan.low ? plan.low.length : 0;
    return plural(plan.stats.faces, 'грань', 'грани', 'граней') + ' стен, ' + plural(plan.stats.openings, 'проём', 'проёма', 'проёмов') + ', ' + plural(plan.rooms.length, 'помещение', 'помещения', 'помещений') +
      (nc ? ' (' + plural(nc, 'коридор', 'коридора', 'коридоров') + ')' : '') +
      (plan.rooms.length ? ': ' + plan.rooms.slice(0, 4).map(function (x) { return fmtNum(x.area, 2) + ' м²'; }).join(', ') : '') +
      (nl ? '; мебель у стен убрана — ' + plural(nl, 'грань', 'грани', 'граней') + ' в слое A-FURN' : '');
  }
  var lastPlan = new Map(), lastPlans = new Map();

  // ------------------------------------------------------------------ PDF-отчёт
  async function report(path, ov, cap, st, btn) {
    var A = api(), k = kit(); if (!A || !A.saveReportPdf || !W.CloudReport) { toast('PDF-отчёт доступен в настольной версии', true); return; }
    if (btn && k && k.busy) k.busy(btn, true);
    try {
      cap = cap || await getCapacity();
      var maps = [{ title: 'Плотность точек', src: mapImage(ov, 'density', { plan: null }) }, { title: 'Высота (палитра от низа к верху)', src: mapImage(ov, 'height', { plan: null }) }];
      if (ov.grid.rgb && ov.file.colored) maps.push({ title: 'Цвет сканера', src: mapImage(ov, 'rgb', { plan: null }) });
      else if (ov.grid.inten) maps.push({ title: 'Интенсивность', src: mapImage(ov, 'intensity', { plan: null }) });
      var plan = (st && st.plan) || lastPlan.get(path) || null;
      if (plan) maps.push({ title: 'План из облака поверх карты', src: mapImage(ov, 'density', { plan: plan }) });
      var snap = null, v = viewer();
      try { if (v && v.canvas && v.base && v.base.length) { v.render(); snap = v.canvas.toDataURL('image/jpeg', 0.88); } } catch (_) {}
      var ver = ''; try { ver = A.getVersion ? await A.getVersion() : ''; } catch (_) {}
      var project = ''; try { var dd = A.getData ? await A.getData() : null; project = dd && dd.project ? dd.project.name || '' : ''; } catch (_) {}
      var many = lastPlans.get(path), plans = many && many.length > 1 ? many.map(function (x) { return { plan: x.plan, title: x.floor.name + ', пол +' + fmtNum(x.floor.floor, 2) + ' м' }; }) : null;
      var html = W.CloudReport.build({ ov: ov, capacity: cap, plan: plan, plans: plans, maps: maps, snapshot: snap, fileName: baseName(path), project: project, appVersion: ver,
        load: lastPre.get(path) || null, facts: facts(ov), storeys: storeys(ov.levels, ov.bbox, ovRoute(ov)) });
      var r = await A.saveReportPdf({ html: html, name: stem(path) + ' — отчёт.pdf' });
      if (r && r.ok) toast('Готово: PDF-отчёт сохранён — ' + r.path); else if (!(r && r.canceled)) toast('Не удалось сохранить PDF: ' + ((r && r.message) || ''), true);
    } catch (e) { toast('Ошибка отчёта: ' + (e && e.message || e), true); }
    finally { if (btn && k && k.busy) k.busy(btn, false); }
  }

  // ------------------------------------------------------------------ вход из app.js
  async function overviewFor(path, force, minPts) {
    var A = api(); if (!A || !A.cloudOverview) return null;
    var k = kit(), id = jobId(), act = k && k.activity ? k.activity('Карта облака…') : null, skip = false;
    var t = setTimeout(function () { if (k && k.toast) k.toast('Строю карту облака до загрузки… (Esc — пропустить)'); }, 1200);
    var onEsc = function (e) { if (e.key === 'Escape') { skip = true; try { A.cancelCloudOverview(id); } catch (_) {} } };
    D.addEventListener('keydown', onEsc, true);
    try {
      var ov = await A.cloudOverview(path, id, { minPoints: force ? 0 : (minPts || LARGE) });
      if (skip || !ov || !ov.ok) return null;
      lastOv.set(path, ov);
      return ov;
    } catch (_) { return null; }
    finally { clearTimeout(t); D.removeEventListener('keydown', onEsc, true); if (act) act.done(); }
  }
  async function maybeOpen(path, o) {
    o = o || {};
    if (!/\.(las|ply|e57)$/i.test(String(path || ''))) return null;
    var force = forceNext || !!o.force; forceNext = false;
    var m = mode(); if (m === 'never' && !force) return null;
    var ov = await overviewFor(path, force, m === 'large' ? LARGE : 1000000);
    if (!ov) return null;
    var cap = await getCapacity();
    var pre = await openDialog(path, ov, cap, o.label);
    if (pre && !pre.cancelled) lastPre.set(path, pre);
    return pre;
  }
  function afterLoad(pre, result) {
    if (!pre || !result || !result.ok) return;
    var v = viewer();
    if (pre.colorMode && v && typeof v.setColorMode === 'function') { try { v.setColorMode(pre.colorMode); } catch (_) {} }
    var parts = [];
    if (pre.filter) { if (pre.filter.rect) parts.push('область'); if (pre.filter.h) parts.push('высоты ' + fmtNum(pre.filter.h.min, 2) + '…' + fmtNum(pre.filter.h.max, 2) + ' м'); if (pre.filter.route) parts.push('около маршрута ' + pre.filter.route.radius + ' м'); if (pre.filter.noise) parts.push('без шума'); }
    W.__bimLoadInfo = { path: result.path || null, sampled: !!result.thinned || !!pre.filter || (result.total > 0 && result.count < result.total), filtered: !!pre.filter, filterText: parts.join(', '), count: result.count, total: result.total };
    try { W.dispatchEvent(new CustomEvent('bim-cloud-loaded', { detail: W.__bimLoadInfo })); } catch (_) {}
  }
  async function currentOverview() {
    var p = W.__bimLastCloudPath ? W.__bimLastCloudPath() : null;
    if (!p) { toast('Сначала откройте облако LAS, PLY или E57', true); return null; }
    if (!/\.(las|ply|e57)$/i.test(p)) { toast('Карта и отчёт до загрузки — для облаков LAS, PLY и E57', true); return null; }
    var ov = lastOv.get(p) || await overviewFor(p, true);
    if (!ov) { toast('Не удалось построить карту облака', true); return null; }
    return { path: p, ov: ov };
  }
  var api2 = Object.assign({}, pure, {
    maybeOpen: maybeOpen, afterLoad: afterLoad,
    lastFor: function (p) { return lastPre.get(p) || null; },
    openNext: function () { forceNext = true; var b = D.getElementById('btnOpenCloud'); if (b) b.click(); else toast('Откройте облако — перед загрузкой появится карта'); },
    planDxf: async function () { var c = await currentOverview(); if (c) planDxf(c.path, c.ov, null, null, null); },
    report: async function () { var c = await currentOverview(); if (c) report(c.path, c.ov, null, null, null); },
    setMode: function (m) { try { localStorage.setItem(LS_MODE, m); } catch (_) {} },
    capacity: getCapacity, mapImage: mapImage
  });
  // мощность ПК — заранее (предел точек по умолчанию берётся из рекомендации)
  setTimeout(function () { getCapacity(); }, 2500);
  return api2;
});
