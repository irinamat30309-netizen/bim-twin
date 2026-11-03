'use strict';
// Ревизия 29: E57 читается ЧАСТЯМИ (e57-segments.js) — по указателю пакетов каждого скана, как LAS и PLY:
// части = чтение целиком (E57Core.read), поля ScaledInteger/Integer/Float, записи через границы пакетов, недействительные точки,
// сферические координаты, позы сканов, карта до загрузки и срез плана по всем точкам, фильтр окна «Перед загрузкой».
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const E57 = require(path.join(ROOT, 'e57-core.js'));
const ES = require(path.join(ROOT, 'e57-segments.js'));
const Seg = require(path.join(ROOT, 'cloud-segments.js'));
const OV = require(path.join(ROOT, 'cloud-overview.js'));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-r29e-'));

// ---------------------------------------------------------------- сборщик E57 для проверки (поля любой ширины, малые пакеты)
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function fieldBits(f) { if (f.type === 'Float') return (f.precision === 'single' ? 4 : 8) * 8; const r = f.max - f.min; if (r <= 0) return 0; let b = Math.ceil(Math.log2(r + 1)); if (Math.pow(2, b) < r + 1) b++; return b; }
function packStream(f, vals) {
  if (f.type === 'Float') {
    const bw = f.precision === 'single' ? 4 : 8, out = new Uint8Array(vals.length * bw), dv = new DataView(out.buffer);
    vals.forEach((v, i) => { if (bw === 4) dv.setFloat32(i * 4, v, true); else dv.setFloat64(i * 8, v, true); });
    return out;
  }
  const bits = fieldBits(f); if (!bits) return new Uint8Array(0);
  const bytes = []; let acc = 0n, n = 0n; const B = BigInt(bits);
  for (const raw of vals) { acc |= BigInt(raw - f.min) << n; n += B; while (n >= 8n) { bytes.push(Number(acc & 255n)); acc >>= 8n; n -= 8n; } }
  if (n > 0n) bytes.push(Number(acc & 255n));
  return Uint8Array.from(bytes);
}
function protoXml(f) {
  if (f.type === 'Float') return '<' + f.name + ' type="Float"' + (f.precision === 'single' ? ' precision="single"' : '') + '/>';
  return '<' + f.name + ' type="' + f.type + '" minimum="' + f.min + '" maximum="' + f.max + '"' + (f.type === 'ScaledInteger' ? ' scale="' + f.scale + '" offset="' + (f.offset || 0) + '"' : '') + '/>';
}
// scans: [{ name, pose:{q:[w,x,y,z],T}, fields:[...], cols:{name: values}, count, packets, extra:true (пакеты индекса и пустые), limits }]
function buildE57(scans, seed) {
  const R = rng(seed || 7), PAY = 1020, PAGE = 1024;
  const chunks = [], metas = [];
  let L = 48;
  for (const sc of scans) {
    const streams = sc.fields.map((f) => packStream(f, sc.cols[f.name]));
    const nf = streams.length, NP = sc.packets;
    // точки разреза каждого потока — случайные (записи переходят через границы пакетов, бывают пустые куски)
    const cuts = streams.map((st) => { const c = [0]; for (let p = 1; p < NP; p++) c.push(Math.floor(R() * st.length)); c.push(st.length); return c.sort((a, b) => a - b); });
    const pk = [];
    for (let p = 0; p < NP; p++) {
      const parts = streams.map((st, s) => st.subarray(cuts[s][p], cuts[s][p + 1]));
      const hl = 6 + 2 * nf, len = (hl + parts.reduce((a, x) => a + x.length, 0) + 3) & ~3;
      assert.ok(len <= 65536);
      const b = new Uint8Array(len), dv = new DataView(b.buffer);
      b[0] = 1; dv.setUint16(2, len - 1, true); dv.setUint16(4, nf, true);
      let o = hl; parts.forEach((x, s) => { dv.setUint16(6 + 2 * s, x.length, true); b.set(x, o); o += x.length; });
      pk.push(b);
      if (sc.extra && p === 1) { const ix = new Uint8Array(32); ix[0] = 0; new DataView(ix.buffer).setUint16(2, 31, true); pk.push(ix); const em = new Uint8Array(8); em[0] = 2; new DataView(em.buffer).setUint16(2, 7, true); pk.push(em); }
    }
    const secLen = 32 + pk.reduce((a, x) => a + x.length, 0);
    metas.push({ start: L, secLen });
    chunks.push({ at: L, pk });
    L += secLen;
  }
  const num = (v) => String(v);
  const xmlScans = scans.map((sc, i) => '<vectorChild type="Structure"><name type="String"><![CDATA[' + sc.name + ']]></name>' + (sc.limits || '') +
    (sc.pose ? '<pose type="Structure"><rotation type="Structure"><w type="Float">' + num(sc.pose.q[0]) + '</w><x type="Float">' + num(sc.pose.q[1]) + '</x><y type="Float">' + num(sc.pose.q[2]) + '</y><z type="Float">' + num(sc.pose.q[3]) + '</z></rotation><translation type="Structure"><x type="Float">' + num(sc.pose.T[0]) + '</x><y type="Float">' + num(sc.pose.T[1]) + '</y><z type="Float">' + num(sc.pose.T[2]) + '</z></translation></pose>' : '') +
    '<points type="CompressedVector" fileOffset="' + E57.logicalToPhysical(metas[i].start) + '" recordCount="' + (sc.declared || sc.count) + '"><prototype type="Structure">' + sc.fields.map(protoXml).join('') + '</prototype><codecs type="Vector" allowHeterogeneousChildren="1"></codecs></points></vectorChild>').join('');
  const xml = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<e57Root type="Structure"><formatName type="String"><![CDATA[ASTM E57 3D Imaging Data File]]></formatName><data3D type="Vector" allowHeterogeneousChildren="1">' + xmlScans + '</data3D></e57Root>\n', 'utf8');
  const xmlStart = L, total = xmlStart + xml.length, pages = Math.ceil(total / PAY), lg = new Uint8Array(pages * PAY), hv = new DataView(lg.buffer);
  const set64 = (o, v) => { hv.setUint32(o, v % 4294967296, true); hv.setUint32(o + 4, Math.floor(v / 4294967296), true); };
  'ASTM-E57'.split('').forEach((c, i) => { lg[i] = c.charCodeAt(0); });
  hv.setUint32(8, 1, true); set64(16, pages * PAGE); set64(24, E57.logicalToPhysical(xmlStart)); set64(32, xml.length); set64(40, PAGE);
  chunks.forEach((c, i) => { lg[c.at] = 1; set64(c.at + 8, metas[i].secLen); set64(c.at + 16, E57.logicalToPhysical(c.at + 32)); let o = c.at + 32; c.pk.forEach((b) => { lg.set(b, o); o += b.length; }); });
  lg.set(xml, xmlStart);
  const out = new Uint8Array(pages * PAGE);
  for (let p = 0; p < pages; p++) {
    out.set(lg.subarray(p * PAY, (p + 1) * PAY), p * PAGE);
    const c = E57.crc32c(out, p * PAGE, PAY), b = p * PAGE + PAY;
    out[b] = (c >>> 24) & 255; out[b + 1] = (c >>> 16) & 255; out[b + 2] = (c >>> 8) & 255; out[b + 3] = c & 255;
  }
  return out;
}

