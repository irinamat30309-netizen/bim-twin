// node tools/refine-cli.js in.las out.las [poses.csv|-] [json-opts] — чистовая обработка скана в новый LAS
const fs = require('node:fs');
const R = require('../scan-refine-core');
const D = require('../dynamic-clean-core');
const [src, dst, poses, o] = process.argv.slice(2);
const opt = o ? JSON.parse(o) : {};
let lastP = -1;
const log = (f, l) => { const p = Math.floor(f * 20); if (p !== lastP) { lastP = p; process.stderr.write(`${l} ${Math.round(f * 100)}%\n`); } };
if (poses && poses !== '-') {
  const t = Date.now(), v = D.run(src, fs.readFileSync(poses, 'utf8'), Object.assign({}, opt.dyn || {}, { voxelsOnly: true }), log);
  process.stderr.write(`dynamic voxels ${v.keys.length} за ${Date.now() - t} мс\n`); lastP = -1;
  opt.dynamic = { keys: v.keys, grid: v.grid };
}
delete opt.dyn;
{ const CB = require('../color-balance-core');   // ревизия 48 — как в приложении; r49: photoColor: true — облако после «Цвета по фото»
  opt.colorBalanceOpt = Object.assign({ saturation: opt.photoColor ? CB.LIXEL_SATURATION_PHOTO : CB.LIXEL_SATURATION }, opt.colorBalanceOpt || {}); }
// ревизия 50: плитки как в приложении (scan-refine-parallel; со сглаживанием зерна цвета — color-grain-core); opt.single: true — прежний R.refine
if (opt.single) console.log(JSON.stringify(R.refine(src, dst, opt, log)));
else require('../scan-refine-parallel').refineParallel(src, dst, opt, log).then((st) => { console.log(JSON.stringify(st)); process.exit(0); }, (e) => { console.error(e && e.stack || e); process.exit(1); });
