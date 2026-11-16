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
// Ревизия 146: для плотных сборок (>50 млн точек) ограничиваем сдвиг тонких поверхностей 1 см — на плотном облаке
// thinSurfaces с 2 см «размазывает» стену (MAD +30 %). Явный opt.maxThinShift главнее; старые сборки 36–53 млн не меняются.
let cleanProfile = null;
try {
  const fd = fs.openSync(src, 'r'); const H = R.readHeader(fd); fs.closeSync(fd);
  cleanProfile = R.cleanProfile(H.n);
  if (opt.thin === undefined) opt.thin = cleanProfile.thin;   // r146: на плотных облаках thin выключается (замер: MAD 79.5 vs 82.6)
  if (opt.maxThinShift === undefined && opt.thin !== false) opt.maxThinShift = cleanProfile.maxThinShift;
} catch (_) { /* не LAS — профиль не нужен */ }
const densify = async (st) => {
  if (!xbin) return st;
  if (!poses || poses === '-') throw new Error('для уплотнения по .xbin нужна траектория poses.csv');
  const tmp = dst + '.dense.las'; lastP = -1;
  st.densify = await require('../cloud-densify-core').densifyLas(dst, tmp, { xbinPath: xbin, posesText: fs.readFileSync(poses, 'utf8') }, opt.densifyOpt || {}, log);
  fs.renameSync(tmp, dst); return st;
};
// Ревизия 145: длительность скана по poses.csv (с) — для авто-включения повторного удаления движущихся.
const posesDuration = (text) => {
  let t0 = null, t1 = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line || line[0] === '#') continue;
    const t = Number(line.split(',')[0]);
    if (!Number.isFinite(t)) continue;
    if (t0 === null) t0 = t;
    t1 = t;
  }
  return t0 === null || t1 === null ? 0 : t1 - t0;
};
// Ревизия 132/145: повторное удаление движущихся объектов ПОСЛЕ шумоподавления:
// dynamicRepass=true — всегда, false — никогда, не задан — автоматически для длинных сканов (>600 с):
// первый проход детектора видит облако с шумом, после чистки занятость вокселей меняется — остаток ~0.003 %.
const repass = async (st) => {
  if (opt.dynamicRepass === false) return st;
  let auto = false;
  if (opt.dynamicRepass !== true) {
    if (!poses || poses === '-') return st;
    let dur = 0; try { dur = posesDuration(fs.readFileSync(poses, 'utf8')); } catch (_) {}
    auto = dur > 600;
    if (!auto) return st;
    process.stderr.write(`dynamicRepass: авто для длинного скана (${Math.round(dur)} с)\n`);
  }
  if (!poses || poses === '-') throw new Error('для dynamicRepass нужна траектория poses.csv');
  const t0 = Date.now();
  const det = D.detect(dst, fs.readFileSync(poses, 'utf8'), Object.assign({}, opt.dynRepassOpt || {}, { voxelsOnly: true }), log);
  const tmp2 = dst + '.nodyn.las';
  const r = R.filterVoxels(dst, tmp2, det, log);
  fs.renameSync(tmp2, dst);
  st.dynamicRepass = { dynVoxels: r.dynVoxels, sets: r.sets, removed: r.removed, points: r.points, ms: Date.now() - t0, auto };  st.cleanProfile = cleanProfile;
  return st;
};
if (opt.single) densify(R.refine(src, dst, opt, log)).then(repass).then((st) => { console.log(JSON.stringify(st)); process.exit(0); }, (e) => { console.error(e && e.stack || e); process.exit(1); });
else require('../scan-refine-parallel').refineParallel(src, dst, opt, log).then(densify).then(repass).then((st) => { console.log(JSON.stringify(st)); process.exit(0); }, (e) => { console.error(e && e.stack || e); process.exit(1); });
