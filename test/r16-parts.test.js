'use strict';
// Ревизия 16: большие LAS/PLY читаются ЧАСТЯМИ (сегменты, ни одного массива больше сегмента), все точки — в видеопамять; «кирпичи» точек
// с рамками: вне экрана не рисуются, при движении «лишние» точки (больше K на пиксель рамки) не рисуются.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const cfg = require('../app-config.js');
const Cloud = require('../las-node.js');
const Seg = require('../cloud-segments.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r16-parts-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

function writeLas(file, n, color, fmtByte) {
  const H = 227, rec = 26, hd = Buffer.alloc(H); hd.write('LASF', 0); hd.writeUInt8(1, 24); hd.writeUInt8(2, 25); hd.writeUInt16LE(H, 94); hd.writeUInt32LE(H, 96);
  hd.writeUInt8(fmtByte || 2, 104); hd.writeUInt16LE(rec, 105); hd.writeUInt32LE(n, 107);
  const sc = 0.001; hd.writeDoubleLE(sc, 131); hd.writeDoubleLE(sc, 139); hd.writeDoubleLE(sc, 147); hd.writeDoubleLE(500000, 155); hd.writeDoubleLE(4000000, 163); hd.writeDoubleLE(100, 171);
  const body = Buffer.alloc(n * rec), mn = [1e18, 1e18, 1e18], mx = [-1e18, -1e18, -1e18];
  for (let i = 0; i < n; i++) {
    const x = 500000 + (i % 300) * 0.05 + Math.sin(i) * 0.01, y = 4000000 + Math.floor(i / 300) * 0.04, z = 100 + ((i * 7) % 113) * 0.03;
    const X = Math.round((x - 500000) / sc), Y = Math.round((y - 4000000) / sc), Z = Math.round((z - 100) / sc);
    const w = [X * sc + 500000, Y * sc + 4000000, Z * sc + 100]; for (let k = 0; k < 3; k++) { if (w[k] < mn[k]) mn[k] = w[k]; if (w[k] > mx[k]) mx[k] = w[k]; }
    const b = i * rec; body.writeInt32LE(X, b); body.writeInt32LE(Y, b + 4); body.writeInt32LE(Z, b + 8); body.writeUInt16LE((i * 37) % 60000, b + 12); body[b + 15] = i % 7;
    if (color) { body.writeUInt16LE((i * 11) % 65536, b + 20); body.writeUInt16LE((i * 13) % 65536, b + 22); body.writeUInt16LE((i * 17) % 65536, b + 24); }
  }
  hd.writeDoubleLE(mx[0], 179); hd.writeDoubleLE(mn[0], 187); hd.writeDoubleLE(mx[1], 195); hd.writeDoubleLE(mn[1], 203); hd.writeDoubleLE(mx[2], 211); hd.writeDoubleLE(mn[2], 219);
  fs.writeFileSync(file, Buffer.concat([hd, body]));
}
function writePly(file, n, up, color, ascii) {
  const hdr = ['ply', ascii ? 'format ascii 1.0' : 'format binary_little_endian 1.0', 'comment up=' + up, 'element vertex ' + n, 'property double x', 'property double y', 'property double z'];
  if (color) hdr.push('property uchar red', 'property uchar green', 'property uchar blue');
  hdr.push('property float intensity', 'property uchar classification', 'end_header\n');
  const head = Buffer.from(hdr.join('\n'), 'ascii');
  if (ascii) { const lines = []; for (let i = 0; i < n; i++) lines.push([i * 0.1, i * 0.2, i * 0.3].concat(color ? [1, 2, 3] : []).concat([0.5, 1]).join(' ')); fs.writeFileSync(file, Buffer.concat([head, Buffer.from(lines.join('\n') + '\n')])); return; }
  const rl = 24 + (color ? 3 : 0) + 4 + 1, body = Buffer.alloc(n * rl);
  for (let i = 0; i < n; i++) {
    let b = i * rl; const x = 1000 + (i % 300) * 0.05 + Math.sin(i) * 0.01, y = 2000 + Math.floor(i / 300) * 0.04, z = 5 + ((i * 7) % 113) * 0.03;
    body.writeDoubleLE(x, b); body.writeDoubleLE(y, b + 8); body.writeDoubleLE(z, b + 16); b += 24;
    if (color) { body[b] = i % 256; body[b + 1] = (i * 3) % 256; body[b + 2] = (i * 5) % 256; b += 3; }
    body.writeFloatLE((i % 1000) / 1000 * 200, b); body[b + 4] = i % 9;
  }
  fs.writeFileSync(file, Buffer.concat([head, body]));
}
const SEG = 40000, CH = 10000;
async function readAll(desc, useWorker) {
  const parts = [];
  for (let from = 0; from < desc.count; from += desc.segPoints) {
    const c = Math.min(desc.segPoints, desc.count - from);
    const r = useWorker ? await Seg.readSegmentAsync(desc, from, c) : Seg.readSegment(desc, from, c);
    assert.equal(r.ok, true, r.message); parts.push(r);
  }
  return parts;
}
// сравнение с обычным (монолитным) разбором файла: те же точки, тот же цвет/интенсивность/класс, ни одной потерянной
function compare(mono, parts, digits, tolI) {
  const key = (x, y, z) => x.toFixed(digits) + ',' + y.toFixed(digits) + ',' + z.toFixed(digits);
  const mm = new Map(); for (let i = 0; i < mono.count; i++) mm.set(key(mono.pos[i * 3], mono.pos[i * 3 + 1], mono.pos[i * 3 + 2]), i);
  let total = 0, miss = 0, badC = 0, badI = 0, badK = 0;
  for (const p of parts) for (let i = 0; i < p.count; i++) {
    total++; const j = mm.get(key(p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2])); if (j === undefined) { miss++; continue; }
    for (let k = 0; k < 3; k++) if (Math.abs(p.col[i * 3 + k] - mono.col[j * 3 + k] * 255) > 1.01) { badC++; break; }
    if (p.intensity && mono.intensity && Math.abs(p.intensity[i] / 65535 - mono.intensity[j]) > tolI) badI++;
    if (p.classification && mono.classification && p.classification[i] !== mono.classification[j]) badK++;
  }
  return { total, miss, badC, badI, badK };
}

