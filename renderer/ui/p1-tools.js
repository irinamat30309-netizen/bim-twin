/* BIM Twin — r151 P1/P2: «Пакетная обработка проекта», «Совместить облака», «Классификация»,
 * «Отчёт о точности» (сверка с эталоном).
 *
 * Готовые Python-инструменты (tools/scan2bim-py) подключены через мост p1-bridge.js:
 *   cloud-register.py  — совмещение (ICP/пары/GCP), результат — LAS + JSON;
 *   cloud-classify.py  — классы пола/стен/крыши/растительности/людей/мебели, JSON + превью;
 *   quality-compare.py — метрики качества против эталона;
 *   cloud-diff.py      — 3D-разница и RMSE плоскостей (для PDF-отчёта о точности).
 *
 * Легаси-путь без моста (jsdom/старые сборки) сохранён: кнопки ведут на существующие
 * обработчики opMerge/opAutoClean/opPhotoColor/opWriteData и понятные заглушки.
 * API: window.__lxP1 = { mount, openBatch, runBatch, cancelBatch, mergeClouds, classify,
 *                        openMerge, openClassify, openAccuracy, runMerge, runAccuracy, state, STAGES }.
 */
(function () {
  'use strict';
  var W = window, D = document;
  var st = {
    mounted: false, view: '', batchOpen: false, running: false, cancelled: false, stage: -1, status: '',
    busy: false, jobId: '', log: [], merged: null, classified: null, accuracy: null,
    refPath: '', srcPath: '', pairsPath: '', mode: 'manual-points', xbinPath: '',
    status2: null, storage: null, storageBusy: false
  };
  var CLASS_LABELS = { ground_floor: 'Пол', wall: 'Стены', roof: 'Крыша', vegetation: 'Растительность', people: 'Люди', clutter: 'Мебель', other: 'Прочее' };
  var ASPRS = { ground_floor: 2, wall: 6, roof: 6, vegetation: 5, people: 18, clutter: 7, other: 1 };

  function icon(n, s) { try { return W.__lxIcons && W.__lxIcons.svg ? W.__lxIcons.svg(n, s || 16) : ''; } catch (e) { return ''; } }
  function toast(m, tone) { try { if (W.__toast) W.__toast(m, tone); else if (W.__lxKit && W.__lxKit.toast) W.__lxKit.toast(m, { tone: tone }); } catch (e) { } }
  function $(id) { return D.getElementById(id); }
  function ops() { return (W.__lxToolsExt && W.__lxToolsExt.ops) || null; }
  function bridge() { try { return (W.bimAPI && typeof W.bimAPI.p1Register === 'function') ? W.bimAPI : null; } catch (e) { return null; } }
  function currentPath() { try { return W.__bimCurrentCloudPath || null; } catch (e) { return null; } }
  function cloudCount() { try { var v = W.__viewer || W.__lxViewer, b = v && v.base && v.base[0]; return b ? ((b._gpuCount | 0) || (b.count | 0)) : 0; } catch (e) { return 0; } }
  function baseName(p) { return String(p || '').replace(/^.*[\\/]/, ''); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtN(n) { try { return Number(n).toLocaleString('ru-RU'); } catch (e) { return String(n); } }
  function mm(m) { return m == null || !isFinite(m) ? '—' : (Math.round(m * 10000) / 10).toFixed(1); }
  function pct(v) { return v == null || !isFinite(v) ? '—' : (Math.round(v * 10) / 10) + '%'; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function nowStamp() { var d = new Date(), z = function (v) { return String(v).padStart(2, '0'); }; return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()); }

  var STAGES = [
    { id: 'build', label: 'Сборка облака из .xbin', ico: 'box', api: 'bimAPI.xbinBuildCloud' },
    { id: 'color', label: 'Цвет по фото камер', ico: 'palette', api: 'bimAPI.photoColorCloud' },
    { id: 'clean', label: 'Чистка облака (шум/выбросы)', ico: 'sparkles', api: 'bimAPI.cleanCloud' },
    { id: 'export', label: 'Экспорт результата', ico: 'download', api: 'bimAPI.p1Export' }
  ];
  // Совместимость с r149: те же четыре стадии в прежнем порядке для простого списка.
  var STAGES_LEGACY = [
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
    '.lx-p1-panel { position: fixed; right: 14px; bottom: 70px; z-index: 520; width: 430px; max-width: calc(100vw - 28px); max-height: 78vh; overflow: auto; border: 1px solid var(--accent-line); border-radius: var(--r-3); background: var(--bg-1); color: var(--txt); box-shadow: var(--shadow-3); font: 11px/1.35 var(--font); }',
    '.lx-p1-panel[hidden] { display: none; }',
    '.lx-p1-head { display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-bottom: 1px solid var(--line); background: var(--bg-2); position: sticky; top: 0; z-index: 2; }',
    '.lx-p1-head b { flex: 1; font-size: 11.5px; font-weight: 600; }',
    '.lx-p1-x { width: 22px; height: 22px; border: 0; border-radius: 6px; background: transparent; color: var(--txt-3); font: 600 15px/1 var(--font); cursor: pointer; }',
    '.lx-p1-x:hover { background: var(--bg-3); color: var(--txt); }',
    '.lx-p1-body { display: flex; flex-direction: column; gap: 7px; padding: 9px 11px 11px; }',
    '.lx-p1-stage { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--bg-2); }',
    '.lx-p1-stage .n { width: 18px; height: 18px; display: grid; place-items: center; border-radius: 50%; background: var(--bg-3); color: var(--txt-3); font: 600 9.5px/1 var(--mono); }',
    '.lx-p1-stage .l { flex: 1; min-width: 0; color: var(--txt-2); }',
    '.lx-p1-stage .s { color: var(--txt-3); font: 9.5px/1 var(--mono); text-align: right; max-width: 46%; }',
    '.lx-p1-stage.run { border-color: var(--accent-line); background: var(--accent-soft); }',
    '.lx-p1-stage.run .s { color: var(--accent); }',
    '.lx-p1-stage.done .n { background: var(--ok-soft); color: var(--ok); }',
    '.lx-p1-stage.skip .n { background: var(--warn-soft); color: var(--warn); }',
    '.lx-p1-bar-progress { height: 5px; border-radius: 999px; background: var(--bg-3); overflow: hidden; }',
    '.lx-p1-bar-progress i { display: block; height: 100%; width: 0; background: var(--accent); transition: width var(--t-fast); }',
    '.lx-p1-note { margin: 0; color: var(--txt-3); font-size: 9.5px; line-height: 1.45; }',
    '.lx-p1-row { display: flex; align-items: center; gap: 7px; }',
    '.lx-p1-row .lb { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.lx-p1-row .lb b { color: var(--txt); font-weight: 600; }',
    '.lx-p1-actions { display: flex; gap: 6px; flex-wrap: wrap; }',
    '.lx-p1-actions button { height: 28px; padding: 0 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg-2); color: var(--txt-2); font: 600 10.5px/1 var(--font); cursor: pointer; }',
    '.lx-p1-actions button.primary { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent); }',
    '.lx-p1-actions button:disabled { opacity: .45; cursor: default; }',
    '.lx-p1-field { display: flex; flex-direction: column; gap: 3px; }',
    '.lx-p1-field label { color: var(--txt-3); font-size: 9.5px; }',
    '.lx-p1-field select, .lx-p1-field input[type=text] { height: 26px; padding: 0 7px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg-2); color: var(--txt); font: 10.5px var(--font); }',
    '.lx-p1-check { display: flex; align-items: center; gap: 6px; color: var(--txt-2); font-size: 10px; }',
    '.lx-p1-err { padding: 7px 8px; border: 1px solid #8c4a4a; border-radius: var(--r-2); background: rgba(140,74,74,.16); color: #f0b0b0; font-size: 10px; line-height: 1.45; }',
    '.lx-p1-ok { padding: 7px 8px; border: 1px solid #3f6b4a; border-radius: var(--r-2); background: rgba(63,107,74,.16); color: #a8e0b8; font-size: 10px; }',
    '.lx-p1-tbl { width: 100%; border-collapse: collapse; font: 10px/1.3 var(--mono); }',
    '.lx-p1-tbl th, .lx-p1-tbl td { padding: 3px 5px; border-bottom: 1px solid var(--line); text-align: left; }',
    '.lx-p1-tbl th { color: var(--txt-3); font-weight: 500; }',
    '.lx-p1-tbl td.n { text-align: right; }',
    '.lx-p1-cbar { height: 6px; border-radius: 999px; background: var(--bg-3); overflow: hidden; min-width: 60px; }',
    '.lx-p1-cbar i { display: block; height: 100%; background: var(--accent); }',
    '.lx-p1-log { max-height: 110px; overflow: auto; padding: 6px 8px; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--bg-0, #14171c); color: var(--txt-3); font: 9px/1.4 var(--mono); white-space: pre-wrap; word-break: break-word; }',
    '.lx-p1-thumb { display: block; width: 100%; border: 1px solid var(--line); border-radius: var(--r-2); }',
    '.lx-p1-badge { display: inline-block; padding: 1px 6px; border-radius: 999px; font: 600 9px/1.5 var(--mono); }',
    '.lx-p1-badge.ok { background: var(--ok-soft); color: var(--ok); }',
    '.lx-p1-badge.fail { background: rgba(140,74,74,.25); color: #f0b0b0; }',
    '.lx-p1-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }',
    '.lx-p1-storage-bar { position: fixed; left: 14px; bottom: 34px; z-index: 519; display: flex; align-items: center; gap: 6px; max-width: min(560px, calc(100vw - 470px)); padding: 5px 8px; border: 1px solid var(--line); border-radius: 10px; background: var(--glass); box-shadow: var(--shadow-2); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); font: 9.5px/1.35 var(--font); color: var(--txt-3); }',
    '.lx-p1-storage-bar[hidden] { display: none; }',
    '.lx-p1-storage-bar .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.lx-p1-storage-bar .t b { color: var(--txt-2); font-weight: 600; }',
    '.lx-p1-storage-bar.warn { border-color: #8c6a3a; }',
    '.lx-p1-storage-bar button { height: 22px; padding: 0 7px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg-2); color: var(--txt-2); font: 600 9.5px/1 var(--font); cursor: pointer; white-space: nowrap; }',
    '.lx-p1-storage-bar button.primary { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent); }',
    '@media (max-width: 1100px) { .lx-p1-bar { display: none; } .lx-p1-storage-bar { display: none; } }'
  ].join('\n');
  function styles() { if (D.getElementById('lxP1Styles')) return; var s = D.createElement('style'); s.id = 'lxP1Styles'; s.textContent = CSS; (D.head || D.documentElement).appendChild(s); }

  // ---------- панель ----------
  function panel() {
    var p = $('lxP1Panel');
    if (p) return p;
    styles();
    p = D.createElement('section'); p.className = 'lx-p1-panel'; p.id = 'lxP1Panel'; p.hidden = true; p.setAttribute('data-p1-panel', '1');
    p.addEventListener('click', onClick);
    p.addEventListener('change', onChange);
    D.body.appendChild(p);
    return p;
  }
  function setView(name, html) {
    var p = panel(); st.view = name; p.innerHTML = html; p.hidden = false;
    st.batchOpen = name === 'batch';
  }
  function closePanel() { var p = panel(); p.hidden = true; st.view = ''; st.batchOpen = false; }
  function bar() {
    var b = $('lxP1Bar'); if (b) return b;
    styles();
    b = D.createElement('div'); b.className = 'lx-p1-bar'; b.id = 'lxP1Bar'; b.setAttribute('data-p1-bar', '1');
    b.innerHTML =
      '<button type="button" class="primary" data-p1="batch" title="Пакетная обработка: .xbin → цвет → чистка → экспорт">' + icon('layers', 15) + '<span>Пакетная обработка проекта</span></button>' +
      '<button type="button" data-p1="merge" title="Совместить облака: ICP / пары точек / GCP">' + icon('merge', 15) + '<span>Совместить облака</span></button>' +
      '<button type="button" data-p1="classify" title="Классификация облака: пол/стены/крыша/растительность">' + icon('grid-3x3', 15) + '<span>Классификация</span></button>' +
      '<button type="button" data-p1="accuracy" title="Отчёт о точности: сверка с эталоном (RMSE плоскостей, 3D-разница, PDF)">' + icon('crosshair', 15) + '<span>Отчёт о точности</span></button>';
    b.addEventListener('click', onClick);
    D.body.appendChild(b);
    return b;
  }
  function setStatus(t) { var p = panel(); var s = p.querySelector('[data-p1-status]'); if (s) s.textContent = t || ''; }
  // ---------- r184: где сохраняются результаты + старые папки AppData ----------
  function fmtBytes(b) {
    var n = Number(b) || 0;
    if (n >= 1024 * 1024 * 1024) return (n / 1073741824).toFixed(1).replace('.', ',') + ' ГБ';
    if (n >= 1024 * 1024) return (n / 1048576).toFixed(1).replace('.', ',') + ' МБ';
    if (n >= 1024) return Math.round(n / 1024) + ' КБ';
    return n + ' Б';
  }
  function storageBar() {
    var b = $('lxP1StorageBar'); if (b) return b;
    styles();
    b = D.createElement('div'); b.className = 'lx-p1-storage-bar'; b.id = 'lxP1StorageBar'; b.hidden = true; b.setAttribute('data-p1-storage-bar', '1');
    b.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-p1storage]') : null; if (!t) return;
      e.preventDefault(); e.stopPropagation();
      var a = t.getAttribute('data-p1storage');
      if (a === 'choose') chooseStorage();
      else if (a === 'clean') cleanLegacyStorage();
    });
    D.body.appendChild(b);
    return b;
  }
  function renderStorage() {
    var b = storageBar(), s = st.storage;
    if (!s || !s.ok) { b.hidden = true; return; }
    b.hidden = false;
    var parts = [];
    if (s.projectSelected && s.projectRoot) {
      parts.push('<span class="t">Результаты: <b title="' + esc(s.projectRoot) + '">' + esc(baseName(s.projectRoot)) + '</b>' + (s.outputRoot ? ' → output/' : '') + '</span>');
      parts.push('<button type="button" data-p1storage="choose" title="Сменить папку проекта">Папка…</button>');
    } else {
      parts.push('<span class="t">Папка проекта не выбрана — результаты пишутся только в неё</span>');
      parts.push('<button type="button" class="primary" data-p1storage="choose">Выбрать папку</button>');
    }
    var legacyBytes = Number(s.legacyBytes) || (s.legacy && s.legacy.bytes) || 0;
    if (legacyBytes > 0) {
      b.classList.add('warn');
      parts.push('<span class="t">Старые результаты в AppData: <b>' + fmtBytes(legacyBytes) + '</b></span>');
      parts.push('<button type="button" data-p1storage="clean" title="Удалить только папки p1-r151 и p2p3-r155 после подтверждения">Удалить</button>');
    } else b.classList.remove('warn');
    b.innerHTML = parts.join('');
  }
  function loadStorage() {
    var B = bridge(); if (!B || typeof B.p1Storage !== 'function') { renderStorage(); return Promise.resolve(null); }
    return Promise.resolve(B.p1Storage({ action: 'info' })).then(function (s) {
      st.storage = s || null; renderStorage(); return st.storage;
    }).catch(function () { renderStorage(); return null; });
  }
  function chooseStorage() {
    var B = bridge(); if (!B || typeof B.p1Storage !== 'function') return;
    if (st.storageBusy) return; st.storageBusy = true;
    Promise.resolve(B.p1Storage({ action: 'choose' })).then(function (r) {
      st.storageBusy = false;
      if (r && r.canceled) return;
      if (r && r.ok) { toast('Папка проекта выбрана: результаты инструментов будут сохраняться в неё'); loadStorage(); }
      else toast((r && r.error) || 'Не удалось выбрать папку проекта', 'err');
    }).catch(function (e) { st.storageBusy = false; toast(String((e && e.message) || e), 'err'); });
  }
  async function cleanLegacyStorage() {
    var B = bridge(); if (!B || typeof B.p1Storage !== 'function' || st.storageBusy) return;
    var sz = fmtBytes((st.storage && (st.storage.legacyBytes || (st.storage.legacy && st.storage.legacy.bytes))) || 0);
    var ok = false;
    try {
      if (W.__lxKit && W.__lxKit.ask) ok = await W.__lxKit.ask({ title: 'Удалить старые результаты?', message: 'В AppData (папка приложения) остались результаты старых версий инструментов: ' + sz + '. Удалить только папки p1-r151 и p2p3-r155? Новые результаты лежат в папке проекта.', okLabel: 'Удалить', cancelLabel: 'Оставить' });
      else if (W.confirm) ok = W.confirm('Удалить старые результаты инструментов в AppData (' + sz + ')?');
    } catch (_) { ok = false; }
    if (!ok) return;
    st.storageBusy = true;
    Promise.resolve(B.p1Storage({ action: 'cleanLegacy', confirm: true })).then(function (r) {
      st.storageBusy = false;
      if (r && r.ok) toast('Старые результаты удалены: ' + ((r.removed || []).filter(function (x) { return x.existed; }).length) + ' папок, ' + fmtBytes((r.removed || []).reduce(function (a, x) { return a + (x.bytes || 0); }, 0)));
      else toast((r && r.error) || 'Не удалось удалить старые результаты', 'err');
      loadStorage();
    }).catch(function (e) { st.storageBusy = false; toast(String((e && e.message) || e), 'err'); });
  }

  function setHint(t) { var p = panel(); var h = p.querySelector('[data-p1-hint]'); if (h) h.textContent = t || ''; }
  function setProgress(f, text) {
    var p = panel();
    var barEl = p.querySelector('[data-p1-progress]'); if (barEl) barEl.style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%';
    if (text != null) setStatus(text);
  }
  function logLine(ln) {
    if (!ln) return;
    st.log.push(String(ln).slice(0, 300));
    if (st.log.length > 120) st.log.shift();
    var p = D.getElementById('lxP1Panel'); if (!p) return;
    var box = p.querySelector('[data-p1-log]'); if (!box) return;
    box.textContent = st.log.slice(-30).join('\n');
    box.scrollTop = box.scrollHeight;
  }
  function jobId(prefix) { st.jobId = 'p1-' + (prefix || 'job') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); return st.jobId; }
  function subscribeJob(id) {
    var B = bridge(); if (!B || typeof B.onP1Progress !== 'function') return function () { };
    try { return B.onP1Progress(id, function (payload) {
      if (!payload) return;
      if (payload.phase === 'log' && payload.line) logLine(payload.line);
      else if (payload.phase === 'start') logLine('… ' + (payload.tool || '') + ' запущен');
      else if (payload.phase === 'done') logLine('готово ' + (payload.tool || '') + ' за ' + ((payload.elapsedMs || 0) / 1000).toFixed(1) + ' с');
    }); } catch (e) { return function () { }; }
  }

  // ---------- ЛЕГАЦИЯ r149 (без моста): простой список стадий ----------
  function htmlBatchLegacy() {
    return '<div class="lx-p1-head"><span>' + icon('layers', 16) + '</span><b>Пакетная обработка проекта</b><button class="lx-p1-x" data-p1="close" aria-label="Закрыть">×</button></div>' +
      '<div class="lx-p1-body">' +
      '<div class="lx-p1-bar-progress"><i data-p1-progress style="width:0"></i></div>' +
      '<p class="lx-p1-note" data-p1-status>Очередь: сборка из .xbin → чистка → цвет → экспорт. Задачи идут фоном, окно остаётся отзывчивым.</p>' +
      STAGES_LEGACY.map(function (s, i) {
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
  function available(id) {
    if (id === 'build') return !!(W.__lxAPI && typeof W.__lxAPI.xbinBuildCloud === 'function') || !!(D.querySelector('[data-cmd="opXbinCloud"]'));
    var o = ops();
    if (!o) return false;
    if (id === 'clean') return typeof o.opAutoClean === 'function';
    if (id === 'color') return typeof o.opPhotoColor === 'function';
    if (id === 'export') return typeof o.opWriteData === 'function' || typeof o.opExportE57 === 'function';
    return false;
  }
  function openBatchLegacy() {
    setView('batch', htmlBatchLegacy());
    setStatus('Очередь: сборка из .xbin → чистка → цвет → экспорт. Задачи идут фоном, окно остаётся отзывчивым.');
    return true;
  }
  function setStage(id, cls, text) {
    var p = D.getElementById('lxP1Panel'); if (!p) return;
    var row = p.querySelector('[data-p1-stage="' + id + '"]'); if (!row) return;
    row.classList.remove('run', 'done', 'skip'); if (cls) row.classList.add(cls);
    var s = row.querySelector('[data-p1-stage-status="' + id + '"]'); if (s && text != null) s.textContent = text;
  }
  function runBatchLegacy() {
    if (st.running) return Promise.resolve(false);
    st.running = true; st.cancelled = false; st.stage = 0;
    var p = panel(); var runBtn = p.querySelector('[data-p1="run"]'), cancelBtn = p.querySelector('[data-p1="cancel"]');
    if (runBtn) runBtn.disabled = true; if (cancelBtn) cancelBtn.disabled = false;
    setHint('');
    var path = currentPath(), count = cloudCount();
    setProgress(0.02, 'Пакетная обработка: старт (облако ' + (count ? Math.round(count / 1e6) + ' млн точек' : 'не загружено') + ')');
    if (!path) { setProgress(0, 'Пакетная обработка: облако не загружено из файла — откройте облако и повторите'); setHint('Нужен файл облака (.xbin/LAS), открытый в приложении.'); st.running = false; if (runBtn) runBtn.disabled = false; if (cancelBtn) cancelBtn.disabled = true; return Promise.resolve(false); }
    var o = ops();
    var chain = Promise.resolve(true);
    STAGES_LEGACY.forEach(function (s, i) {
      chain = chain.then(function (ok) {
        if (!ok || st.cancelled) return ok;
        st.stage = i;
        setStage(s.id, 'run', 'выполняется…');
        setProgress(i / STAGES_LEGACY.length, 'Пакетная обработка: ' + s.label);
        return sleep(40).then(function () {
          try {
            if (!available(s.id)) setStage(s.id, 'skip', 'пропущено: API phase1/phase2 не подключён');
            else if (s.id === 'build') { var xb = D.querySelector('[data-cmd="opXbinCloud"]'); if (xb) { xb.click(); setStage(s.id, 'done', 'запущено в фоне (opXbinCloud)'); } else setStage(s.id, 'skip', 'сборка .xbin: нет обработчика (phase1)'); }
            else if (s.id === 'clean') { o.opAutoClean(); setStage(s.id, 'done', 'запущено (opAutoClean)'); }
            else if (s.id === 'color') { o.opPhotoColor(); setStage(s.id, 'done', 'запущено (opPhotoColor)'); }
            else if (s.id === 'export') {
              if (typeof o.opWriteData === 'function') { o.opWriteData(); setStage(s.id, 'done', 'запущено (opWriteData)'); }
              else if (typeof o.opExportE57 === 'function') { o.opExportE57(); setStage(s.id, 'done', 'запущено (opExportE57)'); }
              else setStage(s.id, 'skip', 'экспорт: нет обработчика');
            }
          } catch (e) { setStage(s.id, 'skip', 'ошибка: ' + String((e && e.message) || e).slice(0, 60)); }
          return sleep(80).then(function () { return !st.cancelled; });
        });
      });
    });
    return chain.then(function (ok) {
      if (st.cancelled) { setProgress(0, 'Пакетная обработка отменена'); setHint('Очередь остановлена. Уже запущенные фоновые операции завершатся сами.'); }
      else { setProgress(1, 'Пакетная обработка: очередь передана инструментам. Прогресс — в окнах операций.'); }
      st.running = false; if (runBtn) runBtn.disabled = false; if (cancelBtn) cancelBtn.disabled = true;
      return !st.cancelled;
    });
  }
  function cancelBatch() {
    if (!st.running) return false;
    st.cancelled = true;
    var B = bridge();
    if (B && st.jobId) { try { B.p1Cancel(st.jobId); } catch (e) { } }
    try { if (W.__lxProgress && W.__lxProgress.cancel) W.__lxProgress.cancel(); } catch (e) { }
    setProgress(0, 'Пакетная обработка: отмена…');
    return true;
  }

  // ---------- РЕАЛЬНЫЙ путь r151: мост к Python ----------
  function bridgeErr(res) { return (res && (res.error || res.message)) || 'неизвестная ошибка'; }

  function htmlMerge() {
    var s = st.status2 || {};
    var icpNoO3 = s && s.python && s.open3d === false;
    return '<div class="lx-p1-head"><span>' + icon('merge', 16) + '</span><b>Совместить облака</b><button class="lx-p1-x" data-p1="close" aria-label="Закрыть">×</button></div>' +
      '<div class="lx-p1-body">' +
      '<div class="lx-p1-row"><span class="lb">Эталон (ref): <b data-p1-engine-ref>' + esc(st.refPath ? baseName(st.refPath) : 'не выбран') + '</b></span><button type="button" data-p1="pick-ref">Выбрать…</button></div>' +
      '<div class="lx-p1-row"><span class="lb">Исходное (src): <b data-p1-src>' + esc(st.srcPath ? baseName(st.srcPath) : 'не выбрано') + '</b></span><button type="button" data-p1="pick-src">Выбрать…</button></div>' +
      '<div class="lx-p1-field"><label>Режим совмещения</label><select data-p1="mode">' +
      '<option value="icp"' + (st.mode === 'icp' ? ' selected' : '') + '>ICP (авто, Open3D)' + (icpNoO3 ? ' — Open3D не найден' : '') + '</option>' +
      '<option value="manual-points"' + (st.mode === 'manual-points' ? ' selected' : '') + '>Пары точек (вручную, без Open3D)</option>' +
      '<option value="gcp"' + (st.mode === 'gcp' ? ' selected' : '') + '>GCP (контрольные точки)</option>' +
      '</select></div>' +
      '<div class="lx-p1-row" data-p1-pairs-row' + (st.mode === 'icp' ? ' hidden' : '') + '><span class="lb">Пары src→ref: <b>' + esc(st.pairsPath ? baseName(st.pairsPath) : 'не выбран') + '</b></span><button type="button" data-p1="pick-pairs">Файл…</button></div>' +
      '<label class="lx-p1-check"><input type="checkbox" data-p1="auto-init" checked /> Авто-инициализация ICP (FPFH+RANSAC)</label>' +
      '<label class="lx-p1-check"><input type="checkbox" data-p1="strict" checked /> Строгий порог точности ' + (st.mode === 'icp' ? '5 см' : '15 см') + ' (не прошёл — ошибка, не грузим)</label>' +
      '<div class="lx-p1-bar-progress"><i data-p1-progress style="width:0"></i></div>' +
      '<p class="lx-p1-note" data-p1-status>' + (icpNoO3 ? 'ICP требует Open3D. Доступны режимы «Пары точек» и «GCP» — они работают без Open3D.' : 'Инструмент: cloud-register.py. Результат — LAS в координатах эталона + JSON с матрицей/RMS.') + '</p>' +
      '<div class="lx-p1-actions"><button type="button" class="primary" data-p1="run-merge">Совместить</button><button type="button" data-p1="cancel-merge">Отмена</button></div>' +
      '<div data-p1-merge-result></div>' +
      '<div class="lx-p1-log" data-p1-log hidden></div>' +
      '<p class="lx-p1-note" data-p1-hint>Совмещение идёт фоном; после успеха облако откроется в сцене, JSON можно открыть кнопкой.</p>' +
      '</div>';
  }
  function openMerge() {
    var B = bridge();
    if (!B) return mergeCloudsLegacy();
    setView('merge', htmlMerge());
    if (!st.status2) { try { B.p1Status().then(function (s) { st.status2 = s || null; if (st.view === 'merge' && s) { var p = panel(); var n = p.querySelector('[data-p1-status]'); if (n && !st.busy) n.textContent = 'Python: ' + (s.python || 'не найден') + ' · Open3D: ' + (s.open3d ? 'есть' : 'нет') + ' · инструменты: ' + Object.keys(s.tools || {}).filter(function (k) { return s.tools[k]; }).join(', '); } }).catch(function () { }); } catch (e) { } }
    return true;
  }
  function pickCloud(which) {
    var B = bridge(); if (!B) return;
    B.p1PickClouds({}).then(function (r) {
      if (!r || !r.ok || !r.paths || !r.paths[0]) { if (r && !r.canceled) toast('Файл не выбран: ' + bridgeErr(r), 'err'); return; }
      if (which === 'ref') st.refPath = r.paths[0]; else st.srcPath = r.paths[0];
      if (st.view === 'accuracy') { st.refPath = r.paths[0]; refreshAccuracyHead(); }
      else if (st.view === 'merge') { var p = panel(); var a = p.querySelector('[data-p1-engine-ref]'), b = p.querySelector('[data-p1-src]'); if (a) a.textContent = baseName(st.refPath || ''); if (b) b.textContent = baseName(st.srcPath || ''); }
      toast('Выбрано: ' + baseName(r.paths[0]));
    }).catch(function (e) { toast('Выбор файла: ' + (e && e.message || e), 'err'); });
  }
  function pickPairs() {
    var B = bridge(); if (!B) return;
    B.p1PickPairs().then(function (r) {
      if (!r || !r.ok || !r.path) { if (r && !r.canceled) toast('Файл пар не выбран', 'err'); return; }
      st.pairsPath = r.path;
      var p = panel(); var row = p.querySelector('[data-p1-pairs-row] .lb b'); if (row) row.textContent = baseName(r.path);
      toast('Пары: ' + baseName(r.path));
    }).catch(function (e) { toast('Файл пар: ' + (e && e.message || e), 'err'); });
  }
  function runMerge() {
    var B = bridge(); if (!B || st.busy) return false;
    if (!st.refPath) { toast('Совместить: выберите эталон (ref)', 'warn'); return false; }
    if (!st.srcPath) { toast('Совместить: выберите исходное облако (src)', 'warn'); return false; }
    var mode = st.mode;
    if (mode !== 'icp' && !st.pairsPath) { toast('Совместить: для режима пар/GCP выберите файл пар (JSON/CSV)', 'warn'); return false; }
    var p = panel();
    var pAuto = p.querySelector('[data-p1="auto-init"]'), pStrict = p.querySelector('[data-p1="strict"]');
    st.busy = true; st.cancelled = false;
    var id = jobId('register'); var unsub = subscribeJob(id);
    setProgress(0.05, 'Совмещение: запуск cloud-register.py…');
    p.querySelector('[data-p1-log]') && (p.querySelector('[data-p1-log]').hidden = false);
    var btn = p.querySelector('[data-p1="run-merge"]'); if (btn) btn.disabled = true;
    var t0 = Date.now();
    var timer = setInterval(function () { var el = (Date.now() - t0) / 1000; var s = p.querySelector('[data-p1-status]'); if (s && st.busy) s.textContent = 'Совмещение идёт… ' + el.toFixed(1) + ' с (mode=' + mode + ')'; setProgress(Math.min(0.9, 0.05 + el / 60), null); }, 400);
    B.p1Register({ ref: st.refPath, src: [st.srcPath], mode: mode, pairs: st.pairsPath, autoInit: !!(pAuto && pAuto.checked), strict: !!(pStrict && pStrict.checked), jobId: id }).then(function (res) {
      clearInterval(timer); st.busy = false; if (btn) btn.disabled = false; try { unsub(); } catch (e) { }
      var box = p.querySelector('[data-p1-merge-result]');
      if (!res || !res.ok) {
        var err = bridgeErr(res);
        if (res && res.needOpen3D) err = res.error || 'ICP требует Open3D — выберите «Пары точек»/«GCP»';
        setProgress(0, 'Совмещение не выполнено');
        if (box) box.innerHTML = '<div class="lx-p1-err">' + esc(err) + '</div>';
        toast('Совместить облака: ' + err, 'err');
        return;
      }
      st.merged = res;
      setProgress(1, 'Совмещение выполнено');
      var r0 = (res.results && res.results[0]) || {};
      var rms = r0.rms || {};
      var rmsVal = rms.rms_inlier_m != null ? rms.rms_inlier_m : rms.rms_m;
      var html = '<div class="lx-p1-ok">Готово: строгий порог ' + (r0.strictPass ? 'пройден' : 'не пройден') + ', RMS ' + mm(rmsVal) + ' мм' + (r0.strictThreshold != null ? ' (порог ' + Math.round(r0.strictThreshold * 1000) + ' мм)' : '') + '.</div>' +
        '<table class="lx-p1-tbl"><tr><th>Параметр</th><th>Значение</th></tr>' +
        '<tr><td>Режим</td><td>' + esc(res.mode) + '</td></tr>' +
        '<tr><td>Поворот yaw</td><td class="n">' + (r0.yawDeg != null ? r0.yawDeg + '°' : '—') + '</td></tr>' +
        '<tr><td>Сдвиг</td><td class="n">' + (r0.translation ? r0.translation.map(function (v) { return (Math.round(v * 1000) / 1000); }).join(', ') + ' м' : '—') + '</td></tr>' +
        '<tr><td>RMS</td><td class="n">' + mm(rmsVal) + ' мм</td></tr>' +
        '<tr><td>inlier</td><td class="n">' + (rms.inlier_ratio != null ? pct(rms.inlier_ratio * 100) : '—') + '</td></tr>' +
        '<tr><td>Время</td><td class="n">' + (res.elapsed_s != null ? res.elapsed_s + ' с' : '—') + '</td></tr></table>' +
        '<div class="lx-p1-actions">' + (res.outLas ? '<button type="button" class="primary" data-p1="load-merge">Открыть результат в сцене</button>' : '') +
        '<button type="button" data-p1="open-merge-json">JSON-отчёт</button>' +
        '<button type="button" data-p1="open-merge-folder">Папка результатов</button></div>' +
        '<p class="lx-p1-note">' + esc(res.outLas || '') + '</p>';
      if (box) box.innerHTML = html;
      toast('Совмещение выполнено: RMS ' + mm(rmsVal) + ' мм', 'ok');
      if (res.outLas && W.__bimOpenCloudPath) { try { W.__bimOpenCloudPath(res.outLas, { fresh: false }); } catch (e) { } }
    }).catch(function (e) {
      clearInterval(timer); st.busy = false; if (btn) btn.disabled = false; try { unsub(); } catch (_) { }
      setProgress(0, 'Совмещение не выполнено');
      var box = p.querySelector('[data-p1-merge-result]'); if (box) box.innerHTML = '<div class="lx-p1-err">' + esc((e && e.message) || e) + '</div>';
      toast('Совместить облака: ' + ((e && e.message) || e), 'err');
    });
    return true;
  }
  function mergeCloudsLegacy() {
    var o = ops();
    if (o && typeof o.opMerge === 'function') { try { o.opMerge(); toast('Совместить облака: запущено объединение'); return true; } catch (e) { } }
    var b = D.querySelector('[data-cmd="opMerge"]'); if (b) { b.click(); return true; }
    toast('Совместить облака: инструмент phase1/phase2 ещё не подключён — доступно «Объединить» в облаке (opMerge)', 'warn');
    setHint('Совместить облака: ждём API phase1/phase2. Текущий аналог — «Объединить» на вкладке «Облако».');
    return false;
  }
  function mergeClouds() {
    var B = bridge();
    if (B) { return openMerge(); }
    return mergeCloudsLegacy();
  }

  // ---------- классификация ----------
  function htmlClassify() {
    return '<div class="lx-p1-head"><span>' + icon('grid-3x3', 16) + '</span><b>Классификация облака</b><button class="lx-p1-x" data-p1="close" aria-label="Закрыть">×</button></div>' +
      '<div class="lx-p1-body">' +
      '<p class="lx-p1-note">Инструмент: cloud-classify.py. Пол/стены/крыша/растительность/люди/мебель — по геометрии, без обучения. Результат: проценты классов, превью, размеченный LAS для подсветки цветом.</p>' +
      '<div class="lx-p1-row"><span class="lb">Облако: <b>' + esc(currentPath() ? baseName(currentPath()) : 'не открыто') + '</b></span></div>' +
      '<label class="lx-p1-check"><input type="checkbox" data-p1="refine-dynamic" /> Убрать людей из результата (--refine-dynamic)</label>' +
      '<div class="lx-p1-bar-progress"><i data-p1-progress style="width:0"></i></div>' +
      '<p class="lx-p1-note" data-p1-status>Запуск классификации текущего облака (LAS/PLY).</p>' +
      '<div class="lx-p1-actions"><button type="button" class="primary" data-p1="run-classify">Классифицировать</button><button type="button" data-p1="cancel-classify">Отмена</button></div>' +
      '<div data-p1-classify-result></div>' +
      '<div class="lx-p1-log" data-p1-log hidden></div>' +
      '</div>';
  }
  function openClassify() {
    var B = bridge();
    if (!B) return classifyLegacy();
    if (!currentPath()) { toast('Классификация: сначала откройте облако точек (LAS/PLY)', 'warn'); }
    setView('classify', htmlClassify());
    return true;
  }
  function renderClassifyResult(res) {
    var p = panel(); var box = p.querySelector('[data-p1-classify-result]'); if (!box) return;
    var stats = (res && res.stats) || {};
    var pctMap = stats.pct || {};
    var rows = Object.keys(CLASS_LABELS).map(function (name) {
      var v = pctMap[name] != null ? Number(pctMap[name]) : null;
      return '<tr><td>' + esc(CLASS_LABELS[name]) + '</td><td class="n">' + (stats.classes && stats.classes[name] != null ? fmtN(stats.classes[name]) : '—') + '</td>' +
        '<td class="n">' + pct(v) + '</td><td><div class="lx-p1-cbar"><i style="width:' + Math.max(0, Math.min(100, v || 0)) + '%"></i></div></td></tr>';
    }).join('');
    var conf = stats.confidence || {};
    var html = '<div class="lx-p1-ok">Классифицировано ' + fmtN(stats.points || 0) + ' точек' + (stats.total_ms != null ? ' за ' + (stats.total_ms / 1000).toFixed(1) + ' с' : '') + '.</div>' +
      '<table class="lx-p1-tbl"><tr><th>Класс</th><th>Точек</th><th>Доля</th><th style="width:34%"></th></tr>' + rows + '</table>' +
      '<p class="lx-p1-note">Средняя уверенность: ' + (conf.mean != null ? Math.round(conf.mean * 100) + '%' : '—') + ' · p10 ' + (conf.p10 != null ? Math.round(conf.p10 * 100) + '%' : '—') + '</p>';
    if (res.previewDataUrl) html += '<img class="lx-p1-thumb" data-p1-preview src="' + res.previewDataUrl + '" alt="Превью классов" />';
    html += '<div class="lx-p1-field"><label>Оставить только классы</label>' +
      '<div class="lx-p1-grid2">' + Object.keys(CLASS_LABELS).map(function (name) {
        return '<label class="lx-p1-check"><input type="checkbox" data-p1-class="' + name + '"' + ((name === 'ground_floor' || name === 'wall' || name === 'vegetation') ? ' checked' : '') + ' /> ' + CLASS_LABELS[name] + '</label>';
      }).join('') + '</div></div>' +
      '<div class="lx-p1-actions">' +
      (res.inputIsLas ? '<button type="button" class="primary" data-p1="apply-classes">Оставить выбранные классы</button>' : '') +
      (res.outLas ? '<button type="button" data-p1="show-classified">Подсветить классы цветом</button>' : '') +
      '<button type="button" data-p1="open-classify-json">JSON-отчёт</button></div>' +
      (res.inputIsLas ? '' : '<p class="lx-p1-note lx-p1-err">Для фильтра классов нужен LAS. Для PLY доступны проценты и превью; конвертируйте облако в LAS через «Экспорт».</p>');
    box.innerHTML = html;
    st.classified = res;
  }
  function runClassify() {
    var B = bridge(); if (!B || st.busy) return false;
    var cloud = currentPath();
    if (!cloud) { toast('Классификация: сначала откройте облако точек', 'warn'); return false; }
    if (st.classified && st.busy) return false;
    st.busy = true;
    var p = panel(); var btn = p.querySelector('[data-p1="run-classify"]'); if (btn) btn.disabled = true;
    var pRef = p.querySelector('[data-p1="refine-dynamic"]');
    var id = jobId('classify'); var unsub = subscribeJob(id);
    var log = p.querySelector('[data-p1-log]'); if (log) log.hidden = false;
    setProgress(0.05, 'Классификация: ' + baseName(cloud) + '…');
    var t0 = Date.now();
    var timer = setInterval(function () { var el = (Date.now() - t0) / 1000; setProgress(Math.min(0.9, 0.05 + el / 30), 'Классификация идёт… ' + el.toFixed(1) + ' с'); }, 400);
    B.p1Classify({ cloud: cloud, outLas: true, refineDynamic: !!(pRef && pRef.checked), jobId: id }).then(function (res) {
      clearInterval(timer); st.busy = false; if (btn) btn.disabled = false; try { unsub(); } catch (_) { }
      if (!res || !res.ok) { setProgress(0, 'Классификация не выполнена'); var box = p.querySelector('[data-p1-classify-result]'); if (box) box.innerHTML = '<div class="lx-p1-err">' + esc(bridgeErr(res)) + '</div>'; toast('Классификация: ' + bridgeErr(res), 'err'); return; }
      setProgress(1, 'Классификация выполнена');
      renderClassifyResult(res);
      var top = res.stats && res.stats.pct && res.stats.pct.wall != null ? 'стены ' + pct(res.stats.pct.wall) : '';
      toast('Классификация готова: ' + top, 'ok');
    }).catch(function (e) {
      clearInterval(timer); st.busy = false; if (btn) btn.disabled = false; try { unsub(); } catch (_) { }
      setProgress(0, 'Классификация не выполнена'); toast('Классификация: ' + ((e && e.message) || e), 'err');
    });
    return true;
  }
  function classifyLegacy() {
    var v = W.__viewer || W.__lxViewer;
    if (W.__lxClassify && typeof W.__lxClassify.open === 'function') { try { W.__lxClassify.open(); return true; } catch (e) { } }
    if (v && typeof v.setColorMode === 'function') {
      try { if ((v.getAvailableColorModes ? v.getAvailableColorModes() : []).indexOf('classification') >= 0) { v.setColorMode('classification'); toast('Классификация: показ классов включён; разметка — phase1/phase2'); return true; } } catch (e) { }
    }
    toast('Классификация: инструмент phase1/phase2 ещё не подключён — доступен показ классов и «Разметить конструктив»', 'warn');
    setHint('Классификация: ждём API phase1/phase2 (разметка пол/стены/потолок), сейчас доступен режим «Классификация» в «Вид облака».');
    return false;
  }
  function classify() {
    var B = bridge();
    if (B) return openClassify();
    return classifyLegacy();
  }
  function applyClasses() {
    var p = panel();
    var chosen = Array.prototype.slice.call(p.querySelectorAll('[data-p1-class]')).filter(function (c) { return c.checked; }).map(function (c) { return c.getAttribute('data-p1-class'); });
    if (!chosen.length) { toast('Выберите хотя бы один класс', 'warn'); return false; }
    var v = (W.__pcTools && W.__pcTools.viewer && W.__pcTools.viewer()) || W.__viewer;
    var cloud = null;
    try { cloud = (W.__pcTools && W.__pcTools.getCloud) ? W.__pcTools.getCloud() : (v && v.getEditedCloud ? v.getEditedCloud() : null); } catch (e) { cloud = null; }
    if (!cloud || !cloud.pos || !cloud.classification) { toast('Нет размеченных классов в открытом облаке — сначала нажмите «Подсветить классы цветом»', 'warn'); return false; }
    var wanted = {};
    chosen.forEach(function (n) { if (ASPRS[n] != null) wanted[ASPRS[n]] = 1; });
    var pos = cloud.pos, col = cloud.col || null, inten = cloud.intensity || null, cls = cloud.classification;
    var n = Math.min(cloud.count || Math.floor(pos.length / 3), Math.floor(pos.length / 3), cls.length);
    var keep = 0;
    for (var i = 0; i < n; i++) if (wanted[cls[i]]) keep++;
    if (!keep) { toast('Среди выбранных классов нет точек', 'warn'); return false; }
    var np = new Float32Array(keep * 3), nc = col ? new Uint8Array(keep * 3) : null, ni = inten ? new Float32Array(keep) : null, nk = new Uint8Array(keep);
    var j = 0;
    for (var k = 0; k < n; k++) {
      if (!wanted[cls[k]]) continue;
      np[j * 3] = pos[k * 3]; np[j * 3 + 1] = pos[k * 3 + 1]; np[j * 3 + 2] = pos[k * 3 + 2];
      if (nc) { nc[j * 3] = col[k * 3]; nc[j * 3 + 1] = col[k * 3 + 1]; nc[j * 3 + 2] = col[k * 3 + 2]; }
      if (ni) ni[j] = inten[k];
      nk[j] = cls[k];
      j++;
    }
    try {
      if (!v || typeof v.loadCloud !== 'function') { toast('Фильтр классов: вьюер недоступен', 'err'); return false; }
      v.loadCloud({ pos: np, col: nc, intensity: ni, classification: nk, count: j, meta: cloud.meta || {} }, { preserveView: true, sourceName: baseName(currentPath()) + ' — классы: ' + chosen.map(function (x) { return CLASS_LABELS[x]; }).join(', ') });
      try { v.setColorMode('classification'); } catch (e) { }
      toast('Оставлено классов: ' + chosen.map(function (x) { return CLASS_LABELS[x]; }).join(', ') + ' — ' + fmtN(j) + ' точек', 'ok');
      return true;
    } catch (e) { toast('Фильтр классов: ' + ((e && e.message) || e), 'err'); return false; }
  }
  function showClassified() {
    var B = bridge(); var res = st.classified;
    if (!B || !res || !res.outLas) { toast('Размеченное облако ещё не готово', 'warn'); return false; }
    if (!W.__bimOpenCloudPath) { toast('Открытие облака недоступно', 'err'); return false; }
    try {
      Promise.resolve(W.__bimOpenCloudPath(res.outLas, { fresh: false })).then(function () {
        setTimeout(function () {
          try { var v = W.__pcTools && W.__pcTools.viewer && W.__pcTools.viewer(); if (v && v.setColorMode) v.setColorMode('classification'); } catch (e) { }
          toast('Размеченное облако открыто: классы подсвечены цветом', 'ok');
        }, 900);
      });
    } catch (e) { toast('Открытие размеченного облака: ' + ((e && e.message) || e), 'err'); return false; }
    return true;
  }

  // ---------- P2: отчёт о точности ----------
  function htmlAccuracy() {
    return '<div class="lx-p1-head"><span>' + icon('crosshair', 16) + '</span><b>Отчёт о точности — сверка с эталоном</b><button class="lx-p1-x" data-p1="close" aria-label="Закрыть">×</button></div>' +
      '<div class="lx-p1-body">' +
      '<p class="lx-p1-note">Сравнение нашего облака с эталоном: 3D-разница (среднее/RMSE/p95), RMSE плоскостей пола и стен, метрики качества (плотность, толщина стен, артефакты). Итог — PDF с числами и картой разницы.</p>' +
      '<div class="lx-p1-row"><span class="lb">Наше облако: <b data-p1-our>' + esc(currentPath() ? baseName(currentPath()) : 'не открыто') + '</b></span></div>' +
      '<div class="lx-p1-row"><span class="lb">Эталон: <b data-p1-acc-ref>' + esc(st.refPath ? baseName(st.refPath) : 'не выбран') + '</b></span><button type="button" data-p1="pick-acc-ref">Выбрать…</button></div>' +
      '<label class="lx-p1-check"><input type="checkbox" data-p1="interior" /> Интерьерный профиль (quality-compare --interior)</label>' +
      '<div class="lx-p1-bar-progress"><i data-p1-progress style="width:0"></i></div>' +
      '<p class="lx-p1-note" data-p1-status>Нужны LAS-облака (наше и эталон). Запуск: quality-compare.py + cloud-diff.py.</p>' +
      '<div class="lx-p1-actions"><button type="button" class="primary" data-p1="run-accuracy">Сверка с эталоном</button><button type="button" data-p1="cancel-accuracy">Отмена</button></div>' +
      '<div data-p1-acc-result></div>' +
      '<div class="lx-p1-log" data-p1-log hidden></div>' +
      '</div>';
  }
  function refreshAccuracyHead() { var p = D.getElementById('lxP1Panel'); if (!p) return; var b = p.querySelector('[data-p1-acc-ref]'); if (b) b.textContent = baseName(st.refPath || ''); var o = p.querySelector('[data-p1-our]'); if (o) o.textContent = currentPath() ? baseName(currentPath()) : 'не открыто'; }
  function openAccuracy() {
    var B = bridge();
    if (!B) { toast('Отчёт о точности: недоступен без Python-моста (desktop)', 'warn'); return false; }
    setView('accuracy', htmlAccuracy());
    return true;
  }
  function renderAccuracyResult(res) {
    var p = panel(); var box = p.querySelector('[data-p1-acc-result]'); if (!box) return;
    var diff = (res && res.diff) || {};
    var d = diff.dist_m || {};
    var planes = (diff.planes_mm) || {};
    var q = (res && res.quality) || null;
    var verdicts = (q && q.verdicts) || {};
    var vHtml = Object.keys(verdicts).map(function (k) {
      var v = verdicts[k] || {};
      return '<tr><td>' + esc(k) + '</td><td><span class="lx-p1-badge ' + (v.pass ? 'ok' : 'fail') + '">' + (v.pass ? 'PASS' : 'FAIL') + '</span></td></tr>';
    }).join('');
    var html = '<div class="lx-p1-' + (d.rmse_m != null ? 'ok' : 'err') + '">' +
      (d.rmse_m != null ? '3D-разница: mean ' + mm(d.mean_m) + ' мм · RMSE ' + mm(d.rmse_m) + ' мм · p95 ' + mm(d.p95_m) + ' мм · max ' + mm(d.max_m) + ' мм' : ('3D-разница: нет данных' + (res.diffError ? ' — ' + String(res.diffError).slice(0, 220) : ''))) + '</div>' +
      '<table class="lx-p1-tbl"><tr><th>Метрика 3D-разницы</th><th>Значение</th></tr>' +
      '<tr><td>Среднее</td><td class="n">' + mm(d.mean_m) + ' мм</td></tr>' +
      '<tr><td>RMSE</td><td class="n">' + mm(d.rmse_m) + ' мм</td></tr>' +
      '<tr><td>Медиана</td><td class="n">' + mm(d.median_m) + ' мм</td></tr>' +
      '<tr><td>p95</td><td class="n">' + mm(d.p95_m) + ' мм</td></tr>' +
      '<tr><td>Максимум</td><td class="n">' + mm(d.max_m) + ' мм</td></tr>' +
      '<tr><td>В допуске 2 / 5 / 10 см</td><td class="n">' + pct(d.within_2cm_pct) + ' / ' + pct(d.within_5cm_pct) + ' / ' + pct(d.within_10cm_pct) + '</td></tr>' +
      '</table>' +
      '<table class="lx-p1-tbl"><tr><th>RMSE плоскостей</th><th>Наше</th><th>Эталон</th><th>Δ</th></tr>' +
      '<tr><td>Пол</td><td class="n">' + mm(planes.floor && planes.floor.our != null ? planes.floor.our / 1000 : null) + ' мм</td><td class="n">' + mm(planes.floor && planes.floor.ref != null ? planes.floor.ref / 1000 : null) + ' мм</td><td class="n">' + (planes.floor && planes.floor.delta != null ? (Math.round(planes.floor.delta * 10) / 10) : '—') + ' мм</td></tr>' +
      '<tr><td>Стены</td><td class="n">' + mm(planes.walls && planes.walls.our != null ? planes.walls.our / 1000 : null) + ' мм</td><td class="n">' + mm(planes.walls && planes.walls.ref != null ? planes.walls.ref / 1000 : null) + ' мм</td><td class="n">' + (planes.walls && planes.walls.delta != null ? (Math.round(planes.walls.delta * 10) / 10) : '—') + ' мм</td></tr>' +
      '</table>' +
      (vHtml ? '<table class="lx-p1-tbl"><tr><th>Качество (quality-compare)</th><th>Вердикт</th></tr>' + vHtml + '</table>' : '') +
      (res.heatmaps || []).slice(0, 3).map(function (h) { return '<img class="lx-p1-thumb" src="' + h.dataUrl + '" alt="' + esc(h.name) + '" />'; }).join('') +
      '<div class="lx-p1-actions"><button type="button" class="primary" data-p1="save-pdf">PDF-отчёт</button><button type="button" data-p1="open-accuracy-json">JSON</button></div>';
    box.innerHTML = html;
    st.accuracy = res;
  }
  function runAccuracy() {
    var B = bridge(); if (!B || st.busy) return false;
    var our = currentPath();
    if (!our) { toast('Отчёт о точности: сначала откройте наше облако (LAS)', 'warn'); return false; }
    if (!st.refPath) { toast('Отчёт о точности: выберите файл-эталон', 'warn'); return false; }
    if (!/\.las$/i.test(our) || !/\.las$/i.test(st.refPath)) { toast('Отчёт о точности: нужны LAS-облака (наше и эталон). PLY сконвертируйте в LAS через «Экспорт».', 'warn'); return false; }
    st.busy = true;
    var p = panel(); var btn = p.querySelector('[data-p1="run-accuracy"]'); if (btn) btn.disabled = true;
    var log = p.querySelector('[data-p1-log]'); if (log) log.hidden = false;
    var id = jobId('accuracy'); var unsub = subscribeJob(id);
    setProgress(0.05, 'Сверка с эталоном: quality-compare + cloud-diff…');
    var t0 = Date.now();
    var timer = setInterval(function () { var el = (Date.now() - t0) / 1000; setProgress(Math.min(0.9, 0.05 + el / 120), 'Сверка идёт… ' + el.toFixed(1) + ' с'); }, 500);
    B.p1Accuracy({ our: our, ref: st.refPath, interior: !!(p.querySelector('[data-p1="interior"]') || {}).checked, jobId: id }).then(function (res) {
      clearInterval(timer); st.busy = false; if (btn) btn.disabled = false; try { unsub(); } catch (_) { }
      if (!res || !res.ok) { setProgress(0, 'Сверка не выполнена'); var box = p.querySelector('[data-p1-acc-result]'); if (box) box.innerHTML = '<div class="lx-p1-err">' + esc(bridgeErr(res)) + '</div>'; toast('Отчёт о точности: ' + bridgeErr(res), 'err'); return; }
      setProgress(1, 'Сверка выполнена');
      renderAccuracyResult(res);
      var d = (res.diff && res.diff.dist_m) || {};
      toast('Точность: 3D RMSE ' + mm(d.rmse_m) + ' мм, p95 ' + mm(d.p95_m) + ' мм', 'ok');
    }).catch(function (e) {
      clearInterval(timer); st.busy = false; if (btn) btn.disabled = false; try { unsub(); } catch (_) { }
      setProgress(0, 'Сверка не выполнена'); toast('Отчёт о точности: ' + ((e && e.message) || e), 'err');
    });
    return true;
  }
  function saveAccuracyPdf() {
    var res = st.accuracy; var B = bridge();
    if (!res) { toast('Сначала выполните сверку с эталоном', 'warn'); return false; }
    var A = W.bimAPI;
    if (!A || typeof A.saveReportPdf !== 'function') { toast('PDF-отчёт доступен в десктоп-версии', 'err'); return false; }
    var d = (res.diff && res.diff.dist_m) || {}, planes = (res.diff && res.diff.planes_mm) || {}, q = res.quality || {};
    var verdicts = q.verdicts || {};
    var rows = Object.keys(verdicts).map(function (k) { var v = verdicts[k] || {}; return '<tr><td>' + esc(k) + '</td><td>' + (v.pass ? 'PASS' : 'FAIL') + '</td></tr>'; }).join('');
    var imgs = (res.heatmaps || []).slice(0, 3).map(function (h) { return '<figure><img src="' + h.dataUrl + '" style="max-width:100%"/><figcaption>' + esc(h.name) + '</figcaption></figure>'; }).join('');
    var html = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Отчёт о точности — BIM Twin</title>' +
      '<style>body{font:13px/1.45 Arial,sans-serif;color:#1d2329;margin:24px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:18px 0 6px}table{border-collapse:collapse;width:100%;margin:6px 0}td,th{border:1px solid #c9d1d9;padding:5px 7px;text-align:left}th{background:#eef2f7}.n{text-align:right}figure{margin:8px 0}figcaption{color:#5a6672;font-size:11px}.muted{color:#5a6672;font-size:11px}</style></head><body>' +
      '<h1>Отчёт о точности: наше облако vs эталон</h1>' +
      '<p class="muted">Сформировано ' + new Date().toLocaleString('ru-RU') + ' · BIM Twin r151 · ' + esc(baseName(res.our || '')) + ' vs ' + esc(baseName(res.ref || '')) + '</p>' +
      '<h2>3D-разница (облако → эталон)</h2><table><tr><th>Показатель</th><th>Значение</th></tr>' +
      '<tr><td>Среднее расстояние</td><td class="n">' + mm(d.mean_m) + ' мм</td></tr>' +
      '<tr><td>RMSE</td><td class="n">' + mm(d.rmse_m) + ' мм</td></tr>' +
      '<tr><td>Медиана</td><td class="n">' + mm(d.median_m) + ' мм</td></tr>' +
      '<tr><td>p95</td><td class="n">' + mm(d.p95_m) + ' мм</td></tr>' +
      '<tr><td>Максимум</td><td class="n">' + mm(d.max_m) + ' мм</td></tr>' +
      '<tr><td>В допуске 2 / 5 / 10 см</td><td class="n">' + pct(d.within_2cm_pct) + ' / ' + pct(d.within_5cm_pct) + ' / ' + pct(d.within_10cm_pct) + '</td></tr></table>' +
      '<h2>RMSE плоскостей</h2><table><tr><th>Плоскость</th><th>Наше, мм</th><th>Эталон, мм</th><th>Δ, мм</th></tr>' +
      '<tr><td>Пол</td><td class="n">' + mm(planes.floor && planes.floor.our != null ? planes.floor.our / 1000 : null) + '</td><td class="n">' + mm(planes.floor && planes.floor.ref != null ? planes.floor.ref / 1000 : null) + '</td><td class="n">' + (planes.floor && planes.floor.delta != null ? (Math.round(planes.floor.delta * 10) / 10) : '—') + '</td></tr>' +
      '<tr><td>Стены</td><td class="n">' + mm(planes.walls && planes.walls.our != null ? planes.walls.our / 1000 : null) + '</td><td class="n">' + mm(planes.walls && planes.walls.ref != null ? planes.walls.ref / 1000 : null) + '</td><td class="n">' + (planes.walls && planes.walls.delta != null ? (Math.round(planes.walls.delta * 10) / 10) : '—') + '</td></tr></table>' +
      (rows ? '<h2>Метрики качества (quality-compare)</h2><table><tr><th>Проверка</th><th>Вердикт</th></tr>' + rows + '</table>' : '') +
      (imgs ? '<h2>Карты разницы</h2>' + imgs : '') +
      '<p class="muted">Инструменты: cloud-diff.py (3D-разница и плоскости), quality-compare.py (качество). Значения — в миллиметрах, если не указано иное.</p>' +
      '</body></html>';
    var nm = 'Отчёт о точности — ' + baseName(res.our || 'облако').replace(/\.[^.]+$/, '') + ' — ' + nowStamp() + '.pdf';
    A.saveReportPdf({ html: html, name: nm }).then(function (r) {
      if (r && r.ok) toast('PDF-отчёт сохранён: ' + r.path, 'ok');
      else if (r && r.canceled) { }
      else toast('PDF-отчёт: ' + bridgeErr(r), 'err');
    }).catch(function (e) { toast('PDF-отчёт: ' + ((e && e.message) || e), 'err'); });
    return true;
  }

  // ---------- пакетная обработка: реальный конвейер ----------
  function htmlBatchReal() {
    var s = st.status2 || {};
    return '<div class="lx-p1-head"><span>' + icon('layers', 16) + '</span><b>Пакетная обработка проекта</b><button class="lx-p1-x" data-p1="close" aria-label="Закрыть">×</button></div>' +
      '<div class="lx-p1-body">' +
      '<div class="lx-p1-row"><span class="lb">Файл сканера: <b data-p1-xbin>' + esc(st.xbinPath ? baseName(st.xbinPath) : (currentPath() ? baseName(currentPath()) + ' (текущее облако)' : 'не выбран')) + '</b></span><button type="button" data-p1="pick-xbin">Файл .xbin…</button></div>' +
      '<p class="lx-p1-note">Конвейер: сборка облака из .xbin → цвет по фото камер → чистка (шум/выбросы) → экспорт в папку результатов. Цвет выполняется до чистки: чистка сохраняет PLY и теряет время точек, без которого цвет по фото невозможен.</p>' +
      '<div class="lx-p1-bar-progress"><i data-p1-progress style="width:0"></i></div>' +
      '<p class="lx-p1-note" data-p1-status>Очередь готова к запуску.</p>' +
      STAGES.map(function (s2, i) {
        return '<div class="lx-p1-stage" data-p1-stage="' + s2.id + '"><span class="n">' + (i + 1) + '</span><span class="l">' + s2.label + '</span>' +
          '<span class="s" data-p1-stage-status="' + s2.id + '">' + (s2.id === 'build' && !st.xbinPath ? 'текущее облако' : 'готово') + '</span></div>';
      }).join('') +
      '<div class="lx-p1-actions">' +
      '<button type="button" class="primary" data-p1="run-batch-real">Запустить очередь</button>' +
      '<button type="button" data-p1="cancel-batch-real" disabled>Отмена</button>' +
      '</div>' +
      '<div data-p1-batch-result></div>' +
      '<div class="lx-p1-log" data-p1-log hidden></div>' +
      '<p class="lx-p1-note" data-p1-hint>Прогресс по стадиям; отмена прерывает текущую фоновую операцию. Экспорт — без диалога, в папку p1-export.</p>' +
      '</div>';
  }
  function openBatchReal() {
    setView('batch', htmlBatchReal());
    var B = bridge();
    if (B && !st.status2) { try { B.p1Status().then(function (s) { st.status2 = s; }).catch(function () { }); } catch (e) { } }
    return true;
  }
  function pickXbin() {
    var B = bridge(); if (!B) return;
    if (typeof B.pickXbin !== 'function') { toast('.xbin: выбор файла недоступен', 'warn'); return; }
    B.pickXbin().then(function (r) {
      if (!r || !r.ok || !r.path) { if (r && !r.cancelled) toast('Файл .xbin не выбран', 'warn'); return; }
      st.xbinPath = r.path;
      var p = panel(); var el = p.querySelector('[data-p1-xbin]'); if (el) el.textContent = baseName(r.path);
      toast('.xbin: ' + baseName(r.path));
    }).catch(function (e) { toast('.xbin: ' + ((e && e.message) || e), 'err'); });
  }
  function stepProgress(i, n, text) { setProgress(Math.max(0.02, Math.min(0.99, (i + 0.15) / n)), text); }
  function runBatchReal() {
    var B = bridge(); if (!B || st.running) return Promise.resolve(false);
    var A = W.bimAPI;
    var start = st.xbinPath || (currentPath() && /\.xbin$/i.test(currentPath()) ? currentPath() : '');
    if (!start && !currentPath()) { toast('Пакетная обработка: выберите .xbin или откройте облако', 'warn'); return Promise.resolve(false); }
    st.running = true; st.cancelled = false; st.log = [];
    var p = panel(); var runBtn = p.querySelector('[data-p1="run-batch-real"]'), cancelBtn = p.querySelector('[data-p1="cancel-batch-real"]');
    var log = p.querySelector('[data-p1-log]'); if (log) { log.hidden = false; log.textContent = ''; }
    if (runBtn) runBtn.disabled = true; if (cancelBtn) cancelBtn.disabled = false;
    var resBox = p.querySelector('[data-p1-batch-result]'); if (resBox) resBox.innerHTML = '';
    var results = { build: null, color: null, clean: null, export: null };
    var pathNow = currentPath();
    var total = 4, done = 0;
    function finish() {
      st.running = false; if (runBtn) runBtn.disabled = false; if (cancelBtn) cancelBtn.disabled = true;
      var ok = !!(results.build || pathNow) && !st.cancelled;
      if (resBox) {
        resBox.innerHTML = '<div class="lx-p1-' + (st.cancelled ? 'err' : (ok ? 'ok' : 'err')) + '">' + (st.cancelled ? 'Очередь отменена' : (ok ? 'Очередь завершена' : 'Очередь завершилась с ошибкой')) + '</div>' +
          '<table class="lx-p1-tbl"><tr><th>Стадия</th><th>Результат</th></tr>' +
          STAGES.map(function (s) { var r2 = results[s.id]; return '<tr><td>' + esc(s.label) + '</td><td>' + esc(r2 || (s.id === 'build' && !st.xbinPath ? 'пропущено (облако уже открыто)' : '—')) + '</td></tr>'; }).join('') + '</table>' +
          (results.export ? '<p class="lx-p1-note">Экспорт: ' + esc(results.export) + '</p>' : '');
      }
      setProgress(st.cancelled ? 0 : 1, st.cancelled ? 'Пакетная обработка отменена' : (ok ? 'Пакетная обработка: готово' : 'Пакетная обработка: ошибка'));
      return !st.cancelled && ok;
    }
    function stageBuild() {
      if (st.cancelled) return Promise.resolve(false);
      stepProgress(0, total, '1/4 Сборка облака из .xbin…'); setStage('build', 'run', 'собираю…');
      if (!st.xbinPath && !(/\.xbin$/i.test(start || ''))) { setStage('build', 'skip', 'облако уже открыто — сборка не нужна'); logLine('build: пропущено'); done++; return Promise.resolve(true); }
      var id = jobId('xbin'); var unsub = subscribeJob(id);
      if (typeof A.cancelXbinCloud === 'function') st.cancelFn = function () { try { A.cancelXbinCloud(id); } catch (e) { } };
      return Promise.resolve(A.xbinBuildCloud(st.xbinPath || start, id, 'normal', { refine: false, fast: true, color: 'gray', edge: true })).then(function (r2) {
        try { unsub(); } catch (e) { }
        if (!r2 || !r2.ok) { setStage('build', 'skip', 'ошибка: ' + String((r2 && r2.message) || 'сборка не удалась').slice(0, 80)); logLine('build FAIL: ' + ((r2 && r2.message) || '')); return false; }
        pathNow = r2.path || pathNow;
        results.build = (r2.points ? fmtN(r2.points) + ' точек' : 'готово') + (r2.name ? ' · ' + r2.name : '');
        setStage('build', 'done', r2.points ? fmtN(r2.points) + ' т.' : 'готово'); logLine('build ok: ' + (r2.path || ''));
        done++; return true;
      });
    }
    function stageColor() {
      if (st.cancelled || !pathNow) return Promise.resolve(false);
      stepProgress(1, total, '2/4 Цвет по фото камер…'); setStage('color', 'run', 'раскрашиваю…');
      if (!/\.las$/i.test(pathNow)) { setStage('color', 'skip', 'пропущено: файл не LAS'); logLine('color: пропущено (не LAS)'); done++; return Promise.resolve(true); }
      if (typeof A.photoColorCloud !== 'function') { setStage('color', 'skip', 'нет API photoColorCloud'); done++; return Promise.resolve(true); }
      var id = jobId('color'); var unsub = subscribeJob(id);
      if (typeof A.cancelPhotoColor === 'function') st.cancelFn = function () { try { A.cancelPhotoColor(id); } catch (e) { } };
      return Promise.resolve(A.photoColorCloud(pathNow, id, {})).then(function (r2) {
        try { unsub(); } catch (e) { }
        if (!r2 || !r2.ok) { setStage('color', 'skip', 'пропущено: ' + String((r2 && (r2.message || r2.error)) || 'нет .xbin/poses').slice(0, 70)); logLine('color skip: ' + ((r2 && (r2.message || r2.error)) || '')); done++; return true; }
        if (r2.path) pathNow = r2.path;
        results.color = r2.points ? fmtN(r2.points) + ' точек' : (r2.path || 'готово');
        setStage('color', 'done', r2.points ? fmtN(r2.points) + ' т.' : 'готово'); logLine('color ok: ' + (r2.path || ''));
        done++; return true;
      });
    }
    function stageClean() {
      if (st.cancelled || !pathNow) return Promise.resolve(false);
      stepProgress(2, total, '3/4 Чистка облака…'); setStage('clean', 'run', 'чищу…');
      if (typeof A.cleanCloud !== 'function') { setStage('clean', 'skip', 'нет API cleanCloud'); done++; return Promise.resolve(true); }
      st.cancelFn = function () { try { if (A.cleanAbort) A.cleanAbort(); } catch (e) { } };
      return Promise.resolve(A.cleanCloud({ path: pathNow, ops: [{ type: 'auto' }], count: cloudCount() })).then(function (r2) {
        if (!r2 || !r2.ok) { setStage('clean', 'skip', 'ошибка: ' + String((r2 && (r2.error || r2.message)) || 'чистка не удалась').slice(0, 70)); logLine('clean skip: ' + ((r2 && (r2.error || r2.message)) || '')); done++; return true; }
        if (r2.path) pathNow = r2.path;
        results.clean = (r2.removed != null ? 'убрано ' + fmtN(r2.removed) + ' точек · ' : '') + (r2.path || 'готово');
        setStage('clean', 'done', r2.removed != null ? '−' + fmtN(r2.removed) : 'готово'); logLine('clean ok: ' + (r2.path || ''));
        done++; return true;
      });
    }
    function stageExport() {
      if (st.cancelled || !pathNow) return Promise.resolve(false);
      stepProgress(3, total, '4/4 Экспорт результата…'); setStage('export', 'run', 'сохраняю…');
      if (typeof B.p1Export !== 'function') { setStage('export', 'skip', 'нет API p1Export'); done++; return Promise.resolve(true); }
      return Promise.resolve(B.p1Export({ sourcePath: pathNow, name: 'batch-' + nowStamp() })).then(function (r2) {
        if (!r2 || !r2.ok) { setStage('export', 'skip', 'ошибка: ' + String((r2 && r2.error) || 'экспорт не удался').slice(0, 70)); logLine('export FAIL'); done++; return true; }
        results.export = r2.path + ' (' + Math.round((r2.bytes || 0) / 1048576) + ' МБ)';
        setStage('export', 'done', 'сохранено'); logLine('export ok: ' + r2.path);
        done++; return true;
      });
    }
    var chain = Promise.resolve(true)
      .then(function (ok) { return ok && !st.cancelled ? stageBuild() : false; })
      .then(function (ok) { return ok && !st.cancelled ? stageColor() : false; })
      .then(function (ok) { return ok && !st.cancelled ? stageClean() : false; })
      .then(function (ok) { return ok && !st.cancelled ? stageExport() : false; })
      .catch(function (e) { logLine('pipeline error: ' + ((e && e.message) || e)); })
      .then(finish);
    return chain;
  }

  // ---------- события ----------
  function onChange(e) {
    var t = e.target;
    if (!t) return;
    if (t.getAttribute && t.getAttribute('data-p1') === 'mode') {
      st.mode = t.value;
      var p = panel();
      var row = p.querySelector('[data-p1-pairs-row]'); if (row) row.hidden = st.mode === 'icp';
      var stEl = p.querySelector('[data-p1-status]');
      if (stEl) stEl.textContent = st.mode === 'icp' ? 'ICP: многомасштабный point-to-plane, нужен Open3D. Строгий порог 5 см.' : 'Режим пар/GCP: Kabsch по выбранным точкам, Open3D не нужен. Строгий порог 15 см.';
    }
    if (t.getAttribute && t.getAttribute('data-p1-class')) { /* чекбоксы классов читаются при применении */ }
  }
  function onClick(e) {
    var t = e.target && e.target.closest && e.target.closest('[data-p1]');
    if (!t) return;
    var a = t.getAttribute('data-p1');
    if (a === 'batch') { st.view === 'batch' && !D.getElementById('lxP1Panel').hidden ? closePanel() : (bridge() ? openBatchReal() : openBatchLegacy()); return; }
    if (a === 'close') { closePanel(); return; }
    if (a === 'merge') { mergeClouds(); return; }
    if (a === 'classify') { classify(); return; }
    if (a === 'accuracy') { openAccuracy(); return; }
    if (a === 'run') { runBatchLegacy(); return; }
    if (a === 'cancel') { cancelBatch(); return; }
    if (a === 'pick-ref' || a === 'pick-src') { pickCloud(a === 'pick-ref' ? 'ref' : 'src'); return; }
    if (a === 'pick-acc-ref') { pickCloud('ref'); return; }
    if (a === 'pick-pairs') { pickPairs(); return; }
    if (a === 'run-merge') { runMerge(); return; }
    if (a === 'load-merge') { openSummaryFile(st.merged && st.merged.outLas, 'Открыть результат совмещения'); return; }
    if (a === 'open-merge-json') { openSummaryFile(st.merged && st.merged.reportPath, 'JSON совмещения'); return; }
    if (a === 'open-merge-folder') { openFolderOf(st.merged && st.merged.outLas); return; }
    if (a === 'run-classify') { runClassify(); return; }
    if (a === 'show-classified') { showClassified(); return; }
    if (a === 'apply-classes') { applyClasses(); return; }
    if (a === 'open-classify-json') { openSummaryFile(st.classified && st.classified.jsonPath, 'JSON классификации'); return; }
    if (a === 'run-accuracy') { runAccuracy(); return; }
    if (a === 'save-pdf') { saveAccuracyPdf(); return; }
    if (a === 'open-accuracy-json') { openSummaryFile(st.accuracy && st.accuracy.files && st.accuracy.files.diffJson, 'JSON точности'); return; }
    if (a === 'pick-xbin') { pickXbin(); return; }
    if (a === 'run-batch-real') { runBatchReal(); return; }
    if (a === 'cancel-batch-real') {
      st.cancelled = true;
      try { if (st.cancelFn) st.cancelFn(); } catch (e2) { }
      var B = bridge(); if (B && st.jobId) { try { B.p1Cancel(st.jobId); } catch (e2) { } }
      setProgress(0, 'Пакетная обработка: отмена…');
      return;
    }
    if (a === 'cancel-merge' || a === 'cancel-classify' || a === 'cancel-accuracy') {
      var B2 = bridge(); if (B2 && st.jobId) { try { B2.p1Cancel(st.jobId); } catch (e2) { } }
      toast('Отмена запрошена', 'warn');
      return;
    }
  }
  function openSummaryFile(path, title) {
    if (!path) { toast(title + ': файл ещё не создан', 'warn'); return; }
    try {
      if (W.bimAPI && W.bimAPI.openFile) { W.bimAPI.openFile(path); return; }
      if (W.bimAPI && W.bimAPI.openPath) { W.bimAPI.openPath(path); return; }
    } catch (e) { }
    toast(title + ': ' + path, 'ok');
  }
  function openFolderOf(path) {
    if (!path) return;
    try { var dir = String(path).replace(/[\\/][^\\/]*$/, ''); if (W.bimAPI && W.bimAPI.openPath) W.bimAPI.openPath(dir); } catch (e) { }
  }

  // ---------- служебный API для сценариев/автотестов ----------
  function setFiles(o) {
    o = o || {};
    if (o.ref !== undefined) st.refPath = String(o.ref || '');
    if (o.src !== undefined) st.srcPath = String(o.src || '');
    if (o.pairs !== undefined) st.pairsPath = String(o.pairs || '');
    if (o.xbin !== undefined) st.xbinPath = String(o.xbin || '');
    var B = bridge();
    if (B && typeof B.p1GrantPaths === 'function') {
      var paths = [st.refPath, st.srcPath, st.pairsPath, st.xbinPath].filter(Boolean);
      if (paths.length) { try { B.p1GrantPaths({ paths: paths }).catch(function () { }); } catch (e) { } }
    }
    var p = D.getElementById('lxP1Panel');
    if (p) {
      var a = p.querySelector('[data-p1-engine-ref]'); if (a) a.textContent = baseName(st.refPath || '') || 'не выбран';
      var b = p.querySelector('[data-p1-src]'); if (b) b.textContent = baseName(st.srcPath || '') || 'не выбрано';
      var c = p.querySelector('[data-p1-pairs-row] .lb b'); if (c) c.textContent = baseName(st.pairsPath || '') || 'не выбран';
      var d = p.querySelector('[data-p1-xbin]'); if (d) d.textContent = baseName(st.xbinPath || '') || 'не выбран';
      refreshAccuracyHead();
    }
    return { ref: st.refPath, src: st.srcPath, pairs: st.pairsPath, xbin: st.xbinPath };
  }

  // ---------- публичный API ----------
  function openBatch() {
    var B = bridge();
    if (B) return openBatchReal();
    return openBatchLegacy();
  }
  function runBatch() {
    var B = bridge();
    if (B) return runBatchReal();
    return runBatchLegacy();
  }
  function state() {
    return {
      mounted: st.mounted, view: st.view, batchOpen: st.batchOpen, running: st.running, stage: st.stage, cancelled: st.cancelled,
      path: currentPath(), count: cloudCount(), busy: st.busy, ref: st.refPath, src: st.srcPath, mode: st.mode,
      bridge: !!bridge(), merged: !!st.merged, classified: !!st.classified, accuracy: !!st.accuracy,
      storage: st.storage,
      stages: (bridge() ? STAGES : STAGES_LEGACY).map(function (s) { return { id: s.id, label: s.label, available: s.id !== 'build' || !!bridge() }; })
    };
  }
  var API = {
    version: '184', mount: mount, openBatch: openBatch, closeBatch: closePanel, runBatch: runBatch, cancelBatch: cancelBatch,
    mergeClouds: mergeClouds, classify: classify, openMerge: openMerge, openClassify: openClassify, openAccuracy: openAccuracy,
    runMerge: runMerge, runClassify: runClassify, runAccuracy: runAccuracy, saveAccuracyPdf: saveAccuracyPdf,
    applyClasses: applyClasses, state: state, STAGES: (bridge() ? STAGES : STAGES_LEGACY).slice(),
    bridge: bridge, setFiles: setFiles, _available: available, _setStatus: setStatus,
    storage: loadStorage, chooseStorage: chooseStorage, cleanLegacyStorage: cleanLegacyStorage
  };
  W.__lxP1 = API;
  function mount() {
    if (st.mounted) return true;
    st.mounted = true;
    try { bar(); } catch (e) { }
    try { storageBar(); loadStorage(); } catch (e) { }
    try { W.addEventListener('lx-cloud-loaded', function () { if (st.view === 'batch' && !st.running) { var p = panel(); var stEl = p.querySelector('[data-p1-status]'); if (stEl) stEl.textContent = 'Облако загружено (' + Math.round(cloudCount() / 1e6) + ' млн) — можно запускать очередь.'; } }); } catch (e) { }
    return true;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof globalThis !== 'undefined' && typeof window === 'undefined') { try { globalThis.__lxP1 = API; } catch (e) { } }
  // r155: подгружаем слой P2/P3 (CRS, Mesh, клип-бокс) без правок app.js.
  function ensureP23() {
    try {
      if (!W || !W.bimAPI) return false;                 // jsdom/легаси-окружение — не грузим
      if (W.__lxP23 || D.getElementById('lxP23Script')) return true;
      var s = D.createElement('script');
      s.id = 'lxP23Script'; s.src = 'ui/p23-tools.js?v=155'; s.async = true;
      s.onload = function () { try { if (W.__lxP23 && W.__lxP23.mount) W.__lxP23.mount(); } catch (e) { } };
      (D.head || D.documentElement).appendChild(s);
      return true;
    } catch (e) { return false; }
  }
  function boot() { try { if (D.body) { mount(); ensureP23(); } else D.addEventListener('DOMContentLoaded', function () { mount(); ensureP23(); }); } catch (e) { } }
  boot();
})();

