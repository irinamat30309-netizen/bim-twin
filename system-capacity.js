'use strict';
/*
 * system-capacity.js — сколько точек облака этот компьютер покажет без сброса видеокарты (ревизия 27).
 *
 * Белый экран при 671,8 млн точек (ревизия 26) — видеокарта сбросила изображение: облако не поместилось в видеопамять. Предел зависит
 * от компьютера: у RTX 5070 (12 ГБ) он один, у встроенной графики ноутбука — в десятки раз меньше. Здесь собираются сведения о памяти
 * видеокарты и оперативной памяти и считается рекомендуемое и наибольшее надёжное число точек на экране (как выбор плотности в Lixel Studio).
 *
 *   probe({ app, os, execFile, platform }) → Promise<{ ok, ram, gpu, cpu, recommendation }>
 *   recommend({ vramTotal, vramFree, ramTotal, ramFree, integrated }) → { points, safeMax, minimum, perPointGpu, perPointRam, limitedBy, notes }
 *   parseNvidiaSmi(text) / parseRegMemory(text) / vramFromName(name) — разбор ответов системы (проверяются тестами)
 *
 * Память на точку: видеокарта — позиция 12 Б + цвет 3 Б (+ запас на служебные буферы) ≈ 16 Б; окно — копии частей для правки
 * (позиция 12 + цвет 3 + интенсивность 2 + класс 1 = 18 Б) + запас ≈ 20 Б.
 */
const GPU_BYTES_PER_POINT = 16;
const RAM_BYTES_PER_POINT = 20;
const GB = 1024 * 1024 * 1024;

// Видеопамять по названию видеокарты — когда система её не сообщает (порядок важен: более точные названия раньше)
const GPU_TABLE = [
  [/rtx\s*5090/i, 32], [/rtx\s*5080/i, 16], [/rtx\s*5070\s*ti/i, 16], [/rtx\s*5070/i, 12], [/rtx\s*5060\s*ti/i, 16], [/rtx\s*5060/i, 8],
  [/rtx\s*4090/i, 24], [/rtx\s*4080/i, 16], [/rtx\s*4070\s*ti\s*super/i, 16], [/rtx\s*4070/i, 12], [/rtx\s*4060\s*ti/i, 8], [/rtx\s*4060/i, 8],
  [/rtx\s*3090/i, 24], [/rtx\s*3080\s*ti/i, 12], [/rtx\s*3080/i, 10], [/rtx\s*3070/i, 8], [/rtx\s*3060\s*ti/i, 8], [/rtx\s*3060/i, 12], [/rtx\s*3050/i, 8],
  [/rtx\s*2080\s*ti/i, 11], [/rtx\s*2080/i, 8], [/rtx\s*2070/i, 8], [/rtx\s*2060/i, 6], [/gtx\s*1660/i, 6], [/gtx\s*1650/i, 4],
  [/gtx\s*1080\s*ti/i, 11], [/gtx\s*1080/i, 8], [/gtx\s*1070/i, 8], [/gtx\s*1060/i, 6], [/gtx\s*1050/i, 4],
  [/rtx\s*a6000|rtx\s*6000/i, 48], [/rtx\s*a5000|rtx\s*5000/i, 24], [/rtx\s*a4000|rtx\s*4000/i, 16], [/quadro\s*p4000/i, 8], [/rtx\s*a2000|rtx\s*2000/i, 8],
  [/rx\s*7900\s*xtx/i, 24], [/rx\s*7900/i, 20], [/rx\s*7800/i, 16], [/rx\s*7700/i, 12], [/rx\s*7600/i, 8], [/rx\s*9070/i, 16], [/rx\s*9060/i, 16],
  [/rx\s*6900|rx\s*6800/i, 16], [/rx\s*6700/i, 12], [/rx\s*6600/i, 8], [/rx\s*6500/i, 4], [/rx\s*5700/i, 8], [/rx\s*580|rx\s*570/i, 8],
  [/arc\s*a770/i, 16], [/arc\s*a750/i, 8], [/arc\s*b580/i, 12], [/arc\s*b570/i, 10]
];
const INTEGRATED_RE = /intel\s*\(r\)?\s*(uhd|hd|iris)|intel.*graphics|radeon\(tm\)?\s*graphics|vega\s*\d+\s*graphics|apple\s*m\d|microsoft basic|swiftshader|llvmpipe/i;

function num(v) { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; }

