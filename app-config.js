/*
 * app-config.js — центральные константы, общие для main- и renderer-процессов.
 * Единый источник истины для «магических чисел» (бюджеты точек, размеры чанков, лимиты LRU и т.д.).
 *
 *   Node:    const cfg = require('./app-config');
 *   Browser: <script src="../app-config.js"> -> window.APP_CONFIG
 */
(function (root, factory) {
  'use strict';
  var cfg = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = cfg;
  if (typeof root !== 'undefined') root.APP_CONFIG = cfg;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return {
    // ---- Облака точек ----
    DEFAULT_MAX_POINTS: 3000000,        // безопасный preview по умолчанию; пользователь может поднять pointBudget до 300 млн
    CLOUD_CHUNK_BYTES: 8 * 1024 * 1024, // размер чанка при потоковом чтении с диска
    COLOR_SAMPLE_COUNT: 4000,          // сколько записей выбираем для определения глубины цвета
    // ---- Октодерево / потоковый рендер ----
    OCTREE_NODE_CAPACITY: 60000,       // целевое число точек на узел
    OCTREE_MAX_POINTS: 400000000,       // потолок точек при построении октодерева
    OCTREE_GPU_LRU_CAP: 1024,          // макс. число GPU-буферов узлов в кеше
    // ---- Экспорт ----
    PLY_EXPORT_MAX_POINTS: 80000000,   // лимит точек при экспорте в PLY
    // ---- OCR ----
    OCR_SCAN_LIMIT: 6000,              // макс. число записей при поиске бинарников OCR
    // PDRF (point data record format) LAS -> байтовое смещение RGB в записи точки
    LAS_COLOR_OFFSETS: { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 }
  };
});
