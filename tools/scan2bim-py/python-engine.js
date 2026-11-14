#!/usr/bin/env node
'use strict';
/*
 * python-engine.js — единая CLI-обёртка Python-движка Scan2BIM для приложения (Фаза 3 ROADMAP-IDEAL).
 *
 * Приложение запускает движок ОДНОЙ командой:
 *
 *   node tools/scan2bim-py/python-engine.js --cloud <облако> --out <каталог> [опции]
 *
 * Шаги:
 *   1) облако: .bin уже в формате движка (float32 XYZRGB, 24 байта/точка) — как есть;
 *      .las/.laz/.ply/.e57/.pcd/.ptx/.xyz — импорт через las-node.js (бюджет --max-points)
 *      и выгрузка во временный raw-float32 (кешируется как <name>.cloud.bin);
 *   2) python scan2bim-v2.py <cloud.bin> <name>.json [voxel=N]  → JSON модели;
 *      (если передан готовый --model model.json, шаг 2 пропускается — кеш приложения);
 *   3) экспорт IFC через renderer/scan2bim.js: toIFC(model, meta) + (опционально) toOBJ/toDXF;
 *      meta.sourceTransform/crsWkt → IfcMapConversion + IfcProjectedCRS (геопривязка);
 *   4) PNG-рендер рядом: python render-textured3.py <name>.json <cloud.bin> <name>.png
 *      (камера по умолчанию подбирается из bbox модели: --view=iso|plan|inside).
 *
 * Вывод: человекочитаемый прогресс — в stderr; последняя строка stdout — JSON-результат
 * для приложения: { ok, outputs:{json,ifc,png,...}, stats, timings, python, ... }.
 * Код возврата: 0 — успех, 1 — ошибка одного из шагов, 2 — ошибка аргументов.
 *
 * Примеры:
 *   node tools/scan2bim-py/python-engine.js --cloud D:\BIM-TWIN-TEST\interior\koridor-local-rgb.bin \
 *        --out D:\BIM-TWIN-TEST\interior\engine-out --python <python.exe> --view=iso
 *   node tools/scan2bim-py/python-engine.js --cloud scan.las --out out --max-points=3000000 \
 *        --crs-wkt="PROJCRS[...]" --formats=ifc,png,obj,dxf --validate
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const TOOLS_DIR = __dirname;
const ROOT = path.resolve(TOOLS_DIR, '..', '..');
const PY_ENGINE = path.join(TOOLS_DIR, 'scan2bim-v2.py');
const PY_RENDER = path.join(TOOLS_DIR, 'render-textured3.py');
const PY_VALIDATE = path.join(TOOLS_DIR, 'validate-ifc.py');
const Scan2BIM = require(path.join(ROOT, 'renderer', 'scan2bim.js'));

const DEFAULTS = {
  view: 'iso',
  size: '1600x1000',
  fov: '50',
  voxel: null,           // null — не переопределять воксель движка (в scan2bim-v2.py по умолчанию 0.03)
  maxPoints: 0,          // 0 — бюджет las-node по умолчанию
  timeoutMs: 30 * 60 * 1000,
  renderTimeoutMs: 15 * 60 * 1000,
  engineTimeoutMs: 30 * 60 * 1000
};

let QUIET = false;
function log(msg) { if (!QUIET) process.stderr.write('[engine] ' + msg + '\n'); }
function warn(msg) { process.stderr.write('[engine] ВНИМАНИЕ: ' + msg + '\n'); }

// ------------------------------------------------------------------ аргументы
function camel(key) {
  return key.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
}

function parseArgs(argv) {
  const opts = { formats: null, renderArgs: [], kv: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help' || a === 'help') { opts.help = true; continue; }
    if (a.slice(0, 2) !== '--') { opts.kv[a] = true; continue; }  // позиционные: bin/model — ниже
    const eq = a.indexOf('=');
    let key, val;
    if (eq >= 0) { key = a.slice(2, eq); val = a.slice(eq + 1); }
    else {
      key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && next.slice(0, 2) !== '--') { val = next; i++; } else { val = true; }
    }
    const k = camel(key);
    if (k === 'renderArg' || k === 'renderArgs') { opts.renderArgs.push(String(val)); continue; }
    opts[k] = val;
  }
  // позиционные аргументы для совместимости: python-engine.js <cloud> <out>
  const positional = argv.filter(function (a) { return a.slice(0, 2) !== '--'; });
  if (!opts.cloud && positional[0]) opts.cloud = positional[0];
  if (!opts.out && positional[1]) opts.out = positional[1];
  return opts;
}

function usage() {
  const t = [
    'python-engine.js — Python-движок Scan2BIM: облако → JSON → IFC → PNG одной командой',
    '',
    'usage: node tools/scan2bim-py/python-engine.js --cloud <файл> --out <каталог> [опции]',
    '',
    'Облако/модель:',
    '  --cloud=<путь>        .bin (float32 XYZRGB, 24 Б/точка) или .las/.laz/.ply/.e57/.pcd/.ptx/.xyz',
    '  --model=<json>        готовый JSON движка — пропустить шаг scan2bim-v2.py (кеш приложения)',
    '  --out=<каталог>       каталог результатов (по умолчанию <каталог облака>/<имя>_scan2bim)',
    '  --name=<база>         базовое имя файлов (по умолчанию имя облака без расширения)',
    '  --voxel=<м>           прореживание движка (по умолчанию его 0.03 м)',
    '  --max-points=<n>      бюджет точек при импорте LAS/PLY (0 — по умолчанию las-node)',
    '  --python=<путь>       интерпретатор Python (иначе BIMTWIN_PYTHON/PYTHON/автопоиск)',
    '  --timeout=<мс>        общий таймаут одного шага (по умолчанию 1800000)',
    '',
    'Экспорт:',
    '  --formats=ifc,png     что выгружать: ifc, png, obj, dxf (по умолчанию ifc,png)',
    '  --ifc=<путь> --png=<путь> --json=<путь>   явные пути результатов',
    '  --validate            прогнать tools/scan2bim-py/validate-ifc.py по готовому IFC',
    '',
    'Геопривязка (meta для toIFC):',
    '  --meta=<файл|json>    {sourceTransform:{axis,t}, crsWkt, project, includeRooms, includePipes, includeBeams}',
    '  --crs-wkt=<wkt>       WKT CRS → IfcProjectedCRS + IfcMapConversion',
    '  --source-t=<x,y,z>    смещение исходного кадра (для IFC X/Y/Z)',
    '  --source-axis=<ось>   zup | yup (по умолчанию zup)',
    '  --project=<имя>       имя IfcProject',
    '',
    'Рендер PNG (render-textured3.py):',
    '  --view=iso|plan|inside|none  камера (по умолчанию iso; none — без PNG)',
    '  --eye=<x,y,z> --target=<x,y,z> --fov=<°> --size=<WxH> --proj=persp|ortho --up=y|z',
    '  --render-arg=k=v      дополнительный параметр render-textured3.py (можно повторять)',
    '',
    'Прочее:',
    '  --quiet               без прогресса в stderr',
    '  --help                эта справка',
    ''
  ];
  process.stderr.write(t.join('\n'));
}

// ------------------------------------------------------------------ утилиты
function isTrue(v) { return v === true || v === '1' || v === 'true' || v === 'yes'; }
function num(v, dflt) { const n = Number(v); return isFinite(n) ? n : dflt; }
function parseTriple(v) {
  if (Array.isArray(v) && v.length >= 3) return v.slice(0, 3).map(Number);
  const parts = String(v || '').split(',').map(function (s) { return parseFloat(s); });
  if (parts.length < 3 || !parts.slice(0, 3).every(isFinite)) {
    throw new Error('ожидались три числа через запятую, получено: ' + v);
  }
  return parts.slice(0, 3);
}
function esc(s) { return String(s).replace(/'/g, "''"); }

function safeName(s) {
  return String(s || 'model').replace(/[^\w.\-а-яА-ЯёЁ]+/g, '_').replace(/^_+|_+$/g, '') || 'model';
}

/** Разбор meta: путь к JSON-файлу, inline JSON или {meta:{...}}-обёртка. */
function readMeta(spec) {
  if (spec === true || spec === undefined || spec === null) return {};
  const s = String(spec).trim();
  let obj;
  if (s.charAt(0) === '{') obj = JSON.parse(s);
  else {
    const p = path.resolve(s);
    if (!fs.existsSync(p)) throw new Error('--meta: файл не найден: ' + p);
    obj = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  }
  if (obj && obj.meta && typeof obj.meta === 'object') obj = obj.meta;
  const meta = {};
  for (const key of ['sourceTransform', 'crsWkt', 'project', 'includeRooms', 'includePipes', 'includeBeams',
    'crsName', 'name']) {
    if (obj && obj[key] !== undefined && obj[key] !== null) meta[key] = obj[key];
  }
  if (meta.sourceTransform && typeof meta.sourceTransform === 'string') {
    meta.sourceTransform = JSON.parse(meta.sourceTransform);
  }
  return meta;
}

