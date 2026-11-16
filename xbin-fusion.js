'use strict';
/*
 * xbin-fusion.js — r155/r159: scan-matching повторных проходов + fusion без прореживания.
 *
 * 1) hist: по времени точки делятся на проходы (passSec); на выборке строятся опорные плоскости
 *    (вертикальные RANSAC + пол/потолок по модам z); для каждого прохода робастно оценивается сдвиг
 *    (tx,ty — по вертикальным плоскостям, tz — по полу/потолку) и применяется ко всем точкам прохода.
 * 2) icp (r159): после hist каждый проход дополнительно выравнивается point-to-plane ICP через
 *    `tools/scan2bim-py/cloud-register.py` (Open3D): опорная карта накапливается из уже обработанных
 *    проходов (сэмпл 300–500k), матрица 4×4 из JSON применяется к точкам прохода в потоке.
 *    Если Python/Open3D/скрипт недоступны — graceful fallback на hist (статистика помечается).
 * 3) Слияние без прореживания: все точки на месте (цвет/время сохраняются), меняются только координаты.
 *
 * opt: { mode:'hist'|'icp', passSec, band, planeBand, minPlanePts, minPassPts, maxShift, sample,
 *        icpMaxPoints, icpMinInlier, refMaxPts }
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const R = require('./scan-refine-core');

const DEF = {
  mode: 'hist', passSec: 20, band: 0.15, planeBand: 0.03, minPlanePts: 3000, maxPlanes: 20,
  minPassPts: 50000, maxShift: 0.25, sample: 250000,
  icpMaxPoints: 300000, icpMinInlier: 0.35, icpMaxRotDeg: 5, icpMaxTransM: 1.0, refMaxPts: 400000, icpTimeoutMs: 180000
};

let _py = undefined, _icpAvail = undefined;
function findPython() {
  if (_py !== undefined) return _py;
  const cands = [process.env.BIM_PYTHON, 'python', 'py',
    path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'C:\\Python314\\python.exe'].filter(Boolean);
  for (const c of cands) {
    try {
      const r = spawnSync(c, ['-c', 'import open3d,sys;print(open3d.__version__)'], { timeout: 20000, windowsHide: true, encoding: 'utf8' });
      if (r.status === 0) { _py = c; return c; }
    } catch (_) { /* следующий кандидат */ }
  }
  _py = null; return null;
}
function icpToolPath() { return path.join(__dirname, 'tools', 'scan2bim-py', 'cloud-register.py'); }
function icpAvailable() {
  if (_icpAvail !== undefined) return _icpAvail;
  _icpAvail = !!(findPython() && fs.existsSync(icpToolPath()));
  return _icpAvail;
}
function setIcpAvailableForTest(v) { _icpAvail = v; }
/** false | 'auto' | true | 'hist' | 'icp' → false | 'hist' | 'icp' */
function resolveMode(fusion, durationSec, hasIcp) {
  const avail = hasIcp === undefined ? icpAvailable() : !!hasIcp;
  if (fusion === false || fusion == null) return false;
  if (fusion === 'hist') return 'hist';
  if (fusion === 'icp' || fusion === true) return avail ? 'icp' : 'hist';
  if (fusion === 'auto') {
    if (!(durationSec > 600)) return false;
    return avail ? 'icp' : 'hist';
  }
  throw new Error('opt.fusion: ожидается false|true|auto|hist|icp');
}

function passBounds(t0, t1, passSec) {
  const out = []; const n = Math.max(1, Math.ceil((t1 - t0) / passSec));
  for (let i = 0; i < n; i++) out.push([t0 + i * passSec, t0 + (i + 1) * passSec]);
  return out;
}
function passIdOf(t, t0, passSec) { const k = Math.floor((t - t0) / passSec); return k < 0 ? 0 : k; }

