'use strict';
/**
 * Ревизия 54: замер качества облака — то, чем сравнивают нашу обработку с Lixel Studio:
 *   • точек на окно 0,5 × 0,5 м и плотность (точек/м²);
 *   • толщина слоя поверхности (СКО и 95 % отклонений от местной плоскости), мм;
 *   • пустые пиксели 1 см — просветы между точками на плоскости.
 *
 *   node tools/cloud-quality.js ours.las --box x0,y0,z0,x1,y1,z1 [--time t0,t1] [--tile 0.5] [--pixel 0.01] [--normal auto|x|y|z] [--json out.json]
 *   node tools/cloud-quality.js ours.las --ref lixel.las --box …            — рядом с эталоном и разницей
 *
 * Рамка — в мировых координатах LAS. Плоскость окна подбирается по всем точкам куска; окна (плитки) —
 * в её собственных осях, поэтому крен стены и наклонный фасад не портят цифры. Крайние плитки неполного
 * покрытия в зачёт не идут: иначе «пустые пиксели» показывали бы пустоту за краем облака.
 *
 * Возврат measure(): { ok, points, inBox, plane, tiles, summary }.
 */
const fs = require('node:fs');
const path = require('node:path');

const DEF = { tile: 0.5, pixel: 0.01, minPoints: 150, maxPoints: 60e6 };

/** Чтение точек LAS по рамке/времени. Возврат — { x, y, z, t, n, inBox }. */
function readPoints(file, opt) {
  const R = require('../scan-refine-core');
  const o = Object.assign({}, DEF, opt || {});
  const fd = fs.openSync(file, 'r');
  try {
    const H = R.readHeader(fd);
    const box = o.box, tm = o.time;
    if (!box) throw new Error('нужна рамка box: x0,y0,z0,x1,y1,z1');
    const [x0, y0, z0, x1, y1, z1] = box;
    let cap = 1 << 20, X = new Float64Array(cap), Y = new Float64Array(cap), Z = new Float64Array(cap), T = H.tOff !== undefined ? new Float64Array(cap) : null;
    let n = 0, inBox = 0;
    const grow = () => { cap *= 2; const g = (A) => { const B = new Float64Array(cap); B.set(A); return B; }; X = g(X); Y = g(Y); Z = g(Z); if (T) T = g(T); };
    const per = 1 << 18, buf = Buffer.allocUnsafe(per * H.rl);
    for (let i = 0; i < H.n; i += per) {
      const c = Math.min(per, H.n - i), bytes = c * H.rl; let got = 0;
      while (got < bytes) { const r = fs.readSync(fd, buf, got, bytes - got, H.off + i * H.rl + got); if (!r) throw new Error('файл LAS обрезан'); got += r; }
      for (let q = 0, p = 0; q < c; q++, p += H.rl) {
        const x = buf.readInt32LE(p) * H.sx + H.ox, y = buf.readInt32LE(p + 4) * H.sy + H.oy, z = buf.readInt32LE(p + 8) * H.sz + H.oz;
        if (x < x0 || x > x1 || y < y0 || y > y1 || z < z0 || z > z1) continue;
        inBox++;
        if (T && tm && (buf.readDoubleLE(p + H.tOff) < tm[0] || buf.readDoubleLE(p + H.tOff) > tm[1])) continue;
        if (n >= cap) grow();
        X[n] = x; Y[n] = y; Z[n] = z; if (T) T[n] = buf.readDoubleLE(p + H.tOff); n++;
        if (n >= o.maxPoints) break;
      }
      if (n >= o.maxPoints) break;
    }
    return { X: X.subarray(0, n), Y: Y.subarray(0, n), Z: Z.subarray(0, n), T: T ? T.subarray(0, n) : null, n, inBox, tOff: H.tOff };
  } finally { fs.closeSync(fd); }
}

/** Плоскость по точкам: centroid + наименьший собственный вектор (нормаль). */
function fitPlane(X, Y, Z, n) {
  const R = require('../scan-refine-core');
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < n; i++) { mx += X[i]; my += Y[i]; mz += Z[i]; }
  mx /= n; my /= n; mz /= n;
  let a = 0, b = 0, c = 0, d = 0, e = 0, f = 0;
  for (let i = 0; i < n; i++) {
    const x = X[i] - mx, y = Y[i] - my, z = Z[i] - mz;
    a += x * x; b += x * y; c += x * z; d += y * y; e += y * z; f += z * z;
  }
  const nr = new Float64Array(3);
  R.eig3(a / n, b / n, c / n, d / n, e / n, f / n, nr);
  const L = Math.hypot(nr[0], nr[1], nr[2]) || 1; nr[0] /= L; nr[1] /= L; nr[2] /= L;
  // оси в плоскости: u — проекция мировой оси с наименьшей связью с нормалью
  const ax = Math.abs(nr[0]) < Math.abs(nr[1]) && Math.abs(nr[0]) < Math.abs(nr[2]) ? [1, 0, 0] : (Math.abs(nr[1]) < Math.abs(nr[2]) ? [0, 1, 0] : [0, 0, 1]);
  let ux = ax[0] - (ax[0] * nr[0] + ax[1] * nr[1] + ax[2] * nr[2]) * nr[0], uy = ax[1] - (ax[0] * nr[0] + ax[1] * nr[1] + ax[2] * nr[2]) * nr[1], uz = ax[2] - (ax[0] * nr[0] + ax[1] * nr[1] + ax[2] * nr[2]) * nr[2];
  const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
  const vx = nr[1] * uz - nr[2] * uy, vy = nr[2] * ux - nr[0] * uz, vz = nr[0] * uy - nr[1] * ux;
  return { m: [mx, my, mz], n: [nr[0], nr[1], nr[2]], u: [ux, uy, uz], v: [vx, vy, vz] };
}

