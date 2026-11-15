/*
 * lixel-scan2bim-quality.js — v114 · Фаза 5 ROADMAP-IDEAL (D2)
 * Панель качества BIM-модели в приложении. Показывает метрики, которые можно
 * получить из модели, и (если в сцене есть облако) покрытие стен облаком.
 * Ничего не меняет в модели: только читает window.__lxScan2BIM.state.model /
 * window.__lxS2BEditor.getModel() и v.base[0].pos. Без Python, сети и записи на диск
 * до явного «Сохранить JSON».
 *
 * Метрики из модели:
 *   высота этажа; стены N и суммарная длина; толщина медиана/мин/макс;
 *   проёмы N (двери/окна); помещения N/площадь/доля от этажа; плиты N.
 * По облаку:
 *   покрытие стен — доля шагов 0.5 м по каждой стене, где в полосе ±(t/2+0.1) м
 *   и по высоте стены есть ≥2 точки облака; иначе строка-прочерк.
 * Каждая строка помечена источником «из модели» / «нужен обмер облаком»
 * и статусом PASS / FAIL / — (прочерк). Есть скор 0–100 и экспорт отчёта JSON.
 *
 * Панель пересчитывается: при открытии, по кнопке «Обновить», при вызове
 * refresh() и автоматически при изменении модели (лёгкий опрос сигнатуры раз
 * в 0,5 с, пока панель открыта) — правки редактора видны без перезагрузки.
 *
 * API: window.__lxS2BQuality = { open, close, isOpen, setModel, getModel, refresh,
 *   checkForChanges, getMetrics, getReport, buildReport, reportJson, exportReport,
 *   modelMetrics, thicknessStats, openingsStats, roomsStats, coverageStats,
 *   buildRows, scoreOf, signatureOf, THRESHOLDS, SCORE_WEIGHTS, STATUS, SOURCE,
 *   STEP, BAND_EXTRA, MIN_POINTS_PER_STEP, version }.
 * Для node --test доступен через module.exports; DOM/панель создаются только в окне.
 */
