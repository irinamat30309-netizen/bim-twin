
/* export-hub.js — Sprint 7 (v1225): PDF, SHP, E57, GeoTIFF export hub.
 * window.ExportHub + module.exports
 */
(function(){
'use strict';

// ── PDF ───────────────────────────────────────────────────────────────────
// Minimal PDF-1.4 builder (no external deps)
function makePDF(opts){
  opts=opts||{};
  var title=opts.title||'BIM Twin Report';
  var date=opts.date||new Date().toISOString().split('T')[0];
  var lines=opts.lines||[];
  // content stream
  var textLines=[];
  textLines.push('BT');
  textLines.push('/F1 16 Tf');
  textLines.push('50 780 Td');
  textLines.push('('+pdfEsc(title)+') Tj');
  textLines.push('/F1 10 Tf');
  textLines.push('0 -20 Td');
  textLines.push('('+pdfEsc(date)+') Tj');
  textLines.push('0 -20 Td');
  lines.forEach(function(l){
    textLines.push('('+pdfEsc(String(l))+') Tj');
    textLines.push('0 -14 Td');
  });
  textLines.push('ET');
  var content=textLines.join('\n');
  // objects
  var objs=[];
  var offsets=[];
  function addObj(id,body){
    offsets.push(-1); // filled later
    objs.push({id:id,body:body});
  }
  addObj(1,'<< /Type /Catalog /Pages 2 0 R >>');
  addObj(2,'<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  addObj(3,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]\n'+
    '/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  addObj(4,'<< /Length '+content.length+' >>\nstream\n'+content+'\nendstream');
  addObj(5,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  // serialize
  var out='%PDF-1.4\n';
  objs.forEach(function(o,i){
    offsets[i]=out.length;
    out+=o.id+' 0 obj\n'+o.body+'\nendobj\n';
  });
  var xref=out.length;
  out+='xref\n0 '+(objs.length+1)+'\n';
  out+='0000000000 65535 f \n';
  offsets.forEach(function(o){out+=pad10(o)+' 00000 n \n';});
  out+='trailer\n<< /Size '+(objs.length+1)+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';
  return out;
}
function pdfEsc(s){return s.replace(/[\\()]/g,function(c){return'\\'+c;}).replace(/[\x00-\x1f]/g,' ');}
function pad10(n){var s=String(n);while(s.length<10)s='0'+s;return s;}

// ── SHP ───────────────────────────────────────────────────────────────────
// ESRI Shapefile binary writer
function exportSHP(shapes,opts){
  opts=opts||{};
  var type=opts.type||'polyline';
  var shpType=type==='point'?1:type==='polygon'?5:3; // 1=point,3=polyline,5=polygon
  // SHP header: 100 bytes
  var SHP_HDR=100;
  var SHX_HDR=100;
  var records=[];
  var contentLen=0; // in 16-bit words
  shapes.forEach(function(shape,ri){
    var recBuf;
    if(shpType===1){
      // point: ShapeType(4)+X(8)+Y(8) = 20 bytes content
      recBuf=new ArrayBuffer(20);
      var dv=new DataView(recBuf);
      dv.setInt32(0,1,true);
      dv.setFloat64(4,shape[0]||0,true);
      dv.setFloat64(12,shape[1]||0,true);
    } else {
      // polyline/polygon: 4+32+4+4+numPts*4+numPts*16
      var pts=shape;
      var numParts=1,numPts=pts.length;
      var recLen=4+32+4+4+numParts*4+numPts*16;
      recBuf=new ArrayBuffer(recLen);
      var dv=new DataView(recBuf);
      var minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
      pts.forEach(function(p){if(p[0]<minX)minX=p[0];if(p[0]>maxX)maxX=p[0];if(p[1]<minY)minY=p[1];if(p[1]>maxY)maxY=p[1];});
      var p=0;
      dv.setInt32(p,shpType,true);p+=4;
      dv.setFloat64(p,minX,true);p+=8;dv.setFloat64(p,minY,true);p+=8;
      dv.setFloat64(p,maxX,true);p+=8;dv.setFloat64(p,maxY,true);p+=8;
      dv.setInt32(p,numParts,true);p+=4;
      dv.setInt32(p,numPts,true);p+=4;
      dv.setInt32(p,0,true);p+=4; // part[0]=0
      pts.forEach(function(pt){dv.setFloat64(p,pt[0],true);p+=8;dv.setFloat64(p,pt[1],true);p+=8;});
    }
    records.push(recBuf);
    contentLen+=recBuf.byteLength/2+4; // record header = 8 bytes = 4 words
  });
  // bounding box
  var allMinX=Infinity,allMaxX=-Infinity,allMinY=Infinity,allMaxY=-Infinity;
  shapes.forEach(function(shape){
    var pts=shpType===1?[shape]:shape;
    pts.forEach(function(p){if(p[0]<allMinX)allMinX=p[0];if(p[0]>allMaxX)allMaxX=p[0];if(p[1]<allMinY)allMinY=p[1];if(p[1]>allMaxY)allMaxY=p[1];});
  });
  var totalShpLen=(SHP_HDR+contentLen*2);
  var shpBuf=new ArrayBuffer(totalShpLen);
  var shv=new DataView(shpBuf);
  shv.setInt32(0,9994,false);  // file code BE
  shv.setInt32(24,SHP_HDR/2+contentLen,false); // file length in 16-bit words BE
  shv.setInt32(28,1000,true);  // version LE
  shv.setInt32(32,shpType,true); // shape type LE
  shv.setFloat64(36,allMinX,true);shv.setFloat64(44,allMinY,true);
  shv.setFloat64(52,allMaxX,true);shv.setFloat64(60,allMaxY,true);
  shv.setFloat64(68,0,true);shv.setFloat64(76,0,true); // Z range
  shv.setFloat64(84,0,true);shv.setFloat64(92,0,true); // M range
  var shxBuf=new ArrayBuffer(SHX_HDR+records.length*8);
  var sxv=new DataView(shxBuf);
  sxv.setInt32(0,9994,false);
  sxv.setInt32(24,(SHX_HDR/2+records.length*4),false);
  sxv.setInt32(28,1000,true);sxv.setInt32(32,shpType,true);
  sxv.setFloat64(36,allMinX,true);sxv.setFloat64(44,allMinY,true);
  sxv.setFloat64(52,allMaxX,true);sxv.setFloat64(60,allMaxY,true);
  // write records
  var offset=SHP_HDR;
  records.forEach(function(rec,i){
    // record header (BE): record number (1-based), content length in 16-bit words
    shv.setInt32(offset,i+1,false);
    shv.setInt32(offset+4,rec.byteLength/2,false);
    var src=new Uint8Array(rec);
    var dst=new Uint8Array(shpBuf,offset+8);
    dst.set(src);
    // SHX entry
    sxv.setInt32(SHX_HDR+i*8,offset/2,false);
    sxv.setInt32(SHX_HDR+i*8+4,rec.byteLength/2,false);
    offset+=8+rec.byteLength;
  });
  // DBF (simple)
  var dbfRows=['ID'];
  shapes.forEach(function(s,i){dbfRows.push(i+1);});
  var dbf='ID\n'+shapes.map(function(s,i){return i+1;}).join('\n');
  return{shp:shpBuf,shx:shxBuf,dbf:dbf};
}

// ── PLY point-cloud export (double precision for survey coordinates) ──────
function _plyInfo(cloud){
  var p=cloud.pos,n=cloud.count!=null?cloud.count:(p.length/3)|0,c=cloud.col&&cloud.col.length>=n*3?cloud.col:null;
  var intensity=cloud.intensity&&cloud.intensity.length>=n?cloud.intensity:null;
  var classification=cloud.classification&&cloud.classification.length>=n?cloud.classification:null;
  var meta=cloud.meta||{},axis=meta.srcXform&&meta.srcXform.axis;
  var zup=axis==='zup',up=zup?'z':'y',wide=zup;
  for(var i=0;i<Math.min(n,1000)&&!wide;i++)if(Math.max(Math.abs(p[i*3]),Math.abs(p[i*3+1]),Math.abs(p[i*3+2]))>100000)wide=true;
  var type=wide?'double':'float',bytes=wide?8:4;
  var h=['ply','format binary_little_endian 1.0','comment BIM Twin survey point cloud','comment up='+up];
  if(meta.units)h.push('comment units='+String(meta.units).replace(/[\r\n]/g,' '));
  if(meta.crsWkt)h.push('comment crs_wkt_uri='+encodeURIComponent(String(meta.crsWkt)));
  h.push('element vertex '+n,'property '+type+' x','property '+type+' y','property '+type+' z');
  if(intensity)h.push('property float intensity');
  if(c)h.push('property uchar red','property uchar green','property uchar blue');
  if(classification)h.push('property uchar classification');
  h.push('end_header','');
  return{p:p,c:c,intensity:intensity,classification:classification,n:n,zup:zup,up:up,wide:wide,bytes:bytes,header:new TextEncoder().encode(h.join('\n'))};
}
function _plyColorScale(c){if(!c)return false;var mx=0;for(var i=0;i<Math.min(c.length,3000);i++)if(c[i]>mx)mx=c[i];return mx>1.0001;}
function _intensityScale(a,n){if(!a)return 1;var mx=0;for(var i=0;i<Math.min(n,3000);i++)if(a[i]>mx)mx=a[i];return mx>1.0001?mx:1;}
function _plyStride(q){return q.bytes*3+(q.intensity?4:0)+(q.c?3:0)+(q.classification?1:0);}
function _writePlyPoint(dv,o,q,i,scaled,intensityDiv){
  for(var a=0;a<3;a++){var v=q.p[i*3+a];if(q.wide){dv.setFloat64(o,v,true);o+=8;}else{dv.setFloat32(o,v,true);o+=4;}}
  if(q.intensity){var iv=Number(q.intensity[i])/intensityDiv;dv.setFloat32(o,Math.max(0,Math.min(1,isFinite(iv)?iv:0)),true);o+=4;}
  if(q.c)for(var a=0;a<3;a++){var cv=scaled?Math.round(q.c[i*3+a]):Math.round(q.c[i*3+a]*255);dv.setUint8(o++,Math.max(0,Math.min(255,cv)));}
  if(q.classification){var cl=Number(q.classification[i]);dv.setUint8(o++,Math.max(0,Math.min(255,isFinite(cl)?Math.round(cl):0)));}
  return o;
}
function exportPLY(cloud){
  var q=_plyInfo(cloud),scaled=_plyColorScale(q.c),stride=_plyStride(q),intensityDiv=_intensityScale(q.intensity,q.n),body=new ArrayBuffer(q.n*stride),dv=new DataView(body),o=0;
  for(var i=0;i<q.n;i++)o=_writePlyPoint(dv,o,q,i,scaled,intensityDiv);
  var out=new Uint8Array(q.header.length+body.byteLength);out.set(q.header);out.set(new Uint8Array(body),q.header.length);return out;
}
async function exportPLYAsync(cloud,onProgress){
  var q=_plyInfo(cloud),scaled=_plyColorScale(q.c),stride=_plyStride(q),intensityDiv=_intensityScale(q.intensity,q.n),body=new ArrayBuffer(q.n*stride),dv=new DataView(body),o=0,chunk=250000;
  for(var s=0;s<q.n;s+=chunk){var e=Math.min(q.n,s+chunk);for(var i=s;i<e;i++)o=_writePlyPoint(dv,o,q,i,scaled,intensityDiv);if(onProgress)try{onProgress(e/q.n);}catch(_){}if(e<q.n)await new Promise(function(resolve){setTimeout(resolve,0);});}
  var out=new Uint8Array(q.header.length+body.byteLength);out.set(q.header);out.set(new Uint8Array(body),q.header.length);return out;
}

// ── LAS 1.4 export with optional WKT VLR ─────────────────────────────────
function exportLAS(cloud){
  var pos=cloud.pos,col=cloud.col&&cloud.col.length>=(cloud.count!=null?cloud.count:cloud.pos.length/3)*3?cloud.col:null;
  var classification=cloud.classification&&cloud.classification.length>=(cloud.count!=null?cloud.count:cloud.pos.length/3)?cloud.classification:null;
  var intensity=cloud.intensity&&cloud.intensity.length>=(cloud.count!=null?cloud.count:cloud.pos.length/3)?cloud.intensity:null;
  var n=cloud.count!=null?cloud.count:(pos.length/3)|0,wkt=cloud.meta&&cloud.meta.crsWkt||'';
  var mn=[Infinity,Infinity,Infinity],mx=[-Infinity,-Infinity,-Infinity];
  for(var i=0;i<n;i++)for(var a=0;a<3;a++){var v=pos[i*3+a];if(v<mn[a])mn[a]=v;if(v>mx[a])mx[a]=v;}
  if(!n)mn=[0,0,0],mx=[0,0,0];
  var scale=[0.001,0.001,0.001],offset=mn.slice();
  for(var a=0;a<3;a++)scale[a]=Math.max(scale[a],(mx[a]-mn[a])/2147483000);
  var wktBytes=wkt?new TextEncoder().encode(wkt+'\0'):new Uint8Array(0);if(wktBytes.length>65535)wktBytes=new Uint8Array(0);
  var header=375,vlrLen=wktBytes.length?54+wktBytes.length:0,pointOffset=header+vlrLen,rec=36,out=new Uint8Array(pointOffset+n*rec),dv=new DataView(out.buffer);
  out.set([0x4c,0x41,0x53,0x46],0);dv.setUint8(24,1);dv.setUint8(25,4);dv.setUint16(6,wktBytes.length?0x10:0,true);
  var sys='BIM Twin';for(var i=0;i<sys.length;i++){out[26+i]=sys.charCodeAt(i);out[58+i]=sys.charCodeAt(i);}
  dv.setUint16(94,header,true);dv.setUint32(96,pointOffset,true);dv.setUint32(100,wktBytes.length?1:0,true);dv.setUint8(104,7);dv.setUint16(105,rec,true);
  // LAS 1.4 PDRF 7 uses the extended point count (legacy count must remain zero).
  dv.setUint32(107,0,true);dv.setUint32(111,n,true);for(var a=0;a<3;a++){dv.setFloat64(131+a*8,scale[a],true);dv.setFloat64(155+a*8,offset[a],true);dv.setFloat64(179+a*16,mx[a],true);dv.setFloat64(187+a*16,mn[a],true);}
  if(typeof dv.setBigUint64==='function')dv.setBigUint64(247,BigInt(n),true);
  if(wktBytes.length){var v=header;dv.setUint16(v,0,true);out.set(new TextEncoder().encode('LASF_Projection'),v+2);dv.setUint16(v+18,2112,true);dv.setUint16(v+20,wktBytes.length,true);out.set(wktBytes,v+54);}
  var scale255=false;if(col){var cm=0;for(var i=0;i<Math.min(col.length,3000);i++)if(col[i]>cm)cm=col[i];scale255=cm>1.0001;}
  var intensityDiv=_intensityScale(intensity,n),o=pointOffset;
  for(var i=0;i<n;i++){
    for(var a=0;a<3;a++)dv.setInt32(o+a*4,Math.round((pos[i*3+a]-offset[a])/scale[a]),true);
    dv.setUint16(o+12,intensity?Math.round(Math.max(0,Math.min(1,Number(intensity[i])/intensityDiv))*65535):0,true);
    out[o+14]=0x11; // first/only return
    out[o+15]=0; // classification flags and scanner channel
    out[o+16]=classification?Math.max(0,Math.min(255,classification[i]|0)):0;
    out[o+17]=0;dv.setInt16(o+18,0,true);dv.setUint16(o+20,0,true);dv.setFloat64(o+22,0,true);
    for(var a=0;a<3;a++){var c=col?Math.round(scale255?col[i*3+a]:col[i*3+a]*255):200;dv.setUint16(o+30+a*2,Math.max(0,Math.min(255,c))*257,true);}
    o+=rec;
  }
  return out;
}

// ── E57 ───────────────────────────────────────────────────────────────────
// ASTM E57 binary interchange writer. The E57Core packet writer owns page CRCs,
// CompressedVector encoding, coordinate metadata and optional RGB/intensity.
function e57ScanRanges(scans,pointCount,step){
  if(!Array.isArray(scans)||scans.length<1)return null;
  pointCount=Math.floor(Number(pointCount));step=Math.max(1,Math.floor(Number(step)||1));
  if(!Number.isSafeInteger(pointCount)||pointCount<1)return null;
  var cursor=0,outCursor=0,out=[];
  for(var i=0;i<scans.length;i++){
    var source=scans[i]||{},start=source.start==null?cursor:Number(source.start),count=Number(source.count);
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(count)||count<0||start!==cursor||start+count>pointCount)return null;
    var first=start+((step-(start%step))%step),kept=first<start+count?Math.floor((start+count-1-first)/step)+1:0;
    if(kept)out.push({name:source.name||('Scan '+(i+1)),start:outCursor,count:kept,pose:source.pose||null});
    cursor+=count;outCursor+=kept;
  }
  return cursor===pointCount&&outCursor===Math.ceil(pointCount/step)?out:null;
}

function hasValidPtxScanRanges(meta,pointCount){
  if(!meta||!/^PTX(?:\s|$)/i.test(String(meta.format||''))||!Array.isArray(meta.scans)||!meta.scans.length)return false;
  var cursor=0;
  for(var i=0;i<meta.scans.length;i++){
    var scan=meta.scans[i]||{},start=Number(scan.start),count=Number(scan.count),m=scan.transform;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(count)||count<0||start!==cursor||start+count>pointCount)return false;
    if(count>0){
      if(!Array.isArray(m)||m.length<16||!m.slice(0,16).every(function(v){return isFinite(Number(v));})||
          (scan.matrixConvention!=='row-vector'&&scan.matrixConvention!=='column-vector')||
          !Array.isArray(scan.scannerPosition)||scan.scannerPosition.length<3||
          !scan.scannerPosition.slice(0,3).every(function(v){return isFinite(Number(v));})||
          !Array.isArray(scan.axes)||scan.axes.length<3||
          !scan.axes.slice(0,3).every(function(axis){return Array.isArray(axis)&&axis.length>=3&&axis.slice(0,3).every(function(v){return isFinite(Number(v));});}))return false;
      var a=scan.matrixConvention==='row-vector'
        ?[Number(m[0]),Number(m[4]),Number(m[8]),Number(m[1]),Number(m[5]),Number(m[9]),Number(m[2]),Number(m[6]),Number(m[10])]
        :[Number(m[0]),Number(m[1]),Number(m[2]),Number(m[4]),Number(m[5]),Number(m[6]),Number(m[8]),Number(m[9]),Number(m[10])];
      var det=a[0]*(a[4]*a[8]-a[5]*a[7])-a[1]*(a[3]*a[8]-a[5]*a[6])+a[2]*(a[3]*a[7]-a[4]*a[6]);
      if(!isFinite(det)||Math.abs(det)<1e-15)return false;
    }
    cursor+=count;
  }
  return cursor===pointCount;
}

function exportE57(pos,count,opts){
  opts=opts||{};
  var E=(typeof window!=='undefined'&&window.E57Core)||((typeof module!=='undefined'&&module.exports)?require('../e57-core'):null);
  if(!E||!E.write)throw new Error('E57Core недоступен');
  var step=Math.max(1,opts.step|0)||1;
  var scans=e57ScanRanges(opts.scans,count,step);
  if(step===1)return E.write({pos:pos,col:opts.col||null,intensity:opts.intensity||null,count:count,name:opts.name||'BIM Twin scan',crs:opts.crs||'',scans:scans||undefined});
  var n=Math.ceil(count/step),p=new Float64Array(n*3),c=opts.col?new Float32Array(n*3):null,it=opts.intensity?new Float32Array(n):null,o=0;
  for(var i=0;i<count;i+=step,o++){p[o*3]=pos[i*3];p[o*3+1]=pos[i*3+1];p[o*3+2]=pos[i*3+2];if(c){c[o*3]=opts.col[i*3];c[o*3+1]=opts.col[i*3+1];c[o*3+2]=opts.col[i*3+2];}if(it)it[o]=opts.intensity[i];}
  return E.write({pos:p,col:c,intensity:it,count:n,name:opts.name||'BIM Twin scan',crs:opts.crs||'',scans:scans||undefined});
}

function _e57guid(){
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){
    var r=Math.random()*16|0;return(c==='x'?r:r&0x3|0x8).toString(16);
  });
}

