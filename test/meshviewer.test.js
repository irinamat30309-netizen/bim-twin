'use strict';
const test = require('node:test');
const assert = require('node:assert');
const MV = require('../renderer/meshviewer.js');

function buildGLB() {
  const enc = new TextEncoder();
  const pos = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]);
  const idx = new Uint16Array([0, 1, 2]);
  const binLen = 36 + 8; // indices 6 bytes padded to 8
  const bin = new Uint8Array(binLen);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), 36);
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 }
    ],
    buffers: [{ byteLength: binLen }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }]
  };
  let jsonBytes = enc.encode(JSON.stringify(gltf));
  const jpad = (4 - (jsonBytes.length % 4)) % 4;
  if (jpad) { const t = new Uint8Array(jsonBytes.length + jpad); t.set(jsonBytes); for (let i = 0; i < jpad; i++) t[jsonBytes.length + i] = 0x20; jsonBytes = t; }
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  let o = 12;
  dv.setUint32(o, jsonBytes.length, true); dv.setUint32(o + 4, 0x4e4f534a, true); out.set(jsonBytes, o + 8); o += 8 + jsonBytes.length;
  dv.setUint32(o, bin.length, true); dv.setUint32(o + 4, 0x004e4942, true); out.set(bin, o + 8);
  return out.buffer;
}

test('parseGLB reads JSON and BIN chunks', () => {
  const ab = buildGLB();
  const g = MV._parseGLB(ab);
  assert.strictEqual(g.json.asset.version, '2.0');
  assert.strictEqual(g.version, 2);
  assert.ok(g.bin && g.bin.byteLength === 44, 'BIN chunk present and 4-aligned');
});

test('parseGLB rejects a non-GLB buffer', () => {
  const bad = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
  assert.throws(() => MV._parseGLB(bad), /GLB/);
});

test('buildScene produces a triangle primitive with material and bounds', () => {
  const g = MV._parseGLB(buildGLB());
  const scene = MV._buildScene(g.json, g.bin);
  assert.strictEqual(scene.primitives.length, 1);
  const p = scene.primitives[0];
  assert.strictEqual(p.vertexCount, 3);
  assert.strictEqual(p.indices.length, 3);
  assert.deepStrictEqual(Array.from(p.indices), [0, 1, 2]);
  assert.strictEqual(p.positions.length, 9);
  assert.strictEqual(p.material.baseColorFactor[0], 1);
  assert.strictEqual(p.material.baseColorFactor[1], 0);
  assert.ok(scene.bounds.radius > 0, 'positive bounds radius');
  assert.strictEqual(scene.triangles, 1);
  assert.ok(p.model && p.model.length === 16, 'model matrix present');
  assert.ok(p.normalMatrix && p.normalMatrix.length === 9, 'normal matrix present');
});

test('_detectAndBuild handles GLB by magic', () => {
  const scene = MV._detectAndBuild(buildGLB(), 'scene.glb');
  assert.strictEqual(scene.primitives.length, 1);
});
