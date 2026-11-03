'use strict';
// BIM-модель по облаку (ревизия 41): поток карты облака, задание 'scan2bim'. Три прохода по файлу, без загрузки облака в память.
//   проход 1 — колонки занятости (план 5 см × полосы высоты), гистограмма высот → этажи;
//   проход 2 — точки вертикальных клеток каждого этажа → грани (прямые, дуги), колонны (круг/прямоугольник);
//   проход 3 — развёртки стен → высота, проёмы (окна, двери, ворота), витражи, материал, неровность и вертикаль;
//   (ревизия 40: тем же проходом 3 — сечения под потолком каждого этажа → трубы, лотки, кабели, воздуховоды, балки; scan2bim-mep.js)
//   (ревизия 41: тем же проходом — слои плана этажа → стояки; сети только под конструкцией; соединение трасс фитингами)
//   итог — модель: этажи, стены, проёмы, перекрытия, колонны, объекты площадки (деревья, кран, бытовки, столбы, ограждения).
const OV = require('./cloud-overview');
const C = require('./scan2bim-core');
const MEP = require('./scan2bim-mep');

function num(x, d) { const v = Number(x); return Number.isFinite(v) ? v : d; }
function wallPts(w, step) {
  if (w.kind === 'line') { const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]), k = Math.max(1, Math.ceil(L / step)), o = []; for (let i = 0; i <= k; i++) o.push([w.a[0] + (w.b[0] - w.a[0]) * i / k, w.a[1] + (w.b[1] - w.a[1]) * i / k]); return o; }
  const k = Math.max(2, Math.ceil(Math.abs(w.a1 - w.a0) * w.r / step)), o = []; for (let i = 0; i <= k; i++) { const a = w.a0 + (w.a1 - w.a0) * i / k; o.push([w.c[0] + w.r * Math.cos(a), w.c[1] + w.r * Math.sin(a)]); } return o;
}
function wallMid(w) { return w.kind === 'line' ? [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2] : [w.c[0] + w.r * Math.cos((w.a0 + w.a1) / 2), w.c[1] + w.r * Math.sin((w.a0 + w.a1) / 2)]; }
// выпуклая оболочка точек [[x,y]]
function hull2(P) {
  const p = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function polyArea(P) { let s = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; s += a[0] * b[1] - a[1] * b[0]; } return s / 2; }
// расстояние со знаком до выпуклого многоугольника (против часовой): < 0 — внутри
function convexDist(P, q) {
  let inside = true, dmin = Infinity;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    if (dx * (q[1] - a[1]) - dy * (q[0] - a[0]) < 0) inside = false;
    const t = C.clamp(((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2, 0, 1); dmin = Math.min(dmin, Math.hypot(q[0] - a[0] - dx * t, q[1] - a[1] - dy * t));
  }
  return inside ? -dmin : dmin;
}
// толщина односторонней стены (видна одна грань) — по материалу; ось сдвигается внутрь от видимой грани
function setThickness(w, t) {
  const dt = (t - w.thickness) / 2; if (!(Math.abs(dt) > 1e-6)) return;
  if (w.kind === 'line' && w.inward) { w.a = [w.a[0] + w.inward[0] * dt, w.a[1] + w.inward[1] * dt]; w.b = [w.b[0] + w.inward[0] * dt, w.b[1] + w.inward[1] * dt]; }
  else if (w.kind === 'arc') w.r += (w.inwardSign || 1) * dt;
  w.thickness = t;
}

// главное скопление стен (здание): стены связаны, если их точки ближе 4 м; берётся скопление с наибольшей длиной стен
function mainCluster(ws, gap) {
  gap = gap || 4; if (!ws.length) return [];
  const P = ws.map((w) => wallPts(w, 1)), par = ws.map((_, i) => i), f = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) {
    if (f(i) === f(j)) continue;
    let near = false; for (const p of P[i]) { for (const q of P[j]) if (Math.abs(p[0] - q[0]) < gap && Math.abs(p[1] - q[1]) < gap && Math.hypot(p[0] - q[0], p[1] - q[1]) < gap) { near = true; break; } if (near) break; }
    if (near) par[f(i)] = f(j);
  }
  const len = new Map(); ws.forEach((w, i) => len.set(f(i), (len.get(f(i)) || 0) + w.length));
  let best = -1, bl = -1; len.forEach((v, k) => { if (v > bl) { bl = v; best = k; } });
  let out = []; ws.forEach((w, i) => { if (f(i) === best) out = out.concat(P[i]); });
  return out;
}

