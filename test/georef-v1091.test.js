'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const G = require('../renderer/georef');

test('helmert3D: identichnost preobrazovanie (s=1, R=I, t=0)', () => {
  const pts = [[0,0,0],[1,0,0],[0,1,0],[0,0,1],[1,1,1]];
  const T = G.helmert3D(pts, pts);
  assert.ok(T !== null);
  assert.ok(Math.abs(T.scale - 1) < 1e-6, 'scale ≈ 1');
  assert.ok(T.rms < 1e-6, 'RMS ≈ 0');
});

test('helmert3D: masshtabirovaniye v 2x', () => {
  const src = [[0,0,0],[1,0,0],[0,1,0],[1,1,0]];
  const dst = src.map(p => [p[0]*2, p[1]*2, p[2]*2]);
  const T = G.helmert3D(src, dst);
  assert.ok(T !== null);
  assert.ok(Math.abs(T.scale - 2) < 1e-4, 'scale ≈ 2');
  assert.ok(T.rms < 0.01, 'malyy RMS');
});

test('helmert3D: chistyy sdvig', () => {
  const src = [[0,0,0],[1,0,0],[0,1,0],[1,1,1]];
  const dt = [5, 3, -2];
  const dst = src.map(p => [p[0]+dt[0],p[1]+dt[1],p[2]+dt[2]]);
  const T = G.helmert3D(src, dst);
  assert.ok(T !== null);
  assert.ok(T.rms < 0.01);
  const tp = G.transformPt(src[0], T.scale, T.R, T.t);
  assert.ok(Math.abs(tp[0]-dst[0][0]) < 0.01);
});

test('helmert3D: povorot (Y) + masshtab + sdvig vosstanavlivayutsya tochno', () => {
  // Регрессия: R = U*diag*V^T (не V*diag*U^T) — иначе R получается транспонированной
  // (обратной) матрицей и georef/ICP выравнивает облако в неверную сторону.
  const deg = 37, r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const R0 = { rows: 3, cols: 3, data: new Float64Array([c, 0, s, 0, 1, 0, -s, 0, c]) };
  const scale0 = 1.7, t0 = [5, -3, 2];
  const src = [[0,0,0],[1,0,0],[0,1,0],[0,0,1],[2,3,1],[-1,2,0.5],[3,-1,2]];
  const dst = src.map(p => {
    const rp = G.transformPt(p, 1, R0, [0,0,0]);
    return [rp[0]*scale0+t0[0], rp[1]*scale0+t0[1], rp[2]*scale0+t0[2]];
  });
  const T = G.helmert3D(src, dst);
  assert.ok(T !== null);
  assert.ok(Math.abs(T.scale - scale0) < 1e-6, 'scale vosstanovlen');
  assert.ok(T.rms < 1e-6, 'RMS ≈ 0 (tochnoye sovpadeniye, bez shuma): ' + T.rms);
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(T.R.data[i] - R0.data[i]) < 1e-6, 'R sovpadaet s ishodnoy (ne transponirovana)');
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(T.t[i] - t0[i]) < 1e-4, 'sdvig vosstanovlen');
});

test('helmert3D: menshe 3 tochek → null', () => {
  assert.equal(G.helmert3D([[0,0,0],[1,0,0]], [[0,0,0],[1,0,0]]), null);
});

test('applyTransform: preobrazuet massiv tochek', () => {
  const pos = new Float32Array([0,0,0, 1,0,0, 0,1,0]);
  const T = { scale:1, R:{data:[1,0,0,0,1,0,0,0,1]}, t:[1,2,3] };
  // R должна byt matritsey 3x3
  T.R = { rows:3, cols:3, data:new Float64Array([1,0,0,0,1,0,0,0,1]) };
  const out = G.applyTransform(pos, 3, T);
  assert.ok(Math.abs(out[0] - 1) < 1e-6);
  assert.ok(Math.abs(out[1] - 2) < 1e-6);
  assert.ok(Math.abs(out[2] - 3) < 1e-6);
});

test('GCPManager.add + solve → rezsidualnoye RMS', () => {
  const gm = new G.GCPManager();
  const src = [[0,0,0],[10,0,0],[0,10,0],[10,10,0]];
  const dst = src.map(p => [p[0]+100, p[1]+200, p[2]+50]);
  src.forEach((s,i) => gm.add('GCP'+(i+1), s, dst[i]));
  const T = gm.solve();
  assert.ok(T !== null);
  assert.ok(T.rms < 0.01);
  assert.ok(T.gcpCount === 4);
  assert.ok(Array.isArray(T.residuals));
});

test('GCPManager.toCSV vozvraschaet CSV', () => {
  const gm = new G.GCPManager();
  gm.add('P1', [0,0,0], [1,1,1]);
  const csv = gm.toCSV();
  assert.ok(csv.includes('src_x'));
  assert.ok(csv.includes('P1'));
});

