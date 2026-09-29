/*
 * realview.js — режим «Экскурсия» (RealView): станции сканера и навигация между ними.
 *
 * По мотивам Autodesk ReCap RealView / Leica Cyclone: пользователь «стоит» в точке
 * съёмки и осматривается вокруг, а затем телепортируется на соседнюю станцию.
 *
 * Этот модуль — чистая логика (без GPU/DOM), покрыта тестами test/realview.test.js:
 *   • модель станций + сериализация для хранения в проекте;
 *   • автоподбор станций (сетка по полу на уровне глаз) — когда в LAS нет метаданных съёмки;
 *   • выбор станции для телепорта (ближайшая / следующая по направлению взгляда).
 *
 * Станция: { id, name, pos:[x,y,z], yaw?, panoUrl? }. panoUrl зарезервирован под
 * реальные сферические снимки (E57/RCP) — подключаются позже без смены API.
 */
(function () {
  'use strict';

  var EYE_HEIGHT = 1.6;

  function makeStation(pos, name, id) {
    return { id: id, name: name || id, pos: [pos[0], pos[1], pos[2]], yaw: 0, panoUrl: null };
  }

  function suggestStations(bbox, opts) {
    opts = opts || {};
    var eyeH = opts.eyeHeight != null ? opts.eyeHeight : EYE_HEIGHT;
    var mn = bbox.mn, mx = bbox.mx;
    var w = mx[0] - mn[0], depth = mx[2] - mn[2];
    var spacing = opts.spacing || Math.max(2, Math.min(w, depth) / 6 || 2);
    var eyeY = mn[1] + eyeH;
    var maxCount = opts.maxCount || 64;
    var out = []; var id = 1;
    for (var x = mn[0] + spacing / 2; x < mx[0]; x += spacing) {
      for (var z = mn[2] + spacing / 2; z < mx[2]; z += spacing) {
        out.push(makeStation([x, eyeY, z], 'Станция ' + id, 'st' + id)); id++;
        if (out.length >= maxCount) return out;
      }
    }
    if (out.length === 0) out.push(makeStation([(mn[0] + mx[0]) / 2, eyeY, (mn[2] + mx[2]) / 2], 'Станция 1', 'st1'));
    return out;
  }

  function _d2(a, b) { var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2]; return dx * dx + dy * dy + dz * dz; }

  function nearest(stations, pos) {
    if (!stations || !stations.length) return null;
    var best = null, bestD = Infinity;
    for (var i = 0; i < stations.length; i++) {
      var d = _d2(stations[i].pos, pos);
      if (d < bestD) { bestD = d; best = stations[i]; }
    }
    return best;
  }

  // Станция «впереди» по направлению взгляда dir (горизонт.), ближайшая из выровненных.
  function pickTeleport(stations, fromPos, dir, opts) {
    opts = opts || {};
    var cosThresh = opts.cosThresh != null ? opts.cosThresh : 0.64; // ~50°
    var minStep = opts.minStep != null ? opts.minStep : 0.5;
    var dl = Math.hypot(dir[0], 0, dir[2]) || 1;
    var dx = dir[0] / dl, dz = dir[2] / dl;
    var best = null, bestDist = Infinity;
    for (var i = 0; i < stations.length; i++) {
      var s = stations[i];
      var vx = s.pos[0] - fromPos[0], vz = s.pos[2] - fromPos[2];
      var dist = Math.hypot(vx, vz);
      if (dist < minStep) continue;
      var dot = (vx / dist) * dx + (vz / dist) * dz;
      if (dot < cosThresh) continue;
      if (dist < bestDist) { bestDist = dist; best = s; }
    }
    return best;
  }

  function serialize(stations) {
    return JSON.stringify((stations || []).map(function (s) {
      return { id: s.id, name: s.name, pos: s.pos, yaw: s.yaw || 0, panoUrl: s.panoUrl || null };
    }));
  }

  function deserialize(json) {
    if (!json) return [];
    var arr = typeof json === 'string' ? JSON.parse(json) : json;
    if (!Array.isArray(arr)) return [];
    return arr.map(function (s) {
      return { id: s.id, name: s.name || s.id, pos: [s.pos[0], s.pos[1], s.pos[2]], yaw: s.yaw || 0, panoUrl: s.panoUrl || null };
    });
  }

  var api = {
    EYE_HEIGHT: EYE_HEIGHT,
    makeStation: makeStation,
    suggestStations: suggestStations,
    nearest: nearest,
    pickTeleport: pickTeleport,
    serialize: serialize,
    deserialize: deserialize
  };
  if (typeof window !== 'undefined') window.RealView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
