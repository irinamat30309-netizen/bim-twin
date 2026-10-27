/*
 * scan2bim-export.js — выгрузка BIM-модели, построенной по облаку (ревизия 40, scan2bim-job.js):
 *   IFC4 (ISO-10303-21): площадка, здание, этажи; стены (IfcWall / IfcCurtainWall) экструзией контура, проёмы IfcOpeningElement
 *   с окнами и дверями (IfcWindow / IfcDoor), перекрытия и кровля (IfcSlab), колонны (IfcColumn, круг или прямоугольник),
 *   объекты площадки (IfcBuildingElementProxy, деревья — IfcGeographicElement), материалы (IfcMaterial), цвета, наборы свойств;
 *   ревизия 40: витраж — сборка из стоек и ригелей (IfcMember .MULLION.) и заполнений (IfcPlate .CURTAIN_PANEL.), окно — рама,
 *   импосты и стеклопакеты отдельными телами; инженерные сети (model.mep): IfcPipeSegment и IfcCableSegment (IfcSweptDiskSolid
 *   по оси), IfcCableCarrierSegment (лоток), IfcDuctSegment, IfcBeam — с набором свойств BIMTwin_Сети
 *   с точностью по облаку (СКО, отклонение от вертикали, измерена ли толщина, доля покрытия точками);
 *   OBJ + MTL — сетка для любого 3D-редактора (стены разрезаны по проёмам, остекление — полупрозрачное);
 *   DXF R12 — планы этажей (контуры стен, проёмы, колонны, перекрытия) слоями;
 *   отчёт JSON и текстовая сводка.
 * Координаты модели — плановые (u, v, h) облака; в файлах они возвращаются к координатам облака: X = u + cx, Y = v + cy, Z = h + cz
 * (параметр local: true — оставить местные, удобно для просмотрщиков, которые плохо переносят большие координаты).
 * window.Scan2BimExport + module.exports.
 */
