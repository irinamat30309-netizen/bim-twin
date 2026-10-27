/*
 * cloud-audit.js — проверка качества облака точек «как у инженера» (ревизия 43). UMD: window.BimCloudAudit / require().
 *
 * audit(pos, n, opts) — один проход по всем точкам (до 30 млн, дальше с шагом), без копий облака:
 *   • устойчивая рамка (0,1–99,9 %) и далёкие выбросы за ней (запас max(2 м, 25 %));
 *   • окрестности 2500 случайных точек (шар R = 5 см): шаг точек по числу соседей (πR² / k), шум — СКО от локальной
 *     плоскости (PCA), доля плоских мест, двоение поверхности (два слоя вдоль нормали дальше max(8 мм, 4σ)),
 *     одиночные точки (соседей в 3 шагах меньше 3), точные дубли (до 1 мм);
 *   • оценка LOA (USIBD) по 2σ шума и двоению, вердикт, рекомендации и уровень чистки для ассистента.
 * Возврат: { ok, points, used, extent, spacingMm, densityPerM2, noiseMm, planarShare, isolatedPct, duplicatePct, farCount,
 *            doublePct, loa, grade, verdict, recommendations[{level, text, command?}], suggest{thoroughness, micro, why}, ms }.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BimCloudAudit = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  function rng(seed) { var s = seed >>> 0 || 1; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function quant(a, q) { if (!a.length) return NaN; var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]; }
  function median(a) { return quant(a, 0.5); }
  // PCA 3×3 (собственные значения по возрастанию, нормаль — вектор наименьшего)
  function pca(P) {
    var n = P.length / 3, cx = 0, cy = 0, cz = 0, i;
    for (i = 0; i < n; i++) { cx += P[i * 3]; cy += P[i * 3 + 1]; cz += P[i * 3 + 2]; }
    cx /= n; cy /= n; cz /= n;
    var a = 0, b = 0, c = 0, d = 0, e = 0, f = 0;
    for (i = 0; i < n; i++) { var x = P[i * 3] - cx, y = P[i * 3 + 1] - cy, z = P[i * 3 + 2] - cz; a += x * x; b += x * y; c += x * z; d += y * y; e += y * z; f += z * z; }
    a /= n; b /= n; c /= n; d /= n; e /= n; f /= n;
    // Якоби
    var A = [[a, b, c], [b, d, e], [c, e, f]], V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (var sweep = 0; sweep < 12; sweep++) {
      for (var p = 0; p < 2; p++) for (var q = p + 1; q < 3; q++) {
        if (Math.abs(A[p][q]) < 1e-18) continue;
        var th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1)), cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
        for (var k = 0; k < 3; k++) { var akp = A[k][p], akq = A[k][q]; A[k][p] = cs * akp - sn * akq; A[k][q] = sn * akp + cs * akq; }
        for (k = 0; k < 3; k++) { var apk = A[p][k], aqk = A[q][k]; A[p][k] = cs * apk - sn * aqk; A[q][k] = sn * apk + cs * aqk; }
        for (k = 0; k < 3; k++) { var vkp = V[k][p], vkq = V[k][q]; V[k][p] = cs * vkp - sn * vkq; V[k][q] = sn * vkp + cs * vkq; }
      }
    }
    var ev = [0, 1, 2].map(function (j) { return { l: Math.max(0, A[j][j]), v: [V[0][j], V[1][j], V[2][j]] }; }).sort(function (x, y) { return x.l - y.l; });
    return { l: [ev[0].l, ev[1].l, ev[2].l], n: ev[0].v, c: [cx, cy, cz] };
  }
  function loaOf(twoSigmaMm) { return twoSigmaMm <= 1 ? 50 : twoSigmaMm <= 5 ? 40 : twoSigmaMm <= 15 ? 30 : twoSigmaMm <= 50 ? 20 : 10; }
  var LOA_TEXT = { 50: 'LOA50 (0–1 мм)', 40: 'LOA40 (1–5 мм)', 30: 'LOA30 (5–15 мм)', 20: 'LOA20 (15–50 мм)', 10: 'LOA10 (хуже 50 мм)' };
  function fmt(x, d) { return x == null || x !== x ? '—' : (Math.round(x * Math.pow(10, d || 0)) / Math.pow(10, d || 0)).toLocaleString('ru-RU'); }

  // редкое облако: шар 5 см содержит мало точек — повторяем с большим радиусом (≈ 80 соседей), но не больше 30 см
  function audit(pos, n, opts) {
    opts = opts || {};
    var r = audit1(pos, n, opts);
    if (r.ok && !opts.radius && r._medCnt > 0 && r._medCnt < 40) {
      var R2 = Math.min(0.3, 0.05 * Math.sqrt(80 / r._medCnt));
      if (R2 > 0.06) { var t = r.ms; r = audit1(pos, n, Object.assign({}, opts, { radius: R2 })); r.ms += t; }
    }
    if (r.ok) delete r._medCnt;
    return r;
  }
  function audit1(pos, n, opts) {
    var t0 = Date.now(); n = n == null ? Math.floor(pos.length / 3) : n | 0;
    if (!pos || n < 200) return { ok: false, message: 'В облаке слишком мало точек для проверки (нужно хотя бы 200).' };
    var R = opts.radius || 0.05, NS = Math.min(opts.seeds || 2500, Math.max(50, Math.floor(n / 20))), CAP = opts.cap || 400, rnd = rng(opts.seed || 7);
    var stride = Math.max(1, Math.ceil(n / (opts.maxPoints || 30e6))), i, k;
    // 1) устойчивая рамка по подвыборке
    var sub = Math.min(n, 40000), qs = [[], [], []], bad = 0;
    for (k = 0; k < sub; k++) { i = Math.floor(k * n / sub); var x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]; if ((x - x) + (y - y) + (z - z) !== 0) continue; qs[0].push(x); qs[1].push(y); qs[2].push(z); }
    var lo = [], hi = [], ext = [];
    for (var ax = 0; ax < 3; ax++) { var a0 = quant(qs[ax], 0.001), a1 = quant(qs[ax], 0.999), e = Math.max(2, 0.25 * (a1 - a0)); lo.push(a0 - e); hi.push(a1 + e); ext.push(quant(qs[ax], 0.999) - quant(qs[ax], 0.001)); }
    // 2) затравки — случайные точки внутри рамки; хэш клеток 2R для их шаров
    var seeds = [], C = 2 * R, map = new Map(), key = function (ix, iy, iz) { return (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791); };
    for (var tries = 0; seeds.length < NS && tries < NS * 4; tries++) {
      i = Math.floor(rnd() * n); var sx = pos[i * 3], sy = pos[i * 3 + 1], sz = pos[i * 3 + 2];
      if ((sx - sx) + (sy - sy) + (sz - sz) !== 0 || sx < lo[0] || sx > hi[0] || sy < lo[1] || sy > hi[1] || sz < lo[2] || sz > hi[2]) continue;
      var sd = { id: i, p: [sx, sy, sz], cnt: 0, pts: [], dup: 0 };
      seeds.push(sd);
      var gx0 = Math.floor((sx - R) / C), gx1 = Math.floor((sx + R) / C), gy0 = Math.floor((sy - R) / C), gy1 = Math.floor((sy + R) / C), gz0 = Math.floor((sz - R) / C), gz1 = Math.floor((sz + R) / C);
      for (var gx = gx0; gx <= gx1; gx++) for (var gy = gy0; gy <= gy1; gy++) for (var gz = gz0; gz <= gz1; gz++) { var kk = key(gx, gy, gz), L = map.get(kk); if (!L) map.set(kk, L = []); L.push(sd); }
    }
    // 3) один проход по облаку
    var far = 0, invalid = 0, R2 = R * R, used = 0;
    for (i = 0; i < n; i += stride) {
      var px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
      if ((px - px) + (py - py) + (pz - pz) !== 0) { invalid++; continue; }
      used++;
      if (px < lo[0] || px > hi[0] || py < lo[1] || py > hi[1] || pz < lo[2] || pz > hi[2]) { far++; continue; }
      var Ls = map.get(key(Math.floor(px / C), Math.floor(py / C), Math.floor(pz / C)));
      if (!Ls) continue;
      for (var j = 0; j < Ls.length; j++) {
        var s = Ls[j], dx = px - s.p[0], dy = py - s.p[1], dz = pz - s.p[2], d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > R2 || i === s.id) continue;
        if (d2 < 1e-6) s.dup++;
        s.cnt++;
        if (s.pts.length < CAP * 3) s.pts.push(px, py, pz); else { var r0 = Math.floor(rnd() * s.cnt); if (r0 < CAP) { s.pts[r0 * 3] = px; s.pts[r0 * 3 + 1] = py; s.pts[r0 * 3 + 2] = pz; } }
      }
    }
    // 4) окрестности: шаг, шум, двоение, одиночные
    var spac = [], noise = [], planar = 0, dbl = 0, nPl = 0, dupS = 0;
    seeds.forEach(function (s) {
      dupS += s.dup;
      if (s.cnt >= 8) spac.push(Math.sqrt(Math.PI * R2 / (s.cnt * stride)));
    });
    var spacing = spac.length ? median(spac) : NaN, medCnt = median(seeds.map(function (s) { return s.cnt; }));
    var isoR = Math.max(0.01, 3 * (spacing || 0.01)), iso = 0;
    seeds.forEach(function (s) {
      // одиночная: в шаре isoR меньше 3 соседей (считаем по сохранённым точкам; при переполнении — заведомо не одиночная)
      if (s.cnt < CAP) { var c3 = 0, q2 = isoR * isoR; for (var u = 0; u < s.pts.length; u += 3) { var ex = s.pts[u] - s.p[0], ey = s.pts[u + 1] - s.p[1], ez = s.pts[u + 2] - s.p[2]; if (ex * ex + ey * ey + ez * ez <= q2) c3++; } if (c3 < 3) iso++; }
      if (s.pts.length < 30) return;
      var f = pca(s.pts);
      if (f.l[1] < 1e-8 || f.l[2] < 1e-8) return;
      var flat = f.l[1] > 0.25 * f.l[2];   // поверхность (не линия: трубы, кабели)
      if (!flat) return;
      nPl++;
      var res = []; for (var w = 0; w < s.pts.length; w += 3) res.push((s.pts[w] - f.c[0]) * f.n[0] + (s.pts[w + 1] - f.c[1]) * f.n[1] + (s.pts[w + 2] - f.c[2]) * f.n[2]);
      var sig = Math.sqrt(f.l[0]);
      // два слоя: 1D k-means на остатках
      var m1 = quant(res, 0.2), m2 = quant(res, 0.8);
      for (var it = 0; it < 8; it++) { var s1 = 0, n1 = 0, s2 = 0, n2 = 0; res.forEach(function (v) { if (Math.abs(v - m1) <= Math.abs(v - m2)) { s1 += v; n1++; } else { s2 += v; n2++; } }); if (!n1 || !n2) break; m1 = s1 / n1; m2 = s2 / n2; }
      var v1 = 0, v2 = 0, c1 = 0, c2 = 0; res.forEach(function (v) { if (Math.abs(v - m1) <= Math.abs(v - m2)) { v1 += (v - m1) * (v - m1); c1++; } else { v2 += (v - m2) * (v - m2); c2++; } });
      var sIn = Math.sqrt((v1 + v2) / Math.max(1, c1 + c2)), gap = Math.abs(m2 - m1);
      var mid = (m1 + m2) / 2, nMid = 0; res.forEach(function (v) { if (Math.abs(v - mid) < gap / 6) nMid++; });
      var isDouble = res.length >= 60 && c1 >= 0.2 * res.length && c2 >= 0.2 * res.length && gap > Math.max(0.008, 4 * sIn) && gap < 0.15 && nMid < 0.06 * res.length;
      if (isDouble) { dbl++; noise.push(sIn); } else { planar++; noise.push(sig); }
    });
    var noiseMm = noise.length ? median(noise) * 1000 : NaN, spacingMm = spacing * 1000;
    var isolatedPct = seeds.length ? iso / seeds.length * 100 : 0, duplicatePct = seeds.length ? Math.min(100, dupS / Math.max(1, seeds.reduce(function (t, s) { return t + s.cnt; }, 0)) * 100) : 0;
    var doublePct = nPl ? dbl / nPl * 100 : 0, planarShare = seeds.length ? nPl / seeds.length : 0, farCount = far * stride + invalid * stride;
    var loa = noiseMm === noiseMm ? loaOf(2 * noiseMm) : 10; if (doublePct > 5 && loa > 20) loa = 20;
    // рекомендации инженера
    var rec = [];
    if (farCount > 0) rec.push({ level: 'warn', text: 'Далёкие выбросы и неверные точки: ' + fmt(farCount) + ' — убираются чисткой «до мелочей».' });
    if (isolatedPct >= 0.1) rec.push({ level: isolatedPct > 1 ? 'warn' : 'info', text: 'Одиночные точки в пустоте: около ' + fmt(isolatedPct, 2) + ' % — чистка «до мелочей» уберёт их, не трогая поверхности.' });
    if (duplicatePct >= 0.5) rec.push({ level: 'info', text: 'Дубли точек: около ' + fmt(duplicatePct, 1) + ' % (повторная выгрузка или склейка) — уберутся чисткой «до мелочей».' });
    if (doublePct > 5) rec.push({ level: 'bad', text: 'Двоение поверхностей в ' + fmt(doublePct, 0) + ' % плоских мест — дрейф траектории или несведённые проходы. Чистка это не исправит: «Чистовая обработка» со сведением проходов или пересъёмка с замыканием петли.', command: 'opRefineScan' });
    if (noiseMm > 8) rec.push({ level: 'warn', text: 'Шум ' + fmt(noiseMm, 1) + ' мм — отклонения меньше ' + fmt(2 * noiseMm, 0) + ' мм по облаку не различить; для контроля ровности используйте рейку 2 м (усреднение) или более точный сканер.' });
    else if (noiseMm > 3) rec.push({ level: 'info', text: 'Шум ' + fmt(noiseMm, 1) + ' мм — норма для ручного SLAM-сканера; ровность 3–5 мм определяется по рейке 2 м с осторожностью.' });
    if (spacingMm > 20) rec.push({ level: 'warn', text: 'Редкое облако: шаг ' + fmt(spacingMm, 0) + ' мм — для обмеров и BIM нужно 5–10 мм; мелкие трубы и проёмы могут не найтись.' });
    else if (spacingMm < 2) rec.push({ level: 'info', text: 'Очень плотное облако (шаг ' + fmt(spacingMm, 1) + ' мм) — для BIM и контроля можно проредить до 5 мм («Ресэмплирование»), будет быстрее.', command: 'opResample' });
    if (!rec.length) rec.push({ level: 'ok', text: 'Облако чистое и пригодно для обмеров; достаточно обычной чистки от прохожих.' });
    var th = farCount > 0 || isolatedPct >= 0.05 || duplicatePct >= 0.5 ? 'deep' : noiseMm > 6 ? 'normal' : isolatedPct > 0.01 ? 'normal' : 'quick';
    var why = th === 'deep' ? 'есть ' + [farCount > 0 ? 'выбросы' : '', isolatedPct >= 0.05 ? 'одиночные точки' : '', duplicatePct >= 0.5 ? 'дубли' : ''].filter(Boolean).join(', ') + ' — нужна чистка «до мелочей»' : th === 'normal' ? 'шум и мусор умеренные — обычная чистка' : 'облако почти чистое — достаточно быстрой чистки';
    var grade = doublePct > 5 || spacingMm > 30 ? 'плохое' : noiseMm > 8 || spacingMm > 20 || isolatedPct > 1 ? 'среднее' : 'хорошее';
    var verdict = 'Качество облака: ' + grade + '. Шаг ' + fmt(spacingMm, 1) + ' мм, шум (СКО) ' + fmt(noiseMm, 1) + ' мм → ' + LOA_TEXT[loa] + (doublePct > 5 ? ', двоение ' + fmt(doublePct, 0) + ' %' : '') + '.';
    return { ok: true, points: n, used: used, stride: stride, extent: ext.map(function (v) { return Math.round(v * 100) / 100; }), spacingMm: Math.round(spacingMm * 10) / 10,
      densityPerM2: spacing > 0 ? Math.round(1 / (spacing * spacing)) : null, noiseMm: Math.round(noiseMm * 10) / 10, planarShare: Math.round(planarShare * 100) / 100,
      isolatedPct: Math.round(isolatedPct * 100) / 100, duplicatePct: Math.round(duplicatePct * 100) / 100, farCount: farCount, doublePct: Math.round(doublePct * 10) / 10,
      loa: loa, loaText: LOA_TEXT[loa], grade: grade, verdict: verdict, recommendations: rec, suggest: { thoroughness: th, micro: th === 'deep', why: why }, seeds: seeds.length, radius: R, ms: Date.now() - t0, _medCnt: medCnt };
  }
  function describe(r) {
    if (!r || !r.ok) return (r && r.message) || 'Нет данных.';
    return '**' + r.verdict + '**\n\n' + r.recommendations.map(function (x) { return '- ' + x.text; }).join('\n') + '\n\nРекомендуемая чистка: ' + ({ quick: 'быстрая', normal: 'обычная', deep: 'до мелочей' }[r.suggest.thoroughness]) + ' (' + r.suggest.why + ').';
  }
  return { audit: audit, describe: describe, loaOf: loaOf, pca: pca };
});