// ---------- заголовки/запись LAS ----------
function readHeaderBytes(fd, H) { const hb = Buffer.alloc(H.off); fs.readSync(fd, hb, 0, hb.length, 0); return hb; }
function patchHeader(hb, H, n, bb) {
  const h = Buffer.from(hb.subarray(0, Math.min(hb.length, 375)));
  h.writeUInt32LE(n <= 0xffffffff ? n : 0, 107);
  for (let r = 0; r < 5; r++) h.writeUInt32LE(r === 0 ? (n <= 0xffffffff ? n : 0) : 0, 111 + r * 4);
  h.writeDoubleLE(bb[3], 179); h.writeDoubleLE(bb[0], 187); h.writeDoubleLE(bb[4], 195); h.writeDoubleLE(bb[1], 203); h.writeDoubleLE(bb[5], 211); h.writeDoubleLE(bb[2], 219);
  return h;
}
/**
 * Потоковая запись LAS с преобразованием координат.
 * opts: {includePass(t), shiftOf(t)->[dx,dy,dz], matrixOf(passId)->4x4|null, maxPts, onProgress}
 */
function writeWithTransform(src, dst, H, opts) {
  const o = opts || {};
  const fd = fs.openSync(src, 'r');
  let ofd = null;
  try {
    const hb = readHeaderBytes(fd, H);
    ofd = fs.openSync(dst, 'w');
    const per = 1 << 17, buf = Buffer.allocUnsafe(per * H.rl);
    const OB = Buffer.allocUnsafe(8192 * H.rl);   // буфер вывода: 8192 записей
    const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let out = 0, on = 0, wpos = H.off;
    const flush = () => { if (on) { fs.writeSync(ofd, OB, 0, on, wpos); wpos += on; on = 0; } };
    const emitFrom = (b, p) => { if (on + H.rl > OB.length) flush(); b.copy(OB, on, p, p + H.rl); on += H.rl; out++; };
    const stride = o.maxPts > 0 ? Math.max(1, Math.ceil(H.n / o.maxPts)) : 1;
    let seen = 0;
    for (let i = 0; i < H.n; i += per) {
      const c = Math.min(per, H.n - i), bytes = c * H.rl; let got = 0;
      while (got < bytes) { const r = fs.readSync(fd, buf, got, bytes - got, H.off + i * H.rl + got); if (!r) break; got += r; }
      if (got < bytes) break;
      for (let q = 0, p = 0; q < c; q++, p += H.rl) {
        const t = buf.readDoubleLE(p + H.tOff);
        if (o.includePass && !o.includePass(t)) continue;
        if (o.maxPts > 0 && (seen++ % stride)) continue;
        let x = buf.readInt32LE(p) * H.sx + H.ox, y = buf.readInt32LE(p + 4) * H.sy + H.oy, z = buf.readInt32LE(p + 8) * H.sz + H.oz;
        if (o.shiftOf) { const sh = o.shiftOf(t); if (sh) { x += sh[0]; y += sh[1]; z += sh[2]; } }
        if (o.matrixOf) {
          const M = o.matrixOf(passIdOf(t, o.t0, o.passSec));
          if (M) {
            if (o.yawOnly) {   // r159: из ICP берём только yaw+сдвиг, чтобы не наклонять пол (z остаётся из hist)
              const yaw = Math.atan2(M[1][0], M[0][0]), cy = Math.cos(yaw), sy = Math.sin(yaw);
              const X = cy * x - sy * y + M[0][3], Y = sy * x + cy * y + M[1][3], Z = z + M[2][3];
              x = X; y = Y; z = Z;
            } else {
              const X = M[0][0] * x + M[0][1] * y + M[0][2] * z + M[0][3], Y = M[1][0] * x + M[1][1] * y + M[1][2] * z + M[1][3], Z = M[2][0] * x + M[2][1] * y + M[2][2] * z + M[2][3];
              x = X; y = Y; z = Z;
            }
          }
        }
        buf.writeInt32LE(Math.round((x - H.ox) / H.sx), p);
        buf.writeInt32LE(Math.round((y - H.oy) / H.sy), p + 4);
        buf.writeInt32LE(Math.round((z - H.oz) / H.sz), p + 8);
        if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (z < bb[2]) bb[2] = z;
        if (x > bb[3]) bb[3] = x; if (y > bb[4]) bb[4] = y; if (z > bb[5]) bb[5] = z;
        emitFrom(buf, p);
      }
      if (o.onProgress) o.onProgress((i + c) / H.n);
    }
    flush();
    if (out) fs.writeSync(ofd, patchHeader(hb, H, out, bb), 0, 227, 0);
    fs.closeSync(ofd); ofd = null;
    return { points: out, bb };
  } finally {
    if (ofd !== null) { try { fs.closeSync(ofd); } catch (_) {} }
    fs.closeSync(fd);
  }
}
// минимальный LAS 1.2 fmt0 для опорной карты ICP
function writeSimpleLas(xyz, n, file) {
  const h = Buffer.alloc(227);
  h.write('LASF', 0, 'ascii');
  h.writeUInt8(1, 24); h.writeUInt8(2, 25);
  h.writeUInt16LE(227, 94); h.writeUInt32LE(227, 96); h.writeUInt8(0, 104); h.writeUInt16LE(20, 105);
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < n; i++) { const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2]; if (x < minx) minx = x; if (y < miny) miny = y; if (z < minz) minz = z; if (x > maxx) maxx = x; if (y > maxy) maxy = y; if (z > maxz) maxz = z; }
  h.writeUInt32LE(n, 107);
  h.writeUInt16LE(0, 111); h.writeUInt16LE(0, 113);
  h.writeDoubleLE(0.001, 131); h.writeDoubleLE(0.001, 139); h.writeDoubleLE(0.001, 147);
  h.writeDoubleLE(0, 155); h.writeDoubleLE(0, 163); h.writeDoubleLE(0, 171);
  h.writeDoubleLE(maxx, 179); h.writeDoubleLE(minx, 187); h.writeDoubleLE(maxy, 195); h.writeDoubleLE(miny, 203); h.writeDoubleLE(maxz, 211); h.writeDoubleLE(minz, 219);
  const rl = 20, per = 8192, OB = Buffer.allocUnsafe(per * rl);
  const ofd = fs.openSync(file, 'w');
  try {
    fs.writeSync(ofd, h, 0, h.length, 0);
    let wpos = 227;
    for (let i = 0; i < n; i += per) {
      const c = Math.min(per, n - i); let on = 0;
      for (let j = 0; j < c; j++) {
        const k = i + j;
        OB.writeInt32LE(Math.round(xyz[k * 3] / 0.001), on);
        OB.writeInt32LE(Math.round(xyz[k * 3 + 1] / 0.001), on + 4);
        OB.writeInt32LE(Math.round(xyz[k * 3 + 2] / 0.001), on + 8);
        OB.writeUInt16LE(0, on + 12); OB.writeUInt8(9, on + 14); OB.writeUInt8(1, on + 15);
        on += rl;
      }
      fs.writeSync(ofd, OB, 0, on, wpos); wpos += on;
    }
  } finally { fs.closeSync(ofd); }
  return { points: n };
}
// прочитать LAS обратно в координаты (для опорной карты)
function readLasXyz(file, H0, maxPts) {
  const fd = fs.openSync(file, 'r');
  try {
    const H = H0 || R.readHeader(fd);
    const stride = maxPts > 0 ? Math.max(1, Math.ceil(H.n / maxPts)) : 1;
    const cap = H.n, out = new Float64Array(Math.min(cap, maxPts > 0 ? Math.ceil(cap / stride) : cap) * 3);
    const per = 1 << 17, buf = Buffer.allocUnsafe(per * H.rl);
    let cnt = 0, i = 0;
    while (i < H.n && cnt * 3 < out.length) {
      const c = Math.min(per, H.n - i), bytes = c * H.rl; let got = 0;
      while (got < bytes) { const r = fs.readSync(fd, buf, got, bytes - got, H.off + i * H.rl + got); if (!r) break; got += r; }
      if (got < bytes) break;
      for (let q = 0, p = 0; q < c; q++, p += H.rl) {
        if ((i + q) % stride) continue;
        if (cnt * 3 + 3 > out.length) break;
        out[cnt * 3] = buf.readInt32LE(p) * H.sx + H.ox; out[cnt * 3 + 1] = buf.readInt32LE(p + 4) * H.sy + H.oy; out[cnt * 3 + 2] = buf.readInt32LE(p + 8) * H.sz + H.oz;
        cnt++;
      }
      i += c;
    }
    return { xyz: out.subarray(0, cnt * 3), n: cnt };
  } finally { fs.closeSync(fd); }
}

