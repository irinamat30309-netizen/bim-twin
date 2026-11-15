/*
 * lixel-scan2bim-editor.js — v1233 · Фаза 4 ROADMAP-IDEAL (D3)
 * Ручной редактор BIM-модели по облаку точек. Работает ЦЕЛИКОМ В ПАМЯТИ приложения:
 * никакого Python, child_process, fetch и записи на диск до явного «Сохранить JSON» /
 * «Экспорт IFC».
 *
 * Что умеет:
 *   • список стен (L, T, материал) и помещений; выбор → подсветка в 3D-оверлее линиями граней;
 *   • сдвиг выбранной стены по нормали ±0,05 м; толщина ±0,01 м; удлинение торцов ±0,1 м;
 *   • «Привязать к облаку» — медианы по двум модам точек в полосе ±0,4 м от оси
 *     (как refineWallFit в scan2bim.js); смещение применяется только если ≤0,25 м;
 *   • проёмы: along/width/sill/head ±0,05 м, удаление, добавление двери 0,90×2,10;
 *   • undo/redo (стек JSON-снимков модели, глубина 30) и «Сбросить» к исходной модели;
 *   • «Сохранить JSON» и «Экспорт IFC» (window.Scan2BIM.toIFC(модель) + download).
 *
 * После каждой правки пересчитываются preview-оверлей и stats (стены/проёмы/площадь).
 *
 * API: window.__lxS2BEditor = { open, close, isOpen, attach, setModel, getModel, getState,
 *   editMoveWall, editThickness, editWallEnd, editOpeningMove, deleteOpening, addDoor,
 *   snapWall, undo, redo, reset, canUndo, canRedo, modelJson, saveJson, exportEditedIfc,
 *   refreshStats, refreshOverlay, historyLimit }.
 * Для node --test (без DOM) доступны чистые функции через module.exports; панель/оверлей
 * создаются только при вызове open() в окне.
 */
