const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
// GPU: задействовать дискретную видеокарту (напр. RTX) на полную и снять блокировки WebGL
try {
  app.commandLine.appendSwitch('force_high_performance_gpu');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
} catch (e) { /* no-op */ }
const path = require('path');
const osNative = require('node:os');
const { pathToFileURL } = require('url');
const fs = require('fs');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { parseIFC, mapIfcType } = require('./db/ifcImport');
const parsers = require('./ai/parsers');
const ocrmod = require('./ai/ocr');
const verify = require('./ai/verify');
const llm = require('./ai/llm');
const report = require('./ai/report');
const cloud = require('./las-node');
const e57 = require('./renderer/e57-stations');
const { PTXStreamValidator } = require('./renderer/ptx-stream-validator');
const { atomicWriteFileSync, atomicWriteJsonSync } = require('./db/atomic-file');
const { CloudAutosaveStore } = require('./db/cloud-autosave');
const {
  assessOctreeBuildMemory,
  assessOctreeBuildDiskSpace,
  assessOutOfCoreOctreeMemory,
  assessOutOfCoreOctreeDiskSpace,
  formatMiB: formatResourceMiB
} = require('./octree-resource-budget');

let octreeCleanupOnQuit = function () {};

function currentAvailableMemoryBytes() {
  const candidates = [];
  try {
    if (typeof process.availableMemory === 'function') {
      const value = Number(process.availableMemory());
      if (Number.isFinite(value) && value >= 0) candidates.push(value);
    }
  } catch (_) {}
  try {
    const value = Number(osNative.freemem());
    if (Number.isFinite(value) && value >= 0) candidates.push(value);
  } catch (_) {}
  return candidates.length ? Math.min.apply(null, candidates) : null;
}

function currentAvailableDiskBytes(directory) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const stats = fs.statfsSync(directory);
    const freeBlocks = Number(stats && stats.bavail);
    const blockSize = Number(stats && stats.bsize);
    const bytes = freeBlocks * blockSize;
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
  } catch (_) {
    return null;
  }
}
// Белый список расширений для bim:readPicked — читаем только файлы моделей/облаков/документов, а не произвольные пути на диске.
const PICKED_EXT_ALLOW = new Set(['.glb', '.gltf', '.obj', '.stl', '.ply', '.las', '.laz', '.e57', '.ptx', '.ifc', '.pdf', '.xlsx', '.xls', '.csv', '.txt', '.docx', '.doc', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.dxf', '.dwg']);

// Разрешённые расширения облаков точек для bim:parseCloud (чтение с диска).
const CLOUD_EXT_ALLOW = new Set(['.las', '.laz', '.ply', '.e57', '.ptx', '.pcd', '.xyz', '.pts', '.txt', '.csv', '.xyzrgb']);

// Валидаторы входных данных IPC: отсекают некорректные/вредоносные аргументы до обращения к хранилищу.
function vId(x) { if (typeof x !== 'string' || !x) throw new Error('invalid id'); return x; }
function vStr(x) { if (typeof x !== 'string') throw new Error('invalid string'); return x; }
function vPatch(x) { if (x == null) return x; if (typeof x !== 'object' || Array.isArray(x)) throw new Error('invalid payload'); return x; }
function vArgs(x) { if (x == null || typeof x !== 'object' || Array.isArray(x)) throw new Error('invalid args'); return x; }

// Настройки: LLM-ключ на диске хранится зашифрованным (safeStorage). Помощники прозрачно шифруют при записи и расшифровывают при чтении.
function decryptSettings(s) {
  const out = Object.assign({}, s || {});
  try {
    const { safeStorage } = require('electron');
    if (out.llmApiKeyEnc && !out.llmApiKey && safeStorage.isEncryptionAvailable()) {
      out.llmApiKey = safeStorage.decryptString(Buffer.from(out.llmApiKeyEnc, 'base64'));
    }
  } catch (e) {}
  return out;
}
function readSettings() { return decryptSettings(store && store.getSettings ? store.getSettings() : {}); }
function encryptSettingsPatch(patch) {
  const p = Object.assign({}, patch || {});
  if (!Object.prototype.hasOwnProperty.call(p, 'llmApiKey')) return p;
  try {
    const { safeStorage } = require('electron');
    if (p.llmApiKey && safeStorage.isEncryptionAvailable()) {
      p.llmApiKeyEnc = safeStorage.encryptString(String(p.llmApiKey)).toString('base64');
      p.llmApiKey = '';
    } else if (!p.llmApiKey) {
      p.llmApiKeyEnc = '';
    }
  } catch (e) {}
  return p;
}

let store = null;
let MODE = 'json';

// ---- In-process DWG -> DXF conversion (GNU LibreDWG compiled to WASM) --------
// Runs in Electron's main process (full Node.js), so the library loads its own
// .wasm from node_modules with no bundler/locate gymnastics. Fully offline and
// needs no external CAD tools. Returns DXF text (string) or null.
let _libredwg = null;
async function getLibreDwg() {
  if (_libredwg) return _libredwg;
  const mod = await import('@mlightcad/libredwg-web');
  const LibreDwg = mod.LibreDwg || (mod.default && mod.default.LibreDwg);
  const Dwg_File_Type = mod.Dwg_File_Type || (mod.default && mod.default.Dwg_File_Type);
  const lib = await LibreDwg.create();
  _libredwg = { lib, Dwg_File_Type };
  return _libredwg;
}

function _num(v, d) { return typeof v === 'number' && isFinite(v) ? v : (d || 0); }
function _pt(p) {
  if (!p) return null;
  if (Array.isArray(p)) return { x: _num(p[0]), y: _num(p[1]) };
  if (typeof p === 'object') return { x: _num(p.x), y: _num(p.y) };
  return null;
}
// Build a minimal, universally-parseable R12 DXF (ENTITIES) from a libredwg-web
// DwgDatabase. Common geometry only; unknown entities are skipped gracefully.
function _dbToDxf(db) {
  const ents = (db && (db.entities || (db.modelSpace && db.modelSpace.entities))) || [];
  if (!ents.length) return null;
  const out = ['0', 'SECTION', '2', 'ENTITIES'];
  const put = (c, v) => { out.push(String(c), String(v)); };
  const layerOf = (e) => (e && (e.layer || e.layerName)) || '0';
  const line = (x1, y1, x2, y2, L) => { put(0, 'LINE'); put(8, L); put(10, x1); put(20, y1); put(11, x2); put(21, y2); };
  let count = 0;
  for (const e of ents) {
    try {
      const t = String(e.type || e.entityType || '').toUpperCase();
      const L = layerOf(e);
      if (t === 'LINE') {
        const a = _pt(e.startPoint || e.start || e.p1), b = _pt(e.endPoint || e.end || e.p2);
        if (a && b) { line(a.x, a.y, b.x, b.y, L); count++; }
      } else if (t === 'CIRCLE') {
        const c = _pt(e.center);
        if (c) { put(0, 'CIRCLE'); put(8, L); put(10, c.x); put(20, c.y); put(40, _num(e.radius, 1)); count++; }
      } else if (t === 'ARC') {
        const c = _pt(e.center);
        if (c) { put(0, 'ARC'); put(8, L); put(10, c.x); put(20, c.y); put(40, _num(e.radius, 1)); put(50, _num(e.startAngle)); put(51, _num(e.endAngle, 360)); count++; }
      } else if (t === 'LWPOLYLINE' || t === 'POLYLINE') {
        const vs = (e.vertices || e.points || []).map(_pt).filter(Boolean);
        if (vs.length >= 2) {
          for (let i = 0; i < vs.length - 1; i++) { line(vs[i].x, vs[i].y, vs[i + 1].x, vs[i + 1].y, L); count++; }
          const closed = e.closed || e.isClosed || (e.shape === true) || (_num(e.flag) & 1);
          if (closed && vs.length > 2) { line(vs[vs.length - 1].x, vs[vs.length - 1].y, vs[0].x, vs[0].y, L); count++; }
        }
      } else if (t === 'ELLIPSE') {
        const c = _pt(e.center), maj = _pt(e.majorAxisEndPoint || e.endPoint);
        if (c && maj) {
          const rx = Math.hypot(maj.x, maj.y), ratio = _num(e.axisRatio || e.ratio, 1), ry = rx * ratio, rot = Math.atan2(maj.y, maj.x), N = 48;
          let px = null, py = null;
          for (let i = 0; i <= N; i++) {
            const a = (i / N) * Math.PI * 2, ex = rx * Math.cos(a), ey = ry * Math.sin(a);
            const x = c.x + ex * Math.cos(rot) - ey * Math.sin(rot), y = c.y + ex * Math.sin(rot) + ey * Math.cos(rot);
            if (px !== null) { line(px, py, x, y, L); count++; }
            px = x; py = y;
          }
        }
      } else if (t === 'SPLINE') {
        const vs = (e.controlPoints || e.fitPoints || []).map(_pt).filter(Boolean);
        for (let i = 0; i < vs.length - 1; i++) { line(vs[i].x, vs[i].y, vs[i + 1].x, vs[i + 1].y, L); count++; }
      }
    } catch (_) { /* skip bad entity */ }
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return count ? out.join('\n') : null;
}
async function dwgToDxfNode(buf) {
  const { lib, Dwg_File_Type } = await getLibreDwg();
  const u8 = Uint8Array.from(buf);
  let dwg = null;
  try {
    dwg = lib.dwg_read_data(u8.buffer, Dwg_File_Type.DWG);
    const db = lib.convert(dwg);
    return _dbToDxf(db);
  } finally {
    try { if (dwg != null) lib.dwg_free(dwg); } catch (_) {}
  }
}

function initStore() {
  const dir = app.getPath('userData');
  try {
    const Database = require('better-sqlite3');
    const { SqliteStore } = require('./db/sqliteStore');
    store = new SqliteStore(dir, Database);
    MODE = 'sqlite';
  } catch (e) {
    console.warn('[store] SQLite недоступен, использую JSON:', e.message);
    const { JsonStore } = require('./db/jsonStore');
    store = new JsonStore(dir);
    MODE = 'json';
  }
}

function saveUpload(name, base64) {
  const safe = Date.now() + '_' + String(name || 'file').replace(/[^\w.\-а-яА-Я]+/gi, '_');
  const abs = path.join(store.uploadsDir, safe);
  fs.writeFileSync(abs, Buffer.from(base64, 'base64'));
  return { file: safe, abs };
}

// Копирование большого файла (3D-модель/облако точек) напрямую с диска — без base64, чтобы не перегружать память.
function saveUploadFromPath(name, srcPath) {
  const safe = Date.now() + '_' + String(name || 'file').replace(/[^\w.\-а-яА-Я]+/gi, '_');
  const abs = path.join(store.uploadsDir, safe);
  fs.copyFileSync(srcPath, abs);
  return { file: safe, abs };
}

function payloadBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value && value.buffer && Number.isFinite(value.byteLength)) return Buffer.from(value.buffer, value.byteOffset || 0, value.byteLength);
  return Buffer.from(value);
}
function sha256Buffer(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
function fsyncPath(filePath) {
  let fd;
  // Windows can reject fsync on a read-only handle with EPERM.
  try { fd = fs.openSync(filePath, 'r+'); fs.fsyncSync(fd); }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
}
function fsyncDirectory(dirPath) {
  let fd;
  try { fd = fs.openSync(dirPath, 'r'); fs.fsyncSync(fd); }
  catch (error) {
    // Directory fsync is unavailable on some Windows/network filesystems.
    if (!error || !['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EBADF', 'EACCES'].includes(error.code)) throw error;
  } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
}
function cloudHistoryDir(target) {
  const abs = path.resolve(target);
  const key = crypto.createHash('sha256').update(abs, 'utf8').digest('hex').slice(0, 24);
  return path.join(app.getPath('userData'), 'cloud-history', key);
}
function safeFilePart(p) {
  const name = path.basename(String(p || 'cloud').replace(/\\/g, '/')).normalize('NFC');
  return name.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').slice(0, 120) || 'cloud.bin';
}
function pruneCloudHistory(dir, keep) {
  try {
    const rows = fs.readdirSync(dir).filter(n => /^rev-.*\.bak$/i.test(n)).map(n => {
      const p = path.join(dir, n); return { path: p, mtime: fs.statSync(p).mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime);
    for (const row of rows.slice(Math.max(1, keep || 8))) try { fs.unlinkSync(row.path); } catch (_) {}
  } catch (_) {}
}
async function saveCloudOutput(target, data, options) {
  options = options || {};
  const abs = path.resolve(String(target || ''));
  if (!path.isAbsolute(abs) || !path.basename(abs)) throw new Error('invalid output path');
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const outputHash = sha256Buffer(bytes);
  let previousHash = null, backupPath = null;
  if (fs.existsSync(abs)) {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) throw new Error('output path is not a regular file');
    previousHash = await sha256File(abs);
    if (previousHash !== outputHash) {
      const dir = cloudHistoryDir(abs);
      fs.mkdirSync(dir, { recursive: true });
      const backupName = 'rev-' + Date.now() + '-' + previousHash.slice(0, 16) + '-' + safeFilePart(abs) + '.bak';
      backupPath = path.join(dir, backupName);
      try {
        fs.copyFileSync(abs, backupPath, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(backupPath, 0o600);
        fsyncPath(backupPath);
      } catch (e) {
        try { fs.unlinkSync(backupPath); } catch (_) {}
        throw new Error('Не удалось сохранить предыдущую версию файла; исходник оставлен без изменений: ' + String(e && e.message || e));
      }
      pruneCloudHistory(dir, 8);
    }
  }
  atomicWriteFileSync(abs, bytes, { mode: 0o600 });
  if (store && store.recordOperation) {
    try {
      const activeId = store.getData && store.getData().project && store.getData().project.id;
      store.recordOperation({
        operation: options.operation || 'cloud.file.save',
        inputHash: options.inputHash || previousHash || null,
        parameters: { format: options.format || path.extname(abs).slice(1).toLowerCase(), fileName: safeFilePart(abs), overwrite: !!previousHash },
        output: { fileName: safeFilePart(abs), sha256: outputHash, bytes: bytes.length, backupCreated: !!backupPath },
        warnings: options.warnings || [],
        appVersion: (() => { try { return app.getVersion(); } catch (_) { return 'unknown'; } })()
      }, activeId);
    } catch (e) { console.warn('[project-journal] cloud save log failed:', e && e.message || e); }
  }
  return { path: abs, bytes: bytes.length, sha256: outputHash, inputHash: previousHash, backupPath };
}

// Commit a same-directory streamed export without materializing the whole
// output in main-process memory. The temporary is created exclusively by the
// export session and is renamed only after the stream has been fsynced.
async function saveCloudOutputFromTemp(target, tempPath, options) {
  options = options || {};
  const abs = path.resolve(String(target || ''));
  const temp = path.resolve(String(tempPath || ''));
  if (!path.isAbsolute(abs) || !path.basename(abs) || !path.isAbsolute(temp) ||
      path.dirname(abs) !== path.dirname(temp) || abs === temp) {
    throw new Error('invalid streamed output path');
  }
  const st = fs.statSync(temp);
  if (!st.isFile()) throw new Error('streamed output is not a regular file');
  const bytes = st.size;
  fsyncPath(temp);
  const outputHash = await sha256File(temp);
  let previousHash = null, backupPath = null;
  if (fs.existsSync(abs)) {
    const targetStat = fs.statSync(abs);
    if (!targetStat.isFile()) throw new Error('output path is not a regular file');
    previousHash = await sha256File(abs);
    if (previousHash !== outputHash) {
      const dir = cloudHistoryDir(abs);
      fs.mkdirSync(dir, { recursive: true });
      const backupName = 'rev-' + Date.now() + '-' + previousHash.slice(0, 16) + '-' + safeFilePart(abs) + '.bak';
      backupPath = path.join(dir, backupName);
      try {
        fs.copyFileSync(abs, backupPath, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(backupPath, 0o600);
        fsyncPath(backupPath);
      } catch (e) {
        try { fs.unlinkSync(backupPath); } catch (_) {}
        throw new Error('Не удалось сохранить предыдущую версию файла; исходник оставлен без изменений: ' + String(e && e.message || e));
      }
      pruneCloudHistory(dir, 8);
    }
  }
  const durabilityWarnings = [];
  try {
    if (previousHash === outputHash) {
      fs.unlinkSync(temp);
      return { path: abs, bytes, sha256: outputHash, inputHash: previousHash, backupPath: null, noOp: true, warnings: durabilityWarnings };
    }
    fs.renameSync(temp, abs);
    try { fsyncPath(abs); } catch (error) { durabilityWarnings.push('Файл сохранён, но fsync файла не подтверждён: ' + String(error && error.message || error)); }
    try { fsyncDirectory(path.dirname(abs)); } catch (error) { durabilityWarnings.push('Файл сохранён, но fsync каталога не подтверждён: ' + String(error && error.message || error)); }
  } catch (e) {
    throw new Error('Не удалось атомарно завершить потоковый экспорт; временный результат сохранён: ' + String(e && e.message || e));
  }
  if (store && store.recordOperation) {
    try {
      const activeId = store.getData && store.getData().project && store.getData().project.id;
      store.recordOperation({
        operation: options.operation || 'project.export',
        inputHash: options.inputHash || previousHash || null,
        parameters: { format: options.format || path.extname(abs).slice(1).toLowerCase(), fileName: safeFilePart(abs), overwrite: !!previousHash, streaming: true },
        output: { fileName: safeFilePart(abs), sha256: outputHash, bytes, backupCreated: !!backupPath },
        warnings: (options.warnings || []).concat(durabilityWarnings),
        appVersion: (() => { try { return app.getVersion(); } catch (_) { return 'unknown'; } })()
      }, activeId);
    } catch (e) { console.warn('[project-journal] streamed export log failed:', e && e.message || e); }
  }
  return { path: abs, bytes, sha256: outputHash, inputHash: previousHash, backupPath, warnings: durabilityWarnings };
}

function linkIFC(parsed, targetRoomId) {
  const data = store.getData();
  const byGuid = new Map();
  for (const r of (data.rooms || [])) for (const el of (r.elements || [])) if (el.ifc_guid) byGuid.set(el.ifc_guid, { el, r });
  const matched = [], created = [];

  const hasHierarchy = parsed.storeys && parsed.storeys.length && parsed.spaces && parsed.spaces.length;
  if (!targetRoomId && hasHierarchy) {
    // Строим этажи из IfcBuildingStorey и помещения из IfcSpace, затем раскладываем элементы по контейнерам.
    const floorByStorey = new Map();   // id этажа IFC -> запись этажа
    const roomBySpace = new Map();     // id пространства IFC -> запись помещения
    const findFloor = (nm) => (store.getData().floors || []).find(f => (f.name || '') === nm);
    (parsed.storeys || []).forEach((s, i) => {
      const nm = s.name || ('Этаж ' + (i + 1));
      let f = findFloor(nm);
      if (!f) { f = store.createFloor({ name: nm }); created.push({ floor: nm }); }
      floorByStorey.set(s.id, f);
    });
    const defaultFloor = (parsed.storeys[0] && floorByStorey.get(parsed.storeys[0].id)) || store.createFloor({ name: parsed.project || 'IFC' });
    (parsed.spaces || []).forEach((sp) => {
      const floor = (sp.storeyId && floorByStorey.get(sp.storeyId)) || defaultFloor;
      const nm = sp.name || sp.longName || 'Помещение';
      const existing = (store.getData().rooms || []).find(r => r.floor_id === floor.id && (r.name || '') === nm);
      const room = existing || store.createRoom(floor.id, { name: nm, number: sp.name || '' });
      if (!existing) created.push({ room: nm });
      roomBySpace.set(sp.id, room);
    });
    // представительное помещение на этаж — для элементов, привязанных прямо к этажу
    const roomByStorey = new Map();
    (parsed.spaces || []).forEach(sp => { if (sp.storeyId && !roomByStorey.has(sp.storeyId)) roomByStorey.set(sp.storeyId, roomBySpace.get(sp.id)); });
    let fallbackRoom = null;
    const ensureFallback = () => {
      if (fallbackRoom) return fallbackRoom;
      const nm = 'Без помещения';
      fallbackRoom = (store.getData().rooms || []).find(r => r.floor_id === defaultFloor.id && r.name === nm) || store.createRoom(defaultFloor.id, { name: nm });
      return fallbackRoom;
    };
    for (const it of (parsed.elements || [])) {
      if (it.guid && byGuid.has(it.guid)) { const hit = byGuid.get(it.guid); matched.push({ name: hit.el.name, room: hit.r.name }); continue; }
      let room = null;
      if (it.containerId && roomBySpace.has(it.containerId)) room = roomBySpace.get(it.containerId);
      else if (it.containerId && floorByStorey.has(it.containerId)) room = roomByStorey.get(it.containerId) || ensureFallback();
      if (!room) room = ensureFallback();
      const el = store.createElement(room.id, { name: it.name || it.ifcType, type: mapIfcType(it.ifcType), ifc_guid: it.guid, ai_status: 'none' });
      created.push({ name: el.name, room: room.name });
    }
    return { project: parsed.project, storeys: (parsed.storeys || []).map(s => s.name), spaces: (parsed.spaces || []).map(s => s.name || s.longName || ''), matched, created };
  }

  // Легаси-путь: одно целевое/первое помещение.
  let room = null;
  if (targetRoomId) room = (data.rooms || []).find(r => r.id === targetRoomId);
  if (!room) room = (data.rooms || [])[0];
  for (const it of parsed.elements) {
    const hit = it.guid && byGuid.get(it.guid);
    if (hit) { matched.push({ name: hit.el.name, room: hit.r.name }); }
    else if (room) {
      const el = store.createElement(room.id, { name: it.name || it.ifcType, type: mapIfcType(it.ifcType), ifc_guid: it.guid, ai_status: 'none' });
      created.push({ name: el.name, room: room.name });
    }
  }
  return { project: parsed.project, storeys: (parsed.storeys || []).map(s => s.name), spaces: (parsed.spaces || []).map(s => s.name || s.longName || ''), matched, created };
}

function loadIntent() {
  const candidates = [path.join(__dirname, 'ai', 'design_intent.json'), path.join(__dirname, 'ai', 'samples', 'design_intent.json')];
  for (const p of candidates) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { /* next */ } }
  return {};
}

// Извлечение текста/OCR в отдельном потоке (worker_threads), чтобы не блокировать main-процесс.
function runDocWorker(absPath, name, settings) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const w = new Worker(path.join(__dirname, 'ai', 'docWorker.js'), {
        workerData: { absPath, name, ocrCmd: settings && settings.ocrCmd, ocrLang: settings && settings.ocrLang }
      });
      w.once('message', (msg) => { finish(msg); w.terminate(); });
      w.once('error', (e) => finish({ ok: false, error: (e && e.message) || String(e) }));
      w.once('exit', (code) => { if (code !== 0) finish({ ok: false, error: 'worker_exit_' + code }); });
    } catch (e) { finish({ ok: false, error: (e && e.message) || String(e) }); }
  });
}

