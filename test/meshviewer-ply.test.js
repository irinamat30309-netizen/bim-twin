const test = require('node:test');
const assert = require('node:assert');
const Mesh = require('../renderer/meshviewer.js');

function buildBinPly() {
  const header = 'ply\nformat binary_little_endian 1.0\n' +
    'element vertex 3\n' +
    'property float x\nproperty float y\nproperty float z\n' +
    'property uchar red\nproperty uchar green\nproperty uchar blue\n' +
    'element face 1\n' +
    'property list uchar int vertex_indices\n' +
    'end_header\n';
  const enc = Buffer.from(header, 'utf8');
  const buf = Buffer.alloc(enc.length + 3 * (12 + 3) + (1 + 3 * 4));
  enc.copy(buf, 0);
  let o = enc.length;
  const verts = [[0, 0, 0, 255, 0, 0], [1, 0, 0, 0, 255, 0], [0, 1, 0, 0, 0, 255]];
  for (const v of verts) {
    buf.writeFloatLE(v[0], o); o += 4; buf.writeFloatLE(v[1], o); o += 4; buf.writeFloatLE(v[2], o); o += 4;
    buf.writeUInt8(v[3], o++); buf.writeUInt8(v[4], o++); buf.writeUInt8(v[5], o++);
  }
  buf.writeUInt8(3, o++); buf.writeInt32LE(0, o); o += 4; buf.writeInt32LE(1, o); o += 4; buf.writeInt32LE(2, o); o += 4;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function buildAsciiPly() {
  const txt = 'ply\nformat ascii 1.0\n' +
    'element vertex 3\n' +
    'property float x\nproperty float y\nproperty float z\n' +
    'element face 1\n' +
    'property list uchar int vertex_indices\n' +
    'end_header\n' +
    '0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n';
  const b = Buffer.from(txt, 'utf8');
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

test('parsePLYMesh reads binary triangle mesh with vertex colors', () => {
  const scene = Mesh._parsePLYMesh(buildBinPly());
  assert.strictEqual(scene.primitives.length, 1);
  const p = scene.primitives[0];
  assert.strictEqual(p.vertexCount, 3);
  assert.strictEqual(p.indices.length, 3);
  assert.ok(p.colors, 'colors present');
  assert.ok(Math.abs(p.colors[0] - 1) < 1e-6, 'first vertex red = 1.0');
  assert.ok(Math.abs(p.colors[1]) < 1e-6, 'first vertex green = 0');
  assert.strictEqual(scene.triangles, 1);
  assert.ok(scene.bounds && scene.bounds.radius > 0, 'bounds computed');
});

test('parsePLYMesh reads ascii triangle mesh without colors', () => {
  const scene = Mesh._parsePLYMesh(buildAsciiPly());
  const p = scene.primitives[0];
  assert.strictEqual(p.vertexCount, 3);
  assert.strictEqual(p.indices.length, 3);
  assert.strictEqual(p.colors, null, 'no colors');
  assert.strictEqual(scene.triangles, 1);
});

test('detectAndBuild routes .ply bytes to the mesh parser', () => {
  const scene = Mesh._detectAndBuild(buildBinPly(), 'model.ply');
  assert.strictEqual(scene.triangles, 1);
});

test('parsePLYMesh rejects a point-only PLY (no faces)', () => {
  const txt = 'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 1 1\n';
  const b = Buffer.from(txt, 'utf8');
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  assert.throws(() => Mesh._parsePLYMesh(ab));
});
