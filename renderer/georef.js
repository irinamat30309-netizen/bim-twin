
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
// Umeyama similarity transform (scale+rotate+translate), optionally weighted.
// weights are relative observation weights (normally inverse variance).
function helmert3D(src,dst,weights){
  if(!Array.isArray(src)||!Array.isArray(dst)||src.length<3||dst.length!==src.length) return null;
  for(var i=0;i<src.length;i++)if(!src[i]||!dst[i]||src[i].length<3||dst[i].length<3||!src[i].slice(0,3).every(Number.isFinite)||!dst[i].slice(0,3).every(Number.isFinite))return null;
  if(!has2DSpread(src)||!has2DSpread(dst))return null;
  var n=src.length;
  var w=new Float64Array(n),sumW=0,maxW=0;
  for(var i=0;i<n;i++){
    var wi=weights==null?1:Number(weights[i]);
    if(!Number.isFinite(wi)||wi<=0)return null;
    w[i]=wi;if(wi>maxW)maxW=wi;
  }
  if(weights!=null&&(!weights.length||weights.length!==n))return null;
  if(!(maxW>0))return null;
  for(var i=0;i<n;i++){w[i]/=maxW;sumW+=w[i];}
  if(!Number.isFinite(sumW)||sumW<=0)return null;
  // centroids
  var ms=[0,0,0],md=[0,0,0];
  for(var i=0;i<n;i++){var wi=w[i];ms[0]+=wi*src[i][0];ms[1]+=wi*src[i][1];ms[2]+=wi*src[i][2];md[0]+=wi*dst[i][0];md[1]+=wi*dst[i][1];md[2]+=wi*dst[i][2];}
  ms=ms.map(function(v){return v/sumW;});md=md.map(function(v){return v/sumW;});
  // variances + cross-covariance
  var varS=0;
  var H=new Float64Array(9);
  for(var i=0;i<n;i++){
    var wi=w[i];
    var a=[src[i][0]-ms[0],src[i][1]-ms[1],src[i][2]-ms[2]];
    var b=[dst[i][0]-md[0],dst[i][1]-md[1],dst[i][2]-md[2]];
    varS+=wi*(a[0]*a[0]+a[1]*a[1]+a[2]*a[2]);
    for(var r=0;r<3;r++) for(var c=0;c<3;c++) H[r*3+c]+=wi*b[r]*a[c];
  }
  varS/=sumW;
  if(!Number.isFinite(varS)||varS<=1e-24)return null;
  // Normalize cross-covariance by n (Umeyama formula requires 1/n)
  for(var j=0;j<9;j++) H[j]/=sumW;
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
    rms+=w[i]*(dx*dx+dy*dy+dz*dz);
  }
  rms=Math.sqrt(rms/sumW);
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
  var intensity=opts.intensity||null,classification=opts.classification||null;
  if(intensity&&intensity.length!==n)throw new RangeError('Массив интенсивности не совпадает с облаком');
  if(classification&&classification.length!==n)throw new RangeError('Массив классификации не совпадает с облаком');
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
  return{pos:pos,col:col||null,intensity:intensity,classification:classification,count:n,meta:{format:'GCP georeferenced',points:n,total:n,
    srcXform:{axis:'zup',t:[cx,cy,cz]},crsWkt:opts.crsWkt?String(opts.crsWkt).trim()||null:null}};
}
function _median(values){
  if(!values.length)return 0;
  var a=Array.prototype.slice.call(values).sort(function(x,y){return x-y;});
  var m=a.length>>1;
  return(a.length&1)?a[m]:(a[m-1]+a[m])*0.5;
}
function _residualVector(g,T){
  var p=transformPt(g.src,T.scale,T.R,T.t);
  return[p[0]-g.dst[0],p[1]-g.dst[1],p[2]-g.dst[2]];
}
function _gcpCovariance(residuals,weights){
  var sw=0,mean=[0,0,0],n=residuals.length,maxW=0;
  for(var i=0;i<n;i++)if(weights[i]>maxW)maxW=weights[i];
  if(!(maxW>0))return[[0,0,0],[0,0,0],[0,0,0]];
  for(var i=0;i<n;i++){var w=weights[i]/maxW;sw+=w;for(var k=0;k<3;k++)mean[k]+=w*residuals[i][k];}
  if(!(sw>0))return[[0,0,0],[0,0,0],[0,0,0]];
  for(var k=0;k<3;k++)mean[k]/=sw;
  var C=[[0,0,0],[0,0,0],[0,0,0]];
  for(var i=0;i<n;i++)for(var r=0;r<3;r++)for(var c=0;c<3;c++)C[r][c]+=(weights[i]/maxW)*(residuals[i][r]-mean[r])*(residuals[i][c]-mean[c]);
  for(var r=0;r<3;r++)for(var c=0;c<3;c++)C[r][c]/=sw;
  return C;
}
function _robustGcpFit(src,dst,baseWeights,opts){
  opts=opts||{};
  var robust=opts.robust!==false,maxIter=opts.maxRobustIterations==null?10:Math.max(1,Math.min(30,opts.maxRobustIterations|0));
  var huberK=opts.huberK==null?2.5:Number(opts.huberK);
  var floor=opts.robustFloor==null?1e-5:Number(opts.robustFloor);
  if(!Number.isFinite(huberK)||huberK<=0||!Number.isFinite(floor)||floor<=0)return null;
  var weights=Array.prototype.slice.call(baseWeights),T=helmert3D(src,dst,weights),iterations=0;
  if(!T)return null;
  if(!robust||src.length<4)return{T:T,weights:weights,iterations:iterations};
  for(var pass=0;pass<maxIter;pass++){
    var residuals=src.map(function(p,i){var tp=transformPt(p,T.scale,T.R,T.t),dx=tp[0]-dst[i][0],dy=tp[1]-dst[i][1],dz=tp[2]-dst[i][2];return Math.sqrt(dx*dx+dy*dy+dz*dz);});
    var center=_median(residuals),deviations=residuals.map(function(r){return Math.abs(r-center);});
    var scale=Math.max(1.4826*_median(deviations),floor),cutoff=Math.max(center+huberK*scale,floor);
    var next=baseWeights.map(function(w,i){return w*Math.min(1,cutoff/Math.max(residuals[i],floor));});
    var delta=0;for(var i=0;i<weights.length;i++)delta=Math.max(delta,Math.abs(next[i]-weights[i])/Math.max(baseWeights[i],1e-30));
    if(delta<1e-6)break;
    var fitted=helmert3D(src,dst,next);
    if(!fitted)break;
    weights=next;T=fitted;iterations=pass+1;
  }
  return{T:T,weights:weights,iterations:iterations};
}

