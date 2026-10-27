'use strict';
/*
 * xbin-lidar.js — облако точек из сырого лидара в файле сканера XGRIDS Lixel (*.xbin), ревизия 24.
 *
 * В .xbin записаны пакеты лидара (Hesai PandarXT-32, 20 оборотов/с, ~410 тыс. точек/с) в системе самого лидара, а лидар
 * вращается мотором. Облако в координатах проекта: точка лидара → extrinsic_motor_lidar → поворот мотора → extrinsic_imu_motor →
 * поза IMU из траектории poses.csv (t,x,y,z,qx,qy,qz,qw) в момент точки.
 *   p_мир = Pose(t) · T_imu_motor · Ry(φ(t)) · T_motor_lidar · p_лидар
 * Мотор: сообщения 200 Гц, поля 5 и 7 (zigzag) — cos и sin половины угла; φ = 2·atan2(sin, cos), ось — y системы мотора.
 * Проверено на реальной съёмке L2 Pro: расхождение точек одной поверхности за разные обороты мотора — 5–9 мм (медиана).
 *
 * Сообщение лидара: 1 {1: номер, 2: время (zigzag, мкс)}, повторяющееся 2 {1,2,3: x,y,z (zigzag, мм), 4: интенсивность,
 * 5: кольцо 0–31, 6: смещение времени точки (zigzag, мкс)}; нулевые x,y,z — нет отражения.
 * Результат — LAS 1.2, формат 3 (время точки = время .xbin/poses.csv, цвет = яркость отражения), годится для «Цвета по фото сканера».
 */
const fs = require('node:fs');
const XB = require('./xbin-core');
const RC = require('./recolor-core');

const HDR = XB.HDR;
const zz = (v) => (v % 2 ? -(v + 1) / 2 : v / 2);

// ---- разбор полей сообщения верхнего уровня: [{f, wt, v | a, e}] без копирования
function* fieldsOf(b, p, end) {
  while (p < end) {
    let tag; [tag, p] = XB.varint(b, p); if (!Number.isFinite(tag)) return;
    const f = Math.floor(tag / 8), wt = tag & 7;
    if (wt === 0) { let v; [v, p] = XB.varint(b, p); yield { f, wt, v }; }
    else if (wt === 2) { let l; [l, p] = XB.varint(b, p); if (!Number.isFinite(l) || p + l > end) return; yield { f, wt, a: p, e: p + l }; p += l; }
    else if (wt === 1) p += 8; else if (wt === 5) p += 4; else return;
  }
}
function messages(b) { const out = []; for (const x of fieldsOf(b, 0, b.length)) if (x.f === 1 && x.wt === 2) out.push(x); return out; }
function headerTime(b, a, e) {   // поле 1 сообщения → время, с
  for (const x of fieldsOf(b, a, e)) if (x.f === 1 && x.wt === 2) { for (const y of fieldsOf(b, x.a, x.e)) if (y.f === 2 && y.wt === 0) return zz(y.v) / 1e6; return null; }
  return null;
}

// мотор: {t, c, s} или null
function parseMotorMsg(b, a, e) {
  let t = null, c = null, s = null;
  for (const x of fieldsOf(b, a, e)) {
    if (x.f === 1 && x.wt === 2) { for (const y of fieldsOf(b, x.a, x.e)) if (y.f === 2 && y.wt === 0) t = zz(y.v) / 1e6; }
    else if (x.wt === 0 && x.f === 5) c = zz(x.v); else if (x.wt === 0 && x.f === 7) s = zz(x.v);
  }
  if (t == null || c == null || s == null) return null;
  const n = Math.hypot(c, s); if (!(n > 0)) return null;
  return { t, c: c / n, s: s / n, norm: n };
}
// IMU: {t, ax, ay, az (м/с²), gx, gy, gz (рад/с)} или null; в L2 Pro поля 2–4 — ускорение (1e-4 м/с²), 5–7 — гироскоп (1e-4 рад/с)
function parseImuMsg(b, a, e) {
  let t = null; const v = [null, null, null, null, null, null, null, null];
  for (const x of fieldsOf(b, a, e)) {
    if (x.f === 1 && x.wt === 2) { for (const y of fieldsOf(b, x.a, x.e)) if (y.f === 2 && y.wt === 0) t = zz(y.v) / 1e6; }
    else if (x.wt === 0 && x.f >= 2 && x.f <= 7) v[x.f] = zz(x.v);
    else if (x.wt === 2) return null;
  }
  if (t == null || v.slice(2, 8).some(q => q == null)) return null;
  return { t, ax: v[2] / 1e4, ay: v[3] / 1e4, az: v[4] / 1e4, gx: v[5] / 1e4, gy: v[6] / 1e4, gz: v[7] / 1e4 };
}
// пакет лидара похож на настоящий: ≥ 50 точек, у точек поля 1..6, кольцо 0..127
function looksLidar(b, a, e) {
  let pts = 0, ok = 0, hdr = false;
  for (const x of fieldsOf(b, a, e)) {
    if (x.f === 1 && x.wt === 2) hdr = true;
    else if (x.f === 2 && x.wt === 2) { pts++; if (pts > 200) break; let good = true; for (const y of fieldsOf(b, x.a, x.e)) { if (y.wt !== 0 || y.f > 8 || (y.f === 5 && y.v > 127)) { good = false; break; } } if (good) ok++; }
    else if (x.wt === 2) return false;
  }
  return hdr && pts >= 50 && ok >= pts * 0.95;
}