(function (root) {
  'use strict';
  var DXF = (typeof module !== 'undefined' && module.exports) ? require('./dxf.js') : root.DXF;

  var MAT = {
    brick: { name: 'Кирпич', ifc: 'Кирпич керамический', color: [0.62, 0.32, 0.22] },
    concrete: { name: 'Бетон', ifc: 'Бетон', color: [0.66, 0.66, 0.64] },
    plaster: { name: 'Штукатурка / окраска', ifc: 'Штукатурка окрашенная', color: [0.9, 0.88, 0.84] },
    glass: { name: 'Стекло (витраж)', ifc: 'Стекло', color: [0.55, 0.72, 0.85], alpha: 0.45 },
    metal: { name: 'Металл', ifc: 'Сталь', color: [0.5, 0.52, 0.55] },
    wood: { name: 'Дерево', ifc: 'Древесина', color: [0.6, 0.45, 0.28] },
    unknown: { name: 'Не определён', ifc: 'Не определён', color: [0.75, 0.75, 0.75] },
    slab: { name: 'Перекрытие', ifc: 'Железобетон', color: [0.72, 0.72, 0.7] },
    column: { name: 'Колонна', ifc: 'Железобетон', color: [0.8, 0.8, 0.78] },
    frame: { name: 'Рама окна', ifc: 'Алюминий', color: [0.85, 0.85, 0.85] },
    mullion: { name: 'Профиль витража (стойка, ригель)', ifc: 'Алюминиевый профиль', color: [0.24, 0.26, 0.3] },
    pane: { name: 'Стеклопакет', ifc: 'Стекло', color: [0.6, 0.78, 0.9], alpha: 0.35 },
    spandrel: { name: 'Глухое остекление (панель)', ifc: 'Стекло непрозрачное', color: [0.74, 0.8, 0.86] },
    door: { name: 'Дверь', ifc: 'Металл / дерево', color: [0.45, 0.3, 0.2] },
    tree: { name: 'Зелень', ifc: 'Растительность', color: [0.25, 0.55, 0.2] },
    trunk: { name: 'Ствол', ifc: 'Древесина', color: [0.4, 0.28, 0.18] },
    crane: { name: 'Кран', ifc: 'Сталь', color: [0.95, 0.75, 0.1] },
    object: { name: 'Объект', ifc: 'Не определён', color: [0.55, 0.6, 0.7] },
    pipe: { name: 'Труба', ifc: 'Сталь', color: [0.55, 0.58, 0.62] },
    pipe_red: { name: 'Труба пожаротушения (красная)', ifc: 'Сталь окрашенная', color: [0.82, 0.16, 0.13] },
    pipe_green: { name: 'Труба (зелёная)', ifc: 'Сталь окрашенная', color: [0.2, 0.6, 0.32] },
    tray: { name: 'Кабельный лоток', ifc: 'Сталь оцинкованная', color: [0.72, 0.74, 0.76] },
    cable: { name: 'Кабель', ifc: 'Медь, ПВХ', color: [0.12, 0.12, 0.14] },
    duct: { name: 'Воздуховод', ifc: 'Сталь оцинкованная', color: [0.8, 0.82, 0.85] },
    beam: { name: 'Балка', ifc: 'Железобетон', color: [0.64, 0.64, 0.6] }
  };
  // ревизия 40: инженерные сети по облаку (scan2bim-mep.js) — вид → тип элемента и материал
  var MEP_TYPE = { pipe: 'pipe', cable: 'cable', tray: 'cabletray', duct: 'duct', beam: 'beam' };
  var MEP_RU = { pipe: 'Труба', cable: 'Кабель', tray: 'Кабельный лоток', duct: 'Воздуховод', beam: 'Балка', fitting: 'Фитинг' };
  // ревизия 41: фитинги (узлы соединения трасс) — тип элемента по виду трассы, название по виду узла
  var FIT_TYPE = { pipe: 'pipefitting', tray: 'cabletrayfitting', duct: 'ductfitting', cable: 'cablefitting' };
  var FIT_RU = { elbow: 'Отвод', tee: 'Тройник', transition: 'Переход' };
  function hostKind(e) { return e.kind === 'fitting' ? (e.host || 'pipe') : e.kind; }
  function mepName(e) {
    if (e.kind === 'fitting') return (FIT_RU[e.type] || 'Узел') + ' ' + ({ pipe: 'трубы', tray: 'лотка', duct: 'воздуховода', cable: 'кабеля' }[e.host] || '');
    if (e.riser) return 'Стояк';
    if (e.kind === 'tray' && e.ladder) return 'Лоток лестничный';
    if (e.kind === 'cable' && e.bundle) return 'Пучок кабелей';
    return MEP_RU[e.kind] || e.kind;
  }
  function mepMat(e) { var k = hostKind(e); return k === 'pipe' ? (e.color === 'red' ? 'pipe_red' : (e.color === 'green' ? 'pipe_green' : 'pipe')) : k; }
  function mepRound(e) { var k = hostKind(e); return k === 'pipe' || k === 'cable'; }
  function mepSize(e) { return mepRound(e) ? Math.max(0.01, e.d || 0.05) : Math.max(0.03, e.w || 0.1); }
  // части по сегментам трассы: трубы и кабели — z по оси (tube — для OBJ и IFC), лотки, короба, балки — от низа на высоту сечения
  // ревизия 41: вертикальные сегменты (стояки, колена отводов) — квадрат вокруг оси на высоту сегмента; фитинги — по своим частям
  function mepParts(e) {
    var round = mepRound(e), w = mepSize(e) * (e.kind === 'fitting' ? 1.15 : 1), hg = round ? w : Math.max(0.03, e.hgt || 0.1), out = [];
    var lines = e.kind === 'fitting' && e.parts && e.parts.length ? e.parts : [e.path || []];
    lines.forEach(function (P) {
      for (var i = 1; i < P.length; i++) {
        var A = P[i - 1], B = P[i], dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2], L = Math.hypot(dx, dy);
        if (Math.abs(dz) > L) {
          if (Math.abs(dz) < 1e-3) continue;
          var h = w / 2, sq = [[A[0] - h, A[1] - h], [A[0] + h, A[1] - h], [A[0] + h, A[1] + h], [A[0] - h, A[1] + h]];
          out.push(round ? { poly: sq, z0: Math.min(A[2], B[2]), z1: Math.max(A[2], B[2]), tube: [A, B], r: w / 2, vertical: true } : { poly: sq, z0: Math.min(A[2], B[2]), z1: Math.max(A[2], B[2]), vertical: true });
          continue;
        }
        if (L < 1e-3) continue;
        var nx = -dy / L * w / 2, ny = dx / L * w / 2, zc = (A[2] + B[2]) / 2;
        var poly = [[A[0] + nx, A[1] + ny], [B[0] + nx, B[1] + ny], [B[0] - nx, B[1] - ny], [A[0] - nx, A[1] - ny]];
        out.push(round ? { poly: poly, z0: zc - w / 2, z1: zc + w / 2, tube: [A, B], r: w / 2 } : { poly: poly, z0: zc, z1: zc + hg });
      }
    });
    return out;
  }
  var OBJ_MAT = { structure: 'metal', tree: 'tree', shrub: 'tree', crane: 'crane', pole: 'metal', fence: 'metal', cabin: 'object', stack: 'object', object: 'object' };

  function num(x, d) { var v = Number(x); return isFinite(v) ? v : d; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  // ---------------------------------------------------------------- геометрия стены: ось, отрезки вдоль оси, точки
  function axisOf(w) {
    if (w.kind === 'line') {
      var dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1], L = Math.hypot(dx, dy) || 1;
      return { kind: 'line', a: w.a, u: [dx / L, dy / L], n: [-dy / L, dx / L], L: L };
    }
    var sg = w.a1 >= w.a0 ? 1 : -1;
    return { kind: 'arc', c: w.c, r: w.r, a0: w.a0, sg: sg, L: Math.abs(w.a1 - w.a0) * w.r };
  }
  // точка оси на длине t со смещением off (по нормали; у дуги — по радиусу наружу)
  function axisPt(A, t, off) {
    if (A.kind === 'line') return [A.a[0] + A.u[0] * t + A.n[0] * off, A.a[1] + A.u[1] * t + A.n[1] * off];
    var ang = A.a0 + A.sg * t / A.r, r = A.r + off; return [A.c[0] + r * Math.cos(ang), A.c[1] + r * Math.sin(ang)];
  }
  // длина вдоль развёртки (s от начала видимой грани) → длина вдоль оси стены
  function refToAxis(w, A, s) {
    var R = w.ref; if (!R) return s;
    if (A.kind === 'line') { var P = [R.a[0] + R.u[0] * s, R.a[1] + R.u[1] * s]; return (P[0] - A.a[0]) * A.u[0] + (P[1] - A.a[1]) * A.u[1]; }
    var ang = R.a0 + s / R.r; var d = (ang - A.a0) * A.sg; return d * A.r;
  }
  // проёмы стены в координатах оси: [{t0,t1,z0,z1,kind,...}]
  function openingsAxis(w) {
    var A = axisOf(w);
    return (w.openings || []).map(function (q) {
      var t0 = refToAxis(w, A, q.s0), t1 = refToAxis(w, A, q.s1); if (t0 > t1) { var x = t0; t0 = t1; t1 = x; }
      return { t0: clamp(t0, 0, A.L), t1: clamp(t1, 0, A.L), z0: q.z0, z1: q.z1, kind: q.kind, width: q.width, height: q.height, sill: q.sill, glazed: q.glazed, grid: q.grid || null };
    }).filter(function (q) { return q.t1 - q.t0 > 0.1 && q.z1 - q.z0 > 0.1; });
  }
  // разрез стены по проёмам: прямоугольники (t0,t1,z0,z1) сплошной части
  function wallPieces(w) {
    var A = axisOf(w), z0 = w.base, z1 = w.base + w.height, ops = openingsAxis(w), cuts = [0, A.L];
    ops.forEach(function (q) { cuts.push(q.t0, q.t1); });
    cuts.sort(function (a, b) { return a - b; });
    var out = [];
    for (var i = 0; i < cuts.length - 1; i++) {
      var a = cuts[i], b = cuts[i + 1]; if (b - a < 1e-4) continue;
      var m = (a + b) / 2, holes = ops.filter(function (q) { return q.t0 <= m && q.t1 >= m; }).sort(function (p, q) { return p.z0 - q.z0; });
      var z = z0;
      holes.forEach(function (q) { var qa = Math.max(z0, q.z0), qb = Math.min(z1, q.z1); if (qa > z + 1e-4) out.push([a, b, z, qa]); z = Math.max(z, qb); });
      if (z1 > z + 1e-4) out.push([a, b, z, z1]);
    }
    return { A: A, pieces: out, ops: ops };
  }
  // контур стены в плане (замкнутый многоугольник) — по оси ± толщина/2
  function wallOutline(w, t0, t1, extra) {
    var A = axisOf(w), h = w.thickness / 2 + (extra || 0); t0 = t0 == null ? 0 : t0; t1 = t1 == null ? A.L : t1;
    var k = A.kind === 'line' ? 1 : Math.max(1, Math.ceil((t1 - t0) / 0.5)), L = [], R = [];
    for (var i = 0; i <= k; i++) { var t = t0 + (t1 - t0) * i / k; L.push(axisPt(A, t, h)); R.push(axisPt(A, t, -h)); }
    return L.concat(R.reverse());
  }

  // ---------------------------------------------------------------- сетка
  function Mesh() { this.v = []; this.f = []; this.groups = []; }
  Mesh.prototype.group = function (name, mat) { this.groups.push({ name: name, mat: mat, start: this.f.length }); };
  Mesh.prototype.vert = function (x, y, z) { this.v.push([x, y, z]); return this.v.length; };
  Mesh.prototype.quad = function (a, b, c, d) { this.f.push([a, b, c, d]); };
  Mesh.prototype.tri = function (a, b, c) { this.f.push([a, b, c]); };
  // призма: контур в плане (против часовой), низ z0, верх z1
  Mesh.prototype.prism = function (poly, z0, z1) {
    if (polyArea(poly) < 0) poly = poly.slice().reverse();
    var n = poly.length, lo = [], hi = [], self = this;
    poly.forEach(function (p) { lo.push(self.vert(p[0], p[1], z0)); hi.push(self.vert(p[0], p[1], z1)); });
    for (var i = 0; i < n; i++) { var j = (i + 1) % n; this.quad(lo[i], lo[j], hi[j], hi[i]); }
    var tris = triangulate(poly);
    tris.forEach(function (t) { self.tri(hi[t[0]], hi[t[1]], hi[t[2]]); self.tri(lo[t[2]], lo[t[1]], lo[t[0]]); });
  };
  function polyArea(P) { var s = 0; for (var i = 0; i < P.length; i++) { var a = P[i], b = P[(i + 1) % P.length]; s += a[0] * b[1] - a[1] * b[0]; } return s / 2; }
  // триангуляция простого многоугольника (уши), против часовой
  function triangulate(P) {
    var n = P.length, idx = [], out = [], i; for (i = 0; i < n; i++) idx.push(i);
    var cross = function (a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); };
    var guard = 0;
    while (idx.length > 3 && guard++ < 10000) {
      var cut = false;
      for (i = 0; i < idx.length; i++) {
        var ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length], a = P[ia], b = P[ib], c = P[ic];
        if (cross(a, b, c) <= 1e-12) continue;
        var inside = false;
        for (var k = 0; k < idx.length && !inside; k++) { var q = idx[k]; if (q === ia || q === ib || q === ic) continue; var p = P[q]; if (cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0) inside = true; }
        if (inside) continue;
        out.push([ia, ib, ic]); idx.splice(i, 1); cut = true; break;
      }
      if (!cut) { for (i = 1; i < idx.length - 1; i++) out.push([idx[0], idx[i], idx[i + 1]]); return out; }
    }
    if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
    return out;
  }
  function circlePoly(c, r, k) { var o = []; k = k || 24; for (var i = 0; i < k; i++) { var a = 2 * Math.PI * i / k; o.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]); } return o; }
  function rectPoly(c, w, d, phi) { var ux = Math.cos(phi || 0), uy = Math.sin(phi || 0), a = w / 2, b = d / 2; return [[-a, -b], [a, -b], [a, b], [-a, b]].map(function (p) { return [c[0] + p[0] * ux - p[1] * uy, c[1] + p[0] * uy + p[1] * ux]; }); }

  // элементы модели как набор призм (общий источник для OBJ, превью и проверок)
  function solids(model, opts) {
    opts = opts || {};
    var out = [], add = function (el) { out.push(el); };
    (model.walls || []).forEach(function (w) {
      var P = wallPieces(w), mat = w.curtain ? 'glass' : (w.material || 'unknown');
      var cg = w.curtain && w.grid && w.grid.members && w.grid.members.length && opts.grid !== false ? gridParts(w, w.grid, true) : null;
      var parts = cg && cg.length ? cg : P.pieces.map(function (pc) { return { poly: wallOutline(w, pc[0], pc[1]), z0: pc[2], z1: pc[3] }; });
      add({ id: w.id, type: w.curtain ? 'curtainwall' : (w.role === 'parapet' ? 'parapet' : (w.role === 'fence' ? 'fence' : 'wall')), storey: w.storey, mat: mat, parts: parts, ref: w });
      P.ops.forEach(function (q, k) {
        var fill = q.kind === 'window' ? 'glass' : 'door', th = q.kind === 'window' ? 0.06 : 0.05;
        var gp = q.grid && opts.grid !== false ? gridParts(w, q.grid, false) : null;
        var poly = wallOutlineThin(w, q.t0, q.t1, th);
        add({ id: w.id + '-O' + (k + 1), type: q.kind, storey: w.storey, mat: fill, parts: gp && gp.length ? gp : [{ poly: poly, z0: q.z0, z1: q.z1 }], ref: q, wall: w.id });
      });
    });
    (model.slabs || []).forEach(function (s) { add({ id: s.id, type: s.kind === 'roof' ? 'roof' : 'slab', storey: s.level, mat: 'slab', parts: [{ poly: s.outline, z0: s.h - s.thickness, z1: s.h }], ref: s }); });
    (model.columns || []).forEach(function (c) {
      var poly = c.shape === 'round' ? circlePoly(c.c, c.d / 2, 24) : rectPoly(c.c, c.w, c.d, c.phi);
      add({ id: c.id, type: 'column', storey: c.storey, mat: 'column', parts: [{ poly: poly, z0: c.base, z1: c.base + c.height }], ref: c });
    });
    (model.objects || []).forEach(function (o, i) {
      var id = 'X' + (i + 1), parts;
      if (o.kind === 'tree') {
        var cr = Math.max(0.6, Math.min(o.w || 2, o.dd || 2) / 2), z = o.base + o.height * 0.35;
        parts = [{ poly: circlePoly(o.c, 0.15, 8), z0: o.base, z1: z, mat: 'trunk' }, { poly: o.outline && o.outline.length >= 3 ? o.outline : circlePoly(o.c, cr, 12), z0: z, z1: o.base + o.height, mat: 'tree' }];
      } else if (o.kind === 'pole' && o.shape === 'round' && o.d) parts = [{ poly: circlePoly(o.c, o.d / 2, 16), z0: o.base, z1: o.base + o.height }];
      else parts = [{ poly: o.outline && o.outline.length >= 3 && o.kind !== 'cabin' ? o.outline : rectPoly(o.c, Math.max(0.1, o.w || 0.3), Math.max(0.1, o.dd || 0.3), o.phi || 0), z0: o.base, z1: o.base + o.height }];
      add({ id: id, type: 'object', kind: o.kind, name: o.name, storey: -1, mat: OBJ_MAT[o.kind] || 'object', parts: parts, ref: o });
    });
    if (opts.mep !== false) (model.mep || []).forEach(function (e) { var parts = mepParts(e); if (parts.length) add({ id: e.id, type: e.kind === 'fitting' ? (FIT_TYPE[e.host] || 'pipefitting') : (MEP_TYPE[e.kind] || 'pipe'), kind: e.kind === 'fitting' ? e.type : e.kind, storey: e.storey, mat: mepMat(e), parts: parts, ref: e }); });
    return out;
  }
  // ревизия 40: членение витража и окна (стойки, ригели, рама, заполнения) — тонкие призмы по оси стены
  // g.members/g.panels: s0–s1 вдоль развёртки, z0–z1 — отметки; профиль витража 0,15 м, рама окна 0,07 м, стекло 0,024 м
  function gridParts(w, g, curtain) {
    var A = axisOf(w), out = [];
    var seg = function (o) { var t0 = refToAxis(w, A, o.s0), t1 = refToAxis(w, A, o.s1); if (t0 > t1) { var x = t0; t0 = t1; t1 = x; } return [clamp(t0, 0, A.L), clamp(t1, 0, A.L)]; };
    (g.panels || []).forEach(function (p) {
      var t = seg(p); if (t[1] - t[0] < 0.02 || p.z1 - p.z0 < 0.02) return;
      var vis = p.kind !== 'spandrel', mat = vis ? 'pane' : (p.mat === 'glass' || !MAT[p.mat] || p.mat === 'unknown' ? 'spandrel' : p.mat);
      out.push({ poly: wallOutlineThin(w, t[0], t[1], vis ? 0.024 : 0.05), z0: p.z0, z1: p.z1, mat: mat, role: vis ? 'panel' : 'spandrel' });
    });
    (g.members || []).forEach(function (m) {
      var t = seg(m); if (t[1] - t[0] < 0.01 || m.z1 - m.z0 < 0.01) return;
      out.push({ poly: wallOutlineThin(w, t[0], t[1], curtain ? 0.15 : 0.07), z0: m.z0, z1: m.z1, mat: curtain ? 'mullion' : 'frame', role: m.dir === 'v' ? (m.frame ? 'frame' : 'mullion') : (m.frame ? 'frame' : 'transom') });
    });
    return out;
  }
  function wallOutlineThin(w, t0, t1, th) { var A = axisOf(w), k = A.kind === 'line' ? 1 : Math.max(1, Math.ceil((t1 - t0) / 0.5)), L = [], R = []; for (var i = 0; i <= k; i++) { var t = t0 + (t1 - t0) * i / k; L.push(axisPt(A, t, th / 2)); R.push(axisPt(A, t, -th / 2)); } return L.concat(R.reverse()); }

  function shift(model, opts) { var o = model.origin || {}; return opts && opts.local ? [0, 0, 0] : [num(o.cx, 0), num(o.cy, 0), num(o.cz, 0)]; }

  // ---------------------------------------------------------------- OBJ + MTL
  // восьмигранная труба между точками A и B (торцы закрыты)
  function tubeMesh(M, A, B, r, k) {
    var d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], L = Math.hypot(d[0], d[1], d[2]) || 1; d = d.map(function (x) { return x / L; });
    var u = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], e1 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]], n1 = Math.hypot(e1[0], e1[1], e1[2]); e1 = e1.map(function (x) { return x / n1; });
    var e2 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]], b = M.v.length + 1;
    [A, B].forEach(function (C) { for (var i = 0; i < k; i++) { var a = 2 * Math.PI * i / k, c = Math.cos(a) * r, s = Math.sin(a) * r; M.v.push([C[0] + e1[0] * c + e2[0] * s, C[1] + e1[1] * c + e2[1] * s, C[2] + e1[2] * c + e2[2] * s]); } });
    for (var i = 0; i < k; i++) { var j = (i + 1) % k; M.f.push([b + i, b + j, b + k + j, b + k + i]); }
    var c0 = [], c1 = []; for (var q = 0; q < k; q++) { c0.push(b + k - 1 - q); c1.push(b + k + q); } M.f.push(c0, c1);
  }
  function toOBJ(model, opts) {
    opts = opts || {};
    var S = solids(model, opts), sh = shift(model, opts), base = opts.mtlName || 'model.mtl';
    var lines = ['# BIM Twin — модель по облаку точек (scan2bim, ревизия 41)', '# единицы: метры; ось Z — вверх', 'mtllib ' + base], vOff = 0, used = {};
    var f6 = function (x) { return (Math.round(x * 1e4) / 1e4).toString(); };
    S.forEach(function (el) {
      lines.push('o ' + el.id + '_' + el.type + (el.kind ? '_' + el.kind : ''));
      el.parts.forEach(function (p) {
        var M = new Mesh(); if (p.tube) tubeMesh(M, p.tube[0], p.tube[1], p.r, 8); else M.prism(p.poly, p.z0, p.z1);
        var mat = p.mat || el.mat; used[mat] = 1;
        lines.push('usemtl ' + mat);
        M.v.forEach(function (v) { lines.push('v ' + f6(v[0] + sh[0]) + ' ' + f6(v[1] + sh[1]) + ' ' + f6(v[2] + sh[2])); });
        M.f.forEach(function (f) { lines.push('f ' + f.map(function (i) { return i + vOff; }).join(' ')); });
        vOff += M.v.length;
      });
    });
    var mtl = ['# BIM Twin — материалы модели по облаку'];
    Object.keys(used).forEach(function (k) {
      var m = MAT[k] || MAT.unknown; mtl.push('newmtl ' + k, 'Kd ' + m.color.map(function (x) { return x.toFixed(3); }).join(' '), 'Ka 0.1 0.1 0.1', 'd ' + (m.alpha != null ? m.alpha : 1), 'illum 2', '');
    });
    return { obj: lines.join('\n') + '\n', mtl: mtl.join('\n') + '\n', vertices: vOff, elements: S.length };
  }

  // ---------------------------------------------------------------- IFC4
  var B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
  function guidGen(seed) {
    var x = 2166136261 >>> 0; String(seed || 'bimtwin').split('').forEach(function (c) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619) >>> 0; });
    var st = [x || 1, (x ^ 0x9e3779b9) >>> 0 || 2, (x * 7 + 13) >>> 0 || 3, (x ^ 0x7f4a7c15) >>> 0 || 4];
    var next = function () { var t = st[3], s = st[0]; st[3] = st[2]; st[2] = st[1]; st[1] = s; t ^= t << 11; t >>>= 0; t ^= t >>> 8; st[0] = (t ^ s ^ (s >>> 19)) >>> 0; return st[0]; };
    return function () { var s = B64[next() & 3]; for (var i = 0; i < 21; i++) s += B64[next() & 63]; return s; };
  }
  // строка STEP: апостроф удваивается, не-ASCII — \X2\hhhh\X0\ (UTF-16)
  function ifcStr(s) {
    if (s == null) return '$';
    s = String(s); var out = '', buf = '';
    var flush = function () { if (buf) { out += '\\X2\\' + buf + '\\X0\\'; buf = ''; } };
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 32 && c < 127) { flush(); var ch = s[i]; out += ch === "'" ? "''" : (ch === '\\' ? '\\\\' : ch); }
      else buf += ('0000' + c.toString(16).toUpperCase()).slice(-4);
    }
    flush(); return "'" + out + "'";
  }
  function fl(x) { x = Number(x); if (!isFinite(x)) x = 0; var s = (Math.round(x * 1e6) / 1e6).toString(); if (s.indexOf('.') < 0 && s.indexOf('e') < 0) s += '.'; return s.replace('e', 'E'); }

  function toIFC(model, opts) {
    opts = opts || {};
    var L = [], id = 0, G = guidGen(opts.seed || (model.bbox ? JSON.stringify(model.bbox) : 'm')), sh = shift(model, opts);
    var E = function (s) { id++; L.push('#' + id + '=' + s + ';'); return '#' + id; };
    var P3 = function (x, y, z) { return E('IFCCARTESIANPOINT((' + fl(x) + ',' + fl(y) + ',' + fl(z) + '))'); };
    var P2 = function (x, y) { return E('IFCCARTESIANPOINT((' + fl(x) + ',' + fl(y) + '))'); };
    var D3 = function (x, y, z) { return E('IFCDIRECTION((' + fl(x) + ',' + fl(y) + ',' + fl(z) + '))'); };
    var name = opts.name || 'Модель по облаку точек', now = Math.floor((opts.time || Date.now()) / 1000);
    var org = E('IFCORGANIZATION($,' + ifcStr('BIM Twin') + ',$,$,$)');
    var person = E('IFCPERSON($,$,' + ifcStr(opts.author || 'BIM Twin') + ',$,$,$,$,$)');
    var po = E('IFCPERSONANDORGANIZATION(' + person + ',' + org + ',$)');
    var app = E('IFCAPPLICATION(' + org + ',' + ifcStr('1.2.0') + ',' + ifcStr('BIM Twin') + ',' + ifcStr('BIMTWIN') + ')');
    var oh = E('IFCOWNERHISTORY(' + po + ',' + app + ',$,.ADDED.,' + now + ',$,$,' + now + ')');
    var origin = P3(0, 0, 0), dz = D3(0, 0, 1), dx = D3(1, 0, 0);
    var ax0 = E('IFCAXIS2PLACEMENT3D(' + origin + ',' + dz + ',' + dx + ')');
    var ctx = E('IFCGEOMETRICREPRESENTATIONCONTEXT($,' + ifcStr('Model') + ',3,1.E-05,' + ax0 + ',$)');
    var body = E('IFCGEOMETRICREPRESENTATIONSUBCONTEXT(' + ifcStr('Body') + ',' + ifcStr('Model') + ',*,*,*,*,' + ctx + ',$,.MODEL_VIEW.,$)');
    var uL = E('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)'), uA = E('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)'), uV = E('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)'), uR = E('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)');
    var units = E('IFCUNITASSIGNMENT((' + [uL, uA, uV, uR].join(',') + '))');
    var proj = E('IFCPROJECT(' + ifcStr(G()) + ',' + oh + ',' + ifcStr(name) + ',' + ifcStr('Построено по облаку точек в BIM Twin') + ',$,$,$,(' + ctx + '),' + units + ')');
    // площадка в координатах облака: смещение (cx, cy, cz) — в размещении площадки
    var siteLp = E('IFCLOCALPLACEMENT($,' + E('IFCAXIS2PLACEMENT3D(' + P3(sh[0], sh[1], sh[2]) + ',' + dz + ',' + dx + ')') + ')');
    var site = E('IFCSITE(' + ifcStr(G()) + ',' + oh + ',' + ifcStr('Площадка') + ',$,$,' + siteLp + ',$,$,.ELEMENT.,$,$,$,$,$)');
    var bldLp = E('IFCLOCALPLACEMENT(' + siteLp + ',' + ax0 + ')');
    var bld = E('IFCBUILDING(' + ifcStr(G()) + ',' + oh + ',' + ifcStr(opts.building || 'Здание') + ',$,$,' + bldLp + ',$,$,.ELEMENT.,$,$,$)');
    E('IFCRELAGGREGATES(' + ifcStr(G()) + ',' + oh + ',$,$,' + proj + ',(' + site + '))');
    E('IFCRELAGGREGATES(' + ifcStr(G()) + ',' + oh + ',$,$,' + site + ',(' + bld + '))');
    var storeys = (model.storeys || []).map(function (s) {
      var lp = E('IFCLOCALPLACEMENT(' + bldLp + ',' + E('IFCAXIS2PLACEMENT3D(' + P3(0, 0, s.h) + ',' + dz + ',' + dx + ')') + ')');
      var st = E('IFCBUILDINGSTOREY(' + ifcStr(G()) + ',' + oh + ',' + ifcStr(s.name) + ',' + ifcStr('Отметка ' + (s.z != null ? s.z.toFixed(3) : s.h.toFixed(3)) + ' м, высота ' + s.height.toFixed(2) + ' м') + ',$,' + lp + ',$,$,.ELEMENT.,' + fl(s.h + sh[2]) + ')');
      return { e: st, lp: lp, h: s.h, items: [] };
    });
    if (storeys.length) E('IFCRELAGGREGATES(' + ifcStr(G()) + ',' + oh + ',$,$,' + bld + ',(' + storeys.map(function (s) { return s.e; }).join(',') + '))');
    var siteItems = [], byMat = {}, styles = {};
    var styleOf = function (k) {
      if (styles[k]) return styles[k];
      var m = MAT[k] || MAT.unknown, col = E('IFCCOLOURRGB($,' + m.color.map(fl).join(',') + ')');
      var sh2 = E('IFCSURFACESTYLESHADING(' + col + ',' + fl(m.alpha != null ? 1 - m.alpha : 0) + ')');
      styles[k] = E('IFCSURFACESTYLE(' + ifcStr(m.name) + ',.BOTH.,(' + sh2 + '))'); return styles[k];
    };
    // экструзия контура (в координатах размещения) от z0 до z1
    var solid = function (poly, z0, z1, matKey) {
      if (polyArea(poly) < 0) poly = poly.slice().reverse();
      var pts = poly.map(function (p) { return P2(p[0], p[1]); }); pts.push(pts[0]);
      var pl = E('IFCPOLYLINE((' + pts.join(',') + '))'), prof = E('IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,' + pl + ')');
      var pos = E('IFCAXIS2PLACEMENT3D(' + P3(0, 0, z0) + ',' + dz + ',' + dx + ')');
      var s = E('IFCEXTRUDEDAREASOLID(' + prof + ',' + pos + ',' + dz + ',' + fl(Math.max(0.001, z1 - z0)) + ')');
      if (matKey) E('IFCSTYLEDITEM(' + s + ',(' + styleOf(matKey) + '),$)');
      return s;
    };
    var shape = function (items, kind) { var r = E('IFCSHAPEREPRESENTATION(' + body + ',' + ifcStr('Body') + ',' + ifcStr(kind || 'SweptSolid') + ',(' + items.join(',') + '))'); return E('IFCPRODUCTDEFINITIONSHAPE($,$,(' + r + '))'); };
    var lpIn = function (rel) { return E('IFCLOCALPLACEMENT(' + rel + ',' + ax0 + ')'); };
    var pset = function (el, nm, props) {
      var ps = [];
      Object.keys(props).forEach(function (k) {
        var v = props[k]; if (v == null || (typeof v === 'number' && !isFinite(v))) return;
        var val = typeof v === 'boolean' ? 'IFCBOOLEAN(' + (v ? '.T.' : '.F.') + ')' : (typeof v === 'number' ? (/_m$/.test(k) ? 'IFCLENGTHMEASURE(' + fl(v) + ')' : 'IFCREAL(' + fl(v) + ')') : 'IFCLABEL(' + ifcStr(v) + ')');
        ps.push(E('IFCPROPERTYSINGLEVALUE(' + ifcStr(k.replace(/_m$/, '')) + ',$,' + val + ',$)'));
      });
      if (!ps.length) return;
      var set = E('IFCPROPERTYSET(' + ifcStr(G()) + ',' + oh + ',' + ifcStr(nm) + ',$,(' + ps.join(',') + '))');
      E('IFCRELDEFINESBYPROPERTIES(' + ifcStr(G()) + ',' + oh + ',$,$,(' + el + '),' + set + ')');
    };
    var addMat = function (k, el) { (byMat[k] = byMat[k] || []).push(el); };
    var cnt = { walls: 0, curtain: 0, openings: 0, windows: 0, doors: 0, slabs: 0, columns: 0, objects: 0, members: 0, plates: 0, pipes: 0, cables: 0, trays: 0, ducts: 0, beams: 0 };
    var stOf = function (i) { return storeys[clamp(i | 0, 0, storeys.length - 1)]; };
    (model.walls || []).forEach(function (w) {
      var S = stOf(w.storey); if (!S) return;
      var siteWall = w.role === 'fence' || w.role === 'site', relLp = siteWall ? bldLp : S.lp, dzH = siteWall ? 0 : S.h;
      var lp = lpIn(relLp), matKey = w.curtain ? 'glass' : (w.material || 'unknown');
      var cgp = w.curtain && w.grid && w.grid.members && w.grid.members.length && opts.grid !== false ? gridParts(w, w.grid, true) : null;
      if (cgp && !cgp.length) cgp = null;
      var sol = cgp ? null : solid(wallOutline(w), w.base - dzH, w.base + w.height - dzH, matKey);
      var m = MAT[matKey] || MAT.unknown, nm = (w.curtain ? 'Витраж ' : (w.role === 'parapet' ? 'Парапет ' : (w.role === 'fence' ? 'Ограждение ' : 'Стена '))) + w.id;
      var desc = m.name + ', толщина ' + (w.thickness * 1000).toFixed(0) + ' мм' + (w.thicknessMeasured ? ' (измерена)' : ' (по материалу)') + ', высота ' + w.height.toFixed(2) + ' м';
      var el;
      if (w.role === 'fence') el = E('IFCRAILING(' + ifcStr(G()) + ',' + oh + ',' + ifcStr(nm) + ',' + ifcStr(desc) + ',$,' + lp + ',' + shape([sol]) + ',$,.USERDEFINED.)');
      else if (w.curtain && cgp) {
        // ревизия 40: витраж — сборка: стойки и ригели (IfcMember .MULLION.), заполнения (IfcPlate .CURTAIN_PANEL.)
        var nMul = cgp.filter(function (p) { return p.mat === 'mullion'; }).length, nPan = cgp.length - nMul;
        el = E('IFCCURTAINWALL(' + ifcStr(G()) + ',' + oh + ',' + ifcStr(nm) + ',' + ifcStr(desc + ', профилей ' + nMul + ', заполнений ' + nPan) + ',$,' + lp + ',$,$,.NOTDEFINED.)'); cnt.curtain++;
        var kids = [], km = 0, kp = 0;
        cgp.forEach(function (p) {
          var clp = E('IFCLOCALPLACEMENT(' + lp + ',' + ax0 + ')'), rep = shape([solid(p.poly, p.z0 - dzH, p.z1 - dzH, p.mat)]), ch;
          if (p.mat === 'mullion') { km++; ch = E('IFCMEMBER(' + ifcStr(G()) + ',' + oh + ',' + ifcStr((p.role === 'transom' ? 'Ригель ' : 'Стойка ') + w.id + '.' + km) + ',$,$,' + clp + ',' + rep + ',$,.MULLION.)'); addMat('mullion', ch); cnt.members++; }
          else { kp++; ch = E('IFCPLATE(' + ifcStr(G()) + ',' + oh + ',' + ifcStr((p.role === 'panel' ? 'Стеклопакет ' : 'Глухая панель ') + w.id + '.' + kp) + ',$,$,' + clp + ',' + rep + ',$,.CURTAIN_PANEL.)'); addMat(p.mat, ch); cnt.plates++; }
          kids.push(ch);
        });
        E('IFCRELAGGREGATES(' + ifcStr(G()) + ',' + oh + ',$,$,' + el + ',(' + kids.join(',') + '))');
      }
      else if (w.curtain) { el = E('IFCCURTAINWALL(' + ifcStr(G()) + ',' + oh + ',' + ifcStr(nm) + ',' + ifcStr(desc) + ',$,' + lp + ',' + shape([sol]) + ',$,.NOTDEFINED.)'); cnt.curtain++; }
      else { el = E('IFCWALL(' + ifcStr(G()) + ',' + oh + ',' + ifcStr(nm) + ',' + ifcStr(desc) + ',$,' + lp + ',' + shape([sol]) + ',$,' + (w.role === 'parapet' ? '.PARAPET.' : '.SOLIDWALL.') + ')'); cnt.walls++; }
      (siteWall ? siteItems : S.items).push(el); addMat(matKey, el);
      pset(el, 'Pset_WallCommon', { IsExternal: !siteWall && w.sides === 1, LoadBearing: w.thickness >= 0.2 && !w.curtain });
      pset(el, 'BIMTwin_ПоОблаку', { 'Материал': m.name, 'Достоверность материала': Math.round((w.materialConf || 0) * 100) / 100, 'Толщина_m': w.thickness, 'Толщина измерена': !!w.thicknessMeasured,
        'Длина_m': w.length, 'Высота_m': w.height, 'Неровность СКО_m': w.rms, 'Отклонение от вертикали, мм на м': isFinite(w.plumb) ? Math.round(w.plumb * 1e4) / 10 : null, 'Покрытие точками': w.coverage != null ? Math.round(w.coverage * 100) / 100 : null, 'Видимых граней': w.sides });
      openingsAxis(w).forEach(function (q, k) {
        if (w.curtain) return;
        var poly = wallOutline(w, q.t0, q.t1, 0.05), olp = E('IFCLOCALPLACEMENT(' + lp + ',' + ax0 + ')');
        var op = E('IFCOPENINGELEMENT(' + ifcStr(G()) + ',' + oh + ',' + ifcStr('Проём ' + w.id + '.' + (k + 1)) + ',$,$,' + olp + ',' + shape([solid(poly, q.z0 - dzH, q.z1 - dzH)]) + ',$,.OPENING.)');
        E('IFCRELVOIDSELEMENT(' + ifcStr(G()) + ',' + oh + ',$,$,' + el + ',' + op + ')'); cnt.openings++;
        var flp = E('IFCLOCALPLACEMENT(' + olp + ',' + ax0 + ')'), fpoly = wallOutlineThin(w, q.t0, q.t1, q.kind === 'window' ? 0.06 : 0.05);
        var gq = q.grid && opts.grid !== false ? gridParts(w, q.grid, false) : null;
        // ревизия 40: окно (остеклённая дверь) с найденным членением — рама, импосты и стеклопакеты отдельными телами
        var fsol = gq && gq.length ? gq.map(function (p) { return solid(p.poly, p.z0 - dzH, p.z1 - dzH, p.mat); }) : [solid(fpoly, q.z0 - dzH, q.z1 - dzH, q.kind === 'window' ? 'glass' : 'door')], fill;
        var fnm = (q.kind === 'window' ? 'Окно ' : (q.kind === 'gate' ? 'Ворота ' : 'Дверь ')) + w.id + '.' + (k + 1);
        var fdesc = (q.t1 - q.t0).toFixed(2) + ' × ' + (q.z1 - q.z0).toFixed(2) + ' м' + (q.kind === 'window' ? ', подоконник ' + (q.sill || 0).toFixed(2) + ' м' : '');
        if (q.kind === 'window') { fill = E('IFCWINDOW(' + ifcStr(G()) + ',' + oh + ',' + ifcStr(fnm) + ',' + ifcStr(fdesc) + ',$,' + flp + ',' + shape(fsol) + ',$,' + fl(q.z1 - q.z0) + ',' + fl(q.t1 - q.t0) + ',.WINDOW.,.NOTDEFINED.,$)'); cnt.windows++; addMat('glass', fill); }
        else { fill = E('IFCDOOR(' + ifcStr(G()) + ',' + oh + ',' + ifcStr(fnm) + ',' + ifcStr(fdesc) + ',$,' + flp + ',' + shape(fsol) + ',$,' + fl(q.z1 - q.z0) + ',' + fl(q.t1 - q.t0) + ',' + (q.kind === 'gate' ? '.GATE.' : '.DOOR.') + ',.NOTDEFINED.,$)'); cnt.doors++; addMat('door', fill); }
        E('IFCRELFILLSELEMENT(' + ifcStr(G()) + ',' + oh + ',$,$,' + op + ',' + fill + ')');
        (siteWall ? siteItems : S.items).push(fill);
        pset(fill, 'BIMTwin_ПоОблаку', { 'Ширина_m': q.t1 - q.t0, 'Высота_m': q.z1 - q.z0, 'Подоконник_m': q.sill, 'Остеклено (доля точек)': q.glazed != null ? Math.round(q.glazed * 100) / 100 : null,
          'Импостов': gq ? gq.filter(function (p) { return p.role === 'mullion'; }).length : null, 'Горбыльков': gq ? gq.filter(function (p) { return p.role === 'transom'; }).length : null, 'Стеклопакетов': gq ? gq.filter(function (p) { return p.role === 'panel'; }).length : null });
      });
    });
    (model.slabs || []).forEach(function (s) {
      var S = s.level >= storeys.length ? stOf(storeys.length - 1) : stOf(s.level); if (!S) return;
      var lp = lpIn(S.lp), sol = solid(s.outline, s.h - s.thickness - S.h, s.h - S.h, 'slab');
      var el = E('IFCSLAB(' + ifcStr(G()) + ',' + oh + ',' + ifcStr((s.kind === 'roof' ? 'Покрытие ' : 'Перекрытие ') + s.id) + ',' + ifcStr('Площадь ' + s.area.toFixed(1) + ' м², контур по стенам (выпуклая оболочка), толщина по умолчанию') + ',$,' + lp + ',' + shape([sol]) + ',$,' + (s.kind === 'roof' ? '.ROOF.' : '.FLOOR.') + ')');
      S.items.push(el); addMat('slab', el); cnt.slabs++;
      pset(el, 'BIMTwin_ПоОблаку', { 'Площадь контура': s.area, 'Толщина_m': s.thickness, 'Контур': 'выпуклая оболочка стен' });
    });
    (model.columns || []).forEach(function (c) {
      var S = stOf(c.storey); if (!S) return;
      var lp = lpIn(S.lp), poly = c.shape === 'round' ? circlePoly(c.c, c.d / 2, 32) : rectPoly(c.c, c.w, c.d, c.phi);
      var el = E('IFCCOLUMN(' + ifcStr(G()) + ',' + oh + ',' + ifcStr('Колонна ' + c.id) + ',' + ifcStr(c.shape === 'round' ? 'Круглая, Ø ' + (c.d * 1000).toFixed(0) + ' мм' : 'Прямоугольная ' + (c.w * 1000).toFixed(0) + '×' + (c.d * 1000).toFixed(0) + ' мм') + ',$,' + lp + ',' + shape([solid(poly, c.base - S.h, c.base + c.height - S.h, 'column')]) + ',$,.COLUMN.)');
      S.items.push(el); addMat('column', el); cnt.columns++;
      pset(el, 'BIMTwin_ПоОблаку', { 'Сечение': c.shape === 'round' ? 'круг' : 'прямоугольник', 'Отклонение точек СКО_m': c.rms, 'Охват дуги, град': c.span, 'Точек': c.points });
    });
    (model.objects || []).forEach(function (o, i) {
      var parts = solids({ objects: [o] })[0].parts, lp = lpIn(bldLp);
      var items = parts.map(function (p) { return solid(p.poly, p.z0, p.z1, p.mat || OBJ_MAT[o.kind] || 'object'); });
      var nm = (o.name || 'Объект') + ' X' + (i + 1), desc = 'Габариты ' + (o.w || 0).toFixed(2) + ' × ' + (o.dd || o.w || 0).toFixed(2) + ' × ' + o.height.toFixed(2) + ' м';
      var el = o.kind === 'tree' || o.kind === 'shrub'
        ? E('IFCGEOGRAPHICELEMENT(' + ifcStr(G()) + ',' + oh + ',' + ifcStr(nm) + ',' + ifcStr(desc) + ',' + ifcStr(o.name) + ',' + lp + ',' + shape(items) + ',$,.USERDEFINED.)')
        : E('IFCBUILDINGELEMENTPROXY(' + ifcStr(G()) + ',' + oh + ',' + ifcStr(nm) + ',' + ifcStr(desc) + ',' + ifcStr(o.name) + ',' + lp + ',' + shape(items) + ',$,.USERDEFINED.)');
      siteItems.push(el); addMat(OBJ_MAT[o.kind] || 'object', el); cnt.objects++;
    });
    // ревизия 40: инженерные сети — трубы и кабели телом IfcSweptDiskSolid по трёхмерной полилинии оси,
    // лотки, воздуховоды и балки — экструзии сечения по сегментам; элементы этажа, свойства BIMTwin_Сети
    var mepIfc = {};
    if (opts.mep !== false) (model.mep || []).forEach(function (e) {
      var S = stOf(e.storey); if (!S || !e.path || e.path.length < 2) return;
      var lp = lpIn(S.lp), round = mepRound(e), mk = mepMat(e), rep, fitg = e.kind === 'fitting';
      var lines = fitg && e.parts && e.parts.length ? e.parts : [e.path];
      if (round) {
        // ревизия 41: фитинг — диск по каждой ветви узла (радиус на 15 % больше трубы — муфта, раструб)
        var sds = lines.filter(function (P) { return P.length >= 2; }).map(function (P) {
          var dl = E('IFCPOLYLINE((' + P.map(function (p) { return P3(p[0], p[1], p[2] - S.h); }).join(',') + '))');
          var sd = E('IFCSWEPTDISKSOLID(' + dl + ',' + fl(mepSize(e) / 2 * (fitg ? 1.15 : 1)) + ',$,$,$)'); E('IFCSTYLEDITEM(' + sd + ',(' + styleOf(mk) + '),$)'); return sd;
        });
        if (!sds.length) return;
        rep = shape(sds, 'AdvancedSweptSolid');
      } else { var pp = mepParts(e); if (!pp.length) return; rep = shape(pp.map(function (p) { return solid(p.poly, p.z0 - S.h, p.z1 - S.h, mk); })); }
      var size = round ? 'Ø ' + (mepSize(e) * 1000).toFixed(0) + ' мм' + (e.dn ? ' (DN ' + e.dn + ')' : '') : ((e.w || 0) * 1000).toFixed(0) + '×' + ((e.hgt || 0) * 1000).toFixed(0) + ' мм';
      var nm = mepName(e) + ' ' + e.id, ds = fitg ? size + (e.angle ? ', угол ' + e.angle + '°' : '') + (e.links && e.links.length ? ', соединяет ' + e.links.join(' и ') : '') + ', центр над полом ' + (e.base || 0).toFixed(2) + ' м'
        : size + ', длина ' + (e.length || 0).toFixed(2) + ' м, ' + (e.riser ? 'от ' + ((e.path[0][2] - S.h)).toFixed(2) + ' до ' + ((e.path[e.path.length - 1][2] - S.h)).toFixed(2) + ' м над полом' : 'низ над полом ' + ((e.base || 0) - (round ? mepSize(e) / 2 : 0)).toFixed(2) + ' м'), el;
      var head = ifcStr(G()) + ',' + oh + ',' + ifcStr(nm) + ',' + ifcStr(ds) + ',$,' + lp + ',' + rep + ',$,';
      if (fitg) {
        var ft = e.type === 'elbow' ? '.BEND.' : (e.type === 'tee' ? '.JUNCTION.' : '.TRANSITION.');
        if (e.host === 'tray') el = E('IFCCABLECARRIERFITTING(' + head + (e.type === 'elbow' ? '.BEND.' : (e.type === 'tee' ? '.TEE.' : '.REDUCER.')) + ')');
        else if (e.host === 'duct') el = E('IFCDUCTFITTING(' + head + ft + ')');
        else if (e.host === 'cable') el = E('IFCCABLEFITTING(' + head + (e.type === 'tee' ? '.JUNCTION.' : '.CONNECTOR.') + ')');
        else el = E('IFCPIPEFITTING(' + head + ft + ')');
        cnt.fittings = (cnt.fittings || 0) + 1;
      } else if (e.kind === 'pipe') { el = E('IFCPIPESEGMENT(' + head + '.RIGIDSEGMENT.)'); cnt.pipes++; }
      else if (e.kind === 'cable') { el = E('IFCCABLESEGMENT(' + head + '.CABLESEGMENT.)'); cnt.cables++; }
      else if (e.kind === 'tray') { el = E('IFCCABLECARRIERSEGMENT(' + head + '.CABLETRAYSEGMENT.)'); cnt.trays++; }
      else if (e.kind === 'duct') { el = E('IFCDUCTSEGMENT(' + head + '.RIGIDSEGMENT.)'); cnt.ducts++; }
      else { el = E('IFCBEAM(' + head + '.BEAM.)'); cnt.beams++; }
      S.items.push(el); addMat(mk, el); mepIfc[e.id] = el;
      pset(el, 'BIMTwin_Сети', { 'Вид': mepName(e), 'Диаметр_m': round ? mepSize(e) : null, 'Условный проход DN': e.dn || null, 'Ширина_m': round ? null : e.w, 'Высота сечения_m': round ? null : e.hgt,
        'Длина_m': fitg ? null : e.length, 'Ось над полом_m': e.base, 'Цвет по облаку': e.color === 'red' ? 'красный' : (e.color === 'green' ? 'зелёный' : (e.color === 'gray' ? 'серый' : null)), 'Сечений облака': fitg ? null : e.hits, 'СКО окружности_m': e.rms,
        'Стояк': e.riser ? true : null, 'Лестничный лоток': e.ladder ? true : null, 'Пучок кабелей': e.bundle ? true : null, 'Под перекрытием, доля': e.cover != null ? e.cover : null,
        'Узел': fitg ? FIT_RU[e.type] : null, 'Угол поворота_deg': fitg && e.angle ? e.angle : null, 'Соединяет': fitg && e.links ? e.links.join(', ') : null });
    });
    // ревизия 41: связи узлов с трассами — IfcRelConnectsElements (фитинг — трасса)
    if (opts.mep !== false) (model.mep || []).forEach(function (e) {
      if (e.kind !== 'fitting' || !mepIfc[e.id]) return;
      (e.links || []).forEach(function (id) { if (mepIfc[id]) E('IFCRELCONNECTSELEMENTS(' + ifcStr(G()) + ',' + oh + ',$,$,$,' + mepIfc[e.id] + ',' + mepIfc[id] + ')'); });
    });
    storeys.forEach(function (S) { if (S.items.length) E('IFCRELCONTAINEDINSPATIALSTRUCTURE(' + ifcStr(G()) + ',' + oh + ',$,$,(' + S.items.join(',') + '),' + S.e + ')'); });
    if (siteItems.length) E('IFCRELCONTAINEDINSPATIALSTRUCTURE(' + ifcStr(G()) + ',' + oh + ',$,$,(' + siteItems.join(',') + '),' + site + ')');
    Object.keys(byMat).forEach(function (k) { var m = MAT[k] || MAT.unknown, me = E('IFCMATERIAL(' + ifcStr(m.ifc) + ',$,' + ifcStr(m.name) + ')'); E('IFCRELASSOCIATESMATERIAL(' + ifcStr(G()) + ',' + oh + ',$,$,(' + byMat[k].join(',') + '),' + me + ')'); });
    var date = new Date(opts.time || Date.now()).toISOString().slice(0, 19);
    var head = ['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
      'FILE_NAME(' + ifcStr(opts.fileName || 'model.ifc') + ",'" + date + "',(" + ifcStr('BIM Twin') + '),(' + ifcStr('BIM Twin') + "),'BIM Twin scan2bim','BIM Twin 1.2.0','');",
      "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;'];
    return { text: head.concat(L, ['ENDSEC;', 'END-ISO-10303-21;']).join('\n') + '\n', counts: cnt, entities: id };
  }

  // ---------------------------------------------------------------- DXF: планы этажей
  function toDXF(model, opts) {
    opts = opts || {};
    var sh = shift(model, opts), ents = [], P = function (p, z) { return [p[0] + sh[0], p[1] + sh[1], (z || 0)]; };
    var pl = function (poly, layer, color, z) { ents.push({ type: 'polyline', layer: layer, color: color, closed: true, points: poly.map(function (p) { return P(p, z); }) }); };
    (model.storeys || []).forEach(function (s, i) {
      var pre = 'S2B_' + String(i + 1).padStart(2, '0') + '_', z = s.h + sh[2];
      (model.walls || []).forEach(function (w) {
        if (w.storey !== i) return;
        var lay = pre + (w.curtain ? 'VITRAZH' : (w.role === 'wall' ? 'STENY' : (w.role === 'parapet' ? 'PARAPETY' : 'PLOSHADKA')));
        pl(wallOutline(w), lay, w.curtain ? 4 : (w.role === 'wall' ? 7 : 8), z);
        openingsAxis(w).forEach(function (q) { if (!w.curtain) pl(wallOutline(w, q.t0, q.t1, 0.02), pre + (q.kind === 'window' ? 'OKNA' : 'DVERI'), q.kind === 'window' ? 5 : 1, z); });
      });
      (model.columns || []).forEach(function (c) { if (c.storey !== i) return; if (c.shape === 'round') ents.push({ type: 'circle', layer: pre + 'KOLONNY', color: 3, c: P(c.c, z), r: c.d / 2 }); else pl(rectPoly(c.c, c.w, c.d, c.phi), pre + 'KOLONNY', 3, z); });
      (model.slabs || []).forEach(function (sl) { if (sl.level === i) pl(sl.outline, pre + 'PEREKRYTIE', 9, z); });
      if (opts.mep !== false) (model.mep || []).forEach(function (e) {
        if (e.storey !== i || !e.path || e.path.length < 2) return;
        var lay = pre + 'SETI_' + (e.kind === 'fitting' ? 'FITINGI' : (e.riser ? 'STOYAKI' : ({ pipe: 'TRUBY', cable: 'KABELI', tray: 'LOTKI', duct: 'VOZDUHOVODY', beam: 'BALKI' }[e.kind] || 'PROCHEE')));
        var hk = hostKind(e), col = hk === 'pipe' ? (e.color === 'red' ? 1 : 4) : (hk === 'tray' ? 8 : (hk === 'cable' ? 6 : (hk === 'duct' ? 5 : 9)));
        (e.kind === 'fitting' && e.parts ? e.parts : [e.path]).forEach(function (P) { if (P.length >= 2) ents.push({ type: 'polyline', layer: lay, color: col, closed: false, points: P.map(function (p) { return [p[0] + sh[0], p[1] + sh[1], p[2] + sh[2]]; }) }); });
        if (e.riser) ents.push({ type: 'circle', layer: lay, color: col, c: P([e.path[0][0], e.path[0][1]], z), r: mepSize(e) / 2 });
      });
      ents.push({ type: 'text', layer: pre + 'PODPISI', color: 2, p: P([model.bbox ? model.bbox.u0 : 0, model.bbox ? model.bbox.v1 + 1 : 0], z), h: 0.8, text: 'ETAZH ' + (i + 1) + '  Z=' + z.toFixed(3) });
    });
    (model.objects || []).forEach(function (o) { var poly = o.outline && o.outline.length >= 3 ? o.outline : rectPoly(o.c, o.w || 0.3, o.dd || 0.3, o.phi || 0); pl(poly, 'S2B_OBJEKTY_' + String(o.kind || 'object').toUpperCase(), o.kind === 'tree' ? 3 : 6, (o.base || 0) + sh[2]); });
    return DXF.toDxf(ents);
  }

  // ---------------------------------------------------------------- отчёт
  var KIND_RU = { window: 'окно', door: 'дверь', gate: 'ворота' };
  function summary(model) {
    var s = model.stats || {}, lines = [];
    lines.push('Модель по облаку точек: этажей ' + s.storeys + ', стен ' + s.walls + ' (из них витражей ' + s.curtainWalls + '), общая длина стен ' + (s.wallLength || 0).toFixed(1) + ' м');
    if (s.mullions || s.glassPanels) lines.push('Членение окон и витражей: импостов, стоек и ригелей ' + (s.mullions || 0) + ', стеклопакетов ' + (s.glassPanels || 0));
    if (s.mep) lines.push('Инженерные сети: труб ' + (s.pipes || 0) + ' (' + (s.pipeLength || 0).toFixed(1) + ' м), кабельных лотков ' + (s.trays || 0) + ' (' + (s.trayLength || 0).toFixed(1) + ' м), кабелей ' + (s.cables || 0) + ' (' + (s.cableLength || 0).toFixed(1) + ' м), воздуховодов ' + (s.ducts || 0) + ', балок ' + (s.beams || 0));
    if (s.risers || s.fittings || s.ladderTrays || s.bundles) lines.push('Стояков ' + (s.risers || 0) + ' (' + (s.riserLength || 0).toFixed(1) + ' м); узлов соединения ' + (s.fittings || 0) + ' (отводов ' + (s.elbows || 0) + ', тройников ' + (s.tees || 0) + ', переходов ' + (s.transitions || 0) + '); лестничных лотков ' + (s.ladderTrays || 0) + ', пучков кабелей ' + (s.bundles || 0));
    lines.push('Проёмы: окон ' + s.windows + ', дверей ' + s.doors + ', ворот ' + s.gates + '; колонн ' + s.columns + '; перекрытий и покрытий ' + s.slabs + '; объектов площадки ' + s.objects + (s.siteWalls ? ', ограждений и сооружений ' + s.siteWalls : ''));
    (model.storeys || []).forEach(function (st) { lines.push('  ' + st.name + ': отметка ' + (st.z != null ? st.z : st.h).toFixed(3) + ' м, высота ' + st.height.toFixed(2) + ' м, стен ' + st.walls); });
    var mats = {}; (model.walls || []).forEach(function (w) { if (w.role !== 'wall') return; var k = w.curtain ? 'glass' : w.material; mats[k] = (mats[k] || 0) + w.length; });
    lines.push('Материалы стен (по длине): ' + Object.keys(mats).sort(function (a, b) { return mats[b] - mats[a]; }).map(function (k) { return (MAT[k] || MAT.unknown).name + ' ' + mats[k].toFixed(0) + ' м'; }).join(', '));
    var rms = (model.walls || []).filter(function (w) { return w.role === 'wall' && isFinite(w.rms); }).map(function (w) { return w.rms; }).sort(function (a, b) { return a - b; });
    if (rms.length) lines.push('Неровность стен по облаку (СКО): медиана ' + (rms[rms.length >> 1] * 1000).toFixed(1) + ' мм');
    (model.warnings || []).forEach(function (w) { lines.push('Внимание: ' + w); });
    return lines.join('\n');
  }
  function report(model) {
    var r = { format: 'bimtwin-scan2bim-report', version: 1, stats: model.stats, storeys: model.storeys, origin: model.origin, warnings: model.warnings, times: model.times,
      walls: (model.walls || []).map(function (w) { return { id: w.id, storey: w.storey + 1, role: w.role, kind: w.kind, length: +w.length.toFixed(3), thickness: +w.thickness.toFixed(3), thicknessMeasured: w.thicknessMeasured, height: +w.height.toFixed(3), material: (MAT[w.curtain ? 'glass' : w.material] || MAT.unknown).name, materialConf: +(w.materialConf || 0).toFixed(2), rms_mm: isFinite(w.rms) ? +(w.rms * 1000).toFixed(1) : null, plumb_mm_per_m: isFinite(w.plumb) ? +(w.plumb * 1000).toFixed(2) : null,
        openings: (w.openings || []).map(function (q) { return { kind: KIND_RU[q.kind] || q.kind, width: +q.width.toFixed(2), height: +q.height.toFixed(2), sill: +(q.sill || 0).toFixed(2), mullions: q.grid ? q.grid.members.filter(function (m) { return !m.frame; }).length : undefined, panes: q.grid ? q.grid.panels.length : undefined }; }),
        grid: w.grid ? { members: w.grid.members.filter(function (m) { return !m.frame; }).length, panels: w.grid.panels.length, vision: w.grid.panels.filter(function (p) { return p.kind === 'vision'; }).length } : undefined }; }),
      columns: (model.columns || []).map(function (c) { return { id: c.id, storey: c.storey + 1, shape: c.shape, d: c.d, w: c.w, depth: c.shape === 'rect' ? c.d : undefined, x: c.c[0], y: c.c[1], rms_mm: +(c.rms * 1000).toFixed(1) }; }),
      objects: (model.objects || []).map(function (o) { return { kind: o.kind, name: o.name, x: +o.c[0].toFixed(2), y: +o.c[1].toFixed(2), w: +(o.w || 0).toFixed(2), d: +(o.dd || 0).toFixed(2), height: +o.height.toFixed(2) }; }),
      mep: (model.mep || []).map(function (e) { return { id: e.id, kind: mepName(e), storey: e.storey + 1, d: e.d, dn: e.dn, w: e.w, hgt: e.hgt, length: e.length, base: e.base, color: e.color, path: e.path, riser: e.riser || undefined, ladder: e.ladder || undefined, bundle: e.bundle || undefined, cover: e.cover, type: e.type, angle: e.angle, links: e.links }; }),
      summary: summary(model) };
    return JSON.stringify(r, null, 1);
  }

  var api = { mepParts: mepParts, MEP_RU: MEP_RU, FIT_RU: FIT_RU, mepName: mepName, toIFC: toIFC, toOBJ: toOBJ, toDXF: toDXF, report: report, summary: summary, solids: solids, wallPieces: wallPieces, wallOutline: wallOutline, openingsAxis: openingsAxis, axisOf: axisOf, axisPt: axisPt, triangulate: triangulate, ifcStr: ifcStr, Mesh: Mesh, MAT: MAT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scan2BimExport = api;
})(typeof window !== 'undefined' ? window : this);