// Explicit Stage-3 interchange contract. "partial" is deliberately distinct
// from "supported": the importer/exporter must never imply parity it does not have.
var FORMAT_CAPABILITIES={
  las:{import:'supported',export:'supported',versions:'LAS 1.0–1.4; writer emits LAS 1.4 PDRF 7',preserves:['XYZ','RGB','intensity','classification','WKT VLR'],limits:['LAS extra dimensions, per-point GPS time/scan source and full multi-return metadata are not retained']},
  laz:{import:'supported-optional-decoder',export:'unsupported',versions:'LAZ 1.2/1.4 through @loaders.gl/las; async desktop import',limits:['compressed input is currently buffered and capped at 2 GiB; not out-of-core']},
  copc:{import:'unsupported',export:'unsupported',limits:['COPC hierarchy/range streaming is not implemented; a COPC LAZ file is not advertised as supported']},
  e57:{import:'supported',export:'supported',preserves:['XYZ','RGB','intensity','coordinateMetadata WKT','per-scan point grouping and rigid pose when scan ranges match the point buffer'],limits:['classification, timestamps and images are not exported; edits that invalidate scan ranges are exported as one merged scan']},
  ptx:{import:'supported',export:'supported',versions:'Leica PTX multi-scan text; valid imported scan ranges and rigid poses are preserved, each output scan is written as one row',preserves:['world XYZ','RGB','normalized intensity','per-scan rigid pose and grouping when valid PTX metadata matches the point buffer'],limits:['original scan grid dimensions and missing-return cells are not retained; invalid/stale scan metadata is flattened','PTX has no portable CRS/classification field; WKT and classification are not exported']},
  ply:{import:'supported',export:'supported',preserves:['XYZ','RGB','intensity','classification','BIM Twin up/units/CRS comments'],limits:['writer emits binary little-endian point-cloud PLY; PLY mesh import is separate and does not preserve arbitrary elements']},
  pcd:{import:'supported',export:'supported',versions:'ASCII, binary, binary_compressed (LZF)',preserves:['XYZ','RGB','intensity','classification','BIM Twin up/units/CRS comments'],limits:['ASCII/interleaved binary and binary_compressed (LZF) support disk-backed out-of-core octree indexing; compressed LOD decodes to a temporary planar disk store included in disk preflight','binary_compressed preview import now streams LZF to a per-import temporary planar disk store and samples into the configured point budget; it checks free space where supported and removes scratch on success, error, and worker cancellation','preview remains a sampled in-memory viewer buffer, not a full out-of-core viewer; organized grid dimensions and full sensor viewpoint are metadata only; arbitrary vector fields are not retained; LOD nodes store XYZ/RGB8 only']},
  pts:{import:'supported',export:'supported',preserves:['XYZ','RGB','intensity'],limits:['standard PTS has no portable CRS/up-axis/classification fields; these are not exported']},
  xyz:{import:'supported',export:'supported',preserves:['XYZ','RGB','intensity','classification','BIM Twin comment metadata'],limits:['text column order is a BIM Twin convention unless a named header is included']},
  csv:{import:'supported',export:'supported',preserves:['XYZ/RGB/intensity/classification columns','BIM Twin up-axis/units/CRS comments'],limits:['up-axis, units and CRS are stored in comment lines; generic spreadsheet/GIS readers may ignore these BIM Twin metadata comments']},
  dxf:{import:'partial',export:'partial',limits:['CAD entities/sections supported; not a point-cloud container; arbitrary CRS and CAD object semantics are not fully retained']},
  dwg:{import:'unsupported',export:'unsupported',limits:['native DWG import/export requires a tested licensed/packaged CAD engine; not enabled in this build']},
  ifc:{import:'partial',export:'partial',limits:['IFC workflow currently covers generated Scan-to-BIM output; full IFC entity/property/geometry round-trip is not implemented']},
  geotiff:{import:'partial',export:'supported',limits:['DSM GeoTIFF export is available; broad raster import, vertical datum/geoid and all GeoTIFF metadata are not implemented']},
  trajectory:{import:'unsupported',export:'unsupported',limits:['trajectory/time-synchronization package import/export is not implemented']},
  imagery:{import:'partial',export:'unsupported',limits:['images are not yet registered as a georeferenced, time-synchronized scan bundle']}
};
function getFormatCapabilities(format){
  var key=String(format||'').replace(/^\./,'').toLowerCase(),value=FORMAT_CAPABILITIES[key];
  if(!value)return{format:key,import:'unsupported',export:'unsupported',limits:['No tested format handler is registered']};
  var copy={format:key};Object.keys(value).forEach(function(k){var v=value[k];copy[k]=Array.isArray(v)?v.slice():v;});return copy;
}
function preflightExport(format,cloud){
  var formatKey=String(format||'').replace(/^\./,'').toLowerCase(),cap=getFormatCapabilities(formatKey),n=cloud&&cloud.pos?Math.floor(cloud.pos.length/3):0,errors=[],warnings=[];
  if(!n)errors.push('Нет точек для экспорта');
  if(cap.export!=='supported')errors.push('Экспорт формата '+String(format||'')+' не заявлен как поддерживаемый');
  if(cloud&&cloud.pos&&cloud.pos.length%3!==0)errors.push('Длина массива XYZ должна быть кратна трём');
  if(cloud&&cloud.pos&&cloud.count!=null&&(!Number.isSafeInteger(cloud.count)||cloud.count!==n))errors.push('Объявленное число точек не совпадает с длиной массива XYZ');
  if(cloud&&cloud.pos)for(var pi=0;pi<cloud.pos.length;pi++)if(!isFinite(Number(cloud.pos[pi]))){errors.push('XYZ содержит нечисловую координату в точке '+Math.floor(pi/3));break;}
  if(cloud&&cloud.col&&cloud.col.length<n*3)errors.push('Массив RGB короче массива XYZ; экспортировать частичный цвет нельзя');
  if(cloud&&cloud.intensity&&cloud.intensity.length<n)errors.push('Массив intensity короче массива XYZ; экспортировать частичную интенсивность нельзя');
  if(cloud&&cloud.classification&&cloud.classification.length<n)errors.push('Массив classification короче массива XYZ; экспортировать частичную классификацию нельзя');
  if(cloud&&cloud.intensity)for(var ii=0;ii<Math.min(cloud.intensity.length,n);ii++)if(!isFinite(Number(cloud.intensity[ii]))){errors.push('Intensity содержит нечисловое значение в точке '+ii);break;}
  if(cloud&&cloud.col)for(var ci=0;ci<Math.min(cloud.col.length,n*3);ci++)if(!isFinite(Number(cloud.col[ci]))){errors.push('RGB содержит нечисловое значение в точке '+Math.floor(ci/3));break;}
  (cloud&&cloud.meta&&cloud.meta.attributeWarnings||[]).forEach(function(w){if(w)warnings.push(String(w));});
  var meta=cloud&&cloud.meta||{},axis=meta.srcXform&&meta.srcXform.axis;
  if((formatKey==='las'||formatKey==='pts')&&axis==='yup')warnings.push('Формат не кодирует соглашение Y-up; численные XYZ будут сохранены без переориентации');
  if((formatKey==='las'||formatKey==='pts')&&!meta.crsWkt&&n){
    var large=false;for(var i=0;i<Math.min(n,1000);i++)if(Math.max(Math.abs(cloud.pos[i*3]),Math.abs(cloud.pos[i*3+1]),Math.abs(cloud.pos[i*3+2]))>100000){large=true;break;}
    if(large)warnings.push('Большие координаты экспортируются без CRS WKT; назначьте систему координат в CAD/GIS');
  }
  if(formatKey==='e57'&&cloud&&cloud.classification&&cloud.classification.length)warnings.push('E57 export does not carry ASPRS classification; this field will be omitted');
  if(formatKey==='pts'&&cloud&&cloud.classification&&cloud.classification.length)warnings.push('Standard PTS does not carry classification; this field will be omitted');
  if(formatKey==='pts'&&meta.crsWkt)warnings.push('Standard PTS has no portable CRS field; WKT will be omitted');
  if(formatKey==='e57'&&meta.scans&&meta.scans.length>0&&!e57ScanRanges(meta.scans,n,1))warnings.push('E57 scan metadata no longer matches the current point buffer; export will merge the points into one scan');
  if(formatKey==='csv'&&meta.scans&&meta.scans.length>0)warnings.push('CSV export flattens '+meta.scans.length+' source scan(s); original scan poses and grid organization are not retained');
  if(formatKey==='ptx'&&meta.scans&&meta.scans.length>0){
    if(hasValidPtxScanRanges(meta,n))warnings.push('PTX export preserves per-scan rigid poses but writes each scan as one row; original grid dimensions and missing-return cells are not retained');
    else warnings.push('PTX export scan ranges/poses do not match the current PTX point buffer; points will be flattened into one identity-pose scan');
  }
  if(formatKey==='las'&&meta.crsWkt&&new TextEncoder().encode(String(meta.crsWkt)+'\0').length>65535)warnings.push('LAS WKT превышает лимит одного VLR и будет опущен');
  (cap.limits||[]).forEach(function(l){if(/not retained|not exported|not retained|not fully/.test(l))warnings.push(l);});
  return{ok:errors.length===0,format:formatKey,pointCount:n,errors:errors,warnings:Array.from(new Set(warnings)),capabilities:cap};
}

