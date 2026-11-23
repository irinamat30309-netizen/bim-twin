'use strict';
/*
 * Ревизия 45: чистовая обработка на всех ядрах. Подготовка (разметка, сведение проходов, выравнивание цвета, раскладка
 * по плиткам) — как в scan-refine-core.refine; плитки обрабатывает пул потоков (scan-refine-tile-worker.js), результат
 * собирается строго в порядке плиток, поэтому LAS побайтно совпадает с однопоточным refine.
 * Потоков: ядра − 1 (не меньше двух), но не больше, чем позволяет свободная память (~300 байт на точку плитки).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const R = require('./scan-refine-core');
const TW = require('./scan-refine-tile-worker');
const WORKER = path.join(__dirname, 'scan-refine-tile-worker.js');
const BYTES_PER_POINT = 300;

function pickThreads(opt, nTiles, maxTile) {
  if (nTiles <= 1) return 1;
  if (opt.threads) return Math.max(1, Math.min(nTiles, 64, Math.floor(opt.threads)));
  const cpu = opt._cpus || (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);
  // r193: на очень больших облаках main-поток почти всё время ждёт воркеры, поэтому берём все ядра
  const maxWorkers = Math.max(1, Math.min(16, opt._bigCloud ? cpu : (cpu > 2 ? cpu - 1 : cpu)));
  const total = typeof opt._freeMem === 'number' ? opt._freeMem : os.freemem();
  const free = total - (768 << 20);
  const byMem = Math.floor(free / (BYTES_PER_POINT * Math.max(1, maxTile * 1.25)));
  // r193: если памяти мало — не сваливаемся в один поток, а уменьшаем плитку (см. fitTileMaxToMemory)
  const threads = Math.min(maxWorkers, cpu, 16, nTiles, Math.max(1, byMem));
  return Math.max(1, Math.min(threads, nTiles));
}
/**
 * r193: подбирает tileMax так, чтобы на CPU−1 воркеров хватило памяти.
 * Раньше при занятой памяти (в приложении открыто большое облако) pickThreads отдавал 1 поток —
 * плиточная стадия шла ~в 5 раз дольше (жалоба «~80 мин» на 590M). Теперь режем плитку, а не потоки.
 */
function fitTileMaxToMemory(opt) {
  if (opt.threads || opt._tileMaxFixed) return;
  try {
    const cpu = opt._cpus || (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);
    const workers = Math.max(2, Math.min(16, opt._bigCloud ? cpu : (cpu > 2 ? cpu - 1 : cpu)));
    const total = typeof opt._freeMem === 'number' ? opt._freeMem : os.freemem();
    const available = Math.max(256 << 20, total - (768 << 20));
    const perWorker = available / workers;
    const maxByMem = Math.floor(perWorker / (BYTES_PER_POINT * 1.25));
    opt._memInfo = { freeMemMB: Math.round(total / 1048576), workers, maxTileByMem: maxByMem, tileMaxBefore: opt.tileMax };
    if (maxByMem < opt.tileMax) opt.tileMax = Math.max(400000, maxByMem);
  } catch (_) {}
}
function liteOpt(opt) {
  const o = {}; for (const k of ['_stageTimings', 'noise', 'noiseLevel', 'thin', 'thinIters', 'thinCell', 'planar', 'maxThinShift', 'alignOpt', 'color', 'colorClamp', 'colorBalance', 'passEq', 'passEqOpt', 'fillNoColor', 'fillNoColorOpt', 'toneLate', 'degrain', 'degrainOpt', 'icicles', 'iciclesOpt', 'glass', 'glassOpt', 'fringeOpt', 'fringe', 'speckles']) if (opt[k] !== undefined) o[k] = opt[k];
  return o;
}
/**
 * r180: профиль чистки для плотных облаков (>50M точек, как r146 cleanProfile):
 * thin по умолчанию выключен (на плотных сборках он не улучшает стены, но дорог), денойз цвета не включаем.
 * Возвращает {thin, degrain, n, dense}.
 */
