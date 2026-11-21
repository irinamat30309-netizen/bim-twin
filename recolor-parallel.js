'use strict';
/**
 * recolor-parallel.js — r179: параллельная раскраска облака из .xbin по тайлам времени.
 *
 * Идея: облако после сборки из .xbin упорядочено по времени точек (проверяется), поэтому его можно
 * разрезать на N непрерывных диапазонов строк. Каждый воркер (отдельное окно/процесс) красит свой
 * диапазон своим набором кадров (recolor-core сам отфильтрует кадры, в окне которых нет его точек),
 * после чего куски склеиваются в исходном порядке строк. Кадры между тайлами не дублируются, поэтому
 * время падает почти линейно по числу воркеров (на 8+ потоках — в 4–8 раз).
 *
 * Модуль не зависит от Electron: runOne(cfg, onProgress) передаётся снаружи (CLI/приложение).
 */
const fs = require('node:fs');
const path = require('node:path');

const HDR = 375;

function readHead(fd) {
  const h = Buffer.alloc(HDR);
  let got = 0;
  while (got < HDR) { const n = fs.readSync(fd, h, got, HDR - got, got); if (!n) break; got += n; }
  if (h.toString('latin1', 0, 4) !== 'LASF') throw new Error('не LAS: источник');
  const minor = h[25], off = h.readUInt32LE(96), fmt = h[104] & 0x3f, rl = h.readUInt16LE(105);
  let n = h.readUInt32LE(107);
  if (minor >= 4) { const n2 = Number(h.readBigUInt64LE(247)); if (n2 > 0) n = n2; }
  const sx = h.readDoubleLE(131), sy = h.readDoubleLE(139), sz = h.readDoubleLE(147);
  const ox = h.readDoubleLE(155), oy = h.readDoubleLE(163), oz = h.readDoubleLE(171);
  const hasT = [1, 3, 4, 5, 6, 7, 8, 9, 10].includes(fmt);
  const tOff = fmt === 6 || fmt >= 7 ? 22 : 20;
  return { minor, off, fmt, rl, n, sx, sy, sz, ox, oy, oz, hasT, tOff };
}

// Разрез LAS на N непрерывных диапазонов строк, сбалансированных по числу точек.
// Возвращает { tiles:[{path, rows, count, t0, t1}], dir }.
function splitByTime(src, dir, workers, log) {
  const fd = fs.openSync(src, 'r');
  try {
    const H = readHead(fd);
    if (!H.hasT) throw new Error('в LAS нет времени точек — параллельный цвет невозможен');
    const W = Math.max(2, Math.min(32, workers | 0));
    const bounds = [];
    // границы: по номерам строк (облако из xbin-lidar упорядочено по времени; проверим монотонность)
    const CH = 1 << 20;
    let monotone = true, prevT = -Infinity;
    const tSample = [];
    for (let i = 0; i < H.n && tSample.length < 5000; i += Math.max(1, Math.floor(H.n / 5000))) {
      const b = Buffer.alloc(H.rl);
      fs.readSync(fd, b, 0, H.rl, H.off + i * H.rl);
      const t = b.readDoubleLE(H.tOff);
      if (t < prevT) monotone = false;
      prevT = t; tSample.push(t);
    }
    // время первой/последней точки каждого диапазона
    const T0 = tSample[0], T1 = tSample[tSample.length - 1];
    const cut = [];
    for (let k = 0; k <= W; k++) cut.push(Math.floor(H.n * k / W));
    const tiles = [];
    for (let k = 0; k < W; k++) {
      const a = cut[k], b = cut[k + 1];
      if (!(b > a)) continue;
      // t0/t1 диапазона — по времени на границах (для лога)
      const tb0 = Buffer.alloc(H.rl), tb1 = Buffer.alloc(H.rl);
      fs.readSync(fd, tb0, 0, H.rl, H.off + a * H.rl);
      fs.readSync(fd, tb1, 0, H.rl, H.off + (b - 1) * H.rl);
      tiles.push({ idx: k, rows: a, count: b - a, t0: tb0.readDoubleLE(H.tOff), t1: tb1.readDoubleLE(H.tOff), path: path.join(dir, 'tile-' + String(k).padStart(2, '0') + '.las'), out: path.join(dir, 'tile-' + String(k).padStart(2, '0') + '-color.las') });
    }
    // пишем тайлы LAS (копия заголовка, затем записи диапазона)
    for (const T of tiles) {
      const fo = fs.openSync(T.path, 'w');
      try {
        const head = Buffer.alloc(H.off);
        let got = 0;
        while (got < H.off) { const n = fs.readSync(fd, head, got, H.off - got, got); if (!n) break; got += n; }
        fs.writeSync(fo, head, 0, H.off);
        const CH2 = 4096;
        let left = T.count, pos = H.off + T.rows * H.rl, w = H.off;
        while (left > 0) {
          const c = Math.min(CH2, left), buf = Buffer.allocUnsafe(c * H.rl);
          let got2 = 0;
          while (got2 < c * H.rl) { const n = fs.readSync(fd, buf, got2, c * H.rl - got2, pos + got2); if (!n) break; got2 += n; }
          fs.writeSync(fo, buf, 0, c * H.rl, w);
          w += c * H.rl; pos += c * H.rl; left -= c;
        }
        // поправить число точек в заголовке (заголовок уже в памяти: head)
        const h2 = Buffer.from(head);
        h2.writeUInt32LE(T.count, 107);
        if (H.minor >= 4) h2.writeBigUInt64LE(BigInt(T.count), 247);
        fs.writeSync(fo, h2, 0, H.off, 0);
      } finally { fs.closeSync(fo); }
    }
    log && log('parallel: ' + H.n + ' точек → ' + tiles.length + ' тайлов (монотонно по времени: ' + monotone + ')');
    return { tiles, src, H, dir };
  } finally { fs.closeSync(fd); }
}