// ---------- RANSAC/плоскости/грубая стадия ----------
function ransacVertical(sample, opt) {
  const o = Object.assign({}, DEF, opt || {});
  const N0 = sample.n / 3;
  const stride = Math.max(1, Math.ceil(N0 / 120000));
  const N = Math.floor((N0 + stride - 1) / stride);
  const xs = new Float64Array(N), ys = new Float64Array(N);
  for (let j = 0, i = 0; j < N; j++, i += stride) { xs[j] = sample.x[i]; ys[j] = sample.y[i]; }
  const minPts = Math.max(200, Math.round((o.minPlanePts || 3000) * N / 250000));
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const planes = []; const used = new Uint8Array(N);
  const ITERS = Math.max(600, (o.maxPlanes || 20) * 150);
  for (let it = 0; it < ITERS && planes.length < o.maxPlanes; it++) {
    const i = (rnd() * N) | 0, j = (rnd() * N) | 0;
    if (used[i] || used[j]) continue;
    const dx = xs[i] - xs[j], dy = ys[i] - ys[j];
    const len = Math.hypot(dx, dy); if (len < 0.5) continue;
    const nx = dy / len, ny = -dx / len, c = nx * xs[i] + ny * ys[i];
    let cnt = 0;
    for (let k = 0; k < N; k++) { if (used[k]) continue; const d = nx * xs[k] + ny * ys[k] - c; if (d < o.planeBand && d > -o.planeBand) cnt++; }
    if (cnt >= minPts) {
      planes.push({ nx, ny, c, n: cnt });
      for (let k = 0; k < N; k++) { if (used[k]) continue; const d = nx * xs[k] + ny * ys[k] - c; if (d < o.planeBand && d > -o.planeBand) used[k] = 1; }
    }
  }
  const merged = [];
  for (const p of planes) {
    let hit = null;
    for (const q of merged) if (Math.abs(q.nx * p.nx + q.ny * p.ny) > 0.995 && Math.abs(q.c - p.c) < 0.09) { hit = q; break; }
    if (!hit) { merged.push({ nx: p.nx, ny: p.ny, c: p.c, n: p.n }); continue; }
    const w = hit.n + p.n;
    hit.c = (hit.c * hit.n + p.c * p.n) / w;
    hit.nx = (hit.nx * hit.n + p.nx * p.n) / w; hit.ny = (hit.ny * hit.n + p.ny * p.n) / w;
    const ln = Math.hypot(hit.nx, hit.ny) || 1; hit.nx /= ln; hit.ny /= ln; hit.n = w;
  }
  return merged;
}
function horizontalPlanes(sample) {
  const N = sample.n / 3;
  let z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < N; i++) { const z = sample.z[i]; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  const bins = 400, h = new Uint32Array(bins), step = Math.max(1e-3, (z1 - z0) / bins);
  for (let i = 0; i < N; i++) { let b = Math.floor((sample.z[i] - z0) / step); if (b < 0) b = 0; if (b >= bins) b = bins - 1; h[b]++; }
  const mode = (a, b) => { let best = a; for (let k = a + 1; k < b; k++) if (h[k] > h[best]) best = k; return best; };
  const mid = bins >> 1, kb = mode(0, mid), kt = mode(mid, bins);
  return [{ nx: 0, ny: 0, nz: 1, c: z0 + (kb + 0.5) * step, n: h[kb] }, { nx: 0, ny: 0, nz: 1, c: z0 + (kt + 0.5) * step, n: h[kt] }];
}
function solveShift(planes, obs) {
  let tx = 0, ty = 0, tz = 0;
  const vert = [];
  for (const p of planes) {
    const off = obs.get(p); if (off === undefined || off.count < 300) continue;
    const nz = p.nz || 0;
    if (Math.abs(nz) < 0.1) vert.push([p.nx, p.ny, off.median]);
  }
  if (vert.length >= 2) {
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
    for (const [nx, ny, off] of vert) {
      const w = 1 / (1 + (Math.abs(off) / 0.02) ** 2);
      a11 += w * nx * nx; a12 += w * nx * ny; a22 += w * ny * ny; b1 += w * nx * (-off); b2 += w * ny * (-off);
    }
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) > 1e-9) { tx = (a22 * b1 - a12 * b2) / det; ty = (a11 * b2 - a12 * b1) / det; }
  }
  const hor = [];
  for (const p of planes) {
    const off = obs.get(p); if (off === undefined || off.count < 300) continue;
    if (Math.abs(p.nz || 0) > 0.9) hor.push(off.median);
  }
  if (hor.length) tz = -hor.reduce((a, b) => a + b, 0) / hor.length;
  const lim = DEF.maxShift, norm = Math.hypot(tx, ty, tz);
  if (norm > lim) { tx *= lim / norm; ty *= lim / norm; tz *= lim / norm; }
  return { tx, ty, tz };
}
function readSample(fd, H, maxPts) {
  const stride = Math.max(1, Math.ceil(H.n / maxPts));
  const x = new Float64Array(maxPts), y = new Float64Array(maxPts), z = new Float64Array(maxPts), t = new Float64Array(maxPts);
  const per = 1 << 18, buf = Buffer.allocUnsafe(per * H.rl);
  let cnt = 0, i = 0;
  while (i < H.n && cnt < maxPts) {
    const c = Math.min(per, H.n - i), bytes = c * H.rl; let got = 0;
    while (got < bytes) { const r = fs.readSync(fd, buf, got, bytes - got, H.off + i * H.rl + got); if (!r) break; got += r; }
    if (got < bytes) break;
    for (let q = 0, p = 0; q < c; q += 1, p += H.rl) {
      if ((i + q) % stride) continue;
      if (cnt >= maxPts) break;
      x[cnt] = buf.readInt32LE(p) * H.sx + H.ox; y[cnt] = buf.readInt32LE(p + 4) * H.sy + H.oy; z[cnt] = buf.readInt32LE(p + 8) * H.sz + H.oz;
      t[cnt] = buf.readDoubleLE(p + H.tOff); cnt++;
    }
    i += c;
  }
  return { x: x.subarray(0, cnt), y: y.subarray(0, cnt), z: z.subarray(0, cnt), t: t.subarray(0, cnt), n: cnt * 3 };
}
function readFirstTime(fd, H) { const b = Buffer.alloc(H.rl); fs.readSync(fd, b, 0, H.rl, H.off); return b.readDoubleLE(H.tOff); }

