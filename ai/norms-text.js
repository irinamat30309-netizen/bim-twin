'use strict';
/*
 * База норм: разбор документов на страницы и фрагменты-пункты, токенизация
 * для полнотекстового поиска (BM25), определение шифра документа (СП/ГОСТ/СНиП).
 * Работает в worker-потоке и в main-процессе; тяжёлых зависимостей не тянет —
 * pdf.js подгружается динамически только при разборе PDF.
 */
const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------ токены
const ENDINGS = ['остями', 'остью', 'ости', 'ость', 'иями', 'ями', 'ами', 'иях', 'ией', 'ием', 'ого', 'его', 'ому', 'ему',
  'ыми', 'ими', 'ться', 'тся', 'ешь', 'ете', 'ают', 'яют', 'ует', 'уют', 'ах', 'ях', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие',
  'ый', 'ий', 'ой', 'ей', 'ую', 'юю', 'ых', 'их', 'ым', 'им', 'ою', 'ею', 'ом', 'ем', 'ам', 'ям', 'ов', 'ев', 'ия', 'ья',
  'ью', 'ии', 'ть', 'ы', 'и', 'а', 'я', 'о', 'е', 'у', 'ю', 'ь', 'й'];

function stem(word) {
  let w = String(word || '').toLowerCase().replace(/ё/g, 'е');
  if (w.length <= 4 || /\d/.test(w) || !/[а-я]/.test(w)) return w;
  for (const e of ENDINGS) {
    if (w.endsWith(e) && w.length - e.length >= 3) { w = w.slice(0, -e.length); break; }
  }
  return w;
}

const STOP = new Set(('и в во на не что как по с со к ко от до за из у о об обо а но или ли же бы то это этот эта эти ' +
  'для при над под без про его ее их мне мы вы он она они оно я ты так также там тут где когда какой какая какие какое ' +
  'который которая которые которое быть был была были есть нет да можно нужно надо ли чем чтобы если весь все всё всех ' +
  'the a an of to in on for and or is are be by with as at from this that it').split(/\s+/));

const SYN_RAW = {
  'завал': 'вертикаль', 'отвес': 'вертикаль', 'крен': 'вертикаль', 'вертикальность': 'вертикаль', 'отклонение от вертикали': 'вертикаль',
  'кривизна': 'неровность', 'ровность': 'неровность', 'горб': 'неровность', 'плоскостность': 'неровность',
  'щуп': 'рейка', 'правило': 'рейка',
  'потолок': 'высота',
  'эвакуация': 'эвакуационный', 'эвакуационные': 'эвакуационный',
  'мгн': 'маломобильный', 'инвалид': 'маломобильный', 'коляска': 'маломобильный',
  'бетонирование': 'бетонный', 'бетон': 'бетонный',
  'опалубка': 'распалубка',
  'кирпич': 'кладка', 'кирпичный': 'кладка', 'газобетон': 'кладка', 'газобетонный': 'кладка',
  'плитка': 'облицовка', 'плиточный': 'облицовка', 'кафель': 'облицовка',
  'зазор': 'просвет'
};
const SYN = {};
for (const k of Object.keys(SYN_RAW)) {
  if (/\s/.test(k)) continue;
  SYN[stem(k)] = stem(SYN_RAW[k]);
}

function tokens(text, opts) {
  const syn = !!(opts && opts.syn);
  const out = [];
  const s = String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/(\d),(\d)/g, '$1.$2');
  const re = /\d+(?:\.\d+)*|[a-zа-я]+(?:-[a-zа-я]+)*/g;
  let m;
  while ((m = re.exec(s))) {
    const t = m[0];
    if (/^\d/.test(t)) { out.push(t); continue; }
    for (const p of t.split('-')) {
      if (!p || STOP.has(p) || p.length < 2) continue;
      const st = stem(p);
      out.push(st);
      if (syn && SYN[st] && SYN[st] !== st) out.push(SYN[st]);
    }
  }
  return out;
}