// ------------------------------------------------------------------ Python
let _pythonCache;
function resolvePython(explicit) {
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  if (_pythonCache !== undefined) return _pythonCache;
  const cands = [];
  if (process.env.BIMTWIN_PYTHON) cands.push(process.env.BIMTWIN_PYTHON);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const la = process.env.LOCALAPPDATA;
    try {
      const pf = path.join(la, 'BIMTwin', 'python-path.txt');
      if (fs.existsSync(pf)) {
        const t = fs.readFileSync(pf, 'utf8').trim();
        if (t) cands.push(t);
      }
    } catch (_) { /* нет файла — не проблема */ }
    cands.push(path.join(la, 'BIMTwin', 'py312', 'python.exe'));
    cands.push(path.join(la, 'BIMTwin', 'py', 'python.exe'));
  }
  if (process.env.PYTHON) cands.push(process.env.PYTHON);
  cands.push('python3', 'python', 'py');
  for (const c of cands) {
    try {
      const r = spawnSync(c, ['--version'], { windowsHide: true, timeout: 15000 });
      const txt = String((r && r.stdout) || '') + String((r && r.stderr) || '');
      if ((r && r.status === 0) || /Python\s+3/.test(txt)) { _pythonCache = c; return c; }
    } catch (_) { /* следующий кандидат */ }
  }
  _pythonCache = null;
  return null;
}

