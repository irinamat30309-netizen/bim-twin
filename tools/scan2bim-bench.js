'use strict';
// Стенд точности scan-to-BIM: эталонные сцены с известной геометрией → ошибки восстановления.
//   node bench-scan2bim.js [--json]
const path = require('node:path');
const S = require(path.join(__dirname, '..', 'renderer', 'scan2bim.js'));

// ---------- генератор облака по эталонным стенам ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// стена: {a:[x,z], b:[x,z], t, h, openings:[{s0,s1,z0,z1}]} — проёмы в локальной координате вдоль стены
function sampleWall(pts, w, opt, rand) {
  const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
  const dx = (w.b[0] - w.a[0]) / len, dz = (w.b[1] - w.a[1]) / len, nx = -dz, nz = dx;
  const step = opt.step || 0.04, noise = opt.noise || 0.006, skip = opt.skip || 0;
  for (const side of [-1, 1]) {
    for (let s = 0; s <= len; s += step) {
      for (let z = opt.floorY + 0.02; z <= opt.floorY + w.h - 0.02; z += step) {
        // проём: не рисуем точки в его пределах (ни с одной стороны)
        let inside = false;
        for (const o of (w.openings || [])) if (s >= o.s0 && s <= o.s1 && z >= opt.floorY + o.z0 && z <= opt.floorY + o.z1) { inside = true; break; }
        if (inside) continue;
        if (rand() < skip) continue;
        const off = side * w.t / 2 + (rand() - 0.5) * noise * 2;
        pts.push([w.a[0] + dx * s + nx * off + (rand() - 0.5) * noise, z + (rand() - 0.5) * noise, w.a[1] + dz * s + nz * off + (rand() - 0.5) * noise]);
      }
    }
  }
}

function sampleSlab(pts, x0, z0, x1, z1, y, opt, rand) {
  const step = opt.step || 0.05, noise = opt.noise || 0.006;
  for (let x = x0; x <= x1; x += step) for (let z = z0; z <= z1; z += step) {
    pts.push([x + (rand() - 0.5) * noise, y + (rand() - 0.5) * noise, z + (rand() - 0.5) * noise]);
  }
}

// ---------- сцены ----------
function sceneFlat() {
  // квартира 10×8, толщина внешних 0.3 (одна стена двухслойная), внутренняя 0.12 с дверью 0.9×2.1,
  // два окна 1.4×1.4 (подоконник 0.9) в наружной стене, колонна 0.4×0.4
  const H = 2.8, T = 0.3, Ti = 0.12;
  const walls = [
    { a: [0, 0], b: [10, 0], t: T, h: H, openings: [{ s0: 2.0, s1: 3.4, z0: 0.9, z1: 2.3 }, { s0: 6.0, s1: 7.4, z0: 0.9, z1: 2.3 }] },
    { a: [10, 0], b: [10, 8], t: T, h: H, openings: [] },
    { a: [10, 8], b: [0, 8], t: T, h: H, openings: [] },
    { a: [0, 8], b: [0, 0], t: T, h: H, openings: [] },
    { a: [4.5, 0.15], b: [4.5, 8 - 0.15], t: Ti, h: H, openings: [{ s0: 3.0, s1: 3.9, z0: 0, z1: 2.1 }] }
  ];
  return { name: 'квартира 10×8: 4 наружные + перегородка, 2 окна, дверь', walls, H, area: (10 + 0.3) * (8 + 0.3), column: { x: 7.5, z: 4.0, size: 0.4 } };
}

function sceneLShape() {
  // Г-образное помещение 9×7 с вырезом 3×3, стены 0.25, окно 1.2×1.5, дверь 0.9×2.1
  const H = 3.0, T = 0.25;
  const walls = [
    { a: [0, 0], b: [9, 0], t: T, h: H, openings: [{ s0: 5.0, s1: 6.5, z0: 1.0, z1: 2.5 }] },
    { a: [9, 0], b: [9, 7], t: T, h: H, openings: [] },
    { a: [9, 7], b: [3, 7], t: T, h: H, openings: [] },
    { a: [3, 7], b: [3, 4], t: T, h: H, openings: [{ s0: 1.0, s1: 1.9, z0: 0, z1: 2.1 }] },
    { a: [3, 4], b: [0, 4], t: T, h: H, openings: [] },
    { a: [0, 4], b: [0, 0], t: T, h: H, openings: [] }
  ];
  return { name: 'Г-образное 9×7 (вырез 3×3), окно, дверь', walls, H, area: null };
}

