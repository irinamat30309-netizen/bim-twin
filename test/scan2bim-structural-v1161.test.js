'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const S = require(path.join(__dirname, '..', 'renderer', 'scan2bim.js'));

// Сцена: комната 6x4x3 + колонна 0.4x0.4 на всю высоту в центре + балка под потолком поперёк.
function sceneStruct() {
  let s = 11 >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const jit = a => (rnd() - 0.5) * a;
  const pts = []; const W = 6, D = 4, H = 3;
  // стены (две пары), пол, потолок
  for (let i = 0; i <= 120; i++) for (let k = 0; k <= 30; k++) { const x = (i / 120) * W, y = (k / 30) * H; pts.push([x, y, 0]); pts.push([x, y, D]); }
  for (let j = 0; j <= 40; j++) for (let k = 0; k <= 30; k++) { const z = (j / 40) * D, y = (k / 30) * H; pts.push([0, y, z]); pts.push([W, y, z]); }
  for (let i = 0; i <= 60; i++) for (let j = 0; j <= 40; j++) { const x = (i / 60) * W, z = (j / 40) * D; pts.push([x, 0, z]); pts.push([x, H, z]); }
  // КОЛОННА: полая оболочка 0.4x0.4 по всей высоте в центре
  for (let y = 0.1; y <= H - 0.1; y += 0.04) for (let a = 0; a < 20; a++) { const th = a / 20 * Math.PI * 2; pts.push([1.5 + Math.cos(th) * 0.2 + jit(0.005), y, 1.0 + Math.sin(th) * 0.2 + jit(0.005)]); }
  // БАЛКА: горизонтальный брус шириной ~0.3, поперёк комнаты, на высоте ~2.85
  for (let x = 0.6; x <= 5.4; x += 0.03) for (let w = -0.15; w <= 0.15; w += 0.03) for (let y = 2.78; y <= 2.9; y += 0.04) { pts.push([x, y, 2 + w]); }
  return pts;
}

test('колонна: вертикальная колонна классифицируется и экспортируется как IFCCOLUMN', () => {
  const m = S.reconstruct(sceneStruct(), { voxel: 0.04 });
  assert.ok(m.ok, m.error || 'reconstruct failed');
  const cols = (m.objects || []).filter(o => o.kind === 'column');
  assert.ok(cols.length >= 1, 'колонна не найдена');
  assert.ok(m.stats.columnCount >= 1, 'columnCount = 0');
  const ifc = S.toIFC(m, { name: 'c.ifc' });
  assert.ok(ifc.includes('IFCCOLUMN'), 'нет IFCCOLUMN в IFC');
  assert.ok(ifc.trim().endsWith('END-ISO-10303-21;'), 'IFC не завершён');
});

test('балка: горизонтальный брус под потолком классифицируется и экспортируется как IFCBEAM', () => {
  const m = S.reconstruct(sceneStruct(), { voxel: 0.04 });
  assert.ok((m.beams || []).length >= 1, 'балка не найдена');
  assert.ok(m.stats.beamCount >= 1, 'beamCount = 0');
  const ifc = S.toIFC(m, { name: 'b.ifc' });
  assert.ok(ifc.includes('IFCBEAM'), 'нет IFCBEAM в IFC');
  const obj = S.toOBJ(m);
  assert.ok((obj.match(/\nv /g) || []).length > 0, 'OBJ пустой');
  const dxf = S.toDXF(m);
  assert.ok(dxf.includes('BEAMS'), 'нет слоя BEAMS в DXF');
});

test('чистая комната: нет ложных колонн и балок', () => {
  const pts = []; const W = 6, D = 4, H = 3;
  for (let i = 0; i <= 120; i++) for (let k = 0; k <= 30; k++) { const x = (i / 120) * W, y = (k / 30) * H; pts.push([x, y, 0]); pts.push([x, y, D]); }
  for (let j = 0; j <= 40; j++) for (let k = 0; k <= 30; k++) { const z = (j / 40) * D, y = (k / 30) * H; pts.push([0, y, z]); pts.push([W, y, z]); }
  for (let i = 0; i <= 60; i++) for (let j = 0; j <= 40; j++) { const x = (i / 60) * W, z = (j / 40) * D; pts.push([x, 0, z]); pts.push([x, H, z]); }
  const m = S.reconstruct(pts, { voxel: 0.05 });
  assert.strictEqual(m.stats.beamCount || 0, 0, 'ложные балки');
  const cols = (m.objects || []).filter(o => o.kind === 'column');
  assert.strictEqual(cols.length, 0, 'ложные колонны');
});

test('версия движка = 1231', () => { assert.strictEqual(S.version, '1231'); });