// сцена: скан A — ScaledInteger 24 и 33 бит, цвет 8 бит, интенсивность 11 бит, invalidState 2 бит, постоянное поле 0 бит, поза с поворотом;
// скан B — сферические координаты (double/single), интенсивность Float с пределами, без цвета, пакеты индекса и пустые
function mixedScene() {
  const R = rng(11), nA = 9000, nB = 5000;
  const A = { cartesianX: [], cartesianY: [], cartesianZ: [], colorRed: [], colorGreen: [], colorBlue: [], intensity: [], cartesianInvalidState: [], rowIndex: [] };
  const invA = [];
  for (let i = 0; i < nA; i++) {
    const t = i / nA * Math.PI * 2;
    A.cartesianX.push(Math.round((4 * Math.cos(t * 3) + R() * 0.01) * 1000)); A.cartesianY.push(Math.round((3 * Math.sin(t * 2)) * 1000)); A.cartesianZ.push(Math.round((R() * 2.8 - 1.2) * 1e6));
    A.colorRed.push(i % 256); A.colorGreen.push((i * 7) % 256); A.colorBlue.push((i * 13) % 256); A.intensity.push((i * 31) % 2048);
    const inv = i === 0 || i % 37 === 5 ? 1 : i % 101 === 3 ? 2 : 0; A.cartesianInvalidState.push(inv); invA.push(inv > 0); A.rowIndex.push(0);
  }
  const fA = [
    { name: 'cartesianX', type: 'ScaledInteger', min: -5000000, max: 5000000, scale: 0.001 }, { name: 'cartesianY', type: 'ScaledInteger', min: -5000000, max: 5000000, scale: 0.001 },
    { name: 'cartesianZ', type: 'ScaledInteger', min: -3000000000, max: 3000000000, scale: 0.000001 },
    { name: 'colorRed', type: 'Integer', min: 0, max: 255 }, { name: 'colorGreen', type: 'Integer', min: 0, max: 255 }, { name: 'colorBlue', type: 'Integer', min: 0, max: 255 },
    { name: 'intensity', type: 'Integer', min: 0, max: 2047 }, { name: 'cartesianInvalidState', type: 'Integer', min: 0, max: 2 }, { name: 'rowIndex', type: 'Integer', min: 0, max: 0 }];
  const B = { sphericalRange: [], sphericalAzimuth: [], sphericalElevation: [], intensity: [] };
  for (let i = 0; i < nB; i++) { B.sphericalRange.push(2 + 6 * R()); B.sphericalAzimuth.push(Math.fround(R() * 6.2 - 3.1)); B.sphericalElevation.push(Math.fround(R() * 1.2 - 0.6)); B.intensity.push(Math.fround(0.2 + 0.6 * R())); }
  const fB = [{ name: 'sphericalRange', type: 'Float' }, { name: 'sphericalAzimuth', type: 'Float', precision: 'single' }, { name: 'sphericalElevation', type: 'Float', precision: 'single' }, { name: 'intensity', type: 'Float', precision: 'single' }];
  const s5 = Math.sqrt(0.5);
  const u8 = buildE57([
    { name: 'A', count: nA, packets: 140, fields: fA, cols: A, pose: { q: [Math.cos(0.2), 0, 0, Math.sin(0.2)], T: [1000.5, 2000.25, 50] },
      limits: '<colorLimits type="Structure"><colorRedMinimum type="Integer">0</colorRedMinimum><colorRedMaximum type="Integer">255</colorRedMaximum><colorGreenMinimum type="Integer">0</colorGreenMinimum><colorGreenMaximum type="Integer">255</colorGreenMaximum><colorBlueMinimum type="Integer">0</colorBlueMinimum><colorBlueMaximum type="Integer">255</colorBlueMaximum></colorLimits><intensityLimits type="Structure"><intensityMinimum type="Integer">0</intensityMinimum><intensityMaximum type="Integer">2047</intensityMaximum></intensityLimits>' },
    { name: 'B', count: nB, packets: 33, extra: true, fields: fB, cols: B, pose: { q: [s5, s5, 0, 0], T: [1003, 2001, 51] },
      limits: '<intensityLimits type="Structure"><intensityMinimum type="Float">0</intensityMinimum><intensityMaximum type="Float">1</intensityMaximum></intensityLimits>' }], 5);
  const file = path.join(TMP, 'mixed.e57'); fs.writeFileSync(file, u8);
  const valid = invA.map((x) => !x).concat(new Array(nB).fill(true));
  return { file, u8, nA, nB, valid };
}
function refRead(file) { const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size; try { return E57.read((o, l) => { const b = Buffer.alloc(l); fs.readSync(fd, b, 0, l, o); return new Uint8Array(b.buffer, b.byteOffset, l); }, size, {}); } finally { fs.closeSync(fd); } }
function readAllParts(d, opts) {
  const pos = new Float32Array(d.count * 3), col = new Uint8Array(d.count * 3), inten = d.hasIntensity ? new Uint16Array(d.count) : null;
  for (let from = 0; from < d.count; from += d.segPoints) {
    const c = Math.min(d.segPoints, d.count - from), r = Seg.readSegment(d, from, c, Object.assign({ shuffle: false }, opts || {}));
    assert.ok(r.ok, r.message); assert.equal(r.count, c);
    // рамки кирпичей содержат свои точки
    for (let i = 0; i < c; i++) { const q = Math.floor(i / r.chunkPoints) * 6; for (let k = 0; k < 3; k++) assert.ok(r.pos[i * 3 + k] >= r.chunkBoxes[q + k] - 1e-6 && r.pos[i * 3 + k] <= r.chunkBoxes[q + 3 + k] + 1e-6); }
    pos.set(r.pos, from * 3); col.set(r.col, from * 3); if (inten) inten.set(r.intensity, from);
  }
  return { pos, col, inten };
}

