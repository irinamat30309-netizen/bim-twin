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

  function* peopleGen(pos, n, opt, ctl) {
    opt = opt || {}; n = n | 0;
    var P = Object.assign({}, PEOPLE_DEFAULTS, PEOPLE_LEVELS[opt.level] || PEOPLE_LEVELS.normal, opt.params || {});
    if (opt.minH != null) P.minH = opt.minH; if (opt.maxH != null) P.maxH = opt.maxH; if (opt.sitting != null) P.sitting = !!opt.sitting; if (opt.maxW != null) P.maxW = opt.maxW;
    var minH = P.sitting ? Math.min(P.minH, 0.9) : P.minH, maxH = Math.max(P.maxH, minH + 0.2);
    var empty = { remove: new Uint32Array(0), removed: 0, count: n, found: [], stats: { components: 0, candidates: 0, rejected: {} }, params: P };
    var box = robustBox(pos, n); if (!box || n < 200) return empty;
    var est = CP && CP.estimate ? CP.estimate(pos, n) : { spacing: 0.03 }, sp = est.spacing > 0 ? est.spacing : 0.03;
    var v = clamp(5 * sp, 0.07, 0.15), HLOW = 0.1, HTOP = Math.max(3.0, maxH + 0.8), i, k, c;
    // --- 1. земля: по клеткам 0,5 м берём низ плотной массы точек (4-ю снизу), затем «открытие» окном ±1,5 м убирает машины, людей, кусты
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
  function people(pos, n, opt, ctl) { return run(peopleGen(pos, n, opt, ctl)); }

  /** Декодирует код 0..255 в шаг, м. */
  function decodeSpacing(code, sMin, sMax) { return sMin * Math.pow(sMax / sMin, code / 255); }

  return { spacingGen: spacingGen, spacingField: spacingField, decodeSpacing: decodeSpacing, denoiseGen: denoiseGen, denoise: denoise, DENOISE_PRESETS: DENOISE_PRESETS, peopleGen: peopleGen, people: people, PEOPLE_LEVELS: PEOPLE_LEVELS, run: run,
    _internal: { CellMap: CellMap, hash3: hash3, robustBox: robustBox } };
});
