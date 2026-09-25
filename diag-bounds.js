const SV = require('./renderer/splatviewer.js');
const fs = require('fs');
const b = fs.readFileSync('/data/splatzip/extracted/scene.ply');
const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const r = SV._parsePly(ab);
const N = r.count;
const f = new Float32Array(r.buffer.buffer, r.buffer.byteOffset, N * 8);

// gather positions
const xs=new Float64Array(N), ys=new Float64Array(N), zs=new Float64Array(N);
for(let i=0;i<N;i++){xs[i]=f[i*8];ys[i]=f[i*8+1];zs[i]=f[i*8+2];}
function pct(arr,p){const a=Float64Array.from(arr).sort();return a[Math.floor((a.length-1)*p)];}
function stats(a){return {p01:pct(a,0.01),p05:pct(a,0.05),p50:pct(a,0.5),p95:pct(a,0.95),p99:pct(a,0.99),min:pct(a,0),max:pct(a,1)};}
const sx=stats(xs),sy=stats(ys),sz=stats(zs);
console.log('X', JSON.stringify(sx));
console.log('Y', JSON.stringify(sy));
console.log('Z', JSON.stringify(sz));
// robust center = median, robust radius = 95th pct distance from median
const cx=sx.p50,cy=sy.p50,cz=sz.p50;
const d=new Float64Array(N);
for(let i=0;i<N;i++){const dx=xs[i]-cx,dy=ys[i]-cy,dz=zs[i]-cz;d[i]=Math.sqrt(dx*dx+dy*dy+dz*dz);}
const ds=Float64Array.from(d).sort();
const rob=(p)=>ds[Math.floor((N-1)*p)];
console.log('median center:',[cx,cy,cz].map(n=>+n.toFixed(1)));
console.log('dist-from-median  p50:',+rob(.5).toFixed(1),'p90:',+rob(.9).toFixed(1),'p95:',+rob(.95).toFixed(1),'p99:',+rob(.99).toFixed(1),'p999:',+rob(.999).toFixed(1),'MAX:',+rob(1).toFixed(1));
const core=rob(.95);
let outliers=0; for(let i=0;i<N;i++) if(d[i]>core*3) outliers++;
console.log('splats beyond 3x p95 (floaters):', outliers, '('+(100*outliers/N).toFixed(2)+'%)');
console.log('=> raw radius', 28895.69, 'vs robust p95', +core.toFixed(1), '=> ratio', +(28895.69/core).toFixed(1)+'x inflation');