/**
 * scan(file) → { size, calib, first, lidarCh, motorCh, lidar: [{off, len, t}], motor: {t, phi} (φ без скачков), bytes, t0, t1 }
 * Каналы лидара и мотора определяются по содержимому первых записей (в L2 Pro — 3 и 4).
 */
function scan(file, onProgress) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = XB.readAt(fd, 0, Math.min(size, 4 << 20));
    if (head.toString('latin1', 0, 4) !== 'XBAG') throw new Error('это не файл сканера XGRIDS (*.xbin): нет подписи XBAG');
    const calib = XB.parseCalib(head) || {};
    const first = XB.findFirstRecord(head); if (first < 0) throw new Error('в файле .xbin не найдены записи данных');
    const kind = new Map();   // ch → 'lidar' | 'motor' | 'other'
    const lidar = [], mt = [], mc = [], ms = [], it = [], ig = [];
    const hb = Buffer.allocUnsafe(HDR); let p = first, last = 0, lidarBytes = 0;
    while (p + HDR <= size) {
      if (fs.readSync(fd, hb, 0, HDR, p) !== HDR) break;
      const r = XB.recordAt(hb, 0); if (!r || p + r.L > size) break;
      let k = kind.get(r.ch);
      if (k === undefined || k === 'motor' || k === 'imu') {
        const body = XB.readAt(fd, p + HDR, Math.min(r.L - HDR, k === 'motor' || k === 'imu' ? 1 << 20 : 2 << 20));
        const msgs = messages(body);
        if (k === undefined) {
          k = 'other';
          if (msgs.length && msgs[0].e - msgs[0].a < 512) { const m = parseMotorMsg(body, msgs[0].a, msgs[0].e); if (m && Math.abs(m.norm / 1e10 - 1) < 0.02) k = 'motor'; }
          if (k === 'other' && msgs.length && looksLidar(body, msgs[0].a, msgs[0].e)) k = 'lidar';
          if (k === 'other' && msgs.length >= 5 && msgs[0].e - msgs[0].a < 128) {   // IMU: |a| ≈ g у первых сообщений
            const ok = msgs.slice(0, 5).map(x => parseImuMsg(body, x.a, x.e)).filter(Boolean);
            if (ok.length === 5 && ok.every(m => Math.abs(Math.hypot(m.ax, m.ay, m.az) - 9.81) < 2.5 && Math.hypot(m.gx, m.gy, m.gz) < 20)) k = 'imu';
          }
          if (k !== 'other' && [...kind.values()].includes(k)) k = 'other';   // по одному каналу каждого вида
          kind.set(r.ch, k);
        }
        if (k === 'motor') for (const x of msgs) { const m = parseMotorMsg(body, x.a, x.e); if (m) { mt.push(m.t); mc.push(m.c); ms.push(m.s); } }
        if (k === 'imu') for (const x of msgs) { const m = parseImuMsg(body, x.a, x.e); if (m) { it.push(m.t); ig.push(m.gx, m.gy, m.gz); } }
      }
      if (k === 'lidar') { lidar.push({ off: p + HDR, len: r.L - HDR, t: r.t0 / 1e6 }); lidarBytes += r.L - HDR; }
      p += r.L;
      if (onProgress && p - last > (512 << 20)) { last = p; onProgress(p / size); }
    }
    // φ = 2·atan2(s, c) без скачков; время мотора — по возрастанию
    const o = mt.map((_, i) => i).sort((a, b) => mt[a] - mt[b]);
    const T = new Float64Array(o.length), PHI = new Float64Array(o.length);
    let prev = 0, acc = 0;
    for (let j = 0; j < o.length; j++) {
      const i = o[j]; let ph = 2 * Math.atan2(ms[i], mc[i]);
      if (j) { let d = ph - prev; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI)); acc += d; } else acc = ph;
      prev = ph; T[j] = mt[i]; PHI[j] = acc;
    }
    let lidarCh = null, motorCh = null, imuCh = null; for (const [ch, k] of kind) { if (k === 'lidar') lidarCh = ch; else if (k === 'motor') motorCh = ch; else if (k === 'imu') imuCh = ch; }
    lidar.sort((a, b) => a.t - b.t);
    const io = it.map((_, i) => i).sort((a, b) => it[a] - it[b]);
    const IT = new Float64Array(io.length), IG = new Float64Array(io.length * 3);
    io.forEach((i, j) => { IT[j] = it[i]; IG[j * 3] = ig[i * 3]; IG[j * 3 + 1] = ig[i * 3 + 1]; IG[j * 3 + 2] = ig[i * 3 + 2]; });
    return { size, calib, first, lidarCh, motorCh, imuCh, lidar, motor: { t: T, phi: PHI }, imu: { t: IT, g: IG }, bytes: lidarBytes,
      t0: lidar.length ? lidar[0].t : null, t1: lidar.length ? lidar[lidar.length - 1].t : null };
  } finally { fs.closeSync(fd); }
}

