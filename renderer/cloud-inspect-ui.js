/*
 * cloud-inspect-ui.js — окно «Контроль геометрии» (ревизия 31).
 *
 * CloudInspectUI.open(path, ov, st) — форма (этаж, класс отделки, допуски) → bimAPI.cloudInspect (поток карты облака: срез, план,
 * проход по точкам пола и стен) → окно результатов: карта (отклонения пола от плоскости / от горизонтали, стены, проект DXF),
 * вкладки «Пол», «Стены», «Проект»; CSV и PDF-отчёт.
 * Чистые функции (тесты): presets, diverging, sequential, limitOf, ffClass, verdict, csv, wallStatus, lineStatus.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudInspectUI = api;
})(typeof window !== 'undefined' ? window : null, function (W) {
  'use strict';
  var D = W && W.document;

  // ------------------------------------------------------------------ чистые функции
  // допуски штукатурки по СП 71.13330 (ориентир): вертикаль мм/м, не более мм на высоту, неровность под 2-метровой рейкой
  var PRESETS = {
    high: { label: 'Высококачественная', plumbPerM: 1, plumbMax: 5, wallRail: 2 },
    improved: { label: 'Улучшенная', plumbPerM: 2, plumbMax: 10, wallRail: 3 },
    simple: { label: 'Простая', plumbPerM: 3, plumbMax: 15, wallRail: 5 }
  };
  function presets() { return PRESETS; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  // расходящаяся палитра: −lim синий (впадина), 0 светлый, +lim красный (бугор / выступ)
  var DIV = [[33, 102, 172], [103, 169, 207], [209, 229, 240], [247, 247, 247], [253, 219, 199], [239, 138, 98], [178, 24, 43]];
  function diverging(v, lim) {
    if (!(v === v)) return null;
    var t = clamp((v / Math.max(1e-9, lim) + 1) / 2, 0, 1) * (DIV.length - 1), i = Math.min(DIV.length - 2, Math.floor(t)), f = t - i, a = DIV[i], b = DIV[i + 1];
    return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
  }
  // последовательная: 0 зелёный → tol жёлтый → 3·tol красный
  function sequential(v, tol) {
    if (!(v === v)) return null;
    var t = clamp(Math.abs(v) / Math.max(1e-9, tol), 0, 3);
    if (t <= 1) return [Math.round(34 + (234 - 34) * t), Math.round(197 + (179 - 197) * t), Math.round(94 + (8 - 94) * t)];
    var f = (t - 1) / 2; return [Math.round(234 + (220 - 234) * f), Math.round(179 + (38 - 179) * f), Math.round(8 + (38 - 8) * f)];
  }
  // предел шкалы: 99-й процентиль |v|, округлённый до 2, 5, 10, 15, 20, 30, 50, 75, 100… мм
  function limitOf(arr) {
    var a = []; for (var i = 0; i < arr.length; i++) { var x = arr[i]; if (x === x) a.push(Math.abs(x)); }
    if (!a.length) return 10;
    a.sort(function (p, q) { return p - q; });
    var p = a[Math.min(a.length - 1, Math.floor(a.length * 0.99))], steps = [2, 5, 10, 15, 20, 30, 50, 75, 100, 150, 200];
    for (var k = 0; k < steps.length; k++) if (p <= steps[k]) return steps[k];
    return 300;
  }
  // класс пола по числу FF (ACI 302.1R / 117, ориентир)
  function ffClass(F) {
    if (!(F > 0)) return '—';
    return F < 20 ? 'ниже обычного' : F < 25 ? 'обычный (FF20)' : F < 35 ? 'умеренно ровный (FF25)' : F < 45 ? 'ровный (FF35)' : F < 60 ? 'очень ровный (FF45)' : 'сверхровный (FF60+)';
  }
  function wallStatus(w) { return w.ok ? 'ok' : !w.okPlumb && !w.okRail ? 'both' : !w.okPlumb ? 'plumb' : 'rail'; }
  function lineStatus(x, tol) { return x.length < 0.5 ? 'короткая' : x.cover < 0.3 ? 'нет в облаке' : x.points >= 20 && Math.abs(x.offset) > tol * 1000 ? 'смещена' : 'совпадает'; }
  function fmt(x, d) { return x === x && x != null && isFinite(x) ? (+x).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—'; }
  function plural(n, a, b, c) { var m = Math.abs(n) % 100, d = m % 10; return n + ' ' + (m > 10 && m < 20 ? c : d === 1 ? a : d >= 2 && d <= 4 ? b : c); }
  function median(a) { var s = a.filter(function (x) { return x === x && x != null; }).sort(function (p, q) { return p - q; }); return s.length ? s[s.length >> 1] : NaN; }
  // короткий вывод для окна и отчёта
  function levelText(lv) {
    if (!lv) return 'не проверялся';
    if (!lv.ok) return 'не определён (' + (lv.message || 'мало стен') + ')';
    var t = fmt(lv.mm, 2) + ' мм/м (' + fmt(lv.deg, 3) + '°) по ' + plural(lv.n, 'стене', 'стенам', 'стенам');
    return t + (lv.applied ? ' — учтён' : lv.significant ? ' — не учтён (выключено)' : ' — в пределах погрешности, не учитывается');
  }
  function prepText(p) {
    if (!p) return 'исходное, без очистки';
    if (p.reused) return 'очищенное ранее: ' + p.name;
    var st = p.stats || {}, al = st.align, parts = [];
    if (al && !al.skipped && al.before != null) parts.push('проходы сведены ' + fmt(al.before * 1000, 1) + ' → ' + fmt(al.after * 1000, 1) + ' мм');
    if (st.dynamic) parts.push('люди ' + fmt(st.dynamic / 1e6, 2) + ' млн т.');
    if (st.noise) parts.push('шум ' + fmt(st.noise / 1e6, 2) + ' млн т.');
    return 'очищено: ' + p.name + (parts.length ? ' (' + parts.join(', ') + ')' : '');
  }
  function verdict(res) {
    var out = [];
    if (res.floor && res.floor.ok) {
      var f = res.floor, F = f.F || {};
      out.push('Пол: FF ' + fmt(F.FF, 1) + ' / FL ' + fmt(F.FL, 1) + ' — ' + ffClass(F.FF) + ', уклон ' + fmt(f.plane.mmPerM, 2) + ' мм/м, рейка 2 м: ' +
        (f.rail.n ? 'просвет больше ' + fmt(f.rail.tol, 0) + ' мм на ' + fmt(f.rail.over * 100, 0) + ' % мест, наибольший ' + fmt(f.rail.max, 1) + ' мм' : 'нет данных'));
    }
    if (res.walls && res.walls.ok) {
      var w = res.walls;
      out.push('Стены: проверено ' + w.checked + ', в допуске ' + (w.checked - w.bad) + ', вне допуска ' + w.bad +
        ' (вертикаль ' + w.walls.filter(function (x) { return !x.okPlumb; }).length + ', неровность ' + w.walls.filter(function (x) { return !x.okRail; }).length + ')');
    }
    if (res.level && res.level.ok && res.level.applied) out.push('Облако наклонено на ' + fmt(res.level.mm, 2) + ' мм/м (' + fmt(res.level.deg, 3) + '°) — наклон найден по стенам и вычтен');
    var nf = res.floor && res.floor.defects ? res.floor.defects.length : 0, nw = res.walls && res.walls.defects != null ? res.walls.defects : 0;
    if (res.floor && res.floor.defects || res.walls && res.walls.defects != null) out.push('Местные дефекты: на полу ' + nf + ', на стенах ' + nw);
    var op = res.openings && res.openings.ok ? res.openings : null;
    if (op && op.list.length) out.push('Проёмы: дверей ' + op.doors + ', окон ' + op.windows);
    return out;
  }
  // CSV (Excel): «;», десятичная запятая, BOM
  function csv(res, cmp) {
    var L = [], c = function (x, d) { return x === x && x != null && isFinite(x) ? (+x).toFixed(d).replace('.', ',') : ''; }, q = function (s) { return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; };
    if (res.floor && res.floor.ok) {
      var f = res.floor, F = f.F || {};
      L.push('Пол'); L.push('FF;FL;Уклон, мм/м;Направление уклона, °;Рейка 2 м: наибольший просвет, мм;Доля мест с просветом больше допуска, %;Площадь, м²');
      L.push([c(F.FF, 1), c(F.FL, 1), c(f.plane.mmPerM, 2), c(f.plane.downDir, 0), c(f.rail.max, 1), c(f.rail.over * 100, 1), c(f.area, 1)].join(';'));
      L.push(''); L.push('Помещение;Тип;Площадь, м²;FF;FL;Уклон, мм/м;Рейка: наибольший просвет, мм;Размах, мм');
      f.rooms.forEach(function (r) { L.push([q(r.name), r.kind === 'corridor' ? 'коридор' : 'помещение', c(r.area, 1), c(r.FF, 1), c(r.FL, 1), c(r.tilt, 2), c(r.railMax, 1), c(r.p2v, 1)].join(';')); });
      L.push('');
    }
    if (res.walls && res.walls.ok) {
      L.push('Стена;Начало X, м;Начало Y, м;Конец X, м;Конец Y, м;Длина, м;Высота проверки, м;Вертикаль, мм/м;Завал на высоту, мм;Наклон верха;Неровность СКО, мм;Рейка 2 м, мм;Шум, мм;Итог');
      res.walls.walls.forEach(function (w, i) {
        L.push([i + 1, c(w.a[0], 3), c(w.a[1], 3), c(w.b[0], 3), c(w.b[1], 3), c(w.length, 2), c(w.height, 2), c(w.plumb, 2), c(w.lean, 1), w.toward === 'room' ? 'в помещение' : w.toward === 'out' ? 'наружу' : '',
          c(w.rms, 1), c(w.rail, 1), c(w.noise, 1), w.ok ? 'в допуске' : 'вне допуска'].join(';'));
      });
      L.push('');
    }
    if (res.corners && res.corners.length) {
      L.push('Угол;X, м;Y, м;Угол, °;Отклонение от 90°, °;мм на 1 м');
      res.corners.forEach(function (k, i) { L.push([i + 1, c(k.at[0], 3), c(k.at[1], 3), c(k.angle, 2), c(k.dev, 2), c(k.mmPerM, 1)].join(';')); });
      L.push('');
    }
    var KN = { bump: 'бугор', dip: 'впадина', bulge: 'выступ', uneven: 'неровность', door: 'дверь', window: 'окно', closed: 'закрыт' };
    if (res.level && res.level.ok) {
      L.push('Наклон облака по стенам, мм/м;Наклон, °;Направление верха, ° от оси X;Стен;Погрешность, мм/м;Учтён');
      L.push([c(res.level.mm, 2), c(res.level.deg, 3), c(res.level.az, 0), res.level.n, c(res.level.se, 2), res.level.applied ? 'да' : 'нет'].join(';')); L.push('');
    }
    var dl = [];
    if (res.floor && res.floor.defects) res.floor.defects.forEach(function (d) { dl.push(['пол', q(d.room || ''), KN[d.kind] || d.kind, c(d.u, 2), c(d.v, 2), '', c(d.area, 2), c(d.depth, 1)]); });
    if (res.walls && res.walls.walls) res.walls.walls.forEach(function (w, i) { (w.defects || []).forEach(function (d) { dl.push(['стена ' + (i + 1), '', KN[d.kind] || d.kind, c(d.u, 2), c(d.v, 2), c(d.h, 2), c(d.area, 2), c(d.depth, 1)]); }); });
    if (dl.length) { L.push('Дефект;Помещение;Тип;X, м;Y, м;Высота над полом, м;Площадь, м²;Глубина, мм'); dl.forEach(function (r) { L.push(r.join(';')); }); L.push(''); }
    if (res.openings && res.openings.list && res.openings.list.length) {
      L.push('Проём;Тип;Начало X, м;Начало Y, м;Конец X, м;Конец Y, м;Ширина, м;Низ, м;Верх, м;Высота, м;Перемычка');
      res.openings.list.forEach(function (o, i) { L.push([i + 1, KN[o.kind] || o.kind, c(o.a[0], 3), c(o.a[1], 3), c(o.b[0], 3), c(o.b[1], 3), c(o.width, 2), o.kind === 'window' ? c(o.sill, 2) : o.kind === 'door' ? '0' : '', o.head != null ? c(o.head, 2) : '', o.height != null ? c(o.height, 2) : '', o.open ? 'нет' : o.kind === 'closed' ? '' : 'есть'].join(';')); });
      L.push('');
    }
    if (cmp && cmp.ok) {
      L.push('Линия проекта;Слой;Длина, м;Смещение, мм;Наибольшее, мм;Покрытие, %;Итог');
      cmp.lines.forEach(function (x, i) { L.push([i + 1, q(x.layer), c(x.length, 2), c(x.offset, 1), c(x.max, 1), c(x.cover * 100, 0), lineStatus(x, cmp.tol)].join(';')); });
    }
    return '\ufeff' + L.join('\r\n') + '\r\n';
  }

  var pure = { presets: presets, diverging: diverging, sequential: sequential, limitOf: limitOf, ffClass: ffClass, verdict: verdict, csv: csv, wallStatus: wallStatus, lineStatus: lineStatus };
  if (!D) return pure;

  // ------------------------------------------------------------------ запуск
  function bim() { return W.bimAPI || null; }
  function kit() { return W.__lxKit || null; }
  function ic(n, s) { var k = kit(); return k && k.ic ? k.ic(n, s || 15) : ''; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function toast(m, err) { var k = kit(); if (k && k.toast) { try { return k.toast(m, err ? { tone: 'err' } : undefined); } catch (_) {} } try { console.log('[inspect] ' + m); } catch (_) {} }
  function baseName(p) { return String(p || '').split(/[\\/]/).pop(); }
  function stem(p) { return baseName(p).replace(/\.[^.]+$/, ''); }
  function jobId() { return 'ins-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function ovRoute(ov) { var tr = ov && ov.trajectory; return tr && tr.route && tr.aligned !== false ? tr.route : null; }
  function joinPath(dir, name) { return dir ? String(dir).replace(/[\\/]+$/, '') + (String(dir).indexOf('\\') >= 0 ? '\\' : '/') + name : name; }
  var last = new Map();

  async function open(path, ov, st) {
    var A = bim(), k = kit(), CI = W.CloudInspect;
    if (!A || !A.cloudInspect || !k || !k.form || !CI) { toast('Контроль геометрии доступен в настольной версии', true); return null; }
    var CP = W.CloudPreview, floors = CP && CP.storeys ? CP.storeys(ov.levels, ov.bbox, ovRoute(ov)) : [];
    var cur = st && st.hf ? (floors.find(function (f) { return f.min <= st.hf.min + 0.2 && f.max >= st.hf.min; }) || floors[0]) : floors[0];
    var floorH = cur ? cur.floor : (ov.levels && ov.levels[0] ? ov.levels[0].h : (ov.bbox.core || ov.bbox).h0);
    var room = cur && cur.ceiling != null ? cur.ceiling - cur.floor : 3.2, topDef = Math.max(1, Math.round(Math.min(3, room - 0.15) * 20) / 20);
    var fields = [], isLas = /\.las$/i.test(String(path)), cleanInfo = null;
    // ревизия 32: сначала очистить облако (сведение проходов, люди, мусор) и проверять уже очищенное
    if (isLas && A.refineScan) {
      if (A.findCleanCloud) { try { var fc = await A.findCleanCloud(path); if (fc && fc.ok && fc.found) cleanInfo = fc; } catch (_) {} }
      var npt = ov && ov.file && ov.file.points || 0, mins = Math.max(1, Math.round(npt * REFINE_US / 6e7));
      var srcOpts = [{ value: 'clean', label: 'Сначала очистить: сведение проходов, люди, мусор' }, { value: 'raw', label: 'Исходное облако, как есть' }];
      if (cleanInfo) srcOpts.unshift({ value: 'found', label: 'Очищенное ранее: ' + cleanInfo.name });
      fields.push({ key: 'src', label: 'Облако для контроля', type: 'select', value: cleanInfo ? 'found' : 'clean', options: srcOpts,
        hint: 'Очистка пишет рядом новый файл «' + stem(path) + '-inspect.las», исходник не меняется' + (npt ? '; около ' + mins + ' мин для ' + fmt(npt / 1e6, 0) + ' млн точек' : '') + '. Мусор, люди и двоение стен от дрейфа сканера иначе завышают неровность; поверхности не сглаживаются, план стен берётся по исходному облаку.' });
    }
    if (floors.length > 1) fields.push({ key: 'floor', label: 'Этаж', type: 'select', value: String(Math.max(0, floors.indexOf(cur))), options: floors.map(function (f, i) { return { value: String(i), label: f.name + ' (пол +' + fmt(f.floor, 2) + ' м)' }; }) });
    fields.push(
      { key: 'doFloor', label: 'Пол: FF/FL, уклон, рейка 2 м', type: 'checkbox', value: true },
      { key: 'floorRail', label: 'Просвет под рейкой пола', type: 'number', value: 4, step: 0.5, min: 0.5, max: 50, unit: 'мм', hint: 'СП 71.13330: стяжка, плитка — 4 мм; линолеум, паркет — 2 мм', showIf: function (v) { return v.doFloor; } },
      { key: 'doWalls', label: 'Стены: вертикаль и неровность', type: 'checkbox', value: true },
      { key: 'cls', label: 'Класс отделки стен', type: 'select', value: 'improved', options: Object.keys(PRESETS).map(function (x) { var p = PRESETS[x]; return { value: x, label: p.label + ' — ' + p.plumbPerM + ' мм/м, до ' + p.plumbMax + ' мм, рейка ' + p.wallRail + ' мм' }; }), showIf: function (v) { return v.doWalls; } },
      { key: 'top', label: 'Проверять стены до', type: 'number', value: topDef, step: 0.05, min: 0.6, max: 12, unit: 'м над полом', showIf: function (v) { return v.doWalls; } },
      { key: 'hc', label: 'Срез для поиска стен', type: 'number', value: 1.2, step: 0.05, min: 0.3, max: 3, unit: 'м над полом' },
      { key: 'furn', label: 'Не считать мебель стенами (второй срез)', type: 'checkbox', value: true },
      { key: 'level', label: 'Выровнять облако по стенам (убрать наклон сканера)', type: 'checkbox', value: true, hint: 'Наклон находится по завалу всех стен; если он заметен, поправка вносится в вертикаль стен, уклон и FL пола' },
      { key: 'defects', label: 'Дефекты пола и стен, проёмы с высотами', type: 'checkbox', value: true });
    if (st && st.rect) fields.push({ key: 'onlyRect', label: 'Только область с карты', type: 'checkbox', value: true });
    var v = await k.form({ title: 'Контроль геометрии', wide: true, className: 'lx-compact', okLabel: 'Проверить',
      message: (cur ? cur.name + ': пол +' + fmt(floorH, 2) + ' м' + (cur.ceiling != null ? ', перекрытие +' + fmt(cur.ceiling, 2) + ' м' : '') : 'Этажи не найдены — пол по низу облака') +
        '. Два прохода по файлу; облако на экран не загружается.', fields: fields });
    if (!v) return null;
    if (!v.doFloor && !v.doWalls) { toast('Выберите пол или стены', true); return null; }
    var f = floors.length > 1 ? floors[+v.floor] || cur : cur || { name: 'Этаж 1', floor: floorH };
    var P = PRESETS[v.cls] || PRESETS.improved, tol = { floorRail: v.floorRail > 0 ? v.floorRail : 4, wallRail: P.wallRail, plumbPerM: P.plumbPerM, plumbMax: P.plumbMax };
    var h0 = f.floor + v.hc - 0.05, h1 = f.floor + v.hc + 0.05, hi = v.furn ? highBand(f, h1) : null, top = f.floor + (v.top > 0 ? v.top : topDef);
    var src = path, prep = null, t0 = Date.now();
    if (v.src === 'found' && cleanInfo) { src = cleanInfo.path; prep = { name: cleanInfo.name, reused: true }; }
    else if (v.src === 'clean') {
      var cr = await cleanFirst(A, path);
      if (!cr) return null;
      if (!cr.ok) { if (!cr.cancelled) toast('Очистка не выполнена: ' + (cr.message || cr.error || 'ошибка') + '. Контроль — по исходному облаку.', true); else return null; }
      else { src = cr.path; prep = { name: cr.name, stats: cr.stats || {}, trajectory: cr.trajectory || null, dynWarning: cr.dynWarning || null, seconds: (Date.now() - t0) / 1000 }; }
    }
    var id = jobId(), act = k.activity ? k.activity('Контроль геометрии…') : null;
    var off = A.onCloudPlanProgress ? A.onCloudPlanProgress(id, function (p, l) { if (act) act.set(p, l ? 'Контроль: ' + String(l).toLowerCase() : null); }) : function () {};
    var r;
    try {
      r = await A.cloudInspect({ path: src, frameFrom: src !== path ? path : null, level: v.level !== false, defects: v.defects !== false, openings: v.defects !== false, jobId: id, h0: h0, h1: h1, hi0: hi ? hi[0] : null, hi1: hi ? hi[1] : null, hiBands: hi ? hi[2] : null, floor: f.floor, top: top, tol: tol,
        floorCheck: !!v.doFloor, wallCheck: !!v.doWalls, rect: v.onlyRect && st && st.rect ? st.rect : null, plan: { lowFilter: v.furn ? undefined : false } });
    } catch (e) { r = { ok: false, message: String((e && e.message) || e) }; }
    finally { off(); if (act) act.done(); }
    if (!r || !r.ok) { if (!(r && r.cancelled)) toast('Контроль не выполнен: ' + ((r && r.message) || 'нет данных'), true); return null; }
    r.storey = f; r.cls = v.cls; r.elapsed = (Date.now() - t0) / 1000; r.fileName = baseName(path); r.prep = prep;
    last.set(path, r);
    show(path, ov, r);
    return r;
  }
  // очистка перед контролем: «Чистовая обработка» в новый файл рядом (без диалога), окно прогресса с отменой
  var REFINE_US = 2.5;   // мкс на точку: замер — 175,6 млн точек за 6,5 мин на 2 ядрах (люди, мусор, сведение проходов; без цвета и утончения)
  async function cleanFirst(A, path) {
    var rid = 'insclean' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36), T = W.__pcTools, stop = null, act = null, off = null, res = null;
    var set = function (f, l) { var t = 'Очистка облака: ' + String(l || 'обработка').replace(/…$/, '').toLowerCase(); if (stop && stop.set) stop.set(f, t); else if (act) act.set(f, t); };
    if (T && T.beginProgress) stop = T.beginProgress('Очистка облака перед контролем…', { onCancel: function () { try { A.cancelRefineScan && A.cancelRefineScan(rid); } catch (_) {} } });
    else if (kit() && kit().activity) act = kit().activity('Очистка облака перед контролем…');
    try {
      if (A.onRefineScanProgress) off = A.onRefineScanProgress(rid, set);
      // ревизия 32: для измерений — только удаление мусора и людей и сведение проходов; без «утончения» поверхностей (сдвиг точек на
      // местную плоскость сглаживает неровность и дефекты), без порога от общей плотности (съедает редкие дальние комнаты) и без цвета
      res = await A.refineScan({ path: path, jobId: rid, autoOut: true, dynamic: true, noise: true, noiseLevel: 'inspect', thin: false, align: true, color: false, colorBalance: false, photo: false });
    } catch (e) { res = { ok: false, message: String((e && e.message) || e) }; }
    finally { if (off) { try { off(); } catch (_) {} } if (stop) { try { stop(); } catch (_) {} } if (act) act.done(); }
    return res;
  }
  function highBand(f, h1) {
    var a = h1 + 0.05, b = f.floor + 2.45;
    if (f.ceiling != null && f.ceiling - f.floor > 1.5) b = Math.min(b, f.ceiling - 0.15);
    if (b - a < 0.3) return null;
    return [a, b, Math.max(2, Math.min(8, Math.round((b - a) / 0.13)))];
  }

  // ------------------------------------------------------------------ карта: plane | level | walls | dxf; light — для PDF
  function heatCanvas(rep, key, lim) {
    var g = rep.grid, m = rep.maps[key], c = D.createElement('canvas'); c.width = g.nx; c.height = g.ny;
    var x2 = c.getContext('2d'), img = x2.createImageData(g.nx, g.ny), px = img.data;
    for (var y = 0; y < g.ny; y++) for (var x = 0; x < g.nx; x++) {
      var k = y * g.nx + x, o = ((g.ny - 1 - y) * g.nx + x) * 4, col = g.flag[k] === 1 ? diverging(m[k], lim) : g.flag[k] === 2 ? [90, 96, 106] : null;
      if (!col) continue; px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = 255;
    }
    x2.putImageData(img, 0, 0);
    return c;
  }
  function wallColor(w, light) { var s = wallStatus(w); return s === 'ok' ? (light ? '#15803d' : '#4ade80') : s === 'rail' ? (light ? '#b45309' : '#fbbf24') : (light ? '#b91c1c' : '#f87171'); }
  function drawMap(ctx, Wd, Ht, S, view, mode, opt) {
    opt = opt || {};
    var light = !!opt.light, res = S.res, plan = res.plan, sc = view.s, i;
    var X = function (u) { return Wd / 2 + (u - view.cx) * sc; }, Y = function (v) { return Ht / 2 - (v - view.cy) * sc; };
    ctx.fillStyle = light ? '#ffffff' : '#0c0e12'; ctx.fillRect(0, 0, Wd, Ht);
    var pv = res.slice && res.slice.preview, showFloor = (mode === 'plane' || mode === 'level' || mode === 'def') && res.floor && res.floor.ok, hk = mode === 'def' ? 'plane' : mode;
    if (showFloor) {
      var g = res.floor.grid, cv = S.heat[hk] || (S.heat[hk] = heatCanvas(res.floor, hk, S.lim[hk]));
      if (mode === 'def') ctx.globalAlpha = 0.45;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(cv, X(g.u0), Y(g.v0 + g.ny * g.cell), g.nx * g.cell * sc, g.ny * g.cell * sc);
      ctx.globalAlpha = 1;
    }
    // точки среза: серые; в режиме «Проект» — цвет по расстоянию до линии проекта
    if (pv) {
      var n = pv.length >> 1, cmp = mode === 'dxf' ? S.cmp : null, step = Math.max(1, Math.floor(n / (cmp ? 200000 : showFloor ? 40000 : 120000)));
      var gray = showFloor ? (light ? 'rgba(15,23,42,0.55)' : 'rgba(230,232,236,0.5)') : (light ? 'rgba(51,65,85,0.5)' : 'rgba(170,176,186,0.55)'), dot = Math.max(1, Math.min(2, sc * 0.02));
      ctx.fillStyle = gray;
      for (i = 0; i < n; i += step) {
        if (cmp) { var dv = cmp.dev[i], col = dv === dv ? sequential(dv, cmp.tol * 1000) : null; ctx.fillStyle = col ? 'rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')' : (light ? 'rgba(100,116,139,0.35)' : 'rgba(120,126,136,0.35)'); }
        ctx.fillRect(X(pv[i * 2]), Y(pv[i * 2 + 1]), dot, dot);
      }
    }
    var faces = plan && plan.ok ? plan.faces : [], byFace = {};
    if (res.walls && res.walls.walls) res.walls.walls.forEach(function (w, wi) { byFace[w.face] = wi; });
    ctx.lineCap = 'round';
    if (mode !== 'dxf') {
      faces.forEach(function (f, fi) {
        var wi = byFace[fi], w = wi != null ? res.walls.walls[wi] : null, sel = wi != null && wi === S.selWall;
        ctx.strokeStyle = w ? wallColor(w, light) : (light ? 'rgba(71,85,105,0.7)' : 'rgba(148,156,168,0.6)');
        if (mode === 'open') ctx.strokeStyle = light ? 'rgba(71,85,105,0.8)' : 'rgba(148,156,168,0.7)';
        ctx.lineWidth = sel ? 5 : w && mode === 'walls' ? 2.5 : 1.2;
        ctx.beginPath(); ctx.moveTo(X(f.a[0]), Y(f.a[1])); ctx.lineTo(X(f.b[0]), Y(f.b[1])); ctx.stroke();
      });
    } else if (S.cmp) {
      S.cmp.segs.forEach(function (s, si) {
        var stt = lineStatus(S.cmp.lines[si], S.cmp.tol);
        ctx.strokeStyle = stt === 'нет в облаке' ? (light ? '#b91c1c' : '#f87171') : stt === 'смещена' ? (light ? '#b45309' : '#fbbf24') : (light ? '#1d4ed8' : '#60a5fa');
        ctx.lineWidth = si === S.selLine ? 4 : 1.5; ctx.setLineDash(stt === 'нет в облаке' ? [5, 4] : []);
        ctx.beginPath(); ctx.moveTo(X(s.a[0]), Y(s.a[1])); ctx.lineTo(X(s.b[0]), Y(s.b[1])); ctx.stroke();
      });
      ctx.setLineDash([]);
    }
    // помещения: название и FF / уклон
    if (mode === 'open' && res.openings && res.openings.list) drawOpenings(ctx, res.openings.list, X, Y, sc, light, S.selOpen);
    if (mode === 'def') drawDefects(ctx, res, X, Y, light, S.selDef);
    if (showFloor && mode !== 'def' && res.floor.rooms && sc > 6) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var boxes = [];
      // крупные помещения первыми; подпись, которая налезает на уже поставленную, не рисуем (видна при увеличении)
      res.floor.rooms.slice().sort(function (a, b) { return b.area - a.area; }).forEach(function (r) {
        if (!r.center) return; var x = X(r.center[0]), y = Y(r.center[1]);
        var t2 = mode === 'plane' ? 'FF ' + fmt(r.FF, 0) + ' · FL ' + fmt(r.FL, 0) : 'уклон ' + fmt(r.tilt, 1) + ' мм/м';
        ctx.font = '600 11px system-ui, sans-serif'; var bw = Math.max(ctx.measureText(r.name).width, ctx.measureText(t2).width) / 2 + 4;
        var bx = [x - bw, y - 15, x + bw, y + 15];
        if (bx[2] < 0 || bx[0] > Wd || bx[3] < 0 || bx[1] > Ht) return;
        if (boxes.some(function (o) { return bx[0] < o[2] && bx[2] > o[0] && bx[1] < o[3] && bx[3] > o[1]; })) return;
        boxes.push(bx);
        ctx.lineWidth = 3; ctx.strokeStyle = light ? 'rgba(255,255,255,0.9)' : 'rgba(12,14,18,0.8)'; ctx.fillStyle = light ? '#0f172a' : '#f1f5f9';
        ctx.font = '600 11px system-ui, sans-serif'; ctx.strokeText(r.name, x, y - 7); ctx.fillText(r.name, x, y - 7);
        ctx.font = '10.5px system-ui, sans-serif'; ctx.strokeText(t2, x, y + 7); ctx.fillText(t2, x, y + 7);
      });
    }
    // худшие места под рейкой пола
    if (mode === 'plane' && showFloor && res.floor.rail && res.floor.rail.worst) {
      ctx.strokeStyle = light ? '#0f172a' : '#ffffff'; ctx.lineWidth = 1.5;
      res.floor.rail.worst.slice(0, 30).forEach(function (p) { if (p.gap <= res.floor.rail.tol) return; ctx.beginPath(); ctx.arc(X(p.u), Y(p.v), 5, 0, Math.PI * 2); ctx.stroke(); });
    }
    var m = 1; [1, 2, 5, 10, 20, 50].forEach(function (k) { if (k * sc <= 140) m = k; });
    ctx.fillStyle = light ? '#0f172a' : '#e5e7eb'; ctx.fillRect(14, Ht - 18, m * sc, 2); ctx.font = '10.5px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(m + ' м', 14, Ht - 22);
  }
  // проёмы: дверь — зелёный, окно — голубой, без перемычки — пунктир; подпись — высота (окно: подоконник–верх)
  var KIND = { door: 'дверь', window: 'окно', closed: 'закрыт', bump: 'бугор', dip: 'впадина', bulge: 'выступ', uneven: 'неровность' };
  function openLabel(o) { return o.kind === 'door' ? (o.head != null ? fmt(o.head, 2) : 'без перемычки') : o.kind === 'window' ? fmt(o.sill, 2) + '–' + (o.head != null ? fmt(o.head, 2) : '…') : 'закрыт'; }
  function drawOpenings(ctx, list, X, Y, sc, light, sel) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '600 10.5px system-ui, sans-serif';
    list.forEach(function (o, i) {
      var col = o.kind === 'door' ? (light ? '#15803d' : '#4ade80') : o.kind === 'window' ? (light ? '#0369a1' : '#38bdf8') : (light ? '#64748b' : '#94a3b8');
      ctx.strokeStyle = col; ctx.lineWidth = i === sel ? 6 : 4; ctx.setLineDash(o.open || o.kind === 'closed' ? [4, 3] : []);
      ctx.beginPath(); ctx.moveTo(X(o.a[0]), Y(o.a[1])); ctx.lineTo(X(o.b[0]), Y(o.b[1])); ctx.stroke();
      if (sc > 9) {
        var x = (X(o.a[0]) + X(o.b[0])) / 2, y = (Y(o.a[1]) + Y(o.b[1])) / 2 - 10, t = (i + 1) + ': ' + openLabel(o);
        ctx.setLineDash([]); ctx.lineWidth = 3; ctx.strokeStyle = light ? 'rgba(255,255,255,0.9)' : 'rgba(12,14,18,0.85)'; ctx.strokeText(t, x, y); ctx.fillStyle = col; ctx.fillText(t, x, y);
      }
    });
    ctx.setLineDash([]);
  }
  // дефекты: бугор / выступ — красный, впадина — синий; пол — кружки, стены — квадраты; размер — по площади
  function defectList(res) {
    var L = [];
    if (res.floor && res.floor.defects) res.floor.defects.forEach(function (d) { L.push({ where: 'floor', d: d, room: d.room || '' }); });
    if (res.walls && res.walls.walls) res.walls.walls.forEach(function (w, wi) { (w.defects || []).forEach(function (d) { L.push({ where: 'wall', wall: wi, d: d, room: 'стена ' + (wi + 1) }); }); });
    L.sort(function (a, b) { return b.d.depth - a.d.depth; });
    return L;
  }
  function drawDefects(ctx, res, X, Y, light, sel) {
    var L = res._defs || (res._defs = defectList(res));
    L.forEach(function (x, i) {
      var d = x.d, up = d.kind === 'bump' || d.kind === 'bulge', r = clamp(3 + Math.sqrt(d.area) * 8, 4, 10), px = X(d.u), py = Y(d.v);
      ctx.fillStyle = up ? (light ? '#dc2626' : '#f87171') : (light ? '#2563eb' : '#60a5fa'); ctx.strokeStyle = light ? '#0f172a' : '#ffffff'; ctx.lineWidth = i === sel ? 2.5 : 1;
      ctx.beginPath(); if (x.where === 'wall') ctx.rect(px - r, py - r, 2 * r, 2 * r); else ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    });
  }
  function fitView(S, Wd, Ht) {
    var b = null, res = S.res;
    if (res.floor && res.floor.ok) { var g = res.floor.grid; b = [g.u0, g.v0, g.u0 + g.nx * g.cell, g.v0 + g.ny * g.cell]; }
    if (res.plan && res.plan.ok && res.plan.bbox) { var p = res.plan.bbox; b = b ? [Math.min(b[0], p.u0), Math.min(b[1], p.v0), Math.max(b[2], p.u1), Math.max(b[3], p.v1)] : [p.u0, p.v0, p.u1, p.v1]; }
    if (!b && res.rect) b = [res.rect.u0, res.rect.v0, res.rect.u1, res.rect.v1];
    if (!b) b = [-10, -10, 10, 10];
    var s = Math.min((Wd - 40) / Math.max(0.5, b[2] - b[0]), (Ht - 40) / Math.max(0.5, b[3] - b[1]));
    return { s: s, cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2 };
  }
  function legend(ctx, Wd, Ht, S, mode, light) {
    var lim = mode === 'dxf' ? (S.cmp ? S.cmp.tol * 1000 : 0) : S.lim[mode === 'def' ? 'plane' : mode];
    if (!(lim > 0)) return;
    var x0 = Wd - 214, y0 = Ht - (light ? 30 : 56), w = 180, i;
    ctx.fillStyle = light ? 'rgba(255,255,255,0.9)' : 'rgba(12,14,18,0.75)'; ctx.fillRect(x0 - 10, y0 - 18, w + 24, 40);
    for (i = 0; i < w; i++) { var t = i / (w - 1), col = mode === 'dxf' ? sequential(t * 3 * lim, lim) : diverging((t * 2 - 1) * lim, lim); ctx.fillStyle = 'rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')'; ctx.fillRect(x0 + i, y0, 1, 8); }
    ctx.fillStyle = light ? '#0f172a' : '#e5e7eb'; ctx.font = '10px system-ui, sans-serif'; ctx.textBaseline = 'top';
    var labs = mode === 'dxf' ? [['0', 0], [fmt(lim, 0), w / 3], [fmt(3 * lim, 0) + ' мм', w]] : [['−' + fmt(lim, 0), 0], ['0', w / 2], ['+' + fmt(lim, 0) + ' мм', w]];
    labs.forEach(function (l, k) { ctx.textAlign = k === 0 ? 'left' : k === 1 ? 'center' : 'right'; ctx.fillText(l[0], x0 + l[1], y0 + 10); });
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(mode === 'plane' ? 'от средней плоскости пола' : mode === 'level' ? 'от горизонтали' : 'расстояние до линии проекта', x0, y0 - 3);
  }
  function mapImage(S, mode, w) {
    var h = Math.round(w * 0.62), c = D.createElement('canvas'); c.width = w; c.height = h;
    var ctx = c.getContext('2d'), view = fitView(S, w, h);
    drawMap(ctx, w, h, S, view, mode, { light: true }); legend(ctx, w, h, S, mode, true);
    return c.toDataURL('image/png');
  }
  // развёртка стены: остатки от плоскости, мм (красный — выступ в помещение, если сторона известна, иначе по нормали грани; синий — впадина)
  function wallImage(w, lim, light, cw) {
    var g = w.grid, c = D.createElement('canvas'), sx = Math.max(2, Math.floor((cw || 276) / g.nt)); c.width = g.nt * sx; c.height = g.nh * sx;
    var x2 = c.getContext('2d'); x2.fillStyle = light ? '#f1f5f9' : '#16181d'; x2.fillRect(0, 0, c.width, c.height);
    for (var it = 0; it < g.nt; it++) for (var ih = 0; ih < g.nh; ih++) {
      var v = g.res[it * g.nh + ih]; if (!(v === v)) continue; var col = diverging((w.side === -1 ? -1 : 1) * v, lim);
      x2.fillStyle = 'rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')'; x2.fillRect(it * sx, (g.nh - 1 - ih) * sx, sx, sx);
    }
    // местные дефекты — рамки
    (w.defects || []).forEach(function (d) {
      x2.strokeStyle = light ? '#0f172a' : '#ffffff'; x2.lineWidth = 1.5;
      x2.strokeRect(d.x0 * sx + 0.5, (g.nh - 1 - d.y1) * sx + 0.5, (d.x1 - d.x0 + 1) * sx - 1, (d.y1 - d.y0 + 1) * sx - 1);
    });
    return c;
  }
  function segDist(u, v, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, t = L2 ? clamp(((u - a[0]) * dx + (v - a[1]) * dy) / L2, 0, 1) : 0;
    return Math.hypot(u - a[0] - t * dx, v - a[1] - t * dy);
  }

  // ------------------------------------------------------------------ окно результатов
  function show(path, ov, res) {
    var k = kit(), back = D.createElement('div'); back.className = 'modal bp-modal ins-modal';
    var S = { res: res, lim: {}, heat: {}, selWall: -1, selLine: -1, selDef: -1, selOpen: -1, cmp: null, dxfName: '', dxfText: '' };
    var f = res.floor, wr = res.walls, hasF = !!(f && f.ok), hasW = !!(wr && wr.ok && wr.walls.length);
    if (hasF) { S.lim.plane = limitOf(f.maps.plane); S.lim.level = limitOf(f.maps.level); }
    var secs = res.elapsed || (res.times && res.times.total / 1000) || 0;
    var sub = (res.storey ? res.storey.name + ' · ' : '') + 'пол +' + fmt(res.floorH, 2) + ' м' + (hasW ? ' · стены до +' + fmt(res.top, 2) + ' м' : '') + (res.prep ? ' · очищенное облако' : '') + ' · ' + fmt(secs, 0) + ' с';
    var defs = res._defs || (res._defs = defectList(res)), ops = res.openings && res.openings.ok ? res.openings.list : [], hasD = !!((f && f.defects) || (wr && wr.defects != null)), hasO = ops.length > 0;
    var modes = [];
    if (hasF) modes.push(['plane', 'Ровность пола'], ['level', 'Уровень пола']);
    modes.push(['walls', 'Стены']);
    if (hasD) modes.push(['def', 'Дефекты']);
    if (hasO) modes.push(['open', 'Проёмы']);
    modes.push(['dxf', 'Проект']);
    back.innerHTML =
      '<div class="modal-card bp-card ins-card" role="dialog" aria-modal="true" aria-labelledby="insTitle">' +
      '<div class="modal-head"><span id="insTitle">Контроль геометрии</span><span class="bp-headsub">' + esc(sub) + '</span><button type="button" class="x" data-ico="x" aria-label="Закрыть"></button></div>' +
      '<div class="bp-body"><div class="bp-mapcol"><div class="bp-map ins-map"><canvas></canvas>' +
        '<div class="bp-over bp-tl"><div class="bp-seg" role="group" aria-label="Карта">' + modes.map(function (m) { return '<button type="button" data-mode="' + m[0] + '">' + m[1] + '</button>'; }).join('') + '</div></div>' +
        '<div class="bp-maphint">колесо — масштаб, перетаскивание — сдвиг, щелчок по стене — развёртка</div></div></div>' +
      '<div class="bp-side ins-side"><div class="bp-tabs" role="tablist">' + (hasF ? '<button type="button" data-tab="floor">Пол</button>' : '') +
        '<button type="button" data-tab="walls">Стены</button>' + (hasD ? '<button type="button" data-tab="def">Дефекты</button>' : '') + (hasO ? '<button type="button" data-tab="open">Проёмы</button>' : '') +
        '<button type="button" data-tab="dxf">Проект</button></div>' +
        '<div class="bp-pane" data-pane="floor"></div><div class="bp-pane" data-pane="walls" hidden></div><div class="bp-pane" data-pane="def" hidden></div><div class="bp-pane" data-pane="open" hidden></div><div class="bp-pane" data-pane="dxf" hidden></div></div></div>' +
      '<div class="form-actions bp-actions"><button type="button" class="btn sm ghost" data-act="csv" title="Таблицы пола, стен, углов и проекта для Excel">' + ic('file-text') + ' CSV</button>' +
        '<button type="button" class="btn sm ghost" data-act="pdf" title="PDF-отчёт контроля геометрии">' + ic('clipboard-check') + ' PDF-отчёт</button>' +
        '<div class="bp-est ins-verdict"></div><button type="button" class="btn sm primary" data-act="close">Закрыть</button></div></div>';
    var q = function (s) { return back.querySelector(s); }, cv = q('.ins-map canvas'), mapEl = q('.ins-map');
    var mode = hasF ? 'plane' : 'walls', view = null;
    var vt = []; if (hasF) vt.push('Пол: FF ' + fmt(f.F.FF, 0) + ' / FL ' + fmt(f.F.FL, 0)); if (hasW) vt.push('стены: ' + (wr.checked - wr.bad) + ' из ' + wr.checked + ' в допуске');
    q('.ins-verdict').textContent = vt.join(' · ');
    function paint() {
      var r = mapEl.getBoundingClientRect(), dpr = W.devicePixelRatio || 1, Wd = Math.max(50, r.width), Ht = Math.max(50, r.height);
      cv.width = Math.round(Wd * dpr); cv.height = Math.round(Ht * dpr); cv.style.width = Wd + 'px'; cv.style.height = Ht + 'px';
      if (!view) view = fitView(S, Wd, Ht);
      var ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawMap(ctx, Wd, Ht, S, view, mode, {}); legend(ctx, Wd, Ht, S, mode, false);
      back.querySelectorAll('[data-mode]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === mode); });
    }
    function setTab(t) {
      back.querySelectorAll('[data-tab]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === t); });
      back.querySelectorAll('[data-pane]').forEach(function (p) { p.hidden = p.getAttribute('data-pane') !== t; });
    }
    function setMode(m) { mode = m; setTab(m === 'plane' || m === 'level' ? 'floor' : m); paint(); }
    back.querySelectorAll('[data-mode]').forEach(function (b) { b.onclick = function () { setMode(b.getAttribute('data-mode')); }; });
    back.querySelectorAll('[data-tab]').forEach(function (b) { b.onclick = function () { var t = b.getAttribute('data-tab'); if (t === 'floor') setMode(mode === 'level' ? 'level' : 'plane'); else setMode(t); }; });
    cv.addEventListener('wheel', function (e) {
      e.preventDefault(); if (!view) return;
      var r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, u = view.cx + (mx - r.width / 2) / view.s, v = view.cy - (my - r.height / 2) / view.s;
      view.s = clamp(view.s * Math.exp(-e.deltaY * 0.0015), 0.5, 2000); view.cx = u - (mx - r.width / 2) / view.s; view.cy = v + (my - r.height / 2) / view.s; paint();
    }, { passive: false });
    var drag = null;
    cv.addEventListener('mousedown', function (e) { if (view) drag = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false }; });
    function mv(e) { if (!drag) return; var dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; if (drag.moved) { view.cx = drag.cx - dx / view.s; view.cy = drag.cy + dy / view.s; paint(); } }
    function up(e) {
      if (!drag) return; var d = drag; drag = null; if (d.moved) return;
      var r = cv.getBoundingClientRect(), u = view.cx + (e.clientX - r.left - r.width / 2) / view.s, v = view.cy - (e.clientY - r.top - r.height / 2) / view.s, best = -1, bd = 10 / view.s;
      if (mode === 'dxf') { if (S.cmp) { S.cmp.segs.forEach(function (s, si) { var dd = segDist(u, v, s.a, s.b); if (dd < bd) { bd = dd; best = si; } }); if (best >= 0) { S.selLine = best; fillDxf(); paint(); } } return; }
      if (hasW) wr.walls.forEach(function (w, wi) { var dd = segDist(u, v, w.a, w.b); if (dd < bd) { bd = dd; best = wi; } });
      if (best >= 0) { mode = 'walls'; setTab('walls'); selectWall(best); }
    }
    D.addEventListener('mousemove', mv); D.addEventListener('mouseup', up);
    function kpis(list) { return '<div class="bp-kpis">' + list.map(function (x) { return '<div class="bp-kpi' + (x[2] ? ' ' + x[2] : '') + '"><b>' + esc(x[0]) + '</b><span title="' + esc(x[1]) + '">' + esc(x[1]) + '</span></div>'; }).join('') + '</div>'; }
    function facts(rows) { return '<table class="bp-facts">' + rows.map(function (r) { return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>'; }
    // ---- «Пол»
    if (hasF) {
      var F = f.F || {}, rl = f.rail, noiseTxt = f.FFnoise > 500 ? 'выше 500' : fmt(f.FFnoise, 0), rows = '';
      f.rooms.forEach(function (r) {
        rows += '<tr' + (r.railMax > rl.tol ? ' class="bad"' : '') + '><td>' + esc(r.name) + '</td><td>' + fmt(r.area, 1) + '</td><td>' + (r.enough ? fmt(r.FF, 0) : '<i title="мало замеров">' + fmt(r.FF, 0) + '</i>') +
          '</td><td>' + fmt(r.FL, 0) + '</td><td>' + fmt(r.tilt, 1) + '</td><td' + (r.railMax > rl.tol ? ' class="hl"' : '') + '>' + fmt(r.railMax, 1) + '</td></tr>';
      });
      var html = kpis([[fmt(F.FF, 1), 'FF — плоскостность'], [fmt(F.FL, 1), 'FL — горизонтальность'], [fmt(f.plane.mmPerM, 2) + ' мм/м', 'уклон (' + fmt(f.plane.deg, 3) + '°)'],
        [rl.n ? fmt(rl.max, 1) + ' мм' : '—', 'рейка 2 м, макс. просвет', rl.n && rl.max > rl.tol ? 'bad' : '']]);
      html += '<section><h4>Пол по ASTM E1155</h4>' + facts([['Класс по FF', ffClass(F.FF)], ['Замеров', fmt(F.readings, 0) + (F.enough ? '' : ' — мало для оценки')], ['FF без шума сканера', fmt(F.FFcorr, 1)],
        ['Предел FF по шуму', noiseTxt], ['От плоскости (1–99 %)', fmt(f.flat.p1, 1) + ' … +' + fmt(f.flat.p99, 1) + ' мм'], ['По высоте (1–99 %)', fmt(f.level.p1, 1) + ' … +' + fmt(f.level.p99, 1) + ' мм'],
        ['Уклон вниз — в сторону', fmt(f.plane.downDir, 0) + '° от оси X'],
        ['Рейка: просвет > ' + fmt(rl.tol, 0) + ' мм', rl.n ? fmt(rl.over * 100, 1) + ' % из ' + fmt(rl.n, 0) + ' мест (95 %: ' + fmt(rl.p95, 1) + ' мм)' : '—'],
        ['Площадь в проверке', fmt(f.area, 1) + ' м² (клетки ' + fmt(f.cell * 100, 1) + ' см)'], ['Предметы на полу', fmt(f.objects * f.cell * f.cell, 1) + ' м² — исключены'],
        ['Наклон облака (по стенам)', levelText(res.level)], ['Облако', prepText(res.prep) + (res.planFrom === 'source' ? '; стены и помещения — по исходному' : '')]]) + '</section>';
      if (rows) html += '<section><h4>По помещениям</h4><table class="ins-tab"><tr><th>Помещение</th><th>м²</th><th>FF</th><th>FL</th><th>мм/м</th><th>Рейка</th></tr>' + rows + '</table></section>';
      html += '<section><p class="bp-note">FF/FL — оценка по облаку, не замена сертифицированного замера профилографом. Шум сканера занижает FF: предел по шуму — ' + noiseTxt + '.</p></section>';
      q('[data-pane="floor"]').innerHTML = html;
    }
    // ---- «Стены»
    var order = hasW ? wr.walls.map(function (w, i) { return i; }).sort(function (a, b) { var A2 = wr.walls[a], B2 = wr.walls[b]; return (A2.ok - B2.ok) || (B2.lean - A2.lean); }) : [];
    function wallsPane() {
      var el = q('[data-pane="walls"]');
      if (!hasW) { el.innerHTML = '<section><p class="bp-note">' + esc(wr && wr.message ? wr.message : res.plan && res.plan.ok ? 'Нет граней стен длиннее 1 м с достаточным покрытием точками.' : 'Стены не найдены в срезе.') + '</p></section>'; return; }
      var t = wr.tol, cn = res.corners || [], rows = '';
      order.forEach(function (wi) {
        var w = wr.walls[wi], s = wallStatus(w);
        rows += '<tr data-w="' + wi + '" class="' + (s === 'ok' ? '' : 'bad') + '"><td>' + (wi + 1) + '</td><td>' + fmt(w.length, 2) + '</td><td' + (w.okPlumb ? '' : ' class="hl"') + '>' + fmt(w.plumb, 1) + '</td><td>' + fmt(w.lean, 0) +
          '</td><td' + (w.okRail ? '' : ' class="hl"') + '>' + fmt(w.rail, 1) + '</td><td>' + ic(s === 'ok' ? 'check' : 'activity', 13) + '</td></tr>';
      });
      var cd = cn.map(function (x) { return x.dev; });
      el.innerHTML = kpis([[String(wr.checked), 'стен проверено'], [String(wr.bad), 'вне допуска', wr.bad ? 'bad' : ''], [fmt(median(wr.walls.map(function (w) { return w.plumb; })), 2) + ' мм/м', 'вертикаль, медиана'],
          [fmt(median(wr.walls.map(function (w) { return w.rail; })), 1) + ' мм', 'рейка 2 м, медиана']]) +
        '<section class="ins-dev" hidden></section>' +
        '<section><h4>Стены (худшие сверху)</h4><table class="ins-tab ins-walls"><tr><th>№</th><th>Длина</th><th>мм/м</th><th>Завал</th><th>Рейка</th><th></th></tr>' + rows + '</table></section>' +
        '<section><h4>Допуски и углы</h4>' + facts([['Вертикаль', t.plumbPerM + ' мм на 1 м, не более ' + t.plumbMax + ' мм на высоту'], ['Неровность (рейка 2 м)', 'не более ' + t.rail + ' мм'],
          ['Сторона помещения', wr.sided ? 'по маршруту сканера у ' + plural(wr.sided, 'грани', 'граней', 'граней') : 'не определена — берётся больший просвет'],
          ['Углы 90°', cn.length ? plural(cn.length, 'угол', 'угла', 'углов') + ', медиана ' + fmt(median(cd), 2) + '°, наибольшее ' + fmt(Math.max.apply(null, cd), 2) + '°' : '—'],
          ['Наклон облака', levelText(res.level)], ['Местные дефекты', wr.defects != null ? plural(wr.defects, 'место', 'места', 'мест') + ' глубже ' + fmt(wr.defTol, 0) + ' мм (рамки на развёртке)' : '—']]) +
        '<p class="bp-note">Плинтус (до 15 см над полом) не проверяется. Неровность — по поверхности, сглаженной в окне 30 × 30 см: шум сканера, розетки и выключатели не считаются.</p></section>';
      back.querySelectorAll('.ins-walls tr[data-w]').forEach(function (tr) { tr.onclick = function () { mode = 'walls'; selectWall(+tr.getAttribute('data-w'), true); }; });
    }
    function selectWall(wi, center) {
      S.selWall = wi; var w = wr.walls[wi], box = q('.ins-dev'); if (!w || !box) return;
      back.querySelectorAll('.ins-walls tr[data-w]').forEach(function (tr) { tr.classList.toggle('sel', +tr.getAttribute('data-w') === wi); });
      var lim = Math.max(3, limitOf(w.grid.res)), img = wallImage(w, lim, false, 276);
      box.hidden = false;
      box.innerHTML = '<h4>Стена ' + (wi + 1) + ': развёртка, отклонение от плоскости</h4><div class="ins-devimg"></div>' +
        '<div class="ins-devscale"><span>−' + lim + ' мм</span><span>0</span><span>+' + lim + ' мм' + (w.side ? ' (в помещение)' : '') + '</span></div>' +
        facts([['Длина × высота', fmt(w.length, 2) + ' × ' + fmt(w.height, 2) + ' м (от +' + fmt(w.hFrom, 2) + ' м над полом)'],
          ['Вертикаль', fmt(w.plumb, 2) + ' мм/м, завал ' + fmt(w.lean, 1) + ' мм' + (w.toward ? (w.toward === 'room' ? ', верх в помещение' : ', верх наружу') : '')],
          ['Неровность', 'СКО ' + fmt(w.rms, 1) + ' мм, размах ' + fmt(w.p2v, 1) + ' мм'], ['Рейка 2 м', w.railN ? 'наибольший просвет ' + fmt(w.rail, 1) + ' мм (95 %: ' + fmt(w.railP95, 1) + ')' : 'нет данных'],
          ['Шум клеток', fmt(w.noise, 1) + ' мм'], ['Покрытие точками', fmt(w.cover * 100, 0) + ' %'],
          ['Дефекты', w.defects && w.defects.length ? w.defects.slice(0, 4).map(function (d) { return KIND[d.kind] + ' ' + fmt(d.depth, 0) + ' мм на +' + fmt(d.h, 1) + ' м'; }).join('; ') + (w.defects.length > 4 ? '…' : '') : 'нет'],
          ['Итог', w.ok ? 'в допуске' : 'вне допуска: ' + [!w.okPlumb ? 'вертикаль' : '', !w.okRail ? 'неровность' : ''].filter(Boolean).join(', ')]]);
      img.className = 'ins-devcv'; box.querySelector('.ins-devimg').appendChild(img);
      if (center && view) { view.cx = (w.a[0] + w.b[0]) / 2; view.cy = (w.a[1] + w.b[1]) / 2; }
      paint();
    }
    // ---- «Дефекты»
    function defPane() {
      var el = q('[data-pane="def"]'); if (!el) return;
      var fl = defs.filter(function (x) { return x.where === 'floor'; }), wl = defs.filter(function (x) { return x.where === 'wall'; }), rows = '';
      defs.slice(0, 200).forEach(function (x, i) {
        var d = x.d;
        rows += '<tr data-d="' + i + '"' + (i === S.selDef ? ' class="sel"' : '') + '><td>' + (i + 1) + '</td><td>' + (x.where === 'floor' ? 'пол' : 'стена ' + (x.wall + 1)) + '</td><td>' + esc(KIND[d.kind] || d.kind) + '</td><td>' + esc(x.where === 'floor' ? (d.room || '—') : '+' + fmt(d.h, 2) + ' м') +
          '</td><td>' + fmt(d.area, 2) + '</td><td class="hl">' + fmt(d.depth, 1) + '</td></tr>';
      });
      var tf = f && f.defTol, tw = wr && wr.defTol;
      el.innerHTML = kpis([[String(fl.length), 'на полу'], [String(wl.length), 'на стенах'], [defs.length ? fmt(defs[0].d.depth, 1) + ' мм' : '—', 'наибольшая глубина', defs.length ? 'bad' : ''],
          [fmt(defs.reduce(function (a2, x) { return a2 + x.d.area; }, 0), 1) + ' м²', 'общая площадь']]) +
        (rows ? '<section><h4>Местные отклонения (глубже сверху)</h4><table class="ins-tab ins-defs"><tr><th>№</th><th>Где</th><th>Что</th><th>Место</th><th>м²</th><th>мм</th></tr>' + rows + '</table></section>' :
          '<section><p class="bp-note">Местных дефектов больше допуска не найдено.</p></section>') +
        '<section>' + facts([['Порог', (tf ? 'пол ' + fmt(tf, 0) + ' мм' : '') + (tf && tw ? ', ' : '') + (tw ? 'стены ' + fmt(tw, 0) + ' мм' : '') + ' от средней в окне 1 м, площадь от 0,04 м²'],
          ['Предметы на полу', f && f.defObjects ? plural(f.defObjects, 'место', 'места', 'мест') + ' выше 15 мм — не считаются дефектами' : '—']]) +
        '<p class="bp-note">Бугор и выступ — выше окружающей поверхности (стена — в сторону помещения, если сторона известна), впадина — ниже. Клетки 10 см: трещины и сколы мельче клетки не видны.</p></section>';
      el.querySelectorAll('.ins-defs tr[data-d]').forEach(function (tr) { tr.onclick = function () {
        var i = +tr.getAttribute('data-d'), x = defs[i]; S.selDef = i; if (view && x) { view.cx = x.d.u; view.cy = x.d.v; view.s = Math.max(view.s, 40); }
        mode = 'def'; defPane(); paint();
      }; });
    }
    // ---- «Проёмы»
    function openPane() {
      var el = q('[data-pane="open"]'); if (!el) return;
      var rows = '', heads = ops.filter(function (o) { return o.kind === 'door' && o.head != null; }).map(function (o) { return o.head; });
      ops.forEach(function (o, i) {
        rows += '<tr data-o="' + i + '"' + (i === S.selOpen ? ' class="sel"' : '') + '><td>' + (i + 1) + '</td><td>' + esc(KIND[o.kind] || o.kind) + (o.open ? ' <i title="над проёмом нет стены до верха проверки">без перемычки</i>' : '') + '</td><td>' + fmt(o.width, 2) +
          '</td><td>' + (o.kind === 'window' ? fmt(o.sill, 2) : o.kind === 'door' ? '0' : '—') + '</td><td>' + (o.head != null ? fmt(o.head, 2) : '—') + '</td><td>' + (o.height != null ? fmt(o.height, 2) : '—') + '</td></tr>';
      });
      el.innerHTML = kpis([[String(res.openings.doors), 'дверей'], [String(res.openings.windows), 'окон'], [heads.length ? fmt(median(heads), 2) + ' м' : '—', 'высота двери, медиана'], [String(ops.filter(function (o) { return o.open; }).length), 'без перемычки']]) +
        '<section><h4>Проёмы плана</h4><table class="ins-tab ins-opens"><tr><th>№</th><th>Тип</th><th>Ширина</th><th>Низ</th><th>Верх</th><th>Высота</th></tr>' + rows + '</table></section>' +
        '<section><p class="bp-note">Отметки — от пола этажа, м. Проём — разрыв стены в срезе плана; высота — по точкам в плоскости стены (клетки 10 см): пустые строки снизу — дверь, выше заполненных — окно. «Закрыт» — в проёме дверь или стекло.</p></section>';
      el.querySelectorAll('.ins-opens tr[data-o]').forEach(function (tr) { tr.onclick = function () {
        var i = +tr.getAttribute('data-o'), o = ops[i]; S.selOpen = i; if (view && o) { view.cx = (o.a[0] + o.b[0]) / 2; view.cy = (o.a[1] + o.b[1]) / 2; view.s = Math.max(view.s, 30); }
        mode = 'open'; openPane(); paint();
      }; });
    }
    // ---- «Проект»
    var dxfOpt = { units: 'auto', align: 'auto', tol: 20 };
    function fillDxf() {
      var c = S.cmp, el = q('[data-pane="dxf"]');
      var form = '<section><h4>Проект для сравнения</h4><div class="bp-row"><button type="button" class="btn sm" data-act="pickDxf">' + ic('layers') + ' ' + (S.dxfName ? 'Другой DXF…' : 'Выбрать DXF…') + '</button><span class="bp-note ins-dxfname">' + esc(S.dxfName) + '</span></div>' +
        '<div class="bp-row"><label>Единицы <select data-k="units"><option value="auto">авто</option><option value="mm">мм</option><option value="cm">см</option><option value="m">м</option></select></label>' +
        '<label>Допуск <input type="number" min="2" max="500" step="1" data-k="tol" value="' + dxfOpt.tol + '"> мм</label></div>' +
        '<div class="bp-row"><label>Положение <select data-k="align"><option value="auto">подобрать по облаку</option><option value="world">координаты облака</option><option value="none">как в файле</option></select></label></div></section>';
      if (!c) el.innerHTML = form + '<section><p class="bp-note">Линии стен проекта (LINE, LWPOLYLINE, POLYLINE) сравниваются со срезом облака. Слои размеров, текста, мебели, дверей и окон пропускаются. Положение подбирается автоматически: поворот, сдвиг, уточнение ICP.</p></section>';
      else {
        var idx = c.lines.map(function (x, i) { return i; }).filter(function (i) { return c.lines[i].length >= 0.5; }).sort(function (a, b) {
          var A2 = c.lines[a], B2 = c.lines[b], oa = lineStatus(A2, c.tol) === 'совпадает' ? 1 : 0, ob = lineStatus(B2, c.tol) === 'совпадает' ? 1 : 0;
          return (oa - ob) || (Math.abs(B2.offset || 0) - Math.abs(A2.offset || 0));
        }), rows = '';
        idx.slice(0, 150).forEach(function (i) {
          var x = c.lines[i], s = lineStatus(x, c.tol);
          rows += '<tr data-l="' + i + '" class="' + (s === 'совпадает' ? '' : 'bad') + (i === S.selLine ? ' sel' : '') + '"><td>' + (i + 1) + '</td><td>' + fmt(x.length, 2) + '</td><td>' + fmt(x.offset, 0) + '</td><td>' + fmt(x.cover * 100, 0) + '%</td><td' + (s === 'совпадает' ? '' : ' class="hl"') + '>' + esc(s) + '</td></tr>';
        });
        el.innerHTML = form + kpis([[fmt(c.within * 100, 1) + ' %', 'точек ближе ' + fmt(c.tol * 1000, 0) + ' мм'], [fmt(c.median, 1) + ' мм', 'медиана расстояния'], [String(c.shifted), 'линий смещено', c.shifted ? 'bad' : ''], [String(c.missing), 'линий нет в облаке', c.missing ? 'bad' : '']]) +
          '<section>' + facts([['Положение проекта', 'поворот ' + fmt(Math.abs(c.transform.rot) < 0.005 ? 0 : c.transform.rot, 2) + '°, сдвиг ' + fmt(c.transform.tx, 2) + '; ' + fmt(c.transform.ty, 2) + ' м'], ['Единицы файла', c.units], ['95 % точек ближе', fmt(c.p95, 1) + ' мм']]) + '</section>' +
          '<section><h4>Линии (расхождения сверху)</h4><table class="ins-tab ins-lines"><tr><th>№</th><th>Длина</th><th>Смещ.</th><th>Покр.</th><th>Итог</th></tr>' + rows + '</table></section>';
      }
      el.querySelector('[data-k="units"]').value = dxfOpt.units; el.querySelector('[data-k="align"]').value = dxfOpt.align;
      el.querySelector('[data-act="pickDxf"]').onclick = pickDxf;
      ['units', 'align', 'tol'].forEach(function (key) { el.querySelector('[data-k="' + key + '"]').onchange = function (e) { dxfOpt[key] = key === 'tol' ? clamp(+e.target.value || 20, 2, 500) : e.target.value; if (S.dxfText) compare(); }; });
      el.querySelectorAll('.ins-lines tr[data-l]').forEach(function (tr) { tr.onclick = function () { S.selLine = +tr.getAttribute('data-l'); var s = S.cmp.segs[S.selLine]; if (view && s) { view.cx = (s.a[0] + s.b[0]) / 2; view.cy = (s.a[1] + s.b[1]) / 2; } mode = 'dxf'; fillDxf(); paint(); }; });
    }
    async function pickDxf() {
      var A = bim(); if (!A || !A.pickDxfText) { toast('Выбор DXF доступен в настольной версии', true); return; }
      var r = await A.pickDxfText(); if (!r || !r.ok) { if (!(r && r.canceled)) toast('DXF не открыт: ' + ((r && r.message) || ''), true); return; }
      S.dxfText = r.text; S.dxfName = r.name; compare();
    }
    function compare(sync) {
      var CI = W.CloudInspect, P = W.DXFParse; if (!CI || !P || !S.dxfText || !res.slice) return;
      var act = k && k.activity ? k.activity('Сравнение с проектом…') : null;
      var run = function () {
        try {
          var segs = CI.dxfSegments(P.parse(S.dxfText));
          var phi = res.plan && res.plan.ok && res.plan.directions && res.plan.directions.length ? res.plan.directions[0] * Math.PI / 180 : null;
          var c = CI.compareDxf(segs, res.slice.preview, { units: dxfOpt.units, align: dxfOpt.align, tol: dxfOpt.tol / 1000, phi: phi, world: ov && ov.origin ? { cx: ov.origin.cx, cy: ov.origin.cy } : null });
          if (!c.ok) { toast('Сравнение не выполнено: ' + c.message, true); S.cmp = null; } else { S.cmp = c; S.selLine = -1; }
        } catch (e) { toast('Ошибка сравнения: ' + ((e && e.message) || e), true); }
        finally { if (act) act.done(); }
        mode = 'dxf'; fillDxf(); setTab('dxf'); paint();
      };
      if (sync) run(); else setTimeout(run, 30);
    }
    // ---- CSV и PDF
    q('[data-act="csv"]').onclick = async function () {
      var A = bim(); if (!A || !A.exportFile) return;
      var dirs = A.projectFolder ? await A.projectFolder('get') : null, name = stem(path) + '-контроль.csv';
      var sv = await A.exportFile({ text: csv(res, S.cmp), ext: 'csv', name: dirs && dirs.ok ? joinPath(dirs.reports, name) : name, title: 'Сохранить таблицы контроля', filterName: 'CSV (Excel)' });
      if (sv && sv.ok) toast('Готово: ' + baseName(sv.path)); else if (!(sv && sv.canceled)) toast('Не удалось сохранить CSV', true);
    };
    q('[data-act="pdf"]').onclick = async function () {
      var A = bim(), btn = q('[data-act="pdf"]'); if (!A || !A.saveReportPdf || !W.CloudReport || !W.CloudReport.inspect) { toast('PDF-отчёт доступен в настольной версии', true); return; }
      if (k && k.busy) k.busy(btn, true);
      try {
        var ver = ''; try { ver = A.getVersion ? await A.getVersion() : ''; } catch (_) {}
        var html = W.CloudReport.inspect(Object.assign(reportData(S, path), { appVersion: ver }));
        var r = await A.saveReportPdf({ html: html, name: stem(path) + ' — контроль геометрии.pdf' });
        if (r && r.ok) toast('Готово: PDF-отчёт сохранён — ' + r.path); else if (!(r && r.canceled)) toast('Не удалось сохранить PDF: ' + ((r && r.message) || ''), true);
      } catch (e) { toast('Ошибка отчёта: ' + ((e && e.message) || e), true); }
      finally { if (k && k.busy) k.busy(btn, false); }
    };
    var done = false;
    function close() {
      if (done) return; done = true;
      D.removeEventListener('keydown', onKey, true); W.removeEventListener('resize', paint); D.removeEventListener('mousemove', mv); D.removeEventListener('mouseup', up);
      back.classList.add('closing'); setTimeout(function () { if (back.parentNode) back.parentNode.removeChild(back); }, 140);
    }
    function onKey(e) { if (e.key === 'Escape' && back.parentNode && !D.querySelector('.modal.lx-ask')) { e.preventDefault(); e.stopPropagation(); close(); } }
    q('.modal-head .x').onclick = close; q('[data-act="close"]').onclick = close;
    D.addEventListener('keydown', onKey, true); W.addEventListener('resize', paint);
    D.body.appendChild(back); if (k && k.hydrate) k.hydrate(back); back.classList.add('open');
    wallsPane(); defPane(); openPane(); fillDxf(); setTab(hasF ? 'floor' : 'walls');
    if (hasW && !hasF) selectWall(order[0]);
    requestAnimationFrame(paint);
    S.paint = paint; S.setMode = setMode; S.close = close;
    S.selectWall = function (i) { mode = 'walls'; setTab('walls'); selectWall(i, true); };
    S.compareText = function (text, name, opt) { S.dxfText = text; S.dxfName = name || 'проект.dxf'; if (opt) Object.assign(dxfOpt, opt); compare(true); };
    S.reportData = function () { return reportData(S, path); };
    return S;
  }
  // данные для PDF (CloudReport.inspect): карты в светлой теме, развёртки худших стен, таблицы
  function reportData(S, path) {
    var res = S.res, maps = [], dev = [];
    if (res.floor && res.floor.ok) {
      maps.push({ title: 'Отклонение пола от средней плоскости, ±' + S.lim.plane + ' мм; кружки — просвет под рейкой больше допуска', src: mapImage(S, 'plane', 1400) });
      maps.push({ title: 'Отклонение пола от горизонтали, ±' + S.lim.level + ' мм', src: mapImage(S, 'level', 1400) });
    }
    if (res.walls && res.walls.ok && res.walls.walls.length) maps.push({ title: 'Стены: зелёный — в допуске, жёлтый — неровность, красный — вертикаль', src: mapImage(S, 'walls', 1400) });
    if (res._defs && res._defs.length && res.floor && res.floor.ok) maps.push({ title: 'Местные дефекты: красный — бугор или выступ, синий — впадина; круг — пол, квадрат — стена', src: mapImage(S, 'def', 1400) });
    if (res.openings && res.openings.ok && res.openings.list.length) maps.push({ title: 'Проёмы: зелёный — дверь (подпись — высота, м), голубой — окно (низ–верх, м), пунктир — без перемычки или закрыт', src: mapImage(S, 'open', 1400) });
    if (S.cmp) maps.push({ title: 'Облако против проекта: цвет точек — расстояние до линии проекта; синий — совпадает, жёлтый — смещена, красный пунктир — нет в облаке', src: mapImage(S, 'dxf', 1400) });
    if (res.walls && res.walls.ok) res.walls.walls.map(function (w, i) { return i; }).filter(function (i) { return !res.walls.walls[i].ok; })
      .sort(function (a, b) { return res.walls.walls[b].lean - res.walls.walls[a].lean; }).slice(0, 6).forEach(function (i) {
        var w = res.walls.walls[i], lim = Math.max(3, limitOf(w.grid.res));
        dev.push({ n: i + 1, lim: lim, src: wallImage(w, lim, true, 520).toDataURL('image/png'), w: w });
      });
    return { fileName: res.fileName || baseName(path), project: W.__bimProjectName || '', res: res, cmp: S.cmp, dxfName: S.dxfName, maps: maps, dev: dev,
      verdict: verdict(res), cls: PRESETS[res.cls] ? PRESETS[res.cls].label : '' };
  }

  return Object.assign({}, pure, { open: open, show: show, last: function (p) { return last.get(p) || null; }, _draw: { drawMap: drawMap, fitView: fitView, mapImage: mapImage } });
});