function histStage(fd, H, o, prog) {
  const sample = readSample(fd, H, o.sample);
  const vplanes = ransacVertical(sample, o);
  const hplanes = horizontalPlanes(sample);
  const planes = vplanes.concat(hplanes);
  let t0 = Infinity, t1 = -Infinity;
  for (let i = 0; i < sample.t.length; i++) { const tv = sample.t[i]; if (tv < t0) t0 = tv; if (tv > t1) t1 = tv; }
  if (!Number.isFinite(t0)) t0 = readFirstTime(fd, H);
  const nPass = Math.max(1, Math.ceil((t1 - t0) / o.passSec) + 1);
  const BINS = 651, MID = 325, BMM = 0.001;
  const hst = new Array(nPass).fill(null), cnt = new Float64Array(nPass);
  const per = 1 << 18, buf = Buffer.allocUnsafe(per * H.rl);
  for (let i = 0; i < H.n; i += per) {
    const c = Math.min(per, H.n - i), bytes = c * H.rl; let got = 0;
    while (got < bytes) { const r = fs.readSync(fd, buf, got, bytes - got, H.off + i * H.rl + got); if (!r) break; got += r; }
    if (got < bytes) break;
    for (let q = 0, p = 0; q < c; q++, p += H.rl) {
      const t = buf.readDoubleLE(p + H.tOff); const k = passIdOf(t, t0, o.passSec);
      if (k < 0 || k >= nPass) continue;
      if (!hst[k]) hst[k] = planes.map(() => new Int32Array(BINS));
      const x = buf.readInt32LE(p) * H.sx + H.ox, y = buf.readInt32LE(p + 4) * H.sy + H.oy, z = buf.readInt32LE(p + 8) * H.sz + H.oz;
      let best = -1, bd = o.band, bs = 1;
      for (let j = 0; j < planes.length; j++) { const pl = planes[j]; const d = pl.nx * x + pl.ny * y + (pl.nz || 0) * z - pl.c; if (Math.abs(d) < bd) { bd = Math.abs(d); best = j; bs = d < 0 ? -1 : 1; } }
      if (best < 0) continue;
      let b = MID + Math.round(bd * bs / BMM); if (b < 0) b = 0; if (b >= BINS) b = BINS - 1;
      hst[k][best][b]++; cnt[k]++;
    }
    prog(0.02 + 0.33 * (i + c) / H.n, 'Слияние проходов: разброс проходов…');
  }
  const shifts = new Float64Array(nPass * 3), meds = new Array(nPass).fill(null);
  let passCount = 0, shiftSum = 0, shiftMax = 0;
  for (let k = 0; k < nPass; k++) {
    if (!hst[k] || cnt[k] < o.minPassPts) continue;
    passCount++;
    const obs = new Map();
    for (let j = 0; j < planes.length; j++) {
      const hist = hst[k][j]; let total = 0; for (let b = 0; b < BINS; b++) total += hist[b];
      if (total < 300) continue;
      let acc = 0, med = 0;
      for (let b = 0; b < BINS; b++) { acc += hist[b]; if (acc * 2 >= total) { med = (b - MID) * BMM; break; } }
      obs.set(planes[j], { median: med, count: total });
    }
    meds[k] = obs;
    const tS = solveShift(planes, obs);
    shifts[k * 3] = tS.tx; shifts[k * 3 + 1] = tS.ty; shifts[k * 3 + 2] = tS.tz;
    const nn = Math.hypot(tS.tx, tS.ty, tS.tz); shiftSum += nn; if (nn > shiftMax) shiftMax = nn;
  }
  function spread(after) {
    const sig = [];
    for (let j = 0; j < planes.length; j++) {
      const vals = [];
      for (let k = 0; k < nPass; k++) {
        const obs = meds[k]; if (!obs) continue;
        const o1 = obs.get(planes[j]); if (!o1 || o1.count < 300) continue;
        const pl = planes[j];
        const dt = after ? pl.nx * shifts[k * 3] + pl.ny * shifts[k * 3 + 1] + (pl.nz || 0) * shifts[k * 3 + 2] : 0;
        vals.push(o1.median + dt);
      }
      if (vals.length >= 2) { const m = vals.reduce((a, b) => a + b, 0) / vals.length; const v = vals.reduce((a, b) => a + (b - m) * (b - m), 0) / vals.length; sig.push(Math.sqrt(v) * 1000); }
    }
    sig.sort((a, b) => a - b);
    return { planes: sig.length, median_sigma_mm: sig.length ? +sig[sig.length >> 1].toFixed(2) : null, max_sigma_mm: sig.length ? +sig[sig.length - 1].toFixed(2) : null };
  }
  return { sample, planes, vplanes, t0, t1, nPass, passCount, shifts, shiftSum, shiftMax, residualBefore: spread(false), residualAfter: spread(true) };
}

