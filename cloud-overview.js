'use strict';
/*
 * cloud-overview.js — карта облака ДО загрузки (ревизия 27): вид сверху, высоты, этажи, сведения о съёмке, маршрут сканера,
 * горизонтальный срез для чертежа плана и маска «не дальше R от маршрута».
 *
 * Файл не загружается целиком: для карты читается равномерная выборка (по умолчанию 4 млн точек — блоками подряд идущих записей,
 * разложенными по всему файлу), для среза плана — проход по всем точкам, но разбирается только высота (остальное — у точек среза).
 *
 * eachPoint(desc, opts, fn): fn(u, v, h, o) — у LAS и PLY четвёртый аргумент — разобранная запись (цвет o.r/g/b 0–255, интенсивность o.i);
 *   у E57 — только (u, v, h) (ревизия 39: цвет и интенсивность нужны модели BIM для материалов).
 *
 * Плановые координаты (u, v, h) — метры от центра облака (u — восток/X, v — север/Y, h — вверх от низа облака). Они же — координаты окна
 * (u = x, v = −z, h = y), поэтому фильтры загрузки (cloud-segments.filterSegment) задаются в них.
 *
 *   overview(desc, { samples, keep }) → { ok, file, bbox, grid, hist, levels, stats, time, pts }
 *   planSlice(desc, { h0, h1, high: { h0, h1, bands }, rect, maxPoints, onProgress, signal }) → { ok, uv: Float32Array, count, read, uvHigh?, countHigh? }
 *   trajectoryInfo(posesText, desc) → { n, duration, length, speed, loopGap, route: Float32Array (u,v,h,t), inside }
 *   routeMask(route, bbox, { radius, cell, from, to }) → { u0, v0, cell, nx, ny, bits: Uint8Array }
 *   areaMask([{ op: 'add'|'sub', pts }], { cell }) → { u0, v0, cell, nx, ny, bits, outsideOn } — контуры, обведённые мышью (ревизия 37)
 */
