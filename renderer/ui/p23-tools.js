/* BIM Twin — r155: P2/P3-интеграция.
 *  • «Система координат»: текущая СК облака/модели, пересчёт UTM↔WGS84↔локальная,
 *    запись привязки (--georef-file), экспорт координат углов — через crs-tools.py.
 *  • «Mesh-инструменты»: заполнить отверстия / сгладить (Лаплас) / удалить треугольники
 *    по классу/цвету / упростить — через mesh-tools.py.
 *  • P3: `window.__lxClipBox` — данные/вьюер/сохранение фрагмента клип-бокса для UI
 *    editor-basics (`renderer/ui/clip-p3.js`), плюс graceful fallback (нет CLI — понятное сообщение).
 *
 * API: window.__lxP23 = { mount, openCrs, openMesh, state, runCrsLocal, runMeshLocal };
 *      window.__lxClipBox = { open, close, state, applyAndSave, cancel, setBox, getBox }.
 * UI не дублирует панель клип-бокса (её делает editor-basics); грузите p23-tools.js
 * из p1-tools.js (dynamic script) — правок app.js не требуется.
 */
(function () {
  'use strict';
  var W = window, D = document;
  var st = {
    mounted: false, status: null, busy: false, view: '', log: [], jobId: '', cancelFn: null,
    crsInfo: null, crsResult: null, crsForm: { op: 'reproject', from: '', to: 'EPSG:32636', wkt: '' },
    meshFile: '', meshOp: 'fill-holes', meshParams: {}, meshResult: null,
    clipBox: null, clipActive: false, clipCount: 0, storage: null
  };
  var CRS_PRESETS = [
    { v: 'EPSG:4326', l: 'EPSG:4326 — WGS84 (широта/долгота)' },
    { v: 'EPSG:32636', l: 'EPSG:32636 — UTM 36N (WGS84)' },
    { v: 'EPSG:32637', l: 'EPSG:32637 — UTM 37N (WGS84)' },
    { v: 'EPSG:25836', l: 'EPSG:25836 — ETRS89 / UTM 36N' },
    { v: 'local', l: 'Локальная система (σ/θ, УСК)' }
  ];
  function bridge() { try { return (W.bimAPI && typeof W.bimAPI.p23Status === 'function') ? W.bimAPI : null; } catch (e) { return null; } }
  function viewer() { try { return (W.__pcTools && W.__pcTools.viewer && W.__pcTools.viewer()) || W.__viewer || W.__lxViewer || null; } catch (e) { return null; } }
  // Облако из вьюера: getEditedCloud() может быть null в потоковом/большом режиме,
  // тогда берём base[0] (pos/col/classification) и запись _cloudRecord.
  function viewerCloud() {
    try { var t = W.__pcTools; if (t && t.getCloud) { var c = t.getCloud(); if (c && c.pos && c.pos.length) return c; } } catch (e) { }
    var v = viewer();
    try {
      var b = v && v.base && v.base[0];
      if (b && b.pos && b.pos.length) {
        return { pos: b.pos, col: b.col || null, intensity: b.intensity || null, classification: b.classification || null, count: b.count || (b.pos.length / 3), meta: (v._cloudRecord || {}) };
      }
    } catch (e) { }
    return null;
  }
  function toast(m, tone) { try { if (W.__toast) W.__toast(m, tone); else if (W.__lxKit && W.__lxKit.toast) W.__lxKit.toast(m, { tone: tone }); } catch (e) { } }
  function icon(n, s) { try { return W.__lxIcons && W.__lxIcons.svg ? W.__lxIcons.svg(n, s || 16) : ''; } catch (e) { return ''; } }
  function $(id) { return D.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function baseName(p) { return String(p || '').replace(/^.*[\\/]/, ''); }
  function fmt(n) { try { return Number(n).toLocaleString('ru-RU'); } catch (e) { return String(n); } }
  function mm(v) { return v == null || !isFinite(v) ? '—' : (Math.round(Number(v) * 1000) / 1000); }
  function nowStamp() { var d = new Date(), z = function (v) { return String(v).padStart(2, '0'); }; return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()); }

  var CSS = [
    '.lx-p23-panel { position: fixed; right: 14px; bottom: 110px; z-index: 521; width: 440px; max-width: calc(100vw - 28px); max-height: 76vh; overflow: auto; border: 1px solid var(--accent-line); border-radius: var(--r-3); background: var(--bg-1); color: var(--txt); box-shadow: var(--shadow-3); font: 11px/1.35 var(--font); }',
    '.lx-p23-panel[hidden] { display: none; }',
    '.lx-p23-head { display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-bottom: 1px solid var(--line); background: var(--bg-2); position: sticky; top: 0; z-index: 2; }',
    '.lx-p23-head b { flex: 1; font-size: 11.5px; font-weight: 600; }',
    '.lx-p23-x { width: 22px; height: 22px; border: 0; border-radius: 6px; background: transparent; color: var(--txt-3); font: 600 15px/1 var(--font); cursor: pointer; }',
    '.lx-p23-x:hover { background: var(--bg-3); color: var(--txt); }',
    '.lx-p23-body { display: flex; flex-direction: column; gap: 7px; padding: 9px 11px 11px; }',
    '.lx-p23-row { display: flex; align-items: center; gap: 7px; }',
    '.lx-p23-row .lb { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--txt-2); }',
    '.lx-p23-row .lb b { color: var(--txt); font-weight: 600; }',
    '.lx-p23-note { margin: 0; color: var(--txt-3); font-size: 9.5px; line-height: 1.45; }',
    '.lx-p23-field { display: flex; flex-direction: column; gap: 3px; }',
    '.lx-p23-field label { color: var(--txt-3); font-size: 9.5px; }',
    '.lx-p23-field select, .lx-p23-field input, .lx-p23-field textarea { padding: 0 7px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg-2); color: var(--txt); font: 10.5px var(--font); }',
    '.lx-p23-field select, .lx-p23-field input { height: 26px; }',
    '.lx-p23-field textarea { min-height: 54px; padding: 5px 7px; resize: vertical; }',
    '.lx-p23-actions { display: flex; gap: 6px; flex-wrap: wrap; }',
    '.lx-p23-actions button { height: 28px; padding: 0 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg-2); color: var(--txt-2); font: 600 10.5px/1 var(--font); cursor: pointer; }',
    '.lx-p23-actions button.primary { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent); }',
    '.lx-p23-actions button:disabled { opacity: .45; cursor: default; }',
    '.lx-p23-tbl { width: 100%; border-collapse: collapse; font: 10px/1.3 var(--mono); }',
    '.lx-p23-tbl th, .lx-p23-tbl td { padding: 3px 5px; border-bottom: 1px solid var(--line); text-align: left; }',
    '.lx-p23-tbl th { color: var(--txt-3); font-weight: 500; }',
    '.lx-p23-tbl td.n { text-align: right; }',
    '.lx-p23-err { padding: 7px 8px; border: 1px solid #8c4a4a; border-radius: var(--r-2); background: rgba(140,74,74,.16); color: #f0b0b0; font-size: 10px; line-height: 1.45; }',
    '.lx-p23-ok { padding: 7px 8px; border: 1px solid #3f6b4a; border-radius: var(--r-2); background: rgba(63,107,74,.16); color: #a8e0b8; font-size: 10px; }',
    '.lx-p23-log { max-height: 110px; overflow: auto; padding: 6px 8px; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--bg-0, #14171c); color: var(--txt-3); font: 9px/1.4 var(--mono); white-space: pre-wrap; word-break: break-word; }',
    '.lx-p23-kv { display: grid; grid-template-columns: 132px 1fr; gap: 2px 8px; font-size: 10px; }',
    '.lx-p23-kv .k { color: var(--txt-3); }',
    '.lx-p23-kv .v { color: var(--txt); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }'
  ].join('\n');
  function styles() { if (D.getElementById('lxP23Styles')) return; var s = D.createElement('style'); s.id = 'lxP23Styles'; s.textContent = CSS; (D.head || D.documentElement).appendChild(s); }
  function ensureBarButtons() {
    var bar = D.getElementById('lxP1Bar');
    if (!bar || D.getElementById('lxP23Btns')) return;
    var wrap = D.createElement('span'); wrap.id = 'lxP23Btns'; wrap.style.display = 'inline-flex'; wrap.style.gap = '6px';
    wrap.innerHTML = '<button type="button" data-p23="crs" title="Система координат: EPSG/WKT, пересчёт, привязка, координаты углов">' + icon('map', 15) + '<span>Система координат</span></button>' +
      '<button type="button" data-p23="mesh" title="Mesh-инструменты: дыры, Лаплас, удаление, упрощение">' + icon('triangle', 15) + '<span>Mesh-инструменты</span></button>';
    bar.appendChild(wrap);
    wrap.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-p23]'); if (!b) return; e.preventDefault(); e.stopPropagation(); if (b.getAttribute('data-p23') === 'crs') openCrs(); else openMesh(); });
  }

  function panelFor(kind) {
    styles();
    var id = kind === 'crs' ? 'lxCrsPanel' : 'lxMeshPanel';
    var p = $(id);
    if (p) return p;
    p = D.createElement('section'); p.className = 'lx-p23-panel'; p.hidden = true; p.setAttribute('data-p23-panel', kind);
    if (kind === 'crs') p.id = 'lxCrsPanel'; else p.id = 'lxMeshPanel';
    p.addEventListener('click', onClick);
    p.addEventListener('change', onChange);
    D.body.appendChild(p);
    return p;
  }
  function showPanel(kind, html) {
    var p = panelFor(kind); p.innerHTML = html; p.hidden = false; st.view = kind;
    var other = panelFor(kind === 'crs' ? 'mesh' : 'crs'); if (other) other.hidden = true;
  }
  function closePanel(kind) { var p = panelFor(kind); p.hidden = true; if (st.view === kind) st.view = ''; }
  function logLine(ln) {
    if (!ln) return;
    st.log.push(String(ln).slice(0, 300)); if (st.log.length > 120) st.log.shift();
    var box = D.querySelector('[data-p23-log]'); if (!box) return;
    box.textContent = st.log.slice(-30).join('\n'); box.scrollTop = box.scrollHeight;
  }
  function jobId(prefix) { st.jobId = 'p23-' + (prefix || 'job') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); return st.jobId; }
  function subscribe(jobKey) {
    var B = bridge(); if (!B || typeof B.onP23Progress !== 'function') return function () { };
    try { return B.onP23Progress(jobKey, function (p) { if (p && p.phase === 'log' && p.line) logLine(p.line); }); } catch (e) { return function () { }; }
  }
  function storageText() {
    var s = st.storage;
    if (!s) return '';
    if (s.projectSelected && s.projectRoot) return ' · Результаты: ' + baseName(s.projectRoot) + '/output';
    return ' · Папка проекта не выбрана (спросим перед сохранением)';
  }
  function statusText() {
    var s = st.status;
    if (!s) return 'проверяю инструменты…';
    var t = [];
    t.push('crs-tools.py: ' + (s.tools && s.tools.crs ? 'есть' : 'нет'));
    t.push('mesh-tools.py: ' + (s.tools && s.tools.mesh ? 'есть' : 'нет'));
    t.push('Open3D: ' + (s.open3d ? 'есть' : 'нет'));
    if (s.python) t.push('Python: ' + s.python); else t.push('Python не найден');
    return t.join(' · ') + storageText();
  }
  function updateStorageNote() {
    try {
      var p = D.querySelector('.lx-p23-panel:not([hidden])');
      if (!p) return;
      var n = p.querySelector('.lx-p23-note');
      if (n) n.textContent = statusText();
    } catch (e) { }
  }
  function loadStatus() {
    var B = bridge();
    if (!B || typeof B.p23Status !== 'function') { st.status = { tools: {}, python: null, missingBridge: true }; return Promise.resolve(st.status); }
    return Promise.resolve(B.p23Status()).then(function (s) {
      st.status = s || { tools: {} };
      if (s && s.storage) st.storage = s.storage;
      else if (B && typeof B.p23Storage === 'function') { try { B.p23Storage({ action: 'info' }).then(function (x) { if (x) { st.storage = x; updateStorageNote(); } }).catch(function () { }); } catch (e) { } }
      // статус пришёл — обновляем открытую панель (кнопки запуска/подсказки об отсутствии CLI)
      try {
        var crs = D.getElementById('lxCrsPanel'), mesh = D.getElementById('lxMeshPanel');
        if (crs && !crs.hidden && st.view === 'crs') crs.innerHTML = crsPanelHtml();
        if (mesh && !mesh.hidden && st.view === 'mesh') mesh.innerHTML = meshPanelHtml();
      } catch (e) { }
      return st.status;
    }).catch(function (e) { st.status = { tools: {}, error: String((e && e.message) || e) }; return st.status; });
  }

  /* ---------------- CRS ---------------- */
  function extractEpsg(text) {
    if (!text) return null;
    var last = null, m;
    var re = /AUTHORITY\s*\[\s*"EPSG"\s*,\s*"(\d+)"\s*\]/gi;
    while ((m = re.exec(String(text)))) last = m[1];
    var m2 = /EPSG\s*[:\s]\s*(\d{4,6})/i.exec(String(text));
    return m2 ? m2[1] : last;
  }
  function collectCrsInfo() {
    var v = viewer(), t = W.__pcTools, cloud = viewerCloud();
    var rec = null;
    try { rec = v && v._cloudRecord ? v._cloudRecord : null; } catch (e) { rec = null; }
    var wkt = null, xf = null, path = null;
    try { wkt = (t && t.getSourceCrs) ? t.getSourceCrs() : (v && v._srcCrs) || (cloud && cloud.meta && cloud.meta.crsWkt) || null; } catch (e) { wkt = null; }
    try { xf = (t && t.getSourceTransform) ? t.getSourceTransform() : (v && v._srcXform) || null; } catch (e) { xf = null; }
    try { path = W.__bimCurrentCloudPath || (rec && rec.sourceName) || null; } catch (e) { path = null; }
    var model = null;
    try { model = (W.__lxScan2BIM && W.__lxScan2BIM.state && W.__lxScan2BIM.state.model) || (W.BimProjectState && W.BimProjectState.current) || null; } catch (e) { model = null; }
    var bbox = v && v.bbox ? { mn: v.bbox.mn.slice(), mx: v.bbox.mx.slice() } : null;
    var epsg = extractEpsg(wkt) || (cloud && cloud.meta && (cloud.meta.epsg || cloud.meta.crsEpsg)) || null;
    var points = (cloud && cloud.count) || (rec && (rec.loadedCount || rec.sourceCount)) || (v && v.pointCount) || 0;
    var corners = [];
    if (bbox) for (var i = 0; i < 8; i++) corners.push([i & 1 ? bbox.mx[0] : bbox.mn[0], i & 2 ? bbox.mx[1] : bbox.mn[1], i & 4 ? bbox.mx[2] : bbox.mn[2]]);
    return { wkt: wkt || null, epsg: epsg || null, xform: xf || null, path: path, model: model ? (model.name || model.title || 'модель проекта') : null, bbox: bbox, corners: corners, points: points, isYup: true };
  }
  function crsInfoHtml(info) {
    var rows = '';
    rows += '<div class="lx-p23-kv">' +
      '<span class="k">Облако</span><span class="v" title="' + esc(info.path || '') + '">' + esc(info.path ? baseName(info.path) : 'не открыто') + '</span>' +
      '<span class="k">Точек</span><span class="v">' + fmt(info.points || 0) + '</span>' +
      '<span class="k">EPSG / WKT</span><span class="v" title="' + esc(info.wkt || '') + '">' + esc(info.epsg ? ('EPSG:' + info.epsg) : (info.wkt ? 'WKT задан' : 'не задана')) + '</span>' +
      '<span class="k">Модель / проект</span><span class="v">' + esc(info.model || '—') + '</span>' +
      (info.xform ? '<span class="k">Источник → сцена</span><span class="v">' + esc((info.xform.axis || 'z') + '-up → Y-up, сдвиг [' + (info.xform.t || []).map(function (v) { return mm(v); }).join(', ') + ']') + '</span>' : '') +
      '</div>';
    if (info.wkt) rows += '<details><summary class="lx-p23-note" style="cursor:pointer">WKT</summary><div class="lx-p23-log" style="max-height:80px">' + esc(info.wkt.slice(0, 1200)) + '</div></details>';
    else rows += '<p class="lx-p23-note">CRS облака не задана: пересчёт/привязка доступны после выбора целевой СК (EPSG или WKT). Привязку можно записать в LAS/IFC через инструмент.</p>';
    if (info.corners.length) {
      rows += '<table class="lx-p23-tbl"><tr><th>Угол</th><th>X</th><th>Y</th><th>Z</th></tr>' +
        info.corners.map(function (c, i) { return '<tr><td>' + (i + 1) + '</td><td class="n">' + mm(c[0]) + '</td><td class="n">' + mm(c[1]) + '</td><td class="n">' + mm(c[2]) + '</td></tr>'; }).join('') +
        '</table>';
    }
    return rows;
  }
  function crsPanelHtml() {
    var info = st.crsInfo || { corners: [], bbox: null, wkt: null, epsg: null, points: 0 };
    var s = st.status || {}; var tools = s.tools || {};
    var missing = !tools.crs;
    var r = st.crsResult;
    return '<div class="lx-p23-head"><span>' + icon('map', 16) + '</span><b>Система координат</b><button class="lx-p23-x" data-p23="close-crs" aria-label="Закрыть">×</button></div>' +
      '<div class="lx-p23-body">' +
      '<p class="lx-p23-note">' + esc(statusText()) + '</p>' +
      '<div data-p23-crs-info>' + crsInfoHtml(info) + '</div>' +
      '<div class="lx-p23-field"><label>Действие</label><select data-p23="crs-op">' +
      '<option value="info">Показать EPSG / WKT / углы (info)</option>' +
      '<option value="reproject">Пересчитать облако в другую СК</option>' +
      '<option value="georef">Записать привязку в LAS/IFC (--georef-file)</option>' +
      '<option value="corners">Экспорт координат углов (CSV + JSON)</option>' +
      '</select></div>' +
      '<div class="lx-p23-field"><label>Исходная СК (EPSG, если нет VLR в LAS)</label><input data-p23="crs-from" value="' + esc(info.epsg ? String(info.epsg) : '') + '" placeholder="напр. 32636, 25836, 4326" /></div>' +
      '<div class="lx-p23-field"><label>Целевая СК</label><select data-p23="crs-to">' + CRS_PRESETS.map(function (o) { return '<option value="' + o.v + '">' + esc(o.l) + '</option>'; }).join('') + '</select></div>' +
      '<div class="lx-p23-field"><label>Параметры локальной СК (E0,N0,theta_deg,scale — для target=local)</label><input data-p23="crs-local" placeholder="0,0,0,1" /></div>' +
      '<p class="lx-p23-note">WKT читается из облака (VLR/заголовок); для пересчёта укажите EPSG. Привязка пишется в LAS (VLR + georef.json для IFC).</p>' +
      '<div class="lx-p23-actions">' +
      '<button type="button" class="primary" data-p23="crs-run"' + (missing ? ' disabled title="crs-tools.py ещё готовится"' : '') + '>Выполнить</button>' +
      '<button type="button" data-p23="crs-refresh">Обновить</button>' +
      '<button type="button" data-p23="crs-corners-local">Координаты углов (локально)</button>' +
      '</div>' +
      (missing ? '<div class="lx-p23-err">Инструмент «Система координат» ещё готовится: tools/scan2bim-py/crs-tools.py не найден. Панель уже показывает текущую СК/координаты углов и готова к пересчёту, привязке и экспорту, как только CLI появится.</div>' : '') +
      '<div data-p23-crs-result>' + (r ? crsResultHtml(r) : '') + '</div>' +
      '<div class="lx-p23-log" data-p23-log' + (st.log.length ? '' : ' hidden') + '>' + esc(st.log.slice(-30).join('\n')) + '</div>' +
      '</div>';
  }
  function crsResultHtml(r) {
    if (!r) return '';
    if (!r.ok) return '<div class="lx-p23-err">' + esc(r.error || 'не выполнено') + '</div>' + (r.cliMismatch && r.help ? '<details><summary class="lx-p23-note" style="cursor:pointer">CLI --help</summary><div class="lx-p23-log">' + esc(r.help) + '</div></details>' : '');
    var res = r.result || {};
    var html = '<div class="lx-p23-ok">Готово: ' + esc(r.op) + (r.elapsedMs != null ? ' за ' + (r.elapsedMs / 1000).toFixed(2) + ' с' : '') + '.</div>';
    if (res.source) {
      html += '<div class="lx-p23-kv"><span class="k">Источник</span><span class="v">' + esc(res.source.name || '') + '</span>' +
        '<span class="k">EPSG</span><span class="v">' + esc(res.source.epsg || '—') + '</span>' +
        '<span class="k">Точек</span><span class="v">' + fmt(res.points_file || res.points || 0) + '</span>' +
        (res.vlr ? '<span class="k">VLR в LAS</span><span class="v">' + (res.vlr.has_wkt ? 'WKT' : (res.vlr.epsg ? 'EPSG:' + res.vlr.epsg : 'нет')) + '</span>' : '') +
        (res.transform ? '<span class="k">Пересчёт</span><span class="v">' + esc((res.transform.from_epsg || '') + ' → ' + (res.transform.to_epsg || res.transform.to || '')) + '</span>' : '') +
        '</div>';
    }
    if (res.bbox) html += '<p class="lx-p23-note">bbox после: ' + (Array.isArray(res.bbox) ? res.bbox.map(function (v) { return mm(v); }).join(', ') : '') + '</p>';
    if (res.corners_wgs84 && res.corners_wgs84.length) {
      html += '<table class="lx-p23-tbl"><tr><th>Угол</th><th>E</th><th>N</th><th>lon</th><th>lat</th></tr>' +
        res.corners_wgs84.map(function (c, i) { return '<tr><td>' + (i + 1) + '</td><td class="n">' + mm(c.E) + '</td><td class="n">' + mm(c.N) + '</td><td class="n">' + (c.lon != null ? Number(c.lon).toFixed(7) : '—') + '</td><td class="n">' + (c.lat != null ? Number(c.lat).toFixed(7) : '—') + '</td></tr>'; }).join('') +
        '</table>';
    }
    if (r.files && Object.keys(r.files).length) {
      html += '<table class="lx-p23-tbl"><tr><th>Файл</th><th>Путь</th></tr>' +
        Object.keys(r.files).map(function (k) { return '<tr><td>' + esc(k) + '</td><td class="n" title="' + esc(r.files[k]) + '">' + esc(baseName(r.files[k])) + '</td></tr>'; }).join('') + '</table>';
      html += '<div class="lx-p23-actions">' + (r.out ? '<button type="button" class="primary" data-p23="open-crs-out">Открыть облако в сцене</button>' : '') + '<button type="button" data-p23="open-crs-json">JSON-отчёт</button></div>';
    }
    if (res.wkt || (res.source && res.source.wkt)) html += '<details><summary class="lx-p23-note" style="cursor:pointer">WKT</summary><div class="lx-p23-log" style="max-height:100px">' + esc(String((res.source && res.source.wkt) || res.wkt).slice(0, 1500)) + '</div></details>';
    return html;
  }
  function openCrs() {
    st.crsInfo = collectCrsInfo();
    showPanel('crs', crsPanelHtml());
    if (!st.status) loadStatus().then(function () { if (st.view === 'crs') refreshCrsInfo(); });
    return true;
  }
  function refreshCrsInfo() {
    st.crsInfo = collectCrsInfo();
    var p = D.getElementById('lxCrsPanel'); if (!p) return;
    var box = p.querySelector('[data-p23-crs-info]'); if (box) box.innerHTML = crsInfoHtml(st.crsInfo);
    var note = p.querySelector('.lx-p23-note'); if (note) note.textContent = statusText();
  }
  function progressTicker(box, label) {
    var t0 = Date.now();
    if (!box) return function () { };
    box.innerHTML = '<div class="lx-p23-note">' + esc(label) + '…</div>';
    var timer = setInterval(function () {
      if (!box || !box.isConnected) { clearInterval(timer); return; }
      box.innerHTML = '<div class="lx-p23-note">' + esc(label) + '… ' + ((Date.now() - t0) / 1000).toFixed(1) + ' с</div>';
    }, 300);
    return function () { clearInterval(timer); };
  }
  function runCrs() {
    var B = bridge(); if (!B) { toast('Система координат: мост недоступен (desktop)', 'err'); return false; }
    if (st.busy) return false;
    var p = D.getElementById('lxCrsPanel'); if (!p) return false;
    var op = p.querySelector('[data-p23="crs-op"]').value;
    var to = p.querySelector('[data-p23="crs-to"]').value;
    var fromInp = p.querySelector('[data-p23="crs-from"]');
    var from = fromInp ? String(fromInp.value || '').trim() : '';
    var localInp = p.querySelector('[data-p23="crs-local"]');
    var localParams = localInp ? String(localInp.value || '').trim() : '';
    // всегда берём актуальное облако/путь: после пересчёта результат автоматически открыт в сцене
    st.crsInfo = collectCrsInfo();
    var cloud = st.crsInfo && st.crsInfo.path;
    if (!cloud) { toast('Система координат: сначала откройте облако точек', 'warn'); return false; }
    st.busy = true; st.log = [];
    var btn = p.querySelector('[data-p23="crs-run"]'); if (btn) btn.disabled = true;
    var resultBox = p.querySelector('[data-p23-crs-result]');
    var stopTicker = progressTicker(resultBox, 'Выполняется ' + op);
    var log = p.querySelector('[data-p23-log]'); if (log) log.hidden = false;
    var id = jobId('crs'); var unsub = subscribe(id);
    var payload = { op: op, cloud: cloud, to: to, from: from || undefined, localParams: localParams || undefined, jobId: id };
    B.p23CrsRun(payload).then(function (r) {
      stopTicker(); st.busy = false; if (btn) btn.disabled = false; try { unsub(); } catch (e) { }
      st.crsResult = r;
      var box = p.querySelector('[data-p23-crs-result]'); if (box) box.innerHTML = crsResultHtml(r);
      if (r && r.ok && r.result) {
        var rr = r.result, src = rr.source || {}, base = st.crsInfo || {};
        var newEpsg = rr.transform && rr.transform.target_epsg;
        st.crsInfo = Object.assign({}, base, {
          epsg: src.epsg || base.epsg || null,
          wkt: src.wkt || base.wkt || null,
          points: rr.points_file || base.points || 0,
          bbox: rr.bbox || base.bbox || null
        });
        // текущая СК сменилась: поле «Исходная СК» должно соответствовать новому облаку,
        // иначе следующий пересчёт применит устаревший --epsg (например, обратно WGS84→UTM).
        if (fromInp) fromInp.value = (newEpsg && Number(newEpsg) > 0) ? String(newEpsg) : '';
        var infoBox = p.querySelector('[data-p23-crs-info]'); if (infoBox) infoBox.innerHTML = crsInfoHtml(st.crsInfo);
      }
      if (r && r.ok) { toast('Система координат: ' + op + ' — готово', 'ok'); if (r.out && W.__bimOpenCloudPath) { try { W.__bimOpenCloudPath(r.out, { fresh: false }); } catch (e) { } } }
      else toast('Система координат: ' + ((r && r.error) || 'не выполнено'), 'err');
    }).catch(function (e) {
      stopTicker(); st.busy = false; if (btn) btn.disabled = false; try { unsub(); } catch (_) { }
      st.crsResult = { ok: false, error: String((e && e.message) || e) };
      var box = p.querySelector('[data-p23-crs-result]'); if (box) box.innerHTML = crsResultHtml(st.crsResult);
      toast('Система координат: ' + ((e && e.message) || e), 'err');
    });
    return true;
  }
  function exportCornersLocal() {
    var info = st.crsInfo || collectCrsInfo();
    var p = D.getElementById('lxCrsPanel'); if (!p) return false;
    var rows = [['corner', 'x', 'y', 'z']].concat((info.corners || []).map(function (c, i) { return [String(i + 1), c[0].toFixed(4), c[1].toFixed(4), c[2].toFixed(4)]; }));
    var text = rows.map(function (r) { return r.join(','); }).join('\n');
    var box = p.querySelector('[data-p23-crs-result]');
    if (box) box.innerHTML = '<div class="lx-p23-ok">Координаты углов bbox (мир сцены, Y-up) — ' + info.corners.length + ' точек.</div><div class="lx-p23-log" style="max-height:120px">' + esc(text) + '</div><div class="lx-p23-actions"><button type="button" data-p23="copy-corners">Скопировать CSV</button><button type="button" data-p23="crs-corners-file">Сохранить CSV через инструмент</button></div>';
    W.__lxP23LastCorners = text;
    return true;
  }
  function copyCorners() {
    var text = W.__lxP23LastCorners || '';
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); toast('Координаты углов скопированы'); return true; } } catch (e) { }
    toast('Координаты углов: ' + (text.split('\n')[0] || ''), 'info');
    return false;
  }

  /* ---------------- Mesh ---------------- */
  var MESH_OPS = [
    { id: 'fill-holes', label: 'Заполнить отверстия', params: [{ k: 'maxEdges', l: 'Макс. рёбер в контуре дыры', v: 500 }] },
    { id: 'laplacian', label: 'Сгладить (Лаплас)', params: [{ k: 'iterations', l: 'Итераций', v: 5 }, { k: 'lambda', l: 'Сила (0…1)', v: 0.5 }] },
    { id: 'remove-class', label: 'Удалить по классу (цвет класса)', params: [{ k: 'classRGB', l: 'Цвет класса R,G,B', v: '' }, { k: 'tolerance', l: 'Допуск (0…255)', v: 30 }] },
    { id: 'remove-color', label: 'Удалить по цвету', params: [{ k: 'color', l: 'Цвет #RRGGBB', v: '#ff0000' }, { k: 'tolerance', l: 'Допуск (0…255)', v: 30 }] },
    { id: 'simplify', label: 'Упростить', params: [{ k: 'targetTriangles', l: 'Целевое число треугольников', v: '' }, { k: 'voxelSize', l: 'Или шаг вокселя, м', v: '' }] }
  ];
  function meshOpDef(id) { for (var i = 0; i < MESH_OPS.length; i++) if (MESH_OPS[i].id === id) return MESH_OPS[i]; return MESH_OPS[0]; }
  function meshPanelHtml() {
    var s = st.status || {}; var tools = s.tools || {};
    var missing = !tools.mesh;
    var noO3 = !missing && s.open3d === false;      // mesh-tools.py требует Open3D
    var canRun = !missing && !noO3;
    var op = meshOpDef(st.meshOp);
    var r = st.meshResult;
    return '<div class="lx-p23-head"><span>' + icon('triangle', 16) + '</span><b>Mesh-инструменты</b><button class="lx-p23-x" data-p23="close-mesh" aria-label="Закрыть">×</button></div>' +
      '<div class="lx-p23-body">' +
      '<p class="lx-p23-note">' + esc(statusText()) + '</p>' +
      '<div class="lx-p23-row"><span class="lb">Mesh-файл: <b>' + esc(st.meshFile ? baseName(st.meshFile) : (st.meshFromScene || 'не выбран')) + '</b></span><button type="button" data-p23="mesh-pick">Выбрать…</button></div>' +
      '<div class="lx-p23-field"><label>Операция</label><select data-p23="mesh-op">' + MESH_OPS.map(function (o) { return '<option value="' + o.id + '"' + (o.id === op.id ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') + '</select></div>' +
      '<div data-p23-mesh-params>' + op.params.map(function (q) { return '<div class="lx-p23-field"><label>' + esc(q.l) + '</label><input data-p23-param="' + esc(q.k) + '" value="' + esc(q.v == null ? '' : q.v) + '" /></div>'; }).join('') + '</div>' +
      '<div class="lx-p23-actions"><button type="button" class="primary" data-p23="mesh-run"' + (canRun ? '' : ' disabled title="' + (missing ? 'mesh-tools.py ещё готовится' : 'нужен Open3D') + '"') + '>Выполнить</button><button type="button" data-p23="mesh-cancel" disabled>Отмена</button></div>' +
      (missing ? '<div class="lx-p23-err">Mesh-инструменты ещё готовятся: tools/scan2bim-py/mesh-tools.py не найден. Выберите mesh-файл и параметры — операции станут доступны, как только появится CLI.</div>' : '') +
      (noO3 ? '<div class="lx-p23-err">Mesh-инструменты (mesh-tools.py) требуют Open3D в Python-движке: чтение/запись mesh и операции над треугольниками. Установите изолированный Python-движок с Open3D (Настройки → Python/Open3D) — тогда «Заполнить отверстия», «Сглаживание», «Удаление» и «Упрощение» заработают. Облако и сцена не затронуты.</div>' : '') +
      '<div data-p23-mesh-result>' + (r ? meshResultHtml(r) : '') + '</div>' +
      '<div class="lx-p23-log" data-p23-log' + (st.log.length ? '' : ' hidden') + '>' + esc(st.log.slice(-30).join('\n')) + '</div>' +
      '</div>';
  }
  function meshResultHtml(r) {
    if (!r) return '';
    if (!r.ok) return '<div class="lx-p23-err">' + esc(r.error || 'не выполнено') + '</div>' + (r.cliMismatch && r.help ? '<details><summary class="lx-p23-note" style="cursor:pointer">CLI --help</summary><div class="lx-p23-log">' + esc(r.help) + '</div></details>' : '');
    var stt = r.result || {};
    var before = stt.before || {}, after = stt.after || {};
    var triB = before.triangles != null ? before.triangles : stt.trianglesBefore;
    var triA = after.triangles != null ? after.triangles : stt.trianglesAfter;
    var ops = Array.isArray(stt.operations) ? stt.operations : [];
    var html = '<div class="lx-p23-ok">Готово: ' + esc(r.op) + (triB != null ? ' · треугольников ' + fmt(triB) + ' → ' + fmt(triA != null ? triA : '?') : '') + (r.elapsedMs != null ? ' · ' + (r.elapsedMs / 1000).toFixed(2) + ' с' : '') + '.</div>';
    if (r.output) {
      html += '<div class="lx-p23-row"><span class="lb">Результат: <b>' + esc(baseName(r.output)) + '</b></span><button type="button" class="primary" data-p23="mesh-open">Открыть в сцене</button><button type="button" data-p23="mesh-folder">Папка</button></div>';
      for (var i = 0; i < ops.length; i++) {
        var o = ops[i] || {};
        var parts = [];
        if (o.holes_filled != null) parts.push('закрыто отверстий: ' + fmt(o.holes_filled));
        if (o.triangles_added != null) parts.push('добавлено треугольников: ' + fmt(o.triangles_added));
        if (o.moved_vertices != null) parts.push('сдвинуто вершин: ' + fmt(o.moved_vertices) + ' (макс ' + mm(o.max_move_m) + ' м)');
        if (o.triangles_removed != null) parts.push('удалено треугольников: ' + fmt(o.triangles_removed));
        if (o.components_removed != null) parts.push('удалено компонент: ' + fmt(o.components_removed));
        if (o.triangles_after != null) parts.push('треугольников после: ' + fmt(o.triangles_after) + (o.method ? ' (' + o.method + ')' : ''));
        if (parts.length) html += '<p class="lx-p23-note">' + esc(o.op || '') + ': ' + esc(parts.join(' · ')) + '</p>';
      }
      if (after.boundary_edges != null) html += '<p class="lx-p23-note">Граничных рёбер после: ' + fmt(after.boundary_edges) + (after.watertight != null ? ' · watertight: ' + (after.watertight ? 'да' : 'нет') : '') + '</p>';
    }
    if (stt.error) html += '<div class="lx-p23-err">' + esc(stt.error) + '</div>';
    if (r.result) html += '<details><summary class="lx-p23-note" style="cursor:pointer">JSON результата</summary><div class="lx-p23-log" style="max-height:120px">' + esc(JSON.stringify(r.result, null, 1).slice(0, 3000)) + '</div></details>';
    return html;
  }
  function openMesh() {
    if (!st.meshFile) { var v = viewer(); try { if (v && v._cloudRecord && /\.(ply|obj|stl)$/i.test(String(v._cloudRecord.sourceName || ''))) { st.meshFile = ''; st.meshFromScene = baseName(v._cloudRecord.sourceName); } } catch (e) { } }
    showPanel('mesh', meshPanelHtml());
    if (!st.status) loadStatus().then(function () { if (st.view === 'mesh') { var p = D.getElementById('lxMeshPanel'); if (p) { var n = p.querySelector('.lx-p23-note'); if (n) n.textContent = statusText(); } } });
    return true;
  }
  function pickMesh() {
    var B = bridge(); if (!B || typeof B.p23PickMesh !== 'function') { toast('Mesh: выбор файла недоступен', 'warn'); return; }
    B.p23PickMesh().then(function (r) {
      if (!r || !r.ok || !r.path) { if (r && !r.canceled) toast('Mesh: ' + ((r && r.error) || 'файл не выбран'), 'err'); return; }
      st.meshFile = r.path; st.meshFromScene = '';
      var p = D.getElementById('lxMeshPanel'); if (p) { var b = p.querySelector('.lx-p23-row .lb b'); if (b) b.textContent = baseName(r.path); }
      toast('Mesh: ' + baseName(r.path));
    }).catch(function (e) { toast('Mesh: ' + ((e && e.message) || e), 'err'); });
  }
  /** Программный выбор mesh (скрипты/E2E): выдаёт грант чтения и обновляет панель. */
  function setMeshFile(path) {
    var B = bridge(); if (!B || !path) return Promise.resolve({ ok: false, error: 'нет моста/пути' });
    var grant = (typeof B.p23GrantMesh === 'function') ? B.p23GrantMesh({ paths: [path] }) : Promise.resolve({ ok: true });
    return Promise.resolve(grant).then(function (g) {
      if (g && g.ok === false) return { ok: false, error: g.error || 'файл не авторизован' };
      st.meshFile = String(path); st.meshFromScene = '';
      var p = D.getElementById('lxMeshPanel');
      if (p && !p.hidden) { var b = p.querySelector('.lx-p23-row .lb b'); if (b) b.textContent = baseName(path); }
      toast('Mesh: ' + baseName(path));
      return { ok: true, path: String(path) };
    }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
  }
  function meshParamsFromPanel() {
    var p = D.getElementById('lxMeshPanel'); var o = {};
    if (!p) return o;
    Array.prototype.slice.call(p.querySelectorAll('[data-p23-param]')).forEach(function (inp) { var v = String(inp.value || '').trim(); if (v !== '') o[inp.getAttribute('data-p23-param')] = v; });
    return o;
  }
  function runMesh() {
    var B = bridge(); if (!B) { toast('Mesh: мост недоступен (desktop)', 'err'); return false; }
    if (st.busy) return false;
    var p = D.getElementById('lxMeshPanel'); if (!p) return false;
    var op = p.querySelector('[data-p23="mesh-op"]').value;
    if (!st.meshFile) { toast('Mesh: выберите файл (PLY/OBJ/STL)', 'warn'); return false; }
    if (st.status && st.status.tools && st.status.tools.mesh && st.status.open3d === false) {
      toast('Mesh-инструменты: нужен Open3D (Настройки → Python/Open3D)', 'warn');
      return false;
    }
    st.busy = true; st.log = [];
    var btn = p.querySelector('[data-p23="mesh-run"]'); if (btn) btn.disabled = true;
    var cancelBtn = p.querySelector('[data-p23="mesh-cancel"]'); if (cancelBtn) cancelBtn.disabled = false;
    var box = p.querySelector('[data-p23-mesh-result]');
    var stopTicker = progressTicker(box, 'Выполняется ' + op);
    var log = p.querySelector('[data-p23-log]'); if (log) log.hidden = false;
    var id = jobId('mesh'); var unsub = subscribe(id);
    B.p23MeshRun({ op: op, input: st.meshFile, params: meshParamsFromPanel(), jobId: id }).then(function (r) {
      stopTicker(); st.busy = false; if (btn) btn.disabled = false; if (cancelBtn) cancelBtn.disabled = true; try { unsub(); } catch (e) { }
      st.meshResult = r;
      var b2 = p.querySelector('[data-p23-mesh-result]'); if (b2) b2.innerHTML = meshResultHtml(r);
      if (r && r.ok) { toast('Mesh: ' + op + ' — готово', 'ok'); if (r.output) loadMeshIntoScene(r.output); }
      else toast('Mesh: ' + ((r && r.error) || 'не выполнено'), 'err');
    }).catch(function (e) {
      stopTicker(); st.busy = false; if (btn) btn.disabled = false; if (cancelBtn) cancelBtn.disabled = true; try { unsub(); } catch (_) { }
      st.meshResult = { ok: false, error: String((e && e.message) || e) };
      var b2 = p.querySelector('[data-p23-mesh-result]'); if (b2) b2.innerHTML = meshResultHtml(st.meshResult);
      toast('Mesh: ' + ((e && e.message) || e), 'err');
    });
    return true;
  }
  function toMeshBuffer(data) {
    if (!data) return null;
    if (typeof data === 'string') {
      var b64 = data.replace(/^data:[^,]*,/, '');
      var bin = atob(b64), u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8.buffer;
    }
    if (data instanceof ArrayBuffer) return data;
    if (data && data.buffer instanceof ArrayBuffer) return data.buffer.slice(data.byteOffset || 0, (data.byteOffset || 0) + data.byteLength);
    return null;
  }
  function loadMeshIntoScene(path) {
    var MV = W.MeshViewer, A = W.bimAPI;
    if (!MV || !A) { toast('Mesh: вьюер недоступен', 'warn'); return false; }
    // lcc2ReadFile умеет читать файлы по грантам (включая выходные файлы моста);
    // bim:readFile ограничен uploads-каталогом и для mesh-результатов вернёт null.
    var read = (typeof A.lcc2ReadFile === 'function')
      ? A.lcc2ReadFile(path)
      : (typeof A.readFile === 'function' ? A.readFile(path) : Promise.resolve(null));
    Promise.resolve(read).then(function (data) {
      var buf = toMeshBuffer(data);
      if (!buf) { toast('Mesh: не удалось прочитать результат', 'err'); return false; }
      var host = D.querySelector('.stage') || D.body;
      try { MV.mount(host); } catch (e) { }
      var pr = MV.loadAsync ? MV.loadAsync(buf, baseName(path)) : MV.load(buf, baseName(path));
      return Promise.resolve(pr).then(function (scene) {
        if (!scene) { toast('Mesh: загрузка отменена', 'warn'); return false; }
        try { MV.enter(); } catch (e) { }
        toast('Mesh открыт в сцене: ' + baseName(path), 'ok');
        return true;
      });
    }).catch(function (e) { toast('Mesh: ' + ((e && e.message) || e), 'err'); return false; });
    return true;
  }

  /* ---------------- P3: клип-бокс (данные/вьюер/сохранение) ---------------- */
  function getViewerBox() {
    var v = viewer();
    if (!v || !v.bbox || !v.bbox.mn || !v.bbox.mx) return null;
    return { min: { x: v.bbox.mn[0], y: v.bbox.mn[1], z: v.bbox.mn[2] }, max: { x: v.bbox.mx[0], y: v.bbox.mx[1], z: v.bbox.mx[2] } };
  }
  function normBox(box) {
    var b = box || {};
    var out = { min: {}, max: {} };
    ['x', 'y', 'z'].forEach(function (a) {
      var lo = b.min && b.min[a] != null ? Number(b.min[a]) : NaN;
      var hi = b.max && b.max[a] != null ? Number(b.max[a]) : NaN;
      if (!isFinite(lo) || !isFinite(hi)) throw new RangeError('Границы клип-бокса ' + a.toUpperCase() + ' должны быть конечными числами');
      if (lo > hi) { var t = lo; lo = hi; hi = t; }
      out.min[a] = lo; out.max[a] = hi;
    });
    return out;
  }
  function boxToFractions(box) {
    var v = viewer(); var fb = getViewerBox();
    if (!v || !v.bbox || !fb) return null;
    var mn = v.bbox.mn, mx = v.bbox.mx;
    var f = { xmin: 0, xmax: 1, ymin: 0, ymax: 1, zmin: 0, zmax: 1 };
    ['x', 'y', 'z'].forEach(function (a, i) {
      var span = (mx[i] - mn[i]) || 1;
      var lo = (box.min[a] - mn[i]) / span, hi = (box.max[a] - mn[i]) / span;
      lo = Math.max(0, Math.min(1, lo)); hi = Math.max(0, Math.min(1, hi));
      if (lo > hi) { var t = lo; lo = hi; hi = t; }
      f[a + 'min'] = lo; f[a + 'max'] = hi;
    });
    return f;
  }
  function countPointsInBox(box) {
    var cl = viewerCloud();
    if (!cl || !cl.pos || !cl.pos.length) return 0;
    var P = cl.pos, n = Math.min(cl.count || (P.length / 3), P.length / 3);
    var step = n > 3000000 ? Math.ceil(n / 2000000) : 1;
    var cnt = 0;
    for (var i = 0; i < n; i += step) {
      var x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      if (x >= box.min.x && x <= box.max.x && y >= box.min.y && y <= box.max.y && z >= box.min.z && z <= box.max.z) cnt++;
    }
    return step > 1 ? Math.round(cnt * step) : cnt;
  }
  function clipState() {
    var v = viewer(); var box = st.clipBox || getViewerBox();
    return { active: !!(st.clipActive && v && v.section && v.section.on), box: box || null, rotation: 0, points: st.clipActive ? st.clipCount : (box ? countPointsInBox(box) : 0), count: st.clipActive ? st.clipCount : (box ? countPointsInBox(box) : 0), format: 'ply' };
  }
  function clipGetBox() { return st.clipBox || getViewerBox(); }
  function clipSetBox(box) {
    var v = viewer();
    var b;
    try { b = normBox(box); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    st.clipBox = b;
    if (!v || typeof v.setSectionBox !== 'function') return { ok: false, error: 'Вьюер недоступен' };
    try {
      var fr = boxToFractions(b); if (!fr) return { ok: false, error: 'Нет bbox у облака' };
      v.setSectionBox(fr);
      v.setSection(true);
      st.clipActive = true;
      st.clipCount = countPointsInBox(b);
      v.render();
      try { W.dispatchEvent(new CustomEvent('lx-clip-box-changed', { detail: clipState() })); } catch (e2) { }
      return { ok: true, box: b, rotation: 0, count: st.clipCount };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  function clipOpen() {
    var v = viewer(); if (!v || typeof v.setSection !== 'function') return { ok: false, error: 'Сначала откройте облако точек' };
    var b = st.clipBox || getViewerBox();
    if (!b) return { ok: false, error: 'Нет габаритов облака' };
    st.clipBox = b; st.clipActive = true; st.clipCount = countPointsInBox(b);
    try { var fr = boxToFractions(b); if (fr && v.setSectionBox) v.setSectionBox(fr); v.setSection(true); v.render(); } catch (e) { }
    try { W.dispatchEvent(new CustomEvent('lx-clip-box-changed', { detail: clipState() })); } catch (e) { }
    return { ok: true, state: clipState() };
  }
  function clipClose() {
    var v = viewer();
    if (v && typeof v.setSection === 'function') { try { v.setSection(false); v.render(); } catch (e) { } }
    st.clipActive = false;
    try { W.dispatchEvent(new CustomEvent('lx-clip-box-changed', { detail: clipState() })); } catch (e) { }
    return { ok: true, state: clipState() };
  }
  function clipCancel() {
    var v = viewer();
    if (v) { try { if (v.resetSection) v.resetSection(); if (v.setSection) v.setSection(false); v.render(); } catch (e) { } }
    st.clipActive = false; st.clipBox = null; st.clipCount = 0;
    try { W.dispatchEvent(new CustomEvent('lx-clip-box-changed', { detail: clipState() })); } catch (e) { }
    return { ok: true };
  }
  function clipApplyAndSave(arg) {
    var format = (arg && arg.format) || 'ply';
    var B = bridge();
    if (!B || typeof B.p23SaveFragment !== 'function') { toast('Клип-бокс: сохранение фрагмента недоступно (мост)', 'err'); return Promise.resolve({ ok: false, error: 'нет моста сохранения' }); }
    var v = viewer(); if (!v) return Promise.resolve({ ok: false, error: 'нет вьюера' });
    var box = st.clipBox || getViewerBox();
    if (!box) return Promise.resolve({ ok: false, error: 'не задан клип-бокс' });
    var cl = viewerCloud();
    if (!cl || !cl.pos || !cl.pos.length) return Promise.resolve({ ok: false, error: 'нет открытого облака' });
    var P = cl.pos, C = cl.col || null, n = Math.min(cl.count || (P.length / 3), P.length / 3);
    var mn = box.min, mx = box.max; var keep = 0;
    var mask = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      if (x >= mn.x && x <= mx.x && y >= mn.y && y <= mx.y && z >= mn.z && z <= mx.z) { mask[i] = 1; keep++; }
    }
    if (!keep) { toast('Клип-бокс: внутри нет точек', 'warn'); return Promise.resolve({ ok: false, error: 'внутри клип-бокса нет точек', count: 0 }); }
    var outP = new Float32Array(keep * 3);
    var outC = C ? new Uint8Array(keep * 3) : null;
    var j = 0;
    for (var k = 0; k < n; k++) {
      if (!mask[k]) continue;
      outP[j * 3] = P[k * 3]; outP[j * 3 + 1] = P[k * 3 + 1]; outP[j * 3 + 2] = P[k * 3 + 2];
      if (outC) { outC[j * 3] = C[k * 3]; outC[j * 3 + 1] = C[k * 3 + 1]; outC[j * 3 + 2] = C[k * 3 + 2]; }
      j++;
    }
    toast('Клип-бокс: сохраняю фрагмент — ' + fmt(keep) + ' т.', 'info');
    return Promise.resolve(B.p23SaveFragment({ format: format, pos: outP, col: outC || undefined, bbox: box })).then(function (r) {
      if (!r || !r.ok) { toast('Клип-бокс: ' + ((r && r.error) || 'не удалось сохранить'), 'err'); return r || { ok: false, error: 'save failed' }; }
      st.clipLast = r;
      if (W.__bimOpenCloudPath) { try { W.__bimOpenCloudPath(r.path, { fresh: false }); } catch (e) { } }
      toast('Фрагмент сохранён: ' + baseName(r.path) + ' (' + fmt(r.count) + ' т.)', 'ok');
      try { W.dispatchEvent(new CustomEvent('lx-clip-box-saved', { detail: r })); } catch (e) { }
      return { ok: true, path: r.path, count: r.count, bbox: box, format: r.format, bytes: r.bytes };
    }).catch(function (e) { toast('Клип-бокс: ' + ((e && e.message) || e), 'err'); return { ok: false, error: String((e && e.message) || e) }; });
  }
  var CLIP_API = {
    version: '155', open: clipOpen, close: clipClose, state: clipState, cancel: clipCancel,
    setBox: clipSetBox, getBox: clipGetBox, applyAndSave: clipApplyAndSave,
    _countInBox: countPointsInBox, _getViewerBox: getViewerBox
  };
  W.__lxClipBox = CLIP_API;

  /* ---------------- события ---------------- */
  function onClick(e) {
    var t = e.target && e.target.closest && e.target.closest('[data-p23]');
    if (!t) return;
    var a = t.getAttribute('data-p23');
    if (a === 'close-crs') { closePanel('crs'); return; }
    if (a === 'close-mesh') { closePanel('mesh'); return; }
    if (a === 'crs-run') { runCrs(); return; }
    if (a === 'crs-refresh') { refreshCrsInfo(); return; }
    if (a === 'crs-corners-local') { exportCornersLocal(); return; }
    if (a === 'copy-corners') { copyCorners(); return; }
    if (a === 'open-crs-out') { if (st.crsResult && st.crsResult.out && W.__bimOpenCloudPath) { try { W.__bimOpenCloudPath(st.crsResult.out, { fresh: false }); } catch (e) { } } return; }
    if (a === 'open-crs-json') { var B1 = bridge(); if (B1 && st.crsResult && st.crsResult.files) { var f = Object.keys(st.crsResult.files)[0]; try { B1.openFile ? B1.openFile(st.crsResult.files[f]) : null; } catch (e) { } } return; }
    if (a === 'mesh-pick') { pickMesh(); return; }
    if (a === 'mesh-run') { runMesh(); return; }
    if (a === 'mesh-open') { if (st.meshResult && st.meshResult.output) loadMeshIntoScene(st.meshResult.output); return; }
    if (a === 'mesh-folder') { return; }
    if (a === 'mesh-cancel') { var B2 = bridge(); if (B2 && B2.p23Cancel && st.jobId) { try { B2.p23Cancel(st.jobId); } catch (e) { } } toast('Mesh: отмена запрошена', 'warn'); return; }
  }
  function onChange(e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.getAttribute('data-p23') === 'mesh-op') {
      st.meshOp = t.value;
      var p = D.getElementById('lxMeshPanel'); if (!p) return;
      var def = meshOpDef(st.meshOp);
      var box = p.querySelector('[data-p23-mesh-params]');
      if (box) box.innerHTML = def.params.map(function (q) { return '<div class="lx-p23-field"><label>' + esc(q.l) + '</label><input data-p23-param="' + esc(q.k) + '" value="' + esc(q.v == null ? '' : q.v) + '" /></div>'; }).join('');
    }
  }

  /* ---------------- публичный API ---------------- */
  function state() { return { mounted: st.mounted, view: st.view, busy: st.busy, status: st.status, crs: st.crsInfo, meshFile: st.meshFile, meshResult: st.meshResult || null, clip: clipState(), storage: st.storage }; }
  function mount() {
    if (st.mounted) return true;
    st.mounted = true;
    styles();
    ensureBarButtons();
    loadStatus();
    // облако загрузилось/сменилось — обновляем панель CRS (в потоковом режиме getCloud может быть null)
    try {
      ['lx-cloud-loaded', 'bim-cloud-loaded', 'lx-pctools-ready', 'bim-project-state-restored'].forEach(function (ev) {
        W.addEventListener(ev, function () { if (st.view === 'crs') refreshCrsInfo(); });
      });
    } catch (e) { }
    // Кнопка editor-basics: data-p3="open" → открыть наш клип-бокс (если панель ещё не вызывает API сама)
    try {
      D.addEventListener('click', function (e) {
        var b = e.target && e.target.closest && e.target.closest('[data-p3="open"]');
        if (!b) return;
        if (W.__lxClipBox && typeof W.__lxClipBox.open === 'function') { try { W.__lxClipBox.open(); } catch (e) { } }
      }, true);
    } catch (e) { }
    return true;
  }
  var API = { version: '159', mount: mount, openCrs: openCrs, openMesh: openMesh, setMeshFile: setMeshFile, state: state, refreshCrsInfo: refreshCrsInfo, loadMeshIntoScene: loadMeshIntoScene, CRS_PRESETS: CRS_PRESETS.slice(), MESH_OPS: MESH_OPS.slice(), _collectCrsInfo: collectCrsInfo, _extractEpsg: extractEpsg };
  W.__lxP23 = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  function boot() { try { if (D.body) mount(); else D.addEventListener('DOMContentLoaded', mount); } catch (e) { } }
  boot();
})();

