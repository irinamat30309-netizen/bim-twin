/*
 * BIM Twin — ревизия 39: «BIM-модель по облаку».
 * Окно запуска и результата: весь файл облака (LAS/PLY/E57) → этажи, стены, витражи, окна, двери, колонны,
 * перекрытия, объекты площадки; выгрузка IFC4 / OBJ / DXF / отчёт рядом с облаком (main: bim:scan2bim).
 * Превью — собственная отрисовка на canvas (без вьювера): поворот мышью, масштаб колесом, этажи и слои.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CloudBimUI = api;
})(typeof window !== 'undefined' ? window : null, function (W) {
  'use strict';
  var D = W ? W.document : null;

  function bim() { return W && (W.bimAPI || W.bim) || null; }
  function kit() { return W && W.__lxKit || null; }
  function X() { return (W && W.Scan2BimExport) || (typeof require === 'function' ? require('./scan2bim-export.js') : null); }
  function toast(m, err) { var k = kit(); if (k && k.toast) { try { return k.toast(m, err ? { tone: 'err' } : undefined); } catch (_) {} } try { console.log('[bim] ' + m); } catch (_) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ic(n, s) { var k = kit(); return k && k.ic ? k.ic(n, s || 15) : ''; }
  function fmt(x, d) { return (+x || 0).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function baseName(p) { return String(p || '').split(/[\\/]/).pop(); }
  function stem(p) { return baseName(p).replace(/\.[^.]+$/, ''); }
  function jobId() { return 'bim-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function plural(n, a, b, c) { var m = Math.abs(n) % 100, d = m % 10; return n + ' ' + (m > 10 && m < 20 ? c : d === 1 ? a : d >= 2 && d <= 4 ? b : c); }
  function fmtBytes(b) { b = +b || 0; return b >= 1048576 ? fmt(b / 1048576, 1) + ' МБ' : fmt(b / 1024, 0) + ' КБ'; }

  // ---------------------------------------------------------------- сцена превью: грани призм из solids()
  var TYPE_LAYER = { wall: 'walls', parapet: 'walls', curtainwall: 'walls', fence: 'site', window: 'open', door: 'open', gate: 'open', slab: 'slabs', roof: 'slabs', column: 'columns', object: 'site', pipe: 'mep', cable: 'mep', cabletray: 'mep', duct: 'mep', beam: 'mep', pipefitting: 'mep', cabletrayfitting: 'mep', ductfitting: 'mep', cablefitting: 'mep' };
  function buildScene(model) {
    var E = X(); if (!E) return null;
    var S = E.solids(model), MAT = E.MAT || {}, faces = [], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    S.forEach(function (el) {
      var layer = TYPE_LAYER[el.type] || 'site';
      el.parts.forEach(function (pt) {
        var poly = pt.poly; if (!poly || poly.length < 3) return;
        var m = MAT[pt.mat || el.mat] || MAT.unknown || { color: [0.7, 0.7, 0.7] }, col = m.color, alpha = m.alpha || 1;
        var n = poly.length, z0 = pt.z0, z1 = pt.z1;
        for (var i = 0; i < n; i++) {
          var a = poly[i], b = poly[(i + 1) % n];
          faces.push({ p: [[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]], c: col, al: alpha, L: layer, s: el.storey, side: 1 });
          lo[0] = Math.min(lo[0], a[0]); lo[1] = Math.min(lo[1], a[1]); hi[0] = Math.max(hi[0], a[0]); hi[1] = Math.max(hi[1], a[1]);
        }
        lo[2] = Math.min(lo[2], z0); hi[2] = Math.max(hi[2], z1);
        faces.push({ p: poly.map(function (q) { return [q[0], q[1], z1]; }), c: col, al: alpha, L: layer, s: el.storey, side: 0 });
      });
    });
    if (!faces.length) return null;
    return { faces: faces, lo: lo, hi: hi, c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], R: Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2) };
  }
  // ортогональная проекция: yaw вокруг Z, pitch — наклон; рисование от дальних граней к ближним
  function drawScene(cv, sc, view) {
    var cx = cv.getContext('2d'), w = cv.width, h = cv.height;
    cx.fillStyle = '#f4f6f8'; cx.fillRect(0, 0, w, h);
    if (!sc) { cx.fillStyle = '#667'; cx.font = '14px sans-serif'; cx.fillText('Нет геометрии для превью', 20, 30); return; }
    var cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
    var s = view.zoom * Math.min(w, h) / (2.2 * sc.R), ox = w / 2 + view.px, oy = h / 2 + view.py, C = sc.c;
    var lx = 0.35, ly = -0.55, lz = 0.76, list = [];
    for (var i = 0; i < sc.faces.length; i++) {
      var f = sc.faces[i];
      if (!view.layers[f.L]) continue;
      if (view.storey >= 0 && f.s !== view.storey && f.L !== 'site') continue;
      if (view.storey >= 0 && f.L === 'site') continue;
      var P = f.p, Q = new Array(P.length), dsum = 0;
      for (var j = 0; j < P.length; j++) {
        var x = P[j][0] - C[0], y = P[j][1] - C[1], z = P[j][2] - C[2];
        var xr = x * cy - y * sy, yr = x * sy + y * cy;             // поворот в плане
        var sx = xr, sz = yr * sp + z * cp, d = yr * cp - z * sp;     // экран X, экран Y (вверх), глубина
        Q[j] = [ox + sx * s, oy - sz * s]; dsum += d;
      }
      // нормаль грани (мир) — для освещения
      var a = P[0], b = P[1], c = P[2] || P[1];
      var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = Math.hypot(nx, ny, nz) || 1;
      var sh = 0.55 + 0.45 * Math.abs((nx * lx + ny * ly + nz * lz) / nl);
      list.push({ q: Q, d: dsum / P.length, f: f, sh: sh });
    }
    list.sort(function (p, q) { return q.d - p.d; });
    cx.lineWidth = 0.6; cx.lineJoin = 'round';
    for (var k = 0; k < list.length; k++) {
      var it = list[k], col = it.f.c, Qk = it.q;
      cx.beginPath(); cx.moveTo(Qk[0][0], Qk[0][1]); for (var m = 1; m < Qk.length; m++) cx.lineTo(Qk[m][0], Qk[m][1]); cx.closePath();
      cx.globalAlpha = it.f.al < 1 ? 0.72 : 1;
      cx.fillStyle = 'rgb(' + Math.round(col[0] * 255 * it.sh) + ',' + Math.round(col[1] * 255 * it.sh) + ',' + Math.round(col[2] * 255 * it.sh) + ')';
      cx.fill(); cx.globalAlpha = 1;
      if (list.length < 40000) { cx.strokeStyle = 'rgba(40,48,60,0.35)'; cx.stroke(); }
    }
  }

  // вид по умолчанию — со стороны съёмки: от центра зоны здания к центру объектов площадки и наружных стен (южная сторона
  // могла не сниматься), чуть наискось
  function autoYaw(model) {
    var z = model.zone, P = [];
    (model.objects || []).forEach(function (o) { if (o.c) P.push(o.c); });
    (model.walls || []).forEach(function (w) { if ((w.role === 'site' || w.role === 'fence') && w.a && w.b) P.push([(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2]); });
    if (!z || z.length < 3 || !P.length) return -0.75;
    var zc = [0, 0]; z.forEach(function (p) { zc[0] += p[0] / z.length; zc[1] += p[1] / z.length; });
    var pc = [0, 0]; P.forEach(function (p) { pc[0] += p[0] / P.length; pc[1] += p[1] / P.length; });
    var dx = pc[0] - zc[0], dy = pc[1] - zc[1]; if (Math.hypot(dx, dy) < 1e-6) return -0.75;
    return Math.atan2(-dx, -dy) + 0.45;
  }

  // ---------------------------------------------------------------- таблицы результата
  function kpis(model) {
    var s = model.stats || {};
    return [[s.storeys, 'этажей'], [s.walls, 'стен'], [s.curtainWalls, 'витражей'], [s.windows, 'окон'], [s.doors + (s.gates || 0), 'дверей и ворот'], [s.columns, 'колонн'], [s.slabs, 'перекрытий'], [s.objects, 'объектов площадки']];
  }
  // ревизия 40: сводка сетей для боковой панели
  function mepRows(s) {
    var o = [];
    if (s.pipes) o.push(['Трубы', s.pipes + ' · ' + fmt(s.pipeLength, 1) + ' м']);
    if (s.trays) o.push(['Кабельные лотки', s.trays + ' · ' + fmt(s.trayLength, 1) + ' м']);
    if (s.cables) o.push(['Кабели', s.cables + ' · ' + fmt(s.cableLength, 1) + ' м']);
    if (s.ducts) o.push(['Воздуховоды', String(s.ducts)]);
    if (s.beams) o.push(['Балки', String(s.beams)]);
    // ревизия 41: стояки, узлы соединения, лестничные лотки и пучки кабелей
    if (s.risers) o.push(['Стояки', s.risers + ' · ' + fmt(s.riserLength, 1) + ' м']);
    if (s.fittings) o.push(['Узлы (отводы, тройники, переходы)', s.fittings + ' · ' + (s.elbows || 0) + ' / ' + (s.tees || 0) + ' / ' + (s.transitions || 0)]);
    if (s.ladderTrays) o.push(['Из них лестничных лотков', String(s.ladderTrays)]);
    if (s.bundles) o.push(['Из них пучков кабелей', String(s.bundles)]);
    return o;
  }
  function materials(model) {
    var E = X(), MAT = (E && E.MAT) || {}, m = {};
    (model.walls || []).forEach(function (w) { if (w.role !== 'wall') return; var k = w.curtain ? 'glass' : (w.material || 'unknown'); m[k] = (m[k] || 0) + (w.length || 0); });
    return Object.keys(m).sort(function (a, b) { return m[b] - m[a]; }).map(function (k) { return { key: k, name: (MAT[k] || MAT.unknown || { name: k }).name, length: m[k], color: (MAT[k] || MAT.unknown || { color: [0.7, 0.7, 0.7] }).color }; });
  }
  function objectsByKind(model) {
    var r = {}; (model.objects || []).forEach(function (o) { var k = o.name || o.kind; r[k] = (r[k] || 0) + 1; });
    return Object.keys(r).sort(function (a, b) { return r[b] - r[a]; }).map(function (k) { return [k, r[k]]; });
  }
  function storeyRows(model) {
    return (model.storeys || []).map(function (st) {
      var ws = (model.walls || []).filter(function (w) { return w.storey === st.index && w.role === 'wall'; }), win = 0, door = 0;
      ws.forEach(function (w) { (w.openings || []).forEach(function (q) { if (q.kind === 'window') win++; else door++; }); });
      return { index: st.index, name: st.name, z: st.z != null ? st.z : st.h, height: st.height, walls: ws.length, windows: win, doors: door, length: ws.reduce(function (a, w) { return a + w.length; }, 0) };
    });
  }

  // ---------------------------------------------------------------- запуск
  async function open(path, ov, st) {
    var A = bim(), k = kit();
    if (!A || !A.cloudScan2Bim || !k || !k.form) { toast('BIM-модель по облаку доступна в настольной версии', true); return null; }
    var fields = [
      { key: 'write', label: 'Сохранить IFC, OBJ, DXF и отчёт рядом с облаком', type: 'checkbox', value: true, hint: 'Папка «' + stem(path) + '-bim» рядом с файлом облака; исходный файл не меняется' },
      { key: 'mep', label: 'Инженерные сети под потолком', type: 'checkbox', value: true, hint: 'Трубы (диаметр, DN, красные — пожаротушение), стояки, кабельные лотки (и лестничные), кабели и пучки, воздуховоды, балки, отводы и тройники — в IFC, OBJ и DXF' },
      { key: 'slabT', more: true, label: 'Толщина перекрытий', type: 'number', value: 0.2, step: 0.01, min: 0.05, max: 1, unit: 'м', hint: 'Нижняя сторона перекрытия часто не снята — толщина задаётся' }
    ];
    if (st && st.rect) fields.push({ key: 'onlyRect', label: 'Только область с карты', type: 'checkbox', value: false });
    var npt = ov && ov.file && ov.file.points || 0;
    var v = await k.form({ title: 'BIM-модель по облаку', wide: true, className: 'lx-compact',
      short: 'Стены, окна, двери, перекрытия и сети — автоматически.',
      message: 'Этажи, стены и витражи с членением, окна и двери, материалы, колонны, перекрытия, инженерные сети и объекты площадки. Три прохода по всему файлу' + (npt ? ' (' + fmt(npt / 1e6, 0) + ' млн точек — около ' + Math.max(1, Math.round(npt / 9e5 / 60)) + ' мин)' : '') + '.',
      fields: fields, okLabel: 'Построить' });
    if (!v) return null;
    var id = jobId(), act = k.activity ? k.activity('BIM-модель по облаку…') : null;
    var off = A.onCloudPlanProgress ? A.onCloudPlanProgress(id, function (p, l) { if (act) act.set(Math.max(0, Math.min(1, +p || 0)), l || 'BIM-модель по облаку…'); }) : function () {};
    var t0 = Date.now(), r;
    try { r = await A.cloudScan2Bim({ path: path, jobId: id, write: v.write !== false, slabT: v.slabT, mep: v.mep !== false, rect: v.onlyRect && st && st.rect ? st.rect : null }); }
    catch (e) { r = { ok: false, message: String((e && e.message) || e) }; }
    finally { off(); if (act) act.done(); }
    if (!r || !r.ok || !r.model || !r.model.ok) { toast('BIM-модель не построена: ' + ((r && (r.message || (r.model && r.model.message))) || 'нет данных'), true); return r || null; }
    r.elapsed = (Date.now() - t0) / 1000;
    if (r.message) toast(r.message, true);
    return show(path, r);
  }

  // ---------------------------------------------------------------- окно результата
  function show(path, r) {
    var k = kit(), A = bim(), model = r.model, back = D.createElement('div'); back.className = 'modal bp-modal ins-modal s2b-modal';
    var sc = buildScene(model), yaw0 = autoYaw(model), view = { yaw: yaw0, pitch: 0.45, zoom: 1.25, px: 0, py: 0, storey: -1, layers: { walls: true, open: true, slabs: true, columns: true, mep: true, site: true } };
    var s = model.stats || {}, E = X();
    var sub = baseName(path) + ' · ' + plural(s.storeys || 0, 'этаж', 'этажа', 'этажей') + ' · стен ' + fmt(s.wallLength, 0) + ' м' + (r.elapsed ? ' · ' + fmt(r.elapsed, 0) + ' с' : '');
    var rows = storeyRows(model), mats = materials(model), objs = objectsByKind(model), warn = model.warnings || [];
    var files = r.files || [];
    back.innerHTML =
      '<div class="modal-card bp-card ins-card" role="dialog" aria-modal="true" aria-labelledby="s2bTitle">' +
      '<div class="modal-head"><span id="s2bTitle">BIM-модель по облаку</span><span class="bp-headsub">' + esc(sub) + '</span><button type="button" class="x" data-ico="x" aria-label="Закрыть"></button></div>' +
      '<div class="bp-body"><div class="bp-mapcol"><div class="bp-map s2b-map"><canvas></canvas>' +
        '<div class="bp-over bp-tl"><div class="bp-seg" role="group" aria-label="Слои">' +
          [['walls', 'Стены'], ['open', 'Проёмы'], ['slabs', 'Перекрытия'], ['columns', 'Колонны'], ['mep', 'Сети'], ['site', 'Площадка']].map(function (x) { return '<button type="button" class="on" data-layer="' + x[0] + '">' + x[1] + '</button>'; }).join('') +
        '</div></div>' +
        '<div class="bp-maphint">перетаскивание — поворот, Shift — сдвиг, колесо — масштаб</div></div></div>' +
      '<div class="bp-side ins-side">' +
        '<div class="bp-kpis">' + kpis(model).map(function (x) { return '<div class="bp-kpi"><b>' + esc(x[0] == null ? 0 : x[0]) + '</b><span>' + esc(x[1]) + '</span></div>'; }).join('') + '</div>' +
        '<section><h4>Этажи</h4><table class="bp-facts s2b-storeys"><tr><th></th><th>Отметка</th><th>Высота</th><th>Стен</th><th>Окон</th><th>Дверей</th></tr>' +
          '<tr data-st="-1" class="sel"><td>Всё здание</td><td></td><td></td><td>' + (s.walls || 0) + '</td><td>' + (s.windows || 0) + '</td><td>' + ((s.doors || 0) + (s.gates || 0)) + '</td></tr>' +
          rows.map(function (x) { return '<tr data-st="' + x.index + '"><td>' + esc(x.name) + '</td><td>' + fmt(x.z, 2) + '</td><td>' + fmt(x.height, 2) + '</td><td>' + x.walls + '</td><td>' + x.windows + '</td><td>' + x.doors + '</td></tr>'; }).join('') + '</table></section>' +
        '<section><h4>Материалы стен</h4><table class="bp-facts">' + mats.map(function (m) { return '<tr><td><i class="s2b-sw" style="background:rgb(' + m.color.map(function (c) { return Math.round(c * 255); }).join(',') + ')"></i>' + esc(m.name) + '</td><td>' + fmt(m.length, 0) + ' м</td></tr>'; }).join('') + '</table></section>' +
        (s.mep ? '<section><h4>Инженерные сети</h4><table class="bp-facts">' + mepRows(s).map(function (x) { return '<tr><td>' + esc(x[0]) + '</td><td>' + x[1] + '</td></tr>'; }).join('') + '</table></section>' : '') +
        (objs.length ? '<section><h4>Объекты площадки</h4><table class="bp-facts">' + objs.map(function (o) { return '<tr><td>' + esc(o[0]) + '</td><td>' + o[1] + '</td></tr>'; }).join('') + '</table></section>' : '') +
        (files.length ? '<section><h4>Файлы' + (r.dir ? ' — ' + esc(baseName(r.dir)) : '') + '</h4><table class="bp-facts">' + files.map(function (f) { return '<tr><td>' + esc(f.name) + '</td><td>' + fmtBytes(f.size) + '</td></tr>'; }).join('') + '</table></section>' : '') +
        '<section><h4>Ограничения</h4><ul class="s2b-notes">' + warn.concat([
          'перекрытия — по контуру стен этажа (выпуклая оболочка), если низ перекрытия не снят',
          'толщина стен, снятых с одной стороны, — типовая для материала',
          'закрытые, затенённые и бликующие проёмы могут быть пропущены — проверьте по облаку'
        ]).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section>' +
      '</div></div>' +
      '<div class="form-actions bp-actions">' +
        '<button type="button" class="btn sm ghost" data-act="ifc" title="Сохранить IFC4 в выбранное место">' + ic('box') + ' IFC</button>' +
        '<button type="button" class="btn sm ghost" data-act="obj" title="Сохранить OBJ (с материалами в комментариях групп)">' + ic('cuboid') + ' OBJ</button>' +
        '<button type="button" class="btn sm ghost" data-act="dxf" title="Планы этажей в DXF">' + ic('pencil-ruler') + ' DXF</button>' +
        (r.dir && A && A.cloudScan2BimReveal ? '<button type="button" class="btn sm ghost" data-act="reveal" title="Открыть папку с выгрузкой">' + ic('folder-open') + ' Папка</button>' : '') +
        '<div class="bp-est">' + esc(E && E.summary ? E.summary(model).split('\n')[1] || '' : '') + '</div>' +
        '<button type="button" class="btn sm primary" data-act="close">Закрыть</button></div></div>';
    var q = function (x) { return back.querySelector(x); }, cv = q('.s2b-map canvas'), mapEl = q('.s2b-map'), raf = 0;
    function paint() {
      raf = 0; var rr = mapEl.getBoundingClientRect(), dpr = W.devicePixelRatio || 1;
      var w = Math.max(200, Math.round(rr.width * dpr)), h = Math.max(200, Math.round(rr.height * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; cv.style.width = '100%'; cv.style.height = '100%'; }
      drawScene(cv, sc, view);
    }
    function later() { if (!raf) raf = (W.requestAnimationFrame || setTimeout)(paint); }
    back.querySelectorAll('[data-layer]').forEach(function (b) { b.onclick = function () { var L = b.getAttribute('data-layer'); view.layers[L] = !view.layers[L]; b.classList.toggle('on', view.layers[L]); later(); }; });
    back.querySelectorAll('tr[data-st]').forEach(function (tr) { tr.onclick = function () { view.storey = +tr.getAttribute('data-st'); back.querySelectorAll('tr[data-st]').forEach(function (t) { t.classList.toggle('sel', t === tr); }); later(); }; });
    var drag = null;
    function mv(e) { if (!drag) return; var dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) { var dpr = W.devicePixelRatio || 1; view.px += dx * dpr; view.py += dy * dpr; } else { view.yaw += dx * 0.01; view.pitch = Math.max(-0.1, Math.min(1.55, view.pitch + dy * 0.01)); } later(); }
    function up() { drag = null; }
    cv.addEventListener('mousedown', function (e) { if (e.button !== 0 && e.button !== 1) return; e.preventDefault(); drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 1 }; });
    cv.addEventListener('wheel', function (e) { e.preventDefault(); view.zoom = Math.max(0.2, Math.min(30, view.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); later(); }, { passive: false });
    cv.addEventListener('dblclick', function () { view.yaw = yaw0; view.pitch = 0.45; view.zoom = 1.25; view.px = view.py = 0; later(); });
    D.addEventListener('mousemove', mv); D.addEventListener('mouseup', up);
    async function save(kind, btn) {
      var EE = X(); if (!EE || !A || !A.exportFile) { toast('Сохранение доступно в настольной версии', true); return; }
      if (k && k.busy) k.busy(btn, true);
      try {
        var name = stem(path), text, ext, filterName;
        if (kind === 'ifc') { text = EE.toIFC(model, { name: name, fileName: name + '.ifc' }).text; ext = 'ifc'; filterName = 'IFC4'; }
        else if (kind === 'obj') { text = EE.toOBJ(model, { mtlName: name + '-bim.mtl' }).obj; ext = 'obj'; filterName = 'Wavefront OBJ'; }
        else { text = EE.toDXF(model); ext = 'dxf'; filterName = 'Чертёж AutoCAD DXF'; }
        var sv = await A.exportFile({ text: text, ext: ext, name: name + '-bim.' + ext, title: 'Сохранить ' + ext.toUpperCase(), filterName: filterName });
        if (sv && sv.ok) toast('Сохранено: ' + baseName(sv.path)); else if (!(sv && sv.canceled)) toast('Не удалось сохранить: ' + ((sv && sv.error) || ''), true);
      } catch (e) { toast('Ошибка выгрузки: ' + ((e && e.message) || e), true); }
      finally { if (k && k.busy) k.busy(btn, false); }
    }
    q('[data-act="ifc"]').onclick = function () { save('ifc', this); };
    q('[data-act="obj"]').onclick = function () { save('obj', this); };
    q('[data-act="dxf"]').onclick = function () { save('dxf', this); };
    if (q('[data-act="reveal"]')) q('[data-act="reveal"]').onclick = async function () { try { var x = await A.cloudScan2BimReveal(r.dir); if (!x || !x.ok) toast('Не удалось открыть папку: ' + ((x && (x.message || x.error)) || ''), true); } catch (e) { toast(String(e), true); } };
    var done = false;
    function close() {
      if (done) return; done = true;
      D.removeEventListener('keydown', onKey, true); W.removeEventListener('resize', later); D.removeEventListener('mousemove', mv); D.removeEventListener('mouseup', up);
      back.classList.add('closing'); setTimeout(function () { if (back.parentNode) back.parentNode.removeChild(back); }, 140);
    }
    function onKey(e) { if (e.key === 'Escape' && back.parentNode && !D.querySelector('.modal.lx-ask')) { e.preventDefault(); e.stopPropagation(); close(); } }
    q('.modal-head .x').onclick = close; q('[data-act="close"]').onclick = close;
    D.addEventListener('keydown', onKey, true); W.addEventListener('resize', later);
    D.body.appendChild(back); if (k && k.hydrate) k.hydrate(back); back.classList.add('open');
    if (!D.getElementById('s2bStyle')) { var stl = D.createElement('style'); stl.id = 's2bStyle'; stl.textContent = '.s2b-map{cursor:grab}.s2b-map canvas{display:block}.s2b-storeys tr[data-st]{cursor:pointer}.s2b-storeys tr.sel td{background:rgba(80,140,255,.14)}.s2b-sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}.s2b-modal .bp-facts td:first-child,.s2b-modal .bp-facts th:first-child{text-align:left}.s2b-notes{margin:4px 0 0 16px;padding:0;font-size:12px;opacity:.8}'; D.head.appendChild(stl); }
    later();
    return { model: model, dir: r.dir, files: files, close: close, view: view, paint: paint };
  }

  return { open: open, show: show, autoYaw: autoYaw, buildScene: buildScene, drawScene: drawScene, kpis: kpis, materials: materials, storeyRows: storeyRows, objectsByKind: objectsByKind };
});
