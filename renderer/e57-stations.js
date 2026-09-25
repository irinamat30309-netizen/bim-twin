/*
 * e57-stations.js — импорт реальных станций сканера из E57 для режима «Экскурсия».
 *
 * По мотивам Autodesk ReCap / Leica Cyclone REGISTER 360: в E57 хранятся
 * позы станций съёмки (data3D/pose) и сферические снимки (images2D). Этот
 * модуль — чистая логика (без GPU/DOM), покрыта тестами test/e57-stations.test.js:
 *   • stripCrcPages() — сборка логического XML из физических страниц E57 (каждая
 *     страница = pageSize-4 байт данных + 4 байта CRC-32C в конце);
 *   • parseE57Header() — разбор XML → станции (survey-координаты) + ссылки на снимки;
 *   • toViewerPos()/stationsFromE57() — перевод survey Z-up → вьювер Y-up той же
 *     формулой, что в las-node.js, чтобы станции совпали с облаком.
 *
 * Станция на выходе совместима с RealView: { id, name, pos:[x,y,z], yaw, panoUrl }.
 */
(function () {
  'use strict';

  // ---- чтение чисел из текста XML ----
  function num(s, def) { var v = parseFloat(s); return isFinite(v) ? v : (def || 0); }

  // Извлечь первое содержимое <tag ...>...</tag> внутри строки.
  function tagText(xml, tag) {
    var re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'i');
    var m = xml.match(re);
    return m ? m[1].trim() : null;
  }

  // Извлечь блок <tag ...>...</tag> целиком (с обёрткой).
  function tagBlock(xml, tag) {
    var re = new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?</' + tag + '>', 'i');
    var m = xml.match(re);
    return m ? m[0] : null;
  }

  // Все повторяющиеся <vectorChild ...>...</vectorChild> внутри секции.
  function vectorChildren(sectionXml) {
    if (!sectionXml) return [];
    return sectionXml.match(/<vectorChild\b[^>]*>[\s\S]*?<\/vectorChild>/gi) || [];
  }

  function readXYZ(xml) {
    if (!xml) return null;
    var x = tagText(xml, 'x'), y = tagText(xml, 'y'), z = tagText(xml, 'z');
    if (x == null && y == null && z == null) return null;
    return [num(x), num(y), num(z)];
  }

  function readQuat(xml) {
    if (!xml) return null;
    var w = tagText(xml, 'w'), x = tagText(xml, 'x'), y = tagText(xml, 'y'), z = tagText(xml, 'z');
    if (w == null && x == null && y == null && z == null) return null;
    return [num(w, 1), num(x), num(y), num(z)];
  }

  /*
   * parseE57Header(xml) — разбор логического XML-заголовка E57.
   * Возвращает { stations:[{ name, guid, survey:[X,Y,Z], rot:[w,x,y,z]|null }], images:[{ guid, assoc, type }] }.
   * survey-координаты — в исходной системе съёмки (обычно Z-up).
   */
  function parseE57Header(xml) {
    var out = { stations: [], images: [] };
    if (!xml || typeof xml !== 'string') return out;

    var d3 = tagBlock(xml, 'data3D');
    var children = vectorChildren(d3);
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      var name = tagText(c, 'name');
      var guid = tagText(c, 'guid');
      var pose = tagBlock(c, 'pose');
      var survey = null, rot = null;
      if (pose) {
        survey = readXYZ(tagBlock(pose, 'translation'));
        rot = readQuat(tagBlock(pose, 'rotation'));
      }
      if (!survey) survey = [0, 0, 0];
      out.stations.push({
        name: name || ('Станция ' + (i + 1)),
        guid: guid || null,
        survey: survey,
        rot: rot
      });
    }

    var i2 = tagBlock(xml, 'images2D');
    var imgs = vectorChildren(i2);
    for (var k = 0; k < imgs.length; k++) {
      var im = imgs[k];
      var type = 'spherical';
      if (/<pinholeRepresentation/i.test(im)) type = 'pinhole';
      else if (/<cylindricalRepresentation/i.test(im)) type = 'cylindrical';
      out.images.push({
        guid: tagText(im, 'guid'),
        assoc: tagText(im, 'associatedData3DGuid'),
        type: type
      });
    }
    return out;
  }

  /*
   * toViewerPos(survey, offset) — та же трансформация, что в las-node.js:
   *   survey Z-up (X,Y,Z) → вьювер Y-up: [X-cx, Z-mnz, -(Y-cy)].
   * offset = { cx, cy, mnz } берётся из meta.offset загруженного облака.
   * Если offset нет (облако не из LAS/неизвестно) — центр не смещается.
   */
  function toViewerPos(survey, offset) {
    var cx = offset && offset.cx != null ? offset.cx : 0;
    var cy = offset && offset.cy != null ? offset.cy : 0;
    var mnz = offset && offset.mnz != null ? offset.mnz : 0;
    return [survey[0] - cx, survey[2] - mnz, -(survey[1] - cy)];
  }

  /*
   * stationsFromE57(parsed, offset, opts) — станции E57 → станции RealView.
   * Координаты переводятся в систему вьювера; yaw=0 (осмотр свободный).
   */
  function stationsFromE57(parsed, offset, opts) {
    opts = opts || {};
    var list = (parsed && parsed.stations) || [];
    return list.map(function (s, i) {
      return {
        id: 'e57_' + (i + 1),
        name: s.name || ('Станция ' + (i + 1)),
        pos: toViewerPos(s.survey, offset),
        yaw: 0,
        panoUrl: null,
        guid: s.guid || null
      };
    });
  }

  /*
   * stripCrcPages(bytes, physBase, xmlPhysicalOffset, xmlLogicalLength, pageSize)
   * — собирает логические байты XML из физических страниц E57.
   *   bytes            — Buffer/Uint8Array части файла;
   *   physBase         — физический оффсет файла, которому соответствует bytes[0];
   *   pageSize         — размер физической страницы (последние 4 байта — CRC).
   * Возвращает строку UTF-8.
   */
  function stripCrcPages(bytes, physBase, xmlPhysicalOffset, xmlLogicalLength, pageSize) {
    physBase = physBase || 0;
    var dataPerPage = pageSize - 4;
    var out = [];
    var oi = 0;
    var phys = xmlPhysicalOffset;
    while (oi < xmlLogicalLength) {
      var page = Math.floor(phys / pageSize);
      var dataEnd = page * pageSize + dataPerPage; // первый CRC-байт страницы
      if (phys >= dataEnd) { phys = (page + 1) * pageSize; continue; } // в зоне CRC — на след. страницу
      var avail = dataEnd - phys;
      var take = Math.min(avail, xmlLogicalLength - oi);
      var srcStart = phys - physBase;
      for (var b = 0; b < take; b++) out.push(bytes[srcStart + b]);
      oi += take; phys += take;
    }
    if (typeof Buffer !== 'undefined') return Buffer.from(out).toString('utf8');
    // откат для сред без Buffer
    var s = '';
    for (var j = 0; j < out.length; j++) s += String.fromCharCode(out[j]);
    try { return decodeURIComponent(escape(s)); } catch (_) { return s; }
  }

  // Разбор 48-байтного заголовка файла E57 (little-endian).
  //   0: "ASTM-E57", 8: major u32, 12: minor u32, 16: filePhysicalLength u64,
  //   24: xmlPhysicalOffset u64, 32: xmlLogicalLength u64, 40: pageSize u64.
  function parseFileHeader(buf) {
    if (!buf || buf.length < 48) return null;
    var sig = '';
    for (var i = 0; i < 8; i++) sig += String.fromCharCode(buf[i]);
    if (sig !== 'ASTM-E57') return null;
    function u64(o) {
      if (typeof buf.readBigUInt64LE === 'function') return Number(buf.readBigUInt64LE(o));
      var lo = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] * 0x1000000);
      var hi = buf[o + 4] | (buf[o + 5] << 8) | (buf[o + 6] << 16) | (buf[o + 7] * 0x1000000);
      return lo + hi * 0x100000000;
    }
    var pageSize = u64(40);
    if (!pageSize || pageSize < 8) pageSize = 1024; // стандарт E57
    return {
      major: buf.readUInt32LE ? buf.readUInt32LE(8) : 0,
      minor: buf.readUInt32LE ? buf.readUInt32LE(12) : 0,
      filePhysicalLength: u64(16),
      xmlPhysicalOffset: u64(24),
      xmlLogicalLength: u64(32),
      pageSize: pageSize
    };
  }

  var api = {
    parseE57Header: parseE57Header,
    toViewerPos: toViewerPos,
    stationsFromE57: stationsFromE57,
    stripCrcPages: stripCrcPages,
    parseFileHeader: parseFileHeader
  };
  if (typeof window !== 'undefined') window.E57Stations = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
