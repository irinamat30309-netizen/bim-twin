// node tools/las-speckle-clean.js in.las out.las [json-opts|@file]
// r174: удаление спекл-шума (одиноких точек) из готового облака: radius outlier removal по воксельной сетке.
// opt: { cell: 0.1, minNeighbors: 4 } — радиус влияния ~cell, минимум соседей в 3×3×3 вокселях.
const fs = require('node:fs');
const path = require('node:path');
const S = require('../speckle-clean');

const [src, dst, o] = process.argv.slice(2);
if (!src || !dst) { console.error('нужно: las-speckle-clean.js in.las out.las [json|@file]'); process.exit(2); }
const opt = !o ? {} : (o[0] === '@' ? JSON.parse(fs.readFileSync(o.slice(1), 'utf8')) : JSON.parse(o));
let last = -1;
const log = (f, l) => { const p = Math.floor(f * 20); if (p !== last) { last = p; process.stderr.write(`${l} ${Math.round(f * 100)}%\n`); } };
const t = Date.now();
const st = S.cleanLas(src, dst, opt, log);
st.wallMs = Date.now() - t;
console.log(JSON.stringify(st));
