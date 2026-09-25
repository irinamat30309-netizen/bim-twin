'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const MeshViewer = require('../renderer/meshviewer.js');
const Section = require('../renderer/section.js');
const DXF = require('../renderer/dxf.js');

function asciiBoxPly() {
  const text = [
    'ply', 'format ascii 1.0',
    'element vertex 8', 'property float x', 'property float y', 'property float z',
    'element face 12', 'property list uchar int vertex_indices', 'end_header',
    '0 0 0', '1 0 0', '1 0 1', '0 0 1',
    '0 1 0', '1 1 0', '1 1 1', '0 1 1',
    '3 0 1 2', '3 0 2 3', '3 4 6 5', '3 4 7 6',
    '3 0 5 1', '3 0 4 5', '3 3 2 6', '3 3 6 7',
    '3 0 3 7', '3 0 7 4', '3 1 5 6', '3 1 6 2', ''
  ].join('\n');
  const bytes = Buffer.from(text, 'utf8');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function binaryDoubleSourceBoxPly() {
  const min = [500000.1234567, 6000000.2345678, 120.125];
  const max = [min[0] + 1, min[1] + 1, min[2] + 1];
  const wkt = 'PROJCRS["Test / local grid",ID["EPSG",990001]]';
  const header = [
    'ply', 'format binary_little_endian 1.0', 'comment up=z',
    'comment coordinate_frame=target-source', 'comment crs_wkt_uri=' + encodeURIComponent(wkt),
    'element vertex 8', 'property double x', 'property double y', 'property double z',
    'element face 12', 'property list uchar int vertex_indices', 'end_header', ''
  ].join('\n');
  const bytes = Buffer.from(header, 'ascii');
  const faces = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 5, 1], [0, 4, 5], [3, 2, 6], [3, 6, 7],
    [0, 3, 7], [0, 7, 4], [1, 5, 6], [1, 6, 2]
  ];
  const payload = Buffer.alloc(8 * 24 + faces.length * 13);
  let off = 0;
  const vertices = [
    [min[0], min[1], min[2]], [max[0], min[1], min[2]],
    [max[0], max[1], min[2]], [min[0], max[1], min[2]],
    [min[0], min[1], max[2]], [max[0], min[1], max[2]],
    [max[0], max[1], max[2]], [min[0], max[1], max[2]]
  ];
  for (const p of vertices) for (const value of p) { payload.writeDoubleLE(value, off); off += 8; }
  for (const face of faces) { payload.writeUInt8(3, off++); for (const i of face) { payload.writeInt32LE(i, off); off += 4; } }
  const out = Buffer.concat([bytes, payload]);
  return { buffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength), min, max, wkt };
}

test('PLY mesh parser → exact section kernel → DXF produces a closed 1×1 plan', () => {
  const scene = MeshViewer._detectAndBuild(asciiBoxPly(), 'box.ply');
  assert.equal(scene.triangles, 12);
  assert.deepEqual(scene.sectionViewTransform, { axis: 'y', center: [0, 0, 0] }, 'ordinary float PLY is not recentered in the GPU buffers');
  const result = Section.meshPlaneSection(scene, Section.axisPlane('y', 0.5, scene.bounds.center));
  assert.equal(result.closedCount, 1);
  assert.equal(result.openCount, 0);
  assert.ok(Math.abs(result.paths[0].length - 4) < 1e-6);
  const dxf = DXF.toDxf(Section.meshSectionToEntities(result, 'MESH_SECTION_Y'));
  assert.equal((dxf.match(/\nPOLYLINE\n/g) || []).length, 1);
  assert.match(dxf, /MESH_SECTION_Y/);
  assert.match(dxf, /\n70\n1\n/);
});

