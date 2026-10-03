'use strict';
/*
 * Worker-поток: разбор IFC (STEP) вне main-процесса.
 * Разбор больших IFC — тяжёлый синхронный парсинг строк; выносим его в поток,
 * чтобы окно не зависало. Общается одним сообщением-ответом.
 */
const { parentPort, workerData } = require('worker_threads');
const { parseIFC } = require('./ifcImport');

try {
  const parsed = parseIFC(String((workerData && workerData.text) || ''));
  parentPort.postMessage({ ok: true, parsed });
} catch (e) {
  parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) });
}
