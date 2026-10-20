'use strict';
// Ревизия 26: облако крупнее, чем видеокарта показывает надёжно (670 млн точек «Все точки» из .xbin — белый экран), читается равномерной
// выборкой: из каждого перемешанного кирпича берутся первые keepPer точек. Сброс видеокарты ловится, предел уменьшается вдвое.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const Seg = require('../cloud-segments.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r26-gpu-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

function writeLas(file, n) {
  const H = 227, rec = 26, hd = Buffer.alloc(H); hd.write('LASF', 0); hd.writeUInt8(1, 24); hd.writeUInt8(2, 25); hd.writeUInt16LE(H, 94); hd.writeUInt32LE(H, 96);
  hd.writeUInt8(2, 104); hd.writeUInt16LE(rec, 105); hd.writeUInt32LE(n, 107);
  const sc = 0.001; hd.writeDoubleLE(sc, 131); hd.writeDoubleLE(sc, 139); hd.writeDoubleLE(sc, 147);
  const body = Buffer.alloc(n * rec), mn = [1e18, 1e18, 1e18], mx = [-1e18, -1e18, -1e18];
  for (let i = 0; i < n; i++) {
    const w = [(i % 300) * 0.05, Math.floor(i / 300) * 0.04, ((i * 7) % 113) * 0.03];
    const X = Math.round(w[0] / sc), Y = Math.round(w[1] / sc), Z = Math.round(w[2] / sc);
    for (let k = 0; k < 3; k++) { if (w[k] < mn[k]) mn[k] = w[k]; if (w[k] > mx[k]) mx[k] = w[k]; }
    const b = i * rec; body.writeInt32LE(X, b); body.writeInt32LE(Y, b + 4); body.writeInt32LE(Z, b + 8); body.writeUInt16LE((i * 37) % 60000, b + 12); body[b + 15] = i % 7;
    body.writeUInt16LE((i * 11) % 65536, b + 20); body.writeUInt16LE((i * 13) % 65536, b + 22); body.writeUInt16LE((i * 17) % 65536, b + 24);
  }
  hd.writeDoubleLE(mx[0], 179); hd.writeDoubleLE(mn[0], 187); hd.writeDoubleLE(mx[1], 195); hd.writeDoubleLE(mn[1], 203); hd.writeDoubleLE(mx[2], 211); hd.writeDoubleLE(mn[2], 219);
  fs.writeFileSync(file, Buffer.concat([hd, body]));
}

test('r26: предел точек — 670 млн точек при пределе 300 млн дают не больше 300 млн на экране, малые облака не трогаются', () => {
  const CH = 1000000, N = 671798156, B = 300000000;
  const k = Seg.keepPerForBudget(N, CH, B), shown = Seg.thinnedCount(N, CH, k);
  assert.ok(k < CH && k > 400000, 'keepPer ' + k);
  assert.ok(shown <= B && shown > B * 0.998, 'на экране ' + shown);
  assert.equal(Seg.keepPerForBudget(175600000, CH, B), CH, 'облако меньше предела читается целиком');
  assert.equal(Seg.thinnedCount(175600000, CH, CH), 175600000);
  assert.equal(Seg.keepPerForBudget(N, CH, 0), CH, 'без предела — все точки');
  assert.equal(Seg.keepPerForBudget(5e9, CH, 1e6), 1000, 'не меньше 1000 точек на кирпич (наименьший кирпич окна)');
  assert.equal(Seg.thinnedCount(2500, 1000, 400), 400 + 400 + 200, 'неполный последний кирпич — пропорционально');
});

test('r26: равномерная выборка части — подмножество точек файла, рамки кирпичей верны, атрибуты на своих местах, поток чтения даёт то же', async () => {
  const f = path.join(TMP, 'a.las'), N = 47000, CH = 10000, SEG = 30000, KP = 3000; writeLas(f, N);
  const d = Seg.openSegmentSource(f, { segPoints: SEG, chunkPoints: CH }).desc;
  for (const [from, cnt] of [[0, SEG], [SEG, N - SEG]]) {
    const full = Seg.readSegment(d, from, cnt), thin = Seg.readSegment(d, from, cnt, { keepPer: KP });
    assert.equal(full.ok && thin.ok, true);
    assert.equal(thin.count, Seg.thinnedCount(cnt, CH, KP)); assert.equal(thin.chunkPoints, KP); assert.equal(thin.sourceCount, cnt);
    assert.deepEqual(Array.from(thin.chunkBoxes), Array.from(full.chunkBoxes), 'рамки кирпичей прежние');
    const nc = Math.ceil(cnt / CH); assert.equal(Math.ceil(thin.count / KP), nc, 'тот же число кирпичей');
    const key = (P, i) => P[i * 3] + ',' + P[i * 3 + 1] + ',' + P[i * 3 + 2];
    for (let c = 0; c < nc; c++) {
      const cn = Math.min(CH, cnt - c * CH), k = Math.min(KP, thin.count - c * KP), m = new Map();
      for (let i = c * CH; i < c * CH + cn; i++) m.set(key(full.pos, i), i);
      for (let j = c * KP; j < c * KP + k; j++) {
        const i = m.get(key(thin.pos, j)); assert.ok(i !== undefined, 'точка выборки есть в файле');
        for (let q = 0; q < 3; q++) { assert.equal(thin.col[j * 3 + q], full.col[i * 3 + q]); const v = thin.pos[j * 3 + q]; assert.ok(v >= thin.chunkBoxes[c * 6 + q] && v <= thin.chunkBoxes[c * 6 + 3 + q]); }
        assert.equal(thin.intensity[j], full.intensity[i]); assert.equal(thin.classification[j], full.classification[i]);
      }
    }
    // равномерность: средняя точка выборки — как у всего сегмента
    for (let q = 0; q < 3; q++) {
      let a = 0, b = 0; for (let i = 0; i < cnt; i++) a += full.pos[i * 3 + q]; for (let j = 0; j < thin.count; j++) b += thin.pos[j * 3 + q];
      a /= cnt; b /= thin.count; assert.ok(Math.abs(a - b) < 0.35, 'ось ' + q + ': ' + a.toFixed(3) + ' vs ' + b.toFixed(3));
    }
    const asy = await Seg.readSegmentAsync(d, from, cnt, { keepPer: KP });
    assert.equal(asy.ok, true); assert.equal(asy.count, thin.count); assert.deepEqual(Array.from(asy.pos.subarray(0, 300)), Array.from(thin.pos.subarray(0, 300)));
  }
  assert.equal(Seg.thinSegment(Seg.readSegment(d, 0, SEG), CH).count, SEG, 'keepPer = кирпич — без изменений');
});

