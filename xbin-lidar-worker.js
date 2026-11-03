'use strict';
// Ревизия 24: фоновый поток — облако точек из сырого лидара .xbin (xbin-lidar.js); главный процесс и окно не замирают.
const { parentPort, workerData } = require('node:worker_threads');
const XL = require('./xbin-lidar');
try {
  const { xbinPath, posesText, outPath, opt } = workerData || {};
  let last = 0;
  const r = XL.build(xbinPath, posesText, outPath, opt || {}, (f, label) => { const now = Date.now(); if (now - last < 200 && f < 1) return; last = now; parentPort.postMessage({ type: 'progress', progress: f, label }); });
  parentPort.postMessage({ type: 'result', result: Object.assign({ ok: true }, r) });
} catch (e) {
  parentPort.postMessage({ type: 'result', result: { ok: false, error: 'xbin_lidar_failed', message: String((e && e.message) || e) } });
}