// ------------------------------------------------------------------ шифр документа
const CODE_RES = [
  /(?:^|[^A-Za-zА-Яа-я])(СП|SP)[\s_]*(\d{1,3})[._](\d{5})[._](\d{4})/i,
  /(?:^|[^A-Za-zА-Яа-я])(ГОСТ|GOST)[\s_]+(Р|R)[\s_]+(\d[\d.]*)[-_–](\d{2,4})/i,
  /(?:^|[^A-Za-zА-Яа-я])(ГОСТ|GOST)[\s_]+(\d[\d.]*)[-_–](\d{2,4})/i,
  /(?:^|[^A-Za-zА-Яа-я])(СНиП|SNiP)[\s_]*(\d[\d.]*)[-_–](\d{2,4})/i,
  /(?:^|[^A-Za-zА-Яа-я])(СП|SP)[\s_]+(\d{1,3}(?:[._]\d{1,5})+)/i,
  /(?:^|[^A-Za-zА-Яа-я])(СанПиН|SanPiN)[\s_]*(\d[\d.]*)[-_–]?(\d{0,4})/i,
  /(?:^|[^A-Za-zА-Яа-я])(ВСН|МДС|РД|СТО)[\s_]+([\d.\-–]+\d)/
];

function normCode(kind, parts) {
  const k = String(kind).toUpperCase();
  const map = { SP: 'СП', 'СП': 'СП', GOST: 'ГОСТ', 'ГОСТ': 'ГОСТ', SNIP: 'СНиП', 'СНИП': 'СНиП', SANPIN: 'СанПиН', 'САНПИН': 'СанПиН' };
  return (map[k] || kind) + ' ' + parts;
}

function detectCode(fileName, text) {
  const srcs = [path.basename(String(fileName || '')).replace(/\.[^.]+$/, ''), String(text || '').slice(0, 6000)];
  for (const src of srcs) {
    for (let i = 0; i < CODE_RES.length; i++) {
      const m = src.match(CODE_RES[i]);
      if (!m) continue;
      if (i === 0) return normCode(m[1], m[2] + '.' + m[3] + '.' + m[4]);
      if (i === 1) return 'ГОСТ Р ' + m[3].replace(/_/g, '.') + '-' + m[4];
      if (i === 2) return 'ГОСТ ' + m[2].replace(/_/g, '.') + '-' + m[3];
      if (i === 3) return 'СНиП ' + m[2].replace(/_/g, '.') + '-' + m[3];
      if (i === 4) return 'СП ' + m[2].replace(/_/g, '.');
      if (i === 5) return 'СанПиН ' + m[2] + (m[3] ? '-' + m[3] : '');
      return m[1] + ' ' + m[2];
    }
  }
  return '';
}

