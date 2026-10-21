/*
 * cloud-report.js — PDF-отчёт по облаку точек (ревизия 27), как отчёт проекта в Lixel Studio.
 *
 * CloudReport.build({ ov, capacity, plan, maps, snapshot, fileName, project, appVersion, load, facts, storeys }) → строка HTML (A4).
 * HTML печатается в PDF главным процессом (bim:saveReportPdf: скрытое окно без JavaScript → printToPDF). Всё внутри — без внешних
 * ссылок: карты и снимок 3D — data:image, гистограмма высот и план — SVG.
 * Разделы: сведения о съёмке и облаке, геометрия, уровни и этажи, гистограмма высот, карты с маршрутом, план из облака (помещения,
 * проёмы, толщины стен), снимок 3D-вида, параметры загрузки и компьютер.
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
      bars += '<rect x="' + X(z).toFixed(1) + '" y="' + (Ht - 22 - bh).toFixed(1) + '" width="' + Math.max(0.8, X(z + H.step) - X(z)).toFixed(2) + '" height="' + bh.toFixed(1) + '" fill="#64748b"/>';
    }
    var marks = (levels || []).map(function (l) { var x = X(l.h).toFixed(1); return '<line x1="' + x + '" y1="8" x2="' + x + '" y2="' + (Ht - 22) + '" stroke="#0284c7" stroke-width="1.4"/><text x="' + x + '" y="8" font-size="10" fill="#0369a1" text-anchor="middle">' + n(l.h, 2) + '</text>'; }).join('');
    var ticks = '', step = Math.max(0.5, Math.pow(10, Math.floor(Math.log10(Math.max(0.1, h1 - h0)))) / (h1 - h0 < 3 ? 2 : 1));
    for (var t = Math.ceil(h0 / step) * step; t <= h1; t += step) ticks += '<text x="' + X(t).toFixed(1) + '" y="' + (Ht - 6) + '" font-size="10" fill="#475569" text-anchor="middle">' + n(t, step < 1 ? 1 : 0) + '</text>';
    return '<svg viewBox="0 0 ' + W + ' ' + Ht + '" width="100%" xmlns="http://www.w3.org/2000/svg"><line x1="40" y1="' + (Ht - 22) + '" x2="' + (W - 20) + '" y2="' + (Ht - 22) + '" stroke="#94a3b8"/>' + bars + marks + ticks +
      '<text x="' + (W - 20) + '" y="' + (Ht - 6) + '" font-size="10" fill="#475569" text-anchor="end">высота, м</text></svg>';
  }
  function planSvg(plan) {
    if (!plan || !plan.ok || !plan.faces || !plan.faces.length) return '';
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    plan.faces.forEach(function (f) { [f.a, f.b].forEach(function (p) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }); });
    var pad = Math.max(0.6, (x1 - x0) * 0.06), W = 700, s = Math.min((W - 20) / (x1 - x0 + 2 * pad), 560 / (y1 - y0 + 2 * pad)), Ht = (y1 - y0 + 2 * pad) * s + 10;
    var P = function (p) { return [((p[0] - x0 + pad) * s + 10).toFixed(1), ((y1 - p[1] + pad) * s + 5).toFixed(1)]; };
    var out = '';
    plan.faces.forEach(function (f) {
      var a = P(f.a), b = P(f.b);
      out += '<line x1="' + a[0] + '" y1="' + a[1] + '" x2="' + b[0] + '" y2="' + b[1] + '" stroke="#0f172a" stroke-width="2"/>';
      if (f.length >= 0.6) {
        var mx = (+a[0] + +b[0]) / 2, my = (+a[1] + +b[1]) / 2, ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
        if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
        out += '<text x="' + mx.toFixed(1) + '" y="' + (my - 4).toFixed(1) + '" font-size="9" fill="#0369a1" text-anchor="middle" transform="rotate(' + ang.toFixed(1) + ' ' + mx.toFixed(1) + ' ' + my.toFixed(1) + ')">' + Math.round(f.length * 1000) + '</text>';
      }
    });
    (plan.openings || []).forEach(function (o) { var a = P(o.a), b = P(o.b); out += '<line x1="' + a[0] + '" y1="' + a[1] + '" x2="' + b[0] + '" y2="' + b[1] + '" stroke="#ea580c" stroke-width="2" stroke-dasharray="5 3"/>'; });
    (plan.rooms || []).forEach(function (r) { var c = P(r.center); out += '<text x="' + c[0] + '" y="' + c[1] + '" font-size="11" font-weight="600" fill="#0f172a" text-anchor="middle">' + esc(r.name) + '</text><text x="' + c[0] + '" y="' + (+c[1] + 13) + '" font-size="10" fill="#334155" text-anchor="middle">' + n(r.area, 2) + ' м²</text>'; });
    return '<svg viewBox="0 0 ' + W + ' ' + Ht.toFixed(0) + '" width="100%" style="max-height:120mm" xmlns="http://www.w3.org/2000/svg">' + out + '</svg>';
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
    var plan = o.plan;
    if (plan && plan.ok) {
      h += '<h2 class="pb">План из облака</h2><div class="fig">' + planSvg(plan) + '<div class="cap">Грани стен (мм), проёмы — пунктир. Срез облака на заданной высоте над полом.</div></div>';
      if (plan.rooms && plan.rooms.length) h += table(plan.rooms.map(function (r) { return [r.name, n(r.area, 2) + ' м²', r.size ? n(r.size[0], 3) + ' × ' + n(r.size[1], 3) + ' м' : '']; }), ['Помещение', 'Площадь', 'Размеры (по осям плана)']);
      if (plan.openings && plan.openings.length) h += table(plan.openings.map(function (p, i) { return ['Проём ' + (i + 1), n(p.width * 1000, 0) + ' мм']; }), ['Проём', 'Ширина']);
      if (plan.walls && plan.walls.length) h += table(plan.walls.map(function (w, i) { return ['Стена ' + (i + 1), n(w.thickness * 1000, 0) + ' мм']; }), ['Стена (две грани)', 'Толщина']);
      h += '<p class="note">Точность размеров определяется плотностью и шумом облака в срезе (обычно ±5–10 мм у плотных сканов). Проверьте ключевые размеры инструментом «Расстояние».</p>';
    }
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
  return { build: build, planSvg: planSvg, histSvg: histSvg, esc: esc };
});
