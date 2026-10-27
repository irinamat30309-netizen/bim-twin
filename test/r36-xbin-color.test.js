'use strict';
// Ревизия 36: облако из .xbin — серое (в RGB яркость отражения лидара) и загружено меньше выбранного (375 из 439 млн).
// 1) С фильтром окна «Перед загрузкой» (шум, область, высоты) доля точек подстраивается после каждой части — загружается выбранное число.
// 2) Цвет по фото камер: при сборке облака из .xbin и кнопкой для уже собранного облака (новый LAS «…-color.las»).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const Seg = require('../cloud-segments.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r36-color-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

// LAS 1.2 формат 2: плотные скопления по 10 точек (проходят фильтр шума) и одиночные точки (шум) вперемешку
function writeNoisyLas(file, n, rgb) {
  const H = 227, rec = 26, hd = Buffer.alloc(H); hd.write('LASF', 0); hd.writeUInt8(1, 24); hd.writeUInt8(2, 25); hd.writeUInt16LE(H, 94); hd.writeUInt32LE(H, 96);
  hd.writeUInt8(2, 104); hd.writeUInt16LE(rec, 105); hd.writeUInt32LE(n, 107);
  const sc = 0.001; hd.writeDoubleLE(sc, 131); hd.writeDoubleLE(sc, 139); hd.writeDoubleLE(sc, 147);
  const body = Buffer.alloc(n * rec), mn = [1e18, 1e18, 1e18], mx = [-1e18, -1e18, -1e18];
  let dense = 0, noise = 0, real = 0;
  for (let i = 0; i < n; i++) {
    const q = i % 14; let w;
    if (q < 10) { const c = Math.floor(dense / 10), j = dense % 10; dense++; real++; w = [(c % 200) * 0.5 + 0.25 + j * 0.002, Math.floor(c / 200) * 0.5 + 0.25, 1.25 + j * 0.001]; }
    else { const k = noise++; w = [(k % 300) * 1.3 + 0.65 + 150, Math.floor(k / 300) * 1.3 + 0.65, 7.65]; }
    for (let k = 0; k < 3; k++) { if (w[k] < mn[k]) mn[k] = w[k]; if (w[k] > mx[k]) mx[k] = w[k]; }
    const b = i * rec; body.writeInt32LE(Math.round(w[0] / sc), b); body.writeInt32LE(Math.round(w[1] / sc), b + 4); body.writeInt32LE(Math.round(w[2] / sc), b + 8);
    body.writeUInt16LE((i * 37) % 60000, b + 12);
    const g = (i * 97) % 65536; const c3 = rgb ? [(i * 11) % 65536, (i * 13) % 65536, (i * 17) % 65536] : [g, g, g];
    body.writeUInt16LE(c3[0], b + 20); body.writeUInt16LE(c3[1], b + 22); body.writeUInt16LE(c3[2], b + 24);
  }
  hd.writeDoubleLE(mx[0], 179); hd.writeDoubleLE(mn[0], 187); hd.writeDoubleLE(mx[1], 195); hd.writeDoubleLE(mn[1], 203); hd.writeDoubleLE(mx[2], 211); hd.writeDoubleLE(mn[2], 219);
  fs.writeFileSync(file, Buffer.concat([hd, body]));
  return { dense: real, noise };
}

// так же, как bim:cloudPartsOpen/bim:cloudPartsRead в main.js: части по очереди, доля следующей — по статистике прочитанных
function loadParts(d, filter, budget, est, adaptive) {
  const nParts = Math.ceil(d.count / d.segPoints), bi = { budget, est, src: 0, passed: 0, kept: 0, next: 0 };
  const ratio0 = budget > 0 && est > budget ? budget / est : 1;
  let kept = 0, passed = 0;
  for (let k = 0; k < nParts; k++) {
    const from = k * d.segPoints, count = Math.min(d.segPoints, d.count - from);
    const fil = Object.assign({}, filter, { ratio: adaptive ? Seg.adaptiveRatio(bi.budget, d.count, bi.est, bi) : ratio0 });
    const res = Seg.readSegment(d, from, count, { filter: fil });
    assert.equal(res.ok, true, res.message);
    assert.equal(typeof res.passed, 'number', 'часть сообщает, сколько точек прошло фильтр');
    bi.src += count; bi.passed += res.passed; bi.kept += res.count; bi.next = k + 1;
    kept += res.count; passed += res.passed;
  }
  return { kept, passed };
}

