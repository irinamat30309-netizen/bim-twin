/* v1232 — Raster point-cloud section/profile worker.
 * The main thread can terminate this worker at any time to cancel an operation.
 */
'use strict';

try {
  importScripts('section.js?v=1233');
} catch (error) {
  self.postMessage({ type: 'fatal', error: error && error.message || String(error) });
}

self.addEventListener('message', function (event) {
  var request = event.data || {};
  var id = request.id;
  try {
    if (!self.Section) throw new Error('Модуль геометрии сечения не загружен в worker');
    if (!ArrayBuffer.isView(request.pos) || !Number.isSafeInteger(request.count) ||
        request.count < 1 || request.count * 3 > request.pos.length) {
      throw new RangeError('Worker получил некорректный массив облака');
    }
    var range = {
      slice: [0, 45],
      profile: [0, 45],
      bounds: [45, 54],
      occupancy: [54, 72],
      'trace-grid': [72, 86],
      'trace-loops': [86, 99]
    };
    var lastPercent = -1;
    var options = Object.assign({}, request.options || {}, { compact: true }, {
      onProgress: function (progress) {
        var r = range[progress.phase] || [0, 99];
        var percent = Math.round(r[0] + (r[1] - r[0]) * progress.fraction);
        if (percent < lastPercent) percent = lastPercent;
        if (percent !== lastPercent || progress.completed === progress.total) {
          lastPercent = percent;
          self.postMessage({
            id: id,
            type: 'progress',
            percent: percent,
            phase: progress.phase,
            completed: progress.completed,
            total: progress.total
          });
        }
      }
    });
    var result;
    if (request.operation === 'profile') {
      result = self.Section.profileToPolylines(request.pos, request.count, options);
    } else if (request.operation === 'axis') {
      result = self.Section.sectionToPolylines(request.pos, request.count, options);
    } else {
      throw new TypeError('Неизвестный тип расчёта сечения');
    }
    self.postMessage({ id: id, type: 'progress', percent: 100, phase: 'complete', completed: 1, total: 1 });
    self.postMessage({ id: id, type: 'result', result: result });
  } catch (error) {
    self.postMessage({
      id: id,
      type: 'error',
      error: error && error.message || String(error),
      name: error && error.name || 'Error'
    });
  }
});