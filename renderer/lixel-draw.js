/*
 * lixel-draw.js — Спринт 2 (v1087): браузерная связка черчения по облаку.
 * Вкладка «Рисование плоскости», SVG-оверлей, хук __lxDraw, экспорт/импорт DXF.
 * 4 новых возможности: привязки, орто/вид сверху, импорт DXF + слои, размеры.
 * Логика — в draw2d.js / dxf.js / snap.js / dxfparse.js. Гард data-lxskin=on.
 */
(function () {
  'use strict';
  var SVGNS = 'http://www.w3.org/2000/svg';

  function on() { return document.documentElement.getAttribute('data-lxskin') === 'on'; }
  function svg(inner) {
    return '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }
  var IC = {
    pline:  svg('<path d="M3 17l6-8 4 5 8-9"/><circle cx="3" cy="17" r="1.4" fill="currentColor"/><circle cx="9" cy="9" r="1.4" fill="currentColor"/><circle cx="13" cy="14" r="1.4" fill="currentColor"/><circle cx="21" cy="5" r="1.4" fill="currentColor"/>'),
    line:   svg('<path d="M4 20L20 4"/><circle cx="4" cy="20" r="1.6" fill="currentColor"/><circle cx="20" cy="4" r="1.6" fill="currentColor"/>'),
    rect:   svg('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
    circle: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>'),
    point:  svg('<circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>'),
    dim:    svg('<path d="M4 8v8M20 8v8M4 12h16"/><path d="M7 9l-3 3 3 3M17 9l3 3-3 3"/>'),
    snap:   svg('<path d="M6 4v7a6 6 0 0 0 12 0V4"/><path d="M6 8h4M14 8h4"/>'),
    top:    svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16M9 4v16"/>'),
    imp:    svg('<path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/><path d="M12 3v11M8 10l4 4 4-4"/>'),
    sect:   svg('<path d="M4 8l8-4 8 4"/><path d="M3 12h18"/><path d="M7 12v6M12 12v6M17 12v6"/>'),
    close:  svg('<path d="M4 6l8 4 8-4M12 10v10"/><path d="M4 6v12l8 4 8-4V6"/>'),
    undo:   svg('<path d="M9 7L4 12l5 5"/><path d="M4 12h11a5 5 0 0 1 0 10h-1"/>'),
    clear:  svg('<path d="M6 7h12M9 7V5h6v2M8 7l1 13h6l1-13"/>'),
    dxf:    svg('<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v4h4"/><path d="M9 13l2 3-2 3M15 13l-2 3 2 3"/>')
  };

  var HINTS = {
    polyline: 'Полилиния: кликай точки по облаку • «Замкнуть» или двойной клик — завершить',
    line: 'Линия: укажи две точки',
    rect: 'Прямоугольник: укажи два противоположных угла',
    circle: 'Окружность: центр, затем точка на радиусе',
    point: 'Точка: кликай по облаку',
    dim: 'Размер: укажи две точки — подпишется длина'
  };

  var S = null; // Draw2D.Session
  var overlay = null, hintEl = null, stageEl = null, fileInput = null;
  var hover = null; // {x,y} client coords курсора
  var lastTool = 'polyline';

  // —— состояние новых функций ——
  var snapOn = true;          // привязки
  var orthoOn = false;        // орто-ограничение при черчении (углы 45°)
  var hiddenLayers = {};      // скрытые слои
  var lastSnap = null;        // {uv,type,mode,fixed} — последняя привязка для маркера
  var sectThickness = 0.2, sectCell = 0.1;   // параметры сечения облака
  var projectDrawingReady = false, drawingSaveTimer = null, lastDrawingStateJson = '';
  var lastSectionStats = null;
  var activeSectionJob = null, nextSectionJobId = 1;
  var maxSectionWorkerBytes = 128 * 1024 * 1024;
  var dxfFramePreference = 'source'; // source | local
  var dxfFrameSelectTouched = false;
  var lastRestoredDrawingToken = '';

  function session() {
    if (!S && window.Draw2D) S = new window.Draw2D.Session({ tool: lastTool, projection: 'top', layer: 'DRAW' });
    return S;
  }
  function drawingSnapshot(s) {
    s = s || session();
    if (!s) return null;
    return { id: 'active-drawing', tool: s.tool || lastTool, projection: s.projection || 'top', layer: s.layer || 'DRAW',
      entities: s.entities || [], draft: s.draft || null, hiddenLayers: hiddenLayers };
  }
  function scheduleDrawingSave(s) {
    if (!projectDrawingReady || drawingSaveTimer) { if (!projectDrawingReady) return; clearTimeout(drawingSaveTimer); }
    var snapshot = drawingSnapshot(s);
    if (!snapshot) return;
    var encoded;
    try { encoded = JSON.stringify(snapshot); } catch (_) { return; }
    if (encoded === lastDrawingStateJson) return;
    drawingSaveTimer = setTimeout(function () {
      drawingSaveTimer = null;
      var ps = window.BimProjectState;
      if (!ps || !ps.update) return;
      lastDrawingStateJson = encoded;
      ps.update({ drawings: [snapshot] }).catch(function (e) { lastDrawingStateJson = ''; try { console.warn('[drawing] project save failed', e); } catch (_) {} });
    }, 650);
  }
  function restoreDrawingState() {
    var ps = window.BimProjectState;
    if (!ps || !ps.ready) { projectDrawingReady = true; return; }
    function apply(data, revision) {
      var token = String(ps.projectId || '') + ':' + String(revision == null ? ps.revision || 0 : revision);
      if (token === lastRestoredDrawingToken) return;
      lastRestoredDrawingToken = token;
      var drawing = data && Array.isArray(data.drawings) && data.drawings.find(function (d) { return d && (d.id === 'active-drawing' || d.id === 'legacy-active-drawing'); });
      var s = session();
      if (s) {
        s.tool = drawing && drawing.tool || 'polyline';
        s.projection = drawing && drawing.projection || 'top';
        s.layer = drawing && drawing.layer || 'DRAW';
        s.entities = drawing && Array.isArray(drawing.entities) ? drawing.entities : [];
        s.draft = drawing && Array.isArray(drawing.draft) && drawing.draft.length ? drawing.draft : null;
        hiddenLayers = drawing && drawing.hiddenLayers && typeof drawing.hiddenLayers === 'object' ? drawing.hiddenLayers : {};
        lastTool = s.tool;
        API.tool = s.tool;
      }
      projectDrawingReady = true;
      try { lastDrawingStateJson = JSON.stringify(drawingSnapshot()); } catch (_) { lastDrawingStateJson = ''; }
      refreshLayers(); draw();
    }
    ps.ready.then(function (data) { apply(data, ps.revision); })
      .catch(function (e) { projectDrawingReady = true; try { console.warn('[drawing] restore failed', e); } catch (_) {} });
    window.addEventListener('bim-project-state-ready', function (ev) {
      var d = ev && ev.detail || {};
      apply(d.state, d.revision);
    });
    window.addEventListener('bim-project-state-restored', function (ev) {
      var d = ev && ev.detail || {};
      apply(d.state, d.revision);
    });
  }
  function viewer() { return window.__viewer || window.__lxViewer || null; }

  function sourceTransform() {
    var v = viewer(), tr = v && v._srcXform;
    if (!tr || (tr.axis !== 'zup' && tr.axis !== 'yup') || !tr.t || tr.t.length < 3) return null;
    var t = [Number(tr.t[0]), Number(tr.t[1]), Number(tr.t[2])];
    if (!t.every(Number.isFinite)) return null;
    return { axis: tr.axis, t: t };
  }

  function syncDxfFrameSelect() {
    var sel = document.getElementById('lxDxfFrame');
    if (!sel) return;
    var sourceOpt = sel.querySelector('option[value="source"]');
    var s = session(), mode = s && s.projection || 'top';
    var supported = !!sourceTransform() && mode === 'top';
    if (sourceOpt) sourceOpt.disabled = !supported;
    if (!dxfFrameSelectTouched && supported) dxfFramePreference = 'source';
    sel.value = supported ? dxfFramePreference : 'local';
    sel.title = supported
      ? '«Исходные»: использовать координаты активного проекта. Для импорта DXF исходный CRS должен совпадать с CRS облака.'
      : 'Исходные координаты доступны для геопривязанного облака в проекции сверху. Сейчас будет выбран локальный DXF.';
  }

  // —— проекции 3D<->2D плоскости ——
  // top: (X,Z) fix Y | front: (X,Y) fix Z | side: (Z,Y) fix X
  function project(p, mode) {
    if (mode === 'front') return [p[0], p[1]];
    if (mode === 'side') return [p[2], p[1]];
    return [p[0], p[2]];
  }
  function unproject(uv, mode, fixed) {
    if (mode === 'front') return [uv[0], uv[1], fixed];
    if (mode === 'side') return [fixed, uv[1], uv[0]];
    return [uv[0], fixed, uv[1]];
  }

  // пикселей на 1 мировую единицу вдоль первой оси плоскости (для допуска привязки)
  function pxPerWorld(wp, mode) {
    var v = viewer(); if (!v || !v.worldToScreen) return 0;
    var off = mode === 'side' ? [wp[0], wp[1], wp[2] + 1] : [wp[0] + 1, wp[1], wp[2]];
    var a = v.worldToScreen(wp), b = v.worldToScreen(off);
    if (!a || !b) return 0;
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  // сущности в 2D плоскости для движка привязок
  function planeEntities(s, mode) {
    var out = [];
    s.entities.forEach(function (e) {
      if (e.layer && hiddenLayers[e.layer]) return;
      if (e.type === 'line') out.push({ type: 'line', a: project(e.a, mode), b: project(e.b, mode) });
      else if (e.type === 'dim') out.push({ type: 'line', a: project(e.a, mode), b: project(e.b, mode) });
      else if (e.type === 'polyline') out.push({ type: 'polyline', points: e.points.map(function (p) { return project(p, mode); }), closed: e.closed });
      else if (e.type === 'point') out.push({ type: 'point', p: project(e.p, mode) });
      else if (e.type === 'text') out.push({ type: 'point', p: project(e.p, mode) });
      else if (e.type === 'circle') out.push({ type: 'circle', c: project(e.c, mode), r: e.r });
    });
    return out;
  }

  // привязка + орто для мировой точки пика
  function snapWorld(wp) {
    var s = session(); if (!s) return wp;
    var mode = s.projection || 'top';
    var fixed = mode === 'front' ? wp[2] : (mode === 'side' ? wp[0] : wp[1]);
    var cur = project(wp, mode);
    lastSnap = null;
    // орто-ограничение относительно последней точки черновика
    if (orthoOn && window.Snap && s.draft && s.draft.length) {
      var base = project(s.draft[s.draft.length - 1], mode);
      var oc = window.Snap.orthoConstrain(base, cur, { angleStep: Math.PI / 4 });
      if (oc) cur = oc;
    }
    // привязка к геометрии
    if (snapOn && window.Snap) {
      var ppw = pxPerWorld(wp, mode) || 60;
      var tolW = 12 / ppw;
      var ents = planeEntities(s, mode);
      var extra = (s.draft || []).map(function (p) { return project(p, mode); });
      var r = window.Snap.snap(cur, ents, { tol: tolW, vertex: true, intersection: true, midpoint: true, grid: false, extraPoints: extra });
      if (r && r.point) { cur = r.point; lastSnap = { uv: r.point, type: r.type, mode: mode, fixed: fixed }; }
    }
    return unproject(cur, mode, fixed);
  }

  // —— хук, который дёргает вьюер ——
  var API = {
    active: false,
    tool: 'polyline',
    onPick: function (worldPt) {
      var s = session(); if (!s || !worldPt) return;
      var p = snapWorld([worldPt[0], worldPt[1], worldPt[2]]);
      s.addVertex(p);
      draw();
    },
    onHover: function (cx, cy) { hover = { x: cx, y: cy }; draw(); }
  };
  window.__lxDraw = API;

  function setActive(tool) {
    var s = session(); if (!s) return;
    if (API.active && API.tool === tool) { deactivate(); return; }
    if (window.__lxWorkspace) window.__lxWorkspace.exitTools('draw');
    s.commit(); s.setTool(tool);
    API.active = true; API.tool = tool; lastTool = tool;
    var v = viewer();
    if (v && v.setMeasure && v.measuring) { try { v.setMeasure(false); } catch (e) {} }
    if (v && v.canvas) { try { v.canvas.style.cursor = 'crosshair'; } catch (e) {} }
    updateToolButtons();
    showHint(HINTS[tool] || '');
    ensureOverlay(); draw();
  }
  function deactivate(cancel) {
    var s = session(); if (s) { if (cancel) s.draft = null; else s.commit(); }
    API.active = false;
    var v = viewer(); if (v && v.canvas) { try { v.canvas.style.cursor = 'grab'; } catch (e) {} }
    updateToolButtons(); showHint(''); draw();
  }

  function updateToolButtons() {
    var wrap = document.getElementById('lxDrawTools'); if (!wrap) return;
    var btns = wrap.querySelectorAll('[data-dtool]');
    Array.prototype.forEach.call(btns, function (b) {
      b.classList.toggle('lx-dactive', API.active && b.getAttribute('data-dtool') === API.tool);
    });
  }

  // Do not present empty drawing-history actions as clickable no-ops.
  // Keep their availability and accessible explanation in sync with the
  // current draft/entities whenever the drawing session changes.
  function syncActionButtons(s) {
    s = s || session();
    if (!s) return;
    var draftLength = s.draft && s.draft.length || 0;
    var hasHistory = draftLength > 0 || s.entities.length > 0;
    var states = [
      {
        id: 'lxClosePathBtn',
        enabled: API.active && API.tool === 'polyline' && draftLength >= 2,
        title: API.active && API.tool === 'polyline'
          ? (draftLength < 2 ? 'Замкнуть полилинию: добавьте ещё одну точку' : 'Замкнуть текущую полилинию')
          : 'Замкнуть: сначала выберите инструмент «Полилиния»'
      },
      {
        id: 'lxUndoDrawBtn',
        enabled: hasHistory,
        title: hasHistory ? 'Отменить последнюю точку или объект чертежа' : 'Отмена: пока нечего отменять'
      },
      {
        id: 'lxClearDrawBtn',
        enabled: hasHistory,
        title: hasHistory ? 'Очистить все объекты и черновик чертежа' : 'Очистить: чертёж пока пуст'
      }
    ];
    states.forEach(function (state) {
      var b = document.getElementById(state.id);
      if (!b) return;
      b.disabled = !state.enabled;
      b.setAttribute('aria-disabled', String(!state.enabled));
      b.title = state.title;
    });
  }

  function showHint(txt) {
    if (!txt) { if (hintEl) hintEl.style.display = 'none'; return; }
    if (!hintEl && stageEl) { hintEl = document.createElement('div'); hintEl.className = 'lx-drawhint'; stageEl.appendChild(hintEl); }
    if (hintEl) { hintEl.textContent = txt; hintEl.style.display = ''; }
  }

  // —— построение кнопок вкладки ——
  function bigBtn(icon, label, primary) {
    var b = document.createElement('button');
    b.className = 'btn lx-bigbtn' + (primary ? ' lx-primary' : '');
    b.innerHTML = '<span class="lx-bic">' + (IC[icon] || '') + '</span><span class="lx-blabel">' + label + '</span>';
    b.title = label;
    return b;
  }

  function ensureFileInput() {
    if (fileInput) return fileInput;
    fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.accept = '.dxf,.txt'; fileInput.style.display = 'none';
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () { importText(String(rd.result), f.name); };
      rd.readAsText(f); fileInput.value = '';
    });
    (document.body || document.documentElement).appendChild(fileInput);
    return fileInput;
  }

  function buildTab() {
    if (!on()) return;
    var tb = document.querySelector('.toolbar .tbtns'); if (!tb) return;
    var grp = tb.querySelector('.tgroup[data-lxtab="draw"]'); if (!grp) return;
    if (grp.querySelector('#lxDrawTools')) return; // уже построено
    var row = grp.querySelector('.tgrow') || grp;
    var soon = row.querySelector('.lx-soon'); if (soon) soon.remove();

    var host = document.createElement('div');
    host.id = 'lxDrawTools';
    host.style.display = 'flex'; host.style.gap = '2px'; host.style.alignItems = 'stretch'; host.style.flexWrap = 'wrap';

    var tools = [['pline', 'Полилиния', 'polyline', true], ['line', 'Линия', 'line'], ['rect', 'Прямоуг.', 'rect'], ['circle', 'Окруж.', 'circle'], ['point', 'Точка', 'point'], ['dim', 'Размер', 'dim']];
    tools.forEach(function (t) {
      var b = bigBtn(t[0], t[1], t[3]);
      b.setAttribute('data-dtool', t[2]);
      b.addEventListener('click', function () { setActive(t[2]); });
      host.appendChild(b);
    });

    // проекция
    var pw = document.createElement('div'); pw.className = 'lx-projsel';
    pw.innerHTML = '<span>Проекция</span>';
    var sel = document.createElement('select');
    sel.innerHTML = '<option value="top">Сверху (XZ)</option><option value="front">Спереди (XY)</option><option value="side">Сбоку (ZY)</option>';
    sel.addEventListener('change', function () { var s = session(); if (s) s.setProjection(sel.value); syncDxfFrameSelect(); draw(); });
    pw.appendChild(sel); host.appendChild(pw);

    // переключатели: Привязки / Орто / Вид сверху
    var bSnap = bigBtn('snap', 'Привязки'); bSnap.id = 'lxSnapBtn'; bSnap.addEventListener('click', function () { setSnap(!snapOn); });
    var bOrtho = bigBtn('line', 'Орто'); bOrtho.id = 'lxOrthoBtn'; bOrtho.addEventListener('click', function () { setOrthoConstrain(!orthoOn); });
    var bTop = bigBtn('top', 'Вид сверху'); bTop.id = 'lxTopBtn'; bTop.addEventListener('click', topToggle);
    host.appendChild(bSnap); host.appendChild(bOrtho); host.appendChild(bTop);

    var bClose = bigBtn('close', 'Замкнуть'); bClose.id = 'lxClosePathBtn'; bClose.addEventListener('click', function () { var s = session(); if (s) { s.closePath(); draw(); } });
    var bUndo = bigBtn('undo', 'Отмена'); bUndo.id = 'lxUndoDrawBtn'; bUndo.addEventListener('click', function () { var s = session(); if (s) { s.undo(); draw(); } });
    var bClear = bigBtn('clear', 'Очистить'); bClear.id = 'lxClearDrawBtn'; bClear.addEventListener('click', function () { var s = session(); if (s) { s.clear(); hiddenLayers = {}; refreshLayers(); draw(); } });
    var bImp = bigBtn('imp', 'Импорт DXF'); bImp.id = 'lxImpBtn'; bImp.addEventListener('click', function () { ensureFileInput().click(); });
    var bSect = bigBtn('sect', 'Сечение'); bSect.id = 'lxSectBtn'; bSect.addEventListener('click', function () { sectionFromCloud(); });
    var bDxf = bigBtn('dxf', 'Экспорт DXF', true); bDxf.id = 'lxExportDxfBtn'; bDxf.addEventListener('click', exportDxf);
    var frameSelect = document.createElement('select');
    // Do not use `.btn`: the ribbon enhancer rewrites every `.btn` into an
    // icon button and would remove the <option> elements from this <select>.
    frameSelect.id = 'lxDxfFrame'; frameSelect.className = 'lx-dxf-frame';
    frameSelect.setAttribute('aria-label', 'Система координат DXF');
    frameSelect.innerHTML = '<option value="source">Исходные</option><option value="local">Локальные</option>';
    frameSelect.style.cssText = 'height:34px;flex:0 0 82px;width:82px;min-width:82px;max-width:82px;padding:0 4px;font-size:10px;background:rgba(32,34,37,.96);color:var(--txt,#e5e7eb);border:1px solid rgba(160,170,185,.35);border-radius:4px;';
    frameSelect.addEventListener('change', function () {
      dxfFrameSelectTouched = true;
      dxfFramePreference = frameSelect.value === 'local' ? 'local' : 'source';
      syncDxfFrameSelect();
    });
    host.appendChild(bClose); host.appendChild(bUndo); host.appendChild(bClear); host.appendChild(bImp); host.appendChild(bSect); host.appendChild(frameSelect); host.appendChild(bDxf);
    // Reserve room for the frame selector and DXF export button on common
    // 1600px workstations; the ribbon itself remains horizontally scrollable.
    Array.prototype.forEach.call(host.querySelectorAll('.lx-bigbtn'), function (b) {
      var w = 'clamp(76px,5.375vw,86px)';
      b.style.setProperty('flex', '0 0 ' + w, 'important');
      b.style.setProperty('width', w, 'important');
      b.style.setProperty('min-width', w, 'important');
      b.style.setProperty('max-width', w, 'important');
    });

    row.appendChild(host);
    tb.classList.add('lx-bigribbon');
    ensureFileInput();
    syncToggles();
    syncDxfFrameSelect();
    syncActionButtons();
  }

  // —— переключатели ——
  function setSnap(v) { snapOn = !!v; syncToggles(); toast(snapOn ? 'Привязки включены' : 'Привязки выключены'); }
  function setOrthoConstrain(v) { orthoOn = !!v; syncToggles(); toast(orthoOn ? 'Орто-черчение вкл.' : 'Орто-черчение выкл.'); }
  function topToggle() {
    var s = session(); if (s) s.setProjection('top');
    var sel = document.querySelector('#lxDrawTools .lx-projsel select'); if (sel) sel.value = 'top';
    var v = viewer();
    if (v) { try { if (v.topView) v.topView(); else if (v.setOrtho) v.setOrtho(true); } catch (e) {} }
    syncDxfFrameSelect();
    syncToggles(); draw();
  }
  function syncToggles() {
    var sb = document.getElementById('lxSnapBtn'); if (sb) sb.classList.toggle('lx-dactive', snapOn);
    var ob = document.getElementById('lxOrthoBtn'); if (ob) ob.classList.toggle('lx-dactive', orthoOn);
    var tb2 = document.getElementById('lxTopBtn'); var v = viewer();
    if (tb2) tb2.classList.toggle('lx-dactive', !!(v && v.isOrtho && v.isOrtho()));
  }

  // —— экспорт DXF ——
  function exportDxf() {
    var s = session(); if (!s) return;
    s.commit();
    if (!s.count()) { toast('Нечего экспортировать: начертите линии по облаку'); return; }
    var mode = s.projection || 'top', tr = sourceTransform();
    var frameSelect = document.getElementById('lxDxfFrame');
    var wantsSource = (frameSelect ? frameSelect.value : dxfFramePreference) === 'source';
    if (wantsSource && tr && mode !== 'top') {
      toast('Исходные координаты доступны только для плана. Выберите проекцию сверху или «Локальные».');
      return;
    }
    var useSource = wantsSource && !!tr && mode === 'top';
    var text;
    try { text = s.toDxf(useSource ? { sourceTransform: tr } : {}); } catch (e) { toast('Ошибка DXF: ' + e.message); return; }
    var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    var stem = 'bim-twin-drawing-' + ts;
    downloadText(stem + '.dxf', text, 'application/dxf');
    var v = viewer(), sourceWkt = useSource && v && typeof v._srcCrs === 'string' ? v._srcCrs.trim() : '';
    var wkt = useSource && tr.axis === 'zup' ? sourceWkt : '';
    if (wkt) downloadText(stem + '.prj', wkt + '\n', 'text/plain;charset=utf-8');
    var frameText = useSource ? 'исходные координаты' : 'локальные координаты';
    if (useSource && !sourceWkt) frameText += ', CRS не задана';
    if (useSource && tr.axis === 'yup' && sourceWkt) frameText += ', .prj не приложен: оси Y-up требуют проверки';
    toast('DXF экспортирован: ' + s.count() + ' объект(ов) · ' + frameText + (wkt ? ' · сохранён .prj' : ''));
  }

  function downloadText(name, text, type) {
    var blob = (typeof Blob !== 'undefined' && text instanceof Blob)
      ? text
      : new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1200);
  }

  // Export the actual points in an axis-aligned section band, separately from
  // its raster-derived contour. Coordinates are mapped back to the source frame
  // only when the viewer still has a valid source transform.
  function exportSectionPoints(opts) {
    opts = opts || {};
    function fail(message) {
      toast(message);
      return { ok: false, error: message };
    }
    if (!window.Section || typeof window.Section.sliceSlab !== 'function') {
      return fail('Модуль точечного сечения не загружен');
    }
    var cloud = opts.cloud || getCloud();
    var pos = cloud && (cloud.pos || cloud.positions);
    var count = cloud && cloud.count != null ? Number(cloud.count) : (pos ? pos.length / 3 : 0);
    var axis = opts.axis || 'y', level = Number(opts.level), thickness = Number(opts.thickness);
    if (!pos || !Number.isSafeInteger(count) || count < 1 || count * 3 > pos.length) {
      return fail('Нет корректного загруженного облака для экспорта среза');
    }
    if (!['x', 'y', 'z'].includes(axis) || !Number.isFinite(level) ||
        !(thickness > 0) || !Number.isFinite(thickness)) {
      return fail('Укажите ось, конечный уровень и положительную толщину полосы');
    }
    var sliced;
    try {
      sliced = window.Section.sliceSlab(pos, count, {
        axis: axis, level: level, thickness: thickness
      });
    } catch (e) {
      return fail('Не удалось выбрать точки сечения: ' + (e && e.message ? e.message : String(e)));
    }
    var indices = sliced && sliced.indices || [];
    if (!indices.length) return fail('В выбранной полосе нет точек · измените уровень или толщину');

    var v = viewer(), current = v && typeof v.getEditedCloud === 'function' ? v.getEditedCloud() : null;
    var tr = sourceTransform(), source = null;
    if (!opts.cloud && current && current.pos === pos && tr &&
        typeof v.getSourceCloud === 'function') {
      try {
        var candidate = v.getSourceCloud();
        if (candidate && candidate.pos && candidate.pos.length === pos.length &&
            candidate.meta && candidate.meta.srcXform) source = candidate;
      } catch (e) {}
    }
    var outPos = source ? source.pos : pos;
    var frame = source ? 'source' : 'viewer-local';
    var colors = cloud.col || null;
    if (colors && colors.length < count * 3) {
      return fail('Цветовой массив облака неполный; CSV не создан');
    }
    var colorMax = 0;
    if (colors) {
      for (var ci = 0; ci < indices.length; ci++) {
        var cp = indices[ci] * 3;
        for (var ca = 0; ca < 3; ca++) {
          var cv = Number(colors[cp + ca]);
          if (Number.isFinite(cv) && cv > colorMax) colorMax = cv;
        }
      }
    }
    var colorDiv = colorMax > 255 ? 65535 : (colorMax > 1.0001 ? 255 : 1);
    var normalizedColors = colorMax <= 1.0001;
    function fmt(n) {
      n = Number(n);
      if (!Number.isFinite(n)) throw new RangeError('Срез содержит нечисловые координаты');
      if (Object.is(n, -0)) n = 0;
      return n.toFixed(6);
    }
    var chunks = ['\uFEFFpoint_index,coordinate_frame,x_m,y_m,z_m,red,green,blue\r\n'];
    var rows = [];
    try {
      for (var j = 0; j < indices.length; j++) {
        var i = indices[j], p = i * 3;
        var rgb = ['', '', ''];
        if (colors) {
          for (var k = 0; k < 3; k++) {
            var rawColor = Number(colors[p + k]);
            var value = Math.round(normalizedColors ? rawColor * 255 : rawColor / colorDiv);
            rgb[k] = String(Math.max(0, Math.min(255, Number.isFinite(value) ? value : 0)));
          }
        }
        rows.push(i + ',' + frame + ',' + fmt(outPos[p]) + ',' + fmt(outPos[p + 1]) + ',' +
          fmt(outPos[p + 2]) + ',' + rgb.join(',') + '\r\n');
        if (rows.length >= 8192) {
          chunks.push(rows.join(''));
          rows = [];
        }
      }
      if (rows.length) chunks.push(rows.join(''));
    } catch (e) {
      return fail('Не удалось подготовить CSV сечения: ' + (e && e.message ? e.message : String(e)));
    }
    var csv = new Blob(chunks, { type: 'text/csv;charset=utf-8' });
    var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    var levelTag = level.toFixed(3).replace('-', 'm').replace('.', 'p');
    var stem = 'bim-twin-section-' + axis + '-' + levelTag + 'm-' + stamp;
    var meta = {
      schema: 'bim-twin-section-points/v1',
      createdAt: new Date().toISOString(),
      sourceName: v && v._cloudRecord && v._cloudRecord.sourceName || null,
      coordinateFrame: frame,
      coordinateUnits: 'm',
      sourceCrsWkt: source && source.meta && source.meta.crsWkt || null,
      sourceTransform: source && source.meta && source.meta.srcXform
        ? { axis: source.meta.srcXform.axis, t: Array.prototype.slice.call(source.meta.srcXform.t || []) }
        : null,
      section: {
        axis: axis,
        levelViewerM: level,
        thicknessM: thickness,
        boundary: 'inclusive',
        pointIndexBase: 0
      },
      pointCount: indices.length,
      fields: ['point_index', 'coordinate_frame', 'x_m', 'y_m', 'z_m', 'red', 'green', 'blue'],
      colorEncoding: colors ? 'RGB 8-bit sRGB' : null,
      attributeLimitations: ['Интенсивность и классификация не доступны в текущем буфере рендерера.']
    };
    try {
      downloadText(stem + '.csv', csv, 'text/csv;charset=utf-8');
      downloadText(stem + '.json', JSON.stringify(meta, null, 2), 'application/json;charset=utf-8');
    } catch (e) {
      return fail('Не удалось сохранить файлы сечения: ' + (e && e.message ? e.message : String(e)));
    }
    var frameLabel = frame === 'source'
      ? (meta.sourceCrsWkt ? 'исходные координаты · CRS записана в JSON' : 'исходная система координат · CRS не задана')
      : 'локальные координаты вьюера · CRS не подтверждена';
    toast('Точки сечения сохранены: ' + indices.length.toLocaleString('ru-RU') + ' · CSV + JSON · ' + frameLabel);
    return {
      ok: true, count: indices.length, axis: axis, level: level, thickness: thickness,
      frame: frame, hasCrs: !!meta.sourceCrsWkt, files: [stem + '.csv', stem + '.json']
    };
  }

  // —— импорт DXF ——
  function importText(text, name) {
    var s = session(); if (!s) return 0;
    if (!window.DXFParse) { toast('DXF-парсер не загружен'); return 0; }
    var parsed;
    try { parsed = window.DXFParse.parse(text); } catch (e) { toast('Ошибка чтения DXF: ' + e.message); return 0; }
    var mode = s.projection || 'top';
    var tr = sourceTransform();
    var frameSelect = document.getElementById('lxDxfFrame');
    var wantsSource = (frameSelect ? frameSelect.value : dxfFramePreference) === 'source';
    if (wantsSource && tr && mode !== 'top') {
      toast('Для импорта исходных координат выберите проекцию сверху или «Локальные».');
      return 0;
    }
    var importSource = wantsSource && !!tr && mode === 'top';
    if (importSource && !dxfFrameSelectTouched && typeof window.confirm === 'function' &&
        !window.confirm('Импортировать DXF как координаты активного облака? Продолжайте только если чертёж в той же системе координат; иначе сначала выберите «Локальные».')) {
      return 0;
    }
    if (importSource) {
      try { parsed = window.Draw2D.fromSourceDxfEntities(parsed, tr, 0); }
      catch (e) { toast('Ошибка преобразования координат DXF: ' + e.message); return 0; }
    }
    var n = 0;
    try { n = s.importEntities(parsed, mode, 0); } catch (e) { toast('Ошибка импорта: ' + e.message); return 0; }
    refreshLayers(); draw();
    toast('Импортировано из ' + (name || 'DXF') + ': ' + n + ' объект(ов) · ' + (importSource ? 'координаты проекта' : 'локальные координаты'));
    return n;
  }

  // —— панель слоёв ——
  function refreshLayers() {
    ensureOverlay(); if (!stageEl) return;
    var s = session(); if (!s) return;
    var set = {}; s.entities.forEach(function (e) { set[e.layer || 'DRAW'] = true; });
    var names = Object.keys(set).sort();
    var panel = document.getElementById('lxLayers');
    var show = names.length >= 2 || Object.keys(hiddenLayers).length > 0;
    if (!panel) { panel = document.createElement('div'); panel.id = 'lxLayers'; panel.className = 'lx-lyrpanel'; stageEl.appendChild(panel); }
    if (!show) { panel.style.display = 'none'; panel.innerHTML = ''; return; }
    panel.style.display = '';
    panel.innerHTML = '<div class="lx-lyrhead">Слои чертежа</div>';
    names.forEach(function (nm) {
      var rowEl = document.createElement('label'); rowEl.className = 'lx-lyrrow';
      var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !hiddenLayers[nm];
      cb.addEventListener('change', function () { if (cb.checked) delete hiddenLayers[nm]; else hiddenLayers[nm] = true; draw(); });
      var sp = document.createElement('span'); sp.textContent = nm;
      rowEl.appendChild(cb); rowEl.appendChild(sp); panel.appendChild(rowEl);
    });
  }

  // —— сечение облака → контурные полилинии в чертёж ——
  function getCloud() {
    var c = window.__lxCloud || null;
    var v = viewer();
    if (!c && v && v.base && v.base.some(function(o) { return o.points; }) && typeof v.getEditedCloud === 'function') c = v.getEditedCloud();
    if (!c && v && typeof v.getCloud === 'function') { try { c = v.getCloud(); } catch (e) {} }
    return c;
  }
  function sectionRequest(opts) {
    opts = opts || {};
    var cloud = opts.cloud || getCloud();
    var pos = cloud && (cloud.pos || cloud.positions);
    var count = cloud && (cloud.count != null ? Number(cloud.count) : (pos ? pos.length / 3 : 0));
    if (!pos || !Number.isSafeInteger(count) || count < 1 || count * 3 > pos.length) return { error: 'Нет корректного загруженного облака для сечения' };
    if (!window.Section) return { error: 'Модуль сечения не загружен' };
    var axis = opts.axis || 'y';
    if (['x', 'y', 'z'].indexOf(axis) < 0) return { error: 'Выберите ось сечения X, Y или Z' };
    var level = opts.level;
    if (level == null) {
      var comp = axis === 'z' ? 2 : (axis === 'x' ? 0 : 1);
      var lo = Infinity, hi = -Infinity;
      for (var i = 0; i < count; i++) { var cc = pos[i * 3 + comp]; if (!Number.isFinite(cc)) continue; if (cc < lo) lo = cc; if (cc > hi) hi = cc; }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { error: 'В облаке нет конечных координат по выбранной оси' };
      level = (lo + hi) / 2;
    }
    level = Number(level);
    var thickness = opts.thickness != null ? opts.thickness : sectThickness;
    var cell = opts.cell != null ? opts.cell : sectCell;
    var minArea = opts.minArea != null ? opts.minArea : undefined;
    return {
      cloud: cloud, pos: pos, count: count, axis: axis, level: level,
      thickness: thickness, cell: cell, minArea: minArea,
      options: { axis: axis, level: level, thickness: thickness, cell: cell, minArea: minArea }
    };
  }
  function commitSectionResult(request, res) {
    var axis = request.axis, level = request.level;
    lastSectionStats = {
      axis: axis, level: level, thickness: request.thickness, cell: request.cell,
      minArea: res.minArea, sliced: res.sliced, loops: res.loops.length,
      discardedSmall: res.discardedSmall || 0
    };
    if (!res.loops.length) {
      var message = res.discardedSmall
        ? 'Точки есть, но все мелкие контуры отсечены порогом площади · уменьшите порог или размер ячейки'
        : 'В этой полосе нет замкнутых контуров · выберите другой уровень или увеличьте толщину';
      lastSectionStats.error = message;
      toast(message);
      return { ok: false, error: message, stats: Object.assign({}, lastSectionStats) };
    }
    var mode = axis === 'z' ? 'front' : (axis === 'x' ? 'side' : 'top');
    var s = session();
    if (!s) return { ok: false, error: 'Не удалось открыть чертёж', stats: Object.assign({}, lastSectionStats) };
    var generated = res.loops.map(function (lp) {
      var pts3 = lp.points.map(function (uv) { return unproject([uv[0], uv[1]], mode, level); });
      if (pts3.some(function (point) { return !point.every(Number.isFinite); })) {
        throw new RangeError('Сечение содержит некорректные координаты');
      }
      return { type: 'polyline', layer: 'SECTION', closed: true, points: pts3, generatedBy: 'section-v1232' };
    });
    s.setProjection(mode);
    var sel = document.querySelector('#lxDrawTools .lx-projsel select'); if (sel) sel.value = mode;
    syncDxfFrameSelect();
    s.entities = s.entities.concat(generated);
    var added = generated.length;
    refreshLayers(); draw();
    var axisName = axis === 'y' ? 'горизонталь Y' : (axis === 'z' ? 'вертикаль Z' : 'вертикаль X');
    var v = viewer();
    if (v && v.setSectionView) v.setSectionView(axis);
    else if (axis === 'y' && v && v.topView) v.topView();
    else if (v && v.setStandardView) v.setStandardView(axis === 'z' ? 'front' : 'right');
    toast('Сечение: ' + added + ' контур(ов) · ' + res.sliced + ' точек · мелких фрагментов отсечено: ' + (res.discardedSmall || 0) + ' · ' + axisName + ' = ' + (Math.round(level * 1000) / 1000) + ' м');
    return { ok: true, loops: added, sliced: res.sliced, stats: Object.assign({}, lastSectionStats) };
  }
  function sectionFromCloud(opts) {
    var request = sectionRequest(opts);
    if (request.error) { toast(request.error); return 0; }
    var s = session(); if (!s) { toast('Не удалось открыть чертёж'); return 0; }
    var res;
    try { res = window.Section.sectionToPolylines(request.pos, request.count, request.options); }
    catch (e) {
      lastSectionStats = { axis: request.axis, level: request.level, error: e && e.message ? e.message : String(e) };
      toast('Не удалось построить контур: ' + lastSectionStats.error);
      return 0;
    }
    var result = commitSectionResult(request, res);
    return result.ok ? result.loops : 0;
  }

  function sectionWorkerCopy(pos, count) {
    if (ArrayBuffer.isView(pos) && !(pos instanceof DataView)) {
      return new pos.constructor(pos.subarray(0, count * 3));
    }
    if (!Array.isArray(pos)) throw new TypeError('Массив точек не поддерживает безопасное копирование в worker');
    var copy = new Float64Array(count * 3);
    for (var i = 0; i < count * 3; i++) copy[i] = Number(pos[i]);
    return copy;
  }

  function runSectionWorker(operation, pos, count, options, onProgress) {
    if (activeSectionJob) return Promise.reject(new Error('Уже выполняется расчёт сечения'));
    if (typeof Worker !== 'function') {
      return Promise.reject(new Error('Фоновый расчёт сечения недоступен в этом режиме; геометрия не изменена'));
    }
    var bytesPerValue = ArrayBuffer.isView(pos) && Number(pos.BYTES_PER_ELEMENT) > 0 ? pos.BYTES_PER_ELEMENT : 8;
    var copyBytes = count * 3 * bytesPerValue;
    if (!Number.isFinite(copyBytes) || copyBytes > maxSectionWorkerBytes) {
      return Promise.reject(new RangeError('Облако слишком велико для безопасной копии фонового сечения (лимит 128 МиБ); обрежьте или проредите данные'));
    }
    var copy;
    try { copy = sectionWorkerCopy(pos, count); }
    catch (e) { return Promise.reject(e); }
    return new Promise(function (resolve, reject) {
      var worker, id = nextSectionJobId++, settled = false;
      try { worker = new Worker(new URL('section-worker.js?v=1232', document.baseURI)); }
      catch (e) { reject(new Error('Не удалось запустить фоновый расчёт сечения: ' + (e && e.message || String(e)))); return; }
      var job = { id: id, worker: worker, reject: reject, cancel: null };
      activeSectionJob = job;
      function finish(callback, value) {
        if (settled) return;
        settled = true;
        if (activeSectionJob === job) activeSectionJob = null;
        try { worker.terminate(); } catch (e) {}
        callback(value);
      }
      job.cancel = function () {
        var error = new Error('Расчёт сечения отменён');
        error.name = 'AbortError';
        finish(reject, error);
      };
      worker.onmessage = function (event) {
        var data = event.data || {};
        if (data.type === 'fatal') {
          finish(reject, new Error('Ошибка загрузки worker сечения: ' + data.error));
          return;
        }
        if (data.id !== id) return;
        if (data.type === 'progress') {
          var update = {
            jobId: id, percent: Number(data.percent) || 0,
            phase: String(data.phase || ''), completed: Number(data.completed) || 0,
            total: Number(data.total) || 0
          };
          try { if (typeof onProgress === 'function') onProgress(update); } catch (e) {}
          if (activeSectionJob !== job) return;
          try { window.dispatchEvent(new CustomEvent('bim-section-progress', { detail: update })); } catch (e) {}
          return;
        }
        if (data.type === 'result') {
          finish(resolve, data.result);
          return;
        }
        if (data.type === 'error') {
          var error = new Error(data.error || 'Ошибка расчёта сечения');
          error.name = data.name || 'Error';
          finish(reject, error);
        }
      };
      worker.onerror = function (event) {
        finish(reject, new Error('Worker сечения завершился с ошибкой: ' + (event && event.message || 'неизвестная ошибка')));
      };
      try {
        worker.postMessage({ id: id, operation: operation, pos: copy, count: count, options: options }, [copy.buffer]);
      } catch (e) {
        finish(reject, new Error('Не удалось передать облако в worker: ' + (e && e.message || String(e))));
      }
    });
  }

  function cancelSectionJob() {
    var job = activeSectionJob;
    if (!job || typeof job.cancel !== 'function') return false;
    activeSectionJob = null;
    job.cancel();
    return true;
  }

  function sectionFromCloudAsync(opts) {
    opts = opts || {};
    var request = sectionRequest(opts);
    if (request.error) {
      toast(request.error);
      return Promise.resolve({ ok: false, error: request.error });
    }
    var v = viewer(), startSession = session(), startEntities = startSession && startSession.entities.slice();
    var record = v && v._cloudRecord;
    if (!startSession) {
      var noDrawing = 'Не удалось открыть чертёж';
      toast(noDrawing);
      return Promise.resolve({ ok: false, error: noDrawing });
    }
    return runSectionWorker('axis', request.pos, request.count, request.options, opts.onProgress).then(function (res) {
      var current = viewer(), currentCloud = current && current.getEditedCloud && current.getEditedCloud();
      var currentPos = currentCloud && (currentCloud.pos || currentCloud.positions);
      var drawingChanged = session() !== startSession || !startEntities ||
        startSession.entities.length !== startEntities.length ||
        startEntities.some(function (entity, index) { return startSession.entities[index] !== entity; });
      if (current !== v || currentPos !== request.pos || current._cloudRecord !== record || drawingChanged) {
        var stale = 'Облако или чертёж изменились во время расчёта; результат не применён';
        lastSectionStats = { axis: request.axis, level: request.level, error: stale, stale: true };
        return { ok: false, stale: true, error: stale, stats: Object.assign({}, lastSectionStats) };
      }
      return commitSectionResult(request, res);
    }).catch(function (error) {
      var cancelled = !!error && error.name === 'AbortError';
      var message = cancelled ? 'Расчёт сечения отменён · чертёж не изменён' :
        'Не удалось построить контур: ' + (error && error.message ? error.message : String(error));
      lastSectionStats = {
        axis: request.axis, level: request.level, thickness: request.thickness,
        cell: request.cell, cancelled: cancelled, error: message
      };
      if (!cancelled) toast(message);
      return { ok: false, cancelled: cancelled, error: message, stats: Object.assign({}, lastSectionStats) };
    });
  }

  function profileRequest(opts) {
    opts = opts || {};
    var cloud = opts.cloud || getCloud();
    var pos = cloud && (cloud.pos || cloud.positions);
    var count = cloud && (cloud.count != null ? Number(cloud.count) : (pos ? pos.length / 3 : 0));
    if (!pos || !Number.isSafeInteger(count) || count < 1 || count * 3 > pos.length) {
      return { error: 'Нет корректного загруженного облака для профиля' };
    }
    var origin = opts.origin || [
      opts.originX != null ? Number(opts.originX) : 0,
      opts.originZ != null ? Number(opts.originZ) : 0
    ];
    var originArray = Array.isArray(origin) || (origin && ArrayBuffer.isView(origin));
    var originX = originArray && origin.length > 0 ? Number(origin[0]) : NaN;
    var originZ = originArray && origin.length > 1 ? Number(origin[1]) : NaN;
    var azimuthDeg = opts.azimuthDeg != null ? Number(opts.azimuthDeg) : 0;
    var offset = opts.offset != null ? Number(opts.offset) : 0;
    var thickness = opts.thickness != null ? Number(opts.thickness) : sectThickness;
    var cell = opts.cell != null ? Number(opts.cell) : sectCell;
    var minArea = opts.minArea != null ? Number(opts.minArea) : undefined;
    if (![originX, originZ, azimuthDeg, offset, thickness, cell].every(Number.isFinite) ||
        !(thickness > 0) || !(cell > 0) || (minArea != null && (!Number.isFinite(minArea) || minArea < 0))) {
      return { error: 'Проверьте азимут, начало X/Z, смещение, толщину, ячейку и площадь контура' };
    }
    var v = viewer();
    var sourceWkt = v && typeof v._srcCrs === 'string' ? v._srcCrs.trim().replace(/\r?\n/g, ' ') : '';
    return {
      cloud: cloud, pos: pos, count: count, origin: [originX, originZ],
      azimuthDeg: azimuthDeg, offset: offset, thickness: thickness, cell: cell,
      minArea: minArea, sourceTransform: sourceTransform(), sourceWkt: sourceWkt,
      options: {
        origin: [originX, originZ], azimuthDeg: azimuthDeg, offset: offset,
        thickness: thickness, cell: cell, minArea: minArea
      }
    };
  }

  function profileFail(message, result, quiet) {
    lastSectionStats = Object.assign({ mode: 'profile', error: message }, result || {});
    if (!quiet) toast(message);
    return { ok: false, error: message, stats: Object.assign({}, lastSectionStats) };
  }

  // Координаты DXF — станция/отметка; исходную CRS нельзя назначать этому DXF.
  function exportProfileResult(res, request) {
    lastSectionStats = {
      mode: 'profile', azimuthDeg: res.azimuthDeg, origin: res.origin.slice(),
      planeOrigin: res.planeOrigin.slice(), offset: res.offset, thickness: res.thickness,
      cell: res.cell, minArea: res.minArea, sliced: res.sliced,
      loops: res.loops.length, discardedSmall: res.discardedSmall || 0
    };
    if (!res.loops.length) {
      var emptyMessage = res.sliced
        ? 'Профиль не дал замкнутых контуров · уменьшите ячейку/порог или измените плоскость'
        : 'В полосе профиля нет точек · проверьте начало, азимут, смещение и толщину';
      return profileFail(emptyMessage, lastSectionStats);
    }
    var entities, dxf;
    try {
      entities = window.Section.profileToDxfEntities(res, 'PROFILE_CONTOUR');
      if (!entities.length) return profileFail('Нет пригодных замкнутых контуров для DXF', lastSectionStats);
      dxf = window.DXF.toDxf(entities, { layers: ['PROFILE_CONTOUR'] });
    } catch (e) {
      return profileFail('Ошибка подготовки DXF профиля: ' + (e && e.message ? e.message : String(e)), lastSectionStats);
    }
    var tr = request.sourceTransform;
    var sourceWkt = request.sourceWkt;
    var header = [
      'contour_id', 'vertex_id', 'station_m', 'elevation_y_m', 'closed',
      'azimuth_deg_from_viewer_x_toward_z', 'offset_m', 'thickness_m',
      'grid_cell_m', 'minimum_contour_area_m2', 'origin_viewer_x_m', 'origin_viewer_z_m',
      'plane_origin_viewer_x_m', 'plane_origin_viewer_z_m', 'source_transform_axis',
      'source_translation_0_m', 'source_translation_1_m', 'source_translation_2_m',
      'source_crs_wkt'
    ];
    function csvCell(value) {
      var text = value == null ? '' : String(value);
      return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }
    function csvNumber(value) {
      var n = Number(value);
      if (Object.is(n, -0)) n = 0;
      return n.toFixed(6);
    }
    var rows = [header.join(',')];
    var wktWritten = false;
    res.loops.forEach(function (loop, loopIndex) {
      var points = loop.points.slice();
      if (loop.closed && points.length > 1 &&
          Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]) <= 1e-9) {
        points.pop();
      }
      points.forEach(function (p, pointIndex) {
        var fields = [
          loopIndex + 1, pointIndex + 1, csvNumber(p[0]), csvNumber(p[1]), loop.closed ? 1 : 0,
          csvNumber(res.azimuthDeg), csvNumber(res.offset), csvNumber(res.thickness),
          csvNumber(res.cell), csvNumber(res.minArea), csvNumber(res.origin[0]), csvNumber(res.origin[1]),
          csvNumber(res.planeOrigin[0]), csvNumber(res.planeOrigin[1]), tr ? tr.axis : '',
          tr ? csvNumber(tr.t[0]) : '', tr ? csvNumber(tr.t[1]) : '', tr ? csvNumber(tr.t[2]) : '',
          !wktWritten ? sourceWkt : ''
        ];
        rows.push(fields.map(csvCell).join(','));
        if (sourceWkt) wktWritten = true;
      });
    });
    var csv = '\uFEFF' + rows.join('\r\n') + '\r\n';
    var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    var stem = 'bim-twin-profile-' + stamp;
    downloadText(stem + '.dxf', dxf, 'application/dxf');
    downloadText(stem + '.csv', csv, 'text/csv;charset=utf-8');
    toast('Профиль экспортирован: ' + res.loops.length + ' контур(ов) · ' + res.sliced +
      ' точек · DXF станция/отметка + CSV с параметрами');
    return { ok: true, loops: res.loops.length, entities: entities.length, sliced: res.sliced, stats: Object.assign({}, lastSectionStats) };
  }

  // Синхронный wrapper остаётся для совместимости с интеграциями и unit tests.
  function exportProfileDxf(opts) {
    if (!window.Section || !window.Section.profileToPolylines || !window.Section.profileToDxfEntities) {
      return profileFail('Модуль наклонного профиля не загружен');
    }
    if (!window.DXF || !window.DXF.toDxf) return profileFail('Модуль DXF не загружен');
    var request = profileRequest(opts);
    if (request.error) return profileFail(request.error);
    try {
      return exportProfileResult(window.Section.profileToPolylines(request.pos, request.count, request.options), request);
    } catch (e) {
      return profileFail('Не удалось построить профиль: ' + (e && e.message ? e.message : String(e)), {
        azimuthDeg: request.azimuthDeg, origin: request.origin, offset: request.offset,
        thickness: request.thickness, cell: request.cell
      });
    }
  }

  function exportProfileDxfAsync(opts) {
    opts = opts || {};
    if (!window.Section || !window.Section.profileToPolylines || !window.Section.profileToDxfEntities) {
      return Promise.resolve(profileFail('Модуль наклонного профиля не загружен'));
    }
    if (!window.DXF || !window.DXF.toDxf) return Promise.resolve(profileFail('Модуль DXF не загружен'));
    var request = profileRequest(opts);
    if (request.error) return Promise.resolve(profileFail(request.error));
    var v = viewer(), record = v && v._cloudRecord;
    return runSectionWorker('profile', request.pos, request.count, request.options, opts.onProgress).then(function (res) {
      var current = viewer(), currentCloud = current && current.getEditedCloud && current.getEditedCloud();
      var currentPos = currentCloud && (currentCloud.pos || currentCloud.positions);
      var currentTransform = sourceTransform();
      var transformChanged = !!currentTransform !== !!request.sourceTransform ||
        (currentTransform && (currentTransform.axis !== request.sourceTransform.axis ||
          currentTransform.t.some(function (n, i) { return Math.abs(n - request.sourceTransform.t[i]) > 1e-9; })));
      var currentWkt = current && typeof current._srcCrs === 'string'
        ? current._srcCrs.trim().replace(/\r?\n/g, ' ') : '';
      if (current !== v || currentPos !== request.pos || current._cloudRecord !== record ||
          transformChanged || currentWkt !== request.sourceWkt) {
        return profileFail('Облако или система координат изменились во время расчёта; профиль не экспортирован',
          { mode: 'profile', stale: true, sliced: res.sliced });
      }
      return exportProfileResult(res, request);
    }).catch(function (error) {
      var cancelled = !!error && error.name === 'AbortError';
      var message = cancelled ? 'Расчёт профиля отменён · файлы не созданы' :
        'Не удалось построить профиль: ' + (error && error.message ? error.message : String(error));
      return profileFail(message, {
        mode: 'profile', azimuthDeg: request.azimuthDeg, origin: request.origin,
        offset: request.offset, thickness: request.thickness, cell: request.cell,
        cancelled: cancelled
      }, cancelled);
    });
  }

  function toast(msg) {
    try { var el = document.getElementById('toast'); if (el) { el.textContent = msg; el.classList.add('show'); setTimeout(function () { el.classList.remove('show'); }, 2600); return; } } catch (e) {}
    try { console.log('[LX-DRAW]', msg); } catch (e) {}
  }

  // —— SVG-оверлей ——
  function ensureOverlay() {
    stageEl = document.querySelector('.stage') || document.querySelector('.center');
    if (!stageEl) return null;
    if (getComputedStyle(stageEl).position === 'static') stageEl.style.position = 'relative';
    if (!overlay) {
      overlay = document.createElementNS(SVGNS, 'svg');
      overlay.setAttribute('class', 'lx-drawsvg');
      stageEl.appendChild(overlay);
    }
    return overlay;
  }

  function w2s(p) {
    var v = viewer(); if (!v || !v.worldToScreen || !stageEl) return null;
    var sc = v.worldToScreen(p); if (!sc) return null;
    var r = stageEl.getBoundingClientRect();
    return { x: sc.x - r.left, y: sc.y - r.top };
  }

  function mkLine(a, b, cls) { var l = document.createElementNS(SVGNS, 'line'); l.setAttribute('x1', a.x); l.setAttribute('y1', a.y); l.setAttribute('x2', b.x); l.setAttribute('y2', b.y); l.setAttribute('class', cls); return l; }
  function mkPoly(pts, cls) { var pl = document.createElementNS(SVGNS, 'polyline'); pl.setAttribute('points', pts.map(function (p) { return p.x + ',' + p.y; }).join(' ')); pl.setAttribute('class', cls); return pl; }
  function mkDot(p, cls, r) { var c = document.createElementNS(SVGNS, 'circle'); c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', r || 3); c.setAttribute('class', cls); return c; }
  function mkText(p, txt, cls, dy) { var t = document.createElementNS(SVGNS, 'text'); t.setAttribute('x', p.x); t.setAttribute('y', p.y - (dy || 0)); t.setAttribute('class', cls); t.textContent = txt; return t; }
  function mkRect(p, sz, cls) { var rc = document.createElementNS(SVGNS, 'rect'); rc.setAttribute('x', p.x - sz); rc.setAttribute('y', p.y - sz); rc.setAttribute('width', sz * 2); rc.setAttribute('height', sz * 2); rc.setAttribute('class', cls); return rc; }

  function draw() {
    var s = session();
    scheduleDrawingSave(s);
    syncActionButtons(s);
    if (!ensureOverlay()) return;
    while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
    if (!s) return;
    // готовые сущности
    s.entities.forEach(function (e) {
      if (e.layer && hiddenLayers[e.layer]) return;
      if (e.type === 'line') { var a = w2s(e.a), b = w2s(e.b); if (a && b) overlay.appendChild(mkLine(a, b, 'lx-dl')); }
      else if (e.type === 'polyline') {
        var sp = e.points.map(w2s).filter(Boolean);
        if (sp.length >= 2) { var pts = e.closed ? sp.concat([sp[0]]) : sp; overlay.appendChild(mkPoly(pts, 'lx-dl' + (e.closed ? ' closed' : '') + (e.layer === 'SECTION' ? ' lx-sect' : ''))); }
        sp.forEach(function (p) { overlay.appendChild(mkDot(p, 'lx-vtx', 2.4)); });
      } else if (e.type === 'point') { var q = w2s(e.p); if (q) overlay.appendChild(mkDot(q, 'lx-pt', 3.4)); }
      else if (e.type === 'text') { var tp = w2s(e.p); if (tp) overlay.appendChild(mkText(tp, e.text || '', 'lx-dimtxt', 0)); }
      else if (e.type === 'dim') {
        var da = w2s(e.a), db = w2s(e.b); if (!da || !db) return;
        overlay.appendChild(mkLine(da, db, 'lx-dim'));
        overlay.appendChild(mkDot(da, 'lx-vtx', 2.2)); overlay.appendChild(mkDot(db, 'lx-vtx', 2.2));
        var mp = { x: (da.x + db.x) / 2, y: (da.y + db.y) / 2 };
        overlay.appendChild(mkText(mp, e.text || '', 'lx-dimtxt', 5));
      }
      else if (e.type === 'circle') {
        var c = w2s(e.c); if (!c) return;
        var edge = w2s([e.c[0] + e.r, e.c[1], e.c[2]]); if (!edge) return;
        var rr = Math.hypot(edge.x - c.x, edge.y - c.y);
        var el = document.createElementNS(SVGNS, 'circle'); el.setAttribute('cx', c.x); el.setAttribute('cy', c.y); el.setAttribute('r', rr); el.setAttribute('class', 'lx-circ');
        overlay.appendChild(el); overlay.appendChild(mkDot(c, 'lx-vtx', 2.4));
      }
    });
    // черновик (draft) + резиновая линия к курсору
    if (s.draft && s.draft.length) {
      var dp = s.draft.map(w2s).filter(Boolean);
      if (dp.length >= 2) overlay.appendChild(mkPoly(dp, 'lx-draft'));
      dp.forEach(function (p) { overlay.appendChild(mkDot(p, 'lx-vtx', 2.4)); });
      if (API.active && hover && dp.length) {
        var r = stageEl.getBoundingClientRect();
        overlay.appendChild(mkLine(dp[dp.length - 1], { x: hover.x - r.left, y: hover.y - r.top }, 'lx-draft'));
      }
    }
    // маркер привязки
    if (lastSnap) {
      var wp3 = unproject(lastSnap.uv, lastSnap.mode, lastSnap.fixed);
      var sm = w2s(wp3);
      if (sm) overlay.appendChild(mkRect(sm, 5, 'lx-snapmark'));
    }
  }

  // перерисовка при движении камеры
  var lastViewSignature = '';
  function tick() {
    if (on()) {
      var s = session(), v = viewer();
      if (s && v && (s.count() || (s.draft && s.draft.length) || API.active)) {
        var sig = [v.yaw,v.pitch,v.dist,v._ortho,v.target && v.target.join(','),v.canvas && v.canvas.width,v.canvas && v.canvas.height,s.count()].join('|');
        if (sig !== lastViewSignature) { lastViewSignature = sig; draw(); }
      }
    }
    requestAnimationFrame(tick);
  }

  function wireDblClick() {
    var v = viewer(); if (!v || !v.canvas || v.canvas.__lxDrawDbl) return;
    v.canvas.addEventListener('dblclick', function () { if (API.active && API.tool === 'polyline') { var s = session(); if (s) { s.commit(); draw(); } } });
    v.canvas.__lxDrawDbl = true;
  }

  function boot() {
    if (!on()) return;
    buildTab(); ensureOverlay(); wireDblClick();
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 80); });
  else setTimeout(boot, 80);
  requestAnimationFrame(tick);

  try {
    window.addEventListener('bim-cloud-change', syncDxfFrameSelect);
    var mo = new MutationObserver(function () { if (on()) { buildTab(); wireDblClick(); } });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-lxskin'] });
    var mo2 = new MutationObserver(function () { if (on()) buildTab(); });
    if (document.body) mo2.observe(document.body, { childList: true, subtree: true });
  } catch (e) {}

  window.__lxDrawUI = {
    buildTab: buildTab, draw: draw, setActive: setActive, deactivate: deactivate, exportDxf: exportDxf, session: session,
    snapWorld: snapWorld, importText: importText, setSnap: setSnap, setOrtho: setOrthoConstrain,
    topToggle: topToggle, refreshLayers: refreshLayers, sectionFromCloud: sectionFromCloud,
    sectionFromCloudAsync: sectionFromCloudAsync, cancelSectionJob: cancelSectionJob,
    exportProfileDxf: exportProfileDxf, exportProfileDxfAsync: exportProfileDxfAsync, exportSectionPoints: exportSectionPoints,
    sectionStats: function () { return lastSectionStats ? Object.assign({}, lastSectionStats) : null; },
    flushProjectState: function () {
      var ps = window.BimProjectState, s = session();
      if (drawingSaveTimer) { clearTimeout(drawingSaveTimer); drawingSaveTimer = null; }
      if (!ps || !ps.update) return Promise.resolve({ ok: true, unchanged: true });
      var snapshot = drawingSnapshot(s), encoded;
      try { encoded = JSON.stringify(snapshot); } catch (_) { return Promise.resolve({ ok: false, error: 'drawing_snapshot_invalid' }); }
      if (encoded === lastDrawingStateJson) return ps.flush ? ps.flush() : Promise.resolve({ ok: true, unchanged: true });
      lastDrawingStateJson = encoded;
      return ps.update({ drawings: [snapshot] }, { immediate: true, operation: { operation: 'drawing.save' } });
    },
    state: function () { return { snapOn: snapOn, orthoOn: orthoOn, hiddenLayers: hiddenLayers, active: API.active, tool: API.tool, dxfFrame: dxfFramePreference }; }
  };
  restoreDrawingState();
})();
