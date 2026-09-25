/*
 * las-node.js — потоковый парсер облаков точек для главного процесса (Node).
 *
 * Читает большие .las/.ply прямо с диска кусками, не загружая весь файл в память,
 * и прореживает до бюджета точек. Возвращает ту же структуру, что renderer/pointcloud.js,
 * чтобы Viewer3DGL.loadCloud()/loadColoredMesh() принял её без изменений.
 *
 *   parseCloudFile(absPath, opts) -> { ok, kind:'points'|'mesh', pos:Float32Array,
 *                                col?:Float32Array, count, meta } | { ok:false, message }
 *
 * Общие константы и чистые хелперы LAS вынесены в ./las-core (единый источник для Node и браузера).
 * Типизированные массивы передаются через IPC (structured clone).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { pathToFileURL } = require('url');
const cfg = require('./app-config');
const core = require('./las-core');
const PcdOutOfCore = require('./pcd-out-of-core');
const ResourceBudget = require('./octree-resource-budget');

const DEFAULT_MAX_POINTS = cfg.DEFAULT_MAX_POINTS;
const CHUNK_BYTES = cfg.CLOUD_CHUNK_BYTES;
const SCAN_N = cfg.COLOR_SAMPLE_COUNT;
function currentAvailableMemoryBytes() {
  const candidates = [];
  try {
    if (typeof process.availableMemory === 'function') {
      const value = Number(process.availableMemory());
      if (Number.isFinite(value) && value >= 0) candidates.push(value);
    }
  } catch (_) {}
  try {
    const value = Number(os.freemem());
    if (Number.isFinite(value) && value >= 0) candidates.push(value);
  } catch (_) {}
  return candidates.length ? Math.min.apply(null, candidates) : null;
}

function progressAt(callback, phase, fraction, detail) {
  if (typeof callback !== 'function') return;
  const p = { phase, fraction: Math.max(0, Math.min(1, Number(fraction) || 0)) };
  if (detail && typeof detail === 'object') Object.assign(p, detail);
  try { callback(p); } catch (_) {}
}

// ============================================================
// LAS (uncompressed), streamed from disk
// ============================================================
function readLasCrsWkt(fd, fileSize, head) {
  if (!head || head.length < 227 || !Number.isSafeInteger(fileSize) || fileSize < 227) return null;
  const headerSize = head.readUInt16LE(94);
  const pointDataOffset = head.readUInt32LE(96);
  const vlrCount = head.readUInt32LE(100);
  const maxWktBytes = 16 * 1024 * 1024;
  function user(buffer, offset, length) {
    return buffer.toString('ascii', offset, offset + length).replace(/\0/g, '').trim();
  }
  function scanVlrs(start, count, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end < start || count > Math.floor((end - start) / 54)) return null;
    let position = start;
    for (let i = 0; i < count; i++) {
      if (position + 54 > end) return null;
      const header = Buffer.alloc(54);
      if (fs.readSync(fd, header, 0, header.length, position) !== header.length) return null;
      const userId = user(header, 2, 16);
      const recordId = header.readUInt16LE(18);
      const length = header.readUInt16LE(20);
      const dataPosition = position + 54;
      const next = dataPosition + length;
      if (next > end) return null;
      if (userId === 'LASF_Projection' && (recordId === 2112 || recordId === 2111) &&
          length <= maxWktBytes) {
        const data = Buffer.alloc(length);
        if (fs.readSync(fd, data, 0, length, dataPosition) !== length) return null;
        return data.toString('utf8').replace(/\0+$/g, '').trim();
      }
      position = next;
    }
    return null;
  }
  const wkt = scanVlrs(headerSize, vlrCount, pointDataOffset);
  if (wkt) return wkt;
  if (head[25] >= 4 && head.length >= 375) {
    const evlrOffsetBig = head.readBigUInt64LE(235);
    const evlrCount = head.readUInt32LE(243);
    if (evlrOffsetBig > 0n && evlrOffsetBig <= BigInt(Number.MAX_SAFE_INTEGER) && evlrCount > 0) {
      const evlrOffset = Number(evlrOffsetBig);
      if (evlrOffset >= pointDataOffset && evlrOffset < fileSize &&
          evlrCount <= Math.floor((fileSize - evlrOffset) / 60)) {
        let position = evlrOffset;
        for (let i = 0; i < evlrCount; i++) {
          if (position + 60 > fileSize) break;
          const header = Buffer.alloc(60);
          if (fs.readSync(fd, header, 0, header.length, position) !== header.length) break;
          const userId = user(header, 2, 16);
          const recordId = header.readUInt16LE(18);
          const lengthBig = header.readBigUInt64LE(20);
          if (lengthBig > BigInt(Number.MAX_SAFE_INTEGER)) break;
          const length = Number(lengthBig);
          const dataPosition = position + 60;
          const next = dataPosition + length;
          if (!Number.isSafeInteger(next) || next > fileSize) break;
          if (userId === 'LASF_Projection' && (recordId === 2112 || recordId === 2111) &&
              length <= maxWktBytes) {
            const data = Buffer.alloc(length);
            if (fs.readSync(fd, data, 0, length, dataPosition) !== length) break;
            return data.toString('utf8').replace(/\0+$/g, '').trim();
          }
          position = next;
        }
      }
    }
  }
  return null;
}

function parseLASFile(fd, fileSize, maxPoints, onProgress) {
  progressAt(onProgress, 'header', 0.02);
  const head = Buffer.alloc(400);
  fs.readSync(fd, head, 0, 400, 0);
  const H = core.parseLasHeader({
    u8: (o) => head.readUInt8(o), u16: (o) => head.readUInt16LE(o), u32: (o) => head.readUInt32LE(o),
    i32: (o) => head.readInt32LE(o), f64: (o) => head.readDoubleLE(o), big64: (o) => Number(head.readBigUInt64LE(o)),
  });
  if (head[104] & 0xc0) throw new Error('сжатый или неизвестный LAS point format; для сжатого облака откройте LAZ');
  const crsWkt=readLasCrsWkt(fd,fileSize,head);
  const offToPts = H.offToPts, fmt = H.fmt, recLen = H.recLen, colorOff = H.colorOff;
  const intensityOff = H.intensityOff, classificationOff = H.classificationOff;
  const hasIntensity = H.hasIntensity && intensityOff + 2 <= recLen;
  const hasClassification = H.hasClassification && classificationOff + 1 <= recLen;
  const sx = H.scale.x, sy = H.scale.y, sz = H.scale.z, ox = H.offset.x, oy = H.offset.y, oz = H.offset.z;
  let count = H.count;
  let hasColor = H.hasColor;
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error('LAS содержит ноль точек или небезопасный point count');
  if (!recLen || offToPts <= 0) throw new Error('повреждённый заголовок LAS');

  // Не индексируем частичный файл молча: такое усечение маскировало повреждённые LAS.
  const maxByBytes = Math.floor((fileSize - offToPts) / recLen);
  if (maxByBytes < count) throw new Error('объявленное число точек LAS превышает объём записей в файле');
  if (count <= 0) throw new Error('в LAS нет точек');

  const budget = maxPoints > 0 ? maxPoints : DEFAULT_MAX_POINTS;
  const stride = count > budget ? Math.ceil(count / budget) : 1;
  let outCap = 0; for (let s = 0; s < count; s += stride) outCap++;

  // Определение глубины цвета: выборка РАВНОМЕРНО по всему файлу (а не первые 4000 точек),
  // иначе неокрашенное начало давало бы серый рендер всего облака. (r9)
  let colDiv = 65535;
  if (hasColor) {
    const step = Math.max(1, Math.floor(count / SCAN_N));
    const rec = Buffer.alloc(recLen);
    let maxC = 0;
    for (let q = 0; q < count; q += step) {
      const rd = fs.readSync(fd, rec, 0, recLen, offToPts + q * recLen);
      if (rd < colorOff + 6) break;
      const rr = rec.readUInt16LE(colorOff), gg = rec.readUInt16LE(colorOff + 2), bb = rec.readUInt16LE(colorOff + 4);
      if (rr > maxC) maxC = rr; if (gg > maxC) maxC = gg; if (bb > maxC) maxC = bb;
      if (maxC > 255) break; // уже ясно, что 16-битный
    }
    const dc = core.decideColorDivisor(maxC);
    hasColor = dc.hasColor; colDiv = dc.colDiv;
  }
  progressAt(onProgress, 'index', 0.1);

  const pos = new Float32Array(outCap * 3);
  const col = new Float32Array(outCap * 3);
  const intensity = hasIntensity ? new Float32Array(outCap) : null;
  const classification = hasClassification ? new Uint8Array(outCap) : null;
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  let oi = 0;
  // Global shift: мировые координаты (UTM/большие ~300000+) нельзя класть в Float32 напрямую:
  // шаг Float32 на 300k ≈ 3.5 см, точки «схлопываются» в сетку → вертикальные полосы.
  // Вычитаем координаты первой точки (double), в Float32 — малые относительные значения (точность микроны).
  let shX = 0, shY = 0, shZ = 0, haveSh = false;

  // читаем область точек кусками, выравненными по recLen
  const recPerChunk = Math.max(1, Math.floor(CHUNK_BYTES / recLen));
  const chunkBytes = recPerChunk * recLen;
  const chunk = Buffer.alloc(chunkBytes);
  let recIndex = 0;
  let filePos = offToPts;
  while (recIndex < count && oi < outCap) {
    const want = Math.min(chunkBytes, (count - recIndex) * recLen);
    const got = fs.readSync(fd, chunk, 0, want, filePos);
    if (got <= 0) break;
    const recsInChunk = Math.floor(got / recLen);
    for (let k = 0; k < recsInChunk; k++) {
      const gi = recIndex + k;
      if (!core.keepSampledIndex(gi, stride)) continue;
      if (oi >= outCap) break;
      const base = k * recLen;
      const X = chunk.readInt32LE(base), Y = chunk.readInt32LE(base + 4), Z = chunk.readInt32LE(base + 8);
      const wxD = X * sx + ox, wyD = Y * sy + oy, wzD = Z * sz + oz;
      if (!haveSh) { shX = wxD; shY = wyD; shZ = wzD; haveSh = true; }
      const wx = wxD - shX, wy = wyD - shY, wz = wzD - shZ;
      pos[oi * 3] = wx; pos[oi * 3 + 1] = wy; pos[oi * 3 + 2] = wz;
      if (wx < mnx) mnx = wx; if (wy < mny) mny = wy; if (wz < mnz) mnz = wz;
      if (wx > mxx) mxx = wx; if (wy > mxy) mxy = wy; if (wz > mxz) mxz = wz;
      if (hasColor) {
        const cb = base + colorOff;
        col[oi * 3] = chunk.readUInt16LE(cb) / colDiv;
        col[oi * 3 + 1] = chunk.readUInt16LE(cb + 2) / colDiv;
        col[oi * 3 + 2] = chunk.readUInt16LE(cb + 4) / colDiv;
      }
      if (intensity) intensity[oi] = chunk.readUInt16LE(base + intensityOff) / 65535;
      if (classification) classification[oi] = fmt >= 6 ? chunk[base + classificationOff] : (chunk[base + classificationOff] & 0x1f);
      oi++;
    }
    recIndex += recsInChunk;
    filePos += got;
    if (recsInChunk === 0) break;
    progressAt(onProgress, 'read', 0.1 + 0.78 * recIndex / count, { pointsRead: recIndex, pointsTotal: count });
  }
  const outN = oi;
  if (outN === 0) throw new Error('не удалось прочитать точки LAS');

  const w = mxx - mnx, d = mxy - mny, h = mxz - mnz;
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
  // survey Z-up -> viewer Y-up, центрировано по X/Y, основание на земле
  for (let j = 0; j < outN; j++) {
    const px = pos[j * 3], py = pos[j * 3 + 1], pz = pos[j * 3 + 2];
    pos[j * 3] = px - cx;
    pos[j * 3 + 1] = pz - mnz;
    pos[j * 3 + 2] = -(py - cy);
    if (!hasColor) {
      const c = core.elevationRamp((pz - mnz) / (h || 1));
      col[j * 3] = c[0]; col[j * 3 + 1] = c[1]; col[j * 3 + 2] = c[2];
    }
  }
  progressAt(onProgress, 'finalize', 0.96, { pointsLoaded: outN, pointsTotal: count });
  return {
    ok: true, kind: 'points',
    pos: pos.subarray(0, outN * 3).slice(),
    col: col.subarray(0, outN * 3).slice(),
    intensity: intensity ? intensity.subarray(0, outN).slice() : null,
    classification: classification ? classification.subarray(0, outN).slice() : null,
    count: outN,
    meta: { kind: 'points', points: outN, total: count, w, d, h, format: 'LAS fmt ' + fmt, colored: hasColor,
      hasIntensity: !!intensity, hasClassification: !!classification, crsWkt: crsWkt || null,
      offset: { cx: cx + shX, cy: cy + shY, mnz: mnz + shZ },
      srcXform: { axis: 'zup', t: [cx + shX, cy + shY, mnz + shZ] } }
  };
}

const LAS_MIN_RECORD_LENGTH = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67];
const LAS_MIN_VERSION_MINOR = [0, 0, 0, 0, 3, 3, 4, 4, 4, 4, 4];

function readExactAt(fd, buffer, length, position, message) {
  let offset = 0;
  while (offset < length) {
    const n = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (n <= 0) throw new Error(message || 'unexpected end of point-cloud file');
    offset += n;
  }
  return offset;
}

function readLasHeaderInfo(fd, fileSize) {
  if (!Number.isSafeInteger(fileSize) || fileSize < 227) throw new Error('LAS header is truncated');
  const head = Buffer.alloc(400);
  readExactAt(fd, head, Math.min(head.length, fileSize), 0, 'truncated LAS public header');
  const H = core.parseLasHeader({
    u8: o => head.readUInt8(o), u16: o => head.readUInt16LE(o),
    u32: o => head.readUInt32LE(o), i32: o => head.readInt32LE(o),
    f64: o => head.readDoubleLE(o), big64: o => Number(head.readBigUInt64LE(o))
  });
  const versionMajor = head.readUInt8(24), versionMinor = head.readUInt8(25);
  const headerSize = head.readUInt16LE(94);
  const pointFormatFlags = head.readUInt8(104);
  const format = pointFormatFlags & 0x3f;
  if (versionMajor !== 1 || versionMinor > 4) throw new Error('unsupported LAS version');
  const minimumHeaderSize = versionMinor >= 4 ? 375 : (versionMinor >= 3 ? 235 : 227);
  if (headerSize < minimumHeaderSize || headerSize > fileSize) throw new Error('invalid LAS public-header size');
  if (pointFormatFlags & 0xc0) throw new Error('compressed or reserved LAS point-format flags are not supported by out-of-core indexing');
  if (format > 10 || versionMinor < LAS_MIN_VERSION_MINOR[format]) {
    throw new Error('unsupported LAS point-data format/version combination');
  }
  if (H.recLen < LAS_MIN_RECORD_LENGTH[format]) throw new Error('LAS point record is shorter than its format requires');
  if (!Number.isSafeInteger(H.count) || H.count < 1) throw new Error('LAS contains no points or exceeds safe point-count limits');
  if (!Number.isSafeInteger(H.offToPts) || H.offToPts < headerSize || H.offToPts > fileSize) {
    throw new Error('invalid LAS point-data offset');
  }
  const vlrCount = head.readUInt32LE(100);
  if (vlrCount > Math.floor((H.offToPts - headerSize) / 54)) {
    throw new Error('LAS VLR table exceeds the point-data offset');
  }
  let vlrPosition = headerSize;
  for (let i = 0; i < vlrCount; i++) {
    const vlrHeader = Buffer.alloc(54);
    readExactAt(fd, vlrHeader, vlrHeader.length, vlrPosition, 'truncated LAS VLR header');
    const vlrEnd = vlrPosition + 54 + vlrHeader.readUInt16LE(20);
    if (vlrEnd > H.offToPts) throw new Error('LAS VLR data overlaps point records');
    vlrPosition = vlrEnd;
  }
  if (![H.scale.x, H.scale.y, H.scale.z].every(v => Number.isFinite(v) && v > 0) ||
      ![H.offset.x, H.offset.y, H.offset.z].every(Number.isFinite)) {
    throw new Error('LAS coordinate scale/offset is invalid');
  }
  const pointBytes = H.count * H.recLen;
  if (!Number.isSafeInteger(pointBytes) || !Number.isSafeInteger(H.offToPts + pointBytes) ||
      H.offToPts + pointBytes > fileSize) {
    throw new Error('LAS point records are truncated or exceed the file');
  }
  const crsWkt = readLasCrsWkt(fd, fileSize, head);
  const publicHeader = Buffer.alloc(headerSize);
  readExactAt(fd, publicHeader, headerSize, 0, 'truncated LAS public header');
  const layoutSignature = crypto.createHash('sha256')
    .update(publicHeader)
    .update(JSON.stringify({
      versionMajor, versionMinor, format, recordLength: H.recLen,
      pointCount: H.count, pointDataOffset: H.offToPts,
      scale: H.scale, offset: H.offset, crsWkt: crsWkt || null
    }))
    .digest('hex');
  return {
    H, head, versionMajor, versionMinor, headerSize, format,
    pointFormatFlags, crsWkt, layoutSignature
  };
}

function lasPointFileInfoFromFd(fd, absPath) {
  const stat = fs.fstatSync(fd, { bigint: true });
  if (!stat.isFile()) throw new Error('point-cloud source is not a regular file');
  const fileSize = Number(stat.size);
  if (!Number.isSafeInteger(fileSize) || fileSize < 227) throw new Error('LAS file size is outside safe limits');
  const parsed = readLasHeaderInfo(fd, fileSize);
  const hasIntensity = parsed.H.hasIntensity && parsed.H.intensityOff + 2 <= parsed.H.recLen;
  const hasClassification = parsed.H.hasClassification &&
    parsed.H.classificationOff + 1 <= parsed.H.recLen;
  const info = Object.assign(plyBigintStatIdentity(stat), {
    pointCount: parsed.H.count,
    pointFormat: parsed.format,
    recordLength: parsed.H.recLen,
    hasIntensity: !!hasIntensity,
    hasClassification: !!hasClassification,
    pointDataOffset: parsed.H.offToPts,
    versionMajor: parsed.versionMajor,
    versionMinor: parsed.versionMinor,
    layoutSignature: parsed.layoutSignature
  });
  if (absPath) {
    const pathStat = fs.statSync(absPath, { bigint: true });
    if (!pathStat.isFile()) throw new Error('point-cloud source is not a regular file');
    const pathIdentity = plyBigintStatIdentity(pathStat);
    if (info.fileSize !== pathIdentity.fileSize ||
        info.mtimeNs !== pathIdentity.mtimeNs ||
        info.device !== pathIdentity.device ||
        info.inode !== pathIdentity.inode) {
      throw new Error('LAS source changed while reading its header');
    }
  }
  return info;
}

function sameLasPointFileInfo(a, b) {
  if (!a || !b) return false;
  const keys = ['fileSize', 'mtimeNs', 'device', 'inode', 'pointCount', 'pointFormat',
    'recordLength', 'hasIntensity', 'hasClassification', 'pointDataOffset',
    'versionMajor', 'versionMinor', 'layoutSignature'];
  return keys.every(key => String(a[key]) === String(b[key]));
}

function getOutOfCoreLasPointFileInfo(absPath) {
  let fd = null;
  try {
    fd = fs.openSync(absPath, 'r');
    return lasPointFileInfoFromFd(fd, absPath);
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
  }
}

function isOutOfCoreLasPointFile(absPath) {
  try { getOutOfCoreLasPointFileInfo(absPath); return true; }
  catch (_) { return false; }
}

function forEachLasPointRecord(fd, parsed, onRecord, onBatch) {
  const { H } = parsed;
  const recordsPerChunk = Math.max(1, Math.floor(CHUNK_BYTES / H.recLen));
  const buffer = Buffer.allocUnsafe(recordsPerChunk * H.recLen);
  let recordIndex = 0;
  while (recordIndex < H.count) {
    const records = Math.min(recordsPerChunk, H.count - recordIndex);
    const bytes = records * H.recLen;
    readExactAt(fd, buffer, bytes, H.offToPts + recordIndex * H.recLen, 'truncated LAS point data');
    for (let i = 0; i < records; i++) onRecord(recordIndex + i, buffer, i * H.recLen);
    recordIndex += records;
    if (onBatch) onBatch(recordIndex);
  }
  return recordIndex;
}

function prepareLasOctreeFile(sourcePath, canonicalPath, maxPoints, onProgress, preferredSourceTransform, expectedSourceInfo) {
  let sourceFd = null, canonicalFd = null;
  try {
    sourceFd = fs.openSync(sourcePath, 'r');
    const sourceStat = fs.fstatSync(sourceFd, { bigint: true });
    if (!sourceStat.isFile()) throw new Error('point-cloud source is not a regular file');
    const sourceSize = Number(sourceStat.size);
    if (!Number.isSafeInteger(sourceSize)) throw new Error('LAS file size exceeds safe limits');
    const info = lasPointFileInfoFromFd(sourceFd, sourcePath);
    if (expectedSourceInfo && !sameLasPointFileInfo(info, expectedSourceInfo)) {
      throw new Error('source LAS changed after resource preflight; retry indexing');
    }
    const parsed = readLasHeaderInfo(sourceFd, sourceSize);
    const H = parsed.H;
    const hasIntensity = H.hasIntensity && H.intensityOff + 2 <= H.recLen;
    const hasClassification = H.hasClassification && H.classificationOff + 1 <= H.recLen;
    const hasRgbFields = H.hasColor && H.colorOff + 6 <= H.recLen;

    const budget = Number.isSafeInteger(maxPoints) && maxPoints > 0 ? maxPoints : DEFAULT_MAX_POINTS;
    const sampleStride = H.count > budget ? Math.ceil(H.count / budget) : 1;
    let validCount = 0, invalidCount = 0;
    let shX = 0, shY = 0, shZ = 0, haveShift = false;
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;

    let colorDiv = 65535, colored = false;
    if (hasRgbFields) {
      const sampleStep = Math.max(1, Math.floor(H.count / SCAN_N));
      const record = Buffer.alloc(H.recLen);
      let maxChannel = 0;
      for (let index = 0; index < H.count; index += sampleStep) {
        readExactAt(sourceFd, record, H.recLen, H.offToPts + index * H.recLen,
          'truncated LAS RGB sample');
        const c = H.colorOff;
        maxChannel = Math.max(maxChannel, record.readUInt16LE(c),
          record.readUInt16LE(c + 2), record.readUInt16LE(c + 4));
        if (maxChannel > 255) break;
      }
      const decision = core.decideColorDivisor(maxChannel);
      colored = decision.hasColor;
      colorDiv = decision.colDiv;
    }

    progressAt(onProgress, 'scan-start', 0.02, { pointsTotal: H.count, mode: 'out-of-core-las' });
    forEachLasPointRecord(sourceFd, parsed, (globalIndex, buffer, base) => {
      const selected = core.keepSampledIndex(globalIndex, sampleStride);
      const rawX = buffer.readInt32LE(base), rawY = buffer.readInt32LE(base + 4);
      const rawZ = buffer.readInt32LE(base + 8);
      const worldX = rawX * H.scale.x + H.offset.x;
      const worldY = rawY * H.scale.y + H.offset.y;
      const worldZ = rawZ * H.scale.z + H.offset.z;
      if (![worldX, worldY, worldZ].every(Number.isFinite)) {
        invalidCount++;
        return;
      }
      if (!selected) return;
      if (!haveShift) { shX = worldX; shY = worldY; shZ = worldZ; haveShift = true; }
      const x = worldX - shX, y = worldY - shY, z = worldZ - shZ;
      if (![x, y, z].every(Number.isFinite)) { invalidCount++; return; }
      mnx = Math.min(mnx, x); mny = Math.min(mny, y); mnz = Math.min(mnz, z);
      mxx = Math.max(mxx, x); mxy = Math.max(mxy, y); mxz = Math.max(mxz, z);
      validCount++;
    }, readCount => {
      progressAt(onProgress, 'scan', 0.02 + 0.28 * readCount / H.count,
        { pointsRead: readCount, pointsTotal: H.count, validPoints: validCount });
    });
    if (!validCount || !haveShift || !Number.isFinite(mnx + mny + mnz + mxx + mxy + mxz)) {
      throw new Error('LAS has no finite indexed XYZ points');
    }
    if (![mxx - mnx, mxy - mny, mxz - mnz].every(Number.isFinite)) {
      throw new Error('LAS coordinate range exceeds safe double-precision limits');
    }

    let preferredT = null;
    if (preferredSourceTransform != null) {
      const t = preferredSourceTransform;
      if (!t || t.axis !== 'zup' || !Array.isArray(t.t) || t.t.length < 3 ||
          !t.t.slice(0, 3).every(value => Number.isFinite(Number(value)) && Math.abs(Number(value)) <= 1e12)) {
        throw new Error('LAS out-of-core source transform must be a finite Z-up transform');
      }
      preferredT = t.t.slice(0, 3).map(Number);
    }
    // Match parseLASFile: bounds are calculated on double coordinates relative
    // to the first sampled return; viewer positions are then stored as Float32.
    const centerX = preferredT ? preferredT[0] - shX : (mnx + mxx) / 2;
    const centerY = preferredT ? preferredT[1] - shY : (mny + mxy) / 2;
    const centerZ = preferredT ? preferredT[2] - shZ : mnz;
    const transform = preferredT || [centerX + shX, centerY + shY, centerZ + shZ];
    const height = mxz - mnz;
    const outputBounds = { mn: [Infinity, Infinity, Infinity], mx: [-Infinity, -Infinity, -Infinity] };

    const recordStride = 15 + (hasIntensity ? 4 : 0) + (hasClassification ? 1 : 0);
    const outputPath = path.resolve(canonicalPath);
    canonicalFd = fs.openSync(outputPath, 'wx', 0o600);
    const outputRecords = Math.max(1, Math.floor(CHUNK_BYTES / recordStride));
    const outputBuffer = Buffer.allocUnsafe(outputRecords * recordStride);
    let outputPosition = 0, outputCount = 0;
    function clampByte(value) {
      if (!Number.isFinite(value)) return 0;
      return Math.max(0, Math.min(255, Math.round(value * 255)));
    }
    function flushOutput() {
      if (!outputPosition) return;
      let written = 0;
      while (written < outputPosition) {
        const n = fs.writeSync(canonicalFd, outputBuffer, written, outputPosition - written);
        if (!n) throw new Error('short write while creating canonical LAS point store');
        written += n;
      }
      outputPosition = 0;
    }

    progressAt(onProgress, 'convert-start', 0.32,
      { pointsTotal: H.count, pointsSelected: validCount });
    forEachLasPointRecord(sourceFd, parsed, (globalIndex, buffer, base) => {
      if (!core.keepSampledIndex(globalIndex, sampleStride)) return;
      const rawX = buffer.readInt32LE(base), rawY = buffer.readInt32LE(base + 4);
      const rawZ = buffer.readInt32LE(base + 8);
      const worldX = rawX * H.scale.x + H.offset.x;
      const worldY = rawY * H.scale.y + H.offset.y;
      const worldZ = rawZ * H.scale.z + H.offset.z;
      if (![worldX, worldY, worldZ].every(Number.isFinite)) return;
      const relX = Math.fround(worldX - shX), relY = Math.fround(worldY - shY);
      const relZ = Math.fround(worldZ - shZ);
      const xyz = [
        Math.fround(relX - centerX),
        Math.fround(relZ - centerZ),
        Math.fround(-(relY - centerY))
      ];
      if (!xyz.every(Number.isFinite)) {
        throw new Error('LAS viewer coordinates exceed the Float32 streaming range');
      }
      for (let axis = 0; axis < 3; axis++) {
        outputBounds.mn[axis] = Math.min(outputBounds.mn[axis], xyz[axis]);
        outputBounds.mx[axis] = Math.max(outputBounds.mx[axis], xyz[axis]);
      }
      const offset = outputPosition;
      outputBuffer.writeFloatLE(xyz[0], offset);
      outputBuffer.writeFloatLE(xyz[1], offset + 4);
      outputBuffer.writeFloatLE(xyz[2], offset + 8);
      if (colored) {
        const c = base + H.colorOff;
        outputBuffer[offset + 12] = clampByte(Math.fround(buffer.readUInt16LE(c) / colorDiv));
        outputBuffer[offset + 13] = clampByte(Math.fround(buffer.readUInt16LE(c + 2) / colorDiv));
        outputBuffer[offset + 14] = clampByte(Math.fround(buffer.readUInt16LE(c + 4) / colorDiv));
      } else {
        const ramp = core.elevationRamp((relZ - mnz) / (height || 1));
        outputBuffer[offset + 12] = clampByte(Math.fround(ramp[0]));
        outputBuffer[offset + 13] = clampByte(Math.fround(ramp[1]));
        outputBuffer[offset + 14] = clampByte(Math.fround(ramp[2]));
      }
      let attributeOffset = offset + 15;
      if (hasIntensity) {
        outputBuffer.writeFloatLE(buffer.readUInt16LE(base + H.intensityOff) / 65535, attributeOffset);
        attributeOffset += 4;
      }
      if (hasClassification) {
        const rawClass = buffer[base + H.classificationOff];
        outputBuffer[attributeOffset++] = parsed.format >= 6 ? rawClass : (rawClass & 0x1f);
      }
      outputPosition += recordStride;
      outputCount++;
      if (outputPosition === outputBuffer.length) flushOutput();
    }, readCount => {
      progressAt(onProgress, 'convert', 0.32 + 0.14 * readCount / H.count,
        { pointsRead: readCount, pointsTotal: H.count, pointsWritten: outputCount });
    });
    flushOutput();
    if (outputCount !== validCount) throw new Error('canonical LAS count differs from the validated scan');

    const sourceAfter = lasPointFileInfoFromFd(sourceFd, sourcePath);
    if (!sameLasPointFileInfo(info, sourceAfter)) {
      throw new Error('source LAS changed while out-of-core indexing was running');
    }
    const eps = outputBounds.mn.map((mn, i) => Math.max(1e-6, (outputBounds.mx[i] - mn) * 1e-6));
    for (let i = 0; i < 3; i++) outputBounds.mx[i] += eps[i];
    const metaOut = {
      kind: 'points', points: outputCount, total: H.count,
      w: mxx - mnx, d: mxy - mny, h: mxz - mnz,
      format: 'LAS fmt ' + parsed.format + ' (out-of-core two-pass)',
      colored,
      hasIntensity, hasClassification,
      streamAttributeOmissions: [],
      crsWkt: parsed.crsWkt || null,
      offset: { cx: transform[0], cy: transform[1], mnz: transform[2] },
      srcXform: { axis: 'zup', t: transform.slice() },
      outOfCore: true, invalidPointCount: invalidCount,
      sampleStride, sourcePointCount: H.count,
      colorStorage: 'RGB8'
    };
    progressAt(onProgress, 'convert-done', 0.48,
      { pointsWritten: outputCount, pointsTotal: H.count, invalidPoints: invalidCount });
    return {
      ok: true, canonicalPath: outputPath, count: outputCount,
      sourcePointCount: H.count, invalidPointCount: invalidCount,
      hasColor: true, meta: metaOut, bbox: outputBounds,
      ingest: 'las-two-pass'
    };
  } catch (error) {
    if (canonicalFd !== null) {
      try { fs.closeSync(canonicalFd); } catch (_) {}
      canonicalFd = null;
      try { fs.unlinkSync(canonicalPath); } catch (_) {}
    }
    throw error;
  } finally {
    if (sourceFd !== null) try { fs.closeSync(sourceFd); } catch (_) {}
    if (canonicalFd !== null) try { fs.closeSync(canonicalFd); } catch (_) {}
  }
}

// ============================================================
// PLY (ascii + binary LE/BE), streamed from disk — облака точек (r10)
// ============================================================
function plyTypeSize(t) {
  switch (t) {
    case 'char': case 'uchar': case 'int8': case 'uint8': return 1;
    case 'short': case 'ushort': case 'int16': case 'uint16': return 2;
    case 'int': case 'uint': case 'int32': case 'uint32': case 'float': case 'float32': return 4;
    case 'double': case 'float64': return 8;
    default: return 0;
  }
}
function plyIsFloat(t) { return t === 'float' || t === 'float32' || t === 'double' || t === 'float64'; }
function plyColorDiv(t) { if (plyIsFloat(t)) return 1; if (t === 'ushort' || t === 'uint16' || t === 'short' || t === 'int16') return 65535; return 255; }
function plyIntensityDiv(t, maxValue) {
  const type = String(t || '').toLowerCase();
  if (plyIsFloat(type)) return maxValue > 1.0001 ? maxValue : 1;
  if (type === 'uchar' || type === 'uint8') return 255;
  if (type === 'char' || type === 'int8') return 127;
  if (type === 'ushort' || type === 'uint16') return 65535;
  if (type === 'short' || type === 'int16') return 32767;
  if (type === 'uint' || type === 'uint32') return 4294967295;
  if (type === 'int' || type === 'int32') return 2147483647;
  return maxValue > 1.0001 ? maxValue : 1;
}
function commentValue(comments, key) {
  const re = new RegExp('^(?:BIM_TWIN_)?' + String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*(.*)$', 'i');
  for (const raw of comments || []) {
    const m = re.exec(String(raw || '').trim());
    if (m) return m[1].trim();
  }
  return null;
}
function commentCrs(comments) {
  const encoded = commentValue(comments, 'crs_wkt_uri');
  if (encoded) { try { return decodeURIComponent(encoded); } catch (_) { return encoded; } }
  return commentValue(comments, 'crs_wkt') || commentValue(comments, 'crs');
}
function commentUp(comments, fallback) {
  const up = String(commentValue(comments, 'up') || '').toLowerCase();
  return up === 'y' || up === 'yup' ? 'y' : up === 'z' || up === 'zup' ? 'z' : fallback || 'z';
}
function plyRead(buf, off, type, le) {
  switch (type) {
    case 'char': case 'int8': return buf.readInt8(off);
    case 'uchar': case 'uint8': return buf.readUInt8(off);
    case 'short': case 'int16': return le ? buf.readInt16LE(off) : buf.readInt16BE(off);
    case 'ushort': case 'uint16': return le ? buf.readUInt16LE(off) : buf.readUInt16BE(off);
    case 'int': case 'int32': return le ? buf.readInt32LE(off) : buf.readInt32BE(off);
    case 'uint': case 'uint32': return le ? buf.readUInt32LE(off) : buf.readUInt32BE(off);
    case 'float': case 'float32': return le ? buf.readFloatLE(off) : buf.readFloatBE(off);
    case 'double': case 'float64': return le ? buf.readDoubleLE(off) : buf.readDoubleBE(off);
    default: throw new Error('неизвестный тип PLY: ' + type);
  }
}

function readPlyHeader(fd, fileSize) {
  const cap = Math.min(fileSize, 1024 * 1024);
  const hb = Buffer.alloc(cap);
  fs.readSync(fd, hb, 0, cap, 0);
  const idx = hb.indexOf(Buffer.from('end_header'));
  if (idx < 0) throw new Error('заголовок PLY не найден');
  let nl = idx + 10;
  while (nl < cap && hb[nl] !== 10) nl++;
  const dataOffset = nl + 1;
  const headerText = hb.toString('ascii', 0, idx + 10);
  const lines = headerText.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== 'ply') throw new Error('файл не является PLY');
  let format = 'ascii'; const elements = []; let cur = null; const comments = [];
  for (const raw of lines) {
    const t = raw.trim().split(/\s+/);
    if (t[0] === 'comment' || t[0] === 'obj_info') comments.push(raw.trim().slice(t[0].length).trim());
    if (t[0] === 'format') format = t[1];
    else if (t[0] === 'element') { cur = { name: t[1], count: parseInt(t[2], 10), props: [] }; elements.push(cur); }
    else if (t[0] === 'property' && cur) {
      if (t[1] === 'list') cur.props.push({ list: true, countType: t[2], itemType: t[3], name: t[4] });
      else cur.props.push({ list: false, type: t[1], name: t[2] });
    }
  }
  return { format, elements, dataOffset, comments };
}

function binaryPlyPointLayout(meta, fileSize) {
  if (!meta || !/^binary_(?:little|big)_endian$/i.test(String(meta.format || ''))) {
    throw new Error('out-of-core PLY supports binary little-endian or big-endian point clouds');
  }
  const vtx = (meta.elements || []).find((e) => e.name === 'vertex');
  if (!vtx || !Number.isSafeInteger(vtx.count) || vtx.count < 1) throw new Error('в PLY нет вершин');
  const firstNonEmpty = (meta.elements || []).find((e) => e.count > 0);
  if (firstNonEmpty !== vtx) {
    throw new Error('out-of-core PLY requires the vertex element before other non-empty elements');
  }
  const face = (meta.elements || []).find((e) => e.name === 'face');
  if (face && face.count > 0) throw new Error('PLY mesh uses the mesh import path, not point-cloud LOD');
  if (vtx.props.some((p) => p.list)) throw new Error('binary PLY vertex list properties are not supported for out-of-core indexing');

  const byName = new Map();
  let recordLength = 0;
  for (const prop of vtx.props) {
    const size = plyTypeSize(prop.type);
    if (!size) throw new Error('unsupported PLY vertex property type: ' + prop.type);
    const name = String(prop.name || '').toLowerCase();
    if (byName.has(name)) throw new Error('duplicate PLY vertex property: ' + prop.name);
    byName.set(name, { name: prop.name, type: prop.type, offset: recordLength });
    recordLength += size;
  }
  if (!Number.isSafeInteger(recordLength) || recordLength < 1 || recordLength > 1024 * 1024) {
    throw new Error('PLY vertex record size is outside the safe streaming limit');
  }
  const x = byName.get('x'), y = byName.get('y'), z = byName.get('z');
  if (!x || !y || !z) throw new Error('PLY vertex x/y/z properties are required');
  const vertexBytes = vtx.count * recordLength;
  if (!Number.isSafeInteger(vertexBytes) || meta.dataOffset + vertexBytes > fileSize) {
    throw new Error('PLY vertex records are truncated or exceed the file');
  }
  const color = {
    r: byName.get('red') || byName.get('r') || byName.get('diffuse_red'),
    g: byName.get('green') || byName.get('g') || byName.get('diffuse_green'),
    b: byName.get('blue') || byName.get('b') || byName.get('diffuse_blue')
  };
  const hasColor = !!(color.r && color.g && color.b);
  const intensity = byName.get('intensity') || byName.get('scalar_intensity') || byName.get('reflectance') || null;
  const classification = byName.get('classification') || byName.get('class') || byName.get('label') || byName.get('scalar_classification') || null;
  return {
    vertexCount: vtx.count,
    recordLength,
    littleEndian: meta.format.toLowerCase().includes('little'),
    x, y, z, color, hasColor,
    colorDivisor: hasColor ? plyColorDiv(color.r.type) : 1,
    intensity, classification
  };
}

const MAX_PLY_ASCII_VERTEX_LINE_BYTES = 1024 * 1024;

function asciiPlyPointLayout(meta) {
  if (!meta || String(meta.format || '').toLowerCase() !== 'ascii') {
    throw new Error('out-of-core PLY supports ASCII or binary little-/big-endian point clouds');
  }
  const vtx = (meta.elements || []).find((e) => e.name === 'vertex');
  if (!vtx || !Number.isSafeInteger(vtx.count) || vtx.count < 1) throw new Error('в PLY нет вершин');
  const firstNonEmpty = (meta.elements || []).find((e) => e.count > 0);
  if (firstNonEmpty !== vtx) {
    throw new Error('out-of-core PLY requires the vertex element before other non-empty elements');
  }
  const face = (meta.elements || []).find((e) => e.name === 'face');
  if (face && face.count > 0) throw new Error('PLY mesh uses the mesh import path, not point-cloud LOD');
  if (vtx.props.some((p) => p.list)) throw new Error('ASCII PLY vertex list properties are not supported for out-of-core indexing');

  const byName = new Map();
  for (let index = 0; index < vtx.props.length; index++) {
    const prop = vtx.props[index];
    if (!plyTypeSize(prop.type)) throw new Error('unsupported PLY vertex property type: ' + prop.type);
    const name = String(prop.name || '').toLowerCase();
    if (byName.has(name)) throw new Error('duplicate PLY vertex property: ' + prop.name);
    byName.set(name, { name: prop.name, type: prop.type, index });
  }
  const x = byName.get('x'), y = byName.get('y'), z = byName.get('z');
  if (!x || !y || !z) throw new Error('PLY vertex x/y/z properties are required');
  const color = {
    r: byName.get('red') || byName.get('r') || byName.get('diffuse_red'),
    g: byName.get('green') || byName.get('g') || byName.get('diffuse_green'),
    b: byName.get('blue') || byName.get('b') || byName.get('diffuse_blue')
  };
  const hasColor = !!(color.r && color.g && color.b);
  const intensity = byName.get('intensity') || byName.get('scalar_intensity') || byName.get('reflectance') || null;
  const classification = byName.get('classification') || byName.get('class') || byName.get('label') || byName.get('scalar_classification') || null;
  return {
    encoding: 'ascii',
    vertexCount: vtx.count,
    propertyCount: vtx.props.length,
    properties: vtx.props.map((p) => ({ type: p.type, name: p.name })),
    x, y, z, color, hasColor,
    colorDivisor: hasColor ? plyColorDiv(color.r.type) : 1,
    intensity, classification
  };
}

function plyPointFileLayout(meta, fileSize) {
  const format = String(meta && meta.format || '').toLowerCase();
  if (/^binary_(?:little|big)_endian$/.test(format)) {
    const layout = binaryPlyPointLayout(meta, fileSize);
    layout.encoding = 'binary';
    layout.properties = (meta.elements.find((e) => e.name === 'vertex') || {}).props || [];
    return layout;
  }
  if (format === 'ascii') return asciiPlyPointLayout(meta, fileSize);
  throw new Error('out-of-core PLY supports ASCII or binary little-/big-endian point clouds');
}

function plyBigintStatIdentity(stat) {
  return {
    fileSize: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    device: String(stat.dev),
    inode: String(stat.ino)
  };
}

function plyLayoutSignature(meta, layout) {
  return crypto.createHash('sha256').update(JSON.stringify({
    format: String(meta.format || ''),
    dataOffset: meta.dataOffset,
    elements: (meta.elements || []).map((e) => ({
      name: e.name, count: e.count,
      props: (e.props || []).map((p) => [!!p.list, p.type || '', p.countType || '', p.itemType || '', p.name || ''])
    })),
    comments: meta.comments || [],
    encoding: layout.encoding
  })).digest('hex');
}

function binaryPlyInfoFromFd(fd, absPath) {
  const stat = fs.fstatSync(fd, { bigint: true });
  if (!stat.isFile()) throw new Error('point-cloud source is not a regular file');
  const fileSize = Number(stat.size);
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) throw new Error('PLY file size exceeds safe limits');
  const meta = readPlyHeader(fd, fileSize);
  const layout = binaryPlyPointLayout(meta, fileSize);
  const info = Object.assign(plyBigintStatIdentity(stat), {
    vertexCount: layout.vertexCount,
    recordLength: layout.recordLength,
    dataOffset: meta.dataOffset,
    format: String(meta.format),
    hasIntensity: !!layout.intensity,
    hasClassification: !!layout.classification
  });
  if (absPath) {
    const pathStat = fs.statSync(absPath, { bigint: true });
    if (!pathStat.isFile()) throw new Error('point-cloud source is not a regular file');
    const pathIdentity = plyBigintStatIdentity(pathStat);
    if (info.fileSize !== pathIdentity.fileSize ||
        info.mtimeNs !== pathIdentity.mtimeNs ||
        info.device !== pathIdentity.device ||
        info.inode !== pathIdentity.inode) {
      throw new Error('PLY source changed while reading its header');
    }
  }
  return info;
}

function plyPointInfoFromFd(fd, absPath) {
  const stat = fs.fstatSync(fd, { bigint: true });
  if (!stat.isFile()) throw new Error('point-cloud source is not a regular file');
  const fileSize = Number(stat.size);
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) throw new Error('PLY file size exceeds safe limits');
  const meta = readPlyHeader(fd, fileSize);
  const layout = plyPointFileLayout(meta, fileSize);
  const info = Object.assign(plyBigintStatIdentity(stat), {
    vertexCount: layout.vertexCount,
    recordLength: Number(layout.recordLength) || 0,
    propertyCount: Number(layout.propertyCount) || (layout.properties || []).length,
    dataOffset: meta.dataOffset,
    format: String(meta.format),
    hasIntensity: !!layout.intensity,
    hasClassification: !!layout.classification,
    layoutSignature: plyLayoutSignature(meta, layout)
  });
  if (absPath) {
    const pathStat = fs.statSync(absPath, { bigint: true });
    if (!pathStat.isFile()) throw new Error('point-cloud source is not a regular file');
    const pathIdentity = plyBigintStatIdentity(pathStat);
    if (info.fileSize !== pathIdentity.fileSize ||
        info.mtimeNs !== pathIdentity.mtimeNs ||
        info.device !== pathIdentity.device ||
        info.inode !== pathIdentity.inode) {
      throw new Error('PLY source changed while reading its header');
    }
  }
  return info;
}

function sameBinaryPlyPointFileInfo(a, b) {
  if (!a || !b) return false;
  const keys = ['fileSize', 'mtimeNs', 'device', 'inode', 'vertexCount', 'recordLength',
    'propertyCount', 'dataOffset', 'format', 'hasIntensity', 'hasClassification', 'layoutSignature'];
  return keys.every(key => String(a[key]) === String(b[key]));
}

function samePlyPointFileInfo(a, b) {
  return sameBinaryPlyPointFileInfo(a, b);
}

function getBinaryPlyPointFileInfo(absPath) {
  let fd = null;
  try {
    fd = fs.openSync(absPath, 'r');
    return binaryPlyInfoFromFd(fd, absPath);
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
  }
}

function getOutOfCorePlyPointFileInfo(absPath) {
  let fd = null;
  try {
    fd = fs.openSync(absPath, 'r');
    return plyPointInfoFromFd(fd, absPath);
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
  }
}

function isBinaryPlyPointFile(absPath) {
  try {
    getBinaryPlyPointFileInfo(absPath);
    return true;
  } catch (_) {
    return false;
  }
}

function isOutOfCorePlyPointFile(absPath) {
  try {
    getOutOfCorePlyPointFileInfo(absPath);
    return true;
  } catch (_) {
    return false;
  }
}

function plyRecordValue(record, field, layout) {
  if (!field) return NaN;
  if (layout.encoding === 'ascii') return Number(record.tokens[field.index]);
  return plyRead(record.buffer, record.base + field.offset, field.type, layout.littleEndian);
}

function forEachPlyVertexRecord(fd, fileSize, meta, layout, onRecord, onBatch) {
  const total = layout.vertexCount;
  let recordIndex = 0;
  if (layout.encoding === 'binary') {
    const recordLength = layout.recordLength;
    const recordsPerChunk = Math.max(1, Math.floor(CHUNK_BYTES / recordLength));
    const buffer = Buffer.alloc(recordsPerChunk * recordLength);
    while (recordIndex < total) {
      const records = Math.min(recordsPerChunk, total - recordIndex);
      const want = records * recordLength;
      let got = 0;
      while (got < want) {
        const n = fs.readSync(fd, buffer, got, want - got,
          meta.dataOffset + recordIndex * recordLength + got);
        if (n <= 0) throw new Error('truncated binary PLY vertex data');
        got += n;
      }
      for (let k = 0; k < records; k++) {
        onRecord(recordIndex + k, { buffer, base: k * recordLength });
      }
      recordIndex += records;
      if (onBatch) onBatch(recordIndex);
    }
    return recordIndex;
  }

  const buffer = Buffer.alloc(Math.max(1, CHUNK_BYTES));
  let position = meta.dataOffset, carry = '';
  function consumeLine(raw) {
    if (recordIndex >= total) return;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.trim()) return;
    if (line.length > MAX_PLY_ASCII_VERTEX_LINE_BYTES) {
      throw new Error('ASCII PLY vertex line exceeds the 1 MiB safety limit');
    }
    const tokens = line.trim().split(/[ \t]+/);
    if (tokens.length !== layout.propertyCount) {
      throw new Error('malformed ASCII PLY vertex record ' + (recordIndex + 1) +
        ': expected ' + layout.propertyCount + ' scalar values, found ' + tokens.length);
    }
    for (let i = 0; i < tokens.length; i++) {
      const value = Number(tokens[i]);
      if (!Number.isFinite(value) &&
          !plyIsFloat(String(layout.properties[i].type || '').toLowerCase())) {
        throw new Error('malformed ASCII PLY integer property in vertex record ' + (recordIndex + 1));
      }
      if (Number.isFinite(value) &&
          !plyIsFloat(String(layout.properties[i].type || '').toLowerCase()) &&
          !Number.isInteger(value)) {
        throw new Error('malformed ASCII PLY integer property in vertex record ' + (recordIndex + 1));
      }
    }
    onRecord(recordIndex, { tokens });
    recordIndex++;
  }

  while (position < fileSize && recordIndex < total) {
    const want = Math.min(buffer.length, fileSize - position);
    const got = fs.readSync(fd, buffer, 0, want, position);
    if (got <= 0) break;
    position += got;
    const text = carry + buffer.toString('latin1', 0, got);
    let start = 0, newline;
    while ((newline = text.indexOf('\n', start)) >= 0 && recordIndex < total) {
      consumeLine(text.slice(start, newline));
      start = newline + 1;
    }
    carry = recordIndex < total ? text.slice(start) : '';
    if (carry.length > MAX_PLY_ASCII_VERTEX_LINE_BYTES) {
      throw new Error('ASCII PLY vertex line exceeds the 1 MiB safety limit');
    }
    if (onBatch) onBatch(recordIndex);
  }
  if (recordIndex < total && carry.trim()) consumeLine(carry);
  if (recordIndex !== total) {
    throw new Error('truncated ASCII PLY vertex data (' + recordIndex + ' of ' + total + ' records)');
  }
  return recordIndex;
}

// Stage 4 out-of-core ingest for binary PLY point clouds. Pass one determines
// the same source-frame/axis transform used by parsePLYFile; pass two writes a
// compact, centred, float32+RGB canonical file. Peak point-data memory is
// bounded by the read/write chunks instead of sourceCount*XYZ/RGB arrays.
function preparePlyOctreeFile(sourcePath, canonicalPath, maxPoints, onProgress, preferredSourceTransform, expectedSourceInfo) {
  let sourceFd = null, canonicalFd = null;
  try {
    sourceFd = fs.openSync(sourcePath, 'r');
    const sourceStat = fs.fstatSync(sourceFd, { bigint: true });
    if (!sourceStat.isFile()) throw new Error('point-cloud source is not a regular file');
    const sourceSize = Number(sourceStat.size);
    if (!Number.isSafeInteger(sourceSize) || sourceSize < 0) throw new Error('PLY file size exceeds safe limits');
    const meta = readPlyHeader(sourceFd, sourceSize);
    const layout = plyPointFileLayout(meta, sourceSize);
    const sourceInfo = Object.assign(plyBigintStatIdentity(sourceStat), {
      vertexCount: layout.vertexCount,
      recordLength: Number(layout.recordLength) || 0,
      propertyCount: Number(layout.propertyCount) || (layout.properties || []).length,
      dataOffset: meta.dataOffset,
      format: String(meta.format),
      hasIntensity: !!layout.intensity,
      hasClassification: !!layout.classification,
      layoutSignature: plyLayoutSignature(meta, layout)
    });
    if (expectedSourceInfo && !samePlyPointFileInfo(sourceInfo, expectedSourceInfo)) {
      throw new Error('source PLY changed after resource preflight; retry indexing');
    }
    const pathStat = fs.statSync(sourcePath, { bigint: true });
    const pathIdentity = plyBigintStatIdentity(pathStat);
    if (sourceInfo.fileSize !== pathIdentity.fileSize ||
        sourceInfo.mtimeNs !== pathIdentity.mtimeNs ||
        sourceInfo.device !== pathIdentity.device ||
        sourceInfo.inode !== pathIdentity.inode) {
      throw new Error('source PLY changed while opening the index job');
    }
    const vertexCount = layout.vertexCount;
    const budget = Number.isSafeInteger(maxPoints) && maxPoints > 0 ? maxPoints : DEFAULT_MAX_POINTS;
    const sampleStride = vertexCount > budget ? Math.ceil(vertexCount / budget) : 1;
    const selectedCapacity = Math.ceil(vertexCount / sampleStride);
    const axisStep = Math.max(1, Math.ceil(selectedCapacity / 50000));
    const firstSample = [[], [], []];
    let selectedOrdinal = 0, validCount = 0, invalidCount = 0;
    let shX = 0, shY = 0, shZ = 0, haveShift = false;
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    const intensityInfo = layout.intensity;
    let intensityMax = 0;

    progressAt(onProgress, 'scan-start', 0.02, { pointsTotal: vertexCount, mode: 'out-of-core-ply' });
    forEachPlyVertexRecord(sourceFd, sourceSize, meta, layout, (globalIndex, record) => {
      const selected = !core.keepSampledIndex || core.keepSampledIndex(globalIndex, sampleStride);
      const ordinal = selected ? selectedOrdinal++ : -1;
      const x = plyRecordValue(record, layout.x, layout);
      const y = plyRecordValue(record, layout.y, layout);
      const z = plyRecordValue(record, layout.z, layout);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        invalidCount++;
        return;
      }
      if (!selected) return;
      if (!haveShift) { shX = x; shY = y; shZ = z; haveShift = true; }
      // The legacy preview computes bounds from double offsets, stores
      // float32 positions, and uses those stored values only for the robust
      // up-axis sample. Preserve that split so the source transform agrees.
      const rx = x - shX, ry = y - shY, rz = z - shZ;
      if (rx < mnx) mnx = rx; if (ry < mny) mny = ry; if (rz < mnz) mnz = rz;
      if (rx > mxx) mxx = rx; if (ry > mxy) mxy = ry; if (rz > mxz) mxz = rz;
      if (ordinal % axisStep === 0) {
        firstSample[0].push(Math.fround(rx)); firstSample[1].push(Math.fround(ry)); firstSample[2].push(Math.fround(rz));
      }
      if (intensityInfo) {
        const iv = plyRecordValue(record, intensityInfo, layout);
        if (Number.isFinite(iv) && iv > intensityMax) intensityMax = iv;
      }
      validCount++;
    }, (readCount) => {
      progressAt(onProgress, 'scan', 0.02 + 0.28 * readCount / vertexCount,
        { pointsRead: readCount, pointsTotal: vertexCount, validPoints: validCount });
    });
    if (!validCount || !haveShift || !Number.isFinite(mnx + mny + mnz + mxx + mxy + mxz)) {
      throw new Error('PLY has no finite indexed XYZ points');
    }
    const axisRanges = firstSample.map((values) => {
      values.sort((a, b) => a - b);
      return values.length
        ? values[Math.floor((values.length - 1) * 0.995)] - values[Math.floor((values.length - 1) * 0.005)]
        : 0;
    });
    const up = commentUp(meta.comments, core.plyUpAxis
      ? core.plyUpAxis(meta.comments, [shX, shY, shZ], axisRanges)
      : 'y');
    const preferredAxis = preferredSourceTransform &&
      (preferredSourceTransform.axis === 'zup' || preferredSourceTransform.axis === 'yup') &&
      Array.isArray(preferredSourceTransform.t) && preferredSourceTransform.t.length >= 3 &&
      preferredSourceTransform.t.slice(0, 3).every(Number.isFinite)
      ? preferredSourceTransform.axis
      : null;
    // Keep streamed points registered with the already-open preview. Its bbox
    // may come from a sampled subset; recomputing a new origin from every source
    // point would visibly shift a georeferenced cloud when LOD is toggled.
    const zUp = preferredAxis ? preferredAxis === 'zup' : up === 'z';
    const sourceCrsWkt = (core.plyCrsWkt ? core.plyCrsWkt(meta.comments) : null) || commentCrs(meta.comments);
    const units = commentValue(meta.comments, 'units');
    const preferredT = preferredAxis ? preferredSourceTransform.t.slice(0, 3).map(Number) : null;
    const centerX = preferredT ? preferredT[0] - shX : (mnx + mxx) / 2;
    const centerY = preferredT ? preferredT[1] - shY : (mny + mxy) / 2;
    const centerZ = preferredT
      ? preferredT[2] - shZ
      : (zUp ? mnz : (mnz + mxz) / 2);
    const outputBounds = { mn: [Infinity, Infinity, Infinity], mx: [-Infinity, -Infinity, -Infinity] };
    const outputPath = path.resolve(canonicalPath);
    canonicalFd = fs.openSync(outputPath, 'wx', 0o600);
    const hasIntensity = !!layout.intensity;
    const hasClassification = !!layout.classification;
    const recordStride = 15 + (hasIntensity ? 4 : 0) + (hasClassification ? 1 : 0);
    const outputRecords = Math.max(1, Math.floor(CHUNK_BYTES / recordStride));
    const outputBuffer = Buffer.alloc(outputRecords * recordStride);
    let outputPosition = 0, outputCount = 0;
    const rampHeight = zUp ? (mxz - mnz) : (mxy - mny);
    const colorDiv = layout.colorDivisor || 1;
    const intensityDiv = hasIntensity
      ? plyIntensityDiv(layout.intensity.type, intensityMax)
      : 1;

    function clampByte(value) {
      if (!Number.isFinite(value)) return 0;
      return Math.max(0, Math.min(255, Math.round(value * 255)));
    }
    function flushOutput() {
      if (!outputPosition) return;
      let written = 0;
      while (written < outputPosition) {
        const n = fs.writeSync(canonicalFd, outputBuffer, written, outputPosition - written);
        if (!n) throw new Error('short write while creating canonical PLY point store');
        written += n;
      }
      outputPosition = 0;
    }

    progressAt(onProgress, 'convert-start', 0.32, { pointsTotal: vertexCount, pointsSelected: validCount });
    selectedOrdinal = 0;
    forEachPlyVertexRecord(sourceFd, sourceSize, meta, layout, (globalIndex, record) => {
      if (core.keepSampledIndex && !core.keepSampledIndex(globalIndex, sampleStride)) return;
      selectedOrdinal++;
      const x = plyRecordValue(record, layout.x, layout);
      const y = plyRecordValue(record, layout.y, layout);
      const z = plyRecordValue(record, layout.z, layout);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      const rx = x - shX, ry = y - shY, rz = z - shZ;
      const storedX = Math.fround(rx), storedY = Math.fround(ry), storedZ = Math.fround(rz);
      const viewerX = storedX - centerX;
      const viewerY = zUp ? storedZ - centerZ : storedY - centerY;
      const viewerZ = zUp ? -(storedY - centerY) : storedZ - centerZ;
      const xyz = [Math.fround(viewerX), Math.fround(viewerY), Math.fround(viewerZ)];
      for (let a = 0; a < 3; a++) {
        outputBounds.mn[a] = Math.min(outputBounds.mn[a], xyz[a]);
        outputBounds.mx[a] = Math.max(outputBounds.mx[a], xyz[a]);
      }
      const recordOffset = outputPosition;
      outputBuffer.writeFloatLE(xyz[0], recordOffset);
      outputBuffer.writeFloatLE(xyz[1], recordOffset + 4);
      outputBuffer.writeFloatLE(xyz[2], recordOffset + 8);
      if (layout.hasColor) {
        outputBuffer[recordOffset + 12] = clampByte(plyRecordValue(record, layout.color.r, layout) / colorDiv);
        outputBuffer[recordOffset + 13] = clampByte(plyRecordValue(record, layout.color.g, layout) / colorDiv);
        outputBuffer[recordOffset + 14] = clampByte(plyRecordValue(record, layout.color.b, layout) / colorDiv);
      } else {
        const elevation = zUp ? storedZ - mnz : storedY - mny;
        const ramp = core.elevationRamp((elevation / (rampHeight || 1)));
        outputBuffer[recordOffset + 12] = clampByte(ramp[0]);
        outputBuffer[recordOffset + 13] = clampByte(ramp[1]);
        outputBuffer[recordOffset + 14] = clampByte(ramp[2]);
      }
      let attributeOffset = recordOffset + 15;
      if (hasIntensity) {
        const value = plyRecordValue(record, layout.intensity, layout);
        const normalized = Number.isFinite(value)
          ? Math.max(0, Math.min(1, value / (intensityDiv || 1)))
          : 0;
        outputBuffer.writeFloatLE(normalized, attributeOffset);
        attributeOffset += 4;
      }
      if (hasClassification) {
        const value = plyRecordValue(record, layout.classification, layout);
        outputBuffer[attributeOffset++] = Number.isFinite(value)
          ? Math.max(0, Math.min(255, Math.round(value)))
          : 0;
      }
      outputPosition += recordStride;
      outputCount++;
      if (outputPosition === outputBuffer.length) flushOutput();
    }, (readCount) => {
      progressAt(onProgress, 'convert', 0.32 + 0.14 * readCount / vertexCount,
        { pointsRead: readCount, pointsTotal: vertexCount, pointsWritten: outputCount });
    });
    flushOutput();
    if (outputCount !== validCount) throw new Error('canonical PLY count differs from the validated scan');
    const sourceAfter = fs.fstatSync(sourceFd, { bigint: true });
    const pathAfter = fs.statSync(sourcePath, { bigint: true });
    const sourceAfterIdentity = plyBigintStatIdentity(sourceAfter);
    const pathAfterIdentity = plyBigintStatIdentity(pathAfter);
    if (sourceAfterIdentity.fileSize !== sourceInfo.fileSize ||
        sourceAfterIdentity.mtimeNs !== sourceInfo.mtimeNs ||
        sourceAfterIdentity.device !== sourceInfo.device ||
        sourceAfterIdentity.inode !== sourceInfo.inode ||
        pathAfterIdentity.fileSize !== sourceInfo.fileSize ||
        pathAfterIdentity.mtimeNs !== sourceInfo.mtimeNs ||
        pathAfterIdentity.device !== sourceInfo.device ||
        pathAfterIdentity.inode !== sourceInfo.inode) {
      throw new Error('source PLY changed while out-of-core indexing was running');
    }

    const eps = outputBounds.mn.map((mn, i) => Math.max(1e-6, (outputBounds.mx[i] - mn) * 1e-6));
    for (let i = 0; i < 3; i++) outputBounds.mx[i] += eps[i];
    const metaOut = {
      kind: 'points', points: outputCount, total: vertexCount,
      w: mxx - mnx, d: zUp ? (mxy - mny) : (mxz - mnz),
      h: zUp ? (mxz - mnz) : (mxy - mny),
      format: 'PLY cloud (' + (layout.encoding === 'ascii' ? 'ASCII' : 'binary') +
        ', out-of-core ' + (zUp ? 'Z-up' : 'Y-up') + ')',
      colored: layout.hasColor,
      hasIntensity, hasClassification,
      streamAttributeOmissions: [],
      crsWkt: sourceCrsWkt || null, units: units || null,
      offset: zUp
        ? { cx: preferredT ? preferredT[0] : centerX + shX,
          cy: preferredT ? preferredT[1] : centerY + shY,
          mnz: preferredT ? preferredT[2] : mnz + shZ }
        : undefined,
      srcXform: preferredT
        ? { axis: preferredAxis, t: preferredT }
        : zUp
          ? { axis: 'zup', t: [centerX + shX, centerY + shY, mnz + shZ] }
          : { axis: 'yup', t: [centerX + shX, centerY + shY, centerZ + shZ] },
      outOfCore: true, invalidPointCount: invalidCount,
      sampleStride
    };
    progressAt(onProgress, 'convert-done', 0.48,
      { pointsWritten: outputCount, pointsTotal: vertexCount, invalidPoints: invalidCount });
    return {
      ok: true, canonicalPath: outputPath, count: outputCount,
      sourcePointCount: vertexCount, invalidPointCount: invalidCount,
      hasColor: true, meta: metaOut, bbox: outputBounds,
      ingest: layout.encoding + '-ply-two-pass'
    };
  } catch (error) {
    if (canonicalFd !== null) {
      try { fs.closeSync(canonicalFd); } catch (_) {}
      canonicalFd = null;
      try { fs.unlinkSync(canonicalPath); } catch (_) {}
    }
    throw error;
  } finally {
    if (sourceFd !== null) try { fs.closeSync(sourceFd); } catch (_) {}
    if (canonicalFd !== null) try { fs.closeSync(canonicalFd); } catch (_) {}
  }
}

// Backward-compatible binary-only entry point for older callers.
function prepareBinaryPLYOctreeFile(sourcePath, canonicalPath, maxPoints, onProgress, preferredSourceTransform, expectedSourceInfo) {
  const info = getOutOfCorePlyPointFileInfo(sourcePath);
  if (!/^binary_(?:little|big)_endian$/i.test(String(info.format || ''))) {
    throw new Error('source is not a supported binary PLY point cloud');
  }
  return preparePlyOctreeFile(sourcePath, canonicalPath, maxPoints, onProgress,
    preferredSourceTransform, expectedSourceInfo || info);
}

function parsePLYFile(fd, fileSize, maxPoints, onProgress) {
  progressAt(onProgress, 'header', 0.03);
  const meta = readPlyHeader(fd, fileSize);
  const le = meta.format.indexOf('little') >= 0;
  const ascii = meta.format.indexOf('ascii') >= 0;
  const crsWkt = (core.plyCrsWkt ? core.plyCrsWkt(meta.comments) : null) || commentCrs(meta.comments);
  const units = commentValue(meta.comments, 'units');
  const vtx = meta.elements.find((e) => e.name === 'vertex');
  if (!vtx || !vtx.count) throw new Error('в PLY нет вершин');
  // PLY-меш (есть грани) показываем через браузерный парсер (освещённый меш), а не как точки.
  const faceEl = meta.elements.find((e) => e.name === 'face');
  if (faceEl && faceEl.count > 0) return { ok: false, fallback: true, message: 'PLY mesh' };
  const vn = vtx.count;
  const budget = maxPoints > 0 ? maxPoints : DEFAULT_MAX_POINTS;
  const stride = vn > budget ? Math.ceil(vn / budget) : 1;
  let outCap = 0; for (let s = 0; s < vn; s += stride) outCap++;

  const names = vtx.props.map((p) => p.name.toLowerCase());
  const findP = (n) => vtx.props.find((p) => p.name.toLowerCase() === n);
  const rp = findP('red') || findP('r') || findP('diffuse_red');
  const gp = findP('green') || findP('g') || findP('diffuse_green');
  const bp = findP('blue') || findP('b') || findP('diffuse_blue');
  const hasColor = !!(rp && gp && bp);
  const cdiv = hasColor ? plyColorDiv(rp.type) : 1;
  const ip = findP('intensity') || findP('scalar_intensity') || findP('reflectance');
  const cp = findP('classification') || findP('class') || findP('label') || findP('scalar_classification');

  const pos = new Float32Array(outCap * 3);
  const col = new Float32Array(outCap * 3);
  const intensity = ip ? new Float32Array(outCap) : null;
  const classification = cp ? new Uint8Array(outCap) : null;
  let intensityMax = 0;
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  let oi = 0;
  // Global shift (та же причина, что и в LAS): большие мировые координаты в Float32 дают полосы.
  let shX = 0, shY = 0, shZ = 0, haveSh = false;

  if (!ascii) {
    if (vtx.props.some((p) => p.list)) throw new Error('бинарный PLY со списками в вершинах не поддержан для стриминга');
    const offOf = {}; let recLen = 0;
    for (const p of vtx.props) { offOf[p.name] = recLen; recLen += plyTypeSize(p.type); }
    const xO = offOf.x, yO = offOf.y, zO = offOf.z;
    const xT = findP('x').type, yT = findP('y').type, zT = findP('z').type;
    const rO = hasColor ? offOf[rp.name] : 0, gO = hasColor ? offOf[gp.name] : 0, bO = hasColor ? offOf[bp.name] : 0;
    const iO = ip ? offOf[ip.name] : 0, cO = cp ? offOf[cp.name] : 0;
    const recPerChunk = Math.max(1, Math.floor(CHUNK_BYTES / recLen));
    const chunkBytes = recPerChunk * recLen;
    const chunk = Buffer.alloc(chunkBytes);
    let recIndex = 0, filePos = meta.dataOffset;
    while (recIndex < vn && oi < outCap) {
      const want = Math.min(chunkBytes, (vn - recIndex) * recLen);
      const got = fs.readSync(fd, chunk, 0, want, filePos);
      if (got <= 0) break;
      const recs = Math.floor(got / recLen);
      for (let k = 0; k < recs; k++) {
        const gi = recIndex + k;
        if (!core.keepSampledIndex(gi, stride)) continue;
        if (oi >= outCap) break;
        const base = k * recLen;
        const xD = plyRead(chunk, base + xO, xT, le), yD = plyRead(chunk, base + yO, yT, le), zD = plyRead(chunk, base + zO, zT, le);
        if (!haveSh) { shX = xD; shY = yD; shZ = zD; haveSh = true; }
        const x = xD - shX, y = yD - shY, z = zD - shZ;
        pos[oi * 3] = x; pos[oi * 3 + 1] = y; pos[oi * 3 + 2] = z;
        if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
        if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
        if (hasColor) {
          col[oi * 3] = plyRead(chunk, base + rO, rp.type, le) / cdiv;
          col[oi * 3 + 1] = plyRead(chunk, base + gO, gp.type, le) / cdiv;
          col[oi * 3 + 2] = plyRead(chunk, base + bO, bp.type, le) / cdiv;
        }
        if (intensity) { const iv = plyRead(chunk, base + iO, ip.type, le); intensity[oi] = isFinite(iv) ? iv : 0; if (iv > intensityMax) intensityMax = iv; }
        if (classification) { const cv = plyRead(chunk, base + cO, cp.type, le); classification[oi] = isFinite(cv) ? Math.max(0, Math.min(255, Math.round(cv))) : 0; }
        oi++;
      }
      recIndex += recs; filePos += got;
      if (recs === 0) break;
      progressAt(onProgress, 'read', 0.1 + 0.78 * recIndex / vn, { pointsRead: recIndex, pointsTotal: vn });
    }
  } else {
    // ASCII: потоковое чтение строк вершин
    const xi = names.indexOf('x'), yi = names.indexOf('y'), zi = names.indexOf('z');
    const ri = rp ? names.indexOf(rp.name.toLowerCase()) : -1, gi2 = gp ? names.indexOf(gp.name.toLowerCase()) : -1, bi = bp ? names.indexOf(bp.name.toLowerCase()) : -1;
    const ii = ip ? names.indexOf(ip.name.toLowerCase()) : -1, ci = cp ? names.indexOf(cp.name.toLowerCase()) : -1;
    let filePos = meta.dataOffset, leftover = '', vseen = 0;
    const rbuf = Buffer.alloc(CHUNK_BYTES);
    outer: while (vseen < vn) {
      const got = fs.readSync(fd, rbuf, 0, CHUNK_BYTES, filePos);
      if (got <= 0) break;
      filePos += got;
      const text = leftover + rbuf.toString('ascii', 0, got);
      const lastNl = text.lastIndexOf('\n');
      leftover = lastNl >= 0 ? text.slice(lastNl + 1) : text;
      const block = lastNl >= 0 ? text.slice(0, lastNl) : '';
      if (block) {
        const rows = block.split('\n');
        for (let r = 0; r < rows.length; r++) {
          if (vseen >= vn) break outer;
          const line = rows[r].trim();
          if (!line) continue;
          const gcur = vseen; vseen++;
          if (!core.keepSampledIndex(gcur, stride)) continue;
          if (oi >= outCap) continue;
          const tk = line.split(/\s+/);
          const xD = parseFloat(tk[xi]), yD = parseFloat(tk[yi]), zD = parseFloat(tk[zi]);
          if (!haveSh) { shX = xD; shY = yD; shZ = zD; haveSh = true; }
          const x = xD - shX, y = yD - shY, z = zD - shZ;
          pos[oi * 3] = x; pos[oi * 3 + 1] = y; pos[oi * 3 + 2] = z;
          if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
          if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
          if (hasColor) { col[oi * 3] = parseFloat(tk[ri]) / cdiv; col[oi * 3 + 1] = parseFloat(tk[gi2]) / cdiv; col[oi * 3 + 2] = parseFloat(tk[bi]) / cdiv; }
          if (intensity) { const iv = parseFloat(tk[ii]); intensity[oi] = isFinite(iv) ? iv : 0; if (iv > intensityMax) intensityMax = iv; }
          if (classification) { const cv = parseFloat(tk[ci]); classification[oi] = isFinite(cv) ? Math.max(0, Math.min(255, Math.round(cv))) : 0; }
          oi++;
        }
      }
      progressAt(onProgress, 'read', 0.1 + 0.78 * vseen / vn, { pointsRead: vseen, pointsTotal: vn });
      if (got < CHUNK_BYTES) break;
    }
  }

  const outN = oi;
  if (outN === 0) throw new Error('не удалось прочитать точки PLY');
  if (intensity) {
    const div = plyIntensityDiv(ip.type, intensityMax);
    for (let i = 0; i < outN; i++) intensity[i] = Math.max(0, Math.min(1, intensity[i] / (div || 1)));
  }
  const axisStep=Math.max(1,Math.ceil(outN/50000)),axisVals=[[],[],[]];
  for(let i=0;i<outN;i+=axisStep)for(let a=0;a<3;a++)axisVals[a].push(pos[i*3+a]);
  const axisRanges=axisVals.map((a)=>{a.sort((x,y)=>x-y);return a.length?a[Math.floor((a.length-1)*0.995)]-a[Math.floor((a.length-1)*0.005)]:0;});
  const up = commentUp(meta.comments, core.plyUpAxis ? core.plyUpAxis(meta.comments, [shX, shY, shZ], axisRanges) : 'y');
  if (up === 'z') {
    // Z-up (съёмка/CloudCompare/экспорт BIM Twin) -> вьюер Y-up, основание на земле.
    const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
    for (let j = 0; j < outN; j++) {
      const px = pos[j * 3], py = pos[j * 3 + 1], pz = pos[j * 3 + 2];
      pos[j * 3] = px - cx; pos[j * 3 + 1] = pz - mnz; pos[j * 3 + 2] = -(py - cy);
      if (!hasColor) { const c = core.elevationRamp((pz - mnz) / ((mxz - mnz) || 1)); col[j * 3] = c[0]; col[j * 3 + 1] = c[1]; col[j * 3 + 2] = c[2]; }
    }
    progressAt(onProgress, 'finalize', 0.96, { pointsLoaded: outN, pointsTotal: vn });
    return {
      ok: true, kind: 'points', pos: pos.subarray(0, outN * 3).slice(), col: col.subarray(0, outN * 3).slice(),
      intensity: intensity ? intensity.subarray(0, outN).slice() : null,
      classification: classification ? classification.subarray(0, outN).slice() : null, count: outN,
      meta: { kind: 'points', points: outN, total: vn, w: mxx - mnx, d: mxy - mny, h: mxz - mnz, format: 'PLY cloud (Z-up)', colored: hasColor,
        hasIntensity: !!intensity, hasClassification: !!classification, crsWkt: crsWkt || null, units: units || null,
        offset: { cx: cx + shX, cy: cy + shY, mnz: mnz + shZ }, srcXform: { axis: 'zup', t: [cx + shX, cy + shY, mnz + shZ] } }
    };
  }
  // Y-up PLY: центрируем по bbox, рампа по высоте при отсутствии цвета
  const ccx = (mnx + mxx) / 2, ccy = (mny + mxy) / 2, ccz = (mnz + mxz) / 2;
  const W = mxx - mnx, D = mxz - mnz, Hh = mxy - mny;
  for (let j = 0; j < outN; j++) {
    pos[j * 3] -= ccx; pos[j * 3 + 1] -= ccy; pos[j * 3 + 2] -= ccz;
    if (!hasColor) {
      const c = core.elevationRamp((pos[j * 3 + 1] + Hh / 2) / (Hh || 1));
      col[j * 3] = c[0]; col[j * 3 + 1] = c[1]; col[j * 3 + 2] = c[2];
    }
  }
  progressAt(onProgress, 'finalize', 0.96, { pointsLoaded: outN, pointsTotal: vn });
  return {
    ok: true, kind: 'points',
    pos: pos.subarray(0, outN * 3).slice(),
    col: col.subarray(0, outN * 3).slice(),
    intensity: intensity ? intensity.subarray(0, outN).slice() : null,
    classification: classification ? classification.subarray(0, outN).slice() : null,
    count: outN,
    meta: { kind: 'points', points: outN, total: vn, w: W, d: D, h: Hh, format: 'PLY cloud (stream)', colored: hasColor,
      hasIntensity: !!intensity, hasClassification: !!classification, crsWkt: crsWkt || null, units: units || null,
      srcXform: { axis: 'yup', t: [ccx + shX, ccy + shY, ccz + shZ] } }
  };
}

// ============================================================
// Общая финализация облака в мировых координатах (Z-up) -> вьюер Y-up
// ============================================================
function finalizeWorldZup(world, col, count, extra, attributes) {
  const pos = new Float32Array(count * 3);
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = world[i * 3], y = world[i * 3 + 1], z = world[i * 3 + 2];
    if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z; if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
  }
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2, h = mxz - mnz;
  const outCol = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const x = world[i * 3], y = world[i * 3 + 1], z = world[i * 3 + 2];
    pos[i * 3] = x - cx; pos[i * 3 + 1] = z - mnz; pos[i * 3 + 2] = -(y - cy);
    if (col) { outCol[i * 3] = col[i * 3]; outCol[i * 3 + 1] = col[i * 3 + 1]; outCol[i * 3 + 2] = col[i * 3 + 2]; }
    else { const c = core.elevationRamp((z - mnz) / (h || 1)); outCol[i * 3] = c[0]; outCol[i * 3 + 1] = c[1]; outCol[i * 3 + 2] = c[2]; }
  }
  const attrs = attributes || {};
  const intensity = attrs.intensity && attrs.intensity.length >= count ? attrs.intensity.subarray ? attrs.intensity.subarray(0, count) : attrs.intensity.slice(0, count) : null;
  const classification = attrs.classification && attrs.classification.length >= count ? attrs.classification.subarray ? attrs.classification.subarray(0, count) : attrs.classification.slice(0, count) : null;
  return {
    ok: true, kind: 'points', pos, col: outCol, count, intensity, classification,
    meta: Object.assign({ kind: 'points', points: count, w: mxx - mnx, d: mxy - mny, h, colored: !!col,
      hasIntensity: !!intensity, hasClassification: !!classification,
      offset: { cx, cy, mnz }, srcXform: { axis: 'zup', t: [cx, cy, mnz] } }, extra || {})
  };
}

function finalizeWorldCoords(world, col, count, upAxis, extra, attributes) {
  if (upAxis !== 'y') return finalizeWorldZup(world, col, count, extra, attributes);
  const pos = new Float32Array(count * 3);
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = world[i * 3], y = world[i * 3 + 1], z = world[i * 3 + 2];
    if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
    if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
  }
  const t = [(mnx + mxx) / 2, (mny + mxy) / 2, (mnz + mxz) / 2];
  const outCol = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = world[i * 3] - t[0]; pos[i * 3 + 1] = world[i * 3 + 1] - t[1]; pos[i * 3 + 2] = world[i * 3 + 2] - t[2];
    if (col) { outCol[i * 3] = col[i * 3]; outCol[i * 3 + 1] = col[i * 3 + 1]; outCol[i * 3 + 2] = col[i * 3 + 2]; }
    else { const c = core.elevationRamp((world[i * 3 + 1] - mny) / ((mxy - mny) || 1)); outCol[i * 3] = c[0]; outCol[i * 3 + 1] = c[1]; outCol[i * 3 + 2] = c[2]; }
  }
  const attrs = attributes || {};
  const intensity = attrs.intensity && attrs.intensity.length >= count ? attrs.intensity.subarray ? attrs.intensity.subarray(0, count) : attrs.intensity.slice(0, count) : null;
  const classification = attrs.classification && attrs.classification.length >= count ? attrs.classification.subarray ? attrs.classification.subarray(0, count) : attrs.classification.slice(0, count) : null;
  return {
    ok: true, kind: 'points', pos, col: outCol, count, intensity, classification,
    meta: Object.assign({ kind: 'points', points: count, w: mxx - mnx, d: mxz - mnz, h: mxy - mny,
      colored: !!col, hasIntensity: !!intensity, hasClassification: !!classification,
      srcXform: { axis: 'yup', t } }, extra || {})
  };
}

// ============================================================
// E57 (ASTM) — через ./e57-core, чтение страниц с диска
// ============================================================
function parseE57File(fd, fileSize, maxPoints, onProgress) {
  const E57 = require('./e57-core');
  let highWater = 0;
  const readPhys = (o, l) => {
    const b = Buffer.alloc(l), got = fs.readSync(fd, b, 0, l, o);
    highWater = Math.max(highWater, o + got);
    progressAt(onProgress, 'read-e57', 0.05 + 0.88 * highWater / Math.max(1, fileSize), { bytesRead: highWater, bytesTotal: fileSize });
    return new Uint8Array(b.buffer, b.byteOffset, got);
  };
  const r = E57.read(readPhys, fileSize, { maxPoints });
  if (!r.count) throw new Error('в E57 нет корректных точек');
  return finalizeWorldZup(r.pos, r.col, r.count, {
    total: r.total, format: 'E57 (' + r.scans.length + ' скан.)',
    crsWkt: r.crs || null, scans: r.scans.map((s) => ({
      name: s.name, start: s.start, count: s.count,
      recordCount: s.recordCount, pose: s.pose
    }))
  }, { intensity: r.intensity });
}

// ============================================================
// Текстовые XYZ / PTS / TXT / CSV и PCD (ascii / binary / binary_compressed)
// ============================================================
function textTokens(line, ext) {
  const s = String(line || '').replace(/^\uFEFF/, '').trim();
  return ext === 'csv' ? s.split(/[,;\t]+/).map((v) => v.trim()) : s.split(/[\s,;]+/);
}
function textColumnLayout(ext, t, names) {
  const alias = (list) => {
    if (!names) return -1;
    for (const n of list) { const i = names.indexOf(n); if (i >= 0) return i; }
    return -1;
  };
  if (names) {
    return {
      x: alias(['x', 'easting', 'east', 'longitude', 'lon']),
      y: alias(['y', 'northing', 'north', 'latitude', 'lat']),
      z: alias(['z', 'elevation', 'height', 'altitude', 'alt']),
      intensity: alias(['intensity', 'i', 'reflectance', 'return_intensity']),
      r: alias(['red', 'r']), g: alias(['green', 'g']), b: alias(['blue', 'b']),
      classification: alias(['classification', 'class', 'label', 'semantic'])
    };
  }
  const n = t.length;
  if (ext === 'xyzrgb') return { x:0, y:1, z:2, intensity:-1, r:n >= 6 ? 3 : -1, g:n >= 6 ? 4 : -1, b:n >= 6 ? 5 : -1, classification:n >= 7 ? 6 : -1 };
  if (ext === 'pts' || n >= 8) return { x:0, y:1, z:2, intensity:n >= 4 ? 3 : -1, r:n >= 7 ? 4 : -1, g:n >= 7 ? 5 : -1, b:n >= 7 ? 6 : -1, classification:n >= 8 ? 7 : -1 };
  if (n === 7) return { x:0, y:1, z:2, intensity:3, r:4, g:5, b:6, classification:-1 };
  if (n === 6) return { x:0, y:1, z:2, intensity:-1, r:3, g:4, b:5, classification:-1 };
  if (n === 5) return { x:0, y:1, z:2, intensity:3, r:-1, g:-1, b:-1, classification:4 };
  return { x:0, y:1, z:2, intensity:n >= 4 ? 3 : -1, r:-1, g:-1, b:-1, classification:-1 };
}
function parseTextCloudFile(fd, fileSize, maxPoints, ext, onProgress) {
  const CH = 8 * 1024 * 1024, buf = Buffer.alloc(CH), comments = [];
  function eachLine(cb, start, phase, base, span) {
    let pos = start || 0, rest = '';
    while (pos < fileSize) {
      const got = fs.readSync(fd, buf, 0, Math.min(CH, fileSize - pos), pos);
      if (got <= 0) break;
      pos += got;
      const lines = (rest + buf.toString('latin1', 0, got)).split('\n'); rest = lines.pop();
      for (const ln of lines) if (cb(ln) === false) return;
      progressAt(onProgress, phase || 'read', (base || 0) + (span == null ? 0.9 : span) * pos / Math.max(1, fileSize), { bytesRead: pos, bytesTotal: fileSize });
    }
    if (rest) cb(rest);
  }
  const numeric = /^[\s]*[-+]?(?:\d|\.\d)/;
  let total = 0, firstPtsCount = ext === 'pts', ptsCountSkipped = false, names = null, layout = null, cols = 0;
  let intensityMax = 0, colorMax = 0;
  eachLine((raw) => {
    const line = raw.trim();
    if (!line) return;
    if (line[0] === '#') {
      const comment = line.slice(1).trim(); comments.push(comment);
      const cm = /^columns\s*=\s*(.+)$/i.exec(comment);
      if (cm) names = cm[1].trim().split(/[\s,;\t]+/).map((s) => s.toLowerCase());
      return;
    }
    const t = textTokens(line, ext);
    if (!numeric.test(line)) {
      const candidate = t.map((s) => s.toLowerCase());
      if (candidate.includes('x') && (candidate.includes('y') || candidate.includes('northing')) && (candidate.includes('z') || candidate.includes('elevation'))) names = candidate;
      return;
    }
    if (firstPtsCount && !ptsCountSkipped && t.length === 1) { ptsCountSkipped = true; return; }
    firstPtsCount = false;
    if (t.length < 3) return;
    if (!layout) { cols = t.length; layout = textColumnLayout(ext, t, names); }
    total++;
    const ii = layout.intensity;
    if (ii >= 0 && ii < t.length) { const v = Number(t[ii]); if (isFinite(v) && v > intensityMax) intensityMax = v; }
    const ci = [layout.r, layout.g, layout.b];
    for (const c of ci) if (c >= 0 && c < t.length) { const v = Number(t[c]); if (isFinite(v) && v > colorMax) colorMax = v; }
  }, 0, 'index-text', 0, 0.44);
  if (!total || !layout) throw new Error('в файле нет строк с координатами X Y Z');
  if (layout.x < 0 || layout.y < 0 || layout.z < 0 || layout.x >= cols || layout.y >= cols || layout.z >= cols) throw new Error('в текстовом облаке отсутствуют колонки X/Y/Z');
  const budget = maxPoints > 0 ? maxPoints : DEFAULT_MAX_POINTS, stride = total > budget ? Math.ceil(total / budget) : 1;
  const cap = Math.ceil(total / stride);
  const hasColor = layout.r >= 0 && layout.g >= 0 && layout.b >= 0;
  const hasIntensity = layout.intensity >= 0, hasClassification = layout.classification >= 0;
  const world = new Float64Array(cap * 3), col = hasColor ? new Float32Array(cap * 3) : null;
  const intensity = hasIntensity ? new Float32Array(cap) : null, classification = hasClassification ? new Uint8Array(cap) : null;
  const colorDiv = colorMax > 255 ? 65535 : colorMax > 1.0001 ? 255 : 1;
  const intensityDiv = intensityMax > 1.0001 ? intensityMax : 1;
  let li = 0, oi = 0, ptsSkip = ext === 'pts' && !ptsCountSkipped;
  eachLine((raw) => {
    const line = raw.trim();
    if (!line || line[0] === '#') return;
    const t = textTokens(line, ext);
    if (!numeric.test(line)) {
      const candidate = t.map((s) => s.toLowerCase());
      if (candidate.includes('x') && (candidate.includes('y') || candidate.includes('northing')) && (candidate.includes('z') || candidate.includes('elevation'))) return;
      return;
    }
    if (ptsSkip && t.length === 1) { ptsSkip = false; return; }
    ptsSkip = false;
    if (t.length < 3) return;
    const gi = li++;
    if (core.keepSampledIndex ? !core.keepSampledIndex(gi, stride) : (gi % stride !== 0)) return;
    if (oi >= cap) return;
    const x = Number(t[layout.x]), y = Number(t[layout.y]), z = Number(t[layout.z]);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return;
    world[oi * 3] = x; world[oi * 3 + 1] = y; world[oi * 3 + 2] = z;
    if (col) {
      const r = Number(t[layout.r]), g = Number(t[layout.g]), b = Number(t[layout.b]);
      col[oi * 3] = Math.max(0, Math.min(1, (isFinite(r) ? r : 0) / colorDiv));
      col[oi * 3 + 1] = Math.max(0, Math.min(1, (isFinite(g) ? g : 0) / colorDiv));
      col[oi * 3 + 2] = Math.max(0, Math.min(1, (isFinite(b) ? b : 0) / colorDiv));
    }
    if (intensity) { const v = Number(t[layout.intensity]); intensity[oi] = isFinite(v) ? Math.max(0, Math.min(1, v / intensityDiv)) : 0; }
    if (classification) { const v = Number(t[layout.classification]); classification[oi] = isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 0; }
    oi++;
  }, 0, 'sample-text', 0.45, 0.44);
  if (!oi) throw new Error('не удалось прочитать точки текстового облака');
  const up = commentUp(comments, 'z');
  const crs = commentCrs(comments);
  const units = commentValue(comments, 'units');
  progressAt(onProgress, 'finalize', 0.96, { pointsLoaded: oi, pointsTotal: total });
  return finalizeWorldCoords(world.subarray(0, oi * 3), col ? col.subarray(0, oi * 3) : null, oi, up, {
    total, format: ext.toUpperCase() + ' (текст)', colored: hasColor, hasIntensity, hasClassification,
    crsWkt: crs || null, units: units || null, intensityScale: intensityMax > 1.0001 ? intensityMax : 1
  }, { intensity: intensity ? intensity.subarray(0, oi) : null, classification: classification ? classification.subarray(0, oi) : null });
}

function ptxRigidPose(scan) {
  const m = scan && scan.matrix;
  if (!Array.isArray(m) || m.length < 16 || !m.slice(0, 16).every(Number.isFinite)) return null;
  const rowVector = scan.convention === 'row-vector';
  const R = rowVector
    ? [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]
    : [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const T = rowVector ? [m[12], m[13], m[14]] : [m[3], m[7], m[11]];
  if (!T.every(Number.isFinite)) return null;
  const rows = [R.slice(0, 3), R.slice(3, 6), R.slice(6, 9)];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (rows.some(row => Math.abs(dot3(row, row) - 1) > 1e-5) ||
      Math.abs(dot3(rows[0], rows[1])) > 1e-5 ||
      Math.abs(dot3(rows[0], rows[2])) > 1e-5 ||
      Math.abs(dot3(rows[1], rows[2])) > 1e-5) return null;
  const det = R[0] * (R[4] * R[8] - R[5] * R[7]) -
    R[1] * (R[3] * R[8] - R[5] * R[6]) +
    R[2] * (R[3] * R[7] - R[4] * R[6]);
  if (Math.abs(det - 1) > 1e-5) return null;
  return { R, T };
}

// Leica PTX is a sequence of scans. Each header contains dimensions, scanner
// origin/axes and a 4x4 transform; the point grid is followed by the next scan.
// Stream twice: first validate/index scans and attributes, then allocate only
// the deterministic point-budget sample and apply each scan's pose.
function parsePTXFile(fd, fileSize, maxPoints, onProgress) {
  const CH = CHUNK_BYTES, buf = Buffer.alloc(CH);
  const progress = typeof onProgress === 'function' ? onProgress : null;
  function parseHeader(lines, scanIndex) {
    const integerLine = (s, label) => {
      const n = Number(String(s).trim());
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error('PTX: invalid ' + label + ' in scan ' + (scanIndex + 1));
      return n;
    };
    const columns = integerLine(lines[0], 'columns'), rows = integerLine(lines[1], 'rows');
    const records = columns * rows;
    if (!Number.isSafeInteger(records) || records > Math.floor(fileSize / 6) + 1) {
      throw new Error('PTX: declared grid size exceeds the file-size safety bound in scan ' + (scanIndex + 1));
    }
    const vector = (line, expected, label) => {
      const values = String(line).trim().split(/[\s,;]+/).map(Number);
      if (values.length < expected || values.slice(0, expected).some(v => !Number.isFinite(v))) {
        throw new Error('PTX: invalid ' + label + ' in scan ' + (scanIndex + 1));
      }
      return values.slice(0, expected);
    };
    const scannerPosition = vector(lines[2], 3, 'scanner position');
    const axes = [vector(lines[3], 3, 'X axis'), vector(lines[4], 3, 'Y axis'), vector(lines[5], 3, 'Z axis')];
    const matrix = [];
    for (let i = 6; i < 10; i++) matrix.push(...vector(lines[i], 4, 'transform matrix'));
    // Leica PTX convention stores translation in the last row and uses row
    // vectors. Accept the common affine column-vector variant too.
    const eps = 1e-8;
    const lastColumnAffine = Math.abs(matrix[3]) < eps && Math.abs(matrix[7]) < eps &&
      Math.abs(matrix[11]) < eps && Math.abs(matrix[15] - 1) < eps;
    const lastRowAffine = Math.abs(matrix[12]) < eps && Math.abs(matrix[13]) < eps &&
      Math.abs(matrix[14]) < eps && Math.abs(matrix[15] - 1) < eps;
    const convention = lastColumnAffine ? 'row-vector' : lastRowAffine ? 'column-vector' : 'row-vector';
    return {
      index: scanIndex, columns, rows, pointRecords: records, validPoints: 0,
      scannerPosition, axes, matrix, convention
    };
  }
  function transform(scan, x, y, z) {
    const m = scan.matrix;
    if (scan.convention === 'column-vector') {
      return [m[0] * x + m[1] * y + m[2] * z + m[3],
        m[4] * x + m[5] * y + m[6] * z + m[7],
        m[8] * x + m[9] * y + m[10] * z + m[11]];
    }
    return [m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14]];
  }
  function walk(onScan, onPoint, pass) {
    let pos = 0, rest = '', header = [], scan = null, remaining = 0, scanIndex = 0, recordIndex = 0;
    function consume(raw) {
      const line = String(raw).trim();
      if (!line) return;
      if (remaining > 0) {
        const t = line.split(/[\s,;]+/), x = Number(t[0]), y = Number(t[1]), z = Number(t[2]);
        if (t.length < 3) throw new Error('PTX: malformed point record ' + (recordIndex + 1));
        if (![x, y, z].every(Number.isFinite)) throw new Error('PTX: non-finite XYZ in record ' + (recordIndex + 1));
        const record = { x, y, z, intensity: t.length >= 4 ? Number(t[3]) : 0,
          r: t.length >= 7 ? Number(t[4]) : 0, g: t.length >= 7 ? Number(t[5]) : 0, b: t.length >= 7 ? Number(t[6]) : 0,
          hasIntensity: t.length >= 4, hasColor: t.length >= 7 };
        if (record.hasIntensity && !Number.isFinite(record.intensity)) record.intensity = 0;
        for (const key of ['r', 'g', 'b']) if (!Number.isFinite(record[key])) record[key] = 0;
        const missing = x === 0 && y === 0 && z === 0;
        if (!missing) {
          const xyz = transform(scan, x, y, z);
          if (xyz.every(Number.isFinite)) onPoint(scan, record, xyz, recordIndex);
        }
        scan.pointRecordsSeen++;
        if (remaining === 1) scan = null;
        remaining--;
        recordIndex++;
        return;
      }
      header.push(line);
      if (header.length === 10) {
        scan = parseHeader(header, scanIndex++);
        scan.pointRecordsSeen = 0;
        remaining = scan.pointRecords;
        onScan(scan);
        header = [];
        if (!remaining) scan = null;
      }
    }
    while (pos < fileSize) {
      const want = Math.min(CH, fileSize - pos), got = fs.readSync(fd, buf, 0, want, pos);
      if (got <= 0) break;
      pos += got;
      const parts = (rest + buf.toString('latin1', 0, got)).split('\n');
      rest = parts.pop();
      for (const line of parts) consume(line);
      if (progress) progress({
        phase: 'ptx-' + pass,
        fraction: pass === 'index'
          ? 0.42 * pos / Math.max(1, fileSize)
          : 0.42 + 0.52 * pos / Math.max(1, fileSize),
        bytesRead: pos, bytesTotal: fileSize
      });
    }
    if (rest) consume(rest);
    if (remaining > 0) throw new Error('PTX: truncated point grid; ' + remaining + ' records missing in scan ' + (scan ? scan.index + 1 : scanIndex));
    if (header.length) throw new Error('PTX: truncated scan header (' + header.length + '/10 lines)');
    if (!scanIndex) throw new Error('PTX: no scan blocks found');
    return { scanCount: scanIndex, recordCount: recordIndex };
  }

  let validCount = 0, hasIntensity = false, hasColor = false, intensityMax = 0, colorMax = 0;
  const indexScans = [];
  const first = walk(scan => indexScans.push(scan), (scan, rec) => {
    scan.validPoints++;
    validCount++;
    if (rec.hasIntensity) { hasIntensity = true; if (rec.intensity > intensityMax) intensityMax = rec.intensity; }
    if (rec.hasColor) {
      hasColor = true;
      colorMax = Math.max(colorMax, rec.r, rec.g, rec.b);
    }
  }, 'index');
  if (!validCount) throw new Error('PTX: no valid returns (all points are missing)');
  const budget = maxPoints > 0 ? maxPoints : DEFAULT_MAX_POINTS;
  const stride = validCount > budget ? Math.ceil(validCount / budget) : 1;
  const cap = Math.ceil(validCount / stride);
  const world = new Float64Array(cap * 3), col = hasColor ? new Float32Array(cap * 3) : null;
  const intensity = hasIntensity ? new Float32Array(cap) : null;
  const colorDiv = colorMax > 255 ? 65535 : colorMax > 1.0001 ? 255 : 1;
  const intensityDiv = intensityMax > 1.0001 ? intensityMax : 1;
  let validIndex = 0, out = 0;
  const sampledScanRanges = new Map();
  const second = walk(scan => {
    sampledScanRanges.set(scan.index, { start: out, count: 0 });
  }, (scan, rec, xyz) => {
    const sample = validIndex++;
    if (sample % stride !== 0 || out >= cap) return;
    world[out * 3] = xyz[0]; world[out * 3 + 1] = xyz[1]; world[out * 3 + 2] = xyz[2];
    if (col) {
      col[out * 3] = Math.max(0, Math.min(1, rec.r / colorDiv));
      col[out * 3 + 1] = Math.max(0, Math.min(1, rec.g / colorDiv));
      col[out * 3 + 2] = Math.max(0, Math.min(1, rec.b / colorDiv));
    }
    if (intensity) intensity[out] = Math.max(0, Math.min(1, rec.intensity / intensityDiv));
    const sampledRange = sampledScanRanges.get(scan.index);
    if (sampledRange) sampledRange.count++;
    out++;
  }, 'sample');
  if (out !== cap || second.recordCount !== first.recordCount) throw new Error('PTX: source changed between streaming passes');
  const scans = indexScans.map(s => ({
    index: s.index, columns: s.columns, rows: s.rows, pointRecords: s.pointRecords,
    validPoints: s.validPoints, scannerPosition: s.scannerPosition, axes: s.axes,
    transform: s.matrix, matrixConvention: s.convention,
    start: (sampledScanRanges.get(s.index) || { start: 0 }).start,
    count: (sampledScanRanges.get(s.index) || { count: 0 }).count,
    name: 'PTX Scan ' + (s.index + 1),
    pose: ptxRigidPose(s)
  }));
  return finalizeWorldZup(world, col, out, {
    total: validCount, recordCount: first.recordCount, scanCount: first.scanCount,
    format: 'PTX (' + first.scanCount + ' scan' + (first.scanCount === 1 ? '' : 's') + ')',
    scans, crsWkt: null, units: null, hasIntensity, hasClassification: false,
    decimation: stride, intensityScale: intensityDiv
  }, { intensity });
}

function parsePCDFile(fd, fileSize, maxPoints, onProgress, scratchBaseDir) {
  progressAt(onProgress, 'header', 0.03);
  const headerCap = Math.min(fileSize, 1024 * 1024), hb = Buffer.alloc(headerCap);
  fs.readSync(fd, hb, 0, hb.length, 0);
  const txt = hb.toString('latin1'), dm = /^DATA\s+([^\r\n]+)\r?\n/im.exec(txt);
  if (!dm) throw new Error('PCD: нет строки DATA');
  const headerText = txt.slice(0, dm.index), H = {}, comments = [];
  headerText.split(/\r?\n/).forEach((line) => {
    const s = line.trim();
    if (!s) return;
    if (s[0] === '#') { comments.push(s.slice(1).trim()); return; }
    const t = s.split(/\s+/); if (t[0]) H[t[0].toUpperCase()] = t.slice(1);
  });
  const fields = (H.FIELDS || H.FIELD || []).map((v) => v.toLowerCase()), size = (H.SIZE || []).map(Number);
  const type = (H.TYPE || []).map((v) => String(v).toUpperCase()), counts = (H.COUNT || fields.map(() => '1')).map(Number);
  if (!fields.length || fields.length !== size.length || fields.length !== type.length || fields.length !== counts.length) throw new Error('PCD: повреждены FIELDS/SIZE/TYPE/COUNT');
  if (new Set(fields).size !== fields.length) throw new Error('PCD: повторяющиеся имена полей не поддерживаются');
  const width = Number((H.WIDTH || [0])[0]) || 0, height = Number((H.HEIGHT || [1])[0]) || 1;
  const n = Number((H.POINTS || [0])[0]) || width * height;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('PCD: некорректный POINTS/WIDTH');
  if (fields.some((_, i) => ![1,2,4,8].includes(size[i]) || !['F','U','I'].includes(type[i]) ||
    (type[i] === 'F' && size[i] !== 4 && size[i] !== 8) ||
    !Number.isSafeInteger(counts[i]) || counts[i] < 1 || counts[i] > 1024)) throw new Error('PCD: неподдерживаемый тип/размер поля');
  const mode = dm[1].trim().toLowerCase(), dataOff = dm.index + dm[0].length;
  const fieldOffsets = [], tokenOffsets = [], fieldBytes = []; let rec = 0, token = 0, planarBytes = 0;
  fields.forEach((_, i) => {
    fieldOffsets.push(rec); tokenOffsets.push(token);
    const bytes = size[i] * counts[i]; fieldBytes.push(bytes); rec += bytes; token += counts[i]; planarBytes += bytes * n;
  });
  if (!Number.isSafeInteger(rec) || rec <= 0 || !Number.isSafeInteger(planarBytes)) throw new Error('PCD: размер данных превышает безопасный диапазон');
  const idx = (...aliases) => { for (const a of aliases) { const i = fields.indexOf(a); if (i >= 0) return i; } return -1; };
  const ix = idx('x'), iy = idx('y'), iz = idx('z'), irgb = idx('rgb','rgba');
  const ii = idx('intensity','i','reflectance'), ic = idx('classification','class','label','semantic');
  const ir = idx('r','red'), ig = idx('g','green'), ib = idx('b','blue');
  if (ix < 0 || iy < 0 || iz < 0) throw new Error('PCD: нет полей x y z');
  for (const i of [ix,iy,iz,ii,ic,irgb,ir,ig,ib]) if (i >= 0 && counts[i] !== 1 && i !== irgb) throw new Error('PCD: многокомпонентные координаты/скаляры не поддержаны');
  const budget = maxPoints > 0 ? maxPoints : DEFAULT_MAX_POINTS, stride = n > budget ? Math.ceil(n / budget) : 1, cap = Math.ceil(n / stride);
  const previewMemory = ResourceBudget.assessCloudPreviewMemory(cap, currentAvailableMemoryBytes());
  if (!previewMemory.ok) {
    throw new Error('PCD: недостаточно доступной оперативной памяти для предпросмотра — ' +
      'оценка ' + ResourceBudget.formatMiB(previewMemory.estimatedBytes) +
      ', безопасный бюджет ' + ResourceBudget.formatMiB(previewMemory.safeBudgetBytes) +
      ' при доступно ' + ResourceBudget.formatMiB(previewMemory.availableBytes) +
      '. Уменьшите плотность облака или закройте другие приложения.');
  }
  const world = new Float64Array(cap * 3), col = (irgb >= 0 || (ir >= 0 && ig >= 0 && ib >= 0)) ? new Float32Array(cap * 3) : null;
  const intensity = ii >= 0 ? new Float32Array(cap) : null, classification = ic >= 0 ? new Uint8Array(cap) : null;
  function pcdMaxFor(i) {
    if (i < 0) return 1;
    if (type[i] === 'F') return 1;
    if (type[i] === 'U') return size[i] === 1 ? 255 : size[i] === 2 ? 65535 : size[i] === 4 ? 4294967295 : Number.MAX_SAFE_INTEGER;
    return size[i] === 1 ? 127 : size[i] === 2 ? 32767 : size[i] === 4 ? 2147483647 : Number.MAX_SAFE_INTEGER;
  }
  function scalar(data, off, i) {
    const s = size[i], t = type[i];
    if (t === 'F') return s === 8 ? data.readDoubleLE(off) : s === 4 ? data.readFloatLE(off) : NaN;
    if (t === 'U') return s === 1 ? data.readUInt8(off) : s === 2 ? data.readUInt16LE(off) : s === 4 ? data.readUInt32LE(off) : data.readBigUInt64LE(off);
    return s === 1 ? data.readInt8(off) : s === 2 ? data.readInt16LE(off) : s === 4 ? data.readInt32LE(off) : data.readBigInt64LE(off);
  }
  function numberValue(v) { return typeof v === 'bigint' ? Number(v) : v; }
  function packedAscii(value, fieldType, fieldSize) {
    const v = Number(value);
    if (!isFinite(v)) return 0;
    if (fieldType === 'F' && fieldSize === 4 && !Number.isInteger(v)) { const b = Buffer.allocUnsafe(4); b.writeFloatLE(v,0); return b.readUInt32LE(0); }
    return (Math.trunc(v) >>> 0);
  }
  let oi = 0, intensityRawMax = 0, asciiRows = null;
  function emit(i, read, readPacked) {
    const x = numberValue(read(ix)), y = numberValue(read(iy)), z = numberValue(read(iz));
    if (!isFinite(x) || !isFinite(y) || !isFinite(z) || oi >= cap) return;
    world[oi * 3] = x; world[oi * 3 + 1] = y; world[oi * 3 + 2] = z;
    if (col) {
      if (irgb >= 0) {
        const u = readPacked(irgb) >>> 0;
        col[oi*3] = ((u >>> 16) & 255) / 255; col[oi*3+1] = ((u >>> 8) & 255) / 255; col[oi*3+2] = (u & 255) / 255;
      } else {
        const div = Math.max(pcdMaxFor(ir), pcdMaxFor(ig), pcdMaxFor(ib));
        col[oi*3] = Math.max(0, Math.min(1, numberValue(read(ir)) / div));
        col[oi*3+1] = Math.max(0, Math.min(1, numberValue(read(ig)) / div));
        col[oi*3+2] = Math.max(0, Math.min(1, numberValue(read(ib)) / div));
      }
    }
    if (intensity) { const v = numberValue(read(ii)); intensity[oi] = isFinite(v) ? v : 0; if (v > intensityRawMax) intensityRawMax = v; }
    if (classification) { const v = numberValue(read(ic)); classification[oi] = isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 0; }
    oi++;
  }
  if (mode === 'ascii') {
    const CH = 8 * 1024 * 1024, buf = Buffer.alloc(CH); let filePos = dataOff, rest = '', seen = 0;
    while (filePos < fileSize && seen < n) {
      const got = fs.readSync(fd, buf, 0, Math.min(CH, fileSize - filePos), filePos); if (got <= 0) break; filePos += got;
      const lines = (rest + buf.toString('latin1', 0, got)).split('\n'); rest = lines.pop();
      for (const raw of lines) {
        const s = raw.trim(); if (!s || s[0] === '#') continue;
        const vals = s.split(/\s+/); const gi = seen++;
        if (gi >= n) break;
        if ((core.keepSampledIndex ? !core.keepSampledIndex(gi, stride) : gi % stride !== 0)) continue;
        const read = (fi) => fi < 0 ? NaN : Number(vals[tokenOffsets[fi]]);
        const readPacked = (fi) => packedAscii(vals[tokenOffsets[fi]], type[fi], size[fi]);
        emit(gi, read, readPacked);
      }
      progressAt(onProgress, 'read-ascii', 0.08 + 0.84 * (filePos - dataOff) / Math.max(1, fileSize - dataOff), { pointsRead: seen, pointsTotal: n });
    }
    if (rest.trim() && seen < n) {
      const vals = rest.trim().split(/\s+/), gi = seen++;
      if (gi < n && (core.keepSampledIndex ? core.keepSampledIndex(gi, stride) : gi % stride === 0)) {
        emit(gi, (fi) => fi < 0 ? NaN : Number(vals[tokenOffsets[fi]]), (fi) => packedAscii(vals[tokenOffsets[fi]], type[fi], size[fi]));
      }
    }
    asciiRows = seen;
  } else if (mode === 'binary') {
    if (dataOff + n * rec > fileSize) throw new Error('PCD: truncated binary payload');
    const per = Math.max(1, Math.floor((4 * 1024 * 1024) / rec)), chunk = Buffer.alloc(per * rec);
    let decoded = 0;
    for (let i0 = 0; i0 < n; i0 += per) {
      const k = Math.min(per, n - i0), got = fs.readSync(fd, chunk, 0, k * rec, dataOff + i0 * rec), rows = Math.floor(got / rec);
      decoded += rows;
      for (let j = 0; j < rows; j++) {
        const gi = i0 + j; if (core.keepSampledIndex ? !core.keepSampledIndex(gi, stride) : gi % stride !== 0) continue;
        const base = j * rec;
        emit(gi, (fi) => scalar(chunk, base + fieldOffsets[fi], fi),
          (fi) => size[fi] === 4 ? chunk.readUInt32LE(base + fieldOffsets[fi]) : numberValue(scalar(chunk, base + fieldOffsets[fi], fi)));
      }
      progressAt(onProgress, 'read-binary', 0.08 + 0.84 * decoded / n, { pointsRead: decoded, pointsTotal: n });
      if (rows < k) break;
    }
    if (decoded !== n) throw new Error('PCD: truncated binary payload');
  } else if (mode === 'binary_compressed') {
    const scratchRoot = scratchBaseDir || os.tmpdir();
    PcdOutOfCore.withPcdLzfPlanarStore(fd, fileSize, scratchRoot, value => {
      const localFraction = Number(value && value.fraction);
      const fraction = 0.08 + 0.54 * Math.max(0, Math.min(1, localFraction / 0.18));
      progressAt(onProgress, 'pcd-lzf-decompress', fraction, {
        bytesRead: value && value.bytesRead,
        bytesTotal: value && value.bytesTotal,
        bytesWritten: value && value.bytesWritten,
        bytesExpected: value && value.bytesExpected
      });
    }, (header, planarFd) => {
      if (header.pointCount !== n || header.pointBytes !== planarBytes ||
          header.fields.length !== fields.length ||
          header.fields.some((field, i) => field !== fields[i] || header.sizes[i] !== size[i] ||
            header.types[i] !== type[i] || header.counts[i] !== counts[i])) {
        throw new Error('PCD: header changed between preview parsing passes');
      }
      PcdOutOfCore.forEachPcdRecord(fd, fileSize, header, (gi, read, readPacked) => {
        if (core.keepSampledIndex ? !core.keepSampledIndex(gi, stride) : gi % stride !== 0) return;
        emit(gi, read, readPacked);
      }, pointsRead => {
        progressAt(onProgress, 'pcd-lzf-sample',
          0.64 + 0.28 * pointsRead / Math.max(1, n),
          { pointsRead, pointsTotal: n });
      }, null, null, null, planarFd, [ii, ic]);
    });
  } else throw new Error('PCD: DATA ' + mode + ' не поддерживается');
  if (mode === 'ascii' && asciiRows !== n) throw new Error('PCD: truncated ASCII payload (' + asciiRows + ' of ' + n + ' points)');
  if (!oi) throw new Error('PCD: не удалось прочитать точки');
  if (intensity) {
    const div = type[ii] === 'F' ? (intensityRawMax > 1.0001 ? intensityRawMax : 1) : pcdMaxFor(ii);
    for (let i = 0; i < oi; i++) intensity[i] = Math.max(0, Math.min(1, intensity[i] / (div || 1)));
  }
  const up = commentUp(comments, 'z'), crs = commentCrs(comments), units = commentValue(comments, 'units');
  const viewpoint = H.VIEWPOINT ? H.VIEWPOINT.map(Number) : null;
  progressAt(onProgress, 'finalize', 0.96, { pointsLoaded: oi, pointsTotal: n });
  return finalizeWorldCoords(world.subarray(0, oi * 3), col ? col.subarray(0, oi * 3) : null, oi, up, {
    total: n, format: 'PCD ' + mode, colored: !!col, hasIntensity: !!intensity, hasClassification: !!classification,
    crsWkt: crs || null, units: units || null, viewpoint
  }, { intensity: intensity ? intensity.subarray(0, oi) : null, classification: classification ? classification.subarray(0, oi) : null });
}

// LAZ decompression uses the bundled laz-rs WASM. Initialize it from a local
// file instead of letting the loader fetch WASM from the network at runtime.
let _lazLoaderPromise = null;
function getLazRsLoader() {
  if (!_lazLoaderPromise) {
    _lazLoaderPromise = (async function () {
      const cjsEntry = require.resolve('@loaders.gl/las');
      const distDir = path.dirname(cjsEntry);
      const wasmJs = path.join(distDir, 'libs', 'laz-rs-wasm', 'laz_rs_wasm.js');
      const wasmBin = path.join(distDir, 'libs', 'laz-rs-wasm', 'laz_rs_wasm_bg.wasm');
      const wasmApi = await import(pathToFileURL(wasmJs).href);
      wasmApi.initSync({ module: fs.readFileSync(wasmBin) });
      const loaders = await import('@loaders.gl/las');
      if (!loaders.LAZRsLoader || typeof loaders.LAZRsLoader.parse !== 'function') throw new Error('LAZ-RS decoder missing');
      return loaders.LAZRsLoader;
    })().catch(function (e) { _lazLoaderPromise = null; throw e; });
  }
  return _lazLoaderPromise;
}

async function parseLAZFile(absPath, opts) {
  opts = opts || {};
  const st = fs.statSync(absPath);
  progressAt(opts.onProgress, 'header', 0.02, { bytesTotal: st.size });
  if (!st.isFile() || st.size < 227) throw new Error('повреждённый LAZ-файл');
  // LAS/LAZ readers keep the compressed bytes while emitting sampled points.
  // Refuse inputs that cannot fit safely into a Node Buffer instead of risking OOM.
  if (st.size > 0x7fffffff) throw new Error('LAZ больше 2 ГБ: потоковый декодер для такого файла не поддерживается');
  const fd = fs.openSync(absPath, 'r');
  let head, crsWkt = null;
  try {
    head = Buffer.alloc(400);
    const got = fs.readSync(fd, head, 0, Math.min(head.length, st.size), 0);
    if (got < 227) throw new Error('короткий заголовок LAZ');
    const H = core.parseLasHeader({
      u8: (o) => head.readUInt8(o), u16: (o) => head.readUInt16LE(o), u32: (o) => head.readUInt32LE(o),
      i32: (o) => head.readInt32LE(o), f64: (o) => head.readDoubleLE(o), big64: (o) => Number(head.readBigUInt64LE(o)),
    });
    if (head[25] >= 4 && head.length >= 375) {
      const extended = Number(head.readBigUInt64LE(247));
      if (extended > 0) H.count = extended;
    }
    if (!H.count || !Number.isSafeInteger(H.count)) throw new Error('в LAZ нет точек или число точек превышает безопасный предел');
    crsWkt = readLasCrsWkt(fd, st.size, head);
    const budget = Math.max(200000, Number(opts.maxPoints) || DEFAULT_MAX_POINTS);
    const skip = H.count > budget ? Math.ceil(H.count / budget) : 1;
    const bytes = await fs.promises.readFile(absPath);
    progressAt(opts.onProgress, 'read-compressed', 0.16, { bytesRead: bytes.length, bytesTotal: st.size });
    const input = (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    let mesh;
    try {
      progressAt(opts.onProgress, 'decode-laz', 0.18, { pointsTotal: H.count });
      const loader = await getLazRsLoader();
      mesh = await loader.parse(input, { las: { fp64: true, skip: skip, colorDepth: 'auto' } });
    } catch (primaryError) {
      // The laz-perf CJS decoder is a compatibility fallback for legacy LAZ
      // 1.2/1.3 packages that cannot load the WASM module from an ASAR archive.
      if (H.verMinor < 4) {
        try {
          const fallback = require('@loaders.gl/las').LAZPerfLoader;
          mesh = fallback.parseSync(input, { las: { fp64: true, skip: skip, colorDepth: 'auto' } });
        } catch (fallbackError) {
          throw new Error('не удалось распаковать LAZ ' + H.verMinor + ': ' + String(primaryError.message || primaryError) + '; fallback: ' + String(fallbackError.message || fallbackError));
        }
      } else {
        throw new Error('не удалось распаковать LAZ 1.4: ' + String(primaryError.message || primaryError));
      }
    }
    const attrs = mesh && mesh.attributes || {};
    const positions = attrs.POSITION && attrs.POSITION.value;
    const count = Math.min(Number(mesh && mesh.header && mesh.header.vertexCount) || 0, positions ? Math.floor(positions.length / 3) : 0);
    if (!positions || !count) throw new Error('декодер LAZ не вернул точки');
    progressAt(opts.onProgress, 'decoded-laz', 0.86, { pointsLoaded: count, pointsTotal: H.count });
    const rgba = attrs.COLOR_0 && attrs.COLOR_0.value;
    const rawIntensity = attrs.intensity && attrs.intensity.value;
    const rawClassification = attrs.classification && attrs.classification.value;
    let col = null;
    if (rgba && rgba.length >= count * 4) {
      col = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        col[i * 3] = rgba[i * 4] / 255;
        col[i * 3 + 1] = rgba[i * 4 + 1] / 255;
        col[i * 3 + 2] = rgba[i * 4 + 2] / 255;
      }
    }
    const intensity = rawIntensity && rawIntensity.length >= count ? new Float32Array(count) : null;
    if (intensity) for (let i = 0; i < count; i++) intensity[i] = Math.max(0, Math.min(1, Number(rawIntensity[i]) / 65535));
    const classification = rawClassification && rawClassification.length >= count ? Uint8Array.from(rawClassification.subarray ? rawClassification.subarray(0, count) : Array.prototype.slice.call(rawClassification, 0, count)) : null;
    const result = finalizeWorldZup(positions, col, count, {
      total: H.count, format: 'LAZ 1.' + H.verMinor + ' fmt ' + H.fmt, colored: !!col, crsWkt: crsWkt || null,
      decimation: skip, pointsFormat: H.fmt,
    }, { intensity, classification });
    progressAt(opts.onProgress, 'finalize', 0.96, { pointsLoaded: count, pointsTotal: H.count });
    return result;
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
}

// ============================================================
// Публичная точка входа
// ============================================================
function parseCloudFile(absPath, opts) {
  let fd = null;
  try {
    if (!absPath || !fs.existsSync(absPath)) return { ok: false, message: 'Файл не найден' };
    const st = fs.statSync(absPath);
    if (!st.isFile()) return { ok: false, message: 'Это не файл' };
    const maxPoints = Math.max(200000, (opts && opts.maxPoints) || DEFAULT_MAX_POINTS);
    const ext = (absPath.split('.').pop() || '').toLowerCase();
    fd = fs.openSync(absPath, 'r');
    if (ext === 'las') return parseLASFile(fd, st.size, maxPoints, opts && opts.onProgress);
    if (ext === 'laz') return { ok: false, message: 'Для LAZ используйте асинхронный parseCloudFileAsync().' };
    if (ext === 'ply') return parsePLYFile(fd, st.size, maxPoints, opts && opts.onProgress);
    if (ext === 'e57') return parseE57File(fd, st.size, maxPoints, opts && opts.onProgress);
    if (ext === 'pcd') return parsePCDFile(fd, st.size, maxPoints, opts && opts.onProgress, opts && opts.scratchBaseDir);
    if (ext === 'ptx') return parsePTXFile(fd, st.size, maxPoints, opts && opts.onProgress);
    if (ext === 'xyz' || ext === 'pts' || ext === 'txt' || ext === 'csv' || ext === 'xyzrgb') return parseTextCloudFile(fd, st.size, maxPoints, ext, opts && opts.onProgress);
    return { ok: false, message: 'Потоковый разбор поддержан для .las, .ply, .e57, .pcd, .ptx, .xyz, .pts' };
  } catch (e) {
    return { ok: false, message: 'Ошибка чтения облака: ' + String((e && e.message) || e) };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

async function parseCloudFileAsync(absPath, opts) {
  opts = opts || {};
  const absolutePath = String(absPath || '');
  const signal = opts.signal;
  if (signal && signal.aborted) return { ok: false, cancelled: true, message: 'Импорт отменён' };

  // Kept for worker-internal callers and deterministic tests that explicitly
  // need the synchronous implementation. All normal desktop async imports use
  // a real Node Worker so parsing never monopolizes Electron's main thread.
  if (opts.worker === false || opts.inWorker === true) {
    try {
      const ext = (absolutePath.split('.').pop() || '').toLowerCase();
      if (ext === 'laz') return await parseLAZFile(absolutePath, opts);
      return parseCloudFile(absolutePath, opts);
    } catch (e) {
      return { ok: false, message: 'Ошибка чтения облака: ' + String((e && e.message) || e) };
    }
  }

  const needsScratch = path.extname(absolutePath).toLowerCase() === '.pcd';
  let workerScratchDir = null;
  if (needsScratch) {
    try {
      const scratchBase = path.resolve(String(opts.scratchBaseDir || os.tmpdir()));
      workerScratchDir = fs.mkdtempSync(path.join(scratchBase, 'bimtwin-cloud-parse-'));
    } catch (e) {
      return { ok: false, message: 'Не удалось подготовить временный каталог PCD: ' +
        String((e && e.message) || e) };
    }
  }

  return new Promise((resolve) => {
    let worker = null;
    let settled = false;
    let cancellationRequested = false;
    let gotResult = false;
    const cancelledResult = () => ({ ok: false, cancelled: true, message: 'Импорт отменён' });
    const cleanup = () => {
      if (signal && abortListener) {
        try { signal.removeEventListener('abort', abortListener); } catch (_) {}
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      (async () => {
        // Terminate/await the worker before deleting its private scratch
        // directory. This is essential on cancellation: worker finally blocks
        // do not run after terminate().
        if (worker) {
          try { await worker.terminate(); } catch (_) {}
        }
        if (workerScratchDir) {
          try {
            fs.rmSync(workerScratchDir, { recursive: true, force: true });
          } catch (error) {
            const detail = String((error && error.message) || error);
            result = Object.assign({}, result || {}, {
              ok: false,
              message: (result && result.message ? result.message + '; ' : '') +
                'Не удалось удалить временные данные PCD: ' + detail
            });
          }
        }
        resolve(result);
      })();
    };
    const report = (progress) => {
      if (typeof opts.onProgress !== 'function') return;
      try { opts.onProgress(progress); } catch (_) {}
    };
    const abortListener = () => {
      if (settled || cancellationRequested) return;
      cancellationRequested = true;
      finish(cancelledResult());
    };

    try {
      let workerPath = path.join(__dirname, 'cloud-parse-worker.js');
      // Node worker_threads cannot reliably boot JavaScript from app.asar.
      // electron-builder unpacks the worker and its parser dependencies.
      if (process.versions && process.versions.electron && process.resourcesPath) {
        const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'cloud-parse-worker.js');
        try { if (fs.existsSync(unpacked)) workerPath = unpacked; } catch (_) {}
      }
      worker = new Worker(workerPath, {
        workerData: {
          absPath: absolutePath,
          maxPoints: Number(opts.maxPoints) || DEFAULT_MAX_POINTS,
          scratchBaseDir: workerScratchDir
        }
      });
    } catch (e) {
      finish({ ok: false, message: 'Не удалось запустить поток импорта: ' + String((e && e.message) || e) });
      return;
    }

    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) abortListener();
    }
    worker.on('message', (message) => {
      if (settled || cancellationRequested || !message || typeof message !== 'object') return;
      if (message.type === 'progress') {
        report(message.progress);
        return;
      }
      if (message.type === 'result') {
        gotResult = true;
        finish(message.result || { ok: false, message: 'Worker импорта вернул пустой ответ' });
      }
    });
    worker.on('messageerror', (error) => {
      if (!settled && !cancellationRequested) {
        finish({ ok: false, message: 'Ошибка передачи результата Worker: ' + String((error && error.message) || error) });
      }
    });
    worker.on('error', (error) => {
      if (!settled && !cancellationRequested) finish({ ok: false, message: 'Ошибка Worker импорта: ' + String((error && error.message) || error) });
    });
    worker.on('exit', (code) => {
      if (settled) return;
      if (cancellationRequested) finish(cancelledResult());
      else if (!gotResult) finish({ ok: false, message: 'Worker импорта завершился без результата (код ' + code + ')' });
    });
  });
}

module.exports = {
  parseCloudFile, parseCloudFileAsync, parseLASFile, parseLAZFile, parsePLYFile,
  parseE57File, parsePTXFile, parseTextCloudFile, parsePCDFile, finalizeWorldZup,
  getBinaryPlyPointFileInfo, sameBinaryPlyPointFileInfo,
  isBinaryPlyPointFile, prepareBinaryPLYOctreeFile,
  getOutOfCorePlyPointFileInfo, samePlyPointFileInfo, isOutOfCorePlyPointFile,
  preparePlyOctreeFile,
  getOutOfCoreLasPointFileInfo, sameLasPointFileInfo, isOutOfCoreLasPointFile,
  prepareLasOctreeFile,
  getOutOfCorePcdPointFileInfo: PcdOutOfCore.getOutOfCorePcdPointFileInfo,
  samePcdPointFileInfo: PcdOutOfCore.samePcdPointFileInfo,
  isOutOfCorePcdPointFile: PcdOutOfCore.isOutOfCorePcdPointFile,
  preparePcdOctreeFile: PcdOutOfCore.preparePcdOctreeFile,
  DEFAULT_MAX_POINTS
};