const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------ чтение записей
function lasTimeOff(fmt) { return (fmt === 1 || fmt === 3 || fmt === 4 || fmt === 5) ? 20 : fmt >= 6 ? 22 : -1; }
function plyRd(type, le) {
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
// Разбор записи → плановые координаты (u, v, h), цвет 0–255, интенсивность 0–1, время (LAS) — в объект o
function makeDecoder(desc) {
  if (desc.kind === 'las') {
    const sx = desc.scale[0], sy = desc.scale[1], sz = desc.scale[2], ox = desc.offset[0] - desc.cx, oy = desc.offset[1] - desc.cy, oz = desc.offset[2] - desc.cz;
    const cOff = desc.colorOff, kc = 255 / (desc.colDiv || 65535), iOff = desc.intensityOff, tOff = lasTimeOff(desc.fmt), hasC = desc.hasColor, hasI = desc.hasIntensity;
    return {
      recLen: desc.recLen, start: desc.offToPts,
      hOf: (b, base) => b.readInt32LE(base + 8) * sz + oz,
      dec(b, base, o) {
        o.u = b.readInt32LE(base) * sx + ox; o.v = b.readInt32LE(base + 4) * sy + oy; o.h = b.readInt32LE(base + 8) * sz + oz;
        if (hasC) { o.r = b.readUInt16LE(base + cOff) * kc; o.g = b.readUInt16LE(base + cOff + 2) * kc; o.b = b.readUInt16LE(base + cOff + 4) * kc; }
        o.i = hasI ? b.readUInt16LE(base + iOff) / 65535 : 0;
        o.t = tOff >= 0 && tOff + 8 <= desc.recLen ? b.readDoubleLE(base + tOff) : NaN;
      }
    };
  }
  const le = desc.le, rx = plyRd(desc.x.type, le), ry = plyRd(desc.y.type, le), rz = plyRd(desc.z.type, le);
  const xO = desc.x.offset, yO = desc.y.offset, zO = desc.z.offset, zup = desc.zup, cx = desc.cx, cy = desc.cy, cz = desc.cz;
  const hasC = desc.hasColor, kc = 255 / (desc.colDiv || 1);
  const rr = hasC ? plyRd(desc.r.type, le) : null, rg = hasC ? plyRd(desc.g.type, le) : null, rb = hasC ? plyRd(desc.b.type, le) : null;
  const ri = desc.intensity ? plyRd(desc.intensity.type, le) : null, iDiv = desc.intDiv || 1;
  const h0 = zup ? 0 : desc.h / 2;   // Y-вверх: центр облака по высоте в нуле — сдвигаем, чтобы низ был в 0
  return {
    recLen: desc.recLen, start: desc.dataOffset,
    hOf: zup ? (b, base) => rz(b, base + zO) - cz : (b, base) => ry(b, base + yO) - cy + h0,
    dec(b, base, o) {
      const X = rx(b, base + xO), Y = ry(b, base + yO), Z = rz(b, base + zO);
      if (zup) { o.u = X - cx; o.v = Y - cy; o.h = Z - cz; } else { o.u = X - cx; o.v = -(Z - cz); o.h = Y - cy + h0; }
      if (hasC) { o.r = rr(b, base + desc.r.offset) * kc; o.g = rg(b, base + desc.g.offset) * kc; o.b = rb(b, base + desc.b.offset) * kc; }
      o.i = ri ? Math.max(0, Math.min(1, ri(b, base + desc.intensity.offset) / iDiv)) : 0;
      o.t = NaN;
    }
  };
}
// плановые координаты → координаты окна и обратно (для фильтров загрузки)
function hShift(desc) { return desc.kind === 'ply' && !desc.zup ? desc.h / 2 : 0; }

function readExact(fd, buf, len, pos) {
  let got = 0;
  while (got < len) { const n = fs.readSync(fd, buf, got, len - got, pos + got); if (n <= 0) return got; got += n; }
  return got;
}

function lasHeaderText(fd) {
  try {
    const b = Buffer.alloc(100); readExact(fd, b, 100, 0);
    const cs = (a, n) => b.toString('latin1', a, a + n).replace(/\0[\s\S]*$/, '').trim();
    const day = b.readUInt16LE(90), year = b.readUInt16LE(92);
    let created = null;
    if (year > 1990 && year < 2200 && day >= 1 && day <= 366) { const d = new Date(Date.UTC(year, 0, 1) + (day - 1) * 86400000); created = d.toISOString().slice(0, 10); }
    return { system: cs(26, 32), software: cs(58, 32), created };
  } catch (_) { return { system: '', software: '', created: null }; }
}

// ------------------------------------------------------------ карта (выборка)
function chooseCell(w, d) {
  const big = Math.max(w, d, 1);
  const raw = big / 900;
  const steps = [0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10];
  for (const s of steps) if (s >= raw) return s;
  return Math.ceil(raw);
}

// ------------------------------------------------------------ E57 (ревизия 28): карта до загрузки и срез плана
// Ревизия 29: E57, открытый через cloud-segments (desc.e57 — указатель пакетов, e57-segments.js), читается как LAS: выборка карты —
// окнами записей равномерно по файлу (файл целиком не читается), срез плана — по ВСЕМ точкам файла одним проходом, начало
// координат — из openE57Segments (центр рамки по X/Y, низ по Z). Без указателя (desc из openE57 — запасной путь) — как в ревизии 28:
// файл читается целиком, в память попадает только равномерная выборка (E57Core.read, maxPoints). Плановые координаты — от центра
// рамки по X/Y и от низа по Z (мировые координаты E57 — Z вверх), они же — origin для фильтров загрузки.
function e57Readers(desc, onProgress) {
  const fd = fs.openSync(desc.path, 'r');
  let high = 0, lastF = 0;
  const readPhys = (o, l) => {
    const b = Buffer.alloc(l), got = readExact(fd, b, l, o);
    if (o + got > high) high = o + got;
    if (onProgress) { const f = Math.min(1, high / Math.max(1, desc.fileSize)); if (f - lastF >= 0.01) { lastF = f; onProgress(f); } }
    return new Uint8Array(b.buffer, b.byteOffset, got);
  };
  return { fd, readPhys };
}
function openE57(abs, size) {
  const E57 = require('./e57-core');
  const desc = { kind: 'e57', path: abs, fileSize: size, count: 0, hasColor: false, hasIntensity: false, hasClassification: false, meta: { format: 'E57' }, zup: true };
  const R = e57Readers(desc, null);
  try {
    const inf = E57.inspect(R.readPhys, size);
    desc.count = inf.total; desc.hasColor = inf.color; desc.hasIntensity = inf.intensity; desc.scans = inf.scans.length;
    desc.meta = { format: 'E57 (' + inf.scans.length + ' скан.)', crsWkt: inf.crs ? 'E57' : null };
  } finally { fs.closeSync(R.fd); }
  return desc;
}
function e57Sample(desc, maxPoints, onProgress) {
  const E57 = require('./e57-core');
  const R = e57Readers(desc, onProgress);
  try { return E57.read(R.readPhys, desc.fileSize, { maxPoints }); } finally { fs.closeSync(R.fd); }
}
// ревизия 29: выборка карты по указателю пакетов — блоки записей равномерно по файлу (как gatherRecords у LAS), начало координат не меняется
function gatherE57Parts(desc, S0) {
  const ES = require('./e57-segments');
  const total = desc.count, S = Math.max(1000, Math.min(total, S0));
  const B = S >= total ? 1 : Math.max(1, Math.min(4096, Math.ceil(S / 1500))), per = Math.max(1, Math.ceil(S / B));
  const cap = Math.min(total, B * per), uu = new Float32Array(cap), vv = new Float32Array(cap), hh = new Float32Array(cap);
  const cr = desc.hasColor ? new Uint8Array(cap * 3) : null, ii = desc.hasIntensity ? new Uint8Array(cap) : null;
  const cx = desc.cx, cy = desc.cy, cz = desc.cz;
  let n = 0;
  const fd = fs.openSync(desc.path, 'r');
  try {
    for (let k = 0; k < B; k++) {
      const first = Math.floor(k * total / B), next = Math.floor((k + 1) * total / B), cnt = Math.min(per, next - first);
      if (cnt <= 0) continue;
      ES.e57Points(desc, fd, first, cnt, (x, y, z, r, g, b, iv) => {
        if (n >= cap) return;
        uu[n] = x - cx; vv[n] = y - cy; hh[n] = z - cz;
        if (cr) { cr[n * 3] = r; cr[n * 3 + 1] = g; cr[n * 3 + 2] = b; }
        if (ii) ii[n] = Math.round(iv * 255);
        n++;
      });
    }
  } finally { fs.closeSync(fd); }
  const stations = desc.e57.scans.map((sc) => ({ name: String(sc.name || '').slice(0, 80), points: sc.count, u: sc.T[0] - cx, v: sc.T[1] - cy, h: sc.T[2] - cz }));
  return { uu, vv, hh, cr, ii, n, t0: Infinity, t1: -Infinity, head: { system: '', software: '', created: null }, stations };
}
function gatherE57(desc, S) {
  if (desc.e57 && Number.isFinite(desc.cx)) return gatherE57Parts(desc, S);
  const r = e57Sample(desc, S);
  const n0 = r.count, P = r.pos;
  if (!(n0 > 0)) return null;
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (let i = 0; i < n0; i++) { const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]; if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; if (z < mnz) mnz = z; }
  // центр и низ — как при загрузке (las-node finalizeWorldZup), только по выборке
  desc.cx = (mnx + mxx) / 2; desc.cy = (mny + mxy) / 2; desc.cz = mnz;
  desc.count = r.total; desc.hasColor = !!r.colored; desc.hasIntensity = !!r.hasIntensity;
  desc.meta = { format: 'E57 (' + r.scans.length + ' скан.)', crsWkt: r.crs || null };
  const uu = new Float32Array(n0), vv = new Float32Array(n0), hh = new Float32Array(n0);
  const cr = r.colored ? new Uint8Array(n0 * 3) : null, ii = r.hasIntensity ? new Uint8Array(n0) : null;
  for (let i = 0; i < n0; i++) {
    uu[i] = P[i * 3] - desc.cx; vv[i] = P[i * 3 + 1] - desc.cy; hh[i] = P[i * 3 + 2] - desc.cz;
    if (cr) { cr[i * 3] = Math.max(0, Math.min(255, r.col[i * 3] * 255)); cr[i * 3 + 1] = Math.max(0, Math.min(255, r.col[i * 3 + 1] * 255)); cr[i * 3 + 2] = Math.max(0, Math.min(255, r.col[i * 3 + 2] * 255)); }
    if (ii) ii[i] = Math.max(0, Math.min(255, Math.round(r.intensity[i] * 255)));
  }
  // станции (позы сканов): у наземного сканера это точки стояния, у мобильного — обычно одна поза на весь проход
  const stations = r.scans.map((sc) => ({ name: String(sc.name || '').slice(0, 80), points: sc.recordCount,
    u: sc.pose.T[0] - desc.cx, v: sc.pose.T[1] - desc.cy, h: sc.pose.T[2] - desc.cz }));
  return { uu, vv, hh, cr, ii, n: n0, t0: Infinity, t1: -Infinity, head: { system: '', software: '', created: null }, stations };
}
function gatherRecords(desc, S0) {
  const total = desc.count;
  const S = Math.max(1000, Math.min(total, S0));
  const B = Math.max(1, Math.min(4096, Math.ceil(S / 1500))), per = Math.max(1, Math.ceil(S / B));
  const D = makeDecoder(desc), rl = D.recLen;
  const uu = new Float32Array(B * per), vv = new Float32Array(B * per), hh = new Float32Array(B * per);
  const cr = desc.hasColor ? new Uint8Array(B * per * 3) : null, ii = desc.hasIntensity ? new Uint8Array(B * per) : null;
  let n = 0, t0 = Infinity, t1 = -Infinity;
  const o = { u: 0, v: 0, h: 0, r: 0, g: 0, b: 0, i: 0, t: NaN };
  const fd = fs.openSync(desc.path, 'r');
  const head = desc.kind === 'las' ? lasHeaderText(fd) : { system: '', software: '', created: null };
  try {
    const buf = Buffer.allocUnsafe(per * rl);
    for (let k = 0; k < B; k++) {
      // блоки равномерно по файлу без перекрытия (при выборке «все точки» каждая точка читается ровно один раз)
      const first = Math.floor(k * total / B), next = Math.floor((k + 1) * total / B);
      const cnt = Math.min(per, next - first);
      if (cnt <= 0) continue;
      const got = Math.floor(readExact(fd, buf, cnt * rl, D.start + first * rl) / rl);
      for (let j = 0; j < got; j++) {
        D.dec(buf, j * rl, o);
        if (!(o.u === o.u && o.v === o.v && o.h === o.h)) continue;
        uu[n] = o.u; vv[n] = o.v; hh[n] = o.h;
        if (cr) { cr[n * 3] = o.r; cr[n * 3 + 1] = o.g; cr[n * 3 + 2] = o.b; }
        if (ii) ii[n] = Math.round(o.i * 255);
        if (o.t === o.t) { if (o.t < t0) t0 = o.t; if (o.t > t1) t1 = o.t; }
        n++;
      }
    }
  } finally { fs.closeSync(fd); }
  return { uu, vv, hh, cr, ii, n, t0, t1, head, stations: null };
}