test('r36: доля точек с фильтром шума подстраивается — загружается выбранное число точек, а не меньше', () => {
  const f = path.join(TMP, 'noisy.las'), N = 280000; const st = writeNoisyLas(f, N, true);
  const d = Seg.openSegmentSource(f, { segPoints: 40000, chunkPoints: 10000 }).desc;
  const filter = { noise: { voxel: 0.1, min: 3 } };
  const all = loadParts(d, filter, 0, N, false);
  assert.ok(all.kept > st.dense * 0.6 && all.kept <= st.dense + 10, 'фильтр шума убирает одиночные точки: ' + all.kept + ' из ' + N);
  const budget = Math.round(all.kept * 0.6);
  // оценка карты не знает про шум (как у пользователя: 671,8 млн в файле, выбрано 439 млн → загружено 375 млн)
  const old = loadParts(d, filter, budget, N, false);
  assert.ok(old.kept < budget * 0.8, 'прежняя доля по оценке: ' + old.kept + ' из ' + budget);
  const now = loadParts(d, filter, budget, N, true);
  assert.ok(Math.abs(now.kept - budget) <= budget * 0.02, 'ревизия 36: ' + now.kept + ' из ' + budget);
  // оценка завышена или занижена — результат тот же
  for (const est of [Math.round(all.kept * 0.7), N]) { const r = loadParts(d, filter, budget, est, true); assert.ok(Math.abs(r.kept - budget) <= budget * 0.02, 'оценка ' + est + ': ' + r.kept); }
  // бюджет больше, чем проходит фильтр, — все прошедшие точки
  const big = loadParts(d, filter, N * 2, N, true);
  assert.equal(big.kept, all.kept);
});

test('r36: adaptiveRatio — первая часть по оценке, дальше по факту; набранный бюджет — почти ничего', () => {
  assert.equal(Seg.adaptiveRatio(0, 1000, 500, null), 1, 'без предела — все точки');
  assert.ok(Math.abs(Seg.adaptiveRatio(100, 1000, 400, { src: 0 }) - 0.25) < 1e-12, 'первая часть: бюджет / оценка');
  assert.equal(Seg.adaptiveRatio(500, 1000, 400, { src: 0 }), 1, 'оценка меньше бюджета — доля 1');
  // прочитано 400 из 1000, прошло фильтр 200 (50 %), взято 60 → осталось набрать 40 из 300 доступных
  assert.ok(Math.abs(Seg.adaptiveRatio(100, 1000, 400, { src: 400, passed: 200, kept: 60 }) - 40 / 300) < 1e-12);
  assert.ok(Seg.adaptiveRatio(100, 1000, 400, { src: 400, passed: 200, kept: 100 }) < 1e-6, 'бюджет набран');
  assert.equal(Seg.adaptiveRatio(100, 1000, 400, { src: 400, passed: 0, kept: 0 }), 1, 'ничего не прошло — доля 1');
  const r = Seg.filterSegment({ ok: true, count: 3000, chunkPoints: 1000, pos: new Float32Array(9000).map((_, i) => (i % 3) * 0.001 + Math.floor(i / 3) * 0.0001), col: new Uint8Array(9000) }, { noise: null, ratio: 0.5 });
  assert.equal(r.passed, 3000); assert.equal(r.count, 1500);
});

