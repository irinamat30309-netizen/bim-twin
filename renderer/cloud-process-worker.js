/* Обработка облака точек вне потока интерфейса (сглаживание, выравнивание поверхностей, подавление шума, ресэмплирование).
 * Координаты приходят одноразовой копией и возвращаются без копирования; отмена — terminate() из окна, показанное облако не затрагивается.
 */
'use strict';
importScripts('cloud-process.js?v=1160');

self.onmessage = function (e) {
  var m = e.data || {}, t0 = Date.now(), lastSent = 0;
  var ctl = {
    progress: function (frac, label) {
      var t = Date.now();
      if (t - lastSent < 120 && frac < 1) return;
      lastSent = t; self.postMessage({ type: 'progress', frac: frac, label: label });
    }
  };
  try {
    var res = self.CloudProcess.run(m.op, m.pos, m.params || {}, ctl), tr = [];
    if (res.pos && res.pos.buffer) tr.push(res.pos.buffer);
    if (res.keep && res.keep.buffer) tr.push(res.keep.buffer);
    res.ms = Date.now() - t0;
    self.postMessage({ type: 'done', result: res }, tr);
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