function overview(desc, opts) {
  opts = opts || {};
  const S0 = Math.max(1000, Math.floor(opts.samples || 4000000));
  const G = desc.kind === 'e57' ? gatherE57(desc, S0) : gatherRecords(desc, Math.min(desc.count, S0));
  if (!G || G.n < 10) return { ok: false, message: 'в файле не нашлось точек для карты' };
  const { uu, vv, hh, n, t0, t1, head } = G, total = desc.count, cr = G.cr, ii = G.ii;
  // габариты по выборке (обрезаем 0,05 % крайних — одиночные выбросы на сотни метров не растягивают карту)
  const qs = (arr) => { const step = Math.max(1, Math.floor(n / 200000)), a = []; for (let i = 0; i < n; i += step) a.push(arr[i]); a.sort((x, y) => x - y); return [a[Math.floor(a.length * 0.0005)], a[Math.min(a.length - 1, Math.floor(a.length * 0.9995))], a[0], a[a.length - 1]]; };
  const qu = qs(uu), qv = qs(vv), qh = qs(hh);
  const pad = 0.5;
  const u0 = qu[0] - pad, u1 = qu[1] + pad, v0 = qv[0] - pad, v1 = qv[1] + pad;
  // клетка карты: по габаритам (≈900 клеток по длинной стороне), но не мельче двух средних шагов точек выборки —
  // иначе на маленьком объекте в клетку попадает 1–2 точки на поверхность и карта высот становится «пёстрой»
  const surf = surfaceArea(uu, vv, hh, n, 0.2);
  const STEPS = [0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10];
  const minCell = surf > 0 ? 2 * Math.sqrt(surf / n) : 0;
  let cell = chooseCell(u1 - u0, v1 - v0);
  if (cell < minCell) cell = STEPS.find((s) => s >= minCell) || Math.ceil(minCell);
  const nx = Math.max(1, Math.ceil((u1 - u0) / cell)), ny = Math.max(1, Math.ceil((v1 - v0) / cell));
  const count = new Uint32Array(nx * ny), hmax = new Float32Array(nx * ny).fill(-Infinity), hmin = new Float32Array(nx * ny).fill(Infinity);
  const sumC = cr ? new Float32Array(nx * ny * 3) : null, sumI = ii ? new Float32Array(nx * ny) : null;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor((uu[i] - u0) / cell), cy = Math.floor((vv[i] - v0) / cell);
    if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) continue;
    const c = cy * nx + cx; count[c]++;
    const h = hh[i]; if (h > hmax[c]) hmax[c] = h; if (h < hmin[c]) hmin[c] = h;
    if (sumC) { sumC[c * 3] += cr[i * 3]; sumC[c * 3 + 1] += cr[i * 3 + 1]; sumC[c * 3 + 2] += cr[i * 3 + 2]; }
    if (sumI) sumI[c] += ii[i];
  }
  let occ = 0;
  const rgb = sumC ? new Uint8Array(nx * ny * 3) : null, inten = sumI ? new Uint8Array(nx * ny) : null;
  for (let c = 0; c < nx * ny; c++) {
    const k = count[c]; if (!k) { hmax[c] = NaN; hmin[c] = NaN; continue; }
    occ++;
    if (rgb) { rgb[c * 3] = sumC[c * 3] / k; rgb[c * 3 + 1] = sumC[c * 3 + 1] / k; rgb[c * 3 + 2] = sumC[c * 3 + 2] / k; }
    if (inten) inten[c] = sumI[c] / k;
  }
  // гистограмма высот (2 см) и горизонтальные плоскости (полы, перекрытия)
  const hs = 0.02, hb0 = Math.floor(qh[2] / hs) * hs, nb = Math.max(1, Math.min(200000, Math.ceil((qh[3] - hb0) / hs) + 1));
  const hist = new Uint32Array(nb);
  for (let i = 0; i < n; i++) { const b = Math.floor((hh[i] - hb0) / hs); if (b >= 0 && b < nb) hist[b]++; }
  const footprint = occ * cell * cell;
  const levels = findLevels(uu, vv, hh, n, hist, hb0, hs, footprint);
  // площадь поверхностей ≈ число занятых вокселей 20 см × 0,04 м² (по выборке — оценка снизу), средний шаг точек — из неё
  const spacing = surf > 0 ? Math.sqrt(surf / total) : 0;
  const res = {
    ok: true,
    file: { name: path.basename(desc.path), size: desc.fileSize, format: desc.meta && desc.meta.format || desc.kind.toUpperCase(), points: total,
      system: head.system, software: head.software, created: head.created, crs: !!(desc.meta && desc.meta.crsWkt), colored: !!desc.hasColor,
      intensity: !!desc.hasIntensity, classification: !!desc.hasClassification },
    origin: { cx: desc.cx, cy: desc.cy, cz: desc.cz, zup: desc.kind === 'las' || desc.kind === 'e57' || !!desc.zup, hShift: hShift(desc) },
    bbox: { u0: qu[2], u1: qu[3], v0: qv[2], v1: qv[3], h0: qh[2], h1: qh[3], core: { u0: qu[0], u1: qu[1], v0: qv[0], v1: qv[1], h0: qh[0], h1: qh[1] } },
    grid: { nx, ny, cell, u0, v0, count, hmax, hmin, rgb, inten },
    hist: { h0: hb0, step: hs, counts: hist },
    levels,
    time: t1 > t0 ? { t0, t1, duration: t1 - t0 } : null,
    sample: { n, share: n / total },
    stats: { footprint, perM2: footprint > 0 ? total / footprint : 0, surface: surf, spacing,
      w: qu[1] - qu[0], d: qv[1] - qv[0], h: qh[1] - qh[0] }
  };
  // небольшая выборка (u, v, h) — окну, чтобы мгновенно пересчитывать «сколько точек останется» при выборе области и высоты
  const keepN = Math.min(n, Math.floor(opts.keep || 300000)), kstep = n / keepN, pts = new Float32Array(keepN * 3);
  for (let j = 0; j < keepN; j++) { const i = Math.floor(j * kstep); pts[j * 3] = uu[i]; pts[j * 3 + 1] = vv[i]; pts[j * 3 + 2] = hh[i]; }
  res.pts = pts;
  if (G.stations && G.stations.length) res.stations = G.stations.slice(0, 2000);
  return res;
}