function m4(v, name) {
  if (!v || v.length !== 16 || !v.every(Number.isFinite)) throw new Error('в .xbin нет калибровки ' + name);
  return Float64Array.from(v);
}
// φ мотора в момент t и скорость (рад/с) рядом: линейно по соседним отсчётам
function motorAt(M, t, out) {
  const T = M.t, n = T.length; let lo = 0, hi = n - 1;
  if (t <= T[0]) lo = 0; else if (t >= T[n - 1]) lo = n - 2; else { while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; } }
  const j = Math.min(n - 1, lo + 1), dt = T[j] - T[lo];
  const w = dt > 0 ? (M.phi[j] - M.phi[lo]) / dt : 0;
  out[0] = M.phi[lo] + w * (t - T[lo]); out[1] = w; out[2] = Math.max(Math.abs(t - T[lo]), Math.abs(T[j] - t));
  return out;
}

// ---- траектория: позы poses.csv (5–10 Гц) + гироскоп IMU (200 Гц) между ними --------------------------------------------
// Ориентация между соседними позами — интеграл гироскопа от позы i, а накопленный уход (смещение нуля, шум) снимается
// поправкой, растущей линейно до позы i+1: R(τ) = R_i · ΔR_гиро(τ) · Exp(s·c), c = Log(ΔR_гиро(t_{i+1})ᵀ · R_iᵀ R_{i+1}).
// В узлах траектория совпадает с poses.csv, между ними повторяет быстрые повороты сканера, которых нет в 5-герцовых позах.
// Положение — кубический сплайн Эрмита по позам (касательные — центральные разности). Без IMU — slerp и линейно.
function qmul(a, b, o, oi) {   // [x,y,z,w]
  const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
  o[oi] = aw * bx + ax * bw + ay * bz - az * by; o[oi + 1] = aw * by - ax * bz + ay * bw + az * bx;
  o[oi + 2] = aw * bz + ax * by - ay * bx + az * bw; o[oi + 3] = aw * bw - ax * bx - ay * by - az * bz;
}
function qexp(x, y, z) { const th = Math.hypot(x, y, z); if (th < 1e-12) return [x / 2, y / 2, z / 2, 1]; const s = Math.sin(th / 2) / th; return [x * s, y * s, z * s, Math.cos(th / 2)]; }
function qlog(q) { let [x, y, z, w] = q; if (w < 0) { x = -x; y = -y; z = -z; w = -w; } const sn = Math.hypot(x, y, z); if (sn < 1e-12) return [2 * x, 2 * y, 2 * z]; const th = 2 * Math.atan2(sn, w); return [x / sn * th, y / sn * th, z / sn * th]; }
function qToMat(x, y, z, w, out) {
  out[0] = 1 - 2 * (y * y + z * z); out[1] = 2 * (x * y - z * w); out[2] = 2 * (x * z + y * w);
  out[4] = 2 * (x * y + z * w); out[5] = 1 - 2 * (x * x + z * z); out[6] = 2 * (y * z - x * w);
  out[8] = 2 * (x * z - y * w); out[9] = 2 * (y * z + x * w); out[10] = 1 - 2 * (x * x + y * y);
  out[12] = out[13] = out[14] = 0; out[15] = 1;
}
function bsearch(T, t) { const n = T.length; if (t <= T[0]) return 0; if (t >= T[n - 1]) return n - 2; let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; } return lo; }

