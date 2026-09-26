'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const T = require('../renderer/terrain');

function makeFlatCloud(n, y) {
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i*3]   = (i % 10) * 0.5;
    pos[i*3+1] = y + (Math.random()-0.5)*0.02;
    pos[i*3+2] = Math.floor(i / 10) * 0.5;
  }
  return pos;
}

test('csfClassify: ploskoe oblako → vse tochki = ground', () => {
  const n = 100;
  const pos = makeFlatCloud(n, 0);
  const res = T.csfClassify(pos, n, { cellSize:0.6, iterations:100, threshold:0.3 });
  assert.ok(res.groundCount > n * 0.8, 'bolshinstvo tochek = ground');
  assert.ok(res.labels instanceof Uint8Array);
  assert.equal(res.labels.length, n);
});

test('csfClassify: oblako s shumami vyше → razdelyaet klassy', () => {
  const n = 100;
  const pos = makeFlatCloud(n, 0);
  // dobavlyaem "kryshi" v verkhniy ryad
  for (let i = 0; i < 10; i++) pos[i*3+1] = 3;
  const res = T.csfClassify(pos, n, { cellSize:0.6, iterations:100, threshold:0.3 });
  // dolzhen byt < 100 ground
  assert.ok(res.groundCount < n, 'ne vse tochki ground (est shumy vyше)');
});

test('csfClassify: razdelyaet pol i potolok v komnate', () => {
  const nx = 12, nz = 8, pos = new Float32Array(nx * nz * 2 * 3);
  let p = 0;
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    // Two returns share the same plan cell: floor at 2m and ceiling at 5m.
    for (const y of [2, 5]) { pos[p++] = x * 0.5; pos[p++] = y; pos[p++] = z * 0.5; }
  }
  const res = T.csfClassify(pos, pos.length / 3, { cellSize: 0.5, threshold: 0.15 });
  assert.ok(res.groundCount >= nx * nz - 2, 'floor should remain ground');
  assert.ok(res.groundCount <= nx * nz + 2, 'ceiling must not diffuse into ground');
  assert.equal(res.method, 'progressive-morphological');
});

test('csfClassify: dalyokiy выброс не портит сетку и остаётся neground', () => {
  const nx = 20, nz = 20, pos = new Float32Array((nx * nz + 1) * 3);
  let p = 0;
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    pos[p++] = x * 0.5; pos[p++] = 0; pos[p++] = z * 0.5;
  }
  const outlier = nx * nz;
  pos[p++] = 1000; pos[p++] = 500; pos[p++] = 1000;
  const res = T.csfClassify(pos, outlier + 1, { cellSize: 0.5, outlierQuantile: 0.01 });
  assert.equal(res.labels[outlier], 0);
  assert.ok(res.excludedCount >= 1);
  assert.ok(res.nx < 100 && res.nz < 100, 'distant return must not explode the grid');
});

test('buildDTM: builds a ground-only grid and reports interpolated cells', () => {
  const nx = 4, nz = 3, pos = new Float32Array(nx * nz * 2 * 3), labels = new Uint8Array(nx * nz * 2);
  let p = 0, j = 0;
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    pos[p++] = x; pos[p++] = 10 + x + z; pos[p++] = z; labels[j++] = 1;
    pos[p++] = x; pos[p++] = 20 + x + z; pos[p++] = z; labels[j++] = 0;
  }
  const dtm = T.buildDTM(pos, labels.length, { cell: 1, labels });
  assert.equal(dtm.validCount, nx * nz);
  assert.equal(dtm.interpolatedCells, 0);
  assert.equal(dtm.grid[0], 10);
  assert.equal(dtm.grid[(nz - 1) * dtm.nx + (nx - 1)], 15);
});

test('buildDSM: stroit setku po oblaku', () => {
  const n = 64;
  const pos = makeFlatCloud(n, 5);
  const dsm = T.buildDSM(pos, n, { cell: 1.0 });
  assert.ok(dsm !== null);
  assert.ok(dsm.nx > 0 && dsm.nz > 0);
  assert.ok(dsm.grid instanceof Float32Array);
  assert.equal(dsm.validPointCount, n);
  assert.equal(dsm.validCells + dsm.interpolatedCells, dsm.grid.length);
});

test('buildDSM: ignores invalid points and caps a grid expanded by a distant return', () => {
  const pos = new Float64Array([0,10,0, 1,11,1, 10000,50,10000, NaN,4,2]);
  const dsm = T.buildDSM(pos, 4, { cell: 0.5, maxGridCells: 4096 });
  assert.ok(dsm.grid.length <= 4096);
  assert.ok(dsm.cell > 0.5, 'effective cell should coarsen to protect memory');
  assert.equal(dsm.sourcePointCount, 4);
  assert.equal(dsm.validPointCount, 3);
  assert.ok(dsm.grid.every(Number.isFinite), 'nearest-cell fill should not leave invalid raster values');
  assert.equal(dsm.validCells + dsm.interpolatedCells, dsm.grid.length);
});

test('buildDSM: reports nearest-cell interpolation instead of a global mean', () => {
  const pos = new Float32Array([0,10,0, 1,20,1]);
  const dsm = T.buildDSM(pos, 2, { cell: 1 });
  assert.equal(dsm.validCells, 2);
  assert.equal(dsm.interpolatedCells, 2);
  assert.deepEqual([...dsm.grid], [10,10,10,20]);
});

test('buildContours: stroit izholinii na prostom DSM', () => {
  const n = 64;
  const pos = makeFlatCloud(n, 10);
  const dsm = T.buildDSM(pos, n, { cell: 0.7 });
  const contours = T.buildContours(dsm, { interval: 1.0 });
  assert.ok(Array.isArray(contours));
  // dolzhna byt hotya by odna izholinia ryadom s y=10
  assert.ok(contours.length > 0);
});

test('contoursToDxf: vozvraschaet DXF stroku', () => {
  const n = 64;
  const pos = makeFlatCloud(n, 5);
  const dsm = T.buildDSM(pos, n, { cell:1.0 });
  const contours = T.buildContours(dsm, { interval:2.0 });
  const dxf = T.contoursToDxf(contours);
  assert.ok(typeof dxf === 'string');
  assert.ok(dxf.includes('CONTOURS') || dxf.includes('ENTITIES'));
});

test('dsmToTiff: vozvraschaet ArrayBuffer pravilnogo razm', () => {
  const n = 25;
  const pos = makeFlatCloud(n, 3);
  const dsm = T.buildDSM(pos, n, { cell:1.0 });
  const buf = T.dsmToTiff(dsm);
  assert.ok(buf instanceof ArrayBuffer);
  assert.ok(buf.byteLength > 100);
  // Proverяem TIFF signature: 'II' + 42
  const dv = new DataView(buf);
  assert.equal(dv.getUint8(0), 0x49); // I
  assert.equal(dv.getUint8(1), 0x49); // I
  assert.equal(dv.getUint16(2, true), 42); // magic
});

test('classStats: vozvraschaet statistiku po klassam', () => {
  const n = 10;
  const pos = new Float32Array(n*3);
  for (let i=0;i<n;i++){pos[i*3]=i;pos[i*3+1]=i<5?0:5;pos[i*3+2]=0;}
  const labels = new Uint8Array(n);
  for (let i=0;i<5;i++) labels[i]=1; // pervye 5 = ground
  const s = T.classStats(pos, n, labels);
  assert.ok(s.ground.min < s.ground.max + 1e-9);
  assert.ok(isFinite(s.nonGround.max));
});
