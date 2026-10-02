/*
 * cloud-chunks.js — сборка облака точек из кусков, которые отдаёт основной процесс (ревизия 6).
 *
 * Зачем. Раньше облако целиком шло из основного процесса в окно ОДНИМ IPC-сообщением (pos 12 + цвет 12 + интенсивность 4 +
 * класс 1 байт на точку): для 50 млн точек это ≈1,4 ГБ в одном сообщении, да ещё preload копирует его при передаче в окно.
 * Теперь крупные облака (больше APP_CONFIG.IPC_INLINE_POINTS) main держит у себя и отдаёт кусками по IPC_CHUNK_POINTS точек
 * (bim:readCloudChunk), а окно собирает итоговые массивы здесь — в основном мире, без лишней копии в preload. Ограничения по
 * числу точек, как в ревизии 5 (20 млн), больше нет: доля точек файла задаётся в Настройки → Облака точек.
 *
 *   resolve(api, result, { onProgress(fraction) })  → тот же result, но с полными pos/col/intensity/classification
 *   parse(api, path, jobId, opts)                    → api.parseCloud + resolve
 *
 * Результат без поля `chunked` возвращается как есть (малые облака, сетки, ошибки).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CloudChunks = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var TYPES = {
    Float32Array: typeof Float32Array !== 'undefined' ? Float32Array : null,
    Float64Array: typeof Float64Array !== 'undefined' ? Float64Array : null,
    Uint8Array: typeof Uint8Array !== 'undefined' ? Uint8Array : null,
    Uint16Array: typeof Uint16Array !== 'undefined' ? Uint16Array : null,
    Uint32Array: typeof Uint32Array !== 'undefined' ? Uint32Array : null,
    Int32Array: typeof Int32Array !== 'undefined' ? Int32Array : null
  };
  var FIELDS = ['pos', 'col', 'intensity', 'classification'];

  function isMemoryError(e) {
    var m = String((e && (e.message || e.name)) || e);
    return (e && e.name === 'RangeError') || /array buffer allocation|allocation failed|out of memory|Invalid typed array length/i.test(m);
  }

  async function resolve(api, result, opts) {
    if (!result || result.ok === false || !result.chunked) return result;
    opts = opts || {};
    var c = result.chunked;
    var n = Number(c.count) || 0;
    var step = Math.max(1, Number(c.chunkPoints) || 4000000);
    var token = c.token;
    var layout = c.fields || {};
    var out = {};
    var release = function () {
      try { if (api && typeof api.releaseCloud === 'function') return Promise.resolve(api.releaseCloud({ token: token })).catch(function () {}); } catch (_) {}
      return Promise.resolve();
    };
    try {
      if (!api || typeof api.readCloudChunk !== 'function') throw new Error('канал чтения кусков облака недоступен');
      FIELDS.forEach(function (f) {
        var d = layout[f];
        if (!d) return;
        var T = TYPES[d.type];
        if (!T) throw new Error('неизвестный тип данных облака: ' + d.type);
        out[f] = { T: T, per: d.per, arr: new T(n * d.per) };
      });
      if (!out.pos) throw new Error('в ответе нет координат');
      for (var from = 0; from < n; from += step) {
        var cnt = Math.min(step, n - from);
        var part = await api.readCloudChunk({ token: token, from: from, count: cnt });
        if (!part || part.ok === false) throw new Error((part && part.message) || 'не удалось прочитать кусок облака');
        FIELDS.forEach(function (f) {
          var o = out[f]; if (!o) return;
          var src = part[f];
          if (!src || src.length !== cnt * o.per) throw new Error('кусок облака повреждён (' + f + ')');
          o.arr.set(src, from * o.per);
        });
        if (typeof opts.onProgress === 'function') { try { opts.onProgress(Math.min(1, (from + cnt) / n)); } catch (_) {} }
        if (opts.signal && opts.signal.aborted) throw new Error('передача облака прервана');
      }
    } catch (e) {
      await release();
      if (isMemoryError(e)) {
        return { ok: false, message: 'Окну не хватило памяти для ' + (n / 1e6).toFixed(1) + ' млн точек. Выберите меньшую долю точек в Настройки → Облака точек и откройте файл снова.', outOfMemory: true };
      }
      return { ok: false, message: 'Не удалось передать облако в окно: ' + String((e && e.message) || e) };
    }
    await release();
    var res = {};
    for (var k in result) if (Object.prototype.hasOwnProperty.call(result, k) && k !== 'chunked') res[k] = result[k];
    FIELDS.forEach(function (f) { if (out[f]) res[f] = out[f].arr; });
    return res;
  }

  function parse(api, path, jobId, opts) {
    return Promise.resolve(api.parseCloud(path, jobId)).then(function (r) { return resolve(api, r, opts); });
  }

  return { resolve: resolve, parse: parse, FIELDS: FIELDS };
});
