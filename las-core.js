/*
 * las-core.js — чистые общие хелперы декодирования LAS — единый источник
 * для Node (las-node.js) и браузера (renderer/pointcloud.js). Без побочных эффектов.
 *
 *   Node:    const core = require('./las-core');
 *   Browser: <script src="../las-core.js"> -> window.LasCore
 */
(function (root, factory) {
  'use strict';
  var cfg = (typeof module !== 'undefined' && module.exports)
    ? require('./app-config')
    : (root.APP_CONFIG || {});
  var mod = factory(cfg);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof root !== 'undefined') root.LasCore = mod;
})(typeof self !== 'undefined' ? self : this, function (cfg) {
  'use strict';

  var LAS_COLOR_OFFSETS = cfg.LAS_COLOR_OFFSETS || { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };
  var LAS_CLASS_OFFSETS = { 0: 15, 1: 15, 2: 15, 3: 15, 4: 15, 5: 15,
    6: 16, 7: 16, 8: 16, 9: 16, 10: 16 };

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  // jet-подобная рампа по высоте (синий -> голубой -> зелёный -> жёлтый -> красный)
  function elevationRamp(t) {
    t = clamp01(t);
    return [
      clamp01(1.5 - Math.abs(4 * t - 3)),
      clamp01(1.5 - Math.abs(4 * t - 2)),
      clamp01(1.5 - Math.abs(4 * t - 1)),
    ];
  }

  /*
   * Разбор публичного заголовка LAS через абстрактный читатель байтов,
   * чтобы один и тот же код работал над Node Buffer и над DataView в браузере.
   *   r = { u8(o), u16(o), u32(o), i32(o), f64(o), big64?(o) }  // все little-endian
   */
  function parseLasHeader(r) {
    if (!(r.u8(0) === 0x4C && r.u8(1) === 0x41 && r.u8(2) === 0x53 && r.u8(3) === 0x46))
      throw new Error('файл не является LAS (нет сигнатуры LASF)');
    var verMinor = r.u8(25);
    var offToPts = r.u32(96);
    var fmt = r.u8(104) & 0x3f;
    var recLen = r.u16(105);
    var count = r.u32(107);
    if (verMinor >= 4 && r.big64) {
      var extendedCount = r.big64(247);
      if (Number.isFinite(extendedCount) && extendedCount > 0) count = extendedCount;
    }
    var scale = { x: r.f64(131), y: r.f64(139), z: r.f64(147) };
    var offset = { x: r.f64(155), y: r.f64(163), z: r.f64(171) };
    var colorOff = LAS_COLOR_OFFSETS[fmt];
    var classificationOff = LAS_CLASS_OFFSETS[fmt];
    return {
      verMinor: verMinor, offToPts: offToPts, fmt: fmt, recLen: recLen, count: count,
      scale: scale, offset: offset, colorOff: colorOff, hasColor: colorOff !== undefined,
      intensityOff: 12, hasIntensity: recLen >= 14,
      classificationOff: classificationOff, hasClassification: classificationOff !== undefined,
    };
  }

  /*
   * По максимальному значению канала в выборке определяем 8- против 16-битного цвета.
   * maxC === 0 -> цвета нет (поля пусты, используем рампу по высоте).
   */
  function decideColorDivisor(maxC) {
    if (maxC === 0) return { hasColor: false, colDiv: 65535 };
    return { hasColor: true, colDiv: maxC > 255 ? 65535 : 255 };
  }

  /*
   * Джиттер-выборка точек при прореживании.
   *
   * Мобильные SLAM-сканеры (CHCNAV RS10 и т.п.) пишут точки в порядке съёмки —
   * профилями/сканлайнами. При равномерном шаге (каждая N-я точка) выборка
   * систематически попадает на одни и те же профили, и облако рендерится
   * периодическими вертикальными «полосами» с большими пустотами.
   *
   * sampleOffset(win, stride) детерминированно (без состояния, одинаково в Node и
   * браузере) выбирает псевдослучайную позицию внутри каждого окна длиной stride.
   * keepSampledIndex(gi, stride) — оставлять ли глобальную точку gi: по одной на окно,
   * что сохраняет прежний итоговый бюджет точек, но равномерно рассеивает выборку и
   * разрушает периодичность → плотное, «непрозрачное» облако вместо полос.
   */
  function sampleOffset(win, stride) {
    if (stride <= 1) return 0;
    var h = (win * 2654435761) >>> 0;   // Knuth multiplicative hash + финальное перемешивание
    h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
    return (h >>> 0) % stride;
  }
  function keepSampledIndex(gi, stride) {
    if (stride <= 1) return true;
    var win = (gi / stride) | 0;
    return (gi - win * stride) === sampleOffset(win, stride);
  }

  function plyUpAxis(comments, firstXYZ, ranges) {
    var c = (comments || []).join(' ').toLowerCase();
    if (/(?:^|[\s])(?:bim_twin_)?up\s*[=:]\s*y\b|\by[- ]up\b/.test(c)) return 'y';
    if (/(?:^|[\s])(?:bim_twin_)?up\s*[=:]\s*z\b|\bz[- ]up\b|cloudcompare|lixel|chcnav|navvis|leica|trimble|far[o]?|matterport/.test(c)) return 'z';
    var p = firstXYZ || [];
    if (p.some(function (v) { return isFinite(v) && Math.abs(v) > 10000; })) return 'z';
    // PLY has no universal up-axis field. If metadata is absent, infer it only when
    // the robust shortest extent is clearly smaller than the next axis (room-like scans).
    if (ranges && ranges.length >= 3) {
      var order = [0,1,2].sort(function (a,b) { return ranges[a]-ranges[b]; });
      var lo = ranges[order[0]], next = ranges[order[1]];
      if (lo > 1e-6 && lo <= next * 0.78) return ['x','y','z'][order[0]];
    }
    return 'y';
  }

  // Optional CRS metadata convention used by BIM Twin PLY exports. PLY has no
  // standard CRS field, so store WKT as a percent-encoded comment; preserve
  // compatibility with plain-text variants written by other tools.
  function plyCrsWkt(comments) {
    var list = comments || [];
    for (var i = 0; i < list.length; i++) {
      var s = String(list[i] || '').trim();
      s = s.replace(/^bim_twin_/i, '');
      var m = /^crs_wkt_uri\s*=\s*(.*)$/i.exec(s);
      if (m) {
        try { return decodeURIComponent(m[1]).trim() || null; }
        catch (_) { return m[1].trim() || null; }
      }
      m = /^crs_wkt\s*=\s*(.*)$/i.exec(s);
      if (m) return m[1].trim() || null;
      m = /^crs_wkt\s+(.+)$/i.exec(s);
      if (m) return m[1].trim() || null;
      m = /^crs\s*=\s*(EPSG:\s*\d{4,6})$/i.exec(s);
      if (m) return m[1].replace(/\s+/g, '').toUpperCase();
    }
    return null;
  }
  function plyUnits(comments) {
    var list = comments || [];
    for (var i = 0; i < list.length; i++) {
      var m = /^(?:bim_twin_)?units\s*=\s*(.*)$/i.exec(String(list[i] || '').trim());
      if (m) return m[1].trim() || null;
    }
    return null;
  }

  return {
    LAS_COLOR_OFFSETS: LAS_COLOR_OFFSETS,
    LAS_CLASS_OFFSETS: LAS_CLASS_OFFSETS,
    clamp01: clamp01,
    elevationRamp: elevationRamp,
    parseLasHeader: parseLasHeader,
    decideColorDivisor: decideColorDivisor,
    sampleOffset: sampleOffset,
    keepSampledIndex: keepSampledIndex,
    plyUpAxis: plyUpAxis,
    plyCrsWkt: plyCrsWkt,
    plyUnits: plyUnits,
  };
});
