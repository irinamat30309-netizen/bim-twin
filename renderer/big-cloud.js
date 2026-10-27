// Ревизия 17 — «большое облако»: чистые (без GL и DOM) алгоритмы для облаков, прочитанных частями (сегменты по ~16 млн точек).
// Раньше (r16) такие облака лежали только в видеопамяти, и выделение, правка, чистка, классы и сохранение были недоступны.
// Теперь копия каждой части (позиции, цвет, интенсивность, класс) остаётся в оперативной памяти, а все операции идут
// по сегментам и «плиткам» — без потери числа точек. Модуль работает с массивом сегментов segs: у каждого сегмента
//   P (Float32 xyz, система Y-вверх), C (Uint8 rgb | null), I (Uint16 | null), K (Uint8 | null) — массивы ёмкости cap,
//   n — число точек, start — глобальный номер первой точки, boxes (Float32 по 6 чисел на кирпич chunk точек).
// Долгие операции — async: между блоками управление отдаётся интерфейсу (ctx.tick), есть прогресс и отмена.
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  try { if (root) root.BigCloud = api; } catch (_) {}
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  const BLOCK = 1 << 18;
  const nowMs = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

  class Cancelled extends Error { constructor(m) { super(m || 'cancelled'); this.name = 'Cancelled'; this.cancelled = true; } }

  // ctx: { sliceMs, cancelled():bool, onProgress(f, label), yield():Promise }
  function makeCtx(o) {
    o = o || {};
    let last = nowMs(), lastP = 0;
    const ctx = {
      _bigctx: true,
      async tick() {
        if (o.cancelled && o.cancelled()) throw new Cancelled();
        const t = nowMs();
        if (t - last >= (o.sliceMs || 30)) { await (o.yield ? o.yield() : new Promise(function (r) { setTimeout(r, 0); })); last = nowMs(); if (o.cancelled && o.cancelled()) throw new Cancelled(); }
      },
      progress(f, label) {
        if (!o.onProgress) return;
        const t = nowMs();
        if (f < 1 && t - lastP < 60) return;
        lastP = t;
        try { o.onProgress(Math.max(0, Math.min(1, f)), label); } catch (_) {}
      },
      cancelled() { return !!(o.cancelled && o.cancelled()); }
    };
    return ctx;
  }
  function ctxOf(c) { return (c && c._bigctx) ? c : makeCtx(c); }

  // ───────────── сегменты ─────────────
  function renumber(segs) { let s = 0; for (let i = 0; i < segs.length; i++) { segs[i].start = s; s += segs[i].n; } return s; }
  function total(segs) { let s = 0; for (let i = 0; i < segs.length; i++) s += segs[i].n; return s; }
  // номер сегмента, содержащего глобальную точку g (двоичный поиск по start); -1 — вне облака
  function locate(segs, g) {
    let lo = 0, hi = segs.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid].start <= g) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    if (ans < 0) return -1;
    const sg = segs[ans];
    return (g >= sg.start && g < sg.start + sg.n) ? ans : -1;
  }
  function pointAt(segs, g) {
    const s = locate(segs, g); if (s < 0) return null;
    const sg = segs[s], i = g - sg.start;
    return [sg.P[i * 3], sg.P[i * 3 + 1], sg.P[i * 3 + 2]];
  }
  function colorAt(segs, g) {
    const s = locate(segs, g); if (s < 0) return null;
    const sg = segs[s]; if (!sg.C) return null; const i = g - sg.start;
    return [sg.C[i * 3], sg.C[i * 3 + 1], sg.C[i * 3 + 2]];
  }

  // ───────────── выделение: маски по сегментам с интерфейсом, совместимым с Set ─────────────
  class BigSel {
    constructor(segs) { this.segs = segs; this.m = new Array(segs.length).fill(null); this.size = 0; this._n = segs.map(function (g) { return g.n; }); }
    valid() { for (let s = 0; s < this.segs.length; s++) if (this._n[s] !== this.segs[s].n) return false; return this.segs.length === this._n.length; }
    has(g) { const s = locate(this.segs, g); if (s < 0) return false; const m = this.m[s]; return !!(m && m[g - this.segs[s].start]); }
    add(g) {
      const s = locate(this.segs, g); if (s < 0) return this;
      const sg = this.segs[s]; let m = this.m[s]; if (!m) m = this.m[s] = new Uint8Array(sg.n);
      const i = g - sg.start; if (!m[i]) { m[i] = 1; this.size++; }
      return this;
    }
    delete(g) {
      const s = locate(this.segs, g); if (s < 0) return false;
      const m = this.m[s]; if (!m) return false; const i = g - this.segs[s].start;
      if (!m[i]) return false; m[i] = 0; this.size--; return true;
    }
    clear() { this.m.fill(null); this.size = 0; }
    mask(s, create) { let m = this.m[s]; if (!m && create) m = this.m[s] = new Uint8Array(this.segs[s].n); return m || null; }
    recount() { let t = 0; for (let s = 0; s < this.m.length; s++) { const m = this.m[s]; if (!m) continue; let c = 0; for (let i = 0; i < m.length; i++) c += m[i]; t += c; if (!c) this.m[s] = null; } this.size = t; return t; }
    forEach(fn) {
      const self = this;
      for (let s = 0; s < this.m.length; s++) { const m = this.m[s]; if (!m) continue; const b = this.segs[s].start; for (let i = 0; i < m.length; i++) if (m[i]) fn.call(undefined, b + i, b + i, self); }
    }
    *[Symbol.iterator]() { for (let s = 0; s < this.m.length; s++) { const m = this.m[s]; if (!m) continue; const b = this.segs[s].start; for (let i = 0; i < m.length; i++) if (m[i]) yield b + i; } }
    values() { return this[Symbol.iterator](); }
    keys() { return this[Symbol.iterator](); }
    // индексы выделенных точек (Uint32Array); limit — потолок, при превышении возвращает null
    toIndices(limit) {
      if (limit != null && this.size > limit) return null;
      const out = new Uint32Array(this.size); let k = 0;
      for (let s = 0; s < this.m.length; s++) { const m = this.m[s]; if (!m) continue; const b = this.segs[s].start; for (let i = 0; i < m.length; i++) if (m[i]) out[k++] = b + i; }
      return k === out.length ? out : out.subarray(0, k);
    }
    // объединение с другим выделением (this |= other)
    union(other) {
      for (let s = 0; s < other.m.length; s++) { const om = other.m[s]; if (!om) continue; const m = this.mask(s, true); for (let i = 0; i < om.length; i++) if (om[i]) m[i] = 1; }
      return this.recount();
    }
    subtract(other) {
      for (let s = 0; s < other.m.length; s++) { const om = other.m[s], m = this.m[s]; if (!om || !m) continue; for (let i = 0; i < om.length; i++) if (om[i]) m[i] = 0; }
      return this.recount();
    }
    invert() {
      for (let s = 0; s < this.segs.length; s++) { const sg = this.segs[s], m = this.mask(s, true); for (let i = 0; i < sg.n; i++) m[i] = m[i] ? 0 : 1; }
      return this.recount();
    }
  }

  // ───────────── рамки кирпичей ─────────────
  function chunkOf(sg) { return Math.max(1000, sg.chunk | 0) || 1000000; }
  function recomputeBoxes(sg, fromBrick) {
    const CH = chunkOf(sg), n = sg.n, nc = Math.ceil(n / CH), old = sg.boxes, P = sg.P;
    const B = new Float32Array(nc * 6); fromBrick = Math.max(0, fromBrick | 0);
    if (old) B.set(old.subarray(0, Math.min(fromBrick, nc, old.length / 6) * 6));
    else fromBrick = 0;
    for (let c = Math.min(fromBrick, nc); c < nc; c++) {
      const i0 = c * CH * 3, i1 = Math.min(n, (c + 1) * CH) * 3;
      let a0 = Infinity, a1 = Infinity, a2 = Infinity, b0 = -Infinity, b1 = -Infinity, b2 = -Infinity;
      for (let i = i0; i < i1; i += 3) { const x = P[i], y = P[i + 1], z = P[i + 2]; if (x < a0) a0 = x; if (x > b0) b0 = x; if (y < a1) a1 = y; if (y > b1) b1 = y; if (z < a2) a2 = z; if (z > b2) b2 = z; }
      B[c * 6] = a0; B[c * 6 + 1] = a1; B[c * 6 + 2] = a2; B[c * 6 + 3] = b0; B[c * 6 + 4] = b1; B[c * 6 + 5] = b2;
    }
    sg.boxes = B; sg.chunk = CH;
    return B;
  }
  // общая рамка всех сегментов по рамкам кирпичей ({mn,mx}); null, если облако пусто
  function boundsOf(segs) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; let any = false;
    for (const sg of segs) {
      if (!sg.n) continue;
      if (!sg.boxes) recomputeBoxes(sg, 0);
      const B = sg.boxes, nc = Math.ceil(sg.n / chunkOf(sg));
      for (let c = 0; c < nc; c++) for (let k = 0; k < 3; k++) { const lo = B[c * 6 + k], hi = B[c * 6 + 3 + k]; if (lo < mn[k]) mn[k] = lo; if (hi > mx[k]) mx[k] = hi; any = true; }
    }
    return any ? { mn: mn, mx: mx } : null;
  }
  function refreshViews(sg) {
    sg.intensity = sg.I ? sg.I.subarray(0, sg.n) : null;
    sg.classification = sg.K ? sg.K.subarray(0, sg.n) : null;
  }

  // ───────────── обход ─────────────
  // fn(sg, s, i0, i1) на блоках точек; pred(boxes, o) — отсечение кирпичей по рамке (необязательно)
  async function eachBrick(segs, ctx, pred, fn, p0, p1) {
    ctx = ctxOf(ctx); const tot = Math.max(1, total(segs)); let done = 0; p0 = p0 || 0; p1 = p1 == null ? 1 : p1;
    for (let s = 0; s < segs.length; s++) {
      const sg = segs[s], n = sg.n; if (!n) continue;
      const CH = chunkOf(sg), nc = Math.ceil(n / CH), B = sg.boxes && sg.boxes.length >= nc * 6 ? sg.boxes : null;
      for (let c = 0; c < nc; c++) {
        const i0 = c * CH, i1 = Math.min(n, i0 + CH);
        if (!(pred && B && !pred(B, c * 6))) fn(sg, s, i0, i1);
        done += i1 - i0;
        await ctx.tick(); ctx.progress(p0 + (p1 - p0) * done / tot);
      }
    }
  }
  const boxOverlap = (mn, mx) => (B, o) => !(B[o] > mx[0] || B[o + 3] < mn[0] || B[o + 1] > mx[1] || B[o + 4] < mn[1] || B[o + 2] > mx[2] || B[o + 5] < mn[2]);
  const boxNearSphere = (c, r) => (B, o) => {
    let d = 0, v;
    for (let k = 0; k < 3; k++) { v = c[k]; if (v < B[o + k]) { v = B[o + k] - v; d += v * v; } else if (v > B[o + 3 + k]) { v = v - B[o + 3 + k]; d += v * v; } }
    return d <= r * r;
  };

  // ───────────── выделение по форме ─────────────
  // Все функции заполняют НОВОЕ выделение out (BigSel) и возвращают его. inClip(x,y,z) — необязательный фильтр секущего бокса.
  async function selectBox(segs, mn, mx, o) {
    o = o || {}; const out = new BigSel(segs), inClip = o.inClip || null;
    await eachBrick(segs, o.ctx, boxOverlap(mn, mx), function (sg, s, i0, i1) {
      const P = sg.P; let m = null;
      for (let i = i0; i < i1; i++) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        if (x >= mn[0] && x <= mx[0] && y >= mn[1] && y <= mx[1] && z >= mn[2] && z <= mx[2] && (!inClip || inClip(x, y, z))) { if (!m) m = out.mask(s, true); m[i] = 1; }
      }
    });
    out.recount(); return out;
  }
  async function selectSphere(segs, c, r, o) {
    o = o || {}; const out = new BigSel(segs), inClip = o.inClip || null, r2 = r * r, cx = c[0], cy = c[1], cz = c[2];
    await eachBrick(segs, o.ctx, boxNearSphere(c, r), function (sg, s, i0, i1) {
      const P = sg.P; let m = null;
      for (let i = i0; i < i1; i++) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], dx = x - cx, dy = y - cy, dz = z - cz;
        if (dx * dx + dy * dy + dz * dz <= r2 && (!inClip || inClip(x, y, z))) { if (!m) m = out.mask(s, true); m[i] = 1; }
      }
    });
    out.recount(); return out;
  }
  // цвет: seed — [r,g,b] в шкале 0..255, tol — допуск евклидова расстояния
  async function selectColor(segs, seed, tol, o) {
    o = o || {}; const out = new BigSel(segs), inClip = o.inClip || null, t2 = tol * tol, sr = seed[0], sg_ = seed[1], sb = seed[2];
    await eachBrick(segs, o.ctx, null, function (sg, s, i0, i1) {
      const C = sg.C, P = sg.P; if (!C) return; let m = null;
      for (let i = i0; i < i1; i++) {
        const dr = C[i * 3] - sr, dg = C[i * 3 + 1] - sg_, db = C[i * 3 + 2] - sb;
        if (dr * dr + dg * dg + db * db <= t2 && (!inClip || inClip(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]))) { if (!m) m = out.mask(s, true); m[i] = 1; }
      }
    });
    out.recount(); return out;
  }
  // все точки, прошедшие фильтр (для «выделить всё в срезе» и «инвертировать»)
  async function selectWhere(segs, test, o) {
    o = o || {}; const out = new BigSel(segs);
    await eachBrick(segs, o.ctx, o.pred || null, function (sg, s, i0, i1) {
      const P = sg.P; let m = null;
      for (let i = i0; i < i1; i++) if (!test || test(P[i * 3], P[i * 3 + 1], P[i * 3 + 2])) { if (!m) m = out.mask(s, true); m[i] = 1; }
    });
    out.recount(); return out;
  }
  // выделение по списку глобальных индексов
  function selectIndices(segs, idx) {
    const out = new BigSel(segs); let s = 0;
    for (let k = 0; k < idx.length; k++) {
      const g = idx[k]; if (!(s < segs.length && g >= segs[s].start && g < segs[s].start + segs[s].n)) s = locate(segs, g);
      if (s < 0) { s = 0; continue; }
      out.mask(s, true)[g - segs[s].start] = 1;
    }
    out.recount(); return out;
  }

  // ───────────── точки по индексам / по выделению ─────────────
  // Копирует выбранные точки в плоские массивы (для объектов, для магической палочки и т. п.)
  function gather(segs, sel, limit) {
    const n = sel.size; if (limit != null && n > limit) return null;
    const hasC = segs.some(function (g) { return g.C; }), hasI = segs.some(function (g) { return g.I; }), hasK = segs.some(function (g) { return g.K; });
    const pos = new Float32Array(n * 3), col = hasC ? new Uint8Array(n * 3) : null, I = hasI ? new Uint16Array(n) : null, K = hasK ? new Uint8Array(n) : null;
    const ref = new Uint32Array(n); let k = 0;
    for (let s = 0; s < segs.length; s++) {
      const m = sel.m[s]; if (!m) continue; const sg = segs[s], P = sg.P;
      for (let i = 0; i < sg.n; i++) {
        if (!m[i]) continue;
        pos[k * 3] = P[i * 3]; pos[k * 3 + 1] = P[i * 3 + 1]; pos[k * 3 + 2] = P[i * 3 + 2];
        if (col && sg.C) { col[k * 3] = sg.C[i * 3]; col[k * 3 + 1] = sg.C[i * 3 + 1]; col[k * 3 + 2] = sg.C[i * 3 + 2]; }
        if (I && sg.I) I[k] = sg.I[i]; if (K && sg.K) K[k] = sg.K[i];
        ref[k] = sg.start + i; k++;
      }
    }
    return { pos: pos, col: col, intensity: I, classification: K, ref: ref, count: k };
  }
  // габариты выделенных точек
  function selBounds(segs, sel) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let s = 0; s < segs.length; s++) {
      const m = sel.m[s]; if (!m) continue; const P = segs[s].P, n = segs[s].n;
      for (let i = 0; i < n; i++) { if (!m[i]) continue; for (let k = 0; k < 3; k++) { const v = P[i * 3 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; } }
    }
    return { mn: mn, mx: mx };
  }

  // ───────────── удаление / обрезка с компактным откатом ─────────────
  // masks[s] — Uint8Array(n) (1 = удалить; при o.keep: 1 = оставить, остальные удалить) либо null.
  // Возвращает { ok, removed, rec } — rec хранит удалённые точки и их места, откат восстанавливает сегменты ПОБАЙТНО как были.
  function removeMasks(segs, masks, o) {
    o = o || {}; const keep = !!o.keep, plans = []; let removed = 0, need = 0;
    for (let s = 0; s < segs.length; s++) {
      const sg = segs[s], m = masks[s], n = sg.n; if (!n) continue;
      let R = 0, first = -1;
      if (!m) { if (keep) { R = n; first = 0; } }
      else if (keep) { for (let i = 0; i < n; i++) if (!m[i]) { if (first < 0) first = i; R++; } }
      else { for (let i = 0; i < n; i++) if (m[i]) { if (first < 0) first = i; R++; } }
      if (R) { plans.push({ s: s, R: R, first: first }); removed += R; need += R * (4 + 12 + (sg.C ? 3 : 0) + (sg.I ? 2 : 0) + (sg.K ? 1 : 0)); }
    }
    if (!removed) return { ok: true, removed: 0, rec: null };
    const recs = [];
    try {
      for (const p of plans) {
        const sg = segs[p.s];
        recs.push({ s: p.s, R: p.R, first: p.first, n0: sg.n, idx: new Uint32Array(p.R), P: new Float32Array(p.R * 3), C: sg.C ? new Uint8Array(p.R * 3) : null,
          I: sg.I ? new Uint16Array(p.R) : null, K: sg.K ? new Uint8Array(p.R) : null, boxes: sg.boxes ? sg.boxes.slice() : null });
      }
    } catch (e) { return { ok: false, error: 'memory', needBytes: need }; }
    for (const rec of recs) {
      const sg = segs[rec.s], m = masks[rec.s], n = sg.n, P = sg.P, C = sg.C, I = sg.I, K = sg.K, idx = rec.idx, rP = rec.P, rC = rec.C, rI = rec.I, rK = rec.K;
      let w = rec.first, r = 0;
      for (let i = rec.first; i < n; i++) {
        const rm = !m ? keep : (keep ? !m[i] : !!m[i]);
        if (rm) {
          idx[r] = i; rP[r * 3] = P[i * 3]; rP[r * 3 + 1] = P[i * 3 + 1]; rP[r * 3 + 2] = P[i * 3 + 2];
          if (rC) { rC[r * 3] = C[i * 3]; rC[r * 3 + 1] = C[i * 3 + 1]; rC[r * 3 + 2] = C[i * 3 + 2]; }
          if (rI) rI[r] = I[i]; if (rK) rK[r] = K[i]; r++;
        } else {
          if (w !== i) {
            P[w * 3] = P[i * 3]; P[w * 3 + 1] = P[i * 3 + 1]; P[w * 3 + 2] = P[i * 3 + 2];
            if (C) { C[w * 3] = C[i * 3]; C[w * 3 + 1] = C[i * 3 + 1]; C[w * 3 + 2] = C[i * 3 + 2]; }
            if (I) I[w] = I[i]; if (K) K[w] = K[i];
          }
          w++;
        }
      }
      sg.n = w; refreshViews(sg);
      recomputeBoxes(sg, Math.floor(rec.first / chunkOf(sg)));
      sg._dirtyFrom = Math.min(sg._dirtyFrom == null ? Infinity : sg._dirtyFrom, rec.first);
    }
    renumber(segs);
    return { ok: true, removed: removed, rec: { kind: 'remove', recs: recs, removed: removed } };
  }
  // откат removeMasks: возвращает точки на прежние места
  function restoreRemoval(segs, rec) {
    if (!rec) return 0; let back = 0;
    for (let k = rec.recs.length - 1; k >= 0; k--) {
      const q0 = rec.recs[k], sg = segs[q0.s], R = q0.R, n0 = sg.n, n1 = n0 + R;
      if (sg.P.length < n1 * 3) throw new RangeError('segment capacity');
      const P = sg.P, C = sg.C, I = sg.I, K = sg.K, idx = q0.idx;
      let w = n1 - 1, r = n0 - 1, q = R - 1;
      while (q >= 0) {
        if (idx[q] === w) {
          P[w * 3] = q0.P[q * 3]; P[w * 3 + 1] = q0.P[q * 3 + 1]; P[w * 3 + 2] = q0.P[q * 3 + 2];
          if (C && q0.C) { C[w * 3] = q0.C[q * 3]; C[w * 3 + 1] = q0.C[q * 3 + 1]; C[w * 3 + 2] = q0.C[q * 3 + 2]; }
          if (I && q0.I) I[w] = q0.I[q]; if (K && q0.K) K[w] = q0.K[q];
          q--;
        } else {
          P[w * 3] = P[r * 3]; P[w * 3 + 1] = P[r * 3 + 1]; P[w * 3 + 2] = P[r * 3 + 2];
          if (C) { C[w * 3] = C[r * 3]; C[w * 3 + 1] = C[r * 3 + 1]; C[w * 3 + 2] = C[r * 3 + 2]; }
          if (I) I[w] = I[r]; if (K) K[w] = K[r];
          r--;
        }
        w--;
      }
      sg.n = n1; refreshViews(sg); sg.boxes = q0.boxes; if (!sg.boxes) recomputeBoxes(sg, 0);
      sg._dirtyFrom = Math.min(sg._dirtyFrom == null ? Infinity : sg._dirtyFrom, q0.first);
      back += R;
    }
    renumber(segs);
    return back;
  }
  // сколько байт занимает запись отката
  function recBytes(rec) {
    if (!rec) return 0;
    if (rec.kind === 'remove') { let b = 0; for (const q of rec.recs) b += q.idx.byteLength + q.P.byteLength + (q.C ? q.C.byteLength : 0) + (q.I ? q.I.byteLength : 0) + (q.K ? q.K.byteLength : 0); return b; }
    if (rec.kind === 'compound') { let b = 0; for (const r of rec.steps) b += recBytes(r); return b; }
    return rec.bytes || 0;
  }

  // ───────────── выборка для процессора (каждая every-я точка) ─────────────
  function rebuildSample(segs, st) {
    const every = st.every, tot = total(segs), cnt = Math.min(st.cap, Math.ceil(tot / every));
    for (const sg of segs) {
      const start = sg.start, n = sg.n, P = sg.P, C = sg.C, I = sg.I, K = sg.K;
      for (let j = (every - (start % every)) % every; j < n; j += every) {
        const s = Math.floor((start + j) / every); if (s >= st.cap) break;
        st.pos[s * 3] = P[j * 3]; st.pos[s * 3 + 1] = P[j * 3 + 1]; st.pos[s * 3 + 2] = P[j * 3 + 2];
        if (C) { st.col[s * 3] = C[j * 3] / 255; st.col[s * 3 + 1] = C[j * 3 + 1] / 255; st.col[s * 3 + 2] = C[j * 3 + 2] / 255; }
        if (st.int && I) st.int[s] = I[j] / 65535;
        if (st.cls && K) st.cls[s] = K[j];
      }
    }
    st.filled = cnt; return cnt;
  }

  const api = { BLOCK: BLOCK, Cancelled: Cancelled, makeCtx: makeCtx, ctxOf: ctxOf, renumber: renumber, total: total, locate: locate, pointAt: pointAt, colorAt: colorAt,
    BigSel: BigSel, recomputeBoxes: recomputeBoxes, boundsOf: boundsOf, refreshViews: refreshViews, eachBrick: eachBrick, boxOverlap: boxOverlap, boxNearSphere: boxNearSphere,
    selectBox: selectBox, selectSphere: selectSphere, selectColor: selectColor, selectWhere: selectWhere, selectIndices: selectIndices, gather: gather, selBounds: selBounds,
    removeMasks: removeMasks, restoreRemoval: restoreRemoval, recBytes: recBytes, rebuildSample: rebuildSample, _p: {} };
  // @@PART:B@@
  // ═════════════ Часть B: хеш-сетки вокселей, плитки, ядра чистки ═════════════
  // Разреженная хеш-сетка вокселей (открытая адресация, ключи — три Int32): работает при любом числе ячеек, память ~24 Б на занятый воксель
  class VoxelHash {
    constructor(hint) {
      let cap = 1 << 12; hint = Math.max(1, hint | 0); while (cap < hint * 2) cap <<= 1;
      this.cap = cap; this.mask = cap - 1; this.tab = new Int32Array(cap);
      const ic = Math.max(1024, hint); this.kx = new Int32Array(ic); this.ky = new Int32Array(ic); this.kz = new Int32Array(ic); this.cnt = new Uint32Array(ic); this.size = 0;
    }
    _h(x, y, z) { let h = Math.imul(x, -1640531535) ^ Math.imul(y, -2048144777) ^ Math.imul(z, -1028477379); h ^= h >>> 15; h = Math.imul(h, 739982445); h ^= h >>> 13; return h & this.mask; }
    _growTab() {
      const cap = this.cap * 2, tab = new Int32Array(cap), mask = cap - 1; this.cap = cap; this.mask = mask;
      for (let id = 0; id < this.size; id++) { let h = this._h(this.kx[id], this.ky[id], this.kz[id]); while (tab[h]) h = (h + 1) & mask; tab[h] = id + 1; }
      this.tab = tab;
    }
    _growIds() {
      const c = this.cnt.length * 2; const f = (a, T) => { const b = new T(c); b.set(a); return b; };
      this.kx = f(this.kx, Int32Array); this.ky = f(this.ky, Int32Array); this.kz = f(this.kz, Int32Array); this.cnt = f(this.cnt, Uint32Array);
    }
    // добавляет точку в воксель (счётчик++), возвращает номер вокселя (в порядке первого появления)
    add(x, y, z) {
      let h = this._h(x, y, z), t = this.tab, mask = this.mask, v;
      while ((v = t[h])) { const id = v - 1; if (this.kx[id] === x && this.ky[id] === y && this.kz[id] === z) { this.cnt[id]++; return id; } h = (h + 1) & mask; }
      if (this.size >= this.cnt.length) this._growIds();
      const id = this.size++; this.kx[id] = x; this.ky[id] = y; this.kz[id] = z; this.cnt[id] = 1; t[h] = id + 1;
      if (this.size * 2 > this.cap) this._growTab();
      return id;
    }
    find(x, y, z) {
      let h = this._h(x, y, z), t = this.tab, mask = this.mask, v;
      while ((v = t[h])) { const id = v - 1; if (this.kx[id] === x && this.ky[id] === y && this.kz[id] === z) return id; h = (h + 1) & mask; }
      return -1;
    }
  }

  function dims(bb) { return [bb.mx[0] - bb.mn[0], bb.mx[1] - bb.mn[1], bb.mx[2] - bb.mn[2]]; }
  function diagOf(bb) { const d = dims(bb); return Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) || 1; }
  function markMask(masks, s, n) { return masks[s] || (masks[s] = new Uint8Array(n)); }
  function countMasks(masks) { let t = 0; for (const m of masks) if (m) for (let i = 0; i < m.length; i++) t += m[i]; return t; }

  // ───── Фильтр плотности: точка удаляется, если в её вокселе меньше minPts точек (как PCEdit.cleanVoxelDensity) ─────
  // До 5e7 ячеек — плотная сетка (как в плоской версии), иначе — разреженная хеш-сетка с заданным вокселем (без укрупнения).
  async function densityMasks(segs, o, ctx) {
    ctx = ctxOf(ctx); o = o || {}; const n = total(segs), masks = new Array(segs.length).fill(null);
    if (n < 8) return { removed: 0, masks: masks, voxel: 0 };
    const bb = o.bounds || boundsOf(segs), D = dims(bb), diag = diagOf(bb);
    let voxel = (o.voxel && o.voxel > 0) ? o.voxel : diag * 0.005; const minPts = o.minPts != null ? (o.minPts | 0) : 6;
    const gx = Math.max(1, Math.floor(D[0] / voxel) + 1), gy = Math.max(1, Math.floor(D[1] / voxel) + 1), gz = Math.max(1, Math.floor(D[2] / voxel) + 1), cells = gx * gy * gz;
    const mnx = bb.mn[0], mny = bb.mn[1], mnz = bb.mn[2], inv = 1 / voxel, dense = cells <= 5e7;
    let counts = null, hash = null, removed = 0;
    if (dense) counts = new Int32Array(cells); else hash = new VoxelHash(Math.min(n, 4e6));
    await eachBrick(segs, ctx, null, function (sg, s, i0, i1) {
      const P = sg.P;
      for (let i = i0; i < i1; i++) {
        let ix = ((P[i * 3] - mnx) * inv) | 0; if (ix >= gx) ix = gx - 1; if (ix < 0) ix = 0;
        let iy = ((P[i * 3 + 1] - mny) * inv) | 0; if (iy >= gy) iy = gy - 1; if (iy < 0) iy = 0;
        let iz = ((P[i * 3 + 2] - mnz) * inv) | 0; if (iz >= gz) iz = gz - 1; if (iz < 0) iz = 0;
        if (dense) counts[ix + gx * (iy + gy * iz)]++; else hash.add(ix, iy, iz);
      }
    }, 0, 0.5);
    // есть ли вообще разреженные воксели — если нет, второй проход не нужен
    let sparse = false;
    if (dense) { for (let c = 0; c < cells; c++) { const v = counts[c]; if (v > 0 && v < minPts) { sparse = true; break; } } }
    else { for (let id = 0; id < hash.size; id++) if (hash.cnt[id] < minPts) { sparse = true; break; } }
    if (sparse) await eachBrick(segs, ctx, null, function (sg, s, i0, i1) {
      const P = sg.P; let m = null;
      for (let i = i0; i < i1; i++) {
        let ix = ((P[i * 3] - mnx) * inv) | 0; if (ix >= gx) ix = gx - 1; if (ix < 0) ix = 0;
        let iy = ((P[i * 3 + 1] - mny) * inv) | 0; if (iy >= gy) iy = gy - 1; if (iy < 0) iy = 0;
        let iz = ((P[i * 3 + 2] - mnz) * inv) | 0; if (iz >= gz) iz = gz - 1; if (iz < 0) iz = 0;
        const c = dense ? counts[ix + gx * (iy + gy * iz)] : hash.cnt[hash.find(ix, iy, iz)];
        if (c < minPts) { if (!m) m = markMask(masks, s, sg.n); m[i] = 1; removed++; }
      }
    }, 0.5, 1);
    return { removed: removed, masks: masks, voxel: voxel };
  }

  // ───── Отсоединённые кластеры (как PCEdit.cleanClusters): связные компоненты занятых вокселей, 26-связность ─────
  async function clusterMasks(segs, o, ctx) {
    ctx = ctxOf(ctx); o = o || {}; const n = total(segs), masks = new Array(segs.length).fill(null);
    const none = { removed: 0, masks: masks, clusters: 0 };
    if (n < 32) return none;
    const bb = o.bounds || boundsOf(segs), D = dims(bb), diag = diagOf(bb);
    const voxel = (o.voxel && o.voxel > 0) ? o.voxel : diag * 0.004;
    const gx = Math.max(1, Math.floor(D[0] / voxel) + 1), gy = Math.max(1, Math.floor(D[1] / voxel) + 1), gz = Math.max(1, Math.floor(D[2] / voxel) + 1);
    const mnx = bb.mn[0], mny = bb.mn[1], mnz = bb.mn[2], inv = 1 / voxel, hash = new VoxelHash(Math.min(n, 4e6));
    await eachBrick(segs, ctx, null, function (sg, s, i0, i1) {
      const P = sg.P;
      for (let i = i0; i < i1; i++) {
        let ix = ((P[i * 3] - mnx) * inv) | 0; if (ix >= gx) ix = gx - 1; if (ix < 0) ix = 0;
        let iy = ((P[i * 3 + 1] - mny) * inv) | 0; if (iy >= gy) iy = gy - 1; if (iy < 0) iy = 0;
        let iz = ((P[i * 3 + 2] - mnz) * inv) | 0; if (iz >= gz) iz = gz - 1; if (iz < 0) iz = 0;
        hash.add(ix, iy, iz);
      }
    }, 0, 0.3);
    const nocc = hash.size; if (nocc <= 1) return none;
    // объединение соседних занятых вокселей (13 «передних» соседей из 26)
    const parent = new Int32Array(nocc); for (let i = 0; i < nocc; i++) parent[i] = i;
    const root = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const OFF = []; for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (dz < 0 || (dz === 0 && (dy < 0 || (dy === 0 && dx <= 0)))) continue; OFF.push(dx, dy, dz); }
    for (let id = 0; id < nocc; id++) {
      const x = hash.kx[id], y = hash.ky[id], z = hash.kz[id];
      for (let k = 0; k < OFF.length; k += 3) {
        const nb = hash.find(x + OFF[k], y + OFF[k + 1], z + OFF[k + 2]); if (nb < 0) continue;
        const a = root(id), b = root(nb); if (a !== b) parent[a < b ? b : a] = a < b ? a : b;
      }
      if ((id & 0xffff) === 0xffff) { await ctx.tick(); ctx.progress(0.3 + 0.2 * id / nocc); }
    }
    const compSize = new Float64Array(nocc); let nComp = 0, maxSize = 0, maxRoot = 0;
    for (let id = 0; id < nocc; id++) { const r = root(id); if (compSize[r] === 0) nComp++; compSize[r] += hash.cnt[id]; }
    if (nComp <= 1) return none;
    for (let id = 0; id < nocc; id++) if (parent[id] === id && compSize[id] > maxSize) { maxSize = compSize[id]; maxRoot = id; }
    const minPts = (o.minClusterPts != null) ? o.minClusterPts : Math.max(150, Math.round(n * 0.0008)), keepRatio = (o.keepRatio != null) ? o.keepRatio : 0;
    const thr = Math.max(minPts, keepRatio * maxSize), keep = new Uint8Array(nocc);   // keep[root]
    for (let id = 0; id < nocc; id++) if (parent[id] === id) keep[id] = compSize[id] >= thr ? 1 : 0;
    keep[maxRoot] = 1;
    // номера вокселей → оставить/удалить
    const voxKeep = new Uint8Array(nocc); for (let id = 0; id < nocc; id++) voxKeep[id] = keep[root(id)];
    let removed = 0;
    await eachBrick(segs, ctx, null, function (sg, s, i0, i1) {
      const P = sg.P; let m = null;
      for (let i = i0; i < i1; i++) {
        let ix = ((P[i * 3] - mnx) * inv) | 0; if (ix >= gx) ix = gx - 1; if (ix < 0) ix = 0;
        let iy = ((P[i * 3 + 1] - mny) * inv) | 0; if (iy >= gy) iy = gy - 1; if (iy < 0) iy = 0;
        let iz = ((P[i * 3 + 2] - mnz) * inv) | 0; if (iz >= gz) iz = gz - 1; if (iz < 0) iz = 0;
        if (!voxKeep[hash.find(ix, iy, iz)]) { if (!m) m = markMask(masks, s, sg.n); m[i] = 1; removed++; }
      }
    }, 0.5, 1);
    return { removed: removed, masks: masks, clusters: nComp, voxel: voxel };
  }

  // ───── Плитки: горизонтальные (X,Z) прямоугольники по гистограмме, в каждой не больше target точек ─────
  async function planTiles(segs, o, ctx) {
    ctx = ctxOf(ctx); o = o || {};
    const bb = o.bounds || boundsOf(segs); if (!bb) return null;
    const ex = Math.max(bb.mx[0] - bb.mn[0], 1e-9), ez = Math.max(bb.mx[2] - bb.mn[2], 1e-9), cells = o.histCells || 1048576, target = Math.max(1000, o.target || 1200000);
    let rx = Math.round(Math.sqrt(cells * ex / ez)); rx = Math.max(1, Math.min(2048, rx)); const rz = Math.max(1, Math.min(2048, Math.round(cells / rx)));
    const ox = bb.mn[0], oz = bb.mn[2], cx = ex / rx, cz = ez / rz, icx = 1 / cx, icz = 1 / cz, counts = new Uint32Array(rx * rz);
    await eachBrick(segs, ctx, null, function (sg, s, i0, i1) {
      const P = sg.P;
      for (let i = i0; i < i1; i++) {
        let ix = ((P[i * 3] - ox) * icx) | 0; if (ix >= rx) ix = rx - 1; else if (ix < 0) ix = 0;
        let iz = ((P[i * 3 + 2] - oz) * icz) | 0; if (iz >= rz) iz = rz - 1; else if (iz < 0) iz = 0;
        counts[iz * rx + ix]++;
      }
    }, 0, 0.05);
    const W = rx + 1, sat = new Float64Array(W * (rz + 1));
    for (let z = 0; z < rz; z++) { let row = 0; for (let x = 0; x < rx; x++) { row += counts[z * rx + x]; sat[(z + 1) * W + x + 1] = sat[z * W + x + 1] + row; } }
    const rect = (x0, x1, z0, z1) => sat[z1 * W + x1] - sat[z0 * W + x1] - sat[z1 * W + x0] + sat[z0 * W + x0];
    const tiles = [], stack = [[0, rx, 0, rz]];
    while (stack.length) {
      const r = stack.pop(), x0 = r[0], x1 = r[1], z0 = r[2], z1 = r[3], c = rect(x0, x1, z0, z1);
      if (c === 0) continue;
      const w = x1 - x0, h = z1 - z0;
      if (c <= target || (w <= 1 && h <= 1)) { tiles.push({ cx0: x0, cx1: x1, cz0: z0, cz1: z1, count: c }); continue; }
      const alongX = (w >= h && w > 1) || h <= 1; let best = -1, bd = Infinity;
      if (alongX) { for (let xm = x0 + 1; xm < x1; xm++) { const d = Math.abs(rect(x0, xm, z0, z1) - c / 2); if (d < bd) { bd = d; best = xm; } } stack.push([x0, best, z0, z1], [best, x1, z0, z1]); }
      else { for (let zm = z0 + 1; zm < z1; zm++) { const d = Math.abs(rect(x0, x1, z0, zm) - c / 2); if (d < bd) { bd = d; best = zm; } } stack.push([x0, x1, z0, best], [x0, x1, best, z1]); }
    }
    tiles.sort(function (a, b) { return a.cz0 - b.cz0 || a.cx0 - b.cx0; });
    return { ox: ox, oz: oz, cx: cx, cz: cz, rx: rx, rz: rz, icx: icx, icz: icz, tiles: tiles, rect: rect, bounds: bb, total: total(segs) };
  }
  // Один проход по облаку собирает точки нескольких плиток (ядро + поле margin вокруг) в плоские массивы в порядке облака
  async function gatherTiles(segs, plan, tiles, margin, ctx) {
    ctx = ctxOf(ctx);
    const outs = tiles.map(function (t) {
      const ex = Math.ceil(margin / Math.min(plan.cx, plan.cz)) + 1;
      const est = plan.rect(Math.max(0, t.cx0 - ex), Math.min(plan.rx, t.cx1 + ex), Math.max(0, t.cz0 - ex), Math.min(plan.rz, t.cz1 + ex));
      const cap = Math.max(64, Math.ceil(est * 1.1) + 64);
      return { tile: t, n: 0, nCore: 0, cap: cap, pos: new Float32Array(cap * 3), sid: new Uint16Array(cap), loc: new Uint32Array(cap), core: new Uint8Array(cap),
        mx0: plan.ox + t.cx0 * plan.cx - margin, mx1: plan.ox + t.cx1 * plan.cx + margin, mz0: plan.oz + t.cz0 * plan.cz - margin, mz1: plan.oz + t.cz1 * plan.cz + margin };
    });
    const grow = (q) => {
      const c = Math.ceil(q.cap * 1.5) + 64, a = new Float32Array(c * 3); a.set(q.pos); q.pos = a;
      const b = new Uint16Array(c); b.set(q.sid); q.sid = b; const d = new Uint32Array(c); d.set(q.loc); q.loc = d; const e = new Uint8Array(c); e.set(q.core); q.core = e; q.cap = c;
    };
    let ux0 = Infinity, ux1 = -Infinity, uz0 = Infinity, uz1 = -Infinity;
    for (const q of outs) { if (q.mx0 < ux0) ux0 = q.mx0; if (q.mx1 > ux1) ux1 = q.mx1; if (q.mz0 < uz0) uz0 = q.mz0; if (q.mz1 > uz1) uz1 = q.mz1; }
    const ox = plan.ox, oz = plan.oz, icx = plan.icx, icz = plan.icz, rx = plan.rx, rz = plan.rz, T = outs.length;
    const pred = (B, o) => B[o + 3] >= ux0 && B[o] <= ux1 && B[o + 5] >= uz0 && B[o + 2] <= uz1;
    await eachBrick(segs, ctx, pred, function (sg, s, i0, i1) {
      const P = sg.P;
      for (let i = i0; i < i1; i++) {
        const x = P[i * 3], z = P[i * 3 + 2];
        if (x < ux0 || x >= ux1 || z < uz0 || z >= uz1) continue;
        let ix = ((x - ox) * icx) | 0; if (ix >= rx) ix = rx - 1; else if (ix < 0) ix = 0;
        let iz = ((z - oz) * icz) | 0; if (iz >= rz) iz = rz - 1; else if (iz < 0) iz = 0;
        for (let t = 0; t < T; t++) {
          const q = outs[t], tl = q.tile;
          const isCore = ix >= tl.cx0 && ix < tl.cx1 && iz >= tl.cz0 && iz < tl.cz1;
          if (!isCore && !(x >= q.mx0 && x < q.mx1 && z >= q.mz0 && z < q.mz1)) continue;
          if (q.n >= q.cap) grow(q);
          const k = q.n++; q.pos[k * 3] = x; q.pos[k * 3 + 1] = P[i * 3 + 1]; q.pos[k * 3 + 2] = z; q.sid[k] = s; q.loc[k] = i; if (isCore) { q.core[k] = 1; q.nCore++; }
        }
      }
    });
    return outs;
  }
  // Обходит все плитки пачками (за один проход по облаку — несколько плиток); fn(tileData, index) вызывается по очереди
  async function eachTile(segs, plan, margin, ctx, fn, o) {
    ctx = ctxOf(ctx); o = o || {};
    const batchPts = o.batchPoints || Math.max(8e6, (o.target || 1.2e6) * 3), tiles = plan.tiles; let k = 0, done = 0;
    while (k < tiles.length) {
      const batch = []; let sum = 0;
      while (k < tiles.length && (batch.length === 0 || sum + tiles[k].count * 1.3 <= batchPts)) { batch.push(tiles[k]); sum += tiles[k].count * 1.3; k++; }
      const data = await gatherTiles(segs, plan, batch, margin, ctx);
      for (let t = 0; t < data.length; t++) {
        if (data[t].nCore) fn(data[t], k - batch.length + t);
        done += batch[t].count; await ctx.tick(); ctx.progress((o.p0 || 0) + ((o.p1 == null ? 1 : o.p1) - (o.p0 || 0)) * done / Math.max(1, plan.total));
        data[t] = null;
      }
    }
  }

  // ───── Сетка соседей по вокселям в плитке (CSR): воксель (ix,iy,iz) = floor((p - origin)/voxel | * inv) ─────
  // mode 'div' — деление (SOR), 'mul' — умножение на 1/voxel (радиус, шум) — как в плоских версиях, до бита.
  function buildCsr(pos, n, origin, voxel, mode) {
    const inv = 1 / voxel, hash = new VoxelHash(Math.max(1024, n >> 2)), cell = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let a, b, c;
      if (mode === 'div') { a = Math.floor((pos[i * 3] - origin[0]) / voxel); b = Math.floor((pos[i * 3 + 1] - origin[1]) / voxel); c = Math.floor((pos[i * 3 + 2] - origin[2]) / voxel); }
      else { a = Math.floor((pos[i * 3] - origin[0]) * inv); b = Math.floor((pos[i * 3 + 1] - origin[1]) * inv); c = Math.floor((pos[i * 3 + 2] - origin[2]) * inv); }
      cell[i] = hash.add(a | 0, b | 0, c | 0);
    }
    const nc = hash.size, start = new Uint32Array(nc + 1);
    for (let id = 0; id < nc; id++) start[id + 1] = start[id] + hash.cnt[id];
    const fill = new Uint32Array(nc), items = new Uint32Array(n);
    for (let i = 0; i < n; i++) { const id = cell[i]; items[start[id] + fill[id]++] = i; }
    // соседи 3×3×3 каждого вокселя (в порядке ox, oy, oz) — -1 если пусто
    const nbr = new Int32Array(nc * 27);
    for (let id = 0; id < nc; id++) {
      const x = hash.kx[id], y = hash.ky[id], z = hash.kz[id]; let q = id * 27;
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) nbr[q++] = hash.find(x + ox, y + oy, z + oz);
    }
    return { nc: nc, cell: cell, start: start, items: items, nbr: nbr };
  }

  // Средние расстояния до k ближайших соседей (3×3×3 вокселя) — как PCEdit.cleanStatisticalOutliers; считаются только для ядра плитки
  function sorScores(pos, n, core, origin, voxel, k, put) {
    const g = buildCsr(pos, n, origin, voxel, 'div'), best = new Float64Array(k), nbr = g.nbr, start = g.start, items = g.items;
    for (let i = 0; i < n; i++) {
      if (!core[i]) continue;
      const xi = pos[i * 3], yi = pos[i * 3 + 1], zi = pos[i * 3 + 2]; let m = 0; const base = g.cell[i] * 27;
      for (let q = 0; q < 27; q++) {
        const id = nbr[base + q]; if (id < 0) continue;
        for (let e = start[id], e1 = start[id + 1]; e < e1; e++) {
          const j = items[e]; if (j === i) continue;
          const dx = pos[j * 3] - xi, dy = pos[j * 3 + 1] - yi, dz = pos[j * 3 + 2] - zi, d2 = dx * dx + dy * dy + dz * dz;
          if (m < k) { let p = m++; while (p > 0 && best[p - 1] > d2) { best[p] = best[p - 1]; p--; } best[p] = d2; }
          else if (d2 < best[k - 1]) { let p = k - 1; while (p > 0 && best[p - 1] > d2) { best[p] = best[p - 1]; p--; } best[p] = d2; }
        }
      }
      if (!m) { put(i, Infinity); continue; }
      let sum = 0; for (let j = 0; j < m; j++) sum += Math.sqrt(best[j]);
      put(i, sum / m);
    }
  }
  // Радиусный фильтр: оставить точку, если в радиусе не меньше minN соседей (как PCEdit.cleanRadiusOutliers)
  function radiusKeep(pos, n, core, origin, radius, minN, put) {
    const g = buildCsr(pos, n, origin, radius, 'mul'), nbr = g.nbr, start = g.start, items = g.items, r2 = radius * radius;
    for (let i = 0; i < n; i++) {
      if (!core[i]) continue;
      const xi = pos[i * 3], yi = pos[i * 3 + 1], zi = pos[i * 3 + 2]; let cnt = 0; const base = g.cell[i] * 27;
      for (let q = 0; q < 27 && cnt < minN; q++) {
        const id = nbr[base + q]; if (id < 0) continue;
        for (let e = start[id], e1 = start[id + 1]; e < e1; e++) {
          const j = items[e]; if (j === i) continue;
          const ex = pos[j * 3] - xi, ey = pos[j * 3 + 1] - yi, ez = pos[j * 3 + 2] - zi;
          if (ex * ex + ey * ey + ez * ez <= r2) { cnt++; if (cnt >= minN) break; }
        }
      }
      put(i, cnt >= minN ? 1 : 0);
    }
  }
  function pe() { try { if (typeof module !== 'undefined' && typeof require === 'function') return require('./pointcloud-edit.js'); } catch (_) {} return root && root.PCEdit; }
  // Отклонение от локальной плоскости (как PCEdit.noiseFilterLocalPlane): первые CAP соседей из 3×3×3 вокселей, PCA
  function noiseDist(pos, n, core, origin, voxel, k, put) {
    const ev3 = pe() && pe()._smallestEV3; if (!ev3) throw new Error('PCEdit._smallestEV3 недоступен');
    const g = buildCsr(pos, n, origin, voxel, 'mul'), nbr = g.nbr, start = g.start, items = g.items, CAP = Math.max(24, Math.min(96, ((k | 0) * 4) || 64)), nbi = new Int32Array(CAP);
    for (let i = 0; i < n; i++) {
      if (!core[i]) continue;
      const xi = pos[i * 3], yi = pos[i * 3 + 1], zi = pos[i * 3 + 2]; let m = 0; const base = g.cell[i] * 27;
      for (let q = 0; q < 27 && m < CAP; q++) { const id = nbr[base + q]; if (id < 0) continue; for (let e = start[id], e1 = start[id + 1]; e < e1 && m < CAP; e++) nbi[m++] = items[e]; }
      if (m < 4) { put(i, 0); continue; }
      let cx = 0, cy = 0, cz = 0; for (let j = 0; j < m; j++) { const ni = nbi[j]; cx += pos[ni * 3]; cy += pos[ni * 3 + 1]; cz += pos[ni * 3 + 2]; } cx /= m; cy /= m; cz /= m;
      let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
      for (let j = 0; j < m; j++) { const ni = nbi[j], a2 = pos[ni * 3] - cx, b2 = pos[ni * 3 + 1] - cy, c2 = pos[ni * 3 + 2] - cz; xx += a2 * a2; xy += a2 * b2; xz += a2 * c2; yy += b2 * b2; yz += b2 * c2; zz += c2 * c2; }
      const nrm = ev3(xx, xy, xz, yy, yz, zz);
      put(i, Math.abs(nrm[0] * (xi - cx) + nrm[1] * (yi - cy) + nrm[2] * (zi - cz)));
    }
  }

  // ───── Фильтры по соседям плитками (SOR, радиус, шум) → маски удаления ─────
  async function sorMasks(segs, o, ctx) {
    ctx = ctxOf(ctx); o = o || {}; const n = total(segs), masks = new Array(segs.length).fill(null);
    if (n < 3) return { removed: 0, masks: masks, meanDist: 0, threshold: 0 };
    const k = Math.max(1, Math.floor(Number(o.k != null ? o.k : 16) || 16)), stdRatio = Math.max(0, Number(o.stdRatio != null ? o.stdRatio : 1.0));
    const bb = o.bounds || boundsOf(segs), diag = diagOf(bb); let voxel = o.voxel != null ? Number(o.voxel) : diag * 0.01; if (!(voxel > 0) || !Number.isFinite(voxel)) voxel = diag * 0.01 || 1e-3;
    const Ctor = n <= 8e6 ? Float64Array : Float32Array, sc = segs.map(function (g) { return new Ctor(g.n); });
    const plan = await planTiles(segs, { bounds: bb, target: o.tilePoints || 1200000, histCells: o.histCells }, ctx);
    let sum = 0, fin = 0;
    await eachTile(segs, plan, voxel * 2, ctx, function (t) {
      sorScores(t.pos, t.n, t.core, bb.mn, voxel, k, function (i, v) { sc[t.sid[i]][t.loc[i]] = v; if (v === v && v !== Infinity) { sum += v; fin++; } });
    }, { target: o.tilePoints || 1200000, p0: 0.02, p1: 0.8 });
    const mean = fin ? sum / fin : 0; let variance = 0;
    for (const a of sc) for (let i = 0; i < a.length; i++) { const v = a[i]; if (v !== Infinity) { const d = v - mean; variance += d * d; } }
    const std = fin ? Math.sqrt(variance / fin) : 0, thr = mean + stdRatio * std; let removed = 0;
    for (let s = 0; s < segs.length; s++) { const a = sc[s]; let m = null; for (let i = 0; i < a.length; i++) { const v = a[i]; if (!(v !== Infinity && v <= thr)) { if (!m) m = markMask(masks, s, a.length); m[i] = 1; removed++; } } }
    return { removed: removed, masks: masks, meanDist: mean, threshold: thr, voxel: voxel };
  }
  async function radiusMasks(segs, o, ctx) {
    ctx = ctxOf(ctx); o = o || {}; const n = total(segs), masks = new Array(segs.length).fill(null);
    if (n < 3) return { removed: 0, masks: masks, radius: 0 };
    const bb = o.bounds || boundsOf(segs), diag = diagOf(bb); let radius = o.radius != null ? o.radius : diag * 0.01; if (!(radius > 0)) radius = diag * 0.01 || 1e-3;
    const minN = o.minNeighbors != null ? o.minNeighbors : 8, plan = await planTiles(segs, { bounds: bb, target: o.tilePoints || 2500000, histCells: o.histCells }, ctx); let removed = 0;
    await eachTile(segs, plan, radius * 1.0001, ctx, function (t) {
      radiusKeep(t.pos, t.n, t.core, bb.mn, radius, minN, function (i, keep) { if (!keep) { markMask(masks, t.sid[i], segs[t.sid[i]].n)[t.loc[i]] = 1; removed++; } });
    }, { target: o.tilePoints || 2500000 });
    return { removed: removed, masks: masks, radius: radius, minNeighbors: minN };
  }
  async function noiseMasks(segs, o, ctx) {
    ctx = ctxOf(ctx); o = o || {}; const n = total(segs), masks = new Array(segs.length).fill(null);
    if (n < 8) return { removed: 0, masks: masks, threshold: 0 };
    const k = o.k != null ? o.k : 16, stdRatio = o.stdRatio != null ? o.stdRatio : 1.0, bb = o.bounds || boundsOf(segs), diag = diagOf(bb);
    let voxel = o.voxel != null ? o.voxel : diag * 0.01; if (voxel <= 0) voxel = diag * 0.01 || 1e-3;
    const Ctor = n <= 8e6 ? Float64Array : Float32Array, sc = segs.map(function (g) { return new Ctor(g.n); });
    const plan = await planTiles(segs, { bounds: bb, target: o.tilePoints || 1200000, histCells: o.histCells }, ctx); let sum = 0;
    await eachTile(segs, plan, voxel * 2, ctx, function (t) {
      noiseDist(t.pos, t.n, t.core, bb.mn, voxel, k, function (i, v) { sc[t.sid[i]][t.loc[i]] = v; sum += v; });
    }, { target: o.tilePoints || 1200000, p0: 0.02, p1: 0.8 });
    const mean = sum / n; let vs = 0; for (const a of sc) for (let i = 0; i < a.length; i++) { const d = a[i] - mean; vs += d * d; }
    const std = Math.sqrt(vs / n), thr = o.absTol != null ? o.absTol : (mean + stdRatio * std); let removed = 0;
    for (let s = 0; s < segs.length; s++) { const a = sc[s]; let m = null; for (let i = 0; i < a.length; i++) if (!(a[i] <= thr)) { if (!m) m = markMask(masks, s, a.length); m[i] = 1; removed++; } }
    return { removed: removed, masks: masks, threshold: thr, voxel: voxel };
  }

  // ───── Срез по оси: оставить точки в слое толщиной thickness вокруг at (как PCEdit.sliceSection) ─────
  async function sliceMasks(segs, o, ctx) {
    o = o || {}; const masks = new Array(segs.length).fill(null), axis = o.axis != null ? o.axis : 2, thickness = o.thickness != null ? o.thickness : 0.1; let at = o.at, removed = 0;
    if (!total(segs)) return { removed: 0, masks: masks };
    if (at == null) { const b = boundsOf(segs); at = (b.mn[axis] + b.mx[axis]) / 2; }
    const lo = at - thickness / 2, hi = at + thickness / 2;
    await eachBrick(segs, ctx, null, function (sg, s, i0, i1) { const P = sg.P; let m = null; for (let i = i0; i < i1; i++) { const v = P[i * 3 + axis]; if (!(v >= lo && v <= hi)) { if (!m) m = markMask(masks, s, sg.n); m[i] = 1; removed++; } } });
    return { removed: removed, masks: masks };
  }
  Object.assign(api, { VoxelHash: VoxelHash, densityMasks: densityMasks, clusterMasks: clusterMasks, planTiles: planTiles, gatherTiles: gatherTiles, eachTile: eachTile, buildCsr: buildCsr,
    sorScores: sorScores, radiusKeep: radiusKeep, noiseDist: noiseDist, sorMasks: sorMasks, radiusMasks: radiusMasks, noiseMasks: noiseMasks, sliceMasks: sliceMasks, markMask: markMask, countMasks: countMasks, dims: dims, diagOf: diagOf });
  // @@/PART:B@@
  // @@PART:C@@
  // ═════════════ Часть C: прореживание вокселями, классы, потоковый экспорт ═════════════
  const capOf = (sg) => (sg.P.length / 3) | 0;

  // Прореживание: один центроид на воксель по ВСЕМУ облаку (хеш-сетка, любые размеры). Возвращает новые сегменты (старые не меняются — на них откат).
  // { ok, segs|null (null — ничего не изменилось), kept, removed, voxel } либо { ok:false, error:'memory' }
  async function voxelDownsample(segs, o, ctx) {
    ctx = ctxOf(ctx); o = o || {};
    const N = total(segs);
    if (N < 2) return { ok: true, segs: null, kept: N, removed: 0, voxel: 0 };
    const bb = boundsOf(segs), dm = dims(bb), diag = diagOf(bb), span = Math.max(dm[0], dm[1], dm[2]);
    let voxel = Number(o.voxel); if (!(voxel > 0) || !isFinite(voxel)) voxel = diag * 0.01 || 1e-3;
    if (span / voxel > 2.0e9) voxel = span / 2.0e9;
    const inv = 1 / voxel, ox = bb.mn[0], oy = bb.mn[1], oz = bb.mn[2];
    const hasC = segs.some(function (g) { return g.C; }), hasI = segs.some(function (g) { return g.I; }), hasK = segs.some(function (g) { return g.K; });
    const H = new VoxelHash(Math.min(N, 1 << 21));
    let cap = H.cnt.length, sx, sy, sz, sr = null, sgn = null, sb = null, si = null, kv = null, kc = null; const votes = new Map();
    try {
      sx = new Float64Array(cap); sy = new Float64Array(cap); sz = new Float64Array(cap);
      if (hasC) { sr = new Float32Array(cap); sgn = new Float32Array(cap); sb = new Float32Array(cap); }
      if (hasI) si = new Float32Array(cap);
      if (hasK) { kv = new Uint8Array(cap); kc = new Uint32Array(cap); }
      const grow = function () {
        const c2 = H.cnt.length, f = function (a, T) { if (!a) return null; const b = new T(c2); b.set(a); return b; };
        sx = f(sx, Float64Array); sy = f(sy, Float64Array); sz = f(sz, Float64Array); sr = f(sr, Float32Array); sgn = f(sgn, Float32Array); sb = f(sb, Float32Array);
        si = f(si, Float32Array); kv = f(kv, Uint8Array); kc = f(kc, Uint32Array); cap = c2;
      };
      await eachBrick(segs, ctx, null, function (sg, s, i0, i1) {
        const P = sg.P, C = sg.C, I = sg.I, K = sg.K;
        for (let i = i0; i < i1; i++) {
          const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
          const id = H.add(Math.floor((x - ox) * inv), Math.floor((y - oy) * inv), Math.floor((z - oz) * inv));
          if (id >= cap) grow();
          sx[id] += x; sy[id] += y; sz[id] += z;
          if (sr && C) { sr[id] += C[i * 3]; sgn[id] += C[i * 3 + 1]; sb[id] += C[i * 3 + 2]; }
          if (si && I) si[id] += I[i];
          if (kv) {
            const cv = K ? K[i] : 0, vm = votes.size ? votes.get(id) : undefined;
            if (vm) vm.set(cv, (vm.get(cv) || 0) + 1);
            else if (!kc[id]) { kv[id] = cv; kc[id] = 1; }
            else if (cv === kv[id]) kc[id]++;
            else votes.set(id, new Map([[kv[id], kc[id]], [cv, 1]]));
          }
        }
      }, 0, 0.7);
      const V = H.size;
      if (V >= N) return { ok: true, segs: null, kept: N, removed: 0, voxel: voxel };
      const maxSeg = Math.max(1000, (o.maxSeg | 0) || 16000000), CH = (segs[0] && segs[0].chunk) || 1000000, out = [];
      for (let a = 0; a < V; a += maxSeg) {
        const n = Math.min(maxSeg, V - a);
        const sg = { P: new Float32Array(n * 3), C: hasC ? new Uint8Array(n * 3) : null, I: hasI ? new Uint16Array(n) : null, K: hasK ? new Uint8Array(n) : null,
          n: n, start: 0, chunk: CH, boxes: null, intensity: null, classification: null };
        const P = sg.P, C = sg.C, I = sg.I, K = sg.K;
        for (let j = 0; j < n; j++) {
          const id = a + j, c = H.cnt[id];
          P[j * 3] = sx[id] / c; P[j * 3 + 1] = sy[id] / c; P[j * 3 + 2] = sz[id] / c;
          if (C) { C[j * 3] = Math.round(sr[id] / c); C[j * 3 + 1] = Math.round(sgn[id] / c); C[j * 3 + 2] = Math.round(sb[id] / c); }
          if (I) I[j] = Math.min(65535, Math.round(si[id] / c));
          if (K) {
            const vm = votes.size ? votes.get(id) : undefined;
            if (!vm) K[j] = kv[id];
            else { let best = kv[id], bc = 0; vm.forEach(function (cnt, lab) { if (cnt > bc || (cnt === bc && lab < best)) { best = lab; bc = cnt; } }); K[j] = best; }
          }
          if ((j & 0x3ffff) === 0x3ffff) { await ctx.tick(); ctx.progress(0.7 + 0.3 * (a + j) / V); }
        }
        refreshViews(sg); recomputeBoxes(sg, 0); out.push(sg);
      }
      renumber(out);
      return { ok: true, segs: out, kept: V, removed: N - V, voxel: voxel };
    } catch (e) {
      if (e && e.cancelled) throw e;
      if (e instanceof RangeError) return { ok: false, error: 'memory' };
      throw e;
    }
  }

  // ───── классы: пол / потолок / стены по плоскостям, найденным в выборке, затем разметка ВСЕХ точек ─────
  // labels[s] — Uint8Array(n сегмента); counts — {floor,ceiling,wall,other}
  async function classifyBig(segs, o, ctx) {
    ctx = ctxOf(ctx); o = o || {}; const PE = pe(), N = total(segs);
    const labels = segs.map(function (g) { return new Uint8Array(g.n); });
    if (N < 16 || !PE || !PE.classifyPlanes) return { labels: labels, planes: [], counts: { floor: 0, ceiling: 0, wall: 0, other: N } };
    const every = Math.max(1, Math.ceil(N / Math.max(1000, (o.sampleMax | 0) || 2000000))), cnt = Math.ceil(N / every), sp = new Float32Array(cnt * 3);
    for (const sg of segs) {
      const P = sg.P, n = sg.n, st = sg.start;
      for (let j = (every - (st % every)) % every; j < n; j += every) { const s = Math.floor((st + j) / every); if (s >= cnt) break; sp[s * 3] = P[j * 3]; sp[s * 3 + 1] = P[j * 3 + 1]; sp[s * 3 + 2] = P[j * 3 + 2]; }
    }
    const bb = boundsOf(segs), cp = PE.classifyPlanes(sp, cnt, bb, o), planes = cp.planes, tol = cp.tol, np = planes.length;
    const nx = new Float64Array(np), ny = new Float64Array(np), nz = new Float64Array(np), dd = new Float64Array(np), cl = new Uint8Array(np);
    for (let p = 0; p < np; p++) { nx[p] = planes[p].normal[0]; ny[p] = planes[p].normal[1]; nz[p] = planes[p].normal[2]; dd[p] = planes[p].d; cl[p] = planes[p].cls; }
    const counts = [0, 0, 0, 0];
    await eachBrick(segs, ctx, null, function (sg, s, i0, i1) {
      const P = sg.P, L = labels[s];
      for (let i = i0; i < i1; i++) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]; let lab = 0;
        for (let p = 0; p < np; p++) { if (Math.abs(nx[p] * x + ny[p] * y + nz[p] * z + dd[p]) <= tol) { lab = cl[p]; break; } }
        L[i] = lab; counts[lab]++;
      }
    });
    return { labels: labels, planes: planes, tol: tol, counts: { floor: counts[1], ceiling: counts[2], wall: counts[3], other: counts[0] } };
  }
  // записывает метки в K всех сегментов; запись отката хранит прежние значения
  function applyLabelsBySeg(segs, labels) {
    const old = []; let bytes = 0;
    for (let s = 0; s < segs.length; s++) {
      const sg = segs[s]; old.push(sg.K ? sg.K.slice(0, sg.n) : null); if (sg.K) bytes += sg.n;
    }
    for (let s = 0; s < segs.length; s++) {
      const sg = segs[s]; if (!sg.K) sg.K = new Uint8Array(capOf(sg));
      sg.K.set(labels[s].subarray(0, sg.n)); refreshViews(sg);
    }
    return { kind: 'labels', old: old, bytes: bytes };
  }
  function restoreLabels(segs, rec) {
    if (!rec) return 0;
    for (let s = 0; s < segs.length; s++) {
      const sg = segs[s], o = rec.old[s];
      if (o) { if (!sg.K) sg.K = new Uint8Array(capOf(sg)); sg.K.set(o.subarray(0, sg.n)); } else sg.K = null;
      refreshViews(sg);
    }
    return segs.length;
  }
  // присваивает код класса выделенным точкам; { changed, rec }
  function assignClass(segs, sel, code) {
    code = Math.max(0, Math.min(255, code | 0)); const recs = []; let changed = 0, bytes = 0;
    for (let s = 0; s < segs.length; s++) {
      const m = sel.m[s]; if (!m) continue; const sg = segs[s], n = sg.n, had = !!sg.K; let K = sg.K, c = 0;
      for (let i = 0; i < n; i++) if (m[i] && (K ? K[i] : 0) !== code) c++;
      if (!c) continue;
      if (!K) { K = sg.K = new Uint8Array(capOf(sg)); }
      const idx = new Uint32Array(c), prev = new Uint8Array(c); let r = 0;
      for (let i = 0; i < n; i++) if (m[i] && K[i] !== code) { idx[r] = i; prev[r] = K[i]; r++; K[i] = code; }
      refreshViews(sg); recs.push({ s: s, had: had, idx: idx.subarray(0, r), prev: prev.subarray(0, r) }); changed += r; bytes += r * 5;
    }
    return { changed: changed, rec: changed ? { kind: 'assign', recs: recs, bytes: bytes } : null };
  }
  function restoreAssign(segs, rec) {
    if (!rec) return 0; let n = 0;
    for (const q of rec.recs) { const sg = segs[q.s]; if (!sg || !sg.K) continue; for (let k = 0; k < q.idx.length; k++) sg.K[q.idx[k]] = q.prev[k]; n += q.idx.length; if (!q.had) sg.K = null; refreshViews(sg); }
    return n;
  }
  // все метки классов одним массивом (для сохранения в проект)
  function labelsFlat(segs) {
    const out = new Uint8Array(total(segs));
    for (const sg of segs) if (sg.K) out.set(sg.K.subarray(0, sg.n), sg.start);
    return out;
  }
  // сколько точек каждого класса (по всем сегментам)
  function classHistogram(segs) {
    const h = new Float64Array(256);
    for (const sg of segs) { const K = sg.K, n = sg.n; if (!K) { h[0] += n; continue; } for (let i = 0; i < n; i++) h[K[i]]++; }
    return h;
  }

  // ───── потоковый экспорт: куски байт по ~200 тыс. точек, без сборки всего файла в памяти ─────
  function xfOf(meta) {
    const x = meta && meta.srcXform;
    return (x && x.t && x.t.length >= 3) ? { zup: x.axis === 'zup', t: [Number(x.t[0]), Number(x.t[1]), Number(x.t[2])] } : null;
  }
  const _enc = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
  function utf8(s) { if (_enc) return _enc.encode(s); return new Uint8Array(Buffer.from(s, 'utf8')); }
  function srcBounds(segs, xf) {
    const bb = boundsOf(segs); if (!bb) return { mn: [0, 0, 0], mx: [0, 0, 0] };
    if (!xf) return bb;
    const t = xf.t;
    if (xf.zup) return { mn: [bb.mn[0] + t[0], -bb.mx[2] + t[1], bb.mn[1] + t[2]], mx: [bb.mx[0] + t[0], -bb.mn[2] + t[1], bb.mx[1] + t[2]] };
    return { mn: [bb.mn[0] + t[0], bb.mn[1] + t[1], bb.mn[2] + t[2]], mx: [bb.mx[0] + t[0], bb.mx[1] + t[1], bb.mx[2] + t[2]] };
  }
  function plyPlan(segs, meta) {
    const N = total(segs), xf = xfOf(meta), zup = !!(xf && xf.zup);
    const hasC = segs.some(function (g) { return g.C; }), hasI = segs.some(function (g) { return g.I; }), hasK = segs.some(function (g) { return g.K; });
    let wide = zup;
    if (!wide) {
      let k = 0;
      outer: for (const sg of segs) {
        for (let i = 0; i < sg.n && k < 1000; i++, k++) {
          let a = Math.abs(sg.P[i * 3]), b = Math.abs(sg.P[i * 3 + 1]), c = Math.abs(sg.P[i * 3 + 2]);
          if (xf) { a = Math.abs(sg.P[i * 3] + xf.t[0]); b = Math.abs(sg.P[i * 3 + 1] + xf.t[1]); c = Math.abs(sg.P[i * 3 + 2] + xf.t[2]); }
          if (Math.max(a, b, c) > 100000) { wide = true; break outer; }
        }
        if (k >= 1000) break;
      }
    }
    const type = wide ? 'double' : 'float', bytes = wide ? 8 : 4;
    const h = ['ply', 'format binary_little_endian 1.0', 'comment BIM Twin survey point cloud', 'comment up=' + (zup ? 'z' : 'y')];
    if (meta && meta.units) h.push('comment units=' + String(meta.units).replace(/[\r\n]/g, ' '));
    if (meta && meta.crsWkt) h.push('comment crs_wkt_uri=' + encodeURIComponent(String(meta.crsWkt)));
    h.push('element vertex ' + N, 'property ' + type + ' x', 'property ' + type + ' y', 'property ' + type + ' z');
    if (hasI) h.push('property float intensity');
    if (hasC) h.push('property uchar red', 'property uchar green', 'property uchar blue');
    if (hasK) h.push('property uchar classification');
    h.push('end_header', '');
    return { N: N, xf: xf, zup: zup, wide: wide, hasC: hasC, hasI: hasI, hasK: hasK, stride: bytes * 3 + (hasI ? 4 : 0) + (hasC ? 3 : 0) + (hasK ? 1 : 0), header: utf8(h.join('\n')) };
  }
  async function* plyChunks(segs, plan, o, ctx) {
    const CP = Math.max(1000, (o && o.chunkPoints) | 0 || 200000), xf = plan.xf, zup = plan.zup, wide = plan.wide, stride = plan.stride, N = Math.max(1, plan.N); let done = 0;
    yield plan.header;
    for (const sg of segs) {
      const P = sg.P, C = sg.C, I = sg.I, K = sg.K, n = sg.n;
      for (let a = 0; a < n; a += CP) {
        const m = Math.min(CP, n - a), buf = new ArrayBuffer(m * stride), dv = new DataView(buf), u8 = new Uint8Array(buf); let o2 = 0;
        for (let j = 0; j < m; j++) {
          const i = a + j; let x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
          if (xf) { const t = xf.t; if (zup) { const py = y; x = x + t[0]; y = -z + t[1]; z = py + t[2]; } else { x += t[0]; y += t[1]; z += t[2]; } }
          if (wide) { dv.setFloat64(o2, x, true); dv.setFloat64(o2 + 8, y, true); dv.setFloat64(o2 + 16, z, true); o2 += 24; }
          else { dv.setFloat32(o2, x, true); dv.setFloat32(o2 + 4, y, true); dv.setFloat32(o2 + 8, z, true); o2 += 12; }
          if (plan.hasI) { dv.setFloat32(o2, I ? Math.fround(I[i] / 65535) : 0, true); o2 += 4; }
          if (plan.hasC) { if (C) { u8[o2] = C[i * 3]; u8[o2 + 1] = C[i * 3 + 1]; u8[o2 + 2] = C[i * 3 + 2]; } o2 += 3; }
          if (plan.hasK) u8[o2++] = K ? K[i] : 0;
        }
        yield u8; done += m; await ctx.tick(); ctx.progress(done / N);
      }
    }
  }
  function lasPlan(segs, meta) {
    const N = total(segs), xf = xfOf(meta), bb = srcBounds(segs, xf), mn = bb.mn.slice(), mx = bb.mx.slice();
    const hasC = segs.some(function (g) { return g.C; });
    const scale = [0.001, 0.001, 0.001], offset = mn.slice();
    for (let a = 0; a < 3; a++) scale[a] = Math.max(scale[a], (mx[a] - mn[a]) / 2147483000);
    const wkt = (meta && meta.crsWkt) ? String(meta.crsWkt) : '';
    let wb = wkt ? utf8(wkt + '\0') : new Uint8Array(0); if (wb.length > 65535) wb = new Uint8Array(0);
    const hd = 375, vlr = wb.length ? 54 + wb.length : 0, po = hd + vlr, rec = 36, head = new Uint8Array(po), dv = new DataView(head.buffer);
    head.set([0x4c, 0x41, 0x53, 0x46], 0); dv.setUint8(24, 1); dv.setUint8(25, 4); dv.setUint16(6, wb.length ? 0x10 : 0, true);
    const sys = 'BIM Twin'; for (let i = 0; i < sys.length; i++) { head[26 + i] = sys.charCodeAt(i); head[58 + i] = sys.charCodeAt(i); }
    dv.setUint16(94, hd, true); dv.setUint32(96, po, true); dv.setUint32(100, wb.length ? 1 : 0, true); dv.setUint8(104, 7); dv.setUint16(105, rec, true);
    dv.setUint32(107, 0, true); dv.setUint32(111, N >>> 0, true);
    for (let a = 0; a < 3; a++) { dv.setFloat64(131 + a * 8, scale[a], true); dv.setFloat64(155 + a * 8, offset[a], true); dv.setFloat64(179 + a * 16, mx[a], true); dv.setFloat64(187 + a * 16, mn[a], true); }
    if (typeof dv.setBigUint64 === 'function') dv.setBigUint64(247, BigInt(N), true);
    if (wb.length) { const v = hd; dv.setUint16(v, 0, true); head.set(utf8('LASF_Projection'), v + 2); dv.setUint16(v + 18, 2112, true); dv.setUint16(v + 20, wb.length, true); head.set(wb, v + 54); }
    return { N: N, xf: xf, hasC: hasC, scale: scale, offset: offset, rec: rec, header: head };
  }
  async function* lasChunks(segs, plan, o, ctx) {
    const CP = Math.max(1000, (o && o.chunkPoints) | 0 || 200000), xf = plan.xf, zup = !!(xf && xf.zup), rec = plan.rec, sc = plan.scale, of = plan.offset, N = Math.max(1, plan.N); let done = 0;
    yield plan.header;
    for (const sg of segs) {
      const P = sg.P, C = sg.C, I = sg.I, K = sg.K, n = sg.n;
      for (let a = 0; a < n; a += CP) {
        const m = Math.min(CP, n - a), buf = new ArrayBuffer(m * rec), dv = new DataView(buf), u8 = new Uint8Array(buf);
        for (let j = 0; j < m; j++) {
          const i = a + j, q = j * rec; let x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
          if (xf) { const t = xf.t; if (zup) { const py = y; x = x + t[0]; y = -z + t[1]; z = py + t[2]; } else { x += t[0]; y += t[1]; z += t[2]; } }
          dv.setInt32(q, Math.round((x - of[0]) / sc[0]), true); dv.setInt32(q + 4, Math.round((y - of[1]) / sc[1]), true); dv.setInt32(q + 8, Math.round((z - of[2]) / sc[2]), true);
          dv.setUint16(q + 12, I ? I[i] : 0, true); u8[q + 14] = 0x11; u8[q + 16] = K ? K[i] : 0;
          if (C) { dv.setUint16(q + 30, C[i * 3] * 257, true); dv.setUint16(q + 32, C[i * 3 + 1] * 257, true); dv.setUint16(q + 34, C[i * 3 + 2] * 257, true); }
          else { dv.setUint16(q + 30, 200 * 257, true); dv.setUint16(q + 32, 200 * 257, true); dv.setUint16(q + 34, 200 * 257, true); }
        }
        yield u8; done += m; await ctx.tick(); ctx.progress(done / N);
      }
    }
  }
  // текстовые форматы (формат строк — как у SmartSaveFmt.toXYZText / toPTSText / toPCDText / toCSVText)
  function textPlan(segs, fmt, meta) {
    const N = total(segs), xf = xfOf(meta), up = (xf && xf.zup) ? 'z' : 'y';
    const hasC = segs.some(function (g) { return g.C; }), hasI = segs.some(function (g) { return g.I; }), hasK = segs.some(function (g) { return g.K; });
    const f = ['x', 'y', 'z']; if (hasI) f.push('intensity');
    let head;
    const extra = [];
    if (meta && meta.units) extra.push(String(meta.units).replace(/[\r\n]/g, ' '));
    if (fmt === 'xyz') {
      if (hasC) f.push('red', 'green', 'blue'); if (hasK) f.push('classification');
      head = ['# BIM Twin XYZ point cloud', '# BIM_TWIN_UP=' + up, '# columns=' + f.join(' ')];
      if (meta && meta.units) head.push('# BIM_TWIN_UNITS=' + String(meta.units).replace(/[\r\n]/g, ' '));
      if (meta && meta.crsWkt) head.push('# BIM_TWIN_CRS_WKT_URI=' + encodeURIComponent(String(meta.crsWkt)));
    } else if (fmt === 'csv') {
      if (hasC) f.push('red', 'green', 'blue'); if (hasK) f.push('classification');
      head = ['# BIM Twin point cloud CSV', '# BIM_TWIN_UP=' + up, '# BIM_TWIN_CSV_COLUMNS=' + f.join(',')];
      if (meta && meta.units) head.push('# BIM_TWIN_UNITS=' + String(meta.units).replace(/[\r\n]/g, ' '));
      if (meta && meta.crsWkt) head.push('# BIM_TWIN_CRS_WKT_URI=' + encodeURIComponent(String(meta.crsWkt)));
      head.push(f.join(','));
    } else if (fmt === 'obj') {
      head = ['# BIM Twin point cloud export (' + N + ' pts)'];
    } else if (fmt === 'pts') {
      head = ['' + N];
    } else if (fmt === 'pcd') {
      const pf = ['x', 'y', 'z']; if (hasI) pf.push('intensity'); if (hasK) pf.push('classification'); if (hasC) pf.push('rgb');
      head = ['# .PCD v0.7 - BIM Twin point cloud', '# BIM_TWIN_UP=' + up, (meta && meta.units) ? '# BIM_TWIN_UNITS=' + String(meta.units).replace(/[\r\n]/g, ' ') : '',
        (meta && meta.crsWkt) ? '# BIM_TWIN_CRS_WKT_URI=' + encodeURIComponent(String(meta.crsWkt)) : '', 'VERSION 0.7', 'FIELDS ' + pf.join(' '),
        'SIZE ' + pf.map(function (q) { return q === 'classification' ? 1 : 4; }).join(' '), 'TYPE ' + pf.map(function (q) { return (q === 'classification' || q === 'rgb') ? 'U' : 'F'; }).join(' '),
        'COUNT ' + pf.map(function () { return '1'; }).join(' '), 'WIDTH ' + N, 'HEIGHT 1', 'VIEWPOINT 0 0 0 1 0 0 0', 'POINTS ' + N, 'DATA ascii'].filter(Boolean);
    }
    return { N: N, xf: xf, hasC: hasC, hasI: hasI, hasK: hasK, fmt: fmt, header: utf8(head.join('\n') + '\n') };
  }
  async function* textChunks(segs, plan, o, ctx) {
    const CP = Math.max(1000, (o && o.chunkPoints) | 0 || 40000), xf = plan.xf, zup = !!(xf && xf.zup), fmt = plan.fmt, sep = fmt === 'csv' ? ',' : ' ', N = Math.max(1, plan.N); let done = 0;
    yield plan.header;
    for (const sg of segs) {
      const P = sg.P, C = sg.C, I = sg.I, K = sg.K, n = sg.n;
      for (let a = 0; a < n; a += CP) {
        const m = Math.min(CP, n - a), rows = new Array(m);
        for (let j = 0; j < m; j++) {
          const i = a + j; let x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
          if (xf) { const t = xf.t; if (zup) { const py = y; x = x + t[0]; y = -z + t[1]; z = py + t[2]; } else { x += t[0]; y += t[1]; z += t[2]; } }
          const r = C ? C[i * 3] : 200, g = C ? C[i * 3 + 1] : 200, b = C ? C[i * 3 + 2] : 200;
          if (fmt === 'obj') rows[j] = 'v ' + x + ' ' + y + ' ' + z + (plan.hasC ? ' ' + (r / 255).toFixed(4) + ' ' + (g / 255).toFixed(4) + ' ' + (b / 255).toFixed(4) : '');
          else if (fmt === 'pts') rows[j] = x + ' ' + y + ' ' + z + ' ' + (plan.hasI && I ? I[i] : 0) + ' ' + r + ' ' + g + ' ' + b;
          else if (fmt === 'pcd') {
            let s = x + ' ' + y + ' ' + z;
            if (plan.hasI) s += ' ' + (I ? Math.max(0, Math.min(1, Math.fround(I[i] / 65535))) : 0);
            if (plan.hasK) s += ' ' + (K ? K[i] : 0);
            if (plan.hasC) s += ' ' + ((((r & 255) << 16) | ((g & 255) << 8) | (b & 255)) >>> 0);
            rows[j] = s;
          } else {
            let s = x + sep + y + sep + z;
            if (plan.hasI) s += sep + (I ? Math.fround(I[i] / 65535) : 0);
            if (plan.hasC) s += sep + r + sep + g + sep + b;
            if (plan.hasK) s += sep + (K ? K[i] : 0);
            rows[j] = s;
          }
        }
        yield utf8(rows.join('\n') + '\n'); done += m; await ctx.tick(); ctx.progress(done / N);
      }
    }
  }
  const EXPORT_FORMATS = ['ply', 'las', 'xyz', 'pts', 'pcd', 'csv', 'obj'];
  // { fmt, count, expectedBytes|null, chunks: AsyncGenerator<Uint8Array> }
  function exportStream(segs, fmt, o, ctx) {
    o = o || {}; ctx = ctxOf(ctx || o.ctx); const meta = o.meta || {}, N = total(segs);
    if (fmt === 'ply') { const p = plyPlan(segs, meta); return { fmt: fmt, count: N, expectedBytes: p.header.length + N * p.stride, chunks: plyChunks(segs, p, o, ctx) }; }
    if (fmt === 'las') { const p = lasPlan(segs, meta); return { fmt: fmt, count: N, expectedBytes: p.header.length + N * p.rec, chunks: lasChunks(segs, p, o, ctx) }; }
    if (fmt === 'xyz' || fmt === 'pts' || fmt === 'pcd' || fmt === 'csv' || fmt === 'obj') { const p = textPlan(segs, fmt, meta); return { fmt: fmt, count: N, expectedBytes: null, chunks: textChunks(segs, p, o, ctx) }; }
    throw new Error('unsupported_format');
  }
  Object.assign(api, { voxelDownsample: voxelDownsample, classifyBig: classifyBig, applyLabelsBySeg: applyLabelsBySeg, restoreLabels: restoreLabels, assignClass: assignClass, restoreAssign: restoreAssign,
    labelsFlat: labelsFlat, classHistogram: classHistogram, exportStream: exportStream, EXPORT_FORMATS: EXPORT_FORMATS, srcBounds: srcBounds, capOf: capOf });
  // @@/PART:C@@
  // @@PART:D@@
  // ═════════════ Часть D: секущий бокс, окна вокруг выделения, защита плоскостей ═════════════
  // Точки внутри бокса [mn,mx] — во временные сегменты (≤ maxSeg точек) с номерами исходных точек (src). attrs — копировать и цвет/интенсивность/класс.
  async function clipSubset(segs, mn, mx, o, ctx) {
    ctx = ctxOf(ctx); o = o || {}; const maxSeg = Math.max(1, (o.maxSeg | 0) || 16000000), attrs = !!o.attrs, CH = (segs[0] && segs[0].chunk) || 1000000;
    const pred = boxOverlap(mn, mx); let cnt = 0;
    await eachBrick(segs, ctx, pred, function (sg, s, i0, i1) {
      const P = sg.P; for (let i = i0; i < i1; i++) { const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]; if (x >= mn[0] && x <= mx[0] && y >= mn[1] && y <= mx[1] && z >= mn[2] && z <= mx[2]) cnt++; }
    }, 0, 0.3);
    const out = [];
    if (cnt) {
      const hasC = attrs && segs.some(function (g) { return g.C; }), hasI = attrs && segs.some(function (g) { return g.I; }), hasK = attrs && segs.some(function (g) { return g.K; });
      for (let a = 0; a < cnt; a += maxSeg) {
        const n = Math.min(maxSeg, cnt - a);
        out.push({ P: new Float32Array(n * 3), C: hasC ? new Uint8Array(n * 3) : null, I: hasI ? new Uint16Array(n) : null, K: hasK ? new Uint8Array(n) : null, src: new Uint32Array(n), n: n, start: 0, chunk: CH, boxes: null, intensity: null, classification: null });
      }
      let oi = 0, w = 0, cur = out[0];
      await eachBrick(segs, ctx, pred, function (sg, s, i0, i1) {
        const P = sg.P, C = sg.C, I = sg.I, K = sg.K, base = sg.start;
        for (let i = i0; i < i1; i++) {
          const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
          if (!(x >= mn[0] && x <= mx[0] && y >= mn[1] && y <= mx[1] && z >= mn[2] && z <= mx[2])) continue;
          if (w >= cur.n) { oi++; cur = out[oi]; w = 0; }
          cur.P[w * 3] = x; cur.P[w * 3 + 1] = y; cur.P[w * 3 + 2] = z; cur.src[w] = base + i;
          if (cur.C) { if (C) { cur.C[w * 3] = C[i * 3]; cur.C[w * 3 + 1] = C[i * 3 + 1]; cur.C[w * 3 + 2] = C[i * 3 + 2]; } }
          if (cur.I && I) cur.I[w] = I[i]; if (cur.K && K) cur.K[w] = K[i];
          w++;
        }
      }, 0.3, 1);
      for (const g of out) { refreshViews(g); recomputeBoxes(g, 0); }
      renumber(out);
    }
    // маски временных сегментов → маски исходных сегментов (null — ничего)
    function mapBack(masks) {
      const res = new Array(segs.length).fill(null); let s = 0, cntm = 0;
      for (let t = 0; t < out.length; t++) {
        const m = masks[t]; if (!m) continue; const src = out[t].src, n = out[t].n;
        for (let i = 0; i < n; i++) {
          if (!m[i]) continue; const g = src[i];
          if (!(s < segs.length && g >= segs[s].start && g < segs[s].start + segs[s].n)) s = locate(segs, g);
          if (s < 0) { s = 0; continue; }
          markMask(res, s, segs[s].n)[g - segs[s].start] = 1; cntm++;
        }
      }
      res.count = cntm; return res;
    }
    function allMasks() { return out.map(function (g) { return new Uint8Array(g.n).fill(1); }); }
    return { segs: out, count: cnt, mapBack: mapBack, allMasks: allMasks };
  }
  // равномерная выборка ≤ cap точек из бокса (как у protectFloorLocal: k-я точка окна при шаге L/cap); { pos, count, total }
  async function windowSample(segs, mn, mx, cap, ctx) {
    ctx = ctxOf(ctx); const pred = boxOverlap(mn, mx); let L = 0;
    await eachBrick(segs, ctx, pred, function (sg, s, i0, i1) { const P = sg.P; for (let i = i0; i < i1; i++) { const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]; if (x >= mn[0] && x <= mx[0] && y >= mn[1] && y <= mx[1] && z >= mn[2] && z <= mx[2]) L++; } }, 0, 0.5);
    if (!L) return { pos: new Float32Array(0), count: 0, total: 0 };
    const useAll = L <= cap, m = useAll ? L : cap, step = useAll ? 1 : L / cap, pos = new Float32Array(m * 3); let k = 0, j = 0;
    await eachBrick(segs, ctx, pred, function (sg, s, i0, i1) {
      const P = sg.P;
      for (let i = i0; i < i1; i++) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        if (!(x >= mn[0] && x <= mx[0] && y >= mn[1] && y <= mx[1] && z >= mn[2] && z <= mx[2])) continue;
        while (j < m && ((j * step) | 0) === k) { pos[j * 3] = x; pos[j * 3 + 1] = y; pos[j * 3 + 2] = z; j++; }
        k++;
      }
    }, 0.5, 1);
    return { pos: j === m ? pos : pos.subarray(0, j * 3), count: j, total: L };
  }
  // убирает из выделения точки, лежащие на защищённых плоскостях (полоса ±tol); возвращает число убранных
  async function unselectOnPlanes(segs, sel, planes, tol, ctx) {
    ctx = ctxOf(ctx); if (!planes || !planes.length) return 0; let dropped = 0; const np = planes.length;
    const nx = new Float64Array(np), ny = new Float64Array(np), nz = new Float64Array(np), dd = new Float64Array(np);
    for (let p = 0; p < np; p++) { nx[p] = planes[p].normal[0]; ny[p] = planes[p].normal[1]; nz[p] = planes[p].normal[2]; dd[p] = planes[p].d; }
    await eachBrick(segs, ctx, null, function (sg, s, i0, i1) {
      const m = sel.m[s]; if (!m) return; const P = sg.P;
      for (let i = i0; i < i1; i++) {
        if (!m[i]) continue; const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        for (let p = 0; p < np; p++) { if (Math.abs(nx[p] * x + ny[p] * y + nz[p] * z + dd[p]) <= tol) { m[i] = 0; dropped++; break; } }
      }
    });
    sel.size -= dropped; return dropped;
  }
  // добавляет точки (pos Float32 xyz, col Uint8 | null) отдельным новым сегментом в конец; возвращает сегмент
  function appendSegment(segs, pos, col, o) {
    o = o || {}; const n = (pos.length / 3) | 0, hasC = segs.some(function (g) { return g.C; }), hasI = segs.some(function (g) { return g.I; }), hasK = segs.some(function (g) { return g.K; });
    const sg = { P: pos, C: hasC ? (col || new Uint8Array(n * 3)) : null, I: hasI ? new Uint16Array(n) : null, K: hasK ? new Uint8Array(n) : null, n: n, start: 0, chunk: (segs[0] && segs[0].chunk) || 1000000, boxes: null, intensity: null, classification: null };
    refreshViews(sg); recomputeBoxes(sg, 0); segs.push(sg); renumber(segs); return sg;
  }
  // равномерная выборка из ВСЕГО облака (pos + цвет) до cap точек — для инструментов, которым нужны плоские массивы (3DGS и т.п.)
  async function sampleAll(segs, cap, ctx) {
    ctx = ctxOf(ctx); const L = total(segs);
    if (!L) return { pos: new Float32Array(0), col: null, count: 0, total: 0 };
    const m = Math.max(1, Math.min(L, Math.floor(cap) || L)), step = L / m, pos = new Float32Array(m * 3);
    const hasC = segs.every(function (g) { return !g.n || g.C; }), col = hasC ? new Uint8Array(m * 3) : null; let k = 0, j = 0;
    await eachBrick(segs, ctx, null, function (sg, s, i0, i1) {
      const P = sg.P, C = sg.C;
      for (let i = i0; i < i1; i++) {
        while (j < m && ((j * step) | 0) === k) {
          pos[j * 3] = P[i * 3]; pos[j * 3 + 1] = P[i * 3 + 1]; pos[j * 3 + 2] = P[i * 3 + 2];
          if (col) { col[j * 3] = C[i * 3]; col[j * 3 + 1] = C[i * 3 + 1]; col[j * 3 + 2] = C[i * 3 + 2]; }
          j++;
        }
        k++;
      }
    });
    return { pos: j === m ? pos : pos.subarray(0, j * 3), col: col ? (j === m ? col : col.subarray(0, j * 3)) : null, count: j, total: L };
  }
  Object.assign(api, { clipSubset: clipSubset, windowSample: windowSample, sampleAll: sampleAll, unselectOnPlanes: unselectOnPlanes, appendSegment: appendSegment });
  // @@/PART:D@@
  // @@PART:E@@
  // ═════════════ Часть E: выбор рамкой / лассо по экрану, маркеры, окна ═════════════
  function screenShape(shape) {
    if (shape.kind === 'poly') {
      const poly = shape.poly, V = poly.length, px = new Float64Array(V), py = new Float64Array(V);
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (let v = 0; v < V; v++) { const X = poly[v][0], Y = poly[v][1]; px[v] = X; py[v] = Y; if (X < bx0) bx0 = X; if (X > bx1) bx1 = X; if (Y < by0) by0 = Y; if (Y > by1) by1 = Y; }
      return {
        nb: { x0: bx0, y0: by0, x1: bx1, y1: by1 },
        test: function (x, y) {
          let inside = false;
          for (let a = 0, b = V - 1; a < V; b = a++) {
            const yi = py[a], yj = py[b];
            if ((yi > y) !== (yj > y)) { const xi = px[a], xj = px[b]; if (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-20) + xi) inside = !inside; }
          }
          return inside;
        }
      };
    }
    return { nb: { x0: Math.min(shape.x0, shape.x1), y0: Math.min(shape.y0, shape.y1), x1: Math.max(shape.x0, shape.x1), y1: Math.max(shape.y0, shape.y1) }, test: function () { return true; } };
  }
  // кирпич пропускается, только если вся его рамка на экране лежит вне области выбора
  function screenPred(M, nb) {
    const E = 1e-4;
    return function (B, o) {
      let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
      for (let k = 0; k < 8; k++) {
        const x = (k & 1) ? B[o + 3] : B[o], y = (k & 2) ? B[o + 4] : B[o + 1], z = (k & 4) ? B[o + 5] : B[o + 2];
        const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
        if (cw <= 1e-9) return true;
        const nx = (M[0] * x + M[4] * y + M[8] * z + M[12]) / cw, ny = (M[1] * x + M[5] * y + M[9] * z + M[13]) / cw;
        if (nx < mnx) mnx = nx; if (nx > mxx) mxx = nx; if (ny < mny) mny = ny; if (ny > mxy) mxy = ny;
      }
      return !(mxx < nb.x0 - E || mnx > nb.x1 + E || mxy < nb.y0 - E || mny > nb.y1 + E);
    };
  }
  // fn(sg, s, i, nx, ny, d) — для каждой точки в области (проекция и глубина округлены до float32, как у плоской проекции)
  async function scanScreen(segs, M, nb, test, ctx, fn, p0, p1) {
    const m0 = M[0], m1 = M[1], m3 = M[3], m4 = M[4], m5 = M[5], m7 = M[7], m8 = M[8], m9 = M[9], m11 = M[11], m12 = M[12], m13 = M[13], m15 = M[15], fr = Math.fround;
    await eachBrick(segs, ctx, screenPred(M, nb), function (sg, s, i0, i1) {
      const P = sg.P;
      for (let i = i0; i < i1; i++) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        const cw = m3 * x + m7 * y + m11 * z + m15; if (cw <= 0) continue;
        const nx = fr((m0 * x + m4 * y + m8 * z + m12) / cw), ny = fr((m1 * x + m5 * y + m9 * z + m13) / cw);
        if (!(nx >= nb.x0 && nx <= nb.x1 && ny >= nb.y0 && ny <= nb.y1)) continue;
        if (!test(nx, ny)) continue;
        fn(sg, s, i, nx, ny, fr(cw));
      }
    }, p0, p1);
  }
  function projectPoint(M, p) {
    const x = p[0], y = p[1], z = p[2], cw = M[3] * x + M[7] * y + M[11] * z + M[15];
    if (cw <= 0) return { nx: NaN, ny: NaN, d: NaN };
    return { nx: Math.fround((M[0] * x + M[4] * y + M[8] * z + M[12]) / cw), ny: Math.fround((M[1] * x + M[5] * y + M[9] * z + M[13]) / cw), d: Math.fround(cw) };
  }
  // выбранные точки → { pos, depth, ref } (для кластеризации переднего слоя)
  function gatherPD(segs, sel, M) {
    const n = sel.size, pos = new Float32Array(n * 3), depth = new Float32Array(n), ref = new Uint32Array(n); let k = 0;
    for (let s = 0; s < segs.length; s++) {
      const m = sel.m[s]; if (!m) continue; const sg = segs[s], P = sg.P;
      for (let i = 0; i < sg.n; i++) {
        if (!m[i]) continue; const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z; const cw = M[3] * x + M[7] * y + M[11] * z + M[15]; depth[k] = cw > 0 ? cw : NaN; ref[k] = sg.start + i; k++;
      }
    }
    return { pos: pos, depth: depth, ref: ref, count: k };
  }
  // Выбор рамкой/лассо ВИДИМЫХ точек всего облака (те же правила глубины, что у плоского выбора).
  // shape: {kind:'rect',x0,y0,x1,y1} | {kind:'poly',poly:[[x,y]…]} в NDC; M — матрица вид·проекция (column-major).
  // o: { mode:0|1|2, through, vis: ID видимых точек (из GPU) | null, spacing, diag, inClip, cluster(pos,depth,voxel,band)→локальные индексы, clusterVoxel, bandDefault, cssW, cssH }
  async function selectScreen(segs, M, shape, o, ctx) {
    ctx = ctxOf(ctx); o = o || {};
    const sh = screenShape(shape), nb = sh.nb, test = sh.test, mode = o.through ? 2 : (o.mode | 0), inClip = o.inClip || null;
    const sp0 = o.spacing > 0 ? o.spacing : 0.02, diag = o.diag > 0 ? o.diag : 8, fr = Math.fround;
    const out = new BigSel(segs), mk = [];
    const mark = function (s, i) { (mk[s] || (mk[s] = out.mask(s, true)))[i] = 1; };
    const markId = function (g) { const s = locate(segs, g); if (s >= 0) mark(s, g - segs[s].start); };
    async function finish(band) {
      out.recount(); let sel = out;
      if (mode < 2 && typeof o.cluster === 'function' && sel.size >= 24 && sel.size <= 3000000) {
        const g = gatherPD(segs, sel, M); let keep = null;
        try { keep = o.cluster(g.pos, g.depth, o.clusterVoxel, band > 0 ? band : o.bandDefault); } catch (_) { keep = null; }
        if (keep && keep.length !== g.count) { const ids = new Uint32Array(keep.length); for (let k = 0; k < keep.length; k++) ids[k] = g.ref[keep[k]]; sel = selectIndices(segs, ids); }
      }
      if (inClip && sel.size) {
        await eachBrick(segs, ctx, null, function (sg, s, i0, i1) { const m = sel.m[s]; if (!m) return; const P = sg.P; for (let i = i0; i < i1; i++) if (m[i] && !inClip(P[i * 3], P[i * 3 + 1], P[i * 3 + 2])) m[i] = 0; }, 0.9, 1);
        sel.recount();
      }
      return sel;
    }
    if (mode >= 2) {   // насквозь — всё, что попало в контур
      await scanScreen(segs, M, nb, test, ctx, function (sg, s, i) { if (!inClip || inClip(sg.P[i * 3], sg.P[i * 3 + 1], sg.P[i * 3 + 2])) mark(s, i); }, 0, 1);
      out.recount(); return out;
    }
    const visAll = o.vis && o.vis.length ? Array.from(o.vis) : null;
    if (visAll) {
      // видимые точки, чьи центры попали в контур (иначе — все видимые)
      const vIn = [], vDepth = new Map(), vXY = new Map();
      for (const g of visAll) {
        const p = pointAt(segs, g); if (!p) continue; const q = projectPoint(M, p); vDepth.set(g, q.d); vXY.set(g, q);
        if (q.nx >= nb.x0 && q.nx <= nb.x1 && q.ny >= nb.y0 && q.ny <= nb.y1 && test(q.nx, q.ny)) vIn.push(g);
      }
      const baseVis = vIn.length ? vIn : visAll.filter(function (g) { return vDepth.has(g); });
      if (!baseVis.length) { out.recount(); return out; }
      if (mode === 0) {
        let front0 = Infinity; for (const g of baseVis) { const d = vDepth.get(g); if (d === d && d < front0) front0 = d; }
        if (!(front0 < Infinity)) { for (const g of baseVis) markId(g); return finish(0); }
        const gapTh0 = Math.max(sp0 * 8, 0.2), maxBand0 = Math.max(sp0 * 30, 0.6), lo = front0 - sp0;
        const R = maxBand0 + sp0 + gapTh0, b = Math.max(sp0 * 0.25, R / 8192), nbins = Math.ceil(R / b) + 2, hist = new Uint32Array(nbins);
        await scanScreen(segs, M, nb, test, ctx, function (sg, s, i, nx, ny, d) { if (d >= lo) { let k = ((d - lo) / b) | 0; if (k >= nbins) k = nbins - 1; hist[k]++; } }, 0, 0.45);
        let cut0 = front0 + maxBand0, prev = front0;
        for (let k = 0; k < nbins; k++) {
          if (!hist[k]) continue; const lowE = lo + k * b;
          if (lowE - prev > gapTh0) { cut0 = prev; break; }
          if (lowE - front0 >= maxBand0) break;
          prev = lo + (k + 1) * b;
        }
        if (cut0 > front0 + maxBand0) cut0 = front0 + maxBand0;
        await scanScreen(segs, M, nb, test, ctx, function (sg, s, i, nx, ny, d) { if (d >= lo && d <= cut0) mark(s, i); }, 0.45, 0.9);
        for (const g of baseVis) markId(g);
        return finish((cut0 - front0) + sp0);
      }
      // режим 1: видимое + слой за локальной видимой поверхностью (карта ближней глубины 64×64)
      const band = Math.min(Math.max(diag * 0.03, 0.6), 3), gw = 64, gh = 64, near = new Float32Array(gw * gh).fill(Infinity);
      const cellIdx = function (x, y) {
        let gx = ((x + 1) * 0.5 * gw) | 0, gy = ((1 - (y + 1) * 0.5) * gh) | 0;
        if (gx < 0) gx = 0; else if (gx >= gw) gx = gw - 1; if (gy < 0) gy = 0; else if (gy >= gh) gy = gh - 1;
        return gy * gw + gx;
      };
      let globalNear = Infinity;
      for (const g of baseVis) { const d = vDepth.get(g); if (d !== d) continue; if (d < globalNear) globalNear = d; const q = vXY.get(g); if (q.nx < -1 || q.nx > 1 || q.ny < -1 || q.ny > 1) continue; const ci = cellIdx(q.nx, q.ny); if (d < near[ci]) near[ci] = d; }
      await scanScreen(segs, M, nb, test, ctx, function (sg, s, i, nx, ny, d) { let ln = near[cellIdx(nx, ny)]; if (!(ln < Infinity)) ln = globalNear; if (d <= ln + band) mark(s, i); }, 0, 0.9);
      for (const g of baseVis) markId(g);
      return finish(0);
    }
    // запасной путь (GPU-выбор недоступен): экранный z-буфер по всем точкам, ячейка 4 px
    const cssW = Math.max(1, o.cssW || 800), cssH = Math.max(1, o.cssH || 600), gw = Math.max(1, Math.ceil(cssW / 4)), gh = Math.max(1, Math.ceil(cssH / 4)), grid = new Float32Array(gw * gh).fill(Infinity);
    const cellOf = function (x, y) {
      let gx = ((x * 0.5 + 0.5) * gw) | 0, gy = ((1 - (y * 0.5 + 0.5)) * gh) | 0;
      if (gx < 0) gx = 0; else if (gx >= gw) gx = gw - 1; if (gy < 0) gy = 0; else if (gy >= gh) gy = gh - 1;
      return gy * gw + gx;
    };
    await scanScreen(segs, M, { x0: -1, y0: -1, x1: 1, y1: 1 }, function () { return true; }, ctx, function (sg, s, i, nx, ny, d) { const ci = cellOf(nx, ny); if (d < grid[ci]) grid[ci] = d; }, 0, 0.4);
    const tolBase = mode === 0 ? 0.12 : 0.6, tolMax = mode === 0 ? Math.min(Math.max(diag * 0.006, 0.12), 0.5) : Math.min(Math.max(diag * 0.04, 0.6), 3), tolRel = mode === 0 ? 0.01 : 0.03;
    let cnt = 0;
    await scanScreen(segs, M, nb, test, ctx, function (sg, s, i, nx, ny, d) { const near = grid[cellOf(nx, ny)], tol = Math.min(tolMax, tolBase + d * tolRel); if (d <= near + tol) { mark(s, i); cnt++; } }, 0.4, 0.8);
    if (!cnt) await scanScreen(segs, M, nb, test, ctx, function (sg, s, i) { mark(s, i); }, 0.8, 0.9);
    return finish(0);
  }
  // Маркеры подсветки выделения: до cap точек равномерно (Float32 xyz)
  function markerSample(segs, sel, cap) {
    const total = sel ? sel.size : 0; if (!total) return new Float32Array(0);
    const stride = total > cap ? Math.ceil(total / cap) : 1, n = Math.min(total, cap), pos = new Float32Array(n * 3); let j = 0, c = 0;
    for (let s = 0; s < segs.length && j < n; s++) {
      const m = sel.m[s]; if (!m) continue; const P = segs[s].P, sn = segs[s].n;
      for (let i = 0; i < sn && j < n; i++) { if (!m[i]) continue; if ((c++ % stride) !== 0) continue; pos[j * 3] = P[i * 3]; pos[j * 3 + 1] = P[i * 3 + 1]; pos[j * 3 + 2] = P[i * 3 + 2]; j++; }
    }
    return j === n ? pos : pos.subarray(0, j * 3);
  }
  // число точек в боксе (для выбора размера окна)
  async function countBox(segs, mn, mx, ctx) {
    let cnt = 0;
    await eachBrick(segs, ctx, boxOverlap(mn, mx), function (sg, s, i0, i1) { const P = sg.P; for (let i = i0; i < i1; i++) { const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]; if (x >= mn[0] && x <= mx[0] && y >= mn[1] && y <= mx[1] && z >= mn[2] && z <= mx[2]) cnt++; } });
    return cnt;
  }
  // Окно вокруг точки c: бокс ±R, при числе точек > limit радиус уменьшается; { segs:[одна временная], pos, count, mapBack, R }
  async function windowAround(segs, c, R, limit, ctx) {
    let r = R; ctx = ctxOf(ctx);
    for (let it = 0; it < 12; it++) {
      const mn = [c[0] - r, c[1] - r, c[2] - r], mx = [c[0] + r, c[1] + r, c[2] + r], n = await countBox(segs, mn, mx, ctx);
      if (n <= limit || it === 11) { const w = await clipSubset(segs, mn, mx, { maxSeg: Math.max(1, n) }, ctx); return { segs: w.segs, pos: w.segs.length ? w.segs[0].P : new Float32Array(0), count: w.count, mapBack: w.mapBack, R: r, box: [mn, mx] }; }
      r *= Math.max(0.3, Math.min(0.8, Math.cbrt(limit / n)));
    }
    return null;
  }
  Object.assign(api, { selectScreen: selectScreen, scanScreen: scanScreen, projectPoint: projectPoint, gatherPD: gatherPD, markerSample: markerSample, countBox: countBox, windowAround: windowAround });
  // @@/PART:E@@
  // @@PARTS@@
  return api;
});
