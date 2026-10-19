'use strict';
/*
 * recolor-core.js — цвет точек по фотографиям сканера (кадры камер из .xbin), ревизия 22.
 *
 * Почему у Lixel Studio облако «чётче»: итоговый LAS там раскрашивается заново по кадрам двух камер «рыбий глаз» 4000×3000
 * (12 Мп, ~2,5 кадра/с на камеру), а realtime-карта (map.las) и наш прежний путь брали цвет, который сканер успел
 * назначить на ходу. Здесь — тот же принцип:
 *   • поза камеры в момент кадра = траектория (poses.csv, кадр IMU) · калибровка (extrinsic_imu_motor · inv(extrinsic_camera_motor),
 *     для второй камеры ещё camera_pose из camera.yaml); проекция — модель Kannala–Brandt (KB4) из camera.yaml;
 *   • каждая точка смотрится только кадрами в окне ±window секунд от времени её измерения (там сканер был рядом);
 *   • видимость — z-буфер по ячейкам cell пикселей (допуск 4 % + 5 см) и по соседним 3×3 с широким допуском 25 % (точка, закрытая
 *     более близкой поверхностью, цвет не берёт; пол под острым углом не отбрасывается);
 *   • качество взгляда: ближе — резче (1/d), центр объектива — резче и без виньетирования, ближе по времени — точнее поза,
 *     плюс «маска» кадра: участки, где цвет кадра систематически не совпадает с облаком (оператор, корпус сканера, блики
 *     на защитном стекле), находятся автоматически на пробных кадрах и не используются;
 *   • на точку хранятся K лучших взглядов; итог — согласованные между собой (люди и машины, попавшие в один кадр, отпадают),
 *     усреднённые с весом q² — резкость лучшего кадра без пятен от экспозиции соседних.
 * Без траектории, времени точек или при плохом совпадении фото с облаком (проверка корреляции яркости) возвращается ошибка —
 * вызывающий оставляет исходный цвет.
 * Память ограничена окном времени: точки раскладываются во временные файлы по корзинам времени (bucket секунд).
 * Декодер кадров передаётся снаружи (в приложении — WebCodecs VideoDecoder в скрытом окне, в тестах — синтетика):
 *   decode(bytes, frame) → Promise<{ w, h, Y, U, V, sY, sU, fullRange }> (I420).
 */
const fs = require('node:fs');
const path = require('node:path');

const RGB_OFF = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };
const T_OFF = { 1: 20, 3: 20, 4: 20, 5: 20, 6: 22, 7: 22, 8: 22, 9: 22, 10: 22 };

const DEF = { window: 2.5, bucket: 2, K: 4, cell: 8, thetaMax: 1.35, thetaSharp: 0.95, dMin: 0.45, dMax: 35, depthRel: 0.04, depthRel3: 0.25, depthAbs: 0.05,
  pilotFrames: 160, minCorr: 0.3, agree: 75, maskGrid: [40, 30], prefetch: 3, minPoints: 1000 };