test('r36: серое облако распознаётся (R = G = B — яркость лидара), цветное — нет', () => {
  const src = read('renderer/lixel-cloud-ui.js');
  const m = src.match(/function isGrayColors\(col, n\) \{[\s\S]*?\n  \}\n/); assert.ok(m, 'isGrayColors в lixel-cloud-ui.js');
  const isGray = new Function(m[0] + '; return isGrayColors;')();
  const n = 50000, g = new Uint8Array(n * 3), c = new Uint8Array(n * 3), f = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const v = (i * 37) % 256; g[i * 3] = g[i * 3 + 1] = g[i * 3 + 2] = v; c[i * 3] = v; c[i * 3 + 1] = (v * 3) % 256; c[i * 3 + 2] = 255 - v; f[i * 3] = f[i * 3 + 1] = v / 255; f[i * 3 + 2] = (v + 1) / 255; }
  assert.equal(isGray(g, n), true, 'серое Uint8'); assert.equal(isGray(f, n), true, 'серое Float (±1/255)'); assert.equal(isGray(c, n), false, 'цветное');
  for (let i = 0; i < n; i += 20) { g[i * 3] = 200; g[i * 3 + 1] = 40; }   // 5 % цветных точек — облако уже не серое
  assert.equal(isGray(g, n), false);
  assert.equal(isGray(null, 10), false); assert.equal(isGray(new Uint8Array(9), 3), false, 'слишком мало точек');
  // серое облако из LAS читается с одинаковыми каналами
  const fl = path.join(TMP, 'gray.las'); writeNoisyLas(fl, 20000, false);
  const d = Seg.openSegmentSource(fl, { segPoints: 20000, chunkPoints: 10000 }).desc, r = Seg.readSegment(d, 0, 20000);
  assert.equal(isGray(r.col, r.count), true);
  assert.match(src, /Раскрасить по фото камер/); assert.match(src, /__bimPhotoColor/);
});

