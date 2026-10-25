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
  const free = (typeof opt._freeMem === 'number' ? opt._freeMem : os.freemem()) - (768 << 20);
  const byMem = Math.floor(free / (BYTES_PER_POINT * Math.max(1, maxTile * 1.25)));
  return Math.max(1, Math.min(Math.max(2, cpu - 1), cpu, byMem, 16, nTiles));   // одно ядро — интерфейсу, если ядер больше двух
}
function liteOpt(opt) {
  const o = {}; for (const k of ['noise', 'noiseLevel', 'thin', 'thinIters', 'thinCell', 'planar', 'color', 'colorClamp']) if (opt[k] !== undefined) o[k] = opt[k];
  return o;
}
async function refineParallel(src, dst, opt, onProgress) {
  opt = Object.assign({ noise: true, thin: true, color: true, tileMax: 4000000, halo: 0.2, thinCell: 0.04, planar: 0.06 }, opt || {});
  const prog = typeof onProgress === 'function' ? onProgress : () => {};
  const P = R.refine(src, dst, Object.assign({}, opt, { _prepareOnly: true }), prog);
  const { H, tiles, tmp, N, t0 } = P; let ofd = P.ofd; const workers = [];
  try {
    const jobs = []; let maxTile = 0;
    for (let t = 0; t < tiles.length; t++) if (fs.existsSync(path.join(tmp, t + '.bin'))) { jobs.push(t); if (tiles[t].n > maxTile) maxTile = tiles[t].n; }
    const data = { __refineTile: true, tmp, H, RS: P.RS, CS: P.CS, x0: P.x0, y0: P.y0, c16: P.c16, opt: liteOpt(opt),
      alignSol: P.alignSol, alignTraj: P.alignTraj, cbSol: P.cbSol, dynSets: P.dynSets,
      poses: P.alignTraj ? (opt.poses || null) : null, posesText: P.alignTraj && !opt.poses ? (opt.posesText || null) : null };
    const threads = pickThreads(opt, jobs.length, maxTile);
    let wpos = P.wpos, out = 0, done = 0, nDyn = 0, nNoise = 0, nMoved = 0, nColor = 0;
    const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const take = (r) => {
      const f = path.join(tmp, r.t + '.out');
      if (r.w) { const B = fs.readFileSync(f); if (B.length !== r.w) throw new Error('плитка ' + r.t + ': неполный результат'); fs.writeSync(ofd, B, 0, r.w, wpos); }
      try { fs.unlinkSync(f); } catch (_) {}
      wpos += r.w; out += r.k; done += r.n0; nDyn += r.nDyn; nNoise += r.nNoise; nMoved += r.nMoved; nColor += r.nColor;
      for (let a = 0; a < 3; a++) { if (r.bb[a] < bb[a]) bb[a] = r.bb[a]; if (r.bb[a + 3] > bb[a + 3]) bb[a + 3] = r.bb[a + 3]; }
      prog(0.45 + 0.55 * done / N, 'Обработка плиток…');
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
    return { points: N, written: out, dynamic: nDyn, noise: nNoise, moved: nMoved, recolored: nColor, tiles: tiles.length, ms: Date.now() - t0, color16: P.c16, align: P.align, colorBalance: P.colorBalance, threads };
  } finally {
    for (const w of workers) { try { await w.terminate(); } catch (_) {} }
    if (ofd !== null) { try { fs.closeSync(ofd); } catch (_) {} }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}
module.exports = { refineParallel, pickThreads, BYTES_PER_POINT };
