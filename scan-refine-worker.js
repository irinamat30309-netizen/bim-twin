'use strict';
// Фоновый поток: чистовая обработка скана в новый LAS (scan-refine-core.js), при наличии траектории — с удалением движущихся объектов.
const { parentPort, workerData } = require('node:worker_threads');
const R = require('./scan-refine-core');
const D = require('./dynamic-clean-core');
try {
  const { src, out, tmpDir, posesText, dynOpt, opt } = workerData || {};
  let last = -1;
  const send = (f, label) => { const p = Math.floor(f * 400); if (p === last) return; last = p; parentPort.postMessage({ type: 'progress', progress: f, label }); };
  const o = Object.assign({}, opt || {}, { tmpDir });
  let dynWarning = null, dynStats = null, base = 0;
  o.dynamic = null;
  // ревизия 19: движущиеся объекты и без траектории — по «следам» во времени точек LAS
  if (opt && opt.dynamic) {
    try {
      const v = D.detect(src, posesText || null, dynOpt || {}, (f, l) => send(0.4 * f, 'Движущиеся объекты: ' + D.stageLabel(l).toLowerCase()));
      o.dynamic = { sets: v.sets }; dynStats = v.stats;
    } catch (e) { dynWarning = String((e && e.message) || e); }
    base = 0.4;
  }
  const st = R.refine(src, out, o, (f, l) => send(base + (1 - base) * f, l));
  parentPort.postMessage({ type: 'result', result: { ok: true, stats: st, dynStats, dynWarning } });
} catch (e) {
  parentPort.postMessage({ type: 'result', result: { ok: false, error: String((e && e.message) || e) } });
}
