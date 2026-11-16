'use strict';
/**
 * p23-bridge.js — r155: мост P2/P3-инструментов к окну приложения.
 *
 *  • «Система координат» (tools/scan2bim-py/crs-tools.py, готовит phase1):
 *      info / reproject / georef / corners; graceful fallback, если CLI ещё нет.
 *  • «Mesh-инструменты» (tools/scan2bim-py/mesh-tools.py):
 *      fill-holes / laplacian / remove-class / remove-color / simplify;
 *      graceful fallback, если CLI ещё нет.
 *  • Сохранение фрагмента клип-бокса (P3) — без Python: PLY (бинаpный с RGB), PCD, XYZ.
 *
 * IPC: bim:p23Status, p23PickMesh, p23CrsRun, p23MeshRun, p23SaveFragment, p23Cancel.
 * Прогресс: bim:p23Progress {jobId, tool, phase, line, elapsedMs}.
 * Чистые builders экспортируются для тестов: buildCrsArgs, buildMeshArgs.
 */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const CRS_SCRIPT = 'crs-tools.py';
const MESH_SCRIPT = 'mesh-tools.py';
const CRS_OPS = { info: 1, reproject: 1, georef: 1, corners: 1 };
const MESH_OPS = { 'fill-holes': 1, laplacian: 1, 'remove-class': 1, 'remove-color': 1, simplify: 1 };
const MESH_EXT = new Set(['.ply', '.obj', '.stl']);
const CLOUD_EXT = new Set(['.las', '.laz', '.ply']);
const OUT_ROOT = 'p2p3-r155';
const FRAG_MAX_POINTS = 5_000_000;
const FRAG_MAX_BYTES = 300 * 1024 * 1024;

function scriptPath(rootDir, name) { return path.join(rootDir, 'tools', 'scan2bim-py', name); }
function fileExists(p) { try { return !!p && fs.statSync(p).isFile(); } catch (_) { return false; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function tail(s, n) { s = String(s || ''); return s.length > n ? s.slice(-n) : s; }
function baseName(p) { try { return path.basename(String(p || '')); } catch (_) { return ''; } }
function stamp() { const d = new Date(); const z = (v) => String(v).padStart(2, '0'); return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds()); }

/** Аргументы crs-tools.py (реальный CLI r155):
 *   info/corners: --in CLOUD --json OUT
 *   reproject:    --in CLOUD --to CRS --out-las OUT --json OUT [--epsg SRC]
 *   georef:       --in CLOUD --update-header --georef-file G --json OUT [--epsg SRC]
 *   local:        --to local --local-params E0,N0,theta,scale
 * variant сохранён для обратной совместимости тестов/старых сборок. */
function buildCrsArgs(op, o, variant) {
  o = o || {};
  op = CRS_OPS[op] ? op : 'info';
  const args = ['--in', String(o.cloud || '')];
  if (op === 'reproject') {
    const to = String(o.to || 'local').replace(/^EPSG\s*:\s*/i, '');
    args.push('--to', to);
    if (o.localParams) args.push('--local-params', String(o.localParams));
    if (o.out) args.push('--out-las', String(o.out));
  } else if (op === 'georef') {
    args.push('--update-header');
    if (o.out) args.push('--out-las', String(o.out));
    if (o.georefFile) args.push('--georef-file', String(o.georefFile));
  }
  if (o.from) args.push('--epsg', String(String(o.from).replace(/^EPSG:/i, '')));
  if (o.maxPoints) args.push('--max-points', String(o.maxPoints));
  if (o.json) args.push('--json', String(o.json));
  return args;
}

/** Аргументы mesh-tools.py (реальный CLI r155):
 *   --in X --out Y --fill-holes [--max-hole-edges N]
 *   --in X --out Y --smooth ITER --lambda L
 *   --in X --out Y --remove-triangles color:R,G,B[,tol] | class:R,G,B[,tol]
 *   --in X --out Y --decimate quadric:N_TRIANGLES | voxel:SIZE_M
 *   --json OUT */
function buildMeshArgs(op, o) {
  o = o || {};
  op = MESH_OPS[op] ? op : 'fill-holes';
  const args = ['--in', String(o.input || ''), '--out', String(o.output || '')];
  const P = o.params || {};
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const rgb = (s) => {
    // #RRGGBB или "R,G,B"
    if (typeof s !== 'string') return null;
    let m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s.trim());
    if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
    m = s.split(',').map((x) => Number(x.trim()));
    if (m.length === 3 && m.every((x) => Number.isFinite(x))) return m;
    return null;
  };
  if (op === 'fill-holes') {
    args.push('--fill-holes');
    const e = num(P.maxEdges); if (e && e > 0) args.push('--max-hole-edges', String(Math.round(e)));
  } else if (op === 'laplacian') {
    args.push('--smooth', String(Math.max(1, Math.round(num(P.iterations) || 5))));
    const l = num(P.lambda); args.push('--lambda', String(l != null ? Math.max(0.01, Math.min(1, l)) : 0.5));
  } else if (op === 'remove-color' || op === 'remove-class') {
    const c = rgb(P.color || P.classRGB || P.className);
    const tol = num(P.tolerance);
    if (c) args.push('--remove-triangles', (op === 'remove-class' ? 'class:' : 'color:') + c.join(',') + (tol != null ? ',' + Math.round(tol) : ''));
    else args.push('--remove-triangles', 'color:255,0,0');
  } else if (op === 'simplify') {
    const target = num(P.targetTriangles);
    const voxel = num(P.voxelSize);
    if (target && target > 0) args.push('--decimate', 'quadric:' + Math.round(target));
    else if (voxel && voxel > 0) args.push('--decimate', 'voxel:' + voxel);
    else args.push('--decimate', 'quadric:10000');
  }
  if (o.json) args.push('--json', String(o.json));
  return args;
}