function surfaceArea(uu, vv, hh, n, vox) {
  const size = 1 << 22, tab = new Uint8Array(size); let occ = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(uu[i] / vox), b = Math.floor(vv[i] / vox), c = Math.floor(hh[i] / vox);
    let hsh = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) >>> 0;
    hsh = (hsh ^ (hsh >>> 15)) & (size - 1);
    if (!tab[hsh]) { tab[hsh] = 1; occ++; }
  }
  // поправка на совпадения в таблице (ожидаемое число занятых ячеек при случайном хешировании)
  const f = occ / size, est = f < 0.999 ? -Math.log(1 - f) * size : occ;
  return est * vox * vox;
}

// пики гистограммы высот с большой горизонтальной площадью → уровни (полы и перекрытия)
function findLevels(uu, vv, hh, n, hist, hb0, hs, footprint) {
  const nb = hist.length; if (nb < 5) return [];
  // сглаживание окном 5 (10 см)
  const sm = new Float32Array(nb);
  for (let i = 0; i < nb; i++) { let s = 0; for (let k = -2; k <= 2; k++) { const j = i + k; if (j >= 0 && j < nb) s += hist[j]; } sm[i] = s; }
  const sorted = Array.from(sm).filter(x => x > 0).sort((a, b) => a - b); const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const cand = [];
  for (let i = 1; i < nb - 1; i++) {
    if (sm[i] <= med * 3 || sm[i] < sm[i - 1] || sm[i] < sm[i + 1]) continue;
    let ok = true; for (let k = -10; k <= 10 && ok; k++) { const j = i + k; if (k && j >= 0 && j < nb && sm[j] > sm[i]) ok = false; }   // наибольший в окне ±20 см
    if (ok) cand.push(i);
  }
  if (!cand.length) return [];
  // площадь каждого пика — число занятых клеток 0,5 м среди точек в ±4 см от пика
  const out = [];
  for (const bi of cand.slice(0, 60)) {
    const hc0 = hb0 + (bi + 0.5) * hs, near = [];
    for (let i = 0; i < n; i++) if (Math.abs(hh[i] - hc0) <= 0.06) near.push(hh[i]);
    near.sort((a, b) => a - b);
    // высота уровня — медиана точек у пика (гистограмма даёт лишь середину корзины); площадь — клетки 0,25 м в ±3 см от уровня
    const hc = near.length ? near[Math.floor(near.length / 2)] : hc0, set = new Set();
    for (let i = 0; i < n; i++) if (Math.abs(hh[i] - hc) <= 0.03) set.add(Math.floor(uu[i] / 0.25) * 1000003 + Math.floor(vv[i] / 0.25));
    out.push({ h: Math.round(hc * 1000) / 1000, area: set.size * 0.0625, points: sm[bi] });
  }
  const maxA = out.reduce((m, x) => Math.max(m, x.area), 0);
  return out.filter(x => x.area >= Math.max(4, maxA * 0.15, footprint * 0.02)).sort((a, b) => a.h - b.h);
}

