'use strict';
// Ревизия 45: поток пула чистовой обработки — получает номер подготовленной плитки, обрабатывает её (scan-refine-core.processTile)
// и записывает результат рядом (<плитка>.out); основной поток собирает плитки в LAS по порядку (scan-refine-parallel.js).
const fs = require('node:fs');
const path = require('node:path');
const R = require('./scan-refine-core');

/** Контекст обработки плитки из передаваемых между потоками данных (решения сведения/цвета, наборы движущихся вокселей). */
function makeCtx(d) {
  let corr = null, cfix = null, DV = null;
  if (d.alignSol) {
    let poseAt = null;
    if (d.alignTraj) {
      const DC = require('./dynamic-clean-core');
      const Pz = d.poses || (d.posesText ? DC.parsePoses(d.posesText) : null);
      if (Pz) { const f = DC.makePoseAt(Pz); poseAt = (t, out) => { f(t, out); return out; }; }
    }
    corr = require('./pass-align-core').makeCorrector(d.alignSol, poseAt);
  }
  if (d.cbSol) cfix = require('./color-balance-core').makeColorFix(d.cbSol);
  if (d.dynSets && d.dynSets.length) DV = require('./renderer/dynamic-voxels').buildMany(d.dynSets);
  return { H: d.H, RS: d.RS, CS: d.CS, x0: d.x0, y0: d.y0, c16: d.c16, opt: d.opt, corr, cfix, DV };
}

/** Обработать плитку t из временного файла: результат — в <t>.out, итоги без самих точек. */
function runTile(ctx, tmp, t, T) {
  const f = path.join(tmp, t + '.bin');
  const B = fs.readFileSync(f); fs.unlinkSync(f);
  const r = R.processTile(B, T, ctx);
  fs.writeFileSync(path.join(tmp, t + '.out'), r.O.subarray(0, r.w));
  return { t, w: r.w, k: r.k, n0: r.n0, nDyn: r.nDyn, nNoise: r.nNoise, nMoved: r.nMoved, nColor: r.nColor, bb: r.bb };
}

module.exports = { makeCtx, runTile };

const wt = require('node:worker_threads');
if (!wt.isMainThread && require.main === module && wt.workerData && wt.workerData.__refineTile) {   // только как точка входа потока
  let ctx = null;
  try { ctx = makeCtx(wt.workerData); } catch (e) { wt.parentPort.postMessage({ type: 'error', error: String((e && e.message) || e) }); }
  if (ctx) {
    wt.parentPort.on('message', (m) => {
      if (!m || m.type !== 'tile') return;
      try { wt.parentPort.postMessage(Object.assign({ type: 'done' }, runTile(ctx, wt.workerData.tmp, m.t, m.T))); }
      catch (e) { wt.parentPort.postMessage({ type: 'error', t: m.t, error: String((e && e.message) || e) }); }
    });
    wt.parentPort.postMessage({ type: 'ready' });
  }
}