// Склейка цветных тайлов в итоговый LAS (порядок строк восстанавливается: тайлы — непрерывные диапазоны).
function mergeTiles(split, dst) {
  const H = split.H, tiles = split.tiles;
  const counts = tiles.map(t => {
    const fd = fs.openSync(t.out, 'r'); try { return readHead(fd).n; } finally { fs.closeSync(fd); }
  });
  const total = counts.reduce((a, b) => a + b, 0);
  const ofd = fs.openSync(dst, 'w');
  try {
    const head = Buffer.alloc(H.off);
    const srcFd = fs.openSync(split.src, 'r');
    try { let got = 0; while (got < H.off) { const n = fs.readSync(srcFd, head, got, H.off - got, got); if (!n) break; got += n; } } finally { fs.closeSync(srcFd); }
    head.writeUInt32LE(total, 107);
    if (H.minor >= 4) head.writeBigUInt64LE(BigInt(total), 247);
    fs.writeSync(ofd, head, 0, H.off, 0);
    let w = H.off;
    const BUF = 1 << 20;
    for (let k = 0; k < tiles.length; k++) {
      const fd = fs.openSync(tiles[k].out, 'r');
      try {
        const rl = H.rl, left = counts[k];
        let readPos = H.off, wrote = 0;
        while (wrote < left) {
          const c = Math.min(BUF / rl | 0, left - wrote);
          const buf = Buffer.allocUnsafe(c * rl);
          let got = 0;
          while (got < c * rl) { const n = fs.readSync(fd, buf, got, c * rl - got, readPos + got); if (!n) break; got += n; }
          fs.writeSync(ofd, buf, 0, c * rl, w);
          w += c * rl; readPos += c * rl; wrote += c;
        }
      } finally { fs.closeSync(fd); }
    }
  } finally { fs.closeSync(ofd); }
  return { total };
}

function cleanup(split) {
  for (const t of split.tiles) { try { fs.rmSync(t.path, { force: true }); } catch (_) {} try { fs.rmSync(t.out, { force: true }); } catch (_) {} }
}

