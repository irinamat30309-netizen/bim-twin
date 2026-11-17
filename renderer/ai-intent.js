/*
 * ai-intent.js — r169: локальный интент-парсер ИИ-ассистента (рус/укр), работает без API/модели.
 *
 * parse(text) → { intent, confidence, params, actions, raw } — понимает «что это за элемент»,
 * «это стена?», «какая толщина», «сколько площадь», «найди двери», «сверь с документацией»,
 * «построй документ», «это труба?», украинские фразы («що це таке?», «яка товщина стіни?»).
 * execute(parsed, ctx) → ответ ТОЛЬКО по фактам из ctx (renderer/ai-context.js): если данных нет —
 * честное «не знаю» и ближайшие доступные действия, без выдумывания.
 * Если нужен анализ выделения, возвращает {handled:false, need:'analyze-selection'} — UI дообогащает контекст.
 *
 * UMD: window.AiIntent и module.exports.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AiIntent = api;
})(typeof window !== 'undefined' ? window : null, function (W) {
  'use strict';
  var VERSION = '169';
  function q(s) { return String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').replace(/[’']/g, '').replace(/\s+/g, ' ').trim(); }
  function rx(s) { return new RegExp(s, 'i'); }
  function fmt(v, d) { if (v == null || !isFinite(Number(v))) return '—'; return Number(v).toLocaleString('ru-RU', { maximumFractionDigits: d == null ? 2 : d }); }
  function has(v) { return v !== undefined && v !== null && v !== ''; }

  var TARGETS = [
    { type: 'wall', label: 'стены', re: rx('(^|[^а-яa-z])(стен[а-я]*|стін[а-я]*|перегородк[а-я]*|стіна|стіни|стіну|стіною)([^а-яa-z]|$)') },
    { type: 'floor', label: 'пола', re: rx('(^|[^а-яa-z])(пол[а-я]*|підлог[а-я]*|підлога|підлоги)([^а-яa-z]|$)') },
    { type: 'ceiling', label: 'потолка', re: rx('(^|[^а-яa-z])(потол[а-я]*|стел[а-я]*|стеля|стелі)([^а-яa-z]|$)') },
    { type: 'pipe', label: 'трубы', re: rx('(^|[^а-яa-z])(труб[а-я]*|трубою)([^а-яa-z]|$)') },
    { type: 'duct', label: 'воздуховода', re: rx('(^|[^а-яa-z])(воздуховод[а-я]*|короб[а-я]*|лот[а-як]*)([^а-яa-z]|$)') },
    { type: 'beam', label: 'балки', re: rx('(^|[^а-яa-z])(балк[а-я]*)([^а-яa-z]|$)') },
    { type: 'column', label: 'колонны', re: rx('(^|[^а-яa-z])(колонн[а-я]*|столб[а-я]*)([^а-яa-z]|$)') },
    { type: 'door', label: 'двери', re: rx('(^|[^а-яa-z])(двер[а-яіь]*|двері|двери)([^а-яa-z]|$)') },
    { type: 'window', label: 'окна', re: rx('(^|[^а-яa-z])(окн[а-я]*|окон|вікн[а-я]*|вікно)([^а-яa-z]|$)') },
    { type: 'opening', label: 'проёмы', re: rx('(^|[^а-яa-z])(проем[а-я]*|проём[а-я]*|проріз[а-я]*)([^а-яa-z]|$)') },
    { type: 'furniture', label: 'мебель', re: rx('(^|[^а-яa-z])(мебел[а-я]*|стол|стул|диван|шкаф)([^а-яa-z]|$)') },
    { type: 'room', label: 'помещения', re: rx('(^|[^а-яa-z])(помещен[а-я]*|кімнат[а-я]*|комнат[а-я]*)([^а-яa-z]|$)') }
  ];
  var DIMENSIONS = [
    { key: 'thickness', label: 'толщина', re: rx('(толщин|товщин|толщину|толщиной)') },
    { key: 'height', label: 'высота', re: rx('(высот|висот|висота)') },
    { key: 'length', label: 'длина', re: rx('(длин[а-я]*|довжин[а-я]*)') },
    { key: 'width', label: 'ширина', re: rx('(ширин[а-я]*|ширш[а-я]*)') },
    { key: 'area', label: 'площадь', re: rx('(площад[а-я]*|площ[а-я]*|площа)') },
    { key: 'volume', label: 'объём', re: rx('(объем|объём|обєм|об’єм)') },
    { key: 'diameter', label: 'диаметр', re: rx('(диаметр[а-я]*|діаметр[а-я]*)') },
    { key: 'section', label: 'сечение', re: rx('(сечен[а-я]*|перетин[а-я]*)') },
    { key: 'clear', label: 'высота в свету', re: rx('(высот[а-я]* в свету|в свету|висот[а-я]* у світлі)') },
    { key: 'plumb', label: 'отклонение от вертикали', re: rx('(отклонени[а-я]*|завал[а-я]*|відхиленн[а-я]*|вертикал[а-я]*)') },
    { key: 'dims', label: 'размеры', re: rx('(размер[а-я]*|габарит[а-я]*|розмір[а-я]*)') }
  ];
  var DOC_WORDS = { 'сп': 'СП', 'гост': 'ГОСТ', 'снип': 'СНиП', 'тз': 'ТЗ', 'проект': 'проект', 'документац': 'документация' };
  var TYPE_LABEL = {
    wall: 'стена', partition: 'перегородка', floor: 'пол', ceiling: 'потолок', roof: 'крыша',
    column: 'колонна', beam: 'балка', pipe: 'труба', duct: 'воздуховод', tray: 'лоток',
    opening: 'проём', door: 'дверь', window: 'окно', furniture: 'мебель', object: 'объект',
    surface: 'поверхность', room: 'помещение', slab: 'плита', vegetation: 'растительность', people: 'люди', unknown: 'не определён'
  };

  function detectTarget(t) {
    for (var i = 0; i < TARGETS.length; i++) if (TARGETS[i].re.test(t)) return { type: TARGETS[i].type, label: TARGETS[i].label };
    return null;
  }
  function detectDimension(t) {
    for (var i = 0; i < DIMENSIONS.length; i++) if (DIMENSIONS[i].re.test(t)) return { key: DIMENSIONS[i].key, label: DIMENSIONS[i].label };
    return null;
  }
  function detectDoc(t) {
    var m = /(СП|ГОСТ(?:\s+Р)?|СНиП)\s*(\d{1,3}(?:\.\d{1,5})?)/i.exec(t);
    if (m) {
      var key = m[1].toUpperCase().replace(/\s+/g, ' ');
      if (/^ГОСТ/.test(key)) key = /ГОСТ\s+Р/i.test(m[1]) ? 'ГОСТ Р' : 'ГОСТ';
      else if (/^СНиП/.test(key)) key = 'СНиП';
      else key = 'СП';
      return key + ' ' + m[2];
    }
    var m2 = /(СП|ГОСТ(?:\s+Р)?|СНиП)\s*\d/i.exec(t);
    if (m2) { var k2 = m2[1].toUpperCase(); return /ГОСТ\s+Р/i.test(m2[1]) ? 'ГОСТ Р' : k2; }
    if (/(снип)/i.test(t)) return 'СНиП';
    if (/(гост)/i.test(t)) return 'ГОСТ';
    return null;
  }
  function detectCalc(t) {
    var m = /(\d+(?:[.,]\d+)?)\s*(?:на|x|х|×|\*)\s*(\d+(?:[.,]\d+)?)/i.exec(t);
    if (!m) return null;
    var a = parseFloat(String(m[1]).replace(',', '.')), b = parseFloat(String(m[2]).replace(',', '.'));
    if (!isFinite(a) || !isFinite(b)) return null;
    return { a: a, b: b, expression: m[1] + '*' + m[2], value: Math.round(a * b * 1e6) / 1e6 };
  }
  function detectFilter(t) {
    if (/(вне допуск|вне норм|брак|не проход|не соответств|поза допуском|не в допуск)/i.test(t)) return 'bad';
    if (/(в допуск|проход|соответств)/i.test(t)) return 'ok';
    return null;
  }

  var RULES = [
    { id: 'unknown.meta', conf: 0.9, re: rx('(не знаю что это|не знаю, что это|не уверен, что это|не понимаю, что это)') },
    { id: 'calculate', conf: 0.95, re: rx('(посчитай|посчитай-ка|сколько будет|умножь|розрахуй|порахуй)') },
    { id: 'document.build', conf: 0.94, re: rx('(построй|сформируй|сформируйте|сделай|подготовь|побудуй|сформуй).*(документ|отчет|отчёт|акт|аоср|исполнительн|ведомост|звіт|документ)') },
    { id: 'document.build', conf: 0.9, re: rx('(документ[а-я]*|отчет[а-я]*|отчёт[а-я]*|акт[а-я]*|аоср|исполнительн[а-я]*).*(построй|сформируй|сделай|подготовь)') },
    { id: 'compare.docs', conf: 0.93, re: rx('(сверь|сверь-ка|сравни|соответству[а-я]* ли|проверь по|проверка по|сопоставь|звір|порівняй)') },
    { id: 'compare.docs', conf: 0.82, re: rx('(с документацией|по документации|с проектом|по проекту|по тз|по нормативам|з документацією)') },
    { id: 'norms.lookup', conf: 0.9, re: rx('(какой|какая|какие|каков|який|яка).*(допуск|норма|норму|требовани|допускается|допустимо|допустим|предел|по сп|по гост)') },
    { id: 'norms.lookup', conf: 0.8, re: rx('(норм[аыу]|норматив|допуск[а-я]*|требовани[а-я]*)') },
    { id: 'checks.summary', conf: 0.9, re: rx('(итог|сводк|результат[а-я]*|вывод|что не так|как дела|какие дефекты|где дефекты|где отклонени|какие проверки|что проверено)') },
    { id: 'model.info', conf: 0.88, re: rx('(в модели|модель|ifc|этаж[а-я]* в модели|сколько стен в модели|что построено|что в bim)') },
    { id: 'project.info', conf: 0.86, re: rx('(проект[а-я]*|какие документы|загруженные документы|что за объект|адрес объект|документация загружена)') },
    { id: 'help.capabilities', conf: 0.9, re: rx('(что ты умеешь|что умеешь|твои возможности|чем можешь помочь|что можешь|допоможи)') },
    { id: 'help.howto', conf: 0.8, re: rx('(как (проверить|сделать|настроить|измерить|запустить|найти|выгрузить|сохранить|открыть|построить|сравнить|включить)|где (кнопка|команда|найти)|як (перевірити|знайти|зробити))') },
    { id: 'find', conf: 0.9, re: rx('(найди|найдите|покажи|покажите|перечисли|сколько|где|знайди|покажи|скільки)') },
    { id: 'selection.measure', conf: 0.88, re: rx('(выделен[а-я]*|выбран[а-я]*|обведен[а-я]*|в рамке|що виділено|выдели)') },
    { id: 'element.measure', conf: 0.92, re: rx('(какая|какой|какие|чему|сколько|какова|яка|який|які).*(толщин|высот|длин|ширин|площад|объем|объём|диаметр|сечен|размер|габарит|отклонен|завал|товщин|висот|довжин|площа|розмір)') },
    { id: 'element.measure', conf: 0.85, re: rx('(толщин|высот|длин|ширин|площад|объем|объём|диаметр|сечен|размер|габарит|товщин|висот|довжин|площа|розмір)') },
    { id: 'element.type', conf: 0.94, re: rx('(что это за|что за элемент|что за объект|что за конструкц|определи (тип|что)|распознай|это что|що це таке|що це|що за|визнач тип)') },
    { id: 'element.type', conf: 0.9, re: rx('(^|[^а-яa-z])(это|эта|этот|це).{0,24}(стен|труб|пол|потол|балк|колонн|двер|окн|проем|проём|воздуховод|мебел|конструкц|стін|підлог)') },
    { id: 'element.type', conf: 0.86, re: rx('(объясни|опиши|расскажи про|що таке|что такое).{0,30}(элемент|объект|стен|труб|пол|потол|балк|колонн|двер|окн)') },
    { id: 'element.type', conf: 0.8, re: rx('(что это|что такое|що це|это что|тип элемента)') },
    { id: 'element.measure', conf: 0.78, re: rx('(сколько|какой размер|какие размеры|какая толщина|какая высота|какая площадь|какой диаметр)') }
  ];

  function parse(text) {
    var raw = String(text == null ? '' : text).trim();
    var t = q(raw);
    var out = { version: VERSION, intent: 'unknown', confidence: 0.2, params: {}, actions: [], raw: raw, normalized: t };
    if (!t) return out;
    var target = detectTarget(t), dim = detectDimension(t), doc = detectDoc(t), calc = detectCalc(t), filter = detectFilter(t);
    for (var i = 0; i < RULES.length; i++) {
      if (!RULES[i].re.test(t)) continue;
      var id = RULES[i].id;
      // «найди/покажи/сколько ... вне допуска» — это поиск, а не запрос нормы
      if (id === 'norms.lookup' && /(найди|покажи|перечисли|где|сколько|скільки|знайди)/i.test(t)) continue;
      // «найди/покажи» без объекта — не считаем find, уточняем
      if (id === 'find' && !target && !/(дефект|проем|проём|проріз)/i.test(t)) continue;
      out.intent = id; out.confidence = RULES[i].conf; break;
    }
    if (out.intent === 'unknown' && target) { out.intent = 'element.type'; out.confidence = 0.6; }
    out.params = {};
    if (target) out.params.target = target.type;
    if (target) out.params.targetLabel = target.label;
    if (dim) { out.params.dimension = dim.key; out.params.dimensionLabel = dim.label; }
    if (doc) out.params.doc = doc;
    if (calc) { out.params.expression = calc.expression; out.params.value = calc.value; out.params.a = calc.a; out.params.b = calc.b; }
    if (filter) out.params.filter = filter;
    if (out.intent === 'document.build') {
      if (/(аоср|акт)/i.test(t)) out.params.docType = 'АОСР/акт';
      else if (/(исполнительн)/i.test(t)) out.params.docType = 'исполнительная документация';
      else if (/(отчет|отчёт|звіт)/i.test(t)) out.params.docType = 'отчёт';
      else if (/(ведомост)/i.test(t)) out.params.docType = 'ведомость';
      else out.params.docType = 'документ';
    }
    if (out.intent === 'compare.docs' && !out.params.doc && doc) out.params.doc = doc;
    if (out.intent === 'norms.lookup' && doc) out.params.doc = doc;
    out.actions = suggestActions(out, null);
    return out;
  }
  // ближайшие доступные действия (без обещаний того, чего нет)
  function suggestActions(parsed, ctx) {
    var c = ctx && ctx.capabilities || {};
    var acts = [];
    function add(kind, label) { acts.push({ kind: kind, label: label }); }
    if (c.selection && !c.element) add('analyze-selection', 'Определить элемент по выделению');
    if (c.cloud) add('pick-element', 'Что это? — щёлкнуть по элементу');
    if (c.inspection) add('open-inspection', 'Открыть контроль геометрии');
    else if (c.cloud) add('open-inspection', 'Запустить контроль геометрии');
    if (c.documents) add('open-docs', 'Открыть документы');
    add('open-norms', 'База норм');
    if (c.model) add('open-model', 'Открыть BIM-модель');
    var seen = {}, out = [];
    acts.forEach(function (a) { if (!seen[a.kind]) { seen[a.kind] = 1; out.push(a); } });
    return out.slice(0, 4);
  }
  // ------------------------------------------------------------------ факты
  function dimByKey(el, key) {
    var dims = el && el.dims || [];
    var aliases = { dims: ['dims'], area: ['area', 'площадь'], thickness: ['thickness', 'depth'], height: ['height', 'clear'], length: ['length'], width: ['width'], diameter: ['diameter'], section: ['section'], plumb: ['plumb', 'deviation'], clear: ['clear'], volume: ['volume'] };
    var keys = aliases[key] || [key];
    for (var i = 0; i < dims.length; i++) if (keys.indexOf(String(dims[i].key)) >= 0) return dims[i];
    // по подписи размера: «Глубина проёма (толщина стены)» = толщина стены
    var lblRe = { thickness: /толщин|товщин/i, height: /высот|висот/i, length: /длин|довжин/i, width: /ширин/i, area: /площад|площ/i, diameter: /диаметр|діаметр/i }[key];
    if (lblRe) for (var j = 0; j < dims.length; j++) if (lblRe.test(String(dims[j].label || ''))) return dims[j];
    return null;
  }
  function dimsText(el, n) {
    return (el && el.dims || []).slice(0, n || 5).map(function (d) { return d.label + ' — ' + (d.text || (d.value != null ? (d.value + (d.unit ? ' ' + d.unit : '')) : '—')); }).join('; ');
  }
  function typeLabel(type) {
    var C = W && W.AiContext;
    if (C && C.TYPE_LABEL && C.TYPE_LABEL[type]) return C.TYPE_LABEL[type];
    return TYPE_LABEL[type] || type || 'элемент';
  }
  function honest(reason, ctx, extra) {
    var acts = suggestActions({ intent: 'unknown' }, ctx);
    return Object.assign({
      handled: true, honest: true, intent: 'unknown',
      text: 'Не знаю — ' + reason + '. Данных в контексте приложения сейчас нет, выдумывать не буду.',
      actions: acts, tools: ['app_context']
    }, extra || {});
  }
  function listActionText(actions) {
    if (!actions || !actions.length) return '';
    return '\n\nЧто можно сделать: ' + actions.map(function (a) { return a.label; }).join('; ') + '.';
  }
  function fmtCount(n) { return n == null ? '?' : Number(n).toLocaleString('ru-RU'); }
  function countOpenings(model) {
    if (!model || !model.openings) return null;
    var doors = 0, windows = 0, other = 0;
    (model._walls || []).forEach(function () { });
    if (model._openingKinds) return model._openingKinds;
    return { doors: null, windows: null, total: model.openings };
  }
  function findTargetFacts(target, ctx) {
    var ins = ctx && ctx.inspection || {}, model = ctx && ctx.model || {};
    if (target === 'door' || target === 'window' || target === 'opening') {
      var total = model.openings != null ? model.openings : (ins.summary && ins.summary.openings);
      if (total == null) return null;
      if (ctx.model && ctx.model.openingKinds) {
        if (target === 'door') return { count: ctx.model.openingKinds.doors, where: 'BIM-модель' };
        if (target === 'window') return { count: ctx.model.openingKinds.windows, where: 'BIM-модель' };
      }
      return { count: total, where: 'BIM-модель/контроль', note: 'в модели проёмов всего ' + total + ' (без разделения двери/окна)' };
    }
    if (target === 'wall') { var n = model.walls != null ? model.walls : (ins.summary && ins.summary.walls); return n == null ? null : { count: n, where: model.walls != null ? 'BIM-модель' : 'контроль геометрии' }; }
    if (target === 'pipe') { var p = model.pipes != null ? model.pipes : (ins.summary && ins.summary.mep && ins.summary.mep.pipes); return p == null ? null : { count: p, where: 'BIM-модель' }; }
    if (target === 'beam') { var b = model.beams != null ? model.beams : (ins.summary && ins.summary.mep && ins.summary.mep.beams); return b == null ? null : { count: b, where: 'BIM-модель' }; }
    if (target === 'column') { return model.columns != null ? { count: model.columns, where: 'BIM-модель' } : null; }
    if (target === 'room') { var r = model.rooms != null ? model.rooms : (ins.summary && ins.summary.rooms); return r == null ? null : { count: r, where: 'BIM-модель/контроль' }; }
    if (target === 'furniture') { return model.objects != null ? { count: model.objects, where: 'BIM-модель' } : null; }
    return null;
  }
  // ------------------------------------------------------------------ выполнение намерения
  function execute(parsed, ctx, opts) {
    parsed = parsed || { intent: 'unknown', params: {} };
    ctx = ctx || {};
    var p = parsed.params || {}, caps = ctx.capabilities || {}, el = ctx.element || null;
    var acts = suggestActions(parsed, ctx);
    if (parsed.intent === 'element.type' || parsed.intent === 'element.describe') {
      if (!el) {
        if (caps.selection) return { handled: false, need: 'analyze-selection', intent: parsed.intent };
        var guess = p.target || p.targetLabel || '';
        if (ctx.inspection && ctx.inspection.available) {
          var sm = ctx.inspection.summary || {};
          return { handled: true, honest: false, intent: parsed.intent, text: 'Выделенного элемента нет, поэтому конкретный тип не подтверждён. По результатам контроля геометрии: стен ' + (sm.walls != null ? sm.walls : '?') + (sm.wallsOutOfTolerance ? ', вне допуска ' + sm.wallsOutOfTolerance : '') + (sm.rooms != null ? '; помещений ' + sm.rooms : '') + '. Чтобы ИИ определил тип с размерами — выделите элемент в облаке и нажмите «Что это?» (auto-measure).' + listActionText(acts), actions: acts, tools: ['app_context'] };
        }
        return honest('нет выделенного элемента и результата классификатора' + (guess ? ' (' + guess + ')' : ''), ctx);
      }
      var checks = el.checks || [];
      var checkText = checks.length ? ' Нормоконтроль: ' + checks.slice(0, 4).map(function (c) { return c.label + ' — ' + (c.ok === true ? 'в норме' : c.ok === false ? 'вне нормы' : (c.text || 'нет данных')); }).join('; ') + '.' : '';
      var text = (el.title || typeLabel(el.type)) + ' — тип: ' + typeLabel(el.type) + (el.confidence != null ? ' (уверенность ' + Math.round(el.confidence * 100) + '%)' : '') + ' (источник: ' + (el.source || 'классификатор') + ').' + (el.dims && el.dims.length ? ' Размеры: ' + dimsText(el, 6) + '.' : '') + checkText;
      return { handled: true, honest: false, intent: parsed.intent, text: text, actions: acts, tools: ['auto_measure', 'app_context'], element: el };
    }
    if (parsed.intent === 'element.measure' || parsed.intent === 'selection.measure') {
      if (!el) {
        if (caps.selection) return { handled: false, need: 'analyze-selection', intent: parsed.intent };
        return honest('элемент не выделен и не распознан', ctx);
      }
      var key = p.dimension || 'dims';
      if (key === 'dims') {
        if (!el.dims || !el.dims.length) return honest('классификатор не дал размеров для этого элемента', ctx);
        return { handled: true, honest: false, intent: parsed.intent, text: (el.title || 'Элемент') + ': ' + dimsText(el, 7) + '.', actions: acts, tools: ['auto_measure', 'app_context'], element: el };
      }
      var d = dimByKey(el, key);
      if (!d) {
        var avail = (el.dims || []).map(function (x) { return x.label; }).join(', ') || 'нет';
        return honest('у распознанного элемента нет размера «' + (p.dimensionLabel || key) + '» (доступны: ' + avail + ')', ctx, { element: el });
      }
      var val = d.value != null ? fmt(d.value, 3) + (d.unit && !/мм|°|%/.test(d.unit) ? ' ' + d.unit : '') : (d.text || '—');
      return { handled: true, honest: false, intent: parsed.intent, text: (p.dimensionLabel ? p.dimensionLabel.charAt(0).toUpperCase() + p.dimensionLabel.slice(1) : 'Размер') + ' — ' + val + ' (' + (el.title || el.type) + ').' + (d.text && d.text !== val ? ' В приложении: ' + d.text + '.' : ''), actions: acts, tools: ['auto_measure', 'app_context'], element: el };
    }
    if (parsed.intent === 'find') {
      var tg = p.target;
      if (!tg && /(дефект)/i.test(parsed.raw)) {
        var ins0 = ctx.inspection || {};
        if (ins0.available) {
          var sm0 = ins0.summary || {};
          if (sm0.defects != null) return { handled: true, honest: false, intent: 'find', text: 'Дефектов в контроле геометрии: ' + sm0.defects + (ins0.checks && ins0.checks.length ? ' (см. проверки: ' + ins0.checks.filter(function (c) { return /дефект/i.test(c.label); }).map(function (c) { return c.text; }).join('; ') + ')' : '') + '.', actions: acts, tools: ['app_context'] };
        }
        return honest('контроль геометрии не выполнялся — дефектов в контексте нет', ctx);
      }
      var facts = findTargetFacts(tg, ctx);
      if (!facts) return honest('в открытых данных нет списка/количества «' + (p.targetLabel || tg || 'объектов') + '»', ctx);
      var suffix = '';
      if (p.filter === 'bad') suffix = ' (фильтр «вне допуска» — см. контроль геометрии)';
      return { handled: true, honest: false, intent: 'find', text: (p.targetLabel ? p.targetLabel.charAt(0).toUpperCase() + p.targetLabel.slice(1) : 'Объекты') + ': ' + fmtCount(facts.count) + ' — источник: ' + facts.where + (facts.note ? '; ' + facts.note : '') + suffix + '.', actions: acts, tools: ['app_context'], find: { target: tg, count: facts.count } };
    }
    if (parsed.intent === 'compare.docs') {
      var ins = ctx.inspection || {};
      if (ins.available && ins.compare) {
        var cmp = ins.compare;
        var parts = [];
        if (cmp.walls != null) parts.push('стен в сверке ' + cmp.walls);
        if (cmp.matched != null) parts.push('совпало ' + cmp.matched);
        if (cmp.mismatch != null) parts.push('расхождений ' + cmp.mismatch);
        if (!parts.length) parts.push('результат сверки есть в контроле геометрии');
        return { handled: true, honest: false, intent: 'compare.docs', text: 'Сверка с документацией: ' + parts.join(', ') + (ins.dxfName ? ' (проект: ' + ins.dxfName + ')' : '') + '.', actions: acts, tools: ['app_context'] };
      }
      var docs = ctx.documents || {};
      return { handled: true, honest: true, intent: 'compare.docs', text: 'Не знаю — сверка с документацией ещё не выполнялась' + ((docs.projectDocs || []).length ? '; в проекте загружено документов: ' + docs.projectDocs.length : '; документы проекта не загружены') + '. Запустите «Сверка с документацией» (контроль геометрии → DXF/ТЗ), тогда отвечу по цифрам.' + listActionText(acts), actions: acts, tools: ['app_context'] };
    }
    if (parsed.intent === 'document.build') {
      var dt = p.docType || 'документ';
      return { handled: true, honest: false, intent: 'document.build', text: 'Могу подготовить «' + dt + '» по открытым данным' + (ctx.cloud && ctx.cloud.open ? ' (облако: ' + ctx.cloud.name + ', ' + fmtCount(ctx.cloud.points) + ' точек)' : '') + (ctx.inspection && ctx.inspection.available ? ' и результатам контроля геометрии' : '') + '. Открою окно документов — там кнопка формирования; при отсутствии данных документ не будет выдумывать цифры.', actions: [{ kind: 'open-docs', label: 'Открыть документы' }].concat(acts.slice(0, 2)), tools: ['app_context'], action: { kind: 'open-docs' } };
    }
    if (parsed.intent === 'norms.lookup') {
      var doc = p.doc || detectDoc(parsed.raw) || '';
      return { handled: true, honest: false, intent: 'norms.lookup', text: 'Открою базу норм' + (doc ? ' и найду выдержки по «' + doc + '»' : ' — уточните документ (СП/ГОСТ) или вопрос') + '. Точные допуски беру только из базы норм, не из головы.', actions: [{ kind: 'open-norms', label: 'Открыть базу норм', doc: doc }], tools: ['app_context'], action: { kind: 'open-norms', doc: doc, query: parsed.raw } };
    }
    if (parsed.intent === 'calculate') {
      if (!p.expression || !has(p.value)) return honest('не увидел двух чисел для расчёта (пример: «посчитай 12,5 на 3,2»)', ctx);
      return { handled: true, honest: false, intent: 'calculate', text: p.a + ' × ' + p.b + ' = ' + fmt(p.value, 6) + '.', actions: acts, tools: ['calculate'] };
    }
    if (parsed.intent === 'model.info') {
      var m = ctx.model || {};
      if (!m.open) return honest('BIM-модель не открыта/не построена', ctx, { actions: [{ kind: 'open-model', label: 'Открыть Скан → BIM' }].concat(acts.slice(0, 3)) });
      return { handled: true, honest: false, intent: 'model.info', text: 'BIM-модель: этажей ' + (m.storeys || 0) + ', стен ' + (m.walls || 0) + ' (длина ' + fmt(m.wallLength, 1) + ' м), проёмов ' + (m.openings || 0) + ', помещений ' + (m.rooms || 0) + ' (площадь ' + fmt(m.area, 1) + ' м²)' + (m.pipes ? ', труб ' + m.pipes : '') + (m.beams ? ', балок ' + m.beams : '') + '.', actions: acts, tools: ['app_context'] };
    }
    if (parsed.intent === 'checks.summary') {
      var ins2 = ctx.inspection || {};
      if (!ins2.available) return honest('контроль геометрии ещё не выполнялся', ctx, { actions: [{ kind: 'open-inspection', label: 'Запустить контроль геометрии' }].concat(acts.slice(0, 3)) });
      var sm = ins2.summary || {};
      var lines = [];
      if (sm.walls != null) lines.push('стен ' + sm.walls + (sm.wallsOutOfTolerance ? ', вне допуска ' + sm.wallsOutOfTolerance : ', все в допуске'));
      if (sm.floor && sm.floor.mmPerM != null) lines.push('ровность пола ' + sm.floor.mmPerM + ' мм/м');
      if (sm.defects != null) lines.push('дефектов ' + sm.defects);
      if (sm.rooms != null) lines.push('помещений ' + sm.rooms + ' (площадь ' + fmt(sm.roomsArea, 1) + ' м²)');
      if (!lines.length) lines.push('результат есть, кратких цифр в контексте нет');
      return { handled: true, honest: false, intent: 'checks.summary', text: 'Итог контроля геометрии' + (ins2.fileName ? ' (' + ins2.fileName + ')' : '') + ': ' + lines.join('; ') + '.', actions: acts, tools: ['app_context'] };
    }
    if (parsed.intent === 'project.info') {
      var pr = ctx.project || {}, docs2 = ctx.documents || {};
      if (!pr.open && !docs2.count) return honest('проект/документы не загружены', ctx);
      return { handled: true, honest: false, intent: 'project.info', text: 'Проект: ' + (pr.name || pr.id || 'не выбран') + '; документов проекта: ' + (docs2.count || 0) + ((docs2.projectDocs || []).length ? ' (' + docs2.projectDocs.map(function (d) { return d.name; }).slice(0, 4).join('; ') + ')' : '') + '; в базе норм документов: ' + ((docs2.norms && docs2.norms.docs || []).length) + '.', actions: acts, tools: ['app_context'] };
    }
    if (parsed.intent === 'unknown.meta') {
      return { handled: true, honest: true, intent: 'unknown', text: 'Не знаю, что это за элемент — чтобы не выдумывать, посмотрите на факты: ' + (el ? el.title + ' (' + typeLabel(el.type) + ')' : (ctx.selection && ctx.selection.active ? 'выделено ' + fmtCount(ctx.selection.count) + ' точек, но классификатор ещё не определил элемент' : 'выделения нет')) + '.' + listActionText(acts), actions: acts, tools: ['app_context'] };
    }
    if (parsed.intent === 'help.capabilities') {
      return { handled: true, honest: false, intent: 'help', text: 'Я отвечаю по фактам приложения: ' + (caps.cloud ? 'облако открыто (' + fmtCount(ctx.cloud.points) + ' точек), ' : 'облако не открыто, ') + (caps.selection ? 'есть выделение, ' : '') + (caps.element ? 'есть распознанный элемент, ' : '') + (caps.inspection ? 'есть контроль геометрии, ' : '') + (caps.model ? 'есть BIM-модель, ' : '') + 'документы и нормы — по загруженным. Умею: «что это», размеры/толщина/площадь, поиск дверей/окон/труб, «сверь с документацией», «построй документ», нормы, расчёты. Если данных нет — скажу «не знаю».' + listActionText(acts), actions: acts, tools: ['app_context'] };
    }
    if (parsed.intent === 'help.howto') {
      return { handled: true, honest: false, intent: 'help', text: 'Подсказка: выделите элемент в облаке и нажмите «Что это?» (или кнопку ассистента) — ИИ определит тип и размеры; для проверки по нормам откройте «База норм», для сверки с проектом — «Контроль геометрии» (DXF/ТЗ).' + listActionText(acts), actions: acts, tools: ['app_context'] };
    }
    // unknown
    return honest('я не понял намерение из фразы «' + parsed.raw.slice(0, 80) + '»', ctx);
  }
  return { version: VERSION, parse: parse, execute: execute, suggestActions: suggestActions, TARGETS: TARGETS, DIMENSIONS: DIMENSIONS, _detectTarget: detectTarget, _detectDimension: detectDimension, _detectCalc: detectCalc, _q: q };
});