test('конфиг: пороги чтения по частям', () => {
  assert.equal(cfg.CLOUD_PARTS_MIN_POINTS, 48000000);
  assert.equal(cfg.CLOUD_SEG_POINTS, 16000000);
  assert.equal(cfg.CLOUD_CHUNK_POINTS, 1000000);
  assert.equal(cfg.CLOUD_SEG_POINTS % cfg.CLOUD_CHUNK_POINTS, 0, 'сегмент — целое число кирпичей');
  assert.ok(cfg.CLOUD_SAMPLE_POINTS >= 1000000);
});

for (const color of [true, false]) {
  test('LAS (' + (color ? 'с цветом' : 'без цвета') + '): сегменты и кирпичи — ни одной потерянной точки, цвет/интенсивность/класс как при чтении целиком', async () => {
    const f = path.join(TMP, 'a-' + color + '.las'), N = 123456; writeLas(f, N, color);
    const mono = Cloud.parseCloudFile(f, { maxPoints: 1e9, pointShare: 1, memoryGuard: false });
    const op = Seg.openSegmentSource(f, { segPoints: SEG, chunkPoints: CH });
    assert.equal(op.ok, true); const d = op.desc;
    assert.equal(d.count, N); assert.equal(d.segPoints, SEG); assert.equal(d.chunkPoints, CH);
    assert.equal(d.hasIntensity, true); assert.equal(d.hasClassification, true);
    const parts = await readAll(d, true);
    assert.equal(parts.length, 4);
    assert.equal(parts.reduce((s, p) => s + p.count, 0), N, 'сумма частей = число точек файла');
    for (const p of parts) assert.ok(p.pos.length <= SEG * 3, 'ни одного массива больше сегмента');
    const r = compare(mono, parts, 3, 1e-4);
    assert.equal(r.total, N); assert.equal(r.miss, 0, 'потерянных/искажённых точек нет'); assert.equal(r.badC, 0); assert.equal(r.badI, 0); assert.equal(r.badK, 0);
  });
}

