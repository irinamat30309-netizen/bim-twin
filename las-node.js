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
const { Worker } = require('worker_threads');
const { pathToFileURL } = require('url');
const cfg = require('./app-config');
const core = require('./las-core');

const DEFAULT_MAX_POINTS = cfg.DEFAULT_MAX_POINTS;
const CHUNK_BYTES = cfg.CLOUD_CHUNK_BYTES;
const SCAN_N = cfg.COLOR_SAMPLE_COUNT;
// binary_compressed PCD must currently be decompressed as a contiguous LZF
// field-major buffer. Keep an explicit bound until Stage 4 adds out-of-core IO.
const PCD_MAX_LZF_BYTES = 512 * 1024 * 1024;
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
  const headerSize=head.readUInt16LE(94), offToPts=head.readUInt32LE(96), vlrs=head.readUInt32LE(100);
  function user(b,o,n){return b.toString('ascii',o,o+n).replace(/\0/g,'').trim();}
  function scan(start,count,hdrLen){let p=start;for(let i=0;i<count&&p+hdrLen<=fileSize;i++){
    const h=Buffer.alloc(hdrLen);if(fs.readSync(fd,h,0,hdrLen,p)!==hdrLen)break;
    const uid=user(h,hdrLen===54?2:2,16), id=hdrLen===54?h.readUInt16LE(18):h.readUInt16LE( headerSize );
    const len=hdrLen===54?h.readUInt16LE(20):h.readUInt32LE(20);
    const data=p+hdrLen;if(data+len>fileSize)break;
    if(uid==='LASF_Projection'&&(id===2112||id===2111)){const b=Buffer.alloc(len);fs.readSync(fd,b,0,len,data);return b.toString('utf8').replace(/\0+$/g,'').trim();}
    p=data+len;
  }return null;}
  const got=scan(headerSize,vlrs,54);if(got)return got;
  if(head[25]>=4&&head.length>=375){const evlrOff=Number(head.readBigUInt64LE(235)),evlrN=head.readUInt32LE(243);if(evlrOff>0&&evlrN>0&&evlrOff<fileSize){let p=evlrOff;for(let i=0;i<evlrN&&p+60<=fileSize;i++){const h=Buffer.alloc(60);fs.readSync(fd,h,0,60,p);const uid=user(h,2,16),id=h.readUInt16LE(18),len=Number(h.readBigUInt64LE(20));if(p+60+len>fileSize)break;if(uid==='LASF_Projection'&&(id===2112||id===2111)){const b=Buffer.alloc(len);fs.readSync(fd,b,0,len,p+60);return b.toString('utf8').replace(/\0+$/g,'').trim();}p+=60+len;}}}
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
  const crsWkt=readLasCrsWkt(fd,fileSize,head);
  const offToPts = H.offToPts, fmt = H.fmt, recLen = H.recLen, colorOff = H.colorOff;
  const intensityOff = H.intensityOff, classificationOff = H.classificationOff;
  const hasIntensity = H.hasIntensity && intensityOff + 2 <= recLen;
  const hasClassification = H.hasClassification && classificationOff + 1 <= recLen;
  const sx = H.scale.x, sy = H.scale.y, sz = H.scale.z, ox = H.offset.x, oy = H.offset.y, oz = H.offset.z;
  let count = H.count;
  let hasColor = H.hasColor;
  if (!count || count < 0) throw new Error('в LAS нет точек');
  if (!recLen || offToPts <= 0) throw new Error('повреждённый заголовок LAS');

  // ограничим count реальным размером файла (на случай битого заголовка)
  const maxByBytes = Math.floor((fileSize - offToPts) / recLen);
  if (maxByBytes > 0 && count > maxByBytes) count = maxByBytes;
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
    crsWkt: r.crs || null, scans: r.scans.map((s) => ({ name: s.name, count: s.count, pose: s.pose }))
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
  const second = walk(() => {}, (_scan, rec, xyz) => {
    const sample = validIndex++;
    if (sample % stride !== 0 || out >= cap) return;
    world[out * 3] = xyz[0]; world[out * 3 + 1] = xyz[1]; world[out * 3 + 2] = xyz[2];
    if (col) {
      col[out * 3] = Math.max(0, Math.min(1, rec.r / colorDiv));
      col[out * 3 + 1] = Math.max(0, Math.min(1, rec.g / colorDiv));
      col[out * 3 + 2] = Math.max(0, Math.min(1, rec.b / colorDiv));
    }
    if (intensity) intensity[out] = Math.max(0, Math.min(1, rec.intensity / intensityDiv));
    out++;
  }, 'sample');
  if (out !== cap || second.recordCount !== first.recordCount) throw new Error('PTX: source changed between streaming passes');
  const scans = indexScans.map(s => ({
    index: s.index, columns: s.columns, rows: s.rows, pointRecords: s.pointRecords,
    validPoints: s.validPoints, scannerPosition: s.scannerPosition, axes: s.axes,
    transform: s.matrix, matrixConvention: s.convention
  }));
  return finalizeWorldZup(world, col, out, {
    total: validCount, recordCount: first.recordCount, scanCount: first.scanCount,
    format: 'PTX (' + first.scanCount + ' scan' + (first.scanCount === 1 ? '' : 's') + ')',
    scans, crsWkt: null, units: null, hasIntensity, hasClassification: false,
    decimation: stride, intensityScale: intensityDiv
  }, { intensity });
}

