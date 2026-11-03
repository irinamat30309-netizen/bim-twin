// Независимая проверка найденных труб: окружность по тонким срезам облака другим алгоритмом.
// Автозамер (renderer/auto-measure.js) подгоняет цилиндр по нормалям и 3D-точкам; здесь, не глядя на его радиус,
// режем облако поперёк найденной оси тонкими слоями и в каждом слое ищем окружность RANSAC-ом по 2D-точкам
// (три точки → окружность, порог 3 мм, затем геометрическая доработка). Сравниваем радиус, центр и разброс по слоям.
//   LAB_SEL_DIR=/путь/sel node dev/ui-lab/pipe-check.js [имя1,имя2]
const fs = require('fs');
const path = require('path');
const AM = require('../../renderer/auto-measure.js');
const DIR = process.env.LAB_SEL_DIR || '/tmp/sel';
const NAMES = process.argv[2] ? process.argv[2].split(',') : ['pipes-narrow', 'tray-a'];
const KIND = { door: 'дверь', wallR: 'проём', pipes: 'труба', tray: 'лоток', partition: 'стена' };

function basis(a) {
  const t = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = [a[1] * t[2] - a[2] * t[1], a[2] * t[0] - a[0] * t[2], a[0] * t[1] - a[1] * t[0]];
  const l = Math.hypot(u[0], u[1], u[2]); u = u.map((x) => x / l);
  const v = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]];
  return { u, v };
}
function circle3(p, q, r) {
  const ax = p[0], ay = p[1], bx = q[0], by = q[1], cx = r[0], cy = r[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  return { x: ux, y: uy, r: Math.hypot(ax - ux, ay - uy) };
}
function refine(pts, c) {
  let x = c.x, y = c.y, r = c.r;
  for (let it = 0; it < 12; it++) {
    let a11 = 0, a12 = 0, a13 = 0, a22 = 0, a23 = 0, a33 = 0, b1 = 0, b2 = 0, b3 = 0;
    for (const p of pts) {
      const dx = p[0] - x, dy = p[1] - y, d = Math.hypot(dx, dy) || 1e-9, res = d - r;
      const j = [-dx / d, -dy / d, -1];
      a11 += j[0] * j[0]; a12 += j[0] * j[1]; a13 += j[0] * j[2]; a22 += j[1] * j[1]; a23 += j[1] * j[2]; a33 += j[2] * j[2];
      b1 += j[0] * res; b2 += j[1] * res; b3 += j[2] * res;
    }
    const det = a11 * (a22 * a33 - a23 * a23) - a12 * (a12 * a33 - a23 * a13) + a13 * (a12 * a23 - a22 * a13);
    if (Math.abs(det) < 1e-18) break;
    const inv = (m) => m;
    const dxs = [
      ((a22 * a33 - a23 * a23) * b1 + (a13 * a23 - a12 * a33) * b2 + (a12 * a23 - a13 * a22) * b3) / det,
      ((a13 * a23 - a12 * a33) * b1 + (a11 * a33 - a13 * a13) * b2 + (a12 * a13 - a11 * a23) * b3) / det,
      ((a12 * a23 - a13 * a22) * b1 + (a12 * a13 - a11 * a23) * b2 + (a11 * a22 - a12 * a12) * b3) / det
    ];
    x -= dxs[0]; y -= dxs[1]; r -= dxs[2];
  }
  return { x, y, r };
}
let seed = 12345; function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
function ransacCircle(pts, rMin, rMax, thr) {
  let best = null;
  const n = pts.length; if (n < 12) return null;
  for (let it = 0; it < 1500; it++) {
    const i = Math.floor(rnd() * n), j = Math.floor(rnd() * n), k = Math.floor(rnd() * n);
    if (i === j || j === k || i === k) continue;
    const c = circle3(pts[i], pts[j], pts[k]); if (!c || c.r < rMin || c.r > rMax) continue;
    let cnt = 0;
    for (let m = 0; m < n; m++) if (Math.abs(Math.hypot(pts[m][0] - c.x, pts[m][1] - c.y) - c.r) < thr) cnt++;
    if (!best || cnt > best.cnt) best = { c, cnt };
  }
  if (!best) return null;
  let inl = pts.filter((p) => Math.abs(Math.hypot(p[0] - best.c.x, p[1] - best.c.y) - best.c.r) < thr * 1.5);
  let c = refine(inl, best.c);
  inl = pts.filter((p) => Math.abs(Math.hypot(p[0] - c.x, p[1] - c.y) - c.r) < thr);
  c = refine(inl, c);
  let arcs = new Set(); inl.forEach((p) => arcs.add(Math.floor((Math.atan2(p[1] - c.y, p[0] - c.x) + Math.PI) / (Math.PI / 18))));
  return { x: c.x, y: c.y, r: c.r, n: inl.length, arc: arcs.size * 10 };
}
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const mad = (a) => { const m = med(a); return med(a.map((x) => Math.abs(x - m))) * 1.4826; };

// Ещё одна независимая оценка: по всем точкам вдоль трубы — распределение расстояний до оси (ось берём у автозамера),
// радиус = положение пика «слоя поверхности» (окно ±3 мм), без подгонки цилиндра.
function radialMode(all, cy) {
  const bins = new Float64Array(400), lo = cy.r * 0.5, hi = cy.r * 1.6, bw = 0.0005;
  let nb = 0;
  for (const q of all) { if (q[2] < cy.t0 || q[2] > cy.t1) continue; const d = Math.hypot(q[0], q[1]); if (d < lo || d > hi) continue; const k = Math.floor((d - lo) / bw); if (k >= 0 && k < 400) { bins[k]++; nb++; } }
  let best = -1, bi = -1; const w = 6;
  for (let k = w; k < 400 - w; k++) { let sm = 0; for (let m = -w; m <= w; m++) sm += bins[k + m]; if (sm > best) { best = sm; bi = k; } }
  return bi < 0 ? NaN : lo + (bi + 0.5) * bw;
}
const found = {};
let tot = 0, ok = 0, totm = 0, okm = 0;
NAMES.forEach((nm) => {
  const f = path.join(DIR, nm + '.f32'); if (!fs.existsSync(f)) return;
  const buf = fs.readFileSync(f), pos = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const res = AM.analyze(pos, { kind: KIND[nm.split('-')[0].replace(/\d+$/, '')] || '' });
  console.log('==', nm, 'точек', pos.length / 3);
  (res.objects || []).filter((o) => o.cylinder).forEach((o) => {
    const cy = o.cylinder, a = cy.a, c = cy.c, B = basis(a);
    const pr = (p) => { const dx = p[0] - c[0], dy = p[1] - c[1], dz = p[2] - c[2]; return [dx * B.u[0] + dy * B.u[1] + dz * B.u[2], dx * B.v[0] + dy * B.v[1] + dz * B.v[2], dx * a[0] + dy * a[1] + dz * a[2]]; };
    const slabs = [];
    const n = pos.length / 3, all = new Array(n);
    for (let i = 0; i < n; i++) all[i] = pr([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
    for (let t = cy.t0 + 0.05; t <= cy.t1 - 0.05; t += 0.1) {
      const pts = all.filter((q) => Math.abs(q[2] - t) < 0.03 && Math.hypot(q[0], q[1]) < cy.r + 0.12).map((q) => [q[0], q[1]]);
      const rc = ransacCircle(pts, 0.015, cy.r * 2.2, 0.003);
      if (rc && rc.arc >= 70 && rc.n >= 25 && Math.hypot(rc.x, rc.y) < 0.03) slabs.push(rc);
    }
    if (slabs.length < 2) { console.log('  Ø' + (cy.r * 2000).toFixed(0), o.dims[0].level, ': срезов с окружностью мало (' + slabs.length + ')'); return; }
    const rs = slabs.map((s) => s.r), r2 = med(rs) * 2, sc = mad(rs) * 2;
    const rm = radialMode(all, cy) * 2, dm = (rm - cy.r * 2) * 1000; totm++;
    const goodM = Math.abs(dm) <= Math.max(3, 2 * o.dims[0].sigma * 1000); if (goodM) okm++;
    (found[nm] = found[nm] || []).push({ c, a, d: cy.r * 2, ds: r2, dm: rm, lvl: o.dims[0].level });
    const dd = (r2 - cy.r * 2) * 1000; tot++;
    const good = Math.abs(dd) <= Math.max(3, 2 * o.dims[0].sigma * 1000);
    if (good) ok++;
    console.log('  Ø' + (cy.r * 2000).toFixed(1).padEnd(6) + ' авто (' + o.dims[0].level + ', ±' + (o.dims[0].sigma * 1000).toFixed(1) + ' мм) | срезы: Ø ' + (r2 * 1000).toFixed(1) + ' мм, разброс по срезам ' + (sc * 1000).toFixed(1) + ' мм, срезов ' + slabs.length + ' | разница ' + (dd >= 0 ? '+' : '') + dd.toFixed(1) + ' мм ' + (good ? 'OK' : 'ПРОВЕРИТЬ') + ' | пик радиусов: Ø ' + (rm * 1000).toFixed(1) + ' (' + (dm >= 0 ? '+' : '') + dm.toFixed(1) + ' мм ' + (goodM ? 'OK' : 'ПРОВЕРИТЬ') + ')');
  });
});
console.log('\nТруб проверено срезами:', tot, '· в пределах max(2σ; 3 мм): по окружностям срезов', ok, ', по пику радиусов', okm, 'из', totm);
// Повторяемость между рамками: одна и та же труба (совпали ось и положение) в разных выделениях.
const names = Object.keys(found);
for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
  const diffs = [];
  found[names[i]].forEach((p) => found[names[j]].forEach((q) => {
    const dot = Math.abs(p.a[0] * q.a[0] + p.a[1] * q.a[1] + p.a[2] * q.a[2]);
    const dc = [q.c[0] - p.c[0], q.c[1] - p.c[1], q.c[2] - p.c[2]], t = dc[0] * p.a[0] + dc[1] * p.a[1] + dc[2] * p.a[2];
    const off = Math.hypot(dc[0] - t * p.a[0], dc[1] - t * p.a[1], dc[2] - t * p.a[2]);
    if (dot > 0.995 && off < 0.04) diffs.push({ d1: p.d, d2: q.d, off });
  }));
  if (diffs.length) {
    const e = diffs.map((x) => (x.d2 - x.d1) * 1000), rms = Math.sqrt(e.reduce((s, x) => s + x * x, 0) / e.length);
    console.log('Повторяемость', names[i], '↔', names[j] + ':', diffs.length, 'общих труб, разница Ø (мм):', e.map((x) => x.toFixed(1)).join(', '), '· СКО ' + rms.toFixed(1) + ' мм');
  }
}