// Разбор IFC в отдельном потоке (worker_threads), чтобы большие модели не подвешивали main-процесс.
function runIfcWorker(text) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const w = new Worker(path.join(__dirname, 'db', 'ifcWorker.js'), { workerData: { text } });
      w.once('message', (msg) => { finish(msg); w.terminate(); });
      w.once('error', (e) => finish({ ok: false, error: (e && e.message) || String(e) }));
      w.once('exit', (code) => { if (code !== 0) finish({ ok: false, error: 'worker_exit_' + code }); });
    } catch (e) { finish({ ok: false, error: (e && e.message) || String(e) }); }
  });
}

async function analyzeRoom(roomId) {
  const data = store.getData();
  const room = (data.rooms || []).find(r => r.id === roomId);
  if (!room) return { ok: false, error: 'room_not_found' };
  const settings = readSettings();
  const docTexts = [];
  const report = [];
  for (const d of (room.documents || [])) {
    if (!d.file) { report.push({ name: d.name, kind: d.type || 'документ', ok: false, note: 'нет файла' }); continue; }
    const abs = path.isAbsolute(d.file) ? d.file : path.join(store.uploadsDir, d.file);
    if (!fs.existsSync(abs)) { report.push({ name: d.name, kind: 'файл', ok: false, note: 'файл не найден' }); continue; }
    const wres = await runDocWorker(abs, d.name || d.file, settings);
    if (!wres.ok) { report.push({ name: d.name, kind: 'файл', ok: false, note: 'ошибка обработки' }); continue; }
    const ext = wres.ext;
    if (wres.ocrInfo) report.push({ name: d.name, kind: 'скан', ok: ext.ok, ocr: wres.ocrInfo.ocr });
    else report.push({ name: d.name, kind: ext.kind, ok: ext.ok, chars: (ext.text || '').length });
    docTexts.push({ id: d.id, type: d.type, name: d.name, element_id: d.element_id || null, text: ext.text || '' });
  }
  const intent = loadIntent();
  const findings = verify.verifyRoom(room, docTexts, intent);
  // preserve prior review state / comments by element_id + kind
  const prior = room.findings || [];
  for (const f of findings) {
    const p = prior.find(x => x.element_id === f.element_id && x.kind === f.kind);
    if (p) { f.review = p.review || 'open'; f.comments = p.comments || []; f.assignee = p.assignee || null; f.due = p.due || null; if (p.id) f.id = p.id; }
  }
  // Optional LLM escalation for ambiguous (warn/open) findings
  let llmUsed = 0;
  const llmOn = llm.llmAvailable(settings);
  if (llmOn) {
    const joined = docTexts.map(d => d.text).join('\n');
    for (const f of findings) {
      if (f.severity !== 'warn' || f.review !== 'open') continue;
      const el = (room.elements || []).find(e => e.id === f.element_id) || { id: f.element_id };
      const res = await llm.verifyLLM(el, joined, settings);
      if (res && res.severity) { f.severity = res.severity; f.text = res.text || f.text; f.kind = res.kind || f.kind; if (res.confidence != null) f.confidence = res.confidence; f.source = 'llm'; llmUsed++; }
    }
  }
  store.setRoomFindings(roomId, findings);
  const counts = { err: 0, warn: 0, ok: 0 };
  for (const f of findings) if (counts[f.severity] != null) counts[f.severity]++;
  return { ok: true, roomId, counts, total: findings.length, documents: report, ocrAvailable: ocrmod.ocrAvailable(settings.ocrCmd), llmConfigured: llmOn, llmUsed };
}

async function analyzeAllRooms() {
  const data = store.getData();
  const results = [];
  for (const r of (data.rooms || [])) {
    let rep; try { rep = await analyzeRoom(r.id); } catch (e) { rep = { ok: false }; }
    results.push({ roomId: r.id, name: r.name, number: r.number || '', counts: (rep && rep.counts) || { err: 0, warn: 0, ok: 0 }, total: (rep && rep.total) || 0 });
  }
  return { ok: true, results };
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1600, height: 1000,
    minWidth: 1024, minHeight: 680,   // окно нельзя уменьшить до поломки раскладки
    backgroundColor: '#1e2126',   // тёмный фон с первого кадра (без белой вспышки)
    darkTheme: true,              // тёмные системные меню/диалоги
    // Полностью своя рамка: на Win/Linux убираем системную (frame:false),
    // кнопки окна рисует тайтлбар приложения; на macOS — системные «светофоры».
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, webgl: true }
  });
  if (!isMac) win.maximize();
  // v1208.2: clear stale renderer cache before loading the UI hotfix.
  win.webContents.session.clearCache().catch(() => {}).finally(() => {
    win.loadFile(path.join(__dirname, 'renderer', 'startup.html'));
  });
  win.webContents.on('did-finish-load', () => {
    try { win.webContents.setZoomFactor(1); } catch (_) {}
  });
  // Безопасность: запрещаем открытие новых окон и внешнюю навигацию внутри окна приложения.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const clean = String(url || '').split(/[?#]/)[0];
    const allowedLocal = [
      pathToFileURL(path.join(__dirname, 'renderer', 'startup.html')).href,
      pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href
    ].includes(clean);
    // Allow only the intentional startup -> workspace transition. Previously
    // this blanket guard silently cancelled location.replace(), making every
    // startup-menu button look unresponsive.
    if (url === win.webContents.getURL() || allowedLocal) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  // v1156 — при закрытии окна с несохранёнными правками облака спрашиваем: сохранить/не сохранять/отмена.
  win.on('close', (e) => {
    if (win.__allowClose || (!win.__bimDirty && !win.__bimProjectDirty)) return;
    e.preventDefault();
    let choice = 1;
    try {
      choice = dialog.showMessageBoxSync(win, {
        type: 'warning', buttons: ['\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c', '\u041d\u0435 \u0441\u043e\u0445\u0440\u0430\u043d\u044f\u0442\u044c', '\u041e\u0442\u043c\u0435\u043d\u0430'],
        defaultId: 0, cancelId: 2, noLink: true,
        title: '\u041d\u0435\u0441\u043e\u0445\u0440\u0430\u043d\u0451\u043d\u043d\u044b\u0435 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f',
        message: '\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f \u043f\u0435\u0440\u0435\u0434 \u0437\u0430\u043a\u0440\u044b\u0442\u0438\u0435\u043c?',
        detail: '\u0412 \u043f\u0440\u043e\u0435\u043a\u0442\u0435 \u0438\u043b\u0438 \u043e\u0431\u043b\u0430\u043a\u0435 \u0442\u043e\u0447\u0435\u043a \u0435\u0441\u0442\u044c \u043d\u0435\u0441\u043e\u0445\u0440\u0430\u043d\u0451\u043d\u043d\u044b\u0435 \u043f\u0440\u0430\u0432\u043a\u0438.'
      });
    } catch (_) { choice = 1; }
    if (choice === 2) return;                              // Отмена — окно остаётся
    if (choice === 1) { win.__allowClose = true; win.destroy(); return; } // Не сохранять
    try { win.webContents.send('bim:doSaveThenClose'); } catch (_) { win.__allowClose = true; win.destroy(); } // Сохранить
  });
}

app.whenReady().then(() => {
  initStore();
  registerIpc();
  createWindow();
  setupAutoUpdate();
  // v1162 — Scan2BIM AI сервер поднимается автоматически вместе с приложением.
  try {
    const s2b = require('./scan2bim-server');
    s2b.start();
    ipcMain.handle('bim:s2bStatus', () => { try { return s2b.status(); } catch (e) { return { running: false, error: String(e && e.message || e) }; } });
    ipcMain.handle('bim:s2bRestart', () => { try { s2b.stop(); return s2b.start(); } catch (e) { return { running: false, error: String(e && e.message || e) }; } });
    // Явная установка опционального AI/GPU-стека (по кнопке). Режим 1:1 его НЕ требует.
    ipcMain.handle('bim:s2bInstall', () => { try { return s2b.install(); } catch (e) { return { running: false, error: String(e && e.message || e) }; } });
  } catch (e) { console.error('[scan2bim] auto-start failed', e); }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  try { octreeCleanupOnQuit(); } catch (e) {}
  try { require('./scan2bim-server').stop(); } catch (e) {}
});

// --- path safety (защита от чтения произвольных путей из renderer) ---
function _resolveWithin(baseDir, p) {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(baseDir, p);
  const rel = path.relative(baseDir, abs);
  const within = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  return { abs, within };
}
function _isRegisteredFile(abs) {
  try {
    const data = store.getData();
    const norm = (f) => path.isAbsolute(f) ? path.resolve(f) : path.resolve(store.uploadsDir, f);
    for (const r of (data.rooms || [])) {
      if (r.model && r.model.file && norm(r.model.file) === abs) return true;
      for (const d of (r.documents || [])) {
        if (d.file && norm(d.file) === abs) return true;
        for (const v of (d.versions || [])) if (v && v.file && norm(v.file) === abs) return true;
      }
    }
  } catch (e) { /* ignore */ }
  return false;
}
// Возвращает абсолютный путь только если он внутри uploads или зарегистрирован в хранилище.
function safeReadPath(p) {
  if (p == null) return null;
  const { abs, within } = _resolveWithin(store.uploadsDir, String(p));
  if (within || _isRegisteredFile(abs)) return abs;
  return null;
}

