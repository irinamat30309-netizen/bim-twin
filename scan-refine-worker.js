'use strict';
// Фоновый поток: чистовая обработка скана в новый LAS (scan-refine-core.js), при наличии траектории — с удалением движущихся объектов.
const { parentPort, workerData } = require('node:worker_threads');
const R = require('./scan-refine-core');
const RP = require('./scan-refine-parallel');   // ревизия 45: плитки — на всех ядрах
const D = require('./dynamic-clean-core');
const CB = require('./color-balance-core');
(async () => { try {
  const { src, out, tmpDir, posesText, dynOpt, opt } = workerData || {};
  let last = -1;
  const send = (f, label) => { const p = Math.floor(f * 400); if (p === last) return; last = p; parentPort.postMessage({ type: 'progress', progress: f, label }); };
  const o = Object.assign({}, opt || {}, { tmpDir });
  let dynWarning = null, dynStats = null, base = 0;
  o.dynamic = null;
  // ревизия 48: насыщенность как у Lixel Studio на фасаде с двором (0,73; в scan-refine-core по умолчанию 0,8); colorBalanceOpt переопределяет
  o.colorBalanceOpt = Object.assign({ saturation: CB.LIXEL_SATURATION }, o.colorBalanceOpt || {});
  o.posesText = posesText || null;   // ревизия 21: траектория и для сведения проходов (поворот вокруг положения сканера)
  // ревизия 19: движущиеся объекты и без траектории — по «следам» во времени точек LAS
  if (opt && opt.dynamic) {
    try {
      const v = D.detect(src, posesText || null, dynOpt || {}, (f, l) => send(0.4 * f, 'Движущиеся объекты: ' + D.stageLabel(l).toLowerCase()));
      o.dynamic = { sets: v.sets }; dynStats = v.stats;
    } catch (e) { dynWarning = String((e && e.message) || e); }
    base = 0.4;
  }
  const prog = (f, l) => send(base + (1 - base) * f, l);
  let st, parallelWarning = null;
  try { st = await RP.refineParallel(src, out, o, prog); }
  catch (e) {   // пул потоков не поднялся (мало памяти, ограничения системы) — обработка в одном потоке, как раньше
    parallelWarning = String((e && e.message) || e); last = -1;
    st = R.refine(src, out, o, prog);
  }
  parentPort.postMessage({ type: 'result', result: { ok: true, stats: st, dynStats, dynWarning, parallelWarning } });
} catch (e) {
  parentPort.postMessage({ type: 'result', result: { ok: false, error: String((e && e.message) || e) } });
} })();
