'use strict';
/*
 * e57-segments.js — чтение E57 ЧАСТЯМИ (ревизия 29), как LAS и PLY в cloud-segments.js.
 *
 * Раньше E57 читался только целиком (E57Core.read): все точки файла — в одном массиве, у облака в сотни миллионов точек это
 * «Array buffer allocation failed» или прореживание. Здесь при открытии файла строится указатель пакетов каждого скана: смещение
 * пакета данных и длина каждого потока полей в нём (читаются только заголовки пакетов, точки не декодируются). По указателю
 * чтение любого диапазона записей [from, from + count) начинается сразу с нужного пакета: для каждого поля — пакет и бит, с которого
 * начинается запись from (потоки полей идут непрерывно через пакеты, запись может начинаться в одном пакете и заканчиваться в другом).
 *
 *   openE57Segments(abs, fd, fileSize) → desc (kind 'e57', указатель пакетов — desc.e57; передаётся в поток чтения как есть)
 *   e57Fill(desc, fd, from, count, out, boxes, onProgress, CH) — то же, что lasFill: позиции (Y-вверх от центра и низа), цвет, интенсивность
 *   e57Each(desc, fd, from, count, fn(x, y, z)) — мировые координаты действительных точек диапазона (срез плана по всем точкам файла)
 *   e57Points(desc, fd, from, count, fn(x, y, z, r, g, b, iv)) — то же с цветом и интенсивностью (выборка карты до загрузки)
 *   setOrigin(desc, cx, cy, cz) — начало координат карты (чтобы фильтр окна «Перед загрузкой» совпал с картой)
 *
 * Поддержано то же, что в E57Core.read: несколько сканов, поза (кватернион + перенос), декартовы и сферические координаты,
 * cartesianInvalidState (недействительная точка заменяется предыдущей действительной — число точек части не меняется), цвет и
 * интенсивность с пределами colorLimits / intensityLimits, поля Float (single/double), Integer, ScaledInteger (до 53 бит).
 */
const fs = require('fs');
const E57 = require('./e57-core');
const I = E57._internal;

const core = require('./las-core');

// таблица цвета по высоте (как в cloud-segments.js) — для сканов без цвета и интенсивности
const RAMP_N = 1023;
let RAMP = null;
function rampTable() {
  if (RAMP) return RAMP;
  RAMP = new Uint8Array((RAMP_N + 1) * 3);
  for (let i = 0; i <= RAMP_N; i++) { const c = core.elevationRamp(i / RAMP_N); RAMP[i * 3] = Math.round(c[0] * 255); RAMP[i * 3 + 1] = Math.round(c[1] * 255); RAMP[i * 3 + 2] = Math.round(c[2] * 255); }
  return RAMP;
}
const P2 = []; for (let i = 0; i <= 64; i++) P2.push(Math.pow(2, i));

// логическое чтение одним обращением к диску: физический промежуток целиком, затем без 4 байт CRC в конце каждой страницы 1024
function logicalReader(fd, fileSize) {
  const PAGE = 1024, PAY = 1020;
  return function (L, len) {
    if (!(len > 0)) return new Uint8Array(0);
    const p0 = Math.floor(L / PAY) * PAGE + (L % PAY), e = L + len - 1, p1 = Math.floor(e / PAY) * PAGE + (e % PAY) + 1;
    if (p1 > fileSize) throw new Error('E57: выход за пределы файла');
    const raw = Buffer.allocUnsafe(p1 - p0); let got = 0;
    while (got < raw.length) { const n = fs.readSync(fd, raw, got, raw.length - got, p0 + got); if (n <= 0) break; got += n; }
    if (got < raw.length) throw new Error('E57 обрывается раньше, чем объявлено');
    if (p1 - p0 === len) return new Uint8Array(raw.buffer, raw.byteOffset, len);
    const out = new Uint8Array(len);
    let o = 0, r = 0, inPg = L % PAY;
    while (o < len) { const take = Math.min(PAY - inPg, len - o); out.set(raw.subarray(r, r + take), o); o += take; r += take + 4; inPg = 0; }
    return out;
  };
}

