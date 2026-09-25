
/* terrain.js — Sprint 4: progressive-morphological ground filter + DSM/DTM + contours + GeoTIFF.
 * window.Terrain + module.exports
 */
(function(){
'use strict';
// --- Progressive-morphological ground filter (CSF-style lower envelope) ---
// The former relaxation diffused elevated cells over the whole grid; on room
// scans that caused ceilings/walls to be reported as 100% ground. This uses a
// robust low-return raster, nearest-sample gap fill and progressive grayscale
// openings. It is deliberately described as CSF-style: it is not the original
// Zhang cloth simulation implementation.
function csfClassify(pos,count,opts){
  opts=opts||{};
  count=Math.max(0,Math.min(count|0,Math.floor((pos&&pos.length||0)/3)));
  var cell=Number(opts.cellSize)||0.5,thr=opts.threshold==null?0.15:Number(opts.threshold);
  var slope=opts.maxSlope==null?0.5:Number(opts.maxSlope), q=opts.outlierQuantile==null?0.002:Number(opts.outlierQuantile);
  if(!isFinite(cell)||cell<=0)cell=0.5;
  if(!isFinite(thr)||thr<0)thr=0.15;
  if(!isFinite(slope)||slope<0)slope=0.5;
  q=Math.max(0,Math.min(0.05,isFinite(q)?q:0.002));
  var labels=new Uint8Array(count);
  if(!count)return{labels:labels,groundCount:0,excludedCount:0,nx:0,nz:0,cell:cell,minX:0,minZ:0,cloth:new Float32Array(0),method:'progressive-morphological'};

  // Sampled robust bounds keep sparse distant returns from exploding the grid.
  function bounds(axis){
    var step=Math.max(1,Math.ceil(count/50000)),a=[];
    for(var i=0;i<count;i+=step){var v=pos[i*3+axis];if(isFinite(v))a.push(v);}
    a.sort(function(x,y){return x-y;});
    if(!a.length)return[Infinity,-Infinity];
    var lo=Math.floor((a.length-1)*q),hi=Math.ceil((a.length-1)*(1-q));
    return[a[lo],a[hi]];
  }
  var rx=bounds(0),ry=bounds(1),rz=bounds(2);
  var minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity,usable=0,excludedCount=0;
  for(var i=0;i<count;i++){
    var x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2];
    if(!isFinite(x)||!isFinite(y)||!isFinite(z)||x<rx[0]||x>rx[1]||y<ry[0]||y>ry[1]||z<rz[0]||z>rz[1]){excludedCount++;continue;}
    usable++;if(x<minX)minX=x;if(x>maxX)maxX=x;if(z<minZ)minZ=z;if(z>maxZ)maxZ=z;
  }
  if(!usable||!isFinite(minX)){
    return{labels:labels,groundCount:0,excludedCount:count,nx:0,nz:0,cell:cell,minX:0,minZ:0,cloth:new Float32Array(0),method:'progressive-morphological'};
  }
  var nx=Math.max(2,Math.ceil((maxX-minX)/cell)+1),nz=Math.max(2,Math.ceil((maxZ-minZ)/cell)+1);
  // Bound working memory for very large extents; report the effective cell size.
  var maxCells=Math.max(4096,Number(opts.maxGridCells)||4000000);
  if(nx*nz>maxCells){cell*=Math.sqrt(nx*nz/maxCells);nx=Math.max(2,Math.ceil((maxX-minX)/cell)+1);nz=Math.max(2,Math.ceil((maxZ-minZ)/cell)+1);}
  var ncell=nx*nz,minY=new Float32Array(ncell);minY.fill(Infinity);
  for(var i=0;i<count;i++){
    var x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2];
    if(!isFinite(x)||!isFinite(y)||!isFinite(z)||x<rx[0]||x>rx[1]||y<ry[0]||y>ry[1]||z<rz[0]||z>rz[1])continue;
    var gx=Math.min(nx-1,Math.floor((x-minX)/cell)),gz=Math.min(nz-1,Math.floor((z-minZ)/cell)),k=gz*nx+gx;
    if(y<minY[k])minY[k]=y;
  }
  // Fill raster holes with the nearest measured low return (linear-time BFS).
  var dist=new Int32Array(ncell);dist.fill(-1);
  var queue=new Int32Array(ncell),head=0,tail=0;
  for(var k=0;k<ncell;k++)if(isFinite(minY[k])){dist[k]=0;queue[tail++]=k;}
  while(head<tail){
    var k=queue[head++],x=k%nx,z=(k/nx)|0;
    var u;
    if(x>0){u=k-1;if(dist[u]<0){dist[u]=dist[k]+1;minY[u]=minY[k];queue[tail++]=u;}}
    if(x+1<nx){u=k+1;if(dist[u]<0){dist[u]=dist[k]+1;minY[u]=minY[k];queue[tail++]=u;}}
    if(z>0){u=k-nx;if(dist[u]<0){dist[u]=dist[k]+1;minY[u]=minY[k];queue[tail++]=u;}}
    if(z+1<nz){u=k+nx;if(dist[u]<0){dist[u]=dist[k]+1;minY[u]=minY[k];queue[tail++]=u;}}
  }

  // Separable sliding-window min/max filters keep morphology O(grid size),
  // rather than O(window²), so a useful metre-scale window remains practical.
  var cap=Math.max(nx,nz),deque=new Int32Array(cap);
  function lineFilter(src,dst,len,stride,base,radius,wantMin){
    var lo=0,hi=0,right=-1;
    for(var x=0;x<len;x++){
      var target=Math.min(len-1,x+radius);
      while(right<target){
        right++;
        var val=src[base+right*stride];
        while(hi>lo){
          var old=src[base+deque[hi-1]*stride];
          if(wantMin?old>val:old<val)hi--;else break;
        }
        deque[hi++]=right;
      }
      var left=Math.max(0,x-radius);
      while(hi>lo&&deque[lo]<left)lo++;
      dst[base+x*stride]=src[base+deque[lo]*stride];
    }
  }
  function filter2D(src,radius,wantMin){
    var tmp=new Float32Array(ncell),out=new Float32Array(ncell);
    for(var z=0;z<nz;z++)lineFilter(src,tmp,nx,1,z*nx,radius,wantMin);
    for(var x=0;x<nx;x++)lineFilter(tmp,out,nz,nx,x,radius,wantMin);
    return out;
  }
  var radii=opts.radii&&opts.radii.length?opts.radii.slice():[1,2,4];
  radii=radii.map(function(r){return Math.max(1,Math.min(32,Math.round(Number(r)||1)));}).filter(function(r,i,a){return a.indexOf(r)===i;}).sort(function(a,b){return a-b;});
  var groundSurface=new Float32Array(minY);
  for(var ri=0;ri<radii.length;ri++){
    var rad=radii[ri],opened=filter2D(filter2D(minY,rad,true),rad,false),allow=slope*rad*cell;
    for(var k=0;k<ncell;k++){
      var candidate=Math.min(minY[k],opened[k]+allow);
      if(candidate<groundSurface[k])groundSurface[k]=candidate;
    }
  }
  var groundCount=0;
  for(var i=0;i<count;i++){
    var x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2];
    if(!isFinite(x)||!isFinite(y)||!isFinite(z)||x<rx[0]||x>rx[1]||y<ry[0]||y>ry[1]||z<rz[0]||z>rz[1])continue;
    var gx=Math.min(nx-1,Math.floor((x-minX)/cell)),gz=Math.min(nz-1,Math.floor((z-minZ)/cell)),cy=groundSurface[gz*nx+gx];
    if(y<=cy+thr){labels[i]=1;groundCount++;}
  }
  return{labels:labels,groundCount:groundCount,excludedCount:excludedCount,nx:nx,nz:nz,cell:cell,minX:minX,minZ:minZ,cloth:groundSurface,method:'progressive-morphological'};
}
function buildDSM(pos,count,opts){
  opts=opts||{};
  count=Math.max(0,Math.min(Math.floor(Number(count)||0),Math.floor((pos&&pos.length||0)/3)));
  var requestedCell=Number(opts.cell),cell=isFinite(requestedCell)&&requestedCell>0?requestedCell:0.5;
  var minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity,validPointCount=0;
  for(var i=0;i<count;i++){
    var x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2];
    if(!isFinite(x)||!isFinite(y)||!isFinite(z))continue;
    validPointCount++;if(x<minX)minX=x;if(x>maxX)maxX=x;if(z<minZ)minZ=z;if(z>maxZ)maxZ=z;
  }
  if(!validPointCount||!isFinite(minX))return{grid:new Float32Array(0),nx:0,nz:0,minX:0,maxX:0,minZ:0,maxZ:0,cell:cell,sourcePointCount:count,validPointCount:0,validCells:0,interpolatedCells:0};
  var maxCells=Number(opts.maxGridCells);
  if(!isFinite(maxCells)||maxCells<4)maxCells=4000000;
  maxCells=Math.floor(Math.max(4,Math.min(16000000,maxCells)));
  function size(extent){return Math.max(2,Math.ceil(extent/cell)+1);}
  var nx=size(maxX-minX),nz=size(maxZ-minZ),guard=0;
  // Prevent sparse returns or a stray coordinate from allocating an unbounded grid.
  // Coarsen evenly, then adjust for ceil/rounding until the configured cell cap holds.
  while(nx*nz>maxCells&&guard++<64){
    cell*=Math.max(1.01,Math.sqrt(nx*nz/maxCells)*1.001);
    nx=size(maxX-minX);nz=size(maxZ-minZ);
  }
  if(nx*nz>maxCells)throw new RangeError('DSM grid exceeds safe cell limit');
  var ncell=nx*nz,grid=new Float32Array(ncell);grid.fill(-Infinity);
  for(var i=0;i<count;i++){
    var x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2];
    if(!isFinite(x)||!isFinite(y)||!isFinite(z))continue;
    var gx=Math.min(nx-1,Math.floor((x-minX)/cell));
    var gz=Math.min(nz-1,Math.floor((z-minZ)/cell)),k=gz*nx+gx;
    if(y>grid[k])grid[k]=y;
  }
  // Fill gaps from the nearest observed cell (deterministic multi-source BFS),
  // and expose coverage so exports/UI can disclose how much of the raster was inferred.
  var seen=new Uint8Array(ncell),queue=new Int32Array(ncell),head=0,tail=0,validCells=0;
  for(var k=0;k<ncell;k++)if(isFinite(grid[k])){seen[k]=1;queue[tail++]=k;validCells++;}
  while(head<tail){
    var k=queue[head++],gx=k%nx,gz=(k/nx)|0,u;
    if(gx>0){u=k-1;if(!seen[u]){seen[u]=1;grid[u]=grid[k];queue[tail++]=u;}}
    if(gx+1<nx){u=k+1;if(!seen[u]){seen[u]=1;grid[u]=grid[k];queue[tail++]=u;}}
    if(gz>0){u=k-nx;if(!seen[u]){seen[u]=1;grid[u]=grid[k];queue[tail++]=u;}}
    if(gz+1<nz){u=k+nx;if(!seen[u]){seen[u]=1;grid[u]=grid[k];queue[tail++]=u;}}
  }
  return{grid:grid,nx:nx,nz:nz,minX:minX,maxX:maxX,minZ:minZ,maxZ:maxZ,cell:cell,requestedCell:requestedCell>0?requestedCell:0.5,sourcePointCount:count,validPointCount:validPointCount,validCells:validCells,interpolatedCells:ncell-validCells};
}
function buildDTM(pos,count,opts){
  opts=opts||{};
  var labels=opts.labels||null,cell=Number(opts.cell)||0.5;
  if(!isFinite(cell)||cell<=0)cell=0.5;
  count=Math.max(0,Math.min(count|0,Math.floor((pos&&pos.length||0)/3)));
  var minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity,used=0;
  for(var i=0;i<count;i++){
    if(labels&&labels[i]!==1)continue;
    var x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2];
    if(!isFinite(x)||!isFinite(y)||!isFinite(z))continue;
    used++;if(x<minX)minX=x;if(x>maxX)maxX=x;if(z<minZ)minZ=z;if(z>maxZ)maxZ=z;
  }
  if(!used||!isFinite(minX))return{grid:new Float32Array(0),nx:0,nz:0,minX:0,maxX:0,minZ:0,maxZ:0,cell:cell,validCount:0,interpolatedCells:0};
  var nx=Math.max(2,Math.ceil((maxX-minX)/cell)+1),nz=Math.max(2,Math.ceil((maxZ-minZ)/cell)+1);
  var maxCells=Math.max(4096,Number(opts.maxGridCells)||4000000);
  if(nx*nz>maxCells){cell*=Math.sqrt(nx*nz/maxCells);nx=Math.max(2,Math.ceil((maxX-minX)/cell)+1);nz=Math.max(2,Math.ceil((maxZ-minZ)/cell)+1);}
  var ncell=nx*nz,sum=new Float64Array(ncell),hits=new Uint32Array(ncell);
  for(var i=0;i<count;i++){
    if(labels&&labels[i]!==1)continue;
    var x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2];
    if(!isFinite(x)||!isFinite(y)||!isFinite(z))continue;
    var gx=Math.min(nx-1,Math.floor((x-minX)/cell)),gz=Math.min(nz-1,Math.floor((z-minZ)/cell)),k=gz*nx+gx;
    sum[k]+=y;hits[k]++;
  }
  var grid=new Float32Array(ncell),seen=new Uint8Array(ncell),queue=new Int32Array(ncell),head=0,tail=0,validCells=0;
  for(var k=0;k<ncell;k++)if(hits[k]){grid[k]=sum[k]/hits[k];seen[k]=1;queue[tail++]=k;validCells++;}
  // Fill holes by nearest measured ground cell; expose the interpolated area.
  while(head<tail){
    var k=queue[head++],x=k%nx,z=(k/nx)|0,u;
    if(x>0){u=k-1;if(!seen[u]){seen[u]=1;grid[u]=grid[k];queue[tail++]=u;}}
    if(x+1<nx){u=k+1;if(!seen[u]){seen[u]=1;grid[u]=grid[k];queue[tail++]=u;}}
    if(z>0){u=k-nx;if(!seen[u]){seen[u]=1;grid[u]=grid[k];queue[tail++]=u;}}
    if(z+1<nz){u=k+nx;if(!seen[u]){seen[u]=1;grid[u]=grid[k];queue[tail++]=u;}}
  }
  return{grid:grid,nx:nx,nz:nz,minX:minX,maxX:maxX,minZ:minZ,maxZ:maxZ,cell:cell,validCount:used,validCells:validCells,interpolatedCells:ncell-validCells};
}
function buildContours(dsm,opts){
  opts=opts||{};
  if(!dsm||!dsm.grid||!dsm.grid.length)return[];
  var nx=Math.floor(Number(dsm.nx)),nz=Math.floor(Number(dsm.nz)),g=dsm.grid,cell=Number(dsm.cell);
  if(!isFinite(nx)||!isFinite(nz)||nx<2||nz<2||nx*nz>g.length||!isFinite(cell)||cell<=0)return[];
  var interval=opts.interval==null?1.0:Number(opts.interval);
  if(!isFinite(interval)||interval<=0)throw new RangeError('Шаг горизонталей должен быть положительным конечным числом');
  var mn=Infinity,mx=-Infinity;
  for(var i=0;i<nx*nz;i++){if(isFinite(g[i])){if(g[i]<mn)mn=g[i];if(g[i]>mx)mx=g[i];}}
  if(!isFinite(mn)||!isFinite(mx)||mx<mn)return[];
  var first=Math.ceil(mn/interval)*interval;
  if(!isFinite(first))throw new RangeError('Невозможно вычислить уровни горизонталей для выбранного шага');
  var levelCount=Math.max(0,Math.floor((mx-first)/interval+1e-9)+1);
  // A fine interval across a large raster can otherwise monopolize the UI
  // thread (and allocate millions of segment arrays). Fail with guidance.
  var maxLevels=4096,maxWork=25000000;
  if(!isFinite(levelCount)||levelCount>maxLevels||levelCount*(nx-1)*(nz-1)>maxWork)
    throw new RangeError('Слишком много уровней для расчёта. Увеличьте шаг горизонталей или используйте более крупную ячейку DSM');
  var levels=[];
  for(var li=0;li<levelCount;li++)levels.push(first+li*interval);
  var contours=[];
  var totalSegments=0,maxSegments=250000;
  levels.forEach(function(lev){
    var segs=[];
    for(var z=0;z<nz-1;z++) for(var x=0;x<nx-1;x++){
      var v00=g[z*nx+x],v10=g[z*nx+x+1],v01=g[(z+1)*nx+x],v11=g[(z+1)*nx+x+1];
      if(!isFinite(v00)||!isFinite(v10)||!isFinite(v01)||!isFinite(v11))continue;
      var wx0=dsm.minX+x*cell,wz0=dsm.minZ+z*cell;
      function interp(a,b,va,vb){
        if(Math.abs(vb-va)<1e-12)return 0.5;
        return(lev-va)/(vb-va);
      }
      var pts=[];
      if((v00<lev)!==(v10<lev)){var t=interp(0,1,v00,v10);pts.push([wx0+t*cell,wz0]);}
      if((v10<lev)!==(v11<lev)){var t=interp(0,1,v10,v11);pts.push([wx0+cell,wz0+t*cell]);}
      if((v01<lev)!==(v11<lev)){var t=interp(0,1,v01,v11);pts.push([wx0+t*cell,wz0+cell]);}
      if((v00<lev)!==(v01<lev)){var t=interp(0,1,v00,v01);pts.push([wx0,wz0+t*cell]);}
      if(pts.length>=2){
        if(++totalSegments>maxSegments)throw new RangeError('Слишком много сегментов горизонталей. Увеличьте шаг или размер ячейки DSM');
        segs.push([pts[0],pts[1]]);
      }
    }
    if(segs.length) contours.push({level:lev,segments:segs});
  });
  return contours;
}
function contoursToDxf(contours){
  var L=['0','SECTION','2','ENTITIES'];
  contours.forEach(function(c){
    c.segments.forEach(function(s){
      L.push('0','LINE','8','CONTOURS',
        '10',s[0][0].toFixed(4),'20',c.level.toFixed(4),'30',s[0][1].toFixed(4),
        '11',s[1][0].toFixed(4),'21',c.level.toFixed(4),'31',s[1][1].toFixed(4));
    });
  });
  L.push('0','ENDSEC','0','EOF');
  return L.join('\n');
}
function slopeColors(dsm,maxSlope){
  maxSlope=maxSlope||45;
  var nx=dsm.nx,nz=dsm.nz,g=dsm.grid,cell=dsm.cell;
  var colors=new Uint8Array(nx*nz*3);
  for(var z=0;z<nz;z++) for(var x=0;x<nx;x++){
    var idx=z*nx+x;
    var dydx=0,dydz=0;
    if(x>0&&x<nx-1) dydx=(g[idx+1]-g[idx-1])/(2*cell);
    else if(x>0) dydx=(g[idx]-g[idx-1])/cell;
    else if(x<nx-1) dydx=(g[idx+1]-g[idx])/cell;
    if(z>0&&z<nz-1) dydz=(g[idx+nx]-g[idx-nx])/(2*cell);
    else if(z>0) dydz=(g[idx]-g[idx-nx])/cell;
    else if(z<nz-1) dydz=(g[idx+nx]-g[idx])/cell;
    var slope=Math.atan(Math.sqrt(dydx*dydx+dydz*dydz))*180/Math.PI;
    var t=Math.min(1,slope/maxSlope);
    colors[idx*3]=Math.round(t*255);
    colors[idx*3+1]=Math.round((1-t)*200);
    colors[idx*3+2]=50;
  }
  return{nx:nx,nz:nz,data:colors};
}
function dsmToTiff(dsm){
  // Single-strip Float32 GeoTIFF with pixel scale, tiepoint and CRS GeoKeys.
  var nx=dsm.nx,nz=dsm.nz,geo=dsm.geo||{},wkt=String(geo.crsWkt||'').replace(/[\0\r\n]/g,' ').trim();
  if(!nx||!nz||!dsm.grid||dsm.grid.length<nx*nz)throw new Error('GeoTIFF: пустая или неполная сетка');
  var projected=/PROJCRS|PROJCS/i.test(wkt),geographic=!projected&&/GEOGCRS|GEOGCS/i.test(wkt),modelType=projected?1:geographic?2:0;
  var epsg=null,re=/(?:ID|AUTHORITY)\s*\[\s*["']EPSG["']\s*,\s*["']?(\d+)/gi,m;
  while((m=re.exec(wkt)))epsg=Number(m[1]);
  if(!(epsg>0&&epsg<=65535))epsg=null;
  var keys=[[1024,0,1,modelType],[1025,0,1,1]],citeKey=projected?3073:(geographic?2049:0);
  if(epsg)keys.push([projected?3072:2048,0,1,epsg]);
  var ascii=wkt&&citeKey?wkt.replace(/\|/g,' ' )+'|':'',asciiBytes=ascii?new TextEncoder().encode(ascii):new Uint8Array(0);
  if(ascii)keys.push([citeKey,34737,asciiBytes.length,0]);
  var keyWords=[1,1,0,keys.length];keys.forEach(function(k){keyWords.push(k[0],k[1],k[2],k[3]);});
  var keyBytes=keyWords.length*2,nxnz=nx*nz,stripByteCount=nxnz*4,IFD_OFFSET=8,NTAGS=17+(asciiBytes.length?1:0),IFD_SIZE=2+NTAGS*12+4;
  var stripOffset=IFD_OFFSET+IFD_SIZE,scaleOffset=stripOffset+stripByteCount,tieOffset=scaleOffset+24,xresOffset=tieOffset+48,yresOffset=xresOffset+8,keyOffset=yresOffset+8,asciiOffset=keyOffset+keyBytes;
  var buf=new ArrayBuffer(asciiBytes.length?asciiOffset+asciiBytes.length:keyOffset+keyBytes),v=new DataView(buf);
  v.setUint8(0,0x49);v.setUint8(1,0x49);v.setUint16(2,42,true);v.setUint32(4,IFD_OFFSET,true);
  var p=IFD_OFFSET;v.setUint16(p,NTAGS,true);p+=2;
  function tag(code,type,cnt,val){v.setUint16(p,code,true);v.setUint16(p+2,type,true);v.setUint32(p+4,cnt,true);v.setUint32(p+8,val,true);p+=12;}
  tag(256,nx>65535?4:3,1,nx);tag(257,nz>65535?4:3,1,nz);tag(258,3,1,32);tag(259,3,1,1);
  tag(262,3,1,1);tag(277,3,1,1);tag(278,3,1,nz);tag(279,4,1,stripByteCount);
  tag(284,3,1,1);tag(339,3,1,3);tag(273,4,1,stripOffset);
  tag(282,5,1,xresOffset);tag(283,5,1,yresOffset);tag(296,3,1,1);
  tag(33550,12,3,scaleOffset);tag(33922,12,6,tieOffset);tag(34735,3,keyWords.length,keyOffset);
  if(asciiBytes.length)tag(34737,2,asciiBytes.length,asciiOffset);
  v.setUint32(p,0,true);
  var scale=new DataView(buf,scaleOffset,24);scale.setFloat64(0,dsm.cell||1,true);scale.setFloat64(8,dsm.cell||1,true);scale.setFloat64(16,0,true);
  var tie=new DataView(buf,tieOffset,48),originX=geo.originX!=null?geo.originX:(dsm.minX||0),originY=geo.originY!=null?geo.originY:(dsm.maxZ!=null?dsm.maxZ:-(dsm.minZ||0));
  [0,0,0,originX,0,originY].forEach(function(x,i){tie.setFloat64(i*8,x,true);});
  [xresOffset,yresOffset].forEach(function(o){var rv=new DataView(buf,o,8);rv.setUint32(0,1,true);rv.setUint32(4,1,true);});
  var kv=new DataView(buf,keyOffset,keyBytes);keyWords.forEach(function(x,i){kv.setUint16(i*2,x,true);});
  if(asciiBytes.length)new Uint8Array(buf,asciiOffset,asciiBytes.length).set(asciiBytes);
  // Grid z grows northward. GeoTIFF rows grow southward; flip when requested.
  var dst=new DataView(buf,stripOffset,stripByteCount),flip=geo.flipRows!==false;
  for(var row=0;row<nz;row++)for(var x=0;x<nx;x++){
    var srcRow=flip?nz-1-row:row;dst.setFloat32((row*nx+x)*4,dsm.grid[srcRow*nx+x],true);
  }
  return buf;
}
function classStats(pos,count,labels){
  var gMin=Infinity,gMax=-Infinity,ngMin=Infinity,ngMax=-Infinity;
  for(var i=0;i<count;i++){
    var y=pos[i*3+1];
    if(labels[i]===1){if(y<gMin)gMin=y;if(y>gMax)gMax=y;}
    else{if(y<ngMin)ngMin=y;if(y>ngMax)ngMax=y;}
  }
  return{ground:{min:gMin,max:gMax},nonGround:{min:ngMin,max:ngMax}};
}
var API={csfClassify:csfClassify,buildDSM:buildDSM,buildDTM:buildDTM,buildContours:buildContours,
  contoursToDxf:contoursToDxf,slopeColors:slopeColors,dsmToTiff:dsmToTiff,classStats:classStats};
if(typeof window!=='undefined') window.Terrain=API;
if(typeof module!=='undefined'&&module.exports) module.exports=API;
})();
