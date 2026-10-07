'use strict';
// Report generator for AI findings: CSV (Excel), HTML (print→PDF) and native PDF.
// Pure module, no external deps. PDF uses base-14 Helvetica (WinAnsi) so Cyrillic
// is transliterated to Latin; CSV (with BOM) and HTML keep full Cyrillic.

const SEV_LABEL = { err: 'Ошибка', warn: 'На проверке', ok: 'ОК', none: 'Нет данных' };
const REVIEW_LABEL = { open: 'Открыто', accepted: 'Принято', rejected: 'Отклонено' };
const SRC_LABEL = { rule: 'правило', llm: 'LLM', ocr: 'OCR' };

const COLUMNS = [
  { key: 'room', label: 'Помещение' },
  { key: 'element', label: 'Элемент' },
  { key: 'kind', label: 'Замечание' },
  { key: 'severity', label: 'Статус' },
  { key: 'confidence', label: 'Уверенность' },
  { key: 'review', label: 'Ревью' },
  { key: 'assignee', label: 'Ответственный' },
  { key: 'due', label: 'Срок' },
  { key: 'source', label: 'Источник' },
  { key: 'text', label: 'Описание' },
  { key: 'comments', label: 'Комментарии' }
];

function userName(data, id) {
  if (!id) return '';
  const u = ((data && data.users) || []).find(x => x.id === id);
  return u ? u.name : id;
}

function buildRows(data, scope) {
  data = data || {};
  scope = scope || { type: 'project' };
  const rooms = ((data.rooms) || []).filter(r => scope.type === 'room' ? r.id === scope.roomId : true);
  const rows = [];
  for (const r of rooms) {
    const els = r.elements || [];
    for (const f of (r.findings || [])) {
      const el = els.find(e => e.id === f.element_id);
      rows.push({
        room: r.name || '',
        element: el ? el.name : '',
        kind: f.kind || '',
        severity: SEV_LABEL[f.severity] || f.severity || '',
        confidence: (f.confidence != null ? Math.round(f.confidence * 100) + '%' : ''),
        review: REVIEW_LABEL[f.review] || f.review || '',
        assignee: userName(data, f.assignee),
        due: f.due || '',
        source: SRC_LABEL[f.source] || f.source || '',
        text: f.text || '',
        comments: (f.comments || []).map(c => (c && c.text) || c || '').join(' | ')
      });
    }
  }
  return rows;
}

function toCSV(rows) {
  const q = s => { s = String(s == null ? '' : s); return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = COLUMNS.map(c => q(c.label)).join(';');
  const body = rows.map(r => COLUMNS.map(c => q(r[c.key])).join(';')).join('\r\n');
  return '\uFEFF' + head + '\r\n' + body;
}

function toHTML(rows, meta) {
  meta = meta || {};
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const counts = { err: 0, warn: 0, ok: 0 };
  for (const r of rows) { if (r.severity === SEV_LABEL.err) counts.err++; else if (r.severity === SEV_LABEL.warn) counts.warn++; else if (r.severity === SEV_LABEL.ok) counts.ok++; }
  const th = COLUMNS.map(c => '<th>' + esc(c.label) + '</th>').join('');
  const tr = rows.map(r => '<tr>' + COLUMNS.map(c => '<td>' + esc(r[c.key]) + '</td>').join('') + '</tr>').join('');
  return '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>' + esc(meta.title || 'Отчёт') + '</title>' +
    '<style>body{font-family:Arial,Helvetica,sans-serif;margin:28px;color:#1f2733}h1{font-size:22px;margin:0 0 4px}.sub{color:#6b7280;margin:0 0 16px}.cards{display:flex;gap:12px;margin:0 0 18px}.card{border:1px solid #e6e8eb;border-radius:12px;padding:10px 16px;font-size:14px}.card b{display:block;font-size:20px}.err b{color:#e5484d}.warn b{color:#d99a00}.ok b{color:#16a34a}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #e6e8eb;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f6f7f9}@media print{.noprint{display:none}}</style></head><body>' +
    '<h1>' + esc(meta.title || 'Отчёт по находкам') + '</h1><p class="sub">' + esc(meta.subtitle || '') + ' · ' + new Date().toLocaleString('ru-RU') + '</p>' +
    '<div class="cards"><div class="card err"><b>' + counts.err + '</b>Ошибки</div><div class="card warn"><b>' + counts.warn + '</b>На проверке</div><div class="card ok"><b>' + counts.ok + '</b>ОК</div><div class="card"><b>' + rows.length + '</b>Всего</div></div>' +
    '<p class="noprint" style="color:#6b7280;font-size:12px">Для PDF: Ctrl/Cmd+P → «Сохранить как PDF».</p>' +
    '<table><thead><tr>' + th + '</tr></thead><tbody>' + tr + '</tbody></table></body></html>';
}

const TRANSLIT = { 'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ё': 'E', 'Ж': 'Zh', 'З': 'Z', 'И': 'I', 'Й': 'Y', 'К': 'K', 'Л': 'L', 'М': 'M', 'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T', 'У': 'U', 'Ф': 'F', 'Х': 'Kh', 'Ц': 'Ts', 'Ч': 'Ch', 'Ш': 'Sh', 'Щ': 'Shch', 'Ъ': '', 'Ы': 'Y', 'Ь': '', 'Э': 'E', 'Ю': 'Yu', 'Я': 'Ya', 'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya', '№': 'No', 'є': 'ie', 'і': 'i', 'ї': 'yi', 'ґ': 'g', 'Є': 'Ie', 'І': 'I', 'Ї': 'Yi', 'Ґ': 'G' };
function translit(s) { return String(s == null ? '' : s).split('').map(ch => TRANSLIT[ch] != null ? TRANSLIT[ch] : ch).join(''); }

function pdfEscape(s) { return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[^\x20-\x7e]/g, '?'); }

