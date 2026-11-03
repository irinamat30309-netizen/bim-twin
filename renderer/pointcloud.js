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
      var maxC = 0, scanN = Math.min(count, 4000), scanStep = Math.max(1, Math.floor(count / scanN));
      for (var q = 0; q < count; q += scanStep) {
        var b0 = offToPts + q * recLen + colorOff;
        if (b0 + 6 > buf.byteLength) break;
        var rr = dv.getUint16(b0, true), gg = dv.getUint16(b0 + 2, true), bb = dv.getUint16(b0 + 4, true);
        if (rr > maxC) maxC = rr; if (gg > maxC) maxC = gg; if (bb > maxC) maxC = bb;
      }
      if (maxC === 0) hasColor = false;         // colour fields empty -> use elevation ramp
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

    var verts = null, vcols = null, vnorm = null, vIntensities = null, vClasses = null, intensityMax = 0, intensityType = '', vn = 0, faces = [], plyOrigin = null;
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
          var faceIdx = null;
          for (var fp = 0; fp < el.props.length; fp++) {
            var pr = el.props[fp];
            if (pr.list) { var n = readScalar(pr.countType); var arr = new Array(n); for (var z = 0; z < n; z++) arr[z] = readScalar(pr.itemType); if (!faceIdx) faceIdx = arr; }
            else readScalar(pr.type);
          }
          if (faceIdx && faceIdx.length >= 3) for (var fk = 1; fk + 1 < faceIdx.length; fk++) faces.push(faceIdx[0], faceIdx[fk], faceIdx[fk + 1]);
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
    var upAxis = window.LasCore && window.LasCore.plyUpAxis ? window.LasCore.plyUpAxis(comments, plyOrigin || [], axisRanges) : 'y';
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

    if (faces.length >= 3) {
      // build lit mesh (triangle soup) with optional per-vertex colour
      var tri = faces.length / 3;
      var P = new Float32Array(tri * 9), N = new Float32Array(tri * 9), C = vcols ? new Float32Array(tri * 9) : null;
      for (var f = 0; f < tri; f++) {
        var ia = faces[f * 3], ib = faces[f * 3 + 1], ic = faces[f * 3 + 2];
        var ax = verts[ia * 3], ay = verts[ia * 3 + 1], az = verts[ia * 3 + 2];
        var bx = verts[ib * 3], by = verts[ib * 3 + 1], bz = verts[ib * 3 + 2];
        var cxx = verts[ic * 3], cyy = verts[ic * 3 + 1], czz = verts[ic * 3 + 2];
        var nx, ny, nz;
        if (vnorm) { nx = vnorm[ia * 3]; ny = vnorm[ia * 3 + 1]; nz = vnorm[ia * 3 + 2]; }
        else { var e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cxx - ax, e2y = cyy - ay, e2z = czz - az; nx = e1y * e2z - e1z * e2y; ny = e1z * e2x - e1x * e2z; nz = e1x * e2y - e1y * e2x; var ln = Math.hypot(nx, ny, nz) || 1; nx /= ln; ny /= ln; nz /= ln; }
        var o9 = f * 9;
        P[o9] = ax; P[o9 + 1] = ay; P[o9 + 2] = az; P[o9 + 3] = bx; P[o9 + 4] = by; P[o9 + 5] = bz; P[o9 + 6] = cxx; P[o9 + 7] = cyy; P[o9 + 8] = czz;
        N[o9] = nx; N[o9 + 1] = ny; N[o9 + 2] = nz; N[o9 + 3] = nx; N[o9 + 4] = ny; N[o9 + 5] = nz; N[o9 + 6] = nx; N[o9 + 7] = ny; N[o9 + 8] = nz;
        if (C) { C[o9] = vcols[ia * 3]; C[o9 + 1] = vcols[ia * 3 + 1]; C[o9 + 2] = vcols[ia * 3 + 2]; C[o9 + 3] = vcols[ib * 3]; C[o9 + 4] = vcols[ib * 3 + 1]; C[o9 + 5] = vcols[ib * 3 + 2]; C[o9 + 6] = vcols[ic * 3]; C[o9 + 7] = vcols[ic * 3 + 1]; C[o9 + 8] = vcols[ic * 3 + 2]; }
      }
      return { ok: true, kind: 'mesh', pos: P, nor: N, col: C, count: tri * 3, meta: { kind: 'mesh', tris: tri, w: W, d: D, h: H, format: 'PLY mesh', colored: !!C, srcXform: srcTransform, crsWkt: crsWkt, units:units } };
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