function physReader(fd, fileSize) {
  return function (o, l) {
    const b = Buffer.allocUnsafe(l); let got = 0;
    while (got < l) { const n = fs.readSync(fd, b, got, l - got, o + got); if (n <= 0) break; got += n; }
    if (got < l) throw new Error('E57 обрывается раньше, чем объявлено');
    return new Uint8Array(b.buffer, b.byteOffset, got);
  };
}

// указатель пакетов одного скана: смещения пакетов данных, длина заголовка, накопленные байты каждого потока до пакета
function indexScan(readLogical, fileOffsetPhys, recordCount, fields) {
  const L = E57.physicalToLogical(fileOffsetPhys), sh = readLogical(L, 32), sdv = new DataView(sh.buffer, sh.byteOffset, 32);
  if (sh[0] !== 1) throw new Error('E57: ожидалась секция CompressedVector');
  const secLen = I.u64(sdv, 8), dataPhys = I.u64(sdv, 16), end = L + secLen, nf = fields.length;
  const bitsOf = fields.map((f) => f.type === 'Float' ? f.bytes * 8 : f.bits);
  const offs = [], hl = [], plen = [], cb = [0].concat(new Array(nf - 1).fill(0)), cum = new Float64Array(nf);
  let pl = E57.physicalToLogical(dataPhys), guard = 0;
  while (pl < end && guard++ < 1e8) {
    let h = readLogical(pl, Math.min(64, end - pl));
    const ptype = h[0], len = (h[2] | (h[3] << 8)) + 1;
    if (ptype === 1) {
      const nbs = h[4] | (h[5] << 8), need = 6 + 2 * nbs;
      if (need > h.length) h = readLogical(pl, need);
      offs.push(pl); hl.push(need); plen.push(len);
      for (let s = 0; s < nf; s++) { cum[s] += s < nbs ? (h[6 + s * 2] | (h[7 + s * 2] << 8)) : 0; cb.push(cum[s]); }
      // все поля набрали записи скана — дальше пакеты не нужны
      let done = true; for (let s = 0; s < nf; s++) if (bitsOf[s] > 0 && Math.floor(cum[s] * 8 / bitsOf[s]) < recordCount) { done = false; break; }
      if (done) break;
    } else if (ptype !== 0 && ptype !== 2) throw new Error('E57: неизвестный тип пакета ' + ptype);
    pl += len;
  }
  for (let s = 0; s < nf; s++) if (bitsOf[s] > 0 && Math.floor(cum[s] * 8 / bitsOf[s]) < recordCount) throw new Error('E57: в скане меньше записей, чем объявлено');
  return { pk: Float64Array.from(offs), hl: Uint16Array.from(hl), pl: Uint32Array.from(plen), cb: Float64Array.from(cb), nf, bits: bitsOf };
}