function run(d, post) {
  const o = (d && d.opts) || {}, desc = d.desc, t0 = Date.now(), times = {}, warnings = [];
  const say = (p, label) => { try { post(p, label); } catch (_) {} };
  const prog = (a, b, label) => { let last = -1; return (f) => { if (f - last >= 0.01) { last = f; say(a + (b - a) * f, label); } }; };
  // ---- габариты: из карты облака или по выборке
  let bb = o.bbox && Number.isFinite(o.bbox.u0) ? Object.assign({}, o.bbox) : null;
  if (!bb) {
    say(0, 'Габариты облака');
    const ov = OV.overview(desc, { samples: num(o.samples, 1500000) });
    if (!ov || !ov.ok) return ov || { ok: false, message: 'облако не прочитано' };
    bb = Object.assign({}, ov.bbox.core);
  }
  if (o.rect) { bb.u0 = Math.max(bb.u0, o.rect.u0); bb.u1 = Math.min(bb.u1, o.rect.u1); bb.v0 = Math.max(bb.v0, o.rect.v0); bb.v1 = Math.min(bb.v1, o.rect.v1); }
  if (!(bb.u1 > bb.u0 && bb.v1 > bb.v0 && bb.h1 > bb.h0)) return { ok: false, message: 'пустая область облака' };
  const rect = { u0: bb.u0 - 0.3, u1: bb.u1 + 0.3, v0: bb.v0 - 0.3, v1: bb.v1 + 0.3 };
  // ---- проход 1
  const A = C.columnAcc(bb, { cell: num(o.cell, 0.05), maxCells: num(o.maxCells, 9e6) });
  const p1 = OV.eachPoint(desc, { h0: bb.h0 - 0.05, h1: bb.h1 + 0.05, rect, signal: d.signal, e57Points: 30000000, onProgress: prog(0.02, 0.3, 'Проход 1 из 3: план и этажи') }, (u, v, h, r) => A.add(u, v, h, r));
  if (!p1 || !p1.ok) return p1 || { ok: false, message: 'облако не прочитано' };
  times.pass1 = Date.now() - t0;
  const pk = C.histPeaks(A.hist, A.h0, A.hs);
  const S = C.storeysFrom(pk.peaks, { top: bb.h1, ground: o.ground != null ? num(o.ground, undefined) : undefined });
  const L = S.levels.map((l) => l.h);
  // ревизия 40: съёмка помещения — над верхним уровнем нет места для этажа, а у верха облака пик сильнее (потолок):
  // верхний «уровень» был ярусом труб и лотков, верх этажа — потолок
  if (L.length >= 2 && bb.h1 - L[L.length - 1] < 2.4) {
    const lastN = S.levels[S.levels.length - 1].n || 0;
    const up = pk.peaks.filter((p) => p.h > L[L.length - 1] + 0.3 && p.h <= bb.h1 + 0.05 && p.n >= 1.5 * lastN).sort((a, b) => b.h - a.h);
    if (up.length) { L[L.length - 1] = up[0].h; S.ceilingTop = true; }
  }
  if (!L.length) return { ok: false, message: 'не найден уровень пола — в облаке нет горизонтальных поверхностей' };
  const steps = L.slice(1).map((h, i) => h - L[i]), step = steps.length ? C.median(steps.slice(-4)) : 3.0;
  const topH = Math.min(L[L.length - 1] + Math.min(step, 4.5), bb.h1);
  if (topH > L[L.length - 1] + 1.2) L.push(topH); else if (L.length < 2) L.push(L[0] + 3);
  const NS = L.length - 1;
  say(0.31, 'Этажей: ' + NS + '. Ищу вертикальные элементы');
  // ---- вертикальные клетки и области по этажам
  const cover = num(o.cover, 0.4), labs = [], comps = [];
  for (let i = 0; i < NS; i++) {
    const m = C.dilate(C.storeyMask(A, L[i], L[i + 1], { cover }), A.nx, A.ny, 1, 1), cc = C.components(m, A.nx, A.ny, 1);
    labs.push(cc.lab); comps.push(cc.list.map((c) => Object.assign(c, { col: C.uvCollector(num(o.maxCompPts, 2500000)) })));
  }
  // ---- проход 2
  const p2 = OV.eachPoint(desc, { h0: L[0], h1: L[NS], rect, signal: d.signal, e57Points: 30000000, onProgress: prog(0.32, 0.55, 'Проход 2 из 3: стены и колонны') }, (u, v, h) => {
    let s = 0; while (s < NS - 1 && h >= L[s + 1]) s++;
    const x = Math.floor((u - A.u0) / A.cell), y = Math.floor((v - A.v0) / A.cell); if (x < 0 || y < 0 || x >= A.nx || y >= A.ny) return;
    const id = labs[s][y * A.nx + x]; if (id >= 0) comps[s][id].col.add(u, v);
  });
  if (!p2 || !p2.ok) return p2 || { ok: false, message: 'облако не прочитано' };
  times.pass2 = Date.now() - t0 - times.pass1;
  labs.length = 0;
  const storeyPrims = [];
  for (let i = 0; i < NS; i++) {
    say(0.56 + 0.04 * i / NS, 'Грани и колонны: этаж ' + (i + 1));
    const prims = [], cols = [];
    for (const c of comps[i]) {
      if (c.col.count() < 60) continue;
      const P = c.col.get(), ext = Math.max(c.x1 - c.x0 + 1, c.y1 - c.y0 + 1) * A.cell;
      if (ext <= 1.6) { const f = C.fitColumn(P); if (f) cols.push(Object.assign(f, { n: c.col.count() * c.col.stride(), ext })); continue; }
      C.fitPrimitives(P, { rMin: 1.5 }).prims.forEach((p) => prims.push(p));
    }
    comps[i] = null;
    storeyPrims.push({ prims, cols });
  }
  // ---- стены: сначала верхние этажи — по ним зона здания и её центр (односторонние стены — внутрь к нему)
  const W = new Array(NS);
  for (let i = NS - 1; i >= 1; i--) W[i] = C.wallsOfStorey(storeyPrims[i].prims, {}).walls;
  let zoneSrc = mainCluster([].concat.apply([], W.slice(1).map((ws) => ws.filter((w) => w.length >= 2))));
  let center = null;
  if (zoneSrc.length >= 3) { const hz = hull2(zoneSrc); let cx = 0, cy = 0; hz.forEach((p) => { cx += p[0]; cy += p[1]; }); center = [cx / hz.length, cy / hz.length]; }
  W[0] = C.wallsOfStorey(storeyPrims[0].prims, center ? { center } : {}).walls;
  if (zoneSrc.length < 3) zoneSrc = mainCluster(W[0].filter((w) => w.length >= 3));
  let zone = zoneSrc.length >= 3 ? hull2(zoneSrc) : null;
  if (zone && polyArea(zone) < 0) zone.reverse();
  const inZone = (p, buf) => !zone || convexDist(zone, p) <= buf;
  // ---- проход 3: развёртки
  const all = [];
  for (let i = 0; i < NS; i++) W[i].forEach((w) => { w.storey = i; w.h0 = L[i]; w.h1 = L[i + 1]; w.site = !inZone(wallMid(w), i === 0 ? 1.0 : 1.5); all.push(w); });
  const acc = C.elevAcc(all, {});
  // ревизия 40: инженерные сети — зона каждого этажа от 1,9 м над полом до потолка (пик гистограммы под следующим уровнем);
  // точки в полосе стен и вне здания не учитываются (импосты и ригели фасада — не сети)
  let mep = null, mepMask = null, riser = null, outMask = null;
  if (o.mep !== false) {
    const zones = [], rz = [];
    for (let i = 0; i < NS; i++) {
      const last = i === NS - 1, top = L[i + 1];
      const cp = pk.peaks.filter((p) => p.h > L[i] + 2.2 && p.h <= (last ? top + 0.05 : top - 0.1)).map((p) => p.h);
      const ceil = cp.length ? Math.max.apply(null, cp) : (last ? top : top - num(o.slabT, 0.2));
      if (ceil - (L[i] + 1.9) > 0.3) zones.push({ storey: i, h0: L[i] + 1.9, h1: ceil + 0.06, ceil });
      if (ceil - L[i] > 1.5) rz.push({ storey: i, h0: L[i] + 0.15, h1: ceil - 0.03 });
    }
    // ревизия 41: стояки — слои плана 0,2 м по всей высоте этажа (точки у стен учитываются: стояки обычно у стен)
    if (o.risers !== false && rz.length) {
      riser = MEP.riserAcc({ axes: MEP.axesFrom(all), zones: rz, rect, cell: num(o.riserCell, 0.015), budgetBits: num(o.riserBudget, Math.min(5e9, Math.max(3e9, require('os').totalmem() * 8 / 30))) });
      if (zone) { outMask = new Uint8Array(A.nx * A.ny); for (let y = 0; y < A.ny; y++) for (let x = 0; x < A.nx; x++) if (convexDist(zone, [A.u0 + (x + 0.5) * A.cell, A.v0 + (y + 0.5) * A.cell]) > 0.3) outMask[y * A.nx + x] = 1; }
    }
    if (zones.length) {
      mep = MEP.mepAcc({ axes: MEP.axesFrom(all), zones, rect, cell: num(o.mepCell, 0.015), budgetBits: num(o.mepBudget, 1.6e9) });
      mepMask = new Uint8Array(A.nx * A.ny);
      const stamp = (x, y, r) => { const ix = Math.floor((x - A.u0) / A.cell), iy = Math.floor((y - A.v0) / A.cell), k = Math.ceil(r / A.cell); for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) { const a = ix + dx, b = iy + dy; if (a >= 0 && b >= 0 && a < A.nx && b < A.ny) mepMask[b * A.nx + a] = 1; } };
      all.forEach((w) => { const t = (w.thickness || 0.25) / 2 + 0.1; wallPts(w, A.cell).forEach((p) => stamp(p[0], p[1], t)); });
      if (zone) for (let y = 0; y < A.ny; y++) for (let x = 0; x < A.nx; x++) { const i = y * A.nx + x; if (!mepMask[i] && convexDist(zone, [A.u0 + (x + 0.5) * A.cell, A.v0 + (y + 0.5) * A.cell]) > 0.3) mepMask[i] = 1; }
    }
  }
  const h3a = Math.min(acc.E.length ? acc.hmin : Infinity, mep ? mep.hmin : Infinity, riser ? riser.hmin : Infinity), h3b = Math.max(acc.E.length ? acc.hmax : -Infinity, mep ? mep.hmax : -Infinity, riser ? riser.hmax : -Infinity);
  say(0.61, 'Проход 3 из 3: развёртки ' + acc.E.length + ' стен' + (mep ? ' и сечения сетей' : ''));
  const p3 = h3b > h3a ? OV.eachPoint(desc, { h0: h3a, h1: h3b, rect, signal: d.signal, e57Points: 30000000, onProgress: prog(0.61, 0.92, 'Проход 3 из 3: проёмы, материалы' + (mep ? ', сети' : '')) }, (u, v, h, r) => {
    acc.add(u, v, h, r);
    if (riser && h >= riser.hmin && h < riser.hmax) {
      const x = Math.floor((u - A.u0) / A.cell), y = Math.floor((v - A.v0) / A.cell);
      if (!outMask || !(x >= 0 && y >= 0 && x < A.nx && y < A.ny && outMask[y * A.nx + x])) riser.add(u, v, h, r);
    }
    if (mep && h >= mep.hmin && h < mep.hmax) {
      const x = Math.floor((u - A.u0) / A.cell), y = Math.floor((v - A.v0) / A.cell);
      if (x >= 0 && y >= 0 && x < A.nx && y < A.ny && mepMask[y * A.nx + x]) return;
      mep.add(u, v, h, r);
    }
  }) : { ok: true };
  if (!p3 || !p3.ok) return p3 || { ok: false, message: 'облако не прочитано' };
  times.pass3 = Date.now() - t0 - times.pass1 - times.pass2;
  say(0.93, 'Собираю модель');
  let mepList = [];
  if (mep) {
    say(0.93, 'Трубы, лотки и кабели');
    const tm = Date.now();
    try { mepList = MEP.mepFind(mep, { needCeiling: o.mepNeedCeiling !== false, ladder: o.ladderTrays !== false }); } catch (e) { warnings.push('инженерные сети не разобраны: ' + String((e && e.message) || e)); }
    times.mep = Date.now() - tm;
    mep = null; mepMask = null;
  }
  let riserList = [];
  if (riser) {
    say(0.935, 'Стояки');
    const tr = Date.now();
    try { riserList = MEP.riserFind(riser, {}); } catch (e) { warnings.push('стояки не разобраны: ' + String((e && e.message) || e)); }
    times.risers = Date.now() - tr;
    riser = null; outMask = null;
  }
  const an = new Map(); acc.E.forEach((e) => { an.set(e.wi, C.analyseWall(e, all[e.wi], {})); });
  acc.E.length = 0;
  // ---- стены модели
  // ревизия 40: членение витража и окна — профили (стойки, ригели, рама) и заполнения, координаты s вдоль стены и h
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const gridOut = (g, top) => {
    const cut = (o) => Object.assign({}, o, { z1: Math.min(o.z1, top) });
    const mem = g.members.map(cut).filter((m) => m.z1 - m.z0 > 0.02).map((m) => ({ dir: m.dir, s0: r3(m.s0), s1: r3(m.s1), z0: r3(m.z0), z1: r3(m.z1), frame: !!m.frame || !!m.edge }));
    const pan = g.panels.map(cut).filter((p) => p.z1 - p.z0 > 0.02 && p.s1 - p.s0 > 0.02).map((p) => ({ kind: p.kind, mat: p.mat, s0: r3(p.s0), s1: r3(p.s1), z0: r3(p.z0), z1: r3(p.z1) }));
    return { members: mem, panels: pan };
  };
  const walls = [];
  all.forEach((w, wi) => {
    const a = an.get(wi) || { ok: false };
    const top = a.ok ? Math.min(a.top, w.h1 + 0.15) : w.h1, height = top - w.h0;
    if (height < 0.3) return;
    const mat = a.ok ? a.material : 'unknown';
    if (!w.measured) setThickness(w, (C.MATERIALS[mat] || C.MATERIALS.unknown).t);
    const role = w.site ? (height < 2.6 ? 'fence' : 'site') : (height < 1.3 ? 'parapet' : 'wall');
    const R = C.refFace(w);
    walls.push({
      id: 'W' + (walls.length + 1), storey: w.storey, kind: w.kind, a: w.a, b: w.b, c: w.c, r: w.r, a0: w.a0, a1: w.a1,
      length: w.length, thickness: w.thickness, thicknessMeasured: !!w.measured, sides: w.sides, base: w.h0, height, top,
      role, curtain: !!a.curtain, material: mat, materialConf: a.materialConf || 0, materials: a.materials || [],
      rms: a.rms, plumb: a.plumb, offset: a.offset, coverage: a.coverage, points: a.points || 0, faceRms: w.rms,
      ref: R.kind === 'line' ? { kind: 'line', a: R.a, u: [R.ux, R.uy], n: [R.nx, R.ny], L: R.L } : { kind: 'arc', c: R.c, r: R.r, a0: R.a0, L: R.L, sgn: R.sgn },
      openings: a.ok && !a.curtain ? a.openings.filter((q) => !q.occluded).map((q) => ({ kind: q.kind, s0: q.s0, s1: q.s1, z0: q.z0, z1: Math.min(q.z1, top), width: q.width, height: Math.min(q.z1, top) - q.z0, sill: q.sill, glazed: q.glazed || 0, grid: q.grid ? gridOut(q.grid, top) : null })) : [],
      panels: a.ok && a.curtain ? a.openings.length : 0, grid: a.ok && a.curtain && a.grid ? gridOut(a.grid, top) : null
    });
  });
  // ---- колонны и столбы
  const columns = [], objects = [];
  storeyPrims.forEach((sp, i) => sp.cols.forEach((c) => {
    let ok = false, size;
    if (c.kind === 'round') { ok = c.rms <= num(o.colRms, 0.012) && c.span >= 150 && c.n >= 500 && c.d >= 0.12 && c.d <= 1.5; size = { d: c.d }; }
    else { const a = Math.min(c.w, c.d), b = Math.max(c.w, c.d); ok = c.rms <= 0.015 && a >= 0.15 && b <= 1.2 && b / a <= 3 && c.n >= 300; size = { w: c.w, d: c.d, phi: c.phi }; }
    if (!ok) return;
    const el = Object.assign({ storey: i, shape: c.kind === 'round' ? 'round' : 'rect', c: c.c, base: L[i], height: L[i + 1] - L[i], rms: c.rms, span: c.span || null, points: c.n }, size);
    if (inZone(c.c, 0.5)) columns.push(Object.assign({ id: 'C' + (columns.length + 1) }, el));
    else if (i === 0) objects.push({ kind: 'pole', name: 'Столб / опора', c: c.c, shape: el.shape, d: el.d, w: el.w, dd: el.d, phi: el.phi, base: L[0], height: L[1] - L[0], measured: 'сечение' });
  }));
  // ---- ревизия 41: стояки внутри колонн и столбов — это они сами; соединение трасс (слияние, отводы, тройники, переходы)
  const inCol = (p, st) => columns.concat(objects.filter((x) => x.kind === 'pole')).some((c) => (c.storey === undefined || c.storey === st) && Math.hypot(p[0] - c.c[0], p[1] - c.c[1]) <= (c.d || Math.max(c.w || 0, c.dd || 0)) / 2 + 0.05);
  riserList = riserList.filter((e) => !inCol(e.path[0], e.storey));
  let fittings = [];
  {
    let all2 = mepList.concat(riserList);
    if (o.fittings !== false && all2.length > 1) {
      try { const cn = MEP.mepConnect(all2, {}); all2 = cn.list; fittings = cn.fittings; times.merges = cn.merges; } catch (e) { warnings.push('соединения сетей не построены: ' + String((e && e.message) || e)); }
    }
    all2.sort((p, q) => (p.storey - q.storey) || p.kind.localeCompare(q.kind) || (q.length - p.length));
    all2.forEach((e, i) => { e.id = 'N' + (i + 1); e.base = Math.round((e.path.reduce((s, p) => s + p[2], 0) / e.path.length - L[e.storey]) * 1000) / 1000; });
    fittings.forEach((f, i) => { f.id = 'F' + (i + 1); f.links = f.links.map((x) => x.id).filter(Boolean); f.path = f.parts[0]; f.length = 0; f.base = Math.round((f.at[2] - L[f.storey]) * 1000) / 1000; });
    mepList = all2.concat(fittings);
  }
  // ---- перекрытия: контур — выпуклая оболочка стен здания этажа (ниже и выше уровня)
  const slabs = [];
  for (let i = 0; i <= NS; i++) {
    let P = [];
    const si = i === NS ? NS - 1 : i;   // перекрытие — под стенами своего этажа, покрытие — над стенами верхнего
    walls.forEach((w) => { if (w.role !== 'wall' || w.length < 1.5) return; if (w.storey === si) P = P.concat(wallPts(w, 0.5)); });
    if (P.length < 3) continue;
    let hP = hull2(P); if (polyArea(hP) < 0) hP.reverse();
    const area = polyArea(hP); if (area < 4) continue;
    slabs.push({ id: 'S' + (slabs.length + 1), level: i, kind: i === 0 ? 'floor' : (i === NS ? 'roof' : 'floor'), h: L[i], thickness: num(o.slabT, 0.2), outline: hP, area, approx: 'hull' });
  }
  // ---- объекты площадки из прохода 1: высокие клетки вне здания
  const N = A.nx * A.ny, tall = new Uint8Array(N), gH = new Float32Array(N), tH = new Float32Array(N);
  const bandRaw = A.dz;
  for (let c = 0; c < N; c++) {
    if (!A.cnt[c]) continue; const t = C.cellRunTop(A, c, Math.max(3, Math.round(0.4 / A.dz))), b = C.cellBottom(A, c); gH[c] = b; tH[c] = t;
    // стоит на земле: занятые полосы от 0,3 до 2,5 м над низом клетки (стрела крана и кроны над землёй — не опора объекта)
    // низ клетки — у земли: под стрелой крана земля не снята, и «низ» оказывается на стреле
    if (b <= L[0] + 1.0 && t - b >= 0.6 + bandRaw && C.coverage(A, c, b + 0.3, b + 2.5) > 0) tall[c] = 1;
  }
  const mark = (p, rad) => { const r = Math.ceil(rad / A.cell), x0 = Math.floor((p[0] - A.u0) / A.cell), y0 = Math.floor((p[1] - A.v0) / A.cell); for (let y = y0 - r; y <= y0 + r; y++) for (let x = x0 - r; x <= x0 + r; x++) if (x >= 0 && y >= 0 && x < A.nx && y < A.ny) tall[y * A.nx + x] = 0; };
  if (zone) for (let y = 0; y < A.ny; y++) for (let x = 0; x < A.nx; x++) { const c = y * A.nx + x; if (tall[c] && convexDist(zone, [A.u0 + (x + 0.5) * A.cell, A.v0 + (y + 0.5) * A.cell]) <= 1.0) tall[c] = 0; }
  walls.forEach((w) => { if (w.role === 'fence' || w.role === 'site') wallPts(w, A.cell).forEach((p) => mark(p, 0.3)); });
  objects.forEach((ob) => mark(ob.c, 0.6));
  const cc = C.components(C.dilate(tall, A.nx, A.ny, 2, 1), A.nx, A.ny, 1);
  const cellsOf = cc.list.map(() => []);
  for (let c = 0; c < N; c++) { const id = cc.lab[c]; if (id >= 0 && tall[c]) cellsOf[id].push(c); }
  cc.list.forEach((k, id) => {
    const cl = cellsOf[id]; if (cl.length < 6) return;
    let hmin = Infinity, hmax = -Infinity, green = 0; const P = [];
    cl.forEach((c) => { const x = c % A.nx, y = (c - x) / A.nx; P.push([A.u0 + (x + 0.5) * A.cell, A.v0 + (y + 0.5) * A.cell]); hmin = Math.min(hmin, gH[c]); hmax = Math.max(hmax, tH[c]); if (C.isGreen(A, c)) green++; });
    const H = hmax - hmin; if (H < 0.8) return;
    if (hmin > L[0] + 0.6) return;   // стоит выше пола первого этажа — часть здания или лесов, а не объект площадки
    if (H >= 15 && green / cl.length < 0.3) {
      // высокое (кран, мачта): каждая мачта — связная группа клеток выше 60 % высоты (без бытовок и штабелей у основания)
      const hi = new Uint8Array(N); cl.forEach((c) => { if (tH[c] >= hmin + 0.6 * H) hi[c] = 1; });
      const mc = C.components(C.dilate(hi, A.nx, A.ny, Math.max(1, Math.round(1.2 / A.cell)), 1), A.nx, A.ny, 1), got = mc.list.map(() => []);
      // сечение мачты — все пояса и раскосы группы выше 30 % высоты (до верха доходит не каждый пояс)
      cl.forEach((c, j) => { const q = mc.lab[c]; if (q >= 0 && tH[c] >= hmin + 0.3 * H) got[q].push(j); });
      got.forEach((js) => {
        if (js.length < 3) return;
        let top = -Infinity; const Q = js.map((j) => { top = Math.max(top, tH[cl[j]]); return P[j]; });
        if (!js.some((j) => hi[cl[j]])) return;
        const hq = hull2(Q), m2 = C.minRect(hq.length >= 3 ? hq : Q); if (!m2) return;
        const w = Math.max(m2.w, A.cell * 2), d = Math.max(m2.d, A.cell * 2), Hm = top - hmin;
        if (Hm < 15 || Math.max(w, d) > 12) return;   // решётчатая мачта: пояса и раскосы в радиусе 1,2 м — одна мачта
        objects.push({ kind: 'crane', name: Math.max(w, d) > 4 ? 'Кран / высотная конструкция' : 'Башенный кран / мачта', c: m2.c, w, dd: d, phi: m2.phi, outline: hq.length >= 3 ? hq : null, base: hmin, height: Hm, green: 0 });
      });
      return;
    }
    const PP = P;
    const hz = hull2(PP), mr = C.minRect(hz.length >= 3 ? hz : PP); if (!mr) return; const Lr = Math.max(mr.w, mr.d), Wr = Math.min(mr.w, mr.d), gf = green / cl.length;
    let kind = 'object', name = 'Объект';
    if (gf >= 0.3 && H >= 2) { kind = 'tree'; name = 'Дерево'; }
    else if (gf >= 0.3) { kind = 'shrub'; name = 'Кустарник / зелень'; }
    else if (H >= 15) { kind = 'crane'; name = Lr > 8 ? 'Кран / высотная конструкция' : 'Башенный кран / мачта'; }
    else if (H >= 6 && Lr > 3) { kind = 'structure'; name = 'Конструкция (леса, подъёмник)'; }
    else if (Wr <= 0.5 && Lr >= 2) { kind = 'fence'; name = 'Ограждение'; }
    else if (Lr >= 2 && Lr <= 14 && Wr >= 1.8 && Wr <= 3.6 && H >= 2 && H <= 3.6) { kind = 'cabin'; name = 'Бытовка / контейнер'; }
    else if (Lr <= 0.8 && H >= 2.5) { kind = 'pole'; name = 'Столб / опора'; }
    else if (H <= 2.2 && Lr <= 6) { kind = 'stack'; name = 'Штабель / техника'; }
    if (Lr * Wr < 0.25 && H < 2.5) return;   // люди, мусор, отдельные ветки
    objects.push({ kind, name, c: mr.c, w: Lr, dd: Wr, phi: mr.phi, outline: hz, base: hmin, height: H, green: gf });
  });
  times.total = Date.now() - t0;
  const storeys = L.slice(0, NS).map((h, i) => ({ index: i, name: 'Этаж ' + (i + 1), h, z: h + (num(desc.cz, 0)), height: L[i + 1] - h,
    walls: walls.filter((w) => w.storey === i && w.role === 'wall').length }));
  if (S.levels.length < 2) warnings.push('найден только один уровень пола — высота этажа взята по облаку');
  if (!zone) warnings.push('зона здания не определена — все стены отнесены к зданию');
  if (!A.hasColor()) warnings.push('в облаке нет цвета — материал и остеклённые окна определяются хуже');
  const stats = {
    storeys: NS, walls: walls.filter((w) => w.role === 'wall').length, curtainWalls: walls.filter((w) => w.curtain && w.role === 'wall').length,
    siteWalls: walls.filter((w) => w.role !== 'wall' && w.role !== 'parapet').length, parapets: walls.filter((w) => w.role === 'parapet').length,
    windows: 0, doors: 0, gates: 0, columns: columns.length, slabs: slabs.length, objects: objects.length,
    wallLength: walls.reduce((s, w) => s + (w.role === 'wall' ? w.length : 0), 0)
  };
  walls.forEach((w) => w.openings.forEach((q) => { if (q.kind === 'window') stats.windows++; else if (q.kind === 'door') stats.doors++; else stats.gates++; }));
  stats.mullions = 0; stats.glassPanels = 0;
  walls.forEach((w) => [w.grid].concat(w.openings.map((q) => q.grid)).forEach((g) => { if (!g) return; stats.mullions += g.members.filter((m) => !m.frame).length; stats.glassPanels += g.panels.filter((p) => p.kind === 'vision').length; }));
  // ревизия 40: инженерные сети
  stats.mep = mepList.filter((e) => e.kind !== 'fitting').length; stats.pipes = 0; stats.trays = 0; stats.cables = 0; stats.ducts = 0; stats.beams = 0; stats.pipeLength = 0; stats.trayLength = 0; stats.cableLength = 0;
  stats.risers = 0; stats.riserLength = 0; stats.fittings = 0; stats.elbows = 0; stats.tees = 0; stats.transitions = 0; stats.ladderTrays = 0; stats.bundles = 0;
  mepList.forEach((e) => {
    if (e.kind === 'fitting') { stats.fittings++; if (e.type === 'elbow') stats.elbows++; else if (e.type === 'tee') stats.tees++; else stats.transitions++; return; }
    if (e.riser) { stats.risers++; stats.riserLength += e.length; }
    if (e.ladder) stats.ladderTrays++;
    if (e.bundle) stats.bundles++;
    if (e.kind === 'pipe') { stats.pipes++; stats.pipeLength += e.length; } else if (e.kind === 'tray') { stats.trays++; stats.trayLength += e.length; }
    else if (e.kind === 'cable') { stats.cables++; stats.cableLength += e.length; } else if (e.kind === 'duct') stats.ducts++; else if (e.kind === 'beam') stats.beams++;
  });
  ['pipeLength', 'trayLength', 'cableLength', 'riserLength'].forEach((k) => { stats[k] = Math.round(stats[k] * 10) / 10; });
  return {
    ok: true, format: 'bimtwin-scan2bim', version: 1, units: 'm', origin: { cx: num(desc.cx, 0), cy: num(desc.cy, 0), cz: num(desc.cz, 0) },
    bbox: bb, levels: L, step, storeys, walls, columns, slabs, objects, mep: mepList, zone, stats, warnings, times,
    points: { pass1: p1.used, sampled: !!p1.sampled }, cell: A.cell
  };
}
module.exports = { run, mainCluster, hull2, convexDist, setThickness, wallPts };