function GCPManager(){this._gcps=[];}
GCPManager.prototype.add=function(name,src,dst,opts){
  opts=opts||{};
  if(!src||!dst||src.length<3||dst.length<3)throw new RangeError('GCP needs source and target XYZ');
  var a=[Number(src[0]),Number(src[1]),Number(src[2])],b=[Number(dst[0]),Number(dst[1]),Number(dst[2])];
  if(!a.every(Number.isFinite)||!b.every(Number.isFinite))throw new RangeError('GCP coordinates must be finite');
  var role=String(opts.role||'control').trim().toLowerCase();
  if(role==='check-point'||role==='checkpoint'||role==='independent')role='check';
  if(role!=='control'&&role!=='check')throw new RangeError('GCP role must be control or check');
  var sigma=opts.sigma==null?null:Number(opts.sigma);
  var weight=opts.weight==null?1:Number(opts.weight);
  if(sigma!=null){if(!Number.isFinite(sigma)||sigma<=0)throw new RangeError('GCP sigma must be positive');weight=1/(sigma*sigma);}
  if(!Number.isFinite(weight)||weight<=0)throw new RangeError('GCP weight must be positive');
  this._gcps.push({name:String(name==null?'':name).trim(),src:a,dst:b,role:role,weight:weight,sigma:sigma});
  return this._gcps[this._gcps.length-1];
};
GCPManager.prototype.remove=function(name){var before=this._gcps.length;this._gcps=this._gcps.filter(function(g){return g.name!==name;});return before-this._gcps.length;};
GCPManager.prototype.list=function(){return this._gcps.map(function(g){return{name:g.name,src:g.src.slice(),dst:g.dst.slice(),role:g.role,weight:g.weight,sigma:g.sigma};});};
GCPManager.prototype.solve=function(opts){
  opts=opts||{};
  var controls=this._gcps.filter(function(g){return g.role!=='check';}),checks=this._gcps.filter(function(g){return g.role==='check';});
  if(controls.length<3)return null;
  var srcs=controls.map(function(g){return g.src;}),dsts=controls.map(function(g){return g.dst;}),rawWeights=controls.map(function(g){return g.weight;}),maxWeight=Math.max.apply(Math,rawWeights),baseWeights=rawWeights.map(function(w){return w/maxWeight;});
  var fit=_robustGcpFit(srcs,dsts,baseWeights,opts);if(!fit)return null;
  var T=fit.T,controlVectors=controls.map(function(g){return _residualVector(g,T);});
  var residuals=this._gcps.map(function(g){
    var v=_residualVector(g,T),r=Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]);
    return{name:g.name,residual:r,dx:v[0],dy:v[1],dz:v[2],role:g.role,weight:g.weight};
  });
  var rawSum=0,weightedSum=0,weightSum=0,maxControl=0;
  for(var i=0;i<controls.length;i++){var v=controlVectors[i],r=Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]);rawSum+=r*r;weightedSum+=fit.weights[i]*r*r;weightSum+=fit.weights[i];if(r>maxControl)maxControl=r;}
  var checkResiduals=residuals.filter(function(r){return r.role==='check';}),checkRms=null,maxCheck=0;
  if(checkResiduals.length){var ss=0;checkResiduals.forEach(function(r){ss+=r.residual*r.residual;if(r.residual>maxCheck)maxCheck=r.residual;});checkRms=Math.sqrt(ss/checkResiduals.length);}
  var controlRms=Math.sqrt(rawSum/controls.length),warnings=[];
  if(fit.iterations>0&&fit.weights.some(function(w,i){return w<baseWeights[i]*0.5;}))warnings.push('control_outlier_downweighted');
  if(!checks.length)warnings.push('no_independent_check_points');
  if(controls.length<4)warnings.push('low_control_redundancy');
  return{
    scale:T.scale,R:T.R,t:T.t,rms:controlRms,controlRms:controlRms,
    weightedRms:weightSum>0?Math.sqrt(weightedSum/weightSum):controlRms,
    checkRms:checkRms,maxCheckResidual:checks.length?maxCheck:null,
    maxControlResidual:maxControl,residualCovariance:_gcpCovariance(controlVectors,fit.weights),
    residuals:residuals,gcpCount:this._gcps.length,controlCount:controls.length,
    checkCount:checks.length,robustIterations:fit.iterations,
    robustWeights:fit.weights.slice(),warnings:warnings
  };
};
GCPManager.prototype.toCSV=function(){
  function esc(v){var s=String(v==null?'':v);return/[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
  var rows=['name,src_x,src_y,src_z,dst_x,dst_y,dst_z,weight,role'];
  this._gcps.forEach(function(g){rows.push([g.name,g.src[0],g.src[1],g.src[2],g.dst[0],g.dst[1],g.dst[2],g.weight,g.role].map(esc).join(','));});
  return rows.join('\n');
};

function _splitDelimitedLine(line,delimiter){
  var out=[],field='',quoted=false;
  for(var i=0;i<line.length;i++){
    var ch=line[i];
    if(ch==='"'){
      if(quoted&&line[i+1]==='"'){field+='"';i++;}
      else if(quoted)quoted=false;
      else if(!field.length)quoted=true;
      else field+=ch;
    }else if(ch===delimiter&&!quoted){out.push(field.trim());field='';}
    else field+=ch;
  }
  if(quoted)throw new Error('unterminated quoted field');
  out.push(field.trim());return out;
}
function _detectGcpDelimiter(line){
  var counts={',':0,';':0,'\t':0},quoted=false;
  for(var i=0;i<line.length;i++){var c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){i++;continue;}quoted=!quoted;}else if(!quoted&&Object.prototype.hasOwnProperty.call(counts,c))counts[c]++;}
  var best=',';
  Object.keys(counts).forEach(function(d){if(counts[d]>counts[best])best=d;});
  return counts[best]?best:',';
}
function parseGcpCsv(text){
  var lines=String(text==null?'':text).replace(/^\uFEFF/,'').split(/\r?\n/),first=-1;
  for(var i=0;i<lines.length;i++)if(lines[i].trim()&&!/^\s*#/.test(lines[i])){first=i;break;}
  if(first<0)return{points:[],errors:[{line:1,error:'empty_input'}],delimiter:',',header:false};
  var delimiter=_detectGcpDelimiter(lines[first]),header=false,columns=null,points=[],errors=[];
  try{columns=_splitDelimitedLine(lines[first],delimiter).map(function(x){return x.toLowerCase().replace(/[^a-z0-9]/g,'');});}
  catch(e){return{points:[],errors:[{line:first+1,error:'invalid_header'}],delimiter:delimiter,header:false};}
  var required=['name','srcx','srcy','srcz','dstx','dsty','dstz'];
  header=required.every(function(n){return columns.indexOf(n)>=0;});
  var ix=header?required.map(function(n){return columns.indexOf(n);}):[0,1,2,3,4,5,6];
  var weightIx=header?columns.indexOf('weight'):7,sigmaIx=header?columns.indexOf('sigma'):-1,roleIx=header?columns.indexOf('role'):8;
  var start=header?first+1:first;
  function num(s){
    s=String(s==null?'':s).trim();
    if(delimiter!==','&&s.indexOf(',')>=0&&s.indexOf('.')<0)s=s.replace(',','.');
    return s===''?NaN:Number(s);
  }
  for(var li=start;li<lines.length;li++){
    var line=lines[li];if(!line.trim()||/^\s*#/.test(line))continue;
    try{
      var p=_splitDelimitedLine(line,delimiter);
      if(p.length<7)throw new Error('expected at least 7 columns');
      var src=[num(p[ix[1]]),num(p[ix[2]]),num(p[ix[3]])],dst=[num(p[ix[4]]),num(p[ix[5]]),num(p[ix[6]])];
      if(!src.every(Number.isFinite)||!dst.every(Number.isFinite))throw new Error('coordinates must be finite numbers');
      var role=roleIx>=0?(p[roleIx]||'control'):'control',opts={role:role};
      if(weightIx>=0&&p[weightIx])opts.weight=num(p[weightIx]);
      if(sigmaIx>=0&&p[sigmaIx])opts.sigma=num(p[sigmaIx]);
      if(opts.weight!=null&&(!Number.isFinite(opts.weight)||opts.weight<=0))throw new Error('weight must be positive');
      if(opts.sigma!=null&&(!Number.isFinite(opts.sigma)||opts.sigma<=0))throw new Error('sigma must be positive');
      var normalized=String(role).toLowerCase();
      if(!['control','check','check-point','checkpoint','independent',''].includes(normalized))throw new Error('role must be control or check');
      points.push({name:p[ix[0]]||('P'+(points.length+1)),src:src,dst:dst,role:normalized==='check-point'||normalized==='checkpoint'||normalized==='independent'?'check':(normalized||'control'),weight:opts.weight,sigma:opts.sigma});
    }catch(e){errors.push({line:li+1,error:String(e&&e.message||e)});}
  }
  return{points:points,errors:errors,delimiter:delimiter,header:header};
}
var API={helmert3D:helmert3D,applyTransform:applyTransform,toViewerCloud:toViewerCloud,transformPt:transformPt,
  GCPManager:GCPManager,parseGcpCsv:parseGcpCsv,det3:det3,matInverse:matInverse,has2DSpread:has2DSpread,compareCrsWkt:compareCrsWkt};
if(typeof window!=='undefined') window.Georef=API;
if(typeof module!=='undefined'&&module.exports) module.exports=API;
})();