test('double, georeferenced Z-up PLY keeps source precision for exact plan section', () => {
  const fixture = binaryDoubleSourceBoxPly();
  const scene = MeshViewer._detectAndBuild(fixture.buffer, 'world-zup.ply');
  assert.equal(scene.sourceFormat, 'PLY');
  assert.equal(scene.sourceUpAxis, 'z');
  assert.equal(scene.sourceUpAxisKnown, true);
  assert.deepEqual(scene.sectionViewTransform, { axis: 'z', center: fixture.min.map((v, i) => v + 0.5) });
  assert.equal(scene.coordinateFrame, 'target-source');
  assert.equal(scene.sourceCrsWkt, fixture.wkt);
  assert.ok(scene.primitives[0].sectionPositions instanceof Float64Array);
  assert.ok(Math.max(...scene.bounds.hi.map(Math.abs)) < 1, 'display vertices are recentered for GPU precision');
  assert.ok(Math.abs(scene.sectionBounds.lo[0] - fixture.min[0]) < 1e-9);

  const result = Section.meshPlaneSection(scene, Section.axisPlane('z', fixture.min[2] + 0.5, scene.sectionBounds.center));
  assert.equal(result.closedCount, 1);
  const xs = result.paths[0].points.map(p => p[0]), ys = result.paths[0].points.map(p => p[1]);
  assert.ok(Math.abs(Math.min(...xs) - fixture.min[0]) < 1e-8);
  assert.ok(Math.abs(Math.max(...xs) - fixture.max[0]) < 1e-8);
  assert.ok(Math.abs(Math.min(...ys) - fixture.min[1]) < 1e-8);
  assert.ok(Math.abs(Math.max(...ys) - fixture.max[1]) < 1e-8);
});

test('mesh viewer exposes a precise plane-section workflow and documents coordinate limits', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
  const viewer = fs.readFileSync(path.join(root, 'renderer/meshviewer.js'), 'utf8');
  const sectionWorker = fs.readFileSync(path.join(root, 'renderer/mesh-section-worker.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');
  const workspace = fs.readFileSync(path.join(root, 'renderer/lixel-workspace.js'), 'utf8');
  assert.ok(html.includes('meshviewer.js?v=1227'));
  assert.ok(html.includes('section.js?v=1233'));
  assert.ok(html.includes('app.js?v=1249'));
  assert.ok(app.includes("_meshInput.accept = '.glb,.gltf,.obj,.stl,.ply'"));
  assert.ok(workspace.includes("if($('tsMesh')) {app.append($('tsMesh'));"), 'mesh import must be available without opening tour mode');
  for (const text of ['Точное сечение меша', 'meshSectionAxis', 'meshSectionLevel', 'meshSectionPreview', 'meshSectionExport', 'meshSectionCancel', 'meshSectionProgress', 'meshSectionOverlay', 'sectionPositions', 'sourceUpAxis', 'projectSectionPoint', 'исходный меш не обрезан']) {
    assert.ok(viewer.includes(text), `missing mesh section UX: ${text}`);
  }
  assert.match(viewer, /new Worker\(new URL\('mesh-section-worker\.js\?v=1226'/);
  assert.match(viewer, /MESH_SECTION_WORKER_MAX_BYTES = 128 \* 1024 \* 1024/);
  assert.match(sectionWorker, /request\.operation !== 'mesh-section'/);
  assert.match(sectionWorker, /request\.operation|type: 'progress'/);
  assert.match(sectionWorker, /section\.js\?v=1233/);
  assert.ok(viewer.includes('getSectionGeometry'));
  assert.ok(viewer.includes('формат DXF R12 её не переносит'));
  assert.ok(viewer.includes('function resetMeshSectionPanel()'));
  const uploadAt = viewer.indexOf('function uploadScene(scene)');
  const uploadResetAt = viewer.indexOf('resetMeshSectionPanel();', uploadAt);
  const uploadGlAt = viewer.indexOf('var gl = S.gl;', uploadAt);
  assert.ok(uploadResetAt > uploadAt && uploadResetAt < uploadGlAt, 'replace-scene must cancel/reset pending section controls');
  const exitAt = viewer.indexOf('exit: function ()');
  const exitResetAt = viewer.indexOf('resetMeshSectionPanel();', exitAt);
  const exitCloseAt = viewer.indexOf('S.open = false;', exitAt);
  assert.ok(exitResetAt > exitAt && exitResetAt < exitCloseAt, 'exit must reset section panel and stale busy state');
  const syncLoadAt = viewer.indexOf('load: function (arrayBuffer, name)');
  const syncLoadResetAt = viewer.indexOf('resetMeshSectionPanel();', syncLoadAt);
  const asyncLoadAt = viewer.indexOf('loadAsync: function (arrayBuffer, name)');
  const asyncLoadResetAt = viewer.indexOf('resetMeshSectionPanel();', asyncLoadAt);
  assert.ok(syncLoadResetAt > syncLoadAt && syncLoadResetAt < viewer.indexOf('completeMeshLoad', syncLoadAt), 'sync load must reset the panel before replacement');
  assert.ok(asyncLoadResetAt > asyncLoadAt && asyncLoadResetAt < viewer.indexOf('var requestId', asyncLoadAt), 'async load must reset the panel before parsing');
});