function lzfDecompress(input, expectedSize) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > PCD_MAX_LZF_BYTES) throw new Error('PCD: decompressed buffer exceeds 512 MiB safety limit');
  const out = Buffer.allocUnsafe(expectedSize); let ip = 0, op = 0;
  while (ip < input.length && op < expectedSize) {
    const ctrl = input[ip++];
    if (ctrl < 32) {
      const len = ctrl + 1;
      if (ip + len > input.length || op + len > expectedSize) throw new Error('PCD: invalid LZF literal run');
      input.copy(out, op, ip, ip + len); ip += len; op += len;
    } else {
      let len = ctrl >>> 5, ref = op - ((ctrl & 0x1f) << 8) - 1;
      if (len === 7) { if (ip >= input.length) throw new Error('PCD: truncated LZF length'); len += input[ip++]; }
      if (ip >= input.length) throw new Error('PCD: truncated LZF offset');
      ref -= input[ip++]; len += 2;
      if (ref < 0 || op + len > expectedSize) throw new Error('PCD: invalid LZF back-reference');
      for (let k = 0; k < len; k++) out[op++] = out[ref++];
    }
  }
  if (op !== expectedSize) throw new Error('PCD: decompressed length mismatch (' + op + ' != ' + expectedSize + ')');
  if (ip !== input.length) throw new Error('PCD: trailing bytes after LZF payload');
  return out;
}

function parsePCDFile(fd, fileSize, maxPoints, onProgress) {
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
    const sz = Buffer.alloc(8); if (fs.readSync(fd, sz, 0, 8, dataOff) !== 8) throw new Error('PCD: truncated binary_compressed sizes');
    const compressedSize = sz.readUInt32LE(0), uncompressedSize = sz.readUInt32LE(4);
    if (uncompressedSize > PCD_MAX_LZF_BYTES || compressedSize > PCD_MAX_LZF_BYTES) throw new Error('PCD: binary_compressed buffer exceeds 512 MiB safety limit');
    if (uncompressedSize !== planarBytes || dataOff + 8 + compressedSize > fileSize) throw new Error('PCD: binary_compressed length mismatch');
    const compressed = Buffer.alloc(compressedSize); if (fs.readSync(fd, compressed, 0, compressedSize, dataOff + 8) !== compressedSize) throw new Error('PCD: truncated compressed payload');
    progressAt(onProgress, 'read-compressed', 0.25, { bytesRead: compressedSize, bytesTotal: compressedSize });
    const raw = lzfDecompress(compressed, uncompressedSize);
    progressAt(onProgress, 'decompress', 0.7, { bytesRead: uncompressedSize, bytesTotal: uncompressedSize });
    const starts = []; let start = 0; fields.forEach((_, i) => { starts.push(start); start += fieldBytes[i] * n; });
    for (let gi = 0; gi < n; gi++) {
      if (core.keepSampledIndex ? !core.keepSampledIndex(gi, stride) : gi % stride !== 0) continue;
      emit(gi, (fi) => scalar(raw, starts[fi] + gi * fieldBytes[fi], fi),
        (fi) => size[fi] === 4 ? raw.readUInt32LE(starts[fi] + gi * fieldBytes[fi]) : numberValue(scalar(raw, starts[fi] + gi * fieldBytes[fi], fi)));
      if ((gi & 0x3ffff) === 0) progressAt(onProgress, 'decode-points', 0.7 + 0.22 * gi / n, { pointsRead: gi, pointsTotal: n });
    }
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
    if (ext === 'pcd') return parsePCDFile(fd, st.size, maxPoints, opts && opts.onProgress);
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
      resolve(result);
    };
    const report = (progress) => {
      if (typeof opts.onProgress !== 'function') return;
      try { opts.onProgress(progress); } catch (_) {}
    };
    const abortListener = () => {
      if (settled || cancellationRequested) return;
      cancellationRequested = true;
      if (!worker) { finish(cancelledResult()); return; }
      try {
        Promise.resolve(worker.terminate()).then(
          () => finish(cancelledResult()),
          () => finish(cancelledResult())
        );
      } catch (_) { finish(cancelledResult()); }
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
        workerData: { absPath: absolutePath, maxPoints: Number(opts.maxPoints) || DEFAULT_MAX_POINTS }
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
        try { worker.terminate(); } catch (_) {}
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

module.exports = { parseCloudFile, parseCloudFileAsync, parseLASFile, parseLAZFile, parsePLYFile, parseE57File, parsePTXFile, parseTextCloudFile, parsePCDFile, finalizeWorldZup, DEFAULT_MAX_POINTS };