// ------------------------------------------------------------------ PDF через pdf.js
let _pdfjs = null;
async function pdfjsLib() {
  if (_pdfjs) return _pdfjs;
  const { pathToFileURL } = require('url');
  let p = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const cands = [];
  if (/app\.asar[\\/]/.test(p)) cands.push(p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'));
  cands.push(p);
  let lastErr;
  for (const c of cands) {
    try {
      if (!fs.existsSync(c) && c !== p) continue;
      const lib = await import(pathToFileURL(c).href);
      _pdfjs = { lib, root: path.resolve(path.dirname(c), '..', '..') };
      return _pdfjs;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('pdfjs-dist не найден');
}

async function pdfPages(buf, opts) {
  opts = opts || {};
  const maxPages = opts.maxPages || 2000;
  const deadline = Date.now() + (opts.budgetMs || 120000);
  const { lib, root } = await pdfjsLib();
  const toUrl = (d) => { const u = path.join(root, d) + path.sep; return fs.existsSync(u) ? u : undefined; };
  const doc = await lib.getDocument({
    data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice(),
    isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0,
    cMapUrl: toUrl('cmaps'), cMapPacked: true, standardFontDataUrl: toUrl('standard_fonts')
  }).promise;
  const total = doc.numPages;
  const pages = [];
  let truncated = false;
  for (let n = 1; n <= Math.min(total, maxPages); n++) {
    if (Date.now() > deadline) { truncated = true; break; }
    const pg = await doc.getPage(n);
    const tc = await pg.getTextContent();
    const lines = [];
    let cur = '', lastY = null;
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      const y = it.transform ? Math.round(it.transform[5]) : lastY;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && cur) { lines.push(cur); cur = ''; }
      if (cur && it.str && !/\s$/.test(cur) && !/^\s/.test(it.str)) {
        const prevX = it.transform ? it.transform[4] : 0;
        cur += (prevX ? ' ' : '');
      }
      cur += it.str;
      lastY = y;
      if (it.hasEOL) { lines.push(cur); cur = ''; lastY = null; }
    }
    if (cur) lines.push(cur);
    pages.push({ page: n, text: lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n') });
    pg.cleanup && pg.cleanup();
  }
  if (total > maxPages) truncated = true;
  try { await doc.destroy(); } catch (e) {}
  return { pages, total, truncated };
}

// ------------------------------------------------------------------ DOCX / RTF / текст
function docxText(buf) {
  const parsers = require('./parsers');
  const ent = parsers.readZipEntries(buf);
  const xml = (ent['word/document.xml'] || Buffer.alloc(0)).toString('utf8');
  if (!xml) return '';
  let s = xml
    .replace(/<w:br[^>]*w:type="page"[^>]*\/>/g, '\f')
    .replace(/<w:lastRenderedPageBreak\/>/g, '')
    .replace(/<w:pageBreakBefore[^>]*\/>/g, '\f')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<w:tc[ >][\s\S]*?<\/w:tc>/g, (c) => c.replace(/<\/w:p>(?![\s\S]*<\/w:p>)/, '').replace(/<\/w:p>/g, ' '))
    .replace(/<\/w:tc>/g, ' | ')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  s = parsers.decodeXmlEntities(s);
  return s.replace(/ \| \n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function rtfText(buf) {
  let s = buf.toString('latin1');
  let out = '';
  // \'xx — байты cp1251; \uN? — юникод
  s = s.replace(/\\par[d]?\b ?/g, '\n').replace(/\\page\b ?/g, '\f').replace(/\\tab\b ?/g, '\t').replace(/\\line\b ?/g, '\n');
  const bytes = [];
  const flush = () => { if (bytes.length) { out += require('./parsers').decodeCp1251(Buffer.from(bytes)); bytes.length = 0; } };
  let depthSkip = 0, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') { depth++; if (/^\{\\\*|^\{\\(fonttbl|colortbl|stylesheet|info|pict)/.test(s.slice(i, i + 12)) && !depthSkip) depthSkip = depth; continue; }
    if (c === '}') { if (depthSkip === depth) depthSkip = 0; depth--; continue; }
    if (depthSkip) continue;
    if (c === '\\') {
      if (s[i + 1] === "'") { bytes.push(parseInt(s.substr(i + 2, 2), 16)); i += 3; continue; }
      const m = /^\\u(-?\d+)\??/.exec(s.slice(i, i + 10));
      if (m) { flush(); let n = parseInt(m[1], 10); if (n < 0) n += 65536; out += String.fromCharCode(n); i += m[0].length - 1; continue; }
      const w = /^\\([a-z]+)(-?\d+)? ?/i.exec(s.slice(i, i + 40));
      if (w) { flush(); i += w[0].length - 1; continue; }
      if (s[i + 1] === '\\' || s[i + 1] === '{' || s[i + 1] === '}') { flush(); out += s[i + 1]; i++; continue; }
      continue;
    }
    if (c === '\r' || (c === '\n' && s[i - 1] !== undefined && false)) continue;
    flush();
    out += c;
  }
  flush();
  return out.replace(/\n{3,}/g, '\n\n');
}

function decodeText(buf) {
  const u = buf.toString('utf8');
  const bad = (u.match(/\uFFFD/g) || []).length;
  if (bad > Math.max(3, u.length * 0.002)) return require('./parsers').decodeCp1251(buf);
  return u.replace(/^\uFEFF/, '');
}

function splitPagesMarked(text) {
  const s = String(text || '');
  if (/=== Страница \d+ ===/.test(s)) {
    const parts = s.split(/=== Страница (\d+) ===/);
    const pages = [];
    for (let i = 1; i < parts.length; i += 2) pages.push({ page: parseInt(parts[i], 10), text: (parts[i + 1] || '').trim() });
    return pages;
  }
  if (s.indexOf('\f') >= 0) return s.split('\f').map((t, i) => ({ page: i + 1, text: t.trim() }));
  return [{ page: 1, text: s.trim() }];
}

const EXT_OK = ['pdf', 'docx', 'txt', 'md', 'htm', 'html', 'rtf', 'xlsx', 'xls', 'csv'];

async function extractPages(file, opts) {
  opts = opts || {};
  const ext = (path.extname(file).slice(1) || '').toLowerCase();
  if (!EXT_OK.includes(ext)) return { ok: false, kind: ext, error: 'Формат не поддерживается: .' + ext };
  const buf = fs.readFileSync(file);
  if (ext === 'pdf') {
    let r = null, err = null;
    try { r = await pdfPages(buf, opts); } catch (e) { err = e; }
    if (r) {
      const chars = r.pages.reduce((a, p) => a + p.text.replace(/\s/g, '').length, 0);
      if (chars < Math.max(80, r.pages.length * 25)) return { ok: false, kind: 'pdf', needsOcr: true, total: r.total, pages: [], engine: 'pdf.js' };
      return { ok: true, kind: 'pdf', pages: r.pages, total: r.total, truncated: r.truncated, engine: 'pdf.js' };
    }
    const p = require('./parsers').parsePDF(buf);
    if (p.text && p.text.replace(/\s/g, '').length > 200 && /[а-яА-Я]{3}/.test(p.text)) {
      return { ok: true, kind: 'pdf', pages: [{ page: 0, text: p.text }], total: 0, truncated: p.truncated, engine: 'встроенный', warn: err ? String(err.message || err) : '' };
    }
    return { ok: false, kind: 'pdf', needsOcr: true, pages: [], engine: 'none', warn: err ? String(err.message || err) : '' };
  }
  let text = '';
  if (ext === 'docx') text = docxText(buf);
  else if (ext === 'rtf') text = rtfText(buf);
  else if (ext === 'htm' || ext === 'html') {
    text = decodeText(buf).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|h\d|li)>/gi, '\n').replace(/<\/t[dh]>/gi, ' | ').replace(/<[^>]+>/g, '');
    text = require('./parsers').decodeXmlEntities(text);
  } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
    const r = require('./parsers').extractText(buf, file);
    text = (r && r.text) || '';
  } else text = decodeText(buf);
  const pages = splitPagesMarked(text);
  const chars = pages.reduce((a, p) => a + p.text.length, 0);
  if (!chars) return { ok: false, kind: ext, pages: [], error: 'Пустой документ' };
  return { ok: true, kind: ext, pages, total: pages.length, engine: ext };
}