// ---- траектория с ориентацией: t,x,y,z,qx,qy,qz,qw (poses.csv Lixel) ----
function parsePoses(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim(); if (!s || /^[a-z#]/i.test(s)) continue;
    const a = s.split(/[,;\s]+/).map(Number);
    if (a.length < 8 || !a.slice(0, 8).every(Number.isFinite)) continue;
    const qn = Math.hypot(a[4], a[5], a[6], a[7]); if (!(qn > 0.5 && qn < 1.5)) continue;
    rows.push([a[0], a[1], a[2], a[3], a[4] / qn, a[5] / qn, a[6] / qn, a[7] / qn]);
  }
  rows.sort((p, q) => p[0] - q[0]);
  const n = rows.length, P = { n, t: new Float64Array(n), p: new Float64Array(n * 3), q: new Float64Array(n * 4) };
  for (let i = 0; i < n; i++) { const r = rows[i]; P.t[i] = r[0]; P.p.set(r.slice(1, 4), i * 3); P.q.set(r.slice(4, 8), i * 4); }
  for (let i = 1; i < n; i++) { let d = 0; for (let k = 0; k < 4; k++) d += P.q[i * 4 + k] * P.q[(i - 1) * 4 + k]; if (d < 0) for (let k = 0; k < 4; k++) P.q[i * 4 + k] = -P.q[i * 4 + k]; }
  return P;
}
// поза IMU в момент t → матрица 4×4 (по строкам); slerp ориентации, линейно положение
function poseAt(P, t, out) {
  out = out || new Float64Array(16);
  const T = P.t, n = P.n; let i;
  if (t <= T[0]) i = 0; else if (t >= T[n - 1]) i = n - 2; else { let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; } i = lo; }
  if (i < 0) i = 0;
  const j = Math.min(n - 1, i + 1), dt = T[j] - T[i];
  let w = dt > 0 ? (t - T[i]) / dt : 0; if (w < 0) w = 0; else if (w > 1) w = 1;
  const a = P.q.subarray(i * 4, i * 4 + 4), b = P.q.subarray(j * 4, j * 4 + 4);
  let c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], s0 = 1 - w, s1 = w;
  if (c < 0.9995) { const th = Math.acos(Math.max(-1, Math.min(1, c))), st = Math.sin(th); s0 = Math.sin((1 - w) * th) / st; s1 = Math.sin(w * th) / st; }
  let x = s0 * a[0] + s1 * b[0], y = s0 * a[1] + s1 * b[1], z = s0 * a[2] + s1 * b[2], ww = s0 * a[3] + s1 * b[3];
  const qn = Math.hypot(x, y, z, ww); x /= qn; y /= qn; z /= qn; ww /= qn;
  out[0] = 1 - 2 * (y * y + z * z); out[1] = 2 * (x * y - z * ww); out[2] = 2 * (x * z + y * ww);
  out[4] = 2 * (x * y + z * ww); out[5] = 1 - 2 * (x * x + z * z); out[6] = 2 * (y * z - x * ww);
  out[8] = 2 * (x * z - y * ww); out[9] = 2 * (y * z + x * ww); out[10] = 1 - 2 * (x * x + y * y);
  for (let k = 0; k < 3; k++) out[k * 4 + 3] = P.p[i * 3 + k] + (P.p[j * 3 + k] - P.p[i * 3 + k]) * w;
  out[12] = out[13] = out[14] = 0; out[15] = 1;
  return out;
}
function mul4(A, B) { const C = new Float64Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += A[r * 4 + k] * B[k * 4 + c]; C[r * 4 + c] = s; } return C; }
function invRigid(A) {   // [R t; 0 1]⁻¹ = [Rᵀ −Rᵀt; 0 1]
  const B = new Float64Array(16);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) B[r * 4 + c] = A[c * 4 + r];
  for (let r = 0; r < 3; r++) B[r * 4 + 3] = -(B[r * 4] * A[3] + B[r * 4 + 1] * A[7] + B[r * 4 + 2] * A[11]);
  B[15] = 1; return B;
}

// камеры: каналы кадров по возрастанию ↔ camera_0, camera_1; T_imu_cam0 = E_IM · inv(E_CM), T_imu_cam1 = T_imu_cam0 · camera_pose(1)
function rigs(calib, frameChannels) {
  if (!calib || !calib.cams || !calib.cams.length) throw new Error('в .xbin нет калибровки камер (camera.yaml)');
  if (!calib.camMotor || !calib.imuMotor) throw new Error('в .xbin нет калибровок extrinsic_camera_motor / extrinsic_imu_motor');
  const X0 = mul4(Float64Array.from(calib.imuMotor), invRigid(Float64Array.from(calib.camMotor)));
  const chs = frameChannels.map(Number).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < Math.min(chs.length, calib.cams.length); i++) {
    const c = calib.cams[i]; const T = i === 0 ? X0 : mul4(mul4(X0, invRigid(Float64Array.from(calib.cams[0].pose))), Float64Array.from(c.pose));
    out.push({ ch: chs[i], cam: i, fx: c.fx, fy: c.fy, cx: c.cx, cy: c.cy, d: c.d, w: c.w, h: c.h, T });
  }
  return out;
}

// KB4: точка камеры → [u, v, θ]; false, если за пределами
function projectKB4(R, x, y, z, out) {
  const r = Math.sqrt(x * x + y * y), th = Math.atan2(r, z), t2 = th * th, d = R.d;
  const thd = th * (1 + t2 * (d[0] + t2 * (d[1] + t2 * (d[2] + t2 * d[3]))));
  const s = r > 1e-12 ? thd / r : 0;
  out[0] = R.fx * s * x + R.cx; out[1] = R.fy * s * y + R.cy; out[2] = th;
  return out;
}