function pythonCandidates() {
  const cands = [];
  const push = (p) => { if (p && !cands.includes(p)) cands.push(p); };
  if (process.env.PYTHON) push(process.env.PYTHON);
  if (process.platform === 'win32') {
    const la = process.env.LOCALAPPDATA;
    if (la) {
      try { const pf = path.join(la, 'BIMTwin', 'python-path.txt'); if (fs.existsSync(pf)) push(String(fs.readFileSync(pf, 'utf8')).trim()); } catch (_) { }
      push(path.join(la, 'BIMTwin', 'py312', 'python.exe'), path.join(la, 'BIMTwin', 'py', 'python.exe'));
      push(path.join(la, 'Programs', 'Python', 'Python311', 'python.exe'));
      push(path.join(la, 'Programs', 'Python', 'Python312', 'python.exe'));
      push(path.join(la, 'Programs', 'Python', 'Python313', 'python.exe'));
    }
  }
  push('python3'); push('python'); push('py');
  return cands;
}
function findPython() {
  for (const c of pythonCandidates()) {
    try {
      const r = cp.spawnSync(c, ['--version'], { windowsHide: true, timeout: 8000 });
      const txt = String((r && r.stdout) || '') + String((r && r.stderr) || '');
      if ((r && r.status === 0) || /Python\s+3/.test(txt)) return c;
    } catch (_) { }
  }
  return null;
}
/** Python с установленным Open3D (mesh-tools.py требует его); null, если нет. */
function findOpen3dPython() {
  for (const c of pythonCandidates()) {
    try {
      const r = cp.spawnSync(c, ['-c', 'import open3d'], { windowsHide: true, timeout: 20000, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }) });
      if (r && r.status === 0) return c;
    } catch (_) { }
  }
  return null;
}