const quant = (arr, p) => { if (!arr.length) return NaN; const s = Array.from(arr).sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; };

/** measure(file, opt) → замер куска облака. */
function measure(file, opt) {
  const o = Object.assign({}, DEF, opt || {});
  const P = readPoints(file, o);
  if (!P.n) throw new Error('в рамке нет точек');
  const pl = o.normal && o.normal !== 'auto' ? (() => {   // заданная нормаль: x/y/z
    const n = [0, 0, 0]; n['xyz'.indexOf(o.normal)] = 1;
    const u = o.normal === 'x' ? [0, 0, 1] : (o.normal === 'y' ? [1, 0, 0] : [1, 0, 0]);
    const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    let mx = 0, my = 0, mz = 0; for (let i = 0; i < P.n; i++) { mx += P.X[i]; my += P.Y[i]; mz += P.Z[i]; }
    return { m: [mx / P.n, my / P.n, mz / P.n], n, u, v };
  })() : fitPlane(P.X, P.Y, P.Z, P.n);
  const [mx, my, mz] = pl.m, [nx, ny, nz] = pl.n, [ux, uy, uz] = pl.u, [vx, vy, vz] = pl.v;
  const n = P.n, U = new Float64Array(n), V = new Float64Array(n), D = new Float64Array(n);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = P.X[i] - mx, y = P.Y[i] - my, z = P.Z[i] - mz;
    const u = x * ux + y * uy + z * uz, v = x * vx + y * vy + z * vz;
    U[i] = u; V[i] = v; D[i] = x * nx + y * ny + z * nz;
    if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  const tw = o.tile, iu0 = Math.ceil(u0 / tw), iu1 = Math.floor(u1 / tw), iv0 = Math.ceil(v0 / tw), iv1 = Math.floor(v1 / tw);
  const grid = new Map();
  const key = (iu, iv) => (iu + 65536) * 131072 + (iv + 65536);
  for (let i = 0; i < n; i++) {
    const iu = Math.floor(U[i] / tw), iv = Math.floor(V[i] / tw);
    if (iu < iu0 || iu > iu1 || iv < iv0 || iv > iv1) continue;
    const k = key(iu, iv); let g = grid.get(k); if (!g) { g = []; grid.set(k, g); } g.push(i);
  }
  const tiles = [], side = Math.max(1, Math.round(tw / o.pixel));
  for (const [, idx] of grid) {
    if (idx.length < o.minPoints) continue;
    let sum = 0; const dd = new Float64Array(idx.length);
    for (let q = 0; q < idx.length; q++) { const i = idx[q]; sum += D[i]; dd[q] = D[i]; }
    const mean = sum / idx.length;
    let ss = 0; for (let q = 0; q < dd.length; q++) { const e = dd[q] - mean; ss += e * e; }
    const med = quant(dd, 0.5);
    const dev = new Float64Array(dd.length); for (let q = 0; q < dd.length; q++) dev[q] = Math.abs(dd[q] - med);
    // пустые пиксели 1 см в пределах плитки (ровно tw × tw)
    const iu = Math.floor(U[idx[0]] / tw), iv = Math.floor(V[idx[0]] / tw);
    const bu = iu * tw, bv = iv * tw, occ = new Uint8Array(side * side);
    for (let q = 0; q < idx.length; q++) {
      const i = idx[q], cu = Math.min(side - 1, Math.max(0, Math.floor((U[i] - bu) / o.pixel))), cv = Math.min(side - 1, Math.max(0, Math.floor((V[i] - bv) / o.pixel)));
      occ[cv * side + cu] = 1;
    }
    let filled = 0; for (let q = 0; q < occ.length; q++) if (occ[q]) filled++;
    tiles.push({ u: bu, v: bv, count: idx.length, density: idx.length / (tw * tw), rms: Math.sqrt(ss / idx.length), p95: quant(dev, 0.95), empty: 1 - filled / occ.length, spacingMm: Math.sqrt(tw * tw / idx.length) * 1000 });
  }
  if (!tiles.length) throw new Error('слишком мало точек для окна ' + tw + ' м (нужно от ' + o.minPoints + ' на плитку)');
  const med = (f) => quant(tiles.map(f), 0.5), avg = (f) => tiles.reduce((s, t) => s + f(t), 0) / tiles.length;
  const tot = tiles.reduce((s, t) => s + t.count, 0);
  const summary = {
    tiles: tiles.length, mode: o.normal || 'auto', points: tot, pointsInBox: P.n,
    perWindow: Math.round(med(t => t.count)), densityPerM2: Math.round(med(t => t.density)),
    rmsMm: +(med(t => t.rms) * 1000).toFixed(2), p95Mm: +(med(t => t.p95) * 1000).toFixed(2),
    emptyPct: +(avg(t => t.empty) * 100).toFixed(2), spacingMm: +med(t => t.spacingMm).toFixed(1),
    coverageM2: +(tiles.length * tw * tw).toFixed(2)
  };
  return { ok: true, file: path.basename(file), points: P.n, inBox: P.inBox, tile: tw, pixel: o.pixel, plane: pl, tiles, summary };
}