for (const up of ['z', 'y']) for (const color of [true, false]) {
  test('PLY бинарный (up=' + up + ', ' + (color ? 'цвет' : 'без цвета') + '): сегменты совпадают с чтением целиком', () => {
    const f = path.join(TMP, 'b-' + up + color + '.ply'), N = 98765; writePly(f, N, up, color);
    const mono = Cloud.parseCloudFile(f, { maxPoints: 1e9, pointShare: 1, memoryGuard: false });
    const op = Seg.openSegmentSource(f, { segPoints: SEG, chunkPoints: CH });
    assert.equal(op.ok, true); const d = op.desc; assert.equal(d.count, N);
    const parts = []; for (let from = 0; from < d.count; from += d.segPoints) parts.push(Seg.readSegment(d, from, Math.min(d.segPoints, d.count - from)));
    for (const p of parts) assert.equal(p.ok, true);
    const r = compare(mono, parts, 2, 2e-4);
    // ключи точек округляются до 1 см: единичные расхождения на границе округления допустимы, потерь нет
    assert.equal(r.total, N); assert.ok(r.miss <= N * 0.01, 'miss ' + r.miss); assert.equal(r.badI, 0); assert.equal(r.badK, 0);
    if (color) assert.equal(r.badC, 0);
    assert.deepEqual(d.meta.srcXform || null, mono.meta.srcXform || null, 'преобразование координат как при чтении целиком');
  });
}

test('кирпичи: рамки верны, порядок файла между кирпичами сохранён, перемешивание только ВНУТРИ кирпича', () => {
  const f = path.join(TMP, 'c.las'), N = 55555; writeLas(f, N, true);
  const d = Seg.openSegmentSource(f, { segPoints: SEG, chunkPoints: CH }).desc;
  const a = Seg.readSegment(d, SEG, N - SEG, { shuffle: false }), b = Seg.readSegment(d, SEG, N - SEG);   // второй сегмент (15 555 точек: кирпичи 10 000 и 5 555)
  assert.equal(a.ok && b.ok, true); assert.equal(a.chunkBoxes.length / 6, 2); assert.equal(b.chunkBoxes.length / 6, 2);
  assert.deepEqual(Array.from(a.chunkBoxes), Array.from(b.chunkBoxes), 'перемешивание не меняет рамки');
  let diff = 0;
  for (let c = 0; c < 2; c++) {
    const i0 = c * CH, i1 = Math.min(b.count, (c + 1) * CH), setA = new Set(), setB = new Set();
    for (let i = i0; i < i1; i++) {
      for (const [P, S] of [[a.pos, setA], [b.pos, setB]]) {
        for (let k = 0; k < 3; k++) assert.ok(P[i * 3 + k] >= b.chunkBoxes[c * 6 + k] - 1e-3 && P[i * 3 + k] <= b.chunkBoxes[c * 6 + 3 + k] + 1e-3, 'точка внутри рамки кирпича');
        S.add(P[i * 3] + ',' + P[i * 3 + 1] + ',' + P[i * 3 + 2]);
      }
      if (a.pos[i * 3] !== b.pos[i * 3] || a.pos[i * 3 + 1] !== b.pos[i * 3 + 1]) diff++;
    }
    assert.equal(setA.size, setB.size); for (const s of setA) assert.ok(setB.has(s), 'тот же набор точек в кирпиче');
  }
  assert.ok(diff > 1000, 'порядок внутри кирпича действительно перемешан (' + diff + ')');
  // общая рамка сегмента — объединение рамок кирпичей
  for (let k = 0; k < 3; k++) assert.equal(b.bbox.mn[k], Math.min(b.chunkBoxes[k], b.chunkBoxes[6 + k]));
});

