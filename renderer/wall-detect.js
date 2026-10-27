
/* wall-detect.js — Sprint 3 (v1091): RANSAC wall detection + floor plan DXF.
 * window.WallDetect + module.exports
 */
(function(){
'use strict';
function distPtLine(p,a,b){
  var dx=b[0]-a[0],dz=b[1]-a[1];
  var len2=dx*dx+dz*dz;
  if(len2<1e-12) return Math.sqrt((p[0]-a[0])*(p[0]-a[0])+(p[1]-a[1])*(p[1]-a[1]));
  var t=((p[0]-a[0])*dx+(p[1]-a[1])*dz)/len2;
  return Math.sqrt((p[0]-a[0]-t*dx)*(p[0]-a[0]-t*dx)+(p[1]-a[1]-t*dz)*(p[1]-a[1]-t*dz));
}
function segLen(a,b){var dx=b[0]-a[0],dz=b[1]-a[1];return Math.sqrt(dx*dx+dz*dz);}
// Детерминированный ГПСЧ (как в measure.js/lixel-geom2d.js) — одинаковый вход даёт
// одинаковый результат детекции стен при повторном запуске (воспроизводимость).
function makeRng(seed){var s=(seed>>>0)||12345;return function(){s=(s*1664525+1013904223)>>>0;return s/4294967296;};}
function ransacLine(pts,opts){
  if(!pts||pts.length<2) return null;
  opts=opts||{};
  var thr=opts.threshold||0.05, iters=opts.iters||400, minLen=opts.minLen||0.3;
  var rng=opts.rng||makeRng(opts.seed!=null?opts.seed:12345);
  var best=null,bestCnt=0;
  var n=pts.length;
  for(var it=0;it<iters;it++){
    var i=Math.floor(rng()*n), j=Math.floor(rng()*n);
    if(i===j) continue;
    var a=pts[i],b=pts[j];
    if(segLen(a,b)<1e-9) continue;
    var inliers=[];
    for(var k=0;k<n;k++) if(distPtLine(pts[k],a,b)<=thr) inliers.push(pts[k]);
    if(inliers.length<=bestCnt) continue;
    // compute endpoint extent along direction
    var dx=b[0]-a[0],dz=b[1]-a[1],L=Math.sqrt(dx*dx+dz*dz);
    var ts=inliers.map(function(p){return((p[0]-a[0])*dx+(p[1]-a[1])*dz)/L;});
    var tMin=Math.min.apply(null,ts),tMax=Math.max.apply(null,ts);
    var len=tMax-tMin;
    if(len<minLen) continue;
    bestCnt=inliers.length;
    var ux=dx/L,uz=dz/L;
    best={a:[a[0]+ux*tMin,a[1]+uz*tMin],b:[a[0]+ux*tMax,a[1]+uz*tMax],
      inliers:inliers,inlierCount:inliers.length,length:len,dir:[ux,uz]};
  }
  return best;
}
function detectWalls(pts,opts){
  opts=opts||{};
  var minInliers=opts.minInliers||10;
  // Один генератор на весь проход: каждая следующая стена продолжает
  // последовательность, а не начинает её заново с того же самого сида.
  var runOpts=Object.assign({},opts,{rng:opts.rng||makeRng(opts.seed!=null?opts.seed:12345)});
  var remaining=pts.slice();
  var walls=[];
  while(remaining.length>=minInliers){
    var w=ransacLine(remaining,runOpts);
    if(!w||w.inlierCount<minInliers) break;
    walls.push(w);
    var inSet=new Set(w.inliers.map(function(p){return p.join(',');}));
    remaining=remaining.filter(function(p){return!inSet.has(p.join(','));});
  }
  return walls;
}
function intersectLines(a1,a2,b1,b2){
  var r=[a2[0]-a1[0],a2[1]-a1[1]];
  var s=[b2[0]-b1[0],b2[1]-b1[1]];
  var d=r[0]*s[1]-r[1]*s[0];
  if(Math.abs(d)<1e-10) return null;
  var t=((b1[0]-a1[0])*s[1]-(b1[1]-a1[1])*s[0])/d;
  return[a1[0]+t*r[0],a1[1]+t*r[1]];
}
function buildFloorPlan(walls){
  var nodes=[];
  for(var i=0;i<walls.length;i++){
    for(var j=i+1;j<walls.length;j++){
      var pt=intersectLines(walls[i].a,walls[i].b,walls[j].a,walls[j].b);
      if(pt) nodes.push(pt);
    }
  }
  return{walls:walls,nodes:nodes};
}
function wallsToDxf(walls,nodes){
  var L=['0','SECTION','2','ENTITIES'];
  walls.forEach(function(w){
    L.push('0','LINE','8','WALLS',
      '10',w.a[0].toFixed(4),'20','0.0000','30',w.a[1].toFixed(4),
      '11',w.b[0].toFixed(4),'21','0.0000','31',w.b[1].toFixed(4));
  });
  if(nodes) nodes.forEach(function(n){
    L.push('0','POINT','8','NODES','10',n[0].toFixed(4),'20','0.0000','30',n[1].toFixed(4));
  });
  L.push('0','ENDSEC','0','EOF');
  return L.join('\n');
}
function autoFloorPlan(pts,opts){
  var walls=detectWalls(pts,opts);
  var plan=buildFloorPlan(walls);
  plan.dxf=wallsToDxf(walls,plan.nodes);
  plan.ptCount=pts.length;
  return plan;
}
var API={distPtLine:distPtLine,ransacLine:ransacLine,detectWalls:detectWalls,
  intersectLines:intersectLines,buildFloorPlan:buildFloorPlan,
  wallsToDxf:wallsToDxf,autoFloorPlan:autoFloorPlan};
if(typeof window!=='undefined') window.WallDetect=API;
if(typeof module!=='undefined'&&module.exports) module.exports=API;
})();
