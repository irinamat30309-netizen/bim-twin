/*
 * pointcloud.js — offline parsers for point-cloud / mesh 3D formats.
 *   .ply  — full: ASCII + binary (LE/BE), point cloud OR mesh, vertex colors + normals.
 *   .las  — full: uncompressed LAS 1.0-1.4, point formats 0-3 / 5 / 7 / 8 / 10,
 *           RGB colour or elevation colour-ramp, adaptive down-sampling.
 *   .laz  — compressed LAS. Desktop imports decode it in the main process with the bundled
 *           LAS/LAZ WASM backend; browser-only fallback uses optional window.LazDecode().
 *   .e57  — ASTM E57 binary import via the local E57Core reader.
 *
 * parse(name, arrayBuffer) -> Promise<result>
 *   result (success): { ok:true, kind:'points'|'mesh', pos:Float32Array,
 *                       col?:Float32Array, nor?:Float32Array, count, meta }
 *   result (failure): { ok:false, reason?, message }
 *
 * Feeds directly into Viewer3DGL.loadCloud() / loadColoredMesh().
 */
(function () {
  'use strict';

  var MAX_POINTS = (typeof window !== 'undefined' && window.__POINT_BUDGET__ > 0) ? window.__POINT_BUDGET__ :
    ((typeof window !== 'undefined' && window.APP_CONFIG && window.APP_CONFIG.DEFAULT_MAX_POINTS) || 3000000); // bounded first-open preview; raise via setBudget

  // Джиттер-выборка (см. las-core.keepSampledIndex): по одной точке на окно длиной
  // stride, но со псевдослучайным смещением. Ломает периодичность порядка съёмки
  // SLAM-сканера (CHCNAV RS10), из-за которой равномерный шаг давал вертикальные
  // «полосы» и разрежённость. Тот же алгоритм, что в Node-парсере.
  function __keepIdx(gi, stride) {
    var LC = (typeof window !== 'undefined' && window.LasCore) ? window.LasCore : null;
    if (LC && LC.keepSampledIndex) return LC.keepSampledIndex(gi, stride);
    if (stride <= 1) return true;
    var win = (gi / stride) | 0;
    var h = (win * 2654435761) >>> 0; h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
    return (gi - win * stride) === ((h >>> 0) % stride);
  }

  // ---- small helpers ----
  function isFloatType(t) { return t === 'float' || t === 'float32' || t === 'double' || t === 'float64'; }
  function colorDivFor(t) { if (isFloatType(t)) return 1; if (t === 'ushort' || t === 'uint16' || t === 'short' || t === 'int16') return 65535; return 255; }
  function intensityDivFor(t, maxValue) {
    t=String(t||'').toLowerCase();
    if(isFloatType(t))return maxValue>1.0001?maxValue:1;
    if(t==='uchar'||t==='uint8')return 255;if(t==='char'||t==='int8')return 127;
    if(t==='ushort'||t==='uint16')return 65535;if(t==='short'||t==='int16')return 32767;
    if(t==='uint'||t==='uint32')return 4294967295;if(t==='int'||t==='int32')return 2147483647;
    return maxValue>1.0001?maxValue:1;
  }
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  // jet-like elevation ramp (blue -> cyan -> green -> yellow -> red)
  function ramp(t) {
    t = clamp01(t);
    var r = clamp01(1.5 - Math.abs(4 * t - 3));
    var g = clamp01(1.5 - Math.abs(4 * t - 2));
    var b = clamp01(1.5 - Math.abs(4 * t - 1));
    return [r, g, b];
  }

  // =====================================================================
  // LAS (uncompressed)
  // =====================================================================
  function lasWkt(dv, bytes) {
    function ascii(off, len) { var s='';for(var i=0;i<len&&off+i<bytes.length;i++){var c=bytes[off+i];if(!c)continue;s+=String.fromCharCode(c);}return s.trim(); }
    function scan(start, count, headLen, evlr) {
      var p=start;
      for(var i=0;i<count;i++){
        if(p+headLen>bytes.length)break;
        var user=ascii(p+2,16), id=evlr?dv.getUint16(p+18,true):dv.getUint16(p+18,true);
        var len=evlr?(typeof dv.getBigUint64==='function'?Number(dv.getBigUint64(p+20,true)):dv.getUint32(p+20,true)):dv.getUint16(p+20,true);
        var data=p+headLen;if(data+len>bytes.length)break;
        if(user==='LASF_Projection'&&(id===2112||id===2111)){
          try{return new TextDecoder('utf-8').decode(bytes.subarray(data,data+len)).replace(/\0+$/g,'').trim();}catch(_){return ascii(data,len);}
        }
        p=data+len;
      }
      return null;
    }
    try {
      var hsize=dv.getUint16(94,true), nvlr=dv.getUint32(100,true), w=scan(hsize,nvlr,54,false);
      if(w)return w;
      if(dv.getUint8(25)>=4&&typeof dv.getBigUint64==='function'){
        var off=Number(dv.getBigUint64(235,true)),num=dv.getUint32(243,true);
        if(off>0&&num>0)return scan(off,num,60,true);
      }
    } catch(_){}
    return null;
  }
  function parseLAS(buf) {
    var dv = new DataView(buf);
    if (!(dv.getUint8(0) === 0x4C && dv.getUint8(1) === 0x41 && dv.getUint8(2) === 0x53 && dv.getUint8(3) === 0x46))
      throw new Error('файл не является LAS (нет сигнатуры LASF)');
    var verMinor = dv.getUint8(25);
    var offToPts = dv.getUint32(96, true);
    var fmt = dv.getUint8(104) & 0x3f;
    var recLen = dv.getUint16(105, true);
    var count = dv.getUint32(107, true);
    if (count === 0 && verMinor >= 4 && typeof dv.getBigUint64 === 'function') count = Number(dv.getBigUint64(247, true));
    if (!count || count < 0) throw new Error('в LAS нет точек');
    var sx = dv.getFloat64(131, true), sy = dv.getFloat64(139, true), sz = dv.getFloat64(147, true);
    var ox = dv.getFloat64(155, true), oy = dv.getFloat64(163, true), oz = dv.getFloat64(171, true);
    var colorOffMap = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };
    var colorOff = colorOffMap[fmt];
    var hasColor = colorOff !== undefined;
    var classOff = fmt >= 6 && fmt <= 10 ? 16 : fmt >= 0 && fmt <= 5 ? 15 : -1;
    var hasIntensity = recLen >= 14, hasClass = classOff >= 0 && classOff < recLen;
    var crsWkt = lasWkt(dv, new Uint8Array(buf));

    var stride = count > MAX_POINTS ? Math.ceil(count / MAX_POINTS) : 1;
    var outN = 0;
    for (var s = 0; s < count; s += stride) outN++;

    // decide colour divisor by pre-scanning a sample (8-bit stored in 16-bit fields is common)
    var colDiv = 65535;
    if (hasColor) {
      // равномерная выборка цвета по всему файлу (а не первые 4000 точек) — иначе серый рендер. (r9)
      var maxC = 0, diffC = 0, sampleN = 0, scanN = Math.min(count, 4000), scanStep = Math.max(1, Math.floor(count / scanN));
      for (var q = 0; q < count; q += scanStep) {
        var b0 = offToPts + q * recLen + colorOff;
        if (b0 + 6 > buf.byteLength) break;
        var rr = dv.getUint16(b0, true), gg = dv.getUint16(b0 + 2, true), bb = dv.getUint16(b0 + 4, true);
        if (rr > maxC) maxC = rr; if (gg > maxC) maxC = gg; if (bb > maxC) maxC = bb;
        if (rr !== gg || gg !== bb) diffC++; sampleN++;
      }
      // r183: серый лидар пишет R=G=B (яркость) — это не цвет; настоящий RGB (R!=G) остаётся цветным.
      if (maxC === 0 || (sampleN > 200 && diffC / sampleN < 0.01)) hasColor = false; // empty/gray fields -> elevation ramp
      else colDiv = maxC > 255 ? 65535 : 255;
    }

    var pos = new Float32Array(outN * 3);
    var col = new Float32Array(outN * 3);
    var intensity = hasIntensity ? new Float32Array(outN) : null;
    var classification = hasClass ? new Uint8Array(outN) : null;
    var mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    var oi = 0, shX = 0, shY = 0, shZ = 0, haveShift = false;
    for (var i = 0; i < count && oi < outN; i++) {
      if (!__keepIdx(i, stride)) continue;
      var base = offToPts + i * recLen;
      if (base + 12 > buf.byteLength) break;
      var X = dv.getInt32(base, true), Y = dv.getInt32(base + 4, true), Z = dv.getInt32(base + 8, true);
      var wxD = X * sx + ox, wyD = Y * sy + oy, wzD = Z * sz + oz;
      if (!haveShift) { shX = wxD; shY = wyD; shZ = wzD; haveShift = true; }
      var wx = wxD - shX, wy = wyD - shY, wz = wzD - shZ;
      pos[oi * 3] = wx; pos[oi * 3 + 1] = wy; pos[oi * 3 + 2] = wz;
      if (wx < mnx) mnx = wx; if (wy < mny) mny = wy; if (wz < mnz) mnz = wz;
      if (wx > mxx) mxx = wx; if (wy > mxy) mxy = wy; if (wz > mxz) mxz = wz;
      if (hasColor) {
        var cb = base + colorOff;
        col[oi * 3] = dv.getUint16(cb, true) / colDiv;
        col[oi * 3 + 1] = dv.getUint16(cb + 2, true) / colDiv;
        col[oi * 3 + 2] = dv.getUint16(cb + 4, true) / colDiv;
      }
      if (intensity) intensity[oi] = dv.getUint16(base + 12, true) / 65535;
      if (classification) classification[oi] = fmt >= 6 ? dv.getUint8(base + classOff) : (dv.getUint8(base + classOff) & 0x1f);
      oi++;
    }
    outN = oi;

    var w = mxx - mnx, d = mxy - mny, h = mxz - mnz;
    var cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
    // transform survey Z-up -> viewer Y-up, centred on X/Y, base at ground
    for (var j = 0; j < outN; j++) {
      var px = pos[j * 3], py = pos[j * 3 + 1], pz = pos[j * 3 + 2];
      pos[j * 3] = px - cx;
      pos[j * 3 + 1] = pz - mnz;
      pos[j * 3 + 2] = -(py - cy);
      if (!hasColor) {
        var c = ramp((pz - mnz) / (h || 1));
        col[j * 3] = c[0]; col[j * 3 + 1] = c[1]; col[j * 3 + 2] = c[2];
      }
    }
    return {
      ok: true, kind: 'points', pos: pos.subarray(0, outN * 3), col: col.subarray(0, outN * 3),
      intensity: intensity ? intensity.subarray(0,outN) : null, classification:classification?classification.subarray(0,outN):null,count: outN,
      meta: { kind: 'points', points: outN, total: count, w: w, d: d, h: h, format: 'LAS fmt ' + fmt, colored: hasColor,
        hasIntensity:!!intensity,hasClassification:!!classification,crsWkt:crsWkt||null,
        offset: { cx: cx + shX, cy: cy + shY, mnz: mnz + shZ }, srcXform: { axis: 'zup', t: [cx + shX, cy + shY, mnz + shZ] } }
    };
  }

  // =====================================================================
  // PLY (ASCII + binary LE/BE; point cloud or mesh)
  // =====================================================================
  function findColor(props) {
    var map = {};
    for (var i = 0; i < props.length; i++) { map[props[i].name.toLowerCase()] = props[i]; }
    var r = map['red'] || map['r'] || map['diffuse_red'];
    var g = map['green'] || map['g'] || map['diffuse_green'];
    var b = map['blue'] || map['b'] || map['diffuse_blue'];
    if (r && g && b) return { r: r.name, g: g.name, b: b.name, type: r.type };
    return null;
  }

  // --- r210: помощники для PLY-меша -------------------------------------------------
  // Грани храним кусками Int32Array: 4 млн треугольников в обычном JS-массиве — это
  // сотни мегабайт и секунды на push(), из-за чего большой меш «не доезжал» до экрана.
  function FaceStore() { this.parts = []; this.part = null; this.used = 0; this.total = 0; }
  FaceStore.prototype.push = function (v) {
    if (!this.part || this.used >= this.part.length) { this.part = new Int32Array(1 << 20); this.parts.push(this.part); this.used = 0; }
    this.part[this.used++] = v; this.total++;
  };
  FaceStore.prototype.push3 = function (a, b, c) { this.push(a); this.push(b); this.push(c); };
  FaceStore.prototype.toIndexArray = function () {
    var out = new Uint32Array(this.total), o = 0, parts = this.parts;
    for (var p = 0; p < parts.length; p++) {
      var a = parts[p], n = (p === parts.length - 1) ? this.used : a.length;
      if (n <= 0) continue;
      out.set(a.subarray(0, n), o); o += n;
    }
    return out;
  };
  // Сглаженные нормали по площади (если в файле нет nx/ny/nz). Нужны для освещения:
  // без них меш рисуется плоским/тёмным. Считаются уже в координатах вьюера.
  function computeVertexNormals(verts, idx, vn) {
    var N = new Float32Array(vn * 3);
    var i, a, b, c, e1x, e1y, e1z, e2x, e2y, e2z, nx, ny, nz;
    for (i = 0; i + 2 < idx.length; i += 3) {
      a = idx[i] * 3; b = idx[i + 1] * 3; c = idx[i + 2] * 3;
      e1x = verts[b] - verts[a]; e1y = verts[b + 1] - verts[a + 1]; e1z = verts[b + 2] - verts[a + 2];
      e2x = verts[c] - verts[a]; e2y = verts[c + 1] - verts[a + 1]; e2z = verts[c + 2] - verts[a + 2];
      nx = e1y * e2z - e1z * e2y; ny = e1z * e2x - e1x * e2z; nz = e1x * e2y - e1y * e2x;
      N[a] += nx; N[a + 1] += ny; N[a + 2] += nz;
      N[b] += nx; N[b + 1] += ny; N[b + 2] += nz;
      N[c] += nx; N[c + 1] += ny; N[c + 2] += nz;
    }
    for (i = 0; i < vn; i++) {
      var x = N[i * 3], y = N[i * 3 + 1], z = N[i * 3 + 2];
      var l = Math.sqrt(x * x + y * y + z * z);
      if (l > 1e-12 && isFinite(l)) { N[i * 3] = x / l; N[i * 3 + 1] = y / l; N[i * 3 + 2] = z / l; }
      else { N[i * 3] = 0; N[i * 3 + 1] = 1; N[i * 3 + 2] = 0; }
    }
    return N;
  }
  // up-axis для меша. PLY не хранит ось вверх; меши из Poisson/Open3D/CloudCompare/MeshLab/
  // Blender — геодезические Z-up. Свой меш приложение пишет с comment up=y (+ coordinate_frame=
  // target-viewer-local) — этот случай распознаётся явно. Без метаданных считаем Z-up:
  // раньше меш из Z-up скана разворачивался «на бок» и на экране был пустой кадр.
  function meshUpAxis(comments, firstXYZ, ranges) {
    var c = (comments || []).join(' ').toLowerCase();
    var m = /(?:^|[\s])(?:bim_twin_)?up\s*[=:]\s*([xyz])\b/.exec(c);
    if (m) return m[1] === 'y' ? 'y' : 'z';
    if (/coordinate_frame\s*[=:]\s*(?:target-)?viewer-local/.test(c)) return 'y';
    if (/y[- ]up\b/.test(c)) return 'y';
    if (/z[- ]up\b|cloudcompare|lixel|chcnav|navvis|leica|trimble|faro\b|matterport/.test(c)) return 'z';
    if (firstXYZ && firstXYZ.some(function (v) { return isFinite(v) && Math.abs(v) > 10000; })) return 'z';
    if (ranges && ranges.length >= 3) {
      var order = [0, 1, 2].sort(function (a, b) { return ranges[a] - ranges[b]; });
      var lo = ranges[order[0]], next = ranges[order[1]];
      if (lo > 1e-6 && lo <= next * 0.78) {
        if (order[0] === 2) return 'z';
        if (order[0] === 1) return 'y';
        return ranges[1] <= ranges[2] * 0.78 ? 'y' : 'z';
      }
    }
    return 'z';
  }

  function parsePLY(buf) {
    var bytes = new Uint8Array(buf);
    // read header (line-by-line up to 'end_header')
    var lines = [], cur = '', idx = 0;
    for (idx = 0; idx < bytes.length; idx++) {
      var ch = bytes[idx];
      if (ch === 10) { var line = cur.replace(/\r$/, ''); lines.push(line); if (line.trim() === 'end_header') { idx++; break; } cur = ''; }
      else cur += String.fromCharCode(ch);
    }
    var dataOffset = idx;
    if (!lines.length || lines[0].trim() !== 'ply') throw new Error('файл не является PLY');
    var format = 'ascii', elements = [], curEl = null, comments = [];
    for (var li = 0; li < lines.length; li++) {
      var t = lines[li].trim().split(/\s+/);
      if (t[0] === 'comment' || t[0] === 'obj_info') comments.push(lines[li].trim().slice(t[0].length).trim());
      if (t[0] === 'format') format = t[1];
      else if (t[0] === 'element') { curEl = { name: t[1], count: parseInt(t[2], 10), props: [] }; elements.push(curEl); }
      else if (t[0] === 'property' && curEl) {
        if (t[1] === 'list') curEl.props.push({ list: true, countType: t[2], itemType: t[3], name: t[4] });
        else curEl.props.push({ list: false, type: t[1], name: t[2] });
      }
    }
    var le = format.indexOf('little') >= 0;
    var ascii = format.indexOf('ascii') >= 0;

    // scalar reader
    var dv = new DataView(buf), off = dataOffset, toks = null, ti = 0;
    if (ascii) { toks = (new TextDecoder('ascii')).decode(bytes.subarray(dataOffset)).split(/\s+/); ti = 0; while (ti < toks.length && toks[ti] === '') ti++; }
    function readScalar(type) {
      if (ascii) { var sN = toks[ti++]; return isFloatType(type) ? parseFloat(sN) : parseInt(sN, 10); }
      var v;
      switch (type) {
        case 'char': case 'int8': v = dv.getInt8(off); off += 1; break;
        case 'uchar': case 'uint8': v = dv.getUint8(off); off += 1; break;
        case 'short': case 'int16': v = dv.getInt16(off, le); off += 2; break;
        case 'ushort': case 'uint16': v = dv.getUint16(off, le); off += 2; break;
        case 'int': case 'int32': v = dv.getInt32(off, le); off += 4; break;
        case 'uint': case 'uint32': v = dv.getUint32(off, le); off += 4; break;
        case 'float': case 'float32': v = dv.getFloat32(off, le); off += 4; break;
        case 'double': case 'float64': v = dv.getFloat64(off, le); off += 8; break;
        default: throw new Error('неизвестный тип PLY: ' + type);
      }
      return v;
    }

    var verts = null, vcols = null, vnorm = null, vIntensities = null, vClasses = null, intensityMax = 0, intensityType = '', vn = 0, faces = new FaceStore(), plyOrigin = null;
    for (var ei = 0; ei < elements.length; ei++) {
      var el = elements[ei];
      if (el.name === 'vertex') {
        vn = el.count;
        verts = new Float32Array(vn * 3);
        var names = el.props.map(function (p) { return p.name; });
        var hasN = names.indexOf('nx') >= 0 && names.indexOf('ny') >= 0 && names.indexOf('nz') >= 0;
        var cinfo = findColor(el.props);
        var propByName={};el.props.forEach(function(p){propByName[String(p.name).toLowerCase()]=p;});
        var iprop=propByName.intensity||propByName.scalar_intensity||propByName.reflectance;
        var cprop=propByName.classification||propByName.class||propByName.label||propByName.scalar_classification;
        if (hasN) vnorm = new Float32Array(vn * 3);
        if (cinfo) vcols = new Float32Array(vn * 3);
        if(iprop){vIntensities=new Float32Array(vn);intensityType=iprop.type;}
        if(cprop)vClasses=new Uint8Array(vn);
        var cdiv = cinfo ? colorDivFor(cinfo.type) : 1;
        for (var vi = 0; vi < vn; vi++) {
          var rec = {};
          for (var pj = 0; pj < el.props.length; pj++) {
            var p = el.props[pj];
            if (p.list) { var cc = readScalar(p.countType); for (var kk = 0; kk < cc; kk++) readScalar(p.itemType); }
            else rec[p.name] = readScalar(p.type);
          }
          if (plyOrigin === null) plyOrigin = [rec.x, rec.y, rec.z];
          verts[vi * 3] = rec.x - plyOrigin[0]; verts[vi * 3 + 1] = rec.y - plyOrigin[1]; verts[vi * 3 + 2] = rec.z - plyOrigin[2];
          if (vnorm) { vnorm[vi * 3] = rec.nx; vnorm[vi * 3 + 1] = rec.ny; vnorm[vi * 3 + 2] = rec.nz; }
          if (vcols) { vcols[vi * 3] = rec[cinfo.r] / cdiv; vcols[vi * 3 + 1] = rec[cinfo.g] / cdiv; vcols[vi * 3 + 2] = rec[cinfo.b] / cdiv; }
          if(vIntensities){var iv=Number(rec[iprop.name]);vIntensities[vi]=isFinite(iv)?iv:0;if(iv>intensityMax)intensityMax=iv;}
          if(vClasses){var cv=Number(rec[cprop.name]);vClasses[vi]=isFinite(cv)?Math.max(0,Math.min(255,Math.round(cv))):0;}
        }
      } else if (el.name === 'face' || (el.props.length === 1 && el.props[0].list)) {
        for (var fi = 0; fi < el.count; fi++) {
          for (var fp = 0; fp < el.props.length; fp++) {
            var pr = el.props[fp];
            if (pr.list) {
              var n = readScalar(pr.countType);
              if (n > 0 && n <= 4096) {
                // треугольники «веером»: (0, i, i+1) — без промежуточного JS-массива на каждую грань
                var first = -1, prev = -1;
                for (var z = 0; z < n; z++) {
                  var vv = readScalar(pr.itemType);
                  if (z === 0) first = vv;
                  else if (z === 1) prev = vv;
                  else { faces.push3(first, prev, vv); prev = vv; }
                }
              } else { for (var z2 = 0; z2 < n; z2++) readScalar(pr.itemType); }
            } else readScalar(pr.type);
          }
        }
      } else {
        // skip unknown element records
        for (var si = 0; si < el.count; si++) for (var sp = 0; sp < el.props.length; sp++) { var pp = el.props[sp]; if (pp.list) { var lc = readScalar(pp.countType); for (var lz = 0; lz < lc; lz++) readScalar(pp.itemType); } else readScalar(pp.type); }
      }
    }
    if (!verts) throw new Error('в PLY нет вершин');
    if(vIntensities){var idiv=intensityDivFor(intensityType,intensityMax);for(var ii=0;ii<vn;ii++)vIntensities[ii]=clamp01(vIntensities[ii]/(idiv||1));}

    // Shift before Float32 storage above, then centre and convert Z-up survey data to viewer Y-up.
    var mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (var m = 0; m < vn; m++) { var x = verts[m * 3], y = verts[m * 3 + 1], zz = verts[m * 3 + 2]; if (x < mnx) mnx = x; if (y < mny) mny = y; if (zz < mnz) mnz = zz; if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (zz > mxz) mxz = zz; }
    var axisStep=Math.max(1,Math.ceil(vn/50000)),axisVals=[[],[],[]];
    for(var ai=0;ai<vn;ai+=axisStep)for(var aa=0;aa<3;aa++)axisVals[aa].push(verts[ai*3+aa]);
    var axisRanges=axisVals.map(function(a){a.sort(function(x,y){return x-y;});return a.length?a[Math.floor((a.length-1)*0.995)]-a[Math.floor((a.length-1)*0.005)]:0;});
    // r210: у меша без метаданных ось «вверх» — геодезическая Z-up (см. meshUpAxis).
    // Точечные облака сохраняют прежнюю эвристику LasCore, чтобы не менять их вид.
    var upAxis = faces.total >= 3
      ? meshUpAxis(comments, plyOrigin || [], axisRanges)
      : (window.LasCore && window.LasCore.plyUpAxis ? window.LasCore.plyUpAxis(comments, plyOrigin || [], axisRanges) : 'y');
    var ccx = (mnx + mxx) / 2, ccy = (mny + mxy) / 2, ccz = (mnz + mxz) / 2;
    var W = mxx - mnx, D = (upAxis === 'z' ? mxy - mny : mxz - mnz), H = (upAxis === 'z' ? mxz - mnz : mxy - mny);
    for (var mm = 0; mm < vn; mm++) {
      var vx = verts[mm * 3], vy = verts[mm * 3 + 1], vz = verts[mm * 3 + 2];
      if (upAxis === 'z') { verts[mm * 3] = vx - ccx; verts[mm * 3 + 1] = vz - mnz; verts[mm * 3 + 2] = -(vy - ccy); if (vnorm) { var nx0=vnorm[mm*3],ny0=vnorm[mm*3+1],nz0=vnorm[mm*3+2]; vnorm[mm*3]=nx0;vnorm[mm*3+1]=nz0;vnorm[mm*3+2]=-ny0; } }
      else { verts[mm * 3] = vx - ccx; verts[mm * 3 + 1] = vy - ccy; verts[mm * 3 + 2] = vz - ccz; }
    }
    var srcTransform = upAxis === 'z' ? { axis:'zup', t:[ccx + plyOrigin[0], ccy + plyOrigin[1], mnz + plyOrigin[2]] } : { axis:'yup', t:[ccx + plyOrigin[0], ccy + plyOrigin[1], ccz + plyOrigin[2]] };
    var crsWkt = window.LasCore && window.LasCore.plyCrsWkt ? window.LasCore.plyCrsWkt(comments) : null;
    var units = window.LasCore && window.LasCore.plyUnits ? window.LasCore.plyUnits(comments) : null;

    if (faces.total >= 3) {
      // r210: ИНДЕКСИРОВАННЫЙ меш вместо «супа» треугольников.
      // Для 4 млн треугольников суп — это 12 млн вершин (435 МБ Float32 только в JS)
      // и ещё столько же в видеопамяти; индексированный меш — ~2 млн вершин и Uint32-индексы
      // (~100 МБ), поэтому 2–4 млн треугольников стабильно грузятся и рисуются.
      var rawIdx = faces.toIndexArray();
      var idx = rawIdx, dropped = 0;
      // грани с индексами вне диапазона (повреждённый файл) не должны давать NaN в вершинах
      var badIdx = 0;
      for (var qc = 0; qc < rawIdx.length; qc++) if (rawIdx[qc] >= vn || rawIdx[qc] < 0) { badIdx++; break; }
      if (badIdx) {
        var okTri = 0;
        for (var qc2 = 0; qc2 + 2 < rawIdx.length; qc2 += 3) { var a0 = rawIdx[qc2], b0 = rawIdx[qc2 + 1], c0i = rawIdx[qc2 + 2]; if (a0 >= 0 && b0 >= 0 && c0i >= 0 && a0 < vn && b0 < vn && c0i < vn) okTri++; }
        idx = new Uint32Array(okTri * 3);
        var wo = 0;
        for (var qc3 = 0; qc3 + 2 < rawIdx.length; qc3 += 3) {
          var a1 = rawIdx[qc3], b1 = rawIdx[qc3 + 1], c1i = rawIdx[qc3 + 2];
          if (a1 >= 0 && b1 >= 0 && c1i >= 0 && a1 < vn && b1 < vn && c1i < vn) { idx[wo++] = a1; idx[wo++] = b1; idx[wo++] = c1i; }
        }
        dropped = (rawIdx.length - idx.length) / 3;
      }
      var tri = idx.length / 3;
      if (!vnorm) vnorm = computeVertexNormals(verts, idx, vn);
      // цвет вершин — байтами (8 бит/канал как в файле): 3,9 МБ вместо 46 МБ на 4 млн вершин
      var colU8 = null;
      if (vcols) {
        colU8 = new Uint8Array(vn * 3);
        for (var ci = 0; ci < vn * 3; ci++) { var cv0 = vcols[ci] * 255 + 0.5; colU8[ci] = cv0 <= 0 ? 0 : (cv0 >= 255 ? 255 : cv0); }
      }
      return {
        ok: true, kind: 'mesh', pos: verts, nor: vnorm, col: colU8, idx: idx, count: vn,
        meta: { kind: 'mesh', tris: tri, vertices: vn, w: W, d: D, h: H,
          format: 'PLY mesh' + (upAxis === 'z' ? ' (Z-up→Y-up)' : ' (Y-up)'),
          colored: !!colU8, upAxis: upAxis, droppedFaces: dropped, indexed: true,
          srcXform: srcTransform, crsWkt: crsWkt, units: units }
      };
    }

    // point cloud (optionally stride-sampled)
    var stride = vn > MAX_POINTS ? Math.ceil(vn / MAX_POINTS) : 1;
    if (stride === 1) {
      if (!vcols) { vcols = new Float32Array(vn * 3); for (var e = 0; e < vn; e++) { var cr = ramp((verts[e * 3 + 1] - (mny - ccy)) / (H || 1)); vcols[e * 3] = cr[0]; vcols[e * 3 + 1] = cr[1]; vcols[e * 3 + 2] = cr[2]; } }
      return { ok: true, kind: 'points', pos: verts, col: vcols, intensity:vIntensities,classification:vClasses,count: vn,
        meta: { kind: 'points', points: vn, total: vn, w: W, d: D, h: H, format: 'PLY cloud' + (upAxis === 'z' ? ' (Z-up)' : ''), colored: !!vcols,
          hasIntensity:!!vIntensities,hasClassification:!!vClasses,srcXform: srcTransform, crsWkt: crsWkt,units:units } };
    }
    var on = 0; for (var ss = 0; ss < vn; ss += stride) on++;
    var pp2 = new Float32Array(on * 3), cc2 = new Float32Array(on * 3), ii2=vIntensities?new Float32Array(on):null,cl2=vClasses?new Uint8Array(on):null,oii = 0;
    for (var iv = 0; iv < vn && oii < on; iv++) {
      if (!__keepIdx(iv, stride)) continue;
      pp2[oii * 3] = verts[iv * 3]; pp2[oii * 3 + 1] = verts[iv * 3 + 1]; pp2[oii * 3 + 2] = verts[iv * 3 + 2];
      if (vcols) { cc2[oii * 3] = vcols[iv * 3]; cc2[oii * 3 + 1] = vcols[iv * 3 + 1]; cc2[oii * 3 + 2] = vcols[iv * 3 + 2]; }
      else { var cg = ramp((verts[iv * 3 + 1] - (mny - ccy)) / (H || 1)); cc2[oii * 3] = cg[0]; cc2[oii * 3 + 1] = cg[1]; cc2[oii * 3 + 2] = cg[2]; }
      if(ii2)ii2[oii]=vIntensities[iv];if(cl2)cl2[oii]=vClasses[iv];
      oii++;
    }
    return { ok: true, kind: 'points', pos: pp2, col: cc2,intensity:ii2,classification:cl2,count: on,
      meta: { kind: 'points', points: on, total: vn, w: W, d: D, h: H, format: 'PLY cloud' + (upAxis === 'z' ? ' (Z-up)' : ''), colored: !!vcols,
        hasIntensity:!!ii2,hasClassification:!!cl2,srcXform: srcTransform, crsWkt: crsWkt,units:units } };
  }

  // =====================================================================
  // E57 — recognise + guide (offline direct view unsupported)
  // =====================================================================
  function parseE57(buf) {
    var E = typeof window !== 'undefined' && window.E57Core;
    if (!E || !E.readBuffer) return { ok:false, reason:'e57', message:'Модуль E57 не загружен' };
    var r = E.readBuffer(buf, { maxPoints: MAX_POINTS });
    if (!r || !r.count) return { ok:false, reason:'e57', message:'В E57 нет корректных точек' };
    var mn=[Infinity,Infinity,Infinity],mx=[-Infinity,-Infinity,-Infinity];
    for(var i=0;i<r.count;i++)for(var a=0;a<3;a++){var v=r.pos[i*3+a];if(v<mn[a])mn[a]=v;if(v>mx[a])mx[a]=v;}
    var cx=(mn[0]+mx[0])/2,cy=(mn[1]+mx[1])/2,mz=mn[2],p=new Float32Array(r.count*3),col=r.col||new Float32Array(r.count*3),h=mx[2]-mn[2];
    for(var i=0;i<r.count;i++){var x=r.pos[i*3],y=r.pos[i*3+1],z=r.pos[i*3+2];p[i*3]=x-cx;p[i*3+1]=z-mz;p[i*3+2]=-(y-cy);if(!r.col){var c=ramp((z-mz)/(h||1));col[i*3]=c[0];col[i*3+1]=c[1];col[i*3+2]=c[2];}}
    return {ok:true,kind:'points',pos:p,col:col,intensity:r.intensity||null,classification:null,count:r.count,
      meta:{kind:'points',points:r.count,total:r.total,w:mx[0]-mn[0],d:mx[1]-mn[1],h,format:'E57 ('+(r.scans.length)+' скан.)',
        colored:!!r.col,hasIntensity:!!r.intensity,hasClassification:false,crsWkt:r.crs||null,
        scans:r.scans.map(function(s){return{name:s.name,count:s.count,pose:s.pose};}),srcXform:{axis:'zup',t:[cx,cy,mz]}}};
  }

  // =====================================================================
  // dispatcher
  // =====================================================================
  function parse(name, buf) {
    var ext = (String(name).split('.').pop() || '').toLowerCase();
    return new Promise(function (resolve) {
      (async function () {
        try {
          if (ext === 'ply') return resolve(parsePLY(buf));
          if (ext === 'las') return resolve(parseLAS(buf));
          if (ext === 'laz') {
            if (typeof window !== 'undefined' && typeof window.LazDecode === 'function') {
              try { var lasBuf = await window.LazDecode(buf); return resolve(parseLAS(lasBuf)); }
              catch (e) { return resolve({ ok: false, reason: 'laz', message: 'Не удалось распаковать LAZ: ' + (e && e.message || e) + '. Попробуйте распаковать в LAS (LAStools/CloudCompare).' }); }
            }
            return resolve({ ok: false, reason: 'laz', message: 'Браузерный fallback не распаковывает LAZ. В настольной версии откройте файл с диска через основной импорт облаков; он использует встроенный локальный декодер.' });
          }
          if (ext === 'e57') return resolve(parseE57(buf));
          return resolve({ ok: false, message: 'Неподдерживаемый 3D-формат: .' + ext });
        } catch (e) {
          return resolve({ ok: false, message: 'Не удалось разобрать файл (.' + ext + '): ' + (e && e.message || e) });
        }
      })();
    });
  }

  function setBudget(n) { n = n | 0; if (n >= 200000) MAX_POINTS = n; return MAX_POINTS; }
  var api = { parse: parse, parsePLY: parsePLY, parseLAS: parseLAS, parseE57: parseE57, setBudget: setBudget, getBudget: function () { return MAX_POINTS; } };
  if (typeof window !== 'undefined') window.PointCloud = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
