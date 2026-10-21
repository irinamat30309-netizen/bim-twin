'use strict';
/*
 * cloud-segments.js — чтение большого облака точек ЧАСТЯМИ (ревизия 16).
 *
 * Зачем. Облако в 270 млн точек не помещается в один массив: Float32Array на 3,3 ГБ (а таких нужно несколько — позиции, цвет, интенсивность)
 * браузерная часть Electron выделить не может («Array buffer allocation failed»), да и вся цепочка «файл → процесс чтения → главный процесс →
 * окно» держала бы по полной копии на каждом шаге. Здесь файл читается порциями (сегментами, по умолчанию 16 млн точек): каждая порция —
 * готовые массивы окна (позиции Float32 в системе просмотра Y-вверх, цвет 3 байта, интенсивность uint16, класс uint8), которые окно сразу
 * кладёт в видеопамять и забывает. Ни одного массива больше сегмента нигде нет, файл целиком в памяти не живёт.
 *
 * Внутри сегмента точки разбиты на «кирпичи» по CLOUD_CHUNK_POINTS подряд идущих точек файла. Для каждого кирпича считается рамка
 * (по ней окно не рисует кирпичи вне экрана), а сами точки кирпича перемешаны ВНУТРИ кирпича: рамка не меняется, а первая доля точек
 * кирпича — равномерная выборка (так работает снижение числа точек при движении).
 *
 *   openSegmentSource(absPath) → { ok:true, desc } | { ok:false, unsupported:true, message }
 *       desc — простой JSON-объект (его можно отдать в поток чтения): формат, число точек, преобразование координат, meta.
 *   readSegment(desc, from, count, { onProgress }) → { ok, pos, col, intensity, classification, count, chunkPoints, chunkBoxes, bbox }
 *   readSegmentAsync(desc, from, count, { signal }) → то же, но в отдельном потоке (главный процесс не блокируется)
 *   { keepPer } (ревизия 26) — из каждого кирпича берутся первые keepPer точек (равномерная выборка для экрана), см. thinSegment
 *   { filter } (ревизия 27) — область, высота, маска маршрута, шум и доля точек из окна «Перед загрузкой», см. filterSegment
 *
 * Поддержано: LAS без сжатия (все форматы точек), бинарный PLY с вершинами (little/big endian). Остальные форматы возвращают
 * { unsupported:true } — их читает прежний путь (целиком).
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./app-config');
const core = require('./las-core');
const Cloud = require('./las-node');
const I = Cloud._internal;

const SEG_POINTS = cfg.CLOUD_SEG_POINTS || 16000000;
const CHUNK_POINTS = cfg.CLOUD_CHUNK_POINTS || 1000000;
const CHUNK_BYTES = cfg.CLOUD_CHUNK_BYTES || 8 * 1024 * 1024;
const SCAN_N = cfg.COLOR_SAMPLE_COUNT || 4000;

function f64(v) { return Number.isFinite(v) ? v : 0; }

// таблица цвета по высоте (1024 ступени) для облаков без цвета
const RAMP_N = 1023;
function rampTable() {
  const t = new Uint8Array((RAMP_N + 1) * 3);
  for (let i = 0; i <= RAMP_N; i++) { const c = core.elevationRamp(i / RAMP_N); t[i * 3] = Math.round(c[0] * 255); t[i * 3 + 1] = Math.round(c[1] * 255); t[i * 3 + 2] = Math.round(c[2] * 255); }
  return t;
}

// ------------------------------------------------------------------ LAS
function openLas(abs, fd, fileSize) {
  const parsed = I.readLasHeaderInfo(fd, fileSize);
  const H = parsed.H, head = parsed.head;
  const hasIntensity = !!(H.hasIntensity && H.intensityOff + 2 <= H.recLen);
  const hasClassification = !!(H.hasClassification && H.classificationOff + 1 <= H.recLen);
  let hasColor = !!(H.hasColor && H.colorOff + 6 <= H.recLen), colDiv = 65535;
  const count = H.count;
  const rec = Buffer.alloc(H.recLen);
  const readRec = (q) => { const rd = fs.readSync(fd, rec, 0, H.recLen, H.offToPts + q * H.recLen); return rd === H.recLen; };
  if (hasColor) {
    // глубина цвета — по выборке РАВНОМЕРНО по всему файлу (как в обычном чтении)
    const step = Math.max(1, Math.floor(count / SCAN_N)); let maxC = 0;
    for (let q = 0; q < count; q += step) {
      if (!readRec(q)) break;
      const rr = rec.readUInt16LE(H.colorOff), gg = rec.readUInt16LE(H.colorOff + 2), bb = rec.readUInt16LE(H.colorOff + 4);
      if (rr > maxC) maxC = rr; if (gg > maxC) maxC = gg; if (bb > maxC) maxC = bb;
      if (maxC > 255) break;
    }
    const dc = core.decideColorDivisor(maxC); hasColor = dc.hasColor; colDiv = dc.colDiv;
  }
  // габариты: из заголовка (быстро), проверка и дополнение — по выборке записей
  const hb = { mx: [head.readDoubleLE(179), head.readDoubleLE(195), head.readDoubleLE(211)], mn: [head.readDoubleLE(187), head.readDoubleLE(203), head.readDoubleLE(219)] };
  let headerOk = hb.mn.every(Number.isFinite) && hb.mx.every(Number.isFinite) && hb.mx.every((v, k) => v >= hb.mn[k]);
  const smn = [Infinity, Infinity, Infinity], smx = [-Infinity, -Infinity, -Infinity];
  const nS = headerOk ? 4000 : 200000, stepS = Math.max(1, Math.floor(count / nS));
  for (let q = 0; q < count; q += stepS) {
    if (!readRec(q)) break;
    const w = [rec.readInt32LE(0) * H.scale.x + H.offset.x, rec.readInt32LE(4) * H.scale.y + H.offset.y, rec.readInt32LE(8) * H.scale.z + H.offset.z];
    for (let k = 0; k < 3; k++) { if (w[k] < smn[k]) smn[k] = w[k]; if (w[k] > smx[k]) smx[k] = w[k]; }
  }
  const mn = [0, 0, 0], mx = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    if (headerOk) { mn[k] = Math.min(hb.mn[k], smn[k]); mx[k] = Math.max(hb.mx[k], smx[k]); }
    else { mn[k] = smn[k]; mx[k] = smx[k]; }
  }
  if (!mn.every(Number.isFinite) || !mx.every(Number.isFinite)) throw new Error('не удалось определить габариты LAS');
  const w = mx[0] - mn[0], d = mx[1] - mn[1], h = mx[2] - mn[2];
  const cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2, mnz = mn[2];
  return {
    kind: 'las', path: abs, fileSize, count,
    offToPts: H.offToPts, recLen: H.recLen, fmt: H.fmt, colorOff: H.colorOff, intensityOff: H.intensityOff, classificationOff: H.classificationOff,
    hasColor, colDiv, hasIntensity, hasClassification,
    scale: [H.scale.x, H.scale.y, H.scale.z], offset: [H.offset.x, H.offset.y, H.offset.z],
    cx, cy, cz: mnz, h,
    bbox: { mn: [-(w / 2), 0, -(d / 2)], mx: [w / 2, h, d / 2] },
    meta: { kind: 'points', points: count, total: count, w, d, h, format: 'LAS fmt ' + H.fmt, colored: hasColor, hasIntensity, hasClassification,
      crsWkt: parsed.crsWkt || null, offset: { cx, cy, mnz }, srcXform: { axis: 'zup', t: [cx, cy, mnz] } }
  };
}

function lasFill(desc, fd, from, count, out, boxes, onProgress, CH) {
  const sx = desc.scale[0], sy = desc.scale[1], sz = desc.scale[2], ox = desc.offset[0], oy = desc.offset[1], oz = desc.offset[2];
  const cx = desc.cx, cy = desc.cy, cz = desc.cz, h = desc.h || 1;
  const recLen = desc.recLen, perChunk = Math.max(1, Math.floor(CHUNK_BYTES / recLen)), buf = Buffer.allocUnsafe(perChunk * recLen);
  const { pos, col, intensity, classification } = out;
  const hasColor = desc.hasColor, kc = 255 / desc.colDiv, cOff = desc.colorOff, iOff = desc.intensityOff, kOff = desc.classificationOff, fmt = desc.fmt;
  const ramp = hasColor ? null : rampTable(), hInv = RAMP_N / h;
  let oi = 0, filePos = desc.offToPts + from * recLen;
  let bmn0 = Infinity, bmn1 = Infinity, bmn2 = Infinity, bmx0 = -Infinity, bmx1 = -Infinity, bmx2 = -Infinity, inChunk = 0, ci = 0;
  while (oi < count) {
    const want = Math.min(perChunk, count - oi), bytes = want * recLen;
    let got = 0;
    while (got < bytes) { const n = fs.readSync(fd, buf, got, bytes - got, filePos + got); if (n <= 0) throw new Error('LAS обрывается раньше, чем объявлено'); got += n; }
    for (let k = 0, base = 0; k < want; k++, base += recLen) {
      const X = buf.readInt32LE(base) * sx + ox, Y = buf.readInt32LE(base + 4) * sy + oy, Z = buf.readInt32LE(base + 8) * sz + oz;
      const px = X - cx, py = Z - cz, pz = -(Y - cy);
      const j = oi * 3; pos[j] = px; pos[j + 1] = py; pos[j + 2] = pz;
      if (px < bmn0) bmn0 = px; if (py < bmn1) bmn1 = py; if (pz < bmn2) bmn2 = pz;
      if (px > bmx0) bmx0 = px; if (py > bmx1) bmx1 = py; if (pz > bmx2) bmx2 = pz;
      if (hasColor) {
        const cb = base + cOff;
        col[j] = (buf.readUInt16LE(cb) * kc + 0.5) | 0; col[j + 1] = (buf.readUInt16LE(cb + 2) * kc + 0.5) | 0; col[j + 2] = (buf.readUInt16LE(cb + 4) * kc + 0.5) | 0;
      } else {
        let t = ((Z - cz) * hInv + 0.5) | 0; if (t < 0) t = 0; else if (t > RAMP_N) t = RAMP_N;
        col[j] = ramp[t * 3]; col[j + 1] = ramp[t * 3 + 1]; col[j + 2] = ramp[t * 3 + 2];
      }
      if (intensity) intensity[oi] = buf.readUInt16LE(base + iOff);
      if (classification) classification[oi] = fmt >= 6 ? buf[base + kOff] : (buf[base + kOff] & 0x1f);
      oi++;
      if (++inChunk === CH) {
        const b = ci * 6; boxes[b] = bmn0; boxes[b + 1] = bmn1; boxes[b + 2] = bmn2; boxes[b + 3] = bmx0; boxes[b + 4] = bmx1; boxes[b + 5] = bmx2;
        ci++; inChunk = 0; bmn0 = bmn1 = bmn2 = Infinity; bmx0 = bmx1 = bmx2 = -Infinity;
      }
    }
    filePos += bytes;
    if (onProgress) onProgress(oi / count);
  }
  if (inChunk > 0) { const b = ci * 6; boxes[b] = bmn0; boxes[b + 1] = bmn1; boxes[b + 2] = bmn2; boxes[b + 3] = bmx0; boxes[b + 4] = bmx1; boxes[b + 5] = bmx2; }
}

// ------------------------------------------------------------------ PLY (бинарный)
function plyReader(type, le) {
  switch (type) {
    case 'char': case 'int8': return (b, o) => b.readInt8(o);
    case 'uchar': case 'uint8': return (b, o) => b.readUInt8(o);
    case 'short': case 'int16': return le ? (b, o) => b.readInt16LE(o) : (b, o) => b.readInt16BE(o);
    case 'ushort': case 'uint16': return le ? (b, o) => b.readUInt16LE(o) : (b, o) => b.readUInt16BE(o);
    case 'int': case 'int32': return le ? (b, o) => b.readInt32LE(o) : (b, o) => b.readInt32BE(o);
    case 'uint': case 'uint32': return le ? (b, o) => b.readUInt32LE(o) : (b, o) => b.readUInt32BE(o);
    case 'float': case 'float32': return le ? (b, o) => b.readFloatLE(o) : (b, o) => b.readFloatBE(o);
    case 'double': case 'float64': return le ? (b, o) => b.readDoubleLE(o) : (b, o) => b.readDoubleBE(o);
    default: throw new Error('неизвестный тип PLY: ' + type);
  }
}

function openPly(abs, fd, fileSize) {
  const meta0 = I.readPlyHeader(fd, fileSize);
  const L = I.binaryPlyPointLayout(meta0, fileSize);          // бросает исключение для ASCII, мешей и списков — тогда читает прежний путь
  const n = L.vertexCount, rl = L.recordLength, le = L.littleEndian;
  const crsWkt = (core.plyCrsWkt ? core.plyCrsWkt(meta0.comments) : null) || I.commentCrs(meta0.comments);
  const units = I.commentValue(meta0.comments, 'units');
  const rdX = plyReader(L.x.type, le), rdY = plyReader(L.y.type, le), rdZ = plyReader(L.z.type, le);
  const rec = Buffer.alloc(rl);
  const readRec = (q) => fs.readSync(fd, rec, 0, rl, meta0.dataOffset + q * rl) === rl;
  if (!readRec(0)) throw new Error('PLY обрывается в начале данных');
  const shX = rdX(rec, L.x.offset), shY = rdY(rec, L.y.offset), shZ = rdZ(rec, L.z.offset);
  // выборка записей по всему файлу: габариты, оси, максимум интенсивности
  const nS = Math.min(n, 200000), step = Math.max(1, Math.floor(n / nS));
  const smn = [Infinity, Infinity, Infinity], smx = [-Infinity, -Infinity, -Infinity], axisVals = [[], [], []];
  let intensityMax = 0; const rdI = L.intensity ? plyReader(L.intensity.type, le) : null;
  const axisStep = Math.max(1, Math.floor(nS / 50000)); let si = 0;
  for (let q = 0; q < n; q += step, si++) {
    if (!readRec(q)) break;
    const p = [rdX(rec, L.x.offset), rdY(rec, L.y.offset), rdZ(rec, L.z.offset)];
    for (let k = 0; k < 3; k++) { if (p[k] < smn[k]) smn[k] = p[k]; if (p[k] > smx[k]) smx[k] = p[k]; }
    if (si % axisStep === 0) axisVals[0].push(p[0] - shX), axisVals[1].push(p[1] - shY), axisVals[2].push(p[2] - shZ);
    if (rdI) { const iv = rdI(rec, L.intensity.offset); if (iv > intensityMax) intensityMax = iv; }
  }
  if (!smn.every(Number.isFinite)) throw new Error('не удалось определить габариты PLY');
  const axisRanges = axisVals.map((a) => { a.sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) * 0.995)] - a[Math.floor((a.length - 1) * 0.005)] : 0; });
  const up = I.commentUp(meta0.comments, core.plyUpAxis ? core.plyUpAxis(meta0.comments, [shX, shY, shZ], axisRanges) : 'y');
  const zup = up === 'z';
  const w = smx[0] - smn[0];
  const common = { crsWkt: crsWkt || null, units: units || null, colored: L.hasColor, hasIntensity: !!L.intensity, hasClassification: !!L.classification };
  let cx, cy, cz, h, d, bbox, mt;
  if (zup) {
    // Z-вверх (съёмка): центр по X/Y, основание на земле
    cx = (smn[0] + smx[0]) / 2; cy = (smn[1] + smx[1]) / 2; cz = smn[2]; h = smx[2] - smn[2]; d = smx[1] - smn[1];
    bbox = { mn: [-(w / 2), 0, -(d / 2)], mx: [w / 2, h, d / 2] };
    mt = Object.assign({ kind: 'points', points: n, total: n, w, d, h, format: 'PLY cloud (Z-up)', offset: { cx, cy, mnz: cz }, srcXform: { axis: 'zup', t: [cx, cy, cz] } }, common);
  } else {
    // Y-вверх: центр по всем осям
    cx = (smn[0] + smx[0]) / 2; cy = (smn[1] + smx[1]) / 2; cz = (smn[2] + smx[2]) / 2; h = smx[1] - smn[1]; d = smx[2] - smn[2];
    bbox = { mn: [-(w / 2), -(h / 2), -(d / 2)], mx: [w / 2, h / 2, d / 2] };
    mt = Object.assign({ kind: 'points', points: n, total: n, w, d, h, format: 'PLY cloud (stream)', srcXform: { axis: 'yup', t: [cx, cy, cz] } }, common);
  }
  const prop = (p) => p ? { type: p.type, offset: p.offset } : null;
  return {
    kind: 'ply', path: abs, fileSize, count: n, dataOffset: meta0.dataOffset, recLen: rl, le, zup,
    x: prop(L.x), y: prop(L.y), z: prop(L.z), r: prop(L.color.r), g: prop(L.color.g), b: prop(L.color.b),
    hasColor: L.hasColor, colDiv: L.colorDivisor, intensity: prop(L.intensity), classification: prop(L.classification),
    intDiv: L.intensity ? (I.plyIntensityDiv(L.intensity.type, intensityMax) || 1) : 1,
    cx, cy, cz, h, hasIntensity: !!L.intensity, hasClassification: !!L.classification,
    bbox, meta: mt
  };
}

function plyFill(desc, fd, from, count, out, boxes, onProgress, CH) {
  const le = desc.le, rl = desc.recLen, zup = desc.zup;
  const rdX = plyReader(desc.x.type, le), rdY = plyReader(desc.y.type, le), rdZ = plyReader(desc.z.type, le);
  const xO = desc.x.offset, yO = desc.y.offset, zO = desc.z.offset;
  const hasColor = desc.hasColor;
  const rdR = hasColor ? plyReader(desc.r.type, le) : null, rdG = hasColor ? plyReader(desc.g.type, le) : null, rdB = hasColor ? plyReader(desc.b.type, le) : null;
  const rO = hasColor ? desc.r.offset : 0, gO = hasColor ? desc.g.offset : 0, bO = hasColor ? desc.b.offset : 0, kc = 255 / (desc.colDiv || 1);
  const rdI = desc.intensity ? plyReader(desc.intensity.type, le) : null, iO = desc.intensity ? desc.intensity.offset : 0, iDiv = desc.intDiv || 1;
  const rdC = desc.classification ? plyReader(desc.classification.type, le) : null, cO = desc.classification ? desc.classification.offset : 0;
  const cx = desc.cx, cy = desc.cy, cz = desc.cz, h = desc.h || 1, hInv = RAMP_N / h;
  const perChunk = Math.max(1, Math.floor(CHUNK_BYTES / rl)), buf = Buffer.allocUnsafe(perChunk * rl);
  const { pos, col, intensity, classification } = out;
  const ramp = hasColor ? null : rampTable();
  let oi = 0, filePos = desc.dataOffset + from * rl;
  let bmn0 = Infinity, bmn1 = Infinity, bmn2 = Infinity, bmx0 = -Infinity, bmx1 = -Infinity, bmx2 = -Infinity, inChunk = 0, ci = 0;
  while (oi < count) {
    const want = Math.min(perChunk, count - oi), bytes = want * rl;
    let got = 0;
    while (got < bytes) { const n = fs.readSync(fd, buf, got, bytes - got, filePos + got); if (n <= 0) throw new Error('PLY обрывается раньше, чем объявлено'); got += n; }
    for (let k = 0, base = 0; k < want; k++, base += rl) {
      const X = rdX(buf, base + xO), Y = rdY(buf, base + yO), Z = rdZ(buf, base + zO);
      let px, py, pz;
      if (zup) { px = X - cx; py = Z - cz; pz = -(Y - cy); } else { px = X - cx; py = Y - cy; pz = Z - cz; }
      const j = oi * 3; pos[j] = px; pos[j + 1] = py; pos[j + 2] = pz;
      if (px < bmn0) bmn0 = px; if (py < bmn1) bmn1 = py; if (pz < bmn2) bmn2 = pz;
      if (px > bmx0) bmx0 = px; if (py > bmx1) bmx1 = py; if (pz > bmx2) bmx2 = pz;
      if (hasColor) {
        let v = rdR(buf, base + rO) * kc + 0.5; col[j] = v <= 0 ? 0 : v >= 255 ? 255 : v | 0;
        v = rdG(buf, base + gO) * kc + 0.5; col[j + 1] = v <= 0 ? 0 : v >= 255 ? 255 : v | 0;
        v = rdB(buf, base + bO) * kc + 0.5; col[j + 2] = v <= 0 ? 0 : v >= 255 ? 255 : v | 0;
      } else {
        let t = (((zup ? Z - cz : Y - (cy - h / 2)) * hInv) + 0.5) | 0; if (t < 0) t = 0; else if (t > RAMP_N) t = RAMP_N;
        col[j] = ramp[t * 3]; col[j + 1] = ramp[t * 3 + 1]; col[j + 2] = ramp[t * 3 + 2];
      }
      if (intensity) { const iv = rdI(buf, base + iO) / iDiv; intensity[oi] = iv <= 0 || !(iv === iv) ? 0 : iv >= 1 ? 65535 : (iv * 65535 + 0.5) | 0; }
      if (classification) { const cv = rdC(buf, base + cO); classification[oi] = cv === cv ? Math.max(0, Math.min(255, Math.round(cv))) : 0; }
      oi++;
      if (++inChunk === CH) {
        const b = ci * 6; boxes[b] = bmn0; boxes[b + 1] = bmn1; boxes[b + 2] = bmn2; boxes[b + 3] = bmx0; boxes[b + 4] = bmx1; boxes[b + 5] = bmx2;
        ci++; inChunk = 0; bmn0 = bmn1 = bmn2 = Infinity; bmx0 = bmx1 = bmx2 = -Infinity;
      }
    }
    filePos += bytes;
    if (onProgress) onProgress(oi / count);
  }
  if (inChunk > 0) { const b = ci * 6; boxes[b] = bmn0; boxes[b + 1] = bmn1; boxes[b + 2] = bmn2; boxes[b + 3] = bmx0; boxes[b + 4] = bmx1; boxes[b + 5] = bmx2; }
}

// ------------------------------------------------------------------ общее
// Перемешивание точек ВНУТРИ каждого кирпича (рамка кирпича не меняется): первая доля точек кирпича — равномерная выборка кирпича.
function shuffleChunks(out, count, chunkPoints, seed) {
  const { pos, col, intensity, classification } = out;
  const CH = chunkPoints || CHUNK_POINTS;
  for (let a = 0, ci = 0; a < count; a += CH, ci++) {
    const m = Math.min(CH, count - a);
    let s = ((seed | 0) * 2654435761 + (ci + 1) * 40503 + 1) >>> 0 || 1;
    for (let i = m - 1; i > 0; i--) {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      const k = s % (i + 1); if (k === i) continue;
      const p = (a + i) * 3, q = (a + k) * 3;
      let t = pos[p]; pos[p] = pos[q]; pos[q] = t; t = pos[p + 1]; pos[p + 1] = pos[q + 1]; pos[q + 1] = t; t = pos[p + 2]; pos[p + 2] = pos[q + 2]; pos[q + 2] = t;
      let u = col[p]; col[p] = col[q]; col[q] = u; u = col[p + 1]; col[p + 1] = col[q + 1]; col[q + 1] = u; u = col[p + 2]; col[p + 2] = col[q + 2]; col[q + 2] = u;
      if (intensity) { const x = intensity[a + i]; intensity[a + i] = intensity[a + k]; intensity[a + k] = x; }
      if (classification) { const y = classification[a + i]; classification[a + i] = classification[a + k]; classification[a + k] = y; }
    }
  }
}

function openSegmentSource(absPath, opts) {
  opts = opts || {};
  const abs = String(absPath || '');
  const ext = path.extname(abs).toLowerCase();
  if (ext !== '.las' && ext !== '.ply') return { ok: false, unsupported: true, message: 'Формат читается целиком' };
  let fd = null;
  try {
    fd = fs.openSync(abs, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, unsupported: true, message: 'не файл' };
    const desc = ext === '.las' ? openLas(abs, fd, st.size) : openPly(abs, fd, st.size);
    desc.chunkPoints = Math.max(1000, Math.floor(Number(opts.chunkPoints) || CHUNK_POINTS));
    desc.segPoints = Math.max(desc.chunkPoints, Math.floor((Number(opts.segPoints) || SEG_POINTS) / desc.chunkPoints) * desc.chunkPoints);
    return { ok: true, desc };
  } catch (e) {
    return { ok: false, unsupported: true, message: String((e && e.message) || e) };
  } finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } }
}

// Ревизия 26: равномерная выборка части для экрана. Точки внутри кирпича уже перемешаны, поэтому первые keepPer точек кирпича —
// равномерная выборка всего кирпича; рамки кирпичей остаются верными (выборка лежит внутри рамки). Нужна для облаков, которые
// целиком не помещаются в видеокарту (например, 670 млн точек «Все точки» из .xbin): иначе видеокарта сбрасывает изображение.
function keepOfChunk(cn, CH, keepPer) { return cn >= CH ? keepPer : Math.max(1, Math.ceil(cn * keepPer / CH)); }
function thinnedCount(count, CH, keepPer) {
  count = Math.floor(count); CH = Math.floor(CH); keepPer = Math.floor(keepPer);
  if (!(count > 0) || !(keepPer > 0) || keepPer >= CH) return Math.max(0, count);
  const full = Math.floor(count / CH), rem = count - full * CH;
  return full * keepPer + (rem > 0 ? keepOfChunk(rem, CH, keepPer) : 0);
}
// keepPer для бюджета точек: не меньше 1000 (столько окно считает наименьшим кирпичом)
function keepPerForBudget(count, CH, budget) {
  count = Math.floor(count); CH = Math.floor(CH); budget = Math.floor(budget);
  if (!(budget > 0) || !(count > budget) || !(CH > 0)) return CH;
  return Math.min(CH, Math.max(1000, Math.floor(CH * budget / count)));
}
function thinSegment(res, keepPer) {
  if (!res || res.ok === false) return res;
  const CH = Math.floor(res.chunkPoints), n = Math.floor(res.count); keepPer = Math.floor(keepPer);
  if (!(keepPer > 0) || keepPer >= CH || !(n > 0)) return res;
  const nc = Math.ceil(n / CH), m = thinnedCount(n, CH, keepPer);
  const pos = new Float32Array(m * 3), col = res.col ? new Uint8Array(m * 3) : null;
  const intensity = res.intensity ? new Uint16Array(m) : null, classification = res.classification ? new Uint8Array(m) : null;
  let o = 0;
  for (let c = 0; c < nc; c++) {
    const a = c * CH, cn = Math.min(CH, n - a), k = keepOfChunk(cn, CH, keepPer);
    pos.set(res.pos.subarray(a * 3, (a + k) * 3), o * 3);
    if (col) col.set(res.col.subarray(a * 3, (a + k) * 3), o * 3);
    if (intensity) intensity.set(res.intensity.subarray(a, a + k), o);
    if (classification) classification.set(res.classification.subarray(a, a + k), o);
    o += k;
  }
  return Object.assign({}, res, { pos, col, intensity, classification, count: m, chunkPoints: keepPer, sourceCount: n });
}

// Ревизия 27: фильтры загрузки (окно «Перед загрузкой»): область на карте, высота, не дальше R от маршрута сканера, одиночные точки (шум)
// и равномерная доля ratio. Координаты фильтра — плановые (u = x окна, v = −z окна, h = y окна + hShift), как у карты (cloud-overview.js).
// Точки внутри кирпичей уже перемешаны: из прошедших фильтр точек каждого кирпича берётся первая доля ratio — выборка остаётся равномерной.
// Результат — новые массивы с кирпичами по CH2 точек и их рамками (окно рисует и отсекает их как обычно).
function noiseTables(bits) { const size = 1 << bits; return { size, a: new Uint16Array(size), b: new Uint16Array(size) }; }
// ревизия 28: отбор точек (координаты окна: u = x, h = y + hShift, v = −z) → { keep: Uint8Array, kept } — общий для частей LAS/PLY и E57
function filterKeep(P, n, filter) {
  const rect = filter.rect, hr = filter.h, mask = filter.mask, hs = Number(filter.hShift) || 0;
  const keep = new Uint8Array(n);
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const u = P[i * 3], h = P[i * 3 + 1] + hs, v = -P[i * 3 + 2];
    if (rect && (u < rect.u0 || u > rect.u1 || v < rect.v0 || v > rect.v1)) continue;
    if (hr && (h < hr.min || h > hr.max)) continue;
    if (mask) {
      const cx = Math.floor((u - mask.u0) / mask.cell), cy = Math.floor((v - mask.v0) / mask.cell);
      if (cx < 0 || cy < 0 || cx >= mask.nx || cy >= mask.ny || !mask.bits[cy * mask.nx + cx]) continue;
    }
    keep[i] = 1; kept++;
  }
  // одиночные точки: в вокселе (по всей части) меньше min точек — шум. Подсчёт — двумя хеш-таблицами (минимум из двух):
  // совпадения ключей только увеличивают счёт, поэтому настоящая точка из-за совпадения не удаляется никогда.
  if (filter.noise && kept) {
    const vx = Math.max(0.02, Number(filter.noise.voxel) || 0.1), mn = Math.max(2, Math.floor(filter.noise.min) || 3);
    const T = noiseTables(22), M = T.size - 1, inv = 1 / vx;
    const key = (i, out) => {
      const a = Math.floor(P[i * 3] * inv), b = Math.floor(P[i * 3 + 1] * inv), c = Math.floor(P[i * 3 + 2] * inv);
      out[0] = ((Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) >>> 0) & M;
      out[1] = ((Math.imul(a, 2654435761) + Math.imul(b, 40503) * 31 + Math.imul(c, 2246822519)) >>> 9) & M;
    };
    const k2 = [0, 0];
    for (let i = 0; i < n; i++) { if (!keep[i]) continue; key(i, k2); if (T.a[k2[0]] < 65535) T.a[k2[0]]++; if (T.b[k2[1]] < 65535) T.b[k2[1]]++; }
    for (let i = 0; i < n; i++) { if (!keep[i]) continue; key(i, k2); if (Math.min(T.a[k2[0]], T.b[k2[1]]) < mn) { keep[i] = 0; kept--; } }
  }
  return { keep, kept };
}
function filterSegment(res, filter) {
  if (!res || res.ok === false || !filter) return res;
  const n = Math.floor(res.count), CH = Math.max(1, Math.floor(res.chunkPoints)), P = res.pos;
  const ratio = filter.ratio > 0 && filter.ratio < 1 ? filter.ratio : 1;
  const K = filterKeep(P, n, filter), keep = K.keep;
  let kept = K.kept;
  // доля ratio в каждом кирпиче
  if (ratio < 1) {
    for (let a = 0; a < n; a += CH) {
      const e = Math.min(n, a + CH); let m = 0; for (let i = a; i < e; i++) m += keep[i];
      let take = Math.max(m ? 1 : 0, Math.round(m * ratio));
      for (let i = a; i < e; i++) { if (!keep[i]) continue; if (take > 0) take--; else { keep[i] = 0; kept--; } }
    }
  }
  const pos = new Float32Array(kept * 3), col = res.col ? new Uint8Array(kept * 3) : null;
  const intensity = res.intensity ? new Uint16Array(kept) : null, classification = res.classification ? new Uint8Array(kept) : null;
  let o = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    pos[o * 3] = P[i * 3]; pos[o * 3 + 1] = P[i * 3 + 1]; pos[o * 3 + 2] = P[i * 3 + 2];
    if (col) { col[o * 3] = res.col[i * 3]; col[o * 3 + 1] = res.col[i * 3 + 1]; col[o * 3 + 2] = res.col[i * 3 + 2]; }
    if (intensity) intensity[o] = res.intensity[i];
    if (classification) classification[o] = res.classification[i];
    o++;
  }
  const CH2 = Math.max(1000, Math.min(CH, Math.round(CH * ratio)));
  const nc = Math.ceil(kept / CH2), boxes = new Float32Array(Math.max(1, nc) * 6);
  const mn3 = [Infinity, Infinity, Infinity], mx3 = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < nc; c++) {
    let a0 = Infinity, a1 = Infinity, a2 = Infinity, b0 = -Infinity, b1 = -Infinity, b2 = -Infinity;
    for (let i = c * CH2, e = Math.min(kept, (c + 1) * CH2); i < e; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (x < a0) a0 = x; if (x > b0) b0 = x; if (y < a1) a1 = y; if (y > b1) b1 = y; if (z < a2) a2 = z; if (z > b2) b2 = z;
    }
    boxes.set([a0, a1, a2, b0, b1, b2], c * 6);
    if (a0 < mn3[0]) mn3[0] = a0; if (a1 < mn3[1]) mn3[1] = a1; if (a2 < mn3[2]) mn3[2] = a2; if (b0 > mx3[0]) mx3[0] = b0; if (b1 > mx3[1]) mx3[1] = b1; if (b2 > mx3[2]) mx3[2] = b2;
  }
  return Object.assign({}, res, { pos, col, intensity, classification, count: kept, chunkPoints: CH2, chunkBoxes: nc ? boxes : new Float32Array(0),
    bbox: kept ? { mn: mn3, mx: mx3 } : res.bbox, sourceCount: n, filtered: true });
}

function readSegment(desc, from, count, opts) {
  opts = opts || {};
  from = Math.floor(from); count = Math.floor(count);
  if (!desc || !(count > 0) || !(from >= 0) || from + count > desc.count) return { ok: false, message: 'неверный диапазон точек' };
  const CH = Math.max(1000, Math.floor(desc.chunkPoints || CHUNK_POINTS));
  if (from % CH !== 0) return { ok: false, message: 'начало сегмента должно быть кратно размеру кирпича' };
  let fd = null;
  try {
    fd = fs.openSync(desc.path, 'r');
    const st = fs.fstatSync(fd);
    if (st.size !== desc.fileSize) throw new Error('файл изменился во время чтения');
    const out = {
      pos: new Float32Array(count * 3), col: new Uint8Array(count * 3),
      intensity: desc.hasIntensity ? new Uint16Array(count) : null, classification: desc.hasClassification ? new Uint8Array(count) : null
    };
    const nChunks = Math.ceil(count / CH), boxes = new Float32Array(nChunks * 6);
    if (desc.kind === 'las') lasFill(desc, fd, from, count, out, boxes, opts.onProgress, CH);
    else if (desc.kind === 'ply') plyFill(desc, fd, from, count, out, boxes, opts.onProgress, CH);
    else throw new Error('неизвестный формат сегмента');
    if (opts.shuffle !== false) shuffleChunks(out, count, CH, from / CH);
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < nChunks; c++) for (let k = 0; k < 3; k++) { if (boxes[c * 6 + k] < mn[k]) mn[k] = boxes[c * 6 + k]; if (boxes[c * 6 + 3 + k] > mx[k]) mx[k] = boxes[c * 6 + 3 + k]; }
    const res = { ok: true, pos: out.pos, col: out.col, intensity: out.intensity, classification: out.classification, count, chunkPoints: CH, chunkBoxes: boxes, bbox: { mn, mx }, from };
    if (opts.filter) return filterSegment(res, opts.filter);
    return opts.keepPer > 0 && opts.keepPer < CH ? thinSegment(res, opts.keepPer) : res;
  } catch (e) {
    return { ok: false, message: 'Ошибка чтения облака: ' + String((e && e.message) || e) };
  } finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } }
}

// чтение сегмента в отдельном потоке: главный процесс не блокируется; отмена — через AbortSignal (поток завершается)
function readSegmentAsync(desc, from, count, opts) {
  opts = opts || {};
  const { Worker } = require('worker_threads');
  const signal = opts.signal;
  if (signal && signal.aborted) return Promise.resolve({ ok: false, cancelled: true, message: 'Импорт отменён' });
  let workerPath = path.join(__dirname, 'cloud-segment-worker.js');
  if (process.versions && process.versions.electron && process.resourcesPath) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'cloud-segment-worker.js');
    try { if (fs.existsSync(unpacked)) workerPath = unpacked; } catch (_) {}
  }
  return new Promise((resolve) => {
    let settled = false, worker = null, aborted = false;
    const done = (r) => {
      if (settled) return; settled = true;
      if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch (_) {} }
      if (worker) { try { worker.terminate().catch(() => {}); } catch (_) {} }
      resolve(r);
    };
    const onAbort = () => { aborted = true; done({ ok: false, cancelled: true, message: 'Импорт отменён' }); };
    try { worker = new Worker(workerPath, { workerData: { desc, from, count, shuffle: opts.shuffle !== false, keepPer: Math.floor(Number(opts.keepPer) || 0), filter: opts.filter || null } }); }
    catch (e) { done({ ok: false, message: 'Не удалось запустить поток чтения: ' + String((e && e.message) || e) }); return; }
    if (signal) { signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); }
    worker.on('message', (m) => { if (m && m.type === 'result') done(m.result || { ok: false, message: 'пустой ответ потока чтения' }); });
    worker.on('error', (e) => done({ ok: false, message: 'Ошибка потока чтения: ' + String((e && e.message) || e) }));
    worker.on('exit', (code) => { if (!settled && !aborted) done({ ok: false, message: 'Поток чтения завершился без результата (код ' + code + ')' }); });
  });
}

module.exports = { filterKeep, openSegmentSource, readSegment, readSegmentAsync, shuffleChunks, thinSegment, filterSegment, thinnedCount, keepPerForBudget, SEG_POINTS, CHUNK_POINTS };
