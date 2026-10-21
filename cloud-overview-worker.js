'use strict';
// Поток карты облака (ревизия 27): выборка для карты до загрузки или горизонтальный срез для чертежа плана — главный процесс не блокируется.
const { parentPort, workerData } = require('worker_threads');
const OV = require('./cloud-overview');

function transfer(obj) {
  const list = [], seen = new Set();
  const add = (v) => { if (ArrayBuffer.isView(v) && v.buffer instanceof ArrayBuffer && !seen.has(v.buffer)) { seen.add(v.buffer); list.push(v.buffer); } };
  if (obj && obj.grid) for (const k of ['count', 'hmax', 'hmin', 'rgb', 'inten']) add(obj.grid[k]);
  if (obj && obj.hist) add(obj.hist.counts);
  if (obj) { add(obj.pts); add(obj.uv); if (obj.slice) add(obj.slice.preview); }
  return list;
}
try {
  const d = workerData || {};
  let result;
  if (d.job === 'slice' || d.job === 'plan') {
    let last = 0;
    const scale = d.job === 'plan' ? 0.7 : 1;
    result = OV.planSlice(d.desc, Object.assign({}, d.opts, { onProgress: (f) => { if (f - last >= 0.01) { last = f; parentPort.postMessage({ type: 'progress', progress: f * scale, label: 'Читаю срез облака' }); } } }));
    if (d.job === 'plan' && result && result.ok) {
      // план: стены, проёмы, помещения (renderer/auto-plan.js — тот же модуль, что в окне) + редкая выборка среза для подложки
      parentPort.postMessage({ type: 'progress', progress: 0.75, label: 'Ищу стены и проёмы' });
      const AP = require('./renderer/auto-plan.js');
      const plan = AP.extract(result.uv, (d.opts && d.opts.plan) || {});
      const n = result.count, keep = Math.min(n, 200000), st = n / Math.max(1, keep), pv = new Float32Array(keep * 2);
      for (let j = 0; j < keep; j++) { const i = Math.floor(j * st); pv[j * 2] = result.uv[i * 2]; pv[j * 2 + 1] = result.uv[i * 2 + 1]; }
      result = { ok: !!plan.ok, message: plan.message, plan, slice: { count: n, stride: result.stride, h0: result.h0, h1: result.h1, preview: pv } };
    }
  } else result = OV.overview(d.desc, d.opts || {});
  parentPort.postMessage({ type: 'result', result }, transfer(result));
} catch (e) {
  parentPort.postMessage({ type: 'result', result: { ok: false, message: 'Ошибка карты облака: ' + String((e && e.message) || e) } });
}