// ── GeoTIFF wrapper ────────────────────────────────────────────────────────────
function exportGeoTIFF(dsm){
  // Use terrain.js dsmToTiff if available
  var T=(typeof window!=='undefined')?(window.Terrain||null):null;
  if(!T){try{T=require('./terrain');}catch(e){}}
  if(T&&typeof T.dsmToTiff==='function') return T.dsmToTiff(dsm);
  throw new Error('Terrain module not available for GeoTIFF export');
}

// ── download helper ────────────────────────────────────────────────────────────
function downloadBlob(blob,name){
  if(typeof document==='undefined') return;
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');a.href=url;a.download=name;
  document.body.appendChild(a);a.click();
  setTimeout(function(){URL.revokeObjectURL(url);document.body.removeChild(a);},500);
}
function downloadPDF(opts,name){
  var pdf=makePDF(opts);
  downloadBlob(new Blob([pdf],{type:'application/pdf'}),name||'report.pdf');
}
function downloadSHP(shapes,opts,baseName){
  var shp=exportSHP(shapes,opts);
  baseName=baseName||'export';
  downloadBlob(new Blob([shp.shp]),baseName+'.shp');
  downloadBlob(new Blob([shp.shx]),baseName+'.shx');
  downloadBlob(new Blob([shp.dbf,{type:'text/plain'}]),baseName+'.dbf');
}
function downloadE57(pos,count,opts,name){
  var e57=exportE57(pos,count,opts);
  downloadBlob(new Blob([e57],{type:'application/octet-stream'}),name||'scan.e57');
}

var API={makePDF:makePDF,exportSHP:exportSHP,exportE57:exportE57,exportLAS:exportLAS,exportPLY:exportPLY,exportPLYAsync:exportPLYAsync,exportGeoTIFF:exportGeoTIFF,
  FORMAT_CAPABILITIES:FORMAT_CAPABILITIES,getFormatCapabilities:getFormatCapabilities,preflightExport:preflightExport,
  downloadPDF:downloadPDF,downloadSHP:downloadSHP,downloadE57:downloadE57};
if(typeof window!=='undefined') window.ExportHub=API;
if(typeof module!=='undefined'&&module.exports) module.exports=API;
})();
