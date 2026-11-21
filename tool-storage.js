'use strict';
/**
 * tool-storage.js — r184: куда инструменты (P1/P2/P3) пишут результаты.
 *
 * Заказчик: сохраняем проект на диск D, а LAS/PLY-результаты почему-то появлялись в
 * `%APPDATA%\bim-twin` (p1-r151, p2p3-r155). Теперь ВСЕ выходные файлы инструментов пишутся
 * только в папку проекта:
 *   <Project>/output/<tool>-<timestamp>/   — результаты операций (LAS/PLY/PNG/JSON/PDF…)
 *   <Project>/temp/<tool>-<timestamp>/     — временные файлы операции, удаляются после завершения
 * Если у проекта нет своей папки — спрашиваем папку у пользователя (диалог через deps.chooseProjectFolder).
 * Без папки проекта/диалога операция не выполняется — в userData/AppData инструменты НЕ пишут.
 *
 * Модуль без Electron: для тестов чистые функции; мост передаёт deps:
 *   projectFolder() → {ok,path,own,root} | null        (текущая папка проекта, main: projectFolderInfo(false))
 *   chooseProjectFolder(event) → {ok,path,canceled}     (диалог выбора папки + assignProjectDir)
 *   userData                                           (для поиска/очистки старых p1-r151/p2p3-r155)
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LEGACY_DIRS = ['p1-r151', 'p2p3-r155'];
const OUTPUT_DIR = 'output';
const TEMP_DIR = 'temp';

function stamp() {
  const d = new Date();
  const z = (v) => String(v).padStart(2, '0');
  return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds());
}
function safeSegment(s, fallback) {
  const out = String(s == null ? '' : s).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').replace(/\s+/g, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 60);
  return out || fallback || 'tool';
}
function isInside(parent, child) {
  const p = path.resolve(String(parent || '')).toLowerCase();
  const c = path.resolve(String(child || '')).toLowerCase();
  return c === p || c.startsWith(p + path.sep);
}
function randomSuffix() { return Math.random().toString(36).slice(2, 6); }

/** Запись статистики по каталогу (без символических ссылок — только файлы внутри). */
function dirStats(dir) {
  const out = { exists: false, bytes: 0, files: 0, path: path.resolve(String(dir || '.')) };
  let st = null; try { st = fs.statSync(dir); } catch (_) { return out; }
  if (!st.isDirectory()) return out;
  out.exists = true;
  const walk = (d, depth) => {
    if (depth > 6) return;
    let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of list) {
      const p = path.join(d, it.name);
      try {
        if (it.isDirectory()) walk(p, depth + 1);
        else if (it.isFile()) { out.files++; out.bytes += fs.statSync(p).size; }
      } catch (_) { }
    }
  };
  walk(out.path, 0);
  return out;
}

/** Старые папки в userData (p1-r151, p2p3-r155): размер/файлы, без удаления. */
function legacyInfo(userData) {
  if (!userData || typeof userData !== 'string') return [];
  return LEGACY_DIRS.map((name) => {
    const p = path.join(userData, name);
    const s = dirStats(p);
    return { name, path: p, exists: s.exists, bytes: s.bytes, files: s.files };
  });
}
function legacySummary(userData) {
  const list = legacyInfo(userData).filter((x) => x.exists);
  return { dirs: list, bytes: list.reduce((a, x) => a + x.bytes, 0), files: list.reduce((a, x) => a + x.files, 0) };
}

/**
 * Безопасная очистка старых папок p1-r151/p2p3-r155.
 * Разрешаем удалять ТОЛЬКО каталог с точным именем из LEGACY_DIRS и только внутри userData
 * (после path.resolve); confirm обязателен. Ничего другого не трогаем.
 */
function cleanLegacy(userData, opts) {
  opts = opts || {};
  if (!userData || typeof userData !== 'string' || !path.isAbsolute(userData)) return { ok: false, error: 'нет userData', removed: [] };
  if (opts.confirm !== true) return { ok: false, error: 'нужно подтверждение пользователя', removed: [] };
  const names = Array.isArray(opts.names) && opts.names.length ? opts.names.filter((n) => LEGACY_DIRS.indexOf(n) >= 0) : LEGACY_DIRS.slice();
  const root = path.resolve(userData);
  const removed = [], failed = [];
  for (const name of names) {
    const target = path.join(root, name);
    const abs = path.resolve(target);
    if (path.dirname(abs) !== root) { failed.push({ name, error: 'не внутри userData' }); continue; }
    if (LEGACY_DIRS.indexOf(path.basename(abs)) < 0) { failed.push({ name, error: 'не та папка' }); continue; }
    let stats = null; try { stats = dirStats(abs); } catch (_) { }
    if (!stats || !stats.exists) { removed.push({ name, existed: false, bytes: 0, files: 0 }); continue; }
    try { fs.rmSync(abs, { recursive: true, force: true, maxRetries: 3 }); removed.push({ name, existed: true, bytes: stats.bytes, files: stats.files }); }
    catch (e) { failed.push({ name, error: String((e && e.message) || e) }); }
  }
  return { ok: failed.length === 0, removed, failed };
}

/** Пути проекта: <project>/output и <project>/temp. */
function projectRoots(projectDir) {
  const root = path.resolve(String(projectDir || ''));
  return { projectDir: root, outputRoot: path.join(root, OUTPUT_DIR), tempRoot: path.join(root, TEMP_DIR) };
}

