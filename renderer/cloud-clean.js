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
    soft:   { tau: 0.04, iso: 3, nIsland: 8,   extIsland: 0.5, rho: 0, link: 24 },
    medium: { tau: 0.04, iso: 3, nIsland: 40,  extIsland: 1.0, rho: 0, link: 24 },
    strong: { tau: 0.08, iso: 4, nIsland: 150, extIsland: 2.0, rho: 0, link: 24 }
  };

  function* denoiseGen(pos, n, opt, ctl) {
    opt = opt || {}; n = n | 0;
    var P = Object.assign({}, DENOISE_PRESETS[opt.level] || DENOISE_PRESETS.medium, opt.params || {});
    var F = yield* fieldGen(pos, n, { sub: Infinity, keepCid: true, p1: 0.3, label: 'Плотность точек…' }, ctl);
    var i, id, c, q, dx, dy, dz;
    if (!F) return { remove: new Uint32Array(0), removed: 0, count: n, stats: { islands: 0, isolated: 0, offSurface: 0, invalid: 0 }, params: P };
    var L0 = F.L0, cells = F.cells, cid = F.cid, levels = F.levels, LEN = F.LEN, h0 = F.h0, s0 = F.s0, ncell = cells;
    var bad = new Uint8Array(cells), stat = { islands: 0, isolated: 0, offSurface: 0, invalid: 0 }, core = opt.core || null;
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

  /** Декодирует код 0..255 в шаг, м. */
  function decodeSpacing(code, sMin, sMax) { return sMin * Math.pow(sMax / sMin, code / 255); }

  return { spacingGen: spacingGen, spacingField: spacingField, decodeSpacing: decodeSpacing, denoiseGen: denoiseGen, denoise: denoise, DENOISE_PRESETS: DENOISE_PRESETS, run: run,
    _internal: { CellMap: CellMap, hash3: hash3, robustBox: robustBox } };
});
