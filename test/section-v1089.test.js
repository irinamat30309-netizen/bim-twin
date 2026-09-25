'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../renderer/section.js');
function closedPerimeter(p){return S.perim(p.concat([p[0]]));}
function signedArea(p){let a=0;for(let i=0;i<p.length;i++){const q=p[(i+1)%p.length];a+=p[i][0]*q[1]-q[0]*p[i][1];}return a/2;}
test('diagonally touching cells stay two simple contours, not figure-eight',()=>{
 const g={occ:new Uint8Array([1,0,0,1]),nx:2,ny:2,mn:[0,0],cell:1};
 const ls=S.traceContours(g);assert.equal(ls.length,2);ls.forEach(l=>{assert.equal(closedPerimeter(l),4);assert.equal(signedArea(l),1);assert.equal(new Set(l.map(String)).size,l.length);});
});
test('one-cell wall ring has distinct outer and inner loops with exact perimeter/area',()=>{
 const nx=5,ny=4,occ=new Uint8Array(nx*ny);
 for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)occ[y*nx+x]=(x===0||y===0||x===nx-1||y===ny-1)?1:0;
 const ls=S.traceContours({occ,nx,ny,mn:[0,0],cell:1});assert.equal(ls.length,2);
 assert.deepEqual(ls.map(closedPerimeter).sort((a,b)=>a-b),[10,18]);
 assert.deepEqual(ls.map(signedArea).sort((a,b)=>a-b),[-6,20]);
});
test('thin 4x3 room preserves separate boundaries on original zero-thickness fixture',()=>{
 const p=[];for(let x=0;x<=4.0001;x+=.05)p.push(x,0,0,x,0,3);for(let z=0;z<=3.0001;z+=.05)p.push(0,0,z,4,0,z);
 const r=S.sectionToPolylines(new Float32Array(p),p.length/3,{level:0,thickness:.2,cell:.2});
 assert.equal(r.loops.length,2);assert.ok(Math.abs(r.loops[0].perim-14.8)<1e-5);assert.ok(Math.abs(r.loops[1].perim-13.2)<1e-5);
});
test('RDP uses distance to finite segment, retains reversals',()=>{assert.equal(S.perpDist([3,0],[0,0],[1,0]),2);assert.deepEqual(S.simplifyRDP([[0,0],[3,0],[1,0]],.1),[[0,0],[3,0],[1,0]]);});
test('grid allocation is bounded before allocation',()=>{assert.throws(()=>S.gridOccupancy([[0,0],[1e6,1e6]],.01),RangeError);});
test('invalid slice parameters rejected, nonfinite input points excluded',()=>{
 assert.throws(()=>S.sliceSlab([0,0,0],2,{}),RangeError);assert.throws(()=>S.sliceSlab([0,0,0],1,{axis:'q'}),RangeError);
 assert.throws(()=>S.sliceSlab([0,0,0],1,{thickness:-1}),RangeError);assert.throws(()=>S.gridOccupancy([[0,0]],Infinity),RangeError);
 assert.equal(S.sliceSlab([NaN,0,0,1,0,2],2,{thickness:.1}).pts.length,1);
});
test('all three axes project and include exact slab boundaries',()=>{
 const p=[1,2,3,1,4,3];
 assert.deepEqual(S.sliceSlab(p,2,{axis:'x',level:1,thickness:1}).pts,[[3,2],[3,4]]);
 assert.deepEqual(S.sliceSlab(p,2,{axis:'z',level:3,thickness:1}).pts,[[1,2],[1,4]]);
 assert.equal(S.sliceSlab(p,2,{axis:'y',level:3,thickness:2}).pts.length,2);
});
test('empty slice returns no fabricated geometry',()=>{const r=S.sectionToPolylines([0,10,0],1,{level:0,thickness:.1,cell:.1});assert.deepEqual(r.loops,[]);assert.equal(r.sliced,0);});
test('изолированная ячейка отсекается по площади, порог 0 сохраняет геометрию',()=>{
 const p=new Float32Array([0,0,0]),filtered=S.sectionToPolylines(p,1,{level:0,thickness:.1,cell:.1});
 assert.equal(filtered.loops.length,0);assert.equal(filtered.discardedSmall,1);assert.equal(filtered.sliced,1);
 const all=S.sectionToPolylines(p,1,{level:0,thickness:.1,cell:.1,minArea:0});
 assert.equal(all.loops.length,1);assert.equal(all.discardedSmall,0);assert.ok(Math.abs(all.loops[0].area-.01)<1e-9);
 assert.throws(()=>S.sectionToPolylines(p,1,{level:0,thickness:.1,cell:.1,minArea:-1}),RangeError);
});
test('вертикальные X/Z-сечения строят контуры в правильных плоскостях',()=>{
 function fixture(axis){
  const p=[],level=5,step=.05;
  const world=(u,v)=>axis==='x'?[level,v,u]:[u,v,level];
  for(let t=0;t<=.2001;t+=.1){
   for(let u=0;u<=4.0001;u+=step){p.push(...world(u,t));p.push(...world(u,3-t));}
   for(let v=0;v<=3.0001;v+=step){p.push(...world(t,v));p.push(...world(4-t,v));}
  }
  return {pos:new Float32Array(p),count:p.length/3};
 }
 for(const axis of ['x','z']){
  const c=fixture(axis),r=S.sectionToPolylines(c.pos,c.count,{axis,level:5,thickness:.2,cell:.2});
  assert.ok(r.loops.length>=1,axis+'-сечение должно дать минимум один контур');
  const bb=S.bbox2d(r.loops[0].points);
  assert.ok(bb.mx[0]-bb.mn[0]>3.6&&bb.mx[0]-bb.mn[0]<4.5,axis+'-сечение должно сохранить ширину');
  assert.ok(bb.mx[1]-bb.mn[1]>2.6&&bb.mx[1]-bb.mn[1]<3.5,axis+'-сечение должно сохранить высоту');
 }
});
test('new scripts wired and translation preserves SVG labels',()=>{
 const fs=require('node:fs'),path=require('node:path'),rd=n=>fs.readFileSync(path.join(__dirname,'../renderer',n),'utf8');
 assert.ok(rd('index.html').includes('lixel-workspace.js?v=1232'));assert.ok(rd('index.html').includes('section.js?v=1233'));
 assert.ok(rd('i18n.js').includes(':scope > .lx-blabel'));assert.ok(rd('app.js').includes("_be.querySelector('.lx-blabel, .lbl')"));
});
