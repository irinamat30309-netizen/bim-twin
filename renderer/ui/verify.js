/* BIM Twin — окно «Сверка с документацией».
 * Таблица: измерение → требование из документов помещения → факт → отклонение → статус.
 * Логика сверки живёт в app.js (window.__lxDocCheck) и measurement-doc-compare.js; здесь только показ и действия.
 * Глобал: window.__lxVerify. Чистые функции (statusInfo, bucketOf, countBuckets, filterRows) экспортируются для тестов. */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.__lxVerify = api;
})(typeof window !== 'undefined' ? window : null, function (W) {
  'use strict';

  /* ---------- Чистая часть ---------- */
  var STATUS = {
    'within-tolerance': { tone: 'ok', bucket: 'ok', label: 'В допуске', short: 'В допуске', hint: 'Факт укладывается в допуск из документа' },
    'outside-tolerance': { tone: 'err', bucket: 'err', label: 'Отклонение от документа', short: 'Отклонение', hint: 'Факт вне допуска, указанного в документе' },
    'tolerance-not-specified': { tone: 'warn', bucket: 'review', label: 'Допуск в документе не указан', short: 'Нет допуска', hint: 'Разница посчитана, но допуска в документе нет' },
    'units-unconfirmed': { tone: 'warn', bucket: 'review', label: 'Нужно подтвердить единицы', short: 'Единицы?', hint: 'Укажите единицы измерения облака' },
    'unit-mismatch': { tone: 'warn', bucket: 'review', label: 'Несовместимые величины', short: 'Не сходится', hint: 'Длина сравнивается с площадью или углом' },
    'needs-review': { tone: 'warn', bucket: 'review', label: 'Нужна проверка', short: 'Проверить', hint: 'Найден похожий пункт, но нужна ваша проверка' },
    'analyzing': { tone: 'accent', bucket: 'busy', label: 'Читаю документы', short: 'Анализ', hint: 'Идёт разбор документов помещения', busy: true },
    'no-match': { tone: 'muted', bucket: 'none', label: 'В документах не найдено', short: 'Нет в доках', hint: 'Подходящего требования в документах нет' },
    'not-checked': { tone: 'muted', bucket: 'none', label: 'Не сверено', short: 'Не сверено', hint: 'Сверка ещё не запускалась' }
  };
  function statusInfo(status, how) {
    var s = STATUS[status] || STATUS['not-checked'];
    return { tone: s.tone, bucket: s.bucket, label: s.label, short: s.short, hint: s.hint, busy: !!s.busy, proposal: how === 'proposal' };
  }
  function bucketOf(status) { return statusInfo(status).bucket; }
  function countBuckets(rows) {
    var c = { all: 0, ok: 0, err: 0, review: 0, none: 0, busy: 0 };
    (rows || []).forEach(function (r) { c.all++; c[bucketOf(r.status)]++; });
    return c;
  }
  function filterRows(rows, key) {
    if (!key || key === 'all') return (rows || []).slice();
    return (rows || []).filter(function (r) { var b = bucketOf(r.status); return key === 'review' ? (b === 'review' || b === 'busy') : b === key; });
  }
  var MODE_NAMES = { distance: 'Расстояние', point: 'Координата', polyline: 'Полилиния', angle: 'Угол', area: 'Площадь', plane: 'Плоскость', deviation: 'Зазор', corner: 'Ребро / угол' };
  function rowTitle(r) { return r && r.label ? r.label : (MODE_NAMES[r && r.mode] || 'Измерение') + ' ' + ((r ? r.index : 0) + 1); }
  var KINDS = ['стена', 'колонна', 'балка', 'перекрытие', 'пол', 'потолок', 'проём', 'дверь', 'окно', 'труба', 'воздуховод', 'оборудование'];
  var HOW = { auto: 'найдено автоматически', user: 'подтверждено вами', manual: 'введено вручную', proposal: 'предложение, не подтверждено' };
  var UNITS = [['м', 'метры'], ['мм', 'миллиметры'], ['см', 'сантиметры'], ['ft', 'футы'], ['in', 'дюймы']];

  var api = { statusInfo: statusInfo, bucketOf: bucketOf, countBuckets: countBuckets, filterRows: filterRows, rowTitle: rowTitle, KINDS: KINDS, STATUS: STATUS, HOW: HOW, open: function () {}, close: function () {} };
  if (!W || typeof document === 'undefined') return api;

  /* ---------- Окно ---------- */
  var D = document;
  var modal = null, listEl = null, statsEl = null, tabsEl = null, subEl = null, bodyEl = null, prevFocus = null, roomSel = null;
  var S = { filter: 'all', tab: 'rows', open: -1, cands: {}, busy: false, reqRoom: '', reqData: null, reqBusy: false, raf: 0 };

  function el(tag, cls, text) { var n = D.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function ic(name, size) { var s = el('span'); s.setAttribute('data-ico', name); s.setAttribute('data-ico-size', String(size || 16)); s.setAttribute('aria-hidden', 'true'); return s; }
  function btn(text, icon, cls, title) {
    var b = el('button', 'btn sm' + (cls ? ' ' + cls : '')); b.type = 'button';
    if (icon) b.appendChild(ic(icon, 15));
    var l = el('span', 'lbl', text); b.appendChild(l);
    if (title) b.setAttribute('data-tip', title);
    return b;
  }
  function dc() { return W.__lxDocCheck || null; }
  function toast(m, o) { try { if (W.__lxKit) W.__lxKit.toast(m, o); } catch (e) {} }
  function hydrate(n) { try { if (W.__lxKit) W.__lxKit.hydrate(n); } catch (e) {} }
  function chip(info, extra) {
    var c = el('span', 'vf-chip ' + info.tone + (extra ? ' ' + extra : ''));
    if (info.busy) c.appendChild(el('span', 'vf-spin')); else c.appendChild(el('span', 'vf-dot'));
    c.appendChild(el('span', 'lbl', info.short));
    return c;
  }

  function build() {
    if (modal) return;
    modal = el('div', 'lx-win-back vf-back'); modal.id = 'lxVfModal'; modal.hidden = true;
    var win = el('div', 'lx-win vf-win'); win.setAttribute('role', 'dialog'); win.setAttribute('aria-modal', 'true'); win.setAttribute('aria-labelledby', 'lxVfTitle');
    var head = el('header', 'lx-win-head');
    var title = el('div', 'lx-win-title'); title.appendChild(ic('clipboard-check', 18)); var t = el('span', '', 'Сверка с документацией'); t.id = 'lxVfTitle'; title.appendChild(t);
    subEl = el('div', 'lx-win-sub', '');
    var x = el('button', 'icon-btn'); x.type = 'button'; x.setAttribute('aria-label', 'Закрыть'); x.setAttribute('data-tip', 'Закрыть · Esc'); x.appendChild(ic('x', 18)); x.onclick = close;
    head.appendChild(title); head.appendChild(subEl); head.appendChild(x);

    var bar = el('div', 'vf-bar');
    tabsEl = el('div', 'seg-group'); tabsEl.setAttribute('role', 'tablist');
    [['rows', 'Измерения'], ['reqs', 'Найдено в документах']].forEach(function (p) {
      var b = el('button', 'hbtn', ''); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.tab = p[0]; b.appendChild(el('span', 'lbl', p[1]));
      b.onclick = function () { setTab(p[0]); }; tabsEl.appendChild(b);
    });
    var acts = el('div', 'vf-actions');
    var runB = btn('Сверить всё', 'wand-sparkles', 'primary', 'Заново прочитать документы и сопоставить все измерения'); runB.id = 'lxVfRun'; runB.onclick = runAll;
    var csvB = btn('CSV', 'file-down', '', 'Сохранить таблицу сверки в CSV'); csvB.id = 'lxVfCsv'; csvB.onclick = function () { if (dc()) dc().exportCsv(); };
    acts.appendChild(csvB); acts.appendChild(runB);
    bar.appendChild(tabsEl); bar.appendChild(acts);

    statsEl = el('div', 'vf-stats'); statsEl.setAttribute('role', 'group'); statsEl.setAttribute('aria-label', 'Фильтр по статусу');
    bodyEl = el('div', 'vf-body');
    listEl = el('div', 'vf-table'); listEl.setAttribute('role', 'table'); listEl.setAttribute('aria-label', 'Сверка измерений с документацией');
    var foot = el('footer', 'vf-foot');
    foot.appendChild(el('p', 'vf-note', 'Документы помещения читаются автоматически: PDF, Word, Excel, CSV, TXT, DXF и сканы (через OCR). Статус «В допуске» или «Отклонение» ставится сам только при однозначном совпадении объекта, размера и единиц; остальное остаётся на вашу проверку.'));
    win.appendChild(head); win.appendChild(bar); win.appendChild(statsEl); win.appendChild(bodyEl); win.appendChild(foot);
    modal.appendChild(win);
    modal.addEventListener('mousedown', function (e) { if (e.target === modal) close(); });
    D.body.appendChild(modal);
    hydrate(modal);
  }

  function setTab(t) {
    S.tab = t; S.open = -1;
    Array.prototype.forEach.call(tabsEl.children, function (b) { var on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    render();
    if (t === 'reqs') loadReqs(false);
  }

  function schedule() {
    if (!modal || modal.hidden) return;
    if (S.raf) return;
    S.raf = W.requestAnimationFrame(function () { S.raf = 0; render(); });
  }

  /* ---------- Рендер ---------- */
  function render() {
    if (!modal || modal.hidden) return;
    var d = dc();
    var rows = d ? d.rows() : [];
    var meta = d ? d.meta() : { rooms: [] };
    var counts = countBuckets(rows);
    var parts = [];
    if (meta.currentRoomName) parts.push(meta.currentRoomName);
    parts.push(rows.length + ' ' + plural(rows.length, 'измерение', 'измерения', 'измерений'));
    subEl.textContent = parts.join(' · ');
    Array.prototype.forEach.call(tabsEl.children, function (b) { var on = b.dataset.tab === S.tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    renderStats(counts);
    statsEl.hidden = S.tab !== 'rows';
    bodyEl.innerHTML = '';
    var scrollTop = 0;
    if (S.tab === 'rows') renderRows(rows, meta); else renderReqs(meta);
    hydrate(bodyEl);
    var run = modal.querySelector('#lxVfRun'); if (run) { run.disabled = S.busy || !rows.length; }
    return scrollTop;
  }

  function plural(n, a, b, c) { var m = Math.abs(n) % 100, k = m % 10; if (m > 10 && m < 20) return c; if (k > 1 && k < 5) return b; if (k === 1) return a; return c; }

  function renderStats(counts) {
    statsEl.innerHTML = '';
    [['all', 'Все', 'muted'], ['ok', 'В допуске', 'ok'], ['err', 'Отклонения', 'err'], ['review', 'Проверить', 'warn'], ['none', 'Нет в документах', 'muted']].forEach(function (p) {
      var n = p[0] === 'review' ? counts.review + counts.busy : counts[p[0]];
      var b = el('button', 'vf-stat ' + p[2] + (S.filter === p[0] ? ' on' : '')); b.type = 'button'; b.setAttribute('aria-pressed', S.filter === p[0] ? 'true' : 'false');
      b.appendChild(el('span', 'vf-stat-n', String(n))); b.appendChild(el('span', 'vf-stat-l', p[1]));
      b.onclick = function () { S.filter = p[0]; S.open = -1; render(); };
      statsEl.appendChild(b);
    });
  }

  function emptyState(icon, title, text, action) {
    var e = el('div', 'vf-empty'); e.appendChild(ic(icon, 28)); e.appendChild(el('strong', '', title)); e.appendChild(el('p', '', text));
    if (action) e.appendChild(action);
    return e;
  }

  function renderRows(rows, meta) {
    if (!rows.length) {
      var go = btn('Измерить объект', 'scan-search', 'primary');
      go.onclick = function () { close(); var b = D.getElementById('lxObjInspectBtn'); if (b) b.click(); };
      bodyEl.appendChild(emptyState('ruler', 'Измерений пока нет', 'Измерьте стену, колонну или проём: результат появится здесь и сам сверится с документами помещения.', go));
      return;
    }
    var shown = filterRows(rows, S.filter);
    listEl = el('div', 'vf-table'); listEl.setAttribute('role', 'table'); listEl.setAttribute('aria-label', 'Сверка измерений с документацией');
    var hd = el('div', 'vf-row vf-hd'); hd.setAttribute('role', 'row');
    ['№', 'Измерение', 'По документу', 'Факт', 'Откл.', 'Статус'].forEach(function (h, i) { var c = el('div', 'vf-c c' + i, h); c.setAttribute('role', 'columnheader'); hd.appendChild(c); });
    listEl.appendChild(hd);
    if (!shown.length) listEl.appendChild(el('div', 'vf-none', 'В этой группе пока ничего нет.'));
    shown.forEach(function (r) { listEl.appendChild(rowNode(r, meta)); });
    bodyEl.appendChild(listEl);
  }

  function rowNode(r, meta) {
    var info = statusInfo(r.status, r.how);
    var wrap = el('div', 'vf-item' + (S.open === r.index ? ' open' : '')); wrap.dataset.index = String(r.index);
    var row = el('button', 'vf-row vf-main ' + info.tone + (r.how === 'proposal' ? ' proposal' : '')); row.type = 'button'; row.setAttribute('role', 'row');
    row.setAttribute('aria-expanded', S.open === r.index ? 'true' : 'false');
    var c0 = el('div', 'vf-c c0'); c0.setAttribute('role', 'cell'); c0.appendChild(ic('chevron-right', 14)); c0.appendChild(el('span', '', String(r.index + 1)));
    var c1 = el('div', 'vf-c c1'); c1.setAttribute('role', 'cell');
    c1.appendChild(el('span', 'vf-t', rowTitle(r)));
    c1.appendChild(el('span', 'vf-s', r.valueText || '—'));
    var tags = el('span', 'vf-tags');
    tags.appendChild(el('span', 'vf-tag' + (r.objectType ? '' : ' none'), r.objectType || 'тип не указан'));
    tags.appendChild(el('span', 'vf-tag' + (r.roomName ? '' : ' none'), r.roomName || 'помещение не указано'));
    c1.appendChild(tags);
    var c2 = el('div', 'vf-c c2'); c2.setAttribute('role', 'cell');
    if (r.expectedText) {
      c2.appendChild(el('span', 'vf-t', r.expectedText));
      var src = r.source && r.source.documentName ? r.source.documentName + (r.source.location ? ' · ' + r.source.location : '') : '';
      c2.appendChild(el('span', 'vf-s', src));
    } else {
      c2.appendChild(el('span', 'vf-t muted', r.status === 'analyzing' ? 'Читаю документы…' : r.status === 'no-match' ? 'Требование не найдено' : '—'));
    }
    var c3 = el('div', 'vf-c c3'); c3.setAttribute('role', 'cell'); c3.appendChild(el('span', 'vf-t', r.actualText || '—')); if (r.fieldLabel) c3.appendChild(el('span', 'vf-s', r.fieldLabel));
    var c4 = el('div', 'vf-c c4'); c4.setAttribute('role', 'cell'); c4.appendChild(el('span', 'vf-t vf-delta ' + info.tone, r.deltaText || '—'));
    var c5 = el('div', 'vf-c c5'); c5.setAttribute('role', 'cell'); c5.appendChild(chip(info)); if (r.how && HOW[r.how]) c5.appendChild(el('span', 'vf-s', r.how === 'proposal' ? 'предложение' : r.how === 'auto' ? 'авто' : r.how === 'user' ? 'вы подтвердили' : 'вручную'));
    [c0, c1, c2, c3, c4, c5].forEach(function (c) { row.appendChild(c); });
    row.onclick = function () { S.open = S.open === r.index ? -1 : r.index; render(); if (S.open === r.index) loadCands(r.index); };
    wrap.appendChild(row);
    if (S.open === r.index) wrap.appendChild(detailNode(r, meta));
    return wrap;
  }

  function field(label, control) { var f = el('label', 'lx-field'); f.appendChild(el('span', '', label)); f.appendChild(control); return f; }
  function select(options, value, onChange, aria) {
    var s = el('select', 'cmp-select'); if (aria) s.setAttribute('aria-label', aria);
    options.forEach(function (o) { var op = el('option', '', o[1]); op.value = o[0]; s.appendChild(op); });
    s.value = value; s.onchange = function () { onChange(s.value); };
    return s;
  }

  function detailNode(r, meta) {
    var d = dc();
    var box = el('div', 'vf-detail');
    var left = el('div', 'vf-col');
    left.appendChild(el('h4', 'lx-win-h', 'Что сказано в документе'));
    if (r.source && (r.source.excerpt || r.source.documentName)) {
      var q = el('blockquote', 'vf-quote', r.source.excerpt || 'Фрагмент не сохранён.'); left.appendChild(q);
      left.appendChild(el('p', 'vf-s', (r.source.documentName || 'Документ') + (r.source.location ? ' · ' + r.source.location : '') + (r.source.ocr ? ' · текст распознан OCR, сверьте с оригиналом' : '')));
      var open = btn('Открыть документ', 'external-link', ''); open.onclick = function () { if (d) d.openDocument(r.index); }; left.appendChild(open);
    } else {
      left.appendChild(el('p', 'vf-s', r.status === 'analyzing' ? 'Документы помещения читаются…' : r.roomId ? 'В документах помещения нет пункта, который подходит к этому измерению. Проверьте тип объекта справа или добавьте документы во вкладке «Документы».' : 'У измерения не указано помещение — без него непонятно, какие документы читать.'));
    }
    if (r.reasons && r.reasons.length) { left.appendChild(el('h4', 'lx-win-h', 'Почему выбрано это требование')); left.appendChild(list(r.reasons)); }
    if (r.warnings && r.warnings.length) { left.appendChild(el('h4', 'lx-win-h', 'На что обратить внимание')); left.appendChild(list(r.warnings, 'warn')); }

    var right = el('div', 'vf-col');
    right.appendChild(el('h4', 'lx-win-h', 'Уточнить'));
    var kindOpts = [['', 'Определить автоматически']].concat(KINDS.map(function (k) { return [k, k.charAt(0).toUpperCase() + k.slice(1)]; }));
    var cur = r.objectType && KINDS.indexOf(r.objectType) < 0 ? r.objectType : (r.objectType || '');
    if (cur && KINDS.indexOf(cur) < 0) kindOpts.push([cur, cur]);
    right.appendChild(field('Тип объекта', select(kindOpts, cur, function (v) { d.setContext(r.index, { objectType: v }); }, 'Тип объекта')));
    var roomOpts = [['', 'Не указано']].concat((meta.rooms || []).map(function (m) { return [m.id, m.name + (m.docs ? ' · документов: ' + m.docs : ' · нет документов')]; }));
    right.appendChild(field('Помещение (откуда брать документы)', select(roomOpts, r.roomId || '', function (v) { if (v) d.setContext(r.index, { roomId: v }); }, 'Помещение')));
    if (!r.units) {
      var uo = [['', 'Выберите…']].concat(UNITS.map(function (u) { return [u[0], u[0] + ' — ' + u[1]]; }));
      var uf = field('Единицы облака точек (в файле не указаны)', select(uo, '', function (v) { if (v) d.setContext(r.index, { units: v }); }, 'Единицы облака'));
      right.appendChild(uf);
    }
    var acts = el('div', 'vf-detail-acts');
    var c = S.cands[r.index];
    var best = c && c.ok && c.list && c.list[0];
    if (r.how === 'proposal' && best && best.canConfirm) {
      var ok = btn('Подтвердить', 'check', 'primary', 'Принять это требование и посчитать отклонение'); ok.onclick = function () { accept(r.index, best.key); }; acts.appendChild(ok);
    }
    var re = btn('Пересверить', 'refresh-cw', ''); re.onclick = function () { S.cands[r.index] = null; d.run(r.index); loadCands(r.index, true); }; acts.appendChild(re);
    var man = btn('Вручную…', 'pencil', '', 'Выбрать пункт и единицы самостоятельно'); man.onclick = function () { d.details(r.index); }; acts.appendChild(man);
    var del = btn('Удалить', 'trash-2', 'danger'); del.onclick = function () { S.open = -1; d.remove(r.index); }; acts.appendChild(del);
    right.appendChild(acts);

    box.appendChild(left); box.appendChild(right);
    var alt = el('div', 'vf-alts');
    alt.appendChild(el('h4', 'lx-win-h', 'Другие подходящие пункты'));
    if (!c) { alt.appendChild(el('div', 'lx-skel vf-skel')); alt.appendChild(el('div', 'lx-skel vf-skel')); }
    else if (!c.ok) alt.appendChild(el('p', 'vf-s', c.reason === 'no-room' ? 'Выберите помещение, чтобы искать в его документах.' : 'Не удалось получить варианты.'));
    else if (!c.list.length) alt.appendChild(el('p', 'vf-s', 'Подходящих числовых требований в ' + (c.docs || 0) + ' ' + plural(c.docs || 0, 'документе', 'документах', 'документах') + ' не найдено.'));
    else c.list.forEach(function (a, i) { alt.appendChild(altNode(r, a, i)); });
    box.appendChild(alt);
    return box;
  }

  function list(items, cls) { var u = el('ul', 'vf-list' + (cls ? ' ' + cls : '')); items.forEach(function (t) { u.appendChild(el('li', '', t)); }); return u; }

  function altNode(r, a, i) {
    var n = el('div', 'vf-alt');
    var main = el('div', 'vf-alt-main');
    main.appendChild(el('span', 'vf-t', a.expectedText || a.label));
    var sub = (a.source.documentName || 'Документ') + (a.source.location ? ' · ' + a.source.location : '');
    main.appendChild(el('span', 'vf-s', sub));
    if (a.actualText) main.appendChild(el('span', 'vf-s', 'Факт ' + a.actualText + (a.deltaText ? ' · откл. ' + a.deltaText : '')));
    n.appendChild(main);
    n.appendChild(el('span', 'vf-score ' + (a.confidence === 'high' ? 'ok' : a.confidence === 'medium' ? 'warn' : 'muted'), a.score + '%'));
    var pick = btn(i === 0 ? 'Принять' : 'Выбрать', 'check', a.canConfirm ? '' : ''); pick.disabled = !a.canConfirm;
    if (!a.canConfirm) pick.setAttribute('data-tip', a.needsUnits ? 'Сначала укажите единицы облака' : 'Для этого пункта нельзя посчитать отклонение');
    pick.onclick = function () { accept(r.index, a.key); };
    n.appendChild(pick);
    return n;
  }

  function renderReqs(meta) {
    var head = el('div', 'vf-reqhead');
    var opts = (meta.rooms || []).map(function (m) { return [m.id, m.name + ' · документов: ' + m.docs]; });
    if (!S.reqRoom) S.reqRoom = meta.currentRoomId || (opts[0] && opts[0][0]) || '';
    if (opts.length) {
      roomSel = select(opts, S.reqRoom, function (v) { S.reqRoom = v; S.reqData = null; render(); loadReqs(false); }, 'Помещение');
      head.appendChild(field('Помещение', roomSel));
    }
    var rescan = btn('Перечитать документы', 'refresh-cw', '', 'Сбросить кэш и заново разобрать файлы'); rescan.onclick = function () { loadReqs(true); };
    head.appendChild(rescan);
    bodyEl.appendChild(head);
    var data = S.reqData;
    if (S.reqBusy || !data) {
      var sk = el('div', 'vf-reqlist'); for (var k = 0; k < 4; k++) sk.appendChild(el('div', 'lx-skel vf-skel'));
      bodyEl.appendChild(sk); return;
    }
    if (!data.ok) { bodyEl.appendChild(emptyState('files', 'Помещение не выбрано', 'Откройте помещение и добавьте к нему документы во вкладке «Документы».')); return; }
    if (!data.docs.length) { bodyEl.appendChild(emptyState('files', 'У помещения нет документов', 'Добавьте PDF, Word, Excel, CSV, DXF или скан во вкладке «Документы»: числа и допуски из них станут доступны для сверки.')); return; }
    var docs = el('div', 'vf-docs');
    data.docs.forEach(function (x) {
      var row = el('div', 'vf-doc'); row.appendChild(ic('file-text', 16));
      var nm = el('div', 'vf-doc-n'); nm.appendChild(el('span', 'vf-t', x.name)); nm.appendChild(el('span', 'vf-s', x.ext ? x.ext.toUpperCase() : ''));
      row.appendChild(nm);
      var st = x.state === 'ok' ? { tone: 'ok', short: 'Требований: ' + x.found } : x.state === 'empty' ? { tone: 'warn', short: 'Чисел не найдено' } : { tone: 'muted', short: 'Формат не читается' };
      row.appendChild(chip(st)); docs.appendChild(row);
    });
    bodyEl.appendChild(docs);
    if (data.nativeCadSkipped) bodyEl.appendChild(el('p', 'vf-note', 'DWG, RVT и IFC напрямую не читаются: сохраните нужные листы в PDF или DXF.'));
    if (data.errors && data.errors.length) bodyEl.appendChild(list(data.errors.slice(0, 5), 'warn'));
    var reqs = el('div', 'vf-reqlist');
    reqs.appendChild(el('h4', 'lx-win-h', 'Найденные числа и допуски (' + data.items.length + ')'));
    if (!data.items.length) reqs.appendChild(el('p', 'vf-s', 'В документах нет чисел с единицами измерения, которые можно сравнить.'));
    data.items.slice(0, 200).forEach(function (it) {
      var r = el('div', 'vf-req');
      var m = el('div', 'vf-alt-main'); m.appendChild(el('span', 'vf-t', it.label));
      m.appendChild(el('span', 'vf-s', (it.source.documentName || '') + (it.source.location ? ' · ' + it.source.location : '')));
      if (it.source.excerpt) m.appendChild(el('span', 'vf-s vf-ex', it.source.excerpt));
      r.appendChild(m);
      r.appendChild(el('span', 'vf-score ' + (it.confidence === 'high' ? 'ok' : it.confidence === 'medium' ? 'warn' : 'muted'), it.confidence === 'high' ? 'явно' : it.confidence === 'medium' ? 'по заголовку' : 'неточно'));
      reqs.appendChild(r);
    });
    bodyEl.appendChild(reqs);
  }

  /* ---------- Действия ---------- */
  function loadCands(i, silentKeep) {
    var d = dc(); if (!d) return;
    if (!silentKeep && S.cands[i]) return;
    d.candidates(i).then(function (res) { S.cands[i] = res; if (S.open === i) schedule(); }, function () { S.cands[i] = { ok: false, reason: 'error', list: [] }; schedule(); });
  }
  function loadReqs(force) {
    var d = dc(); if (!d || S.reqBusy) return;
    S.reqBusy = true; render();
    d.requirements(S.reqRoom, { force: !!force }).then(function (res) { S.reqData = res; S.reqBusy = false; render(); }, function () { S.reqData = { ok: false, docs: [], items: [] }; S.reqBusy = false; render(); });
  }
  function accept(i, key) {
    var d = dc(); if (!d) return;
    d.accept(i, key).then(function (res) {
      if (res && res.ok) { S.cands[i] = null; toast(res.status === 'outside-tolerance' ? 'Сохранено: есть отклонение от документа' : 'Сверка сохранена', { tone: res.status === 'outside-tolerance' ? 'warn' : 'ok' }); }
      schedule();
    });
  }
  function runAll() {
    var d = dc(); if (!d || S.busy) return;
    S.busy = true; S.cands = {};
    var b = modal.querySelector('#lxVfRun'); var lbl = b && b.querySelector('.lbl');
    if (b) { b.disabled = true; b.classList.add('busy'); }
    d.runAll(function (p) { if (lbl) lbl.textContent = 'Сверяю ' + p.current + ' из ' + p.total; }).then(function (c) {
      S.busy = false; if (b) b.classList.remove('busy'); if (lbl) lbl.textContent = 'Сверить всё';
      var msg = c.confirmed ? 'Сверено: ' + c.confirmed + (c.outside ? ' · отклонений: ' + c.outside : '') + (c.review ? ' · на проверку: ' + c.review : '') : 'Автоматически ничего не сопоставлено: проверьте тип объекта и документы';
      toast(msg, { tone: c.outside ? 'warn' : 'info' }); render();
    }, function () { S.busy = false; if (lbl) lbl.textContent = 'Сверить всё'; render(); });
  }

  function open(opts) {
    opts = opts || {};
    build();
    prevFocus = D.activeElement;
    modal.hidden = false;
    if (opts.focus != null) { S.tab = 'rows'; S.filter = 'all'; S.open = opts.focus; loadCands(opts.focus); }
    else if (opts.tab) S.tab = opts.tab;
    Array.prototype.forEach.call(tabsEl.children, function (b) { b.classList.toggle('on', b.dataset.tab === S.tab); });
    render();
    if (S.tab === 'reqs') loadReqs(false);
    var first = modal.querySelector('#lxVfRun'); if (first && !first.disabled) first.focus({ preventScroll: true });
    if (opts.focus != null) { var n = modal.querySelector('.vf-item.open'); if (n && n.scrollIntoView) n.scrollIntoView({ block: 'nearest' }); }
  }
  function close() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    try { if (prevFocus && prevFocus.focus && D.contains(prevFocus)) prevFocus.focus({ preventScroll: true }); } catch (e) {}
    prevFocus = null;
  }
  W.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal && !modal.hidden) { e.preventDefault(); e.stopImmediatePropagation(); close(); }
  }, true);
  W.addEventListener('lx-measurements-changed', function () { schedule(); });

  api.open = open; api.close = close; api.isOpen = function () { return !!modal && !modal.hidden; };
  return api;
});
