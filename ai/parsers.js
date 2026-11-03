'use strict';
/*
 * Document parsers (Phase C) — zero external dependencies, only Node built-ins.
 * Extracts plain text from XLSX / CSV / TXT / PDF for the verification engine.
 * XLSX/PDF decompression uses the built-in zlib module (no npm packages).
 */
const zlib = require('zlib');

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/* ---------- Minimal ZIP reader (STORE + DEFLATE via zlib) ---------- */
function readZipEntries(buf) {
  const entries = {};
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP (no EOCD)');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdCount = buf.readUInt16LE(eocd + 10);
  let p = cdOffset;
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lhNameLen = buf.readUInt16LE(localOff + 26);
    const lhExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
    const comp = buf.slice(dataStart, dataStart + compSize);
    let data;
    try {
      if (method === 0) data = comp;
      else if (method === 8) data = zlib.inflateRawSync(comp);
      else data = comp;
    } catch (e) { data = Buffer.alloc(0); }
    entries[name] = data;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* ---------- XLSX ---------- */
function parseXLSX(buf) {
  const z = readZipEntries(buf);
  const shared = [];
  if (z['xl/sharedStrings.xml']) {
    const xml = z['xl/sharedStrings.xml'].toString('utf8');
    const re = /<si>([\s\S]*?)<\/si>/g; let m;
    while ((m = re.exec(xml))) {
      const tre = /<t[^>]*>([\s\S]*?)<\/t>/g; let tm; const parts = [];
      while ((tm = tre.exec(m[1]))) parts.push(tm[1]);
      shared.push(decodeXmlEntities(parts.join('')));
    }
  }
  const sheets = [];
  const names = Object.keys(z).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  for (const nm of names) {
    const xml = z[nm].toString('utf8');
    const rows = [];
    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g; let rm;
    while ((rm = rowRe.exec(xml))) {
      const cells = [];
      const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g; let cm;
      while ((cm = cRe.exec(rm[1]))) {
        const attrs = cm[1] || cm[3] || '';
        const inner = cm[2] || '';
        const t = (/t="([^"]+)"/.exec(attrs) || [])[1];
        let val = '';
        if (t === 's') { const vi = /<v>([\s\S]*?)<\/v>/.exec(inner); if (vi) val = shared[parseInt(vi[1], 10)] || ''; }
        else if (t === 'inlineStr') { const ti = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner); if (ti) val = decodeXmlEntities(ti[1]); }
        else { const vi = /<v>([\s\S]*?)<\/v>/.exec(inner); if (vi) val = decodeXmlEntities(vi[1]); else { const ti = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner); if (ti) val = decodeXmlEntities(ti[1]); } }
        cells.push(val);
      }
      rows.push(cells);
    }
    sheets.push({ name: nm, rows });
  }
  const text = sheets.map(s => s.rows.map(r => r.join('\t')).join('\n')).join('\n');
  return { kind: 'xlsx', sheets, text };
}