function readHeader(fd) {
  const h = Buffer.alloc(375); fs.readSync(fd, h, 0, 375, 0);
  if (h.toString('latin1', 0, 4) !== 'LASF') throw new Error('файл не LAS');
  if (h[104] & 0x80) throw new Error('сжатый LAS (LAZ) не поддерживается');
  const minor = h[25], off = h.readUInt32LE(96), fmt = h[104] & 0x3f, rl = h.readUInt16LE(105);
  let n = h.readUInt32LE(107); if (minor >= 4) { const n2 = Number(h.readBigUInt64LE(247)); if (n2 > 0) n = n2; }
  return { minor, off, fmt, rl, n, rgb: RGB_OFF[fmt], tOff: T_OFF[fmt], sx: h.readDoubleLE(131), sy: h.readDoubleLE(139), sz: h.readDoubleLE(147), ox: h.readDoubleLE(155), oy: h.readDoubleLE(163), oz: h.readDoubleLE(171) };
}
function scanLas(fd, H, cb, per) {
  per = per || 1 << 18; const buf = Buffer.allocUnsafe(per * H.rl);
  for (let i = 0; i < H.n; i += per) {
    const c = Math.min(per, H.n - i), bytes = c * H.rl; let got = 0;
    while (got < bytes) { const r = fs.readSync(fd, buf, got, bytes - got, H.off + i * H.rl + got); if (!r) throw new Error('файл LAS обрезан'); got += r; }
    cb(buf, i, c);
  }
}

// I420 → RGB (BT.601; limited range, если не fullRange), билинейно по яркости, цвет — по ближайшему пикселю половинного разрешения
function sampleRGB(img, u, v, out) {
  const w = img.w, h = img.h; if (u < 0 || v < 0 || u > w - 1.001 || v > h - 1.001) return false;
  const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0, Y = img.Y, sY = img.sY, p = y0 * sY + x0;
  const yy = (Y[p] * (1 - fx) + Y[p + 1] * fx) * (1 - fy) + (Y[p + sY] * (1 - fx) + Y[p + sY + 1] * fx) * fy;
  const q = (v >> 1) * img.sU + (u >> 1) * (img.uvStep || 1), cb = img.U[q] - 128, cr = img.V[q] - 128;
  let r, g, b;
  if (img.fullRange) { r = yy + 1.402 * cr; g = yy - 0.344136 * cb - 0.714136 * cr; b = yy + 1.772 * cb; }
  else { const c = 1.164383 * (yy - 16); r = c + 1.596027 * cr; g = c - 0.391762 * cb - 0.812968 * cr; b = c + 2.017232 * cb; }
  out[0] = r < 0 ? 0 : (r > 255 ? 255 : r); out[1] = g < 0 ? 0 : (g > 255 ? 255 : g); out[2] = b < 0 ? 0 : (b > 255 ? 255 : b);
  return true;
}

/**
 * Проекция окна точек в один кадр. pts — [{ n, P: Float32Array(3n) (отн. origin), T: Float32Array(n) (отн. t0), ...}],
 * Tcw — мир→камера (Float64Array 16, мир отн. origin), tf — время кадра (отн. t0). visit(bucket, i, u, v, th, d) — для видимых точек.
 */