(function () {
  'use strict';

  // ===================== КОНСТАНТЫ =====================
  var STEP_SHIFT = 0.05;        // сдвиг стены по нормали, м
  var STEP_THICK = 0.01;        // толщина, м
  var STEP_END = 0.10;          // удлинение торца, м
  var STEP_OPEN = 0.05;         // проём, м
  var MIN_THICKNESS = 0.05;     // как в движке: толщина клампится 0.05..0.50/0.60
  var MAX_THICKNESS = 0.60;
  var MIN_WALL_LENGTH = 0.30;   // меньше — стена вырождается
  var MIN_OPEN_WIDTH = 0.20;
  var MIN_OPEN_HEIGHT = 0.30;
  var DOOR_W = 0.90;            // «дверь 0.9×2.1» из задания
  var DOOR_H = 2.10;
  var SNAP_BAND = 0.40;         // полоса точек вокруг оси стены, ±м
  var SNAP_MAX_SHIFT = 0.25;    // больше — привязку отклоняем (как в движке)
  var SNAP_MIN_POINTS = 24;     // минимум точек на каждую моду (грань)
  var SNAP_MIN_THICK = 0.03, SNAP_MAX_THICK = 0.70;
  var HISTORY_LIMIT = 30;       // задание: стек снимков ≥ 20
  var SAVE_VERSION = '1233';

  // Палитра оверлея — мягкая тёплая, в тон tokens.css (фиолетовый акцент, без синего).
  var COL_WALL = [0.62, 0.60, 0.57];   // тёплый графит
  var COL_SEL = [0.72, 0.60, 1.00];    // --accent #b9a2ff, выбранная стена
  var COL_OPEN = [0.91, 0.64, 0.30];   // --warn #e8a34c, проёмы
  var COL_ROOM = [0.24, 0.81, 0.56];   // --ok #3ecf8e, помещение
  var COL_FOOT = [0.80, 0.74, 0.52];   // контур этажа

  var MAT_LABEL = {
    brick: 'кирпич', metal: 'металл', concrete: 'бетон', block: 'блок',
    other: 'прочее', unknown: 'не определено', inferred: 'достроена'
  };

  // ===================== МЕЛКИЕ УТИЛИТЫ =====================
  function isFiniteNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x, def) { var v = Number(x); return isFinite(v) ? v : (def == null ? 0 : def); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function fmt(x, d) { return isFiniteNum(x) ? (+x).toFixed(d == null ? 2 : d) : '—'; }
  function nfmt(x, d) { return isFiniteNum(x) ? fmt(x, d) : '—'; }
  function cloneJson(x) { return JSON.parse(JSON.stringify(x)); }
  function isModelOk(m) { return !!(m && m.ok && (m.walls || m.storeys || m.rooms)); }
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

  // ===================== МОДЕЛЬ: СТЕНЫ / ПРОЁМЫ =====================
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
  // Нормаль к оси стены в плане: n = (-dz, dx) — как в scan2bim.js/JSON-экспорте.
  function wallNormal(w) { var d = unitDir(w); return [-d[1], d[0]]; }
  function wallLength(w) {
    if (!w || !w.a || !w.b) return num(w && w.length);
    return Math.hypot(num(w.b[0]) - num(w.a[0]), num(w.b[1]) - num(w.a[1]));
  }
  function wallHeight(w) {
    if (!w) return 3;
    if (isFiniteNum(w.height) && w.height > 0.3) return w.height;
    if (isFiniteNum(w.top) && isFiniteNum(w.base)) return Math.max(0.5, w.top - w.base);
    return 3;
  }
  function wallBase(w) { return w ? num(w.base) : 0; }
  function renormalizeWall(w) {
    if (!w) return;
    var dx = num(w.b[0]) - num(w.a[0]), dz = num(w.b[1]) - num(w.a[1]);
    var len = Math.hypot(dx, dz);
    w.length = len;
    if (len > 1e-9) {
      w.dir = [dx / len, dz / len];
      w.angleDeg = Math.atan2(dz, dx) * 180 / Math.PI;
    }
    if (!isFiniteNum(w.height) || w.height <= 0) w.height = wallHeight(w);
    if (!isFiniteNum(w.base)) w.base = 0;
    w.top = num(w.base) + wallHeight(w);
    if (!w.openings) w.openings = [];
  }
  function openingsOf(w) { return (w && w.openings) || []; }
  function getWall(model, index) {
    if (!model || !model.walls) return null;
    var i = Number(index);
    if (!isFinite(i) || i < 0 || i >= model.walls.length) return null;
    return model.walls[i | 0];
  }
  function wallMaterialLabel(w) {
    if (!w) return '—';
    return MAT_LABEL[w.material] || (w.material ? String(w.material) : 'не определено');
  }
  function openingKindLabel(o) {
    if (!o) return 'проём';
    if (o.kind === 'door') return 'дверь';
    if (o.kind === 'window') return 'окно';
    if (o.kind === 'opening') return 'проход';
    return 'проём';
  }
  // Вертикальные границы проёма, если sill/head не заданы (как wallOpeningVerticalBounds движка).
  function openingVertical(o, w) {
    var H = wallHeight(w);
    if (o && o.kind === 'opening') {
      var head0 = Math.min(Math.max(0.5, H - 0.05), 2.1);
      return { sill: 0, head: head0 };
    }
    var sill = isFiniteNum(o && o.sill) ? num(o.sill) : 0;
    var head = isFiniteNum(o && o.head) ? num(o.head) : Math.min(H - 0.03, 2.1);
    sill = clamp(sill, 0, H);
    head = clamp(head, sill, H);
    return { sill: sill, head: head };
  }

  // ===================== ПРАВКИ СТЕН =====================
  function fail(reason) { return { ok: false, reason: reason || 'операция отклонена' }; }
  function okInfo(extra) {
    var r = { ok: true };
    if (extra) for (var k in extra) r[k] = extra[k];
    return r;
  }

  /**
   * Сдвиг стены по нормали.
   * @param {object} model — модель Scan2BIM
   * @param {number} index — индекс стены
   * @param {number} delta — смещение вдоль n=(-dz,dx), м (для UI ±0.05)
   * @returns {{ok:boolean, reason?:string, shift?:number}}
   */
  function editMoveWall(model, index, delta) {
    var w = getWall(model, index);
    if (!w) return fail('стена не найдена');
    var d = num(delta);
    if (!isFiniteNum(d) || Math.abs(d) < 1e-9) return fail('нулевой сдвиг');
    beginEdit(model);
    var n = wallNormal(w);
    w.a = [num(w.a[0]) + n[0] * d, num(w.a[1]) + n[1] * d];
    w.b = [num(w.b[0]) + n[0] * d, num(w.b[1]) + n[1] * d];
    renormalizeWall(w);
    afterEdit(model, 'Стена ' + ((Number(index) | 0) + 1) + ': сдвиг ' + fmt(d, 2) + ' м по нормали');
    return okInfo({ shift: d, index: Number(index) });
  }

  /** Толщина стены: delta ±0.01 м, клампится в [0.05, 0.60]. */
  function editThickness(model, index, delta) {
    var w = getWall(model, index);
    if (!w) return fail('стена не найдена');
    var d = num(delta);
    if (!isFiniteNum(d) || Math.abs(d) < 1e-9) return fail('нулевое изменение толщины');
    var cur = num(w.thickness, 0.15);
    var next = clamp(cur + d, MIN_THICKNESS, MAX_THICKNESS);
    if (Math.abs(next - cur) < 1e-9) return fail('предел толщины ' + fmt(MIN_THICKNESS, 2) + '…' + fmt(MAX_THICKNESS, 2) + ' м');
    beginEdit(model);
    w.thickness = Math.round(next * 1000) / 1000;
    afterEdit(model, 'Стена ' + ((Number(index) | 0) + 1) + ': толщина ' + fmt(w.thickness, 2) + ' м');
    return okInfo({ thickness: w.thickness, index: Number(index) });
  }

  /**
   * Удлинение/укорочение торца стены вдоль её оси.
   * @param {string} side — 'a' (начало) или 'b' (конец)
   * @param {number} delta — >0 удлиняет, <0 укорачивает, м (для UI ±0.1)
   */
  function editWallEnd(model, index, side, delta) {
    var w = getWall(model, index);
    if (!w) return fail('стена не найдена');
    var d = num(delta);
    if (!isFiniteNum(d) || Math.abs(d) < 1e-9) return fail('нулевое изменение длины');
    var dir = unitDir(w), L = wallLength(w);
    var nextLength = L + d;
    if (nextLength < MIN_WALL_LENGTH) return fail('минимальная длина стены ' + fmt(MIN_WALL_LENGTH, 2) + ' м');
    var startSide = (String(side) === 'a');
    var ops = openingsOf(w);
    // при удлинении начала координата along проёма не должна «уехать» в мир —
    // смещение along сохраняет физическое положение проёма.
    var alongShift = startSide ? d : 0;
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      var s = clamp(num(o.along) + alongShift, 0, Math.max(0, nextLength - num(o.width, MIN_OPEN_WIDTH)));
      if (Math.abs(s - (num(o.along) + alongShift)) > 1e-6) return fail('проём не помещается в новую длину стены');
    }
    beginEdit(model);
    var a = [num(w.a[0]), num(w.a[1])], b = [num(w.b[0]), num(w.b[1])];
    if (startSide) { w.a = [a[0] - dir[0] * d, a[1] - dir[1] * d]; }
    else { w.b = [b[0] + dir[0] * d, b[1] + dir[1] * d]; }
    for (var j = 0; j < ops.length; j++) ops[j].along = num(ops[j].along) + alongShift;
    renormalizeWall(w);
    afterEdit(model, 'Стена ' + ((Number(index) | 0) + 1) + ': торец ' + (startSide ? 'a' : 'b') + ' ' +
      (d > 0 ? '+' : '') + fmt(d, 2) + ' м, длина ' + fmt(w.length, 2) + ' м');
    return okInfo({ length: w.length, side: startSide ? 'a' : 'b', delta: d, index: Number(index) });
  }

  // ===================== ПРАВКИ ПРОЁМОВ =====================
  function getOpening(model, wallIndex, opIndex) {
    var w = getWall(model, wallIndex);
    if (!w) return null;
    var ops = openingsOf(w), i = Number(opIndex);
    if (!isFinite(i) || i < 0 || i >= ops.length) return null;
    return ops[i | 0];
  }

  /**
   * Правка проёма: prop = along|width|sill|head, delta ±0.05 м.
   * along — от начала стены (a); sill/head — от base стены (как в scan2bim.js).
   */
  function editOpeningMove(model, wallIndex, opIndex, prop, delta) {
    var w = getWall(model, wallIndex), o = getOpening(model, wallIndex, opIndex);
    if (!w || !o) return fail('проём не найден');
    var d = num(delta);
    if (!isFiniteNum(d) || Math.abs(d) < 1e-9) return fail('нулевое изменение проёма');
    var L = wallLength(w), H = wallHeight(w);
    var along = clamp(num(o.along), 0, Math.max(0, L - num(o.width, MIN_OPEN_WIDTH)));
    var width = clamp(num(o.width, DOOR_W), MIN_OPEN_WIDTH, Math.max(MIN_OPEN_WIDTH, L - along));
    var vert = openingVertical(o, w), sill = vert.sill, head = vert.head;
    var next;
    switch (String(prop)) {
      case 'along':
        next = clamp(along + d, 0, Math.max(0, L - width));
        if (Math.abs(next - along) < 1e-9) return fail('проём у края стены');
        beginEdit(model); o.along = next; break;
      case 'width':
        next = clamp(width + d, MIN_OPEN_WIDTH, Math.max(MIN_OPEN_WIDTH, L - along));
        if (Math.abs(next - width) < 1e-9) return fail('предел ширины проёма');
        beginEdit(model); o.width = next; break;
      case 'sill':
        next = clamp(sill + d, 0, Math.max(0, head - MIN_OPEN_HEIGHT));
        if (Math.abs(next - sill) < 1e-9) return fail('предел подоконника');
        beginEdit(model); o.sill = next; break;
      case 'head':
        next = clamp(head + d, Math.min(H, sill + MIN_OPEN_HEIGHT), H);
        if (Math.abs(next - head) < 1e-9) return fail('предел верха проёма');
        beginEdit(model); o.head = next; break;
      default: return fail('неизвестное поле проёма: ' + prop);
    }
    if (!isFiniteNum(o.sill) && prop === 'head') o.sill = sill;
    afterEdit(model, 'Проём ' + ((Number(opIndex) | 0) + 1) + ' на стене ' + ((Number(wallIndex) | 0) + 1) +
      ': ' + prop + ' = ' + fmt(num(o[prop]), 2) + ' м');
    return okInfo({ index: Number(opIndex), wall: Number(wallIndex), prop: String(prop), value: num(o[prop]) });
  }

  /** Удалить проём. */
  function deleteOpening(model, wallIndex, opIndex) {
    var w = getWall(model, wallIndex);
    if (!w) return fail('стена не найдена');
    var ops = openingsOf(w), i = Number(opIndex);
    if (!isFinite(i) || i < 0 || i >= ops.length) return fail('проём не найден');
    beginEdit(model);
    ops.splice(i | 0, 1);
    afterEdit(model, 'Проём ' + ((i | 0) + 1) + ' удалён');
    return okInfo({ wall: Number(wallIndex), removed: i | 0 });
  }

  // Свободный интервал along шириной width; возвращает позицию начала или null.
  function freeSpan(w, width) {
    var L = wallLength(w), ops = openingsOf(w).slice().sort(function (a, b) { return num(a.along) - num(b.along); });
    var gaps = [], cur = 0;
    for (var i = 0; i < ops.length; i++) {
      var s = clamp(num(ops[i].along), 0, L), e = clamp(num(ops[i].along) + num(ops[i].width), 0, L);
      if (s - cur >= width) gaps.push([cur, s]);
      if (e > cur) cur = e;
    }
    if (L - cur >= width) gaps.push([cur, L]);
    if (!gaps.length) return null;
    // ближе к середине стены — привычнее для двери
    var best = null, bestD = Infinity;
    for (var g = 0; g < gaps.length; g++) {
      var gs = gaps[g][0], ge = gaps[g][1], start = gs + (ge - gs - width) / 2, mid = start + width / 2;
      var dd = Math.abs(mid - L / 2);
      if (dd < bestD) { bestD = dd; best = start; }
    }
    return best;
  }

  /** Добавить дверь 0.90×2.10 в свободное место стены. */
  function addDoor(model, wallIndex) {
    var w = getWall(model, wallIndex);
    if (!w) return fail('стена не найдена');
    var L = wallLength(w), H = wallHeight(w);
    if (L < MIN_WALL_LENGTH) return fail('стена слишком короткая для двери');
    var doorW = Math.min(DOOR_W, Math.max(MIN_OPEN_WIDTH, L - 2 * MIN_OPEN_WIDTH));
    var doorH = Math.min(DOOR_H, H - 0.03);
    if (doorH < MIN_OPEN_HEIGHT) return fail('стена слишком низкая для двери');
    var start = freeSpan(w, doorW);
    if (start == null) return fail('на стене нет свободного места для двери ' + fmt(doorW, 2) + ' м');
    beginEdit(model);
    if (!w.openings) w.openings = [];
    var door = { along: start, width: doorW, sill: 0, head: doorH, kind: 'door' };
    w.openings.push(door);
    w.openings.sort(function (a, b) { return num(a.along) - num(b.along); });
    var idx = w.openings.indexOf(door);
    afterEdit(model, 'Добавлена дверь ' + fmt(doorW, 2) + '×' + fmt(doorH, 2) + ' м на стене ' +
      ((Number(wallIndex) | 0) + 1));
    return okInfo({ wall: Number(wallIndex), opening: idx, along: start, width: doorW, head: doorH });
  }

  // ===================== ПРИВЯЗКА К ОБЛАКУ =====================
  // Одномерные две моды (k-means по перпендикуляру от оси): две грани стены.
  function twoModeMedians(values) {
    if (!values || values.length < 4) return null;
    var mn = Infinity, mx = -Infinity, i;
    for (i = 0; i < values.length; i++) { if (values[i] < mn) mn = values[i]; if (values[i] > mx) mx = values[i]; }
    if (!(mx - mn > 1e-6)) return null;
    var c1 = mn + (mx - mn) * 0.25, c2 = mn + (mx - mn) * 0.75;
    var g1 = [], g2 = [];
    for (var it = 0; it < 12; it++) {
      g1 = []; g2 = [];
      for (i = 0; i < values.length; i++) {
        if (Math.abs(values[i] - c1) <= Math.abs(values[i] - c2)) g1.push(values[i]);
        else g2.push(values[i]);
      }
      if (!g1.length || !g2.length) return null;
      var m1 = median(g1), m2 = median(g2), nc1 = m1, nc2 = m2;
      if (nc1 === c1 && nc2 === c2) { c1 = nc1; c2 = nc2; break; }
      c1 = nc1; c2 = nc2;
    }
    var med1 = median(g1), med2 = median(g2);
    var lo = Math.min(med1, med2), hi = Math.max(med1, med2);
    var loGroup = med1 <= med2 ? g1 : g2, hiGroup = med1 <= med2 ? g2 : g1;
    return { lo: lo, hi: hi, loGroup: loGroup, hiGroup: hiGroup };
  }
  function median(arr) {
    if (!arr || !arr.length) return NaN;
    var s = arr.slice().sort(function (a, b) { return a - b; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // Обход точек облака: принимает Float32Array xyz, массив [x,y,z] и { pos }-чанк.
  function eachCloudPoint(cloud, cb) {
    if (!cloud) return 0;
    if (cloud.pos && cloud.pos.length) cloud = cloud.pos;
    var n = cloud.length | 0, cnt = 0, i;
    if (!n) return 0;
    if (typeof cloud[0] === 'number') {
      var step = 3;
      if (n > 1500000) { step = Math.ceil(n / 1500000) * 3; }
      for (i = 0; i + 2 < n; i += step) {
        var x = cloud[i], y = cloud[i + 1], z = cloud[i + 2];
        if (isFiniteNum(x) && isFiniteNum(y) && isFiniteNum(z)) { if (cb(x, y, z)) cnt++; }
      }
    } else {
      var st = n > 500000 ? Math.ceil(n / 500000) : 1;
      for (i = 0; i < n; i += st) {
        var p = cloud[i];
        if (p && p.length >= 3) {
          var px = +p[0], py = +p[1], pz = +p[2];
          if (isFinite(px) && isFinite(py) && isFinite(pz)) { if (cb(px, py, pz)) cnt++; }
        }
      }
    }
    return cnt;
  }

  /**
   * Привязка оси стены к облаку (медианы по двум модам — двум граням).
   * Точки берутся в полосе ±0.40 м от оси (локальный кадр вьюера, Y вверх).
   * Сдвиг применяется только если |смещение| ≤ 0.25 м; толщина — 0.03..0.70 м.
   * @param {object} model
   * @param {number} index — индекс стены
   * @param {Float32Array|Array|{pos:Float32Array}} cloud — точки (v.base[0].pos)
   */
  function snapWall(model, index, cloud) {
    var w = getWall(model, index);
    if (!w) return fail('стена не найдена');
    if (!cloud || !cloud.length) return fail('нет точек облака для привязки');
    var dir = unitDir(w), nrm = wallNormal(w);
    var a = [num(w.a[0]), num(w.a[1])], L = wallLength(w), base = wallBase(w), H = wallHeight(w);
    var sLo = Math.min(0.10, L * 0.1), sHi = Math.max(sLo, L - Math.min(0.10, L * 0.1));
    var yLo = base + 0.15, yHi = base + H - 0.15;
    if (yHi <= yLo) { yLo = base; yHi = base + H; }
    var offsets = [];
    var seen = eachCloudPoint(cloud, function (x, y, z) {
      if (y < yLo || y > yHi) return false;
      var px = x - a[0], pz = z - a[1];
      var s = px * dir[0] + pz * dir[1];
      if (s < sLo || s > sHi) return false;
      var t = px * nrm[0] + pz * nrm[1];
      if (t < -SNAP_BAND || t > SNAP_BAND) return false;
      offsets.push(t);
      return true;
    });
    if (seen < SNAP_MIN_POINTS * 2) return fail('мало точек облака у стены (' + seen + ')');
    var modes = twoModeMedians(offsets);
    if (!modes || modes.loGroup.length < SNAP_MIN_POINTS || modes.hiGroup.length < SNAP_MIN_POINTS) {
      return fail('не удалось выделить две грани стены в облаке');
    }
    var center = (modes.lo + modes.hi) / 2;
    var thick = modes.hi - modes.lo;
    if (!(thick > SNAP_MIN_THICK && thick < SNAP_MAX_THICK)) {
      return fail('толщина по облаку вне допуска: ' + fmt(thick, 3) + ' м');
    }
    if (Math.abs(center) > SNAP_MAX_SHIFT) {
      return fail('смещение ' + fmt(center, 3) + ' м > ' + fmt(SNAP_MAX_SHIFT, 2) + ' м — привязка отклонена');
    }
    beginEdit(model);
    w.a = [a[0] + nrm[0] * center, a[1] + nrm[1] * center];
    w.b = [num(w.b[0]) + nrm[0] * center, num(w.b[1]) + nrm[1] * center];
    w.thickness = Math.round(clamp(thick, MIN_THICKNESS, MAX_THICKNESS) * 1000) / 1000;
    w.snapped = (num(w.snapped) || 0) + 1;   // след правки для «Сохранить JSON»
    renormalizeWall(w);
    afterEdit(model, 'Стена ' + ((Number(index) | 0) + 1) + ' привязана к облаку: сдвиг ' +
      fmt(center, 3) + ' м, толщина ' + fmt(w.thickness, 2) + ' м');
    return okInfo({
      index: Number(index), shift: center, thickness: w.thickness,
      points: seen, bands: { lo: modes.loGroup.length, hi: modes.hiGroup.length }
    });
  }

  // ===================== ИСТОРИЯ (UNDO / REDO / RESET) =====================
  var st = {
    model: null,
    initialJson: null,
    undo: [],
    redo: [],
    wall: 0,
    opening: -1,
    room: -1,
    status: '',
    snapStatus: '',
    panel: null,
    keyOn: false
  };

  function modelSnapshot(model) { try { return JSON.stringify(model || st.model); } catch (e) { return null; } }

  // Стек снимков: JSON.stringify(model), новые правки обнуляют redo.
  function pushHistory() {
    if (!st.model) return false;
    var snap = modelSnapshot(st.model);
    if (!snap) return false;
    if (st.undo.length && st.undo[st.undo.length - 1] === snap) return true;
    st.undo.push(snap);
    while (st.undo.length > HISTORY_LIMIT) st.undo.shift();
    st.redo.length = 0;
    return true;
  }

  function assignModel(target, data) {
    var k;
    for (k in target) { if (Object.prototype.hasOwnProperty.call(target, k)) delete target[k]; }
    for (k in data) { if (Object.prototype.hasOwnProperty.call(data, k)) target[k] = data[k]; }
  }

  function beginEdit(model) {
    if (st.model && model === st.model) return pushHistory();
    return false;
  }

  function restoreSnapshot(json) {
    if (!st.model || !json) return false;
    assignModel(st.model, JSON.parse(json));
    ensureSelection();
    return true;
  }

  /** Отменить последнюю правку. */
  function undo() {
    if (!st.model || !st.undo.length) return false;
    var cur = modelSnapshot(st.model);
    if (cur) st.redo.push(cur);
    var snap = st.undo.pop();
    if (!restoreSnapshot(snap)) return false;
    afterEdit(st.model, 'Отменено (undo)');
    return true;
  }

  /** Повторить отменённую правку. */
  function redo() {
    if (!st.model || !st.redo.length) return false;
    var cur = modelSnapshot(st.model);
    if (cur) st.undo.push(cur);
    if (st.undo.length > HISTORY_LIMIT) st.undo.shift();
    var snap = st.redo.pop();
    if (!restoreSnapshot(snap)) return false;
    afterEdit(st.model, 'Повторено (redo)');
    return true;
  }

  /** Сбросить все правки к модели, с которой редактор был открыт. */
  function reset() {
    if (!st.model || !st.initialJson) return false;
    pushHistory();
    if (!restoreSnapshot(st.initialJson)) return false;
    st.snapStatus = '';
    afterEdit(st.model, 'Модель сброшена к исходной (правки в памяти)');
    return true;
  }

  function canUndo() { return !!(st.model && st.undo.length); }
  function canRedo() { return !!(st.model && st.redo.length); }

  // ===================== СТАТИСТИКА =====================
  // Пересчёт сводки после правок: стены/проёмы/помещения/длина/площадь.
  function refreshStats(model) {
    var m = model || st.model;
    if (!m) return null;
    var walls = m.walls || [], rooms = m.rooms || [];
    var openings = 0, totalLen = 0;
    for (var i = 0; i < walls.length; i++) {
      openings += openingsOf(walls[i]).length;
      totalLen += wallLength(walls[i]);
    }
    var roomsArea = 0;
    for (var r = 0; r < rooms.length; r++) roomsArea += num(rooms[r].area, polyArea(rooms[r].polygon));
    var s = m.stats || (m.stats = {});
    s.wallCount = walls.length;
    s.openingCount = openings;
    s.roomCount = rooms.length;
    s.roomsArea = Math.round(roomsArea * 1000) / 1000;
    s.totalWallLength = Math.round(totalLen * 1000) / 1000;
    if (!isFiniteNum(s.floorArea)) s.floorArea = Math.round(polyArea(m.footprint) * 1000) / 1000 || 0;
    return s;
  }

  // ===================== ЭКСПОРТ =====================
  function engineOf() {
    if (typeof window !== 'undefined' && window.Scan2BIM) return window.Scan2BIM;
    if (typeof globalThis !== 'undefined' && globalThis.Scan2BIM) return globalThis.Scan2BIM;
    // Запасной путь только для node --test: в окне require нет (nodeIntegration=false).
    if (typeof require === 'function') { try { return require('./scan2bim.js'); } catch (e) { } }
    return null;
  }

  /**
   * IFC4 по текущей (отредактированной) модели — через window.Scan2BIM.toIFC.
   * @returns {string} STEP-текст
   */
  function exportEditedIfc(model, meta) {
    var m = model || st.model;
    if (!isModelOk(m)) throw new Error('модель не построена');
    var S = engineOf();
    if (!S || typeof S.toIFC !== 'function') throw new Error('движок Scan2BIM.toIFC не загружен');
    var opts = { name: 'scan2bim-edited.ifc', includeBeams: false, includePipes: false };
    if (meta && typeof meta === 'object') for (var k in meta) if (Object.prototype.hasOwnProperty.call(meta, k)) opts[k] = meta[k];
    return S.toIFC(m, opts);
  }

  function modelJson(model) {
    var m = model || st.model;
    if (!m) return null;
    try { return JSON.stringify(m, null, 2); } catch (e) { return null; }
  }

  function downloadText(text, name, mime) {
    if (typeof document === 'undefined') return false;
    try {
      var blob = new Blob([text], { type: mime || 'text/plain' });
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

  /** «Сохранить JSON» — отредактированная модель в файл scan2bim-edited.json. */
  function saveJson(model) {
    var text = modelJson(model);
    if (!text) return false;
    return downloadText(text, 'scan2bim-edited.json', 'application/json');
  }

  // ===================== DOM: ПАНЕЛЬ И ОВЕРЛЕЙ =====================
  function mainV() {
    try {
      if (typeof window === 'undefined') return null;
      if (window.__pcTools && window.__pcTools.viewer) return window.__pcTools.viewer();
      return window.__viewer || null;
    } catch (e) { return null; }
  }
  function toast(msg, err) {
    try {
      if (typeof window !== 'undefined' && window.__toast) return window.__toast(msg, err ? 'error' : 'info');
    } catch (e) { }
    if (typeof console !== 'undefined') console[err ? 'error' : 'log']('[scan2bim-editor] ' + msg);
  }
  function hydrate(scope) {
    try {
      if (typeof window === 'undefined') return;
      if (window.__lxKit && window.__lxKit.hydrate) return window.__lxKit.hydrate(scope);
      if (window.__lxIcons && window.__lxIcons.hydrate) return window.__lxIcons.hydrate(scope);
    } catch (e) { }
  }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  function cloudPoints() {
    var v = mainV();
    if (!v || !v.base) return null;
    for (var i = 0; i < v.base.length; i++) {
      var o = v.base[i];
      if (o && o.pos && o.pos.length) return o.pos;
    }
    return null;
  }

  // Линии граней стены (12 рёбер бокса) — как showPreview в lixel-scan2bim-ui.js.
  function boxEdgesXform(cx, cy, cz, ax, ay, hx, hy, hz, out) {
    var nx = -ay, nz = ax;
    function V(sx, sy, sz) { return [cx + ax * sx * hx + nx * sz * hz, cy + sy * hy, cz + ay * sx * hx + nz * sz * hz]; }
    var c = [V(-1, -1, -1), V(1, -1, -1), V(1, -1, 1), V(-1, -1, 1), V(-1, 1, -1), V(1, 1, -1), V(1, 1, 1), V(-1, 1, 1)];
    var E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (var i = 0; i < E.length; i++) {
      var a = c[E[i][0]], b = c[E[i][1]];
      out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
  }
  function pushWallEdges(w, out) {
    var d = unitDir(w), L = wallLength(w), H = wallHeight(w);
    var mx = (num(w.a[0]) + num(w.b[0])) / 2, mz = (num(w.a[1]) + num(w.b[1])) / 2;
    boxEdgesXform(mx, wallBase(w) + H / 2, mz, d[0], d[1], L / 2, H / 2, Math.max(0.02, num(w.thickness, 0.15)) / 2, out);
  }
  function pushOpeningEdges(w, o, out) {
    var d = unitDir(w), L = wallLength(w), H = wallHeight(w), vert = openingVertical(o, w);
    var s0 = clamp(num(o.along), 0, L), s1 = clamp(num(o.along) + num(o.width), 0, L);
    var sill = clamp(vert.sill, 0, H), head = clamp(vert.head, sill, H);
    var a = w.a, base = wallBase(w);
    function P(s, y) { return [num(a[0]) + d[0] * s, base + y, num(a[1]) + d[1] * s]; }
    var pts = [P(s0, sill), P(s1, sill), P(s1, head), P(s0, head)];
    for (var i = 0; i < 4; i++) {
      var p = pts[i], q = pts[(i + 1) % 4];
      out.push(p[0], p[1], p[2], q[0], q[1], q[2]);
    }
  }
  function overlayColors() {
    return { wall: COL_WALL, sel: COL_SEL, open: COL_OPEN, room: COL_ROOM, foot: COL_FOOT };
  }

  // Перерисовать 3D-оверлей: все стены каркасом, выбранная — акцентом, проёмы/помещение.
  function refreshOverlay() {
    var v = mainV();
    if (!v || !v._setOverlay) return false;
    var model = isModelOk(st.model) ? st.model : null;
    var objs = [];
    try {
      if (model) {
        var walls = model.walls || [], wallPos = [], selPos = [], openPos = [];
        var selWall = getWall(model, st.wall);
        for (var i = 0; i < walls.length; i++) {
          if (walls[i] === selWall) continue;
          pushWallEdges(walls[i], wallPos);
        }
        if (wallPos.length) objs.push({ line: true, gkind: 'wire', pos: new Float32Array(wallPos), color: overlayColors().wall });
        if (selWall) {
          pushWallEdges(selWall, selPos);
          var d = unitDir(selWall), n = wallNormal(selWall);
          var L = wallLength(selWall), H = wallHeight(selWall), base = wallBase(selWall);
          var mx = (num(selWall.a[0]) + num(selWall.b[0])) / 2, mz = (num(selWall.a[1]) + num(selWall.b[1])) / 2;
          var cy = base + Math.min(H * 0.35, 1.1);
          // стрелка нормали: показывает, куда двигают стену кнопки «±0.05»
          selPos.push(mx, cy, mz, mx + n[0] * 0.6, cy, mz + n[1] * 0.6);
          selPos.push(mx + n[0] * 0.6, cy, mz + n[1] * 0.6, mx + n[0] * 0.45 + d[0] * 0.12, cy, mz + n[1] * 0.45 + d[1] * 0.12);
          selPos.push(mx + n[0] * 0.6, cy, mz + n[1] * 0.6, mx + n[0] * 0.45 - d[0] * 0.12, cy, mz + n[1] * 0.45 - d[1] * 0.12);
          var ops = openingsOf(selWall);
          var selOp = getOpening(model, st.wall, st.opening);
          for (var j = 0; j < ops.length; j++) {
            if (ops[j] === selOp) continue;
            pushOpeningEdges(selWall, ops[j], openPos);
          }
          if (selOp) pushOpeningEdges(selWall, selOp, openPos);
          if (openPos.length) objs.push({ line: true, gkind: 'wire', pos: new Float32Array(openPos), color: overlayColors().open });
          objs.push({ line: true, gkind: 'wire', pos: new Float32Array(selPos), color: overlayColors().sel });
        }
        // выбранное помещение — контур на уровне пола и потолка
        var room = model.rooms && st.room >= 0 ? model.rooms[st.room] : null;
        if (room && room.polygon && room.polygon.length >= 3) {
          var fY = num(model.storey && model.storey.floorY, 0), cY = num(model.storey && model.storey.ceilY, fY + 3);
          var rp = [];
          for (var k = 0; k < room.polygon.length; k++) {
            var p1 = room.polygon[k], p2 = room.polygon[(k + 1) % room.polygon.length];
            rp.push(p1[0], fY + 0.01, p1[1], p2[0], fY + 0.01, p2[1]);
            rp.push(p1[0], cY, p1[1], p2[0], cY, p2[1]);
          }
          objs.push({ line: true, gkind: 'wire', pos: new Float32Array(rp), color: overlayColors().room });
        }
        // контур этажа
        var foot = model.footprint || [];
        if (foot.length > 1) {
          var fp = [], ffY = num(model.storey && model.storey.floorY, 0), fcY = num(model.storey && model.storey.ceilY, ffY + 3);
          for (var fi = 0; fi < foot.length; fi++) {
            var fa = foot[fi], fb = foot[(fi + 1) % foot.length];
            fp.push(fa[0], ffY, fa[1], fb[0], ffY, fb[1]);
          }
          objs.push({ line: true, gkind: 'wire', pos: new Float32Array(fp), color: overlayColors().foot });
        }
      }
      v._setOverlay(objs);
      if (v.render) v.render();
      return true;
    } catch (e) {
      try { v._setOverlay([]); } catch (e2) { }
      return false;
    }
  }

  function clearOverlay() {
    var v = mainV();
    if (!v || !v._setOverlay) return;
    try { v._setOverlay([]); if (v.render) v.render(); } catch (e) { }
  }

  // ---------- стили (только токены tokens.css, без синего/белого/градиентов) ----------
  var CSS_ID = 'lxS2BEditorStyles';
  var CSS = [
    '.lx-s2be.fpanel { width: 340px; }',
    '.lx-s2be .fpanel-body { display: flex; flex-direction: column; gap: 6px; }',
    '.lx-s2be .lx-stats-h { color: var(--accent); }',
    '.lx-s2be-list { display: flex; flex-direction: column; gap: 2px; max-height: 168px; overflow: auto; padding: 3px; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--bg-2); }',
    '.lx-s2be-item { display: flex; flex: 1; align-items: center; gap: 8px; width: 100%; min-height: 30px; padding: 0 8px; border: 0; border-radius: var(--r-1); background: transparent; color: var(--txt-2); font: 500 var(--fs-sm)/1.25 var(--font); text-align: left; cursor: pointer; transition: background var(--t-fast), color var(--t-fast); }',
    '.lx-s2be-item:hover { background: var(--bg-3); color: var(--txt); }',
    '.lx-s2be-item[aria-selected="true"] { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); color: var(--txt); }',
    '.lx-s2be-item:focus-visible { outline: 1px solid var(--accent-line); outline-offset: -1px; }',
    '.lx-s2be-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }',
    '.lx-s2be-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.lx-s2be-item small { flex: none; color: var(--txt-3); font: 11px/1 var(--mono); font-variant-numeric: tabular-nums; }',
    '.lx-s2be-edit { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; padding: 10px; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--bg-2); }',
    '.lx-s2be-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; margin-bottom: 2px; color: var(--txt); font-size: var(--fs-sm); font-weight: 600; }',
    '.lx-s2be-title small { color: var(--txt-3); font: 11px/1.3 var(--mono); font-variant-numeric: tabular-nums; }',
    '.lx-s2be-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 26px; color: var(--txt-2); font-size: var(--fs-sm); }',
    '.lx-s2be-lbl { min-width: 0; }',
    '.lx-s2be-btns { display: inline-flex; flex: none; align-items: center; gap: 4px; }',
    '.lx-s2be-btns .btn.xs { min-width: 44px; padding: 0 6px; font-variant-numeric: tabular-nums; }',
    '.lx-s2be-val { min-width: 62px; color: var(--txt); font: 12px/1 var(--mono); font-variant-numeric: tabular-nums; text-align: center; }',
    '.lx-s2be-orow { display: flex; align-items: center; gap: 2px; }',
    '.lx-s2be-orow .lx-s2be-item { min-width: 0; }',
    '.lx-s2be-note { margin: 4px 0 0; color: var(--txt-3); font-size: var(--fs-xs); line-height: 1.45; }',
    '.lx-s2be-note:empty { display: none; }',
    '.lx-s2be-snap { color: var(--ok); }',
    '.lx-s2be-snap.err { color: var(--warn); }',
    '.lx-s2be-sep { margin: 8px 0 0; padding-top: 8px; border-top: 1px solid var(--line); }',
    '.lx-s2be .lx-btnrow { margin-top: 2px; }',
    '.lx-s2be .lx-btnrow .btn { flex: 1 1 auto; }'
  ].join('\n');

  function ensureStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(CSS_ID)) return;
    var s = document.createElement('style');
    s.id = CSS_ID;
    s.textContent = CSS;
    (document.head || document.documentElement || document.body).appendChild(s);
  }

  // ---------- состояние выбора ----------
  function ensureSelection() {
    var model = isModelOk(st.model) ? st.model : null;
    if (!model) { st.wall = 0; st.opening = -1; st.room = -1; return; }
    var nWalls = (model.walls || []).length;
    st.wall = nWalls ? clamp(Number(st.wall) | 0, 0, nWalls - 1) : 0;
    var w = getWall(model, st.wall);
    var nOps = w ? openingsOf(w).length : 0;
    st.opening = nOps ? clamp(Number(st.opening) | 0, 0, nOps - 1) : -1;
    var nRooms = (model.rooms || []).length;
    if (!nRooms) st.room = -1;
    else if (st.room >= nRooms) st.room = nRooms - 1;
    else if (st.room < -1) st.room = -1;
  }

  // ---------- разметка панели ----------
  // data-контракт (стабильный, по нему же проверяет r110-scan2bim-editor.test.js):
  //   data-lx-edit="panel|body|walls|wall-edit|openings|opening-edit|rooms|stats|actions|status|snap-status"
  //   data-wall-index / data-room-index / data-opening-index — выбор элемента списка
  //   data-act="undo|redo|wall-move|wall-thick|wall-end|snap|op-move|op-del|op-add-door|reset|save-json|export-ifc"
  function wallItemHtml(w, i) {
    var sel = (i === st.wall);
    return '<button type="button" class="lx-s2be-item" role="option" data-wall-index="' + i + '"' +
      ' aria-selected="' + (sel ? 'true' : 'false') + '">' +
      '<span class="lx-s2be-dot" aria-hidden="true"></span>' +
      '<span class="lx-s2be-nm">Стена ' + (i + 1) + '</span>' +
      '<small>' + fmt(wallLength(w), 2) + ' м · ' + fmt(num(w.thickness, 0.15), 2) + ' м · ' + wallMaterialLabel(w) + '</small>' +
      '</button>';
  }
  function openingItemHtml(o, j, sel) {
    var vert = openingVertical(o, null);
    return '<div class="lx-s2be-orow" data-opening-row="' + j + '">' +
      '<button type="button" class="lx-s2be-item" role="option" data-opening-index="' + j + '" aria-selected="' + (sel ? 'true' : 'false') + '">' +
      '<span class="lx-s2be-nm">Проём ' + (j + 1) + ' · ' + openingKindLabel(o) + '</span>' +
      '<small>' + fmt(num(o.along), 2) + ' м · ' + fmt(num(o.width), 2) + '×' + fmt(Math.max(0, vert.head - vert.sill), 2) + ' м</small>' +
      '</button>' +
      '<button type="button" class="icon-btn xs danger" data-act="op-del" data-opening-index="' + j + '"' +
      ' data-ico="trash-2" data-tip="Удалить проём" aria-label="Удалить проём ' + (j + 1) + '"></button>' +
      '</div>';
  }
  function roomItemHtml(room, i) {
    var area = num(room.area, polyArea(room.polygon));
    return '<button type="button" class="lx-s2be-item" role="option" data-room-index="' + i + '" aria-selected="' + (i === st.room ? 'true' : 'false') + '">' +
      '<span class="lx-s2be-nm">Помещение ' + (i + 1) + '</span>' +
      '<small>' + fmt(area, 1) + ' м²</small>' +
      '</button>';
  }

  function modelBodyHtml() {
    var m = st.model;
    if (!isModelOk(m)) {
      return '<p class="sec-note" data-lx-edit="hint">Модель ещё не построена. Откройте панель «Скан → BIM», нажмите «Построить BIM» — и вернитесь в редактор.</p>' +
        '<div class="lx-btnrow" data-lx-edit="empty-actions">' +
        '<button type="button" class="btn sm" data-act="open-build" data-ico="building">Открыть «Скан → BIM»</button>' +
        '</div>';
    }
    ensureSelection();
    var walls = m.walls || [], rooms = m.rooms || [];
    var wall = getWall(m, st.wall);
    var ops = wall ? openingsOf(wall) : [];
    var op = getOpening(m, st.wall, st.opening);
    var html = [];

    // подсказка + статистика
    html.push('<p class="sec-note" data-lx-edit="hint">Правки хранятся в памяти приложения. Кнопки двигают выбранную стену; «Привязать к облаку» подгоняет ось и толщину по точкам.</p>');
    var s = refreshStats(m);
    html.push('<div class="lx-stats" data-lx-edit="stats" aria-label="Статистика модели">' +
      '<div class="lx-stat"><span>Стен</span><b>' + num(s.wallCount) + '</b></div>' +
      '<div class="lx-stat"><span>Проёмов</span><b>' + num(s.openingCount) + '</b></div>' +
      '<div class="lx-stat"><span>Помещений</span><b>' + num(s.roomCount) + '</b></div>' +
      '<div class="lx-stat"><span>Площадь помещений</span><b>' + fmt(num(s.roomsArea), 1) + ' м²</b></div>' +
      '<div class="lx-stat"><span>Сумм. длина стен</span><b>' + fmt(num(s.totalWallLength), 1) + ' м</b></div>' +
      '</div>');

    // стены
    html.push('<div class="lx-obj-h">Стены</div>');
    var wallList = ['<div class="lx-s2be-list" role="listbox" aria-label="Стены" data-lx-edit="walls">'];
    for (var i = 0; i < walls.length; i++) wallList.push(wallItemHtml(walls[i], i));
    if (!walls.length) wallList.push('<div class="lx-s2be-note">В модели нет стен</div>');
    wallList.push('</div>');
    html.push(wallList.join(''));

    // правка стены
    if (wall) {
      var d = unitDir(wall);
      html.push('<div class="lx-s2be-edit" data-lx-edit="wall-edit">' +
        '<div class="lx-s2be-title"><b>Стена ' + (st.wall + 1) + '</b>' +
        '<small>L ' + fmt(wallLength(wall), 2) + ' м · T ' + fmt(num(wall.thickness, 0.15), 2) + ' м · ' + wallMaterialLabel(wall) +
        ' · ось ' + fmt(Math.atan2(d[1], d[0]) * 180 / Math.PI, 1) + '°</small></div>' +
        '<div class="lx-s2be-row"><span class="lx-s2be-lbl">Сдвиг по нормали, м</span>' +
        '<span class="lx-s2be-btns">' +
        '<button type="button" class="btn xs" data-act="wall-move" data-delta="-' + STEP_SHIFT + '" data-wall-index="' + st.wall + '" data-tip="Сдвинуть на −' + fmt(STEP_SHIFT) + ' м по нормали">−' + fmt(STEP_SHIFT) + '</button>' +
        '<button type="button" class="btn xs" data-act="wall-move" data-delta="' + STEP_SHIFT + '" data-wall-index="' + st.wall + '" data-tip="Сдвинуть на +' + fmt(STEP_SHIFT) + ' м по нормали">+' + fmt(STEP_SHIFT) + '</button>' +
        '</span></div>' +
        '<div class="lx-s2be-row"><span class="lx-s2be-lbl">Толщина, м</span>' +
        '<span class="lx-s2be-btns">' +
        '<button type="button" class="btn xs" data-act="wall-thick" data-delta="-' + STEP_THICK + '" data-wall-index="' + st.wall + '" data-tip="Уменьшить толщину">−' + fmt(STEP_THICK) + '</button>' +
        '<output class="lx-s2be-val" data-lx-edit="wall-thickness">' + fmt(num(wall.thickness, 0.15), 2) + '</output>' +
        '<button type="button" class="btn xs" data-act="wall-thick" data-delta="' + STEP_THICK + '" data-wall-index="' + st.wall + '" data-tip="Увеличить толщину">+' + fmt(STEP_THICK) + '</button>' +
        '</span></div>' +
        '<div class="lx-s2be-row"><span class="lx-s2be-lbl">Торцы, м</span>' +
        '<span class="lx-s2be-btns">' +
        '<button type="button" class="btn xs" data-act="wall-end" data-side="a" data-delta="-' + STEP_END + '" data-wall-index="' + st.wall + '" data-tip="Укоротить начало">a −</button>' +
        '<button type="button" class="btn xs" data-act="wall-end" data-side="a" data-delta="' + STEP_END + '" data-wall-index="' + st.wall + '" data-tip="Удлинить начало">a +</button>' +
        '<button type="button" class="btn xs" data-act="wall-end" data-side="b" data-delta="-' + STEP_END + '" data-wall-index="' + st.wall + '" data-tip="Укоротить конец">b −</button>' +
        '<button type="button" class="btn xs" data-act="wall-end" data-side="b" data-delta="' + STEP_END + '" data-wall-index="' + st.wall + '" data-tip="Удлинить конец">b +</button>' +
        '</span></div>' +
        '<div class="lx-s2be-row"><span class="lx-s2be-lbl">Привязка к облаку</span>' +
        '<button type="button" class="btn sm" data-act="snap" data-wall-index="' + st.wall + '" data-ico="magnet" data-tip="Подогнать ось и толщину по точкам облака (полоса ±0,4 м)">Привязать к облаку</button>' +
        '</div>' +
        '<p class="lx-s2be-note' + (st.snapStatus && /отклон|мало|вне|не удалось|нет точек/i.test(st.snapStatus) ? ' err' : '') + '" data-lx-edit="snap-status">' + (st.snapStatus || '') + '</p>' +
        '</div>');
    }

    // проёмы
    html.push('<div class="lx-obj-h lx-s2be-sep">Проёмы</div>');
    var opList = ['<div class="lx-s2be-list" role="listbox" aria-label="Проёмы" data-lx-edit="openings">'];
    for (var j = 0; j < ops.length; j++) opList.push(openingItemHtml(ops[j], j, j === st.opening));
    if (!ops.length) opList.push('<div class="lx-s2be-note">На выбранной стене проёмов нет</div>');
    opList.push('</div>');
    html.push(opList.join(''));
    if (op) {
      var vert = openingVertical(op, wall);
      var mvBtn = function (prop, delta, label, tip) {
        return '<button type="button" class="btn xs" data-act="op-move" data-prop="' + prop + '" data-delta="' + delta + '" data-opening-index="' + st.opening + '" data-tip="' + tip + '">' + label + '</button>';
      };
      html.push('<div class="lx-s2be-edit" data-lx-edit="opening-edit" data-sel-opening="' + st.opening + '">' +
        '<div class="lx-s2be-title"><b>Проём ' + (st.opening + 1) + '</b><small>' + openingKindLabel(op) + ' · ' + fmt(num(op.width, DOOR_W), 2) + '×' + fmt(vert.head - vert.sill, 2) + ' м</small></div>' +
        '<div class="lx-s2be-row"><span class="lx-s2be-lbl">Along (от начала)</span><span class="lx-s2be-btns">' +
        mvBtn('along', -STEP_OPEN, '−' + fmt(STEP_OPEN), 'Сдвинуть проём к началу') +
        '<output class="lx-s2be-val" data-lx-edit="op-along">' + fmt(num(op.along), 2) + '</output>' +
        mvBtn('along', STEP_OPEN, '+' + fmt(STEP_OPEN), 'Сдвинуть проём к концу') + '</span></div>' +
        '<div class="lx-s2be-row"><span class="lx-s2be-lbl">Ширина, м</span><span class="lx-s2be-btns">' +
        mvBtn('width', -STEP_OPEN, '−' + fmt(STEP_OPEN), 'Уменьшить ширину') +
        '<output class="lx-s2be-val" data-lx-edit="op-width">' + fmt(num(op.width), 2) + '</output>' +
        mvBtn('width', STEP_OPEN, '+' + fmt(STEP_OPEN), 'Увеличить ширину') + '</span></div>' +
        '<div class="lx-s2be-row"><span class="lx-s2be-lbl">Подоконник, м</span><span class="lx-s2be-btns">' +
        mvBtn('sill', -STEP_OPEN, '−' + fmt(STEP_OPEN), 'Опустить подоконник') +
        '<output class="lx-s2be-val" data-lx-edit="op-sill">' + fmt(vert.sill) + '</output>' +
        mvBtn('sill', STEP_OPEN, '+' + fmt(STEP_OPEN), 'Поднять подоконник') + '</span></div>' +
        '<div class="lx-s2be-row"><span class="lx-s2be-lbl">Верх, м</span><span class="lx-s2be-btns">' +
        mvBtn('head', -STEP_OPEN, '−' + fmt(STEP_OPEN), 'Опустить верх проёма') +
        '<output class="lx-s2be-val" data-lx-edit="op-head">' + fmt(vert.head) + '</output>' +
        mvBtn('head', STEP_OPEN, '+' + fmt(STEP_OPEN), 'Поднять верх проёма') + '</span></div>' +
        '<div class="lx-s2be-row"><button type="button" class="btn sm danger" data-act="op-del" data-opening-index="' + st.opening + '" data-ico="trash-2">Удалить проём</button></div>' +
        '</div>');
    }
    html.push('<div class="lx-btnrow"><button type="button" class="btn sm" data-act="op-add-door" data-wall-index="' + st.wall + '" data-ico="door-open" data-tip="Вставить дверь 0,90×2,10 м в свободное место стены">Добавить дверь 0.9×2.1</button></div>');

    // помещения
    html.push('<div class="lx-obj-h lx-s2be-sep">Помещения</div>');
    var roomList = ['<div class="lx-s2be-list" role="listbox" aria-label="Помещения" data-lx-edit="rooms">'];
    for (var r = 0; r < rooms.length; r++) roomList.push(roomItemHtml(rooms[r], r));
    if (!rooms.length) roomList.push('<div class="lx-s2be-note">В модели нет помещений</div>');
    roomList.push('</div>');
    html.push(roomList.join(''));

    // файл / история
    html.push('<div class="lx-obj-h lx-s2be-sep">Модель</div>');
    html.push('<div class="lx-btnrow" data-lx-edit="actions">' +
      '<button type="button" class="btn sm" data-act="reset" data-ico="rotate-ccw" data-tip="Вернуть модель к исходной (правки в памяти)">Сбросить</button>' +
      '<button type="button" class="btn sm" data-act="save-json" data-ico="save" data-tip="Сохранить отредактированную модель в JSON">Сохранить JSON</button>' +
      '<button type="button" class="btn sm primary" data-act="export-ifc" data-ico="download" data-tip="Экспорт IFC4 по текущей модели">Экспорт IFC</button>' +
      '</div>');
    html.push('<p class="lx-s2be-note" data-lx-edit="status" role="status" aria-live="polite">' + (st.status || '') + '</p>');
    html.push('<p class="lx-s2be-note">История: ' + st.undo.length + '/' + HISTORY_LIMIT +
      ' · Отменить Ctrl+Z · Повторить Ctrl+Shift+Z</p>');
    return html.join('');
  }

  function ensurePanel() {
    if (typeof document === 'undefined') return null;
    if (st.panel && st.panel.isConnected) return st.panel;
    var ex = document.getElementById('lxS2BEditorPanel');
    if (ex) { st.panel = ex; return ex; }
    ensureStyles();
    var p = el('section', 'fpanel fp-right lx-s2be');
    p.id = 'lxS2BEditorPanel';
    p.setAttribute('aria-label', 'Редактор BIM-модели');
    p.setAttribute('data-esc', '1');
    p.setAttribute('data-lx-edit', 'panel');
    p.style.display = 'none';
    p.innerHTML = '<div class="fpanel-inner">' +
      '<header class="fpanel-head"><span class="fpanel-ico" data-ico="pencil-ruler"></span><h3>Редактор модели</h3>' +
      '<div class="fpanel-actions">' +
      '<button id="lxS2BEditorUndo" class="icon-btn" type="button" data-act="undo" data-ico="undo-2" data-tip="Отменить (Ctrl+Z)" aria-label="Отменить правку"></button>' +
      '<button id="lxS2BEditorRedo" class="icon-btn" type="button" data-act="redo" data-ico="redo-2" data-tip="Повторить (Ctrl+Shift+Z)" aria-label="Повторить правку"></button>' +
      '<button id="lxS2BEditorClose" class="icon-btn" type="button" data-panel-close data-ico="x" data-tip="Закрыть" aria-label="Закрыть редактор"></button>' +
      '</div></header>' +
      '<div class="fpanel-body lx-sec-body" data-lx-edit="body"></div>' +
      '</div>';
    var host = document.getElementById('stageSideR') || document.querySelector('.stage') || document.body;
    host.appendChild(p);
    var closeBtn = p.querySelector('#lxS2BEditorClose');
    if (closeBtn) closeBtn.onclick = close;
    p.addEventListener('click', onPanelClick);
    hydrate(p);
    st.panel = p;
    return p;
  }

  function renderAll() {
    if (typeof document === 'undefined') return;
    var p = ensurePanel();
    if (!p) return;
    var body = p.querySelector('[data-lx-edit="body"]');
    if (!body) return;
    body.innerHTML = modelBodyHtml();
    hydrate(body);
    var u = p.querySelector('#lxS2BEditorUndo'), r = p.querySelector('#lxS2BEditorRedo');
    if (u) { u.disabled = !canUndo(); u.setAttribute('aria-disabled', String(!canUndo())); }
    if (r) { r.disabled = !canRedo(); r.setAttribute('aria-disabled', String(!canRedo())); }
  }

  function setStatus(text) { st.status = text || ''; var n = panelNode('[data-lx-edit="status"]'); if (n) n.textContent = st.status; }
  function panelNode(sel) { try { return st.panel ? st.panel.querySelector(sel) : null; } catch (e) { return null; } }

  // После правки: статистика + панель + 3D-оверлей.
  function afterEdit(model, message) {
    if (message) st.status = message;
    if (model) refreshStats(model);
    ensureSelection();
    if (typeof document !== 'undefined') { renderAll(); refreshOverlay(); }
  }

  // ---------- обработчики ----------
  function readDelta(node) {
    if (!node) return 0;
    var d = parseFloat(node.getAttribute('data-delta'));
    return isFinite(d) ? d : 0;
  }
  function selectWall(index) {
    var model = st.model;
    if (!isModelOk(model)) return;
    var i = Number(index);
    if (!isFinite(i) || !getWall(model, i)) return;
    st.wall = i | 0;
    var w = getWall(model, st.wall);
    st.opening = w && openingsOf(w).length ? 0 : -1;
    st.room = -1;
    st.snapStatus = '';
    afterEdit(model);
  }
  function selectOpening(index) {
    var model = st.model;
    var i = Number(index);
    if (!isFinite(i)) return;
    var w = getWall(model, st.wall);
    if (!w || i < 0 || i >= openingsOf(w).length) return;
    st.opening = i | 0;
    afterEdit(model);
  }
  function selectRoom(index) {
    var model = st.model;
    var i = Number(index);
    if (!isModelOk(model) || !model.rooms || !isFinite(i) || i < 0 || i >= model.rooms.length) return;
    st.room = i | 0;
    afterEdit(model);
  }
  function flashResult(res, label) {
    if (!res || !res.ok) { setStatus(label + ': ' + ((res && res.reason) || 'не выполнено')); return; }
    setStatus(label + ' — готово');
  }

  function handleAct(act, node) {
    var model = st.model;
    if (!isModelOk(model)) {
      if (act === 'open-build') openScanPanel();
      return;
    }
    ensureSelection();
    var d = readDelta(node);
    switch (act) {
      case 'undo': if (!undo()) setStatus('Нечего отменять'); break;
      case 'redo': if (!redo()) setStatus('Нечего повторять'); break;
      case 'wall-move': flashResult(editMoveWall(model, st.wall, d), 'Сдвиг стены'); break;
      case 'wall-thick': flashResult(editThickness(model, st.wall, d), 'Толщина'); break;
      case 'wall-end': {
        var side = node.getAttribute('data-side') === 'a' ? 'a' : 'b';
        flashResult(editWallEnd(model, st.wall, side, d), 'Торец ' + side);
        break;
      }
      case 'snap': doSnap(); break;
      case 'op-move': {
        var prop = node.getAttribute('data-prop');
        var opIdxM = Number(node.getAttribute('data-opening-index'));
        flashResult(editOpeningMove(model, st.wall, isFinite(opIdxM) ? opIdxM : st.opening, prop, d), 'Проём: ' + prop);
        break;
      }
      case 'op-del': {
        // кнопка удаления есть у каждой строки списка — удаляем именно строку из data-атрибута
        var opIdxD = Number(node.getAttribute('data-opening-index'));
        var targetOp = isFinite(opIdxD) ? opIdxD : st.opening;
        var res = deleteOpening(model, st.wall, targetOp);
        if (res.ok) {
          var w = getWall(model, st.wall);
          var n = w ? openingsOf(w).length : 0;
          st.opening = n ? clamp(targetOp, 0, n - 1) : -1;
          afterEdit(model);
        }
        flashResult(res, 'Удаление проёма');
        break;
      }
      case 'op-add-door': {
        var added = addDoor(model, st.wall);
        if (added.ok) st.opening = added.opening;
        flashResult(added, 'Дверь');
        if (added.ok) afterEdit(model);
        break;
      }
      case 'reset':
        if (!reset()) setStatus('Сброс недоступен');
        break;
      case 'save-json':
        if (saveJson(model)) toast('JSON модели сохранён: scan2bim-edited.json');
        else toast('Не удалось сохранить JSON', true);
        break;
      case 'export-ifc': doExportIfc(); break;
      case 'open-build': openScanPanel(); break;
      default: break;
    }
  }

  function doSnap() {
    var model = st.model;
    if (!isModelOk(model)) { setStatus('Сначала постройте модель'); return; }
    var cloud = cloudPoints();
    if (!cloud) { st.snapStatus = 'Облако точек не найдено в сцене — откройте облако и повторите'; afterEdit(model); return; }
    var res = snapWall(model, st.wall, cloud);
    if (res.ok) {
      st.snapStatus = 'Привязано: сдвиг ' + fmt(res.shift, 3) + ' м, толщина ' + fmt(res.thickness, 2) +
        ' м, точек ' + res.points + ' (грани ' + res.bands.lo + '/' + res.bands.hi + ')';
    } else {
      st.snapStatus = 'Привязка: ' + (res.reason || 'не выполнена');
    }
    afterEdit(model);
  }

  function doExportIfc() {
    try {
      var ifc = exportEditedIfc(st.model);
      if (!ifc) throw new Error('пустой IFC');
      downloadText(ifc, 'scan2bim-edited.ifc', 'application/x-step');
      toast('IFC4 по отредактированной модели сохранён: scan2bim-edited.ifc');
    } catch (e) {
      toast('Экспорт IFC не удался: ' + ((e && e.message) || e), true);
    }
  }

  function openScanPanel() {
    try {
      if (typeof window !== 'undefined' && window.__lxScan2BIM && window.__lxScan2BIM.open) window.__lxScan2BIM.open();
    } catch (e) { }
  }

  function onPanelClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var actNode = t.closest('[data-act]');
    if (actNode) {
      e.preventDefault();
      e.stopPropagation();
      handleAct(actNode.getAttribute('data-act'), actNode);
      return;
    }
    var wNode = t.closest('[data-wall-index]');
    if (wNode && wNode.getAttribute('data-wall-index') != null) { selectWall(wNode.getAttribute('data-wall-index')); return; }
    var oNode = t.closest('[data-opening-index]');
    if (oNode && oNode.getAttribute('data-opening-index') != null) { selectOpening(oNode.getAttribute('data-opening-index')); return; }
    var rNode = t.closest('[data-room-index]');
    if (rNode && rNode.getAttribute('data-room-index') != null) { selectRoom(rNode.getAttribute('data-room-index')); return; }
  }

  function onKeyDown(e) {
    if (!isOpen()) return;
    var tag = (e.target && e.target.tagName ? e.target.tagName : '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    var mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    var k = (e.key || '').toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); if (!undo()) setStatus('Нечего отменять'); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); if (!redo()) setStatus('Нечего повторять'); }
  }

  // ---------- открытие / закрытие ----------
  function attach(model) {
    if (model !== st.model) {
      st.model = model || null;
      st.initialJson = isModelOk(model) ? modelSnapshot(model) : null;
      st.undo.length = 0;
      st.redo.length = 0;
      st.wall = 0;
      st.opening = -1;
      st.room = -1;
      st.status = '';
      st.snapStatus = '';
      ensureSelection();
    }
    return st.model;
  }

  function isOpen() {
    return !!(st.panel && st.panel.style && st.panel.style.display !== 'none' && st.panel.isConnected !== false);
  }

  /**
   * Открыть панель редактора.
   * @param {object|null} [model] — модель после «Построить BIM»; без модели показывается подсказка.
   */
  function open(model) {
    if (typeof document === 'undefined') return null;
    if (model !== undefined) attach(model);
    else if (!st.model && typeof window !== 'undefined' && window.__lxScan2BIM && window.__lxScan2BIM.state) {
      attach(window.__lxScan2BIM.state.model);
    }
    ensureStyles();
    var p = ensurePanel();
    if (!p) return null;
    p.style.display = 'block';
    p.classList.remove('folded');
    if (!st.keyOn && document && document.addEventListener) {
      document.addEventListener('keydown', onKeyDown, true);
      st.keyOn = true;
    }
    ensureSelection();
    renderAll();
    refreshOverlay();
    hydrate(p);
    return p;
  }

  function close() {
    var p = ensurePanel();
    if (p) p.style.display = 'none';
    if (st.keyOn && typeof document !== 'undefined' && document.removeEventListener) {
      document.removeEventListener('keydown', onKeyDown, true);
      st.keyOn = false;
    }
    clearOverlay();
    // вернуть штатный предпросмотр «Скан → BIM», если он включён
    try {
      if (typeof window !== 'undefined' && window.__lxScan2BIM && window.__lxScan2BIM.refreshPreview) {
        window.__lxScan2BIM.refreshPreview();
      }
    } catch (e) { }
  }

  function setModel(model) {
    attach(model);
    if (isOpen()) { renderAll(); refreshOverlay(); }
    return st.model;
  }

  function getState() {
    return {
      model: st.model,
      hasModel: isModelOk(st.model),
      undo: st.undo.length,
      redo: st.redo.length,
      historyLimit: HISTORY_LIMIT,
      hasInitial: !!st.initialJson,
      wall: st.wall,
      opening: st.opening,
      room: st.room,
      version: SAVE_VERSION
    };
  }

  // ===================== ЭКСПОРТ =====================
  var API = {
    version: SAVE_VERSION,
    historyLimit: HISTORY_LIMIT,
    open: open,
    close: close,
    isOpen: isOpen,
    attach: attach,
    setModel: setModel,
    getModel: function () { return st.model; },
    getState: getState,
    editMoveWall: editMoveWall,
    editThickness: editThickness,
    editWallEnd: editWallEnd,
    editOpeningMove: editOpeningMove,
    deleteOpening: deleteOpening,
    addDoor: addDoor,
    snapWall: snapWall,
    undo: undo,
    redo: redo,
    reset: reset,
    canUndo: canUndo,
    canRedo: canRedo,
    modelJson: modelJson,
    saveJson: saveJson,
    exportEditedIfc: exportEditedIfc,
    refreshStats: refreshStats,
    refreshOverlay: refreshOverlay
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.__lxS2BEditor = API;
  if (typeof globalThis !== 'undefined' && typeof window === 'undefined') {
    try { globalThis.__lxS2BEditor = API; } catch (e) { }
  }
})();