// ------------------------------------------------------------ траектория
function parsePoses(text) {
  const T = [], X = [], Y = [], Z = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim(); if (!s || /^[a-z#]/i.test(s)) continue;
    const a = s.split(/[,;\s]+/).map(Number);
    if (a.length < 4 || !a.slice(0, 4).every(Number.isFinite)) continue;
    T.push(a[0]); X.push(a[1]); Y.push(a[2]); Z.push(a[3]);
  }
  const o = Array.from(T.keys()).sort((i, j) => T[i] - T[j]);
  return { n: o.length, t: o.map(i => T[i]), x: o.map(i => X[i]), y: o.map(i => Y[i]), z: o.map(i => Z[i]) };
}
function trajectoryInfo(posesText, origin, bbox) {
  const P = parsePoses(posesText);
  if (P.n < 2) return null;
  let len = 0;
  for (let i = 1; i < P.n; i++) len += Math.hypot(P.x[i] - P.x[i - 1], P.y[i] - P.y[i - 1], P.z[i] - P.z[i - 1]);
  let dur = P.t[P.n - 1] - P.t[0];
  if (dur > 1e7) dur /= 1e9; else if (dur > 1e5 && len / dur < 0.01) dur /= 1e3;   // наносекунды/миллисекунды → секунды
  const cx = origin.cx, cy = origin.cy, cz = origin.cz;
  // траектория в плановых координатах облака; не больше 6000 точек
  const step = Math.max(1, Math.ceil(P.n / 6000)), m = Math.ceil(P.n / step), route = new Float32Array(m * 4);
  let inside = 0;
  for (let j = 0; j < m; j++) {
    const i = Math.min(P.n - 1, j * step);
    const u = P.x[i] - cx, v = P.y[i] - cy, h = P.z[i] - cz;
    route[j * 4] = u; route[j * 4 + 1] = v; route[j * 4 + 2] = h; route[j * 4 + 3] = (P.t[i] - P.t[0]) / Math.max(1e-9, P.t[P.n - 1] - P.t[0]);
    if (bbox && u >= bbox.u0 - 5 && u <= bbox.u1 + 5 && v >= bbox.v0 - 5 && v <= bbox.v1 + 5) inside++;
  }
  const gap = Math.hypot(P.x[P.n - 1] - P.x[0], P.y[P.n - 1] - P.y[0], P.z[P.n - 1] - P.z[0]);
  return { n: P.n, duration: dur, length: len, speed: dur > 0 ? len / dur : 0, loopGap: gap, route, inside: m ? inside / m : 0,
    aligned: origin.zup && (!bbox || inside / Math.max(1, m) > 0.6) };
}

// клетки не дальше radius от маршрута (или его участка from–to, доли 0–1 по времени)
function routeMask(route, bbox, o) {
  o = o || {};
  const R = Math.max(0.5, Number(o.radius) || 10), cell = Math.max(0.1, Number(o.cell) || Math.max(0.25, R / 20));
  const u0 = bbox.u0 - 1, v0 = bbox.v0 - 1, nx = Math.max(1, Math.ceil((bbox.u1 - bbox.u0 + 2) / cell)), ny = Math.max(1, Math.ceil((bbox.v1 - bbox.v0 + 2) / cell));
  if (nx * ny > 16e6) throw new Error('слишком мелкая клетка маски маршрута');
  const from = o.from == null ? 0 : +o.from, to = o.to == null ? 1 : +o.to;
  const dist = new Float32Array(nx * ny).fill(Infinity), q = [];
  const m = route.length / 4;
  const seed = (cx, cy) => { if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) return; const c = cy * nx + cx; if (dist[c] !== 0) { dist[c] = 0; q.push(c); } };
  for (let j = 0; j < m; j++) {
    const t = route[j * 4 + 3]; if (t < from || t > to) continue;
    const ua = route[j * 4], va = route[j * 4 + 1];
    seed(Math.floor((ua - u0) / cell), Math.floor((va - v0) / cell));
    if (j + 1 < m && route[(j + 1) * 4 + 3] <= to) {   // отрезок до следующей точки маршрута
      const ub = route[(j + 1) * 4], vb = route[(j + 1) * 4 + 1], L = Math.hypot(ub - ua, vb - va), k = Math.ceil(L / (cell * 0.5));
      for (let s = 1; s < k; s++) seed(Math.floor((ua + (ub - ua) * s / k - u0) / cell), Math.floor((va + (vb - va) * s / k - v0) / cell));
    }
  }
  // расстояние по клеткам (8 соседей) — волной от маршрута, не дальше R
  const rc = R / cell, D2 = Math.SQRT2;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi], d = dist[c], x = c % nx, y = (c - x) / nx;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= nx || Y >= ny) continue;
      const nd = d + (dx && dy ? D2 : 1); if (nd > rc) continue;
      const k = Y * nx + X; if (nd < dist[k]) { dist[k] = nd; q.push(k); }
    }
  }
  const bits = new Uint8Array(nx * ny); let on = 0;
  for (let c = 0; c < nx * ny; c++) if (dist[c] <= rc) { bits[c] = 1; on++; }
  return { u0, v0, cell, nx, ny, bits, cells: on };
}