function makeProjector(R, o) {
  const cs = o.cell, gw = Math.ceil(R.w / cs) + 2, gh = Math.ceil(R.h / cs) + 2;
  const Z = new Float32Array(gw * gh), Z3 = new Float32Array(gw * gh), uv = new Float64Array(3);
  const thMax = o.thetaMax, dMin = o.dMin, dMax = o.dMax;
  return function project(pts, Tcw, tf, W, visit) {
    Z.fill(Infinity);
    const a = Tcw;
    for (let pass = 0; pass < 2; pass++) {
      for (const B of pts) {
        const P = B.P, T = B.T, n = B.n;
        for (let i = 0, k = 0; i < n; i++, k += 3) {
          if (pass === 1 && Math.abs(T[i] - tf) > W) continue;
          const px = P[k], py = P[k + 1], pz = P[k + 2];
          const x = a[0] * px + a[1] * py + a[2] * pz + a[3], y = a[4] * px + a[5] * py + a[6] * pz + a[7], z = a[8] * px + a[9] * py + a[10] * pz + a[11];
          const d = Math.sqrt(x * x + y * y + z * z); if (d < dMin || d > dMax) continue;
          if (z < d * Math.cos(thMax)) continue;
          projectKB4(R, x, y, z, uv);
          const u = uv[0], v = uv[1]; if (!(u >= 0 && v >= 0 && u < R.w - 1 && v < R.h - 1)) continue;
          const ci = ((v / cs) | 0) + 1, cj = ((u / cs) | 0) + 1, c = ci * gw + cj;
          if (pass === 0) { if (d < Z[c]) Z[c] = d; }
          else if (d <= Z[c] * (1 + o.depthRel) + o.depthAbs && d <= Z3[c] * (1 + o.depthRel3) + o.depthAbs) visit(B, i, u, v, uv[2], d);
        }
      }
      if (pass === 0) {   // минимум по 3×3 с широким допуском: редкие точки близкого предмета закрывают дальнюю поверхность в «дырах» между собой, а пол под острым углом (глубина соседней ячейки на 10–20 % меньше) — нет
        for (let i = 1; i < gh - 1; i++) for (let j = 1; j < gw - 1; j++) {
          let m = Infinity; for (let di = -1; di <= 1; di++) { const r0 = (i + di) * gw + j; const a0 = Z[r0 - 1], a1 = Z[r0], a2 = Z[r0 + 1]; if (a0 < m) m = a0; if (a1 < m) m = a1; if (a2 < m) m = a2; }
          Z3[i * gw + j] = m;
        }
      }
    }
  };
}

// итог по K взглядам: согласованные кандидаты (сумма |ΔR|+|ΔG|+|ΔB| < agree), вес q²
function resolveColor(qK, cK, base, K, agree, out) {
  let best = -1, bestS = -1;
  for (let a = 0; a < K; a++) {
    const qa = qK[base + a]; if (!(qa > 0)) continue; const ca = cK[base + a];
    let s = 0;
    for (let b = 0; b < K; b++) { const qb = qK[base + b]; if (!(qb > 0)) continue; const cb = cK[base + b];
      const dd = Math.abs((ca & 255) - (cb & 255)) + Math.abs(((ca >>> 8) & 255) - ((cb >>> 8) & 255)) + Math.abs(((ca >>> 16) & 255) - ((cb >>> 16) & 255));
      if (dd < agree) s += qb; }
    s += qa * 1e-3;
    if (s > bestS) { bestS = s; best = a; }
  }
  if (best < 0) return false;
  const ca = cK[base + best]; let sw = 0, r = 0, g = 0, b2 = 0;
  for (let b = 0; b < K; b++) { const qb = qK[base + b]; if (!(qb > 0)) continue; const cb = cK[base + b];
    const dd = Math.abs((ca & 255) - (cb & 255)) + Math.abs(((ca >>> 8) & 255) - ((cb >>> 8) & 255)) + Math.abs(((ca >>> 16) & 255) - ((cb >>> 16) & 255));
    if (dd >= agree) continue; const w = qb * qb; sw += w; r += w * (cb & 255); g += w * ((cb >>> 8) & 255); b2 += w * ((cb >>> 16) & 255); }
  out[0] = r / sw; out[1] = g / sw; out[2] = b2 / sw; return true;
}

/**
 * recolor(src, dst, { index, posesText, decode, onProgress, tmpDir, opt }) → Promise<stats>
 *   index — результат xbin-core.open(); decode(bytes, frame) — декодер кадра; результат dst — копия src с новым RGB.
 */
