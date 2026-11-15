/*
 * lixel-scan2bim-docs.js — v119 · Блок 3 ROADMAP-DOCS-AI
 * Панель «Документация»: загрузка отчёта сравнения `compare.json` (готовит
 * tools/scan2bim-py/docs-compare.py), просмотр таблицы «проект ↔ модель ↔ облако»,
 * скора соответствия 0–100, рекомендаций и подсказки, как получить отчёт без терминала.
 *
 * Что умеет:
 *   • «Загрузить отчёт сравнения» — input[type=file] JSON + валидация схемы
 *     (compare.json: docs/inputs, rows[], score, recommendations[]; поддерживается и
 *     упрощённая схема {docs, model, rows:[{name, project, model, cloud, delta_mm, delta_pct,
 *     status}], score, recommendations}); при ошибке ничего не ломается и не теряется;
 *   • отображение: объект/адрес из документации, скор 0–100 с цветом статуса и оценкой A–E,
 *     счётчики PASS/WARN/FAIL/—, покрытие проверок, таблица строк проект↔модель↔облако
 *     с Δмм/Δ%, блок рекомендаций, ограничения и непроверенные пункты;
 *   • кнопки «Обновить» (перечитать файл), «Сохранить отчёт» (JSON download),
 *     «Загрузить другой отчёт», «Как получить отчёт» (модалка с пошаговой инструкцией
 *     и готовыми командами CLI + «Копировать»);
 *   • пустое состояние: порядок «1. Загрузите документацию → 2. Сравните с моделью →
 *     3. Исправьте», напоминание, что облако и модель уже в приложении
 *     (window.__lxScan2BIM.state.model), и сводка загруженной модели рядом со скором.
 *
 * Всё локально: без Python/child_process/fetch, файл читается FileReader'ом и живёт в памяти
 * до явного «Сохранить отчёт». Палитра — токены tokens.css: violet #a78bfa / #6a52cb,
 * graphite #1c1b1a / #232221; без синего, чистого белого и градиентов.
 *
 * API: window.__lxS2BDocs = { open, close, isOpen, setModel, getModel, currentModel,
 *   setReport, getReport, clearReport, loadFile, importJson, refresh, saveReport, reportJson,
 *   parseCompareJson, normalizeCompare, scoreOf, gradeOf, statusOfScore, summaryOf, rowToStatus,
 *   normalizeStatusString, cellText, statusLabel, instructions, buildCommand, copyCommand,
 *   copyText, showHelp, hideHelp, isHelpOpen, setPythonPath, getPythonPath, getState,
 *   VERSION, REPORT_NAME, PYTHON_DEFAULT, TOOLS_DIR_DEFAULT, STATUS, STATUS_LABEL,
 *   DEFAULT_TOL_MM, DEFAULT_TOL_PCT, GRADE_BANDS }.
 * Для node --test доступен через module.exports; DOM/панель/модалка создаются только в окне.
 */
