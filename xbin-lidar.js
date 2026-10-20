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
    const lidar = [], mt = [], mc = [], ms = [];
    const hb = Buffer.allocUnsafe(HDR); let p = first, last = 0, lidarBytes = 0;
    while (p + HDR <= size) {
      if (fs.readSync(fd, hb, 0, HDR, p) !== HDR) break;
      const r = XB.recordAt(hb, 0); if (!r || p + r.L > size) break;
      let k = kind.get(r.ch);
      if (k === undefined || k === 'motor') {
        const body = XB.readAt(fd, p + HDR, Math.min(r.L - HDR, k === 'motor' ? 1 << 20 : 2 << 20));
        const msgs = messages(body);
        if (k === undefined) {
          k = 'other';
          if (msgs.length && msgs[0].e - msgs[0].a < 512) { const m = parseMotorMsg(body, msgs[0].a, msgs[0].e); if (m && Math.abs(m.norm / 1e10 - 1) < 0.02) k = 'motor'; }
          if (k === 'other' && msgs.length && looksLidar(body, msgs[0].a, msgs[0].e)) k = 'lidar';
          if (k !== 'other' && [...kind.values()].includes(k)) k = 'other';   // по одному каналу каждого вида
          kind.set(r.ch, k);
        }
        if (k === 'motor') for (const x of msgs) { const m = parseMotorMsg(body, x.a, x.e); if (m) { mt.push(m.t); mc.push(m.c); ms.push(m.s); } }
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
    let lidarCh = null, motorCh = null; for (const [ch, k] of kind) { if (k === 'lidar') lidarCh = ch; else if (k === 'motor') motorCh = ch; }
    lidar.sort((a, b) => a.t - b.t);
    return { size, calib, first, lidarCh, motorCh, lidar, motor: { t: T, phi: PHI }, bytes: lidarBytes,
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

// ---- LAS 1.2, формат 3 (34 байта): XYZ int32 (0,001 м), интенсивность, возврат 1 из 1, класс 0, кольцо → user data, время, RGB
function lasHeader(o) {
  const h = Buffer.alloc(227);
  h.write('LASF', 0, 'latin1'); h[24] = 1; h[25] = 2;
  h.write('BIM Twin', 26, 'latin1'); h.write('BIM Twin xbin-lidar r24', 58, 'latin1');
  const d = new Date(); const doy = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;
  h.writeUInt16LE(doy, 90); h.writeUInt16LE(d.getUTCFullYear(), 92);
  h.writeUInt16LE(227, 94); h.writeUInt32LE(227, 96); h.writeUInt32LE(0, 100); h[104] = 3; h.writeUInt16LE(34, 105);
  h.writeUInt32LE(o.n, 107); h.writeUInt32LE(o.n, 111);
  for (let k = 0; k < 3; k++) h.writeDoubleLE(0.001, 131 + 8 * k);
  h.writeDoubleLE(o.ox, 155); h.writeDoubleLE(o.oy, 163); h.writeDoubleLE(o.oz, 171);
  h.writeDoubleLE(o.max[0], 179); h.writeDoubleLE(o.min[0], 187); h.writeDoubleLE(o.max[1], 195); h.writeDoubleLE(o.min[1], 203); h.writeDoubleLE(o.max[2], 211); h.writeDoubleLE(o.min[2], 219);
  return h;
}

const DEF = { minRange: 0.5, maxRange: 120, maxPoints: 40e6, step: 0, t0: null, t1: null, maxMotorGap: 0.05 };

/**
 * build(xbinPath, posesText, outLas, opt, onProgress) → { points, step, t0, t1, seconds, skipped, ... }
 *   opt: minRange/maxRange (м, от лидара), maxPoints (прорежение каждой k-й точкой, k подбирается по объёму пакетов),
 *        step (k вручную), t0/t1 (UNIX-время, с), index (готовый результат scan()).
 */
function build(xbinPath, posesText, outLas, opt, onProgress) {
  const o = Object.assign({}, DEF, opt || {});
  const prog = typeof onProgress === 'function' ? onProgress : () => {};
  const S = o.index || scan(xbinPath, (f) => prog(0.1 * f, 'Облако из .xbin: оглавление файла…'));
  if (!S.lidar.length) throw new Error('в .xbin не найдены пакеты лидара');
  if (S.motor.t.length < 2) throw new Error('в .xbin нет угла мотора лидара');
  const P = RC.parsePoses(posesText || ''); if (P.n < 2) throw new Error('нужна траектория сканера poses.csv (t,x,y,z,qx,qy,qz,qw) из папки проекта');
  const EML = m4(S.calib && S.calib.motorLidar, 'extrinsic_motor_lidar'), EIM = m4(S.calib && S.calib.imuMotor, 'extrinsic_imu_motor');
  const T0 = Math.max(P.t[0], o.t0 != null ? o.t0 : -Infinity, S.motor.t[0]), T1 = Math.min(P.t[P.n - 1], o.t1 != null ? o.t1 : Infinity, S.motor.t[S.motor.t.length - 1]);
  const recs = S.lidar.filter(r => r.t >= T0 - 1.5 && r.t <= T1 + 0.1);   // в записи — несколько пакетов (до ~0,3 с)
  if (!recs.length || !(T1 > T0)) throw new Error('время пакетов лидара не совпадает с траекторией poses.csv');
  // прорежение: ≈ 20,5 байта на точку в пакетах L2 Pro (уточняется по пакету из середины); после фильтра дальности и пустых остаётся ~60 %
  const fd = fs.openSync(xbinPath, 'r');
  const tmp = outLas + '.part';
  let ofd = null;
  try {
    let bpp = 20.5;
    { const r = recs[Math.min(recs.length - 1, recs.length >> 1)]; const b = XB.readAt(fd, r.off, r.len); let n = 0; for (const m of messages(b)) for (const x of fieldsOf(b, m.a, m.e)) if (x.f === 2 && x.wt === 2) n++; if (n > 0) bpp = b.length / n; }
    const est = recs.reduce((s, r) => s + r.len, 0) / bpp;
    const step = o.step > 0 ? Math.floor(o.step) : Math.max(1, Math.ceil(est * 0.6 / o.maxPoints));
    ofd = fs.openSync(tmp, 'w');
    const ox = Math.round(P.p[0]), oy = Math.round(P.p[1]), oz = Math.round(P.p[2]);
    fs.writeSync(ofd, lasHeader({ n: 0, ox, oy, oz, min: [0, 0, 0], max: [0, 0, 0] }), 0, 227, 0);
    const OB = 34 * 65536, out = Buffer.allocUnsafe(OB); let fill = 0, fpos = 227;
    const flush = () => { if (fill) { fs.writeSync(ofd, out, 0, fill, fpos); fpos += fill; fill = 0; } };
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    const A = EML, B = EIM, PA = new Float64Array(16), PB = new Float64Array(16), MA = new Float64Array(3);
    const r2min = o.minRange * o.minRange, r2max = o.maxRange > 0 ? o.maxRange * o.maxRange : Infinity;
    let n = 0, cnt = 0, skipped = 0, empty = 0, done = 0; const total = recs.reduce((s, r) => s + r.len, 0); let lastProg = 0;
    let buf = Buffer.allocUnsafe(1 << 20);
    for (const r of recs) {
      if (buf.length < r.len) buf = Buffer.allocUnsafe(r.len * 2);
      let got = 0; while (got < r.len) { const k = fs.readSync(fd, buf, got, r.len - got, r.off + got); if (!k) break; got += k; }
      const b = buf; const end = got;
      // сообщения верхнего уровня (поле 1)
      let p = 0;
      while (p < end) {
        let tag = b[p++]; if (tag & 0x80) { [tag, p] = XB.varint(b, p - 1); }
        if (tag !== 10) break;
        let l, q; [l, q] = XB.varint(b, p); const me = q + l; p = q; if (me > end) break;
        // заголовок и точки
        let th = null; const ptsStart = [];
        let pp = p;
        // первый проход по сообщению: время заголовка (поле 1 идёт первым)
        while (pp < me) {
          const tg = b[pp++];
          if (tg === 10) { let hl; [hl, pp] = XB.varint(b, pp); const he = pp + hl; while (pp < he) { let t2; [t2, pp] = XB.varint(b, pp); if ((t2 & 7) === 0) { let v; [v, pp] = XB.varint(b, pp); if ((t2 >>> 3) === 2) th = zz(v) / 1e6; } else { pp = he; } } pp = he; }
          else { pp--; break; }
        }
        p = me;
        if (th == null || th < T0 - 0.06 || th > T1) { skipped++; continue; }
        const tm = Math.min(T1, Math.max(T0, th)), tn = Math.min(T1, th + 0.05);
        RC.poseAt(P, tm, PA); RC.poseAt(P, tn, PB);
        motorAt(S.motor, th, MA); if (MA[2] > o.maxMotorGap) { skipped++; continue; }
        const phi0 = MA[0]; motorAt(S.motor, th + 0.05, MA); const w = (MA[0] - phi0) / 0.05, dT = tn - tm;   // скорость мотора — по окну пакета
        // точки: поле 2 (tag 0x12)
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
          if (!(X | Y | Z)) { empty++; continue; }
          const x = zz(X) / 1000, y = zz(Y) / 1000, z = zz(Z) / 1000, d2 = x * x + y * y + z * z;
          if (d2 < r2min || d2 > r2max) continue;
          if ((cnt++ % step) !== 0) continue;
          const dt = zz(D) / 1e6, t = th + dt;
          if (t < T0 || t > T1) continue;
          // мотор → лидар
          const qx = A[0] * x + A[1] * y + A[2] * z + A[3], qy = A[4] * x + A[5] * y + A[6] * z + A[7], qz = A[8] * x + A[9] * y + A[10] * z + A[11];
          const ph = phi0 + w * dt, c = Math.cos(ph), s = Math.sin(ph);
          const rx = c * qx + s * qz, rz = -s * qx + c * qz;
          const mxx = B[0] * rx + B[1] * qy + B[2] * rz + B[3], myy = B[4] * rx + B[5] * qy + B[6] * rz + B[7], mzz = B[8] * rx + B[9] * qy + B[10] * rz + B[11];
          let a1 = dT > 0 ? (t - tm) / dT : 0; if (a1 < 0) a1 = 0; else if (a1 > 1) a1 = 1; const a0 = 1 - a1;
          const wx = (PA[0] * a0 + PB[0] * a1) * mxx + (PA[1] * a0 + PB[1] * a1) * myy + (PA[2] * a0 + PB[2] * a1) * mzz + PA[3] * a0 + PB[3] * a1;
          const wy = (PA[4] * a0 + PB[4] * a1) * mxx + (PA[5] * a0 + PB[5] * a1) * myy + (PA[6] * a0 + PB[6] * a1) * mzz + PA[7] * a0 + PB[7] * a1;
          const wz = (PA[8] * a0 + PB[8] * a1) * mxx + (PA[9] * a0 + PB[9] * a1) * myy + (PA[10] * a0 + PB[10] * a1) * mzz + PA[11] * a0 + PB[11] * a1;
          if (wx < mn[0]) mn[0] = wx; if (wx > mx[0]) mx[0] = wx; if (wy < mn[1]) mn[1] = wy; if (wy > mx[1]) mx[1] = wy; if (wz < mn[2]) mn[2] = wz; if (wz > mx[2]) mx[2] = wz;
          if (fill + 34 > OB) flush();
          out.writeInt32LE(Math.round((wx - ox) * 1000), fill); out.writeInt32LE(Math.round((wy - oy) * 1000), fill + 4); out.writeInt32LE(Math.round((wz - oz) * 1000), fill + 8);
          out.writeUInt16LE(I * 257 > 65535 ? 65535 : I * 257, fill + 12); out[fill + 14] = 0x09; out[fill + 15] = 0; out[fill + 16] = 0; out[fill + 17] = R & 255;
          out.writeUInt16LE(0, fill + 18); out.writeDoubleLE(t, fill + 20);
          const g = (I > 255 ? 255 : I) * 257; out.writeUInt16LE(g, fill + 28); out.writeUInt16LE(g, fill + 30); out.writeUInt16LE(g, fill + 32);
          fill += 34; n++;
        }
      }
      done += r.len;
      if (done - lastProg > (64 << 20)) { lastProg = done; prog(0.1 + 0.9 * done / total, 'Облако из .xbin: точки лидара…'); }
    }
    flush();
    if (n < 100) throw new Error('из пакетов лидара получилось слишком мало точек');
    fs.writeSync(ofd, lasHeader({ n, ox, oy, oz, min: mn, max: mx }), 0, 227, 0);
    fs.closeSync(ofd); ofd = null;
    fs.renameSync(tmp, outLas);
    prog(1, 'Облако из .xbin: готово');
    return { points: n, step, estimated: Math.round(est), t0: T0, t1: T1, seconds: T1 - T0, packets: recs.length, skipped, empty, min: mn, max: mx, lidarCh: S.lidarCh, motorCh: S.motorCh };
  } finally {
    if (ofd != null) { try { fs.closeSync(ofd); } catch (_) {} try { fs.rmSync(tmp, { force: true }); } catch (_) {} }
    fs.closeSync(fd);
  }
}

module.exports = { scan, build, motorAt, parseMotorMsg, looksLidar, lasHeader, DEF };