/** Запуск процесса с таймаутом и построчным форвардом вывода в stderr. */
function run(cmd, args, opts) {
  opts = opts || {};
  const timeoutMs = num(opts.timeoutMs, DEFAULTS.timeoutMs);
  const prefix = opts.prefix || '';
  return new Promise(function (resolve) {
    const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, env: env, cwd: opts.cwd || ROOT });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: '', error: 'spawn: ' + String((e && e.message) || e), timedOut: false });
      return;
    }
    let out = '', errBuf = '';
    let outTail = '', errTail = '';
    let timedOut = false;
    const timer = setTimeout(function () {
      timedOut = true;
      try { child.kill(); } catch (_) { /* уже мёртв */ }
    }, timeoutMs);
    function forward(chunk, tailName) {
      const text = chunk.toString('utf8');
      if (tailName === 'out') out += text; else errBuf += text;
      const parts = (tailName === 'out' ? outTail : errTail) + text;
      const lines = parts.split(/\r?\n/);
      const rest = lines.pop();
      if (tailName === 'out') outTail = rest; else errTail = rest;
      for (const line of lines) {
        if (line.trim() === '') continue;
        process.stderr.write(prefix + line + '\n');
      }
    }
    child.stdout.on('data', function (d) { forward(d, 'out'); });
    child.stderr.on('data', function (d) { forward(d, 'err'); });
    child.on('error', function (e) {
      clearTimeout(timer);
      resolve({ code: -1, stdout: out, stderr: errBuf, error: 'spawn: ' + String((e && e.message) || e), timedOut: false });
    });
    child.on('close', function (code) {
      clearTimeout(timer);
      if (outTail.trim()) process.stderr.write(prefix + outTail + '\n');
      if (errTail.trim()) process.stderr.write(prefix + errTail + '\n');
      resolve({ code: code === null ? -1 : code, stdout: out, stderr: errBuf, timedOut: timedOut });
    });
  });
}

// ------------------------------------------------------------------ облако
/**
 * Приводит облако к формату движка: raw float32 XYZRGB, 24 байта на точку.
 * .bin отдаётся как есть; остальные форматы читает las-node.js (точки уже в
 * локальном Y-up кадре — именно его ждут scan2bim-v2.py и render-textured3.py),
 * геопривязка сохраняется в meta (srcXform из las-node: axis='zup', t=[...]).
 */