/* ---------- writers для фрагмента клип-бокса ---------- */
function normalizeFragment(p) {
  const pos = p && p.pos;
  if (!pos) throw new Error('нет координат фрагмента');
  let P;
  if (ArrayBuffer.isView(pos)) P = new Float32Array(pos.buffer, pos.byteOffset, pos.byteLength / 4);
  else if (Array.isArray(pos)) P = Float32Array.from(pos);
  else if (pos.type === 'Buffer' && Array.isArray(pos.data)) P = new Float32Array(pos.data);
  else if (pos instanceof ArrayBuffer) P = new Float32Array(pos);
  else throw new Error('плохой формат pos');
  if (P.length % 3) throw new Error('pos не кратен 3');
  const n = P.length / 3;
  if (n <= 0) throw new Error('фрагмент пуст');
  if (n > FRAG_MAX_POINTS) throw new Error('фрагмент слишком большой: ' + n + ' точек');
  let C = null;
  if (p.col) {
    if (ArrayBuffer.isView(p.col)) C = new Uint8Array(p.col.buffer, p.col.byteOffset, p.col.byteLength);
    else if (Array.isArray(p.col)) C = Uint8Array.from(p.col);
    else if (p.col.type === 'Buffer' && Array.isArray(p.col.data)) C = new Uint8Array(p.col.data);
    else throw new Error('плохой формат col');
    if (C.length < n * 3) C = null;
  }
  return { P, C, n };
}
function writePly(file, P, C) {
  const n = P.length / 3;
  const header = 'ply\nformat binary_little_endian 1.0\nelement vertex ' + n + '\n' +
    'property float x\nproperty float y\nproperty float z\n' + (C ? 'property uchar red\nproperty uchar green\nproperty uchar blue\n' : '') +
    'end_header\n';
  const head = Buffer.from(header, 'utf8');
  const stride = 12 + (C ? 3 : 0);
  const out = Buffer.alloc(head.length + n * stride);
  head.copy(out, 0);
  let o = head.length;
  for (let i = 0; i < n; i++) {
    out.writeFloatLE(P[i * 3], o); out.writeFloatLE(P[i * 3 + 1], o + 4); out.writeFloatLE(P[i * 3 + 2], o + 8);
    o += 12;
    if (C) { out[o] = C[i * 3]; out[o + 1] = C[i * 3 + 1]; out[o + 2] = C[i * 3 + 2]; o += 3; }
  }
  fs.writeFileSync(file, out);
  return { bytes: out.length, points: n, format: 'ply' };
}
function writePcd(file, P, C) {
  const n = P.length / 3;
  const lines = ['# .PCD v0.7 - Point Cloud Data file format', 'VERSION 0.7', 'FIELDS x y z' + (C ? ' rgb' : ''),
    'SIZE 4 4 4' + (C ? ' 4' : ''), 'TYPE F F F' + (C ? ' U' : ''), 'COUNT 1 1 1' + (C ? ' 1' : ''),
    'WIDTH ' + n, 'HEIGHT 1', 'VIEWPOINT 0 0 0 1 0 0 0', 'POINTS ' + n, 'DATA ascii'];
  for (let i = 0; i < n; i++) {
    let s = P[i * 3].toFixed(4) + ' ' + P[i * 3 + 1].toFixed(4) + ' ' + P[i * 3 + 2].toFixed(4);
    if (C) { const rgb = (C[i * 3] << 16) | (C[i * 3 + 1] << 8) | C[i * 3 + 2]; s += ' ' + rgb; }
    lines.push(s);
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { bytes: fs.statSync(file).size, points: n, format: 'pcd' };
}
function writeXyz(file, P, C) {
  const n = P.length / 3;
  const lines = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = P[i * 3].toFixed(4) + ' ' + P[i * 3 + 1].toFixed(4) + ' ' + P[i * 3 + 2].toFixed(4);
    if (C) s += ' ' + C[i * 3] + ' ' + C[i * 3 + 1] + ' ' + C[i * 3 + 2];
    lines[i] = s;
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { bytes: fs.statSync(file).size, points: n, format: 'xyz' };
}

function register(deps) {
  deps = deps || {};
  const ipcMain = deps.ipcMain, app = deps.app, dialog = deps.dialog, rootDir = deps.rootDir || process.cwd();
  const fileGrants = deps.fileGrants, ipcSender = deps.ipcSender, resolveAuthorizedFile = deps.resolveAuthorizedFile, grantExistingOutput = deps.grantExistingOutput;
  if (!ipcMain || !app) throw new Error('p23-bridge: нужны ipcMain/app');
  const python = deps.python !== undefined ? deps.python : findPython();
  const jobs = new Map();
  const helpCache = {};
  let open3dResolved;
  /** Python, в котором доступен Open3D (для mesh-tools.py). null — нет.
   *  В юнит-тестах deps.python задан явно → реальные процессы не запускаем,
   *  если не передан deps.open3dPython. */
  function open3dPython() {
    if (Object.prototype.hasOwnProperty.call(deps, 'open3dPython')) return deps.open3dPython || null;
    if (deps.python !== undefined) return null;
    if (open3dResolved !== undefined) return open3dResolved;
    open3dResolved = findOpen3dPython();
    return open3dResolved;
  }
  function hasOpen3d() { return !!open3dPython(); }

  function outRoot() { const d = path.join(app.getPath('userData'), OUT_ROOT); try { fs.mkdirSync(d, { recursive: true }); } catch (_) { } return d; }
  function jobDir(tool) { const d = path.join(outRoot(), tool + '-' + stamp() + '-' + Math.random().toString(36).slice(2, 6)); fs.mkdirSync(d, { recursive: true }); return d; }
  function sender(event) { return typeof ipcSender === 'function' ? ipcSender(event) : (event && event.sender); }
  function authorize(event, p, exts) {
    const s = sender(event); if (!s) return null;
    if (typeof resolveAuthorizedFile === 'function') { try { return resolveAuthorizedFile(event, String(p || ''), exts || CLOUD_EXT); } catch (_) { return null; } }
    return fileExists(p) ? path.resolve(String(p)) : null;
  }
  function grant(event, p) { try { if (typeof grantExistingOutput === 'function') return !!grantExistingOutput(event, p); } catch (_) { } return false; }
  function grantRead(event, p) {
    const s = sender(event); if (!s || !fileGrants || !fileExists(p)) return false;
    try { fileGrants.grantExistingFile(s.id, p, { read: true, write: false }); return true; } catch (_) { return false; }
  }
  function emit(senderObj, payload) {
    try { if (senderObj && typeof senderObj.send === 'function' && !(senderObj.isDestroyed && senderObj.isDestroyed())) senderObj.send('bim:p23Progress', payload); } catch (_) { }
  }
  function helpFor(script) {
    if (Object.prototype.hasOwnProperty.call(helpCache, script)) return helpCache[script];
    if (!fileExists(script) || !python) { helpCache[script] = ''; return ''; }
    try {
      const r = cp.spawnSync(python, [script, '--help'], { windowsHide: true, timeout: 30000, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }) });
      helpCache[script] = (String((r && r.stdout) || '') + String((r && r.stderr) || '')).slice(0, 6000);
    } catch (_) { helpCache[script] = ''; }
    return helpCache[script];
  }
  function runTool(tool, script, args, opts) {
    opts = opts || {};
    const py = opts.python || python;
    return new Promise((resolve) => {
      const started = Date.now();
      if (!py) { resolve({ ok: false, error: 'Python 3 не найден — установите Python или включите изолированный движок в настройках.', code: -1 }); return; }
      if (!fileExists(script)) { resolve({ ok: false, missing: true, error: 'Инструмент ещё готовится: ' + baseName(script) + ' не найден в tools/scan2bim-py.', code: -1 }); return; }
      const jobId = String(opts.jobId || (tool + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)));
      const senderObj = opts.sender || null;
      let child = null;
      try { child = cp.spawn(py, [script].concat(args), { windowsHide: true, cwd: path.dirname(script), env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }) }); }
      catch (e) { resolve({ ok: false, error: 'Не удалось запустить Python: ' + (e && e.message || e), code: -1, jobId }); return; }
      let out = '', err = '', finished = false, killed = false;
      const lines = [];
      const record = (chunk, isErr) => {
        const txt = String(chunk);
        if (isErr) err += txt; else out += txt;
        for (const ln of txt.split(/\r?\n/).filter((s) => s.trim())) {
          if (lines.length < 120) lines.push(ln.slice(0, 400));
          emit(senderObj, { jobId, tool, phase: 'log', line: ln.slice(0, 400), elapsedMs: Date.now() - started });
        }
      };
      const timer = setTimeout(() => { killed = true; try { child.kill(); } catch (_) { } }, Math.max(60000, Math.min(60 * 60 * 1000, Number(opts.timeoutMs) || 30 * 60 * 1000)));
      jobs.set(jobId, { child, started, tool });
      emit(senderObj, { jobId, tool, phase: 'start', elapsedMs: 0 });
      if (child.stdout) child.stdout.on('data', (d) => record(d, false));
      if (child.stderr) child.stderr.on('data', (d) => record(d, true));
      child.on('error', (e) => { err += String(e && e.message || e); });
      child.on('close', (code) => {
        clearTimeout(timer); jobs.delete(jobId); finished = true;
        const elapsedMs = Date.now() - started;
        emit(senderObj, { jobId, tool, phase: code === 0 ? 'done' : 'error', elapsedMs, code });
        resolve({ ok: code === 0, code, jobId, tool, elapsedMs, killed, stdout: tail(out, 4000), stderr: tail(err, 4000), lines: lines.slice(-40) });
      });
      setTimeout(() => { if (!finished && !child) { try { child.kill(); } catch (_) { } } }, 5000);
    });
  }

  /* ---------- статус ---------- */
  ipcMain.handle('bim:p23Status', async () => {
    const crsScript = scriptPath(rootDir, CRS_SCRIPT), meshScript = scriptPath(rootDir, MESH_SCRIPT);
    const crsHelp = helpFor(crsScript), meshHelp = helpFor(meshScript);
    const has = (h, flag) => new RegExp('(^|[\\s,=])' + flag.replace(/[-]/g, '\\-') + '([\\s,=]|$)').test(h);
    return {
      ok: true, python: python || null, open3d: hasOpen3d(),
      tools: { crs: fileExists(crsScript), mesh: fileExists(meshScript) },
      scripts: { crs: crsScript, mesh: meshScript },
      crs: {
        ops: ['info', 'reproject', 'georef', 'corners'],
        help: crsHelp.slice(0, 2500) || null,
        flagsOk: fileExists(crsScript) ? {
          input: has(crsHelp, '--in'), json: has(crsHelp, '--json'),
          to: has(crsHelp, '--to'), outLas: has(crsHelp, '--out-las'),
          updateHeader: has(crsHelp, '--update-header'), georefFile: has(crsHelp, '--georef-file'),
          localParams: has(crsHelp, '--local-params')
        } : null
      },
      mesh: {
        ops: ['fill-holes', 'laplacian', 'remove-class', 'remove-color', 'simplify'],
        help: meshHelp.slice(0, 2500) || null,
        flagsOk: fileExists(meshScript) ? {
          input: has(meshHelp, '--in'), output: has(meshHelp, '--out'), json: has(meshHelp, '--json'),
          fillHoles: has(meshHelp, '--fill-holes'), smooth: has(meshHelp, '--smooth'),
          removeTriangles: has(meshHelp, '--remove-triangles'), decimate: has(meshHelp, '--decimate')
        } : null
      },
      root: outRoot()
    };
  });

  /* ---------- программный грант mesh-файлов (скрипты/автотесты) ---------- */
  ipcMain.handle('bim:p23GrantMesh', async (event, a) => {
    try {
      const list = Array.isArray(a && a.paths) ? a.paths : [];
      if (!list.length || list.length > 10) return { ok: false, error: 'paths: нужен массив 1..10 путей' };
      const granted = [];
      for (const raw of list) {
        const p = path.resolve(String(raw || ''));
        if (!fileExists(p)) return { ok: false, error: 'Файл не найден: ' + baseName(p) };
        if (!MESH_EXT.has(path.extname(p).toLowerCase())) return { ok: false, error: 'Не mesh-формат (PLY/OBJ/STL): ' + baseName(p) };
        if (!grantRead(event, p)) return { ok: false, error: 'Не удалось выдать грант: ' + baseName(p) };
        granted.push(p);
      }
      return { ok: true, paths: granted };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  /* ---------- выбор mesh-файла ---------- */
  ipcMain.handle('bim:p23PickMesh', async (event) => {    try {
      if (!dialog) return { ok: false, error: 'Нет доступа к диалогу' };
      const res = await dialog.showOpenDialog({ title: 'Выберите mesh (PLY/OBJ/STL)', properties: ['openFile'], filters: [{ name: 'Mesh', extensions: ['ply', 'obj', 'stl'] }, { name: 'Все файлы', extensions: ['*'] }] });
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
      const p = res.filePaths[0]; if (!fileExists(p)) return { ok: false, error: 'Файл не найден' };
      grantRead(event, p);
      return { ok: true, path: p, name: baseName(p), size: fs.statSync(p).size };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });

  /* ---------- CRS ---------- */
  function writeCornersCsv(result, file) {
    const lines = ['# crs-tools.py: координаты углов облака', 'corner,E,N,lon,lat'];
    const c = (result && result.corners_wgs84) || [];
    c.forEach((p, i) => lines.push([i + 1, p.E, p.N, p.lon, p.lat].join(',')));
    if (!c.length && result && result.bbox && result.bbox.length === 6) {
      lines.push('# bbox: ' + result.bbox.join(', '));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    return file;
  }
  ipcMain.handle('bim:p23CrsRun', async (event, a) => {
    a = a || {};
    const op = CRS_OPS[a.op] ? a.op : 'info';
    const script = scriptPath(rootDir, CRS_SCRIPT);
    if (!fileExists(script)) return { ok: false, missing: true, error: 'Инструмент «Система координат» ещё готовится: tools/scan2bim-py/crs-tools.py не найден. Пока панель показывает текущую СК/координаты углов, а пересчёт/запись привязки появятся после готовности CLI.' };
    const help = helpFor(script);
    if (help && !/--in\b/.test(help)) return { ok: false, cliMismatch: true, error: 'CLI crs-tools.py не совпал с ожидаемым (--in/--json/--to/--out-las/--update-header). Нужна согласованная версия.', help: help.slice(0, 2000) };
    const cloud = authorize(event, a.cloud, CLOUD_EXT);
    if (!cloud) return { ok: false, error: 'Не выбрано облако (LAS/PLY) — откройте облако точек, чтобы читать/пересчитывать его СК.' };
    if (op === 'reproject' && !a.to) return { ok: false, error: 'Не указана целевая система координат (EPSG:4326/32636/25836 или local).' };
    const dir = jobDir('crs');
    const outLas = (op === 'reproject' || op === 'georef') ? path.join(dir, op === 'reproject' ? 'reprojected.las' : 'georef-header.las') : null;
    const jsonPath = path.join(dir, 'crs-' + op + '.json');
    const georefFile = op === 'georef' ? path.join(dir, 'georef.json') : null;
    const args = buildCrsArgs(op, { cloud, from: a.from, to: a.to, out: outLas, json: jsonPath, georefFile, localParams: a.localParams, maxPoints: a.maxPoints });
    const run = await runTool('crs', script, args, { sender: sender(event), jobId: a.jobId, timeoutMs: a.timeoutMs });
    const result = readJson(jsonPath) || null;
    const files = {};
    let csv = null;
    if (op === 'corners' && result) {
      try { csv = writeCornersCsv(result, path.join(dir, 'corners.csv')); } catch (_) { csv = null; }
    }
    const outCandidates = [jsonPath, csv, outLas, georefFile].filter(Boolean);
    for (const f of outCandidates) { if (fileExists(f)) { grant(event, f); files[baseName(f)] = f; } }
    const toolOut = result && result.out_las ? (typeof result.out_las === 'string' ? result.out_las : (result.out_las.file || null)) : null;
    if (toolOut && fileExists(toolOut)) { grant(event, toolOut); files[baseName(toolOut)] = toolOut; }
    const toolGeoref = result && result.georef_file ? result.georef_file : null;
    if (toolGeoref && fileExists(toolGeoref)) { grant(event, toolGeoref); files[baseName(toolGeoref)] = toolGeoref; }
    if (!run.ok) {
      const toolErr = result && result.error ? String(result.error) : '';
      const errText = toolErr || tail(run.stderr || run.stdout, 700) || ('код ' + run.code);
      const needO3 = /open3d/i.test(errText);
      return { ok: false, error: errText, needOpen3D: needO3, cliMismatch: /unrecognized|invalid choice/i.test(run.stderr || ''), result, files, log: run.lines || [] };
    }
    const out = toolOut && fileExists(toolOut) ? toolOut : (outLas && fileExists(outLas) ? outLas : null);
    return {
      ok: true, op, result, files,
      out: out || null,
      georefFile: (toolGeoref && fileExists(toolGeoref)) ? toolGeoref : (georefFile && fileExists(georefFile) ? georefFile : null),
      source: result && result.source ? result.source : null,
      elapsedMs: run.elapsedMs, log: run.lines || []
    };
  });

  /* ---------- Mesh ---------- */
  ipcMain.handle('bim:p23MeshRun', async (event, a) => {
    a = a || {};
    const op = MESH_OPS[a.op] ? a.op : 'fill-holes';
    const script = scriptPath(rootDir, MESH_SCRIPT);
    if (!fileExists(script)) return { ok: false, missing: true, error: 'Mesh-инструменты ещё готовятся: tools/scan2bim-py/mesh-tools.py не найден. Панель показывает параметры и ждёт CLI; как только он появится — операции заработают.' };
    const help = helpFor(script);
    if (help && (!/--in\b/.test(help) || !/--out\b/.test(help))) return { ok: false, cliMismatch: true, error: 'CLI mesh-tools.py не совпал с ожидаемым (--in/--out/--fill-holes/--smooth/--remove-triangles/--decimate). Нужна согласованная версия CLI.', help: help.slice(0, 2000) };
    const meshPython = open3dPython();
    if (!meshPython) return { ok: false, needOpen3D: true, error: 'Mesh-инструменты требуют Open3D в Python-движке (чтение/запись mesh и операции над треугольниками). Установите изолированный Python-движок с Open3D (Настройки → Python/Open3D) — без него mesh-операции недоступны. Текущее облако/сцену это не затрагивает.' };
    const input = authorize(event, a.input, MESH_EXT);
    if (!input) return { ok: false, error: 'Не выбран mesh-файл (PLY/OBJ/STL).' };
    if (!a.output && !/\.(ply|obj|stl)$/i.test(input)) return { ok: false, error: 'Формат mesh не поддерживается для записи.' };
    const dir = jobDir('mesh');
    const ext = path.extname(input).toLowerCase() || '.ply';
    const output = a.output || path.join(dir, 'mesh-' + op + ext);
    const jsonPath = path.join(dir, 'mesh-' + op + '.json');
    const args = buildMeshArgs(op, { input, output, params: a.params || {}, json: jsonPath });
    const run = await runTool('mesh', script, args, { sender: sender(event), jobId: a.jobId, timeoutMs: a.timeoutMs, python: meshPython });
    const result = readJson(jsonPath) || null;
    const files = {};
    for (const f of [jsonPath, output]) { if (fileExists(f)) { grant(event, f); files[baseName(f)] = f; } }
    if (!run.ok) {
      const toolErr = result && result.error ? String(result.error) : '';
      const errText = toolErr || tail(run.stderr || run.stdout, 700) || ('код ' + run.code);
      return { ok: false, error: errText, needOpen3D: /open3d/i.test(errText), cliMismatch: /unrecognized|invalid choice/i.test(run.stderr || ''), result, files, log: run.lines || [] };
    }
    return { ok: true, op, result, output: fileExists(output) ? output : null, files, elapsedMs: run.elapsedMs, log: run.lines || [] };
  });

  /* ---------- фрагмент клип-бокса ---------- */
  ipcMain.handle('bim:p23SaveFragment', async (event, a) => {
    try {
      a = a || {};
      const s = sender(event); if (!s) return { ok: false, error: 'invalid_sender' };
      const fmt = /^(ply|pcd|xyz)$/i.test(String(a.format || '')) ? String(a.format).toLowerCase() : 'ply';
      const { P, C, n } = normalizeFragment(a);
      if (n * (12 + (C ? 3 : 0)) > FRAG_MAX_BYTES) return { ok: false, error: 'Фрагмент слишком большой для сохранения (' + n + ' точек)' };
      const dir = jobDir('clip');
      const file = path.join(dir, 'clip-fragment.' + fmt);
      let wr;
      if (fmt === 'ply') wr = writePly(file, P, C);
      else if (fmt === 'pcd') wr = writePcd(file, P, C);
      else wr = writeXyz(file, P, C);
      grant(event, file);
      return { ok: true, path: file, count: n, format: fmt, bytes: wr.bytes, bbox: a.bbox || null };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });

  /* ---------- отмена ---------- */
  ipcMain.handle('bim:p23Cancel', async (_event, a) => {
    const jobId = a && String(a.jobId || '');
    const job = jobId && jobs.get(jobId);
    if (!job) return { ok: false, error: 'Задача не найдена' };
    try { job.child.kill(); } catch (_) { }
    return { ok: true };
  });

  return { ok: true, python, _scripts: { CRS_SCRIPT, MESH_SCRIPT }, _builders: { buildCrsArgs, buildMeshArgs } };
}

module.exports = { register, buildCrsArgs, buildMeshArgs, CRS_SCRIPT, MESH_SCRIPT, CRS_OPS, MESH_OPS, findPython, findOpen3dPython, pythonCandidates };
