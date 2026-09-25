'use strict';
// v1046 — тесты для Phase 1-3: расширенный конвейер обработки облаков точек.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../renderer/pointcloud-edit.js');

// helper: плотная сетка точек в плоскости XY на заданной высоте z
function planeGrid(nx, ny, step, z, x0, y0){
  x0 = x0||0; y0 = y0||0; z = z||0;
  const pos = new Float32Array(nx*ny*3); let k=0;
  for (let i=0;i<nx;i++) for (let j=0;j<ny;j++){ pos[k*3]=x0+i*step; pos[k*3+1]=y0+j*step; pos[k*3+2]=z; k++; }
  return pos;
}

test('cleanRadiusOutliers: удаляет изолированные точки, плотную сетку сохраняет', () => {
  const dense = planeGrid(15,15,0.05,0); // 225 точек, шаг 0.05
  const far = [ [5,5,5],[5.1,5,5],[-4,-4,-4],[8,0,0],[0,8,0] ];
  const pos = new Float32Array(dense.length + far.length*3);
  pos.set(dense,0);
  for (let i=0;i<far.length;i++){ pos[dense.length+i*3]=far[i][0]; pos[dense.length+i*3+1]=far[i][1]; pos[dense.length+i*3+2]=far[i][2]; }
  const r = P.cleanRadiusOutliers({pos}, { radius:0.12, minNeighbors:3 });
  assert.ok(r.removed >= 5, 'должно удалить хотя бы 5 изолированных точек, удалено '+r.removed);
  assert.ok(r.removed <= 12, 'не должно вырезать плотную сетку целиком, удалено '+r.removed);
  // ни одна далёкая точка (|coord|>3) не должна остаться
  const out = r.pos; let hasFar=false;
  for (let i=0;i<out.length/3;i++){ if (Math.abs(out[i*3])>3||Math.abs(out[i*3+1])>3||Math.abs(out[i*3+2])>3){ hasFar=true; break; } }
  assert.ok(!hasFar, 'далёкие изолированные точки должны быть удалены');
});

test('noiseFilterLocalPlane: убирает выступы над локальной поверхностью, плоскость сохраняет', () => {
  // Фильтр по локальной плоскости убирает точки, выступающие над поверхностью там, где есть соседи
  // (шероховатость/«толщина» стен). Далёкий оторванный шум убирает radius outlier / SOR / islands.
  const nx=20, ny=20, step=0.05; const base=new Float32Array(nx*ny*3); let k=0;
  for (let i=0;i<nx;i++) for (let j=0;j<ny;j++){ base[k*3]=i*step; base[k*3+1]=j*step; base[k*3+2]=0; k++; }
  // 12 точек, выступающих над поверхностью на 0.12 м (в пределах соседства вокселя)
  const bump=[]; for (let s=0;s<12;s++){ bump.push([0.1 + (s%4)*0.25, 0.1 + Math.floor(s/4)*0.25, 0.12]); }
  const pos = new Float32Array(base.length + bump.length*3); pos.set(base,0);
  for (let i=0;i<bump.length;i++){ pos[base.length+i*3]=bump[i][0]; pos[base.length+i*3+1]=bump[i][1]; pos[base.length+i*3+2]=bump[i][2]; }
  const r = P.noiseFilterLocalPlane({pos}, { voxel:0.15, k:8, stdRatio:1.0 });
  assert.ok(r.removed >= 8, 'должно удалить выступающие точки, удалено '+r.removed);
  const out = r.pos; let hiZ=0;
  for (let i=0;i<out.length/3;i++){ if (out[i*3+2] > 0.05) hiZ++; }
  assert.ok(hiZ <= 2, 'выступы над поверхностью должны быть в основном удалены, осталось '+hiZ);
  assert.ok(out.length/3 >= 350, 'основная плоскость должна сохраниться');
});

test('voxelDownsample: уменьшает число точек, сохраняет структуру', () => {
  const n = 2000; const pos = new Float32Array(n*3);
  let seed=12345; function rnd(){ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; }
  for (let i=0;i<n;i++){ pos[i*3]=rnd(); pos[i*3+1]=rnd(); pos[i*3+2]=rnd(); }
  const r = P.voxelDownsample({pos}, { voxel:0.25 });
  assert.ok(r.kept < n, 'должно проредить: kept='+r.kept+' < '+n);
  assert.ok(r.kept >= 1, 'должна остаться хотя бы одна точка');
  assert.ok(r.removed > 0, 'removed должно быть > 0');
  assert.ok(r.kept <= 64, 'при вокселе 0.25 в единичном кубе не более 64 ячеек, kept='+r.kept);
});