function makeTrajectory(P, imu, opt) {
  const o = opt || {}, n = P.n;
  const shift = Number.isFinite(o.imuShift) ? o.imuShift : 0;
  const hermite = o.position !== 'linear';
  let DT = null, DQ = null, used = 0, gaps = 0, corr = [];
  if (o.imu !== false && imu && imu.t && imu.t.length > 100 && n >= 2) {
    const IT = imu.t, IG = imu.g, m = IT.length;
    const t = [], q = [];
    const gyro = (k) => [IG[k * 3], IG[k * 3 + 1], IG[k * 3 + 2]];
    for (let i = 0; i < n - 1; i++) {
      const ta = P.t[i], tb = P.t[i + 1], qa = Array.from(P.q.subarray(i * 4, i * 4 + 4)), qb = Array.from(P.q.subarray(i * 4 + 4, i * 4 + 8));
      t.push(ta); q.push(qa);
      // отсчёты IMU в (ta, tb) с учётом сдвига времени IMU
      let k0 = bsearch(IT, ta - shift); if (IT[k0] + shift < ta) k0++;
      let k1 = bsearch(IT, tb - shift) + 1; if (k1 < m && IT[k1] + shift <= tb) k1++;
      k1 = Math.min(k1, m);
      const ok = k0 > 0 && k1 < m && k1 - k0 >= 2 && (IT[k0] + shift - ta) < 0.02 && (tb - IT[k1 - 1] - shift) < 0.02 &&
        (() => { for (let k = k0; k < k1; k++) if (IT[k] - IT[k - 1] > 0.02) return false; return true; })();
      if (!ok) { gaps++; continue; }
      used++;
      // интеграл: ω — линейно между отсчётами, шаг — середина отрезка
      const nodes = [], quats = [];
      let cur = qa.slice(), tau = ta, kk = k0;
      const omegaAt = (tt) => { const j = Math.max(0, Math.min(m - 2, bsearch(IT, tt - shift))); const w = (tt - shift - IT[j]) / (IT[j + 1] - IT[j]); const a = gyro(j), b = gyro(j + 1); return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w]; };
      const step = (t2) => { const h = t2 - tau; if (h <= 0) return; const w = omegaAt(tau + h / 2); const d = qexp(w[0] * h, w[1] * h, w[2] * h); const r = [0, 0, 0, 0]; qmul(cur, d, r, 0); const nn = Math.hypot(r[0], r[1], r[2], r[3]); cur = r.map(v => v / nn); tau = t2; };
      for (; kk < k1; kk++) { step(IT[kk] + shift); nodes.push(tau); quats.push(cur.slice()); }
      step(tb);
      const inv = [-cur[0], -cur[1], -cur[2], cur[3]], dq = [0, 0, 0, 0]; qmul(inv, qb, dq, 0);
      const c = qlog(dq); corr.push(Math.hypot(c[0], c[1], c[2]));
      for (let j = 0; j < nodes.length; j++) {
        const s = (nodes[j] - ta) / (tb - ta), e = qexp(c[0] * s, c[1] * s, c[2] * s), r = [0, 0, 0, 0]; qmul(quats[j], e, r, 0);
        const nn = Math.hypot(r[0], r[1], r[2], r[3]); t.push(nodes[j]); q.push(r.map(v => v / nn));
      }
    }
    t.push(P.t[n - 1]); q.push(Array.from(P.q.subarray((n - 1) * 4, n * 4)));
    DT = Float64Array.from(t); DQ = new Float64Array(q.length * 4);
    for (let i = 1; i < q.length; i++) { const a = q[i - 1], b = q[i]; if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0) for (let k = 0; k < 4; k++) b[k] = -b[k]; }
    q.forEach((v, i) => DQ.set(v, i * 4));
    if (!used) { DT = null; DQ = null; }
  }
  // касательные сплайна положения
  const V = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1), dt = P.t[b] - P.t[a];
    for (let k = 0; k < 3; k++) V[i * 3 + k] = dt > 0 ? (P.p[b * 3 + k] - P.p[a * 3 + k]) / dt : 0;
  }
  function poseAt(tt, out) {
    out = out || new Float64Array(16);
    if (DT) {
      const j = bsearch(DT, tt), a = DQ.subarray(j * 4, j * 4 + 4), b = DQ.subarray(j * 4 + 4, j * 4 + 8);
      let w = (tt - DT[j]) / (DT[j + 1] - DT[j]); if (!(w >= 0)) w = 0; else if (w > 1) w = 1;
      let x = a[0] + (b[0] - a[0]) * w, y = a[1] + (b[1] - a[1]) * w, z = a[2] + (b[2] - a[2]) * w, ww = a[3] + (b[3] - a[3]) * w;   // шаг 5 мс — nlerp
      const qn = Math.hypot(x, y, z, ww); qToMat(x / qn, y / qn, z / qn, ww / qn, out);
    } else RC.poseAt(P, tt, out);
    const i = bsearch(P.t, tt), j = Math.min(n - 1, i + 1), h = P.t[j] - P.t[i];
    let s = h > 0 ? (tt - P.t[i]) / h : 0; if (s < 0) s = 0; else if (s > 1) s = 1;
    if (hermite && h > 0) {
      const s2 = s * s, s3 = s2 * s, h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
      for (let k = 0; k < 3; k++) out[k * 4 + 3] = h00 * P.p[i * 3 + k] + h10 * h * V[i * 3 + k] + h01 * P.p[j * 3 + k] + h11 * h * V[j * 3 + k];
    } else for (let k = 0; k < 3; k++) out[k * 4 + 3] = P.p[i * 3 + k] + (P.p[j * 3 + k] - P.p[i * 3 + k]) * s;
    return out;
  }
  corr.sort((a, b) => a - b);
  return { poseAt, imu: !!DT, intervals: n - 1, imuIntervals: used, gaps, nodes: DT ? DT.length : n, position: hermite ? 'hermite' : 'linear',
    corrMedianDeg: corr.length ? corr[corr.length >> 1] * 180 / Math.PI : null };
}

// ---- LAS 1.2, формат 3 (34 байта): XYZ int32 (0,001 м), интенсивность, возврат 1 из 1, класс 0, кольцо → user data, время, RGB
function lasHeader(o) {
  const h = Buffer.alloc(227);
  h.write('LASF', 0, 'latin1'); h[24] = 1; h[25] = 2;
  h.write('BIM Twin', 26, 'latin1'); h.write('BIM Twin xbin-lidar r25', 58, 'latin1');
  const d = new Date(); const doy = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;
  h.writeUInt16LE(doy, 90); h.writeUInt16LE(d.getUTCFullYear(), 92);
  h.writeUInt16LE(227, 94); h.writeUInt32LE(227, 96); h.writeUInt32LE(0, 100); h[104] = 3; h.writeUInt16LE(34, 105);
  h.writeUInt32LE(o.n, 107); h.writeUInt32LE(o.n, 111);
  for (let k = 0; k < 3; k++) h.writeDoubleLE(0.001, 131 + 8 * k);
  h.writeDoubleLE(o.ox, 155); h.writeDoubleLE(o.oy, 163); h.writeDoubleLE(o.oz, 171);
  h.writeDoubleLE(o.max[0], 179); h.writeDoubleLE(o.min[0], 187); h.writeDoubleLE(o.max[1], 195); h.writeDoubleLE(o.min[1], 203); h.writeDoubleLE(o.max[2], 211); h.writeDoubleLE(o.min[2], 219);
  return h;
}