test('неверные диапазоны и несовпадение начала с кирпичом отвергаются', () => {
  const f = path.join(TMP, 'd.las'); writeLas(f, 30000, false);
  const d = Seg.openSegmentSource(f, { segPoints: SEG, chunkPoints: CH }).desc;
  assert.equal(Seg.readSegment(d, 0, 40000).ok, false, 'за концом файла');
  assert.equal(Seg.readSegment(d, 5000, 10000).ok, false, 'начало не кратно кирпичу');
  assert.equal(Seg.readSegment(d, 0, 0).ok, false);
  assert.equal(Seg.readSegment(d, -10000, 10000).ok, false);
});

test('поток чтения: отмена через AbortSignal останавливает чтение (и уже отменённый сигнал тоже)', async () => {
  const f = path.join(TMP, 'e.las'), N = 400000; writeLas(f, N, true);
  const d = Seg.openSegmentSource(f, { segPoints: 400000, chunkPoints: 100000 }).desc;
  const pre = new AbortController(); pre.abort();
  const r0 = await Seg.readSegmentAsync(d, 0, N, { signal: pre.signal }); assert.equal(r0.ok, false); assert.equal(r0.cancelled, true);
  const ac = new AbortController(); const p = Seg.readSegmentAsync(d, 0, N, { signal: ac.signal }); ac.abort();
  const r1 = await p; assert.equal(r1.cancelled, true);
  const r2 = await Seg.readSegmentAsync(d, 0, N); assert.equal(r2.ok, true); assert.equal(r2.count, N);
});

test('форматы, которые читаются целиком (прежним путём): не LAS/PLY, LAZ, ASCII PLY, PLY с гранями, сжатый LAS, нет файла', () => {
  const touch = (n, s) => { const f = path.join(TMP, n); fs.writeFileSync(f, s || 'x'); return f; };
  for (const n of ['p.xyz', 'p.laz', 'p.pcd', 'p.e57', 'p.txt']) { const o = Seg.openSegmentSource(touch(n)); assert.equal(o.ok, false, n); assert.equal(o.unsupported, true, n); }
  const asc = path.join(TMP, 'asc.ply'); writePly(asc, 50, 'z', true, true); assert.equal(Seg.openSegmentSource(asc).unsupported, true, 'ASCII PLY');
  const mesh = path.join(TMP, 'mesh.ply');
  fs.writeFileSync(mesh, Buffer.concat([Buffer.from('ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n'), Buffer.alloc(3 * 12 + 1 + 12)]));
  assert.equal(Seg.openSegmentSource(mesh).unsupported, true, 'PLY с гранями');
  const lz = path.join(TMP, 'compressed.las'); writeLas(lz, 100, false, 2 | 0x80); assert.equal(Seg.openSegmentSource(lz).ok, false, 'сжатый LAS (формат точки с битом сжатия)');
  assert.equal(Seg.openSegmentSource(path.join(TMP, 'нет-такого.las')).unsupported, true);
});

// ---------- вьюер: кирпичи, отсечение, снижение точек, блокировки (без видеокарты: подставные gl и матрица) ----------
globalThis.window = globalThis.window || { dispatchEvent() {} };
const { Viewer3DGL } = require('../renderer/webgl-viewer.js');
function persp(fovDeg, aspect, near, far) { const f = 1 / Math.tan(fovDeg * Math.PI / 360), M = new Array(16).fill(0); M[0] = f / aspect; M[5] = f; M[10] = (far + near) / (near - far); M[11] = -1; M[14] = 2 * far * near / (near - far); return M; }
const boxes = (list) => { const B = new Float32Array(list.length * 6); list.forEach((b, i) => B.set(b, i * 6)); return B; };
const mkViewer = (M, W, H) => { const v = Object.create(Viewer3DGL.prototype); v.gl = { canvas: { width: W || 1000, height: H || 640 } }; v._lastVP = M; v._cullOn = true; v._moveSmart = true; v._smartK = 6; v._interacting = false; return v; };

