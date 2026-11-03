/*
 * assistant.js — ИИ-ассистент BIM Twin (ревизия 35): инструменты, агентный цикл, простой режим без модели. UMD, без DOM.
 *
 * Модель (локальная Qwen через Ollama) получает описания инструментов TOOLS и сама решает, что вызвать; цифры по объекту она
 * берёт только из инструментов — данные контроля геометрии, справка, реестр команд, калькулятор. Действия (запуск команды,
 * открыть результат, выгрузка) выполняются только после подтверждения пользователем (ctx.confirm).
 *
 * ctx (окно приложения или тест):
 *   inspection() → результат «Контроля геометрии» или null; compare() → сравнение с DXF или null; cloud() → { name, path, points };
 *   project() → имя; commands() → [{ id, label, tab, group, tip, enabled }]; verdict(res) → строки вывода (необязательно);
 *   runCommand(id), showResult({ tab, wall, item }), exportResult(format) → { ok, message }; confirm(text) → Promise<boolean>.
 * runAgent({ question, history, ctx, chat, onEvent, maxSteps, think, signal }) → { text, messages, tools, steps }
 * offlineAnswer(question, ctx) → { text, tools } — ответ по шаблонам, пока модель не установлена.
 * r35: searchNorms(query, { doc, n }) → Promise<{ results:[{ cite, text, source }] }> — база норм (search_norms);
 *   vision() → true, если модель видит картинки; captureView() → Promise<{ ok, image(base64 JPEG) }> (look_at_view);
 *   normsInfo() → строка о базе норм для подсказки. offlineNorms(question, ctx) → ответ по базе норм без модели.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BimAssistant = api;
})(typeof window !== 'undefined' ? window : null, function (W) {
  'use strict';
  function req(name, glob) {
    if (W && W[glob]) return W[glob];
    if (typeof module === 'object' && typeof require === 'function') { try { return require(name); } catch (_) {} }
    return null;
  }
  var KB = req('./assistant-kb.js', 'BimAssistantKB');
  var PROMPT = req('./assistant-prompt.js', 'BimAssistantPrompt');

  // ------------------------------------------------------------------ форматирование
  function r(x, d) { if (x == null || x !== x || !isFinite(x)) return null; var k = Math.pow(10, d == null ? 1 : d); return Math.round(x * k) / k; }
  function ru(x, d) { var v = r(x, d); return v == null ? '—' : v.toLocaleString('ru-RU', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function plural(n, a, b, c) { var m = Math.abs(n) % 100, d = m % 10; return n + ' ' + (m > 10 && m < 20 ? c : d === 1 ? a : d >= 2 && d <= 4 ? b : c); }
  function median(a) { var s = a.filter(function (x) { return x === x && x != null; }).sort(function (p, q) { return p - q; }); return s.length ? s[s.length >> 1] : NaN; }
  var CLS = { high: 'высококачественная', improved: 'улучшенная', simple: 'простая' };
  var DEF_KIND = { bump: 'бугор', dip: 'впадина', bulge: 'выступ', uneven: 'неровность' };
  var MEP_KIND = { beam: 'балка', pipe: 'труба', duct: 'короб', tray: 'лоток', rack: 'трасса' };
  var OPEN_KIND = { door: 'дверь', window: 'окно', closed: 'закрыт' };
  function clampInt(v, a, b, d) { v = Math.round(+v); return v === v ? Math.max(a, Math.min(b, v)) : d; }

  // ------------------------------------------------------------------ описания инструментов (формат Ollama / OpenAI)
  function fn(name, description, props, required) {
    return { type: 'function', function: { name: name, description: description, parameters: { type: 'object', properties: props || {}, required: required || [] } } };
  }
  var TOOLS = [
    fn('get_overview', 'Что сейчас открыто и краткий итог последнего «Контроля геометрии» (пол, стены, дефекты, проёмы, балки и трубы).'),
    fn('get_walls', 'Стены из контроля геометрии: вертикаль (мм/м, завал мм), неровность (рейка 2 м, мм), допуск, статус. Номер стены — как в окне результатов.',
      { filter: { type: 'string', enum: ['bad', 'all', 'good'], description: 'bad — вне допуска (по умолчанию), all — все, good — в допуске' },
        sort: { type: 'string', enum: ['lean', 'rail', 'length', 'number'], description: 'порядок: lean — по завалу, rail — по неровности' },
        number: { type: 'integer', description: 'номер одной стены' }, limit: { type: 'integer', description: 'сколько стен вернуть, по умолчанию 8' } }),
    fn('get_floor', 'Пол: FF/FL, уклон, рейка 2 м (просвет, доля мест больше допуска), площадь, по помещениям.',
      { rooms: { type: 'boolean', description: 'вернуть таблицу помещений' }, sort: { type: 'string', enum: ['ff', 'rail', 'tilt', 'area'] }, limit: { type: 'integer' } }),
    fn('get_defects', 'Местные дефекты: бугры и впадины пола, выступы и вмятины стен — тип, глубина мм, площадь м², место (X, Y), высота.',
      { where: { type: 'string', enum: ['all', 'floor', 'walls'] }, min_depth_mm: { type: 'number' }, limit: { type: 'integer' } }),
    fn('get_openings', 'Проёмы: двери и окна — ширина, высота перемычки, подоконник, без перемычки.',
      { kind: { type: 'string', enum: ['all', 'door', 'window'] }, limit: { type: 'integer' } }),
    fn('get_mep', 'Балки, трубы, короба, лотки под потолком: число по типам, диаметры труб, низ над полом, элементы ниже допустимой высоты в свету.',
      { filter: { type: 'string', enum: ['all', 'low', 'beam', 'pipe', 'duct', 'tray', 'rack'], description: 'low — только ниже допуска высоты в свету' }, limit: { type: 'integer' } }),
    fn('get_dxf_compare', 'Сравнение облака с проектом DXF (если выполнено во вкладке «Проект»): совпадает / смещена / нет в облаке, худшие линии.',
      { limit: { type: 'integer' } }),
    fn('search_help', 'Поиск по встроенной справке BIM Twin: как сделать, что значит показатель, нормы и допуски, установка модели.',
      { query: { type: 'string', description: 'ключевые слова вопроса' } }, ['query']),
    fn('search_norms', 'База норм: найти требования СП, ГОСТ, СНиП, проектов и ТЗ (встроенная база и документы пользователя). Возвращает фрагменты с цитатой cite «документ, пункт, страница» — цитируй её в ответе.',
      { query: { type: 'string', description: 'о чём требование: элемент, параметр, работы (например «отклонение от вертикали монолитные стены»)' },
        doc: { type: 'string', description: 'необязательно: искать только в документе, например «СП 70» или «ГОСТ 26433.2»' } }, ['query']),
    fn('look_at_view', 'Посмотреть на текущий вид в окне программы (снимок экрана 3D/плана). Для вопросов о том, что видно сейчас. Размеры по снимку не определяются.',
      { focus: { type: 'string', description: 'на что обратить внимание' } }),
    fn('find_command', 'Найти команду на ленте приложения: возвращает путь «вкладка → группа → команда», подсказку и id для run_command.',
      { query: { type: 'string' } }, ['query']),
    fn('calculate', 'Калькулятор: + − * / ^ ( ), %, sqrt, abs, min, max, round, pi. Пример: (12,5-3)*2 или sqrt(3^2+4^2).',
      { expression: { type: 'string' } }, ['expression']),
    fn('run_command', 'ДЕЙСТВИЕ: выполнить команду ленты по id из find_command (например cpInspect — «Контроль геометрии»). Только по прямой просьбе пользователя.',
      { id: { type: 'string' } }, ['id']),
    fn('show_result', 'ДЕЙСТВИЕ: открыть окно результатов контроля на вкладке и/или показать стену, дефект, элемент.',
      { tab: { type: 'string', enum: ['floor', 'walls', 'def', 'open', 'mep', 'dxf'] }, wall: { type: 'integer', description: 'номер стены' }, item: { type: 'integer', description: 'номер строки (дефект, проём, элемент) в списке инструмента' } }),
    fn('export_result', 'ДЕЙСТВИЕ: выгрузить результат контроля: csv (Excel), pdf (отчёт), mep_dxf или mep_ifc (балки и трубы).',
      { format: { type: 'string', enum: ['csv', 'pdf', 'mep_dxf', 'mep_ifc'] } }, ['format']),
    // r42
    fn('clean_cloud', 'ДЕЙСТВИЕ: почистить открытое облако точек. thoroughness: quick — шум и мусор; normal — ещё прохожие и «волоски» у стен; deep — до мелочей: ещё дубли, неверные точки, летающие обрывки, далёкие выбросы. Программа сама покажет удаляемое красным и спросит «Применить». Только по прямой просьбе.',
      { thoroughness: { type: 'string', enum: ['quick', 'normal', 'deep', 'auto'], description: 'auto — по проверке качества облака (audit_cloud)' }, flatten_surfaces: { type: 'boolean', description: 'сдвинуть точки стен и пола на ровные плоскости (искажает контроль геометрии) — только если пользователь прямо попросил выровнять' },
        people: { type: 'string', enum: ['off', 'strict', 'normal'], description: 'удалять людей: off — нет' } }),
    fn('get_picked', 'Элемент, по которому пользователь щёлкнул в режиме «Что это?»: тип (стена, пол, потолок, колонна, труба, предмет), размеры, отклонения, проверка по встроенной базе норм и сверка с документами пользователя. Для вопросов «что это», «какой размер у этого», «соответствует ли это».'),
    fn('pick_element', 'Включить режим «Что это?»: пользователь щёлкнет по стене, полу, потолку, трубе или предмету в 3D-виде — программа измерит его и покажет карточку.'),
    fn('remember', 'Запомнить правило, знание или заметку пользователя в памяти ассистента (используется в следующих ответах). Только по просьбе «запомни…».',
      { text: { type: 'string' }, kind: { type: 'string', enum: ['rule', 'fact', 'note'], description: 'rule — как отвечать/работать; fact — знание; note — об этом объекте' } }, ['text']),
    fn('recall_memory', 'Найти в памяти ассистента правила, заметки об объекте и прошлые исправления пользователя по теме.',
      { query: { type: 'string' } }, ['query']),
    // r43
    fn('audit_cloud', 'Проверка качества открытого облака точек как у инженера: плотность (шаг, мм), шум (СКО, мм), одиночные точки, дубли, далёкие выбросы, двоение стен (дрейф), оценка LOA, что почистить и как. Вызывай перед чисткой «на усмотрение» и на вопросы о качестве облака.'),
    fn('run_plan', 'ДЕЙСТВИЕ: выполнить несколько шагов подряд с одним подтверждением (например: почистить облако, запустить контроль геометрии, сохранить PDF). Каждый шаг — {tool, args}, tool — одно из действий (clean_cloud, run_command, show_result, export_result) или чтение данных. Шаги ждут завершения предыдущего.',
      { title: { type: 'string' }, steps: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' } }, required: ['tool'] } } }, ['steps']),
    fn('run_skill', 'ДЕЙСТВИЕ: выполнить навык (сценарий), которому пользователь обучил ассистента или который пришёл в пакете знаний, по имени.',
      { name: { type: 'string' } }, ['name']),
    fn('save_skill', 'Сохранить навык (именованный сценарий из шагов) в памяти — по просьбе «запомни навык …» или «запомни последние действия как …».',
      { name: { type: 'string' }, steps: { type: 'array', items: { type: 'object' } }, from_last: { type: 'boolean', description: 'взять последние выполненные действия' } }, ['name']),
    fn('check_updates', 'Проверить обновления баз ассистента в интернете (нормы, справка, знания, модель): что вышло нового и что уже установлено.'),
    fn('install_updates', 'ДЕЙСТВИЕ: установить найденные обновления баз (нормы, справка, знания). ids — какие; без ids — все доступные.',
      { ids: { type: 'array', items: { type: 'string' } } })
  ];
  var ACTIONS = { run_command: 1, show_result: 1, export_result: 1, clean_cloud: 1, run_plan: 1, run_skill: 1, install_updates: 1 };
  var PLAN_TOOLS = { clean_cloud: 1, run_command: 1, show_result: 1, export_result: 1, audit_cloud: 1, get_overview: 1, get_walls: 1, get_floor: 1, get_defects: 1, get_openings: 1, get_mep: 1, pick_element: 1 };
  function toolNames() { return TOOLS.map(function (t) { return t.function.name; }); }
  // look_at_view — только моделям со зрением; search_norms — только если база норм подключена
  function toolsFor(ctx) {
    return TOOLS.filter(function (t) {
      var n = t.function.name;
      if (n === 'look_at_view') return hasVision(ctx);
      if (n === 'search_norms') return !!(ctx && ctx.searchNorms);
      if (n === 'clean_cloud') return !!(ctx && ctx.cleanCloud);
      if (n === 'get_picked') return !!(ctx && ctx.picked);
      if (n === 'pick_element') return !!(ctx && ctx.pickElement);
      if (n === 'remember' || n === 'recall_memory') return !!(ctx && ctx.memory);
      if (n === 'audit_cloud') return !!(ctx && ctx.auditCloud);
      if (n === 'run_skill' || n === 'save_skill') return !!(ctx && ctx.memory && ctx.memory.skills);
      if (n === 'check_updates' || n === 'install_updates') return !!(ctx && ctx.updates);
      return true;
    });
  }

  // ------------------------------------------------------------------ данные контроля
  function insp(ctx) { try { return ctx && ctx.inspection ? ctx.inspection() : null; } catch (_) { return null; } }
  var NO_INSPECTION = { ok: false, message: 'Контроль геометрии ещё не выполнялся. Откройте облако и запустите «Контроль» → «Контроль геометрии» (id cpInspect).' };

  function wallVerdict(w, tol) {
    if (w.ok) return 'в допуске';
    var p = [];
    if (!w.okPlumb) p.push('вертикаль ' + ru(w.plumb, 2) + ' мм/м' + (tol.plumbPerM ? ' больше допуска ' + ru(tol.plumbPerM, 1) + ' мм/м' : '') + (tol.plumbMax && w.lean > tol.plumbMax ? ', завал ' + ru(w.lean, 1) + ' мм больше ' + ru(tol.plumbMax, 0) + ' мм' : ''));
    if (!w.okRail) p.push('рейка ' + ru(w.rail, 1) + ' мм' + (tol.rail ? ' больше допуска ' + ru(tol.rail, 1) + ' мм' : ''));
    return 'ВНЕ допуска: ' + p.join('; ');
  }
  function wallRow(w, i, tol) {
    return { verdict: wallVerdict(w, tol || {}), number: i + 1, length_m: r(w.length, 2), height_m: r(w.height, 2), plumb_mm_per_m: r(w.plumb, 2), lean_mm: r(w.lean, 1),
      toward: w.toward === 'room' ? 'в помещение' : w.toward === 'out' ? 'от помещения' : '', rail_mm: r(w.rail, 1), noise_mm: r(w.noise, 1),
      ok: !!w.ok, fails: w.ok ? '' : (!w.okPlumb && !w.okRail ? 'вертикаль и неровность' : !w.okPlumb ? 'вертикаль' : 'неровность'), defects: (w.defects || []).length };
  }
  function getWalls(ctx, a) {
    var res = insp(ctx); if (!res) return NO_INSPECTION;
    var wr = res.walls; if (!wr || !wr.ok) return { ok: false, message: 'Стены не проверялись (в форме контроля был снят флажок «Стены»).' };
    a = a || {};
    var tol = wr.tol || {}, all = wr.walls.map(function (w, i) { return wallRow(w, i, tol); });
    if (a.number != null) { var one = all[clampInt(a.number, 1, all.length, 1) - 1]; return { ok: true, tolerance: { plumb_mm_per_m: tol.plumbPerM, plumb_max_mm: tol.plumbMax, rail_mm: tol.rail }, wall: one || null }; }
    var f = a.filter || 'bad', list = all.filter(function (x) { return f === 'all' ? true : f === 'good' ? x.ok : !x.ok; });
    var s = a.sort || 'lean';
    list.sort(function (p, q) { return s === 'rail' ? (q.rail_mm || 0) - (p.rail_mm || 0) : s === 'length' ? (q.length_m || 0) - (p.length_m || 0) : s === 'number' ? p.number - q.number : (q.lean_mm || 0) - (p.lean_mm || 0); });
    var lim = clampInt(a.limit, 1, 60, 8);
    return { ok: true, finish_class: CLS[res.cls] || res.cls || '', tolerance: { plumb_mm_per_m: tol.plumbPerM, plumb_max_mm: tol.plumbMax, rail_mm: tol.rail },
      checked: wr.checked, out_of_tolerance: wr.bad, plumb_fail: wr.walls.filter(function (w) { return !w.okPlumb; }).length, rail_fail: wr.walls.filter(function (w) { return !w.okRail; }).length,
      median_plumb_mm_per_m: r(median(wr.walls.map(function (w) { return w.plumb; })), 2), median_rail_mm: r(median(wr.walls.map(function (w) { return w.rail; })), 1),
      cloud_tilt: res.level && res.level.ok ? { mm_per_m: r(res.level.mm, 2), applied: !!res.level.applied } : null,
      shown: Math.min(lim, list.length), of: list.length, walls: list.slice(0, lim) };
  }
  function ffClass(F) { return !(F > 0) ? '' : F < 20 ? 'ниже обычного' : F < 25 ? 'обычный (FF20)' : F < 35 ? 'умеренно ровный (FF25)' : F < 45 ? 'ровный (FF35)' : F < 60 ? 'очень ровный (FF45)' : 'сверхровный (FF60+)'; }
  function getFloor(ctx, a) {
    var res = insp(ctx); if (!res) return NO_INSPECTION;
    var f = res.floor; if (!f || !f.ok) return { ok: false, message: 'Пол не проверялся или по облаку его не удалось измерить.' };
    a = a || {};
    var F = f.F || {}, out = { ok: true, area_m2: r(f.area, 1), FF: r(F.FF, 1), FL: r(F.FL, 1), FF_class: ffClass(F.FF), FF_noise_limit: r(f.FFnoise, 0),
      slope_mm_per_m: r(f.plane && f.plane.mmPerM, 2), rail: { length_m: f.rail.len || 2, tolerance_mm: f.rail.tol, max_gap_mm: r(f.rail.max, 1), p95_mm: r(f.rail.p95, 1), share_over_tolerance_pct: r(f.rail.over * 100, 1), readings: f.rail.n },
      cloud_tilt: res.level && res.level.ok ? { mm_per_m: r(res.level.mm, 2), applied: !!res.level.applied } : null, rooms_count: (f.rooms || []).length };
    if (a.rooms || a.sort) {
      var s = a.sort || 'area', rooms = (f.rooms || []).map(function (x) { return { name: x.name, kind: x.kind === 'corridor' ? 'коридор' : 'помещение', area_m2: r(x.area, 1), FF: r(x.FF, 1), FL: r(x.FL, 1), slope_mm_per_m: r(x.tilt, 2), rail_max_mm: r(x.railMax, 1), rail_over_pct: r(x.railOver * 100, 1) }; });
      rooms.sort(function (p, q) { return s === 'ff' ? (p.FF || 0) - (q.FF || 0) : s === 'rail' ? (q.rail_max_mm || 0) - (p.rail_max_mm || 0) : s === 'tilt' ? (q.slope_mm_per_m || 0) - (p.slope_mm_per_m || 0) : (q.area_m2 || 0) - (p.area_m2 || 0); });
      out.rooms = rooms.slice(0, clampInt(a.limit, 1, 60, 12));
    }
    return out;
  }
  function defectRows(res) {
    var L = [];
    if (res.floor && res.floor.defects) res.floor.defects.forEach(function (d) { L.push({ where: 'пол', room: d.room || '', d: d }); });
    if (res.walls && res.walls.walls) res.walls.walls.forEach(function (w, wi) { (w.defects || []).forEach(function (d) { L.push({ where: 'стена ' + (wi + 1), wall: wi + 1, d: d }); }); });
    L.sort(function (a, b) { return b.d.depth - a.d.depth; });
    return L.map(function (x, i) { return { item: i + 1, where: x.where, room: x.room || undefined, kind: DEF_KIND[x.d.kind] || x.d.kind, depth_mm: r(x.d.depth, 1), area_m2: r(x.d.area, 2), x: r(x.d.u, 2), y: r(x.d.v, 2), height_m: x.d.h != null ? r(x.d.h, 2) : undefined }; });
  }
  function getDefects(ctx, a) {
    var res = insp(ctx); if (!res) return NO_INSPECTION;
    if (!(res.floor && res.floor.defects) && !(res.walls && res.walls.defects != null)) return { ok: false, message: 'Местные дефекты не искались (флажок «Местные дефекты и проёмы» в форме контроля).' };
    a = a || {};
    var all = defectRows(res), w = a.where || 'all', min = +a.min_depth_mm || 0;
    var list = all.filter(function (x) { return (w === 'all' || (w === 'floor' ? x.where === 'пол' : x.where !== 'пол')) && (x.depth_mm || 0) >= min; });
    var lim = clampInt(a.limit, 1, 100, 10);
    return { ok: true, tolerance_mm: 5, total: all.length, floor: all.filter(function (x) { return x.where === 'пол'; }).length, walls: all.filter(function (x) { return x.where !== 'пол'; }).length,
      total_area_m2: r(all.reduce(function (s, x) { return s + (x.area_m2 || 0); }, 0), 1), shown: Math.min(lim, list.length), of: list.length, defects: list.slice(0, lim) };
  }
  function getOpenings(ctx, a) {
    var res = insp(ctx); if (!res) return NO_INSPECTION;
    var op = res.openings; if (!op || !op.ok) return { ok: false, message: 'Проёмы не измерялись (флажок «Местные дефекты и проёмы»).' };
    a = a || {};
    var list = op.list.map(function (o, i) { return { item: i + 1, kind: OPEN_KIND[o.kind] || o.kind, width_m: r(o.width, 2), sill_m: o.kind === 'window' ? r(o.sill, 2) : undefined, head_m: o.head != null ? r(o.head, 2) : undefined, no_lintel: !!o.open }; });
    var k = a.kind || 'all', f = list.filter(function (x) { return k === 'all' || x.kind === OPEN_KIND[k]; });
    var heads = op.list.filter(function (o) { return o.kind === 'door' && o.head != null; }).map(function (o) { return o.head; });
    var lim = clampInt(a.limit, 1, 100, 12);
    return { ok: true, doors: op.doors, windows: op.windows, closed: op.list.filter(function (o) { return o.kind === 'closed'; }).length, no_lintel: op.list.filter(function (o) { return o.open; }).length,
      door_head_median_m: r(median(heads), 2), shown: Math.min(lim, f.length), of: f.length, openings: f.slice(0, lim) };
  }
  function mepSize(e) { var mm = function (x) { return Math.round(x * 1000); }; return e.kind === 'pipe' || e.shape === 'round' ? 'Ø' + mm(e.d || e.width) : mm(e.width) + '×' + mm(e.depth); }
  function getMep(ctx, a) {
    var res = insp(ctx); if (!res) return NO_INSPECTION;
    var me = res.mep; if (!me || !me.ok) return { ok: false, message: 'Балки и трубы не искались — включите в форме контроля «Балки, трубы, короба и лотки под потолком».' };
    a = a || {};
    var sm = me.summary || {}, by = {}, clear = me.clear || sm.clearLim || 2;
    Object.keys(sm.by || {}).forEach(function (k) { by[MEP_KIND[k] || k] = { count: sm.by[k].n, length_m: r(sm.by[k].length, 1) }; });
    var diam = Object.keys(sm.diam || {}).map(Number).sort(function (p, q) { return p - q; }).map(function (d) { return { d_mm: d, length_m: r(sm.diam[d], 1) }; });
    var list = me.list.map(function (e, i) { return { item: i + 1, id: e.id, kind: MEP_KIND[e.kind] || e.kind, size_mm: mepSize(e), length_m: r(e.length, 2), clear_m: r(e.clear, 2), at_ceiling: !!e.touch, low: !!e.warn, _k: e.kind }; });
    var f = a.filter || 'all';
    var sel = list.filter(function (x) { return f === 'all' ? true : f === 'low' ? x.low : x._k === f; }).sort(function (p, q) { return (q.low - p.low) || ((p.clear_m || 9) - (q.clear_m || 9)); });
    sel.forEach(function (x) { delete x._k; });
    var lim = clampInt(a.limit, 1, 100, 10);
    return { ok: true, total: me.list.length, by_kind: by, pipe_diameters: diam, min_clear_m: r(sm.minClear, 2), clear_limit_m: clear, below_limit: sm.warn || 0,
      shown: Math.min(lim, sel.length), of: sel.length, items: sel.slice(0, lim) };
  }
  function lineStatus(x, tol) { return x.length < 0.5 ? 'короткая' : x.cover < 0.3 ? 'нет в облаке' : x.points >= 20 && Math.abs(x.offset) > tol * 1000 ? 'смещена' : 'совпадает'; }
  function getCompare(ctx, a) {
    var c = null; try { c = ctx && ctx.compare ? ctx.compare() : null; } catch (_) {}
    if (!c || !c.lines) return { ok: false, message: 'Сравнение с проектом не выполнялось: окно результатов контроля → вкладка «Проект» → выбрать DXF.' };
    var tol = c.tol || 0.02, cnt = {}, lines = c.lines.map(function (x, i) { var s = lineStatus(x, tol); cnt[s] = (cnt[s] || 0) + 1; return { number: i + 1, layer: x.layer, length_m: r(x.length, 2), offset_mm: r(x.offset, 1), max_mm: r(x.max, 1), cover_pct: r(x.cover * 100, 0), status: s }; });
    var bad = lines.filter(function (x) { return x.status === 'смещена' || x.status === 'нет в облаке'; }).sort(function (p, q) { return Math.abs(q.offset_mm || 0) - Math.abs(p.offset_mm || 0); });
    return { ok: true, tolerance_mm: r(tol * 1000, 0), lines: lines.length, by_status: cnt, worst: bad.slice(0, clampInt(a && a.limit, 1, 50, 8)) };
  }
  function shortVerdict(res) {
    var out = [];
    if (res.floor && res.floor.ok) { var F = res.floor.F || {}; out.push('пол FF ' + ru(F.FF, 1) + ' / FL ' + ru(F.FL, 1) + ', уклон ' + ru(res.floor.plane && res.floor.plane.mmPerM, 2) + ' мм/м'); }
    if (res.walls && res.walls.ok) out.push('стен ' + res.walls.checked + ', вне допуска ' + res.walls.bad);
    var nf = res.floor && res.floor.defects ? res.floor.defects.length : 0, nw = res.walls && res.walls.defects != null ? res.walls.defects : 0;
    if (nf || nw) out.push('дефектов ' + (nf + nw));
    if (res.openings && res.openings.ok) out.push('дверей ' + res.openings.doors + ', окон ' + res.openings.windows);
    if (res.mep && res.mep.ok) out.push('под потолком ' + res.mep.list.length + ' элем.' + (res.mep.summary && res.mep.summary.warn ? ', ниже ' + ru(res.mep.clear, 2) + ' м — ' + res.mep.summary.warn : ''));
    return out.join('; ');
  }
  function getOverview(ctx) {
    var cl = null, pr = '', res = insp(ctx);
    try { cl = ctx && ctx.cloud ? ctx.cloud() : null; } catch (_) {}
    try { pr = ctx && ctx.project ? ctx.project() : ''; } catch (_) {}
    var out = { ok: true, project: pr || '', cloud: cl ? { name: cl.name || '', points_mln: cl.points ? r(cl.points / 1e6, 1) : null } : null, inspection: null };
    if (res) {
      var v = null; try { v = ctx.verdict ? ctx.verdict(res) : null; } catch (_) {}
      out.inspection = { file: res.fileName || '', storey: res.storey ? res.storey.name : '', finish_class: CLS[res.cls] || '', seconds: r(res.elapsed, 0), cleaned: !!res.prep,
        summary: v && v.length ? v : [shortVerdict(res)] };
    }
    return out;
  }
  function searchHelp(ctx, a) {
    var q = String(a && a.query || '').slice(0, 300);
    var hits = KB ? KB.search(q, 3) : [];
    return { ok: true, query: q, results: hits.map(function (h) { return { title: h.title, text: h.text }; }) };
  }
  function commandList(ctx) { try { return ctx && ctx.commands ? ctx.commands() || [] : []; } catch (_) { return []; } }
  function findCommand(ctx, a) {
    var q = String(a && a.query || ''), T = KB ? KB.terms(q) : q.toLowerCase().split(/\s+/);
    var list = commandList(ctx).map(function (c) {
      var hay = (String(c.label || '') + ' ' + (c.tip || '') + ' ' + (c.group || '') + ' ' + (c.tab || '') + ' ' + c.id).toLowerCase().replace(/ё/g, 'е'), lab = String(c.label || '').toLowerCase().replace(/ё/g, 'е'), s = 0;
      T.forEach(function (t) { if (lab.indexOf(t) >= 0) s += 3; else if (hay.indexOf(t) >= 0) s += 1; });
      return { c: c, s: s };
    }).filter(function (x) { return x.s > 0; }).sort(function (p, q2) { return q2.s - p.s; }).slice(0, 5);
    return { ok: true, query: q, commands: list.map(function (x) { return { id: x.c.id, path: 'вкладка «' + x.c.tab + '» → «' + x.c.group + '» → «' + x.c.label + '»', tip: x.c.tip || '', enabled: x.c.enabled !== false }; }) };
  }

  // ------------------------------------------------------------------ калькулятор (без eval)
  function calculate(expr) {
    var s = String(expr == null ? '' : expr).replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-').replace(/(\d),(\d)/g, '$1.$2').replace(/;/g, ',').toLowerCase();
    var i = 0;
    function ws() { while (i < s.length && /\s/.test(s[i])) i++; }
    function num() {
      ws(); var m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/.exec(s.slice(i)); if (m) { i += m[0].length; return parseFloat(m[0]); }
      m = /^[a-z_]+/.exec(s.slice(i));
      if (m) {
        i += m[0].length; var name = m[0];
        if (name === 'pi') return Math.PI; if (name === 'e') return Math.E;
        ws(); if (s[i] !== '(') throw new Error('ожидалась «(» после ' + name);
        i++; var args = [expr2()]; ws(); while (s[i] === ',') { i++; args.push(expr2()); ws(); }
        if (s[i] !== ')') throw new Error('нет «)»'); i++;
        var F = { sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max, round: function (x, d) { var k = Math.pow(10, d || 0); return Math.round(x * k) / k; }, sin: function (x) { return Math.sin(x * Math.PI / 180); }, cos: function (x) { return Math.cos(x * Math.PI / 180); }, tan: function (x) { return Math.tan(x * Math.PI / 180); }, atan: function (x) { return Math.atan(x) * 180 / Math.PI; }, ln: Math.log, log: Math.log10 }[name];
        if (!F) throw new Error('неизвестная функция ' + name);
        return F.apply(null, args);
      }
      if (s[i] === '(') { i++; var v = expr2(); ws(); if (s[i] !== ')') throw new Error('нет «)»'); i++; return v; }
      throw new Error('ошибка в выражении у «' + s.slice(i, i + 8) + '»');
    }
    function unary() { ws(); if (s[i] === '-') { i++; return -unary(); } if (s[i] === '+') { i++; return unary(); } var v = num(); ws(); if (s[i] === '%') { i++; v = v / 100; } return v; }
    function pow() { var b = unary(); ws(); if (s[i] === '^' || (s[i] === '*' && s[i + 1] === '*')) { i += s[i] === '^' ? 1 : 2; return Math.pow(b, pow()); } return b; }
    function term() { var v = pow(); for (;;) { ws(); var c = s[i]; if (c === '*' && s[i + 1] !== '*') { i++; v *= pow(); } else if (c === '/') { i++; v /= pow(); } else return v; } }
    function expr2() { var v = term(); for (;;) { ws(); var c = s[i]; if (c === '+') { i++; v += term(); } else if (c === '-') { i++; v -= term(); } else return v; } }
    try {
      if (s.length > 300) throw new Error('слишком длинное выражение');
      var v = expr2(); ws(); if (i < s.length) throw new Error('лишние символы: ' + s.slice(i, i + 10));
      if (!isFinite(v)) throw new Error('результат не число');
      return { ok: true, expression: String(expr), result: Math.round(v * 1e9) / 1e9 };
    } catch (e) { return { ok: false, expression: String(expr), message: e.message }; }
  }

  // ------------------------------------------------------------------ действия (с подтверждением)
  var FORMAT_TEXT = { csv: 'таблицы контроля в CSV (Excel)', pdf: 'PDF-отчёт контроля геометрии', mep_dxf: 'балки и трубы в DXF', mep_ifc: 'балки и трубы в IFC' };
  var TAB_TEXT = { floor: 'Пол', walls: 'Стены', def: 'Дефекты', open: 'Проёмы', mep: 'Балки и трубы', dxf: 'Проект' };
  function describeAction(name, a, ctx) {
    a = a || {};
    if (name === 'run_command') { var c = commandList(ctx).find(function (x) { return x.id === a.id; }); return 'Выполнить команду «' + (c ? c.label : a.id) + '»' + (c ? ' (' + c.tab + ' → ' + c.group + ')' : '') + '?'; }
    if (name === 'show_result') return 'Открыть результаты контроля' + (a.tab ? ' — вкладка «' + (TAB_TEXT[a.tab] || a.tab) + '»' : '') + (a.wall ? ', стена ' + a.wall : '') + (a.item ? ', строка ' + a.item : '') + '?';
    if (name === 'export_result') return 'Сохранить ' + (FORMAT_TEXT[a.format] || a.format) + '?';
    if (name === 'clean_cloud') { var cl = cloudInfo(ctx), th = CLEAN_TEXT[a.thoroughness] || CLEAN_TEXT.normal;
      return 'Почистить облако' + (cl && cl.name ? ' «' + cl.name + '»' : '') + ' — ' + th + '?' + (a.flatten_surfaces ? ' Стены, пол и потолок будут выровнены (точки сдвинутся).' : ' Точки стен и пола не сдвигаются — замеры не искажаются.') + ' Перед применением удаляемое будет показано красным; Ctrl+Z вернёт облако.'; }
    if (name === 'run_plan') return (a.title ? '«' + a.title + '»: ' : 'Выполнить по порядку: ') + (a.steps || []).map(function (st, i) { return (i + 1) + ') ' + stepText(st, ctx); }).join('; ') + '?';
    if (name === 'install_updates') return 'Установить обновления баз' + (a.ids && a.ids.length ? ': ' + a.ids.join(', ') : ' (все найденные)') + '? Исходные данные проверяются по SHA-256; программа и модель не меняются.';
    return 'Выполнить ' + name + '?';
  }
  function stepText(st, ctx) {
    var a = st.args || {};
    if (st.tool === 'clean_cloud') return 'почистить облако — ' + (CLEAN_TEXT[a.thoroughness] || CLEAN_TEXT.normal);
    if (st.tool === 'run_command') { var c = commandList(ctx).find(function (x) { return x.id === a.id; }); return 'команда «' + (c ? c.label : a.id) + '»'; }
    if (st.tool === 'export_result') return 'сохранить ' + (FORMAT_TEXT[a.format] || a.format);
    if (st.tool === 'show_result') return 'показать результаты' + (a.wall ? ', стена ' + a.wall : '');
    if (st.tool === 'audit_cloud') return 'проверить качество облака';
    if (st.tool === 'pick_element') return 'включить «Что это?»';
    return st.tool.replace(/^get_/, 'данные: ');
  }
  // r43: нормализация шагов плана (данные от модели и из чужих пакетов — только разрешённые инструменты, простые аргументы)
  function normSteps(steps) {
    if (!Array.isArray(steps)) return [];
    var out = [];
    steps.slice(0, 12).forEach(function (st) {
      if (!st || typeof st !== 'object') return;
      var tool = String(st.tool || st.name || ''), args = st.args && typeof st.args === 'object' ? st.args : (st.arguments && typeof st.arguments === 'object' ? st.arguments : {});
      if (!PLAN_TOOLS[tool]) return;
      var a = {}; Object.keys(args).slice(0, 8).forEach(function (k) { var v = args[k]; if (/^[a-z_]{1,24}$/.test(k) && (typeof v === 'string' ? v.length <= 80 : typeof v === 'number' || typeof v === 'boolean')) a[k] = v; });
      out.push({ tool: tool, args: a });
    });
    return out;
  }
  // журнал выполненных (успешно) действий — для «запомни последние действия как навык»: последние 30 минут, после сохранения навыка — с чистого листа
  var lastActs = [], ACT_TTL = 30 * 60e3;
  function logAct(name, a) {
    if (name === 'run_plan' || name === 'run_skill' || name === 'install_updates') return;
    var x = JSON.parse(JSON.stringify(a || {}));
    if (name === 'clean_cloud' && 'reason' in x) { x.thoroughness = 'auto'; delete x.reason; }   // выбран по проверке облака — в навыке тоже «на усмотрение»
    lastActs.push({ tool: name, args: x, t: Date.now() }); if (lastActs.length > 12) lastActs.shift();
  }
  function lastActions() { var t0 = Date.now() - ACT_TTL; return lastActs.filter(function (x) { return x.t >= t0; }).map(function (x) { return { tool: x.tool, args: x.args }; }); }
  function clearActions() { lastActs = []; }
  // авто-уровень чистки по проверке облака
  async function autoLevel(ctx) {
    if (!ctx || !ctx.auditCloud) return { level: 'normal', why: 'проверка качества недоступна — обычная чистка' };
    var au = null; try { au = await ctx.auditCloud(); } catch (_) { au = null; }
    if (!au || !au.ok) return { level: 'normal', why: 'облако не удалось проверить — обычная чистка' };
    var sg = au.suggest || {};
    return { level: CLEAN_TEXT[sg.thoroughness] && sg.thoroughness !== 'auto' ? sg.thoroughness : 'normal', why: sg.why || '', audit: au };
  }
  var CLEAN_TEXT = { quick: 'быстро (шум и мусор)', normal: 'обычно (шум, прохожие, «волоски» у стен)', deep: 'до мелочей (шум, прохожие, «волоски», дубли, неверные точки, летающие обрывки, далёкие выбросы, одиночные точки в пустоте)', auto: 'на усмотрение ассистента по проверке качества облака' };
  function cloudInfo(ctx) { try { return ctx && ctx.cloud ? ctx.cloud() : null; } catch (_) { return null; } }
  async function doAction(name, a, ctx) {
    a = a || {};
    if (name === 'clean_cloud') {
      if (!ctx || !ctx.cleanCloud) return { ok: false, message: 'Чистка облака недоступна в этом окне.' };
      var ci = cloudInfo(ctx); if (!ci || !ci.name) return { ok: false, message: 'Облако не открыто. Откройте облако точек, затем попросите почистить.' };
      if (!CLEAN_TEXT[a.thoroughness]) a.thoroughness = 'normal';
      if (a.thoroughness === 'auto') { var al = await autoLevel(ctx); a.thoroughness = al.level; a.reason = al.why; }
    }
    if (name === 'run_skill') {
      var sk = ctx && ctx.memory && ctx.memory.findSkill ? ctx.memory.findSkill(String(a.name || '')) : null;
      if (!sk) return { ok: false, message: 'Нет навыка «' + String(a.name || '') + '». Научите: «запомни навык «название»: шаг, потом шаг…».' };
      return doAction('run_plan', { title: 'навык «' + sk.name + '»', steps: sk.steps, skill: sk.name }, ctx);
    }
    if (name === 'run_plan') {
      a.steps = normSteps(a.steps);
      if (!a.steps.length) return { ok: false, message: 'В плане нет допустимых шагов (clean_cloud, run_command, show_result, export_result, audit_cloud, get_*).' };
      for (var si = 0; si < a.steps.length; si++) if (a.steps[si].tool === 'clean_cloud' && a.steps[si].args.thoroughness === 'auto') { var al2 = await autoLevel(ctx); a.steps[si].args.thoroughness = al2.level; }
    }
    if (name === 'install_updates' && !(ctx && ctx.updates && ctx.updates.install)) return { ok: false, message: 'Обновления баз недоступны в этом окне.' };
    if (name === 'run_command') {
      var c = commandList(ctx).find(function (x) { return x.id === a.id; });
      if (!c) return { ok: false, message: 'Нет команды с id «' + a.id + '». Найдите id через find_command.' };
      if (c.enabled === false) return { ok: false, message: 'Команда «' + c.label + '» сейчас недоступна' + (c.why ? ': ' + c.why : '') + '.' };
    }
    if ((name === 'show_result' || name === 'export_result') && !insp(ctx)) return NO_INSPECTION;
    if (name === 'export_result' && /^mep_/.test(a.format || '')) { var me = insp(ctx).mep; if (!me || !me.ok || !me.list.length) return { ok: false, message: 'Нет найденных балок и труб для выгрузки.' }; }
    if (name === 'export_result' && !FORMAT_TEXT[a.format]) return { ok: false, message: 'Формат: csv, pdf, mep_dxf, mep_ifc.' };
    var yes = ctx && ctx.confirm ? await ctx.confirm(describeAction(name, a, ctx), { tool: name, args: a }) : false;
    if (!yes) return { ok: false, cancelled: true, message: 'Пользователь отменил действие.' };
    try {
      if (name === 'run_plan') return await runPlanSteps(a, ctx);
      if (name === 'install_updates') { var iu = await ctx.updates.install(Array.isArray(a.ids) ? a.ids.slice(0, 50).map(String) : null); return Object.assign({ ok: true }, iu || {}); }
      if (name === 'clean_cloud') {
        var cr = await ctx.cleanCloud({ thoroughness: a.thoroughness, flatten: !!a.flatten_surfaces, people: a.people });
        if (!cr) return { ok: false, message: 'Облако не изменено.' };
        if (cr.cancelled) return { ok: false, cancelled: true, message: 'Пользователь не применил чистку — облако не изменено.' };
        if (cr.ok && ctx.memory && ctx.memory.learn) { try { ctx.memory.learn('clean.level', a.thoroughness, true); } catch (_) {} }
        if (cr.ok !== false) logAct(name, a);
        return Object.assign({ thoroughness: a.thoroughness }, cr, { note: cr.ok ? (cr.big ? 'Открыто окно полной очистки большого скана — запуск в нём. Цифр результата пока нет.' : 'Чистка применена. Цифры — из message/stats выше; Ctrl+Z вернёт облако.') : 'Облако не изменено.' });
      }
      var out = name === 'run_command' ? await ctx.runCommand(a.id) : name === 'show_result' ? await ctx.showResult(a) : await ctx.exportResult(a.format);
      var r = Object.assign({ ok: true }, out || {});
      if (r.ok !== false && !r.cancelled) logAct(name, a);
      if (r.ok !== false) r.note = name === 'run_command' ? 'Команда запущена в программе; её результаты пользователь увидит в окне программы позже. Данных результата у тебя нет — не называй цифр, просто сообщи, что запущено.'
        : name === 'export_result' ? 'Открыто окно сохранения файла; пользователь выберет папку сам.' : 'Окно результатов открыто.';
      return r;
    } catch (e) { return { ok: false, message: String(e && e.message || e) }; }
  }

  // r43: выполнение плана — подтверждение уже получено; шаги по очереди, ожидание завершения длинных операций, стоп на ошибке
  async function runPlanSteps(a, ctx) {
    var inner = Object.create(ctx); inner.confirm = async function () { return true; };
    var res = [], stopped = null;
    for (var i = 0; i < a.steps.length; i++) {
      var st = a.steps[i];
      if (ctx.onPlanStep) { try { ctx.onPlanStep({ index: i, total: a.steps.length, step: st, text: stepText(st, ctx), phase: 'start' }); } catch (_) {} }
      var r0 = null;
      try { r0 = await execTool(st.tool, st.args, inner); } catch (e) { r0 = { ok: false, message: String(e && e.message || e) }; }
      var ok = !!r0 && r0.ok !== false;
      res.push({ step: i + 1, tool: st.tool, text: stepText(st, ctx), ok: ok, message: r0 && (r0.message || r0.note) ? String(r0.message || r0.note).slice(0, 300) : undefined, data: st.tool === 'audit_cloud' || /^get_/.test(st.tool) ? r0 : undefined });
      if (ctx.onPlanStep) { try { ctx.onPlanStep({ index: i, total: a.steps.length, step: st, ok: ok, result: r0, phase: 'done' }); } catch (_) {} }
      if (!ok) { stopped = i + 1; break; }
      if (ctx.waitIdle && i < a.steps.length - 1) { try { var wi = await ctx.waitIdle({ step: st }); if (wi && wi.ok === false) { res[res.length - 1].wait = wi.message; stopped = i + 1; break; } } catch (_) {} }
    }
    if (!stopped && a.skill && ctx.memory && ctx.memory.useSkill) { try { ctx.memory.useSkill(a.skill); } catch (_) {} }
    return { ok: !stopped, title: a.title || '', done: res.filter(function (x) { return x.ok; }).length, total: a.steps.length, steps: res,
      message: stopped ? 'Остановлено на шаге ' + stopped + ' из ' + a.steps.length + ': ' + (res[stopped - 1].wait || res[stopped - 1].message || 'ошибка') : 'Выполнено шагов: ' + res.length + ' из ' + a.steps.length + '.' };
  }
  async function auditCloud(ctx) {
    if (!ctx || !ctx.auditCloud) return { ok: false, message: 'Проверка облака недоступна в этом окне.' };
    var ci = cloudInfo(ctx); if (!ci || !ci.name) return { ok: false, message: 'Облако не открыто.' };
    try { var r0 = await ctx.auditCloud(); return r0 || { ok: false, message: 'Нет данных облака.' }; } catch (e) { return { ok: false, message: 'Проверка не удалась: ' + String(e && e.message || e) }; }
  }
  function saveSkill(ctx, a) {
    if (!ctx || !ctx.memory || !ctx.memory.addSkill) return { ok: false, message: 'Память ассистента недоступна.' };
    var steps = a.from_last ? lastActions() : normSteps(a.steps);
    steps = normSteps(steps);
    if (!steps.length) return { ok: false, message: a.from_last ? 'Пока нет выполненных действий — сначала сделайте их, потом попросите запомнить.' : 'Нет шагов для навыка.' };
    var nm = String(a.name || '').trim().slice(0, 60); if (!nm) return { ok: false, message: 'Нужно имя навыка.' };
    var r0 = ctx.memory.addSkill({ name: nm, steps: steps, text: a.text || '' });
    if (r0 && r0.ok && a.from_last) clearActions();
    return r0 && r0.ok ? { ok: true, message: 'Навык «' + nm + '» сохранён: ' + steps.map(function (st, i) { return (i + 1) + ') ' + stepText(st, ctx); }).join('; ') + '. Скажите «выполни навык ' + nm + '».', steps: steps } : { ok: false, message: (r0 && r0.error) || 'Не удалось сохранить навык.' };
  }
  async function checkUpdates(ctx) {
    if (!ctx || !ctx.updates || !ctx.updates.check) return { ok: false, message: 'Обновления баз недоступны в этом окне.' };
    try { return (await ctx.updates.check()) || { ok: false, message: 'Нет ответа.' }; } catch (e) { return { ok: false, message: String(e && e.message || e) }; }
  }

  // ------------------------------------------------------------------ база норм и зрение (r35)
  function hasVision(ctx) { try { return !!(ctx && ctx.vision && ctx.vision() && ctx.captureView); } catch (_) { return false; } }
  async function searchNorms(ctx, a) {
    var q = String(a && (a.query || a.q) || '').trim();
    if (!q) return { ok: false, message: 'Укажи query — о чём требование.' };
    if (!ctx || !ctx.searchNorms) return { ok: false, message: 'База норм недоступна в этом окне.' };
    var r;
    try { r = await ctx.searchNorms(q, { doc: a && a.doc ? String(a.doc) : undefined, n: clampInt(a && a.limit, 1, 8, 5) }); }
    catch (e) { return { ok: false, message: 'Поиск по базе норм не удался: ' + String(e && e.message || e) }; }
    if (!r || r.ok === false) return { ok: false, message: (r && (r.error || r.message)) || 'Поиск по базе норм не удался.' };
    var res = (r.results || []).slice(0, 6).map(function (x) {
      var o = { cite: x.cite, source: x.source, text: String(x.text || '').slice(0, 1200) };
      if (x.topic) o.topic = x.topic;
      return o;
    });
    var out = { ok: true, query: q, found: res.length, results: res };
    // для окна (источники под ответом): id документа и страница; в JSON для модели не попадает
    Object.defineProperty(out, '_src', { value: (r.results || []).slice(0, 6).map(function (x) { return { cite: x.cite, source: x.source, id: x.id, page: x.page, doc: x.doc, text: String(x.text || '').slice(0, 600) }; }), enumerable: false });
    if (res.some(function (x) { return x.source === 'встроенная база'; })) out.note = 'Источник «встроенная база» — краткое изложение норм BIM Twin; полный текст — в документе (сверить с действующей редакцией).';
    if (!res.length) out.message = r.note || 'В базе норм ничего не найдено. Предложи пользователю добавить документ в «База норм».';
    return out;
  }
  async function lookAtView(ctx, a) {
    if (!hasVision(ctx)) return { ok: false, message: 'Текущая модель не видит изображения.' };
    var r;
    try { r = await ctx.captureView(); } catch (e) { return { ok: false, message: 'Не удалось сделать снимок вида: ' + String(e && e.message || e) }; }
    if (!r || !r.ok || !r.image) return { ok: false, message: (r && r.error) || 'Не удалось сделать снимок вида.' };
    return { ok: true, _image: r.image, message: 'Снимок текущего вида приложен следующим сообщением' + (a && a.focus ? ' (внимание: ' + String(a.focus).slice(0, 120) + ')' : '') + '. Опиши, что видно; размеры по снимку не называй.' };
  }

  // ------------------------------------------------------------------ r42: «Что это?» и память
  async function getPicked(ctx) {
    var p = null;
    try { p = ctx && ctx.picked ? await ctx.picked() : null; } catch (e) { return { ok: false, message: 'Не удалось прочитать выбранный элемент: ' + String(e && e.message || e) }; }
    if (!p) return { ok: false, message: 'Ничего не выбрано. Нажмите «Что это?» в окне ассистента (или попросите «включи выбор элемента») и щёлкните по стене, полу, трубе или предмету в 3D-виде.' };
    return p;
  }
  async function pickElement(ctx) {
    if (!ctx || !ctx.pickElement) return { ok: false, message: 'Выбор элемента недоступен в этом окне.' };
    try { var r = await ctx.pickElement(); return Object.assign({ ok: true, message: 'Режим «Что это?» включён: щёлкните по элементу в 3D-виде — карточка с размерами появится в чате.' }, r || {}); }
    catch (e) { return { ok: false, message: String(e && e.message || e) }; }
  }
  function remember(ctx, a) {
    if (!ctx || !ctx.memory || !ctx.memory.add) return { ok: false, message: 'Память ассистента недоступна.' };
    var t = String(a && a.text || '').trim(); if (!t) return { ok: false, message: 'Нечего запоминать — укажи text.' };
    var r = ctx.memory.add({ kind: a.kind, text: t, remember: true });
    return r && r.ok ? { ok: true, saved: r.item ? r.item.text : t, kind: r.item ? r.item.kind : a.kind, duplicate: !!r.duplicate, message: r.duplicate ? 'Это уже есть в памяти.' : 'Запомнено. Использую в следующих ответах; список — «Опыт и знания» в окне ассистента.' } : { ok: false, message: (r && r.error) || 'Не удалось запомнить.' };
  }
  function recallMemory(ctx, a) {
    if (!ctx || !ctx.memory || !ctx.memory.recall) return { ok: false, message: 'Память ассистента недоступна.' };
    var L = ctx.memory.recall(String(a && a.query || ''), clampInt(a && a.limit, 1, 10, 6)) || [];
    return { ok: true, found: L.length, items: L.map(function (x) { return x.q && x.a ? { kind: x.kind, question: x.q, answer: x.a.slice(0, 800) } : { kind: x.kind, text: x.text.slice(0, 800) }; }), note: 'Это опыт пользователя, а не данные объекта: цифры объекта бери из инструментов get_*.' };
  }

  async function execTool(name, args, ctx) {
    var a = args && typeof args === 'object' ? args : {};
    if (typeof args === 'string') { try { a = JSON.parse(args); } catch (_) { a = {}; } }
    switch (name) {
      case 'get_overview': return getOverview(ctx);
      case 'get_walls': return getWalls(ctx, a);
      case 'get_floor': return getFloor(ctx, a);
      case 'get_defects': return getDefects(ctx, a);
      case 'get_openings': return getOpenings(ctx, a);
      case 'get_mep': return getMep(ctx, a);
      case 'get_dxf_compare': return getCompare(ctx, a);
      case 'search_help': return searchHelp(ctx, a);
      case 'find_command': return findCommand(ctx, a);
      case 'calculate': return calculate(a.expression != null ? a.expression : a.expr);
      case 'search_norms': return searchNorms(ctx, a);
      case 'look_at_view': return lookAtView(ctx, a);
      case 'get_picked': return getPicked(ctx);
      case 'pick_element': return pickElement(ctx);
      case 'remember': return remember(ctx, a);
      case 'recall_memory': return recallMemory(ctx, a);
      case 'audit_cloud': return auditCloud(ctx);
      case 'save_skill': return saveSkill(ctx, a);
      case 'check_updates': return checkUpdates(ctx);
      default: if (ACTIONS[name]) return doAction(name, a, ctx);
    }
    return { ok: false, message: 'Нет такого инструмента: ' + name + '. Доступны: ' + toolNames().join(', ') };
  }

  // ------------------------------------------------------------------ разбор ответа модели
  function stripThink(t) { return String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '').trim(); }
  // небольшие модели иногда пишут вызов инструмента текстом: <tool_call>{...}</tool_call> или ```json {"name":…,"arguments":…}```
  function inlineToolCalls(text) {
    var t = String(text || ''), out = [], names = toolNames(), m;
    var re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
    while ((m = re.exec(t))) push(m[1]);
    if (!out.length) { var re2 = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g; while ((m = re2.exec(t))) push(m[1]); }
    if (!out.length) { var s = t.trim(); if (/^\{[\s\S]*\}$/.test(s)) push(s); }
    return out;
    function push(js) {
      var j; try { j = JSON.parse(js); } catch (_) { return; }
      var nm = j && (j.name || (j.function && j.function.name)), ar = j && (j.arguments || j.parameters || (j.function && j.function.arguments) || {});
      if (typeof ar === 'string') { try { ar = JSON.parse(ar); } catch (_) { ar = {}; } }
      if (nm && names.indexOf(nm) >= 0) out.push({ function: { name: nm, arguments: ar } });
    }
  }
  function snapshot(ctx) {
    var res = insp(ctx), cl = null, pr = '';
    try { cl = ctx && ctx.cloud ? ctx.cloud() : null; } catch (_) {}
    try { pr = ctx && ctx.project ? ctx.project() : ''; } catch (_) {}
    var d = new Date();
    return { cloud: cl && cl.name ? cl.name + (cl.points ? ' (' + ru(cl.points / 1e6, 1) + ' млн точек)' : '') : '', inspection: res ? (res.fileName || 'облако') + (res.storey && res.storey.name ? ', ' + res.storey.name : '') : '', project: pr || '',
      today: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'),
      norms: (function () { try { return ctx && ctx.normsInfo ? String(ctx.normsInfo() || '') : ''; } catch (_) { return ''; } })(), vision: hasVision(ctx),
      picked: (function () { try { return ctx && ctx.hasPicked && ctx.hasPicked() && ctx.pickedTitle ? String(ctx.pickedTitle() || '') : ''; } catch (_) { return ''; } })(),
      memory: (function () { try { return ctx && ctx.memory && ctx.memory.info ? String(ctx.memory.info() || '') : ''; } catch (_) { return ''; } })() };
  }
  function systemPrompt(ctx) { return PROMPT ? PROMPT.build(snapshot(ctx)) : 'Ты — ассистент BIM Twin. Отвечай по-русски.'; }
  function trimHistory(h, maxTurns) {
    var L = (h || []).filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && m.content; }).map(function (m) { return { role: m.role, content: String(m.content).slice(0, 4000) }; });
    return L.slice(-2 * (maxTurns || 6));
  }

  // ------------------------------------------------------------------ заранее нужные данные по смыслу вопроса
  // небольшим моделям (2–9B) так надёжнее: данные уже в разговоре, модели остаётся понять и сформулировать; большие всё равно
  // могут вызвать любые инструменты сами
  var RX = {
    calc: /(\d+(?:[.,]\d+)?)\s*(?:на|x|х|×|\*)\s*(\d+(?:[.,]\d+)?)/i,
    how: /(как |где |что (такое|значит|означает)|зачем|почему|какие нормы|по нормам|норм[аеыу]|СП |что умеешь)/i,
    defects: /(дефект|бугор|бугры|впадин|вмятин|выступ)/i,
    mep: /(труб|балк|короб|воздуховод|лот(о|к)|высот\S* в свету|в свету|под потолк|инженерн)/i,
    openings: /(проём|проем|двер|окн)/i,
    dxf: /(dxf|с проектом|проекту|чертеж|чертёж)/i,
    floor: /((^|[^а-яё])пол([^а-яё]|$)|пола|полу|\bff\b|\bfl\b|ровност|горизонтальн|уклон|стяжк)/i,
    walls: /(стен|вертикал|завал|отвес|неровн|штукатур)/i,
    overview: /(итог|сводк|результат|вывод|что с объект|общ(ая|ий|ее) картин|как дела|в целом)/i,
    norms: /(норм[аеыуо]|нормати|(^|[^а-яё])(СП|ГОСТ|СНиП)\s*\d|допуск|допустим|допускает|требован|по правилам|можно ли|разрешено|разрешается|не более|не менее)/i,
    command: /(запусти|открой|выполни|включи|сделай|построй|где (кнопка|команда)|как найти|на какой вкладке)/i
  };
  var RX_PICK = /(что это|это (что|за)|что за (элемент|предмет|штук|конструкц)|выбранн|нажал|щ[её]лкнул|кликнул|отмечен|указал|(^|[^а-яё])(этот|эта|эту|этой|этого|этим|это)([^а-яё]|$))/i;
  function planTools(question, ctx) {
    var q = String(question || ''), out = [], add = function (name, args) { if (!out.some(function (x) { return x.name === name; })) out.push({ name: name, args: args || {} }); };
    // r42: вопрос о выбранном щелчком элементе — его карточка всегда первой
    var hasPick = false; try { hasPick = !!(ctx && ctx.picked && ctx.hasPicked && ctx.hasPicked()); } catch (_) {}
    if (hasPick && RX_PICK.test(q)) add('get_picked', {});
    // «как проверить / как сделать…» — нужна инструкция, а не цифры объекта: данные не подставляем, модель может запросить их сама
    var howTo = /как (проверить|сделать|настроить|измерить|запустить|найти|выгрузить|сохранить|открыть|построить|сравнить|включить)/i.test(q);
    if (howTo) { add('search_help', { query: q.slice(0, 200) }); add('find_command', { query: q.replace(RX.command, ' ').slice(0, 200) }); return out; }
    if (/(запомни|что ты помнишь|что ты знаешь обо мне|мои правила|из памяти)/i.test(q) && ctx && ctx.memory && !/^\s*(пожалуйста[, ]+)?запомни/i.test(q)) add('recall_memory', { query: q.slice(0, 200) });
    // вопрос только о норме («какой допуск по СП 70», «можно ли…») — данные объекта не подставляем
    var nq = q.replace(/(вне|в|за пределами|за) допуск\S*/gi, ' ');
    var isNorm = RX.norms.test(nq), normOnly = isNorm && /(как(ой|ая|ие|ое|ов)|что говорит|по (СП|ГОСТ|СНиП|норм|правил)|(^|[^а-яё])(СП|ГОСТ|СНиП)\s*\d|требован|можно ли|разрешено|разрешается|допустим)/i.test(nq) &&
      !/(у нас|на объекте|наш|эт(от|ой|и|у|а) (стен|пол|перекрыт|колонн)|сколько|соответству|укладыва|проходит ли|выполнен|по результат|по облаку|по скану|стен\S*\s*(№|номер)?\s*\d)/i.test(q);
    var dhm = /(СП|ГОСТ(?:\s+Р)?|СНиП)\s*(\d{1,3}(?:\.\d{1,5})?)/i.exec(q);
    var normArgs = dhm ? { query: q.slice(0, 200), doc: dhm[1].toUpperCase().replace('СНИП', 'СНиП') + ' ' + dhm[2] } : { query: q.slice(0, 200) };
    if (normOnly) { add('search_norms', normArgs); return out.slice(0, 4); }
    var m = RX.calc.exec(q);
    if (m && /(посчита|площад|сколько|умнож|объём|объем)/i.test(q)) add('calculate', { expression: m[1].replace(',', '.') + '*' + m[2].replace(',', '.') });
    // r43: качество облака (шаг, шум, двоение, одиночные точки) и актуальность баз — свои инструменты
    if (ctx && ctx.auditCloud && /((провер|оцени|какое|каково|покажи)\S*\s+(качеств\S*\s+)?(облак|скан)|качеств\S*\s+(облак|скан)|(шум|двоени|плотност|шаг\s+точек)\S*\s+(в\s+|у\s+)?(облак|скан)|облак\S*\s+(шумн|двои))/i.test(q) && !/(как (проверить|оценить|улучшить)|что такое)/i.test(q)) add('audit_cloud', {});
    if (ctx && ctx.updates && /((провер|есть ли|какие|появил)\S*\s+(нов\S*\s+)?(обновлени|выпуск)|обновлени\S*\s+(баз|норм|знани|справк)|актуальн\S*\s+(ли\s+)?(баз|норм|сп\b|гост|документ))/i.test(q)) add('check_updates', {});
    if (RX.defects.test(q)) add('get_defects', { limit: 8 });
    if (RX.mep.test(q)) add('get_mep', { filter: /(высот|свет|низ|пройд|хват)/i.test(q) ? 'low' : 'all', limit: 8 });
    if (RX.openings.test(q)) add('get_openings', {});
    if (RX.dxf.test(q)) add('get_dxf_compare', {});
    if (RX.floor.test(q)) add('get_floor', { rooms: /(помещен|комнат|по зонам)/i.test(q) });
    var wn = /стен\S*\s*(?:№|номер)?\s*(\d{1,3})/i.exec(q);
    if (wn) add('get_walls', { number: +wn[1] });
    else if (RX.walls.test(q) && !RX.defects.test(q)) add('get_walls', { filter: /(все стены|всех стен|каждой)/i.test(q) ? 'all' : 'bad', sort: /(неровн|рейк)/i.test(q) ? 'rail' : 'lean', limit: 8 });
    if (RX.overview.test(q)) add('get_overview', {});
    if (isNorm) add('search_norms', normArgs);
    // строительный вопрос без данных объекта («какая толщина защитного слоя», «минимальная ширина марша») — тоже в базу норм
    else if (!out.length && /(минимальн|максимальн|предельн|должн[аоыя]?\b|обязательн|толщин|ширин|высот|шаг |глубин|расстояни|класс бетона|марк[аиу] )/i.test(q) && /(как(ой|ая|ое|ие|ов)|сколько|нужн|должн|минимальн|максимальн|предельн)/i.test(q)) add('search_norms', normArgs);
    var data = out.length > 0;
    if (RX.how.test(q) && (!data || /(как (проверить|сделать|настроить|работает|найти|измерить|запустить)|что (такое|значит|означает)|норм|СП |допуск)/i.test(q))) add('search_help', { query: q.slice(0, 200) });
    if (RX.command.test(q) || (!data && /(где|как найти|кнопк|вкладк)/i.test(q))) add('find_command', { query: q.replace(RX.command, ' ').slice(0, 200) });
    return out.slice(0, 4);
  }

  // явная просьба о действии — выполняем сами (с подтверждением), не надеясь, что небольшая модель вызовет инструмент
  var RX_DO = /(покажи|открой|выдели|перейди|сохрани|выгрузи|экспортируй|сделай|сформируй|создай|запусти|выполни|включи)/i;
  var RX_CLEAN = /(почист|очист|вычист|подчист|чистк\S* облак|убери\s+(весь\s+|все\s+)?(мусор|шум|лишн)|удали\s+(весь\s+|все\s+)?(мусор|шум|лишн))/;
  // r43: готовые сценарии инженера (одно подтверждение на весь сценарий)
  var WORKFLOWS = [
    { id: 'acceptance', title: 'приёмка помещения по облаку', rx: /(при[её]мк\S*|прими\s+(помещени|квартир|объект)|полн\S*\s+(проверк|контрол)\S*\s+(помещени|квартир|объект|облак))/,
      steps: [{ tool: 'clean_cloud', args: { thoroughness: 'auto' } }, { tool: 'run_command', args: { id: 'cpInspect' } }, { tool: 'export_result', args: { format: 'pdf' } }] },
    { id: 'bim', title: 'BIM-модель по облаку', rx: /((сделай|построй|создай|собери)\s+(мне\s+)?(\S+\s+)?(bim|бим)|scan\s*(to|→|2)\s*bim|скан\s*(→|в)\s*bim)/,
      steps: [{ tool: 'clean_cloud', args: { thoroughness: 'auto' } }, { tool: 'run_command', args: { id: 'lxScan2BimBtn' } }] },
    { id: 'full', title: 'полный цикл: чистка, контроль, отчёт, BIM', rx: /(сделай\s+вс[её](\s+сам)?|полный\s+цикл|от\s+начала\s+до\s+конца|вс[её]\s+под\s+ключ)/,
      steps: [{ tool: 'audit_cloud', args: {} }, { tool: 'clean_cloud', args: { thoroughness: 'auto' } }, { tool: 'run_command', args: { id: 'cpInspect' } }, { tool: 'export_result', args: { format: 'pdf' } }, { tool: 'run_command', args: { id: 'lxScan2BimBtn' } }] }
  ];
  // r43: короткие фразы → команды программы (для цепочек «сделай X, потом Y»)
  var PHRASES = [
    [/(провер\S*|контрол\S*)\s+(геометри|стен\S* и пол|ровност|плоскост)|контроль геометрии/, 'cpInspect'],
    [/(обмерн\S*\s+план|план\S*\s+(помещени|этаж|из облака|в dxf)|план dxf)/, 'cpPlanDxf'],
    [/(раскрась|цвет\S*\s+по\s+фото|настоящ\S*\s+цвет)/, 'opPhotoColor'],
    [/(чистов\S*\s+обработк|сведи\s+проход|убери\s+двоени)/, 'opRefineScan'],
    [/(движущ\S*|прохож\S*|машин\S*)\s*(объект)?/, 'opDynClean'],
    [/(прорежи|уменьши\s+плотност|ресэмпл)/, 'opResample'],
    [/(\bmesh\b|меш|полигональн\S*|поверхност\S*\s+obj|треугольн\S*\s+сетк|построй\s+сетку|сетк\S*\s+(по|из)\s+облак)/, 'opMesh'],
    [/(рельеф|dtm|цмр)/, 'opDTM'],
    [/(\bifc\b|ифц)(?!.*(труб|балк|mep))/, 'opIFC4'],
    [/(отчет|отчёт)\s+(по\s+)?облак/, 'cpReport'],
    [/(об[ъь][её]м)/, 'opVolume'],
    [/(\bbim\b|бим)/, 'lxScan2BimBtn']
  ];
  function phraseStep(part, ctx) {
    var low = part.toLowerCase().replace(/ё/g, 'е'), list = commandList(ctx);
    for (var i = 0; i < PHRASES.length; i++) if (PHRASES[i][0].test(low)) {
      var id = PHRASES[i][1];
      if (list.length && !list.some(function (c) { return c.id === id; })) continue;
      return { tool: 'run_command', args: { id: id } };
    }
    return null;
  }
  var RX_CHAIN = /\s*(?:,|;)?\s*(?:а\s+)?(?:потом|затем|после\s+этого|после\s+чего|далее|в\s+конце|и\s+наконец)\s+|\s*;\s*|\s+и\s+(?=(?:сделай|запусти|проверь|почисти|очисти|сохрани|экспортируй|выгрузи|построй|покажи|раскрась|прорежи|создай|сформируй)\S*)|,\s+(?=(?:сделай|запусти|проверь|почисти|очисти|сохрани|экспортируй|выгрузи|построй|покажи|раскрась|прорежи|создай|сформируй)\S*)/;
  function stepOf(part, ctx) {
    var a = planAction(part, ctx, true);
    if (a && PLAN_TOOLS[a.name]) return { tool: a.name, args: a.args };
    var low = part.toLowerCase().replace(/ё/g, 'е');
    if (/(отчет|отчёт|pdf|пдф)/.test(low) && !/облак/.test(low)) return { tool: 'export_result', args: { format: 'pdf' } };
    if (/(csv|excel|эксел|таблиц)/.test(low)) return { tool: 'export_result', args: { format: 'csv' } };
    if (/(провер|оцени)\S*\s+(качеств|облак)/.test(low) && ctx && ctx.auditCloud) return { tool: 'audit_cloud', args: {} };
    return phraseStep(part, ctx);
  }
  function chainSteps(q, ctx) {
    var parts = String(q).split(RX_CHAIN).filter(function (x) { return x && x.trim().length > 2; });
    if (parts.length < 2) return null;
    var steps = [];
    for (var i = 0; i < parts.length; i++) { var st = stepOf(parts[i], ctx); if (!st) return null; steps.push(st); }
    return steps;
  }
  function planAction(question, ctx, single) {
    var q = String(question || ''), low = q.toLowerCase().replace(/ё/g, 'е');
    if (!single) {
      var askW = /^(как|где|что|зачем|почему|можно ли|что такое)(?=\s|$)/.test(low.trim());
      // «запомни навык «X»: шаг, потом шаг» / «запомни последние действия как навык X»
      var ms = /^\s*(?:пожалуйста[, ]+)?(?:запомни|сохрани|создай|выучи)\s+(?:как\s+)?(?:навык|сценарий|макрос|процедуру)\s*[«"']?([^»"':]{2,60}?)[»"']?\s*[:—-]\s*(.+)$/i.exec(q);
      if (ms && ctx && ctx.memory && ctx.memory.addSkill) { var ss = chainSteps(ms[2], ctx) || (function () { var o1 = stepOf(ms[2], ctx); return o1 ? [o1] : null; })(); if (ss) return { name: 'save_skill', args: { name: ms[1].trim(), steps: ss } }; }
      var ml = /(?:запомни|сохрани)\s+(?:последн\S*|эти|мои)\s+(?:действия|шаги)\s+как\s+(?:навык\s+)?[«"']?([^»"']{2,60})[»"']?/i.exec(q);
      if (ml && ctx && ctx.memory && ctx.memory.addSkill) return { name: 'save_skill', args: { name: ml[1].trim(), from_last: true } };
      if (!askW && ctx && ctx.memory && ctx.memory.findSkill && /(выполни|сделай|запусти|примени|повтори)/.test(low)) {
        var sk = ctx.memory.findSkill(q); if (sk) return { name: 'run_skill', args: { name: sk.name } };
      }
      if (!askW) {
        for (var wi = 0; wi < WORKFLOWS.length; wi++) if (WORKFLOWS[wi].rx.test(low) && /(сделай|проведи|выполни|запусти|построй|создай|собери|прими|приемк|приёмк|цикл)/.test(low) && ctx && ctx.cleanCloud) {
          return { name: 'run_plan', args: { title: WORKFLOWS[wi].title, steps: WORKFLOWS[wi].steps.filter(function (st) { return st.tool !== 'audit_cloud' || ctx.auditCloud; }).map(function (st) { return { tool: st.tool, args: Object.assign({}, st.args) }; }), workflow: WORKFLOWS[wi].id } };
        }
        var ch = chainSteps(q, ctx); if (ch) return { name: 'run_plan', args: { steps: ch } };
      }
    }
    // «как профи», «как обычно», «как в прошлый раз» — это манера выполнения, а не вопрос «как сделать»
    var lowAsk = low.replace(/как\s+(профи|профессионал\S*|инженер\S*|специалист\S*|обычно|раньше|всегда|в прошлый раз|в тот раз)/g, ' ');
    var ask = /(как |где |можно ли|что будет|зачем|почему|что значит|что такое|надо ли|стоит ли|что делает)/.test(lowAsk);
    // r42: «почисти облако [до мелочей]» — чистка с предпросмотром; глубина — из просьбы или из того, что пользователь выбирал раньше
    if (RX_CLEAN.test(low) && !ask && !/(кэш|истори|памят|чат|переписк)/.test(low) && ctx && ctx.cleanCloud) {
      var th = /(до мелоч|полност|тщательн|идеальн|по максимуму|максимальн|глубок|подчист|все до|всё до|от всего|начисто|дочиста|все лишнее|весь мусор)/.test(low) ? 'deep'
        : /(быстр|слегка|немного|чуть|мягк|только шум)/.test(low) ? 'quick'
        : /(сам\S*\s+(реши|выбери)|на\s+(сво[её]|тво[её])\s+усмотрени|как\s+(профи|профессионал|инженер)|умно|автоматич)/.test(low) && ctx.auditCloud ? 'auto'
        : (ctx.memory && ctx.memory.best ? String(ctx.memory.best('clean.level', ctx.auditCloud ? 'auto' : 'normal')) : (ctx.auditCloud ? 'auto' : 'normal'));
      var args = { thoroughness: CLEAN_TEXT[th] ? th : 'normal' };
      if (/(выровн|сгладь|ровн\S* плоскост|утюж)/.test(low)) args.flatten_surfaces = true;
      if (/(людей не|не (удаляй|трогай) людей|без удаления людей|оставь людей)/.test(low)) args.people = 'off';
      return { name: 'clean_cloud', args: args };
    }
    // «запомни, что …» — сразу в память (это не действие с облаком, подтверждение не нужно)
    if (/^\s*(пожалуйста[, ]+)?(запомни|запиши себе|учти на будущее|имей в виду|на будущее)/.test(low) && ctx && ctx.memory && ctx.memory.add) {
      var fr = ctx.memory.parse ? ctx.memory.parse(q) : null;
      if (fr && fr.text) return { name: 'remember', args: { text: fr.text, kind: fr.kind } };
    }
    if (/(включи|запусти|начни)\s+(режим\s+)?(выбор|«?что это)/.test(low) && ctx && ctx.pickElement) return { name: 'pick_element', args: {} };
    // r43: «обнови базы / установи обновления норм» — установка скачанных выпусков (с подтверждением)
    if (!ask && /(обнови|установи|скачай|подтяни)\S*\s+(?:все\s+|свои\s+)?(?:обновлени\S*\s+)?(баз|норм|знани|справк|обновлени)/.test(low) && ctx && ctx.updates && ctx.updates.install) return { name: 'install_updates', args: {} };
    // r43: одна команда программы словами («раскрась облако по фото», «прорежи облако», «построй сетку»)
    if (!ask && /(раскрась|построй|прорежи|сведи|убери|сделай|создай|запусти|выполни|уменьши)/.test(low) && !/(сохрани|выгрузи|экспорт|(труб|балк|короб|инженер|mep)\S*.*(ifc|dxf))/.test(low)) {
      var ps = phraseStep(q, ctx); if (ps && !/(отчет|pdf|пдф|csv|excel)/.test(low.replace(/отчет\S*\s+(по\s+)?облак\S*/, ''))) return { name: 'run_command', args: ps.args };
    }
    if (!RX_DO.test(low) || /(как |где |можно ли|что будет)/.test(lowAsk)) return null;
    if (/(сохрани|выгрузи|экспорт|сделай|сформируй|создай)/.test(low)) {
      if (/(pdf|пдф|отчет)/.test(low)) return { name: 'export_result', args: { format: 'pdf' } };
      if (/(csv|excel|эксел|таблиц)/.test(low)) return { name: 'export_result', args: { format: 'csv' } };
      if (/ifc/.test(low) && /(труб|балк|короб|инженер|mep)/.test(low)) return { name: 'export_result', args: { format: 'mep_ifc' } };
      if (/dxf/.test(low) && /(труб|балк|короб|инженер|mep)/.test(low)) return { name: 'export_result', args: { format: 'mep_dxf' } };
    }
    if (/(покажи|открой|выдели|перейди)/.test(low)) {
      var w = /стен\S*\s*(?:№|номер)?\s*(\d{1,3})/.exec(low); if (w) return { name: 'show_result', args: { tab: 'walls', wall: +w[1] } };
      var tabs = [['def', /(дефект|бугр|впадин)/], ['open', /(проем|двер|окн)/], ['mep', /(труб|балк|короб)/], ['dxf', /(dxf|с проектом|сравнени)/], ['floor', /(^|[^а-я])пол([^а-я]|$)|пола/], ['walls', /стен/]];
      for (var i = 0; i < tabs.length; i++) if (tabs[i][1].test(low)) {
        var n = /(?:№|номер|строк\S*)\s*(\d{1,3})/.exec(low);
        return { name: 'show_result', args: n && tabs[i][0] !== 'walls' && tabs[i][0] !== 'floor' ? { tab: tabs[i][0], item: +n[1] } : { tab: tabs[i][0] } };
      }
      if (/(результат|окно контроля)/.test(low)) return { name: 'show_result', args: {} };
    }
    if (/(запусти|выполни|включи|открой)/.test(low) && ctx) {
      var best = null;
      commandList(ctx).forEach(function (c) { var lab = String(c.label || '').toLowerCase().replace(/ё/g, 'е'); if (lab.length >= 5 && low.indexOf(lab) >= 0 && (!best || lab.length > best.l)) best = { id: c.id, l: lab.length }; });
      if (best) return { name: 'run_command', args: { id: best.id } };
    }
    return null;
  }

  // проверка цифр: каждое число с единицей измерения в ответе должно найтись в данных инструментов, вопросе или подсказке
  var RX_UNIT = /(-?\d+(?:[.,]\d+)?)\s*(мм\/м|мм|м²|м2|м³|м3|м\b|м(?=[\s.,;:)]|$)|%|°|см)/g;
  function numbersIn(text) { var out = [], m, re = /-?\d+(?:[.,]\d+)?/g; text = String(text || ''); while ((m = re.exec(text))) out.push(parseFloat(m[0].replace(',', '.'))); return out; }
  function ungrounded(text, sourceText) {
    var src = numbersIn(sourceText), bad = [], m, seen = {};
    RX_UNIT.lastIndex = 0;
    while ((m = RX_UNIT.exec(String(text || '')))) {
      var raw = m[1], v = parseFloat(raw.replace(',', '.')), dec = (raw.split(/[.,]/)[1] || '').length, key = raw + m[2];
      if (!isFinite(v) || seen[key]) continue; seen[key] = 1;
      var p = Math.pow(10, dec), ok = src.some(function (x) {
        var c = [x, x * 1000, x / 1000, x * 100, Math.abs(x)];
        return c.some(function (y) { return Math.abs(Math.round(y * p) / p - v) < 1e-9 || Math.abs(y - v) <= 0.011; });
      });
      if (!ok) bad.push(raw.replace('.', ',') + ' ' + m[2]);
    }
    return bad;
  }
  function sourcesOf(messages) { return messages.filter(function (m) { return !m._fix && (m.role === 'tool' || m.role === 'user' || m.role === 'system'); }).map(function (m) { return m.content || ''; }).join('\n'); }

  // r35: ответ по базе норм без названия документа — дописать источник (небольшие модели часто его опускают)
  function docKey(cite) {
    var m = /^(СП|ГОСТ(?:\s+Р)?|СНиП|ACI|ASTM)\s*([\dA-Z]+)/i.exec(String(cite || '').trim());
    if (m) return (m[1] + ' ' + m[2]).replace(/\s+/g, ' ');
    var f = /(\d+)-ФЗ/.exec(String(cite || '')); return f ? f[0] : '';
  }
  function normCites(messages) {
    var out = [];
    messages.forEach(function (m) {
      if (m.role !== 'tool' || m.tool_name !== 'search_norms') return;
      var j; try { j = JSON.parse(m.content); } catch (_) {
        // обрезанный JSON (больше 6000 знаков) — достать цитаты регулярным выражением
        var re = /"cite":"((?:[^"\\]|\\.)*)"(?:,"source":"((?:[^"\\]|\\.)*)")?(?:,"text":"((?:[^"\\]|\\.)*)")?/g, mm;
        while ((mm = re.exec(m.content))) out.push({ cite: mm[1].replace(/\\"/g, '"'), source: mm[2] || '', text: mm[3] || '' });
        return;
      }
      (j && j.results || []).forEach(function (r) { if (r && r.cite) out.push(r); });
    });
    return out;
  }
  function withSource(text, messages) {
    var cs = normCites(messages);
    if (!text || !cs.length) return text;
    var flat = String(text).replace(/[\s\u00a0]+/g, ' ').toLowerCase();
    if (cs.some(function (r) { var k = docKey(r.cite); return k && flat.indexOf(k.toLowerCase()) >= 0; })) return text;
    var nums = flat.match(/\d+(?:[.,]\d+)?/g) || [];
    var best = cs[0], bs = -1;
    cs.forEach(function (r) { var t = String(r.text || '').replace(/[\s\u00a0]+/g, ' '); var sc = nums.filter(function (n) { return t.indexOf(n) >= 0; }).length; if (sc > bs) { bs = sc; best = r; } });
    return text + '\n\nИсточник: ' + best.cite + (best.source === 'встроенная база' ? ' (встроенная база, сверить с действующей редакцией)' : '') + '.';
  }
  async function runAgent(o) {
    var ctx = o.ctx || {}, emit = o.onEvent || function () {}, maxSteps = o.maxSteps || 6, used = [];
    var umsg = { role: 'user', content: String(o.question || '') };
    if (Array.isArray(o.images) && o.images.length) { umsg.images = o.images.slice(0, 2); umsg.content += '\n(Приложен снимок текущего вида программы.)'; }
    var messages = [{ role: 'system', content: systemPrompt(ctx) }];
    // r42: опыт пользователя, похожий на вопрос, — отдельным системным сообщением (_fix: его числа не считаются данными объекта)
    var memText = ''; try { memText = ctx.memory && ctx.memory.block ? String(ctx.memory.block(o.question) || '') : ''; } catch (_) {}
    if (memText) { messages.push({ role: 'system', _fix: true, content: memText.slice(0, 6000) }); emit({ type: 'memory', text: memText }); }
    messages = messages.concat(trimHistory(o.history, o.maxTurns), [umsg]);
    if (o.prefetch !== false) {
      var pre = planTools(o.question, ctx);
      if (pre.length) {
        messages.push({ role: 'assistant', content: '', tool_calls: pre.map(function (p) { return { function: { name: p.name, arguments: p.args } }; }) });
        for (var pi = 0; pi < pre.length; pi++) {
          emit({ type: 'tool', name: pre[pi].name, args: pre[pi].args, action: false, prefetch: true });
          var pr = await execTool(pre[pi].name, pre[pi].args, ctx);
          used.push({ name: pre[pi].name, args: pre[pi].args, ok: pr && pr.ok !== false, prefetch: true });
          emit({ type: 'tool_result', name: pre[pi].name, result: pr });
          var pj = JSON.stringify(pr); if (pj.length > 6000) pj = pj.slice(0, 6000) + '…';
          messages.push({ role: 'tool', tool_name: pre[pi].name, content: pj });
        }
      }
    }
    var done = {};
    var act = o.actions !== false ? planAction(o.question, ctx) : null;
    if (act) {
      emit({ type: 'tool', name: act.name, args: act.args, action: !!ACTIONS[act.name], planned: true });
      var ar = await execTool(act.name, act.args, ctx);
      used.push({ name: act.name, args: act.args, ok: ar && ar.ok !== false, planned: true });
      emit({ type: 'tool_result', name: act.name, result: ar });
      done[act.name] = 1;
      messages.push({ role: 'assistant', content: '', tool_calls: [{ function: { name: act.name, arguments: act.args } }] });
      messages.push({ role: 'tool', tool_name: act.name, content: JSON.stringify(ar) });
    }
    var fixed = false;
    for (var step = 0; step < maxSteps; step++) {
      if (o.signal && o.signal.aborted) return { text: '', cancelled: true, messages: messages, tools: used, steps: step };
      var resp = await o.chat({ messages: messages, tools: toolsFor(ctx), think: o.think, onDelta: function (d) { emit({ type: 'delta', step: step, content: d.content || '', thinking: d.thinking || '' }); }, signal: o.signal });
      var msg = (resp && resp.message) || { role: 'assistant', content: '' };
      var calls = msg.tool_calls && msg.tool_calls.length ? msg.tool_calls : inlineToolCalls(msg.content);
      if (!calls.length) {
        var text = stripThink(msg.content);
        if (!text && step < maxSteps - 1) { messages.push({ role: 'assistant', content: '' }); messages.push({ role: 'user', content: 'Ответь пользователю по-русски по полученным данным.' }); continue; }
        var bad = o.ground !== false ? ungrounded(text, sourcesOf(messages)) : [];
        if (bad.length && !fixed && step < maxSteps - 1) {
          fixed = true; emit({ type: 'retry', reason: 'ungrounded', values: bad });
          messages.push({ role: 'assistant', content: text });
          messages.push({ role: 'user', _fix: true, content: 'В ответе есть значения, которых нет в данных инструментов: ' + bad.slice(0, 8).join('; ') + '. Перепиши ответ, используя только числа из результатов инструментов (можно вызвать нужный инструмент). Если данных нет — так и скажи.' });
          continue;
        }
        if (bad.length) {
          var off = offlineAnswer(o.question, ctx);
          if (off && off.text && off.tools && off.tools.length && /^(get_|calculate)/.test(off.tools[0])) text = off.text;
          else text += '\n\nПроверьте цифры: ' + bad.slice(0, 5).join(', ') + ' — этих значений нет в данных программы.';
        }
        if (o.cite !== false) text = withSource(text, messages);
        messages.push({ role: 'assistant', content: text });
        emit({ type: 'final', text: text });
        return { text: text, messages: messages, tools: used, steps: step + 1, stats: resp && resp.stats };
      }
      messages.push({ role: 'assistant', content: msg.tool_calls ? (msg.content || '') : '', tool_calls: calls });
      for (var k = 0; k < calls.length && k < 6; k++) {
        var c = calls[k].function || calls[k], name = c.name, args = c.arguments || {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { args = {}; } }
        emit({ type: 'tool', name: name, args: args, action: !!ACTIONS[name] });
        var result = (ACTIONS[name] || name === 'remember') && done[name] ? { ok: true, duplicate: true, message: 'Это действие уже выполнено выше — не повторяй, ответь пользователю.' } : await execTool(name, args, ctx);
        if (ACTIONS[name] || name === 'remember') done[name] = 1;
        used.push({ name: name, args: args, ok: result && result.ok !== false });
        emit({ type: 'tool_result', name: name, result: result });
        var img = result && result._image; if (img) { result = Object.assign({}, result); delete result._image; }
        var js = JSON.stringify(result); if (js.length > 6000) js = js.slice(0, 6000) + '…';
        messages.push({ role: 'tool', tool_name: name, content: js });
        if (img) messages.push({ role: 'user', _fix: true, content: 'Снимок текущего вида программы.', images: [img] });
      }
    }
    // шаги кончились — последний ответ без инструментов
    var fin = await o.chat({ messages: messages.concat([{ role: 'user', content: 'Сформулируй ответ по уже полученным данным, без новых вызовов.' }]), tools: [], think: false, signal: o.signal,
      onDelta: function (d) { emit({ type: 'delta', step: maxSteps, content: d.content || '' }); } });
    var ft = stripThink(fin && fin.message && fin.message.content);
    if (o.cite !== false) ft = withSource(ft, messages);
    emit({ type: 'final', text: ft });
    return { text: ft, messages: messages, tools: used, steps: maxSteps + 1 };
  }

  // ------------------------------------------------------------------ простой режим (без модели)
  var INTENTS = [
    { re: /(что ты|что умеешь|кто ты|помощь|help)/i, run: function () { return { text: 'Я — локальный ассистент BIM Twin. Отвечаю по результатам «Контроля геометрии» (стены, пол, дефекты, проёмы, балки и трубы, сравнение с DXF), подсказываю, где команда и что значат показатели, считаю. Сейчас модель не готова — работаю в простом режиме по шаблонам; полный режим включится сам после установки модели.', tools: [] }; } },
    { re: /(посчита|сколько будет|вычисл|^[\d\s.,+\-*/^()%]+$)/i, run: function (q) { var ex = q.replace(/^[^\d(-]*/, '').replace(/[=?]+\s*$/, '').replace(/(\d)\s*(?:м|мм|см)?\s*(?:на|x|х|×)\s*(\d)/gi, '$1*$2').replace(/\s*(м²|м2|м|мм|см|шт)\.?\s*$/i, ''); var c = calculate(ex); return c.ok ? { text: ex.trim() + ' = ' + ru(c.result, Math.abs(c.result) < 100 ? 3 : 1).replace(/,?0+$/, ''), tools: ['calculate'] } : null; } },
    { re: /(где|как найти|кнопк|какая команда|в каком меню|на какой вкладке)/i, run: function (q, ctx) {
      var f = findCommand(ctx, { query: q }), h = searchHelp(ctx, { query: q }).results[0];
      if (f.commands.length) return { text: 'Похоже, вам нужно: ' + f.commands.slice(0, 3).map(function (c) { return c.path + (c.tip ? ' — ' + c.tip : ''); }).join('\n'), tools: ['find_command'] };
      return h ? { text: h.title + ': ' + h.text, tools: ['search_help'] } : null; } },
    { re: /(дефект|бугор|бугры|впадин|вмятин|выступ)/i, data: 1, run: function (q, ctx) {
      var d = getDefects(ctx, { limit: 5 }); if (!d.ok) return { text: d.message, tools: ['get_defects'] };
      return { text: 'Местные дефекты (больше 5 мм): ' + d.total + ' — на полу ' + d.floor + ', на стенах ' + d.walls + ', общая площадь ' + ru(d.total_area_m2, 1) + ' м².' + (d.defects.length ? '\nСамые глубокие: ' + d.defects.map(function (x) { return x.kind + ' ' + ru(x.depth_mm, 0) + ' мм, ' + ru(x.area_m2, 2) + ' м² (' + x.where + (x.room ? ', ' + x.room : '') + ')'; }).join('; ') + '.' : ''), tools: ['get_defects'] }; } },
    { re: /(труб|балк|короб|воздуховод|лот(о|к)|высот\S* в свету|под потолк|инженерн)/i, data: 1, run: function (q, ctx) {
      var m = getMep(ctx, { filter: 'all', limit: 5 }); if (!m.ok) return { text: m.message, tools: ['get_mep'] };
      var kinds = Object.keys(m.by_kind).map(function (k) { return k + ' ' + m.by_kind[k].count + ' (' + ru(m.by_kind[k].length_m, 0) + ' м)'; }).join(', ');
      return { text: 'Под потолком найдено ' + m.total + ': ' + (kinds || 'нет') + '. Наименьший низ над полом ' + ru(m.min_clear_m, 2) + ' м; ниже ' + ru(m.clear_limit_m, 2) + ' м — ' + m.below_limit + '.' +
        (m.pipe_diameters.length ? '\nТрубы: ' + m.pipe_diameters.map(function (d) { return 'Ø' + d.d_mm + ' — ' + ru(d.length_m, 1) + ' м'; }).join(', ') + '.' : ''), tools: ['get_mep'] }; } },
    { re: /(проём|проем|двер|окн)/i, data: 1, run: function (q, ctx) {
      var o = getOpenings(ctx, {}); if (!o.ok) return { text: o.message, tools: ['get_openings'] };
      return { text: 'Проёмы: дверей ' + o.doors + ', окон ' + o.windows + (o.closed ? ', закрытых ' + o.closed : '') + '; без перемычки ' + o.no_lintel + '. Высота двери (медиана) ' + ru(o.door_head_median_m, 2) + ' м.', tools: ['get_openings'] }; } },
    { re: /(dxf|проект|чертёж|чертеж)/i, data: 1, run: function (q, ctx) {
      var c = getCompare(ctx, {}); if (!c.ok) return null;
      return { text: 'Сравнение с проектом: ' + c.lines + ' линий — ' + Object.keys(c.by_status).map(function (k) { return k + ' ' + c.by_status[k]; }).join(', ') + '.' + (c.worst.length ? '\nХудшие: ' + c.worst.slice(0, 4).map(function (x) { return '№' + x.number + ' (' + x.layer + ') ' + x.status + ', ' + ru(x.offset_mm, 1) + ' мм'; }).join('; ') + '.' : ''), tools: ['get_dxf_compare'] }; } },
    { re: /((^|[^а-яё])пол([^а-яё]|$)|пола|полу|\bff\b|\bfl\b|ровност|горизонтальн|уклон|стяжк|рейк)/i, data: 1, run: function (q, ctx) {
      var f = getFloor(ctx, {}); if (!f.ok) return { text: f.message, tools: ['get_floor'] };
      return { text: 'Пол ' + ru(f.area_m2, 0) + ' м²: FF ' + ru(f.FF, 1) + ' / FL ' + ru(f.FL, 1) + ' — ' + f.FF_class + '; уклон ' + ru(f.slope_mm_per_m, 2) + ' мм/м. Рейка 2 м: наибольший просвет ' + ru(f.rail.max_gap_mm, 1) + ' мм, больше ' + f.rail.tolerance_mm + ' мм — ' + ru(f.rail.share_over_tolerance_pct, 1) + ' % мест.' + (f.cloud_tilt && f.cloud_tilt.applied ? ' Наклон облака ' + ru(f.cloud_tilt.mm_per_m, 2) + ' мм/м учтён.' : ''), tools: ['get_floor'] }; } },
    { re: /(стен|вертикал|завал|отвес)/i, data: 1, run: function (q, ctx) {
      var w = getWalls(ctx, { filter: 'bad', limit: 5 }); if (!w.ok) return { text: w.message, tools: ['get_walls'] };
      var t = 'Стены: проверено ' + w.checked + ', вне допуска ' + w.out_of_tolerance + ' (вертикаль ' + w.plumb_fail + ', неровность ' + w.rail_fail + '). Допуск (' + w.finish_class + '): ' + w.tolerance.plumb_mm_per_m + ' мм/м, до ' + w.tolerance.plumb_max_mm + ' мм, рейка ' + w.tolerance.rail_mm + ' мм.';
      if (w.walls.length) t += '\nХуже всех: ' + w.walls.map(function (x) { return '№' + x.number + ' — завал ' + ru(x.lean_mm, 1) + ' мм (' + ru(x.plumb_mm_per_m, 2) + ' мм/м), рейка ' + ru(x.rail_mm, 1) + ' мм'; }).join('; ') + '.';
      t += '\nМедиана: вертикаль ' + ru(w.median_plumb_mm_per_m, 2) + ' мм/м, рейка ' + ru(w.median_rail_mm, 1) + ' мм.';
      return { text: t, tools: ['get_walls'] }; } },
    { re: /(итог|сводк|результат|вывод|что с объект|общ(ая|ий) картин|как дела)/i, data: 1, run: function (q, ctx) {
      var ov = getOverview(ctx); if (!ov.inspection) return { text: NO_INSPECTION.message, tools: ['get_overview'] };
      return { text: 'Итог контроля (' + ov.inspection.file + '):\n' + ov.inspection.summary.join('\n'), tools: ['get_overview'] }; } }
  ];
  function offlineAnswer(question, ctx) {
    var q = String(question || '').trim();
    for (var i = 0; i < INTENTS.length; i++) {
      if (!INTENTS[i].re.test(q)) continue;
      var a = INTENTS[i].run(q, ctx); if (a) return Object.assign({ offline: true }, a);
    }
    var h = searchHelp(ctx, { query: q }).results;
    if (h.length) return { offline: true, text: h[0].title + ': ' + h[0].text, tools: ['search_help'] };
    return { offline: true, text: 'В простом режиме я понимаю вопросы о стенах, поле, дефектах, проёмах, балках и трубах, сравнении с проектом и где найти команду. Полный режим включится, когда будет готова локальная модель.', tools: [] };
  }

  // простой режим (модель ещё не готова): вопрос о нормах — ответ выдержками из базы норм с цитатами
  async function offlineNorms(question, ctx) {
    var q = String(question || '').trim();
    if (!q || !RX.norms.test(q) || !ctx || !ctx.searchNorms) return null;
    var dh = /(СП|ГОСТ(?:\s+Р)?|СНиП)\s*(\d{1,3}(?:\.\d{1,5})?)/i.exec(q);
    var r = await searchNorms(ctx, { query: q, doc: dh ? dh[1] + ' ' + dh[2] : undefined });
    if (!r.ok) return null;
    if (!r.results.length) return { offline: true, text: 'В базе норм ничего не нашлось по этому вопросу. Добавьте нужный СП или ГОСТ в «База норм» (кнопка с книгой) — поиск по нему заработает сразу.', tools: ['search_norms'] };
    var top = r.results.slice(0, 2).map(function (x) { var t = x.text.replace(/\s+/g, ' '); return '• ' + x.cite + (x.source === 'встроенная база' ? ' (кратко)' : '') + ': ' + (t.length > 420 ? t.slice(0, 420) + '…' : t); });
    return { offline: true, text: 'Нашёл в базе норм:\n' + top.join('\n') + (r.note ? '\n' + r.note : ''), tools: ['search_norms'], cites: r.results.map(function (x) { return x.cite; }), src: r._src };
  }

  // реестр ленты (renderer/ui/commands.js) → плоский список для find_command / run_command
  function flattenCommands(C, state) {
    var out = [];
    ((C && C.TABS) || []).forEach(function (t) { (t.groups || []).forEach(function (g) { (g.items || []).forEach(function (it) {
      if (!it || !it.id || it.special) return;
      var label = it.label || (state && state.label ? state.label(it) : '') || it.id, en = state && state.enabled ? state.enabled(it) : true;
      out.push({ id: it.id, label: String(label), tab: t.label, group: g.label, tip: it.tip || '', needs: it.needs || '', enabled: en !== false, why: en === false && it.needs === 'cloud' ? 'сначала откройте облако точек' : '' });
    }); }); });
    return out;
  }

  return { WORKFLOWS: WORKFLOWS, PLAN_TOOLS: PLAN_TOOLS, normSteps: normSteps, chainSteps: chainSteps, lastActions: lastActions, clearActions: clearActions, stepText: stepText, TOOLS: TOOLS, toolsFor: toolsFor, withSource: withSource, offlineNorms: offlineNorms, searchNorms: searchNorms, flattenCommands: flattenCommands, planTools: planTools, planAction: planAction, ungrounded: ungrounded, ACTIONS: ACTIONS, toolNames: toolNames, execTool: execTool, runAgent: runAgent, offlineAnswer: offlineAnswer, calculate: calculate,
    inlineToolCalls: inlineToolCalls, stripThink: stripThink, snapshot: snapshot, systemPrompt: systemPrompt, describeAction: describeAction, trimHistory: trimHistory,
    _get: { walls: getWalls, floor: getFloor, defects: getDefects, openings: getOpenings, mep: getMep, compare: getCompare, overview: getOverview } };
});
