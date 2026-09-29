/* lixel-draw-ext.js — v1150
 * Расширение риббона «Рисование плоскости»: Дуга, Текст, Дверь, Окно,
 * Расширить, Разделить, Пересечение, Копирование, AI-извлечение.
 * Работает поверх window.__lxDrawUI (сессия Draw2D) и чистых функций LxGeom2D.
 */
(function () {
  'use strict';
  function ui() { return window.__lxDrawUI || null; }
  function D2() { return window.Draw2D || null; }
  function G() { return window.LxGeom2D || null; }
  function skin() { return document.documentElement.getAttribute('data-lxskin') === 'on'; }
  function toast(m) { try { var el = document.getElementById('toast'); if (el) { el.textContent = m; el.classList.add('show'); setTimeout(function () { el.classList.remove('show'); }, 2600); return; } } catch (e) {} try { console.log('[LX-DRAW-EXT]', m); } catch (e) {} }

  function sess() { var u = ui(); return u && u.session ? u.session() : null; }
  function redraw() { var u = ui(); if (u) { if (u.refreshLayers) u.refreshLayers(); if (u.draw) u.draw(); } }
  function mode(s) { return (s && s.projection) || 'top'; }
  function proj(p, m) { return D2().project(p, m); }
  function unproj(uv, m, fixed) { return D2().unproject(uv, m, fixed); }
  function fixedOf(e, m) { var ax = D2().fixedAxis(m); if (e.a) return e.a[ax]; if (e.p) return e.p[ax]; if (e.points && e.points[0]) return e.points[0][ax]; if (e.c) return e.c[ax]; return 0; }

  function lastOf(s, types) { for (var i = s.entities.length - 1; i >= 0; i--) { var e = s.entities[i]; if (types.indexOf(e.type) >= 0) return e; } return null; }
  function segOf(e) { // вернуть 2 конца отрезка из line/последнего сегмента polyline
    if (!e) return null;
    if (e.type === 'line') return [e.a, e.b];
    if (e.type === 'polyline' && e.points.length >= 2) return [e.points[e.points.length - 2], e.points[e.points.length - 1]];
    return null;
  }

  // Дуга: по 3 последним точкам черновика (или последней полилинии) → полилиния-аппроксимация
  function doArc() {
    var s = sess(); if (!s) return; var m = mode(s); var g = G(); if (!g) { toast('Геометрия не загружена'); return; }
    var pts3 = null, fixed = 0;
    if (s.draft && s.draft.length >= 3) { pts3 = s.draft.slice(-3); fixed = s.draft[0][D2().fixedAxis(m)]; }
    else { var e = lastOf(s, ['polyline']); if (e && e.points.length >= 3) { pts3 = e.points.slice(-3); fixed = fixedOf(e, m); } }
    if (!pts3) { toast('Дуга: начните полилинию из 3 точек (начало·середина·конец)'); return; }
    var a = proj(pts3[0], m), b = proj(pts3[1], m), c = proj(pts3[2], m);
    var arc = g.arcFrom3Points(a, b, c, { segments: 48 });
    if (!arc) { toast('Точки лежат на одной прямой — дуга невозможна'); return; }
    var pts = arc.points.map(function (uv) { return unproj(uv, m, fixed); });
    if (s.draft && s.draft.length >= 3) s.draft = s.draft.slice(0, -3);
    s.entities.push({ type: 'polyline', layer: 'ARC', closed: false, points: pts });
    redraw(); toast('Дуга: R=' + (Math.round(arc.radius * 1000) / 1000) + ' м, 48 сегм.');
  }

  function doText() {
    var s = sess(); if (!s) return; var m = mode(s);
    var txt = null; try { txt = window.prompt('Текст аннотации:', ''); } catch (e) {}
    if (txt == null || txt === '') return;
    // точка размещения: последняя вершина черновика или центр bbox чертежа
    var p = null;
    if (s.draft && s.draft.length) p = s.draft[s.draft.length - 1].slice();
    else { var bb = s.bbox(); if (bb) p = [(bb.mn[0] + bb.mx[0]) / 2, (bb.mn[1] + bb.mx[1]) / 2, (bb.mn[2] + bb.mx[2]) / 2]; else p = [0, 0, 0]; }
    s.entities.push({ type: 'text', layer: 'TEXT', p: p, h: 0.3, text: txt });
    redraw(); toast('Текст добавлен');
  }

  function doDoor() {
    var s = sess(); if (!s) return; var m = mode(s); var g = G(); if (!g) return;
    var e = lastOf(s, ['line', 'polyline']); var seg = segOf(e);
    if (!seg) { toast('Дверь: сначала нарисуйте линию проёма'); return; }
    var fixed = fixedOf(e, m);
    var p0 = proj(seg[0], m), p1 = proj(seg[1], m);
    var d = g.doorSymbol(p0, p1, { hinge: 'start', swing: 'ccw', segments: 24 });
    s.entities.push({ type: 'polyline', layer: 'DOOR', closed: false, points: d.jamb.map(function (uv) { return unproj(uv, m, fixed); }) });
    s.entities.push({ type: 'polyline', layer: 'DOOR', closed: false, points: d.leaf.map(function (uv) { return unproj(uv, m, fixed); }) });
    s.entities.push({ type: 'polyline', layer: 'DOOR', closed: false, points: d.swing.map(function (uv) { return unproj(uv, m, fixed); }) });
    redraw(); toast('Дверь: проём ' + (Math.round(d.width * 1000) / 1000) + ' м');
  }

  function doWindow() {
    var s = sess(); if (!s) return; var m = mode(s); var g = G(); if (!g) return;
    var e = lastOf(s, ['line', 'polyline']); var seg = segOf(e);
    if (!seg) { toast('Окно: сначала нарисуйте линию проёма'); return; }
    var fixed = fixedOf(e, m);
    var p0 = proj(seg[0], m), p1 = proj(seg[1], m);
    var w = g.windowSymbol(p0, p1, {});
    s.entities.push({ type: 'polyline', layer: 'WINDOW', closed: false, points: w.side1.map(function (uv) { return unproj(uv, m, fixed); }) });
    s.entities.push({ type: 'polyline', layer: 'WINDOW', closed: false, points: w.side2.map(function (uv) { return unproj(uv, m, fixed); }) });
    redraw(); toast('Окно: проём ' + (Math.round(w.thickness * 1000) / 1000) + ' м');
  }

  function doExtend() {
    var s = sess(); if (!s) return; var m = mode(s); var g = G(); if (!g) return;
    var lines = s.entities.filter(function (e) { return e.type === 'line'; });
    if (lines.length < 2) { toast('Расширить: нужны минимум 2 линии'); return; }
    var e1 = lines[lines.length - 1], e2 = lines[lines.length - 2];
    var fixed = fixedOf(e1, m);
    var s1a = proj(e1.a, m), s1b = proj(e1.b, m), s2a = proj(e2.a, m), s2b = proj(e2.b, m);
    var X = g.segIntersect(s1a, s1b, s2a, s2b, { infinite: true });
    if (!X) { toast('Линии параллельны — продление невозможно'); return; }
    // переносим ближайший конец e1 в точку пересечения
    var da = Math.hypot(s1a[0] - X[0], s1a[1] - X[1]), db = Math.hypot(s1b[0] - X[0], s1b[1] - X[1]);
    if (db <= da) e1.b = unproj(X, m, fixed); else e1.a = unproj(X, m, fixed);
    redraw(); toast('Расширено до пересечения');
  }

  function doSplit() {
    var s = sess(); if (!s) return; var g = G(); if (!g) return;
    var e = lastOf(s, ['polyline']); if (!e || e.points.length < 3) { toast('Разделить: нужна полилиния из ≥3 точек'); return; }
    var idx = Math.floor(e.points.length / 2);
    var parts = g.splitPolyline(e.points, idx);
    var i = s.entities.indexOf(e); s.entities.splice(i, 1);
    s.entities.push({ type: 'polyline', layer: e.layer || 'DRAW', closed: false, points: parts[0] });
    s.entities.push({ type: 'polyline', layer: e.layer || 'DRAW', closed: false, points: parts[1] });
    redraw(); toast('Разделено на вершине ' + idx);
  }

  function doIntersect() {
    var s = sess(); if (!s) return; var m = mode(s); var g = G(); if (!g) return;
    var lines = s.entities.filter(function (e) { return e.type === 'line'; });
    if (lines.length < 2) { toast('Пересечение: нужны минимум 2 линии'); return; }
    var e1 = lines[lines.length - 1], e2 = lines[lines.length - 2];
    var fixed = fixedOf(e1, m);
    var X = g.segIntersect(proj(e1.a, m), proj(e1.b, m), proj(e2.a, m), proj(e2.b, m), { infinite: false });
    if (!X) { toast('Отрезки не пересекаются'); return; }
    s.entities.push({ type: 'point', layer: 'ISECT', p: unproj(X, m, fixed) });
    redraw(); toast('Точка пересечения добавлена');
  }

  function doCopy() {
    var s = sess(); if (!s) return; var m = mode(s); var g = G(); if (!g) return;
    var e = lastOf(s, ['line', 'polyline', 'circle', 'point', 'text']); if (!e) { toast('Копирование: нет сущностей'); return; }
    var bb = s.bbox(); var off = bb ? Math.max(0.2, (bb.mx[0] - bb.mn[0]) * 0.1) : 0.5;
    function shift(p) { var q = p.slice(); q[0] += off; return q; }
    var c = { type: e.type, layer: (e.layer || 'DRAW') };
    if (e.type === 'line') { c.a = shift(e.a); c.b = shift(e.b); }
    else if (e.type === 'polyline') { c.closed = e.closed; c.points = e.points.map(shift); }
    else if (e.type === 'circle') { c.c = shift(e.c); c.r = e.r; }
    else if (e.type === 'point') { c.p = shift(e.p); }
    else if (e.type === 'text') { c.p = shift(e.p); c.h = e.h; c.text = e.text; }
    s.entities.push(c); redraw(); toast('Скопировано (смещение ' + (Math.round(off * 1000) / 1000) + ' м)');
  }

  // AI-извлечение: RANSAC-прямые по точкам сечения (слой SECTION) → стены/линии.
  function doAIExtract() {
    var s = sess(); if (!s) return; var m = mode(s); var g = G(); if (!g) return;
    var pts2 = [], fixedSum = 0, fixedN = 0, ax = D2().fixedAxis(m);
    s.entities.forEach(function (e) {
      if (e.type === 'polyline' && (e.layer === 'SECTION' || e.layer === 'DRAW')) {
        e.points.forEach(function (p) { pts2.push(proj(p, m)); fixedSum += p[ax]; fixedN++; });
      }
    });
    if (pts2.length < 20) { toast('AI-извлечение: сначала постройте сечение (мало точек)'); return; }
    var fixed = fixedN ? fixedSum / fixedN : 0;
    var segs = g.ransacLines(pts2, { tol: 0.05, minInliers: 12, iters: 400, maxLines: 12, seed: 1 });
    if (!segs || !segs.length) { toast('AI-извлечение: прямые не найдены'); return; }
    segs.forEach(function (sg) { s.entities.push({ type: 'line', layer: 'AI', a: unproj(sg[0], m, fixed), b: unproj(sg[1], m, fixed) }); });
    redraw(); toast('AI-извлечение: найдено ' + segs.length + ' прямых (слой AI)');
  }

  var ACTIONS = [
    ['Дуга', 'Дуга по 3 точкам черновика/полилинии', doArc],
    ['Текст', 'Текстовая аннотация', doText],
    ['Дверь', 'Символ двери на последней линии', doDoor],
    ['Окно', 'Символ окна на последней линии', doWindow],
    ['Расширить', 'Продлить линию до пересечения', doExtend],
    ['Разделить', 'Разделить полилинию пополам', doSplit],
    ['Пересечение', 'Точка пересечения 2 линий', doIntersect],
    ['Копирование', 'Копия последней сущности со смещением', doCopy],
    ['AI-извлечение', 'RANSAC-прямые по сечению', doAIExtract]
  ];

  var built = false;
  function build() {
    if (built || !skin()) return;
    var tb = document.querySelector('.toolbar .tbtns'); if (!tb) return;
    var grp = tb.querySelector('.tgroup[data-lxtab="draw"]'); if (!grp) return;
    var row = grp.querySelector('.tgrow') || grp;
    if (row.querySelector('#lxDrawExtTools')) return;
    var host = document.createElement('div'); host.id = 'lxDrawExtTools';
    host.style.display = 'flex'; host.style.gap = '4px'; host.style.alignItems = 'stretch'; host.style.flexWrap = 'wrap';
    ACTIONS.forEach(function (a) {
      var b = document.createElement('button'); b.className = 'btn lx-bigbtn'; b.type = 'button'; b.title = a[1];
      b.innerHTML = '<span class="lx-bic">▧</span><span class="lx-blabel">' + a[0] + '</span>';
      b.addEventListener('click', function () { try { a[2](); } catch (e) { toast('Ошибка: ' + (e && e.message || e)); } });
      host.appendChild(b);
    });
    row.appendChild(host); built = true;
    try { console.log('[LX-DRAW-EXT] инструменты рисования готовы · v1150'); } catch (e) {}
  }

  window.__lxDrawExt = { build: build, ops: { doArc: doArc, doText: doText, doDoor: doDoor, doWindow: doWindow, doExtend: doExtend, doSplit: doSplit, doIntersect: doIntersect, doCopy: doCopy, doAIExtract: doAIExtract } };
  if (typeof window !== 'undefined') {
    function boot() { build(); var n = 0; var iv = setInterval(function () { n++; if (built || n > 40) { clearInterval(iv); return; } build(); }, 250); }
    if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(boot, 350);
    else window.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 350); });
    try { var mo = new MutationObserver(function () { if (skin()) build(); }); mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-lxskin'] }); } catch (e) {}
  }
})();
