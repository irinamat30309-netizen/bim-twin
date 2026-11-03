const test = require('node:test');
const assert = require('node:assert');
const PCEdit = require('../renderer/pointcloud-edit.js');

test('protectFloorLocal: floor points are protected, object points stay deletable', () => {
  const pts = [];
  // Пол: плотная горизонтальная сетка z=0 (крупная поверхность).
  for (let x = -20; x <= 20; x++) for (let y = -20; y <= 20; y++) pts.push(x * 0.1, y * 0.1, 0);
  const objStart = pts.length / 3;
  // Объект: небольшая вертикальная колонна у начала координат.
  for (let k = 0; k < 60; k++) pts.push(0.02 * (k % 3), 0.02 * ((k / 3) | 0), 0.05 + k * 0.01);
  const pos = new Float32Array(pts);
  const n = pos.length / 3;
  // Выделение «насквозь»: весь объект + пятно пола под ним.
  const sel = [];
  for (let i = objStart; i < n; i++) sel.push(i);
  for (let i = 0; i < objStart; i++) { const x = pos[i * 3], y = pos[i * 3 + 1]; if (Math.abs(x) < 0.3 && Math.abs(y) < 0.3) sel.push(i); }
  const kept = PCEdit.protectFloorLocal({ pos }, sel, { spacing: 0.05 });
  let floorInKept = 0, objInKept = 0;
  for (const idx of kept) { if (idx < objStart) floorInKept++; else objInKept++; }
  assert.equal(floorInKept, 0, 'floor points must be protected (removed from delete set)');
  assert.ok(objInKept > 40, 'most object points remain deletable, got ' + objInKept);
});

test('protectFloorLocal smart: compact debris cluster on floor becomes deletable', () => {
  const pts = [];
  for (let x = -25; x <= 25; x++) for (let y = -25; y <= 25; y++) pts.push(x * 0.1, y * 0.1, 0);
  const objStart = pts.length / 3;
  // Плоское компактное пятно мусора (диск ~0.35 м) на высоте 0.3 м над полом.
  for (let k = 0; k < 200; k++) { const ang = k * 2.399963; const rr = 0.175 * Math.sqrt((k + 0.5) / 200); pts.push(Math.cos(ang) * rr, Math.sin(ang) * rr, 0.3); }
  const pos = new Float32Array(pts);
  const n = pos.length / 3;
  const sel = [];
  for (let i = objStart; i < n; i++) sel.push(i);
  for (let i = 0; i < objStart; i++) { const x = pos[i * 3], y = pos[i * 3 + 1]; if (Math.abs(x) < 0.4 && Math.abs(y) < 0.4) sel.push(i); }
  const keptSmart = PCEdit.protectFloorLocal({ pos }, sel, { spacing: 0.05 });
  const keptDumb = PCEdit.protectFloorLocal({ pos }, sel, { spacing: 0.05, smart: false });
  let floorSmart = 0, objSmart = 0, objDumb = 0;
  for (const idx of keptSmart) { if (idx < objStart) floorSmart++; else objSmart++; }
  for (const idx of keptDumb) { if (idx >= objStart) objDumb++; }
  assert.equal(floorSmart, 0, 'floor stays protected with smart on');
  assert.ok(objSmart > objDumb, 'smart lets more debris be deleted: ' + objSmart + ' vs ' + objDumb);
  assert.ok(objSmart > 150, 'most debris deletable with smart, got ' + objSmart);
});

test('protectFloorLocal: no selection returns empty', () => {
  const pos = new Float32Array([0, 0, 0, 1, 1, 1]);
  assert.deepEqual(PCEdit.protectFloorLocal({ pos }, []), []);
});

test('cleanIslands: removes small disconnected clusters, keeps main body', () => {
  const pts = [];
  for (let x = 0; x < 40; x++) for (let y = 0; y < 40; y++) for (let z = 0; z < 3; z++) pts.push(x * 0.05, y * 0.05, z * 0.05);
  const mainCount = pts.length / 3;
  // Далёкий маленький островок (30 точек).
  for (let k = 0; k < 30; k++) pts.push(100 + 0.05 * (k % 5), 100, 0.05 * ((k / 5) | 0));
  const pos = new Float32Array(pts);
  const r = PCEdit.cleanIslands({ pos }, { voxel: 0.1, minClusterPts: 100 });
  assert.ok(r.removed >= 30, 'removes at least the 30-point island, got ' + r.removed);
  assert.ok(r.removed < mainCount, 'keeps the main body');
});
