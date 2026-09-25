
/* georef.js — Sprint 5 (v1091): Helmert 3D georeference + GCP manager + ICP.
 * window.Georef + module.exports
 */
(function(){
'use strict';
function matMul(A,B){
  var r=A.rows,k=A.cols,c=B.cols;
  var D=new Float64Array(r*c);
  for(var i=0;i<r;i++) for(var j=0;j<c;j++){
    var s=0;for(var p=0;p<k;p++) s+=A.data[i*k+p]*B.data[p*c+j];
    D[i*c+j]=s;
  }
  return{rows:r,cols:c,data:D};
}
function matT(A){
  var D=new Float64Array(A.rows*A.cols);
  for(var i=0;i<A.rows;i++) for(var j=0;j<A.cols;j++) D[j*A.rows+i]=A.data[i*A.cols+j];
  return{rows:A.cols,cols:A.rows,data:D};
}
function dot3(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
function cross3(a,b){return[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
function det3(M){
  var d=M.data;
  return d[0]*(d[4]*d[8]-d[5]*d[7])-d[1]*(d[3]*d[8]-d[5]*d[6])+d[2]*(d[3]*d[7]-d[4]*d[6]);
}
function matInverse(M){
  var d=M.data,det=det3(M);
  if(Math.abs(det)<1e-14) return null;
  var inv=new Float64Array(9);
  inv[0]=(d[4]*d[8]-d[5]*d[7])/det; inv[1]=(d[2]*d[7]-d[1]*d[8])/det; inv[2]=(d[1]*d[5]-d[2]*d[4])/det;
  inv[3]=(d[5]*d[6]-d[3]*d[8])/det; inv[4]=(d[0]*d[8]-d[2]*d[6])/det; inv[5]=(d[2]*d[3]-d[0]*d[5])/det;
  inv[6]=(d[3]*d[7]-d[4]*d[6])/det; inv[7]=(d[1]*d[6]-d[0]*d[7])/det; inv[8]=(d[0]*d[4]-d[1]*d[3])/det;
  return{rows:3,cols:3,data:inv};
}
// Reject collinear control points: a 3D similarity rotation is underdetermined
// if the source or destination controls span less than a plane.
function has2DSpread(points){
  if(!Array.isArray(points)||points.length<3)return false;
  var o=points[0],maxD2=0,maxCross2=0;
  for(var i=1;i<points.length;i++){
    var a=[points[i][0]-o[0],points[i][1]-o[1],points[i][2]-o[2]],d2=dot3(a,a);
    if(d2>maxD2)maxD2=d2;
    for(var j=i+1;j<points.length;j++){
      var b=[points[j][0]-o[0],points[j][1]-o[1],points[j][2]-o[2]],c=cross3(a,b),c2=dot3(c,c);
      if(c2>maxCross2)maxCross2=c2;
    }
  }
  return maxD2>1e-24&&maxCross2>Math.max(1e-24,maxD2*maxD2*1e-12);
}
function compareCrsWkt(a,b){
  var na=String(a||'').replace(/\s+/g,'').toUpperCase(),nb=String(b||'').replace(/\s+/g,'').toUpperCase();
  if(!na||!nb)return'unknown';
  if(na===nb)return'same';
  // Only compare a root-level authority code. A base-geographic EPSG embedded
  // inside a custom projection is not enough to prove that the full CRS matches.
  function rootEpsg(s){
    var simple=/^(?:EPSG:|URN:OGC:DEF:CRS:EPSG::)?(\d{4,6})$/.exec(s);if(simple)return simple[1];
    var open=s.indexOf('[');if(open<0)return'';
    var depth=1,quoted=false,seg=open+1,found='';
    function take(end){var part=s.slice(seg,end),m=/^(?:ID|AUTHORITY)\["EPSG",["']?(\d+)/.exec(part);if(m)found=m[1];}
    for(var i=open+1;i<s.length;i++){
      var ch=s[i];
      if(ch==='"'){if(quoted&&s[i+1]==='"'){i++;continue;}quoted=!quoted;continue;}
      if(quoted)continue;
      if(ch==='[')depth++;
      else if(ch===']'){if(depth===1){take(i);break;}depth--;}
      else if(ch===','&&depth===1){take(i);seg=i+1;}
    }
    return found;
  }
  var ea=rootEpsg(na),eb=rootEpsg(nb);
  if(ea&&eb)return ea===eb?'same':'different';
  return'unknown';
}
// Umeyama similarity transform (scale+rotate+translate)
function helmert3D(src,dst){
  if(!Array.isArray(src)||!Array.isArray(dst)||src.length<3||dst.length!==src.length) return null;
  for(var i=0;i<src.length;i++)if(!src[i]||!dst[i]||src[i].length<3||dst[i].length<3||!src[i].slice(0,3).every(Number.isFinite)||!dst[i].slice(0,3).every(Number.isFinite))return null;
  if(!has2DSpread(src)||!has2DSpread(dst))return null;
  var n=src.length;
  // centroids
  var ms=[0,0,0],md=[0,0,0];
  for(var i=0;i<n;i++){ms[0]+=src[i][0];ms[1]+=src[i][1];ms[2]+=src[i][2];md[0]+=dst[i][0];md[1]+=dst[i][1];md[2]+=dst[i][2];}
  ms=ms.map(function(v){return v/n;});md=md.map(function(v){return v/n;});
  // variances + cross-covariance
  var varS=0;
  var H=new Float64Array(9);
  for(var i=0;i<n;i++){
    var a=[src[i][0]-ms[0],src[i][1]-ms[1],src[i][2]-ms[2]];
    var b=[dst[i][0]-md[0],dst[i][1]-md[1],dst[i][2]-md[2]];
    varS+=a[0]*a[0]+a[1]*a[1]+a[2]*a[2];
    for(var r=0;r<3;r++) for(var c=0;c<3;c++) H[r*3+c]+=b[r]*a[c];
  }
  varS/=n;
  if(!Number.isFinite(varS)||varS<=1e-24)return null;
  // Normalize cross-covariance by n (Umeyama formula requires 1/n)
  for(var j=0;j<9;j++) H[j]/=n;
  var HM={rows:3,cols:3,data:H};
  // Proper SVD via H = U * diag(s) * V^T (Umeyama 1991).
  // H = sum b_i a_i^T ; optimal rotation R = U * diag(1,1,det(U V^T)) * V^T
  var svdH=jacobi3(HM);
  var U=svdH.U,S=svdH.S,V=svdH.V;
  var detUVT=det3(matMul(U,matT(V)));
  var diag=new Float64Array([1,0,0,0,1,0,0,0,detUVT>=0?1:-1]);
  var R=matMul(U,matMul({rows:3,cols:3,data:diag},matT(V)));
  // scale = trace(diag(S)*diag)/varS
  var scale=(S[0]+S[1]+(detUVT>=0?S[2]:-S[2]))/varS;
  // translation
  var Rms=[R.data[0]*ms[0]+R.data[1]*ms[1]+R.data[2]*ms[2],
           R.data[3]*ms[0]+R.data[4]*ms[1]+R.data[5]*ms[2],
           R.data[6]*ms[0]+R.data[7]*ms[1]+R.data[8]*ms[2]];
  var t=[md[0]-scale*Rms[0],md[1]-scale*Rms[1],md[2]-scale*Rms[2]];
  if(!Number.isFinite(scale)||scale<=0||!t.every(Number.isFinite))return null;
  // RMS
  var rms=0;
  for(var i=0;i<n;i++){
    var tp=transformPt(src[i],scale,R,t);
    var dx=tp[0]-dst[i][0],dy=tp[1]-dst[i][1],dz=tp[2]-dst[i][2];
    rms+=dx*dx+dy*dy+dz*dz;
  }
  rms=Math.sqrt(rms/n);
  return{scale:scale,R:R,t:t,rms:rms};
}
function jacobi3(A){
  // returns U,S,V such that A ≈ U * diag(S) * V^T
  // Here we do it via eigendecomposition of A^T A
  var AtA=matMul(matT(A),A);
  var V=new Float64Array([1,0,0,0,1,0,0,0,1]);
  var a=new Float64Array(AtA.data);
  for(var sweep=0;sweep<60;sweep++){
    var conv=true;
    for(var p=0;p<2;p++) for(var q=p+1;q<3;q++){
      var apq=a[p*3+q];
      if(Math.abs(apq)<1e-12) continue;
      conv=false;
      var tau=(a[q*3+q]-a[p*3+p])/(2*apq);
      var t2=tau>=0?1/(tau+Math.sqrt(1+tau*tau)):1/(tau-Math.sqrt(1+tau*tau));
      var c2=1/Math.sqrt(1+t2*t2),s2=t2*c2;
      var newApp=a[p*3+p]-t2*apq,newAqq=a[q*3+q]+t2*apq;
      a[p*3+p]=newApp;a[q*3+q]=newAqq;a[p*3+q]=0;a[q*3+p]=0;
      for(var r=0;r<3;r++){if(r===p||r===q)continue;
        var arp=a[r*3+p],arq=a[r*3+q];
        a[r*3+p]=c2*arp-s2*arq;a[p*3+r]=a[r*3+p];
        a[r*3+q]=s2*arp+c2*arq;a[q*3+r]=a[r*3+q];
      }
      for(var r=0;r<3;r++){var vp=V[r*3+p],vq=V[r*3+q];V[r*3+p]=c2*vp-s2*vq;V[r*3+q]=s2*vp+c2*vq;}
    }
    if(conv) break;
  }
  var S=[Math.sqrt(Math.max(0,a[0])),Math.sqrt(Math.max(0,a[4])),Math.sqrt(Math.max(0,a[8]))];
  // U = A * V * diag(1/S). For planar GCPs the third singular value is zero;
  // complete its missing vector with a cross product so the rotation remains orthonormal.
  var VM={rows:3,cols:3,data:V};
  var AV=matMul(A,VM),Ud=new Float64Array(9),live=[],tol=Math.max(1e-15,Math.max(S[0],S[1],S[2])*1e-12);
  for(var j=0;j<3;j++)if(S[j]>tol){live.push(j);for(var i=0;i<3;i++)Ud[i*3+j]=AV.data[i*3+j]/S[j];}
  if(live.length===2){
    var missing=0;while(missing===live[0]||missing===live[1])missing++;
    var ia=(missing+1)%3,ib=(missing+2)%3;
    var ca=[Ud[ia],Ud[3+ia],Ud[6+ia]],cb=[Ud[ib],Ud[3+ib],Ud[6+ib]],cc=cross3(ca,cb),cn=Math.sqrt(dot3(cc,cc));
    if(cn>tol){Ud[missing]=cc[0]/cn;Ud[3+missing]=cc[1]/cn;Ud[6+missing]=cc[2]/cn;}
  }
  return{U:{rows:3,cols:3,data:Ud},S:S,V:VM};
}
function transformPt(p,scale,R,t){
  var d=R.data;
  return[
    scale*(d[0]*p[0]+d[1]*p[1]+d[2]*p[2])+t[0],
    scale*(d[3]*p[0]+d[4]*p[1]+d[5]*p[2])+t[1],
    scale*(d[6]*p[0]+d[7]*p[1]+d[8]*p[2])+t[2]
  ];
}
function applyTransform(pos,count,T){
  if(!pos||!Number.isSafeInteger(count)||count<0||count*3>pos.length||!T||!Number.isFinite(T.scale)||!T.R||!T.R.data||!T.t||T.t.length<3)throw new RangeError('Некорректные входные данные геопреобразования');
  // Keep global coordinates in double precision. The viewer receives a centred
  // Float32 copy only after the transform, avoiding UTM-scale quantization.
  var out=new Float64Array(count*3);
  for(var i=0;i<count;i++){
    var p=[pos[i*3],pos[i*3+1],pos[i*3+2]];
    if(!p.every(Number.isFinite))throw new RangeError('Облако содержит некорректные координаты');
    var tp=transformPt(p,T.scale,T.R,T.t);
    if(!tp.every(Number.isFinite))throw new RangeError('Геопреобразование создало некорректные координаты');
    out[i*3]=tp[0];out[i*3+1]=tp[1];out[i*3+2]=tp[2];
  }
  return out;
}
function toViewerCloud(worldPos,col,opts){
  opts=opts||{};
  if(!worldPos||!worldPos.length||worldPos.length%3)throw new RangeError('Нужен массив мировых XYZ-координат');
  var n=worldPos.length/3;
  if(col&&col.length!==worldPos.length)throw new RangeError('Цветовой массив не совпадает с облаком');
  var minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity;
  for(var i=0;i<n;i++){
    var x=worldPos[i*3],y=worldPos[i*3+1],z=worldPos[i*3+2];
    if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z))throw new RangeError('Мировые координаты должны быть конечными');
    if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;if(z<minZ)minZ=z;
  }
  var cx=minX/2+maxX/2,cy=minY/2+maxY/2,cz=minZ,pos=new Float32Array(n*3);
  for(var i=0;i<n;i++){
    var x=worldPos[i*3],y=worldPos[i*3+1],z=worldPos[i*3+2];
    pos[i*3]=x-cx;pos[i*3+1]=z-cz;pos[i*3+2]=-(y-cy);
  }
  return{pos:pos,col:col||null,count:n,meta:{format:'GCP georeferenced',points:n,total:n,
    srcXform:{axis:'zup',t:[cx,cy,cz]},crsWkt:opts.crsWkt?String(opts.crsWkt).trim()||null:null}};
}
function GCPManager(){

  this._gcps=[];
}
GCPManager.prototype.add=function(name,src,dst){this._gcps.push({name:name,src:src,dst:dst});};
GCPManager.prototype.remove=function(name){this._gcps=this._gcps.filter(function(g){return g.name!==name;});};
GCPManager.prototype.list=function(){return this._gcps.slice();};
GCPManager.prototype.solve=function(){
  if(this._gcps.length<3) return null;
  var srcs=this._gcps.map(function(g){return g.src;});
  var dsts=this._gcps.map(function(g){return g.dst;});
  var T=helmert3D(srcs,dsts);
  if(!T) return null;
  var residuals=this._gcps.map(function(g){
    var tp=transformPt(g.src,T.scale,T.R,T.t);
    var dx=tp[0]-g.dst[0],dy=tp[1]-g.dst[1],dz=tp[2]-g.dst[2];
    return{name:g.name,residual:Math.sqrt(dx*dx+dy*dy+dz*dz)};
  });
  return{scale:T.scale,R:T.R,t:T.t,rms:T.rms,residuals:residuals,gcpCount:this._gcps.length};
};
GCPManager.prototype.toCSV=function(){
  var rows=['name,src_x,src_y,src_z,dst_x,dst_y,dst_z'];
  this._gcps.forEach(function(g){
    rows.push([g.name,g.src[0],g.src[1],g.src[2],g.dst[0],g.dst[1],g.dst[2]].join(','));
  });
  return rows.join('\n');
};
var API={helmert3D:helmert3D,applyTransform:applyTransform,toViewerCloud:toViewerCloud,transformPt:transformPt,
  GCPManager:GCPManager,det3:det3,matInverse:matInverse,has2DSpread:has2DSpread,compareCrsWkt:compareCrsWkt};
if(typeof window!=='undefined') window.Georef=API;
if(typeof module!=='undefined'&&module.exports) module.exports=API;
})();