// «12227, 1534, NVIDIA GeForce RTX 5070» (МиБ) — nvidia-smi --query-gpu=memory.total,memory.used,name --format=csv,noheader,nounits
function parseNvidiaSmi(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const a = line.split(',').map(s => s.trim()); if (a.length < 2) continue;
    const total = Number(a[0]), used = Number(a[1]);
    if (!(total > 0) || !(used >= 0)) continue;
    out.push({ name: a[2] || 'NVIDIA', vramTotal: total * 1024 * 1024, vramFree: Math.max(0, total - used) * 1024 * 1024 });
  }
  out.sort((x, y) => y.vramTotal - x.vramTotal);
  return out[0] || null;
}
// reg query ... /v HardwareInformation.qwMemorySize → «HardwareInformation.qwMemorySize    REG_QWORD    0x300000000»; AdapterString — название
function parseRegMemory(text) {
  const s = String(text || ''); let best = null, curName = '';
  for (const line of s.split(/\r?\n/)) {
    const nm = /HardwareInformation\.AdapterString\s+REG_\w+\s+(.+)$/i.exec(line); if (nm) curName = nm[1].trim();
    const m = /HardwareInformation\.(?:qwMemorySize|MemorySize)\s+REG_(QWORD|DWORD|BINARY)\s+(\S+)/i.exec(line);
    if (!m) continue;
    let v = 0;
    if (/^0x/i.test(m[2])) v = parseInt(m[2], 16);
    else if (m[1].toUpperCase() === 'BINARY') { const h = m[2].match(/../g) || []; for (let i = h.length - 1; i >= 0; i--) v = v * 256 + parseInt(h[i], 16); }
    else v = Number(m[2]);
    if (v > 256 * 1024 * 1024 && (!best || v > best.vramTotal)) best = { name: curName || '', vramTotal: v };
  }
  return best;
}
function vramFromName(name) {
  const s = String(name || '');
  for (const [re, gb] of GPU_TABLE) if (re.test(s)) return gb * GB;
  return 0;
}
function isIntegrated(name) { return INTEGRATED_RE.test(String(name || '')); }

function roundPts(v) {
  if (!(v > 0)) return 0;
  const step = v >= 100e6 ? 10e6 : v >= 10e6 ? 1e6 : 100000;
  return Math.max(step, Math.floor(v / step) * step);
}
/*
 * Рекомендация: видеокарте — не больше 30 % свободной видеопамяти (наибольшее надёжное — 42 %), окну — не больше половины
 * свободной оперативной памяти за вычетом 2 ГБ на систему (наибольшее — 3/4). Встроенная графика делит оперативную память: ей — не больше
 * четверти оперативной памяти. Неизвестная видеокарта — считаем 4 ГБ.
 */
function recommend(info) {
  info = info || {};
  const notes = [];
  let vramTotal = num(info.vramTotal), vramFree = num(info.vramFree);
  const ramTotal = num(info.ramTotal), ramFree0 = num(info.ramFree) || ramTotal * 0.5;
  const integrated = !!info.integrated;
  if (integrated) { const shared = ramTotal ? Math.min(ramTotal / 4, 8 * GB) : 2 * GB; if (!vramTotal || vramTotal < shared) vramTotal = shared; notes.push('встроенная графика: видеопамять — часть оперативной'); }
  if (!vramTotal) { vramTotal = 4 * GB; notes.push('видеопамять не определена — принято 4 ГБ'); }
  if (!vramFree || vramFree > vramTotal) vramFree = Math.max(vramTotal * 0.5, vramTotal - 1.2 * GB);
  const ramFree = Math.max(0.5 * GB, ramFree0 - 2 * GB);
  // ревизия 37: по опыту (RTX 5070 12 ГБ: 220 млн работает, 430 млн — сброс изображения) — видеокарте не больше 30 % свободной
  // видеопамяти рекомендовано и 42 % наибольшее: Windows (ANGLE/Direct3D) держит копии буферов и сбрасывает долгие кадры
  const gpuRec = vramFree * 0.3 / GPU_BYTES_PER_POINT, gpuMax = vramFree * 0.42 / GPU_BYTES_PER_POINT;
  const resetAt = num(info.gpuResetAt);
  const ramRec = ramFree * 0.5 / RAM_BYTES_PER_POINT, ramMax = ramFree * 0.75 / RAM_BYTES_PER_POINT;
  const limitedBy = gpuRec <= ramRec ? 'gpu' : 'ram';
  // встроенной графике много точек не по силам и по скорости: не больше 50 млн рекомендовано и 100 млн наибольшее
  const capRec = integrated ? 50e6 : 1.5e9, capMax = integrated ? 100e6 : 2e9;
  let points = roundPts(Math.min(gpuRec, ramRec, capRec)), safeMax = Math.max(points, roundPts(Math.min(gpuMax, ramMax, capMax)));
  if (resetAt >= 1e6) { safeMax = Math.min(safeMax, roundPts(resetAt * 0.7)); points = Math.min(points, roundPts(resetAt * 0.5)); notes.push('видеокарта сбрасывала изображение при ' + Math.round(resetAt / 1e6) + ' млн точек — пределы снижены'); }
  return { points, safeMax, minimum: 1000000, perPointGpu: GPU_BYTES_PER_POINT, perPointRam: RAM_BYTES_PER_POINT, limitedBy,
    vramTotal, vramFree, ramTotal, ramFree: ramFree0, notes };
}

