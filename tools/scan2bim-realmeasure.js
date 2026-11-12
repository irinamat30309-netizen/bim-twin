'use strict';
// Замеры по РЕАЛЬНОМУ облаку: фасад/плоскость, окна, этажи; затем сверка с BIM-моделью.
//   node tools/scan2bim-realmeasure.js file.las [--json=out.json]
const fs = require('node:fs');
const path = require('node:path');
const L = require('../las-node.js');
const S = require('../renderer/scan2bim.js');

const file = process.argv[2];
if (!file) { console.error('укажите .las'); process.exit(2); }
const jsonOut = (process.argv.find(a => a.startsWith('--json=')) || '').split('=')[1];

const t0 = Date.now();
const cloud = L.parseCloudFile(file);
const pos = cloud.pos, col = cloud.col, n = cloud.count || pos.length / 3;
const step = Math.max(1, Math.floor(n / 2000000));
const pts = [];
for (let i = 0; i < n; i += step) {
  const k = i * 3;
  pts.push([pos[k], pos[k + 1], pos[k + 2]]);
}
console.log(`файл ${path.basename(file)}: ${n} точек, в работе ${pts.length}, ${((Date.now() - t0) / 1000).toFixed(1)} с`);

// --- 1. Главная вертикальная плоскость фасада (по XZ) ---
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (const p of pts) {
  if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
  if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  if (p[2] < minZ) minZ = p[2]; if (p[2] > maxZ) maxZ = p[2];
}
console.log(`габариты: X ${(maxX - minX).toFixed(2)} м, высота Y ${(maxY - minY).toFixed(2)} м, глубина Z ${(maxZ - minZ).toFixed(2)} м`);

// среднее направление стены: главная компонента в плане (X,Z)
let sx = 0, sz = 0, cnt = 0;
for (const p of pts) { sx += p[0]; sz += p[2]; cnt++; }
sx /= cnt; sz /= cnt;
let sxx = 0, sxz = 0, szz = 0;
for (const p of pts) { const dx = p[0] - sx, dz = p[2] - sz; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; }
const tr = sxx + szz, det = sxx * szz - sxz * sxz;
const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
let dir = Math.abs(sxz) > 1e-9 ? [l1 - szz, sxz] : [1, 0];
const dl = Math.hypot(dir[0], dir[1]); dir = [dir[0] / dl, dir[1] / dl];
const nrm = [-dir[1], dir[0]];
// положение плоскости — медиана смещения
let offs = [];
for (const p of pts) offs.push((p[0] - sx) * nrm[0] + (p[2] - sz) * nrm[1]);
offs.sort((a, b) => a - b);
const planeOff = offs[Math.floor(offs.length / 2)];
let rms = 0, near = 0;
const band = 0.5;
for (const p of pts) {
  const d = (p[0] - sx) * nrm[0] + (p[2] - sz) * nrm[1] - planeOff;
  if (Math.abs(d) <= band) { rms += d * d; near++; }
}
rms = Math.sqrt(rms / Math.max(1, near));
const angleDeg = Math.atan2(dir[1], dir[0]) * 180 / Math.PI;
console.log(`плоскость фасада: направление ${angleDeg.toFixed(2)}°, точек в полосе ${near}, RMS ${(rms * 1000).toFixed(1)} мм`);