const DEF = { minRange: 0.5, maxRange: 120, maxPoints: 40e6, step: 0, t0: null, t1: null, maxMotorGap: 0.05, imu: true, imuShift: 0, position: 'hermite', poseStep: 0.005,
  refine: false, selfRadius: 0.6, edge: true, edgeMin: 0.15, edgeRel: 0.02, edgeGap: 0.0003 };

// подготовка: оглавление, калибровки, траектория, отбор пакетов по времени
function prepare(xbinPath, posesText, o, prog) {
  const S = o.index || scan(xbinPath, (f) => prog(0.1 * f, 'Облако из .xbin: оглавление файла…'));
  if (!S.lidar.length) throw new Error('в .xbin не найдены пакеты лидара');
  if (S.motor.t.length < 2) throw new Error('в .xbin нет угла мотора лидара');
  const P = RC.parsePoses(posesText || ''); if (P.n < 2) throw new Error('нужна траектория сканера poses.csv (t,x,y,z,qx,qy,qz,qw) из папки проекта');
  if (Number.isFinite(o.poseShift) && o.poseShift) for (let i = 0; i < P.n; i++) P.t[i] += o.poseShift;   // сдвиг часов poses.csv относительно лидара, с
  const EML = m4(S.calib && S.calib.motorLidar, 'extrinsic_motor_lidar'), EIM = m4(S.calib && S.calib.imuMotor, 'extrinsic_imu_motor');
  const T0 = Math.max(P.t[0], o.t0 != null ? o.t0 : -Infinity, S.motor.t[0]), T1 = Math.min(P.t[P.n - 1], o.t1 != null ? o.t1 : Infinity, S.motor.t[S.motor.t.length - 1]);
  const recs = S.lidar.filter(r => r.t >= T0 - 1.5 && r.t <= T1 + 0.1);   // в записи — несколько пакетов (до ~0,3 с)
  if (!recs.length || !(T1 > T0)) throw new Error('время пакетов лидара не совпадает с траекторией poses.csv');
  const TR = makeTrajectory(P, S.imu, o);
  return { S, P, EML, EIM, T0, T1, recs, TR };
}

/**
 * walk(fd, C, o, w0, w1, step, cb, onBytes) — все точки лидара с w0 ≤ t ≤ w1 (каждая step-я после фильтра дальности):
 *   cb(x, y, z, t, intensity, ring, cx, cy, cz, bx, by, bz) — мир; c — положение сканера (IMU) в момент точки; b — точка в системе IMU.
 * Поза — по сетке 5 мс внутри пакета (C.TR.poseAt учитывает гироскоп и поправки уточнения).
 */
