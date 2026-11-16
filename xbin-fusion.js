'use strict';
/*
 * xbin-fusion.js — r149: scan-matching повторных проходов + fusion без прореживания.
 *
 * Проблема: на длинном скане облако содержит десятки «проходов» (окна по времени). Из-за остаточного дрейфа
 * траектории одна и та же стена от разных проходов стоит на 10–60 мм друг от друга — стены «толстые»,
 * пол «смазан». Здесь:
 *   1) по времени точки определяются проходы (passSec, по умолчанию 20 с);
 *   2) на прореженной выборке строятся опорные плоскости: вертикальные RANSAC (XY) + пол/потолок (моды z);
 *   3) для каждого прохода по этим плоскостям робастно оценивается сдвиг: tx,ty — МНК по вертикальным
 *      плоскостям с весами (отбрасываются выбросы), tz — по медианам смещений пола/потолка;
 *   4) ко всем точкам прохода применяется его сдвиг (без прореживания — плотность сохраняется);
 *      остаточный разброс проходов по плоскостям считается до/после и попадает в статистику.
 *
 * Это scan-matching по глобальным плоскостям, аналог `cloud-register.py` для повторных проходов; перекрытия
 * проходов не обязательны (каждый проход привязывается к общей системе координат).
 * Время: 1 проход по файлу на выборку + 1 проход для сдвигов + 1 запись (≈2–3 чтения LAS).
 */
const fs = require('node:fs');
const R = require('./scan-refine-core');

const DEF = { passSec: 20, band: 0.15, planeBand: 0.03, minPlanePts: 3000, maxPlanes: 20, minPassPts: 50000, maxShift: 0.25, sample: 250000 };

function growF(a, n) { if (a.length >= n) return a; const b = new Float64Array(Math.max(n, a.length * 2)); b.set(a); return b; }

/** проходы по времени: сколько и какие границы (для тестов/статистики) */
function passBounds(t0, t1, passSec) {
  const out = [];
  const n = Math.max(1, Math.ceil((t1 - t0) / passSec));
  for (let i = 0; i < n; i++) out.push([t0 + i * passSec, t0 + (i + 1) * passSec]);
  return out;
}
function passIdOf(t, t0, passSec) { const k = Math.floor((t - t0) / passSec); return k < 0 ? 0 : k; }

// вертикальные плоскости: RANSAC по XY-выборке (нормаль n=(nx,ny,0), плоскость nx·x+ny·y=c)
function ransacVertical(sample, opt) {
  const o = Object.assign({}, DEF, opt || {});
  const N0 = sample.n / 3;
  // для скорости RANSAC работает на прореженной выборке до ~120 тыс. точек
  const stride = Math.max(1, Math.ceil(N0 / 120000));
  const N = Math.floor((N0 + stride - 1) / stride);
  const xs = new Float64Array(N), ys = new Float64Array(N);
  for (let j = 0, i = 0; j < N; j++, i += stride) { xs[j] = sample.x[i]; ys[j] = sample.y[i]; }
  const minPts = Math.max(200, Math.round((o.minPlanePts || 3000) * N / 250000));
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const planes = [];
  const used = new Uint8Array(N);
  const ITERS = Math.max(600, (o.maxPlanes || 20) * 150);
  for (let it = 0; it < ITERS && planes.length < o.maxPlanes; it++) {
    const i = (rnd() * N) | 0, j = (rnd() * N) | 0;
    if (used[i] || used[j]) continue;
    const dx = xs[i] - xs[j], dy = ys[i] - ys[j];
    const len = Math.hypot(dx, dy); if (len < 0.5) continue;
    const nx = dy / len, ny = -dx / len;              // нормаль к линии
    const c = nx * xs[i] + ny * ys[i];
    let cnt = 0;
    for (let k = 0; k < N; k++) {
      if (used[k]) continue;
      const d = nx * xs[k] + ny * ys[k] - c;
      if (d < o.planeBand && d > -o.planeBand) cnt++;
    }
    if (cnt >= minPts) {
      planes.push({ nx, ny, c, n: cnt });
      for (let k = 0; k < N; k++) {
        if (used[k]) continue;
        const d = nx * xs[k] + ny * ys[k] - c;
        if (d < o.planeBand && d > -o.planeBand) used[k] = 1;
      }
    }
  }
  // объединяем параллельные плоскости с близким c: два прохода одной стены не должны стать двумя «опорными»
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

// пол/потолок по гистограммам z выборки
function horizontalPlanes(sample, opt) {
  const o = Object.assign({}, DEF, opt || {});
  const N = sample.n / 3;
  let z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < N; i++) { const z = sample.z[i]; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  const bins = 400, h = new Uint32Array(bins), step = Math.max(1e-3, (z1 - z0) / bins);
  for (let i = 0; i < N; i++) { let b = Math.floor((sample.z[i] - z0) / step); if (b < 0) b = 0; if (b >= bins) b = bins - 1; h[b]++; }
  const mode = (a, b) => { let best = a; for (let k = a + 1; k < b; k++) if (h[k] > h[best]) best = k; return best; };
  const mid = bins >> 1;
  const kb = mode(0, mid), kt = mode(mid, bins);
  return [{ nx: 0, ny: 0, nz: 1, c: z0 + (kb + 0.5) * step, n: h[kb] }, { nx: 0, ny: 0, nz: 1, c: z0 + (kt + 0.5) * step, n: h[kt] }];
}

/** робастная оценка сдвига прохода: вертикальные плоскости → tx,ty; пол/потолок → tz */
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
  const lim = DEF.maxShift;
  const norm = Math.hypot(tx, ty, tz);
  if (norm > lim) { tx *= lim / norm; ty *= lim / norm; tz *= lim / norm; }
  return { tx, ty, tz };
}

