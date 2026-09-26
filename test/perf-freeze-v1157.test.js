const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const PCEdit = require('../renderer/pointcloud-edit.js');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', 'renderer', f), 'utf8');

// --- Functional: magicWand must stay fast + correct on a large (>1.5M) cloud ---
// This is the exact freeze scenario the user hit: clicking an object on a
// multi-million-point in-memory cloud used to build a string-keyed Map over
// every point. v1157 gates that behind a bounded neighbourhood pre-filter.
test('magicWand large cloud: bounded + correct + fast', () => {
  const N = 1270;                 // 1270*1270 = 1,612,900 floor points ( >1.5M )
  const floorCount = N * N;
  const blob = 125;               // 5x5x5 raised blob
  const total = floorCount + blob;
  const pos = new Float32Array(total * 3);
  let p = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      pos[p++] = i * 0.1; pos[p++] = j * 0.1; pos[p++] = 0;
    }
  }
  const cx = 63, cy = 63;         // centre of the floor
  let seed = -1;
  for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) for (let c = 0; c < 5; c++) {
    if (a === 2 && b === 2 && c === 2) seed = p / 3;
    pos[p++] = cx + a * 0.05; pos[p++] = cy + b * 0.05; pos[p++] = 0.5 + c * 0.05;
  }
  assert.ok(seed >= floorCount, 'seed is a blob point');

  const t0 = Date.now();
  const idx = PCEdit.magicWand(seed, pos, total, {
    voxel: 0.06, planes: [{ normal: [0, 0, 1], d: 0 }], planeTol: 0.09,
  });
  const dt = Date.now() - t0;

  assert.ok(idx.length >= 120 && idx.length <= 125, 'blob only, got ' + idx.length);
  for (const i of idx) assert.ok(pos[i * 3 + 2] > 0.4, 'no floor point selected');
  // Generous ceiling: the old full-cloud Map build blew well past this.
  assert.ok(dt < 4000, 'magicWand large cloud too slow: ' + dt + 'ms');
});

// --- Source locks: the deferred / bounded-work fixes must stay in place ---
test('magicWand keeps large-cloud neighbourhood pre-filter', () => {
  const src = R('pointcloud-edit.js');
  assert.ok(src.includes('1500000'), 'large-cloud gate missing');
  assert.ok(/_useSub/.test(src), '_useSub neighbourhood filter missing');
});

test('object inspector defers pick behind progress', () => {
  const src = R('lixel-object-inspector.js');
  assert.ok(src.includes('beginProgress'), 'inspector progress missing');
  assert.ok(src.includes('maxPts: 500000'), 'inspector maxPts not lowered');
  assert.ok(src.includes('_strideDown'), 'inspector downsample helper missing');
});

test('object extract defers smart-click behind progress', () => {
  const src = R('lixel-object-extract.js');
  assert.ok(src.includes('beginProgress'), 'extract progress missing');
  assert.ok(src.includes('maxPts: 500000'), 'extract maxPts not lowered');
});

test('scan2bim build is deferred behind progress', () => {
  const src = R('lixel-scan2bim-ui.js');
  assert.ok(src.includes('beginProgress'), 'scan2bim build progress missing');
});

test('smart-save yields before synchronous text export', () => {
  const src = R('lixel-smart-save.js');
  assert.ok(/setTimeout\(r, 30\)[\s\S]*buildCloudPayload/.test(src), 'export yield missing');
  assert.ok(src.includes("version: '1160'"), 'smart-save version not bumped');
});

test('banner bumped to v1157', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(app.includes('готова · v1160'), 'banner not v1157');
});
