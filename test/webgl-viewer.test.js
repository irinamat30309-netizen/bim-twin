const test = require('node:test');
const assert = require('node:assert');
const V = require('../renderer/webgl-viewer.js');
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'webgl-viewer.js'), 'utf8');

test('grade: fragment shader has photorealistic tonemap uniforms', () => {
  for (const u of ['uGrade', 'uExposure', 'uContrast', 'uSaturation', 'uGamma', 'uTone']) {
    assert.ok(SRC.includes('uniform float ' + u + ';'), 'missing uniform ' + u);
  }
  assert.ok(SRC.includes('vec3 aces('), 'missing ACES tonemap function');
});

test('grade: uniforms are registered and driven each frame', () => {
  assert.ok(SRC.includes("'uTone'"), 'uTone not in uniform-location list');
  assert.ok(SRC.includes('gl.uniform1f(this.u.uExposure'), 'uExposure not set in render loop');
});

test('grade: setGrade/getGrade methods exist and default is neutral RGB (off)', () => {
  assert.ok(SRC.includes('setGrade('), 'setGrade method missing');
  assert.ok(SRC.includes('getGrade('), 'getGrade method missing');
  assert.ok(/_grade\s*=\s*\{\s*on:\s*false/.test(SRC), 'grade should not alter RGB by default');
});

test('cloudQuality: exports present', () => {
  assert.strictEqual(typeof V.cloudQuality, 'function');
});

test('cloudQuality: small clouds get largest crisp points', () => {
  const q = V.cloudQuality(500);
  assert.strictEqual(q.pointSize, 1.5);
  assert.strictEqual(q.ptMax, 3.5);
});

test('cloudQuality: mid clouds (~2M) moderate size', () => {
  const q = V.cloudQuality(2000000);
  assert.strictEqual(q.pointSize, 1.3);
  assert.strictEqual(q.ptMax, 3);
});

test('cloudQuality: huge clouds (>6M) smallest size for perf', () => {
  const q = V.cloudQuality(8000000);
  assert.strictEqual(q.pointSize, 1.3);
  assert.strictEqual(q.ptMax, 2.5);
});

test('cloudQuality: monotonic non-increasing size as count grows', () => {
  const counts = [100, 400000, 400001, 1500000, 1500001, 6000000, 6000001, 20000000];
  let prev = Infinity;
  for (const c of counts) {
    const q = V.cloudQuality(c);
    assert.ok(q.pointSize <= prev, 'pointSize should not grow with count at ' + c);
    prev = q.pointSize;
  }
});

test('cloudQuality: CloudCompare-like small points (<= legacy defaults)', () => {
  // Tuned down to mimic CloudCompare's crisp ~1-2px points; every tier must be small.
  assert.ok(V.cloudQuality(8000000).pointSize <= 1.3);
  assert.ok(V.cloudQuality(2000000).pointSize <= 1.3);
  assert.ok(V.cloudQuality(500000).pointSize <= 1.4);
  assert.ok(V.cloudQuality(100).pointSize <= 1.5);
  // caps must stay small so near points do not bloat into big squares
  assert.ok(V.cloudQuality(100).ptMax <= 3.5);
  assert.ok(V.cloudQuality(8000000).ptMax <= 2.5);
});

test('cloudQuality: handles float / non-integer counts (truncates)', () => {
  // 400000.9 | 0 === 400000 -> NOT > 400000 -> stays in smallest-count tier (1.0)
  assert.strictEqual(V.cloudQuality(400000.9).pointSize, 1.5);
  // 400001.9 | 0 === 400001 -> > 400000 -> next tier (1.4)
  assert.strictEqual(V.cloudQuality(400001.9).pointSize, 1.4);
});

test('loadCloud preserves E57 scan point order when adaptive-render shuffle would otherwise run', () => {
  const n=2000001,pos=new Float32Array(n*3);
  pos[3]=1;pos[6]=2;
  const scans=[
    {name:'Station A',start:0,count:1000000},
    {name:'Station B',start:1000000,count:n-1000000}
  ];
  function stubViewer(){
    const v=Object.create(V.Viewer3DGL.prototype);
    v._clearMeasure=()=>{};
    v._estimateSpacing=()=>0;
    v._setBase=objects=>{v.base=objects;v.bbox={mn:[0,0,0],mx:[2,2,2]};};
    v._frame=()=>{};v.render=()=>{};v._notifyCloudChanged=()=>{};
    v._computeCloudDims=()=>null;
    v._lodThreshold=40000000;v._maxSingleBuffer=96000000;
    v._edlAutoTried=true;v._cloudDisplay={};
    v.target=[0,0,0];v._attributeWarnings=[];
    return v;
  }
  const previousInfo=console.info;
  try {
    console.info=()=>{};
    const withScans=stubViewer();let shuffleCalls=0;
    withScans._shuffleCloud=()=>{shuffleCalls++;};
    withScans.loadCloud({pos,count:n,meta:{total:n,scans}}, {sourceName:'large.e57'});
    assert.equal(shuffleCalls,0);
    assert.equal(withScans.base[0]._shuffled,undefined);
    assert.equal(withScans.base[0].pos[3],1);
    assert.equal(withScans.base[0].pos[6],2);
    assert.deepEqual(withScans._srcMeta.scans,scans);

    const withoutScans=stubViewer();let ordinaryShuffleCalls=0;
    withoutScans._shuffleCloud=()=>{ordinaryShuffleCalls++;};
    withoutScans.loadCloud({pos,count:n,meta:{total:n}}, {sourceName:'large.ply'});
    assert.equal(ordinaryShuffleCalls,1,'ordinary large clouds keep the existing interaction optimization');
    assert.equal(withoutScans.base[0]._shuffled,true);
  } finally {
    console.info=previousInfo;
  }
});

test('loadColoredMesh: replaces source CRS metadata instead of keeping a stale cloud frame', () => {
  const v = Object.create(V.Viewer3DGL.prototype);
  v._clearMeasure = () => {};
  v._setBase = () => {};
  v._computeModelDims = () => null;
  v._frame = () => {};
  v.render = () => {};
  const mesh = { pos: new Float32Array(9), nor: new Float32Array(9), col: null,
    meta: { srcXform: { axis: 'zup', t: [500000, 6000000, 100] }, crsWkt: 'EPSG:32610' } };
  v.loadColoredMesh(mesh);
  assert.deepEqual(v._srcXform, mesh.meta.srcXform);
  assert.equal(v._srcCrs, 'EPSG:32610');
  v.loadColoredMesh({ pos: new Float32Array(9), nor: new Float32Array(9), meta: {} });
  assert.equal(v._srcXform, null);
  assert.equal(v._srcCrs, null);
});
