// node tools/las-fusion.js in.las out.las [json-opts|@file] — scan-matching проходов + fusion без прореживания (r149).
// Определяет проходы по времени, оценивает сдвиг каждого прохода по глобальным плоскостям (стены/пол/потолок),
// переносит точки — стены/пол становятся тоньше. Плотность сохраняется (все точки на месте).
const fs = require('node:fs');
const F = require('../xbin-fusion');
const [src, dst, o] = process.argv.slice(2);
if (!src || !dst) { console.error('нужно: las-fusion.js in.las out.las [json|@file]'); process.exit(2); }
const opt = !o ? {} : (o[0] === '@' ? JSON.parse(fs.readFileSync(o.slice(1), 'utf8')) : JSON.parse(o));
let last = -1;
const log = (f, l) => { const p = Math.floor(f * 20); if (p !== last) { last = p; process.stderr.write(`${l} ${Math.round(f * 100)}%\n`); } };
const t = Date.now();
const st = F.fuseLas(src, dst, opt, log);
st.wallMs = Date.now() - t;
st.maxRssMB = Math.round(process.memoryUsage().rss / 1048576);
console.log(JSON.stringify(st));
