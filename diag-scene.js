const SV = require('./renderer/splatviewer.js');
const fs = require('fs');
const path = '/data/splatzip/extracted/scene.ply';
const b = fs.readFileSync(path);
const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const t0 = Date.now();
const r = SV._parsePly(ab);
const bounds = SV._computeBounds(r.buffer, r.count);
console.log('kind:', r.kind, '| kept:', r.count.toLocaleString(), '| total:', r.totalVertices.toLocaleString(), '| stride:', r.stride, '| parse', (Date.now()-t0)+'ms');
console.log('center:', bounds.center.map(n=>+n.toFixed(2)), 'radius:', +bounds.radius.toFixed(2));

// Each splat = 32 bytes: floats[0..2]=pos, [3..5]=scale, u8[24..27]=RGBA (for gaussian: color stored where?)
// Layout check: read as both float and byte views
const N = r.count;
const fArr = new Float32Array(r.buffer.buffer, r.buffer.byteOffset, N * 8);
const u8 = new Uint8Array(r.buffer.buffer, r.buffer.byteOffset, N * 32);

let minC=[255,255,255], maxC=[0,0,0], sumC=[0,0,0], sumA=0, minA=255, maxA=0;
let sumScale=0, minScale=1e9, maxScale=0;
const step = Math.max(1, Math.floor(N/50000));
let cnt=0;
for (let i=0;i<N;i+=step){
  const bo = i*32;
  const rr=u8[bo+24], gg=u8[bo+25], bb=u8[bo+26], aa=u8[bo+27];
  for(let k=0;k<3;k++){const v=[rr,gg,bb][k]; if(v<minC[k])minC[k]=v; if(v>maxC[k])maxC[k]=v; sumC[k]+=v;}
  sumA+=aa; if(aa<minA)minA=aa; if(aa>maxA)maxA=aa;
  const sc=fArr[i*8+3]; sumScale+=sc; if(sc<minScale)minScale=sc; if(sc>maxScale)maxScale=sc;
  cnt++;
}
console.log('samples:', cnt);
console.log('color R/G/B  min:', minC, 'max:', maxC, 'avg:', sumC.map(s=>+(s/cnt).toFixed(1)));
console.log('alpha  min:', minA, 'max:', maxA, 'avg:', +(sumA/cnt).toFixed(1));
console.log('scale0 min:', +minScale.toFixed(4), 'max:', +maxScale.toFixed(4), 'avg:', +(sumScale/cnt).toFixed(4));
console.log('first 3 splats:');
for(let i=0;i<3;i++){const bo=i*32; console.log('  pos', [fArr[i*8],fArr[i*8+1],fArr[i*8+2]].map(n=>+n.toFixed(2)), 'scale', [fArr[i*8+3],fArr[i*8+4],fArr[i*8+5]].map(n=>+n.toFixed(3)), 'RGBA', [u8[bo+24],u8[bo+25],u8[bo+26],u8[bo+27]]);}
