'use strict';
/**
 * p1-bridge.js — r151 мост между P1-инструментами Python и окном приложения.
 *
 * Инструменты (готовые, из tools/scan2bim-py):
 *   cloud-register.py  — совмещение облаков (ICP / пары / GCP);
 *   cloud-classify.py  — классификация облака (пол/стены/крыша/растительность/люди/мебель);
 *   quality-compare.py — метрики качества нашего облака против эталона;
 *   cloud-diff.py      — 3D-разница и RMSE плоскостей (наш новый, r151).
 *
 * Функции для тестов экспортируются отдельно: buildRegisterArgs/buildClassifyArgs/buildAccuracyArgs/buildDiffArgs.
 */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const toolStorage = require('./tool-storage');

const TOOLS = ['register', 'classify', 'quality', 'diff'];
const SCRIPTS = {
  register: 'cloud-register.py',
  classify: 'cloud-classify.py',
  quality: 'quality-compare.py',
  diff: 'cloud-diff.py'
};
const MODES = new Set(['icp', 'manual-points', 'gcp']);
const CLOUD_EXT = new Set(['.las', '.laz', '.ply']);
const LOG_LIMIT = 120;

function scriptPath(rootDir, tool) {
  const name = SCRIPTS[tool];
  if (!name) throw new Error('unknown_tool:' + tool);
  return path.join(rootDir, 'tools', 'scan2bim-py', name);
}

/** Аргументы cloud-register.py (без пути python). */
function buildRegisterArgs(o) {
  o = o || {};
  const mode = MODES.has(o.mode) ? o.mode : 'icp';
  const args = ['--ref', String(o.ref || ''), '--src'].concat((Array.isArray(o.src) ? o.src : [o.src]).filter(Boolean).map(String));
  args.push('--mode', mode);
  if (o.pairs) args.push('--pairs', String(o.pairs));
  if (o.autoInit) args.push('--auto-init');
  if (o.crop) args.push('--crop', String(o.crop));
  if (Number(o.maxIter) > 0) args.push('--max-iter', String(Math.round(Number(o.maxIter))));
  if (Number(o.maxPoints) > 0) args.push('--max-points', String(Math.round(Number(o.maxPoints))));
  if (o.out) args.push('--out', String(o.out));
  if (o.outLas) args.push('--out-las', String(o.outLas));
  if (o.strict) args.push('--strict');
  return args;
}

/** Аргументы cloud-classify.py. */
function buildClassifyArgs(o) {
  o = o || {};
  const args = [String(o.cloud || '')];
  if (o.outLas) args.push('--out-las', String(o.outLas));
  if (o.outBin) args.push('--out-bin', String(o.outBin));
  if (o.json) args.push('--json', String(o.json));
  if (o.preview) args.push('--preview', String(o.preview));
  if (o.refineDynamic) args.push('--refine-dynamic');
  if (Number(o.maxPoints) > 0) args.push('--max-points', String(Math.round(Number(o.maxPoints))));
  return args;
}

/** Аргументы quality-compare.py. */
function buildQualityArgs(o) {
  o = o || {};
  const args = ['--our', String(o.our || ''), '--ref', String(o.ref || '')];
  if (o.out) args.push('--out', String(o.out));
  if (o.heatmaps) args.push('--heatmaps', String(o.heatmaps));
  if (o.label) args.push('--label', String(o.label));
  if (Number(o.maxPoints) > 0) args.push('--max-points', String(Math.round(Number(o.maxPoints))));
  if (o.interior) args.push('--interior');
  return args;
}

/** Аргументы cloud-diff.py — 3D-разница/RMSE плоскостей. */
function buildDiffArgs(o) {
  o = o || {};
  const args = ['--our', String(o.our || ''), '--ref', String(o.ref || '')];
  if (o.out) args.push('--out', String(o.out));
  if (o.heatmap) args.push('--heatmap', String(o.heatmap));
  if (Number(o.maxPoints) > 0) args.push('--max-points', String(Math.round(Number(o.maxPoints))));
  return args;
}

