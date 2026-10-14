/* Exact triangle-mesh plane sections run outside the renderer UI thread.
 * Large inputs are transferred from disposable copies; terminating this worker
 * is the cancellation mechanism and cannot mutate the displayed mesh.
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
    if (!self.Section || typeof self.Section.meshPlaneSection !== 'function') {
      throw new Error('Модуль точного сечения не загрузился в Worker');
    }
    if (request.operation !== 'mesh-section' || !Array.isArray(request.primitives) ||
        !request.primitives.length || !request.plane) {
      throw new TypeError('Worker получил некорректный запрос mesh-сечения');
    }
    request.primitives.forEach(function (primitive, index) {
      if (!primitive || !ArrayBuffer.isView(primitive.positions) ||
          primitive.positions instanceof DataView ||
          primitive.positions.length < 9 || primitive.positions.length % 3 !== 0) {
        throw new RangeError('Worker получил некорректные вершины меша #' + (index + 1));
      }
      if (primitive.indices && (!ArrayBuffer.isView(primitive.indices) ||
          primitive.indices instanceof DataView || primitive.indices.length % 3 !== 0)) {
        throw new RangeError('Worker получил некорректные индексы меша #' + (index + 1));
      }
    });

    var ranges = {
      bounds: [0, 8],
      intersect: [8, 72],
      coplanar: [72, 75],
      adjacency: [75, 86],
      trace: [86, 99],
      complete: [100, 100]
    };
    var lastPercent = -1;
    self.postMessage({ id: id, type: 'progress', percent: 0, phase: 'prepare', completed: 0, total: 1 });
    var result = self.Section.meshPlaneSection(request.primitives, request.plane, {
      maxTriangles: 2000000,
      epsilon: request.epsilon,
      stitchTolerance: request.stitchTolerance,
      onProgress: function (progress) {
        var range = ranges[progress.phase] || [0, 99];
        var percent = progress.phase === 'complete'
          ? 100
          : Math.round(range[0] + (range[1] - range[0]) * (Number(progress.fraction) || 0));
        percent = Math.max(lastPercent, Math.min(100, percent));
        if (percent !== lastPercent || progress.completed === progress.total) {
          lastPercent = percent;
          self.postMessage({
            id: id,
            type: 'progress',
            percent: percent,
            phase: progress.phase,
            completed: Number(progress.completed) || 0,
            total: Number(progress.total) || 0
          });
        }
      }
    });
    self.postMessage({
      id: id,
      type: 'progress',
      percent: 100,
      phase: 'complete',
      completed: 1,
      total: 1
    });
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