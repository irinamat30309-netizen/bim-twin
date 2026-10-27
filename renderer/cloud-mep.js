/*
 * cloud-mep.js — балки, трубы, воздуховоды и лотки под потолком по облаку точек (ревизия 33).
 *
 * Проход по файлу (вместе с полом и стенами): воксели 5 × 5 × 5 см в рамке, повёрнутой по главному направлению плана, от 1,2 м над
 * полом до перекрытия; на воксель два бита — точка встречена один раз и не меньше двух (одиночные точки шума не занимают воксель).
 * Местный потолок — верхний занятый воксель колонок: 75-й процентиль в квадрате 0,5 м, наибольший из соседних квадратов (над балкой
 * и плотной трубой перекрытие сканеру не видно, рядом — видно). «Висящий» воксель — ниже потолка на 10 см и больше, не ниже
 * 1,9 м над полом, а под ним в колонке есть пустой промежуток от 0,4 м (стены, шкафы и колонны заняты донизу и отпадают); у граней
 * стен плана (±15 см) — перемычки над проёмами — не учитываются.
 * Линейные элементы — по каждому из двух направлений плана: отрезки по 0,5 м вдоль направления, сечение «поперёк × высота»; клетка
 * сечения устойчива, если занята в 70 % вокселей отрезка; связные пятна сечения — сечения элементов; пятна соседних отрезков с
 * перекрытием складываются в элемент; длина от 1 м, ширина до 1,2 м. Край потолка (пятно продолжается потолком того же уровня у
 * соседней колонки — уступ, подвесной потолок) отбрасывается.
 * Второй проход — точное сечение по точкам (1 см): нижний профиль; окружность по профилю (МНК) — труба и её диаметр; несколько дуг —
 * пучок труб (каждая отдельно); плоский низ у потолка — балка (выступ перекрытия), плоский тонкий — лоток, иначе короб (воздуховод).
 * Высота в свету — от пола (местная отметка по сетке пола) до низа элемента; ниже порога — замечание.
 *
 *   mepAcc({ rect, phi, z0, z1, cell, dz }) → накопитель (add(u, v, h))
 *   mepFind(acc, { floor, floorAt, exclude, ... }) → { ok, list, ceiling, stats }
 *   refineAcc(list, { rect }) → накопитель точного сечения;  refine(list, racc, { floorAt, clear }) → list
 *   summary(list) · toDxfEntities(list, { origin }) · toIfc(list, { origin, name, storey }) · csvRows(list)
 * Чистые функции (UMD: window.CloudMEP, module.exports).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudMEP = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function median(a) { if (!a.length) return NaN; var s = Float64Array.from(a).sort(); var m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function pct(a, p) { if (!a.length) return NaN; var s = Float64Array.from(a).sort(); return s[clamp(Math.round((s.length - 1) * p), 0, s.length - 1)]; }
  function bitTop(w) { return 31 - Math.clz32(w); }
  var KIND = { beam: 'балка', pipe: 'труба', duct: 'короб', tray: 'лоток', rack: 'трасса' };
  var KIND_LONG = { beam: 'Балка (выступ перекрытия)', pipe: 'Труба', duct: 'Воздуховод / короб', tray: 'Кабельный лоток', rack: 'Трасса (пучок труб, кабелей)' };

  // ---------------------------------------------------------------- накопитель вокселей
  function mepAcc(o) {
    o = o || {};
    var phi = +o.phi || 0, c = Math.cos(phi), s = Math.sin(phi), R = o.rect;
    var A0 = Infinity, A1 = -Infinity, B0 = Infinity, B1 = -Infinity;
    [[R.u0, R.v0], [R.u1, R.v0], [R.u0, R.v1], [R.u1, R.v1]].forEach(function (p) {
      var a = p[0] * c + p[1] * s, b = -p[0] * s + p[1] * c;
      if (a < A0) A0 = a; if (a > A1) A1 = a; if (b < B0) B0 = b; if (b > B1) B1 = b;
    });
    var cell = o.cell || 0.05, maxCols = o.maxCols || 9e6;
    while (((A1 - A0) / cell) * ((B1 - B0) / cell) > maxCols) cell *= 1.2;
    var dz = o.dz || 0.05, z0 = +o.z0, z1 = +o.z1, ns = clamp(Math.ceil((z1 - z0) / dz), 4, 128), W = (ns + 31) >> 5;
    var na = Math.max(1, Math.ceil((A1 - A0) / cell)), nb = Math.max(1, Math.ceil((B1 - B0) / cell)), N = na * nb;
    var seen = new Uint32Array(N * W), solid = new Uint32Array(N * W), n = 0;
    var zTop = z0 + ns * dz;
    return {
      phi: phi, c: c, s: s, a0: A0, b0: B0, cell: cell, na: na, nb: nb, ns: ns, W: W, z0: z0, dz: dz, seen: seen, solid: solid,
      add: function (u, v, h) {
        if (!(h >= z0 && h < zTop)) return;
        var ia = Math.floor((u * c + v * s - A0) / cell), ib = Math.floor((-u * s + v * c - B0) / cell);
        if (ia < 0 || ib < 0 || ia >= na || ib >= nb) return;
        var si = Math.floor((h - z0) / dz), k = (ib * na + ia) * W + (si >> 5), bit = 1 << (si & 31);
        if (seen[k] & bit) solid[k] |= bit; else seen[k] |= bit;
        n++;
      },
      count: function () { return n; },
      toUV: function (a, b) { return [a * c - b * s, a * s + b * c]; },
      bytes: N * W * 8
    };
  }

  // ---------------------------------------------------------------- поиск элементов
  // пятна сечения: отрезки занятых клеток по столбцам, сцепка соседних столбцов по низу отрезка
  function pieces(P, L2, ns, need) {
    var runs = [], prev = [], prev2 = [], cur, j, s, k;
    for (j = 0; j < L2; j++) {
      cur = []; var base = j * ns;
      for (s = 0; s < ns; s++) {
        if (P[base + s] < need) continue;
        var e = s; while (e + 1 < ns && P[base + e + 1] >= need) e++;
        var r = { j: j, s0: s, s1: e, id: runs.length, lo: s, hi: s }; runs.push(r); cur.push(r); s = e;
      }
      // каждому отрезку — ближайший по низу из соседнего столбца (не дальше одной клетки), без повторов
      // (через пустой столбец — тоже: просвет между трубами ряда)
      var taken = new Set();
      [prev, prev2].forEach(function (pv, gap) {
        cur.forEach(function (r) {
          if (r.link != null) return;
          var best = null, bd = 2;
          // низ цепочки уходит не дальше двух клеток от самого нижнего: косые провода и подвесы не сцепляют ярусы
          pv.forEach(function (q) { var d = Math.abs(q.s0 - r.s0); if (d < bd && !taken.has(q.id) && (!gap || !q.next) && Math.abs(r.s0 - q.lo) <= 2 && Math.abs(r.s0 - q.hi) <= 2) { bd = d; best = q; } });
          if (best) { taken.add(best.id); best.next = true; r.link = best.id; r.lo = Math.min(best.lo, r.s0); r.hi = Math.max(best.hi, r.s0); }
        });
      });
      prev2 = prev; prev = cur;
    }
    var root = new Int32Array(runs.length);
    for (k = 0; k < runs.length; k++) root[k] = runs[k].link != null ? root[runs[k].link] : k;
    var by = new Map();
    runs.forEach(function (r) {
      var id = root[r.id], c = by.get(id);
      if (!c) by.set(id, c = { j0: r.j, j1: r.j, s0: r.s0, s1: r.s1, n: 0 });
      if (r.j < c.j0) c.j0 = r.j; if (r.j > c.j1) c.j1 = r.j; if (r.s0 < c.s0) c.s0 = r.s0; if (r.s1 > c.s1) c.s1 = r.s1; c.n += r.s1 - r.s0 + 1;
    });
    return Array.from(by.values());
  }
  function mepFind(acc, o) {
    o = o || {};
    var na = acc.na, nb = acc.nb, ns = acc.ns, W = acc.W, N = na * nb, cell = acc.cell, dz = acc.dz, z0 = acc.z0, solid = acc.solid;
    var floor = +o.floor, floorAt = typeof o.floorAt === 'function' ? o.floorAt : null, floorSeen = typeof o.floorSeen === 'function' ? o.floorSeen : null;
    var minBottom = o.minBottom != null ? +o.minBottom : 1.9, freeS = Math.max(2, Math.round((o.free || 0.4) / dz)), gapS = Math.max(1, Math.round((o.gap || 0.1) / dz));
    var segC = Math.max(4, Math.round((o.seg || 0.5) / cell)), need = Math.ceil((o.persist || 0.7) * segC), minLen = o.minLen || 1, maxWidth = o.maxWidth || 1.2;
    var i, j, k, w, col;
    // 1. верх колонки
    var top = new Int16Array(N).fill(-1);
    for (col = 0; col < N; col++) for (w = W - 1; w >= 0; w--) { var x = solid[col * W + w]; if (x) { top[col] = w * 32 + bitTop(x); break; } }
    // 2. потолок: квадраты 0,5 м — 75-й процентиль верха колонок (если в квадрате занято от 15 % колонок и верх ровный), затем наибольший из 3 × 3
    var B = Math.max(2, Math.round(0.5 / cell)), ga = Math.ceil(na / B), gb = Math.ceil(nb / B), blk = new Int16Array(ga * gb).fill(-1), buf = [];
    var blk0 = new Int16Array(ga * gb).fill(-1), blkP = new Int16Array(ga * gb).fill(-1), blkQ = new Float32Array(ga * gb), qS = Math.max(1, Math.round(0.1 / dz)), capS = Math.max(1, Math.round((o.cap != null ? o.cap : 0.1) / dz)), ceilQ = o.ceilQ != null ? +o.ceilQ : 0.5;
    for (var by = 0; by < gb; by++) for (var bx = 0; bx < ga; bx++) {
      buf.length = 0;
      for (j = by * B; j < Math.min(nb, by * B + B); j++) for (i = bx * B; i < Math.min(na, bx * B + B); i++) { var tp = top[j * na + i]; if (tp >= 0) buf.push(tp); }
      if (buf.length < 0.15 * B * B) continue;
      var pv = Math.round(pct(buf, 0.75)), nq = 0;
      // потолок — ровный слой внутри полосы: верх колонок у 75-го процентиля (±0,1 м) хотя бы у половины колонок квадрата;
      // упор в верх полосы — облако идёт выше (крона дерева, высокий зал), потолок не измерен; рыхлый верх — крона, не плита
      for (var qi = 0; qi < buf.length; qi++) if (Math.abs(buf[qi] - pv) <= qS) nq++;
      blkQ[by * ga + bx] = nq / buf.length; blkP[by * ga + bx] = pv;
      if (pv <= ns - 1 - capS && nq >= ceilQ * buf.length) blk0[by * ga + bx] = pv;
    }
    // плита сплошная: в 3 × 3 не меньше 4 ровных квадратов на одной высоте (±0,15 м) — отдельные «ровные» пятна в кроне отпадают
    var tolS = Math.max(1, Math.round(0.15 / dz));
    for (by = 0; by < gb; by++) for (bx = 0; bx < ga; bx++) {
      var p0 = blk0[by * ga + bx]; if (p0 < 0) continue; var cnt0 = 0;
      for (var y8 = Math.max(0, by - 1); y8 <= Math.min(gb - 1, by + 1); y8++) for (var x8 = Math.max(0, bx - 1); x8 <= Math.min(ga - 1, bx + 1); x8++) { var p8 = blk0[y8 * ga + x8]; if (p8 >= 0 && Math.abs(p8 - p0) <= tolS) cnt0++; }
      if (cnt0 >= 4) blk[by * ga + bx] = p0;
    }
    var ceilB = new Int16Array(ga * gb).fill(-1);
    for (by = 0; by < gb; by++) for (bx = 0; bx < ga; bx++) {
      // квадрат с неровным верхом (балка во всю ширину квадрата, край плиты) берёт потолок соседей, если облако не уходит выше полосы
      if (blk[by * ga + bx] < 0 && !(blkQ[by * ga + bx] > 0 && blkP[by * ga + bx] <= ns - 1 - capS)) continue; var m = -1;
      for (var yy = Math.max(0, by - 1); yy <= Math.min(gb - 1, by + 1); yy++) for (var xx = Math.max(0, bx - 1); xx <= Math.min(ga - 1, bx + 1); xx++) if (blk[yy * ga + xx] > m) m = blk[yy * ga + xx];
      ceilB[by * ga + bx] = m;
    }
    var ceilOf = function (ia, ib) { return ceilB[Math.floor(ib / B) * ga + Math.floor(ia / B)]; };
    // 3. у граней стен плана (и проёмов) — не элементы
    var excl = new Uint8Array(N), ER = Math.max(1, Math.round((o.exclR != null ? o.exclR : 0.15) / cell));
    (o.exclude || []).forEach(function (sg) {
      if (!sg || !sg.a || !sg.b) return;
      var pa = [sg.a[0] * acc.c + sg.a[1] * acc.s - acc.a0, -sg.a[0] * acc.s + sg.a[1] * acc.c - acc.b0], pb = [sg.b[0] * acc.c + sg.b[1] * acc.s - acc.a0, -sg.b[0] * acc.s + sg.b[1] * acc.c - acc.b0];
      var L = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]), st = Math.max(1, Math.ceil(L / (cell * 0.5)));
      for (var q = 0; q <= st; q++) {
        var ci = Math.floor((pa[0] + (pb[0] - pa[0]) * q / st) / cell), cj = Math.floor((pa[1] + (pb[1] - pa[1]) * q / st) / cell);
        for (var dj = -ER; dj <= ER; dj++) for (var di = -ER; di <= ER; di++) { var I = ci + di, J = cj + dj; if (I >= 0 && J >= 0 && I < na && J < nb && di * di + dj * dj <= ER * ER) excl[J * na + I] = 1; }
      }
    });
    // 4. висящие воксели (в массив seen — он больше не нужен)
    var H = acc.seen; H.fill(0);
    var hang = 0, cols = 0;
    for (j = 0; j < nb; j++) for (i = 0; i < na; i++) {
      col = j * na + i; var cs = ceilOf(i, j); if (cs < 0 || excl[col] || top[col] < 0) continue;
      var sMax = Math.min(ns - 1, cs - gapS - 1); if (sMax < 0) continue;
      var fz = floor; if (floorAt) { var ab = acc.toUV(acc.a0 + (i + 0.5) * cell, acc.b0 + (j + 0.5) * cell), fv = floorAt(ab[0], ab[1]); if (fv === fv) fz = fv; }
      // промежуток под элементом должен быть виден: снизу ограничен занятым вокселем (верх шкафа, стеллажа) или под ним виден пол
      // (у шкафа внутри пусто только потому, что сканер туда не заглядывает)
      var sMin = Math.max(0, Math.ceil((fz + minBottom - z0) / dz)), run = 0, any = false, good = false, fromBottom = false, fsee = -1;
      for (var sl = 0; sl <= sMax; sl++) {
        var on = solid[col * W + (sl >> 5)] & (1 << (sl & 31));
        if (!on) {
          if (run === 0) fromBottom = sl === 0;
          run++;
          if (run >= freeS && !good) {
            if (!fromBottom) good = true;
            else { if (fsee < 0) { var uv = acc.toUV(acc.a0 + (i + 0.5) * cell, acc.b0 + (j + 0.5) * cell); fsee = floorSeen ? (floorSeen(uv[0], uv[1]) ? 1 : 0) : 1; } if (fsee) good = true; }
          }
          continue;
        }
        run = 0;
        if (sl >= sMin && good) { H[col * W + (sl >> 5)] |= 1 << (sl & 31); hang++; any = true; }
      }
      if (any) cols++;
    }
    // 5. по двум направлениям плана
    var list = [], segs = 0, clutter = 0, grille = 0;
    for (var dir = 0; dir < 2; dir++) {
      var L1 = dir === 0 ? na : nb, L2 = dir === 0 ? nb : na, nk = Math.floor(L1 / segC), P = new Uint8Array(L2 * ns);
      var colOf = dir === 0 ? function (a, c2) { return c2 * na + a; } : function (a, c2) { return a * na + c2; };
      var runs = [], open = [];
      for (k = 0; k < nk; k++) {
        P.fill(0);
        var iA = k * segC, iB = iA + segC;
        for (var al = iA; al < iB; al++) for (var cr = 0; cr < L2; cr++) {
          col = colOf(al, cr);
          for (w = 0; w < W; w++) { var bits = H[col * W + w]; while (bits) { var t = bitTop(bits); bits &= ~(1 << t); var sx = w * 32 + t; if (sx < ns) P[cr * ns + sx]++; } }
        }
        if (o.debugP && o.debugP(dir, acc.a0 + (iA + segC / 2) * cell, acc.b0 + (iA + segC / 2) * cell)) o.debugPush({ dir: dir, k: k, L2: L2, ns: ns, need: need, P: Array.from(P) });
        // устойчивые клетки → пятна (8-связность)
        // сечение → вертикальные отрезки (столбец j, низ, верх); соседние столбцы сцепляются по низу (разница до одной клетки):
        // ярусы подвеса (лоток под трубами), соседние ряды и косые провода в просвете не слипаются, а короб, видный снизу
        // и с боков, лоток с бортами, ряд труб — одно пятно
        var comps = pieces(P, L2, ns, need);        var keep = [];
        comps.forEach(function (cp) {
          if (cp.n < 2 || (cp.j1 - cp.j0 + 1) * cell > maxWidth) return;
          // край потолка: у соседней колонки (за краем пятна) верх на уровне пятна — продолжение потолка, не элемент
          var edge = 0;
          [cp.j0 - 1, cp.j1 + 1].forEach(function (jn) {
            if (jn < 0 || jn >= L2) return; var hit = 0, tot = 0;
            for (var a2 = iA; a2 < iB; a2++) { var cn = colOf(a2, jn), tq = top[cn]; if (tq < 0) continue; tot++; if (tq >= cp.s0 - 1 && tq <= cp.s1 + 1) hit++; }
            if (tot && hit >= 0.5 * (iB - iA)) edge++;
          });
          if (o.debug) o.debug.push({ dir: dir, k: k, j0: cp.j0, j1: cp.j1, s0: cp.s0, s1: cp.s1, n: cp.n, edge: edge });
          if (edge) return;
          cp.k = k; keep.push(cp);
        });
        segs += keep.length;
        // сшивка с отрезками k − 1 и k − 2 (пропуск одного отрезка — спринклер, подвес)
        var used = new Set();
        keep.forEach(function (cp) {
          var best = -1, bo = 0;
          for (var r = 0; r < open.length; r++) {
            var ru = open[r]; if (used.has(r)) continue; var lc = ru.last; if (k - lc.k > 2) continue;
            var oj = Math.min(cp.j1, lc.j1) - Math.max(cp.j0, lc.j0) + 1, os = Math.min(cp.s1, lc.s1 + 1) - Math.max(cp.s0, lc.s0 - 1) + 1;
            if (oj < 1 || os < 1) continue; var sc = oj * os; if (sc > bo) { bo = sc; best = r; }
          }
          if (best >= 0) { used.add(best); open[best].parts.push(cp); open[best].last = cp; }
          else { var nr = { dir: dir, parts: [cp], last: cp }; open.push(nr); used.add(open.length - 1); }
        });
        // закрыть отставшие
        for (var r2 = open.length - 1; r2 >= 0; r2--) if (k - open[r2].last.k > 2) { runs.push(open[r2]); open.splice(r2, 1); }
      }
      runs = runs.concat(open);
      runs.forEach(function (ru) {
        var p = ru.parts, k0 = p[0].k, k1 = p[p.length - 1].k;
        if ((k1 - k0 + 1) * segC * cell < minLen - 1e-9) return;
        var el = { dir: dir, j0: Math.round(median(p.map(function (x) { return x.j0; }))), j1: Math.round(median(p.map(function (x) { return x.j1; }))),
          s0: Math.round(median(p.map(function (x) { return x.s0; }))), s1: Math.round(median(p.map(function (x) { return x.s1; }))), i0: k0 * segC, i1: (k1 + 1) * segC - 1, parts: p.length };
        if (el.j1 < el.j0) el.j1 = el.j0; if (el.s1 < el.s0) el.s1 = el.s0;
        // концы: по вокселям сечения, шаг клетки
        var cnt = function (a3) { var c3 = 0; for (var jj = el.j0; jj <= el.j1; jj++) { var cn = colOf(a3, jj); for (var ss = el.s0; ss <= el.s1; ss++) if (H[cn * W + (ss >> 5)] & (1 << (ss & 31))) c3++; } return c3; };
        var vals = []; for (var a4 = el.i0; a4 <= el.i1; a4++) vals.push(cnt(a4));
        var typ = Math.max(1, median(vals)), thr = Math.max(1, 0.35 * typ);
        while (el.i0 < el.i1 && cnt(el.i0) < thr) el.i0++;
        while (el.i1 > el.i0 && cnt(el.i1) < thr) el.i1--;
        var miss = 0; while (el.i0 > 0 && miss < 2) { if (cnt(el.i0 - 1) >= thr) { el.i0--; miss = 0; } else if (el.i0 > 1 && cnt(el.i0 - 2) >= thr) { el.i0 -= 2; miss = 0; } else miss = 9; }
        miss = 0; while (el.i1 < L1 - 1 && miss < 2) { if (cnt(el.i1 + 1) >= thr) { el.i1++; miss = 0; } else if (el.i1 < L1 - 2 && cnt(el.i1 + 2) >= thr) { el.i1 += 2; miss = 0; } else miss = 9; }
        if ((el.i1 - el.i0 + 1) * cell < minLen - 1e-9) return;
        // потолок и касание
        var cl = []; for (var a5 = el.i0; a5 <= el.i1; a5 += 2) for (var j5 = el.j0; j5 <= el.j1; j5++) { var ia5 = dir === 0 ? a5 : j5, ib5 = dir === 0 ? j5 : a5, cv = ceilOf(ia5, ib5); if (cv >= 0) cl.push(cv); }
        var cs2 = cl.length ? median(cl) : ns - 1;
        el.ceilS = cs2; el.touch = el.s1 >= cs2 - gapS - 1;
        el.vox = 0; for (var a6 = el.i0; a6 <= el.i1; a6++) el.vox += cnt(a6);
        // по сторонам на высоте элемента: доля занятых колонок в полосах 0,1–0,5 м слева и справа (крона, решётка — занято с обеих сторон)
        var sideOf = function (jA, jB) {
          var occ = 0, tot = 0;
          for (var a7 = el.i0; a7 <= el.i1; a7++) for (var j7 = Math.max(0, jA); j7 <= Math.min(L2 - 1, jB); j7++) {
            var cn7 = colOf(a7, j7), hit7 = 0; tot++;
            for (var s7 = el.s0; s7 <= el.s1 && !hit7; s7++) if (solid[cn7 * W + (s7 >> 5)] & (1 << (s7 & 31))) hit7 = 1;
            occ += hit7;
          }
          return tot ? occ / tot : 0;
        };
        var sw = Math.max(2, Math.round(0.4 / cell)), sg = Math.max(1, Math.round(0.1 / cell));
        el.side = [sideOf(el.j0 - sg - sw, el.j0 - sg - 1), sideOf(el.j1 + sg + 1, el.j1 + sg + sw)];
        if (el.side[0] + el.side[1] >= (o.sideMax || 0.8)) { clutter++; return; }
        list.push(el);
      });
    }
    // 5а. дубли одного направления: сечения перекрываются (от 60 % меньшего) на половине длины — остаётся элемент с большим числом вокселей
    list.sort(function (x, y) { return y.vox - x.vox; });
    var kept = [];
    list.forEach(function (el) {
      var area = (el.j1 - el.j0 + 1) * (el.s1 - el.s0 + 1), host = null;
      kept.some(function (f) {
        if (f.dir !== el.dir) return false;
        var oi = Math.min(el.i1, f.i1) - Math.max(el.i0, f.i0) + 1; if (oi < 0.5 * Math.min(el.i1 - el.i0 + 1, f.i1 - f.i0 + 1)) return false;
        var oj = Math.min(el.j1, f.j1) - Math.max(el.j0, f.j0) + 1, os = Math.min(el.s1, f.s1) - Math.max(el.s0, f.s0) + 1; if (oj < 1 || os < 1) return false;
        var fa = (f.j1 - f.j0 + 1) * (f.s1 - f.s0 + 1), inter = oj * os;
        if (inter < 0.6 * Math.min(area, fa)) return false;
        host = f; if (inter >= 0.5 * Math.max(area, fa)) { f.i0 = Math.min(f.i0, el.i0); f.i1 = Math.max(f.i1, el.i1); }
        return true;
      });
      if (!host) kept.push(el);
    });
    list = kept;
    // 6. в координаты плана
    var out = list.map(function (el) {
      var th = acc.phi + (el.dir ? Math.PI / 2 : 0), crossC, t0, t1;
      // вдоль (t) и поперёк (q) в рамке элемента: dir 0 — t = a, q = b; dir 1 — t = b, q = −a
      if (el.dir === 0) { t0 = acc.a0 + el.i0 * cell; t1 = acc.a0 + (el.i1 + 1) * cell; crossC = acc.b0 + (el.j0 + el.j1 + 1) / 2 * cell; }
      else { t0 = acc.b0 + el.i0 * cell; t1 = acc.b0 + (el.i1 + 1) * cell; crossC = -(acc.a0 + (el.j0 + el.j1 + 1) / 2 * cell); }
      var ct = Math.cos(th), st2 = Math.sin(th), P0 = [t0 * ct - crossC * st2, t0 * st2 + crossC * ct], P1 = [t1 * ct - crossC * st2, t1 * st2 + crossC * ct];
      var bottom = z0 + el.s0 * dz, topZ = z0 + (el.s1 + 1) * dz, ceil = z0 + el.ceilS * dz;
      var width = (el.j1 - el.j0 + 1) * cell, e = { dir: el.dir, th: th, t0: t0, t1: t1, q: crossC, a: P0, b: P1, length: t1 - t0, width: width, bottom: bottom, top: el.touch ? ceil : topZ,
        ceiling: ceil, touch: el.touch, vox: el.vox, side: el.side, src: 'grid' };
      e.depth = e.top - e.bottom;
      e.kind = el.touch && width >= 0.1 ? 'beam' : width <= 0.3 && e.depth >= 0.4 * width ? 'pipe' : e.depth <= 0.15 ? 'tray' : 'duct';
      if (e.kind === 'pipe') e.d = width;
      return e;
    });
    // вертикальные пластины (уступ потолка, торец короба): узкие и глубокие — не элементы
    if (o.debug) out.forEach(function (e) { o.debug.push({ el: true, dir: e.dir, kind: e.kind, length: e.length, width: e.width, depth: e.depth, bottom: e.bottom }); });
    out = out.filter(function (e) { return !(e.width <= 0.1 + 1e-9 && e.depth >= 0.3); });
    var gr0 = dropGrille(out, { cell: cell }); out = gr0.list; grille = gr0.n;
    // дубли по двум направлениям (квадратные пятна до 1,2 м): оставляется более длинный
    out.sort(function (x, y) { return y.length - x.length; });
    var res = [];
    out.forEach(function (e) {
      var bb = rectAB(e), dup = res.some(function (f) { if (f.dir === e.dir) return false; var b2 = rectAB(f), ix = Math.min(bb[2], b2[2]) - Math.max(bb[0], b2[0]), iy = Math.min(bb[3], b2[3]) - Math.max(bb[1], b2[1]); return ix > 0 && iy > 0 && ix * iy > 0.5 * (bb[2] - bb[0]) * (bb[3] - bb[1]) && Math.min(e.top, f.top) > Math.max(e.bottom, f.bottom); });
      if (!dup) res.push(e); else if (o.debug) o.debug.push({ dup: true, kind: e.kind, length: e.length, a: e.a, b: e.b });
    });
    res.forEach(function (e, n) { e.id = n + 1; clearOf(e, floor, floorAt, o.clear); });
    // потолок: высоты квадратов (75-й процентиль верха), 0,5 м — для классов точек и подписи
    var ceilH = new Float32Array(ga * gb).fill(NaN); for (k = 0; k < ga * gb; k++) if (blk[k] >= 0) ceilH[k] = z0 + (blk[k] + 1) * dz;
    var cz = [], nRej = 0; for (k = 0; k < ga * gb; k++) { if (blk[k] >= 0) cz.push(ceilH[k]); else if (blkQ[k] > 0) nRej++; }
    return { ok: true, list: res, ceiling: { phi: acc.phi, a0: acc.a0, b0: acc.b0, cell: B * cell, nx: ga, ny: gb, h: ceilH, median: cz.length ? median(cz) : NaN },
      stats: { cell: cell, dz: dz, columns: N, hangVox: hang, hangCols: cols, segs: segs, points: acc.count(), minBottom: minBottom, ceilBlocks: cz.length, ceilRejected: nRej, clutter: clutter, grille: grille } };
  }
  // решётка, ограждение, переплёт: три и больше тонких прута одно над другим (та же ось в плане, перекрытие по длине от половины,
  // низ отличается от 0,15 м) — не трубы. Номера и пучки пересчитываются.
  function dropGrille(list, o) {
    o = o || {};
    var cell = o.cell || 0.05, thin = Math.max(0.12, 1.5 * cell), tolQ = Math.max(0.1, 1.5 * cell);
    var isThin = function (e) { return e.width <= thin + 1e-9 && (e.depth != null ? e.depth : e.top - e.bottom) <= thin + 1e-9; };
    var ax = list.map(function (e) {
      var c = Math.cos(e.th), s = Math.sin(e.th), ta = e.a[0] * c + e.a[1] * s, tb = e.b[0] * c + e.b[1] * s;
      return { t0: Math.min(ta, tb), t1: Math.max(ta, tb), q: (-e.a[0] * s + e.a[1] * c - e.b[0] * s + e.b[1] * c) / 2, c: c, s: s };
    });
    var drop = list.map(function (e, i) {
      if (!isThin(e)) return false; var hs = [e.bottom], A = ax[i];
      list.forEach(function (f, k) {
        if (k === i || f.dir !== e.dir || !isThin(f)) return;
        var B = ax[k], qf = (-f.a[0] * A.s + f.a[1] * A.c - f.b[0] * A.s + f.b[1] * A.c) / 2; if (Math.abs(qf - A.q) > tolQ) return;
        var ov = Math.min(A.t1, B.t1) - Math.max(A.t0, B.t0); if (ov < 0.5 * Math.min(A.t1 - A.t0, B.t1 - B.t0)) return;
        if (hs.every(function (h) { return Math.abs(h - f.bottom) >= 0.15; })) hs.push(f.bottom);
      });
      return hs.length >= 3;
    });
    var n = drop.filter(Boolean).length; if (!n) return { list: list, n: 0 };
    var res = list.filter(function (e, i) { return !drop[i]; });
    if (res.some(function (e) { return e.id != null; })) {
      var gc = {}; res.forEach(function (e) { if (e.group) gc[e.group] = (gc[e.group] || 0) + 1; });
      res.forEach(function (e, k) { e.id = k + 1; if (e.group) { if (gc[e.group] < 2) { delete e.group; delete e.groupN; } else e.groupN = gc[e.group]; } });
    }
    return { list: res, n: n };
  }
  // прямоугольник элемента в рамке плана (a, b): элементы идут по направлениям плана
  function rectAB(e) { var h = e.width / 2; return e.dir === 0 ? [e.t0, e.q - h, e.t1, e.q + h] : [-e.q - h, e.t0, -e.q + h, e.t1]; }
  function boxUV(e) { var hw = e.width / 2, nx = -Math.sin(e.th) * hw, ny = Math.cos(e.th) * hw, xs = [e.a[0] + nx, e.a[0] - nx, e.b[0] + nx, e.b[0] - nx], ys = [e.a[1] + ny, e.a[1] - ny, e.b[1] + ny, e.b[1] - ny]; return [Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs), Math.max.apply(null, ys)]; }
  function clearOf(e, floor, floorAt, lim) {
    var f = floor;
    if (floorAt) { var zs = []; [0.1, 0.5, 0.9].forEach(function (t) { var v = floorAt(e.a[0] + (e.b[0] - e.a[0]) * t, e.a[1] + (e.b[1] - e.a[1]) * t); if (v === v) zs.push(v); }); if (zs.length) f = median(zs); }
    e.floorH = f; e.clear = e.bottom - f; e.warn = e.clear < (lim || 2.0);
  }

  // ---------------------------------------------------------------- второй проход: точное сечение
  // по каждому элементу — сетка «поперёк × высота» 1 см (число точек) и покрытие по длине (полосы 10 см) для каждого столбца сечения:
  // столбец, занятый меньше чем на половине длины, — чужой (перекрёстный лоток, подвес), в сечение не идёт
  function refineAccRaw(list, o) {
    o = o || {};
    var res = o.res || 0.01, m = 0.05, G = 1, TB = 0.1, cells = new Map(), grids = list.map(function (e, idx) {
      var w = e.width + 2 * m, zTop = Math.min(e.top + m, e.ceiling - 0.03), h = Math.max(0.05, zTop - (e.bottom - m)), r = Math.max(res, Math.max(w, h) / 220), nq = Math.ceil(w / r), nz = Math.ceil(h / r);
      var nt = Math.max(1, Math.ceil((e.t1 - e.t0) / TB));
      var bb = boxUV(e); for (var gx = Math.floor((bb[0] - m) / G); gx <= Math.floor((bb[2] + m) / G); gx++) for (var gy = Math.floor((bb[1] - m) / G); gy <= Math.floor((bb[3] + m) / G); gy++) {
        var key = gx + ',' + gy, a = cells.get(key); if (!a) cells.set(key, a = []); a.push(idx);
      }
      return { r: r, nq: nq, nz: nz, nt: nt, q0: e.q - e.width / 2 - m, z0: e.bottom - m, z1: e.bottom - m + nz * r, t0: e.t0, t1: e.t1, c: Math.cos(e.th), s: Math.sin(e.th),
        cnt: new Uint32Array(nq * nz), cov: new Uint8Array(nq * nt), n: 0 };
    });
    var zLo = Infinity, zHi = -Infinity; grids.forEach(function (g) { if (g.z0 < zLo) zLo = g.z0; if (g.z1 > zHi) zHi = g.z1; });
    return {
      grids: grids, h0: zLo, h1: zHi,
      add: function (u, v, h) {
        var a = cells.get(Math.floor(u / G) + ',' + Math.floor(v / G)); if (!a) return;
        for (var x = 0; x < a.length; x++) {
          var g = grids[a[x]]; if (h < g.z0 || h >= g.z1) continue;
          var t = u * g.c + v * g.s; if (t < g.t0 || t >= g.t1) continue;
          var iq = Math.floor((-u * g.s + v * g.c - g.q0) / g.r); if (iq < 0 || iq >= g.nq) continue;
          var iz = Math.floor((h - g.z0) / g.r); if (iz >= g.nz) continue;
          g.cnt[iq * g.nz + iz]++; g.n++;
          var it = Math.floor((t - g.t0) / TB); if (it >= g.nt) it = g.nt - 1; g.cov[iq * g.nt + it] = 1;
        }
      }
    };
  }
  // окружность по точкам (МНК Каса, веса) → { qc, zc, r, rms }
  function circleFit(P) {
    var n = P.length; if (n < 4) return null;
    var sw = 0, mx = 0, my = 0, i, w; for (i = 0; i < n; i++) { w = P[i][2] || 1; sw += w; mx += w * P[i][0]; my += w * P[i][1]; } mx /= sw; my /= sw;
    var Suu = 0, Svv = 0, Suv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
    for (i = 0; i < n; i++) { w = P[i][2] || 1; var u = P[i][0] - mx, v = P[i][1] - my; Suu += w * u * u; Svv += w * v * v; Suv += w * u * v; Suuu += w * u * u * u; Svvv += w * v * v * v; Suvv += w * u * v * v; Svuu += w * v * u * u; }
    var det = Suu * Svv - Suv * Suv; if (Math.abs(det) < 1e-18) return null;
    var b1 = 0.5 * (Suuu + Suvv), b2 = 0.5 * (Svvv + Svuu), uc = (b1 * Svv - b2 * Suv) / det, vc = (Suu * b2 - Suv * b1) / det;
    var r = Math.sqrt(uc * uc + vc * vc + (Suu + Svv) / sw), e2 = 0;
    for (i = 0; i < n; i++) { w = P[i][2] || 1; var d = Math.hypot(P[i][0] - mx - uc, P[i][1] - my - vc) - r; e2 += w * d * d; }
    return { qc: uc + mx, zc: vc + my, r: r, rms: Math.sqrt(e2 / sw) };
  }
  // труба: окружность по занятым клеткам сечения; ширина и подъём краёв согласуются с радиусом, разброс мал
  function roundFit(cellsP, width, cellR) {
    var f = circleFit(cellsP); if (!f) return null;
    var zs = cellsP.map(function (p) { return p[1]; }), zmin = Math.min.apply(null, zs), rise = Math.max.apply(null, zs) - zmin;
    var shape = f.r >= 0.012 && f.r <= 0.4 && Math.abs(2 * f.r - width) <= Math.max(0.03, 0.35 * width) && rise >= 0.3 * f.r && f.zc > zmin;
    // шум облака SLAM 5–10 мм: строго — СКО до 6 мм или 22 % радиуса; в пучке рядом со строгими — до 40 % радиуса
    f.ok = shape && f.rms <= Math.max(0.006, 0.45 * cellR, Math.min(0.22 * f.r, 0.01));
    f.loose = shape && f.rms <= Math.max(0.006, 0.45 * cellR, Math.min(0.4 * f.r, 0.016));
    return f;
  }
  function refineRaw(list, racc, o) {
    o = o || {};
    var out = [];
    list.forEach(function (e, idx) {
      var g = racc && racc.grids[idx];
      if (!g || g.n < 30) { e.src = 'grid'; out.push(e); return; }
      var nz = g.nz, nq = g.nq, cnt = g.cnt, q, z, k;
      // столбцы, занятые по длине не меньше чем наполовину
      var okq = new Uint8Array(nq), covs = [];
      for (q = 0; q < nq; q++) { var cv = 0; for (k = 0; k < g.nt; k++) cv += g.cov[q * g.nt + k]; covs.push(cv / g.nt); okq[q] = cv >= 0.5 * g.nt ? 1 : 0; }
      var nzv = []; for (q = 0; q < nq; q++) if (okq[q]) for (z = 0; z < nz; z++) if (cnt[q * nz + z]) nzv.push(cnt[q * nz + z]);
      if (nzv.length < 6) { e.src = 'grid'; out.push(e); return; }
      var p90 = pct(nzv, 0.9), thr = Math.max(2, (o.thrLow || 0.04) * p90), thrTop = Math.max(thr, 0.15 * p90);
      var zb = new Float64Array(nq).fill(NaN), qa = -1, qb = -1, ztop = -Infinity;
      for (q = 0; q < nq; q++) {
        if (!okq[q]) continue;
        for (z = 0; z < nz; z++) if (cnt[q * nz + z] >= thr) { zb[q] = g.z0 + (z + 0.5) * g.r; break; }
        for (z = nz - 1; z >= 0; z--) if (cnt[q * nz + z] >= thrTop) { var zz = g.z0 + (z + 1) * g.r; if (zz > ztop) ztop = zz; break; }
        if (zb[q] === zb[q]) { if (qa < 0) qa = q; qb = q; }
      }
      if (qa < 0) { e.src = 'grid'; out.push(e); return; }
      var qOf = function (q2) { return g.q0 + (q2 + 0.5) * g.r; };
      // для окружности — только нижняя видимая оболочка: в каждом столбце первый занятый отрезок снизу (пропуск до 2 клеток),
      // провода и лотки выше трубы в том же столбце не мешают
      var cellsIn = function (qq0, qq1) {
        var P = [];
        for (var x = qq0; x <= qq1; x++) {
          if (!okq[x]) continue; var y = 0, miss = 0; while (y < nz && cnt[x * nz + y] < thr) y++;
          for (; y < nz && miss <= 2; y++) { var cy = cnt[x * nz + y]; if (cy >= thr) { miss = 0; P.push([qOf(x), g.z0 + (y + 0.5) * g.r, Math.min(cy, p90)]); } else miss++; }
        }
        return P;
      };
      var prof = []; for (q = qa; q <= qb; q++) if (zb[q] === zb[q]) prof.push([qOf(q), zb[q], q]);
      var wf = (qb - qa + 1) * g.r, zBot = pct(prof.map(function (p) { return p[1]; }), 0.03) - g.r / 2;
      e.src = 'points'; e.pts = g.n;
      // пучок: разрывы и местные вершины нижнего профиля (между трубами профиль поднимается)
      var parts = splitProfile(prof, g.r), pipes = [];
      var fits = [];
      if (parts.length >= 2) parts.forEach(function (pp) { var q0 = pp[0][2], q1 = pp[pp.length - 1][2], wpp = (q1 - q0 + 1) * g.r, f = roundFit(cellsIn(q0, q1), wpp, g.r); if (o.debug) fits.push(f && [+(2 * f.r).toFixed(3), +(f.rms * 1000).toFixed(1), f.ok, +wpp.toFixed(2), +(-f.qc).toFixed(2)]); if (f && f.loose) pipes.push({ f: f, w: wpp }); });
      if (pipes.filter(function (p) { return p.f.ok; }).length < 2) pipes = pipes.filter(function (p) { return p.f.ok; });
      var cover = pipes.reduce(function (s2, p) { return s2 + p.w; }, 0);
      if (o.debug) o.debug.push({ p: e._p, c: e._c, q: e.q, w: e.width, wf: wf, zBot: zBot, prof: prof.map(function (x) { return [+x[0].toFixed(3), +x[1].toFixed(3)]; }), parts: parts.length, fits: fits, pipes: pipes.length, cover: cover, nq: nq, okq: Array.from(okq).join('') });
      if (pipes.length >= 2 && cover >= 0.5 * wf) {
        pipes.forEach(function (p) {
          var d = 2 * p.f.r, c = Object.assign({}, e, { kind: 'pipe', d: d, width: d, q: p.f.qc, bottom: p.f.zc - p.f.r, top: p.f.zc + p.f.r, center: p.f.zc, rms: p.f.rms, group: e.id, groupN: pipes.length, src: 'points' });
          delete c.shape; c.depth = d; c.touch = false; c.a = axisAt(c, c.t0); c.b = axisAt(c, c.t1); clearOf(c, e.floorH, o.floorAt, o.clear); out.push(c);
        });
        return;
      }
      e.parts = parts.bumps || 0;
      var fit = roundFit(cellsIn(qa, qb), wf, g.r);
      if (fit && fit.ok) {
        var d2 = 2 * fit.r; e.d = d2; e.width = d2; e.q = fit.qc; e.bottom = fit.zc - fit.r; e.top = fit.zc + fit.r; e.center = fit.zc; e.depth = d2; e.rms = fit.rms;
        e.kind = d2 < 0.2 ? 'pipe' : 'duct'; if (e.kind === 'duct') e.shape = 'round';
      } else {
        var mid = prof.filter(function (p) { return p[0] >= qOf(qa) + 0.1 * wf && p[0] <= qOf(qb) - 0.1 * wf; }), mz = (mid.length >= 3 ? mid : prof).map(function (p) { return p[1]; });
        e.flat = pct(mz, 0.8) - pct(mz, 0.2) <= Math.max(0.012, 0.04 * wf);
        // у потолка: бока доходят до перекрытия (балка); лоток в 5–15 см под перекрытием — не касается
        e.touch = ztop >= e.ceiling - 0.05;
        e.width = wf; e.q = (qOf(qa) + qOf(qb)) / 2; e.bottom = zBot; e.top = e.touch ? e.ceiling : Math.max(ztop, zBot + g.r); e.depth = e.top - e.bottom;
        e.kind = e.touch && e.depth >= 0.06 && wf >= 0.1 ? 'beam' : e.depth <= 0.15 && wf >= 0.08 ? 'tray' : wf <= 0.12 ? 'pipe' : 'duct';
        if (e.kind === 'pipe') { e.d = wf; e.center = e.bottom + wf / 2; } else delete e.d;
        if (e.kind === 'duct') e.shape = 'rect'; else delete e.shape;
      }
      e.a = axisAt(e, e.t0); e.b = axisAt(e, e.t1); clearOf(e, e.floorH, o.floorAt, o.clear);
      out.push(e);
    });
    out.forEach(function (e, n) { e.id = n + 1; });
    return out;
  }
  // ---------------------------------------------------------------- уточнение кусками
  // ось длинного элемента не строго параллельна направлению плана (1° — 5 см на 3 м), трубы провисают и идут с уклоном:
  // сечение уточняется кусками по 1 м,
  // куски одного элемента сшиваются обратно (ось — по фактическому положению концов, низ — наименьший)
  function refineAcc(list, o) {
    o = o || {};
    var CH = o.chunk || 1, chunks = [];
    list.forEach(function (e, idx) {
      var n = e.length > CH * 1.34 ? Math.ceil(e.length / CH) : 1, L = e.length / n;
      for (var c = 0; c < n; c++) {
        var t0 = e.t0 + c * L, t1 = c === n - 1 ? e.t1 : e.t0 + (c + 1) * L;
        chunks.push(Object.assign({}, e, { t0: t0, t1: t1, length: t1 - t0, a: axisAt(e, t0), b: axisAt(e, t1), _p: idx, _c: c, _n: n }));
      }
    });
    var r = refineAccRaw(chunks, o); r.chunks = chunks; return r;
  }
  function refine(list, racc, o) {
    o = o || {};
    if (!racc || !racc.chunks) return refineRaw(list, racc, o);
    var items = refineRaw(racc.chunks, racc, o), byP = new Map();
    items.forEach(function (it) { var a = byP.get(it._p); if (!a) byP.set(it._p, a = []); a.push(it); });
    var out = [];
    list.forEach(function (e, idx) {
      var its = (byP.get(idx) || []).sort(function (x, y) { return x._c - y._c; }), tracks = [], bundle = 0;
      // куски, где сечение — трубы, против кусков-прямоугольников: по большинству длины; пропуски труб до трёх кусков
      var lenP = {}, lenAll = {};
      its.forEach(function (it) { var li = it.t1 - it.t0; lenAll[it._c] = li; if (it.kind === 'pipe') lenP[it._c] = li; });
      var sumP = 0, sumA = 0; Object.keys(lenAll).forEach(function (c) { sumA += lenAll[c]; if (lenP[c]) sumP += lenP[c]; });
      var pipeMode = sumP >= 0.5 * sumA;
      its = its.filter(function (it) { return (it.kind === 'pipe') === pipeMode; });
      its.forEach(function (it) {
        var best = null, bs = Infinity, pipe = it.kind === 'pipe';
        tracks.forEach(function (tr) {
          var l = tr[tr.length - 1]; if (l._c === it._c || it._c - l._c > (pipe ? 4 : 2) || (l.kind === 'pipe') !== pipe) return;
          var dq = Math.abs(l.q - it.q), db = Math.abs(l.bottom - it.bottom), rw = Math.min(l.width, it.width) / Math.max(l.width, it.width);
          if (dq > Math.max(0.06, 0.5 * Math.max(l.width, it.width)) || db > 0.08 || rw < 0.6) return;
          if (dq + db < bs) { bs = dq + db; best = tr; }
        });
        if (best) best.push(it); else tracks.push([it]);
      });
      tracks.forEach(function (tr) {
        var f = tr[0], l = tr[tr.length - 1], m = Object.assign({}, f), L = 0, w = 0, dp = 0, dd = 0, rm = 0, kinds = {};
        tr.forEach(function (it) { var li = it.t1 - it.t0; L += li; w += it.width * li; dp += it.depth * li; if (it.d) dd += it.d * li; if (it.rms) rm += it.rms * li; kinds[it.kind] = (kinds[it.kind] || 0) + li; });
        m.kind = Object.keys(kinds).sort(function (x, y) { return kinds[y] - kinds[x]; })[0];
        m.a = f.a; m.b = l.b; m.th = Math.atan2(l.b[1] - f.a[1], l.b[0] - f.a[0]);
        var c = Math.cos(m.th), s = Math.sin(m.th); m.t0 = m.a[0] * c + m.a[1] * s; m.t1 = m.b[0] * c + m.b[1] * s; m.q = -m.a[0] * s + m.a[1] * c; m.length = m.t1 - m.t0;
        if (m.length < 1 - 1e-9) return;
        // низ — 20-й процентиль кусков по длине (один кусок с проводом или подвесом не тянет вниз весь элемент)
        var bs2 = tr.map(function (it) { return [it.bottom, it.t1 - it.t0]; }).sort(function (x, y) { return x[0] - y[0]; }), acc2 = 0;
        m.width = w / L; m.depth = dp / L; m.bottom = bs2[0][0];
        for (var bi = 0; bi < bs2.length; bi++) { acc2 += bs2[bi][1]; if (acc2 >= 0.2 * L) { m.bottom = bs2[bi][0]; break; } }
        // ряд местных вершин нижнего профиля (3 и больше в большинстве кусков), а окружности не сходятся — пучок труб или кабелей
        var pm = median(tr.map(function (it) { return it.parts || 0; }));
        if (m.kind !== 'pipe' && m.kind !== 'beam' && m.shape !== 'round' && pm >= 3 && m.width >= 0.3) { m.kind = 'rack'; delete m.shape; }
        m.touch = tr.some(function (it) { return it.touch; }) && m.kind === 'beam';
        m.top = m.touch ? m.ceiling : m.bottom + m.depth;
        if (m.kind === 'pipe' || m.shape === 'round') { m.d = dd / L || m.width; m.width = m.d; m.depth = m.d; m.top = m.bottom + m.d; m.center = m.bottom + m.d / 2; } else delete m.d;
        if (rm) m.rms = rm / L;
        m.pts = tr.reduce(function (a2, it) { return a2 + (it.pts || 0); }, 0); m.vox = e.vox;
        m.chunks = tr.length; m.dir = e.dir;
        m._g = tr.some(function (it) { return it.group; });
        delete m._c; delete m._n; delete m.group; delete m.groupN;
        clearOf(m, e.floorH, o.floorAt, o.clear);
        out.push(m);
      });
      var g = out.filter(function (m) { return m._p === idx && m._g && m.kind === 'pipe'; });
      if (g.length >= 2) { bundle = idx + 1; g.forEach(function (m) { m.group = bundle; m.groupN = g.length; }); }
    });
    // дубли одного направления после уточнения: сечения (поперёк × высота) перекрываются от 40 % меньшего на половине длины
    // (элементы внутри трассы, найденные вторым ярусом, не считаются дважды)
    out.sort(function (x, y) { return (y.pts || 0) - (x.pts || 0) || y.length - x.length; });
    var res = [];
    out.forEach(function (e) {
      var dup = res.some(function (f) {
        if (f.dir !== e.dir) return false;
        var c = Math.cos(f.th), s = Math.sin(f.th), ta = e.a[0] * c + e.a[1] * s, tb = e.b[0] * c + e.b[1] * s, qa = -e.a[0] * s + e.a[1] * c, qb = -e.b[0] * s + e.b[1] * c;
        var t0 = Math.min(ta, tb), t1 = Math.max(ta, tb), ot = Math.min(t1, f.t1) - Math.max(t0, f.t0); if (ot < 0.5 * Math.min(t1 - t0, f.length)) return false;
        var q = (qa + qb) / 2, oq = Math.min(q + e.width / 2, f.q + f.width / 2) - Math.max(q - e.width / 2, f.q - f.width / 2), oz = Math.min(e.top, f.top) - Math.max(e.bottom, f.bottom);
        return oq > 0 && oz > 0 && oq * oz >= 0.4 * Math.min(e.width * (e.top - e.bottom), f.width * (f.top - f.bottom));
      });
      if (!dup) res.push(e);
    });
    var gmap = {}, gn = 0;
    res.sort(function (x, y) { return y.length - x.length; });
    res.forEach(function (e) { if (e.group) { if (!gmap[e.group]) gmap[e.group] = ++gn; e.group = gmap[e.group]; } });
    // число труб пучка — после удаления дублей
    var gc = {}; res.forEach(function (e) { if (e.group) gc[e.group] = (gc[e.group] || 0) + 1; });
    res.forEach(function (e, n) { e.id = n + 1; delete e._p; delete e._g; if (e.group) { if (gc[e.group] < 2) { delete e.group; delete e.groupN; } else e.groupN = gc[e.group]; } });
    return res;
  }
  function axisAt(e, t) { var c = Math.cos(e.th), s = Math.sin(e.th); return [t * c - e.q * s, t * s + e.q * c]; }
  function splitProfile(prof, r) {
    var parts = [], cur = [], i;
    var sm = prof.map(function (p, k) { var a = []; for (var j = Math.max(0, k - 1); j <= Math.min(prof.length - 1, k + 1); j++) a.push(prof[j][1]); return median(a); });
    var cut = new Uint8Array(prof.length);
    for (i = 2; i < prof.length - 2; i++) {
      if (!(sm[i] >= sm[i - 1] && sm[i] >= sm[i + 1])) continue;
      var lm = Infinity, rm = Infinity; for (var j = Math.max(0, i - 15); j < i; j++) lm = Math.min(lm, sm[j]); for (j = i + 1; j <= Math.min(prof.length - 1, i + 15); j++) rm = Math.min(rm, sm[j]);
      if (sm[i] - lm >= 0.012 && sm[i] - rm >= 0.012) cut[i] = 1;
    }
    for (i = 0; i < prof.length; i++) {
      if (i > 0 && (prof[i][2] - prof[i - 1][2] > 1 || cut[i])) { if (cur.length) parts.push(cur); cur = []; if (cut[i]) continue; }
      cur.push(prof[i]);
    }
    if (cur.length) parts.push(cur);
    var res = parts.filter(function (p) { return p.length * r >= 0.025; }), nc = 0; for (i = 0; i < cut.length; i++) nc += cut[i];
    res.bumps = nc; return res;
  }

  // ---------------------------------------------------------------- итоги и выгрузка
  function summary(list, o) {
    o = o || {};
    var by = {}, warn = 0, minC = Infinity, diam = {};
    list.forEach(function (e) {
      var b = by[e.kind] || (by[e.kind] = { n: 0, length: 0 }); b.n++; b.length += e.length;
      if (e.warn) warn++; if (e.clear < minC) minC = e.clear;
      if (e.kind === 'pipe' && e.d) { var key = Math.round(e.d * 100) * 10; diam[key] = (diam[key] || 0) + e.length; }
    });
    return { n: list.length, by: by, warn: warn, minClear: minC === Infinity ? NaN : minC, diam: diam, clearLim: o.clear || 2.0 };
  }
  function sizeText(e) {
    var mm = function (x) { return Math.round(x * 1000); };
    return e.kind === 'pipe' || e.shape === 'round' ? 'Ø' + mm(e.d || e.width) : mm(e.width) + '×' + mm(e.depth);
  }
  function csvRows(list, o) {
    o = o || {};
    var c = function (x, d) { return x === x && x != null && isFinite(x) ? (+x).toFixed(d).replace('.', ',') : ''; }, wx = o.origin ? o.origin.cx || 0 : 0, wy = o.origin ? o.origin.cy || 0 : 0, wz = o.origin ? o.origin.cz || 0 : 0;
    var L = ['№;Тип;Размер, мм;Длина, м;Начало X;Начало Y;Конец X;Конец Y;Низ, м;Верх, м;Низ над полом, м;У потолка;Пучок;Замечание'];
    list.forEach(function (e) {
      L.push([e.id, KIND_LONG[e.kind] || e.kind, sizeText(e), c(e.length, 2), c(e.a[0] + wx, 3), c(e.a[1] + wy, 3), c(e.b[0] + wx, 3), c(e.b[1] + wy, 3), c(e.bottom + wz, 3), c(e.top + wz, 3), c(e.clear, 2),
        e.touch ? 'да' : '', e.group ? 'пучок ' + e.group + ' (' + e.groupN + ')' : '', e.warn ? 'низ ниже ' + c(o.clear || 2, 2) + ' м' : ''].join(';'));
    });
    return L;
  }
  var LAYER = { beam: 'S-BEAM', pipe: 'P-PIPE', duct: 'M-DUCT', tray: 'E-TRAY', rack: 'P-RACK' };
  var COLOR = { beam: 30, pipe: 5, duct: 3, tray: 40, rack: 6 };
  function toDxfEntities(list, o) {
    o = o || {};
    var ox = o.origin ? o.origin.cx || 0 : 0, oy = o.origin ? o.origin.cy || 0 : 0, oz = o.origin ? o.origin.cz || 0 : 0, ents = [];
    list.forEach(function (e) {
      var lay = LAYER[e.kind] || 'MEP', col = e.warn ? 1 : COLOR[e.kind] || 7, hw = e.width / 2, nx = -Math.sin(e.th) * hw, ny = Math.cos(e.th) * hw, z = e.bottom + oz;
      var P = function (p, sx, h) { return [p[0] + ox + nx * sx, p[1] + oy + ny * sx, h]; };
      ents.push({ type: 'polyline', layer: lay, color: col, closed: true, points: [P(e.a, 1, z), P(e.b, 1, z), P(e.b, -1, z), P(e.a, -1, z)] });
      var zc = e.kind === 'pipe' ? (e.center != null ? e.center : e.bottom + e.width / 2) + oz : z;
      ents.push({ type: 'line', layer: lay + '-AXIS', color: col, a: P(e.a, 0, zc), b: P(e.b, 0, zc) });
      var mid = P([(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2], 0, z);
      ents.push({ type: 'text', layer: lay + '-TEXT', color: col, p: [mid[0], mid[1], z], h: 0.12,
        text: (e.kind === 'pipe' || e.shape === 'round' ? 'D' + Math.round((e.d || e.width) * 1000) : Math.round(e.width * 1000) + 'x' + Math.round(e.depth * 1000)) + ' H' + e.clear.toFixed(2) });
    });
    return ents;
  }
  // IFC4: IfcBeam, IfcPipeSegment, IfcDuctSegment, IfcCableCarrierSegment — выдавливание прямоугольника или круга вдоль оси
  function toIfc(list, o) {
    o = o || {};
    var id = 0, L = [], nid = function () { return ++id; }, put = function (s) { var k = nid(); L.push('#' + k + '=' + s + ';'); return '#' + k; };
    var f = function (x) { var s = (+x || 0).toFixed(6).replace(/0+$/, ''); return /\.$/.test(s) ? s + '0' : s.indexOf('.') < 0 ? s + '.' : s; };
    var str = function (s) { return "'" + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[^\x20-\x7e]/g, function (ch) { var h = ch.charCodeAt(0).toString(16).toUpperCase(); while (h.length < 4) h = '0' + h; return '\\X2\\' + h + '\\X0\\'; }) + "'"; };
    var seed = o.seed || 1, rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    var CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$', gid = function () { var s = CH[Math.floor(rnd() * 4)]; for (var i = 1; i < 22; i++) s += CH[Math.floor(rnd() * 64)]; return "'" + s + "'"; };
    var pt = function (x, y, z) { return put('IFCCARTESIANPOINT((' + f(x) + ',' + f(y) + (z == null ? '' : ',' + f(z)) + '))'); }, dirE = function (x, y, z) { return put('IFCDIRECTION((' + f(x) + ',' + f(y) + (z == null ? '' : ',' + f(z)) + '))'); };
    var org = o.origin || { cx: 0, cy: 0, cz: 0 }, storeyZ = o.storey != null ? +o.storey : 0;
    var p0 = pt(0, 0, 0), zA = dirE(0, 0, 1), xA = dirE(1, 0, 0), wcs = put('IFCAXIS2PLACEMENT3D(' + p0 + ',' + zA + ',' + xA + ')');
    var ctx = put("IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05," + wcs + ',$)');
    var body = put("IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*," + ctx + ",$,.MODEL_VIEW.,$)");
    var uL = put('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)'), uA = put('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)'), uV = put('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)'), uP = put('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)');
    var units = put('IFCUNITASSIGNMENT((' + [uL, uA, uV, uP].join(',') + '))');
    var proj = put('IFCPROJECT(' + gid() + ',$,' + str(o.name || 'BIM Twin — инженерные элементы по облаку') + ',$,$,$,$,(' + ctx + '),' + units + ')');
    var sitePl = put('IFCLOCALPLACEMENT($,' + put('IFCAXIS2PLACEMENT3D(' + pt(org.cx || 0, org.cy || 0, org.cz || 0) + ',$,$)') + ')');
    var site = put('IFCSITE(' + gid() + ",$,'Site',$,$," + sitePl + ',$,$,.ELEMENT.,$,$,$,$,$)');
    var bldPl = put('IFCLOCALPLACEMENT(' + sitePl + ',' + put('IFCAXIS2PLACEMENT3D(' + pt(0, 0, 0) + ',$,$)') + ')');
    var bld = put('IFCBUILDING(' + gid() + ",$,'Building',$,$," + bldPl + ',$,$,.ELEMENT.,$,$,$)');
    var stPl = put('IFCLOCALPLACEMENT(' + bldPl + ',' + put('IFCAXIS2PLACEMENT3D(' + pt(0, 0, storeyZ) + ',$,$)') + ')');
    var st = put('IFCBUILDINGSTOREY(' + gid() + ',$,' + str(o.storeyName || 'Этаж') + ',$,$,' + stPl + ',$,$,.ELEMENT.,' + f(storeyZ + (org.cz || 0)) + ')');
    put('IFCRELAGGREGATES(' + gid() + ',$,$,$,' + proj + ',(' + site + '))'); put('IFCRELAGGREGATES(' + gid() + ',$,$,$,' + site + ',(' + bld + '))'); put('IFCRELAGGREGATES(' + gid() + ',$,$,$,' + bld + ',(' + st + '))');
    var els = [], ENT = { beam: ['IFCBEAM', '.BEAM.'], pipe: ['IFCPIPESEGMENT', '.RIGIDSEGMENT.'], duct: ['IFCDUCTSEGMENT', '.RIGIDSEGMENT.'], tray: ['IFCCABLECARRIERSEGMENT', '.CABLETRAYSEGMENT.'], rack: ['IFCPIPESEGMENT', '.NOTDEFINED.'] };
    list.forEach(function (e) {
      var round = e.kind === 'pipe' || e.shape === 'round', c = Math.cos(e.th), s = Math.sin(e.th);
      var zc = round ? (e.center != null ? e.center : e.bottom + e.width / 2) : e.bottom;
      // местные оси: Z — вдоль элемента, X — поперёк по горизонтали, Y — вверх
      var pl = put('IFCLOCALPLACEMENT(' + stPl + ',' + put('IFCAXIS2PLACEMENT3D(' + pt(e.a[0], e.a[1], zc - storeyZ) + ',' + dirE(c, s, 0) + ',' + dirE(-s, c, 0) + ')') + ')');
      var prof = round ? put("IFCCIRCLEPROFILEDEF(.AREA.,$," + put('IFCAXIS2PLACEMENT2D(' + pt(0, 0) + ',$)') + ',' + f((e.d || e.width) / 2) + ')')
        : put("IFCRECTANGLEPROFILEDEF(.AREA.,$," + put('IFCAXIS2PLACEMENT2D(' + pt(0, e.depth / 2) + ',$)') + ',' + f(e.width) + ',' + f(e.depth) + ')');
      var solid = put('IFCEXTRUDEDAREASOLID(' + prof + ',' + put('IFCAXIS2PLACEMENT3D(' + pt(0, 0, 0) + ',$,$)') + ',' + dirE(0, 0, 1) + ',' + f(e.length) + ')');
      var rep = put('IFCSHAPEREPRESENTATION(' + body + ",'Body','SweptSolid',(" + solid + '))'), pds = put('IFCPRODUCTDEFINITIONSHAPE($,$,(' + rep + '))');
      var en = ENT[e.kind] || ENT.duct, name = (KIND_LONG[e.kind] || e.kind) + ' ' + sizeText(e);
      var el = put(en[0] + '(' + gid() + ',$,' + str(name) + ',' + str('по облаку точек, BIM Twin') + ',$,' + pl + ',' + pds + ',' + str('MEP-' + e.id) + ',' + en[1] + ')');
      var props = [put("IFCPROPERTYSINGLEVALUE('Width',$,IFCPOSITIVELENGTHMEASURE(" + f(e.width) + '),$)'), put("IFCPROPERTYSINGLEVALUE('Depth',$,IFCPOSITIVELENGTHMEASURE(" + f(Math.max(0.001, e.depth)) + '),$)'),
        put("IFCPROPERTYSINGLEVALUE('Length',$,IFCPOSITIVELENGTHMEASURE(" + f(e.length) + '),$)'), put("IFCPROPERTYSINGLEVALUE('BottomAboveFloor',$,IFCLENGTHMEASURE(" + f(e.clear) + '),$)'),
        put("IFCPROPERTYSINGLEVALUE('LowClearance',$,IFCBOOLEAN(" + (e.warn ? '.T.' : '.F.') + '),$)')];
      if (round) props.push(put("IFCPROPERTYSINGLEVALUE('NominalDiameter',$,IFCPOSITIVELENGTHMEASURE(" + f(e.d || e.width) + '),$)'));
      var ps = put('IFCPROPERTYSET(' + gid() + ",$,'BIMTwin_Scan',$,(" + props.join(',') + '))');
      put('IFCRELDEFINESBYPROPERTIES(' + gid() + ',$,$,$,(' + el + '),' + ps + ')');
      els.push(el);
    });
    if (els.length) put('IFCRELCONTAINEDINSPATIALSTRUCTURE(' + gid() + ',$,$,$,(' + els.join(',') + '),' + st + ')');
    var date = (o.date || new Date().toISOString()).slice(0, 19);
    return ['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
      'FILE_NAME(' + str(o.fileName || 'mep.ifc') + ",'" + date + "',(''),(''),'BIM Twin','BIM Twin','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;'].concat(L, ['ENDSEC;', 'END-ISO-10303-21;']).join('\n') + '\n';
  }

  return { mepAcc: mepAcc, mepFind: mepFind, refineAcc: refineAcc, refine: refine, dropGrille: dropGrille, circleFit: circleFit, splitProfile: splitProfile, summary: summary, sizeText: sizeText,
    csvRows: csvRows, toDxfEntities: toDxfEntities, toIfc: toIfc, KIND: KIND, KIND_LONG: KIND_LONG, LAYER: LAYER };
});
