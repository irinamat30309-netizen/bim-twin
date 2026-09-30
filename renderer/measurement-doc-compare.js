/*
 * measurement-doc-compare.js
 * Conservative, deterministic extraction and comparison of measured values
 * against explicit requirements found in project documents. Document contents
 * are untrusted data: this module only parses numeric patterns and never runs
 * or interprets document instructions.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MeasurementDocCompare = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  const UNIT_DEFS = [
    { aliases: ['мм²', 'мм2', 'мм^2', 'mm²', 'mm2', 'mm^2', 'sq mm', 'sq. mm', 'square mm', 'square millimeter', 'square millimeters', 'square millimetre', 'square millimetres'], kind: 'area', factor: 1e-6, symbol: 'мм²' },
    { aliases: ['см²', 'см2', 'см^2', 'cm²', 'cm2', 'cm^2', 'sq cm', 'sq. cm', 'square cm', 'square centimeter', 'square centimeters', 'square centimetre', 'square centimetres'], kind: 'area', factor: 1e-4, symbol: 'см²' },
    { aliases: ['м²', 'м2', 'м^2', 'm²', 'm2', 'm^2', 'кв. м', 'кв.м', 'кв м', 'квадратный метр', 'квадратных метров', 'sq m', 'sq. m', 'sqm', 'square meter', 'square meters', 'square metre', 'square metres'], kind: 'area', factor: 1, symbol: 'м²' },
    { aliases: ['ft²', 'ft2', 'ft^2', 'sq ft', 'sq. ft', 'sqft', 'square foot', 'square feet'], kind: 'area', factor: 0.09290304, symbol: 'ft²' },
    { aliases: ['in²', 'in2', 'in^2', 'sq in', 'sq. in', 'sqin', 'square inch', 'square inches'], kind: 'area', factor: 0.00064516, symbol: 'in²' },
    { aliases: ['мм', 'millimeter', 'millimeters', 'millimetre', 'millimetres', 'миллиметр', 'миллиметра', 'миллиметров', 'mm'], kind: 'linear', factor: 0.001, symbol: 'мм' },
    { aliases: ['см', 'centimeter', 'centimeters', 'centimetre', 'centimetres', 'сантиметр', 'сантиметра', 'сантиметров', 'cm'], kind: 'linear', factor: 0.01, symbol: 'см' },
    { aliases: ['м', 'метр', 'метра', 'метров', 'meter', 'meters', 'metre', 'metres', 'm'], kind: 'linear', factor: 1, symbol: 'м' },
    { aliases: ['км', 'километр', 'километра', 'километров', 'kilometer', 'kilometers', 'kilometre', 'kilometres', 'km'], kind: 'linear', factor: 1000, symbol: 'км' },
    { aliases: ['дюйм', 'дюйма', 'дюймов', 'inch', 'inches', 'in', '"'], kind: 'linear', factor: 0.0254, symbol: 'in' },
    { aliases: ['фут', 'фута', 'футов', 'foot', 'feet', 'ft', "'"], kind: 'linear', factor: 0.3048, symbol: 'ft' },
    { aliases: ['градус', 'градуса', 'градусов', 'град', 'degree', 'degrees', 'deg', '°'], kind: 'angle', factor: 1, symbol: '°' },
    { aliases: ['радиан', 'радиана', 'радианов', 'radian', 'radians', 'rad'], kind: 'angle', factor: 180 / Math.PI, symbol: 'rad' },
    { aliases: ['%', 'процент', 'процента', 'процентов', 'percent', 'pct'], kind: 'slope', factor: 1, symbol: '%' }
  ];

  const NUM_SRC = '[+-]?(?:\\d{1,3}(?:[ \\u00a0]\\d{3})+|\\d+)(?:[.,]\\d+)?';
  const UNIT_TOKEN_SRC = '(?:миллиметр(?:а|ов)?|сантиметр(?:а|ов)?|километр(?:а|ов)?|метр(?:а|ов)?|дюйм(?:а|ов)?|фут(?:а|ов)?|градус(?:а|ов)?|радиан(?:а|ов)?|квадратных?\\s+метр(?:а|ов)?|кв\\.?\\s*м|millimet(?:er|re)s?|centimet(?:er|re)s?|kilomet(?:er|re)s?|met(?:er|re)s?|inches|inch|feet|foot|degrees?|degs?|radians?|rad|sq\\.?\\s*(?:mm|cm|m|ft|in)|sqft|sqin|sqm|мм(?:\\s*(?:\\^?2|²))?|см(?:\\s*(?:\\^?2|²))?|км|м(?:\\s*(?:\\^?2|²))?|mm(?:\\s*(?:\\^?2|²))?|cm(?:\\s*(?:\\^?2|²))?|km|m(?:\\s*(?:\\^?2|²))?|ft(?:\\s*(?:\\^?2|²))?|in(?:\\s*(?:\\^?2|²))?|ft²|in²|°|%|дюйм|фут)';
  const EXPLICIT_UNIT_RE = new RegExp('(^|[^A-Za-zА-Яа-яЁё0-9])(' + UNIT_TOKEN_SRC + ')(?=$|[^A-Za-zА-Яа-яЁё0-9])', 'giu');
  const DIMENSION_LABELS = [
    ['width', /\bwidth\b|ширин/iu],
    ['height', /\bheight\b|\bvertical\b|высот/iu],
    ['length', /\blength\b|длин/iu],
    ['thickness', /\bthickness\b|толщин/iu],
    ['diameter', /\bdiameter\b|\bdia\b|диаметр/iu],
    ['gap', /\bclearance\b|\bgap\b|\bdeviation\b|зазор|отклонен/iu],
    ['area', /\barea\b|площад/iu],
    ['angle', /\bangle\b|угол/iu],
    ['slope', /\bslope\b|\bgrade\b|уклон/iu]
  ];

  const SEMANTIC_STOP_WORDS = new Set([
    'the', 'and', 'for', 'from', 'with', 'this', 'that', 'into', 'over', 'under',
    'или', 'для', 'при', 'это', 'этот', 'эта', 'эти', 'как', 'что', 'над', 'под',
    'в', 'во', 'на', 'по', 'из', 'к', 'ко', 'у', 'о', 'об', 'от', 'до', 'и',
    'та', 'такий', 'така', 'таке', 'для', 'при', 'це', 'цей', 'ця', 'ці', 'як',
    'з', 'із', 'зі', 'у', 'в', 'на', 'по', 'до', 'від'
  ]);

  const OBJECT_CATEGORY_DEFS = [
    ['wall', /(?:\bwall(?:s)?\b|стен|сті[нн]|перегород|partition)/iu],
    ['opening', /(?:\bopening(?:s)?\b|про[её]м|проріз)/iu],
    ['door', /(?:\bdoor(?:s)?\b|двер|дверн)/iu],
    ['window', /(?:\bwindow(?:s)?\b|окон|окн|вікон|вікн)/iu],
    ['column', /(?:\bcolumn(?:s)?\b|колонн|колон)/iu],
    ['beam', /(?:\bbeam(?:s)?\b|балк)/iu],
    ['slab', /(?:\bslab(?:s)?\b|плит[аы]|перекрыт)/iu],
    ['floor', /(?:\bfloor(?:s)?\b|пол(?:а|у|ом|ы)?\b|підлог)/iu],
    ['ceiling', /(?:\bceiling(?:s)?\b|потол|стел)/iu],
    ['pipe', /(?:\bpipe(?:s)?\b|pipeline|труб|трубопровод)/iu],
    ['duct', /(?:\bduct(?:s)?\b|air[\s-]?duct|воздуховод|повітровод|венткороб)/iu],
    ['shaft', /(?:\bshaft(?:s)?\b|шахт|вентшахт)/iu],
    ['equipment', /(?:\bequipment\b|\bunit\b|оборудован|обладнан|установк)/iu],
    ['cable-tray', /(?:cable[\s-]?(?:tray|channel)|кабель[\s-]?(?:канал|лоток)|лоток)/iu],
    ['stair', /(?:\bstair(?:s|case)?\b|лестниц|сход)/iu],
    ['foundation', /(?:\bfoundation(?:s)?\b|фундамент)/iu],
    ['facade', /(?:\bfacade(?:s)?\b|фасад)/iu],
    ['roof', /(?:\broof(?:s)?\b|кровл|дах)/iu],
    ['room', /(?:\broom(?:s)?\b|помещен|приміщен|комнат)/iu]
  ];

  const CATEGORY_COMPATIBILITY = {
    door: ['opening'],
    window: ['opening'],
    opening: ['door', 'window'],
    duct: ['shaft'],
    shaft: ['duct'],
    slab: ['floor', 'ceiling'],
    floor: ['slab'],
    ceiling: ['slab']
  };

  function normalizeSemanticText(value) {
    return String(value == null ? '' : value)
      .normalize('NFKD')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zа-яіїєґ0-9]+/giu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function semanticStem(token) {
    let value = String(token || '');
    if (value.length <= 4 || /\d/u.test(value)) return value;
    if (/^[a-z]+$/u.test(value)) {
      value = value.replace(/(?:ments?|ations?|ingly|edly|ing|ed|es|s)$/u, '');
      return value.length >= 3 ? value : token;
    }
    value = value.replace(/(?:иями|ями|ами|ого|ему|ому|ими|ыми|ий|ый|ая|яя|ое|ее|ые|ие|ов|ев|ам|ям|ах|ях|ою|ею|ом|ем|ів|а|я|и|ы|е|у|ю|о)$/u, '');
    return value.length >= 3 ? value : token;
  }

  function tokenizeSemanticText(value) {
    const normalized = normalizeSemanticText(value);
    if (!normalized) return [];
    const seen = new Set();
    const out = [];
    for (const raw of normalized.split(' ')) {
      if (!raw || raw.length < 2 || SEMANTIC_STOP_WORDS.has(raw)) continue;
      const token = semanticStem(raw);
      if (!token || SEMANTIC_STOP_WORDS.has(token) || seen.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
    return out;
  }

  function detectObjectCategories(value) {
    const text = normalizeSemanticText(value);
    if (!text) return [];
    return OBJECT_CATEGORY_DEFS.filter(pair => pair[1].test(text)).map(pair => pair[0]);
  }

  function normalizeUnitText(value) {
    let s = String(value == null ? '' : value).trim().toLowerCase()
      .replace(/\u00a0/g, ' ')
      .replace(/[²]/g, '2')
      .replace(/\^2/g, '2')
      .replace(/\s+/g, ' ');
    s = s.replace(/^квадратных?\s+метр(?:а|ов)?$/, 'м2');
    s = s.replace(/^square\s+(millimeters?|millimetres?)$/, 'mm2');
    s = s.replace(/^square\s+(centimeters?|centimetres?)$/, 'cm2');
    s = s.replace(/^square\s+(meters?|metres?)$/, 'm2');
    s = s.replace(/^square\s+feet$/, 'ft2').replace(/^square\s+foot$/, 'ft2');
    s = s.replace(/^square\s+inches?$/, 'in2');
    s = s.replace(/^sq\.?\s*(mm|cm|m|ft|in)$/, '$1' + '2');
    s = s.replace(/^sqft$/, 'ft2').replace(/^sqin$/, 'in2').replace(/^sqm$/, 'm2');
    s = s.replace(/^кв\.?\s*м$/, 'м2');
    return s;
  }

  function unitInfo(value) {
    const s = normalizeUnitText(value);
    for (const def of UNIT_DEFS) {
      if (def.aliases.some(alias => normalizeUnitText(alias) === s)) {
        return { kind: def.kind, factor: def.factor, symbol: def.symbol };
      }
    }
    return null;
  }

  function findUnit(text, preferredKind) {
    const s = String(text == null ? '' : text);
    EXPLICIT_UNIT_RE.lastIndex = 0;
    let m;
    while ((m = EXPLICIT_UNIT_RE.exec(s))) {
      const info = unitInfo(m[2]);
      if (info && (!preferredKind || info.kind === preferredKind)) return { raw: m[2], info: info, index: m.index + m[1].length };
    }
    return null;
  }

  function parseNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const s = String(value == null ? '' : value).trim().replace(/\u00a0/g, ' ');
    if (!s) return null;
    const normalized = s.replace(/[ \t]/g, '').replace(',', '.');
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
  }

  function dimensionHint(text, unitKind) {
    const s = String(text || '');
    if (unitKind === 'area') return { dimension: 'area', kind: 'area' };
    if (unitKind === 'angle') return { dimension: 'angle', kind: 'angle' };
    if (unitKind === 'slope') return { dimension: 'slope', kind: 'slope' };
    for (const [dimension, re] of DIMENSION_LABELS) {
      if (re.test(s)) {
        const kind = dimension === 'area' ? 'area' : dimension === 'angle' ? 'angle' : dimension === 'slope' ? 'slope' : 'linear';
        return { dimension: dimension, kind: kind };
      }
    }
    return { dimension: 'unspecified', kind: unitKind || 'linear' };
  }

  function sourceCopy(source, excerpt) {
    source = source || {};
    return {
      documentId: source.documentId || null,
      documentName: source.documentName || null,
      sheet: source.sheet || null,
      row: Number.isSafeInteger(source.row) ? source.row : null,
      line: Number.isSafeInteger(source.line) ? source.line : null,
      page: Number.isSafeInteger(source.page) ? source.page : null,
      excerpt: String(excerpt == null ? '' : excerpt).slice(0, 500),
      ocr: !!source.ocr,
      truncated: !!source.truncated
    };
  }

  function makeRequirement(args) {
    const info = unitInfo(args.unit);
    if (!info || !Number.isFinite(args.value)) return null;
    const dim = args.dimension || dimensionHint(args.context, info.kind).dimension;
    const kind = args.kind || info.kind;
    const unitKindMismatch = kind !== info.kind;
    const tolerance = Number.isFinite(args.tolerance) && args.tolerance >= 0 ? args.tolerance : null;
    const tolUnit = unitInfo(args.toleranceUnit || args.unit);
    const toleranceBase = tolerance == null || !tolUnit || tolUnit.kind !== info.kind ? null : tolerance * tolUnit.factor;
    return {
      id: '',
      kind: info.kind,
      dimension: dim,
      value: args.value,
      unit: info.symbol,
      baseValue: args.value * info.factor,
      tolerance: toleranceBase,
      toleranceValue: tolerance,
      toleranceUnit: tolerance == null || !tolUnit || tolUnit.kind !== info.kind ? null : tolUnit.symbol,
      toleranceMode: args.toleranceMode || (toleranceBase != null ? 'symmetric' : null),
      bound: Number.isFinite(args.bound) ? args.bound * info.factor : null,
      confidence: args.confidence || 'medium',
      needsConfirmation: args.needsConfirmation !== false,
      assumptions: Array.isArray(args.assumptions) ? args.assumptions.slice(0, 5) : [],
      source: sourceCopy(args.source, args.excerpt),
      unitKindMismatch: unitKindMismatch
    };
  }

  function lastMeaningfulLabel(text, endIndex) {
    const before = String(text || '').slice(0, Math.max(0, endIndex));
    let bestIndex = -1;
    for (const pair of DIMENSION_LABELS) {
      const re = new RegExp(pair[1].source, pair[1].flags.replace('g', '') + 'g');
      let m;
      while ((m = re.exec(before))) {
        if (m.index > bestIndex) bestIndex = m.index;
        if (!m[0].length) re.lastIndex++;
      }
    }
    if (bestIndex >= 0) return before.slice(bestIndex, Math.min(before.length, bestIndex + 120));
    const parts = before.split(/[;|\n\r]/);
    return parts.slice(-2).join(' ');
  }

  function isToleranceContext(text, index) {
    const before = String(text || '').slice(Math.max(0, index - 80), index);
    const after = String(text || '').slice(index, index + 35);
    const tolAt = Math.max(before.toLowerCase().lastIndexOf('допуск'), before.toLowerCase().lastIndexOf('tolerance'), before.toLowerCase().lastIndexOf('±'), before.toLowerCase().lastIndexOf('+/-'));
    const dimAt = Math.max(before.toLowerCase().lastIndexOf('ширин'), before.toLowerCase().lastIndexOf('width'), before.toLowerCase().lastIndexOf('высот'), before.toLowerCase().lastIndexOf('height'), before.toLowerCase().lastIndexOf('длин'), before.toLowerCase().lastIndexOf('length'), before.toLowerCase().lastIndexOf('толщин'), before.toLowerCase().lastIndexOf('thickness'));
    return tolAt >= 0 && tolAt > dimAt && !/^\s*(?:ширин|width|высот|height|длин|length|толщин|thickness)/iu.test(after);
  }

  function overlaps(range, ranges) {
    return ranges.some(r => range.start < r.end && range.end > r.start);
  }

  function findTolerance(sourceLine, fromIndex, fallbackUnit) {
    const s = String(sourceLine || '');
    const num = NUM_SRC;
    const unit = UNIT_TOKEN_SRC;
    const re = new RegExp('(?:±|\\+\\s*\\/\\s*-|\\+\\s*-|допуск\\s*:?\\s*±?)\\s*(' + num + ')\\s*(' + unit + ')?', 'iu');
    const endAt = s.indexOf(';', fromIndex) >= 0 ? s.indexOf(';', fromIndex) : s.length;
    const startAt = Math.max(s.lastIndexOf(';', fromIndex), s.lastIndexOf('\n', fromIndex)) + 1;
    const local = s.slice(Math.max(startAt, fromIndex - 2), Math.min(endAt, fromIndex + 80));
    const m = re.exec(local);
    if (!m) return null;
    const value = parseNumber(m[1]);
    const u = unitInfo(m[2] || fallbackUnit);
    if (value == null || !u) return null;
    return { value: value, unit: u.symbol, baseValue: value * u.factor, kind: u.kind, mode: 'symmetric' };
  }

  function createSingle(line, value, unitText, at, source, extra) {
    const unit = unitInfo(unitText);
    if (!unit) return null;
    const labelContext = lastMeaningfulLabel(line, at);
    const hint = dimensionHint(labelContext || line, unit.kind);
    const tol = findTolerance(line, at, unitText);
    const args = {
      value: value, unit: unitText, kind: unit.kind, dimension: hint.dimension,
      tolerance: tol && tol.kind === unit.kind ? tol.value : null,
      toleranceUnit: tol && tol.kind === unit.kind ? tol.unit : unitText,
      toleranceMode: tol && tol.kind === unit.kind ? tol.mode : null,
      context: line, source: source, excerpt: line,
      confidence: source && source.sheet ? 'medium' : 'medium',
      assumptions: []
    };
    const boundMatch = /(?:не\s+(?:более|свыше|выше)|не\s+менее|не\s+ниже|максимум|минимум|(?:<=|≤|>=|≥))\s*[-+]?\s*(?:\d[\d \u00a0]*\d|\d)(?:[.,]\d+)?/iu.exec(line);
    if (boundMatch) {
      const prefix = line.slice(Math.max(0, boundMatch.index - 25), boundMatch.index);
      const isMin = /не\s+менее|не\s+ниже|минимум|>=|≥/iu.test(boundMatch[0] + ' ' + prefix);
      args.tolerance = null;
      args.toleranceMode = null;
      args.bound = value;
      args.boundMode = isMin ? 'min' : 'max';
    }
    return makeRequirement(Object.assign(args, extra || {}));
  }

  function extractLine(line, source, diagnostics) {
    const out = [];
    const text = String(line == null ? '' : line).replace(/\u00a0/g, ' ');
    if (!text.trim() || text.length > 12000) return out;
    if (!source || !source.sheet) {
      const clauses = text.split(/;(?!\d)/).filter(part => part.trim());
      if (clauses.length > 1) {
        for (const clause of clauses) {
          const parsed = extractLine(clause, source, diagnostics);
          parsed.forEach(req => { if (req.source) req.source.excerpt = text.slice(0, 500); });
          out.push.apply(out, parsed);
        }
        return out;
      }
    }
    const used = [];

    // Explicit dimension pairs (e.g. 900 × 2100 мм, 0.9 m x 2.1 m).
    const pairRe = new RegExp('(' + NUM_SRC + ')\\s*(' + UNIT_TOKEN_SRC + ')?\\s*[xх×]\\s*(' + NUM_SRC + ')\\s*(' + UNIT_TOKEN_SRC + ')?', 'giu');
    let match;
    while ((match = pairRe.exec(text))) {
      const unit1 = unitInfo(match[2]), unit2 = unitInfo(match[4]);
      const u1 = unit1 || unit2, u2 = unit2 || unit1;
      const a = parseNumber(match[1]), b = parseNumber(match[3]);
      if (!u1 || !u2 || u1.kind !== 'linear' || u2.kind !== 'linear' || a == null || b == null) continue;
      const prefix = text.slice(Math.max(0, match.index - 90), match.index);
      const context = prefix + ' ' + text.slice(match.index + match[0].length, Math.min(text.length, match.index + match[0].length + 50));
      const explicitAxes = /ширин.{0,35}(?:[xх×]|на).{0,35}высот|height.{0,35}(?:[x×]|by).{0,35}width|width.{0,35}(?:[x×]|by).{0,35}height/iu.test(context);
      const openingContext = /про[её]м|двер|окн|opening|door|window|габарит|dimension|size|размер/iu.test(context);
      const pairDimensions = explicitAxes || openingContext ? ['width', 'height'] : ['first', 'second'];
      const assumptions = explicitAxes ? [] : openingContext ? ['Порядок размеров принят как ширина × высота по контексту документа; проверьте направление.'] : ['Документ не обозначает оси пары размеров; выберите соответствующее измерение вручную.'];
      if (/±|\+\/-|\+-/u.test(text.slice(match.index + match[0].length, match.index + match[0].length + 30))) {
        assumptions.push('Для пары найден допуск, но его распределение по осям неоднозначно и не используется автоматически.');
      }
      out.push({
        id: '', kind: 'pair', dimension: 'pair', values: [
          { value: a, unit: u1.symbol, baseValue: a * u1.factor, dimension: pairDimensions[0] },
          { value: b, unit: u2.symbol, baseValue: b * u2.factor, dimension: pairDimensions[1] }
        ],
        confidence: explicitAxes ? 'high' : openingContext ? 'medium' : 'low',
        needsConfirmation: true, assumptions: assumptions,
        source: sourceCopy(source, text), unitKindMismatch: false
      });
      used.push({ start: match.index, end: match.index + match[0].length });
    }

    // Nominal value ± tolerance, including "900 ± 10 мм" and "0.9 m ± 0.01 m".
    const tolRe = new RegExp('(' + NUM_SRC + ')\\s*(' + UNIT_TOKEN_SRC + ')?\\s*(?:±|\\+\\s*\\/\\s*-|\\+\\s*-)\\s*(' + NUM_SRC + ')\\s*(' + UNIT_TOKEN_SRC + ')?', 'giu');
    while ((match = tolRe.exec(text))) {
      if (overlaps({ start: match.index, end: tolRe.lastIndex }, used)) continue;
      const nominal = parseNumber(match[1]), tolerance = parseNumber(match[3]);
      const nominalUnit = unitInfo(match[2]), toleranceUnit = unitInfo(match[4]);
      const u = nominalUnit || toleranceUnit;
      if (nominal == null || tolerance == null || !u || (nominalUnit && nominalUnit.kind !== u.kind) || (toleranceUnit && toleranceUnit.kind !== u.kind)) continue;
      const label = lastMeaningfulLabel(text, match.index);
      const hint = dimensionHint(label || text, u.kind);
      const req = makeRequirement({
        value: nominal, unit: nominalUnit ? match[2] : match[4], kind: u.kind, dimension: hint.dimension,
        tolerance: tolerance, toleranceUnit: toleranceUnit ? match[4] : (nominalUnit ? match[2] : match[4]),
        toleranceMode: 'symmetric', source: source, excerpt: text, context: text,
        confidence: 'high', assumptions: []
      });
      if (req) out.push(req);
      used.push({ start: match.index, end: match.index + match[0].length });
    }

    // One-sided constraints (maximum/minimum) are only captured with an explicit unit.
    const boundRe = new RegExp('(?:не\\s+(?:более|свыше|выше|менее|ниже)|максимум|минимум|<=|≤|>=|≥)\\s*(' + NUM_SRC + ')\\s*(' + UNIT_TOKEN_SRC + ')', 'giu');
    while ((match = boundRe.exec(text))) {
      if (overlaps({ start: match.index, end: boundRe.lastIndex }, used)) continue;
      const value = parseNumber(match[1]), unit = unitInfo(match[2]);
      if (value == null || !unit) continue;
      const label = lastMeaningfulLabel(text, match.index);
      const hint = dimensionHint(label || text, unit.kind);
      const isMin = /не\s+менее|не\s+ниже|минимум|>=|≥/iu.test(match[0]);
      const req = makeRequirement({
        value, unit: match[2], kind: unit.kind, dimension: hint.dimension,
        bound: value, toleranceMode: isMin ? 'min' : 'max',
        source: source, excerpt: text, context: text,
        confidence: 'high', assumptions: []
      });
      if (req) out.push(req);
      used.push({ start: match.index, end: boundRe.lastIndex });
    }

    // Individual explicitly-unitized values. Values in a tolerance column are not
    // reinterpreted as nominal requirements.
    const valueRe = new RegExp('(' + NUM_SRC + ')\\s*(' + UNIT_TOKEN_SRC + ')', 'giu');
    while ((match = valueRe.exec(text))) {
      if (overlaps({ start: match.index, end: valueRe.lastIndex }, used) || isToleranceContext(text, match.index)) continue;
      const value = parseNumber(match[1]), unit = unitInfo(match[2]);
      if (value == null || !unit) continue;
      const req = createSingle(text, value, match[2], match.index, source);
      if (req) out.push(req);
      used.push({ start: match.index, end: valueRe.lastIndex });
    }

    if (!out.length && /\d/u.test(text) && /(?:ширин|width|высот|height|длин|length|площад|area|допуск|tolerance)/iu.test(text)) {
      diagnostics.unitlessLines++;
    }
    return out;
  }

  function detectHeaderUnit(headers, cells) {
    const headerText = (headers || []).join(' ');
    const cellText = (cells || []).join(' ');
    const found = findUnit(headerText) || findUnit(cellText);
    return found && found.info || null;
  }

  function parseStructuredSheet(sheet, input, diagnostics) {
    const found = [];
    const rows = Array.isArray(sheet && sheet.rows) ? sheet.rows : [];
    if (!rows.length) return found;
    const normalizeRow = r => (Array.isArray(r) ? r : Object.values(r || {})).map(v => String(v == null ? '' : v).trim());
    const normalized = rows.slice(0, 50000).map(normalizeRow);
    const headerCount = Math.min(5, normalized.length);
    let headerIndex = -1;
    let headerScore = -1;
    for (let i = 0; i < headerCount; i++) {
      const t = normalized[i].join(' ');
      let score = 0;
      if (/(?:значен|value|номинал|проект|design|размер|dimension)/iu.test(t)) score += 2;
      if (/(?:допуск|tolerance|лимит|limit)/iu.test(t)) score += 2;
      if (findUnit(t)) score += 1;
      if (score > headerScore) { headerScore = score; headerIndex = i; }
    }
    if (headerScore < 1) headerIndex = 0;
    const headers = normalized[headerIndex] || [];
    const headerText = headers.join(' ');
    const headerUnitInfo = detectHeaderUnit(normalized.slice(0, headerIndex + 1).flat(), []);
    const valueCol = headers.findIndex(h => /(?:значен|value|номинал|проект|design|факт|размер)/iu.test(h));
    const toleranceCol = headers.findIndex(h => /(?:допуск|tolerance|±|погрешн|deviation)/iu.test(h));
    const dimensionColumns = headers.map((h, i) => {
      const hint = dimensionHint(h, null);
      return hint.dimension !== 'unspecified' && !/(?:допуск|tolerance|погрешн|deviation)/iu.test(h) ? { index: i, hint: hint } : null;
    }).filter(Boolean);

    for (let ri = headerIndex + 1; ri < normalized.length; ri++) {
      const row = normalized[ri];
      const rowText = row.join(' | ');
      if (!rowText.trim()) continue;
      const src = Object.assign({}, input.source || {}, { sheet: sheet.name || null, row: ri + 1 });
      const nums = row.map((c, i) => ({ i: i, n: parseNumber(c), raw: c })).filter(x => x.n != null);
      if (!nums.length) continue;
      if (dimensionColumns.length) {
        let columnCount = 0;
        for (const item of dimensionColumns) {
          const cell = row[item.index];
          let value = parseNumber(cell);
          if (value == null && cell) {
            const numeric = new RegExp(NUM_SRC, 'u').exec(String(cell));
            value = numeric ? parseNumber(numeric[0]) : null;
          }
          if (value == null) continue;
          const header = headers[item.index] || '';
          const rowUnit = findUnit(String(cell || '')) || findUnit(rowText);
          const unit = findUnit(header) || rowUnit || (headerUnitInfo ? { info: headerUnitInfo, raw: headerUnitInfo.symbol } : null);
          if (!unit || unit.info.kind !== item.hint.kind) continue;
          let tolerance = null, toleranceUnit = null;
          const matchingToleranceColumn = headers.findIndex((h, ci) => {
            if (ci === item.index || !/(?:допуск|tolerance|±|погрешн|deviation)/iu.test(h)) return false;
            const tolDimension = dimensionHint(h, null).dimension;
            return tolDimension === item.hint.dimension || (dimensionColumns.length === 1 && tolDimension === 'unspecified');
          });
          if (matchingToleranceColumn >= 0) {
            const t = parseNumber(row[matchingToleranceColumn]);
            if (t != null) {
              const tu = findUnit((headers[matchingToleranceColumn] || '') + ' ' + row[matchingToleranceColumn]) ||
                (headerUnitInfo ? { info: headerUnitInfo, raw: headerUnitInfo.symbol } : unit);
              if (tu.info && tu.info.kind === unit.info.kind) { tolerance = t; toleranceUnit = tu.raw || tu.info.symbol; }
            }
          }
          const req = makeRequirement({
            value: value, unit: unit.raw || unit.info.symbol, kind: unit.info.kind,
            dimension: item.hint.dimension, tolerance: tolerance, toleranceUnit: toleranceUnit || unit.raw || unit.info.symbol,
            toleranceMode: tolerance == null ? null : 'symmetric',
            source: src, excerpt: rowText, context: header + ' ' + rowText,
            confidence: 'medium',
            assumptions: headerUnitInfo ? ['Размер и единица взяты из заголовка соответствующего столбца.'] : []
          });
          if (req) { found.push(req); columnCount++; }
        }
        if (columnCount) continue;
      }

      const direct = extractLine(rowText, src, diagnostics);
      found.push.apply(found, direct);
      if (direct.length) continue;

      const labelText = row.filter((c, ci) => ci !== valueCol && ci !== toleranceCol && parseNumber(c) == null).join(' ') + ' ' + headerText + ' ' + (sheet.name || '');
      const hint = dimensionHint(labelText, headerUnitInfo && headerUnitInfo.kind);
      const valueCell = valueCol >= 0 ? parseNumber(row[valueCol]) : nums[0].n;
      const valueIndex = valueCol >= 0 ? valueCol : nums[0].i;
      const unitContext = (headers[valueIndex] || '') + ' ' + row[valueIndex] + ' ' + headerText + ' ' + rowText;
      const unit = findUnit(unitContext) || (headerUnitInfo ? { info: headerUnitInfo, raw: headerUnitInfo.symbol } : null);
      if (valueCell == null || !unit) continue;

      let tolerance = null;
      let toleranceUnit = null;
      if (toleranceCol >= 0) {
        const t = parseNumber(row[toleranceCol]);
        if (t != null) {
          const tu = findUnit((headers[toleranceCol] || '') + ' ' + row[toleranceCol] + ' ' + headerText) || { info: unit.info, raw: unit.raw };
          if (tu.info && tu.info.kind === unit.info.kind) { tolerance = t; toleranceUnit = tu.raw || tu.info.symbol; }
        }
      }

      // A generic pair row is retained as a pair rather than assigning axes silently.
      const useNumbers = valueCol < 0 && toleranceCol < 0 ? nums : [];
      if (useNumbers.length >= 2 && /\b(?:size|dimension|габарит|размер|про[её]м|opening|door|window)\b/iu.test(labelText)) {
        const n1 = useNumbers[0].n, n2 = useNumbers[1].n;
        const pairUnit = unit.info;
        if (pairUnit.kind === 'linear') {
          found.push({
            id: '', kind: 'pair', dimension: 'pair',
            values: [
              { value: n1, unit: pairUnit.symbol, baseValue: n1 * pairUnit.factor, dimension: 'first' },
              { value: n2, unit: pairUnit.symbol, baseValue: n2 * pairUnit.factor, dimension: 'second' }
            ],
            confidence: 'low', needsConfirmation: true,
            assumptions: ['Оси двух значений не указаны явно.'], source: sourceCopy(src, rowText), unitKindMismatch: false
          });
        }
        continue;
      }

      const req = makeRequirement({
        value: valueCell, unit: unit.raw || unit.info.symbol, kind: unit.info.kind,
        dimension: hint.dimension, tolerance: tolerance, toleranceUnit: toleranceUnit || unit.raw || unit.info.symbol,
        toleranceMode: tolerance == null ? null : 'symmetric',
        source: src, excerpt: rowText, context: labelText,
        confidence: 'medium',
        assumptions: headerUnitInfo ? ['Единица взята из заголовка таблицы; проверьте заголовок.'] : []
      });
      if (req) found.push(req);
    }
    return found;
  }

  function stableId(req, index) {
    const s = req.source || {};
    return [s.documentId || '', s.sheet || '', s.row || '', s.line || '', req.dimension || '', req.kind || '', req.baseValue || (req.values || []).map(v => v.baseValue).join(',') || '', index].join(':');
  }

  function extractRequirements(input) {
    input = input || {};
    const diagnostics = { scannedLines: 0, scannedRows: 0, unitlessLines: 0, truncated: !!input.textTruncated, parseErrors: [] };
    const requirements = [];
    const source = {
      documentId: input.documentId || input.source && input.source.documentId || null,
      documentName: input.documentName || input.source && input.source.documentName || null,
      ocr: !!input.ocr || !!(input.source && input.source.ocr),
      truncated: !!input.textTruncated || !!(input.source && input.source.truncated)
    };
    const sheets = Array.isArray(input.sheets) ? input.sheets : [];
    for (const sheet of sheets) {
      const reqs = parseStructuredSheet(sheet, { source }, diagnostics);
      diagnostics.scannedRows += Array.isArray(sheet.rows) ? sheet.rows.length : 0;
      requirements.push.apply(requirements, reqs);
    }
    const text = typeof input.text === 'string' ? input.text : '';
    // For sheets, the row grid is the authoritative structured content; parser text
    // is usually the same cells flattened again. Avoid creating duplicate candidates.
    if (text && !sheets.length) {
      let page = null;
      let pendingHeader = null;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const pageMatch = /(?:===\s*)?(?:страница|page)\s+(\d+)(?:\s*===)?/iu.exec(lines[i]);
        if (pageMatch) { page = Number(pageMatch[1]); pendingHeader = null; continue; }
        if (pendingHeader && i - pendingHeader.line > 2) pendingHeader = null;
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        const lineSource = Object.assign({}, source, { line: i + 1, page: page });
        const headerUnit = findUnit(lines[i]);
        const headerHint = headerUnit ? dimensionHint(lines[i], headerUnit.info.kind) : null;
        const isUnitHeader = !!(headerUnit && headerHint && headerHint.dimension !== 'unspecified' && !new RegExp(NUM_SRC, 'u').test(lines[i]) && !/(?:допуск|tolerance|погрешн)/iu.test(lines[i]));
        if (isUnitHeader) {
          pendingHeader = { line: i + 1, text: trimmed, unit: headerUnit.info, dimension: headerHint.dimension };
          diagnostics.scannedLines++;
          continue;
        }
        let usedHeader = false;
        if (pendingHeader) {
          const bare = new RegExp('^\\s*(' + NUM_SRC + ')(?:\\s*(?:±|\\+\\s*\\/\\s*-|\\+\\s*-)\\s*(' + NUM_SRC + '))?\\s*$', 'iu').exec(trimmed);
          if (bare) {
            const value = parseNumber(bare[1]);
            const tolerance = bare[2] == null ? null : parseNumber(bare[2]);
            if (value != null && (tolerance == null || tolerance >= 0)) {
              const req = makeRequirement({
                value: value, unit: pendingHeader.unit.symbol, kind: pendingHeader.unit.kind,
                dimension: pendingHeader.dimension, tolerance: tolerance,
                toleranceUnit: pendingHeader.unit.symbol, toleranceMode: tolerance == null ? null : 'symmetric',
                source: lineSource, excerpt: pendingHeader.text + ' → ' + trimmed,
                confidence: 'medium',
                assumptions: ['Единица взята из непосредственно предшествующего заголовка; проверьте исходный документ.']
              });
              if (req) { requirements.push(req); usedHeader = true; }
            }
          }
          pendingHeader = null;
        }
        if (!usedHeader) requirements.push.apply(requirements, extractLine(lines[i], lineSource, diagnostics));
        diagnostics.scannedLines++;
      }
    }

    // Remove true duplicates caused by parsers exposing both a sheet grid and
    // its flattened text, while retaining separate references in different rows.
    const seen = new Set();
    const unique = [];
    for (const req of requirements) {
      if (!req || !req.kind) continue;
      const src = req.source || {};
      const valueKey = req.kind === 'pair'
        ? req.values.map(v => Number(v.baseValue).toPrecision(12)).join(',')
        : Number(req.baseValue).toPrecision(12);
      const key = [src.documentId || '', req.kind, req.dimension, valueKey, req.tolerance == null ? '' : Number(req.tolerance).toPrecision(12), src.sheet || '', src.row || '', String(src.excerpt || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 180)].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(req);
    }
    unique.forEach((req, i) => { req.id = stableId(req, i); });
    return { requirements: unique.slice(0, 800), diagnostics: diagnostics };
  }

  function parseDelimitedText(text) {
    const input = String(text == null ? '' : text);
    const sample = input.slice(0, 8192);
    const candidates = [',', ';', '\t'];
    let delimiter = ',';
    let best = -1;
    for (const c of candidates) {
      const score = sample.split(/\r?\n/).slice(0, 12).reduce((n, line) => n + (line.split(c).length - 1), 0);
      if (score > best) { best = score; delimiter = c; }
    }
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (quoted) {
        if (ch === '"' && input[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"' && cell.length === 0) quoted = true;
      else if (ch === delimiter) { row.push(cell.trim()); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && input[i + 1] === '\n') i++;
        row.push(cell.trim()); cell = '';
        if (row.some(v => v !== '')) rows.push(row);
        row = [];
      } else cell += ch;
      if (rows.length >= 50000) break;
    }
    row.push(cell.trim());
    if (row.some(v => v !== '') && rows.length < 50000) rows.push(row);
    return rows;
  }

  function measurementFields(measurement) {
    const m = measurement || {};
    const num = (value) => typeof value === 'number' && Number.isFinite(value);
    const fields = [];
    const add = (key, label, value, kind) => { if (num(value)) fields.push({ key, label, value, kind }); };
    switch (m.mode) {
      case 'distance':
        add('perp', m.perpKind === 'edges' ? 'Расстояние между рёбрами (⊥)' : m.perpKind === 'point-plane' ? 'Расстояние до плоскости (⊥)' : 'Расстояние между плоскостями (⊥)', m.perp, 'linear');
        add('distance3d', 'Полная длина (3D)', m.d3, 'linear');
        add('horizontal', 'Горизонтальная проекция', m.horizontal, 'linear');
        add('vertical', 'Перепад высоты', m.vertical, 'linear');
        add('deltaX', 'Абсолютный ΔX', typeof m.dx === 'number' ? Math.abs(m.dx) : null, 'linear');
        add('deltaY', 'Абсолютный ΔY', typeof m.dy === 'number' ? Math.abs(m.dy) : null, 'linear');
        add('deltaZ', 'Абсолютный ΔZ', typeof m.dz === 'number' ? Math.abs(m.dz) : null, 'linear');
        add('slope', 'Уклон', m.grade, 'slope');
        break;
      case 'polyline':
        add('length', 'Длина полилинии', m.total, 'linear');
        break;
      case 'plane':
        add('length', 'Длинная сторона плоскости', m.length, 'linear');
        add('width', 'Короткая сторона плоскости', m.width, 'linear');
        add('area', 'Площадь прямоугольника плоскости', m.rectArea, 'area');
        break;
      case 'area':
        add('area', 'Площадь контура', m.area, 'area');
        add('perimeter', 'Периметр контура', m.perimeter, 'linear');
        break;
      case 'angle':
        add('angle', 'Угол по трём точкам', m.deg, 'angle');
        break;
      case 'corner':
        add('angle', 'Двугранный угол', m.angleDeg, 'angle');
        break;
      case 'deviation':
        if (typeof m.signed === 'number') add('gap', 'Абсолютный зазор', Math.abs(m.signed), 'linear');
        break;
      default:
        break;
    }
    return fields;
  }

  function suggestField(requirement, fields) {
    fields = Array.isArray(fields) ? fields : [];
    const d = requirement && requirement.dimension;
    const byKey = key => fields.find(f => f.key === key);
    if (d === 'width') return byKey('width') || byKey('perp') || byKey('horizontal') || byKey('distance3d') || fields.find(f => f.kind === (requirement && requirement.kind));
    if (d === 'height') return byKey('perp') && byKey('vertical') ? byKey('perp') : byKey('vertical') || byKey('height') || byKey('length') || fields.find(f => f.kind === (requirement && requirement.kind));
    if (d === 'length') return byKey('length') || byKey('perp') || byKey('distance3d') || byKey('perimeter') || fields.find(f => f.kind === (requirement && requirement.kind));
    if (d === 'thickness' || d === 'diameter' || d === 'gap') return byKey('gap') || byKey('perp') || byKey('distance3d') || fields.find(f => f.kind === (requirement && requirement.kind));
    if (d === 'angle') return byKey('angle');
    if (d === 'area') return byKey('area');
    if (d === 'slope') return byKey('slope');
    if (requirement && requirement.kind === 'pair' && fields.filter(f => f.kind === 'linear').length >= 2) return fields.filter(f => f.kind === 'linear')[0];
    return fields.find(f => f.kind === (requirement && requirement.kind)) || fields[0] || null;
  }

  /* Какому размеру из документа отвечает поле измерения.
   * Ось «вверх» в приложении — Y, поэтому ΔY — это высота, а ΔX и ΔZ — горизонтальные проекции; они годятся только для
   * ручного выбора (auto:false), иначе горизонтальный замер «по ΔY = 0» подходил бы под любое требование.
   * Вертикальный замер — это высота, горизонтальный — ширина или длина, наклонный — длина. */
  function measurementOrientation(measurement) {
    if (!measurement || measurement.mode !== 'distance') return 'diagonal';
    const d3 = Number(measurement.d3), h = Number(measurement.horizontal), v = Math.abs(Number(measurement.dy));
    if (!(d3 > 0)) return 'diagonal';
    if (h / d3 <= 0.2) return 'vertical';
    if (v / d3 <= 0.2) return 'horizontal';
    return 'diagonal';
  }
  function measurementFieldDimensions(field, measurement) {
    const key = field && field.key;
    const mode = measurement && measurement.mode;
    const orient = measurementOrientation(measurement);
    const vert = orient === 'vertical', hor = orient === 'horizontal';
    const map = {
      perp: vert ? { primary: 'height', compatible: ['length', 'gap', 'thickness'] } : { primary: ['width', 'length', 'thickness'], compatible: ['gap', 'diameter'] },
      distance3d: vert ? { primary: 'height', compatible: ['length', 'gap', 'thickness'] }
        : hor ? { primary: ['width', 'length'], compatible: ['thickness', 'diameter', 'gap'] }
          : { primary: 'length', compatible: ['width', 'height', 'thickness', 'diameter', 'gap'] },
      horizontal: { primary: ['width', 'length'], compatible: ['diameter', 'gap', 'thickness'] },
      vertical: { primary: 'height', compatible: ['length', 'gap', 'thickness'] },
      deltaX: { primary: ['width', 'length'], compatible: ['thickness', 'diameter', 'gap'], auto: false },
      deltaY: { primary: 'height', compatible: ['length', 'gap', 'thickness'], auto: false },
      deltaZ: { primary: ['width', 'length'], compatible: ['thickness', 'diameter', 'gap'], auto: false },
      length: { primary: 'length', compatible: mode === 'plane' ? ['height'] : ['width', 'height'] },
      width: { primary: 'width', compatible: ['thickness', 'diameter', 'gap'] },
      area: { primary: 'area', compatible: [] },
      perimeter: { primary: 'length', compatible: [] },
      angle: { primary: 'angle', compatible: [] },
      slope: { primary: 'slope', compatible: [] },
      gap: { primary: 'gap', compatible: ['thickness', 'diameter'] }
    };
    const prof = map[key] || {
      primary: field && field.kind === 'area' ? 'area' : field && field.kind === 'angle' ? 'angle' : field && field.kind === 'slope' ? 'slope' : 'unspecified',
      compatible: []
    };
    const primaries = [].concat(prof.primary);
    return { primary: primaries[0], primaries: primaries, compatible: prof.compatible, auto: prof.auto !== false, orientation: orient };
  }

  function suggestMeasurementUnit(sourceUnits, kind) {
    if (kind === 'angle') return { unit: '°', source: 'intrinsic', autoConfirm: true };
    if (kind === 'slope') return { unit: '%', source: 'intrinsic', autoConfirm: true };
    const source = unitInfo(sourceUnits);
    if (!source) return { unit: null, source: 'unknown', autoConfirm: false };
    if (kind === 'linear' && source.kind === 'linear') {
      return { unit: source.symbol, source: 'metadata', autoConfirm: true };
    }
    if (kind === 'area') {
      if (source.kind === 'area') return { unit: source.symbol, source: 'metadata', autoConfirm: true };
      if (source.kind === 'linear') {
        const squared = { 'мм': 'мм²', 'см': 'см²', 'м': 'м²', ft: 'ft²', in: 'in²' }[source.symbol] || null;
        if (squared) return { unit: squared, source: 'metadata-derived-area', autoConfirm: true };
      }
    }
    return { unit: null, source: 'incompatible', autoConfirm: false };
  }

  function categoryRelationship(left, right) {
    const a = Array.isArray(left) ? left : [];
    const b = Array.isArray(right) ? right : [];
    if (!a.length || !b.length) return 'unknown';
    if (a.some(value => b.includes(value))) return 'match';
    for (const value of a) {
      const compatible = CATEGORY_COMPATIBILITY[value] || [];
      if (compatible.some(item => b.includes(item))) return 'compatible';
    }
    // "equipment" is generic and must not turn a specific MEP category into a
    // false contradiction.
    if (a.includes('equipment') || b.includes('equipment')) return 'unknown';
    return 'conflict';
  }

  function semanticOverlap(leftTokens, rightTokens) {
    const left = new Set(leftTokens || []);
    const right = new Set(rightTokens || []);
    if (!left.size || !right.size) return { count: 0, ratio: 0, tokens: [] };
    const tokens = [];
    left.forEach(value => { if (right.has(value)) tokens.push(value); });
    return {
      count: tokens.length,
      ratio: tokens.length / Math.max(1, Math.min(left.size, right.size)),
      tokens: tokens.slice(0, 8)
    };
  }

  function requirementParts(requirement) {
    if (!requirement) return [];
    if (requirement.kind !== 'pair') return [{ requirement: requirement, pairIndex: null }];
    return (Array.isArray(requirement.values) ? requirement.values : []).map((value, pairIndex) => ({
      pairIndex: pairIndex,
      requirement: Object.assign({}, requirement, {
        kind: 'linear',
        dimension: value.dimension || 'unspecified',
        baseValue: value.baseValue,
        value: value.value,
        unit: value.unit,
        tolerance: null,
        toleranceValue: null,
        toleranceUnit: null,
        toleranceMode: null,
        bound: null
      })
    }));
  }

  function dimensionCompatibility(dimension, field, measurement) {
    const profile = measurementFieldDimensions(field, measurement);
    if (!dimension || dimension === 'unspecified' || dimension === 'first' || dimension === 'second') {
      return { tier: 'ambiguous', points: 3, exact: false, profile: profile };
    }
    if (profile.primaries.includes(dimension)) return { tier: 'exact', points: 24, exact: true, profile: profile };
    if (profile.compatible.includes(dimension)) return { tier: 'compatible', points: 13, exact: false, profile: profile };
    return { tier: 'conflict', points: -22, exact: false, profile: profile };
  }

  function finiteTolerance(requirement) {
    return (requirement.toleranceMode === 'symmetric' && Number.isFinite(requirement.tolerance)) ||
      ((requirement.toleranceMode === 'max' || requirement.toleranceMode === 'min') && Number.isFinite(requirement.bound));
  }

  function valuePlausibility(field, requirement, unit) {
    const info = unitInfo(unit);
    if (!field || !info || !Number.isFinite(field.value) || !Number.isFinite(requirement && requirement.baseValue)) return 0;
    const actual = Math.abs(field.value * info.factor);
    const expected = Math.abs(requirement.baseValue);
    if (actual === 0 && expected === 0) return 4;
    if (!(actual > 0) || !(expected > 0)) return 0;
    const logRatio = Math.abs(Math.log(actual / expected));
    if (logRatio <= Math.log(1.05)) return 4;
    if (logRatio <= Math.log(1.25)) return 3;
    if (logRatio <= Math.log(2)) return 1;
    if (logRatio >= Math.log(100)) return -4;
    return 0;
  }

  function rankRequirementMatches(args) {
    args = args || {};
    const measurement = args.measurement || {};
    const context = Object.assign({}, measurement.measurementContext || {}, args.context || {});
    const candidates = Array.isArray(args.candidates) ? args.candidates : [];
    const fields = Array.isArray(args.fields) ? args.fields : measurementFields(measurement);
    const measurementText = [
      measurement.label, context.elementName, context.elementType, context.elementGuid
    ].filter(Boolean).join(' ');
    const measurementTokens = tokenizeSemanticText(measurementText);
    const roomTokens = tokenizeSemanticText(context.roomName || '');
    const measurementCategories = detectObjectCategories(measurementText);
    const matches = [];

    candidates.forEach((candidate, candidateIndex) => {
      const entry = candidate && candidate.requirement ? candidate : { requirement: candidate, doc: null };
      const requirement = entry.requirement;
      if (!requirement) return;
      const doc = entry.doc || {};
      const source = requirement.source || {};
      const requirementText = [source.excerpt, source.documentName, doc.name, doc.type].filter(Boolean).join(' ');
      const requirementTokens = tokenizeSemanticText(requirementText);
      const requirementCategories = detectObjectCategories(requirementText);
      const category = categoryRelationship(measurementCategories, requirementCategories);
      const overlap = semanticOverlap(measurementTokens, requirementTokens);
      const roomOverlap = semanticOverlap(roomTokens, requirementTokens);
      const exactElementLink = !!(context.elementId && doc.element_id && String(context.elementId) === String(doc.element_id));
      const conflictingElementLink = !!(context.elementId && doc.element_id && String(context.elementId) !== String(doc.element_id));

      for (const part of requirementParts(requirement)) {
        const selectedRequirement = part.requirement;
        for (const field of fields) {
          if (!field || field.kind !== selectedRequirement.kind) continue;
          if (!args.allFields && measurementFieldDimensions(field, measurement).auto === false) continue;
          const unitSuggestion = suggestMeasurementUnit(args.sourceUnits != null ? args.sourceUnits : context.sourceUnits, field.kind);
          const dimension = dimensionCompatibility(selectedRequirement.dimension, field, measurement);
          let score = 8 + dimension.points;
          const reasonCodes = [];
          const warningCodes = [];
          const reasons = [];
          const warnings = [];

          if (dimension.tier === 'exact') {
            reasonCodes.push('dimension_exact'); reasons.push('Размер документа совпадает с измеряемым полем.');
          } else if (dimension.tier === 'compatible') {
            reasonCodes.push('dimension_compatible'); reasons.push('Геометрия измерения совместима с типом размера.');
          } else if (dimension.tier === 'ambiguous') {
            warningCodes.push('dimension_ambiguous'); warnings.push('В документе не обозначена ось размера.');
          } else {
            warningCodes.push('dimension_conflict'); warnings.push('Обозначение размера не соответствует выбранному полю.');
          }

          if (exactElementLink) {
            score += 28; reasonCodes.push('element_link'); reasons.push('Документ прямо привязан к выбранному элементу.');
          } else if (conflictingElementLink) {
            score -= 30; warningCodes.push('linked_to_other_element'); warnings.push('Документ привязан к другому элементу.');
          }

          if (category === 'match') {
            score += 18; reasonCodes.push('category_match'); reasons.push('Тип объекта совпадает с контекстом требования.');
          } else if (category === 'compatible') {
            score += 10; reasonCodes.push('category_compatible'); reasons.push('Типы объекта и требования совместимы.');
          } else if (category === 'conflict') {
            score -= 24; warningCodes.push('object_conflict'); warnings.push('Требование похоже на другой тип объекта.');
          }

          if (overlap.count) {
            const semanticPoints = Math.min(14, 4 + overlap.count * 3 + Math.round(overlap.ratio * 3));
            score += semanticPoints;
            reasonCodes.push('semantic_overlap');
            reasons.push('Совпали ключевые слова: ' + overlap.tokens.join(', ') + '.');
          }
          if (roomOverlap.count) {
            score += Math.min(5, 2 + roomOverlap.count);
            reasonCodes.push('room_context');
            reasons.push('Источник содержит контекст помещения.');
          }

          if (requirement.confidence === 'high') {
            score += 9; reasonCodes.push('explicit_requirement'); reasons.push('Размер и единица явно извлечены из источника.');
          } else if (requirement.confidence === 'medium') {
            score += 4;
          } else if (requirement.confidence === 'low') {
            score -= 8; warningCodes.push('low_extraction_confidence'); warnings.push('Извлечение требования имеет низкую уверенность.');
          } else if (requirement.confidence === 'manual') {
            score -= 3; warningCodes.push('manual_requirement'); warnings.push('Требование введено вручную.');
          }

          if (finiteTolerance(selectedRequirement)) {
            score += 4; reasonCodes.push('explicit_tolerance'); reasons.push('В источнике указан явный допуск или предел.');
          }
          if (unitSuggestion.unit) {
            score += 4;
            reasonCodes.push(unitSuggestion.source === 'intrinsic' ? 'intrinsic_unit' : 'units_from_metadata');
            reasons.push(unitSuggestion.source === 'intrinsic' ? 'Единица задана самим типом измерения.' : 'Единица подтверждается метаданными облака.');
          } else {
            score -= 7; warningCodes.push('units_unknown'); warnings.push('Метаданные не подтверждают единицу фактического измерения.');
          }
          if (source.ocr) {
            score -= 12; warningCodes.push('ocr_source'); warnings.push('Текст получен OCR и требует проверки по оригиналу.');
          }
          if (source.truncated) {
            score -= 14; warningCodes.push('truncated_source'); warnings.push('Извлечённый текст документа был сокращён.');
          }
          if (Array.isArray(requirement.assumptions) && requirement.assumptions.length) {
            score -= Math.min(6, requirement.assumptions.length * 2);
            warningCodes.push('parser_assumptions');
          }

          const plausibility = valuePlausibility(field, selectedRequirement, unitSuggestion.unit);
          score += plausibility;
          if (plausibility > 0) {
            reasonCodes.push('value_plausible');
            reasons.push('Значения находятся в правдоподобном масштабе.');
          }

          score = Math.max(0, Math.min(100, Math.round(score)));
          const scopeSafe = exactElementLink || (category === 'match' && overlap.count > 0);
          const dimensionSafe = dimension.tier === 'exact' ||
            (dimension.tier === 'compatible' && exactElementLink && overlap.count > 0);
          const sourceSafe = !source.ocr && !source.truncated &&
            requirement.confidence !== 'low' && requirement.confidence !== 'manual' &&
            !(requirement.kind === 'pair' && (
              ['first', 'second', 'unspecified'].includes(selectedRequirement.dimension) ||
              (Array.isArray(requirement.assumptions) && requirement.assumptions.length > 0)
            ));
          const autoConfirmEligible = score >= 78 && scopeSafe && dimensionSafe &&
            unitSuggestion.autoConfirm && sourceSafe && !conflictingElementLink && category !== 'conflict';
          const preview = unitSuggestion.unit ? compareMeasurement({
            measurement: measurement,
            requirement: requirement,
            fields: fields,
            fieldKey: field.key,
            pairIndex: part.pairIndex == null ? 0 : part.pairIndex,
            unit: unitSuggestion.unit,
            requirementConfirmed: true,
            unitConfirmed: true
          }) : null;

          matches.push({
            candidateIndex: candidateIndex,
            candidate: candidate,
            entry: entry,
            requirement: requirement,
            selectedRequirement: selectedRequirement,
            field: field,
            pairIndex: part.pairIndex,
            unit: unitSuggestion.unit,
            unitSource: unitSuggestion.source,
            score: score,
            confidence: score >= 78 ? 'high' : score >= 55 ? 'medium' : 'low',
            autoConfirmEligible: autoConfirmEligible,
            reasons: reasons.slice(0, 8),
            warnings: warnings.slice(0, 8),
            reasonCodes: reasonCodes,
            warningCodes: warningCodes,
            signals: {
              dimension: dimension.tier,
              category: category,
              exactElementLink: exactElementLink,
              conflictingElementLink: conflictingElementLink,
              semanticTokens: overlap.tokens
            },
            preview: preview
          });
        }
      }
    });

    matches.sort((a, b) => b.score - a.score || a.candidateIndex - b.candidateIndex || String(a.field.key).localeCompare(String(b.field.key)));
    const best = matches[0] || null;
    const second = matches[1] || null;
    const margin = best ? (second ? best.score - second.score : 100) : 0;
    if (best && margin < 10) {
      best.warningCodes = best.warningCodes.concat('ambiguous_candidates');
      best.warnings = best.warnings.concat('Есть близкий по рейтингу альтернативный вариант.');
    }
    const canAutoConfirm = !!(best && best.autoConfirmEligible && margin >= 10);
    if (best) best.canAutoConfirm = canAutoConfirm;
    const decision = {
      state: !best ? 'no-match' : canAutoConfirm ? 'auto-confirmed' : margin < 10 ? 'ambiguous' : 'needs-review',
      canAutoConfirm: canAutoConfirm,
      score: best ? best.score : 0,
      confidence: best ? best.confidence : 'low',
      margin: margin,
      reasons: best ? best.reasons.slice() : [],
      warnings: best ? best.warnings.slice() : ['Совместимое требование в документах не найдено.']
    };
    return { matches: matches, best: best, margin: margin, decision: decision };
  }

  function compareMeasurement(args) {
    args = args || {};
    const requirement = args.requirement;
    const measurement = args.measurement;
    const field = (args.fields || measurementFields(measurement)).find(f => f.key === args.fieldKey);
    const base = {
      status: 'needs-review',
      actual: null, expected: null, delta: null, absoluteDelta: null, percentDelta: null,
      fieldKey: field && field.key || args.fieldKey || null,
      unit: args.unit || null,
      requirementId: requirement && requirement.id || null,
      message: ''
    };
    if (!requirement || !measurement || !field) {
      base.message = 'Не выбраны измерение или поле для сравнения.';
      return base;
    }
    if (requirement.needsConfirmation && args.requirementConfirmed !== true) {
      base.message = 'Подтвердите, что найденное в документе требование относится к этому элементу.';
      return base;
    }
    if (args.unitConfirmed !== true) {
      base.status = 'units-unconfirmed';
      base.message = 'Единицы/масштаб измерения не подтверждены.';
      return base;
    }
    let selectedRequirement = requirement;
    if (requirement.kind === 'pair') {
      const part = Number(args.pairIndex);
      const pairValue = Array.isArray(requirement.values) ? requirement.values[part] : null;
      if (!pairValue) {
        base.message = 'Укажите, какой размер пары сопоставлять.';
        return base;
      }
      selectedRequirement = Object.assign({}, requirement, {
        kind: 'linear', dimension: pairValue.dimension || 'unspecified',
        baseValue: pairValue.baseValue, value: pairValue.value, unit: pairValue.unit,
        tolerance: null, toleranceMode: null
      });
      base.pairIndex = part;
    }
    if (field.kind !== selectedRequirement.kind) {
      base.status = 'unit-mismatch';
      base.message = 'Типы данных не совпадают: измерение ' + field.kind + ', требование ' + selectedRequirement.kind + '.';
      return base;
    }
    const actualUnit = unitInfo(args.unit);
    if (!actualUnit || actualUnit.kind !== field.kind) {
      base.status = 'unit-mismatch';
      base.message = 'Выбранная единица несовместима с измерением.';
      return base;
    }
    if (!Number.isFinite(field.value) || !Number.isFinite(selectedRequirement.baseValue)) {
      base.message = 'Нет корректного числового значения для сравнения.';
      return base;
    }
    const actual = field.value * actualUnit.factor;
    const expected = selectedRequirement.baseValue;
    const delta = actual - expected;
    base.actual = actual;
    base.expected = expected;
    base.delta = delta;
    base.absoluteDelta = Math.abs(delta);
    base.percentDelta = expected !== 0 ? delta / Math.abs(expected) * 100 : null;
    base.actualRaw = field.value;
    base.expectedRaw = selectedRequirement.value;
    base.expectedUnit = selectedRequirement.unit;
    base.tolerance = Number.isFinite(selectedRequirement.tolerance) ? selectedRequirement.tolerance : null;
    base.toleranceMode = selectedRequirement.toleranceMode || null;
    base.bound = Number.isFinite(selectedRequirement.bound) ? selectedRequirement.bound : null;
    base.dimension = selectedRequirement.dimension || 'unspecified';
    base.kind = selectedRequirement.kind;
    if (selectedRequirement.toleranceMode === 'symmetric' && Number.isFinite(selectedRequirement.tolerance)) {
      base.status = base.absoluteDelta <= selectedRequirement.tolerance + 1e-12 ? 'within-tolerance' : 'outside-tolerance';
      base.message = base.status === 'within-tolerance' ? 'Измерение в пределах указанного допуска.' : 'Измерение вне указанного допуска.';
    } else if (selectedRequirement.toleranceMode === 'max' && Number.isFinite(selectedRequirement.bound)) {
      base.status = actual <= selectedRequirement.bound + 1e-12 ? 'within-tolerance' : 'outside-tolerance';
      base.message = base.status === 'within-tolerance' ? 'Измерение не превышает заданный максимум.' : 'Измерение превышает заданный максимум.';
    } else if (selectedRequirement.toleranceMode === 'min' && Number.isFinite(selectedRequirement.bound)) {
      base.status = actual >= selectedRequirement.bound - 1e-12 ? 'within-tolerance' : 'outside-tolerance';
      base.message = base.status === 'within-tolerance' ? 'Измерение не ниже заданного минимума.' : 'Измерение ниже заданного минимума.';
    } else {
      base.status = 'tolerance-not-specified';
      base.message = 'Разница рассчитана, но в источнике не указан допуск — статус соответствия не присвоен.';
    }
    return base;
  }

  function formatBaseValue(value, kind, displayUnit) {
    const info = unitInfo(displayUnit);
    if (!info || info.kind !== kind || !Number.isFinite(value)) return null;
    const precision = info.factor >= 1 ? 4 : info.factor >= 0.01 ? 2 : 1;
    return (value / info.factor).toFixed(precision) + ' ' + info.symbol;
  }

  return {
    unitInfo, findUnit, parseNumber, parseDelimitedText, dimensionHint,
    normalizeSemanticText, tokenizeSemanticText, detectObjectCategories,
    extractRequirements, measurementFields, measurementFieldDimensions, measurementOrientation, suggestField,
    suggestMeasurementUnit, rankRequirementMatches, compareMeasurement, formatBaseValue
  };
});