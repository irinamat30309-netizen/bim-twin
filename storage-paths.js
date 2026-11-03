'use strict';
/* BIM Twin — где хранить большие файлы (ревизия 38).
 * Программа может стоять на диске C, а проект — на любом другом диске: у проекта своя папка
 * (выбирается при создании), в ней — «Облака», «Чертежи», «Отчёты», «Экспорт» и служебная папка
 * «Кэш BIM Twin» (индексы octree, черновики, резервные копии облаков, временные файлы обработок).
 * Проекты без своей папки пользуются общей папкой (settings.cacheRoot) или, как раньше, userData.
 * Модуль без Electron: пути считаются из настроек, свободное место — через fs.statfsSync. */
const fs = require('fs');
const path = require('path');

const CACHE_DIR = 'Кэш BIM Twin';
const DEFAULT_PARENT = 'BIM Twin Проекты';
const KINDS = ['octrees', 'potree', 'splatcache', 'clean', 'geom', 'cc-edit', 'cloud-history', 'autosave-clouds', 'tmp'];
const LOW_FREE = 20 * 1024 * 1024 * 1024;      // меньше 20 ГБ — предупреждаем: облака и их индексы занимают десятки гигабайт

function isAbsDir(p) {
  return typeof p === 'string' && p.length > 1 && p.length < 1024 && p.indexOf('\0') < 0 && path.isAbsolute(p);
}
function safeName(name) {
  const s = String(name || '').normalize('NFC').replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 100);
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s) ? s + '_' : (s || 'Проект');
}
function projectDirOf(settings, projectId) {
  const m = settings && settings.projectDirs;
  const d = m && typeof m === 'object' && projectId ? m[projectId] : null;
  return isAbsDir(d) ? path.resolve(d) : null;
}
function projectDirFor(parent, name) { return path.join(path.resolve(parent), safeName(name)); }
// корень служебных файлов: папка проекта → общая папка из настроек → userData
function workRoot(o) {
  o = o || {};
  const s = o.settings || {};
  const pd = projectDirOf(s, o.projectId);
  if (pd) return { root: path.join(pd, CACHE_DIR), source: 'project', projectDir: pd };
  if (isAbsDir(s.cacheRoot)) return { root: path.resolve(s.cacheRoot), source: 'custom', projectDir: null };
  return { root: path.resolve(String(o.userData || '.')), source: 'userData', projectDir: null };
}
function workDir(kind, o) {
  if (KINDS.indexOf(kind) < 0) throw new Error('unknown work dir: ' + kind);
  return path.join(workRoot(o).root, kind);
}
// все корни, где могут лежать служебные файлы (для проверок «только внутри своих каталогов» и очистки при выходе)
function allRoots(o) {
  o = o || {};
  const s = o.settings || {}, out = [];
  const add = p => { if (isAbsDir(p)) { const r = path.resolve(p); if (out.indexOf(r) < 0) out.push(r); } };
  add(o.userData);
  add(s.cacheRoot);
  const m = s.projectDirs && typeof s.projectDirs === 'object' ? s.projectDirs : {};
  for (const id of Object.keys(m)) if (isAbsDir(m[id])) add(path.join(m[id], CACHE_DIR));
  return out;
}
function existingAncestor(p, fsx) {
  fsx = fsx || fs;
  let d = path.resolve(String(p || '.'));
  for (let i = 0; i < 64; i++) {
    try { if (fsx.statSync(d)) return d; } catch (_) {}
    const up = path.dirname(d); if (up === d) return null; d = up;
  }
  return null;
}
function diskSpace(p, fsx) {
  fsx = fsx || fs;
  try {
    const a = existingAncestor(p, fsx);
    if (!a || typeof fsx.statfsSync !== 'function') return null;
    const st = fsx.statfsSync(a);
    const free = Number(st.bavail) * Number(st.bsize), total = Number(st.blocks) * Number(st.bsize);
    if (!isFinite(free) || !isFinite(total)) return null;
    return { free, total, root: path.parse(a).root, low: free < LOW_FREE };
  } catch (_) { return null; }
}
function sameRoot(a, b) { return String(a || '').toLowerCase().replace(/[\\/]+$/, '') === String(b || '').toLowerCase().replace(/[\\/]+$/, ''); }
// диски компьютера со свободным местом; на Windows — буквы C…Z, иначе корень и домашняя папка
function listDrives(o) {
  o = o || {};
  const fsx = o.fs || fs, platform = o.platform || process.platform, out = [];
  if (platform === 'win32') {
    for (let c = 67; c <= 90; c++) {
      const r = String.fromCharCode(c) + ':\\';
      try { if (!fsx.existsSync(r)) continue; } catch (_) { continue; }
      // корень диска есть всегда — statfs напрямую (без поиска существующей папки)
      try {
        const st = fsx.statfsSync(r), free = Number(st.bavail) * Number(st.bsize), total = Number(st.blocks) * Number(st.bsize);
        if (isFinite(free) && total > 0) out.push({ path: r, free, total, root: r, low: free < LOW_FREE });
      } catch (_) {}
    }
  } else {
    for (const r of ['/', o.home].filter(Boolean)) {
      const sp = diskSpace(r, fsx); if (sp && !out.some(d => sameRoot(d.root, sp.root) && d.total === sp.total)) out.push(Object.assign({ path: r }, sp));
    }
  }
  const sys = o.systemRoot || (platform === 'win32' ? (process.env.SystemDrive || 'C:') + '\\' : '/');
  for (const d of out) d.system = sameRoot(d.root, sys);
  return out;
}
// куда предложить новый проект: прежнее место (если там хватает места) → несистемный диск с наибольшим свободным местом → Документы
function suggestParent(o) {
  o = o || {};
  const drives = Array.isArray(o.drives) ? o.drives : [];
  if (isAbsDir(o.lastParent)) {
    const sp = o.lastSpace !== undefined ? o.lastSpace : diskSpace(o.lastParent, o.fs);
    if (!sp || !sp.low) return { path: path.resolve(o.lastParent), why: 'last' };
  }
  const sys = drives.find(d => d.system) || null;
  const other = drives.filter(d => !d.system && d.free >= LOW_FREE).sort((a, b) => b.free - a.free)[0];
  if (other && (!sys || sys.low || other.free > sys.free)) return { path: path.join(other.path, DEFAULT_PARENT), why: 'free' };
  if (isAbsDir(o.documents)) return { path: path.join(o.documents, 'BIM Twin', 'Проекты'), why: 'documents' };
  return { path: o.lastParent || null, why: 'none' };
}
function fmtGB(b) {
  b = Number(b) || 0;
  if (b >= 1024 * 1024 * 1024 * 1024) return (b / 1099511627776).toFixed(1).replace('.', ',') + ' ТБ';
  if (b >= 10 * 1024 * 1024 * 1024) return Math.round(b / 1073741824) + ' ГБ';
  if (b >= 1024 * 1024 * 1024) return (b / 1073741824).toFixed(1).replace('.', ',') + ' ГБ';
  return Math.round(b / 1048576) + ' МБ';
}
function spaceText(sp) {
  if (!sp) return 'свободное место неизвестно';
  return 'свободно ' + fmtGB(sp.free) + ' из ' + fmtGB(sp.total) + (sp.low ? ' — мало для облаков точек' : '');
}

module.exports = { CACHE_DIR, DEFAULT_PARENT, KINDS, LOW_FREE, isAbsDir, safeName, projectDirOf, projectDirFor, workRoot, workDir, allRoots, existingAncestor, diskSpace, listDrives, suggestParent, fmtGB, spaceText };
