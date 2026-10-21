'use strict';
// Контроль геометрии по облаку (ревизия 31): поток карты облака, задание 'inspect'.
// Проход 1 — горизонтальный срез и план (renderer/auto-plan.js): грани стен, проёмы, помещения.
// Проход 2 — точки от пола до верха стен: сетка высот пола (FF/FL по ASTM E1155, уклон, рейка 2 м, по помещениям)
// и отклонения стен от плоскости (вертикаль, неровность, рейка), сторона помещения у грани — по маршруту сканера.
// Ревизия 32: наклон облака по стенам (выравнивание), местные дефекты пола и стен, проёмы плана с высотой и подоконником.
const OV = require('./cloud-overview');
const CI = require('./renderer/cloud-inspect.js');
const AP = require('./renderer/auto-plan.js');
const DF = require('./renderer/cloud-defects.js');

function num(x, d) { const v = Number(x); return Number.isFinite(v) ? v : d; }
function interRect(a, b) {
  if (!a) return b; if (!b) return a;
  const r = { u0: Math.max(a.u0, b.u0), u1: Math.min(a.u1, b.u1), v0: Math.max(a.v0, b.v0), v1: Math.min(a.v1, b.v1) };
  return r.u1 > r.u0 && r.v1 > r.v0 ? r : a;
}