test('det3: opredelitel edinichnoy matritsy = 1', () => {
  const I = { data: new Float64Array([1,0,0,0,1,0,0,0,1]) };
  assert.ok(Math.abs(G.det3(I) - 1) < 1e-10);
});

test('matInverse: obratnaya k edinichnoy = edinichnaya', () => {
  const I = { rows:3, cols:3, data:new Float64Array([1,0,0,0,1,0,0,0,1]) };
  const Inv = G.matInverse(I);
  assert.ok(Inv !== null);
  assert.ok(Math.abs(Inv.data[0] - 1) < 1e-10);
  assert.ok(Math.abs(Inv.data[4] - 1) < 1e-10);
});

test('helmert3D: planar GCPs keep a full orthonormal 3D rotation', () => {
  const a=0.43,c=Math.cos(a),s=Math.sin(a),R0={rows:3,cols:3,data:new Float64Array([1,0,0,0,c,-s,0,s,c])};
  const src=[[0,0,0],[10,0,0],[0,10,0],[10,10,0]],dst=src.map(p=>G.transformPt(p,1.25,R0,[500000,6000000,100]));
  const T=G.helmert3D(src,dst);
  assert.ok(T);assert.ok(T.rms<1e-6);assert.ok(Math.abs(T.scale-1.25)<1e-7);
  const off=[2,3,4],expected=G.transformPt(off,1.25,R0,[500000,6000000,100]),actual=G.transformPt(off,T.scale,T.R,T.t);
  for(let i=0;i<3;i++)assert.ok(Math.abs(actual[i]-expected[i])<1e-5);
  const r=T.R.data;for(let i=0;i<3;i++)for(let j=0;j<3;j++){let v=0;for(let k=0;k<3;k++)v+=r[i*3+k]*r[j*3+k];assert.ok(Math.abs(v-(i===j?1:0))<1e-8);}
  assert.ok(Math.abs(G.det3(T.R)-1)<1e-8);
});

test('helmert3D: collinear GCPs are rejected', () => {
  assert.equal(G.helmert3D([[0,0,0],[1,0,0],[2,0,0]],[[10,20,30],[11,20,30],[12,20,30]]),null);
});

test('applyTransform: retains millimetres at geodetic magnitudes', () => {
  const I={rows:3,cols:3,data:new Float64Array([1,0,0,0,1,0,0,0,1])};
  const p=new Float64Array([500000.001,6000000.002,100.003]);
  const out=G.applyTransform(p,1,{scale:1,R:I,t:[0,0,0]});
  assert.ok(out instanceof Float64Array);
  assert.ok(Math.abs(out[0]-p[0])<1e-9);assert.ok(Math.abs(out[1]-p[1])<1e-9);assert.ok(Math.abs(out[2]-p[2])<1e-9);
});

test('toViewerCloud: centres target XYZ and retains an invertible source transform', () => {
  const world=new Float64Array([500000.012,6000000.023,104.034,500002.045,6000003.056,105.067]);
  const intensity=new Float32Array([0.25,0.75]),classification=new Uint8Array([2,6]);
  const c=G.toViewerCloud(world,null,{crsWkt:'PROJCRS["Test"]',intensity,classification}),t=c.meta.srcXform.t;
  assert.equal(c.meta.srcXform.axis,'zup');assert.equal(c.meta.crsWkt,'PROJCRS["Test"]');
  assert.equal(c.intensity,intensity);assert.equal(c.classification,classification);
  for(let i=0;i<world.length/3;i++){
    assert.ok(Math.abs((c.pos[i*3]+t[0])-world[i*3])<1e-5);
    assert.ok(Math.abs((-c.pos[i*3+2]+t[1])-world[i*3+1])<1e-5);
    assert.ok(Math.abs((c.pos[i*3+1]+t[2])-world[i*3+2])<1e-5);
  }
  assert.throws(()=>G.toViewerCloud(world,null,{intensity:new Float32Array([0.1])}),/интенсивности/);
});

test('compareCrsWkt: recognizes equivalent EPSG, mismatch, and unknown', () => {
  assert.equal(G.compareCrsWkt('PROJCRS["Grid A",ID["EPSG",32610]]','PROJCRS["Grid B",ID["EPSG",32610]]'),'same');
  assert.equal(G.compareCrsWkt('PROJCRS["Grid A",ID["EPSG",32610]]','PROJCRS["Grid B",ID["EPSG",32611]]'),'different');
  assert.equal(G.compareCrsWkt('EPSG:32610','EPSG:32611'),'different');
  assert.equal(G.compareCrsWkt('LOCAL_CS["A"]','LOCAL_CS["B"]'),'unknown');
  assert.equal(G.compareCrsWkt('PROJCRS["Custom A",BASEGEOGCRS["WGS",ID["EPSG",4326]],CONVERSION["A"]]','PROJCRS["Custom B",BASEGEOGCRS["WGS",ID["EPSG",4326]],CONVERSION["B"]]'),'unknown');
  assert.equal(G.compareCrsWkt(null,'PROJCRS["Grid",ID["EPSG",32610]]'),'unknown');
  assert.equal(G.compareCrsWkt(' PROJCRS["Same"] ','PROJCRS["Same"]'),'same');
});

