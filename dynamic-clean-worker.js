'use strict';
// Фоновый поток: движущиеся объекты (dynamic-clean-core.js) — главный процесс и окно не замирают.
// Ревизия 19: с траекторией (poses.csv) — лучи сканера + «следы» по времени точек; без траектории — только «следы».
const { parentPort, workerData } = require('node:worker_threads');
const D = require('./dynamic-clean-core');
try {
  const { lasPath, posesText, opt } = workerData || {};
  const r = D.detect(lasPath, posesText || null, opt || {}, (f, label) => parentPort.postMessage({ type: 'progress', progress: f, label: D.stageLabel(label) }));
  parentPort.postMessage({ type: 'result', result: Object.assign({ ok: true }, r) }, r.sets.map(s => s.keys.buffer));
} catch (e) {
  parentPort.postMessage({ type: 'result', result: { ok: false, error: String((e && e.message) || e) } });
}
