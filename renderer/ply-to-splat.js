/*
 * ply-to-splat.js — LiDAR PLY → Gaussian Splatting конвертер для BIM Twin.
 * Входные данные: ArrayBuffer обычного PLY с xyz+rgb (лидарное облако точек).
 * Выходные данные: ArrayBuffer в формате .splat (32 байта/сплэт):
 *   [0..11]  : xyz  (float32×3) — позиция
 *   [12..23] : scale (float32×3) — размер эллипса
 *   [24..27] : RGBA (uint8×4)   — цвет + прозрачность
 *   [28..31] : rot  (uint8×4)   — кватернион вращения
 * API: window.PlyToSplat = { convert(buf, opts) → Promise<{buffer, count, scale}> }
 */
(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────
  // 1. PLY HEADER PARSER
  // ──────────────────────────────────────────────────────────
  function parsePlyHeader(arrayBuffer) {
    var u8 = new Uint8Array(arrayBuffer);
    var headerText = '';
    var scan = Math.min(u8.length, 200000);
    var marker = 'end_header\n';
    for (var i = 0; i < scan; i++) {
      headerText += String.fromCharCode(u8[i]);
      if (headerText.length >= marker.length &&
          headerText.slice(-marker.length) === marker) break;
    }
    var dataStart = headerText.length;
    var lines = headerText.split('\n');
    var vertexCount = 0;
    var props = [];
    var inVertex = false;
    var littleEndian = true;
    var isBinary = false;

    for (var l = 0; l < lines.length; l++) {
      var ln = lines[l].trim();
      if (ln === 'format binary_little_endian 1.0') { isBinary = true; littleEndian = true; }
      else if (ln === 'format binary_big_endian 1.0') { isBinary = true; littleEndian = false; }
      else if (ln.indexOf('element vertex') === 0) {
        vertexCount = parseInt(ln.split(/\s+/)[2], 10);
        inVertex = true;
      } else if (ln.indexOf('element') === 0 && ln.indexOf('vertex') < 0) {
        inVertex = false;
      } else if (ln.indexOf('property') === 0 && inVertex) {
        var parts = ln.split(/\s+/);
        if (parts[1] === 'list') continue;
        props.push({ type: parts[1], name: parts[2] });
      }
    }

    function typeSize(t) {
      if (t === 'double' || t === 'float64') return 8;
      if (t === 'float' || t === 'float32' || t === 'int' || t === 'uint' ||
          t === 'int32' || t === 'uint32') return 4;
      if (t === 'short' || t === 'ushort' || t === 'int16' || t === 'uint16') return 2;
      return 1; // uchar / char / uint8
    }

    var offsets = {}, types = {};
    var rowLen = 0;
    for (var p = 0; p < props.length; p++) {
      offsets[props[p].name] = rowLen;
      types[props[p].name] = props[p].type;
      rowLen += typeSize(props[p].type);
    }

    function has(n) { return offsets[n] !== undefined; }

    // Позиция
    if (!has('x') || !has('y') || !has('z')) return null; // не PLY с геометрией

    // Цвет (разные имена в PLY)
    var rName = has('red') ? 'red' : has('r') ? 'r' : null;
    var gName = has('green') ? 'green' : has('g') ? 'g' : null;
    var bName = has('blue') ? 'blue' : has('b') ? 'b' : null;
    var hasColor = rName && gName && bName;

    // Тип цвета: uchar (0-255) или float (0-1)
    var colorIsFloat = hasColor && (
      types[rName] === 'float' || types[rName] === 'float32' ||
      types[rName] === 'double'
    );

    return {
      vertexCount: vertexCount,
      rowLen: rowLen,
      dataStart: dataStart,
      littleEndian: littleEndian,
      isBinary: isBinary,
      offX: offsets['x'], offY: offsets['y'], offZ: offsets['z'],
      typeX: types['x'],
      offR: hasColor ? offsets[rName] : -1,
      offG: hasColor ? offsets[gName] : -1,
      offB: hasColor ? offsets[bName] : -1,
      typeR: hasColor ? types[rName] : null,
      colorIsFloat: colorIsFloat,
      hasColor: !!hasColor,
    };
  }

  // ──────────────────────────────────────────────────────────
  // 2. ОЦЕНКА МАСШТАБА СПЛЭТА (по bbox + плотность точек)
  // ──────────────────────────────────────────────────────────
  function estimateScale(dv, hdr, sampleN) {
    var count = hdr.vertexCount;
    var rowLen = hdr.rowLen;
    var offX = hdr.offX, offY = hdr.offY, offZ = hdr.offZ;
    var le = hdr.littleEndian;
    var step = Math.max(1, Math.floor(count / sampleN));

    var mnX = Infinity, mnY = Infinity, mnZ = Infinity;
    var mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
    var sampled = 0;

    for (var i = 0; i < count; i += step) {
      var base = i * rowLen;
      var x = dv.getFloat32(base + offX, le);
      var y = dv.getFloat32(base + offY, le);
      var z = dv.getFloat32(base + offZ, le);
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
      if (x < mnX) mnX = x; if (x > mxX) mxX = x;
      if (y < mnY) mnY = y; if (y > mxY) mxY = y;
      if (z < mnZ) mnZ = z; if (z > mxZ) mxZ = z;
      sampled++;
    }

    if (!sampled || !isFinite(mnX)) return { scale: 0.02, bbox: null };

    // Площадь поверхности сканирования (упрощённо: два наибольших измерения)
    var dx = mxX - mnX, dy = mxY - mnY, dz = mxZ - mnZ;
    // Берём горизонтальное сечение (X×Z) как основную поверхность
    var area = dx * dz + dx * dy * 0.5 + dy * dz * 0.5;
    area = Math.max(area, 0.01);

    // Плотность: сколько точек на кв.метр → размер сплэта = ~1/sqrt(плотность)
    var density = count / area;   // точек/м²
    var spacing = 1.0 / Math.sqrt(Math.max(density, 1));
    // Сплэт чуть больше шага чтобы перекрываться и закрашивать дыры
    var scale = Math.max(0.003, Math.min(0.8, spacing * 1.8));

    return {
      scale: scale,
      scaleZ: scale * 0.12, // плоский диск: по нормали тонкий
      bbox: { mnX: mnX, mnY: mnY, mnZ: mnZ, mxX: mxX, mxY: mxY, mxZ: mxZ },
      spacing: spacing,
    };
  }

  // ──────────────────────────────────────────────────────────
  // 3. ОСНОВНОЙ КОНВЕРТЕР
  // ──────────────────────────────────────────────────────────
  // opts:
  //   downsample  (int, default 4) — брать каждую N-ю точку
  //   progress    (fn(pct, msg))   — коллбек прогресса
  //   maxSplats   (int)            — жёсткий лимит выходных сплэтов (default 15M)
  function convert(plyBuffer, opts) {
    return new Promise(function (resolve, reject) {
      try {
        opts = opts || {};
        var progress = opts.progress || function () {};
        var downsample = Math.max(1, Math.round(opts.downsample || 4));
        var maxSplats = opts.maxSplats || 15000000;

        progress(0, 'Разбираю заголовок PLY…');
        var hdr = parsePlyHeader(plyBuffer);
        if (!hdr) { reject(new Error('Не удалось прочитать заголовок PLY')); return; }
        if (!hdr.isBinary) { reject(new Error('Поддерживается только бинарный PLY (binary_little/big_endian)')); return; }

        var n = hdr.vertexCount;
        progress(2, 'Точек: ' + n.toLocaleString('ru-RU') + ' · оцениваю масштаб…');

        // DataView на блок данных
        var dv = new DataView(plyBuffer, hdr.dataStart);

        // Оценка масштаба (по ~50 000 выборочным точкам)
        var scaleInfo = estimateScale(dv, hdr, 50000);
        var splatScale = scaleInfo.scale;
        var splatScaleZ = scaleInfo.scaleZ || splatScale * 0.12;

        progress(8, 'Масштаб сплэта: ' + splatScale.toFixed(4) + ' м · конвертирую…');

        // Корректируем downsample чтобы не превысить maxSplats
        var minStep = Math.ceil(n / maxSplats);
        if (minStep > downsample) downsample = minStep;

        var outCount = Math.ceil(n / downsample);
        var outBuf, out, outF;
        try {
          outBuf = new ArrayBuffer(outCount * 32);
          out = new Uint8Array(outBuf);
          outF = new Float32Array(outBuf);
        } catch (e) {
          reject(new Error('Недостаточно памяти. Попробуйте увеличить прореживание.'));
          return;
        }

        var rowLen = hdr.rowLen;
        var offX = hdr.offX, offY = hdr.offY, offZ = hdr.offZ;
        var offR = hdr.offR, offG = hdr.offG, offB = hdr.offB;
        var colorIsFloat = hdr.colorIsFloat;
        var le = hdr.littleEndian;

        // Кватернион идентичности в uint8: w=1→191, xyz=0→128
        // Формула: byte = round(q * 128 + 128), clamp [0,255]
        // w=1 → 128+128=256 → clamp 255; xyz=0 → 128
        var ROT_W = 255, ROT_X = 128, ROT_Y = 128, ROT_Z = 128;
        var ALPHA = 225;

        var w = 0; // индекс выходного сплэта
        var chunkSize = 500000; // обрабатываем кусками
        var i = 0;

        function processChunk() {
          var end = Math.min(i + chunkSize * downsample, n);
          for (; i < end; i += downsample) {
            var base = i * rowLen;

            // Позиция
            var px = dv.getFloat32(base + offX, le);
            var py = dv.getFloat32(base + offY, le);
            var pz = dv.getFloat32(base + offZ, le);
            if (!isFinite(px) || !isFinite(py) || !isFinite(pz)) continue;

            // Цвет
            var cr = 180, cg = 180, cb = 180;
            if (offR >= 0) {
              if (colorIsFloat) {
                cr = Math.round(dv.getFloat32(base + offR, le) * 255);
                cg = Math.round(dv.getFloat32(base + offG, le) * 255);
                cb = Math.round(dv.getFloat32(base + offB, le) * 255);
              } else {
                cr = dv.getUint8(base + offR);
                cg = dv.getUint8(base + offG);
                cb = dv.getUint8(base + offB);
              }
            }

            // Пишем 32 байта сплэта
            var f8 = w * 8; // индекс в float32 массиве (8 float32 = 32 байта)
            outF[f8 + 0] = px;
            outF[f8 + 1] = py;
            outF[f8 + 2] = pz;
            outF[f8 + 3] = splatScale;   // scale_x
            outF[f8 + 4] = splatScale;   // scale_y
            outF[f8 + 5] = splatScaleZ;  // scale_z (тонкий диск по нормали)

            var u32 = w * 32; // байтовый индекс
            out[u32 + 24] = cr > 255 ? 255 : (cr < 0 ? 0 : cr);
            out[u32 + 25] = cg > 255 ? 255 : (cg < 0 ? 0 : cg);
            out[u32 + 26] = cb > 255 ? 255 : (cb < 0 ? 0 : cb);
            out[u32 + 27] = ALPHA;
            out[u32 + 28] = ROT_W;
            out[u32 + 29] = ROT_X;
            out[u32 + 30] = ROT_Y;
            out[u32 + 31] = ROT_Z;

            w++;
          }

          var pct = 10 + Math.round(88 * i / n);
          progress(pct, 'Конвертировано ' + w.toLocaleString('ru-RU') + ' сплэтов…');

          if (i < n) {
            // Следующий чанк через setTimeout → браузер не замерзает
            setTimeout(processChunk, 0);
          } else {
            progress(100, 'Готово! ' + w.toLocaleString('ru-RU') + ' сплэтов');
            // Обрезаем буфер до реального размера
            var finalBuf = outBuf.slice(0, w * 32);
            resolve({
              buffer: finalBuf,
              count: w,
              scale: splatScale,
              bbox: scaleInfo.bbox,
              downsample: downsample,
            });
          }
        }

        // Запускаем первый чанк
        setTimeout(processChunk, 0);

      } catch (err) {
        reject(err);
      }
    });
  }

  // ──────────────────────────────────────────────────────────
  // 4. ЭКСПОРТ
  // ──────────────────────────────────────────────────────────
  window.PlyToSplat = {
    convert: convert,
    parsePlyHeader: parsePlyHeader,
    estimateScale: estimateScale,
  };

})();
