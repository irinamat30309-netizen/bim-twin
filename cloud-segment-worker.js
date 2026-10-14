'use strict';
// Поток чтения одной части облака (ревизия 16): читает диапазон точек файла в готовые массивы окна и отдаёт их передачей (без копии).
const { parentPort, workerData } = require('worker_threads');
const Seg = require('./cloud-segments');

function transferables(result) {
  const list = [], seen = new Set();
  for (const key of ['pos', 'col', 'intensity', 'classification', 'chunkBoxes']) {
    const v = result && result[key];
    if (!ArrayBuffer.isView(v) || !(v.buffer instanceof ArrayBuffer) || !v.buffer.byteLength || seen.has(v.buffer)) continue;
    seen.add(v.buffer); list.push(v.buffer);
  }
  return list;
}

try {
  const d = workerData || {};
  const result = Seg.readSegment(d.desc, d.from, d.count, { shuffle: d.shuffle !== false });
  parentPort.postMessage({ type: 'result', result }, transferables(result));
} catch (e) {
  parentPort.postMessage({ type: 'result', result: { ok: false, message: 'Ошибка чтения облака: ' + String((e && e.message) || e) } });
}