test('рамка кирпича: вне экрана → -1; пересекает камеру → Infinity; на экране → площадь в пикселях', () => {
  const v = mkViewer(persp(60, 1000 / 640, 0.1, 1000));
  const M = v._lastVP, B = boxes([[-1, -1, -21, 1, 1, -19], [500, -1, -21, 501, 1, -19], [-1, -1, -5, 1, 1, 5], [-1, -1, 10, 1, 1, 12]]);
  const a = v._boxScreenArea(M, B, 0, 1000, 640); assert.ok(a > 100 && a < 640000, 'площадь ' + a);
  assert.equal(v._boxScreenArea(M, B, 6, 1000, 640), -1, 'правее экрана');
  assert.equal(v._boxScreenArea(M, B, 12, 1000, 640), Infinity, 'пересекает плоскость камеры — не отсекаем и не ограничиваем');
  assert.equal(v._boxScreenArea(M, B, 18, 1000, 640), -1, 'целиком за камерой');
});

test('план кадра: в покое рисуются ВСЕ точки видимых кирпичей, вне экрана — 0; при движении «лишние» точки (>6 на пиксель) отбрасываются', () => {
  const n = 1000000, M = persp(60, 1000 / 640, 0.1, 1000);
  const v = mkViewer(M); const B = boxes([[-1, -1, -21, 1, 1, -19], [500, -1, -21, 501, 1, -19], [-1, -1, -5, 1, 1, 5]]);
  const o = { _segs: [{ n: n * 3, boxes: B, chunk: n, start: 0 }], _gpuCount: n * 3, count: n * 3, _shuffled: true, _chunked: true };
  let p = v._planChunks(o, 1e12);
  assert.deepEqual(Array.from(p.takes), [n, 0, n]); assert.equal(p.visible, 2 * n); assert.equal(p.drawn, 2 * n); assert.equal(p.culled, n); assert.equal(p.total, 3 * n); assert.equal(p.chunks, 3);
  const area = v._boxScreenArea(M, B, 0, 1000, 640);
  v._interacting = true; p = v._planChunks(o, 1e12);
  assert.equal(p.takes[0], Math.max(64, Math.ceil(6 * area)), 'движение: не больше 6 точек на пиксель рамки'); assert.ok(p.takes[0] < n);
  assert.equal(p.takes[1], 0); assert.equal(p.takes[2], n, 'кирпич, пересекающий камеру, не ограничивается');
  v._moveSmart = false; p = v._planChunks(o, 1e12); assert.deepEqual(Array.from(p.takes), [n, 0, n], 'при выключенном «умном» режиме — как в покое');
  v._moveSmart = true; v._interacting = false;
  p = v._planChunks(o, n);   // бюджет «Авто»/% делится только между ВИДИМЫМИ кирпичами
  assert.equal(p.takes[0], Math.ceil(n * 0.5)); assert.equal(p.takes[2], Math.ceil(n * 0.5)); assert.equal(p.takes[1], 0);
  o._shuffled = false; p = v._planChunks(o, n); assert.equal(p.takes[0], n, 'облако без перемешивания не режется по бюджету (только отсечение)');
});

test('рисование по кирпичам: подряд идущие целиком видимые кирпичи сливаются в один вызов; невидимые пропускаются', () => {
  const v = mkViewer(persp(60, 1, 0.1, 1000)), calls = [];
  v.gl = Object.assign(v.gl, { POINTS: 0, bindVertexArray() {}, drawArrays(m, first, count) { calls.push([first, count]); } });
  v._segEnsureAttr = () => {};
  const n = 100;
  const seg = { vao: {}, n: n * 6, start: 0, chunk: n, boxes: new Float32Array(36) };
  const o = { _segs: [seg], _gpuCount: n * 6 };
  const plan = { takes: new Uint32Array([n, n, 0, n, n, 40]), drawn: n * 4 + 40, visible: n * 5 + 40, culled: n, total: n * 6, chunks: 6 };
  const dr = v._drawPointSegs(o, 0, 0, plan);
  assert.deepEqual(calls, [[0, 2 * n], [3 * n, 2 * n], [5 * n, 40]]);
  assert.equal(dr, n * 4 + 40); assert.equal(v._cullStats.calls, 3); assert.equal(v._cullStats.culled, n);
  calls.length = 0; v._drawPointSegs(o, 250, 0, null); assert.deepEqual(calls, [[0, 250]], 'без плана — прежний порядок (первые dc точек)');
});