test('E57 частями: поля ScaledInteger/Integer/Float, записи через границы пакетов, недействительные точки — как чтение целиком', () => {
  const s = mixedScene(), ref = refRead(s.file);
  assert.equal(ref.count, s.valid.filter(Boolean).length);
  const o = Seg.openSegmentSource(s.file, { chunkPoints: 1000, segPoints: 3000 });
  assert.ok(o.ok, o.message);
  const d = o.desc;
  assert.equal(d.kind, 'e57'); assert.equal(d.count, s.nA + s.nB); assert.ok(d.hasColor && d.hasIntensity);
  assert.match(d.meta.format, /^E57 \(2 скан\.\)$/);
  assert.equal(d.e57.scans[0].idx.bits.join(','), '24,24,33,8,8,8,11,2,0', 'ширина полей — по пределам (33 бит — общий путь, до 24 — сдвигами)');
  assert.ok(d.e57.scans[0].idx.pk.length >= 140 && d.e57.scans[1].idx.pk.length === 33, 'пакеты индекса и пустые в указатель не входят');
  const all = readAllParts(d);
  let ri = 0, maxd = 0, sx = 0, sy = 0, sz = 0;
  for (let g = 0; g < d.count; g++) {
    const inA = g < s.nA;
    if (s.valid[g]) {
      const x = ref.pos[ri * 3] - d.cx, y = ref.pos[ri * 3 + 2] - d.cz, z = -(ref.pos[ri * 3 + 1] - d.cy);
      maxd = Math.max(maxd, Math.abs(all.pos[g * 3] - x), Math.abs(all.pos[g * 3 + 1] - y), Math.abs(all.pos[g * 3 + 2] - z));
      for (let k = 0; k < 3; k++) assert.equal(all.col[g * 3 + k], Math.round(ref.col[ri * 3 + k] * 255), 'цвет точки ' + g);
      assert.ok(Math.abs(all.inten[g] / 65535 - ref.intensity[ri]) < 1e-4, 'интенсивность точки ' + g);
      sx = all.pos[g * 3]; sy = all.pos[g * 3 + 1]; sz = all.pos[g * 3 + 2];
      ri++;
    } else {
      // недействительная — повтор предыдущей действительной; в начале скана — точка стояния
      const st = g === 0 ? [1000.5 - d.cx, 50 - d.cz, -(2000.25 - d.cy)] : [sx, sy, sz];
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(all.pos[g * 3 + k] - st[k]) < 1e-4, 'недействительная точка ' + g);
    }
    if (inA === false && g === s.nA) assert.ok(true);
  }
  assert.equal(ri, ref.count);
  assert.ok(maxd < 2e-5, 'координаты: ' + maxd);
  // скан B — без цвета: серый по интенсивности
  const g = s.nA + 10; assert.ok(all.col[g * 3] === all.col[g * 3 + 1] && all.col[g * 3 + 1] === all.col[g * 3 + 2]);
});