/**
 * parallelRecolor({src,dst,xbin,posesText,tmpDir,opt,workers,runOne,onProgress,job,log})
 *   runOne(cfg, onProgress) → Promise<{ok, stats}> — раскраска одного тайла (окно Electron / процесс).
 */
async function parallelRecolor(cfg) {
  const { src, dst, xbin, posesText, tmpDir, opt, workers, runOne, onProgress, job, log } = cfg;
  const w = Math.max(1, Math.min(32, workers | 0));
  const t0 = Date.now();
  const dir = fs.mkdtempSync(path.join(tmpDir || path.dirname(dst), '.recolor-par-'));
  let split = null;
  try {
    split = splitByTime(src, dir, w, log);
    const totalPts = split.H.n;
    const progress = new Float64Array(split.tiles.length);
    const report = () => {
      if (!onProgress) return;
      let s = 0;
      for (const t of split.tiles) { const i = split.tiles.indexOf(t); s += progress[i] * (t.count / totalPts); }
      onProgress(Math.max(0, Math.min(1, s)), 'Цвет по фото: ' + w + ' воркеров…');
    };
    // Запускаем тайлы волной: не больше workers одновременно (для CPU-конкуренции хватает workers,
    // но на 6-ядерной машине 4 окна × декодеры — уже предел; сами воркеры и есть workers).
    const results = new Array(split.tiles.length).fill(null);
    let next = 0;
    const launch = async () => {
      while (next < split.tiles.length) {
        if (job && job.cancelled) throw new Error('cancelled');
        const i = next++;
        const T = split.tiles[i];
        const p = await runOne({ src: T.path, dst: T.out, xbin, posesText, tmpDir: dir, opt }, (f) => { progress[i] = f; report(); })
          .then(r => { progress[i] = 1; report(); results[i] = r; return r; })
          .catch(e => { results[i] = { ok: false, error: String((e && e.message) || e) }; });
        // Не await каждого: волна запускается ниже
        if (p && p.then) { /* no-op */ }
        if (next <= split.tiles.length) { /* continue */ }
      }
    };
    // простой пул: держим до w одновременно
    const queue = split.tiles.map((T, i) => ({ T, i }));
    let active = 0, done = 0;
    await new Promise((resolve, reject) => {
      const pump = () => {
        if (job && job.cancelled) { reject(new Error('cancelled')); return; }
        while (active < w && queue.length) {
          const { T, i } = queue.shift(); active++;
          runOne({ src: T.path, dst: T.out, xbin, posesText, tmpDir: dir, opt }, (f) => { progress[i] = f; report(); })
            .then(r => { results[i] = r; })
            .catch(e => { results[i] = { ok: false, error: String((e && e.message) || e) }; })
            .finally(() => {
              progress[i] = 1; report(); active--; done++;
              if (done === split.tiles.length) resolve(); else pump();
            });
        }
      };
      pump();
    });
    const bad = results.filter(r => !r || !r.ok);
    if (bad.length) throw new Error('часть тайлов не раскрашена: ' + JSON.stringify(bad.slice(0, 2).map(b => b && (b.error || b.message))));
    const merge = mergeTiles(split, dst);
    const sum = { points: totalPts, colored: 0, filled: 0, views: 0, frames: 0, workers: w, tiles: split.tiles.map((T, i) => ({ rows: T.rows, count: T.count, t0: T.t0, t1: T.t1, ms: results[i].stats && results[i].stats.ms, colored: results[i].stats && results[i].stats.colored })) };
    let worst = 0;
    for (const r of results) { sum.colored += (r.stats && r.stats.colored) || 0; sum.filled += (r.stats && r.stats.filled) || 0; sum.views += (r.stats && r.stats.views) || 0; sum.frames += (r.stats && r.stats.frames) || 0; worst = Math.max(worst, (r.stats && r.stats.ms) || 0); }
    sum.timing = { parallelMs: Date.now() - t0, worstTileMs: worst };
    sum.merged = merge.total;
    return { ok: true, stats: sum };
  } finally {
    if (split) cleanup(split);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { splitByTime, mergeTiles, parallelRecolor, cleanup, readHead };