function run(d, post) {
  const o = (d && d.opts) || {}, desc = d.desc, t0 = Date.now(), times = {};
  const say = (p, label) => { try { post(p, label); } catch (_) {} };
  const floor = num(o.floor, num(o.h0, 0) - 1.2), top = num(o.top, floor + 2.6);
  if (!(top > floor + 0.5)) return { ok: false, message: 'верх стен должен быть выше пола хотя бы на 0,5 м' };
  const tol = Object.assign({ floorRail: 4, wallRail: 3, plumbPerM: 2, plumbMax: 10 }, o.tol || {});
  const doFloor = o.doFloor !== false, doWalls = o.doWalls !== false;
  // ---- проход 1: срез и план
  let last = 0;
  // ревизия 32: у очищенного облака план (стены, проёмы, помещения) берётся по исходному — очистка убирает редкие дальние стены и
  // сжимает облако у стен, местный порог плотности плана растёт, и часть граней теряется; мерить же лучше по очищенному
  const planDesc = o.planDesc && typeof o.planDesc === 'object' ? o.planDesc : null;
  const sl = OV.planSlice(planDesc || desc, Object.assign({}, o, { planDesc: undefined, onProgress: (f) => { if (f - last >= 0.01) { last = f; say(f * 0.3, 'Читаю срез облака'); } } }));
  if (!sl || !sl.ok) return sl || { ok: false, message: 'срез не прочитан' };
  times.slice = Date.now() - t0;
  say(0.31, 'Ищу стены, проёмы и помещения');
  const popt = Object.assign({}, o.plan || {}), dbg = {};
  popt.debugRooms = dbg;
  if (sl.uvHigh && sl.countHigh) { popt.uvHigh = sl.uvHigh; if (sl.bandHigh) { popt.bandHigh = sl.bandHigh; popt.highBands = sl.highBands; } }
  const plan = AP.extract(sl.uv, popt);
  delete popt.debugRooms;
  times.plan = Date.now() - t0 - times.slice;
  const n = sl.count, keep = Math.min(n, 200000), st = n / Math.max(1, keep), pv = new Float32Array(keep * 2);
  for (let j = 0; j < keep; j++) { const i = Math.floor(j * st); pv[j * 2] = sl.uv[i * 2]; pv[j * 2 + 1] = sl.uv[i * 2 + 1]; }
  const slice = { count: n, stride: sl.stride, h0: sl.h0, h1: sl.h1, preview: pv };
  const faces = plan && plan.ok ? plan.faces : [];
  // рамка: план ±0,5 м (или срез), с ограничением пользователя
  let bb = plan && plan.ok && plan.bbox ? plan.bbox : null;
  if (!bb) { bb = { u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity }; for (let j = 0; j < keep; j++) { const u = pv[j * 2], v = pv[j * 2 + 1]; if (u < bb.u0) bb.u0 = u; if (u > bb.u1) bb.u1 = u; if (v < bb.v0) bb.v0 = v; if (v > bb.v1) bb.v1 = v; } }
  if (!(bb.u1 > bb.u0 && bb.v1 > bb.v0)) return { ok: false, message: 'в срезе нет точек', slice };
  const rect = interRect(o.rect || null, { u0: bb.u0 - 0.5, u1: bb.u1 + 0.5, v0: bb.v0 - 0.5, v1: bb.v1 + 0.5 });
  // ---- проход 2: пол и стены
  const fb0 = floor - 0.15, fb1 = floor + 0.2;
  const facc = doFloor ? CI.floorAcc({ u0: rect.u0, u1: rect.u1, v0: rect.v0, v1: rect.v1, h0: fb0, h1: fb1, cell: num(o.cell, 0.1) }) : null;
  const wacc = doWalls && faces.length ? CI.wallAcc(faces, { floor, top, minLen: num(o.minWall, 1) }) : null;
  const opFaces = o.openings !== false && plan && plan.ok ? DF.openingFaces(plan.openings) : [];
  const oacc = opFaces.length ? CI.wallAcc(opFaces, { floor, top, minLen: 0.4, skipBottom: 0.02 }) : null;
  if (!facc && !wacc) return { ok: false, message: plan && plan.ok ? 'нечего проверять' : 'стены не найдены: ' + ((plan && plan.message) || 'план не построен'), plan, slice };
  say(0.4, 'Читаю пол и стены');
  last = 0;
  const h0 = facc ? fb0 : floor + 0.05, h1 = wacc ? top : fb1;
  const pass = OV.eachPoint(desc, { h0, h1, rect, signal: d.signal, e57Points: 30000000,
    onProgress: (f) => { if (f - last >= 0.01) { last = f; say(0.4 + f * 0.5, 'Читаю пол и стены'); } } }, (u, v, h) => {
    if (facc && h <= fb1) facc.add(u, v, h);
    if (wacc) wacc.add(u, v, h);
    if (oacc) oacc.add(u, v, h);
  });
  if (!pass || !pass.ok) return pass || { ok: false, message: 'облако не прочитано' };
  times.pass = Date.now() - t0 - times.slice - times.plan;
  const out = { ok: true, plan, slice, floorH: floor, top, tol, rect, points: { read: pass.read, used: pass.used, sampled: !!pass.sampled }, times };
  if (planDesc) out.planFrom = 'source';
  const dtol = Object.assign({ floor: 5, wall: 5 }, o.defTol || {});
  let level = null;
  // ---- стены и углы
  if (wacc) {
    say(0.91, 'Считаю вертикаль и ровность стен');
    const route = o.route && o.route.length >= 8 ? o.route : null;
    const side = route ? CI.sidesFromRoute(faces, route, { radius: 10, minLen: num(o.minWall, 1) }) : {};
    const wr = CI.wallReport(wacc, { side, plumbPerM: tol.plumbPerM, plumbMax: tol.plumbMax, tol: tol.wallRail, keepSmooth: true });
    // наклон облака по стенам; поправка — если наклон заметен (больше 0,3 мм/м и двух погрешностей)
    level = DF.levelFromWalls(wr.walls);
    level.applied = o.level !== false && level.ok && level.significant;
    if (level.applied) DF.applyLevelWalls(wr, level, { plumbPerM: tol.plumbPerM, plumbMax: tol.plumbMax });
    let nDef = 0;
    wr.walls.forEach((w) => { if (o.defects !== false && w._sm) { const d = DF.wallDefects(w, w._sm, { tol: dtol.wall }); w.defects = d.list; nDef += d.list.length; } delete w._sm; });
    if (o.defects !== false) { wr.defects = nDef; wr.defTol = dtol.wall; }
    wr.points = wacc.count(); wr.sided = Object.keys(side).length; wr.faces = faces.length;
    out.walls = wr;
    out.corners = CI.corners(faces);
  }
  // ---- пол
  if (facc) {
    say(0.95, 'Считаю ровность пола');
    const g = CI.floorGrid(facc, { objTol: num(o.objTol, 0.015) });
    if (level && level.applied) DF.levelFloorGrid(g, level);
    const lab = dbg.grid || null, rooms = plan && plan.ok ? plan.rooms || [] : [];
    const sec = lab ? CI.sectionsFrom(g, lab, rooms) : null;
    const phi = plan && plan.ok && plan.directions && plan.directions.length ? plan.directions[0] * Math.PI / 180 : 0;
    const rep = CI.floorReport(g, { phi, sec, rooms, tol: tol.floorRail });
    rep.grid = { u0: g.u0, v0: g.v0, cell: g.cell, nx: g.nx, ny: g.ny, flag: g.flag };
    if (sec) rep.grid.sec = sec;
    if (o.defects !== false) { const fd = DF.floorDefects(g, { tol: dtol.floor, sec, rooms }); rep.defects = fd.list; rep.defTotal = fd.total; rep.defObjects = fd.objects; rep.defTol = dtol.floor; }
    rep.leveled = !!(level && level.applied);
    rep.points = facc.count(); rep.band = [fb0, fb1]; rep.phi = phi * 180 / Math.PI;
    out.floor = rep;
  }
  // ---- проёмы: высота, подоконник
  if (oacc) { say(0.98, 'Измеряю проёмы'); out.openings = DF.openingReport(oacc, {}); }
  if (level) out.level = level;
  times.total = Date.now() - t0;
  say(1, 'Готово');
  return out;
}

function transferList(r) {
  const list = [], seen = new Set();
  const add = (v) => { if (ArrayBuffer.isView(v) && v.buffer instanceof ArrayBuffer && !seen.has(v.buffer)) { seen.add(v.buffer); list.push(v.buffer); } };
  if (!r) return list;
  if (r.slice) add(r.slice.preview);
  if (r.floor) { if (r.floor.maps) { add(r.floor.maps.plane); add(r.floor.maps.level); } if (r.floor.grid) { add(r.floor.grid.flag); add(r.floor.grid.sec); } }
  if (r.walls && r.walls.walls) r.walls.walls.forEach((w) => { if (w.grid) add(w.grid.res); });
  return list;
}

module.exports = { run, transferList };