test('E57 частями: чтение с любой записи (бинарный поиск пакета и бита) = соответствующий кусок полного прохода', () => {
  const s = mixedScene(), ref = refRead(s.file), d = Seg.openSegmentSource(s.file).desc;
  // номер точки ref для каждой записи
  const map = new Int32Array(d.count).fill(-1); let ri = 0; for (let g = 0; g < d.count; g++) if (s.valid[g]) map[g] = ri++;
  const fd = fs.openSync(s.file, 'r');
  try {
    const R = rng(3);
    for (let t = 0; t < 60; t++) {
      const from = Math.floor(R() * (d.count - 1)), cnt = 1 + Math.floor(R() * Math.min(700, d.count - from));
      const got = []; ES.e57Each(d, fd, from, cnt, (x, y, z) => got.push(x, y, z));
      const want = []; for (let g = from; g < from + cnt; g++) if (map[g] >= 0) want.push(ref.pos[map[g] * 3], ref.pos[map[g] * 3 + 1], ref.pos[map[g] * 3 + 2]);
      assert.equal(got.length, want.length, 'с записи ' + from);
      for (let i = 0; i < got.length; i++) assert.ok(Math.abs(got[i] - want[i]) < 1e-9, 'с записи ' + from + ', значение ' + i);
    }
    // e57Points: тот же порядок, цвет в 0..255, интенсивность 0..1
    let n = 0; ES.e57Points(d, fd, 0, d.count, (x, y, z, r, g, b, iv) => { assert.ok(r >= 0 && r <= 255 && iv >= 0 && iv <= 1); n++; });
    assert.equal(n, ref.count);
  } finally { fs.closeSync(fd); }
});