/* ---------- SheetJS (optional dep, best coverage: xls/xlsx/ods/csv/html) ---------- */
let _XLSX = null, _xlsxTried = false;
function getXLSX() {
  if (!_xlsxTried) { _xlsxTried = true; try { _XLSX = require('xlsx'); } catch (e) { _XLSX = null; } }
  return _XLSX;
}
// Normalize a ragged grid: uniform column count, drop fully-empty rows and columns.
function trimGrid(rows) {
  let g = (rows || []).map(r => (r || []).map(c => (c == null ? '' : String(c).replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+/g, ' ').trim())));
  let ncol = 0; g.forEach(r => { if (r.length > ncol) ncol = r.length; });
  g = g.map(r => { const rr = r.slice(0, ncol); while (rr.length < ncol) rr.push(''); return rr; });
  g = g.filter(r => r.some(c => c !== ''));
  const keep = [];
  for (let c = 0; c < ncol; c++) { if (g.some(r => (r[c] || '') !== '')) keep.push(c); }
  g = g.map(r => keep.map(c => r[c]));
  return g;
}
function cellText(cell) {
  if (!cell) return '';
  const v = (cell.w != null ? cell.w : (cell.v != null ? cell.v : ''));
  return String(v).replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+/g, ' ').trim();
}
// Build a faithful Excel-like grid: full used range + real merges + column widths.
function sheetsFromWorkbook(X, wb) {
  const sheets = [];
  (wb.SheetNames || []).forEach(nm => {
    const ws = wb.Sheets[nm]; if (!ws || !ws['!ref']) return;
    const range = X.utils.decode_range(ws['!ref']);
    const r0 = range.s.r, c0 = range.s.c;
    const nrow = range.e.r - r0 + 1, ncol = range.e.c - c0 + 1;
    if (nrow < 1 || ncol < 1 || nrow > 20000) return;
    const rows = [];
    for (let r = 0; r < nrow; r++) {
      const row = [];
      for (let c = 0; c < ncol; c++) row.push(cellText(ws[X.utils.encode_cell({ r: r0 + r, c: c0 + c })]));
      rows.push(row);
    }
    if (!rows.some(r => r.some(c => c !== ''))) return;
    const merges = (ws['!merges'] || [])
      .map(m => ({ r: m.s.r - r0, c: m.s.c - c0, rs: m.e.r - m.s.r + 1, cs: m.e.c - m.s.c + 1 }))
      .filter(m => m.r >= 0 && m.c >= 0 && (m.rs > 1 || m.cs > 1));
    const colsRaw = ws['!cols'] || [];
    const colWidths = [];
    for (let c = 0; c < ncol; c++) { const cw = colsRaw[c0 + c]; colWidths.push(cw ? (cw.wpx ? Math.round(cw.wpx) : (cw.wch ? Math.round(cw.wch * 7 + 5) : null)) : null); }
    const rowsRaw = ws['!rows'] || [];
    const rowHeights = [];
    for (let r = 0; r < nrow; r++) { const rh = rowsRaw[r0 + r]; rowHeights.push(rh ? (rh.hpx ? Math.round(rh.hpx) : (rh.hpt ? Math.round(rh.hpt * 96 / 72) : null)) : null); }
    // Basic per-cell styles (bold / alignment) when available from the reader.
    const styles = {};
    for (let r = 0; r < nrow; r++) {
      for (let c = 0; c < ncol; c++) {
        const cell = ws[X.utils.encode_cell({ r: r0 + r, c: c0 + c })];
        if (!cell || !cell.s) continue;
        const s = cell.s; const st = {};
        if (s.font && s.font.bold) st.b = 1;
        const al = s.alignment || {};
        if (al.horizontal) st.h = al.horizontal;
        if (al.vertical) st.v = al.vertical;
        if (al.wrapText) st.w = 1;
        if (Object.keys(st).length) styles[r + ':' + c] = st;
      }
    }
    sheets.push({ name: String(nm || ''), rows, merges, colWidths, rowHeights, styles });
  });
  const text = sheets.map(s => s.rows.map(r => r.join('\t')).join('\n')).join('\n\n');
  return { sheets, text };
}