test('координаты точки по номеру читаются из нужного буфера видеопамяти (измерения по GPU-выбору)', () => {
  const v = mkViewer(persp(60, 1, 0.1, 100)); const reads = [];
  v.gl = Object.assign(v.gl, { ARRAY_BUFFER: 1, bindBuffer(t, b) { this._b = b; }, getBufferSubData(t, off, out) { reads.push([this._b.id, off]); out[0] = this._b.id; out[1] = off; out[2] = 7; } });
  const bo = { _segs: [{ pb: { id: 1 }, start: 0, n: 100 }, { pb: { id: 2 }, start: 100, n: 100 }] };
  assert.deepEqual(v._segPointAt(bo, 150), [2, 50 * 12, 7]); assert.deepEqual(v._segPointAt(bo, 5), [1, 60, 7]);
  assert.equal(v._segPointAt(bo, 500), null); assert.equal(v._segPointAt(bo, -1), null);
});

test('облако по частям: правка/выделение/чистка не падают, дают нейтральный результат и одно сообщение за 3 с', () => {
  const events = []; const prevWin = globalThis.window;
  globalThis.window = { dispatchEvent(e) { events.push(e.detail && e.detail.what); }, PCEdit: null };
  globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
  try {
    const v = Object.create(Viewer3DGL.prototype); v.base = [{ points: true, _stream: { total: 5 }, pos: new Float32Array(3), _segs: [] }];
    assert.equal(v.isStreamedCloud(), true);
    assert.equal(v.selectBox([0, 0, 0], [1, 1, 1]), 0); assert.equal(v.selectSphere([0, 0, 0], 1), 0); assert.equal(v.magicWandAt(1, 1), 0);
    assert.equal(v.deleteSelection(), 0); assert.equal(v.cropToSelection(), 0); assert.equal(v.cleanAutoInApp({}), 0); assert.equal(v.cleanSORInApp({}), 0);
    assert.equal(v.noiseFilterInApp({}), 0); assert.equal(v.voxelDownsampleInApp({}), 0); assert.equal(v.sliceKeepInApp({}), 0);
    assert.equal(v.classifyInApp({}), null); assert.equal(v.extractSelectionAsObject('x'), null); assert.deepEqual(v.detectFloorWalls({}), []);
    assert.equal(v.undoEdit(), false); assert.equal(v.applyClassificationLabels([1], 1), false); assert.equal(v.assignClassificationInApp(2).ok, false);
    assert.equal(v._gpuVisibleSet({ x: 0, y: 0, w: 5, h: 5 }), null);
    assert.equal(events.length, 1, 'сообщение не чаще раза в 3 с (' + events.length + ')');
    v._streamBlockAt = 0; v.selectBox([0, 0, 0], [1, 1, 1]); assert.equal(events.length, 2);
    // обычное облако — прежнее поведение (оригинальные методы)
    const v2 = Object.create(Viewer3DGL.prototype); v2.base = [{ points: true, pos: new Float32Array(3) }];
    assert.equal(v2.isStreamedCloud(), false); assert.equal(v2.selectBox([0, 0, 0], [1, 1, 1]), 0);
    assert.equal(events.length, 2, 'у обычного облака сообщения нет');
  } finally { globalThis.window = prevWin; }
});

