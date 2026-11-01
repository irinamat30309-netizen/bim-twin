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
  let tfix = null;
  if (d.cbSol) { const CB = require('./color-balance-core'), late = !d.opt || d.opt.toneLate !== false; cfix = CB.makeColorFix(d.cbSol, { noTone: late }); if (late) tfix = CB.makeToneFix(d.cbSol); }
  if (d.dynSets && d.dynSets.length) DV = require('./renderer/dynamic-voxels').buildMany(d.dynSets);
  return { H: d.H, RS: d.RS, CS: d.CS, x0: d.x0, y0: d.y0, c16: d.c16, opt: d.opt, corr, cfix, DV, tfix };
}

/** Обработать плитку t из временного файла: результат — в <t>.out, итоги без самих точек. */
function runTile(ctx, tmp, t, T) {
  const f = path.join(tmp, t + '.bin');
  const B = fs.readFileSync(f); fs.unlinkSync(f);
  const r = R.processTile(B, T, ctx);
  const g = degrainTile(ctx, r);
  fs.writeFileSync(path.join(tmp, t + '.out'), r.O.subarray(0, r.w));
  return { t, w: r.w, k: r.k, n0: r.n0, nDyn: r.nDyn, nNoise: r.nNoise, nMoved: r.nMoved, nColor: r.nColor + g, bb: r.bb, noColor: r.noColor || 0, noColorLeft: r.noColorLeft || 0, degrain: g };
}

/**
 * Ревизия 50: «зерно» цвета (color-grain-core.degrain) — последним шагом, по готовым точкам плитки (после тоновой кривой).
 * Выключается opt.degrain === false; параметры — opt.degrainOpt. Возвращает число перекрашенных точек.
 */
function degrainTile(ctx, r) {
  const { H, opt, c16 } = ctx;
  if (!opt || !opt.color || opt.degrain === false || H.rgb === undefined || !r.k) return 0;
  const O = r.O, rl = H.rl, n = r.k, X = new Float64Array(n * 3), RGB = new Float32Array(n * 3), s = c16 ? 1 / 256 : 1;
  const cx = (r.bb[0] + r.bb[3]) / 2, cy = (r.bb[1] + r.bb[4]) / 2, cz = (r.bb[2] + r.bb[5]) / 2;
  for (let i = 0, o = 0; i < n; i++, o += rl) {
    X[i * 3] = O.readInt32LE(o) * H.sx + H.ox - cx; X[i * 3 + 1] = O.readInt32LE(o + 4) * H.sy + H.oy - cy; X[i * 3 + 2] = O.readInt32LE(o + 8) * H.sz + H.oz - cz;
    for (let a = 0; a < 3; a++) RGB[i * 3 + a] = O.readUInt16LE(o + H.rgb + a * 2) * s;
  }
  const g = require('./color-grain-core').degrain(X, RGB, n, null, opt.degrainOpt || {});
  if (g) for (let i = 0, o = 0; i < n; i++, o += rl) for (let a = 0; a < 3; a++) { const v = Math.round(RGB[i * 3 + a] / s); O.writeUInt16LE(v < 0 ? 0 : (v > 65535 ? 65535 : v), o + H.rgb + a * 2); }
  return g;
}

module.exports = { makeCtx, runTile, degrainTile };

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
