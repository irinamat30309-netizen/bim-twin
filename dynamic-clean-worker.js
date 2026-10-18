'use strict';
// Фоновый поток: удаление движущихся объектов по траектории (dynamic-clean-core.js) — главный процесс и окно не замирают.
const { parentPort, workerData } = require('node:worker_threads');
const D = require('./dynamic-clean-core');
try {
  const { lasPath, posesText, opt } = workerData || {};
  let last = -1;
  const r = D.run(lasPath, posesText, Object.assign({}, opt || {}, { voxelsOnly: true }), (f, label) => {
    const p = Math.floor(f * 200); if (p === last) return; last = p;
    parentPort.postMessage({ type: 'progress', progress: f, label: label === 'занятость' ? 'Чтение облака…' : label === 'лучи' ? 'Проверка лучей сканера…' : 'Анализ…' });
  });
  parentPort.postMessage({ type: 'result', result: { ok: true, keys: r.keys, grid: r.grid, stats: r.stats } }, [r.keys.buffer]);
} catch (e) {
  parentPort.postMessage({ type: 'result', result: { ok: false, error: String((e && e.message) || e) } });
}
