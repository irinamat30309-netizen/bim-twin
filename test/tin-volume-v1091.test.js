'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const T = require('../renderer/tin-volume');

test('delaunay2D triangulirует 3 tochki v 1 treugolnik', () => {
  const pts = [[0,0],[1,0],[0,1]];
  const tris = T.delaunay2D(pts);
  assert.equal(tris.length, 1);
  const t = tris[0].slice().sort((a,b)=>a-b);
  assert.deepEqual(t, [0,1,2]);
});

test('delaunay2D: 4 tochki → 2 treugolnika', () => {
  const pts = [[0,0],[1,0],[1,1],[0,1]];
  const tris = T.delaunay2D(pts);
  assert.ok(tris.length >= 2, 'dolzhno byt >= 2 treugolnikov');
});

test('delaunay2D < 3 tochek → pustoy massiv', () => {
  assert.deepEqual(T.delaunay2D([]), []);
  assert.deepEqual(T.delaunay2D([[0,0],[1,1]]), []);
});

test('circumcircle: pravilnaya opisannaya okruzhnost', () => {
  const cc = T.circumcircle([0,0],[2,0],[1,1]);
  assert.ok(cc, 'dolzhno vernut okruzhnost');
  assert.ok(Math.abs(cc.cx - 1) < 1e-8, 'cx ≈ 1');
});

test('circumcircle: vyrozhdennye tochki → null', () => {
  const cc = T.circumcircle([0,0],[0,0],[0,0]);
  assert.equal(cc, null);
});

test('buildTIN stroит TIN iz 4 tochek', () => {
  // 4 tochki v XZ (y-vysota)
  const xz4 = [[0,0],[1,0],[1,1],[0,1]];
  const ys4  = [0,0,0,0];
  const pos = new Float32Array(4*3);
  xz4.forEach((p,i) => { pos[i*3]=p[0]; pos[i*3+1]=ys4[i]; pos[i*3+2]=p[1]; });
  const tin = T.buildTIN(pos, 4, { step:1 });
  assert.ok(tin.triangles.length >= 2, 'Dolzhno byt >= 2 treugolnikov');
  assert.equal(tin.xz.length, 4);
});

test('computeVolume: ploskaya poverkhnost na refY → cut i fill blizki k 0', () => {
  const pts2d = [[0,0],[2,0],[2,2],[0,2]];
  const ys = [1,1,1,1];
  const pos = new Float32Array(4*3);
  pts2d.forEach((p,i)=>{pos[i*3]=p[0];pos[i*3+1]=ys[i];pos[i*3+2]=p[1];});
  const tin = T.buildTIN(pos, 4, {step:1});
  const vol = T.computeVolume(tin, 1.0); // refY = 1.0 (ploskost na etoy vysote)
  assert.ok(Math.abs(vol.net) < 1e-8, 'net volume ≈ 0 pri ploskoy poverkhnosti na refY');
});

test('computeVolume: poverkhnost vyshe refY → cut > 0', () => {
  const pts2d = [[0,0],[2,0],[2,2],[0,2]];
  const ys = [2,2,2,2];
  const pos = new Float32Array(4*3);
  pts2d.forEach((p,i)=>{pos[i*3]=p[0];pos[i*3+1]=ys[i];pos[i*3+2]=p[1];});
  const tin = T.buildTIN(pos, 4, {step:1});
  const vol = T.computeVolume(tin, 0.0);
  assert.ok(vol.cut > 0, 'cut > 0 esli poverkhnost vyshe refY');
  assert.ok(vol.fill < 1e-8, 'fill ≈ 0');
});

test('tinToDxf vozvraschaet stroku s 3DFACE', () => {
  const pts2d = [[0,0],[1,0],[0,1]];
  const ys = [0,0,1];
  const pos = new Float32Array(3*3);
  pts2d.forEach((p,i)=>{pos[i*3]=p[0];pos[i*3+1]=ys[i];pos[i*3+2]=p[1];});
  const tin = T.buildTIN(pos, 3, {step:1});
  const dxf = T.tinToDxf(tin);
  assert.ok(typeof dxf === 'string');
  assert.ok(dxf.includes('3DFACE'), 'dolzhen soderzhat 3DFACE');
});

test('profileToCsv vozvraschaet stroki CSV', () => {
  const profile = [{dist:0,y:10,x:0,z:0},{dist:1,y:11,x:1,z:0}];
  const csv = T.profileToCsv(profile);
  assert.ok(csv.includes('dist_m,height_m'));
  assert.ok(csv.includes('0.0000'));
  assert.ok(csv.includes('1.0000'));
});

test('interpolateY: tochka v treugolnike interpoliruetsya', () => {
  const pts2d = [[0,0],[2,0],[1,2]];
  const ys = [0,0,2];
  const pos = new Float32Array(3*3);
  pts2d.forEach((p,i)=>{pos[i*3]=p[0];pos[i*3+1]=ys[i];pos[i*3+2]=p[1];});
  const tin = T.buildTIN(pos, 3, {step:1});
  const y = T.interpolateY(tin, 1, 0);
  assert.ok(y !== null && y >= 0, 'interpolated Y dolzhen byt >= 0');
});
