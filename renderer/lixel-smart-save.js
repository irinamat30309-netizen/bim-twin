/*
 * lixel-smart-save.js — v1226
 * Умная система сохранения правок облака точек:
 *   • индикатор состояния (Сохранено / Не сохранено / Сохранение… / Черновик);
 *   • периодическое авто-сохранение (настраиваемый интервал);
 *   • тихое сохранение в рабочий файл (без диалога) + черновик-бэкап;
 *   • вопрос при закрытии окна;
 *   • экспорт во все форматы (PLY/LAS/XYZ/PTS/PCD/OBJ + IFC/OBJ/DXF для BIM).
 * Надстройка над window.__pcAutosave / window.__pcTools — не ломает существующий черновик.
 * window.__lxSmartSave = { save, exportAs, setInterval, status, formats }.
 */
(function () {
  'use strict';

  // ===================== ЧИСТЫЕ ГЕНЕРАТОРЫ ФОРМАТОВ (тестируемые) =====================
  // Цвет может быть float 0..1 или uchar 0..255 — определяем автоматически.
  function colScale255(col) {
    if (!col || !col.length) return false;
    var mx = 0, lim = Math.min(col.length, 300);
    for (var i = 0; i < lim; i++) if (col[i] > mx) mx = col[i];
    return mx > 1.0001;
  }
  function rgbAt(col, i, s255) {
    if (!col || !col.length) return [200, 200, 200];
    if (s255) return [col[i * 3] | 0, col[i * 3 + 1] | 0, col[i * 3 + 2] | 0];
    return [Math.round(col[i * 3] * 255), Math.round(col[i * 3 + 1] * 255), Math.round(col[i * 3 + 2] * 255)];
  }

  function ptxScanGroups(cloud, n) {
    var meta = cloud && cloud.meta || {};
    if (!/^PTX(?:\s|$)/i.test(String(meta.format || '')) || !Array.isArray(meta.scans) || !meta.scans.length) return null;
    var cursor = 0, groups = [], pos = cloud.pos;
    function inverse3(a) {
      var det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) +
        a[2] * (a[3] * a[7] - a[4] * a[6]);
      if (!isFinite(det) || Math.abs(det) < 1e-15) return null;
      return [
        (a[4] * a[8] - a[5] * a[7]) / det, (a[2] * a[7] - a[1] * a[8]) / det, (a[1] * a[5] - a[2] * a[4]) / det,
        (a[5] * a[6] - a[3] * a[8]) / det, (a[0] * a[8] - a[2] * a[6]) / det, (a[2] * a[3] - a[0] * a[5]) / det,
        (a[3] * a[7] - a[4] * a[6]) / det, (a[1] * a[6] - a[0] * a[7]) / det, (a[0] * a[4] - a[1] * a[3]) / det
      ];
    }
    function localPoint(index, inv, translation) {
      var dx = Number(pos[index * 3]) - translation[0];
      var dy = Number(pos[index * 3 + 1]) - translation[1];
      var dz = Number(pos[index * 3 + 2]) - translation[2];
      return [
        inv[0] * dx + inv[1] * dy + inv[2] * dz,
        inv[3] * dx + inv[4] * dy + inv[5] * dz,
        inv[6] * dx + inv[7] * dy + inv[8] * dz
      ];
    }
    for (var i = 0; i < meta.scans.length; i++) {
      var scan = meta.scans[i] || {}, start = Number(scan.start), count = Number(scan.count);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 0 ||
          start !== cursor || start + count > n) return null;
      cursor += count;
      if (!count) continue;
      var m = scan.transform;
      if (!Array.isArray(m) || m.length < 16 || !m.slice(0, 16).every(function (v) { return isFinite(Number(v)); })) return null;
      var convention = scan.matrixConvention;
      if (convention !== 'row-vector' && convention !== 'column-vector') return null;
      var rowVector = convention === 'row-vector';
      var a = rowVector
        ? [Number(m[0]), Number(m[4]), Number(m[8]), Number(m[1]), Number(m[5]), Number(m[9]), Number(m[2]), Number(m[6]), Number(m[10])]
        : [Number(m[0]), Number(m[1]), Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[8]), Number(m[9]), Number(m[10])];
      var translation = rowVector
        ? [Number(m[12]), Number(m[13]), Number(m[14])]
        : [Number(m[3]), Number(m[7]), Number(m[11])];
      var inv = inverse3(a);
      var scannerPosition = scan.scannerPosition;
      var axes = scan.axes;
      if (!inv || !translation.every(isFinite) || !Array.isArray(scannerPosition) || scannerPosition.length < 3 ||
          !scannerPosition.slice(0, 3).every(function (v) { return isFinite(Number(v)); }) ||
          !Array.isArray(axes) || axes.length < 3 || !axes.slice(0, 3).every(function (axis) {
            return Array.isArray(axis) && axis.length >= 3 && axis.slice(0, 3).every(function (v) { return isFinite(Number(v)); });
          })) return null;
      var hasLocalOrigin = false, minLocalX = Infinity;
      for (var p = start; p < start + count; p++) {
        var local = localPoint(p, inv, translation);
        if (!local.every(isFinite)) return null;
        if (local[0] < minLocalX) minLocalX = local[0];
        if (local[0] === 0 && local[1] === 0 && local[2] === 0) hasLocalOrigin = true;
      }
      // PTX reserves the all-zero local triple as a missing-return marker. If
      // an actual return is at the scanner origin, shift this scan frame by a
      // representable amount and compensate the matrix translation.
      var shiftX = 0, outputMatrix = m.slice(0, 16).map(Number);
      if (hasLocalOrigin) {
        var delta = Math.max(1e-6, Math.abs(minLocalX) * Number.EPSILON * 8);
        shiftX = minLocalX - delta;
        if (!(shiftX < minLocalX)) shiftX = minLocalX - Math.max(1e-6, Math.abs(minLocalX) * Number.EPSILON * 32);
        if (!(shiftX < minLocalX)) return null;
        var dx = a[0] * shiftX, dy = a[3] * shiftX, dz = a[6] * shiftX;
        if (rowVector) { outputMatrix[12] += dx; outputMatrix[13] += dy; outputMatrix[14] += dz; }
        else { outputMatrix[3] += dx; outputMatrix[7] += dy; outputMatrix[11] += dz; }
      }
      groups.push({
        start: start, count: count, scan: scan, rowVector: rowVector, a: a, inv: inv,
        translation: translation, shiftX: shiftX, matrix: outputMatrix
      });
    }
    return cursor === n && groups.length ? groups : null;
  }

  function ptxWorldToLocal(state, index, group) {
    if (!group) return [
      Number(state.pos[index * 3]) - state.shift[0],
      Number(state.pos[index * 3 + 1]) - state.shift[1],
      Number(state.pos[index * 3 + 2]) - state.shift[2]
    ];
    var dx = Number(state.pos[index * 3]) - group.translation[0];
    var dy = Number(state.pos[index * 3 + 1]) - group.translation[1];
    var dz = Number(state.pos[index * 3 + 2]) - group.translation[2];
    return [
      group.inv[0] * dx + group.inv[1] * dy + group.inv[2] * dz - group.shiftX,
      group.inv[3] * dx + group.inv[4] * dy + group.inv[5] * dz,
      group.inv[6] * dx + group.inv[7] * dy + group.inv[8] * dz
    ];
  }

  function ptxHeaderForGroup(state, group) {
    if (!group) return state.header.join('\n') + '\n';
    var scan = group.scan, m = group.matrix;
    return [
      String(group.count), '1',
      scan.scannerPosition.slice(0, 3).map(Number).join(' '),
      scan.axes[0].slice(0, 3).map(Number).join(' '),
      scan.axes[1].slice(0, 3).map(Number).join(' '),
      scan.axes[2].slice(0, 3).map(Number).join(' '),
      m.slice(0, 4).join(' '), m.slice(4, 8).join(' '),
      m.slice(8, 12).join(' '), m.slice(12, 16).join(' ')
    ].join('\n') + '\n';
  }

  function ptxOutputGroups(state) {
    return state.scans || [{ start: 0, count: state.n, scan: null }];
  }

  // PTS: первая строка — количество; далее "x y z intensity r g b".
  function toPTSText(cloud) {
    var pos = cloud && cloud.pos, col = (cloud && cloud.col) || null, intensity = cloud && cloud.intensity;
    var n = pos ? (cloud.count != null ? Math.min(cloud.count, Math.floor(pos.length / 3)) : (pos.length / 3) | 0) : 0, s255 = colScale255(col), iDiv = 1;
    if (intensity) { var im = 0; for (var k = 0; k < Math.min(n, 3000); k++) if (intensity[k] > im) im = intensity[k]; iDiv = im > 1.0001 ? im : 1; }
    var parts = ['' + n], CH = [];
    for (var i = 0; i < n; i++) {
      var c = rgbAt(col, i, s255);
      var iv = intensity && intensity.length > i ? Math.round(Math.max(0, Math.min(1, Number(intensity[i]) / iDiv)) * 65535) : 0;
      CH.push(pos[i * 3] + ' ' + pos[i * 3 + 1] + ' ' + pos[i * 3 + 2] + ' ' + iv + ' ' + c[0] + ' ' + c[1] + ' ' + c[2]);
      if (CH.length >= 100000) { parts.push(CH.join('\n')); CH.length = 0; }
    }
    if (CH.length) parts.push(CH.join('\n'));
    return parts.join('\n') + '\n';
  }

  // PTX: deterministic single-row/single-scan interchange. Coordinates are
  // encoded as local XYZ plus a row-vector pose so large source coordinates
  // keep their precision. PTX has no standard CRS/classification fields.
  function ptxCreateState(cloud, rowLimit) {
    var pos = cloud && cloud.pos, col = cloud && cloud.col, intensity = cloud && cloud.intensity;
    var n = pos ? (cloud.count != null ? Math.min(cloud.count, Math.floor(pos.length / 3)) : (pos.length / 3) | 0) : 0;
    if (!n || !pos || pos.length < n * 3) throw new Error('PTX: нет точек для экспорта');
    if (pos.length % 3 !== 0 || (cloud.count != null && cloud.count !== Math.floor(pos.length / 3))) throw new Error('PTX: число точек не совпадает с массивом XYZ');
    if (col && col.length < n * 3) throw new Error('PTX: массив RGB короче массива XYZ');
    if (intensity && intensity.length < n) throw new Error('PTX: массив intensity короче массива XYZ');
    if (n > 2147483647) throw new Error('PTX: число точек превышает безопасный размер сетки');
    rowLimit = Math.max(1000, Math.min(100000, Math.floor(Number(rowLimit) || 10000)));
    return {
      cloud: cloud, pos: pos, col: col, intensity: intensity, n: n, rowLimit: rowLimit,
      min: [Infinity, Infinity, Infinity], hasOrigin: false,
      colorMax: 0, intensityMax: 0, shift: [0, 0, 0]
    };
  }
  function ptxInspectPoint(state, i) {
    var pos = state.pos, col = state.col, intensity = state.intensity;
    var x = Number(pos[i * 3]), y = Number(pos[i * 3 + 1]), z = Number(pos[i * 3 + 2]);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) throw new Error('PTX: нечисловая XYZ в точке ' + i);
    if (x < state.min[0]) state.min[0] = x;
    if (y < state.min[1]) state.min[1] = y;
    if (z < state.min[2]) state.min[2] = z;
    if (x === 0 && y === 0 && z === 0) state.hasOrigin = true;
    if (intensity) {
      var iv = Number(intensity[i]);
      if (!isFinite(iv)) throw new Error('PTX: нечисловая intensity в точке ' + i);
      if (iv > state.intensityMax) state.intensityMax = iv;
    }
    if (col) {
      for (var c = 0; c < 3; c++) {
        var cv = Number(col[i * 3 + c]);
        if (!isFinite(cv)) throw new Error('PTX: нечисловой RGB в точке ' + i);
        if (cv > state.colorMax) state.colorMax = cv;
      }
    }
  }
  function ptxFinalizeState(state) {
    var n = state.n, pos = state.pos, col = state.col, intensity = state.intensity;
    // PTX uses 0 0 0 as a missing-return sentinel. If the cloud contains the
    // origin, shift its scan frame below the data bounds and apply that
    // translation in the 4x4 pose so the origin is not silently discarded.
    if (state.hasOrigin) {
      var shifted = false;
      for (var a = 0; a < 3; a++) {
        var delta = Math.max(1, Math.abs(state.min[a]) * Number.EPSILON * 4);
        var candidate = state.min[a] - delta;
        if (isFinite(candidate) && candidate < state.min[a]) { state.shift[a] = candidate; shifted = true; break; }
      }
      if (!shifted) throw new Error('PTX: невозможно безопасно сместить скан, содержащий точку (0,0,0)');
    }
    state.hasColor = !!(col && col.length >= n * 3);
    state.hasIntensity = !!(intensity && intensity.length >= n);
    // Uint16 scanner colors use the full 16-bit range even when this scan
    // contains no bright pixels; float/u8 buffers retain their usual scale.
    state.rgbDiv = col instanceof Uint16Array ? 65535 : state.colorMax > 255 ? 65535 : state.colorMax > 1.0001 ? 255 : 1;
    state.intensityDiv = state.intensityMax > 1.0001 ? state.intensityMax : 1;
    state.header = [
      String(n), '1',
      '0 0 0', '1 0 0', '0 1 0', '0 0 1',
      '1 0 0 0', '0 1 0 0', '0 0 1 0',
      state.shift[0] + ' ' + state.shift[1] + ' ' + state.shift[2] + ' 1'
    ];
    state.scans = ptxScanGroups(state.cloud, state.n);
    return state;
  }
  function ptxRow(state, index, group) {
    var pos = state.pos, col = state.col, intensity = state.intensity;
    var local = ptxWorldToLocal(state, index, group), px = local[0], py = local[1], pz = local[2];
    if (!isFinite(px) || !isFinite(py) || !isFinite(pz)) throw new Error('PTX: координатный диапазон не помещается в локальную систему');
    var row = [px, py, pz];
    if (state.hasIntensity || state.hasColor) {
      var iv = state.hasIntensity ? Math.max(0, Math.min(1, Number(intensity[index]) / state.intensityDiv)) : 0;
      row.push(iv);
    }
    if (state.hasColor) for (var ca = 0; ca < 3; ca++) row.push(Math.max(0, Math.min(255, Math.round(Number(col[index * 3 + ca]) / state.rgbDiv * 255))));
    return row.join(' ');
  }
  function* ptxTextChunks(cloud, rowLimit) {
    var state = ptxCreateState(cloud, rowLimit);
    for (var i = 0; i < state.n; i++) ptxInspectPoint(state, i);
    ptxFinalizeState(state);
    var groups = ptxOutputGroups(state), written = 0;
    for (var g = 0; g < groups.length; g++) {
      var group = state.scans ? groups[g] : null, end = group ? group.start + group.count : state.n;
      yield { text: ptxHeaderForGroup(state, group), points: written, total: state.n, phase: 'write' };
      var rows = [];
      for (var j = group ? group.start : 0; j < end; j++) {
        rows.push(ptxRow(state, j, group));
        written++;
        if (rows.length >= state.rowLimit) {
          yield { text: rows.join('\n') + '\n', points: written, total: state.n, phase: 'write' };
          rows.length = 0;
        }
      }
      if (rows.length) yield { text: rows.join('\n') + '\n', points: written, total: state.n, phase: 'write' };
    }
  }
  async function* ptxTextChunksAsync(cloud, rowLimit, isCancelled) {
    var state = ptxCreateState(cloud, rowLimit), scanBatch = 131072;
    for (var start = 0; start < state.n; start += scanBatch) {
      var end = Math.min(state.n, start + scanBatch);
      for (var i = start; i < end; i++) ptxInspectPoint(state, i);
      if (end < state.n) {
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
        if (isCancelled && isCancelled()) { var scanCancel = new Error('Экспорт отменён'); scanCancel.cancelled = true; throw scanCancel; }
        yield { text: '', points: end, total: state.n, phase: 'scan' };
      }
    }
    if (isCancelled && isCancelled()) { var cancel = new Error('Экспорт отменён'); cancel.cancelled = true; throw cancel; }
    ptxFinalizeState(state);
    var groups = ptxOutputGroups(state), written = 0;
    for (var g = 0; g < groups.length; g++) {
      var group = state.scans ? groups[g] : null, end = group ? group.start + group.count : state.n;
      if (isCancelled && isCancelled()) { var headerCancel = new Error('Экспорт отменён'); headerCancel.cancelled = true; throw headerCancel; }
      yield { text: ptxHeaderForGroup(state, group), points: written, total: state.n, phase: 'write' };
      var rows = [];
      for (var j = group ? group.start : 0; j < end; j++) {
        rows.push(ptxRow(state, j, group));
        written++;
        if (rows.length >= state.rowLimit) {
          if (isCancelled && isCancelled()) { var rowCancel = new Error('Экспорт отменён'); rowCancel.cancelled = true; throw rowCancel; }
          yield { text: rows.join('\n') + '\n', points: written, total: state.n, phase: 'write' };
          rows.length = 0;
        }
      }
      if (rows.length) {
        if (isCancelled && isCancelled()) { var finalCancel = new Error('Экспорт отменён'); finalCancel.cancelled = true; throw finalCancel; }
        yield { text: rows.join('\n') + '\n', points: written, total: state.n, phase: 'write' };
      }
    }
  }
  function toPTXText(cloud) {
    var parts = [];
    for (var chunk of ptxTextChunks(cloud, 50000)) parts.push(chunk.text);
    return parts.join('');
  }

  // PCD v0.7 ASCII: x y z rgb(упакованный uint в поле rgb).
  function toPCDText(cloud) {
    var pos = cloud && cloud.pos, col = (cloud && cloud.col) || null, intensity = cloud && cloud.intensity, classification = cloud && cloud.classification;
    var n = pos ? (cloud.count != null ? Math.min(cloud.count, Math.floor(pos.length / 3)) : (pos.length / 3) | 0) : 0, s255 = colScale255(col), fields = ['x','y','z'];
    var meta = cloud && cloud.meta || {}, axis = meta.srcXform && meta.srcXform.axis || 'y';
    if (intensity && intensity.length >= n) fields.push('intensity');
    if (classification && classification.length >= n) fields.push('classification');
    if (col && col.length >= n * 3) fields.push('rgb');
    var hdr = [
      '# .PCD v0.7 - BIM Twin point cloud',
      '# BIM_TWIN_UP=' + (axis === 'zup' ? 'z' : 'y'),
      meta.units ? '# BIM_TWIN_UNITS=' + String(meta.units).replace(/[\r\n]/g, ' ') : '',
      meta.crsWkt ? '# BIM_TWIN_CRS_WKT_URI=' + encodeURIComponent(String(meta.crsWkt)) : '',
      'VERSION 0.7',
      'FIELDS ' + fields.join(' '),
      'SIZE ' + fields.map(function(f){return f==='classification'?1:f==='rgb'?4:4;}).join(' '),
      'TYPE ' + fields.map(function(f){return f==='classification'||f==='rgb'?'U':'F';}).join(' '),
      'COUNT ' + fields.map(function(){return '1';}).join(' '),
      'WIDTH ' + n,
      'HEIGHT 1',
      'VIEWPOINT 0 0 0 1 0 0 0',
      'POINTS ' + n,
      'DATA ascii'
    ];
    var parts = [hdr.filter(Boolean).join('\n')], CH = [], intensityDiv = 1;
    if (intensity && intensity.length >= n) { var im = 0; for (var k = 0; k < Math.min(n, 3000); k++) if (intensity[k] > im) im = intensity[k]; intensityDiv = im > 1.0001 ? im : 1; }
    for (var i = 0; i < n; i++) {
      var c = rgbAt(col, i, s255);
      var rgb = ((c[0] & 255) << 16) | ((c[1] & 255) << 8) | (c[2] & 255);
      var vals = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
      if (intensity && intensity.length >= n) vals.push(Math.max(0, Math.min(1, Number(intensity[i]) / intensityDiv)));
      if (classification && classification.length >= n) vals.push(Math.max(0, Math.min(255, Number(classification[i]) | 0)));
      if (col && col.length >= n * 3) vals.push(rgb >>> 0);
      CH.push(vals.join(' '));
      if (CH.length >= 100000) { parts.push(CH.join('\n')); CH.length = 0; }
    }
    if (CH.length) parts.push(CH.join('\n'));
    return parts.join('\n') + '\n';
  }

  // Rich, self-describing XYZ text. Readers that ignore comment lines still see
  // numeric rows; the BIM Twin reader uses the named columns/CRS/up-axis comments.
  function toXYZText(cloud) {
    var pos = cloud && cloud.pos, col = cloud && cloud.col, intensity = cloud && cloud.intensity, classification = cloud && cloud.classification;
    var n = pos ? (cloud.count != null ? Math.min(cloud.count, Math.floor(pos.length / 3)) : (pos.length / 3) | 0) : 0, meta = cloud && cloud.meta || {};
    var axis = meta.srcXform && meta.srcXform.axis || 'y', s255 = colScale255(col), fields = ['x','y','z'];
    if (intensity && intensity.length >= n) fields.push('intensity');
    if (col && col.length >= n * 3) fields.push('red','green','blue');
    if (classification && classification.length >= n) fields.push('classification');
    var lines = ['# BIM Twin XYZ point cloud', '# BIM_TWIN_UP=' + (axis === 'zup' ? 'z' : 'y'), '# columns=' + fields.join(' ')];
    if (meta.units) lines.push('# BIM_TWIN_UNITS=' + String(meta.units).replace(/[\r\n]/g, ' '));
    if (meta.crsWkt) lines.push('# BIM_TWIN_CRS_WKT_URI=' + encodeURIComponent(String(meta.crsWkt)));
    for (var i = 0; i < n; i++) {
      var row = [pos[i*3], pos[i*3+1], pos[i*3+2]];
      if (intensity && intensity.length >= n) row.push(intensity[i]);
      if (col && col.length >= n * 3) { var c=rgbAt(col,i,s255);row.push(c[0],c[1],c[2]); }
      if (classification && classification.length >= n) row.push(classification[i]);
      lines.push(row.join(' '));
    }
    return lines.join('\n') + '\n';
  }

  // Self-describing point CSV. BIM Twin comments carry axis/units/CRS without
  // putting non-numeric values into ordinary spreadsheet columns.
  function toCSVText(cloud) {
    var pos = cloud && cloud.pos, col = cloud && cloud.col, intensity = cloud && cloud.intensity, classification = cloud && cloud.classification;
    var n = pos ? (cloud.count != null ? Math.min(cloud.count, Math.floor(pos.length / 3)) : (pos.length / 3) | 0) : 0;
    var meta = cloud && cloud.meta || {}, s255 = colScale255(col), fields = ['x', 'y', 'z'];
    if (intensity && intensity.length >= n) fields.push('intensity');
    if (col && col.length >= n * 3) fields.push('red', 'green', 'blue');
    if (classification && classification.length >= n) fields.push('classification');
    var lines = [
      '# BIM Twin point cloud CSV',
      '# BIM_TWIN_UP=' + (meta.srcXform && meta.srcXform.axis === 'zup' ? 'z' : 'y'),
      '# BIM_TWIN_CSV_COLUMNS=' + fields.join(',')
    ];
    if (meta.units) lines.push('# BIM_TWIN_UNITS=' + String(meta.units).replace(/[\r\n]/g, ' '));
    if (meta.crsWkt) lines.push('# BIM_TWIN_CRS_WKT_URI=' + encodeURIComponent(String(meta.crsWkt)));
    lines.push(fields.join(','));
    var CH = [];
    for (var i = 0; i < n; i++) {
      var row = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
      if (intensity && intensity.length >= n) row.push(intensity[i]);
      if (col && col.length >= n * 3) row.push.apply(row, rgbAt(col, i, s255));
      if (classification && classification.length >= n) row.push(classification[i]);
      CH.push(row.join(','));
      if (CH.length >= 100000) { lines.push(CH.join('\n')); CH.length = 0; }
    }
    if (CH.length) lines.push(CH.join('\n'));
    return lines.join('\n') + '\n';
  }

  // OBJ: облако точек как вершины (v x y z [r g b]).
  function cloudToOBJ(cloud) {
    var pos = cloud && cloud.pos, col = (cloud && cloud.col) || null;
    var n = pos ? (pos.length / 3) | 0 : 0, s255 = colScale255(col);
    var parts = ['# BIM Twin point cloud export (' + n + ' pts)'], CH = [];
    for (var i = 0; i < n; i++) {
      if (col && col.length) { var c = rgbAt(col, i, s255); CH.push('v ' + pos[i * 3] + ' ' + pos[i * 3 + 1] + ' ' + pos[i * 3 + 2] + ' ' + (c[0] / 255).toFixed(4) + ' ' + (c[1] / 255).toFixed(4) + ' ' + (c[2] / 255).toFixed(4)); }
      else CH.push('v ' + pos[i * 3] + ' ' + pos[i * 3 + 1] + ' ' + pos[i * 3 + 2]);
      if (CH.length >= 100000) { parts.push(CH.join('\n')); CH.length = 0; }
    }
    if (CH.length) parts.push(CH.join('\n'));
    return parts.join('\n') + '\n';
  }

  // Реестр форматов. kind: 'cloud' — из облака; 'bim' — из построенной BIM-модели Scan2BIM.
  var FORMATS = [
    { id: 'ply', label: 'PLY (бинарный)', ext: 'ply', kind: 'cloud', binary: true, filterName: 'Polygon PLY' },
    { id: 'las', label: 'LAS 1.4', ext: 'las', kind: 'cloud', binary: true, filterName: 'LAS' },
    { id: 'xyz', label: 'XYZ (текст)', ext: 'xyz', kind: 'cloud', binary: false, filterName: 'XYZ' },
    { id: 'pts', label: 'PTS (текст)', ext: 'pts', kind: 'cloud', binary: false, filterName: 'PTS' },
    { id: 'pcd', label: 'PCD (ASCII)', ext: 'pcd', kind: 'cloud', binary: false, filterName: 'PCD' },
    { id: 'csv', label: 'CSV (таблица)', ext: 'csv', kind: 'cloud', binary: false, filterName: 'CSV' },
    { id: 'e57', label: 'E57 (ASTM)', ext: 'e57', kind: 'cloud', binary: true, filterName: 'E57' },
    { id: 'ptx', label: 'PTX (мультискан · 1 строка/скан)', ext: 'ptx', kind: 'cloud', binary: false, filterName: 'PTX' },
    { id: 'obj', label: 'OBJ (точки)', ext: 'obj', kind: 'cloud', binary: false, filterName: 'OBJ' },
    { id: 'bim-ifc', label: 'IFC4 (BIM-модель)', ext: 'ifc', kind: 'bim', binary: false, filterName: 'IFC' },
    { id: 'bim-obj', label: 'OBJ (BIM-модель)', ext: 'obj', kind: 'bim', binary: false, filterName: 'OBJ' },
    { id: 'bim-dxf', label: 'DXF (план BIM)', ext: 'dxf', kind: 'bim', binary: false, filterName: 'DXF' }
  ];

  var Fmt = {
    FORMATS: FORMATS,
    toPTSText: toPTSText,
    toPTXText: toPTXText,
    ptxTextChunks: ptxTextChunks,
    ptxTextChunksAsync: ptxTextChunksAsync,
    toPCDText: toPCDText,
    toXYZText: toXYZText,
    toCSVText: toCSVText,
    cloudToOBJ: cloudToOBJ,
    colScale255: colScale255,
    version: '1160'
  };

  if (typeof window !== 'undefined') window.SmartSaveFmt = Fmt;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fmt;

  // ===================== БРАУЗЕРНАЯ ЧАСТЬ =====================
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  var LS_MIN = 'lxSmartSaveMin';       // интервал авто-сохранения, мин (0 = выкл)
  var st = {
    dirty: false, saving: false,
    lastSavedAt: 0, lastDraftAt: 0,
    workingPath: null, workingFmt: 'ply',
    intervalMin: 2, timer: null
  };

  function api() { try { return window.bimAPI || null; } catch (e) { return null; } }
  function tools() { try { return window.__pcTools || null; } catch (e) { return null; } }
  function viewer() { var t = tools(); if (t && t.viewer) { try { return t.viewer(); } catch (e) {} } return window.__viewer || null; }
  function toast(m, err) { var t = tools(); if (t && t.toast) { try { return t.toast(m, err); } catch (e) {} } try { if (window.__toast) return window.__toast(m, err ? 'error' : 'info'); } catch (e) {} console[err ? 'error' : 'log']('[smart-save] ' + m); }
  function getCloud() {
    var t = tools();
    if (t && t.getSourceCloud) { try { var s = t.getSourceCloud(); if (s && s.pos && s.pos.length) return s; } catch (e) {} }
    if (t && t.getCloud) { try { var c = t.getCloud(); if (c && c.pos && c.pos.length) return c; } catch (e) {} }
    var v = viewer();
    if (v && v.getEditedCloud) { try { var c2 = v.getEditedCloud(); if (c2 && c2.pos && c2.pos.length) return c2; } catch (e) {} }
    return null;
  }
  function bimModel() { try { return (window.__lxScan2BIM && window.__lxScan2BIM.state && window.__lxScan2BIM.state.model) || null; } catch (e) { return null; } }
  function hhmm(ts) { try { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); } catch (e) { return ''; } }
  function nowName(ext) { return 'pointcloud-edited.' + ext; }

  // ---------- сборка байт/текста по формату ----------
  function buildCloudPayload(fmt, cloud) {
    var PE = window.PCEdit;
    if (fmt === 'ply') return { binary: PE.toPLYBinaryAsync ? null : PE.toPLYBinary(cloud) }; // async обрабатывается отдельно
    if (fmt === 'las') return { binary: (window.ExportHub && window.ExportHub.exportLAS) ? window.ExportHub.exportLAS(cloud) : PE.toLASBinary(cloud) };
    if (fmt === 'xyz') return { text: toXYZText(cloud) };
    if (fmt === 'pts') return { text: toPTSText(cloud) };
    if (fmt === 'ptx') return { text: toPTXText(cloud) };
    if (fmt === 'pcd') return { text: toPCDText(cloud) };
    if (fmt === 'csv') return { text: toCSVText(cloud) };
    if (fmt === 'e57') {
      var EH = window.ExportHub;
      if (!EH || !EH.exportE57) throw new Error('Модуль E57 export недоступен');
      return { binary: EH.exportE57(cloud.pos, cloud.count || cloud.pos.length / 3, {
        col: cloud.col || null, intensity: cloud.intensity || null,
        crs: cloud.meta && cloud.meta.crsWkt || '',
        scans: cloud.meta && cloud.meta.scans || null
      }) };
    }
    if (fmt === 'obj') return { text: cloudToOBJ(cloud) };
    return null;
  }
  async function plyBytes(cloud, onProg) {
    var EH = window.ExportHub;
    if (EH && EH.exportPLYAsync) return await EH.exportPLYAsync(cloud, onProg);
    var PE = window.PCEdit;
    if (PE.toPLYBinaryAsync) return await PE.toPLYBinaryAsync(cloud, onProg);
    return PE.toPLYBinary(cloud);
  }

  // ---------- состояние dirty ----------
  function setDirty(v) {
    st.dirty = !!v;
    try { var A = api(); if (A && A.setDirty) A.setDirty(st.dirty); } catch (e) {}
    renderChip();
  }
  async function markSaved(kind, generation) {
    var ack = { ok: true };
    try {
      if (window.__pcAutosave && window.__pcAutosave.saved) ack = await window.__pcAutosave.saved(generation);
    } catch (e) { ack = { ok: false, error: String(e && e.message || e) }; }
    st.lastSavedAt = Date.now();
    if (ack && ack.ok === false) {
      st.dirty = true;
      try { var A = api(); if (A && A.setDirty) A.setDirty(true); } catch (e) {}
      toast('Файл сохранён, но облако изменилось во время сохранения; сохраните актуальную версию отдельно', true);
      renderChip();
      return false;
    }
    st.dirty = false;
    try { var A = api(); if (A && A.setDirty) A.setDirty(false); } catch (e) {}
    renderChip();
    return true;
  }

  // ---------- основное сохранение ----------
  // askPath=true — всегда через диалог («Сохранить как…»). silent=true — без тостов (авто).
  async function save(opts) {
    opts = opts || {};
    if (st.saving) return { ok: false, busy: true };
    var A = api(); if (!A) { toast('Сохранение доступно в десктоп-версии', true); return { ok: false }; }
    var cloud = getCloud(); if (!cloud) { if (!opts.silent) toast('Нет облака для сохранения', true); return { ok: false }; }
    var cnt = cloud.pos.length / 3;
    if (cnt > 90000000) { toast('Слишком большое облако (~' + Math.round(cnt / 1e6) + ' млн) — сначала обрежьте', true); return { ok: false }; }
    var saveGeneration = window.__pcAutosave && Number.isSafeInteger(window.__pcAutosave.editGeneration)
      ? window.__pcAutosave.editGeneration : undefined;
    st.saving = true; renderChip();
    var t = tools(); var stop = (t && t.beginProgress) ? t.beginProgress('\u0424\u043e\u0440\u043c\u0438\u0440\u043e\u0432\u0430\u043d\u0438\u0435 PLY\u2026') : null;
    var setP = function (f, m) { try { if (stop && stop.set) stop.set(f, m); } catch (e) {} };
    try {
      var bytes = await plyBytes(cloud, function (f) { setP(f * 0.9, '\u0424\u043e\u0440\u043c\u0438\u0440\u043e\u0432\u0430\u043d\u0438\u0435 PLY\u2026'); });
      setP(0.95, '\u0421\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0438\u0435\u2026');
      var r;
      if (st.workingPath && !opts.askPath) {
        r = await A.saveCloudToPath({ path: st.workingPath, binary: bytes });
      } else {
        r = await A.saveCloud({ binary: bytes, name: nowName('ply') });
        if (r && r.ok && r.path) { st.workingPath = r.path; st.workingFmt = 'ply'; }
      }
      if (r && r.ok) {
        await markSaved('file', saveGeneration);
        if (!opts.silent) toast('\u0421\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e: ' + (r.path || st.workingPath));
        return { ok: true, path: r.path };
      }
      if (r && r.canceled) { return { ok: false, canceled: true }; }
      toast('\u041e\u0448\u0438\u0431\u043a\u0430 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0438\u044f: ' + ((r && r.error) || ''), true);
      return { ok: false };
    } catch (e) { toast('\u041e\u0448\u0438\u0431\u043a\u0430 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0438\u044f', true); return { ok: false }; }
    finally { st.saving = false; try { if (stop) stop(); } catch (e) {} renderChip(); }
  }

  // ---------- авто-сохранение по таймеру ----------
  async function autoTick() {
    if (!st.dirty || st.saving) { armTimer(); return; }
    if (st.workingPath) {
      // есть рабочий файл — тихо перезапишем его
      await save({ silent: true });
    } else {
      // иначе — черновик-бэкап в userData (без диалога)
      try { if (window.__pcAutosave && window.__pcAutosave.flush) { await window.__pcAutosave.flush(); st.lastDraftAt = Date.now(); } } catch (e) {}
    }
    renderChip(); armTimer();
  }
  function armTimer() {
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    if (st.intervalMin > 0) st.timer = setTimeout(autoTick, st.intervalMin * 60000);
  }
  function setInterval_(min) {
    st.intervalMin = Math.max(0, min | 0);
    try { localStorage.setItem(LS_MIN, String(st.intervalMin)); } catch (e) {}
    armTimer(); renderChip();
  }

  // ---------- экспорт во все форматы ----------
  async function exportAs(id) {
    var A = api(); if (!A || !A.exportFile) { toast('\u042d\u043a\u0441\u043f\u043e\u0440\u0442 \u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d \u0432 \u0434\u0435\u0441\u043a\u0442\u043e\u043f-\u0432\u0435\u0440\u0441\u0438\u0438', true); return; }
    var f = null; for (var i = 0; i < FORMATS.length; i++) if (FORMATS[i].id === id) f = FORMATS[i];
    if (!f) { toast('\u041d\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043d\u044b\u0439 \u0444\u043e\u0440\u043c\u0430\u0442', true); return; }
    var t = tools(); var stop = (t && t.beginProgress) ? t.beginProgress('\u042d\u043a\u0441\u043f\u043e\u0440\u0442\u2026') : null;
    var setP = function (fr, m) { try { if (stop && stop.set) stop.set(fr, m); } catch (e) {} };
    var streamId = null, cancelRequested = false, cancelListener = null;
    try {
      var payload = { name: 'export.' + f.ext, ext: f.ext, filterName: f.filterName, title: '\u042d\u043a\u0441\u043f\u043e\u0440\u0442 \u00b7 ' + f.label };
      if (f.kind === 'cloud') {
        var cloud = getCloud(); if (!cloud) { toast('\u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u043e\u0442\u043a\u0440\u043e\u0439\u0442\u0435 \u043e\u0431\u043b\u0430\u043a\u043e \u0442\u043e\u0447\u0435\u043a', true); return; }
        if (!window.PCEdit) { toast('\u041c\u043e\u0434\u0443\u043b\u044c \u0440\u0435\u0434\u0430\u043a\u0442\u0438\u0440\u043e\u0432\u0430\u043d\u0438\u044f \u043d\u0435 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043d', true); return; }
        var preflight = window.ExportHub && window.ExportHub.preflightExport ? window.ExportHub.preflightExport(f.id, cloud) : { ok:true, warnings:[] };
        if (!preflight.ok) { toast('Экспорт отменён: ' + (preflight.errors || []).join('; '), true); return; }
        var preflightWarnings = preflight.warnings || [];
        setP(0.2, '\u0424\u043e\u0440\u043c\u0438\u0440\u043e\u0432\u0430\u043d\u0438\u0435 ' + f.ext.toUpperCase() + '\u2026');
        if (f.id === 'ptx') {
          if (typeof A.beginExportStream !== 'function' || typeof A.writeExportStreamChunk !== 'function' ||
              typeof A.finishExportStream !== 'function' || typeof A.cancelExportStream !== 'function') {
            throw new Error('Потоковый PTX-экспорт недоступен в этой версии приложения');
          }
          var expectedPoints = cloud.count != null ? Number(cloud.count) : Math.floor((cloud.pos && cloud.pos.length || 0) / 3);
          var begun = await A.beginExportStream({ ext: 'ptx', name: payload.name, title: payload.title, expectedPoints: expectedPoints });
          if (begun && begun.canceled) return;
          if (!begun || !begun.ok || !begun.streamId) throw new Error((begun && begun.error) || 'Не удалось начать PTX-экспорт');
          streamId = begun.streamId;
          cancelListener = function (event) {
            if (!stop || !stop.token || !event || !event.detail || event.detail.token !== stop.token || cancelRequested) return;
            cancelRequested = true;
            if (streamId) A.cancelExportStream(streamId).catch(function () {});
          };
          window.addEventListener('lx-progress-cancel', cancelListener);
          setP(0.05, '\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 PTX \u0434\u0430\u043d\u043d\u044b\u0445\u2026');
          var generator = window.SmartSaveFmt && window.SmartSaveFmt.ptxTextChunksAsync;
          if (typeof generator !== 'function') throw new Error('Потоковый форматтер PTX не загружен');
          for await (var chunk of generator(cloud, 10000, function () { return cancelRequested; })) {
            if (cancelRequested) { var stopped = new Error('Экспорт отменён'); stopped.cancelled = true; throw stopped; }
            if (chunk.phase === 'scan') {
              setP(0.05 + 0.22 * chunk.points / chunk.total, '\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u0442\u043e\u0447\u0435\u043a: ' + chunk.points.toLocaleString() + ' / ' + chunk.total.toLocaleString());
              continue;
            }
            if (!chunk.text) continue;
            var written = await A.writeExportStreamChunk({ streamId: streamId, text: chunk.text });
            if (!written || !written.ok) {
              var writeError = new Error((written && written.error) || 'Ошибка потоковой записи PTX');
              if (written && written.cancelled) writeError.cancelled = true;
              throw writeError;
            }
            if (chunk.points) setP(0.3 + 0.62 * chunk.points / chunk.total, '\u0417\u0430\u043f\u0438\u0441\u044c PTX: ' + chunk.points.toLocaleString() + ' / ' + chunk.total.toLocaleString());
          }
          if (cancelRequested) { var stoppedAfterWrite = new Error('Экспорт отменён'); stoppedAfterWrite.cancelled = true; throw stoppedAfterWrite; }
          setP(0.95, '\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u0438 \u0444\u0438\u043a\u0441\u0430\u0446\u0438\u044f PTX\u2026');
          var streamed = await A.finishExportStream(streamId);
          streamId = null;
          if (!streamed || !streamed.ok) {
            var finishError = new Error((streamed && streamed.error) || 'Не удалось завершить PTX-экспорт');
            if (streamed && streamed.recoveryPath) finishError.message += ' · временный результат: ' + streamed.recoveryPath;
            throw finishError;
          }
          toast('\u042d\u043a\u0441\u043f\u043e\u0440\u0442\u0438\u0440\u043e\u0432\u0430\u043d\u043e: ' + streamed.path +
            (preflightWarnings.length ? ' · Предупреждения: ' + preflightWarnings.join('; ') : '') +
            ((streamed.warnings || []).length ? ' · ' + streamed.warnings.join('; ') : ''));
          return { ok: true, path: streamed.path, bytes: streamed.bytes, sha256: streamed.sha256 };
        }
        if (f.id === 'ply') { payload.binary = await plyBytes(cloud, function (fr) { setP(0.2 + fr * 0.7, '\u0424\u043e\u0440\u043c\u0438\u0440\u043e\u0432\u0430\u043d\u0438\u0435 PLY\u2026'); }); }
        else { await new Promise(function (r) { setTimeout(r, 30); }); var p = buildCloudPayload(f.id, cloud); if (p.binary != null) payload.binary = p.binary; else payload.text = p.text; }
      } else { // bim
        var m = bimModel(); if (!m || !m.ok) { toast('\u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u043f\u043e\u0441\u0442\u0440\u043e\u0439\u0442\u0435 BIM-\u043c\u043e\u0434\u0435\u043b\u044c (\ud83c\udfd7 \u0421\u043a\u0430\u043d\u2192BIM)', true); return; }
        if (!window.Scan2BIM) { toast('\u0414\u0432\u0438\u0436\u043e\u043a Scan2BIM \u043d\u0435 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043d', true); return; }
        setP(0.4, '\u042d\u043a\u0441\u043f\u043e\u0440\u0442 BIM\u2026');
        if (f.id === 'bim-ifc') payload.text = window.Scan2BIM.toIFC(m, { name: 'scan2bim.ifc', includeBeams: false, includePipes: false });
        else if (f.id === 'bim-obj') payload.text = window.Scan2BIM.toOBJ(m);
        else if (f.id === 'bim-dxf') payload.text = window.Scan2BIM.toDXF(m, { includeCandidates: false });
      }
      setP(0.95, '\u0421\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0438\u0435\u2026');
      var r = await A.exportFile(payload);
      if (r && r.ok) toast('\u042d\u043a\u0441\u043f\u043e\u0440\u0442\u0438\u0440\u043e\u0432\u0430\u043d\u043e: ' + r.path + (typeof preflightWarnings !== 'undefined' && preflightWarnings.length ? ' · Предупреждения: ' + preflightWarnings.join('; ') : ''));
      else if (!(r && r.canceled)) toast('\u041e\u0448\u0438\u0431\u043a\u0430 \u044d\u043a\u0441\u043f\u043e\u0440\u0442\u0430: ' + ((r && r.error) || ''), true);
    } catch (e) {
      if (e && (e.cancelled || cancelRequested)) toast('\u042d\u043a\u0441\u043f\u043e\u0440\u0442 \u043e\u0442\u043c\u0435\u043d\u0451\u043d');
      else toast('\u041e\u0448\u0438\u0431\u043a\u0430 \u044d\u043a\u0441\u043f\u043e\u0440\u0442\u0430: ' + (e && e.message || e), true);
    }
    finally {
      if (cancelListener) try { window.removeEventListener('lx-progress-cancel', cancelListener); } catch (e) {}
      if (streamId && A && A.cancelExportStream) try { await A.cancelExportStream(streamId); } catch (e) {}
      try { if (stop) stop(); } catch (e) {}
    }
  }

  // ===================== UI =====================
  var bar = null, chip = null, expPanel = null, bProjectUndo = null, bProjectRedo = null;
  function elx(tag, css, html) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (html != null) e.innerHTML = html; return e; }
  var TONE = { blue: 'var(--lx-blue)', neutral: 'var(--lx-neutral)' };

  function buildBar() {
    if (bar) return bar;
    bar = elx('div', 'position:fixed;right:16px;bottom:16px;z-index:60;display:none;align-items:center;gap:6px;padding:6px 8px;border-radius:12px;background:var(--panel);border:1px solid var(--line);box-shadow:var(--shadow-pop);font:12px system-ui,Segoe UI,Arial;color:var(--txt)');
    bar.className = 'lx-smart-save';
    chip = elx('span', 'display:inline-flex;align-items:center;gap:6px;color:var(--muted);padding:0 4px;min-width:96px');
    var bSave = elx('button', btn(TONE.blue), '\ud83d\udcbe \u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c');
    bSave.className = 'lx-smart-primary';
    bSave.title = '\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c (Ctrl+S). \u041f\u043e\u0432\u0442\u043e\u0440\u043d\u043e \u2014 \u0442\u0438\u0445\u043e \u0432 \u0442\u043e\u0442 \u0436\u0435 \u0444\u0430\u0439\u043b';
    bSave.addEventListener('click', function () { save({}); });
    var bHistory = elx('button', btn(TONE.neutral), '\u21bb \u0418\u0441\u0442\u043e\u0440\u0438\u044f');
    bHistory.className = 'lx-smart-secondary';
    bHistory.title = '\u041f\u043e\u043a\u0430\u0437\u0430\u0442\u044c \u0438 \u0432\u043e\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u044c \u043e\u0434\u043d\u0443 \u0438\u0437 \u0432\u0435\u0440\u0441\u0438\u0439 \u0447\u0435\u0440\u043d\u043e\u0432\u0438\u043a\u0430';
    bHistory.addEventListener('click', function () {
      if (window.__pcAutosave && window.__pcAutosave.offerHistory) window.__pcAutosave.offerHistory();
      else toast('\u0418\u0441\u0442\u043e\u0440\u0438\u044f \u0447\u0435\u0440\u043d\u043e\u0432\u0438\u043a\u043e\u0432 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u0430', true);
    });
    bProjectUndo = elx('button', btn(TONE.neutral), '\u21b6');
    bProjectUndo.className = 'lx-smart-secondary lx-project-undo';
    bProjectUndo.title = '\u041e\u0442\u043c\u0435\u043d\u0438\u0442\u044c \u043f\u043e\u0441\u043b\u0435\u0434\u043d\u044e\u044e \u0432\u0435\u0440\u0441\u0438\u044e \u0441\u043e\u0441\u0442\u043e\u044f\u043d\u0438\u044f \u043f\u0440\u043e\u0435\u043a\u0442\u0430';
    bProjectUndo.setAttribute('aria-label', bProjectUndo.title);
    bProjectUndo.addEventListener('click', function () { runProjectHistory('undo'); });
    bProjectRedo = elx('button', btn(TONE.neutral), '\u21b7');
    bProjectRedo.className = 'lx-smart-secondary lx-project-redo';
    bProjectRedo.title = '\u041f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u044c \u043e\u0442\u043c\u0435\u043d\u0451\u043d\u043d\u0443\u044e \u0432\u0435\u0440\u0441\u0438\u044e \u043f\u0440\u043e\u0435\u043a\u0442\u0430';
    bProjectRedo.setAttribute('aria-label', bProjectRedo.title);
    bProjectRedo.addEventListener('click', function () { runProjectHistory('redo'); });
    var bExp = elx('button', btn(TONE.neutral), '\u2b07 \u042d\u043a\u0441\u043f\u043e\u0440\u0442');
    bExp.className = 'lx-smart-secondary';
    bExp.title = '\u042d\u043a\u0441\u043f\u043e\u0440\u0442 \u0432\u043e \u0432\u0441\u0435 \u0444\u043e\u0440\u043c\u0430\u0442\u044b';
    bExp.addEventListener('click', toggleExport);
    var bGear = elx('button', btn(TONE.neutral), '\u2699');
    bGear.className = 'lx-smart-secondary';
    bGear.title = '\u0418\u043d\u0442\u0435\u0440\u0432\u0430\u043b \u0430\u0432\u0442\u043e-\u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0438\u044f';
    bGear.addEventListener('click', cycleInterval);
    bar.appendChild(chip); bar.appendChild(bProjectUndo); bar.appendChild(bProjectRedo);
    bar.appendChild(bHistory); bar.appendChild(bSave); bar.appendChild(bExp); bar.appendChild(bGear);
    wireProjectHistory();
    document.body.appendChild(bar);
    return bar;
  }
  function btn(bg) { return 'display:inline-flex;align-items:center;gap:5px;padding:6px 9px;border:none;border-radius:9px;background:' + bg + ';color:#fff;font:600 12px/1 system-ui;cursor:pointer'; }

  function renderChip() {
    if (!chip) return;
    var txt, col, dot;
    if (st.saving) { txt = '\u0421\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0438\u0435\u2026'; col = 'var(--lx-blue)'; dot = 'var(--lx-blue)'; }
    else if (st.dirty) { txt = '\u041d\u0435 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e'; col = 'var(--warn)'; dot = 'var(--warn)'; }
    else if (st.lastSavedAt) { txt = '\u0421\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e ' + hhmm(st.lastSavedAt); col = 'var(--ok)'; dot = 'var(--ok)'; }
    else if (st.lastDraftAt) { txt = '\u0427\u0435\u0440\u043d\u043e\u0432\u0438\u043a ' + hhmm(st.lastDraftAt); col = 'var(--muted)'; dot = 'var(--muted)'; }
    else { txt = '\u0413\u043e\u0442\u043e\u0432\u043e'; col = 'var(--muted)'; dot = 'var(--line)'; }
    var ai = st.intervalMin > 0 ? (' \u00b7 \u0430\u0432\u0442\u043e ' + st.intervalMin + '\u043c') : ' \u00b7 \u0430\u0432\u0442\u043e \u0432\u044b\u043a\u043b';
    chip.innerHTML = '<span style="width:9px;height:9px;border-radius:50%;background:' + dot + ';display:inline-block"></span>' +
      '<span style="color:' + col + '">' + txt + '</span><span style="color:var(--muted);font-size:11px">' + ai + '</span>';
  }

  function syncProjectHistoryButtons() {
    var ps = window.BimProjectState;
    if (bProjectUndo) bProjectUndo.disabled = !(ps && ps.canUndo);
    if (bProjectRedo) bProjectRedo.disabled = !(ps && ps.canRedo);
  }
  function wireProjectHistory() {
    if (window.__lxSmartSaveProjectHistory) { syncProjectHistoryButtons(); return; }
    window.__lxSmartSaveProjectHistory = true;
    ['bim-project-state-ready', 'bim-project-state-saved', 'bim-project-state-restored', 'bim-project-state-error']
      .forEach(function (name) { window.addEventListener(name, syncProjectHistoryButtons); });
    var ps = window.BimProjectState;
    if (ps && ps.ready) Promise.resolve(ps.ready).finally(syncProjectHistoryButtons);
    syncProjectHistoryButtons();
  }
  async function runProjectHistory(direction) {
    var ps = window.BimProjectState;
    if (!ps || typeof ps[direction] !== 'function') { toast('\u0418\u0441\u0442\u043e\u0440\u0438\u044f \u043f\u0440\u043e\u0435\u043a\u0442\u0430 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u0430', true); return; }
    syncProjectHistoryButtons();
    if ((direction === 'undo' && !ps.canUndo) || (direction === 'redo' && !ps.canRedo)) {
      toast('\u041d\u0435\u0442 \u0441\u043e\u0445\u0440\u0430\u043d\u0451\u043d\u043d\u043e\u0439 \u0432\u0435\u0440\u0441\u0438\u0438 \u0434\u043b\u044f ' + (direction === 'undo' ? '\u043e\u0442\u043c\u0435\u043d\u044b' : '\u043f\u043e\u0432\u0442\u043e\u0440\u0430'));
      return;
    }
    if (bProjectUndo) bProjectUndo.disabled = true;
    if (bProjectRedo) bProjectRedo.disabled = true;
    try {
      var result = await ps[direction]();
      if (!result || result.ok === false) toast('\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c ' + (direction === 'undo' ? '\u043e\u0442\u043c\u0435\u043d\u0438\u0442\u044c' : '\u043f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u044c') + ' \u0432\u0435\u0440\u0441\u0438\u044e \u043f\u0440\u043e\u0435\u043a\u0442\u0430: ' + String(result && result.error || '\u043e\u0448\u0438\u0431\u043a\u0430'), true);
      else toast(direction === 'undo' ? '\u0421\u043e\u0441\u0442\u043e\u044f\u043d\u0438\u0435 \u043f\u0440\u043e\u0435\u043a\u0442\u0430 \u043e\u0442\u043c\u0435\u043d\u0435\u043d\u043e' : '\u0421\u043e\u0441\u0442\u043e\u044f\u043d\u0438\u0435 \u043f\u0440\u043e\u0435\u043a\u0442\u0430 \u0432\u043e\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u043e');
    } catch (error) {
      toast('\u041e\u0448\u0438\u0431\u043a\u0430 \u0438\u0441\u0442\u043e\u0440\u0438\u0438 \u043f\u0440\u043e\u0435\u043a\u0442\u0430: ' + String(error && error.message || error), true);
    } finally { syncProjectHistoryButtons(); }
  }

  function cycleInterval() {
    var seq = [0, 1, 2, 5, 10];
    var idx = seq.indexOf(st.intervalMin); idx = (idx + 1) % seq.length;
    setInterval_(seq[idx]);
    toast(st.intervalMin > 0 ? ('\u0410\u0432\u0442\u043e-\u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0438\u0435 \u043a\u0430\u0436\u0434\u044b\u0435 ' + st.intervalMin + ' \u043c\u0438\u043d') : '\u0410\u0432\u0442\u043e-\u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0438\u0435 \u0432\u044b\u043a\u043b\u044e\u0447\u0435\u043d\u043e');
  }

  function toggleExport() {
    if (expPanel) { expPanel.remove(); expPanel = null; return; }
    expPanel = elx('div', ''); expPanel.className = 'lx-tool-panel'; expPanel.style.cssText = 'right:16px;bottom:60px;width:236px;padding:10px;font:12px system-ui';
    expPanel.appendChild(elx('div', 'color:var(--txt);font-weight:600;margin-bottom:6px', '\u2b07 \u042d\u043a\u0441\u043f\u043e\u0440\u0442 \u043e\u0431\u043b\u0430\u043a\u0430'));
    var hasBim = !!bimModel();
    FORMATS.forEach(function (f) {
      if (f.kind === 'bim' && f.id === 'bim-ifc') expPanel.appendChild(elx('div', 'color:var(--txt);font-weight:600;margin:8px 0 4px', '\ud83c\udfd7 BIM-\u043c\u043e\u0434\u0435\u043b\u044c' + (hasBim ? '' : ' (\u043d\u0435\u0442)')));
      var b = elx('button', 'display:block;width:100%;text-align:left;margin:3px 0;padding:7px 9px;border:none;border-radius:8px;background:var(--panel2);color:' + (f.kind === 'bim' && !hasBim ? 'var(--muted)' : 'var(--txt)') + ';font:600 12px system-ui;cursor:pointer', f.label);
      b.addEventListener('click', function () { exportAs(f.id); if (expPanel) { expPanel.remove(); expPanel = null; } });
      expPanel.appendChild(b);
    });
    document.body.appendChild(expPanel);
  }

  // показываем панель, когда в сцене есть облако
  function updateVisibility() {
    if (!bar) return;
    var show = !!getCloud();
    bar.style.display = show ? 'flex' : 'none';
  }

  // ---------- перехват правок: оборачиваем __pcAutosave.onEdit ----------
  var _wrapped = false;
  function wrapAutosave() {
    if (_wrapped) return;
    var as = window.__pcAutosave;
    if (!as || typeof as.onEdit !== 'function') return;
    var orig = as.onEdit;
    as.onEdit = function (n) { try { orig(n); } catch (e) {} setDirty(true); updateVisibility(); };
    // когда черновик очищается через saved() — наш markSaved уже вызывает его; не зацикливаемся
    _wrapped = true;
  }

  // ---------- закрытие окна: сохранить и закрыть ----------
  function wireClose() {
    var A = api(); if (!A || !A.onDoSaveThenClose) return;
    A.onDoSaveThenClose(async function () {
      var cloudSave = null;
      try {
        cloudSave = await save({ silent: true });
      } catch (e) {}
      var autosave = window.__pcAutosave;
      if (!(cloudSave && cloudSave.ok) || (autosave && autosave.isDirty && autosave.isDirty())) {
        try {
          var draft = autosave && autosave.flush ? await autosave.flush() : { ok: false, error: 'autosave_unavailable' };
          if (!draft || draft.ok === false || (autosave && autosave.isDirty && autosave.isDirty())) {
            toast('\u041e\u0431\u043b\u0430\u043a\u043e \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u043e \u0438 \u043d\u0435 \u0432\u0441\u0435 \u0434\u0430\u043d\u043d\u044b\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043d\u0430\u0434\u0451\u0436\u043d\u043e \u0441\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c — \u043e\u043a\u043d\u043e \u043e\u0441\u0442\u0430\u0432\u043b\u0435\u043d\u043e \u043e\u0442\u043a\u0440\u044b\u0442\u044b\u043c', true);
            return;
          }
        } catch (e) {
          toast('\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u044c \u0430\u0432\u0442\u043e\u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0438\u0435 — \u043e\u043a\u043d\u043e \u043e\u0441\u0442\u0430\u0432\u043b\u0435\u043d\u043e \u043e\u0442\u043a\u0440\u044b\u0442\u044b\u043c', true);
          return;
        }
      }
      try {
        if (window.BimProjectState && window.BimProjectState.flush) {
          var projectSave = await window.BimProjectState.flush();
          if (!(projectSave && projectSave.ok)) { toast('Не удалось сохранить состояние проекта — окно оставлено открытым', true); return; }
        }
      } catch (e) { toast('Не удалось сохранить состояние проекта — окно оставлено открытым', true); return; }
      try { A.closeConfirmed(); } catch (e) {}
    });
  }

  // ---------- горячие клавиши ----------
  function wireKeys() {
    if (window.__lxSmartSaveKeys) return; window.__lxSmartSaveKeys = true;
    window.addEventListener('keydown', function (e) {
      var k = (e.key || '').toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 's') {
        var tg = e.target;
        if (tg && (/^(input|textarea|select)$/i.test(tg.tagName || '') || tg.isContentEditable)) return;
        e.preventDefault(); save({});
      }
    });
  }

  // ---------- загрузка ----------
  function boot() {
    if (window.__lxSmartSaveBooted) return; window.__lxSmartSaveBooted = true;
    try { var m = parseInt(localStorage.getItem(LS_MIN), 10); if (!isNaN(m)) st.intervalMin = Math.max(0, m); } catch (e) {}
    buildBar(); renderChip(); wireKeys(); wireClose(); armTimer();
    wrapAutosave();
    window.addEventListener('lx-pctools-ready', function () { wrapAutosave(); updateVisibility(); });
    setInterval(function () { wrapAutosave(); updateVisibility(); }, 1500);
  }

  window.__lxSmartSave = {
    save: save,
    exportAs: exportAs,
    setInterval: setInterval_,
    undoProjectState: function () { return runProjectHistory('undo'); },
    redoProjectState: function () { return runProjectHistory('redo'); },
    openAutosaveHistory: function () {
      if (window.__pcAutosave && typeof window.__pcAutosave.offerHistory === 'function') {
        window.__pcAutosave.offerHistory(); return true;
      }
      toast('\u0418\u0441\u0442\u043e\u0440\u0438\u044f \u0447\u0435\u0440\u043d\u043e\u0432\u0438\u043a\u043e\u0432 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u0430', true); return false;
    },
    status: function () { return { dirty: st.dirty, saving: st.saving, lastSavedAt: st.lastSavedAt, workingPath: st.workingPath, intervalMin: st.intervalMin }; },
    formats: FORMATS,
    _state: st
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
