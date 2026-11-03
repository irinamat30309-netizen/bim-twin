/*
 * dxfparse.js — чистый парсер DXF (R12/ASCII) → список сущностей,
 * совместимый с dxf.js / draw2d.js.
 * Поддержка: LINE, POINT, CIRCLE, TEXT, POLYLINE(+VERTEX/SEQEND), LWPOLYLINE.
 * window.DXFParse + module.exports.
 */
(function () {
  'use strict';
  function toPairs(text) {
    var toks = String(text).split(/\r\n|\r|\n/);
    var pairs = [];
    for (var i = 0; i + 1 < toks.length; i += 2) {
      var code = parseInt(String(toks[i]).trim(), 10);
      if (isNaN(code)) { i -= 1; continue; } // толерантность к пустым/лишним строкам
      pairs.push([code, toks[i + 1]]);
    }
    return pairs;
  }
  function blocksInEntities(pairs) {
    var start = -1;
    for (var k = 0; k < pairs.length; k++) {
      if (pairs[k][0] === 2 && String(pairs[k][1]).trim() === 'ENTITIES') { start = k + 1; break; }
    }
    var blocks = [];
    if (start < 0) return blocks;
    var block = null;
    for (k = start; k < pairs.length; k++) {
      var code = pairs[k][0], val = pairs[k][1];
      if (code === 0) {
        var t = String(val).trim();
        if (block) blocks.push(block);
        if (t === 'ENDSEC') { block = null; break; }
        block = { type: t, codes: [] };
      } else if (block) { block.codes.push([code, val]); }
    }
    return blocks;
  }
  function num(codes, c, def) { for (var j = 0; j < codes.length; j++) if (codes[j][0] === c) return parseFloat(codes[j][1]); return def; }
  function str(codes, c, def) { for (var j = 0; j < codes.length; j++) if (codes[j][0] === c) return String(codes[j][1]); return def; }
  function layerOf(codes) { return String(str(codes, 8, '0')).trim() || '0'; }

  function parse(text) {
    var blocks = blocksInEntities(toPairs(text));
    var out = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i], cs = b.codes, layer = layerOf(cs);
      if (b.type === 'LINE') {
        out.push({ type: 'line', layer: layer, a: [num(cs, 10, 0), num(cs, 20, 0), num(cs, 30, 0)], b: [num(cs, 11, 0), num(cs, 21, 0), num(cs, 31, 0)] });
      } else if (b.type === 'POINT') {
        out.push({ type: 'point', layer: layer, p: [num(cs, 10, 0), num(cs, 20, 0), num(cs, 30, 0)] });
      } else if (b.type === 'CIRCLE') {
        out.push({ type: 'circle', layer: layer, c: [num(cs, 10, 0), num(cs, 20, 0), num(cs, 30, 0)], r: num(cs, 40, 0) });
      } else if (b.type === 'TEXT') {
        out.push({ type: 'text', layer: layer, p: [num(cs, 10, 0), num(cs, 20, 0), num(cs, 30, 0)], h: num(cs, 40, 1), text: str(cs, 1, '') });
      } else if (b.type === 'LWPOLYLINE') {
        var pts = [], cx = null;
        for (var j = 0; j < cs.length; j++) {
          if (cs[j][0] === 10) cx = parseFloat(cs[j][1]);
          else if (cs[j][0] === 20 && cx != null) { pts.push([cx, parseFloat(cs[j][1]), 0]); cx = null; }
        }
        out.push({ type: 'polyline', layer: layer, points: pts, closed: ((num(cs, 70, 0) | 0) & 1) === 1 });
      } else if (b.type === 'POLYLINE') {
        var closed = ((num(cs, 70, 0) | 0) & 1) === 1, vpts = [];
        while (i + 1 < blocks.length && blocks[i + 1].type === 'VERTEX') {
          var vc = blocks[++i].codes;
          vpts.push([num(vc, 10, 0), num(vc, 20, 0), num(vc, 30, 0)]);
        }
        if (i + 1 < blocks.length && blocks[i + 1].type === 'SEQEND') i++;
        out.push({ type: 'polyline', layer: layer, points: vpts, closed: closed });
      }
    }
    return out;
  }

  // Список слоёв, встречающихся в сущностях (для дерева слоёв).
  function layers(ents) {
    var set = {}; (ents || []).forEach(function (e) { set[e.layer || '0'] = true; });
    return Object.keys(set);
  }

  var API = { parse: parse, layers: layers, toPairs: toPairs };
  if (typeof window !== 'undefined') window.DXFParse = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