async function prepareCloud(cloudPath, outDir, name, opts) {
  const ext = path.extname(cloudPath).slice(1).toLowerCase();
  if (ext === 'bin') return { bin: cloudPath, converted: false, meta: null, points: null };
  if (['las', 'laz', 'ply', 'e57', 'pcd', 'ptx', 'xyz', 'pts', 'txt', 'csv', 'xyzrgb'].indexOf(ext) < 0) {
    throw new Error('неизвестный формат облака .' + ext + ' (поддержано: bin, las, laz, ply, e57, pcd, ptx, xyz)');
  }
  const lasNode = require(path.join(ROOT, 'las-node.js'));
  log('импорт .' + ext + ' через las-node.js → raw float32 XYZRGB' +
    (num(opts.maxPoints, 0) > 0 ? ' (бюджет ' + num(opts.maxPoints, 0) + ' точек)' : ''));
  const t0 = Date.now();
  let res;
  if (ext === 'laz' && typeof lasNode.parseCloudFileAsync === 'function') {
    res = await lasNode.parseCloudFileAsync(cloudPath, { maxPoints: num(opts.maxPoints, 0) || undefined });
  } else {
    res = lasNode.parseCloudFile(cloudPath, { maxPoints: num(opts.maxPoints, 0) || undefined });
  }
  if (!res || !res.ok) throw new Error('импорт облака не удался: ' + ((res && res.message) || 'нет результата'));
  if (res.kind !== 'points' || !res.pos) throw new Error('облако не является набором точек (kind=' + res.kind + ')');
  const n = Number(res.count) || Math.floor(res.pos.length / 3);
  const pos = res.pos;
  const col = res.col;
  const data = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const j = i * 6, k = i * 3;
    data[j] = pos[k];
    data[j + 1] = pos[k + 1];
    data[j + 2] = pos[k + 2];
    if (col) {
      data[j + 3] = col[k];
      data[j + 4] = col[k + 1];
      data[j + 5] = col[k + 2];
    } else {
      data[j + 3] = 0.5; data[j + 4] = 0.5; data[j + 5] = 0.5;
    }
  }
  const binPath = path.join(outDir, name + '.cloud.bin');
  fs.writeFileSync(binPath, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  const meta = {};
  const m = res.meta || {};
  if (m.srcXform && m.srcXform.t && m.srcXform.t.length >= 3) meta.sourceTransform = m.srcXform;
  if (m.crsWkt) meta.crsWkt = m.crsWkt;
  log('импорт: ' + n + ' точек за ' + (Date.now() - t0) + ' мс → ' + binPath);
  return { bin: binPath, converted: true, meta: meta, points: n };
}

// ------------------------------------------------------------------ мета IFC
function buildIfcMeta(opts, autoMeta, name) {
  const meta = readMeta(opts.meta);
  const auto = autoMeta || {};
  if (auto.sourceTransform && meta.sourceTransform === undefined) meta.sourceTransform = auto.sourceTransform;
  if (auto.crsWkt && meta.crsWkt === undefined) meta.crsWkt = auto.crsWkt;
  if (opts.crsWkt && opts.crsWkt !== true) meta.crsWkt = String(opts.crsWkt);
  if (opts.sourceT && opts.sourceT !== true) {
    const prev = meta.sourceTransform && meta.sourceTransform.axis;
    meta.sourceTransform = { axis: String(opts.sourceAxis || prev || 'zup'), t: parseTriple(opts.sourceT) };
  }
  if (opts.project && opts.project !== true) meta.project = String(opts.project);
  meta.name = name + '.ifc';
  return meta;
}

