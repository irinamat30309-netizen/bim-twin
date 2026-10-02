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
    DEFAULT_MAX_POINTS: 200000000,      // бюджет точек по умолчанию (ревизия 4): читаем облако целиком, прореживание — только если в файле больше 200 млн
    MIN_POINT_BUDGET: 200000000,        // «пол» для проектов: сохранённый старый бюджет ниже этого значения один раз поднимается до него (ползунок «Плотность» потом можно менять вручную)
    IPC_MAX_POINTS: 20000000,           // сколько точек за один раз уходит из основного процесса в окно (ревизия 5): облако целиком в одном IPC-сообщении (50 млн точек ≈ 1,2 ГБ) роняло приложение на 87 % загрузки; больше — только прореженным или через «Стриминг»
    MAX_POINT_BUDGET: 300000000,        // верхняя граница ползунка «Плотность»
    LOD_DRAW_BUDGET: 80000000,          // сколько точек за кадр рисует поток октодерева (не путать с бюджетом чтения): бюджет 200 млн не должен перегружать видеокарту
    MIN_SAFE_PREVIEW_POINTS: 3000000,   // нижняя граница, до которой бюджет сужается, если свободной памяти не хватает (облако откроется, а не упадёт)
    CLOUD_CHUNK_BYTES: 8 * 1024 * 1024, // размер чанка при потоковом чтении с диска
    COLOR_SAMPLE_COUNT: 4000,          // сколько записей выбираем для определения глубины цвета
    // ---- Октодерево / потоковый рендер ----
    OCTREE_NODE_CAPACITY: 60000,       // целевое число точек на узел
    OCTREE_MAX_POINTS: 400000000,       // потолок точек при построении октодерева
    OCTREE_GPU_LRU_CAP: 1024,          // макс. число GPU-буферов узлов в кеше
    // ---- Экспорт ----
    PLY_EXPORT_MAX_POINTS: 200000000,  // лимит точек при экспорте/сохранении в PLY (под бюджет 200 млн)
    // ---- OCR ----
    OCR_SCAN_LIMIT: 6000,              // макс. число записей при поиске бинарников OCR
    // PDRF (point data record format) LAS -> байтовое смещение RGB в записи точки
    LAS_COLOR_OFFSETS: { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 },
    // Бюджет точек из настроек: нет значения → 200 млн; значение, сохранённое старыми версиями (ползунок «Плотность» без пометки
    // pointBudgetCustom), один раз поднимается до MIN_POINT_BUDGET; значение, выбранное вручную после этого (pointBudgetCustom), — как есть.
    resolvePointBudget: function (settings) {
      var DEF = 200000000, MINB = 200000000, MAXB = 300000000;
      var v = Number(settings && settings.pointBudget);
      if (!(v > 0)) return DEF;
      if (!(settings && settings.pointBudgetCustom)) v = Math.max(v, MINB);
      return Math.min(Math.round(v), Math.max(MAXB, MINB));
    }
  };
});