/** Новая папка операции: <project>/output/<tool>-<stamp> и временная <project>/temp/<tool>-<stamp>-xxxx. */
function makeJob(projectDir, tool) {
  const roots = projectRoots(projectDir);
  if (!roots.projectDir || !path.isAbsolute(roots.projectDir)) throw Object.assign(new Error('нет папки проекта'), { code: 'no_project' });
  const t = safeSegment(tool, 'tool');
  const base = t + '-' + stamp();
  let outDir = path.join(roots.outputRoot, base);
  for (let i = 0; i < 50; i++) {
    try { fs.mkdirSync(outDir, { recursive: false }); break; }
    catch (e) {
      if (e && e.code === 'EEXIST') { outDir = path.join(roots.outputRoot, base + '-' + randomSuffix()); continue; }
      // родительских папок может не быть — создаём и повторяем
      try { fs.mkdirSync(roots.outputRoot, { recursive: true }); } catch (_) { }
      try { fs.mkdirSync(outDir, { recursive: true }); break; } catch (e2) { throw Object.assign(new Error('не удалось создать папку результатов: ' + ((e2 && e2.message) || e2)), { code: 'output_dir' }); }
    }
  }
  const tempDir = path.join(roots.tempRoot, base + '-' + randomSuffix());
  try { fs.mkdirSync(tempDir, { recursive: true }); } catch (_) { }
  let finalized = false;
  const api = {
    tool: t, projectDir: roots.projectDir, outputRoot: roots.outputRoot, tempRoot: roots.tempRoot,
    outDir, tempDir,
    out(name) { return path.join(outDir, safeSegment(name, 'file')); },
    tmp(name) { return path.join(tempDir, safeSegment(name, 'tmp')); },
    finalize(opts) {
      if (finalized && !(opts && opts.keepTemp)) return { ok: true, already: true };
      finalized = true;
      let ok = true, error = null;
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { ok = false; error = String((e && e.message) || e); }
      // пустой <project>/temp после уборки можно удалить (если он пуст); сам <project> не трогаем
      try { if (fs.readdirSync(roots.tempRoot).length === 0) fs.rmdirSync(roots.tempRoot); } catch (_) { }
      return { ok, error };
    }
  };
  return api;
}

function storageError(e) {
  const code = (e && e.code) || 'storage';
  return { ok: false, error: (e && e.message) || 'папка проекта недоступна', needProjectFolder: code === 'no_project' || code === 'canceled', storageCode: code, canceled: code === 'canceled' };
}

/**
 * Папка проекта для результатов:
 *  1) projectFolder() и own=true (папка выбрана пользователем) → она;
 *  2) иначе chooseProjectFolder(event) (диалог + привязка к проекту);
 *  3) иначе ошибка no_project/canceled. Никакого userData/AppData.
 */
async function resolveProjectRoot(deps, event) {
  deps = deps || {};
  let info = null;
  try { info = deps.projectFolder ? deps.projectFolder() : null; } catch (_) { info = null; }
  if (info && info.path && info.own) {
    const p = path.resolve(String(info.path));
    try { fs.mkdirSync(p, { recursive: true }); return p; } catch (_) { /* спросим другое место */ }
  }
  if (typeof deps.chooseProjectFolder === 'function') {
    let r = null;
    try { r = await deps.chooseProjectFolder(event); } catch (e) { throw Object.assign(new Error(String((e && e.message) || e)), { code: 'canceled' }); }
    if (r && r.canceled) throw Object.assign(new Error('Папка проекта не выбрана — результаты инструментов не сохранены.'), { code: 'canceled' });
    if (r && r.ok === false) throw Object.assign(new Error(r.message || 'Не удалось выбрать папку проекта'), { code: 'no_project' });
    const p = r && (r.path || (r.projectDir) || null);
    if (!p) throw Object.assign(new Error('Папка проекта не выбрана — результаты инструментов не сохранены.'), { code: 'canceled' });
    const abs = path.resolve(String(p));
    try { fs.mkdirSync(abs, { recursive: true }); } catch (e) { throw Object.assign(new Error('Папка проекта недоступна для записи: ' + abs), { code: 'output_dir' }); }
    return abs;
  }
  throw Object.assign(new Error('Папка проекта не выбрана. Выберите папку проекта — результаты инструментов пишутся только в неё.'), { code: 'no_project' });
}

async function beginJob(deps, event, tool) {
  const root = await resolveProjectRoot(deps, event);
  return makeJob(root, tool);
}

/** Статус для UI: где будут результаты, выбрана ли папка, старые папки в userData. */
function describe(deps) {
  deps = deps || {};
  let info = null; try { info = deps.projectFolder ? deps.projectFolder() : null; } catch (_) { info = null; }
  const own = !!(info && info.own && info.path);
  const root = own ? path.resolve(String(info.path)) : (info && info.path ? path.resolve(String(info.path)) : null);
  const roots = root ? projectRoots(root) : null;
  const legacy = legacySummary(deps.userData);
  return {
    ok: true, projectSelected: own, projectRoot: own ? root : null,
    suggestedRoot: root, outputRoot: roots ? roots.outputRoot : null, tempRoot: roots ? roots.tempRoot : null,
    userData: deps.userData || null, legacy, legacyBytes: legacy.bytes,
    note: own ? 'Результаты инструментов сохраняются в папку проекта' : 'Папка проекта не выбрана — инструменты спросят её перед сохранением'
  };
}

module.exports = {
  LEGACY_DIRS, OUTPUT_DIR, TEMP_DIR, stamp, safeSegment, isInside, dirStats,
  legacyInfo, legacySummary, cleanLegacy, projectRoots, makeJob, storageError,
  resolveProjectRoot, beginJob, describe
};