// ---------- ICP-стадия: последовательная опорная карта ----------
function icpStage(src, H, hist, o, tmpDir, prog) {
  if (!icpAvailable()) return { ok: false, reason: 'no-python-or-open3d' };
  const py = findPython(), tool = icpToolPath();
  if (!py || !fs.existsSync(tool)) return { ok: false, reason: 'no-python-or-tool' };
  const shiftOf = (t) => { const k = passIdOf(t, hist.t0, o.passSec); return k < hist.nPass ? [hist.shifts[k * 3], hist.shifts[k * 3 + 1], hist.shifts[k * 3 + 2]] : [0, 0, 0]; };
  // 1) кропы проходов (с hist-сдвигом)
  const passFiles = [];
  for (let k = 0; k < hist.nPass; k++) {
    const file = path.join(tmpDir, 'pass-' + k + '.las');
    const w = writeWithTransform(src, file, H, { includePass: (t) => passIdOf(t, hist.t0, o.passSec) === k, shiftOf, t0: hist.t0, passSec: o.passSec });
    if (w.points >= 2000) passFiles.push({ k, file, points: w.points });
  }
  if (!passFiles.length) return { ok: false, reason: 'empty-passes' };
  // 2) начальная опорная карта — первые до 3 проходов (сэмпл)
  const refMax = o.refMaxPts || 400000;
  let refXyz = new Float64Array(3 * refMax), refN = 0;
  const addRef = (xyz, n, maxTake) => {
    const stride = Math.max(1, Math.ceil(n / Math.max(1, maxTake)));
    for (let i = 0; i < n && refN < refMax * 2; i += stride) {
      refXyz[refN * 3] = xyz[i * 3]; refXyz[refN * 3 + 1] = xyz[i * 3 + 1]; refXyz[refN * 3 + 2] = xyz[i * 3 + 2]; refN++;
    }
    if (refN > refMax) { // прореживаем вдвое
      let w = 0; for (let i = 0; i < refN; i += 2) { refXyz[w * 3] = refXyz[i * 3]; refXyz[w * 3 + 1] = refXyz[i * 3 + 1]; refXyz[w * 3 + 2] = refXyz[i * 3 + 2]; w++; }
      refN = w;
    }
  };
  const initN = o.refMode === 'global' ? passFiles.length : Math.min(3, passFiles.length);
  const initPer = Math.max(1, Math.ceil(refMax / initN));
  for (let i = 0; i < initN; i++) { const rd = readLasXyz(passFiles[i].file, null, initPer); addRef(rd.xyz, rd.n, initPer); }
  if (refN < 1000) return { ok: false, reason: 'empty-ref' };
  const refLas = path.join(tmpDir, 'ref.las');
  writeSimpleLas(refXyz.subarray(0, refN * 3), refN, refLas);
  // 3) ICP по проходам в порядке времени, опорная карта пополняется уже выровненными
  const matrices = new Map(), stats = [];
  const maxAge = o.icpTimeoutMs || 180000;
  for (let idx = 0; idx < passFiles.length; idx++) {
    const pf = passFiles[idx];
    const outJson = path.join(tmpDir, 'reg-' + pf.k + '.json');
    let applied = false, reg = null;
    try {
      const r = spawnSync(py, [tool, '--ref', refLas, '--src', pf.file, '--mode', 'icp', '--max-points', String(o.icpMaxPoints || 300000), '--out', outJson], { timeout: maxAge, windowsHide: true, encoding: 'utf8' });
      if (r.status === 0 && fs.existsSync(outJson)) {
        reg = JSON.parse(fs.readFileSync(outJson, 'utf8'));
        const rr = reg.results && reg.results[0];
        if (rr && rr.matrix && rr.rms) {
          const M = rr.matrix;
          const tr = M[0][0] + M[1][1] + M[2][2];
          const rotDeg = Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2))) * 180 / Math.PI;
          const transM = Math.hypot(M[0][3], M[1][3], M[2][3]);
          const ok = rr.rms.inlier_ratio >= (o.icpMinInlier || 0.35) && rotDeg <= (o.icpMaxRotDeg || 5) && transM <= (o.icpMaxTransM || 1.0);
          if (ok) { matrices.set(pf.k, M); applied = true; }
          stats.push({ pass: pf.k, rmsInlierM: rr.rms.rms_inlier_m, inlier: rr.rms.inlier_ratio, rotDeg: rr.transform && rr.transform.rotation_deg, applied, reason: ok ? null : 'implausible-transform' });
        } else stats.push({ pass: pf.k, applied: false, reason: 'no-matrix' });
      } else stats.push({ pass: pf.k, applied: false, error: (r.stderr || '').slice(-200) });
    } catch (e) { stats.push({ pass: pf.k, applied: false, error: String((e && e.message) || e) }); }
    if (applied) {
      // пополняем опорную карту уже выровненными точками прохода
      const rd = readLasXyz(pf.file, null, 60000);
      const M = matrices.get(pf.k);
      for (let i = 0; i < rd.n; i++) { const x = rd.xyz[i * 3], y = rd.xyz[i * 3 + 1], z = rd.xyz[i * 3 + 2]; rd.xyz[i * 3] = M[0][0] * x + M[0][1] * y + M[0][2] * z + M[0][3]; rd.xyz[i * 3 + 1] = M[1][0] * x + M[1][1] * y + M[1][2] * z + M[1][3]; rd.xyz[i * 3 + 2] = M[2][0] * x + M[2][1] * y + M[2][2] * z + M[2][3]; }
      addRef(rd.xyz, rd.n, 60000);
      writeSimpleLas(refXyz.subarray(0, refN * 3), refN, refLas);
    }
    try { fs.unlinkSync(pf.file); } catch (_) {}
    prog(0.4 + 0.5 * (idx + 1) / passFiles.length, 'Слияние проходов: ICP ' + (idx + 1) + ' из ' + passFiles.length + '…');
  }
  const applied = stats.filter(s => s.applied).length;
  if (!applied) return { ok: false, reason: 'no-applied' };
  const rmsArr = stats.filter(s => s.applied && Number.isFinite(s.rmsInlierM)).map(s => s.rmsInlierM);
  const inlArr = stats.filter(s => s.applied && Number.isFinite(s.inlier)).map(s => s.inlier);
  const med = a => { if (!a.length) return null; const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
  return { ok: true, matrices, passStats: stats, applied, failed: passFiles.length - applied, refPoints: refN,
    icpRmsMedianM: med(rmsArr), icpInlierMedian: med(inlArr), icpRunner: py };
}

