/*
 * draw2d.js — чистая модель черчения по облаку (без DOM/GL).
 * Хранит 3D-точки (мировые), проецирует на плоскость для экспорта DXF.
 * window.Draw2D + module.exports (для тестов).
 *
 * Система координат: вьюер Y-up. Проекции:
 *   top   — вид сверху:  DXF (X,Y) = (worldX, worldZ),  фикс ось Y
 *   front — вид спереди: DXF (X,Y) = (worldX, worldY),  фикс ось Z
 *   side  — вид сбоку:   DXF (X,Y) = (worldZ, worldY),  фикс ось X
 */
(function () {
  'use strict';

  function project(pt, mode) {
    mode = mode || 'top';
    if (mode === 'front') return [pt[0], pt[1]];
    if (mode === 'side') return [pt[2], pt[1]];
    return [pt[0], pt[2]]; // top
  }
  // обратно: из плоскостных (u,v) + фиксированной третьей координаты -> 3D
  function unproject(uv, mode, fixed) {
    mode = mode || 'top';
    fixed = fixed || 0;
    if (mode === 'front') return [uv[0], uv[1], fixed]; // фикс Z
    if (mode === 'side') return [fixed, uv[1], uv[0]];  // фикс X
    return [uv[0], fixed, uv[1]];                        // top: фикс Y
  }
  function fixedAxis(mode) { return mode === 'front' ? 2 : (mode === 'side' ? 0 : 1); }

  function dist2d(a, b) { var dx = a[0] - b[0], dy = a[1] - b[1]; return Math.sqrt(dx * dx + dy * dy); }
  function dist3d(a, b) { var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2]; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
  // Формат длины для подписи размера (метры, латинское 'm' для совместимости с CAD)
  function formatLen(m) { return (Math.round((m || 0) * 1000) / 1000).toString() + ' m'; }

  // 4 угла прямоугольника в 3D по двум противоположным углам (в плоскости проекции)
  function rectCorners3D(a, b, mode) {
    var pa = project(a, mode), pb = project(b, mode);
    var ax = fixedAxis(mode);
    var fixed = (a[ax] + b[ax]) / 2;
    var c1 = [pa[0], pa[1]], c2 = [pb[0], pa[1]], c3 = [pb[0], pb[1]], c4 = [pa[0], pb[1]];
    return [c1, c2, c3, c4].map(function (uv) { return unproject(uv, mode, fixed); });
  }

  function Session(opts) {
    opts = opts || {};
    this.tool = opts.tool || 'polyline'; // polyline|line|rect|circle|point
    this.projection = opts.projection || 'top';
    this.layer = opts.layer || 'DRAW';
    this.entities = [];
    this.draft = null; // массив 3D-точек текущей незавершённой сущности
  }

  Session.prototype.setTool = function (t) { this.commit(); this.tool = t; return this; };
  Session.prototype.setProjection = function (m) { this.projection = m; return this; };

  Session.prototype._push = function (ent) { ent.layer = ent.layer || this.layer; this.entities.push(ent); return ent; };

  Session.prototype.addVertex = function (p3) {
    var t = this.tool;
    if (t === 'point') { this._push({ type: 'point', p: p3.slice() }); return this; }
    if (!this.draft) this.draft = [];
    this.draft.push(p3.slice());
    if (t === 'line' && this.draft.length === 2) {
      this._push({ type: 'line', a: this.draft[0], b: this.draft[1] });
      this.draft = null;
    } else if (t === 'dim' && this.draft.length === 2) {
      var da = this.draft[0], db = this.draft[1];
      // Размер должен соответствовать текущей чертёжной плоскости, а не
      // случайной разнице высот точек, спроецированных из облака.
      var L = dist2d(project(da, this.projection), project(db, this.projection));
      this._push({ type: 'dim', a: da, b: db, len: L, text: formatLen(L) });
      this.draft = null;
    } else if (t === 'rect' && this.draft.length === 2) {
      this._push({ type: 'polyline', points: rectCorners3D(this.draft[0], this.draft[1], this.projection), closed: true });
      this.draft = null;
    } else if (t === 'circle' && this.draft.length === 2) {
      var c = this.draft[0], rp = this.draft[1];
      var r = dist2d(project(c, this.projection), project(rp, this.projection));
      this._push({ type: 'circle', c: c.slice(), r: r });
      this.draft = null;
    }
    return this;
  };

  // Завершить открытую полилинию (без замыкания)
  Session.prototype.commit = function () {
    if (this.tool === 'polyline' && this.draft && this.draft.length >= 2) {
      this._push({ type: 'polyline', points: this.draft.slice(), closed: false });
    }
    this.draft = null;
    return this;
  };
  // Замкнуть текущую полилинию
  Session.prototype.closePath = function () {
    if (this.tool === 'polyline' && this.draft && this.draft.length >= 2) {
      this._push({ type: 'polyline', points: this.draft.slice(), closed: true });
    }
    this.draft = null;
    return this;
  };

  Session.prototype.undo = function () {
    if (this.draft && this.draft.length) { this.draft.pop(); if (!this.draft.length) this.draft = null; }
    else if (this.entities.length) { this.entities.pop(); }
    return this;
  };
  Session.prototype.clear = function () { this.entities = []; this.draft = null; return this; };

  // Импорт распарсенных DXF-сущностей (2D плоскости) → 3D через unproject
  Session.prototype.importEntities = function (parsed, mode, fixed) {
    mode = mode || this.projection; fixed = (fixed == null ? 0 : fixed);
    var self = this, added = 0;
    (parsed || []).forEach(function (e) {
      if (e.type === 'line') { self.entities.push({ type: 'line', layer: e.layer || self.layer, a: unproject([e.a[0], e.a[1]], mode, fixed), b: unproject([e.b[0], e.b[1]], mode, fixed) }); added++; }
      else if (e.type === 'polyline') { self.entities.push({ type: 'polyline', layer: e.layer || self.layer, closed: !!e.closed, points: (e.points || []).map(function (q) { return unproject([q[0], q[1]], mode, fixed); }) }); added++; }
      else if (e.type === 'point') { self.entities.push({ type: 'point', layer: e.layer || self.layer, p: unproject([e.p[0], e.p[1]], mode, fixed) }); added++; }
      else if (e.type === 'circle') { self.entities.push({ type: 'circle', layer: e.layer || self.layer, c: unproject([e.c[0], e.c[1]], mode, fixed), r: e.r }); added++; }
      else if (e.type === 'text') { self.entities.push({ type: 'text', layer: e.layer || self.layer, p: unproject([e.p[0], e.p[1]], mode, fixed), h: e.h, text: e.text }); added++; }
    });
    return added;
  };

  Session.prototype.count = function () { return this.entities.length; };

  Session.prototype.bbox = function () {
    var pts = [];
    this.entities.forEach(function (e) {
      if (e.type === 'line') pts.push(e.a, e.b);
      else if (e.type === 'polyline') e.points.forEach(function (q) { pts.push(q); });
      else if (e.type === 'point') pts.push(e.p);
      else if (e.type === 'circle') pts.push(e.c);
      else if (e.type === 'text') pts.push(e.p);
      else if (e.type === 'dim') pts.push(e.a, e.b);
    });
    if (!pts.length) return null;
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    pts.forEach(function (q) { for (var i = 0; i < 3; i++) { if (q[i] < mn[i]) mn[i] = q[i]; if (q[i] > mx[i]) mx[i] = q[i]; } });
    return { mn: mn, mx: mx };
  };

  // Преобразование viewer Y-up -> исходные горизонтальные координаты проекта.
  // Для Z-up: viewer (x,y,z) -> source (x+t0, -z+t1, y+t2).
  // Для Y-up: viewer (x,y,z) -> source (x+t0, y+t1, z+t2); планом служат X/Z.
  function sourcePlanPoint(pt, transform) {
    var t = transform && transform.t;
    if (!pt || pt.length < 3 || !t || t.length < 3 ||
        (transform.axis !== 'zup' && transform.axis !== 'yup')) {
      throw new RangeError('Для исходного DXF нужны ось и смещение исходного облака');
    }
    var x = Number(pt[0]), z = Number(pt[2]);
    var tx = Number(t[0]), ty = Number(t[1]), tz = Number(t[2]);
    if (![x, z, tx, ty, tz].every(Number.isFinite)) {
      throw new RangeError('Некорректные координаты исходного DXF');
    }
    return transform.axis === 'zup'
      ? [x + tx, -z + ty, 0]
      : [x + tx, z + tz, 0];
  }

  // Обратное преобразование 2D DXF из исходной системы в координаты плана
  // viewer (u,v). Session.importEntities затем разворачивает их в 3D.
  function sourceDxfPointToViewer(pt, transform) {
    var t = transform && transform.t;
    if (!pt || pt.length < 2 || !t || t.length < 3 ||
        (transform.axis !== 'zup' && transform.axis !== 'yup')) {
      throw new RangeError('Для импорта исходного DXF нужны ось и смещение облака');
    }
    var x = Number(pt[0]), y = Number(pt[1]);
    var tx = Number(t[0]), ty = Number(t[1]), tz = Number(t[2]);
    if (![x, y, tx, ty, tz].every(Number.isFinite)) {
      throw new RangeError('Некорректные координаты импортируемого DXF');
    }
    return transform.axis === 'zup'
      ? [x - tx, -(y - ty), 0]
      : [x - tx, y - tz, 0];
  }

  function fromSourceDxfEntities(entities, transform) {
    return (entities || []).map(function (e) {
      if (!e) return e;
      var out = Object.assign({}, e);
      if (e.type === 'line') {
        out.a = sourceDxfPointToViewer(e.a, transform);
        out.b = sourceDxfPointToViewer(e.b, transform);
      } else if (e.type === 'polyline') {
        out.points = (e.points || []).map(function (p) { return sourceDxfPointToViewer(p, transform); });
      } else if (e.type === 'point' || e.type === 'text') {
        out.p = sourceDxfPointToViewer(e.p, transform);
      } else if (e.type === 'circle') {
        out.c = sourceDxfPointToViewer(e.c, transform);
      }
      return out;
    });
  }

  // Проецируем 3D-сущности в плоские для DXF (размер = линия + текст).
  // На плане можно передать sourceTransform, чтобы DXF содержал исходные XY,
  // а не локальные viewer-координаты. Вертикальные виды остаются локальными.
  function toDxfEntities(entities, mode, layer, opts) {
    mode = mode || 'top';
    opts = opts || {};
    var sourceTransform = opts.sourceTransform;
    var flatten = function (pt) {
      if (sourceTransform && mode === 'top') return sourcePlanPoint(pt, sourceTransform);
      return project(pt, mode).concat(0);
    };
    var out = [];
    entities.forEach(function (e) {
      var lyr = e.layer || layer;
      if (e.type === 'line') out.push({ type: 'line', layer: lyr, a: flatten(e.a), b: flatten(e.b) });
      else if (e.type === 'polyline') out.push({ type: 'polyline', layer: lyr, closed: !!e.closed, points: e.points.map(flatten) });
      else if (e.type === 'point') out.push({ type: 'point', layer: lyr, p: flatten(e.p) });
      else if (e.type === 'circle') out.push({ type: 'circle', layer: lyr, c: flatten(e.c), r: e.r });
      else if (e.type === 'text') out.push({ type: 'text', layer: lyr, p: flatten(e.p), h: e.h || 0.3, text: e.text || '' });
      else if (e.type === 'dim') {
        var pa = flatten(e.a), pb = flatten(e.b);
        out.push({ type: 'line', layer: lyr, a: pa, b: pb });
        var mp = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, 0];
        out.push({ type: 'text', layer: lyr, p: mp, h: (e.h || Math.max(0.15, (e.len || 1) * 0.06)), text: e.text != null ? e.text : formatLen(e.len || 0) });
      }
    });
    return out;
  }

  Session.prototype.toDxf = function (opts) {
    opts = opts || {};
    if (typeof module !== 'undefined' && module.exports) {
      var DXF = require('./dxf.js');
      return DXF.toDxf(toDxfEntities(this.entities, this.projection, this.layer, opts), { layers: [this.layer] });
    }
    var D = (typeof window !== 'undefined') ? window.DXF : null;
    if (!D) throw new Error('DXF module not loaded');
    return D.toDxf(toDxfEntities(this.entities, this.projection, this.layer, opts), { layers: [this.layer] });
  };

  var Draw2D = {
    Session: Session,
    project: project,
    unproject: unproject,
    fixedAxis: fixedAxis,
    rectCorners3D: rectCorners3D,
    toDxfEntities: toDxfEntities,
    sourcePlanPoint: sourcePlanPoint,
    sourceDxfPointToViewer: sourceDxfPointToViewer,
    fromSourceDxfEntities: fromSourceDxfEntities,
    dist2d: dist2d,
    dist3d: dist3d,
    formatLen: formatLen
  };
  if (typeof window !== 'undefined') window.Draw2D = Draw2D;
  if (typeof module !== 'undefined' && module.exports) module.exports = Draw2D;
})();