// ------------------------------------------------------------------ камера
function modelBounds(model) {
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity, miny = Infinity, maxy = -Infinity;
  function upd(x, y, z) {
    // typeof-проверка обязательна: isFinite(null) === true (Number(null) === 0),
    // из-за чего помещения без высоты обнуляли минимум и ломали авто-камеру.
    if (typeof x === 'number' && isFinite(x)) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); }
    if (typeof y === 'number' && isFinite(y)) { miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
    if (typeof z === 'number' && isFinite(z)) { minz = Math.min(minz, z); maxz = Math.max(maxz, z); }
  }
  (model.walls || []).forEach(function (w) { if (w.a) upd(w.a[0], w.base, w.a[1]); if (w.b) upd(w.b[0], w.base, w.b[1]); });
  (model.slabs || []).forEach(function (s) { (s.polygon || []).forEach(function (p) { upd(p[0], s.level, p[1]); }); });
  (model.rooms || []).forEach(function (r) { (r.polygon || []).forEach(function (p) { upd(p[0], null, p[1]); }); });
  const st = model.storey || {};
  let floorY = num(st.floorY, isFinite(miny) ? miny : 0);
  let ceilY = num(st.ceilY, floorY + num(st.height, 3));
  if (isFinite(miny)) floorY = Math.min(floorY, miny - 0.2);
  if (isFinite(maxy)) ceilY = Math.max(ceilY, maxy + 0.2);
  if (!isFinite(minx)) { minx = -2; maxx = 2; minz = -2; maxz = 2; }
  const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2, cy = (floorY + ceilY) / 2;
  const span = Math.max(maxx - minx, maxz - minz, ceilY - floorY, 2);
  return { minx, maxx, minz, maxz, miny: floorY, maxy: ceilY, cx, cy, cz, floorY, ceilY, span };
}

/** Аргументы render-textured3.py: явные --eye/--target/... перекрывают авто-камеру. */
function renderCameraArgs(model, opts) {
  const view = String(opts.view || DEFAULTS.view).toLowerCase();
  const b = modelBounds(model);
  let eye = null, target = null, up = null, proj = null;
  if (opts.eye && opts.eye !== true) eye = parseTriple(opts.eye);
  if (opts.target && opts.target !== true) target = parseTriple(opts.target);
  if (opts.up && opts.up !== true) up = String(opts.up);
  if (opts.proj && opts.proj !== true) proj = String(opts.proj);
  if (!eye || !target) {
    if (view === 'inside') {
      throw new Error('--view=inside требует явных --eye=x,y,z и --target=x,y,z (камера внутри сцены)');
    }
    if (view === 'plan') {
      eye = [b.cx, b.ceilY + b.span * 1.6, b.cz];
      target = [b.cx, b.floorY, b.cz];
      up = up || 'z';
      proj = proj || 'ortho';
    } else {
      // изометрия: направление как у принятого пресета (eye=16,13,17 → 0,1.4,0),
      // дистанция — от габарита модели (1,5 × макс. пролёт).
      const len = Math.hypot(1, 0.75, 1);
      const dist = b.span * 1.5;
      eye = [b.cx + (1 / len) * dist, b.cy + (0.75 / len) * dist, b.cz + (1 / len) * dist];
      target = [b.cx, b.cy, b.cz];
    }
  }
  const args = [
    'eye=' + eye.map(function (v) { return Math.round(v * 1000) / 1000; }).join(','),
    'target=' + target.map(function (v) { return Math.round(v * 1000) / 1000; }).join(','),
    'fov=' + (opts.fov !== undefined && opts.fov !== true ? String(opts.fov) : DEFAULTS.fov),
    'size=' + (opts.size !== undefined && opts.size !== true ? String(opts.size) : DEFAULTS.size)
  ];
  if (up) args.push('up=' + up);
  if (proj) args.push('proj=' + proj);
  return args;
}