// ревизия 37: контуры, обведённые мышью в окне «Перед загрузкой» (лассо): [{ op: 'add' | 'sub', pts: [u, v, u, v, ...] }] по порядку.
// Сетка — по рамке всех контуров; клетка выбрана, если её центр внутри контура (чёт-нечет). Если первая операция — «вырезать»,
// исходно выбрано всё (outsideOn = 1, и за сеткой тоже). Тот же расчёт — areaMaskJS в renderer/cloud-preview.js (оценка в окне).
function areaMask(areas, o) {
  o = o || {};
  const list = (Array.isArray(areas) ? areas : []).filter((a) => a && Array.isArray(a.pts) && a.pts.length >= 6);
  if (!list.length) return null;
  let U0 = Infinity, U1 = -Infinity, V0 = Infinity, V1 = -Infinity;
  for (const a of list) for (let i = 0; i + 1 < a.pts.length; i += 2) { const u = a.pts[i], v = a.pts[i + 1]; if (u < U0) U0 = u; if (u > U1) U1 = u; if (v < V0) V0 = v; if (v > V1) V1 = v; }
  if (!(U1 >= U0 && V1 >= V0)) return null;
  const cell = Math.max(Number(o.cell) || 0.05, Math.sqrt(Math.max(1e-6, (U1 - U0) * (V1 - V0)) / 4e6));
  const u0 = U0 - cell, v0 = V0 - cell, nx = Math.ceil((U1 - U0) / cell) + 3, ny = Math.ceil((V1 - V0) / cell) + 3;
  const outsideOn = list[0].op === 'sub' ? 1 : 0, bits = new Uint8Array(nx * ny);
  if (outsideOn) bits.fill(1);
  const xs = [];
  for (const a of list) {
    const P = a.pts, m = Math.floor(P.length / 2), val = a.op === 'sub' ? 0 : 1;
    let pv0 = Infinity, pv1 = -Infinity;
    for (let i = 0; i < m; i++) { const v = P[i * 2 + 1]; if (v < pv0) pv0 = v; if (v > pv1) pv1 = v; }
    const y0 = Math.max(0, Math.ceil((pv0 - v0) / cell - 0.5)), y1 = Math.min(ny - 1, Math.floor((pv1 - v0) / cell - 0.5));
    for (let y = y0; y <= y1; y++) {
      const vc = v0 + (y + 0.5) * cell; xs.length = 0;
      for (let i = 0, j = m - 1; i < m; j = i++) {
        const va = P[j * 2 + 1], vb = P[i * 2 + 1];
        if ((va <= vc) !== (vb <= vc)) { const ua = P[j * 2], ub = P[i * 2]; xs.push(ua + (vc - va) * (ub - ua) / (vb - va)); }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, Math.ceil((xs[k] - u0) / cell - 0.5)), x1 = Math.min(nx - 1, Math.floor((xs[k + 1] - u0) / cell - 0.5));
        if (x1 >= x0) bits.fill(val, y * nx + x0, y * nx + x1 + 1);
      }
    }
  }
  let on = 0; for (let c = 0; c < nx * ny; c++) on += bits[c];
  return { u0, v0, cell, nx, ny, bits, outsideOn, cells: on };
}