async function recolor(src, dst, a) {
  const o = Object.assign({}, DEF, (a && a.opt) || {});
  const prog = typeof a.onProgress === 'function' ? a.onProgress : () => {};
  const t0ms = Date.now();
  const X = a.index; if (!X || !X.frames) throw new Error('нет оглавления .xbin');
  const chs = Object.keys(X.frames).filter(k => X.frames[k].length > 0);
  if (!chs.length) throw new Error('в .xbin нет кадров камер');
  const RG = rigs(X.calib, chs);
  const P = parsePoses(a.posesText || ''); if (P.n < 2) throw new Error('нужна траектория сканера с ориентацией (poses.csv: t,x,y,z,qx,qy,qz,qw)');
  const fd = fs.openSync(src, 'r'); let xfd = null, ofd = null;
  const tmp = fs.mkdtempSync(path.join(a.tmpDir || path.dirname(dst), '.recolor-'));
  try {
    const H = readHeader(fd);
    if (H.tOff === undefined) throw new Error('в LAS нет времени точек — цвет по фото невозможен');
    if (H.rgb === undefined) throw new Error('в формате LAS нет цвета (нужен формат 2/3/5/7/8/10)');
    if (H.n < o.minPoints) throw new Error('слишком мало точек');
    // кадры обеих камер по времени; рабочий интервал — пересечение траектории и кадров
    const frames = [];
    for (const R of RG) for (const f of X.frames[R.ch]) if (f.t >= P.t[0] && f.t <= P.t[P.n - 1]) frames.push({ t: f.t, off: f.off, len: f.len, R, src: f });
    frames.sort((p, q) => p.t - q.t);
    if (frames.length < 2) throw new Error('кадры .xbin не совпадают по времени с траекторией');
    const T0 = frames[0].t - o.window - 1, T1 = frames[frames.length - 1].t + o.window + 1;
    const ox = P.p[0], oy = P.p[1], oz = P.p[2];
    const BS = o.bucket, NB = Math.max(1, Math.ceil((T1 - T0) / BS));
    // ---- 1: раскладка точек по корзинам времени (x,y,z,t float32 + исходный цвет 3 байта + 1 — для пробы)
    const REC = 20, bufs = new Array(NB).fill(null), fill = new Int32Array(NB), cnt = new Float64Array(NB);
    const BUF = Math.max(REC * 1024, Math.min(1 << 20, Math.floor((192 << 20) / NB / REC) * REC));
    const flush = (b) => { if (!fill[b]) return; fs.appendFileSync(path.join(tmp, b + '.p'), bufs[b].subarray(0, fill[b])); fill[b] = 0; };
    let colorMax = 0, inWin = 0;
    const bucketOf = (t) => { if (!(t >= T0 && t < T1)) return -1; const b = Math.floor((t - T0) / BS); return b < NB ? b : -1; };
    scanLas(fd, H, (buf, first, c) => {
      for (let j = 0, q = 0; j < c; j++, q += H.rl) {
        const r = buf.readUInt16LE(q + H.rgb); if (r > colorMax) colorMax = r;
        const t = buf.readDoubleLE(q + H.tOff), b = bucketOf(t); if (b < 0) continue;
        if (!bufs[b]) bufs[b] = Buffer.allocUnsafe(BUF);
        if (fill[b] + REC > BUF) flush(b);
        const w = bufs[b], p = fill[b];
        w.writeFloatLE(buf.readInt32LE(q) * H.sx + H.ox - ox, p); w.writeFloatLE(buf.readInt32LE(q + 4) * H.sy + H.oy - oy, p + 4); w.writeFloatLE(buf.readInt32LE(q + 8) * H.sz + H.oz - oz, p + 8);
        w.writeFloatLE(t - T0, p + 12);
        w.writeUInt16LE(r, p + 16); w.writeUInt16LE(buf.readUInt16LE(q + H.rgb + 2), p + 18);   // R, G — для проверки совпадения (яркость ≈ (R+G)/2 достаточно)
        fill[b] += REC; cnt[b]++; inWin++;
      }
      prog(0.08 * (first + c) / H.n, 'Цвет по фото: раскладка точек…');
    });
    for (let b = 0; b < NB; b++) { flush(b); bufs[b] = null; }
    if (inWin < o.minPoints) throw new Error('время точек LAS не совпадает со временем кадров .xbin');
    // кадры, в окне которых нет точек (облако — часть съёмки), не декодируются
    { const has = (tl) => { for (let b = Math.max(0, Math.floor((tl - o.window) / BS)), b1 = Math.min(NB - 1, Math.floor((tl + o.window) / BS)); b <= b1; b++) if (cnt[b]) return true; return false; };
      let k = 0; for (const f of frames) if (has(f.t - T0)) frames[k++] = f; frames.length = k; }
    if (!frames.length) throw new Error('время точек LAS не совпадает со временем кадров .xbin');
    const c16 = colorMax > 255, cdiv = c16 ? 256 : 1;
    const loadBucket = (b) => {
      const f = path.join(tmp, b + '.p'); if (!cnt[b] || !fs.existsSync(f)) return null;
      const B = fs.readFileSync(f), n = Math.floor(B.length / REC);
      const Pp = new Float32Array(n * 3), Tt = new Float32Array(n), L = new Float32Array(n);
      for (let i = 0, q = 0; i < n; i++, q += REC) { Pp[i * 3] = B.readFloatLE(q); Pp[i * 3 + 1] = B.readFloatLE(q + 4); Pp[i * 3 + 2] = B.readFloatLE(q + 8); Tt[i] = B.readFloatLE(q + 12); L[i] = (B.readUInt16LE(q + 16) + B.readUInt16LE(q + 18)) / (2 * cdiv); }
      return { b, n, P: Pp, T: Tt, L };
    };
    if (!a.readFrame) xfd = fs.openSync(X.path, 'r');
    const readBytes = (f) => { if (a.readFrame) return a.readFrame(f.src, f.R.ch); const bb = Buffer.allocUnsafe(f.len); let got = 0; while (got < f.len) { const r = fs.readSync(xfd, bb, got, f.len - got, f.off + got); if (!r) break; got += r; } return bb.subarray(0, got); };
    const projs = new Map(RG.map(R => [R, makeProjector(R, o)]));
    const Tw = new Float64Array(16);
    const camPose = (f) => { poseAt(P, f.t, Tw); const Twc = mul4(Tw, f.R.T); const Tcw = invRigid(Twc); return Tcw; };   // мир (отн. origin) → камера
    const toLocal = (Tcw) => { // учесть origin: Pw = Pl + o → Pc = R·Pl + (R·o + t)
      const A = Float64Array.from(Tcw); A[3] += Tcw[0] * ox + Tcw[1] * oy + Tcw[2] * oz; A[7] += Tcw[4] * ox + Tcw[5] * oy + Tcw[6] * oz; A[11] += Tcw[8] * ox + Tcw[9] * oy + Tcw[10] * oz; return A; };
    const windowBuckets = (tl, cache) => { const out = []; const b0 = Math.max(0, Math.floor((tl - o.window) / BS)), b1 = Math.min(NB - 1, Math.floor((tl + o.window) / BS)); for (let b = b0; b <= b1; b++) { let B = cache.get(b); if (B === undefined) { B = loadBucket(b); cache.set(b, B); } if (B) out.push(B); } return out; };
    const MG = o.maskGrid, mgw = MG[0], mgh = MG[1];
    // ---- 2: проба — маска кадра (оператор, корпус) и проверка совпадения фото с облаком
    const nPilot = Math.min(o.pilotFrames, frames.length);
    const mSum = RG.map(() => new Float64Array(mgw * mgh)), mCnt = RG.map(() => new Float64Array(mgw * mgh));
    let corrS = 0, corrN = 0;
    {
      const cache = new Map(); const rgb = new Float64Array(3);
      const pick = []; for (let k = 0; k < nPilot; k++) pick.push(Math.min(frames.length - 1, Math.floor((k + 0.5) * frames.length / nPilot)));
      for (let k = 0; k < pick.length; k++) {
        const f = frames[pick[k]], tl = f.t - T0;
        for (const key of cache.keys()) if (key * BS + BS < tl - o.window - BS || key * BS > tl + o.window + BS) cache.delete(key);
        const pts = windowBuckets(tl, cache); if (!pts.length) continue;
        const img = await a.decode(readBytes(f), f);
        const Ls = [], Ps = [], cells = [];
        const ri = RG.indexOf(f.R);
        projs.get(f.R)(pts, toLocal(camPose(f)), tl, o.window, (B, i, u, v) => {
          if (!sampleRGB(img, u, v, rgb)) return;
          Ls.push(B.L[i]); Ps.push((rgb[0] + rgb[1]) / 2); cells.push(Math.min(mgh - 1, (v / img.h * mgh) | 0) * mgw + Math.min(mgw - 1, (u / img.w * mgw) | 0));
        });
        if (img.close) img.close();
        const m = Ls.length; if (m < 200) continue;
        // яркость облака ≈ a·яркость фото + b (экспозиция кадра), остаток — по ячейкам
        let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
        for (let i = 0; i < m; i++) { const x = Ps[i], y = Ls[i]; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; }
        const vx = sxx - sx * sx / m, vy = syy - sy * sy / m, cxy = sxy - sx * sy / m;
        if (vx > 0 && vy > 0) { corrS += cxy / Math.sqrt(vx * vy) * m; corrN += m; }
        const ga = vx > 0 ? cxy / vx : 1, gb = (sy - ga * sx) / m;
        for (let i = 0; i < m; i++) { mSum[ri][cells[i]] += Math.abs(Ls[i] - (ga * Ps[i] + gb)); mCnt[ri][cells[i]]++; }
        prog(0.08 + 0.07 * (k + 1) / pick.length, 'Цвет по фото: проверка калибровки…');
      }
    }
    const corr = corrN ? corrS / corrN : 0;
    if (!(corr >= o.minCorr)) throw new Error('фото сканера не совпадают с облаком (корреляция ' + corr.toFixed(2) + '): другая съёмка, траектория или облако сдвинуто');
    // маска: ячейки кадра с ошибкой > 1,6 медианы — вес плавно до 0 к 2,6 медианы
    const masks = RG.map((R, ri) => {
      const S = mSum[ri], C = mCnt[ri], vals = [];
      for (let c = 0; c < S.length; c++) if (C[c] >= 30) vals.push(S[c] / C[c]);
      vals.sort((p, q) => p - q); const med = vals.length ? vals[vals.length >> 1] : 0;
      const M = new Float32Array(S.length).fill(1); let off = 0;
      if (med > 0) for (let c = 0; c < S.length; c++) { if (C[c] < 30) continue; const e = S[c] / C[c] / med; const w = e <= 1.6 ? 1 : (e >= 2.6 ? 0 : 1 - (e - 1.6)); M[c] = w; if (w < 0.5) off++; }
      return { M, off, med };
    });
    // ---- 3: основной проход по кадрам; корзины держатся в памяти, пока их видят кадры окна
    const K = o.K, live = new Map(); let doneB = -1, colored = 0, views = 0;
    const cfile = (b) => path.join(tmp, b + '.c');
    const ensure = (b) => { let B = live.get(b); if (B !== undefined) return B; B = loadBucket(b); if (B) { B.q = new Float32Array(B.n * K); B.c = new Uint32Array(B.n * K); B.L = null; } live.set(b, B); return B; };
    const out3 = new Float64Array(3);
    const finalize = (b) => {
      const B = live.get(b); live.delete(b);
      if (!B) return;
      const C = Buffer.alloc(B.n * 4);
      for (let i = 0; i < B.n; i++) if (resolveColor(B.q, B.c, i * K, K, o.agree, out3)) { C[i * 4] = Math.round(out3[0]); C[i * 4 + 1] = Math.round(out3[1]); C[i * 4 + 2] = Math.round(out3[2]); C[i * 4 + 3] = 1; colored++; }
      fs.writeFileSync(cfile(b), C); try { fs.unlinkSync(path.join(tmp, b + '.p')); } catch (_) {}
    };
    const rgb = new Float64Array(3), cosS = o.thetaSharp, thM = o.thetaMax;
    const queue = []; let qi = 0;
    const want = () => { while (queue.length < o.prefetch && qi < frames.length) { const f = frames[qi++]; queue.push({ f, p: Promise.resolve().then(() => a.decode(readBytes(f), f)) }); } };
    want();
    for (let fi = 0; fi < frames.length; fi++) {
      const { f, p } = queue.shift(); want();
      const tl = f.t - T0;
      const bLo = Math.max(0, Math.floor((tl - o.window) / BS));
      while (doneB + 1 < bLo) { doneB++; if (live.has(doneB)) finalize(doneB); }
      const pts = []; for (let b = bLo, b1 = Math.min(NB - 1, Math.floor((tl + o.window) / BS)); b <= b1; b++) { const B = ensure(b); if (B) pts.push(B); }
      const img = await p;
      if (!pts.length) { if (img.close) img.close(); continue; }
      const M = masks[RG.indexOf(f.R)].M, iw = img.w, ih = img.h;
      projs.get(f.R)(pts, toLocal(camPose(f)), tl, o.window, (B, i, u, v, th, d) => {
        const mk = M[Math.min(mgh - 1, (v / ih * mgh) | 0) * mgw + Math.min(mgw - 1, (u / iw * mgw) | 0)]; if (mk <= 0) return;
        const dt = (B.T[i] - tl) / o.window;
        const fth = th <= cosS ? 1 : Math.max(0, (thM - th) / (thM - cosS));
        const q = mk * fth * Math.exp(-dt * dt) / Math.max(d, 0.7); if (!(q > 0)) return;
        const base = i * K; let mi = 0, mq = B.q[base];
        for (let k = 1; k < K; k++) if (B.q[base + k] < mq) { mq = B.q[base + k]; mi = k; }
        if (q <= mq) return;
        if (!sampleRGB(img, u, v, rgb)) return;
        B.q[base + mi] = q; B.c[base + mi] = (rgb[0] + 0.5 | 0) | ((rgb[1] + 0.5 | 0) << 8) | ((rgb[2] + 0.5 | 0) << 16); views++;
      });
      if (img.close) img.close();
      if ((fi & 7) === 0) prog(0.15 + 0.75 * (fi + 1) / frames.length, 'Цвет по фото: кадр ' + (fi + 1) + ' из ' + frames.length + '…');
    }
    for (const b of Array.from(live.keys()).sort((p, q) => p - q)) finalize(b);
    if (xfd !== null) { fs.closeSync(xfd); xfd = null; }
    // ---- 4: запись LAS: исходные записи, цвет — из корзин по порядку точек
    const hdr = Buffer.alloc(H.off); fs.readSync(fd, hdr, 0, H.off, 0);
    ofd = fs.openSync(dst, 'w'); fs.writeSync(ofd, hdr, 0, H.off, 0);
    const rd = new Array(NB).fill(null);
    const nextColor = (b) => {
      let R = rd[b];
      if (!R) { const f = cfile(b); R = rd[b] = { fd: fs.existsSync(f) ? fs.openSync(f, 'r') : null, buf: Buffer.alloc(1 << 14), len: 0, pos: 0, fpos: 0 }; }
      if (!R.fd) return -1;
      if (R.pos >= R.len) { R.len = fs.readSync(R.fd, R.buf, 0, R.buf.length, R.fpos); R.fpos += R.len; R.pos = 0; if (R.len < 4) return -1; }
      const p = R.pos; R.pos += 4; return R.buf[p + 3] ? p : -1;
    };
    let wpos = H.off, changed = 0;
    scanLas(fd, H, (buf, first, c) => {
      for (let j = 0, q = 0; j < c; j++, q += H.rl) {
        const b = bucketOf(buf.readDoubleLE(q + H.tOff)); if (b < 0) continue;
        const p = nextColor(b); if (p < 0) continue;
        const C = rd[b].buf, m = c16 ? 257 : 1;
        buf.writeUInt16LE(C[p] * m, q + H.rgb); buf.writeUInt16LE(C[p + 1] * m, q + H.rgb + 2); buf.writeUInt16LE(C[p + 2] * m, q + H.rgb + 4); changed++;
      }
      fs.writeSync(ofd, buf, 0, c * H.rl, wpos); wpos += c * H.rl;
      prog(0.9 + 0.1 * (first + c) / H.n, 'Цвет по фото: запись…');
    });
    // хвост файла после точек (EVLR) переносится как есть
    const end = H.off + H.n * H.rl, size = fs.fstatSync(fd).size;
    if (size > end) { const tail = Buffer.alloc(Math.min(size - end, 64 << 20)); fs.readSync(fd, tail, 0, tail.length, end); fs.writeSync(ofd, tail, 0, tail.length, wpos); }
    for (const R of rd) if (R && R.fd) fs.closeSync(R.fd);
    fs.closeSync(ofd); ofd = null;
    return { points: H.n, inWindow: inWin, colored: changed, frames: frames.length, views, corr: +corr.toFixed(3), masked: masks.map(m => m.off), cameras: RG.length, ms: Date.now() - t0ms, color16: c16 };
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
    if (xfd !== null) { try { fs.closeSync(xfd); } catch (_) {} }
    if (ofd !== null) { try { fs.closeSync(ofd); } catch (_) {} }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { recolor, parsePoses, poseAt, rigs, projectKB4, sampleRGB, resolveColor, makeProjector, mul4, invRigid, readHeader, DEF };