// Удаляет повторяющиеся колонтитулы и голые номера страниц.
function cleanPages(pages) {
  if (!pages || pages.length < 3) return (pages || []).map((p) => ({ page: p.page, text: p.text.replace(/^\s*-?\s*\d{1,4}\s*-?\s*$/gm, '').trim() }));
  const cnt = new Map();
  const keyOf = (l) => l.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  for (const p of pages) {
    const ls = p.text.split('\n');
    const edge = new Set([...ls.slice(0, 3), ...ls.slice(-3)].map(keyOf).filter((k) => k.length >= 3 && k.length <= 160));
    for (const k of edge) cnt.set(k, (cnt.get(k) || 0) + 1);
  }
  const lim = Math.max(3, Math.ceil(pages.length * 0.4));
  const rep = new Set([...cnt].filter(([, c]) => c >= lim).map(([k]) => k));
  return pages.map((p) => {
    const ls = p.text.split('\n');
    const keep = ls.filter((l, i) => {
      if (/^\s*[-–—]?\s*\d{1,4}\s*[-–—]?\s*$/.test(l)) return false;
      if ((i < 3 || i >= ls.length - 3) && rep.has(keyOf(l))) return false;
      return true;
    });
    return { page: p.page, text: keep.join('\n').trim() };
  });
}

