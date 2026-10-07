/* Обработка облака точек вне потока интерфейса (сглаживание, выравнивание поверхностей, подавление шума, ресэмплирование).
 * Координаты приходят одноразовой копией и возвращаются без копирования; отмена — terminate() из окна, показанное облако не затрагивается.
 */
'use strict';
importScripts('cloud-process.js?v=1160', 'cloud-clean.js?v=1170');

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
    var res, tr = [];
    if (m.op === 'denoise2') res = self.CloudClean.denoise(m.pos, (m.pos.length / 3) | 0, m.params || {}, ctl);   // умное подавление шума: список удаляемых точек
    else if (m.op === 'autoclean') res = self.CloudClean.autoClean(m.pos, (m.pos.length / 3) | 0, m.params || {}, ctl);   // шум + люди + выравнивание плоскостей
    else if (m.op === 'people') res = self.CloudClean.people(m.pos, (m.pos.length / 3) | 0, m.params || {}, ctl);
    else res = self.CloudProcess.run(m.op, m.pos, m.params || {}, ctl);
    if (res.pos && res.pos.buffer) tr.push(res.pos.buffer);
    if (res.keep && res.keep.buffer) tr.push(res.keep.buffer);
    if (res.remove && res.remove.buffer) tr.push(res.remove.buffer);
    res.ms = Date.now() - t0;
    self.postMessage({ type: 'done', result: res }, tr);
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