function scanInfo(sc, readLogical) {
  const C = I.child, N = I.numVal, pts = C(sc, 'points'), count = pts ? Number(pts.attrs.recordCount || 0) : 0;
  if (!pts || !count) return null;
  const fields = I.protoFields(C(pts, 'prototype')), F = {};
  fields.forEach((f, i) => { F[f.name] = i; });
  const cart = F.cartesianX != null && F.cartesianY != null && F.cartesianZ != null;
  const sph = !cart && F.sphericalRange != null && F.sphericalAzimuth != null && F.sphericalElevation != null;
  if (!cart && !sph) return null;
  const hasRGB = F.colorRed != null && F.colorGreen != null && F.colorBlue != null, cl = C(sc, 'colorLimits');
  const cMin = [0, 0, 0], cMax = [255, 255, 255];
  ['Red', 'Green', 'Blue'].forEach((k, j) => {
    const f = fields[F['color' + k]];
    cMin[j] = cl ? N(C(cl, 'color' + k + 'Minimum'), f ? f.min : 0) : (f ? f.min : 0);
    cMax[j] = cl ? N(C(cl, 'color' + k + 'Maximum'), f ? f.max : 255) : (f ? f.max : 255);
    if (!(cMax[j] > cMin[j])) { cMin[j] = 0; cMax[j] = 255; }
  });
  const hasInt = F.intensity != null, il = C(sc, 'intensityLimits');
  let iMin = il ? N(C(il, 'intensityMinimum'), 0) : (hasInt && fields[F.intensity].min != null ? fields[F.intensity].min : 0);
  let iMax = il ? N(C(il, 'intensityMaximum'), 1) : (hasInt && fields[F.intensity].max != null ? fields[F.intensity].max : 1);
  if (!(iMax > iMin)) { iMin = 0; iMax = 1; }
  let R = null, T = [0, 0, 0];
  const pose = C(sc, 'pose');
  if (pose) {
    const rq = C(pose, 'rotation'), tr = C(pose, 'translation');
    if (rq) R = I.quatToMat(N(C(rq, 'w'), 1), N(C(rq, 'x'), 0), N(C(rq, 'y'), 0), N(C(rq, 'z'), 0));
    if (tr) T = [N(C(tr, 'x'), 0), N(C(tr, 'y'), 0), N(C(tr, 'z'), 0)];
  }
  const inv = F.cartesianInvalidState != null ? F.cartesianInvalidState : (F.sphericalInvalidState != null ? F.sphericalInvalidState : -1);
  const idx = indexScan(readLogical, Number(pts.attrs.fileOffset), count, fields);
  return {
    name: String((C(sc, 'name') || {}).text || ''), count, cart, hasRGB, hasInt, cMin, cMax, iMin, iMax, R, T, inv,
    fx: cart ? [F.cartesianX, F.cartesianY, F.cartesianZ] : [F.sphericalRange, F.sphericalAzimuth, F.sphericalElevation],
    fc: hasRGB ? [F.colorRed, F.colorGreen, F.colorBlue] : null, fi: hasInt ? F.intensity : -1,
    fields: fields.map((f) => ({ type: f.type, bytes: f.bytes || 0, bits: f.bits || 0, min: f.min || 0, scale: f.scale == null ? 1 : f.scale, offset: f.offset || 0 })),
    idx
  };
}