(function () {
  'use strict';

  var VERSION = '119';
  var SCHEMA_VERSION = 1;
  var REPORT_NAME = 'docs-compare-report.json';

  // Статусы строк: PASS/WARN/FAIL; UNVERIFIED показываем как «—».
  var STATUS = { PASS: 'pass', WARN: 'warn', FAIL: 'fail', NA: 'na' };
  var STATUS_LABEL = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', na: '—' };
  var STATUS_ORDER = [STATUS.PASS, STATUS.WARN, STATUS.FAIL, STATUS.NA];
  var DEFAULT_TOL_MM = 30;      // когда в отчёте нет tolerance: ±30 мм — допуск A-блока
  var DEFAULT_TOL_PCT = 2;      // ±2 % — второй допуск из PROJECT-VS-MODEL
  var GRADE_BANDS = [['A', 85], ['B', 70], ['C', 55], ['D', 40], ['E', 0]];

  // Python из DSH (DeepSeek Harness) и инструменты извлечения/сравнения документации.
  // Путь можно переопределить через setPythonPath()/buildCommand({python}) — см. getState().
  var PYTHON_DEFAULT = 'C:\\Users\\bob\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
  var TOOLS_DIR_DEFAULT = 'tools\\scan2bim-py';
  var CMD_DEFAULTS = {
    python: PYTHON_DEFAULT,
    toolsDir: TOOLS_DIR_DEFAULT,
    docsInput: 'D:\\BIM-TWIN-TEST\\docs',
    docsJson: 'D:\\BIM-TWIN-TEST\\docs\\docs.json',
    model: 'D:\\BIM-TWIN-TEST\\interior\\py2-final-v4.json',
    cloud: 'D:\\BIM-TWIN-TEST\\interior\\koridor-local-rgb.bin',
    out: 'D:\\BIM-TWIN-TEST\\docs\\compare.json'
  };

  // ===================== УТИЛИТЫ =====================
  function isFiniteNum(x) { return typeof x === 'number' && isFinite(x); }
  function numOrNull(x) {
    if (x === null || x === undefined || x === '' || typeof x === 'boolean') return null;
    var v = Number(x);
    return isFinite(v) ? v : null;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function fmtNum(x, d) {
    if (!isFiniteNum(x)) return '—';
    var s = (d == null ? String(x) : (+x).toFixed(d));
    return String(s).replace('.', ',');
  }
  function unitLabel(u) {
    var m = { mm: 'мм', m: 'м', m2: 'м²', 'm²': 'м²', cm: 'см', '%': '%' };
    return m[String(u)] || String(u || '');
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function firstString() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (isFiniteNum(v)) return String(v);
    }
    return '';
  }
  function isPlainObject(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function fail(reason) { return { ok: false, reason: reason || 'JSON не соответствует схеме отчёта сравнения' }; }
  function pctText(v) { return isFiniteNum(v) ? (v > 0 ? '+' : (v < 0 ? '−' : '')) + fmtNum(Math.abs(v), 2).replace(',00', '') + ' %' : '—'; }
  function mmText(v, unit) {
    if (!isFiniteNum(v)) return '—';
    return (v > 0 ? '+' : (v < 0 ? '−' : '')) + fmtNum(Math.abs(v), Math.abs(v) >= 100 ? 0 : 1).replace(',0', '') + ' ' + unitLabel(unit || 'mm');
  }
  function dateLabel(iso) {
    if (typeof iso !== 'string' || !iso) return '';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      function p(x) { return (x < 10 ? '0' : '') + x; }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    } catch (e) { return iso; }
  }
  function hhmmss(d) {
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function isModelOk(m) { return !!(m && m.ok && (m.walls || m.storeys || m.rooms)); }

  // ===================== СТАТУСЫ И СКОР =====================
  function normalizeStatusString(s) {
    if (typeof s !== 'string') return null;
    var t = s.trim().toUpperCase().replace(/[^A-Z0-9А-Я]/g, '');
    if (!t) return null;
    if (t === 'PASS' || t === 'PASSED' || t === 'OK' || t === 'TRUE' || t === 'УСПЕХ') return STATUS.PASS;
    if (t === 'WARN' || t === 'WARNING' || t === 'ВНИМАНИЕ' || t === 'ПРЕДУПРЕЖДЕНИЕ') return STATUS.WARN;
    if (t === 'FAIL' || t === 'FAILED' || t === 'ERROR' || t === 'FALSE' || t === 'ОШИБКА') return STATUS.FAIL;
    if (t === 'UNVERIFIED' || t === 'SKIP' || t === 'SKIPPED' || t === 'NA' || t === 'N/A' ||
      t === 'UNKNOWN' || t === 'NOTCHECKED' || t === 'НЕПРОВЕРЕНО') return STATUS.NA;
    return null;
  }
  /** Статус строки: сначала явный, иначе — из Δ и допуска; без данных «—». */
  function rowToStatus(row) {
    if (typeof row === 'string') return normalizeStatusString(row) || STATUS.NA;
    if (!isPlainObject(row)) return STATUS.NA;
    var explicit = normalizeStatusString(row.status);
    if (explicit) return explicit;
    var delta = isPlainObject(row.delta_mp) ? row.delta_mp : (isPlainObject(row.delta) ? row.delta : null);
    var abs = delta ? numOrNull(delta.abs !== undefined ? delta.abs : delta.value) : numOrNull(row.delta_mm);
    var pct = delta ? numOrNull(delta.pct) : numOrNull(row.delta_pct);
    var tol = null;
    if (isPlainObject(row.tolerance)) {
      var tv = row.tolerance.value;
      tol = numOrNull(row.tolerance.abs !== undefined ? row.tolerance.abs :
        (isPlainObject(tv) ? (tv.pass_mm !== undefined ? tv.pass_mm : tv.abs) : tv));
    } else {
      tol = numOrNull(row.tolerance);
    }
    if (abs !== null) return Math.abs(abs) <= (tol !== null ? Math.abs(tol) : DEFAULT_TOL_MM) ? STATUS.PASS : STATUS.FAIL;
    if (pct !== null) return Math.abs(pct) <= DEFAULT_TOL_PCT ? STATUS.PASS : STATUS.FAIL;
    return STATUS.NA;
  }
  function statusLabel(s) { return STATUS_LABEL[s] || STATUS_LABEL[STATUS.NA]; }
  function gradeOf(score) {
    var s = isFiniteNum(score) ? score : 0;
    for (var i = 0; i < GRADE_BANDS.length; i++) if (s >= GRADE_BANDS[i][1]) return GRADE_BANDS[i][0];
    return 'E';
  }
  function statusOfScore(score) {
    var s = isFiniteNum(score) ? score : 0;
    if (s >= 85) return 'ok';
    if (s >= 55) return 'warn';
    return 'err';
  }
  function statusesOfRows(rows) {
    var c = { pass: 0, warn: 0, fail: 0, na: 0, checks: 0 };
    if (!Array.isArray(rows)) return c;
    for (var i = 0; i < rows.length; i++) {
      var st = rows[i] && rows[i].status && rows[i].__normalized ? rows[i].status : rowToStatus(rows[i]);
      if (st === STATUS.PASS) c.pass++;
      else if (st === STATUS.WARN) c.warn++;
      else if (st === STATUS.FAIL) c.fail++;
      else c.na++;
    }
    c.checks = Array.isArray(rows) ? rows.length : 0;
    return c;
  }
  /**
   * Скор соответствия 0–100: явный score отчёта (число или {value}, дробный score
   * сохраняем — docs-compare.py выдаёт 92.7), иначе — по строкам
   * (PASS = 1, WARN = 0.5, FAIL = 0; «—» не учитывается, округление до целого).
   */
  function scoreOf(input) {
    if (isPlainObject(input)) {
      if (isFiniteNum(input.score)) return clamp(Math.round(input.score * 10) / 10, 0, 100);
      if (isPlainObject(input.score) && isFiniteNum(input.score.value)) return clamp(Math.round(input.score.value * 10) / 10, 0, 100);
    }
    var rows = Array.isArray(input) ? input : (isPlainObject(input) && Array.isArray(input.rows) ? input.rows : null);
    if (!rows) return 0;
    var c = statusesOfRows(rows);
    var total = c.pass + c.warn + c.fail;
    if (!total) return 0;
    return clamp(Math.round(100 * (c.pass + 0.5 * c.warn) / total), 0, 100);
  }
  /** Скор в интерфейсе: целое — без дробей, дробное — с одним знаком (92,7). */
  function fmtScore(s) {
    if (!isFiniteNum(s)) return '—';
    return s === Math.round(s) ? String(s) : fmtNum(s, 1);
  }
  /** Подпись допуска для title/подстрочника строки. */
  function toleranceText(tol) {
    if (!tol || !isFiniteNum(tol.abs)) return '';
    return 'допуск ±' + fmtNum(tol.abs, 0) + ' ' + unitLabel(tol.unit || 'mm');
  }
  /** Сводка PASS/WARN/FAIL/— (явная summary отчёта или расчёт по строкам).
   *  Поддерживает и нижний регистр (compare-v5), и ВЕРХНИЙ (compare-full-v5: PASS/WARN/FAIL/UNVERIFIED). */
  function summaryOf(input) {
    if (isPlainObject(input) && isPlainObject(input.summary)) {
      var s = input.summary;
      var pick = function () {
        for (var i = 0; i < arguments.length; i++) {
          var v = numOrNull(s[arguments[i]]);
          if (v !== null) return v;
        }
        return null;
      };
      var out = {
        checks: pick('checks', 'CHECKS', 'total', 'TOTAL'),
        pass: pick('pass', 'PASS', 'passed', 'PASSED'),
        warn: pick('warn', 'WARN', 'warning', 'WARNING', 'warnings'),
        fail: pick('fail', 'FAIL', 'failed', 'FAILED'),
        unverified: pick('unverified', 'UNVERIFIED', 'na', 'NA', 'skip', 'SKIP')
      };
      if (out.pass !== null || out.fail !== null || out.warn !== null) {
        var c0 = statusesOfRows(input.rows || []);
        if (out.checks === null) out.checks = c0.checks;
        if (out.pass === null) out.pass = c0.pass;
        if (out.warn === null) out.warn = c0.warn;
        if (out.fail === null) out.fail = c0.fail;
        if (out.unverified === null) out.unverified = c0.na;
        return out;
      }
    }
    var c = statusesOfRows(Array.isArray(input) ? input : (isPlainObject(input) && Array.isArray(input.rows) ? input.rows : []));
    return { checks: c.checks, pass: c.pass, warn: c.warn, fail: c.fail, unverified: c.na };
  }

  // ===================== ЯЧЕЙКИ И Δ =====================
  /** Текст значения ячейки: объект {value,unit} → «3300 мм», число/строка/null. */
  function cellText(cell) {
    if (cell === null || cell === undefined || cell === '') return '—';
    if (typeof cell === 'number') return isFinite(cell) ? fmtNum(cell) : '—';
    if (typeof cell === 'string') return cell.trim() || '—';
    if (isPlainObject(cell)) {
      var v = cell.value;
      var u = cell.unit;
      if (v === null || v === undefined || v === '') return '—';
      var nm = (typeof v === 'number') ? v
        : (typeof v === 'string' && v.trim() && isFinite(Number(v))) ? Number(v) : null;
      if (nm !== null) return fmtNum(nm) + (u ? ' ' + unitLabel(u) : '');
      return String(v);
    }
    return '—';
  }
  function normalizeCell(cell) {
    var value = null, unit = '', source = '', page = null;
    if (isPlainObject(cell)) {
      value = cell.value === undefined ? null : cell.value;
      unit = typeof cell.unit === 'string' ? cell.unit : '';
      source = typeof cell.source === 'string' ? cell.source : '';
      page = numOrNull(cell.page);
    } else {
      value = (cell === undefined) ? null : cell;
    }
    return { value: value, unit: unit, text: cellText(isPlainObject(cell) ? { value: value, unit: unit } : value), source: source, page: page };
  }
  function normalizeDelta(row) {
    var src = isPlainObject(row.delta_mp) ? row.delta_mp : (isPlainObject(row.delta) ? row.delta : null);
    var abs = null, pct = null, unit = 'mm';
    if (src) {
      // docs-compare.py: {value, unit, pct}; в раннем описании было {abs, unit, pct} — принимаем оба
      abs = numOrNull(src.abs !== undefined ? src.abs : src.value);
      pct = numOrNull(src.pct);
      unit = (typeof src.unit === 'string' && src.unit) ? src.unit : 'mm';
    } else {
      abs = numOrNull(row.delta_mm);
      pct = numOrNull(row.delta_pct);
    }
    if (abs === null && pct === null) return null;
    return { abs: abs, pct: pct, unit: unit };
  }
  function normalizeTolerance(tol) {
    if (tol === null || tol === undefined) return null;
    if (isPlainObject(tol)) {
      var unit = (typeof tol.unit === 'string' && tol.unit) ? tol.unit : 'mm';
      var v = tol.value;
      if (isPlainObject(v)) {
        // допуск дверей: {value:{pass_mm, warn_mm, unit}, unit:''}
        var pass = numOrNull(v.pass_mm !== undefined ? v.pass_mm : v.abs);
        var warn = numOrNull(v.warn_mm);
        if (pass === null && warn === null) return null;
        return {
          abs: pass !== null ? pass : warn,
          warn: warn,
          unit: (typeof v.unit === 'string' && v.unit) ? v.unit : unit
        };
      }
      var a = numOrNull(v !== undefined ? v : tol.abs);
      return a === null ? null : { abs: a, unit: unit };
    }
    var n = numOrNull(tol);
    return n === null ? null : { abs: n, unit: 'mm' };
  }
  function deltaText(delta) {
    if (!delta) return '—';
    var parts = [];
    if (delta.abs !== null) parts.push(mmText(delta.abs, delta.unit));
    if (delta.pct !== null) parts.push(pctText(delta.pct));
    return parts.length ? parts.join(' · ') : '—';
  }

  // ===================== ПАРСИНГ И ВАЛИДАЦИЯ compare.json =====================
  function normalizeDocs(docsRaw) {
    var d = isPlainObject(docsRaw) ? docsRaw : {};
    var primary = firstString(d.primary_pdf, d.pdf, d.main_pdf);
    return {
      object: firstString(d.object, d.object_name, d.title, d.name, d.project),
      address: firstString(d.address, d.location, d.addr),
      path: firstString(d.path, d.folder, d.docs_path),
      primaryPdf: primary,
      pages: numOrNull(d.pages),
      raw: d
    };
  }
  function normalizeModelInfo(modelRaw) {
    // в объединённом compare-full-v5.json inputs.model — строка-путь; в compare-v5 — объект
    var m = isPlainObject(modelRaw) ? modelRaw : {};
    var stats = isPlainObject(m.stats) ? m.stats : {};
    var height = numOrNull(m.storey_height_m !== undefined ? m.storey_height_m : (m.height !== undefined ? m.height : stats.height));
    var heightMm = numOrNull(m.storey_height_mm !== undefined ? m.storey_height_mm : m.height_mm);
    if (height === null && heightMm !== null) height = Math.round(heightMm) / 1000;
    return {
      path: firstString(m.path, m.file, m.json, typeof modelRaw === 'string' ? modelRaw : ''),
      md5: firstString(m.md5, m.hash, m.checksum),
      walls: numOrNull(m.walls !== undefined ? m.walls : stats.wallCount),
      wallsMeasured: numOrNull(m.walls_measured),
      rooms: numOrNull(m.rooms !== undefined ? m.rooms : stats.roomCount),
      roomsArea: numOrNull(m.rooms_area_m2 !== undefined ? m.rooms_area_m2 : stats.roomsArea),
      height: height,
      heightMm: heightMm,
      raw: modelRaw
    };
  }
  function normalizeCloudInfo(cloudRaw) {
    var c = isPlainObject(cloudRaw) ? cloudRaw : {};
    var height = numOrNull(c.height_m !== undefined ? c.height_m : c.height);
    var heightMm = numOrNull(c.height_mm);
    if (height === null && heightMm !== null) height = Math.round(heightMm) / 1000;
    return {
      path: firstString(c.path, c.file, typeof cloudRaw === 'string' ? cloudRaw : ''),
      measured: c.measured === true,
      height: height,
      heightMm: heightMm,
      floorVisible: numOrNull(c.floor_visible_m2 !== undefined ? c.floor_visible_m2 : c.floor_visible),
      floorY: numOrNull(c.floor_y),
      ceilY: numOrNull(c.ceil_y),
      perimeterCoveredPct: numOrNull(c.rooms_perimeter_covered_pct),
      floorPerimeterOuter: numOrNull(c.floor_perimeter_outer_m),
      floorAreaCells: numOrNull(c.floor_area_cells_m2),
      error: firstString(c.error),
      raw: cloudRaw
    };
  }
  function normalizeSeverity(s) {
    var t = typeof s === 'string' ? s.trim().toLowerCase() : '';
    if (t === 'fail' || t === 'error' || t === 'critical' || t === 'err') return 'fail';
    if (t === 'warn' || t === 'warning' || t === 'attention') return 'warn';
    return 'info';
  }
  function normalizeRecommendations(arr) {
    if (arr === undefined || arr === null) return { ok: true, items: [] };
    if (!Array.isArray(arr)) return { ok: false, reason: 'recommendations должен быть массивом' };
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i], where = 'recommendations[' + (i + 1) + ']';
      if (typeof it === 'string') { out.push({ severity: 'info', code: '', text: it }); continue; }
      if (!isPlainObject(it)) return { ok: false, reason: where + ': ожидалась строка или объект' };
      var text = firstString(it.text, it.message, it.label, it.title, it.note);
      if (!text) return { ok: false, reason: where + ': нет текста (text/message)' };
      out.push({ severity: normalizeSeverity(it.severity), code: firstString(it.code), text: text });
    }
    return { ok: true, items: out };
  }
  function normalizeStringList(arr, label) {
    if (arr === undefined || arr === null) return { ok: true, items: [] };
    if (!Array.isArray(arr)) return { ok: false, reason: label + ' должен быть массивом' };
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      if (typeof it === 'string') { out.push(it); continue; }
      if (isPlainObject(it)) {
        var t = firstString(it.text, it.message, it.label, it.title);
        if (t) { out.push(t); continue; }
      }
      return { ok: false, reason: label + '[' + (i + 1) + ']: ожидалась строка или объект с текстом' };
    }
    return { ok: true, items: out };
  }
  function normalizeUnverified(arr) {
    if (arr === undefined || arr === null) return { ok: true, items: [] };
    if (!Array.isArray(arr)) return { ok: false, reason: 'unverified должен быть массивом' };
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i], where = 'unverified[' + (i + 1) + ']';
      if (typeof it === 'string') { out.push({ id: '', label: it, reason: '' }); continue; }
      if (!isPlainObject(it)) return { ok: false, reason: where + ': ожидался объект' };
      var lbl = firstString(it.label, it.name, it.id);
      if (!lbl) return { ok: false, reason: where + ': нет label/name' };
      out.push({ id: firstString(it.id), label: lbl, reason: firstString(it.reason, it.note) });
    }
    return { ok: true, items: out };
  }
  function normalizeRow(rawRow, i) {
    if (!isPlainObject(rawRow)) return { ok: false, reason: 'строка ' + (i + 1) + ': ожидался объект' };
    var id = firstString(rawRow.id, rawRow.name);
    var label = firstString(rawRow.label, rawRow.name);
    if (!id && !label) return { ok: false, reason: 'строка ' + (i + 1) + ': нет названия (label/name)' };
    if (!label) label = id;
    if (!id) id = 'row-' + (i + 1);
    var row = {
      id: id,
      index: i,
      label: label,
      group: firstString(rawRow.group, rawRow.section),
      category: typeof rawRow.category === 'string' ? rawRow.category : '',
      project: normalizeCell(rawRow.project),
      model: normalizeCell(rawRow.model),
      cloud: normalizeCell(rawRow.cloud),
      delta: normalizeDelta(rawRow),
      tolerance: normalizeTolerance(rawRow.tolerance),
      status: rowToStatus(rawRow),
      note: firstString(rawRow.note, rawRow.hint),
      raw: rawRow
    };
    row.__normalized = true;
    return { ok: true, row: row };
  }
  /**
   * Нормализовать распарсенный JSON отчёта (обе схемы: docs-compare.py и упрощённая).
   * @returns {{ok:boolean, report?:object, raw?:object, reason?:string}}
   */
  function normalizeCompare(raw) {
    if (!isPlainObject(raw)) return fail('корень JSON должен быть объектом отчёта сравнения');
    if (raw.rows === undefined) return fail('нет массива rows (строк сравнения)');
    if (!Array.isArray(raw.rows)) return fail('rows должен быть массивом строк сравнения');
    if (raw.inputs !== undefined && !isPlainObject(raw.inputs)) return fail('inputs должен быть объектом');
    var rows = [];
    for (var i = 0; i < raw.rows.length; i++) {
      var nr = normalizeRow(raw.rows[i], i);
      if (!nr.ok) return fail(nr.reason);
      rows.push(nr.row);
    }
    var docsRaw = raw.docs !== undefined ? raw.docs : (isPlainObject(raw.inputs) ? raw.inputs.docs : undefined);
    if (docsRaw !== undefined && !isPlainObject(docsRaw)) return fail('docs должен быть объектом (объект/адрес документации)');
    var modelRaw = raw.model !== undefined ? raw.model : (isPlainObject(raw.inputs) ? raw.inputs.model : undefined);
    // объединённый compare-full-v5.json держит inputs.model строкой-путём — это допустимо
    if (modelRaw !== undefined && !isPlainObject(modelRaw) && typeof modelRaw !== 'string') return fail('model должен быть объектом/путём или отсутствовать');
    var cloudRaw = raw.cloud !== undefined ? raw.cloud : (isPlainObject(raw.inputs) ? raw.inputs.cloud : undefined);
    if (cloudRaw !== undefined && !isPlainObject(cloudRaw) && typeof cloudRaw !== 'string') return fail('cloud должен быть объектом/путём или отсутствовать');

    var scoreExplicit = false;
    if (raw.score !== undefined) {
      if (isPlainObject(raw.score)) {
        if (!isFiniteNum(raw.score.value)) return fail('score.value должен быть числом 0–100');
        scoreExplicit = true;
      } else if (isFiniteNum(raw.score)) {
        scoreExplicit = true;
      } else {
        return fail('score должен быть числом 0–100');
      }
    }
    var score = scoreOf(raw);
    var gradeRaw = typeof raw.grade === 'string' ? raw.grade.trim().toUpperCase() : '';
    var grade = /^[A-E]$/.test(gradeRaw) ? gradeRaw : gradeOf(score);
    var coverage = numOrNull(raw.coverage_pct);
    if (coverage !== null) coverage = clamp(coverage, 0, 100);
    var summary = summaryOf({ rows: rows, summary: raw.summary });
    var recs = normalizeRecommendations(raw.recommendations);
    if (!recs.ok) return fail(recs.reason);
    var lims = normalizeStringList(raw.limitations, 'limitations');
    if (!lims.ok) return fail(lims.reason);
    var unv = normalizeUnverified(raw.unverified);
    if (!unv.ok) return fail(unv.reason);
    if (raw.schema_version !== undefined && numOrNull(raw.schema_version) === null) return fail('schema_version должен быть числом');

    var docs = normalizeDocs(docsRaw);
    // группы строк (compare-full-v5): первая — основное сравнение, остальные — проверка по документации
    var groupList = [], groupSeen = {};
    for (var gi = 0; gi < rows.length; gi++) {
      var g = rows[gi].group;
      if (g && !groupSeen[g]) { groupSeen[g] = true; groupList.push(g); }
    }
    var primaryGroup = groupList.length ? groupList[0] : '';
    var verifyRows = [];
    if (groupList.length > 1) {
      for (var vi = 0; vi < rows.length; vi++) if (rows[vi].group && rows[vi].group !== primaryGroup) verifyRows.push(rows[vi]);
    }
    var scoreDocs = numOrNull(raw.score_docs);
    var scoreDocDims = numOrNull(raw.score_doc_dimensions);
    var report = {
      ok: true,
      title: firstString(raw.title),
      schema_version: numOrNull(raw.schema_version) !== null ? numOrNull(raw.schema_version) : SCHEMA_VERSION,
      generated_at: firstString(raw.generated_at),
      docs: docs,
      model: normalizeModelInfo(modelRaw),
      cloud: normalizeCloudInfo(cloudRaw),
      rows: rows,
      groups: groupList,
      primaryGroup: primaryGroup,
      verifyRows: verifyRows,
      score: score,
      score_derived: !scoreExplicit,
      scoreDocs: scoreDocs,
      scoreDocDimensions: scoreDocDims,
      hasSubScores: scoreDocs !== null || scoreDocDims !== null,
      grade: grade,
      coverage: coverage,
      summary: summary,
      recommendations: recs.items,
      limitations: lims.items,
      unverified: unv.items,
      raw: raw
    };
    return { ok: true, report: report, raw: raw };
  }
  /**
   * Разобрать текст/объект JSON отчёта сравнения и провалидировать схему.
   * При ошибке модель состояния панели не меняется.
   */
  function parseCompareJson(text) {
    if (text === null || text === undefined) return fail('пустой JSON');
    var raw;
    if (typeof text === 'string') {
      var s = text.replace(/^\uFEFF/, '').trim();
      if (!s) return fail('файл пустой');
      try { raw = JSON.parse(s); }
      catch (e) { return fail('синтаксис JSON: ' + ((e && e.message) || e)); }
    } else if (typeof text === 'object') {
      try { raw = JSON.parse(JSON.stringify(text)); }
      catch (e2) { return fail('JSON не сериализуется: ' + ((e2 && e2.message) || e2)); }
    } else {
      return fail('ожидался текст или объект JSON');
    }
    return normalizeCompare(raw);
  }

  // ===================== ИНСТРУКЦИЯ CLI =====================
  function cmdOptions(opts) {
    var c = {};
    for (var k in CMD_DEFAULTS) if (Object.prototype.hasOwnProperty.call(CMD_DEFAULTS, k)) c[k] = CMD_DEFAULTS[k];
    if (st && st.python) c.python = st.python;
    if (st && st.toolsDir) c.toolsDir = st.toolsDir;
    if (opts && typeof opts === 'object') {
      if (opts.python) c.python = String(opts.python);
      if (opts.toolsDir) c.toolsDir = String(opts.toolsDir);
      for (var k2 in opts) if (Object.prototype.hasOwnProperty.call(opts, k2) && CMD_DEFAULTS[k2] !== undefined) c[k2] = String(opts[k2]);
    }
    return c;
  }
  function psQuote(s) { return '"' + String(s == null ? '' : s).replace(/"/g, '`"') + '"'; }
  function joinPath(dir, file) {
    var d = String(dir || '').replace(/[\\/]+$/, '');
    return d ? d + '\\' + file : file;
  }
  /**
   * Готовая команда PowerShell: 'extract' — извлечение документации, 'compare' — сравнение.
   * Путь к Python и скриптам документирован в инструкции и переопределяется opts.
   */
  function buildCommand(kind, opts) {
    var c = cmdOptions(opts);
    var env = '$env:PYTHONIOENCODING="utf-8"; $env:PYTHONUTF8="1"; ';
    if (String(kind) === 'extract') {
      return env + '& ' + psQuote(c.python) + ' ' + psQuote(joinPath(c.toolsDir, 'docs-extract.py')) +
        ' --input ' + psQuote(c.docsInput) + ' --out ' + psQuote(c.docsJson);
    }
    return env + '& ' + psQuote(c.python) + ' ' + psQuote(joinPath(c.toolsDir, 'docs-compare.py')) +
      ' --docs ' + psQuote(c.docsJson) + ' --model ' + psQuote(c.model) +
      ' --cloud ' + psQuote(c.cloud) + ' --out ' + psQuote(c.out);
  }
  /** Пошаговая инструкция для пользователя без терминала + готовые команды. */
  function instructions(opts) {
    var c = cmdOptions(opts);
    return {
      title: 'Как получить отчёт сравнения',
      intro: 'Отчёт готовит Python-инструмент вне окна приложения: он извлекает размеры из проектной документации и сравнивает их с моделью и облаком. Всё локально и офлайн.',
      steps: [
        { n: 1, title: 'Загрузите документацию', text: 'Извлеките размеры из PDF/ZIP проекта: помещения и площади, габариты в осях, толщины стен, ширины дверей, отметки этажей — в docs.json.' },
        { n: 2, title: 'Сравните с моделью', text: 'docs-compare.py сверяет документацию, JSON модели приложения и облако точек: таблица «проект ↔ модель ↔ облако», Δмм/%, скор 0–100 и рекомендации → compare.json.' },
        { n: 3, title: 'Загрузите отчёт в панель', text: 'Нажмите «Загрузить отчёт сравнения» и выберите compare.json — появится таблица, скор и список рекомендаций. После правок в редакторе повторите сравнение.' }
      ],
      commands: [
        { id: 'extract', label: '1. Извлечение документации (docs-extract.py)', cmd: buildCommand('extract', opts) },
        { id: 'compare', label: '2. Сравнение с моделью и облаком (docs-compare.py)', cmd: buildCommand('compare', opts) }
      ],
      python: c.python,
      toolsDir: c.toolsDir,
      notes: [
        'Команды — для PowerShell (Windows): выполните их по одной в терминале.',
        'Python: ' + c.python + ' (поставляется с DSH; если у вас другой Python — замените путь).',
        'Файл compare.json появится в папке из параметра --out; его и загружайте в панель.',
        'С флагом --strict docs-compare.py вернёт код 1, если скор ниже порога или есть критичные расхождения — для CI, вручную можно без него.'
      ]
    };
  }

  // ===================== СОСТОЯНИЕ =====================
  var st = {
    panel: null,
    report: null,
    raw: null,
    rawText: null,
    file: null,
    fileName: '',
    status: '',
    error: '',
    verifyOpen: false,
    model: null,
    python: PYTHON_DEFAULT,
    toolsDir: TOOLS_DIR_DEFAULT,
    modal: null,
    keyOn: false
  };

  function currentModel() {
    try {
      if (typeof window !== 'undefined' && window.__lxS2BEditor && window.__lxS2BEditor.getModel) {
        var e = window.__lxS2BEditor.getModel();
        if (isModelOk(e)) return e;
      }
    } catch (e1) { }
    try {
      if (typeof window !== 'undefined' && window.__lxScan2BIM && window.__lxScan2BIM.state && isModelOk(window.__lxScan2BIM.state.model)) {
        return window.__lxScan2BIM.state.model;
      }
    } catch (e2) { }
    return null;
  }
  /** Сводка модели приложения (рядом со скором / в пустом состоянии). */
  function modelSummaryOf(model) {
    if (!isModelOk(model)) return { ok: false };
    var walls = (model.walls || []).length, rooms = model.rooms || [];
    var area = 0;
    for (var i = 0; i < rooms.length; i++) area += numOrNull(rooms[i].area) || polyArea(rooms[i].polygon);
    var height = numOrNull(model.storey && model.storey.height);
    if (height === null) {
      var h = numOrNull(model.storey && model.storey.ceilY) !== null && numOrNull(model.storey && model.storey.floorY) !== null
        ? numOrNull(model.storey.ceilY) - numOrNull(model.storey.floorY) : null;
      height = h;
    }
    return { ok: true, walls: walls, rooms: rooms.length, area: area, height: height };
  }
  function polyArea(poly) {
    if (!poly || poly.length < 3) return 0;
    var s = 0;
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      if (!a || !b) return 0;
      s += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(s) / 2;
  }

  // ===================== DOM: ПАНЕЛЬ =====================
  function toast(msg, err) {
    try {
      if (typeof window !== 'undefined' && window.__toast) return window.__toast(msg, err ? 'error' : 'info');
    } catch (e) { }
    if (typeof console !== 'undefined') console[err ? 'error' : 'log']('[scan2bim-docs] ' + msg);
  }
  function hydrate(scope) {
    try {
      if (typeof window === 'undefined') return;
      if (window.__lxKit && window.__lxKit.hydrate) return window.__lxKit.hydrate(scope);
      if (window.__lxIcons && window.__lxIcons.hydrate) return window.__lxIcons.hydrate(scope);
    } catch (e) { }
  }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function downloadText(text, name, mime) {
    if (typeof document === 'undefined') return false;
    try {
      var blob = new Blob([text], { type: mime || 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function () {
        try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) { }
      }, 400);
      return true;
    } catch (e) { return false; }
  }

  // Стили: только токены tokens.css — палитра violet #a78bfa / #6a52cb и graphite
  // #1c1b1a / #232221 (тёмная/светлая тема), без синего, чистого белого и градиентов.
  var CSS_ID = 'lxS2BDocsStyles';
  var CSS = [
    // панель живёт в правой колонке приложения (#stageSideR, ~328px) — не выходим за неё
    '.lx-s2bd.fpanel { width: 100%; max-width: 100%; right: 0; }',
    '.lx-s2bd .fpanel-body { display: flex; flex-direction: column; gap: 8px; }',
    '.lx-s2bd .fpanel-body > * { flex: 0 0 auto; }',
    '.lx-s2bd .lx-stats-h { color: var(--accent); }',
    // заголовок объекта/адреса
    '.lx-s2bd-title { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-3); background: var(--bg-2); }',
    '.lx-s2bd-title b { color: var(--txt); font-size: var(--fs-sm); font-weight: 600; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }',
    '.lx-s2bd-title small { overflow: hidden; color: var(--txt-3); font-size: var(--fs-xs); line-height: 1.35; text-overflow: ellipsis; }',
    '.lx-s2bd-title .lx-s2bd-addr { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }',
    '.lx-s2bd-title .lx-s2bd-meta { font: 10.5px/1.35 var(--mono); color: var(--txt-3); font-variant-numeric: tabular-nums; }',
    // скор
    '.lx-s2bd-score { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-3); background: var(--bg-2); }',
    '.lx-s2bd-score-v { display: flex; flex: none; align-items: baseline; gap: 2px; color: var(--accent); }',
    '.lx-s2bd-score-v b { font: 600 30px/1 var(--font); font-variant-numeric: tabular-nums; }',
    '.lx-s2bd-score-v small { color: var(--txt-3); font: 11px/1 var(--mono); }',
    '.lx-s2bd-score-m { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }',
    '.lx-s2bd-score-t { color: var(--txt); font-size: var(--fs-sm); font-weight: 600; }',
    '.lx-s2bd-score.ok .lx-s2bd-score-v { color: var(--ok); }',
    '.lx-s2bd-score.warn .lx-s2bd-score-v { color: var(--warn); }',
    '.lx-s2bd-score.err .lx-s2bd-score-v { color: var(--err); }',
    '.lx-s2bd-counts { display: flex; flex-wrap: wrap; gap: 4px 10px; font: 11px/1.3 var(--mono); font-variant-numeric: tabular-nums; }',
    '.lx-s2bd-counts .ok { color: var(--ok); }',
    '.lx-s2bd-counts .warn { color: var(--warn); }',
    '.lx-s2bd-counts .err { color: var(--err); }',
    '.lx-s2bd-counts .na { color: var(--txt-3); }',
    '.lx-s2bd-src { overflow: hidden; color: var(--txt-3); font: 10px/1.35 var(--mono); white-space: normal; }',
    // сводка модели приложения
    '.lx-s2bd-model { display: block; margin: 0; padding: 6px 8px; border-radius: var(--r-1); background: var(--accent-soft); color: var(--txt-2); font: 11px/1.45 var(--mono); font-variant-numeric: tabular-nums; }',
    '.lx-s2bd-model .lx-s2bd-model-tag { margin-right: 6px; color: var(--accent); font-weight: 600; }',
    '.lx-s2bd-model.none { background: var(--bg-2); color: var(--txt-3); }',
    // таблица сравнения: параметр (с Δ под ним) + проект/модель/облако + статус
    '.lx-s2bd-table { display: flex; flex-direction: column; flex: none; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--bg-2); overflow-x: auto; }',
    '.lx-s2bd-thead, .lx-s2bd-row { display: grid; grid-template-columns: minmax(70px, 1.35fr) minmax(48px, .8fr) minmax(48px, .8fr) minmax(48px, .8fr) auto; align-items: center; gap: 3px 5px; min-width: 290px; padding: 5px 8px; }',
    '.lx-s2bd-thead { color: var(--txt-3); font: 9px/1.3 var(--mono); letter-spacing: .04em; text-transform: uppercase; border-bottom: 1px solid var(--line); background: var(--bg-1); }',
    '.lx-s2bd-row { border-top: 1px solid var(--line); }',
    '.lx-s2bd-row:first-of-type, .lx-s2bd-thead + .lx-s2bd-row { border-top: 0; }',
    '.lx-s2bd-row:hover { background: var(--bg-3); }',
    '.lx-s2bd-param { display: flex; flex-direction: column; gap: 1px; min-width: 0; }',
    '.lx-s2bd-param b { overflow: hidden; color: var(--txt); font-size: 10.5px; font-weight: 500; line-height: 1.25; text-overflow: ellipsis; white-space: nowrap; }',
    '.lx-s2bd-sub { display: flex; align-items: baseline; gap: 6px; min-width: 0; overflow: hidden; }',
    '.lx-s2bd-cat { overflow: hidden; color: var(--txt-3); font: 9px/1.2 var(--mono); text-overflow: ellipsis; white-space: nowrap; }',
    '.lx-s2bd-cell { overflow: hidden; color: var(--txt-2); font: 10px/1.3 var(--mono); font-variant-numeric: tabular-nums; text-align: right; text-overflow: ellipsis; white-space: nowrap; }',
    '.lx-s2bd-cell.na { color: var(--txt-3); }',
    '.lx-s2bd-delta { flex: none; color: var(--txt-2); font: 9px/1.2 var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }',
    '.lx-s2bd-row[data-d-row-status="pass"] .lx-s2bd-delta { color: var(--ok); }',
    '.lx-s2bd-row[data-d-row-status="warn"] .lx-s2bd-delta { color: var(--warn); }',
    '.lx-s2bd-row[data-d-row-status="fail"] .lx-s2bd-delta { color: var(--err); }',
    '.lx-s2bd-row[data-d-row-status="pass"] .lx-s2bd-delta { color: var(--ok); }',
    '.lx-s2bd-row[data-d-row-status="warn"] .lx-s2bd-delta { color: var(--warn); }',
    '.lx-s2bd-row[data-d-row-status="fail"] .lx-s2bd-delta { color: var(--err); }',
    '.lx-s2bd-badge { flex: none; min-width: 42px; padding: 2px 5px; border-radius: 999px; font: 600 9.5px/1.4 var(--font); letter-spacing: .04em; text-align: center; }',
    '.lx-s2bd-badge.pass { background: var(--ok-soft); color: var(--ok); }',
    '.lx-s2bd-badge.warn { background: var(--warn-soft); color: var(--warn); }',
    '.lx-s2bd-badge.fail { background: var(--err-soft); color: var(--err); }',
    '.lx-s2bd-badge.na { background: var(--bg-4); color: var(--txt-3); }',
    // группы строк (compare-full-v5: docs-compare / документация ↔ облако/модель)
    '.lx-s2bd-ghead { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-top: 1px solid var(--line); background: var(--bg-1); color: var(--accent); font: 600 10px/1.3 var(--mono); letter-spacing: .02em; }',
    '.lx-s2bd-ghead .lx-s2bd-gcount { margin-left: auto; color: var(--txt-3); font-weight: 500; }',
    '.lx-s2bd-row[data-d-group=""] + .lx-s2bd-row { border-top: 1px solid var(--line); }',
    // под-скоры объединённого отчёта: документация↔модель и проверка по документации
    '.lx-s2bd-subscore { display: flex; flex-wrap: wrap; gap: 2px 10px; color: var(--txt-3); font: 10px/1.4 var(--mono); font-variant-numeric: tabular-nums; }',
    '.lx-s2bd-subscore b { color: var(--txt-2); font-weight: 600; }',
    '.lx-s2bd-subscore .ok { color: var(--ok); }',
    '.lx-s2bd-subscore .warn { color: var(--warn); }',
    // блок «Проверка по документации» (score_doc_dimensions + строки verify)
    '.lx-s2bd-verify { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--accent-line); border-radius: var(--r-2); background: var(--accent-soft); }',
    '.lx-s2bd-vscore { display: flex; align-items: baseline; gap: 8px; }',
    '.lx-s2bd-vscore b { color: var(--accent); font: 600 22px/1 var(--font); font-variant-numeric: tabular-nums; }',
    '.lx-s2bd-vscore.ok b { color: var(--ok); }',
    '.lx-s2bd-vscore.warn b { color: var(--warn); }',
    '.lx-s2bd-vscore.err b { color: var(--err); }',
    '.lx-s2bd-vscore small { color: var(--txt-3); font: 10px/1 var(--mono); }',
    '.lx-s2bd-vhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
    '.lx-s2bd-vhead b { color: var(--txt); font-size: var(--fs-sm); font-weight: 600; }',
    '.lx-s2bd-explain { margin: 0; color: var(--txt-2); font-size: var(--fs-xs); line-height: 1.45; }',
    '.lx-s2bd-explain b { color: var(--txt); font-weight: 600; }',
    '.lx-s2bd-vrow { display: flex; flex-direction: column; gap: 2px; padding: 5px 0; border-top: 1px solid var(--line); }',
    '.lx-s2bd-vrow-h { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }',
    '.lx-s2bd-vrow-h .lx-s2bd-vlabel { min-width: 0; overflow: hidden; color: var(--txt); font-size: 10.5px; font-weight: 500; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }',
    '.lx-s2bd-vvals { overflow: hidden; color: var(--txt-3); font: 9.5px/1.4 var(--mono); text-overflow: ellipsis; }',
    // рекомендации / ограничения / непроверенное
    '.lx-s2bd-recs { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }',
    '.lx-s2bd-rec { display: flex; gap: 8px; padding: 6px 8px; border-radius: var(--r-1); background: var(--bg-2); color: var(--txt-2); font-size: var(--fs-xs); line-height: 1.4; }',
    '.lx-s2bd-rec b { color: var(--txt); font: 600 10.5px/1.4 var(--mono); }',
    '.lx-s2bd-rec-dot { flex: none; width: 7px; height: 7px; margin-top: 5px; border-radius: 50%; background: var(--accent); }',
    '.lx-s2bd-rec.warn .lx-s2bd-rec-dot { background: var(--warn); }',
    '.lx-s2bd-rec.fail .lx-s2bd-rec-dot { background: var(--err); }',
    '.lx-s2bd-limits, .lx-s2bd-unv { margin: 0; padding: 0; list-style: none; }',
    '.lx-s2bd-limits li, .lx-s2bd-unv li { padding: 3px 0; border-top: 1px solid var(--line); color: var(--txt-3); font-size: var(--fs-xs); line-height: 1.4; }',
    '.lx-s2bd-unv b { color: var(--txt-2); font-weight: 500; }',
    // пустое состояние / шаги
    '.lx-s2bd-steps { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; counter-reset: lx-s2bd-step; }',
    '.lx-s2bd-steps li { display: flex; flex-direction: column; gap: 2px; padding: 7px 9px 7px 32px; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--bg-2); color: var(--txt-2); font-size: var(--fs-xs); line-height: 1.4; position: relative; counter-increment: lx-s2bd-step; }',
    '.lx-s2bd-steps li::before { content: counter(lx-s2bd-step); position: absolute; left: 9px; top: 7px; display: grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); font: 600 10px/1 var(--mono); }',
    '.lx-s2bd-steps b { color: var(--txt); font-size: var(--fs-xs); font-weight: 600; }',
    '.lx-s2bd-note { margin: 0; color: var(--txt-3); font-size: var(--fs-xs); line-height: 1.45; }',
    '.lx-s2bd-err { margin: 0; padding: 6px 8px; border-radius: var(--r-1); background: var(--err-soft); color: var(--err); font-size: var(--fs-xs); line-height: 1.4; }',
    '.lx-s2bd-import { display: flex; flex-direction: column; gap: 2px; }',
    '.lx-s2bd-import input[type="file"] { display: none; }',
    '.lx-s2bd-status { margin: 0; color: var(--txt-3); font: 10.5px/1.4 var(--mono); }',
    '.lx-s2bd-status:empty { display: none; }',
    '.lx-s2bd .lx-btnrow { margin-top: 0; }',
    '.lx-s2bd .lx-btnrow .btn { flex: 1 1 auto; }',
    // модалка «Как получить отчёт»
    '.lx-s2bd-card { width: min(640px, 92vw); max-height: min(78vh, 760px); overflow: auto; }',
    '.lx-s2bd-help-body { display: flex; flex-direction: column; gap: 8px; }',
    '.lx-s2bd-cmd { display: flex; flex-direction: column; gap: 3px; }',
    '.lx-s2bd-cmd-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--txt-2); font-size: var(--fs-xs); font-weight: 500; }',
    '.lx-s2bd-pre { margin: 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--bg-2); color: var(--txt); font: 10.5px/1.5 var(--mono); white-space: pre-wrap; word-break: break-all; }',
    '.lx-s2bd-help-body .lx-s2bd-note code { color: var(--accent); font-family: var(--mono); }',
    '.lx-s2bd-help-body .lx-s2bd-status { min-height: 14px; }'
  ].join('\n');

  function ensureStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(CSS_ID)) return;
    var s = document.createElement('style');
    s.id = CSS_ID;
    s.textContent = CSS;
    (document.head || document.documentElement || document.body).appendChild(s);
  }

  // ---------- разметка ----------
  function deltaCellHtml(r) {
    var d = r.delta;
    var abs = d && d.abs !== null ? mmText(d.abs, d.unit) : '';
    var pct = d && d.pct !== null ? pctText(d.pct) : '';
    var text = abs ? (pct ? abs + ' · ' + pct : abs) : (pct || 'Δ —');
    return '<span class="lx-s2bd-delta" data-d-cell="delta"' +
      ' data-d-delta-abs="' + (d && d.abs !== null ? d.abs : '') + '"' +
      ' data-d-delta-pct="' + (d && d.pct !== null ? d.pct : '') + '"' +
      ' title="Δ модель − проект">' + esc(text) + '</span>';
  }
  function statusRowHtml(r) {
    var tol = toleranceText(r.tolerance);
    var sub = r.category || tol || '';
    var titleParts = [];
    if (r.note) titleParts.push(r.note);
    if (tol) titleParts.push(tol);
    return '<div class="lx-s2bd-row" data-d-row="' + esc(r.id) + '" data-d-index="' + r.index + '" data-d-row-status="' + r.status + '"' +
      ' data-d-group="' + esc(r.group || '') + '"' +
      (titleParts.length ? ' title="' + esc(titleParts.join(' · ')) + '"' : '') + '>' +
      '<div class="lx-s2bd-param" data-d-cell="param">' +
      '<b title="' + esc(r.label) + '">' + esc(r.label) + '</b>' +
      '<span class="lx-s2bd-sub"><span class="lx-s2bd-cat" data-d-category>' + esc(sub) + '</span>' + deltaCellHtml(r) + '</span>' +
      '</div>' +
      '<div class="lx-s2bd-cell" data-d-cell="project">' + esc(r.project.text) + '</div>' +
      '<div class="lx-s2bd-cell" data-d-cell="model">' + esc(r.model.text) + '</div>' +
      '<div class="lx-s2bd-cell' + (r.cloud.value == null ? ' na' : '') + '" data-d-cell="cloud">' + esc(r.cloud.text) + '</div>' +
      '<span class="lx-s2bd-badge ' + r.status + '" data-d-badge>' + statusLabel(r.status) + '</span>' +
      '</div>';
  }
  function tableHtml(rep) {
    var head = '<div class="lx-s2bd-thead" aria-hidden="true"><span>Параметр</span><span>Проект</span>' +
      '<span>Модель</span><span>Облако</span><span></span></div>';
    if (!rep.rows.length) return '<div class="lx-s2bd-table" data-d-table>' + head + '<p class="lx-s2bd-note" style="padding:8px">В отчёте нет строк сравнения.</p></div>';
    // объединённый отчёт: строки сгруппированы (group), заголовки групп выводятся в таблице
    var groupCounts = {};
    for (var gi = 0; gi < rep.rows.length; gi++) {
      var gg = rep.rows[gi].group || '';
      groupCounts[gg] = (groupCounts[gg] || 0) + 1;
    }
    var rows = [], lastGroup = null;
    for (var i = 0; i < rep.rows.length; i++) {
      var r = rep.rows[i], g = r.group || '';
      if (g && g !== lastGroup) {
        rows.push('<div class="lx-s2bd-ghead" data-d-group-row="' + esc(g) + '">' +
          '<span data-d-group-name>' + esc(g) + '</span>' +
          '<span class="lx-s2bd-gcount">' + groupCounts[g] + ' строк</span></div>');
        lastGroup = g;
      } else if (!g) {
        lastGroup = null;
      }
      rows.push(statusRowHtml(r));
    }
    return '<div class="lx-s2bd-table" data-d-table>' + head + rows.join('') + '</div>';
  }
  function scoreBlockHtml(rep) {
    var tone = statusOfScore(rep.score);
    var sum = rep.summary || { pass: 0, warn: 0, fail: 0, unverified: 0 };
    var cov = rep.coverage !== null && rep.coverage !== undefined
      ? '<span class="lx-s2bd-src" data-d-coverage="' + rep.coverage + '">сверено ' + fmtNum(rep.coverage, 0) + ' % проверок' +
        (sum.checks ? ' · проверок ' + sum.checks : '') + '</span>'
      : (sum.checks ? '<span class="lx-s2bd-src" data-d-coverage="">проверок ' + sum.checks + '</span>' : '');
    var subParts = [];
    if (rep.scoreDocs !== null && rep.scoreDocs !== undefined) {
      subParts.push('<span data-d-score-docs="' + rep.scoreDocs + '">документация ↔ модель <b>' + fmtScore(rep.scoreDocs) + '</b></span>');
    }
    if (rep.scoreDocDimensions !== null && rep.scoreDocDimensions !== undefined) {
      subParts.push('<span data-d-score-dims="' + rep.scoreDocDimensions + '">проверка по документации <b>' + fmtScore(rep.scoreDocDimensions) + '</b></span>');
    }
    var sub = subParts.length ? '<span class="lx-s2bd-subscore" data-d-subscore>' + subParts.join('') + '</span>' : '';
    return '<div class="lx-s2bd-score ' + tone + '" data-d-score="' + rep.score + '" data-d-grade="' + esc(rep.grade) + '">' +
      '<div class="lx-s2bd-score-v"><b data-d-score-value>' + fmtScore(rep.score) + '</b><small>/100</small></div>' +
      '<div class="lx-s2bd-score-m"><span class="lx-s2bd-score-t">Соответствие документации · ' + esc(rep.grade) + '</span>' +
      '<span class="lx-s2bd-counts">' +
      '<span class="ok" data-d-count="pass">PASS ' + sum.pass + '</span>' +
      '<span class="warn" data-d-count="warn">WARN ' + sum.warn + '</span>' +
      '<span class="err" data-d-count="fail">FAIL ' + sum.fail + '</span>' +
      '<span class="na" data-d-count="na">— ' + sum.unverified + '</span></span>' +
      cov + sub + '</div></div>';
  }
  function modelSummaryHtml(where) {
    var ms = modelSummaryOf(st.model);
    if (!ms.ok) {
      return '<p class="lx-s2bd-model none" data-d-model-summary="none">Модель в приложении не построена — отчёт можно смотреть и без неё; постройте BIM в «Скан → BIM» или загрузите JSON в редакторе.</p>';
    }
    return '<p class="lx-s2bd-model" data-d-model-summary="' + esc([
      'Стены ' + ms.walls, 'Помещения ' + ms.rooms,
      'Площадь ' + fmtNum(ms.area, 1) + ' м²',
      'Высота ' + (ms.height !== null ? fmtNum(ms.height, 2) : '—') + ' м'
    ].join(' · ')) + '"><span class="lx-s2bd-model-tag">В приложении</span>' +
      ' Стены ' + ms.walls + ' · Помещения ' + ms.rooms +
      ' · Площадь ' + fmtNum(ms.area, 1) + ' м² · Высота ' + (ms.height !== null ? fmtNum(ms.height, 2) : '—') + ' м' +
      (where === 'empty' ? ' — эта модель будет сравниваться с документацией.' : '') + '</p>';
  }
  function titleHtml(rep) {
    var t = rep.docs.object || rep.title || rep.docs.address || st.fileName || 'Отчёт сравнения документации';
    var addr = rep.docs.address && rep.docs.address !== t ? rep.docs.address : '';
    var meta = [];
    if (st.fileName) meta.push(st.fileName);
    if (rep.generated_at) meta.push(dateLabel(rep.generated_at));
    if (rep.docs.pages) meta.push('стр. ' + rep.docs.pages);
    if (rep.scoreDocs !== null && rep.scoreDocs !== undefined) meta.push('docs↔модель ' + fmtScore(rep.scoreDocs));
    return '<div class="lx-s2bd-title" data-d-title>' +
      '<b data-d-object title="' + esc(t) + '">' + esc(t) + '</b>' +
      '<small class="lx-s2bd-addr" data-d-address' + (addr ? ' title="' + esc(addr) + '"' : '') + '>' + esc(addr) + '</small>' +
      '<small class="lx-s2bd-meta" data-d-file>' + esc(meta.join(' · ')) + '</small></div>';
  }
  function recommendationsHtml(rep) {
    var recs = rep.recommendations || [];
    var html = '<div class="lx-obj-h">Рекомендации' + (recs.length ? ' (' + recs.length + ')' : '') + '</div>';
    if (!recs.length) {
      return html + '<p class="lx-s2bd-note" data-d-recs-empty>Расхождений вне допуска нет — рекомендаций не требуется.</p>';
    }
    var lis = [];
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      lis.push('<li class="lx-s2bd-rec ' + esc(r.severity) + '" data-d-rec="' + i + '" data-d-severity="' + esc(r.severity) + '">' +
        '<span class="lx-s2bd-rec-dot" aria-hidden="true"></span>' +
        '<span class="lx-s2bd-rec-t">' + (r.code ? '<b>' + esc(r.code) + '</b> ' : '') + esc(r.text) + '</span></li>');
    }
    return html + '<ul class="lx-s2bd-recs" data-d-recs>' + lis.join('') + '</ul>';
  }
  function limitsHtml(rep) {
    if (!rep.limitations || !rep.limitations.length) return '';
    var lis = [];
    for (var i = 0; i < rep.limitations.length; i++) lis.push('<li data-d-limit="' + i + '">' + esc(rep.limitations[i]) + '</li>');
    return '<div data-d-limits><div class="lx-obj-h">Ограничения отчёта</div><ul class="lx-s2bd-limits">' + lis.join('') + '</ul></div>';
  }
  function unverifiedHtml(rep) {
    if (!rep.unverified || !rep.unverified.length) return '';
    var lis = [];
    for (var i = 0; i < rep.unverified.length; i++) {
      var u = rep.unverified[i];
      lis.push('<li data-d-unv="' + i + '"><b>' + esc(u.label) + '</b>' + (u.reason ? ' — ' + esc(u.reason) : '') + '</li>');
    }
    return '<div data-d-unverified><div class="lx-obj-h">Не проверено (' + rep.unverified.length + ')</div><ul class="lx-s2bd-unv">' + lis.join('') + '</ul></div>';
  }
  function verifyCounts(rep) {
    var c = { pass: 0, warn: 0, fail: 0, na: 0 };
    for (var i = 0; i < rep.verifyRows.length; i++) {
      var s = rep.verifyRows[i].status;
      if (s === STATUS.PASS) c.pass++;
      else if (s === STATUS.WARN) c.warn++;
      else if (s === STATUS.FAIL) c.fail++;
      else c.na++;
    }
    return c;
  }
  // Требование r131: «Проверка по документации» — score_doc_dimensions и 8 строк verify,
  // с пояснением разницы «документация ↔ модель» и «документация ↔ облако».
  function verifyBlockHtml(rep) {
    if (!rep.verifyRows || !rep.verifyRows.length) return '';
    var c = verifyCounts(rep);
    var dims = rep.scoreDocDimensions;
    var scoreTxt = (dims !== null && dims !== undefined) ? fmtNum(dims, 1) : '—';
    var scoreTone = (dims !== null && dims !== undefined) ? statusOfScore(dims) : 'na';
    var compareRows = Math.max(0, rep.rows.length - rep.verifyRows.length);
    var lis = [];
    for (var i = 0; i < rep.verifyRows.length; i++) {
      var r = rep.verifyRows[i];
      var vals = ['проект: ' + r.project.text, 'модель: ' + r.model.text, 'облако: ' + r.cloud.text];
      lis.push('<div class="lx-s2bd-vrow" data-d-verify-row="' + esc(r.id) + '" data-d-row-status="' + r.status + '">' +
        '<div class="lx-s2bd-vrow-h"><span class="lx-s2bd-vlabel" title="' + esc(r.label) + '">' + esc(r.label) + '</span>' +
        '<span class="lx-s2bd-badge ' + r.status + '">' + statusLabel(r.status) + '</span></div>' +
        '<div class="lx-s2bd-vvals">' + esc(vals.join(' · ')) + '</div></div>');
    }
    return '<div class="lx-s2bd-verify" data-d-verify-block>' +
      '<div class="lx-s2bd-vhead"><b>Проверка по документации</b><span class="lx-s2bd-counts">' +
      '<span class="ok" data-d-verify-count="pass">PASS ' + c.pass + '</span>' +
      '<span class="warn" data-d-verify-count="warn">WARN ' + c.warn + '</span>' +
      '<span class="err" data-d-verify-count="fail">FAIL ' + c.fail + '</span>' +
      '<span class="na" data-d-verify-count="na">— ' + c.na + '</span></span></div>' +
      '<div class="lx-s2bd-vscore ' + scoreTone + '"><b data-d-verify-score="' + (dims !== null && dims !== undefined ? dims : '') + '">' + scoreTxt + '</b>' +
      '<small>/100 · score_doc_dimensions</small></div>' +
      '<p class="lx-s2bd-explain" data-d-explain="docs-model"><b>Документация ↔ модель</b> — score_docs ' +
      (rep.scoreDocs !== null && rep.scoreDocs !== undefined ? fmtScore(rep.scoreDocs) : '—') +
      ': насколько модель совпадает с проектом (строк compare: ' + compareRows + ').</p>' +
      '<p class="lx-s2bd-explain" data-d-explain="docs-cloud"><b>Документация ↔ облако</b> — ' + scoreTxt +
      ': насколько облако и модель подтверждают размеры проекта (коридор, ячейки, высота, толщины, двери; строк verify: ' + rep.verifyRows.length + ').</p>' +
      lis.join('') + '</div>';
  }
  function stepsHtml() {
    return '<ol class="lx-s2bd-steps" data-d-steps>' +
      '<li data-d-step="1"><b>Загрузите документацию</b><span>PDF/ZIP проекта → docs-extract.py извлекает помещения, площади, толщины стен, двери и отметки этажей.</span></li>' +
      '<li data-d-step="2"><b>Сравните с моделью</b><span>docs-compare.py сверяет документацию, модель приложения и облако → compare.json со скором и рекомендациями.</span></li>' +
      '<li data-d-step="3"><b>Исправьте</b><span>Откройте «Редактор модели», поправьте расхождения и повторите сравнение.</span></li>' +
      '</ol>';
  }
  function importRowHtml() {
    return '<div class="lx-s2bd-import" data-d-import>' +
      '<div class="lx-btnrow">' +
      '<button type="button" class="btn sm" data-act="load-report" data-ico="upload" data-tip="Выбрать compare.json — отчёт сравнения документации с моделью и облаком">Загрузить отчёт сравнения</button>' +
      '</div>' +
      '<input type="file" accept=".json,application/json" data-d-import-input aria-label="Файл отчёта сравнения JSON" hidden />' +
      '</div>';
  }
  function actionRowHtml(hasReport) {
    if (!hasReport) {
      return '<div class="lx-btnrow">' +
        '<button type="button" class="btn sm" data-act="show-help" data-ico="clipboard-list" data-tip="Как извлечь документацию и сравнить её с моделью: готовые команды CLI">Как получить отчёт</button>' +
        '</div>';
    }
    var verifyBar = '';
    var rep = st.report;
    if (rep && rep.verifyRows && rep.verifyRows.length) {
      var dims = rep.scoreDocDimensions;
      var vLabel = (st.verifyOpen ? 'Скрыть проверку по документации' : 'Проверка по документации') +
        ((dims !== null && dims !== undefined) ? ' · ' + fmtScore(dims) : '');
      verifyBar = '<div class="lx-btnrow" data-d-verify-bar><button type="button" class="btn sm' + (st.verifyOpen ? ' primary' : '') + '"' +
        ' data-act="toggle-verify" data-ico="clipboard-check" aria-pressed="' + (st.verifyOpen ? 'true' : 'false') + '"' +
        ' data-tip="score_doc_dimensions и строки verify: коридор, ячейки, высота, толщины, двери; разница «документация ↔ модель» и «документация ↔ облако»">' +
        vLabel + '</button></div>';
    }
    return verifyBar +
      '<div class="lx-btnrow">' +
      '<button type="button" class="btn sm" data-act="refresh" data-ico="refresh-cw" data-tip="Перечитать файл отчёта и обновить сводку модели">Обновить</button>' +
      '<button type="button" class="btn sm" data-act="save-report" data-ico="download" data-tip="Сохранить отчёт сравнения в JSON">Сохранить отчёт</button>' +
      '</div>' +
      '<div class="lx-btnrow">' +
      '<button type="button" class="btn sm" data-act="load-report" data-ico="upload" data-tip="Выбрать другой compare.json">Загрузить другой отчёт</button>' +
      '<button type="button" class="btn sm" data-act="show-help" data-ico="clipboard-list" data-tip="Как извлечь документацию и сравнить её с моделью">Как получить отчёт</button>' +
      '</div>';
  }
  function statusHtml() {
    return '<p class="lx-s2bd-status" data-d-status role="status" aria-live="polite">' + esc(st.status || '') + '</p>';
  }
  function bodyHtml() {
    var rep = st.report;
    var html = [];
    if (st.error) html.push('<p class="lx-s2bd-err" data-d-error role="alert">' + esc(st.error) + '</p>');
    if (!rep) {
      html.push('<p class="sec-note" data-d-hint="empty">Загрузите отчёт сравнения — и увидите, что в BIM-модели расходится с проектной документацией и облаком, и что стоит исправить.</p>');
      html.push(stepsHtml());
      html.push('<p class="lx-s2bd-note" data-d-note="source">Облако и модель уже в приложении: модель — <code>window.__lxScan2BIM.state.model</code>; сравнение делает <code>docs-compare.py</code> и сохраняет <code>compare.json</code>.</p>');
      html.push(modelSummaryHtml('empty'));
      html.push(importRowHtml());
      html.push(actionRowHtml(false));
      html.push(statusHtml());
      return html.join('');
    }
    html.push(titleHtml(rep));
    html.push(scoreBlockHtml(rep));
    html.push(modelSummaryHtml('report'));
    if (rep.verifyRows.length && st.verifyOpen) html.push(verifyBlockHtml(rep));
    html.push('<div class="lx-obj-h">Проект ↔ модель ↔ облако</div>');
    html.push(tableHtml(rep));
    html.push(recommendationsHtml(rep));
    html.push(limitsHtml(rep));
    html.push(unverifiedHtml(rep));
    html.push(importRowHtml());
    html.push(actionRowHtml(true));
    html.push(statusHtml());
    return html.join('');
  }

  function ensurePanel() {
    if (typeof document === 'undefined') return null;
    if (st.panel && st.panel.isConnected) return st.panel;
    var ex = document.getElementById('lxS2BDocsPanel');
    if (ex) { st.panel = ex; return ex; }
    ensureStyles();
    var p = el('section', 'fpanel fp-right lx-s2bd');
    p.id = 'lxS2BDocsPanel';
    p.setAttribute('aria-label', 'Документация: сравнение с моделью');
    p.setAttribute('data-esc', '1');
    p.setAttribute('data-d-panel', '1');
    p.style.display = 'none';
    p.innerHTML = '<div class="fpanel-inner">' +
      '<header class="fpanel-head"><span class="fpanel-ico" data-ico="file-text"></span><h3>Документация</h3>' +
      '<div class="fpanel-actions">' +
      '<button id="lxS2BDocsRefresh" class="icon-btn" type="button" data-act="refresh" data-ico="refresh-cw" data-tip="Перечитать файл отчёта" aria-label="Перечитать отчёт"></button>' +
      '<button id="lxS2BDocsHelp" class="icon-btn" type="button" data-act="show-help" data-ico="clipboard-list" data-tip="Как получить отчёт" aria-label="Как получить отчёт"></button>' +
      '<button id="lxS2BDocsClose" class="icon-btn" type="button" data-panel-close data-ico="x" data-tip="Закрыть" aria-label="Закрыть панель документации"></button>' +
      '</div></header>' +
      '<div class="fpanel-body lx-sec-body" data-d-body="1"></div>' +
      '</div>';
    var host = document.getElementById('stageSideR') || document.querySelector('.stage') || document.body;
    host.appendChild(p);
    var closeBtn = p.querySelector('#lxS2BDocsClose');
    if (closeBtn) closeBtn.onclick = close;
    p.addEventListener('click', onPanelClick);
    p.addEventListener('change', onPanelChange);
    hydrate(p);
    st.panel = p;
    return p;
  }

  function render() {
    if (typeof document === 'undefined') return;
    var p = ensurePanel();
    if (!p) return;
    var body = p.querySelector('[data-d-body]');
    if (!body) return;
    body.innerHTML = bodyHtml();
    hydrate(body);
    var refreshBtn = p.querySelector('#lxS2BDocsRefresh');
    if (refreshBtn) refreshBtn.disabled = !st.report && !st.file;
  }
  function panelNode(sel) {
    try { return st.panel ? st.panel.querySelector(sel) : null; } catch (e) { return null; }
  }

  // ===================== ЧТЕНИЕ ФАЙЛА / ИМПОРТ =====================
  function readFileText(file) {
    return new Promise(function (resolve, reject) {
      try {
        if (typeof FileReader === 'undefined') { reject(new Error('FileReader недоступен')); return; }
        var fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result == null ? '' : fr.result)); };
        fr.onerror = function () { reject(new Error('не удалось прочитать файл')); };
        fr.readAsText(file);
      } catch (e) { reject(e); }
    });
  }
  /** Импорт текста/объекта JSON отчёта; при ошибке прежний отчёт сохраняется. */
  function importJson(text, meta) {
    var res = parseCompareJson(text);
    if (!res || !res.ok) {
      var reason = (res && res.reason) || 'не удалось разобрать JSON';
      st.error = 'Импорт отклонён: ' + reason;
      st.status = st.error;
      toast(st.error, true);
      render();
      return { ok: false, reason: reason };
    }
    var report = res.report;
    report.loadedAt = new Date().toISOString();
    st.report = report;
    st.raw = res.raw;
    st.rawText = (typeof text === 'string') ? text : JSON.stringify(res.raw);
    if (meta && meta.fileName) st.fileName = String(meta.fileName);
    else if (!st.fileName) st.fileName = 'compare.json';
    st.error = '';
    st.status = 'Загружено: ' + st.fileName + ' · скор ' + fmtScore(report.score) + '/100 · строк ' + report.rows.length +
      (report.verifyRows.length ? ' · проверка по документации ' + (report.scoreDocDimensions !== null ? fmtScore(report.scoreDocDimensions) : '—') : '');
    // объединённый отчёт: блок «Проверка по документации» показываем сразу, кнопка может свернуть
    st.verifyOpen = !!(report.verifyRows && report.verifyRows.length);
    if (meta && meta.keepFile === false) st.file = null;
    render();
    toast('Отчёт сравнения загружен: скор ' + fmtScore(report.score) + '/100, строк ' + report.rows.length);
    return { ok: true, report: report };
  }
  /** Загрузить отчёт из File (input[type=file]); возвращает Promise. */
  function loadFile(file) {
    if (!file) { toast('Файл отчёта не выбран', true); return Promise.resolve({ ok: false, reason: 'файл не выбран' }); }
    st.file = file;
    st.fileName = file.name || 'compare.json';
    st.status = 'Читаю отчёт: ' + st.fileName + '…';
    st.error = '';
    render();
    return readFileText(file).then(function (text) {
      var res = importJson(text, { fileName: st.fileName });
      if (!res.ok) st.status = 'Импорт отклонён: ' + res.reason;
      render();
      return res;
    }, function (err) {
      st.error = 'Не удалось прочитать файл: ' + ((err && err.message) || err);
      st.status = st.error;
      toast(st.error, true);
      render();
      return { ok: false, reason: st.error };
    });
  }
  /** «Обновить»: перечитать последний файл отчёта (или перерисовать отчёт из памяти). */
  function refresh() {
    st.model = currentModel() || st.model;
    if (st.file && typeof FileReader !== 'undefined') {
      st.status = 'Обновляю отчёт: ' + st.fileName + '…';
      st.error = '';
      render();
      return readFileText(st.file).then(function (text) {
        return importJson(text, { fileName: st.fileName, keepFile: true });
      }, function (err) {
        st.error = 'Обновить не удалось: ' + ((err && err.message) || err);
        st.status = st.error;
        toast(st.error, true);
        render();
        return { ok: false, reason: st.error };
      });
    }
    st.status = 'Обновлено ' + hhmmss(new Date()) + (st.report ? ' · отчёт из памяти' : ' · файл не выбран');
    render();
    return Promise.resolve({ ok: !!st.report });
  }
  function openFilePicker() {
    var inp = panelNode('[data-d-import-input]');
    if (!inp) { render(); inp = panelNode('[data-d-import-input]'); }
    if (!inp) { toast('Поле выбора файла не найдено', true); return false; }
    try { inp.click(); return true; }
    catch (e) { toast('Не удалось открыть выбор файла: ' + ((e && e.message) || e), true); return false; }
  }
  function onPanelChange(e) {
    var t = e && e.target;
    if (!t || typeof t.hasAttribute !== 'function' || !t.hasAttribute('data-d-import-input')) return;
    var file = t.files && t.files[0];
    if (!file) return;
    loadFile(file);
    try { t.value = ''; } catch (e2) { }
  }
  function onPanelClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var actNode = t.closest('[data-act]');
    if (!actNode) return;
    e.preventDefault();
    e.stopPropagation();
    var act = actNode.getAttribute('data-act');
    if (act === 'load-report') { openFilePicker(); return; }
    if (act === 'refresh') { refresh(); return; }
    if (act === 'save-report') { saveReport(); return; }
    if (act === 'show-help') { showHelp(); return; }
    if (act === 'toggle-verify') {
      st.verifyOpen = !st.verifyOpen;
      render();
      return;
    }
    if (act === 'open-build') {
      try { if (typeof window !== 'undefined' && window.__lxScan2BIM && window.__lxScan2BIM.open) window.__lxScan2BIM.open(); } catch (e2) { }
    }
  }

  function reportJson() {
    if (!st.report) return null;
    if (st.rawText) return st.rawText;
    try { return JSON.stringify(st.raw || st.report.raw || st.report, null, 2); } catch (e) { return null; }
  }
  function saveReport() {
    if (!st.report) { toast('Сначала загрузите отчёт сравнения', true); return false; }
    var text = reportJson();
    if (!text) { toast('Не удалось собрать JSON отчёта', true); return false; }
    var ok = downloadText(text, REPORT_NAME, 'application/json');
    if (ok) {
      st.status = 'Отчёт сохранён: ' + REPORT_NAME;
      toast('Отчёт сохранён: ' + REPORT_NAME);
    } else {
      st.status = 'Не удалось сохранить отчёт';
      toast(st.status, true);
    }
    render();
    return ok;
  }

  // ===================== МОДАЛКА «КАК ПОЛУЧИТЬ ОТЧЁТ» =====================
  function copyText(text) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
      }
    } catch (e) { }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    if (typeof document === 'undefined') return false;
    try {
      var ta = document.createElement('textarea');
      ta.value = String(text == null ? '' : text);
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      var ok = false;
      if (typeof document.execCommand === 'function') { try { ok = document.execCommand('copy'); } catch (e) { ok = false; } }
      if (ta.parentNode) ta.parentNode.removeChild(ta);
      return !!ok;
    } catch (e2) { return false; }
  }
  function showHelp() {
    if (typeof document === 'undefined') return null;
    hideHelp();
    ensureStyles();
    var info = instructions();
    var cmds = [];
    for (var i = 0; i < info.commands.length; i++) {
      var c = info.commands[i];
      cmds.push('<div class="lx-s2bd-cmd"><div class="lx-s2bd-cmd-h"><span>' + esc(c.label) + '</span>' +
        '<button type="button" class="btn xs" data-act="copy-command" data-cmd="' + esc(c.id) + '" data-ico="copy" ' +
        'data-tip="Скопировать команду в буфер обмена">Копировать</button></div>' +
        '<pre class="lx-s2bd-pre" data-d-cmd="' + esc(c.id) + '" tabindex="0">' + esc(c.cmd) + '</pre></div>');
    }
    var m = el('div', 'modal lx-s2bd-help');
    m.setAttribute('data-d-modal', 'help');
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-label', info.title);
    m.innerHTML = '<div class="modal-card md lx-s2bd-card" role="document">' +
      '<div class="modal-head"><span id="lxS2BDocsHelpTitle">' + esc(info.title) + '</span>' +
      '<button type="button" class="x" data-act="close-help" data-ico="x" aria-label="Закрыть"></button></div>' +
      '<div class="form-body lx-s2bd-help-body">' +
      '<p class="lx-s2bd-note" data-d-help-intro>' + esc(info.intro) + '</p>' +
      '<ol class="lx-s2bd-steps" data-d-help-steps>' +
      info.steps.map(function (s) { return '<li data-d-help-step="' + s.n + '"><b>' + esc(s.title) + '</b><span>' + esc(s.text) + '</span></li>'; }).join('') +
      '</ol>' +
      '<p class="lx-s2bd-note">Команды для PowerShell (Windows): выполните по одной, затем загрузите <code>compare.json</code> в панель.</p>' +
      cmds.join('') +
      '<p class="lx-s2bd-note" data-d-help-note>' + info.notes.map(function (n) { return esc(n); }).join(' ') + '</p>' +
      '<p class="lx-s2bd-status" data-d-help-status role="status" aria-live="polite"></p>' +
      '</div></div>';
    (document.body || document.documentElement).appendChild(m);
    hydrate(m);
    m.addEventListener('click', onHelpClick);
    if (document.addEventListener) document.addEventListener('keydown', onHelpKey, true);
    setTimeout(function () { try { m.classList.add('open'); } catch (e) { } }, 20);
    st.modal = m;
    st.status = 'Инструкция: как получить отчёт сравнения';
    return m;
  }
  function hideHelp() {
    if (!st.modal) return;
    var m = st.modal;
    st.modal = null;
    try { if (m.parentNode) m.parentNode.removeChild(m); } catch (e) { }
    if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('keydown', onHelpKey, true);
  }
  function isHelpOpen() { return !!st.modal; }
  function onHelpKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideHelp(); }
  }
  function onHelpClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var actNode = t.closest('[data-act]');
    if (!actNode) { if (t === st.modal) hideHelp(); return; }
    e.preventDefault();
    e.stopPropagation();
    var act = actNode.getAttribute('data-act');
    if (act === 'copy-command') { copyCommand(actNode.getAttribute('data-cmd')); return; }
    if (act === 'close-help') { hideHelp(); return; }
  }
  /** Скопировать готовую CLI-команду и показать результат в модалке. */
  function copyCommand(id) {
    var info = instructions();
    var text = null;
    for (var i = 0; i < info.commands.length; i++) if (info.commands[i].id === id) text = info.commands[i].cmd;
    if (!text) text = info.commands[info.commands.length - 1] ? info.commands[info.commands.length - 1].cmd : '';
    return copyText(text).then(function (ok) {
      var msg = ok ? 'Команда скопирована в буфер обмена' : 'Не удалось скопировать — выделите команду и нажмите Ctrl+C';
      var node = st.modal ? st.modal.querySelector('[data-d-help-status]') : null;
      if (node) node.textContent = msg;
      st.status = msg;
      if (ok) toast(msg); else toast(msg, true);
      return ok;
    });
  }

  // ===================== ОТКРЫТИЕ / ЗАКРЫТИЕ / API =====================
  function isOpen() {
    return !!(st.panel && st.panel.style && st.panel.style.display !== 'none' && st.panel.isConnected !== false);
  }
  /**
   * Открыть панель «Документация».
   * @param {object|null} [model] — модель приложения; без аргумента берётся текущая.
   */
  function open(model) {
    if (typeof document === 'undefined') return null;
    if (model !== undefined) st.model = model || null;
    else st.model = currentModel() || st.model || null;
    ensureStyles();
    var p = ensurePanel();
    if (!p) return null;
    p.style.display = 'block';
    p.classList.remove('folded');
    render();
    hydrate(p);
    return p;
  }
  function close() {
    var p = ensurePanel();
    if (p) p.style.display = 'none';
    hideHelp();
    st.status = '';
  }
  function setModel(model) {
    st.model = model || null;
    if (isOpen()) render();
    return st.model;
  }
  function getModel() { return st.model; }
  function setReport(input) {
    var res = parseCompareJson(input);
    if (!res || !res.ok) {
      st.error = 'Импорт отклонён: ' + ((res && res.reason) || 'не удалось разобрать JSON');
      st.status = st.error;
      render();
      return res;
    }
    st.report = res.report; st.raw = res.raw; st.rawText = (typeof input === 'string') ? input : JSON.stringify(res.raw);
    st.error = '';
    st.verifyOpen = !!(res.report.verifyRows && res.report.verifyRows.length);
    st.status = 'Отчёт загружен · скор ' + fmtScore(res.report.score) + '/100';
    render();
    return res;
  }
  function getReport() { return st.report; }
  function clearReport() {
    st.report = null; st.raw = null; st.rawText = null; st.file = null; st.fileName = '';
    st.error = ''; st.status = 'Отчёт очищен'; st.verifyOpen = false;
    render();
    return true;
  }
  function setPythonPath(p) { if (p) st.python = String(p); return st.python; }
  function getPythonPath() { return st.python; }
  function getState() {
    return {
      version: VERSION,
      hasReport: !!st.report,
      hasFile: !!st.file,
      fileName: st.fileName,
      score: st.report ? st.report.score : null,
      grade: st.report ? st.report.grade : null,
      scoreDocs: st.report ? st.report.scoreDocs : null,
      scoreDocDimensions: st.report ? st.report.scoreDocDimensions : null,
      rows: st.report ? st.report.rows.length : 0,
      groups: st.report ? st.report.groups.slice() : [],
      verifyRows: st.report ? st.report.verifyRows.length : 0,
      verifyOpen: !!st.verifyOpen,
      recommendations: st.report ? st.report.recommendations.length : 0,
      title: st.report ? (st.report.docs.object || st.report.title || st.report.docs.address || '') : '',
      error: st.error,
      status: st.status,
      model: modelSummaryOf(st.model),
      python: st.python,
      helpOpen: isHelpOpen()
    };
  }

  var API = {
    version: VERSION,
    VERSION: VERSION,
    REPORT_NAME: REPORT_NAME,
    SCHEMA_VERSION: SCHEMA_VERSION,
    PYTHON_DEFAULT: PYTHON_DEFAULT,
    TOOLS_DIR_DEFAULT: TOOLS_DIR_DEFAULT,
    CMD_DEFAULTS: CMD_DEFAULTS,
    STATUS: STATUS,
    STATUS_LABEL: STATUS_LABEL,
    DEFAULT_TOL_MM: DEFAULT_TOL_MM,
    DEFAULT_TOL_PCT: DEFAULT_TOL_PCT,
    GRADE_BANDS: GRADE_BANDS,
    // чистые функции (node --test)
    parseCompareJson: parseCompareJson,
    normalizeCompare: normalizeCompare,
    normalizeRow: normalizeRow,
    normalizeCell: normalizeCell,
    normalizeDelta: normalizeDelta,
    scoreOf: scoreOf,
    gradeOf: gradeOf,
    statusOfScore: statusOfScore,
    summaryOf: summaryOf,
    rowToStatus: rowToStatus,
    normalizeStatusString: normalizeStatusString,
    cellText: cellText,
    statusLabel: statusLabel,
    deltaText: deltaText,
    fmtScore: fmtScore,
    toleranceText: toleranceText,
    modelSummaryOf: modelSummaryOf,
    instructions: instructions,
    buildCommand: buildCommand,
    copyText: copyText,
    // панель
    open: open,
    close: close,
    isOpen: isOpen,
    setModel: setModel,
    getModel: getModel,
    currentModel: currentModel,
    setReport: setReport,
    getReport: getReport,
    clearReport: clearReport,
    loadFile: loadFile,
    importJson: importJson,
    refresh: refresh,
    saveReport: saveReport,
    reportJson: reportJson,
    showHelp: showHelp,
    hideHelp: hideHelp,
    isHelpOpen: isHelpOpen,
    copyCommand: copyCommand,
    setPythonPath: setPythonPath,
    getPythonPath: getPythonPath,
    getState: getState,
    openFilePicker: openFilePicker
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.__lxS2BDocs = API;
  if (typeof globalThis !== 'undefined' && typeof window === 'undefined') {
    try { globalThis.__lxS2BDocs = API; } catch (e) { }
  }
})();