// ------------------------------------------------------------------ main
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  QUIET = isTrue(opts.quiet);
  if (opts.help) { usage(); return { ok: true, help: true }; }

  const tAll = Date.now();
  if (!opts.cloud && !opts.model) {
    usage();
    const e = new Error('нужен --cloud=<файл> (или --model=<json>)');
    e.usage = true;
    throw e;
  }

  let cloudPath = opts.cloud ? path.resolve(String(opts.cloud)) : null;
  if (cloudPath && !fs.existsSync(cloudPath)) throw new Error('облако не найдено: ' + cloudPath);
  const modelIn = opts.model ? path.resolve(String(opts.model)) : null;
  if (modelIn && !fs.existsSync(modelIn)) throw new Error('--model не найден: ' + modelIn);

  let name = opts.name && opts.name !== true
    ? safeName(opts.name)
    : safeName(cloudPath ? path.basename(cloudPath, path.extname(cloudPath)) : path.basename(modelIn, '.json'));
  const outDir = path.resolve(String(opts.out && opts.out !== true ? opts.out : (path.dirname(cloudPath || modelIn))));
  fs.mkdirSync(outDir, { recursive: true });
  log('name=' + name + '  out=' + outDir);

  const formats = String(opts.formats && opts.formats !== true ? opts.formats : 'ifc,png')
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  const wantPng = formats.indexOf('png') >= 0 && String(opts.view || DEFAULTS.view).toLowerCase() !== 'none';
  const wantIfc = formats.indexOf('ifc') >= 0;
  const wantObj = formats.indexOf('obj') >= 0;
  const wantDxf = formats.indexOf('dxf') >= 0;

  const outputs = { folder: outDir };
  outputs.json = opts.json && opts.json !== true ? path.resolve(String(opts.json)) : path.join(outDir, name + '.json');
  if (wantIfc) outputs.ifc = opts.ifc && opts.ifc !== true ? path.resolve(String(opts.ifc)) : path.join(outDir, name + '.ifc');
  if (wantObj) outputs.obj = path.join(outDir, name + '.obj');
  if (wantDxf) outputs.dxf = path.join(outDir, name + '.dxf');
  if (wantPng) outputs.png = opts.png && opts.png !== true ? path.resolve(String(opts.png)) : path.join(outDir, name + '.png');
  outputs.report = path.join(outDir, name + '.report.json');

  let python = null;
  // Python нужен для движка; для рендера — тоже (render-textured3.py). В режиме --model
  // (кеш приложения) достаточно только рендера и только если передано облако.
  const needPyEngine = !modelIn;
  const needPyRender = wantPng && !!cloudPath;
  if (needPyEngine || needPyRender) {
    python = resolvePython(opts.python);
    if (!python) throw new Error('Python 3 не найден. Укажите --python=<python.exe> или задайте BIMTWIN_PYTHON/PYTHON.');
    if (needPyEngine && !fs.existsSync(PY_ENGINE)) throw new Error('не найден движок: ' + PY_ENGINE);
  }

  const timings = {};
  let autoMeta = null;
  let prepared = null;
  let model;

  if (modelIn) {
    log('шаг 1/3: готовый JSON (кеш приложения) — Python-движок не требуется');
    model = JSON.parse(fs.readFileSync(modelIn, 'utf8').replace(/^\uFEFF/, ''));
    outputs.json = modelIn;
    if (needPyRender) {
      log('шаг 1/3: облако для PNG-рендера (модель из кеша)');
      const t0 = Date.now();
      prepared = await prepareCloud(cloudPath, outDir, name, opts);
      timings.prepareMs = Date.now() - t0;
    }
  } else {
    log('шаг 1/3: подготовка облака');
    let t = Date.now();
    prepared = await prepareCloud(cloudPath, outDir, name, opts);
    timings.prepareMs = Date.now() - t;
    autoMeta = prepared.meta;

    log('шаг 2/3: python scan2bim-v2.py');
    t = Date.now();
    const engineArgs = [PY_ENGINE, prepared.bin, outputs.json];
    if (opts.voxel && opts.voxel !== true) engineArgs.push('voxel=' + String(opts.voxel));
    const r = await run(python, engineArgs, {
      prefix: '  [py] ', timeoutMs: num(opts.timeout, DEFAULTS.engineTimeoutMs), cwd: TOOLS_DIR
    });
    timings.engineMs = Date.now() - t;
    if (r.code !== 0) {
      throw new Error('scan2bim-v2.py завершился с кодом ' + r.code +
        (r.timedOut ? ' (таймаут)' : '') + '\n' + String(r.stderr || r.stdout).slice(-1500));
    }
    if (!fs.existsSync(outputs.json)) throw new Error('движок не создал JSON: ' + outputs.json);
    model = JSON.parse(fs.readFileSync(outputs.json, 'utf8').replace(/^\uFEFF/, ''));
  }

  if (!model || !model.ok) throw new Error('модель движка не готова: ' + ((model && model.error) || 'ok=false'));
  log('модель: стен ' + ((model.walls || []).length) +
    ', помещений ' + ((model.rooms || []).length) +
    ', проёмов ' + ((model.walls || []).reduce(function (a, w) { return a + ((w.openings || []).length); }, 0)));

  log('шаг 3/3: экспорт IFC через renderer/scan2bim.js toIFC');
  const ifcMeta = buildIfcMeta(opts, autoMeta, name);
  let t = Date.now();
  if (wantIfc) {
    const ifc = Scan2BIM.toIFC(model, ifcMeta);
    fs.writeFileSync(outputs.ifc, ifc, 'utf8');
    log('IFC: ' + ifc.length + ' байт → ' + outputs.ifc +
      (ifcMeta.crsWkt ? ' (геопривязка: ' + (ifcMeta.crsName || 'CRS из meta') + ')' : ''));
  }
  if (wantObj) {
    fs.writeFileSync(outputs.obj, Scan2BIM.toOBJ(model), 'utf8');
    log('OBJ → ' + outputs.obj);
  }
  if (wantDxf) {
    fs.writeFileSync(outputs.dxf, Scan2BIM.toDXF(model), 'utf8');
    log('DXF → ' + outputs.dxf);
  }
  timings.exportMs = Date.now() - t;

  let validation = null;
  if (isTrue(opts.validate)) {
    if (!python) python = resolvePython(opts.python);
    if (!python) warn('--validate: Python не найден, проверка IFC пропущена');
    else if (!wantIfc) warn('--validate: формат ifc не запрошен, проверять нечего');
    else {
      t = Date.now();
      const vr = await run(python, [PY_VALIDATE, outputs.ifc], { prefix: '  [validate] ', timeoutMs: 5 * 60 * 1000, cwd: TOOLS_DIR });
      timings.validateMs = Date.now() - t;
      const lastLine = String(vr.stdout || '').trim().split('\n').pop() || '';
      validation = { ok: vr.code === 0, exitCode: vr.code, summary: lastLine };
      log('валидация IFC: ' + (vr.code === 0 ? 'OK' : 'ПРОБЛЕМЫ') + ' — ' + lastLine);
    }
  }

  if (wantPng) {
    if (!prepared || !prepared.bin) {
      warn('PNG пропущен: для рендера нужно исходное облако (--cloud)');
      delete outputs.png;
    } else {
      const camArgs = renderCameraArgs(model, opts);
      const extra = Array.isArray(opts.renderArgs) ? opts.renderArgs.filter(Boolean) : [];
      log('рендер PNG: render-textured3.py ' + camArgs.join(' '));
      t = Date.now();
      const rr = await run(python, [PY_RENDER, outputs.json, prepared.bin, outputs.png].concat(camArgs, extra),
        { prefix: '  [render] ', timeoutMs: num(opts.renderTimeout, DEFAULTS.renderTimeoutMs), cwd: TOOLS_DIR });
      timings.renderMs = Date.now() - t;
      if (rr.code !== 0 || !fs.existsSync(outputs.png)) {
        warn('рендер PNG не удался (код ' + rr.code + '): ' + String(rr.stderr || '').slice(-600));
        delete outputs.png;
      } else {
        log('PNG → ' + outputs.png + ' (' + fs.statSync(outputs.png).size + ' байт)');
      }
    }
  }

  const result = {
    ok: true,
    name: name,
    cloud: cloudPath,
    model: outputs.json,
    outputs: outputs,
    python: python,
    georef: {
      sourceTransform: ifcMeta.sourceTransform || null,
      crsWkt: ifcMeta.crsWkt ? String(ifcMeta.crsWkt).slice(0, 200) : null
    },
    stats: model.stats || {},
    timings: Object.assign({ totalMs: Date.now() - tAll }, timings),
    points: prepared && prepared.points,
    validation: validation
  };
  try {
    fs.writeFileSync(outputs.report,
      JSON.stringify(Object.assign({}, result, { generatedAt: new Date().toISOString() }), null, 1), 'utf8');
  } catch (e) {
    warn('не удалось записать report: ' + e.message);
  }
  log('готово за ' + (result.timings.totalMs / 1000).toFixed(1) + ' с: ' +
    Object.keys(outputs).filter(function (k) { return k !== 'folder'; })
      .map(function (k) { return k; }).join(', '));
  return result;
}

main().then(function (res) {
  if (res && res.help) return;
  process.stdout.write(JSON.stringify(res) + '\n');
  process.exit(0);
}, function (err) {
  const msg = String((err && err.message) || err);
  process.stderr.write('[engine] ОШИБКА: ' + msg + '\n');
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  process.exit(err && err.usage ? 2 : 1);
});
