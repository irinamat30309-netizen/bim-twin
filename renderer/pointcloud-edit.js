/*
 * pointcloud-edit.js — чистая логика редактирования облака точек (Phase 4).
 *
 * Без GPU/DOM — только геометрия, чтобы можно было покрыть unit-тестами.
 * Проекцию точек на экран делает вьювер (знает матрицу VP), а сюда передаёт уже
 * спроецированные 2D-координаты (NDC или пиксели — единицы не важны, лишь бы совпадали
 * с rect/poly). Точки за камерой передаются как NaN и игнорируются.
 */
(function () {
  'use strict';

  function normSet(indices) { return (indices instanceof Set) ? indices : new Set(indices); }

  // Точка внутри многоугольника (ray casting). poly: [[x,y],...]
  function pointInPolygon(pt, poly) {
    const x = pt[0], y = pt[1]; let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      const denom = (yj - yi) || 1e-20;
      const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / denom + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // Выбор прямоугольной рамкой. xy: Float32Array длиной count*2. rect: {x0,y0,x1,y1}.
  function selectByRect(xy, count, rect) {
    const x0 = Math.min(rect.x0, rect.x1), x1 = Math.max(rect.x0, rect.x1);
    const y0 = Math.min(rect.y0, rect.y1), y1 = Math.max(rect.y0, rect.y1);
    const out = [];
    for (let i = 0; i < count; i++) {
      const x = xy[i * 2], y = xy[i * 2 + 1];
      if (x !== x || y !== y) continue; // NaN = за камерой/вне кадра
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.push(i);
    }
    return out;
  }

  // Выбор лассо (произвольный многоугольник).
  function selectByPolygon(xy, count, poly) {
    if (!poly || poly.length < 3) return [];
    // Плоские типизированные массивы вершин + inline point-in-polygon: без аллокаций на точку (десятки млн точек).
    const V = poly.length;
    const px = new Float64Array(V), py = new Float64Array(V);
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let v = 0; v < V; v++) { const X = poly[v][0], Y = poly[v][1]; px[v] = X; py[v] = Y; if (X < bx0) bx0 = X; if (X > bx1) bx1 = X; if (Y < by0) by0 = Y; if (Y > by1) by1 = Y; }
    const out = [];
    for (let i = 0; i < count; i++) {
      const x = xy[i * 2], y = xy[i * 2 + 1];
      if (x !== x || y !== y) continue;
      if (x < bx0 || x > bx1 || y < by0 || y > by1) continue;
      let inside = false;
      for (let a = 0, b = V - 1; a < V; b = a++) {
        const yi = py[a], yj = py[b];
        if ((yi > y) !== (yj > y)) {
          const xi = px[a], xj = px[b];
          if (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-20) + xi) inside = !inside;
        }
      }
      if (inside) out.push(i);
    }
    return out;
  }

  function invertSelection(indices, count) {
    const rem = normSet(indices); const out = [];
    for (let i = 0; i < count; i++) if (!rem.has(i)) out.push(i);
    return out;
  }

  // Удалить точки по индексам → новый {pos, col, removed}. Сохраняет тип col (Float32/Uint8).
  function deleteByIndices(cloud, indices) {
    return _rebuild(cloud, indices, false);
  }
  // Оставить только выбранные точки (кроп).
  function keepByIndices(cloud, indices) {
    return _rebuild(cloud, indices, true);
  }
  // LAS/PLY data is point-indexed: rebuilding only XYZ/RGB silently detached
  // intensity and classification from their points. Preserve known fields and
  // other typed point arrays whose length is an unambiguous per-point stride.
  const _POINT_ATTR_STRIDES = {
    col: 3, color: 3, colors: 3, rgb: 3, normal: 3, normals: 3, nor: 3,
    intensity: 1, classification: 1, gpsTime: 1, gps_time: 1, timestamp: 1,
    time: 1, returnNumber: 1, numberOfReturns: 1, scanAngle: 1,
    pointSourceId: 1, userData: 1, scanDirectionFlag: 1, edgeOfFlightLine: 1
  };
  const _NON_POINT_ARRAY_KEYS = new Set([
    'pos', 'positions', 'indices', 'index', 'faces', 'triangles', 'meta',
    'bbox', 'bounds', 'scans', 'count', 'pointAttributeStrides'
  ]);

  function _pointAttributeSpecs(cloud, count) {
    if (!cloud || !count) return [];
    const declared = cloud.pointAttributeStrides || {};
    const specs = [];
    Object.keys(cloud).forEach(function (key) {
      if (_NON_POINT_ARRAY_KEYS.has(key)) return;
      const values = cloud[key];
      if (!ArrayBuffer.isView(values) || values instanceof DataView) return;
      let stride = Number(declared[key] || _POINT_ATTR_STRIDES[key]);
      if (!stride && values.length % count === 0) stride = values.length / count;
      if (!Number.isInteger(stride) || stride < 1 || stride > 16 || values.length !== count * stride) return;
      specs.push({ key: key, values: values, stride: stride });
    });
    return specs;
  }

  function _emptyRemoval(values) {
    return values ? new values.constructor(0) : null;
  }

  function _noRemoval(cloud, extra) {
    const pos = cloud && cloud.pos || new Float32Array(0);
    const count = Math.floor(pos.length / 3);
    const result = {
      pos: pos, col: cloud && cloud.col || null, removed: 0,
      removedPos: new Float32Array(0), removedCol: _emptyRemoval(cloud && cloud.col)
    };
    const removedAttributes = {};
    _pointAttributeSpecs(cloud, count).forEach(function (spec) {
      if (spec.key === 'col') return;
      result[spec.key] = spec.values;
      removedAttributes[spec.key] = _emptyRemoval(spec.values);
      result['removed' + spec.key.charAt(0).toUpperCase() + spec.key.slice(1)] = removedAttributes[spec.key];
    });
    result.removedAttributes = removedAttributes;
    return Object.assign(result, extra || {});
  }

  function _rebuildMask(cloud, keep, keepN, count) {
    const pos = cloud && cloud.pos;
    const specs = _pointAttributeSpecs(cloud, count);
    const removedN = count - keepN;
    const outPos = new Float32Array(keepN * 3);
    const remPos = new Float32Array(removedN * 3);
    const arrays = specs.map(function (spec) {
      return {
        spec: spec,
        kept: new spec.values.constructor(keepN * spec.stride),
        removed: new spec.values.constructor(removedN * spec.stride)
      };
    });
    let ki = 0, ri = 0;
    for (let i = 0; i < count; i++) {
      const isKept = !!keep[i];
      const dstPoint = isKept ? ki++ : ri++;
      const dstPos = isKept ? outPos : remPos;
      dstPos[dstPoint * 3] = pos[i * 3];
      dstPos[dstPoint * 3 + 1] = pos[i * 3 + 1];
      dstPos[dstPoint * 3 + 2] = pos[i * 3 + 2];
      for (let a = 0; a < arrays.length; a++) {
        const entry = arrays[a], src = entry.spec.values;
        const dst = isKept ? entry.kept : entry.removed;
        const stride = entry.spec.stride, from = i * stride, to = dstPoint * stride;
        for (let j = 0; j < stride; j++) dst[to + j] = src[from + j];
      }
    }
    const result = { pos: outPos, col: null, removed: removedN, removedPos: remPos, removedCol: null, removedAttributes: {} };
    for (let a = 0; a < arrays.length; a++) {
      const entry = arrays[a], key = entry.spec.key;
      if (key === 'col') {
        result.col = entry.kept;
        result.removedCol = entry.removed;
      } else {
        result[key] = entry.kept;
        result.removedAttributes[key] = entry.removed;
        result['removed' + key.charAt(0).toUpperCase() + key.slice(1)] = entry.removed;
      }
    }
    return result;
  }

  function _rebuild(cloud, indices, keep) {
    const pos = cloud && cloud.pos;
    if (!pos || pos.length % 3) throw new TypeError('cloud.pos must contain complete XYZ triples');
    const n = pos.length / 3;
    const set = normSet(indices);
    const mask = new Uint8Array(n);
    let keepCount = 0;
    for (let i = 0; i < n; i++) {
      const inSet = set.has(i);
      if (keep ? inSet : !inSet) { mask[i] = 1; keepCount++; }
    }
    return _rebuildMask(cloud, mask, keepCount, n);
  }

  function _plyExportInfo(cloud) {
    const pos = cloud && cloud.pos;
    if (!pos || !Number.isSafeInteger(pos.length) || pos.length % 3) throw new RangeError('invalid_position_array');
    const n = pos.length / 3;
    const col = cloud.col == null ? null : cloud.col;
    const intensity = cloud.intensity == null ? null : cloud.intensity;
    const classification = cloud.classification == null ? null : cloud.classification;
    if (col && col.length !== n * 3) throw new RangeError('color_array_length_mismatch');
    if (intensity && intensity.length !== n) throw new RangeError('intensity_array_length_mismatch');
    if (classification && classification.length !== n) throw new RangeError('classification_array_length_mismatch');
    return { pos: pos, col: col, intensity: intensity, classification: classification, n: n };
  }
  function _plyColorMode(col) {
    if (!col) return false;
    let mx = 0;
    const lim = Math.min(col.length, 300);
    for (let i = 0; i < lim; i++) {
      const value = Number(col[i]);
      if (!Number.isFinite(value)) throw new RangeError('invalid_color_value');
      if (value > mx) mx = value;
    }
    return mx <= 1.0001;
  }
  function _plyColorByte(value, scaled) {
    value = Number(value);
    if (!Number.isFinite(value)) throw new RangeError('invalid_color_value');
    value = scaled ? Math.round(value * 255) : Math.round(value);
    return value < 0 ? 0 : (value > 255 ? 255 : value);
  }
  function _plyIntensity(value) {
    value = Number(value);
    if (!Number.isFinite(value) || Math.abs(value) > 3.402823466e38) throw new RangeError('invalid_intensity_value');
    return value;
  }
  function _plyClass(value) {
    value = Number(value);
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError('invalid_classification_value');
    return value;
  }
  function _plyHeader(info, format, binary) {
    const H = ['ply', 'format ' + format + ' 1.0', 'comment BIM Twin point cloud export' + (binary ? ' (binary)' : ''),
      'element vertex ' + info.n, 'property float x', 'property float y', 'property float z'];
    if (info.col) H.push('property uchar red', 'property uchar green', 'property uchar blue');
    if (info.intensity) H.push('property float intensity');
    if (info.classification) H.push('property uchar classification');
    H.push('end_header');
    if (binary) H.push('');
    return H;
  }
  // Экспорт в ASCII PLY сохраняет поточечные атрибуты; class остаётся отдельным LAS-кодом.
  function toPLY(cloud) {
    const q = _plyExportInfo(cloud), scaled = _plyColorMode(q.col);
    const L = _plyHeader(q, 'ascii', false);
    for (let i = 0; i < q.n; i++) {
      const p = i * 3;
      const xyz = [Number(q.pos[p]), Number(q.pos[p + 1]), Number(q.pos[p + 2])];
      if (!xyz.every(Number.isFinite)) throw new RangeError('non_finite_coordinates');
      let line = xyz.join(' ');
      if (q.col) line += ' ' + _plyColorByte(q.col[p], scaled) + ' ' + _plyColorByte(q.col[p + 1], scaled) + ' ' + _plyColorByte(q.col[p + 2], scaled);
      if (q.intensity) line += ' ' + _plyIntensity(q.intensity[i]);
      if (q.classification) line += ' ' + _plyClass(q.classification[i]);
      L.push(line);
    }
    return L.join('\n') + '\n';
  }

  // Экспорт в бинарный PLY (binary_little_endian) — компактно и быстро,
  // снимает практический лимит ASCII-экспорта (~8 млн точек): байт вместо
  // длинных текстовых строк. Возвращает Uint8Array (заголовок ASCII + бинарное тело).
  // col может быть float 0..1 или uchar 0..255 — определяем автоматически, как в toPLY.
  function toPLYBinary(cloud) {
    const q = _plyExportInfo(cloud), scaled = _plyColorMode(q.col);
    const headerStr = _plyHeader(q, 'binary_little_endian', true).join('\n');
    const headerBytes = new Uint8Array(headerStr.length);
    for (let i = 0; i < headerStr.length; i++) headerBytes[i] = headerStr.charCodeAt(i) & 0xff;
    const stride = 12 + (q.col ? 3 : 0) + (q.intensity ? 4 : 0) + (q.classification ? 1 : 0);
    const body = new ArrayBuffer(q.n * stride);
    const dv = new DataView(body);
    let off = 0;
    for (let i = 0; i < q.n; i++) {
      const p = i * 3;
      for (let a = 0; a < 3; a++) {
        const value = Number(q.pos[p + a]);
        if (!Number.isFinite(value) || Math.abs(value) > 3.402823466e38) throw new RangeError('invalid_position_value');
        dv.setFloat32(off, value, true); off += 4;
      }
      if (q.col) {
        dv.setUint8(off, _plyColorByte(q.col[p], scaled)); off += 1;
        dv.setUint8(off, _plyColorByte(q.col[p + 1], scaled)); off += 1;
        dv.setUint8(off, _plyColorByte(q.col[p + 2], scaled)); off += 1;
      }
      if (q.intensity) { dv.setFloat32(off, _plyIntensity(q.intensity[i]), true); off += 4; }
      if (q.classification) { dv.setUint8(off, _plyClass(q.classification[i])); off += 1; }
    }
    const out = new Uint8Array(headerBytes.length + body.byteLength);
    out.set(headerBytes, 0);
    out.set(new Uint8Array(body), headerBytes.length);
    return out;
  }

  // Асинхронный чанковый экспорт в бинарный PLY с колбэком прогресса onProgress(0..1).
  // Пишет тело чанками и отдаёт управление event loop между ними, чтобы счётчик
  // процентов обновлялся и вкладка не «зависала» на больших облаках (авто-сохранение/экспорт).
  async function toPLYBinaryAsync(cloud, onProgress) {
    const q = _plyExportInfo(cloud), scaled = _plyColorMode(q.col);
    const headerStr = _plyHeader(q, 'binary_little_endian', true).join('\n');
    const headerBytes = new Uint8Array(headerStr.length);
    for (let i = 0; i < headerStr.length; i++) headerBytes[i] = headerStr.charCodeAt(i) & 0xff;
    const stride = 12 + (q.col ? 3 : 0) + (q.intensity ? 4 : 0) + (q.classification ? 1 : 0);
    const body = new ArrayBuffer(q.n * stride);
    const dv = new DataView(body);
    const CHUNK = 300000;
    const yield_ = () => new Promise(r => (typeof setTimeout === 'function' ? setTimeout(r, 0) : r()));
    for (let start = 0; start < q.n; start += CHUNK) {
      const end = Math.min(q.n, start + CHUNK);
      for (let i = start; i < end; i++) {
        const p = i * 3, base = i * stride;
        for (let a = 0; a < 3; a++) {
          const value = Number(q.pos[p + a]);
          if (!Number.isFinite(value) || Math.abs(value) > 3.402823466e38) throw new RangeError('invalid_position_value');
          dv.setFloat32(base + a * 4, value, true);
        }
        let off = base + 12;
        if (q.col) {
          dv.setUint8(off++, _plyColorByte(q.col[p], scaled));
          dv.setUint8(off++, _plyColorByte(q.col[p + 1], scaled));
          dv.setUint8(off++, _plyColorByte(q.col[p + 2], scaled));
        }
        if (q.intensity) { dv.setFloat32(off, _plyIntensity(q.intensity[i]), true); off += 4; }
        if (q.classification) dv.setUint8(off, _plyClass(q.classification[i]));
      }
      if (typeof onProgress === 'function') { try { onProgress(q.n ? end / q.n : 1); } catch (e) {} }
      if (end < q.n) await yield_();
    }
    const out = new Uint8Array(headerBytes.length + body.byteLength);
    out.set(headerBytes, 0);
    out.set(new Uint8Array(body), headerBytes.length);
    return out;
  }

  // Шаг 3 (рекомендованный пайплайн): Euclidean Clustering / DBSCAN по воксельной сетке.
  // После экранного фильтра (Шаг 1) и Z-буфера (Шаг 2) в выборке могут оставаться
  // точки фона, просвечивающие в зазорах между разреженными сплэтами (а на LOD/octree GPU-pick
  // вообще недоступен). Здесь выборка группируется в связные 3D-кластеры (26-связность
  // занятых вокселей с ребром voxel ≈ r), и остаются лишь кластеры у переднего края:
  // те, чья минимальная глубина не дальше globalNear + band. Фоновая стена/деревья,
  // отделённые пространственным зазором, отбрасываются. Передняя поверхность на одной
  // глубине сохраняется целиком, даже если разбита на несколько связных кусков (они на близкой глубине).
  // pos: Float32Array xyz всего облака. indices: выбранные индексы.
  // opts.depth: Float32Array глубины (меньше = ближе). opts.voxel: ребро вокселя/радиус связности.
  // opts.band: допуск по глубине за передним кластером. opts.minCount: ниже — кластеризация пропускается.
  // opts.maxCount: выше — пропускаем (защита от тяжёлых выборок).
  function clusterFront(pos, indices, opts) {
    opts = opts || {};
    const idx = Array.isArray(indices) ? indices : Array.from(indices);
    const minCount = opts.minCount != null ? opts.minCount : 24;
    const maxCount = opts.maxCount != null ? opts.maxCount : 3000000;
    if (idx.length < minCount || idx.length > maxCount) return idx;
    const voxel = opts.voxel;
    if (!(voxel > 0) || !pos) return idx;
    const depth = opts.depth || null;
    const band = opts.band != null ? opts.band : Infinity;
    const inv = 1 / voxel;
    // Воксели: ключ → vid; параллельные массивы для BFS.
    const keyToVid = new Map();
    const vcoord = []; // [ix,iy,iz]
    const vmembers = []; // массивы позиций в idx
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const ix = Math.floor(pos[i * 3] * inv), iy = Math.floor(pos[i * 3 + 1] * inv), iz = Math.floor(pos[i * 3 + 2] * inv);
      const key = ix + ':' + iy + ':' + iz;
      let vid = keyToVid.get(key);
      if (vid === undefined) { vid = vcoord.length; keyToVid.set(key, vid); vcoord.push([ix, iy, iz]); vmembers.push([]); }
      vmembers[vid].push(k);
    }
    const nv = vcoord.length;
    if (nv <= 1) return idx;
    // Связные компоненты по 26-связности занятых вокселей (BFS).
    const comp = new Int32Array(nv).fill(-1);
    const queue = new Int32Array(nv);
    let nComp = 0;
    for (let s = 0; s < nv; s++) {
      if (comp[s] !== -1) continue;
      let head = 0, tail = 0; queue[tail++] = s; comp[s] = nComp;
      while (head < tail) {
        const v = queue[head++]; const c = vcoord[v];
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const nb = keyToVid.get((c[0] + dx) + ':' + (c[1] + dy) + ':' + (c[2] + dz));
          if (nb === undefined || comp[nb] !== -1) continue;
          comp[nb] = nComp; queue[tail++] = nb;
        }
      }
      nComp++;
    }
    if (nComp <= 1) return idx; // всё связно — один объект, убирать нечего
    // Ближняя глубина каждого компонента (минимум по валидным глубинам его точек).
    const compNear = new Float32Array(nComp).fill(Infinity);
    const compSize = new Int32Array(nComp);
    for (let v = 0; v < nv; v++) {
      const c = comp[v]; const mem = vmembers[v];
      compSize[c] += mem.length;
      if (depth) { for (let m = 0; m < mem.length; m++) { const d = depth[idx[mem[m]]]; if (d === d && d < compNear[c]) compNear[c] = d; } }
    }
    let keep;
    if (depth) {
      let globalNear = Infinity;
      for (let c = 0; c < nComp; c++) if (compNear[c] < globalNear) globalNear = compNear[c];
      keep = new Uint8Array(nComp);
      for (let c = 0; c < nComp; c++) keep[c] = (compNear[c] <= globalNear + band) ? 1 : 0;
    } else {
      // без глубины — оставляем крупнейший связный кластер
      let best = 0; for (let c = 1; c < nComp; c++) if (compSize[c] > compSize[best]) best = c;
      keep = new Uint8Array(nComp); keep[best] = 1;
    }
    const out = [];
    for (let v = 0; v < nv; v++) { if (!keep[comp[v]]) continue; const mem = vmembers[v]; for (let m = 0; m < mem.length; m++) out.push(idx[mem[m]]); }
    return out.length ? out : idx;
  }

  // Удаление ОТСОЕДИНЁННЫХ кластеров (Euclidean clustering): связные компоненты
  // по 26-связности занятых вокселей. Главная структура (стены/пол/потолок)
  // — один большой кластер; летающий мусор и отсоединённые куски — мелкие кластеры, удаляются.
  // opts.voxel: ребро вокселя связности (≈ 3-4 шага облака). opts.minClusterPts: меньше — удалить. opts.keepRatio: доля от крупнейшего.
  function cleanClusters(cloud, opts) {
    opts = opts || {};
    const pos = cloud.pos, col = cloud.col || null;
    const n = pos.length / 3;
    const empty = _noRemoval(cloud, { clusters: 0 });
    if (n < 32) return empty;
    let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
    for (let i=0;i<n;i++){ const x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2]; if(x<minx)minx=x; if(x>maxx)maxx=x; if(y<miny)miny=y; if(y>maxy)maxy=y; if(z<minz)minz=z; if(z>maxz)maxz=z; }
    const dx=maxx-minx, dy=maxy-miny, dz=maxz-minz;
    const diag = Math.sqrt(dx*dx+dy*dy+dz*dz) || 1;
    let voxel = (opts.voxel && opts.voxel > 0) ? opts.voxel : diag * 0.004;
    let gx,gy,gz,cells;
    for (let guard=0; guard<48; guard++){
      gx=Math.max(1,Math.floor(dx/voxel)+1); gy=Math.max(1,Math.floor(dy/voxel)+1); gz=Math.max(1,Math.floor(dz/voxel)+1);
      cells=gx*gy*gz; if (cells <= 3e7) break; voxel *= 1.4;
    }
    const gxy = gx*gy;
    const counts = new Int32Array(cells);
    const cellOf = new Int32Array(n);
    const inv = 1/voxel;
    for (let i=0;i<n;i++){
      let ix=((pos[i*3]-minx)*inv)|0; if(ix>=gx)ix=gx-1; if(ix<0)ix=0;
      let iy=((pos[i*3+1]-miny)*inv)|0; if(iy>=gy)iy=gy-1; if(iy<0)iy=0;
      let iz=((pos[i*3+2]-minz)*inv)|0; if(iz>=gz)iz=gz-1; if(iz<0)iz=0;
      const c = ix + gx*(iy + gy*iz); cellOf[i]=c; counts[c]++;
    }
    // занятые ячейки → компактный список
    let nocc = 0;
    for (let c=0;c<cells;c++){ if (counts[c] > 0) nocc++; }
    if (nocc <= 1) return empty;
    const occOf = new Int32Array(cells).fill(-1);
    const occCell = new Int32Array(nocc);
    let t = 0;
    for (let c=0;c<cells;c++){ if (counts[c] > 0){ occOf[c]=t; occCell[t]=c; t++; } }
    // связные компоненты (BFS по занятым ячейкам, 26-связность)
    const label = new Int32Array(nocc);
    const stack = new Int32Array(nocc);
    let nComp = 0;
    for (let s=0;s<nocc;s++){
      if (label[s] !== 0) continue;
      nComp++; label[s]=nComp; let sp=0; stack[sp++]=s;
      while (sp>0){
        const o = stack[--sp]; const c = occCell[o];
        const iz=(c/gxy)|0; const rem=c-iz*gxy; const iy=(rem/gx)|0; const ix=rem-iy*gx;
        for (let ddz=-1; ddz<=1; ddz++){ const nz=iz+ddz; if(nz<0||nz>=gz)continue;
          for (let ddy=-1; ddy<=1; ddy++){ const ny=iy+ddy; if(ny<0||ny>=gy)continue;
            for (let ddx=-1; ddx<=1; ddx++){ if(ddx===0&&ddy===0&&ddz===0)continue; const nx=ix+ddx; if(nx<0||nx>=gx)continue;
              const nc = nx + gx*(ny + gy*nz); const no = occOf[nc]; if(no<0||label[no]!==0)continue; label[no]=nComp; stack[sp++]=no;
            }
          }
        }
      }
    }
    if (nComp <= 1) return empty; // всё связно — убирать нечего
    // размер компонент (число точек)
    const compSize = new Float64Array(nComp+1);
    for (let o=0;o<nocc;o++){ compSize[label[o]] += counts[occCell[o]]; }
    let maxSize=0, maxComp=1; for (let c=1;c<=nComp;c++){ if(compSize[c]>maxSize){maxSize=compSize[c];maxComp=c;} }
    const minPts = (opts.minClusterPts != null) ? opts.minClusterPts : Math.max(150, Math.round(n*0.0008));
    const keepRatio = (opts.keepRatio != null) ? opts.keepRatio : 0;
    const thr = Math.max(minPts, keepRatio*maxSize);
    const keep = new Uint8Array(nComp+1);
    for (let c=1;c<=nComp;c++) keep[c] = (compSize[c] >= thr) ? 1 : 0;
    keep[maxComp]=1; // главную структуру всегда сохраняем
    const mask = new Uint8Array(n);
    let keepCount=0;
    for (let i=0;i<n;i++){ const o=occOf[cellOf[i]]; if (o>=0 && keep[label[o]]){ mask[i]=1; keepCount++; } }
    if (n - keepCount === 0) return empty;
    const result = _rebuildMask(cloud, mask, keepCount, n);
    result.clusters = nComp;
    return result;
  }

  // Готовая чистка шума: воксельный фильтр плотности (принцип SOR/voxel как в CloudCompare/Open3D).
  // Точка удаляется, если в её вокселе меньше minPts точек. O(n), типизированные массивы.
  function cleanVoxelDensity(cloud, opts) {
    opts = opts || {};
    const pos = cloud.pos, col = cloud.col || null;
    const n = pos.length / 3;
    const empty = _noRemoval(cloud, { voxel: 0 });
    if (n < 8) return empty;
    let minx=Infinity,miny=Infinity,minz=Infinity,maxx=-Infinity,maxy=-Infinity,maxz=-Infinity;
    for (let i=0;i<n;i++){ const x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2]; if(x<minx)minx=x; if(x>maxx)maxx=x; if(y<miny)miny=y; if(y>maxy)maxy=y; if(z<minz)minz=z; if(z>maxz)maxz=z; }
    const dx=maxx-minx, dy=maxy-miny, dz=maxz-minz;
    const diag = Math.sqrt(dx*dx+dy*dy+dz*dz) || 1;
    let voxel = (opts.voxel && opts.voxel > 0) ? opts.voxel : diag * 0.005;
    const minPts = (opts.minPts != null) ? (opts.minPts | 0) : 6;
    let gx,gy,gz,cells;
    for (let guard=0; guard<40; guard++){
      gx=Math.max(1,Math.floor(dx/voxel)+1); gy=Math.max(1,Math.floor(dy/voxel)+1); gz=Math.max(1,Math.floor(dz/voxel)+1);
      cells=gx*gy*gz; if (cells <= 5e7) break; voxel *= 1.4;
    }
    const counts = new Int32Array(cells);
    const cell = new Int32Array(n);
    const inv = 1/voxel;
    for (let i=0;i<n;i++){
      let ix=((pos[i*3]-minx)*inv)|0; if(ix>=gx)ix=gx-1; if(ix<0)ix=0;
      let iy=((pos[i*3+1]-miny)*inv)|0; if(iy>=gy)iy=gy-1; if(iy<0)iy=0;
      let iz=((pos[i*3+2]-minz)*inv)|0; if(iz>=gz)iz=gz-1; if(iz<0)iz=0;
      const c = ix + gx*(iy + gy*iz); cell[i]=c; counts[c]++;
    }
    const mask = new Uint8Array(n);
    let keepCount=0;
    for (let i=0;i<n;i++){ if (counts[cell[i]] >= minPts) { mask[i]=1; keepCount++; } }
    const result = _rebuildMask(cloud, mask, keepCount, n);
    result.voxel = voxel;
    return result;
  }

  
  function _p56rng(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
  function _p56bounds(pos,count){var mn=[Infinity,Infinity,Infinity],mx=[-Infinity,-Infinity,-Infinity];for(var i=0;i<count;i++){for(var k=0;k<3;k++){var v=pos[i*3+k];if(v<mn[k])mn[k]=v;if(v>mx[k])mx[k]=v;}}return{mn:mn,mx:mx};}
  function detectPlanes(pos,count,opts){opts=opts||{};count=count|0;if(!pos||count<3)return [];var b=_p56bounds(pos,count);var dx=b.mx[0]-b.mn[0],dy=b.mx[1]-b.mn[1],dz=b.mx[2]-b.mn[2];var diag=Math.sqrt(dx*dx+dy*dy+dz*dz)||1;var tol=opts.tol!=null?opts.tol:Math.max(diag*0.004,1e-4);var maxPlanes=opts.maxPlanes!=null?opts.maxPlanes:3;var iters=opts.iters!=null?opts.iters:120;var minFrac=opts.minFrac!=null?opts.minFrac:0.04;var sampleCap=opts.sample!=null?opts.sample:20000;var seed=opts.seed!=null?opts.seed:1337;var rnd=_p56rng(seed>>>0);var sample;if(count>sampleCap){sample=new Int32Array(sampleCap);for(var i=0;i<sampleCap;i++)sample[i]=Math.min(count-1,(rnd()*count)|0);}else{sample=new Int32Array(count);for(var i=0;i<count;i++)sample[i]=i;}var S=sample.length;var used=new Uint8Array(S);var planes=[];var minCount=Math.max(3,Math.floor(S*minFrac));for(var pi=0;pi<maxPlanes;pi++){var best=null,bestCnt=0;for(var it=0;it<iters;it++){var i0=(rnd()*S)|0,i1=(rnd()*S)|0,i2=(rnd()*S)|0;if(i0===i1||i1===i2||i0===i2)continue;if(used[i0]||used[i1]||used[i2])continue;var a=sample[i0],b2=sample[i1],c=sample[i2];var ax=pos[a*3],ay=pos[a*3+1],az=pos[a*3+2];var bx=pos[b2*3],by=pos[b2*3+1],bz=pos[b2*3+2];var cx=pos[c*3],cy=pos[c*3+1],cz=pos[c*3+2];var ux=bx-ax,uy=by-ay,uz=bz-az;var vx=cx-ax,vy=cy-ay,vz=cz-az;var nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;var nl=Math.sqrt(nx*nx+ny*ny+nz*nz);if(nl<1e-12)continue;nx/=nl;ny/=nl;nz/=nl;var d=-(nx*ax+ny*ay+nz*az);var cnt=0;for(var s=0;s<S;s++){if(used[s])continue;var idx=sample[s];var dist=Math.abs(nx*pos[idx*3]+ny*pos[idx*3+1]+nz*pos[idx*3+2]+d);if(dist<=tol)cnt++;}if(cnt>bestCnt){bestCnt=cnt;best={normal:[nx,ny,nz],d:d};}}if(!best||bestCnt<minCount)break;var inl=0;for(var s=0;s<S;s++){if(used[s])continue;var idx=sample[s];var dist=Math.abs(best.normal[0]*pos[idx*3]+best.normal[1]*pos[idx*3+1]+best.normal[2]*pos[idx*3+2]+best.d);if(dist<=tol){used[s]=1;inl++;}}var absz=Math.abs(best.normal[2]);var axis=absz>0.7?'floor/ceiling':'wall';planes.push({normal:best.normal,d:best.d,count:inl,sampleCount:S,tol:tol,axis:axis});}planes.sort(function(p,q){return q.count-p.count;});return planes;}
  function protectPlanes(indices,pos,planes,tol){if(!planes||!planes.length)return Array.isArray(indices)?indices.slice():Array.from(indices);var arr=Array.isArray(indices)?indices:Array.from(indices);var out=[];for(var i=0;i<arr.length;i++){var idx=arr[i];var x=pos[idx*3],y=pos[idx*3+1],z=pos[idx*3+2];var onP=false;for(var p=0;p<planes.length;p++){var pl=planes[p];var t=(tol!=null?tol:(pl.tol!=null?pl.tol:0.02));var dist=Math.abs(pl.normal[0]*x+pl.normal[1]*y+pl.normal[2]*z+pl.d);if(dist<=t){onP=true;break;}}if(!onP)out.push(idx);}return out;}
  function magicWand(seedIndex,pos,count,opts){opts=opts||{};count=count|0;if(!pos||count<1||seedIndex<0||seedIndex>=count)return [];var b=_p56bounds(pos,count);var dx=b.mx[0]-b.mn[0],dy=b.mx[1]-b.mn[1],dz=b.mx[2]-b.mn[2];var diag=Math.sqrt(dx*dx+dy*dy+dz*dz)||1;var voxel=opts.voxel!=null?opts.voxel:Math.max(diag*0.01,1e-4);if(voxel<=0)voxel=1e-4;var maxPts=opts.maxPts!=null?opts.maxPts:500000;var planes=opts.planes||null;var planeTol=opts.planeTol!=null?opts.planeTol:voxel*1.5;function gx(i){return Math.floor((pos[i*3]-b.mn[0])/voxel);}function gy(i){return Math.floor((pos[i*3+1]-b.mn[1])/voxel);}function gz(i){return Math.floor((pos[i*3+2]-b.mn[2])/voxel);}function key(x,y,z){return x+','+y+','+z;}var _useSub=count>1500000;var _sx=pos[seedIndex*3],_sy=pos[seedIndex*3+1],_sz=pos[seedIndex*3+2];var _R=_useSub?Math.max(voxel*250,diag*0.18):Infinity;var grid=new Map();for(var i=0;i<count;i++){if(_useSub){var _px=pos[i*3],_py=pos[i*3+1],_pz=pos[i*3+2];if(_px<_sx-_R||_px>_sx+_R||_py<_sy-_R||_py>_sy+_R||_pz<_sz-_R||_pz>_sz+_R)continue;}var k=key(gx(i),gy(i),gz(i));var a=grid.get(k);if(!a){a=[];grid.set(k,a);}a.push(i);}function isProt(i){if(!planes||!planes.length)return false;var x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2];for(var p=0;p<planes.length;p++){var pl=planes[p];var dist=Math.abs(pl.normal[0]*x+pl.normal[1]*y+pl.normal[2]*z+pl.d);if(dist<=planeTol)return true;}return false;}var visited=new Set();var out=[];var stack=[seedIndex];visited.add(seedIndex);while(stack.length){var cur=stack.pop();if(isProt(cur))continue;out.push(cur);if(out.length>=maxPts)break;var cxg=gx(cur),cyg=gy(cur),czg=gz(cur);for(var ox=-1;ox<=1;ox++)for(var oy=-1;oy<=1;oy++)for(var oz=-1;oz<=1;oz++){var nb=grid.get(key(cxg+ox,cyg+oy,czg+oz));if(!nb)continue;for(var j=0;j<nb.length;j++){var ni=nb[j];if(visited.has(ni))continue;visited.add(ni);if(isProt(ni))continue;stack.push(ni);}}}return out;}
  function selectByColor(col,count,seedRGB,opts){opts=opts||{};count=count|0;if(!col||count<1||!seedRGB)return [];var tol=opts.tol!=null?opts.tol:40;var maxc=0;var N=Math.min(col.length,count*3);for(var i=0;i<N;i++){var v=col[i];if(v>maxc)maxc=v;}var scale=maxc<=1.0001?255:1;var sr=seedRGB[0],sg=seedRGB[1],sb=seedRGB[2];var out=[];var t2=tol*tol;for(var i=0;i<count;i++){var r=col[i*3]*scale,g=col[i*3+1]*scale,b=col[i*3+2]*scale;var dr=r-sr,dg=g-sg,db=b-sb;if(dr*dr+dg*dg+db*db<=t2)out.push(i);}return out;}
  function selectBySphere(pos,count,center,radius){count=count|0;if(!pos||count<1||!center)return [];var r2=radius*radius;var cx=center[0],cy=center[1],cz=center[2];var out=[];for(var i=0;i<count;i++){var dx=pos[i*3]-cx,dy=pos[i*3+1]-cy,dz=pos[i*3+2]-cz;if(dx*dx+dy*dy+dz*dz<=r2)out.push(i);}return out;}
  function selectByBox(pos,count,mn,mx){count=count|0;if(!pos||count<1||!mn||!mx)return [];var out=[];for(var i=0;i<count;i++){var x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2];if(x>=mn[0]&&x<=mx[0]&&y>=mn[1]&&y<=mx[1]&&z>=mn[2]&&z<=mx[2])out.push(i);}return out;}
  function cleanStatisticalOutliers(cloud, opts) {
    opts = opts || {};
    const pos = cloud && cloud.pos;
    const count = pos ? Math.floor(pos.length / 3) : 0;
    if (!pos || pos.length % 3 || count < 3) return _noRemoval(cloud, { meanDist: 0, threshold: 0 });
    const k = Math.max(1, Math.floor(Number(opts.k != null ? opts.k : 16) || 16));
    const stdRatio = Math.max(0, Number(opts.stdRatio != null ? opts.stdRatio : 1.0));
    const b = _p56bounds(pos, count);
    const dx = b.mx[0] - b.mn[0], dy = b.mx[1] - b.mn[1], dz = b.mx[2] - b.mn[2];
    const diag = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    let voxel = opts.voxel != null ? Number(opts.voxel) : diag * 0.01;
    if (!(voxel > 0) || !Number.isFinite(voxel)) voxel = diag * 0.01 || 1e-3;
    const gx = new Int32Array(count), gy = new Int32Array(count), gz = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      gx[i] = Math.floor((pos[i * 3] - b.mn[0]) / voxel);
      gy[i] = Math.floor((pos[i * 3 + 1] - b.mn[1]) / voxel);
      gz[i] = Math.floor((pos[i * 3 + 2] - b.mn[2]) / voxel);
    }
    const map = new Map();
    const key = (x, y, z) => x + ',' + y + ',' + z;
    for (let i = 0; i < count; i++) {
      const kk = key(gx[i], gy[i], gz[i]);
      let bucket = map.get(kk);
      if (!bucket) { bucket = []; map.set(kk, bucket); }
      bucket.push(i);
    }
    const mean = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const xi = pos[i * 3], yi = pos[i * 3 + 1], zi = pos[i * 3 + 2];
      const dists = [];
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
        const bucket = map.get(key(gx[i] + ox, gy[i] + oy, gz[i] + oz));
        if (!bucket) continue;
        for (let j = 0; j < bucket.length; j++) {
          const ni = bucket[j]; if (ni === i) continue;
          const ddx = pos[ni * 3] - xi, ddy = pos[ni * 3 + 1] - yi, ddz = pos[ni * 3 + 2] - zi;
          dists.push(ddx * ddx + ddy * ddy + ddz * ddz);
        }
      }
      dists.sort((a, b2) => a - b2);
      const m = Math.min(k, dists.length);
      if (!m) { mean[i] = Infinity; continue; }
      let sum = 0;
      for (let j = 0; j < m; j++) sum += Math.sqrt(dists[j]);
      mean[i] = sum / m;
    }
    let sum = 0, finiteCount = 0;
    for (let i = 0; i < count; i++) if (Number.isFinite(mean[i])) { sum += mean[i]; finiteCount++; }
    const globalMean = finiteCount ? sum / finiteCount : 0;
    let variance = 0;
    for (let i = 0; i < count; i++) if (Number.isFinite(mean[i])) {
      const delta = mean[i] - globalMean; variance += delta * delta;
    }
    const std = finiteCount ? Math.sqrt(variance / finiteCount) : 0;
    const threshold = globalMean + stdRatio * std;
    const keep = new Uint8Array(count);
    let keepN = 0;
    for (let i = 0; i < count; i++) if (Number.isFinite(mean[i]) && mean[i] <= threshold) { keep[i] = 1; keepN++; }
    const result = _rebuildMask(cloud, keep, keepN, count);
    result.meanDist = globalMean;
    result.threshold = threshold;
    return result;
  }

  // ─────────── PATCH-58: авто-очистка за ОДИН проход + латание дыр на плоскостях ───────────
  function _p58concat(chunks, Ctor){ var t=0; for(var i=0;i<chunks.length;i++)t+=chunks[i].length; var out=new Ctor(t); var o=0; for(var i=0;i<chunks.length;i++){ out.set(chunks[i],o); o+=chunks[i].length; } return out; }

  // Максимальная авто-очистка за один вызов: несколько проходов (SOR + плотность + кластеры) до стабилизации.
  // Принцип как в CloudCompare/Open3D: statistical outlier removal + density + Label Connected Components.
  function cleanAuto(cloud, opts){
    opts = opts || {};
    var maxPasses = opts.maxPasses != null ? opts.maxPasses : 5;
    var minFrac = opts.minRemovedFrac != null ? opts.minRemovedFrac : 0.0008;
    var voxel = (opts.voxel && opts.voxel > 0) ? opts.voxel : 0;
    var initialCount = cloud && cloud.pos ? Math.floor(cloud.pos.length / 3) : 0;
    var attrSpecs = _pointAttributeSpecs(cloud, initialCount);
    var col0 = cloud.col || null;
    var cur = { pos: cloud.pos, col: cloud.col || null };
    for (var ai = 0; ai < attrSpecs.length; ai++) if (attrSpecs[ai].key !== 'col') cur[attrSpecs[ai].key] = attrSpecs[ai].values;
    var remP = [], remC = cloud.col ? [] : null; var colOK = true;
    var remAttrChunks = {}, attrOK = {};
    for (var ai = 0; ai < attrSpecs.length; ai++) {
      var spec = attrSpecs[ai];
      if (spec.key === 'col') continue;
      remAttrChunks[spec.key] = [];
      attrOK[spec.key] = true;
    }
    var brk = { sor: 0, density: 0, clusters: 0 };
    var passes = 0;
    function acc(rx, kind){
      if (!rx || !rx.removed) return;
      cur = { pos: rx.pos, col: rx.col };
      for (var ai = 0; ai < attrSpecs.length; ai++) {
        var spec = attrSpecs[ai];
        if (spec.key !== 'col' && rx[spec.key]) cur[spec.key] = rx[spec.key];
      }
      brk[kind] += rx.removed;
      if (rx.removedPos && rx.removedPos.length) {
        remP.push(rx.removedPos);
        if (remC) {
          if (rx.removedCol && rx.removedCol.length === rx.removedPos.length) remC.push(rx.removedCol);
          else colOK = false;
        }
        for (var ai = 0; ai < attrSpecs.length; ai++) {
          var spec = attrSpecs[ai];
          if (spec.key === 'col') continue;
          var removed = rx.removedAttributes && rx.removedAttributes[spec.key];
          if (!removed) removed = rx['removed' + spec.key.charAt(0).toUpperCase() + spec.key.slice(1)];
          if (removed && removed.length === rx.removed * spec.stride) remAttrChunks[spec.key].push(removed);
          else attrOK[spec.key] = false;
        }
      }
    }
    for (var p = 0; p < maxPasses; p++){
      var before = cur.pos.length / 3;
      if (before < 32) break;
      var b0 = before;
      // 1) SOR — статистические выбросы (дымка, «лучи», шум у поверхностей). Только на первых проходах: многократный SOR выедает края плоскостей.
      // SOR (k-NN) — самый дорогой шаг. На больших облаках он морозит UI-поток, поэтому пропускаем его выше порога (нативный Open3D-движок обрабатывает такие облака отдельно).
      if (p < 2 && before <= (opts.maxSorPoints != null ? opts.maxSorPoints : 1500000)) acc(cleanStatisticalOutliers(cur, { k: 16, stdRatio: (opts.stdRatio != null ? opts.stdRatio : 2.2), voxel: voxel || undefined }), 'sor');
      // 2) Плотностный фильтр — редкие «облака» шума в воздухе. minPts низкий, чтобы не разрушать тонкие поверхности (пол/стены).
      acc(cleanVoxelDensity(cur, { voxel: voxel || undefined, minPts: 3 + p }), 'density');
      // 3) Отсоединённые кластеры (Label Connected Components) — летающий мусор / отдельные пятна. Основной безопасный фильтр. Порог растёт с проходом.
      acc(cleanClusters(cur, { voxel: voxel || undefined, minClusterPts: Math.round(50 * Math.pow(1.6, p)), connect: 4 }), 'clusters');
      passes++;
      var removedThis = b0 - cur.pos.length / 3;
      if (removedThis <= b0 * minFrac) break; // стабилизировалось — чистить больше нечего
    }
    var removedPos = _p58concat(remP, Float32Array);
    var removedCol = (remC && colOK) ? _p58concat(remC, (col0 && col0.constructor) || Uint8Array) : null;
    var removedAttributes = {};
    for (var ai = 0; ai < attrSpecs.length; ai++) {
      var spec = attrSpecs[ai];
      if (spec.key === 'col') continue;
      var chunks = remAttrChunks[spec.key];
      var removed = attrOK[spec.key] ? _p58concat(chunks, spec.values.constructor) : null;
      if (removed) {
        removedAttributes[spec.key] = removed;
        cur['removed' + spec.key.charAt(0).toUpperCase() + spec.key.slice(1)] = removed;
      }
    }
    return Object.assign(cur, { removed: removedPos.length / 3, removedPos: removedPos, removedCol: removedCol,
      removedAttributes: removedAttributes, passes: passes, breakdown: brk });
  }

  // Латание дыр («теней») на защищённых плоскостях (пол/стены) после удаления объекта.
  // removedPos — удалённые точки (человек/мебель); их силуэт проецируется на каждую плоскость,
  // и пустые ячейки ВНУТРИ поверхности заполняются точками на плоскости (цвет — от соседей).
  function fillPlaneHoles(cloud, planes, removedPos, opts){
    opts = opts || {};
    var pos = cloud.pos, col = cloud.col || null;
    var n = pos ? pos.length / 3 : 0;
    var empty = { addedPos: new Float32Array(0), addedCol: col ? new col.constructor(0) : null, added: 0 };
    if (!planes || !planes.length || !removedPos || removedPos.length < 9 || n < 16) return empty;
    var rn = removedPos.length / 3;
    var bb = _p56bounds(pos, n);
    var dx=bb.mx[0]-bb.mn[0], dy=bb.mx[1]-bb.mn[1], dz=bb.mx[2]-bb.mn[2];
    var diag = Math.sqrt(dx*dx+dy*dy+dz*dz) || 1;
    var step = (opts.step && opts.step > 0) ? opts.step : Math.max(diag*0.003, 1e-3);
    var tol = (opts.tol != null) ? opts.tol : step*2.5;
    var maxAdd = (opts.maxAdd != null) ? opts.maxAdd : 300000;
    var dilations = (opts.dilations != null) ? opts.dilations : 12;
    var band = (opts.band != null) ? opts.band : diag*0.5;
    var maxPlanes = Math.min(planes.length, (opts.maxPlanes != null ? opts.maxPlanes : 4));
    var inv = 1/step;
    var rb = _p56bounds(removedPos, rn);
    var mrg = Math.max(step*20, diag*0.03);
    var lo0=rb.mn[0]-mrg, lo1=rb.mn[1]-mrg, lo2=rb.mn[2]-mrg, hi0=rb.mx[0]+mrg, hi1=rb.mx[1]+mrg, hi2=rb.mx[2]+mrg;
    var addPX = [], addCL = col ? [] : null; var added = 0;
    for (var pi=0; pi<maxPlanes && added<maxAdd; pi++){
      var pl = planes[pi]; var nx=pl.normal[0], ny=pl.normal[1], nz=pl.normal[2], d=pl.d;
      var nl = Math.sqrt(nx*nx+ny*ny+nz*nz)||1; nx/=nl; ny/=nl; nz/=nl; d/=nl;
      var axx=Math.abs(nx), ayy=Math.abs(ny), azz=Math.abs(nz);
      var rx,ry,rz; if (axx<=ayy && axx<=azz){rx=1;ry=0;rz=0;} else if (ayy<=azz){rx=0;ry=1;rz=0;} else {rx=0;ry=0;rz=1;}
      var ux=ny*rz-nz*ry, uy=nz*rx-nx*rz, uz=nx*ry-ny*rx;
      var ul=Math.sqrt(ux*ux+uy*uy+uz*uz)||1; ux/=ul; uy/=ul; uz/=ul;
      var vx=ny*uz-nz*uy, vy=nz*ux-nx*uz, vz=nx*uy-ny*ux;
      var occ = new Set(); var ccol = col ? new Map() : null;
      for (var i=0;i<n;i++){
        var x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2];
        if (x<lo0||x>hi0||y<lo1||y>hi1||z<lo2||z>hi2) continue;
        var sd = nx*x+ny*y+nz*z+d; if (sd<0) sd=-sd; if (sd>tol) continue;
        var ku=Math.round((x*ux+y*uy+z*uz)*inv), kv=Math.round((x*vx+y*vy+z*vz)*inv);
        var kk=ku+','+kv; occ.add(kk);
        if (ccol){ var e=ccol.get(kk); if(!e){e=[0,0,0,0]; ccol.set(kk,e);} e[0]+=col[i*3];e[1]+=col[i*3+1];e[2]+=col[i*3+2];e[3]++; }
      }
      if (occ.size < 4) continue;
      var holes = new Set();
      for (var r=0;r<rn;r++){
        var X=removedPos[r*3],Y=removedPos[r*3+1],Z=removedPos[r*3+2];
        var sd2 = nx*X+ny*Y+nz*Z+d; var ad2 = sd2<0?-sd2:sd2; if (ad2>band) continue;
        var pxp=X-sd2*nx, pyp=Y-sd2*ny, pzp=Z-sd2*nz;
        var ku2=Math.round((pxp*ux+pyp*uy+pzp*uz)*inv), kv2=Math.round((pxp*vx+pyp*vy+pzp*vz)*inv);
        var kk2=ku2+','+kv2; if (occ.has(kk2)) continue; holes.add(kk2);
      }
      if (!holes.size) continue;
      var filled = new Map();
      for (var it=0; it<dilations && added<maxAdd; it++){
        var wave = [];
        holes.forEach(function(kk){
          if (filled.has(kk)) return;
          var ci=kk.indexOf(','); var ku=+kk.slice(0,ci), kv=+kk.slice(ci+1);
          var occN=0, cr=0,cg=0,cb=0,cc=0;
          for (var ox=-1;ox<=1;ox++)for(var oy=-1;oy<=1;oy++){ if(ox===0&&oy===0)continue;
            var nk=(ku+ox)+','+(kv+oy);
            if (occ.has(nk)){ occN++; if (ccol){ var e2=ccol.get(nk); if(e2){cr+=e2[0]/e2[3];cg+=e2[1]/e2[3];cb+=e2[2]/e2[3];cc++;} } }
            else if (filled.has(nk)){ occN++; if (addCL){ var f=filled.get(nk); cr+=f[0];cg+=f[1];cb+=f[2];cc++; } }
          }
          if (occN>=2){ wave.push([kk,ku,kv, cc?cr/cc:0, cc?cg/cc:0, cc?cb/cc:0]); }
        });
        if (!wave.length) break;
        for (var w=0; w<wave.length && added<maxAdd; w++){
          var it2=wave[w]; var u=it2[1]*step, v=it2[2]*step;
          var qx=u*ux+v*vx-d*nx, qy=u*uy+v*vy-d*ny, qz=u*uz+v*vz-d*nz;
          addPX.push(qx,qy,qz); if (addCL) addCL.push(it2[3],it2[4],it2[5]);
          filled.set(it2[0],[it2[3],it2[4],it2[5]]); added++;
        }
      }
    }
    var addedPos = new Float32Array(addPX);
    var addedCol = addCL ? new (col.constructor)(addCL) : null;
    return { addedPos: addedPos, addedCol: addedCol, added: addedPos.length/3 };
  }

  // Legacy export: LAS 1.2 PDRF 2 (XYZ + intensity + 5-bit classification + RGB).
  // LAS 1.2 PDRF 2 cannot encode classes >31; refuse rather than silently corrupting them.
  function toLASBinary(cloud) {
    var pos = cloud && cloud.pos;
    if (!pos || pos.length % 3) throw new TypeError('LAS export requires complete XYZ triples');
    var col = (cloud && cloud.col) || null;
    var intensity = (cloud && cloud.intensity) || null;
    var classification = (cloud && cloud.classification) || null;
    var n = pos.length / 3;
    if (!Number.isSafeInteger(n) || n > 0xffffffff) throw new RangeError('LAS 1.2 point count exceeds the supported legacy limit');
    if (col && col.length !== n * 3) throw new RangeError('LAS export RGB array length does not match point count');
    if (intensity && intensity.length !== n) throw new RangeError('LAS export intensity array length does not match point count');
    if (classification && classification.length !== n) throw new RangeError('LAS export classification array length does not match point count');
    var minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    var maxIntensity = 0, maxColor = 0;
    for (var i = 0; i < n; i++) {
      var x = Number(pos[i * 3]), y = Number(pos[i * 3 + 1]), z = Number(pos[i * 3 + 2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new RangeError('LAS export coordinates must be finite');
      if (x < minx) minx = x; if (y < miny) miny = y; if (z < minz) minz = z;
      if (x > maxx) maxx = x; if (y > maxy) maxy = y; if (z > maxz) maxz = z;
      if (intensity) {
        var iv = Number(intensity[i]);
        if (!Number.isFinite(iv) || iv < 0) throw new RangeError('LAS intensity must be finite and non-negative');
        if (iv > maxIntensity) maxIntensity = iv;
      }
      if (classification) {
        var cls = Number(classification[i]);
        if (!Number.isInteger(cls) || cls < 0 || cls > 31) throw new RangeError('LAS 1.2 PDRF 2 supports classification codes 0–31; use LAS 1.4 export for extended classes');
      }
      if (col) for (var c = 0; c < 3; c++) {
        var cv = Number(col[i * 3 + c]);
        if (!Number.isFinite(cv)) throw new RangeError('LAS RGB values must be finite');
        if (cv > maxColor) maxColor = cv;
      }
    }
    if (!isFinite(minx)) { minx = miny = minz = 0; maxx = maxy = maxz = 0; }
    var sx = Math.max(0.001, (maxx - minx) / 2147483000);
    var sy = Math.max(0.001, (maxy - miny) / 2147483000);
    var sz = Math.max(0.001, (maxz - minz) / 2147483000);
    var ox = minx, oy = miny, oz = minz;
    var HEADER = 227, REC = 26;
    var buf = new ArrayBuffer(HEADER + n * REC); var dv = new DataView(buf); var u8 = new Uint8Array(buf);
    u8[0] = 0x4C; u8[1] = 0x41; u8[2] = 0x53; u8[3] = 0x46; // 'LASF'
    dv.setUint8(24, 1); dv.setUint8(25, 2); // версия 1.2
    var sysId = 'BIM Twin'; for (var i = 0; i < sysId.length && i < 32; i++) u8[26 + i] = sysId.charCodeAt(i);
    var sw = 'BIM Twin'; for (var i = 0; i < sw.length && i < 32; i++) u8[58 + i] = sw.charCodeAt(i);
    dv.setUint16(94, HEADER, true); dv.setUint32(96, HEADER, true); dv.setUint32(100, 0, true);
    dv.setUint8(104, 2); dv.setUint16(105, REC, true);
    dv.setUint32(107, n, true); dv.setUint32(111, n, true);
    dv.setFloat64(131, sx, true); dv.setFloat64(139, sy, true); dv.setFloat64(147, sz, true);
    dv.setFloat64(155, ox, true); dv.setFloat64(163, oy, true); dv.setFloat64(171, oz, true);
    dv.setFloat64(179, maxx, true); dv.setFloat64(187, minx, true);
    dv.setFloat64(195, maxy, true); dv.setFloat64(203, miny, true);
    dv.setFloat64(211, maxz, true); dv.setFloat64(219, minz, true);
    var scale255 = !!(col && maxColor > 1.0001);
    var intensityScale = intensity && maxIntensity <= 1.0001 ? 65535 : 1;
    var o = HEADER;
    for (var i = 0; i < n; i++) {
      dv.setInt32(o, Math.round((pos[i * 3] - ox) / sx), true);
      dv.setInt32(o + 4, Math.round((pos[i * 3 + 1] - oy) / sy), true);
      dv.setInt32(o + 8, Math.round((pos[i * 3 + 2] - oz) / sz), true);
      var intensityValue = intensity ? Math.round(Number(intensity[i]) * intensityScale) : 0;
      dv.setUint16(o + 12, Math.max(0, Math.min(65535, intensityValue)), true);
      u8[o + 14] = 0x09;
      u8[o + 15] = classification ? Number(classification[i]) : 0;
      u8[o + 16] = 0; u8[o + 17] = 0; dv.setUint16(o + 18, 0, true);
      var r = 200, g = 200, b = 200;
      if (col) {
        if (scale255) { r = Math.round(col[i * 3]); g = Math.round(col[i * 3 + 1]); b = Math.round(col[i * 3 + 2]); }
        else { r = Math.round(col[i * 3] * 255); g = Math.round(col[i * 3 + 1] * 255); b = Math.round(col[i * 3 + 2] * 255); }
        r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
      }
      dv.setUint16(o + 20, (r * 257) & 0xffff, true); dv.setUint16(o + 22, (g * 257) & 0xffff, true); dv.setUint16(o + 24, (b * 257) & 0xffff, true);
      o += REC;
    }
    return u8;
  }
  // Экспорт в текстовый XYZ (x y z [r g b]). Возвращает строку.
  function toXYZText(cloud) {
    var pos = cloud && cloud.pos; var col = (cloud && cloud.col) || null; var n = pos ? (pos.length / 3) | 0 : 0;
    var scale255 = false; if (col && col.length) { var mx = 0, lim = Math.min(col.length, 300); for (var i = 0; i < lim; i++) if (col[i] > mx) mx = col[i]; if (mx > 1.0001) scale255 = true; }
    var parts = [], CH = [];
    for (var i = 0; i < n; i++) {
      var x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (col && col.length) { var r, g, b; if (scale255) { r = col[i * 3] | 0; g = col[i * 3 + 1] | 0; b = col[i * 3 + 2] | 0; } else { r = Math.round(col[i * 3] * 255); g = Math.round(col[i * 3 + 1] * 255); b = Math.round(col[i * 3 + 2] * 255); } CH.push(x + ' ' + y + ' ' + z + ' ' + r + ' ' + g + ' ' + b); }
      else CH.push(x + ' ' + y + ' ' + z);
      if (CH.length >= 100000) { parts.push(CH.join('\n')); CH.length = 0; }
    }
    if (CH.length) parts.push(CH.join('\n'));
    return parts.join('\n');
  }
  // v1045: Локальная защита пола/стен при ручном удалении. Вместо одной глобальной
  // плоскости на всё здание (ненадёжно на 100-метровых сканах) детектим плоскости
  // ЛОКАЛЬНО вокруг выделения — как ground-plane RANSAC в CloudCompare/Open3D segment_plane.
  // Возвращает список индексов, которые реально надо удалить (точки пола/стен исключены).
  // v1056: геометрический фильтр «поверхность vs мусор». Настоящая поверхность
  // (пол/стена) перекрывает большую площадь локальной области; куча мусора или предмет на
  // полу — компактный сгусток. Отличаем их по боковому размеру инлайеров плоскости.
  function _p59structuralPlanes(lp, n, planes, tol, minExtent, bigExtent){
    if (!planes || !planes.length) return planes;
    var out = [];
    for (var p = 0; p < planes.length; p++){
      var pl = planes[p]; var nx = pl.normal[0], ny = pl.normal[1], nz = pl.normal[2], d = pl.d;
      var axx = Math.abs(nx), ayy = Math.abs(ny), azz = Math.abs(nz);
      var rx, ry, rz; if (axx <= ayy && axx <= azz){ rx=1; ry=0; rz=0; } else if (ayy <= azz){ rx=0; ry=1; rz=0; } else { rx=0; ry=0; rz=1; }
      var ux = ny*rz - nz*ry, uy = nz*rx - nx*rz, uz = nx*ry - ny*rx;
      var ul = Math.sqrt(ux*ux + uy*uy + uz*uz) || 1; ux/=ul; uy/=ul; uz/=ul;
      var vx = ny*uz - nz*uy, vy = nz*ux - nx*uz, vz = nx*uy - ny*ux;
      var cnt = 0, minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (var i = 0; i < n; i++){
        var x = lp[i*3], y = lp[i*3+1], z = lp[i*3+2];
        var dist = x*nx + y*ny + z*nz + d; if (dist < 0) dist = -dist; if (dist > tol) continue;
        var pu = x*ux + y*uy + z*uz, pv = x*vx + y*vy + z*vz;
        if (pu < minU) minU = pu; if (pu > maxU) maxU = pu; if (pv < minV) minV = pv; if (pv > maxV) maxV = pv; cnt++;
      }
      if (cnt < 40) continue;
      var du = maxU - minU, dv = maxV - minV; var latDiag = Math.sqrt(du*du + dv*dv);
      if (latDiag >= minExtent || latDiag >= bigExtent) out.push(pl);
    }
    return out;
  }

  function protectFloorLocal(cloud, indices, opts){
    opts = opts || {};
    var pos = cloud && cloud.pos;
    var arr = Array.isArray(indices) ? indices.slice() : Array.from(indices || []);
    if (!pos || arr.length === 0) return arr;
    var count = pos.length / 3;
    var mnx=Infinity,mny=Infinity,mnz=Infinity,mxx=-Infinity,mxy=-Infinity,mxz=-Infinity;
    for (var i=0;i<arr.length;i++){ var idx=arr[i]; var x=pos[idx*3],y=pos[idx*3+1],z=pos[idx*3+2]; if(x<mnx)mnx=x; if(y<mny)mny=y; if(z<mnz)mnz=z; if(x>mxx)mxx=x; if(y>mxy)mxy=y; if(z>mxz)mxz=z; }
    var sx=mxx-mnx, sy=mxy-mny, sz=mxz-mnz;
    var seldiag=Math.sqrt(sx*sx+sy*sy+sz*sz)||1;
    var sp = opts.spacing || 0;
    var margin = opts.margin != null ? opts.margin : Math.max(seldiag*0.5, sp*20, 0.4);
    var lmnx=mnx-margin,lmny=mny-margin,lmnz=mnz-margin,lmxx=mxx+margin,lmxy=mxy+margin,lmxz=mxz+margin;
    var localIdx=[];
    for (var i=0;i<count;i++){ var x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2]; if(x>=lmnx&&x<=lmxx&&y>=lmny&&y<=lmxy&&z>=lmnz&&z<=lmxz) localIdx.push(i); }
    if (localIdx.length < 64) return arr;
    var cap = opts.sampleCap != null ? opts.sampleCap : 60000;
    var useIdx = localIdx;
    if (localIdx.length > cap){ var step=localIdx.length/cap; useIdx=new Array(cap); for(var i=0;i<cap;i++) useIdx[i]=localIdx[(i*step)|0]; }
    var lp=new Float32Array(useIdx.length*3);
    for (var i=0;i<useIdx.length;i++){ var idx=useIdx[i]; lp[i*3]=pos[idx*3]; lp[i*3+1]=pos[idx*3+1]; lp[i*3+2]=pos[idx*3+2]; }
    var ldx=lmxx-lmnx,ldy=lmxy-lmny,ldz=lmxz-lmnz; var ldiag=Math.sqrt(ldx*ldx+ldy*ldy+ldz*ldz)||1;
    var tol = opts.tol != null ? opts.tol : Math.max(sp*3, 0.02);
    // minFrac высокий, чтобы защищать только КРУПНЫЕ поверхности (пол/стены), а не сам объект.
    var planes = detectPlanes(lp, useIdx.length, { maxPlanes: opts.maxPlanes!=null?opts.maxPlanes:3, minFrac: opts.minFrac!=null?opts.minFrac:0.10, tol: tol, iters: opts.iters!=null?opts.iters:150 });
    if (!planes.length) return arr;
    // v1053: откат ориентационного деления v1052. Лейбл «пол/стена» по |nz|>0.7 ошибался на
    // облаках с вертикалью по Y (пол считался стеной и наоборот) — поэтому то стены, то пол
    // получали не ту полосу и срезались. Теперь защищаем ВСЕ крупные локальные плоскости
    // единой полосой (независимо от осей): подгонка точная (tol), полоса защиты чуть шире (protTol);
    // больше стен/пола/потолка ловим за счёт меньшего minFrac и большего maxPlanes.
    // v1056: умная защита — отбрасываем «плоскости», которые на самом деле мусор/предмет
    // (малый боковой размер), а не крупная поверхность. Так пол/стены защищены, а насыпь
    // и предметы на полу можно удалять. Отключается тумблером «умная защита» (opts.smart=false).
    if (opts.smart !== false) {
      var structMinExtent = Math.max(ldiag * 0.35, sp * 15, 0.4);
      planes = _p59structuralPlanes(lp, useIdx.length, planes, tol, structMinExtent, 2.5);
      if (!planes.length) return arr;
    }
    var protTol = opts.protTol != null ? opts.protTol : Math.max(tol, sp*4, 0.05);
    return protectPlanes(arr, pos, planes, protTol);
  }

  // v1045: «Убрать мелкие островки» — Label Connected Components с адаптивным порогом
  // (аналог Tools > Segmentation > Label Connected Components в CloudCompare: помечает
  // связные компоненты и удаляет все, что меньше порога, кроме главной структуры).
  function cleanIslands(cloud, opts){
    opts = opts || {};
    var pos = cloud && cloud.pos; var count = pos ? pos.length/3 : 0;
    if (!pos || count < 32) return _noRemoval(cloud, { clusters: 0 });
    var minPts = opts.minClusterPts != null ? opts.minClusterPts : Math.max(200, Math.round(count*0.0004));
    return cleanClusters(cloud, { voxel: opts.voxel, minClusterPts: minPts, keepRatio: opts.keepRatio != null ? opts.keepRatio : 0 });
  }

  // =========================================================================
  // v1046 — Phase 1-3: расширенный конвейер обработки (по образцу CloudCompare/Open3D).
  // Чистые алгоритмы без DOM/GPU — покрыты unit-тестами (test/pcedit-phase123.test.js).
  // =========================================================================

  // Собственные значения/векторы симметричной матрицы NxN методом Якоби (N=3 или 4).
  function _jacobiEig(A, n){
    var a=[], v=[], i, j;
    for (i=0;i<n;i++){ a[i]=A[i].slice(); v[i]=[]; for(j=0;j<n;j++) v[i][j]=(i===j)?1:0; }
    for (var sweep=0; sweep<100; sweep++){
      var off=0; for(i=0;i<n;i++) for(j=i+1;j<n;j++) off+=Math.abs(a[i][j]);
      if (off < 1e-14) break;
      for (var p=0;p<n;p++) for (var q=p+1;q<n;q++){
        if (Math.abs(a[p][q]) < 1e-18) continue;
        var theta=(a[q][q]-a[p][p])/(2*a[p][q]);
        var sgn = theta>=0?1:-1;
        var t = sgn/(Math.abs(theta)+Math.sqrt(theta*theta+1));
        var c = 1/Math.sqrt(t*t+1), s=t*c;
        for (i=0;i<n;i++){ var aip=a[i][p], aiq=a[i][q]; a[i][p]=c*aip-s*aiq; a[i][q]=s*aip+c*aiq; }
        for (i=0;i<n;i++){ var api=a[p][i], aqi=a[q][i]; a[p][i]=c*api-s*aqi; a[q][i]=s*api+c*aqi; }
        for (i=0;i<n;i++){ var vip=v[i][p], viq=v[i][q]; v[i][p]=c*vip-s*viq; v[i][q]=s*vip+c*viq; }
      }
    }
    var vals=[]; for(i=0;i<n;i++) vals[i]=a[i][i];
    return { values: vals, vectors: v };
  }

  // Нормаль (наименьший собственный вектор) ковариации 3x3 (верхний треугольник).
  function _smallestEV3(xx,xy,xz,yy,yz,zz){
    var e=_jacobiEig([[xx,xy,xz],[xy,yy,yz],[xz,yz,zz]],3);
    var mi=0; for(var k=1;k<3;k++) if(e.values[k]<e.values[mi]) mi=k;
    var nx=e.vectors[0][mi], ny=e.vectors[1][mi], nz=e.vectors[2][mi];
    var l=Math.sqrt(nx*nx+ny*ny+nz*nz)||1; return [nx/l,ny/l,nz/l];
  }

  function _mat3mul(A,B){return [
    A[0]*B[0]+A[1]*B[3]+A[2]*B[6], A[0]*B[1]+A[1]*B[4]+A[2]*B[7], A[0]*B[2]+A[1]*B[5]+A[2]*B[8],
    A[3]*B[0]+A[4]*B[3]+A[5]*B[6], A[3]*B[1]+A[4]*B[4]+A[5]*B[7], A[3]*B[2]+A[4]*B[5]+A[5]*B[8],
    A[6]*B[0]+A[7]*B[3]+A[8]*B[6], A[6]*B[1]+A[7]*B[4]+A[8]*B[7], A[6]*B[2]+A[7]*B[5]+A[8]*B[8]
  ];}

  // --- Phase 1: radius outlier removal (аналог Open3D remove_radius_outlier). ---
  function cleanRadiusOutliers(cloud, opts){
    opts=opts||{};
    var pos=cloud&&cloud.pos; var col=(cloud&&cloud.col)||null; var count=pos?pos.length/3:0;
    var empty=_noRemoval(cloud,{radius:0,minNeighbors:0});
    if(!pos||count<3)return empty;
    var b=_p56bounds(pos,count);var dx=b.mx[0]-b.mn[0],dy=b.mx[1]-b.mn[1],dz=b.mx[2]-b.mn[2];var diag=Math.sqrt(dx*dx+dy*dy+dz*dz)||1;
    var radius=opts.radius!=null?opts.radius:diag*0.01; if(!(radius>0))radius=diag*0.01||1e-3;
    var minN=opts.minNeighbors!=null?opts.minNeighbors:8; var inv=1/radius; var r2=radius*radius;
    var gx=new Int32Array(count),gy=new Int32Array(count),gz=new Int32Array(count);var map=new Map();
    function key(x,y,z){return x+','+y+','+z;}
    for(var i=0;i<count;i++){gx[i]=Math.floor((pos[i*3]-b.mn[0])*inv);gy[i]=Math.floor((pos[i*3+1]-b.mn[1])*inv);gz[i]=Math.floor((pos[i*3+2]-b.mn[2])*inv);var kk=key(gx[i],gy[i],gz[i]);var a=map.get(kk);if(!a){a=[];map.set(kk,a);}a.push(i);}
    var keep=new Uint8Array(count),keepN=0;
    for(var i=0;i<count;i++){var xi=pos[i*3],yi=pos[i*3+1],zi=pos[i*3+2];var cnt=0;
      for(var ox=-1;ox<=1&&cnt<minN;ox++)for(var oy=-1;oy<=1&&cnt<minN;oy++)for(var oz=-1;oz<=1&&cnt<minN;oz++){var a=map.get(key(gx[i]+ox,gy[i]+oy,gz[i]+oz));if(!a)continue;for(var j=0;j<a.length;j++){var ni=a[j];if(ni===i)continue;var ex=pos[ni*3]-xi,ey=pos[ni*3+1]-yi,ez=pos[ni*3+2]-zi;if(ex*ex+ey*ey+ez*ez<=r2){cnt++;if(cnt>=minN)break;}}}
      if(cnt>=minN){keep[i]=1;keepN++;}}
    var r=_rebuildMask(cloud,keep,keepN,count);r.radius=radius;r.minNeighbors=minN;return r;
  }

  // --- Phase 1: noise filter по локальной плоскости (аналог CloudCompare Noise filter). ---
  function noiseFilterLocalPlane(cloud, opts){
    opts=opts||{};
    var pos=cloud&&cloud.pos; var col=(cloud&&cloud.col)||null; var count=pos?pos.length/3:0;
    var empty=_noRemoval(cloud,{threshold:0});
    if(!pos||count<8)return empty;
    var k=opts.k!=null?opts.k:16; var stdRatio=opts.stdRatio!=null?opts.stdRatio:1.0;
    var b=_p56bounds(pos,count);var dx=b.mx[0]-b.mn[0],dy=b.mx[1]-b.mn[1],dz=b.mx[2]-b.mn[2];var diag=Math.sqrt(dx*dx+dy*dy+dz*dz)||1;
    var voxel=opts.voxel!=null?opts.voxel:diag*0.01; if(voxel<=0)voxel=diag*0.01||1e-3; var inv=1/voxel;
    var gx=new Int32Array(count),gy=new Int32Array(count),gz=new Int32Array(count);var map=new Map();
    function key(x,y,z){return x+','+y+','+z;}
    for(var i=0;i<count;i++){gx[i]=Math.floor((pos[i*3]-b.mn[0])*inv);gy[i]=Math.floor((pos[i*3+1]-b.mn[1])*inv);gz[i]=Math.floor((pos[i*3+2]-b.mn[2])*inv);var kk=key(gx[i],gy[i],gz[i]);var a=map.get(kk);if(!a){a=[];map.set(kk,a);}a.push(i);}
    // v1047: без сортировки и без аллокаций на точку (раньше nb.push([...]) + sort давали
    // GC-затор и «бесконечную загрузку» на 14+ млн точек). Соседей берём из 3x3x3 вокселей
    // в переиспользуемый буфер nbi (жёсткий предел CAP), плоскость строим PCA по ним.
    var dist=new Float64Array(count);
    var CAP=Math.max(24,Math.min(96,((k|0)*4)||64));
    var nbi=new Int32Array(CAP);
    for(var i=0;i<count;i++){var xi=pos[i*3],yi=pos[i*3+1],zi=pos[i*3+2];var m=0;
      for(var ox=-1;ox<=1&&m<CAP;ox++)for(var oy=-1;oy<=1&&m<CAP;oy++)for(var oz=-1;oz<=1&&m<CAP;oz++){var a=map.get(key(gx[i]+ox,gy[i]+oy,gz[i]+oz));if(!a)continue;for(var j=0;j<a.length&&m<CAP;j++){nbi[m++]=a[j];}}
      if(m<4){dist[i]=0;continue;}
      var cx=0,cy=0,cz=0;for(var j=0;j<m;j++){var ni=nbi[j];cx+=pos[ni*3];cy+=pos[ni*3+1];cz+=pos[ni*3+2];}cx/=m;cy/=m;cz/=m;
      var xx=0,xy=0,xz=0,yy=0,yz=0,zz=0;for(var j=0;j<m;j++){var ni=nbi[j];var a2=pos[ni*3]-cx,b2=pos[ni*3+1]-cy,c2=pos[ni*3+2]-cz;xx+=a2*a2;xy+=a2*b2;xz+=a2*c2;yy+=b2*b2;yz+=b2*c2;zz+=c2*c2;}
      var nrm=_smallestEV3(xx,xy,xz,yy,yz,zz);
      dist[i]=Math.abs(nrm[0]*(xi-cx)+nrm[1]*(yi-cy)+nrm[2]*(zi-cz));
    }
    var sum=0;for(var i=0;i<count;i++)sum+=dist[i];var mean=sum/count;
    var vs=0;for(var i=0;i<count;i++){var dd=dist[i]-mean;vs+=dd*dd;}var std=Math.sqrt(vs/count);
    var thr=opts.absTol!=null?opts.absTol:(mean+stdRatio*std);
    var keep=new Uint8Array(count),keepN=0;
    for(var i=0;i<count;i++){if(dist[i]<=thr){keep[i]=1;keepN++;}}
    var r=_rebuildMask(cloud,keep,keepN,count);r.threshold=thr;return r;
  }

  // --- Phase 2: реальное воксельное прореживание (один центроид на воксель). ---
  function voxelDownsample(cloud, opts){
    opts=opts||{};
    var pos=cloud&&cloud.pos, count=pos?Math.floor(pos.length/3):0;
    if(!pos||pos.length%3||count<1)return Object.assign(_noRemoval(cloud,{voxel:0}),{kept:count,removed:0});
    var b=_p56bounds(pos,count),dx=b.mx[0]-b.mn[0],dy=b.mx[1]-b.mn[1],dz=b.mx[2]-b.mn[2];
    var diag=Math.sqrt(dx*dx+dy*dy+dz*dz)||1;
    var voxel=opts.voxel!=null?Number(opts.voxel):diag*0.01;
    if(!(voxel>0)||!Number.isFinite(voxel))voxel=diag*0.01||1e-3;
    var inv=1/voxel, map=new Map();
    var specs=_pointAttributeSpecs(cloud,count);
    var color=specs.find(function(s){return s.key==='col';})||null;
    var intensity=specs.find(function(s){return s.key==='intensity'&&s.stride===1;})||null;
    var classification=specs.find(function(s){return s.key==='classification'&&s.stride===1;})||null;
    for(var i=0;i<count;i++){
      var kx=Math.floor((pos[i*3]-b.mn[0])*inv),ky=Math.floor((pos[i*3+1]-b.mn[1])*inv),kz=Math.floor((pos[i*3+2]-b.mn[2])*inv);
      var kk=kx+','+ky+','+kz, e=map.get(kk);
      if(!e){
        e={x:0,y:0,z:0,r:0,g:0,b:0,n:0,firstIndex:i,intensitySum:0,classValue:0,classCount:0,classVotes:null};
        map.set(kk,e);
      }
      e.x+=pos[i*3];e.y+=pos[i*3+1];e.z+=pos[i*3+2];
      if(color){e.r+=color.values[i*3];e.g+=color.values[i*3+1];e.b+=color.values[i*3+2];}
      if(intensity){var iv=Number(intensity.values[i]);e.intensitySum+=Number.isFinite(iv)?iv:0;}
      if(classification){
        var cv=Number(classification.values[i]);
        if(Number.isFinite(cv)){
          cv=Math.round(cv);
          if(!e.classCount){e.classValue=cv;e.classCount=1;}
          else if(e.classVotes){e.classVotes.set(cv,(e.classVotes.get(cv)||0)+1);}
          else if(cv===e.classValue)e.classCount++;
          else{e.classVotes=new Map([[e.classValue,e.classCount],[cv,1]]);e.classCount=0;}
        }
      }
      e.n++;
    }
    var kept=map.size,outPos=new Float32Array(kept*3),outCol=color?new color.values.constructor(kept*3):null;
    var outAttrs={};
    specs.forEach(function(spec){if(spec.key!=='col')outAttrs[spec.key]=new spec.values.constructor(kept*spec.stride);});
    var j=0;
    map.forEach(function(e){
      outPos[j*3]=e.x/e.n;outPos[j*3+1]=e.y/e.n;outPos[j*3+2]=e.z/e.n;
      if(outCol){outCol[j*3]=e.r/e.n;outCol[j*3+1]=e.g/e.n;outCol[j*3+2]=e.b/e.n;}
      for(var a=0;a<specs.length;a++){
        var spec=specs[a],key=spec.key;
        if(key==='col')continue;
        var dst=outAttrs[key],stride=spec.stride,base=j*stride,source=spec.values;
        if(key==='intensity'&&stride===1){dst[j]=e.intensitySum/e.n;continue;}
        if(key==='classification'&&stride===1){
          var best=e.classValue,bestCount=e.classVotes?0:e.classCount;
          if(e.classVotes)e.classVotes.forEach(function(voteCount,label){if(voteCount>bestCount||(voteCount===bestCount&&label<best)){best=label;bestCount=voteCount;}});
          dst[j]=best;continue;
        }
        var first=e.firstIndex*stride;
        for(var c=0;c<stride;c++)dst[base+c]=source[first+c];
      }
      j++;
    });
    var result={pos:outPos,col:outCol,kept:kept,removed:count-kept,voxel:voxel};
    Object.keys(outAttrs).forEach(function(key){result[key]=outAttrs[key];});
    return result;
  }

  // --- Phase 2: оценка нормалей (PCA по kNN, ориентация к viewpoint). ---
  function estimateNormals(cloud, opts){
    opts=opts||{};var pos=cloud&&cloud.pos;var count=pos?pos.length/3:0;var normals=new Float32Array(count*3);
    if(!pos||count<3)return normals;
    var k=opts.k!=null?opts.k:16;
    var b=_p56bounds(pos,count);var dx=b.mx[0]-b.mn[0],dy=b.mx[1]-b.mn[1],dz=b.mx[2]-b.mn[2];var diag=Math.sqrt(dx*dx+dy*dy+dz*dz)||1;
    var voxel=opts.voxel!=null?opts.voxel:diag*0.02;if(voxel<=0)voxel=diag*0.02||1e-3;var inv=1/voxel;
    var gx=new Int32Array(count),gy=new Int32Array(count),gz=new Int32Array(count);var map=new Map();
    for(var i=0;i<count;i++){gx[i]=Math.floor((pos[i*3]-b.mn[0])*inv);gy[i]=Math.floor((pos[i*3+1]-b.mn[1])*inv);gz[i]=Math.floor((pos[i*3+2]-b.mn[2])*inv);var kk=gx[i]+','+gy[i]+','+gz[i];var a=map.get(kk);if(!a){a=[];map.set(kk,a);}a.push(i);}
    var vp=opts.viewpoint||[b.mn[0]-diag,b.mn[1]-diag,b.mx[2]+diag];
    for(var i=0;i<count;i++){var xi=pos[i*3],yi=pos[i*3+1],zi=pos[i*3+2];var nb=[];
      for(var ox=-1;ox<=1;ox++)for(var oy=-1;oy<=1;oy++)for(var oz=-1;oz<=1;oz++){var a=map.get((gx[i]+ox)+','+(gy[i]+oy)+','+(gz[i]+oz));if(!a)continue;for(var jj=0;jj<a.length;jj++){var ni=a[jj];var ex=pos[ni*3]-xi,ey=pos[ni*3+1]-yi,ez=pos[ni*3+2]-zi;nb.push([ex*ex+ey*ey+ez*ez,ni]);}}
      if(nb.length<3){normals[i*3]=0;normals[i*3+1]=0;normals[i*3+2]=1;continue;}
      nb.sort(function(p,q){return p[0]-q[0];});var m=Math.min(Math.max(3,k),nb.length);
      var cx=0,cy=0,cz=0;for(var j=0;j<m;j++){var ni=nb[j][1];cx+=pos[ni*3];cy+=pos[ni*3+1];cz+=pos[ni*3+2];}cx/=m;cy/=m;cz/=m;
      var xx=0,xy=0,xz=0,yy=0,yz=0,zz=0;for(var j=0;j<m;j++){var ni=nb[j][1];var a2=pos[ni*3]-cx,b3=pos[ni*3+1]-cy,c3=pos[ni*3+2]-cz;xx+=a2*a2;xy+=a2*b3;xz+=a2*c3;yy+=b3*b3;yz+=b3*c3;zz+=c3*c3;}
      var nrm=_smallestEV3(xx,xy,xz,yy,yz,zz);
      var wx=vp[0]-xi,wy=vp[1]-yi,wz=vp[2]-zi;if(nrm[0]*wx+nrm[1]*wy+nrm[2]*wz<0){nrm[0]=-nrm[0];nrm[1]=-nrm[1];nrm[2]=-nrm[2];}
      normals[i*3]=nrm[0];normals[i*3+1]=nrm[1];normals[i*3+2]=nrm[2];
    }
    return normals;
  }

  // --- Phase 3: классификация конструктива (пол/стены/потолок) через RANSAC-плоскости. ---
  // labels: 0=прочее, 1=пол, 2=потолок, 3=стена.
  function classifyStructure(cloud, opts){
    opts=opts||{};var pos=cloud&&cloud.pos;var count=pos?pos.length/3:0;
    if(!pos||count<16)return { labels:new Uint8Array(count), planes:[], counts:{floor:0,ceiling:0,wall:0,other:count|0} };
    var b=_p56bounds(pos,count);var dx=b.mx[0]-b.mn[0],dy=b.mx[1]-b.mn[1],dz=b.mx[2]-b.mn[2];var diag=Math.sqrt(dx*dx+dy*dy+dz*dz)||1;
    var tol=opts.tol!=null?opts.tol:Math.max(diag*0.01,1e-3);
    var up=opts.upAxis!=null?opts.upAxis:2;
    var planes=detectPlanes(pos,count,{maxPlanes:opts.maxPlanes!=null?opts.maxPlanes:6,minFrac:opts.minFrac!=null?opts.minFrac:0.03,tol:tol,iters:opts.iters!=null?opts.iters:150});
    var cc=[(b.mn[0]+b.mx[0])/2,(b.mn[1]+b.mx[1])/2,(b.mn[2]+b.mx[2])/2];var zmid=cc[up];
    for(var p=0;p<planes.length;p++){var nrm=planes[p].normal;var nu=Math.abs(nrm[up]);
      if(nu>0.8){var acc=nrm[0]*cc[0]+nrm[1]*cc[1]+nrm[2]*cc[2];acc-=nrm[up]*cc[up];var h=(nrm[up]!==0)?(-(planes[p].d+acc)/nrm[up]):zmid;planes[p].cls=(h<=zmid)?1:2;planes[p].height=h;}
      else{planes[p].cls=3;}
    }
    var labels=new Uint8Array(count);var counts={floor:0,ceiling:0,wall:0,other:0};
    for(var i=0;i<count;i++){var x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2];var lab=0;
      for(var p=0;p<planes.length;p++){var pl=planes[p];var d=Math.abs(pl.normal[0]*x+pl.normal[1]*y+pl.normal[2]*z+pl.d);if(d<=tol){lab=pl.cls;break;}}
      labels[i]=lab;if(lab===1)counts.floor++;else if(lab===2)counts.ceiling++;else if(lab===3)counts.wall++;else counts.other++;
    }
    return { labels:labels, planes:planes, counts:counts };
  }

  // --- Phase 2: crop box / сечения / измерения. ---
  function cropBox(cloud, mn, mx, opts){
    opts=opts||{};var pos=cloud&&cloud.pos;var col=(cloud&&cloud.col)||null;var count=pos?pos.length/3:0;
    if(!pos||count<1)return _noRemoval(cloud);
    var invert=!!opts.invert;var keep=new Uint8Array(count),keepN=0;
    for(var i=0;i<count;i++){var x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2];var inside=(x>=mn[0]&&x<=mx[0]&&y>=mn[1]&&y<=mx[1]&&z>=mn[2]&&z<=mx[2]);var kp=invert?!inside:inside;if(kp){keep[i]=1;keepN++;}}
    return _rebuildMask(cloud,keep,keepN,count);
  }
  function sliceSection(cloud, opts){
    opts=opts||{};var pos=cloud&&cloud.pos;var col=(cloud&&cloud.col)||null;var count=pos?pos.length/3:0;
    var axis=opts.axis!=null?opts.axis:2;var thickness=opts.thickness!=null?opts.thickness:0.1;var at=opts.at;
    if(!pos||count<1)return _noRemoval(cloud);
    if(at==null){var b=_p56bounds(pos,count);at=(b.mn[axis]+b.mx[axis])/2;}
    var lo=at-thickness/2,hi=at+thickness/2;var keep=new Uint8Array(count),keepN=0;
    for(var i=0;i<count;i++){var v=pos[i*3+axis];if(v>=lo&&v<=hi){keep[i]=1;keepN++;}}
    return _rebuildMask(cloud,keep,keepN,count);
  }
  function measureDistance(a,b){var dx=a[0]-b[0],dy=a[1]-b[1],dz=a[2]-b[2];return Math.sqrt(dx*dx+dy*dy+dz*dz);}
  function pointToPlaneDistance(pt,plane){return Math.abs(plane.normal[0]*pt[0]+plane.normal[1]*pt[1]+plane.normal[2]*pt[2]+plane.d);}

  // --- Phase 3: ICP-регистрация (point-to-point, кватернион Horn). ---
  function _quatToR(q){var w=q[0],x=q[1],y=q[2],z=q[3];var n=Math.sqrt(w*w+x*x+y*y+z*z)||1;w/=n;x/=n;y/=n;z/=n;return [w*w+x*x-y*y-z*z,2*(x*y-w*z),2*(x*z+w*y),2*(x*y+w*z),w*w-x*x+y*y-z*z,2*(y*z-w*x),2*(x*z-w*y),2*(y*z+w*x),w*w-x*x-y*y+z*z];}
  function registerICP(source, target, opts){
    opts=opts||{};var sp=source&&source.pos,tp=target&&target.pos;var ns=sp?sp.length/3:0,nt=tp?tp.length/3:0;
    var I={R:[1,0,0,0,1,0,0,0,1],t:[0,0,0],rmse:0,iterations:0,converged:false,pos:sp?sp.slice():new Float32Array(0)};
    if(!ns||!nt)return I;
    var maxIter=opts.maxIter!=null?opts.maxIter:30;var tolConv=opts.tol!=null?opts.tol:1e-6;
    var b=_p56bounds(tp,nt);var dx=b.mx[0]-b.mn[0],dy=b.mx[1]-b.mn[1],dz=b.mx[2]-b.mn[2];var diag=Math.sqrt(dx*dx+dy*dy+dz*dz)||1;
    var voxel=opts.voxel!=null?opts.voxel:diag*0.03;if(voxel<=0)voxel=diag*0.03||1e-2;var inv=1/voxel;var map=new Map();
    function key(x,y,z){return x+','+y+','+z;}
    for(var i=0;i<nt;i++){var kx=Math.floor((tp[i*3]-b.mn[0])*inv),ky=Math.floor((tp[i*3+1]-b.mn[1])*inv),kz=Math.floor((tp[i*3+2]-b.mn[2])*inv);var kk=key(kx,ky,kz);var a=map.get(kk);if(!a){a=[];map.set(kk,a);}a.push(i);}
    function nn(x,y,z){var kx=Math.floor((x-b.mn[0])*inv),ky=Math.floor((y-b.mn[1])*inv),kz=Math.floor((z-b.mn[2])*inv);var best=-1,bd=Infinity,fr=-1;for(var r=0;r<=4;r++){if(fr>=0&&r>fr+1)break;for(var ox=-r;ox<=r;ox++)for(var oy=-r;oy<=r;oy++)for(var oz=-r;oz<=r;oz++){if(r>0&&Math.max(Math.abs(ox),Math.abs(oy),Math.abs(oz))!==r)continue;var a=map.get(key(kx+ox,ky+oy,kz+oz));if(!a)continue;for(var j=0;j<a.length;j++){var ni=a[j];var ex=tp[ni*3]-x,ey=tp[ni*3+1]-y,ez=tp[ni*3+2]-z;var d=ex*ex+ey*ey+ez*ez;if(d<bd){bd=d;best=ni;if(fr<0)fr=r;}}}}return best;}
    var cur=sp.slice();var Racc=[1,0,0,0,1,0,0,0,1],tacc=[0,0,0];var rmse=0,iter=0,converged=false,prev=Infinity;
    var maxPairs=opts.maxPairs!=null?opts.maxPairs:20000;var stride=Math.max(1,Math.floor(ns/maxPairs));
    for(iter=0;iter<maxIter;iter++){
      var Sxx=0,Sxy=0,Sxz=0,Syx=0,Syy=0,Syz=0,Szx=0,Szy=0,Szz=0;var cpx=0,cpy=0,cpz=0,cqx=0,cqy=0,cqz=0,m=0;var pIdx=[],qIdx=[];
      for(var i=0;i<ns;i+=stride){var x=cur[i*3],y=cur[i*3+1],z=cur[i*3+2];var ni=nn(x,y,z);if(ni<0)continue;pIdx.push(i);qIdx.push(ni);cpx+=x;cpy+=y;cpz+=z;cqx+=tp[ni*3];cqy+=tp[ni*3+1];cqz+=tp[ni*3+2];m++;}
      if(m<3)break;cpx/=m;cpy/=m;cpz/=m;cqx/=m;cqy/=m;cqz/=m;
      for(var kk2=0;kk2<m;kk2++){var i=pIdx[kk2],ni=qIdx[kk2];var px=cur[i*3]-cpx,py=cur[i*3+1]-cpy,pz=cur[i*3+2]-cpz;var qx=tp[ni*3]-cqx,qy=tp[ni*3+1]-cqy,qz=tp[ni*3+2]-cqz;Sxx+=px*qx;Sxy+=px*qy;Sxz+=px*qz;Syx+=py*qx;Syy+=py*qy;Syz+=py*qz;Szx+=pz*qx;Szy+=pz*qy;Szz+=pz*qz;}
      var N=[[Sxx+Syy+Szz,Syz-Szy,Szx-Sxz,Sxy-Syx],[Syz-Szy,Sxx-Syy-Szz,Sxy+Syx,Szx+Sxz],[Szx-Sxz,Sxy+Syx,-Sxx+Syy-Szz,Syz+Szy],[Sxy-Syx,Szx+Sxz,Syz+Szy,-Sxx-Syy+Szz]];
      var e=_jacobiEig(N,4);var mi=0;for(var kk3=1;kk3<4;kk3++)if(e.values[kk3]>e.values[mi])mi=kk3;
      var q=[e.vectors[0][mi],e.vectors[1][mi],e.vectors[2][mi],e.vectors[3][mi]];var R=_quatToR(q);
      var tx=cqx-(R[0]*cpx+R[1]*cpy+R[2]*cpz),ty=cqy-(R[3]*cpx+R[4]*cpy+R[5]*cpz),tz=cqz-(R[6]*cpx+R[7]*cpy+R[8]*cpz);
      for(var i=0;i<ns;i++){var x=cur[i*3],y=cur[i*3+1],z=cur[i*3+2];cur[i*3]=R[0]*x+R[1]*y+R[2]*z+tx;cur[i*3+1]=R[3]*x+R[4]*y+R[5]*z+ty;cur[i*3+2]=R[6]*x+R[7]*y+R[8]*z+tz;}
      var Rn=_mat3mul(R,Racc);var tn=[R[0]*tacc[0]+R[1]*tacc[1]+R[2]*tacc[2]+tx,R[3]*tacc[0]+R[4]*tacc[1]+R[5]*tacc[2]+ty,R[6]*tacc[0]+R[7]*tacc[1]+R[8]*tacc[2]+tz];Racc=Rn;tacc=tn;
      var se=0;for(var kk4=0;kk4<m;kk4++){var i=pIdx[kk4],ni=qIdx[kk4];var ex=cur[i*3]-tp[ni*3],ey=cur[i*3+1]-tp[ni*3+1],ez=cur[i*3+2]-tp[ni*3+2];se+=ex*ex+ey*ey+ez*ez;}
      rmse=Math.sqrt(se/m);if(Math.abs(prev-rmse)<tolConv){converged=true;iter++;break;}prev=rmse;
    }
    return { R:Racc, t:tacc, rmse:rmse, iterations:iter, converged:converged, pos:cur };
  }

  // --- Phase 3: лёгкое 2.5D-меширование (heightfield) + экспорт OBJ. ---
  // Полный 3D Poisson идёт через Python/Open3D/PDAL; это встроенный быстрый вариант для пола/плит.
  function meshHeightGrid(cloud, opts){
    opts=opts||{};var pos=cloud&&cloud.pos;var count=pos?pos.length/3:0;
    if(!pos||count<3)return { vertices:new Float32Array(0), indices:new Uint32Array(0), width:0, height:0, cell:0 };
    var up=opts.upAxis!=null?opts.upAxis:2;var a0=(up+1)%3,a1=(up+2)%3;
    var b=_p56bounds(pos,count);var w0=b.mx[a0]-b.mn[a0],w1=b.mx[a1]-b.mn[a1];
    var res=opts.resolution!=null?opts.resolution:128;var cell=opts.cell!=null?opts.cell:(Math.max(w0,w1)/res)||1;if(cell<=0)cell=1;
    var gw=Math.max(1,Math.floor(w0/cell)+1),gh=Math.max(1,Math.floor(w1/cell)+1);
    var pick=opts.pick||'max';var zbest=new Float64Array(gw*gh);var has=new Uint8Array(gw*gh);var initV=(pick==='min')?Infinity:-Infinity;
    for(var i=0;i<gw*gh;i++)zbest[i]=initV;
    for(var i=0;i<count;i++){var u=Math.floor((pos[i*3+a0]-b.mn[a0])/cell);if(u<0)u=0;if(u>=gw)u=gw-1;var v=Math.floor((pos[i*3+a1]-b.mn[a1])/cell);if(v<0)v=0;if(v>=gh)v=gh-1;var h=pos[i*3+up];var ci=v*gw+u;if(pick==='min'){if(h<zbest[ci]){zbest[ci]=h;has[ci]=1;}}else{if(h>zbest[ci]){zbest[ci]=h;has[ci]=1;}}}
    var vindex=new Int32Array(gw*gh);for(var i=0;i<gw*gh;i++)vindex[i]=-1;var verts=[];var nv=0;
    for(var v=0;v<gh;v++)for(var u=0;u<gw;u++){var ci=v*gw+u;if(!has[ci])continue;var P=[0,0,0];P[a0]=b.mn[a0]+(u+0.5)*cell;P[a1]=b.mn[a1]+(v+0.5)*cell;P[up]=zbest[ci];verts.push(P[0],P[1],P[2]);vindex[ci]=nv++;}
    var idx=[];
    for(var v=0;v<gh-1;v++)for(var u=0;u<gw-1;u++){var A=vindex[v*gw+u],B2=vindex[v*gw+u+1],C=vindex[(v+1)*gw+u],D=vindex[(v+1)*gw+u+1];if(A>=0&&C>=0&&B2>=0)idx.push(A,C,B2);if(B2>=0&&C>=0&&D>=0)idx.push(B2,C,D);}
    return { vertices:new Float32Array(verts), indices:new Uint32Array(idx), width:gw, height:gh, cell:cell };
  }
  function meshToOBJ(mesh){var V=mesh&&mesh.vertices,I=mesh&&mesh.indices;if(!V||!I)return '';var L=['# BIM Twin mesh export (heightfield)'];for(var i=0;i<V.length;i+=3)L.push('v '+V[i]+' '+V[i+1]+' '+V[i+2]);for(var i=0;i<I.length;i+=3)L.push('f '+(I[i]+1)+' '+(I[i+1]+1)+' '+(I[i+2]+1));return L.join('\n')+'\n';}

  // ============================================================
  // v1150 — Phase 2: паритет функций LixelStudio (Инструмент/Приложение).
  // Чистые, тестируемые функции: объединение, сглаживание, выравнивание,
  // закрытый объём и сравнение объёмов. Без внешних движков.
  // ============================================================

  // Объединить: конкатенация нескольких облаков в одно.
  function mergeClouds(clouds){
    clouds=(clouds||[]).filter(function(c){return c&&c.pos&&c.pos.length;});
    var total=0,anyCol=false;
    clouds.forEach(function(c){total+=c.pos.length/3;if(c.col&&c.col.length)anyCol=true;});
    var pos=new Float32Array(total*3);var col=anyCol?new Uint8Array(total*3):null;var o=0;
    clouds.forEach(function(c){
      var n=c.pos.length/3;pos.set(c.pos.subarray?c.pos.subarray(0,n*3):c.pos,o*3);
      if(col){if(c.col&&c.col.length>=n*3)col.set(c.col.subarray(0,n*3),o*3);else{for(var k=0;k<n*3;k++)col[o*3+k]=200;}}
      o+=n;
    });
    return { pos:pos, col:col, count:total, clouds:clouds.length };
  }

  // Сглаживание: MLS-подобная проекция каждой точки на локальную плоскость (PCA).
  function smoothMLS(cloud, opts){
    opts=opts||{};var pos=cloud&&cloud.pos;var n=pos?pos.length/3:0;
    var out={ pos: pos?pos.slice():new Float32Array(0), col: cloud&&cloud.col?cloud.col.slice():null, count:n, moved:0 };
    if(n<8)return out;
    var b=_p56bounds(pos,n);var dx=b.mx[0]-b.mn[0],dy=b.mx[1]-b.mn[1],dz=b.mx[2]-b.mn[2];var diag=Math.sqrt(dx*dx+dy*dy+dz*dz)||1;
    var radius=opts.radius!=null?opts.radius:diag*0.01;if(radius<=0)radius=diag*0.01||1e-3;
    var strength=opts.strength!=null?opts.strength:1.0;if(strength<0)strength=0;if(strength>1)strength=1;
    var cell=radius;var inv=1/cell;var map=new Map();
    function key(x,y,z){return x+','+y+','+z;}
    for(var i=0;i<n;i++){var kx=Math.floor((pos[i*3]-b.mn[0])*inv),ky=Math.floor((pos[i*3+1]-b.mn[1])*inv),kz=Math.floor((pos[i*3+2]-b.mn[2])*inv);var kk=key(kx,ky,kz);var a=map.get(kk);if(!a){a=[];map.set(kk,a);}a.push(i);}
    var r2=radius*radius;var moved=0;
    for(var i=0;i<n;i++){
      var x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2];
      var kx=Math.floor((x-b.mn[0])*inv),ky=Math.floor((y-b.mn[1])*inv),kz=Math.floor((z-b.mn[2])*inv);
      var sx=0,sy=0,sz=0,m=0;var nb=[];
      for(var ox=-1;ox<=1;ox++)for(var oy=-1;oy<=1;oy++)for(var oz=-1;oz<=1;oz++){
        var a=map.get(key(kx+ox,ky+oy,kz+oz));if(!a)continue;
        for(var j=0;j<a.length;j++){var ni=a[j];var ex=pos[ni*3]-x,ey=pos[ni*3+1]-y,ez=pos[ni*3+2]-z;if(ex*ex+ey*ey+ez*ez<=r2){nb.push(ni);sx+=pos[ni*3];sy+=pos[ni*3+1];sz+=pos[ni*3+2];m++;}}
      }
      if(m<4)continue;
      var cx=sx/m,cy=sy/m,cz=sz/m;
      var xx=0,xy=0,xz=0,yy=0,yz=0,zz=0;
      for(var j=0;j<nb.length;j++){var ni=nb[j];var ex=pos[ni*3]-cx,ey=pos[ni*3+1]-cy,ez=pos[ni*3+2]-cz;xx+=ex*ex;xy+=ex*ey;xz+=ex*ez;yy+=ey*ey;yz+=ey*ez;zz+=ez*ez;}
      var C=[[xx,xy,xz],[xy,yy,yz],[xz,yz,zz]];
      var e=_jacobiEig(C,3);var mi=0;for(var k=1;k<3;k++)if(e.values[k]<e.values[mi])mi=k;
      var nx=e.vectors[0][mi],ny=e.vectors[1][mi],nz=e.vectors[2][mi];var nl=Math.sqrt(nx*nx+ny*ny+nz*nz)||1;nx/=nl;ny/=nl;nz/=nl;
      var dvec=(x-cx)*nx+(y-cy)*ny+(z-cz)*nz;
      out.pos[i*3]=x-dvec*nx*strength;out.pos[i*3+1]=y-dvec*ny*strength;out.pos[i*3+2]=z-dvec*nz*strength;
      if(Math.abs(dvec)>1e-9)moved++;
    }
    out.moved=moved;return out;
  }

  // Доминантная плоскость (пол/потолок либо стена) для выравнивания.
  function dominantPlane(cloud, opts){
    opts=opts||{};var pos=cloud&&cloud.pos;var n=pos?pos.length/3:0;if(n<3)return null;
    var planes=detectPlanes(pos,n,{maxPlanes:opts.maxPlanes||4});
    if(!planes.length)return null;
    var want=opts.orientation||'floor';var uax=opts.upAxis!=null?opts.upAxis:2;var best=null,bestScore=-Infinity;
    planes.forEach(function(p){var absu=Math.abs(p.normal[uax]);var score=want==='wall'?(1-absu)*p.count:absu*p.count;if(score>bestScore){bestScore=score;best=p;}});
    return best;
  }

  // Выравнивание/Горизонтальный/Вертикальный: поворот облака так, чтобы нормаль
  // доминантной плоскости совпала с осью up (Родригес, вокруг центра bbox).
  function levelCloud(cloud, opts){
    opts=opts||{};var pos=cloud&&cloud.pos;var n=pos?pos.length/3:0;
    var out={ pos: pos?pos.slice():new Float32Array(0), col: cloud&&cloud.col?cloud.col.slice():null, count:n, angleDeg:0, applied:false };
    if(n<3)return out;
    var up=opts.up||[0,0,1];var ul=Math.sqrt(up[0]*up[0]+up[1]*up[1]+up[2]*up[2])||1;up=[up[0]/ul,up[1]/ul,up[2]/ul];
    var uax=0;var uamax=Math.abs(up[0]);if(Math.abs(up[1])>uamax){uamax=Math.abs(up[1]);uax=1;}if(Math.abs(up[2])>uamax){uamax=Math.abs(up[2]);uax=2;}
    var plane=opts.plane||dominantPlane(cloud,{orientation:opts.orientation||'floor',upAxis:uax});
    if(!plane)return out;
    var nrm=plane.normal.slice();
    if(nrm[0]*up[0]+nrm[1]*up[1]+nrm[2]*up[2]<0)nrm=[-nrm[0],-nrm[1],-nrm[2]];
    var ax=nrm[1]*up[2]-nrm[2]*up[1],ay=nrm[2]*up[0]-nrm[0]*up[2],az=nrm[0]*up[1]-nrm[1]*up[0];
    var s=Math.sqrt(ax*ax+ay*ay+az*az);var c=nrm[0]*up[0]+nrm[1]*up[1]+nrm[2]*up[2];
    var angle=Math.atan2(s,c);out.angleDeg=angle*180/Math.PI;
    if(s<1e-9){out.applied=true;return out;}
    ax/=s;ay/=s;az/=s;
    var C=Math.cos(angle),S2=Math.sin(angle),t=1-C;
    var R=[t*ax*ax+C,t*ax*ay-S2*az,t*ax*az+S2*ay,t*ax*ay+S2*az,t*ay*ay+C,t*ay*az-S2*ax,t*ax*az-S2*ay,t*ay*az+S2*ax,t*az*az+C];
    var b=_p56bounds(pos,n);var ox=(b.mn[0]+b.mx[0])/2,oy=(b.mn[1]+b.mx[1])/2,oz=(b.mn[2]+b.mx[2])/2;
    for(var i=0;i<n;i++){var x=pos[i*3]-ox,y=pos[i*3+1]-oy,z=pos[i*3+2]-oz;out.pos[i*3]=R[0]*x+R[1]*y+R[2]*z+ox;out.pos[i*3+1]=R[3]*x+R[4]*y+R[5]*z+oy;out.pos[i*3+2]=R[6]*x+R[7]*y+R[8]*z+oz;}
    out.applied=true;out.R=R;return out;
  }

  // Закрытый объём: столбцовая заливка вдоль оси up (объём между верхней и нижней
  // поверхностью на регулярной сетке) — реальная оценка замкнутого объёма.
  function closedVolume(cloud, opts){
    opts=opts||{};var pos=cloud&&cloud.pos;var n=pos?pos.length/3:0;
    if(n<4)return { volume:0, voxel:0, columns:0 };
    var up=opts.up!=null?opts.up:2;var a0=(up+1)%3,a1=(up+2)%3;
    var b=_p56bounds(pos,n);var d0=b.mx[a0]-b.mn[a0],d1=b.mx[a1]-b.mn[a1],du=b.mx[up]-b.mn[up];var diag=Math.sqrt(d0*d0+d1*d1+du*du)||1;
    var voxel=opts.voxel!=null?opts.voxel:diag/64;if(voxel<=0)voxel=diag/64||1e-3;var inv=1/voxel;
    var g0=Math.max(1,Math.floor(d0*inv)+1),g1=Math.max(1,Math.floor(d1*inv)+1);
    var lo=new Float64Array(g0*g1),hi=new Float64Array(g0*g1),has=new Uint8Array(g0*g1);
    for(var i=0;i<g0*g1;i++){lo[i]=Infinity;hi[i]=-Infinity;}
    for(var i=0;i<n;i++){var u=Math.floor((pos[i*3+a0]-b.mn[a0])*inv);if(u<0)u=0;if(u>=g0)u=g0-1;var v=Math.floor((pos[i*3+a1]-b.mn[a1])*inv);if(v<0)v=0;if(v>=g1)v=g1-1;var h=pos[i*3+up];var ci=v*g0+u;if(h<lo[ci])lo[ci]=h;if(h>hi[ci])hi[ci]=h;has[ci]=1;}
    var cellArea=voxel*voxel,vol=0,cols=0;
    for(var ci=0;ci<g0*g1;ci++){if(!has[ci])continue;cols++;var h=hi[ci]-lo[ci];if(h<0)h=0;vol+=cellArea*h;}
    return { volume:vol, voxel:voxel, columns:cols, mode:'solid', bbox:{mn:b.mn,mx:b.mx} };
  }

  // Сравнение объёмов: cut/fill между верхними поверхностями двух облаков на общей сетке.
  function compareVolumes(cloudA, cloudB, opts){
    opts=opts||{};var pa=cloudA&&cloudA.pos,pb=cloudB&&cloudB.pos;var na=pa?pa.length/3:0,nb=pb?pb.length/3:0;
    if(na<3||nb<3)return { cut:0, fill:0, net:0, cell:0, cells:0 };
    var up=opts.up!=null?opts.up:2;var a0=(up+1)%3,a1=(up+2)%3;
    var ba=_p56bounds(pa,na),bb=_p56bounds(pb,nb);
    var mn0=Math.min(ba.mn[a0],bb.mn[a0]),mn1=Math.min(ba.mn[a1],bb.mn[a1]);
    var mx0=Math.max(ba.mx[a0],bb.mx[a0]),mx1=Math.max(ba.mx[a1],bb.mx[a1]);
    var d0=mx0-mn0,d1=mx1-mn1;var diag=Math.sqrt(d0*d0+d1*d1)||1;
    var cell=opts.cell!=null?opts.cell:diag/128;if(cell<=0)cell=diag/128||1e-3;var inv=1/cell;
    var g0=Math.max(1,Math.floor(d0*inv)+1),g1=Math.max(1,Math.floor(d1*inv)+1);
    function grid(p,cnt){var G=new Float64Array(g0*g1),H=new Uint8Array(g0*g1);for(var i=0;i<g0*g1;i++)G[i]=-Infinity;for(var i=0;i<cnt;i++){var u=Math.floor((p[i*3+a0]-mn0)*inv);if(u<0)u=0;if(u>=g0)u=g0-1;var v=Math.floor((p[i*3+a1]-mn1)*inv);if(v<0)v=0;if(v>=g1)v=g1-1;var h=p[i*3+up];var ci=v*g0+u;if(h>G[ci]){G[ci]=h;H[ci]=1;}}return {G:G,H:H};}
    var A=grid(pa,na),B=grid(pb,nb);var cellArea=cell*cell,cut=0,fill=0,cells=0;
    for(var ci=0;ci<g0*g1;ci++){if(!A.H[ci]||!B.H[ci])continue;var diff=B.G[ci]-A.G[ci];cells++;if(diff>=0)fill+=diff*cellArea;else cut+=(-diff)*cellArea;}
    return { cut:cut, fill:fill, net:fill-cut, cell:cell, cells:cells };
  }

  const API = { pointInPolygon, selectByRect, selectByPolygon, invertSelection, deleteByIndices, keepByIndices, clusterFront, toPLY, toPLYBinary, toPLYBinaryAsync, toLASBinary, toXYZText, cleanVoxelDensity, cleanClusters, detectPlanes, protectPlanes, protectFloorLocal, cleanIslands, magicWand, selectByColor, selectBySphere, selectByBox, cleanStatisticalOutliers, cleanAuto, fillPlaneHoles, cleanRadiusOutliers, noiseFilterLocalPlane, voxelDownsample, estimateNormals, classifyStructure, cropBox, sliceSection, measureDistance, pointToPlaneDistance, registerICP, meshHeightGrid, meshToOBJ, mergeClouds, smoothMLS, dominantPlane, levelCloud, closedVolume, compareVolumes };
  if (typeof window !== 'undefined') window.PCEdit = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
