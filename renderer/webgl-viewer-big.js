'use strict';
// Ревизия 17 — большие облака (читаются частями, >48 млн точек) со ВСЕМИ функциями: выделение, правка с откатом, чистка, классы, сохранение.
// Раньше (r16) такие облака лежали только в видеопамяти, и операции были заблокированы. Теперь копия каждой части (P/C/I/K) остаётся в оперативной
// памяти (renderer/big-cloud.js), а методы Viewer3DGL, которым нужны точки, подменяются здесь: если облако «большое» (bo._stream.cpu === true),
// работает версия ниже (асинхронная, с прогрессом и отменой), иначе — прежний метод (плоские массивы либо сообщение r16, когда памяти не хватило).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  try { if (root && root.Viewer3DGL && root.BigCloud) api.install(root.Viewer3DGL, root.BigCloud, root); } catch (e) { try { console.warn('[big] install', e); } catch (_) {} }
})(typeof window !== 'undefined' ? window : null, function () {
  function install(V, BC, W) {
    const P = V.prototype;
    if (P._bigInstalled) return;
    P._bigInstalled = true;
    const UNDO_DEPTH = 6, UNDO_BYTES = 3 * 1024 * 1024 * 1024, MAXH = 250000, OBJ_LIMIT = 25000000, WIN_LIMIT = 8000000;
    const bigOf = (v) => { const b = v.base && v.base[0]; return (b && b._stream && b._stream.cpu === true && b._segs) ? b : null; };
    const wrap = (name, impl) => { const orig = P[name]; P[name] = function () { return bigOf(this) ? impl.apply(this, arguments) : (typeof orig === 'function' ? orig.apply(this, arguments) : undefined); }; };
    const PE = () => (W && W.PCEdit) || null;
    const diagOfBox = (bb) => { if (!bb) return 8; const w = bb.mx[0] - bb.mn[0], h = bb.mx[1] - bb.mn[1], d = bb.mx[2] - bb.mn[2]; return Math.sqrt(w * w + h * h + d * d) || 8; };
    const selOf = (segs, masks) => { const s = new BC.BigSel(segs); for (let k = 0; k < segs.length; k++) s.m[k] = masks[k] || null; s.recount(); return s; };

    // ───────── общие помощники ─────────
    P.isBigCloud = function () { return !!bigOf(this); };
    P._bigNote = function (message, kind) {
      try { if (W && W.dispatchEvent && typeof CustomEvent === 'function') W.dispatchEvent(new CustomEvent('bim-big-notice', { detail: { message: String(message || ''), kind: kind || 'info' } })); } catch (_) {}
    };
    // Долгая операция: прогресс (общая карточка), отмена, защита от параллельных операций. → { value } | { cancelled } | { error } | { busy }
    P._bigRun = async function (label, fn) {
      if (this._bigBusy) { this._bigNote('Подождите: предыдущая операция с большим облаком ещё идёт.', 'warn'); return { busy: true }; }
      this._bigBusy = true;
      let cancelled = false;
      const L = W && W.__lxProgress, outer = (L && L.active && L.active.stop) ? L.active.stop : null;
      const own = (!outer && L && typeof L.begin === 'function') ? L.begin(label, { onCancel: function () { cancelled = true; } }) : null;
      const stop = outer || own, onCancelEvt = function () { cancelled = true; };
      try { W.addEventListener('lx-progress-cancel', onCancelEvt); } catch (_) {}
      const ctx = BC.makeCtx({ cancelled: function () { return cancelled; }, onProgress: function (f, t) { if (stop && typeof stop.set === 'function') { try { stop.set(f, t || undefined); } catch (_) {} } } });
      try { return { value: await fn(ctx) }; }
      catch (e) {
        if (e && (e.cancelled || e instanceof BC.Cancelled)) { this._bigNote('Операция отменена — облако не изменено.', 'info'); return { cancelled: true }; }
        try { console.warn('[big]', e); } catch (_) {}
        this._bigNote('Операция не выполнена: ' + String((e && e.message) || e), 'error'); return { error: e };
      } finally {
        try { W.removeEventListener('lx-progress-cancel', onCancelEvt); } catch (_) {}
        if (own) { try { own(); } catch (_) {} }
        this._bigBusy = false;
      }
    };
    P._bigSelCur = function () {
      const bo = bigOf(this); if (!bo) return null;
      if (!(this._sel instanceof BC.BigSel) || !this._sel.valid()) this._sel = new BC.BigSel(bo._segs);
      return this._sel;
    };
    // секущий бокс/срез как функция (x,y,z) → bool; null — ограничения нет; скрытое облако — ничего не выбирается
    P._bigInClip = function () {
      if (this.cloudVisible === false || (this._cloudDisplay && this._cloudDisplay.opacity === 0)) return function () { return false; };
      if (!this._clipActive()) return null;
      const b = this._clipBounds(); if (!b) return null;
      const mn = b.mn, mx = b.mx;
      return function (x, y, z) { return x >= mn[0] && x <= mx[0] && y >= mn[1] && y <= mx[1] && z >= mn[2] && z <= mx[2]; };
    };
    // Новое выделение; add/subtract как у плоского выделения (_selAccumulate)
    P._bigApplySel = function (sel, additive, subtract) {
      const bo = bigOf(this); if (!bo) return 0;
      const add = additive || (this._selAccumulate && !subtract);
      let cur = (this._sel instanceof BC.BigSel && this._sel.valid()) ? this._sel : null;
      if (subtract) { if (!cur) cur = new BC.BigSel(bo._segs); cur.subtract(sel); this._sel = cur; }
      else if (add && cur) { cur.union(sel); this._sel = cur; }
      else this._sel = sel;
      this._buildSelHighlight();
      if (typeof this.onEditSelect === 'function') this.onEditSelect(this._sel.size);
      this.render();
      return this._sel.size;
    };
    P._bigSetSel = function (sel) {
      this._sel = sel; this._buildSelHighlight();
      if (typeof this.onEditSelect === 'function') this.onEditSelect(this._sel.size);
      this.render(); return this._sel.size;
    };
    P._bigMeta = function () {
      const tr = this._srcXform, meta = {};
      if (tr && tr.t && tr.t.length >= 3) meta.srcXform = { axis: tr.axis, t: Array.prototype.slice.call(tr.t, 0, 3).map(Number) };
      if (this._srcCrs) meta.crsWkt = this._srcCrs;
      if (this._srcUnits) meta.units = this._srcUnits;
      return meta;
    };

    // ───────── видеопамять: сегменты ─────────
    P._bigGpuCreate = function (sg) {
      const gl = this.gl, T = gl.ARRAY_BUFFER, n = sg.n | 0;
      if (gl.getError) gl.getError();
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      const pb = gl.createBuffer(); gl.bindBuffer(T, pb); this._bigBufferData(sg.P.subarray(0, n * 3));
      gl.enableVertexAttribArray(this.aPos); gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 0, 0);
      let cb = null;
      if (sg.C && this.aColor >= 0) {
        cb = gl.createBuffer(); gl.bindBuffer(T, cb); gl.bufferData(T, sg.C.subarray(0, n * 3), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(this.aColor); gl.vertexAttribPointer(this.aColor, 3, gl.UNSIGNED_BYTE, true, 0, 0);
      }
      gl.bindVertexArray(null);
      if (gl.getError && gl.getError() === gl.OUT_OF_MEMORY) { try { gl.deleteVertexArray(vao); gl.deleteBuffer(pb); if (cb) gl.deleteBuffer(cb); } catch (_) {} return false; }
      sg.vao = vao; sg.pb = pb; sg.cb = cb; sg.ib = null; sg.kb = null;
      return true;
    };
    P._bigGpuDispose = function (sg) {
      const gl = this.gl; if (!gl || !sg) return;
      try { if (sg.vao) gl.deleteVertexArray(sg.vao); if (sg.pb) gl.deleteBuffer(sg.pb); if (sg.cb) gl.deleteBuffer(sg.cb); if (sg.ib) gl.deleteBuffer(sg.ib); if (sg.kb) gl.deleteBuffer(sg.kb); } catch (_) {}
      try { if (sg.rb) gl.deleteBuffer(sg.rb); } catch (_) {}
      sg.vao = null; sg.pb = null; sg.cb = null; sg.ib = null; sg.kb = null; sg.rb = null; sg.rbN = 0;
    };
    // дозаливка изменившегося хвоста сегмента (с точки from) в буферы видеопамяти
    P._bigUpload = function (sg, from) {
      const gl = this.gl, T = gl.ARRAY_BUFFER, n = sg.n | 0, CH = 8 * 1024 * 1024; if (from >= n) return;
      gl.bindBuffer(T, sg.pb);
      for (let i = from * 3; i < n * 3; i += CH) gl.bufferSubData(T, i * 4, sg.P.subarray(i, Math.min(n * 3, i + CH)));
      if (sg.cb && sg.C) { gl.bindBuffer(T, sg.cb); for (let i = from * 3; i < n * 3; i += CH) gl.bufferSubData(T, i, sg.C.subarray(i, Math.min(n * 3, i + CH))); }
      gl.bindBuffer(T, null);
    };
    // После любой правки сегментов: нумерация, видеопамять, габариты, выборка для процессора, кэши, события
    P._bigSync = function (o) {
      o = o || {};
      const bo = bigOf(this); if (!bo) return;
      const st = bo._stream, segs = bo._segs, gl = this.gl;
      BC.renumber(segs);
      for (const sg of segs) {
        if (!sg.vao) { if (!this._bigGpuCreate(sg)) this._bigNote('Видеопамяти не хватило для части точек — на экране они появятся после перезапуска (в памяти и в файле они есть).', 'warn'); else if (bo._radModel && this._segRadRefresh) this._segRadRefresh(bo, sg, 0); sg._dirtyFrom = null; continue; }
        if (sg._dirtyFrom != null) {
          this._bigUpload(sg, sg._dirtyFrom);
          if (bo._radModel && this._segRadRefresh) this._segRadRefresh(bo, sg, sg._dirtyFrom);
          sg._dirtyFrom = null;
          if (sg.ib) { try { gl.deleteBuffer(sg.ib); } catch (_) {} sg.ib = null; }
          if (sg.kb) { try { gl.deleteBuffer(sg.kb); } catch (_) {} sg.kb = null; }
        }
      }
      if (bo._radModel && !bo._radSegReady && this._startSegSpacing) { try { this._startSegSpacing(bo); } catch (_) {} }   // поле шага ещё считалось — заново по новым точкам
      if (o.dropClass || o.dropAll) this._segDropAttr(bo, 'classification');
      if (o.dropIntensity || o.dropAll) this._segDropAttr(bo, 'intensity');
      const N = BC.total(segs);
      bo._gpuCount = bo.count = N;
      const first = segs[0]; if (first) { bo._vao = first.vao; bo._pb = first.pb; bo._cb = first.cb; }
      const bb = BC.boundsOf(segs); if (bb) { bo.aabb = { mn: bb.mn.slice(), mx: bb.mx.slice() }; st.ub = { mn: bb.mn.slice(), mx: bb.mx.slice() }; }
      const anyK = segs.some(function (sg) { return !!sg.K; });
      if (anyK && !st.cls) st.cls = new Uint8Array(st.cap);
      if (!anyK && st.cls && o.classCleared) st.cls = null;
      BC.rebuildSample(segs, st);
      bo.pos = st.pos.subarray(0, st.filled * 3); bo.col = st.col.subarray(0, st.filled * 3);
      this._intensityValues = st.int ? st.int.subarray(0, st.filled) : null; bo.intensity = this._intensityValues;
      this._classificationLabels = st.cls ? st.cls.subarray(0, st.filled) : null; bo.classification = this._classificationLabels;
      this._psCache = null; this._psJob = null; this._yqCache = null; this._projCache = null; bo._planTakes = null; this._spTok = (this._spTok || 0) + 1;
      if (this._pickKeys) { this._pickKeys[0] = null; this._pickKeys[1] = null; }
      this._recomputeBBox();
      if (this._cloudRecord) { this._cloudRecord.loadedCount = N; this._cloudRecord.revision = (this._cloudRecord.revision | 0) + 1; this._cloudRecord.hasClassification = anyK; }
      if (!anyK && this._cloudColorMode === 'classification') { this._cloudColorMode = 'rgb'; this._ptElev = false; }
    };
    P._bigAfterEdit = function (o) {
      const bo = bigOf(this); if (!bo) return;
      this._bigSync(o);
      this._sel = new BC.BigSel(bo._segs); this._bigHL = null;
      if (this._selObj) { this._delObjs([this._selObj]); this._selObj = null; }
      this._notifyCloudChanged(); this.render();
      if (typeof this.onEditSelect === 'function') this.onEditSelect(0);
      if (typeof this.onEditChange === 'function') this.onEditChange(BC.total(bo._segs));
    };

    // ───────── откат ─────────
    P._bigPushUndo = function (rec, extra) {
      if (!rec) return;
      const arr = (this._undo = this._undo || []);
      arr.push(Object.assign({ big: true, rec: rec, bytes: BC.recBytes(rec) }, extra || {}));
      let bytes = 0; for (const e of arr) bytes += e.bytes || 0;
      while (arr.length > UNDO_DEPTH || (bytes > UNDO_BYTES && arr.length > 1)) { const x = arr.shift(); bytes -= (x && x.bytes) || 0; }
    };
    P._bigUndoRec = function (rec, flags) {
      const bo = bigOf(this), segs = bo._segs;
      switch (rec.kind) {
        case 'remove': BC.restoreRemoval(segs, rec); break;
        case 'compound': for (let k = rec.steps.length - 1; k >= 0; k--) this._bigUndoRec(rec.steps[k], flags); break;
        case 'append': { const i = segs.lastIndexOf(rec.seg); if (i >= 0) { this._bigGpuDispose(rec.seg); segs.splice(i, 1); } break; }
        case 'swap': { for (const sg of rec.newSegs) this._bigGpuDispose(sg); segs.splice.apply(segs, [0, segs.length].concat(rec.oldSegs)); break; }
        case 'assign': BC.restoreAssign(segs, rec); flags.cls = true; break;
        case 'labels': BC.restoreLabels(segs, rec); flags.cls = true; break;
        default: break;
      }
    };
    // Применяет удаление масками (+ откат); { removed, rec } | { error }
    P._bigRemove = function (masks, o) {
      const bo = bigOf(this), r = BC.removeMasks(bo._segs, masks, o || {});
      if (!r.ok) { this._bigNote('Не хватило оперативной памяти для записи отката — правка не выполнена, облако не изменено.', 'error'); return { error: 'memory' }; }
      return { removed: r.removed, rec: r.rec };
    };

    // Новая модель/облако заменяет текущее: выделение и записи отката «большого» облака к ней не относятся
    const origSetBase = P._setBase;
    if (typeof origSetBase === 'function') {
      P._setBase = function () {
        if (this._sel instanceof BC.BigSel) { this._sel = new Set(); this._bigHL = null; }
        if (this._undo && this._undo.length && this._undo.some(function (e) { return e && e.big; })) this._undo = this._undo.filter(function (e) { return !(e && e.big); });
        return origSetBase.apply(this, arguments);
      };
    }

    // ───────── выделение ─────────
    const RED = [0.898, 0.282, 0.302];
    P._bigShowHL = function (pos) {
      const bo = bigOf(this); if (this._selObj) { this._delObjs([this._selObj]); this._selObj = null; }
      if (!bo || !pos || !pos.length) { this.render(); return; }
      const size = Math.min((bo._ptMax || 6) + 1, 7);
      const o = this._makeObj({ id: null, points: true, pos: pos, col: null, pointSize: size, color: RED, status: 'none' });
      o._spacing = 0; o._ptMax = size; o._isSel = true; this._selObj = o; this.render();
    };
    wrap('_buildSelHighlight', function () {
      const bo = bigOf(this), sel = this._sel;
      if (this._selObj) { this._delObjs([this._selObj]); this._selObj = null; }
      if (!bo || !(sel instanceof BC.BigSel) || !sel.size) { this._bigHL = null; this.render(); return; }
      this._bigHL = BC.markerSample(bo._segs, sel, MAXH); this._bigShowHL(this._bigHL);
    });
    wrap('clearSelection', function () {
      const bo = bigOf(this); this._sel = new BC.BigSel(bo._segs); this._bigHL = null; this._smartSeed = null;
      if (this._selObj) { this._delObjs([this._selObj]); this._selObj = null; }
      if (typeof this.onEditSelect === 'function') this.onEditSelect(0);
      this.render();
    });
    wrap('invertSelection', function () {
      const cur = this._bigSelCur(); if (!cur) return;
      cur.invert(); this._bigSetSel(cur);
    });

    // Рамка / лассо: видимые точки ВСЕГО облака (GPU-проход даёт видимые ID, остальное — по кирпичам с отсечением)
    async function screenSelect(v, kind, additive, subtract) {
      const bo = bigOf(v), segs = bo._segs, pe = PE(); if (!pe) return 0;
      const rect = v.canvas.getBoundingClientRect(); let shape;
      if (kind === 'lasso') {
        if (!v._lasso || v._lasso.length < 3) return 0;
        shape = { kind: 'poly', poly: v._lasso.map(function (p) { return [(p[0] - rect.left) / rect.width * 2 - 1, 1 - (p[1] - rect.top) / rect.height * 2]; }) };
      } else {
        if (!v._selStart || !v._selCur) return 0;
        const r = v._rectToNDC(); shape = { kind: 'rect', x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 };
      }
      const M = Float64Array.from(v._lastVP || v._vp()), mode = v._selDepthMode == null ? 0 : v._selDepthMode, through = mode >= 2 || !!v._selThrough;
      let vis = null;
      if (!through) { try { const region = v._selRegionDev(kind); if (region) { const s = v._gpuVisibleSet(region.bbox, region.poly); if (s && s.size) vis = Array.from(s); } } catch (e) { vis = null; } }
      const diag = diagOfBox(v.bbox), sp = bo._spacing || 0;
      let voxel = sp ? sp * 3 : diag * 0.006; voxel = Math.min(Math.max(voxel, diag * 0.002), diag * 0.05);
      const o = { mode: mode, through: through, vis: vis, spacing: sp, diag: diag, inClip: v._bigInClip(), cssW: rect.width, cssH: rect.height, clusterVoxel: voxel,
        bandDefault: mode === 0 ? Math.min(Math.max(diag * 0.01, 0.05), 0.25) : Math.min(Math.max(diag * 0.05, 0.4), 3),
        cluster: function (pos, depth, vox, band) { const n = pos.length / 3, idx = new Array(n); for (let i = 0; i < n; i++) idx[i] = i; return pe.clusterFront(pos, idx, { depth: depth, voxel: vox, band: band }); } };
      const r = await v._bigRun('Выделение точек…', function (ctx) { return BC.selectScreen(segs, M, shape, o, ctx); });
      if (!r.value) return v.selectionCount();
      return v._bigApplySel(r.value, additive, subtract);
    }
    wrap('_finishMarquee', function (additive, subtract) { return screenSelect(this, 'rect', additive, subtract); });
    wrap('_finishLasso', function (additive, subtract) { return screenSelect(this, 'lasso', additive, subtract); });
    wrap('selectRegion', async function (x0c, y0c, x1c, y1c) {
      this._selStart = [x0c, y0c]; this._selCur = [x1c, y1c];
      try { await this._finishMarquee(false, false); } catch (e) { return 0; }
      return this.selectionCount();
    });
    wrap('extractRegionAsObject', async function (x0c, y0c, x1c, y1c, name) {
      const n = await this.selectRegion(x0c, y0c, x1c, y1c); if (!n) return null;
      return this.extractSelectionAsObject(name);
    });

    // Кисть: сетка 3 px из ID-буфера (передний слой в каждой ячейке), подсветка добавляется постепенно
    wrap('_buildBrushGrid', function () {
      const bo = bigOf(this), gl = this.gl; this._brushGrid = null;
      if (!this._pickReady) this._pickInit();
      if (!this._pickReady) { this._bigNote('Кисть недоступна: видеокарта не поддерживает проход выбора. Используйте рамку или лассо.', 'warn'); return; }
      if (this._pickW !== this.canvas.width || this._pickH !== this.canvas.height) this._pickResize();
      if (!this._bigHL && this._sel && this._sel.size) this._buildSelHighlight();
      const cw = this.canvas.width, ch = this.canvas.height, rect = this.canvas.getBoundingClientRect();
      const fbo = this._drawPickPass(bo, 0), px = new Uint32Array(cw * ch);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.readPixels(0, 0, cw, ch, gl.RED_INTEGER, gl.UNSIGNED_INT, px); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, cw, ch); gl.useProgram(this.prog);
      const cellPx = 3, gw = Math.max(1, Math.ceil(Math.max(1, rect.width) / cellPx)), gh = Math.max(1, Math.ceil(Math.max(1, rect.height) / cellPx));
      const frontI = new Int32Array(gw * gh).fill(-1), sx = Math.max(1, rect.width) / cw, sy = Math.max(1, rect.height) / ch;
      for (let y = 0; y < ch; y++) {
        const gy = Math.min(gh - 1, ((ch - 1 - y) * sy / cellPx) | 0), row = y * cw;
        for (let x = 0; x < cw; x++) { const id = px[row + x]; if (!id) continue; const k = gy * gw + Math.min(gw - 1, (x * sx / cellPx) | 0); if (frontI[k] < 0) frontI[k] = id - 1; }
      }
      this._brushGrid = { gw: gw, gh: gh, cellPx: cellPx, frontI: frontI, frontD: null, rect: rect };
    });
    wrap('_brushAt', function (cx, cy, subtract) {
      const g = this._brushGrid; if (!g) return;
      const bo = bigOf(this), segs = bo._segs, rect = g.rect, cell = g.cellPx, px = cx - rect.left, py = cy - rect.top, R = this._brushRadius || 16;
      const gcx = px / cell, gcy = py / cell, gr = R / cell, r2 = gr * gr, gw = g.gw, gh = g.gh, fI = g.frontI;
      const x0 = Math.max(0, Math.floor(gcx - gr)), x1 = Math.min(gw - 1, Math.ceil(gcx + gr)), y0 = Math.max(0, Math.floor(gcy - gr)), y1 = Math.min(gh - 1, Math.ceil(gcy + gr));
      const sel = this._bigSelCur(), inClip = this._bigInClip(), added = []; let changed = false, dropped = false;
      for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
        const ddx = gx + 0.5 - gcx, ddy = gy + 0.5 - gcy; if (ddx * ddx + ddy * ddy > r2) continue;
        const i = fI[gy * gw + gx]; if (i < 0) continue;
        if (subtract) { if (sel.delete(i)) { changed = true; dropped = true; } }
        else if (!sel.has(i)) {
          const p = BC.pointAt(segs, i); if (!p) continue;
          if (inClip && !inClip(p[0], p[1], p[2])) continue;
          sel.add(i); changed = true; added.push(p[0], p[1], p[2]);
        }
      }
      if (!changed) return;
      if (dropped) this._buildSelHighlight();
      else {
        const base = this._bigHL || new Float32Array(0);
        if (base.length < MAXH * 3) { const cap = Math.min(added.length, MAXH * 3 - base.length), out = new Float32Array(base.length + cap); out.set(base, 0); for (let k = 0; k < cap; k++) out[base.length + k] = added[k]; this._bigHL = out; this._bigShowHL(out); }
        else this.render();
      }
      if (typeof this.onEditSelect === 'function') this.onEditSelect(sel.size);
    });

    // Ближайшая к точке pt точка облака (поиск по кирпичам), -1 если рядом ничего нет
    P._bigNearest = function (pt, r0) {
      const bo = bigOf(this), segs = bo._segs;
      for (let att = 0, r = r0; att < 4; att++, r *= 3) {
        const pred = BC.boxNearSphere(pt, r); let best = -1, bd = r * r;
        for (const sg of segs) {
          const n = sg.n, CH = Math.max(1000, sg.chunk | 0) || 1000000, nc = Math.ceil(n / CH), B = sg.boxes, Pp = sg.P;
          for (let c = 0; c < nc; c++) {
            if (B && !pred(B, c * 6)) continue;
            for (let i = c * CH, e = Math.min(n, i + CH); i < e; i++) { const dx = Pp[i * 3] - pt[0], dy = Pp[i * 3 + 1] - pt[1], dz = Pp[i * 3 + 2] - pt[2], d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; best = sg.start + i; } }
          }
        }
        if (best >= 0) return best;
      }
      return -1;
    };
    // Номер точки под курсором: из GPU-прохода (точный) либо ближайшая к лучу
    P._bigPickIndex = function (cx, cy) {
      const bo = bigOf(this), total = BC.total(bo._segs);
      let pg = null; try { pg = this._pickGPU(cx, cy); } catch (_) { pg = null; }
      if (pg && pg.index != null && pg.index >= 0 && pg.index < total) return pg.index | 0;
      const hit = this._pick(cx, cy); if (!hit || !hit.point) return -1;
      return this._bigNearest(hit.point, (bo._spacing > 0 ? bo._spacing * 3 : 0.05));
    };
    wrap('_pickIndex', function (cx, cy) { return this._bigPickIndex(cx, cy); });

    // Простые инструменты выделения
    wrap('selectBox', async function (mn, mx) {
      const bo = bigOf(this), clip = this._bigInClip();
      const r = await this._bigRun('Выделение в боксе…', function (ctx) { return BC.selectBox(bo._segs, mn, mx, { inClip: clip, ctx: ctx }); });
      return r.value ? this._bigSetSel(r.value) : this.selectionCount();
    });
    wrap('selectSphere', async function (center, radius) {
      const bo = bigOf(this), clip = this._bigInClip();
      const r = await this._bigRun('Выделение шаром…', function (ctx) { return BC.selectSphere(bo._segs, center, radius, { inClip: clip, ctx: ctx }); });
      return r.value ? this._bigSetSel(r.value) : this.selectionCount();
    });
    wrap('selectSphereAt', async function (cx, cy, radius) {
      const hit = this._pick(cx, cy); if (!hit || !hit.point) return 0;
      return this.selectSphere(hit.point, radius || 0.5);
    });
    wrap('selectColorAt', async function (cx, cy, tol) {
      const bo = bigOf(this), segs = bo._segs, seed = this._bigPickIndex(cx, cy); if (seed < 0) return 0;
      const c = BC.colorAt(segs, seed); if (!c) return 0; const clip = this._bigInClip();
      const r = await this._bigRun('Выделение по цвету…', function (ctx) { return BC.selectColor(segs, c, tol || 40, { inClip: clip, ctx: ctx }); });
      return r.value ? this._bigSetSel(r.value) : this.selectionCount();
    });
    wrap('selectInSlice', async function () {
      const bo = bigOf(this), segs = bo._segs, hidden = this.cloudVisible === false || (this._cloudDisplay && this._cloudDisplay.opacity === 0);
      const b = this._clipActive() ? this._clipBounds() : null;
      if (hidden) return this._bigSetSel(new BC.BigSel(segs));
      const r = await this._bigRun('Выделение в срезе…', async function (ctx) {
        if (b) return BC.selectBox(segs, b.mn, b.mx, { ctx: ctx });
        const s = new BC.BigSel(segs); s.invert(); return s;
      });
      return r.value ? this._bigSetSel(r.value) : this.selectionCount();
    });

    // Магическая палочка / умный объект: рост области в окне вокруг точки (≤ 8 млн точек, радиус уменьшается при нехватке)
    async function wandSelect(v, seed, opts, ctx) {
      const bo = bigOf(v), segs = bo._segs, pe = PE(), sp = bo._spacing || 0, voxel = sp > 0 ? sp * 2 : undefined, c = BC.pointAt(segs, seed), diag = diagOfBox(v.bbox);
      const R = Math.max((voxel || diag * 0.004) * 250, diag * 0.18);
      const win = await BC.windowAround(segs, c, R, WIN_LIMIT, ctx);
      if (!win || !win.count) return { sel: new BC.BigSel(segs), point: c };
      const ws = win.segs[0]; let local = -1; for (let i = 0; i < ws.n; i++) if (ws.src[i] === seed) { local = i; break; }
      if (local < 0) return { sel: new BC.BigSel(segs), point: c };
      const idx = pe.magicWand(local, win.pos, win.count, { voxel: voxel, planes: opts.planes || null, maxPts: opts.maxPts });
      const m0 = new Uint8Array(ws.n); for (let k = 0; k < idx.length; k++) m0[idx[k]] = 1;
      const sel = selOf(segs, win.mapBack([m0]));
      const inClip = v._bigInClip();
      if (inClip && sel.size) await BC.eachBrick(segs, ctx, null, function (sg, s, i0, i1) { const m = sel.m[s]; if (!m) return; const Pp = sg.P; for (let i = i0; i < i1; i++) if (m[i] && !inClip(Pp[i * 3], Pp[i * 3 + 1], Pp[i * 3 + 2])) m[i] = 0; });
      sel.recount();
      return { sel: sel, point: c };
    }
    wrap('magicWandAt', async function (cx, cy) {
      const pe = PE(); if (!pe || !pe.magicWand) return 0;
      const seed = this._bigPickIndex(cx, cy); if (seed < 0) return 0;
      let planes = null; if (this._planeProtect) { if (!(this._planes && this._planes.length)) this.detectFloorWalls(); planes = this._planes; }
      const self = this, r = await this._bigRun('Магическая палочка…', function (ctx) { return wandSelect(self, seed, { planes: planes }, ctx); });
      return r.value ? this._bigSetSel(r.value.sel) : this.selectionCount();
    });
    wrap('smartObjectAt', async function (cx, cy, opts) {
      const pe = PE(); if (!pe || !pe.magicWand) return 0;
      const seed = this._bigPickIndex(cx, cy); if (seed < 0) return 0;
      const self = this, r = await this._bigRun('Захват объекта…', function (ctx) { return wandSelect(self, seed, { maxPts: (opts && opts.maxPts) || 800000 }, ctx); });
      if (!r.value) return this.selectionCount();
      const n = this._bigSetSel(r.value.sel); this._smartSeed = { sel: this._sel, point: r.value.point }; return n;
    });

    // Выделение → отдельный объект (не меняет облако); не больше 25 млн точек
    wrap('extractSelectionAsObject', function (name) {
      const bo = bigOf(this), sel = this._sel; if (!(sel instanceof BC.BigSel) || !sel.size) return null;
      if (sel.size > OBJ_LIMIT) { this._bigNote('Выделено ' + sel.size.toLocaleString('ru-RU') + ' точек — для отдельного объекта слишком много (предел ' + OBJ_LIMIT.toLocaleString('ru-RU') + '). Выделите меньшую часть.', 'warn'); return null; }
      const g = BC.gather(bo._segs, sel, OBJ_LIMIT); if (!g || !g.count) return null;
      let col = null; if (g.col) { col = new Float32Array(g.col.length); for (let i = 0; i < col.length; i++) col[i] = g.col[i] / 255; }
      const count = g.count, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], pos = g.pos;
      for (let i = 0; i < count; i++) for (let a = 0; a < 3; a++) { const x = pos[i * 3 + a]; if (x < mn[a]) mn[a] = x; if (x > mx[a]) mx[a] = x; }
      this._objects = this._objects || []; this._objSeq = (this._objSeq || 0) + 1;
      const meta = {};
      if (this._srcXform && (this._srcXform.axis === 'zup' || this._srcXform.axis === 'yup') && this._srcXform.t && this._srcXform.t.length >= 3) meta.srcXform = { axis: this._srcXform.axis, t: Array.prototype.slice.call(this._srcXform.t, 0, 3).map(Number) };
      if (this._srcCrs) meta.crsWkt = this._srcCrs;
      if (this._smartSeed && this._smartSeed.sel === this._sel && this._smartSeed.point) meta.seed = this._smartSeed.point.slice();
      const obj = { id: 'obj-' + this._objSeq, name: name || ('Объект ' + this._objSeq), pos: pos, col: col, count: count, bbox: { mn: mn, mx: mx }, meta: meta };
      this._objects.push(obj);
      return { id: obj.id, name: obj.name, count: obj.count, bbox: obj.bbox };
    });

    // ───────── правка: удаление / обрезка / откат ─────────
    // Удаление (keep=false) или обрезка по выделению (keep=true). Защита пола и стен и латание дыр — как у плоского облака
    // (плоскости подгоняются по выборке вокруг выделения; заплатки идут отдельным сегментом и откатываются вместе с удалением).
    P._bigApplyEdit = async function (keep, force) {
      const bo = bigOf(this), pe = PE(), sel = this._sel;
      if (!bo || !(sel instanceof BC.BigSel) || !sel.valid() || !sel.size) return 0;
      const self = this, segs = bo._segs, sp = bo._spacing || 0;
      const protect = !keep && !force && !!this._planeProtect && !!pe && typeof pe.protectFloorPlanes === 'function';
      const fill = protect && !!this._holeFill && !!(this._planes && this._planes.length) && typeof pe.fillPlaneHoles === 'function';
      const r = await this._bigRun(keep ? 'Обрезка по выделению…' : 'Удаление выделенных точек…', async function (ctx) {
        self._lastProtectRemoved = 0;
        if (protect) {
          try {
            const before = sel.size, b = BC.selBounds(segs, sel);
            if (b && isFinite(b.mn[0])) {
              const sx = b.mx[0] - b.mn[0], sy = b.mx[1] - b.mn[1], sz = b.mx[2] - b.mn[2], seldiag = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
              const margin = Math.max(seldiag * 0.5, sp * 20, 0.4), lmn = [b.mn[0] - margin, b.mn[1] - margin, b.mn[2] - margin], lmx = [b.mx[0] + margin, b.mx[1] + margin, b.mx[2] + margin];
              const w = await BC.windowSample(segs, lmn, lmx, 60000, ctx);
              if (w.total >= 64) {
                const ldx = lmx[0] - lmn[0], ldy = lmx[1] - lmn[1], ldz = lmx[2] - lmn[2], ldiag = Math.sqrt(ldx * ldx + ldy * ldy + ldz * ldz) || 1;
                const pp = pe.protectFloorPlanes(w.pos, w.count, ldiag, sp, { maxPlanes: 8, protTol: (self._protectWidthM > 0 ? self._protectWidthM : undefined), minFrac: (self._protectMinFrac > 0 ? self._protectMinFrac : undefined), smart: (self._smartProtect === false ? false : true) });
                if (pp) await BC.unselectOnPlanes(segs, sel, pp.planes, pp.protTol, ctx);
              }
            }
            self._lastProtectRemoved = Math.max(0, before - sel.size);
          } catch (e) {
            sel.recount();
            if (e && (e.cancelled || e instanceof BC.Cancelled)) throw e;
            try { console.warn('[big] protect', e); } catch (_) {}
          }
        }
        if (!sel.size) return { removed: 0 };
        const rr = self._bigRemove(sel.m, { keep: keep });
        if (rr.error) return { removed: 0 };
        const steps = [rr.rec]; let filled = 0;
        // латание дыр на защищённых плоскостях: окно вокруг удалённого, заплатки — отдельным сегментом в конец
        if (fill) {
          try {
            const rp = [];
            for (const q of rr.rec.recs) { const stp = Math.max(1, Math.ceil(q.R / 1500000)); for (let i = 0; i < q.R; i += stp) rp.push(q.P[i * 3], q.P[i * 3 + 1], q.P[i * 3 + 2]); }
            if (rp.length >= 9) {
              const removedPos = Float32Array.from(rp), rb = { mn: [Infinity, Infinity, Infinity], mx: [-Infinity, -Infinity, -Infinity] };
              for (let i = 0; i < removedPos.length; i += 3) for (let a = 0; a < 3; a++) { const v = removedPos[i + a]; if (v < rb.mn[a]) rb.mn[a] = v; if (v > rb.mx[a]) rb.mx[a] = v; }
              const bbAll = BC.boundsOf(segs), diagTotal = bbAll ? diagOfBox(bbAll) : 8, step = sp > 0 ? sp : Math.max(diagTotal * 0.003, 1e-3), mrg = Math.max(step * 20, diagTotal * 0.03);
              const wmn = [rb.mn[0] - mrg, rb.mn[1] - mrg, rb.mn[2] - mrg], wmx = [rb.mx[0] + mrg, rb.mx[1] + mrg, rb.mx[2] + mrg];
              const cnt = await BC.countBox(segs, wmn, wmx, ctx);
              if (cnt > 0 && cnt <= WIN_LIMIT) {
                const cs = await BC.clipSubset(segs, wmn, wmx, { attrs: true, maxSeg: 1 << 30 }, ctx);
                if (cs.segs.length) {
                  const ws = cs.segs[0];
                  const fr = pe.fillPlaneHoles({ pos: ws.P, col: ws.C }, self._planes, removedPos, { step: step, band: diagTotal * 0.5 });
                  if (fr && fr.added) {
                    const col = (fr.addedCol && fr.addedCol.length === fr.addedPos.length) ? Uint8Array.from(fr.addedCol) : null;
                    const seg = BC.appendSegment(segs, Float32Array.from(fr.addedPos), col);
                    steps.push({ kind: 'append', seg: seg, bytes: 0 }); filled = fr.added;
                  }
                }
              }
            }
          } catch (e) { if (e && (e.cancelled || e instanceof BC.Cancelled)) { /* заплатки не обязательны: удаление уже выполнено */ } else { try { console.warn('[big] fillPlaneHoles', e); } catch (_) {} } }
        }
        self._bigPushUndo(steps.length > 1 ? { kind: 'compound', steps: steps } : steps[0]);
        self._bigAfterEdit({});
        return { removed: rr.removed, filled: filled };
      });
      if (r.cancelled) { try { this._buildSelHighlight(); } catch (_) {} }
      return r.value ? (r.value.removed | 0) : 0;
    };
    wrap('_applyEdit', function (keep) { return this._bigApplyEdit(!!keep, false); });
    wrap('deleteSelection', function () { return this._bigApplyEdit(false, false); });
    wrap('cropToSelection', function () { return this._bigApplyEdit(true, false); });
    wrap('deleteSelectionForce', function () { return this._bigApplyEdit(false, true); });

    // Откат последней правки (синхронный, как у плоского облака): точки возвращаются на свои места побайтно
    wrap('undoEdit', function () {
      const bo = bigOf(this), arr = this._undo;
      if (this._bigBusy) { this._bigNote('Подождите: операция с большим облаком ещё идёт.', 'warn'); return false; }
      if (!arr || !arr.length) return false;
      const e = arr[arr.length - 1]; if (!e || !e.big) return false;
      arr.pop();
      const flags = {};
      try { this._bigUndoRec(e.rec, flags); }
      catch (err) { arr.push(e); this._bigNote('Не удалось откатить правку: ' + String((err && err.message) || err), 'error'); return false; }
      const anyK = bo._segs.some(function (sg) { return !!sg.K; });
      this._bigAfterEdit(flags.cls ? { dropClass: true, classCleared: !anyK } : { classCleared: !anyK });
      if (flags.cls) {
        if (anyK) this._lastClassificationPromise = this._bigPersistClasses('manual LAS/ASPRS class assignment (undo)', { undo: true }, {}, e.target);
        else this._lastClassificationPromise = this._persistClassificationClear(e.target);
      }
      return true;
    });

    // ───────── чистка ─────────
    const isCancel = (e) => !!(e && (e.cancelled || e instanceof BC.Cancelled));
    // Проход чистки: вычисляет маски удаления либо по всему облаку, либо (при активном секущем боксе) по копии точек внутри бокса.
    // compute(segs2, ctx) → { removed, masks }; результат — маски над настоящими сегментами.
    async function maskedPass(v, ctx, compute) {
      const bo = bigOf(v), segs = bo._segs;
      if (!v._clipActive()) { const r = await compute(segs, ctx); return { removed: r.removed | 0, masks: r.masks, info: r }; }
      const b = v._clipBounds();
      if (!b) { const r = await compute(segs, ctx); return { removed: r.removed | 0, masks: r.masks, info: r }; }
      const cs = await BC.clipSubset(segs, b.mn, b.mx, { attrs: false }, ctx);
      if (!cs.count) return { removed: 0, masks: new Array(segs.length).fill(null), info: null };
      const r = await compute(cs.segs, ctx);
      if (!r.removed) return { removed: 0, masks: new Array(segs.length).fill(null), info: r };
      const masks = cs.mapBack(r.masks);
      return { removed: masks.count | 0, masks: masks, info: r };
    }
    // Одна чистка = маски → удаление → запись отката → обновление; возвращает число удалённых точек
    async function cleanRun(v, label, compute) {
      const r = await v._bigRun(label, async function (ctx) {
        const p = await maskedPass(v, ctx, compute);
        if (!p.removed) return 0;
        const rr = v._bigRemove(p.masks, {});
        if (rr.error || !rr.removed) return 0;
        v._bigPushUndo(rr.rec);
        v._bigAfterEdit({});
        return rr.removed;
      });
      return r.value | 0;
    }
    const spOf = (v) => { const bo = bigOf(v); return (bo && bo._spacing > 0) ? bo._spacing : 0; };
    wrap('cleanInApp', function (opts) {
      const o = Object.assign({}, opts || {}), sp = spOf(this);
      if (o.voxel == null && sp > 0) o.voxel = sp * (o.voxelFactor || 3);
      return cleanRun(this, 'Чистка шума…', function (sg, c) { return BC.densityMasks(sg, o, c); });
    });
    wrap('cleanClustersInApp', function (opts) {
      const o = Object.assign({}, opts || {}), sp = spOf(this);
      if (o.voxel == null && sp > 0) o.voxel = sp * (o.connect || 4);
      return cleanRun(this, 'Удаление отдельных кластеров…', function (sg, c) { return BC.clusterMasks(sg, o, c); });
    });
    wrap('cleanSORInApp', function (opts) {
      const o = Object.assign({}, opts || {}), sp = spOf(this);
      if (o.voxel == null && sp > 0) o.voxel = sp * 3;
      return cleanRun(this, 'Статистическая чистка…', function (sg, c) { return BC.sorMasks(sg, o, c); });
    });
    wrap('cleanRadiusInApp', function (opts) {
      const o = Object.assign({}, opts || {}), sp = spOf(this);
      if (o.radius == null && sp > 0) o.radius = sp * (o.radiusFactor || 5);
      return cleanRun(this, 'Чистка по радиусу…', function (sg, c) { return BC.radiusMasks(sg, o, c); });
    });
    wrap('noiseFilterInApp', function (opts) {
      const o = Object.assign({}, opts || {}), sp = spOf(this);
      if (o.voxel == null && sp > 0) o.voxel = sp * (o.voxelFactor || 2);
      return cleanRun(this, 'Фильтр шума по плоскости…', function (sg, c) { return BC.noiseMasks(sg, o, c); });
    });
    wrap('sliceKeepInApp', function (opts) {
      const o = Object.assign({}, opts || {});
      return cleanRun(this, 'Срез…', function (sg, c) { return BC.sliceMasks(sg, o, c); });
    });
    // Убрать мелкие островки (+ «мушки» тесным радиусом, если нет секущего бокса)
    wrap('cleanIslandsInApp', async function (opts) {
      const self = this, bo = bigOf(this), segs = bo._segs, n = BC.total(segs), o = Object.assign({}, opts || {}), sp = spOf(this);
      if (o.voxel == null && sp > 0) o.voxel = sp * (o.voxelFactor || 2);
      if (o.minClusterPts == null) o.minClusterPts = Math.max(120, Math.round(n * 0.0003));
      const r = await this._bigRun('Удаление островков…', async function (ctx) {
        const steps = []; let removed = 0, err = null;
        try {
          const p1 = await maskedPass(self, ctx, function (sg, c) { return BC.clusterMasks(sg, o, c); });
          if (p1.removed) { const rr = self._bigRemove(p1.masks, {}); if (!rr.error) { steps.push(rr.rec); removed += rr.removed; } }
          if (!self._clipActive() && o.despeckle !== false && sp > 0) {
            const p2 = await BC.radiusMasks(segs, { radius: sp * (o.despeckleRadius || 3), minNeighbors: (o.despeckleMinN || 1) }, ctx);
            if (p2.removed && p2.removed <= n * (o.despeckleMaxFrac || 0.03)) { const rr = self._bigRemove(p2.masks, {}); if (!rr.error) { steps.push(rr.rec); removed += rr.removed; } }
          }
        } catch (e) { err = e; }
        if (steps.length) { self._bigPushUndo(steps.length > 1 ? { kind: 'compound', steps: steps } : steps[0]); self._bigAfterEdit({}); }
        if (err) { if (isCancel(err) && steps.length) self._bigNote('Операция отменена после первого шага: удалено ' + removed.toLocaleString('ru-RU') + ' точек (Ctrl+Z откатит).', 'info'); else throw err; }
        return removed;
      });
      return r.value | 0;
    });
    // «Авто»: несколько проходов SOR (только первые два и не выше порога) → плотность → кластеры, пока есть что убирать
    wrap('cleanAutoInApp', async function (opts) {
      const self = this, bo = bigOf(this), segs = bo._segs, o = Object.assign({}, opts || {}), sp = spOf(this);
      if (o.voxel == null && sp > 0) o.voxel = sp * (o.voxelFactor || 3);
      const r = await this._bigRun('Автоочистка…', async function (ctx) {
        const steps = [], brk = { sor: 0, density: 0, clusters: 0 }; let passes = 0, removedAll = 0, err = null, stop = false;
        const apply = async function (kind, compute) {
          const p = await maskedPass(self, ctx, compute); if (!p.removed) return 0;
          const rr = self._bigRemove(p.masks, {}); if (rr.error || !rr.removed) { stop = true; return 0; }
          steps.push(rr.rec); brk[kind] += rr.removed; removedAll += rr.removed; return rr.removed;
        };
        try {
          const maxPasses = o.maxPasses != null ? o.maxPasses : 5, minFrac = o.minRemovedFrac != null ? o.minRemovedFrac : 0.0008, sorMax = o.maxSorPoints != null ? o.maxSorPoints : 1500000;
          for (let p = 0; p < maxPasses && !stop; p++) {
            const b0 = BC.total(segs); if (b0 < 32) break;
            if (p < 2 && b0 <= sorMax) await apply('sor', function (sg, c) { return BC.sorMasks(sg, { k: 16, stdRatio: (o.stdRatio != null ? o.stdRatio : 2.2), voxel: o.voxel || undefined }, c); });
            if (stop) break;
            await apply('density', function (sg, c) { return BC.densityMasks(sg, { voxel: o.voxel || undefined, minPts: 3 + p }, c); });
            if (stop) break;
            await apply('clusters', function (sg, c) { return BC.clusterMasks(sg, { voxel: o.voxel || undefined, minClusterPts: Math.round(50 * Math.pow(1.6, p)), connect: 4 }, c); });
            passes++;
            if (b0 - BC.total(segs) <= b0 * minFrac) break;
          }
        } catch (e) { err = e; }
        if (steps.length) { self._bigPushUndo(steps.length > 1 ? { kind: 'compound', steps: steps } : steps[0]); self._bigAfterEdit({}); }
        if (err) { if (isCancel(err) && steps.length) self._bigNote('Автоочистка прервана: уже удалено ' + removedAll.toLocaleString('ru-RU') + ' точек (Ctrl+Z откатит), остальное не тронуто.', 'info'); else throw err; }
        return { removed: removedAll, passes: passes, breakdown: brk };
      });
      return r.value || null;
    });
    // Прореживание вокселями: один центроид на воксель по ВСЕМУ облаку. Без секущего бокса — замена всех сегментов (откат возвращает старые),
    // с боксом — точки внутри заменяются прореженными.
    wrap('voxelDownsampleInApp', async function (opts) {
      const self = this, bo = bigOf(this), segs = bo._segs, o = Object.assign({}, opts || {}), sp = spOf(this);
      if (o.voxel == null && sp > 0) o.voxel = sp * (o.voxelFactor || 2);
      const before = BC.total(segs);
      const r = await this._bigRun('Прореживание точек…', async function (ctx) {
        const clipB = self._clipActive() ? self._clipBounds() : null;
        if (!clipB) {
          const ds = await BC.voxelDownsample(segs, { voxel: o.voxel, maxSeg: o.maxSeg }, ctx);
          if (!ds.ok) { self._bigNote('Не хватило оперативной памяти для прореживания — облако не изменено.', 'error'); return 0; }
          if (!ds.segs || !ds.segs.length || !(ds.removed > 0)) return 0;
          const oldSegs = segs.slice(); let bytes = 0;
          for (const sg of oldSegs) { bytes += sg.P.byteLength + (sg.C ? sg.C.byteLength : 0) + (sg.I ? sg.I.byteLength : 0) + (sg.K ? sg.K.byteLength : 0); self._bigGpuDispose(sg); }
          segs.splice.apply(segs, [0, segs.length].concat(ds.segs)); BC.renumber(segs);
          self._bigPushUndo({ kind: 'swap', oldSegs: oldSegs, newSegs: ds.segs.slice(), bytes: bytes });
          self._bigAfterEdit({}); return before - BC.total(segs);
        }
        const cs = await BC.clipSubset(segs, clipB.mn, clipB.mx, { attrs: true, maxSeg: 1 << 30 }, ctx);
        if (!cs.count) return 0;
        const ds = await BC.voxelDownsample(cs.segs, { voxel: o.voxel, maxSeg: o.maxSeg }, ctx);
        if (!ds.ok) { self._bigNote('Не хватило оперативной памяти для прореживания — облако не изменено.', 'error'); return 0; }
        if (!ds.segs || !ds.segs.length || !(ds.removed > 0)) return 0;
        const rr = self._bigRemove(cs.mapBack(cs.allMasks()), {}); if (rr.error) return 0;
        const steps = [rr.rec];
        for (const sg of ds.segs) { sg.src = null; segs.push(sg); steps.push({ kind: 'append', seg: sg, bytes: 0 }); }
        BC.renumber(segs);
        self._bigPushUndo({ kind: 'compound', steps: steps });
        self._bigAfterEdit({}); return before - BC.total(segs);
      });
      return r.value | 0;
    });

    // ───────── классификация ─────────
    // Пол/стены по выборке (≤ 1,5 млн точек): плоскости нужны для защиты конструктива и палочки
    wrap('detectFloorWalls', function (opts) {
      const bo = bigOf(this), pe = PE(); if (!bo || !pe || !pe.detectPlanes) return [];
      const sp = bo._spacing || 0, CAP = 1500000; let pos = bo.pos, n = Math.floor(pos.length / 3);
      if (n > CAP) { const st = n / CAP, out = new Float32Array(CAP * 3); for (let i = 0; i < CAP; i++) { const j = Math.min(n - 1, (i * st) | 0); out[i * 3] = pos[j * 3]; out[i * 3 + 1] = pos[j * 3 + 1]; out[i * 3 + 2] = pos[j * 3 + 2]; } pos = out; n = CAP; }
      this._planes = pe.detectPlanes(pos, n, Object.assign({ maxPlanes: 8, minFrac: 0.02, tol: (sp > 0 ? Math.max(sp * 6, 0.10) : undefined) }, opts || {}));
      return this._planes;
    });
    // Метки классов ВСЕХ точек в проект (ресурс классификации ограничен 128 МиБ — для облаков крупнее метки живут в памяти и в сохраняемых файлах)
    P._bigPersistClasses = function (algorithm, parameters, counts, target) {
      const bo = bigOf(this), segs = bo._segs, N = BC.total(segs), LIM = 128 * 1024 * 1024;
      if (N > LIM) { this._bigNote('Метки классов ' + N.toLocaleString('ru-RU') + ' точек не умещаются в ресурс проекта (предел ' + LIM.toLocaleString('ru-RU') + '): они сохранены в памяти и попадут в LAS/PLY при сохранении и экспорте.', 'info'); return Promise.resolve({ ok: false, error: 'too_large' }); }
      return this._persistClassificationAsset(BC.labelsFlat(segs), algorithm, parameters, counts, target);
    };
    // Метки для всех точек облака (плоский массив длины = числу точек)
    wrap('applyClassificationLabels', function (labels, selectClass) {
      const bo = bigOf(this), segs = bo._segs, N = BC.total(segs);
      if (!labels || labels.length !== N) return false;
      const data = labels instanceof Uint8Array ? labels : new Uint8Array(labels);
      BC.applyLabelsBySeg(segs, segs.map(function (sg) { return data.subarray(sg.start, sg.start + sg.n); }));
      this._bigSync({ dropClass: true });
      if (selectClass != null) this._bigSelectClass(selectClass);
      this.render(); this._notifyCloudChanged();
      return true;
    });
    P._bigSelectClass = function (code) {
      const bo = bigOf(this), segs = bo._segs, sel = new BC.BigSel(segs); let t = 0;
      for (let s = 0; s < segs.length; s++) { const K = segs[s].K; if (!K) { if (code === 0) { sel.m[s] = new Uint8Array(segs[s].n).fill(1); t += segs[s].n; } continue; } let m = null; for (let i = 0, n = segs[s].n; i < n; i++) if (K[i] === code) { if (!m) m = new Uint8Array(n); m[i] = 1; t++; } sel.m[s] = m; }
      sel.size = t; this._bigSetSel(sel); return t;
    };
    wrap('getClassificationLabels', function () {
      const bo = bigOf(this); if (!bo._segs.some(function (sg) { return !!sg.K; })) return null;
      return BC.labelsFlat(bo._segs);
    });
    wrap('clearClassificationLabels', function () {
      const bo = bigOf(this), segs = bo._segs, gl = this.gl;
      if (!segs.some(function (sg) { return !!sg.K; })) return false;
      for (const sg of segs) { sg.K = null; sg.classification = null; if (sg.vao && this.aClassification >= 0) { gl.bindVertexArray(sg.vao); gl.disableVertexAttribArray(this.aClassification); gl.vertexAttrib1f(this.aClassification, 0); gl.bindVertexArray(null); } }
      this._segDropAttr(bo, 'classification');
      this._bigSync({ dropClass: true, classCleared: true });
      this.render(); this._notifyCloudChanged();
      return true;
    });
    wrap('classifyInApp', async function (opts) {
      const self = this, bo = bigOf(this), segs = bo._segs, o = opts || {};
      const hadK = segs.some(function (sg) { return !!sg.K; });
      const r = await this._bigRun('Разметка конструктива…', function (ctx) { return BC.classifyBig(segs, o, ctx); });
      if (!r.value) return null;
      const res = r.value, rec = BC.applyLabelsBySeg(segs, res.labels), target = this._classificationTarget();
      this._bigPushUndo(rec, { cls: true, hadClassification: hadK, target: target });
      this._bigSync({ dropClass: true });
      if (o.selectClass != null) this._bigSelectClass(o.selectClass);
      this._lastClassificationPromise = this._bigPersistClasses('RANSAC structural planes', o, res.counts);
      this.render(); this._notifyCloudChanged();
      return res.counts;
    });
    // Назначение кода класса выделенным точкам (ASPRS), с откатом
    wrap('assignClassificationInApp', function (classCode) {
      const code = Number(classCode);
      if (!Number.isInteger(code) || code < 0 || code > 255) return { ok: false, error: 'invalid_class_code' };
      const bo = bigOf(this), segs = bo._segs, sel = this._sel;
      if (this._bigBusy) return { ok: false, error: 'busy' };
      if (!(sel instanceof BC.BigSel) || !sel.valid() || !sel.size) return { ok: false, error: 'no_selected_points' };
      const hadK = segs.some(function (sg) { return !!sg.K; });
      const r = BC.assignClass(segs, sel, code);
      if (!r.changed) return { ok: true, unchanged: true, changed: 0, classCode: code };
      const target = this._classificationTarget();
      this._bigSync({ dropClass: true });
      this._bigPushUndo(r.rec, { cls: true, hadClassification: hadK, target: target });
      this._lastClassificationPromise = this._bigPersistClasses('manual LAS/ASPRS class assignment', { classCode: code, selectionCount: sel.size }, { classCode: code, assignedPointCount: r.changed }, target);
      this.render(); this._notifyCloudChanged();
      return { ok: true, changed: r.changed, classCode: code };
    });

    // ───────── сохранение и экспорт ─────────
    // Потоковый экспорт всех точек (PLY/LAS/XYZ/PTS/PCD/CSV) кусками байт — без сборки файла в памяти. { fmt, count, expectedBytes, chunks }
    P.getBigExport = function (fmt, o) {
      const bo = bigOf(this); if (!bo) return null;
      o = o || {};
      return BC.exportStream(bo._segs, fmt, { meta: this._bigMeta(), chunkPoints: o.chunkPoints }, o.ctx);
    };
    P.bigInfo = function () {
      const bo = bigOf(this); if (!bo) return null;
      const segs = bo._segs; let bytes = 0, hasC = false, hasI = false, hasK = false;
      for (const sg of segs) { bytes += sg.P.byteLength + (sg.C ? sg.C.byteLength : 0) + (sg.I ? sg.I.byteLength : 0) + (sg.K ? sg.K.byteLength : 0); if (sg.C) hasC = true; if (sg.I) hasI = true; if (sg.K) hasK = true; }
      return { count: BC.total(segs), segments: segs.length, bytes: bytes, hasColor: hasC, hasIntensity: hasI, hasClassification: hasK, undo: (this._undo || []).length, busy: !!this._bigBusy };
    };
    // Сохранение/экспорт ВСЕХ точек потоком: куски байт уходят в основной процесс по одному (bim:beginExportStream …), файл собирается на диске.
    // fmt: ply | las | xyz | pts | pcd | csv. Возвращает { ok, path, bytes, count } | { canceled } | { error, message }.
    P.saveBigStream = async function (fmt, o) {
      const bo = bigOf(this); if (!bo) return null;
      o = o || {}; fmt = String(fmt || 'ply').toLowerCase();
      if (BC.EXPORT_FORMATS.indexOf(fmt) < 0) return { ok: false, error: 'unsupported_format', message: 'Формат ' + fmt.toUpperCase() + ' для облака больше 48 млн точек недоступен (доступны PLY, LAS, XYZ, PTS, PCD, CSV, OBJ).' };
      const A = W && W.bimAPI;
      if (!A || typeof A.beginExportStream !== 'function' || typeof A.writeExportStreamChunk !== 'function' || typeof A.finishExportStream !== 'function' || typeof A.cancelExportStream !== 'function') {
        const m = 'Сохранение облака больше 48 млн точек доступно в десктоп-версии.'; this._bigNote(m, 'warn'); return { ok: false, error: 'stream_api_unavailable', message: m };
      }
      const self = this; let streamId = null, canceledByUser = false;
      const text = fmt !== 'ply' && fmt !== 'las';
      const run = await this._bigRun(o.label || ('Сохранение ' + fmt.toUpperCase() + '…'), async function (ctx) {
        const ex = BC.exportStream(bo._segs, fmt, { meta: self._bigMeta(), chunkPoints: o.chunkPoints || (text ? 100000 : 200000) }, ctx);
        const begun = await A.beginExportStream({ ext: fmt, name: o.name || ('pointcloud-edited.' + fmt), title: o.title, expectedPoints: ex.count, expectedBytes: ex.expectedBytes || undefined, targetPath: o.targetPath || undefined });
        if (!begun || !begun.ok) { if (begun && begun.canceled) { canceledByUser = true; return null; } throw new Error('Не удалось начать запись: ' + ((begun && begun.error) || 'ошибка')); }
        streamId = begun.streamId;
        for await (const chunk of ex.chunks) {
          const w = await A.writeExportStreamChunk({ streamId: streamId, bytes: chunk });
          if (!w || !w.ok) throw new Error('Запись на диск прервана: ' + ((w && w.error) || 'ошибка'));
        }
        const fin = await A.finishExportStream(streamId); streamId = null;
        if (!fin || !fin.ok) throw new Error('Файл не завершён: ' + ((fin && fin.error) || 'ошибка') + (fin && fin.recoveryPath ? ' (результат сохранён во временный файл ' + fin.recoveryPath + ')' : ''));
        return { ok: true, path: fin.path, bytes: fin.bytes, sha256: fin.sha256, count: ex.count, noOp: !!fin.noOp };
      });
      if (streamId) { try { await A.cancelExportStream(streamId); } catch (_) {} streamId = null; }
      if (run.cancelled || canceledByUser) return { ok: false, canceled: true };
      if (run.busy) return { ok: false, error: 'busy' };
      if (run.error) return { ok: false, error: 'stream_failed', message: String((run.error && run.error.message) || run.error) };
      return run.value || { ok: false, canceled: true };
    };
    // Равномерная выборка из ВСЕГО облака (до cap точек, по умолчанию 12 млн) для инструментов с плоскими массивами (3DGS).
    P.getBigSample = async function (cap) {
      const bo = bigOf(this); if (!bo) return null;
      const r = await this._bigRun('Выборка точек для инструмента…', function (ctx) { return BC.sampleAll(bo._segs, cap > 0 ? cap : 12000000, ctx); });
      return r && r.value ? r.value : null;
    };
    // Целиком: «большое» облако не отдаёт плоских массивов (сводка для проекта — по выборке, сохранение — только потоком)
    const origGet = P.getEditedCloud;
    P.getEditedCloud = function () {
      const bo = bigOf(this);
      if (!bo) return typeof origGet === 'function' ? origGet.apply(this, arguments) : null;
      return null;
    };
  }
  return { install: install };
});