function findPython() {
  const cands = [];
  if (process.env.PYTHON) cands.push(process.env.PYTHON);
  if (process.platform === 'win32') {
    const la = process.env.LOCALAPPDATA;
    if (la) {
      try { const pf = path.join(la, 'BIMTwin', 'python-path.txt'); if (fs.existsSync(pf)) cands.push(String(fs.readFileSync(pf, 'utf8')).trim()); } catch (_) {}
      cands.push(path.join(la, 'BIMTwin', 'py312', 'python.exe'), path.join(la, 'BIMTwin', 'py', 'python.exe'));
    }
  }
  cands.push('python3', 'python', 'py');
  for (const c of cands) {
    if (!c) continue;
    try {
      const r = cp.spawnSync(c, ['--version'], { windowsHide: true, timeout: 8000 });
      const txt = String((r && r.stdout) || '') + String((r && r.stderr) || '');
      if ((r && r.status === 0) || /Python\s+3/.test(txt)) return c;
    } catch (_) {}
  }
  return null;
}

function fileExists(p) { try { return !!p && fs.statSync(p).isFile(); } catch (_) { return false; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function tailText(s, n) { s = String(s || ''); return s.length > n ? s.slice(-n) : s; }
function stamp() { const d = new Date(); const z = (v) => String(v).padStart(2, '0'); return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds()); }
function baseName(p) { try { return path.basename(String(p || '')); } catch (_) { return ''; } }

function register(deps) {
  deps = deps || {};
  const ipcMain = deps.ipcMain, app = deps.app, dialog = deps.dialog, rootDir = deps.rootDir || process.cwd();
  const fileGrants = deps.fileGrants, ipcSender = deps.ipcSender, resolveAuthorizedFile = deps.resolveAuthorizedFile, grantExistingOutput = deps.grantExistingOutput;
  if (!ipcMain || !app || !dialog) throw new Error('p1-bridge: нужны ipcMain/app/dialog');
  const python = (deps.python !== undefined ? deps.python : findPython());
  const jobs = new Map();
  let pythonChecked = false, open3dCache = null;

  // r184: результаты инструментов — ТОЛЬКО в папку проекта (<Project>/output/<tool>-<stamp>,
  // временные — <Project>/temp с очисткой). В userData/AppData инструменты больше не пишут.
  // deps: projectFolder()/chooseProjectFolder(event)/userData (передаёт main.js).
  function storageDeps() { return deps; }
  async function prepareJob(event, tool) {
    try { return { job: await toolStorage.beginJob(storageDeps(), event, tool) }; }
    catch (e) { return { error: toolStorage.storageError(e) }; }
  }
  function storageDescribe() { try { return toolStorage.describe(storageDeps()); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } }
  function sender(event) { return typeof ipcSender === 'function' ? ipcSender(event) : (event && event.sender); }
  function authorize(event, p, exts) {
    const s = sender(event);
    if (!s) return null;
    if (typeof resolveAuthorizedFile === 'function') {
      try { return resolveAuthorizedFile(event, String(p || ''), exts || CLOUD_EXT); } catch (_) { return null; }
    }
    return fileExists(p) ? path.resolve(String(p)) : null;
  }
  function grant(event, p) { try { if (typeof grantExistingOutput === 'function') return !!grantExistingOutput(event, p); } catch (_) {} return false; }
  function grantRead(event, p) {
    const s = sender(event);
    if (!s || !fileGrants || !fileExists(p)) return false;
    try { fileGrants.grantExistingFile(s.id, p, { read: true, write: false }); return true; } catch (_) { return false; }
  }
  function emit(senderObj, payload) {
    try { if (senderObj && typeof senderObj.send === 'function' && !(senderObj.isDestroyed && senderObj.isDestroyed())) senderObj.send('bim:p1Progress', payload); } catch (_) {}
  }
  function hasOpen3d() {
    if (open3dCache !== null) return open3dCache;
    if (!python) return (open3dCache = false);
    try {
      const r = cp.spawnSync(python, ['-c', 'import open3d'], { windowsHide: true, timeout: 20000 });
      open3dCache = !!(r && r.status === 0);
    } catch (_) { open3dCache = false; }
    return open3dCache;
  }
  function runTool(tool, args, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const started = Date.now();
      const script = scriptPath(rootDir, tool);
      if (!fileExists(script)) { resolve({ ok: false, error: 'Скрипт инструмента не найден: ' + baseName(script), code: -1 }); return; }
      if (!python) { resolve({ ok: false, error: 'Python 3 не найден. Установите Python или включите изолированный движок в настройках.', code: -1 }); return; }
      const jobId = String(opts.jobId || (tool + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)));
      const senderObj = opts.sender || null;
      let child = null;
      try { child = cp.spawn(python, [script].concat(args), { windowsHide: true, cwd: path.dirname(script), env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }) }); }
      catch (e) { resolve({ ok: false, error: 'Не удалось запустить Python: ' + (e && e.message || e), code: -1, jobId }); return; }
      const lines = [];
      let err = '', out = '', killed = false, finished = false;
      const record = (chunk, isErr) => {
        const txt = String(chunk);
        if (isErr) err += txt; else out += txt;
        const parts = txt.split(/\r?\n/).filter((s) => s.trim());
        for (const ln of parts) {
          if (lines.length < LOG_LIMIT) lines.push(ln.slice(0, 400));
          emit(senderObj, { jobId, tool, phase: 'log', line: ln.slice(0, 400), elapsedMs: Date.now() - started });
        }
      };
      const timer = setTimeout(() => { killed = true; try { child.kill(); } catch (_) {} }, Math.max(60000, Math.min(60 * 60 * 1000, Number(opts.timeoutMs) || 30 * 60 * 1000)));
      jobs.set(jobId, { child, started, tool });
      emit(senderObj, { jobId, tool, phase: 'start', elapsedMs: 0 });
      child.stdout.on('data', (d) => record(d, false));
      child.stderr.on('data', (d) => record(d, true));
      child.on('error', (e) => { err += String(e && e.message || e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        jobs.delete(jobId);
        finished = true;
        const elapsedMs = Date.now() - started;
        const payload = { ok: code === 0 || (code === 1 && !!opts.allowCode1), code, jobId, tool, elapsedMs, killed, stdout: tailText(out, 4000), stderr: tailText(err, 4000), lines: lines.slice(-40) };
        emit(senderObj, { jobId, tool, phase: code === 0 ? 'done' : 'error', elapsedMs, code });
        resolve(payload);
      });
      setTimeout(() => { if (!finished && !child) { try { child.kill(); } catch (_) {} } }, 5000);
    });
  }

  function cloudPicked(event, p) { return authorize(event, p, CLOUD_EXT); }

  // ---- статус инструментов ----
  ipcMain.handle('bim:p1Status', async (event) => {
    if (!pythonChecked) pythonChecked = true;
    const tools = {};
    for (const t of TOOLS) tools[t] = fileExists(scriptPath(rootDir, t));
    const storage = storageDescribe();
    return {
      ok: true, python: python || null, open3d: hasOpen3d(), tools,
      root: storage && storage.outputRoot ? storage.outputRoot : null,
      storage,
      register: { modes: ['icp', 'manual-points', 'gcp'], strict: { icp: 0.05, 'manual-points': 0.15, gcp: 0.15 } },
      classify: { classes: ['ground_floor', 'wall', 'roof', 'vegetation', 'people', 'clutter', 'other'], asprs: { ground_floor: 2, wall: 6, roof: 6, vegetation: 5, people: 18, clutter: 7, other: 1 } }
    };
  });

  // ---- r184: пути результатов и старые папки в AppData ----
  ipcMain.handle('bim:p1Storage', async (event, a) => {
    try {
      a = a && typeof a === 'object' ? a : {};
      const action = typeof a.action === 'string' ? a.action : 'info';
      if (action === 'info') return Object.assign({ ok: true }, storageDescribe());
      if (action === 'choose') {
        if (typeof deps.chooseProjectFolder !== 'function') return { ok: false, error: 'Выбор папки проекта доступен в настольной версии' };
        const r = await deps.chooseProjectFolder(event);
        if (!r || r.canceled) return { ok: false, canceled: true };
        return Object.assign({ ok: true }, storageDescribe());
      }
      if (action === 'cleanLegacy') {
        const res = toolStorage.cleanLegacy(deps.userData, { confirm: a.confirm === true, names: a.names });
        return Object.assign({ ok: !!res.ok, storage: storageDescribe() }, res);
      }
      // тестовый хук (только при BIM_TWIN_E2E=1): привязать папку проекта программно,
      // чтобы E2E мог проверить сохранение без нативного диалога. В обычном запуске запрещён.
      if (action === 'assignProjectDir') {
        if (process.env.BIM_TWIN_E2E !== '1') return { ok: false, error: 'действие доступно только в тестовом режиме' };
        if (typeof deps.setProjectDirForTests !== 'function') return { ok: false, error: 'тестовый хук недоступен' };
        const p = a.path;
        if (typeof p !== 'string' || !path.isAbsolute(p)) return { ok: false, error: 'нужен абсолютный путь папки проекта' };
        const r = deps.setProjectDirForTests(p);
        if (!r || r.ok === false) return { ok: false, error: (r && r.error) || 'не удалось привязать папку' };
        return Object.assign({ ok: true }, storageDescribe());
      }
      if (action === 'snapshot') {
        // снимок userData (для E2E): какие файлы есть в старых папках инструментов
        return { ok: true, legacy: toolStorage.legacyInfo(deps.userData), userData: deps.userData || null };
      }
      return { ok: false, error: 'неизвестное действие' };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // ---- выбор файлов ----
  ipcMain.handle('bim:p1PickClouds', async (event, a) => {
    try {
      const multi = !!(a && a.multi);
      const res = await dialog.showOpenDialog({
        title: 'Выберите облако точек (LAS/PLY)',
        properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: [{ name: 'Облака точек', extensions: ['las', 'laz', 'ply'] }, { name: 'Все файлы', extensions: ['*'] }]
      });
      if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };
      const paths = [];
      for (const p of res.filePaths) { if (!fileExists(p)) continue; grantRead(event, p); paths.push(p); }
      return { ok: paths.length > 0, paths, files: paths.map((p) => ({ path: p, name: baseName(p), size: (() => { try { return fs.statSync(p).size; } catch (_) { return 0; } })() })) };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
  ipcMain.handle('bim:p1PickPairs', async (event) => {
    try {
      const res = await dialog.showOpenDialog({ title: 'Файл пар точек (JSON/CSV: src → ref)', properties: ['openFile'], filters: [{ name: 'Пары точек', extensions: ['json', 'csv'] }, { name: 'Все файлы', extensions: ['*'] }] });
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
      const p = res.filePaths[0]; grantRead(event, p);
      return { ok: true, path: p, name: baseName(p) };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
  // Разрешение на чтение уже известных файлов (сценарии/автотесты, файлы проекта из CLI):
  // только существующие LAS/LAZ/PLY/JSON/CSV, не больше 10 за вызов.
  ipcMain.handle('bim:p1GrantPaths', async (event, a) => {
    try {
      const s = sender(event);
      if (!s || !fileGrants) return { ok: false, error: 'invalid_sender' };
      const list = (a && Array.isArray(a.paths) ? a.paths : []).slice(0, 10);
      const granted = [];
      for (const p of list) {
        if (typeof p !== 'string' || !p) continue;
        let abs = null;
        try { abs = fs.realpathSync(path.resolve(p)); } catch (_) { continue; }
        if (!fileExists(abs)) continue;
        if (!CLOUD_EXT.has(path.extname(abs).toLowerCase()) && !/\.(json|csv)$/i.test(abs)) continue;
        try { fileGrants.grantExistingFile(s.id, abs, { read: true, write: false }); granted.push(abs); } catch (_) {}
      }
      return { ok: granted.length > 0, paths: granted };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });

  // ---- совмещение облаков ----
  ipcMain.handle('bim:p1Register', async (event, a) => {
    a = a || {};
    const ref = cloudPicked(event, a.ref);
    if (!ref) return { ok: false, error: 'Не выбран эталон (ref) — нажмите «Эталон…» и выберите LAS/PLY.' };
    const srcs = (Array.isArray(a.src) ? a.src : [a.src]).filter(Boolean).map((p) => cloudPicked(event, p)).filter(Boolean);
    if (!srcs.length) return { ok: false, error: 'Не выбрано исходное облако (src) — нажмите «Исходное…».' };
    const mode = MODES.has(a.mode) ? a.mode : 'icp';
    let pairs = null;
    if (mode !== 'icp') {
      const pairsRes = a.pairs ? authorize(event, a.pairs, new Set(['.json', '.csv'])) : null;
      if (!pairsRes) return { ok: false, error: 'Для режима «Пары точек»/«GCP» выберите файл пар (JSON/CSV: src → ref).' };
      pairs = pairsRes;
    }
    if (mode === 'icp' && !hasOpen3d()) {
      return { ok: false, needOpen3D: true, error: 'ICP требует Open3D в Python-движке. Установите движок (Настройки → Python/Open3D) или используйте режимы «Пары точек» / «GCP» — они работают без Open3D.' };
    }
    const prep = await prepareJob(event, 'register');
    if (prep.error) return prep.error;
    const job = prep.job;
    const dir = job.outDir;
    try {
    const outLas = path.join(dir, 'src-registered.las');
    const reportPath = path.join(dir, 'register.json');
    const args = buildRegisterArgs({ ref, src: srcs, mode, pairs, autoInit: a.autoInit !== false, strict: a.strict !== false, maxIter: a.maxIter, maxPoints: a.maxPoints, crop: a.crop, out: reportPath, outLas });
    const s = sender(event);
    const run = await runTool('register', args, { sender: s, jobId: a.jobId, timeoutMs: a.timeoutMs });
    const report = readJson(reportPath);
    grant(event, outLas); grant(event, reportPath);
    if (!report) {
      const low = ((run.stderr || '') + (run.stdout || '')).toLowerCase();
      if (/open3d/.test(low)) return { ok: false, needOpen3D: /icp/.test(low), error: 'Инструменту нужен Open3D: ' + tailText(run.stderr, 300) };
      return { ok: false, error: 'Совмещение не выполнено: ' + (tailText(run.stderr, 400) || tailText(run.stdout, 400) || ('код ' + run.code)), code: run.code, outLas: fileExists(outLas) ? outLas : null };
    }
    const results = (report.results || []).map((r) => ({
      src: r.src, strictPass: !!r.strict_pass, strictThreshold: r.strict_threshold_m,
      yawDeg: r.transform && r.transform.yaw_deg, translation: r.transform && r.transform.translation, scale: r.transform && r.transform.scale,
      rms: r.rms || (r.pairs_fit ? { rms_m: r.pairs_fit.rms_m, max_m: r.pairs_fit.max_m, n_pairs: r.pairs_fit.n_pairs } : null),
      pairsFit: r.pairs_fit || null, iterations: r.iterations, seconds: r.seconds, matrix: r.matrix
    }));
    const outOk = results.every((r) => r.strictPass !== false);
    const summary = {
      ok: !!report.ok && outOk, mode: report.mode, strict: !!report.strict, elapsed_s: report.elapsed_s,
      ref: report.ref && { file: report.ref.file, sampled: report.ref.sampled },
      results, outLas: (report.out_las && report.out_las[0] && report.out_las[0].file) || (fileExists(outLas) ? outLas : null),
      reportPath, json: report, files: { report: reportPath, outLas: fileExists(outLas) ? outLas : null },
      log: run.lines || []
    };
    if (!outOk) {
      const bad = results.filter((r) => !r.strictPass)[0] || {};
      const chk = (bad.rms && (bad.rms.rms_inlier_m != null ? bad.rms.rms_inlier_m : bad.rms.rms_m)) || (bad.pairsFit && bad.pairsFit.rms_m);
      summary.strictFail = true;
      summary.error = 'Строгий порог не пройден: RMS ' + (chk != null ? (Math.round(chk * 1000) / 1000) + ' м' : '—') + ' > ' + bad.strictThreshold + ' м. Облако не совмещено с нужной точностью — проверьте пары/начальную ориентацию или уменьшите шум.';
    }
    return summary;
    } finally { try { job.finalize(); } catch (_) {} }
  });

  // ---- классификация ----
  ipcMain.handle('bim:p1Classify', async (event, a) => {
    a = a || {};
    const cloud = authorize(event, a.cloud, CLOUD_EXT);
    if (!cloud) return { ok: false, error: 'Сначала откройте облако точек (LAS/PLY), чтобы классифицировать его.' };
    const isLas = /\.las$/i.test(cloud);
    const prep = await prepareJob(event, 'classify');
    if (prep.error) return prep.error;
    const job = prep.job;
    const dir = job.outDir;
    try {
    const jsonPath = path.join(dir, 'classify.json');
    const previewPath = path.join(dir, 'classify-preview.png');
    const outLas = isLas && a.outLas !== false ? path.join(dir, 'classified.las') : null;
    const outBin = !isLas ? path.join(dir, 'classified.bin') : null;
    const args = buildClassifyArgs({ cloud, outLas, outBin, json: jsonPath, preview: previewPath, refineDynamic: !!a.refineDynamic, maxPoints: a.maxPoints });
    const s = sender(event);
    const run = await runTool('classify', args, { sender: s, jobId: a.jobId, timeoutMs: a.timeoutMs });
    grant(event, jsonPath); grant(event, previewPath);
    if (outLas) grant(event, outLas); if (outBin) grant(event, outBin);
    const stats = readJson(jsonPath);
    if (!stats) return { ok: false, error: 'Классификация не выполнена: ' + (tailText(run.stderr, 400) || tailText(run.stdout, 400) || ('код ' + run.code)), code: run.code };
    let previewDataUrl = null;
    try {
      if (fileExists(previewPath) && fs.statSync(previewPath).size <= 4 * 1024 * 1024) previewDataUrl = 'data:image/png;base64,' + fs.readFileSync(previewPath).toString('base64');
    } catch (_) {}
    return { ok: true, stats, jsonPath, previewPath, previewDataUrl, outLas: outLas && fileExists(outLas) ? outLas : null, outBin: outBin && fileExists(outBin) ? outBin : null, inputIsLas: isLas, elapsedMs: run.elapsedMs, log: run.lines || [] };
    } finally { try { job.finalize(); } catch (_) {} }
  });

  // ---- P2: отчёт о точности (quality-compare + cloud-diff) ----
  ipcMain.handle('bim:p1Accuracy', async (event, a) => {
    a = a || {};
    const our = authorize(event, a.our, CLOUD_EXT);
    const ref = authorize(event, a.ref, CLOUD_EXT);
    if (!our) return { ok: false, error: 'Не облако для сравнения — откройте облако или выберите файл.' };
    if (!ref) return { ok: false, error: 'Не выбран эталон — нажмите «Эталон…» и выберите LAS/PLY.' };
    const prep = await prepareJob(event, 'accuracy');
    if (prep.error) return prep.error;
    const job = prep.job;
    const dir = job.outDir;
    try {
    const qJson = path.join(dir, 'quality.json');
    const diffJson = path.join(dir, 'diff.json');
    const heatDir = path.join(dir, 'heatmaps');
    const heatmap = path.join(dir, 'diff-heatmap.png');
    const s = sender(event);
    const qRun = await runTool('quality', buildQualityArgs({ our, ref, out: qJson, heatmaps: heatDir, label: a.label || 'BIM Twin vs эталон', maxPoints: a.maxPoints, interior: !!a.interior }), { sender: s, jobId: a.jobId && a.jobId + '-q', timeoutMs: a.timeoutMs });
    const dRun = await runTool('diff', buildDiffArgs({ our, ref, out: diffJson, heatmap, maxPoints: a.maxPoints || 200000 }), { sender: s, jobId: a.jobId && a.jobId + '-d', timeoutMs: a.timeoutMs });
    const quality = readJson(qJson), diff = readJson(diffJson);
    grant(event, qJson); grant(event, diffJson); grant(event, heatmap);
    const images = [];
    for (const f of [heatmap]) if (fileExists(f)) images.push(f);
    try {
      for (const f of (quality && quality.heatmaps) || []) if (fileExists(f)) images.push(f);
    } catch (_) {}
    const seen = new Set(); const uniq = [];
    for (const f of images) { const k = path.resolve(f); if (seen.has(k)) continue; seen.add(k); uniq.push(f); grant(event, f); }
    const dataUrls = [];
    for (const f of uniq.slice(0, 8)) {
      try { if (fs.statSync(f).size <= 5 * 1024 * 1024) dataUrls.push({ path: f, name: baseName(f), dataUrl: 'data:image/png;base64,' + fs.readFileSync(f).toString('base64') }); } catch (_) {}
    }
    if (!quality && !diff) return { ok: false, error: 'Сравнение не выполнено: ' + (tailText(qRun.stderr || dRun.stderr, 500) || 'нет JSON-результата') };
    return {
      ok: true, our, ref, quality, diff,
      qualityError: quality ? null : tailText(qRun.stderr || qRun.stdout, 500),
      diffError: diff ? null : tailText(dRun.stderr || dRun.stdout, 500),
      files: { qualityJson: qJson, diffJson, heatmaps: uniq },
      heatmaps: dataUrls, elapsedMs: (qRun.elapsedMs || 0) + (dRun.elapsedMs || 0),
      logs: { quality: qRun.lines || [], diff: dRun.lines || [] }
    };
    } finally { try { job.finalize(); } catch (_) {} }
  });

  // ---- экспорт результата (без диалога, в папку проекта) ----
  ipcMain.handle('bim:p1Export', async (event, a) => {
    try {
      a = a || {};
      const src = authorize(event, a.sourcePath, CLOUD_EXT);
      if (!src) return { ok: false, error: 'Нет файла для экспорта.' };
      const prep = await prepareJob(event, 'export');
      if (prep.error) return prep.error;
      const job = prep.job;
      try {
      const dir = job.outDir;
      const ext = path.extname(src).toLowerCase();
      const target = path.join(dir, (a.name ? String(a.name).replace(/[^\w.\-]+/g, '_') : baseName(src).replace(/\.[^.]+$/, '')) + ext);
      fs.copyFileSync(src, target);
      grant(event, target);
      return { ok: true, path: target, bytes: fs.statSync(target).size, source: src };
      } finally { try { job.finalize(); } catch (_) {} }
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });

  // ---- отмена ----
  ipcMain.handle('bim:p1Cancel', async (_event, a) => {
    const jobId = a && String(a.jobId || '');
    const job = jobId && jobs.get(jobId);
    if (!job) return { ok: false, error: 'Задача не найдена' };
    try { job.child.kill(); } catch (_) {}
    return { ok: true };
  });

  return { ok: true, python, open3d: hasOpen3d, _scripts: SCRIPTS, _builders: { buildRegisterArgs, buildClassifyArgs, buildQualityArgs, buildDiffArgs } };
}

module.exports = { register, buildRegisterArgs, buildClassifyArgs, buildQualityArgs, buildDiffArgs, SCRIPTS, TOOLS, scriptPath };
