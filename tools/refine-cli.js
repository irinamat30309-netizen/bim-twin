// node tools/refine-cli.js in.las out.las [poses.csv|-] [json-opts] — чистовая обработка скана в новый LAS
const fs = require('node:fs');
const R = require('../scan-refine-core');
const D = require('../dynamic-clean-core');
const [src, dst, poses, o] = process.argv.slice(2);
// Опции: JSON-строкой или файлом (@путь.json) — из PowerShell кавычки в аргументах теряются
const opt = !o ? {} : (o[0] === '@' ? JSON.parse(fs.readFileSync(o.slice(1), 'utf8')) : JSON.parse(o));
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
// ревизия 51: "xbin": "путь.xbin" — после обработки уплотнение по сырому лидару (cloud-densify-core; нужна траектория poses.csv)
const xbin = opt.xbin; delete opt.xbin;
const densify = async (st) => {
  if (!xbin) return st;
  if (!poses || poses === '-') throw new Error('для уплотнения по .xbin нужна траектория poses.csv');
  const tmp = dst + '.dense.las'; lastP = -1;
  st.densify = await require('../cloud-densify-core').densifyLas(dst, tmp, { xbinPath: xbin, posesText: fs.readFileSync(poses, 'utf8') }, opt.densifyOpt || {}, log);
  fs.renameSync(tmp, dst); return st;
};
// Ревизия 132: повторное удаление движущихся объектов ПОСЛЕ шумоподавления (флаг dynamicRepass, по умолчанию выкл.):
// первый проход детектора видит облако с шумом, после чистки занятость вокселей меняется — остаток ~0.003 %.
// Второй проход: detect по очищенному LAS + удаление точек в найденных вокселях (filterVoxels), ~+10 с на 36 млн.
const repass = async (st) => {
  if (!opt.dynamicRepass) return st;
  if (!poses || poses === '-') throw new Error('для dynamicRepass нужна траектория poses.csv');
  const t0 = Date.now();
  const det = D.detect(dst, fs.readFileSync(poses, 'utf8'), Object.assign({}, opt.dynRepassOpt || {}, { voxelsOnly: true }), log);
  const tmp2 = dst + '.nodyn.las';
  const r = R.filterVoxels(dst, tmp2, det, log);
  fs.renameSync(tmp2, dst);
  st.dynamicRepass = { dynVoxels: r.dynVoxels, sets: r.sets, removed: r.removed, points: r.points, ms: Date.now() - t0 };
  return st;
};
if (opt.single) densify(R.refine(src, dst, opt, log)).then(repass).then((st) => { console.log(JSON.stringify(st)); process.exit(0); }, (e) => { console.error(e && e.stack || e); process.exit(1); });
else require('../scan-refine-parallel').refineParallel(src, dst, opt, log).then(densify).then(repass).then((st) => { console.log(JSON.stringify(st)); process.exit(0); }, (e) => { console.error(e && e.stack || e); process.exit(1); });
