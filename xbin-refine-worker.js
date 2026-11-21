'use strict';
// r179: воркер уточнения траектории по одному временному сегменту (параллельный refine).
const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const XL = require('./xbin-lidar');
const XR = require('./xbin-refine');

const { xbinPath, posesText, index, t0, t1, opt, job } = workerData || {};
try {
  const fd = fs.openSync(xbinPath, 'r');
  try {
    const C = XL.prepare(xbinPath, posesText, Object.assign({}, opt, { index, t0, t1 }));
    const ri = XR.refine(fd, C, Object.assign({}, opt, { refineOpt: (opt && opt.refineOpt) || {} }),
      (f, label) => parentPort.postMessage({ type: 'progress', job, f: Number(f) || 0, label }),
      XL.walk);
    parentPort.postMessage({ type: 'result', ok: true, job,
      knots: { t0: ri.knots.t0, dt: ri.knots.dt, x: ri.knots.x },
      summary: ri.summary, T0: C.T0, T1: C.T1 });
  } finally { fs.closeSync(fd); }
} catch (e) {
  parentPort.postMessage({ type: 'result', ok: false, job, error: String((e && e.message) || e) });
}
