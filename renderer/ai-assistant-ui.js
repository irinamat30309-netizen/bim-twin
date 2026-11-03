/*
 * ai-assistant-ui.js — панель «ИИ-ассистент» (ревизия 35).
 * Чат с локальной моделью (Qwen через Ollama, только 127.0.0.1): ответы по результатам «Контроля геометрии»
 * и сравнения с DXF, подсказки по командам и нормам, калькулятор. Действия (запуск команды, показ результата,
 * выгрузка CSV/PDF/DXF/IFC) — только после подтверждения. Пока модель ставится — простой режим по шаблонам.
 * Логика — ai/assistant.js (BimAssistant), справка — ai/assistant-kb.js, подсказка модели — ai/assistant-prompt.js.
 * r35: «База норм» (кнопка с книгой): документы СП/ГОСТ/проекты, индексация, пробный поиск; источники под ответом;
 *   снимок вида для модели со зрением (кнопка с камерой).
 * r42: «Что это?» — щелчок по облаку: что за элемент, размеры, отклонения, проверка по встроенной базе и сверка с документами;
 *   «почисти облако» — чистка с предпросмотром; оценки ответов и «Опыт и знания» (память, пакеты знаний, обновление модели опытом).
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BimAssistantUI = api;
})(typeof window !== 'undefined' ? window : null, function (W) {
  'use strict';
  var D = W && W.document;
  var KEY_THINK = 'bim.ai.think', KEY_HIST = 'bim.ai.history';
  var TAB_TEXT = { floor: 'Пол', walls: 'Стены', def: 'Дефекты', open: 'Проёмы', mep: 'Балки и трубы', dxf: 'Проект' };
  var TOOL_TEXT = { get_overview: 'сводка', get_walls: 'стены', get_floor: 'пол', get_defects: 'дефекты', get_openings: 'проёмы', get_mep: 'балки и трубы',
    get_dxf_compare: 'сравнение с DXF', search_help: 'справка', find_command: 'команды', calculate: 'расчёт', run_command: 'запуск команды', show_result: 'показ результата', export_result: 'выгрузка',
    search_norms: 'база норм', look_at_view: 'снимок вида', clean_cloud: 'чистка облака', audit_cloud: 'проверка облака', run_plan: 'план действий', run_skill: 'навык', save_skill: 'сохранить навык', check_updates: 'обновления баз', install_updates: 'установка обновлений', get_picked: 'выбранный элемент', pick_element: 'выбор элемента', remember: 'запомнить', recall_memory: 'память' };
  var KIND_TEXT = { rule: 'Правило', fact: 'Знание', note: 'Об объекте', example: 'Удачный ответ', correction: 'Исправление', skill: 'Навык' };
  var KEY_MEM = 'bim.ai.memory';
  var NSTATUS = { queued: 'в очереди', working: 'обрабатывается…', ok: 'готово', scan: 'скан без текста', empty: 'текст не найден', error: 'ошибка' };
  var PHASE_TEXT = { none: 'модель не установлена', check: 'проверка компьютера', runtime: 'загрузка Ollama', extract: 'распаковка Ollama', server: 'запуск сервера модели',
    model: 'загрузка модели', create: 'настройка ассистента', ready: 'готово', error: 'ошибка установки' };

  function A() { return W && W.bimAPI; }
  function K() { return W && W.__lxKit; }
  function B() { return W && W.BimAssistant; }
  function MM() { return W && W.BimMemory; }
  function EI() { return W && W.ElementIdentify; }
  function ic(n, s) { return W && W.__lxIcons ? W.__lxIcons.svg(n, s || 16) : ''; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function store(k, v) { try { if (v === undefined) return W.localStorage.getItem(k); if (v === null) W.localStorage.removeItem(k); else W.localStorage.setItem(k, v); } catch (_) {} return null; }
  function toast(m, err) { var k = K(); if (k && k.toast) k.toast(m, err ? { tone: 'err' } : undefined); }
  function fmtGb(x) { return (Math.round(x * 10) / 10).toString().replace('.', ',') + ' ГБ'; }

  // лёгкая разметка ответа: **жирный**, `код`, списки «- » и «1. », абзацы
  function md(text) {
    var lines = esc(text).split(/\r?\n/), out = [], list = null;
    function inline(s) { return s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>'); }
    function flush() { if (list) { out.push('<' + list.t + '>' + list.items.join('') + '</' + list.t + '>'); list = null; } }
    lines.forEach(function (l) {
      var m = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(l);
      if (m) { var t = m[1] ? 'ol' : 'ul'; if (!list || list.t !== t) { flush(); list = { t: t, items: [] }; } list.items.push('<li>' + inline(m[2]) + '</li>'); return; }
      flush(); if (/^\s*#{1,4}\s+/.test(l)) { out.push('<p><b>' + inline(l.replace(/^\s*#{1,4}\s+/, '')) + '</b></p>'); return; }
      if (l.trim()) out.push('<p>' + inline(l) + '</p>');
    });
    flush(); return out.join('');
  }

  // ------------------------------------------------------------------ связь с приложением (ctx для BimAssistant)
  function inspectCurrent() { var U = W && W.CloudInspectUI; try { return U && U.current ? U.current() : null; } catch (_) { return null; } }
  function ribbonBtn(id) { var R = W && W.__lxRibbon; try { return R && R.button ? R.button(id) : null; } catch (_) { return null; } }
  function makeCtx() {
    return {
      inspection: function () { var c = inspectCurrent(); return c ? c.res : null; },
      compare: function () { var c = inspectCurrent(); return c && c.S ? c.S.cmp : null; },
      cloud: function () {
        var li = W.__bimLoadInfo || null, p = null; try { p = W.__bimLastCloudPath ? W.__bimLastCloudPath() : null; } catch (_) {}
        p = p || (li && li.path) || null; if (!p) return null;
        return { name: String(p).split(/[\\/]/).pop(), path: p, points: li ? li.count : null, total: li ? li.total : null, sampled: li ? !!li.sampled : false };
      },
      project: function () { return W.__bimProjectName || ''; },
      commands: function () {
        var BA = B(); if (!BA || !W.__lxCommands) return [];
        return BA.flattenCommands(W.__lxCommands, {
          label: function (it) { var b = ribbonBtn(it.id); return b ? (b.getAttribute('aria-label') || b.title || b.textContent || '').trim() : ''; },
          enabled: function (it) { var b = ribbonBtn(it.id); return !(b && b.getAttribute('aria-disabled') === 'true'); }
        }).filter(function (c) { return c.id !== 'aiAssistant'; });
      },
      runCommand: function (id) {
        if (id === 'aiAssistant') return { ok: true, message: 'Ассистент уже открыт' };
        var b = ribbonBtn(id); if (!b) return { ok: false, message: 'Команда не найдена: ' + id };
        if (b.getAttribute('aria-disabled') === 'true') return { ok: false, message: 'Команда пока недоступна — сначала откройте облако точек или модель' };
        try { b.click(); return { ok: true, message: 'Команда запущена' }; } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
      },
      showResult: function (a) {
        var U = W.CloudInspectUI, S = U && U.reopen ? U.reopen() : null; if (!S) return { ok: false, message: 'Нет результата контроля геометрии' };
        a = a || {};
        if (a.wall > 0 && S.selectWall) { S.selectWall(Math.round(a.wall) - 1); return { ok: true, message: 'Показана стена ' + a.wall }; }
        if (a.item > 0 && a.tab && S.selectItem && S.selectItem(a.tab, a.item)) return { ok: true, message: 'Показана строка ' + a.item + ' на вкладке «' + (TAB_TEXT[a.tab] || a.tab) + '»' };
        if (a.tab && S.showTab && !S.showTab(a.tab)) return { ok: false, message: 'В этом результате нет вкладки «' + (TAB_TEXT[a.tab] || a.tab) + '»' };
        return { ok: true, message: 'Открыто окно результатов' + (a.tab ? ' — «' + (TAB_TEXT[a.tab] || a.tab) + '»' : '') };
      },
      exportResult: async function (format) {
        var U = W.CloudInspectUI, S = U && U.reopen ? U.reopen() : null; if (!S) return { ok: false, message: 'Нет результата контроля геометрии' };
        try {
          if (format === 'csv') await S.exportCsv();
          else if (format === 'pdf') await S.exportPdf();
          else if (format === 'mep_dxf' || format === 'mep_ifc') { if (S.exportMep(format === 'mep_ifc' ? 'ifc' : 'dxf') === null) return { ok: false, message: 'В результате нет балок и труб' }; }
          else return { ok: false, message: 'Неизвестный формат: ' + format };
          return { ok: true, message: 'Открыто сохранение файла (' + format + ')' };
        } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
      },
      searchNorms: function (q, o) { var api = A(); return api && api.normsSearch ? api.normsSearch(q, o || {}) : Promise.resolve({ ok: false, error: 'База норм доступна в настольной версии' }); },
      normsInfo: function () {
        var n = state.norms; if (!n) return '';
        var docs = (n.docs || []).filter(function (d) { return d.status === 'ok'; });
        return 'встроенная (' + ((n.builtin && n.builtin.entries) || 0) + ' статей, кратко) + документов пользователя: ' + docs.length + (docs.length ? ' (' + docs.slice(0, 8).map(function (d) { return d.code || d.name; }).join('; ') + ')' : '');
      },
      vision: function () { return !!(state.st && state.st.ready && state.st.vision); },
      captureView: function () {
        var api = A(); if (!api || !api.aiCaptureView) return Promise.resolve({ ok: false, error: 'Снимок вида доступен в настольной версии' });
        var r = null;
        if (P && !P.el.hidden) { var b = P.el.getBoundingClientRect(); var w = Math.max(16, Math.floor(b.left) - 4); r = { x: 0, y: 0, width: w, height: Math.floor(W.innerHeight || 0) }; }
        return api.aiCaptureView(r);
      },
      confirm: async function (text) {
        var k = K(); if (!k || !k.ask) return false;   // без диалога подтверждения действие не выполняется
        return !!(await k.ask({ title: 'Ассистент предлагает действие', message: text, okLabel: 'Выполнить', cancelLabel: 'Не надо' }));
      },
      // r42: чистка облака — та же «Автоочистка» / «Чистка до мелочей», но без формы; предпросмотр удаляемого и «Применить» остаются
      cleanCloud: function (o) {
        var X = W.__lxToolsExt; if (!X || !X.ops || !X.ops.opAutoClean) return Promise.resolve({ ok: false, message: 'Инструменты облака не загружены.' });
        o = o || {}; var th = o.thoroughness || 'normal';
        return Promise.resolve(X.ops.opAutoClean({ deep: th === 'deep', preset: { level: th === 'quick' ? 'soft' : th === 'deep' ? 'strong' : 'medium', people: o.people === 'off' ? 'off' : o.people === 'strict' ? 'strict' : 'normal', flatten: th !== 'quick', keepShape: !o.flatten, hair: th !== 'quick' } }))
          .then(function (r) { return r || { ok: false, message: 'Облако не изменено (нет открытого облака или идёт другая обработка).' }; });
      },
      picked: function () { var E = EI(), pk = state.picked; return pk && E ? Object.assign(E.toTool(pk.res, pk.cmp), { age_s: Math.round((Date.now() - pk.at) / 1000) }) : null; },
      hasPicked: function () { return !!(state.picked && state.picked.res && state.picked.res.ok); },
      pickedTitle: function () { return state.picked && state.picked.res ? state.picked.res.title : ''; },
      pickElement: function () { startPick(); return { ok: true }; },
      memory: memoryCtx(),
      // r43: проверка качества облака, ожидание завершения шагов плана, ход плана, обновления баз
      auditCloud: function () {
        var AU = W && W.BimCloudAudit, c = getCloudArr(); if (!AU || !c) return Promise.resolve(null);
        return new Promise(function (res) { setTimeout(function () { try { var r = AU.audit(c.pos, c.count != null ? c.count : c.pos.length / 3); state.audit = r; res(r); } catch (e) { res({ ok: false, message: String(e && e.message || e) }); } }, 30); });
      },
      waitIdle: waitIdle,
      onPlanStep: planStep,
      updates: updatesCtx()
    };
  }

  // ------------------------------------------------------------------ r43: выполнение планов — ожидание завершения длинных операций
  function appBusy() {
    var X = W && W.__lxToolsExt;
    if (X && X.isBusy && X.isBusy()) return 'обработка облака';
    if (!D) return '';
    if (D.querySelector('.ribbon [aria-busy="true"], .k-ribbon [aria-busy="true"], button[aria-busy="true"]')) return 'команда выполняется';
    var dl = Array.prototype.filter.call(D.querySelectorAll('[aria-modal="true"]'), function (x) { return x.offsetParent !== null || x.getClientRects().length; });
    if (dl.length) return 'открыто окно с параметрами — заполните его';
    if (D.querySelector('.k-progress:not([hidden]), .lx-progress:not([hidden]), .busy-overlay:not([hidden])')) return 'идёт обработка';
    return '';
  }
  var planMark = null;
  function planStep(ev) {
    if (!ev) return;
    if (ev.phase === 'start') {
      var U = W && W.CloudInspectUI; planMark = { step: ev.step, insp: U && U.current ? U.current() : null };
      note('Шаг ' + (ev.index + 1) + ' из ' + ev.total + ': ' + ev.text + '…');
    } else if (ev.phase === 'done' && ev.ok === false) note('Шаг ' + (ev.index + 1) + ' не выполнен: ' + ((ev.result && ev.result.message) || 'ошибка'));
  }
  function waitIdle(o) {
    o = o || {};
    var t0 = Date.now(), limit = o.timeoutMs || 30 * 60e3, calm = 0, st = o.step || (planMark && planMark.step) || {}, U = W && W.CloudInspectUI;
    var needInsp = st.tool === 'run_command' && st.args && st.args.id === 'cpInspect', before = planMark ? planMark.insp : null, shown = '';
    return new Promise(function (resolve) {
      (function tick() {
        if (state.ac && state.ac.signal && state.ac.signal.aborted) return resolve({ ok: false, message: 'План остановлен.' });
        if (Date.now() - t0 > limit) return resolve({ ok: false, message: 'шаг не завершился за ' + Math.round(limit / 60000) + ' мин' });
        var b = appBusy();
        if (needInsp) { var c = U && U.current ? U.current() : null; if (c && c !== before && !(W.__lxToolsExt && W.__lxToolsExt.isBusy && W.__lxToolsExt.isBusy())) return resolve({ ok: true }); b = b || 'идёт контроль геометрии'; }
        if (b) { calm = 0; if (b !== shown && Date.now() - t0 > 3000) { shown = b; note('Жду: ' + b + '…'); } }
        else calm += 500;
        if (!needInsp && calm >= 1500 && Date.now() - t0 >= 1200) return resolve({ ok: true });
        setTimeout(tick, 500);
      })();
    });
  }
  // ------------------------------------------------------------------ r43: обновления баз (лента в интернете, раз в сутки)
  function updatesCtx() {
    var api = A(); if (!api || !api.aiUpdCheck) return null;
    return {
      check: function () { return api.aiUpdCheck().then(function (r) { state.upd = Object.assign(state.upd || {}, { lastCheck: r.lastCheck, available: r.available, outdated: r.outdated }); return r; }); },
      install: function (ids) { return api.aiUpdInstall(ids).then(function (r) { afterInstall(r); return r; }); }
    };
  }
  function afterInstall(r) {
    var M = MM(); if (r && r.memory && M) { state.mem = M.normalize(r.memory); }
    if (r && r.state) state.upd = r.state;
    kbLoad();
    if (P && P.memv && !P.memv.hidden) { renderMem(); renderUpd(); }
  }
  function kbLoad() {
    var api = A(), KB = W && W.BimAssistantKB; if (!api || !api.aiKbLoad || !KB || !KB.addArticles) return;
    api.aiKbLoad().then(function (r) { if (r && r.articles) KB.addArticles(r.articles); }).catch(function () {});
  }
  var updHooked = false;
  function hookUpdates() {
    var api = A(); if (updHooked || !api) return; updHooked = true;
    if (api.onAiKbExtra) api.onAiKbExtra(function (p) { var KB = W && W.BimAssistantKB; if (p && p.articles && KB && KB.addArticles) KB.addArticles(p.articles); });
    if (api.onAiUpdate) api.onAiUpdate(function (p) {
      if (p && p.state) state.upd = p.state;
      var n = p && p.installed ? p.installed.length : 0;
      if (n) toast('Базы ассистента обновлены: ' + p.installed.map(function (x) { return x.title; }).join(', '));
      else if (p && p.state && p.state.available && p.state.available.length) toast('Есть обновления баз ассистента — «Опыт и знания» → «Обновления баз»');
      if (P && P.memv && !P.memv.hidden) { memLoad().then(function () { renderMem(); renderUpd(); }); }
    });
    kbLoad();
  }

  // ------------------------------------------------------------------ r42: память ассистента (опыт, правила, параметры)
  var memSaveT = null;
  function mem() { var M = MM(); if (!state.mem && M) { state.mem = M.empty(); try { var j = JSON.parse(store(KEY_MEM) || 'null'); if (j) state.mem = M.normalize(j); } catch (_) {} } return state.mem; }
  async function memLoad() {
    var api = A(), M = MM(); if (!M) return;
    if (api && api.aiMemLoad) { try { var r = await api.aiMemLoad(); if (r && r.ok && r.memory) { state.mem = M.normalize(r.memory); state.trained = r.trained || null; } } catch (_) {} }
    else mem();
  }
  function memSave() {
    if (memSaveT) clearTimeout(memSaveT);
    memSaveT = setTimeout(function () {
      memSaveT = null; var api = A(), m = state.mem; if (!m) return;
      if (api && api.aiMemSave) api.aiMemSave(m).then(function (r) { if (r && r.ok === false) toast('Память ассистента не сохранена: ' + (r.error || ''), true); }, function () {});
      else { try { store(KEY_MEM, JSON.stringify(m)); } catch (_) {} }
      if (state.view === 'mem') renderMem();
    }, 400);
  }
  function memoryCtx() {
    var M = MM(); if (!M) return null;
    return {
      recall: function (q, n) { var m = mem(); return m ? M.recall(m, q, n) : []; },
      block: function (q) { var m = mem(); return m ? M.promptBlock(M.recall(m, q, 5)) : ''; },
      add: function (it) {
        var m = mem(); if (!m) return { ok: false, error: 'Память недоступна' };
        var x = it && it.remember && !it.kind ? (M.fromRemember(it.text) || it) : it;
        var r = M.add(m, { kind: x.kind || 'fact', text: x.text, source: 'просьба «запомни»' }); memSave(); return r;
      },
      parse: function (q) { return M.fromRemember(q); },
      skills: function () { var m = mem(); return m ? M.skills(m) : []; },
      findSkill: function (q) { var m = mem(); return m ? M.findSkill(m, q) : null; },
      addSkill: function (o) { var m = mem(); if (!m) return { ok: false, error: 'Память недоступна' }; var r = M.addSkill(m, o); memSave(); return r; },
      useSkill: function (n) { var m = mem(); var r = m ? M.useSkill(m, n) : false; memSave(); return r; },
      best: function (k, d) { return M.bestParam(mem(), k, d); },
      learn: function (k, v, g) { var r = M.learnParam(mem(), k, v, g); memSave(); return r; },
      info: function () { var m = mem(); if (!m || !m.items.length) return ''; var sm = M.summary(m); return sm.total + ' записей (правил и знаний ' + ((sm.byKind.rule || 0) + (sm.byKind.fact || 0)) + ', об объекте ' + (sm.byKind.note || 0) + ', примеров ' + sm.examples + ')'; }
    };
  }
  // оценка ответа: «верно» — пример для подражания; «исправить» — правильный ответ пользователя
  function feedbackBar(bot, q, text, tools) {
    var M = MM(); if (!M || !text) return;
    var bar = D.createElement('div'); bar.className = 'ai-fb';
    bar.innerHTML = '<button type="button" class="ai-ib" data-v="1" title="Ответ верный — запомнить как пример">' + ic('circle-check', 14) + '</button>' +
      '<button type="button" class="ai-ib" data-v="0" title="Ответ неверный — исправить, ассистент учтёт">' + ic('square-pen', 14) + '</button>';
    bar.querySelector('[data-v="1"]').onclick = function () {
      M.feedback(mem(), { question: q, answer: text, good: true, tools: (tools || []).map(function (t) { return t.name; }) }); memSave();
      bar.innerHTML = '<span class="ai-fb-t">' + ic('check', 12) + 'Запомнено как удачный ответ</span>';
    };
    bar.querySelector('[data-v="0"]').onclick = async function () {
      var k = K(), v = k && k.form ? await k.form({ title: 'Исправить ответ', okLabel: 'Запомнить', message: 'Напишите, как правильно. Ассистент будет учитывать это в похожих вопросах; цифры объекта он всё равно берёт из расчёта программы.',
        fields: [{ key: 'cor', label: 'Правильный ответ или правило', multiline: true, rows: 5, value: '' }] }) : null;
      if (!v) return;
      M.feedback(mem(), { question: q, answer: text, good: false, correction: v.cor }); memSave();
      bar.innerHTML = '<span class="ai-fb-t">' + ic('check', 12) + (v.cor && String(v.cor).trim() ? 'Исправление запомнено' : 'Учтено') + '</span>';
    };
    bot.appendChild(bar);
  }

  // ------------------------------------------------------------------ r42: «Что это?» — щелчок по облаку
  function viewer() { return W && W.__viewer; }
  function getCloudArr() {
    var t = W && W.__pcTools, c = null; try { c = t && t.getCloud ? t.getCloud() : null; } catch (_) {}
    if (!c) { var v = viewer(); try { c = v && v.getEditedCloud ? v.getEditedCloud() : null; } catch (_) {} }
    return c && c.pos ? c : null;
  }
  function stopPick() { state.picking = false; if (W) { if (W.__bimPick) W.__bimPick.active = false; } if (D && D.body) D.body.classList.remove('ai-picking'); if (P && P.pickBtn) P.pickBtn.classList.remove('on'); D.removeEventListener('keydown', pickKey, true); }
  function pickKey(e) { if (e.key === 'Escape' && state.picking) { e.preventDefault(); e.stopPropagation(); stopPick(); toast('Выбор элемента отменён'); } }
  function startPick() {
    if (!W || !D) return;
    if (state.picking) { stopPick(); return; }
    if (!getCloudArr()) { toast('Откройте облако точек — «Что это?» измеряет элемент по точкам облака', true); return; }
    var dr = W.__lxDraw; if (dr && dr.active) { toast('Сначала завершите черчение', true); return; }
    state.picking = true;
    W.__bimPick = { active: true, onPick: function (pt) { if (!pt) { toast('Мимо облака — щёлкните по точкам'); return; } stopPick(); onPicked(pt); } };
    D.body.classList.add('ai-picking'); if (P && P.pickBtn) P.pickBtn.classList.add('on');
    D.addEventListener('keydown', pickKey, true);
    toast('Щёлкните по стене, полу, потолку, трубе или предмету в 3D-виде · Esc — отмена');
  }
  async function onPicked(pt) {
    var E = EI(); if (!E || !P) return;
    var c = getCloudArr(); if (!c) { toast('Облако недоступно', true); return; }
    if (!isOpen()) open();
    if (state.view !== 'chat') showView('chat');
    var empty = P.list.querySelector('.ai-empty'); if (empty) empty.remove();
    var card = addMsg('bot', '<div class="ai-tools">' + toolChip({ name: 'get_picked' }) + '</div><div class="ai-text"><p class="ai-note">Измеряю элемент…</p></div>', 'ai-pick');
    await new Promise(function (r) { setTimeout(r, 30); });
    var res, cr;
    try {
      cr = E.crop(c.pos, c.count != null ? c.count : c.pos.length / 3, pt, {});
      res = E.identify(cr.pos, pt, { finish: state.finish || 'improved', box: cr.box });
    } catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
    var body = card.querySelector('.ai-text');
    if (!res || !res.ok) { body.innerHTML = md('Не удалось определить элемент: ' + ((res && res.error) || 'нет данных') + '. Попробуйте щёлкнуть ближе к середине поверхности.'); state.picked = null; return; }
    state.picked = { res: res, cmp: null, at: Date.now() };
    body.innerHTML = md(E.describe(res));
    highlight(res, cr);
    // поиск в документах пользователя и встроенной базе — именно по этому элементу
    var ctx = makeCtx(), hits = [], src = [];
    if (ctx.searchNorms && res.queries && res.queries.length) {
      card.querySelector('.ai-tools').insertAdjacentHTML('beforeend', toolChip({ name: 'search_norms' }));
      for (var i = 0; i < Math.min(3, res.queries.length); i++) {
        try { var r = await ctx.searchNorms(res.queries[i], { n: 4 }); (r && r.results || []).forEach(function (x) { if (!hits.some(function (y) { return y.cite === x.cite && y.text === x.text; })) { hits.push(x); src.push(x); } }); } catch (_) {}
      }
      var cmp = E.docCompare(res, hits);
      if (state.picked && state.picked.res === res) state.picked.cmp = cmp;
      body.innerHTML = md(E.describe(res, cmp) + (hits.some(function (x) { return x.source === 'документ'; }) ? '' : '\n\n_В ваших документах требований к этому элементу не найдено — добавьте проект, ТЗ или СП в «База норм»._'));
      if (src.length) renderSources(card, '', src);
    }
    var acts = D.createElement('div'); acts.className = 'ai-sugg ai-pick-acts';
    ['Что это и соответствует ли нормам и проекту?', 'Что проверить на месте?', 'Сколько материала на выравнивание?'].forEach(function (t) {
      var b = D.createElement('button'); b.type = 'button'; b.className = 'ai-chip'; b.textContent = t; b.onclick = function () { ask(t); }; acts.appendChild(b);
    });
    var again = D.createElement('button'); again.type = 'button'; again.className = 'ai-chip'; again.textContent = 'Выбрать другой элемент'; again.onclick = startPick; acts.appendChild(again);
    card.appendChild(acts);
    state.history.push({ role: 'assistant', content: 'Выбран элемент: ' + res.title + '. ' + res.dims.slice(0, 4).map(function (d) { return d.label + ' — ' + d.text; }).join('; ') });
    P.list.scrollTop = P.list.scrollHeight;
  }
  // подсветить найденный элемент на 4 с (точки области)
  function highlight(res, cr) {
    var v = viewer(); if (!v || !v.previewPoints || !res.highlight) return;
    try { v.previewPoints(res.highlight, { color: '#2f8cff', size: 9 }); } catch (_) { return; }
    var mine = v._prevObj;   // снимаем только свою подсветку (не предпросмотр чистки, если он успел начаться)
    setTimeout(function () { if (v._prevObj === mine && v.clearPreview) { try { v.clearPreview(); } catch (_) {} } }, 4000);
  }

  // вызов модели через главный процесс с потоком частей ответа
  var seq = 0;
  function chatViaIpc(o) {
    var api = A(); if (!api || !api.aiChat) return Promise.reject(new Error('Ассистент доступен в настольной версии'));
    var jobId = 'ai-' + Date.now().toString(36) + '-' + (++seq), off = api.onAiDelta ? api.onAiDelta(jobId, function (d) { if (o.onDelta) o.onDelta(d); }) : function () {};
    var onAbort = function () { if (api.aiCancel) api.aiCancel(jobId); };
    if (o.signal) { if (o.signal.aborted) onAbort(); else o.signal.addEventListener('abort', onAbort, { once: true }); }
    return api.aiChat({ jobId: jobId, messages: o.messages, tools: o.tools, think: o.think }).then(function (r) {
      off(); if (o.signal) o.signal.removeEventListener('abort', onAbort);
      if (!r || !r.ok) { var e = new Error(r && r.cancelled ? 'cancelled' : (r && r.error) || 'нет ответа'); e.cancelled = !!(r && r.cancelled); throw e; }
      return r;
    }, function (e) { off(); throw e; });
  }

  // ------------------------------------------------------------------ панель
  var P = null;   // { el, list, input, send, status, bar, ... }
  var state = { st: null, history: [], busy: false, ac: null, offProgress: null, norms: null, offNorms: null, view: 'chat', attach: false, mem: null, trained: null, picked: null, picking: false };

  function suggestions() {
    var c = makeCtx(), has = !!c.inspection();
    if (!has && c.cloud()) return ['Проверь качество облака', 'Сделай приёмку помещения', 'Почисти облако до мелочей', 'Что это? (щёлкните по элементу облака)', 'Как проверить ровность пола и стен?', 'Какой допуск вертикали монолитной стены по СП 70?', 'Запомни: отделка у нас улучшенная'];
    return has ? ['Сколько стен вне допуска и какие хуже всех?', 'Укладываются ли стены в допуск по СП 70?', 'Какие FF и FL у пола?', 'Где трубы и балки ниже 2,1 м?', 'Какие дефекты самые глубокие?', 'Сделай PDF-отчёт']
      : ['Как проверить ровность пола и стен?', 'Какой допуск вертикали монолитной стены по СП 70?', 'Какая толщина защитного слоя бетона?', 'Что значат FF и FL?', 'Где команда сравнения с DXF?', 'Посчитай 12,5 на 3,2'];
  }
  function ready() { return !!(state.st && state.st.ready); }

  function renderStatus() {
    if (!P) return;
    var st = state.st || {}, txt, cls = '', pct = null, btn = '';
    if (st.ready) { var m = (st.models || []).filter(function (x) { return x.id === st.base; })[0]; txt = 'Модель: ' + (m ? m.label : (st.base || 'bim-twin-assistant')) + (st.server && st.server.system ? ' · системный Ollama' : ''); cls = 'ok'; }
    else if (st.phase === 'error') { txt = 'Установка не удалась: ' + (st.error || st.message || ''); cls = 'err'; btn = 'Повторить'; }
    else if (st.busy || (st.phase && st.phase !== 'none')) { txt = 'Устанавливается: ' + (st.message || PHASE_TEXT[st.phase] || st.phase); pct = st.pct || 0; cls = 'busy'; }
    else { txt = 'Модель не установлена — работает простой режим'; btn = 'Установить'; }
    P.status.className = 'ai-status ' + cls;
    P.status.innerHTML = '<span class="ai-dot"></span><span class="ai-st-t">' + esc(txt) + (pct != null ? ' — ' + Math.round(pct) + ' %' : '') + '</span>' +
      (btn ? '<button type="button" class="btn sm" data-act="setup">' + esc(btn) + '</button>' : '');
    P.bar.hidden = pct == null; P.bar.firstChild.style.width = Math.max(2, Math.min(100, pct || 0)) + '%';
    var b = P.status.querySelector('[data-act="setup"]'); if (b) b.onclick = function () { setup(); };
    if (st.ready && st.embedPhase === 'pull') P.status.querySelector('.ai-st-t').textContent += ' · модель поиска по нормам ' + Math.round(st.embedPct || 0) + ' %';
    P.mode.textContent = st.ready ? '' : 'простой режим';
    if (P.cam) { var v = !!(st.ready && st.vision); P.cam.hidden = !v; if (!v) setAttach(false); }
  }
  async function refresh() {
    var api = A(); if (!api || !api.aiStatus) { state.st = { phase: 'none' }; renderStatus(); return; }
    try { state.st = await api.aiStatus(); } catch (_) {}
    renderStatus();
    if (api.normsStatus) { try { state.norms = await api.normsStatus(); } catch (_) {} renderNorms(); }
  }
  async function setup(model) {
    var api = A(); if (!api || !api.aiSetup) { toast('Установка модели доступна в настольной версии', true); return; }
    var r = await api.aiSetup(model); if (r && r.ok === false) toast('Не удалось начать установку: ' + (r.error || ''), true);
    state.st = Object.assign({}, state.st || {}, { busy: true, phase: 'check', message: 'проверка компьютера', pct: 0 }); renderStatus();
  }

  function note(text) {
    if (!P) { toast(text); return; }
    addMsg('note', '<span class="ai-step">' + esc(text) + '</span>', 'ai-plan-note');
  }
  function addMsg(role, html, extra) {
    var m = D.createElement('div'); m.className = 'ai-msg ai-' + role + (extra ? ' ' + extra : '');
    m.innerHTML = html; P.list.appendChild(m); P.list.scrollTop = P.list.scrollHeight; return m;
  }
  function renderEmpty() {
    if (!P || P.list.children.length) return;
    var box = D.createElement('div'); box.className = 'ai-empty';
    box.innerHTML = '<p>Спросите про результаты контроля, нормы и команды. Модель работает на этом компьютере, без интернета; цифры берутся только из расчёта программы.</p>' +
      '<div class="ai-sugg">' + suggestions().map(function (s) { return '<button type="button" class="ai-chip">' + esc(s) + '</button>'; }).join('') + '</div>';
    box.querySelectorAll('.ai-chip').forEach(function (b) { b.onclick = function () { if (/^Что это\?/.test(b.textContent)) startPick(); else ask(b.textContent); }; });
    P.list.appendChild(box);
  }
  function toolChip(ev) {
    var t = TOOL_TEXT[ev.name] || ev.name;
    return '<span class="ai-tool' + (ev.action ? ' act' : '') + '">' + ic(ev.action ? 'sparkles' : 'search', 12) + esc(t) + '</span>';
  }

  async function ask(text) {
    var q = String(text || '').trim(); if (!q || state.busy || !P) return;
    var empty = P.list.querySelector('.ai-empty'); if (empty) empty.remove();
    addMsg('user', esc(q).replace(/\n/g, '<br>'));
    var BA = B(); if (!BA) { addMsg('bot', '<p>Модуль ассистента не загружен.</p>', 'err'); return; }
    var ctx = makeCtx();
    if (!ready()) {
      var pa = BA.planAction ? BA.planAction(q, ctx) : null;
      if (pa) {
        var r0 = await BA.execTool(pa.name, pa.args, ctx);
        var t0txt = r0 && r0.ok !== false ? (r0.message || 'Готово') + '.' : r0 && r0.cancelled ? 'Действие отменено.' : 'Не получилось: ' + ((r0 && r0.message) || 'нет данных');
        addMsg('bot', '<div class="ai-tools">' + toolChip({ name: pa.name, action: true }) + '</div>' + md(t0txt), 'offline');
        return;
      }
      var offN = null; try { offN = BA.offlineNorms ? await BA.offlineNorms(q, ctx) : null; } catch (_) {}
      var off = offN || BA.offlineAnswer(q, ctx);
      var res = off && off.text ? off : { text: 'Пока модель не установлена, я отвечаю только на простые вопросы: итоги контроля, стены, пол, дефекты, проёмы, трубы, где команда, расчёт. Полный режим включится сам после установки.', tools: [] };
      var ob = addMsg('bot', (res.tools && res.tools.length ? '<div class="ai-tools">' + res.tools.map(function (n) { return toolChip({ name: n }); }).join('') + '</div>' : '') + md(res.text), 'offline');
      if (res.text && !/^В простом режиме/.test(res.text)) feedbackBar(ob, q, res.text, (res.tools || []).map(function (n) { return { name: n }; }));
      if (res.src) renderSources(ob, '', res.src);
      state.history.push({ role: 'user', content: q }, { role: 'assistant', content: res.text });
      return;
    }
    state.busy = true; setBusy(true);
    var bot = addMsg('bot', '<div class="ai-tools"></div><details class="ai-think" hidden><summary>Рассуждение</summary><div></div></details><div class="ai-text"><span class="ai-typing"><i></i><i></i><i></i></span></div>');
    var tools = bot.querySelector('.ai-tools'), think = bot.querySelector('.ai-think'), body = bot.querySelector('.ai-text'), live = '', thinking = '', step = -1;
    var ac = state.ac = new AbortController(), t0 = Date.now();
    var thinkPref = store(KEY_THINK), sources = [], images;
    if (state.attach && ctx.vision()) {
      try { var cap = await ctx.captureView(); if (cap && cap.ok && cap.image) { images = [cap.image]; tools.insertAdjacentHTML('beforeend', toolChip({ name: 'look_at_view' })); } } catch (_) {}
      setAttach(false);
    }
    try {
      var out = await BA.runAgent({
        question: q, images: images, history: state.history, ctx: ctx, chat: chatViaIpc, signal: ac.signal, think: thinkPref == null ? undefined : thinkPref === '1',
        onEvent: function (ev) {
          if (ev.type === 'tool_result' && ev.name === 'search_norms' && ev.result && ev.result._src) ev.result._src.forEach(function (x) { if (!sources.some(function (y) { return y.cite === x.cite; })) sources.push(x); });
          if (ev.type === 'tool') { tools.insertAdjacentHTML('beforeend', toolChip(ev)); }
          else if (ev.type === 'memory') { tools.insertAdjacentHTML('beforeend', toolChip({ name: 'recall_memory' })); }
          else if (ev.type === 'delta') {
            if (ev.step !== step) { step = ev.step; live = ''; }
            if (ev.thinking) { thinking += ev.thinking; think.hidden = false; think.lastChild.textContent = thinking; }
            if (ev.content) { live += ev.content; if (!/^\s*(<tool_call>|\{|```)/.test(live)) body.innerHTML = md(BA.stripThink(live)); }
          }
          P.list.scrollTop = P.list.scrollHeight;
        }
      });
      if (out.cancelled) body.innerHTML = '<p class="ai-note">Остановлено.</p>';
      else {
        body.innerHTML = md(out.text || 'Нет ответа.');
        renderSources(bot, out.text || '', sources);
        feedbackBar(bot, q, out.text || '', out.tools);
        var sec = (Date.now() - t0) / 1000;
        bot.insertAdjacentHTML('beforeend', '<div class="ai-meta">' + sec.toFixed(sec < 10 ? 1 : 0).replace('.', ',') + ' с' + (out.stats && out.stats.evalCount && out.stats.evalMs ? ' · ' + Math.round(out.stats.evalCount / out.stats.evalMs * 1000) + ' ток/с' : '') + '</div>');
        state.history.push({ role: 'user', content: q }, { role: 'assistant', content: out.text || '' });
      }
    } catch (e) {
      if (e && (e.cancelled || e.message === 'cancelled')) body.innerHTML = '<p class="ai-note">Остановлено.</p>';
      else {
        var off2 = BA.offlineAnswer(q, ctx);
        body.innerHTML = '<p class="ai-note">Модель не ответила (' + esc((e && e.message) || e) + ').' + (off2 && off2.text ? ' Ответ простого режима:' : '') + '</p>' + (off2 && off2.text ? md(off2.text) : '');
        refresh();
      }
    } finally {
      state.busy = false; state.ac = null; setBusy(false);
      if (state.history.length > 40) state.history = state.history.slice(-40);
      try { store(KEY_HIST, JSON.stringify(state.history.slice(-20))); } catch (_) {}
      P.list.scrollTop = P.list.scrollHeight;
    }
  }
  // источники под ответом: цитаты базы норм, которые модель использовала (или все найденные, если в тексте их нет)
  function renderSources(bot, text, sources) {
    if (!sources || !sources.length) return;
    var low = String(text || '').toLowerCase();
    var used = sources.filter(function (x) { var c = String(x.doc || '').toLowerCase(); return c && low.indexOf(c.split(/[ ,]/).slice(0, 2).join(' ')) >= 0; });
    var list = (used.length ? used : sources).slice(0, 5);
    var box = D.createElement('div'); box.className = 'ai-src';
    box.innerHTML = '<div class="ai-src-h">' + ic('notebook-text', 12) + 'Источники</div>' + list.map(function (x, i) {
      return '<button type="button" class="ai-src-i' + (x.source === 'документ' ? ' doc' : '') + '" data-i="' + i + '" title="' + esc(String(x.text || '').slice(0, 400)) + '">' + esc(x.cite) +
        (x.source === 'встроенная база' ? ' <span class="ai-src-k">кратко</span>' : '') + '</button>';
    }).join('');
    box.querySelectorAll('.ai-src-i').forEach(function (b) {
      b.onclick = function () {
        var x = list[+b.getAttribute('data-i')];
        if (x && x.source === 'документ' && x.id) { var api = A(); if (api && api.normsOpen) api.normsOpen(x.id).then(function (r) { if (r && r.ok === false) toast(r.error || 'Не удалось открыть', true); else if (x.page) toast('Открыт документ: смотрите страницу ' + x.page); }); }
        else toast(x ? x.cite + ' — краткое изложение встроенной базы; сверяйте с полным текстом документа' : '');
      };
    });
    bot.appendChild(box);
  }
  function setAttach(on) {
    state.attach = !!on;
    if (P && P.cam) { P.cam.classList.toggle('on', state.attach); P.cam.title = state.attach ? 'Снимок вида будет приложен к вопросу (нажмите, чтобы отменить)' : 'Приложить снимок текущего вида к вопросу'; }
  }

  // ------------------------------------------------------------------ база норм
  function fmtSize(b) { return b >= 1048576 ? (Math.round(b / 104857.6) / 10).toString().replace('.', ',') + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ'; }
  async function normsRefresh() {
    var api = A(); if (!api || !api.normsStatus) { state.norms = null; renderNorms(); return; }
    try { state.norms = await api.normsStatus(); } catch (_) {}
    renderNorms();
  }
  function normsLine(n) {
    var e = (n && n.embed) || {}, st = state.st || {};
    if (e.running) return 'Поиск по смыслу: подготовка ' + e.done + ' из ' + e.total + ' фрагментов…';
    if (e.error) return 'Поиск по смыслу недоступен (' + e.error + ') — работает поиск по словам';
    if (e.model && e.total && e.done >= e.total) return 'Поиск по словам и по смыслу (' + e.model + ')';
    if (st.embedPhase === 'pull') return 'Скачивается модель поиска по смыслу — ' + Math.round(st.embedPct || 0) + ' %; поиск по словам уже работает';
    if (!e.model) return 'Поиск по словам; поиск по смыслу включится после установки модели';
    return 'Поиск по словам; по смыслу — ' + e.done + ' из ' + e.total;
  }
  function renderNorms() {
    if (!P || !P.norms) return;
    var n = state.norms, box = P.norms;
    if (!n || n.ok === false) { box.querySelector('.nb-body').innerHTML = '<p class="ai-note">' + esc(n && n.error ? 'База норм недоступна: ' + n.error : 'База норм доступна в настольной версии.') + '</p>'; return; }
    box.querySelector('.nb-info').textContent = 'Встроенная база: ' + n.builtin.entries + ' кратких статей по ' + n.builtin.docs + ' документам. Ваши документы: ' + n.docs.length + (n.queue ? ' · в очереди ' + n.queue : '') + '.';
    box.querySelector('.nb-line').textContent = normsLine(n);
    var body = box.querySelector('.nb-body');
    if (!n.docs.length) {
      body.innerHTML = '<div class="nb-empty"><p>Добавьте PDF, DOCX, TXT, RTF или HTML нормативных документов (СП, ГОСТ, СНиП), проекта или ТЗ — ассистент будет отвечать по ним с указанием пункта и страницы.</p>' +
        '<p>Сканы без текста распознаются, если установлен Tesseract OCR. Файлы остаются на месте, в базу попадает только текст.</p></div>';
      return;
    }
    body.innerHTML = n.docs.map(function (d) {
      var meta = [];
      if (d.status === 'ok') { meta.push(d.pages + ' с.'); meta.push(d.chunks + ' фрагм.'); if (d.embedded && d.embedded >= d.chunks) meta.push('по смыслу'); else if (d.embedded) meta.push('по смыслу ' + Math.round(d.embedded / d.chunks * 100) + ' %'); if (d.ocr) meta.push('распознан'); if (d.truncated) meta.push('частично'); }
      meta.push(fmtSize(d.size || 0));
      if (!d.exists) meta.push('файл не найден');
      return '<div class="nb-doc ' + esc(d.status) + '" data-id="' + esc(d.id) + '"><div class="nb-d-main"><div class="nb-d-name" title="' + esc(d.file) + '">' + esc(d.code || d.name) + '</div>' +
        '<div class="nb-d-sub">' + (d.code ? esc(d.name) + ' · ' : '') + '<span class="nb-st">' + esc(NSTATUS[d.status] || d.status) + '</span>' + (d.error && d.status !== 'ok' ? ' — ' + esc(d.error) : '') + ' · ' + esc(meta.join(' · ')) + '</div></div>' +
        '<button type="button" class="ai-ib" data-act="open" title="Открыть файл"' + (d.exists ? '' : ' disabled') + '>' + ic('external-link', 14) + '</button>' +
        '<button type="button" class="ai-ib" data-act="reindex" title="Обработать заново">' + ic('refresh-cw', 14) + '</button>' +
        '<button type="button" class="ai-ib" data-act="remove" title="Убрать из базы (файл не удаляется)">' + ic('trash-2', 14) + '</button></div>';
    }).join('');
    body.querySelectorAll('.nb-doc').forEach(function (row) {
      var id = row.getAttribute('data-id'), api = A();
      row.querySelector('[data-act="open"]').onclick = function () { api.normsOpen(id).then(function (r) { if (r && r.ok === false) toast(r.error || 'Не удалось открыть', true); }); };
      row.querySelector('[data-act="reindex"]').onclick = function () { api.normsReindex(id).then(normsRefresh); };
      row.querySelector('[data-act="remove"]').onclick = async function () {
        var k = K(), ok = k && k.ask ? await k.ask({ title: 'Убрать из базы норм', message: 'Убрать документ «' + (row.querySelector('.nb-d-name').textContent) + '» из базы? Сам файл на диске останется.', okLabel: 'Убрать', cancelLabel: 'Отмена' }) : true;
        if (ok) api.normsRemove(id).then(normsRefresh);
      };
    });
  }
  async function normsAdd(folder) {
    var api = A(); if (!api || !api.normsAddFiles) { toast('База норм доступна в настольной версии', true); return; }
    var r = await (folder ? api.normsAddFolder() : api.normsAddFiles());
    if (!r || r.cancelled) return;
    var msg = r.added && r.added.length ? 'Добавлено: ' + r.added.length : 'Новых документов нет';
    if (r.skipped && r.skipped.length) msg += '; пропущено ' + r.skipped.length + ' (' + r.skipped.slice(0, 2).map(function (x) { return x.reason; }).join(', ') + ')';
    toast(msg);
    normsRefresh();
  }
  async function normsTry(q) {
    var api = A(), out = P.norms.querySelector('.nb-res');
    q = String(q || '').trim(); if (!q) { out.innerHTML = ''; return; }
    if (!api || !api.normsSearch) return;
    out.innerHTML = '<p class="ai-note">Поиск…</p>';
    var r = await api.normsSearch(q, { n: 5 });
    if (!r || !r.results || !r.results.length) { out.innerHTML = '<p class="ai-note">' + esc((r && (r.note || r.error)) || 'Ничего не найдено') + '</p>'; return; }
    out.innerHTML = r.results.map(function (x) {
      var t = String(x.text || '').replace(/\s+/g, ' ');
      return '<div class="nb-hit"><div class="nb-hit-c">' + esc(x.cite) + (x.source === 'встроенная база' ? ' <span class="ai-src-k">кратко</span>' : '') + '</div><div class="nb-hit-t">' + esc(t.length > 320 ? t.slice(0, 320) + '…' : t) + '</div></div>';
    }).join('') + '<p class="ai-note">Найдено среди ' + r.searched.chunks + ' фрагментов' + (r.searched.vectors ? ', с поиском по смыслу' : '') + '.</p>';
  }
  function showView(v) {
    if (!P) return;
    state.view = v === 'norms' || v === 'mem' ? v : 'chat';
    var nb = state.view === 'norms', mv = state.view === 'mem';
    P.norms.hidden = !nb; P.memv.hidden = !mv; P.list.hidden = nb || mv; P.form.hidden = nb || mv;
    P.bookBtn.classList.toggle('on', nb); P.memBtn.classList.toggle('on', mv);
    if (mv) { memLoad().then(renderMem); try { updState(); } catch (e) {} return; }
    if (nb) {
      normsRefresh();
      var api = A(); if (api && api.onNormsProgress && !state.offNorms) state.offNorms = api.onNormsProgress(function (p) { if (p && p.status) { state.norms = Object.assign({ ok: true }, p.status); renderNorms(); } });
      setTimeout(function () { var i = P.norms.querySelector('.nb-q'); if (i) i.focus(); }, 30);
    } else setTimeout(function () { if (P) P.input.focus(); }, 30);
  }
  function buildNorms() {
    var el = D.createElement('div'); el.className = 'ai-norms'; el.hidden = true;
    el.innerHTML = '<div class="nb-top"><button type="button" class="ai-ib" data-act="back" title="К разговору">' + ic('arrow-left', 15) + '</button><b>База норм</b><span class="ai-sp"></span>' +
      '<button type="button" class="btn sm" data-act="add">' + ic('file-up', 14) + 'Добавить файлы</button><button type="button" class="btn sm" data-act="folder">' + ic('folder-plus', 14) + 'Папку</button></div>' +
      '<div class="nb-info"></div><div class="nb-line"></div>' +
      '<form class="nb-search"><input class="nb-q" type="search" placeholder="Проверить поиск: например «защитный слой бетона»" aria-label="Пробный поиск по базе норм"><button type="submit" class="ai-ib" title="Найти">' + ic('search', 15) + '</button></form>' +
      '<div class="nb-res"></div><div class="nb-body"></div>' +
      '<div class="nb-foot">Встроенная база — краткое изложение норм; для точных формулировок добавьте полный текст документа. Всё хранится на этом компьютере.</div>';
    el.querySelector('[data-act="back"]').onclick = function () { showView('chat'); };
    el.querySelector('[data-act="add"]').onclick = function () { normsAdd(false); };
    el.querySelector('[data-act="folder"]').onclick = function () { normsAdd(true); };
    el.querySelector('.nb-search').onsubmit = function (e) { e.preventDefault(); normsTry(el.querySelector('.nb-q').value); };
    el.querySelector('.nb-q').addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); showView('chat'); } e.stopPropagation(); });
    return el;
  }

  // ------------------------------------------------------------------ r42: «Опыт и знания»
  function buildMem() {
    var el = D.createElement('div'); el.className = 'ai-norms ai-mem'; el.hidden = true;
    el.innerHTML = '<div class="nb-top"><button type="button" class="ai-ib" data-act="back" title="К разговору">' + ic('arrow-left', 15) + '</button><b>Опыт и знания</b><span class="ai-sp"></span>' +
      '<button type="button" class="btn sm" data-act="import" title="Загрузить пакет знаний коллеги (.bimknow.json)">' + ic('file-up', 14) + 'Загрузить</button>' +
      '<button type="button" class="btn sm" data-act="export" title="Выгрузить свой опыт пакетом знаний — передать коллегам">' + ic('file-down', 14) + 'Выгрузить</button></div>' +
      '<div class="nb-info mem-info"></div>' +
      '<div class="mem-train"><button type="button" class="btn sm primary" data-act="train">' + ic('sparkles', 14) + 'Обновить модель опытом</button>' +
      '<button type="button" class="btn sm" data-act="more">' + ic('ellipsis', 14) + 'Ещё</button><span class="mem-tr"></span></div>' +
      '<form class="nb-search mem-add"><select class="mem-kind" aria-label="Тип записи"><option value="rule">Правило</option><option value="fact" selected>Знание</option><option value="note">Об объекте</option></select>' +
      '<input class="nb-q mem-text" type="text" placeholder="Добавить знание: например «плитка на клей — рейка 2 м не более 3 мм по ТЗ»" aria-label="Новая запись памяти">' +
      '<button type="submit" class="ai-ib" title="Добавить">' + ic('plus', 15) + '</button></form>' +
      '<div class="mem-upd"><div class="mem-upd-h"><b>Обновления баз</b><label class="mem-upd-auto"><input type="checkbox" class="upd-auto"> сами раз в сутки</label><span class="ai-sp"></span>' +
      '<button type="button" class="btn sm" data-act="upd-check">' + ic('refresh-cw', 14) + 'Проверить</button><button type="button" class="btn sm primary" data-act="upd-install" hidden>' + ic('download', 14) + 'Установить</button></div>' +
      '<div class="mem-upd-s"></div></div>' +
      '<input class="nb-q mem-filter" type="search" placeholder="Поиск по памяти" aria-label="Поиск по памяти">' +
      '<div class="nb-body mem-list"></div>' +
      '<div class="nb-foot">Как учится ассистент: оценки ответов («верно» / «исправить»), «запомни…» в чате и записи здесь подаются модели как справочные данные к похожим вопросам; ' +
      '«Обновить модель опытом» пересоздаёт локальную модель со знаниями и примерами (секунды, без скачивания). Цифры объекта модель всё равно берёт только из расчёта программы. Всё хранится на этом компьютере.</div>';
    el.querySelector('[data-act="back"]').onclick = function () { showView('chat'); };
    el.querySelector('[data-act="export"]').onclick = function () { memExport('pack'); };
    el.querySelector('[data-act="import"]').onclick = memImport;
    el.querySelector('[data-act="train"]').onclick = function () { memTrain(false); };
    el.querySelector('[data-act="more"]').onclick = function (e) {
      var k = K(); if (!k || !k.menu) return;
      k.menu(e.currentTarget, [
        { label: 'Набор примеров для дообучения (JSONL)', ico: 'file-json', sub: 'Для LoRA/SFT на отдельном компьютере: вопрос → одобренный ответ', onClick: function () { memExport('dataset'); } },
        { label: 'Modelfile для Ollama', ico: 'file-text', sub: 'Та же модель со знаниями — коллега соберёт её командой ollama create', onClick: function () { memExport('modelfile'); } },
        { sep: true },
        { label: 'Вернуть модель без опыта', ico: 'rotate-ccw', onClick: function () { memTrain(true); } },
        { label: 'Очистить память…', ico: 'trash-2', onClick: memClear }
      ], { title: 'Опыт и знания', minWidth: 300 });
    };
    el.querySelector('.mem-add').onsubmit = function (e) {
      e.preventDefault(); var M = MM(), t = el.querySelector('.mem-text'); if (!M || !t.value.trim()) return;
      var r = M.add(mem(), { kind: el.querySelector('.mem-kind').value, text: t.value, source: 'добавлено вручную' });
      if (r && r.ok) { t.value = ''; memSave(); renderMem(); toast(r.duplicate ? 'Такая запись уже есть' : 'Добавлено в память ассистента'); }
    };
    el.querySelector('.mem-filter').addEventListener('input', function () { renderMem(); });
    el.querySelector('[data-act="upd-check"]').onclick = updCheck;
    el.querySelector('[data-act="upd-install"]').onclick = function () { updInstall(null); };
    el.querySelector('.upd-auto').onchange = function (e) { var api = A(); if (api && api.aiUpdSettings) api.aiUpdSettings({ auto: !!e.target.checked }).then(function (st) { state.upd = Object.assign(state.upd || {}, st); renderUpd(); }); };
    el.querySelectorAll('input').forEach(function (i) { i.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); showView('chat'); } e.stopPropagation(); }); });
    return el;
  }
  function renderMem() {
    if (!P || !P.memv) return;
    var M = MM(), m = mem(), box = P.memv;
    if (!M || !m) { box.querySelector('.mem-list').innerHTML = '<p class="ai-note">Модуль памяти не загружен.</p>'; return; }
    var sm = M.summary(m), tr = state.trained;
    box.querySelector('.mem-info').textContent = 'Записей: ' + sm.total + ' — правил ' + (sm.byKind.rule || 0) + ', знаний ' + (sm.byKind.fact || 0) + ', об объекте ' + (sm.byKind.note || 0) + ', удачных ответов ' + (sm.byKind.example || 0) + ', исправлений ' + (sm.byKind.correction || 0) +
      '. Оценок: верно ' + sm.good + ', исправить ' + sm.bad + '. Выученных настроек: ' + sm.params + '.';
    box.querySelector('.mem-tr').textContent = tr && tr.at ? 'Модель обновлена ' + new Date(tr.at).toLocaleString('ru-RU') + ' (примеров ' + tr.examples + ', знаний ' + tr.facts + ')' : (ready() ? 'Модель ещё не обновлялась опытом' : 'Обновление — после установки модели');
    var f = String(box.querySelector('.mem-filter').value || '').toLowerCase().trim();
    var L = M.list(m).filter(function (x) { return !f || (x.text + ' ' + x.q + ' ' + x.a).toLowerCase().indexOf(f) >= 0; }).slice(0, 300);
    var body = box.querySelector('.mem-list');
    if (!L.length) { body.innerHTML = '<div class="nb-empty"><p>' + (f ? 'Ничего не найдено.' : 'Память пуста. Скажите в чате «Запомни: …», оценивайте ответы кнопками под ними или добавьте знание строкой выше. Пакет знаний коллеги — кнопка «Загрузить».') + '</p></div>'; return; }
    body.innerHTML = L.map(function (x) {
      var main = x.q && x.a ? '«' + x.q + '» → ' + x.a : x.text;
      return '<div class="nb-doc mem-it k-' + esc(x.kind) + '" data-id="' + esc(x.id) + '"><div class="nb-d-main"><div class="nb-d-name" title="' + esc(main.slice(0, 600)) + '">' + esc(main.length > 220 ? main.slice(0, 220) + '…' : main) + '</div>' +
        '<div class="nb-d-sub">' + esc(KIND_TEXT[x.kind] || x.kind) + ' · ' + esc(x.source || '') + (x.uses ? ' · использовано ' + x.uses : '') + '</div></div>' +
        '<button type="button" class="ai-ib" data-act="del" title="Удалить запись">' + ic('trash-2', 14) + '</button></div>';
    }).join('');
    body.querySelectorAll('.mem-it').forEach(function (row) { row.querySelector('[data-act="del"]').onclick = function () { M.remove(mem(), row.getAttribute('data-id')); memSave(); renderMem(); }; });
  }
  async function memFlush() { var api = A(); if (memSaveT && api && api.aiMemSave) { clearTimeout(memSaveT); memSaveT = null; await api.aiMemSave(state.mem); } }
  async function memExport(kind) {
    var api = A(); if (!api || !api.aiMemExport) { toast('Выгрузка доступна в настольной версии', true); return; }
    await memFlush();
    var o = { kind: kind };
    if (kind === 'pack') {
      var k = K(), v = k && k.form ? await k.form({ title: 'Выгрузить пакет знаний', okLabel: 'Сохранить', message: 'В пакет попадут правила, знания, заметки, удачные ответы и исправления, а также выученные настройки. Облака, документы и результаты контроля не выгружаются.',
        fields: [{ key: 'name', label: 'Название', value: 'Знания BIM Twin' }, { key: 'author', label: 'Автор', value: '' }, { key: 'description', label: 'Описание', value: '' }, { key: 'params', label: 'Включить выученные настройки', type: 'checkbox', value: true }] }) : { name: 'Знания BIM Twin' };
      if (!v) return; o.name = v.name; o.author = v.author; o.description = v.description; o.params = v.params !== false;
    }
    var r = await api.aiMemExport(o);
    if (r && r.ok && !r.cancelled) toast('Сохранено: ' + String(r.file || '').split(/[\\/]/).pop());
    else if (r && r.ok === false) toast('Не удалось сохранить: ' + (r.error || ''), true);
  }
  async function memImport() {
    var api = A(), M = MM(); if (!api || !api.aiMemImport || !M) { toast('Загрузка доступна в настольной версии', true); return; }
    await memFlush();
    var r = await api.aiMemImport(); if (!r || r.cancelled) return;
    if (!r.ok) { toast(r.error || 'Не удалось загрузить пакет', true); return; }
    if (r.memory) state.mem = M.normalize(r.memory);
    renderMem();
    var k = K(), msg = 'Пакет «' + r.name + '»' + (r.author ? ' (' + r.author + ')' : '') + ': добавлено ' + r.added + ', уже было ' + r.duplicates + (r.rejected ? ', отклонено ' + r.rejected : '') + (r.params ? ', настроек ' + r.params : '') + '.' + (r.warnings && r.warnings.length ? '\n' + r.warnings.join('\n') : '');
    if (k && k.ask) await k.ask({ title: 'Пакет знаний загружен', message: msg + '\nЧтобы модель знала это сразу, нажмите «Обновить модель опытом».', okLabel: 'Понятно', cancelLabel: 'Закрыть' }); else toast(msg);
  }
  async function memTrain(reset) {
    var api = A(), M = MM(); if (!api || !api.aiTrain) { toast('Обновление модели доступно в настольной версии', true); return; }
    if (!ready()) { toast('Сначала дождитесь установки модели', true); return; }
    var sm = M ? M.summary(mem()) : null;
    if (!reset && sm && !sm.examples && !((sm.byKind.rule || 0) + (sm.byKind.fact || 0))) { toast('В памяти пока нет правил, знаний и одобренных ответов — нечем обновлять', true); return; }
    await memFlush();
    var b = P.memv.querySelector('[data-act="train"]'); b.disabled = true; P.memv.querySelector('.mem-tr').textContent = reset ? 'Возвращаю модель без опыта…' : 'Обновляю модель…';
    try {
      var r = await api.aiTrain({ reset: !!reset });
      if (r && r.ok) { state.trained = reset ? null : { at: Date.now(), examples: r.examples, facts: r.facts }; toast(reset ? 'Модель возвращена к исходной' : 'Модель обновлена: примеров ' + r.examples + ', знаний ' + r.facts); }
      else toast('Не удалось: ' + ((r && r.error) || ''), true);
    } finally { b.disabled = false; renderMem(); }
  }
  async function memClear() {
    var k = K(), M = MM(); if (!M) return;
    var ok = k && k.ask ? await k.ask({ title: 'Очистить память ассистента', message: 'Удалить все правила, знания, примеры и выученные настройки? Сначала можно выгрузить их пакетом знаний.', okLabel: 'Удалить', cancelLabel: 'Отмена' }) : false;
    if (!ok) return; state.mem = M.empty(); memSave(); renderMem();
  }

  function setBusy(b) {
    if (!P) return;
    P.send.innerHTML = ic(b ? 'square' : 'arrow-up', 15); P.send.title = b ? 'Остановить' : 'Отправить (Enter)'; P.send.classList.toggle('stop', b);
    P.el.classList.toggle('busy', b);
  }

  function settingsMenu(anchor) {
    var k = K(), st = state.st || {}, models = st.models || [];
    if (!k || !k.menu) return;
    var th = store(KEY_THINK), thinkOn = th == null ? !!st.think : th === '1', items = [];
    items.push({ label: (thinkOn ? 'Выключить' : 'Включить') + ' рассуждение (точнее, но медленнее)', ico: 'sparkles', onClick: function () { store(KEY_THINK, thinkOn ? '0' : '1'); toast('Рассуждение ' + (thinkOn ? 'выключено' : 'включено')); } });
    items.push({ label: 'Очистить разговор', ico: 'trash-2', onClick: clear });
    items.push({ sep: true }, { head: 'Модель' });
    models.forEach(function (m) {
      items.push({ label: (m.id === st.base ? 'Сейчас: ' : '') + m.label + ' — ' + fmtGb(m.size), sub: m.note, onClick: async function () {
        if (m.id === st.base) return;
        var k2 = K(), ok = k2 && k2.ask ? await k2.ask({ title: 'Сменить модель', message: 'Скачать и настроить ' + m.label + ' (' + fmtGb(m.size) + ')? Это займёт время; пока идёт загрузка, ассистент работает на текущей модели или в простом режиме.', okLabel: 'Скачать', cancelLabel: 'Отмена' }) : true;
        if (ok) setup(m.id);
      } });
    });
    if (st.hardware) {
      var h = st.hardware; items.push({ sep: true });
      items.push({ label: 'Компьютер: память ' + fmtGb(h.ramGB || 0) + (h.gpus && h.gpus.length ? ', ' + h.gpus[0].name + ' ' + fmtGb(h.vramGB || 0) : h.apple ? ', Apple (общая память)' : ', без видеокарты NVIDIA') + '', sub: st.why || '', disabled: true });
    }
    k.menu(anchor, items, { title: 'Ассистент', minWidth: 320 });
  }
  function clear() { state.history = []; store(KEY_HIST, null); if (P) { P.list.innerHTML = ''; renderEmpty(); } }

  function build() {
    var el = D.createElement('aside'); el.className = 'ai-panel'; el.setAttribute('role', 'complementary'); el.setAttribute('aria-label', 'ИИ-ассистент');
    el.innerHTML = '<div class="ai-head"><span class="ai-title">' + ic('message-circle', 16) + 'ИИ-ассистент</span><span class="ai-mode"></span><span class="ai-sp"></span>' +
      '<button type="button" class="ai-ib" data-act="pick" title="Что это? — щёлкните по стене, полу, трубе или предмету в облаке">' + ic('scan-search', 15) + '</button>' +
      '<button type="button" class="ai-ib" data-act="mem" title="Опыт и знания: память ассистента, пакеты знаний, обновление модели">' + ic('database-backup', 15) + '</button>' +
      '<button type="button" class="ai-ib" data-act="norms" title="База норм: СП, ГОСТ, проекты">' + ic('notebook-text', 15) + '</button>' +
      '<button type="button" class="ai-ib" data-act="menu" title="Модель и настройки">' + ic('settings', 15) + '</button>' +
      '<button type="button" class="ai-ib" data-act="close" title="Закрыть (Esc)">' + ic('x', 15) + '</button></div>' +
      '<div class="ai-status"></div><div class="ai-bar" hidden><i></i></div>' +
      '<div class="ai-list" aria-live="polite"></div>' +
      '<form class="ai-form"><button type="button" class="ai-ib ai-cam" data-act="cam" hidden>' + ic('camera', 15) + '</button><textarea rows="1" placeholder="Вопрос по объекту, нормам или командам…" aria-label="Вопрос ассистенту"></textarea>' +
      '<button type="submit" class="ai-send" title="Отправить (Enter)"></button></form>';
    var q = function (s) { return el.querySelector(s); };
    P = { el: el, list: q('.ai-list'), input: q('textarea'), send: q('.ai-send'), status: q('.ai-status'), bar: q('.ai-bar'), mode: q('.ai-mode'), form: q('.ai-form'), cam: q('[data-act="cam"]'), bookBtn: q('[data-act="norms"]') };
    P.norms = buildNorms(); P.list.parentNode.insertBefore(P.norms, P.form);
    P.memv = buildMem(); P.list.parentNode.insertBefore(P.memv, P.form);
    P.pickBtn = q('[data-act="pick"]'); P.memBtn = q('[data-act="mem"]');
    P.bookBtn.onclick = function () { showView(state.view === 'norms' ? 'chat' : 'norms'); };
    P.memBtn.onclick = function () { showView(state.view === 'mem' ? 'chat' : 'mem'); };
    P.pickBtn.onclick = function () { startPick(); };
    P.cam.onclick = function () { setAttach(!state.attach); };
    setAttach(false);
    q('[data-act="close"]').onclick = close;
    q('[data-act="menu"]').onclick = function (e) { settingsMenu(e.currentTarget); };
    P.form.onsubmit = function (e) { e.preventDefault(); if (state.busy) { if (state.ac) state.ac.abort(); return; } var v = P.input.value; P.input.value = ''; autosize(); ask(v); };
    P.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); P.form.requestSubmit ? P.form.requestSubmit() : P.form.onsubmit(e); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (state.busy && state.ac) state.ac.abort(); else close(); }
      e.stopPropagation();   // горячие клавиши приложения не срабатывают при наборе
    });
    P.input.addEventListener('input', autosize);
    setBusy(false);
    D.body.appendChild(el);
    try { var h = JSON.parse(store(KEY_HIST) || '[]'); if (Array.isArray(h)) state.history = h.filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'; }); } catch (_) {}
    state.history.forEach(function (m) { addMsg(m.role === 'user' ? 'user' : 'bot', m.role === 'user' ? esc(m.content) : md(m.content), 'old'); });
    renderEmpty();
    var api = A(); if (api && api.onAiSetupProgress && !state.offProgress) state.offProgress = api.onAiSetupProgress(function (s) { state.st = s; renderStatus(); });
  }
  function autosize() { if (!P) return; P.input.style.height = 'auto'; P.input.style.height = Math.min(160, P.input.scrollHeight) + 'px'; }

  function renderUpd() {
    if (!P || !P.memv) return;
    var box = P.memv.querySelector('.mem-upd'); if (!box) return;
    var api = A(), u = state.upd || {};
    if (!api || !api.aiUpdState) { box.querySelector('.mem-upd-s').textContent = 'Обновления баз доступны в настольной программе.'; box.querySelector('[data-act="upd-check"]').disabled = true; return; }
    box.querySelector('.upd-auto').checked = u.auto !== false;
    var av = u.available || [], inst = u.installed || [], out = u.outdated || [];
    var t = (u.lastCheck ? 'Проверено ' + new Date(u.lastCheck).toLocaleString('ru-RU') + '. ' : 'Ещё не проверялось. ') +
      (av.length ? 'Доступно: ' + av.map(function (x) { return x.title + ' ' + x.version; }).join('; ') + '. ' : 'Новых выпусков нет. ') +
      (inst.length ? 'Установлено: ' + inst.map(function (x) { return x.title + ' ' + x.version; }).join('; ') + '. ' : '') +
      (u.lastError ? 'Ошибка: ' + u.lastError + '. ' : '') +
      (out.length ? 'Устаревшие документы: ' + out.map(function (x) { return x.code + ' → ' + (x.replacedBy || x.status); }).join('; ') + '.' : '');
    box.querySelector('.mem-upd-s').textContent = t;
    box.querySelector('[data-act="upd-install"]').hidden = !av.length;
  }
  async function updState() { var api = A(); if (!api || !api.aiUpdState) return; try { state.upd = await api.aiUpdState(); } catch (_) {} renderUpd(); }
  async function updCheck() {
    var api = A(); if (!api || !api.aiUpdCheck) return;
    var b = P.memv.querySelector('[data-act="upd-check"]'), k = K(); if (k && k.busy) k.busy(b, true);
    try { var r = await api.aiUpdCheck(); toast(r.message || 'Проверено'); await updState(); } catch (e) { toast('Не удалось проверить: ' + String(e && e.message || e), true); }
    finally { if (k && k.busy) k.busy(b, false); }
  }
  async function updInstall(ids) {
    var api = A(); if (!api || !api.aiUpdInstall) return;
    var b = P.memv.querySelector('[data-act="upd-install"]'), k = K(); if (k && k.busy) k.busy(b, true);
    try { var r = await api.aiUpdInstall(ids); afterInstall(r); toast(r.message || 'Готово', r.ok === false); await updState(); } catch (e) { toast('Не удалось установить: ' + String(e && e.message || e), true); }
    finally { if (k && k.busy) k.busy(b, false); }
  }
  function open(question) {
    if (!D) return null;
    if (!P) build();
    P.el.classList.add('open'); P.el.hidden = false;
    refresh(); memLoad(); hookUpdates();
    setTimeout(function () { if (P) P.input.focus(); }, 30);
    if (question) ask(question);
    return P.el;
  }
  function close() { if (!P) return; if (state.ac) state.ac.abort(); P.el.classList.remove('open'); P.el.hidden = true; }
  function toggle() { if (P && !P.el.hidden) close(); else open(); }
  function isOpen() { return !!(P && !P.el.hidden); }

  // Ctrl+Shift+A — открыть/закрыть (по e.code — при любой раскладке)
  if (D && D.addEventListener) D.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyA') { e.preventDefault(); toggle(); }
  });

  return { open: open, close: close, toggle: toggle, isOpen: isOpen, ask: function (q) { open(); return ask(q); }, clear: clear, refresh: refresh, norms: function () { open(); showView('norms'); },
    memory: function () { open(); showView('mem'); }, pick: function () { open(); startPick(); }, _md: md, _ctx: makeCtx, _onPicked: onPicked, _state: function () { return state; } };
});
