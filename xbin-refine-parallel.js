'use strict';
/*
 * xbin-refine-parallel.js — r179: параллельное уточнение траектории (refine) по временным сегментам.
 *
 * Длинный скан (20+ ГБ, 35+ мин) последовательно уточняется ~130 окнами — это десятки минут CPU.
 * Здесь диапазон скана делится на N сегментов с перекрытием; каждый сегмент уточняется своим
 * worker_threads-потоком (общий scan()-индекс передаётся один раз), затем поправки поз (knots)
 * сливаются с линейным перекрытием в одну траекторию. Качество: в зонах перекрытия веса
 * сегментов плавно (линейно) переходят друг в друга.
 */
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

function mergeKnots(segs, T0, T1, dt, overlap) {
  const K = Math.max(2, Math.ceil((T1 - T0) / dt) + 2);
  const X = new Float64Array(K * 6), W = new Float64Array(K);
  const add = (k, x, w) => {
    if (!(w > 0)) return;
    const i0 = k * 6;
    for (let j = 0; j < 6; j++) X[i0 + j] += x[j] * w;
    W[k] += w;
  };
  for (const s of segs) {
    const a = Math.max(T0, s.T0), b = Math.min(T1, s.T1);
    const k0 = Math.max(0, Math.floor((a - T0) / dt)), k1 = Math.min(K - 1, Math.ceil((b - T0) / dt));
    const SK = s.knots.x.length / 6, sdt = s.knots.dt || dt;
    for (let k = k0; k <= k1; k++) {
      const t = T0 + k * dt;
      if (t < a || t > b) continue;
      // вес сегмента: 1 в середине, линейно к 0 на краях перекрытия
      let w = 1;
      if (s.T0 > T0 + 1e-9) w = Math.min(w, (t - s.T0) / overlap);
      if (s.T1 < T1 - 1e-9) w = Math.min(w, (s.T1 - t) / overlap);
      if (!(w > 0)) continue;
      // значение knots сегмента в момент t (линейная интерполяция)
      const u = (t - s.knots.t0) / sdt;
      let ku = Math.floor(u); if (ku < 0) ku = 0; if (ku > SK - 2) ku = SK - 2;
      const al = Math.max(0, Math.min(1, u - ku)), be = 1 - al, i0 = ku * 6, i1 = i0 + 6;
      const v = new Float64Array(6);
      for (let j = 0; j < 6; j++) v[j] = s.knots.x[i0 + j] * be + s.knots.x[i1 + j] * al;
      add(k, v, w);
    }
  }
  // нормировка; для непокрытых узлов — ближайший сегмент
  let lastV = new Float64Array(6), haveLast = false;
  for (let k = 0; k < K; k++) {
    if (W[k] > 1e-9) {
      for (let j = 0; j < 6; j++) X[k * 6 + j] /= W[k];
      lastV = X.subarray(k * 6, k * 6 + 6);
      haveLast = true;
    } else if (haveLast) {
      for (let j = 0; j < 6; j++) X[k * 6 + j] = lastV[j];
    }
  }
  return { t0: T0, dt, x: X, K, segs: segs.length };
}

/** параллельный refine: S — готовый scan()-индекс, o — опции сборки/refine */
function refineParallel(xbinPath, posesText, S, o, prog, opts) {
  const P = (opts || {});
  const T0 = Math.max(S.t0, o.t0 != null ? o.t0 : -Infinity);
  const T1 = Math.min(S.t1, o.t1 != null ? o.t1 : Infinity);
  const duration = T1 - T0;
  const nSeg = Math.max(2, Math.min(P.workers || Math.max(2, Math.min(5, os.cpus().length - 1)), Math.floor(duration / 120)));
  const segLen = duration / nSeg;
  const overlap = Math.max(15, Math.min(40, segLen * 0.08));   // r179: небольшое перекрытие — меньше лишних окон
  const jobs = [];
  for (let i = 0; i < nSeg; i++) {
    const a = T0 + i * segLen - (i > 0 ? overlap : 0);
    const b = T0 + (i + 1) * segLen + (i < nSeg - 1 ? overlap : 0);
    jobs.push({ job: i, t0: Math.max(T0, a), t1: Math.min(T1, b) });
  }
  const optForWorker = Object.assign({}, o);
  delete optForWorker.index;
  // сериализуем только нужные поля refineOpt (без функций)
  const workerUrl = path.join(__dirname, 'xbin-refine-worker.js');
  return new Promise((resolve, reject) => {
    const results = new Array(nSeg);
    let done = 0, failed = null, active = 0, next = 0;
    const cur = new Array(nSeg).fill(0);
    const finish = () => {
      if (failed) { reject(failed); return; }
      if (done !== nSeg) return;
      try {
        const segs = results.map(r => ({ knots: r.knots, T0: r.T0, T1: r.T1, summary: r.summary }));
        const merged = mergeKnots(segs, T0, T1, 0.1, overlap);
        const s0 = segs[0].summary || {};
        const summary = Object.assign({}, s0, {
          segments: nSeg, overlapSec: Math.round(overlap),
          residualBeforeMm: +(segs.reduce((s, r) => s + (r.summary.residualBeforeMm || 0), 0) / segs.length).toFixed(3),
          residualAfterMm: +(segs.reduce((s, r) => s + (r.summary.residualAfterMm || 0), 0) / segs.length).toFixed(3),
          seconds: +(segs.reduce((s, r) => s + (r.summary.seconds || 0), 0)).toFixed(1),
          windows: segs.reduce((s, r) => s + (r.summary.windows || 0), 0),
          parallelWorkers: nSeg
        });
        resolve({ knots: merged, summary });
      } catch (e) { reject(e); }
    };
    const spawn = () => {
      while (active < nSeg && next < nSeg) {
        const idx = next++;
        active++;
        const w = new Worker(workerUrl, { workerData: {
          xbinPath, posesText, index: S, t0: jobs[idx].t0, t1: jobs[idx].t1, opt: optForWorker, job: idx
        } });
        w.on('message', (m) => {
          if (!m) return;
          if (m.type === 'progress') {
            cur[m.job] = Number(m.f) || 0;
            const f = (done + cur.reduce((a, b) => a + b, 0)) / nSeg;
            try { prog(Math.max(0, Math.min(1, f)), (m.label || 'Уточнение траектории (параллельно)') + ' — сегмент ' + (m.job + 1) + '/' + nSeg); } catch (_) {}
          } else if (m.type === 'result') {
            active--;
            if (!m.ok) { failed = failed || new Error('refine worker: ' + (m.error || 'ошибка')); try { w.terminate(); } catch (_) {} }
            else { results[m.job] = m; done++; }
            spawn();
            finish();
          }
        });
        w.on('error', (e) => { active--; failed = failed || e; try { w.terminate(); } catch (_) {} finish(); });
        w.on('exit', () => { /* нормальное завершение после result */ });
      }
    };
    spawn();
  });
}

module.exports = { refineParallel, mergeKnots };
