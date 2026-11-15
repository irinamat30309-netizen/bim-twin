'use strict';
/*
 * r133 — Potree 2.0: шаг точки и раскладка атрибутов из metadata.attributes.
 *
 * Баг (найден на реальном проекте XGrids/Lixel Studio, D:\Skan\gg\123):
 * загрузчик жёстко считал 16 байт на точку (position 12 + intensity 1 + rgb 3),
 * а metadata.oct проекта объявляет ещё classification → 17 байт. Начиная со второй
 * точки позиции/цвета «съезжали». Теперь шаг и смещения берутся из metadata.attributes,
 * для метаданных без attributes сохранён прежний формат 16 байт.
 */
const test = require('node:test');
const assert = require('node:assert');

global.window = global;

function makeHierarchy(nodes) {
  const buf = new ArrayBuffer(nodes.length * 22);
  const dv = new DataView(buf);
  nodes.forEach((n, i) => {
    const o = i * 22;
    dv.setUint8(o, n.type || 0);
    dv.setUint8(o + 1, 0);
    dv.setUint32(o + 2, n.numPoints, true);
    dv.setBigUint64(o + 6, BigInt(n.byteOffset), true);
    dv.setBigUint64(o + 14, BigInt(n.byteSize), true);
  });
  return buf;
}
// octree.bin: точки с раскладкой attributes (в порядке массива)
function makeOctree(meta, points) {
  const stride = meta.attributes.reduce((s, a) => s + a.size, 0);
  const buf = new ArrayBuffer(points.length * stride);
  const dv = new DataView(buf);
  points.forEach((pt, i) => {
    const base = i * stride;
    let off = 0;
    for (const a of meta.attributes) {
      if (a.name === 'position') {
        dv.setInt32(base + off, pt.ix, true);
        dv.setInt32(base + off + 4, pt.iy, true);
        dv.setInt32(base + off + 8, pt.iz, true);
      } else if (a.name === 'intensity') {
        dv.setUint8(base + off, pt.i != null ? pt.i : 0);
      } else if (a.name === 'rgb') {
        dv.setUint8(base + off, pt.r); dv.setUint8(base + off + 1, pt.g); dv.setUint8(base + off + 2, pt.b);
      } else if (a.name === 'classification') {
        dv.setUint8(base + off, pt.c != null ? pt.c : 0);
      }
      off += a.size;
    }
  });
  return buf;
}
function makeFetch(meta, hierarchyBuf, octreeBuf) {
  return async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/metadata.json')) return { json: async () => meta };
    if (u.endsWith('/hierarchy.bin')) return { arrayBuffer: async () => hierarchyBuf };
    if (u.endsWith('/octree.bin')) {
      let start = 0, end = octreeBuf.byteLength - 1;
      const range = opts && opts.headers && opts.headers.Range;
      const m = range && /bytes=(\d+)-(\d+)/.exec(range);
      if (m) { start = +m[1]; end = +m[2]; }
      return { arrayBuffer: async () => octreeBuf.slice(start, end + 1) };
    }
    throw new Error('unexpected url ' + url);
  };
}
function fakeGl(cap) {
  return {
    createShader: () => ({}), shaderSource() { }, compileShader() { }, getShaderParameter: () => true, getShaderInfoLog: () => '',
    createProgram: () => ({}), attachShader() { }, linkProgram() { }, getProgramParameter: () => true, getProgramInfoLog: () => '',
    createBuffer: () => ({}), bindBuffer() { },
    bufferData(target, data) {
      if (data && data.constructor && data.constructor.name === 'Float32Array') cap.pos.push(Array.from(data));
      else if (data && data.constructor && data.constructor.name === 'Uint8Array') cap.col.push(Array.from(data));
    },
    ARRAY_BUFFER: 34962, STATIC_DRAW: 35044
  };
}
async function waitLoaded(loader, n, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 2000) && loader.nodes.filter((x) => x.loaded).length < n) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return loader.nodes.filter((x) => x.loaded).length;
}