// ------------------------------------------------------------ горизонтальный срез для плана
function planSlice(desc, opts) {
  opts = opts || {};
  const h0 = Number(opts.h0), h1 = Number(opts.h1);
  if (!(h1 > h0)) return { ok: false, message: 'неверный диапазон высоты среза' };
  const rect = opts.rect || null, maxPts = Math.max(100000, Math.floor(opts.maxPoints || 12000000));
  // ревизия 29: второй, верхний срез (opts.high = { h0, h1 }, обычно у потолка) — тем же проходом: по нему план отличает стены
  // от мебели и стеллажей у стен (у них нет точек над собой)
  // ревизия 30: opts.high.bands = K (до 8) — колонка над срезом делится на K полос по высоте, у каждой точки — номер полосы (bandHigh)
  const hi = opts.high && Number(opts.high.h1) > Number(opts.high.h0) ? { h0: Number(opts.high.h0), h1: Number(opts.high.h1), K: Math.max(1, Math.min(8, Math.floor(Number(opts.high.bands) || 1))) } : null;
  if (hi) hi.band = (h) => hi.K > 1 ? Math.max(0, Math.min(hi.K - 1, Math.floor((h - hi.h0) / (hi.h1 - hi.h0) * hi.K))) : 0;
  const H = hi ? highAcc(Math.max(100000, Math.floor(opts.maxHigh || 6000000)), hi.K) : null;
  if (desc.kind === 'e57') return planSliceE57(desc, h0, h1, rect, opts, hi, H);
  const D = makeDecoder(desc), rl = D.recLen, total = desc.count;
  const perChunk = Math.max(1, Math.floor((8 << 20) / rl)), buf = Buffer.allocUnsafe(perChunk * rl);
  let cap = Math.min(maxPts, 1 << 20), uv = new Float32Array(cap * 2), n = 0, stride = 1, tick = 0;
  const o = { u: 0, v: 0, h: 0, r: 0, g: 0, b: 0, i: 0, t: NaN };
  const fd = fs.openSync(desc.path, 'r');
  try {
    for (let first = 0; first < total; first += perChunk) {
      if (opts.signal && opts.signal.aborted) return { ok: false, cancelled: true, message: 'отменено' };
      const cnt = Math.min(perChunk, total - first);
      const got = Math.floor(readExact(fd, buf, cnt * rl, D.start + first * rl) / rl);
      for (let j = 0; j < got; j++) {
        const base = j * rl, h = D.hOf(buf, base);
        if (H && h >= hi.h0 && h <= hi.h1) { D.dec(buf, base, o); if (!rect || (o.u >= rect.u0 && o.u <= rect.u1 && o.v >= rect.v0 && o.v <= rect.v1)) H.add(o.u, o.v, hi.band(h)); if (!(h >= h0 && h <= h1)) continue; }
        if (!(h >= h0 && h <= h1)) continue;
        if (stride > 1 && (++tick % stride)) continue;
        D.dec(buf, base, o);
        if (rect && (o.u < rect.u0 || o.u > rect.u1 || o.v < rect.v0 || o.v > rect.v1)) continue;
        if (n >= cap) {
          if (cap < maxPts) { const nc = Math.min(maxPts, cap * 2), a = new Float32Array(nc * 2); a.set(uv); uv = a; cap = nc; }
          else { let w = 0; for (let k = 0; k < n; k += 2) { uv[w * 2] = uv[k * 2]; uv[w * 2 + 1] = uv[k * 2 + 1]; w++; } n = w; stride *= 2; }
        }
        uv[n * 2] = o.u; uv[n * 2 + 1] = o.v; n++;
      }
      if (opts.onProgress) opts.onProgress(Math.min(1, (first + cnt) / total));
    }
  } finally { fs.closeSync(fd); }
  return withHigh({ ok: true, uv: uv.slice(0, n * 2), count: n, stride, read: total, h0, h1 }, hi, H);
}

// накопитель верхнего среза: при переполнении — каждая вторая точка, дальше берётся каждая 2^k-я (равномерно по файлу);
// K > 1 — с номером полосы по высоте у каждой точки
function highAcc(maxPts, K) {
  let cap = Math.min(maxPts, 1 << 18), uv = new Float32Array(cap * 2), bd = K > 1 ? new Uint8Array(cap) : null, n = 0, stride = 1, tick = 0;
  return {
    add(u, v, k) {
      if (stride > 1 && (++tick % stride)) return;
      if (n >= cap) {
        if (cap < maxPts) { const nc = Math.min(maxPts, cap * 2), a = new Float32Array(nc * 2); a.set(uv); uv = a; if (bd) { const c = new Uint8Array(nc); c.set(bd); bd = c; } cap = nc; }
        else { let w = 0; for (let j = 0; j < n; j += 2) { uv[w * 2] = uv[j * 2]; uv[w * 2 + 1] = uv[j * 2 + 1]; if (bd) bd[w] = bd[j]; w++; } n = w; stride *= 2; }
      }
      uv[n * 2] = u; uv[n * 2 + 1] = v; if (bd) bd[n] = k || 0; n++;
    },
    done() { return { uv: uv.slice(0, n * 2), band: bd ? bd.slice(0, n) : null, count: n, stride }; }
  };
}
function withHigh(res, hi, H) {
  if (!H) return res;
  const r = H.done();
  res.uvHigh = r.uv; res.countHigh = r.count; res.hi0 = hi.h0; res.hi1 = hi.h1; res.highBands = hi.K;
  if (r.band) res.bandHigh = r.band;
  return res;
}

// E57: равномерная выборка всего файла (opts.e57Points, по умолчанию 10 млн) → точки в слое h0–h1 (координаты карты: origin из overview);
// ревизия 29: при указателе пакетов (desc.e57) — все точки файла одним проходом, предел maxPoints — как у LAS (каждая 2^k-я точка слоя)
function planSliceE57(desc, h0, h1, rect, opts, hi, H) {
  if (!Number.isFinite(desc.cx)) return { ok: false, message: 'сначала постройте карту облака E57' };
  if (desc.e57) return planSliceE57Parts(desc, h0, h1, rect, opts, hi, H);
  const r = e57Sample(desc, Math.max(100000, Math.floor(opts.e57Points || 10000000)), opts.onProgress);
  const P = r.pos, n0 = r.count, uv = new Float32Array(n0 * 2);
  let n = 0;
  for (let i = 0; i < n0; i++) {
    const h = P[i * 3 + 2] - desc.cz, hiOk = H && h >= hi.h0 && h <= hi.h1; if (!hiOk && !(h >= h0 && h <= h1)) continue;
    const u = P[i * 3] - desc.cx, v = P[i * 3 + 1] - desc.cy;
    if (rect && (u < rect.u0 || u > rect.u1 || v < rect.v0 || v > rect.v1)) continue;
    if (hiOk) { H.add(u, v, hi.band(h)); if (!(h >= h0 && h <= h1)) continue; }
    uv[n * 2] = u; uv[n * 2 + 1] = v; n++;
  }
  return withHigh({ ok: true, uv: uv.slice(0, n * 2), count: n, stride: Math.max(1, Math.ceil(r.total / Math.max(1, n0))), read: r.total, h0, h1 }, hi, H);
}

