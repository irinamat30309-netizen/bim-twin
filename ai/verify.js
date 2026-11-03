'use strict';
/*
 * Verification engine (Phase C, C2/C3). Rule-based normocontrol that compares
 * BIM model elements against parsed document text and a design-intent map, and
 * produces findings (err/warn/ok) with confidence. An optional LLM verifier can
 * be plugged in for ambiguous cases (see ai/llm.js); offline it is skipped.
 */
const RANK = { none: 0, ok: 1, warn: 2, err: 3 };
const gid = () => 'f_' + Math.random().toString(36).slice(2, 9);

function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[×хХx]/g, 'x').replace(/\s+/g, ' ').trim(); }
function num(x) { const n = parseFloat(String(x).replace(',', '.').replace(/[^\d.]/g, '')); return isNaN(n) ? null : n; }

function extractDims(t) { const out = []; const re = /(\d{2,4})\s*[xхХ×]\s*(\d{2,4})/gi; let m; while ((m = re.exec(t))) out.push(m[1] + 'x' + m[2]); return out; }
function extractFire(t) { const m = /EI[-\s]?(\d{2,3})/i.exec(t); return m ? ('EI-' + m[1]) : null; }
function extractDiam(t) { const m = /[ØøΦϕ]\s?(\d{2,4})/.exec(t) || /\bDN\s?(\d{2,4})/i.exec(t); return m ? ('Ø' + m[1]) : null; }

function mk(el, docId, kind, severity, confidence, text, source) {
  return { id: gid(), element_id: el.id, document_id: docId || null, kind, severity, confidence, text, source: source || 'rule', review: 'open', comments: [] };
}

function verifyElement(el, docs, intent) {
  const findings = [];
  const allText = docs.map(d => d.text || '').join('\n');
  const nText = norm(allText);
  const it = (intent && intent[el.id]) || {};
  const primaryDoc = docs[0] ? docs[0].id : null;

  // Rule 1: duct/section mismatch (design vs model)
  if (it.section && it.model_section && norm(it.section) !== norm(it.model_section)) {
    findings.push(mk(el, primaryDoc, 'Сечение воздуховода', 'err', 0.92,
      `На чертеже ${it.section} мм, в модели ${it.model_section} мм — расхождение с проектом.`));
  }
  // Rule 2: load vs floor limit
  if (it.load_kg != null && it.floor_limit_kg) {
    const ratio = it.load_kg / it.floor_limit_kg;
    if (ratio > 1) findings.push(mk(el, primaryDoc, 'Перегрузка перекрытия', 'err', 0.9, `Нагрузка ${it.load_kg} кг превышает предел ${it.floor_limit_kg} кг.`));
    else if (ratio >= 0.9) findings.push(mk(el, primaryDoc, 'Нагрузка на перекрытие', 'warn', 0.72, `Нагрузка ${it.load_kg} кг близка к пределу ${it.floor_limit_kg} кг (${Math.round(ratio * 100)}%).`));
  }
  // Rule 3: glazing / area deviation
  if (it.area_design != null && it.area_model != null && it.area_design > 0) {
    const d = (it.area_model - it.area_design) / it.area_design;
    if (Math.abs(d) >= 0.05) findings.push(mk(el, primaryDoc, 'Площадь остекления', 'warn', 0.68, `Отклонение площади на ${Math.round(d * 100)}% от проектной (${it.area_model} vs ${it.area_design} м²).`));
  }
  // Rule 4: fire rating for doors present in docs but missing on model
  if (el.type === 'дверь') {
    const fr = extractFire(allText);
    if (fr && !el.fire_rating) findings.push(mk(el, primaryDoc, 'Класс огнестойкости', 'warn', 0.7, `В документе указан ${fr}, у элемента модели класс не задан — уточнить.`));
  }
  // Rule 5: document coverage (data-driven from parsed text)
  const hasIssue = findings.some(f => f.severity === 'err' || f.severity === 'warn');
  if (docs.length && !hasIssue) {
    const token = (String(el.name).match(/[A-ZА-Я]{1,5}-?\d+/i) || [])[0];
    const mentioned = nText.includes(norm(el.id)) || nText.includes(norm(el.name)) || (token && nText.includes(norm(token)));
    if (mentioned) findings.push(mk(el, primaryDoc, 'Соответствие документам', 'ok', 0.8, `«${el.name}» найден в документах, критичных расхождений не найдено.`));
    else findings.push(mk(el, primaryDoc, 'Нет в документах', 'warn', 0.5, `«${el.name}» не найден в приложенных документах — приложите чертёж/смету.`));
  }
  return findings;
}

function verifyRoom(room, docTexts, intent) {
  const findings = [];
  for (const el of (room.elements || [])) {
    const perElem = docTexts.filter(d => d.element_id === el.id);
    const roomLevel = docTexts.filter(d => !d.element_id);
    const use = perElem.length ? perElem.concat(roomLevel) : roomLevel;
    for (const f of verifyElement(el, use, intent)) findings.push(f);
  }
  return findings;
}

function statusOf(findings) { let b = 'none'; for (const f of findings) if (RANK[f.severity] > RANK[b]) b = f.severity; return b; }

module.exports = { verifyRoom, verifyElement, extractDims, extractFire, extractDiam, statusOf, RANK, norm, num };
