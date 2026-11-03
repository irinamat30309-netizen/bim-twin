'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const W = require('../renderer/wall-detect');

test('distPtLine: tochka na pryamoy → dist ≈ 0', () => {
  const d = W.distPtLine([1,1],[0,0],[2,2]);
  assert.ok(d < 1e-10);
});

test('distPtLine: tochka perpendiculyarno → pravilnoe rasstoyanie', () => {
  const d = W.distPtLine([0,1],[0,0],[1,0]);
  assert.ok(Math.abs(d - 1) < 1e-10);
});

test('ransacLine: nakhodit gorizontalnuyu liniyu', () => {
  const pts = [];
  for (let i = 0; i < 20; i++) pts.push([i * 0.1, 0 + (Math.random() - 0.5) * 0.01]);
  // poperechnye shumy
  for (let i = 0; i < 5; i++) pts.push([Math.random(), Math.random() * 5]);
  const line = W.ransacLine(pts, { threshold: 0.05, iters: 500, minLen: 0.5 });
  assert.ok(line !== null, 'dolzhen naiti liniyu');
  assert.ok(line.inlierCount >= 15, 'minimum 15 inlayerov');
  assert.ok(line.length > 0.5, 'dlina > 0.5');
});

test('ransacLine: < 2 tochek → null', () => {
  assert.equal(W.ransacLine([]), null);
  assert.equal(W.ransacLine([[0,0]]), null);
});

test('detectWalls: nakhodit 2 steny v krestoobraznom oblake', () => {
  const pts = [];
  for (let i = 0; i < 30; i++) pts.push([i * 0.1, 0 + (Math.random()-0.5)*0.01]); // gorizontalnaya
  for (let i = 0; i < 30; i++) pts.push([0 + (Math.random()-0.5)*0.01, i*0.1]);   // vertikalnaya
  const walls = W.detectWalls(pts, { threshold:0.06, minInliers:8, minLen:0.3, iters:300 });
  assert.ok(walls.length >= 1, 'dolzhen naiti >= 1 steny');
});

test('intersectLines: pravilnoe peresechenie', () => {
  const pt = W.intersectLines([0,0],[2,0],[1,-1],[1,1]);
  assert.ok(pt !== null);
  assert.ok(Math.abs(pt[0]-1) < 1e-8 && Math.abs(pt[1]-0) < 1e-8);
});

test('intersectLines: parallelnye → null', () => {
  const pt = W.intersectLines([0,0],[1,0],[0,1],[1,1]);
  assert.equal(pt, null);
});

test('wallsToDxf: vozvraschaet stroku s DXF', () => {
  const walls = [
    { a:[0,0], b:[1,0] },
    { a:[1,0], b:[1,1] }
  ];
  const dxf = W.wallsToDxf(walls, null);
  assert.ok(typeof dxf === 'string');
  assert.ok(dxf.includes('LINE'));
  assert.ok(dxf.includes('WALLS'));
});

test('autoFloorPlan: na bolshom oblake → nahodит steny', () => {
  const pts = [];
  for (let i = 0; i < 40; i++) pts.push([i*0.05, 0 + (Math.random()-0.5)*0.01]);
  for (let i = 0; i < 40; i++) pts.push([2, i*0.05 + (Math.random()-0.5)*0.01]);
  for (let i = 0; i < 40; i++) pts.push([i*0.05, 2 + (Math.random()-0.5)*0.01]);
  for (let i = 0; i < 40; i++) pts.push([0, i*0.05 + (Math.random()-0.5)*0.01]);
  const result = W.autoFloorPlan(pts, { threshold:0.06, minInliers:10, iters:400, minLen:0.3 });
  assert.ok(result.walls.length >= 1, 'naydena >= 1 stena');
  assert.ok(typeof result.dxf === 'string');
  assert.ok(result.ptCount === pts.length);
});