function loadModule() {
  delete require.cache[require.resolve('../renderer/potree-loader.js')];
  require('../renderer/potree-loader.js');
  return global.PotreeLoader;
}

test('r133: шаг точки из metadata.attributes (17 байт, XGrids/Lixel) — без сдвига', async () => {
  // project-like meta: position 12 + intensity 1 + rgb 3 + classification 1 = 17
  const meta = {
    version: '2.1', points: 5, encoding: 'DEFAULT',
    scale: [0.0001, 0.0001, 0.0001],
    offset: [-113.3416, -0.0002, -100.3901],
    boundingBox: { min: [0, 0, 0], max: [226.0781, 226.0781, 226.0781] },
    attributes: [
      { name: 'position', size: 12, numElements: 3, type: 'int32' },
      { name: 'intensity', size: 1, numElements: 1, type: 'uint8' },
      { name: 'rgb', size: 3, numElements: 3, type: 'uint8' },
      { name: 'classification', size: 1, numElements: 1, type: 'uint8' }
    ]
  };
  const pts0 = [
    { ix: 1000, iy: 2000, iz: 3000, r: 10, g: 20, b: 30, i: 7, c: 2 },
    { ix: 500000, iy: 10000, iz: 500, r: 40, g: 50, b: 60, i: 8, c: 3 },
    { ix: 20000, iy: 3000, iz: 4000, r: 70, g: 80, b: 90, i: 9, c: 4 }
  ];
  const pts1 = [
    { ix: 3000, iy: 4000, iz: 5000, r: 1, g: 2, b: 3, i: 1, c: 1 },
    { ix: 6000, iy: 7000, iz: 8000, r: 4, g: 5, b: 6, i: 2, c: 1 }
  ];
  const node0 = makeOctree(meta, pts0);
  const node1 = makeOctree(meta, pts1);
  const octree = new Uint8Array(node0.byteLength + node1.byteLength);
  octree.set(new Uint8Array(node0), 0);
  octree.set(new Uint8Array(node1), node0.byteLength);
  const hierarchy = makeHierarchy([
    { numPoints: pts0.length, byteOffset: 0, byteSize: node0.byteLength },
    { numPoints: pts1.length, byteOffset: node0.byteLength, byteSize: node1.byteLength }
  ]);
  global.fetch = makeFetch(meta, hierarchy, octree.buffer);
  const PotreeLoader = loadModule();
  const cap = { pos: [], col: [] };
  const ldr = new PotreeLoader();
  await ldr.open('fake://base');
  assert.strictEqual(ldr.nodes.length, 2);
  ldr.attachGL(fakeGl(cap));
  ldr.setLoadBudget(4);
  ldr.update(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), [800, 600]);
  const loaded = await waitLoaded(ldr, 2, 4000);
  assert.strictEqual(loaded, 2, 'не загрузились оба узла');
  assert.strictEqual(cap.pos.length, 2, 'нет перехвата pos-буферов');
  assert.strictEqual(cap.col.length, 2, 'нет перехвата col-буферов');

  // точные координаты (scale/offset из meta)
  const expect = (ix, iy, iz) => [
    ix * meta.scale[0] + meta.offset[0],
    iy * meta.scale[1] + meta.offset[1],
    iz * meta.scale[2] + meta.offset[2]
  ];
  const e0 = expect(1000, 2000, 3000);
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-5, msg + ': ' + a + ' vs ' + b);
  near(cap.pos[0][0], e0[0], 'X первой точки неверен');
  near(cap.pos[0][1], e0[1], 'Y первой точки неверен');
  near(cap.pos[0][2], e0[2], 'Z первой точки неверен');
  // вторая точка — главная проверка: при старом шаге 16 она была бы сдвинута
  const e1 = expect(500000, 10000, 500);
  near(cap.pos[0][3], e1[0], 'X второй точки неверен (сдвиг stride?)');
  near(cap.pos[0][4], e1[1], 'Y второй точки неверен (сдвиг stride?)');
  near(cap.pos[0][5], e1[2], 'Z второй точки неверен (сдвиг stride?)');
  // цвета второй точки тоже не должны съезжать
  assert.deepStrictEqual(cap.col[0].slice(3, 6), [40, 50, 60], 'цвета второй точки сдвинуты');

  // все декодированные позиции в диапазоне attribute position (как у реального проекта)
  const lim = {
    min: [-113.3416, -0.0002, -100.3901],
    max: [112.7364, 59.0059, 97.9319]
  };
  for (const arr of cap.pos) {
    for (let i = 0; i < arr.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        assert.ok(arr[i + k] >= lim.min[k] - 1e-6 && arr[i + k] <= lim.max[k] + 1e-6,
          'позиция вне диапазона meta: ' + arr[i + k]);
      }
    }
  }
});

