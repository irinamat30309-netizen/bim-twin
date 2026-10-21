/*
 * cloud-report.js — PDF-отчёт по облаку точек (ревизия 27), как отчёт проекта в Lixel Studio.
 *
 * CloudReport.build({ ov, capacity, plan | plans: [{ plan, title }], maps, snapshot, fileName, project, appVersion, load, facts, storeys }) → строка HTML (A4).
 * HTML печатается в PDF главным процессом (bim:saveReportPdf: скрытое окно без JavaScript → printToPDF). Всё внутри — без внешних
 * ссылок: карты и снимок 3D — data:image, гистограмма высот и план — SVG.
 * Разделы: сведения о съёмке и облаке, геометрия, уровни и этажи, гистограмма высот, карты с маршрутом, план из облака (помещения,
 * проёмы, толщины стен), снимок 3D-вида, параметры загрузки и компьютер.
 * Ревизия 31: CloudReport.inspect(o) — отдельный отчёт «Контроль геометрии» (пол FF/FL, стены, углы, сравнение с DXF).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudReport = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function n(x, d) { return (+x || 0).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function mln(x) { x = +x || 0; return x >= 1e7 ? n(x / 1e6, 0) : n(x / 1e6, 1); }
  function safeImg(src) { return typeof src === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(src) ? src : ''; }

  function histSvg(ov, levels) {
    var H = ov.hist; if (!H || !H.counts || !H.counts.length) return '';
    var core = ov.bbox.core || ov.bbox, h0 = core.h0, h1 = core.h1, W = 700, Ht = 170, mx = 1, i, bars = '';
    for (i = 0; i < H.counts.length; i++) if (H.counts[i] > mx) mx = H.counts[i];
    var X = function (z) { return 40 + (z - h0) / Math.max(0.01, h1 - h0) * (W - 60); };
    for (i = 0; i < H.counts.length; i++) {
      var z = H.h0 + i * H.step; if (z < h0 || z > h1) continue;
      var bh = Math.sqrt(H.counts[i] / mx) * (Ht - 40);
      bars += '<rect x="' + X(z).toFixed(1) + '" y="' + (Ht - 22 - bh).toFixed(1) + '" width="' + Math.max(0.8, X(z + H.step) - X(z) + 0.4).toFixed(2) + '" height="' + bh.toFixed(1) + '" fill="#64748b"/>';
    }
    // отметки уровней: близкие подписи — во второй ряд, чтобы не слипались
    var lastX = -1e9, row = 0;
    var marks = (levels || []).slice().sort(function (a, b) { return a.h - b.h; }).map(function (l) {
      var xv = X(l.h), x = xv.toFixed(1); row = xv - lastX < 30 ? (row ? 0 : 1) : 0; lastX = xv;
      return '<line x1="' + x + '" y1="' + (row ? 19 : 8) + '" x2="' + x + '" y2="' + (Ht - 22) + '" stroke="#0284c7" stroke-width="1.4"/><text x="' + x + '" y="' + (row ? 18 : 8) + '" font-size="10" fill="#0369a1" text-anchor="middle">' + n(l.h, 2) + '</text>';
    }).join('');
    var ticks = '', step = Math.max(0.5, Math.pow(10, Math.floor(Math.log10(Math.max(0.1, h1 - h0)))) / (h1 - h0 < 3 ? 2 : 1));
    for (var t = Math.ceil(h0 / step) * step; t <= h1; t += step) if (X(t) < W - 80) ticks += '<text x="' + X(t).toFixed(1) + '" y="' + (Ht - 6) + '" font-size="10" fill="#475569" text-anchor="middle">' + n(t, step < 1 ? 1 : 0) + '</text>';
    return '<svg viewBox="0 0 ' + W + ' ' + Ht + '" width="100%" xmlns="http://www.w3.org/2000/svg"><line x1="40" y1="' + (Ht - 22) + '" x2="' + (W - 20) + '" y2="' + (Ht - 22) + '" stroke="#94a3b8"/>' + bars + marks + ticks +
      '<text x="' + (W - 20) + '" y="' + (Ht - 6) + '" font-size="10" fill="#475569" text-anchor="end">высота, м</text></svg>';
  }
  function planSvg(plan) {
    if (!plan || !plan.ok || !plan.faces || !plan.faces.length) return '';
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    plan.faces.forEach(function (f) { [f.a, f.b].forEach(function (p) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }); });
    var pad = Math.max(0.6, (x1 - x0) * 0.06), W = 700, s = Math.min((W - 20) / (x1 - x0 + 2 * pad), 560 / (y1 - y0 + 2 * pad)), Ht = (y1 - y0 + 2 * pad) * s + 10;
    var P = function (p) { return [((p[0] - x0 + pad) * s + 10).toFixed(1), ((y1 - p[1] + pad) * s + 5).toFixed(1)]; };
    var out = '', txt = '';
    // подписи не должны налезать друг на друга: каждая подпись — повёрнутый прямоугольник, ставим по очереди
    // (сначала помещения, затем грани от длинных к коротким) в первое свободное место; не нашлось — подпись не рисуем
    var placed = [];
    var hit = function (A, B) {
      var ax = [[Math.cos(A.r), Math.sin(A.r)], [-Math.sin(A.r), Math.cos(A.r)], [Math.cos(B.r), Math.sin(B.r)], [-Math.sin(B.r), Math.cos(B.r)]];
      for (var k = 0; k < 4; k++) {
        var u = ax[k], d = Math.abs((B.x - A.x) * u[0] + (B.y - A.y) * u[1]);
        var ra = A.w * Math.abs(Math.cos(A.r) * u[0] + Math.sin(A.r) * u[1]) + A.h * Math.abs(-Math.sin(A.r) * u[0] + Math.cos(A.r) * u[1]);
        var rb = B.w * Math.abs(Math.cos(B.r) * u[0] + Math.sin(B.r) * u[1]) + B.h * Math.abs(-Math.sin(B.r) * u[0] + Math.cos(B.r) * u[1]);
        if (d >= ra + rb) return false;
      }
      return true;
    };
    var free = function (bx) {
      if (bx.x - bx.w < 0 || bx.x + bx.w > W || bx.y < 0 || bx.y > Ht + 4) return false;
      for (var q = 0; q < placed.length; q++) if (hit(bx, placed[q])) return false;
      return true;
    };
    var halo = ' paint-order="stroke" stroke="#fff" stroke-width="3" stroke-linejoin="round"';
    var faces = plan.faces, partner = {}, centers = (plan.rooms || []).map(function (r) { return r.center; });
    (plan.walls || []).forEach(function (w) { if (faces[w.i] && faces[w.j]) { partner[w.i] = faces[w.j]; partner[w.j] = faces[w.i]; } });
    var minLab = faces.length > 120 ? 2 : faces.length > 50 ? 1.2 : 0.6, off = Math.max(0.18, 11 / s);
    faces.forEach(function (f) { var a = P(f.a), b = P(f.b); out += '<line x1="' + a[0] + '" y1="' + a[1] + '" x2="' + b[0] + '" y2="' + b[1] + '" stroke="#0f172a" stroke-width="2"/>'; });
    (plan.openings || []).forEach(function (o) { var a = P(o.a), b = P(o.b); out += '<line x1="' + a[0] + '" y1="' + a[1] + '" x2="' + b[0] + '" y2="' + b[1] + '" stroke="#ea580c" stroke-width="2" stroke-dasharray="5 3"/>'; });
    (plan.rooms || []).forEach(function (r) {
      var c = P(r.center), cx = +c[0], cy = +c[1], nm = String(r.name || ''), ar = n(r.area, 2) + ' м²';
      var w2 = Math.max(nm.length * 3.4, ar.length * 2.9) + 2, dys = [0, -26, 26, -52, 52, -78, 78];
      for (var k = 0; k < dys.length; k++) {
        var bx = { x: cx, y: cy + dys[k] + 3, w: w2, h: 12, r: 0 };
        if (!free(bx)) continue;
        placed.push(bx);
        txt += '<text x="' + cx.toFixed(1) + '" y="' + (cy + dys[k]).toFixed(1) + '" font-size="11" font-weight="600" fill="#0f172a" text-anchor="middle"' + halo + '>' + esc(nm) + '</text>' +
          '<text x="' + cx.toFixed(1) + '" y="' + (cy + dys[k] + 13).toFixed(1) + '" font-size="10" fill="#334155" text-anchor="middle"' + halo + '>' + ar + '</text>';
        return;
      }
    });
    // подписи длин граней: со стороны помещения; у двух граней одной стены (перегородки) — врозь
    faces.map(function (f, fi) { return { f: f, fi: fi, L: f.length || Math.hypot(f.b[0] - f.a[0], f.b[1] - f.a[1]) }; })
      .filter(function (e) { return e.L >= minLab; })
      .sort(function (x, y) { return y.L - x.L; })
      .forEach(function (e) {
        var f = e.f, fi = e.fi, L = e.L;
        var d = [(f.b[0] - f.a[0]) / L, (f.b[1] - f.a[1]) / L], nrm = [-d[1], d[0]], mid = [(f.a[0] + f.b[0]) / 2, (f.a[1] + f.b[1]) / 2], side = 1;
        var dot = function (q) { return (q[0] - mid[0]) * nrm[0] + (q[1] - mid[1]) * nrm[1]; };
        if (partner[fi]) side = dot([(partner[fi].a[0] + partner[fi].b[0]) / 2, (partner[fi].a[1] + partner[fi].b[1]) / 2]) >= 0 ? -1 : 1;
        else if (centers.length) { var best = Infinity; centers.forEach(function (c) { var dd = Math.hypot(c[0] - mid[0], c[1] - mid[1]); if (dd < best) { best = dd; side = dot(c) >= 0 ? 1 : -1; } }); }
        var ang = Math.atan2(-(d[1]), d[0]) * 180 / Math.PI;
        if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
        var label = String(Math.round(L * 1000)), hw = label.length * 2.7 + 1.5, rad = ang * Math.PI / 180;
        var tries = [side, -side, 2.1 * side, -2.1 * side, 0.55 * side];
        for (var k = 0; k < tries.length; k++) {
          var t = P([mid[0] + nrm[0] * off * tries[k], mid[1] + nrm[1] * off * tries[k]]), bx = { x: +t[0], y: +t[1], w: hw, h: 5.5, r: rad };
          if (!free(bx)) continue;
          placed.push(bx);
          txt += '<text x="' + t[0] + '" y="' + t[1] + '" font-size="9" fill="#0369a1" text-anchor="middle" dominant-baseline="middle"' + halo + ' transform="rotate(' + ang.toFixed(1) + ' ' + t[0] + ' ' + t[1] + ')">' + label + '</text>';
          return;
        }
      });
    out += txt;
    return '<svg viewBox="0 0 ' + W + ' ' + Ht.toFixed(0) + '" width="100%" style="max-height:120mm" xmlns="http://www.w3.org/2000/svg">' + out + '</svg>';
  }
  // таблица размеров; длинный список (реальные сканы: десятки проёмов) — одной строкой: число, диапазон, медиана
  function sizes(list, key, one, what, many) {
    if (!list || !list.length) return '';
    if (list.length <= 12) return table(list.map(function (p, i) { return [one + ' ' + (i + 1), n(p[key] * 1000, 0) + ' мм']; }), [one, what]);
    var v = list.map(function (p) { return p[key] * 1000; }).sort(function (x, y) { return x - y; });
    return table([[many, list.length + ' шт. · ' + n(v[0], 0) + '–' + n(v[v.length - 1], 0) + ' мм, медиана ' + n(v[Math.floor(v.length / 2)], 0) + ' мм']]);
  }
  function table(rows, head) {
    return '<table>' + (head ? '<tr>' + head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr>' : '') +
      rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return (head ? '<td>' : i ? '<td>' : '<th>') + esc(c) + (head ? '</td>' : i ? '</td>' : '</th>'); }).join('') + '</tr>'; }).join('') + '</table>';
  }

  function build(o) {
    o = o || {};
    var ov = o.ov || {}, now = new Date(), date = now.toLocaleDateString('ru-RU') + ' ' + now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    var css = '@page{size:A4;margin:14mm 12mm}*{box-sizing:border-box}body{font:11px/1.45 Arial,"Liberation Sans",sans-serif;color:#0f172a;margin:0}' +
      'h1{font-size:20px;margin:0 0 2px}h2{font-size:14px;margin:18px 0 6px;padding-bottom:3px;border-bottom:2px solid #0284c7;color:#0c4a6e}' +
      '.sub{color:#475569;margin-bottom:10px}.head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid #cbd5e1;padding-bottom:8px}' +
      'table{width:100%;border-collapse:collapse;margin:4px 0}th,td{text-align:left;padding:3px 6px;border-bottom:1px solid #e2e8f0;vertical-align:top}th{color:#334155;font-weight:600;width:42%}' +
      'table tr:first-child th{background:#f1f5f9}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.fig{break-inside:avoid;margin:6px 0 10px}.fig img{width:100%;border:1px solid #cbd5e1;border-radius:3px}' +
      '.cap{color:#475569;font-size:10px;margin-top:2px}.kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:8px 0}.kpi div{border:1px solid #cbd5e1;border-radius:4px;padding:6px}' +
      '.kpi b{display:block;font-size:15px;color:#0c4a6e}.kpi span{color:#475569;font-size:10px}.note{color:#64748b;font-size:10px}.pb{break-before:page}';
    var st = ov.stats || {}, f = ov.file || {}, tr = ov.trajectory;
    var kpi = [[mln(f.points) + ' млн', 'точек в файле'], [n(st.footprint, 1) + ' м²', 'площадь застройки'], [tr ? n(tr.length, 0) + ' м' : '—', 'путь сканера'],
      [tr ? (tr.duration < 90 ? Math.round(tr.duration) + ' с' : Math.round(tr.duration / 60) + ' мин') : '—', 'длительность съёмки']];
    var h = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>' + esc('Отчёт — ' + (o.fileName || '')) + '</title><style>' + css + '</style></head><body>';
    h += '<div class="head"><div><h1>Отчёт по облаку точек</h1><div class="sub">' + esc(o.fileName || f.name || '') + (o.project ? ' · проект «' + esc(o.project) + '»' : '') + '</div></div>' +
      '<div class="sub" style="text-align:right">' + esc(date) + '<br>BIM Twin ' + esc(o.appVersion || '') + '</div></div>';
    h += '<div class="kpi">' + kpi.map(function (k) { return '<div><b>' + esc(k[0]) + '</b><span>' + esc(k[1]) + '</span></div>'; }).join('') + '</div>';
    h += '<h2>Сведения о съёмке и облаке</h2>' + table(o.facts || []);
    if (tr) h += '<p class="note">Траектория: ' + esc(tr.file || 'poses.csv') + ', ' + n(tr.n, 0) + ' поз. Расстояние «старт — финиш» показывает, вернулся ли сканер в начальную точку (замкнутый маршрут уменьшает накопленный дрейф).</p>';
    var lv = ov.levels || [];
    if (lv.length || (o.storeys && o.storeys.length)) {
      h += '<h2>Уровни и этажи</h2>';
      if (lv.length) h += table(lv.map(function (l, i) { return [String(i + 1), '+' + n(l.h, 3) + ' м', '≈ ' + n(l.area, 1) + ' м²']; }), ['№', 'Горизонтальная плоскость (пол / перекрытие)', 'Площадь']);
      if (o.storeys && o.storeys.length) h += table(o.storeys.map(function (s) { return [s.name, '+' + n(s.floor, 2) + ' м', s.ceiling != null ? '+' + n(s.ceiling, 2) + ' м' : '—', s.ceiling != null ? n(s.ceiling - s.floor, 2) + ' м' : '—']; }), ['Этаж', 'Пол', 'Перекрытие', 'Высота в свету']);
    }
    h += '<div class="fig"><h2>Распределение точек по высоте</h2>' + histSvg(ov, lv) + '<div class="cap">Пики — горизонтальные поверхности (полы, перекрытия, кровля); отметки — найденные уровни.</div></div>';
    var maps = (o.maps || []).filter(function (m) { return safeImg(m.src); });
    if (maps.length) {
      h += '<h2>Карты площадки (вид сверху)</h2><div class="grid2">' + maps.map(function (m) { return '<div class="fig"><img src="' + safeImg(m.src) + '" alt=""><div class="cap">' + esc(m.title) + (tr ? ' · маршрут: зелёный — начало, красный — конец' : '') + '</div></div>'; }).join('') + '</div>';
    }
    var plans = (o.plans && o.plans.length ? o.plans : o.plan ? [{ plan: o.plan, title: '' }] : []).filter(function (x) { return x && x.plan && x.plan.ok; });
    plans.forEach(function (it, pi) {
      var plan = it.plan;
      h += '<h2' + (pi === 0 ? ' class="pb"' : '') + '>План из облака' + (it.title ? ' — ' + esc(it.title) : '') + '</h2><div class="fig">' + planSvg(plan) + '<div class="cap">Грани стен (мм), проёмы — пунктир. Срез облака на заданной высоте над полом.</div></div>';
      if (plan.rooms && plan.rooms.length) h += table(plan.rooms.map(function (r) { return [r.name, n(r.area, 2) + ' м²', r.size ? n(r.size[0], 3) + ' × ' + n(r.size[1], 3) + ' м' : '']; }), ['Помещение', 'Площадь', 'Размеры (по осям плана)']);
      h += sizes(plan.openings, 'width', 'Проём', 'Ширина', 'Проёмы');
      h += sizes(plan.walls, 'thickness', 'Стена', 'Толщина', 'Стены (две грани)');
      if (pi === plans.length - 1) h += '<p class="note">Точность размеров определяется плотностью и шумом облака в срезе (обычно ±5–10 мм у плотных сканов). Проверьте ключевые размеры инструментом «Расстояние».</p>';
    });
    var snap = safeImg(o.snapshot);
    if (snap) h += '<div class="fig"><h2>3D-вид облака</h2><img src="' + snap + '" alt=""></div>';
    var cap = o.capacity, rec = cap && cap.recommendation;
    var rows = [];
    if (o.load) {
      var lf = o.load.filter || {};
      rows.push(['Загружено точек', o.load.maxPoints > 0 ? 'до ' + mln(o.load.maxPoints) + ' млн' : 'все']);
      if (lf.rect) rows.push(['Область', n(lf.rect.u1 - lf.rect.u0, 2) + ' × ' + n(lf.rect.v1 - lf.rect.v0, 2) + ' м']);
      if (lf.h) rows.push(['Высоты', n(lf.h.min, 2) + ' … ' + n(lf.h.max, 2) + ' м']);
      if (lf.route) rows.push(['Около маршрута', 'не дальше ' + n(lf.route.radius, 0) + ' м, участок ' + Math.round(lf.route.from * 100) + '–' + Math.round(lf.route.to * 100) + ' %']);
      if (lf.noise) rows.push(['Шум', 'удалён при чтении (воксель ' + n(lf.noise.voxel * 100, 0) + ' см, не меньше ' + lf.noise.min + ' точек)']);
    }
    if (cap && cap.ok) {
      rows.push(['Видеокарта', (cap.gpu && cap.gpu.name || '—') + (cap.gpu && cap.gpu.vramTotal ? ', ' + n(cap.gpu.vramTotal / 1073741824, 1) + ' ГБ' : '')]);
      rows.push(['Оперативная память', n(cap.ram.total / 1073741824, 1) + ' ГБ']);
      if (rec) rows.push(['Рекомендовано точек на экране', mln(rec.points) + ' млн (наибольшее надёжное ' + mln(rec.safeMax) + ' млн)']);
    }
    h += '<div class="fig">';
    if (rows.length) h += '<h2>Параметры загрузки и компьютер</h2>' + table(rows);
    h += '<p class="note" style="margin-top:14px">Сведения по выборке ' + n(Math.min((ov.sample && ov.sample.n) || 0, (ov.file && ov.file.points) || Infinity), 0) + ' точек, равномерно по файлу. Площадь поверхностей — оценка по вокселям 20 см.</p>';
    return h + '</div></body></html>';
  }
  // ------------------------------------------------------------------ ревизия 31: отчёт «Контроль геометрии»
  // CloudReport.inspect({ fileName, project, res, cmp, dxfName, maps: [{ title, src }], dev: [{ n, lim, src, w }], verdict: [строки], cls, appVersion })
  // res — результат bim:cloudInspect (пол, стены, углы), cmp — сравнение с DXF (CloudInspect.compareDxf). Без внешних ссылок.
  function fx(x, d) { return x === x && x != null && isFinite(x) ? n(x, d) : '—'; }
  function ffText(F) {
    if (!(F > 0)) return '—';
    return F < 20 ? 'ниже обычного' : F < 25 ? 'обычный (FF20)' : F < 35 ? 'умеренно ровный (FF25)' : F < 45 ? 'ровный (FF35)' : F < 60 ? 'очень ровный (FF45)' : 'сверхровный (FF60+)';
  }
  function lineState(x, tol) { return x.length < 0.5 ? 'короткая' : x.cover < 0.3 ? 'нет в облаке' : x.points >= 20 && Math.abs(x.offset) > tol * 1000 ? 'смещена' : 'совпадает'; }
  function medianOf(a) { var s = a.filter(function (x) { return x === x && x != null; }).sort(function (p, q) { return p - q; }); return s.length ? s[s.length >> 1] : NaN; }
  function quantOf(a, q) { var s = a.filter(function (x) { return x === x && x != null; }).sort(function (p, r) { return p - r; }); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : NaN; }
  function rowsTable(rows, head, bad) {
    return '<table class="t">' + '<tr>' + head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr>' +
      rows.map(function (r, i) { return '<tr' + (bad && bad[i] ? ' class="bad"' : '') + '>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table>';
  }
  function inspect(o) {
    o = o || {};
    var res = o.res || {}, cmp = o.cmp && o.cmp.ok ? o.cmp : null, now = new Date(), date = now.toLocaleDateString('ru-RU') + ' ' + now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    var css = '@page{size:A4;margin:14mm 12mm}*{box-sizing:border-box}body{font:11px/1.45 Arial,"Liberation Sans",sans-serif;color:#0f172a;margin:0}' +
      'h1{font-size:20px;margin:0 0 2px}h2{font-size:14px;margin:18px 0 6px;padding-bottom:3px;border-bottom:2px solid #0284c7;color:#0c4a6e}h3{font-size:12px;margin:10px 0 4px;color:#0c4a6e}' +
      '.sub{color:#475569;margin-bottom:10px}.head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid #cbd5e1;padding-bottom:8px}' +
      'table{width:100%;border-collapse:collapse;margin:4px 0}th,td{text-align:left;padding:3px 6px;border-bottom:1px solid #e2e8f0;vertical-align:top}th{color:#334155;font-weight:600;width:42%}' +
      'table tr:first-child th{background:#f1f5f9}table.t th{width:auto}table.t td,table.t th{font-size:10px;padding:2px 5px}table.t tr.bad td{color:#b91c1c}' +
      '.fig{break-inside:avoid;margin:6px 0 10px}.fig img{width:100%;border:1px solid #cbd5e1;border-radius:3px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}' +
      '.cap{color:#475569;font-size:10px;margin-top:2px}.kpi{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:8px 0}.kpi div{border:1px solid #cbd5e1;border-radius:4px;padding:6px}' +
      '.kpi b{display:block;font-size:15px;color:#0c4a6e}.kpi b.bad{color:#b91c1c}.kpi span{color:#475569;font-size:10px}.note{color:#64748b;font-size:10px}.pb{break-before:page}' +
      '.verdict{border-left:3px solid #0284c7;background:#f0f9ff;padding:6px 10px;margin:8px 0}.verdict div{margin:2px 0}.dev img{display:block;width:auto;max-width:100%;max-height:260px;margin:0 auto}';
    var f = res.floor && res.floor.ok ? res.floor : null, w = res.walls && res.walls.ok ? res.walls : null, F = f ? f.F || {} : {};
    var kpi = [];
    if (f) kpi.push([fx(F.FF, 1) + ' / ' + fx(F.FL, 1), 'FF / FL пола', false], [fx(f.plane.mmPerM, 2) + ' мм/м', 'уклон пола', false],
      [fx(f.rail.max, 1) + ' мм', 'просвет под рейкой ' + fx(f.rail.len || 2, 0) + ' м, наибольший', f.rail.max > f.rail.tol]);
    if (w) kpi.push([(w.checked - w.bad) + ' из ' + w.checked, 'стен в допуске', w.bad > 0]);
    if (cmp) kpi.push([fx(cmp.within * 100, 1) + ' %', 'точек ближе ' + fx(cmp.tol * 1000, 0) + ' мм к проекту', cmp.within < 0.9]);
    var h = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>' + esc('Контроль геометрии — ' + (o.fileName || '')) + '</title><style>' + css + '</style></head><body>';
    h += '<div class="head"><div><h1>Контроль геометрии по облаку точек</h1><div class="sub">' + esc(o.fileName || '') + (o.project ? ' · проект «' + esc(o.project) + '»' : '') + '</div></div>' +
      '<div class="sub" style="text-align:right">' + esc(date) + '<br>BIM Twin ' + esc(o.appVersion || '') + '</div></div>';
    if (kpi.length) h += '<div class="kpi" style="grid-template-columns:repeat(' + Math.min(5, kpi.length) + ',1fr)">' + kpi.slice(0, 5).map(function (k) { return '<div><b' + (k[2] ? ' class="bad"' : '') + '>' + esc(k[0]) + '</b><span>' + esc(k[1]) + '</span></div>'; }).join('') + '</div>';
    if (o.verdict && o.verdict.length) h += '<div class="verdict">' + o.verdict.map(function (s) { return '<div>' + esc(s) + '</div>'; }).join('') + '</div>';
    var tol = res.tol || {}, par = [];
    if (res.floorH != null) par.push(['Отметка пола', '+' + fx(res.floorH, 3) + ' м']);
    if (res.top != null) par.push(['Проверка стен до высоты', '+' + fx(res.top, 2) + ' м над полом']);
    if (tol.floorRail != null) par.push(['Допуск просвета под рейкой пола', fx(tol.floorRail, 1) + ' мм']);
    if (o.cls || tol.plumbPerM != null) par.push(['Стены' + (o.cls ? ', класс «' + o.cls.toLowerCase() + '»' : ''), 'вертикаль ' + fx(tol.plumbPerM, 1) + ' мм/м, не больше ' + fx(tol.plumbMax, 0) + ' мм на высоту, рейка 2 м — ' + fx(tol.wallRail, 1) + ' мм']);
    if (res.points) par.push(['Точек в проверке', n(res.points.used || res.points.read || 0, 0) + (res.points.read ? ' из ' + n(res.points.read, 0) + ' прочитанных' : '')]);
    if (par.length) h += '<h2>Параметры проверки</h2>' + table(par);
    var maps = (o.maps || []).filter(function (m) { return safeImg(m.src); });
    if (maps.length) h += '<h2>Карты отклонений</h2>' + maps.map(function (m) { return '<div class="fig"><img src="' + safeImg(m.src) + '" alt=""><div class="cap">' + esc(m.title) + '</div></div>'; }).join('');
    if (f) {
      h += '<h2 class="pb">Пол</h2>' + table([
        ['Проверенная площадь', fx(f.area, 1) + ' м² (клетка ' + fx(f.cell * 100, 1) + ' см)'],
        ['FF / FL (ASTM E1155, оценка по облаку)', fx(F.FF, 1) + ' / ' + fx(F.FL, 1) + ' — ' + ffText(F.FF) + ((F.readings || F.nq) ? ', замеров ' + n(F.readings || F.nq, 0) : '')],
        ['Уклон средней плоскости', fx(f.plane.mmPerM, 2) + ' мм/м (' + fx(Math.atan(f.plane.mmPerM / 1000) * 180 / Math.PI, 3) + '°)' + (f.plane.downDir === f.plane.downDir && f.plane.downDir != null ? ', понижение в сторону ' + fx(f.plane.downDir, 0) + '°' : '')],
        ['Размах от средней плоскости (1–99 %)', f.flat ? fx(f.flat.p1, 1) + ' … ' + fx(f.flat.p99, 1) + ' мм' : '—'],
        ['Размах от горизонтали (1–99 %)', f.level ? fx(f.level.p1, 1) + ' … ' + fx(f.level.p99, 1) + ' мм' : '—'],
        ['Рейка ' + fx(f.rail.len || 2, 0) + ' м', f.rail.n ? 'мест ' + n(f.rail.n, 0) + ', p95 ' + fx(f.rail.p95, 1) + ' мм, наибольший ' + fx(f.rail.max, 1) + ' мм, больше ' + fx(f.rail.tol, 1) + ' мм — ' + fx(f.rail.over * 100, 1) + ' %' : 'нет данных'],
        ['Шум отметок пола (СКО по клеткам)', f.sigma === f.sigma && f.sigma != null ? 'σ ≈ ' + fx(f.sigma, 2) + ' мм' + (isFinite(f.FFnoise) && f.FFnoise > 0 ? ' (предел FF от шума ≈ ' + fx(f.FFnoise, 0) + ')' : '') : '—']
      ]);
      if (f.rooms && f.rooms.length) h += '<h3>По помещениям</h3>' + rowsTable(f.rooms.map(function (r) {
        return [r.name, r.kind === 'corridor' ? 'коридор' : 'помещение', fx(r.area, 1), fx(r.FF, 1), fx(r.FL, 1), fx(r.tilt, 2), fx(r.railMax, 1), fx(r.p2v, 1)];
      }), ['Помещение', 'Тип', 'Площадь, м²', 'FF', 'FL', 'Уклон, мм/м', 'Рейка, мм', 'Размах, мм'], f.rooms.map(function (r) { return r.railMax > f.rail.tol; }));
    }
    if (w) {
      var ws = w.walls, plumbs = ws.map(function (x) { return x.plumb; }), rails = ws.map(function (x) { return x.rail; });
      h += '<h2 class="pb">Стены</h2>' + table([
        ['Проверено граней', w.checked + ' (в допуске ' + (w.checked - w.bad) + ', вне допуска ' + w.bad + ')'],
        ['Вертикаль', 'медиана ' + fx(medianOf(plumbs), 2) + ' мм/м, 90 % — до ' + fx(quantOf(plumbs, 0.9), 2) + ' мм/м; не в допуске ' + ws.filter(function (x) { return !x.okPlumb; }).length],
        ['Неровность (рейка 2 м)', 'медиана ' + fx(medianOf(rails), 1) + ' мм, 90 % — до ' + fx(quantOf(rails, 0.9), 1) + ' мм; не в допуске ' + ws.filter(function (x) { return !x.okRail; }).length],
        ['Шум облака на стенах', 'медиана ' + fx(medianOf(ws.map(function (x) { return x.noise; })), 1) + ' мм']
      ]);
      var order = ws.map(function (x, i) { return i; }).sort(function (a, b) { return (ws[a].ok - ws[b].ok) || (ws[b].plumb - ws[a].plumb); }).slice(0, 60);
      h += '<h3>Грани' + (ws.length > 60 ? ' (60 из ' + ws.length + ': сначала вне допуска)' : '') + '</h3>' + rowsTable(order.map(function (i) {
        var x = ws[i];
        return [String(i + 1), fx(x.length, 2), fx(x.height, 2), fx(x.plumb, 2), fx(x.lean, 1), x.toward === 'room' ? 'в помещение' : x.toward === 'out' ? 'наружу' : '—', fx(x.rail, 1), fx(x.noise, 1),
          x.ok ? 'в допуске' : !x.okPlumb && !x.okRail ? 'вертикаль и неровность' : !x.okPlumb ? 'вертикаль' : 'неровность'];
      }), ['№', 'Длина, м', 'Высота, м', 'Вертикаль, мм/м', 'Завал, мм', 'Верх', 'Рейка, мм', 'Шум, мм', 'Итог'], order.map(function (i) { return !ws[i].ok; }));
      var dev = (o.dev || []).filter(function (d) { return safeImg(d.src); });
      if (dev.length) h += '<h3>Развёртки граней вне допуска</h3><div class="grid2">' + dev.map(function (d) {
        return '<div class="fig dev"><img src="' + safeImg(d.src) + '" alt=""><div class="cap">Грань ' + d.n + (d.w ? ': ' + fx(d.w.length, 2) + ' × ' + fx(d.w.height, 2) + ' м, вертикаль ' + fx(d.w.plumb, 2) + ' мм/м' : '') + ' · шкала ±' + fx(d.lim, 0) + ' мм (синий — впадина, красный — выступ)</div></div>';
      }).join('') + '</div>';
    }
    var cs = res.corners || [];
    if (cs.length) {
      var dvs = cs.map(function (k) { return k.dev; });
      h += '<h2>Углы между стенами</h2>' + table([['Углов', String(cs.length)], ['Отклонение от 90°', 'медиана ' + fx(medianOf(dvs), 2) + '°, наибольшее ' + fx(Math.max.apply(null, dvs), 2) + '°']]);
      var worst = cs.map(function (k, i) { return i; }).sort(function (a, b) { return cs[b].dev - cs[a].dev; }).slice(0, 15);
      h += rowsTable(worst.map(function (i) { var k = cs[i]; return [String(i + 1), fx(k.at[0], 2) + '; ' + fx(k.at[1], 2), fx(k.angle, 2), fx(k.dev, 2), fx(k.mmPerM, 1)]; }), ['№', 'X; Y, м', 'Угол, °', 'От 90°, °', 'мм на 1 м'], worst.map(function (i) { return cs[i].mmPerM > 3; }));
    }
    if (cmp) {
      var T = cmp.transform || {};
      h += '<h2 class="pb">Облако против проекта' + (o.dxfName ? ' — ' + esc(o.dxfName) : '') + '</h2>' + table([
        ['Совмещение', (T.mode === 'world' ? 'по координатам файла' : T.mode === 'none' ? 'без совмещения' : 'автоматически') + ', поворот ' + fx(T.rot, 3) + '°, единицы DXF — ' + esc(cmp.units)],
        ['Точек среза рядом с линиями', n(cmp.points, 0) + ' из ' + n(cmp.total, 0)],
        ['Ближе ' + fx(cmp.tol * 1000, 0) + ' мм', fx(cmp.within * 100, 1) + ' %'],
        ['Отклонение', 'медиана ' + fx(cmp.median, 1) + ' мм, среднее ' + fx(cmp.mean, 1) + ' мм, 95 % — до ' + fx(cmp.p95, 1) + ' мм'],
        ['Линии', cmp.lines.length + ', смещено ' + cmp.shifted + ', нет в облаке ' + cmp.missing]
      ]);
      var li = cmp.lines.map(function (x, i) { return i; }).filter(function (i) { return cmp.lines[i].length >= 0.5; })
        .sort(function (a, b) { var A = lineState(cmp.lines[a], cmp.tol), B = lineState(cmp.lines[b], cmp.tol); return ((A === 'совпадает') - (B === 'совпадает')) || (Math.abs(cmp.lines[b].offset || 0) - Math.abs(cmp.lines[a].offset || 0)); }).slice(0, 60);
      h += rowsTable(li.map(function (i) { var x = cmp.lines[i]; return [String(i + 1), x.layer || '', fx(x.length, 2), fx(x.offset, 1), fx(x.max, 1), fx(x.cover * 100, 0), lineState(x, cmp.tol)]; }),
        ['№', 'Слой', 'Длина, м', 'Смещение, мм', 'Наибольшее, мм', 'Покрытие, %', 'Итог'], li.map(function (i) { return lineState(cmp.lines[i], cmp.tol) !== 'совпадает'; }));
    }
    h += '<p class="note" style="margin-top:14px">Оценка по облаку точек, не заменяет инструментальный контроль. Точность ограничена шумом сканера и накопленным дрейфом траектории (у мобильных сканеров — несколько миллиметров на стенах). ' +
      'FF/FL рассчитаны по методике ASTM E1155 на сетке облака; допуски по СП 71.13330 заданы при запуске. Мебель, откосы и проёмы исключаются по плану, но могут попадать в отдельные грани — проверяйте развёртки. Сравнение с проектом — двумерное, по срезу на высоте проверки.</p>';
    return h + '</body></html>';
  }

  return { build: build, inspect: inspect, planSvg: planSvg, histSvg: histSvg, esc: esc };
});
