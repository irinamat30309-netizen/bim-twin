'use strict';
/*
 * Worker-поток: извлечение текста из документа (+ OCR при необходимости).
 * Выносит тяжёлый парсинг PDF/XLSX/DOCX и OCR из main-процесса, чтобы окно не зависало.
 * Запускается из main.js через new Worker(...). Общается одним сообщением-ответом.
 */
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const parsers = require('./parsers');
const ocrmod = require('./ocr');

(async () => {
  try {
    const { absPath, name, ocrCmd, ocrLang } = workerData || {};
    const buf = fs.readFileSync(absPath);
    let ext = parsers.extractText(buf, name || absPath);
    let ocrInfo = null;
    if (!ext.ok && ext.needsOCR) {
      const o = await ocrmod.ocr(absPath, { cmd: ocrCmd, lang: ocrLang });
      ext = { ok: o.ok, text: o.text || '', kind: 'скан' };
      ocrInfo = { ocr: o.ok ? 'ok' : o.reason };
    }
    parentPort.postMessage({ ok: true, ext, ocrInfo });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) });
  }
})();
