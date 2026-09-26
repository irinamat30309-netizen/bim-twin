
/* tin-volume.js — Sprint 2 (v1091): Delaunay TIN + cut/fill volume.
 * Bowyer-Watson O(n log n avg). window.TinVolume + module.exports.
 */
(function(){
'use strict';
function circumcircle(a,b,c){
  var ax=b[0]-a[0],ay=b[1]-a[1],bx=c[0]-a[0],by=c[1]-a[1];
  var D=2*(ax*by-ay*bx);
  if(Math.abs(D)<1e-12) return null;
  var ux=(by*(ax*ax+ay*ay)-ay*(bx*bx+by*by))/D;
  var uy=(ax*(bx*bx+by*by)-bx*(ax*ax+ay*ay))/D;
  var r=Math.sqrt(ux*ux+uy*uy);
  return{cx:a[0]+ux,cy:a[1]+uy,r:r};
}
function delaunay2D(pts){
  if(!Array.isArray(pts)) throw new TypeError('Точки TIN должны быть массивом');
  if(pts.length<3) return [];
  if(pts.some(function(p){return !p||!Number.isFinite(p[0])||!Number.isFinite(p[1]);})) throw new RangeError('Некорректные координаты TIN');
  var n=pts.length;
  var mn=[Infinity,Infinity],mx=[-Infinity,-Infinity];
  pts.forEach(function(p){if(p[0]<mn[0])mn[0]=p[0];if(p[1]<mn[1])mn[1]=p[1];if(p[0]>mx[0])mx[0]=p[0];if(p[1]>mx[1])mx[1]=p[1];});
  var dx=mx[0]-mn[0],dy=mx[1]-mn[1],d=Math.max(dx,dy)*10;
  var work=pts.map(function(p){return[p[0]-mn[0],p[1]-mn[1]];});
  var S=[[-d-1,-1],[dx/2,d+1],[dx+d+1,-1]];
  var all=work.concat(S);
  var tris=[[n,n+1,n+2]];
  for(var i=0;i<n;i++){
    var p=work[i];
    var edges=[];
    var good=[];
    for(var t=0;t<tris.length;t++){
      var tri=tris[t];
      var cc=circumcircle(all[tri[0]],all[tri[1]],all[tri[2]]);
      if(cc&&(p[0]-cc.cx)*(p[0]-cc.cx)+(p[1]-cc.cy)*(p[1]-cc.cy)<cc.r*cc.r){
        edges.push([tri[0],tri[1]],[tri[1],tri[2]],[tri[2],tri[0]]);
      }else{good.push(tri);}
    }
    var uniq=[];
    for(var e=0;e<edges.length;e++){
      var dup=false;
      for(var e2=0;e2<edges.length;e2++){
        if(e!==e2&&((edges[e][0]===edges[e2][0]&&edges[e][1]===edges[e2][1])||(edges[e][0]===edges[e2][1]&&edges[e][1]===edges[e2][0]))){dup=true;break;}
      }
      if(!dup) uniq.push(edges[e]);
    }
    uniq.forEach(function(e){good.push([e[0],e[1],i]);});
    tris=good;
  }
  return tris.filter(function(t){return t[0]<n&&t[1]<n&&t[2]<n;});
}
function buildTIN(pos,count,opts){
  opts=opts||{};
  if(!pos||!Number.isSafeInteger(count)||count<0||count*3>pos.length) throw new RangeError('Некорректное число точек TIN');
  var step=opts.step==null?1:Number(opts.step);
  if(!Number.isSafeInteger(step)||step<1) throw new RangeError('Шаг TIN должен быть положительным целым');
  var xz=[],ys=[];
  for(var i=0;i<count;i+=step){
    var x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2];
    if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z)) throw new RangeError('Некорректные координаты TIN');
    xz.push([x,z]);ys.push(y);
  }
  var tris=delaunay2D(xz);
  return{xz:xz,ys:ys,triangles:tris};
}
function sign(p1,p2,p3){return(p1[0]-p3[0])*(p2[1]-p3[1])-(p2[0]-p3[0])*(p1[1]-p3[1]);}
function ptInTri(p,a,b,c){
  var d1=sign(p,a,b),d2=sign(p,b,c),d3=sign(p,c,a);
  var hn=(d1<0)||(d2<0)||(d3<0),hp=(d1>0)||(d2>0)||(d3>0);
  return !(hn&&hp);
}
function interpolateY(tin,x,z){
  var p=[x,z];
  for(var t=0;t<tin.triangles.length;t++){
    var tr=tin.triangles[t];
    var a=tin.xz[tr[0]],b=tin.xz[tr[1]],c=tin.xz[tr[2]];
    if(ptInTri(p,a,b,c)){
      // barycentric
      var denom=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
      if(Math.abs(denom)<1e-12) continue;
      var w1=((b[1]-c[1])*(p[0]-c[0])+(c[0]-b[0])*(p[1]-c[1]))/denom;
      var w2=((c[1]-a[1])*(p[0]-c[0])+(a[0]-c[0])*(p[1]-c[1]))/denom;
      var w3=1-w1-w2;
      return w1*tin.ys[tr[0]]+w2*tin.ys[tr[1]]+w3*tin.ys[tr[2]];
    }
  }
  return null;
}
function triArea2D(a,b,c){return Math.abs((b[0]-a[0])*(c[1]-a[1])-(c[0]-a[0])*(b[1]-a[1]))/2;}
function computeVolume(tin,refY){
  if(!tin||!Array.isArray(tin.xz)||!Array.isArray(tin.ys)||!Array.isArray(tin.triangles)||!Number.isFinite(refY)) throw new RangeError('Некорректные данные TIN');
  var cut=0,fill=0;
  for(var t=0;t<tin.triangles.length;t++){
    var tr=tin.triangles[t],a=tin.xz[tr[0]],b=tin.xz[tr[1]],c=tin.xz[tr[2]];if(!a||!b||!c)continue;
    var h=[tin.ys[tr[0]]-refY,tin.ys[tr[1]]-refY,tin.ys[tr[2]]-refY];if(!h.every(Number.isFinite))continue;
    var area=triArea2D(a,b,c);if(!(area>0))continue;var pos=h.filter(function(v){return v>0;}),neg=h.filter(function(v){return v<0;}),net=area*(h[0]+h[1]+h[2])/3;
    if(!neg.length){cut+=Math.max(0,net);continue;}if(!pos.length){fill+=Math.max(0,-net);continue;}
    if(pos.length===1){var hp=pos[0],r1=hp/(hp-neg[0]),r2=hp/(hp-neg[1]),cp=area*r1*r2*hp/3;cut+=cp;fill+=cp-net;}
    else{var hn=-neg[0],q1=hn/(pos[0]+hn),q2=hn/(pos[1]+hn),fp=area*q1*q2*hn/3;fill+=fp;cut+=net+fp;}
  }
  if(Math.abs(cut)<1e-15)cut=0;if(Math.abs(fill)<1e-15)fill=0;return{cut:cut,fill:fill,net:cut-fill};
}
function tinToDxf(tin){
  var lines=['0','SECTION','2','ENTITIES'];
  tin.triangles.forEach(function(tr){
    var a=tin.xz[tr[0]],b=tin.xz[tr[1]],c=tin.xz[tr[2]];
    var ya=tin.ys[tr[0]],yb=tin.ys[tr[1]],yc=tin.ys[tr[2]];
    lines.push('0','3DFACE','8','TIN',
      '10',a[0].toFixed(4),'20',ya.toFixed(4),'30',a[1].toFixed(4),
      '11',b[0].toFixed(4),'21',yb.toFixed(4),'31',b[1].toFixed(4),
      '12',c[0].toFixed(4),'22',yc.toFixed(4),'32',c[1].toFixed(4),
      '13',c[0].toFixed(4),'23',yc.toFixed(4),'33',c[1].toFixed(4));
  });
  lines.push('0','ENDSEC','0','EOF');
  return lines.join('\n');
}
function extractProfile(tin,ax,az,bx,bz,step){
  step=step==null?0.5:Number(step);
  var dx=bx-ax,dz=bz-az,len=Math.sqrt(dx*dx+dz*dz);
  if(len<1e-9) return[];
  var profile=[];
  if(!(step>0)||!Number.isFinite(step)) throw new RangeError('Шаг профиля должен быть положительным');
  var samples=Math.floor(len/step);
  for(var i=0;i<=samples;i++){var dd=Math.min(i*step,len),t=dd/len,x=ax+dx*t,z=az+dz*t,y=interpolateY(tin,x,z);if(y!==null)profile.push({dist:dd,y:y,x:x,z:z});}
  if(samples*step<len-1e-12){var ye=interpolateY(tin,bx,bz);if(ye!==null)profile.push({dist:len,y:ye,x:bx,z:bz});}
  return profile;
}
function profileToCsv(profile){
  var rows=['dist_m,height_m,x,z'];
  profile.forEach(function(p){
    rows.push(p.dist.toFixed(4)+','+p.y.toFixed(4)+','+p.x.toFixed(4)+','+p.z.toFixed(4));
  });
  return rows.join('\n');
}
var API={circumcircle:circumcircle,delaunay2D:delaunay2D,buildTIN:buildTIN,
  interpolateY:interpolateY,computeVolume:computeVolume,
  tinToDxf:tinToDxf,extractProfile:extractProfile,profileToCsv:profileToCsv};
if(typeof window!=='undefined') window.TinVolume=API;
if(typeof module!=='undefined'&&module.exports) module.exports=API;
})();