function writtenScene() {
  const n = 60000, pos = new Float64Array(n * 3), col = new Uint8Array(n * 3), inten = new Float32Array(n);
  // две комнаты 6×4 м (стены) с полом и потолком, мировые координаты — большие (как в проекте)
  const R = rng(19);
  for (let i = 0; i < n; i++) {
    const k = i % 5, t = R();
    let x, y, z;
    if (k === 0) { x = t * 12; y = 0; } else if (k === 1) { x = t * 12; y = 4; } else if (k === 2) { x = (i % 3) * 6; y = t * 4; } else { x = R() * 12; y = R() * 4; }
    z = k >= 3 ? (k === 3 ? 0 : 2.8) : R() * 2.8;
    pos[i * 3] = 400000 + x; pos[i * 3 + 1] = 6000000 + y; pos[i * 3 + 2] = 120 + z;
    col[i * 3] = 50 + (i % 200); col[i * 3 + 1] = 90; col[i * 3 + 2] = (i * 3) % 256; inten[i] = (i % 997) / 996;
  }
  const u8 = E57.write({ pos, col, intensity: inten, count: n, scans: [
    { name: 'Станция 1', start: 0, count: 25000, pose: { T: [400003, 6000002, 121.5], quaternion: { w: Math.cos(0.4), x: 0, y: 0, z: Math.sin(0.4) } } },
    { name: 'Станция 2', start: 25000, count: n - 25000, pose: { T: [400009, 6000002, 121.5], quaternion: { w: 1, x: 0, y: 0, z: 0 } } }] });
  const file = path.join(TMP, 'w.e57'); fs.writeFileSync(file, u8);
  return { file, n, pos };
}