test('estimateNormals: для плоскости XY нормали ≈ ±Z', () => {
  const pos = planeGrid(30,30,0.03,0); // плотная плоскость z=0
  const nrm = P.estimateNormals({pos}, { voxel:0.08, k:8 });
  assert.strictEqual(nrm.length, pos.length);
  // проверяем внутренние точки (индексы в середине)
  let ok=0, tested=0;
  for (let i=300;i<600;i++){ tested++; if (Math.abs(nrm[i*3+2]) > 0.9) ok++; }
  assert.ok(ok > tested*0.8, 'большинство нормалей должны быть вертикальны: '+ok+'/'+tested);
});

test('classifyStructure: находит пол и стену', () => {
  const floor = planeGrid(40,40,0.1,0);      // z=0, большая горизонталь
  // стена: плоскость x=0 (y,z), нормаль ~X
  const wallN=40, wallM=40, step=0.1; const wall=new Float32Array(wallN*wallM*3); let k=0;
  for (let i=0;i<wallN;i++) for (let j=0;j<wallM;j++){ wall[k*3]=0; wall[k*3+1]=i*step; wall[k*3+2]=j*step; k++; }
  const pos = new Float32Array(floor.length + wall.length);
  pos.set(floor,0); pos.set(wall, floor.length);
  const res = P.classifyStructure({pos}, { tol:0.05 });
  assert.ok(res.counts.floor > 0, 'должен найти пол, floor='+res.counts.floor);
  assert.ok(res.counts.wall > 0, 'должен найти стену, wall='+res.counts.wall);
  assert.ok(res.planes.length >= 2, 'должно быть >= 2 плоскостей');
});

test('cropBox / sliceSection: обрезка и срез работают', () => {
  const pos = planeGrid(20,20,0.1,0);
  const cb = P.cropBox({pos}, [0,0,-1], [0.9,0.9,1]);
  assert.ok(cb.removed > 0 && cb.pos.length/3 > 0, 'cropBox должен что-то оставить и что-то убрать');
  // трёхслойное облако по Z
  const layers = new Float32Array(300*3); let k=0;
  for (let z=0; z<3; z++) for (let i=0;i<100;i++){ layers[k*3]=i*0.01; layers[k*3+1]=0; layers[k*3+2]=z; k++; }
  const sl = P.sliceSection({pos:layers}, { axis:2, at:1, thickness:0.1 });
  assert.strictEqual(sl.pos.length/3, 100, 'срез должен оставить ровно один слой (100 точек)');
});

test('measureDistance / pointToPlaneDistance: корректная геометрия', () => {
  assert.ok(Math.abs(P.measureDistance([0,0,0],[3,4,0]) - 5) < 1e-9);
  const plane = { normal:[0,0,1], d:0 }; // z=0
  assert.ok(Math.abs(P.pointToPlaneDistance([1,2,2.5], plane) - 2.5) < 1e-9);
});

test('registerICP: восстанавливает известное жёсткое преобразование', () => {
  // цель — «бугристая» поверхность (уникальные признаки, не плоскость)
  const nx=25, ny=25, step=0.08; const tp=new Float32Array(nx*ny*3); let k=0;
  for (let i=0;i<nx;i++) for (let j=0;j<ny;j++){ const x=i*step, y=j*step; tp[k*3]=x; tp[k*3+1]=y; tp[k*3+2]=0.3*Math.sin(3*x)+0.2*Math.cos(3*y); k++; }
  // известное преобразование: поворот ~7° вокруг Z + сдвиг
  const ang=7*Math.PI/180, c=Math.cos(ang), s=Math.sin(ang); const tx=0.05, ty=0.04, tz=0.02;
  const n=tp.length/3; const sp=new Float32Array(n*3);
  for (let i=0;i<n;i++){ const x=tp[i*3],y=tp[i*3+1],z=tp[i*3+2]; sp[i*3]=c*x-s*y+tx; sp[i*3+1]=s*x+c*y+ty; sp[i*3+2]=z+tz; }
  const r = P.registerICP({pos:sp}, {pos:tp}, { maxIter:40 });
  assert.ok(r.iterations > 0, 'ICP должен сделать итерации');
  assert.ok(r.rmse < 0.05, 'ICP должен сойтись к малой ошибке (остаточная ≈ шаг дискретизации), rmse='+r.rmse);
});

test('meshHeightGrid / meshToOBJ: строит меш и экспортирует OBJ', () => {
  const pos = planeGrid(20,20,0.1,0);
  const mesh = P.meshHeightGrid({pos}, { cell:0.15 });
  assert.ok(mesh.vertices.length > 0, 'должны быть вершины');
  assert.ok(mesh.indices.length > 0 && mesh.indices.length % 3 === 0, 'индексы кратны 3');
  const obj = P.meshToOBJ(mesh);
  assert.ok(obj.indexOf('v ') >= 0 && obj.indexOf('f ') >= 0, 'OBJ содержит вершины и грани');
});
