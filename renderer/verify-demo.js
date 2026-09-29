/* Browser demo verification (Phase C) — intent-driven rules, no file parsing.
 * In the desktop build the real engine (ai/verify.js) runs in the main process
 * and parses actual PDF/XLSX/CSV/TXT documents; this mirror keeps the browser
 * demo interactive without Node. */
(function () {
  'use strict';
  const RANK = { none: 0, ok: 1, warn: 2, err: 3 };
  const gid = () => 'f_' + Math.random().toString(36).slice(2, 9);
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[×хx]/g, 'x').replace(/\s+/g, ' ').trim(); }
  function mk(el, kind, severity, confidence, text) { return { id: gid(), element_id: el.id, document_id: null, kind, severity, confidence, text, source: 'rule', review: 'open', comments: [] }; }
  function verifyElement(el, intent) {
    const out = []; const it = (intent && intent[el.id]) || {};
    if (it.section && it.model_section && norm(it.section) !== norm(it.model_section)) out.push(mk(el, 'Сечение воздуховода', 'err', 0.92, 'На чертеже ' + it.section + ' мм, в модели ' + it.model_section + ' мм — расхождение с проектом.'));
    if (it.load_kg != null && it.floor_limit_kg) { const r = it.load_kg / it.floor_limit_kg; if (r > 1) out.push(mk(el, 'Перегрузка перекрытия', 'err', 0.9, 'Нагрузка ' + it.load_kg + ' кг превышает предел ' + it.floor_limit_kg + ' кг.')); else if (r >= 0.9) out.push(mk(el, 'Нагрузка на перекрытие', 'warn', 0.72, 'Нагрузка ' + it.load_kg + ' кг близка к пределу ' + it.floor_limit_kg + ' кг (' + Math.round(r * 100) + '%).')); }
    if (it.area_design != null && it.area_model != null && it.area_design > 0) { const d = (it.area_model - it.area_design) / it.area_design; if (Math.abs(d) >= 0.05) out.push(mk(el, 'Площадь остекления', 'warn', 0.68, 'Отклонение площади на ' + Math.round(d * 100) + '% от проектной.')); }
    if (!out.length && it.passport && it.model && norm(it.passport) === norm(it.model)) out.push(mk(el, 'Соответствие паспорту', 'ok', 0.85, 'Модель ' + it.model + ' соответствует паспорту и смете.'));
    return out;
  }
  function verifyRoom(room, intent) { const f = []; for (const el of (room.elements || [])) for (const x of verifyElement(el, intent)) f.push(x); return f; }
  function recompute(room) { for (const e of (room.elements || [])) { let b = 'none'; for (const f of (room.findings || [])) if (f.element_id === e.id && f.review !== 'rejected' && RANK[f.severity] > RANK[b]) b = f.severity; e.ai_status = b; } }
  window.VerifyDemo = { verifyRoom, verifyElement, recompute };
})();
