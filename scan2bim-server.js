/*
 * scan2bim-server.js — v1170 (главный процесс Electron)
 * Режим 1:1 работает ОФЛАЙН (CPU, встроенный движок) — ему сервер/GPU НЕ нужен.
 * АВТОЗАПУСК БЕЗ автоустановки: ничего не скачивается при каждом запуске.
 * Тяжёлый GPU/AI-стек (torch/spconv/Pointcept) ставится ТОЛЬКО по явному install() — один раз,
 * и нужен только для опциональной нейросетевой разметки (не для 1:1).
 * Открыли приложение → сервер сам поднимается на http://127.0.0.1:8765.
 *
 * НИЧЕГО НЕ НАДО ДЕЛАТЬ РУКАМИ:
 *   • нет окружения → один раз тихо собирает venv + базовые зависимости;
 *   • есть NVIDIA (nvidia-smi) → автоматически ставит GPU-стек (torch cu121,
 *     torch-scatter, spconv, Pointcept/PointTransformerV3) и скачивает веса;
 *   • пока GPU-стек ставится — работает встроенный геометрический движок (офлайн);
 *   • как только GPU готов — сервер перезапускается и работает через видеокарту;
 *   • любая ошибка не роняет приложение.
 *
 * Прогресс виден через status().phase и в логе scan2bim-server.log.
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let child = null;
let upgradeTimer = null;
const PORT = 8765;
let state = { running: false, starting: false, bootstrapping: false, phase: 'idle', gpu: null, port: PORT, python: null, dir: null, venv: false, error: null };

function logFile() {
  try { const { app } = require('electron'); return path.join(app.getPath('userData'), 'scan2bim-server.log'); }
  catch (e) { try { return path.join(require('os').tmpdir(), 'scan2bim-server.log'); } catch (e2) { return 'scan2bim-server.log'; } }
}
function log(line) { try { fs.appendFileSync(logFile(), '[' + new Date().toISOString() + '] ' + line + '\n'); } catch (e) {} }
function outFd() { let out = 'ignore'; try { out = fs.openSync(logFile(), 'a'); } catch (e) { out = 'ignore'; } return out; }

function serverDir() {
  const cands = [];
  try {
    if (process.resourcesPath) {
      cands.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'scan2bim-ai-server'));
      cands.push(path.join(process.resourcesPath, 'scan2bim-ai-server'));
    }
  } catch (e) {}
  cands.push(path.join(__dirname, 'scan2bim-ai-server'));
  for (const d of cands) { try { if (fs.existsSync(path.join(d, 'server.py'))) return d; } catch (e) {} }
  return null;
}

function venvPython(dir) {
  const win = process.platform === 'win32';
  const p = win ? path.join(dir, '.venv', 'Scripts', 'python.exe') : path.join(dir, '.venv', 'bin', 'python');
  try { return fs.existsSync(p) ? p : null; } catch (e) { return null; }
}
function hasDeps(py, dir) {
  try { const r = spawnSync(py, ['-c', 'import uvicorn, fastapi, numpy'], { cwd: dir, windowsHide: true }); return !!(r && r.status === 0); }
  catch (e) { return false; }
}
function hasGpu() {
  if (state.gpu !== null) return state.gpu;
  try { const r = spawnSync('nvidia-smi', [], { windowsHide: true }); state.gpu = !!(r && r.status === 0); }
  catch (e) { state.gpu = false; }
  return state.gpu;
}
function baseCandidates() { return process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python']; }
function firstRunnable(cands) {
  for (const c of cands) { try { const r = spawnSync(c, ['--version'], { windowsHide: true }); if (r && !r.error) return c; } catch (e) {} }
  return null;
}
// PyTorch (cu121) существует только для Python 3.10–3.12. Для 3.13/3.14 колёс нет.
function pyIsCompat(cmd, args) {
  try {
    const r = spawnSync(cmd, (args || []).concat(['-c', 'import sys;print("%d.%d"%sys.version_info[:2])']), { windowsHide: true, encoding: 'utf8' });
    if (!r || r.status !== 0) return false;
    const m = /(\d+)\.(\d+)/.exec(String(r.stdout || '').trim());
    if (!m) return false;
    const mj = +m[1], mn = +m[2];
    return mj === 3 && mn >= 10 && mn <= 12;
  } catch (e) { return false; }
}
// Ищем совместимый интерпретатор 3.10–3.12 (на Windows — через py-лаунчер).
function compatibleBase() {
  const cands = process.platform === 'win32'
    ? [['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3.10']], ['python', []], ['python3', []]]
    : [['python3.12', []], ['python3.11', []], ['python3.10', []], ['python3', []], ['python', []]];
  for (const pair of cands) { if (pyIsCompat(pair[0], pair[1])) return { cmd: pair[0], args: pair[1] }; }
  return null;
}
function venvIsCompat(dir) { const vp = venvPython(dir); return !!(vp && pyIsCompat(vp, [])); }
function pickPython(dir) {
  const vp = venvPython(dir);
  if (vp && venvIsCompat(dir) && hasDeps(vp, dir)) return { py: vp, venv: true };
  for (const c of baseCandidates()) { if (pyIsCompat(c, []) && hasDeps(c, dir)) return { py: c, venv: false }; }
  return null;
}

// v1189: LITE-server (Python stdlib http.server + numpy) - podnimaetsya BEZ fastapi/uvicorn.
// Imenno otsutstvie fastapi/uvicorn ostavlyalo port 8765 pustym (ERR_CONNECTION_REFUSED).
// numpy pochti vsegda uzhe est (ego tyanet torch), poetomu LITE zapuskaetsya nadyozhno.
function hasNumpy(py, dir) {
  try { const r = spawnSync(py, ['-c', 'import numpy'], { cwd: dir, windowsHide: true }); return !!(r && r.status === 0); }
  catch (e) { return false; }
}
function hasLiteServer(dir) { try { return fs.existsSync(path.join(dir, 'server_lite.py')); } catch (e) { return false; } }
function pickPythonLite(dir) {
  const vp = venvPython(dir);
  if (vp && hasNumpy(vp, dir)) return { py: vp, venv: true };
  for (const c of baseCandidates()) {
    try { const r = spawnSync(c, ['--version'], { windowsHide: true }); if (r && !r.error && hasNumpy(c, dir)) return { py: c, venv: false }; } catch (e) {}
  }
  return null;
}
function launchLite(py, dir, venv) {
  const out = outFd();
  const args = ['server_lite.py'];
  try {
    child = spawn(py, args, { cwd: dir, windowsHide: true, env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1' }), stdio: ['ignore', out, out] });
  } catch (e) {
    state.starting = false; state.running = false; state.error = 'spawn_failed_lite:' + (e && e.message || e); child = null;
    log('lite spawn failed: ' + state.error); return state;
  }
  state.python = py; state.venv = !!venv; state.starting = false; state.running = true; state.error = null; state.phase = 'running_lite';
  log('started LITE (stdlib+numpy): ' + py + ' ' + args.join(' ') + ' (cwd=' + dir + ')');
  child.on('exit', function (code, sig) { state.running = false; child = null; state.phase = 'stopped'; log('lite server exited code=' + code + ' sig=' + sig); });
  child.on('error', function (e) { state.running = false; state.error = 'proc_error_lite:' + (e && e.message || e); child = null; log('lite server error: ' + state.error); });
  return state;
}

function launch(py, dir, venv) {
  const out = outFd();
  // Слушаем 127.0.0.1 (IPv4) — совпадает с нормализацией клиента (обход ::1).
  const args = ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', String(PORT)];
  try {
    child = spawn(py, args, { cwd: dir, windowsHide: true, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: ['ignore', out, out] });
  } catch (e) {
    state.starting = false; state.running = false; state.error = 'spawn_failed:' + (e && e.message || e); child = null;
    log('spawn failed: ' + state.error); return state;
  }
  state.python = py; state.venv = !!venv; state.starting = false; state.running = true; state.error = null; state.phase = 'running';
  log('started: ' + py + ' ' + args.join(' ') + ' (cwd=' + dir + ')');
  child.on('exit', function (code, sig) { state.running = false; child = null; state.phase = 'stopped'; log('server exited code=' + code + ' sig=' + sig); });
  child.on('error', function (e) { state.running = false; state.error = 'proc_error:' + (e && e.message || e); child = null; log('server error: ' + state.error); });
  return state;
}

// Последовательный pip install (толерантен к частичным ошибкам).
function pipInstall(py, dir, args, out, cb) {
  let p;
  try { p = spawn(py, ['-m', 'pip', 'install'].concat(args), { cwd: dir, windowsHide: true, stdio: ['ignore', out, out] }); }
  catch (e) { log('pip spawn failed: ' + (e && e.message || e)); cb(false); return; }
  p.on('error', function (e) { log('pip error: ' + (e && e.message || e)); cb(false); });
  p.on('exit', function (code) { cb(code === 0); });
}

// Версия установленного torch (без +cuXXX суффикса), нужна для torch-scatter.
function torchVersion(py, dir) {
  try { const r = spawnSync(py, ['-c', 'import torch;print(torch.__version__.split("+")[0])'], { cwd: dir, windowsHide: true, encoding: 'utf8' }); if (r && r.status === 0) return String(r.stdout || '').trim() || null; } catch (e) {}
  return null;
}
// Реально ли доступен CUDA (не просто установлен torch).
function cudaReady(py, dir) {
  try { const r = spawnSync(py, ['-c', 'import torch,sys;sys.exit(0 if torch.cuda.is_available() else 1)'], { cwd: dir, windowsHide: true }); return !!(r && r.status === 0); } catch (e) { return false; }
}
// Автоустановка полного GPU-стека (один раз). Толерантная: отдельный
// неудачный шаг не прерывает цепочку — в худшем случае останемся на geom.
// cu128 — поддержка новых GPU (RTX 50xx / Blackwell sm_120). cu121 их не знает.
function runGpuStack(py, dir, out, done) {
  const gmarker = path.join(dir, '.gpusetup.done');
  // Маркер есть, но CUDA не работает — переустанавливаем (авто-лечение).
  try {
    if (fs.existsSync(gmarker)) {
      if (cudaReady(py, dir)) { log('gpu: already installed & CUDA ok'); done(); return; }
      log('gpu: marker есть, но CUDA не готов — переустановка'); fs.rmSync(gmarker, { force: true });
    }
  } catch (e) {}
  state.phase = 'gpu_torch'; log('gpu: installing torch cu128 (может занять несколько минут)');
  pipInstall(py, dir, ['--upgrade', 'torch', 'torchvision', '--index-url', 'https://download.pytorch.org/whl/cu128'], out, function () {
    const tv = torchVersion(py, dir);
    state.phase = 'gpu_ops'; log('gpu: installing torch-scatter / spconv / timm (torch=' + (tv || '?') + ')');
    const scatterArgs = tv ? ['torch-scatter', '-f', 'https://data.pyg.org/whl/torch-' + tv + '+cu128.html'] : ['torch-scatter'];
    pipInstall(py, dir, scatterArgs, out, function () {
      pipInstall(py, dir, ['spconv-cu126', 'addict', 'timm', 'h5py', 'ifcopenshell'], out, function () {
        state.phase = 'gpu_pointcept'; log('gpu: installing Pointcept (zip, без git)');
        // Из zip — не требует установленного git.
        pipInstall(py, dir, ['https://github.com/Pointcept/Pointcept/archive/refs/heads/main.zip'], out, function () {
          state.phase = 'gpu_weights'; log('gpu: downloading model weights');
          let dm = null;
          try { dm = spawn(py, ['download_models.py'], { cwd: dir, windowsHide: true, stdio: ['ignore', out, out] }); }
          catch (e) { dm = null; }
          const finish = function () {
            // Отмечаем «done» ТОЛЬКО если CUDA реально работает — иначе при след. запуске повторим.
            if (cudaReady(py, dir)) { try { fs.writeFileSync(gmarker, JSON.stringify({ done: new Date().toISOString(), torch: torchVersion(py, dir) })); } catch (e) {} state.phase = 'gpu_done'; log('gpu: stack ready, CUDA ok'); }
            else { state.phase = 'gpu_no_cuda'; log('gpu: CUDA недоступен после установки — остаюсь на офлайн-движке (marker не ставлю)'); }
            done();
          };
          if (dm) { dm.on('error', finish); dm.on('exit', finish); } else finish();
        });
      });
    });
  });
}

function bootstrap(dir) {
  if (state.bootstrapping) return; // не запускаем параллельно
  const base = compatibleBase();
  if (!base) { state.error = 'python_incompatible'; state.phase = 'error'; log('bootstrap: нет Python 3.10-3.12 (для 3.13/3.14 нет PyTorch). Работает офлайн-движок.'); return; }
  // Несовместимое старое окружение (напр. созданное на 3.14) — пересоздаём.
  try {
    if (venvPython(dir) && !venvIsCompat(dir)) {
      log('bootstrap: .venv несовместим — удаляю и пересоздаю');
      fs.rmSync(path.join(dir, '.venv'), { recursive: true, force: true });
      try { fs.rmSync(path.join(dir, '.gpusetup.done'), { force: true }); } catch (e) {}
    }
  } catch (e) {}
  state.bootstrapping = true; state.phase = 'venv'; state.error = null;
  log('bootstrap: creating venv with ' + base.cmd + ' ' + base.args.join(' ') + '; gpu=' + hasGpu());
  const out = outFd();

  const proceedLaunch = function () {
    state.bootstrapping = false;
    const chosen = pickPython(dir);
    if (chosen) { log('bootstrap: launching server'); launch(chosen.py, dir, chosen.venv); }
    else { state.error = 'deps_missing_after_bootstrap'; state.phase = 'error'; log('bootstrap: deps still missing'); }
  };

  const afterCpu = function () {
    // Как только базовые зависимости есть — СРАЗУ поднимаем сервер (auto/geom работает),
    // а GPU-стек доставляем в фоне и перезапускаем сервер после готовности.
    const vp = venvPython(dir) || base.cmd;
    proceedLaunch();
    if (hasGpu()) {
      state.bootstrapping = true;
      runGpuStack(vp, dir, out, function () {
        state.bootstrapping = false;
        try { if (child) { log('gpu ready: restarting server on GPU'); child.kill(); child = null; } } catch (e) {}
        const chosen = pickPython(dir);
        if (chosen) launch(chosen.py, dir, chosen.venv);
      });
    }
  };

  let mk;
  try { mk = spawn(base.cmd, base.args.concat(['-m', 'venv', '.venv']), { cwd: dir, windowsHide: true, stdio: ['ignore', out, out] }); }
  catch (e) { state.bootstrapping = false; state.error = 'venv_failed'; state.phase = 'error'; log('bootstrap venv spawn failed'); return; }
  mk.on('error', function () { state.bootstrapping = false; state.error = 'venv_failed'; state.phase = 'error'; });
  mk.on('exit', function () {
    const vp = venvPython(dir) || base.cmd;
    state.phase = 'cpu_deps'; log('bootstrap: installing base deps');
    pipInstall(vp, dir, ['--upgrade', 'pip'], out, function () {
      pipInstall(vp, dir, ['-r', 'requirements-cpu.txt'], out, function (ok) {
        if (!ok) log('bootstrap: base deps install returned non-zero (продолжаю)');
        afterCpu();
      });
    });
  });
}

// v1190: fonovyy nablyudatel - kak tolko v .venv poyavlyaetsya polnyy stek (uvicorn)
// i/ili gotov GPU (.gpusetup.done + CUDA), avtomaticheski perezapuskaem server na luchshem
// interpretatore. Eto daet "odin klik": ustanovka idet v otdelnom okne, a prilozhenie
// samo perehodit s LITE na polnyy/GPU-server bez uchastiya polzovatelya.
function startUpgradeWatch(dir) {
  if (upgradeTimer) return;
  const gmarker = path.join(dir, '.gpusetup.done');
  upgradeTimer = setInterval(function () {
    try {
      const full = pickPython(dir);
      if (!full) return; // polnyy stek eshche ne ustanovlen - prodolzhaem rabotat na LITE
      let gpuDone = false;
      try { gpuDone = fs.existsSync(gmarker) && cudaReady(full.py, dir); } catch (e) { gpuDone = false; }
      const onLite = (state.phase === 'running_lite');
      const onCpu = (state.phase === 'running' && !state.gpuActive);
      if (onLite || (gpuDone && onCpu)) {
        log('upgrade-watch: switching server (gpuDone=' + gpuDone + ', from=' + state.phase + ', py=' + full.py + ')');
        try { if (child) { child.kill(); child = null; } } catch (e) {}
        state.starting = false;
        launch(full.py, dir, full.venv);
        if (gpuDone) { state.gpuActive = true; try { clearInterval(upgradeTimer); } catch (e) {} upgradeTimer = null; }
      }
    } catch (e) {}
  }, 15000);
  try { if (upgradeTimer && upgradeTimer.unref) upgradeTimer.unref(); } catch (e) {}
}

function start(opts) {
  opts = opts || {};
  if (child || state.starting) return state;
  const dir = serverDir();
  state.dir = dir;
  if (!dir) { state.error = 'no_server_dir'; log('no server dir'); return state; }
  state.starting = true; state.error = null;
  const chosen = pickPython(dir);
  if (chosen) {
    const st = launch(chosen.py, dir, chosen.venv);
    // v1190: esli GPU-zhelezo est, no CUDA/marker eshche ne gotovy - sledim i perehodim na GPU avtomaticheski.
    try {
      if (hasGpu()) {
        if (fs.existsSync(path.join(dir, '.gpusetup.done')) && cudaReady(chosen.py, dir)) { state.gpuActive = true; }
        else { startUpgradeWatch(dir); }
      }
    } catch (e) {}
    // GPU-стек доставляем ТОЛЬКО по явному запросу (install=true), НЕ при обычном автозапуске.
    if (opts.install && hasGpu() && !(fs.existsSync(path.join(dir, '.gpusetup.done')) && cudaReady(chosen.py, dir))) {
      const out = outFd(); state.bootstrapping = true;
      runGpuStack(chosen.py, dir, out, function () {
        state.bootstrapping = false;
        try { if (child) { log('gpu ready: restarting server on GPU'); child.kill(); child = null; } } catch (e) {}
        const c2 = pickPython(dir); if (c2) launch(c2.py, dir, c2.venv);
      });
    }
    return st;
  }
  // v1189: polnogo uvicorn-okruzheniya net - probuem LITE-server (tolko numpy).
  if (hasLiteServer(dir)) {
    const lite = pickPythonLite(dir);
    if (lite) {
      state.error = null; log('auto-start: uvicorn deps missing - launching LITE server (numpy only)');
      const stl = launchLite(lite.py, dir, lite.venv);
      if (hasGpu()) startUpgradeWatch(dir); // v1190: perekluchimsya na GPU-server kak tolko ustanovka zavershitsya
      return stl;
    }
  }
  // Готового AI-окружения нет.
  state.starting = false;
  if (opts.install) {
    // Явный запрос: ставим AI/GPU-окружение в фоне (один раз). До готовности работает офлайн-движок 1:1.
    bootstrap(dir);
  } else {
    // Обычный автозапуск: НИЧЕГО не качаем и не ставим. Режим 1:1 работает офлайн, на CPU.
    state.phase = 'offline';
    log('auto-start: AI-окружение не установлено — работаем на встроенном офлайн-движке 1:1 (без загрузок).');
  }
  return state;
}

function stop() {
  if (child) { try { child.kill(); } catch (e) {} child = null; }
  try { if (upgradeTimer) { clearInterval(upgradeTimer); upgradeTimer = null; } } catch (e) {}
  state.running = false; state.starting = false;
  return state;
}

function status() { return Object.assign({}, state, { hasDir: !!serverDir() }); }

// install() — явная установка опционального AI/GPU-стека (один раз, по кнопке/бату).
function install() { return start({ install: true }); }
module.exports = { start: start, stop: stop, status: status, install: install, PORT: PORT };