function sceneRooms() {
  // три помещения в ряд 12×6: перегородки 0.1 с дверями
  const H = 2.7, T = 0.28, Ti = 0.1;
  const walls = [
    { a: [0, 0], b: [12, 0], t: T, h: H, openings: [{ s0: 1.5, s1: 2.9, z0: 0.9, z1: 2.2 }, { s0: 5.0, s1: 6.4, z0: 0.9, z1: 2.2 }, { s0: 8.5, s1: 9.9, z0: 0.9, z1: 2.2 }] },
    { a: [12, 0], b: [12, 6], t: T, h: H, openings: [] },
    { a: [12, 6], b: [0, 6], t: T, h: H, openings: [] },
    { a: [0, 6], b: [0, 0], t: T, h: H, openings: [] },
    { a: [4, 0.14], b: [4, 6 - 0.14], t: Ti, h: H, openings: [{ s0: 2.5, s1: 3.4, z0: 0, z1: 2.0 }] },
    { a: [8, 0.14], b: [8, 6 - 0.14], t: Ti, h: H, openings: [{ s0: 2.5, s1: 3.4, z0: 0, z1: 2.0 }] }
  ];
  return { name: 'три комнаты 12×6, две перегородки, 3 окна + 2 двери', walls, H, area: (12 + 0.28) * (6 + 0.28) };
}

function buildCloud(sc, opt) {
  const rand = rng(opt.seed || 1);
  const pts = [];
  for (const w of sc.walls) sampleWall(pts, w, { floorY: 0, step: opt.step, noise: opt.noise, skip: opt.skip }, rand);
  sampleSlab(pts, 0, 0, 10, 8, 0, { step: 0.08, noise: opt.noise }, rand);
  sampleSlab(pts, 0, 0, 10, 8, sc.H, { step: 0.08, noise: opt.noise }, rand);
  if (sc.column) {
    const c = sc.column;
    for (let y = 0.05; y < sc.H - 0.05; y += 0.04) {
      for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) pts.push([c.x + dx * c.size / 2, y, c.z + dz * c.size / 2]);
    }
  }
  return pts;
}

// ---------- метрики ----------
function segDist(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz;
  let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
}
function wallMid(w) { return [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2]; }

// сравнение найденных проёмов с эталонными: смещение вдоль стены, ширина, подоконник, перемычка
function openingErrors(g, w) {
  const gt = (g.openings || []);
  const det = (w.openings || []).slice().sort((a, b) => a.along - b.along);
  if (!gt.length && !det.length) return null;
  const gd = (() => { const L = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]); return [(g.b[0] - g.a[0]) / L, (g.b[1] - g.a[1]) / L]; })();
  const wd = (() => { const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]); return [(w.b[0] - w.a[0]) / L, (w.b[1] - w.a[1]) / L]; })();
  const res = { gt: gt.length, det: det.length, items: [] };
  for (const o of gt) {
    const cw = [g.a[0] + gd[0] * (o.s0 + o.s1) / 2, g.a[1] + gd[1] * (o.s0 + o.s1) / 2];
    const along = (cw[0] - w.a[0]) * wd[0] + (cw[1] - w.a[1]) * wd[1];       // центр проёма в системе найденной стены
    let best = null, bd = Infinity;
    for (const d of det) { const dc = d.along + d.width / 2; if (Math.abs(dc - along) < bd) { bd = Math.abs(dc - along); best = d; } }
    if (!best || bd > 1.2) { res.items.push({ missing: o.s0 + '–' + o.s1 }); continue; }
    res.items.push({
      dMid: +bd.toFixed(3),
      dW: +(best.width - (o.s1 - o.s0)).toFixed(3),
      dSill: +(((best.sill != null ? best.sill : 0) - o.z0)).toFixed(3),
      dHead: +(((best.head != null ? best.head : 0) - o.z1)).toFixed(3)
    });
  }
  const nums = (k) => res.items.filter(x => x[k] != null).map(x => Math.abs(x[k]));
  const maxOf = (arr) => (arr.length ? Math.max(...arr) : null);
  res.midMax = maxOf(nums('dMid')); res.wMax = maxOf(nums('dW'));
  res.sillMax = maxOf(nums('dSill')); res.headMax = maxOf(nums('dHead'));
  return res;
}

