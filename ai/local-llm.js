'use strict';
/*
 * local-llm.js — локальная языковая модель для ИИ-ассистента (ревизия 34; ревизия 35 — Qwen 3.8, зрение, эмбеддинги для базы норм). Только встроенные модули Node.
 *
 * Что делает ensure():
 *   1. Ищет уже работающий Ollama на 127.0.0.1:11434 (установлен пользователем) — тогда ничего не качает.
 *   2. Иначе — переносная копия Ollama в папке приложения (%LOCALAPPDATA%\BIMTwin\ollama, Linux ~/.local/share/BIMTwin/ollama,
 *      переменная BIMTWIN_OLLAMA_DIR): скачивание с GitHub с докачкой и проверкой SHA-256, распаковка, запуск `ollama serve`
 *      на 127.0.0.1:11435 (только локальный адрес, модели в своей папке).
 *   3. Выбирает самую умную модель, которая поместится в видеопамять / память и на диск (pickModel), скачивает её (/api/pull).
 *   4. Создаёт свою модель «bim-twin-assistant» поверх выбранной (системная подсказка, низкая температура, окно контекста).
 *   5. Докачивает модель эмбеддингов (qwen3-embedding:0.6b, 0,64 ГБ) для поиска по смыслу в базе норм (ai/norms-index.js).
 * Состояние пишется в state.json (его читают окно приложения, START.bat и установщик); блокировка setup.lock не даёт двум
 * процессам качать одновременно. Сеть — только к github.com / ollama.com (скачивание) и к 127.0.0.1 (работа модели).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const SYSTEM_PORT = 11434;
const OWN_PORT = 11435;
const ASSISTANT = 'bim-twin-assistant';
const PINNED_VERSION = 'v0.40.8';
const GB = 1024 * 1024 * 1024;

// Лестница моделей: сверху — умнее. size — объём скачивания, ГБ (с запасом), mem — сколько памяти нужно для работы, ГБ.
// Ревизия 35: вершина — Qwen 3.8 27B (август 2026; лучшая локальная модель: рассуждение, инструменты, зрение, контекст 256K).
const MODELS = [
  { id: 'qwen3.8:27b-q8_0', label: 'Qwen 3.8 27B (8 бит)', size: 30, mem: 34, ctx: 65536, think: true, vision: true, note: 'самая умная: Qwen 3.8 27B почти без потерь квантования — видеокарта 40–48 ГБ или Mac с 64 ГБ памяти и больше' },
  { id: 'qwen3.8:27b', label: 'Qwen 3.8 27B', size: 18, mem: 22, ctx: 32768, think: true, vision: true, note: 'лучшая локальная модель 2026 года: рассуждение, инструменты, понимает снимки — видеокарта 24 ГБ или Mac с 36 ГБ' },
  { id: 'qwen3.6:35b-a3b', label: 'Qwen 3.6 35B-A3B (MoE)', size: 24, mem: 27, ctx: 32768, think: true, vision: false, note: '35B, из них 3B активных — быстрая даже на процессоре при 32 ГБ памяти и больше' },
  { id: 'qwen3.5:9b', label: 'Qwen 3.5 9B', size: 7.6, mem: 9, ctx: 16384, think: true, vision: true, note: 'для видеокарт 8–12 ГБ и ПК с 16 ГБ памяти' },
  { id: 'qwen3.5:4b', label: 'Qwen 3.5 4B', size: 4, mem: 5, ctx: 12288, think: false, vision: true, note: 'для ПК с 8 ГБ памяти' },
  { id: 'qwen3.5:2b-q4_K_M', label: 'Qwen 3.5 2B', size: 1.9, mem: 3, ctx: 12288, think: false, vision: true, note: 'минимальная — слабые ПК' }
];
// модель для поиска по базе норм (эмбеддинги): многоязычная, хорошо понимает русский; первые keep чисел вектора (обучена «матрёшкой»)
const EMBED_MODELS = [
  { id: 'qwen3-embedding:0.6b', label: 'Qwen3 Embedding 0.6B', size: 0.64, keep: 512, query: 'Instruct: Given a question from a construction engineer, retrieve passages of building codes and project documents that answer it\nQuery: ' },
  { id: 'embeddinggemma', label: 'EmbeddingGemma 300M', size: 0.62, keep: 512, query: 'task: search result | query: ' }
];
const EMBED = EMBED_MODELS[0];

function modelInfo(id) { return MODELS.find(m => m.id === id) || null; }

// ------------------------------------------------------------------ пути и состояние
function baseDir(env) {
  const e = env || process.env;
  if (e.BIMTWIN_OLLAMA_DIR) return path.resolve(e.BIMTWIN_OLLAMA_DIR);
  if (process.platform === 'win32') return path.join(e.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'BIMTwin', 'ollama');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'BIMTwin', 'ollama');
  return path.join(e.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'BIMTwin', 'ollama');
}
function paths(dir) {
  const b = dir || baseDir();
  return { base: b, runtime: path.join(b, 'runtime'), models: path.join(b, 'models'), downloads: path.join(b, 'downloads'),
    state: path.join(b, 'state.json'), lock: path.join(b, 'setup.lock'), log: path.join(b, 'setup.log'), ready: path.join(b, 'ready.flag') };
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 1));
  fs.renameSync(tmp, p);
}
function readState(dir) { return readJson(paths(dir).state) || { phase: 'none' }; }
function pidAlive(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}
// блокировка: файл с pid; считается брошенной, если процесса нет или состояние не обновлялось 15 минут
function takeLock(dir) {
  const P = paths(dir);
  fs.mkdirSync(P.base, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(P.lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' }); return true; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const L = readJson(P.lock) || {};
      const st = readState(dir);
      const stale = !pidAlive(L.pid) || (Date.now() - (st.updated || L.at || 0) > 15 * 60 * 1000);
      if (!stale) return false;
      try { fs.unlinkSync(P.lock); } catch (_) {}
    }
  }
  return false;
}
function releaseLock(dir) {
  const P = paths(dir), L = readJson(P.lock);
  if (L && L.pid === process.pid) { try { fs.unlinkSync(P.lock); } catch (_) {} }
}
function lockHolder(dir) { const L = readJson(paths(dir).lock); return L && pidAlive(L.pid) && L.pid !== process.pid ? L : null; }

// ------------------------------------------------------------------ железо и выбор модели
function run(cmd, args, timeoutMs) {
  return new Promise(resolve => {
    try {
      execFile(cmd, args, { timeout: timeoutMs || 5000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : String(stdout || '')));
    } catch (_) { resolve(null); }
  });
}
function parseNvidia(out) {
  const gpus = [];
  String(out || '').split(/\r?\n/).forEach(line => {
    const m = line.split(',').map(s => s.trim());
    if (m.length >= 2 && +m[1] > 0) gpus.push({ name: m[0], vramGB: +m[1] / 1024 });
  });
  return gpus;
}
async function hardware(opts) {
  const o = opts || {};
  const ramGB = (o.ramGB != null ? o.ramGB : os.totalmem() / GB);
  let gpus = o.gpus || null;
  if (!gpus) gpus = parseNvidia(await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], 6000));
  let vramGB = gpus.reduce((a, g) => a + g.vramGB, 0);
  const apple = process.platform === 'darwin' && process.arch === 'arm64';
  if (apple && !vramGB) vramGB = ramGB * 0.65;     // общая память Apple Silicon
  let freeGB = o.freeGB;
  if (freeGB == null) {
    try { const d = paths(o.dir).base; fs.mkdirSync(d, { recursive: true }); const s = fs.statfsSync(d); freeGB = s.bavail * s.bsize / GB; } catch (_) { freeGB = null; }
  }
  return { ramGB: round1(ramGB), vramGB: round1(vramGB), gpus, apple, cpus: (os.cpus() || []).length, freeGB: freeGB == null ? null : round1(freeGB), platform: process.platform, arch: process.arch };
}
function round1(x) { return Math.round(x * 10) / 10; }
// самая умная модель, которая поместится: видеопамять 34+ ГБ → Qwen 3.8 27B 8 бит; 22+ ГБ → Qwen 3.8 27B; много общей памяти → MoE 35B-A3B; далее 9B / 4B / 2B
function pickModel(hw, opts) {
  const h = hw || {}, o = opts || {}, ram = +h.ramGB || 0, vram = +h.vramGB || 0;
  let i;
  if (vram >= 34) i = 0;
  else if (vram >= 22) i = 1;
  else if ((vram >= 8 && ram >= 32) || ram >= 48) i = 2;
  else if (vram >= 8 || ram >= 15) i = 3;
  else if (ram >= 7.5 || vram >= 5) i = 4;
  else i = 5;
  const reasons = [];
  // диск: модель + 2 ГБ запаса (уже скачанные модели не считаются)
  while (i < MODELS.length - 1 && h.freeGB != null && !(o.have || []).includes(MODELS[i].id) && h.freeGB < MODELS[i].size + 2) { reasons.push('мало места на диске для ' + MODELS[i].label); i++; }
  const m = MODELS[i];
  return { id: m.id, model: m, reasons, why: whyText(h, m) };
}
function whyText(h, m) {
  const parts = [];
  if (h.vramGB) parts.push('видеопамять ' + h.vramGB + ' ГБ');
  parts.push('память ' + h.ramGB + ' ГБ');
  return m.label + ' — ' + parts.join(', ') + ': ' + m.note;
}

// ------------------------------------------------------------------ HTTP
function request(urlStr, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const body = o.body != null ? Buffer.from(typeof o.body === 'string' ? o.body : JSON.stringify(o.body)) : null;
    const headers = Object.assign({ 'User-Agent': 'BIM-Twin/1.2 (+local assistant)' }, o.headers || {});
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    const req = lib.request({ method: o.method || (body ? 'POST' : 'GET'), hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, headers }, res => resolve({ res, req }));
    req.on('error', reject);
    if (o.timeout) req.setTimeout(o.timeout, () => req.destroy(new Error('timeout')));
    if (o.signal) { if (o.signal.aborted) req.destroy(new Error('cancelled')); else o.signal.addEventListener('abort', () => req.destroy(new Error('cancelled')), { once: true }); }
    if (body) req.write(body);
    req.end();
  });
}
async function getText(urlStr, opts, depth) {
  const { res } = await request(urlStr, Object.assign({ timeout: 30000 }, opts));
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (depth || 0) < 6) { res.resume(); return getText(new URL(res.headers.location, urlStr).href, opts, (depth || 0) + 1); }
  const chunks = []; let n = 0;
  for await (const c of res) { n += c.length; if (n > 8 * 1024 * 1024) throw new Error('response_too_large'); chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (res.statusCode < 200 || res.statusCode >= 300) { const e = new Error('http_' + res.statusCode + (text ? ': ' + text.slice(0, 200) : '')); e.status = res.statusCode; throw e; }
  return text;
}
async function getJson(urlStr, opts) { return JSON.parse(await getText(urlStr, opts)); }
// построчный JSON (поток Ollama): onLine(obj) на каждую строку
async function streamJsonLines(urlStr, body, onLine, opts) {
  const { res } = await request(urlStr, Object.assign({ method: 'POST', body }, opts || {}));
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let t = ''; for await (const c of res) { t += c; if (t.length > 4000) break; }
    let msg = t; try { msg = JSON.parse(t).error || t; } catch (_) {}
    const e = new Error(String(msg || ('http_' + res.statusCode)).slice(0, 400)); e.status = res.statusCode; throw e;
  }
  let buf = '', last = null;
  for await (const c of res) {
    buf += c.toString('utf8');
    let k;
    while ((k = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch (_) { continue; }
      if (j.error) throw new Error(String(j.error));
      last = j; onLine(j);
    }
  }
  if (buf.trim()) { try { const j = JSON.parse(buf); if (j.error) throw new Error(String(j.error)); last = j; onLine(j); } catch (e) { if (e && e.message && !/JSON/.test(e.message)) throw e; } }
  return last;
}

// ------------------------------------------------------------------ скачивание с докачкой и проверкой
async function download(urlStr, dest, opts) {
  const o = opts || {};
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  let have = 0; try { have = fs.statSync(part).size; } catch (_) {}
  let url = urlStr, res = null;
  for (let hop = 0; hop < 8; hop++) {
    const headers = have > 0 ? { Range: 'bytes=' + have + '-' } : {};
    ({ res } = await request(url, { headers, timeout: 60000, signal: o.signal }));
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); url = new URL(res.headers.location, url).href; continue; }
    break;
  }
  if (res.statusCode === 416) { res.resume(); try { fs.unlinkSync(part); } catch (_) {} return download(urlStr, dest, Object.assign({}, o, { _retry: (o._retry || 0) + 1 })); }
  if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); throw new Error('download_http_' + res.statusCode); }
  if (res.statusCode === 200) have = 0;                     // сервер не умеет Range — сначала
  const total = res.statusCode === 206 ? have + (+res.headers['content-length'] || 0) : (+res.headers['content-length'] || 0);
  const out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
  let done = have, lastT = 0;
  await new Promise((resolve, reject) => {
    res.on('data', c => {
      done += c.length;
      if (!out.write(c)) { res.pause(); out.once('drain', () => res.resume()); }
      const t = Date.now(); if (o.onProgress && t - lastT > 400) { lastT = t; o.onProgress(done, total); }
    });
    res.on('end', () => out.end(resolve));
    res.on('error', e => { out.end(); reject(e); });
    res.on('aborted', () => { out.end(); reject(new Error('download_aborted')); });
  });
  if (total && done < total) throw new Error('download_incomplete');
  if (o.onProgress) o.onProgress(done, total || done);
  if (o.sha256) {
    const got = await sha256File(part);
    if (got !== String(o.sha256).toLowerCase()) {
      try { fs.unlinkSync(part); } catch (_) {}
      if (!o._retry) return download(urlStr, dest, Object.assign({}, o, { _retry: 1 }));
      throw new Error('sha256_mismatch');
    }
  }
  fs.renameSync(part, dest);
  return { path: dest, bytes: done };
}
function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// ------------------------------------------------------------------ переносной Ollama
function assetName(platform, arch) {
  const p = platform || process.platform, a = arch || process.arch;
  if (p === 'win32') return a === 'arm64' ? 'ollama-windows-arm64.zip' : 'ollama-windows-amd64.zip';
  if (p === 'linux') return a === 'arm64' ? 'ollama-linux-arm64.tar.zst' : 'ollama-linux-amd64.tar.zst';
  if (p === 'darwin') return 'ollama-darwin.tgz';
  return null;
}
function parseShaList(text) {
  const m = {};
  String(text || '').split(/\r?\n/).forEach(line => { const r = line.trim().match(/^([0-9a-f]{64})\s+\*?(?:\.\/)?(\S+)$/i); if (r) m[r[2]] = r[1].toLowerCase(); });
  return m;
}
async function latestVersion(opts) {
  try {
    const j = await getJson('https://api.github.com/repos/ollama/ollama/releases/latest', Object.assign({ headers: { Accept: 'application/vnd.github+json' }, timeout: 20000 }, opts || {}));
    if (j && /^v\d/.test(j.tag_name || '')) return j.tag_name;
  } catch (_) {}
  return PINNED_VERSION;
}
function findBinary(root) {
  const want = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name === want) return p;
      if (e.isDirectory() && d.split(path.sep).length - root.split(path.sep).length < 3) stack.push(p);
    }
  }
  return null;
}
function runtimeBinary(dir) {
  const P = paths(dir), st = readState(dir);
  if (st.binary && fs.existsSync(st.binary)) return st.binary;
  return fs.existsSync(P.runtime) ? findBinary(P.runtime) : null;
}
function spawnWait(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const ch = spawn(cmd, args, Object.assign({ windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }, opts || {}));
    let err = ''; ch.stderr.on('data', d => { err = (err + d).slice(-2000); });
    ch.on('error', reject);
    ch.on('close', code => code === 0 ? resolve() : reject(new Error(cmd + ' exit ' + code + (err ? ': ' + err.trim() : ''))));
  });
}
async function extract(archive, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  if (/\.zip$/i.test(archive)) {
    if (process.platform === 'win32') {
      const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      try { await spawnWait(fs.existsSync(tarExe) ? tarExe : 'tar', ['-xf', archive, '-C', dest]); return; } catch (_) {}
      await spawnWait('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'Expand-Archive -LiteralPath $env:BT_SRC -DestinationPath $env:BT_DST -Force'],
        { env: Object.assign({}, process.env, { BT_SRC: archive, BT_DST: dest }) });
      return;
    }
    await spawnWait('unzip', ['-q', '-o', archive, '-d', dest]);
    return;
  }
  if (/\.tar\.zst$/i.test(archive)) {
    try { await spawnWait('tar', ['--zstd', '-xf', archive, '-C', dest]); return; } catch (_) {}
    await spawnWait('sh', ['-c', 'zstd -dc "$BT_SRC" | tar -x -C "$BT_DST"'], { env: Object.assign({}, process.env, { BT_SRC: archive, BT_DST: dest }) });
    return;
  }
  await spawnWait('tar', ['-xzf', archive, '-C', dest]);
}

// ------------------------------------------------------------------ сервер
async function ping(port, timeoutMs) {
  try { const j = await getJson('http://127.0.0.1:' + port + '/api/version', { timeout: timeoutMs || 1500 }); return j && j.version ? j.version : null; } catch (_) { return null; }
}
let child = null;          // наш `ollama serve` в этом процессе
function serverEnv(dir) {
  const P = paths(dir);
  return Object.assign({}, process.env, { OLLAMA_HOST: '127.0.0.1:' + OWN_PORT, OLLAMA_MODELS: P.models, OLLAMA_KEEP_ALIVE: '15m', OLLAMA_NOPRUNE: '1', OLLAMA_ORIGINS: 'http://127.0.0.1,http://localhost' });
}
async function startServer(dir, opts) {
  const o = opts || {};
  if (await ping(OWN_PORT)) return { port: OWN_PORT, own: false };
  const bin = runtimeBinary(dir);
  if (!bin) throw new Error('ollama_not_installed');
  const P = paths(dir);
  fs.mkdirSync(P.models, { recursive: true });
  const logFd = fs.openSync(path.join(P.base, 'server.log'), 'a');
  child = spawn(bin, ['serve'], { env: serverEnv(dir), windowsHide: true, detached: !!o.detached, stdio: ['ignore', logFd, logFd] });
  child.on('exit', () => { child = null; });
  try { fs.closeSync(logFd); } catch (_) {}
  if (o.detached) child.unref();
  for (let i = 0; i < 120; i++) {
    if (await ping(OWN_PORT, 1000)) return { port: OWN_PORT, own: true, pid: child && child.pid };
    if (!child) break;
    await sleep(500);
  }
  throw new Error('ollama_server_did_not_start');
}
function stopServer() { if (child) { try { child.kill(); } catch (_) {} child = null; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// где работать: свой сервер приложения (11435) или уже установленный пользователем Ollama (11434)
async function endpoint(dir, opts) {
  const st = readState(dir);
  if (st.server === 'system' && await ping(SYSTEM_PORT)) return { url: 'http://127.0.0.1:' + SYSTEM_PORT, system: true };
  if (st.server === 'custom' && st.url && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(st.url)) { try { const j = await getJson(st.url + '/api/version', { timeout: 1500 }); if (j && j.version) return { url: st.url, system: true }; } catch (_) {} }
  if (await ping(OWN_PORT)) return { url: 'http://127.0.0.1:' + OWN_PORT, system: false };
  if (opts && opts.start === false) return null;
  if (runtimeBinary(dir)) { await startServer(dir); return { url: 'http://127.0.0.1:' + OWN_PORT, system: false }; }
  if (await ping(SYSTEM_PORT)) return { url: 'http://127.0.0.1:' + SYSTEM_PORT, system: true };
  return null;
}
async function listModels(url) {
  try { const j = await getJson(url + '/api/tags', { timeout: 5000 }); return (j.models || []).map(m => m.name || m.model); } catch (_) { return []; }
}
function hasModel(list, id) { const want = id.includes(':') ? id : id + ':latest'; return list.some(n => n === id || n === want); }

// ------------------------------------------------------------------ установка целиком
function makeReporter(dir, onProgress) {
  const P = paths(dir);
  let cur = Object.assign({}, readState(dir));
  return function set(patch) {
    cur = Object.assign({}, cur, patch, { updated: Date.now(), pid: process.pid });
    try { writeJson(P.state, cur); } catch (_) {}
    if (patch.message) { try { fs.appendFileSync(P.log, new Date().toISOString() + ' ' + patch.message + '\n'); } catch (_) {} }
    if (onProgress) { try { onProgress(cur); } catch (_) {} }
    return cur;
  };
}
async function ensure(opts) {
  const o = opts || {}, dir = o.dir, P = paths(dir);
  fs.mkdirSync(P.base, { recursive: true });
  if (!takeLock(dir)) return { ok: false, busy: true, state: readState(dir), holder: lockHolder(dir) };
  const set = makeReporter(dir, o.onProgress);
  try {
    set({ phase: 'check', pct: 0, message: 'Проверка компьютера', error: null });
    const hw = o.hardware || await hardware({ dir });
    // 1) сервер: уже установленный Ollama пользователя или свой переносной
    let url = null, server = 'own';
    const sys = o.url || o.useSystem === false ? null : await ping(SYSTEM_PORT);
    if (o.url) { url = String(o.url).replace(/\/$/, ''); server = 'custom'; set({ server, message: 'Сервер модели: ' + url }); }   // явный адрес (тесты, свой сервер на этом ПК)
    else if (sys) { url = 'http://127.0.0.1:' + SYSTEM_PORT; server = 'system'; set({ server, ollamaVersion: sys, message: 'Найден установленный Ollama ' + sys }); }
    else {
      if (!runtimeBinary(dir)) {
        const asset = assetName();
        if (!asset) throw new Error('unsupported_platform');
        const ver = o.version || await latestVersion();
        const baseUrl = (o.mirror || 'https://github.com/ollama/ollama/releases/download/' + ver).replace(/\/$/, '');
        let sums = {};
        try { sums = parseShaList(await getText(baseUrl + '/sha256sum.txt')); } catch (_) {}
        const file = path.join(P.downloads, ver + '-' + asset);
        if (!fs.existsSync(file)) {
          set({ phase: 'runtime', pct: 0, version: ver, message: 'Скачивание Ollama ' + ver + ' (' + asset + ')' });
          await download(baseUrl + '/' + asset, file, { sha256: sums[asset] || null, signal: o.signal,
            onProgress: (d, t) => set({ phase: 'runtime', done: d, total: t, pct: t ? Math.round(d / t * 1000) / 10 : 0 }) });
        }
        set({ phase: 'extract', pct: 0, message: 'Распаковка Ollama' });
        await extract(file, P.runtime);
        const bin = findBinary(P.runtime);
        if (!bin) throw new Error('ollama_binary_not_found');
        if (process.platform !== 'win32') { try { fs.chmodSync(bin, 0o755); } catch (_) {} }
        set({ binary: bin, version: ver, message: 'Ollama распакован: ' + bin });
        if (!o.keepArchive) { try { fs.unlinkSync(file); } catch (_) {} }
      }
      set({ phase: 'server', message: 'Запуск локального сервера модели' });
      await startServer(dir);
      url = 'http://127.0.0.1:' + OWN_PORT;
      set({ server, ollamaVersion: await ping(OWN_PORT) });
    }
    // 2) модель
    const have = await listModels(url);
    const pick = o.model ? { id: o.model, model: modelInfo(o.model) || { id: o.model, label: o.model, ctx: 8192, think: false }, reasons: [], why: 'выбрана вручную' } : pickModel(hw, { have });
    let base = pick.id, mi = pick.model;
    const reasons = pick.reasons.slice();
    set({ hardware: hw, base, why: pick.why, reasons });
    // тег новой модели может ещё не быть в библиотеке Ollama — при автоматическом выборе берём следующую ступень
    for (;;) {
      if (hasModel(have, base)) break;
      try {
        set({ phase: 'model', pct: 0, done: 0, total: 0, message: 'Скачивание модели ' + mi.label });
        const digests = {};
        await streamJsonLines(url + '/api/pull', { model: base, stream: true }, j => {
          if (j.digest && j.total) digests[j.digest] = { total: j.total, done: j.completed || 0 };
          const all = Object.values(digests), t = all.reduce((a, x) => a + x.total, 0), d = all.reduce((a, x) => a + x.done, 0);
          set({ phase: 'model', status: j.status || '', done: d, total: t, pct: t ? Math.round(d / t * 1000) / 10 : 0 });
        }, { signal: o.signal });
        break;
      } catch (e) {
        const i = MODELS.findIndex(m => m.id === base);
        if (o.model || i < 0 || i >= MODELS.length - 1 || !isMissingTag(e) || (o.signal && o.signal.aborted)) throw e;
        reasons.push(mi.label + ' недоступна в Ollama (' + String(e && e.message || e).slice(0, 80) + ')');
        mi = MODELS[i + 1]; base = mi.id;
        set({ base, why: whyText(hw, mi), reasons });
      }
    }
    // 3) своя модель: системная подсказка ассистента и параметры
    set({ phase: 'create', pct: 100, message: 'Настройка модели «' + ASSISTANT + '»' });
    // r42: если пользователь уже «обучал» модель опытом — при переустановке опыт сохраняется
    const cb = assistantBody(base, mi.ctx, !!readState(dir).trained);
    await streamJsonLines(url + '/api/create', cb.body, () => {}, { signal: o.signal });
    const caps = await capabilities(url, ASSISTANT);
    let res = set({ phase: 'ready', pct: 100, model: ASSISTANT, base, server, url, think: !!mi.think, ctx: mi.ctx || 8192, caps, vision: caps.includes('vision'),
      message: 'Готово: ' + mi.label + ' (' + ASSISTANT + ')', error: null });
    try { fs.writeFileSync(P.ready, JSON.stringify({ base, at: Date.now() })); } catch (_) {}
    // 4) модель поиска по базе норм — уже после «готово»: ассистент отвечает, пока она качается; ошибка не мешает (остаётся поиск по словам)
    if (o.embed !== false) { await pullEmbed(url, set, o.signal); res = readState(dir); }
    return { ok: true, state: res };
  } catch (e) {
    const msg = String(e && e.message || e);
    set({ phase: 'error', error: msg, message: 'Ошибка: ' + msg });
    return { ok: false, error: msg, state: readState(dir) };
  } finally {
    releaseLock(dir);
    if (o.stopServerAfter) stopServer();
  }
}
// ------------------------------------------------------------------ r42: опыт пользователя в модели
// память ассистента (опыт, правила, пакеты знаний) — рядом с папкой модели: …/BIMTwin/assistant/memory.json
function memoryPath(env) {
  const e = env || process.env;
  if (e.BIMTWIN_AI_MEMORY) return path.resolve(e.BIMTWIN_AI_MEMORY);
  return path.join(path.dirname(baseDir(e)), 'assistant', 'memory.json');
}
// тело /api/create: системная подсказка ассистента; с withMemory — плюс знания пользователя и одобренные примеры диалогов
function assistantBody(base, ctxLen, withMemory, memory) {
  const prompt = require('./assistant-prompt');
  const parameters = { temperature: 0.3, top_p: 0.9, num_ctx: ctxLen || 8192 };
  if (!withMemory) return { body: { model: ASSISTANT, from: base, system: prompt.SYSTEM_SHORT, parameters, stream: true }, examples: 0, facts: 0 };
  const M = require('./assistant-memory');
  const mem = M.normalize(memory || readJson(memoryPath()));
  return M.createPayload(mem, { model: ASSISTANT, from: base, system: prompt.SYSTEM_SHORT, parameters });
}
// «Обновить модель опытом»: пересоздать bim-twin-assistant из той же базовой модели (веса не меняются, скачивания нет — секунды)
async function train(opts) {
  const o = opts || {}, st = readState(o.dir);
  if (st.phase !== 'ready' || !st.base) return { ok: false, error: 'Сначала дождитесь установки модели.' };
  if (!takeLock(o.dir)) return { ok: false, busy: true, error: 'Сейчас идёт установка модели — попробуйте позже.' };
  try {
    const ep = await endpoint(o.dir);
    if (!ep) throw new Error('Сервер модели не запущен.');
    const reset = o.reset === true, p = assistantBody(st.base, st.ctx, !reset, o.memory);
    await streamJsonLines(ep.url + '/api/create', p.body, () => {}, { signal: o.signal, timeout: o.timeout });
    const trained = reset ? null : { at: Date.now(), examples: p.examples, facts: p.facts };
    writeJson(paths(o.dir).state, Object.assign(readState(o.dir), { trained }));
    return { ok: true, reset, examples: p.examples, facts: p.facts, model: ASSISTANT, base: st.base };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  finally { releaseLock(o.dir); }
}

// что умеет модель (Ollama /api/show → capabilities: completion, tools, thinking, vision)
function isMissingTag(e) { return (e && e.status === 404) || /file does not exist|manifest|not found|pull model|unknown model|404/i.test(String(e && e.message || e)); }
async function capabilities(url, model) {
  try { const j = JSON.parse(await getText(url + '/api/show', { method: 'POST', body: { model }, timeout: 20000 })); return Array.isArray(j.capabilities) ? j.capabilities : []; } catch (_) { return []; }
}
// скачать модель эмбеддингов (поиск по смыслу в базе норм); set — запись состояния (embedPhase, embedPct, embed)
async function pullEmbed(url, set, signal) {
  for (const em of EMBED_MODELS) {
    try {
      const have = await listModels(url);
      if (!hasModel(have, em.id)) {
        set({ embedPhase: 'pull', embedPct: 0, message: 'Скачивание модели поиска по нормам ' + em.label });
        const dg = {};
        await streamJsonLines(url + '/api/pull', { model: em.id, stream: true }, j => {
          if (j.digest && j.total) dg[j.digest] = { total: j.total, done: j.completed || 0 };
          const all = Object.values(dg), t = all.reduce((a, x) => a + x.total, 0), d = all.reduce((a, x) => a + x.done, 0);
          set({ embedPhase: 'pull', embedPct: t ? Math.round(d / t * 1000) / 10 : 0 });
        }, { signal });
      }
      set({ embedPhase: 'ready', embedPct: 100, embed: em.id, embedError: null, message: 'Поиск по смыслу в базе норм: ' + em.label });
      return em.id;
    } catch (e) {
      if (signal && signal.aborted) throw e;
      set({ embedPhase: 'error', embedError: String(e && e.message || e) });
    }
  }
  return null;
}
// докачать модель эмбеддингов для уже установленного ассистента (установки ревизии 34)
async function ensureEmbed(opts) {
  const o = opts || {}, dir = o.dir;
  const st = readState(dir);
  if (st.embed && st.embedPhase === 'ready' && !o.force) return { ok: true, embed: st.embed };
  if (!takeLock(dir)) return { ok: false, busy: true };
  const set = makeReporter(dir, o.onProgress);
  try {
    const ep = o.url ? { url: o.url } : await endpoint(dir);
    if (!ep) return { ok: false, error: 'model_not_ready' };
    const id = await pullEmbed(ep.url, set, o.signal);
    return id ? { ok: true, embed: id } : { ok: false, error: readState(dir).embedError || 'embed_failed' };
  } finally { releaseLock(dir); }
}
function embedInfo(id) { return EMBED_MODELS.find(m => m.id === id || m.id === String(id || '').replace(/:latest$/, '')) || EMBED; }
// эмбеддинги: input — строки; возвращает Float32Array длиной keep (нормированные) для каждой строки; query — добавить инструкцию запроса
async function embed(opts) {
  const o = opts || {};
  const st = readState(o.dir);
  const model = o.model || st.embed;
  if (!model) throw new Error('embed_model_not_ready');
  const ep = o.url ? { url: o.url } : await endpoint(o.dir);
  if (!ep) throw new Error('model_not_ready');
  const em = embedInfo(model), keep = o.keep || em.keep || 512;
  const input = (o.input || []).map(t => (o.query ? em.query : '') + String(t || '').slice(0, 6000));
  const j = JSON.parse(await getText(ep.url + '/api/embed', { method: 'POST', body: { model, input, truncate: true, keep_alive: '30m' }, timeout: o.timeout || 5 * 60 * 1000, signal: o.signal }));
  return (j.embeddings || []).map(v => normalize(v, keep));
}
function normalize(v, keep) {
  const n = Math.min(keep || v.length, v.length), out = new Float32Array(n);
  let s = 0; for (let i = 0; i < n; i++) { out[i] = v[i]; s += v[i] * v[i]; }
  s = Math.sqrt(s) || 1; for (let i = 0; i < n; i++) out[i] /= s;
  return out;
}
function isReady(dir) { const st = readState(dir); return st.phase === 'ready' && fs.existsSync(paths(dir).ready); }

// ------------------------------------------------------------------ разговор с моделью (поток)
// messages — формат Ollama /api/chat; tools — описания функций; onDelta({content, thinking}) — по мере генерации
async function chat(opts) {
  const o = opts || {};
  const ep = o.url ? { url: o.url } : await endpoint(o.dir);
  if (!ep) throw new Error('model_not_ready');
  const st = readState(o.dir);
  const body = { model: o.model || st.model || ASSISTANT, messages: o.messages || [], stream: true, keep_alive: o.keepAlive || '15m',
    options: Object.assign({ temperature: 0.3, num_ctx: st.ctx || 8192 }, o.options || {}) };
  if (o.tools && o.tools.length) body.tools = o.tools;
  if (o.think != null) body.think = !!o.think;
  let content = '', thinking = '', calls = [], last = null;
  last = await streamJsonLines(ep.url + '/api/chat', body, j => {
    const m = j.message || {};
    if (m.content) content += m.content;
    if (m.thinking) thinking += m.thinking;
    if (m.tool_calls && m.tool_calls.length) calls = calls.concat(m.tool_calls);
    if ((m.content || m.thinking) && o.onDelta) { try { o.onDelta({ content: m.content || '', thinking: m.thinking || '' }); } catch (_) {} }
  }, { signal: o.signal, timeout: o.timeout || 10 * 60 * 1000 });
  const msg = { role: 'assistant', content };
  if (thinking) msg.thinking = thinking;
  if (calls.length) msg.tool_calls = calls;
  return { message: msg, stats: last ? { evalCount: last.eval_count, evalMs: last.eval_duration ? last.eval_duration / 1e6 : null, promptCount: last.prompt_eval_count, totalMs: last.total_duration ? last.total_duration / 1e6 : null } : null };
}

async function status(dir) {
  const st = readState(dir), holder = lockHolder(dir);
  const ep = await endpoint(dir, { start: false });
  return Object.assign({}, st, { dir: paths(dir).base, running: !!ep, endpoint: ep ? ep.url : null, busy: !!holder, ready: st.phase === 'ready', models: MODELS });
}

module.exports = {
  MODELS, EMBED_MODELS, EMBED, ASSISTANT, OWN_PORT, SYSTEM_PORT, PINNED_VERSION,
  baseDir, paths, readState, takeLock, releaseLock, lockHolder, pidAlive,
  hardware, parseNvidia, pickModel, modelInfo, assetName, parseShaList, latestVersion,
  download, sha256File, extract, findBinary, runtimeBinary,
  ping, startServer, stopServer, endpoint, listModels, hasModel,
  ensure, isReady, chat, status, streamJsonLines, request,
  capabilities, pullEmbed, ensureEmbed, embed, embedInfo, normalize,
  memoryPath, assistantBody, train
};