test('r26: сброс видеокарты — отрисовка останавливается, окно получает одно событие с числом точек и путём файла', () => {
  const { Viewer3DGL } = require('../renderer/webgl-viewer.js');
  const events = [], prevWin = globalThis.window, prevCE = globalThis.CustomEvent;
  globalThis.window = { dispatchEvent(e) { events.push(e); } };
  globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
  try {
    const v = Object.create(Viewer3DGL.prototype); let frames = 0, prevented = 0;
    v._queueFrame = () => { frames++; };
    v.base = [{ points: true, _stream: { total: 300 }, _gpuCount: 300000000, count: 300000000 }];
    v._cloudRecord = { sourceName: 'D:/scan/x-lidar.las', sourceCount: 671798156, loadedCount: 300000000 };
    v.render(); assert.equal(frames, 1);
    assert.equal(v._onGlLost({ preventDefault() { prevented++; } }), true);
    assert.equal(prevented, 1, 'preventDefault — чтобы браузер мог восстановить контекст');
    assert.equal(events.length, 1); assert.equal(events[0].type, 'bim-gl-lost');
    assert.deepEqual(events[0].detail, { loaded: 300000000, total: 671798156, path: 'D:/scan/x-lidar.las', streaming: true });
    v.render(); assert.equal(frames, 1, 'после сброса кадры не рисуются');
    assert.equal(v._onGlLost({}), false); assert.equal(events.length, 1, 'повторное событие не шлётся');
  } finally { globalThis.window = prevWin; globalThis.CustomEvent = prevCE; }
});

test('r26: связка — предел из окна в main, выборка в потоке чтения, число точек файла в панели, сброс видеокарты в окне', () => {
  const m = read('main.js'), pl = read('preload.js'), a = read('renderer/app.js'), v = read('renderer/webgl-viewer.js'), ui = read('renderer/lixel-cloud-ui.js'), w = read('cloud-segment-worker.js'), s = read('cloud-segments.js');
  const h = m.slice(m.indexOf("ipcMain.handle('bim:cloudPartsOpen'"), m.indexOf("ipcMain.handle('bim:readCloudChunk'"));
  assert.match(h, /keepPerForBudget\(d\.count, d\.chunkPoints, gpuBudget\)/); assert.match(h, /total: shown, sourceTotal: d\.count/);
  assert.match(h, /readSegmentAsync\(d, from, count, \{ signal: ss\.controller\.signal, keepPer: ss\.keepPer \}\)/);
  assert.match(pl, /cloudPartsOpen: \(p, jobId, opts\) => inv\('bim:cloudPartsOpen', \{ path: p, jobId, maxPoints:/);
  assert.match(w, /keepPer: d\.keepPer/); assert.match(s, /keepPer: Math\.floor\(Number\(opts\.keepPer\) \|\| 0\)/);
  assert.match(a, /const GPU_POINT_BUDGET = 300000000;/); assert.match(a, /localStorage\.getItem\('bim\.gpuPointBudget'\)/);
  assert.match(a, /API\.cloudPartsOpen\(filePath, makeCloudParseJobId\(\), \{ maxPoints: gpuPointBudget\(\) \}\)/);
  assert.match(a, /sourceTotal: opened\.sourceTotal \|\| total/);
  assert.match(a, /addEventListener\('bim-gl-lost'/); assert.match(a, /localStorage\.setItem\('bim\.gpuPointBudget'/); assert.match(a, /sessionStorage\.setItem\('bim\.reopenCloud'/); assert.match(a, /location\.reload\(\)/);
  const gl = a.slice(a.indexOf("addEventListener('bim-gl-lost'"), a.indexOf('(function setupStreamPrefs'));
  assert.ok(gl.length > 0 && gl.length < 4000, 'обработчик сброса стоит вне setupStreamPrefs (у той ранний выход)');
  assert.match(v, /addEventListener\('webglcontextlost', \(e\) => this\._onGlLost\(e\)/);
  assert.match(v, /render\(\) \{ if \(this\._glLost\) return;/);
  assert.match(v, /sourceCount: Number\.isSafeInteger\(srcTotal\) \? srcTotal : null/);
  assert.match(v, /gpuThinned:/); assert.match(ui, /info\.gpuThinned \?/);
  assert.doesNotMatch(read('renderer/lixel-cloud-ui.js') + gl, /[\u{1F300}-\u{1FAFF}]/u, 'без эмодзи');
});
