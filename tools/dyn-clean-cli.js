// node tools/dyn-clean-cli.js map.las poses.csv out.mask [json-opts]
const D = require('../dynamic-clean-core');
const fs = require('node:fs');
const [las, poses, out, o] = process.argv.slice(2);
let lastP = -1;
const r = D.run(las, fs.readFileSync(poses, 'utf8'), o ? JSON.parse(o) : {}, (f, l) => { const p = Math.floor(f * 20); if (p !== lastP) { lastP = p; process.stderr.write(`${l} ${Math.round(f * 100)}%\n`); } });
fs.writeFileSync(out, r.mask);
console.log(JSON.stringify(r.stats));
