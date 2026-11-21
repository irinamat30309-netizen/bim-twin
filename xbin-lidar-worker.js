'use strict';
// Ревизия 24: фоновый поток — облако точек из сырого лидара .xbin (xbin-lidar.js); главный процесс и окно не замирают.
// r179: для длинных сканов refine выполняется параллельно по сегментам (xbin-refine-parallel.js) в отдельных потоках,
// затем сборка идёт с готовыми поправками траектории (без повторного уточнения).
const { parentPort, workerData } = require('node:worker_threads');
const XL = require('./xbin-lidar');

(async () => {
  try {
    const { xbinPath, posesText, outPath, opt: optIn } = workerData || {};
    const opt = Object.assign({}, optIn || {});
    let last = 0;
    const post = (f, label) => {
      const now = Date.now(); if (now - last < 200 && f < 1) return; last = now;
      parentPort.postMessage({ type: 'progress', progress: Math.max(0, Math.min(1, f)), label });
    };
    let refineInfoForStats = null;
    const durationHint = Number(opt.durationSec) || 0;
    // Параллельное уточнение: только для длинных сканов и если не отключено явно.
    if (opt.refine && opt.parallelRefine !== false && !opt.refineKnots && durationHint > 900) {
      try {
        const t0 = Date.now();
        post(0.02, 'Облако из .xbin: оглавление файла (параллельное уточнение)…');
        const S = XL.scan(xbinPath, (f) => post(0.02 + 0.05 * f, 'Облако из .xbin: оглавление файла…'));
        const RP = require('./xbin-refine-parallel');
        const pr = await RP.refineParallel(xbinPath, posesText, S, opt,
          (f, label) => post(0.07 + 0.55 * f, label || 'Облако из .xbin: параллельное уточнение траектории…'),
          { workers: opt.refineWorkers });
        opt.refineKnots = pr;
        opt.index = S;
        refineInfoForStats = Object.assign({ parallelMs: Date.now() - t0 }, pr.summary);
        post(0.62, 'Облако из .xbin: уточнение готово, сборка точек…');
      } catch (e) {
        // откат на обычный последовательный refine внутри build
        delete opt.refineKnots; delete opt.index;
        post(0.07, 'Параллельное уточнение не удалось (' + String((e && e.message) || e) + ') — обычное уточнение…');
      }
    }
    const base = refineInfoForStats ? 0.62 : 0;
    const scale = refineInfoForStats ? 0.38 : 1;
    const r = XL.build(xbinPath, posesText, outPath, opt, (f, label) => post(base + scale * f, label));
    if (refineInfoForStats) r.refine = Object.assign({}, r.refine || {}, { parallel: refineInfoForStats });
    parentPort.postMessage({ type: 'result', result: Object.assign({ ok: true }, r) });
  } catch (e) {
    parentPort.postMessage({ type: 'result', result: { ok: false, error: 'xbin_lidar_failed', message: String((e && e.message) || e) } });
  }
})();