test('E57 частями: файл E57Core.write (две станции), части = целиком; начало координат карты (setOrigin)', () => {
  const s = writtenScene(), ref = refRead(s.file);
  const d = Seg.openSegmentSource(s.file, { chunkPoints: 1000, segPoints: 7000 }).desc;
  assert.equal(d.count, s.n);
  assert.ok(Math.abs(d.cz - 120) < 0.05 && Math.abs(d.cx - 400006) < 0.05 && Math.abs(d.cy - 6000002) < 0.05, 'центр рамки и низ по выборке');
  assert.equal(d.meta.srcXform.axis, 'zup'); assert.deepEqual(d.meta.srcXform.t, [d.cx, d.cy, d.cz]);
  const all = readAllParts(d);
  let maxd = 0;
  for (let i = 0; i < s.n; i++) maxd = Math.max(maxd, Math.abs(all.pos[i * 3] - (ref.pos[i * 3] - d.cx)), Math.abs(all.pos[i * 3 + 1] - (ref.pos[i * 3 + 2] - d.cz)), Math.abs(all.pos[i * 3 + 2] + (ref.pos[i * 3 + 1] - d.cy)));
  assert.ok(maxd < 1e-5, 'координаты: ' + maxd);
  // начало координат карты — части сдвигаются вместе с ним
  ES.setOrigin(d, d.cx + 1, d.cy - 2, d.cz - 0.5);
  const r = Seg.readSegment(d, 0, 1000, { shuffle: false });
  assert.ok(Math.abs(r.pos[0] - (all.pos[0] - 1)) < 1e-4 && Math.abs(r.pos[1] - (all.pos[1] + 0.5)) < 1e-4 && Math.abs(r.pos[2] - (all.pos[2] - 2)) < 1e-4);
  assert.ok(d.bbox.mn[1] <= 0.5 && d.bbox.mx[1] >= 3.2, 'рамка по высоте — от нового низа');
  // перемешивание внутри кирпича не меняет набор точек
  const sh = Seg.readSegment(d, 0, 1000, { shuffle: true });
  const key = (p) => Array.from({ length: 1000 }, (_, i) => p[i * 3].toFixed(4) + ',' + p[i * 3 + 1].toFixed(4)).sort().join(';');
  assert.equal(key(sh.pos), key(r.pos));
  // поток чтения (как в приложении) — тот же результат
  return Seg.readSegmentAsync(d, 7000, 7000, { shuffle: false }).then((a) => { assert.ok(a.ok, a.message); assert.equal(a.count, 7000); });
});

test('E57 частями: карта до загрузки и срез плана — по всем точкам файла, совпадают с прежним путём', () => {
  const s = writtenScene(), ref = refRead(s.file);
  const d = Seg.openSegmentSource(s.file).desc, cx = d.cx, cy = d.cy, cz = d.cz;
  const ov = OV.overview(d, { samples: 4e6 });
  assert.ok(ov.ok, ov.message);
  assert.deepEqual([ov.origin.cx, ov.origin.cy, ov.origin.cz], [cx, cy, cz], 'начало координат не меняется');
  assert.equal(ov.file.points, s.n); assert.equal(ov.sample.n, s.n, 'небольшой файл — в выборке все точки');
  assert.equal(ov.stations.length, 2); assert.equal(ov.stations[1].name, 'Станция 2');
  assert.ok(Math.abs(ov.stations[1].u + cx - 400009) < 1e-6);
  assert.ok(ov.grid.rgb && ov.grid.inten);
  // прежний путь (чтение целиком) — те же уровни
  const old = OV.openE57(s.file, fs.statSync(s.file).size), ovOld = OV.overview(old, { samples: 4e6 });
  assert.equal(ov.levels.length, ovOld.levels.length);
  ov.levels.forEach((l, i) => assert.ok(Math.abs(l.h + cz - (ovOld.levels[i].h + ovOld.origin.cz)) < 0.03));
  // выборка меньше файла — блоки записей по всему файлу (обе станции)
  const ovS = OV.overview(d, { samples: 9000 });
  assert.ok(ovS.ok && ovS.sample.n <= 9000 && ovS.sample.n > 8000);
  // срез плана: ровно все точки слоя
  const sl = OV.planSlice(d, { h0: 1.0, h1: 1.4, high: { h0: 2.5, h1: 2.9 } });
  assert.ok(sl.ok, sl.message);
  let want = 0, wantHi = 0; for (let i = 0; i < ref.count; i++) { const h = ref.pos[i * 3 + 2] - cz; if (h >= 1.0 && h <= 1.4) want++; if (h >= 2.5 && h <= 2.9) wantHi++; }
  assert.equal(sl.count, want); assert.equal(sl.stride, 1); assert.equal(sl.read, s.n);
  assert.equal(sl.countHigh, wantHi);
  for (let i = 0; i < sl.count; i++) assert.ok(sl.uv[i * 2] > -6.1 && sl.uv[i * 2] < 6.1 && sl.uv[i * 2 + 1] > -2.1 && sl.uv[i * 2 + 1] < 2.1);
  // предел точек: каждая 2^k-я точка слоя
  const lim = OV.planSlice(d, { h0: 0, h1: 2.9, maxPoints: 100000 });
  assert.ok(lim.ok && lim.count <= 100000);
  // область и отмена
  const rc = OV.planSlice(d, { h0: 1.0, h1: 1.4, rect: { u0: -6.5, u1: 0, v0: -3, v1: 3 } });
  assert.ok(rc.count > want * 0.3 && rc.count < want * 0.7);
  const ac = new AbortController(); ac.abort();
  const cancelled = OV.planSlice(d, { h0: 1.0, h1: 1.4, signal: ac.signal });
  assert.equal(cancelled.ok, false); assert.equal(cancelled.cancelled, true);
});