function denseCleanProfile(n, opt) {
  const o = opt || {};
  const dense = Number(n) > (o.denseThreshold > 0 ? o.denseThreshold : 50e6);
  const wantThin = o.thin !== undefined ? !!o.thin : true;
  // r180: для плотных облаков денойз цвета не включаем (дорого и по заданию не нужен), для небольших — как раньше
  const wantDegrain = dense ? o.degrain === true : o.degrain !== false;
  return { dense, n: Number(n) || 0, thin: dense ? false : wantThin, degrain: wantDegrain };
}
async function refineParallel(src, dst, opt, onProgress) {
  opt = Object.assign({ noise: true, thin: true, color: true, tileMax: 4000000, halo: 0.2, thinCell: 0.04, planar: 0.06 }, opt || {});
  // r180: профиль плотных облаков и дефолт «без денойза цвета»; заголовок читаем сразу (дешёво)
  try {
    const fd0 = fs.openSync(src, 'r'); const H0 = R.readHeader(fd0); fs.closeSync(fd0);
    const prof = denseCleanProfile(H0 && H0.n, opt);
    if (opt.denseProfile !== false && prof.dense) { opt.thin = false; opt.denseProfileUsed = true; }
    if (H0 && H0.n > 150e6) opt._bigCloud = true;   // r193: большие облака — все ядра (main всё равно ждёт)
    if (opt.degrain === undefined) opt.degrain = prof.degrain;
    opt._denseProfile = prof;
  } catch (_) {}
  // r193: сначала подгоняем размер плитки под свободную память (потоки не режем)
  try { fitTileMaxToMemory(opt); } catch (_) {}
  // Ревизия 56: плитки под размер облака. Раньше облако до 4 млн точек всегда было одной плиткой — один поток, и
  // чистовая не ускорялась. Если точек немного на поток, режем мельче (не меньше 0,6 млн на плитку), чтобы работали все
  // ядра: на окне 120 с (3,08 млн) это 35,9 → 14,2 с. Качество то же: в 25 плотных кубах 1 м — столько же точек и та же
  // толщина слоя (40,24 против 40,22 мм), отличие 409 точек из 3 млн (0,014 %) — только у границ плиток.
  if (!opt._tileMaxFixed) {
    try {
      const fd = fs.openSync(src, 'r'), H = R.readHeader(fd); fs.closeSync(fd);
      const cpu = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
      const threadsGuess = Math.max(2, Math.min(16, cpu - 1));
      const n = H && H.n ? H.n : 0;
      if (n > 1500000 && n / threadsGuess < opt.tileMax) {
        opt.tileMax = Math.max(600000, Math.min(opt.tileMax, Math.ceil(n / (threadsGuess * 2))));
      }
    } catch (_) {}
  }
  const prog = typeof onProgress === 'function' ? onProgress : () => {};
  const tPrep = Date.now();
  // r193: подготовка занимает 0..0.10 прогресса (плитки — 0.10..1.0); раньше 0.45 отдавали подготовке,
  // из-за чего общий прогресс и ETA расходились с реальной скоростью плиток.
  const prepProg = (f, label) => { try { prog(Math.min(0.10, Math.max(0, (Number(f) || 0) * (0.10 / 0.45))), label, { stage: 'prepare', frac: Number(f) || 0, prepMs: Date.now() - tPrep }); } catch (_) {} };
  const P = R.refine(src, dst, Object.assign({}, opt, { _prepareOnly: true }), prepProg);
  const prepareMs = Date.now() - tPrep;
  const { H, tiles, tmp, N, t0 } = P; let ofd = P.ofd; const workers = [];
  // r193: для плотных облаков без повторных проходов (align пропущен, colorBalance.segments=0) местное
  // выравнивание проходов passEq нечего исправлять — отключаем, экономия ~15–20 % CPU цветовой стадии.
  try {
    if (opt._denseProfile && opt._denseProfile.dense && opt.passEq === undefined &&
        (!P.align || P.align.skipped) && (!P.colorBalance || !P.colorBalance.segments)) {
      opt.passEq = false; opt._colorSimplify = 'no-multipass';
    }
  } catch (_) {}
  try {
    const jobs = []; let maxTile = 0;
    for (let t = 0; t < tiles.length; t++) if (fs.existsSync(path.join(tmp, t + '.bin'))) { jobs.push(t); if (tiles[t].n > maxTile) maxTile = tiles[t].n; }
    const data = { __refineTile: true, tmp, H, RS: P.RS, CS: P.CS, x0: P.x0, y0: P.y0, c16: P.c16, opt: liteOpt(opt),
      alignSol: P.alignSol, alignTraj: P.alignTraj, cbSol: P.cbSol, dynSets: P.dynSets,
      poses: P.alignTraj ? (opt.poses || null) : null, posesText: P.alignTraj && !opt.poses ? (opt.posesText || null) : null };
    const threads = pickThreads(opt, jobs.length, maxTile);
    const tTiles = Date.now(); let workerMs = 0;
    let wpos = P.wpos, out = 0, done = 0, nDyn = 0, nNoise = 0, nMoved = 0, nColor = 0, nNoC = 0, nNoCL = 0, nGrain = 0; const stageMs = {};
    const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const take = (r) => {
      const f = path.join(tmp, r.t + '.out');
      if (r.w) { const B = fs.readFileSync(f); if (B.length !== r.w) throw new Error('плитка ' + r.t + ': неполный результат'); fs.writeSync(ofd, B, 0, r.w, wpos); }
      try { fs.unlinkSync(f); } catch (_) {}
      workerMs += r.ms || 0;
      wpos += r.w; out += r.k; done += r.n0; nDyn += r.nDyn; nNoise += r.nNoise; nMoved += r.nMoved; nColor += r.nColor; nNoC += r.noColor || 0; nNoCL += r.noColorLeft || 0; nGrain += r.degrain || 0; if (r.stageMs) for (const k in r.stageMs) stageMs[k] = (stageMs[k] || 0) + r.stageMs[k];
      for (let a = 0; a < 3; a++) { if (r.bb[a] < bb[a]) bb[a] = r.bb[a]; if (r.bb[a + 3] > bb[a + 3]) bb[a + 3] = r.bb[a + 3]; }
            const frac = N ? done / N : 1;
      const elapsedTilesMs = Date.now() - tTiles;
      const el = elapsedTilesMs / 1000;
      const eta = frac > 0.02 && frac < 1 ? Math.max(1, Math.round(el / frac - el)) : 0;
      prog(0.10 + 0.90 * Math.min(1, frac), 'Обработка плиток… ' + Math.round(frac * 100) + '%' + (eta ? ' (~' + Math.max(1, Math.round(eta / 60)) + ' мин)' : ''),
        { stage: 'tiles', frac, done, total: N, elapsedTilesMs, etaMs: eta * 1000, prepMs: Date.now() - tPrep, threads });
    };
    if (threads <= 1) { const ctx = TW.makeCtx(data); for (const t of jobs) take(TW.runTile(ctx, tmp, t, tiles[t])); }
    else {
      await new Promise((resolve, reject) => {
        const res = new Map(); let next = 0, write = 0, failed = false;
        const fail = (e) => { if (failed) return; failed = true; reject(e instanceof Error ? e : new Error(String(e))); };
        const flush = () => {
          try { while (write < jobs.length && res.has(jobs[write])) { const r = res.get(jobs[write]); res.delete(jobs[write]); take(r); write++; } }
          catch (e) { fail(e); return; }
          if (write >= jobs.length && !failed) resolve();
        };
        const give = (w) => { if (failed) return; if (next < jobs.length) { const t = jobs[next++]; w.busy = true; w.postMessage({ type: 'tile', t, T: tiles[t] }); } else w.busy = false; };
        for (let i = 0; i < threads; i++) {
          const w = new Worker(opt._workerPath || WORKER, { workerData: data }); workers.push(w);
          w.on('message', (m) => {
            if (!m) return;
            if (m.type === 'ready') give(w);
            else if (m.type === 'done') { w.busy = false; res.set(m.t, m); give(w); flush(); }
            else if (m.type === 'error') fail(new Error('обработка плитки' + (m.t !== undefined ? ' ' + m.t : '') + ': ' + m.error));
          });
          w.on('error', (e) => fail(e));
          w.on('exit', (code) => { if (!failed && write < jobs.length && (code !== 0 || w.busy)) fail(new Error('поток обработки плиток завершился с кодом ' + code)); });
        }
      });
    }
    R.finishLas(ofd, H, out, bb, wpos); fs.closeSync(ofd); ofd = null;
    const tilesMs = Date.now() - tTiles;
    return { points: N, written: out, dynamic: nDyn, noise: nNoise, moved: nMoved, recolored: nColor, tiles: tiles.length, ms: Date.now() - t0, color16: P.c16, align: P.align, colorBalance: P.colorBalance, noColor: { found: nNoC, left: nNoCL }, degrain: nGrain, threads, threadsMax: (opt._memInfo && opt._memInfo.workers) || threads, tileMax: opt.tileMax, memInfo: opt._memInfo || null, colorSimplify: opt._colorSimplify || null, stageMs, prepareMs, tilesMs, workerMs, denseProfile: opt._denseProfile || null };
  } finally {
    for (const w of workers) { try { await w.terminate(); } catch (_) {} }
    if (ofd !== null) { try { fs.closeSync(ofd); } catch (_) {} }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}
module.exports = { refineParallel, pickThreads, fitTileMaxToMemory, denseCleanProfile, BYTES_PER_POINT };
