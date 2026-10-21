/* BIM Twin — «Последние действия» (ревизия 27).
 * Список правок облака, которые можно отменить (стек viewer._undo), журнал изменений проекта и события сеанса.
 * «Отменить до этого» отменяет все правки от последней до выбранной включительно (viewer.undoEdit по шагам).
 * Записи стека подписываются здесь: доступ к viewer._undo перехватывается, к каждой новой записи
 * добавляется время и понятная подпись (сам формат записей просмотрщика не меняется).
 *   HistoryPanel.open() — окно; HistoryPanel.entries() — правки облака (новые сверху); HistoryPanel.log(text) — событие сеанса.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.HistoryPanel = api;
})(typeof window !== 'undefined' ? window : null, function (W) {
  'use strict';
  var TOOL = {
    edit: 'Правка облака', smooth: 'Сглаживание', resample: 'Прореживание', level: 'Выравнивание по горизонту',
    'vertical-align': 'Выравнивание по вертикали', merge: 'Объединение облаков', overlay: 'Наложение облаков',
    'add-cloud': 'Добавление облака', add: 'Добавление облака', denoise: 'Удаление шума', removePeople: 'Удаление людей',
    removeDynamic: 'Удаление движущихся объектов', autoClean: 'Автоочистка', flatten: 'Выравнивание пола',
    recolor: 'Перекраска', colorBalance: 'Баланс цвета', crop: 'Обрезка', 'tool-result': 'Обработка облака'
  };
  var OP = {
    'project.state.update': 'Изменение проекта', 'project.export': 'Экспорт проекта', 'workspace.sync.export': 'Выгрузка для команды',
    'drawing.save': 'Сохранение чертежа', 'mesh-section': 'Сечение сетки', 'pointcloud.export.stream': 'Экспорт облака по частям',
    'cloud.export': 'Экспорт облака', 'cloud.working-copy.save': 'Сохранение облака', 'cloud.report.pdf': 'PDF-отчёт',
    'cloud.point-edit': 'Правка точек', 'cloud.edit.restore': 'Восстановление облака', 'cloud.classification.clear': 'Сброс классов',
    'cloud.plan.dxf': 'План из облака (DXF)'
  };
  function toolLabel(t) { t = String(t || 'edit'); return TOOL[t] || ('Обработка облака: ' + t); }
  function opLabel(op) {
    op = String(op || '');
    if (OP[op]) return OP[op];
    var m = /^cloud\.(.+)$/.exec(op); if (m) return TOOL[m[1]] || ('Облако: ' + m[1]);
    return op || 'Операция';
  }
  function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',') + ' млн';
    if (n >= 1e4) return Math.round(n / 1e3) + ' тыс.';
    return String(Math.round(n));
  }
  function plural(n, a, b, c) { n = Math.abs(n) % 100; var k = n % 10; if (n > 10 && n < 20) return c; if (k > 1 && k < 5) return b; if (k === 1) return a; return c; }
  // подпись и подробность записи стека отмены (формат просмотрщика: removedPos / pos(snapshot) / classificationEdit)
  function describe(e) {
    if (!e || typeof e !== 'object') return { label: 'Правка облака', detail: '' };
    var h = e.__h || {};
    if (h.label) return { label: h.label, detail: h.detail || '' };
    if (e.classificationEdit) {
      var n = Number(e.changedPointCount) || (e.indices ? e.indices.length : 0);
      return { label: 'Классы точек', detail: n ? 'изменено ' + fmtCount(n) + ' ' + plural(n, 'точка', 'точки', 'точек') : '' };
    }
    if (e.removedPos) {
      var r = Math.floor(e.removedPos.length / 3);
      return { label: e.addedFill ? 'Удаление и заполнение' : 'Удаление точек', detail: 'удалено ' + fmtCount(r) + ' ' + plural(r, 'точка', 'точки', 'точек') };
    }
    if (e.pos) {
      var before = Number(e.pointCountBefore) || Math.floor(e.pos.length / 3);
      return { label: e.tool ? toolLabel(e.tool) : (e.snapshot ? 'Правка облака' : 'Обработка облака'), detail: 'было ' + fmtCount(before) + ' ' + plural(before, 'точка', 'точки', 'точек') };
    }
    return { label: 'Правка облака', detail: '' };
  }
  function fmtTime(t) {
    if (!t) return '';
    var d = new Date(t); if (isNaN(d.getTime())) return '';
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    var now = new Date(), same = d.toDateString() === now.toDateString();
    return (same ? '' : p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' ') + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function ago(t, now) {
    var s = Math.max(0, Math.round(((now || Date.now()) - t) / 1000));
    if (s < 60) return 'только что';
    var m = Math.round(s / 60); if (m < 60) return m + ' мин назад';
    var h = Math.round(m / 60); if (h < 24) return h + ' ч назад';
    return fmtTime(t);
  }
  var pure = { describe: describe, toolLabel: toolLabel, opLabel: opLabel, fmtCount: fmtCount, fmtTime: fmtTime, ago: ago, plural: plural };
  if (!W || !W.document) return pure;

  var D = W.document, session = [], openBack = null, hint = null;
  function kit() { return W.__lxKit || null; }
  function ic(n, s) { return W.__lxIcons ? W.__lxIcons.svg(n, s || 16) : ''; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function toast(t, err) { var k = kit(); if (k && k.toast) { try { k.toast(t, err ? { tone: 'err' } : undefined); } catch (_) {} } }
  function api() { return W.bimAPI || null; }
  function viewer() { return W.__viewer || null; }
  function log(text, kind) {
    session.push({ at: Date.now(), text: String(text || ''), kind: kind || 'info' });
    if (session.length > 120) session.shift();
    refresh();
  }
  // подсказка для следующей записи стека (инструменты могут вызвать HistoryPanel.hint('Обрезка по рамке'))
  function setHint(label, detail) { hint = { label: String(label || ''), detail: detail ? String(detail) : '', at: Date.now() }; }
  function stamp(e) {
    if (!e || typeof e !== 'object' || e.__h) return;
    var h = { at: Date.now() };
    if (hint && Date.now() - hint.at < 15000) { h.label = hint.label; h.detail = hint.detail; hint = null; }
    try { Object.defineProperty(e, '__h', { value: h, enumerable: false, configurable: true }); } catch (_) {}
  }
  function wrapArray(a) {
    if (!Array.isArray(a) || a.__hpWrapped) return a;
    var push = Array.prototype.push;
    try {
      Object.defineProperty(a, 'push', { value: function () { for (var i = 0; i < arguments.length; i++) stamp(arguments[i]); var r = push.apply(this, arguments); setTimeout(refresh, 0); return r; }, enumerable: false, configurable: true, writable: true });
      Object.defineProperty(a, '__hpWrapped', { value: true, enumerable: false });
    } catch (_) {}
    for (var i = 0; i < a.length; i++) stamp(a[i]);
    return a;
  }
  function install(v) {
    if (!v || v.__hpInstalled) return;
    try {
      var cur = wrapArray(v._undo || []);
      Object.defineProperty(v, '_undo', { get: function () { return cur; }, set: function (a) { cur = wrapArray(a); setTimeout(refresh, 0); }, enumerable: true, configurable: true });
      if (typeof v.undoEdit === 'function') {
        var orig = v.undoEdit;
        v.undoEdit = function () {
          var top = cur && cur.length ? cur[cur.length - 1] : null;
          var ok = orig.apply(this, arguments);
          if (ok && top) log('Отменено: ' + describe(top).label, 'undo');
          return ok;
        };
      }
      Object.defineProperty(v, '__hpInstalled', { value: true, enumerable: false });
    } catch (e) { try { console.warn('[history] не удалось подключиться к стеку отмены', e); } catch (_) {} }
  }
  function entries() {
    var v = viewer(); install(v);
    var a = v && v._undo ? v._undo : [];
    var out = [];
    for (var i = a.length - 1; i >= 0; i--) { var d = describe(a[i]); out.push({ index: i, steps: a.length - i, at: (a[i] && a[i].__h && a[i].__h.at) || 0, label: d.label, detail: d.detail }); }
    return out;
  }
  function streamed() { var v = viewer(); var b = v && v.base && v.base[0]; return !!(b && b._stream); }
  async function undoSteps(k) {
    var v = viewer(); if (!v || typeof v.undoEdit !== 'function') return 0;
    if (k > 1 && kit() && kit().ask) {
      var yes = await kit().ask({ title: 'Отменить правки', message: 'Отменить ' + k + ' ' + plural(k, 'последнюю правку', 'последние правки', 'последних правок') + ' облака? Облако вернётся к состоянию до выбранной.', okLabel: 'Отменить ' + k, cancelLabel: 'Нет' });
      if (!yes) return 0;
    }
    var done = 0;
    for (var i = 0; i < k; i++) { if (!v.undoEdit()) break; done++; await new Promise(function (r) { setTimeout(r, 0); }); }
    if (done) toast(done === 1 ? 'Правка отменена' : 'Отменено правок: ' + done);
    else toast('Отменить не удалось', true);
    refresh();
    return done;
  }
  async function projectMove(dir) {
    var ps = W.BimProjectState; if (!ps || typeof ps[dir] !== 'function') { toast('История проекта недоступна', true); return; }
    try {
      var r = await ps[dir]();
      if (!r || r.ok === false) toast(r && (r.error === 'no_undo' || r.error === 'no_redo') ? 'Нет версии для ' + (dir === 'undo' ? 'отмены' : 'повтора') : 'Не удалось: ' + String(r && (r.message || r.error) || 'ошибка'), true);
      else { toast(dir === 'undo' ? 'Изменение проекта отменено' : 'Изменение проекта повторено'); log(dir === 'undo' ? 'Отменено изменение проекта' : 'Повторено изменение проекта', 'undo'); }
    } catch (e) { toast('Не удалось: ' + String(e && e.message || e), true); }
    refresh(true);
  }
  var journal = [], journalAt = 0;
  async function loadJournal(force) {
    var a = api(); if (!a || typeof a.listProjectOperations !== 'function') { journal = []; return; }
    if (!force && Date.now() - journalAt < 3000) return;
    journalAt = Date.now();
    try {
      var ps = W.BimProjectState, q = { limit: 40 };
      if (ps && ps.projectId) q.projectId = ps.projectId;
      var r = await a.listProjectOperations(q);
      journal = Array.isArray(r) ? r : (r && Array.isArray(r.operations) ? r.operations : []);
    } catch (_) { journal = []; }
  }
  function opDetail(op) {
    var p = (op && op.parameters) || {}, o = (op && op.output) || {}, parts = [];
    if (p.pointCountBefore != null && p.pointCountAfter != null) parts.push(fmtCount(p.pointCountBefore) + ' → ' + fmtCount(p.pointCountAfter) + ' точек');
    if (o.path || p.path) parts.push(String(o.path || p.path).split(/[\\/]/).pop());
    if (o.revision != null && op.operation === 'project.state.update') parts.push('версия ' + o.revision);
    return parts.join(' · ');
  }
  function render() {
    if (!openBack) return;
    var body = openBack.querySelector('.hp-body'); if (!body) return;
    var list = entries(), ps = W.BimProjectState, now = Date.now(), h = '';
    h += '<section class="hp-sec"><div class="hp-sec-h">' + ic('undo-2', 15) + '<span>Правки облака</span><span class="hp-sub">можно отменить</span></div>';
    if (streamed()) h += '<p class="hp-note">Облако открыто по частям: правки точек для него недоступны, отменять нечего.</p>';
    else if (!list.length) h += '<p class="hp-note">Пока нет правок, которые можно отменить. Здесь появятся удаление точек, обрезка, чистка, выравнивание и другие изменения облака.</p>';
    else {
      h += '<ol class="hp-list">';
      list.forEach(function (e, i) {
        h += '<li class="hp-item' + (i === 0 ? ' top' : '') + '"><span class="hp-n">' + e.steps + '</span><div class="hp-txt"><b>' + esc(e.label) + '</b>' + (e.detail ? '<small>' + esc(e.detail) + '</small>' : '') + '</div>' +
          '<span class="hp-time" title="' + esc(fmtTime(e.at)) + '">' + (e.at ? esc(ago(e.at, now)) : '') + '</span>' +
          '<button type="button" class="btn xs' + (i === 0 ? ' primary' : '') + '" data-undo="' + e.steps + '">' + ic('undo-2', 14) + '<span>' + (i === 0 ? 'Отменить' : 'Отменить до этого') + '</span></button></li>';
      });
      h += '</ol><p class="hp-note">Хранится до 6 последних правок; у облаков больше 4 млн точек — 2, больше 12 млн — 1 (каждая копия занимает оперативную память). Горячая клавиша: Ctrl+Z.</p>';
    }
    h += '</section>';
    h += '<section class="hp-sec"><div class="hp-sec-h">' + ic('history', 15) + '<span>Изменения проекта</span><span class="hp-sp"></span>' +
      '<button type="button" class="btn xs" data-proj="undo"' + (ps && ps.canUndo ? '' : ' disabled') + '>' + ic('undo-2', 14) + '<span>Отменить</span></button>' +
      '<button type="button" class="btn xs" data-proj="redo"' + (ps && ps.canRedo ? '' : ' disabled') + '>' + ic('redo-2', 14) + '<span>Повторить</span></button></div>';
    if (!journal.length) h += '<p class="hp-note">Журнал пуст.</p>';
    else {
      h += '<ul class="hp-list hp-journal">';
      journal.slice(0, 40).forEach(function (op) {
        var t = Date.parse(op.createdAt || '') || 0, det = opDetail(op);
        h += '<li class="hp-item"><span class="hp-dot"></span><div class="hp-txt"><b>' + esc(opLabel(op.operation)) + '</b>' + (det ? '<small>' + esc(det) + '</small>' : '') + '</div><span class="hp-time" title="' + esc(fmtTime(t)) + '">' + (t ? esc(ago(t, now)) : '') + '</span></li>';
      });
      h += '</ul>';
    }
    h += '</section>';
    if (session.length) {
      h += '<section class="hp-sec"><div class="hp-sec-h">' + ic('list', 15) + '<span>В этом сеансе</span></div><ul class="hp-list hp-session">';
      session.slice().reverse().slice(0, 40).forEach(function (e) { h += '<li class="hp-item ' + esc(e.kind) + '"><span class="hp-dot"></span><div class="hp-txt">' + esc(e.text) + '</div><span class="hp-time">' + esc(fmtTime(e.at)) + '</span></li>'; });
      h += '</ul></section>';
    }
    body.innerHTML = h;
    Array.prototype.forEach.call(body.querySelectorAll('[data-undo]'), function (b) { b.onclick = function () { undoSteps(Number(b.getAttribute('data-undo')) || 1); }; });
    Array.prototype.forEach.call(body.querySelectorAll('[data-proj]'), function (b) { b.onclick = function () { projectMove(b.getAttribute('data-proj')); }; });
  }
  var rt = 0;
  function refresh(reloadJournal) {
    if (!openBack) return;
    clearTimeout(rt);
    rt = setTimeout(function () { (reloadJournal ? loadJournal(true) : Promise.resolve()).then(render); }, 30);
  }
  function close() {
    if (!openBack) return;
    var b = openBack; openBack = null;
    D.removeEventListener('keydown', onKey, true);
    clearInterval(tick);
    b.classList.add('closing'); setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 160);
  }
  function onKey(e) { if (e.key === 'Escape' && openBack && !D.querySelector('.modal.lx-ask')) { e.preventDefault(); e.stopPropagation(); close(); } }
  var tick = 0;
  async function open() {
    if (openBack) { refresh(true); return; }
    install(viewer());
    var back = D.createElement('div'); back.className = 'modal hp-modal';
    back.innerHTML = '<div class="modal-card hp-card" role="dialog" aria-modal="true" aria-labelledby="hpTitle">' +
      '<div class="modal-head"><span id="hpTitle">Последние действия</span><button type="button" class="x" data-ico="x" aria-label="Закрыть"></button></div>' +
      '<div class="hp-body"></div></div>';
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
    back.querySelector('.modal-head .x').onclick = close;
    D.body.appendChild(back); if (kit() && kit().hydrate) kit().hydrate(back); back.classList.add('open');
    openBack = back;
    D.addEventListener('keydown', onKey, true);
    await loadJournal(true); render();
    tick = setInterval(function () { if (openBack) render(); }, 30000);   // «N мин назад»
  }
  if (W.addEventListener) {
    W.addEventListener('lx-viewer-ready', function () { install(viewer()); });
    W.addEventListener('bim-cloud-loaded', function (e) {
      var d = (e && e.detail) || {};
      log('Открыто облако' + (d.path ? ' ' + String(d.path).split(/[\\/]/).pop() : '') + (d.count ? ': ' + fmtCount(d.count) + ' точек' : '') + (d.total && d.count < d.total ? ' из ' + fmtCount(d.total) : '') + (d.filterText ? ' (' + d.filterText + ')' : ''), 'load');
    });
    ['bim-project-state-saved', 'bim-project-state-restored'].forEach(function (n) { W.addEventListener(n, function () { refresh(true); }); });
    setTimeout(function () { install(viewer()); }, 0);
  }
  return Object.assign({}, pure, { open: open, close: close, entries: entries, log: log, hint: setHint, undoSteps: undoSteps, install: install });
});