test('E57 частями: фильтр окна «Перед загрузкой» (область, высота) — в координатах карты', () => {
  const s = writtenScene(), ref = refRead(s.file);
  const d = Seg.openSegmentSource(s.file, { chunkPoints: 1000, segPoints: 20000 }).desc;
  const filter = { rect: { u0: -6.5, u1: 0, v0: -3, v1: 3 }, h: { min: 0.5, max: 2 }, hShift: OV.hShift(d) };
  assert.equal(filter.hShift, 0);
  let kept = 0;
  for (let from = 0; from < d.count; from += d.segPoints) {
    const r = Seg.readSegment(d, from, Math.min(d.segPoints, d.count - from), { filter });
    assert.ok(r.ok && r.filtered);
    for (let i = 0; i < r.count; i++) { const u = r.pos[i * 3], h = r.pos[i * 3 + 1], v = -r.pos[i * 3 + 2]; assert.ok(u >= -6.5 && u <= 0 && h >= 0.5 && h <= 2 && v >= -3 && v <= 3); }
    kept += r.count;
  }
  let want = 0; for (let i = 0; i < ref.count; i++) { const u = ref.pos[i * 3] - d.cx, v = ref.pos[i * 3 + 1] - d.cy, h = ref.pos[i * 3 + 2] - d.cz; if (u >= -6.5 && u <= 0 && v >= -3 && v <= 3 && h >= 0.5 && h <= 2) want++; }
  assert.ok(Math.abs(kept - want) <= 2, kept + ' / ' + want);
});

test('E57 частями: повреждённый файл — понятный отказ (запасной путь), не исключение', () => {
  const s = writtenScene(), u8 = fs.readFileSync(s.file);
  const cut = path.join(TMP, 'cut.e57'); fs.writeFileSync(cut, u8.subarray(0, Math.floor(u8.length / 2)));
  const r = Seg.openSegmentSource(cut);
  assert.equal(r.ok, false); assert.equal(r.unsupported, true); assert.ok(r.message);
  // объявлено больше записей, чем есть в пакетах
  const m = mixedScene();
  const bad = buildE57([{ name: 'X', count: 100, declared: 150, packets: 3, fields: [{ name: 'cartesianX', type: 'Float' }, { name: 'cartesianY', type: 'Float' }, { name: 'cartesianZ', type: 'Float' }],
    cols: { cartesianX: Array.from({ length: 100 }, (_, i) => i), cartesianY: new Array(100).fill(0), cartesianZ: new Array(100).fill(1) } }], 9);
  const bf = path.join(TMP, 'bad.e57'); fs.writeFileSync(bf, bad);
  const rb = Seg.openSegmentSource(bf);
  assert.equal(rb.ok, false); assert.match(rb.message, /меньше записей/);
  assert.ok(m.file);
});

