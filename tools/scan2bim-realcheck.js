'use strict';
// Проверка scan-to-BIM на РЕАЛЬНОМ облаке: печатает модель, отклонения и сохраняет IFC.
//   node tools/scan2bim-realcheck.js file.las [out.ifc] [--max-points=1500000]
const fs = require('node:fs');
const path = require('node:path');
const S = require('../renderer/scan2bim.js');
const L = require('../las-node.js');

const file = process.argv[2];
if (!file) { console.error('укажите .las/.laz'); process.exit(2); }
const outIfc = (process.argv[3] && !process.argv[3].startsWith('--')) ? process.argv[3] : null;
const maxArg = (process.argv.find(a => a.startsWith('--max-points=')) || '').split('=')[1];
const maxPts = Number(maxArg) || 1500000;

const t0 = Date.now();
const cloud = L.parseCloudFile(file);
const pos = cloud.pos, col = cloud.col, n = cloud.count || pos.length / 3;
const step = Math.max(1, Math.floor(n / maxPts));
const pts = [];
for (let i = 0; i < n; i += step) {
  const k = i * 3;
  if (col && col.length >= k + 3) pts.push([pos[k], pos[k + 1], pos[k + 2], col[k], col[k + 1], col[k + 2]]);
  else pts.push([pos[k], pos[k + 1], pos[k + 2]]);
}
console.log(`файл: ${path.basename(file)}`);
console.log(`точек: ${n}, в работе: ${pts.length}, чтение ${((Date.now() - t0) / 1000).toFixed(1)} с`);

const t1 = Date.now();
const levels = S.detectStoreys(pts);
const model = S.reconstruct(pts, { voxel: 0.05 });
console.log(`реконструкция ${((Date.now() - t1) / 1000).toFixed(1)} с, ok = ${model.ok}`);
if (!model.ok) process.exit(1);

const st = model.storeys || [];
console.log(`этажей: ${st.length || 1}` + (st.length ? ' · ' + st.map(s => `пол ${s.floorY.toFixed(2)} высота ${s.height.toFixed(2)}`).join(' · ') : ''));
console.log(`уровней найдено (detectStoreys): ${levels.length}`);
console.log(`стен: ${model.stats.wallCount}, проёмов: ${model.stats.openingCount}, помещений: ${model.stats.roomCount || 0}, труб: ${model.stats.pipeCount}, балок: ${model.stats.beamCount}, объектов: ${model.stats.objectCount}`);

// отклонение точек от плоскостей стен — прямая мера качества «1:1»
let rmsAll = 0, thickSum = 0, wallsWithRms = 0;
for (const w of model.walls) {
  if (typeof w.rms === 'number') { rmsAll += w.rms; wallsWithRms++; }
  thickSum += w.thickness || 0;
}
console.log(`средний RMS плоскостей стен: ${(wallsWithRms ? (rmsAll / wallsWithRms) * 1000 : 0).toFixed(1)} мм (по ${wallsWithRms} стенам)`);
console.log(`средняя толщина стены: ${(wallsWithRms ? thickSum / wallsWithRms : 0).toFixed(3)} м`);

const byKind = {};
for (const w of model.walls) for (const o of (w.openings || [])) byKind[o.kind || 'opening'] = (byKind[o.kind || 'opening'] || 0) + 1;
if (Object.keys(byKind).length) console.log('проёмы по типам: ' + Object.entries(byKind).map(([k, v]) => `${k} — ${v}`).join(', '));

// проверки качества
const checks = [
  ['плоскости стен RMS ≤ 20 мм', (wallsWithRms ? (rmsAll / wallsWithRms) * 1000 : 1e9) <= 20],
  ['толщина стен в разумных пределах 3–60 см', model.walls.every(w => (w.thickness || 0) >= 0.03 && (w.thickness || 0) <= 0.6)],
  ['все проёмы внутри стен', model.walls.every(w => (w.openings || []).every(o => o.along >= 0 && o.along + o.width <= w.length + 1e-6))]
];
for (const [name, ok] of checks) console.log(`${ok ? 'OK  ' : 'НЕТ '} ${name}`);

if (outIfc) {
  const ifc = S.toIFC(model, { name: path.basename(outIfc) });
  fs.writeFileSync(outIfc, ifc);
  const counts = {};
  for (const m of ifc.matchAll(/=([A-Z0-9]+)\(/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
  console.log(`IFC: ${outIfc} (${(fs.statSync(outIfc).size / 1024).toFixed(0)} КБ)`);
  console.log('  ' + ['IFCBUILDINGSTOREY', 'IFCWALLSTANDARDCASE', 'IFCOPENINGELEMENT', 'IFCWINDOW', 'IFCDOOR', 'IFCSLAB', 'IFCSPACE', 'IFCBEAM', 'IFCCOLUMN']
    .filter(k => counts[k]).map(k => `${k.slice(3)} ${counts[k]}`).join(', '));
}
process.exit(checks.every(c => c[1]) ? 0 : 1);
