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
   * Поле локального шага. Возвращает (через генератор) { codes: Uint8Array(n), sMin, sMax, s0, h0, cells }.
   * Шаг точки s = мин. размер ячейки h·√(KAPPA / c): c — число точек в ячейке, выбранной из пирамиды (h, 2h, 4h …) так, чтобы в ней
   * было не меньше CMIN точек. Код точки = лог-шкала s в диапазоне [sMin, sMax] (0..255): 1 байт на точку.
   */
  function* spacingGen(pos, n, opt, ctl) {
    opt = opt || {}; n = n | 0;
    var est = CP.estimate(pos, n), s0 = est.spacing > 0 ? est.spacing : 0.02;
    var rb = robustBox(pos, n);
    if (!rb) return { codes: new Uint8Array(n), sMin: s0, sMax: s0 * 1.0001, s0: s0, h0: s0 * 3, cells: 0 };
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
    for (var u = 0; u < m; u++) {
      i = u < m - 1 ? Math.floor(u * step) : n - 1; j = i * 3;
      var x = pos[j] - mn0, y = pos[j + 1] - mn1, z = pos[j + 2] - mn2;
      if ((x - x) + (y - y) + (z - z) !== 0) continue;
      var ix = (x * inv) | 0, iy = (y * inv) | 0, iz = (z * inv) | 0;
      if (x < 0) ix = 0; else if (ix > mx0) ix = mx0;
      if (y < 0) iy = 0; else if (iy > mx1) iy = mx1;
      if (z < 0) iz = 0; else if (iz > mx2) iz = mx2;
      L0.add(ix, iy, iz, wgt);
      if ((u & (CHUNK - 1)) === CHUNK - 1) { prog(ctl, 0.45 * u / m, 'Плотность точек…'); yield 0.45 * u / m; }
    }
    // пирамида: уровень j = ячейки со стороной h0·2^j (счётчики суммируются из предыдущего уровня)
    var levels = [L0], maxLev = 8, cur = L0, lv;
    for (lv = 1; lv <= maxLev && cur.n > 8; lv++) {
      var P = new CellMap(ny, nz, cur.n / 2);
      for (var c = 0; c < cur.n; c++) P.add(cur.cx[c] >> 1, cur.cy[c] >> 1, cur.cz[c] >> 1, cur.cnt[c]);
      levels.push(P); cur = P; yield 0.46;
    }
    // шаг для каждой ячейки нулевого уровня
    var cells = L0.n, sCell = new Float32Array(cells), lo = Infinity, hi = 0, LEN = levels.length;
    var sFloor = s0 / 64, sCeil = s0 * 64;
    for (var id = 0; id < cells; id++) {
      var ax = L0.cx[id], ay = L0.cy[id], az = L0.cz[id], cc = L0.cnt[id], hh = h0, sv;
      var l2 = 0, c0 = cc, c1 = cc;
      while (cc < CMIN && l2 + 1 < LEN) {
        l2++; hh *= 2;
        var pid = levels[l2].find(ax >> l2, ay >> l2, az >> l2);
        cc = pid >= 0 ? levels[l2].cnt[pid] : 1;
        if (l2 === 1) c1 = cc;
      }
      sv = clamp(hh * Math.sqrt(KAPPA / Math.max(1, cc)), sFloor, Math.min(sCeil, 16 * s0));
      // одиночная точка/«комочек» вдали от поверхностей (в ячейке и в её родителе почти пусто) — это шум, а не разреженная поверхность:
      // рисуем её небольшой, а не огромным квадратом шага «пустоты» вокруг
      if (l2 >= 1 && c0 <= 1.5 * wgt && c1 <= 3 * wgt && LEN > 4) {
        var Lb = levels[4], bx = ax >> 4, by = ay >> 4, bz = az >> 4, blk = 0;
        for (var dx = -1; dx <= 1 && blk <= 4 * wgt; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
          var bid = Lb.find(bx + dx, by + dy, bz + dz); if (bid >= 0) blk += Lb.cnt[bid];
        }
        if (blk <= 4 * wgt) sv = Math.min(sv, 4 * s0);    // и в блоке 3×3×3 из крупных ячеек (16·h) почти пусто — одиночный выброс
      }
      sCell[id] = sv; if (sv < lo) lo = sv; if (sv > hi) hi = sv;
      if ((id & 262143) === 262143) yield 0.46 + 0.04 * id / cells;
    }
    if (!(lo < Infinity)) { lo = s0; hi = s0; }
    var sMin = lo, sMax = Math.max(hi, lo * 1.0001), lnMin = Math.log(sMin), span = Math.log(sMax) - lnMin;
    var codeOfCell = new Uint8Array(cells);
    for (var q = 0; q < cells; q++) codeOfCell[q] = Math.round((Math.log(sCell[q]) - lnMin) / span * 255);
    levels.length = 1; levels[1] = null;
    // запись кода каждой точки
    var codes = new Uint8Array(n);
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
    return { codes: codes, sMin: sMin, sMax: sMax, s0: s0, h0: h0, cells: cells };
  }
  function spacingField(pos, n, opt, ctl) { return run(spacingGen(pos, n, opt, ctl)); }

  /** Декодирует код 0..255 в шаг, м. */
  function decodeSpacing(code, sMin, sMax) { return sMin * Math.pow(sMax / sMin, code / 255); }

  return { spacingGen: spacingGen, spacingField: spacingField, decodeSpacing: decodeSpacing, run: run,
    _internal: { CellMap: CellMap, hash3: hash3, robustBox: robustBox } };
});
