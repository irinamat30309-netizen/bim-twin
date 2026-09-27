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
      excerpt: String(excerpt == null ? '' : excerpt).slice(0, 500)
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
      documentName: input.documentName || input.source && input.source.documentName || null
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
    if (d === 'width') return byKey('width') || byKey('horizontal') || byKey('distance3d') || fields.find(f => f.kind === (requirement && requirement.kind));
    if (d === 'height') return byKey('vertical') || byKey('height') || byKey('length') || fields.find(f => f.kind === (requirement && requirement.kind));
    if (d === 'length') return byKey('length') || byKey('distance3d') || byKey('perimeter') || fields.find(f => f.kind === (requirement && requirement.kind));
    if (d === 'thickness' || d === 'diameter' || d === 'gap') return byKey('gap') || byKey('distance3d') || fields.find(f => f.kind === (requirement && requirement.kind));
    if (d === 'angle') return byKey('angle');
    if (d === 'area') return byKey('area');
    if (d === 'slope') return byKey('slope');
    if (requirement && requirement.kind === 'pair' && fields.filter(f => f.kind === 'linear').length >= 2) return fields.filter(f => f.kind === 'linear')[0];
    return fields.find(f => f.kind === (requirement && requirement.kind)) || fields[0] || null;
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
    extractRequirements, measurementFields, suggestField, compareMeasurement, formatBaseValue
  };
});