function evaluate(sc, model) {
  const out = { scene: sc.name, walls: model.walls.length, expectedWalls: sc.walls.length, errors: [] };
  const used = new Set();
  for (const g of sc.walls) {
    const gm = [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2];
    let best = null, bd = Infinity;
    model.walls.forEach((w, i) => {
      if (used.has(i)) return;
      const d = segDist(gm, w.a, w.b);
      if (d < bd) { bd = d; best = i; }
    });
    if (best == null) { out.errors.push({ gt: g.a + '→' + g.b, missing: true }); continue; }
    used.add(best);
    const w = model.walls[best];
    // положение оси: расстояние между серединами + угол
    const wm = wallMid(w);
    const posErr = Math.hypot(gm[0] - wm[0], gm[1] - wm[1]);
    const angGt = Math.atan2(g.b[1] - g.a[1], g.b[0] - g.a[0]) * 180 / Math.PI;
    const angW = Math.atan2(w.b[1] - w.a[1], w.b[0] - w.a[0]) * 180 / Math.PI;
    let da = Math.abs(angGt - angW) % 180; if (da > 90) da = 180 - da;
    // длина: покрытие эталонной стены найденной
    const gtLen = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]);
    out.errors.push({
      wall: g.a + '→' + g.b,
      posErr: +posErr.toFixed(3), angErr: +da.toFixed(1),
      thickGt: g.t, thick: +w.thickness.toFixed(3), thickErr: +(w.thickness - g.t).toFixed(3),
      lenGt: +gtLen.toFixed(2), len: +w.length.toFixed(2), lenErr: +(w.length - gtLen).toFixed(2),
      openings: (w.openings || []).length, expectOpenings: (g.openings || []).length,
      openingErr: openingErrors(g, w)
    });
  }
  out.extraWalls = model.walls.length - used.size;
  out.areaGt = sc.area; out.area = +model.stats.floorArea.toFixed(2);
  out.areaErrPct = sc.area == null ? null : +(100 * (model.stats.floorArea - sc.area) / sc.area).toFixed(2);
  out.heightGt = sc.H; out.height = +model.storey.height.toFixed(3); out.heightErr = +(model.storey.height - sc.H).toFixed(3);
  out.openingsGt = sc.walls.reduce((a, w) => a + (w.openings || []).length, 0);
  out.openings = model.stats.openingCount;
  const pos = out.errors.filter(e => !e.missing).map(e => e.posErr).sort((a, b) => a - b);
  const thk = out.errors.filter(e => !e.missing).map(e => Math.abs(e.thickErr)).sort((a, b) => a - b);
  out.posMedian = pos.length ? +pos[Math.floor(pos.length / 2)].toFixed(3) : null;
  out.posMax = pos.length ? pos[pos.length - 1] : null;
  out.thickMedian = thk.length ? +thk[Math.floor(thk.length / 2)].toFixed(3) : null;
  return out;
}

const scenes = { flat: sceneFlat, lshape: sceneLShape, rooms: sceneRooms };
const list = process.argv[2] && scenes[process.argv[2]] ? [process.argv[2]] : Object.keys(scenes);
const results = [];
for (const key of list) {
  const sc = scenes[key]();
  const opt = { step: 0.04, noise: 0.006 };
  if (key === 'flat') { sc.walls[0].openings.length = 2; }
  const pts = buildCloud(sc, opt);
  const model = S.reconstruct(pts, { voxel: 0.04 });
  if (!model.ok) { results.push({ scene: sc.name, error: model.error }); continue; }
  results.push(evaluate(sc, model));
}
if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 1));
else {
  for (const r of results) {
    console.log('\n=== ' + r.scene + ' ===');
    console.log(`стен: ${r.walls} (ждём ${r.expectedWalls}), лишних: ${r.extraWalls}`);
    console.log(`площадь: ${r.area} м² (эталон ${r.areaGt}, ошибка ${r.areaErrPct} %), высота ${r.height} (${r.heightGt}), проёмы ${r.openings} (ждём ${r.openingsGt})`);
    console.log(`положение оси: медиана ${r.posMedian} м, максимум ${r.posMax} м; толщина: медиана ошибки ${r.thickMedian} м`);
    for (const e of r.errors) console.log('  ', e.missing ? `ПРОПУЩЕНА ${e.gt}` : `стена ${e.wall}: сдвиг ${e.posErr} м, угол ${e.angErr}°, толщина ${e.thick} (эт. ${e.thickGt}), длина ${e.len} (эт. ${e.lenGt}), проёмы ${e.openings}/${e.expectOpenings}` + (e.openingErr ? ` [смещение ${e.openingErr.midMax} м, ширина ±${e.openingErr.wMax} м, подоконник ±${e.openingErr.sillMax} м, перемычка ±${e.openingErr.headMax} м]` : ''));
  }
}