// курсор одного поля: значения записей подряд, начиная с записи r (пакет и бит — по указателю)
function fieldCursor(sc, fi, r, getPacket) {
  const f = sc.fields[fi], X = sc.idx, nf = X.nf, bits = X.bits[fi], npk = X.pk.length;
  if (bits === 0) { const c = f.min * f.scale + f.offset; return { next(n, out) { out.fill(c, 0, n); } }; }
  const cbAt = (p) => X.cb[p * nf + fi];
  const startBit = r * bits, startByte = Math.floor(startBit / 8);
  // пакет, в потоке которого лежит первый байт записи
  let lo = 0, hi = npk - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cbAt(m) <= startByte) lo = m; else hi = m - 1; }
  let p = lo, buf = null, dv = null, pos = 0, len = 0;
  const load = (q) => {
    const pk = getPacket(q); let o = X.hl[q];
    for (let s = 0; s < fi; s++) o += X.cb[(q + 1) * nf + s] - X.cb[q * nf + s];
    len = X.cb[(q + 1) * nf + fi] - cbAt(q); buf = pk.subarray(o, o + len); dv = new DataView(buf.buffer, buf.byteOffset, len); pos = 0;
  };
  const advance = () => { do { p++; if (p >= npk) throw new Error('E57: поток поля закончился раньше записей'); load(p); } while (len === 0); };
  load(p); pos = startByte - cbAt(p);
  while (pos >= len) advance();
  if (f.type === 'Float') {
    const bw = f.bytes, tmp = new Uint8Array(8), tv = new DataView(tmp.buffer);
    return { next(n, out) {
      for (let k = 0; k < n; k++) {
        if (pos + bw <= len) { out[k] = bw === 8 ? dv.getFloat64(pos, true) : dv.getFloat32(pos, true); pos += bw; }
        else { for (let j = 0; j < bw; j++) { while (pos >= len) advance(); tmp[j] = buf[pos++]; } out[k] = bw === 8 ? tv.getFloat64(0, true) : tv.getFloat32(0, true); }
        if (pos >= len && k + 1 < n) advance();
      }
    } };
  }
  const pow = Math.pow(2, bits), mn = f.min, sc0 = f.scale, of = f.offset, sh = startBit - startByte * 8;
  let acc = Math.floor(buf[pos++] / (1 << sh)), accBits = 8 - sh;
  if (bits <= 24) {
    // до 24 бит накопитель помещается в 32-битное целое (bits + 7 ≤ 31): сдвиги вместо деления
    const mask = (1 << bits) - 1;
    return { next(n, out) {
      for (let k = 0; k < n; k++) {
        while (accBits < bits) { if (pos >= len) advance(); acc |= buf[pos++] << accBits; accBits += 8; }
        const v = acc & mask; acc >>>= bits; accBits -= bits;
        out[k] = (v + mn) * sc0 + of;
      }
    } };
  }
  return { next(n, out) {
    for (let k = 0; k < n; k++) {
      while (accBits < bits) { if (pos >= len) advance(); acc += buf[pos++] * P2[accBits]; accBits += 8; }
      const v = acc % pow; acc = (acc - v) / pow; accBits -= bits;
      out[k] = (v + mn) * sc0 + of;
    }
  } };
}

// пакеты пачки записей: курсоры полей идут по одним и тем же пакетам по очереди — кэш держит пакеты пачки (до 48 МБ),
// иначе каждое поле читало бы те же пакеты с диска заново
function packetCache(readLogical, sc) {
  const cache = new Map(), X = sc.idx, CAP = 48 << 20;
  let bytes = 0;
  return function (q) {
    let b = cache.get(q);
    if (b) return b;
    b = readLogical(X.pk[q], X.pl[q]);
    cache.set(q, b); bytes += b.length;
    while (bytes > CAP && cache.size > 1) { const k = cache.keys().next().value; bytes -= cache.get(k).length; cache.delete(k); }
    return b;
  };
}

