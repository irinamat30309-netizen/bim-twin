const SV = require('./renderer/splatviewer.js');
const fs = require('fs');
const b = fs.readFileSync('/data/splatzip/extracted/scene.ply');
const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const r = SV._parsePly(ab);
let buf=r.buffer, count=r.count;
let rb = SV._robustBounds(buf, count);
console.log('robustBounds center:', rb.center.map(n=>+n.toFixed(2)), 'radius:', +rb.radius.toFixed(2));
const pr = SV._pruneOutliers(buf, count, rb, 2.5);
console.log('pruneOutliers -> count:', pr.count.toLocaleString(), 'of', count.toLocaleString(), '(removed', (count-pr.count).toLocaleString()+')');
if (pr.count>0 && pr.count<count){ buf=pr.buffer; count=pr.count; rb=SV._robustBounds(buf,count); }
console.log('final bounds center:', rb.center.map(n=>+n.toFixed(2)), 'radius:', +rb.radius.toFixed(2));
const naive = SV._computeBounds(buf, count);
console.log('naive bounds AFTER prune center:', naive.center.map(n=>+n.toFixed(2)), 'radius:', +naive.radius.toFixed(2));
console.log('camera eye would be:', [rb.center[0],rb.center[1],rb.center[2]-rb.radius*1.8].map(n=>+n.toFixed(2)));
