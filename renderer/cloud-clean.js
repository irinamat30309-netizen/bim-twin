/* cloud-clean.js — v1170
 * «Умная» очистка облака и локальная плотность точек. Чистые функции над типизированными массивами (UMD: window/self.CloudClean, module.exports).
 *  • spacingGen/spacingField — локальный шаг точек по ячейкам (пирамида счётчиков): размер точки на экране вблизи подбирается под
 *    плотность именно этого места, а не под среднюю по всей сцене. Один проход подсчёта + один проход записи, память ≈ O(ячеек).
 * Алгоритмы — генераторы: окно рисования выполняет их по кусочкам (не замораживая интерфейс), воркеры и Node — целиком (run()).
 * Прогресс: ctl.progress(доля 0..1, подпись). Отмена — terminate() воркера.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./cloud-process.js'));
  else root.CloudClean = factory(root.CloudProcess);
})(typeof self !== 'undefined' ? self : this, function (CP) {
  'use strict';

  var CHUNK = 262144;               // точек между точками уступки управления (yield)
  var KAPPA = 1.3;                  // средняя площадь поверхности в ячейке = KAPPA·h² (плоскость под произвольным углом)
  var CMIN = 10;                    // минимум точек в ячейке для надёжной оценки плотности

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function prog(ctl, f, l) { if (ctl && typeof ctl.progress === 'function') ctl.progress(f, l); }
  function run(gen) { var r; do { r = gen.next(); } while (!r.done); return r.value; }

  function hash3(ix, iy, iz) {
    var h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) | 0;
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
    return h;
  }

  /** Хеш-таблица ячеек (открытая адресация): ключ → номер ячейки; для каждой ячейки хранятся координаты и счётчик. */
  function CellMap(ny, nz, cap0) {
    var cap = 1 << 12; while (cap < cap0 * 2) cap <<= 1;
    this.ny = ny; this.nz = nz; this.cap = cap; this.mask = cap - 1;
    this.keys = new Float64Array(cap).fill(-1); this.ids = new Int32Array(cap);
    this.n = 0; this.ccap = 1 << 14;
    this.cx = new Int32Array(this.ccap); this.cy = new Int32Array(this.ccap); this.cz = new Int32Array(this.ccap); this.cnt = new Float64Array(this.ccap);
  }
  CellMap.prototype._growCells = function () {
    var c = this.ccap * 2, a = new Int32Array(c), b = new Int32Array(c), d = new Int32Array(c), e = new Float64Array(c);
    a.set(this.cx); b.set(this.cy); d.set(this.cz); e.set(this.cnt);
    this.cx = a; this.cy = b; this.cz = d; this.cnt = e; this.ccap = c;
  };
  CellMap.prototype._rehash = function () {
    var cap = this.cap * 2, mask = cap - 1, keys = new Float64Array(cap).fill(-1), ids = new Int32Array(cap);
    for (var id = 0; id < this.n; id++) {
      var ix = this.cx[id], iy = this.cy[id], iz = this.cz[id], key = (ix * this.ny + iy) * this.nz + iz, s = hash3(ix, iy, iz) & mask;
      while (keys[s] !== -1) s = (s + 1) & mask;
      keys[s] = key; ids[s] = id;
    }
    this.cap = cap; this.mask = mask; this.keys = keys; this.ids = ids;
  };
  /** Добавляет w к счётчику ячейки (создаёт её при необходимости); возвращает номер ячейки. */
  CellMap.prototype.add = function (ix, iy, iz, w) {
    var key = (ix * this.ny + iy) * this.nz + iz, s = hash3(ix, iy, iz) & this.mask, keys = this.keys;
    for (;;) {
      var k = keys[s];
      if (k === key) { var id = this.ids[s]; this.cnt[id] += w; return id; }
      if (k === -1) {
        var nid = this.n++; if (nid >= this.ccap) this._growCells();
        this.cx[nid] = ix; this.cy[nid] = iy; this.cz[nid] = iz; this.cnt[nid] = w; keys[s] = key; this.ids[s] = nid;
        if (this.n * 2 > this.cap) this._rehash();
        return nid;
      }
      s = (s + 1) & this.mask;
    }
  };
  CellMap.prototype.find = function (ix, iy, iz) {
    if (ix < 0 || iy < 0 || iz < 0) return -1;
    var key = (ix * this.ny + iy) * this.nz + iz, s = hash3(ix, iy, iz) & this.mask, keys = this.keys;
    for (;;) {
      var k = keys[s];
      if (k === key) return this.ids[s];
      if (k === -1) return -1;
      s = (s + 1) & this.mask;
    }
  };

  /** Устойчивая рамка по случайной подвыборке: единичные «улетевшие» точки не раздувают сетку. */
  function robustBox(pos, n) {
    var m = Math.min(n, 20000), st = n / m, X = new Float32Array(m), Y = new Float32Array(m), Z = new Float32Array(m), k = 0;
    for (var i = 0; i < m; i++) {
      var s = Math.min(n - 1, Math.floor(i * st)) * 3, x = pos[s], y = pos[s + 1], z = pos[s + 2];
      if ((x - x) + (y - y) + (z - z) !== 0) continue;
      X[k] = x; Y[k] = y; Z[k] = z; k++;
    }
    if (k < 8) return null;
    function pr(A, q) { var B = A.slice(0, k).sort(); return B[Math.min(k - 1, Math.max(0, Math.floor(q * (k - 1))))]; }
    var lo = [pr(X, 0.001), pr(Y, 0.001), pr(Z, 0.001)], hi = [pr(X, 0.999), pr(Y, 0.999), pr(Z, 0.999)], mn = [], mx = [];
    for (var a = 0; a < 3; a++) {
      var span = Math.max(hi[a] - lo[a], 1e-6), pad = span * 0.25;
      mn[a] = lo[a] - pad; mx[a] = hi[a] + pad;
    }
    return { mn: mn, mx: mx };
  }

  /**
   * Поле плотности (общая основа для размера точек и очистки). Пирамида счётчиков по ячейкам: уровень j — ячейки h0·2^j.
   * Для каждой ячейки нулевого уровня: шаг sClimb = h·√(KAPPA/c), где c — число точек в ячейке, выбранной из пирамиды так, чтобы в ней
   * было не меньше CMIN точек (плотная поверхность → мелкий шаг, разреженная → крупный); isoFlag — одиночный выброс.
   * opt.sub — сколько точек считать (по равномерной подвыборке; по умолчанию 6 млн), opt.keepCid — запомнить ячейку каждой точки.
   */
  function* fieldGen(pos, n, opt, ctl) {
    opt = opt || {}; n = n | 0;
    var est = CP.estimate(pos, n), s0 = est.spacing > 0 ? est.spacing : 0.02;
    var rb = robustBox(pos, n);
    if (!rb) return null;
    var diag = Math.hypot(rb.mx[0] - rb.mn[0], rb.mx[1] - rb.mn[1], rb.mx[2] - rb.mn[2]);
    var h0 = Math.max(opt.cell > 0 ? +opt.cell : 3 * s0, diag / 60000), inv = 1 / h0;
    var mn0 = rb.mn[0], mn1 = rb.mn[1], mn2 = rb.mn[2];
    var nx = Math.floor((rb.mx[0] - mn0) * inv) + 1, ny = Math.floor((rb.mx[1] - mn1) * inv) + 1, nz = Math.floor((rb.mx[2] - mn2) * inv) + 1;
    var mx0 = nx - 1, mx1 = ny - 1, mx2 = nz - 1;
    var L0 = new CellMap(ny, nz, Math.min(n, 1 << 20) / 4);
    var i, j;
    // счёт ячеек — по равномерной подвыборке (не более SUB точек): крупные облака считаются в разы быстрее, а число точек в плотных
    // ячейках всё равно измеряется с запасом; вес точки wgt = n/m приводит счётчики к полному облаку
    var SUB = opt.sub > 0 ? +opt.sub : 6000000, m = Math.min(n, SUB), wgt = n / m, step = n / m;
    var cid = opt.keepCid && m === n ? new Int32Array(n).fill(-1) : null;
    for (var u = 0; u < m; u++) {
      i = u < m - 1 ? Math.floor(u * step) : n - 1; j = i * 3;
      var x = pos[j] - mn0, y = pos[j + 1] - mn1, z = pos[j + 2] - mn2;
      if ((x - x) + (y - y) + (z - z) !== 0) continue;
      var ix = (x * inv) | 0, iy = (y * inv) | 0, iz = (z * inv) | 0;
      if (x < 0) ix = 0; else if (ix > mx0) ix = mx0;
      if (y < 0) iy = 0; else if (iy > mx1) iy = mx1;
      if (z < 0) iz = 0; else if (iz > mx2) iz = mx2;
      var id0 = L0.add(ix, iy, iz, wgt);
      if (cid) cid[i] = id0;
      if ((u & (CHUNK - 1)) === CHUNK - 1) { prog(ctl, (opt.p1 || 0.45) * u / m, opt.label || 'Плотность точек…'); yield (opt.p1 || 0.45) * u / m; }
    }
    // пирамида: уровень j = ячейки со стороной h0·2^j (счётчики суммируются из предыдущего уровня)
    var levels = [L0], maxLev = 9, cur = L0, lv;
    for (lv = 1; lv <= maxLev && cur.n > 8; lv++) {
      var P = new CellMap(ny, nz, cur.n / 2);
      for (var c = 0; c < cur.n; c++) P.add(cur.cx[c] >> 1, cur.cy[c] >> 1, cur.cz[c] >> 1, cur.cnt[c]);
      levels.push(P); cur = P; yield 0.46;
    }
    var cells = L0.n, sClimb = new Float32Array(cells), isoFlag = new Uint8Array(cells), jStar = new Uint8Array(cells), LEN = levels.length;
    var sFloor = s0 / 64, sCeil = 16 * s0;
    for (var id = 0; id < cells; id++) {
      var ax = L0.cx[id], ay = L0.cy[id], az = L0.cz[id], cc = L0.cnt[id], hh = h0, l2 = 0, c0 = cc, c1 = cc;
      while (cc < CMIN && l2 + 1 < LEN) {
        l2++; hh *= 2;
        var pid = levels[l2].find(ax >> l2, ay >> l2, az >> l2);
        cc = pid >= 0 ? levels[l2].cnt[pid] : 1;
        if (l2 === 1) c1 = cc;
      }
      sClimb[id] = clamp(hh * Math.sqrt(KAPPA / Math.max(1, cc)), sFloor, sCeil);   // cc ≥ 1: даже одна точка занимает ячейку
      jStar[id] = l2;
      // одиночная точка/«комочек» вдали от поверхностей (в ячейке и в её родителе почти пусто) и в блоке 3×3×3 из крупных ячеек (16·h) тоже
      // почти пусто — это шум, а не разреженная поверхность
      if (l2 >= 1 && c0 <= 1.5 * wgt && c1 <= 3 * wgt && LEN > 4) {
        var Lb = levels[4], bx = ax >> 4, by = ay >> 4, bz = az >> 4, blk = 0;
        for (var dx = -1; dx <= 1 && blk <= 4 * wgt; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
          var bid = Lb.find(bx + dx, by + dy, bz + dz); if (bid >= 0) blk += Lb.cnt[bid];
        }
        if (blk <= 4 * wgt) isoFlag[id] = 1;
      }
      if ((id & 262143) === 262143) yield 0.46 + 0.04 * id / cells;
    }
    return { s0: s0, h0: h0, inv: inv, mn: [mn0, mn1, mn2], mx: [mx0, mx1, mx2], L0: L0, levels: levels, LEN: LEN, wgt: wgt, m: m, cid: cid, cells: cells,
      sClimb: sClimb, isoFlag: isoFlag, jStar: jStar, rb: rb };
  }

  /**
   * Код шага для каждой точки (лог-шкала 0..255 в диапазоне [sMin, sMax]): { codes, sMin, sMax, s0, h0, cells }.
   * Шаг одиночных выбросов ограничен 4·s0 — шум не раздувается в огромные квадраты.
   */
  function* spacingGen(pos, n, opt, ctl) {
    opt = opt || {}; n = n | 0;
    var F = yield* fieldGen(pos, n, opt, ctl);
    if (!F) { var s0 = (CP.estimate(pos, n).spacing) || 0.02; return { codes: new Uint8Array(n), sMin: s0, sMax: s0 * 1.0001, s0: s0, h0: s0 * 3, cells: 0 }; }
    var L0 = F.L0, cells = F.cells, s0b = F.s0, sCell = new Float32Array(cells), lo = Infinity, hi = 0, id;
    for (id = 0; id < cells; id++) {
      var sv = F.isoFlag[id] ? Math.min(F.sClimb[id], 4 * s0b) : F.sClimb[id];
      sCell[id] = sv; if (sv < lo) lo = sv; if (sv > hi) hi = sv;
    }
    if (!(lo < Infinity)) { lo = s0b; hi = s0b; }
    var sMin = lo, sMax = Math.max(hi, lo * 1.0001), lnMin = Math.log(sMin), span = Math.log(sMax) - lnMin;
    var codeOfCell = new Uint8Array(cells);
    for (var q = 0; q < cells; q++) codeOfCell[q] = Math.round((Math.log(sCell[q]) - lnMin) / span * 255);
    F.levels.length = 1;
    // запись кода каждой точки
    var codes = new Uint8Array(n), inv = F.inv, mn0 = F.mn[0], mn1 = F.mn[1], mn2 = F.mn[2], mx0 = F.mx[0], mx1 = F.mx[1], mx2 = F.mx[2], i, j;
    for (i = 0, j = 0; i < n; i++, j += 3) {
      var x2 = pos[j] - mn0, y2 = pos[j + 1] - mn1, z2 = pos[j + 2] - mn2;
      if ((x2 - x2) + (y2 - y2) + (z2 - z2) !== 0) { codes[i] = 255; continue; }
      var jx = (x2 * inv) | 0, jy = (y2 * inv) | 0, jz = (z2 * inv) | 0;
      if (x2 < 0) jx = 0; else if (jx > mx0) jx = mx0;
      if (y2 < 0) jy = 0; else if (jy > mx1) jy = mx1;
      if (z2 < 0) jz = 0; else if (jz > mx2) jz = mx2;
      var cid = L0.find(jx, jy, jz);
      codes[i] = cid >= 0 ? codeOfCell[cid] : 128;
      if ((i & (CHUNK - 1)) === CHUNK - 1) { prog(ctl, 0.5 + 0.5 * i / n, 'Запись шага точек…'); yield 0.5 + 0.5 * i / n; }
    }
    prog(ctl, 1, 'Готово');
    return { codes: codes, sMin: sMin, sMax: sMax, s0: s0b, h0: F.h0, cells: cells };
  }
  function spacingField(pos, n, opt, ctl) { return run(spacingGen(pos, n, opt, ctl)); }

  // ---------------------------------------------------------------- умное подавление шума
  /**
   * Три независимых признака шума; каждый работает в масштабе того места, где стоит точка, а не по одному радиусу на всю сцену:
   *   1) «острова»: группы точек, не связанные с остальным облаком на масштабе link·шаг окружения, где мало точек и малая протяжённость — пыль, комочки;
   *      длинные цепочки (провода, трубы, арматура) и большие разреженные поверхности — связны и протяжённы, поэтому остаются;
   *   2) «одиночка в плотном окружении»: у точки почти нет соседей на её масштабе, хотя рядом плотная поверхность (отлипшие точки);
   *   3) «вне поверхности» (с уровня «средне»): расстояние до 3-го соседа больше ρ·шага окружения — полу-пиксели на краях, мультипуть.
   * tau — доля от ожидаемой плотности, ниже которой точка считается одиночкой (признак 2); iso — абсолютный максимум соседей;
   * nIsland/extIsland — предельные размер и протяжённость «острова»; rho — множитель признака 3 (0 — выключен).
   */
  // Пресеты подобраны на синтетической сцене со сканерной плотностью (dev/ui-lab/denoise-eval.js): каждый следующий уровень удаляет не меньше
  // предыдущего. soft — только заведомый мусор; medium (по умолчанию) — островки до 40 точек размахом до 1 м; strong — до 150 точек и 2 м.
  // rho (отсев «вне поверхности») на сцене давал +1 % шума ценой десятков полезных точек — в пресеты не входит (0 = выключен).
  var DENOISE_PRESETS = {
    soft:   { tau: 0.04, iso: 3, nIsland: 8,   extIsland: 0.5, rho: 0, link: 24, sparse: 0 },
    medium: { tau: 0.04, iso: 3, nIsland: 40,  extIsland: 1.0, rho: 0, link: 24, sparse: 0, sparseRel: 0.002 },
    strong: { tau: 0.08, iso: 4, nIsland: 150, extIsland: 2.0, rho: 0, link: 24, sparse: 0, sparseRel: 0.004 }
  };

  function* denoiseGen(pos, n, opt, ctl) {
    opt = opt || {}; n = n | 0;
    var P = Object.assign({}, DENOISE_PRESETS[opt.level] || DENOISE_PRESETS.medium, opt.params || {});
    var F = yield* fieldGen(pos, n, { sub: Infinity, keepCid: true, p1: 0.3, label: 'Плотность точек…' }, ctl);
    var i, id, c, q, dx, dy, dz;
    if (!F) return { remove: new Uint32Array(0), removed: 0, count: n, stats: { islands: 0, isolated: 0, offSurface: 0, invalid: 0 }, params: P };
    var L0 = F.L0, cells = F.cells, cid = F.cid, levels = F.levels, LEN = F.LEN, h0 = F.h0, s0 = F.s0, ncell = cells;
    var bad = new Uint8Array(cells), stat = { islands: 0, isolated: 0, sparse: 0, offSurface: 0, invalid: 0 }, core = opt.core || null;
    // --- 1. острова: связность считается в масштабе самого места — радиус связи = link·(шаг окружения), а не один радиус на всю сцену
    prog(ctl, 0.34, 'Поиск мелких островков…'); yield 0.34;
    var comps = [], lvOf = new Uint8Array(cells), used = new Uint8Array(LEN + 1);
    // опорный шаг места: у «надёжной» ячейки (плотной: ≥ CMIN точек в ячейке или её родителе) — свой; у разреженной/одиночной — наименьший шаг
    // надёжных ячеек вокруг (в блоке 3×3×3 крупных ячеек ≥ 0,6 м), а если надёжных рядом нет — не больше 4·s0. Так пыль, повисшая рядом с плотной
    // поверхностью, оценивается по масштабу этой поверхности, а не по «пустоте» вокруг самой пылинки.
    var Lc = 1; while (Lc + 1 < LEN && h0 * Math.pow(2, Lc) < Math.max(0.6, 16 * s0)) Lc++;
    var sRef = new Float32Array(cells);
    if (LEN > 1) {
      var LX = levels[Lc], ctxMin = new Float32Array(LX.n).fill(Infinity), nbrMin = new Float32Array(LX.n).fill(Infinity);
      for (id = 0; id < cells; id++) if (F.jStar[id] <= 1) {
        var ca = LX.find(L0.cx[id] >> Lc, L0.cy[id] >> Lc, L0.cz[id] >> Lc);
        if (ca >= 0 && F.sClimb[id] < ctxMin[ca]) ctxMin[ca] = F.sClimb[id];
      }
      for (c = 0; c < LX.n; c++) {
        var mnv = Infinity;
        for (dx = -1; dx <= 1; dx++) for (dy = -1; dy <= 1; dy++) for (dz = -1; dz <= 1; dz++) { q = LX.find(LX.cx[c] + dx, LX.cy[c] + dy, LX.cz[c] + dz); if (q >= 0 && ctxMin[q] < mnv) mnv = ctxMin[q]; }
        nbrMin[c] = mnv;
      }
      for (id = 0; id < cells; id++) {
        if (F.jStar[id] <= 1) { sRef[id] = F.sClimb[id]; continue; }
        var cb = LX.find(L0.cx[id] >> Lc, L0.cy[id] >> Lc, L0.cz[id] >> Lc), nv = cb >= 0 ? nbrMin[cb] : Infinity;
        sRef[id] = Math.min(F.sClimb[id], nv < Infinity ? nv : 4 * s0);
      }
    } else sRef.set(F.sClimb);
    for (id = 0; id < cells; id++) {
      var Hh = Math.max(h0, P.link * sRef[id] / 2), lv2 = Math.round(Math.log(Hh / h0) / Math.LN2);
      lv2 = lv2 < 0 ? 0 : (lv2 > LEN - 1 ? LEN - 1 : lv2); lvOf[id] = lv2; used[lv2] = 1;
    }
    for (var L = 0; L < LEN; L++) {
      if (!used[L]) continue;
      var LC = levels[L], nn = LC.n, par = new Int32Array(nn), Hc = h0 * Math.pow(2, L);
      for (c = 0; c < nn; c++) par[c] = c;
      var fnd = function (a) { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
      for (c = 0; c < nn; c++) {
        var qx = LC.cx[c], qy = LC.cy[c], qz = LC.cz[c];
        for (dx = -1; dx <= 1; dx++) for (dy = -1; dy <= 1; dy++) for (dz = -1; dz <= 1; dz++) {
          if (dx < 0 || (dx === 0 && (dy < 0 || (dy === 0 && dz < 0)))) continue;
          if (!(dx | dy | dz)) continue;
          q = LC.find(qx + dx, qy + dy, qz + dz); if (q < 0) continue;
          var ra = fnd(c), rb2 = fnd(q); if (ra !== rb2) par[ra] = rb2;
        }
        if ((c & 262143) === 262143) yield 0.35;
      }
      var pts = new Float64Array(nn), mnx = new Int32Array(nn).fill(2147483647), mny = new Int32Array(nn).fill(2147483647), mnz = new Int32Array(nn).fill(2147483647),
        mxx = new Int32Array(nn).fill(-1), mxy = new Int32Array(nn).fill(-1), mxz = new Int32Array(nn).fill(-1);
      for (c = 0; c < nn; c++) {
        var r = fnd(c); pts[r] += LC.cnt[c];
        if (LC.cx[c] < mnx[r]) mnx[r] = LC.cx[c]; if (LC.cx[c] > mxx[r]) mxx[r] = LC.cx[c];
        if (LC.cy[c] < mny[r]) mny[r] = LC.cy[c]; if (LC.cy[c] > mxy[r]) mxy[r] = LC.cy[c];
        if (LC.cz[c] < mnz[r]) mnz[r] = LC.cz[c]; if (LC.cz[c] > mxz[r]) mxz[r] = LC.cz[c];
      }
      var maxSpan = Math.max(2, Math.ceil(P.extIsland / Hc)), island = new Uint8Array(nn);
      for (c = 0; c < nn; c++) if (par[c] === c) {
        var span = Math.max(mxx[c] - mnx[c], mxy[c] - mny[c], mxz[c] - mnz[c]) + 1;
        if (pts[c] <= P.nIsland && span <= maxSpan) island[c] = 1;
      }
      for (c = 0; c < nn; c++) island[c] = island[fnd(c)];
      comps[L] = island;
      yield 0.36;
    }
    for (id = 0; id < cells; id++) {
      var L2 = lvOf[id], a = levels[L2].find(L0.cx[id] >> L2, L0.cy[id] >> L2, L0.cz[id] >> L2);
      if (a >= 0 && comps[L2][a]) { bad[id] = 1; stat.islands += L0.cnt[id]; }
      if ((id & 262143) === 262143) yield 0.37;
    }
    // --- 2. одиночка в плотном окружении
    prog(ctl, 0.4, 'Проверка одиночных точек…'); yield 0.4;
    var L3 = LEN > 3 ? levels[3] : null;
    var ctxE = function (id2) {   // ожидаемое число точек в блоке 3×3 ячеек поверхности по плотности окрестности (уровень 3: 8×8×8 ячеек)
      if (!L3) return 0;
      var a3 = L3.find(L0.cx[id2] >> 3, L0.cy[id2] >> 3, L0.cz[id2] >> 3);
      return 9 * (a3 >= 0 ? L3.cnt[a3] : 0) / 64;
    };
    var blockSum = function (id2, limit) {
      var ix2 = L0.cx[id2], iy2 = L0.cy[id2], iz2 = L0.cz[id2], b = 0;
      for (var ddx = -1; ddx <= 1 && b <= limit; ddx++) for (var ddy = -1; ddy <= 1; ddy++) for (var ddz = -1; ddz <= 1; ddz++) {
        var q2 = L0.find(ix2 + ddx, iy2 + ddy, iz2 + ddz); if (q2 >= 0) b += L0.cnt[q2];
      }
      return b;
    };
    if (L3) for (id = 0; id < cells; id++) {
      if (bad[id] || L0.cnt[id] > 3) continue;
      var E = ctxE(id); if (E * P.tau < 1) continue;
      var b0 = blockSum(id, P.iso);
      if (b0 <= P.iso && b0 <= P.tau * E) { bad[id] = 1; stat.isolated += L0.cnt[id]; }
      if ((id & 262143) === 262143) yield 0.45;
    }
    // --- 2б. разреженные «облачка» в пустоте (отражения от стёкол, парящая пыль): в крупной ячейке (≥ 0,6 м) точек не больше доли sparseRel от
    // плотных мест сцены (90-й процентиль по ячейкам). Настоящая далёкая стена или крона даёт в ячейке сотни точек и остаётся.
    if ((P.sparse > 0 || P.sparseRel > 0) && LEN > 1) {
      var LXs = levels[Lc], sparseC = new Uint8Array(LXs.n);
      var smp = new Float64Array(Math.min(LXs.n, 50000)), sst = LXs.n / smp.length;
      for (c = 0; c < smp.length; c++) smp[c] = LXs.cnt[Math.floor(c * sst)];
      smp.sort(); var refD = smp[Math.min(smp.length - 1, Math.floor(0.9 * smp.length))], thrS = Math.max(P.sparse || 0, (P.sparseRel || 0) * refD);
      for (c = 0; c < LXs.n; c++) if (LXs.cnt[c] <= thrS) {
        // «облачко» — это ещё и пустота вокруг: во всех 27 соседних ячейках вместе не больше 6·порога (далёкая редкая поверхность тянется цепочкой ячеек и остаётся)
        var bs = 0, qx = LXs.cx[c], qy = LXs.cy[c], qz = LXs.cz[c], dx, dy, dz, fq;
        for (dx = -1; dx <= 1 && bs <= 6 * thrS; dx++) for (dy = -1; dy <= 1; dy++) for (dz = -1; dz <= 1; dz++) { fq = LXs.find(qx + dx, qy + dy, qz + dz); if (fq >= 0) bs += LXs.cnt[fq]; }
        if (bs <= 6 * thrS) sparseC[c] = 1;
      }
      stat.sparseThr = thrS; stat.sparseRef = refD;
      for (id = 0; id < cells; id++) {
        if (bad[id]) continue;
        var cs2 = LXs.find(L0.cx[id] >> Lc, L0.cy[id] >> Lc, L0.cz[id] >> Lc);
        if (cs2 >= 0 && sparseC[cs2]) { bad[id] = 1; stat.sparse += L0.cnt[id]; }
      }
    }
    // --- 3. вне поверхности
    var ptBad = null;
    if (P.rho > 0 && cid) {
      prog(ctl, 0.5, 'Точки вне поверхности…'); yield 0.5;
      ptBad = new Uint8Array(n);
      var start = new Int32Array(cells + 1), order = new Int32Array(n), fill = new Int32Array(cells);
      for (i = 0; i < n; i++) if (cid[i] >= 0) start[cid[i] + 1]++;
      for (id = 0; id < cells; id++) start[id + 1] += start[id];
      for (i = 0; i < n; i++) { var ci = cid[i]; if (ci >= 0) order[start[ci] + fill[ci]++] = i; }
      fill = null;
      var nb = new Int32Array(27);
      for (id = 0; id < cells; id++) {
        if (bad[id] || L0.cnt[id] > 6) continue;
        var nc = 0, ex = L0.cx[id], ey = L0.cy[id], ez = L0.cz[id];
        for (dx = -1; dx <= 1; dx++) for (dy = -1; dy <= 1; dy++) for (dz = -1; dz <= 1; dz++) { q = L0.find(ex + dx, ey + dy, ez + dz); if (q >= 0) nb[nc++] = q; }
        var thr2 = P.rho * F.sClimb[id]; thr2 *= thr2;
        var dense = ctxE(id) * P.tau >= 1;
        for (var w0 = start[id]; w0 < start[id + 1]; w0++) {
          var p0 = order[w0], X = pos[p0 * 3], Y = pos[p0 * 3 + 1], Z = pos[p0 * 3 + 2], d1 = Infinity, d2 = Infinity, d3 = Infinity, ok = false;
          for (var u = 0; u < nc && !ok; u++) {
            var cq = nb[u];
            for (var w = start[cq], we = start[cq + 1]; w < we; w++) {
              var pj = order[w]; if (pj === p0) continue;
              var ax = pos[pj * 3] - X, ay = pos[pj * 3 + 1] - Y, az = pos[pj * 3 + 2] - Z, dd = ax * ax + ay * ay + az * az;
              if (dd < d3) { if (dd < d1) { d3 = d2; d2 = d1; d1 = dd; } else if (dd < d2) { d3 = d2; d2 = dd; } else d3 = dd; if (d3 <= thr2) { ok = true; break; } }
            }
          }
          if (ok) continue;
          if (d3 === Infinity ? dense : d3 > thr2) { ptBad[p0] = 1; stat.offSurface++; }
        }
        if ((id & 65535) === 65535) { prog(ctl, 0.5 + 0.45 * id / cells, 'Точки вне поверхности…'); yield 0.5 + 0.45 * id / cells; }
      }
    }
    // --- результат
    var lo = core ? core.lo : -Infinity, hi = core ? core.hi : Infinity, ax2 = core ? core.axis : 0, cnt = 0, rem = new Uint32Array(Math.min(n, 1 << 16)), capR = rem.length;
    for (i = 0; i < n; i++) {
      var ci2 = cid[i], gone;
      if (ci2 < 0) { gone = 1; stat.invalid++; } else gone = bad[ci2] || (ptBad && ptBad[i]);
      if (!gone) continue;
      if (core) { var cv = pos[i * 3 + ax2]; if (!(cv >= lo && cv < hi)) continue; }
      if (cnt >= capR) { capR *= 2; var nr = new Uint32Array(capR); nr.set(rem); rem = nr; }
      rem[cnt++] = i;
    }
    prog(ctl, 1, 'Готово');
    return { remove: rem.slice(0, cnt), removed: cnt, count: n, stats: stat, params: P, s0: s0, cell: h0 };
  }
  function denoise(pos, n, opt, ctl) { return run(denoiseGen(pos, n, opt, ctl)); }

  // ---------------------------------------------------------------- удаление людей
  // Эвристика по форме (без нейросети): земля → точки на высоте 10 см…3 м → вокселы → связные компоненты → признаки «человека».
  // Человек: рост 1,3…2,2 м (с опцией «сидящие» от 0,9), опирается на землю, компактен по ширине, сверху уже, чем в области торса
  // (голова), нет разрывов по высоте. Столбы, колонны, тумбы, ящики, знаки на стойках, деревья, машины и стены по этим признакам не проходят.
  // Человек, вплотную стоящий к стене или машине, сливается с ней в один компонент и не удаляется (такого лучше выделить вручную).
  var PEOPLE_LEVELS = {
    strict: { headRatio: 0.65, maxW: 1.0, minPts: 120, lowRatio: 1.4, cylHead: 0.6,  cylLow: 0.9 },
    normal: { headRatio: 0.8,  maxW: 1.2, minPts: 60,  lowRatio: 1.8, cylHead: 0.68, cylLow: 0.97 },
    loose:  { headRatio: 0.92, maxW: 1.6, minPts: 40,  lowRatio: 2.5, cylHead: 9,    cylLow: 9 }
  };
  var PEOPLE_DEFAULTS = { minH: 1.3, maxH: 2.2, sitting: false, level: 'normal' };

  /** Земля: по клеткам 0,5 м берётся низ плотной массы точек (4-я снизу), затем «открытие» окном ±1,5 м убирает машины, людей, кусты. */
  function* groundGen(pos, n, box, ctl) {
    var i, c;
    // земля: по клеткам 0,5 м берём низ плотной массы точек (4-ю снизу), затем «открытие» окном ±1,5 м убирает машины, людей, кусты
    var gcell = 0.5, minX = box.mn[0], minZ = box.mn[2], spanX = box.mx[0] - minX, spanZ = box.mx[2] - minZ;
    while ((spanX / gcell + 2) * (spanZ / gcell + 2) > 2e6) gcell *= 1.5;
    var GX = Math.ceil(spanX / gcell) + 1, GZ = Math.ceil(spanZ / gcell) + 1, GC = GX * GZ;
    prog(ctl, 0.02, 'Поиск земли…'); yield 0.02;
    var low = new Float32Array(GC * 4).fill(Infinity), gcnt = new Uint32Array(GC);
    for (i = 0; i < n; i++) {
      var x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if ((x - x) + (y - y) + (z - z) !== 0) continue;
      var gx = Math.floor((x - minX) / gcell), gz = Math.floor((z - minZ) / gcell);
      if (gx < 0 || gz < 0 || gx >= GX || gz >= GZ || y < box.mn[1] || y > box.mx[1]) continue;
      var gi = gz * GX + gx, b = gi * 4; gcnt[gi]++;
      if (y < low[b + 3]) {
        if (y < low[b]) { low[b + 3] = low[b + 2]; low[b + 2] = low[b + 1]; low[b + 1] = low[b]; low[b] = y; }
        else if (y < low[b + 1]) { low[b + 3] = low[b + 2]; low[b + 2] = low[b + 1]; low[b + 1] = y; }
        else if (y < low[b + 2]) { low[b + 3] = low[b + 2]; low[b + 2] = y; }
        else low[b + 3] = y;
      }
      if ((i & 1048575) === 1048575) { prog(ctl, 0.02 + 0.08 * i / n, 'Поиск земли…'); yield 0.02 + 0.08 * i / n; }
    }
    var gr = new Float32Array(GC).fill(Infinity), tmp = new Float32Array(GC);
    for (c = 0; c < GC; c++) { var cn = gcnt[c]; if (cn) gr[c] = low[c * 4 + (cn >= 12 ? 3 : (cn >= 6 ? 2 : (cn >= 3 ? 1 : 0)))]; }
    low = null;
    var RW = Math.max(1, Math.ceil(1.5 / gcell));
    function filt(src, dst, isMin) {   // разделимый фильтр min/max по окну ±RW; пустые клетки (Infinity) пропускаются
      var t = new Float32Array(GC), a, bb, d;
      for (var zz = 0; zz < GZ; zz++) for (var xx = 0; xx < GX; xx++) {
        var best = isMin ? Infinity : -Infinity, has = false;
        for (d = -RW; d <= RW; d++) { var x2 = xx + d; if (x2 < 0 || x2 >= GX) continue; var val = src[zz * GX + x2]; if (val === Infinity || val === -Infinity) continue; has = true; if (isMin ? val < best : val > best) best = val; }
        t[zz * GX + xx] = has ? best : (isMin ? Infinity : -Infinity);
      }
      for (var xx2 = 0; xx2 < GX; xx2++) for (var zz2 = 0; zz2 < GZ; zz2++) {
        var best2 = isMin ? Infinity : -Infinity, has2 = false;
        for (d = -RW; d <= RW; d++) { var z2 = zz2 + d; if (z2 < 0 || z2 >= GZ) continue; var val2 = t[z2 * GX + xx2]; if (val2 === Infinity || val2 === -Infinity) continue; has2 = true; if (isMin ? val2 < best2 : val2 > best2) best2 = val2; }
        dst[zz2 * GX + xx2] = has2 ? best2 : (isMin ? Infinity : -Infinity);
      }
    }
    prog(ctl, 0.11, 'Поиск земли…'); yield 0.11;
    filt(gr, tmp, true); filt(tmp, gr, false);   // «открытие»: сначала min, потом max → нижняя огибающая, повторяющая уклон
    tmp = null;
    for (c = 0; c < GC; c++) if (gr[c] === -Infinity) gr[c] = Infinity;
    return { gr: gr, gcell: gcell, minX: minX, minZ: minZ, GX: GX, GZ: GZ, GC: GC };
  }

  function* peopleAGen(pos, n, opt, ctl) {
    opt = opt || {}; n = n | 0;
    var P = Object.assign({}, PEOPLE_DEFAULTS, PEOPLE_LEVELS[opt.level] || PEOPLE_LEVELS.normal, opt.params || {});
    if (opt.minH != null) P.minH = opt.minH; if (opt.maxH != null) P.maxH = opt.maxH; if (opt.sitting != null) P.sitting = !!opt.sitting; if (opt.maxW != null) P.maxW = opt.maxW;
    var minH = P.sitting ? Math.min(P.minH, 0.9) : P.minH, maxH = Math.max(P.maxH, minH + 0.2);
    var empty = { remove: new Uint32Array(0), removed: 0, count: n, found: [], stats: { components: 0, candidates: 0, rejected: {} }, params: P };
    var box = robustBox(pos, n); if (!box || n < 200) return empty;
    var est = CP && CP.estimate ? CP.estimate(pos, n) : { spacing: 0.03 }, sp = est.spacing > 0 ? est.spacing : 0.03;
    var v = clamp(5 * sp, 0.07, 0.15), HLOW = 0.1, HTOP = Math.max(3.0, maxH + 0.8), i, k, c;
    // --- 1. земля (общая для обоих способов поиска)
    var G = yield* groundGen(pos, n, box, ctl), gcell = G.gcell, minX = G.minX, minZ = G.minZ, spanX = box.mx[0] - minX, spanZ = box.mx[2] - minZ,
      GX = G.GX, GZ = G.GZ, GC = G.GC, gr = G.gr;
    // --- 2. вокселы точек между землёй+10 см и 3 м
    prog(ctl, 0.14, 'Вокселизация…'); yield 0.14;
    var NX = Math.ceil(spanX / v) + 2, NZ = Math.ceil(spanZ / v) + 2, NY = Math.ceil((box.mx[1] - box.mn[1]) / v) + 2;
    var map = new CellMap(NY, NZ, Math.min(2000000, Math.max(50000, n >> 3))), vcap = 1 << 16, hmin = new Float32Array(vcap).fill(Infinity), hmax = new Float32Array(vcap).fill(-Infinity), nb = 0;
    for (i = 0; i < n; i++) {
      var X = pos[i * 3], Y = pos[i * 3 + 1], Z = pos[i * 3 + 2];
      if ((X - X) + (Y - Y) + (Z - Z) !== 0) continue;
      var cx = Math.floor((X - minX) / gcell), cz = Math.floor((Z - minZ) / gcell);
      if (cx < 0 || cz < 0 || cx >= GX || cz >= GZ) continue;
      var g0 = gr[cz * GX + cx], h = Y - g0;
      if (!(h >= HLOW && h < HTOP) || Y < box.mn[1] || Y > box.mx[1]) continue;
      var ix = Math.floor((X - minX) / v), iz = Math.floor((Z - minZ) / v), iy = Math.floor((Y - box.mn[1]) / v);
      if (ix < 0 || iz < 0 || iy < 0 || ix >= NX || iz >= NZ || iy >= NY) continue;
      var id = map.add(ix, iy, iz, 1);
      if (id >= vcap) { var nc = vcap * 2, a1 = new Float32Array(nc).fill(Infinity), a2 = new Float32Array(nc).fill(-Infinity); a1.set(hmin); a2.set(hmax); hmin = a1; hmax = a2; vcap = nc; }
      if (h < hmin[id]) hmin[id] = h; if (h > hmax[id]) hmax[id] = h;
      if ((i & 1048575) === 1048575) { prog(ctl, 0.14 + 0.3 * i / n, 'Вокселизация…'); yield 0.14 + 0.3 * i / n; }
    }
    nb = map.n; var NV = nb;
    if (NV < 20) return empty;
    // --- 3. связные компоненты вокселов (26 соседей)
    prog(ctl, 0.46, 'Связные группы…'); yield 0.46;
    var par = new Int32Array(NV); for (c = 0; c < NV; c++) par[c] = c;
    function fnd(a) { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; }
    var cxv = map.cx, cyv = map.cy, czv = map.cz, cntv = map.cnt, dx, dy, dz, q;
    for (c = 0; c < NV; c++) {
      var ax = cxv[c], ay = cyv[c], az = czv[c];
      for (dx = -1; dx <= 1; dx++) for (dy = -1; dy <= 1; dy++) for (dz = -1; dz <= 1; dz++) {
        if (dx < 0 || (dx === 0 && (dy < 0 || (dy === 0 && dz < 0)))) continue;
        if (!(dx | dy | dz)) continue;
        q = map.find(ax + dx, ay + dy, az + dz); if (q < 0) continue;
        var r1 = fnd(c), r2 = fnd(q); if (r1 !== r2) par[r1] = r2;
      }
      if ((c & 131071) === 131071) { prog(ctl, 0.46 + 0.2 * c / NV, 'Связные группы…'); yield 0.46 + 0.2 * c / NV; }
    }
    var cPts = new Float64Array(NV), cMinH = new Float32Array(NV).fill(Infinity), cMaxH = new Float32Array(NV).fill(-Infinity),
      cMinX = new Int32Array(NV).fill(2147483647), cMaxX = new Int32Array(NV).fill(-1), cMinZ = new Int32Array(NV).fill(2147483647), cMaxZ = new Int32Array(NV).fill(-1), cVox = new Int32Array(NV);
    for (c = 0; c < NV; c++) {
      var rt = fnd(c); cPts[rt] += cntv[c]; cVox[rt]++;
      if (hmin[c] < cMinH[rt]) cMinH[rt] = hmin[c]; if (hmax[c] > cMaxH[rt]) cMaxH[rt] = hmax[c];
      if (cxv[c] < cMinX[rt]) cMinX[rt] = cxv[c]; if (cxv[c] > cMaxX[rt]) cMaxX[rt] = cxv[c];
      if (czv[c] < cMinZ[rt]) cMinZ[rt] = czv[c]; if (czv[c] > cMaxZ[rt]) cMaxZ[rt] = czv[c];
    }
    // --- 4. признаки «человека»
    prog(ctl, 0.7, 'Оценка формы…'); yield 0.7;
    var stat = { components: 0, candidates: 0, rejected: { size: 0, support: 0, gaps: 0, shape: 0, few: 0 } }, cand = {}, candList = [];
    for (c = 0; c < NV; c++) {
      if (par[c] !== c) continue;
      stat.components++;
      var H = cMaxH[c], Hlow = cMinH[c], w = Math.max(cMaxX[c] - cMinX[c], cMaxZ[c] - cMinZ[c]) * v + v;
      var dbg = opt.debug && cPts[c] >= 20 && w < 3 ? { cx: (cMinX[c] + cMaxX[c]) / 2 * v + minX, cz: (cMinZ[c] + cMaxZ[c]) / 2 * v + minZ, H: H, Hlow: Hlow, w: w, pts: cPts[c] } : null;
      if (dbg) (stat.debug = stat.debug || []).push(dbg);
      if (H < minH || H > maxH || w > P.maxW || w < 0.12) { stat.rejected.size++; if (dbg) dbg.why = 'size'; continue; }
      if (Hlow > 0.45) { stat.rejected.support++; if (dbg) dbg.why = 'support'; continue; }
      if (cPts[c] < P.minPts) { stat.rejected.few++; if (dbg) dbg.why = 'few'; continue; }
      cand[c] = { H: H, w: w, pts: cPts[c], sl: [], vox: 0, dbg: dbg }; candList.push(c);
    }
    var SL = 0.1, NS = Math.ceil(HTOP / SL) + 1, S2 = Math.SQRT1_2;
    for (c = 0; c < NV; c++) {
      var cd = cand[fnd(c)]; if (!cd) continue;
      var sIdx = Math.min(NS - 1, Math.max(0, Math.floor((hmin[c] + hmax[c]) / 2 / SL))), st = cd.sl[sIdx];
      var xx3 = cxv[c], zz3 = czv[c], u = xx3 + zz3, w2 = xx3 - zz3;
      if (!st) cd.sl[sIdx] = st = { n: 0, x0: xx3, x1: xx3, z0: zz3, z1: zz3, u0: u, u1: u, w0: w2, w1: w2 };
      st.n++; if (xx3 < st.x0) st.x0 = xx3; if (xx3 > st.x1) st.x1 = xx3; if (zz3 < st.z0) st.z0 = zz3; if (zz3 > st.z1) st.z1 = zz3;
      if (u < st.u0) st.u0 = u; if (u > st.u1) st.u1 = u; if (w2 < st.w0) st.w0 = w2; if (w2 > st.w1) st.w1 = w2;
    }
    var okRoot = new Uint8Array(NV), found = [];
    function widthOf(st) { return (Math.max(st.x1 - st.x0, st.z1 - st.z0, (st.u1 - st.u0) * S2, (st.w1 - st.w0) * S2) + 1) * v; }
    for (var ci = 0; ci < candList.length; ci++) {
      var root = candList[ci], cd2 = cand[root], H2 = cd2.H, sl = cd2.sl, first = -1, last = -1, gapRun = 0, gapMax = 0, s;
      for (s = 0; s < sl.length; s++) { if (sl[s]) { if (first < 0) first = s; last = s; gapRun = 0; } else if (first >= 0) { gapRun++; if (gapRun > gapMax) gapMax = gapRun; } }
      if (gapMax > 3) { stat.rejected.gaps++; if (cd2.dbg) cd2.dbg.why = 'gaps'; continue; }
      var bodyW = 0, headW = 0, lowW = 0, hs;
      for (s = 0; s < sl.length; s++) {
        if (!sl[s]) continue; hs = (s + 0.5) * SL; var ww = widthOf(sl[s]);
        if (hs >= 0.45 * H2 && hs <= 0.88 * H2) { if (ww > bodyW) bodyW = ww; }
        if (hs >= H2 - 0.15) { if (ww > headW) headW = ww; }
        if (hs <= 0.45 * H2) { if (ww > lowW) lowW = ww; }
      }
      if (cd2.dbg) { cd2.dbg.body = bodyW; cd2.dbg.head = headW; cd2.dbg.low = lowW; }
      if (bodyW <= 0 || headW <= 0) { stat.rejected.shape++; if (cd2.dbg) cd2.dbg.why = 'shape0'; continue; }
      if (headW > P.headRatio * bodyW || lowW > P.lowRatio * bodyW || bodyW < 0.16 || (headW >= P.cylHead * bodyW && lowW >= P.cylLow * bodyW)) {   // последнее — «цилиндр»: сечение почти не меняется по высоте (колонна, столб, бочка)
        stat.rejected.shape++; if (cd2.dbg) cd2.dbg.why = 'shape'; continue; }
      okRoot[root] = 1; stat.candidates++;
      found.push({ cx: (cMinX[root] + cMaxX[root]) / 2 * v + minX, cz: (cMinZ[root] + cMaxZ[root]) / 2 * v + minZ, h: H2, w: cd2.w, points: cd2.pts });
    }
    if (!found.length) { prog(ctl, 1, 'Готово'); return { remove: new Uint32Array(0), removed: 0, count: n, found: [], stats: stat, params: P }; }
    // --- 5. точки найденных компонентов + «пеньки» стоп (3…10 см над землёй) 
    prog(ctl, 0.78, 'Отбор точек…'); yield 0.78;
    var acc = new Uint8Array(NV);   // 1 — воксел найденного человека
    for (c = 0; c < NV; c++) if (okRoot[fnd(c)]) acc[c] = 1;
    var cnt = 0, rem = new Uint32Array(1 << 16), capR = rem.length;
    for (i = 0; i < n; i++) {
      var X2 = pos[i * 3], Y2 = pos[i * 3 + 1], Z2 = pos[i * 3 + 2];
      if ((X2 - X2) + (Y2 - Y2) + (Z2 - Z2) !== 0) continue;
      var cx2 = Math.floor((X2 - minX) / gcell), cz2 = Math.floor((Z2 - minZ) / gcell);
      if (cx2 < 0 || cz2 < 0 || cx2 >= GX || cz2 >= GZ) continue;
      var hh = Y2 - gr[cz2 * GX + cx2];
      if (!(hh >= 0.03 && hh < HTOP) || Y2 < box.mn[1] || Y2 > box.mx[1]) continue;
      var jx = Math.floor((X2 - minX) / v), jz = Math.floor((Z2 - minZ) / v), jy = Math.floor((Y2 - box.mn[1]) / v), gone = false;
      if (hh >= HLOW) { var vid = map.find(jx, jy, jz); gone = vid >= 0 && acc[vid] > 0; }
      else {   // пенёк стопы: рядом (±1 воксел по XZ, до 2 вверх) есть воксел найденного человека
        for (dx = -1; dx <= 1 && !gone; dx++) for (dz = -1; dz <= 1 && !gone; dz++) for (dy = 0; dy <= 2; dy++) { q = map.find(jx + dx, jy + dy, jz + dz); if (q >= 0 && acc[q] === 1) { gone = true; break; } }
      }
      if (!gone) continue;
      if (cnt >= capR) { capR *= 2; var nr = new Uint32Array(capR); nr.set(rem); rem = nr; }
      rem[cnt++] = i;
      if ((i & 1048575) === 1048575) { prog(ctl, 0.78 + 0.2 * i / n, 'Отбор точек…'); yield 0.78 + 0.2 * i / n; }
    }
    prog(ctl, 1, 'Готово');
    return { remove: rem.slice(0, cnt), removed: cnt, count: n, found: found, stats: stat, params: P };
  }
  // ---- второй способ поиска людей: «столбцы» (вид сверху). Не зависит от того, слит ли человек с соседними предметами в одну связную группу:
  // над каждой клеткой 10 см строится вертикальная цепочка занятых слоёв; человек — «башня» (макушка выше большинства клеток вокруг),
  // с головой и плечами умеренного размера, туловищем в пределах ширины и без цилиндрической формы (столбы, колонны).
  var PEOPLE_COLS = {
    strict: { ringMax: 0.30, headCells: 22, torsoCells: 36, startMax: 5, minPts: 120, lowRatio: 1.5, headRatio: 0.70, cylHead: 0.62, cylLow: 0.92 },
    normal: { ringMax: 0.45, headCells: 36, torsoCells: 60, startMax: 8, minPts: 60,  lowRatio: 1.9, headRatio: 0.85, cylHead: 0.70, cylLow: 0.97 },
    loose:  { ringMax: 0.60, headCells: 50, torsoCells: 90, startMax: 11, minPts: 40, lowRatio: 2.6, headRatio: 0.95, cylHead: 9,    cylLow: 9 }
  };
  function* peopleColsGen(pos, n, opt, P, box, ctl) {
    var level = PEOPLE_COLS[opt.level] ? opt.level : 'normal', Q = PEOPLE_COLS[level];
    var minH = P.sitting ? Math.min(P.minH, 0.9) : P.minH, maxH = Math.max(P.maxH, minH + 0.2);
    var est = CP && CP.estimate ? CP.estimate(pos, n) : { spacing: 0.03 }, sp = est.spacing > 0 ? est.spacing : 0.03;
    var G = yield* groundGen(pos, n, box, ctl), gr = G.gr, gcell = G.gcell, minX = G.minX, minZ = G.minZ, GX = G.GX, GZ = G.GZ;
    var cs = clamp(2.5 * sp, 0.08, 0.2), spanX = box.mx[0] - minX, spanZ = box.mx[2] - minZ;
    while ((spanX / cs + 3) * (spanZ / cs + 3) > 14e6) cs *= 1.25;
    var NXc = Math.ceil(spanX / cs) + 2, NZc = Math.ceil(spanZ / cs) + 2, NC = NXc * NZc, SLH = 0.1, i, c;
    var useStrong = sp < 0.03;
    var m1 = new Uint32Array(NC), m2 = new Uint32Array(NC);
    prog(ctl, 0.1, 'Столбцы: заполнение…'); yield 0.1;
    for (i = 0; i < n; i++) {
      var X = pos[i * 3], Y = pos[i * 3 + 1], Z = pos[i * 3 + 2];
      if ((X - X) + (Y - Y) + (Z - Z) !== 0) continue;
      var gx = Math.floor((X - minX) / gcell), gz = Math.floor((Z - minZ) / gcell);
      if (gx < 0 || gz < 0 || gx >= GX || gz >= GZ) continue;
      var h = Y - gr[gz * GX + gx];
      if (!(h >= 0.03 && h < 3.15) || Y < box.mn[1] || Y > box.mx[1]) continue;
      var ix = Math.floor((X - minX) / cs), iz = Math.floor((Z - minZ) / cs); if (ix < 0 || iz < 0 || ix >= NXc || iz >= NZc) continue;
      var col = iz * NXc + ix, bit = 1 << Math.min(31, Math.floor(h / SLH));
      if (m1[col] & bit) m2[col] |= bit; else m1[col] |= bit;
      if ((i & 1048575) === 1048575) { prog(ctl, 0.1 + 0.25 * i / n, 'Столбцы: заполнение…'); yield 0.1 + 0.25 * i / n; }
    }
    var mask = useStrong ? m2 : m1; m1 = useStrong ? null : m1; if (useStrong) m1 = null;
    // цепочка слоёв от самого низкого занятого (не выше startMax) с допуском разрыва 3 слоя
    prog(ctl, 0.38, 'Столбцы: высоты…'); yield 0.38;
    var top = new Float32Array(NC), bot = new Float32Array(NC).fill(9);
    for (c = 0; c < NC; c++) {
      var mk = mask[c]; if (!mk) continue;
      var s0 = 31 - Math.clz32(mk & -mk); if (s0 > Q.startMax) continue;
      var last = s0, gap = 0;
      for (var s = s0 + 1; s < 32; s++) { if (mk & (1 << s)) { last = s; gap = 0; } else if (++gap > 3) break; }
      top[c] = (last + 1) * SLH; bot[c] = s0 * SLH;
    }
    // «второй по высоте среди 3×3»: одиночные выбросы-шипы не создают пиков
    var topS = new Float32Array(NC), nb = new Float32Array(9);
    for (var zz = 1; zz < NZc - 1; zz++) for (var xx = 1; xx < NXc - 1; xx++) {
      var cc = zz * NXc + xx; if (!top[cc]) continue;
      var m = 0, m2v = 0;
      for (var dz = -1; dz <= 1; dz++) for (var dx = -1; dx <= 1; dx++) { var t = top[cc + dz * NXc + dx]; if (t > m) { m2v = m; m = t; } else if (t > m2v) m2v = t; }
      topS[cc] = m2v;
    }
    top = null;
    // пики
    prog(ctl, 0.45, 'Столбцы: поиск людей…'); yield 0.45;
    var q, rPk = Math.max(2, Math.round(0.4 / cs)), rRing0 = 0.55, rRing1 = 1.0, rBody = 0.7, owner = new Int32Array(NC).fill(-1), ownD = new Float32Array(NC).fill(1e9);
    var found = [], pk = [], zoneLo = 0.45, zoneHi = 0.88;
    var rejected = { notTower: 0, overhead: 0, head: 0, torso: 0, shape: 0, thin: 0 }, cand = 0;
    function cellsIn(cx, cz, r, fn) {
      var rr = Math.ceil(r / cs), r2 = r * r / (cs * cs);
      for (var dz2 = -rr; dz2 <= rr; dz2++) for (var dx2 = -rr; dx2 <= rr; dx2++) { if (dx2 * dx2 + dz2 * dz2 > r2) continue; var ax = cx + dx2, az = cz + dz2; if (ax < 0 || az < 0 || ax >= NXc || az >= NZc) continue; fn(az * NXc + ax, dx2, dz2); }
    }
    for (zz = rPk; zz < NZc - rPk; zz++) {
      for (xx = rPk; xx < NXc - rPk; xx++) {
        cc = zz * NXc + xx; var tv = topS[cc];
        if (tv < minH || tv > maxH) continue;
        var isMax = true;
        for (dz = -rPk; dz <= rPk && isMax; dz++) for (dx = -rPk; dx <= rPk; dx++) {
          if (!dx && !dz) continue; if (dx * dx + dz * dz > rPk * rPk) continue;
          var o2 = topS[cc + dz * NXc + dx]; if (o2 > tv || (o2 === tv && (dz < 0 || (dz === 0 && dx < 0)))) { isMax = false; break; }
        }
        if (!isMax) continue;
        cand++;
        // изоляция: кольцо 0,55…1,0 м — доля клеток с макушкой не ниже (макушка − 0,3 м)
        var ringN = 0, ringTall = 0;
        cellsIn(xx, zz, rRing1, function (id, dx3, dz3) { var d = Math.sqrt(dx3 * dx3 + dz3 * dz3) * cs; if (d < rRing0) return; ringN++; if (topS[id] >= tv - 0.3) ringTall++; });
        if (ringN && ringTall / ringN > Q.ringMax) { rejected.notTower++; continue; }
        // над головой должно быть свободно: выше макушки + 0,3 м в соседних клетках нет ≥ 3 занятых слоёв (иначе это стена, крона, навес)
        var hiBits = 0, hs0 = Math.min(32, Math.floor((tv + 0.3) / SLH) + 1), un = 0;
        for (q = hs0; q < 32; q++) hiBits |= (1 << q);
        for (dz = -1; dz <= 1; dz++) for (dx = -1; dx <= 1; dx++) un |= mask[cc + dz * NXc + dx];
        un &= hiBits; var occ = 0; while (un) { un &= un - 1; occ++; }
        if (occ >= 3) { rejected.overhead++; continue; }
        // голова: клетки в радиусе 0,5 м с макушкой не ниже (макушка − 0,25)
        var headC = 0; cellsIn(xx, zz, 0.5, function (id) { if (topS[id] >= tv - 0.25) headC++; });
        if (headC > Q.headCells) { rejected.head++; continue; }
        // туловище и низ: клетки радиуса 0,7 м, где есть занятые слои в соответствующей зоне высот
        var bLo = Math.floor(zoneLo * tv / SLH), bHi = Math.floor(zoneHi * tv / SLH), lHi = Math.floor(zoneLo * tv / SLH) - 1, zoneB = 0, zoneL = 0, sumX = 0, sumZ = 0, bw = 0;
        var bmaskB = 0, bmaskL = 0, bmaskH = 0;
        for (q = bLo; q <= bHi && q < 32; q++) bmaskB |= (1 << q);
        for (q = 0; q <= lHi && q < 32; q++) bmaskL |= (1 << q);
        for (q = Math.max(0, Math.floor((tv - 0.15) / SLH)); q < 32 && q <= Math.floor(tv / SLH); q++) bmaskH |= (1 << q);
        var bx0 = 1e9, bx1 = -1e9, bz0 = 1e9, bz1 = -1e9, headA = 0;
        cellsIn(xx, zz, rBody, function (id, dx3, dz3) {
          var mk2 = mask[id]; if (!mk2) return;
          if (mk2 & bmaskB) { zoneB++; sumX += dx3; sumZ += dz3; bw++; if (dx3 < bx0) bx0 = dx3; if (dx3 > bx1) bx1 = dx3; if (dz3 < bz0) bz0 = dz3; if (dz3 > bz1) bz1 = dz3; }
          if (mk2 & bmaskL) zoneL++;
          if (mk2 & bmaskH) headA++;
        });
        if (zoneB < 4) { rejected.thin++; continue; }
        if (zoneB > Q.torsoCells) { rejected.torso++; continue; }
        var bodyW = Math.sqrt(zoneB), headW = Math.sqrt(Math.max(1, headA)), lowW = Math.sqrt(Math.max(1, zoneL));
        if (headW > Q.headRatio * bodyW || lowW > Q.lowRatio * bodyW || (headW >= Q.cylHead * bodyW && lowW >= Q.cylLow * bodyW)) { rejected.shape++; continue; }
        if ((bx1 - bx0 + 1) * cs > 1.3 || (bz1 - bz0 + 1) * cs > 1.3) { rejected.torso++; continue; }
        var ccx = xx + sumX / bw, ccz = zz + sumZ / bw;
        pk.push({ cx: ccx, cz: ccz, top: tv, id: pk.length, zoneB: zoneB });
      }
      if ((zz & 255) === 255) { prog(ctl, 0.45 + 0.25 * zz / NZc, 'Столбцы: поиск людей…'); yield 0.45 + 0.25 * zz / NZc; }
    }
    // принадлежность клеток: ближайший пик в радиусе 0,5 м от центра туловища; клетки выше макушки + 0,3 м (стены, деревья) не берём; клетка должна иметь высоту ≥ 0,5 м
    for (var pi = 0; pi < pk.length; pi++) {
      var pp = pk[pi];
      cellsIn(Math.round(pp.cx), Math.round(pp.cz), 0.5, function (id, dx3, dz3) {
        var tv2 = topS[id]; if (!mask[id] || tv2 > pp.top + 0.3) return; if (tv2 < 0.5 && !(mask[id] & 15)) return;
        var d = Math.hypot(Math.round(pp.cx) + dx3 - pp.cx, Math.round(pp.cz) + dz3 - pp.cz); if (d < ownD[id]) { ownD[id] = d; owner[id] = pp.id; }
      });
    }
    // подсчёт точек на владельца, затем отбор
    prog(ctl, 0.72, 'Столбцы: отбор точек…'); yield 0.72;
    var cntO = new Int32Array(pk.length + 1), maxHo = new Float32Array(pk.length + 1);
    for (i = 0; i < n; i++) {
      X = pos[i * 3]; Y = pos[i * 3 + 1]; Z = pos[i * 3 + 2];
      if ((X - X) + (Y - Y) + (Z - Z) !== 0) continue;
      ix = Math.floor((X - minX) / cs); iz = Math.floor((Z - minZ) / cs); if (ix < 0 || iz < 0 || ix >= NXc || iz >= NZc) continue;
      var ow = owner[iz * NXc + ix]; if (ow < 0) continue;
      gx = Math.floor((X - minX) / gcell); gz = Math.floor((Z - minZ) / gcell); if (gx < 0 || gz < 0 || gx >= GX || gz >= GZ) continue;
      h = Y - gr[gz * GX + gx]; if (h >= 0.03 && h <= pk[ow].top + 0.1) cntO[ow]++;
    }
    var okOwner = new Uint8Array(pk.length + 1);
    for (pi = 0; pi < pk.length; pi++) if (cntO[pi] >= Q.minPts) { okOwner[pi] = 1; found.push({ cx: pk[pi].cx * cs + minX, cz: pk[pi].cz * cs + minZ, h: pk[pi].top, w: Math.sqrt(pk[pi].zoneB) * cs, points: cntO[pi], via: 'cols' }); } else rejected.thin++;
    var rem = new Uint32Array(1 << 16), capR = rem.length, cnt = 0;
    if (found.length) for (i = 0; i < n; i++) {
      X = pos[i * 3]; Y = pos[i * 3 + 1]; Z = pos[i * 3 + 2];
      if ((X - X) + (Y - Y) + (Z - Z) !== 0) continue;
      ix = Math.floor((X - minX) / cs); iz = Math.floor((Z - minZ) / cs); if (ix < 0 || iz < 0 || ix >= NXc || iz >= NZc) continue;
      ow = owner[iz * NXc + ix]; if (ow < 0 || !okOwner[ow]) continue;
      gx = Math.floor((X - minX) / gcell); gz = Math.floor((Z - minZ) / gcell); if (gx < 0 || gz < 0 || gx >= GX || gz >= GZ) continue;
      h = Y - gr[gz * GX + gx]; if (!(h >= 0.03 && h <= pk[ow].top + 0.1)) continue;
      if (cnt >= capR) { capR *= 2; var nr = new Uint32Array(capR); nr.set(rem); rem = nr; }
      rem[cnt++] = i;
      if ((i & 1048575) === 1048575) { prog(ctl, 0.78 + 0.2 * i / n, 'Столбцы: отбор точек…'); yield 0.78 + 0.2 * i / n; }
    }
    return { remove: rem.slice(0, cnt), found: found, stats: { peaks: cand, rejected: rejected, cell: cs } };
  }

  // ---- третий способ поиска людей (v1180, проверен на реальном скане): «опорные столбцы» и связные группы столбцов.
  // Настоящие люди на SLAM-скане — это не чистые силуэты, а плотное туловище, рядом «призрачные» копии и разреженные хвосты шагов.
  // Поэтому форма отдельных вокселов не используется. Над землёй строятся столбцы 10×10 см, каждый — цепочка занятых слоёв по 10 см от земли
  // (разрыв до 30 см допустим). Высокие столбцы (1,1…2,6 м, над ними пусто) склеиваются в группы; группа — человек (или несколько рядом), если
  //  • её размах ≤ 1,4 м (одиночка) или ≤ 2,8 м и площадь ≤ 3 м² (группа), не тоньше 22 см и не «линейка» (стенка, лист, знак);
  //  • вокруг (кольцо 30…80 см) почти нет других высоких столбцов — иначе это стена, машина, куча, кусты, строительные леса;
  //  • точек достаточно, чтобы это не был сухой «шип» шума.
  // Удаляются все точки группы, расширенной на 20 см (хвосты и «двойники» движения), от 3 см над землёй до макушки + 15 см.
  function* peopleV2Gen(pos, n, opt, ctl) {
    opt = opt || {};
    var level = PEOPLE_LEVELS[opt.level] ? opt.level : 'normal';
    var Q = { strict: { ring: 0.08, maxExt: 1.0, maxArea: 0.3, maxS: 0.3, fill: 0.8, minPts: 400, taper: 0.85, minArea: 0.1 }, normal: { ring: 0.15, maxExt: 1.5, maxArea: 0.6, maxS: 0.5, fill: 0.74, minPts: 150, taper: 0.92, minArea: 0.09 }, loose: { ring: 0.25, maxExt: 1.6, maxArea: 0.7, maxS: 0.5, fill: 0.66, minPts: 80, taper: 1.01, minArea: 0.08 } }[level];
    var minH = opt.minH != null ? +opt.minH : PEOPLE_DEFAULTS.minH, maxH = opt.maxH != null ? +opt.maxH : PEOPLE_DEFAULTS.maxH;
    if (opt.sitting) minH = Math.min(minH, 0.9); maxH = Math.max(maxH, minH + 0.2);
    var empty = { remove: new Uint32Array(0), removed: 0, count: n, found: [], stats: { groups: 0, accepted: 0, rejected: {} } };
    var box = robustBox(pos, n); if (!box || n < 200) return empty;
    var est = CP && CP.estimate ? CP.estimate(pos, n) : { spacing: 0.03 }, sp = est.spacing > 0 ? est.spacing : 0.03;
    var occN = clamp(Math.round(0.04 * (0.1 / sp) * (0.1 / sp)), 1, 3);   // сколько точек в слое 10×10×10 см считать «занято» (на плотном скане — 3, на редком — 1)
    var G = yield* groundGen(pos, n, box, ctl), gr = G.gr, gcell = G.gcell, minX = G.minX, minZ = G.minZ, GX = G.GX, GZ = G.GZ;
    var cs = 0.1, spanX = box.mx[0] - minX, spanZ = box.mx[2] - minZ, i, c;
    while ((spanX / cs + 3) * (spanZ / cs + 3) > 12e6) cs *= 1.25;
    var NXc = Math.ceil(spanX / cs) + 2, NZc = Math.ceil(spanZ / cs) + 2, NC = NXc * NZc, SLH = 0.1, SMAX = 31;
    var A = new Uint32Array(NC), B = new Uint32Array(NC), C3 = new Uint32Array(NC), cntCol = new Uint32Array(NC);
    prog(ctl, 0.2, 'Люди: столбцы…'); yield 0.2;
    for (i = 0; i < n; i++) {
      var X = pos[i * 3], Y = pos[i * 3 + 1], Z = pos[i * 3 + 2];
      if ((X - X) + (Y - Y) + (Z - Z) !== 0) continue;
      var gx = Math.floor((X - minX) / gcell), gz = Math.floor((Z - minZ) / gcell);
      if (gx < 0 || gz < 0 || gx >= GX || gz >= GZ) continue;
      var h = Y - gr[gz * GX + gx];
      if (!(h >= 0.03 && h < 3.2) || Y < box.mn[1] || Y > box.mx[1]) continue;
      var ix = Math.floor((X - minX) / cs), iz = Math.floor((Z - minZ) / cs); if (ix < 0 || iz < 0 || ix >= NXc || iz >= NZc) continue;
      var col = iz * NXc + ix, bit = 1 << Math.min(SMAX, Math.floor(h / SLH));
      C3[col] |= B[col] & bit; B[col] |= A[col] & bit; A[col] |= bit; cntCol[col]++;
      if ((i & 1048575) === 1048575) { prog(ctl, 0.2 + 0.25 * i / n, 'Люди: столбцы…'); yield 0.2 + 0.25 * i / n; }
    }
    var mask = occN >= 3 ? C3 : (occN === 2 ? B : A);
    // высота цепочки столбца: от самого низкого занятого слоя (не выше 40 см), разрывы до 3 слоёв
    var top = new Uint8Array(NC), over = new Uint8Array(NC), s;
    for (c = 0; c < NC; c++) {
      var mk = mask[c]; if (!mk) continue;
      var s0 = 31 - Math.clz32(mk & -mk); if (s0 > 4) continue;
      var last = s0, gap = 0;
      for (s = s0 + 1; s <= SMAX; s++) { if (mk & (1 << s)) { last = s; gap = 0; } else if (++gap > 3) break; }
      top[c] = last + 1;
      var hi = 0; for (s = last + 5; s <= SMAX; s++) if (mk & (1 << s)) hi++;   // что-то над головой (+0,4 м и выше) — крона, навес, стена
      over[c] = hi;
    }
    var tMin = Math.max(3, Math.round(0.85 * minH / SLH)), tMax = Math.round((maxH + 0.4) / SLH), tallCell = new Uint8Array(NC), any = 0;
    for (c = 0; c < NC; c++) if (top[c] >= tMin && top[c] <= tMax && over[c] < 2) { tallCell[c] = 1; any++; }
    var anyTall = new Uint8Array(NC);   // «высокий предмет» для проверки кольца (любой столбец ≥ 70 см)
    for (c = 0; c < NC; c++) if (top[c] >= 7) anyTall[c] = 1;
    if (!any) { prog(ctl, 1, 'Готово'); return empty; }
    // группы: окно 5×5 (пропуск одного столбца)
    prog(ctl, 0.5, 'Люди: группы…'); yield 0.5;
    var par = new Int32Array(NC); for (c = 0; c < NC; c++) par[c] = c;
    function fnd(a) { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; }
    var zz, xx, dx, dz;
    for (zz = 2; zz < NZc - 2; zz++) for (xx = 2; xx < NXc - 2; xx++) {
      c = zz * NXc + xx; if (!tallCell[c]) continue;
      for (dz = 0; dz <= 2; dz++) for (dx = -2; dx <= 2; dx++) {
        if (dz === 0 && dx <= 0) continue;
        var c2 = c + dz * NXc + dx; if (!tallCell[c2]) continue;
        var r1 = fnd(c), r2 = fnd(c2); if (r1 !== r2) par[r1] = r2;
      }
    }
    var comps = {}, roots = [];
    for (zz = 0; zz < NZc; zz++) for (xx = 0; xx < NXc; xx++) {
      c = zz * NXc + xx; if (!tallCell[c]) continue;
      var rt = fnd(c), cm = comps[rt];
      if (!cm) { cm = comps[rt] = { cells: [], x0: xx, x1: xx, z0: zz, z1: zz, top: 0, pts: 0, sx: 0, sz: 0 }; roots.push(rt); }
      cm.cells.push(c); if (xx < cm.x0) cm.x0 = xx; if (xx > cm.x1) cm.x1 = xx; if (zz < cm.z0) cm.z0 = zz; if (zz > cm.z1) cm.z1 = zz;
      if (top[c] > cm.top) cm.top = top[c]; cm.pts += cntCol[c]; cm.sx += xx; cm.sz += zz;
    }
    var rejList = [];
    var rej = { size: 0, thin: 0, crowded: 0, few: 0, height: 0, sparse: 0, low: 0 }, accepted = [], ri, k;
    var ringIn = Math.round(0.3 / cs), ringOut = Math.round(0.8 / cs);
    for (ri = 0; ri < roots.length; ri++) {
      var cm2 = comps[roots[ri]], nc0 = cm2.cells.length;
      // ядро группы: клетки, где точек не меньше 30 % от верхней четверти (отсекает ореол и «хвосты» вокруг плотного тела)
      var cv = new Float64Array(nc0); for (k = 0; k < nc0; k++) cv[k] = cntCol[cm2.cells[k]];
      var srt = Float64Array.from(cv).sort(), q75 = srt[Math.min(nc0 - 1, Math.floor(0.75 * nc0))], thrC = 0.3 * q75, core = [];
      for (k = 0; k < nc0; k++) if (cv[k] >= thrC) core.push(cm2.cells[k]);
      var nc = core.length, cx0 = 1e9, cx1 = -1, cz0 = 1e9, cz1 = -1, csx = 0, csz = 0;
      for (k = 0; k < nc; k++) { var cq = core[k], qx = cq % NXc, qz = (cq / NXc) | 0; if (qx < cx0) cx0 = qx; if (qx > cx1) cx1 = qx; if (qz < cz0) cz0 = qz; if (qz > cz1) cz1 = qz; csx += qx; csz += qz; }
      var ext = Math.max(cx1 - cx0, cz1 - cz0) * cs + cs, area = nc * cs * cs, ctop = cm2.top * SLH;
      if (ctop < minH || ctop > maxH + 0.05) { rej.height++; if (opt.debug) rejList.push(['height', cm2, ext, area, ctop]); continue; }
      if (ext > Q.maxExt || area > Q.maxArea) { rej.size++; if (opt.debug) rejList.push(['size', cm2, ext, area, ctop]); continue; }
      if (ext < 0.22 || area < Q.minArea) { rej.thin++; continue; }
      // разброс по главным осям: у стенки, листа, знака — вытянутая «линейка», у человека — компактное пятно
      var mx = csx / nc, mz = csz / nc, sxx = 0, szz = 0, sxz = 0;
      for (k = 0; k < nc; k++) { var cc2 = core[k], px = cc2 % NXc - mx, pz = (cc2 / NXc | 0) - mz; sxx += px * px; szz += pz * pz; sxz += px * pz; }
      sxx /= nc; szz /= nc; sxz /= nc;
      var tr = sxx + szz, dt = Math.sqrt(Math.max(0, (sxx - szz) * (sxx - szz) / 4 + sxz * sxz)), l1 = tr / 2 + dt, l2 = Math.max(0, tr / 2 - dt);
      var sMinM = Math.sqrt(l2) * cs, sMaxM = Math.sqrt(l1) * cs;
      if (sMaxM > Q.maxS) { rej.size++; if (opt.debug) rejList.push(['smax', cm2, ext, area, ctop, sMaxM]); continue; }
      if (cm2.pts < Q.minPts) { rej.few++; continue; }
      // кольцо 30…80 см вокруг группы (по Чебышёву от её клеток): доля клеток с высоким предметом
      var ringN = 0, ringTall = 0, rx0 = Math.max(0, cm2.x0 - ringOut), rx1 = Math.min(NXc - 1, cm2.x1 + ringOut), rz0 = Math.max(0, cm2.z0 - ringOut), rz1 = Math.min(NZc - 1, cm2.z1 + ringOut);
      var wL = rx1 - rx0 + 1, hL = rz1 - rz0 + 1, loc = new Uint8Array(wL * hL);   // 1 — клетка группы, 2 — в пределах 30 см
      for (k = 0; k < nc0; k++) { var cc3 = cm2.cells[k]; loc[((cc3 / NXc | 0) - rz0) * wL + (cc3 % NXc - rx0)] = 1; }
      var dist = new Uint8Array(wL * hL).fill(255), q0 = [];
      for (k = 0; k < loc.length; k++) if (loc[k] === 1) { dist[k] = 0; q0.push(k); }
      for (var layer = 1; layer <= ringOut; layer++) {   // расстояние Чебышёва — послойное расширение
        var nq = [];
        for (k = 0; k < q0.length; k++) { var pz2 = (q0[k] / wL) | 0, px2 = q0[k] % wL;
          for (dz = -1; dz <= 1; dz++) for (dx = -1; dx <= 1; dx++) { var az = pz2 + dz, ax = px2 + dx; if (az < 0 || ax < 0 || az >= hL || ax >= wL) continue; var li = az * wL + ax; if (dist[li] !== 255) continue; dist[li] = layer; nq.push(li); } }
        q0 = nq;
      }
      for (k = 0; k < dist.length; k++) { var dv = dist[k]; if (dv < ringIn || dv > ringOut || dv === 255) continue; ringN++; if (anyTall[(rz0 + ((k / wL) | 0)) * NXc + rx0 + k % wL]) ringTall++; }
      if (ringN && ringTall / ringN > Q.ring) { rej.crowded++; continue; }
      var fillSum = 0; for (k = 0; k < nc; k++) { var mk3 = mask[core[k]], tp3 = top[core[k]], pcnt = 0; mk3 &= tp3 >= 31 ? 0xFFFFFFFF : ((1 << tp3) - 1); while (mk3) { mk3 &= mk3 - 1; pcnt++; } fillSum += pcnt / tp3; }
      var fill = fillSum / nc;
      if (fill < Q.fill) { rej.sparse++; continue; }
      // эффективная высота: слой, где занято не меньше 35 % клеток ядра (отсекает ёмкости, бочки, кусты с шумом над макушкой)
      var effTop = 0; for (s = 0; s <= SMAX; s++) { var cc5 = 0; for (k = 0; k < nc; k++) if (mask[core[k]] & (1 << s)) cc5++; if (cc5 >= 0.35 * nc) effTop = (s + 1) * SLH; }
      if (effTop < minH - 0.1) { rej.low++; continue; }
      // «макушка»: у человека верхние слои (голова) заметно уже, чем в середине; ровная колонна, ящик, бочка до самого верха держат ту же ширину
      var tpL = cm2.top, pf = []; for (s = 0; s < tpL; s++) { var pc3 = 0; for (k = 0; k < nc; k++) if (mask[core[k]] & (1 << s)) pc3++; pf.push(pc3); }
      var pfs = pf.slice().sort(function (a, b) { return a - b; }), pmed = pfs[pfs.length >> 1] || 1, ptop = tpL >= 4 ? (pf[tpL - 2] + pf[tpL - 3]) / 2 : pf[0]   /* самый верхний слой неполный — пропускаем */, taper = ptop / pmed;
      if (taper > Q.taper) { rej.low++; if (opt.debug) rejList.push(['taper', cm2, ext, area, ctop, taper]); continue; }
      var prof = []; if (opt.debug) { for (s = 0; s < 27; s++) { var pc2 = 0; for (k = 0; k < nc; k++) if (mask[core[k]] & (1 << s)) pc2++; prof.push(pc2); } }
      accepted.push({ prof: prof, root: roots[ri], cm: cm2, ext: ext, top: ctop, area: area, sMin: sMinM, sMax: sMaxM, fill: fill, ringFrac: ringN ? ringTall / ringN : 0 });
    }
    var found = [];
    for (k = 0; k < accepted.length; k++) { var ac = accepted[k], cmm = ac.cm; found.push({ cx: (cmm.sx / cmm.cells.length) * cs + minX + cs / 2, cz: (cmm.sz / cmm.cells.length) * cs + minZ + cs / 2, h: ac.top, w: ac.ext, points: cmm.pts, via: 'v2' }); }
    var stats = { groups: roots.length, accepted: accepted.length, rejected: rej, cell: cs, occN: occN, spacing: sp };
    if (opt.debug) stats.rejList = rejList.map(function (r) { var c0 = r[1]; return { why: r[0], x: c0.sx / c0.cells.length * cs + minX, z: c0.sz / c0.cells.length * cs + minZ, ext: r[2], area: r[3], top: r[4], s: r[5], pts: c0.pts }; });
    if (opt.debug) stats.debug = accepted.map(function (a) { return { x: (a.cm.sx / a.cm.cells.length) * cs + minX, z: (a.cm.sz / a.cm.cells.length) * cs + minZ, top: a.top, ext: a.ext, area: a.area, sMin: a.sMin, sMax: a.sMax, ring: a.ringFrac, fill: a.fill, pts: a.cm.pts, cells: a.cm.cells.length, prof: a.prof }; });
    if (!accepted.length) { prog(ctl, 1, 'Готово'); return { remove: new Uint32Array(0), removed: 0, count: n, found: [], stats: stats }; }
    // клетки удаления: клетки групп, расширенные на 20 см; высота ограничивается макушкой группы + 15 см
    var ownerTop = new Float32Array(NC), DIL = Math.round(0.2 / cs);
    for (k = 0; k < accepted.length; k++) {
      var cm3 = accepted[k].cm, tp = accepted[k].top + 0.15;
      for (var m = 0; m < cm3.cells.length; m++) {
        var cc4 = cm3.cells[m], cz4 = (cc4 / NXc) | 0, cx4 = cc4 % NXc;
        for (dz = -DIL; dz <= DIL; dz++) for (dx = -DIL; dx <= DIL; dx++) { var az2 = cz4 + dz, ax2 = cx4 + dx; if (az2 < 0 || ax2 < 0 || az2 >= NZc || ax2 >= NXc) continue; var id2 = az2 * NXc + ax2; if (tp > ownerTop[id2]) ownerTop[id2] = tp; }
      }
    }
    prog(ctl, 0.8, 'Люди: отбор точек…'); yield 0.8;
    var rem = new Uint32Array(1 << 16), capR = rem.length, cnt = 0;
    for (i = 0; i < n; i++) {
      X = pos[i * 3]; Y = pos[i * 3 + 1]; Z = pos[i * 3 + 2];
      if ((X - X) + (Y - Y) + (Z - Z) !== 0) continue;
      ix = Math.floor((X - minX) / cs); iz = Math.floor((Z - minZ) / cs); if (ix < 0 || iz < 0 || ix >= NXc || iz >= NZc) continue;
      var tpv = ownerTop[iz * NXc + ix]; if (!tpv) continue;
      gx = Math.floor((X - minX) / gcell); gz = Math.floor((Z - minZ) / gcell); if (gx < 0 || gz < 0 || gx >= GX || gz >= GZ) continue;
      h = Y - gr[gz * GX + gx]; if (!(h >= 0.03 && h <= tpv)) continue;
      if (cnt >= capR) { capR *= 2; var nr = new Uint32Array(capR); nr.set(rem); rem = nr; }
      rem[cnt++] = i;
      if ((i & 1048575) === 1048575) { prog(ctl, 0.8 + 0.19 * i / n, 'Люди: отбор точек…'); yield 0.8 + 0.19 * i / n; }
    }
    prog(ctl, 1, 'Готово');
    return { remove: rem.slice(0, cnt), removed: cnt, count: n, found: found, stats: stats };
  }

  function* peopleGen(pos, n, opt, ctl) {
    opt = opt || {}; n = n | 0;
    var top = 0, sub = function (a, b) { return ctl && typeof ctl.progress === 'function' ? { progress: function (f, l) { var v = Math.max(top, a + (b - a) * f); top = v; ctl.progress(v, l); } } : null; };
    var A = yield* peopleAGen(pos, n, opt, sub(0, 0.35));
    if (opt.mode === 'shape' || n < 200) { prog(ctl, 1, 'Готово'); return A; }
    var box = robustBox(pos, n); if (!box) { prog(ctl, 1, 'Готово'); return A; }
    var B = yield* peopleColsGen(pos, n, opt, A.params, box, sub(0.35, 0.65));
    var V = yield* peopleV2Gen(pos, n, opt, sub(0.65, 0.97));
    // объединение: флаги по индексам точек (бит на точку)
    var flag = new Uint8Array((n >> 3) + 1), i, cnt = 0, rem;
    function mark(arr) { for (var k = 0; k < arr.length; k++) { var j = arr[k]; flag[j >> 3] |= 1 << (j & 7); } }
    mark(A.remove); mark(B.remove); mark(V.remove);
    for (i = 0; i < n; i++) if (flag[i >> 3] & (1 << (i & 7))) cnt++;
    rem = new Uint32Array(cnt); var w = 0;
    for (i = 0; i < n; i++) if (flag[i >> 3] & (1 << (i & 7))) rem[w++] = i;
    var found = A.found.slice();
    for (var f = 0; f < B.found.length; f++) {   // не дублируем то, что уже найдено первым способом
      var bf = B.found[f], dup = false;
      for (var g = 0; g < A.found.length && !dup; g++) if (Math.hypot(A.found[g].cx - bf.cx, A.found[g].cz - bf.cz) < 0.6) dup = true;
      if (!dup) found.push(bf);
    }
    for (var f2 = 0; f2 < V.found.length; f2++) {
      var vf = V.found[f2], dup2 = false;
      for (var g2 = 0; g2 < found.length && !dup2; g2++) if (Math.hypot(found[g2].cx - vf.cx, found[g2].cz - vf.cz) < 0.6) dup2 = true;
      if (!dup2) found.push(vf);
    }
    var stats = Object.assign({}, A.stats, { cols: B.stats, v2: V.stats, foundShape: A.found.length, foundCols: B.found.length, foundV2: V.found.length });
    prog(ctl, 1, 'Готово');
    return { remove: rem, removed: cnt, count: n, found: found, stats: stats, params: A.params };
  }

  function people(pos, n, opt, ctl) { return run(peopleGen(pos, n, opt, ctl)); }

  // ---------------------------------------------------------------- автоматическая чистка (всё сразу)
  /**
   * Автоматическая чистка: шум → люди → выравнивание плоскостей и «волосы» около них. Каждый этап работает над результатом предыдущего:
   * найденные «летающие» точки и люди не искажают подбор плоскостей, а плоскости подбираются уже по чистому облаку.
   * opt: level ('soft'|'medium'|'strong' — шум), people (bool), peopleLevel, minH, maxH, sitting, flatten (bool), facade (bool — толстый слой), tol (м), hair (bool).
   * Возврат: { remove (Uint32Array, по возрастанию), pos (Float32Array n·3 — новые координаты, у удаляемых точек исходные), stats }.
   */
  function* autoCleanGen(pos, n, opt, ctl) {
    opt = opt || {}; n = n | 0;
    var CPm = CP, stats = { noise: 0, people: 0, peopleFound: 0, hair: 0, moved: 0, planes: 0, rmsShift: 0 };
    var gone = new Uint8Array(n), i;
    var useNoise = opt.noise !== false, usePeople = opt.people !== false, useFlat = opt.flatten !== false && !!CPm && !!CPm.flatten;
    var w = (useNoise ? 0.35 : 0) + (usePeople ? 0.3 : 0) + (useFlat ? 0.35 : 0) || 1, done = 0;
    function sub(frac) { var a = done / w, b = (done + frac) / w; done += frac; return { progress: function (f, l) { prog(ctl, a + (b - a) * f, l); } }; }
    if (useNoise) {
      var r1 = yield* denoiseGen(pos, n, { level: opt.level || 'medium' }, sub(0.35));
      for (i = 0; i < r1.remove.length; i++) gone[r1.remove[i]] = 1;
      stats.noise = r1.removed;
    }
    if (usePeople) {
      var r2 = yield* peopleGen(pos, n, { level: opt.peopleLevel || 'normal', minH: opt.minH, maxH: opt.maxH, sitting: opt.sitting, col: opt.col }, sub(0.3));
      for (i = 0; i < r2.remove.length; i++) { if (!gone[r2.remove[i]]) stats.people++; gone[r2.remove[i]] = 1; }
      stats.peopleFound = r2.found.length;
    }
    var out = new Float32Array(pos);   // копия: результат — новые координаты
    if (useFlat) {
      var kept = 0; for (i = 0; i < n; i++) if (!gone[i]) kept++;
      var cp = new Float32Array(kept * 3), map = new Uint32Array(kept), k = 0;
      for (i = 0; i < n; i++) if (!gone[i]) { cp[k * 3] = pos[i * 3]; cp[k * 3 + 1] = pos[i * 3 + 1]; cp[k * 3 + 2] = pos[i * 3 + 2]; map[k++] = i; }
      var est = CPm.estimate(cp, kept), fac = !!opt.facade, tol = opt.tol > 0 ? +opt.tol : (fac ? 0.12 : 0.03);
      prog(ctl, (done) / w, 'Выравнивание плоскостей…'); yield 0;
      var fr = CPm.flatten(cp, kept, { tol: tol, strength: opt.strength == null ? 1 : opt.strength, spacing: est.spacing, cell: fac ? 0.6 : undefined, inPlace: true, hairBand: opt.hair === false ? 0 : Math.min(0.15, Math.max(3 * tol, 0.06)) }, null);
      prog(ctl, 1, 'Готово');
      for (k = 0; k < kept; k++) { var o = map[k] * 3; out[o] = cp[k * 3]; out[o + 1] = cp[k * 3 + 1]; out[o + 2] = cp[k * 3 + 2]; }
      stats.moved = fr.moved; stats.planes = fr.planes; stats.rmsShift = fr.rmsShift || 0;
      if (fr.hair) { for (k = 0; k < fr.hair.length; k++) { var gi = map[fr.hair[k]]; if (!gone[gi]) { gone[gi] = 1; stats.hair++; } } }
    } else prog(ctl, 1, 'Готово');
    var cnt = 0; for (i = 0; i < n; i++) if (gone[i]) cnt++;
    var rem = new Uint32Array(cnt), q = 0; for (i = 0; i < n; i++) if (gone[i]) rem[q++] = i;
    stats.removed = cnt;
    return { remove: rem, removed: cnt, count: n, pos: out, stats: stats };
  }
  function autoClean(pos, n, opt, ctl) { return run(autoCleanGen(pos, n, opt, ctl)); }

  /** Декодирует код 0..255 в шаг, м. */
  function decodeSpacing(code, sMin, sMax) { return sMin * Math.pow(sMax / sMin, code / 255); }

  return { spacingGen: spacingGen, spacingField: spacingField, decodeSpacing: decodeSpacing, denoiseGen: denoiseGen, denoise: denoise, DENOISE_PRESETS: DENOISE_PRESETS, peopleGen: peopleGen, people: people, peopleV2Gen: peopleV2Gen, autoCleanGen: autoCleanGen, autoClean: autoClean, PEOPLE_LEVELS: PEOPLE_LEVELS, run: run,
    _internal: { CellMap: CellMap, hash3: hash3, robustBox: robustBox } };
});