(function () {
  'use strict';

  var VERSION = '114';
  var REPORT_NAME = 'scan2bim-quality.json';
  var STEP = 0.5;                    // шаг обмера покрытия вдоль стены, м (задание)
  var BAND_EXTRA = 0.10;             // полоса вокруг стены: ±(t/2 + 0.1) м
  var MIN_POINTS_PER_STEP = 2;       // «по высоте ≥2 точки» — шаг считается покрытым
  var CLOUD_SAMPLE_MAX = 300000;     // прореживание облака, чтобы обмер не подвешивал UI
  var WATCH_MS = 500;                // опрос изменения модели, пока панель открыта

  // Пороги PASS/FAIL. Где возможно — из таблицы A роадмапа:
  // A2 покрытие: медиана ≥ 90 %, мин ≥ 60 %; остальные — физические/полнотные допуски,
  // т.к. сравнение «модель vs облако» для них в UI без обмера невозможно (строка-прочерк).
  var THRESHOLDS = {
    HEIGHT_MIN: 2.2, HEIGHT_MAX: 4.5,     // правдоподобная высота этажа, м
    WALLS_MIN: 3, WALL_LEN_MIN: 4.0,      // сколько стен/метров минимум для «модель интерьера»
    THICK_MIN: 0.05, THICK_MAX: 0.50,     // диапазон толщин движка scan2bim.js
    OPENINGS_MIN: 1,                      // без проёмов модель, скорее всего, неполна
    ROOM_SHARE_MIN: 0.40, ROOM_SHARE_MAX: 1.02, // доля площади помещений от площади этажа
    SLABS_MIN: 2,                         // пол + потолок
    COVERAGE_MIN: 0.90,                   // A2: медиана покрытия стен
    COVERAGE_MIN_WALL: 0.60               // A2: минимальное покрытие по стене
  };
  var SCORE_WEIGHTS = { height: 15, walls: 15, thickness: 20, openings: 10, rooms: 15, slabs: 5, coverage: 20 };
  var STATUS = { PASS: 'pass', FAIL: 'fail', NA: 'na' };
  var SOURCE = { MODEL: 'model', CLOUD: 'cloud' };

  // ===================== УТИЛИТЫ =====================
  function isFiniteNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x, def) { var v = Number(x); return isFinite(v) ? v : (def == null ? 0 : def); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function fmt(x, d) { return isFiniteNum(x) ? (+x).toFixed(d == null ? 2 : d) : '—'; }
  function pct(x, d) { return isFiniteNum(x) ? (+x * 100).toFixed(d == null ? 0 : d) + ' %' : '—'; }
  function median(arr) {
    if (!arr || !arr.length) return NaN;
    var s = arr.slice().sort(function (a, b) { return a - b; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function polyArea(poly) {
    if (!poly || poly.length < 3) return 0;
    var s = 0;
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      if (!a || !b) return 0;
      s += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(s) / 2;
  }
  function isModelOk(m) { return !!(m && m.ok && (m.walls || m.storeys || m.rooms)); }
  function hhmmss(d) {
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // ===================== ГЕОМЕТРИЯ МОДЕЛИ =====================
  function unitDir(w) {
    if (!w || !w.a || !w.b) return [1, 0];
    var dx = num(w.b[0]) - num(w.a[0]), dz = num(w.b[1]) - num(w.a[1]);
    var len = Math.hypot(dx, dz);
    if (len > 1e-9) return [dx / len, dz / len];
    if (w.dir && (num(w.dir[0]) || num(w.dir[1]))) {
      var dl = Math.hypot(num(w.dir[0]), num(w.dir[1])) || 1;
      return [num(w.dir[0]) / dl, num(w.dir[1]) / dl];
    }
    return [1, 0];
  }
  function wallLength(w) {
    if (!w || !w.a || !w.b) return num(w && w.length);
    return Math.hypot(num(w.b[0]) - num(w.a[0]), num(w.b[1]) - num(w.a[1]));
  }
  function wallHeight(w) {
    if (!w) return 0;
    if (isFiniteNum(w.height) && w.height > 0.2) return w.height;
    if (isFiniteNum(w.top) && isFiniteNum(w.base)) return Math.max(0, w.top - w.base);
    return 0;
  }
  function wallBase(w) { return w ? num(w.base) : 0; }
  function openingsOf(w) { return (w && w.openings) || []; }

  // ===================== МЕТРИКИ ИЗ МОДЕЛИ =====================
  function thicknessStats(walls) {
    var arr = [];
    for (var i = 0; i < (walls || []).length; i++) {
      var t = num(walls[i].thickness, NaN);
      if (isFiniteNum(t) && t > 0) arr.push(t);
    }
    if (!arr.length) return { count: 0, median: NaN, min: NaN, max: NaN };
    return {
      count: arr.length,
      median: Math.round(median(arr) * 1000) / 1000,
      min: Math.round(Math.min.apply(null, arr) * 1000) / 1000,
      max: Math.round(Math.max.apply(null, arr) * 1000) / 1000
    };
  }
  function openingsStats(walls) {
    var out = { count: 0, doors: 0, windows: 0, other: 0 };
    for (var i = 0; i < (walls || []).length; i++) {
      var ops = openingsOf(walls[i]);
      for (var j = 0; j < ops.length; j++) {
        out.count++;
        var k = ops[j] && ops[j].kind;
        if (k === 'door') out.doors++;
        else if (k === 'window') out.windows++;
        else out.other++;
      }
    }
    return out;
  }
  function floorAreaOf(model) {
    if (!model) return 0;
    var s = model.stats || {};
    if (isFiniteNum(s.floorArea) && s.floorArea > 0) return s.floorArea;
    if (model.footprint && model.footprint.length >= 3) {
      var a = polyArea(model.footprint);
      if (a > 0) return a;
    }
    var slabs = model.slabs || [], best = 0;
    for (var i = 0; i < slabs.length; i++) {
      if (slabs[i] && slabs[i].type === 'floor') best = Math.max(best, num(slabs[i].area, polyArea(slabs[i].polygon)));
    }
    return best;
  }
  function roomsStats(model) {
    var rooms = (model && model.rooms) || [], area = 0;
    for (var i = 0; i < rooms.length; i++) {
      area += num(rooms[i].area, polyArea(rooms[i].polygon));
    }
    var floorArea = floorAreaOf(model);
    var share = floorArea > 0 ? area / floorArea : NaN;
    return { count: rooms.length, area: Math.round(area * 1000) / 1000, floorArea: Math.round(floorArea * 1000) / 1000, share: share };
  }
  function modelMetrics(model) {
    if (!isModelOk(model)) return null;
    var walls = model.walls || [], totalLen = 0;
    for (var i = 0; i < walls.length; i++) totalLen += wallLength(walls[i]);
    var storey = model.storey || {};
    var h = isFiniteNum(storey.height) ? storey.height
      : (isFiniteNum(storey.ceilY) && isFiniteNum(storey.floorY) ? storey.ceilY - storey.floorY : NaN);
    var slabs = model.slabs || [], floorCount = 0, ceilCount = 0;
    for (var j = 0; j < slabs.length; j++) {
      if (slabs[j] && slabs[j].type === 'ceiling') ceilCount++;
      else floorCount++;
    }
    return {
      storey: { height: h, floorY: isFiniteNum(storey.floorY) ? storey.floorY : 0, ceilY: isFiniteNum(storey.ceilY) ? storey.ceilY : h },
      walls: { count: walls.length, totalLength: Math.round(totalLen * 1000) / 1000 },
      thickness: thicknessStats(walls),
      openings: openingsStats(walls),
      rooms: roomsStats(model),
      slabs: { count: slabs.length, floorCount: floorCount, ceilingCount: ceilCount }
    };
  }

  // ===================== ПОКРЫТИЕ СТЕН ОБЛАКОМ =====================
  // Обход точек облака: Float32Array xyz (v.base[0].pos), [x,y,z]-тройки или {pos}.
  function eachCloudPoint(cloud, cb) {
    if (!cloud) return 0;
    if (cloud.pos && cloud.pos.length) cloud = cloud.pos;
    var n = cloud.length | 0, i, used = 0;
    if (!n) return 0;
    if (typeof cloud[0] === 'number') {
      var stride = 3;
      if (n / 3 > CLOUD_SAMPLE_MAX) stride = Math.ceil((n / 3) / CLOUD_SAMPLE_MAX) * 3;
      for (i = 0; i + 2 < n; i += stride) {
        var x = cloud[i], y = cloud[i + 1], z = cloud[i + 2];
        if (isFinite(x) && isFinite(y) && isFinite(z)) { cb(x, y, z); used++; }
      }
    } else {
      var st = n > CLOUD_SAMPLE_MAX ? Math.ceil(n / CLOUD_SAMPLE_MAX) : 1;
      for (i = 0; i < n; i += st) {
        var p = cloud[i];
        if (p && p.length >= 3) {
          var px = +p[0], py = +p[1], pz = +p[2];
          if (isFinite(px) && isFinite(py) && isFinite(pz)) { cb(px, py, pz); used++; }
        }
      }
    }
    return used;
  }

  /**
   * Покрытие стен облаком: доля шагов по 0.5 м, где в полосе ±(t/2+0.1) м и по высоте
   * стены набирается ≥2 точки облака.
   * @param {object} model
   * @param {Float32Array|Array|{pos:Float32Array}|null} cloud — v.base[0].pos
   * @returns {{available:boolean, reason?:string, walls:Array, steps:number, covered:number,
   *   overall:number, median:number, min:number, points:number, sampled:number}}
   */
  function coverageStats(model, cloud) {
    var walls = (model && model.walls) || [];
    if (!cloud || !cloud.length) {
      return { available: false, reason: 'облако точек не найдено', walls: [], steps: 0, covered: 0, overall: 0, median: 0, min: 0, points: 0, sampled: 0 };
    }
    var ws = [], i;
    for (i = 0; i < walls.length; i++) {
      var w = walls[i];
      if (!w || !w.a || !w.b) continue;
      var L = wallLength(w);
      if (!(L > 0.05)) continue;
      var t = Math.max(0.01, num(w.thickness, 0.15));
      var steps = Math.max(1, Math.floor(L / STEP));
      var dir = unitDir(w);
      var base = wallBase(w), H = wallHeight(w);
      if (!(H > 0.05)) continue;
      var half = t / 2 + BAND_EXTRA;
      var a0 = num(w.a[0]), a1 = num(w.a[1]), b0 = num(w.b[0]), b1 = num(w.b[1]);
      ws.push({
        index: i, steps: steps, stepLen: L / steps, counts: new Int32Array(steps),
        a0: a0, a1: a1, L: L, dx: dir[0], dz: dir[1], nx: -dir[1], nz: dir[0],
        half: half, yLo: base, yHi: base + H,
        minX: Math.min(a0, b0) - half, maxX: Math.max(a0, b0) + half,
        minZ: Math.min(a1, b1) - half, maxZ: Math.max(a1, b1) + half
      });
    }
    if (!ws.length) {
      return { available: false, reason: 'в модели нет стен для обмера', walls: [], steps: 0, covered: 0, overall: 0, median: 0, min: 0, points: 0, sampled: 0 };
    }
    var hits = 0;
    var sampled = eachCloudPoint(cloud, function (x, y, z) {      for (var wi = 0; wi < ws.length; wi++) {
        var W = ws[wi];
        if (x < W.minX || x > W.maxX || z < W.minZ || z > W.maxZ) continue;
        if (y < W.yLo || y > W.yHi) continue;
        var px = x - W.a0, pz = z - W.a1;
        var s = px * W.dx + pz * W.dz;
        if (s < 0 || s >= W.L) continue;
        var perp = px * W.nx + pz * W.nz;
        if (perp < -W.half || perp > W.half) continue;
        var k = (s / W.stepLen) | 0;
        if (k >= W.steps) k = W.steps - 1;
        W.counts[k]++;
        hits++;
      }
    });
    var totalSteps = 0, totalCovered = 0, perWall = [], covs = [];
    for (var wi2 = 0; wi2 < ws.length; wi2++) {
      var W2 = ws[wi2], covered = 0;
      for (var k2 = 0; k2 < W2.steps; k2++) if (W2.counts[k2] >= MIN_POINTS_PER_STEP) covered++;
      var cov = W2.steps > 0 ? covered / W2.steps : 0;
      totalSteps += W2.steps;
      totalCovered += covered;
      covs.push(cov);
      perWall.push({ index: W2.index, steps: W2.steps, coveredSteps: covered, coverage: Math.round(cov * 1000) / 1000 });
    }
    return {
      available: true,
      walls: perWall,
      steps: totalSteps,
      covered: totalCovered,
      overall: totalSteps > 0 ? totalCovered / totalSteps : 0,
      median: covs.length ? median(covs) : 0,
      min: covs.length ? Math.min.apply(null, covs) : 0,
      points: sampled,   // сколько точек облака реально просмотрено
      hits: hits         // сколько попаданий «точка × стена» легло в шаги
    };
  }

  // ===================== СТРОКИ-МЕТРИКИ И СКОР =====================
  function row(id, label, value, target, source, sourceLabel, status, detail) {
    return { id: id, label: label, value: value, target: target, source: source, sourceLabel: sourceLabel, status: status, detail: detail || '' };
  }
  function srcLabel(kind, available) {
    if (kind === SOURCE.MODEL) return 'из модели';
    return available ? 'обмер облаком' : 'нужен обмер облаком';
  }

  /**
   * Строки панели с PASS/FAIL/прочерком.
   * @param {object|null} m — результат modelMetrics()
   * @param {object} cov — результат coverageStats()
   */
  function buildRows(m, cov) {
    var rows = [];
    if (!m) return rows;
    var h = m.storey.height;
    rows.push(row('height', 'Высота этажа', fmt(h, 2) + ' м', fmt(THRESHOLDS.HEIGHT_MIN, 1) + '–' + fmt(THRESHOLDS.HEIGHT_MAX, 1) + ' м',
      SOURCE.MODEL, srcLabel(SOURCE.MODEL), (!isFiniteNum(h)) ? STATUS.NA : (h >= THRESHOLDS.HEIGHT_MIN && h <= THRESHOLDS.HEIGHT_MAX ? STATUS.PASS : STATUS.FAIL)));

    var w = m.walls;
    rows.push(row('walls', 'Стены', w.count + ' шт · ' + fmt(w.totalLength, 1) + ' м',
      '≥ ' + THRESHOLDS.WALLS_MIN + ' шт, ≥ ' + fmt(THRESHOLDS.WALL_LEN_MIN, 0) + ' м', SOURCE.MODEL, srcLabel(SOURCE.MODEL),
      (w.count >= THRESHOLDS.WALLS_MIN && w.totalLength >= THRESHOLDS.WALL_LEN_MIN) ? STATUS.PASS : STATUS.FAIL));

    var th = m.thickness;
    rows.push(row('thickness', 'Толщина стен (медиана/мин/макс)',
      th.count ? (fmt(th.median, 2) + ' / ' + fmt(th.min, 2) + ' / ' + fmt(th.max, 2) + ' м') : '—',
      fmt(THRESHOLDS.THICK_MIN, 2) + '–' + fmt(THRESHOLDS.THICK_MAX, 2) + ' м', SOURCE.MODEL, srcLabel(SOURCE.MODEL),
      !th.count ? STATUS.NA : (th.median >= THRESHOLDS.THICK_MIN && th.median <= THRESHOLDS.THICK_MAX ? STATUS.PASS : STATUS.FAIL)));

    var op = m.openings;
    rows.push(row('openings', 'Проёмы', op.count + ' (двери ' + op.doors + ' · окна ' + op.windows + (op.other ? ' · прочие ' + op.other : '') + ')',
      '≥ ' + THRESHOLDS.OPENINGS_MIN + ' проём', SOURCE.MODEL, srcLabel(SOURCE.MODEL),
      !w.count ? STATUS.NA : (op.count >= THRESHOLDS.OPENINGS_MIN ? STATUS.PASS : STATUS.FAIL)));

    var rm = m.rooms;
    var shareTxt = isFiniteNum(rm.share) ? pct(rm.share) + ' этажа' : 'доля —';
    var shareOk = isFiniteNum(rm.share) && rm.share >= THRESHOLDS.ROOM_SHARE_MIN && rm.share <= THRESHOLDS.ROOM_SHARE_MAX;
    rows.push(row('rooms', 'Помещения', rm.count + ' · ' + fmt(rm.area, 1) + ' м² · ' + shareTxt,
      '≥ 1, доля ' + pct(THRESHOLDS.ROOM_SHARE_MIN) + '–' + pct(THRESHOLDS.ROOM_SHARE_MAX), SOURCE.MODEL, srcLabel(SOURCE.MODEL),
      (rm.count >= 1 && shareOk) ? STATUS.PASS : STATUS.FAIL));

    var sl = m.slabs;
    rows.push(row('slabs', 'Плиты', sl.count + ' (пол ' + sl.floorCount + ' · потолок ' + sl.ceilingCount + ')',
      '≥ ' + THRESHOLDS.SLABS_MIN + ' (пол + потолок)', SOURCE.MODEL, srcLabel(SOURCE.MODEL),
      sl.count >= THRESHOLDS.SLABS_MIN ? STATUS.PASS : STATUS.FAIL));

    // Покрытие — единственная метрика, которой нужен обмер облаком.
    var covOk = !!cov && cov.available && cov.overall >= THRESHOLDS.COVERAGE_MIN && cov.min >= THRESHOLDS.COVERAGE_MIN_WALL;
    var covValue = (cov && cov.available)
      ? pct(cov.overall) + ' · мин ' + pct(cov.min)
      : '—';
    var covDetail = (cov && cov.available)
      ? ('стен ' + cov.walls.length + ' · шагов ' + cov.steps + ' · точек ' + cov.points + ' · попаданий ' + num(cov.hits))
      : ((cov && cov.reason) || 'облако точек не найдено');
    rows.push(row('coverage', 'Покрытие стен облаком', covValue,
      '≥ ' + pct(THRESHOLDS.COVERAGE_MIN) + ', мин ≥ ' + pct(THRESHOLDS.COVERAGE_MIN_WALL),
      SOURCE.CLOUD, srcLabel(SOURCE.CLOUD, !!(cov && cov.available)),
      !cov || !cov.available ? STATUS.NA : (covOk ? STATUS.PASS : STATUS.FAIL), covDetail));
    return rows;
  }

  function scoreOf(rows) {
    var values = rows || [], weighted = 0, total = 0, pass = 0, fail = 0, na = 0;
    for (var i = 0; i < values.length; i++) {
      var r = values[i], wt = SCORE_WEIGHTS[r.id] || 0;
      if (r.status === STATUS.NA) { na++; continue; }
      total += wt;
      if (r.status === STATUS.PASS) { pass++; weighted += wt; } else fail++;
    }
    return { value: total > 0 ? Math.round(weighted / total * 100) : 0, pass: pass, fail: fail, na: na, measurable: total };
  }

  // ===================== ОТЧЁТ =====================
  function buildReport(model, opts) {
    opts = opts || {};
    var cloud = opts.cloud != null ? opts.cloud : null;
    var metrics = modelMetrics(model);
    var coverage = coverageStats(model || { walls: [] }, cloud);
    var rows = buildRows(metrics, coverage);
    var score = scoreOf(rows);
    var created = opts.generatedAt || new Date().toISOString();
    return {
      tool: 'lixel-scan2bim-quality',
      version: VERSION,
      created_at: created,
      source: coverage.available ? 'model+cloud' : 'model',
      model: metrics || null,
      coverage: coverage,
      rows: rows,
      score: score,
      thresholds: {
        A1: { label: 'Высота этажа', target: 'правдоподобная ' + fmt(THRESHOLDS.HEIGHT_MIN, 1) + '–' + fmt(THRESHOLDS.HEIGHT_MAX, 1) + ' м' },
        A2: { label: 'Покрытие стен облаком', target: 'медиана ≥ ' + pct(THRESHOLDS.COVERAGE_MIN) + ', мин ≥ ' + pct(THRESHOLDS.COVERAGE_MIN_WALL) },
        A3: { label: 'Толщина стен', target: fmt(THRESHOLDS.THICK_MIN, 2) + '–' + fmt(THRESHOLDS.THICK_MAX, 2) + ' м (сравнение с облаком — в регрессии)' },
        A5: { label: 'Площадь помещений', target: 'доля от площади этажа ' + pct(THRESHOLDS.ROOM_SHARE_MIN) + '–' + pct(THRESHOLDS.ROOM_SHARE_MAX) }
      }
    };
  }
  function reportJson(model, opts) {
    try { return JSON.stringify(buildReport(model, opts), null, 2); } catch (e) { return null; }
  }
  // Компактная сигнатура модели: ловит правки редактора без полного сравнения JSON.
  function signatureOf(model) {
    if (!isModelOk(model)) return 'none';
    var walls = model.walls || [], rooms = model.rooms || [], slabs = model.slabs || [];
    var len = 0, thk = 0, cx = 0, cz = 0, ops = 0, hs = 0;
    for (var i = 0; i < walls.length; i++) {
      var w = walls[i];
      len += wallLength(w);
      thk += num(w.thickness, 0.15);
      cx += num(w.a && w.a[0]) + num(w.b && w.b[0]);
      cz += num(w.a && w.a[1]) + num(w.b && w.b[1]);
      ops += openingsOf(w).length;
      hs += wallHeight(w);
    }
    var area = 0;
    for (var r = 0; r < rooms.length; r++) area += num(rooms[r].area, 0);
    function rr(x) { return Math.round(num(x) * 1000) / 1000; }
    return [walls.length, rr(len), rr(thk), rr(cx), rr(cz), ops, hs, rooms.length, rr(area), slabs.length,
      rr(model.storey && model.storey.height)].join('|');
  }

  // ===================== ИСТОЧНИКИ ДАННЫХ =====================
  function mainV() {
    try {
      if (typeof window === 'undefined') return null;
      if (window.__pcTools && window.__pcTools.viewer) return window.__pcTools.viewer();
      return window.__viewer || null;
    } catch (e) { return null; }
  }
  // Облако: по заданию — v.base[0].pos; если первый чанк пуст, берём первый непустой.
  function cloudPosOf(v) {
    if (!v || !v.base || !v.base.length) return null;
    for (var i = 0; i < v.base.length; i++) {
      var o = v.base[i];
      if (o && o.pos && o.pos.length) return o.pos;
    }
    return null;
  }
  function viewerCloud() {
    try { return cloudPosOf(mainV()); } catch (e) { return null; }
  }
  function currentModel() {
    try {
      if (typeof window !== 'undefined' && window.__lxS2BEditor && typeof window.__lxS2BEditor.getModel === 'function') {
        var m = window.__lxS2BEditor.getModel();
        if (isModelOk(m)) return m;
      }
    } catch (e) { }
    try {
      if (typeof window !== 'undefined' && window.__lxScan2BIM && window.__lxScan2BIM.state) return window.__lxScan2BIM.state.model || null;
    } catch (e) { }
    return null;
  }

  // ===================== DOM: ПАНЕЛЬ =====================
  function toast(msg, err) {
    try {
      if (typeof window !== 'undefined' && window.__toast) return window.__toast(msg, err ? 'error' : 'info');
    } catch (e) { }
    if (typeof console !== 'undefined') console[err ? 'error' : 'log']('[scan2bim-quality] ' + msg);
  }
  function hydrate(scope) {
    try {
      if (typeof window === 'undefined') return;
      if (window.__lxKit && window.__lxKit.hydrate) return window.__lxKit.hydrate(scope);
      if (window.__lxIcons && window.__lxIcons.hydrate) return window.__lxIcons.hydrate(scope);
    } catch (e) { }
  }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function downloadText(text, name, mime) {
    if (typeof document === 'undefined') return false;
    try {
      var blob = new Blob([text], { type: mime || 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function () {
        try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) { }
      }, 400);
      return true;
    } catch (e) { return false; }
  }

  // Стили: только токены tokens.css — палитра violet #a78bfa / #6a52cb и graphite
  // #1c1b1a / #232221 (тёмная/светлая тема), без синего, чистого белого и градиентов.
  var CSS_ID = 'lxS2BQualityStyles';
  var CSS = [
    '.lx-s2bq.fpanel { width: 340px; }',
    '.lx-s2bq .fpanel-body { display: flex; flex-direction: column; gap: 8px; }',
    '.lx-s2bq-score { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-3); background: var(--bg-2); }',
    '.lx-s2bq-score-v { display: flex; flex: none; align-items: baseline; gap: 2px; color: var(--accent); }',
    '.lx-s2bq-score-v b { font: 600 30px/1 var(--font); font-variant-numeric: tabular-nums; }',
    '.lx-s2bq-score-v small { color: var(--txt-3); font: 11px/1 var(--mono); }',
    '.lx-s2bq-score-m { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }',
    '.lx-s2bq-score-t { color: var(--txt); font-size: var(--fs-sm); font-weight: 600; }',
    '.lx-s2bq-counts { display: flex; flex-wrap: wrap; gap: 4px 10px; font: 11px/1.3 var(--mono); font-variant-numeric: tabular-nums; }',
    '.lx-s2bq-counts .ok { color: var(--ok); }',
    '.lx-s2bq-counts .err { color: var(--err); }',
    '.lx-s2bq-counts .na { color: var(--txt-3); }',
    '.lx-s2bq-src { overflow: hidden; color: var(--txt-3); font: 11px/1.35 var(--mono); text-overflow: ellipsis; white-space: nowrap; }',
    '.lx-s2bq-score.ok .lx-s2bq-score-v { color: var(--ok); }',
    '.lx-s2bq-score.warn .lx-s2bq-score-v { color: var(--warn); }',
    '.lx-s2bq-score.err .lx-s2bq-score-v { color: var(--err); }',
    '.lx-s2bq-rows { display: flex; flex-direction: column; gap: 2px; }',
    '.lx-s2bq-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 4px 8px; padding: 6px 8px; border-radius: var(--r-1); background: var(--bg-2); }',
    '.lx-s2bq-row:hover { background: var(--bg-3); }',
    '.lx-s2bq-main { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }',
    '.lx-s2bq-lbl { color: var(--txt); font-size: var(--fs-sm); font-weight: 500; }',
    '.lx-s2bq-sub { overflow: hidden; color: var(--txt-3); font-size: var(--fs-xs); text-overflow: ellipsis; white-space: nowrap; }',
    '.lx-s2bq-val { color: var(--txt); font: 12px/1.3 var(--mono); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }',
    '.lx-s2bq-row[data-q-status="na"] .lx-s2bq-val { color: var(--txt-3); }',
    '.lx-s2bq-badge { flex: none; min-width: 44px; padding: 2px 6px; border-radius: 999px; font: 600 10.5px/1.4 var(--font); text-align: center; letter-spacing: .04em; }',
    '.lx-s2bq-badge.pass { background: var(--ok-soft); color: var(--ok); }',
    '.lx-s2bq-badge.fail { background: var(--err-soft); color: var(--err); }',
    '.lx-s2bq-badge.na { background: var(--bg-4); color: var(--txt-3); }',
    '.lx-s2bq-hint { margin: 2px 0 0; color: var(--txt-3); font-size: var(--fs-xs); line-height: 1.45; }',
    '.lx-s2bq-status { margin: 0; color: var(--txt-3); font: 11px/1.4 var(--mono); }',
    '.lx-s2bq-status:empty { display: none; }',
    '.lx-s2bq .lx-btnrow { margin-top: 0; }',
    '.lx-s2bq .lx-btnrow .btn { flex: 1 1 auto; }'
  ].join('\n');

  function ensureStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(CSS_ID)) return;
    var s = document.createElement('style');
    s.id = CSS_ID;
    s.textContent = CSS;
    (document.head || document.documentElement || document.body).appendChild(s);
  }

  var st = { panel: null, model: null, report: null, metrics: null, status: '', updatedAt: null, lastSig: 'none', timer: null, keyOn: false };

  function statusLabel(s) {
    if (s === STATUS.PASS) return 'PASS';
    if (s === STATUS.FAIL) return 'FAIL';
    return '—';
  }
  function rowHtml(r) {
    return '<div class="lx-s2bq-row" data-q-row="' + r.id + '" data-q-metric="' + r.id + '" data-q-status="' + r.status + '" data-q-source="' + r.source + '">' +
      '<div class="lx-s2bq-main"><span class="lx-s2bq-lbl">' + r.label + '</span>' +
      '<small class="lx-s2bq-sub" data-q-source-label="' + r.sourceLabel + '">' + r.sourceLabel + ' · цель: ' + r.target + '</small></div>' +
      '<span class="lx-s2bq-val" data-q-value>' + r.value + '</span>' +
      '<span class="lx-s2bq-badge ' + r.status + '" data-q-badge>' + statusLabel(r.status) + '</span>' +
      '</div>';
  }

  function bodyHtml() {
    var model = st.model;
    if (!isModelOk(model)) {
      return '<p class="sec-note" data-q-hint="no-model">Модель ещё не построена. Откройте панель «Скан → BIM», нажмите «Построить BIM» — и вернитесь в «Качество модели».</p>' +
        '<div class="lx-btnrow"><button type="button" class="btn sm" data-act="open-build" data-ico="building">Открыть «Скан → BIM»</button></div>';
    }
    var rep = st.report;
    if (!rep) return '<p class="sec-note" data-q-hint="no-report">Нажмите «Обновить», чтобы пересчитать метрики.</p>' +
      '<div class="lx-btnrow"><button type="button" class="btn sm" data-act="refresh" data-ico="refresh-cw">Обновить</button></div>';
    var score = rep.score, cov = rep.coverage;
    var tone = score.value >= 80 ? 'ok' : (score.value >= 50 ? 'warn' : 'err');
    var srcLine = (cov.available ? 'модель + облако' : 'модель') +
      (cov.available ? ' · шагов ' + cov.steps + ' · точек ' + cov.points : ' · облако не найдено');
    var html = [];
    html.push('<div class="lx-s2bq-score ' + tone + '" data-q-score="' + score.value + '">' +
      '<div class="lx-s2bq-score-v"><b data-q-score-value>' + score.value + '</b><small>/100</small></div>' +
      '<div class="lx-s2bq-score-m"><span class="lx-s2bq-score-t">Качество модели</span>' +
      '<span class="lx-s2bq-counts"><span class="ok" data-q-count="pass">PASS ' + score.pass + '</span>' +
      '<span class="err" data-q-count="fail">FAIL ' + score.fail + '</span>' +
      '<span class="na" data-q-count="na">— ' + score.na + '</span></span>' +
      '<span class="lx-s2bq-src" data-q-source-line>' + srcLine + '</span></div></div>');
    html.push('<p class="sec-note" data-q-hint="legend">«из модели» — расчёт по геометрии модели; «нужен обмер облаком» — метрика по точкам сцены, без облака показывается прочерк.</p>');
    var modelRows = [], cloudRows = [];
    for (var i = 0; i < rep.rows.length; i++) (rep.rows[i].source === SOURCE.CLOUD ? cloudRows : modelRows).push(rowHtml(rep.rows[i]));
    html.push('<div class="lx-obj-h">Из модели</div><div class="lx-s2bq-rows" data-q-group="model">' + modelRows.join('') + '</div>');
    html.push('<div class="lx-obj-h" style="margin-top:8px">По облаку</div><div class="lx-s2bq-rows" data-q-group="cloud">' + cloudRows.join('') + '</div>');
    html.push('<p class="lx-s2bq-hint">Панель пересчитывается при открытии, по кнопке «Обновить» и автоматически после правок редактора модели.</p>');
    html.push('<div class="lx-btnrow">' +
      '<button type="button" class="btn sm" data-act="refresh" data-ico="refresh-cw">Обновить</button>' +
      '<button type="button" class="btn sm primary" data-act="export-report" data-ico="file-json" data-tip="Сохранить отчёт качества в JSON">Сохранить JSON</button>' +
      '</div>');
    html.push('<p class="lx-s2bq-status" data-q-status role="status" aria-live="polite">' + (st.status || '') + '</p>');
    return html.join('');
  }

  function ensurePanel() {
    if (typeof document === 'undefined') return null;
    if (st.panel && st.panel.isConnected) return st.panel;
    var ex = document.getElementById('lxS2BQualityPanel');
    if (ex) { st.panel = ex; return ex; }
    ensureStyles();
    var p = el('section', 'fpanel fp-right lx-s2bq');
    p.id = 'lxS2BQualityPanel';
    p.setAttribute('aria-label', 'Качество модели');
    p.setAttribute('data-esc', '1');
    p.setAttribute('data-q-panel', '1');
    p.style.display = 'none';
    p.innerHTML = '<div class="fpanel-inner">' +
      '<header class="fpanel-head"><span class="fpanel-ico" data-ico="gauge"></span><h3>Качество модели</h3>' +
      '<div class="fpanel-actions">' +
      '<button id="lxS2BQualityRefresh" class="icon-btn" type="button" data-act="refresh" data-ico="refresh-cw" data-tip="Пересчитать метрики" aria-label="Пересчитать метрики"></button>' +
      '<button id="lxS2BQualityClose" class="icon-btn" type="button" data-panel-close data-ico="x" data-tip="Закрыть" aria-label="Закрыть панель качества"></button>' +
      '</div></header>' +
      '<div class="fpanel-body lx-sec-body" data-q-body="1"></div>' +
      '</div>';
    var host = document.getElementById('stageSideR') || document.querySelector('.stage') || document.body;
    host.appendChild(p);
    var closeBtn = p.querySelector('#lxS2BQualityClose');
    if (closeBtn) closeBtn.onclick = close;
    p.addEventListener('click', onPanelClick);
    hydrate(p);
    st.panel = p;
    return p;
  }

  function render() {
    if (typeof document === 'undefined') return;
    var p = ensurePanel();
    if (!p) return;
    var body = p.querySelector('[data-q-body]');
    if (!body) return;
    body.innerHTML = bodyHtml();
    hydrate(body);
    var refreshBtn = p.querySelector('#lxS2BQualityRefresh');
    if (refreshBtn) refreshBtn.disabled = !isModelOk(st.model);
  }

  // ===================== ОБНОВЛЕНИЕ =====================
  /**
   * Пересчитать метрики и отчёт, перерисовать панель.
   * @param {object|null} [modelArg] — явная модель (иначе текущая из редактора/UI).
   */
  function refresh(modelArg) {
    var model = (modelArg !== undefined) ? (modelArg || null) : (currentModel() || st.model || null);
    st.model = model;
    st.lastSig = signatureOf(model);
    if (!isModelOk(model)) {
      st.metrics = null;
      st.report = null;
      st.status = 'Модель не построена';
      render();
      return null;
    }
    var cloud = viewerCloud();
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var report = buildReport(model, { cloud: cloud, generatedAt: new Date().toISOString() });
    report.elapsed_ms = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0));
    st.metrics = report.model;
    st.report = report;
    st.updatedAt = report.created_at;
    st.status = 'Обновлено ' + hhmmss(new Date()) + ' · ' + (report.coverage.available ? 'модель + облако' : 'только модель') +
      ' · ' + report.elapsed_ms + ' мс';
    render();
    return report;
  }

  /** Опрос: если модель изменилась (правки редактора) — пересчитать. */
  function checkForChanges() {
    if (!isOpen()) return false;
    var model = currentModel() || st.model || null;
    var sig = signatureOf(model);
    if (sig === st.lastSig) return false;
    refresh(model);
    return true;
  }
  function startWatch() {
    if (st.timer) return;
    st.timer = setInterval(function () { try { checkForChanges(); } catch (e) { } }, WATCH_MS);
  }
  function stopWatch() {
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
  }

  function onPanelClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var actNode = t.closest('[data-act]');
    if (!actNode) return;
    e.preventDefault();
    e.stopPropagation();
    var act = actNode.getAttribute('data-act');
    if (act === 'refresh') { refresh(); return; }
    if (act === 'export-report') { exportReport(); return; }
    if (act === 'open-build') {
      try { if (typeof window !== 'undefined' && window.__lxScan2BIM && window.__lxScan2BIM.open) window.__lxScan2BIM.open(); } catch (e2) { }
    }
  }

  function isOpen() {
    return !!(st.panel && st.panel.style && st.panel.style.display !== 'none' && st.panel.isConnected !== false);
  }

  /** Сохранить отчёт качества JSON (свежий расчёт на момент нажатия). */
  function exportReport() {
    var model = currentModel() || st.model || null;
    if (!isModelOk(model)) { toast('Сначала постройте модель', true); return false; }
    var text = reportJson(model, { cloud: viewerCloud() });
    if (!text) { toast('Не удалось собрать отчёт', true); return false; }
    var ok = downloadText(text, REPORT_NAME, 'application/json');
    if (ok) toast('Отчёт качества сохранён: ' + REPORT_NAME);
    else toast('Не удалось сохранить отчёт', true);
    return ok;
  }

  // ===================== ОТКРЫТИЕ / ЗАКРЫТИЕ / API =====================
  function setModel(model) {
    st.model = model || null;
    if (isOpen()) refresh(st.model);
    return st.model;
  }
  function getModel() { return st.model; }
  function getMetrics() { return st.metrics; }
  function getReport() { return st.report; }

  /**
   * Открыть панель качества.
   * @param {object|null} [model] — модель; без аргумента берётся текущая
   *   (window.__lxS2BEditor.getModel() или window.__lxScan2BIM.state.model).
   */
  function open(model) {
    if (typeof document === 'undefined') return null;
    if (model !== undefined) st.model = model || null;
    else st.model = currentModel() || st.model || null;
    ensureStyles();
    var p = ensurePanel();
    if (!p) return null;
    p.style.display = 'block';
    p.classList.remove('folded');
    st.status = '';
    refresh(st.model);
    startWatch();
    hydrate(p);
    return p;
  }

  function close() {
    var p = ensurePanel();
    if (p) p.style.display = 'none';
    stopWatch();
    st.status = '';
  }

  var API = {
    version: VERSION,
    STEP: STEP,
    BAND_EXTRA: BAND_EXTRA,
    MIN_POINTS_PER_STEP: MIN_POINTS_PER_STEP,
    CLOUD_SAMPLE_MAX: CLOUD_SAMPLE_MAX,
    WATCH_MS: WATCH_MS,
    THRESHOLDS: THRESHOLDS,
    SCORE_WEIGHTS: SCORE_WEIGHTS,
    STATUS: STATUS,
    SOURCE: SOURCE,
    // чистые функции (node --test)
    thicknessStats: thicknessStats,
    openingsStats: openingsStats,
    roomsStats: roomsStats,
    floorAreaOf: floorAreaOf,
    modelMetrics: modelMetrics,
    coverageStats: coverageStats,
    buildRows: buildRows,
    scoreOf: scoreOf,
    buildReport: buildReport,
    reportJson: reportJson,
    signatureOf: signatureOf,
    // панель
    open: open,
    close: close,
    isOpen: isOpen,
    setModel: setModel,
    getModel: getModel,
    getMetrics: getMetrics,
    getReport: getReport,
    refresh: refresh,
    checkForChanges: checkForChanges,
    exportReport: exportReport,
    cloudPosOf: cloudPosOf
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.__lxS2BQuality = API;
  if (typeof globalThis !== 'undefined' && typeof window === 'undefined') {
    try { globalThis.__lxS2BQuality = API; } catch (e) { }
  }
})();