// --- 2. Развёртка фасада: u вдоль стены, v по высоте; окна = пустоты в стене ---
const U = (p) => (p[0] - sx) * dir[0] + (p[2] - sz) * dir[1];
const V = (p) => p[1];
let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
const wallPts = [];
for (const p of pts) {
  const d = (p[0] - sx) * nrm[0] + (p[2] - sz) * nrm[1] - planeOff;
  if (Math.abs(d) > band) continue;
  const u = U(p), v = V(p);
  wallPts.push([u, v]);
  if (u < uMin) uMin = u; if (u > uMax) uMax = u;
  if (v < vMin) vMin = v; if (v > vMax) vMax = v;
}
const cell = 0.05;
const gw = Math.ceil((uMax - uMin) / cell) + 1, gh = Math.ceil((vMax - vMin) / cell) + 1;
const occ = new Uint8Array(gw * gh);
for (const [u, v] of wallPts) {
  const x = Math.floor((u - uMin) / cell), y = Math.floor((v - vMin) / cell);
  if (x >= 0 && y >= 0 && x < gw && y < gh) occ[y * gw + x] = 1;
}
// расширяем занятость на 1 клетку — тонкие линии облака не должны давать щели
const occ2 = new Uint8Array(gw * gh);
for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
  if (!occ[y * gw + x]) continue;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < gw && ny < gh) occ2[ny * gw + nx] = 1;
  }
}
// пустоты внутри контура: компоненты незанятых клеток, не касающиеся границ
const seen = new Uint8Array(gw * gh), holes = [];
const stack = new Int32Array(gw * gh);
for (let i = 0; i < gw * gh; i++) {
  if (occ2[i] || seen[i]) continue;
  let sp = 0; stack[sp++] = i; seen[i] = 1;
  const cells = []; let touch = false;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  while (sp) {
    const c = stack[--sp]; cells.push(c);
    const x = c % gw, y = (c / gw) | 0;
    if (x === 0 || y === 0 || x === gw - 1 || y === gh - 1) touch = true;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    const nb = [c - 1, c + 1, c - gw, c + gw];
    for (let k = 0; k < 4; k++) {
      const id = nb[k];
      if (id < 0 || id >= gw * gh || seen[id] || occ2[id]) continue;
      if (k === 0 && x === 0) continue; if (k === 1 && x === gw - 1) continue;
      seen[id] = 1; stack[sp++] = id;
    }
  }
  if (touch || cells.length < 20) continue;
  const w = (x1 - x0 + 1) * cell, h = (y1 - y0 + 1) * cell;
  if (w < 0.35 || h < 0.35 || w > 6 || h > 3.5) continue;
  holes.push({ u0: uMin + x0 * cell, u1: uMin + (x1 + 1) * cell, v0: vMin + y0 * cell, v1: vMin + (y1 + 1) * cell, w, h, area: w * h, fill: cells.length * cell * cell / (w * h) });
}
holes.sort((a, b) => a.v0 - b.v0 || a.u0 - b.u0);
// v1258: окна разбиты импостами на «фрамуги» — склеиваем соседние пустоты с узким простенком (<0.22 м)
const merged = [];
for (const h of holes) {
  let target = null;
  for (let k = merged.length - 1; k >= 0; k--) {
    const m = merged[k];
    if (Math.abs(m.v0 - h.v0) > 0.3 || Math.abs(m.v1 - h.v1) > 0.3) continue;
    if (h.u0 - m.u1 > 0.55 || m.u0 - h.u1 > 0.55) continue;
    target = m; break;
  }
  if (target) {
    target.u0 = Math.min(target.u0, h.u0); target.u1 = Math.max(target.u1, h.u1);
    target.w = target.u1 - target.u0; target.area = target.w * target.h;
  } else {
    merged.push({ ...h });
  }
}
holes.length = 0;
for (const m of merged) if (m.w >= 0.5 && m.w <= 3.6) holes.push(m);
holes.sort((a, b) => a.v0 - b.v0 || a.u0 - b.u0);
console.log(`окон после склейки импостов: ${holes.length}`);
const widths = holes.map(h => h.w).sort((a, b) => a - b);
const heights = holes.map(h => h.h).sort((a, b) => a - b);
const med = (a) => a.length ? a[Math.floor(a.length / 2)] : null;
console.log(`ширина окна: медиана ${med(widths)?.toFixed(2)} м (${widths[0]?.toFixed(2)}…${widths[widths.length - 1]?.toFixed(2)}), высота: медиана ${med(heights)?.toFixed(2)} м (${heights[0]?.toFixed(2)}…${heights[heights.length - 1]?.toFixed(2)})`);
// этажи: группируем окна по v0
const rows = [];
for (const h of holes) {
  let row = rows.find(r => Math.abs(r.v0 - h.v0) < 0.6);
  if (!row) { row = { v0: h.v0, items: [] }; rows.push(row); }
  row.items.push(h);
}
rows.sort((a, b) => a.v0 - b.v0);
console.log(`рядов окон: ${rows.length}`);
rows.forEach((r, i) => {
  const cs = r.items.map(h => (h.u0 + h.u1) / 2).sort((a, b) => a - b);
  const pitches = [];
  for (let k = 1; k < cs.length; k++) pitches.push(+(cs[k] - cs[k - 1]).toFixed(3));
  console.log(`  ряд ${i + 1}: низ ${r.v0.toFixed(2)} м, окон ${r.items.length}, шаг ${pitches.length ? (pitches.reduce((a, b) => a + b, 0) / pitches.length).toFixed(2) : '—'} м`);
});
// шаг этажей: по рядам и по пикам занятости
const floorPitch = [];
for (let k = 1; k < rows.length; k++) floorPitch.push(+(rows[k].v0 - rows[k - 1].v0).toFixed(2));
console.log(`шаг между рядами: ${floorPitch.join(', ')} м`);