function run(execFile, cmd, args, ms) {
  return new Promise((resolve) => {
    try {
      const ch = execFile(cmd, args, { timeout: ms || 3000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
      if (ch && ch.on) ch.on('error', () => resolve(''));
    } catch (_) { resolve(''); }
  });
}

async function probe(env) {
  env = env || {};
  const os = env.os || require('os');
  const execFile = env.execFile || require('child_process').execFile;
  const platform = env.platform || process.platform;
  const ram = { total: os.totalmem(), free: os.freemem() };
  const cpus = (os.cpus && os.cpus()) || [];
  const cpu = { model: cpus[0] ? String(cpus[0].model || '').trim() : '', cores: cpus.length };
  const gpu = { name: '', vendor: '', vramTotal: 0, vramFree: 0, source: '', integrated: false };
  // 1) название из Chromium (app.getGPUInfo)
  try {
    if (env.app && typeof env.app.getGPUInfo === 'function') {
      const gi = await Promise.race([env.app.getGPUInfo('basic'), new Promise(r => setTimeout(() => r(null), 2500))]);
      const dev = gi && Array.isArray(gi.gpuDevice) ? (gi.gpuDevice.find(d => d && d.active) || gi.gpuDevice[0]) : null;
      const aux = gi && gi.auxAttributes ? gi.auxAttributes : {};
      if (dev) gpu.vendor = ({ 0x10de: 'NVIDIA', 0x1002: 'AMD', 0x8086: 'Intel', 0x106b: 'Apple' })[dev.vendorId] || '';
      gpu.name = String(aux.glRenderer || dev && dev.deviceString || '').replace(/^ANGLE \((.*)\)$/i, '$1');
    }
  } catch (_) {}
  if (env.rendererName && !gpu.name) gpu.name = String(env.rendererName);
  // 2) NVIDIA — точная видеопамять и занятость
  const smi = parseNvidiaSmi(await run(execFile, 'nvidia-smi', ['--query-gpu=memory.total,memory.used,name', '--format=csv,noheader,nounits'], 3000));
  if (smi) { gpu.vramTotal = smi.vramTotal; gpu.vramFree = smi.vramFree; gpu.source = 'nvidia-smi'; gpu.vendor = 'NVIDIA'; if (smi.name) gpu.name = smi.name; }
  // 3) Windows — объём видеопамяти любого производителя из реестра драйвера
  if (!gpu.vramTotal && platform === 'win32') {
    const txt = await run(execFile, 'reg', ['query', 'HKLM\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}', '/s', '/v', 'HardwareInformation.qwMemorySize'], 4000);
    const r = parseRegMemory(txt); if (r) { gpu.vramTotal = r.vramTotal; gpu.source = 'реестр Windows'; if (r.name && !gpu.name) gpu.name = r.name; }
  }
  // 4) Linux/AMD — sysfs
  if (!gpu.vramTotal && platform === 'linux') {
    try {
      const fs = require('fs');
      for (const c of fs.readdirSync('/sys/class/drm')) {
        if (!/^card\d+$/.test(c)) continue;
        const t = Number(fs.readFileSync('/sys/class/drm/' + c + '/device/mem_info_vram_total', 'utf8'));
        let u = 0; try { u = Number(fs.readFileSync('/sys/class/drm/' + c + '/device/mem_info_vram_used', 'utf8')); } catch (_) {}
        if (t > gpu.vramTotal) { gpu.vramTotal = t; gpu.vramFree = u > 0 ? t - u : 0; gpu.source = 'sysfs'; }
      }
    } catch (_) {}
  }
  // 5) по названию
  if (!gpu.vramTotal) { const v = vramFromName(gpu.name); if (v) { gpu.vramTotal = v; gpu.source = 'таблица видеокарт'; } }
  gpu.integrated = !smi && (isIntegrated(gpu.name) || platform === 'darwin' && /apple/i.test(gpu.name + ' ' + cpu.model));
  const recommendation = recommend({ vramTotal: gpu.vramTotal, vramFree: gpu.vramFree, ramTotal: ram.total, ramFree: ram.free, integrated: gpu.integrated });
  return { ok: true, ram, gpu, cpu, recommendation, at: Date.now() };
}

module.exports = { probe, recommend, parseNvidiaSmi, parseRegMemory, vramFromName, isIntegrated, GPU_BYTES_PER_POINT, RAM_BYTES_PER_POINT };