// обход записей диапазона глобальных номеров [from, from + count) пачками: fb(scan, m, wx, wy, wz, T) — мировые координаты m записей
// пачки (NaN у недействительной), T — значения всех полей пачки (T[поле][k])
function eachBatch(desc, fd, from, count, fb, onProgress) {
  const readLogical = logicalReader(fd, desc.fileSize);
  const B = 16384;
  let g = 0, doneN = 0;
  for (const sc of desc.e57.scans) {
    const a = Math.max(from, g) - g, b = Math.min(from + count, g + sc.count) - g;
    g += sc.count;
    if (b <= a) continue;
    const getPacket = packetCache(readLogical, sc), nf = sc.fields.length, M = Math.min(B, b - a);
    const cur = sc.fields.map((_, fi) => fieldCursor(sc, fi, a, getPacket));
    const tmp = sc.fields.map(() => new Float64Array(M)), wx = new Float64Array(M), wy = new Float64Array(M), wz = new Float64Array(M);
    const R = sc.R, T0 = sc.T[0], T1 = sc.T[1], T2 = sc.T[2], f0 = tmp[sc.fx[0]], f1 = tmp[sc.fx[1]], f2 = tmp[sc.fx[2]], inv = sc.inv >= 0 ? tmp[sc.inv] : null;
    for (let r = a; r < b; r += B) {
      const m = Math.min(B, b - r);
      for (let fi = 0; fi < nf; fi++) cur[fi].next(m, tmp[fi]);
      for (let k = 0; k < m; k++) {
        let x, y, z;
        if (inv && inv[k] > 0) { wx[k] = NaN; continue; }
        if (sc.cart) { x = f0[k]; y = f1[k]; z = f2[k]; }
        else { const rr = f0[k], az = f1[k], el = f2[k]; x = rr * Math.cos(el) * Math.cos(az); y = rr * Math.cos(el) * Math.sin(az); z = rr * Math.sin(el); }
        if (R) { const X = R[0] * x + R[1] * y + R[2] * z, Y = R[3] * x + R[4] * y + R[5] * z, Z = R[6] * x + R[7] * y + R[8] * z; x = X; y = Y; z = Z; }
        x += T0; y += T1; z += T2;
        // нечисловые координаты — как недействительная точка (E57Core.read такие точки тоже пропускает)
        if (x - x !== 0 || y - y !== 0 || z - z !== 0) { wx[k] = NaN; continue; }
        wx[k] = x; wy[k] = y; wz[k] = z;
      }
      fb(sc, m, wx, wy, wz, tmp);
      doneN += m;
      if (onProgress) onProgress(doneN / count);
    }
  }
}
// то же по одной записи: fn(x, y, z, scan, k, T) — NaN у недействительной
function eachRecord(desc, fd, from, count, fn, onProgress) {
  eachBatch(desc, fd, from, count, (sc, m, wx, wy, wz, tmp) => { for (let k = 0; k < m; k++) fn(wx[k], wy[k], wz[k], sc, k, tmp); }, onProgress);
}

function e57Each(desc, fd, from, count, fn, onProgress) {
  eachRecord(desc, fd, from, count, (x, y, z) => { if (x === x) fn(x, y, z); }, onProgress);
}

// действительные точки диапазона с цветом: fn(x, y, z, r, g, b, iv) — r, g, b 0..255 (без RGB — серый по интенсивности или 128), iv 0..1 (без интенсивности — 0)
function e57Points(desc, fd, from, count, fn, onProgress) {
  eachRecord(desc, fd, from, count, (x, y, z, sc, k, tmp) => {
    if (!(x === x)) return;
    let iv = 0, r, g, b;
    if (sc.hasInt) { iv = (tmp[sc.fi][k] - sc.iMin) / (sc.iMax - sc.iMin); iv = iv < 0 ? 0 : iv > 1 ? 1 : iv; }
    if (sc.hasRGB) {
      r = (tmp[sc.fc[0]][k] - sc.cMin[0]) / (sc.cMax[0] - sc.cMin[0]) * 255; g = (tmp[sc.fc[1]][k] - sc.cMin[1]) / (sc.cMax[1] - sc.cMin[1]) * 255; b = (tmp[sc.fc[2]][k] - sc.cMin[2]) / (sc.cMax[2] - sc.cMin[2]) * 255;
      r = r < 0 ? 0 : r > 255 ? 255 : (r + 0.5) | 0; g = g < 0 ? 0 : g > 255 ? 255 : (g + 0.5) | 0; b = b < 0 ? 0 : b > 255 ? 255 : (b + 0.5) | 0;
    } else r = g = b = sc.hasInt ? (iv * 255 + 0.5) | 0 : 128;
    fn(x, y, z, r, g, b, iv);
  }, onProgress);
}

// рамка облака: выборка окон по 256 записей равномерно по всем сканам (точки не декодируются целиком)
function sampleBounds(desc, fd) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], W = 256, total = desc.count;
  const nW = Math.max(1, Math.min(1024, Math.floor(total / W)));
  for (let w = 0; w < nW; w++) {
    const from = Math.min(total - 1, Math.floor(w * total / nW)), cnt = Math.min(W, total - from);
    eachRecord(desc, fd, from, cnt, (x, y, z) => {
      if (!(x === x) || !isFinite(x) || !isFinite(y) || !isFinite(z)) return;
      if (x < mn[0]) mn[0] = x; if (x > mx[0]) mx[0] = x; if (y < mn[1]) mn[1] = y; if (y > mx[1]) mx[1] = y; if (z < mn[2]) mn[2] = z; if (z > mx[2]) mx[2] = z;
    });
  }
  return { mn, mx };
}