function planSliceE57Parts(desc, h0, h1, rect, opts, hi, H) {
  const ES = require('./e57-segments');
  const maxPts = Math.max(100000, Math.floor(opts.maxPoints || 12000000)), cx = desc.cx, cy = desc.cy, cz = desc.cz;
  let cap = Math.min(maxPts, 1 << 20), uv = new Float32Array(cap * 2), n = 0, stride = 1, tick = 0;
  const STOP = {};
  const fd = fs.openSync(desc.path, 'r');
  try {
    ES.e57Each(desc, fd, 0, desc.count, (x, y, z) => {
      const h = z - cz, inMain = h >= h0 && h <= h1;
      if (H && h >= hi.h0 && h <= hi.h1) { const u = x - cx, v = y - cy; if (!rect || (u >= rect.u0 && u <= rect.u1 && v >= rect.v0 && v <= rect.v1)) H.add(u, v, hi.band(h)); }
      if (!inMain) return;
      if (stride > 1 && (++tick % stride)) return;
      const u = x - cx, v = y - cy;
      if (rect && (u < rect.u0 || u > rect.u1 || v < rect.v0 || v > rect.v1)) return;
      if (n >= cap) {
        if (cap < maxPts) { const nc = Math.min(maxPts, cap * 2), a = new Float32Array(nc * 2); a.set(uv); uv = a; cap = nc; }
        else { let w = 0; for (let k = 0; k < n; k += 2) { uv[w * 2] = uv[k * 2]; uv[w * 2 + 1] = uv[k * 2 + 1]; w++; } n = w; stride *= 2; }
      }
      uv[n * 2] = u; uv[n * 2 + 1] = v; n++;
    }, (f) => { if (opts.signal && opts.signal.aborted) throw STOP; if (opts.onProgress) opts.onProgress(Math.min(1, f)); });
  } catch (e) {
    if (e === STOP) return { ok: false, cancelled: true, message: 'отменено' };
    throw e;
  } finally { fs.closeSync(fd); }
  return withHigh({ ok: true, uv: uv.slice(0, n * 2), count: n, stride, read: desc.count, h0, h1 }, hi, H);
}

// ревизия 31: проход по всем точкам слоя h0–h1 (контроль геометрии: пол и стены) — fn(u, v, h) в координатах карты; LAS, PLY и E57
// (по указателю пакетов; без указателя — по выборке, как срез плана). Возвращает { ok, read, used, sampled }
function eachPoint(desc, opts, fn) {
  opts = opts || {};
  const h0 = Number(opts.h0), h1 = Number(opts.h1), rect = opts.rect || null;
  if (!(h1 > h0)) return { ok: false, message: 'неверный диапазон высоты' };
  const inRect = rect ? (u, v) => u >= rect.u0 && u <= rect.u1 && v >= rect.v0 && v <= rect.v1 : null;
  let used = 0;
  if (desc.kind === 'e57') {
    if (!Number.isFinite(desc.cx)) return { ok: false, message: 'сначала постройте карту облака E57' };
    const cx = desc.cx, cy = desc.cy, cz = desc.cz;
    if (!desc.e57) {
      const r = e57Sample(desc, Math.max(100000, Math.floor(opts.e57Points || 10000000)), opts.onProgress), P = r.pos;
      for (let i = 0; i < r.count; i++) { const h = P[i * 3 + 2] - cz; if (!(h >= h0 && h <= h1)) continue; const u = P[i * 3] - cx, v = P[i * 3 + 1] - cy; if (inRect && !inRect(u, v)) continue; used++; fn(u, v, h); }
      return { ok: true, read: r.total, used, sampled: true };
    }
    const ES = require('./e57-segments'), STOP = {}, fd = fs.openSync(desc.path, 'r');
    try {
      ES.e57Each(desc, fd, 0, desc.count, (x, y, z) => { const h = z - cz; if (!(h >= h0 && h <= h1)) return; const u = x - cx, v = y - cy; if (inRect && !inRect(u, v)) return; used++; fn(u, v, h); },
        (f) => { if (opts.signal && opts.signal.aborted) throw STOP; if (opts.onProgress) opts.onProgress(Math.min(1, f)); });
    } catch (e) { if (e === STOP) return { ok: false, cancelled: true, message: 'отменено' }; throw e; }
    finally { fs.closeSync(fd); }
    return { ok: true, read: desc.count, used, sampled: false };
  }
  const D = makeDecoder(desc), rl = D.recLen, total = desc.count;
  const perChunk = Math.max(1, Math.floor((8 << 20) / rl)), buf = Buffer.allocUnsafe(perChunk * rl), o = { u: 0, v: 0, h: 0, r: 0, g: 0, b: 0, i: 0, t: NaN };
  const fd = fs.openSync(desc.path, 'r');
  try {
    for (let first = 0; first < total; first += perChunk) {
      if (opts.signal && opts.signal.aborted) return { ok: false, cancelled: true, message: 'отменено' };
      const cnt = Math.min(perChunk, total - first), got = Math.floor(readExact(fd, buf, cnt * rl, D.start + first * rl) / rl);
      for (let j = 0; j < got; j++) {
        const base = j * rl, h = D.hOf(buf, base); if (!(h >= h0 && h <= h1)) continue;
        D.dec(buf, base, o); if (inRect && !inRect(o.u, o.v)) continue;
        used++; fn(o.u, o.v, h, o);
      }
      if (opts.onProgress) opts.onProgress(Math.min(1, (first + cnt) / total));
    }
  } finally { fs.closeSync(fd); }
  return { ok: true, read: total, used, sampled: false };
}

module.exports = { eachPoint, openE57, overview, planSlice, trajectoryInfo, routeMask, areaMask, parsePoses, makeDecoder, chooseCell, findLevels, surfaceArea, hShift };
