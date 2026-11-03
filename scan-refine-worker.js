'use strict';
// Фоновый поток: чистовая обработка скана в новый LAS (scan-refine-core.js), при наличии траектории — с удалением движущихся объектов.
const { parentPort, workerData } = require('node:worker_threads');
const R = require('./scan-refine-core');
const RP = require('./scan-refine-parallel');   // ревизия 45: плитки — на всех ядрах
const D = require('./dynamic-clean-core');
const CB = require('./color-balance-core');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Ревизия 51: файл сканера .xbin для уплотнения по сырому лидару (cloud-densify-core): opt.xbinPath, путь от «Цвета по фото»
 * (xbin-source.txt во временной папке) или .xbin рядом с облаком. Облако, собранное из самого .xbin, не уплотняется.
 */
function densifySource(src, tmpDir, o) {
  if (o.densify === false || o.noiseLevel === 'inspect') return null;   // подготовка к контролю отклонений — без новых точек
  try { const fd = fs.openSync(src, 'r'), h = Buffer.alloc(64); fs.readSync(fd, h, 0, 64, 26); fs.closeSync(fd); if (/xbin-lidar/.test(h.toString('latin1'))) return null; } catch (_) { return null; }
  const ok = (f) => { try { return f && fs.statSync(f).isFile() && /\.xbin$/i.test(f) ? f : null; } catch (_) { return null; } };
  let f = ok(o.xbinPath);
  if (!f && tmpDir) { try { f = ok(fs.readFileSync(path.join(tmpDir, 'xbin-source.txt'), 'utf8').trim()); } catch (_) {} }
  if (!f && (!tmpDir || path.resolve(path.dirname(src)) !== path.resolve(tmpDir))) { try { f = ok(require('./xbin-core').findNear(path.resolve(src))); } catch (_) {} }
  return f;
}
(async () => { try {
  const { src, out, tmpDir, posesText, dynOpt, opt } = workerData || {};
  let last = -1;
  const send = (f, label) => { const p = Math.floor(f * 400); if (p === last) return; last = p; parentPort.postMessage({ type: 'progress', progress: f, label }); };
  const o = Object.assign({}, opt || {}, { tmpDir });
  let dynWarning = null, dynStats = null, base = 0;
  o.dynamic = null;
  // ревизия 48: насыщенность как у Lixel Studio на фасаде с двором (0,73; в scan-refine-core по умолчанию 0,8); colorBalanceOpt переопределяет
  // ревизия 49: облако после «Цвета по фото» (opt.photoColor из main.js) — своя насыщенность, снимки камер пестрее карты сканера
  o.colorBalanceOpt = Object.assign({ saturation: o.photoColor ? CB.LIXEL_SATURATION_PHOTO : CB.LIXEL_SATURATION }, o.colorBalanceOpt || {});
  o.posesText = posesText || null;   // ревизия 21: траектория и для сведения проходов (поворот вокруг положения сканера)
  // ревизия 19: движущиеся объекты и без траектории — по «следам» во времени точек LAS
  if (opt && opt.dynamic) {
    try {
      const v = D.detect(src, posesText || null, dynOpt || {}, (f, l) => send(0.4 * f, 'Движущиеся объекты: ' + D.stageLabel(l).toLowerCase()));
      o.dynamic = { sets: v.sets }; dynStats = v.stats;
    } catch (e) { dynWarning = String((e && e.message) || e); }
    base = 0.4;
  }
  const xbin = posesText ? densifySource(src, tmpDir, o) : null, pRef = xbin ? 0.75 : 1;
  const prog = (f, l) => send(base + (1 - base) * pRef * f, l);
  let st, parallelWarning = null;
  try { st = await RP.refineParallel(src, out, o, prog); }
  catch (e) {   // пул потоков не поднялся (мало памяти, ограничения системы) — обработка в одном потоке, как раньше
    parallelWarning = String((e && e.message) || e); last = -1;
    // ревизия 50: сначала те же плитки в этом потоке (со сглаживанием зерна цвета), затем — прежняя обработка целиком
    try { st = await RP.refineParallel(src, out, Object.assign({}, o, { threads: 1 }), prog); }
    catch (_) { last = -1; st = R.refine(src, out, o, prog); }
  }
  // ревизия 51: уплотнение по сырому лидару — пустоты между точками карты заполняются точками лидара, прижатыми к поверхности
  let densifyWarning = null;
  if (xbin && st) {
    const dOut = out + '.dense.las';
    try {
      const size = fs.statSync(out).size; let free = Infinity;
      try { const sf = fs.statfsSync(path.dirname(out)); free = Number(sf.bavail) * Number(sf.bsize); } catch (_) {}
      if (Number.isFinite(free) && free < size * 2.8) throw new Error('не хватает места на диске (нужно около ' + (size * 2.8 / 1073741824).toFixed(1) + ' ГБ)');
      const D = await require('./cloud-densify-core').densifyLas(out, dOut, { xbinPath: xbin, posesText }, Object.assign({ tmpDir: tmpDir || path.dirname(out) }, o.densifyOpt || {}),
        (f, l) => send(base + (1 - base) * (pRef + (1 - pRef) * f), l));
      fs.renameSync(dOut, out);
      st.densify = { added: D.added, points: D.points, raw: D.raw, threads: D.threads, ms: D.ms, xbin: path.basename(xbin) };
      st.written = D.points;
    } catch (e) { densifyWarning = String((e && e.message) || e); try { fs.rmSync(dOut, { force: true }); } catch (_) {} }
  }
  parentPort.postMessage({ type: 'result', result: { ok: true, stats: st, dynStats, dynWarning, parallelWarning, densifyWarning } });
} catch (e) {
  parentPort.postMessage({ type: 'result', result: { ok: false, error: String((e && e.message) || e) } });
} })();
