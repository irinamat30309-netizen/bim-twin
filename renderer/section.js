/*
 * section.js — Спринт 3 (v1088): сечение облака точек → контурные полилинии (план).
 * Мост «облако → план этажа → чертёж/DXF»: берём горизонтальную плиту,
 * строим сетку занятости, трассируем границы и упрощаем (Ramer–Douglas–Peucker).
 * Оси согласованы с lixel-draw: 'y'(верх)→(x,z)=top, 'z'→(x,y)=front, 'x'→(z,y)=side.
 * Чистые функции + window.Section (+ module.exports для тестов).
 */
(function () {
  'use strict';

  // проекция точки в плоскость сечения
  function projAxis(p, axis) {
    if (axis === 'z') return [p[0], p[1]];
    if (axis === 'x') return [p[2], p[1]];
    return [p[0], p[2]]; // 'y' — верх, план этажа
  }
  function axisComp(p, axis) {
    if (axis === 'z') return p[2];
    if (axis === 'x') return p[0];
    return p[1];
  }

  // Progress callback contract shared with the optional renderer Worker.
  // Callback errors are isolated from geometry generation.
  function emitProgress(callback, phase, completed, total) {
    if (typeof callback !== 'function') return;
    var fraction = total > 0 ? Math.max(0, Math.min(1, completed / total)) : 1;
    try { callback({ phase: phase, completed: completed, total: total, fraction: fraction }); } catch (e) {}
  }

  function isFlatPointBuffer(points) {
    return points instanceof Float32Array || points instanceof Float64Array;
  }
  function point2dCount(points) {
    if (!points) return 0;
    if (isFlatPointBuffer(points)) {
      if (points.length % 2) throw new RangeError('Некорректный плоский массив координат');
      return points.length / 2;
    }
    return points.length;
  }

  // Срез плиты: точки в пределах level ± thickness/2, спроецированные в плоскость.
  // pos: массив/Float32Array [x,y,z,...] длиной count*3
  function sliceSlab(pos, count, opts) {
    opts = opts || {};
    var axis = opts.axis || 'y';
    var level = opts.level != null ? opts.level : 0;
    var thickness = opts.thickness != null ? opts.thickness : 0.1;
    var half = thickness / 2;
    if (!pos || !Number.isSafeInteger(count) || count < 0 || count * 3 > pos.length) throw new RangeError('Некорректное число точек');
    if (!['x','y','z'].includes(axis) || !Number.isFinite(level) || !(thickness > 0) || !Number.isFinite(thickness)) throw new RangeError('Некорректные параметры сечения');
    var pts = [], idx = [];
    var progressEvery = Math.max(1, Math.floor(count / 80));
    emitProgress(opts.onProgress, 'slice', 0, count);
    for (var i = 0; i < count; i++) {
      var x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if ([x,y,z].every(Number.isFinite)) {
        var c = axis === 'z' ? z : (axis === 'x' ? x : y);
        if (c >= level - half && c <= level + half) {
          pts.push(projAxis([x, y, z], axis));
          idx.push(i);
        }
      }
      if ((i + 1) % progressEvery === 0 || i + 1 === count) emitProgress(opts.onProgress, 'slice', i + 1, count);
    }
    if (!count) emitProgress(opts.onProgress, 'slice', 0, 0);
    return { pts: pts, indices: idx, axis: axis, level: level, thickness: thickness };
  }

  // Worker path: compact interleaved coordinates avoid millions of short-lived
  // two-element arrays and discard unused source indices before rasterization.
  function sliceSlabCompact(pos, count, opts) {
    opts = opts || {};
    var axis = opts.axis || 'y';
    var level = opts.level != null ? opts.level : 0;
    var thickness = opts.thickness != null ? opts.thickness : 0.1;
    var half = thickness / 2;
    if (!pos || !Number.isSafeInteger(count) || count < 0 || count * 3 > pos.length) throw new RangeError('Некорректное число точек');
    if (!['x','y','z'].includes(axis) || !Number.isFinite(level) || !(thickness > 0) || !Number.isFinite(thickness)) throw new RangeError('Некорректные параметры сечения');
    var CoordArray = pos instanceof Float32Array ? Float32Array : Float64Array;
    var coords = new CoordArray(count * 2), used = 0;
    var progressEvery = Math.max(1, Math.floor(count / 80));
    emitProgress(opts.onProgress, 'slice', 0, count);
    for (var i = 0; i < count; i++) {
      var x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        var c = axis === 'z' ? z : (axis === 'x' ? x : y);
        if (c >= level - half && c <= level + half) {
          coords[used++] = axis === 'x' ? z : x;
          coords[used++] = axis === 'y' ? z : y;
        }
      }
      if ((i + 1) % progressEvery === 0 || i + 1 === count) emitProgress(opts.onProgress, 'slice', i + 1, count);
    }
    if (!count) emitProgress(opts.onProgress, 'slice', 0, 0);
    return { pts: coords.subarray(0, used), count: used / 2, axis: axis, level: level, thickness: thickness };
  }

  function bbox2d(pts, onProgress) {
    var count = point2dCount(pts);
    if (!count) return null;
    var mnu = Infinity, mnv = Infinity, mxu = -Infinity, mxv = -Infinity;
    var flat = isFlatPointBuffer(pts);
    for (var i = 0; i < count; i++) {
      var u = flat ? pts[i * 2] : pts[i][0];
      var v = flat ? pts[i * 2 + 1] : pts[i][1];
      if (!Number.isFinite(u) || !Number.isFinite(v)) throw new RangeError('Некорректные координаты');
      if (u < mnu) mnu = u; if (v < mnv) mnv = v;
      if (u > mxu) mxu = u; if (v > mxv) mxv = v;
      if ((i & 16383) === 16383 || i + 1 === count) emitProgress(onProgress, 'bounds', i + 1, count);
    }
    return { mn: [mnu, mnv], mx: [mxu, mxv] };
  }

  // Сетка занятости: отмечаем ячейки, где есть точки.
  function gridOccupancy(pts, cell, onProgress) {
    if (!(cell > 0) || !Number.isFinite(cell)) throw new RangeError('Размер ячейки должен быть положительным');
    var count = point2dCount(pts);
    var bb = bbox2d(pts, onProgress);
    if (!bb) return { occ: new Uint8Array(0), nx: 0, ny: 0, mn: [0, 0], cell: cell };
    var mn = bb.mn;
    var nx = Math.max(1, Math.floor((bb.mx[0] - mn[0]) / cell + 1e-6) + 1);
    var ny = Math.max(1, Math.floor((bb.mx[1] - mn[1]) / cell + 1e-6) + 1);
    if (!Number.isSafeInteger(nx * ny) || nx * ny > 4000000) throw new RangeError('Слишком большая сетка сечения. Увеличьте размер ячейки или обрежьте облако.');
    var occ = new Uint8Array(nx * ny);
    var flat = isFlatPointBuffer(pts);
    for (var i = 0; i < count; i++) {
      var u = flat ? pts[i * 2] : pts[i][0];
      var v = flat ? pts[i * 2 + 1] : pts[i][1];
      var gx = Math.floor((u - mn[0]) / cell + 1e-6);
      var gy = Math.floor((v - mn[1]) / cell + 1e-6);
      if (gx < 0) gx = 0; if (gy < 0) gy = 0;
      if (gx >= nx) gx = nx - 1; if (gy >= ny) gy = ny - 1;
      occ[gy * nx + gx] = 1;
      if ((i & 16383) === 16383 || i + 1 === count) emitProgress(onProgress, 'occupancy', i + 1, count);
    }
    if (!count) emitProgress(onProgress, 'occupancy', 0, 0);
    return { occ: occ, nx: nx, ny: ny, mn: mn, cell: cell };
  }

  // Граничные рёбра занятых ячеек → сшивка в замкнутые контуры (мировые коорд.).
  // Directed edges keep occupied cells on the left. At diagonal touches choose
  // the left turn: separate 4-connected regions, never join a figure-eight.
  function traceContours(grid, opts) {
    opts = opts || {};
    var maxEdges = opts.maxEdges != null ? opts.maxEdges : 250000;
    if (!Number.isSafeInteger(maxEdges) || maxEdges < 0) throw new RangeError('Некорректный лимит рёбер контура');
    const { occ, nx, ny, mn, cell } = grid;
    const get = (x,y) => x >= 0 && y >= 0 && x < nx && y < ny && occ[y*nx+x];
    const key = p => p[0] + ',' + p[1];
    const edges = [], outgoing = new Map();
    function edge(a,b,d) {
      if (edges.length >= maxEdges) throw new RangeError('Слишком сложная граница сечения. Увеличьте размер ячейки или обрежьте облако.');
      const e = {a,b,d,used:false}; edges.push(e);
      const k = key(a); if(!outgoing.has(k)) outgoing.set(k,[]); outgoing.get(k).push(e);
    }
    var rowStep = Math.max(1, Math.floor(ny / 40));
    for(let y=0;y<ny;y++) {
      for(let x=0;x<nx;x++) if(get(x,y)) {
        if(!get(x,y-1)) edge([x,y],[x+1,y],0);
        if(!get(x+1,y)) edge([x+1,y],[x+1,y+1],1);
        if(!get(x,y+1)) edge([x+1,y+1],[x,y+1],2);
        if(!get(x-1,y)) edge([x,y+1],[x,y],3);
      }
      if ((y + 1) % rowStep === 0 || y + 1 === ny) emitProgress(opts.onProgress, 'trace-grid', y + 1, ny);
    }
    if (!ny) emitProgress(opts.onProgress, 'trace-grid', 0, 0);
    const loops=[];
    var edgeStep = Math.max(1, Math.floor(edges.length / 40));
    for(let edgeIndex=0;edgeIndex<edges.length;edgeIndex++) {
      const start=edges[edgeIndex];
      if ((edgeIndex + 1) % edgeStep === 0 || edgeIndex + 1 === edges.length) {
        emitProgress(opts.onProgress, 'trace-loops', edgeIndex + 1, edges.length);
      }
      if(start.used) continue;
      const points=[];let e=start,closed=false;
      for(let guard=0;guard<=edges.length;guard++) {
        if(e.used) break;
        e.used=true;points.push(e.a);
        if(key(e.b)===key(start.a)){closed=true;break;}
        const next=(outgoing.get(key(e.b))||[]).filter(n=>!n.used);
        const rank=n=>({1:0,0:1,3:2,2:3})[(n.d-e.d+4)%4];
        next.sort((a,b)=>rank(a)-rank(b));if(!next.length)break;e=next[0];
      }
      if(closed && points.length >= (opts.minLoop == null ? 4 : opts.minLoop)) loops.push(points.map(p=>[mn[0]+p[0]*cell,mn[1]+p[1]*cell]));
    }
    if (!edges.length) emitProgress(opts.onProgress, 'trace-loops', 0, 0);
    return loops;
  }

  function perpDist(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var L2 = dx * dx + dy * dy;
    if (L2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    var t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
    t = Math.max(0, Math.min(1, t)); // distance to the segment, not its infinite line
    var cx = a[0] + t * dx, cy = a[1] + t * dy;
    return Math.hypot(p[0] - cx, p[1] - cy);
  }

  // Ramer–Douglas–Peucker — упрощение ломаной.
  function simplifyRDP(points, eps) {
    if (!points || points.length < 3) return (points || []).slice();
    eps = eps == null ? 1e-6 : eps;
    if (!Number.isFinite(eps) || eps < 0) throw new RangeError('Некорректный допуск упрощения');
    var keep = new Array(points.length); for (var i = 0; i < points.length; i++) keep[i] = false;
    keep[0] = true; keep[points.length - 1] = true;
    var stack = [[0, points.length - 1]];
    while (stack.length) {
      var seg = stack.pop(); var s = seg[0], e = seg[1];
      var a = points[s], b = points[e]; var dmax = 0, idx = -1;
      for (var j = s + 1; j < e; j++) { var d = perpDist(points[j], a, b); if (d > dmax) { dmax = d; idx = j; } }
      if (dmax > eps && idx > 0) { keep[idx] = true; stack.push([s, idx]); stack.push([idx, e]); }
    }
    var out = []; for (var k = 0; k < points.length; k++) if (keep[k]) out.push(points[k]);
    return out;
  }

  // Remove vertices introduced only by a mesh's triangle diagonals. A closed
  // section may contain two or more collinear fragments per polygon edge; RDP
  // alone can preserve some of them depending on where its recursion splits.
  // Anchor at the strongest corner, then use a linear stack pass so even large
  // contours are simplified in O(n), without weakening the caller's tolerance.
  function simplifyCollinearClosed(points, eps) {
    if (!points || points.length < 4) return (points || []).slice();
    var n = points.length, anchor = 0, maxTurn = -1;
    for (var i = 0; i < n; i++) {
      var d = perpDist(points[i], points[(i + n - 1) % n], points[(i + 1) % n]);
      if (d > maxTurn) { maxTurn = d; anchor = i; }
    }
    // A fully collinear closed chain has no unambiguous corner. Keep it intact;
    // downstream validation can flag zero-area geometry rather than inventing it.
    if (!(maxTurn > eps)) return points.slice();
    var ordered = points.slice(anchor).concat(points.slice(0, anchor));
    var stack = [ordered[0]];
    for (var j = 1; j < ordered.length; j++) {
      var current = ordered[j];
      while (stack.length >= 2 && perpDist(stack[stack.length - 1], stack[stack.length - 2], current) <= eps) {
        stack.pop();
      }
      stack.push(current);
    }
    // Simplify the final edge back to the fixed anchor. The anchor is selected
    // as a non-collinear corner, so it is retained while any seam midpoints go.
    while (stack.length >= 3 && perpDist(stack[stack.length - 1], stack[stack.length - 2], stack[0]) <= eps) {
      stack.pop();
    }
    return stack;
  }

  function perim(pts) {
    var s = 0; for (var i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return s;
  }

  function polygonArea(pts) {
    if (!pts || pts.length < 3) return 0;
    var twice = 0;
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      twice += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(twice) * 0.5;
  }

  // Общий конвейер для ортогонального и наклонного сечений:
  // проекция → сетка → контуры → фильтр площади → упрощение.
  function contoursFromPoints(pts, opts, meta) {
    opts = opts || {};
    var cell = opts.cell != null ? opts.cell : 0.1;
    var minArea = opts.minArea != null ? Number(opts.minArea) : cell * cell * 1.5;
    if (!Number.isFinite(minArea) || minArea < 0) throw new RangeError('Минимальная площадь должна быть неотрицательным числом');
    var grid = gridOccupancy(pts, cell, opts.onProgress);
    var loops = traceContours(grid, { minLoop: opts.minLoop != null ? opts.minLoop : 4, onProgress: opts.onProgress });
    var eps = opts.simplify != null ? opts.simplify : cell * 0.25;
    var discardedSmall = 0;
    var out = loops.map(function (lp) {
      var rawArea = polygonArea(lp);
      if (rawArea + cell * cell * 1e-9 < minArea) { discardedSmall++; return null; }
      var closed = lp.slice(); closed.push(lp[0].slice());
      var spts = simplifyRDP(closed, eps);
      return { points: spts, closed: true, perim: perim(spts), area: polygonArea(spts) };
    }).filter(function (o) { return o && o.points.length >= 4; });
    out.sort(function (a, b) { return b.perim - a.perim; });
    return Object.assign({
      loops: out, cell: cell, sliced: point2dCount(pts), minArea: minArea,
      discardedSmall: discardedSmall
    }, meta || {});
  }

  // Высокоуровневый конвейер для среза, параллельного координатным плоскостям.
  function sectionToPolylines(pos, count, opts) {
    opts = opts || {};
    var sl = opts.compact ? sliceSlabCompact(pos, count, opts) : sliceSlab(pos, count, opts);
    return contoursFromPoints(sl.pts, opts, { axis: sl.axis, level: sl.level });
  }

  // Наклонный вертикальный профиль. Азимут задаётся в координатах viewer:
  // 0° идёт вдоль +X, 90° — вдоль +Z. Плоскость смещается на offset по
  // нормали (-sin, cos); результат — [станция, высота Y] в метрах.
  function profileToPolylines(pos, count, opts) {
    opts = opts || {};
    if (!pos || !Number.isSafeInteger(count) || count < 0 || count * 3 > pos.length) {
      throw new RangeError('Некорректное число точек');
    }
    var origin = opts.origin;
    var originArray = Array.isArray(origin) || (origin && typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(origin));
    if (origin != null && (!originArray || origin.length < 2)) throw new RangeError('Начало профиля должно содержать X и Z');
    var originX = origin != null ? Number(origin[0]) : (opts.originX != null ? Number(opts.originX) : 0);
    var originZ = origin != null ? Number(origin[1]) : (opts.originZ != null ? Number(opts.originZ) : 0);
    var rawAngle = opts.azimuthDeg != null ? Number(opts.azimuthDeg) : 0;
    var offset = opts.offset != null ? Number(opts.offset) : 0;
    var thickness = opts.thickness != null ? Number(opts.thickness) : 0.1;
    if (![originX, originZ, rawAngle, offset].every(Number.isFinite) ||
        !(thickness > 0) || !Number.isFinite(thickness)) {
      throw new RangeError('Некорректные параметры наклонного профиля');
    }
    var azimuthDeg = ((rawAngle % 360) + 360) % 360;
    var rad = azimuthDeg * Math.PI / 180;
    var dx = Math.cos(rad), dz = Math.sin(rad);
    var nx = -dz, nz = dx;
    var half = thickness / 2;
    // Keep the default memory footprint close to the existing axis-aligned
    // section path. Original point IDs are opt-in for audit/export workflows.
    var indices = opts.includeIndices ? [] : null;
    var compact = !!opts.compact && !indices;
    var CoordArray = pos instanceof Float32Array ? Float32Array : Float64Array;
    var pts = compact ? new CoordArray(count * 2) : [];
    var used = 0;
    var progressEvery = Math.max(1, Math.floor(count / 80));
    emitProgress(opts.onProgress, 'profile', 0, count);
    for (var i = 0; i < count; i++) {
      var x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        var rx = x - originX, rz = z - originZ;
        var crossTrack = rx * nx + rz * nz;
        if (Math.abs(crossTrack - offset) <= half) {
          if (compact) {
            pts[used++] = rx * dx + rz * dz;
            pts[used++] = y;
          } else pts.push([rx * dx + rz * dz, y]);
          if (indices) indices.push(i);
        }
      }
      if ((i + 1) % progressEvery === 0 || i + 1 === count) emitProgress(opts.onProgress, 'profile', i + 1, count);
    }
    if (!count) emitProgress(opts.onProgress, 'profile', 0, 0);
    if (compact) pts = pts.subarray(0, used);
    var meta = {
      axis: 'profile',
      azimuthDeg: azimuthDeg,
      origin: [originX, originZ],
      offset: offset,
      planeOrigin: [originX + nx * offset, originZ + nz * offset],
      direction: [dx, dz],
      normal: [nx, nz],
      thickness: thickness
    };
    if (indices) meta.indices = indices;
    return contoursFromPoints(pts, opts, meta);
  }

  // Представление результатов профиля как 2D-полилиний DXF:
  // X=станция, Y=отметка, Z=0. Дубликат замыкающей вершины удаляется,
  // поскольку замыкание уже кодируется флагом POLYLINE.
  function profileToDxfEntities(result, layer) {
    if (!result || !Array.isArray(result.loops)) throw new TypeError('Нет результата сечения для DXF');
    layer = layer || 'PROFILE_CONTOUR';
    var entities = [];
    result.loops.forEach(function (loop) {
      if (!loop || !Array.isArray(loop.points)) throw new TypeError('Некорректный контур профиля');
      var closed = loop.closed !== false;
      var points = loop.points.map(function (p) {
        if (!p || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
          throw new RangeError('Контур профиля содержит некорректную вершину');
        }
        return [Number(p[0]), Number(p[1]), 0];
      });
      if (closed && points.length > 1) {
        var a = points[0], b = points[points.length - 1];
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-9) points.pop();
      }
      if (points.length < (closed ? 3 : 2)) return;
      entities.push({ type: 'polyline', layer: layer, closed: closed, points: points });
    });
    return entities;
  }

  // Build an axis-aligned section plane. Coordinates are viewer/source mesh
  // coordinates; the resulting DXF uses the two visible axes of that plane.
  function axisPlane(axis, level, center) {
    if (!['x', 'y', 'z'].includes(axis) || !Number.isFinite(Number(level))) {
      throw new RangeError('Некорректная ось или уровень плоскости');
    }
    center = center || [0, 0, 0];
    if (!center || center.length < 3 || ![Number(center[0]), Number(center[1]), Number(center[2])].every(Number.isFinite)) {
      throw new RangeError('Центр плоскости должен содержать три конечные координаты');
    }
    var origin = [Number(center[0]), Number(center[1]), Number(center[2])];
    var normal, u, v;
    if (axis === 'x') { origin[0] = Number(level); normal = [1, 0, 0]; u = [0, 0, 1]; v = [0, 1, 0]; }
    else if (axis === 'y') { origin[1] = Number(level); normal = [0, 1, 0]; u = [1, 0, 0]; v = [0, 0, 1]; }
    else { origin[2] = Number(level); normal = [0, 0, 1]; u = [1, 0, 0]; v = [0, 1, 0]; }
    return { axis: axis, level: Number(level), origin: origin, normal: normal, u: u, v: v };
  }

  function meshPlaneSection(mesh, plane, opts) {
    opts = opts || {};
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    function emitProgress(phase, completed, total) {
      if (!onProgress) return;
      var safeTotal = Number(total) || 0;
      var safeCompleted = Number(completed) || 0;
      try {
        onProgress({
          phase: phase,
          completed: safeCompleted,
          total: safeTotal,
          fraction: safeTotal > 0 ? Math.max(0, Math.min(1, safeCompleted / safeTotal)) : 1
        });
      } catch (e) {}
    }
    var primitives = Array.isArray(mesh) ? mesh : (mesh && Array.isArray(mesh.primitives) ? mesh.primitives : [mesh]);
    if (!primitives.length || !primitives[0]) throw new TypeError('Не передана треугольная геометрия меша');
    if (!plane || !plane.origin || !plane.normal || plane.origin.length < 3 || plane.normal.length < 3) {
      throw new TypeError('Плоскость должна содержать origin и normal');
    }
    var origin = [Number(plane.origin[0]), Number(plane.origin[1]), Number(plane.origin[2])];
    var rawNormal = [Number(plane.normal[0]), Number(plane.normal[1]), Number(plane.normal[2])];
    if (!origin.every(Number.isFinite) || !rawNormal.every(Number.isFinite)) throw new RangeError('Некорректные координаты плоскости');
    var nLen = Math.hypot(rawNormal[0], rawNormal[1], rawNormal[2]);
    if (!(nLen > 0)) throw new RangeError('Нормаль плоскости не может быть нулевой');
    var normal = rawNormal.map(function (x) { return x / nLen; });

    function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
    function norm3(a) { var d = Math.hypot(a[0], a[1], a[2]); return d > 0 ? a.map(function (x) { return x / d; }) : null; }
    function readVector3(value, label) {
      if (!value || value.length < 3) throw new RangeError(label + ' должен содержать три координаты');
      var q = [Number(value[0]), Number(value[1]), Number(value[2])];
      if (!q.every(Number.isFinite)) throw new RangeError('Некорректный ' + label);
      return q;
    }
    var u, v;
    if (plane.u != null) {
      var ru = readVector3(plane.u, 'вектор u');
      u = norm3([ru[0] - normal[0] * dot3(ru, normal), ru[1] - normal[1] * dot3(ru, normal), ru[2] - normal[2] * dot3(ru, normal)]);
      if (!u) throw new RangeError('Вектор u параллелен нормали плоскости');
      if (plane.v != null) {
        var rv = readVector3(plane.v, 'вектор v'), vn = dot3(rv, normal), vu = dot3(rv, u);
        v = norm3([rv[0] - normal[0] * vn - u[0] * vu, rv[1] - normal[1] * vn - u[1] * vu, rv[2] - normal[2] * vn - u[2] * vu]);
        if (!v) throw new RangeError('Вектор v не задаёт независимое направление в плоскости');
      } else {
        v = norm3([
          normal[1] * u[2] - normal[2] * u[1],
          normal[2] * u[0] - normal[0] * u[2],
          normal[0] * u[1] - normal[1] * u[0]
        ]);
      }
    } else {
      var ref = Math.abs(normal[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
      u = norm3([
        normal[1] * ref[2] - normal[2] * ref[1],
        normal[2] * ref[0] - normal[0] * ref[2],
        normal[0] * ref[1] - normal[1] * ref[0]
      ]);
      v = norm3([
        normal[1] * u[2] - normal[2] * u[1],
        normal[2] * u[0] - normal[0] * u[2],
        normal[0] * u[1] - normal[1] * u[0]
      ]);
    }

    var maxTriangles = opts.maxTriangles == null ? 2000000 : Number(opts.maxTriangles);
    if (!Number.isSafeInteger(maxTriangles) || maxTriangles < 1) throw new RangeError('Лимит треугольников должен быть положительным целым');
    var geometry = [], triCount = 0, boundsMin = [Infinity, Infinity, Infinity], boundsMax = [-Infinity, -Infinity, -Infinity];
    var totalInputVertices = 0;
    for (var tvi = 0; tvi < primitives.length; tvi++) {
      var tp = primitives[tvi];
      var tpos = tp && (tp.sectionPositions || tp.positions || tp.vertices);
      if (tpos && Number.isSafeInteger(tpos.length) && tpos.length % 3 === 0) totalInputVertices += tpos.length / 3;
    }
    var boundsDone = 0, boundsStride = Math.max(1, Math.floor(totalInputVertices / 100));
    function validateMatrix(m) {
      if (m == null) return null;
      if (m.length !== 16) throw new RangeError('Матрица меша должна содержать 16 значений');
      for (var q = 0; q < 16; q++) if (!Number.isFinite(Number(m[q]))) throw new RangeError('Матрица меша содержит нечисловое значение');
      return m;
    }
    function worldPoint(pos, index, matrix) {
      var x = Number(pos[index * 3]), y = Number(pos[index * 3 + 1]), z = Number(pos[index * 3 + 2]);
      if (![x, y, z].every(Number.isFinite)) return null;
      if (!matrix) return [x, y, z];
      var w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
      if (!Number.isFinite(w) || Math.abs(w) < 1e-15) return null;
      var q = [
        (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w,
        (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w,
        (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w
      ];
      return q.every(Number.isFinite) ? q : null;
    }
    for (var pi = 0; pi < primitives.length; pi++) {
      var prim = primitives[pi];
      if (!prim) continue;
      var positions = prim.sectionPositions || prim.positions || prim.vertices;
      if (!positions || positions.length < 9 || positions.length % 3 !== 0) throw new RangeError('Меш должен содержать плоский массив вершин XYZ');
      var indices = prim.indices || prim.index || null, vertexCount = positions.length / 3;
      if (indices && indices.length % 3 !== 0) throw new RangeError('Число индексов меша не кратно трём');
      var primitiveTriangles = indices ? indices.length / 3 : vertexCount / 3;
      if (!Number.isSafeInteger(primitiveTriangles)) throw new RangeError('Геометрия меша не содержит полные треугольники');
      triCount += primitiveTriangles;
      if (triCount > maxTriangles) throw new RangeError('Точное сечение ограничено ' + maxTriangles + ' треугольниками; разделите меш или уменьшите его плотность');
      var matrix = validateMatrix(prim.model || prim.transform);
      geometry.push({ positions: positions, indices: indices, vertexCount: vertexCount, matrix: matrix, triangles: primitiveTriangles });
      for (var vi = 0; vi < vertexCount; vi++) {
        var wp = worldPoint(positions, vi, matrix);
        if (!wp) continue;
        for (var c = 0; c < 3; c++) { if (wp[c] < boundsMin[c]) boundsMin[c] = wp[c]; if (wp[c] > boundsMax[c]) boundsMax[c] = wp[c]; }
        boundsDone++;
        if (boundsDone % boundsStride === 0 || boundsDone === totalInputVertices) emitProgress('bounds', boundsDone, totalInputVertices);
      }
    }
    if (!geometry.length || !Number.isFinite(boundsMin[0])) throw new RangeError('В меше нет конечных координат');
    emitProgress('bounds', totalInputVertices, totalInputVertices);
    var center = [
      boundsMin[0] + (boundsMax[0] - boundsMin[0]) * 0.5,
      boundsMin[1] + (boundsMax[1] - boundsMin[1]) * 0.5,
      boundsMin[2] + (boundsMax[2] - boundsMin[2]) * 0.5
    ];
    var diagonal = Math.hypot(boundsMax[0] - boundsMin[0], boundsMax[1] - boundsMin[1], boundsMax[2] - boundsMin[2]);
    var epsilon = opts.epsilon == null ? Math.max(1e-9, diagonal * 1e-9) : Number(opts.epsilon);
    if (!(epsilon > 0) || !Number.isFinite(epsilon)) throw new RangeError('Допуск сечения должен быть конечным и положительным');
    var stitchTolerance = opts.stitchTolerance == null
      ? Math.max(epsilon * 4, diagonal * 1e-10, 1e-9)
      : Number(opts.stitchTolerance);
    if (!(stitchTolerance > 0) || !Number.isFinite(stitchTolerance)) throw new RangeError('Допуск сшивки должен быть конечным и положительным');
    var snap = Math.max(stitchTolerance, diagonal * 1e-12, 1e-9);
    var signedCenter = dot3([center[0] - origin[0], center[1] - origin[1], center[2] - origin[2]], normal);
    var anchor = [center[0] - normal[0] * signedCenter, center[1] - normal[1] * signedCenter, center[2] - normal[2] * signedCenter];
    var coordOffset = [dot3(anchor, u), dot3(anchor, v)];
    function local2(p) {
      return [
        (p[0] - anchor[0]) * u[0] + (p[1] - anchor[1]) * u[1] + (p[2] - anchor[2]) * u[2],
        (p[0] - anchor[0]) * v[0] + (p[1] - anchor[1]) * v[1] + (p[2] - anchor[2]) * v[2]
      ];
    }
    function nodeKey(q) { return Math.round(q[0] / snap) + ',' + Math.round(q[1] / snap); }
    var nodes = [], nodeIds = new Map(), segments = [], segmentKeys = new Set(), coplanarEdges = new Map();
    function getNode(p) {
      var q = local2(p), key = nodeKey(q), id = nodeIds.get(key);
      if (id == null) { id = nodes.length; nodeIds.set(key, id); nodes.push(q); }
      return id;
    }
    function addSegmentIds(ia, ib) {
      if (ia === ib) return;
      var lo = Math.min(ia, ib), hi = Math.max(ia, ib), key = lo + ':' + hi;
      if (segmentKeys.has(key)) return;
      segmentKeys.add(key); segments.push([lo, hi]);
    }
    function addSegment(a, b) { addSegmentIds(getNode(a), getNode(b)); }
    function countCoplanarEdge(a, b) {
      var ia = getNode(a), ib = getNode(b);
      if (ia === ib) return;
      var lo = Math.min(ia, ib), hi = Math.max(ia, ib), key = lo + ':' + hi, old = coplanarEdges.get(key);
      if (old) old.count++;
      else coplanarEdges.set(key, { a: lo, b: hi, count: 1 });
    }
    var intersectedTriangles = 0, coplanarTriangles = 0, invalidTriangles = 0, degenerateTriangles = 0;
    var trianglesDone = 0, triangleStride = Math.max(1, Math.floor(triCount / 100));
    for (var gi = 0; gi < geometry.length; gi++) {
      var g = geometry[gi];
      for (var ti = 0; ti < g.triangles; ti++) {
        trianglesDone++;
        if (trianglesDone % triangleStride === 0 || trianglesDone === triCount) emitProgress('intersect', trianglesDone, triCount);
        var ids = g.indices ? [Number(g.indices[ti * 3]), Number(g.indices[ti * 3 + 1]), Number(g.indices[ti * 3 + 2])] : [ti * 3, ti * 3 + 1, ti * 3 + 2];
        if (!ids.every(function (id) { return Number.isSafeInteger(id) && id >= 0 && id < g.vertexCount; })) throw new RangeError('Индекс вершины выходит за границы массива');
        var p3 = [worldPoint(g.positions, ids[0], g.matrix), worldPoint(g.positions, ids[1], g.matrix), worldPoint(g.positions, ids[2], g.matrix)];
        if (p3.some(function (q) { return !q; })) { invalidTriangles++; continue; }
        var e1 = [p3[1][0] - p3[0][0], p3[1][1] - p3[0][1], p3[1][2] - p3[0][2]];
        var e2 = [p3[2][0] - p3[0][0], p3[2][1] - p3[0][1], p3[2][2] - p3[0][2]];
        var areaVec = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        if (!(Math.hypot(areaVec[0], areaVec[1], areaVec[2]) > epsilon * epsilon)) { degenerateTriangles++; continue; }
        var sd = p3.map(function (q) { return dot3([q[0] - origin[0], q[1] - origin[1], q[2] - origin[2]], normal); });
        var cls = sd.map(function (d) { return d > epsilon ? 1 : (d < -epsilon ? -1 : 0); });
        var zeroCount = (cls[0] === 0 ? 1 : 0) + (cls[1] === 0 ? 1 : 0) + (cls[2] === 0 ? 1 : 0);
        if (zeroCount === 3) {
          coplanarTriangles++;
          countCoplanarEdge(p3[0], p3[1]); countCoplanarEdge(p3[1], p3[2]); countCoplanarEdge(p3[2], p3[0]);
          continue;
        }
        var hits = [];
        if (zeroCount === 2) {
          for (var zi = 0; zi < 3; zi++) if (cls[zi] === 0) hits.push(p3[zi]);
        } else if (zeroCount === 1) {
          var on = cls.indexOf(0), other = [0, 1, 2].filter(function (k) { return k !== on; });
          if (cls[other[0]] * cls[other[1]] < 0) {
            hits.push(p3[on]);
            var td = sd[other[0]] / (sd[other[0]] - sd[other[1]]);
            hits.push([
              p3[other[0]][0] + (p3[other[1]][0] - p3[other[0]][0]) * td,
              p3[other[0]][1] + (p3[other[1]][1] - p3[other[0]][1]) * td,
              p3[other[0]][2] + (p3[other[1]][2] - p3[other[0]][2]) * td
            ]);
          }
        } else {
          for (var ei = 0; ei < 3; ei++) {
            var ej = (ei + 1) % 3;
            if (cls[ei] * cls[ej] < 0) {
              var tt = sd[ei] / (sd[ei] - sd[ej]);
              hits.push([
                p3[ei][0] + (p3[ej][0] - p3[ei][0]) * tt,
                p3[ei][1] + (p3[ej][1] - p3[ei][1]) * tt,
                p3[ei][2] + (p3[ej][2] - p3[ei][2]) * tt
              ]);
            }
          }
        }
        if (hits.length === 2) { addSegment(hits[0], hits[1]); intersectedTriangles++; }
      }
    }
    emitProgress('intersect', triCount, triCount);
    var coplanarTotal = coplanarEdges.size, coplanarDone = 0, coplanarStride = Math.max(1, Math.floor(coplanarTotal / 100));
    coplanarEdges.forEach(function (edge) {
      if (edge.count === 1) addSegmentIds(edge.a, edge.b);
      coplanarDone++;
      if (coplanarDone % coplanarStride === 0 || coplanarDone === coplanarTotal) emitProgress('coplanar', coplanarDone, coplanarTotal);
    });
    if (!coplanarTotal) emitProgress('coplanar', 0, 0);

    var adjacency = new Array(nodes.length), adjacencyTotal = nodes.length + segments.length, adjacencyDone = 0;
    var adjacencyStride = Math.max(1, Math.floor(adjacencyTotal / 100));
    for (var ai0 = 0; ai0 < nodes.length; ai0++) {
      adjacency[ai0] = [];
      adjacencyDone++;
      if (adjacencyDone % adjacencyStride === 0 || adjacencyDone === adjacencyTotal) emitProgress('adjacency', adjacencyDone, adjacencyTotal);
    }
    for (var si = 0; si < segments.length; si++) {
      adjacency[segments[si][0]].push(si); adjacency[segments[si][1]].push(si);
      adjacencyDone++;
      if (adjacencyDone % adjacencyStride === 0 || adjacencyDone === adjacencyTotal) emitProgress('adjacency', adjacencyDone, adjacencyTotal);
    }
    if (!adjacencyTotal) emitProgress('adjacency', 0, 0);
    var used = new Uint8Array(segments.length), paths = [];
    var traceDone = 0, traceStride = Math.max(1, Math.floor(segments.length / 100));
    function walk(start, firstEdge) {
      var ids = [start], current = start, edge = firstEdge, closed = false, guard = 0;
      while (edge != null && !used[edge] && guard++ <= segments.length) {
        used[edge] = 1;
        traceDone++;
        if (traceDone % traceStride === 0 || traceDone === segments.length) emitProgress('trace', traceDone, segments.length);
        var ends = segments[edge], next = ends[0] === current ? ends[1] : ends[0];
        if (next === start) { closed = true; break; }
        ids.push(next); current = next;
        if (adjacency[current].length !== 2) break;
        var candidates = adjacency[current].filter(function (ei) { return !used[ei]; });
        if (candidates.length !== 1) break;
        edge = candidates[0];
      }
      if (ids.length < (closed ? 3 : 2)) return;
      var points = ids.map(function (id) { return [nodes[id][0] + coordOffset[0], nodes[id][1] + coordOffset[1]]; });
      var length = 0;
      for (var k = 1; k < points.length; k++) length += Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]);
      if (closed) length += Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]);
      var simplifyTolerance = Math.max(epsilon * 4, snap * 2);
      if (closed && points.length >= 4) {
        // Start on an extreme vertex, not halfway along a straight edge, so RDP
        // can remove triangulation midpoints without preserving an artificial
        // seam in the closed polyline.
        var avgX = 0, avgY = 0;
        for (var ap = 0; ap < points.length; ap++) { avgX += points[ap][0]; avgY += points[ap][1]; }
        avgX /= points.length; avgY /= points.length;
        var startAt = 0, farSq = -1;
        for (var fp = 0; fp < points.length; fp++) {
          var fx = points[fp][0] - avgX, fy = points[fp][1] - avgY, fsq = fx * fx + fy * fy;
          if (fsq > farSq) { farSq = fsq; startAt = fp; }
        }
        var rotated = points.slice(startAt).concat(points.slice(0, startAt));
        var simplifiedClosed = simplifyRDP(rotated.concat([rotated[0]]), simplifyTolerance);
        if (simplifiedClosed.length > 1 && Math.hypot(simplifiedClosed[0][0] - simplifiedClosed[simplifiedClosed.length - 1][0], simplifiedClosed[0][1] - simplifiedClosed[simplifiedClosed.length - 1][1]) <= simplifyTolerance) simplifiedClosed.pop();
        simplifiedClosed = simplifyCollinearClosed(simplifiedClosed, simplifyTolerance);
        if (simplifiedClosed.length >= 3) points = simplifiedClosed;
      } else if (!closed && points.length > 2) {
        var simplifiedOpen = simplifyRDP(points, simplifyTolerance);
        if (simplifiedOpen.length >= 2) points = simplifiedOpen;
      }
      paths.push({ points: points, closed: closed, length: length, area: closed ? polygonArea(points) : 0 });
    }
    for (var ni = 0; ni < nodes.length; ni++) if (adjacency[ni].length !== 2) {
      for (var ai = 0; ai < adjacency[ni].length; ai++) if (!used[adjacency[ni][ai]]) walk(ni, adjacency[ni][ai]);
    }
    for (var ei2 = 0; ei2 < segments.length; ei2++) if (!used[ei2]) walk(segments[ei2][0], ei2);
    paths.sort(function (a, b) { return b.length - a.length || a.points[0][0] - b.points[0][0] || a.points[0][1] - b.points[0][1]; });
    var branchNodes = adjacency.reduce(function (n, a) { return n + (a.length > 2 ? 1 : 0); }, 0);
    emitProgress('trace', segments.length, segments.length);
    emitProgress('complete', 1, 1);
    return {
      paths: paths,
      axis: plane.axis || null,
      level: plane.level == null ? null : Number(plane.level),
      plane: { origin: origin, normal: normal, u: u, v: v },
      anchor: anchor,
      coordOffset: coordOffset,
      epsilon: epsilon,
      stitchTolerance: snap,
      triangleCount: triCount,
      intersectedTriangles: intersectedTriangles,
      coplanarTriangles: coplanarTriangles,
      invalidTriangles: invalidTriangles,
      degenerateTriangles: degenerateTriangles,
      segmentCount: segments.length,
      closedCount: paths.filter(function (p) { return p.closed; }).length,
      openCount: paths.filter(function (p) { return !p.closed; }).length,
      branchNodes: branchNodes
    };
  }

  function meshSectionToEntities(result, layer) {
    if (!result || !Array.isArray(result.paths)) throw new TypeError('Нет результата mesh-сечения');
    layer = layer || 'MESH_SECTION';
    return result.paths.map(function (path) {
      if (!path || !Array.isArray(path.points)) throw new TypeError('Некорректная линия mesh-сечения');
      var points = path.points.map(function (p) {
        if (!p || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new RangeError('Сечение содержит нечисловую вершину');
        return [Number(p[0]), Number(p[1]), 0];
      });
      if (points.length < (path.closed ? 3 : 2)) return null;
      return { type: 'polyline', layer: layer, closed: !!path.closed, points: points };
    }).filter(Boolean);
  }

  var API = {
    projAxis: projAxis, axisComp: axisComp, sliceSlab: sliceSlab, sliceSlabCompact: sliceSlabCompact, bbox2d: bbox2d,
    gridOccupancy: gridOccupancy, traceContours: traceContours, perpDist: perpDist,
    simplifyRDP: simplifyRDP, perim: perim, polygonArea: polygonArea,
    contoursFromPoints: contoursFromPoints, sectionToPolylines: sectionToPolylines,
    profileToPolylines: profileToPolylines, profileToDxfEntities: profileToDxfEntities,
    axisPlane: axisPlane, meshPlaneSection: meshPlaneSection, meshSectionToEntities: meshSectionToEntities
  };
  if (typeof window !== 'undefined') window.Section = API;
  if (typeof self !== 'undefined') self.Section = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