test('E57 частями: план в потоке карты (как в приложении) совпадает с планом по LAS того же облака', async () => {
  const G = require('./r27-synthetic.helper.js'), AP = require(path.join(ROOT, 'renderer', 'auto-plan.js'));
  const { Worker } = require('worker_threads');
  const b = G.building({ step: 0.03, theta: 17, noise: 0.003 });
  const las = path.join(TMP, 'p.las'); G.writeLas(las, b.pts);
  const n = b.pts.length, pos = new Float64Array(n * 3), col = new Float32Array(n * 3);
  b.pts.forEach((p, i) => { pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; col[i * 3] = 0.5; col[i * 3 + 1] = 0.5; col[i * 3 + 2] = 0.5; });
  const e57 = path.join(TMP, 'p.e57'); fs.writeFileSync(e57, E57.write({ pos, col, count: n }));
  const dl = Seg.openSegmentSource(las).desc, de = Seg.openSegmentSource(e57).desc;
  const ovL = OV.overview(dl, { samples: 4e6 }), ovE = OV.overview(de, { samples: 4e6 });
  const run = (desc, fl) => new Promise((ok, bad) => {
    const w = new Worker(path.join(ROOT, 'cloud-overview-worker.js'), { workerData: { job: 'plan', desc, opts: { h0: fl + 1.15, h1: fl + 1.25, plan: {} } } });
    w.on('message', (m) => { if (m.type === 'result') { ok(m.result); w.terminate(); } });
    w.on('error', bad);
  });
  const [pL, pE] = await Promise.all([run(dl, ovL.levels[0].h), run(de, ovE.levels[0].h)]);
  assert.ok(pL.ok && pE.ok, pE.message);
  assert.equal(pE.slice.stride, 1, 'все точки слоя');
  assert.ok(Math.abs(pE.slice.count - pL.slice.count) <= pL.slice.count * 0.02, pE.slice.count + ' / ' + pL.slice.count);
  assert.equal(pE.plan.rooms.length, pL.plan.rooms.length);
  const aE = pE.plan.rooms.map(r => r.area).sort((x, y) => x - y), aL = pL.plan.rooms.map(r => r.area).sort((x, y) => x - y);
  aE.forEach((a, i) => assert.ok(Math.abs(a - aL[i]) < 0.15, 'помещение ' + a + ' / ' + aL[i]));
  assert.equal(pE.plan.openings.length, pL.plan.openings.length);
  assert.ok(AP.toDXF(pE.plan, {}).length > 1000);
});

test('E57 частями: связка (cloud-segments, карта, план, main.js, сборка)', () => {
  const seg = read('cloud-segments.js'), main = read('main.js'), ov = read('cloud-overview.js'), es = read('e57-segments.js'), pkg = JSON.parse(read('package.json'));
  assert.match(seg, /ext !== '\.e57'/);
  assert.match(seg, /desc\.kind === 'e57' && desc\.e57\) require\('\.\/e57-segments'\)\.e57Fill/);
  assert.match(main, /const seg = cloudSegments\.openSegmentSource\(abs\);\n\s+if \(seg\.ok \|\| !\/\\\.e57\$\/i\.test\(abs\)\) return seg;/);
  assert.match(main, /require\('\.\/e57-segments'\)\.setOrigin\(d, cachedE57\.desc\.cx, cachedE57\.desc\.cy, cachedE57\.desc\.cz\)/);
  assert.match(ov, /if \(desc\.e57\) return planSliceE57Parts/);
  assert.match(ov, /if \(desc\.e57 && Number\.isFinite\(desc\.cx\)\) return gatherE57Parts/);
  for (const k of ['asarUnpack', 'files']) assert.ok(pkg.build[k].includes('e57-segments.js'), k);
  assert.doesNotMatch(es, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'без эмодзи');
});