test('weighted Helmert uses observation weights and rejects invalid weights', () => {
  const src=[[0,0,0],[10,0,0],[0,10,0],[0,0,10],[5,3,7]];
  const dst=src.map(p=>[p[0]+500000,p[1]+6000000,p[2]+120]);
  dst[4]=[dst[4][0]+1,dst[4][1]-1,dst[4][2]+0.5];
  const unweighted=G.helmert3D(src,dst);
  const weighted=G.helmert3D(src,dst,[1,1,1,1,0.001]);
  assert.ok(unweighted && weighted);
  assert.ok(weighted.rms<unweighted.rms);
  const p=G.transformPt([2,4,6],weighted.scale,weighted.R,weighted.t);
  assert.ok(Math.abs(p[0]-500002)<0.01);
  assert.ok(Math.abs(p[1]-6000004)<0.01);
  assert.ok(Math.abs(p[2]-126)<0.01);
  assert.equal(G.helmert3D(src,dst,[1,1,0,1,1]),null);
  assert.equal(G.helmert3D(src,dst,[1,1]),null);
});

test('GCPManager separates independent checks and robustly downweights a control outlier', () => {
  const src=[[0,0,0],[10,0,0],[0,10,0],[0,0,10],[10,10,3],[5,2,7]];
  const dst=src.map(p=>[p[0]+100,p[1]+200,p[2]+50]);
  dst[5]=[dst[5][0]+3,dst[5][1]-2,dst[5][2]+1];
  const gm=new G.GCPManager();
  src.forEach((p,i)=>gm.add('C'+i,p,dst[i],{weight:i===4?4:1}));
  gm.add('CHECK-1',[2,3,4],[102,203,54],{role:'check',sigma:0.01});
  const solved=gm.solve({robust:true});
  assert.ok(solved);
  assert.equal(solved.controlCount,6);
  assert.equal(solved.checkCount,1);
  assert.ok(solved.robustIterations>0);
  assert.ok(solved.robustWeights[5]<0.01,'gross control outlier should be visibly downweighted');
  assert.ok(solved.checkRms<1e-3,'independent check point is not used in fit and validates the transform');
  assert.ok(solved.maxControlResidual>3);
  assert.ok(solved.warnings.includes('control_outlier_downweighted'));
  assert.equal(solved.residualCovariance.length,3);
  assert.ok(solved.residuals.some(r=>r.name==='CHECK-1'&&r.role==='check'));
});

test('GCPManager validates measurements and exports role/weight columns', () => {
  const gm=new G.GCPManager();
  assert.throws(()=>gm.add('bad',[0,0,NaN],[1,2,3]),/finite/);
  assert.throws(()=>gm.add('bad',[0,0,0],[1,2,3],{weight:0}),/positive/);
  assert.throws(()=>gm.add('bad',[0,0,0],[1,2,3],{role:'fit?'}),/role/);
  gm.add('P,1',[0,0,0],[1,2,3],{weight:2,role:'control'});
  gm.add('CHECK',[1,0,0],[2,2,3],{role:'check'});
  const csv=gm.toCSV();
  assert.match(csv,/src_x.*weight.*role/);
  assert.match(csv,/"P,1",/);
  assert.match(csv,/CHECK,[^\n]*,check/);
});

test('parseGcpCsv supports headers, quoted names, weights, checks, and decimal-comma semicolon files', () => {
  const comma=G.parseGcpCsv('name,src_x,src_y,src_z,dst_x,dst_y,dst_z,weight,role\n"Point, one",0,0,0,10,20,30,4,control\nPcheck,1,1,1,11,21,31,2,check');
  assert.equal(comma.errors.length,0);
  assert.equal(comma.points.length,2);
  assert.equal(comma.points[0].name,'Point, one');
  assert.equal(comma.points[0].weight,4);
  assert.equal(comma.points[1].role,'check');

  const semi=G.parseGcpCsv('name;src_x;src_y;src_z;dst_x;dst_y;dst_z;weight;role\nP1;0,5;0;0;10,5;20;30;2;control\nP2;1,5;0;0;11,5;20;30;1;check');
  assert.equal(semi.errors.length,0);
  assert.equal(semi.delimiter,';');
  assert.equal(semi.points[0].src[0],0.5);
  assert.equal(semi.points[1].role,'check');

  const bad=G.parseGcpCsv('name,src_x,src_y,src_z,dst_x,dst_y,dst_z\nP1,0,0,0,1,2,3\nbroken,x,0,0,1,2,3');
  assert.equal(bad.points.length,1);
  assert.deepEqual(bad.errors.map(e=>e.line),[3]);
});