function walk(fd, C, o, w0, w1, step, cb, onBytes) {
  const { S, EML: A, EIM: B, TR } = C, T0 = Math.max(C.T0, w0), T1 = Math.min(C.T1, w1);
  const H = o.poseStep > 0 ? o.poseStep : 0.005, KN = Math.ceil(0.07 / H) + 2;
  const PM = new Float64Array(KN * 16), tmpM = new Float64Array(16), MA = new Float64Array(3);
  const r2min = o.minRange * o.minRange, r2max = o.maxRange > 0 ? o.maxRange * o.maxRange : Infinity;
  const s2 = o.selfRadius > 0 ? o.selfRadius * o.selfRadius : 0;   // «самомаска»: отражения от корпуса сканера (≤ 0,5 м от IMU, в мёртвой зоне лидара 0,5–1,2 м точек нет)
  let cnt = 0, skipped = 0, empty = 0, packets = 0, self = 0;
  let buf = Buffer.allocUnsafe(1 << 20);
  // ревизия 37: фильтр «смешанных отражений» и одиночных скачков дальности по кольцу лидара (как у Lixel Studio и драйверов Hesai).
  // Соседи точки — предыдущие и следующие отражения ТОГО ЖЕ кольца (через ~50 мкс, 0,36° по азимуту); пустое отражение — «бесконечность».
  // Удаляется точка, у которой дальность отличается от обоих соседей больше чем на max(edgeMin, edgeRel·r) и при этом это
  // одиночный выброс (оба соседа ближе или оба дальше: пыль, капли, блики) или точка «между» двумя ровными участками на краю предмета
  // (смешанное отражение края — «бахрома» и хвосты за предметами). Наклонная к лучу плоскость (пол, фасад вдоль пути) не страдает:
  // у неё дальность меняется плавно и с обеих сторон. Если соседей нет (разрыв по времени > edgeGap, начало/конец окна) — точка остаётся.
  // Решение по точке откладывается на 2 отражения её кольца; вызовы cb идут в том же порядке внутри кольца.
  const EDGE = o.edge !== false && o.edge !== 0, eMin = o.edgeMin > 0 ? o.edgeMin : 0.15, eRel = o.edgeRel >= 0 ? o.edgeRel : 0.02, eGap = o.edgeGap > 0 ? o.edgeGap : 0.0003;
  const NR = 256, Hr = new Float64Array(NR * 5), Ht = new Float64Array(NR * 5).fill(-1e18), Hp = new Uint8Array(NR * 5), Hv = new Float64Array(NR * 5 * 12), Hh = new Uint8Array(NR);
  let edge = 0;
  const isEdge = (b0, h) => {
    const i0 = b0 + h, i1 = b0 + (h + 1) % 5, i2 = b0 + (h + 2) % 5, i3 = b0 + (h + 3) % 5, i4 = b0 + (h + 4) % 5, t2 = Ht[i2];
    if (!(Math.abs(Ht[i1] - t2) <= eGap && Math.abs(Ht[i3] - t2) <= eGap)) return false;
    const r2 = Hr[i2], T = Math.max(eMin, eRel * r2), A = r2 - Hr[i1], B = r2 - Hr[i3];
    if (!(Math.abs(A) > T && Math.abs(B) > T)) return false;
    if ((A > 0) === (B > 0)) return true;
    return (Math.abs(Ht[i1] - Ht[i0]) <= eGap && Math.abs(Hr[i1] - Hr[i0]) < T * 0.5) || (Math.abs(Ht[i4] - Ht[i3]) <= eGap && Math.abs(Hr[i4] - Hr[i3]) < T * 0.5);
  };
  // новое отражение кольца ring: сдвиг окна из 5, решение по средней (третьей) точке
  const slot = (ring, t, r, keep, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11) => {
    const b0 = (ring & 255) * 5, h = (Hh[ring & 255] + 1) % 5; Hh[ring & 255] = h;
    const i4 = b0 + (h + 4) % 5;
    Hr[i4] = r; Ht[i4] = t; Hp[i4] = keep ? 1 : 0;
    if (keep) { const q = i4 * 12; Hv[q] = a0; Hv[q + 1] = a1; Hv[q + 2] = a2; Hv[q + 3] = a3; Hv[q + 4] = a4; Hv[q + 5] = a5; Hv[q + 6] = a6; Hv[q + 7] = a7; Hv[q + 8] = a8; Hv[q + 9] = a9; Hv[q + 10] = a10; Hv[q + 11] = a11; }
    const i2 = b0 + (h + 2) % 5;
    if (!Hp[i2]) return;
    Hp[i2] = 0;
    if (isEdge(b0, h)) { edge++; return; }
    const q = i2 * 12; cb(Hv[q], Hv[q + 1], Hv[q + 2], Hv[q + 3], Hv[q + 4], Hv[q + 5], Hv[q + 6], Hv[q + 7], Hv[q + 8], Hv[q + 9], Hv[q + 10], Hv[q + 11]);
  };
  for (const r of C.recs) {
    if (r.t < T0 - 1.5 || r.t > T1 + 0.1) continue;
    packets++;
    if (buf.length < r.len) buf = Buffer.allocUnsafe(r.len * 2);
    let got = 0; while (got < r.len) { const k = fs.readSync(fd, buf, got, r.len - got, r.off + got); if (!k) break; got += k; }
    const b = buf; const end = got;
    let p = 0;
    while (p < end) {
      let tag = b[p++]; if (tag & 0x80) { [tag, p] = XB.varint(b, p - 1); }
      if (tag !== 10) break;
      let l, q; [l, q] = XB.varint(b, p); const me = q + l; p = q; if (me > end) break;
      let th = null, pp = p;
      while (pp < me) {   // заголовок сообщения (поле 1 идёт первым): время, мкс
        const tg = b[pp++];
        if (tg === 10) { let hl; [hl, pp] = XB.varint(b, pp); const he = pp + hl; while (pp < he) { let t2; [t2, pp] = XB.varint(b, pp); if ((t2 & 7) === 0) { let v; [v, pp] = XB.varint(b, pp); if ((t2 >>> 3) === 2) th = zz(v) / 1e6; } else { pp = he; } } pp = he; }
        else { pp--; break; }
      }
      p = me;
      if (th == null || th < T0 - 0.06 || th > T1) { skipped++; continue; }
      const tm = Math.min(T1, Math.max(T0, th));
      motorAt(S.motor, th, MA); if (MA[2] > o.maxMotorGap) { skipped++; continue; }
      for (let k = 0; k < KN; k++) { TR.poseAt(Math.min(C.T1, tm + k * H), tmpM); PM.set(tmpM, k * 16); }
      const phi0 = MA[0]; motorAt(S.motor, th + 0.05, MA); const w = (MA[0] - phi0) / 0.05;   // скорость мотора — по окну пакета
      while (pp < me) {
        const tg = b[pp++];
        if (tg !== 0x12) {   // прочие поля — пропуск
          pp--; let t3; [t3, pp] = XB.varint(b, pp); const wt = t3 & 7;
          if (wt === 0) { [, pp] = XB.varint(b, pp); } else if (wt === 2) { let l3; [l3, pp] = XB.varint(b, pp); pp += l3; } else if (wt === 1) pp += 8; else if (wt === 5) pp += 4; else { pp = me; }
          continue;
        }
        let pl = b[pp++]; if (pl & 0x80) { [pl, pp] = XB.varint(b, pp - 1); }
        const pe = pp + pl;
        let X = 0, Y = 0, Z = 0, I = 0, R = 0, D = 0;
        while (pp < pe) {
          const f = b[pp++] >>> 3;
          let v = b[pp++];
          if (v & 0x80) { v &= 0x7f; let s = 128, c; do { c = b[pp++]; v += (c & 0x7f) * s; s *= 128; } while (c & 0x80); }
          switch (f) { case 1: X = v; break; case 2: Y = v; break; case 3: Z = v; break; case 4: I = v; break; case 5: R = v; break; case 6: D = v; break; default: break; }
        }
        pp = pe;
        if (!(X | Y | Z)) { empty++; if (EDGE) slot(R, th + zz(D) / 1e6, Infinity, false); continue; }
        const x = zz(X) / 1000, y = zz(Y) / 1000, z = zz(Z) / 1000, d2 = x * x + y * y + z * z;
        const dt = zz(D) / 1e6, t = th + dt;
        if (d2 < r2min || d2 > r2max || (cnt++ % step) !== 0 || t < T0 || t > T1) { if (EDGE) slot(R, t, Math.sqrt(d2), false); continue; }
        // лидар → мотор → поворот мотора → IMU
        const qx = A[0] * x + A[1] * y + A[2] * z + A[3], qy = A[4] * x + A[5] * y + A[6] * z + A[7], qz = A[8] * x + A[9] * y + A[10] * z + A[11];
        const ph = phi0 + w * dt, c = Math.cos(ph), s = Math.sin(ph);
        const rx = c * qx + s * qz, rz = -s * qx + c * qz;
        const mxx = B[0] * rx + B[1] * qy + B[2] * rz + B[3], myy = B[4] * rx + B[5] * qy + B[6] * rz + B[7], mzz = B[8] * rx + B[9] * qy + B[10] * rz + B[11];
        if (mxx * mxx + myy * myy + mzz * mzz < s2) { self++; if (EDGE) slot(R, t, Math.sqrt(d2), false); continue; }
        // поза в момент точки: линейно между позами сетки 5 мс (поворот за 5 мс < 1°, ошибка смешения ≪ 0,1 мм)
        let u = (t - tm) / H; if (u < 0) u = 0; let kq = Math.floor(u); if (kq > KN - 2) { kq = KN - 2; u = KN - 1; }
        const a1 = u - kq, a0 = 1 - a1, i0 = kq * 16, i1 = i0 + 16;
        const cx = PM[i0 + 3] * a0 + PM[i1 + 3] * a1, cy = PM[i0 + 7] * a0 + PM[i1 + 7] * a1, cz = PM[i0 + 11] * a0 + PM[i1 + 11] * a1;
        const wx = (PM[i0] * a0 + PM[i1] * a1) * mxx + (PM[i0 + 1] * a0 + PM[i1 + 1] * a1) * myy + (PM[i0 + 2] * a0 + PM[i1 + 2] * a1) * mzz + cx;
        const wy = (PM[i0 + 4] * a0 + PM[i1 + 4] * a1) * mxx + (PM[i0 + 5] * a0 + PM[i1 + 5] * a1) * myy + (PM[i0 + 6] * a0 + PM[i1 + 6] * a1) * mzz + cy;
        const wz = (PM[i0 + 8] * a0 + PM[i1 + 8] * a1) * mxx + (PM[i0 + 9] * a0 + PM[i1 + 9] * a1) * myy + (PM[i0 + 10] * a0 + PM[i1 + 10] * a1) * mzz + cz;
        if (EDGE) slot(R, t, Math.sqrt(d2), true, wx, wy, wz, t, I, R, cx, cy, cz, mxx, myy, mzz);
        else cb(wx, wy, wz, t, I, R, cx, cy, cz, mxx, myy, mzz);
      }
    }
    if (onBytes) onBytes(r.len);
  }
  // конец окна: отложенные точки — без правых соседей, остаются
  if (EDGE) for (let ring = 0; ring < NR; ring++) { slot(ring, -1e18, Infinity, false); slot(ring, -1e18, Infinity, false); }
  return { skipped, empty, packets, self, edge };
}

