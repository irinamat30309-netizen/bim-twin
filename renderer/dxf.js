/*
 * dxf.js — минимальный, но валидный сериализатор AutoCAD DXF R12 (AC1009).
 * Чистый модуль без зависимостей: window.DXF + module.exports (для тестов).
 * Поддержка сущностей: LINE, POLYLINE (открытая/замкнутая), POINT, CIRCLE, TEXT.
 * R12 не поддерживает LWPOLYLINE, поэтому используем POLYLINE/VERTEX/SEQEND.
 */
(function () {
  'use strict';

  function fmt(n) {
    if (n == null || !isFinite(n)) n = 0;
    var s = (+n).toFixed(6);
    // убираем хвостовые нули, но оставляем хотя бы один знак после точки
    s = s.replace(/0+$/, '').replace(/\.$/, '.0');
    return s;
  }
  function p(code, val) { return code + '\n' + val + '\n'; }
  function xyz(p10, v) {
    return p(p10, fmt(v[0])) + p(p10 + 10, fmt(v[1])) + p(p10 + 20, fmt(v[2] == null ? 0 : v[2]));
  }

  var COLOR = { pline: 5, line: 5, point: 3, circle: 4, text: 2, def: 7 };

  function collectPoints(entities) {
    var pts = [];
    entities.forEach(function (e) {
      if (!e) return;
      if (e.type === 'line') { pts.push(e.a, e.b); }
      else if (e.type === 'polyline') { (e.points || []).forEach(function (q) { pts.push(q); }); }
      else if (e.type === 'point' || e.type === 'text') { pts.push(e.p); }
      else if (e.type === 'circle') {
        var c = e.c, r = e.r || 0;
        pts.push([c[0] - r, c[1] - r, c[2] || 0], [c[0] + r, c[1] + r, c[2] || 0]);
      }
    });
    return pts.filter(Boolean);
  }

  function extents(entities) {
    var pts = collectPoints(entities);
    if (!pts.length) return { mn: [0, 0, 0], mx: [0, 0, 0] };
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    pts.forEach(function (q) {
      for (var i = 0; i < 3; i++) { var v = q[i] == null ? 0 : q[i]; if (v < mn[i]) mn[i] = v; if (v > mx[i]) mx[i] = v; }
    });
    return { mn: mn, mx: mx };
  }

  function layerSet(entities, extra) {
    var set = {};
    (extra || []).forEach(function (l) { set[l] = true; });
    entities.forEach(function (e) { if (e && e.layer) set[e.layer] = true; });
    var names = Object.keys(set);
    if (!names.length) names = ['0'];
    if (names.indexOf('0') < 0) names.unshift('0');
    return names;
  }

  function header(ext) {
    return p(0, 'SECTION') + p(2, 'HEADER') +
      p(9, '$ACADVER') + p(1, 'AC1009') +
      p(9, '$INSBASE') + xyz(10, [0, 0, 0]) +
      p(9, '$EXTMIN') + xyz(10, ext.mn) +
      p(9, '$EXTMAX') + xyz(10, ext.mx) +
      p(0, 'ENDSEC');
  }
  function tables(layers) {
    var s = p(0, 'SECTION') + p(2, 'TABLES') + p(0, 'TABLE') + p(2, 'LAYER') + p(70, layers.length);
    layers.forEach(function (name, i) {
      s += p(0, 'LAYER') + p(2, name) + p(70, 0) + p(62, i === 0 ? 7 : ((i % 6) + 1)) + p(6, 'CONTINUOUS');
    });
    s += p(0, 'ENDTAB') + p(0, 'ENDSEC');
    return s;
  }

  function entLine(e) {
    return p(0, 'LINE') + p(8, e.layer || '0') + p(62, e.color != null ? e.color : COLOR.line) +
      xyz(10, e.a) + xyz(11, e.b);
  }
  function entPolyline(e) {
    var lay = e.layer || '0';
    var s = p(0, 'POLYLINE') + p(8, lay) + p(62, e.color != null ? e.color : COLOR.pline) + p(66, 1) + p(70, e.closed ? 1 : 0);
    (e.points || []).forEach(function (q) {
      s += p(0, 'VERTEX') + p(8, lay) + xyz(10, q);
    });
    s += p(0, 'SEQEND') + p(8, lay);
    return s;
  }
  function entPoint(e) { return p(0, 'POINT') + p(8, e.layer || '0') + p(62, e.color != null ? e.color : COLOR.point) + xyz(10, e.p); }
  function entCircle(e) { return p(0, 'CIRCLE') + p(8, e.layer || '0') + p(62, e.color != null ? e.color : COLOR.circle) + xyz(10, e.c) + p(40, fmt(e.r || 0)); }
  function entText(e) {
    return p(0, 'TEXT') + p(8, e.layer || '0') + p(62, e.color != null ? e.color : COLOR.text) +
      xyz(10, e.p) + p(40, fmt(e.h || 1)) + p(1, String(e.text == null ? '' : e.text));
  }

  function entities(list) {
    var s = p(0, 'SECTION') + p(2, 'ENTITIES');
    list.forEach(function (e) {
      if (!e) return;
      if (e.type === 'line') s += entLine(e);
      else if (e.type === 'polyline') s += entPolyline(e);
      else if (e.type === 'point') s += entPoint(e);
      else if (e.type === 'circle') s += entCircle(e);
      else if (e.type === 'text') s += entText(e);
    });
    s += p(0, 'ENDSEC');
    return s;
  }

  // Главная функция: массив сущностей -> строка DXF R12
  function toDxf(list, opts) {
    list = list || [];
    opts = opts || {};
    var ext = extents(list);
    var layers = layerSet(list, opts.layers);
    return header(ext) + tables(layers) + entities(list) + p(0, 'EOF');
  }

  var DXF = { toDxf: toDxf, extents: extents, fmt: fmt, layerSet: layerSet, COLOR: COLOR };
  if (typeof window !== 'undefined') window.DXF = DXF;
  if (typeof module !== 'undefined' && module.exports) module.exports = DXF;
})();