// ---------- исходники: IPC, окно, сборка ----------
test('main/preload: чтение по частям — IPC с проверкой пути, сессией, отменой, потоком чтения', () => {
  const m = read('main.js'), pl = read('preload.js');
  assert.match(m, /require\('\.\/cloud-segments'\)/);
  const h = m.slice(m.indexOf("ipcMain.handle('bim:cloudPartsOpen'"), m.indexOf("ipcMain.handle('bim:readCloudChunk'"));
  assert.match(h, /resolveAuthorizedFile\(event, requested, CLOUD_EXT_ALLOW\)/, 'путь проходит ту же проверку доступа, что и обычное открытие');
  assert.match(h, /openSegmentSource\(abs\)/); assert.match(h, /CLOUD_PARTS_MIN_POINTS/); assert.match(h, /unsupported: true/);
  assert.match(h, /activeCloudParseJobs\.set\(key/, 'сессия видна общей отмене импорта');
  assert.match(h, /readSegmentAsync\(d, from, count, \{ signal: ss\.controller\.signal(, keepPer: ss\.keepPer)? \}\)/);
  assert.match(h, /ss\.senderId !== sender\.id/, 'чужое окно сессию не читает');
  assert.match(h, /pendingClouds\.stash\(sender\.id, res/);
  assert.match(h, /bim:cloudPartsClose/); assert.match(h, /controller\.abort\(\)/);
  for (const n of ['cloudPartsOpen', 'cloudPartsRead', 'cloudPartsClose']) assert.match(pl, new RegExp(n + ':'), 'preload: ' + n);
});

test('окно: большой LAS/PLY читается частями (конвейер с предзагрузкой), без диалога про память, без видимого «потокового режима»', () => {
  const a = read('renderer/app.js');
  const t = a.slice(a.indexOf('async function tryPartsLoad'), a.indexOf('async function parseCloudWithProgressOnce'));
  assert.match(t, /API\.cloudPartsOpen\(filePath/); assert.match(t, /viewer\.beginCloudStream\(/); assert.match(t, /viewer\.addCloudStreamSegment\(res\)/); assert.match(t, /viewer\.endCloudStream\(/);
  assert.match(t, /next = readPart\(k \+ 1\)/, 'пока часть уходит в видеопамять, читается следующая');
  assert.match(t, /window\.CloudChunks\.resolve\(_rawAPI, light\)/); assert.match(t, /cloudPartsClose/); assert.match(t, /viewerLoaded: true/);
  assert.match(t, /return null;/, 'малые облака и прочие форматы — прежний путь');
  assert.match(t, /viewer\.clearCloud\(\)/, 'отмена убирает частично загруженное облако');
  assert.match(a, /const parts = await tryPartsLoad\(filePath, label, extra\); if \(parts\) return parts;/);
  assert.ok((a.match(/!pr\.viewerLoaded/g) || []).length >= 3, 'уже показанное по частям облако не грузится во второй раз');
  assert.match(a, /!\(v\.isStreamedCloud && v\.isStreamedCloud\(\)\)/, 'копия облака в RAM-кэш не делается');
  assert.match(a, /addEventListener\('bim-stream-limit'/);
  assert.ok(!/потоков[а-я]+ режим/i.test(t), 'в новом коде нет «потокового режима» для пользователя');
});

test('вьюер: код чтения по частям и защита операций, которым нужны все точки', () => {
  const w = read('renderer/webgl-viewer.js');
  for (const s of ['beginCloudStream(', 'addCloudStreamSegment(', 'endCloudStream(', 'isStreamedCloud()', '_segPointAt(', '_planChunks(', '_boxScreenArea(', '_drawPointSegs(', 'guardStreamedCloud', 'setMoveSmart(', "'bim-stream-limit'"]) assert.ok(w.includes(s), s);
  assert.match(w, /_shuffleChunks\(/);
  assert.match(w, /if \(o\._stream\) return o;/);
  assert.match(w, /bo\._stream \|\| !bo\.pos\)|bo\._lod \|\| bo\._stream\) return null|bo\._lod \|\| \(bo\._stream && bo\._stream\.cpu !== true\)\) return null/);   // r17: с копиями точек в памяти (cpu === true) выделение работает
});

test('сборка: новые файлы попадают в пакет и распаковываются (поток чтения не может жить внутри asar)', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const f of ['cloud-segments.js', 'cloud-segment-worker.js']) { assert.ok(pkg.build.files.includes(f), 'files: ' + f); assert.ok(pkg.build.asarUnpack.includes(f), 'asarUnpack: ' + f); }
  const w = read('cloud-segment-worker.js'); assert.match(w, /require\('\.\/cloud-segments'\)/);
});