// чтение выборки точек (грубый шаг) без материализации файла
function readSample(fd, H, maxPts) {
  const stride = Math.max(1, Math.ceil(H.n / maxPts));
  const x = new Float64Array(maxPts), y = new Float64Array(maxPts), z = new Float64Array(maxPts), t = new Float64Array(maxPts);
  const per = 1 << 18, buf = Buffer.allocUnsafe(Math.min(per, 1 << 18) * H.rl);
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

/** основной вход: fusion LAS-файла. opt: passSec, band, minPassPts, sample, onProgress */
function fuseLas(src, dst, opt, onProgress) {
  const o = Object.assign({}, DEF, opt || {});
  const t0ms = Date.now();
  const prog = typeof onProgress === 'function' ? onProgress : () => {};
  const fd = fs.openSync(src, 'r');
  let ofd = null;
  try {
    const H = R.readHeader(fd), rl = H.rl;
    prog(0.02, 'Слияние проходов: выборка…');
    const sample = readSample(fd, H, o.sample);
    const vplanes = ransacVertical(sample, o);
    const hplanes = horizontalPlanes(sample, o);
    const planes = vplanes.concat(hplanes.map(p => p));
    // t0/t1 по времени выборки (первая точка файла может быть не минимальной по времени)
    let t0 = Infinity, t1 = -Infinity, tSum = 0;
    for (let i = 0; i < sample.t.length; i++) { const tv = sample.t[i]; if (tv < t0) t0 = tv; if (tv > t1) t1 = tv; tSum += tv; }
    if (!Number.isFinite(t0)) t0 = readFirstTime(fd, H);
    const nPass = Math.max(1, Math.ceil((t1 - t0) / o.passSec) + 1);
    // гистограммы смещений: pass × plane × 651 бинов по 1 мм (−30..+30 см)
    const BINS = 651, MID = 325, BMM = 0.001;
    const hst = new Array(nPass).fill(null);
    const cnt = new Float64Array(nPass);
    const per = 1 << 18, buf = Buffer.allocUnsafe(per * rl);
    for (let i = 0; i < H.n; i += per) {
      const c = Math.min(per, H.n - i), bytes = c * rl; let got = 0;
      while (got < bytes) { const r = fs.readSync(fd, buf, got, bytes - got, H.off + i * rl + got); if (!r) break; got += r; }
      if (got < bytes) break;
      for (let q = 0, p = 0; q < c; q++, p += rl) {
        const t = buf.readDoubleLE(p + H.tOff); const k = passIdOf(t, t0, o.passSec);
        if (k < 0 || k >= nPass) continue;
        if (!hst[k]) hst[k] = planes.map(() => new Int32Array(BINS));
        const x = buf.readInt32LE(p) * H.sx + H.ox, y = buf.readInt32LE(p + 4) * H.sy + H.oy, z = buf.readInt32LE(p + 8) * H.sz + H.oz;
        let best = -1, bd = o.band, bs = 1;
        for (let j = 0; j < planes.length; j++) {
          const pl = planes[j];
          const d = pl.nx * x + pl.ny * y + (pl.nz || 0) * z - pl.c;
          if (Math.abs(d) < bd) { bd = Math.abs(d); best = j; bs = d < 0 ? -1 : 1; }
        }
        if (best < 0) continue;
        let b = MID + Math.round(bd * bs / BMM); if (b < 0) b = 0; if (b >= BINS) b = BINS - 1;
        hst[k][best][b]++; cnt[k]++;
      }
      prog(0.05 + 0.55 * (i + c) / H.n, 'Слияние проходов: разброс проходов…');
    }
    // медианы по проходам/плоскостям и сдвиги
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
      const t = solveShift(planes, obs);
      shifts[k * 3] = t.tx; shifts[k * 3 + 1] = t.ty; shifts[k * 3 + 2] = t.tz;
      const nn = Math.hypot(t.tx, t.ty, t.tz);
      shiftSum += nn; if (nn > shiftMax) shiftMax = nn;
    }
    // остаточный разброс по плоскостям до/после: σ медиан проходов
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
        if (vals.length >= 2) {
          const m = vals.reduce((a, b) => a + b, 0) / vals.length;
          const v = vals.reduce((a, b) => a + (b - m) * (b - m), 0) / vals.length;
          sig.push(Math.sqrt(v) * 1000);
        }
      }
      sig.sort((a, b) => a - b);
      return { planes: sig.length, median_sigma_mm: sig.length ? +sig[sig.length >> 1].toFixed(2) : null, max_sigma_mm: sig.length ? +sig[sig.length - 1].toFixed(2) : null };
    }
    const residualBefore = spread(false), residualAfter = spread(true);
    // запись: применяем сдвиги прохода, плотность сохраняется
    const hb = Buffer.alloc(H.off); fs.readSync(fd, hb, 0, hb.length, 0);
    ofd = fs.openSync(dst, 'w+'); fs.writeSync(ofd, hb, 0, hb.length, 0);
    const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let wpos = H.off, out = 0;
    const OB = Buffer.allocUnsafe(per * rl);
    for (let i = 0; i < H.n; i += per) {
      const c = Math.min(per, H.n - i), bytes = c * rl; let got = 0;
      while (got < bytes) { const r = fs.readSync(fd, buf, got, bytes - got, H.off + i * rl + got); if (!r) break; got += r; }
      if (got < bytes) break;
      let w = 0;
      for (let q = 0, p = 0; q < c; q++, p += rl) {
        const t = buf.readDoubleLE(p + H.tOff); const k = passIdOf(t, t0, o.passSec) | 0;
        const x = buf.readInt32LE(p) * H.sx + H.ox, y = buf.readInt32LE(p + 4) * H.sy + H.oy, z = buf.readInt32LE(p + 8) * H.sz + H.oz;
        const tx = k < nPass ? shifts[k * 3] : 0, ty = k < nPass ? shifts[k * 3 + 1] : 0, tz = k < nPass ? shifts[k * 3 + 2] : 0;
        const wx = x + tx, wy = y + ty, wz = z + tz;
        if (wx < bb[0]) bb[0] = wx; if (wy < bb[1]) bb[1] = wy; if (wz < bb[2]) bb[2] = wz;
        if (wx > bb[3]) bb[3] = wx; if (wy > bb[4]) bb[4] = wy; if (wz > bb[5]) bb[5] = wz;
        buf.writeInt32LE(Math.round((wx - H.ox) / H.sx), p);
        buf.writeInt32LE(Math.round((wy - H.oy) / H.sy), p + 4);
        buf.writeInt32LE(Math.round((wz - H.oz) / H.sz), p + 8);
        w += rl; out++;
      }
      if (w) { fs.writeSync(ofd, buf, 0, w, wpos); wpos += w; }
      prog(0.6 + 0.35 * (i + c) / H.n, 'Слияние проходов: запись…');
    }
    R.finishLas(ofd, H, out, bb, wpos);
    fs.closeSync(ofd); ofd = null;
    const stats = { passes: passCount, passSec: o.passSec, planes: planes.length, verticalPlanes: vplanes.length,
      points: out, removed: H.n - out, shiftMedianMm: passCount ? +(shiftSum / passCount * 1000).toFixed(2) : 0,
      shiftMaxMm: +(shiftMax * 1000).toFixed(2), residualBeforeMm: residualBefore, residualAfterMm: residualAfter,
      ms: Date.now() - t0ms };
    return stats;
  } catch (e) {
    if (ofd !== null) { try { fs.closeSync(ofd); } catch (_) {} try { fs.rmSync(dst, { force: true }); } catch (_) {} }
    throw e;
  } finally {
    if (ofd !== null) { try { fs.closeSync(ofd); } catch (_) {} }
    fs.closeSync(fd);
  }
}

function readFirstTime(fd, H) {
  const b = Buffer.alloc(H.rl); fs.readSync(fd, b, 0, H.rl, H.off); return b.readDoubleLE(H.tOff);
}
function readLastTime(fd, H) {
  if (H.n < 1) return 0; const b = Buffer.alloc(H.rl); fs.readSync(fd, b, 0, H.rl, H.off + (H.n - 1) * H.rl); return b.readDoubleLE(H.tOff);
}

module.exports = { fuseLas, passBounds, passIdOf, ransacVertical, horizontalPlanes, solveShift, readSample, DEF };
