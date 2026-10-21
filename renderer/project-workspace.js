/* BIM Twin — папка проекта, работа с файлом на месте, «Сохранить как новое», резервные копии (ревизия 27).
 * У каждого проекта постоянная папка: Документы/BIM Twin/Проекты/<проект>/{Облака, Чертежи, Отчёты, Экспорт}
 * (расположение меняется). Облако можно править прямо в исходном файле (без копии — место не расходуется)
 * или сохранить как новое в папку проекта. Резервные копии перед перезаписью: не хранить / одна / несколько.
 *   ProjectWorkspace.open() — окно; workInPlace(); saveAsNew(); cloudDefaultPath(ext); folder(); backups()
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ProjectWorkspace = api;
})(typeof window !== 'undefined' ? window : null, function (W) {
  'use strict';
  var IN_PLACE = ['ply', 'las', 'xyz', 'pts', 'pcd', 'csv'];
  function ext(p) { var m = /\.([a-z0-9]+)$/i.exec(String(p || '')); return m ? m[1].toLowerCase() : ''; }
  function base(p) { return String(p || '').split(/[\\/]/).pop(); }
  function stem(p) { return base(p).replace(/\.[^.]+$/, ''); }
  function joinPath(dir, name) { dir = String(dir || ''); var sep = dir.indexOf('\\') >= 0 && dir.indexOf('/') < 0 ? '\\' : '/'; return dir.replace(/[\\/]+$/, '') + sep + name; }
  // имя «как новое»: <исходное>-правка.<ext>, без запрещённых в Windows символов
  function newName(src, e) { var s = stem(src || 'pointcloud').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/-правка(-\d+)?$/, '') || 'pointcloud'; return s + '-правка.' + (e || 'ply'); }
  function fmtBytes(b) { b = Number(b) || 0; if (b >= 1073741824) return (b / 1073741824).toFixed(2).replace('.', ',') + ' ГБ'; if (b >= 1048576) return Math.round(b / 1048576) + ' МБ'; if (b > 0) return Math.max(1, Math.round(b / 1024)) + ' КБ'; return '0'; }
  // можно ли перезаписывать исходный файл: только если на экране ВСЕ его точки (не выборка, не область/фильтр)
  function inPlaceBlock(info) {
    info = info || {};
    if (!info.path) return 'Сначала откройте облако из файла';
    if (IN_PLACE.indexOf(ext(info.path)) < 0) return 'Формат ' + (ext(info.path).toUpperCase() || '?') + ' на месте не перезаписывается — сохраните как новое (PLY, LAS, XYZ, PTS, PCD, CSV перезаписываются)';
    if (info.filtered) return 'Облако открыто не целиком (' + (info.filterText || 'выбранная область') + '): перезапись удалила бы из файла остальные точки. Сохраните как новое';
    if (info.sampled || info.thinned) return 'На экране равномерная выборка точек, а не все точки файла: перезапись уменьшила бы файл. Сохраните как новое';
    return '';
  }
  var pure = { ext: ext, base: base, newName: newName, joinPath: joinPath, fmtBytes: fmtBytes, inPlaceBlock: inPlaceBlock, IN_PLACE: IN_PLACE };
  if (!W || !W.document) return pure;

  var D = W.document, back = null, folderCache = null, inPlacePath = null, lastSource = null;
  function A() { return W.bimAPI || null; }
  function kit() { return W.__lxKit || null; }
  function ic(n, s) { return W.__lxIcons ? W.__lxIcons.svg(n, s || 16) : ''; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function toast(t, err) { var k = kit(); if (k && k.toast) { try { k.toast(t, err ? { tone: 'err' } : undefined); } catch (_) {} } }
  function smart() { return W.__lxSmartSave || null; }
  function viewer() { return W.__viewer || null; }
  function cloudPath() { try { return W.__bimLastCloudPath ? W.__bimLastCloudPath() : null; } catch (_) { return null; } }
  function loadState() {
    var p = cloudPath(), li = W.__bimLoadInfo || {}, v = viewer(), info = null;
    try { info = v && v.getCloudInfo ? v.getCloudInfo() : null; } catch (_) {}
    var same = li.path && p && li.path === p;
    return { path: p, filtered: same && !!li.filtered, filterText: same ? li.filterText : '', sampled: same && !!li.sampled, thinned: !!(info && info.gpuThinned), hasCloud: !!info };
  }
  async function folder(create) {
    var a = A(); if (!a || !a.projectFolder) return null;
    try { var r = await a.projectFolder(create === false ? 'peek' : 'get'); if (r && r.path) folderCache = r; return r; } catch (_) { return null; }
  }
  async function cloudDefaultPath(e) {
    var f = folderCache && folderCache.ok ? folderCache : await folder(true);
    if (!f || !f.clouds) return null;
    return joinPath(f.clouds, newName(cloudPath(), e || 'ply'));
  }
  async function workInPlace() {
    var st = loadState(), why = inPlaceBlock(st);
    if (why) { toast(why, true); return { ok: false, message: why }; }
    var a = A(), s = smart();
    if (!a || !a.grantWorkInPlace || !s || !s.setWorkingPath) { toast('Работа с файлом на месте доступна в настольной версии', true); return { ok: false }; }
    var r = await a.grantWorkInPlace(st.path);
    if (!r || !r.ok) { if (!(r && r.canceled)) toast('Не удалось: ' + ((r && r.message) || 'нет права на запись'), true); render(); return r || { ok: false }; }
    s.setWorkingPath(r.path); inPlacePath = r.path;
    toast('Правки сохраняются прямо в ' + base(r.path) + ' (Ctrl+S)');
    render(); return { ok: true, path: r.path };
  }
  async function saveAsNew() {
    var s = smart(); if (!s || !s.saveAsNew) { toast('Сохранение недоступно', true); return { ok: false }; }
    var r = await s.saveAsNew();
    if (r && r.ok) inPlacePath = null;
    render(); return r;
  }
  async function backups(action, policy) {
    var a = A(); if (!a || !a.cloudBackups) return null;
    try { return await a.cloudBackups(Object.assign({ action: action || 'usage' }, policy ? { policy: policy } : {})); } catch (_) { return null; }
  }
  var bk = null;
  async function render() {
    if (!back) return;
    var body = back.querySelector('.pw-body'); if (!body) return;
    var f = folderCache, st = loadState(), s = smart(), ss = s && s.status ? s.status() : {}, why = inPlaceBlock(st), wp = ss.workingPath || null;
    var mode = !wp ? 'Правки ещё не сохранялись — Ctrl+S спросит, куда сохранить' : (st.path && wp === st.path ? 'Правки сохраняются прямо в исходный файл' : 'Правки сохраняются в ' + base(wp));
    var h = '';
    // папка проекта: путь одной строкой и две кнопки-иконки
    h += '<section class="pw-sec"><div class="pw-h">Папка проекта</div>';
    h += '<div class="pw-row">' + ic('folder', 16) + (f && f.path ? '<span class="pw-path" title="' + esc(f.path + '\nОблака, планы DXF, PDF-отчёты и выгрузки сохраняются сюда по умолчанию. Папка не удаляется при закрытии программы.') + '">' + esc(f.path) + '</span>' : '<span class="pw-path pw-dim">Недоступна в этой версии</span>') +
      '<button type="button" class="btn xs ghost pw-ib" data-a="open" title="Открыть папку" aria-label="Открыть папку"' + (f && f.path ? '' : ' disabled') + '>' + ic('folder-open', 15) + '</button>' +
      '<button type="button" class="btn xs ghost pw-ib" data-a="choose" title="Изменить расположение…" aria-label="Изменить расположение">' + ic('settings', 15) + '</button></div>';
    if (f && f.path) h += '<div class="pw-subs">' + ['clouds', 'drawings', 'reports', 'exports'].map(function (k) { return f[k] ? '<span>' + esc(base(f[k])) + '</span>' : ''; }).join('') + '</div>';
    h += '</section>';
    // открытое облако: файл, куда идут правки, два способа сохранения
    h += '<section class="pw-sec"><div class="pw-h">Открытое облако</div>';
    if (!st.hasCloud) h += '<div class="pw-row pw-dim">' + ic('layers', 16) + '<span>Облако не открыто</span></div>';
    else {
      var here = !!(wp && st.path && wp === st.path);
      h += '<div class="pw-row">' + ic('layers', 16) + '<div class="pw-file"><b title="' + esc(st.path || '') + '">' + esc(base(st.path) || 'без файла') + '</b><small>' + esc(mode) + '</small></div>' +
        (wp ? '<button type="button" class="btn xs pw-ib" data-a="save" title="Сохранить (Ctrl+S)" aria-label="Сохранить">' + ic('save', 15) + '</button>' : '') + '</div>';
      h += '<div class="pw-acts">' +
        '<button type="button" class="pw-opt' + (here ? ' on' : '') + '" data-a="inplace"' + (why || here ? ' disabled' : '') + ' title="Файл не копируется, место на диске не расходуется">' + ic(here ? 'check' : 'pencil', 15) + '<span><b>На месте</b><small>правки в исходный файл</small></span></button>' +
        '<button type="button" class="pw-opt' + (wp && !here ? ' on' : '') + '" data-a="asnew" title="Исходный файл не меняется, копия ложится в папку проекта (Облака)">' + ic('copy', 15) + '<span><b>Как новое…</b><small>копия в папку проекта</small></span></button></div>';
      if (why) h += '<p class="pw-warn">' + ic('info', 14) + '<span>' + esc(why) + '</span></p>';
    }
    h += '</section>';
    // резервные копии перед перезаписью
    var pol = (bk && bk.policy) || 'several';
    h += '<section class="pw-sec"><div class="pw-h">Резервные копии<span class="pw-sp"></span><span class="pw-usage" title="Копия нужна, чтобы вернуть файл после неудачной перезаписи">' + (bk ? (bk.files || 0) + ' ' + plural(bk.files || 0) + ' · ' + fmtBytes(bk.bytes) : 'объём неизвестен') + '</span>' +
      '<button type="button" class="btn xs ghost pw-ib" data-a="clear" title="Удалить копии" aria-label="Удалить копии"' + (bk && bk.files ? '' : ' disabled') + '>' + ic('trash-2', 15) + '</button></div>';
    h += '<div class="pw-seg" role="radiogroup" aria-label="Резервные копии">' +
      [['none', 'Не хранить', 'Экономит место — для облаков в десятки гигабайт'], ['one', 'Одна', 'Предыдущая версия'], ['several', 'Несколько', 'До 8 версий']].map(function (o) {
        return '<button type="button" role="radio" aria-checked="' + (pol === o[0]) + '" class="' + (pol === o[0] ? 'on' : '') + '" data-pol="' + o[0] + '" title="' + esc(o[2]) + '">' + o[1] + '</button>';
      }).join('') + '</div></section>';
    body.innerHTML = h;
    var on = function (sel, fn) { Array.prototype.forEach.call(body.querySelectorAll(sel), function (b) { b.onclick = function () { fn(b); }; }); };
    on('[data-a="open"]', async function () { var a = A(); if (a && a.projectFolder) { var r = await a.projectFolder('open'); if (r && r.ok === false && r.message) toast(r.message, true); } });
    on('[data-a="choose"]', async function () { var a = A(); if (!a || !a.projectFolder) return; var r = await a.projectFolder('choose'); if (r && r.path) { folderCache = r; toast('Папка проектов: ' + r.root); } render(); });
    on('[data-a="inplace"]', function () { workInPlace(); });
    on('[data-a="asnew"]', function () { saveAsNew(); });
    on('[data-a="save"]', async function () { var s2 = smart(); if (s2 && s2.save) { await s2.save(); render(); } });
    on('[data-pol]', async function (b) { var r = await backups('set', b.getAttribute('data-pol')); if (r && r.ok) { bk = r; toast(r.keep ? 'Резервных копий хранится: до ' + r.keep : 'Резервные копии не хранятся'); } render(); });
    on('[data-a="clear"]', async function () { var r = await backups('clear'); if (r && r.ok) { bk = r; toast('Резервные копии удалены'); } else if (r) bk = Object.assign({}, bk || {}, r); render(); });
  }
  function plural(n) { n = Math.abs(n) % 100; var k = n % 10; if (n > 10 && n < 20) return 'копий'; if (k > 1 && k < 5) return 'копии'; if (k === 1) return 'копия'; return 'копий'; }
  function close() {
    if (!back) return; var b = back; back = null;
    D.removeEventListener('keydown', onKey, true);
    b.classList.add('closing'); setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 160);
  }
  function onKey(e) { if (e.key === 'Escape' && back && !D.querySelector('.modal.lx-ask')) { e.preventDefault(); e.stopPropagation(); close(); } }
  async function open(section) {
    if (!back) {
      back = D.createElement('div'); back.className = 'modal pw-modal';
      back.innerHTML = '<div class="modal-card pw-card" role="dialog" aria-modal="true" aria-labelledby="pwTitle">' +
        '<div class="modal-head"><span id="pwTitle">Проект: папка и хранение</span><button type="button" class="x" data-ico="x" aria-label="Закрыть"></button></div><div class="pw-body"></div></div>';
      back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
      back.querySelector('.modal-head .x').onclick = close;
      D.body.appendChild(back); if (kit() && kit().hydrate) kit().hydrate(back); back.classList.add('open');
      D.addEventListener('keydown', onKey, true);
    }
    var r = await Promise.all([folder(true), backups('usage')]);
    bk = r[1] && r[1].ok ? r[1] : null;
    await render();
    if (section === 'backups' && back) { var el = back.querySelector('.pw-seg'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' }); }
  }
  // открыто другое облако — прежний рабочий файл больше не цель Ctrl+S (иначе новое облако перезаписало бы старый файл)
  if (W.addEventListener) W.addEventListener('bim-cloud-change', function () {
    var v = viewer(), info = null; try { info = v && v.getCloudInfo ? v.getCloudInfo() : null; } catch (_) {}
    var src = info && info.sourceName ? String(info.sourceName) : null;
    if (!src) return;
    if (lastSource && src !== lastSource) {
      var s = smart(), ss = s && s.status ? s.status() : null;
      if (s && s.setWorkingPath && ss && ss.workingPath) { s.setWorkingPath(null); inPlacePath = null; }
    }
    lastSource = src;
    if (back) render();
  });
  return Object.assign({}, pure, { open: open, close: close, workInPlace: workInPlace, saveAsNew: saveAsNew, cloudDefaultPath: cloudDefaultPath, folder: folder, backups: function () { return open('backups'); }, state: loadState });
});