// ------------------------------------------------------------------ фрагменты
const RX_CLAUSE = /^(\d{1,2}(?:\.\d{1,3}){1,4})\.?\s+(?=[А-ЯЁA-Z«(])/;
const RX_SECTION = /^(\d{1,2})\.?\s+([А-ЯЁ][^\n]{2,120})$/;
const RX_TABLE = /^Таблица\s+([А-ЯЁA-Z]?\.?\d+(?:\.\d+)*|[А-ЯЁ]\.\d+)/;
const RX_ANNEX = /^Приложение\s+([А-ЯЁA-Z])(?![А-Яа-яЁёA-Za-z])/;
const RX_ACLAUSE = /^([А-ЯЁA-Z]\.\d{1,3}(?:\.\d{1,3}){0,3})\.?\s+(?=[А-ЯЁA-Z«(])/;

function chunkPages(pages, opts) {
  opts = opts || {};
  const maxLen = opts.maxLen || 1100, minLen = opts.minLen || 350;
  const units = [];
  let heading = '', clause = '', table = '';
  for (const p of pages || []) {
    const lines = String(p.text || '').split('\n');
    let cur = null;
    const push = () => { if (cur && cur.text.trim()) units.push(cur); cur = null; };
    for (const raw of lines) {
      const l = raw.trim();
      if (!l) continue;
      let m;
      if ((m = l.match(RX_ANNEX))) { push(); heading = l.slice(0, 140); clause = 'прил. ' + m[1]; table = ''; cur = { page: p.page, clause, table, heading, text: l }; continue; }
      if ((m = l.match(RX_TABLE))) { push(); table = m[1]; cur = { page: p.page, clause, table, heading, text: l }; continue; }
      if ((m = l.match(RX_CLAUSE)) || (m = l.match(RX_ACLAUSE))) { push(); clause = m[1]; table = ''; cur = { page: p.page, clause, table, heading, text: l }; continue; }
      if ((m = l.match(RX_SECTION)) && l.length < 120 && !/[.;:,]$/.test(l)) { push(); heading = l; clause = m[1]; table = ''; cur = { page: p.page, clause, table, heading, text: l }; continue; }
      if (!cur) cur = { page: p.page, clause, table, heading, text: l };
      else cur.text += (/[-‐]$/.test(cur.text) ? '' : '\n') + l;
    }
    push();
  }
  // Склейка коротких и разрезание длинных
  const out = [];
  let acc = null;
  const emit = (u) => {
    if (u.text.length <= maxLen) { out.push(u); return; }
    const parts = u.text.split(/(?<=[.;:])\s+|\n/);
    let buf = '';
    for (const s of parts) {
      if (buf && buf.length + s.length + 1 > maxLen) { out.push(Object.assign({}, u, { text: buf })); buf = ''; }
      buf += (buf ? ' ' : '') + s;
      while (buf.length > maxLen * 1.5) { out.push(Object.assign({}, u, { text: buf.slice(0, maxLen) })); buf = buf.slice(maxLen); }
    }
    if (buf) out.push(Object.assign({}, u, { text: buf }));
  };
  for (const u of units) {
    if (acc && acc.page === u.page && acc.text.length < minLen && acc.text.length + u.text.length < maxLen && !u.table && !acc.table) {
      acc.text += '\n' + u.text;
      if (u.clause && u.clause !== acc.clauses[acc.clauses.length - 1]) acc.clauses.push(u.clause);
      continue;
    }
    if (acc) emit(acc);
    acc = Object.assign({}, u, { clauses: u.clause ? [u.clause] : [] });
  }
  if (acc) emit(acc);
  return out.map((c, i) => ({ i, page: c.page, clause: c.clause || '', clauses: c.clauses || [], table: c.table || '', heading: c.heading || '', text: c.text }));
}

function citeOf(label, ch) {
  const parts = [label || 'документ'];
  if (ch) {
    let cls = (ch.clauses || []).slice();
    const sub = (c) => /[\dА-ЯЁA-Z]\.\d/.test(c);
    if (cls.length > 1 && cls.some(sub)) cls = cls.filter(sub);
    const cl = cls.length > 1 ? cls[0] + '–' + cls[cls.length - 1] : (cls[0] || ch.clause || '');
    if (cl && !ch.table) parts.push(/^прил\./.test(cl) ? cl : (/^\d+$/.test(cl) ? 'разд. ' + cl : 'п. ' + cl));
    if (ch.table) parts.push('табл. ' + ch.table);
    if (ch.page) parts.push('с. ' + ch.page);
  }
  return parts.join(', ');
}

module.exports = { stem, tokens, STOP, SYN, detectCode, normCode, pdfjsLib, pdfPages, docxText, rtfText, decodeText,
  splitPagesMarked, EXT_OK, extractPages, cleanPages, chunkPages, citeOf, RX_CLAUSE, RX_ACLAUSE };