function fmt(r) {
  const s = r.summary;
  return [
    'Файл: ' + r.file,
    'Точек в рамке: ' + r.points.toLocaleString('ru-RU') + '; в окнах ' + r.tile + ' × ' + r.tile + ' м: ' + s.tiles + ' (' + s.coverageM2 + ' м²)',
    'Точек на окно ' + r.tile + ' × ' + r.tile + ' м: ' + s.perWindow.toLocaleString('ru-RU') + '   плотность: ' + s.densityPerM2.toLocaleString('ru-RU') + ' точек/м²   шаг: ' + s.spacingMm + ' мм',
    'Толщина слоя: ' + s.rmsMm + ' мм (СКО), ' + s.p95Mm + ' мм (95 %)',
    'Пустые пиксели ' + (r.pixel * 1000) + ' мм: ' + s.emptyPct + ' %'
  ].join('\n');
}

function main(argv) {
  const file = argv[0];
  if (!file) { console.error('нужно: node tools/cloud-quality.js файл.las --box x0,y0,z0,x1,y1,z1 [--ref другой.las] [--time t0,t1] [--tile 0.5] [--pixel 0.01] [--normal auto|x|y|z] [--json out.json]'); process.exit(2); }
  const arg = (k) => { const i = argv.findIndex(a => a === '--' + k || a.startsWith('--' + k + '=')); return i >= 0 ? (argv[i].includes('=') ? argv[i].slice(argv[i].indexOf('=') + 1) : argv[i + 1]) : null; };
  const box = (arg('box') || '').split(',').map(Number);
  if (box.length !== 6 || box.some(v => !Number.isFinite(v))) { console.error('нужна рамка --box x0,y0,z0,x1,y1,z1'); process.exit(2); }
  const time = arg('time') ? arg('time').split(',').map(Number) : null;
  const opt = { box, time, tile: arg('tile') ? Number(arg('tile')) : DEF.tile, pixel: arg('pixel') ? Number(arg('pixel')) : DEF.pixel, normal: arg('normal') || 'auto' };
  try {
    const a = measure(path.resolve(file), opt);
    const out = { ours: a.summary };
    let text = fmt(a);
    const ref = arg('ref');
    if (ref) {
      const b = measure(path.resolve(ref), opt); out.ref = b.summary; out.delta = {};
      for (const k of ['perWindow', 'densityPerM2', 'rmsMm', 'p95Mm', 'emptyPct']) out.delta[k] = +((a.summary[k] - b.summary[k])).toFixed(2);
      const line = (lbl, ka, kb) => lbl.padEnd(26) + String(ka).padStart(10) + String(kb).padStart(10) + String(((ka - kb) >= 0 ? '+' : '') + (Math.round((ka - kb) * 100) / 100)).padStart(10);
      text += '\n\nСравнение (слева — наш файл, справа — эталон):\n' +
        'показатель'.padEnd(26) + 'наш'.padStart(10) + 'эталон'.padStart(10) + 'разница'.padStart(10) + '\n' +
        line('точек на окно 0,5×0,5', a.summary.perWindow, b.summary.perWindow) + '\n' +
        line('точек/м²', a.summary.densityPerM2, b.summary.densityPerM2) + '\n' +
        line('толщина СКО, мм', a.summary.rmsMm, b.summary.rmsMm) + '\n' +
        line('толщина 95 %, мм', a.summary.p95Mm, b.summary.p95Mm) + '\n' +
        line('пустые пиксели, %', a.summary.emptyPct, b.summary.emptyPct);
    }
    const js = arg('json');
    if (js) fs.writeFileSync(path.resolve(js), JSON.stringify(out, null, 2), 'utf8');
    console.log(text);
    if (js) console.log('\nJSON: ' + path.resolve(js));
  } catch (e) { console.error(String((e && e.message) || e)); process.exit(1); }
}

module.exports = { measure, readPoints, fitPlane, DEF };
if (require.main === module) main(process.argv.slice(2));