function setOrigin(desc, cx, cy, cz) {
  const b = desc.world;
  desc.cx = cx; desc.cy = cy; desc.cz = cz;
  const h = Math.max(1e-6, b.mx[2] - cz);
  desc.h = h;
  desc.bbox = { mn: [b.mn[0] - cx, Math.min(0, b.mn[2] - cz), -(b.mx[1] - cy)], mx: [b.mx[0] - cx, h, -(b.mn[1] - cy)] };
  desc.meta.offset = { cx, cy, mnz: cz }; desc.meta.srcXform = { axis: 'zup', t: [cx, cy, cz] };
  return desc;
}

function openE57Segments(abs, fd, fileSize) {
  const readPhys = physReader(fd, fileSize), hdr = I.readHeader(readPhys, fileSize), readLogical = logicalReader(fd, fileSize);
  const xmlBytes = readLogical(E57.physicalToLogical(hdr.xmlPhysicalOffset), hdr.xmlLogicalLength);
  const root = E57.parseXML(Buffer.from(xmlBytes).toString('utf8')), d3 = I.child(root, 'data3D');
  const crs = String((I.child(root, 'coordinateMetadata') || {}).text || '').trim() || null;
  const scans = (d3 ? d3.children : []).map((sc) => scanInfo(sc, readLogical)).filter(Boolean);
  const count = scans.reduce((s, x) => s + x.count, 0);
  if (!count) throw new Error('В E57 нет точек');
  const hasColor = scans.some((s) => s.hasRGB), hasIntensity = scans.some((s) => s.hasInt);
  const desc = { kind: 'e57', path: abs, fileSize, count, hasColor, hasIntensity, hasClassification: false, colored: hasColor, scans: scans.length, e57: { scans } };
  const wb = sampleBounds(desc, fd);
  if (!wb.mn.every(Number.isFinite)) throw new Error('E57: нет действительных точек');
  desc.world = wb;
  const w = wb.mx[0] - wb.mn[0], d = wb.mx[1] - wb.mn[1], h = wb.mx[2] - wb.mn[2];
  desc.meta = { kind: 'points', points: count, total: count, w, d, h, format: 'E57 (' + scans.length + ' скан.)', colored: hasColor, hasIntensity, hasClassification: false, crsWkt: crs };
  return setOrigin(desc, (wb.mn[0] + wb.mx[0]) / 2, (wb.mn[1] + wb.mx[1]) / 2, wb.mn[2]);
}