function registerIpc() {
  const activeCloudParseJobs = new Map();
  const activeOctreeBuildJobs = new Map();
  const activeExportStreams = new Map();
  const MAX_EXPORT_STREAMS_PER_SENDER = 1;
  const MAX_EXPORT_STREAM_BYTES = 16 * 1024 * 1024 * 1024;
  const MAX_EXPORT_CHUNK_CHARS = 4 * 1024 * 1024;
  function cloudJobKey(sender, jobId) {
    return String(sender && sender.id != null ? sender.id : 'unknown') + ':' + jobId;
  }
  function exportStreamFor(event, payload) {
    const id = typeof payload === 'string' ? payload : payload && payload.streamId;
    if (typeof id !== 'string' || !/^[a-f0-9]{48}$/.test(id)) return null;
    const session = activeExportStreams.get(id);
    return session && session.sender === (event && event.sender) ? session : null;
  }
  function waitForWriteStreamClose(stream) {
    if (!stream || stream.closed) return Promise.resolve();
    return new Promise(resolve => stream.once('close', resolve));
  }
  function removeExportStream(session, keepTemp) {
    if (!session) return Promise.resolve();
    if (session.cleanupPromise) return session.cleanupPromise;
    session.cleanupPromise = (async () => {
      session.cleaned = true;
      if (session.state !== 'committing' && session.state !== 'committed') session.state = 'cancelled';
      try { if (session.sender && session.onSenderDestroyed) session.sender.removeListener('destroyed', session.onSenderDestroyed); } catch (_) {}
      const writer = session.writer;
      if (writer && !writer.closed) {
        const closed = waitForWriteStreamClose(writer);
        try { if (!writer.destroyed) writer.destroy(); } catch (_) {}
        await closed;
      }
      if (!keepTemp) try { fs.unlinkSync(session.tempPath); } catch (error) { if (!error || error.code !== 'ENOENT') console.warn('[export-stream] temp cleanup failed:', error && error.message || error); }
      activeExportStreams.delete(session.id);
    })();
    return session.cleanupPromise;
  }
  // Streamed PTX is the first bounded-memory export path. It is intentionally
  // restricted to PTX; renderer never supplies a destination path, and every
  // token is tied to the WebContents that opened the native save dialog.
  ipcMain.handle('bim:beginExportStream', async (event, payload) => {
    let session = null;
    try {
      const sender = event && event.sender;
      if (!sender || (sender.isDestroyed && sender.isDestroyed())) return { ok: false, error: 'invalid_sender' };
      const ext = String(payload && payload.ext || '').replace(/^\./, '').toLowerCase();
      if (ext !== 'ptx') return { ok: false, error: 'stream_format_not_supported' };
      const expectedPoints = Number(payload && payload.expectedPoints);
      if (!Number.isSafeInteger(expectedPoints) || expectedPoints < 1 || expectedPoints > 2147483647) return { ok: false, error: 'invalid_point_count' };
      const activeForSender = Array.from(activeExportStreams.values()).filter(item => item.sender === sender && !item.cleaned).length;
      if (activeForSender >= MAX_EXPORT_STREAMS_PER_SENDER) return { ok: false, error: 'export_busy' };

      const requestedName = safeFilePart(payload && payload.name || 'pointcloud.ptx');
      const defaultPath = path.extname(requestedName).toLowerCase() === '.ptx' ? requestedName : requestedName + '.ptx';
      const options = {
        title: String(payload && payload.title || 'Экспорт · PTX').slice(0, 120),
        defaultPath,
        filters: [{ name: 'PTX', extensions: ['ptx'] }]
      };
      let owner = null;
      try { owner = BrowserWindow.fromWebContents(sender); } catch (_) {}
      const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
      if (!result || result.canceled || !result.filePath) return { ok: false, canceled: true };

      let target = path.resolve(String(result.filePath));
      if (path.extname(target).toLowerCase() !== '.ptx') target += '.ptx';
      const directory = path.dirname(target);
      const dirStat = fs.statSync(directory);
      if (!dirStat.isDirectory()) return { ok: false, error: 'output_directory_not_found' };
      if (fs.existsSync(target) && !fs.statSync(target).isFile()) return { ok: false, error: 'output_path_not_file' };

      const id = crypto.randomBytes(24).toString('hex');
      const tempName = '.' + path.basename(target).slice(0, 72) + '.bimtwin-' + id + '.tmp';
      const tempPath = path.join(directory, tempName);
      session = {
        id, sender, target, tempPath, expectedPoints,
        validator: new PTXStreamValidator(expectedPoints),
        writer: null, state: 'opening', bytes: 0,
        writeChain: Promise.resolve(), error: null, cleaned: false
      };
      session.onSenderDestroyed = () => {
        if (session.state !== 'committing' && session.state !== 'committed') {
          removeExportStream(session, false).catch(error => console.warn('[export-stream] sender cleanup failed:', error && error.message || error));
        }
      };
      activeExportStreams.set(id, session);
      try { sender.on('destroyed', session.onSenderDestroyed); } catch (_) {}

      session.writer = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600, highWaterMark: 512 * 1024 });
      const opened = new Promise((resolve, reject) => {
        session.openResolve = resolve;
        session.openReject = reject;
      });
      session.writer.on('error', error => {
        session.error = error;
        if (session.openReject) {
          const reject = session.openReject;
          session.openResolve = null;
          session.openReject = null;
          reject(error);
        }
      });
      session.writer.once('open', () => {
        if (session.openResolve) session.openResolve();
        session.openResolve = null;
        session.openReject = null;
      });
      await opened;
      if (session.cleaned || session.error || (sender.isDestroyed && sender.isDestroyed())) {
        await removeExportStream(session, false);
        return { ok: false, canceled: true };
      }
      session.state = 'writing';
      return { ok: true, streamId: id, fileName: path.basename(target), expectedPoints };
    } catch (error) {
      if (session) await removeExportStream(session, false);
      return { ok: false, error: String(error && error.message || error) };
    }
  });

  ipcMain.handle('bim:writeExportStreamChunk', async (event, payload) => {
    const session = exportStreamFor(event, payload);
    if (!session) return { ok: false, error: 'invalid_or_expired_stream' };
    const text = payload && payload.text;
    if (session.state !== 'writing' || typeof text !== 'string' || !text.length || text.length > MAX_EXPORT_CHUNK_CHARS) {
      await removeExportStream(session, false);
      return { ok: false, error: 'invalid_stream_chunk' };
    }
    const operation = session.writeChain.then(async () => {
      if (session.cleaned || session.error || !['writing', 'finishing'].includes(session.state)) throw session.error || new Error('export stream was cancelled');
      const validated = session.validator.push(text);
      const bytes = Buffer.from(text, 'ascii');
      if (session.bytes + bytes.length > MAX_EXPORT_STREAM_BYTES) throw new Error('PTX export exceeds 16 GiB safety limit');
      await new Promise((resolve, reject) => {
        try { session.writer.write(bytes, error => error ? reject(error) : resolve()); }
        catch (error) { reject(error); }
      });
      session.bytes += bytes.length;
      return { ok: true, bytes: session.bytes, points: validated.points, expectedPoints: session.expectedPoints };
    });
    session.writeChain = operation.catch(error => { session.error = error; });
    try { return await operation; }
    catch (error) {
      await removeExportStream(session, false);
      return { ok: false, error: String(error && error.message || error) };
    }
  });

  ipcMain.handle('bim:finishExportStream', async (event, payload) => {
    const session = exportStreamFor(event, payload);
    if (!session) return { ok: false, error: 'invalid_or_expired_stream' };
    if (session.state !== 'writing') return { ok: false, error: 'stream_not_writable' };
    session.state = 'finishing';
    try {
      await session.writeChain;
      if (session.cleaned || session.error) throw session.error || new Error('export stream was cancelled');
      const validated = session.validator.finish();
      if (validated.bytes !== session.bytes || validated.points !== session.expectedPoints) throw new Error('PTX stream integrity check failed');
      await new Promise((resolve, reject) => {
        session.writer.once('error', reject);
        session.writer.once('finish', resolve);
        session.writer.end();
      });
      await waitForWriteStreamClose(session.writer);
      if (session.error) throw session.error;

      session.state = 'committing';
      const saved = await saveCloudOutputFromTemp(session.target, session.tempPath, {
        operation: 'pointcloud.export.stream',
        format: 'ptx'
      });
      session.state = 'committed';
      await removeExportStream(session, false);
      return {
        ok: true, path: saved.path, sha256: saved.sha256, bytes: saved.bytes,
        backupPath: saved.backupPath, noOp: !!saved.noOp,
        warnings: saved.warnings || []
      };
    } catch (error) {
      const preserve = session.state === 'committing' && fs.existsSync(session.tempPath);
      const recoveryPath = preserve ? session.tempPath : null;
      await removeExportStream(session, preserve);
      return { ok: false, error: String(error && error.message || error), recoveryPath };
    }
  });

  ipcMain.handle('bim:cancelExportStream', async (event, payload) => {
    const session = exportStreamFor(event, payload);
    if (!session) return { ok: true, alreadyClosed: true };
    if (session.state === 'committing' || session.state === 'committed') return { ok: false, error: 'stream_already_committing' };
    await removeExportStream(session, false);
    return { ok: true, cancelled: true };
  });

  ipcMain.on('bim:cancelCloudParse', (event, payload) => {
    const jobId = typeof payload === 'string' ? payload : payload && payload.jobId;
    if (typeof jobId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(jobId)) return;
    const job = activeCloudParseJobs.get(cloudJobKey(event && event.sender, jobId));
    if (job) {
      try { job.controller.abort(); } catch (_) {}
    }
  });
  ipcMain.on('bim:cancelOctreeBuild', (event, payload) => {
    const jobId = typeof payload === 'string' ? payload : payload && payload.jobId;
    if (typeof jobId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(jobId)) return;
    const job = activeOctreeBuildJobs.get(cloudJobKey(event && event.sender, 'octree:' + jobId));
    if (!job || job.finished || job.cancelled) return;
    job.cancelled = true;
    try { job.worker.terminate().catch(() => {}); } catch (_) {}
  });

  let autosaveStore;
  try {
    let userData;
    try { userData = app.getPath('userData'); } catch (_) { userData = require('os').tmpdir(); }
    autosaveStore = new CloudAutosaveStore({
      root: path.join(userData, 'autosave-clouds'),
      getAppVersion: () => { try { return app.getVersion(); } catch (_) { return 'unknown'; } },
      getSourceHash: async sourcePath => {
        const abs = String(sourcePath || '');
        if (!path.isAbsolute(abs) || !CLOUD_EXT_ALLOW.has(path.extname(abs).toLowerCase())) return null;
        try {
          if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
          return await sha256File(abs);
        } catch (_) { return null; }
      },
      recordOperation: (draft, projectId) => {
        if (!store || !store.recordOperation) throw new Error('project operation journal is unavailable');
        const id = projectId || (store.getData && store.getData().project && store.getData().project.id);
        return store.recordOperation(draft, id);
      }
    });
  } catch (error) {
    console.error('[autosave] storage initialization failed:', error && error.message || error);
  }

  ipcMain.handle('bim:getData', () => store.getData());
  ipcMain.handle('bim:getMode', () => MODE);

  ipcMain.handle('bim:readFile', (_e, p) => {
    const abs = safeReadPath(p);
    if (!abs || !fs.existsSync(abs)) return null;
    return fs.readFileSync(abs).toString('base64');
  });
  // Чтение файла, который пользователь сам выбрал/перетащил (3D-модели и облака точек могут лежать где угодно и быть очень большими).
  ipcMain.handle('bim:readPicked', (_e, p) => {
    try {
      const abs = String(p || '');
      if (!abs || !fs.existsSync(abs)) return { ok: false, error: 'not_found' };
      const st = fs.statSync(abs);
      if (!st || !st.isFile()) return { ok: false, error: 'not_file' };
      if (!PICKED_EXT_ALLOW.has(path.extname(abs).toLowerCase())) return { ok: false, error: 'ext_not_allowed' };
      return { ok: true, base64: fs.readFileSync(abs).toString('base64'), size: st.size };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  // Parse in a dedicated worker so long scans do not block project saves or
  // window controls; progress and cancellation are scoped to the initiating
  // WebContents and job id.
  ipcMain.handle('bim:parseCloud', async (event, payload) => {
    const abs = String(payload && typeof payload === 'object' ? payload.path || '' : payload || '');
    const jobId = payload && typeof payload === 'object' ? payload.jobId : null;
    try {
      if (!CLOUD_EXT_ALLOW.has(path.extname(abs).toLowerCase())) return { ok: false, message: 'ext_not_allowed' };
      if (jobId != null && (typeof jobId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(jobId))) return { ok: false, message: 'invalid_job_id' };
      const s = readSettings();
      const maxPoints = Number(s && s.pointBudget) > 0 ? Number(s.pointBudget) : undefined;
      const controller = new AbortController();
      const key = jobId ? cloudJobKey(event && event.sender, jobId) : null;
      if (key && activeCloudParseJobs.has(key)) return { ok: false, message: 'duplicate_job_id' };
      const sender = event && event.sender;
      const job = { controller, senderId: sender && sender.id };
      if (key) activeCloudParseJobs.set(key, job);
      const onDestroyed = () => { try { controller.abort(); } catch (_) {} };
      if (sender && typeof sender.once === 'function') sender.once('destroyed', onDestroyed);
      const onProgress = (progress) => {
        if (!jobId || controller.signal.aborted || !sender || typeof sender.send !== 'function') return;
        try {
          if (typeof sender.isDestroyed !== 'function' || !sender.isDestroyed()) {
            sender.send('bim:parseCloudProgress', { jobId, progress });
          }
        } catch (_) {}
      };
      try {
        const result = await cloud.parseCloudFileAsync(abs, { maxPoints, signal: controller.signal, onProgress });
        if (result && result.ok) onProgress({ phase: 'done', fraction: 1, pointsLoaded: result.count || (result.pos && result.pos.length / 3) || 0 });
        return result;
      } finally {
        if (key) activeCloudParseJobs.delete(key);
        if (sender && typeof sender.removeListener === 'function') {
          try { sender.removeListener('destroyed', onDestroyed); } catch (_) {}
        }
      }
    }
    catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
  });
  // In-app document reader: returns file bytes (images/pdf/svg) and/or extracted text/table for preview.
  // Covers the widest set of formats used in construction/BIM; binary CAD (dwg/rvt) fall back to external open.
  ipcMain.handle('bim:readDocument', async (_e, docId) => {
    try {
      const data = store.getData();
      let doc = null;
      for (const r of (data.rooms || [])) { const d = (r.documents || []).find(x => x.id === docId); if (d) { doc = d; break; } }
      if (!doc) return { ok: false, error: 'not_found' };
      if (!doc.file) return { ok: false, error: 'no_file', name: doc.name };
      const abs = path.isAbsolute(doc.file) ? doc.file : path.join(store.uploadsDir, doc.file);
      if (!fs.existsSync(abs)) return { ok: false, error: 'missing', name: doc.name };
      const buf = fs.readFileSync(abs);
      const ext = (String(doc.name || doc.file).split('.').pop() || '').toLowerCase();
      const IMG = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'ico', 'avif'];
      const isSvg = ext === 'svg';
      const isImage = IMG.includes(ext);
      const isPdf = ext === 'pdf';
      const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml', pdf: 'application/pdf' };
      const mime = doc.mime || mimeMap[ext] || 'application/octet-stream';
      const res = { ok: true, id: doc.id, name: doc.name, file: doc.file, ext, mime, size: buf.length, isImage: isImage || isSvg, isPdf, isSvg };
      if (isImage || isSvg || isPdf) res.base64 = buf.toString('base64');
      if (ext === 'docx' || ext === 'dwg') res.base64 = buf.toString('base64');
      if (isPdf) {
        // Текст PDF извлекаем в worker-потоке с бюджетом времени, чтобы большие
        // чертежи открывались сразу и не подвешивали окно (base64 уже готов для просмотра).
        res.kind = 'pdf';
        try {
          const wres = await Promise.race([
            runDocWorker(abs, doc.name || doc.file, {}),
            new Promise(r => setTimeout(() => r({ ok: false, timeout: true }), 12000)),
          ]);
          if (wres && wres.ok && wres.ext) { res.text = wres.ext.text || ''; res.textOk = !!res.text; res.textTruncated = !!wres.ext.truncated; }
          else { res.text = ''; res.textOk = false; if (wres && wres.timeout) res.textTruncated = true; }
        } catch (e) { res.text = ''; res.parseError = String((e && e.message) || e); }
        return res;
      }
      if (!isImage && !isSvg) {
        let text = '';
        try {
          if (ext === 'docx') {
            const z = parsers.readZipEntries(buf);
            const xml = z['word/document.xml'] ? z['word/document.xml'].toString('utf8') : '';
            text = parsers.decodeXmlEntities(xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
            res.kind = 'docx'; res.textOk = !!text;
          } else {
            const exr = parsers.extractText(buf, doc.name || doc.file);
            res.kind = exr && exr.kind; res.textOk = !!(exr && exr.ok);
            if (exr && exr.sheets) res.sheets = exr.sheets;
            text = (exr && exr.text) || '';
          }
        } catch (e) { res.parseError = String((e && e.message) || e); }
        if (!text && !isPdf && !(res.sheets && res.sheets.length)) {
          const sample = buf.slice(0, 8192);
          let bad = 0;
          for (let i = 0; i < sample.length; i++) { const b = sample[i]; if (b === 0) { bad = 1e9; break; } if (b < 9 || (b > 13 && b < 32)) bad++; }
          if (sample.length && bad / sample.length < 0.1) { text = buf.toString('utf8'); res.kind = res.kind || 'text'; res.textOk = true; }
          else { res.binary = true; }
        }
        res.text = text;
      }
      return res;
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  // OCR по запросу: распознаёт текст из отсканированного PDF или изображения.
  ipcMain.handle('bim:ocrDocument', async (_e, docId) => {
    try {
      const data = store.getData();
      let doc = null;
      for (const r of (data.rooms || [])) { const d = (r.documents || []).find(x => x.id === docId); if (d) { doc = d; break; } }
      if (!doc) return { ok: false, reason: 'not_found' };
      if (!doc.file) return { ok: false, reason: 'no_file', name: doc.name };
      const abs = path.isAbsolute(doc.file) ? doc.file : path.join(store.uploadsDir, doc.file);
      if (!fs.existsSync(abs)) return { ok: false, reason: 'missing', name: doc.name };
      const settings = readSettings();
      const ocrOpts = { cmd: settings.ocrCmd, lang: settings.ocrLang };
      const ext = (String(doc.name || doc.file).split('.').pop() || '').toLowerCase();
      if (ext === 'pdf') return await ocrmod.ocrPdf(abs, ocrOpts);
      const IMG = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'ico', 'avif'];
      if (IMG.includes(ext)) return await ocrmod.ocr(abs, ocrOpts);
      return { ok: false, reason: 'unsupported', ext };
    } catch (e) { return { ok: false, reason: 'error', error: String((e && e.message) || e) }; }
  });

  // Статус OCR: есть ли Tesseract и растеризатор PDF (Poppler/Ghostscript).
  ipcMain.handle('bim:ocrStatus', () => {
    try {
      const settings = readSettings();
      if (ocrmod.resetOcrCache) ocrmod.resetOcrCache(); // Ре-скан путей (после установки без перезапуска)
      return { ok: true, tesseract: ocrmod.ocrAvailable(settings.ocrCmd), rasterizer: ocrmod.rasterizerAvailable(), lang: settings.ocrLang || 'rus+ukr+eng', platform: process.platform };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // Запуск установщика OCR (Tesseract + Poppler/Ghostscript) в окне терминала.
  ipcMain.handle('bim:installOcr', async () => {
    try {
      const cp = require('child_process');
      const os = require('os');
      const isWin = process.platform === 'win32';
      const isMac = process.platform === 'darwin';
      const scriptName = isWin ? 'install-ocr.ps1' : 'install-ocr.sh';
      let src = '';
      try { src = fs.readFileSync(path.join(__dirname, 'scripts', scriptName), 'utf8'); }
      catch (e) { return { ok: false, message: 'Скрипт установки не найден в сборке' }; }
      const tmp = path.join(os.tmpdir(), 'bimtwin-' + scriptName);
      fs.writeFileSync(tmp, src, 'utf8');
      if (!isWin) { try { fs.chmodSync(tmp, 0o755); } catch (e) {} }
      if (isWin) {
        const inner = "Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-ExecutionPolicy','Bypass','-File','\"" + tmp + "\"'";
        cp.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', inner], { detached: true, stdio: 'ignore' }).unref();
        return { ok: true, message: 'Открыто окно установки (подтвердите запрос прав администратора)', path: tmp };
      }
      if (isMac) {
        cp.spawn('open', ['-a', 'Terminal', tmp], { detached: true, stdio: 'ignore' }).unref();
        return { ok: true, message: 'Открыт Terminal с установщиком OCR', path: tmp };
      }
      const terms = [['x-terminal-emulator', ['-e', 'bash', tmp]], ['gnome-terminal', ['--', 'bash', tmp]], ['konsole', ['-e', 'bash', tmp]], ['xterm', ['-e', 'bash ' + tmp]]];
      for (const [bin, args] of terms) {
        try { cp.spawn(bin, args, { detached: true, stdio: 'ignore' }).unref(); return { ok: true, message: 'Открыт терминал с установщиком OCR', path: tmp }; } catch (e) {}
      }
      try { shell.openPath(tmp); } catch (e) {}
      return { ok: true, message: 'Скрипт сохранён: ' + tmp + ' — запустите его вручную (sudo bash ' + tmp + ')', path: tmp };
    } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
  });

  ipcMain.handle('bim:installPyDeps', async () => {
    try {
      const cp = require('child_process');
      const os = require('os');
      const isWin = process.platform === 'win32';
      const isMac = process.platform === 'darwin';
      const scriptName = isWin ? 'install-pydeps.ps1' : 'install-pydeps.sh';
      let src = '';
      try { src = fs.readFileSync(path.join(__dirname, 'scripts', scriptName), 'utf8'); }
      catch (e) { return { ok: false, message: 'Скрипт установки не найден в сборке' }; }
      const tmp = path.join(os.tmpdir(), 'bimtwin-' + scriptName);
      fs.writeFileSync(tmp, src, 'utf8');
      if (!isWin) { try { fs.chmodSync(tmp, 0o755); } catch (e) {} }
      if (isWin) {
        // v1031: ставим ИЗОЛИРОВАННЫЙ Python 3.12 (embeddable) + Open3D через setup-python.ps1.
        // НЕ используем системный Python: у пользователя может быть 3.13/3.14, под который Open3D нет.
        let ps1 = '';
        const cand = [
          path.join(process.resourcesPath || '', 'setup-python.ps1'),
          path.join(__dirname, 'scripts', 'setup-python.ps1'),
          path.join(__dirname, 'resources', 'setup-python.ps1'),
        ];
        for (const c of cand) { try { if (c && fs.existsSync(c)) { ps1 = c; break; } } catch (e) {} }
        if (!ps1) { return { ok: false, message: 'Не найден setup-python.ps1 в сборке' }; }
        // офлайн-колёса (если положены рядом): resources/wheels или scripts/wheels
        let wheels = '';
        const wcand = [
          path.join(process.resourcesPath || '', 'wheels'),
          path.join(path.dirname(ps1), 'wheels'),
        ];
        for (const w of wcand) { try { if (w && fs.existsSync(w)) { wheels = w; break; } } catch (e) {} }
        const psArg = wheels ? ('-File "' + ps1 + '" -Wheels "' + wheels + '"') : ('-File "' + ps1 + '"');
        const bat = [
          '@echo off',
          'chcp 65001 >nul',
          'title BIM Twin - автонастройка Python-движка (Open3D)',
          'echo ============================================================',
          'echo   Автонастройка Python-движка очистки',
          'echo   Изолированный Python 3.12 + Open3D. Без прав администратора.',
          'echo   Системный Python НЕ трогается.',
          'echo ============================================================',
          'echo.',
          'powershell -NoProfile -ExecutionPolicy Bypass ' + psArg,
          'set "RC=%ERRORLEVEL%"',
          'echo.',
          'if "%RC%"=="0" (echo [OK] Open3D установлен. Перезапустите BIM Twin.) else if "%RC%"=="2" (echo [OK] NumPy-режим установлен. Open3D не собрался, но чистка работает.) else (echo [ОШИБКА] Установка не удалась. Проверьте интернет-соединение.)',
          'echo.',
          'pause'
        ].join('\r\n');
        const batTmp = path.join(os.tmpdir(), 'bimtwin-setup-python.bat');
        try { fs.writeFileSync(batTmp, '\ufeff' + bat, 'utf8'); } catch (e) { return { ok: false, message: 'Не удалось создать установщик: ' + String((e && e.message) || e) }; }
        let opened = false;
        try { const r = await shell.openPath(batTmp); opened = !r; } catch (e) {}
        if (!opened) { try { cp.spawn('cmd.exe', ['/c', batTmp], { detached: true, stdio: 'ignore' }).unref(); opened = true; } catch (e) {} }
        return { ok: true, message: 'Открыто окно автоустановки: изолированный Python 3.12 + Open3D (без прав администратора).', path: batTmp };
      }
      if (isMac) {
        cp.spawn('open', ['-a', 'Terminal', tmp], { detached: true, stdio: 'ignore' }).unref();
        return { ok: true, message: 'Открыт Terminal с установщиком Open3D/SciPy', path: tmp };
      }
      const terms = [['x-terminal-emulator', ['-e', 'bash', tmp]], ['gnome-terminal', ['--', 'bash', tmp]], ['konsole', ['-e', 'bash', tmp]], ['xterm', ['-e', 'bash ' + tmp]]];
      for (const [bin, args] of terms) {
        try { cp.spawn(bin, args, { detached: true, stdio: 'ignore' }).unref(); return { ok: true, message: 'Открыт терминал с установщиком Open3D/SciPy', path: tmp }; } catch (e) {}
      }
      try { shell.openPath(tmp); } catch (e) {}
      return { ok: true, message: 'Скрипт сохранён: ' + tmp + ' — запустите вручную: bash ' + tmp, path: tmp };
    } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
  });

  // Convert a binary DWG to DXF text via an external converter (LibreOffice or ODA File Converter), if installed.
  ipcMain.handle('bim:convertDwg', async (_e, docId) => {
    try {
      const cp = require('child_process');
      const os = require('os');
      const data = store.getData(); let doc = null;
      for (const r of (data.rooms || [])) { const dd = (r.documents || []).find(x => x.id === docId); if (dd) { doc = dd; break; } }
      if (!doc || !doc.file) return { ok: false, error: 'no_file' };
      const abs = path.isAbsolute(doc.file) ? doc.file : path.join(store.uploadsDir, doc.file);
      if (!fs.existsSync(abs)) return { ok: false, error: 'missing' };
      // 1) Preferred: parse in-process with libredwg-web (GNU LibreDWG -> WASM).
      //    Fully offline, no external CAD tools, works from node_modules directly.
      try {
        const dxf = await dwgToDxfNode(fs.readFileSync(abs));
        if (dxf && String(dxf).trim()) return { ok: true, dxf, via: 'libredwg' };
      } catch (e) { console.log('[dwg] libredwg parse failed, trying external converter:', (e && e.message) || e); }
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-dwg-'));
      const base = path.basename(abs).replace(/\.[^.]+$/, '');
      const outDxf = path.join(tmp, base + '.dxf');
      const soffice = process.platform === 'win32'
        ? ['soffice', 'C:/Program Files/LibreOffice/program/soffice.exe', 'C:/Program Files (x86)/LibreOffice/program/soffice.exe']
        : process.platform === 'darwin'
          ? ['soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice']
          : ['soffice', 'libreoffice', '/usr/bin/soffice'];
      for (const bin of soffice) {
        try {
          cp.execFileSync(bin, ['--headless', '--convert-to', 'dxf', '--outdir', tmp, abs], { timeout: 90000, stdio: 'ignore' });
          if (fs.existsSync(outDxf)) return { ok: true, dxf: fs.readFileSync(outDxf, 'utf8'), via: 'LibreOffice' };
        } catch (e) { /* try next */ }
      }
      const oda = process.platform === 'win32'
        ? ['ODAFileConverter', 'C:/Program Files/ODA/ODAFileConverter/ODAFileConverter.exe']
        : ['ODAFileConverter', '/usr/bin/ODAFileConverter'];
      const inDir = path.join(tmp, 'in'); try { fs.mkdirSync(inDir, { recursive: true }); fs.copyFileSync(abs, path.join(inDir, path.basename(abs))); } catch (e) {}
      for (const bin of oda) {
        try {
          cp.execFileSync(bin, [inDir, tmp, 'ACAD2018', 'DXF', '0', '1'], { timeout: 90000, stdio: 'ignore' });
          if (fs.existsSync(outDxf)) return { ok: true, dxf: fs.readFileSync(outDxf, 'utf8'), via: 'ODA' };
        } catch (e) { /* try next */ }
      }
      return { ok: false, error: 'no_converter' };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  // Persist edited document bytes (e.g. a Word .docx saved from the in-app editor) back to its file.
  ipcMain.handle('bim:saveDocument', (_e, docId, base64) => {
    try {
      const data = store.getData(); let doc = null;
      for (const r of (data.rooms || [])) { const dd = (r.documents || []).find(x => x.id === docId); if (dd) { doc = dd; break; } }
      if (!doc || !doc.file) return { ok: false, error: 'no_file' };
      const abs = path.isAbsolute(doc.file) ? doc.file : path.join(store.uploadsDir, doc.file);
      fs.writeFileSync(abs, Buffer.from(base64, 'base64'));
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('bim:openFile', (_e, p) => {
    const abs = safeReadPath(p);
    if (!abs) return 'blocked';
    return shell.openPath(abs);
  });
  // Save a copy of a document to a user-chosen location
  ipcMain.handle('bim:saveCopy', async (_e, docId) => {
    try {
      const data = store.getData(); let doc = null;
      for (const r of (data.rooms || [])) { const d = (r.documents || []).find(x => x.id === docId); if (d) { doc = d; break; } }
      if (!doc || !doc.file) return { ok: false, error: 'no_file' };
      const abs = path.isAbsolute(doc.file) ? doc.file : path.join(store.uploadsDir, doc.file);
      if (!fs.existsSync(abs)) return { ok: false, error: 'missing' };
      const res = await dialog.showSaveDialog({ title: 'Сохранить копию документа', defaultPath: doc.name || path.basename(abs) });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      fs.copyFileSync(abs, res.filePath);
      return { ok: true, path: res.filePath };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('bim:getModelPath', (_e, roomId) => store.getModelPath(roomId));

  // Phase 4: сохранение отредактированного облака точек в PLY
  ipcMain.handle('bim:saveCloud', async (_e, a) => {
    try {
      a = a || {};
      const hasBinary = a.binary != null;
      const text = typeof a.text === 'string' ? a.text : '';
      if (!hasBinary && !text) return { ok: false, error: 'empty' };
      const res = await dialog.showSaveDialog({ title: 'Сохранить облако точек', defaultPath: a.name || 'pointcloud-edited.ply', filters: [{ name: 'PLY', extensions: ['ply'] }] });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      const buf = hasBinary ? payloadBuffer(a.binary) : Buffer.from(text, 'utf8');
      const saved = await saveCloudOutput(res.filePath, buf, { operation: 'cloud.export', format: 'ply' });
      return { ok: true, path: saved.path, sha256: saved.sha256, bytes: saved.bytes, backupPath: saved.backupPath };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // v1156 — экспорт в произвольный формат с корректным расширением/фильтром (диалог).
  ipcMain.handle('bim:exportFile', async (_e, a) => {
    try {
      a = a || {};
      const hasBinary = a.binary != null;
      const text = typeof a.text === 'string' ? a.text : '';
      if (!hasBinary && !text) return { ok: false, error: 'empty' };
      const ext = String(a.ext || '').replace(/^\./, '') || 'bin';
      const filters = [{ name: a.filterName || (ext.toUpperCase() + ' \u0444\u0430\u0439\u043b'), extensions: [ext] }, { name: '\u0412\u0441\u0435 \u0444\u0430\u0439\u043b\u044b', extensions: ['*'] }];
      const res = await dialog.showSaveDialog({ title: a.title || '\u042d\u043a\u0441\u043f\u043e\u0440\u0442', defaultPath: a.name || ('export.' + ext), filters });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      const buf = hasBinary ? payloadBuffer(a.binary) : Buffer.from(text, 'utf8');
      const saved = await saveCloudOutput(res.filePath, buf, { operation: 'project.export', format: ext });
      return { ok: true, path: saved.path, sha256: saved.sha256, bytes: saved.bytes, backupPath: saved.backupPath };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // v1156 — тихое сохранение в уже известный путь (без диалога), атомарная замена.
  ipcMain.handle('bim:saveCloudToPath', async (_e, a) => {
    try {
      a = a || {};
      if (!a.path) return { ok: false, error: 'no-path' };
      const hasBinary = a.binary != null;
      const text = typeof a.text === 'string' ? a.text : '';
      if (!hasBinary && !text) return { ok: false, error: 'empty' };
      const buf = hasBinary ? payloadBuffer(a.binary) : Buffer.from(text, 'utf8');
      const saved = await saveCloudOutput(a.path, buf, { operation: 'cloud.working-copy.save', format: path.extname(a.path).slice(1).toLowerCase() });
      return { ok: true, path: saved.path, sha256: saved.sha256, bytes: saved.bytes, inputHash: saved.inputHash, backupPath: saved.backupPath, savedAt: Date.now() };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('bim:autosaveCloud', async (_e, a) => {
    try {
      a = vArgs(a || {});
      if (!autosaveStore) return { ok: false, error: 'autosave_store_unavailable' };
      return await autosaveStore.save(Object.assign({}, a, {
        projectId: a.projectId ? vId(a.projectId) : (store && store.getData().project.id),
        binary: a.binary
      }));
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('bim:autosaveLoad', async (_e, a) => {
    try {
      a = vArgs(a || {});
      if (!autosaveStore) return { ok: false, error: 'autosave_store_unavailable' };
      return await autosaveStore.load(a);
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('bim:autosaveClear', async (_e, a) => {
    try {
      a = vArgs(a || {});
      if (!autosaveStore) return { ok: false, error: 'autosave_store_unavailable' };
      return await autosaveStore.clear(a);
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // ---------- Конвертация облака (LAS/LAZ/E57/PCD/XYZ) → PLY для 3D-экскурсии ----------
  // Парсим файл в main-процессе (Node, без GPU) и потоково пишем бинарный PLY на диск
  // чанками — не держим весь PLY в памяти, поэтому не вылетает на больших облаках.
  function writePlyBinaryToDisk(filePath, pos, col, hasColor, opts) {
    opts = opts || {};
    const n = (pos.length / 3) | 0;
    const doublePrecision = opts.doublePrecision === true;
    const coordType = doublePrecision ? 'double' : 'float';
    const coordBytes = doublePrecision ? 8 : 4;
    const H = ['ply', 'format binary_little_endian 1.0', 'comment BIM Twin cloud export'];
    if (opts.upAxis === 'z' || opts.upAxis === 'y') H.push('comment up=' + opts.upAxis);
    if (opts.crsWkt) H.push('comment crs_wkt_uri=' + encodeURIComponent(String(opts.crsWkt)));
    if (opts.coordinateFrame) H.push('comment coordinate_frame=' + String(opts.coordinateFrame).replace(/[^A-Za-z0-9_.:-]/g, '_'));
    H.push('element vertex ' + n, 'property ' + coordType + ' x', 'property ' + coordType + ' y', 'property ' + coordType + ' z');
    if (hasColor) { H.push('property uchar red', 'property uchar green', 'property uchar blue'); }
    H.push('end_header', '');
    let scaled = true; // col в диапазоне 0..1 → умножаем на 255
    if (hasColor && col) { let mx = 0; const lim = Math.min(col.length, 300); for (let i = 0; i < lim; i++) if (col[i] > mx) mx = col[i]; if (mx > 1.0001) scaled = false; }
    const toByte = v => { v = scaled ? Math.round(v * 255) : Math.round(v); return v < 0 ? 0 : (v > 255 ? 255 : v); };
    const fd = fs.openSync(filePath, 'w');
    try {
      fs.writeSync(fd, Buffer.from(H.join('\n'), 'ascii'));
      const stride = coordBytes * 3 + (hasColor ? 3 : 0);
      const CHUNK = 200000;
      const buf = Buffer.allocUnsafe(CHUNK * stride);
      let i = 0;
      while (i < n) {
        const mm = Math.min(CHUNK, n - i);
        let off = 0;
        for (let k = 0; k < mm; k++) {
          const p = (i + k) * 3;
          if (doublePrecision) {
            buf.writeDoubleLE(pos[p], off); off += 8;
            buf.writeDoubleLE(pos[p + 1], off); off += 8;
            buf.writeDoubleLE(pos[p + 2], off); off += 8;
          } else {
            buf.writeFloatLE(pos[p], off); off += 4;
            buf.writeFloatLE(pos[p + 1], off); off += 4;
            buf.writeFloatLE(pos[p + 2], off); off += 4;
          }
          if (hasColor) {
            buf.writeUInt8(toByte(col[p]), off); off += 1;
            buf.writeUInt8(toByte(col[p + 1]), off); off += 1;
            buf.writeUInt8(toByte(col[p + 2]), off); off += 1;
          }
        }
        fs.writeSync(fd, buf, 0, off);
        i += mm;
      }
    } finally { try { fs.closeSync(fd); } catch (_) {} }
    return n;
  }

  ipcMain.handle('bim:convertCloudToPly', async (_e, a) => {
    try {
      a = a || {};
      let abs = String(a.path || '');
      if (!abs) {
        const pick = await dialog.showOpenDialog({ title: 'Выберите облако (LAS/LAZ/E57/PTX/PCD/XYZ) для конвертации в PLY', properties: ['openFile'], filters: [{ name: 'Облака точек', extensions: ['las', 'laz', 'e57', 'ptx', 'pcd', 'xyz', 'pts', 'xyzrgb'] }] });
        if (pick.canceled || !pick.filePaths || !pick.filePaths[0]) return { ok: false, canceled: true };
        abs = pick.filePaths[0];
      }
      if (!CLOUD_EXT_ALLOW.has(path.extname(abs).toLowerCase())) return { ok: false, error: 'ext_not_allowed' };
      if (!fs.existsSync(abs)) return { ok: false, error: 'not_found' };
      const s = readSettings();
      const maxPoints = Number(a.maxPoints) > 0 ? Number(a.maxPoints) : 120000000;
      const pr = await cloud.parseCloudFileAsync(abs, { maxPoints });
      if (!pr || !pr.ok) return { ok: false, error: (pr && pr.message) || 'parse_failed' };
      if (pr.kind && pr.kind !== 'points') return { ok: false, error: 'not_points' };
      const base = path.basename(abs).replace(/\.[^.]+$/, '');
      const def = path.join(path.dirname(abs), base + '.ply');
      const out = await dialog.showSaveDialog({ title: 'Сохранить PLY', defaultPath: def, filters: [{ name: 'PLY', extensions: ['ply'] }] });
      if (out.canceled || !out.filePath) return { ok: false, canceled: true };
      const hasColor = !!(pr.meta && pr.meta.colored) && !!(pr.col && pr.col.length);
      const n = writePlyBinaryToDisk(out.filePath, pr.pos, pr.col, hasColor);
      return { ok: true, path: out.filePath, count: n, colored: hasColor, total: (pr.meta && pr.meta.total) || n };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // ---------- Импорт реальных станций сканера (E57) для «Экскурсии» ----------
  async function readE57Stations(p) {
    let fd = null;
    try {
      const ext = path.extname(p || '').toLowerCase();
      if (ext !== '.e57') return { ok: false, error: 'not e57' };
      if (!fs.existsSync(p)) return { ok: false, error: 'not found' };
      const st = fs.statSync(p);
      fd = fs.openSync(p, 'r');
      const head = Buffer.alloc(48);
      fs.readSync(fd, head, 0, 48, 0);
      const h = e57.parseFileHeader(head);
      if (!h) return { ok: false, error: 'bad e57 header' };
      const pageSize = h.pageSize;
      const CAP = 64 * 1024 * 1024;
      const logical = Math.min(h.xmlLogicalLength || 0, CAP);
      if (!logical) return { ok: false, error: 'no xml' };
      const physBase = Math.floor(h.xmlPhysicalOffset / pageSize) * pageSize;
      const pagesNeeded = Math.ceil(logical / (pageSize - 4)) + 2;
      let physLen = pagesNeeded * pageSize;
      if (physBase + physLen > st.size) physLen = st.size - physBase;
      if (physLen <= 0) return { ok: false, error: 'bad xml region' };
      const buf = Buffer.alloc(physLen);
      fs.readSync(fd, buf, 0, physLen, physBase);
      const xml = e57.stripCrcPages(buf, physBase, h.xmlPhysicalOffset, logical, pageSize);
      const parsed = e57.parseE57Header(xml);
      return { ok: true, stations: parsed.stations, images: parsed.images, version: h.major + '.' + h.minor };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } }
  }

  ipcMain.handle('bim:parseScanStations', async (_e, p) => {
    if (typeof p !== 'string' || !p) return { ok: false, error: 'bad path' };
    return await readE57Stations(p);
  });

  ipcMain.handle('bim:importStations', async () => {
    try {
      const res = await dialog.showOpenDialog({ title: 'Импорт станций сканера', properties: ['openFile'], filters: [{ name: 'Станции (E57/JSON)', extensions: ['e57', 'json'] }] });
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
      const p = res.filePaths[0];
      const ext = path.extname(p).toLowerCase();
      if (ext === '.json') {
        const text = fs.readFileSync(p, 'utf8');
        let arr; try { arr = JSON.parse(text); } catch (_) { return { ok: false, error: 'bad json' }; }
        const stations = Array.isArray(arr) ? arr : (arr && Array.isArray(arr.stations) ? arr.stations : []);
        return { ok: true, kind: 'json', stations, path: p };
      }
      const r = await readE57Stations(p);
      if (!r.ok) return r;
      return { ok: true, kind: 'e57', stations: r.stations, images: r.images, path: p };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('bim:saveStations', async (_e, a) => {
    try {
      a = a || {};
      const text = typeof a.text === 'string' ? a.text : '';
      if (!text) return { ok: false, error: 'empty' };
      const res = await dialog.showSaveDialog({ title: 'Экспорт станций', defaultPath: a.name || 'stations.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      fs.writeFileSync(res.filePath, text, 'utf8');
      return { ok: true, path: res.filePath };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // ---------- Дисковый octree: сборка и потоковая подгрузка узлов (пункт 4) ----------
  // Каталог хранилищ octree внутри userData; читать/писать разрешено только здесь.
  function octreeBaseDir() { return path.join(app.getPath('userData'), 'octrees'); }
  const octreeIndexCache = new Map();
  const octreeDirOwners = new Map();
  function safeOctreeDir(dir) {
    const base = path.resolve(octreeBaseDir());
    const rd = path.resolve(String(dir || ''));
    const relative = path.relative(base, rd);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    try {
      if (fs.lstatSync(base).isSymbolicLink() || fs.lstatSync(rd).isSymbolicLink() || !fs.lstatSync(rd).isDirectory()) return null;
    } catch (_) { return null; }
    return rd;
  }
  octreeCleanupOnQuit = function cleanupOctreeStoresOnQuit() {
    for (const job of activeOctreeBuildJobs.values()) {
      if (!job || job.finished) continue;
      job.cancelled = true;
      try { job.worker.terminate().catch(() => {}); } catch (_) {}
      try { if (job.outputDir) fs.rmSync(job.outputDir, { recursive: true, force: true }); } catch (_) {}
    }
    const base = path.resolve(octreeBaseDir());
    try {
      const stat = fs.lstatSync(base);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return;
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        // Remove only names produced by buildOctree, never arbitrary userData.
        if (!entry.isDirectory() || !/^\d+-[a-f0-9]{16}$/.test(entry.name)) continue;
        const dir = safeOctreeDir(path.join(base, entry.name));
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (_) {}
    octreeIndexCache.clear();
    octreeDirOwners.clear();
  };

  // Parse, partition and pack point data in a dedicated worker. Only the
  // relatively small index returns through IPC; node bytes are written in
  // bounded blocks directly to disk.
  ipcMain.handle('bim:buildOctree', async (event, a) => {
    let job = null;
    try {
      a = a || {};
      const abs = String(a.path || '');
      if (!CLOUD_EXT_ALLOW.has(path.extname(abs).toLowerCase())) return { ok: false, error: 'ext_not_allowed' };
      const sender = event && event.sender;
      if (!sender || (sender.isDestroyed && sender.isDestroyed())) return { ok: false, error: 'invalid_sender' };
      const jobId = a.jobId == null ? crypto.randomBytes(12).toString('hex') : a.jobId;
      if (typeof jobId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(jobId)) return { ok: false, error: 'invalid_job_id' };
      const key = cloudJobKey(sender, 'octree:' + jobId);
      if (activeOctreeBuildJobs.has(key)) return { ok: false, error: 'duplicate_job_id' };
      const s = readSettings();
      // Scalar ASCII/binary PLY, uncompressed LAS and ASCII/interleaved-binary/
      // LZF PCD point clouds use bounded source reads and external disk partitions.
      // Other formats still use the memory-backed parser below.
      const configuredBudget = Number(s && s.pointBudget) > 0 ? Number(s.pointBudget) : 0;
      const requestedBudget = Math.max(configuredBudget, Number(a.maxPoints) || 0, 40000000);
      const maxPoints = Math.min(40000000, Number.isSafeInteger(requestedBudget) ? requestedBudget : 40000000);
      const requestedCapacity = Number(a.nodeCapacity) || 120000;
      const nodeCapacity = Math.max(1000, Math.min(500000, Number.isSafeInteger(requestedCapacity) ? requestedCapacity : 120000));
      let sourcePreflightInfo = null;
      const sourceExtension = path.extname(abs).toLowerCase();
      if (sourceExtension === '.ply' &&
          typeof cloud.getOutOfCorePlyPointFileInfo === 'function') {
        try { sourcePreflightInfo = cloud.getOutOfCorePlyPointFileInfo(abs); } catch (_) {}
      } else if (sourceExtension === '.las' &&
          typeof cloud.getOutOfCoreLasPointFileInfo === 'function') {
        try { sourcePreflightInfo = cloud.getOutOfCoreLasPointFileInfo(abs); } catch (_) {}
      } else if (sourceExtension === '.pcd' &&
          typeof cloud.getOutOfCorePcdPointFileInfo === 'function') {
        try { sourcePreflightInfo = cloud.getOutOfCorePcdPointFileInfo(abs); } catch (_) {}
      }
      const useOutOfCore = !!sourcePreflightInfo;
      const advertisedSourcePoints = Number(a.expectedPoints);
      const sourcePointCount = useOutOfCore
        ? Number(sourcePreflightInfo.pointCount || sourcePreflightInfo.vertexCount)
        : advertisedSourcePoints;
      const estimatePointCount = Number.isSafeInteger(sourcePointCount) && sourcePointCount > 0
        ? Math.min(sourcePointCount, maxPoints)
        : null;
      if (estimatePointCount !== null) {
        const memory = useOutOfCore
          ? assessOutOfCoreOctreeMemory(estimatePointCount, currentAvailableMemoryBytes(), { nodeCapacity })
          : assessOctreeBuildMemory(estimatePointCount, currentAvailableMemoryBytes());
        if (!memory.ok) {
          return {
            ok: false,
            error: 'insufficient_memory',
            message: 'Индексация остановлена до запуска worker: ' +
              (useOutOfCore ? 'оценка потокового рабочего набора ' : 'консервативная оценка памяти ') +
              formatResourceMiB(memory.estimatedBytes) + ', безопасный бюджет сейчас ' +
              formatResourceMiB(memory.safeBudgetBytes) + '. Закройте другие приложения или уменьшите объём облака.'
          };
        }
      }
      const base = octreeBaseDir();
      fs.mkdirSync(base, { recursive: true });
      if (estimatePointCount !== null) {
        const pcdLzfScratchBytes = useOutOfCore && sourceExtension === '.pcd' &&
          sourcePreflightInfo.mode === 'binary_compressed'
          ? sourcePreflightInfo.pointBytes
          : 0;
        const disk = useOutOfCore
          ? assessOutOfCoreOctreeDiskSpace(
            estimatePointCount, currentAvailableDiskBytes(base),
            { extraBytes: pcdLzfScratchBytes }
          )
          : assessOctreeBuildDiskSpace(estimatePointCount, currentAvailableDiskBytes(base));
        if (!disk.ok) {
          return {
            ok: false,
            error: 'insufficient_disk',
            message: 'Индексация остановлена до запуска worker: свободно ' +
              formatResourceMiB(disk.availableBytes) + ', по оценке требуется ' +
              formatResourceMiB(disk.requiredBytes) + ' с резервом' +
              (useOutOfCore ? ' для промежуточных и итоговых дисковых данных.' : '.') +
              ' Освободите место на диске приложения или уменьшите объём облака.'
          };
        }
      }
      let sourceTransform;
      if (a.sourceTransform != null) {
        const candidate = a.sourceTransform;
        if (!candidate || !['zup', 'yup'].includes(candidate.axis) ||
            !Array.isArray(candidate.t) || candidate.t.length < 3 ||
            !candidate.t.slice(0, 3).every(value => Number.isFinite(Number(value)) && Math.abs(Number(value)) <= 1e12)) {
          return { ok: false, error: 'invalid_source_transform' };
        }
        sourceTransform = { axis: candidate.axis, t: candidate.t.slice(0, 3).map(Number) };
      }
      const outputDir = path.join(base, Date.now() + '-' + crypto.randomBytes(8).toString('hex'));
      const worker = new Worker(path.join(__dirname, 'octree-build-worker.js'), {
        workerData: { sourcePath: abs, outputDir, maxPoints, nodeCapacity, sourceTransform, sourcePreflightInfo }
      });
      return await new Promise(resolve => {
        let settled = false;
        const finish = result => {
          if (settled) return;
          settled = true;
          job.finished = true;
          activeOctreeBuildJobs.delete(key);
          try { sender.removeListener('destroyed', job.onSenderDestroyed); } catch (_) {}
          if (!result || !result.ok) {
            try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (_) {}
            result = result || { ok: false, error: 'octree_worker_failed' };
          } else {
            // The index is immutable after build. Cache it once instead of
            // reparsing index.json for every node requested by the renderer.
            const canonicalDir = path.resolve(outputDir);
            octreeIndexCache.set(canonicalDir, result.index);
            octreeDirOwners.set(canonicalDir, sender.id);
            while (octreeIndexCache.size > 8) octreeIndexCache.delete(octreeIndexCache.keys().next().value);
          }
          resolve(result);
        };
        job = { key, jobId, sender, worker, outputDir, cancelled: false, finished: false };
        job.onSenderDestroyed = () => {
          if (job.finished || job.cancelled) return;
          job.cancelled = true;
          try { worker.terminate().catch(() => {}); } catch (_) {}
        };
        activeOctreeBuildJobs.set(key, job);
        try { sender.once('destroyed', job.onSenderDestroyed); } catch (_) {}
        worker.on('message', message => {
          if (job.cancelled || job.finished) return;
          if (message && message.type === 'progress') {
            try { if (!(sender.isDestroyed && sender.isDestroyed())) sender.send('bim:octreeProgress', { jobId, progress: message.progress }); } catch (_) {}
          } else if (message && message.type === 'result') {
            finish(Object.assign({ ok: false }, message.result || {}));
          }
        });
        worker.on('error', error => finish({ ok: false, error: String(error && error.message || error) }));
        worker.on('exit', code => {
          if (job.cancelled) finish({ ok: false, cancelled: true, error: 'cancelled' });
          else if (!settled) finish({ ok: false, error: 'octree_worker_exit_' + code });
        });
      });
    } catch (e) {
      if (job && job.outputDir) try { fs.rmSync(job.outputDir, { recursive: true, force: true }); } catch (_) {}
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // Читает байты одного узла octree по смещению/длине из index (для потоковой подгрузки в рендерере).
  ipcMain.handle('bim:readOctreeNode', async (_e, a) => {
    let fd = null;
    try {
      a = a || {};
      const dir = safeOctreeDir(a.dir);
      if (!dir) return { ok: false, error: 'denied' };
      const idxPath = path.join(dir, 'index.json');
      const binPath = path.join(dir, 'nodes.bin');
      if (!fs.existsSync(idxPath) || !fs.existsSync(binPath)) return { ok: false, error: 'not_found' };
      let index = octreeIndexCache.get(dir);
      if (!index) {
        const idxStat = fs.statSync(idxPath);
        if (!idxStat.isFile() || idxStat.size > 64 * 1024 * 1024) return { ok: false, error: 'index_too_large' };
        index = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
        if (!index || !Array.isArray(index.nodes) || ![12, 15].includes(index.stride)) return { ok: false, error: 'invalid_index' };
        octreeIndexCache.set(dir, index);
      }
      if (typeof a.key !== 'string' || !/^r[0-7]*$/.test(a.key)) return { ok: false, error: 'invalid_node_key' };
      const node = index.nodes.find(x => x.key === a.key);
      if (!node) return { ok: false, error: 'no_node' };
      if (!Number.isSafeInteger(node.count) || node.count < 0 ||
          !Number.isSafeInteger(node.offset) || node.offset < 0 ||
          !Number.isSafeInteger(node.byteLength) || node.byteLength !== node.count * index.stride ||
          node.byteLength > 16 * 1024 * 1024) return { ok: false, error: 'invalid_node_range' };
      const binStat = fs.statSync(binPath);
      if (!binStat.isFile() || node.offset + node.byteLength > binStat.size) return { ok: false, error: 'node_out_of_bounds' };
      fd = fs.openSync(binPath, 'r');
      const buf = Buffer.alloc(node.byteLength);
      const read = fs.readSync(fd, buf, 0, node.byteLength, node.offset);
      if (read !== node.byteLength) return { ok: false, error: 'short_node_read' };
      return { ok: true, key: node.key, count: node.count, hasColor: !!index.hasColor, bytes: buf };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } }
  });

  // Deletes one completed, sender-owned derived store. Raw source files and
  // other renderer sessions are never in scope for this operation.
  ipcMain.handle('bim:deleteOctree', async (event, a) => {
    try {
      a = a || {};
      const dir = safeOctreeDir(a.dir);
      if (!dir) return { ok: false, error: 'denied' };
      const sender = event && event.sender;
      if (!sender || octreeDirOwners.get(dir) !== sender.id) return { ok: false, error: 'denied' };
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      octreeIndexCache.delete(dir);
      octreeDirOwners.delete(dir);
      return { ok: true, deleted: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // ---------- Potree: конвертация облака во внешний формат Potree 2.0 (опционально) ----------
  // Требует внешний бинарник PotreeConverter, который пользователь кладёт в
  // vendor/potree-converter/. Если его нет — возвращаем ok:false, и рендерер
  // откатывается на встроенное дисковое octree-облако (ничего не ломается).
  function potreeConverterPath() {
    const names = process.platform === 'win32' ? ['PotreeConverter.exe'] : ['PotreeConverter'];
    const dirs = [];
    try { const s = readSettings(); if (s && s.potreeConverterPath) { const pp = String(s.potreeConverterPath); try { if (fs.existsSync(pp)) return pp; } catch (_) {} dirs.push(path.dirname(pp)); } } catch (_) {}
    if (process.env.POTREE_CONVERTER) { const pe = String(process.env.POTREE_CONVERTER); try { if (fs.existsSync(pe)) return pe; } catch (_) {} dirs.push(path.dirname(pe)); }
    dirs.push(path.join(__dirname, 'vendor', 'potree-converter'));
    try { dirs.push(path.join(app.getPath('userData'), 'vendor', 'potree-converter')); } catch (_) {}
    for (const dir of dirs) { for (const n of names) { const p = path.join(dir, n); try { if (fs.existsSync(p)) return p; } catch (_) {} } }
    return null;
  }
  ipcMain.handle('bim:potreeStatus', () => {
    try { const c = potreeConverterPath(); return { ok: true, converter: !!c, path: c || null }; }
    catch (e) { return { ok: false, converter: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('bim:convertPotree', async (_e, p) => {
    try {
      const abs = String(p || '');
      if (!CLOUD_EXT_ALLOW.has(path.extname(abs).toLowerCase())) return { ok: false, error: 'ext_not_allowed' };
      if (!fs.existsSync(abs)) return { ok: false, error: 'missing' };
      const conv = potreeConverterPath();
      if (!conv) return { ok: false, error: 'no_converter' };
      const base = path.join(app.getPath('userData'), 'potree');
      fs.mkdirSync(base, { recursive: true });
      const out = path.join(base, String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8));
      const { execFile } = require('child_process');
      const { pathToFileURL } = require('url');
      await new Promise((resolve, reject) => {
        execFile(conv, [abs, '-o', out, '--overwrite'], { windowsHide: true, maxBuffer: 1 << 24 }, (err) => err ? reject(err) : resolve());
      });
      const meta = path.join(out, 'metadata.json');
      if (!fs.existsSync(meta)) return { ok: false, error: 'no_output' };
      return { ok: true, dir: out, url: pathToFileURL(meta).href };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // ---------- SplatTransform: PLY -> SOG (сжатие ~15-20x) / оптимизация (Шаг 1) ----------
  // Использует npm-пакет @playcanvas/splat-transform (MIT), ставится через `npm install`.
  // Если пакет не установлен — возвращаем ok:false, и рендерер грузит исходный файл (без регрессий).
  function splatTransformBin() {
    try {
      const pkg = require.resolve('@playcanvas/splat-transform/package.json');
      const dir = path.dirname(pkg);
      const meta = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      let bin = meta && meta.bin;
      if (bin && typeof bin === 'object') bin = bin['splat-transform'] || Object.values(bin)[0];
      if (!bin) bin = 'bin/index.js';
      const binPath = path.join(dir, bin);
      if (fs.existsSync(binPath)) return binPath;
    } catch (_) {}
    return null;
  }
  ipcMain.handle('bim:splatTransformStatus', () => {
    try { return { ok: true, converter: !!splatTransformBin() }; }
    catch (e) { return { ok: false, converter: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('bim:convertSplat', async (_e, a) => {
    try {
      a = a || {};
      const abs = String(a.path || '');
      const mode = a.mode === 'optimize' ? 'optimize' : 'sog';
      if (path.extname(abs).toLowerCase() !== '.ply') return { ok: false, error: 'ext_not_allowed' };
      if (!fs.existsSync(abs)) return { ok: false, error: 'missing' };
      const bin = splatTransformBin();
      if (!bin) return { ok: false, error: 'no_converter' };
      const st = fs.statSync(abs);
      const base = path.join(app.getPath('userData'), 'splatcache');
      fs.mkdirSync(base, { recursive: true });
      const crypto = require('crypto');
      const key = crypto.createHash('sha1').update(abs + '|' + st.size + '|' + st.mtimeMs + '|' + mode).digest('hex').slice(0, 16);
      const ext = mode === 'sog' ? '.sog' : '.ply';
      const out = path.join(base, key + ext);
      const { pathToFileURL } = require('url');
      const cap = 300 * 1024 * 1024;
      const readOut = () => {
        const size = fs.statSync(out).size;
        const res = { ok: true, outPath: out, url: pathToFileURL(out).href, kind: mode, bytes: size };
        if (size > 0 && size <= cap) { try { res.base64 = fs.readFileSync(out).toString('base64'); } catch (_) {} }
        return res;
      };
      if (fs.existsSync(out) && fs.statSync(out).size > 0) return Object.assign({ cached: true }, readOut());
      const args = [bin, abs];
      if (mode === 'optimize') { args.push('-d', '60%', '--filter-nan', '--filter-harmonics', '2'); }
      args.push(out);
      const { execFile } = require('child_process');
      await new Promise((resolve, reject) => {
        execFile(process.execPath, args, {
          windowsHide: true,
          maxBuffer: 1 << 26,
          env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
        }, (err) => err ? reject(err) : resolve());
      });
      if (!fs.existsSync(out) || fs.statSync(out).size === 0) return { ok: false, error: 'no_output' };
      return readOut();
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // ---------- Очистка облака точек (Open3D/PDAL сайдкар; fallback — NumPy) ----------
  // Работает в отдельном процессе Python по IPC. Если установлен open3d — используется он
  // (statistical/radius outlier, HPR, crop, downsample). Иначе — быстрый NumPy-фильтр по
  // плотности вокселей (удаление шума/«лучей»/оторванных точек) + crop/downsample.
  let _pyBinCache;
  function pythonBin() {
    if (_pyBinCache !== undefined) return _pyBinCache;
    const cp = require('child_process');
    const cands = [];
    try { const s = readSettings(); if (s && s.pythonPath) cands.push(String(s.pythonPath)); } catch (_) {}
    // v1029: изолированный Python-движок, настроенный установщиком (NumPy + Open3D), без прав админа.
    if (process.platform === 'win32') {
      const la = process.env.LOCALAPPDATA;
      if (la) {
        try { const pf = path.join(la, 'BIMTwin', 'python-path.txt'); if (fs.existsSync(pf)) { const t = String(fs.readFileSync(pf, 'utf8')).trim(); if (t) cands.push(t); } } catch (_) {}
        cands.push(path.join(la, 'BIMTwin', 'py312', 'python.exe'));
        cands.push(path.join(la, 'BIMTwin', 'py', 'python.exe'));
      }
    }
    if (process.env.PYTHON) cands.push(process.env.PYTHON);
    cands.push('python3', 'python', 'py');
    for (const c of cands) {
      try {
        const r = cp.spawnSync(c, ['--version'], { windowsHide: true });
        const txt = String((r && r.stdout) || '') + String((r && r.stderr) || '');
        if ((r && r.status === 0) || /Python\s+3/.test(txt)) { _pyBinCache = c; return c; }
      } catch (_) {}
    }
    _pyBinCache = null; return null;
  }
  function ensureCleanScript() {
    const dst = path.join(app.getPath('userData'), 'pointcloud_clean.py');
    const src = path.join(__dirname, 'tools', 'pointcloud_clean.py');
    const content = fs.readFileSync(src, 'utf8');
    let need = true;
    try { if (fs.existsSync(dst) && fs.readFileSync(dst, 'utf8') === content) need = false; } catch (_) {}
    if (need) fs.writeFileSync(dst, content);
    return dst;
  }
  function runPyClean(py, script, payload) {
    return new Promise((resolve) => {
      const cp = require('child_process');
      let ch;
      try { ch = cp.spawn(py, [script], { windowsHide: true }); }
      catch (e) { resolve({ ok: false, error: 'spawn_failed', needPython: true }); return; }
      let out = '', err = '';
      const to = setTimeout(() => { try { ch.kill(); } catch (_) {} resolve({ ok: false, error: 'timeout' }); }, 20 * 60 * 1000);
      ch.stdout.on('data', (d) => { out += d; });
      ch.stderr.on('data', (d) => { err += d; });
      ch.on('error', (e) => { clearTimeout(to); resolve({ ok: false, error: 'spawn_failed:' + (e && e.message), needPython: true }); });
      ch.on('close', () => {
        clearTimeout(to);
        try {
          const line = out.trim().split('\n').filter(Boolean).pop() || '';
          resolve(JSON.parse(line));
        } catch (_) { resolve({ ok: false, error: 'bad_output', stderr: String(err).slice(-800), raw: String(out).slice(-800) }); }
      });
      try { ch.stdin.write(JSON.stringify(payload)); ch.stdin.end(); } catch (_) {}
    });
  }
  // CloudCompare CLI — опциональный профессиональный движок очистки (вызывается как отдельный
  // процесс, GPL-безопасно). Сам CloudCompare устанавливает пользователь.
  let _ccBinCache;
  function ccBin() {
    if (_ccBinCache !== undefined) return _ccBinCache;
    const cands = [];
    try { const s = readSettings(); if (s && s.cloudComparePath) cands.push(String(s.cloudComparePath)); } catch (_) {}
    if (process.env.CLOUDCOMPARE) cands.push(process.env.CLOUDCOMPARE);
    // v1034: встроенный портативный CloudCompare (внутри приложения / userData) — «готовый редактор», ничего ставить не надо.
    try {
      const ccDirs = [];
      if (process.resourcesPath) ccDirs.push(path.join(process.resourcesPath, 'cloudcompare'));
      ccDirs.push(path.join(__dirname, 'resources', 'cloudcompare'));
      try { ccDirs.push(path.join(app.getPath('userData'), 'cloudcompare')); } catch (_) {}
      try { if (process.env.LOCALAPPDATA) ccDirs.push(path.join(process.env.LOCALAPPDATA, 'BIMTwin', 'cloudcompare')); } catch (_) {}
      for (const d of ccDirs) {
        if (process.platform === 'win32') cands.push(path.join(d, 'CloudCompare.exe'));
        else if (process.platform === 'darwin') cands.push(path.join(d, 'CloudCompare.app', 'Contents', 'MacOS', 'CloudCompare'));
        else cands.push(path.join(d, 'CloudCompare'), path.join(d, 'cloudcompare'));
      }
    } catch (_) {}
    if (process.platform === 'win32') { cands.push('C:\\Program Files\\CloudCompare\\CloudCompare.exe', 'C:\\Program Files (x86)\\CloudCompare\\CloudCompare.exe'); }
    else if (process.platform === 'darwin') { cands.push('/Applications/CloudCompare.app/Contents/MacOS/CloudCompare'); }
    for (const c of cands) { try { if (c && (c.indexOf('/') >= 0 || c.indexOf('\\') >= 0) && fs.existsSync(c)) { _ccBinCache = c; return c; } } catch (_) {} }
    const cp = require('child_process');
    for (const name of ['CloudCompare', 'cloudcompare', 'cloudcompare.CloudCompare']) {
      try { const w = cp.spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { windowsHide: true }); if (w && w.status === 0 && String(w.stdout).trim()) { _ccBinCache = String(w.stdout).trim().split(/\r?\n/)[0]; return _ccBinCache; } } catch (_) {}
    }
    _ccBinCache = null; return null;
  }
  function plyVertexCount(fp) {
    try {
      const fd = fs.openSync(fp, 'r'); const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, 4096, 0); fs.closeSync(fd);
      const head = buf.slice(0, n).toString('latin1');
      const m = head.match(/element\s+vertex\s+(\d+)/i);
      return m ? parseInt(m[1], 10) : null;
    } catch (_) { return null; }
  }
  let _ccCleanProc = null;
  function runCC(bin, inPly, outPly, ops, count) {
    return new Promise((resolve) => {
      const cp = require('child_process');
      const n = Number(count) || 0;
      const args = ['-SILENT', '-AUTO_SAVE', 'OFF', '-O', inPly];
      let hasClean = false;
      for (const op of (ops || [])) {
        if (op.type === 'auto') {
          // v1042: авто-очистка. Для очень больших облаков сначала прореживаем воксельно,
          // иначе SOR по 78 млн точек считает соседей часами (раньше «висело» >8 мин).
          if (n > 12000000 || op.subsample) { const voxel = Number(op.voxel) > 0 ? Number(op.voxel) : (n > 40000000 ? 0.02 : 0.01); args.push('-SS', 'SPATIAL', String(voxel)); }
          const k = Number(op.k || op.minPts || 6); const s = Number(op.std || 1.0); args.push('-SOR', String(k), String(s)); hasClean = true;
        }
        else if (op.type === 'denoise' || op.type === 'statistical') { const k = Number(op.k || op.minPts || 6); const s = Number(op.std || 1.0); args.push('-SOR', String(k), String(s)); hasClean = true; }
        else if (op.type === 'downsample') { const d = Number(op.voxel || 0.01); args.push('-SS', 'SPATIAL', String(d)); hasClean = true; }
      }
      if (!hasClean) args.push('-SOR', '6', '1.0');
      args.push('-C_EXPORT_FMT', 'PLY', '-NO_TIMESTAMP', '-SAVE_CLOUDS', 'FILE', outPly);
      let ch;
      try { ch = cp.spawn(bin, args, { windowsHide: true }); }
      catch (e) { resolve({ ok: false, error: 'cc_spawn_failed', needCloudCompare: true }); return; }
      _ccCleanProc = ch;
      let err = '';
      const to = setTimeout(() => { try { ch.kill(); } catch (_) {} _ccCleanProc = null; resolve({ ok: false, error: 'timeout' }); }, 20 * 60 * 1000);
      ch.stderr.on('data', (d) => { err += d; });
      ch.on('error', () => { clearTimeout(to); _ccCleanProc = null; resolve({ ok: false, error: 'cc_spawn_failed', needCloudCompare: true }); });
      ch.on('close', (code) => {
        clearTimeout(to); _ccCleanProc = null;
        if (!fs.existsSync(outPly)) { resolve({ ok: false, error: 'cc_no_output', stderr: String(err).slice(-800) }); return; }
        resolve({ ok: true, engine: 'cloudcompare', code });
      });
    });
  }
  ipcMain.handle('bim:cleanStatus', async () => {
    try {
      const cc = !!ccBin();
      const py = pythonBin();
      if (!py) return { ok: true, python: false, open3d: false, numpy: false, cloudCompare: cc };
      const script = ensureCleanScript();
      const r = await runPyClean(py, script, { mode: 'status' });
      return { ok: true, python: true, pythonBin: py, open3d: !!(r && r.open3d), numpy: !!(r && r.numpy), pyVersion: (r && r.python) || null, cloudCompare: cc };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('bim:cleanCloud', async (_e, a) => {
    let tmpIn = null;
    try {
      a = a || {};
      const abs = String(a.path || '');
      if (!abs) return { ok: false, error: 'no_path' };
      if (!fs.existsSync(abs)) return { ok: false, error: 'not_found' };
      const ext = path.extname(abs).toLowerCase();
      if (ext !== '.ply' && !CLOUD_EXT_ALLOW.has(ext)) return { ok: false, error: 'ext_not_allowed' };
      // Движок выбираем ДО тяжёлого парсинга.
      let engine = a.engine || 'auto';
      if (engine === 'auto') engine = ccBin() ? 'cloudcompare' : 'python';
      // CloudCompare открывает LAS/LAZ/E57/PCD/PLY/PTS/XYZ напрямую -> НЕ парсим в JS.
      // (Синхронный парсинг гигантского LAS в main-процессе раньше «вешал» приложение
      //  навсегда -> авто-очистка грузилась бесконечно.)
      const CC_DIRECT = new Set(['.ply', '.las', '.laz', '.e57', '.ptx', '.pcd', '.pts', '.xyz', '.xyzrgb']);
      let inPly = abs;
      if (ext !== '.ply' && !(engine === 'cloudcompare' && CC_DIRECT.has(ext))) {
        const maxPoints = Number(a.maxPoints) > 0 ? Number(a.maxPoints) : 120000000;
        const pr = await cloud.parseCloudFileAsync(abs, { maxPoints });
        if (!pr || !pr.ok) return { ok: false, error: 'parse_failed' };
        if (pr.kind && pr.kind !== 'points') return { ok: false, error: 'not_points' };
        const base = path.join(app.getPath('userData'), 'clean');
        fs.mkdirSync(base, { recursive: true });
        tmpIn = path.join(base, 'in-' + Date.now() + '.ply');
        const hasColor = !!(pr.meta && pr.meta.colored) && !!(pr.col && pr.col.length);
        writePlyBinaryToDisk(tmpIn, pr.pos, pr.col, hasColor);
        inPly = tmpIn;
      }
      let outp = String(a.output || '');
      if (!outp) {
        const b = path.basename(abs).replace(/\.[^.]+$/, '');
        const dir = path.dirname(abs);
        outp = path.join(dir, b + '_clean.ply');
        try { fs.accessSync(dir, fs.constants.W_OK); }
        catch (_) { const ub = path.join(app.getPath('userData'), 'clean'); fs.mkdirSync(ub, { recursive: true }); outp = path.join(ub, b + '_clean.ply'); }
      }
      const ops = Array.isArray(a.ops) && a.ops.length ? a.ops : [{ type: 'denoise' }];
      // Движок уже выбран выше (engine): auto -> CloudCompare если установлен, иначе Python (Open3D->NumPy).
      if (engine === 'cloudcompare') {
        const cc = ccBin();
        if (!cc) return { ok: false, error: 'no_cloudcompare', needCloudCompare: true };
        const inCount = plyVertexCount(inPly);
        const r = await runCC(cc, inPly, outp, ops, Number(a.count) || inCount || 0);
        if (!r.ok) return r;
        const outCount = plyVertexCount(outp);
        return { ok: true, engine: 'cloudcompare', path: outp, inputCount: inCount, outputCount: outCount, removed: (inCount != null && outCount != null) ? (inCount - outCount) : null };
      }
      const py = pythonBin();
      if (!py) return { ok: false, error: 'no_python', needPython: true };
      const script = ensureCleanScript();
      const res = await runPyClean(py, script, { input: inPly, output: outp, ops });
      return res;
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    finally { if (tmpIn) { try { fs.unlinkSync(tmpIn); } catch (_) {} } }
  });
  // v1042: прервать зависшую нативную очистку (UI-сторож вызывает это по таймауту).
  ipcMain.handle('bim:cleanAbort', async () => {
    try { const ch = _ccCleanProc; if (ch) { try { ch.kill(); } catch (_) {} } _ccCleanProc = null; return { ok: true }; }
    catch (e) { return { ok: false }; }
  });

  // v1034: CloudCompare как «готовый редактор» — открыть облако в его GUI, по закрытию переимпортировать результат.
  ipcMain.handle('bim:ccStatus', async () => {
    try { const b = ccBin(); return { ok: true, cloudCompare: !!b, path: b || null }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('bim:ccFolder', async () => {
    try {
      const dir = path.join(app.getPath('userData'), 'cloudcompare');
      fs.mkdirSync(dir, { recursive: true });
      try { require('electron').shell.openPath(dir); } catch (_) {}
      return { ok: true, path: dir };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('bim:installCloudCompare', async () => {
    // Надёжного прямого URL к Windows-бинарю нет: открываем офиц. страницу загрузки и целевую папку.
    try {
      const dir = path.join(app.getPath('userData'), 'cloudcompare');
      fs.mkdirSync(dir, { recursive: true });
      const sh = require('electron').shell;
      try { sh.openExternal('https://www.cloudcompare.org/release/'); } catch (_) {}
      try { sh.openPath(dir); } catch (_) {}
      return { ok: true, folder: dir, message: 'Скачайте «7zip (64 bits)», распакуйте так, чтобы в открытой папке появился CloudCompare.exe' };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  // v1035: авто-скачивание + тихая установка офиц. CloudCompare (тот же, что в установщике).
  ipcMain.handle('bim:downloadCloudCompare', async () => {
    try {
      if (process.platform !== 'win32') return { ok: false, error: 'win_only', message: 'Авто-установка CloudCompare доступна на Windows. Скачайте вручную с cloudcompare.org' };
      const have = ccBin(); if (have) return { ok: true, already: true, path: have, message: 'CloudCompare уже установлен' };
      const cands = [];
      try { if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'setup-cloudcompare.ps1')); } catch (_) {}
      cands.push(path.join(__dirname, 'scripts', 'setup-cloudcompare.ps1'));
      let ps = null; for (const c of cands) { try { if (c && fs.existsSync(c)) { ps = c; break; } } catch (_) {} }
      if (!ps) return { ok: false, error: 'no_script', message: 'Скрипт установки CloudCompare не найден' };
      const base = process.env.LOCALAPPDATA || app.getPath('userData');
      const dest = path.join(base, 'BIMTwin', 'cloudcompare');
      const cp = require('child_process');
      let ch;
      try { ch = cp.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-Dest', dest], { windowsHide: true }); }
      catch (e) { return { ok: false, error: 'spawn_failed', message: 'Не удалось запустить PowerShell' }; }
      let out = '';
      const win = (BrowserWindow.getAllWindows && BrowserWindow.getAllWindows()[0]) || null;
      const send = (m) => { try { if (win && !win.isDestroyed()) win.webContents.send('bim:ccProgress', m); } catch (_) {} };
      if (ch.stdout) ch.stdout.on('data', (d) => { const s = d.toString(); out += s; s.split(/\r?\n/).forEach((l) => { if (l.trim()) send(l.trim()); }); });
      if (ch.stderr) ch.stderr.on('data', (d) => { out += d.toString(); });
      const code = await new Promise((resolve) => { ch.on('error', () => resolve(-1)); ch.on('close', (c) => resolve(c)); });
      _ccBinCache = undefined; // сброс кэша, чтобы ccBin() переобнаружил бинарь
      const bin = ccBin();
      if (bin) return { ok: true, path: bin, code, message: 'CloudCompare установлен' };
      return { ok: false, code, message: 'Не удалось установить CloudCompare (код ' + code + ')', out: out.slice(-600) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('bim:editInCloudCompare', async (_e, a) => {
    try {
      a = a || {};
      const abs = String(a.path || '');
      if (!abs) return { ok: false, error: 'no_path' };
      if (!fs.existsSync(abs)) return { ok: false, error: 'not_found' };
      const cc = ccBin();
      if (!cc) return { ok: false, error: 'no_cloudcompare', needCloudCompare: true };
      const base = path.join(app.getPath('userData'), 'cc-edit');
      fs.mkdirSync(base, { recursive: true });
      const stem = path.basename(abs).replace(/\.[^.]+$/, '') || 'cloud';
      const work = path.join(base, stem + '.ply');
      const ext = path.extname(abs).toLowerCase();
      if (ext === '.ply') {
        fs.copyFileSync(abs, work);
      } else {
        if (!CLOUD_EXT_ALLOW.has(ext)) return { ok: false, error: 'ext_not_allowed' };
        const maxPoints = Number(a.maxPoints) > 0 ? Number(a.maxPoints) : 120000000;
        const pr = await cloud.parseCloudFileAsync(abs, { maxPoints });
        if (!pr || !pr.ok) return { ok: false, error: 'parse_failed' };
        if (pr.kind && pr.kind !== 'points') return { ok: false, error: 'not_points' };
        const hasColor = !!(pr.meta && pr.meta.colored) && !!(pr.col && pr.col.length);
        writePlyBinaryToDisk(work, pr.pos, pr.col, hasColor);
      }
      let before = 0; try { before = fs.statSync(work).mtimeMs; } catch (_) {}
      const cp = require('child_process');
      let ch;
      try { ch = cp.spawn(cc, [work], { windowsHide: false }); }
      catch (e) { return { ok: false, error: 'cc_spawn_failed', needCloudCompare: true }; }
      const code = await new Promise((resolve) => { ch.on('error', () => resolve(-1)); ch.on('close', (c) => resolve(c)); });
      let after = before, changed = false, outCount = null;
      try { after = fs.statSync(work).mtimeMs; } catch (_) {}
      changed = after > before;
      if (changed) { outCount = plyVertexCount(work); return { ok: true, path: work, changed: true, exitCode: code, outputCount: outCount }; }
      // Фолбэк: если юзер сохранил «Save as» в ту же папку — возьмём самый свежий .ply.
      try {
        const files = fs.readdirSync(base).filter((f) => /\.ply$/i.test(f)).map((f) => path.join(base, f));
        let newest = null, nt = before;
        for (const f of files) { try { const m = fs.statSync(f).mtimeMs; if (m > nt) { nt = m; newest = f; } } catch (_) {} }
        if (newest) return { ok: true, path: newest, changed: true, exitCode: code, outputCount: plyVertexCount(newest) };
      } catch (_) {}
      return { ok: true, path: work, changed: false, exitCode: code, outputCount: null };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // v1041: CloudCompare ВСТРОЕННЫЙ прямо в окно BIM Twin (Windows) — репарентинг нативного
  // окна CloudCompare внутрь панели приложения через постоянный PowerShell-помощник
  // (user32 SetParent/MoveWindow). GPL-безопасно: CloudCompare остаётся отдельным процессом,
  // код не линкуется и не смешивается — мы лишь переносим его окно как дочернее.
  // На не-Windows / при сбое возвращаем fallbackExternal:true → рендерер откроет его отдельно.
  let _embedProc = null;
  function embedHelper() {
    if (_embedProc && !_embedProc.killed) return _embedProc;
    const cands = [];
    try { if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'embed-window.ps1')); } catch (_) {}
    cands.push(path.join(__dirname, 'scripts', 'embed-window.ps1'));
    let ps = null; for (const c of cands) { try { if (c && fs.existsSync(c)) { ps = c; break; } } catch (_) {} }
    if (!ps) return null;
    const cp = require('child_process');
    try {
      _embedProc = cp.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], { windowsHide: true });
      _embedProc.on('close', () => { _embedProc = null; });
      _embedProc.on('error', () => { _embedProc = null; });
      if (_embedProc.stdout) _embedProc.stdout.on('data', () => {}); // сток вывода, чтобы буфер не переполнялся
      if (_embedProc.stderr) _embedProc.stderr.on('data', () => {});
    } catch (_) { _embedProc = null; }
    return _embedProc;
  }
  function embedSend(obj) {
    try { const h = embedHelper(); if (h && h.stdin && h.stdin.writable) { h.stdin.write(JSON.stringify(obj) + '\n'); return true; } } catch (_) {}
    return false;
  }
  function parentHwndDecimal(win) {
    try {
      if (!win || win.isDestroyed()) return null;
      const buf = win.getNativeWindowHandle();
      if (!buf || !buf.length) return null;
      if (buf.length >= 8) return buf.readBigUInt64LE(0).toString();
      return String(buf.readUInt32LE(0));
    } catch (_) { return null; }
  }
  let _ccEmbedProc = null;
  ipcMain.handle('bim:embedCloudCompare', async (_e, a) => {
    try {
      if (process.platform !== 'win32') return { ok: false, error: 'win_only', fallbackExternal: true };
      a = a || {};
      const abs = String(a.path || '');
      if (!abs) return { ok: false, error: 'no_path' };
      if (!fs.existsSync(abs)) return { ok: false, error: 'not_found' };
      const cc = ccBin();
      if (!cc) return { ok: false, error: 'no_cloudcompare', needCloudCompare: true };
      const win = BrowserWindow.fromWebContents(_e.sender) || (BrowserWindow.getAllWindows() || [])[0] || null;
      const parentDec = win ? parentHwndDecimal(win) : null;
      if (!parentDec) return { ok: false, error: 'no_parent_hwnd', fallbackExternal: true };
      if (!embedHelper()) return { ok: false, error: 'no_embed_helper', fallbackExternal: true };
      // v1042 КРИТИЧНО: CloudCompare сам читает LAS/LAZ/E57/PCD/PLY/PTS/XYZ. Раньше мы
      // синхронно парсили гигантский LAS -> PLY прямо в main-процессе (78 млн точек ≈ 20+ c),
      // из-за чего приложение «зависало» («не отвечает»), команды позиционирования копились,
      // а окно CloudCompare не успевало встроиться и открывалось отдельно. Теперь открываем
      // ИСХОДНЫЙ файл напрямую — старт мгновенный, main-поток не блокируется.
      const ext = path.extname(abs).toLowerCase();
      if (!CLOUD_EXT_ALLOW.has(ext)) return { ok: false, error: 'ext_not_allowed' };
      const work = abs;
      const watchDir = path.dirname(abs);
      const launchTs = Date.now();
      const CLOUD_RE = /\.(ply|las|laz|e57|pcd|pts|xyz|xyzrgb)$/i;
      let before = 0; try { before = fs.statSync(abs).mtimeMs; } catch (_) {}
      // Снимок «до»: облачные файлы в папке (ловим «Сохранить как…» под новым именем).
      const snapshot = {};
      try { for (const f of fs.readdirSync(watchDir)) { if (CLOUD_RE.test(f)) { try { snapshot[f] = fs.statSync(path.join(watchDir, f)).mtimeMs; } catch (_) {} } } } catch (_) {}
      const cp = require('child_process');
      let ch;
      try { ch = cp.spawn(cc, [work], { windowsHide: false }); }
      catch (e) { return { ok: false, error: 'cc_spawn_failed', needCloudCompare: true, fallbackExternal: true }; }
      _ccEmbedProc = ch;
      const b = a.bounds || {};
      embedSend({ cmd: 'embed', pid: ch.pid, parent: String(parentDec), x: Math.round(b.x || 0), y: Math.round(b.y || 0), w: Math.max(80, Math.round(b.w || 800)), h: Math.max(80, Math.round(b.h || 600)) });
      const code = await new Promise((resolve) => { ch.on('error', () => resolve(-1)); ch.on('close', (c) => resolve(c)); });
      _ccEmbedProc = null;
      try { embedSend({ cmd: 'release' }); } catch (_) {}
      // 1) Тот же файл перезаписан (Ctrl+S поверх)?
      let after = before; try { after = fs.statSync(abs).mtimeMs; } catch (_) {}
      if (after > before) { return { ok: true, embedded: true, path: abs, changed: true, exitCode: code, outputCount: (/\.ply$/i.test(abs) ? plyVertexCount(abs) : null) }; }
      // 2) Иначе — самый свежий облачный файл в папке, созданный/изменённый после запуска.
      try {
        let newest = null, nt = launchTs - 1500;
        for (const f of fs.readdirSync(watchDir)) {
          if (!CLOUD_RE.test(f)) continue;
          const fp = path.join(watchDir, f);
          let m = 0; try { m = fs.statSync(fp).mtimeMs; } catch (_) { continue; }
          const prev = snapshot[f];
          if ((prev === undefined || m > prev) && m > nt) { nt = m; newest = fp; }
        }
        if (newest) return { ok: true, embedded: true, path: newest, changed: true, exitCode: code, outputCount: (/\.ply$/i.test(newest) ? plyVertexCount(newest) : null) };
      } catch (_) {}
      return { ok: true, embedded: true, path: abs, changed: false, exitCode: code, outputCount: null };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('bim:ccEmbedBounds', async (_e, a) => {
    try { a = a || {}; embedSend({ cmd: 'move', x: Math.round(a.x || 0), y: Math.round(a.y || 0), w: Math.max(80, Math.round(a.w || 800)), h: Math.max(80, Math.round(a.h || 600)) }); return { ok: true }; }
    catch (e) { return { ok: false }; }
  });
  ipcMain.handle('bim:ccEmbedClose', async () => {
    try { embedSend({ cmd: 'release' }); const ch = _ccEmbedProc; if (ch) { try { ch.kill(); } catch (_) {} } return { ok: true }; }
    catch (e) { return { ok: false }; }
  });

  // ---------- Геометрия облака: отклонения / меширование / регистрация / PDAL ----------
  // Отдельный Python-сайдкар (tools/pointcloud_geometry.py). deviate/register работают
  // на чистом NumPy (точнее — со SciPy), mesh требует Open3D, pdal — модуль/CLI PDAL.
  function ensureGeomScript() {
    const dst = path.join(app.getPath('userData'), 'pointcloud_geometry.py');
    const src = path.join(__dirname, 'tools', 'pointcloud_geometry.py');
    const content = fs.readFileSync(src, 'utf8');
    let need = true;
    try { if (fs.existsSync(dst) && fs.readFileSync(dst, 'utf8') === content) need = false; } catch (_) {}
    if (need) fs.writeFileSync(dst, content);
    return dst;
  }
  // Приводит вход к .ply (конвертирует LAS/LAZ/E57/… при необходимости). Возвращает {ply,tmp} или {error}.
  async function ensurePlyInput(abs, maxPoints) {
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.ply') return { ply: abs, tmp: null };
    if (!CLOUD_EXT_ALLOW.has(ext)) return { error: 'ext_not_allowed' };
    const mp = Number(maxPoints) > 0 ? Number(maxPoints) : 120000000;
    const pr = await cloud.parseCloudFileAsync(abs, { maxPoints: mp });
    if (!pr || !pr.ok) return { error: 'parse_failed' };
    if (pr.kind && pr.kind !== 'points') return { error: 'not_points' };
    const base = path.join(app.getPath('userData'), 'geom');
    fs.mkdirSync(base, { recursive: true });
    const tmp = path.join(base, 'in-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.ply');
    const hasColor = !!(pr.meta && pr.meta.colored) && !!(pr.col && pr.col.length);
    writePlyBinaryToDisk(tmp, pr.pos, pr.col, hasColor);
    return { ply: tmp, tmp };
  }
  // Registration must see both inputs in the same viewer-local Y-up frame.
  // Parsing even an existing PLY is intentional: otherwise its raw world or
  // vendor coordinates bypass centring/axis conversion and produce a false ICP.
  async function ensureGeomPointInput(abs, maxPoints) {
    const ext = path.extname(abs).toLowerCase();
    if (!CLOUD_EXT_ALLOW.has(ext)) return { error: 'ext_not_allowed' };
    const mp = Number(maxPoints) > 0 ? Number(maxPoints) : 120000000;
    const pr = await cloud.parseCloudFileAsync(abs, { maxPoints: mp });
    if (!pr || !pr.ok) return { error: 'parse_failed', message: (pr && pr.message) || '' };
    if ((pr.kind && pr.kind !== 'points') || !pr.pos || !pr.pos.length) return { error: 'not_points' };
    const base = path.join(app.getPath('userData'), 'geom');
    fs.mkdirSync(base, { recursive: true });
    const tmp = path.join(base, 'register-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9) + '.ply');
    const hasColor = !!(pr.meta && pr.meta.colored) && !!(pr.col && pr.col.length);
    try {
      // pr.pos is already centred and converted to the viewer's Y-up frame.
      writePlyBinaryToDisk(tmp, pr.pos, pr.col, hasColor, { upAxis: 'y', coordinateFrame: 'viewer-local' });
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      return { error: 'ply_write_failed', message: String((e && e.message) || e) };
    }
    return { ply: tmp, tmp, meta: pr.meta || {}, count: pr.count || pr.pos.length / 3, pos: pr.pos, col: pr.col || null, hasColor: hasColor };
  }
  function validGeomSourceTransform(meta) {
    const x = meta && meta.srcXform;
    return !!(x && (x.axis === 'zup' || x.axis === 'yup') && Array.isArray(x.t) && x.t.length >= 3 && x.t.slice(0, 3).every(Number.isFinite));
  }
  // Convert viewer-local Y-up points from one reversible source frame into another.
  // Use Float64 during the world-coordinate subtraction so UTM-scale offsets do not
  // erase millimetre changes before the result is written to the Python sidecar.
  function mapGeomPositionsToFrame(pos, sourceMeta, targetMeta) {
    if (!validGeomSourceTransform(sourceMeta) || !validGeomSourceTransform(targetMeta)) return null;
    const src = sourceMeta.srcXform, dst = targetMeta.srcXform;
    // Transform in place: registration on multi-million-point scans must not
    // allocate a second full cloud-sized array in the Electron main process.
    const out = pos;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const wx = x + src.t[0];
      const wy = src.axis === 'zup' ? -z + src.t[1] : y + src.t[1];
      const wz = src.axis === 'zup' ? y + src.t[2] : z + src.t[2];
      if (dst.axis === 'zup') {
        out[i] = wx - dst.t[0];
        out[i + 1] = wz - dst.t[2];
        out[i + 2] = -(wy - dst.t[1]);
      } else {
        out[i] = wx - dst.t[0];
        out[i + 1] = wy - dst.t[1];
        out[i + 2] = wz - dst.t[2];
      }
    }
    return out;
  }
  function writeGeomPointInput(input, pos, frameName) {
    if (!input || !input.tmp || !pos) return false;
    writePlyBinaryToDisk(input.tmp, pos, input.col, input.hasColor, {
      upAxis: 'y', coordinateFrame: frameName || 'comparison-viewer-local'
    });
    input.pos = pos;
    return true;
  }
  function geomDefaultOut(abs, suffix) {
    const b = path.basename(abs).replace(/\.[^.]+$/, '');
    const dir = path.dirname(abs);
    let outp = path.join(dir, b + suffix);
    try { fs.accessSync(dir, fs.constants.W_OK); }
    catch (_) { const ub = path.join(app.getPath('userData'), 'geom'); fs.mkdirSync(ub, { recursive: true }); outp = path.join(ub, b + suffix); }
    return outp;
  }
  ipcMain.handle('bim:geomStatus', async () => {
    try {
      const py = pythonBin();
      if (!py) return { ok: true, python: false, numpy: false, scipy: false, open3d: false, pdal: false, cloudCompare: !!ccBin() };
      const script = ensureGeomScript();
      const r = await runPyClean(py, script, { mode: 'status' });
      return { ok: true, python: true, pythonBin: py, numpy: !!(r && r.numpy), scipy: !!(r && r.scipy), open3d: !!(r && r.open3d), pdal: !!(r && r.pdal), pyVersion: (r && r.python) || null, cloudCompare: !!ccBin() };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('bim:deviation', async (_e, a) => {
    const tmps = [];
    try {
      a = a || {};
      const refAbs = String(a.reference || ''), cmpAbs = String(a.compared || '');
      if (!refAbs || !cmpAbs) return { ok: false, error: 'no_path' };
      if (!fs.existsSync(refAbs) || !fs.existsSync(cmpAbs)) return { ok: false, error: 'not_found' };
      const py = pythonBin(); if (!py) return { ok: false, error: 'no_python', needPython: true };
      const ri = await ensureGeomPointInput(refAbs, a.maxPoints);
      if (ri.error) return { ok: false, error: ri.error, message: ri.message || '' };
      if (ri.tmp) tmps.push(ri.tmp);
      const ci = await ensureGeomPointInput(cmpAbs, a.maxPoints);
      if (ci.error) return { ok: false, error: ci.error, message: ci.message || '' };
      if (ci.tmp) tmps.push(ci.tmp);
      const G = require('./renderer/georef');
      const crsStatus = G.compareCrsWkt(
        (ri.meta && ri.meta.crsWkt) || null,
        (ci.meta && ci.meta.crsWkt) || null
      );
      const referenceHasTransform = validGeomSourceTransform(ri.meta);
      const comparedHasTransform = validGeomSourceTransform(ci.meta);
      const frameCheck = {
        crsStatus: crsStatus,
        referenceHasTransform: referenceHasTransform,
        comparedHasTransform: comparedHasTransform,
        targetOutputIsGeoreferenced: comparedHasTransform
      };
      if (crsStatus === 'different') {
        return { ok: false, error: 'crs_mismatch', frameCheck: frameCheck };
      }
      if ((crsStatus !== 'same' || !referenceHasTransform || !comparedHasTransform) && a.confirmFrame !== true) {
        return { ok: false, error: 'frame_confirmation_required', needFrameConfirmation: true, frameCheck: frameCheck };
      }
      const referenceInCompared = mapGeomPositionsToFrame(ri.pos, ri.meta, ci.meta);
      if (referenceInCompared) writeGeomPointInput(ri, referenceInCompared, 'compared-viewer-local');
      const out = String(a.output || '') || geomDefaultOut(cmpAbs, '_deviation.ply');
      const normPath = p => {
        const resolved = path.resolve(String(p));
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      };
      if (normPath(out) === normPath(refAbs) || normPath(out) === normPath(cmpAbs)) {
        return { ok: false, error: 'output_overwrites_input' };
      }
      const script = ensureGeomScript();
      const comparedFrame = comparedHasTransform ? {
        axis: ci.meta.srcXform.axis,
        t: ci.meta.srcXform.t.slice(0, 3)
      } : null;
      const r = await runPyClean(py, script, {
        mode: 'deviate', reference: ri.ply, compared: ci.ply, output: out,
        maxDist: a.maxDist, voxel: a.voxel, signed: !!a.signed,
        comparedFrame: comparedFrame,
        outputCrsWkt: comparedFrame ? ((ci.meta && ci.meta.crsWkt) || null) : null
      });
      if (r && r.ok) {
        r.frameCheck = frameCheck;
        r.outputFrame = comparedFrame ? 'target-source' : 'target-viewer-local';
        r.outputCrsWkt = comparedFrame ? ((ci.meta && ci.meta.crsWkt) || null) : null;
      }
      return r;
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    finally { for (const t of tmps) { try { fs.unlinkSync(t); } catch (_) {} } }
  });
  ipcMain.handle('bim:registerClouds', async (_e, a) => {
    const tmps = [];
    try {
      a = a || {};
      const srcAbs = String(a.source || ''), tgtAbs = String(a.target || '');
      if (!srcAbs || !tgtAbs) return { ok: false, error: 'no_path' };
      if (!fs.existsSync(srcAbs) || !fs.existsSync(tgtAbs)) return { ok: false, error: 'not_found' };
      const py = pythonBin(); if (!py) return { ok: false, error: 'no_python', needPython: true };
      const si = await ensureGeomPointInput(srcAbs, a.maxPoints);
      if (si.error) return { ok: false, error: si.error, message: si.message || '' };
      if (si.tmp) tmps.push(si.tmp);
      const ti = await ensureGeomPointInput(tgtAbs, a.maxPoints);
      if (ti.error) return { ok: false, error: ti.error, message: ti.message || '' };
      if (ti.tmp) tmps.push(ti.tmp);
      const G = require('./renderer/georef');
      const crsStatus = G.compareCrsWkt(
        (si.meta && si.meta.crsWkt) || null,
        (ti.meta && ti.meta.crsWkt) || null
      );
      const sourceHasTransform = validGeomSourceTransform(si.meta);
      const targetHasTransform = validGeomSourceTransform(ti.meta);
      const frameCheck = {
        crsStatus: crsStatus,
        sourceHasTransform: sourceHasTransform,
        targetHasTransform: targetHasTransform,
        targetOutputIsGeoreferenced: targetHasTransform
      };
      if (crsStatus === 'different') {
        return { ok: false, error: 'crs_mismatch', frameCheck: frameCheck };
      }
      if ((crsStatus !== 'same' || !sourceHasTransform || !targetHasTransform) && a.confirmFrame !== true) {
        return { ok: false, error: 'frame_confirmation_required', needFrameConfirmation: true, frameCheck: frameCheck };
      }
      const sourceInTarget = mapGeomPositionsToFrame(si.pos, si.meta, ti.meta);
      if (sourceInTarget) writeGeomPointInput(si, sourceInTarget, 'target-viewer-local');
      const out = String(a.output || '') || geomDefaultOut(srcAbs, '_registered.ply');
      const normPath = p => {
        const resolved = path.resolve(String(p));
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      };
      if (normPath(out) === normPath(srcAbs) || normPath(out) === normPath(tgtAbs)) {
        return { ok: false, error: 'output_overwrites_input' };
      }
      const script = ensureGeomScript();
      const targetTransform = targetHasTransform ? {
        axis: ti.meta.srcXform.axis,
        t: ti.meta.srcXform.t.slice(0, 3)
      } : null;
      const r = await runPyClean(py, script, {
        mode: 'register', source: si.ply, target: ti.ply, output: out,
        voxel: a.voxel, threshold: a.threshold, maxIter: a.maxIter,
        targetFrame: targetTransform,
        outputCrsWkt: targetTransform ? ((ti.meta && ti.meta.crsWkt) || null) : null
      });
      if (r && r.ok) {
        r.frameCheck = frameCheck;
        r.outputFrame = targetTransform ? 'target-source' : 'target-viewer-local';
        r.outputCrsWkt = targetTransform ? ((ti.meta && ti.meta.crsWkt) || null) : null;
      }
      return r;
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    finally { for (const t of tmps) { try { fs.unlinkSync(t); } catch (_) {} } }
  });
  ipcMain.handle('bim:meshCloud', async (_e, a) => {
    const tmps = [];
    try {
      a = a || {};
      const abs = String(a.path || ''); if (!abs) return { ok: false, error: 'no_path' };
      if (!fs.existsSync(abs)) return { ok: false, error: 'not_found' };
      const py = pythonBin(); if (!py) return { ok: false, error: 'no_python', needPython: true };
      const pi = await ensureGeomPointInput(abs, a.maxPoints);
      if (pi.error) return { ok: false, error: pi.error, message: pi.message || '' };
      if (pi.tmp) tmps.push(pi.tmp);
      const out = String(a.output || '') || geomDefaultOut(abs, '_mesh.ply');
      const normPath = p => {
        const resolved = path.resolve(String(p));
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      };
      if (normPath(out) === normPath(abs)) return { ok: false, error: 'output_overwrites_input' };
      const script = ensureGeomScript();
      const hasTransform = validGeomSourceTransform(pi.meta);
      const inputFrame = hasTransform ? {
        axis: pi.meta.srcXform.axis,
        t: pi.meta.srcXform.t.slice(0, 3)
      } : null;
      const r = await runPyClean(py, script, {
        mode: 'mesh', input: pi.ply, output: out, method: a.method || 'poisson',
        depth: a.depth, voxel: a.voxel, trim: a.trim,
        inputFrame: inputFrame,
        outputCrsWkt: inputFrame ? ((pi.meta && pi.meta.crsWkt) || null) : null
      });
      if (r && r.ok) {
        r.outputFrame = inputFrame ? 'source' : 'viewer-local';
        r.outputCrsWkt = inputFrame ? ((pi.meta && pi.meta.crsWkt) || null) : null;
      }
      return r;
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    finally { for (const t of tmps) { try { fs.unlinkSync(t); } catch (_) {} } }
  });
  ipcMain.handle('bim:pdalRun', async (_e, a) => {
    try {
      a = a || {};
      const py = pythonBin(); if (!py) return { ok: false, error: 'no_python', needPython: true };
      const script = ensureGeomScript();
      return await runPyClean(py, script, { mode: 'pdal', pipeline: a.pipeline, output: a.output });
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('bim:uploadDocument', (_e, a) => {
    const { file } = saveUpload(a.name, a.base64);
    // F1: если в этом же помещении/элементе уже есть загруженный документ с таким именем — создаём новую версию
    const data = store.getData();
    const room = (data.rooms || []).find(r => r.id === a.roomId);
    const existing = room && (room.documents || []).find(d => d.name === a.name && (d.element_id || null) === (a.elementId || null) && d.is_upload);
    if (existing) {
      const versions = Array.isArray(existing.versions) ? existing.versions.slice() : [];
      const curLabel = existing.version || 'v1';
      if (!versions.some(v => v.v === curLabel)) versions.push({ v: curLabel, file: existing.file, date: existing.date });
      const nextNum = versions.reduce((m, v) => Math.max(m, parseInt(String(v.v).replace(/\D/g, ''), 10) || 0), 0) + 1;
      versions.push({ v: 'v' + nextNum, file, date: new Date().toISOString().slice(0, 10) });
      return store.updateDocument(existing.id, { file, mime: a.mime || existing.mime, version: 'v' + nextNum, date: new Date().toISOString().slice(0, 10), versions });
    }
    return store.createDocument({ room_id: a.roomId, element_id: a.elementId || null, type: a.type || 'документ', name: a.name, author: a.author || '', file, mime: a.mime || '', is_upload: 1, version: 'v1', versions: [] });
  });
  ipcMain.handle('bim:uploadModel', (_e, a) => {
    const { file } = (a && a.srcPath && fs.existsSync(a.srcPath)) ? saveUploadFromPath(a.name, a.srcPath) : saveUpload(a.name, a.base64);
    return store.attachModel(a.roomId, { name: a.name, file, mime: a.mime || '', is_upload: 1 });
  });

  ipcMain.handle('bim:updateProject', (_e, patch) => store.updateProject(vPatch(patch)));
  ipcMain.handle('bim:createFloor', (_e, patch) => store.createFloor(vPatch(patch)));
  ipcMain.handle('bim:updateFloor', (_e, a) => { a = vArgs(a); return store.updateFloor(vId(a.id), vPatch(a.patch)); });
  ipcMain.handle('bim:deleteFloor', (_e, id) => store.deleteFloor(vId(id)));
  ipcMain.handle('bim:createRoom', (_e, a) => { a = vArgs(a); return store.createRoom(vId(a.floorId), vPatch(a.patch)); });
  ipcMain.handle('bim:updateRoom', (_e, a) => { a = vArgs(a); return store.updateRoom(vId(a.id), vPatch(a.patch)); });
  ipcMain.handle('bim:deleteRoom', (_e, id) => store.deleteRoom(vId(id)));
  ipcMain.handle('bim:createElement', (_e, a) => { a = vArgs(a); return store.createElement(vId(a.roomId), vPatch(a.patch)); });
  ipcMain.handle('bim:updateElement', (_e, a) => { a = vArgs(a); return store.updateElement(vId(a.id), vPatch(a.patch)); });
  ipcMain.handle('bim:deleteElement', (_e, id) => store.deleteElement(vId(id)));
  ipcMain.handle('bim:createDocument', (_e, patch) => store.createDocument(vPatch(patch)));
  ipcMain.handle('bim:updateDocument', (_e, a) => { a = vArgs(a); return store.updateDocument(vId(a.id), vPatch(a.patch)); });
  ipcMain.handle('bim:deleteDocument', (_e, id) => store.deleteDocument(vId(id)));

  ipcMain.handle('bim:importIFC', async (_e, a) => {
    a = vArgs(a);
    const text = Buffer.from(vStr(a.base64), 'base64').toString('utf8');
    const wres = await runIfcWorker(text);
    const parsed = (wres && wres.ok) ? wres.parsed : parseIFC(text); // фолбэк на синхронный разбор
    return linkIFC(parsed, a.targetRoomId);
  });

  ipcMain.handle('bim:analyzeRoom', (_e, roomId) => analyzeRoom(vId(roomId)));
  ipcMain.handle('bim:analyzeAll', () => analyzeAllRooms());
  ipcMain.handle('bim:analyzeDocument', (_e, docId) => {
    const data = store.getData();
    let room = null;
    for (const r of (data.rooms || [])) if ((r.documents || []).some(d => d.id === docId)) { room = r; break; }
    return room ? analyzeRoom(room.id) : { ok: false, error: 'doc_not_found' };
  });
  ipcMain.handle('bim:updateFinding', (_e, a) => { a = vArgs(a); return store.updateFinding(vId(a.id), vPatch(a.patch)); });
  ipcMain.handle('bim:addFindingComment', (_e, a) => { a = vArgs(a); return store.addFindingComment(vId(a.id), a.comment); });
  ipcMain.handle('bim:getSettings', () => readSettings());
  ipcMain.handle('bim:setSettings', (_e, patch) => { const saved = store.updateSettings ? store.updateSettings(encryptSettingsPatch(patch)) : {}; return decryptSettings(saved); });

  // Phase E: app info, data paths, updates
  ipcMain.handle('bim:getVersion', () => { try { return app.getVersion(); } catch (e) { return '0.0.0'; } });
  ipcMain.handle('bim:getPaths', () => {
    const p = {};
    try { p.userData = app.getPath('userData'); } catch (e) {}
    try { p.documents = app.getPath('documents'); } catch (e) {}
    p.uploads = store && store.uploadsDir ? store.uploadsDir : null;
    p.store = store && store.storePath ? store.storePath : null;
    p.mode = MODE;
    return p;
  });
  ipcMain.handle('bim:openPath', (_e, p) => { try { if (p) shell.openPath(p); return { ok: true }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; } });
  ipcMain.handle('bim:checkUpdates', async () => checkForUpdates());

  // Кастомные кнопки окна (frameless-режим)
  ipcMain.on('bim:win:min', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
  ipcMain.on('bim:win:max', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) { if (w.isMaximized()) w.unmaximize(); else w.maximize(); } });
  ipcMain.on('bim:win:close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });
  // v1156 — рендерер сообщает о несохранённых правках; при закрытии окна спросим сохранить.
  ipcMain.on('bim:setDirty', (e, v) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.__bimDirty = !!v; });
  ipcMain.on('bim:setProjectDirty', (e, v) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.__bimProjectDirty = !!v; });
  ipcMain.on('bim:closeConfirmed', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) { w.__bimDirty = false; w.__bimProjectDirty = false; w.__allowClose = true; w.close(); } });

  ipcMain.handle('bim:exportBackup', () => {
    const json = store.exportBackup();
    const p = path.join(app.getPath('userData'), 'backup-' + Date.now() + '.json');
    fs.writeFileSync(p, json);
    return p;
  });
  ipcMain.handle('bim:importBackup', (_e, json) => store.importBackup(json));

  // ---- Phase D1: projects ----
  ipcMain.handle('bim:listProjects', () => store.listProjects());
  ipcMain.handle('bim:createProject', (_e, patch) => store.createProject(vPatch(patch)));
  ipcMain.handle('bim:switchProject', (_e, id) => store.switchProject(vId(id)));
  ipcMain.handle('bim:deleteProject', (_e, id) => store.deleteProject(vId(id)));
  ipcMain.handle('bim:getProjectState', (_e, projectId) => store.getProjectState(projectId ? vId(projectId) : undefined));
  ipcMain.handle('bim:saveProjectState', (_e, a) => {
    a = vArgs(a);
    const revision = a.expectedRevision == null ? undefined : Number(a.expectedRevision);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new Error('invalid expectedRevision');
    const operation = a.operation == null ? null : vPatch(a.operation);
    const appVersion = a.appVersion == null ? app.getVersion() : vStr(a.appVersion);
    try {
      return store.saveProjectState(vPatch(a.state), {
        projectId: a.projectId ? vId(a.projectId) : undefined,
        expectedRevision: revision,
        operation: operation,
        appVersion: appVersion
      });
    } catch (error) {
      if (error && error.code === 'REVISION_CONFLICT') {
        return { ok: false, error: 'REVISION_CONFLICT', currentRevision: error.currentRevision };
      }
      throw error;
    }
  });
  ipcMain.handle('bim:undoProjectState', (_e, a) => {
    a = a == null ? {} : vArgs(a);
    return store.undoProjectState({
      projectId: a.projectId ? vId(a.projectId) : undefined,
      expectedRevision: a.expectedRevision == null ? undefined : Number(a.expectedRevision),
      appVersion: app.getVersion()
    });
  });
  ipcMain.handle('bim:redoProjectState', (_e, a) => {
    a = a == null ? {} : vArgs(a);
    return store.redoProjectState({
      projectId: a.projectId ? vId(a.projectId) : undefined,
      expectedRevision: a.expectedRevision == null ? undefined : Number(a.expectedRevision),
      appVersion: app.getVersion()
    });
  });
  ipcMain.handle('bim:listProjectRevisions', (_e, projectId) => store.listProjectRevisions(projectId ? vId(projectId) : undefined));
  ipcMain.handle('bim:recordProjectOperation', (_e, a) => {
    a = vArgs(a);
    return store.recordOperation(Object.assign({}, vPatch(a), { appVersion: a.appVersion || app.getVersion() }), a.projectId ? vId(a.projectId) : undefined);
  });
  ipcMain.handle('bim:listProjectOperations', (_e, a) => {
    a = a == null ? {} : vArgs(a);
    return store.listOperations(a.limit, a.projectId ? vId(a.projectId) : undefined);
  });
  ipcMain.handle('bim:saveProjectClassification', async (_e, a) => {
    a = vArgs(a);
    if (!store || !store.projectAssets) throw new Error('project asset storage is unavailable');
    const projectId = a.projectId ? vId(a.projectId) : store.getData().project.id;
    const cloudId = vId(a.cloudId);
    const expectedRevision = a.expectedRevision == null ? undefined : Number(a.expectedRevision);
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new Error('invalid expectedRevision');
    const before = store.getProjectState(projectId);
    if (expectedRevision !== undefined && before.revision !== expectedRevision) {
      return { ok: false, error: 'REVISION_CONFLICT', currentRevision: before.revision };
    }
    let sourceHash = a.sourceHash == null ? null : String(a.sourceHash).replace(/^sha256:/i, '').toLowerCase();
    const sourcePath = typeof a.sourcePath === 'string' ? a.sourcePath : '';
    if (!sourceHash && path.isAbsolute(sourcePath) && CLOUD_EXT_ALLOW.has(path.extname(sourcePath).toLowerCase())) {
      try { if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile()) sourceHash = await sha256File(sourcePath); } catch (_) {}
    }
    const metadata = store.projectAssets.saveClassification({
      projectId,
      cloudId,
      labels: payloadBuffer(a.labels),
      pointCount: a.pointCount,
      algorithm: a.algorithm,
      parameters: a.parameters,
      sourceHash,
      sourceTransform: a.sourceTransform,
      crsWkt: a.crsWkt,
      counts: a.counts
    });
    const next = before.payload;
    const at = next.classifications.findIndex(item => item && item.cloudId === cloudId);
    if (at >= 0) next.classifications[at] = metadata;
    else next.classifications.push(metadata);
    try {
      const saved = store.saveProjectState(next, {
        projectId,
        expectedRevision: before.revision,
        appVersion: app.getVersion(),
        operation: {
          operation: 'cloud.classify.structure',
          inputHash: metadata.sourceHash,
          parameters: {
            cloudId,
            algorithm: metadata.algorithm,
            options: metadata.parameters,
            pointCount: metadata.pointCount,
            sourceTransform: metadata.sourceTransform,
            classificationSha256: metadata.asset.sha256
          },
          output: { pointCount: metadata.pointCount, counts: metadata.counts, labelSha256: metadata.asset.sha256 },
          warnings: []
        }
      });
      return { ok: true, classification: metadata, state: saved };
    } catch (error) {
      if (error && error.code === 'REVISION_CONFLICT') {
        return { ok: false, error: 'REVISION_CONFLICT', currentRevision: error.currentRevision };
      }
      throw error;
    }
  });
  ipcMain.handle('bim:loadProjectClassification', (_e, a) => {
    a = a == null ? {} : vArgs(a);
    if (!store || !store.projectAssets) throw new Error('project asset storage is unavailable');
    const projectId = a.projectId ? vId(a.projectId) : store.getData().project.id;
    const cloudId = vId(a.cloudId);
    const state = store.getProjectState(projectId).payload;
    const entries = (state.classifications || []).filter(item => item && item.cloudId === cloudId);
    const item = a.sha256
      ? entries.find(x => x.asset && x.asset.sha256 === String(a.sha256).toLowerCase())
      : entries[entries.length - 1];
    if (!item || !item.asset) return { ok: false, error: 'CLASSIFICATION_NOT_FOUND' };
    const loaded = store.projectAssets.loadClassification(projectId, cloudId, item.asset.sha256);
    return { ok: true, classification: item, labels: loaded.labels, sha256: loaded.sha256, bytes: loaded.bytes };
  });
  ipcMain.handle('bim:listSectionPresets', () => store.listSectionPresets());
  ipcMain.handle('bim:saveSectionPreset', (_e, preset) => store.saveSectionPreset(vPatch(preset)));
  ipcMain.handle('bim:deleteSectionPreset', (_e, id) => store.deleteSectionPreset(vId(id)));

  // ---- Phase D2: users & assignment ----
  ipcMain.handle('bim:listUsers', () => store.listUsers());
  ipcMain.handle('bim:createUser', (_e, patch) => store.createUser(vPatch(patch)));
  ipcMain.handle('bim:updateUser', (_e, a) => { a = vArgs(a); return store.updateUser(vId(a.id), vPatch(a.patch)); });
  ipcMain.handle('bim:deleteUser', (_e, id) => store.deleteUser(vId(id)));
  ipcMain.handle('bim:assignFinding', (_e, a) => { a = vArgs(a); return store.assignFinding(vId(a.id), vPatch(a.patch)); });

  // ---- Phase D3: element discussions ----
  ipcMain.handle('bim:listDiscussions', (_e, elementId) => store.listDiscussions(elementId));
  ipcMain.handle('bim:createDiscussion', (_e, patch) => store.createDiscussion(vPatch(patch)));
  ipcMain.handle('bim:addDiscussionComment', (_e, a) => { a = vArgs(a); return store.addDiscussionComment(vId(a.id), a.comment); });
  ipcMain.handle('bim:setDiscussionStatus', (_e, a) => { a = vArgs(a); return store.setDiscussionStatus(vId(a.id), vStr(a.status)); });
  ipcMain.handle('bim:deleteDiscussion', (_e, id) => store.deleteDiscussion(vId(id)));

  // ---- Phase D4: export reports ----
  ipcMain.handle('bim:exportReport', async (_e, a) => {
    const data = store.getData();
    const meta = { title: 'Отчёт по находкам', subtitle: (data.project && data.project.name) || '' };
    const scope = (a && a.scope) || { type: 'project' };
    const format = (a && a.format) || 'csv';
    const out = report.build(data, scope, format, meta);
    const dir = safePath(['documents', 'userData']);
    const res = await dialog.showSaveDialog({ title: 'Сохранить отчёт', defaultPath: path.join(dir, 'otchet-' + Date.now() + '.' + out.ext), filters: [{ name: out.ext.toUpperCase(), extensions: [out.ext] }] });
    if (res.canceled || !res.filePath) return { canceled: true };
    fs.writeFileSync(res.filePath, out.encoding === 'binary' ? out.content : Buffer.from(out.content, 'utf8'));
    return { ok: true, path: res.filePath };
  });

  // ---- Phase D5: team sync bundle ----
  ipcMain.handle('bim:exportSync', async () => {
    const bundle = store.exportWorkspace();
    const files = {};
    try { for (const f of fs.readdirSync(store.uploadsDir)) { const abs = path.join(store.uploadsDir, f); if (fs.statSync(abs).isFile()) files[f] = fs.readFileSync(abs).toString('base64'); } } catch (e) {}
    bundle.files = files;
    const dir = safePath(['documents', 'userData']);
    const res = await dialog.showSaveDialog({ title: 'Экспорт рабочего пространства', defaultPath: path.join(dir, 'workspace-' + Date.now() + '.bimsync'), filters: [{ name: 'BIM Sync', extensions: ['bimsync', 'json'] }] });
    if (res.canceled || !res.filePath) return { canceled: true };
    fs.writeFileSync(res.filePath, JSON.stringify(bundle));
    return { ok: true, path: res.filePath };
  });
  ipcMain.handle('bim:importSync', async (_e, a) => {
    const res = await dialog.showOpenDialog({ title: 'Импорт синхронизации', properties: ['openFile'], filters: [{ name: 'BIM Sync', extensions: ['bimsync', 'json'] }] });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    const bundle = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
    if (bundle.files) { for (const name in bundle.files) { try { fs.writeFileSync(path.join(store.uploadsDir, name), Buffer.from(bundle.files[name], 'base64')); } catch (e) {} } }
    store.importWorkspace(bundle, { merge: !!(a && a.merge) });
    return { ok: true };
  });

  /* LCC2: нативный выбор папки через dialog */
  ipcMain.handle('lcc2:openFolder', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Выберите LCC2-папку',
      properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    const folder = res.filePaths[0];
    // Рекурсивно читаем все файлы
    const allFiles = [];
    function walk(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); }
        else { allFiles.push({ name: e.name, fullPath: full, size: 0 }); }
      }
    }
    walk(folder);
    return { canceled: false, folder, files: allFiles };
  });

  /* LCC2: чтение файла как ArrayBuffer */
  ipcMain.handle('lcc2:readFile', async (_e, fullPath) => {
    const buf = fs.readFileSync(fullPath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });
}

function safePath(keys) {
  for (const k of keys) { try { return app.getPath(k); } catch (e) {} }
  return app.getPath('userData');
}

// ---------- Phase E: auto-updates (offline-safe) ----------
let _autoUpdater = null;
function getAutoUpdater() {
  if (_autoUpdater !== null) return _autoUpdater;
  try { _autoUpdater = require('electron-updater').autoUpdater; }
  catch (e) { _autoUpdater = false; console.warn('[update] electron-updater недоступен:', e.message); }
  return _autoUpdater;
}

function setupAutoUpdate() {
  // Only meaningful for packaged, signed builds with a configured publish feed.
  if (!app.isPackaged) { console.log('[update] dev-режим: автопроверка обновлений пропущена'); return; }
  const au = getAutoUpdater();
  if (!au) return;
  try {
    if (process.env.BIMTWIN_UPDATE_URL) { try { au.setFeedURL({ provider: 'generic', url: process.env.BIMTWIN_UPDATE_URL }); } catch (e) { /* игнорируем */ } }
    au.autoDownload = false;
    au.on('update-available', (info) => { console.log('[update] доступно обновление', info && info.version); });
    au.on('update-not-available', () => { console.log('[update] обновлений нет'); });
    au.on('error', (err) => { console.warn('[update] ошибка', err && err.message); });
    au.checkForUpdates().catch((e) => console.warn('[update] проверка не удалась', e && e.message));
  } catch (e) { console.warn('[update] setup failed', e && e.message); }
}

async function checkForUpdates() {
  if (!app.isPackaged) return { ok: false, reason: 'dev', message: 'Автообновления работают только в установленной сборке.' };
  const au = getAutoUpdater();
  if (!au) return { ok: false, reason: 'no_module', message: 'Модуль обновлений не установлен (нужен онлайн-npm при сборке).' };
  try {
    const r = await au.checkForUpdates();
    const v = r && r.updateInfo && r.updateInfo.version;
    const cur = app.getVersion();
    if (v && v !== cur) return { ok: true, available: true, version: v, current: cur };
    return { ok: true, available: false, current: cur };
  } catch (e) {
    return { ok: false, reason: 'network', message: 'Не удалось проверить обновления: ' + (e && e.message || e) };
  }
}
