/* BIM Twin — r149 P1: «Пакетная обработка проекта», «Совместить облака», «Классификация».
 * Отдельный слой (динамически грузится из app.js: ui/p1-tools.js?v=149), r130/редизайн r145 не трогает.
 * Очередь: сборка из .xbin → чистка → цвет по фото → экспорт; фоновые задачи с прогрессом и отменой.
 * Если инструменты phase1/phase2 ещё не готовы — понятная заглушка, а не молчаливая кнопка.
 * API: window.__lxP1 = { mount, openBatch, runBatch, cancelBatch, mergeClouds, classify, state, STAGES }.
 */
(function () {
  'use strict';
  var W = window, D = document;
  var st = { mounted: false, batchOpen: false, running: false, cancelled: false, stage: -1, status: '', timer: 0 };
  function icon(n, s) { try { return W.__lxIcons && W.__lxIcons.svg ? W.__lxIcons.svg(n, s || 16) : ''; } catch (e) { return ''; } }
  function toast(m, tone) { try { if (W.__toast) W.__toast(m, tone); else if (W.__lxKit && W.__lxKit.toast) W.__lxKit.toast(m, { tone: tone }); } catch (e) { } }
  function $(id) { return D.getElementById(id); }
  function ops() { return (W.__lxToolsExt && W.__lxToolsExt.ops) || null; }
  function cloudPath() { try { return W.__bimCurrentCloudPath || null; } catch (e) { return null; } }
  function cloudCount() { try { var v = W.__viewer || W.__lxViewer, b = v && v.base && v.base[0]; return b ? ((b._gpuCount | 0) || (b.count | 0)) : 0; } catch (e) { return 0; } }
  function isXbin(p) { return /\.xbin$/i.test(String(p || '')); }
  function available(id) {
    if (id === 'build') return !!(W.__lxAPI && typeof W.__lxAPI.xbinBuildCloud === 'function') || !!(D.querySelector('[data-cmd="opXbinCloud"]'));
    var o = ops();
    if (!o) return false;
    if (id === 'clean') return typeof o.opAutoClean === 'function';
    if (id === 'color') return typeof o.opPhotoColor === 'function';
    if (id === 'export') return typeof o.opWriteData === 'function' || typeof o.opExportE57 === 'function';
    return false;
  }
  var STAGES = [
    { id: 'build', label: 'Сборка облака из .xbin', ico: 'box', api: 'xbinBuildCloud / opXbinCloud' },
    { id: 'clean', label: 'Чистка облака (шум/выбросы)', ico: 'sparkles', api: 'opAutoClean' },
    { id: 'color', label: 'Цвет по фото камер', ico: 'palette', api: 'opPhotoColor' },
    { id: 'export', label: 'Экспорт результата', ico: 'download', api: 'opWriteData / opExportE57' }
  ];

  var CSS = [
    '.lx-p1-bar { position: fixed; right: 14px; bottom: 34px; z-index: 519; display: flex; gap: 6px; padding: 5px; border: 1px solid var(--line); border-radius: 10px; background: var(--glass); box-shadow: var(--shadow-2); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }',
    '.lx-p1-bar button { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 9px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--txt-2); font: 500 11px/1 var(--font); cursor: pointer; }',
    '.lx-p1-bar button:hover { background: var(--bg-3); color: var(--txt); }',
    '.lx-p1-bar button.primary { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent); }',
    '.lx-p1-bar button svg { width: 15px; height: 15px; }',
    '.lx-p1-panel { position: fixed; right: 14px; bottom: 70px; z-index: 520; width: 380px; max-width: calc(100vw - 28px); max-height: 70vh; overflow: auto; border: 1px solid var(--accent-line); border-radius: var(--r-3); background: var(--bg-1); color: var(--txt); box-shadow: var(--shadow-3); font: 11px/1.35 var(--font); }',
    '.lx-p1-panel[hidden] { display: none; }',
    '.lx-p1-head { display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-bottom: 1px solid var(--line); background: var(--bg-2); }',
    '.lx-p1-head b { flex: 1; font-size: 11.5px; font-weight: 600; }',
    '.lx-p1-x { width: 22px; height: 22px; border: 0; border-radius: 6px; background: transparent; color: var(--txt-3); font: 600 15px/1 var(--font); cursor: pointer; }',
    '.lx-p1-x:hover { background: var(--bg-3); color: var(--txt); }',
    '.lx-p1-body { display: flex; flex-direction: column; gap: 7px; padding: 9px 11px 11px; }',
    '.lx-p1-stage { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--bg-2); }',
    '.lx-p1-stage .n { width: 18px; height: 18px; display: grid; place-items: center; border-radius: 50%; background: var(--bg-3); color: var(--txt-3); font: 600 9.5px/1 var(--mono); }',
    '.lx-p1-stage .l { flex: 1; min-width: 0; color: var(--txt-2); }',
    '.lx-p1-stage .s { color: var(--txt-3); font: 9.5px/1 var(--mono); }',
    '.lx-p1-stage.run { border-color: var(--accent-line); background: var(--accent-soft); }',
    '.lx-p1-stage.run .s { color: var(--accent); }',
    '.lx-p1-stage.done .n { background: var(--ok-soft); color: var(--ok); }',
    '.lx-p1-stage.skip .n { background: var(--warn-soft); color: var(--warn); }',
    '.lx-p1-bar-progress { height: 5px; border-radius: 999px; background: var(--bg-3); overflow: hidden; }',
    '.lx-p1-bar-progress i { display: block; height: 100%; width: 0; background: var(--accent); transition: width var(--t-fast); }',
    '.lx-p1-note { margin: 0; color: var(--txt-3); font-size: 9.5px; line-height: 1.45; }',
    '.lx-p1-actions { display: flex; gap: 6px; flex-wrap: wrap; }',
    '.lx-p1-actions button { height: 28px; padding: 0 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg-2); color: var(--txt-2); font: 600 10.5px/1 var(--font); cursor: pointer; }',
    '.lx-p1-actions button.primary { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent); }',
    '.lx-p1-actions button:disabled { opacity: .45; cursor: default; }',
    '@media (max-width: 1100px) { .lx-p1-bar { display: none; } }'
  ].join('\n');
  function styles() { if (D.getElementById('lxP1Styles')) return; var s = document.createElement('style'); s.id = 'lxP1Styles'; s.textContent = CSS; (D.head || D.documentElement).appendChild(s); }

  function htmlBatch() {
    return '<div class="lx-p1-head"><span>' + icon('layers', 16) + '</span><b>Пакетная обработка проекта</b><button class="lx-p1-x" data-p1="close" aria-label="Закрыть">×</button></div>' +
      '<div class="lx-p1-body">' +
      '<div class="lx-p1-bar-progress"><i data-p1-progress style="width:0"></i></div>' +
      '<p class="lx-p1-note" data-p1-status>Очередь: сборка из .xbin → чистка → цвет → экспорт. Задачи идут фоном, окно остаётся отзывчивым.</p>' +
      STAGES.map(function (s, i) {
        var ok = available(s.id);
        return '<div class="lx-p1-stage" data-p1-stage="' + s.id + '"><span class="n">' + (i + 1) + '</span><span class="l">' + s.label + '</span>' +
          '<span class="s" data-p1-stage-status="' + s.id + '">' + (ok ? 'готово к запуску' : 'нет API — заглушка') + '</span></div>';
      }).join('') +
      '<div class="lx-p1-actions">' +
      '<button type="button" class="primary" data-p1="run">Запустить очередь</button>' +
      '<button type="button" data-p1="cancel" disabled>Отмена</button>' +
      '<button type="button" data-p1="merge" title="phase1/phase2: объединение облаков">Совместить облака</button>' +
      '<button type="button" data-p1="classify" title="phase1/phase2: классификация облака">Классификация</button>' +
      '</div>' +
      '<p class="lx-p1-note" data-p1-hint></p>' +
      '</div>';
  }
  function panel() {
    var p = $('lxP1Panel');
    if (p) return p;
    styles();
    p = document.createElement('section'); p.className = 'lx-p1-panel'; p.id = 'lxP1Panel'; p.hidden = true; p.setAttribute('data-p1-panel', '1');
    p.innerHTML = htmlBatch();
    p.addEventListener('click', onClick);
    D.body.appendChild(p);
    return p;
  }
  function bar() {
    var b = $('lxP1Bar'); if (b) return b;
    styles();
    b = document.createElement('div'); b.className = 'lx-p1-bar'; b.id = 'lxP1Bar'; b.setAttribute('data-p1-bar', '1');
    b.innerHTML =
      '<button type="button" class="primary" data-p1="batch" title="Пакетная обработка: .xbin → чистка → цвет → экспорт">' + icon('layers', 15) + '<span>Пакетная обработка проекта</span></button>' +
      '<button type="button" data-p1="merge" title="Совместить облака (phase1/phase2)">' + icon('merge', 15) + '<span>Совместить облака</span></button>' +
      '<button type="button" data-p1="classify" title="Классификация облака (phase1/phase2)">' + icon('grid-3x3', 15) + '<span>Классификация</span></button>';
    b.addEventListener('click', onClick);
    D.body.appendChild(b);
    return b;
  }
  function setStage(id, cls, text) {
    var p = panel();
    var row = p.querySelector('[data-p1-stage="' + id + '"]'); if (!row) return;
    row.classList.remove('run', 'done', 'skip'); if (cls) row.classList.add(cls);
    var s = row.querySelector('[data-p1-stage-status="' + id + '"]'); if (s && text != null) s.textContent = text;
  }
  function setProgress(f, text) {
    var p = panel();
    var barEl = p.querySelector('[data-p1-progress]'); if (barEl) barEl.style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%';
    var s = p.querySelector('[data-p1-status]'); if (s && text != null) s.textContent = text;
  }
  function openBatch() {
    var p = panel(); p.hidden = false; st.batchOpen = true;
    setStatus('Очередь: сборка из .xbin → чистка → цвет → экспорт. Задачи идут фоном, окно остаётся отзывчивым.');
    return true;
  }
  function closeBatch() { var p = panel(); p.hidden = true; st.batchOpen = false; }
  function setStatus(t) { var p = panel(); var s = p.querySelector('[data-p1-status]'); if (s) s.textContent = t; }
  function hint(t) { var p = panel(); var h = p.querySelector('[data-p1-hint]'); if (h) h.textContent = t || ''; }

  function mergeClouds() {
    var o = ops();
    if (o && typeof o.opMerge === 'function') { try { o.opMerge(); toast('Совместить облака: запущено объединение'); return true; } catch (e) { } }
    var b = D.querySelector('[data-cmd="opMerge"]'); if (b) { b.click(); return true; }
    toast('Совместить облака: инструмент phase1/phase2 ещё не подключён — доступно «Объединить» в облаке (opMerge)', 'warn');
    hint('Совместить облака: ждём API phase1/phase2. Текущий аналог — «Объединить» на вкладке «Облако».');
    return false;
  }
  function classify() {
    var v = W.__viewer || W.__lxViewer;
    if (W.__lxClassify && typeof W.__lxClassify.open === 'function') { try { W.__lxClassify.open(); return true; } catch (e) { } }
    if (v && typeof v.setColorMode === 'function') {
      try { if ((v.getAvailableColorModes ? v.getAvailableColorModes() : []).indexOf('classification') >= 0) { v.setColorMode('classification'); toast('Классификация: показ классов включён; разметка — phase1/phase2'); return true; } } catch (e) { }
    }
    toast('Классификация: инструмент phase1/phase2 ещё не подключён — доступен показ классов и «Разметить конструктив»', 'warn');
    hint('Классификация: ждём API phase1/phase2 (разметка пол/стены/потолок), сейчас доступен режим «Классификация» в «Вид облака».');
    return false;
  }
  function canRun(stage) { return available(stage.id); }
  async function runBatch() {
    if (st.running) return false;
    st.running = true; st.cancelled = false; st.stage = 0;
    var p = panel(); var runBtn = p.querySelector('[data-p1="run"]'), cancelBtn = p.querySelector('[data-p1="cancel"]');
    if (runBtn) runBtn.disabled = true; if (cancelBtn) cancelBtn.disabled = false;
    hint('');
    var path = cloudPath(), count = cloudCount();
    setProgress(0.02, 'Пакетная обработка: старт (облако ' + (count ? Math.round(count / 1e6) + ' млн точек' : 'не загружено') + ')');
    if (!path) { setProgress(0, 'Пакетная обработка: облако не загружено из файла — откройте облако и повторите'); hint('Нужен файл облака (.xbin/LAS), открытый в приложении.'); st.running = false; if (runBtn) runBtn.disabled = false; if (cancelBtn) cancelBtn.disabled = true; return false; }
    var o = ops();
    for (var i = 0; i < STAGES.length; i++) {
      if (st.cancelled) break;
      var s = STAGES[i]; st.stage = i;
      setStage(s.id, 'run', 'выполняется…');
      setProgress(i / STAGES.length, 'Пакетная обработка: ' + s.label);
      try {
        if (!canRun(s)) { setStage(s.id, 'skip', 'пропущено: API phase1/phase2 не подключён'); }
        else if (s.id === 'build') {
          var xb = D.querySelector('[data-cmd="opXbinCloud"]');
          if (xb) { xb.click(); setStage(s.id, 'done', 'запущено в фоне (opXbinCloud)'); }
          else { setStage(s.id, 'skip', 'сборка .xbin: нет обработчика (phase1)'); }
          await sleep(50);
        } else if (s.id === 'clean') {
          o.opAutoClean(); setStage(s.id, 'done', 'запущено (opAutoClean)'); await sleep(50);
        } else if (s.id === 'color') {
          o.opPhotoColor(); setStage(s.id, 'done', 'запущено (opPhotoColor)'); await sleep(50);
        } else if (s.id === 'export') {
          if (typeof o.opWriteData === 'function') { o.opWriteData(); setStage(s.id, 'done', 'запущено (opWriteData)'); }
          else if (typeof o.opExportE57 === 'function') { o.opExportE57(); setStage(s.id, 'done', 'запущено (opExportE57)'); }
          else setStage(s.id, 'skip', 'экспорт: нет обработчика');
          await sleep(50);
        }
      } catch (e) { setStage(s.id, 'skip', 'ошибка: ' + String((e && e.message) || e).slice(0, 60)); }
      if (st.cancelled) break;
      await sleep(120);
    }
    if (st.cancelled) { setProgress(0, 'Пакетная обработка отменена'); hint('Очередь остановлена. Уже запущенные фоновые операции завершатся сами.'); }
    else { setProgress(1, 'Пакетная обработка: очередь передана инструментам. Прогресс — в окнах операций.'); }
    st.running = false; if (runBtn) runBtn.disabled = false; if (cancelBtn) cancelBtn.disabled = true;
    return !st.cancelled;
  }
  function cancelBatch() {
    if (!st.running) return false;
    st.cancelled = true;
    try { if (W.__lxProgress && W.__lxProgress.cancel) W.__lxProgress.cancel(); } catch (e) { }
    setProgress(0, 'Пакетная обработка: отмена…');
    return true;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function onClick(e) {
    var t = e.target && e.target.closest && e.target.closest('[data-p1]');
    if (!t) return;
    var a = t.getAttribute('data-p1');
    if (a === 'batch') { openBatch(); return; }
    if (a === 'close') { closeBatch(); return; }
    if (a === 'run') { runBatch(); return; }
    if (a === 'cancel') { cancelBatch(); return; }
    if (a === 'merge') { mergeClouds(); return; }
    if (a === 'classify') { classify(); return; }
  }
  function mount() {
    if (st.mounted) return true;
    st.mounted = true;
    try { bar(); } catch (e) { }
    try { W.addEventListener('lx-cloud-loaded', function () { if (st.batchOpen) { var p = panel(); var stEl = p.querySelector('[data-p1-status]'); if (stEl && !st.running) stEl.textContent = 'Облако загружено (' + Math.round(cloudCount() / 1e6) + ' млн) — можно запускать очередь.'; } }); } catch (e) { }
    return true;
  }
  function state() { return { mounted: st.mounted, batchOpen: st.batchOpen, running: st.running, stage: st.stage, cancelled: st.cancelled, path: cloudPath(), count: cloudCount(), stages: STAGES.map(function (s) { return { id: s.id, label: s.label, available: available(s.id) }; }) }; }

  var API = { version: '149', mount: mount, openBatch: openBatch, closeBatch: closeBatch, runBatch: runBatch, cancelBatch: cancelBatch, mergeClouds: mergeClouds, classify: classify, state: state, STAGES: STAGES.slice(), _available: available };
  W.__lxP1 = API;
  function boot() { try { if (D.body) mount(); else D.addEventListener('DOMContentLoaded', mount); } catch (e) { } }
  boot();
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof globalThis !== 'undefined' && typeof window === 'undefined') { try { globalThis.__lxP1 = API; } catch (e) { } }
})();
