const test = require('node:test');
const assert = require('node:assert');
const PCEdit = require('../renderer/pointcloud-edit.js');

function scene(){
  const pos=[]; const col=[];
  for(let i=0;i<40;i++)for(let j=0;j<40;j++){ pos.push(i*0.1, j*0.1, 0); col.push(0.5,0.5,0.5); }
  for(let a=0;a<5;a++)for(let b=0;b<5;b++)for(let c=0;c<5;c++){ pos.push(1.0+a*0.05, 1.0+b*0.05, 0.5+c*0.05); col.push(1,0,0); }
  return { pos:new Float32Array(pos), col:new Float32Array(col), count: pos.length/3 };
}

test('detectPlanes finds floor', () => {
  const s=scene();
  const planes=PCEdit.detectPlanes(s.pos,s.count,{});
  assert.ok(planes.length>=1, 'at least one plane');
  const top=planes[0];
  assert.strictEqual(top.axis,'floor/ceiling');
  assert.ok(Math.abs(top.normal[2])>0.9, 'normal up');
  assert.ok(Math.abs(top.d)<0.05, 'd near 0');
});

test('detectPlanes empty', () => {
  assert.deepStrictEqual(PCEdit.detectPlanes(new Float32Array(0),0,{}), []);
});

test('protectPlanes keeps blob', () => {
  const s=scene();
  const all=[]; for(let i=0;i<s.count;i++) all.push(i);
  const kept=PCEdit.protectPlanes(all, s.pos, [{normal:[0,0,1],d:0}], 0.09);
  assert.strictEqual(kept.length, 125);
});

test('magicWand floods blob only', () => {
  const s=scene();
  const idx=PCEdit.magicWand(1600, s.pos, s.count, { voxel:0.06, planes:[{normal:[0,0,1],d:0}], planeTol:0.09 });
  assert.ok(idx.length>=120 && idx.length<=125, 'blob '+idx.length);
  for(const i of idx){ assert.ok(s.pos[i*3+2]>0.4, 'no floor'); }
});

test('selectByColor red blob', () => {
  const s=scene();
  const idx=PCEdit.selectByColor(s.col, s.count, [255,0,0], { tol:40 });
  assert.strictEqual(idx.length, 125);
  for(const i of idx){ assert.ok(s.pos[i*3+2]>0.4); }
});

test('selectBySphere blob', () => {
  const s=scene();
  const idx=PCEdit.selectBySphere(s.pos, s.count, [1.1,1.1,0.6], 0.25);
  assert.strictEqual(idx.length, 125);
});

test('selectByBox blob', () => {
  const s=scene();
  const idx=PCEdit.selectByBox(s.pos, s.count, [0.9,0.9,0.4], [1.3,1.3,0.8]);
  assert.strictEqual(idx.length, 125);
});

test('cleanStatisticalOutliers removes far points', () => {
  const pts=[]; const dense=500;
  for(let a=0;a<10;a++)for(let b=0;b<10;b++)for(let c=0;c<5;c++){ pts.push(a*0.02,b*0.02,c*0.02); }
  [[5,5,5],[6,0,0],[0,6,0],[0,0,6],[-5,-5,-5]].forEach(o=>pts.push(o[0],o[1],o[2]));
  const r=PCEdit.cleanStatisticalOutliers({pos:new Float32Array(pts),col:null},{k:8,stdRatio:2.0});
  assert.ok(r.removed>=5, 'removed '+r.removed);
  assert.ok(r.pos.length/3 >= dense*0.6, 'core kept '+(r.pos.length/3));
  for(let i=0;i<r.pos.length/3;i++){ assert.ok(Math.abs(r.pos[i*3])<1 && Math.abs(r.pos[i*3+1])<1 && Math.abs(r.pos[i*3+2])<1); }
});