function buildPdf(pages) {
  const N = pages.length;
  const fontNum = 3;
  const pageNums = [], contentNums = [];
  let next = 4;
  for (let i = 0; i < N; i++) { pageNums.push(next++); contentNums.push(next++); }
  const objects = [];
  objects.push({ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' });
  objects.push({ num: 2, body: '<< /Type /Pages /Count ' + N + ' /Kids [' + pageNums.map(n => n + ' 0 R').join(' ') + '] >>' });
  objects.push({ num: fontNum, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' });
  for (let i = 0; i < N; i++) {
    const lines = pages[i];
    let stream = 'BT /F1 10 Tf 13 TL 40 800 Td\n';
    for (let j = 0; j < lines.length; j++) stream += '(' + pdfEscape(lines[j]) + ') Tj T*\n';
    stream += 'ET';
    objects.push({ num: pageNums[i], body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ' + fontNum + ' 0 R >> >> /Contents ' + contentNums[i] + ' 0 R >>' });
    objects.push({ num: contentNums[i], body: '<< /Length ' + Buffer.byteLength(stream, 'latin1') + ' >>\nstream\n' + stream + '\nendstream' });
  }
  objects.sort((a, b) => a.num - b.num);
  const maxNum = objects[objects.length - 1].num;
  const count = maxNum + 1;
  let pdf = '%PDF-1.4\n';
  const offsets = {};
  for (const o of objects) { offsets[o.num] = Buffer.byteLength(pdf, 'latin1'); pdf += o.num + ' 0 obj\n' + o.body + '\nendobj\n'; }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += 'xref\n0 ' + count + '\n0000000000 65535 f \n';
  for (let n = 1; n < count; n++) { const off = offsets[n] != null ? offsets[n] : 0; pdf += String(off).padStart(10, '0') + ' 00000 n \n'; }
  pdf += 'trailer\n<< /Size ' + count + ' /Root 1 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF';
  return Buffer.from(pdf, 'latin1');
}

function toPDF(rows, meta) {
  meta = meta || {};
  const lines = [];
  lines.push(translit(meta.title || 'Report'));
  if (meta.subtitle) lines.push(translit(meta.subtitle));
  lines.push(translit('Vsego nahodok: ' + rows.length + '   ' + new Date().toLocaleString('ru-RU')));
  lines.push('');
  let i = 1;
  for (const r of rows) {
    lines.push(i + '. [' + translit(r.severity) + '] ' + translit(r.room) + ' / ' + translit(r.element));
    lines.push('   ' + translit(r.kind) + ' - ' + translit(r.text));
    const extra = [];
    if (r.assignee) extra.push('Otv: ' + translit(r.assignee));
    if (r.due) extra.push('Srok: ' + translit(r.due));
    if (r.confidence) extra.push('Uv: ' + r.confidence);
    if (r.review) extra.push('Rev: ' + translit(r.review));
    if (extra.length) lines.push('   ' + extra.join('  '));
    lines.push('');
    i++;
  }
  if (rows.length === 0) lines.push('Net nahodok.');
  const perPage = 56;
  const pages = [];
  for (let p = 0; p < lines.length; p += perPage) pages.push(lines.slice(p, p + perPage));
  if (!pages.length) pages.push(['']);
  return buildPdf(pages);
}

function build(data, scope, format, meta) {
  const rows = buildRows(data, scope);
  format = (format || 'csv').toLowerCase();
  if (format === 'pdf') return { mime: 'application/pdf', ext: 'pdf', content: toPDF(rows, meta), encoding: 'binary' };
  if (format === 'html') return { mime: 'text/html', ext: 'html', content: toHTML(rows, meta), encoding: 'utf8' };
  return { mime: 'text/csv', ext: 'csv', content: toCSV(rows), encoding: 'utf8' };
}

module.exports = { buildRows, toCSV, toHTML, toPDF, translit, build, COLUMNS, SEV_LABEL, REVIEW_LABEL };
