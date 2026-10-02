/* BIM Twin — renderer v0.4 (Phase A: persistence + CRUD + uploads + backup). */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const _rawAPI = window.bimAPI || null;
  const __bimLog = { buf: [], max: 600, el: null };
  function __fmtArg(a) {
    try {
      if (a === undefined) return 'undefined';
      if (a === null) return 'null';
      if (typeof a === 'string') return a.length > 120 ? a.slice(0, 120) + '…' : a;
      if (typeof a === 'number' || typeof a === 'boolean') return String(a);
      if (a instanceof ArrayBuffer) return 'ArrayBuffer(' + a.byteLength + ')';
      if (ArrayBuffer.isView(a)) return a.constructor.name + '(' + (a.length || a.byteLength) + ')';
      const s = JSON.stringify(a, function (k, v) {
        if (typeof v === 'string' && v.length > 80) return v.slice(0, 80) + '…';
        if (ArrayBuffer.isView(v)) return v.constructor.name + '(' + (v.length || v.byteLength) + ')';
        return v;
      });
      return s && s.length > 220 ? s.slice(0, 220) + '…' : (s || String(a));
    } catch (e) { return '<?>'; }
  }
  function __bimLogRender(e) {
    const body = __bimLog.el; if (!body) return;
    const d = new Date(e.t);
    const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0'), ss = String(d.getSeconds()).padStart(2, '0');
    const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 24;
    const row = document.createElement('div'); row.className = 'dc-row dc-' + e.level;
    const tm = document.createElement('span'); tm.className = 'dc-time'; tm.textContent = hh + ':' + mm + ':' + ss;
    const sp = document.createElement('span'); sp.className = 'dc-msg'; sp.textContent = ' ' + e.msg;
    row.appendChild(tm); row.appendChild(sp); body.appendChild(row);
    while (body.childElementCount > __bimLog.max) body.removeChild(body.firstChild);
    if (atBottom) body.scrollTop = body.scrollHeight;
  }
  function bimLog(level, msg) {
    const e = { t: Date.now(), level: level || 'info', msg: String(msg) };
    __bimLog.buf.push(e); if (__bimLog.buf.length > __bimLog.max) __bimLog.buf.shift();
    try { __bimLogRender(e); } catch (err) {}
  }
  window.bimLog = bimLog;
  ['log', 'info', 'warn', 'error'].forEach(function (m) {
    const orig = (console[m] || console.log || function () {}).bind(console);
    console['__orig_' + m] = orig;
    console[m] = function () {
      try { bimLog(m === 'error' ? 'error' : (m === 'warn' ? 'warn' : 'info'), Array.prototype.map.call(arguments, __fmtArg).join(' ')); } catch (e) {}
      return orig.apply(null, arguments);
    };
  });
  window.addEventListener('error', function (ev) { try { bimLog('error', 'JS: ' + (ev.message || '') + (ev.filename ? ' @ ' + String(ev.filename).split('/').pop() + ':' + ev.lineno : '')); } catch (e) {} });
  window.addEventListener('unhandledrejection', function (ev) { try { bimLog('error', 'Promise: ' + __fmtArg((ev.reason && (ev.reason.message || ev.reason)) || ev.reason)); } catch (e) {} });
  function __resSummary(r) { try { if (r && typeof r === 'object' && 'ok' in r) return r.ok ? (' → ok' + (r.engine ? ' [' + r.engine + ']' : '') + (r.count != null ? ' · ' + r.count : '')) : (' → FAIL' + (r.error ? ': ' + r.error : '')); } catch (e) {} return ''; }
  let API = _rawAPI;
  try {
    if (_rawAPI) {
      const __wrap = {};
      let __names = [];
      try { __names = Object.getOwnPropertyNames(_rawAPI); } catch (e) { __names = []; }
      if (!__names.length) { try { for (const k in _rawAPI) __names.push(k); } catch (e) {} }
      __names.forEach(function (prop) {
        if (prop === 'constructor' || prop === '__proto__') return;
        let v; try { v = _rawAPI[prop]; } catch (e) { return; }
        if (typeof v !== 'function') { try { __wrap[prop] = v; } catch (e) {} return; }
        __wrap[prop] = function () {
          const args = Array.prototype.slice.call(arguments);
          let argstr = ''; try { argstr = args.map(__fmtArg).join(', '); } catch (e) {}
          const t0 = (window.performance && performance.now) ? performance.now() : Date.now();
          try { bimLog('call', '→ ' + prop + '(' + (argstr.length > 160 ? argstr.slice(0, 160) + '…' : argstr) + ')'); } catch (e) {}
          let res;
          try { res = v.apply(_rawAPI, args); }
          catch (e) { try { bimLog('error', prop + ': ' + ((e && e.message) || e)); } catch (e2) {} throw e; }
          if (res && typeof res.then === 'function') {
            return res.then(function (r) { try { const dt = Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - t0); bimLog('ok', prop + ' (' + dt + ' мс)' + __resSummary(r)); } catch (e) {} return r; },
              function (e) { try { const dt = Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - t0); bimLog('error', prop + ' (' + dt + ' мс): ' + ((e && e.message) || e)); } catch (e2) {} throw e; });
          }
          return res;
        };
      });
      API = __wrap;
    }
  } catch (e) { API = _rawAPI; try { (console.__orig_warn || console.warn)('bimLog: API wrap failed, using raw API', e); } catch (e2) {} }
  function selectedFilePath(file) {
    if (!file) return '';
    try {
      if (_rawAPI && typeof _rawAPI.getPathForFile === 'function') {
        const p = _rawAPI.getPathForFile(file);
        if (typeof p === 'string' && p) return p;
      }
    } catch (_) {}
    try { return typeof file.path === 'string' ? file.path : ''; } catch (_) { return ''; }
  }
  let cloudParseSequence = 0;
  function makeCloudParseJobId() {
    cloudParseSequence++;
    return 'cloud-' + Date.now().toString(36) + '-' + cloudParseSequence.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  function createCloudParseProgress(label, onCancel) {
    // Карточка прогресса — общая для всех тяжёлых операций (ui/modes.js): появляется, если импорт идёт дольше ~0,4 с
    const P = window.__lxProgress;
    const stop = P && P.begin ? P.begin('Импорт: ' + String(label || 'облако точек'), { onCancel }) : null;
    const phaseNames = {
      header: 'Читаю и проверяю заголовок',
      index: 'Проверяю структуру LAS',
      read: 'Читаю точки',
      finalize: 'Подготавливаю облако',
      'read-ascii': 'Читаю текстовые точки',
      'read-binary': 'Читаю бинарные точки',
      'read-compressed': 'Читаю сжатые данные',
      decompress: 'Распаковываю сжатые данные',
      'decode-points': 'Декодирую точки',
      'pcd-lzf-decompress': 'Распаковываю PCD LZF во временное дисковое хранилище',
      'pcd-lzf-sample': 'Выбираю точки из PCD LZF',
      'read-e57': 'Читаю сканы E57',
      'index-text': 'Анализирую текстовые поля',
      'sample-text': 'Выбираю точки в пределах бюджета',
      'ptx-index': 'Проверяю сетки и сканы PTX',
      'ptx-sample': 'Применяю положение сканов PTX',
      'decode-laz': 'Распаковываю LAZ (декодер не сообщает процент)',
      'decoded-laz': 'LAZ распакован; подготавливаю точки',
      done: 'Готово',
      cancelled: 'Импорт отменён',
      error: 'Импорт завершился ошибкой'
    };
    return {
      update(progress) {
        if (!stop || !progress || typeof progress !== 'object') return;
        const phase = String(progress.phase || '');
        const f = Number(progress.fraction);
        const description = progress.message ? String(progress.message) : (phaseNames[phase] || phase || 'Импорт');
        let suffix = '';
        if (Number.isFinite(Number(progress.pointsLoaded)) && Number(progress.pointsLoaded) > 0) {
          suffix = ' · ' + Number(progress.pointsLoaded).toLocaleString('ru-RU') + ' точек';
        } else if (Number.isFinite(Number(progress.pointsRead)) && Number(progress.pointsRead) > 0) {
          suffix = ' · ' + Number(progress.pointsRead).toLocaleString('ru-RU') + ' точек';
        }
        if (phase === 'pcd-lzf-decompress' && Number(progress.bytesExpected) > 0) {
          suffix = ' · ' +
            (Number(progress.bytesWritten || 0) / (1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) +
            ' / ' +
            (Number(progress.bytesExpected) / (1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) +
            ' МиБ';
        }
        if (phase === 'decode-laz') stop.text(description + suffix);
        else stop.set(Number.isFinite(f) ? f : 0, description + suffix);
      },
      close() { if (stop) { try { stop(); } catch (_) {} } }
    };
  }
  // Бюджет чтения (200 млн) и бюджет рисования потока октодерева за кадр — разные вещи: рисуем не больше LOD_DRAW_BUDGET точек.
  function lodDrawBudget(budget) { const cap = Number(window.APP_CONFIG && window.APP_CONFIG.LOD_DRAW_BUDGET) || 80000000; return Math.max(1000000, Math.min(Number(budget) || cap, cap)); }
  async function parseCloudWithProgress(filePath, label) {
    if (!API || typeof API.parseCloud !== 'function') return { ok: false, message: 'Импорт облака недоступен' };
    if (typeof API.onCloudParseProgress !== 'function' || typeof API.cancelCloudParse !== 'function') {
      return await API.parseCloud(filePath);
    }
    const jobId = makeCloudParseJobId();
    let latest = null;
    const panel = createCloudParseProgress(label || filePath, () => API.cancelCloudParse(jobId));
    const unsubscribe = API.onCloudParseProgress(jobId, (event) => {
      latest = event;
      panel.update(event);
    });
    try {
      const result = await API.parseCloud(filePath, jobId);
      if (result && result.ok) panel.update({ phase: 'done', fraction: 1, pointsLoaded: result.count || (result.pos && result.pos.length / 3) || 0 });
      else if (result && result.cancelled) panel.update({ phase: 'cancelled', fraction: 0 });
      else if (result && result.message) panel.update({ phase: 'error', fraction: latest && latest.fraction || 0, message: result.message });
      // Keep completion/error visible briefly so fast jobs still give feedback.
      await new Promise(resolve => setTimeout(resolve, 260));
      if (result && result.ok && result.pointBudget && result.pointBudget.ipcLimited) {
        try { const pb = result.pointBudget; toast('В файле ' + (pb.total / 1e6).toFixed(1) + ' млн точек: для устойчивой работы окна открыты ' + Math.round(pb.applied / 1e6) + ' млн (равномерная выборка). Весь файл — кнопка «Потоковый LOD».'); } catch (_) {}
      }
      if (result && result.ok && result.pointBudget && result.pointBudget.memoryLimited) {
        try { const pb = result.pointBudget; toast('Свободной памяти хватает на ~' + Math.round(pb.applied / 1e6) + ' млн точек из ' + (pb.total / 1e6).toFixed(1) + ' млн в файле: облако открыто прореженным. Закройте другие программы и откройте файл снова — тогда оно загрузится целиком.'); } catch (_) {}
      }
      return result;
    } finally {
      try { if (typeof unsubscribe === 'function') unsubscribe(); } catch (_) {}
      panel.close();
    }
  }
  const CAN_PERSIST = !!(API && API.uploadDocument);
  const CAN_VERIFY = !!(API && API.analyzeRoom);

  // Чистые хелперы вынесены в renderer/app-utils.js (загружается перед app.js). (r13)
  const _AU = window.AppUtils || {};
  const is3DModelName = _AU.is3DModelName, fmtSize = _AU.fmtSize, guessDocType = _AU.guessDocType,
    b64ToU8 = _AU.b64ToU8, fileToBase64 = _AU.fileToBase64, fileToArrayBuffer = _AU.fileToArrayBuffer;

  const STATUS_COLOR = { err: '#e5484d', ok: '#16a34a', warn: '#d99a00', none: '#9aa4b2' };
  const STATUS_LABEL = { err: 'Ошибка', ok: 'ОК', warn: 'На проверке', none: 'Нет данных' };
  const RANK = { none: 0, ok: 1, warn: 2, err: 3 };
  const EL_TYPES = [
    'стена', 'перегородка', 'пол', 'потолок', 'плита', 'колонна', 'балка',
    'дверь', 'окно', 'проём', 'труба', 'воздуховод', 'вентшахта',
    'кабель-канал', 'оборудование'
  ];

  let DB = null, viewer = null, current = null, selEl = null;
  let filter = 'all', searchTerm = '', activeTab = 'docs', editing = false;
  let SETTINGS = {};
  let USERS = [], PROJECTS = [];

  // ---------- data ----------
  async function loadData() {
    if (CAN_PERSIST) { DB = await API.getData(); normalize(DB); }
    else { DB = buildFromSeed(); }
  }
  function normalize(db) {
    db.rooms = db.rooms || [];
    for (const r of db.rooms) { r.elements = r.elements || []; r.documents = r.documents || []; r.findings = r.findings || []; }
  }
  function buildFromSeed() {
    const seed = JSON.parse(JSON.stringify(window.SEED));
    const db = { project: seed.project, floors: seed.floors, rooms: seed.rooms };
    normalize(db); mergeAI(db); return db;
  }
  // For demo mode: attach findings from SEED_FINDINGS and derive ai_status.
  function mergeAI(db) {
    const F = window.SEED_FINDINGS || {}, S = window.SEED_STATUS || {};
    for (const r of db.rooms) {
      r.findings = r.findings && r.findings.length ? r.findings : [];
      for (const e of r.elements) {
        if (e.ai_status && e.ai_status !== 'none') continue;
        const arr = F[e.id] || [];
        if (!r.findings.some(f => f.element_id === e.id)) for (const f of arr) r.findings.push(f);
        e.ai_status = S[e.id] || (arr.reduce((b, f) => RANK[f.severity] > RANK[b] ? f.severity : b, 'none'));
      }
    }
  }

  const roomsOfFloor = fid => DB.rooms.filter(r => r.floor_id === fid);
  const findRoom = id => DB.rooms.find(r => r.id === id);
  const roomErrCount = r => r.elements.filter(e => e.ai_status === 'err').length;
  const roomWarnCount = r => r.elements.filter(e => e.ai_status === 'warn').length;
  function roomDocs(r, elId) { return r && Array.isArray(r.documents) ? r.documents.filter(d => elId ? d.element_id === elId : true) : []; }

  // ---------- tree ----------
  function matchRoom(r) {
    if (searchTerm) {
      const hay = (r.name + ' ' + (r.number || '') + ' ' + r.elements.map(e => e.name).join(' ')).toLowerCase();
      if (!hay.includes(searchTerm)) return false;
    }
    if (filter === 'all') return true;
    return r.elements.some(e => e.ai_status === filter);
  }
  function renderTree() {
    const box = $('tree'); box.innerHTML = '';
    const ph = document.createElement('div'); ph.className = 'project';
    ph.innerHTML = '<span>' + esc(DB.project.name) + '</span>'; ph.title = DB.project.name;
    { const a = mk('span', 'addfloor', ICON('plus', 13) + '<span class="lbl">Этаж</span>'); a.title = 'Добавить этаж'; a.onclick = createFloorUI; ph.appendChild(a); }
    box.appendChild(ph);

    for (const f of DB.floors) {
      const fr = document.createElement('div'); fr.className = 'floor';
      fr.innerHTML = '<span>' + esc(f.name) + '</span>'; fr.title = f.name;
      const addRoom = mk('span', 'addroom', ICON('plus', 14)); addRoom.title = 'Добавить помещение'; addRoom.onclick = (ev) => { ev.stopPropagation(); createRoomUI(f.id); }; fr.appendChild(addRoom);
      if (editing) {
        const acts = mk('span', 'row-actions');
        const ed = mk('span', 'edit', ICON('pencil', 14)); ed.onclick = () => editFloorUI(f);
        const del = mk('span', 'del', ICON('x', 14)); del.onclick = () => deleteFloorUI(f);
        acts.append(ed, del); fr.appendChild(acts);
      }
      box.appendChild(fr);
      const _frooms = roomsOfFloor(f.id).filter(matchRoom);
      if (!_frooms.length) { const eh = mk('div', 'tree-empty', ICON('plus', 13) + '<span>Нет помещений — добавить</span>'); eh.onclick = () => createRoomUI(f.id); box.appendChild(eh); }
      for (const r of _frooms) {
        if (!matchRoom(r)) continue;
        const row = document.createElement('div'); row.className = 'room' + (current && current.id === r.id ? ' active' : '');
        const sev = roomErrCount(r) ? 'err' : (roomWarnCount(r) ? 'warn' : (r.elements.some(e => e.ai_status === 'ok') ? 'ok' : 'none'));
        row.innerHTML = '<i class="dot ' + sev + '"></i><span class="rn">' + esc(r.name) + '</span>';
        const ec = roomErrCount(r); if (ec) { const b = mk('span', 'rcount', String(ec)); row.appendChild(b); }
        row.onclick = () => openRoom(r.id);
        if (editing) {
          const acts = mk('span', 'row-actions');
          const ed = mk('span', 'edit', ICON('pencil', 14)); ed.onclick = ev => { ev.stopPropagation(); editRoomUI(r); };
          const del = mk('span', 'del', ICON('x', 14)); del.onclick = ev => { ev.stopPropagation(); deleteRoomUI(r); };
          acts.append(ed, del); row.appendChild(acts);
        }
        box.appendChild(row);
      }
    }
  }

  // ---------- room / viewer ----------
  async function openRoom(id) {
    current = findRoom(id); selEl = null; if (!current) return;
    $('roomTitle').textContent = current.name + (current.number ? ' · ' + current.number : '');
    const _tbr = $('tbRoom'); if (_tbr) { const _rt = current.name + (current.number ? ' · ' + current.number : ''); _tbr.textContent = _rt; _tbr.title = _rt; }
    $('btnBackRoom').style.display = 'none';
    viewer.loadRoom(current);
    await maybeLoadModel(current);
    // Фоновую предзагрузку всех облаков больше не запускаем автоматически (тормозила старт).
    // Предзагрузка теперь только по кнопке «Макс. память» (профиль «Максимум памяти/качество»).
    renderElbar(); renderTree(); updateElProps();
    $('inspTitle').textContent = current.name;
    $('inspSub').textContent = (current.type || 'помещение') + ' · ' + (current.area_m2 || 0) + ' м²';
    renderTab();
  }
  // Расширения 3D, которые умеет открывать вьюер
  const MODEL_EXTS = ['glb', 'gltf', 'obj', 'stl', 'ply', 'las', 'laz', 'e57'];
  // is3DModelName → window.AppUtils (renderer/app-utils.js)
  function meshWarningSummary(warnings, metadata) {
    const ws = Array.isArray(warnings) ? warnings : [];
    const hints = [];
    if (ws.some(w => /MTL|материал|текстур/i.test(w))) hints.push('без MTL/материалов');
    if (ws.some(w => /иерархия OBJ|групп|объектов сведена/i.test(w))) hints.push('группы сведены к одному мешу');
    if (ws.some(w => /CRS|единиц/i.test(w))) hints.push('CRS/единицы не заданы');
    if (ws.some(w => /facet-атрибуты/i.test(w))) hints.push('facet-атрибуты STL не применены');
    const removed = metadata && ((metadata.removedCollinearCorners || 0) + (metadata.removedDuplicateCorners || 0));
    if (removed) hints.push('исключено нулевых углов: ' + Number(removed).toLocaleString('ru-RU'));
    if (metadata && metadata.rejectedFaces) hints.push('пропущено граней: ' + Number(metadata.rejectedFaces).toLocaleString('ru-RU'));
    return hints.length ? ' · ' + hints.join('; ') : '';
  }
  // Единая точка загрузки геометрии в 3D-вьюер по расширению
  async function load3DBuffer(name, buf) {
    if (/\.(glb|gltf)$/i.test(name)) {
      if (/\.gltf$/i.test(name)) { const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buf))); viewer.loadGltf(gltf, []); }
      else viewer.loadGlb(buf);
      return { ok: true, kind: 'mesh' };
    }
    if (/\.(obj|stl)$/i.test(name)) {
      if (!window.MeshViewer) return { ok: false, message: 'Модуль OBJ/STL-вьюера не загружен.' };
      const meshHost = document.querySelector('.stage');
      if (meshHost) window.MeshViewer.mount(meshHost);
      const scene = window.MeshViewer.loadAsync ? await window.MeshViewer.loadAsync(buf, name) : window.MeshViewer.load(buf, name);
      if (!scene) return { ok: false, message: 'Загрузка меша отменена другой операцией.' };
      return { ok: true, kind: 'mesh-overlay', triangles: scene && scene.triangles, warnings: (scene && scene.warnings) || [], metadata: (scene && scene.metadata) || {} };
    }
    if (/\.(ply|las|laz|e57)$/i.test(name)) {
      if (!window.PointCloud) return { ok: false, message: 'Модуль облаков точек не загрузился (pointcloud.js) — переустановите сборку.' };
      const res = await window.PointCloud.parse(name, buf);
      if (!res || !res.ok) return { ok: false, message: (res && res.message) || 'Формат не поддерживается' };
      if (res.kind === 'mesh') viewer.loadColoredMesh(res); else viewer.loadCloud(res, { sourceName: name });
      return { ok: true, kind: res.kind, meta: res.meta };
    }
    return { ok: false, message: 'Неизвестный 3D-формат' };
  }
  // Тяжёлые облака точек НЕ грузим автоматически при открытии помещения — иначе старт очень долгий.
  // Запоминаем путь и показываем кнопку «Открыть облако» — пользователь грузит по требованию.
  const HEAVY_CLOUD_RE = /\.(las|laz|e57|ply|pcd|xyz|pts|xyzrgb)$/i;
  var pendingCloudPath = null;
  function updateOpenCloudBtn() {
    const b = $('btnOpenCloud'); if (!b) return;
    b.style.display = '';
    b.title = pendingCloudPath ? 'Открыть сохранённое облако точек этого помещения' : 'Открыть облако точек: LAS/LAZ/E57/PTX/PCD/PLY/PTS/XYZ/CSV';
  }
  async function maybeLoadModel(room) {
    pendingCloudPath = null; updateOpenCloudBtn();
    if (!CAN_PERSIST) return;
    try {
      const p = await API.getModelPath(room.id); if (!p) return;
      // Тяжёлое облако точек — откладываем загрузку, показываем кнопку «Открыть облако».
      if (HEAVY_CLOUD_RE.test(p)) { pendingCloudPath = p; updateOpenCloudBtn(); return; }
      // Лёгкая mesh-модель (glb/gltf) — грузим сразу.
      const b64 = await API.readFile(p); if (!b64) return;
      const buf = b64ToU8(b64).buffer;
      const r = await load3DBuffer(p, buf);
      if (!r.ok) { console.warn('model load', r.message); return; }
      if (r.kind !== 'points' && r.kind !== 'mesh-overlay') await applyModelDims(room, 'auto');
      $('btnBackRoom').style.display = '';
    } catch (e) { console.warn('model load', e); }
  }
  // Загрузка отложенного облака точек текущего помещения по требованию (кнопка «Открыть облако»).
  async function openPendingCloud() {
    const room = current; const p = pendingCloudPath;
    if (!p) { const mi = $('modelInput'); if (mi) { toast('Нет сохранённого облака — выберите файл облака (LAS/LAZ/E57/PTX/PCD/PLY/PTS/XYZ/CSV)'); mi.click(); } else { toast('Для этого помещения нет сохранённого облака'); } return; }
    const btn = $('btnOpenCloud'); if (btn) btn.classList.add('on');
    toast('Открываю облако точек… это может занять время');
    try {
      if (/\.(las|laz|ply|e57|ptx|pcd|xyz|pts|txt|csv|xyzrgb)$/i.test(p) && API && API.parseCloud) {
        if (showCloudFromCache(p)) { lastCloudPath = p; const _cc = cloudCacheMap.get(p); lastCloudCount = (_cc && _cc.count) || 0; }
        else {
          const pr = await parseCloudWithProgress(p, String(p).split(/[\\/]/).pop());
          if (pr && pr.ok) {
            if (pr.kind === 'mesh') viewer.loadColoredMesh(pr); else { viewer.loadCloud(pr, {sourceName:p}); cacheCloud(p, pr); }
            lastCloudPath = p; lastCloudCount = (pr.meta && pr.meta.points) || 0;
          } else if (pr && pr.fallback) {
            const b64 = await API.readFile(p); if (!b64) { toast('Файл PLY не найден'); return; }
            const r = await load3DBuffer(p, b64ToU8(b64).buffer);
            if (!r.ok) { toast(r.message || 'Не удалось открыть PLY mesh'); return; }
            // load3DBuffer already routes the parsed result into the appropriate
            // viewer method; r is only a status object and has no vertex buffers.
            lastCloudPath = p; lastCloudCount = (r.meta && r.meta.points) || 0;
          } else { toast((pr && pr.message) || 'Не удалось открыть облако'); return; }
        }
      } else {
        const b64 = await API.readFile(p); if (!b64) { toast('Файл облака точек не найден'); return; }
        const buf = b64ToU8(b64).buffer;
        const r = await load3DBuffer(p, buf);
        if (!r.ok) { toast(r.message || 'Не удалось открыть облако'); return; }
        if (r.kind !== 'points') await applyModelDims(room, 'auto');
        lastCloudPath = p; lastCloudCount = (r.meta && r.meta.points) || 0;
      }
      $('btnBackRoom').style.display = '';
      pendingCloudPath = null; updateOpenCloudBtn();
      toast('Облако открыто' + (lastCloudCount ? ': ' + Number(lastCloudCount).toLocaleString('ru-RU') + ' точек' : ''));
    } catch (e) { console.warn('open cloud', e); toast('Ошибка открытия облака'); }
    finally { if (btn) btn.classList.remove('on'); }
  }
  // Синхронизирует свойства помещения (площадь/высота/габариты/объём) с реальной 3D-моделью
  async function applyModelDims(room, mode) {
    const dm = viewer && viewer.modelDims; if (!room || !dm) return;
    const area = Math.round(dm.footprint * 100) / 100;
    const height = Math.round(dm.h * 100) / 100;
    const changed = Math.abs((room.area_m2 || 0) - area) > 0.5 || Math.abs((room.height_m || 0) - height) > 0.05;
    room.area_m2 = area; room.height_m = height;
    room.dims = { w: dm.w, d: dm.d, h: dm.h };
    room.volume_m3 = Math.round(dm.volume * 100) / 100;
    if (current && current.id === room.id) {
      $('inspSub').textContent = (room.type || 'помещение') + ' · ' + area + ' м²';
      if (!selEl && activeTab === 'props') renderTab();
    }
    if (CAN_PERSIST && (mode === 'force' || (mode === 'auto' && changed))) {
      try { await API.updateRoom(room.id, { area_m2: area, height_m: height }); } catch (e) { console.warn('persist dims', e); }
    }
  }
  function renderElbar() {
    const bar = $('elbar'); bar.innerHTML = '';
    for (const e of current.elements) {
      const pill = document.createElement('div'); pill.className = 'elpill' + (selEl && selEl.id === e.id ? ' sel' : '');
      pill.innerHTML = '<i class="dot ' + (e.ai_status || 'none') + '"></i><span class="nm">' + esc(e.name) + '</span>';
      pill.onclick = () => selectEl(e.id);
      bar.appendChild(pill);
    }
    if (editing) { const add = mk('div', 'elpill add', '+ элемент'); add.onclick = () => createElementUI(current.id); bar.appendChild(add); }
  }
  function selectEl(id) {
    selEl = current.elements.find(e => e.id === id) || null;
    viewer.select(selEl ? selEl.id : null);
    renderElbar();
    if (selEl) { $('inspTitle').textContent = selEl.name; $('inspSub').textContent = selEl.type + ' · Статус: ' + STATUS_LABEL[selEl.ai_status || 'none']; }
    else { $('inspTitle').textContent = current.name; $('inspSub').textContent = (current.type || 'помещение'); }
    updateElProps();
    renderTab();
  }

  // ---------- inspector tabs ----------
  function renderTab() {
    const body = $('tabbody'); body.innerHTML = '';
    if (!current && activeTab !== 'dash') {
      body.appendChild(mk('div', 'empty', DB.rooms.length
        ? 'Выберите помещение, чтобы открыть его документы и свойства.'
        : 'В проекте пока нет помещений. Добавьте этаж и создайте помещение.'));
      return;
    }
    if (activeTab === 'docs') renderDocs(body);
    else if (activeTab === 'props') renderProps(body);
    else if (activeTab === 'ai') renderAI(body);
    else if (activeTab === 'disc') renderDisc(body);
    else renderDashboard(body);
  }
  // Цветной SVG-бейдж в виде листа бумаги с короткой меткой типа файла.
  function fileBadge(color, label) {
    label = String(label || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();
    const fs = label.length >= 4 ? 5 : (label.length === 3 ? 6 : 7);
    return '<svg class="fic" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
      '<path d="M7 3h6l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="' + color + '"/>' +
      '<path d="M13 3l4 4h-3a1 1 0 0 1-1-1z" fill="rgba(255,255,255,.45)"/>' +
      '<text x="11.5" y="17.5" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="' + fs + '" fill="#fff">' + label + '</text>' +
      '</svg>';
  }
  function docIcon(d) {
    const ext = (String(d.name || d.file || '').split('.').pop() || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'svg', 'ico', 'avif'].includes(ext)) return fileBadge('#7A5AF8', 'IMG');
    if (ext === 'pdf') return fileBadge('#E23B3B', 'PDF');
    if (ext === 'csv') return fileBadge('#1D8A46', 'CSV');
    if (['xls', 'xlsx', 'ods'].includes(ext)) return fileBadge('#1D8A46', 'XLS');
    if (['ppt', 'pptx', 'odp'].includes(ext)) return fileBadge('#D24726', 'PPT');
    if (ext === 'txt') return fileBadge('#2B5BB0', 'TXT');
    if (['doc', 'docx', 'md', 'rtf', 'odt'].includes(ext)) return fileBadge('#2B5BB0', 'DOC');
    if (['dwg', 'dxf', 'ifc'].includes(ext)) return fileBadge('#5B6B7B', ext);
    if (['rvt', 'skp', 'step', 'stp', 'iges', 'igs', 'nwd', 'nwc'].includes(ext)) return fileBadge('#5B6B7B', 'CAD');
    if (['glb', 'gltf', 'obj', 'fbx', '3ds', 'stl'].includes(ext)) return fileBadge('#0E9CA3', '3D');
    return fileBadge('#8A94A6', ext || 'DOC');
  }
  function renderDocs(body) {
    const allDocs = roomDocs(current);
    const head = mk('div', 'docs-head');
    head.innerHTML = '<div class="docs-title">Документы помещения <span class="docs-count">' + allDocs.length + '</span></div>';
    body.appendChild(head);
    const an = mk('div', 'docs-analyzing', '<span class="an-spin"></span><span>Идёт анализ документов…</span>'); an.id = 'docsAnalyzing'; an.style.display = VERIFYING ? 'flex' : 'none'; body.appendChild(an);
    // Always-visible upload zone with drag & drop — the room document repository
    const zone = mk('div', 'docs-drop');
    zone.innerHTML = '<div class="dz-ic" data-ico="upload" data-ico-size="22"></div><div class="dz-t">Перетащите файл сюда или нажмите, чтобы загрузить</div><div class="dz-s">PDF, Word, Excel/CSV, изображения, чертежи (DWG/DXF/IFC) и другое</div>';
    zone.onclick = () => $('docInput').click();
    zone.ondragover = e => { e.preventDefault(); zone.classList.add('over'); };
    zone.ondragleave = () => zone.classList.remove('over');
    zone.ondrop = e => { e.preventDefault(); zone.classList.remove('over'); const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) addDocumentFile(f); };
    body.appendChild(zone);
    if (editing) {
      const bar = mk('div', 'crud-actions');
      const add = mk('button', 'btn sm', '+ Запись без файла'); add.onclick = () => createDocumentUI();
      bar.append(add); body.appendChild(bar);
    }
    if (!allDocs.length) { body.appendChild(mk('div', 'empty', 'Пока нет документов. Загрузите смету, ТЗ, чертёж или фото — они сохранятся в этом помещении.')); return; }
    const search = document.createElement('input'); search.type = 'search'; search.className = 'docs-search'; search.placeholder = 'Поиск по документам…'; search.value = renderDocs.q || '';
    body.appendChild(search);
    const listWrap = mk('div', 'docs-list'); body.appendChild(listWrap);
    const selId = selEl && selEl.id;
    const draw = () => {
      listWrap.innerHTML = '';
      const q = (renderDocs.q || '').trim().toLowerCase();
      let list = allDocs.slice();
      if (q) list = list.filter(d => (d.name || '').toLowerCase().includes(q) || (d.type || '').toLowerCase().includes(q) || (d.version || '').toLowerCase().includes(q));
      list.sort((a, b) => (selId ? ((b.element_id === selId) - (a.element_id === selId)) : 0));
      if (!list.length) { listWrap.appendChild(mk('div', 'empty', 'Ничего не найдено по запросу «' + esc(renderDocs.q) + '»')); return; }
      for (const d of list) {
        const openable = !!d.file;
        const row = document.createElement('div'); row.className = 'doc' + (openable ? ' doc-open' : '') + (selId && d.element_id === selId ? ' doc-hl' : '');
        const el = d.element_id && current.elements.find(e => e.id === d.element_id);
        const scope = el ? '<span class="doc-scope">' + esc(el.name) + '</span>' : '<span class="doc-scope room">помещение</span>';
        const hint = openable ? '<span class="doc-open-hint">Открыть ›</span>' : '<span class="doc-noview">без файла</span>';
        let vers = '';
        if (d.versions && d.versions.length) vers = '<div class="ver">' + d.versions.map(v => '<span class="v' + (v.v === d.version ? ' cur' : '') + '">' + esc(v.v) + '</span>').join('') + '</div>';
        row.innerHTML = '<div class="ic">' + docIcon(d) + '</div><div class="doc-main"><div class="name">' + esc(d.name) + '</div>' +
          '<div class="meta">' + esc(d.type || 'документ') + ' · ' + esc(d.version || 'v1') + ' · ' + esc(d.date || '') + (d.author ? ' · ' + esc(d.author) : '') + '</div>' + vers +
          '<div class="doc-tags">' + scope + hint + '</div></div>';
        if (openable) { row.onclick = () => openDoc(d); row.onmouseenter = () => schedulePreview(d, row); row.onmouseleave = hidePreview; }
        if (d.versions && d.versions.length) { const vspans = row.querySelectorAll('.ver .v'); d.versions.forEach((vv, vi) => { const sp = vspans[vi]; if (!sp) return; sp.title = 'Открыть версию ' + vv.v; sp.onclick = ev => { ev.stopPropagation(); openVersion(d, vv); }; }); }
        const del = mk('span', 'del', ICON('trash', 15)); del.title = 'Удалить документ'; del.onclick = ev => { ev.stopPropagation(); deleteDocUI(d); }; row.appendChild(del);
        listWrap.appendChild(row);
      }
    };
    search.oninput = () => { renderDocs.q = search.value; draw(); };
    draw();
  }
  function renderProps(body) {
    const t = selEl || current;
    const rows = selEl
      ? [['Имя', t.name], ['Тип', t.type], ['IFC GUID', t.ifc_guid || '—'], ['Статус НС', STATUS_LABEL[t.ai_status || 'none']]]
      : (() => {
          const rs = [['Помещение', t.name], ['Номер', t.number || '—'], ['Тип', t.type || '—'], ['Площадь', (t.area_m2 || 0) + ' м²'], ['Высота', (t.height_m || 0) + ' м']];
          if (t.dims) rs.push(['Габариты (Ш×Г×В)', (Math.round(t.dims.w * 100) / 100) + ' × ' + (Math.round(t.dims.d * 100) / 100) + ' × ' + (Math.round(t.dims.h * 100) / 100) + ' м']);
          if (t.volume_m3) rs.push(['Объём (модель)', t.volume_m3 + ' м³']);
          rs.push(['Статус', t.status || '—']);
          return rs;
        })();
    for (const [k, v] of rows) { const r = mk('div', 'kv'); r.innerHTML = '<span class="k">' + esc(k) + '</span><span>' + esc(String(v)) + '</span>'; body.appendChild(r); }
    if (editing) {
      const bar = mk('div', 'crud-actions');
      if (selEl) {
        const ed = mk('button', 'btn sm', IB('pencil', 'Изменить элемент')); ed.onclick = () => editElementUI(selEl);
        const del = mk('button', 'btn sm danger', IB('trash-2', 'Удалить элемент')); del.onclick = () => deleteElementUI(selEl);
        bar.append(ed, del);
      } else {
        const ed = mk('button', 'btn sm', IB('pencil', 'Изменить помещение')); ed.onclick = () => editRoomUI(current); bar.append(ed);
      }
      body.appendChild(bar);
    }
  }
  function renderAI(body) {
    const bar = mk('div', 'crud-actions');
    const vbtn = mk('button', 'btn sm primary', ICON('shield-check', 15) + '<span class="lbl">' + (selEl ? 'Проверить элемент' : 'Проверить помещение') + '</span>');
    vbtn.onclick = () => runVerify();
    bar.appendChild(vbtn);
    const sbtn = mk('button', 'btn sm', ICON('settings', 15) + '<span class="lbl">Настройки ИИ</span>'); sbtn.onclick = openSettings; bar.appendChild(sbtn);
    const allbtn = mk('button', 'btn sm', ICON('refresh-cw', 15) + '<span class="lbl">Все помещения</span>'); allbtn.onclick = () => runVerifyAll(); bar.appendChild(allbtn);
    const exbtn = mk('button', 'btn sm', ICON('file-down', 15) + '<span class="lbl">Экспорт отчёта</span>'); exbtn.onclick = () => exportReportUI(); bar.appendChild(exbtn);
    body.appendChild(bar);

    let items = selEl ? current.findings.filter(f => f.element_id === selEl.id) : current.findings.slice();
    if (!items.length) { body.appendChild(mk('div', 'empty', 'Замечаний нет. Нажмите «Проверить», чтобы запустить анализ документов.')); return; }
    items.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
    for (const f of items) {
      const el = current.elements.find(e => e.id === f.element_id);
      const reviewed = f.review && f.review !== 'open';
      const card = mk('div', 'finding ' + f.severity + (reviewed ? ' reviewed rv-' + f.review : ''));
      const src = f.source === 'llm' ? '<span class="src llm">LLM</span>' : (f.source === 'ocr' ? '<span class="src">OCR</span>' : '<span class="src">правило</span>');
      let cmts = '';
      if (f.comments && f.comments.length) cmts = '<div class="fcomments">' + f.comments.map(c => '<div class="fc">' + ICON('message-circle', 13) + '<span>' + esc(c.text || c) + '</span></div>').join('') + '</div>';
      const rv = reviewed ? '<div class="rvline ' + f.review + '">' + (f.review === 'accepted' ? ICON('check', 13) + '<span>Принято</span>' : ICON('x', 13) + '<span>Отклонено</span>') + '</div>' : '';
      const who = USERS.find(u => u.id === f.assignee);
      const asgLine = (who || f.due) ? '<div class="assignee">' + ICON('user', 13) + '<span>' + esc(who ? who.name : 'не назначен') + (f.due ? ' · до ' + esc(f.due) : '') + '</span></div>' : '';
      card.innerHTML = '<div class="fhead"><b>' + esc(f.kind) + '</b><span class="badge ' + f.severity + '">' + STATUS_LABEL[f.severity] + '</span>' + src + '</div>' +
        '<div class="ftext">' + esc(f.text) + '</div>' +
        '<div class="conf">' + (el ? esc(el.name) + ' · ' : '') + 'уверенность ' + Math.round((f.confidence || 0) * 100) + '%</div>' + rv + asgLine + cmts;
      const acts = mk('div', 'factions');
      const acc = mk('button', 'btn xs ok', ICON('check', 13) + '<span class="lbl">Принять</span>'); acc.onclick = ev => { ev.stopPropagation(); reviewFinding(f, 'accepted'); };
      const rej = mk('button', 'btn xs danger', ICON('x', 13) + '<span class="lbl">Отклонить</span>'); rej.onclick = ev => { ev.stopPropagation(); reviewFinding(f, 'rejected'); };
      const cm = mk('button', 'btn xs', ICON('message-circle', 15)); cm.title = 'Комментарий'; cm.onclick = ev => { ev.stopPropagation(); commentFinding(f); };
      const asg = mk('button', 'btn xs', ICON('user', 15)); asg.title = 'Назначить ответственного'; asg.onclick = ev => { ev.stopPropagation(); assignFindingUI(f); };
      acts.append(acc, rej, cm, asg); card.appendChild(acts);
      card.onclick = () => { if (el) selectEl(el.id); };
      body.appendChild(card);
    }
  }

  // ---------- Phase C: проверка нейросетью + ревью находок ----------
  let VERIFYING = false;
  function setAnalyzing(on) { VERIFYING = !!on; const b = document.getElementById('docsAnalyzing'); if (!b) return; if (on) { b.className = 'docs-analyzing'; b.innerHTML = '<span class="an-spin"></span><span>Идёт анализ документов…</span>'; b.onclick = null; b.style.cursor = 'default'; } b.style.display = on ? 'flex' : 'none'; }
  function showAnalyzeDone(counts) { VERIFYING = false; const b = document.getElementById('docsAnalyzing'); if (!b) return; const c = counts || {}; b.className = 'docs-analyzing done'; b.innerHTML = '<span class="an-check">' + ICON('check', 11) + '</span><span>Готово: ' + (c.err || 0) + ' ошибок, ' + (c.warn || 0) + ' на проверке</span><span class="an-go">Открыть ›</span>'; b.style.display = 'flex'; b.style.cursor = 'pointer'; b.onclick = () => { activeTab = 'ai'; syncTabs(); }; clearTimeout(showAnalyzeDone._t); showAnalyzeDone._t = setTimeout(() => { const e = document.getElementById('docsAnalyzing'); if (e && e.classList.contains('done')) e.style.display = 'none'; }, 4000); }
  async function runVerify(silent) {
    if (!current) { toast('Выберите помещение'); return; }
    setAnalyzing(true);
    try {
    if (CAN_VERIFY) {
      if (!silent) toast('Анализ документов…');
      let rep;
      try { rep = await API.analyzeRoom(current.id); }
      catch (e) { console.error(e); toast('Ошибка проверки'); return; }
      await refresh(current.id);
      if (!silent) { activeTab = 'ai'; syncTabs(); }
      if (rep && rep.ok) { toast('Проверка: ' + rep.counts.err + ' ошибок, ' + rep.counts.warn + ' на проверке'); showAnalyzeDone(rep.counts); if (!silent) showVerifyReport(rep); }
      else toast('Не удалось выполнить проверку');
    } else {
      const intent = window.DESIGN_INTENT || {};
      current.findings = window.VerifyDemo.verifyRoom(current, intent);
      window.VerifyDemo.recompute(current);
      renderTree(); renderElbar(); if (!silent) { activeTab = 'ai'; syncTabs(); }
      toast('Демо-проверка выполнена');
      showAnalyzeDone(countFindings(current.findings));
      if (!silent) showVerifyReport({ demo: true, counts: countFindings(current.findings), total: current.findings.length, documents: [] });
    }
    } finally { const _b = document.getElementById('docsAnalyzing'); if (_b && !_b.classList.contains('done')) _b.style.display = 'none'; VERIFYING = false; }
  }
  function countFindings(arr) { const c = { err: 0, warn: 0, ok: 0 }; for (const f of arr) if (c[f.severity] != null) c[f.severity]++; return c; }
  // F3: массовая проверка всех помещений
  async function runVerifyAll() {
    setAnalyzing(true); toast('Проверка всех помещений…');
    try {
      let results;
      if (CAN_VERIFY) {
        let res; try { res = await API.analyzeAll(); } catch (e) { toast('Ошибка проверки'); return; }
        results = (res && res.results) || [];
        await refresh(current && current.id);
      } else {
        const intent = window.DESIGN_INTENT || {};
        results = [];
        for (const r of DB.rooms) { r.findings = window.VerifyDemo.verifyRoom(r, intent); window.VerifyDemo.recompute(r); results.push({ roomId: r.id, name: r.name, number: r.number || '', counts: countFindings(r.findings), total: r.findings.length }); }
        renderTree(); renderElbar(); renderTab();
      }
      showAllReport(results);
    } finally { setAnalyzing(false); }
  }
  function showAllReport(results) {
    results = results || [];
    const tot = results.reduce((a, r) => ({ err: a.err + (r.counts.err || 0), warn: a.warn + (r.counts.warn || 0), ok: a.ok + (r.counts.ok || 0) }), { err: 0, warn: 0, ok: 0 });
    const p = modalPanel('Проверка всех помещений');
    const sum = mk('div', 'ifc-report');
    sum.innerHTML = '<div class="kv"><span class="k">Помещений</span><span>' + results.length + '</span></div>' +
      '<div class="kv"><span class="k">Ошибки</span><span>' + tot.err + '</span></div>' +
      '<div class="kv"><span class="k">На проверке</span><span>' + tot.warn + '</span></div>' +
      '<div class="kv"><span class="k">ОК</span><span>' + tot.ok + '</span></div>';
    p.body.appendChild(sum);
    const tbl = mk('table', 'allrep-table');
    tbl.innerHTML = '<tr><th>Помещение</th><th>Ошибки</th><th>На проверке</th><th>Всего</th></tr>';
    results.slice().sort((a, b) => (b.counts.err - a.counts.err) || (b.counts.warn - a.counts.warn)).forEach(r => {
      const tr = document.createElement('tr'); tr.className = 'allrep-row' + (r.counts.err ? ' has-err' : '');
      tr.innerHTML = '<td>' + esc(r.name || '') + '</td><td class="c-err">' + (r.counts.err || 0) + '</td><td class="c-warn">' + (r.counts.warn || 0) + '</td><td>' + (r.total || 0) + '</td>';
      tr.onclick = () => { p.close(); openRoom(r.roomId); activeTab = 'ai'; syncTabs(); };
      tbl.appendChild(tr);
    });
    p.body.appendChild(tbl);
    const ex = mk('button', 'btn sm', IB('file-down', 'Экспорт всего отчёта')); ex.onclick = () => exportReportUI(); p.body.appendChild(ex);
  }
  async function reviewFinding(f, review) {
    f.review = f.review === review ? 'open' : review;
    if (CAN_VERIFY && f.id) { try { await API.updateFinding(f.id, { review: f.review }); } catch (e) {} }
    recomputeLocal();
    renderTree(); renderElbar(); renderTab();
    toast(f.review === 'accepted' ? 'Принято' : (f.review === 'rejected' ? 'отклонено' : 'Сброшено'));
  }
  async function commentFinding(f) {
    const v = await openForm('Комментарий к находке', [{ k: 'text', label: 'Текст', value: '' }]);
    if (!v || !v.text) return;
    f.comments = f.comments || []; f.comments.push({ text: v.text, at: new Date().toISOString() });
    if (CAN_VERIFY && f.id) { try { await API.addFindingComment(f.id, v.text); } catch (e) {} }
    renderTab(); toast('Комментарий добавлен');
  }
  function recomputeLocal() {
    if (!current) return;
    for (const e of current.elements) {
      let best = 'none';
      for (const f of current.findings) if (f.element_id === e.id && f.review !== 'rejected' && RANK[f.severity] > RANK[best]) best = f.severity;
      e.ai_status = best;
    }
  }
  function showVerifyReport(rep) {
    const docs = (rep.documents || []).map(d => '<li>' + esc(d.name || '') + ' — ' + esc(d.kind || '') + (d.chars != null ? ' (' + d.chars + ' симв.)' : '') + (d.ocr ? ' · OCR: ' + esc(d.ocr) : '') + (d.note ? ' · ' + esc(d.note) : '') + '</li>').join('');
    const c = rep.counts || { err: 0, warn: 0, ok: 0 };
    const html = '<div class="ifc-report">' +
      '<div class="kv"><span class="k">Ошибки</span><span>' + c.err + '</span></div>' +
      '<div class="kv"><span class="k">На проверке</span><span>' + c.warn + '</span></div>' +
      '<div class="kv"><span class="k">ОК</span><span>' + c.ok + '</span></div>' +
      (rep.demo ? '<div class="muted" style="margin:8px 0">Демо-режим: проверка по проектному замыслу без разбора файлов. В десктоп-версии разбираются PDF/XLSX/CSV/TXT и сканы (OCR).</div>' :
        '<div class="kv"><span class="k">OCR (Tesseract)</span><span>' + (rep.ocrAvailable ? 'доступен' : 'не установлен') + '</span></div>' +
        '<div class="kv"><span class="k">LLM-верификатор</span><span>' + (rep.llmConfigured
          ? ('вкл · вызовов: ' + (rep.llmUsed || 0))
          : ((rep.llmStatus && rep.llmStatus.reason === 'consent_required') ? 'выкл · требуется согласие на удалённую передачу' : 'выкл')) + '</span></div>' +
        '<h4>Разобранные документы (' + (rep.documents || []).length + ')</h4>' + (docs ? '<ul>' + docs + '</ul>' : '<div class="muted">Файлы не приложены — проверка по проектному замыслу.</div>')) +
      '</div>';
    showInfo('Отчёт проверки', html);
  }
  // ---------- Phase E: theme + i18n ----------
  function T(key) { return window.I18N ? window.I18N.t(key) : key; }
  function applyTheme(theme) {
    const dark = theme === 'dark';
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    SETTINGS = Object.assign({}, SETTINGS, { theme: dark ? 'dark' : 'light' });
    try { if (viewer && viewer.setTheme) viewer.setTheme(dark ? 'dark' : 'light'); } catch (e) {}
  }
  window.__bimSetTheme = theme => { applyTheme(theme); persistSettings({ theme }); };
  function applyLang(lang) {
    if (window.I18N) { window.I18N.set(lang); window.I18N.apply(document); }
    SETTINGS = Object.assign({}, SETTINGS, { lang: (window.I18N && window.I18N.lang) || lang });
    // Re-render dynamic UI that isn't driven by data-i18n
    try { renderTree(); } catch (e) {}
    try { if (current) renderTab(); } catch (e) {}
  }
  function decorateIcons() {
    // Иконки описаны в разметке атрибутами data-ico / data-ico-lead; здесь только подстановка SVG.
    if (window.__lxKit && window.__lxKit.hydrate) window.__lxKit.hydrate(document);
  }
  function settingsForLocalStorage(value) {
    const safe = Object.assign({}, value || {});
    delete safe.llmApiKey;
    delete safe.llmApiKeyEnc;
    return safe;
  }
  async function persistSettings(patch) {
    const next = Object.assign({}, patch || {});
    try {
      let saved = null;
      if (CAN_VERIFY && API && API.setSettings) saved = await API.setSettings(next);
      SETTINGS = Object.assign({}, SETTINGS, next, saved || {});
      if (next.llmApiKey) {
        SETTINGS.llmApiKeyConfigured = true;
        SETTINGS.llmApiKey = '';
      }
      try { localStorage.setItem('bim.settings', JSON.stringify(settingsForLocalStorage(SETTINGS))); } catch (e) {}
      return { ok: true, settings: saved || null };
    } catch (error) {
      try { console.warn('settings save failed', error); } catch (_) {}
      return { ok: false, error: String(error && error.message || error) };
    }
  }

  async function openSettings() {
    let s = SETTINGS || {};
    if (CAN_VERIFY) { try { s = Object.assign({}, s, (await API.getSettings()) || {}); SETTINGS = s; } catch (e) {} }
    const st = {
      theme: s.theme || 'light',
      lang: (window.I18N && window.I18N.lang) || s.lang || 'ru',
      llmProvider: s.llmProvider || 'none',
      llmApiKey: '',
      llmApiKeyConfigured: !!s.llmApiKeyConfigured,
      clearLlmApiKey: false,
      llmHost: s.llmHost || 'http://localhost:11434',
      llmModel: s.llmModel || 'gpt-4o-mini',
      llmRemoteConsent: s.llmRemoteConsent === true,
      llmDocumentCharLimit: Number.isSafeInteger(Number(s.llmDocumentCharLimit)) ? Number(s.llmDocumentCharLimit) : 6000,
      ocrLang: s.ocrLang || 'rus+ukr+eng',
      autoVerify: s.autoVerify !== false
    };
    const p = modalPanel(T('settings.title'));
    p.body.classList.add('settings-body');
    const section = (title) => { const sec = mk('div', 'set-sec'); sec.appendChild(mk('div', 'set-h', esc(title))); p.body.appendChild(sec); return sec; };
    const rowSelect = (sec, label, opts, val, onch) => {
      const row = mk('div', 'set-row'); row.appendChild(mk('label', 'set-lbl', esc(label)));
      const sel = mk('select', 'set-ctl');
      opts.forEach(([v, lab]) => { const o = document.createElement('option'); o.value = v; o.textContent = lab; if (v === val) o.selected = true; sel.appendChild(o); });
      sel.onchange = () => onch(sel.value); row.appendChild(sel); sec.appendChild(row); return sel;
    };
    const rowInput = (sec, label, val, onch, type) => {
      const row = mk('div', 'set-row'); row.appendChild(mk('label', 'set-lbl', esc(label)));
      const inp = mk('input', 'set-ctl'); inp.type = type || 'text'; inp.value = val == null ? '' : val;
      inp.oninput = () => onch(inp.value); row.appendChild(inp); sec.appendChild(row); return inp;
    };
    const rowCheckbox = (sec, label, val, onch) => {
      const row = mk('div', 'set-row'); row.appendChild(mk('label', 'set-lbl', esc(label)));
      const inp = mk('input', 'set-ctl-chk'); inp.type = 'checkbox'; inp.checked = !!val;
      inp.onchange = () => onch(inp.checked); row.appendChild(inp); sec.appendChild(row); return inp;
    };
    const rowStatic = (sec, label, value, onOpen) => {
      const row = mk('div', 'set-row'); row.appendChild(mk('label', 'set-lbl', esc(label)));
      const wrap = mk('div', 'set-static'); wrap.appendChild(mk('code', null, esc(value || '—')));
      if (onOpen && value) { const b = named(mk('button', 'btn xs', ICON('external-link', 14)), 'Открыть'); b.onclick = onOpen; wrap.appendChild(b); }
      row.appendChild(wrap); sec.appendChild(row); return row;
    };

    // Appearance
    const secA = section(T('settings.appearance'));
    rowSelect(secA, T('settings.theme'), [['light', T('settings.theme.light')], ['dark', T('settings.theme.dark')]], st.theme, v => { st.theme = v; applyTheme(v); });
    rowSelect(secA, T('settings.lang'), (window.I18N ? window.I18N.langs : ['ru']).map(l => [l, (window.I18N && window.I18N.label[l]) || l]), st.lang, v => { st.lang = v; applyLang(v); p.close(); openSettings(); });

    // AI & verification
    const secAI = section(T('settings.ai'));
    rowSelect(secAI, T('settings.provider'), [['none', 'none'], ['openai', 'openai'], ['ollama', 'ollama']], st.llmProvider, v => st.llmProvider = v);
    const keyInput = rowInput(secAI, T('settings.apikey'), st.llmApiKey, v => st.llmApiKey = v, 'password');
    if (st.llmApiKeyConfigured) keyInput.placeholder = 'Ключ уже сохранён в защищённом хранилище';
    rowCheckbox(secAI, 'Удалить сохранённый API-ключ', st.clearLlmApiKey, v => st.clearLlmApiKey = v);
    rowInput(secAI, T('settings.host'), st.llmHost, v => st.llmHost = v);
    rowInput(secAI, T('settings.model'), st.llmModel, v => st.llmModel = v);
    rowInput(secAI, 'Максимум символов документа для AI', st.llmDocumentCharLimit, v => st.llmDocumentCharLimit = Math.max(0, Math.min(12000, parseInt(v, 10) || 0)), 'number');
    rowCheckbox(secAI, 'Разрешаю передачу фрагментов документов удалённому AI', st.llmRemoteConsent, v => st.llmRemoteConsent = v);
    secAI.appendChild(mk('div', 'set-hint', 'OpenAI и удалённый Ollama не получают данные без этого явного разрешения. Локальный Ollama на localhost работает без передачи наружу.'));
    rowInput(secAI, T('settings.ocr'), st.ocrLang, v => st.ocrLang = v);
    rowCheckbox(secAI, T('settings.autoVerify'), st.autoVerify, v => st.autoVerify = v);

    // OCR (desktop only) — только проверка статуса; установка вынесена в START.bat / start.sh
    if (CAN_PERSIST && API && API.ocrStatus) {
      const secO = section('OCR (распознавание сканов)');
      const statusRow = mk('div', 'set-row');
      statusRow.appendChild(mk('label', 'set-lbl', 'Состояние'));
      const statWrap = mk('div', 'set-static'); const statCode = mk('code', null, 'проверка…'); statWrap.appendChild(statCode);
      statusRow.appendChild(statWrap); secO.appendChild(statusRow);
      const refreshStat = async () => {
        try {
          const s = (API.ocrStatus ? await API.ocrStatus() : null) || {};
          const t = s.tesseract ? 'Tesseract: готов' : 'Tesseract: не найден';
          const r = s.rasterizer ? (s.rasterizer + ': готов') : 'PDF-растеризатор: не найден';
          statCode.textContent = t + ' · ' + r;
        } catch (e) { statCode.textContent = '—'; }
      };
      refreshStat();
      const btnRow = mk('div', 'set-row');
      const reBtn = mk('button', 'btn sm', 'Проверить снова'); reBtn.style.width = 'auto';
      const progHint = mk('div', 'set-hint', '');
      reBtn.onclick = async () => { statCode.textContent = 'проверка…'; await refreshStat(); progHint.textContent = 'Статус обновлён.'; };
      btnRow.appendChild(reBtn); secO.appendChild(btnRow); secO.appendChild(progHint);
      secO.appendChild(mk('div', 'set-hint', 'Нужны Tesseract (rus+ukr+eng) и Poppler или Ghostscript. Установка выполняется автоматически при запуске через START.bat (Windows) или start.sh / start.command. Если чего-то не хватает — закройте приложение и запустите START.bat.'));
    }

    // Data & files (desktop only)
    if (CAN_PERSIST && API && API.getPaths) {
      const secP = section(T('settings.paths'));
      try {
        const paths = (await API.getPaths()) || {};
        rowStatic(secP, 'userData', paths.userData, paths.userData ? () => API.openPath(paths.userData) : null);
        rowStatic(secP, 'uploads', paths.uploads, paths.uploads ? () => API.openPath(paths.uploads) : null);
        rowStatic(secP, 'store', paths.store, paths.store ? () => API.openPath(paths.store) : null);
      } catch (e) { secP.appendChild(mk('div', 'empty', '—')); }
    }

    // About
    const secAbout = section(T('settings.about'));
    let ver = '1.2.0-rc.3';
    if (CAN_PERSIST && API && API.getVersion) { try { ver = await API.getVersion(); } catch (e) {} }
    rowStatic(secAbout, 'BIM Twin', 'v' + ver + (CAN_PERSIST ? '' : ' · демо'));
    const updRow = mk('div', 'set-row');
    const updBtn = mk('button', 'btn sm', T('settings.checkUpd')); updBtn.style.width = 'auto';
    updBtn.onclick = async () => {
      updBtn.disabled = true;
      if (!(CAN_PERSIST && API && API.checkUpdates)) { toast('Обновления доступны в установленной сборке'); updBtn.disabled = false; return; }
      try {
        const r = await API.checkUpdates();
        if (r && r.ok && r.available) toast('Доступна версия ' + r.version);
        else if (r && r.ok) toast('У вас последняя версия');
        else toast((r && r.message) || 'Проверка недоступна');
      } catch (e) { toast('Проверка недоступна'); }
      updBtn.disabled = false;
    };
    updRow.appendChild(updBtn); secAbout.appendChild(updRow);

    // Save bar
    const bar = mk('div', 'set-actions');
    const save = mk('button', 'btn primary', T('settings.save'));
    save.onclick = async () => {
      const patch = {
        theme: st.theme, lang: st.lang,
        llmProvider: st.llmProvider, llmHost: st.llmHost,
        llmModel: st.llmModel, llmRemoteConsent: st.llmRemoteConsent,
        llmDocumentCharLimit: st.llmDocumentCharLimit,
        ocrLang: st.ocrLang, autoVerify: st.autoVerify
      };
      if (st.clearLlmApiKey) patch.llmApiKey = '';
      else if (st.llmApiKey) patch.llmApiKey = st.llmApiKey;
      save.disabled = true;
      const result = await persistSettings(patch);
      save.disabled = false;
      if (!result.ok) {
        toast(result.error === 'secure_storage_unavailable'
          ? 'API-ключ не сохранён: защищённое хранилище системы недоступно'
          : 'Не удалось сохранить настройки: ' + result.error);
        return;
      }
      applyTheme(st.theme); applyLang(st.lang);
      p.close(); toast(T('settings.save'), { tone: 'ok' });
    };
    bar.appendChild(save); p.body.appendChild(bar);
  }

  // ---------- Phase E: onboarding + demo project ----------
  function isOnboarded() {
    if (SETTINGS && SETTINGS.onboarded) return true;
    try { return localStorage.getItem('bim.onboarded') === '1'; } catch (e) { return false; }
  }
  function markOnboarded() {
    persistSettings({ onboarded: true });
    try { localStorage.setItem('bim.onboarded', '1'); } catch (e) {}
  }
  function maybeOnboard() {
    const ov = $('onboard'); if (!ov) return;
    if (isOnboarded()) { ov.style.display = 'none'; return; }
    // language chips
    const langs = $('onboardLangs');
    if (langs) {
      langs.innerHTML = '';
      (window.I18N ? window.I18N.langs : ['ru']).forEach(l => {
        const chip = mk('span', 'onb-lang' + (((window.I18N && window.I18N.lang) || 'ru') === l ? ' active' : ''), (window.I18N && window.I18N.label[l]) || l);
        chip.onclick = () => { applyLang(l); persistSettings({ lang: l }); langs.querySelectorAll('.onb-lang').forEach(x => x.classList.remove('active')); chip.classList.add('active'); };
        langs.appendChild(chip);
      });
    }
    ov.style.display = 'flex';
    const close = () => { ov.style.display = 'none'; markOnboarded(); };
    $('onbSkip').onclick = close;
    $('onbStart').onclick = close;
    $('onbDemo').onclick = async () => { close(); await loadDemoProject(); };
  }
  async function loadDemoProject() {
    if (CAN_PERSIST && API && API.createProject) {
      try {
        await API.createProject({ name: 'Демо-проект', address: 'г. Пример, ул. Демонстрационная, 1' });
        const fl = await API.createFloor({ name: '1 этаж', number: 1 });
        const rooms = [['Серверная', '101', 'тех.'], ['Переговорная', '102', 'офис'], ['Венткамера', '103', 'тех.']];
        for (const [nm, no, tp] of rooms) {
          const r = await API.createRoom(fl.id, { name: nm, number: no, type: tp, area_m2: 20, height_m: 3 });
          if (r && r.id) { await API.createElement(r.id, { name: 'Вентшахта', type: 'вентшахта', ai_status: 'none' }); await API.createElement(r.id, { name: 'Оборудование', type: 'оборудование', ai_status: 'none' }); }
        }
        await loadData(); await loadTeam(); current = null; selEl = null; renderTree();
        if (DB.rooms.length) openRoom(DB.rooms[0].id); else renderTab();
        toast('Демо-проект создан');
      } catch (e) { toast('Не удалось создать демо-проект'); }
    } else {
      toast('Демо-данные уже загружены');
    }
  }
  function renderDashboard(body) {
    let err = 0, warn = 0, ok = 0;
    const rows = [];
    for (const r of DB.rooms) for (const f of r.findings) {
      if (f.severity === 'err') err++; else if (f.severity === 'warn') warn++; else if (f.severity === 'ok') ok++;
      if (f.severity === 'err' || f.severity === 'warn') rows.push({ f, r });
    }
    const cards = mk('div', 'dash-cards');
    cards.innerHTML = '<div class="dcard err"><div class="n">' + err + '</div><div class="l">Ошибки</div></div>' +
      '<div class="dcard warn"><div class="n">' + warn + '</div><div class="l">На проверке</div></div>' +
      '<div class="dcard ok"><div class="n">' + ok + '</div><div class="l">ОК</div></div>';
    body.appendChild(cards);
    rows.sort((a, b) => RANK[b.f.severity] - RANK[a.f.severity]);
    for (const { f, r } of rows) {
      const row = mk('div', 'dash-row ' + f.severity);
      row.innerHTML = '<span>' + esc(f.kind) + '</span><span class="where">' + esc(r.name) + '</span>';
      row.onclick = () => { openRoom(r.id).then(() => { activeTab = 'ai'; syncTabs(); selectEl(f.element_id); }); };
      body.appendChild(row);
    }
    if (!rows.length) body.appendChild(mk('div', 'empty', 'Критичных замечаний нет'));
  }

  // ---------- documents / models ----------
  // fileToBase64 → window.AppUtils (renderer/app-utils.js)
  // fileToArrayBuffer → window.AppUtils (renderer/app-utils.js)
  // b64ToU8 → window.AppUtils (renderer/app-utils.js)
  // guessDocType → window.AppUtils (renderer/app-utils.js)

  async function addDocumentFile(file) {
    if (!current) { toast('Сначала выберите помещение'); return; }
    if (is3DModelName(file.name)) { return loadModelFile(file); }   // 3D-форматы (glb/gltf/ply/las/laz/e57) открываем во вьютере, а не как документ
    if (CAN_PERSIST) {
      const base64 = await fileToBase64(file);
      const doc = await API.uploadDocument({ roomId: current.id, elementId: selEl && selEl.id, type: guessDocType(file.name), name: file.name, author: '', mime: file.type, base64 });
      current.documents.push(doc);
    } else {
      current.documents.push({ id: 'doc_' + Math.random().toString(36).slice(2, 8), room_id: current.id, element_id: selEl && selEl.id, type: guessDocType(file.name), name: file.name, version: 'v1', date: new Date().toISOString().slice(0, 10), author: '', is_upload: 0, versions: [] });
      toast('Демо-режим: файл не сохранён на диск');
    }
    renderTab(); toast('Документ добавлен');
    // Авто-считывание данных нового документа и автоматическая проверка (по умолчанию включено)
    if (current && (!SETTINGS || SETTINGS.autoVerify !== false)) { toast('Считываю документ и проверяю…'); runVerify(true); }
    if (current) refreshAutomaticComparisonsForRoom(current.id);
  }
  // fmtSize → window.AppUtils (renderer/app-utils.js)
  function normalizeGrid(rows, maxCols) {
    let g = (rows || []).map(r => (r || []).map(c => (c == null ? '' : String(c))));
    let ncol = 0; g.forEach(r => { if (r.length > ncol) ncol = r.length; });
    if (maxCols) ncol = Math.min(ncol, maxCols);
    g = g.map(r => { const rr = r.slice(0, ncol); while (rr.length < ncol) rr.push(''); return rr; });
    g = g.filter(r => r.some(c => String(c).trim() !== ''));
    const keep = [];
    for (let c = 0; c < ncol; c++) { if (g.some(r => String(r[c] || '').trim() !== '')) keep.push(c); }
    g = g.map(r => keep.map(c => r[c]));
    return g;
  }
  function buildTable(rows, maxRows, maxCols) {
    const wrap = mk('div', 'docview-tablewrap');
    const tbl = document.createElement('table'); tbl.className = 'docview-table';
    const data = normalizeGrid(rows, maxCols);
    const total = data.length;
    const ncol = data.length ? data[0].length : 1;
    data.slice(0, maxRows).forEach((r, ri) => {
      const tr = document.createElement('tr');
      const filled = r.filter(c => String(c == null ? '' : c).trim() !== '');
      if (filled.length === 1 && String(r[0] == null ? '' : r[0]).trim() !== '' && ncol > 1) {
        const td = document.createElement(ri === 0 ? 'th' : 'td'); td.textContent = String(r[0]); td.colSpan = ncol; td.className = 'docview-span'; tr.appendChild(td);
      } else {
        (r.length ? r : ['']).forEach(c => { const td = document.createElement(ri === 0 ? 'th' : 'td'); td.textContent = c == null ? '' : String(c); tr.appendChild(td); });
      }
      tbl.appendChild(tr);
    });
    wrap.appendChild(tbl);
    if (total > maxRows) wrap.appendChild(mk('div', 'docview-more', 'Показаны первые ' + maxRows + ' строк из ' + total));
    return wrap;
  }
  function isNumeric(s) { const t = String(s).trim(); if (!t) return false; return /^-?\d{1,3}([ \u00a0]\d{3})*([.,]\d+)?$/.test(t) || /^-?\d+([.,]\d+)?$/.test(t); }
  function buildExcelTable(sheet, maxRows, maxCols) {
    const rows = sheet.rows || [];
    const wrap = mk('div', 'docview-tablewrap excel');
    const tbl = document.createElement('table'); tbl.className = 'docview-table excel';
    let ncol = 0; rows.forEach(r => { if (r.length > ncol) ncol = r.length; });
    ncol = Math.min(ncol, maxCols); const nrow = Math.min(rows.length, maxRows);
    const covered = {}, span = {};
    (sheet.merges || []).forEach(m => {
      if (m.r >= nrow || m.c >= ncol) return;
      const rs = Math.min(m.rs, nrow - m.r), cs = Math.min(m.cs, ncol - m.c);
      span[m.r + ':' + m.c] = { rs, cs };
      for (let r = m.r; r < m.r + rs; r++) for (let c = m.c; c < m.c + cs; c++) { if (r === m.r && c === m.c) continue; covered[r + ':' + c] = 1; }
    });
    const cg = document.createElement('colgroup');
    for (let c = 0; c < ncol; c++) { const col = document.createElement('col'); const w = (sheet.colWidths || [])[c]; if (w) col.style.width = Math.max(24, Math.min(w, 460)) + 'px'; cg.appendChild(col); }
    tbl.appendChild(cg);
    for (let r = 0; r < nrow; r++) {
      const tr = document.createElement('tr');
      for (let c = 0; c < ncol; c++) {
        if (covered[r + ':' + c]) continue;
        const td = document.createElement('td');
        const sp = span[r + ':' + c]; if (sp) { if (sp.rs > 1) td.rowSpan = sp.rs; if (sp.cs > 1) td.colSpan = sp.cs; }
        const val = (rows[r] && rows[r][c] != null) ? String(rows[r][c]) : '';
        td.textContent = val; if (val && isNumeric(val)) td.className = 'num';
        tr.appendChild(td);
      }
      tbl.appendChild(tr);
    }
    wrap.appendChild(tbl);
    if (rows.length > maxRows) wrap.appendChild(mk('div', 'docview-more', 'Показаны первые ' + maxRows + ' строк из ' + rows.length));
    return wrap;
  }
  function csvToRows(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n').filter(l => l.length);
    const delim = (text.indexOf('\t') >= 0 && text.indexOf(',') < 0) ? '\t' : (text.split(';').length > text.split(',').length ? ';' : ',');
    return lines.map(l => l.split(delim));
  }
  function parseDxf(text) {
    const t = String(text).split(/\r\n|\r|\n/);
    const seg = [], circ = [], layers = {};
    let type = null, cur = {}, vx = [], px = null;
    const finish = () => {
      const L = (cur[8] != null ? String(cur[8]).trim() : '') || '0';
      if (type === 'LINE' && cur[10] != null && cur[11] != null) { seg.push([+cur[10], +cur[20], +cur[11], +cur[21], L]); layers[L] = true; }
      else if (type === 'CIRCLE' && cur[10] != null) { circ.push([+cur[10], +cur[20], +cur[40], L]); layers[L] = true; }
      else if (type === 'ARC' && cur[10] != null) { const cx = +cur[10], cy = +cur[20], r = +cur[40]; let a1 = (+cur[50] || 0) * Math.PI / 180, a2 = (+cur[51] || 0) * Math.PI / 180; if (a2 <= a1) a2 += 2 * Math.PI; const N = 24; for (let s = 0; s < N; s++) { const p1 = a1 + (a2 - a1) * s / N, p2 = a1 + (a2 - a1) * (s + 1) / N; seg.push([cx + r * Math.cos(p1), cy + r * Math.sin(p1), cx + r * Math.cos(p2), cy + r * Math.sin(p2), L]); } layers[L] = true; }
      else if (type === 'LWPOLYLINE') { for (let v = 0; v + 1 < vx.length; v++) seg.push([vx[v][0], vx[v][1], vx[v + 1][0], vx[v + 1][1], L]); if ((parseInt(cur[70] || 0, 10) & 1) && vx.length > 2) seg.push([vx[vx.length - 1][0], vx[vx.length - 1][1], vx[0][0], vx[0][1], L]); if (vx.length > 1) layers[L] = true; }
      type = null; cur = {}; vx = []; px = null;
    };
    for (let k = 0; k + 1 < t.length; k += 2) {
      const code = t[k].trim(), val = t[k + 1];
      if (code === '0') { if (type) finish(); const v = String(val).trim(); if (v === 'LINE' || v === 'CIRCLE' || v === 'ARC' || v === 'LWPOLYLINE') { type = v; cur = {}; vx = []; px = null; } continue; }
      if (!type) continue;
      const c = parseInt(code, 10);
      if (type === 'LWPOLYLINE') { if (c === 10) px = +val; else if (c === 20) vx.push([px, +val]); else cur[c] = val; }
      else cur[c] = val;
    }
    if (type) finish();
    return { seg, circ, layers: Object.keys(layers) };
  }
  function drawDxf(data, host) {
    const seg = data.seg || [], circ = data.circ || [];
    if (!seg.length && !circ.length) return false;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    const acc = (x, y) => { if (isFinite(x) && isFinite(y)) { if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y; } };
    seg.forEach(s => { acc(s[0], s[1]); acc(s[2], s[3]); });
    circ.forEach(c => { acc(c[0] - c[2], c[1] - c[2]); acc(c[0] + c[2], c[1] + c[2]); });
    if (!isFinite(minx)) return false;
    const PALETTE = ['#ff7a3d', '#4a9df8', '#2ec38b', '#e5c05a', '#c07ce0', '#e0607a', '#5fc9d0', '#b7c0cc'];
    const layerNames = (data.layers && data.layers.length ? data.layers : ['0']).slice();
    const layerColor = {}, layerOn = {};
    layerNames.forEach((n, i) => { layerColor[n] = PALETTE[i % PALETTE.length]; layerOn[n] = true; });
    const W = 820, H = 500, pad = 24;
    const wrap = mk('div', 'dxf-wrap');
    const bar = mk('div', 'dxf-bar');
    const btnFit = mk('button', 'btn xs', ICON('home', 14) + '<span class="lbl">По размеру</span>');
    const btnIn = named(mk('button', 'btn xs', ICON('zoom-in', 14)), 'Приблизить');
    const btnOut = named(mk('button', 'btn xs', ICON('zoom-out', 14)), 'Отдалить');
    const readout = mk('span', 'dxf-coord', 'X: —  Y: —');
    bar.append(btnFit, btnIn, btnOut, readout);
    const layRow = mk('div', 'dxf-layers');
    if (layerNames.length > 1 || layerNames[0] !== '0') layerNames.forEach(n => {
      const chip = mk('button', 'dxf-layer on');
      chip.innerHTML = '<i class="lc" style="background:' + layerColor[n] + '"></i><span>' + esc(n) + '</span>';
      chip.onclick = () => { layerOn[n] = !layerOn[n]; chip.classList.toggle('on', layerOn[n]); redraw(); };
      layRow.appendChild(chip);
    });
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; cv.className = 'docview-canvas dxf-canvas';
    const ctx = cv.getContext('2d');
    wrap.append(bar, layRow, cv); host.appendChild(wrap);
    const dw = (maxx - minx) || 1, dh = (maxy - miny) || 1;
    let view = { scale: 1, ox: 0, oy: 0 };
    const tx = wx => wx * view.scale + view.ox;
    const ty = wy => view.oy - wy * view.scale;
    const inv = (sx, sy) => [(sx - view.ox) / view.scale, (view.oy - sy) / view.scale];
    let snap = null;
    function redraw() {
      ctx.clearRect(0, 0, W, H); ctx.lineWidth = 1;
      const byL = {}; seg.forEach(s => { const L = s[4] || '0'; if (layerOn[L] === false) return; (byL[L] = byL[L] || []).push(s); });
      Object.keys(byL).forEach(L => { ctx.strokeStyle = layerColor[L] || '#ff7a3d'; ctx.beginPath(); byL[L].forEach(s => { ctx.moveTo(tx(s[0]), ty(s[1])); ctx.lineTo(tx(s[2]), ty(s[3])); }); ctx.stroke(); });
      circ.forEach(c => { const L = c[3] || '0'; if (layerOn[L] === false) return; ctx.strokeStyle = layerColor[L] || '#ff7a3d'; ctx.beginPath(); ctx.arc(tx(c[0]), ty(c[1]), Math.abs(c[2]) * view.scale, 0, 2 * Math.PI); ctx.stroke(); });
      if (snap) { ctx.fillStyle = '#2f6bff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.rect(tx(snap[0]) - 4, ty(snap[1]) - 4, 8, 8); ctx.fill(); ctx.stroke(); }
    }
    function fit() { const sc = Math.min((W - 2 * pad) / dw, (H - 2 * pad) / dh); view.scale = sc; view.ox = (W - dw * sc) / 2 - minx * sc; view.oy = (H - dh * sc) / 2 + maxy * sc; redraw(); }
    fit();
    btnFit.onclick = fit;
    const zoomAt = (mx, my, f) => { view.ox = mx - (mx - view.ox) * f; view.oy = my - (my - view.oy) * f; view.scale *= f; redraw(); };
    btnIn.onclick = () => zoomAt(W / 2, H / 2, 1.25);
    btnOut.onclick = () => zoomAt(W / 2, H / 2, 0.8);
    cv.addEventListener('wheel', e => { e.preventDefault(); const r = cv.getBoundingClientRect(); const mx = (e.clientX - r.left) * (W / r.width), my = (e.clientY - r.top) * (H / r.height); zoomAt(mx, my, e.deltaY > 0 ? 0.9 : 1.1); }, { passive: false });
    let drag = null;
    cv.addEventListener('mousedown', e => { drag = { x: e.clientX, y: e.clientY }; cv.style.cursor = 'grabbing'; });
    window.addEventListener('mouseup', () => { if (drag) { drag = null; cv.style.cursor = ''; } });
    cv.addEventListener('mousemove', e => {
      const r = cv.getBoundingClientRect(); const mx = (e.clientX - r.left) * (W / r.width), my = (e.clientY - r.top) * (H / r.height);
      if (drag) { const dx = (e.clientX - drag.x) * (W / r.width), dy = (e.clientY - drag.y) * (H / r.height); drag.x = e.clientX; drag.y = e.clientY; view.ox += dx; view.oy += dy; redraw(); return; }
      const wp = inv(mx, my); let best = null, bd = 12 / view.scale;
      for (const s of seg) { if (layerOn[s[4] || '0'] === false) continue; const ends = [[s[0], s[1]], [s[2], s[3]]]; for (const p of ends) { const d = Math.hypot(p[0] - wp[0], p[1] - wp[1]); if (d < bd) { bd = d; best = p; } } }
      snap = best;
      const rx = best ? best[0] : wp[0], ry = best ? best[1] : wp[1];
      readout.textContent = (best ? 'привязка · ' : '') + 'X: ' + rx.toFixed(2) + '  Y: ' + ry.toFixed(2);
      redraw();
    });
    return true;
  }
  // F1: открытие предыдущей версии документа
  async function openVersion(d, v) {
    if (!v) return;
    if (v.v === d.version) { openDoc(d); return; }
    if (CAN_PERSIST && API.openFile && v.file) { await API.openFile(v.file); toast('Открыта версия ' + v.v + ' во внешней программе'); }
    else toast('Предыдущие версии доступны в десктоп-версии');
  }
  // F4: предпросмотр документа при наведении
  let _pvTimer = null, _pvEl = null;
  function ensurePreviewEl() { if (_pvEl) return _pvEl; _pvEl = mk('div', 'doc-preview'); _pvEl.style.display = 'none'; document.body.appendChild(_pvEl); return _pvEl; }
  function hidePreview() { if (_pvTimer) { clearTimeout(_pvTimer); _pvTimer = null; } const e = ensurePreviewEl(); e.style.display = 'none'; }
  function schedulePreview(d, row) { if (!CAN_PERSIST || !d.file) return; if (_pvTimer) clearTimeout(_pvTimer); _pvTimer = setTimeout(() => showPreview(d, row), 420); }
  function positionPreview(e, row) { const r = row.getBoundingClientRect(); const w = 320; let left = r.left - w - 14; if (left < 8) left = Math.min(r.right + 14, window.innerWidth - w - 8); let top = r.top; const maxH = 340; if (top + maxH > window.innerHeight - 8) top = Math.max(8, window.innerHeight - maxH - 8); e.style.left = left + 'px'; e.style.top = top + 'px'; e.style.width = w + 'px'; }
  async function showPreview(d, row) {
    const e = ensurePreviewEl();
    e.innerHTML = '<div class="pv-load">Предпросмотр…</div>'; e.style.display = 'block'; positionPreview(e, row);
    let info = d._preview;
    if (!info) { try { info = await API.readDocument(d.id); } catch (_) { info = { ok: false }; } d._preview = info; }
    if (e.style.display === 'none') return;
    e.innerHTML = '';
    e.appendChild(mk('div', 'pv-head', docIcon(d) + ' ' + esc(d.name)));
    const bodyp = mk('div', 'pv-body');
    if (!info || !info.ok) { bodyp.innerHTML = '<div class="pv-note">Не удалось прочитать файл</div>'; }
    else if (info.isImage) { const img = document.createElement('img'); img.className = 'pv-img'; img.src = 'data:' + (info.mime || 'image/png') + ';base64,' + info.base64; bodyp.appendChild(img); }
    else if (info.sheets && info.sheets.length) { bodyp.appendChild(buildTable(info.sheets[0].rows || [], 7, 6)); }
    else if (info.kind === 'csv' && info.text) { bodyp.appendChild(buildTable(csvToRows(info.text), 7, 6)); }
    else if (info.text && info.text.trim()) { bodyp.appendChild(mk('pre', 'pv-text', esc(info.text.slice(0, 600)))); }
    else if (info.isPdf) { bodyp.innerHTML = '<div class="pv-note">PDF — откройте для просмотра</div>'; }
    else { bodyp.innerHTML = '<div class="pv-note">Предпросмотр недоступен · .' + esc(info.ext || '') + '</div>'; }
    e.appendChild(bodyp);
    positionPreview(e, row);
  }
  async function openDoc(d) {
    hidePreview();
    if (window.XLSViewer && window.XLSViewer.dispose) { try { window.XLSViewer.dispose(); } catch (e) {} }
    if (!CAN_PERSIST) { toast('Просмотр файла доступен в десктоп-версии'); return; }
    if (!d.file) { toast('У документа нет прикреплённого файла'); return; }
    const p = modalPanel(d.name || 'Документ');
    if (p.body.parentElement) p.body.parentElement.classList.add('docview-modal-card');
    if (p.overlay) p.overlay.classList.add('docview-modal-overlay');
    p.body.className = 'panel-body docview-body';
    p.body.innerHTML = '<div class="docview-loading">Загрузка…</div>';
    let info;
    try { info = await API.readDocument(d.id); } catch (e) { info = { ok: false, error: String(e) }; }
    p.body.innerHTML = '';
    const bar = mk('div', 'docview-bar dv2-head');
    const fileBox = mk('div', 'dv2-file');
    const fic = mk('span', 'dv2-ic', docIcon(d));
    const fmeta = mk('div', 'dv2-fmeta');
    fmeta.appendChild(mk('div', 'dv2-name', esc(d.name || 'Документ')));
    fmeta.appendChild(mk('div', 'docview-meta dv2-meta', esc(d.type || 'документ') + (info && info.size ? ' · ' + fmtSize(info.size) : '') + (info && info.ext ? ' · .' + esc(info.ext) : '')));
    fileBox.append(fic, fmeta);
    const tools = mk('div', 'dv2-tools');
    const toolBtn = (icon, title, fn) => { const b = mk('button', 'dv2-tool'); b.title = title; b.innerHTML = (window.ICON ? window.ICON(icon, 18) : ''); b.onclick = fn; return b; };
    const actions = mk('div', 'dv2-actions');
    const extBtn = mk('button', 'btn sm dv2-btn'); extBtn.innerHTML = (window.ICON ? window.ICON('external-link', 16) : '') + '<span class="lbl">Открыть внешне</span>'; extBtn.onclick = () => API.openFile(d.file);
    const saveBtn = mk('button', 'btn sm dv2-btn'); saveBtn.innerHTML = (window.ICON ? window.ICON('download', 16) : '') + '<span class="lbl">Скачать копию</span>'; saveBtn.onclick = async () => { if (!API.saveCopy) return; const r = await API.saveCopy(d.id); if (r && r.ok) toast('Копия сохранена'); else if (!(r && r.canceled)) toast('Не удалось сохранить копию'); };
    actions.append(extBtn, saveBtn);
    bar.append(fileBox, tools, actions); p.body.appendChild(bar);
    const view = mk('div', 'docview dv2-stage');
    if (!info || !info.ok) {
      view.innerHTML = '<div class="docview-empty">Не удалось прочитать файл' + (info && info.error ? ' (' + esc(info.error) + ')' : '') + '. Попробуйте открыть во внешней программе.</div>';
    } else if (info.isImage) {
      const img = document.createElement('img'); img.className = 'docview-img'; img.src = 'data:' + (info.mime || 'image/png') + ';base64,' + info.base64; view.appendChild(img);
    } else if (info.isPdf) {
      // Built-in Electron/Chromium PDF viewer (PDFium). It renders every PDF
      // reliably offline, ships its own toolbar (zoom / print / search) and does
      // NOT depend on any bundled library. `view=FitH` fits the page to the
      // viewport width (Chromium ignores Adobe's `zoom=page-width` keyword, which
      // made the page open tiny with large gray margins).
      view.classList.add('stage-fill');
      let src = 'data:application/pdf;base64,' + info.base64;
      try { const bytes = Uint8Array.from(atob(info.base64), c => c.charCodeAt(0)); src = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); } catch (e) {}
      const fr = document.createElement('iframe'); fr.className = 'docview-frame docview-frame-fill'; fr.src = src + '#toolbar=1&navpanes=0&view=FitH'; view.appendChild(fr);
      const pdfTextBox = mk('div', 'docview-text-tools');
      const showRecognized = (txt) => { const det = document.createElement('details'); det.className = 'docview-text-toggle'; det.open = true; det.innerHTML = '<summary>Показать распознанный текст</summary><pre class="docview-text">' + esc(txt) + '</pre>'; pdfTextBox.appendChild(det); };
      if (info.text && info.text.trim()) {
        showRecognized(info.text);
      } else {
        // Отсканированный PDF без текстового слоя: распознаём по запросу (OCR).
        const hint = mk('div', 'docview-ocr-hint', 'Текстовый слой не найден (похоже, отсканированный PDF).');
        const btn = mk('button', 'btn sm docview-ocr-btn', 'Распознать текст (OCR)');
        btn.onclick = async () => {
          btn.disabled = true; const old = btn.textContent; btn.textContent = 'Распознаётся…';
          try {
            const r = await API.ocrDocument(d.id);
            if (r && r.ok && r.text && r.text.trim()) { hint.remove(); btn.remove(); showRecognized(r.text); }
            else {
              const reasons = { tesseract_not_installed: 'OCR-движок Tesseract не установлен в системе.', no_pdf_rasterizer: 'Для OCR нужен Poppler (pdftoppm) или Ghostscript.', empty: 'Не удалось распознать текст на страницах.', unsupported: 'Тип файла не поддерживается для OCR.' };
              const msg = (r && reasons[r.reason]) || ('Не удалось распознать текст' + (r && r.reason ? ' (' + esc(r.reason) + ')' : '') + '.');
              hint.textContent = msg; btn.textContent = old; btn.disabled = false;
              if (typeof toast === 'function') toast(msg);
              if (r && (r.reason === 'tesseract_not_installed' || r.reason === 'no_pdf_rasterizer') && !pdfTextBox.querySelector('.docview-ocr-note')) {
                const note = mk('div', 'docview-ocr-hint docview-ocr-note', 'OCR не установлен. Закройте приложение и запустите START.bat — компоненты установятся автоматически.');
                pdfTextBox.appendChild(note);
              }
            }
          } catch (e) { btn.textContent = old; btn.disabled = false; if (typeof toast === 'function') toast('Ошибка OCR'); }
        };
        pdfTextBox.appendChild(hint); pdfTextBox.appendChild(btn);
      }
      view.appendChild(pdfTextBox);
    } else if (info.sheets && info.sheets.length) {
      const renderBuiltin = (host) => { host.innerHTML = ''; info.sheets.forEach((sh, i) => { if (info.sheets.length > 1) host.appendChild(mk('div', 'docview-sheet-name', sh.name || ('Лист ' + (i + 1)))); host.appendChild((sh.merges && sh.merges.length) ? buildExcelTable(sh, 400, 60) : buildTable(sh.rows || [], 300, 40)); }); };
      if (window.XLSViewer && window.XLSViewer.mount) {
        const host = mk('div', 'docview-univer'); view.appendChild(host);
        requestAnimationFrame(() => { try { window.XLSViewer.mount(host, info.sheets); } catch (e) { host.className = 'docview'; renderBuiltin(host); } });
      } else { renderBuiltin(view); }
    } else if (info.kind === 'csv' && info.text && info.text.trim()) {
      view.appendChild(buildTable(csvToRows(info.text), 300, 40));
    } else if (info.ext === 'dxf' && info.text && info.text.trim()) {
      if (window.DXFViewer && window.DXFViewer.available) {
        const host = mk('div', 'docview-dxf3d');
        const badge = mk('div', 'dxf-engine', 'three-dxf · точный CAD‑рендер');
        view.appendChild(badge); view.appendChild(host);
        requestAnimationFrame(() => {
          let ok = null;
          try { ok = window.DXFViewer.render(host, info.text, { height: 520 }); } catch (e) { ok = null; }
          if (ok) {
            const det = document.createElement('details'); det.className = 'docview-text-toggle';
            det.innerHTML = '<summary>Показать исходный текст DXF</summary><pre class="docview-text">' + esc(info.text) + '</pre>';
            view.appendChild(det);
          } else {
            badge.remove(); host.remove();
            const w2 = mk('div', 'docview-dxf'); let dn = false;
            try { dn = drawDxf(parseDxf(info.text), w2); } catch (e2) { dn = false; }
            if (dn) view.appendChild(w2); else view.appendChild(mk('pre', 'docview-text', esc(info.text)));
          }
        });
      } else {
      const wrap = mk('div', 'docview-dxf'); let drawn = false;
      try { drawn = drawDxf(parseDxf(info.text), wrap); } catch (e) { drawn = false; }
      if (drawn) { view.appendChild(wrap); const det = document.createElement('details'); det.className = 'docview-text-toggle'; det.innerHTML = '<summary>Показать исходный текст DXF</summary><pre class="docview-text">' + esc(info.text) + '</pre>'; view.appendChild(det); }
      else view.appendChild(mk('pre', 'docview-text', esc(info.text)));
      }
    } else if (info.kind === 'docx' || info.ext === 'docx') {
      const docxTextFallback = () => {
        if (info.text && info.text.trim()) view.appendChild(mk('pre', 'docview-text dv2-doctext', esc(info.text)));
        else view.appendChild(mk('div', 'docview-empty', 'Не удалось показать документ. Откройте во внешней программе.'));
      };
      const docxView = () => {
        if (window.DOCXViewer && window.DOCXViewer.available && info.base64) {
          const host = mk('div', 'docview-docx'); view.appendChild(host);
          let scale = 1;
          const pct = mk('span', 'dv2-pct', '100%');
          const apply = s => { scale = Math.max(0.5, Math.min(2.4, s)); pct.textContent = Math.round(scale * 100) + '%'; host.querySelectorAll('section.docx').forEach(sec => sec.style.setProperty('--docx-zoom', String(scale))); };
          tools.append(toolBtn('zoom-out', 'Меньше', () => apply(scale - 0.1)), pct, toolBtn('zoom-in', 'Больше', () => apply(scale + 0.1)));
          requestAnimationFrame(async () => { try { await window.DOCXViewer.render(host, info.base64); } catch (e) { host.remove(); tools.innerHTML = ''; docxTextFallback(); } });
        } else { docxTextFallback(); }
      };
      const docxEdit = () => {
        if (!(window.DOCXEditor && window.DOCXEditor.available && info.base64)) { docxView(); return; }
        view.className = 'docview dv2-stage stage-fill'; view.innerHTML = ''; tools.innerHTML = '';
        const sdToolbar = mk('div', 'sd-toolbar');
        const editor = mk('div', 'sd-editor');
        tools.appendChild(sdToolbar);
        view.appendChild(editor);
        const saveDocxBtn = mk('button', 'btn sm primary dv2-btn'); saveDocxBtn.innerHTML = (window.ICON ? window.ICON('check', 16) : '') + '<span class="lbl">Сохранить</span>'; saveDocxBtn.disabled = true;
        actions.insertBefore(saveDocxBtn, actions.firstChild);
        let handle = null;
        requestAnimationFrame(async () => {
          try {
            handle = await window.DOCXEditor.mount({ editor, toolbar: sdToolbar, base64: info.base64, name: d.name });
            saveDocxBtn.disabled = false;
            saveDocxBtn.onclick = async () => {
              if (!handle) return;
              saveDocxBtn.disabled = true;
              try {
                const blob = await handle.exportDocx();
                if (blob && API.saveDocument) {
                  const buf = new Uint8Array(await blob.arrayBuffer());
                  let bin = ''; const CH = 8192; for (let o = 0; o < buf.length; o += CH) bin += String.fromCharCode.apply(null, buf.subarray(o, o + CH));
                  const r = await API.saveDocument(d.id, btoa(bin));
                  if (r && r.ok) {
                    toast('Документ сохранён');
                    invalidateComparisonDocument(d);
                    if (current) refreshAutomaticComparisonsForRoom(current.id);
                  } else toast('Не удалось сохранить');
                } else { toast('Экспорт недоступен в этой сборке'); }
              } catch (e) { toast('Не удалось сохранить'); }
              saveDocxBtn.disabled = false;
            };
          } catch (e) {
            view.classList.remove('stage-fill'); view.innerHTML = ''; tools.innerHTML = ''; saveDocxBtn.remove(); docxView();
          }
        });
      };
      // По умолчанию показываем документ в оригинальном виде (настоящая вёрстка страниц Word)
      // через docx-preview — 100% масштаб, без обрезки справа (горизонтальная прокрутка).
      // Кнопка «Редактировать» переключает на редактор SuperDoc при необходимости правок.
      docxView();
      if (window.DOCXEditor && window.DOCXEditor.available && info.base64) {
        const editBtn = mk('button', 'btn sm dv2-btn'); editBtn.innerHTML = '<span class="lbl">Редактировать</span>';
        editBtn.onclick = () => { editBtn.remove(); docxEdit(); };
        actions.insertBefore(editBtn, actions.firstChild);
      }
    } else if (info.ext === 'dwg') {
      const host = mk('div', 'docview-dxf3d'); host.innerHTML = '<div class="docview-loading">Открытие чертежа DWG…</div>'; view.appendChild(host);
      const dwgEmpty = () => { host.className = 'docview-empty dv2-empty'; host.innerHTML = '<div class="dv-big">' + docIcon(d) + '</div><div class="dv2-empty-t">Не удалось открыть чертёж .dwg</div><div class="dv2-empty-s">Файл сохранён. Откройте его во внешней программе (AutoCAD и т.п.) или сохраните как .dxf.</div>'; };
      const renderDxf = (dxf, via) => {
        host.innerHTML = ''; host.className = 'docview-dxf3d';
        const badge = mk('div', 'dxf-engine', 'DWG → DXF · ' + esc(via)); view.insertBefore(badge, host);
        let ok = null;
        if (window.DXFViewer && window.DXFViewer.available) { try { ok = window.DXFViewer.render(host, dxf, { height: 520 }); } catch (e) { ok = null; } }
        if (!ok) { let dn = false; try { dn = drawDxf(parseDxf(dxf), host); } catch (e) { dn = false; } if (!dn) { badge.remove(); dwgEmpty(); return false; } }
        return true;
      };
      (async () => {
        if (window.DWGViewer && window.DWGViewer.available && info.base64) {
          try {
            const dxf = await window.DWGViewer.toDxf(info.base64);
            if (dxf && String(dxf).trim() && renderDxf(dxf, 'libredwg (WASM)')) return;
          } catch (e) { /* fall through to external converter */ }
        }
        let conv = null;
        try { conv = API.convertDwg ? await API.convertDwg(d.id) : null; } catch (e) { conv = null; }
        if (conv && conv.ok && conv.dxf && String(conv.dxf).trim() && renderDxf(conv.dxf, conv.via || 'конвертация')) return;
        dwgEmpty();
      })();
    } else if (info.text && info.text.trim()) {
      view.appendChild(mk('pre', 'docview-text', esc(info.text)));
    } else {
      view.innerHTML = '<div class="docview-empty"><div class="dv-big">' + docIcon(d) + '</div>Этот формат' + (info.ext ? ' (.' + esc(info.ext) + ')' : '') + ' нельзя показать внутри приложения.<br>Файл сохранён — нажмите «Открыть во внешней программе», чтобы посмотреть его в профильной программе (AutoCAD, Revit, Word и т.п.).</div>';
    }
    p.body.appendChild(view);
  }
  async function readModelBuffer(file) {
    // 1) Electron: у выбранного/перетащенного файла есть реальный путь — читаем в главном процессе (надёжно для больших LAS/облаков точек).
    const p = selectedFilePath(file);
    if (p && API && API.readPicked) {
      try { const r = await API.readPicked(p); if (r && r.ok && r.base64 != null) return b64ToU8(r.base64).buffer; if (r && r.error) console.warn('readPicked', r.error); } catch (e) { console.warn('readPicked', e); }
    }
    // 2) Нативный Blob.arrayBuffer() — устойчивее старого FileReader.
    if (file && typeof file.arrayBuffer === 'function') { try { return await file.arrayBuffer(); } catch (e) { console.warn('arrayBuffer', e); } }
    // 3) Fallback: FileReader.
    return await fileToArrayBuffer(file);
  }
  var lastCloudOffset = null;  // смещение центрирования последнего облака (для выравнивания станций E57)
  var lastCloudPath = null;    // путь к файлу последнего .las облака (для потокового octree, пункт 4)
  var lastCloudCount = 0;      // число точек последнего облака (выбор: полный буфер vs стриминг)
  var activeOctreeDir = null;  // временный дисковый индекс текущего stream-сеанса
  var octreeNodeErrorToastAt = 0;
  window.addEventListener('bim-octree-node-error', function () {
    const now = Date.now();
    if (now - octreeNodeErrorToastAt < 4000) return;
    octreeNodeErrorToastAt = now;
    toast('Не удалось подгрузить часть облака. Проверьте временный диск; переместите камеру или выключите/включите LOD для повтора.');
  });
  async function releaseActiveOctreeStore() {
    const dir = activeOctreeDir;
    activeOctreeDir = null;
    if (!dir || !API || typeof API.deleteOctree !== 'function') return { ok: !dir, skipped: !!dir };
    try { return await API.deleteOctree({ dir }); }
    catch (error) { return { ok: false, error: String(error && error.message || error) }; }
  }
  window.addEventListener('bim-cloud-change', function () {
    if (typeof window.__bimRefreshQuality === 'function') {
      try { window.__bimRefreshQuality(); } catch (_) {}
    }
    if (activeOctreeDir && !(viewer && viewer.octreeActive && viewer.octreeActive())) {
      releaseActiveOctreeStore().then(result => {
        if (result && result.ok === false) console.warn('octree cleanup', result.error || 'failed');
      });
    }
  });
  function resetProjectCloudContext() {
    lastCloudOffset = null;
    lastCloudPath = null;
    lastCloudCount = 0;
    pendingCloudPath = null;
    try { if (cloudCacheMap) cloudCacheMap.clear(); cloudCacheBytes = 0; } catch (_) {}
  }
  window.addEventListener('bim-project-cloud-restored', function (event) {
    var detail = event && event.detail || {};
    lastCloudPath = detail.path || null;
    lastCloudCount = Number(detail.count) || 0;
    lastCloudOffset = detail.meta && detail.meta.offset || null;
    try {
      var active = window.MultiCloud && window.MultiCloud.getActive && window.MultiCloud.getActive();
      var v = viewer;
      if (active && active.path && window.PCEdit && v && v.base && v.base[0]) {
        cacheCloud(active.path, {
          pos: v.base[0].pos, col: v.base[0].col || null,
          intensity: v._intensityValues || null, classification: v._classificationLabels || null,
          meta: Object.assign({}, detail.meta || {}, { srcXform: v._srcXform || null, crsWkt: v._srcCrs || null }),
          count: detail.count
        });
      }
    } catch (_) {}
  });
  // RAM-кеш облаков проекта: держим разобранные точки резидентно в оперативке (по пути к файлу),
  // чтобы переключение между помещениями и повторный показ были мгновенными — без чтения/парсинга с диска.
  var cloudCacheMap = new Map();          // path -> { pos, col, intensity, classification, meta, count, bytes, used }
  var cloudCacheBytes = 0;                 // суммарный объём кеша облаков (байт)
  var cloudCacheSeq = 0;                    // счётчик LRU
  var cacheRamGiB = Number(window.navigator && window.navigator.deviceMemory);
  if (!Number.isFinite(cacheRamGiB) || cacheRamGiB <= 0) cacheRamGiB = 8; // безопасная оценка, если браузер не сообщает RAM
  var GIB = 1024 * 1024 * 1024;
  var CLOUD_CACHE_MAX_BYTES = Math.min(GIB, cacheRamGiB * 0.125 * GIB);
  var octNodeCacheMaxBytes = Math.min(0.5 * GIB, cacheRamGiB * 0.0625 * GIB);
  var perfMax = false;                     // активен ли профиль «Максимум памяти/качество»
  var _preloading = false, _preloadKicked = false;
  function _evictCloudCache(protectPath) {
    while (cloudCacheBytes > CLOUD_CACHE_MAX_BYTES && cloudCacheMap.size > 1) {
      let oldestKey = null, oldestUsed = Infinity;
      for (const [k, v] of cloudCacheMap) { if (k === protectPath) continue; if (v.used < oldestUsed) { oldestUsed = v.used; oldestKey = k; } }
      if (oldestKey == null) break;
      const e = cloudCacheMap.get(oldestKey); cloudCacheBytes -= e.bytes; cloudCacheMap.delete(oldestKey);
    }
  }
  function cacheCloud(path, pr) {
    try {
      if (!path || !pr || pr.kind === 'mesh' || !pr.pos || !pr.pos.length) return;
      if (cloudCacheMap.has(path)) { const old = cloudCacheMap.get(path); cloudCacheBytes -= old.bytes; cloudCacheMap.delete(path); }
      const count = Math.min(Number.isSafeInteger(pr.count) && pr.count >= 0 ? pr.count : Math.floor(pr.pos.length / 3), Math.floor(pr.pos.length / 3));
      const pos = pr.pos.slice(0, count * 3);
      const col = pr.col && pr.col.length >= count * 3 ? pr.col.slice(0, count * 3) : null;
      const intensity = pr.intensity && pr.intensity.length >= count ? pr.intensity.slice(0, count) : null;
      const classification = pr.classification && pr.classification.length >= count ? pr.classification.slice(0, count) : null;
      const bytes = pos.byteLength + (col ? col.byteLength : 0) + (intensity ? intensity.byteLength : 0) + (classification ? classification.byteLength : 0);
      cloudCacheMap.set(path, { pos: pos, col: col, intensity: intensity, classification: classification, meta: pr.meta || {}, count: count, bytes: bytes, used: ++cloudCacheSeq });
      cloudCacheBytes += bytes; _evictCloudCache(path);
    } catch (e) { console.warn('cacheCloud', e); }
  }
  function showCloudFromCache(path) {
    const c = path && cloudCacheMap.get(path);
    if (!c || !c.pos) return false;
    try {
      c.used = ++cloudCacheSeq;
      // Отдаём вьюеру собственные копии всех атрибутов, чтобы перемешивание/
      // правки не портили кеш и возврат из disk-LOD не терял intensity/class.
      viewer.loadCloud({
        pos: c.pos.slice(), col: c.col ? c.col.slice() : null,
        intensity: c.intensity ? c.intensity.slice() : null,
        classification: c.classification ? c.classification.slice() : null,
        meta: c.meta, count: c.count || c.pos.length / 3
      }, { sourceName:path });
      return true;
    } catch (e) { console.warn('showCloudFromCache', e); return false; }
  }
  // Предзагрузка всех облаков проекта в RAM (в фоне, по бюджету) — переключение между помещениями становится моментальным.
  async function preloadProjectClouds() {
    if (_preloading || !CAN_PERSIST || !API || !API.getModelPath || !API.parseCloud || !DB || !DB.rooms) return;
    _preloading = true;
    try {
      for (const room of DB.rooms) {
        if (cloudCacheBytes > CLOUD_CACHE_MAX_BYTES) break;
        let p = null; try { p = await API.getModelPath(room.id); } catch (e) { continue; }
        if (!p || !/\.las$/i.test(p) || cloudCacheMap.has(p)) continue;
        try { const pr = await API.parseCloud(p); if (pr && pr.ok && pr.kind !== 'mesh') cacheCloud(p, pr); } catch (e) { console.warn('preload', e); }
        await new Promise(r => setTimeout(r, 40)); // не блокируем интерфейс
      }
    } finally { _preloading = false; }
  }
  // Профиль «Максимум памяти/качество» (32 ГБ + RTX 5070): расширяем бюджеты RAM и детализацию при движении.
  function applyPerfProfile(max) {
    perfMax = !!max;
    // Бюджеты привязаны к RAM-профилю браузера и оставляют место Electron,
    // renderer/GPU и исходным массивах; профиль «Максимум» включается явно.
    CLOUD_CACHE_MAX_BYTES = Math.min((perfMax ? 8 : 1) * GIB, cacheRamGiB * (perfMax ? 0.5 : 0.125) * GIB);
    octNodeCacheMaxBytes = Math.min((perfMax ? 4 : 0.5) * GIB, cacheRamGiB * (perfMax ? 0.25 : 0.0625) * GIB);
    try { if (viewer && viewer.setPerfProfile) viewer.setPerfProfile(perfMax ? 'max' : 'balanced'); if (viewer && viewer.setMaxQuality) viewer.setMaxQuality(perfMax); } catch (e) { }
    if (perfMax) preloadProjectClouds();
  }
  async function loadModelFile(file) {
    if (!current) { toast('Сначала выберите помещение'); return; }
    toast('Открываю 3D: ' + file.name + ' (' + fmtSize(file.size) + ') …');
    const localPath = selectedFilePath(file);
    let r = null;
    // HQ-облако через Potree (LOD/EDL как в CloudCompare). Активно только если собран
    // бандл Potree И у пользователя установлен внешний PotreeConverter; иначе — обычный путь.
    if (localPath && /\.(las|laz)$/i.test(file.name) && window.PotreeView && window.PotreeView.available && API && API.potreeStatus && API.convertPotree) {
      try {
        const st = await API.potreeStatus();
        if (st && st.converter) {
          const potHost = document.querySelector('.stage');
          if (potHost) {
            toast('Potree: конвертация облака (один раз)…');
            const cv = await API.convertPotree(localPath);
            if (cv && cv.ok && cv.url) {
              window.PotreeView.mount(potHost, { onExit: () => { try { potHost.style.display = 'none'; } catch (_) {} } });
              const okp = await window.PotreeView.loadPotree(cv.url);
              if (okp) {
                lastCloudPath = localPath; $('btnBackRoom').style.display = '';
                if (CAN_PERSIST && localPath && API.readPicked) { try { await API.uploadModel({ roomId: current.id, name: file.name, mime: file.type || '', srcPath: localPath }); } catch (_) {} }
                toast('Облако (Potree HQ) · ' + file.name); return;
              }
              console.warn('[potree] render failed, falling back to built-in viewer');
            } else if (cv && cv.error && cv.error !== 'no_converter') { console.warn('[potree] convert error', cv.error); }
          }
        }
      } catch (e) { console.warn('[potree] HQ path failed, fallback', e); }
    }
    // Большие облака точек .las парсим в главном процессе прямо с диска — без лимитов памяти рендерера.
    if (localPath && API && API.parseCloud && /\.(las|laz|ply|e57|ptx|pcd|xyz|pts|txt|csv|xyzrgb)$/i.test(file.name)) {
      let pr = null;
      try { pr = await parseCloudWithProgress(localPath, file.name); } catch (e) { console.warn('parseCloud', e); }
      if (pr && pr.ok) {
        try { if (pr.kind === 'mesh') viewer.loadColoredMesh(pr); else { viewer.loadCloud(pr, {sourceName:localPath || file.name}); cacheCloud(localPath, pr); } r = { ok: true, kind: pr.kind, meta: pr.meta }; lastCloudOffset = (pr.meta && pr.meta.offset) || null; lastCloudPath = localPath; lastCloudCount = (pr.meta && pr.meta.points) || 0; }
        catch (e) { console.warn('render-cloud', e); toast('Ошибка 3D: ' + (e && e.message ? e.message : 'не удалось показать')); return; }
      } else if (pr && pr.fallback) { /* PLY mesh: use the full renderer parser below. */ }
      else if (pr && pr.message) { toast(pr.message); return; }
    }
    if (!r) {
      let buf; try { buf = await readModelBuffer(file); } catch (e) { console.warn('read', e); toast('Не удалось прочитать файл: ' + (e && e.message ? e.message : 'ошибка') + ' · ' + fmtSize(file.size)); return; }
      if (!buf || !buf.byteLength) { toast('Файл пустой или недоступен · ' + fmtSize(file.size)); return; }
      try { r = await load3DBuffer(file.name, buf); }
      catch (e) { console.warn('model', e); toast('Ошибка 3D: ' + (e && e.message ? e.message : 'не удалось открыть')); return; }
      if (!r.ok) { toast(r.message || 'Не удалось открыть модель'); return; }
      // v1091: сохраняем PLY-буфер для конвертера PLY→3DGS
      if (/\.ply$/i.test(file.name) && r.kind === 'points' && window.PlyToSplat) {
        window._lastLidarPlyBuf = buf;
        window._lastLidarPlyName = file.name;
        const convBtn = document.getElementById('tsConv3dgs');
        if (convBtn) convBtn.style.display = '';
      }
    }
    $('btnBackRoom').style.display = '';
    const isCloud = r.kind === 'points';
    if (!isCloud && r.kind !== 'mesh-overlay') await applyModelDims(current, 'force');
    if (CAN_PERSIST) {
      try {
        if (localPath && API.readPicked) { await API.uploadModel({ roomId: current.id, name: file.name, mime: file.type || '', srcPath: localPath }); }
        else { const base64 = await fileToBase64(file); await API.uploadModel({ roomId: current.id, name: file.name, mime: file.type || '', base64 }); }
      } catch (e) { console.warn('save-model', e); toast('Модель показана, но не сохранена: ' + (e && e.message ? e.message : 'ошибка')); }
    }
    if (isCloud && r.meta) { const pts = (r.meta.points || 0).toLocaleString('ru'); toast('Облако точек · ' + pts + ' точек' + (r.meta.colored ? '' : ' · цвет по высоте')); }
    else if (r.kind === 'mesh-overlay') {
      toast('Меш ' + file.name + ' открыт · ' + Number(r.triangles || 0).toLocaleString('ru-RU') + ' треугольников' + meshWarningSummary(r.warnings, r.metadata));
    }
    else if (CAN_PERSIST) toast('Модель · ' + (current.area_m2 || 0) + ' м² · выс. ' + (current.height_m || 0) + ' м');
    else toast('Демо · ' + (current.area_m2 || 0) + ' м² · выс. ' + (current.height_m || 0) + ' м');
  }

  // ---------- CRUD UI ----------
  async function refresh(preserveId) { if (CAN_PERSIST) { DB = await API.getData(); normalize(DB); } const id = preserveId || (current && current.id); renderTree(); if (id && findRoom(id)) openRoom(id); else if (DB.rooms[0]) openRoom(DB.rooms[0].id); }

  async function createFloorUI() { const v = await openForm('Новая папка (этаж)', [{ k: 'name', label: 'Название', value: '' }]); if (!v || !v.name) return; const num = DB.floors.length + 1; if (CAN_PERSIST) await API.createFloor({ name: v.name, number: num }); else DB.floors.push({ id: 'floor_' + Date.now(), project_id: DB.project.id, name: v.name, number: num }); await refresh(); toast('Этаж добавлен'); }
  async function editFloorUI(f) { const v = await openForm('Этаж', [{ k: 'name', label: 'Название', value: f.name }, { k: 'number', label: 'Номер', value: f.number, type: 'number' }]); if (!v) return; if (CAN_PERSIST) await API.updateFloor(f.id, { name: v.name, number: Number(v.number) }); else Object.assign(f, { name: v.name, number: Number(v.number) }); await refresh(); }
  async function deleteFloorUI(f) { if (!await confirmBox('Удалить этаж «' + f.name + '» со всеми помещениями?')) return; if (CAN_PERSIST) await API.deleteFloor(f.id); else { DB.floors = DB.floors.filter(x => x.id !== f.id); DB.rooms = DB.rooms.filter(r => r.floor_id !== f.id); } await refresh(); toast('Этаж удалён'); }

  async function createRoomUI(floorId) { const v = await openForm('Новая папка (помещение)', [{ k: 'name', label: 'Название', value: '' }]); if (!v || !v.name) return; const patch = { name: v.name, number: '', type: '', area_m2: 12, height_m: 3 }; if (CAN_PERSIST) await API.createRoom(floorId, patch); else DB.rooms.push(Object.assign({ id: 'room_' + Date.now(), floor_id: floorId, elements: [], documents: [], findings: [], status: 'проект' }, patch)); await refresh(); toast('Помещение добавлено'); }
  async function editRoomUI(r) { const v = await openForm('Переименовать папку', [{ k: 'name', label: 'Название', value: r.name }]); if (!v || !v.name) return; const patch = { name: v.name }; if (CAN_PERSIST) await API.updateRoom(r.id, patch); else Object.assign(r, patch); await refresh(r.id); }
  async function deleteRoomUI(r) { if (!await confirmBox('Удалить помещение «' + r.name + '»?')) return; if (CAN_PERSIST) await API.deleteRoom(r.id); else DB.rooms = DB.rooms.filter(x => x.id !== r.id); current = null; await refresh(); toast('Помещение удалено'); }

  async function createElementUI(roomId) { const v = await openForm('Новый элемент', [{ k: 'name', label: 'Имя', value: '' }, { k: 'type', label: 'Тип', value: 'оборудование', type: 'select', options: EL_TYPES }]); if (!v) return; const patch = { name: v.name, type: v.type, ai_status: 'none' }; if (CAN_PERSIST) await API.createElement(roomId, patch); else current.elements.push(Object.assign({ id: 'el_' + Date.now(), ifc_guid: 'guid_' + Date.now() }, patch)); await refresh(roomId); toast('Элемент добавлен'); }
  async function editElementUI(e) { const v = await openForm('Элемент', [{ k: 'name', label: 'Имя', value: e.name }, { k: 'type', label: 'Тип', value: e.type, type: 'select', options: EL_TYPES }]); if (!v) return; const patch = { name: v.name, type: v.type }; if (CAN_PERSIST) await API.updateElement(e.id, patch); else Object.assign(e, patch); const rid = current.id; await refresh(rid); selectEl(e.id); }
  async function deleteElementUI(e) { if (!await confirmBox('Удалить элемент «' + e.name + '»?')) return; const rid = current.id; if (CAN_PERSIST) await API.deleteElement(e.id); else current.elements = current.elements.filter(x => x.id !== e.id); selEl = null; await refresh(rid); toast('Элемент удалён'); }

  async function createDocumentUI() { const v = await openForm('Новый документ', [{ k: 'name', label: 'Название', value: '' }, { k: 'type', label: 'Тип', value: 'документ' }, { k: 'version', label: 'Версия', value: 'v1' }, { k: 'author', label: 'Автор', value: '' }]); if (!v) return; const patch = { room_id: current.id, element_id: selEl && selEl.id, name: v.name, type: v.type, version: v.version, author: v.author, date: new Date().toISOString().slice(0, 10) }; if (CAN_PERSIST) { const d = await API.createDocument(patch); current.documents.push(d); } else current.documents.push(Object.assign({ id: 'doc_' + Date.now(), is_upload: 0, versions: [] }, patch)); renderTab(); toast('Документ добавлен'); }
  async function deleteDocUI(d) {
    if (!await confirmBox('Удалить документ «' + d.name + '»?')) return;
    const roomId = current && current.id;
    if (CAN_PERSIST) await API.deleteDocument(d.id);
    invalidateComparisonDocument(d);
    current.documents = current.documents.filter(x => x.id !== d.id);
    renderTab(); toast('Документ удалён');
    if (roomId) refreshAutomaticComparisonsForRoom(roomId);
  }

  // ---------- generic form modal ----------
  function openForm(title, fields) {
    return new Promise(res => {
      const bg = $('formModal'); $('formTitle').textContent = title;
      const body = $('formBody'); body.innerHTML = '';
      const inputs = {};
      for (const f of fields) {
        const row = mk('div', 'formrow'); row.appendChild(mk('label', '', f.label));
        let inp;
        if (f.type === 'select') { inp = document.createElement('select'); for (const o of f.options) { const op = document.createElement('option'); op.value = o; op.textContent = o; if (o === f.value) op.selected = true; inp.appendChild(op); } }
        else { inp = document.createElement('input'); inp.type = f.type || 'text'; inp.value = f.value != null ? f.value : ''; }
        row.appendChild(inp); body.appendChild(row); inputs[f.k] = inp;
      }
      bg.classList.add('open');
      const first = body.querySelector('input,select'); if (first) setTimeout(() => first.focus(), 30);
      const close = ok => { bg.classList.remove('open'); $('formOk').onclick = null; $('formCancel').onclick = null; if (!ok) return res(null); const out = {}; for (const k in inputs) out[k] = inputs[k].value; res(out); };
      $('formOk').onclick = () => close(true); $('formCancel').onclick = () => close(false);
    });
  }
  function confirmBox(msg) {
    return new Promise(res => {
      const bg = $('formModal'); $('formTitle').textContent = msg; $('formBody').innerHTML = '';
      bg.classList.add('open');
      const close = v => { bg.classList.remove('open'); $('formOk').onclick = null; $('formCancel').onclick = null; res(v); };
      $('formOk').onclick = () => close(true); $('formCancel').onclick = () => close(false);
    });
  }
  let toastT = null;
  function toast(msg, opts) {
    try { bimLog('toast', msg); } catch (e) {}
    if (window.__lxKit && window.__lxKit.toast) { window.__lxKit.toast(msg, opts); return; }
    const t = $('toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200);
  }
  window.__toast = function (msg, kind) { toast((kind === 'error' ? 'Ошибка: ' : '') + String(msg || ''), { tone: kind === 'error' ? 'err' : kind === 'warn' ? 'warn' : kind === 'ok' ? 'ok' : undefined }); };
  // Подпись кнопки с иконкой: меняем только текст (и, при необходимости, значок), не разрушая разметку
  function setLbl(btn, text, ico) {
    if (!btn) return;
    const l = btn.querySelector('.lbl');
    if (l) l.textContent = text; else btn.textContent = text;
    if (ico) {
      const i = btn.querySelector('[data-ico]');
      if (i && i.getAttribute('data-ico') !== ico) { i.setAttribute('data-ico', ico); if (window.__lxKit) window.__lxKit.hydrate(btn); }
    }
  }

  // ---------- edit mode + backup ----------
  function setEditing(on) { editing = on; document.body.classList.toggle('editing', on); $('btnEdit').classList.toggle('on', on); $('btnBackup').style.display = on ? '' : 'none'; (function(){var _be=$('btnEdit');var _bl=_be.querySelector('.lx-blabel, .lbl')||_be;_bl.textContent = on ? 'Готово' : 'Правка';})(); renderTree(); if (current) { renderElbar(); renderTab(); } }
  async function doBackup() { if (!CAN_PERSIST) { const blob = new Blob([JSON.stringify(DB, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'bim-backup.json'; a.click(); toast('Бэкап скачан'); return; } const p = await API.exportBackup(); toast('Бэкап сохранён: ' + p); }

  // ---------- compare ----------
  function openCompare() {
    const modal = $('cmpModal'); const pick = $('cmpPick'); const result = $('cmpResult');
    pick.innerHTML = ''; result.innerHTML = ''; const chosen = [];
    for (const r of DB.rooms) { const c = mk('span', 'chip', r.name); c.onclick = () => { const i = chosen.indexOf(r.id); if (i >= 0) { chosen.splice(i, 1); c.classList.remove('sel'); } else { if (chosen.length >= 4) { toast('Максимум 4'); return; } chosen.push(r.id); c.classList.add('sel'); } draw(); }; pick.appendChild(c); }
    function draw() {
      if (chosen.length < 2) { result.innerHTML = '<div class="empty">Выберите 2–4 помещения</div>'; return; }
      const rs = chosen.map(findRoom);
      const metrics = [['Площадь, м²', r => r.area_m2 || 0], ['Высота, м', r => r.height_m || 0], ['Элементов', r => r.elements.length], ['Документов', r => (r.documents || []).length], ['Ошибки НС', r => roomErrCount(r)], ['На проверке', r => roomWarnCount(r)]];
      let html = '<table class="cmp"><tr><th>Параметр</th>' + rs.map(r => '<th>' + esc(r.name) + '</th>').join('') + '</tr>';
      for (const [label, fn] of metrics) { const vals = rs.map(fn); const uniq = new Set(vals.map(String)); const diff = uniq.size > 1; html += '<tr><td>' + label + '</td>' + vals.map(v => '<td class="' + (diff ? 'diff' : '') + '">' + v + '</td>').join('') + '</tr>'; }
      html += '</table>'; result.innerHTML = html;
    }
    draw(); modal.classList.add('open');
  }

  // ---------- Phase B: 3D-инструменты и импорт IFC ----------
  function toolsOK() { if (viewer && viewer.supportsTools) return true; toast('Инструмент доступен в 3D‑режиме (WebGL)'); return false; }
  function syncLODControl() {
    const supported = !!(viewer && viewer.supportsLOD && viewer.supportsLOD());
    const active = supported && !!viewer.lod;
    const title = supported ? 'LOD: уменьшить детализацию полигональной модели' : 'LOD доступен только для полигональных моделей; для облаков точек режим пока не реализован';
    const btn = $('btnLOD');
    if (btn) { btn.disabled = !supported; btn.setAttribute('aria-disabled', String(!supported)); btn.setAttribute('aria-pressed', String(active)); btn.classList.toggle('on', active); btn.title = title; }
  }
  // v0.9.29: ViewCube (стандартные виды), плавающая панель инструментов, режим прогулки
  function wireViewerExtras() {
    const vc = document.getElementById('viewCube');
    if (vc) {
      const setActive = b => { vc.querySelectorAll('.vc').forEach(x => x.classList.toggle('active', x === b)); };
      const iso0 = vc.querySelector('[data-view="iso"]'); if (iso0) setActive(iso0);
      vc.addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (!b) return; setActive(b); if (viewer && viewer.setStandardView) viewer.setStandardView(b.getAttribute('data-view')); });
    }
    const ft = $('vtFit'); if (ft) ft.addEventListener('click', () => { if (viewer && viewer.resetView) viewer.resetView(); });
    const zi = $('vtZoomIn'); if (zi) zi.addEventListener('click', () => { if (viewer && viewer.zoomBy) viewer.zoomBy(0.82); });
    const zo = $('vtZoomOut'); if (zo) zo.addEventListener('click', () => { if (viewer && viewer.zoomBy) viewer.zoomBy(1.22); });
    // Патч 30: панель «Качество облака» — цвет RGB/высота, яркость, размер точки, плотность, EDL
    const qBtn = $('vtQuality'); const qBar = $('qualityBar');
    if (qBtn && qBar) qBtn.addEventListener('click', () => { const on = !qBtn.classList.contains('on'); qBtn.classList.toggle('on', on); qBar.style.display = on ? 'flex' : 'none'; });
    window.__bimRefreshQuality = refreshQualityButtons;
    const qColor = $('qColor');
    const colorModeLabels = { rgb:'RGB', elev:'Высота', intensity:'Интенсивность', classification:'Классификация' };
    function refreshColorModeButton() {
      if (!qColor || !viewer) return;
      const mode = viewer.getColorMode ? viewer.getColorMode() : (viewer._ptElev ? 'elev' : 'rgb');
      const modes = viewer.getAvailableColorModes ? viewer.getAvailableColorModes() : ['rgb','elev'];
      setLbl(qColor, colorModeLabels[mode] || 'RGB');
      qColor.title = 'Нажмите для переключения доступных режимов: ' +
        modes.map(value => colorModeLabels[value] || value).join(' → ');
      qColor.setAttribute('aria-label', 'Режим окраски облака: ' + (colorModeLabels[mode] || 'RGB'));
    }
    if (qColor) qColor.addEventListener('click', () => {
      if (!viewer || !viewer.setColorMode) { toast('Цветовой режим доступен в 3D-режиме (WebGL)'); return; }
      const modes = viewer.getAvailableColorModes ? viewer.getAvailableColorModes() : ['rgb','elev'];
      const current = viewer.getColorMode ? viewer.getColorMode() : (viewer._ptElev ? 'elev' : 'rgb');
      const index = Math.max(0, modes.indexOf(current));
      const mode = modes[(index + 1) % modes.length] || 'rgb';
      try {
        viewer.setColorMode(mode);
        refreshColorModeButton();
        toast(mode === 'intensity'
          ? 'Окраска по интенсивности (шкала серого)'
          : mode === 'classification'
            ? 'Окраска по классу точки'
            : mode === 'elev'
              ? 'Цвет по высоте'
              : 'Цвет RGB — как снимал сканер');
      } catch (error) {
        toast(String(error && error.message || error));
      }
    });
    const qBright = $('qBright');
    if (qBright) qBright.addEventListener('input', () => { if (viewer && viewer.setBrightness) viewer.setBrightness(parseFloat(qBright.value)); });
    const qSize = $('qSize');
    if (qSize) qSize.addEventListener('input', () => { if (viewer && viewer.setPointSizeScale) viewer.setPointSizeScale(parseFloat(qSize.value)); });
    function refreshQualityButtons() {
      if (!viewer) return;
      refreshColorModeButton();const qb=$('qBright');if(qb && document.activeElement!==qb)qb.value=viewer._ptBright;const qg=$('qGrade');if(qg)qg.classList.toggle('on',!!viewer._grade?.on);
      const qE = $('qEDL'); if (qE) { const e = !!viewer._edl; qE.classList.toggle('on', e); }
      const qA = $('qAtten'); if (qA && viewer.attenuateOn) { const a = viewer.attenuateOn(); qA.classList.toggle('on', a); }
      const qD = $('qDense'); if (qD && viewer.denseFillOn) { const d = viewer.denseFillOn(); qD.classList.toggle('on', d); }
      const qF = $('qFrame'); if (qF && viewer.frameOn) { const f = viewer.frameOn(); qF.classList.toggle('on', f); }
      const qP = $('qPhoto'); if (qP && viewer.photoOn) { const p = viewer.photoOn(); qP.classList.toggle('on', p); }
    }
    const qEDL = $('qEDL');
    if (qEDL) qEDL.addEventListener('click', () => { if (!viewer || !viewer.setEDL) { toast('EDL доступен в 3D-режиме (WebGL)'); return; } const on = !qEDL.classList.contains('on'); const ok = viewer.setEDL(on); if (on && !ok) { toast('EDL недоступен на этом GPU — оставляю обычный рендер'); qEDL.classList.remove('on'); return; } qEDL.classList.toggle('on', on); toast(on ? 'EDL включён — объём и резкость облака' : 'EDL выключен'); });
    const qPhoto = $('qPhoto');
    if (qPhoto) qPhoto.addEventListener('click', () => { if (!viewer || !viewer.setPhoto) { toast('Фото-режим доступен в 3D-режиме (WebGL)'); return; } const on = !qPhoto.classList.contains('on'); const r = viewer.setPhoto(on); qPhoto.classList.toggle('on', !!r); if (qEDL) { const e = !!viewer._edl; qEDL.classList.toggle('on', e); } toast(r ? 'Фото-качество включено' : 'Фото-качество выключено'); });
    const qGrade = $('qGrade');
    if (qGrade) qGrade.addEventListener('click', () => {
      if (!viewer || !viewer.setGrade) { toast('Доступно в 3D-режиме (WebGL)'); return; }
      const g = viewer.getGrade ? viewer.getGrade() : { on: true, exposure: 1.06, contrast: 1.14, saturation: 1.22, gamma: 1.02, tone: 0.85 };
      const p = modalPanel('Фотореализм · цветокоррекция');
      const gRow = (label, min, max, step, val, key, fmt) => {
        const row = mk('div', ''); row.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin:10px 0';
        const top = mk('div', ''); top.style.cssText = 'display:flex;justify-content:space-between;font-size:13px;color:var(--txt)';
        const lab = mk('span', '', esc(label)); const vEl = mk('span', '', esc(fmt(val))); vEl.style.cssText = 'color:var(--accent);font-variant-numeric:tabular-nums';
        top.append(lab, vEl);
        const inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = val; inp.style.cssText = 'width:100%';
        inp.addEventListener('input', () => { const v = parseFloat(inp.value); vEl.textContent = fmt(v); const o = {}; o[key] = v; viewer.setGrade(o); });
        row.append(top, inp); p.body.appendChild(row); return inp;
      };
      const onWrap = mk('label', ''); onWrap.style.cssText = 'display:flex;gap:8px;align-items:center;font-size:13px;color:var(--txt);margin-bottom:4px';
      const onChk = document.createElement('input'); onChk.type = 'checkbox'; onChk.checked = !!g.on;
      onChk.addEventListener('change', () => { viewer.setGrade(onChk.checked); qGrade.classList.toggle('on', onChk.checked); toast(onChk.checked ? 'Фотореализм включён' : 'Фотореализм выключен'); });
      onWrap.append(onChk, mk('span', '', 'Включить фотореализм')); p.body.appendChild(onWrap);
      gRow('Экспозиция (яркость света)', 0.5, 2.0, 0.02, g.exposure != null ? g.exposure : 1.06, 'exposure', v => '×' + v.toFixed(2));
      gRow('Откат пересветов (белый потолок/окна)', 0, 1, 0.05, g.tone != null ? g.tone : 0.85, 'tone', v => Math.round(v * 100) + '%');
      gRow('Контраст', 0.6, 1.8, 0.02, g.contrast != null ? g.contrast : 1.14, 'contrast', v => '×' + v.toFixed(2));
      gRow('Насыщенность цвета', 0, 2, 0.02, g.saturation != null ? g.saturation : 1.22, 'saturation', v => '×' + v.toFixed(2));
      gRow('Гамма', 0.6, 1.6, 0.02, g.gamma != null ? g.gamma : 1.02, 'gamma', v => v.toFixed(2));
      const btns = mk('div', ''); btns.style.cssText = 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap';
      const bReset = mk('button', 'btn sm', 'Сбросить');
      bReset.onclick = () => { viewer.setGrade({ on: true, exposure: 1.06, contrast: 1.14, saturation: 1.22, gamma: 1.02, tone: 0.85 }); p.close(); qGrade.classList.add('on'); toast('Настройки реализма сброшены'); };
      const bClose = mk('button', 'btn sm primary', 'Готово');
      bClose.onclick = () => p.close();
      btns.append(bReset, bClose); p.body.appendChild(btns);
    });
    const qAtten = $('qAtten');
    if (qAtten) qAtten.addEventListener('click', () => { if (!viewer || !viewer.setAttenuate) { toast('Доступно в 3D-режиме (WebGL)'); return; } const toGrow = !(viewer.attenuateOn && viewer.attenuateOn()); const on = viewer.setAttenuate(toGrow); qAtten.classList.toggle('on', on); toast(on ? 'Размер точки растёт при приближении' : 'Постоянный размер точки — как в CloudCompare'); });
    const qDense = $('qDense');
    if (qDense) qDense.addEventListener('click', () => { if (!viewer || !viewer.setDenseFill) { toast('Доступно в 3D-режиме (WebGL)'); return; } const on = viewer.setDenseFill(!qDense.classList.contains('on')); qDense.classList.toggle('on', on); const qA = $('qAtten'); if (qA && viewer.attenuateOn) { const a = viewer.attenuateOn(); qA.classList.toggle('on', a); } toast(on ? 'Плотная заливка включена — без чёрных промежутков при приближении' : 'Плотная заливка выключена'); });
    const qFrame = $('qFrame');
    if (qFrame) qFrame.addEventListener('click', () => { if (!viewer || !viewer.setFrame) { toast('Доступно в 3D-режиме (WebGL)'); return; } const on = viewer.setFrame(!qFrame.classList.contains('on')); qFrame.classList.toggle('on', on); toast(on ? 'Чёрные рамки точек включены' : 'Чёрные рамки точек выключены'); });
    const qDensity = $('qDensity');
    if (qDensity) qDensity.addEventListener('change', async () => {
      const mln = Math.max(1, parseInt(qDensity.value, 10) || 12); const budget = mln * 1000000;
      try { if (window.PointCloud && window.PointCloud.setBudget) window.PointCloud.setBudget(budget); } catch (e) { }
      try { if (viewer && viewer.setLodBudget) viewer.setLodBudget(lodDrawBudget(budget)); } catch (e) { }
      if (API && API.setSettings) { try { SETTINGS.pointBudget = budget; SETTINGS.pointBudgetCustom = true; await API.setSettings({ pointBudget: budget, pointBudgetCustom: true }); } catch (e) { } }
      if (lastCloudPath && API && API.parseCloud && /\.(las|laz|ply|e57|ptx|pcd|xyz|pts|txt|csv|xyzrgb)$/i.test(lastCloudPath)) {
        toast('Плотность: ' + mln + ' млн точек — перечитываю облако…');
        try { const pr = await parseCloudWithProgress(lastCloudPath, 'Перезагрузка с бюджетом ' + mln + ' млн точек'); if (pr && pr.ok) { if (pr.kind === 'mesh') viewer.loadColoredMesh(pr); else { viewer.loadCloud(pr, {sourceName:lastCloudPath,preserveView:true}); cacheCloud(lastCloudPath, pr); lastCloudOffset=(pr.meta&&pr.meta.offset)||null; lastCloudCount=(pr.meta&&pr.meta.points)||pr.count||0; } toast('Готово: ' + mln + ' млн точек'); } else { toast('Не удалось перечитать облако' + (pr&&pr.message?': '+pr.message:'')); } } catch (e) { toast('Ошибка перечитывания: '+(e&&e.message||e)); }
      } else { toast('Плотность ' + mln + ' млн — применится при следующей загрузке облака'); }
    });
    const wb = $('vtWalk'); if (wb) wb.addEventListener('click', () => { if (!toolsOK()) return; if (!viewer.setWalk) { toast('Прогулка доступна в 3D‑режиме (WebGL)'); return; } const v = !wb.classList.contains('on'); wb.classList.toggle('on', v); viewer.setWalk(v); { const qP = $('qPhoto'); if (qP && viewer.photoOn) { const on = viewer.photoOn(); qP.classList.toggle('on', on); } const qE = $('qEDL'); if (qE) { const e = !!viewer._edl; qE.classList.toggle('on', e); } } toast(v ? 'Прогулка: W/A/S/D — движение, мышь — осмотр, Q/E — вниз/вверх, колесо — вперёд/назад, Esc — выход' : 'Обычный режим'); });
    const tb = $('vtTour'); if (tb) tb.addEventListener('click', () => { if (!toolsOK()) return; if (!viewer.setTour) { toast('Экскурсия доступна в 3D-режиме (WebGL)'); return; } const v = !tb.classList.contains('on'); tb.classList.toggle('on', v); if (v && wb && wb.classList.contains('on')) { wb.classList.remove('on'); viewer.setWalk(false); } viewer.setTour(v); toast(v ? 'Экскурсия: клик по облаку — телепорт к ближайшей станции, N — следующая станция вперёд, мышь — осмотр' : 'Обычный режим'); });
    if (!window.__tourKeys) { window.__tourKeys = true; window.addEventListener('keydown', e => { const k = (e.key || '').toLowerCase(); if ((k === 'n' || k === 'т') && viewer && viewer.tour && viewer.tourNext) viewer.tourNext(); }); }
    // Item 3 (patch 26): панель «Экскурсии» — импорт реальных станций E57/JSON, ручная расстановка, экспорт
    const tourBar = $('tourBar');
    if (tb && tourBar) tb.addEventListener('click', () => { const on = tb.classList.contains('on'); tourBar.style.display = on ? 'flex' : 'none'; if (!on && viewer.setStationEdit) { viewer.setStationEdit(null); const a = $('tsAdd'), d = $('tsDel'); if (a) a.classList.remove('on'); if (d) d.classList.remove('on'); } });
    if (viewer) viewer.onStations = (list) => { const c = $('tsCount'); if (c) c.textContent = (list ? list.length : 0) + ' ст.'; };
    const tsImport = $('tsImport');
    if (tsImport) tsImport.addEventListener('click', async () => {
      if (!API || !API.importStations) { toast('Импорт станций доступен в десктоп-версии'); return; }
      toast('Выберите файл E57 или JSON со станциями…');
      let res = null; try { res = await API.importStations(); } catch (e) { console.warn('importStations', e); }
      if (!res || !res.ok) { if (res && res.canceled) return; toast('Не удалось импортировать станции' + (res && res.error ? ': ' + res.error : '')); return; }
      let stations = [];
      if (res.kind === 'json') stations = (window.RealView ? window.RealView.deserialize(res.stations) : res.stations) || [];
      else stations = window.E57Stations ? window.E57Stations.stationsFromE57({ stations: res.stations }, lastCloudOffset) : [];
      if (!stations.length) { toast('В файле не найдено станций'); return; }
      viewer.setStations(stations);
      if (viewer.setTour && !tb.classList.contains('on')) { tb.classList.add('on'); if (wb && wb.classList.contains('on')) { wb.classList.remove('on'); viewer.setWalk(false); } viewer.setTour(true); if (tourBar) tourBar.style.display = 'flex'; }
      toast('Импортировано станций: ' + stations.length + (res.kind === 'e57' && !lastCloudOffset ? ' · без привязки к облаку — нажмите «В размер»' : ''));
    });
    const tsAdd = $('tsAdd');
    if (tsAdd) tsAdd.addEventListener('click', () => { if (!viewer.setStationEdit) { toast('Ручная расстановка доступна в 3D-режиме'); return; } const on = !tsAdd.classList.contains('on'); tsAdd.classList.toggle('on', on); const td = $('tsDel'); if (td) td.classList.remove('on'); viewer.setStationEdit(on ? 'add' : null); toast(on ? 'Клик по облаку — добавить станцию' : 'Добавление выключено'); });
    const tsDel = $('tsDel');
    if (tsDel) tsDel.addEventListener('click', () => { if (!viewer.setStationEdit) return; const on = !tsDel.classList.contains('on'); tsDel.classList.toggle('on', on); const ta = $('tsAdd'); if (ta) ta.classList.remove('on'); viewer.setStationEdit(on ? 'del' : null); toast(on ? 'Клик по станции — удалить её' : 'Удаление выключено'); });
    const tsReset = $('tsReset');
    if (tsReset) tsReset.addEventListener('click', () => { if (!window.RealView || !viewer.setStations || !viewer.bbox) return; viewer.setStations(window.RealView.suggestStations(viewer.bbox, {})); toast('Станции пересозданы автоматически'); });
    const tsExport = $('tsExport');
    if (tsExport) tsExport.addEventListener('click', async () => {
      if (!viewer.getStations) return;
      const list = viewer.getStations();
      if (!list.length) { toast('Нет станций для экспорта'); return; }
      const text = window.RealView ? window.RealView.serialize(list) : JSON.stringify(list);
      if (!API || !API.saveStations) { toast('Экспорт доступен в десктоп-версии'); return; }
      let res = null; try { res = await API.saveStations({ text: text, name: 'stations.json' }); } catch (e) { console.warn('saveStations', e); }
      if (res && res.ok) toast('Станции сохранены'); else if (!(res && res.canceled)) toast('Не удалось сохранить станции'); });
    // Патч 30 фаза 5: ЛОКАЛЬНЫЙ оффлайн фото-тур (аналог CoCloud RealView, без интернета)
    const stageEl = document.querySelector('.stage');
    if (window.PhotoTour && stageEl) window.PhotoTour.mount(stageEl);
    if (window.SplatViewer && stageEl) window.SplatViewer.mount(stageEl);
    // Патч 30 фаза 6: 3D Gaussian Splatting вьюер (.ply / .splat) — фотореализм «как с прибора»
    let _splatInput = null;
    function splatInput() {
      if (_splatInput) return _splatInput;
      _splatInput = document.createElement('input');
      _splatInput.type = 'file'; _splatInput.accept = '.ply,.splat,.ksplat,.glb,.gltf'; _splatInput.multiple = false;
      _splatInput.style.display = 'none'; document.body.appendChild(_splatInput);
      return _splatInput;
    }
    // base64 -> ArrayBuffer (для сконвертированного SOG из main-процесса)
    function _b64ToBuf(b64) {
      const bin = atob(b64); const len = bin.length; const u8 = new Uint8Array(len);
      for (let i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
      return u8.buffer;
    }
    // Шаг 2: PlayCanvas отдаёт управление нашему полноценному BIM-туру (станции/ходьба/маркеры) по кнопке «Тур».
    let _lastSplatBuf = null, _lastSplatName = null, _lastConvertedSplat = null;
    function openTourViewer() {
      if (!window.SplatViewer || !_lastSplatBuf) { toast('Тур недоступен'); return; }
      try { if (window.PCSplat && window.PCSplat.exit) window.PCSplat.exit(); } catch (e) {}
      if (stageEl) window.SplatViewer.mount(stageEl);
      try { window.SplatViewer.load(_lastSplatBuf, _lastSplatName || 'scene.ply'); toast('Тур: W/S/A/D — ходьба, метки — переходы, Esc — выход'); }
      catch (e) { console.warn('tour load', e); toast('Не удалось открыть тур'); }
    }
    if (window.PCSplat) { try { window.PCSplat.onTour = openTourViewer; } catch (e) {} }
    async function openSplatFile(file) {
      if (!file) return;
      if (/\.(glb|gltf)$/i.test(file.name)) { openMeshFile(file); return; }
      const localPath = selectedFilePath(file);
      toast('Читаю ' + file.name + '…');
      let buf;
      try { buf = await file.arrayBuffer(); }
      catch (e) { console.warn('splat read', e); toast('Не удалось прочитать файл'); return; }
      _lastSplatBuf = buf; _lastSplatName = file.name;
      // Prefer the high-quality PlayCanvas renderer when its offline bundle is present.
      if (window.PCSplat && window.PCSplat.available && stageEl) {
        // Шаг 1: если есть офлайн-конвертер, ужимаем PLY -> SOG (~15-20x меньше) для быстрой/плавной загрузки «как на superspl.at».
        let sogBuf = null;
        try {
          if (localPath && /\.ply$/i.test(file.name) && API && API.splatTransformStatus && API.convertSplat) {
            const stt = await API.splatTransformStatus();
            if (stt && stt.converter) {
              toast('Оптимизирую сцену (SOG)…');
              const cv = await API.convertSplat({ path: localPath, mode: 'sog' });
              if (cv && cv.ok && cv.base64) sogBuf = _b64ToBuf(cv.base64);
              else if (cv && !cv.ok) console.warn('[splat] SOG convert not ok', cv.error);
            }
          }
        } catch (e) { console.warn('[splat] SOG convert failed, using raw', e); }
        try {
          window.PCSplat.mount(stageEl);
          let ok = false;
          if (sogBuf) ok = await window.PCSplat.load(sogBuf, 'scene.sog');
          if (!ok) ok = await window.PCSplat.load(buf, file.name);
          if (ok) { toast('3DGS (PlayCanvas): ' + file.name + (sogBuf ? ' · SOG' : '') + ' · кнопка «Тур» — обход по станциям'); return; }
          console.warn('[splat] PlayCanvas renderer failed, falling back to built-in viewer');
        } catch (e) { console.warn('[splat] PlayCanvas threw, fallback', e); }
      }
      if (!window.SplatViewer) { toast('Модуль 3DGS не загружен'); return; }
      if (stageEl) window.SplatViewer.mount(stageEl);
      try {
        window.SplatViewer.load(buf, file.name);
      } catch (e) { console.warn('splat load', e); toast('Не удалось открыть файл: ' + (e && e.message ? e.message : e)); }
    }
    const openSplatPicker = () => { const inp = splatInput(); inp.onchange = () => { openSplatFile(inp.files && inp.files[0]); inp.value = ''; }; inp.click(); };

    /* === LCC2: глобальный шлюз — вызывается из lcc2-loader.js ===
     * Повторяет логику openSplatFile, но принимает готовый ArrayBuffer.
     * mount(stageEl) обязателен перед load(), иначе вьюер не откроется.
     */
    window._bimOpenSplat = async function(buf, name) {
      if (!buf) return;
      _lastSplatBuf  = buf;
      _lastSplatName = name || 'lcc2.splat';
      // Сначала пробуем PlayCanvas (PCSplat), если он доступен
      if (window.PCSplat && window.PCSplat.available && stageEl) {
        try {
          window.PCSplat.mount(stageEl);
          const ok = await window.PCSplat.load(buf, _lastSplatName);
          if (ok) { toast('LCC2 3DGS: кнопка «Тур» — обход по станциям'); return; }
        } catch (e) { console.warn('[lcc2] PCSplat failed, fallback', e); }
      }
      // Fallback: встроенный SplatViewer
      if (!window.SplatViewer) { toast('Модуль 3DGS не загружен'); return; }
      if (stageEl) window.SplatViewer.mount(stageEl);
      // Фотореалистичные параметры через публичный API
      // sizeMul=1.0 (физически точный размер гауссиан), maxPx=50 (достаточно большой квад)
      window.SplatViewer.setPointScale && window.SplatViewer.setPointScale(1.0);
      window.SplatViewer.setMaxPx && window.SplatViewer.setMaxPx(200);
      try {
        window.SplatViewer.load(buf, _lastSplatName);
      } catch (e) { console.warn('[lcc2] SplatViewer.load failed', e); toast('Ошибка 3DGS: ' + (e && e.message || e)); }
    };

    const tsSplat = $('tsSplat');
    if (tsSplat) tsSplat.addEventListener('click', openSplatPicker);

    // v1091: PLY → 3DGS конвертер
    const tsConv3dgs = $('tsConv3dgs');
    if (tsConv3dgs) tsConv3dgs.addEventListener('click', async () => {
      if (!window.PlyToSplat) { toast('Модуль конвертера не загружен'); return; }
      const buf = window._lastLidarPlyBuf;
      if (!buf) { toast('Сначала откройте PLY-облако точек через главный вьюер'); return; }

      // Прогресс-модаль
      let _dlg = document.getElementById('_plyConvDlg');
      if (!_dlg) {
        _dlg = document.createElement('div');
        _dlg.id = '_plyConvDlg';
        _dlg.className = 'modal open';
        _dlg.innerHTML = `
          <div class="modal-card sm conv-card">
            <div class="modal-head"><span class="conv-title">${ICON('sparkles', 16)}PLY → 3DGS конвертация</span></div>
            <div class="panel-body conv-body">
              <div id="_convMsg" class="conv-msg">Подготовка…</div>
              <div class="lx-bar"><i id="_convBar"></i></div>
              <div id="_convSub" class="conv-sub">Обнаруживаю файл…</div>
              <div class="conv-actions">
                <select id="_convQuality" aria-label="Качество конвертации">
                  <option value="2">Высокое (каждая 2-я точка)</option>
                  <option value="4" selected>Баланс (каждая 4-я)</option>
                  <option value="8">Быстрое (каждая 8-я)</option>
                </select>
                <button id="_convStart" class="btn primary" type="button">Начать</button>
                <button id="_convClose" class="btn" type="button">Закрыть</button>
              </div>
            </div>
          </div>`;
        document.body.appendChild(_dlg);
      }
      _dlg.style.display = 'flex'; _dlg.classList.add('open');
      const msgEl = document.getElementById('_convMsg');
      const barEl = document.getElementById('_convBar');
      const subEl = document.getElementById('_convSub');
      const qualEl = document.getElementById('_convQuality');
      const startBtn = document.getElementById('_convStart');
      const closeBtn = document.getElementById('_convClose');

      const n = (window._lastLidarPlyBuf.byteLength / 1e6).toFixed(0);
      if (msgEl) msgEl.textContent = 'Облако: ' + (window._lastLidarPlyName || 'cloud.ply') + '  ·  ' + n + ' МБ';
      if (barEl) barEl.style.width = '0%';
      if (subEl) subEl.textContent = 'Выберите качество и нажмите «Начать»';

      let _converting = false;
      if (startBtn) startBtn.onclick = async () => {
        if (_converting) return;
        _converting = true;
        startBtn.disabled = true;
        startBtn.textContent = 'Конвертирую…';
        const ds = qualEl ? parseInt(qualEl.value, 10) : 4;
        try {
          const result = await window.PlyToSplat.convert(buf, {
            downsample: ds,
            progress: (pct, msg) => {
              if (barEl) barEl.style.width = pct + '%';
              if (subEl) subEl.textContent = msg;
            }
          });
          if (msgEl) msgEl.textContent = 'Готово! ' + result.count.toLocaleString('ru-RU') + ' сплэтов · ' + (result.buffer.byteLength / 1e6).toFixed(0) + ' МБ';
          if (subEl) subEl.textContent = 'Загружаю в 3DGS-вьюер…';
          _lastSplatBuf = result.buffer;
          _lastSplatName = (window._lastLidarPlyName || 'cloud').replace(/\.ply$/i, '') + '-3dgs.splat';
          _lastConvertedSplat = result.buffer;
          setTimeout(() => {
            _dlg.style.display = 'none';
            if (!window.SplatViewer) { toast('Модуль 3DGS-вьюера не загружен'); return; }
            if (stageEl) window.SplatViewer.mount(stageEl);
            try {
              window.SplatViewer.load(result.buffer, _lastSplatName);
              toast('3DGS готов: ' + result.count.toLocaleString('ru-RU') + ' сплэтов · W/S/A/D — ходьба, Esc — выход');
            } catch (e) { toast('Ошибка открытия 3DGS: ' + (e.message || e)); }
          }, 800);
        } catch (err) {
          if (msgEl) msgEl.textContent = 'Ошибка: ' + (err.message || err);
          if (barEl) barEl.style.background = 'var(--err)';
          startBtn.disabled = false;
          startBtn.textContent = 'Повторить';
          _converting = false;
        }
      };
      if (closeBtn) closeBtn.onclick = () => { if (!_converting) _dlg.style.display = 'none'; };
    });
    const tsSplatTop = $('tsSplatTop');
    if (tsSplatTop) tsSplatTop.addEventListener('click', openSplatPicker);
    // Патч 31: вариант B — текстурированный меш-вьюер (glTF/GLB) для 3D-тура «как в RealityScan»
    let _meshInput = null;
    function meshInput() {
      if (_meshInput) return _meshInput;
      _meshInput = document.createElement('input');
      _meshInput.type = 'file'; _meshInput.accept = '.glb,.gltf,.obj,.stl,.ply'; _meshInput.multiple = false;
      _meshInput.style.display = 'none'; document.body.appendChild(_meshInput);
      return _meshInput;
    }
    async function openMeshFile(file) {
      if (!file) return;
      if (!window.MeshViewer) { toast('Модуль меш-вьюера не загружен'); return; }
      toast('Читаю меш ' + file.name + '…');
      let mb;
      try { mb = await file.arrayBuffer(); }
      catch (e) { console.warn('mesh read', e); toast('Не удалось прочитать файл'); return; }
      try { if (window.SplatViewer && window.SplatViewer.isOpen && window.SplatViewer.isOpen()) window.SplatViewer.exit(); } catch (e) {}
      try { if (window.PCSplat && window.PCSplat.exit) window.PCSplat.exit(); } catch (e) {}
      try {
        if (stageEl) window.MeshViewer.mount(stageEl);
        const scene = window.MeshViewer.loadAsync ? await window.MeshViewer.loadAsync(mb, file.name) : window.MeshViewer.load(mb, file.name);
        if (!scene) { toast('Загрузка меша отменена другой операцией'); return; }
        toast('Меш ' + file.name + ' открыт · ' + Number(scene && scene.triangles || 0).toLocaleString('ru-RU') + ' треугольников' +
          meshWarningSummary(scene && scene.warnings, scene && scene.metadata));
      }
      catch (e) { console.warn('mesh load', e); toast('Не удалось открыть меш: ' + (e && e.message ? e.message : e)); }
    }
    const openMeshPicker = () => { const inp = meshInput(); inp.onchange = () => { openMeshFile(inp.files && inp.files[0]); inp.value = ''; }; inp.click(); };
    const tsMesh = $('tsMesh');
    if (tsMesh) tsMesh.addEventListener('click', openMeshPicker);
    let _panoInput = null;
    function panoInput() {
      if (_panoInput) return _panoInput;
      _panoInput = document.createElement('input');
      _panoInput.type = 'file'; _panoInput.accept = 'image/*,.json,application/json'; _panoInput.multiple = true;
      _panoInput.style.display = 'none'; document.body.appendChild(_panoInput);
      return _panoInput;
    }
    function startPhotoTour(stations) {
      if (!window.PhotoTour) { toast('Модуль фото-тура не загружен'); return; }
      if (stageEl) window.PhotoTour.mount(stageEl);
      try { if (viewer && viewer.setStations) viewer.setStations(stations.map(s => ({ id: s.id, name: s.name, pos: s.pos, yaw: s.yaw || 0, panoUrl: s.panoUrl }))); } catch (e) {}
      window.PhotoTour.load(stations);
      window.PhotoTour.enter(0);
      toast('Фото-тур: тяните мышью — осмотр, колесо — зум, синие метки / N — переход, Esc — выход');
    }
    async function buildPhotoTourFromFiles(files) {
      const arr = Array.from(files || []);
      const imgs = arr.filter(f => /\.(jpe?g|png|webp)$/i.test(f.name));
      const manFile = arr.find(f => /\.json$/i.test(f.name));
      if (!imgs.length) { toast('Не выбрано ни одной панорамы (JPG/PNG)'); return; }
      let manifest = null;
      if (manFile) { try { manifest = JSON.parse(await manFile.text()); } catch (e) { toast('Ошибка чтения manifest.json — беру только изображения'); } }
      const byName = {}; imgs.forEach(f => { byName[f.name] = f; });
      let stations = [];
      if (manifest && Array.isArray(manifest.stations) && manifest.stations.length) {
        stations = manifest.stations.map((s, i) => {
          const fn = s.image || s.file || s.pano || '';
          const f = byName[fn] || byName[(fn || '').split(/[\\/]/).pop()] || imgs[i];
          return { id: s.id || ('p' + (i + 1)), name: s.name || ('Станция ' + (i + 1)), pos: s.pos || [i * 4, 1.6, 0], yaw: s.yaw || 0, panoUrl: f ? URL.createObjectURL(f) : null };
        });
      } else {
        imgs.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        stations = imgs.map((f, i) => ({ id: 'p' + (i + 1), name: f.name.replace(/\.(jpe?g|png|webp)$/i, ''), pos: [i * 4, 1.6, 0], yaw: 0, panoUrl: URL.createObjectURL(f) }));
      }
      startPhotoTour(stations);
    }
    const tsPhoto = $('tsPhoto');
    if (tsPhoto) tsPhoto.addEventListener('click', () => { const inp = panoInput(); inp.onchange = () => { buildPhotoTourFromFiles(inp.files); inp.value = ''; }; inp.click(); });
    const tsPhotoDemo = $('tsPhotoDemo');
    if (tsPhotoDemo) tsPhotoDemo.addEventListener('click', () => { if (!window.PhotoTour) { toast('Модуль фото-тура не загружен'); return; } if (stageEl) window.PhotoTour.mount(stageEl); window.PhotoTour.demo(); toast('Демо фото-тур: 3 станции. Тяните мышью — осмотр, синие метки — переход, N — вперёд, Esc — выход'); });
    // Phase 4: редактирование облака точек
    const eb = $('vtEdit'); const editBar = $('editBar'); const edCount = $('editCount');
    const nfmt = n => (n || 0).toLocaleString('ru-RU');
    const refreshEdCount = n => { if (edCount) edCount.textContent = n > 0 ? ('Выбрано точек: ' + nfmt(n)) : 'Выделите точки рамкой (ЛКМ). Shift/ПКМ — вращение'; };
    if (viewer) { viewer.onEditSelect = n => refreshEdCount(n); viewer.onBrushRadius = r => toast('Размер кисти: ' + r + ' px'); viewer.onEditChange = n => { toast('Точек в облаке: ' + nfmt(n)); if (!viewer._pendingProjectOperation) viewer._pendingProjectOperation = { operation: 'cloud.point-edit', parameters: { pointCountAfter: Number(n) || 0 } }; try { if (window.__pcAutosave) window.__pcAutosave.onEdit(n); } catch (e) {} }; }
    if (eb) eb.addEventListener('click', () => { if (!toolsOK()) return; if (!viewer.setEditSelect) { toast('Редактирование доступно в 3D-режиме (WebGL)'); return; } const v = !eb.classList.contains('on'); eb.classList.toggle('on', v); viewer.setEditSelect(v); if (editBar) editBar.style.display = v ? '' : 'none'; if (v) { selMode = 'lasso'; selDepthMode = 1; if (viewer.setSelectMode) viewer.setSelectMode('lasso'); if (viewer.setSmartClean) { try { viewer.setSmartClean(true); } catch (e) {} } else if (viewer.setSelectDepthMode) { viewer.setSelectDepthMode(1); } if (edModeBtn) setEdModeLbl('Лассо'); if (edThroughBtn) { edThroughBtn.classList.remove('on'); } if (edProtectBtn) { edProtectBtn.classList.add('on'); } refreshEdCount(0); if (wb) wb.classList.remove('on'); if (tb) tb.classList.remove('on'); toast('Лассо включено: обведите мусор (ЛКМ) и нажмите «Удалить». Пол и стены под объектом защищены. ПКМ и колесо — камера · Alt — снять · Esc — сброс · Ctrl+Z — отмена'); } });
    // Пункт 4: disk-octree подгружает видимые узлы по frustum+budget; построение индекса пока in-memory и ограничено защитным пределом.
    const mb = $('vtMem');
    if (mb) mb.addEventListener('click', () => { const on = !mb.classList.contains('on'); mb.classList.toggle('on', on); applyPerfProfile(on); toast(on ? 'Профиль «Максимум памяти/качество»: предзагрузка всех облаков проекта, увеличенный кеш octree, детализация при движении до 12 млн точек' : 'Сбалансированный профиль: экономия памяти'); });
    // Конвертация LAS/LAZ/E57 → PLY (для 3D-экскурсии). Идёт в main-процессе прямо с диска — не грузит облако в GPU, поэтому не вылетает.
    const cvt = $('vtConvert');
    if (cvt) cvt.addEventListener('click', async () => {
      if (!API || !API.convertCloudToPly) { toast('Конвертация доступна в десктоп-версии'); return; }
      const src = (lastCloudPath && /\.(las|laz|e57|pcd|xyz|pts|xyzrgb)$/i.test(lastCloudPath)) ? lastCloudPath : null;
      cvt.classList.add('on');
      toast(src ? 'Конвертация текущего облака в PLY… выберите, куда сохранить' : 'Выберите файл LAS/LAZ/E57 для конвертации в PLY…');
      try {
        const r = await API.convertCloudToPly(src ? { path: src } : {});
        if (r && r.ok) { const mln = Math.round((r.count || 0) / 1e5) / 10; toast('Готово · PLY сохранён (' + mln + ' млн точек): ' + r.path); }
        else if (!(r && r.canceled)) toast('Не удалось конвертировать: ' + ((r && r.error) || 'ошибка'));
      } catch (e) { toast('Ошибка конвертации'); }
      finally { cvt.classList.remove('on'); }
    });
    // v1091: expose LAS→PLY conversion globally for ConvertHub
    window.__bimLaunchConvertToPly = async function () {
      if (!API || !API.convertCloudToPly) { toast('Конвертация доступна в десктоп-версии'); return; }
      const src = (lastCloudPath && /\.(las|laz|e57|pcd|xyz|pts|xyzrgb)$/i.test(lastCloudPath)) ? lastCloudPath : null;
      toast(src ? 'Конвертация текущего облака в PLY… выберите, куда сохранить' : 'Выберите файл LAS/LAZ/E57 для конвертации в PLY…');
      try {
        const r = await API.convertCloudToPly(src ? { path: src } : {});
        if (r && r.ok) { const mln = Math.round((r.count || 0) / 1e5) / 10; toast('Готово · PLY сохранён (' + mln + ' млн т.): ' + r.path); return r; }
        else if (!(r && r.canceled)) { toast('Не удалось: ' + ((r && r.error) || 'ошибка')); return r || {ok:false}; }
        else return {ok:false,canceled:true};
      } catch (e) { toast('Ошибка конвертации'); return {ok:false,error:e&&e.message||'ошибка'}; }
    };
    window.__bimAPI = { convertCloudToPly: () => window.__bimLaunchConvertToPly() };
    // ───── Геометрия облака: отклонения / совмещение / меш / PDAL ──────
    let _geomInput = null;
    const geomInput = (accept) => {
      if (!_geomInput) { _geomInput = document.createElement('input'); _geomInput.type = 'file'; _geomInput.style.display = 'none'; document.body.appendChild(_geomInput); }
      _geomInput.accept = accept || '';
      return _geomInput;
    };
    const pickGeomFile = (accept) => new Promise(resolve => {
      const inp = geomInput(accept); inp.value = '';
      let done = false;
      const onFocus = () => { setTimeout(() => { if (!done && (!inp.files || !inp.files.length)) finish(null); }, 600); };
      const finish = (f) => { if (done) return; done = true; try { inp.onchange = null; inp.oncancel = null; } catch (e) {} window.removeEventListener('focus', onFocus); resolve(f || null); };
      inp.onchange = () => {
        const file = (inp.files && inp.files[0]) || null;
        finish(file ? { name: file.name, type: file.type || '', size: file.size || 0, path: selectedFilePath(file) } : null);
      };
      inp.oncancel = () => finish(null);
      window.addEventListener('focus', onFocus);
      inp.click();
    });
    const reloadGeomCloud = async (p) => {
      try {
        const pr = await API.parseCloud(p);
        if (pr && pr.ok) {
          if (pr.kind === 'mesh') viewer.loadColoredMesh(pr);
          else { viewer.loadCloud(pr, { preserveView: true, sourceName:p }); cacheCloud(p, pr); }
          lastCloudPath = p; lastCloudCount = (pr.meta && pr.meta.points) || 0; return true;
        }
        if (pr && pr.fallback && API.readFile) {
          const b64 = await API.readFile(p);
          if (!b64) return false;
          const browserParsed = await load3DBuffer(p, b64ToU8(b64).buffer);
          if (!browserParsed || !browserParsed.ok) return false;
          lastCloudPath = p; lastCloudCount = (browserParsed.meta && browserParsed.meta.points) || 0; return true;
        }
      } catch (e) { console.warn('geom reload', e); }
      return false;
    };
    const curCloudPath = () => {
      if (lastCloudPath) return lastCloudPath;
      try { const active = window.MultiCloud && window.MultiCloud.getActive && window.MultiCloud.getActive(); if (active && active.path) return active.path; } catch (_) {}
      return pendingCloudPath || null;
    };
    let geomBusy = false;
    function beginProgress(label, opts) {
      if (window.__lxProgress && window.__lxProgress.begin) return window.__lxProgress.begin(label, opts);
      // запасной вариант: тонкая полоса активности сверху окна
      const a = window.__lxKit && window.__lxKit.activity ? window.__lxKit.activity(label || 'Обработка…') : null;
      const stop = () => { if (a) a.done(); };
      stop.set = (frac, lab) => { if (a) a.set(frac, lab); };
      stop.text = (lab) => { if (a && lab != null) a.set(null, lab); };
      return stop;
    }
    async function withBusy(btn, label, fn) {
      if (geomBusy) { toast('Идёт обработка облака — дождитесь завершения'); return; }
      geomBusy = true; if (btn) { btn.classList.add('on'); btn.classList.add('busy'); btn.disabled = true; }
      const stop = beginProgress(label);
      try { await fn(); } catch (e) { console.warn('geom op', e); toast('Ошибка: ' + ((e && e.message) || e)); }
      finally { geomBusy = false; if (btn) { btn.classList.remove('on'); btn.classList.remove('busy'); btn.disabled = false; } if (stop) { try { stop(); } catch (e) {} } }
    }
    async function geomInstall() {
      if (!API || !API.installPyDeps) { toast('Установка доступна в десктоп-версии'); return; }
      toast('Открываю установщик Open3D / SciPy…');
      try { const r = await API.installPyDeps(); toast((r && r.message) || (r && r.ok ? 'Установщик запущен' : 'Не удалось запустить установщик')); }
      catch (e) { toast('Ошибка запуска установщика'); }
    }
    const geomCloudReady = () => { if (!API) { toast('Функция доступна в десктоп-версии'); return false; } const p = curCloudPath(); if (!p || !/\.(ply|las|laz|e57|pcd|xyz|pts|xyzrgb)$/i.test(p)) { toast('Сначала выберите помещение с сохранённым облаком (или откройте облако)'); return false; } return true; };
    const mmv = v => (Number(v || 0) * 1000).toFixed(1);
    async function confirmGeometryFrame(action, r) {
      if (!(r && r.needFrameConfirmation)) return true;
      const fc = r.frameCheck || {};
      const reason = fc.crsStatus !== 'same'
        ? 'CRS отсутствует или не удалось однозначно сопоставить WKT'
        : 'не удалось подтвердить source-transform обоих облаков';
      const question = action + ' продолжится в локальных координатах точек. ' + reason +
        '. Выполняйте операцию только если облака уже приведены к одному datum и координаты сопоставимы.';
      const kit = window.__lxKit;
      if (!kit || !kit.ask) return false;
      return !!(await kit.ask({ title: 'Координаты не подтверждены', message: question, okLabel: 'Продолжить', danger: true }));
    }
    async function geomDeviation() {
      if (!geomCloudReady() || !API.deviation) return;
      toast('Выберите эталон (проектная модель / опорное облако) для сравнения…');
      const f = await pickGeomFile('.ply,.las,.laz,.e57,.ptx,.pcd,.xyz,.pts');
      if (!f || !f.path) { toast('Эталон не выбран'); return; }
      toast('Расчёт отклонений (скан ↔ эталон)… это может занять время');
      try {
        const payload = { compared: curCloudPath(), reference: f.path };
        let r = await API.deviation(payload);
        if (r && r.needFrameConfirmation) {
          if (!(await confirmGeometryFrame('Сравнение', r))) { toast('Сравнение отменено: сначала подтвердите совместимость координат'); return; }
          r = await API.deviation(Object.assign({}, payload, { confirmFrame: true }));
        }
        if (r && r.ok) {
          await reloadGeomCloud(r.path);
          const frameNote = r.outputCrsWkt ? ' · CRS текущего облака сохранена' : ' · CRS результата не задана';
          toast('Готово · отклонения (' + (r.engine === 'scipy' ? 'точно' : r.engine) + '): среднее ' + mmv(r.mean) + ' мм, макс ' + mmv(r.max) + ' мм, 95% ≤ ' + mmv(r.p95) + ' мм. Красный — большое отклонение, синий — совпадение' + frameNote);
        } else if (r && r.error === 'crs_mismatch') {
          toast('Сравнение отменено: CRS облаков различаются. Сначала преобразуйте их в одну систему координат.');
        } else { toast('Не удалось: ' + ((r && r.error) || 'ошибка') + (r && r.needPython ? ' — нужен Python' : '')); }
      } catch (e) { toast('Ошибка расчёта отклонений'); }
    }
    async function geomRegister() {
      if (!geomCloudReady() || !API.registerClouds) return;
      toast('Выберите целевое облако (target), к которому подгонять текущее…');
      const f = await pickGeomFile('.ply,.las,.laz,.e57,.ptx,.pcd,.xyz,.pts');
      if (!f || !f.path) { toast('Целевое облако не выбрано'); return; }
      toast('Совмещение (ICP)… это может занять время');
      try {
        const source = curCloudPath();
        let r = await API.registerClouds({ source: source, target: f.path });
        if (r && r.needFrameConfirmation) {
          if (!(await confirmGeometryFrame('Совмещение ICP', r))) {
            toast('Совмещение отменено: сначала подтвердите совместимость систем координат');
            return;
          }
          r = await API.registerClouds({ source: source, target: f.path, confirmFrame: true });
        }
        if (r && r.ok) {
          await reloadGeomCloud(r.path);
          const frameNote = r.outputCrsWkt
            ? ' · CRS целевого облака сохранена'
            : (r.outputFrame === 'target-source' ? ' · координаты target, CRS не задана' : ' · локальные координаты target');
          const warningNote = Array.isArray(r.warnings) && r.warnings.length
            ? ' · предупреждения: ' + r.warnings.join(', ')
            : '';
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const basename = value => String(value || '').split(/[\\/]/).pop() || '';
          const report = {
            schema: 'bim-twin.registration-report.v1',
            generatedAt: new Date().toISOString(),
            algorithm: 'trimmed coarse-to-fine point-to-point ICP (local solver; no global feature initialization)',
            source: basename(source),
            target: basename(f.path),
            outputCloud: basename(r.path),
            coordinateFrame: r.coordinateFrame || r.outputFrame || 'unknown',
            outputCrsWkt: r.outputCrsWkt || null,
            frameCheck: r.frameCheck || null,
            transformConvention: 'row-major 4x4 homogeneous matrix; maps source XYZ to target XYZ',
            transform: Array.isArray(r.transform) ? r.transform : null,
            baseline: {
              stage: 'centroid-only initialization, before ICP iterations',
              fitness: r.initialFitness == null ? null : r.initialFitness,
              rmse: r.initialRmse == null ? null : r.initialRmse,
              correspondences: r.initialCorrespondences == null ? null : r.initialCorrespondences
            },
            metrics: {
              fitness: r.fitness == null ? null : r.fitness,
              fitnessDefinition: 'fraction of sampled source points with nearest target within maxCorrespondenceDistance',
              inlierRatio: r.inlierRatio == null ? null : r.inlierRatio,
              rmse: r.rmse == null ? null : r.rmse,
              medianResidual: r.medianResidual == null ? null : r.medianResidual,
              p95Residual: r.p95Residual == null ? null : r.p95Residual,
              maxCorrespondenceDistance: r.maxCorrespondenceDistance == null ? null : r.maxCorrespondenceDistance,
              correspondences: r.correspondences == null ? null : r.correspondences,
              inliers: r.inliers == null ? null : r.inliers,
              sampledSourcePoints: r.sampledSourcePoints == null ? null : r.sampledSourcePoints,
              sourcePoints: r.points == null ? null : r.points,
              targetPoints: r.targetPoints == null ? null : r.targetPoints,
              iterations: r.iterations == null ? null : r.iterations,
              converged: r.converged == null ? null : r.converged,
              trimFraction: r.trimFraction == null ? null : r.trimFraction
            },
            warnings: Array.isArray(r.warnings) ? r.warnings : [],
            independentCheck: null,
            accuracyNote: 'Initial RMSE is computed on in-gate correspondences before ICP; final RMSE is over trimmed final inliers, so the populations differ. ICP residuals describe internal fit, not independent survey accuracy; use separate check points for acceptance.'
          };
          downloadBlob(JSON.stringify(report, null, 2), 'registration-report-' + stamp + '.json', 'application/json');
          const residualNote = r.p95Residual == null ? '' : ', P95 ' + mmv(r.p95Residual) + ' мм';
          const inlierNote = r.inlierRatio == null ? '' : ', inliers ' + Math.round(r.inlierRatio * 100) + '%';
          toast('Готово · совмещение (' + r.engine + '): RMSE ' + mmv(r.rmse) + ' мм' + residualNote +
            inlierNote + ', fitness ' + Math.round((r.fitness || 0) * 100) + '%' + frameNote + warningNote +
            ' · JSON-отчёт скачан');
        } else if (r && r.error === 'crs_mismatch') {
          toast('Совмещение отменено: CRS облаков различаются. Сначала преобразуйте облака в одну систему координат.');
        } else {
          toast('Не удалось: ' + ((r && r.error) || 'ошибка'));
        }
      } catch (e) { toast('Ошибка совмещения'); }
    }
    async function geomMesh() {
      if (!geomCloudReady() || !API.meshCloud) return;
      toast('Построение поверхности (Poisson)… нужен Open3D, может занять время');
      try {
        const r = await API.meshCloud({ path: curCloudPath(), method: 'poisson' });
        if (r && r.ok) {
          const loaded = await reloadGeomCloud(r.path);
          if (loaded) {
            const frameNote = r.outputCrsWkt ? ' · CRS сохранена' : (r.outputFrame === 'source' ? ' · координаты исходного облака' : ' · локальные координаты');
            toast('Готово · поверхность: ' + (r.triangles || 0).toLocaleString('ru-RU') + ' треуг., ' + (r.vertices || 0).toLocaleString('ru-RU') + ' вершин' + frameNote);
          } else {
            toast('Меш построен, но не удалось загрузить его в просмотрщик: ' + r.path);
          }
        }
        else if (r && r.needOpen3d) { toast('Для меширования нужен Open3D. Откройте «Облако → Геометрия → Установить Open3D + SciPy»'); }
        else { toast('Не удалось: ' + ((r && r.error) || 'ошибка')); }
      } catch (e) { toast('Ошибка построения поверхности'); }
    }
    // Офлайн-конвертация текущего облака в 3DGS (surfel-сплаты) прямо в приложении — без Python/внешних утилит.
    // Перекрывающиеся сплэты закрывают чёрные щели между точками => плотная «как фото» картинка, сразу в туре.
    // Строка-ползунок для диалога конвертации.
    function splatSlider(body, label, min, max, step, val, fmt) {
      const row = mk('div', ''); row.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin:10px 0';
      const top = mk('div', ''); top.style.cssText = 'display:flex;justify-content:space-between;font-size:13px;color:var(--txt)';
      const lab = mk('span', '', esc(label)); const valEl = mk('span', '', esc(fmt(val))); valEl.style.cssText = 'color:var(--accent);font-variant-numeric:tabular-nums';
      top.append(lab, valEl);
      const inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = val; inp.style.cssText = 'width:100%';
      inp.addEventListener('input', () => { valEl.textContent = fmt(parseFloat(inp.value)); });
      row.append(top, inp); body.appendChild(row);
      return inp;
    }
    // Диалог настроек качества 3DGS-конвертации.
    function openSplatConvertDialog() {
      if (!window.CloudConvert || !window.SplatViewer) { toast('Модуль конвертации не загружен'); return; }
      const cc = (viewer && viewer.getEditedCloud) ? viewer.getEditedCloud() : null;
      if (!cc || !cc.pos || !cc.pos.length) { toast('Сначала откройте облако точек'); return; }
      const p = modalPanel('Облако → 3DGS · качество');
      const info = mk('div', '', 'Точек в облаке: ' + Math.round(cc.pos.length / 3).toLocaleString('ru-RU')); info.style.cssText = 'font-size:12px;color:var(--muted);margin-bottom:6px';
      p.body.appendChild(info);
      const sDens = splatSlider(p.body, 'Плотность (число сплэтов)', 0.5, 6, 0.1, 2.5, v => v.toFixed(1) + ' млн');
      const sSize = splatSlider(p.body, 'Размер сплэта (перекрытие щелей)', 0.3, 1.4, 0.05, 0.6, v => '×' + v.toFixed(2));
      const sOpac = splatSlider(p.body, 'Непрозрачность', 0.5, 0.99, 0.01, 0.92, v => Math.round(v * 100) + '%');
      const hint = mk('div', '', 'Больше размер/плотность = плотнее «как фото», но тяжелее. Меньше = легче и точнее по геометрии.'); hint.style.cssText = 'font-size:12px;color:var(--muted);margin:8px 0 4px';
      p.body.appendChild(hint);
      const optsOf = () => ({ targetSplats: Math.round(parseFloat(sDens.value) * 1e6), scaleMul: parseFloat(sSize.value), opacity: parseFloat(sOpac.value) });
      const btns = mk('div', ''); btns.style.cssText = 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap';
      const bGo = mk('button', 'btn sm primary', IB('sparkles', 'Конвертировать и открыть в туре'));
      const bSave = mk('button', 'btn sm', IB('save', 'Конвертировать и сохранить .ply'));
      bGo.onclick = async () => { p.close(); await runSplatConvert(optsOf(), false); };
      bSave.onclick = async () => { p.close(); await runSplatConvert(optsOf(), true); };
      btns.append(bGo, bSave); p.body.appendChild(btns);
    }
    // Офлайн-конвертация облака в 3DGS (surfel-сплаты): перекрывающиеся сплэты закрывают щели => плотная «как фото» картинка.
    async function runSplatConvert(opts, alsoSave) {
      if (!window.CloudConvert || !window.SplatViewer) { toast('Модуль конвертации не загружен'); return; }
      const cc = (viewer && viewer.getEditedCloud) ? viewer.getEditedCloud() : null;
      if (!cc || !cc.pos || !cc.pos.length) { toast('Сначала откройте облако точек'); return; }
      toast('Конвертация в 3DGS… несколько секунд, не закрывайте окно');
      await new Promise(r => setTimeout(r, 30));
      let res;
      try { res = window.CloudConvert.pointsToSplat(cc.pos, cc.col || null, opts || {}); }
      catch (e) { console.warn('toSplat', e); toast('Не удалось конвертировать: ' + (e && e.message ? e.message : e)); return; }
      if (!res || !res.buffer) { toast('Пустой результат конвертации'); return; }
      try { if (window.PCSplat && window.PCSplat.exit) window.PCSplat.exit(); } catch (e) {}
      try { if (window.MeshViewer && window.MeshViewer.isOpen && window.MeshViewer.isOpen()) window.MeshViewer.exit(); } catch (e) {}
      _lastSplatBuf = res.buffer; _lastSplatName = 'converted-3dgs.ply'; _lastConvertedSplat = res.buffer;
      if (stageEl) window.SplatViewer.mount(stageEl);
      try { window.SplatViewer.load(res.buffer, _lastSplatName); toast('3DGS готов: ' + (res.count || 0).toLocaleString('ru-RU') + ' сплэтов · кнопка «Тур» — обход'); }
      catch (e) { console.warn('splat load', e); toast('Не удалось открыть 3DGS'); }
      if (alsoSave) await saveConvertedSplat();
    }
    // Сохранение последнего конвертированного 3DGS на диск (.ply).
    async function saveConvertedSplat() {
      if (!_lastConvertedSplat) { toast('Сначала выполните конвертацию в 3DGS'); return; }
      if (!API || !API.saveCloud) { toast('Сохранение доступно в десктоп-версии'); return; }
      try {
        const r = await API.saveCloud({ binary: new Uint8Array(_lastConvertedSplat), name: 'converted-3dgs.ply' });
        if (r && r.ok) toast('Сохранено: ' + r.path);
        else if (!(r && r.canceled)) toast('Ошибка сохранения: ' + ((r && r.error) || ''));
      } catch (e) { console.warn('saveSplat', e); toast('Ошибка сохранения'); }
    }
    // Построение меша (Poisson через Open3D) и открытие его прямо в туре (meshviewer теперь читает меш-PLY).
    async function cloudToMeshTour() {
      if (!geomCloudReady() || !API || !API.meshCloud) { toast('Функция доступна в десктоп-версии'); return; }
      toast('Построение поверхности (Poisson)… нужен Open3D, может занять время');
      let r;
      try { r = await API.meshCloud({ path: curCloudPath(), method: 'poisson' }); }
      catch (e) { console.warn('meshCloud', e); toast('Ошибка построения поверхности'); return; }
      if (!r || !r.ok) {
        if (r && (r.needOpen3d || r.needPython)) toast('Для меша нужен Open3D. Откройте «Облако → Геометрия → Установить Open3D + SciPy»');
        else toast('Не удалось: ' + ((r && r.error) || 'ошибка'));
        return;
      }
      if (!window.MeshViewer) { toast('Модуль меш-вьюера не загружен'); return; }
      let mb = null;
      try { const rd = await API.readPicked(r.path); if (rd && rd.ok && rd.base64) mb = _b64ToBuf(rd.base64); }
      catch (e) { console.warn('read mesh', e); }
      if (!mb) { toast('Меш построен (' + (r.triangles || 0).toLocaleString('ru-RU') + ' треуг.), но не удалось открыть в туре'); return; }
      try { if (window.SplatViewer && window.SplatViewer.isOpen && window.SplatViewer.isOpen()) window.SplatViewer.exit(); } catch (e) {}
      try { if (window.PCSplat && window.PCSplat.exit) window.PCSplat.exit(); } catch (e) {}
      if (stageEl) window.MeshViewer.mount(stageEl);
      try { window.MeshViewer.load(mb, 'mesh.ply'); toast('Меш в туре: ' + (r.triangles || 0).toLocaleString('ru-RU') + ' треуг.'); }
      catch (e) { console.warn('mesh load', e); toast('Не удалось открыть меш: ' + (e && e.message ? e.message : e)); }
    }
    async function geomPdal() {
      if (!API || !API.pdalRun) { toast('Функция доступна в десктоп-версии'); return; }
      toast('Выберите PDAL-пайплайн (.json)…');
      const f = await pickGeomFile('.json');
      if (!f) { toast('Пайплайн не выбран'); return; }
      if (!f.path) { toast('Не удалось подтвердить путь к PDAL-пайплайну'); return; }
      toast('Запуск PDAL-пайплайна…');
      try {
        const r = await API.pdalRun({ pipelinePath: f.path });
        if (r && r.ok) { toast('PDAL готово (' + r.engine + ')' + (r.count != null ? ' · точек: ' + Number(r.count).toLocaleString('ru-RU') : '')); }
        else if (r && r.needPdal) { toast('Нужен PDAL: conda install -c conda-forge pdal python-pdal'); }
        else if (r && r.canceled) { toast('PDAL отменён'); }
        else { toast('Не удалось: ' + ((r && r.error) || 'ошибка')); }
      } catch (e) { toast('Ошибка PDAL'); }
    }
    const gb = $('vtGeom');
    if (gb) gb.addEventListener('click', () => {
      if (document.getElementById('geomMenu')) { window.__lxKit.closePopover(); return; }
      const GI = (ico, label, fn) => ({ ico, label, onClick: fn });
      window.__lxKit.menu(gb, [
        GI('chart-column', 'Отклонения (скан ↔ модель)', () => withBusy(gb, 'Расчёт отклонений…', geomDeviation)),
        GI('git-compare', 'Совмещение сканов (ICP)', () => withBusy(gb, 'Совмещение (ICP)…', geomRegister)),
        GI('shapes', 'Построить поверхность (mesh)', () => withBusy(gb, 'Построение поверхности…', geomMesh)),
        { sep: true },
        GI('sparkles', 'Облако → 3DGS (настройки + тур)', () => openSplatConvertDialog()),
        GI('save', 'Сохранить 3DGS (.ply)', () => saveConvertedSplat()),
        GI('landmark', 'Облако → меш (в туре)', () => withBusy(gb, 'Меш для тура…', cloudToMeshTour)),
        { sep: true },
        GI('workflow', 'PDAL-пайплайн (.json)', () => withBusy(gb, 'PDAL…', geomPdal)),
        GI('download', 'Установить Open3D + SciPy', geomInstall)
      ], { id: 'geomMenu', title: 'Геометрия облака', minWidth: 300 });
    });

    // Очистка облака от шума/выбросов через Python-сайдкар (Open3D → иначе NumPy). Идёт в main-процессе.
    const cln = $('vtClean');
    let clnStep = 0;
    if (cln) cln.addEventListener('click', async () => {
      // v1033: на больших облаках JS-чистка (SOR/кластеры) морозит UI-поток и «висит».
      // Если есть сохранённый файл и готовый Python/CloudCompare-движок — отдаём тяжёлую работу нативному движку (секунды вместо зависания).
      let _routeNative = false;
      try {
        const _cc = (viewer && viewer.getEditedCloud) ? viewer.getEditedCloud() : null;
        const _ptN = (_cc && _cc.pos) ? _cc.pos.length / 3 : 0;
        const _fp0 = (typeof curCloudPath === 'function') ? curCloudPath() : null;
        const _fileOk0 = _fp0 && /\.(ply|las|laz|e57|pcd|xyz|pts|xyzrgb)$/i.test(_fp0);
        if (_ptN > 1500000 && _fileOk0 && API && API.cleanCloud) {
          let _eng0 = null; try { if (API.cleanStatus) _eng0 = await API.cleanStatus(); } catch (e) {}
          const _isPly0 = /\.ply$/i.test(_fp0);
          const _ccDirect0 = /\.(ply|las|laz|e57|pcd|pts|xyz|xyzrgb)$/i.test(_fp0);
          // v1041 (исправление «вечного зависания»): маршрутизируем в нативный движок
          // ТОЛЬКО когда он НЕ будет синхронно парсить гигантский файл в main-процессе
          // (иначе UI «виснет»): CloudCompare сам открывает LAS/LAZ/E57/… — безопасно;
          // Open3D/NumPy парсят не-PLY в main → берём их только для .ply.
          if (_eng0 && _eng0.cloudCompare && _ccDirect0) _routeNative = true;
          else if (_eng0 && (_eng0.open3d || _eng0.numpy) && _isPly0) _routeNative = true;
          else _routeNative = false;
        }
      } catch (e) {}
      // БЫСТРАЯ чистка ПРЯМО в приложении (без Python): воксельный фильтр плотности.
      try {
        const _c0 = (viewer && viewer.getEditedCloud) ? viewer.getEditedCloud() : null;
        if (_c0 && _c0.pos && _c0.pos.length && viewer.cleanInApp && window.PCEdit && window.PCEdit.cleanVoxelDensity) {
          if (geomBusy) { toast('Идёт обработка — дождитесь завершения'); return; }
          cln.classList.add('on'); cln.classList.add('busy'); cln.disabled = true;
          const _cs = beginProgress('Чистка облака…');
          toast('Чистка облака (фильтр плотности, без Python)…');
          await new Promise(function (res) { setTimeout(res, 40); });
          let removed = 0, remN = 0, remC = 0;
          const minPts = 6 + clnStep * 3;                 // шум: 6, 9, 12, ...
          const clPts = Math.round(120 * Math.pow(2, clnStep)); // кластеры: 120, 240, 480, ...
          try {
            if (viewer.cleanAutoInApp && window.PCEdit && window.PCEdit.cleanAuto) {
              const _ai = viewer.cleanAutoInApp({ maxPasses: 3 }) || null;
              window.__lastAutoClean = _ai;
              remN = _ai && _ai.breakdown ? ((_ai.breakdown.sor | 0) + (_ai.breakdown.density | 0)) : 0;
              remC = _ai && _ai.breakdown ? (_ai.breakdown.clusters | 0) : 0;
              removed = _ai ? (_ai.removed | 0) : 0;
            } else {
              remN = viewer.cleanInApp({ minPts: minPts }) | 0;
              await new Promise(function (res) { setTimeout(res, 20); });
              if (viewer.cleanClustersInApp && window.PCEdit && window.PCEdit.cleanClusters) {
                remC = viewer.cleanClustersInApp({ minClusterPts: clPts, connect: 4 }) | 0;
              }
              removed = remN + remC;
            }
            clnStep++;
          }
          catch (e) { toast('Ошибка чистки: ' + ((e && e.message) || e)); }
          finally { cln.classList.remove('on'); cln.classList.remove('busy'); cln.disabled = false; if (_cs) { try { _cs(); } catch (e) {} } }
          if (removed > 0) {
            var _ap = (window.__lastAutoClean && window.__lastAutoClean.passes) ? (' за ' + window.__lastAutoClean.passes + ' прох.') : ''; toast('Очищено с одного раза' + _ap + ': шум ' + nfmt(remN) + ' + отсоединённые кластеры ' + nfmt(remC) + ' точек · людей/мебель на полу — «Правка облака» → лассо → «Удалить» · Ctrl+Z отмена');
          } else {
            toast('Отсоединённого мусора не найдено. Объекты, связанные с полом (люди, мебель), удаляются вручную: «Правка облака» → лассо → «Удалить»');
          }
          return;
        }
      } catch (e) { console.warn('inapp clean', e); }
      if (!API || !API.cleanCloud) { toast('Очистка доступна в десктоп-версии'); return; }
      const _cp = curCloudPath(); if (!_cp || !/\.(ply|las|laz|e57|pcd|xyz|pts|xyzrgb)$/i.test(_cp)) { toast('Сначала выберите помещение с сохранённым облаком'); return; }
      if (geomBusy) { toast('Идёт обработка облака — дождитесь завершения'); return; }
      // v1041 (исправление зависания): НИКОГДА не уходим в блокирующий нативный путь,
      // если он подвесит main-процесс (напр. Open3D/NumPy на огромном LAS). Для потоковых
      // облаков без буфера правки предлагаем ручную правку или CloudCompare.
      let _engB = null; try { if (API.cleanStatus) _engB = await API.cleanStatus(); } catch (e) {}
      const _isPlyB = /\.ply$/i.test(_cp);
      const _ccDirectB = /\.(ply|las|laz|e57|pcd|pts|xyz|xyzrgb)$/i.test(_cp);
      const _nativeSafe = !!(_engB && ((_engB.cloudCompare && _ccDirectB) || ((_engB.open3d || _engB.numpy) && _isPlyB)));
      if (!_nativeSafe) {
        toast('Это облако не загружено в буфер правки, а быстрая авто-очистка для него может повесить приложение. Используйте «Правка» (лассо/кисть) или «Редактировать в CloudCompare» — там есть SOR/сегментация.');
        return;
      }
      cln.classList.add('on'); cln.classList.add('busy'); cln.disabled = true; geomBusy = true;
      const _cs = beginProgress('Очистка облака…');
      toast('Очистка облака (удаление шума/выбросов/«лучей»)… это может занять время');
      try {
        // Сторож: даже если нативный движок зависнет — спиннер не крутится вечно.
        // v1042: сторож 12 мин (авто-очистка теперь прореживает гигантские облака в main).
        // При таймауте РЕАЛЬНО убиваем процесс CloudCompare (раньше он оставался висеть в фоне).
        let _wd; const _wdP = new Promise((res) => { _wd = setTimeout(() => res({ ok: false, _uiTimeout: true }), 12 * 60 * 1000); });
        const r = await Promise.race([API.cleanCloud({ path: _cp, ops: [{ type: 'auto' }], count: (lastCloudCount || 0) }), _wdP]);
        try { clearTimeout(_wd); } catch (e) {}
        if (r && r._uiTimeout) {
          try { if (API.cleanAbort) await API.cleanAbort(); } catch (e) {}
          toast('Очистка идёт слишком долго — процесс остановлен. Для очень больших облаков откройте «Редактировать в CloudCompare» (SOR/сегментация вручную).');
        } else if (r && r.ok) {
          const remTxt = (r.removed == null) ? '?' : r.removed.toLocaleString('ru-RU');
          const eng = r.engine === 'cloudcompare' ? 'CloudCompare' : (r.engine === 'open3d' ? 'Open3D' : 'NumPy');
          try {
            const pr = await API.parseCloud(r.path);
            if (pr && pr.ok) { if (pr.kind === 'mesh') viewer.loadColoredMesh(pr); else { viewer.loadCloud(pr, { preserveView: true, sourceName:r.path }); cacheCloud(r.path, pr); } lastCloudPath = r.path; lastCloudCount = (pr.meta && pr.meta.points) || 0; }
          } catch (e) { console.warn('reload after clean', e); }
          toast('Очищено (' + eng + '): удалено ' + remTxt + ' точек · сохранено: ' + r.path);
        } else if (r && r.needPython) {
          toast('Нужен Python 3. Откройте «Облако → Геометрия → Установить Open3D + SciPy»');
        } else {
          toast('Не удалось очистить: ' + ((r && r.error) || 'ошибка'));
        }
      } catch (e) { toast('Ошибка очистки'); }
      finally { cln.classList.remove('on'); cln.classList.remove('busy'); cln.disabled = false; geomBusy = false; if (_cs) { try { _cs(); } catch (e) {} } }
    });
    // ───── Консоль действий (встроенный лог для отладки) ─────
    // ЕДИНОЕ меню чистки: одна кнопка -> выбор инструмента (ручное лассо / авто-очистка / сохранить / отмена)
    // v1041: CloudCompare ВСТРОЕН прямо в окно BIM Twin (Windows) — репарентинг нативного окна
    // в панель поверх сцены. Та же кнопка «Редактировать в CloudCompare». По «Готово»
    // окно CloudCompare закрывается и результат переимпортируется. Возвращает {external:true},
    // если встроить не удалось — когда вызывающий код откроет CloudCompare отдельным окном.
    async function startCCEmbedded(p) {
      if (geomBusy) { toast('Идёт обработка — дождитесь завершения'); return { external: false }; }
      const stage = document.querySelector('.stage');
      if (!stage) return { external: true };
      if (document.getElementById('ccEmbedHost')) return { external: false };
      const host = document.createElement('div'); host.id = 'ccEmbedHost';
      host.style.cssText = 'position:absolute;inset:0;z-index:9000;display:flex;flex-direction:column;background:#141414';
      const bar = document.createElement('div');
      bar.style.cssText = 'flex:0 0 40px;display:flex;align-items:center;gap:10px;padding:0 12px;background:var(--panel);border-bottom:1px solid var(--line);color:var(--txt);font-size:12px';
      const info = document.createElement('div'); info.style.cssText = 'flex:1;white-space:normal;line-height:1.3';
      info.innerHTML = '<b style="color:var(--ok)">CloudCompare</b> — встроен в BIM Twin. Отредактируйте облако (вырезание, сегментация, SOR/шум), затем <b>Ctrl+S → PLY</b> (поверх файла) и нажмите «Готово».';
      const doneBtn = document.createElement('button'); doneBtn.innerHTML = IB('check', 'Готово и переимпортировать');
      doneBtn.style.cssText = 'background:var(--ok);border:1px solid var(--ok);border-radius:6px;color:#fff;padding:7px 12px;cursor:pointer;font-weight:600;white-space:nowrap';
      const cancelBtn = document.createElement('button'); cancelBtn.innerHTML = IB('x', 'Закрыть');
      cancelBtn.style.cssText = 'background:var(--panel2);border:1px solid var(--line);border-radius:6px;color:var(--txt);padding:7px 12px;cursor:pointer;white-space:nowrap';
      bar.appendChild(info); bar.appendChild(doneBtn); bar.appendChild(cancelBtn);
      const body = document.createElement('div'); body.id = 'ccEmbedBody';
      body.style.cssText = 'flex:1;position:relative;background:#0b0b0b';
      const hint = document.createElement('div');
      hint.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9aa;font-size:13px;text-align:center;padding:20px';
      hint.textContent = 'Запуск CloudCompare… (первый старт может занять несколько секунд)';
      body.appendChild(hint);
      host.appendChild(bar); host.appendChild(body); stage.appendChild(host);
      const rectBounds = () => {
        const r = body.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
        return { x: Math.round(r.left * dpr), y: Math.round(r.top * dpr), w: Math.round(r.width * dpr), h: Math.round(r.height * dpr) };
      };
      const sendBounds = () => { try { if (API && API.ccEmbedBounds) API.ccEmbedBounds(rectBounds()); } catch (e) {} };
      const onResize = () => sendBounds();
      window.addEventListener('resize', onResize);
      let ro = null; try { ro = new ResizeObserver(() => sendBounds()); ro.observe(body); } catch (e) {}
      // Пока CloudCompare стартует, его окно появляется не сразу — несколько раз поправим позицию.
      const nudges = [400, 900, 1500, 2500, 4000, 6000].map((t) => setTimeout(sendBounds, t));
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return; cleaned = true;
        try { window.removeEventListener('resize', onResize); } catch (e) {}
        try { if (ro) ro.disconnect(); } catch (e) {}
        nudges.forEach((n) => { try { clearTimeout(n); } catch (e) {} });
        try { if (host && host.parentNode) host.parentNode.removeChild(host); } catch (e) {}
      };
      let closing = false;
      const doClose = async () => { if (closing) return; closing = true; try { if (API && API.ccEmbedClose) await API.ccEmbedClose(); } catch (e) {} };
      doneBtn.onclick = async () => { doneBtn.disabled = true; doneBtn.textContent = 'Переимпорт…'; await doClose(); };
      cancelBtn.onclick = async () => { cancelBtn.disabled = true; await doClose(); };
      geomBusy = true;
      toast('CloudCompare встроен в окно. Ctrl+S → PLY, затем «Готово»');
      try {
        const r = await API.embedCloudCompare({ path: p, bounds: rectBounds() });
        if (r && r.fallbackExternal) { cleanup(); geomBusy = false; return { external: true }; }
        if (r && r.ok && r.changed) {
          try {
            const pr = await API.parseCloud(r.path);
            if (pr && pr.ok) { if (pr.kind === 'mesh') viewer.loadColoredMesh(pr); else { viewer.loadCloud(pr, { preserveView: true, sourceName:r.path }); cacheCloud(r.path, pr); } lastCloudPath = r.path; lastCloudCount = (pr.meta && pr.meta.points) || 0; }
            toast('Готово: облако обновлено из CloudCompare' + (r.outputCount != null ? (' (' + r.outputCount.toLocaleString('ru-RU') + ' точек)') : ''));
          } catch (e) { toast('Отредактировано, но не удалось переимпортировать: ' + r.path); }
        } else if (r && r.ok && !r.changed) { toast('Изменений не обнаружено (сохраните поверх открытого файла: Ctrl+S → PLY)'); }
        else if (r && r.needCloudCompare) { cleanup(); geomBusy = false; return { external: true }; }
        else { toast('Не удалось встроить CloudCompare: ' + ((r && r.error) || 'ошибка')); }
      } catch (e) { toast('Ошибка встроенного CloudCompare'); }
      finally { cleanup(); geomBusy = false; }
      return { external: false };
    }

    function pointCloudArrayUnavailableMessage() {
      if (viewer && viewer.octreeActive && viewer.octreeActive()) return 'Операция требует полный массив точек и недоступна в «Поток LOD». Выключите «Поток LOD» и повторите.';
      return 'Сначала откройте облако точек';
    }
    const tbTools = $('vtTools');
    if (tbTools) {
      tbTools.addEventListener('click', () => {
        if (document.getElementById('cleanMenu')) { window.__lxKit.closePopover(); return; }
        const edOn = () => { const e2 = $('vtEdit'); return !!(e2 && e2.classList.contains('on')); };
        const on = edOn();
        const menu = document.createElement('div');
        const MI = (ico, text) => ({ ico, text });
        const head = document.createElement('div'); head.textContent = 'Чистка облака точек'; head.className = 'lx-pop-title'; menu.appendChild(head);
        // v1029: бейдж активного движка очистки (заполняется асинхронно ниже).
        const engBadge = document.createElement('div'); engBadge.id = 'cleanEngine'; engBadge.className = 'lx-pop-eng'; engBadge.innerHTML = '<i></i><span>Движок очистки: проверяю…</span>'; menu.appendChild(engBadge);
        var cleanParams = (window.cleanParams = window.cleanParams || { k:16, stdRatio:1.0, minNeighbors:4, voxelFactor:2, protectWidth:60, protectSens:50, smartProtect:true });
        const items = [
          { head: 'Ручная правка' },
          [MI('pencil-ruler', 'Редактировать в CloudCompare (готовый редактор)'), 'Открывает облако в CloudCompare (вырезание, сегментация, SOR/шум). Сохраните поверх файла (Ctrl+S → PLY) и закройте — результат переимпортируется', async () => {
            try {
              if (!(typeof API !== 'undefined' && API && API.editInCloudCompare)) { toast('Доступно в десктоп-версии'); return; }
              const p = (typeof curCloudPath === 'function') ? curCloudPath() : null;
              if (!p || !/\.(ply|las|laz|e57|pcd|xyz|pts|xyzrgb)$/i.test(p)) { toast('Сначала выберите помещение с сохранённым облаком'); return; }
              let st = null; try { st = await API.ccStatus(); } catch (e) {}
              if (!st || !st.cloudCompare) {
                toast('CloudCompare не найден. Скачиваю и устанавливаю автоматически… это может занять несколько минут');
                const _ds = beginProgress('Загрузка CloudCompare…');
                try { const dr = (API.downloadCloudCompare ? await API.downloadCloudCompare() : null); if (dr && dr.ok) { try { st = await API.ccStatus(); } catch (e) {} } } catch (e) {} finally { if (_ds) { try { _ds(); } catch (e) {} } }
                if (!st || !st.cloudCompare) { try { await API.installCloudCompare(); } catch (e) {} toast('Не удалось установить автоматически — открыл страницу загрузки и папку'); return; }
              }
              if (geomBusy) { toast('Идёт обработка — дождитесь завершения'); return; }
              // v1041: на Windows сначала пробуем ВСТРОЕННЫЙ режим (CloudCompare внутри окна).
              // Если встроить не удалось (не-Windows / сбой) — падаем на внешнее окно (как раньше).
              if ((typeof API !== 'undefined') && API && API.platform === 'win32' && API.embedCloudCompare && (typeof startCCEmbedded === 'function')) {
                const _emb = await startCCEmbedded(p);
                if (!_emb || !_emb.external) return;
                toast('Встроенный режим недоступен — открываю CloudCompare отдельным окном');
              }
              toast('Открываю CloudCompare… Отредактируйте облако, сохраните поверх файла (Ctrl+S → PLY) и закройте окно');
              const _cs = beginProgress('Редактирование в CloudCompare…'); geomBusy = true;
              try {
                const r = await API.editInCloudCompare({ path: p });
                if (r && r.ok && r.changed) {
                  try {
                    const pr = await API.parseCloud(r.path);
                    if (pr && pr.ok) { if (pr.kind === 'mesh') viewer.loadColoredMesh(pr); else { viewer.loadCloud(pr, { preserveView: true, sourceName:r.path }); cacheCloud(r.path, pr); } lastCloudPath = r.path; lastCloudCount = (pr.meta && pr.meta.points) || 0; }
                    toast('Готово: облако обновлено из CloudCompare' + (r.outputCount != null ? (' (' + r.outputCount.toLocaleString('ru-RU') + ' точек)') : ''));
                  } catch (e) { toast('Отредактировано, но не удалось переимпортировать: ' + r.path); }
                } else if (r && r.ok && !r.changed) { toast('Изменений не обнаружено (сохраните поверх открытого файла: Ctrl+S → PLY)'); }
                else if (r && r.needCloudCompare) { toast('CloudCompare не найден'); try { await API.installCloudCompare(); } catch (e) {} }
                else { toast('Не удалось открыть в CloudCompare: ' + ((r && r.error) || 'ошибка')); }
              } finally { geomBusy = false; if (_cs) { try { _cs(); } catch (e) {} } }
            } catch (e) { toast('Ошибка запуска CloudCompare'); }
          }],
          [on ? MI('check', 'Ручное лассо — выключить') : MI('lasso-select', 'Ручное лассо — удалить лишнее'), on ? 'Режим включён. Обведите мусор мышью → Enter или «Удалить». Нажмите, чтобы выйти' : 'Обведите мусор мышью → Enter или «Удалить». Люди и мебель на полу убираются только так', () => { const e2 = $('vtEdit'); if (e2) e2.click(); setTimeout(() => { try { tbTools.classList.toggle('on', edOn()); } catch (e) {} }, 0); }],
          { head: 'Автоматическая очистка' },
          [MI('sparkles', 'Авто-очистка: шум + мусор'), 'Быстро убирает шум и отсоединённые кластеры. Нажимайте повторно = сильнее', () => { const c = $('vtClean'); if (c) c.click(); }],
          [MI('puzzle', 'Убрать мелкие островки точек'), 'Убирает отдельные сгустки И одиночные висящие точки-«мушки», не связанные с основной геометрией (Connected Components + тесный radius). Поверхности сохраняются. Ctrl+Z — отмена', () => { if (!viewer || !viewer.cleanIslandsInApp) { toast('Недоступно в этом режиме'); return; } if (typeof geomBusy !== 'undefined' && geomBusy) { toast('Идёт обработка — дождитесь завершения'); return; } const ec = (viewer.getEditedCloud && viewer.getEditedCloud()); if (!ec || !ec.pos || !ec.pos.length) { toast(pointCloudArrayUnavailableMessage()); return; } const rem = viewer.cleanIslandsInApp({}); if (rem > 0) toast('Убрано мелких островков: ' + nfmt(rem) + ' точек · Ctrl+Z — отмена'); else toast('Отдельных мелких кластеров не найдено — всё связано с основной геометрией'); }],
          [MI('cloud-fog', 'Убрать редкие «мушки» (radius outlier)'), 'Удаляет точки, у которых мало соседей в заданном радиусе — редкий шум, который пропускает SOR (как remove_radius_outlier в Open3D). Ctrl+Z — отмена', () => { if (!viewer || !viewer.cleanRadiusInApp) { toast('Недоступно в этом режиме'); return; } if (typeof geomBusy !== 'undefined' && geomBusy) { toast('Идёт обработка — дождитесь завершения'); return; } const ec = (viewer.getEditedCloud && viewer.getEditedCloud()); if (!ec || !ec.pos || !ec.pos.length) { toast(pointCloudArrayUnavailableMessage()); return; } const rem = viewer.cleanRadiusInApp({ minNeighbors: (cleanParams && cleanParams.minNeighbors) || 4 }); if (rem > 0) toast('Удалено редких точек: ' + nfmt(rem) + ' · Ctrl+Z — отмена'); else toast('Редких изолированных точек не найдено'); }],
          [MI('feather', 'Фильтр шума по поверхности (noise filter)'), 'Убирает точки, выступающие над локальной плоскостью стен/пола — сглаживает «толщину» поверхности (как Noise filter в CloudCompare). Ctrl+Z — отмена', () => { if (!viewer || !viewer.noiseFilterInApp) { toast('Недоступно в этом режиме'); return; } if (typeof geomBusy !== 'undefined' && geomBusy) { toast('Идёт обработка — дождитесь завершения'); return; } const ec = (viewer.getEditedCloud && viewer.getEditedCloud()); if (!ec || !ec.pos || !ec.pos.length) { toast(pointCloudArrayUnavailableMessage()); return; } const rem = viewer.noiseFilterInApp({ stdRatio: (cleanParams && cleanParams.stdRatio) || 1.0, k: (cleanParams && cleanParams.k) || 16 }); if (rem > 0) toast('Сглажено (удалено шумовых точек): ' + nfmt(rem) + ' · Ctrl+Z — отмена'); else toast('Шумовых выступов над поверхностью не найдено'); }],
          { head: 'Защита и разметка' },
          [MI('shield', 'Защита конструктива (лассо не режет пол, стены, потолок)'), 'ВКЛ по умолчанию при ручном лассо: пол, стены и потолок (RANSAC) не удаляются — режется только объект. Здесь можно включить/выключить и увидеть, сколько плоскостей распознано', () => { if (!viewer || !viewer.setPlaneProtect) { toast('Недоступно в этом режиме'); return; } const cur = viewer.getPlaneProtect ? viewer.getPlaneProtect() : true; const nv = !cur; viewer.setPlaneProtect(nv); const np = (viewer._planes && viewer._planes.length) || 0; const eP = document.getElementById('edProtect'); if (eP) { eP.classList.toggle('on', nv); } toast(nv ? ('Защита конструктива ВКЛ · распознано плоскостей: ' + np + (np ? '' : ' — мало данных в кадре, отдалите камеру и повторите')) : 'Защита ВЫКЛ — лассо удаляет всё внутри контура'); }],
          [MI('tag', 'Назначить LAS-класс выделенным точкам'), 'Вручную назначает выбранным точкам код ASPRS LAS 0–255 (например, 2 — грунт, 6 — здание). Ctrl+Z отменяет и восстанавливает метки проекта', async () => {
            if (!viewer || !viewer.assignClassificationInApp) { toast('Недоступно в этом режиме'); return; }
            if (typeof geomBusy !== 'undefined' && geomBusy) { toast('Идёт обработка — дождитесь завершения'); return; }
            if (!viewer.selectionCount || !viewer.selectionCount()) { toast('Сначала выделите точки лассо или рамкой'); return; }
            if (!window.__lxKit || !window.__lxKit.ask) { toast('Ввод кода класса недоступен в этом режиме'); return; }
            const answer = await window.__lxKit.ask({ title: 'Класс LAS', message: 'Код класса ASPRS LAS — целое число от 0 до 255. Например: 2 — грунт, 6 — здание.', input: true, type: 'number', min: 0, max: 255, step: 1, value: '6', okLabel: 'Назначить', validate: v => (/^[0-9]{1,3}$/.test(String(v).trim()) && Number(v) <= 255) ? null : 'Введите целый код класса от 0 до 255' });
            if (answer == null) return;
            const text = String(answer).trim();
            if (!/^[0-9]{1,3}$/.test(text) || Number(text) > 255) { toast('Введите целый код класса от 0 до 255'); return; }
            const result = viewer.assignClassificationInApp(Number(text));
            if (!result || !result.ok) {
              const messages = {
                no_selected_points: 'Сначала выделите точки лассо или рамкой',
                streaming_cloud_edit_not_supported: 'Для ручной разметки отключите потоковый LOD и загрузите облако полностью',
                partial_cloud_edit_not_supported: 'Разметка отключена для выборочного облака: загрузите все точки без прореживания',
                classification_point_count_mismatch: 'Число меток не совпадает с числом точек — разметка отменена'
              };
              toast(messages[result && result.error] || ('Не удалось назначить класс: ' + ((result && result.error) || 'ошибка')));
              return;
            }
            if (result.unchanged) { toast('Выделенные точки уже имеют этот класс'); return; }
            toast('Назначен LAS-класс ' + result.classCode + ' точкам: ' + nfmt(result.changed) + ' · Ctrl+Z — отмена');
            if (viewer._lastClassificationPromise) viewer._lastClassificationPromise.then(r => {
              if (r && r.ok) toast('Разметка сохранена в проекте');
              else toast('Разметка применена, но не сохранена в проект: ' + ((r && (r.message || r.error)) || 'ошибка'));
            });
          }],
          [MI('layout-grid', 'Разметить конструктив (пол, стены, потолок)'), 'RANSAC определяет пол, стены и потолок и выделяет всё остальное (мебель/люди/шум) для проверки перед удалением. Затем «Удалить» или Ctrl+Z', () => { if (!viewer || !viewer.classifyInApp) { toast('Недоступно в этом режиме'); return; } if (typeof geomBusy !== 'undefined' && geomBusy) { toast('Идёт обработка — дождитесь завершения'); return; } const ec = (viewer.getEditedCloud && viewer.getEditedCloud()); if (!ec || !ec.pos || !ec.pos.length) { toast(pointCloudArrayUnavailableMessage()); return; } const c = viewer.classifyInApp({ selectClass: 0 }); if (!c) { toast('Не удалось классифицировать'); return; } toast('Пол ' + nfmt(c.floor) + ' · стены ' + nfmt(c.wall) + ' · потолок ' + nfmt(c.ceiling) + ' · прочее ' + nfmt(c.other) + ' (выделено «прочее» — проверьте)'); if (viewer._lastClassificationPromise) viewer._lastClassificationPromise.then(r => { if (r && r.ok) toast('Метки классификации сохранены в проекте'); else toast('Метки рассчитаны, но не сохранены: ' + ((r && (r.message || r.error)) || 'ошибка')); }); }],
          { head: 'Вид и файл' },
          [MI('frame', 'Обводка точек чёрным: ' + ((viewer && viewer._edl) ? 'вкл' : 'выкл')), 'Возвращает тонкую чёрную обводку вокруг точек (эффект EDL) — помогает различать отдельные точки и грани при редактировании. По умолчанию выкл. Нажмите, чтобы переключить', () => { if (!viewer || !viewer.setEDL) { toast('Доступно в 3D-режиме (WebGL)'); return; } const on = !viewer._edl; const ok = viewer.setEDL(on); if (on && !ok) { toast('Обводка (EDL) недоступна на этом GPU'); return; } const qE = $('qEDL'); if (qE) { qE.classList.toggle('on', on); } toast(on ? 'Чёрная обводка точек включена' : 'Чёрная обводка точек выключена'); }],
          [MI('save', 'Сохранить облако (.ply)'), 'Сохранить результат правки в файл', () => { const s = $('edSave'); if (s) s.click(); else toast('Сначала включите «Ручное лассо»'); }],
          [MI('undo-2', 'Отменить (Ctrl+Z)'), 'Отменить последнее удаление', () => { const u = $('edUndo'); if (u && u.offsetParent !== null) u.click(); else if (viewer && viewer.undoEdit) viewer.undoEdit(); }],
        ];
        items.forEach(row => {
          if (row.head) { const h2 = document.createElement('div'); h2.className = 'lx-pop-title'; h2.textContent = row.head; menu.appendChild(h2); return; }
          menu.appendChild(window.__lxKit.menuItem({ ico: row[0].ico, label: row[0].text, sub: row[1], onClick: row[2] }));
        });
        // v1046: параметры фильтров (k, std-ratio, соседи, воксель, защита плоскостей).
        (function () {
          const wrap = document.createElement('div'); wrap.className = 'lx-pop-params';
          const tt = document.createElement('div'); tt.className = 'lx-pop-title'; tt.textContent = 'Параметры фильтров'; wrap.appendChild(tt);
          const row = (label, ctl, cls) => { const rw = document.createElement('label'); rw.className = 'lx-pop-row' + (cls ? ' ' + cls : ''); const sp = document.createElement('span'); sp.textContent = label; rw.append(sp, ctl); wrap.appendChild(rw); return rw; };
          const num = (label, key, step, min) => { const inp = document.createElement('input'); inp.type = 'number'; inp.step = String(step); if (min != null) inp.min = String(min); inp.value = String(cleanParams[key]); inp.onchange = () => { const v = parseFloat(inp.value); if (isFinite(v)) cleanParams[key] = v; }; row(label, inp); };
          const range = (label, min, max, step, value, fmt, apply) => {
            const rng = document.createElement('input'); rng.type = 'range'; rng.min = String(min); rng.max = String(max); rng.step = String(step); rng.value = String(value);
            const out = document.createElement('output'); out.textContent = fmt(value);
            const rw = row(label, out, 'lx-pop-range'); rw.appendChild(rng);
            rng.oninput = () => { const v = parseFloat(rng.value); if (isFinite(v)) { out.textContent = fmt(v); apply(v); } };
          };
          num('Соседей k (SOR, шум)', 'k', 1, 1);
          num('std-ratio (агрессивность)', 'stdRatio', 0.1, 0.1);
          num('Мин. соседей (radius)', 'minNeighbors', 1, 1);
          num('Фактор вокселя (прореживание)', 'voxelFactor', 0.5, 0.5);
          // v1054: ширина защиты стен/пола/потолка (мм). Живо влияет на ручное лассо.
          if (cleanParams.protectWidth == null) cleanParams.protectWidth = 60;
          range('Ширина защиты стен', 15, 150, 5, cleanParams.protectWidth, v => v + ' мм', v => { cleanParams.protectWidth = v; if (viewer && viewer.setProtectWidth) viewer.setProtectWidth(v); });
          if (viewer && viewer.setProtectWidth) viewer.setProtectWidth(cleanParams.protectWidth);
          // v1055: «защита мелких участков» — minFrac (какая доля точек считается поверхностью).
          // Лево = защищаем только крупные плоскости (мусор на полу удаляется); право = бережём даже мелкие/шероховатые.
          if (cleanParams.protectSens == null) cleanParams.protectSens = 50;
          const psMinFrac = (S) => Math.max(0.05, Math.min(0.20, 0.20 - (S - 1) / 99 * 0.15));
          range('Защита мелких участков', 1, 100, 1, cleanParams.protectSens, v => v + '%', v => { cleanParams.protectSens = v; if (viewer && viewer.setProtectMinFrac) viewer.setProtectMinFrac(psMinFrac(v)); });
          if (viewer && viewer.setProtectMinFrac) viewer.setProtectMinFrac(psMinFrac(cleanParams.protectSens));
          // v1056: «умная защита» — автоотличие крупной поверхности от мусора/предметов на ней.
          if (cleanParams.smartProtect == null) cleanParams.smartProtect = true;
          const smChk = document.createElement('input'); smChk.type = 'checkbox'; smChk.checked = !!cleanParams.smartProtect;
          smChk.onchange = () => { cleanParams.smartProtect = !!smChk.checked; if (viewer && viewer.setSmartProtect) viewer.setSmartProtect(cleanParams.smartProtect); };
          row('Умная защита (поверхность ≠ мусор)', smChk, 'lx-pop-check');
          if (viewer && viewer.setSmartProtect) viewer.setSmartProtect(cleanParams.smartProtect);
          menu.appendChild(wrap);
        })();
        window.__lxKit.popover({ anchor: tbTools, content: menu, id: 'cleanMenu', minWidth: 360, label: 'Чистка облака' });
        // v1029: определить и показать активный движок; если Open3D/CloudCompare нет — предложить автоустановку.
        (async () => {
          const eb = document.getElementById('cleanEngine'); if (!eb) return;
          const setEng = (text, tone) => { eb.setAttribute('data-tone', tone || 'muted'); const sp = eb.querySelector('span'); if (sp) sp.textContent = 'Движок очистки: ' + text; };
          try {
            if (!(typeof API !== 'undefined' && API && API.cleanStatus)) { setEng('браузерный (в приложении)', 'muted'); return; }
            const st = await API.cleanStatus();
            let label = 'браузерный (в приложении)', color = 'muted';
            if (st && st.cloudCompare) { label = 'CloudCompare (макс. качество)'; color = 'ok'; }
            else if (st && st.open3d) { label = 'Open3D (полный конвейер)'; color = 'ok'; }
            else if (st && st.numpy) { label = 'NumPy (базовый Python)'; color = 'warn'; }
            else if (st && st.python) { label = 'Python есть, пакеты не найдены'; color = 'warn'; }
            setEng(label, color);
            if (st && !st.open3d && !st.cloudCompare && (typeof CAN_PERSIST === 'undefined' || CAN_PERSIST) && API.installPyDeps) {
              menu.appendChild(window.__lxKit.menuItem({ ico: 'download', label: 'Установить Open3D (макс. качество)', sub: 'Автоматически: изолированный Python + Open3D, без прав администратора',
                onClick: async () => { try { const r = await API.installPyDeps(); toast((r && r.message) || 'Запущена установка Open3D…'); } catch (e) { toast('Не удалось запустить установку'); } } }));
            }
            if ((!st || !st.cloudCompare) && API.installCloudCompare) {
              menu.appendChild(window.__lxKit.menuItem({ ico: 'download', label: 'Подключить CloudCompare (готовый редактор)', sub: 'Открыть страницу загрузки и папку приложения — распакуйте туда CloudCompare.exe',
                onClick: async () => { const _ds = beginProgress('Загрузка CloudCompare…'); try { toast('Скачиваю и устанавливаю CloudCompare… это может занять несколько минут'); const r = (API.downloadCloudCompare ? await API.downloadCloudCompare() : null); if (r && r.ok) { toast('CloudCompare установлен — откройте меню и нажмите «Редактировать в CloudCompare»'); } else { const r2 = await API.installCloudCompare(); toast((r2 && r2.message) || 'Открыта папка для CloudCompare'); } } catch (e) { try { await API.installCloudCompare(); } catch (e2) {} toast('Открыл страницу загрузки CloudCompare'); } finally { if (_ds) { try { _ds(); } catch (e) {} } } } }));
            }
          } catch (e) { setEng('браузерный (в приложении)', 'muted'); }
        })();
      });
    }
    (function setupDevConsole() {
      const panel = $('devConsole'); const body = $('dcBody');
      if (body) { __bimLog.el = body; if (!body.__inited) { body.__inited = true; body.innerHTML = ''; __bimLog.buf.forEach(__bimLogRender); body.scrollTop = body.scrollHeight; } }
      const stage = document.querySelector('.stage');
      let dockH = 232; // высота консоли (px) — можно тянуть мышью
      const applyH = (h) => { dockH = Math.max(90, Math.min(Math.round(window.innerHeight * 0.8), Math.round(h))); if (panel && !panel.classList.contains('collapsed')) { panel.style.height = dockH + 'px'; if (stage) stage.style.setProperty('--dc-h', dockH + 'px'); } };
      const setCollapsed = (col) => { if (!panel) return; panel.classList.toggle('collapsed', col); if (stage) stage.classList.toggle('console-collapsed', col); if (col) { panel.style.height = ''; if (stage) stage.style.removeProperty('--dc-h'); } else { panel.style.height = dockH + 'px'; if (stage) stage.style.setProperty('--dc-h', dockH + 'px'); } const lb2 = $('vtLog'); if (lb2) lb2.classList.toggle('on', !col); try { window.dispatchEvent(new Event('resize')); } catch (e) {} if (!col && body) body.scrollTop = body.scrollHeight; };
      if (panel && !panel.__resizer) { panel.__resizer = true; const grip = document.createElement('div'); grip.className = 'dc-resize'; grip.title = 'Потяните вверх/вниз, чтобы изменить высоту консоли'; panel.insertBefore(grip, panel.firstChild); let drag = null; grip.addEventListener('mousedown', (e) => { if (panel.classList.contains('collapsed')) return; drag = { y: e.clientY, h: panel.getBoundingClientRect().height }; document.body.style.userSelect = 'none'; e.preventDefault(); }); window.addEventListener('mousemove', (e) => { if (!drag) return; applyH(drag.h + (drag.y - e.clientY)); if (!panel.__raf) panel.__raf = requestAnimationFrame(() => { panel.__raf = 0; try { window.dispatchEvent(new Event('resize')); } catch (er) {} }); }); window.addEventListener('mouseup', () => { if (!drag) return; drag = null; document.body.style.userSelect = ''; try { window.dispatchEvent(new Event('resize')); } catch (e) {} }); }
      applyH(dockH); setCollapsed(true);
      const lb = $('vtLog'); if (lb) { lb.classList.remove('on'); lb.addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed'))); }
      const cl = $('dcClose'); if (cl) { cl.title = 'Свернуть/развернуть консоль'; cl.addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed'))); }
      const cc = $('dcClear'); if (cc) cc.addEventListener('click', () => { __bimLog.buf.length = 0; if (body) body.innerHTML = ''; bimLog('info', 'Консоль очищена'); });
      const cp = $('dcCopy'); if (cp) cp.addEventListener('click', async () => { const txt = __bimLog.buf.map((e) => { const d = new Date(e.t); return d.toLocaleTimeString('ru-RU') + ' [' + e.level + '] ' + e.msg; }).join('\n'); try { await navigator.clipboard.writeText(txt); toast('Лог скопирован (' + __bimLog.buf.length + ' строк)'); } catch (e) { toast('Не удалось скопировать'); } });
      if (!document.__bimClickLog) { document.__bimClickLog = true; document.addEventListener('click', (ev) => { const b = ev.target && ev.target.closest ? ev.target.closest('button, .btn, .vtool, .vc') : null; if (!b) return; if (b.closest && b.closest('#devConsole')) return; const label = (b.title || (b.textContent || '').trim() || b.id || 'кнопка').slice(0, 48); bimLog('click', label + (b.id ? ' #' + b.id : '')); }, true); }
      bimLog('info', 'Консоль действий готова · v1160');
    })();

    const sb = $('vtStream');
    if (sb) sb.addEventListener('click', async () => {
      if (!viewer.setOctreeStream) { toast('Стриминг доступен в 3D-режиме (WebGL)'); return; }
      // ВЫКЛ: активен реальный octree-стриминг ИЛИ визуальный режим «все точки» (кнопка горит).
      if ((viewer.octreeActive && viewer.octreeActive()) || sb.classList.contains('on')) {
        if (viewer.octreeActive && viewer.octreeActive()) { try { viewer.clearOctreeStream(); } catch (e) {} }
        sb.classList.remove('on');
        const cleanup = await releaseActiveOctreeStore();
        if (lastCloudPath && !showCloudFromCache(lastCloudPath)) { try { const pr0 = await API.parseCloud(lastCloudPath); if (pr0 && pr0.ok) { if (pr0.kind === 'mesh') viewer.loadColoredMesh(pr0); else { viewer.loadCloud(pr0, { preserveView: true, sourceName:lastCloudPath }); cacheCloud(lastCloudPath, pr0); } } } catch (e) { console.warn('reload after stream off', e); } }
        if (typeof window.__bimRefreshQuality === 'function') window.__bimRefreshQuality();
        toast('Потоковый режим выключен' + (cleanup && cleanup.ok === false ? ' · временный индекс не удалось удалить' : '')); return;
      }
      // ВКЛ:
      if (!lastCloudPath) { toast('Сначала откройте облако точек'); return; }
      // Сравниваем число точек в источнике с загруженной выборкой. Раньше здесь
      // проверялся только lastCloudCount (уже ограниченный point budget), из-за
      // чего облака вроде 15M PLY никогда не переходили в disk-backed octree.
      const cloudInfo = viewer && viewer.getCloudInfo ? viewer.getCloudInfo() : null;
      const loadedCount = Number(cloudInfo && cloudInfo.loadedCount) || Number(lastCloudCount) || 0;
      const sourceCount = Number(cloudInfo && cloudInfo.sourceCount) || Number(lastCloudCount) || loadedCount;
      const sourceIsSampled = sourceCount > loadedCount;
      // Если весь источник уже загружен и помещается в обычный режим, сохраняем
      // привычное поведение. При наличии непрочитанных точек индексируем сам файл
      // в Worker, а не только текущую renderer-выборку.
      const STREAM_CAP = Number(window.APP_CONFIG && window.APP_CONFIG.DEFAULT_MAX_POINTS) || 200000000;
      if (!sourceIsSampled && loadedCount <= STREAM_CAP) {
        sb.classList.add('on'); // кнопка горит: режим «все точки» активен
        toast(loadedCount ? ('Облако ' + (loadedCount / 1e6).toFixed(1) + ' млн — весь источник уже загружен: показаны все точки') : 'Показаны все точки одним буфером');
        if (!showCloudFromCache(lastCloudPath)) { try { const prf = await API.parseCloud(lastCloudPath); if (prf && prf.ok) { if (prf.kind === 'mesh') viewer.loadColoredMesh(prf); else { viewer.loadCloud(prf, { preserveView: true, sourceName:lastCloudPath }); cacheCloud(lastCloudPath, prf); } } } catch (e) { console.warn('full reload', e); } }
        return;
      }
      if (!API || !API.buildOctree) { toast('Стриминг доступен в десктоп-версии'); return; }
      const jobId = makeCloudParseJobId();
      const stopOctreeProgress = beginProgress('Построение дискового octree…');
      let octreeProgressOff = null, octreeCancelListener = null, cancelOctreeRequested = false;
      if (API.onOctreeProgress) octreeProgressOff = API.onOctreeProgress(jobId, p => {
        if (!p || !stopOctreeProgress) return;
        if (Number.isFinite(p.fraction) && stopOctreeProgress.set) {
          const label = p.phase === 'octree-write'
            ? 'Запись узлов: ' + (p.nodesWritten || 0) + ' / ' + (p.nodeCount || 0)
            : p.phase === 'octree-partition'
              ? 'Разбиение на диске: ' + Number(p.sourceRecordsProcessed || 0).toLocaleString() +
                ' / ' + Number(p.sourceRecordsTotal || 0).toLocaleString()
              : p.phase === 'parse-decompress-start' || p.phase === 'parse-decompress-pcd' ||
                p.phase === 'parse-decompress-pcd-done'
                ? 'PCD LZF → временный диск: ' +
                  (Number(p.bytesWritten || 0) / (1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) +
                  ' / ' +
                  (Number(p.bytesExpected || 0) / (1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) +
                  ' МиБ'
              : p.phase === 'parse-scan' || p.phase === 'parse-convert'
                ? (p.phase === 'parse-scan' ? 'Потоковое чтение LAS/PLY/PCD: ' : 'Подготовка дискового источника LAS/PLY/PCD: ') +
                  Number(p.pointsRead || p.pointsWritten || 0).toLocaleString() +
                  ' / ' + Number(p.pointsTotal || 0).toLocaleString()
                : String(p.phase || 'Индексация облака');
          stopOctreeProgress.set(p.fraction, label);
        } else if (stopOctreeProgress.text) {
          const detail = Number.isFinite(p.nodesWritten)
            ? ' · узлов записано: ' + Number(p.nodesWritten).toLocaleString()
            : (p.workDone ? ' · обработано операций: ' + Number(p.workDone).toLocaleString() : '');
          stopOctreeProgress.text(String(p.phase || 'Индексация') + detail);
        }
      });
      octreeCancelListener = event => {
        if (!stopOctreeProgress || !stopOctreeProgress.token || !event || !event.detail ||
            event.detail.token !== stopOctreeProgress.token || cancelOctreeRequested) return;
        cancelOctreeRequested = true;
        try { API.cancelOctreeBuild(jobId); } catch (_) {}
      };
      window.addEventListener('lx-progress-cancel', octreeCancelListener);
      let res = null;
      const sourceTransform = viewer && viewer._srcXform &&
        (viewer._srcXform.axis === 'zup' || viewer._srcXform.axis === 'yup') &&
        Array.isArray(viewer._srcXform.t) && viewer._srcXform.t.length >= 3
        ? { axis: viewer._srcXform.axis, t: viewer._srcXform.t.slice(0, 3) }
        : undefined;
      try { res = await API.buildOctree({ path: lastCloudPath, jobId, expectedPoints: sourceCount, sourceTransform }); }
      catch (e) { console.warn('buildOctree', e); }
      finally {
        if (octreeProgressOff) try { octreeProgressOff(); } catch (_) {}
        if (octreeCancelListener) try { window.removeEventListener('lx-progress-cancel', octreeCancelListener); } catch (_) {}
        try { if (stopOctreeProgress) stopOctreeProgress(); } catch (_) {}
      }
      if (!res || !res.ok) {
        if (cancelOctreeRequested || (res && res.cancelled)) toast('Построение octree отменено');
        else toast('Не удалось построить octree: ' + ((res && (res.message || res.error)) || 'ошибка'));
        return;
      }
      const dir = res.dir, index = res.index;
      // RAM-кеш узлов octree: один раз прочитанный с диска узел остаётся в оперативке — при повторном
      // попадании в кадр (после вытеснения GPU-буфера) диск не перечитывается. Бюджет зависит от профиля.
      const octNodeCache = new Map(); // key -> { pos, col, intensity, classification }
      let octNodeBytes = 0;
      const fetchNode = (key) => {
        const hit = octNodeCache.get(key);
        if (hit) {
          // Map insertion order is the LRU order: refresh a hit before
          // eviction so repeatedly viewed nodes stay warm in RAM.
          octNodeCache.delete(key);
          octNodeCache.set(key, hit);
          return Promise.resolve(hit);
        }
        return API.readOctreeNode({ dir, key }).then(r => {
          if (!(r && r.ok)) {
            throw new Error('octree node read failed: ' + ((r && (r.error || r.message)) || 'unknown error'));
          }
          if (!window.OctreeStore) throw new Error('OctreeStore is unavailable');
          const np = window.OctreeStore.deserializeNodePoints(
            r.bytes, r.count, r.hasColor, index
          );
          if (!np || !np.pos || !np.pos.length) throw new Error('empty octree node data');
          const b = np.pos.byteLength + (np.col ? np.col.byteLength : 0) +
            (np.intensity ? np.intensity.byteLength : 0) +
            (np.classification ? np.classification.byteLength : 0);
          octNodeCache.set(key, np); octNodeBytes += b;
          if (octNodeBytes > octNodeCacheMaxBytes) {
            for (const k of octNodeCache.keys()) {
              if (k === key) continue;
              const e = octNodeCache.get(k);
              octNodeBytes -= e.pos.byteLength + (e.col ? e.col.byteLength : 0) +
                (e.intensity ? e.intensity.byteLength : 0) +
                (e.classification ? e.classification.byteLength : 0);
              octNodeCache.delete(k);
              if (octNodeBytes <= octNodeCacheMaxBytes) break;
            }
          }
          return np;
        });
      };
      const okset = viewer.setOctreeStream({ index, fetchNode });
      if (okset) {
        if (typeof window.__bimRefreshQuality === 'function') window.__bimRefreshQuality();
        activeOctreeDir = dir;
        sb.classList.toggle('on', !!(viewer.octreeActive && viewer.octreeActive()));
        if (wb) { wb.classList.remove('on'); if (viewer.setWalk) viewer.setWalk(false); }
        if (tb) tb.classList.remove('on');
        if (eb) { eb.classList.remove('on'); if (viewer.setEditSelect) viewer.setEditSelect(false); if (editBar) editBar.style.display = 'none'; }
        const mln = ((index.pointCount || 0) / 1e6).toFixed(1);
        const sourceCount = Number(index.sourcePointCount || res.sourcePointCount || 0);
        const sourceMln = sourceCount ? (sourceCount / 1e6).toFixed(1) : null;
        const sampled = sourceCount > index.pointCount;
        const decimationInfo = index.exactDecimation
          ? 'шаг ' + (index.decimation || 1)
          : 'примерно 1 из ' + (index.decimation || 1);
        const overlapFallbackCount = Array.isArray(index.nodes)
          ? index.nodes.reduce((count, node) => count + (node && node.splitMode === 'balanced-overlap-fallback' ? 1 : 0), 0)
          : 0;
        const streamedAttributeOmissions = index.sourceMeta && Array.isArray(index.sourceMeta.streamAttributeOmissions)
          ? index.sourceMeta.streamAttributeOmissions
          : [];
        const attributeNote = streamedAttributeOmissions.length
          ? ' · в LOD пока нет ' + streamedAttributeOmissions.join('/')
          : '';
        toast('Стриминг octree включён · ' + mln + ' млн индексированных точек · узлов: ' + (index.nodeCount || 0) +
          (sampled ? ' · выборка из ' + sourceMln + ' млн (' + decimationInfo + ')' : '') +
          (overlapFallbackCount ? ' · предупреждение: перекрывающиеся LOD-границы в ветвях: ' + overlapFallbackCount : '') +
          attributeNote);
      } else {
        sb.classList.remove('on');
        try { if (API.deleteOctree) await API.deleteOctree({ dir }); } catch (_) {}
        toast('Не удалось запустить стриминг');
      }
    });
    let selMode = 'lasso';
    const edModeBtn = $('edMode');
    const ED_ICO = { 'Лассо': 'lasso-select', 'Рамка': 'box-select', 'Кисть': 'brush', 'Палочка': 'wand-sparkles', 'Пипетка': 'pipette' };
    const setEdModeLbl = t => setLbl(edModeBtn, t, ED_ICO[t]);
    if (edModeBtn) edModeBtn.addEventListener('click', () => { if (!viewer.setSelectMode) return; selMode = selMode === 'lasso' ? 'rect' : selMode === 'rect' ? 'brush' : 'lasso'; viewer.setSelectMode(selMode); setEdModeLbl(selMode === 'lasso' ? 'Лассо' : selMode === 'rect' ? 'Рамка' : 'Кисть'); if (viewer.clearSelection) viewer.clearSelection(); toast(selMode === 'lasso' ? 'Лассо: обведите мусор произвольным контуром (ЛКМ). Alt — снять лишнее' : 'Рамка: выделите прямоугольную область (ЛКМ). Alt — снять лишнее'); });
    let selDepthMode = 0;
    const edThroughBtn = $('edThrough');
    if (edThroughBtn) edThroughBtn.addEventListener('click', () => { if (!viewer.setSelectDepthMode) return; selDepthMode = (selDepthMode >= 2) ? 0 : 2; viewer.setSelectDepthMode(selDepthMode); edThroughBtn.classList.toggle('on', selDepthMode >= 2); if (viewer.clearSelection) viewer.clearSelection(); toast(selDepthMode >= 2 ? 'Насквозь: удаляются все точки внутри контура по всей глубине — надёжно для мусора в воздухе (разверните камеру так, чтобы мусор был на фоне пустоты)' : 'Только объект: затрагивается лишь видимая поверхность, без точек за ней'); });
    // Ползунок «Латание» — ручное расширение точек-окклюдеров в pick-проходе (setSelectGrowPx, 0–20px).
    // null = авто (2.5px «точно» / 4px «с запасом»). Двойной клик по ползунку возвращает в авто.
    // Снятие выделения (Alt / кнопка): рамка/лассо убирают точки из выбора.
    let selSubtract = false;
    const edSubBtn = $('edSubtract');
    if (edSubBtn) edSubBtn.addEventListener('click', () => { if (!viewer.setSelectSubtract) return; selSubtract = !selSubtract; viewer.setSelectSubtract(selSubtract); edSubBtn.textContent = selSubtract ? 'Снять: вкл' : 'Снять: выкл'; edSubBtn.classList.toggle('on', selSubtract); toast(selSubtract ? 'Режим снятия ВКЛ: обведите лишние точки (напр. фон позади) — они уберутся. Крутите камеру между шагами' : 'Режим снятия выкл'); });
    // Накопление (мультивыбор) — по умолчанию ВКЛ.
    let selAccum = true;
    if (viewer.setSelectAccumulate) viewer.setSelectAccumulate(true);
    const edAccumBtn = $('edAccum');
    if (edAccumBtn) edAccumBtn.addEventListener('click', () => { if (!viewer.setSelectAccumulate) return; selAccum = !selAccum; viewer.setSelectAccumulate(selAccum); edAccumBtn.textContent = selAccum ? 'Накопление: вкл' : 'Накопление: выкл'; edAccumBtn.classList.toggle('on', selAccum); toast(selAccum ? 'Накопление ВКЛ: выделяйте объекты один за другим — они складываются. Alt — снять, «Очистить»/Esc — сброс' : 'Накопление выкл: каждая новая рамка заменяет прошлый выбор'); });
    var edProtectBtn = $('edProtect');
    if (edProtectBtn) edProtectBtn.addEventListener('click', function(){ if (!viewer.setPlaneProtect) { toast('\u041d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u043e'); return; } var on = !edProtectBtn.classList.contains('on'); edProtectBtn.classList.toggle('on', on); var cnt = 0; if (on && viewer.detectFloorWalls) { try { cnt = (viewer.detectFloorWalls() || []).length; } catch (e) { cnt = 0; } } viewer.setPlaneProtect(on); toast(on ? ('\u0417\u0430\u0449\u0438\u0442\u0430 \u043f\u043b\u043e\u0441\u043a\u043e\u0441\u0442\u0435\u0439 \u0412\u041a\u041b: ' + cnt + ' \u043f\u043b\u043e\u0441\u043a\u043e\u0441\u0442\u0435\u0439 (\u043f\u043e\u043b/\u0441\u0442\u0435\u043d\u044b) \u0441\u043e\u0445\u0440\u0430\u043d\u044f\u0442\u0441\u044f \u043f\u0440\u0438 \u0443\u0434\u0430\u043b\u0435\u043d\u0438\u0438') : '\u0417\u0430\u0449\u0438\u0442\u0430 \u0432\u044b\u043a\u043b'); });
    var edWandBtn = $('edWand');
    if (edWandBtn) edWandBtn.addEventListener('click', function(){ if (!viewer.setSelectMode) return; selMode = 'wand'; viewer.setSelectMode('wand'); if (edModeBtn) setEdModeLbl('Палочка'); if (viewer.clearSelection) viewer.clearSelection(); toast('\u041f\u0430\u043b\u043e\u0447\u043a\u0430: \u043a\u043b\u0438\u043a\u043d\u0438\u0442\u0435 \u043f\u043e \u043c\u0443\u0441\u043e\u0440\u0443 \u2014 \u0432\u044b\u0434\u0435\u043b\u0438\u0442\u0441\u044f \u0441\u0432\u044f\u0437\u043d\u044b\u0439 \u043e\u0431\u044a\u0435\u043a\u0442'); });
    var edDropBtn = $('edDrop');
    if (edDropBtn) edDropBtn.addEventListener('click', function(){ if (!viewer.setSelectMode) return; selMode = 'eyedrop'; viewer.setSelectMode('eyedrop'); if (edModeBtn) setEdModeLbl('Пипетка'); if (viewer.clearSelection) viewer.clearSelection(); toast('\u041f\u0438\u043f\u0435\u0442\u043a\u0430: \u043a\u043b\u0438\u043a\u043d\u0438\u0442\u0435 \u043f\u043e \u0446\u0432\u0435\u0442\u0443 \u2014 \u0432\u044b\u0434\u0435\u043b\u044f\u0442\u0441\u044f \u0432\u0441\u0435 \u0442\u043e\u0447\u043a\u0438 \u044d\u0442\u043e\u0433\u043e \u0446\u0432\u0435\u0442\u0430'); });
    var edSORBtn = $('edSOR');
    if (edSORBtn) edSORBtn.addEventListener('click', function(){ if (!viewer.cleanSORInApp) { toast('\u041d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u043e'); return; } var r = viewer.cleanSORInApp({ k: 16, stdRatio: 1.0 }) | 0; toast(r > 0 ? ('SOR \u0443\u0434\u0430\u043b\u0438\u043b \u0432\u044b\u0431\u0440\u043e\u0441\u043e\u0432: ' + nfmt(r)) : 'SOR: \u0432\u044b\u0431\u0440\u043e\u0441\u043e\u0432 \u043d\u0435\u0442'); });
    const edClearBtn = $('edClear');
    if (edClearBtn) edClearBtn.addEventListener('click', () => { if (viewer.clearSelection) viewer.clearSelection(); toast('Выбор очищен'); });
    const edGrow = $('edGrow'); const edGrowVal = $('edGrowVal');
    const applyGrow = (px, save) => {
      if (!viewer || !viewer.setSelectGrowPx) return;
      const v = viewer.setSelectGrowPx(px); // возвращает число либо null (авто)
      if (edGrowVal) edGrowVal.textContent = (v == null) ? 'авто' : (v + 'px');
      if (edGrow && v != null) edGrow.value = v;
      if (save) persistSettings({ selGrowPx: (v == null ? null : v) });
    };
    if (edGrow) {
      const savedGrow = (SETTINGS && typeof SETTINGS.selGrowPx === 'number') ? SETTINGS.selGrowPx : null;
      if (savedGrow != null) applyGrow(savedGrow, false); else if (edGrowVal) edGrowVal.textContent = 'авто';
      edGrow.addEventListener('input', () => applyGrow(parseFloat(edGrow.value), true));
      edGrow.addEventListener('dblclick', () => { applyGrow(NaN, true); toast('Латание разрывов: авто (2.5px «точно» / 4px «с запасом»)'); });
    }
    const edBtn = (id, fn) => { const b = $(id); if (b) b.addEventListener('click', fn); };
    edBtn('edDelete', () => { if (!viewer.selectionCount || !viewer.selectionCount()) { toast('Сначала выделите точки рамкой'); return; } const r = viewer.deleteSelection(); const _pb = (viewer._lastProtectRemoved | 0); if (r === 0 && _pb > 0) toast('Выделенное защищено как конструктив (' + nfmt(_pb) + ' т.). Меню «Чистка» → «Защита конструктива» — выключите, чтобы удалить'); else toast('Удалено точек: ' + nfmt(r) + (_pb > 0 ? ' (защищено конструктива: ' + nfmt(_pb) + ')' : '')); });
    edBtn('edCrop', () => { if (!viewer.selectionCount || !viewer.selectionCount()) { toast('Сначала выделите точки рамкой'); return; } viewer.cropToSelection(); toast('Оставлены только выбранные точки'); });
    edBtn('edInvert', () => { if (viewer.invertSelection) viewer.invertSelection(); });
    edBtn('edUndo', () => { if (viewer.undoEdit && viewer.undoEdit()) toast('Отменено'); else toast('Нет действий для отмены'); });
    // ---- Авто-сохранение правок облака (черновик + сохранение перед выходом + восстановление) ----
    const _asMaxPts = 60000000; // выше — авто-сохранение на паузе (черновик такого облака не умещается в память)
    let _asDirty = false, _asTimer = null, _asBusy = false, _asPromise = null, _asEditGeneration = 0;
    const _asKey = () => { try { return curCloudPath() || 'cloud'; } catch (e) { try { return lastCloudPath || 'cloud'; } catch (_) { return 'cloud'; } } };
    const _asProjectId = () => {
      try { return window.BimProjectState && window.BimProjectState.projectId || DB && DB.project && DB.project.id || ''; } catch (_) { return ''; }
    };
    const _asStoreKey = () => {
      const projectId = _asProjectId(), sourceKey = _asKey();
      return projectId ? ('project:' + encodeURIComponent(projectId) + '\u0000' + sourceKey) : sourceKey;
    };
    async function autosaveNow() {
      if (_asPromise) return _asPromise;
      if (!_asDirty) return { ok: true, unchanged: true };
      if (!(API && API.autosaveCloud && viewer && viewer.getEditedCloud && window.PCEdit)) return { ok: false, error: 'autosave_unavailable' };
      const c = viewer.getEditedCloud(); if (!c || !c.pos || !c.pos.length) return;
      const cnt = c.pos.length / 3;
      if (cnt > _asMaxPts) { toast('Авто-сохранение на паузе: облако ~' + Math.round(cnt / 1e6) + ' млн точек. Обрежьте облако, чтобы сохранить черновик'); return { ok: false, error: 'cloud_too_large' }; }
      const generation = _asEditGeneration;
      const sourceKey = _asKey();
      const key = _asStoreKey();
      const projectId = _asProjectId();
      const operation = viewer && viewer._pendingProjectOperation ? viewer._pendingProjectOperation : null;
      const tr = viewer && viewer._srcXform;
      const sourceTransform = tr && (tr.axis === 'zup' || tr.axis === 'yup') && tr.t && tr.t.length >= 3
        ? { axis: tr.axis, t: Array.prototype.slice.call(tr.t, 0, 3).map(Number) } : null;
      const crsWkt = viewer && typeof viewer._srcCrs === 'string' ? viewer._srcCrs : null;
      _asBusy = true;
      const stop = beginProgress('Авто-сохранение…'); if (stop.set) stop.set(0, 'Авто-сохранение…');
      const task = (async function () {
        try {
          const bytes = window.PCEdit.toPLYBinaryAsync ? await window.PCEdit.toPLYBinaryAsync(c, f => { if (stop.set) stop.set(f * 0.92, 'Авто-сохранение…'); }) : window.PCEdit.toPLYBinary(c);
          if (stop.set) stop.set(0.96, 'Авто-сохранение…');
          const r = await API.autosaveCloud({
            key: key, sourcePath: sourceKey,
            name: String(sourceKey).split(/[\\/]/).pop(),
            projectId: projectId || undefined,
            points: cnt, binary: bytes, operation: operation,
            sourceTransform: sourceTransform, crsWkt: crsWkt
          });
          if (r && r.ok) {
            if (_asEditGeneration === generation) _asDirty = false;
            if (viewer && viewer._pendingProjectOperation === operation) viewer._pendingProjectOperation = null;
            if (_asDirty) scheduleAutosave(500);
            else toast('Черновик сохранён автоматически');
          } else {
            const message = r && (r.message || r.error) || 'неизвестная ошибка';
            console.warn('autosave failed', message);
            toast('Не удалось сохранить черновик: ' + String(message).slice(0, 160));
            if (_asDirty && r && r.error !== 'cloud_too_large') scheduleAutosave(8000);
          }
          return r || { ok: false, error: 'autosave_no_result' };
        } catch (e) {
          console.warn('autosave', e);
          toast('Не удалось сохранить черновик: ' + String(e && e.message || e).slice(0, 160));
          if (_asDirty) scheduleAutosave(8000);
          return { ok: false, error: String(e && e.message || e) };
        } finally {
          _asBusy = false;
          try { stop(); } catch (e) {}
        }
      })();
      _asPromise = task;
      try { return await task; }
      finally { if (_asPromise === task) _asPromise = null; }
    }
    function scheduleAutosave(delay) {
      if (_asTimer) clearTimeout(_asTimer);
      _asTimer = setTimeout(() => { _asTimer = null; autosaveNow(); }, Math.max(0, Number(delay) || 3500));
    }
    async function flushAutosave() {
      if (_asTimer) { clearTimeout(_asTimer); _asTimer = null; }
      for (let attempt = 0; attempt < 3; attempt++) {
        if (_asPromise) await _asPromise;
        if (!_asDirty) return { ok: true, unchanged: true };
        const result = await autosaveNow();
        if (!result || result.ok === false) return result || { ok: false, error: 'autosave_failed' };
      }
      return _asDirty ? { ok: false, error: 'autosave_keeps_changing' } : { ok: true };
    }
    async function markCloudSaved(savedGeneration) {
      const generation = Number.isSafeInteger(savedGeneration) ? savedGeneration : _asEditGeneration;
      if (_asPromise) await _asPromise;
      if (generation !== _asEditGeneration) return { ok: false, error: 'cloud_changed_during_save' };
      _asDirty = false;
      if (_asTimer) { clearTimeout(_asTimer); _asTimer = null; }
      if (!(API && API.autosaveClear)) return { ok: true, skipped: true };
      const keys = Array.from(new Set([_asStoreKey(), _asKey()].filter(Boolean)));
      const results = await Promise.all(keys.map(key => API.autosaveClear({ key: key })));
      const failed = results.find(result => !result || result.ok === false);
      if (failed) {
        console.warn('[autosave] saved cloud, but draft acknowledgement failed', failed);
        toast('Файл сохранён, но черновик не удалось отметить как подтверждённый');
      }
      return failed ? { ok: false, error: failed.error || 'autosave_clear_failed' } : { ok: true };
    }
    let _asRecoveryKey = '';
    async function getAutosaveSet(projectKey, sourceKey, includeCleared) {
      let result = await API.autosaveLoad({ key: projectKey, includeCleared: !!includeCleared });
      if (projectKey !== sourceKey && result && !result.exists && !result.acknowledged &&
          !result.error && (!Array.isArray(result.revisions) || !result.revisions.length)) {
        const legacy = await API.autosaveLoad({ key: sourceKey, includeCleared: !!includeCleared });
        if (legacy && (legacy.exists || legacy.acknowledged || legacy.error ||
            (Array.isArray(legacy.revisions) && legacy.revisions.length))) return { key: sourceKey, result: legacy, legacyKey: true };
      }
      return { key: projectKey, result: result, legacyKey: false };
    }
    async function restoreAutosave(set, row) {
      const mutableLegacy = !!(set.result && set.result.legacy && (!Array.isArray(set.result.revisions) || !set.result.revisions.length));
      const snapshot = row && row.sha256 && !mutableLegacy
        ? await API.autosaveLoad({ key: set.key, sha256: row.sha256 })
        : set.result;
      if (!snapshot || !snapshot.ok || !snapshot.exists || !snapshot.path) {
        toast('Выбранную версию черновика не удалось проверить или открыть');
        return false;
      }
      const pr = await API.parseCloud(snapshot.path);
      if (!pr || !pr.ok || pr.kind === 'mesh') {
        toast('Не удалось прочитать черновик облака');
        return false;
      }
      pr.meta = Object.assign({}, pr.meta || {});
      if (snapshot.sourceTransform) pr.meta.srcXform = snapshot.sourceTransform;
      if (snapshot.crsWkt) pr.meta.crsWkt = snapshot.crsWkt;
      viewer.loadCloud(pr, { preserveView: true, sourceName: _asKey() });
      viewer._pendingProjectOperation = snapshot.sha256 ? {
        operation: 'cloud.edit.restore',
        inputHash: snapshot.sha256,
        parameters: { restoredSha256: snapshot.sha256, restoredAt: snapshot.savedAt || null }
      } : null;
      _asDirty = false;
      if (_asTimer) { clearTimeout(_asTimer); _asTimer = null; }
      try { await API.autosaveClear({ key: set.key }); } catch (_) {}
      toast('Черновик восстановлен' + (snapshot.sha256 ? ' · SHA-256 ' + snapshot.sha256.slice(0, 12) : ''));
      return true;
    }
    async function chooseAutosaveRevision(set, forceList) {
      const result = set && set.result;
      if (!result || !result.ok) {
        toast('Историю черновиков не удалось прочитать: ' + String(result && (result.message || result.error) || 'ошибка'));
        return false;
      }
      const rows = Array.isArray(result.revisions) ? result.revisions.slice()
        .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)) : [];
      if (!rows.length && result.exists && result.path) rows.push({
        savedAt: result.savedAt, points: result.points, bytes: result.bytes,
        sha256: result.sha256, latest: true
      });
      if (!rows.length) {
        toast(result.acknowledged ? 'Черновик уже подтверждён; сохранённые версии не найдены' : 'Для этого облака сохранённых черновиков нет');
        return false;
      }
      let selected = Math.max(0, rows.findIndex(row => row.latest));
      if (forceList || rows.length > 1) {
        const options = rows.map((row, index) => {
          const when = row.savedAt ? new Date(row.savedAt).toLocaleString() : 'время неизвестно';
          const points = row.points ? (Number(row.points).toLocaleString('ru-RU') + ' т.') : 'число точек не задано';
          const digest = row.sha256 ? row.sha256.slice(0, 12) : 'legacy';
          return index + ' — ' + (row.latest ? 'последняя · ' : '') + when + ' · ' + points + ' · ' + digest;
        });
        const form = await openForm('История автосохранений · ' + String(_asKey()).split(/[\\/]/).pop(), [
          { k: 'revision', label: 'Версия (дата, количество точек, SHA-256)', type: 'select', options: options, value: options[selected] }
        ]);
        if (!form) return false;
        selected = parseInt(String(form.revision).split(' — ')[0], 10);
        if (!Number.isInteger(selected) || selected < 0 || selected >= rows.length) return false;
        const confirmRestore = await confirmBox('Заменить текущее облако на выбранную сохранённую версию? Текущий исходный файл не изменится.');
        if (!confirmRestore) return false;
      } else {
        const row = rows[selected];
        const when = row.savedAt ? new Date(row.savedAt).toLocaleString() : '';
        const points = row.points ? (Number(row.points).toLocaleString('ru-RU') + ' точек, ') : '';
        if (!await confirmBox('Найден черновик (' + points + when + '). Восстановить его? Исходный файл останется без изменений.')) return false;
      }
      return restoreAutosave(set, rows[selected]);
    }
    async function offerRecovery() {
      if (!(API && API.autosaveLoad && API.parseCloud && viewer)) return;
      let sourceKey, key; try { sourceKey = _asKey(); key = _asStoreKey(); } catch (e) { return; }
      if (!sourceKey || sourceKey === 'cloud' || _asRecoveryKey === key) return;
      _asRecoveryKey = key;
      try {
        const set = await getAutosaveSet(key, sourceKey, false);
        if (set.result && set.result.error) { toast('Автовосстановление недоступно: ' + String(set.result.message || set.result.error)); return; }
        if (set.result && set.result.ok && set.result.exists) await chooseAutosaveRevision(set, false);
      } catch (e) { _asRecoveryKey = ''; console.warn('recovery', e); toast('Не удалось проверить автосохранение: ' + String(e && e.message || e)); }
    }
    async function offerHistory() {
      if (!(API && API.autosaveLoad && API.parseCloud && viewer)) return;
      const sourceKey = _asKey();
      if (!sourceKey || sourceKey === 'cloud') { toast('Сначала откройте облако точек'); return; }
      try {
        const set = await getAutosaveSet(_asStoreKey(), sourceKey, true);
        await chooseAutosaveRevision(set, true);
      } catch (error) {
        toast('Не удалось открыть историю автосохранений: ' + String(error && error.message || error));
      }
    }
    window.__pcAutosave = {
      onEdit: () => { _asEditGeneration++; _asDirty = true; scheduleAutosave(); },
      flush: flushAutosave,
      saved: markCloudSaved,
      offerRecovery: offerRecovery,
      offerHistory: offerHistory,
      isDirty: () => _asDirty,
      get editGeneration() { return _asEditGeneration; }
    };
    // v1150 — мост для модуля lixel-tools-ext.js (риббоны Инструмент/Приложение).
    // Даёт доступ к общей полосе прогресса %, тостам, перезагрузке облака и выбору файла.
    window.__pcTools = {
      beginProgress: beginProgress,
      withBusy: withBusy,
      toast: toast,
      curCloudPath: curCloudPath,
      reloadGeomCloud: reloadGeomCloud,
      pickGeomFile: pickGeomFile,
      geomCloudReady: geomCloudReady,
      api: () => API,
      viewer: () => viewer,
      getCloud: () => (viewer && viewer.getEditedCloud) ? viewer.getEditedCloud() : null,
      getSourceCloud: () => (viewer && viewer.getSourceCloud) ? viewer.getSourceCloud() : ((viewer && viewer.getEditedCloud) ? viewer.getEditedCloud() : null),
      isOctreeStreamActive: () => !!(viewer && viewer.octreeActive && viewer.octreeActive()),
      getSourceTransform: () => viewer && viewer._srcXform ? { axis: viewer._srcXform.axis, t: viewer._srcXform.t.slice() } : null,
      getSourceCrs: () => viewer && viewer._srcCrs || null,
      loadCloud: (c, name, details) => {
        if (viewer && viewer.loadCloud && c && c.pos) {
          const bo = viewer.base && viewer.base[0];
          const beforeCount = bo && bo.pos ? bo.pos.length / 3 : null;
          if (bo && bo.pos && (c.pos !== bo.pos || c.count !== bo.pos.length / 3)) {
            (viewer._undo = viewer._undo || []).push({ pos: bo.pos.slice(), col: bo.col ? bo.col.slice() : null, srcXform: viewer._srcXform || null, crsWkt: viewer._srcCrs || null });
            if (viewer._undo.length > 3) viewer._undo.shift();
          }
          const srcName = viewer._cloudRecord && viewer._cloudRecord.sourceName || name || 'tool-result';
          const op = Object.assign({ operation: 'cloud.' + String(name || 'edit'), parameters: { tool: String(name || 'edit'), pointCountBefore: beforeCount, pointCountAfter: c.count || (c.pos.length / 3) } }, details || {});
          if (op.parameters && details && details.parameters) op.parameters = Object.assign({}, op.parameters, details.parameters);
          viewer._pendingProjectOperation = op;
          if (/level|vertical|align|merge|overlay/i.test(String(name || ''))) { viewer._srcXform = null; viewer._srcCrs = null; }
          viewer.loadCloud({ pos: c.pos, col: c.col || null, intensity:c.intensity||null, classification:c.classification||null,
            count: c.count || (c.pos.length / 3), meta: c.meta || {} }, { preserveView: true, sourceName: srcName });
        }
        if (window.__pcAutosave) { try { window.__pcAutosave.onEdit(c && c.count || 0); } catch (e) {} }
      }
    };
    try { window.dispatchEvent(new Event('lx-pctools-ready')); } catch (e) {}
    if (!window.__pcAutosaveExit) {
      window.__pcAutosaveExit = true;
      window.addEventListener('beforeunload', (e) => { if (_asDirty && !_asBusy) { try { autosaveNow(); } catch (_) {} e.preventDefault(); e.returnValue = ''; return ''; } });
    }
    try { const _ebR = document.getElementById('vtEdit'); if (_ebR) _ebR.addEventListener('click', () => { setTimeout(() => { if (_ebR.classList.contains('on')) offerRecovery(); }, 80); }); } catch (e) {}
    edBtn('edForceDelete', () => {
      if (!viewer.selectionCount || !viewer.selectionCount()) { toast('Сначала выделите точки (лассо/рамка)'); return; }
      if (!viewer.deleteSelectionForce) { toast('Недоступно'); return; }
      const r = viewer.deleteSelectionForce();
      toast('Удалено принудительно (без защит): ' + nfmt(r) + ' т.');
    });
    edBtn('edSave', async () => {
      if (!viewer.getEditedCloud) return;
      const c = viewer.getEditedCloud(); if (!c || !c.pos || !c.pos.length) { toast('Нет облака для сохранения'); return; }
      const saveGeneration = _asEditGeneration;
      const cnt = c.pos.length / 3;
      if (cnt > ((window.APP_CONFIG && window.APP_CONFIG.PLY_EXPORT_MAX_POINTS) || 200000000)) { toast('Слишком большое облако для экспорта в PLY (~' + Math.round(cnt / 1e6) + ' млн). Сначала обрежьте облако.'); return; }
      if (!window.PCEdit) { toast('Модуль редактирования не загружен'); return; }
      if (!(API && API.saveCloud)) { toast('Сохранение доступно в десктоп-версии'); return; }
      const stop = beginProgress('Формирование PLY…'); if (stop.set) stop.set(0, 'Формирование PLY…');
      try {
        const bytes = window.PCEdit.toPLYBinaryAsync ? await window.PCEdit.toPLYBinaryAsync(c, f => { if (stop.set) stop.set(f * 0.9, 'Формирование PLY…'); }) : window.PCEdit.toPLYBinary(c);
        if (stop.set) stop.set(0.95, 'Сохранение на диск…');
        const r = await API.saveCloud({ binary: bytes, name: 'pointcloud-edited.ply' });
        if (r && r.ok) {
          const ack = await markCloudSaved(saveGeneration);
          toast((ack && ack.ok === false ? 'Файл сохранён, но облако изменилось во время сохранения; черновик оставлен' : 'Сохранено: ' + r.path));
        } else if (!(r && r.canceled)) toast('Ошибка сохранения: ' + ((r && r.error) || ''));
      } catch (e) { toast('Ошибка сохранения'); }
      finally { try { stop(); } catch (e) {} }
    });
    if (!window.__editKeys) { window.__editKeys = true; window.addEventListener('keydown', e => { if (!viewer || !viewer.editSelect) return; const k = (e.key || '').toLowerCase(); if (k === 'delete' || k === 'backspace' || k === 'enter') { const _t = e.target; if (_t && (/^(input|textarea|select)$/i.test(_t.tagName || '') || _t.isContentEditable)) return; if (viewer.selectionCount && viewer.selectionCount()) { const r = viewer.deleteSelection(); const _pb = (viewer._lastProtectRemoved | 0); if (r === 0 && _pb > 0) toast('Выделенное защищено как конструктив (' + nfmt(_pb) + ' т.). Меню «Чистка» → «Защита конструктива» — выключите, чтобы удалить'); else toast('Удалено точек: ' + nfmt(r) + (_pb > 0 ? ' (защищено конструктива: ' + nfmt(_pb) + ')' : '')); } } else if ((e.ctrlKey || e.metaKey) && k === 'z') { if (viewer.undoEdit && viewer.undoEdit()) toast('Отменено'); } else if (k === 'escape') { if (viewer.selectionCount && viewer.selectionCount() && viewer.clearSelection) { viewer.clearSelection(); toast('Выбор очищен (Esc)'); } } }); }
  }
  // v0.9.29: карточка свойств выбранного элемента поверх сцены
  function updateElProps() {
    const box = document.getElementById('elProps'); if (!box) return;
    if (!selEl) { box.style.display = 'none'; box.innerHTML = ''; return; }
    const st = selEl.ai_status || 'none';
    const rows = [['Тип', selEl.type || '—'], ['Статус', (STATUS_LABEL[st] || st)]];
    if (selEl.ifc_guid) rows.push(['IFC GUID', selEl.ifc_guid]);
    const nDocs = (current && current.documents) ? current.documents.filter(d => d.element_id === selEl.id).length : 0;
    rows.push(['Документов', String(nDocs)]);
    box.innerHTML = '<div class="ep-head"><i class="dot ' + st + '"></i><span>' + esc(selEl.name) + '</span><button class="ep-x" title="Закрыть" aria-label="Закрыть">' + ICON('x', 14) + '</button></div>' +
      '<div class="ep-body">' + rows.map(r => '<div class="ep-row"><span class="ep-k">' + esc(r[0]) + '</span><span class="ep-v">' + esc(r[1]) + '</span></div>').join('') + '</div>' +
      '<div class="ep-foot"><button class="btn xs" id="epMore">' + ICON('sliders-horizontal', 14) + '<span class="lbl">Все свойства</span></button></div>';
    box.style.display = '';
    const x = box.querySelector('.ep-x'); if (x) x.onclick = () => selectEl(null);
    const more = box.querySelector('#epMore'); if (more) more.onclick = () => { activeTab = 'props'; syncTabs(); };
  }
  // ── форматирование результатов измерения ──
  function measIcon(mode) { return ({ point: 'crosshair', distance: 'ruler', polyline: 'polyline', angle: 'angle', area: 'vector-square', diameter: 'diameter', plane: 'brick-wall', deviation: 'arrow-up-down', corner: 'cuboid' })[mode] || 'ruler'; }
  function measIco(mode, cls) { return '<span class="ro-ico' + (cls ? ' ' + cls : '') + '" data-ico="' + (mode === 'error' ? 'triangle-alert' : measIcon(mode)) + '"></span>'; }
  function measureHint(mode) {
    const H = {
      distance: 'Расстояние: кликните две точки',
      point: 'Точка: кликните по точке — покажу X/Y/Z',
      polyline: 'Полилиния: кликайте точки подряд, «Завершить» — новая',
      angle: 'Угол: кликните 3 точки (вершина — вторая)',
      area: 'Площадь: кликайте вершины контура (≥3), «Завершить» — новая',
      diameter: 'Диаметр: один клик по трубе — ось и радиус по всей видимой дуге',
      plane: 'Плоскость: кликните по стене/потолку — подберу размеры',
      deviation: 'Зазор: 1-й клик — опорная плоскость (ровная поверхность), дальше — клики для замера отклонения',
      corner: 'Ребро/Угол: кликните 2 плоскости (стена+стена) → точное ребро и угол; 3-я плоскость (+пол/потолок) → точка угла комнаты'
    };
    const m = H[mode] ? mode : 'distance';
    return measIco(m) + '<span class="ro-t">' + H[m] + '</span>';
  }
  // «по N точкам» (плоскость выросла по всей поверхности) или «точек N/M» (запасной RANSAC по окрестности)
  function ptsOf(res) {
    const n = res.inlierCount | 0, t = res.total | 0, f = v => v.toLocaleString('ru-RU');
    return t && t !== n ? 'точек ' + f(n) + '/' + f(t) : 'по ' + f(n) + ' точкам';
  }
  // Текст результата без значка (для строк списка и строки состояния)
  function fmtMeasureText(res) {
    if (!res) return '';
    const Me = window.Measure, L = m => Me ? Me.fmtLen(m) : (m.toFixed(3) + ' м'), A = m => Me ? Me.fmtArea(m) : (m.toFixed(3) + ' м²');
    switch (res.mode) {
      case 'point': return 'X ' + res.point[0].toFixed(3) + ' · Y ' + res.point[1].toFixed(3) + ' · Z ' + res.point[2].toFixed(3) + ' м';
      case 'distance': {
        if (res.auto && typeof res.auto === 'object' && Me && Me.autoValue) {
          const au = res.auto, lv = { high: 'высокая', medium: 'средняя', low: 'низкая' }[au.level] || au.level || '—';
          return esc(au.label || 'Размер') + ' <b>' + Me.autoValue(au) + '</b>' + esc(Me.autoSigma(au)) + ' · ' + esc(au.how || '') + ' · уверенность: ' + esc(lv);
        }
        const SN = { corner: 'угол', edge: 'ребро', plane: 'плоскость', point: 'точка', raw: 'без привязки', curve: 'труба' };
        const sn = res.snap ? ' · ' + (SN[res.snap.a.kind] || '') + ' → ' + (SN[res.snap.b.kind] || '') : '';
        // ±σ — точность привязок; у ребра и плоскости она только поперёк, а расстояние между точками зависит ещё и от места клика вдоль ребра (плоскости) —
        // поэтому для обычного 3D-расстояния ± пишем, когда точки определены полностью (угол, точка облака)
        const partial = k => k === 'edge' || k === 'plane';
        const acc = res.sigma != null && res.sigma > 0 && res.snap && res.snap.a.grown && res.snap.b.grown && (res.perp != null || !(partial(res.snap.a.kind) || partial(res.snap.b.kind))) ? ' · ±' + (Math.max(res.sigma, 0.0001) * 1000).toFixed(1).replace('.', ',') + ' мм' : '';
        // плоскости не параллельны (откосы, перекрытия): расстояние зависит от места замера — говорим об этом, а не выдаём одно число за «ширину вообще»
        const tiltNote = res.tilt != null && res.tilt >= 0.0052 ? ' · не параллельны на ' + (res.tilt * 180 / Math.PI).toFixed(1).replace('.', ',') + '°: значение зависит от места (' + (Math.tan(res.tilt) * 100).toFixed(1).replace('.', ',') + ' мм на 10 см)' : '';
        const sg1 = v => ' · ±' + (Math.max(v, 0.0001) * 1000).toFixed(1).replace('.', ',') + ' мм';
        if (res.perp != null && res.perpKind === 'pipe') return 'Ø <b>' + L(res.perp) + '</b> диаметр трубы (радиус ' + L(res.perp / 2) + ')' + sn + (res.perpSigma > 0 && res.snap && res.snap.a.grown && res.snap.b.grown ? sg1(res.perpSigma) : '') + ' · по ' + ((res.snap && res.snap.a.count) || 0).toLocaleString('ru-RU') + ' точкам трубы';
        if (res.perp != null && res.perpKind === 'pipes') return '<b>' + L(res.perp) + '</b> между осями двух труб · зазор между стенками ' + L(Math.max(0, res.gap || 0)) + sn;
        if (res.perp != null && res.perpKind === 'planes') return '<b>' + L(res.perp) + '</b> между плоскостями (по нормали)' + sn + acc + ' · сдвиг вдоль плоскостей ' + L(Math.sqrt(Math.max(0, res.d3 * res.d3 - res.perp * res.perp))) + tiltNote;
        if (res.perp != null && res.perpKind === 'edges') return '<b>' + L(res.perp) + '</b> между рёбрами (по перпендикуляру)' + sn + acc + (res.along != null ? ' · вдоль ребра ' + L(res.along) : '');
        return '<b>' + L(res.d3) + '</b> · гориз. ' + L(res.horizontal) + ' · верт. ' + L(res.vertical) + ' · ΔX ' + L(Math.abs(res.dx)) + ' ΔY ' + L(Math.abs(res.dy)) + ' ΔZ ' + L(Math.abs(res.dz)) + sn + acc + (res.perp != null ? ' · до плоскости ⊥ ' + L(res.perp) : '') + (res.pipe ? ' · точки на одной трубе Ø ' + L(res.pipe.diameter) + ' (диаметр — клики на противоположных сторонах)' : '');
      }
      case 'polyline': return 'Длина <b>' + L(res.total) + '</b> · точек: ' + res.count + ' · сегментов: ' + (res.count - 1);
      case 'angle': return 'Угол <b>' + res.deg.toFixed(2) + '°</b> · стороны ' + L(res.lenA) + ' и ' + L(res.lenC);
      case 'area': return 'Площадь <b>' + A(res.area) + '</b> · периметр ' + L(res.perimeter) + ' · вершин: ' + res.count;
      case 'diameter': return 'Ø <b>' + L(res.diameter) + '</b> · радиус ' + L(res.radius) + (res.sigma > 0 ? ' · ±' + (Math.max(res.sigma, 0.0001) * 1000).toFixed(1).replace('.', ',') + ' мм' : '') + ' · по ' + (res.count | 0).toLocaleString('ru-RU') + ' точкам трубы' + (res.arc ? ' · видимая дуга ' + Math.round(res.arc) + '°' : '') + (res.weak ? ' · дуга короткая — оценка грубая, поверните вид и кликните по трубе ближе к середине дуги' : '');
      case 'plane': return esc(res.kind) + ' · <b>' + L(res.length) + ' × ' + L(res.width) + '</b> (≈' + A(res.rectArea) + ') · наклон ' + res.dip.toFixed(1) + '° · RMS ' + (res.rms * 1000).toFixed(1) + ' мм · ' + ptsOf(res);
      case 'deviation':
        if (res.ready) return 'Опорная плоскость готова: ' + L(res.length || 0) + ' × ' + L(res.width || 0) + ' (RMS ' + (res.rms * 1000).toFixed(1) + ' мм, ' + ptsOf(res) + '). Теперь кликайте точки для замера зазора';
        if (res.signed === undefined) return 'Кликните по ровной поверхности — задать опорную плоскость';
        return 'Зазор до плоскости <b>' + (res.sign >= 0 ? '+' : '−') + L(res.distance) + '</b> · ' + (res.sign >= 0 ? 'перед плоскостью (к камере)' : 'за плоскостью (от камеры)') + ' · база RMS ' + ((res.refRms || 0) * 1000).toFixed(1) + ' мм' + (res.sigma ? ' · ±' + (Math.max(res.sigma, 0.0001) * 1000).toFixed(1).replace('.', ',') + ' мм' : '') + (res.tilt != null && res.tilt >= 0.0052 ? ' · поверхность не параллельна опорной на ' + (res.tilt * 180 / Math.PI).toFixed(1).replace('.', ',') + '°: значение зависит от места клика' : '');
      case 'corner':
        if (res.planeCount === 1) return 'Плоскость 1 задана (RMS ' + ((res.rms || 0) * 1000).toFixed(1) + ' мм). Кликните 2-ю плоскость для ребра/угла';
        if (res.planeCount === 2) return 'Ребро найдено · угол между плоскостями <b>' + (res.angleDeg != null ? res.angleDeg.toFixed(2) : '?') + '°</b>. Кликните 3-ю плоскость → точка угла комнаты';
        return 'Угол комнаты <b>X ' + res.corner[0].toFixed(3) + ' · Y ' + res.corner[1].toFixed(3) + ' · Z ' + res.corner[2].toFixed(3) + '</b> м · угол между плоскостями ' + (res.angleDeg != null ? res.angleDeg.toFixed(2) : '?') + '°';
      default: return '';
    }
  }
  function fmtMeasure(res) {
    if (!res) return '';
    if (res.error) return measIco('error', 'ro-err') + '<span class="ro-t">' + esc(res.error) + '</span>';
    const t = fmtMeasureText(res);
    return t ? measIco(res.mode) + '<span class="ro-t">' + t + '</span>' : '';
  }
  // ── список сохранённых измерений + CSV ──
  var __measurements = [];
  var __measurementsStateToken = '';
  function persistMeasurements() {
    const ps = window.BimProjectState;
    if (ps && ps.update) ps.update({ measurements: __measurements }).catch(e => { try { console.warn('[measurements] project save failed', e); } catch (_) {} });
  }
  function applyProjectMeasurements(projectState, revision) {
    const ps = window.BimProjectState;
    const token = String(ps && ps.projectId || '') + ':' + String(revision == null ? (ps && ps.revision || 0) : revision);
    if (token === __measurementsStateToken) return;
    __measurementsStateToken = token;
    __measurements = projectState && Array.isArray(projectState.measurements) ? projectState.measurements : [];
    renderMeasList();
  }
  if (window.BimProjectState && window.BimProjectState.ready) {
    window.BimProjectState.ready.then(projectState => applyProjectMeasurements(projectState, window.BimProjectState.revision));
    window.addEventListener('bim-project-state-ready', event => {
      const detail = event && event.detail || {};
      applyProjectMeasurements(detail.state, detail.revision);
    });
    window.addEventListener('bim-project-state-restored', event => {
      const detail = event && event.detail || {};
      applyProjectMeasurements(detail.state, detail.revision);
    });
  }
  function latestDocComparison(measurement) {
    const history = measurement && Array.isArray(measurement.docComparisons) ? measurement.docComparisons : [];
    const saved = history.length ? history[history.length - 1] : (measurement && measurement.docComparison) || null;
    const proposal = measurement && measurement.autoComparisonProposal || null;
    if (!saved) return proposal;
    if (!proposal) return saved;
    return Date.parse(proposal.createdAt || 0) > Date.parse(saved.createdAt || 0) ? proposal : saved;
  }
  function docComparisonStatusLabel(status) {
    return ({
      'within-tolerance': 'Соответствует требованию',
      'outside-tolerance': 'Отклонение',
      'tolerance-not-specified': 'Допуск не задан',
      'units-unconfirmed': 'Подтвердите единицы',
      'unit-mismatch': 'Несовместимые типы',
      'needs-review': 'Нужна проверка',
      'analyzing': 'Анализ документов…',
      'no-match': 'Требование не найдено'
    })[status] || 'Не сверено';
  }
  function renderMeasList() {
    const body = $('measureListBody'); const btn = $('mmList');
    const cnt = $('mmListCount'); if (cnt) { cnt.textContent = String(__measurements.length); cnt.hidden = !__measurements.length; }
    if (!body) return;
    if (!__measurements.length) { body.innerHTML = '<div class="empty">Пока пусто. Сделайте измерение и нажмите «В список».</div>'; notifyMeasurementsChanged(); return; }
    body.innerHTML = __measurements.map((m, i) => {
      const lbl = m.label ? '<span class="meas-label">' + esc(m.label) + '</span>' : '';
      const comparison = latestDocComparison(m);
      const status = comparison ? (comparison.statusLabel || docComparisonStatusLabel(comparison.status)) : 'Не сверено';
      const statusClass = comparison ? String(comparison.status || 'needs-review').replace(/[^a-z-]/g, '') : 'not-checked';
      const roomName = m.measurementContext && m.measurementContext.roomName ? ' · ' + esc(m.measurementContext.roomName) : '';
      return '<div class="meas-saved-row"><div class="meas-saved-main"><span class="meas-saved-index">' + (i + 1) + '</span><span class="measure-row-label">' + lbl + measIco(m.mode) + '<span class="ro-t">' + fmtMeasureText(m) + '</span></span><button class="icon-btn xs" type="button" data-mren="' + i + '" data-ico="pencil" title="Переименовать" aria-label="Переименовать измерение ' + (i + 1) + '"></button><button class="icon-btn xs danger" type="button" data-mdel="' + i + '" data-ico="trash-2" title="Удалить" aria-label="Удалить измерение ' + (i + 1) + '"></button></div><div class="meas-saved-footer"><span class="meas-room-context">' + roomName + '</span><span class="meas-doc-status ' + statusClass + '">' + esc(status) + '</span><button class="btn xs meas-doc-compare" type="button" data-mcmp="' + i + '" title="Сопоставить с документацией помещения">' + IB('scale', 'Сверить', 14) + '</button></div></div>';
    }).join('');
    Array.prototype.forEach.call(body.querySelectorAll('[data-mdel]'), b => b.addEventListener('click', () => { __measurements.splice(Number(b.getAttribute('data-mdel')), 1); renderMeasList(); persistMeasurements(); }));
    Array.prototype.forEach.call(body.querySelectorAll('[data-mren]'), b => b.addEventListener('click', () => renameMeasurement(Number(b.getAttribute('data-mren')))));
    Array.prototype.forEach.call(body.querySelectorAll('[data-mcmp]'), b => b.addEventListener('click', () => compareSavedMeasurement(Number(b.getAttribute('data-mcmp')))));
    notifyMeasurementsChanged();
  }
  function notifyMeasurementsChanged() {
    try { window.dispatchEvent(new CustomEvent('lx-measurements-changed', { detail: { count: __measurements.length } })); } catch (_) {}
  }
  // Переименование/подпись сохранённого измерения через инлайн-поле (prompt может быть недоступен в Electron).
  function renameMeasurement(idx) {
    const m = __measurements[idx]; if (!m) return;
    const body = $('measureListBody'); if (!body) return;
    const rows = body.children; const row = rows[idx]; if (!row) return;
    const span = row.querySelector('.measure-row-label'); if (!span) return;
    const cur = m.label || '';
    span.innerHTML = '<input type="text" value="' + esc(cur).replace(/"/g, '&quot;') + '" placeholder="Подпись измерения…" class="meas-rename" />';
    const inp = span.querySelector('input'); if (!inp) return;
    inp.focus(); inp.select();
    let finished = false;
    const commit = () => {
      if (finished) return;
      finished = true;
      const next = inp.value.trim();
      const changed = next !== (m.label || '');
      m.label = next;
      renderMeasList(); persistMeasurements();
      if (changed) autoCompareMeasurementInBackground(idx);
    };
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); finished = true; renderMeasList(); }
    });
    inp.addEventListener('blur', commit);
  }
  function saveMeasurement() {
    const res = viewer && viewer._measResult;
    if (!res || res.error || (res.mode === 'deviation' && res.signed === undefined) || (res.mode === 'corner' && !(res.planeCount >= 2))) {
      toast(res && !res.error && res.mode === 'deviation' ? 'Выбрана опорная плоскость — кликните точку или вторую поверхность, тогда измерение можно сохранить'
        : res && !res.error && res.mode === 'corner' ? 'Выбрана одна плоскость — кликните соседнюю, тогда измерение можно сохранить' : 'Нет готового измерения для сохранения');
      return;
    }
    storeMeasurement(res, {});
    toast('Сохранено измерений: ' + __measurements.length);
  }
  // Общая точка сохранения: основной вьюер и окно «Инспектор объекта» кладут измерения в один список.
  // extra: { objectType, objectName, origin, label, silent } — тип объекта помогает подобрать требование в документах.
  const DC_UNITS_KEY = 'bim.docCheck.defaultUnits';
  function dcDefaultUnits() { try { return localStorage.getItem(DC_UNITS_KEY) || ''; } catch (_) { return ''; } }
  function storeMeasurement(res, extra) {
    extra = extra || {};
    const saved = JSON.parse(JSON.stringify(res));
    const cloud = viewer && viewer._cloudRecord || {};
    const sourcePath = String(cloud.sourceName || lastCloudPath || '');
    const inferredObjectType = !selEl && !extra.objectType && res.mode === 'plane'
      ? (/стен/iu.test(res.kind || '') ? 'стена' : /пол|потол/iu.test(res.kind || '') ? 'пол/потолок' : /наклон/iu.test(res.kind || '') ? 'наклонная поверхность' : null)
      : null;
    const chosenType = extra.objectType || null;
    if (extra.label && !saved.label) saved.label = String(extra.label).slice(0, 120);
    saved.measurementContext = {
      roomId: current && current.id || null,
      roomName: current && current.name || null,
      elementId: selEl && selEl.id || null,
      elementName: chosenType ? chosenType : (selEl && selEl.name || inferredObjectType),
      elementType: chosenType ? chosenType : (selEl && selEl.type || inferredObjectType),
      elementGuid: selEl && selEl.ifc_guid || null,
      inferredFromGeometry: !chosenType && !!inferredObjectType,
      objectTypeChosenByUser: !!chosenType,
      objectName: extra.objectName || null,
      origin: extra.origin || 'viewer',
      cloudName: sourcePath.split(/[\\/]/).pop() || null,
      sourceUnits: viewer && viewer._srcUnits || dcDefaultUnits() || null,
      unitsConfirmedByUser: !(viewer && viewer._srcUnits) && !!dcDefaultUnits(),
      hasCrs: !!(viewer && viewer._srcCrs)
    };
    if (!Array.isArray(saved.docComparisons)) saved.docComparisons = [];
    __measurements.push(saved);
    renderMeasList();
    persistMeasurements();
    autoCompareMeasurementInBackground(__measurements.length - 1);
    return __measurements.length - 1;
  }
  var __measurementDocCompareCache = new Map();
  function comparisonDocCacheKey(d) {
    return [d && d.id || '', d && d.file || '', d && d.version || '', d && d.date || ''].join('|');
  }
  function comparisonFileExt(d) {
    const names = [d && d.name, d && d.file];
    let fallback = '';
    for (const name of names) {
      const match = /\.([a-z0-9]{1,8})$/i.exec(String(name || '').split(/[?#]/)[0]);
      if (!match) continue;
      const ext = match[1].toLowerCase();
      if (!fallback) fallback = ext;
      if (comparisonSupportedExt(ext) || comparisonOcrExt(ext)) return ext;
    }
    return fallback;
  }
  function comparisonDocName(d) {
    const name = String(d && d.name || '').trim();
    if (name) return name;
    return String(d && d.file || '').split(/[\\/]/).pop() || 'Документ';
  }
  function comparisonSupportedExt(ext) {
    return ['pdf', 'docx', 'xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'csv', 'tsv', 'txt', 'md', 'dxf'].includes(ext);
  }
  function comparisonOcrExt(ext) {
    return ['pdf', 'png', 'jpg', 'jpeg', 'bmp', 'webp', 'tif', 'tiff'].includes(ext);
  }
  async function parseComparisonDocument(doc) {
    const C = window.MeasurementDocCompare;
    if (!C || !API || !API.readDocument) return { ok: false, reason: 'Чтение документов недоступно в этом режиме.', requirements: [], diagnostics: {} };
    const key = comparisonDocCacheKey(doc);
    if (__measurementDocCompareCache.has(key)) return __measurementDocCompareCache.get(key);
    const pending = (async () => {
      const info = await API.readDocument(doc.id);
      if (!info || !info.ok) return { ok: false, reason: info && info.error || 'Не удалось прочитать файл.', requirements: [], diagnostics: {}, textTruncated: false };
      const ext = String(info.ext || comparisonFileExt(doc));
      let sheets = Array.isArray(info.sheets) ? info.sheets : [];
      if (!sheets.length && (ext === 'csv' || ext === 'tsv') && info.text) {
        sheets = [{ name: ext.toUpperCase(), rows: C.parseDelimitedText(info.text) }];
      }
      const parsed = C.extractRequirements({
        documentId: doc.id || null,
        documentName: comparisonDocName(doc),
        text: info.text || '',
        sheets: sheets,
        textTruncated: !!info.textTruncated
      });
      return {
        ok: true,
        requirements: parsed.requirements,
        diagnostics: parsed.diagnostics,
        textTruncated: !!info.textTruncated,
        hasText: !!(info.text && info.text.trim()) || sheets.length > 0,
        kind: info.kind || ext,
        error: info.parseError || null
      };
    })();
    __measurementDocCompareCache.set(key, pending);
    try { return await pending; }
    catch (error) {
      __measurementDocCompareCache.delete(key);
      return { ok: false, reason: String(error && error.message || error), requirements: [], diagnostics: {} };
    }
  }
  var __measurementOcrCompareCache = new Map();
  var __measurementRoomRequirementCache = new Map();
  function invalidateComparisonDocument(doc) {
    if (!doc) return;
    const key = comparisonDocCacheKey(doc);
    __measurementDocCompareCache.delete(key);
    __measurementOcrCompareCache.delete(key + '|ocr');
  }
  async function parseComparisonOcrDocument(doc, force) {
    const C = window.MeasurementDocCompare;
    if (!C || !API || !API.ocrDocument) return { ok: false, reason: 'OCR недоступен.', requirements: [], diagnostics: {} };
    const key = comparisonDocCacheKey(doc) + '|ocr';
    if (force) __measurementOcrCompareCache.delete(key);
    if (__measurementOcrCompareCache.has(key)) return __measurementOcrCompareCache.get(key);
    const pending = (async () => {
      const response = await API.ocrDocument(doc.id);
      if (!response || !response.ok || !response.text) {
        return { ok: false, reason: response && (response.reason || response.error) || 'OCR не вернул текст.', requirements: [], diagnostics: {} };
      }
      const parsed = C.extractRequirements({
        documentId: doc.id || null,
        documentName: comparisonDocName(doc),
        text: response.text,
        textTruncated: !!response.truncated,
        ocr: true
      });
      return {
        ok: true,
        requirements: parsed.requirements,
        diagnostics: parsed.diagnostics,
        textTruncated: !!response.truncated,
        hasText: true,
        kind: 'ocr'
      };
    })();
    __measurementOcrCompareCache.set(key, pending);
    try { return await pending; }
    catch (error) {
      __measurementOcrCompareCache.delete(key);
      return { ok: false, reason: String(error && error.message || error), requirements: [], diagnostics: {} };
    }
  }
  function comparisonRoomCacheKey(room, autoOcr) {
    const docs = roomDocs(room).filter(d => d && d.file);
    return [room && room.id || '', autoOcr ? 'ocr' : 'native'].concat(docs.map(comparisonDocCacheKey).sort()).join('||');
  }
  function invalidateRoomRequirementCache(room) {
    const prefix = String(room && room.id || '') + '||';
    for (const key of __measurementRoomRequirementCache.keys()) {
      if (String(key).startsWith(prefix)) __measurementRoomRequirementCache.delete(key);
    }
  }
  // Требования: документы помещения + «свои размеры», введённые вручную (они не привязаны к файлам и кэшу документов)
  async function scanRoomRequirements(room, options) {
    const base = await scanRoomRequirementsDocs(room, options);
    const manual = dcManualEntries();
    return manual.length ? Object.assign({}, base, { entries: (base.entries || []).concat(manual), manualCount: manual.length }) : base;
  }
  function dcManualScan() {
    const entries = dcManualEntries();
    return { entries, docs: [], readCount: 0, ocrCount: 0, skippedCount: 0, nativeCadSkipped: false, errors: [], ocrFailures: [], manualCount: entries.length };
  }
  async function scanRoomRequirementsDocs(room, options) {
    options = options || {};
    const autoOcr = options.autoOcr !== false;
    const docs = roomDocs(room).filter(d => d && d.file);
    const cacheKey = comparisonRoomCacheKey(room, autoOcr);
    if (options.force) __measurementRoomRequirementCache.delete(cacheKey);
    if (__measurementRoomRequirementCache.has(cacheKey)) {
      if (options.onProgress) options.onProgress({ stage: 'cache', current: docs.length, total: docs.length, name: '' });
      return __measurementRoomRequirementCache.get(cacheKey);
    }
    const pending = (async () => {
      const entries = [];
      const errors = [];
      const ocrFailures = [];
      let readCount = 0, ocrCount = 0, skippedCount = 0, nativeCadSkipped = false;
      if (!API || !API.readDocument) {
        return { entries, docs, readCount, ocrCount, skippedCount: docs.length, nativeCadSkipped, errors: ['Чтение документов недоступно.'], ocrFailures };
      }
      const addParsed = (doc, parsed) => {
        for (const requirement of parsed && parsed.requirements || []) {
          if (requirement.source) {
            requirement.source.documentId = requirement.source.documentId || doc.id || null;
            requirement.source.documentName = requirement.source.documentName || comparisonDocName(doc);
          }
          entries.push({
            id: String(doc.id || 'doc') + ':' + String(requirement.id || entries.length),
            requirement,
            doc
          });
        }
      };
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        const ext = comparisonFileExt(doc);
        if (options.onProgress) options.onProgress({ stage: 'read', current: i + 1, total: docs.length, name: comparisonDocName(doc) });
        let found = 0;
        if (comparisonSupportedExt(ext)) {
          const parsed = await parseComparisonDocument(doc);
          readCount++;
          if (parsed.ok) {
            addParsed(doc, parsed);
            found = parsed.requirements.length;
            if (parsed.error) errors.push(comparisonDocName(doc) + ': ' + parsed.error);
          } else errors.push(comparisonDocName(doc) + ': ' + parsed.reason);
        }
        if (!found && autoOcr && comparisonOcrExt(ext) && API.ocrDocument) {
          if (options.onProgress) options.onProgress({ stage: 'ocr', current: i + 1, total: docs.length, name: comparisonDocName(doc) });
          const parsedOcr = await parseComparisonOcrDocument(doc, false);
          ocrCount++;
          if (parsedOcr.ok) {
            addParsed(doc, parsedOcr);
            found = parsedOcr.requirements.length;
          } else {
            ocrFailures.push({ doc, reason: parsedOcr.reason });
          }
        }
        if (!comparisonSupportedExt(ext) && !(autoOcr && comparisonOcrExt(ext))) {
          skippedCount++;
          if (['dwg', 'rvt', 'rfa', 'rte', 'ifc', 'ifczip'].includes(ext)) nativeCadSkipped = true;
        }
      }
      return { entries, docs, readCount, ocrCount, skippedCount, nativeCadSkipped, errors, ocrFailures };
    })();
    __measurementRoomRequirementCache.set(cacheKey, pending);
    try { return await pending; }
    catch (error) {
      __measurementRoomRequirementCache.delete(cacheKey);
      return { entries: [], docs, readCount: 0, ocrCount: 0, skippedCount: 0, nativeCadSkipped: false, errors: [String(error && error.message || error)], ocrFailures: [] };
    }
  }
  function comparisonUnitOptions(kind) {
    if (kind === 'linear') return [{ value: 'м', label: 'м — метры' }, { value: 'мм', label: 'мм — миллиметры' }, { value: 'см', label: 'см — сантиметры' }, { value: 'ft', label: 'ft — футы' }, { value: 'in', label: 'in — дюймы' }];
    if (kind === 'area') return [{ value: 'м²', label: 'м² — квадратные метры' }, { value: 'см²', label: 'см² — квадратные сантиметры' }, { value: 'мм²', label: 'мм² — квадратные миллиметры' }, { value: 'ft²', label: 'ft² — квадратные футы' }, { value: 'in²', label: 'in² — квадратные дюймы' }];
    if (kind === 'angle') return [{ value: '°', label: '° — градусы' }, { value: 'rad', label: 'rad — радианы' }];
    if (kind === 'slope') return [{ value: '%', label: '% — проценты' }];
    return [];
  }
  function comparisonDimensionLabel(dimension) {
    return ({
      width: 'ширина', height: 'высота', length: 'длина', thickness: 'толщина',
      diameter: 'диаметр', gap: 'зазор', area: 'площадь', angle: 'угол',
      slope: 'уклон', unspecified: 'размер', pair: 'пара размеров',
      first: 'первый размер', second: 'второй размер'
    })[dimension] || 'размер';
  }
  function comparisonRequirementLabel(entry) {
    const r = entry && entry.requirement || {};
    if (r.kind === 'pair') {
      const a = r.values && r.values[0], b = r.values && r.values[1];
      if (!a || !b) return 'Пара размеров';
      return 'Размеры ' + a.value + ' ' + a.unit + ' × ' + b.value + ' ' + b.unit;
    }
    const tolerance = Number.isFinite(r.toleranceValue) ? ' ± ' + r.toleranceValue + ' ' + (r.toleranceUnit || r.unit) : '';
    return comparisonDimensionLabel(r.dimension) + ': ' + r.value + ' ' + (r.unit || '') + tolerance;
  }
  function measurementRoom(measurement) {
    const context = measurement && measurement.measurementContext || {};
    return context.roomId && Array.isArray(DB && DB.rooms) ? DB.rooms.find(r => r.id === context.roomId) || null : null;
  }
  function automaticMatchFingerprint(measurement, match) {
    const req = match && match.selectedRequirement || {};
    const source = req.source || match && match.requirement && match.requirement.source || {};
    return [
      source.documentId || '', match && match.requirement && match.requirement.id || '',
      match && match.field && match.field.key || '', match && match.pairIndex != null ? match.pairIndex : '',
      match && match.field && match.field.value != null ? match.field.value : '', match && match.unit || ''
    ].join('|');
  }
  function appendMeasurementComparison(measurement, comparison) {
    if (!Array.isArray(measurement.docComparisons)) measurement.docComparisons = [];
    const last = measurement.docComparisons[measurement.docComparisons.length - 1];
    if (last && last.automation && comparison.automation &&
        last.automation.fingerprint && last.automation.fingerprint === comparison.automation.fingerprint) {
      measurement.docComparisons[measurement.docComparisons.length - 1] = comparison;
    } else measurement.docComparisons.push(comparison);
    if (measurement.docComparisons.length > 20) measurement.docComparisons.splice(0, measurement.docComparisons.length - 20);
    measurement.docComparison = comparison;
    measurement.autoComparisonProposal = null;
  }
  function buildAutomaticComparisonRecord(measurement, room, ranked, ranking) {
    if (!ranked || !ranked.preview || !ranked.field || !ranked.unit) return null;
    const result = ranked.preview;
    if (!['within-tolerance', 'outside-tolerance', 'tolerance-not-specified'].includes(result.status) || !Number.isFinite(result.actual)) return null;
    const req = ranked.requirement || {};
    const selected = ranked.selectedRequirement || req;
    const source = req.source || {};
    const context = measurement.measurementContext || {};
    return {
      schema: 'bim-twin.document-measurement-comparison.v2',
      id: 'doccmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      createdAt: new Date().toISOString(),
      status: result.status,
      statusLabel: docComparisonStatusLabel(result.status),
      field: {
        key: ranked.field.key,
        label: ranked.field.label,
        rawValue: ranked.field.value,
        kind: ranked.field.kind,
        unit: ranked.unit
      },
      expected: {
        value: selected.value,
        unit: selected.unit,
        baseValue: result.expected,
        kind: selected.kind,
        dimension: selected.dimension,
        toleranceValue: selected.toleranceValue == null ? null : selected.toleranceValue,
        toleranceUnit: selected.toleranceUnit || selected.unit || null,
        toleranceMode: result.toleranceMode || null,
        bound: result.bound == null ? null : result.bound
      },
      actual: { rawValue: ranked.field.value, unit: ranked.unit, baseValue: result.actual, kind: ranked.field.kind },
      delta: result.delta,
      absoluteDelta: result.absoluteDelta,
      percentDelta: result.percentDelta,
      source: {
        origin: 'document',
        documentId: source.documentId || null,
        documentName: source.documentName || 'Документ',
        sheet: source.sheet || null,
        row: source.row || null,
        line: source.line || null,
        page: source.page || null,
        excerpt: source.excerpt || '',
        confidence: req.confidence || 'medium',
        ocr: !!source.ocr,
        truncated: !!source.truncated
      },
      confirmations: {
        room: true,
        sourceRequirement: true,
        unitsOrScale: true,
        autoConfirmed: true,
        method: 'deterministic-smart-match-v1'
      },
      automation: {
        mode: 'automatic',
        algorithmVersion: '1.0.0',
        score: ranked.score,
        confidence: ranked.confidence,
        margin: ranking && ranking.margin || 0,
        reasons: ranked.reasons || [],
        warnings: ranked.warnings || [],
        reasonCodes: ranked.reasonCodes || [],
        warningCodes: ranked.warningCodes || [],
        fingerprint: automaticMatchFingerprint(measurement, ranked)
      },
      context: {
        roomId: room && room.id || context.roomId || null,
        roomName: room && room.name || context.roomName || null,
        elementId: context.elementId || null,
        elementName: context.elementName || null,
        elementType: context.elementType || null,
        elementGuid: context.elementGuid || null,
        cloudName: context.cloudName || null
      }
    };
  }
  function setAutomaticProposal(measurement, room, ranking, state, label) {
    const best = ranking && ranking.best;
    const req = best && best.requirement || {};
    const source = req.source || {};
    const context = measurement.measurementContext || {};
    measurement.autoComparisonProposal = {
      schema: 'bim-twin.document-measurement-proposal.v1',
      createdAt: new Date().toISOString(),
      status: state === 'analyzing' ? 'analyzing' : state === 'no-match' ? 'no-match' : 'needs-review',
      statusLabel: label || (state === 'analyzing' ? 'Анализ документов…' : state === 'no-match' ? 'Требование не найдено' : state === 'ambiguous' ? 'Неоднозначное совпадение' : 'Нужна проверка'),
      source: best ? {
        documentId: source.documentId || null,
        documentName: source.documentName || null,
        excerpt: source.excerpt || '',
        ocr: !!source.ocr,
        truncated: !!source.truncated
      } : null,
      candidate: best ? {
        requirementId: req.id || null,
        fieldKey: best.field && best.field.key || null,
        pairIndex: best.pairIndex,
        unit: best.unit,
        score: best.score
      } : null,
      preview: best ? dcSummarize(best) : null,
      automation: {
        state: state,
        algorithmVersion: '1.0.0',
        score: best && best.score || 0,
        confidence: best && best.confidence || 'low',
        margin: ranking && ranking.margin || 0,
        reasons: best && best.reasons || [],
        warnings: best && best.warnings || []
      },
      context: {
        roomId: room && room.id || context.roomId || null,
        roomName: room && room.name || context.roomName || null,
        elementId: context.elementId || null,
        elementName: context.elementName || null
      }
    };
  }
  function rankMeasurementAgainstEntries(measurement, entries) {
    const C = window.MeasurementDocCompare;
    if (!C || !C.rankRequirementMatches) return { matches: [], best: null, margin: 0, decision: { state: 'no-match', canAutoConfirm: false } };
    const context = measurement.measurementContext || {};
    return C.rankRequirementMatches({
      measurement,
      context,
      sourceUnits: context.sourceUnits,
      candidates: entries || []
    });
  }
  function applyAutomaticComparison(measurement, room, scan) {
    const ranking = rankMeasurementAgainstEntries(measurement, scan && scan.entries || []);
    if (ranking.decision && ranking.decision.canAutoConfirm) {
      const comparison = buildAutomaticComparisonRecord(measurement, room, ranking.best, ranking);
      if (comparison) {
        appendMeasurementComparison(measurement, comparison);
        return { state: 'auto-confirmed', comparison, ranking };
      }
    }
    const state = !ranking.best ? 'no-match' : ranking.decision && ranking.decision.state || 'needs-review';
    setAutomaticProposal(measurement, room, ranking, state);
    return { state, comparison: null, ranking };
  }
  async function autoCompareMeasurementInBackground(index) {
    const measurement = __measurements[index];
    if (!measurement || !window.MeasurementDocCompare) return;
    const room = measurementRoom(measurement);
    if (!room && !dcManualEntries().length) {
      setAutomaticProposal(measurement, null, null, 'needs-review', 'Укажите помещение');
      renderMeasList(); persistMeasurements();
      return;
    }
    const historyCount = Array.isArray(measurement.docComparisons) ? measurement.docComparisons.length : 0;
    setAutomaticProposal(measurement, room, null, 'analyzing');
    renderMeasList();
    try {
      const scan = room ? await scanRoomRequirements(room, { autoOcr: true }) : dcManualScan();
      // A manual result saved while background analysis was running wins.
      if ((measurement.docComparisons || []).length > historyCount) return;
      const outcome = applyAutomaticComparison(measurement, room, scan);
      renderMeasList(); persistMeasurements();
      if (outcome.comparison) {
        toast(outcome.comparison.status === 'outside-tolerance'
          ? 'Автосверка: найдено отклонение от документа'
          : 'Автосверка завершена: ' + outcome.comparison.statusLabel);
      }
    } catch (error) {
      setAutomaticProposal(measurement, room, null, 'needs-review', 'Ошибка анализа документов');
      renderMeasList(); persistMeasurements();
    }
  }
  async function refreshAutomaticComparisonsForRoom(roomId) {
    const room = Array.isArray(DB && DB.rooms) ? DB.rooms.find(item => item.id === roomId) : null;
    if (!room) return;
    const indexes = [];
    __measurements.forEach((measurement, index) => {
      if (measurement && measurement.measurementContext && measurement.measurementContext.roomId === roomId) indexes.push(index);
    });
    if (!indexes.length) return;
    invalidateRoomRequirementCache(room);
    try {
      const scan = await scanRoomRequirements(room, { autoOcr: true, force: true });
      let confirmed = 0, outside = 0;
      for (const index of indexes) {
        const measurement = __measurements[index];
        if (!measurement) continue;
        const outcome = applyAutomaticComparison(measurement, room, scan);
        if (outcome.comparison) {
          confirmed++;
          if (outcome.comparison.status === 'outside-tolerance') outside++;
        }
      }
      renderMeasList(); persistMeasurements();
      if (outside) toast('Документация обновлена: найдено отклонений — ' + outside);
      else if (confirmed) toast('Документация обновлена: пересверено измерений — ' + confirmed);
    } catch (error) {
      try { console.warn('[measurements] automatic document refresh failed', error); } catch (_) {}
    }
  }
  function showAutomaticComparisonSummary(counts) {
    const modal = modalPanel('Автосверка всех измерений');
    const summary = mk('div', 'cmp-batch-summary');
    summary.appendChild(mk('strong', '', 'Обработано: ' + counts.total));
    const list = document.createElement('ul');
    [
      ['Автоматически сопоставлено', counts.confirmed],
      ['Соответствует допуску', counts.within],
      ['Найдены отклонения', counts.outside],
      ['Допуск в источнике не задан', counts.noTolerance],
      ['Нужна проверка', counts.review],
      ['Требование не найдено', counts.noMatch]
    ].forEach(row => {
      const li = document.createElement('li'); li.textContent = row[0] + ': ' + row[1]; list.appendChild(li);
    });
    summary.appendChild(list);
    summary.appendChild(mk('div', 'cmp-small-hint', 'Автоматический статус присвоен только при однозначном совпадении объекта, размера, источника и подтверждённых метаданных единиц. OCR и неоднозначные совпадения оставлены на проверку.'));
    const close = mk('button', 'btn sm primary', 'Готово'); close.type = 'button'; close.onclick = () => modal.close();
    summary.appendChild(close); modal.body.appendChild(summary);
  }
  async function computeAllComparisons(onProgress) {
    const counts = { total: __measurements.length, confirmed: 0, within: 0, outside: 0, noTolerance: 0, review: 0, noMatch: 0 };
    const scans = new Map();
    for (let i = 0; i < __measurements.length; i++) {
      const measurement = __measurements[i];
      const room = measurementRoom(measurement);
      if (onProgress) onProgress({ current: i + 1, total: __measurements.length });
      if (!room && !dcManualEntries().length) {
        setAutomaticProposal(measurement, null, null, 'needs-review', 'Укажите помещение');
        counts.review++;
        continue;
      }
      const scanKey = room ? room.id : '__manual__';
      if (!scans.has(scanKey)) scans.set(scanKey, room ? await scanRoomRequirements(room, { autoOcr: true }) : dcManualScan());
      const outcome = applyAutomaticComparison(measurement, room, scans.get(scanKey));
      if (outcome.comparison) {
        counts.confirmed++;
        if (outcome.comparison.status === 'within-tolerance') counts.within++;
        else if (outcome.comparison.status === 'outside-tolerance') counts.outside++;
        else counts.noTolerance++;
      } else if (outcome.state === 'no-match') counts.noMatch++;
      else counts.review++;
    }
    renderMeasList(); persistMeasurements();
    return counts;
  }
  async function autoCompareAllMeasurements() {
    if (!__measurements.length) { toast('Список измерений пуст'); return; }
    const button = $('mlAutoCompare');
    if (button) { button.disabled = true; setLbl(button, 'Анализ…'); }
    try {
      showAutomaticComparisonSummary(await computeAllComparisons());
    } finally {
      if (button) { button.disabled = false; setLbl(button, 'Сверить всё'); }
    }
  }
  // ---------- Мост для окна «Сверка с документацией» (ui/verify.js) и окна «Инспектор объекта» ----------
  // Логика сверки остаётся здесь и в measurement-doc-compare.js; окна только показывают строки и вызывают эти методы.
  function dcFmt(value, kind, unit) {
    const C = window.MeasurementDocCompare;
    return C && Number.isFinite(value) ? C.formatBaseValue(value, kind, unit) : null;
  }
  function dcSigned(value, kind, unit) {
    if (!Number.isFinite(value)) return null;
    const text = dcFmt(Math.abs(value), kind, unit);
    if (!text) return null;
    return (value > 0 ? '+' : value < 0 ? '\u2212' : '') + text;
  }
  function dcExpectedText(ex) {
    if (!ex || ex.value == null) return '';
    const base = ex.value + ' ' + (ex.unit || '');
    if (ex.toleranceMode === 'symmetric' && Number.isFinite(ex.toleranceValue)) return base + ' \u00b1 ' + ex.toleranceValue + ' ' + (ex.toleranceUnit || ex.unit || '');
    if (ex.toleranceMode === 'max' && Number.isFinite(ex.bound)) return '\u2264 ' + (dcFmt(ex.bound, ex.kind, ex.unit) || base);
    if (ex.toleranceMode === 'min' && Number.isFinite(ex.bound)) return '\u2265 ' + (dcFmt(ex.bound, ex.kind, ex.unit) || base);
    return base;
  }
  function dcSummarize(ranked) {
    const r = ranked && (ranked.selectedRequirement || ranked.requirement) || {};
    const pv = ranked && ranked.preview || {};
    return {
      expectedText: dcExpectedText({ value: r.value, unit: r.unit, kind: r.kind, toleranceMode: r.toleranceMode, toleranceValue: r.toleranceValue, toleranceUnit: r.toleranceUnit, bound: r.bound }),
      actualText: dcFmt(pv.actual, r.kind, r.unit),
      deltaText: dcSigned(pv.delta, r.kind, r.unit),
      previewStatus: pv.status || null,
      fieldLabel: ranked && ranked.field && ranked.field.label || ''
    };
  }
  function dcPlainValue(m) {
    try { return window.Measure && window.Measure.measureValueText ? window.Measure.measureValueText(m) : ''; } catch (_) { return ''; }
  }
  function dcSourceOf(cmp) {
    const s = cmp && cmp.source || {};
    const loc = [];
    if (s.sheet) loc.push('лист ' + s.sheet);
    if (s.row) loc.push('строка ' + s.row);
    if (s.page) loc.push('стр. ' + s.page);
    else if (s.line) loc.push('строка текста ' + s.line);
    return { documentId: s.documentId || null, documentName: s.documentName || '', location: loc.join(', '), excerpt: s.excerpt || '', ocr: !!s.ocr, truncated: !!s.truncated };
  }
  function dcRow(m, i) {
    const cmp = latestDocComparison(m);
    const ctx = m.measurementContext || {};
    const saved = !!(cmp && cmp.expected);
    const status = cmp ? String(cmp.status || 'needs-review') : 'not-checked';
    const auto = cmp && cmp.automation || {};
    const row = {
      index: i, label: m.label || '', mode: m.mode, valueText: dcPlainValue(m),
      roomId: ctx.roomId || null, roomName: ctx.roomName || '', objectType: ctx.elementType || '', objectByUser: !!ctx.objectTypeChosenByUser,
      origin: ctx.origin || 'viewer', units: ctx.sourceUnits || '', unitsByUser: !!ctx.unitsConfirmedByUser,
      status, statusLabel: cmp ? (cmp.statusLabel || docComparisonStatusLabel(status)) : 'Не сверено',
      confirmed: saved,
      how: !cmp ? '' : !saved ? 'proposal' : cmp.confirmations && cmp.confirmations.method === 'user-accepted-suggestion' ? 'user' : auto.mode === 'automatic' ? 'auto' : 'manual',
      expectedText: '', actualText: '', deltaText: '', fieldLabel: '', source: null,
      score: auto.score || 0, confidence: auto.confidence || '', reasons: auto.reasons || [], warnings: auto.warnings || []
    };
    if (saved) {
      const ex = cmp.expected;
      row.expectedText = dcExpectedText(ex);
      row.actualText = dcFmt(cmp.actual && cmp.actual.baseValue, ex.kind, ex.unit) || '';
      row.deltaText = dcSigned(cmp.delta, ex.kind, ex.unit) || '';
      row.fieldLabel = cmp.field && cmp.field.label || '';
      row.source = dcSourceOf(cmp);
    } else if (cmp && cmp.candidate) {
      const pv = cmp.preview || {};
      row.expectedText = pv.expectedText || ''; row.actualText = pv.actualText || ''; row.deltaText = pv.deltaText || '';
      row.fieldLabel = pv.fieldLabel || ''; row.previewStatus = pv.previewStatus || null;
      row.source = cmp.source ? dcSourceOf({ source: cmp.source }) : null;
    }
    return row;
  }
  function dcRoomsInfo() {
    const rooms = Array.isArray(DB && DB.rooms) ? DB.rooms : [];
    return rooms.map(r => ({ id: r.id, name: r.name || 'Без названия', docs: roomDocs(r).filter(d => d && d.file).length }));
  }
  function dcMeta() {
    const missing = __measurements.filter(m => !(m.measurementContext && m.measurementContext.sourceUnits)).length;
    return { count: __measurements.length, currentRoomId: current && current.id || null, currentRoomName: current && current.name || '', rooms: dcRoomsInfo(), missingUnits: missing, defaultUnits: dcDefaultUnits(), manualCount: dcManualLoad().length };
  }
  async function dcCandidates(i) {
    const m = __measurements[i];
    if (!m) return { ok: false, reason: 'no-measurement', list: [] };
    const room = measurementRoom(m);
    if (!room && !dcManualEntries().length) return { ok: false, reason: 'no-room', list: [] };
    const scan = room ? await scanRoomRequirements(room, { autoOcr: true }) : dcManualScan();
    const ranking = rankMeasurementAgainstEntries(m, scan.entries);
    const list = [];
    ranking.matches.slice(0, 6).forEach((mt, key) => {
      const source = dcSourceOf({ source: (mt.requirement && mt.requirement.source) || {} });
      list.push(Object.assign({
        key, score: mt.score, confidence: mt.confidence, reasons: mt.reasons || [], warnings: mt.warnings || [],
        label: comparisonRequirementLabel(mt.entry), canConfirm: !!(mt.preview && ['within-tolerance', 'outside-tolerance', 'tolerance-not-specified'].includes(mt.preview.status)),
        needsUnits: !mt.unit, source
      }, dcSummarize(mt)));
    });
    return { ok: true, list, decision: ranking.decision, docs: scan.docs.length, readCount: scan.readCount, ocrCount: scan.ocrCount, errors: scan.errors };
  }
  async function dcAccept(i, key) {
    const m = __measurements[i];
    const room = m && measurementRoom(m);
    if (!m || (!room && !dcManualEntries().length)) { toast('Укажите помещение измерения'); return { ok: false, reason: 'no-room' }; }
    const scan = room ? await scanRoomRequirements(room, { autoOcr: true }) : dcManualScan();
    const ranking = rankMeasurementAgainstEntries(m, scan.entries);
    const ranked = ranking.matches[Number(key)];
    if (!ranked) { toast('Вариант устарел: обновите список'); return { ok: false, reason: 'stale' }; }
    if (!ranked.unit) { toast('Сначала укажите единицы измерения облака'); return { ok: false, reason: 'units' }; }
    const record = buildAutomaticComparisonRecord(m, room, ranked, ranking);
    if (!record) { toast('Для этого варианта нельзя посчитать отклонение'); return { ok: false, reason: 'no-result' }; }
    record.automation.mode = 'user-accepted';
    record.confirmations.autoConfirmed = false;
    record.confirmations.method = 'user-accepted-suggestion';
    record.confirmations.acceptedAt = new Date().toISOString();
    appendMeasurementComparison(m, record);
    renderMeasList(); persistMeasurements();
    return { ok: true, status: record.status };
  }
  function dcSetContext(i, patch) {
    const m = __measurements[i]; if (!m) return false;
    const ctx = m.measurementContext = m.measurementContext || {};
    patch = patch || {};
    if (Object.prototype.hasOwnProperty.call(patch, 'objectType')) {
      const t = String(patch.objectType || '').trim();
      ctx.elementType = t || null; ctx.elementName = t || null;
      ctx.objectTypeChosenByUser = !!t; ctx.inferredFromGeometry = false;
    }
    if (patch.roomId) {
      const room = Array.isArray(DB && DB.rooms) ? DB.rooms.find(r => r.id === patch.roomId) : null;
      if (room) { ctx.roomId = room.id; ctx.roomName = room.name || null; }
    }
    if (patch.units) { ctx.sourceUnits = String(patch.units); ctx.unitsConfirmedByUser = true; }
    renderMeasList(); persistMeasurements();
    autoCompareMeasurementInBackground(i);
    return true;
  }
  // Единицы облака часто не записаны в файле (PLY, часть LAS): один раз подтверждаем их для всех измерений и запоминаем.
  async function dcSetDefaultUnits(unit) {
    const u = String(unit || '').trim();
    if (!u || !window.MeasurementDocCompare || !window.MeasurementDocCompare.unitInfo(u)) return null;
    try { localStorage.setItem(DC_UNITS_KEY, u); } catch (_) {}
    __measurements.forEach(m => {
      const ctx = m.measurementContext = m.measurementContext || {};
      if (!ctx.sourceUnits) { ctx.sourceUnits = u; ctx.unitsConfirmedByUser = true; }
    });
    renderMeasList(); persistMeasurements();
    return computeAllComparisons();
  }
  function dcRemove(i) {
    if (!__measurements[i]) return false;
    __measurements.splice(i, 1); renderMeasList(); persistMeasurements(); return true;
  }
  async function dcRequirements(roomId, opts) {
    opts = opts || {};
    const rooms = Array.isArray(DB && DB.rooms) ? DB.rooms : [];
    const room = rooms.find(r => r.id === roomId) || current || null;
    if (!room) return { ok: false, reason: 'no-room', docs: [], items: [], manual: dcManualInfo() };
    const scan = await scanRoomRequirements(room, { autoOcr: true, force: !!opts.force, onProgress: opts.onProgress });
    const counts = new Map();
    scan.entries.forEach(e => { const k = String(e.doc && e.doc.id || ''); counts.set(k, (counts.get(k) || 0) + 1); });
    const docs = scan.docs.map(d => {
      const ext = comparisonFileExt(d);
      const found = counts.get(String(d.id || '')) || 0;
      const readable = comparisonSupportedExt(ext) || comparisonOcrExt(ext);
      return { id: d.id, name: comparisonDocName(d), ext, found, state: found ? 'ok' : readable ? 'empty' : 'skipped' };
    });
    const items = scan.entries.filter(e => !(e.doc && e.doc.type === 'manual')).map(e => ({
      id: e.id, label: comparisonRequirementLabel(e), dimension: comparisonDimensionLabel(e.requirement && e.requirement.dimension),
      confidence: e.requirement && e.requirement.confidence || '', source: dcSourceOf({ source: e.requirement && e.requirement.source })
    }));
    return { ok: true, roomId: room.id, roomName: room.name || '', docs, items, errors: scan.errors, ocrCount: scan.ocrCount, nativeCadSkipped: scan.nativeCadSkipped, manual: dcManualInfo() };
  }
  function dcOpenDocument(i) {
    const m = __measurements[i]; const cmp = m && latestDocComparison(m);
    const id = cmp && cmp.source && cmp.source.documentId;
    const room = m && measurementRoom(m);
    const doc = id && room ? roomDocs(room).find(d => d.id === id) : null;
    if (!doc) { toast('Документ-источник не найден в помещении'); return false; }
    openDoc(doc); return true;
  }
  function dcExportCsv() {
    if (!__measurements.length) { toast('Список измерений пуст'); return false; }
    const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
    const head = ['№', 'Название', 'Тип объекта', 'Помещение', 'Измерение', 'Сравниваемое значение', 'Факт', 'Требование документа', 'Отклонение', 'Статус', 'Как сопоставлено', 'Документ', 'Место в документе', 'Фрагмент', 'Уверенность (0-100)'];
    const how = { auto: 'автоматически', user: 'подтверждено вручную', manual: 'введено вручную', proposal: 'предложение, не подтверждено' };
    const lines = [head.map(q).join(';')];
    __measurements.forEach((m, i) => {
      const r = dcRow(m, i);
      lines.push([i + 1, r.label, r.objectType, r.roomName, r.valueText, r.fieldLabel, r.actualText, r.expectedText, r.deltaText, r.statusLabel, how[r.how] || '', r.source && r.source.documentName, r.source && r.source.location, r.source && r.source.excerpt, r.score || ''].map(q).join(';'));
    });
    downloadBlob('\ufeff' + lines.join('\r\n'), 'doc-check-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv', 'text/csv;charset=utf-8');
    toast('Отчёт сверки сохранён (' + __measurements.length + ' строк)');
    return true;
  }
  // ── Свои размеры: номинал и допуск вводит сам пользователь (чертёж, договор, паспорт изделия) ──
  const DC_MANUAL_KEY = 'bim.docCheck.manual';
  const DC_MANUAL_DIMS = [['width', 'Ширина'], ['height', 'Высота'], ['length', 'Длина'], ['thickness', 'Толщина'], ['diameter', 'Диаметр'], ['gap', 'Зазор'], ['angle', 'Угол'], ['unspecified', 'Размер']];
  let __manualCache = null;
  function dcManualLoad() {
    if (__manualCache) return __manualCache;
    let list = [];
    try {
      const ps = window.BimProjectState, snap = ps && ps.snapshot && ps.snapshot(), md = snap && snap.metadata;
      if (md && md.docCheck && Array.isArray(md.docCheck.manual)) list = md.docCheck.manual;
    } catch (_) {}
    if (!list.length) { try { const raw = localStorage.getItem(DC_MANUAL_KEY); const arr = raw ? JSON.parse(raw) : []; if (Array.isArray(arr)) list = arr; } catch (_) {} }
    __manualCache = list.filter(r => r && r.id && Array.isArray(r.sizes)).slice(0, 200);
    return __manualCache;
  }
  function dcManualSave(list) {
    __manualCache = list.slice(0, 200);
    try { localStorage.setItem(DC_MANUAL_KEY, JSON.stringify(__manualCache)); } catch (_) {}
    try {
      const ps = window.BimProjectState;
      if (ps && ps.update && ps.snapshot) {
        const md = Object.assign({}, ps.snapshot().metadata || {});
        md.docCheck = Object.assign({}, md.docCheck || {}, { manual: __manualCache });
        ps.update({ metadata: md }).catch(e => { try { console.warn('[docCheck] manual sizes save failed', e); } catch (_) {} });
      }
    } catch (_) {}
  }
  function dcManualRequirement(label, size, recId, idx) {
    const C = window.MeasurementDocCompare; if (!C || !size) return null;
    const unit = C.unitInfo(size.unit), value = C.parseNumber(String(size.value == null ? '' : size.value));
    const tolGiven = !(size.tolerance === '' || size.tolerance == null), tol = tolGiven ? C.parseNumber(String(size.tolerance)) : null;
    // допуск можно не указывать, но если он написан, то обязан быть числом не меньше нуля: «abc» не превращается в «допуск не задан»
    if (!unit || value == null || !(value > 0 || size.dimension === 'angle') || (tolGiven && (tol == null || !(tol >= 0)))) return null;
    const dim = DC_MANUAL_DIMS.some(d => d[0] === size.dimension) ? size.dimension : 'unspecified';
    const tolText = tol != null ? ' ±' + tol + ' ' + unit.symbol : '';
    return {
      id: 'manual_' + recId + '_' + idx, kind: unit.kind, dimension: dim, value, unit: unit.symbol, baseValue: value * unit.factor,
      tolerance: tol == null ? null : tol * unit.factor, toleranceValue: tol, toleranceUnit: tol == null ? null : unit.symbol,
      toleranceMode: tol == null ? null : 'symmetric', confidence: 'high', needsConfirmation: false, assumptions: [], unitKindMismatch: false,
      source: { documentId: 'manual', documentName: 'Введено вручную', sheet: null, row: null, line: null, page: null, ocr: false, truncated: false,
        excerpt: (String(label || '').trim() + ': ' + comparisonDimensionLabel(dim) + ' ' + value + ' ' + unit.symbol + tolText).slice(0, 300) }
    };
  }
  function dcManualEntries() {
    const out = [];
    dcManualLoad().forEach(rec => {
      (rec.sizes || []).forEach((sz, idx) => {
        const req = dcManualRequirement(rec.label, sz, rec.id, idx);
        if (req) out.push({ id: 'manual:' + rec.id + ':' + idx, requirement: req, doc: { id: 'manual', name: 'Введено вручную', type: 'manual' } });
      });
    });
    return out;
  }
  function dcManualInfo() {
    const dimName = Object.fromEntries(DC_MANUAL_DIMS);
    return dcManualLoad().map(rec => ({
      id: rec.id, label: rec.label || 'Без названия',
      sizes: (rec.sizes || []).map(sz => (dimName[sz.dimension] || 'Размер') + ' ' + sz.value + ' ' + sz.unit + (sz.tolerance !== '' && sz.tolerance != null ? ' ±' + sz.tolerance : '')),
      valid: (rec.sizes || []).every((sz, idx) => !!dcManualRequirement(rec.label, sz, rec.id, idx))
    }));
  }
  async function dcManualAdd(spec) {
    spec = spec || {};
    const label = String(spec.label || '').trim().slice(0, 120);
    const sizes = (Array.isArray(spec.sizes) ? spec.sizes : []).slice(0, 6).map(sz => ({
      dimension: String(sz.dimension || 'unspecified'), value: String(sz.value == null ? '' : sz.value).trim(), unit: String(sz.unit || 'мм'),
      tolerance: sz.tolerance === '' || sz.tolerance == null ? '' : String(sz.tolerance).trim()
    }));
    const id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    if (!label) return { ok: false, reason: 'no-label' };
    if (!sizes.length || !sizes.every((sz, idx) => dcManualRequirement(label, sz, id, idx))) return { ok: false, reason: 'bad-size' };
    dcManualSave(dcManualLoad().concat([{ id, label, sizes, createdAt: new Date().toISOString() }]));
    const counts = __measurements.length ? await computeAllComparisons() : null;
    return { ok: true, id, counts };
  }
  async function dcManualRemove(id) {
    const list = dcManualLoad(), next = list.filter(r => r.id !== id);
    if (next.length === list.length) return { ok: false };
    dcManualSave(next);
    const counts = __measurements.length ? await computeAllComparisons() : null;
    return { ok: true, counts };
  }
  // Быстрая проверка одного измерения по размеру, который пользователь ввёл сам (запоминать в списке не обязательно)
  async function dcManualCompare(i, spec) {
    const m = __measurements[i], C = window.MeasurementDocCompare;
    spec = spec || {};
    if (!m || !C) return { ok: false, reason: 'no-measurement' };
    const label = String(spec.label || m.label || 'Свой размер').trim();
    const req = dcManualRequirement(label, { dimension: spec.dimension, value: spec.value, unit: spec.unit, tolerance: spec.tolerance }, 'q' + Date.now().toString(36), 0);
    if (!req) return { ok: false, reason: 'bad-size' };
    const fields = C.measurementFields(m);
    const field = fields.find(f => f.key === spec.fieldKey) || C.suggestField(req, fields);
    if (!field) return { ok: false, reason: 'no-field' };
    if (field.kind !== req.kind) return { ok: false, reason: 'kind-mismatch' };
    const context = m.measurementContext || {};
    const units = spec.cloudUnits || context.sourceUnits || dcDefaultUnits() || '';
    const ranking = C.rankRequirementMatches({
      measurement: m, context, sourceUnits: units, fields: [field], allFields: true,
      candidates: [{ id: 'manual:quick', requirement: req, doc: { id: 'manual', name: 'Введено вручную', type: 'manual' } }]
    });
    const ranked = ranking.matches[0];
    if (!ranked) return { ok: false, reason: 'no-result' };
    if (!ranked.unit) return { ok: false, reason: 'units' };
    const record = buildAutomaticComparisonRecord(m, measurementRoom(m), ranked, ranking);
    if (!record) return { ok: false, reason: 'no-result' };
    record.automation.mode = 'user-entered';
    record.confirmations.autoConfirmed = false;
    record.confirmations.method = 'user-entered-size';
    record.confirmations.acceptedAt = new Date().toISOString();
    appendMeasurementComparison(m, record);
    if (spec.remember) {
      const list = dcManualLoad(), id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      dcManualSave(list.concat([{ id, label, sizes: [{ dimension: req.dimension, value: String(spec.value), unit: String(spec.unit || 'мм'), tolerance: spec.tolerance === '' || spec.tolerance == null ? '' : String(spec.tolerance) }], createdAt: new Date().toISOString() }]));
    }
    renderMeasList(); persistMeasurements();
    return { ok: true, status: record.status, actualText: dcFmt(record.actual && record.actual.baseValue, record.expected.kind, record.expected.unit), deltaText: dcSigned(record.delta, record.expected.kind, record.expected.unit) };
  }
  // Что у измерения можно сравнивать с размером: название, значение (в единицах облака, если они известны), подходит ли поле без ручного выбора
  function dcFields(i) {
    const m = __measurements[i], C = window.MeasurementDocCompare;
    if (!m || !C) return [];
    const ctx = m.measurementContext || {}, units = ctx.sourceUnits || dcDefaultUnits() || '', ui = units ? C.unitInfo(units) : null;
    return C.measurementFields(m).map(f => {
      const prof = C.measurementFieldDimensions(f, m);
      let text = '';
      if (f.kind === 'angle') text = f.value.toFixed(2) + ' °';
      else if (f.kind === 'slope') text = f.value.toFixed(2) + ' %';
      else if (f.kind === 'linear') text = ui && ui.kind === 'linear' ? (dcFmt(f.value * ui.factor, 'linear', ui.symbol) || '') : f.value.toFixed(4) + ' ед. облака';
      else if (f.kind === 'area') text = f.value.toFixed(3);
      return { key: f.key, label: f.label, kind: f.kind, text, auto: prof.auto !== false, dimension: prof.primary || 'unspecified' };
    });
  }
  window.__lxDocCheck = {
    meta: dcMeta, rows: () => __measurements.map(dcRow), row: i => (__measurements[i] ? dcRow(__measurements[i], i) : null),
    add: (res, extra) => (res && !res.error ? storeMeasurement(res, extra || {}) : -1),
    update: (i, res) => { const m = __measurements[i]; if (!m || !res || res.error) return false; const keep = { measurementContext: m.measurementContext, label: m.label, docComparisons: m.docComparisons, docComparison: m.docComparison, autoComparisonProposal: m.autoComparisonProposal }; Object.keys(m).forEach(k => delete m[k]); Object.assign(m, JSON.parse(JSON.stringify(res)), keep); renderMeasList(); persistMeasurements(); autoCompareMeasurementInBackground(i); return true; },
    candidates: dcCandidates, accept: dcAccept, setDefaultUnits: dcSetDefaultUnits, setContext: dcSetContext, remove: dcRemove, requirements: dcRequirements,
    run: i => autoCompareMeasurementInBackground(i), runAll: computeAllComparisons, details: i => compareSavedMeasurement(i),
    openDocument: dcOpenDocument, exportCsv: dcExportCsv,
    fields: dcFields,
    manual: { list: dcManualInfo, add: dcManualAdd, remove: dcManualRemove, compare: dcManualCompare, dims: DC_MANUAL_DIMS }
  };
  function compareSavedMeasurement(index) {
    const measurement = __measurements[index];
    const C = window.MeasurementDocCompare;
    if (!measurement || !C) { toast('Сверка измерения недоступна'); return; }
    const context = measurement.measurementContext || {};
    const knownRoom = context.roomId && Array.isArray(DB && DB.rooms) ? DB.rooms.find(r => r.id === context.roomId) : null;
    const room = knownRoom || current;
    if (!room) { toast('Не удалось определить помещение измерения — откройте помещение и повторите'); return; }
    const needsRoomConfirmation = !knownRoom;
    let docs = roomDocs(room).filter(d => d && d.file);
    if (context.elementId) docs.sort((a, b) => Number(b.element_id === context.elementId) - Number(a.element_id === context.elementId));

    const modal = modalPanel('Сверить измерение с документацией');
    const card = modal.overlay.querySelector('.modal-card');
    if (card) { card.classList.add('measurement-compare-card'); card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-label', 'Сверка измерения с документацией'); }
    modal.overlay.addEventListener('click', event => { if (event.target === modal.overlay) modal.close(); });
    modal.body.classList.add('measurement-compare');
    const intro = mk('div', 'cmp-intro');
    const fields = C.measurementFields(measurement);
    const measuredText = fields.length
      ? fields.map(f => f.label + ': ' + Number(f.value).toPrecision(6) + (f.kind === 'area' ? ' ед.²' : f.kind === 'angle' ? '°' : f.kind === 'slope' ? '%' : ' ед.')).join(' · ')
      : 'В этом сохранённом измерении нет числового размера, который можно сопоставить.';
    intro.textContent = measuredText;
    modal.body.appendChild(intro);

    const provenance = mk('div', 'cmp-provenance');
    const scopeName = context.elementName || (selEl && selEl.name) || 'объект без привязки к элементу';
    const cloudMeta = context.sourceUnits ? 'Единицы в метаданных облака: ' + String(context.sourceUnits) + '.' : 'Метаданные единиц облака отсутствуют.';
    const crsMeta = context.hasCrs ? ' CRS указан, но геопривязка в этой проверке не оценивается.' : ' CRS не указан; геопривязка этой проверкой не подтверждается.';
    provenance.textContent = 'Помещение: ' + (room.name || 'без названия') + ' · объект: ' + scopeName + (context.cloudName ? ' · источник: ' + context.cloudName : '') + '. ' + cloudMeta + crsMeta;
    modal.body.appendChild(provenance);

    const autoSummary = mk('div', 'cmp-auto-summary');
    autoSummary.setAttribute('role', 'status');
    autoSummary.setAttribute('aria-live', 'polite');
    autoSummary.textContent = 'Умный подбор запустится после чтения документов.';
    modal.body.appendChild(autoSummary);

    const scopeLabel = document.createElement('label'); scopeLabel.className = 'cmp-check';
    const scopeCheck = document.createElement('input'); scopeCheck.type = 'checkbox'; scopeCheck.checked = !needsRoomConfirmation; scopeCheck.disabled = !needsRoomConfirmation;
    const scopeText = document.createElement('span');
    scopeText.textContent = needsRoomConfirmation
      ? 'Подтверждаю: документы текущего помещения относятся к этому старому измерению.'
      : 'Для этого измерения выбраны документы его сохранённого помещения.';
    scopeLabel.append(scopeCheck, scopeText); modal.body.appendChild(scopeLabel);

    const scanStatus = mk('div', 'cmp-scan-status'); scanStatus.setAttribute('role', 'status'); scanStatus.setAttribute('aria-live', 'polite');
    scanStatus.textContent = 'Подготовка списка документов…'; modal.body.appendChild(scanStatus);

    const candidateLabel = document.createElement('label'); candidateLabel.className = 'formrow';
    const candidateCaption = document.createElement('span'); candidateCaption.textContent = 'Найденное требование'; candidateLabel.appendChild(candidateCaption);
    const candidateSelect = document.createElement('select'); candidateSelect.className = 'cmp-select'; candidateSelect.setAttribute('aria-label', 'Выберите требование из документа'); candidateLabel.appendChild(candidateSelect); modal.body.appendChild(candidateLabel);
    const candidateInfo = mk('div', 'cmp-candidate-info'); modal.body.appendChild(candidateInfo);
    const alternatives = mk('div', 'cmp-alternatives'); modal.body.appendChild(alternatives);
    const sourceExcerpt = document.createElement('pre'); sourceExcerpt.className = 'cmp-source-excerpt'; sourceExcerpt.textContent = 'Выберите требование, найденное в документах.'; modal.body.appendChild(sourceExcerpt);
    const sourceActions = mk('div', 'cmp-source-actions'); modal.body.appendChild(sourceActions);

    const pairRow = mk('label', 'formrow'); const pairCaption = document.createElement('span'); pairCaption.textContent = 'Размер пары'; pairRow.appendChild(pairCaption);
    const pairSelect = document.createElement('select'); pairSelect.className = 'cmp-select'; pairRow.appendChild(pairSelect); pairRow.style.display = 'none'; modal.body.appendChild(pairRow);

    const actualFieldLabel = document.createElement('label'); actualFieldLabel.className = 'formrow';
    const actualFieldCaption = document.createElement('span'); actualFieldCaption.textContent = 'Какое значение измерения сравнить'; actualFieldLabel.appendChild(actualFieldCaption);
    const actualFieldSelect = document.createElement('select'); actualFieldSelect.className = 'cmp-select'; actualFieldLabel.appendChild(actualFieldSelect); modal.body.appendChild(actualFieldLabel);

    const unitLabel = document.createElement('label'); unitLabel.className = 'formrow';
    const unitCaption = document.createElement('span'); unitCaption.textContent = 'Единицы фактического измерения'; unitLabel.appendChild(unitCaption);
    const unitSelect = document.createElement('select'); unitSelect.className = 'cmp-select'; unitLabel.appendChild(unitSelect); modal.body.appendChild(unitLabel);
    const unitHint = mk('div', 'cmp-small-hint'); modal.body.appendChild(unitHint);

    const unitConfirmLabel = document.createElement('label'); unitConfirmLabel.className = 'cmp-check';
    const unitConfirm = document.createElement('input'); unitConfirm.type = 'checkbox';
    const unitConfirmText = document.createElement('span'); unitConfirmText.textContent = 'Подтверждаю единицы/масштаб фактического измерения.'; unitConfirmLabel.append(unitConfirm, unitConfirmText); modal.body.appendChild(unitConfirmLabel);
    const requirementConfirmLabel = document.createElement('label'); requirementConfirmLabel.className = 'cmp-check';
    const requirementConfirm = document.createElement('input'); requirementConfirm.type = 'checkbox';
    const requirementConfirmText = document.createElement('span'); requirementConfirmText.textContent = 'Подтверждаю, что этот пункт документа относится к измеряемой стене/элементу.'; requirementConfirmLabel.append(requirementConfirm, requirementConfirmText); modal.body.appendChild(requirementConfirmLabel);

    const manualToggle = mk('button', 'btn sm', '+ Ввести требование вручную');
    manualToggle.type = 'button'; modal.body.appendChild(manualToggle);
    const manualPanel = mk('div', 'cmp-manual'); manualPanel.style.display = 'none'; modal.body.appendChild(manualPanel);
    const manualLabelInput = document.createElement('input'); manualLabelInput.type = 'text'; manualLabelInput.maxLength = 120; manualLabelInput.placeholder = 'Например: ширина стены по листу АР-02';
    const manualDimension = document.createElement('select'); manualDimension.className = 'cmp-select';
    [['width','Ширина'],['height','Высота'],['length','Длина'],['thickness','Толщина'],['diameter','Диаметр'],['gap','Зазор'],['area','Площадь'],['angle','Угол'],['slope','Уклон'],['unspecified','Размер без обозначения оси']].forEach(([value,label]) => { const o=document.createElement('option'); o.value=value; o.textContent=label; manualDimension.appendChild(o); });
    const manualValue = document.createElement('input'); manualValue.type = 'number'; manualValue.step = 'any'; manualValue.placeholder = 'Номинал';
    const manualUnit = document.createElement('select'); manualUnit.className = 'cmp-select';
    const manualTolerance = document.createElement('input'); manualTolerance.type = 'number'; manualTolerance.step = 'any'; manualTolerance.min = '0'; manualTolerance.placeholder = 'Допуск ± (необязательно)';
    const manualError = mk('div', 'cmp-small-hint');
    function addManualRow(labelText, control) {
      const row = document.createElement('label'); row.className = 'formrow'; const title = document.createElement('span'); title.textContent = labelText; row.append(title, control); manualPanel.appendChild(row);
    }
    addManualRow('Описание требования', manualLabelInput);
    addManualRow('Размер', manualDimension);
    addManualRow('Номинал', manualValue);
    addManualRow('Единица', manualUnit);
    addManualRow('Допуск (симметричный, ±)', manualTolerance);
    const manualAdd = mk('button', 'btn sm primary', 'Добавить требование'); manualAdd.type = 'button'; manualPanel.append(manualError, manualAdd);
    function updateManualUnits() {
      const dimension = manualDimension.value;
      const kind = dimension === 'area' ? 'area' : dimension === 'angle' ? 'angle' : dimension === 'slope' ? 'slope' : 'linear';
      manualUnit.innerHTML = '';
      comparisonUnitOptions(kind).forEach(u => { const o=document.createElement('option'); o.value=u.value; o.textContent=u.label; manualUnit.appendChild(o); });
    }
    updateManualUnits();
    manualDimension.addEventListener('change', updateManualUnits);

    const resultBox = mk('div', 'cmp-evaluation'); resultBox.setAttribute('role', 'status'); resultBox.setAttribute('aria-live', 'polite');
    resultBox.textContent = 'Подтвердите источник и единицы, чтобы получить результат.'; modal.body.appendChild(resultBox);
    const actions = mk('div', 'cmp-actions');
    const saveCompare = mk('button', 'btn sm primary', 'Сохранить сверку'); saveCompare.type = 'button'; saveCompare.disabled = true;
    const closeButton = mk('button', 'btn sm', 'Закрыть'); closeButton.type = 'button'; closeButton.onclick = () => modal.close();
    actions.append(saveCompare, closeButton); modal.body.appendChild(actions);

    const entries = [];
    let scanInProgress = false;
    let currentResult = null;
    let currentField = null;
    let currentEntry = null;
    let currentPairIndex = 0;
    let latestRanking = null;
    function addRequirements(doc, requirements, origin) {
      for (const req of requirements || []) {
        if (req.source) {
          req.source.documentId = req.source.documentId || doc && doc.id || null;
          req.source.documentName = req.source.documentName || (doc ? comparisonDocName(doc) : (origin === 'manual' ? 'Ручной ввод' : 'Документ'));
        }
        entries.push({ id: String(req.id || 'req_' + Date.now() + '_' + entries.length), requirement: req, doc: doc || null, manual: origin === 'manual' });
      }
      if (!scanInProgress) updateCandidateOptions();
    }
    function addOption(select, value, label) {
      const option = document.createElement('option'); option.value = String(value); option.textContent = String(label); select.appendChild(option);
    }
    function selectedEntry() { return entries.find(entry => entry.id === candidateSelect.value) || null; }
    function addCandidateEntry(entry) {
      entries.push(entry);
      updateCandidateOptions(entry.id);
    }
    function setScanBusy(busy) {
      candidateSelect.disabled = busy;
      pairSelect.disabled = busy;
      actualFieldSelect.disabled = busy;
      unitSelect.disabled = busy;
      unitConfirm.disabled = busy;
      requirementConfirm.disabled = busy;
      manualToggle.disabled = busy;
      manualAdd.disabled = busy;
    }
    function updateCandidateOptions(selectId) {
      const before = selectId || candidateSelect.value;
      candidateSelect.innerHTML = '';
      addOption(candidateSelect, '', 'Выберите требование…');
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i], req = entry.requirement, docName = req.source && req.source.documentName || comparisonDocName(entry.doc);
        const groupKey = String(docName || 'Документ').slice(0, 80);
        let group = Array.prototype.slice.call(candidateSelect.querySelectorAll('optgroup')).find(g => g.label === groupKey);
        if (!group) { group = document.createElement('optgroup'); group.label = groupKey; candidateSelect.appendChild(group); }
        const option = document.createElement('option'); option.value = entry.id; option.textContent = comparisonRequirementLabel(entry); group.appendChild(option);
      }
      if (before && entries.some(e => e.id === before)) candidateSelect.value = before;
      else if (entries.length) candidateSelect.value = entries[0].id;
      renderSelectedCandidate();
    }
    function sourceLocation(req) {
      const s = req && req.source || {};
      const loc = [];
      if (s.sheet) loc.push('лист ' + s.sheet);
      if (s.row) loc.push('строка ' + s.row);
      if (s.page) loc.push('страница ' + s.page);
      else if (s.line) loc.push('строка текста ' + s.line + ' (номер страницы не извлечён)');
      return (s.documentName || 'Документ') + (loc.length ? ' · ' + loc.join(', ') : '');
    }
    function formatCandidateTolerance(req) {
      if (req.toleranceMode === 'symmetric' && Number.isFinite(req.toleranceValue)) return 'Допуск из источника: ± ' + req.toleranceValue + ' ' + (req.toleranceUnit || req.unit) + '.';
      if ((req.toleranceMode === 'max' || req.toleranceMode === 'min') && Number.isFinite(req.bound)) {
        const bound = C.formatBaseValue(req.bound, req.kind, req.unit);
        return (req.toleranceMode === 'max' ? 'Максимум: ' : 'Минимум: ') + (bound || req.value + ' ' + req.unit) + '.';
      }
      return 'Допуск в источнике не найден.';
    }
    function renderSelectedCandidate() {
      currentEntry = selectedEntry();
      const req = currentEntry && currentEntry.requirement;
      candidateInfo.innerHTML = ''; sourceExcerpt.textContent = 'Выберите требование, найденное в документах.'; sourceActions.innerHTML = '';
      pairSelect.innerHTML = ''; pairRow.style.display = req && req.kind === 'pair' ? '' : 'none';
      if (!req) { renderComparisonControls(); evaluate(); return; }
      if (req.kind === 'pair') {
        const values = Array.isArray(req.values) ? req.values : [];
        values.forEach((v, i) => addOption(pairSelect, i, comparisonDimensionLabel(v.dimension) + ': ' + v.value + ' ' + v.unit));
        currentPairIndex = Number(pairSelect.value || 0);
      } else currentPairIndex = 0;
      const details = mk('div', 'cmp-candidate-meta');
      const location = document.createElement('div'); location.textContent = sourceLocation(req); details.appendChild(location);
      const tolerance = mk('div', '', formatCandidateTolerance(req)); details.appendChild(tolerance);
      const confidenceLabel = req.confidence === 'high' ? 'Высокая — размер и единица явно указаны' : req.confidence === 'medium' ? 'Средняя — единица может быть взята из заголовка' : req.confidence === 'low' ? 'Низкая — оси пары не обозначены' : 'Введено вручную';
      details.appendChild(mk('div', 'cmp-small-hint', 'Извлечение: ' + confidenceLabel));
      if (Array.isArray(req.assumptions) && req.assumptions.length) {
        const notes = mk('div', 'cmp-small-hint'); notes.textContent = req.assumptions.join(' '); details.appendChild(notes);
      }
      candidateInfo.appendChild(details);
      sourceExcerpt.textContent = req.source && req.source.excerpt || 'Исходный фрагмент не сохранён.';
      if (currentEntry.doc) {
        const open = mk('button', 'btn xs', 'Открыть источник'); open.type = 'button'; open.onclick = () => openDoc(currentEntry.doc); sourceActions.appendChild(open);
      }
      renderComparisonControls();
      evaluate();
    }
    function updateFieldOptions(preferredKey) {
      const req = currentEntry && currentEntry.requirement;
      const kind = req && req.kind === 'pair' ? 'linear' : req && req.kind;
      const compatible = fields.filter(f => f.kind === kind);
      actualFieldSelect.innerHTML = '';
      compatible.forEach(f => addOption(actualFieldSelect, f.key, f.label));
      if (!compatible.length) {
        actualFieldSelect.disabled = true;
        addOption(actualFieldSelect, '', 'Нет совместимого значения в измерении');
        currentField = null;
        return;
      }
      actualFieldSelect.disabled = false;
      let suggested = null;
      if (req && req.kind === 'pair') {
        const values = req.values || [];
        const part = values[currentPairIndex] || values[0];
        const suggestReq = { kind: 'linear', dimension: part && part.dimension };
        suggested = C.suggestField(suggestReq, compatible);
        if ((!suggested || (part && (part.dimension === 'first' || part.dimension === 'second'))) && compatible.length > 1) suggested = compatible[currentPairIndex] || compatible[0];
      } else if (req) suggested = C.suggestField(req, compatible);
      const selectedKey = compatible.some(f => f.key === preferredKey) ? preferredKey : (suggested && suggested.key || compatible[0].key);
      actualFieldSelect.value = selectedKey;
      currentField = compatible.find(f => f.key === selectedKey) || compatible[0];
    }
    function updateUnits(preferred) {
      const req = currentEntry && currentEntry.requirement;
      const kind = req && req.kind === 'pair' ? 'linear' : currentField && currentField.kind;
      const options = comparisonUnitOptions(kind);
      unitSelect.innerHTML = '';
      addOption(unitSelect, '', 'Выберите единицу…');
      options.forEach(u => addOption(unitSelect, u.value, u.label));
      const detected = C.unitInfo(context.sourceUnits);
      let chosen = preferred && options.some(o => o.value === preferred) ? preferred : '';
      if (!chosen && detected) {
        const match = options.find(o => C.unitInfo(o.value) && C.unitInfo(o.value).kind === detected.kind && C.unitInfo(o.value).factor === detected.factor);
        if (match) chosen = match.value;
        else if (kind === 'area' && detected.kind === 'linear' && detected.factor === 1) chosen = 'м²';
      }
      if (!chosen && kind === 'angle') chosen = '°';
      if (!chosen && kind === 'slope') chosen = '%';
      unitSelect.value = chosen;
      const needsScaleConfirm = kind === 'linear' || kind === 'area';
      unitConfirm.disabled = !needsScaleConfirm;
      unitConfirm.checked = !needsScaleConfirm;
      unitConfirmText.textContent = needsScaleConfirm
        ? (detected ? 'Подтверждаю выбранную единицу и масштаб облака: ' + detected.symbol + ' в метаданных — подсказка, не доказательство масштаба.' : 'Подтверждаю единицу/масштаб фактического измерения: исходные метаданные этого не подтверждают.')
        : 'Для угла/уклона CRS и масштаб не требуются; единицы определяются самим измерением.';
      unitHint.textContent = needsScaleConfirm
        ? 'Без подтверждённой единицы результат останется «нужна проверка» и не будет помечен как прошедший/не прошедший.'
        : 'Угловое значение не зависит от масштаба облака.';
    }
    function renderComparisonControls() {
      const req = currentEntry && currentEntry.requirement;
      const oldField = actualFieldSelect.value;
      updateFieldOptions(oldField);
      updateUnits(unitSelect.value);
      if (!req) {
        actualFieldSelect.disabled = true; unitSelect.disabled = true;
        requirementConfirm.disabled = true; requirementConfirm.checked = false;
        requirementConfirmText.textContent = 'Сначала выберите требование.';
        return;
      }
      unitSelect.disabled = !currentField;
      requirementConfirm.disabled = false;
      requirementConfirm.checked = false;
      const dim = req.kind === 'pair' ? (req.values && req.values[currentPairIndex] || {}).dimension : req.dimension;
      requirementConfirmText.textContent = 'Подтверждаю, что «' + comparisonDimensionLabel(dim) + '» в этом источнике относится к измеряемой стене/элементу.';
    }
    function statusMessageText(status) {
      return ({
        'within-tolerance': 'Соответствует требованию',
        'outside-tolerance': 'За пределами допуска',
        'tolerance-not-specified': 'Допуск не задан',
        'units-unconfirmed': 'Нужно подтвердить единицы',
        'unit-mismatch': 'Несовместимые типы данных',
        'needs-review': 'Требуется проверка'
      })[status] || 'Не выполнено';
    }
    function evaluate() {
      const entry = selectedEntry();
      currentEntry = entry;
      const req = entry && entry.requirement;
      const field = fields.find(f => f.key === actualFieldSelect.value);
      currentField = field || null;
      saveCompare.disabled = true;
      currentResult = null;
      resultBox.className = 'cmp-evaluation';
      resultBox.replaceChildren();
      if (!req) { resultBox.textContent = 'Сначала выберите найденное требование.'; return; }
      if (!scopeCheck.checked) {
        resultBox.classList.add('cmp-eval-review'); resultBox.textContent = 'Подтвердите помещение, из которого нужно брать документацию.'; return;
      }
      if (!field) {
        resultBox.classList.add('cmp-eval-review');
        resultBox.textContent = 'Сохранённое измерение не содержит значения типа «' + req.kind + '». Сделайте подходящее измерение (например, ширину/высоту плоскости, длину, площадь или угол).';
        return;
      }
      const selectedUnit = unitSelect.value;
      const unitNeedsConfirmation = field.kind === 'linear' || field.kind === 'area';
      const unitConfirmed = !unitNeedsConfirmation || unitConfirm.checked;
      const result = C.compareMeasurement({
        measurement: measurement, requirement: req, fields: fields,
        fieldKey: field.key, unit: selectedUnit,
        pairIndex: Number(pairSelect.value || 0),
        unitConfirmed: unitConfirmed,
        requirementConfirmed: requirementConfirm.checked
      });
      currentResult = result;
      const validSave = ['within-tolerance', 'outside-tolerance', 'tolerance-not-specified'].includes(result.status) && Number.isFinite(result.actual);
      resultBox.classList.add(validSave ? (result.status === 'within-tolerance' ? 'cmp-eval-ok' : result.status === 'outside-tolerance' ? 'cmp-eval-out' : 'cmp-eval-unknown') : 'cmp-eval-review');
      const title = mk('strong', '', statusMessageText(result.status)); resultBox.appendChild(title);
      const description = mk('div', 'cmp-eval-message', result.message || '');
      if (Number.isFinite(result.actual) && Number.isFinite(result.expected)) {
        const unitInfo = C.unitInfo(selectedUnit);
        const actualText = C.formatBaseValue(result.actual, field.kind, selectedUnit) || result.actual;
        const expectedUnit = result.expectedUnit || req.unit;
        const expectedText = C.formatBaseValue(result.expected, field.kind, expectedUnit) || result.expected + ' ' + expectedUnit;
        const deltaText = C.formatBaseValue(result.delta, field.kind, expectedUnit) || result.delta;
        const values = mk('div', 'cmp-eval-values');
        values.textContent = 'Факт: ' + actualText + ' · По требованию: ' + expectedText + ' · Δ: ' + deltaText + (result.percentDelta == null ? '' : ' (' + result.percentDelta.toFixed(2) + '%)');
        resultBox.append(description, values);
        if (unitInfo && req.toleranceValue != null) resultBox.appendChild(mk('div', 'cmp-small-hint', 'Учтён явный допуск: ± ' + req.toleranceValue + ' ' + (req.toleranceUnit || req.unit) + '.'));
      } else resultBox.appendChild(description);
      if (validSave) saveCompare.disabled = false;
    }

    function applyRankedMatch(match, autoConfirm) {
      if (!match || !match.entry || !entries.includes(match.entry)) return;
      candidateSelect.value = match.entry.id;
      renderSelectedCandidate();
      if (match.requirement && match.requirement.kind === 'pair') {
        pairSelect.value = String(match.pairIndex == null ? 0 : match.pairIndex);
        currentPairIndex = Number(pairSelect.value || 0);
        renderComparisonControls();
      }
      if (match.field && Array.prototype.some.call(actualFieldSelect.options, option => option.value === match.field.key)) {
        actualFieldSelect.value = match.field.key;
        currentField = fields.find(field => field.key === match.field.key) || null;
      }
      updateUnits(match.unit || '');
      if (match.unit && Array.prototype.some.call(unitSelect.options, option => option.value === match.unit)) unitSelect.value = match.unit;
      const canConfirm = !!(autoConfirm && latestRanking && latestRanking.best === match && latestRanking.decision.canAutoConfirm);
      if (!unitConfirm.disabled) unitConfirm.checked = canConfirm;
      requirementConfirm.checked = canConfirm;
      evaluate();
    }
    function renderAutomaticRanking() {
      latestRanking = rankMeasurementAgainstEntries(measurement, entries);
      alternatives.replaceChildren();
      autoSummary.replaceChildren();
      if (!latestRanking.best) {
        autoSummary.className = 'cmp-auto-summary cmp-auto-review';
        autoSummary.appendChild(mk('strong', '', 'Требование не найдено автоматически'));
        autoSummary.appendChild(mk('div', 'cmp-small-hint', 'Попробуйте подписать измерение (например, «ширина стены А-1»), привязать его к элементу или ввести требование вручную.'));
        return;
      }
      const best = latestRanking.best;
      const state = latestRanking.decision.canAutoConfirm ? 'confirmed' : latestRanking.decision.state === 'ambiguous' ? 'ambiguous' : 'review';
      autoSummary.className = 'cmp-auto-summary cmp-auto-' + state;
      const title = latestRanking.decision.canAutoConfirm
        ? 'Найдено автоматически · ' + best.score + '/100'
        : latestRanking.decision.state === 'ambiguous'
          ? 'Найдено несколько вариантов · нужна проверка'
          : 'Предложено совпадение · ' + best.score + '/100';
      autoSummary.appendChild(mk('strong', '', title));
      autoSummary.appendChild(mk('div', 'cmp-auto-best', comparisonRequirementLabel(best.entry) + ' → ' + best.field.label));
      if (best.reasons.length) autoSummary.appendChild(mk('div', 'cmp-small-hint', best.reasons.slice(0, 3).join(' ')));
      if (best.warnings.length) autoSummary.appendChild(mk('div', 'cmp-auto-warning', best.warnings.slice(0, 3).join(' ')));

      const seen = new Set();
      const top = [];
      for (const match of latestRanking.matches) {
        const key = [match.entry.id, match.field.key, match.pairIndex == null ? '' : match.pairIndex].join('|');
        if (seen.has(key)) continue;
        seen.add(key); top.push(match);
        if (top.length >= 3) break;
      }
      if (top.length > 1) {
        alternatives.appendChild(mk('div', 'cmp-alternatives-title', 'Лучшие варианты'));
        top.forEach((match, rank) => {
          const button = mk('button', 'cmp-alternative' + (match === best ? ' selected' : ''));
          button.type = 'button';
          button.textContent = (rank + 1) + '. ' + match.score + '/100 · ' + comparisonRequirementLabel(match.entry) + ' → ' + match.field.label;
          button.onclick = () => applyRankedMatch(match, false);
          alternatives.appendChild(button);
        });
      }
      applyRankedMatch(best, latestRanking.decision.canAutoConfirm);
    }

    function updateManualOptions() {
      const kind = manualDimension.value === 'area' ? 'area' : manualDimension.value === 'angle' ? 'angle' : manualDimension.value === 'slope' ? 'slope' : 'linear';
      const options = comparisonUnitOptions(kind);
      manualUnit.innerHTML = '';
      options.forEach(o => { const option = document.createElement('option'); option.value=o.value; option.textContent=o.label; manualUnit.appendChild(option); });
    }
    manualToggle.onclick = () => { manualPanel.style.display = manualPanel.style.display === 'none' ? 'block' : 'none'; if (manualPanel.style.display !== 'none') manualLabelInput.focus(); };
    manualDimension.addEventListener('change', updateManualOptions);
    manualAdd.onclick = () => {
      manualError.textContent = '';
      const unit = C.unitInfo(manualUnit.value);
      const value = C.parseNumber(manualValue.value);
      const tolerance = manualTolerance.value.trim() ? C.parseNumber(manualTolerance.value) : null;
      if (!unit || value == null || (tolerance != null && tolerance < 0)) { manualError.textContent = 'Введите корректный номинал, единицу и неотрицательный допуск.'; return; }
      const dimension = manualDimension.value;
      const label = manualLabelInput.value.trim() || comparisonDimensionLabel(dimension);
      const req = {
        id: 'manual_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        kind: unit.kind, dimension: dimension, value: value, unit: unit.symbol, baseValue: value * unit.factor,
        tolerance: tolerance == null ? null : tolerance * unit.factor,
        toleranceValue: tolerance, toleranceUnit: tolerance == null ? null : unit.symbol,
        toleranceMode: tolerance == null ? null : 'symmetric', confidence: 'manual',
        needsConfirmation: true, assumptions: ['Требование введено пользователем; оно не было извлечено из документа.'],
        source: { documentId: null, documentName: 'Введено вручную', sheet: null, row: null, line: null, page: null, excerpt: label.slice(0, 500) },
        unitKindMismatch: false
      };
      addCandidateEntry({ id: req.id, requirement: req, doc: null, manual: true });
      manualPanel.style.display = 'none'; manualValue.value = ''; manualTolerance.value = '';
      toast('Требование добавлено — проверьте и подтвердите перед сверкой');
    };

    candidateSelect.addEventListener('change', renderSelectedCandidate);
    pairSelect.addEventListener('change', () => { currentPairIndex = Number(pairSelect.value || 0); renderComparisonControls(); evaluate(); });
    actualFieldSelect.addEventListener('change', () => { currentField = fields.find(f => f.key === actualFieldSelect.value) || null; updateUnits(unitSelect.value); evaluate(); });
    unitSelect.addEventListener('change', evaluate);
    scopeCheck.addEventListener('change', evaluate);
    unitConfirm.addEventListener('change', evaluate);
    requirementConfirm.addEventListener('change', evaluate);
    saveCompare.onclick = () => {
      const entry = selectedEntry(), req = entry && entry.requirement, field = fields.find(f => f.key === actualFieldSelect.value);
      const result = currentResult;
      if (!entry || !req || !field || !result || saveCompare.disabled) return;
      const pairValue = req.kind === 'pair' && req.values ? req.values[Number(pairSelect.value || 0)] : null;
      const rankedMatch = latestRanking && latestRanking.matches.find(match =>
        match.entry === entry && match.field && match.field.key === field.key &&
        Number(match.pairIndex == null ? 0 : match.pairIndex) === Number(pairSelect.value || 0)
      );
      const assisted = !!(rankedMatch && latestRanking.best === rankedMatch && latestRanking.decision.canAutoConfirm);
      const comparison = {
        schema: 'bim-twin.document-measurement-comparison.v2',
        id: 'doccmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        createdAt: new Date().toISOString(),
        status: result.status,
        statusLabel: docComparisonStatusLabel(result.status),
        field: { key: field.key, label: field.label, rawValue: field.value, kind: field.kind, unit: unitSelect.value },
        expected: {
          value: result.expectedRaw,
          unit: result.expectedUnit || pairValue && pairValue.unit || req.unit,
          baseValue: result.expected,
          kind: result.kind || (pairValue ? 'linear' : req.kind),
          dimension: result.dimension || req.dimension,
          toleranceValue: req.toleranceValue == null ? null : req.toleranceValue,
          toleranceUnit: req.toleranceUnit || req.unit || null,
          toleranceMode: result.toleranceMode || null,
          bound: result.bound == null ? null : result.bound
        },
        actual: { rawValue: field.value, unit: unitSelect.value, baseValue: result.actual, kind: field.kind },
        delta: result.delta,
        absoluteDelta: result.absoluteDelta,
        percentDelta: result.percentDelta,
        source: {
          origin: entry.manual ? 'operator' : 'document',
          documentId: req.source && req.source.documentId || null,
          documentName: req.source && req.source.documentName || 'Введено вручную',
          sheet: req.source && req.source.sheet || null,
          row: req.source && req.source.row || null,
          line: req.source && req.source.line || null,
          page: req.source && req.source.page || null,
          excerpt: req.source && req.source.excerpt || '',
          confidence: req.confidence || 'manual',
          ocr: !!(req.source && req.source.ocr),
          truncated: !!(req.source && req.source.truncated)
        },
        confirmations: {
          room: scopeCheck.checked,
          sourceRequirement: requirementConfirm.checked,
          unitsOrScale: unitConfirm.checked || !(field.kind === 'linear' || field.kind === 'area'),
          autoConfirmed: assisted,
          method: assisted ? 'deterministic-smart-match-v1-with-operator-save' : 'operator'
        },
        automation: {
          mode: assisted ? 'assisted' : 'operator',
          algorithmVersion: '1.0.0',
          score: rankedMatch && rankedMatch.score || null,
          confidence: rankedMatch && rankedMatch.confidence || null,
          margin: latestRanking && latestRanking.margin || null,
          reasons: rankedMatch && rankedMatch.reasons || [],
          warnings: rankedMatch && rankedMatch.warnings || [],
          reasonCodes: rankedMatch && rankedMatch.reasonCodes || [],
          warningCodes: rankedMatch && rankedMatch.warningCodes || []
        },
        context: {
          roomId: room.id || null,
          roomName: room.name || null,
          elementId: context.elementId || null,
          elementName: context.elementName || null,
          elementType: context.elementType || null,
          elementGuid: context.elementGuid || null,
          cloudName: context.cloudName || null
        }
      };
      appendMeasurementComparison(measurement, comparison);
      persistMeasurements(); renderMeasList(); modal.close();
      toast('Сверка сохранена: ' + comparison.statusLabel);
    };

    async function runOcr(doc, button) {
      if (!API || !API.ocrDocument) { toast('OCR недоступен'); return; }
      button.disabled = true; button.textContent = 'Распознаётся…';
      try {
        const parsed = await parseComparisonOcrDocument(doc, true);
        if (!parsed.ok) {
          const reasons = { tesseract_not_installed: 'Tesseract не установлен.', no_pdf_rasterizer: 'Для PDF-OCR нужен Poppler или Ghostscript.', empty: 'Распознанный текст не найден.', unsupported: 'Тип файла не поддерживает OCR.' };
          button.textContent = reasons[parsed.reason] || 'OCR не удался — повторить';
          button.disabled = false; return;
        }
        if (!parsed.requirements.length) {
          button.textContent = 'В OCR-тексте требования не найдены'; button.disabled = true; return;
        }
        addRequirements(doc, parsed.requirements, 'document');
        invalidateRoomRequirementCache(room);
        button.textContent = 'Добавлено требований: ' + parsed.requirements.length; button.disabled = true;
        scanStatus.textContent = 'OCR: найдено требований — ' + parsed.requirements.length + '. OCR-источник всегда требует проверки по оригиналу.';
        renderAutomaticRanking();
      } catch (error) {
        button.textContent = 'Ошибка OCR — повторить'; button.disabled = false;
      }
    }
    async function scanDocuments() {
      scanInProgress = true;
      setScanBusy(true);
      if (!docs.length) {
        scanStatus.textContent = 'В этом помещении нет документов с прикреплёнными файлами. Можно ввести требование вручную.';
        scanInProgress = false; setScanBusy(false); updateCandidateOptions(); renderAutomaticRanking(); return;
      }
      if (!API || !API.readDocument) {
        scanStatus.textContent = 'Чтение локальных документов доступно только в десктопной версии BIM Twin.';
      } else {
        const scan = await scanRoomRequirements(room, {
          autoOcr: true,
          onProgress: progress => {
            if (!modal.overlay.isConnected) return;
            const action = progress.stage === 'ocr' ? 'OCR документа' : progress.stage === 'cache' ? 'Чтение кэша' : 'Анализ документа';
            scanStatus.textContent = action + ' ' + progress.current + ' из ' + progress.total + (progress.name ? ': ' + progress.name : '') + '…';
          }
        });
        if (!modal.overlay.isConnected) return;
        for (const entry of scan.entries) addRequirements(entry.doc, [entry.requirement], 'document');
        scanStatus.textContent = 'Просмотрено документов: ' + scan.docs.length +
          ' · найдено требований: ' + entries.length +
          (scan.ocrCount ? ' · OCR запущен: ' + scan.ocrCount : '') +
          (scan.skippedCount ? ' · неподдерживаемых форматов: ' + scan.skippedCount : '') + '.';
        if (scan.errors.length) scanStatus.textContent += ' Ошибок/предупреждений чтения: ' + scan.errors.length + '.';
        if (scan.ocrFailures.length && API.ocrDocument) {
          const ocrSection = mk('div', 'cmp-ocr-section');
          ocrSection.appendChild(mk('strong', '', 'OCR не завершён'));
          ocrSection.appendChild(mk('div', 'cmp-small-hint', 'Автораспознавание уже запускалось. Можно повторить после установки Tesseract/Poppler или проверки файла.'));
          for (const failure of scan.ocrFailures) {
            const btn = mk('button', 'btn xs');
            btn.textContent = 'Повторить OCR: ' + comparisonDocName(failure.doc);
            btn.type = 'button';
            btn.onclick = () => runOcr(failure.doc, btn);
            ocrSection.appendChild(btn);
          }
          modal.body.insertBefore(ocrSection, manualToggle);
        }
        if (!entries.length) scanStatus.textContent += ' Размеры с явными единицами не найдены; подпишите измерение точнее или введите требование вручную.';
        if (scan.nativeCadSkipped) scanStatus.textContent += ' DWG/RVT/RFA/IFC напрямую не разбираются: приложите размерный лист/спецификацию PDF, XLSX, CSV или DXF.';
      }
      scanInProgress = false;
      setScanBusy(false);
      updateCandidateOptions();
      renderAutomaticRanking();
      if (!entries.length) { renderComparisonControls(); evaluate(); }
    }

    updateCandidateOptions();
    renderComparisonControls();
    evaluate();
    scanDocuments();
  }
  function exportMeasCsv() {
    if (!__measurements.length) { toast('Список измерений пуст'); return; }
    const csv = window.Measure ? window.Measure.measurementsToCsv(__measurements) : '';
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = 'measurements-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('CSV экспортирован (' + __measurements.length + ' строк)');
  }
  async function exportMeasQaReport() {
    if (!__measurements.length) { toast('Список измерений пуст'); return; }
    if (!window.Measure || typeof window.Measure.createMeasurementReport !== 'function') {
      toast('Не удалось сформировать QA-отчёт'); return;
    }
    const values = await openForm('Параметры QA-отчёта', [
      { k: 'author', label: 'Автор отчёта (необязательно)', value: '' },
      { k: 'linearTolerance', label: 'Линейный допуск в единицах источника (необязательно)', type: 'number', value: '' },
      { k: 'angularTolerance', label: 'Угловой допуск в градусах (необязательно)', type: 'number', value: '' }
    ]);
    if (!values) return;
    const optionalTolerance = value => {
      if (value == null || String(value).trim() === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : undefined;
    };
    const linearTolerance = optionalTolerance(values.linearTolerance);
    const angularTolerance = optionalTolerance(values.angularTolerance);
    if (linearTolerance === undefined || angularTolerance === undefined) {
      toast('Допуски должны быть неотрицательными числами; исправьте значения');
      return;
    }
    const cloud = viewer && viewer._cloudRecord || {};
    const sourcePath = cloud.sourceName || lastCloudPath || '';
    const sourceName = String(sourcePath).split(/[\\/]/).pop() || null;
    const project = DB && DB.project || {};
    const report = window.Measure.createMeasurementReport(__measurements, {
      author: values.author,
      project: { id: project.id, name: project.name, room: current && current.name },
      source: {
        name: sourceName,
        format: cloud.format || null,
        pointCount: Number.isSafeInteger(cloud.sourceCount) ? cloud.sourceCount : null,
        loadedPointCount: Number.isSafeInteger(cloud.loadedCount) ? cloud.loadedCount : null
      },
      coordinateReference: {
        frame: 'viewer',
        crsWkt: viewer && viewer._srcCrs || null,
        units: viewer && viewer._srcUnits || null,
        sourceTransform: viewer && viewer._srcXform || null
      },
      tolerances: {
        linear: linearTolerance,
        angular: angularTolerance,
        units: viewer && viewer._srcUnits || null
      }
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(JSON.stringify(report, null, 2), 'measurement-qa-report-' + stamp + '.json', 'application/json');
    toast('QA JSON сформирован · допуски записаны, автоматическая оценка не выполнялась');
  }
  // Экспорт измерений в Notion: формируем готовую Markdown-таблицу и копируем в буфер обмена
  // (вставляется в Notion как настоящая таблица). Дополнительно сохраняем .md-файл.
  function exportMeasNotion() {
    if (!__measurements.length) { toast('Список измерений пуст'); return; }
    const title = 'BIM Twin — измерения ' + new Date().toLocaleString('ru-RU');
    const md = window.Measure ? window.Measure.measurementsToMarkdown(__measurements, title) : '';
    const done = () => toast('Markdown-таблица скопирована — вставьте (Ctrl+V) в Notion');
    let copied = false;
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(md).then(done, () => fallbackCopy(md, done)); copied = true; } } catch (e) {}
    if (!copied) fallbackCopy(md, done);
    // также сохраняем .md как резервную копию
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = 'measurements-notion-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.md';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function fallbackCopy(text, cb) {
    try { const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); document.execCommand('copy'); document.body.removeChild(t); if (cb) cb(); }
    catch (e) { toast('Не удалось скопировать — используйте сохранённый .md файл'); }
  }
  function setMeasuring(on) {
    if (on && !toolsOK()) return false;
    if (on && window.__lxWorkspace) window.__lxWorkspace.exitTools('measure');
    if (viewer && viewer.setMeasure) viewer.setMeasure(!!on);
    ['btnMeasure'].forEach(id => { const b = $(id); if (b) { b.classList.toggle('on', !!on); b.setAttribute('aria-pressed', String(!!on)); } });
    const bar = $('measureBar'); if (bar) bar.style.display = on ? 'flex' : 'none';
    const readout = $('measureReadout'); if (readout) { readout.style.display = on ? '' : 'none'; if (on) {readout.dataset.hint='1';readout.innerHTML = measureHint(viewer.measureMode || 'distance');} }
    if (!on && $('measureListPanel')) $('measureListPanel').style.display = 'none';
    if (on && window._measSetMode) window._measSetMode(viewer.measureMode || 'distance');
    return !!on;
  }
  window.__bimSetMeasuring = setMeasuring;
  function wirePhaseB() {
    if (viewer) viewer.onMeasureReset = mode => { const r = $('measureReadout'); if (r) { r.dataset.hint = '1'; r.style.display = ''; r.innerHTML = measureHint(mode || 'distance'); } };
    if (viewer) viewer.onMeasure = res => { const r = $('measureReadout'); if (r) { r.dataset.hint='0';r.style.display = ''; r.innerHTML = fmtMeasure(res); } if (res && res.mode === 'point' && res.point && window.__lxSetCoords) window.__lxSetCoords(res.point[0], res.point[1], res.point[2]); };
    const bind = (id, fn) => { const b = $(id); if (b) b.addEventListener('click', fn); };
    // кнопки выбора режима измерения
    const mmBtns = Array.prototype.slice.call(document.querySelectorAll('[data-mm]'));
    const setMM = mode => { if (!viewer || !viewer.setMeasureMode) return; viewer.setMeasureMode(mode); mmBtns.forEach(b => b.classList.toggle('on', b.getAttribute('data-mm') === mode)); const r = $('measureReadout'); if (r) { r.dataset.hint='1';r.style.display = ''; r.innerHTML = measureHint(mode); } };
    mmBtns.forEach(b => b.addEventListener('click', () => setMM(b.getAttribute('data-mm'))));
    bind('mmClear', () => { if (viewer && viewer.setMeasureMode) { viewer.setMeasureMode(viewer.measureMode || 'distance'); } const r = $('measureReadout'); if (r){r.dataset.hint='1';r.innerHTML = measureHint(viewer && viewer.measureMode || 'distance');} });
    bind('mmFinish', () => { if (viewer && viewer.finishMeasure) viewer.finishMeasure(); });
    // «Выйти» в панелях измерения, правки и станций — то же, что Esc: выключает активный инструмент
    const exitTool = () => { if (window.__lxModes && window.__lxModes.cancelAll) window.__lxModes.cancelAll('exit'); else if (window.__lxWorkspace && window.__lxWorkspace.exitTools) window.__lxWorkspace.exitTools(); };
    ['mmExit', 'edExit', 'tsExit'].forEach(id => bind(id, exitTool));
    // привязка (snap)
    bind('mmSnap', e => { if (!viewer || !viewer.setMeasureSnap) return; const on = viewer.setMeasureSnap(!viewer.measureSnap); e.currentTarget.classList.toggle('on', on); toast(on ? 'Привязка к рёбрам и углам включена' : 'Привязка выключена'); });
    // список / сохранение / CSV
    bind('mmSave', () => saveMeasurement());
    bind('mmCsv', () => exportMeasCsv());
    bind('mmQaReport', () => exportMeasQaReport());
    bind('mmNotion', () => exportMeasNotion());
    bind('mlAutoCompare', () => autoCompareAllMeasurements());
    bind('mlOpenVerify', () => { if (window.__lxVerify) window.__lxVerify.open({}); });
    bind('mlCsv', () => exportMeasCsv());
    bind('mlNotion', () => exportMeasNotion());
    // «Очистить всё» без диалога: список из нескольких замеров стирается только вторым нажатием в течение 4 секунд
    let clearArm = 0;
    bind('mlClearAll', () => {
      if (__measurements.length > 1 && Date.now() - clearArm > 4000) { clearArm = Date.now(); toast('В списке замеров: ' + __measurements.length + '. Нажмите ещё раз, чтобы очистить весь список'); return; }
      clearArm = 0; __measurements = []; renderMeasList(); persistMeasurements();
    });
    bind('mmList', () => { const p = $('measureListPanel'); if (p) { p.style.display = p.style.display === 'none' ? 'block' : 'none'; renderMeasList(); } });
    window._measSetMode = setMM;
    renderMeasList();
    bind('btnSection', e => { if (!toolsOK()) return; const on = !e.currentTarget.classList.contains('on'); e.currentTarget.classList.toggle('on', on); viewer.setSection(on); const s = $('sectionRange'); if (s) s.style.display = 'none'; const p = ensureSectionPanel(); if (p) p.style.display = on ? 'block' : 'none'; });
    const sr = $('sectionRange'); if (sr) sr.addEventListener('input', e => { if (viewer && viewer.setSectionValue) viewer.setSectionValue(Number(e.target.value) / 100); });
    function ensureSectionPanel() {
      if (window.__secPanel) return window.__secPanel;
      const host = $('stageSideL') || document.querySelector('.stage') || document.body;
      const wrap = document.createElement('section'); wrap.id = 'sectionPanel'; wrap.className = 'fpanel fp-left'; wrap.style.display = 'none';
      wrap.setAttribute('aria-label', 'Секущий бокс');
      const axes = [ { a: 'y', label: 'Верх — низ' }, { a: 'x', label: 'Лево — право' }, { a: 'z', label: 'Перёд — зад' } ];
      let html = '<div class="fpanel-inner"><header class="fpanel-head"><span class="fpanel-ico" data-ico="square-split-vertical"></span><h3>Секущий бокс</h3>' +
        '<div class="fpanel-actions"><button class="icon-btn" type="button" data-close="sectionPanel" data-ico="x" title="Закрыть" aria-label="Закрыть"></button></div></header><div class="fpanel-body">' +
        '<p class="sec-note">Быстрый тонкий срез · толщина 0,2 м</p>' +
        '<div class="sec-presets">' +
        '<button type="button" class="btn sm" id="sec_preset_y" title="Горизонтальный плановый срез по Y">План · Y</button>' +
        '<button type="button" class="btn sm" id="sec_preset_z" title="Вертикальный фасадный срез по Z">Фасад · Z</button>' +
        '<button type="button" class="btn sm" id="sec_preset_x" title="Вертикальный боковой срез по X">Бок · X</button></div>';
      for (const ax of axes) {
        html += '<div class="sec-axis"><div class="sec-axis-lbl">' + ax.label + '</div>' +
          '<input type="range" id="sec_' + ax.a + '_min" min="0" max="100" step="0.02" value="0" aria-label="' + ax.label + ': от">' +
          '<input type="range" id="sec_' + ax.a + '_max" min="0" max="100" step="0.02" value="100" aria-label="' + ax.label + ': до">' +
          '<div id="sec_' + ax.a + '_readout" class="sec-readout">Полный диапазон</div></div>';
      }
      html += '<button id="sec_reset" class="btn sec-reset" type="button">Сбросить срез</button>' +
        '<p class="sec-note">Очистка и выделение работают только по видимой (несрезанной) части. Срезанное защищено и вернётся при сбросе.</p></div></div>';
      wrap.innerHTML = html; host.appendChild(wrap); window.__secPanel = wrap;
      const axisI = { x: 0, y: 1, z: 2 };
      const readout = (a) => {
        const mn = $('sec_' + a + '_min'), mx = $('sec_' + a + '_max'), out = $('sec_' + a + '_readout');
        if (!mn || !mx || !out) return;
        const b = viewer && viewer.bbox, i = axisI[a];
        if (!b || !b.mn || !b.mx || !Number.isFinite(b.mn[i]) || !Number.isFinite(b.mx[i])) { out.textContent = 'Координаты недоступны'; return; }
        const loPct = Math.max(0, Math.min(1, Number(mn.value) / 100)), hiPct = Math.max(0, Math.min(1, Number(mx.value) / 100));
        const lo = b.mn[i] + (b.mx[i] - b.mn[i]) * Math.min(loPct, hiPct), hi = b.mn[i] + (b.mx[i] - b.mn[i]) * Math.max(loPct, hiPct);
        out.textContent = a.toUpperCase() + ': ' + lo.toFixed(3) + '–' + hi.toFixed(3) + ' м · толщина ' + (hi - lo).toFixed(3) + ' м';
      };
      const apply = (a, edge) => {
        const mn = $('sec_' + a + '_min'), mx = $('sec_' + a + '_max'); if (!mn || !mx) return;
        if (Number(mn.value) > Number(mx.value)) { if (edge === 'min') mx.value = mn.value; else mn.value = mx.value; }
        const lo = Number(mn.value) / 100, hi = Number(mx.value) / 100;
        if (viewer && viewer.setSectionAxis) viewer.setSectionAxis(a, lo, hi);
        readout(a);
      };
      for (const ax of axes) {
        const mn = $('sec_' + ax.a + '_min'), mx = $('sec_' + ax.a + '_max');
        if (mn) mn.addEventListener('input', () => apply(ax.a, 'min'));
        if (mx) mx.addEventListener('input', () => apply(ax.a, 'max'));
        readout(ax.a);
      }
      const preset = (axis) => {
        const i = axisI[axis], b = viewer && viewer.bbox;
        if (!b || !b.mn || !b.mx || !Number.isFinite(b.mn[i]) || !Number.isFinite(b.mx[i])) return;
        const span = b.mx[i] - b.mn[i]; if (!(span > 0)) return;
        const thickness = Math.min(0.2, span), half = thickness / span / 2, lo = Math.max(0, 0.5 - half), hi = Math.min(1, 0.5 + half);
        for (const ax of axes) {
          const mn = $('sec_' + ax.a + '_min'), mx = $('sec_' + ax.a + '_max');
          if (mn) mn.value = ax.a === axis ? lo * 100 : 0;
          if (mx) mx.value = ax.a === axis ? hi * 100 : 100;
          readout(ax.a);
        }
        document.querySelectorAll('#sectionPanel [id^="sec_preset_"]').forEach(bn => bn.classList.toggle('on', bn.id === 'sec_preset_' + axis));
        if (viewer && viewer.sliceSetup) viewer.sliceSetup(axis, lo, hi);
        else if (viewer && viewer.setSectionAxis) { viewer.setSection(true); viewer.setSectionAxis(axis, lo, hi); }
        if (viewer && viewer.setSectionView) viewer.setSectionView(axis);
      };
      ['x', 'y', 'z'].forEach(a => { const b = $('sec_preset_' + a); if (b) b.addEventListener('click', () => preset(a)); });
      const rb = $('sec_reset'); if (rb) rb.addEventListener('click', () => {
        for (const ax of axes) { const mn = $('sec_' + ax.a + '_min'), mx = $('sec_' + ax.a + '_max'); if (mn) mn.value = 0; if (mx) mx.value = 100; readout(ax.a); }
        document.querySelectorAll('#sectionPanel [id^="sec_preset_"]').forEach(bn => bn.classList.remove('on'));
        if (viewer && viewer.resetSection) viewer.resetSection();
      });
      return wrap;
    }
    bind('btnMeasure', () => setMeasuring(!(viewer && viewer.measuring)));
    bind('btnIsolate', e => {
      if (!toolsOK()) return;
      const on = !viewer.isolate;
      const applied = viewer.setIsolate(on);
      if (applied === false && on) toast('Сначала выберите объект или элемент, который нужно изолировать');
      const active = !!viewer.isolate;
      e.currentTarget.classList.toggle('on', active); e.currentTarget.setAttribute('aria-pressed', String(active));
    });
    bind('btnLOD', e => {
      if (!toolsOK()) return;
      if (!viewer.supportsLOD || !viewer.supportsLOD()) { toast('LOD доступен только для полигональной модели; облако точек не прореживается'); syncLODControl(); return; }
      const ok = viewer.setLOD(!viewer.lod);
      if (!ok) toast('Не удалось применить LOD к текущей модели');
      syncLODControl();
    });
    window.addEventListener('bim-cloud-change', syncLODControl);
    syncLODControl();
    const ifc = $('ifcInput'); if (ifc) ifc.addEventListener('change', e => { if (e.target.files[0]) importIFCFile(e.target.files[0]); e.target.value = ''; });
  }
  function mapIfcType(t) { t = (t || '').toUpperCase(); if (t.includes('DUCT') || t.includes('AIRTERMINAL') || t.includes('FAN')) return 'вентшахта'; if (t.includes('PIPE') || t.includes('VALVE') || t.includes('PUMP')) return 'труба'; if (t.includes('DOOR')) return 'дверь'; if (t.includes('CABLE')) return 'кабель-канал'; return 'оборудование'; }
  async function importIFCFile(file) {
    let rep;
    try {
      if (CAN_PERSIST) { const base64 = await fileToBase64(file); rep = await API.importIFC({ base64, targetRoomId: current && current.id }); await refresh(current && current.id); }
      else { const text = await file.text(); const parsed = window.IFCImport.parseIFC(text); rep = linkIFCDemo(parsed); renderTree(); if (current) openRoom(current.id); }
    } catch (e) { console.error(e); toast('Не удалось разобрать IFC'); return; }
    showIFCReport(rep);
  }
  function linkIFCDemo(parsed) {
    const byGuid = new Map();
    for (const r of DB.rooms) for (const el of r.elements) if (el.ifc_guid) byGuid.set(el.ifc_guid, { el, r });
    const matched = [], created = [];
    const room = current || DB.rooms[0];
    for (const it of parsed.elements) {
      const hit = byGuid.get(it.guid);
      if (hit) matched.push({ name: hit.el.name, room: hit.r.name });
      else if (room) { const el = { id: 'el_' + Math.random().toString(36).slice(2, 8), ifc_guid: it.guid, name: it.name || it.ifcType, type: mapIfcType(it.ifcType), ai_status: 'none' }; room.elements.push(el); created.push({ name: el.name, room: room.name }); }
    }
    return { project: parsed.project, storeys: parsed.storeys.map(s => s.name), spaces: parsed.spaces.map(s => s.name || s.longName || ''), matched, created };
  }
  function showIFCReport(rep) {
    if (!rep) { toast('IFC импортирован'); return; }
    const li = a => (a && a.length) ? '<ul>' + a.map(x => '<li>' + esc(typeof x === 'string' ? x : (x.name + (x.room ? ' · ' + x.room : ''))) + '</li>').join('') + '</ul>' : '<div class="muted">—</div>';
    const html = '<div class="ifc-report">' +
      '<div class="kv"><span class="k">Проект</span><span>' + esc(rep.project || '—') + '</span></div>' +
      '<div class="kv"><span class="k">Этажи</span><span>' + esc((rep.storeys || []).join(', ') || '—') + '</span></div>' +
      '<h4>Пространства (' + (rep.spaces || []).length + ')</h4>' + li(rep.spaces) +
      '<h4>Связано по IFC GUID (' + (rep.matched || []).length + ')</h4>' + li(rep.matched) +
      '<h4>Создано новых элементов (' + (rep.created || []).length + ')</h4>' + li(rep.created) +
      '</div>';
    showInfo('Импорт IFC', html);
    toast('IFC: связано ' + ((rep.matched || []).length) + ', новых ' + ((rep.created || []).length));
  }
  function showInfo(title, html) {
    const bg = $('formModal'); $('formTitle').textContent = title; $('formBody').innerHTML = html;
    bg.classList.add('open'); const cancel = $('formCancel'); if (cancel) cancel.style.display = 'none';
    const close = () => { bg.classList.remove('open'); $('formOk').onclick = null; if (cancel) cancel.style.display = ''; };
    $('formOk').onclick = close;
  }

  // ---------- helpers ----------
  /** Содержимое кнопки: иконка + подпись (подпись в .lbl — её подменяет i18n) */
  function IB(name, text, size) { return (window.ICON ? window.ICON(name, size || 15) : '') + '<span class="lbl">' + esc(text) + '</span>'; }
  function mk(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  // Кнопка только с иконкой обязана иметь имя: подсказка и aria-label
  function named(btn, text) { btn.title = text; btn.setAttribute('aria-label', text); return btn; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function syncTabs() { document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab)); renderTab(); }

  function syncProjectHistoryButtons() {
    const ps = window.BimProjectState;
    const undo = $('btnProjectUndo'), redo = $('btnProjectRedo');
    if (undo) {
      undo.disabled = !(ps && ps.canUndo);
      undo.title = ps && ps.canUndo
        ? 'Отменить последнее сохранение состояния проекта (Ctrl+Z)'
        : 'Нет сохранённого изменения проекта для отмены';
    }
    if (redo) {
      redo.disabled = !(ps && ps.canRedo);
      redo.title = ps && ps.canRedo
        ? 'Повторить отменённое изменение состояния проекта (Ctrl+Shift+Z)'
        : 'Нет отменённого изменения проекта для повтора';
    }
  }
  function bindProjectHistoryControls() {
    if (window.__bimProjectHistoryBound) { syncProjectHistoryButtons(); return; }
    window.__bimProjectHistoryBound = true;
    const run = async direction => {
      const ps = window.BimProjectState;
      if (!ps || typeof ps[direction] !== 'function') { toast('История проекта недоступна'); return; }
      const undo = $('btnProjectUndo'), redo = $('btnProjectRedo');
      if (undo) undo.disabled = true;
      if (redo) redo.disabled = true;
      try {
        const result = await ps[direction]();
        if (!result || result.ok === false) {
          const noEntry = result && (result.error === 'no_undo' || result.error === 'no_redo');
          toast(noEntry ? 'Нет сохранённой версии для ' + (direction === 'undo' ? 'отмены' : 'повтора') :
            'Не удалось изменить версию проекта: ' + String(result && (result.message || result.error) || 'ошибка'));
        } else {
          toast(direction === 'undo' ? 'Состояние проекта отменено' : 'Состояние проекта восстановлено');
        }
      } catch (error) {
        toast('Не удалось изменить версию проекта: ' + String(error && error.message || error));
      } finally { syncProjectHistoryButtons(); }
    };
    const undo = $('btnProjectUndo'), redo = $('btnProjectRedo');
    if (undo) undo.addEventListener('click', () => run('undo'));
    if (redo) redo.addEventListener('click', () => run('redo'));
    ['bim-project-state-ready', 'bim-project-state-saved', 'bim-project-state-restored', 'bim-project-state-error']
      .forEach(name => window.addEventListener(name, syncProjectHistoryButtons));
    window.addEventListener('bim-project-state-conflict', async event => {
      if (window.__bimProjectConflictDialog) return;
      const detail = event && event.detail || {}, ps = window.BimProjectState;
      if (!ps || (detail.projectId && detail.projectId !== ps.projectId)) return;
      window.__bimProjectConflictDialog = true;
      try {
        const fields = Array.isArray(detail.conflicts) && detail.conflicts.length ? detail.conflicts.join(', ') : 'состояние проекта';
        const reloadRemote = await confirmBox(
          'Проект был изменён в другом окне или процессе (' + fields + '). ' +
          'Локальная правка не была перезаписана и пока не сохранена. Перезагрузить последнюю версию с диска и отбросить только конфликтующую локальную правку?'
        );
        if (reloadRemote) {
          await ps.discardPendingAndReload();
          toast('Загружена последняя сохранённая версия проекта');
        } else {
          toast('Локальные изменения оставлены в памяти; разрешите конфликт перед переключением проекта');
        }
      } catch (error) {
        toast('Не удалось разрешить конфликт версии проекта: ' + String(error && error.message || error));
      } finally { window.__bimProjectConflictDialog = false; syncProjectHistoryButtons(); }
    });
    if (window.BimProjectState && window.BimProjectState.ready) {
      Promise.resolve(window.BimProjectState.ready).finally(syncProjectHistoryButtons);
    }
    syncProjectHistoryButtons();
  }

  // ---------- init ----------
  async function init() {
    const canvas = $('viewer');
    const onSel = el => { if (el) selectEl(el.id); else selectEl(null); };
    let VClass = window.Viewer3D;
    try { if (window.Viewer3DGL && window.Viewer3DGL.isSupported && window.Viewer3DGL.isSupported()) VClass = window.Viewer3DGL; } catch (_) {}
    try { viewer = new VClass(canvas, onSel); }
    catch (err) { console.warn('WebGL viewer unavailable, using 2D', err); viewer = new window.Viewer3D(canvas, onSel); }
    viewer.onHover = null;
    try { window.__viewer = viewer; window.dispatchEvent(new Event('lx-viewer-ready')); } catch (e) {}
    // Keep the AI-highlight affordance in sync with the viewer's default state.
    try { const aiBtn = $('btnAI'); const aiOn = !!viewer.showAI; if (aiBtn) { aiBtn.classList.toggle('on', aiOn); aiBtn.setAttribute('aria-pressed', String(aiOn)); } } catch (e) {}
    viewer.onQualityChange = () => { if (window.__bimRefreshQuality) window.__bimRefreshQuality(); };
    // v1042: если огромное облако прорежено для просмотра — честно сообщаем (полная точность — в файле/CloudCompare).
    viewer.onDecimated = (from, to) => { try { toast('Облако большое (' + nfmt(from) + ') — для просмотра показано ' + nfmt(to) + ' точек. Полная точность — в авто-очистке и CloudCompare.'); } catch (e) {} };
    wirePhaseB();
    wireViewerExtras();
    await loadData();
    if (CAN_VERIFY) { try { SETTINGS = (await API.getSettings()) || {}; } catch (e) { SETTINGS = {}; } }
    // Phase E: merge locally-persisted prefs (theme/lang/onboarded) for demo mode & fallback
    try {
      const ls = JSON.parse(localStorage.getItem('bim.settings') || 'null');
      if (ls) {
        delete ls.llmApiKey;
        delete ls.llmApiKeyEnc;
        SETTINGS = Object.assign({}, ls, SETTINGS);
        localStorage.setItem('bim.settings', JSON.stringify(settingsForLocalStorage(SETTINGS)));
      }
    } catch (e) {}
    // Ревизия 4: бюджет точек по умолчанию — 200 млн (облако читается целиком), «пол» для старых проектов — тоже 200 млн
    // (resolvePointBudget поднимает прежнее сохранённое значение один раз). От нехватки памяти защищает las-node (сужает бюджет,
    // а не роняет окно), от предела видеопамяти — viewer._maxSingleBuffer. Ползунок «Плотность» можно двигать вручную (до 300 млн).
    const defaultPointBudget = Number(window.APP_CONFIG && window.APP_CONFIG.DEFAULT_MAX_POINTS) || 200000000;
    const initialPointBudget = (window.APP_CONFIG && window.APP_CONFIG.resolvePointBudget) ? window.APP_CONFIG.resolvePointBudget(SETTINGS) : (Number(SETTINGS.pointBudget) > 0 ? Number(SETTINGS.pointBudget) : defaultPointBudget);
    try { window.__POINT_BUDGET__ = initialPointBudget; if (window.PointCloud && window.PointCloud.setBudget) window.PointCloud.setBudget(initialPointBudget); } catch (_) {}
    try { if (viewer && viewer.setLodBudget) viewer.setLodBudget(lodDrawBudget(initialPointBudget)); } catch (_) {}
    const densityControl = $('qDensity');
    if (densityControl) densityControl.value = String(Math.max(1, Math.min(300, Math.round(initialPointBudget / 1000000))));
    try { decorateIcons(); } catch (e) { console.warn('icons', e); }
    applyLang(SETTINGS.lang || (window.I18N && window.I18N.lang) || 'ru');
    // v0.9.19: одноразовый переход на новую светлую тему claude.ai (сбрасывает старую тёмную один раз)
    try { if (localStorage.getItem('bim.theme.v1089') !== '1') { SETTINGS.theme = 'dark'; localStorage.setItem('bim.theme.v1089', '1'); persistSettings({ theme: 'dark' }); } } catch (e) {}
    applyTheme(SETTINGS.theme || 'light');
    { // компактная плашка режима; полная формулировка — в подсказке
      const modeName = CAN_PERSIST ? String(await API.getMode()) : 'демо (без сохранения)', ml = $('modeLabel');
      ml.textContent = CAN_PERSIST ? ({ sqlite: 'SQLite', json: 'JSON' }[modeName] || modeName) : 'Демо'; ml.classList.toggle('demo', !CAN_PERSIST);
      ml.setAttribute('data-tip', 'Режим: ' + modeName + (CAN_PERSIST ? '' : ' — данные не записываются на диск'));
    }

    $('btnAI').addEventListener('click', e => { const on = !e.currentTarget.classList.contains('on'); e.currentTarget.classList.toggle('on', on); viewer.setAIHighlight(on); });
    $('btnVerify').addEventListener('click', () => runVerify());
    $('btnSettings').addEventListener('click', openSettings);
    $('btnReset').addEventListener('click', () => viewer.resetView());
    $('btnCompare').addEventListener('click', openCompare);
    $('cmpClose').addEventListener('click', () => $('cmpModal').classList.remove('open'));
    $('btnEdit').addEventListener('click', () => setEditing(!editing));
    $('btnBackup').addEventListener('click', doBackup);
    bindProjectHistoryControls();

    // Кастомные кнопки окна (десктоп, кроме macOS — там системные «светофоры»)
    try {
      const wb = $('tbWinBtns');
      if (API && API.winMin && API.platform !== 'darwin') {
        $('tbMin').addEventListener('click', () => API.winMin());
        $('tbMax').addEventListener('click', () => API.winMax());
        $('tbClose').addEventListener('click', () => API.winClose());
      } else if (wb) { wb.style.display = 'none'; }
    } catch (e) {}
    $('btnBackRoom').addEventListener('click', () => { if (current) openRoom(current.id); });
    { const _boc = $('btnOpenCloud'); if (_boc) _boc.addEventListener('click', openPendingCloud); }
    $('search').addEventListener('input', e => { searchTerm = e.target.value.trim().toLowerCase(); renderTree(); });
    document.querySelectorAll('.fchip').forEach(c => c.addEventListener('click', () => { document.querySelectorAll('.fchip').forEach(x => { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); }); c.classList.add('active'); c.setAttribute('aria-pressed', 'true'); filter = c.dataset.f; renderTree(); }));
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => { activeTab = t.dataset.tab; syncTabs(); }));
    $('modelInput').addEventListener('change', e => { if (e.target.files[0]) loadModelFile(e.target.files[0]); e.target.value = ''; });
    $('docInput').addEventListener('change', e => { if (e.target.files[0]) addDocumentFile(e.target.files[0]); e.target.value = ''; });

    await loadTeam();
    const ps = $('projSelect'); if (ps) ps.addEventListener('change', e => switchProjectUI(e.target.value));
    const bnp = $('btnNewProject'); if (bnp) bnp.addEventListener('click', newProjectUI);
    const bu = $('btnUsers'); if (bu) bu.addEventListener('click', openUsers);
    const be = $('btnExport'); if (be) be.addEventListener('click', exportReportUI);
    const bs = $('btnSync'); if (bs) bs.addEventListener('click', syncUI);

    renderTree();
    if (DB.rooms.length) openRoom(DB.rooms[0].id);
    maybeOnboard();
    window.dispatchEvent(new Event('bim-app-ready'));
  }
  // ---------- Phase D: команда, проекты, обсуждения, отчёты, синхронизация ----------
  const NONE_ASSIGNEE = '— не назначен —';
  const ROLES = ['Администратор', 'Инженер', 'Наблюдатель'];

  async function loadTeam() {
    if (API && API.listUsers) { try { USERS = (await API.listUsers()) || []; } catch (e) { USERS = []; } }
    if (API && API.listProjects) { try { PROJECTS = (await API.listProjects()) || []; } catch (e) { PROJECTS = []; } }
    else { PROJECTS = [{ id: (DB.project && DB.project.id) || 'demo', name: (DB.project && DB.project.name) || 'Демо-проект', active: true, rooms: DB.rooms.length }]; }
    renderProjSwitcher();
    window.dispatchEvent(new Event('bim-project-changed'));
  }
  function renderProjSwitcher() {
    const sel = $('projSelect'); if (!sel) return;
    sel.innerHTML = '';
    for (const p of PROJECTS) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name + (p.rooms != null ? ' (' + p.rooms + ')' : ''); if (p.active) o.selected = true; sel.appendChild(o); }
    const _cur = PROJECTS.find(p => p.active) || PROJECTS[0]; if (_cur) sel.title = _cur.name;
  }
  async function switchProjectUI(id) {
    if (!API || !API.switchProject) { toast('Переключение проектов — в десктоп-версии'); renderProjSwitcher(); return; }
    try {
      const ps = window.BimProjectState;
      if (window.__pcAutosave && window.__pcAutosave.flush) {
        await window.__pcAutosave.flush();
        if (window.__pcAutosave.isDirty && window.__pcAutosave.isDirty()) throw new Error('Черновик облака не сохранён; сохраните или сократите облако перед переключением');
      }
      if (window.__lxDraw && window.__lxDraw.flushProjectState) {
        const drawingSave = await window.__lxDraw.flushProjectState();
        if (drawingSave && drawingSave.ok === false) throw new Error('Не удалось сохранить чертёж');
      }
      if (ps && ps.flush) {
        const saved = await ps.flush();
        if (saved && saved.ok === false) throw new Error('Сначала устраните ошибку сохранения состояния проекта');
      }
      const switched = await API.switchProject(id);
      if (!switched) throw new Error('Проект не найден');
      // Never leave points from the previous project visible while the next
      // project is loading or has a missing source file.
      resetProjectCloudContext();
      try { if (viewer && viewer.clearCloud) viewer.clearCloud(); } catch (_) {}
      if (ps && ps.reload) await ps.reload();
      await loadData(); await loadTeam();
      current = null; selEl = null; renderTree();
      if (DB.rooms.length) openRoom(DB.rooms[0].id); else renderTab();
      toast('Проект переключён');
    } catch (error) {
      renderProjSwitcher();
      toast('Не удалось переключить проект: ' + String(error && error.message || error));
    }
  }
  async function newProjectUI() {
    if (!API || !API.createProject) { toast('Создание проектов — в десктоп-версии'); return; }
    const v = await openForm('Новый проект', [{ k: 'name', label: 'Название', value: '' }, { k: 'address', label: 'Адрес', value: '' }]);
    if (!v || !v.name) return;
    try {
      const ps = window.BimProjectState;
      if (window.__pcAutosave && window.__pcAutosave.flush) {
        await window.__pcAutosave.flush();
        if (window.__pcAutosave.isDirty && window.__pcAutosave.isDirty()) throw new Error('Черновик облака не сохранён; сохраните или сократите облако перед созданием проекта');
      }
      if (window.__lxDraw && window.__lxDraw.flushProjectState) {
        const drawingSave = await window.__lxDraw.flushProjectState();
        if (drawingSave && drawingSave.ok === false) throw new Error('Не удалось сохранить чертёж');
      }
      if (ps && ps.flush) {
        const saved = await ps.flush();
        if (saved && saved.ok === false) throw new Error('Сначала устраните ошибку сохранения состояния проекта');
      }
      const p = await API.createProject({ name: v.name, address: v.address || '' });
      resetProjectCloudContext();
      try { if (viewer && viewer.clearCloud) viewer.clearCloud(); } catch (_) {}
      if (ps && ps.reload) await ps.reload();
      await loadData(); await loadTeam(); current = null; selEl = null; renderTree(); renderTab();
      toast('Проект создан: ' + (p && p.name || v.name));
    } catch (error) {
      toast('Не удалось создать проект: ' + String(error && error.message || error));
    }
  }

  function modalPanel(title) {
    const overlay = mk('div', 'modal open');
    const card = mk('div', 'modal-card');
    const head = mk('div', 'modal-head'); head.innerHTML = '<span>' + esc(title) + '</span>';
    const x = mk('span', 'x', ICON('x', 16)); x.onclick = () => overlay.remove(); head.appendChild(x);
    const bodyEl = mk('div', 'panel-body');
    card.append(head, bodyEl); overlay.appendChild(card); document.body.appendChild(overlay);
    return { overlay, body: bodyEl, close: () => overlay.remove() };
  }
  function userFields(u) {
    return [
      { k: 'name', label: 'Имя', value: u.name || '' },
      { k: 'role', label: 'Роль', value: u.role || 'Инженер', type: 'select', options: ROLES },
      { k: 'email', label: 'E-mail', value: u.email || '' }
    ];
  }
  async function openUsers() {
    const p = modalPanel('Команда и роли');
    const render = () => {
      p.body.innerHTML = '';
      const add = mk('button', 'btn sm primary', ICON('plus', 15) + '<span class="lbl">Добавить участника</span>');
      add.onclick = async () => {
        const v = await openForm('Новый участник', userFields({})); if (!v || !v.name) return;
        if (API && API.createUser) { try { const u = await API.createUser({ name: v.name, role: v.role, email: v.email }); USERS.push(u); } catch (e) {} }
        else USERS.push({ id: 'u_' + Date.now(), name: v.name, role: v.role, email: v.email });
        render();
      };
      p.body.appendChild(add);
      if (!USERS.length) p.body.appendChild(mk('div', 'empty', 'Участников пока нет'));
      for (const u of USERS) {
        const row = mk('div', 'urow');
        row.innerHTML = '<div class="uinfo"><b>' + esc(u.name) + '</b><span class="urole">' + esc(u.role || '') + (u.email ? ' · ' + esc(u.email) : '') + '</span></div>';
        const ed = named(mk('button', 'btn xs', ICON('pencil', 14)), 'Изменить участника'); ed.onclick = async () => { const v = await openForm('Изменить участника', userFields(u)); if (!v) return; Object.assign(u, { name: v.name, role: v.role, email: v.email }); if (API && API.updateUser) { try { await API.updateUser(u.id, { name: v.name, role: v.role, email: v.email }); } catch (e) {} } render(); };
        const del = named(mk('button', 'btn xs danger', ICON('trash', 14)), 'Удалить участника'); del.onclick = async () => { if (!(await confirmBox('Удалить участника ' + u.name + '?'))) return; USERS = USERS.filter(x => x.id !== u.id); if (API && API.deleteUser) { try { await API.deleteUser(u.id); } catch (e) {} } render(); };
        const acts = mk('div', 'uacts'); acts.append(ed, del); row.appendChild(acts);
        p.body.appendChild(row);
      }
    };
    render();
  }
  async function assignFindingUI(f) {
    if (!USERS.length) { toast('Сначала добавьте участников (Команда)'); openUsers(); return; }
    const names = [NONE_ASSIGNEE].concat(USERS.map(u => u.name));
    const curName = (USERS.find(u => u.id === f.assignee) || {}).name || NONE_ASSIGNEE;
    const v = await openForm('Назначить ответственного', [
      { k: 'assignee', label: 'Ответственный', value: curName, type: 'select', options: names },
      { k: 'due', label: 'Срок (ГГГГ-ММ-ДД)', value: f.due || '' }
    ]);
    if (!v) return;
    const u = USERS.find(x => x.name === v.assignee);
    f.assignee = u ? u.id : null; f.due = v.due || null;
    if (API && API.assignFinding && f.id) { try { await API.assignFinding(f.id, { assignee: f.assignee, due: f.due }); } catch (e) {} }
    renderTab(); toast('Ответственный обновлён');
  }

  function discussionsFor(elementId) { const arr = (DB.discussions || []); return elementId ? arr.filter(d => d.element_id === elementId) : arr; }
  function renderDisc(body) {
    const el = selEl;
    body.appendChild(mk('div', 'disc-scope', el ? ('Элемент: ' + esc(el.name)) : 'Выберите элемент на сцене, чтобы вести обсуждение по нему'));
    if (el) { const add = mk('button', 'btn sm primary', '+ Новая тема'); add.onclick = () => newDiscussionUI(el); body.appendChild(add); }
    const list = discussionsFor(el && el.id);
    if (!list.length) { body.appendChild(mk('div', 'empty', el ? 'Обсуждений по элементу нет' : '—')); return; }
    for (const d of list) {
      const card = mk('div', 'disc' + (d.status === 'resolved' ? ' resolved' : ''));
      const cmts = (d.comments || []).map(c => '<div class="dc"><span class="da">' + esc(c.author || 'аноним') + '</span> ' + esc(c.text || c) + '</div>').join('');
      card.innerHTML = '<div class="dhead"><b>' + esc(d.title) + '</b><span class="dstatus ' + d.status + '">' + (d.status === 'resolved' ? 'решено' : 'открыто') + '</span></div>' +
        (d.author ? '<div class="dmeta">автор: ' + esc(d.author) + '</div>' : '') + '<div class="dcomments">' + cmts + '</div>';
      const acts = mk('div', 'dacts');
      const rep = mk('button', 'btn xs', IB('message-circle', 'Ответить', 14)); rep.onclick = () => replyDiscussionUI(d);
      const res = mk('button', 'btn xs', d.status === 'resolved' ? IB('rotate-ccw', 'Открыть', 14) : IB('check', 'Решить', 14)); res.onclick = () => toggleDiscussion(d);
      const del = named(mk('button', 'btn xs danger', ICON('trash', 14)), 'Удалить тему'); del.onclick = async () => { if (await confirmBox('Удалить тему?')) removeDiscussion(d); };
      acts.append(rep, res, del); card.appendChild(acts);
      body.appendChild(card);
    }
  }
  async function newDiscussionUI(el) {
    const v = await openForm('Новая тема обсуждения', [{ k: 'title', label: 'Тема', value: '' }, { k: 'author', label: 'Автор', value: '' }, { k: 'text', label: 'Первый комментарий', value: '' }]);
    if (!v || !v.title) return;
    let d = { id: 'disc_' + Date.now(), element_id: el.id, room_id: current && current.id, title: v.title, status: 'open', author: v.author || '', created_at: new Date().toISOString(), comments: [] };
    if (API && API.createDiscussion) {
      try { const saved = await API.createDiscussion({ element_id: el.id, room_id: current && current.id, title: v.title, author: v.author || '' }); if (saved) d = saved; if (v.text) { const upd = await API.addDiscussionComment(d.id, { author: v.author || '', text: v.text }); if (upd) d = upd; } } catch (e) {}
    } else if (v.text) { d.comments.push({ author: v.author || '', text: v.text, at: new Date().toISOString() }); }
    DB.discussions = (DB.discussions || []).filter(x => x.id !== d.id); DB.discussions.push(d);
    renderTab(); toast('Тема создана');
  }
  async function replyDiscussionUI(d) {
    const v = await openForm('Ответить', [{ k: 'author', label: 'Автор', value: '' }, { k: 'text', label: 'Комментарий', value: '' }]);
    if (!v || !v.text) return;
    d.comments = d.comments || []; d.comments.push({ author: v.author || '', text: v.text, at: new Date().toISOString() });
    if (API && API.addDiscussionComment) { try { await API.addDiscussionComment(d.id, { author: v.author || '', text: v.text }); } catch (e) {} }
    renderTab();
  }
  function toggleDiscussion(d) {
    d.status = d.status === 'resolved' ? 'open' : 'resolved';
    if (API && API.setDiscussionStatus) { try { API.setDiscussionStatus(d.id, d.status); } catch (e) {} }
    renderTab();
  }
  function removeDiscussion(d) {
    DB.discussions = (DB.discussions || []).filter(x => x.id !== d.id);
    if (API && API.deleteDiscussion) { try { API.deleteDiscussion(d.id); } catch (e) {} }
    renderTab();
  }

  async function exportReportUI() {
    const scopeOpts = ['Весь проект', 'Текущее помещение'];
    const fmtOpts = ['CSV (Excel)', 'HTML (печать → PDF)', 'PDF'];
    const v = await openForm('Экспорт отчёта по находкам', [
      { k: 'scope', label: 'Область', value: scopeOpts[0], type: 'select', options: scopeOpts },
      { k: 'format', label: 'Формат', value: fmtOpts[0], type: 'select', options: fmtOpts }
    ]);
    if (!v) return;
    const roomScope = v.scope === scopeOpts[1];
    if (roomScope && !current) { toast('Сначала выберите помещение'); return; }
    const scope = roomScope ? { type: 'room', roomId: current.id } : { type: 'project' };
    const format = v.format === fmtOpts[2] ? 'pdf' : (v.format === fmtOpts[1] ? 'html' : 'csv');
    if (API && API.exportReport) {
      const res = await API.exportReport(scope, format);
      if (res && res.ok) toast('Сохранено: ' + res.path); else if (!(res && res.canceled)) toast('Не удалось сохранить');
    } else {
      if (format === 'pdf') { toast('PDF — в десктоп-версии; выберите HTML и распечатайте в PDF'); return; }
      const out = buildReportClient(scope, format); downloadBlob(out.content, out.name, out.mime);
    }
  }
  function buildReportClient(scope, format) {
    const cols = [['room', 'Помещение'], ['element', 'Элемент'], ['kind', 'Замечание'], ['severity', 'Статус'], ['assignee', 'Ответственный'], ['text', 'Описание']];
    const rows = [];
    for (const r of DB.rooms) { if (scope.type === 'room' && r.id !== scope.roomId) continue; for (const f of (r.findings || [])) { const el = (r.elements || []).find(e => e.id === f.element_id); const who = USERS.find(u => u.id === f.assignee); rows.push({ room: r.name, element: el ? el.name : '', kind: f.kind, severity: STATUS_LABEL[f.severity] || f.severity, assignee: who ? who.name : '', text: f.text }); } }
    if (format === 'html') {
      const th = cols.map(c => '<th>' + esc(c[1]) + '</th>').join('');
      const tr = rows.map(r => '<tr>' + cols.map(c => '<td>' + esc(String(r[c[0]] || '')) + '</td>').join('') + '</tr>').join('');
      const html = '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Отчёт</title><style>body{font-family:Arial;margin:24px;color:#1f2733}h1{font-size:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d7dbe0;padding:6px 8px;font-size:13px;text-align:left}th{background:#f6f7f9}</style></head><body><h1>Отчёт по находкам</h1><table><thead><tr>' + th + '</tr></thead><tbody>' + tr + '</tbody></table></body></html>';
      return { content: html, name: 'otchet.html', mime: 'text/html' };
    }
    const q = s => { s = String(s == null ? '' : s); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const csv = '\uFEFF' + cols.map(c => q(c[1])).join(';') + '\r\n' + rows.map(r => cols.map(c => q(r[c[0]])).join(';')).join('\r\n');
    return { content: csv, name: 'otchet.csv', mime: 'text/csv' };
  }
  function downloadBlob(content, name, mime) {
    try { const blob = new Blob([content], { type: mime + ';charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Файл сформирован'); } catch (e) { toast('Не удалось сформировать файл'); }
  }

  async function syncUI() {
    if (!API || !API.exportSync) { toast('Синхронизация — в десктоп-версии'); return; }
    const opts = ['Экспорт для команды', 'Импорт и объединение'];
    const v = await openForm('Синхронизация команды', [{ k: 'act', label: 'Действие', value: opts[0], type: 'select', options: opts }]);
    if (!v) return;
    if (v.act === opts[0]) { const r = await API.exportSync(); if (r && r.ok) toast('Выгружено: ' + r.path); }
    else { const r = await API.importSync(true); if (r && r.ok) { await loadData(); await loadTeam(); current = null; selEl = null; renderTree(); if (DB.rooms.length) openRoom(DB.rooms[0].id); else renderTab(); toast('Импортировано и объединено'); } }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