/**
 * build(xbinPath, posesText, outLas, opt, onProgress) → { points, step, t0, t1, seconds, skipped, trajectory, refine, ... }
 *   opt: minRange/maxRange (м, от лидара), maxPoints (прорежение каждой k-й точкой, k подбирается по объёму пакетов),
 *        step (k вручную), t0/t1 (UNIX-время, с), index (готовый результат scan()), imu (гироскоп между позами, по умолчанию да),
 *        refine (уточнение траектории по самому облаку — xbin-refine.js; дольше, но стены и пол тоньше).
 */
function build(xbinPath, posesText, outLas, opt, onProgress) {
  const o = Object.assign({}, DEF, opt || {});
  const prog = typeof onProgress === 'function' ? onProgress : () => {};
  const C = prepare(xbinPath, posesText, o, prog);
  const { recs, T0, T1, P } = C;
  const fd = fs.openSync(xbinPath, 'r');
  const tmp = outLas + '.part';
  let ofd = null;
  try {
    // прорежение: ≈ 20,5 байта на точку в пакетах L2 Pro (уточняется по пакету из середины); после фильтра дальности и пустых остаётся ~60 %
    let bpp = 20.5;
    { const r = recs[Math.min(recs.length - 1, recs.length >> 1)]; const b = XB.readAt(fd, r.off, r.len); let n = 0; for (const m of messages(b)) for (const x of fieldsOf(b, m.a, m.e)) if (x.f === 2 && x.wt === 2) n++; if (n > 0) bpp = b.length / n; }
    const total = recs.reduce((s, r) => s + r.len, 0), est = total / bpp;
    const step = o.step > 0 ? Math.floor(o.step) : Math.max(1, Math.ceil(est * 0.6 / o.maxPoints));
    let pw = 0.1, refineInfo = null;
    if (o.refine) {
      const XR = require('./xbin-refine');
      refineInfo = XR.refine(fd, C, o, (f, label) => prog(0.1 + 0.55 * f, label || 'Облако из .xbin: уточнение траектории по облаку…'), walk);
      C.TR = XR.correctedTrajectory(C.TR, refineInfo.knots);
      pw = 0.65;
    }
    ofd = fs.openSync(tmp, 'w');
    const ox = Math.round(P.p[0]), oy = Math.round(P.p[1]), oz = Math.round(P.p[2]);
    fs.writeSync(ofd, lasHeader({ n: 0, ox, oy, oz, min: [0, 0, 0], max: [0, 0, 0] }), 0, 227, 0);
    const OB = 34 * 65536, out = Buffer.allocUnsafe(OB); let fill = 0, fpos = 227;
    const flush = () => { if (fill) { fs.writeSync(ofd, out, 0, fill, fpos); fpos += fill; fill = 0; } };
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    let n = 0, done = 0, lastProg = 0;
    const W = walk(fd, C, o, T0, T1, step, (wx, wy, wz, t, I, R) => {
      if (wx < mn[0]) mn[0] = wx; if (wx > mx[0]) mx[0] = wx; if (wy < mn[1]) mn[1] = wy; if (wy > mx[1]) mx[1] = wy; if (wz < mn[2]) mn[2] = wz; if (wz > mx[2]) mx[2] = wz;
      if (fill + 34 > OB) flush();
      out.writeInt32LE(Math.round((wx - ox) * 1000), fill); out.writeInt32LE(Math.round((wy - oy) * 1000), fill + 4); out.writeInt32LE(Math.round((wz - oz) * 1000), fill + 8);
      out.writeUInt16LE(I * 257 > 65535 ? 65535 : I * 257, fill + 12); out[fill + 14] = 0x09; out[fill + 15] = 0; out[fill + 16] = 0; out[fill + 17] = R & 255;
      out.writeUInt16LE(0, fill + 18); out.writeDoubleLE(t, fill + 20);
      const g = (I > 255 ? 255 : I) * 257; out.writeUInt16LE(g, fill + 28); out.writeUInt16LE(g, fill + 30); out.writeUInt16LE(g, fill + 32);
      fill += 34; n++;
    }, (bytes) => { done += bytes; if (done - lastProg > (64 << 20)) { lastProg = done; prog(pw + (1 - pw) * done / total, 'Облако из .xbin: точки лидара…'); } });
    flush();
    if (n < 100) throw new Error('из пакетов лидара получилось слишком мало точек');
    fs.writeSync(ofd, lasHeader({ n, ox, oy, oz, min: mn, max: mx }), 0, 227, 0);
    fs.closeSync(ofd); ofd = null;
    fs.renameSync(tmp, outLas);
    prog(1, 'Облако из .xbin: готово');
    const TR = C.TR;
    return { points: n, step, estimated: Math.round(est), t0: T0, t1: T1, seconds: T1 - T0, packets: W.packets, skipped: W.skipped, empty: W.empty, self: W.self, edge: W.edge || 0, min: mn, max: mx,
      lidarCh: C.S.lidarCh, motorCh: C.S.motorCh, imuCh: C.S.imuCh,
      trajectory: { imu: TR.imu, imuIntervals: TR.imuIntervals, intervals: TR.intervals, gaps: TR.gaps, position: TR.position, corrMedianDeg: TR.corrMedianDeg, refined: !!refineInfo },
      refine: refineInfo ? refineInfo.summary : null };
  } finally {
    if (ofd != null) { try { fs.closeSync(ofd); } catch (_) {} try { fs.rmSync(tmp, { force: true }); } catch (_) {} }
    fs.closeSync(fd);
  }
}

module.exports = { scan, build, prepare, walk, motorAt, parseMotorMsg, parseImuMsg, looksLidar, lasHeader, makeTrajectory, qexp, qmul, qToMat, DEF };