/** fusion LAS: mode 'hist' | 'icp'. Возвращает статистику. */
function fuseLas(src, dst, opt, onProgress) {
  const o = Object.assign({}, DEF, opt || {});
  const prog = typeof onProgress === 'function' ? onProgress : () => {};
  const t0ms = Date.now();
  const fd = fs.openSync(src, 'r');
  let tmpDir = null;
  try {
    const H = R.readHeader(fd);
    const hist = histStage(fd, H, o, prog);
    const baseStats = {
      passes: hist.passCount, passSec: o.passSec, planes: hist.planes.length, verticalPlanes: hist.vplanes.length,
      pointsIn: H.n, shiftMedianMm: hist.passCount ? +(hist.shiftSum / hist.passCount * 1000).toFixed(2) : 0,
      shiftMaxMm: +(hist.shiftMax * 1000).toFixed(2), residualBeforeMm: hist.residualBefore, residualAfterMm: hist.residualAfter
    };
    const shiftOf = (t) => { const k = passIdOf(t, hist.t0, o.passSec); if (k >= hist.nPass) return [0, 0, 0]; return o.zOnly ? [0, 0, hist.shifts[k * 3 + 2]] : [hist.shifts[k * 3], hist.shifts[k * 3 + 1], hist.shifts[k * 3 + 2]]; };
    const mode = o.mode === 'icp' ? 'icp' : 'hist';
    if (mode === 'icp') {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xbin-fusion-'));
      const icp = icpStage(src, H, hist, o, tmpDir, prog);
      if (icp.ok) {
        const matrixOf = (k) => icp.matrices.get(k) || null;
        const w = writeWithTransform(src, dst, H, { shiftOf, matrixOf, yawOnly: o.icpYawOnly ? true : false, t0: hist.t0, passSec: o.passSec, onProgress: (f) => prog(0.9 + 0.1 * f, 'Слияние проходов: запись с ICP…') });
        prog(1, 'Слияние проходов: готово');
        return Object.assign(baseStats, {
          mode: 'icp', points: w.points, removed: H.n - w.points,
          icp: { applied: icp.applied, failed: icp.failed, refPoints: icp.refPoints, rmsInlierMedianM: icp.icpRmsMedianM, inlierMedian: icp.icpInlierMedian, runner: icp.icpRunner, passStats: icp.passStats },
          ms: Date.now() - t0ms
        });
      }
      prog(0.4, 'Слияние проходов: ICP недоступен — откат на hist…');
      baseStats.icpFallback = icp.reason || 'failed';
    }
    const w = writeWithTransform(src, dst, H, { shiftOf, t0: hist.t0, passSec: o.passSec, onProgress: (f) => prog(0.4 + 0.6 * f, 'Слияние проходов: запись…') });
    return Object.assign(baseStats, { mode: mode === 'icp' ? 'hist-fallback' : 'hist', points: w.points, removed: H.n - w.points, ms: Date.now() - t0ms });
  } catch (e) {
    try { fs.rmSync(dst, { force: true }); } catch (_) {}
    throw e;
  } finally {
    fs.closeSync(fd);
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} }
  }
}

module.exports = { fuseLas, passBounds, passIdOf, ransacVertical, horizontalPlanes, solveShift, resolveMode, icpAvailable, findPython, readSample, setIcpAvailableForTest, DEF };
