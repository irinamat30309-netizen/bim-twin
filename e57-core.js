/* e57-core.js — v1223
 * Честный ASTM E57 (libE57Format-совместимый) ридер и райтер без зависимостей.
 *   • страницы по 1024 байт: 1020 байт данных + CRC-32C (Castagnoli, big-endian);
 *   • CompressedVector: data-пакеты, bitpack для Integer/ScaledInteger, raw для Float;
 *   • чтение: несколько сканов, поза (кватернион + перенос), сферические координаты,
 *     cartesianInvalidState, цвет/интенсивность, прореживание до maxPoints;
 *   • запись: cartesianXYZ (double) + RGB (uint8) + intensity (опц.), пакеты ≤ 64 КиБ.
 * Node: require('./e57-core')  ·  Browser: <script src="../e57-core.js"> -> window.E57Core
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof root !== 'undefined') root.E57Core = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var PAGE = 1024, PAYLOAD = 1020;

  // ---------- CRC-32C ----------
  var CRC_T = (function () { var t = new Uint32Array(256); for (var i = 0; i < 256; i++) { var c = i; for (var k = 0; k < 8; k++) c = (c & 1) ? (0x82F63B78 ^ (c >>> 1)) : (c >>> 1); t[i] = c >>> 0; } return t; })();
  function crc32c(u8, off, len) { var c = 0xFFFFFFFF; for (var i = off, e = off + len; i < e; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

  function logicalToPhysical(L) { return Math.floor(L / PAYLOAD) * PAGE + (L % PAYLOAD); }
  function physicalToLogical(P) { return Math.floor(P / PAGE) * PAYLOAD + (P % PAGE); }

  // ---------- мини-XML парсер (элементы, атрибуты, текст, CDATA) ----------
  function decodeEnt(s) { return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, function (m, e) { var l = e.toLowerCase(); if (l === 'lt') return '<'; if (l === 'gt') return '>'; if (l === 'amp') return '&'; if (l === 'quot') return '"'; if (l === 'apos') return "'"; var cp = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10); if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF) || (cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) || cp === 0xFFFE || cp === 0xFFFF) throw new Error('E57 XML: недопустимая числовая XML-ссылка'); return String.fromCodePoint(cp); }); }
  function markupEnd(s, from, allowSubset) {
    var quote = '', subsetDepth = 0;
    for (var i = from; i < s.length; i++) {
      var c = s[i];
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (allowSubset && c === '[') { subsetDepth++; continue; }
      if (allowSubset && c === ']' && subsetDepth) { subsetDepth--; continue; }
      if (c === '>' && subsetDepth === 0) return i;
    }
    return -1;
  }
  function parseXML(s) {
    s = String(s == null ? '' : s);
    var rootN = { name: '#root', attrs: {}, children: [], text: '' }, stack = [rootN], i = 0, n = s.length;
    while (i < n) {
      var lt = s.indexOf('<', i);
      if (lt < 0) { stack[stack.length - 1].text += decodeEnt(s.slice(i)); break; }
      if (lt > i) stack[stack.length - 1].text += decodeEnt(s.slice(i, lt));
      if (s.startsWith('<![CDATA[', lt)) {
        if (stack.length === 1) throw new Error('E57 XML: CDATA вне корневого элемента');
        var ce = s.indexOf(']]>', lt + 9);
        if (ce < 0) throw new Error('E57 XML: незавершённая CDATA');
        stack[stack.length - 1].text += s.slice(lt + 9, ce); i = ce + 3; continue;
      }
      if (s.startsWith('<!--', lt)) {
        var commentEnd = s.indexOf('-->', lt + 4);
        if (commentEnd < 0) throw new Error('E57 XML: незавершённый комментарий');
        i = commentEnd + 3; continue;
      }
      if (s.startsWith('<?', lt)) {
        var piEnd = s.indexOf('?>', lt + 2);
        if (piEnd < 0) throw new Error('E57 XML: незавершённая processing instruction');
        i = piEnd + 2; continue;
      }
      if (s.startsWith('<!', lt)) {
        var declEnd = markupEnd(s, lt + 2, true);
        if (declEnd < 0) throw new Error('E57 XML: незавершённое объявление');
        i = declEnd + 1; continue;
      }
      var gt = markupEnd(s, lt + 1, false);
      if (gt < 0) throw new Error('E57 XML: незавершённый тег');
      var tag = s.slice(lt + 1, gt).trim();
      if (!tag) throw new Error('E57 XML: пустой тег');
      if (tag[0] === '/') {
        var closeName = tag.slice(1).trim();
        if (!closeName || /\s/.test(closeName) || stack.length <= 1 ||
            stack[stack.length - 1].name !== closeName) {
          throw new Error('E57 XML: несогласованный закрывающий тег ' + closeName);
        }
        stack.pop(); i = gt + 1; continue;
      }
      var selfClose = tag[tag.length - 1] === '/';
      if (selfClose) tag = tag.slice(0, -1).trim();
      var m = /^([^\s/]+)/.exec(tag);
      if (!m) throw new Error('E57 XML: некорректное имя элемента');
      var node = { name: m[1], attrs: {}, children: [], text: '' };
      var re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g, a;
      while ((a = re.exec(tag))) node.attrs[a[1]] = decodeEnt(a[3] != null ? a[3] : a[4]);
      stack[stack.length - 1].children.push(node);
      if (!selfClose) stack.push(node);
      i = gt + 1;
    }
    if (stack.length !== 1) throw new Error('E57 XML: незакрытый элемент ' + stack[stack.length - 1].name);
    return rootN.children[0] || null;
  }
  function child(node, name) { if (!node) return null; for (var i = 0; i < node.children.length; i++) if (node.children[i].name === name) return node.children[i]; return null; }
  function numVal(node, def) { if (!node) return def; var t = String(node.text || '').trim(); if (t === '') return 0; var v = Number(t); return isFinite(v) ? v : def; }

  // ---------- чтение файла по логическим адресам ----------
  // readPhys(offset, length) -> Uint8Array (физические байты файла)
  function makeLogicalReader(readPhys, fileLen) {
    return function readLogical(L, len) {
      var out = new Uint8Array(len), o = 0;
      while (o < len) {
        var pg = Math.floor(L / PAYLOAD), inPg = L % PAYLOAD, take = Math.min(PAYLOAD - inPg, len - o);
        var p = pg * PAGE + inPg; if (p + take > fileLen) throw new Error('E57: выход за пределы файла');
        out.set(readPhys(p, take), o); o += take; L += take;
      }
      return out;
    };
  }
  function u64(dv, o) { return dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296; }

  function readHeader(readPhys, fileLen) {
    var h = readPhys(0, 48); var sig = String.fromCharCode.apply(null, h.subarray(0, 8));
    if (sig !== 'ASTM-E57') throw new Error('не E57-файл (нет сигнатуры ASTM-E57)');
    var dv = new DataView(h.buffer, h.byteOffset, 48);
    var hdr = { major: dv.getUint32(8, true), minor: dv.getUint32(12, true), fileLength: u64(dv, 16), xmlPhysicalOffset: u64(dv, 24), xmlLogicalLength: u64(dv, 32), pageSize: u64(dv, 40) };
    if (hdr.pageSize !== PAGE) throw new Error('E57: неподдерживаемый размер страницы ' + hdr.pageSize);
    return hdr;
  }

  // ---------- описание полей прототипа ----------
  function protoFields(protoNode) {
    return protoNode.children.map(function (c) {
      var t = c.attrs.type, f = { name: c.name, type: t };
      if (t === 'Float') { f.bytes = (c.attrs.precision === 'single') ? 4 : 8; }
      else if (t === 'Integer' || t === 'ScaledInteger') {
        var mn = c.attrs.minimum != null ? Number(c.attrs.minimum) : -9223372036854775808;
        var mx = c.attrs.maximum != null ? Number(c.attrs.maximum) : 9223372036854775807;
        f.min = mn; f.max = mx; var range = mx - mn;
        f.bits = range <= 0 ? 0 : Math.ceil(Math.log2(range + 1));
        if (f.bits > 0 && Math.pow(2, f.bits) < range + 1) f.bits++;
        f.scale = t === 'ScaledInteger' ? Number(c.attrs.scale != null ? c.attrs.scale : 1) : 1;
        f.offset = t === 'ScaledInteger' ? Number(c.attrs.offset != null ? c.attrs.offset : 0) : 0;
        if (f.bits > 53) throw new Error('E57: поле ' + c.name + ' шире 53 бит не поддержано');
      } else throw new Error('E57: неподдерживаемый тип поля ' + t);
      return f;
    });
  }

  // Потоковый декодер одного bytestream: feed(bytes) -> вызывает emit(value, index)
  function makeDecoder(f, emit) {
    var idx = 0;
    if (f.type === 'Float') {
      var carry = new Uint8Array(0), bw = f.bytes;
      return { feed: function (b) {
        var buf = b; if (carry.length) { buf = new Uint8Array(carry.length + b.length); buf.set(carry, 0); buf.set(b, carry.length); }
        var cnt = Math.floor(buf.length / bw), dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
        for (var k = 0; k < cnt; k++) emit(bw === 8 ? dv.getFloat64(k * bw, true) : dv.getFloat32(k * bw, true), idx++);
        carry = buf.slice(cnt * bw);
      }, count: function () { return idx; } };
    }
    var bits = f.bits;
    if (bits === 0) return { feed: function () {}, constant: f.min * f.scale + f.offset, count: function () { return Infinity; } };
    // LSB-first поток бит
    var acc = 0, accBits = 0, pow = Math.pow(2, bits);
    return { feed: function (b) {
      for (var i = 0; i < b.length; i++) {
        acc += b[i] * Math.pow(2, accBits); accBits += 8;
        while (accBits >= bits) {
          var v = acc % pow; acc = (acc - v) / pow; accBits -= bits;
          emit((v + f.min) * f.scale + f.offset, idx++);
        }
      }
    }, count: function () { return idx; } };
  }

  // Прочитать один скан (CompressedVector) — вызывает onField(name, value, recordIndex).
  function readCompressedVector(readLogical, fileOffsetPhys, recordCount, fields, onValue) {
    var L = physicalToLogical(fileOffsetPhys);
    var sh = readLogical(L, 32), sdv = new DataView(sh.buffer, sh.byteOffset, 32);
    if (sh[0] !== 1) throw new Error('E57: ожидалась секция CompressedVector');
    var secLen = u64(sdv, 8), dataPhys = u64(sdv, 16);
    var decs = fields.map(function (f, fi) { return makeDecoder(f, function (v, i) { if (i < recordCount) onValue(fi, v, i); }); });
    var pl = physicalToLogical(dataPhys), end = L + secLen, guard = 0;
    while (pl < end && guard++ < 1e8) {
      var ph = readLogical(pl, 4), ptype = ph[0], plen = (ph[2] | (ph[3] << 8)) + 1;
      if (ptype === 1) {
        var pk = readLogical(pl, plen), pdv = new DataView(pk.buffer, pk.byteOffset, plen);
        var nbs = pdv.getUint16(4, true), off = 6 + nbs * 2;
        for (var s = 0; s < nbs; s++) { var bl = pdv.getUint16(6 + s * 2, true); if (s < decs.length && bl) decs[s].feed(pk.subarray(off, off + bl)); off += bl; }
        var done = true; for (var d = 0; d < decs.length; d++) if (decs[d].count() < recordCount) { done = false; break; }
        if (done) break;
      } else if (ptype === 0 || ptype === 2) { /* index/empty */ } else throw new Error('E57: неизвестный тип пакета ' + ptype);
      pl += plen;
    }
    return decs;
  }

  function quatToMat(w, x, y, z) {
    var n = Math.sqrt(w * w + x * x + y * y + z * z) || 1; w /= n; x /= n; y /= n; z /= n;
    return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
      2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
      2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
  }

  /**
   * read(readPhys, fileLen, opts) -> { scans:[{name,count}], total, pos:Float64Array (мировые XYZ),
   *   col:Float32Array 0..1 | null, intensity:Float32Array|null, count }
   * opts.maxPoints — прореживание равномерным шагом по всем сканам.
   */
  function read(readPhys, fileLen, opts) {
    opts = opts || {};
    var hdr = readHeader(readPhys, fileLen), readLogical = makeLogicalReader(readPhys, fileLen);
    var xmlBytes = readLogical(physicalToLogical(hdr.xmlPhysicalOffset), hdr.xmlLogicalLength);
    var xml = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8').decode(xmlBytes) : Buffer.from(xmlBytes).toString('utf8');
    var rootN = parseXML(xml); var d3 = child(rootN, 'data3D');
    var coordinateMetadata = String((child(rootN, 'coordinateMetadata') || {}).text || '').trim() || null;
    var scans = d3 ? d3.children : [];
    var infos = scans.map(function (sc) { var pts = child(sc, 'points'); return { node: sc, pts: pts, count: pts ? Number(pts.attrs.recordCount || 0) : 0 }; });
    var total = infos.reduce(function (a, s) { return a + s.count; }, 0);
    if (!total) throw new Error('В E57 нет точек');
    var maxP = opts.maxPoints > 0 ? opts.maxPoints : total, stride = Math.max(1, Math.ceil(total / maxP));
    var outCap = Math.ceil(total / stride) + infos.length;
    var pos = new Float64Array(outCap * 3), col = null, inten = null, oi = 0, anyColor = false, anyInt = false;
    var colAll = new Float32Array(outCap * 3), intAll = new Float32Array(outCap);
    var scanList = [], gIndex = 0;
    infos.forEach(function (s) {
      if (!s.pts || !s.count) return;
      var fields = protoFields(child(s.pts, 'prototype'));
      var F = {}; fields.forEach(function (f, i) { F[f.name] = i; });
      var cart = F.cartesianX != null && F.cartesianY != null && F.cartesianZ != null;
      var sph = !cart && F.sphericalRange != null && F.sphericalAzimuth != null && F.sphericalElevation != null;
      if (!cart && !sph) return;
      var hasRGB = F.colorRed != null && F.colorGreen != null && F.colorBlue != null;
      var cl = child(s.node, 'colorLimits');
      var cMin = [0, 0, 0], cMax = [255, 255, 255];
      ['Red', 'Green', 'Blue'].forEach(function (k, j) {
        var f = fields[F['color' + k]];
        cMin[j] = cl ? numVal(child(cl, 'color' + k + 'Minimum'), f ? f.min : 0) : (f ? f.min : 0);
        cMax[j] = cl ? numVal(child(cl, 'color' + k + 'Maximum'), f ? f.max : 255) : (f ? f.max : 255);
        if (!(cMax[j] > cMin[j])) { cMin[j] = 0; cMax[j] = 255; }
      });
      var hasInt = F.intensity != null, il = child(s.node, 'intensityLimits');
      var iMin = il ? numVal(child(il, 'intensityMinimum'), 0) : (hasInt && fields[F.intensity].min != null ? fields[F.intensity].min : 0);
      var iMax = il ? numVal(child(il, 'intensityMaximum'), 1) : (hasInt && fields[F.intensity].max != null ? fields[F.intensity].max : 1);
      if (!(iMax > iMin)) { iMin = 0; iMax = 1; }
      var R = null, T = [0, 0, 0], Q = { w: 1, x: 0, y: 0, z: 0 }, pose = child(s.node, 'pose');
      if (pose) {
        var rq = child(pose, 'rotation'), tr = child(pose, 'translation');
        if (rq) {
          Q = { w: numVal(child(rq, 'w'), 1), x: numVal(child(rq, 'x'), 0),
            y: numVal(child(rq, 'y'), 0), z: numVal(child(rq, 'z'), 0) };
          R = quatToMat(Q.w, Q.x, Q.y, Q.z);
        }
        if (tr) T = [numVal(child(tr, 'x'), 0), numVal(child(tr, 'y'), 0), numVal(child(tr, 'z'), 0)];
      }
      // отбираем записи с шагом stride по глобальному индексу
      var first = (stride - (gIndex % stride)) % stride, keepN = s.count > first ? Math.floor((s.count - 1 - first) / stride) + 1 : 0;
      var tmp = fields.map(function () { return new Float64Array(keepN); });
      var decs = readCompressedVector(readLogical, Number(s.pts.attrs.fileOffset), s.count, fields, function (fi, v, i) {
        if (i < first || (i - first) % stride) return; var k = (i - first) / stride; if (k < keepN) tmp[fi][k] = v;
      });
      decs.forEach(function (d, fi) { if (d.constant != null) tmp[fi].fill(d.constant); });
      var inv = F.cartesianInvalidState != null ? tmp[F.cartesianInvalidState] : (F.sphericalInvalidState != null ? tmp[F.sphericalInvalidState] : null);
      var start = oi;
      for (var k = 0; k < keepN; k++) {
        if (inv && inv[k] > 0) continue;
        var x, y, z;
        if (cart) { x = tmp[F.cartesianX][k]; y = tmp[F.cartesianY][k]; z = tmp[F.cartesianZ][k]; }
        else { var r = tmp[F.sphericalRange][k], az = tmp[F.sphericalAzimuth][k], el = tmp[F.sphericalElevation][k]; x = r * Math.cos(el) * Math.cos(az); y = r * Math.cos(el) * Math.sin(az); z = r * Math.sin(el); }
        if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
        if (R) { var X = R[0] * x + R[1] * y + R[2] * z, Y = R[3] * x + R[4] * y + R[5] * z, Z = R[6] * x + R[7] * y + R[8] * z; x = X; y = Y; z = Z; }
        pos[oi * 3] = x + T[0]; pos[oi * 3 + 1] = y + T[1]; pos[oi * 3 + 2] = z + T[2];
        if (hasRGB) { colAll[oi * 3] = (tmp[F.colorRed][k] - cMin[0]) / (cMax[0] - cMin[0]); colAll[oi * 3 + 1] = (tmp[F.colorGreen][k] - cMin[1]) / (cMax[1] - cMin[1]); colAll[oi * 3 + 2] = (tmp[F.colorBlue][k] - cMin[2]) / (cMax[2] - cMin[2]); }
        if (hasInt) intAll[oi] = (tmp[F.intensity][k] - iMin) / (iMax - iMin);
        oi++;
      }
      if (hasRGB) anyColor = true; if (hasInt) anyInt = true;
      if (!hasRGB && hasInt) for (var q = start; q < oi; q++) { var g = Math.max(0, Math.min(1, intAll[q])); colAll[q * 3] = colAll[q * 3 + 1] = colAll[q * 3 + 2] = g; }
      scanList.push({
        name: (child(s.node, 'name') || {}).text || ('Scan ' + (scanList.length + 1)),
        start: start, count: oi - start, recordCount: s.count,
        pose: { R: R, T: T, quaternion: Q }
      });
      gIndex += s.count;
    });
    if (anyColor || anyInt) col = colAll.subarray(0, oi * 3);
    if (anyInt) inten = intAll.subarray(0, oi);
    return { pos: pos.subarray(0, oi * 3), col: col, intensity: inten, count: oi, total: total, scans: scanList, colored: anyColor, hasIntensity: anyInt, crs: coordinateMetadata };
  }

  function readBuffer(u8, opts) {
    if (u8 instanceof ArrayBuffer) u8 = new Uint8Array(u8);
    return read(function (o, l) { return u8.subarray(o, o + l); }, u8.length, opts);
  }

  // ---------- запись ----------
  // Text fields below are emitted as XML CDATA. Do not entity-escape inside
  // CDATA (the parser would return the literal "&amp;"), and split the only
  // forbidden sequence so arbitrary scanner names/WKT cannot terminate it.
  function xmlCdata(s) { return '<![CDATA[' + String(s == null ? '' : s).replace(/\]\]>/g, ']]]]><![CDATA[>') + ']]>'; }
  function guid() { var h = '0123456789abcdef', s = ''; for (var i = 0; i < 32; i++) s += h[(Math.random() * 16) | 0]; return '{' + s.slice(0, 8) + '-' + s.slice(8, 12) + '-4' + s.slice(13, 16) + '-a' + s.slice(17, 20) + '-' + s.slice(20, 32) + '}'; }
  function fnum(v) { return Number(v).toPrecision(17); }
  function normalizedQuaternion(value, rotation) {
    var q = value && [value.w, value.x, value.y, value.z].every(function (v) { return Number.isFinite(Number(v)); })
      ? { w: Number(value.w), x: Number(value.x), y: Number(value.y), z: Number(value.z) }
      : null;
    if (!q && rotation && rotation.length === 9 && Array.prototype.every.call(rotation, function (v) { return Number.isFinite(Number(v)); })) {
      var m = Array.prototype.map.call(rotation, Number);
      var tr = m[0] + m[4] + m[8];
      if (tr > 0) {
        var s = Math.sqrt(tr + 1) * 2;
        q = { w: 0.25 * s, x: (m[7] - m[5]) / s, y: (m[2] - m[6]) / s, z: (m[3] - m[1]) / s };
      } else if (m[0] > m[4] && m[0] > m[8]) {
        var s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
        q = { w: (m[7] - m[5]) / s, x: 0.25 * s, y: (m[1] + m[3]) / s, z: (m[2] + m[6]) / s };
      } else if (m[4] > m[8]) {
        var s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
        q = { w: (m[2] - m[6]) / s, x: (m[1] + m[3]) / s, y: 0.25 * s, z: (m[5] + m[7]) / s };
      } else {
        var s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
        q = { w: (m[3] - m[1]) / s, x: (m[2] + m[6]) / s, y: (m[5] + m[7]) / s, z: 0.25 * s };
      }
    }
    q = q || { w: 1, x: 0, y: 0, z: 0 };
    var norm = Math.hypot(q.w, q.x, q.y, q.z);
    if (!Number.isFinite(norm) || norm < 1e-12) throw new Error('E57: некорректная поза скана');
    return { w: q.w / norm, x: q.x / norm, y: q.y / norm, z: q.z / norm };
  }

  function normalizeScanRanges(scans, pointCount) {
    if (!Array.isArray(scans) || scans.length < 1) return null;
    var cursor = 0, result = [];
    scans.forEach(function (scan, index) {
      scan = scan || {};
      var start = scan.start == null ? cursor : Number(scan.start);
      var count = Number(scan.count);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 0 ||
          start !== cursor || start + count > pointCount) {
        throw new Error('E57: scan ranges must be contiguous and match the point buffer');
      }
      if (count > 0) {
        var pose = scan.pose || {}, T = Array.isArray(pose.T) ? pose.T.slice(0, 3).map(Number) : [0, 0, 0];
        if (T.length !== 3 || !T.every(Number.isFinite)) throw new Error('E57: scan translation is invalid');
        var q = normalizedQuaternion(pose.quaternion, pose.R);
        result.push({
          start: start, count: count,
          name: String(scan.name || ('Scan ' + (index + 1))),
          T: T, q: q, R: quatToMat(q.w, q.x, q.y, q.z)
        });
      }
      cursor += count;
    });
    if (cursor !== pointCount) throw new Error('E57: scan ranges do not cover the point buffer');
    return result.length > 0 ? result : null;
  }

  function worldToScan(pos, index, spec) {
    var dx = Number(pos[index * 3]) - spec.T[0];
    var dy = Number(pos[index * 3 + 1]) - spec.T[1];
    var dz = Number(pos[index * 3 + 2]) - spec.T[2];
    if (!Number.isFinite(dx + dy + dz)) throw new Error('E57: координаты содержат NaN/Infinity');
    var R = spec.R;
    return [
      R[0] * dx + R[3] * dy + R[6] * dz,
      R[1] * dx + R[4] * dy + R[7] * dz,
      R[2] * dx + R[5] * dy + R[8] * dz
    ];
  }

  function writeMultiScan(cloud, pointCount, col, inten, scans, scale255) {
    var nStreams = 3 + (col ? 3 : 0) + (inten ? 1 : 0) + 1;
    var recordBytes = 24 + (col ? 3 : 0) + (inten ? 4 : 0) + 1;
    var headerLength = 6 + 2 * nStreams;
    var maxRecordCount = Math.floor((65536 - headerLength - 4) / recordBytes);
    var sectionStart = 48, builtScans = [];
    scans.forEach(function (scan) {
      var mn = [Infinity, Infinity, Infinity], mxv = [-Infinity, -Infinity, -Infinity];
      for (var i = scan.start; i < scan.start + scan.count; i++) {
        var local = worldToScan(cloud.pos, i, scan);
        for (var a = 0; a < 3; a++) { if (local[a] < mn[a]) mn[a] = local[a]; if (local[a] > mxv[a]) mxv[a] = local[a]; }
      }
      var packets = [], sectionLength = 32;
      for (var r0 = 0; r0 < scan.count;) {
        var k = Math.min(maxRecordCount, scan.count - r0);
        var dataLength = 24 * k + (col ? 3 * k : 0) + (inten ? 4 * k : 0) + Math.ceil(k / 8);
        var needed = headerLength + dataLength, packetLength = (needed + 3) & ~3;
        var packet = new Uint8Array(packetLength), dv = new DataView(packet.buffer);
        packet[0] = 1; packet[1] = 0; dv.setUint16(2, packetLength - 1, true); dv.setUint16(4, nStreams, true);
        var stream = 0, off = headerLength;
        function setLength(bytes) { dv.setUint16(6 + stream * 2, bytes, true); stream++; }
        setLength(k * 8); setLength(k * 8); setLength(k * 8);
        var yStream = off + k * 8, zStream = off + k * 16;
        for (var j = 0; j < k; j++) {
          var local = worldToScan(cloud.pos, scan.start + r0 + j, scan);
          dv.setFloat64(off + j * 8, local[0], true);
          dv.setFloat64(yStream + j * 8, local[1], true);
          dv.setFloat64(zStream + j * 8, local[2], true);
        }
        off += k * 24;
        if (col) for (var channel = 0; channel < 3; channel++) {
          setLength(k);
          for (var j = 0; j < k; j++) {
            var color = Number(col[(scan.start + r0 + j) * 3 + channel]);
            color = scale255 ? Math.round(color) : Math.round(color * 255);
            packet[off++] = !Number.isFinite(color) || color < 0 ? 0 : color > 255 ? 255 : color;
          }
        }
        if (inten) {
          setLength(k * 4);
          for (var j = 0; j < k; j++) {
            var iv = Number(inten[scan.start + r0 + j]);
            dv.setFloat32(off, Number.isFinite(iv) ? Math.max(0, Math.min(1, iv)) : 0, true);
            off += 4;
          }
        }
        setLength(Math.ceil(k / 8)); off += Math.ceil(k / 8);
        packets.push(packet); sectionLength += packetLength; r0 += k;
      }
      builtScans.push(Object.assign({}, scan, { mn: mn, mx: mxv, sectionStart: sectionStart,
        dataStart: sectionStart + 32, sectionLength: sectionLength, packets: packets }));
      sectionStart += sectionLength;
    });

    var xmlEntries = builtScans.map(function (scan) {
      return '<vectorChild type="Structure"><guid type="String"><![CDATA[' + guid() + ']]></guid>' +
        '<name type="String">' + xmlCdata(scan.name) + '</name>' +
        (col ? '<colorLimits type="Structure"><colorRedMinimum type="Integer">0</colorRedMinimum><colorRedMaximum type="Integer">255</colorRedMaximum><colorGreenMinimum type="Integer">0</colorGreenMinimum><colorGreenMaximum type="Integer">255</colorGreenMaximum><colorBlueMinimum type="Integer">0</colorBlueMinimum><colorBlueMaximum type="Integer">255</colorBlueMaximum></colorLimits>' : '') +
        (inten ? '<intensityLimits type="Structure"><intensityMinimum type="Float">0</intensityMinimum><intensityMaximum type="Float">1</intensityMaximum></intensityLimits>' : '') +
        '<cartesianBounds type="Structure"><xMinimum type="Float">' + fnum(scan.mn[0]) + '</xMinimum><xMaximum type="Float">' + fnum(scan.mx[0]) +
        '</xMaximum><yMinimum type="Float">' + fnum(scan.mn[1]) + '</yMinimum><yMaximum type="Float">' + fnum(scan.mx[1]) +
        '</yMaximum><zMinimum type="Float">' + fnum(scan.mn[2]) + '</zMinimum><zMaximum type="Float">' + fnum(scan.mx[2]) + '</zMaximum></cartesianBounds>' +
        '<pose type="Structure"><rotation type="Structure"><w type="Float">' + fnum(scan.q.w) + '</w><x type="Float">' + fnum(scan.q.x) +
        '</x><y type="Float">' + fnum(scan.q.y) + '</y><z type="Float">' + fnum(scan.q.z) + '</z></rotation>' +
        '<translation type="Structure"><x type="Float">' + fnum(scan.T[0]) + '</x><y type="Float">' + fnum(scan.T[1]) +
        '</y><z type="Float">' + fnum(scan.T[2]) + '</z></translation></pose>' +
        '<points type="CompressedVector" fileOffset="' + logicalToPhysical(scan.sectionStart) + '" recordCount="' + scan.count +
        '"><prototype type="Structure">' +
        '<cartesianX type="Float" minimum="' + fnum(scan.mn[0]) + '" maximum="' + fnum(scan.mx[0]) + '"/>' +
        '<cartesianY type="Float" minimum="' + fnum(scan.mn[1]) + '" maximum="' + fnum(scan.mx[1]) + '"/>' +
        '<cartesianZ type="Float" minimum="' + fnum(scan.mn[2]) + '" maximum="' + fnum(scan.mx[2]) + '"/>' +
        (col ? '<colorRed type="Integer" minimum="0" maximum="255"/><colorGreen type="Integer" minimum="0" maximum="255"/><colorBlue type="Integer" minimum="0" maximum="255"/>' : '') +
        (inten ? '<intensity type="Float" precision="single" minimum="0" maximum="1"/>' : '') +
        '<cartesianInvalidState type="Integer" minimum="0" maximum="1"/></prototype><codecs type="Vector" allowHeterogeneousChildren="1"></codecs></points></vectorChild>';
    }).join('');
    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n<e57Root type="Structure" xmlns="http://www.astm.org/COMMIT/E57/2010-e57-v1.0">' +
      '<formatName type="String"><![CDATA[ASTM E57 3D Imaging Data File]]></formatName><guid type="String"><![CDATA[' + guid() + ']]></guid>' +
      '<versionMajor type="Integer">1</versionMajor><versionMinor type="Integer">0</versionMinor>' +
      '<e57LibraryVersion type="String"><![CDATA[BIM Twin e57-core 1223]]></e57LibraryVersion>' +
      '<coordinateMetadata type="String">' + xmlCdata(cloud.crs || '') + '</coordinateMetadata>' +
      '<creationDateTime type="Structure"><dateTimeValue type="Float">' + fnum((Date.now() / 1000) - 315964800 + 18) +
      '</dateTimeValue><isAtomicClockReferenced type="Integer">0</isAtomicClockReferenced></creationDateTime>' +
      '<data3D type="Vector" allowHeterogeneousChildren="1">' + xmlEntries +
      '</data3D><images2D type="Vector" allowHeterogeneousChildren="1"></images2D></e57Root>\n';
    var xmlBytes = (typeof TextEncoder !== 'undefined') ? new TextEncoder().encode(xml) : Buffer.from(xml, 'utf8');
    var xmlStart = sectionStart, logicalLength = xmlStart + xmlBytes.length;
    var pageCount = Math.ceil(logicalLength / PAYLOAD), physicalLength = pageCount * PAGE;
    var logical = new Uint8Array(pageCount * PAYLOAD), hv = new DataView(logical.buffer);
    'ASTM-E57'.split('').forEach(function (c, i) { logical[i] = c.charCodeAt(0); });
    hv.setUint32(8, 1, true); hv.setUint32(12, 0, true);
    function set64(offset, value) { hv.setUint32(offset, value % 4294967296, true); hv.setUint32(offset + 4, Math.floor(value / 4294967296), true); }
    set64(16, physicalLength); set64(24, logicalToPhysical(xmlStart)); set64(32, xmlBytes.length); set64(40, PAGE);
    builtScans.forEach(function (scan) {
      logical[scan.sectionStart] = 1;
      set64(scan.sectionStart + 8, scan.sectionLength);
      set64(scan.sectionStart + 16, logicalToPhysical(scan.dataStart));
      set64(scan.sectionStart + 24, 0);
      var offset = scan.dataStart;
      scan.packets.forEach(function (packet) { logical.set(packet, offset); offset += packet.length; });
    });
    logical.set(xmlBytes, xmlStart);
    var output = new Uint8Array(physicalLength);
    for (var page = 0; page < pageCount; page++) {
      output.set(logical.subarray(page * PAYLOAD, (page + 1) * PAYLOAD), page * PAGE);
      var crc = crc32c(output, page * PAGE, PAYLOAD), crcOffset = page * PAGE + PAYLOAD;
      output[crcOffset] = (crc >>> 24) & 255; output[crcOffset + 1] = (crc >>> 16) & 255;
      output[crcOffset + 2] = (crc >>> 8) & 255; output[crcOffset + 3] = crc & 255;
    }
    return output;
  }

  /**
   * write({pos, col?, intensity?, count?, name?}) -> Uint8Array (валидный E57).
   * pos — мировые координаты (Float64Array предпочтительно); col — 0..1 или 0..255.
   */
  function write(cloud) {
    var pos = cloud.pos, n = cloud.count != null ? cloud.count : (pos.length / 3) | 0, col = cloud.col && cloud.col.length >= n * 3 ? cloud.col : null;
    var inten = cloud.intensity && cloud.intensity.length >= n ? cloud.intensity : null;
    var s255 = false; if (col) { var mx = 0, lim = Math.min(col.length, 3000); for (var i = 0; i < lim; i++) if (col[i] > mx) mx = col[i]; s255 = mx > 1.0001; }
    var scanSpecs = normalizeScanRanges(cloud.scans, n);
    if (scanSpecs) return writeMultiScan(cloud, n, col, inten, scanSpecs, s255);
    var mn = [Infinity, Infinity, Infinity], mxv = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < n; i++) for (var a = 0; a < 3; a++) { var v = Number(pos[i * 3 + a]); if (!isFinite(v)) throw new Error('E57: координаты содержат NaN/Infinity'); if (v < mn[a]) mn[a] = v; if (v > mxv[a]) mxv[a] = v; }
    if (!n) { mn = [0, 0, 0]; mxv = [0, 0, 0]; }
    var nStreams = 3 + (col ? 3 : 0) + (inten ? 1 : 0) + 1; // cartesianInvalidState (all valid)
    var recBytes = 24 + (col ? 3 : 0) + (inten ? 4 : 0) + 1;
    var hdrLen = 6 + 2 * nStreams, maxRec = Math.floor((65536 - hdrLen - 4) / recBytes);
    var nPk = Math.max(1, Math.ceil(n / maxRec));
    // оценка длины бинарной секции
    var body = [], secLen = 32;
    var pkts = [];
    for (var p = 0, r0 = 0; p < nPk; p++) {
      var k = Math.min(maxRec, n - r0);
      // cartesianInvalidState is a 1-bit integer stream, so its packed byte
      // length is ceil(k/8), not one byte per record.
      var dataLen = 24 * k + (col ? 3 * k : 0) + (inten ? 4 * k : 0) + Math.ceil(k / 8);
      var needed = hdrLen + dataLen, packetLen = (needed + 3) & ~3;
      // E57 packetLength is four-byte aligned; bytes after all bytestreams are
      // defined zero padding (at most three bytes).
      var pk = new Uint8Array(packetLen), dv = new DataView(pk.buffer);
      pk[0] = 1; pk[1] = 0; dv.setUint16(2, packetLen - 1, true); dv.setUint16(4, nStreams, true);
      var si = 0, off = hdrLen;
      function setLen(bytes) { dv.setUint16(6 + si * 2, bytes, true); si++; }
      for (var a = 0; a < 3; a++) { setLen(k * 8); for (var j = 0; j < k; j++) { dv.setFloat64(off, pos[(r0 + j) * 3 + a], true); off += 8; } }
      if (col) for (var a = 0; a < 3; a++) { setLen(k); for (var j = 0; j < k; j++) { var cv = col[(r0 + j) * 3 + a]; cv = s255 ? Math.round(cv) : Math.round(cv * 255); pk[off++] = cv < 0 ? 0 : cv > 255 ? 255 : isFinite(cv) ? cv : 0; } }
      if (inten) { setLen(k * 4); for (var j = 0; j < k; j++) { var iv = Number(inten[r0 + j]); dv.setFloat32(off, isFinite(iv) ? Math.max(0, Math.min(1, iv)) : 0, true); off += 4; } }
      setLen(Math.ceil(k / 8)); off += Math.ceil(k / 8); // bit-packed all-zero invalid-state stream
      pkts.push(pk); secLen += packetLen; r0 += k;
    }
    var secStartL = 48, dataStartL = secStartL + 32, xmlStartL = secStartL + secLen;
    var proto = '<cartesianX type="Float" minimum="' + fnum(mn[0]) + '" maximum="' + fnum(mxv[0]) + '"/>' +
      '<cartesianY type="Float" minimum="' + fnum(mn[1]) + '" maximum="' + fnum(mxv[1]) + '"/>' +
      '<cartesianZ type="Float" minimum="' + fnum(mn[2]) + '" maximum="' + fnum(mxv[2]) + '"/>' +
      (col ? '<colorRed type="Integer" minimum="0" maximum="255"/><colorGreen type="Integer" minimum="0" maximum="255"/><colorBlue type="Integer" minimum="0" maximum="255"/>' : '') +
      (inten ? '<intensity type="Float" precision="single" minimum="0" maximum="1"/>' : '') +
      '<cartesianInvalidState type="Integer" minimum="0" maximum="1"/>';
    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n<e57Root type="Structure" xmlns="http://www.astm.org/COMMIT/E57/2010-e57-v1.0">' +
      '<formatName type="String"><![CDATA[ASTM E57 3D Imaging Data File]]></formatName>' +
      '<guid type="String"><![CDATA[' + guid() + ']]></guid>' +
      '<versionMajor type="Integer">1</versionMajor><versionMinor type="Integer">0</versionMinor>' +
      '<e57LibraryVersion type="String"><![CDATA[BIM Twin e57-core 1223]]></e57LibraryVersion>' +
      '<coordinateMetadata type="String">' + xmlCdata(cloud.crs || '') + '</coordinateMetadata>' +
      '<creationDateTime type="Structure"><dateTimeValue type="Float">' + fnum((Date.now() / 1000) - 315964800 + 18) + '</dateTimeValue><isAtomicClockReferenced type="Integer">0</isAtomicClockReferenced></creationDateTime>' +
      '<data3D type="Vector" allowHeterogeneousChildren="1"><vectorChild type="Structure">' +
      '<guid type="String"><![CDATA[' + guid() + ']]></guid><name type="String">' + xmlCdata(cloud.name || 'BIM Twin scan') + '</name>' +
      (col ? '<colorLimits type="Structure"><colorRedMinimum type="Integer">0</colorRedMinimum><colorRedMaximum type="Integer">255</colorRedMaximum><colorGreenMinimum type="Integer">0</colorGreenMinimum><colorGreenMaximum type="Integer">255</colorGreenMaximum><colorBlueMinimum type="Integer">0</colorBlueMinimum><colorBlueMaximum type="Integer">255</colorBlueMaximum></colorLimits>' : '') +
      (inten ? '<intensityLimits type="Structure"><intensityMinimum type="Float">0</intensityMinimum><intensityMaximum type="Float">1</intensityMaximum></intensityLimits>' : '') +
      '<cartesianBounds type="Structure"><xMinimum type="Float">' + fnum(mn[0]) + '</xMinimum><xMaximum type="Float">' + fnum(mxv[0]) + '</xMaximum><yMinimum type="Float">' + fnum(mn[1]) + '</yMinimum><yMaximum type="Float">' + fnum(mxv[1]) + '</yMaximum><zMinimum type="Float">' + fnum(mn[2]) + '</zMinimum><zMaximum type="Float">' + fnum(mxv[2]) + '</zMaximum></cartesianBounds>' +
      '<pose type="Structure"><rotation type="Structure"><w type="Float">1</w><x type="Float">0</x><y type="Float">0</y><z type="Float">0</z></rotation><translation type="Structure"><x type="Float">0</x><y type="Float">0</y><z type="Float">0</z></translation></pose>' +
      '<points type="CompressedVector" fileOffset="' + logicalToPhysical(secStartL) + '" recordCount="' + n + '"><prototype type="Structure">' + proto + '</prototype><codecs type="Vector" allowHeterogeneousChildren="1"></codecs></points>' +
      '</vectorChild></data3D><images2D type="Vector" allowHeterogeneousChildren="1"></images2D></e57Root>\n';
    var xmlU8 = (typeof TextEncoder !== 'undefined') ? new TextEncoder().encode(xml) : Buffer.from(xml, 'utf8');
    var logicalLen = xmlStartL + xmlU8.length, pages = Math.ceil(logicalLen / PAYLOAD), physLen = pages * PAGE;
    var L = new Uint8Array(pages * PAYLOAD);
    // заголовок
    var hv = new DataView(L.buffer);
    'ASTM-E57'.split('').forEach(function (c, i) { L[i] = c.charCodeAt(0); });
    hv.setUint32(8, 1, true); hv.setUint32(12, 0, true);
    function set64(o, v) { hv.setUint32(o, v % 4294967296, true); hv.setUint32(o + 4, Math.floor(v / 4294967296), true); }
    set64(16, physLen); set64(24, logicalToPhysical(xmlStartL)); set64(32, xmlU8.length); set64(40, PAGE);
    // секция CompressedVector
    L[secStartL] = 1; set64(secStartL + 8, secLen); set64(secStartL + 16, logicalToPhysical(dataStartL)); set64(secStartL + 24, 0);
    var o = dataStartL; pkts.forEach(function (pk) { L.set(pk, o); o += pk.length; });
    L.set(xmlU8, xmlStartL);
    // физическая раскладка с CRC
    var out = new Uint8Array(physLen);
    for (var pg = 0; pg < pages; pg++) {
      out.set(L.subarray(pg * PAYLOAD, (pg + 1) * PAYLOAD), pg * PAGE);
      var c = crc32c(out, pg * PAGE, PAYLOAD), b = pg * PAGE + PAYLOAD;
      out[b] = (c >>> 24) & 255; out[b + 1] = (c >>> 16) & 255; out[b + 2] = (c >>> 8) & 255; out[b + 3] = c & 255;
    }
    return out;
  }

  return { read: read, readBuffer: readBuffer, write: write, crc32c: crc32c, parseXML: parseXML, logicalToPhysical: logicalToPhysical, physicalToLogical: physicalToLogical, version: '1223' };
});