test('r36: цвет по фото — результат пишется во временную папку и переименовывается; при отмене и ошибке исходник не тронут', async () => {
  const src = read('main.js');
  const need = src.match(/function photoColorNeed\([\s\S]*?\n/)[0], fn = src.match(/  async function photoColorLas\([\s\S]*?\n  \}\n/)[0];
  const make = (stub) => new Function('fs', 'path', 'require', 'runPhotoRecolor', need + fn + '; return { photoColorLas, photoColorNeed };')(fs, path, (m) => require(path.join(ROOT, m)), stub);
  const las = path.join(TMP, 'cloud.las'); writeNoisyLas(las, 5000, false);
  const orig = fs.readFileSync(las);
  let seen = null;
  const ok = make(async (cfg, onProg) => { seen = cfg; onProg(0.5, 'кадры'); fs.writeFileSync(cfg.dst, Buffer.from('COLORED')); return { ok: true, stats: { points: 5000, colored: 4500, frames: 12, cameras: 2, ms: 1500 } }; });
  assert.ok(ok.photoColorNeed(1e9, 3e7) > 1e9 * 1.05 + 6e8, 'место: облако + 21 байт на точку');
  const prog = [];
  const dst = path.join(TMP, 'cloud-color.las');
  const r = await ok.photoColorLas(las, dst, '/x/scan.xbin', 'poses', (f, l) => prog.push([f, l]), { cancelled: false });
  assert.equal(r.ok, true); assert.equal(fs.readFileSync(dst, 'utf8'), 'COLORED'); assert.deepEqual(fs.readFileSync(las), orig, 'исходник не меняется');
  assert.equal(seen.src, las); assert.equal(seen.xbin, '/x/scan.xbin'); assert.equal(seen.posesText, 'poses'); assert.deepEqual(prog, [[0.5, 'кадры']]);
  assert.equal(r.stats.colored, 4500);
  // dst === src (сборка из .xbin: серое облако заменяется цветным)
  const same = path.join(TMP, 'same.las'); fs.copyFileSync(las, same);
  assert.equal((await ok.photoColorLas(same, same, 'x.xbin', 'p', () => {}, {})).ok, true); assert.equal(fs.readFileSync(same, 'utf8'), 'COLORED');
  // отмена
  const cancel = make(async (cfg) => { fs.writeFileSync(cfg.dst, 'half'); return { ok: false, cancelled: true }; });
  const c = await cancel.photoColorLas(las, las, 'x', 'p', () => {}, {}); assert.equal(c.cancelled, true); assert.deepEqual(fs.readFileSync(las), orig);
  // ни одна точка не получила цвет — ошибка, файл не заменяется
  const none = make(async (cfg) => { fs.writeFileSync(cfg.dst, 'gray'); return { ok: true, stats: { points: 5000, colored: 0 } }; });
  const z = await none.photoColorLas(las, las, 'x', 'p', () => {}, {}); assert.equal(z.ok, false); assert.equal(z.error, 'photo_none'); assert.deepEqual(fs.readFileSync(las), orig);
  // сбой декодера
  const bad = make(async () => ({ ok: false, error: 'WebCodecs недоступен' }));
  const b = await bad.photoColorLas(las, las, 'x', 'p', () => {}, {}); assert.equal(b.ok, false); assert.match(b.message, /WebCodecs/);
  assert.deepEqual(fs.readdirSync(TMP).filter(x => x.startsWith('.bimtwin-color-')), [], 'временные папки удалены');
});

test('r36: проводка — сборка из .xbin с цветом, кнопка «Раскрасить по фото камер», адаптивная доля в чтении частей', () => {
  const main = read('main.js'), pre = read('preload.js'), app = read('renderer/app.js'), cmd = read('renderer/ui/commands.js'), ext = read('renderer/lixel-tools-ext.js');
  assert.match(main, /ipcMain\.handle\('bim:photoColorCloud'/); assert.match(main, /ipcMain\.on\('bim:cancelPhotoColor'/);
  assert.match(main, /const photo = a\.color !== 'gray' && !!\(info\.xbin && info\.xbin\.photoReady\)/);
  assert.match(main, /photoColorLas\(target, target, abs, posesText/);
  assert.match(main, /ss\.filter\.ratio = cloudSegments\.adaptiveRatio\(bi\.budget, d\.count, bi\.est, bi\)/);
  assert.match(main, /bi\.passed \+= Number\(res\.passed\)/);
  assert.match(main, /'bim:photoColorProgress'/);
  assert.match(pre, /color: opts && opts\.color === 'gray' \? 'gray' : 'photo'/);
  for (const k of ['photoColorCloud:', 'onPhotoColorProgress:', 'cancelPhotoColor:', "'bim:photoColorProgress'", "'bim:cancelPhotoColor'"]) assert.ok(pre.includes(k), 'preload: ' + k);
  assert.match(app, /API\.xbinBuildCloud\(p, jobId, density, \{ refine, color(, edge)? \}\)/);   // ревизия 37: + фильтр краёв
  assert.match(app, /window\.__bimPhotoColor = async function/);
  assert.match(app, /r\.needXbin && typeof API\.pickXbin/); assert.match(app, /r\.needPoses && typeof API\.pickTrajectory/);
  assert.match(app, /'Настоящий, по фото камер \(дольше\)'/); assert.match(app, /'Серый, яркость лидара \(быстро\)'/);
  assert.match(cmd, /I\('opPhotoColor', 'camera', 'Цвет по фото камер'/);
  assert.match(ext, /opPhotoColor: opPhotoColor/);
});

test('r36: поток чтения части возвращает passed (без него доля не подстраивается)', async () => {
  const f = path.join(TMP, 'w.las'); writeNoisyLas(f, 30000, true);
  const d = Seg.openSegmentSource(f, { segPoints: 30000, chunkPoints: 10000 }).desc;
  const r = await Seg.readSegmentAsync(d, 0, 30000, { filter: { noise: { voxel: 0.1, min: 3 }, ratio: 0.5 } });
  assert.equal(r.ok, true, r.message); assert.equal(typeof r.passed, 'number'); assert.ok(r.passed > r.count && r.count > 0);
});