/* ---------- HTML / SpreadsheetML tables (estimate exports like АВК saved as .xls) ---------- */
function stripTags(s) {
  return decodeXmlEntities(String(s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}
function parseHtmlTables(buf) {
  let html = buf.toString('utf8');
  if ((/\ufffd/.test(html) && !/[\u0400-\u04FF]/.test(html)) || /charset=["']?(windows-1251|cp1251)/i.test(html)) {
    try { html = decodeCp1251(buf); } catch (e) {}
  }
  const sheets = [];
  const tblRe = /<table[\s\S]*?<\/table>/gi; let tm; let idx = 0;
  while ((tm = tblRe.exec(html))) {
    const tbl = tm[0]; const rows = [];
    const trRe = /<tr[\s\S]*?<\/tr>/gi; let rm;
    while ((rm = trRe.exec(tbl))) {
      const cells = []; const cRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi; let cm;
      while ((cm = cRe.exec(rm[0]))) cells.push(stripTags(cm[1]));
      if (cells.length) rows.push(cells);
    }
    const g = trimGrid(rows);
    if (g.length) { idx++; sheets.push({ name: 'Таблица ' + idx, rows: g }); }
  }
  const text = sheets.map(s => s.rows.map(r => r.join('\t')).join('\n')).join('\n\n');
  return { sheets, text };
}

// Minimal CP1251 -> Unicode decoder (for legacy .xls/HTML exports without UTF-8)
function decodeCp1251(buf) {
  const map = 'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—�™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕї';
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b >= 0xC0) out += String.fromCharCode(0x0410 + (b - 0xC0));
    else out += map.charAt(b - 0x80) || '\ufffd';
  }
  return out;
}

/* ---------- Spreadsheet dispatcher (xls/xlsx/ods/csv/html) ---------- */
function looksLikeHtml(buf) {
  const head = buf.slice(0, 2048).toString('latin1').toLowerCase();
  return head.indexOf('<table') >= 0 || head.indexOf('<html') >= 0 || head.indexOf('<?xml') >= 0 || head.indexOf('spreadsheet') >= 0 || head.indexOf('<!doctype html') >= 0;
}
function parseSpreadsheet(buf, ext) {
  const X = getXLSX();
  if (X) {
    try {
      const wb = X.read(buf, { type: 'buffer', cellDates: false, cellStyles: true, cellNF: true, sheetStubs: false, WTF: false });
      const r = sheetsFromWorkbook(X, wb);
      if (r.sheets.length) return { ok: true, ext, kind: 'sheet', sheets: r.sheets, text: r.text };
    } catch (e) { /* fall through to built-in parsers */ }
  }
  if ((ext === 'xlsx' || ext === 'xlsm') && !looksLikeHtml(buf)) {
    try { const r = parseXLSX(buf); if (r.sheets && r.sheets.length) return Object.assign({ ok: true, ext }, r); } catch (e) {}
  }
  if (looksLikeHtml(buf)) {
    try { const r = parseHtmlTables(buf); if (r.sheets && r.sheets.length) return { ok: true, ext, kind: 'html', sheets: r.sheets, text: r.text }; } catch (e) {}
  }
  if (ext === 'csv' || ext === 'tsv') return { ok: true, ext, kind: 'csv', text: buf.toString('utf8') };
  return null;
}

/* ---------- PDF (text layer; FlateDecode via zlib) ---------- */
function decodePdfString(tok) {
  let s = tok.slice(1, -1);
  s = s.replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\');
  return s;
}
function extractPdfText(content) {
  const parts = [];
  const re = /\[([^\]]*)\]\s*TJ|(\((?:\\.|[^\\()])*\))\s*Tj/g; let m;
  while ((m = re.exec(content))) {
    if (m[1] != null) {
      const sre = /\((?:\\.|[^\\()])*\)/g; let sm; let line = '';
      while ((sm = sre.exec(m[1]))) line += decodePdfString(sm[0]);
      if (line) parts.push(line);
    } else if (m[2]) { parts.push(decodePdfString(m[2])); }
  }
  return parts.join(' ');
}
function parsePDF(buf) {
  // Границы, чтобы большие чертежи-PDF не подвешивали процесс (парсинг идёт в worker-потоке):
  const MAX_BYTES = 24 * 1024 * 1024;  // сканируем до 24 МБ содержимого
  const MAX_STREAMS = 20000;           // не более 20000 потоков
  const MAX_TEXT = 4 * 1024 * 1024;    // не более 4 МБ извлечённого текста
  const DEADLINE = Date.now() + 9000;  // бюджет времени 9 с
  // Потоки-изображения НЕ распаковываем: в сканах это самое тяжёлое, и именно из-за
  // них раньше пропадал текстовый слой по таймауту. Пропуск картинок ускоряет разбор
  // в десятки раз и возвращает чтение текста в отсканированных PDF.
  const IMG_RE = /\/Subtype\s*\/Image|\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode|\/JBIG2Decode/;
  const scanLen = Math.min(buf.length, MAX_BYTES);
  const raw = buf.toString('latin1', 0, scanLen);
  const out = []; let textLen = 0, streams = 0, truncated = buf.length > scanLen;
  const re = /stream\r?\n/g; let m;
  while ((m = re.exec(raw))) {
    if (streams++ >= MAX_STREAMS || textLen >= MAX_TEXT || Date.now() > DEADLINE) { truncated = true; break; }
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const dictStart = raw.lastIndexOf(' obj', m.index);
    const dict = dictStart >= 0 ? raw.slice(dictStart, m.index) : raw.slice(Math.max(0, m.index - 512), m.index);
    if (IMG_RE.test(dict)) { re.lastIndex = end + 9; continue; }
    const chunk = buf.slice(start, end);
    let data = null;
    try { data = zlib.inflateSync(chunk); }
    catch (e) { try { data = zlib.inflateRawSync(chunk); } catch (e2) { data = null; } }
    const content = data ? data.toString('latin1') : chunk.toString('latin1');
    const txt = extractPdfText(content);
    if (txt) { out.push(txt); textLen += txt.length; }
    re.lastIndex = end + 9;
  }
  return { kind: 'pdf', truncated, text: out.join('\n').replace(/[ \t]{2,}/g, ' ').trim() };
}

/* ---------- Dispatcher ---------- */
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'gif'];
function extractText(buf, name) {
  const ext = (String(name || '').split('.').pop() || '').toLowerCase();
  const SHEET_EXT = ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'csv', 'tsv'];
  try {
    if (SHEET_EXT.includes(ext)) { const sp = parseSpreadsheet(buf, ext); if (sp) return sp; }
    if (ext === 'txt' || ext === 'md') return { ok: true, ext, kind: 'txt', text: buf.toString('utf8') };
    if (ext === 'pdf') return Object.assign({ ok: true, ext }, parsePDF(buf));
    if (IMAGE_EXT.includes(ext)) return { ok: false, ext, kind: 'image', needsOCR: true, text: '' };
  } catch (e) { return { ok: false, ext, kind: ext, error: e.message, text: '' }; }
  return { ok: false, ext, kind: ext || 'unknown', text: '' };
}

module.exports = { extractText, parseXLSX, parseSpreadsheet, parseHtmlTables, parsePDF, readZipEntries, decodeXmlEntities, decodeCp1251, IMAGE_EXT };
