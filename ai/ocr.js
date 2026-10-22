'use strict';
/*
 * OCR adapter (Phase C). Uses a locally installed Tesseract binary if present.
 * Fully offline: if Tesseract is not installed, returns a graceful
 * { ok:false, reason:'tesseract_not_installed' } so the pipeline can fall back
 * to text-layer extraction and rule/LLM checks.
 *
 * ВАЖНО: многие инсталляторы (winget UB-Mannheim.TesseractOCR, Poppler,
 * Ghostscript) не добавляют бинарники в PATH. Поэтому здесь есть резолвер,
 * который ищет исполняемые файлы и в типовых каталогах установки, а не только
 * в PATH. Результат кешируется.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function _exists(p) { try { return !!p && fs.existsSync(p); } catch (e) { return false; } }

function _binWorks(bin, args) {
  try {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 8000 });
    if (r.error) return false;
    return r.status === 0 || /\d+\.\d+/.test((r.stdout || '') + (r.stderr || ''));
  } catch (e) { return false; }
}

// Ограниченный по глубине рекурсивный поиск файла по имени (regex) под root.
function _findUnder(root, nameRe, maxDepth) {
  if (!_exists(root)) return null;
  const stack = [[root, 0]];
  let scanned = 0;
  while (stack.length) {
    const [dir, depth] = stack.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      if (++scanned > 6000) return null; // защита от долгого сканирования
      if (e.isFile() && nameRe.test(e.name)) return path.join(dir, e.name);
    }
    if (depth < maxDepth) {
      for (const e of entries) { if (e.isDirectory()) stack.push([path.join(dir, e.name), depth + 1]); }
    }
  }
  return null;
}

const PF = process.env['ProgramFiles'] || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCALAPP = process.env['LOCALAPPDATA'] || '';

// Диск-кеш найденных путей к внешним инструментам (Tesseract/Poppler/Ghostscript):
// дорогой рекурсивный поиск (_findUnder) выполняется один раз, дальше путь берётся из кеша. (r11)
const TOOL_CACHE_FILE = path.join(os.tmpdir(), 'bimtwin-tools.json');
function _loadToolCache() { try { return JSON.parse(fs.readFileSync(TOOL_CACHE_FILE, 'utf8')) || {}; } catch (e) { return {}; } }
function _saveToolCache(obj) { try { fs.writeFileSync(TOOL_CACHE_FILE, JSON.stringify(obj)); } catch (e) {} }
const PROGDATA = process.env['ProgramData'] || 'C:\\ProgramData';

// --- Резолвер Tesseract -----------------------------------------------------
let _tessCache; // undefined = не резолвили; null = нет; string = путь/имя
function _resolveTesseract(cmd) {
  if (cmd && cmd !== 'tesseract' && _binWorks(cmd, ['--version'])) return cmd;
  if (_tessCache !== undefined) return _tessCache;
  // диск-кеш: путь, найденный в прошлый запуск (пропускаем дорогое сканирование)
  const _disk = _loadToolCache();
  if (_disk.tesseract && _binWorks(_disk.tesseract, ['--version'])) { _tessCache = _disk.tesseract; return _tessCache; }
  let found = null;
  if (_binWorks('tesseract', ['--version'])) { found = 'tesseract'; }
  if (!found) {
    const cand = [];
    if (IS_WIN) {
      cand.push(path.join(PF, 'Tesseract-OCR', 'tesseract.exe'));
      cand.push(path.join(PF86, 'Tesseract-OCR', 'tesseract.exe'));
      if (LOCALAPP) {
        cand.push(path.join(LOCALAPP, 'Programs', 'Tesseract-OCR', 'tesseract.exe'));
        cand.push(path.join(LOCALAPP, 'Tesseract-OCR', 'tesseract.exe'));
      }
    } else if (IS_MAC) {
      cand.push('/opt/homebrew/bin/tesseract', '/usr/local/bin/tesseract', '/usr/bin/tesseract');
    } else {
      cand.push('/usr/bin/tesseract', '/usr/local/bin/tesseract', '/snap/bin/tesseract');
    }
    found = cand.find(_exists) || null;
    if (!found && IS_WIN && LOCALAPP) {
      found = _findUnder(path.join(LOCALAPP, 'Microsoft', 'WinGet', 'Packages'), /^tesseract\.exe$/i, 4);
    }
  }
  _tessCache = found;
  if (found) { const _c = _loadToolCache(); _c.tesseract = found; _saveToolCache(_c); }
  return found;
}

// --- Резолвер растеризатора PDF (Poppler/Ghostscript) -----------------------
let _rastCache; // undefined = не резолвили; null = нет; { type, cmd }
function _rasterizer() {
  if (_rastCache !== undefined) return _rastCache;
  // диск-кеш растеризатора PDF (как у Tesseract) — пропускаем дорогой поиск
  const _dr = _loadToolCache();
  if (_dr.rasterizer && _dr.rasterizer.cmd && _exists(_dr.rasterizer.cmd)) { _rastCache = _dr.rasterizer; return _rastCache; }
  const _res = _rasterizerScan();
  if (_res && _res.cmd) { const _c = _loadToolCache(); _c.rasterizer = _res; _saveToolCache(_c); }
  return _res;
}
function _rasterizerScan() {
  if (_rastCache !== undefined) return _rastCache;
  // 1) PATH
  const pathProbe = IS_WIN
    ? [['pdftoppm', 'pdftoppm', ['-v']], ['pdftocairo', 'pdftocairo', ['-v']], ['gs', 'gswin64c', ['--version']], ['gs', 'gswin32c', ['--version']]]
    : [['pdftoppm', 'pdftoppm', ['-v']], ['pdftocairo', 'pdftocairo', ['-v']], ['gs', 'gs', ['--version']]];
  for (const [type, name, args] of pathProbe) {
    if (_binWorks(name, args)) { _rastCache = { type, cmd: name }; return _rastCache; }
  }
  // 2) типовые каталоги установки
  if (IS_WIN) {
    const chocoBin = path.join(PROGDATA, 'chocolatey', 'bin');
    const fixed = [
      ['pdftoppm', path.join(chocoBin, 'pdftoppm.exe')],
      ['pdftocairo', path.join(chocoBin, 'pdftocairo.exe')],
      ['gs', path.join(chocoBin, 'gswin64c.exe')],
      ['gs', path.join(chocoBin, 'gswin32c.exe')],
    ];
    for (const [type, p] of fixed) { if (_exists(p)) { _rastCache = { type, cmd: p }; return _rastCache; } }
    // Ghostscript: Program Files\gs\gs*\bin\gswin64c.exe
    for (const base of [path.join(PF, 'gs'), path.join(PF86, 'gs')]) {
      const gp = _findUnder(base, /^gswin(64|32)c\.exe$/i, 2);
      if (gp) { _rastCache = { type: 'gs', cmd: gp }; return _rastCache; }
    }
    // Poppler: Program Files или каталоги пакетов winget
    for (const base of [PF, PF86]) {
      const pp = _findUnder(base, /^pdftoppm\.exe$/i, 3);
      if (pp) { _rastCache = { type: 'pdftoppm', cmd: pp }; return _rastCache; }
    }
    if (LOCALAPP) {
      const wg = path.join(LOCALAPP, 'Microsoft', 'WinGet', 'Packages');
      const pp = _findUnder(wg, /^pdftoppm\.exe$/i, 5);
      if (pp) { _rastCache = { type: 'pdftoppm', cmd: pp }; return _rastCache; }
      const gp = _findUnder(wg, /^gswin(64|32)c\.exe$/i, 5);
      if (gp) { _rastCache = { type: 'gs', cmd: gp }; return _rastCache; }
    }
  } else {
    const dirs = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
    const names = [['pdftoppm', 'pdftoppm'], ['pdftocairo', 'pdftocairo'], ['gs', 'gs']];
    for (const [type, name] of names) {
      for (const d of dirs) { const p = path.join(d, name); if (_exists(p)) { _rastCache = { type, cmd: p }; return _rastCache; } }
    }
  }
  _rastCache = null;
  return _rastCache;
}

function ocrAvailable(cmd) { return !!_resolveTesseract(cmd); }

// Асинхронный OCR: не блокирует event loop основного процесса.
function ocr(absPath, opts) {
  opts = opts || {};
  const lang = opts.lang || 'rus+ukr+eng';
  return new Promise((resolve) => {
    const bin = _resolveTesseract(opts.cmd);
    if (!bin) { resolve({ ok: false, reason: 'tesseract_not_installed', text: '' }); return; }
    let out = '', err = '', done = false;
    let child;
    try {
      child = spawn(bin, [absPath, 'stdout', '-l', lang], { encoding: 'utf8' });
    } catch (e) { resolve({ ok: false, reason: 'spawn_error', text: '', error: e.message }); return; }
    const finish = (res) => { if (done) return; done = true; resolve(res); };
    child.stdout.on('data', (d) => { out += d.toString(); if (out.length > 2e8) { try { child.kill(); } catch (e) {} } });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => finish({ ok: false, reason: 'spawn_error', text: '', error: (e && e.message) || String(e) }));
    child.on('close', (code) => {
      if (code !== 0) finish({ ok: false, reason: 'ocr_failed', text: '', error: (err || '').slice(0, 200) });
      else finish({ ok: true, text: (out || '').trim() });
    });
  });
}

// Синхронный вариант сохранён для обратной совместимости (не рекомендуется).
function ocrSync(absPath, opts) {
  opts = opts || {};
  const lang = opts.lang || 'rus+ukr+eng';
  const bin = _resolveTesseract(opts.cmd);
  if (!bin) return { ok: false, reason: 'tesseract_not_installed', text: '' };
  try {
    const r = spawnSync(bin, [absPath, 'stdout', '-l', lang], { encoding: 'utf8', maxBuffer: 1e8 });
    if (r.status !== 0) return { ok: false, reason: 'ocr_failed', text: '', error: (r.stderr || '').slice(0, 200) };
    return { ok: true, text: (r.stdout || '').trim() };
  } catch (e) { return { ok: false, reason: 'spawn_error', text: '', error: e.message }; }
}

function _spawnWait(bin, args) {
  return new Promise((resolve) => {
    let err = '', done = false, child;
    try { child = spawn(bin, args); } catch (e) { resolve({ code: -1, err: String((e && e.message) || e) }); return; }
    const fin = (r) => { if (done) return; done = true; resolve(r); };
    if (child.stderr) child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => fin({ code: -1, err: String((e && e.message) || e) }));
    child.on('close', (code) => fin({ code, err }));
  });
}

// Распознаёт текст в отсканированном PDF. Грациозно возвращает reason,
// если нет Tesseract или растеризатора (Poppler/Ghostscript).
async function ocrPdf(absPath, opts) {
  opts = opts || {};
  const lang = opts.lang || 'rus+ukr+eng';
  const maxPages = opts.maxPages || 30;
  const dpi = opts.dpi || 200;
  const bin = _resolveTesseract(opts.cmd);
  if (!bin) return { ok: false, reason: 'tesseract_not_installed', text: '' };
  const raster = _rasterizer();
  if (!raster) return { ok: false, reason: 'no_pdf_rasterizer', text: '' };
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimocr-')); } catch (e) { return { ok: false, reason: 'tmp_error', text: '', error: e.message }; }
  try {
    const prefix = path.join(dir, 'page');
    let r;
    if (raster.type === 'pdftoppm') r = await _spawnWait(raster.cmd, ['-png', '-r', String(dpi), '-f', '1', '-l', String(maxPages), absPath, prefix]);
    else if (raster.type === 'pdftocairo') r = await _spawnWait(raster.cmd, ['-png', '-r', String(dpi), '-f', '1', '-l', String(maxPages), absPath, prefix]);
    else r = await _spawnWait(raster.cmd, ['-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=png16m', '-r' + dpi, '-dFirstPage=1', '-dLastPage=' + maxPages, '-sOutputFile=' + prefix + '-%03d.png', absPath]);
    const pngs = fs.readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort();
    if (!pngs.length) return { ok: false, reason: 'raster_failed', text: '', error: ((r && r.err) || '').slice(0, 200) };
    const parts = [];
    let pageNo = 0;
    for (const f of pngs) {
      pageNo++;
      const pr = await ocr(path.join(dir, f), { cmd: bin, lang });
      if (pr && pr.ok && pr.text) parts.push('=== Страница ' + pageNo + ' ===\n' + pr.text.trim());
    }
    const text = parts.join('\n\n').trim();
    return { ok: !!text, text, pages: pngs.length, engine: raster.type + '+tesseract', reason: text ? undefined : 'empty' };
  } catch (e) {
    return { ok: false, reason: 'ocr_error', text: '', error: String((e && e.message) || e) };
  } finally {
    try { for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f)); fs.rmdirSync(dir); } catch (e) {}
  }
}

// Сбросить кеш резолвинга (например, после установки OCR без перезапуска).
function resetOcrCache() { _tessCache = undefined; _rastCache = undefined; }

function rasterizerAvailable() { const r = _rasterizer(); return r ? r.type : null; }

module.exports = { ocrAvailable, ocr, ocrSync, ocrPdf, rasterizerAvailable, resetOcrCache };
