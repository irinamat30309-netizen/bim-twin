/* BIM Twin — выбор диска и папки при создании проекта (ревизия 38).
 * Программа может стоять на диске C, а проект — на любом диске: облака, LAS, кэш индексов, черновики,
 * резервные копии и отчёты лежат в папке проекта. Форма «Новый проект»: название (+ адрес) и место
 * хранения с кнопкой «Изменить…», под ним — итоговый путь и свободное место; предупреждение, если места мало.
 *   ProjectStorageUI.newProjectForm({ address: true }) → { name, address, folderParent } | null
 *   ProjectStorageUI.chooseFor(projectId, name) — перенести папку существующего проекта (файлы не переносятся)
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ProjectStorageUI = api;
})(typeof window !== 'undefined' ? window : null, function (W) {
  'use strict';
  var LOW = 20 * 1024 * 1024 * 1024;
  function gb(b) {
    b = Number(b) || 0;
    if (b >= 1099511627776) return (b / 1099511627776).toFixed(1).replace('.', ',') + ' ТБ';
    if (b >= 10737418240) return Math.round(b / 1073741824) + ' ГБ';
    if (b >= 1073741824) return (b / 1073741824).toFixed(1).replace('.', ',') + ' ГБ';
    return Math.round(b / 1048576) + ' МБ';
  }
  function safeName(n) {
    var s = String(n || '').normalize ? String(n || '').normalize('NFC') : String(n || '');
    s = s.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 100);
    return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s) ? s + '_' : (s || 'Проект');
  }
  function sepOf(p) { p = String(p || ''); return p.indexOf('\\') >= 0 || /^[a-z]:/i.test(p) ? '\\' : '/'; }
  function baseOf(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop(); }
  // итоговая папка проекта — как в main.assignProjectDir: <место>\<название>, либо само место, если оно уже так называется
  function projectPath(parent, name) {
    parent = String(parent || ''); if (!parent) return '';
    var nm = safeName(name);
    if (baseOf(parent).toLowerCase() === nm.toLowerCase()) return parent;
    return parent.replace(/[\\/]+$/, '') + sepOf(parent) + nm;
  }
  function driveOf(p) { var m = /^([a-z]:)/i.exec(String(p || '')); return m ? m[1].toUpperCase() : '/'; }
  // подсказка под полем «Где хранить»: путь, свободное место и предупреждения
  function describe(parent, name, space, drives) {
    if (!parent) return { text: 'Выберите папку на диске, где достаточно места', warn: true };
    var t = 'Папка проекта: ' + projectPath(parent, name || 'Название');
    if (!space) return { text: t, warn: false };
    t += ' · свободно ' + gb(space.free) + ' на ' + (space.drive ? String(space.drive).replace(/[\\/]+$/, '') : driveOf(parent));
    var better = null;
    (drives || []).forEach(function (d) { if (!d.system && d.free >= LOW && d.free > space.free * 2 && (!better || d.free > better.free)) better = d; });
    if (space.low || space.free < LOW) {
      return { text: t + '. Мало места: облака точек, LAS и их индексы занимают десятки гигабайт' + (better ? ' — свободнее ' + String(better.path).replace(/[\\/]+$/, '') + ' (' + gb(better.free) + ')' : '') + '.', warn: true };
    }
    return { text: t, warn: false };
  }
  function drivesLine(drives) {
    if (!drives || !drives.length) return '';
    return drives.map(function (d) { return String(d.path).replace(/[\\/]+$/, '') + ' — свободно ' + gb(d.free) + (d.system ? ' (системный)' : ''); }).join(' · ');
  }
  var pure = { gb: gb, safeName: safeName, projectPath: projectPath, describe: describe, drivesLine: drivesLine, LOW: LOW };
  if (!W || !W.document) return pure;

  function A() { return W.bimAPI || null; }
  function K() { return W.__lxKit || null; }
  async function info(projectId) {
    var a = A(); if (!a || !a.projectStorage) return null;
    try { var r = await a.projectStorage(projectId ? { action: 'info', projectId: projectId } : { action: 'info' }); return r && r.ok ? r : null; } catch (_) { return null; }
  }
  async function newProjectForm(o) {
    o = o || {};
    var kit = K(), a = A(); if (!kit || !kit.form) return null;
    var inf = await info(), spaces = {};
    if (inf && inf.suggest) spaces[inf.suggest] = inf.suggestSpace || null;
    var fields = [{ key: 'name', label: 'Название', type: 'text', stack: true, value: o.name || '', placeholder: 'Например: ЖК «Северный», корпус А', maxLength: 200 }];
    if (o.address) fields.push({ key: 'address', label: 'Адрес', type: 'text', stack: true, value: '', maxLength: 300 });
    if (inf && a && a.projectStorage) {
      fields.push({
        key: 'folder', label: 'Где хранить проект (облака, LAS, кэш, отчёты)', type: 'folder', value: inf.suggest || '', pickLabel: 'Изменить…',
        pick: async function (cur) {
          var r = await a.projectStorage({ action: 'pick', path: cur || undefined, title: 'Где хранить новый проект (облака, LAS, кэш, отчёты)' });
          if (r && r.ok && r.path) { spaces[r.path] = r.space || null; return { path: r.path }; }
          return null;
        },
        hint: function (v) { return describe(v.folder, v.name, spaces[v.folder], inf.drives); }
      });
    }
    var dl = inf ? drivesLine(inf.drives) : '';
    var v = await kit.form({
      title: 'Новый проект', wide: true, okLabel: 'Создать', className: 'ps-new',
      message: inf ? 'Программа может стоять на диске C, а проект — на любом диске: в папке проекта хранятся облака, LAS, индексы для быстрого открытия, черновики и отчёты.' : 'Название появится в списке проектов и в заголовке рабочей области.',
      hint: dl ? 'Диски: ' + dl : undefined,
      fields: fields,
      validate: function (x) { if (!x.name) return 'Введите название проекта'; if (inf && !x.folder) return 'Выберите, где хранить проект'; return null; }
    });
    if (!v || !v.name) return null;
    return { name: v.name, address: v.address || '', folderParent: v.folder || undefined };
  }
  async function chooseFor(projectId, name) {
    var a = A(); if (!a || !a.projectStorage) return null;
    try { return await a.projectStorage({ action: 'choose', projectId: projectId, title: 'Где хранить проект «' + String(name || 'Проект').slice(0, 120) + '» (облака, LAS, кэш, отчёты)' }); } catch (e) { return { ok: false, message: String(e && e.message || e) }; }
  }
  pure.info = info; pure.newProjectForm = newProjectForm; pure.chooseFor = chooseFor;
  return pure;
});