test('r133: метаданные без attributes — прежний формат 16 байт', async () => {
  const meta = {
    version: '2.0', points: 2,
    scale: [0.0001, 0.0001, 0.0001], offset: [0, 0, 0],
    boundingBox: { min: [0, 0, 0], max: [1, 1, 1] }
  };
  const stride = 16;
  const octree = new ArrayBuffer(2 * stride);
  const dv = new DataView(octree);
  [[100, 200, 300, 11, 22, 33], [400, 500, 600, 44, 55, 66]].forEach((p, i) => {
    const b = i * stride;
    dv.setInt32(b, p[0], true); dv.setInt32(b + 4, p[1], true); dv.setInt32(b + 8, p[2], true);
    dv.setUint8(b + 12, 7); // intensity
    dv.setUint8(b + 13, p[3]); dv.setUint8(b + 14, p[4]); dv.setUint8(b + 15, p[5]);
  });
  const hierarchy = makeHierarchy([{ numPoints: 2, byteOffset: 0, byteSize: 2 * stride }]);
  global.fetch = makeFetch(meta, hierarchy, octree);
  const PotreeLoader = loadModule();
  const cap = { pos: [], col: [] };
  const ldr = new PotreeLoader();
  await ldr.open('fake://base');
  ldr.attachGL(fakeGl(cap));
  ldr.update(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), [800, 600]);
  await waitLoaded(ldr, 1, 3000);
  const exp = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06];
  for (let i = 0; i < 6; i++) assert.ok(Math.abs(cap.pos[0][i] - exp[i]) < 1e-6, 'позиция ' + i + ': ' + cap.pos[0][i]);
  assert.deepStrictEqual(cap.col[0].slice(0, 6), [11, 22, 33, 44, 55, 66]);
});

test('r133: буфер узла короче numPoints×stride — декодируется безопасно', async () => {
  const meta = {
    version: '2.1', points: 10,
    scale: [0.0001, 0.0001, 0.0001], offset: [0, 0, 0],
    attributes: [
      { name: 'position', size: 12 }, { name: 'intensity', size: 1 }, { name: 'rgb', size: 3 }, { name: 'classification', size: 1 }
    ]
  };
  // объявлено 10 точек (170 байт), а реально пришло 2 точки (34 байта)
  const stride = 17;
  const octree = new ArrayBuffer(2 * stride);
  const hierarchy = makeHierarchy([{ numPoints: 10, byteOffset: 0, byteSize: 10 * stride }]);
  global.fetch = makeFetch(meta, hierarchy, octree);
  const PotreeLoader = loadModule();
  const cap = { pos: [], col: [] };
  const ldr = new PotreeLoader();
  await ldr.open('fake://base');
  ldr.attachGL(fakeGl(cap));
  ldr.update(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), [800, 600]);
  await waitLoaded(ldr, 1, 3000);
  assert.strictEqual(cap.pos[0].length, 2 * 3, 'должно декодироваться только 2 точки, а не 10');
  assert.strictEqual(ldr.nodes[0].vao.count, 2, 'count узла должен быть 2');
});
