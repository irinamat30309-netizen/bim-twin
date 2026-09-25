'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Mesh = require('../renderer/meshviewer.js');
const Utils = require('../renderer/app-utils.js');
const Cloud = require('../las-node.js');
const Section = require('../renderer/section.js');
const DXF = require('../renderer/dxf.js');

function ab(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function concaveOBJ() {
  return ab([
    '# concave five-corner polygon',
    'v 0 0 0', 'v 2 0 0', 'v 2 2 0', 'v 1 1 0', 'v 0 2 0',
    'vt 0 0', 'vt 1 0', 'vt 1 1', 'vt .5 .5', 'vt 0 1',
    'vn 0 0 1',
    'f 1/1/1 2/2/1 3/3/1 4/4/1 5/5/1'
  ].join('\n'));
}

function coloredNegativeIndexOBJ() {
  return ab([
    'v 0 0 0 255 0 0',
    'v 1 0 0 0 255 0',
    'v 0 1 0 0 0 255',
    'f -3 -2 -1'
  ].join('\n'));
}

function binarySTL(attribute = 0) {
  const b = Buffer.alloc(84 + 50);
  b.write('solid binary-but-solid-header', 0, 'ascii');
  b.writeUInt32LE(1, 80);
  let o = 84;
  for (const n of [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0]) {
    b.writeFloatLE(n, o);
    o += 4;
  }
  b.writeUInt16LE(attribute, o);
  return ab(b);
}

function asciiSTL(normal = '0 0 0') {
  return ab([
    'solid test',
    `facet normal ${normal}`,
    'outer loop',
    'vertex 0 0 0',
    'vertex 2 0 0',
    'vertex 0 3 0',
    'endloop',
    'endfacet',
    'endsolid test',
    ''
  ].join('\n'));
}

function cubeOBJ() {
  return ab([
    'v 0 0 0', 'v 1 0 0', 'v 1 0 1', 'v 0 0 1',
    'v 0 1 0', 'v 1 1 0', 'v 1 1 1', 'v 0 1 1',
    'f 1 2 3 4', 'f 5 8 7 6',
    'f 1 5 6 2', 'f 1 4 8 5',
    'f 4 3 7 8', 'f 2 6 7 3'
  ].join('\n'));
}

test('OBJ ear-clips a concave n-gon without filling its notch', () => {
  const scene = Mesh._detectAndBuild(concaveOBJ(), 'concave.obj');
  const p = scene.primitives[0];
  assert.equal(scene.sourceFormat, 'OBJ');
  assert.equal(scene.triangles, 3);
  assert.equal(p.normals.length, p.vertexCount * 3);
  assert.equal(p.uvs.length, p.vertexCount * 2);

  let area = 0;
  for (let i = 0; i < p.indices.length; i += 3) {
    const a = p.indices[i] * 3, b = p.indices[i + 1] * 3, c = p.indices[i + 2] * 3;
    const signed = (
      (p.sectionPositions[b] - p.sectionPositions[a]) * (p.sectionPositions[c + 1] - p.sectionPositions[a + 1]) -
      (p.sectionPositions[b + 1] - p.sectionPositions[a + 1]) * (p.sectionPositions[c] - p.sectionPositions[a])
    ) / 2;
    area += Math.abs(signed);
    assert.ok(signed > 0, 'triangles preserve face winding');
  }
  assert.ok(Math.abs(area - 3) < 1e-9, `expected polygon area 3, got ${area}`);
  assert.equal(scene.sourceUpAxisKnown, false);
  assert.equal(scene.unitsKnown, false);
  assert.match(scene.warnings.join(' '), /CRS/);
});

test('OBJ resolves negative indices and maps normalized or byte vertex colors', () => {
  const scene = Mesh._detectAndBuild(coloredNegativeIndexOBJ(), 'colors.obj');
  const p = scene.primitives[0];
  assert.equal(scene.triangles, 1);
  assert.deepEqual(Array.from(p.indices), [0, 1, 2]);
  assert.deepEqual(Array.from(p.colors), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.equal(p.normals, null);
  assert.equal(p.uvs, null);
});

test('OBJ rejects invalid and zero indices rather than silently corrupting geometry', () => {
  assert.throws(() => Mesh._parseOBJMesh(ab('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 0 2 3\n')), /индекс/);
  assert.throws(() => Mesh._parseOBJMesh(ab('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 4\n')), /вне диапазона/);
});

test('binary STL is identified by its exact payload length even with a "solid" header', () => {
  const scene = Mesh._detectAndBuild(binarySTL(), 'fixture.stl');
  assert.equal(scene.sourceFormat, 'STL');
  assert.equal(scene.triangles, 1);
  assert.equal(scene.metadata.binary, true);
  assert.deepEqual(Array.from(scene.primitives[0].indices), [0, 1, 2]);
  assert.deepEqual(Array.from(scene.primitives[0].normals.slice(0, 3)), [0, 0, 1]);
});

test('STL reports non-zero facet attributes instead of silently dropping possible color data', () => {
  const scene = Mesh._parseSTLMesh(binarySTL(0x8000));
  assert.equal(scene.metadata.nonZeroAttributes, 1);
  assert.match(scene.warnings.join(' '), /facet-атрибуты/);
});

test('ASCII STL reads facets and derives a normal when the stored normal is zero', () => {
  const scene = Mesh._detectAndBuild(asciiSTL(), 'fixture.stl');
  const p = scene.primitives[0];
  assert.equal(scene.triangles, 1);
  assert.equal(scene.metadata.binary, false);
  assert.deepEqual(Array.from(p.normals.slice(0, 3)), [0, 0, 1]);
  assert.deepEqual(scene.sectionBounds.hi, [2, 3, 0]);
});

test('truncated binary STL and incomplete ASCII facets fail clearly', () => {
  assert.throws(() => Mesh._parseSTLMesh(ab(Buffer.alloc(83))), /короче/);
  assert.throws(() => Mesh._parseSTLMesh(ab(
    'solid bad\nfacet normal 0 0 1\nvertex 0 0 0\nendfacet\nendsolid\n#' + '.'.repeat(120) + '\n'
  )), /ровно три вершины/);
});

test('OBJ mesh sections remain closed and export as a closed CAD polyline', () => {
  const scene = Mesh._detectAndBuild(cubeOBJ(), 'cube.obj');
  assert.equal(scene.triangles, 12);
  const result = Section.meshPlaneSection(scene, Section.axisPlane('y', 0.5, scene.sectionBounds.center));
  assert.equal(result.closedCount, 1);
  assert.equal(result.openCount, 0);
  assert.ok(Math.abs(result.paths[0].length - 4) < 1e-8);
  const text = DXF.toDxf(Section.meshSectionToEntities(result, 'OBJ_SECTION'));
  assert.equal((text.match(/\nPOLYLINE\n/g) || []).length, 1);
  assert.match(text, /OBJ_SECTION/);
  assert.match(text, /\n70\n1\n/);
});

test('OBJ/STL are available through both model and mesh pickers; importer script loads first', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');
  const meshViewer = fs.readFileSync(path.join(root, 'renderer/meshviewer.js'), 'utf8');
  const importsAt = html.indexOf('mesh-importers.js?v=1224');
  const viewerAt = html.indexOf('meshviewer.js?v=1227');
  assert.ok(importsAt >= 0 && importsAt < viewerAt, 'pure format reader loads before MeshViewer');
  assert.match(html, /id="modelInput"[^>]*\.obj[^>]*\.stl/);
  assert.ok(app.includes("_meshInput.accept = '.glb,.gltf,.obj,.stl,.ply'"));
  assert.ok(app.includes("if (/\\.(obj|stl)$/i.test(name))"));
  assert.ok(app.includes('window.MeshViewer.loadAsync'), 'the UI uses the Worker parser');
  assert.match(meshViewer, /z-index:13/, 'mesh overlay must keep Lixel controls visible above it');
  assert.ok(fs.existsSync(path.join(root, 'renderer/mesh-import-worker.js')));
  assert.ok(Utils.is3DModelName('building.OBJ'));
  assert.ok(Utils.is3DModelName('prototype.stl'));
  assert.ok(!Utils.is3DModelName('materials.mtl'));
});

const userFixtureDir = process.env.BIM_TWIN_USER_FIXTURES || '';
test('uploaded full OBJ/STL user fixtures parse with expected geometry and honest capability warnings', { skip: !userFixtureDir }, () => {
  const objPath = path.join(userFixtureDir, 'EXAMPLES__Untitled+(1).obj');
  const stlPath = path.join(userFixtureDir, 'EXAMPLES__Untitled.stl');
  const objBytes = fs.readFileSync(objPath);
  const stlBytes = fs.readFileSync(stlPath);
  const obj = Mesh._detectAndBuild(ab(objBytes), path.basename(objPath));
  const stl = Mesh._detectAndBuild(ab(stlBytes), path.basename(stlPath));
  assert.equal(obj.triangles, 315390);
  assert.equal(obj.metadata.faces, 249260);
  assert.equal(obj.metadata.rejectedFaces, 0);
  assert.equal(obj.metadata.renderVertices, 809574);
  assert.ok(obj.metadata.groupStatements > 0);
  assert.equal(obj.metadata.removedCollinearCorners, 105);
  assert.match(obj.warnings.join(' '), /Иерархия OBJ-групп/);
  assert.equal(obj.primitives[0].indices.length, obj.triangles * 3);
  assert.equal(obj.primitives[0].uvs.length, obj.primitives[0].vertexCount * 2);
  assert.match(obj.warnings.join(' '), /MTL/);
  assert.match(obj.warnings.join(' '), /единицы/);
  assert.equal(stl.triangles, 315495);
  assert.equal(stl.metadata.binary, true);
  assert.equal(stl.metadata.declaredTriangles, 315495);
  assert.equal(stl.primitives[0].indices.length, stl.triangles * 3);
  for (const scene of [obj, stl]) {
    const p = scene.primitives[0];
    for (const arr of [p.positions, p.sectionPositions, p.normals, p.indices]) {
      assert.ok(arr && arr.length > 0);
    }
    for (let i = 0; i < p.positions.length; i += Math.max(3, Math.floor(p.positions.length / 10000 / 3) * 3)) {
      assert.ok(Number.isFinite(p.positions[i]), `${scene.sourceFormat} sampled positions finite`);
    }
  }
  const objBounds = obj.sectionBounds, stlBounds = stl.sectionBounds;
  const objSection = Section.meshPlaneSection(obj, Section.axisPlane('y', (objBounds.lo[1] + objBounds.hi[1]) / 2, objBounds.center));
  const stlSection = Section.meshPlaneSection(stl, Section.axisPlane('z', (stlBounds.lo[2] + stlBounds.hi[2]) / 2, stlBounds.center));
  assert.equal(objSection.closedCount, 488);
  assert.equal(objSection.openCount, 135);
  assert.equal(stlSection.closedCount, objSection.closedCount);
  assert.equal(stlSection.openCount, objSection.openCount);
  assert.equal(objSection.paths.length, objSection.closedCount + objSection.openCount);
  const dxfText = DXF.toDxf(Section.meshSectionToEntities(objSection, 'USER_OBJ_SECTION'));
  assert.match(dxfText, /USER_OBJ_SECTION/);
});

test('external large PLY fixture is streamed and deterministically budget-sampled', { skip: !userFixtureDir }, async () => {
  const file = path.join(userFixtureDir, 'PLY___1.ply');
  const stat = fs.statSync(file);
  const parsed = await Cloud.parseCloudFileAsync(file, { maxPoints: 1000000 });
  assert.equal(stat.size, 230294477);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.meta.total, 15352950);
  assert.equal(parsed.count, 959559);
  assert.equal(parsed.pos.length, parsed.count * 3);
  assert.equal(parsed.col.length, parsed.count * 3);
  assert.ok(parsed.meta.w > 3 && parsed.meta.w < 3.2);
  assert.ok(parsed.meta.d > 27 && parsed.meta.d < 28);
  assert.ok(parsed.meta.h > 4 && parsed.meta.h < 5);
  for (let i = 0; i < parsed.pos.length; i += 10007) assert.ok(Number.isFinite(parsed.pos[i]));
  for (let i = 0; i < parsed.col.length; i += 10007) assert.ok(Number.isFinite(parsed.col[i]));
});