// --- 3. BIM-модель по этому же облаку: этажи задаём по измеренным рядам окон -----------------
// подоконник ≈ 0.9 м над полом → пол = низ ряда − 0.9 м; берём только ряды с шагом 3.4–4.0 м
// (нижние «витринные» ряды могут быть другой высоты и не образуют этаж)
const floorGuess = rows.map(r => +(r.v0 - 0.9).toFixed(2)).sort((a, b) => a - b);
const levels = [];
let runStart = -1;
for (let k = 0; k + 1 < floorGuess.length; k++) {
  const h = floorGuess[k + 1] - floorGuess[k];
  if (h >= 3.4 && h <= 4.0) { if (runStart < 0) runStart = k; }
  else { if (runStart >= 0 && k - runStart >= 1) { for (let q = runStart; q < k; q++) levels.push({ floorY: floorGuess[q], ceilY: floorGuess[q + 1] }); } runStart = -1; }
}
if (runStart >= 0 && floorGuess.length - runStart >= 2) {
  for (let q = runStart; q + 1 < floorGuess.length; q++) {
    const h = floorGuess[q + 1] - floorGuess[q];
    if (h >= 3.4 && h <= 4.0) levels.push({ floorY: floorGuess[q], ceilY: floorGuess[q + 1] });
  }
}
if (levels.length) {
  // крайние этажи: снизу от самого нижнего ряда окон до первого найденного этажа, сверху — до верха фасада
  const firstFloor = levels[0].floorY, lastCeil = levels[levels.length - 1].ceilY;
  const lowestRow = rows.length ? Math.min(...rows.map(r => r.v0)) : null;
  if (lowestRow != null && firstFloor - (lowestRow - 0.9) > 1.8) levels.unshift({ floorY: +(lowestRow - 0.9).toFixed(2), ceilY: firstFloor });
  if (vMax - lastCeil > 1.8) levels.push({ floorY: lastCeil, ceilY: +(vMax).toFixed(2) });
}
if (levels.length) console.log(`этажи по окнам: ${levels.map(l => `${l.floorY.toFixed(2)}–${l.ceilY.toFixed(2)}`).join(', ')}`);
const t1 = Date.now();
const model = S.reconstruct(pts, Object.assign({ voxel: 0.05 }, levels.length ? { levels } : {}));
console.log(`BIM: ${((Date.now() - t1) / 1000).toFixed(1)} с, стен ${model.stats.wallCount}, проёмов ${model.stats.openingCount}, этажей ${model.storeys ? model.storeys.length : 1}, помещений ${model.stats.roomCount}`);
const modelOpenings = [];
for (const w of model.walls) {
  const wl = Math.hypot(w.dir[0], w.dir[1]) || 1;
  const wd = [w.dir[0] / wl, w.dir[1] / wl];
  for (const o of (w.openings || [])) {
    const cu = (w.a[0] + wd[0] * (o.along + o.width / 2));
    const cz = (w.a[1] + wd[1] * (o.along + o.width / 2));
    // в развёртку фасада: u вдоль стены, v — абсолютная высота
    const u = (cu - sx) * dir[0] + (cz - sz) * dir[1];
    modelOpenings.push({ u, v0: (w.base || 0) + (o.sill || 0), v1: (w.base || 0) + (o.head || 0), width: o.width, kind: o.kind });
  }
}
// --- 4. Сверка «1:1» по маскам: площадь окон по облаку и по модели ---
const M = new Uint8Array(gw * gh), O = new Uint8Array(gw * gh);
for (const h of holes) {
  const x0 = Math.floor((h.u0 - uMin) / cell), x1 = Math.ceil((h.u1 - uMin) / cell);
  const y0 = Math.floor((h.v0 - vMin) / cell), y1 = Math.ceil((h.v1 - vMin) / cell);
  for (let y = Math.max(0, y0); y < Math.min(gh, y1); y++) for (let x = Math.max(0, x0); x < Math.min(gw, x1); x++) M[y * gw + x] = 1;
}
for (const mo of modelOpenings) {
  const u0 = mo.u - mo.width / 2, u1 = mo.u + mo.width / 2;
  const x0 = Math.floor((u0 - uMin) / cell), x1 = Math.ceil((u1 - uMin) / cell);
  const y0 = Math.floor((mo.v0 - vMin) / cell), y1 = Math.ceil((mo.v1 - vMin) / cell);
  for (let y = Math.max(0, y0); y < Math.min(gh, y1); y++) for (let x = Math.max(0, x0); x < Math.min(gw, x1); x++) O[y * gw + x] = 1;
}
let mM = 0, mO = 0, inter = 0;
for (let i = 0; i < gw * gh; i++) { if (M[i]) mM++; if (O[i]) mO++; if (M[i] && O[i]) inter++; }
const recall = mM ? inter / mM : 0, precision = mO ? inter / mO : 0;
const iou = (mM + mO - inter) ? inter / (mM + mO - inter) : 0;
const areaM = mM * cell * cell, areaO = mO * cell * cell;
console.log(`окна по облаку: ${areaM.toFixed(1)} м² (${holes.length} шт), по модели: ${areaO.toFixed(1)} м² (${modelOpenings.length} шт)`);
console.log(`сверка 1:1 — покрытие облака моделью ${(100 * recall).toFixed(0)} %, точность модели ${(100 * precision).toFixed(0)} %, IoU ${(100 * iou).toFixed(0)} %`);
// по рядам: сколько окон облака имеет проём модели в том же месте
const byRow = [];
for (const r of rows) {
  let ok = 0;
  for (const h of r.items) {
    const cu = (h.u0 + h.u1) / 2;
    for (const mo of modelOpenings) if (Math.abs(mo.u - cu) <= Math.max(0.8, h.w / 2) && Math.abs((mo.v0 + mo.v1) / 2 - (h.v0 + h.v1) / 2) < 1.2) { ok++; break; }
  }
  byRow.push({ row: r.v0, windows: r.items.length, matched: ok });
}
for (const b of byRow) console.log(`  ряд ${b.row.toFixed(2)} м: окон ${b.windows}, совпало ${b.matched}`);

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({
    file: path.basename(file), plane: { angleDeg, rms, band, offset: planeOff, dir, nrm },
    bbox: { uMin, uMax, vMin, vMax }, cell, holes, rows: rows.map(r => ({ v0: r.v0, count: r.items.length })),
    levels,
    model: { walls: model.stats.wallCount, openings: model.stats.openingCount, storeys: model.storeys ? model.storeys.length : 1, rooms: model.stats.roomCount, openingsList: modelOpenings },
    match: { recall, precision, iou, areaM, areaO, byRow }
  }, null, 1));
  console.log('JSON:', jsonOut);
}
const ifcOut = (process.argv.find(a => a.startsWith('--ifc=')) || '').split('=')[1];
if (ifcOut) {
  fs.writeFileSync(ifcOut, S.toIFC(model, { name: path.basename(ifcOut) }));
  const counts = {};
  for (const m of fs.readFileSync(ifcOut, 'utf8').matchAll(/=([A-Z0-9]+)\(/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
  console.log(`IFC: ${ifcOut} (${(fs.statSync(ifcOut).size / 1024).toFixed(0)} КБ)`);
  console.log('  ' + Object.entries(counts).filter(([k]) => /STOREY|WALL|OPENING|WINDOW|DOOR|SLAB|SPACE|BEAM|COLUMN/.test(k)).map(([k, v]) => `${k} ${v}`).join(', '));
}
