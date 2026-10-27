'use strict';
/*
 * Worker-поток базы норм: извлекает текст документа постранично (pdf.js / DOCX / TXT…),
 * при отсутствии текстового слоя запускает OCR, режет на фрагменты-пункты и
 * считает токены для BM25. Отвечает одним сообщением.
 */
const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const T = require('./norms-text');

(async () => {
  const wd = workerData || {};
  const file = wd.file;
  try {
    let r = await T.extractPages(file, { maxPages: wd.maxPages || 2000, budgetMs: wd.budgetMs || 180000 });
    let ocrInfo = null;
    if (!r.ok && r.needsOcr) {
      if (wd.ocr === false) {
        parentPort.postMessage({ ok: false, needsOcr: true, kind: r.kind, error: 'Нет текстового слоя (скан); распознавание отключено' });
        return;
      }
      const ocr = require('./ocr');
      const o = await ocr.ocrPdf(file, { maxPages: wd.ocrPages || 300, dpi: 200, cmd: wd.ocrCmd, lang: wd.ocrLang });
      ocrInfo = { ok: !!o.ok, reason: o.reason || '', engine: o.engine || '' };
      if (!o.ok) {
        parentPort.postMessage({ ok: false, needsOcr: true, ocr: false, ocrReason: o.reason || 'ocr_failed', kind: 'pdf',
          error: o.reason === 'tesseract_not_installed' ? 'Скан без текстового слоя: установите Tesseract OCR' :
            o.reason === 'no_pdf_rasterizer' ? 'Скан без текстового слоя: нужен Poppler или Ghostscript' : 'Не удалось распознать скан' });
        return;
      }
      r = { ok: true, kind: 'pdf', pages: T.splitPagesMarked(o.text), total: o.pages, truncated: (o.pages || 0) >= (wd.ocrPages || 300), engine: o.engine };
    }
    if (!r.ok) { parentPort.postMessage({ ok: false, kind: r.kind, error: r.error || 'Не удалось прочитать документ' }); return; }
    const pages = T.cleanPages(r.pages);
    const all = pages.map((p) => p.text).join('\n');
    const code = T.detectCode(path.basename(file), all);
    const chunks = T.chunkPages(pages).map((c) => Object.assign(c, { k: T.tokens((c.heading ? c.heading + '\n' : '') + c.text, { syn: true }) }));
    parentPort.postMessage({ ok: true, kind: r.kind, code, pages: pages.length, total: r.total || pages.length, truncated: !!r.truncated,
      chunks, needsOcr: false, ocr: !!ocrInfo, engine: r.engine || '', chars: all.length });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
  }
})();