function e57Fill(desc, fd, from, count, out, boxes, onProgress, CH) {
  const { pos, col, intensity } = out, cx = desc.cx, cy = desc.cy, cz = desc.cz, hInv = RAMP_N / (desc.h || 1), ramp = rampTable();
  let oi = 0, inChunk = 0, ci = 0, bmn0 = Infinity, bmn1 = Infinity, bmn2 = Infinity, bmx0 = -Infinity, bmx1 = -Infinity, bmx2 = -Infinity;
  let lx = NaN, ly = 0, lz = 0, lr = 0, lg = 0, lb = 0, li = 0, lastSc = null;
  eachBatch(desc, fd, from, count, (sc, m, wx, wy, wz, tmp) => {
    if (oi + m > count) throw new Error('E57: записей больше, чем запрошено');
    const ti = sc.hasInt ? tmp[sc.fi] : null, iMin = sc.iMin, iK = 1 / (sc.iMax - sc.iMin);
    const tr = sc.hasRGB ? tmp[sc.fc[0]] : null, tg = sc.hasRGB ? tmp[sc.fc[1]] : null, tb = sc.hasRGB ? tmp[sc.fc[2]] : null;
    const r0 = sc.cMin[0], g0 = sc.cMin[1], b0 = sc.cMin[2], rK = 255 / (sc.cMax[0] - sc.cMin[0]), gK = 255 / (sc.cMax[1] - sc.cMin[1]), bK = 255 / (sc.cMax[2] - sc.cMin[2]);
    if (lastSc !== sc) { lx = NaN; lastSc = sc; }
    for (let k = 0; k < m; k++) {
      const j = oi * 3, x = wx[k];
      if (!(x === x)) {
        // недействительная точка — повтор предыдущей действительной (число точек части не меняется), в начале скана — точка стояния
        if (!(lx === lx)) { lx = sc.T[0] - cx; ly = sc.T[2] - cz; lz = -(sc.T[1] - cy); lr = lg = lb = 128; li = 0; }
        pos[j] = lx; pos[j + 1] = ly; pos[j + 2] = lz; col[j] = lr; col[j + 1] = lg; col[j + 2] = lb; if (intensity) intensity[oi] = li;
      } else {
        const px = x - cx, py = wz[k] - cz, pz = -(wy[k] - cy);
        pos[j] = px; pos[j + 1] = py; pos[j + 2] = pz;
        let r, g, b, iv = 0;
        if (ti) { iv = (ti[k] - iMin) * iK; iv = iv < 0 ? 0 : iv > 1 ? 1 : iv; }
        if (tr) {
          r = (tr[k] - r0) * rK; g = (tg[k] - g0) * gK; b = (tb[k] - b0) * bK;
          r = r < 0 ? 0 : r > 255 ? 255 : (r + 0.5) | 0; g = g < 0 ? 0 : g > 255 ? 255 : (g + 0.5) | 0; b = b < 0 ? 0 : b > 255 ? 255 : (b + 0.5) | 0;
        } else if (ti) { r = g = b = (iv * 255 + 0.5) | 0; }
        else { let t = (py * hInv + 0.5) | 0; if (t < 0) t = 0; else if (t > RAMP_N) t = RAMP_N; r = ramp[t * 3]; g = ramp[t * 3 + 1]; b = ramp[t * 3 + 2]; }
        col[j] = r; col[j + 1] = g; col[j + 2] = b;
        const iq = Math.round(iv * 65535);
        if (intensity) intensity[oi] = iq;
        lx = px; ly = py; lz = pz; lr = r; lg = g; lb = b; li = iq;
      }
      const px2 = pos[j], py2 = pos[j + 1], pz2 = pos[j + 2];
      if (px2 < bmn0) bmn0 = px2; if (py2 < bmn1) bmn1 = py2; if (pz2 < bmn2) bmn2 = pz2;
      if (px2 > bmx0) bmx0 = px2; if (py2 > bmx1) bmx1 = py2; if (pz2 > bmx2) bmx2 = pz2;
      oi++;
      if (++inChunk === CH) {
        const q = ci * 6; boxes[q] = bmn0; boxes[q + 1] = bmn1; boxes[q + 2] = bmn2; boxes[q + 3] = bmx0; boxes[q + 4] = bmx1; boxes[q + 5] = bmx2;
        ci++; inChunk = 0; bmn0 = bmn1 = bmn2 = Infinity; bmx0 = bmx1 = bmx2 = -Infinity;
      }
    }
  }, onProgress);
  if (oi !== count) throw new Error('E57: прочитано ' + oi + ' записей из ' + count);
  if (inChunk > 0) { const q = ci * 6; boxes[q] = bmn0; boxes[q + 1] = bmn1; boxes[q + 2] = bmn2; boxes[q + 3] = bmx0; boxes[q + 4] = bmx1; boxes[q + 5] = bmx2; }
}

module.exports = { openE57Segments, e57Fill, e57Each, e57Points, setOrigin, _fieldCursor: fieldCursor };
