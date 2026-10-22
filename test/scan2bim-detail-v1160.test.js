'use strict';
// v1160 — качество реконструкции BIM:
//   • параллельные грани одной толстой стены не делятся на «слои» (мержа)
//   • детектятся проёмы (двери)
//   • детектятся трубы под потолком и попадают в OBJ/IFC
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const S = require(path.join(__dirname, '..', 'renderer', 'scan2bim.js'));

function scene() {
  let s = 7 >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const jit = a => (rnd() - 0.5) * a;
  const pts = []; const W = 10, D = 4, H = 3;
  // две длинные СТЕНЫ, каждая из 4 параллельных слоёв (имитация толстой шумной стены)
  for (let layer = 0; layer < 4; layer++) {
    const zoff = layer * 0.10;
    for (let i = 0; i <= 200; i++) for (let k = 0; k <= 30; k++) {
      const x = (i / 200) * W, y = (k / 30) * H;
      if (!(x > 4 && x < 5 && y < 2.1)) pts.push([x + jit(0.01), y, 0 + zoff + jit(0.01)]); // дверной проём 4..5
      pts.push([x + jit(0.01), y, D - zoff + jit(0.01)]);
    }
  }
  for (let j = 0; j <= 40; j++) for (let k = 0; k <= 30; k++) { const z = (j / 40) * D, y = (k / 30) * H; pts.push([0 + jit(0.01), y, z + jit(0.01)]); pts.push([W + jit(0.01), y, z + jit(0.01)]); }
  for (let i = 0; i <= 100; i++) for (let j = 0; j <= 40; j++) { const x = (i / 100) * W, z = (j / 40) * D; pts.push([x, 0 + jit(0.01), z]); pts.push([x, H + jit(0.01), z]); }
  // горизонтальная труба под потолком
  for (let i = 0; i <= 300; i++) { const x = (i / 300) * W; for (let a = 0; a < 8; a++) { const th = a / 8 * Math.PI * 2; pts.push([x, 2.7 + Math.sin(th) * 0.05, 2.0 + Math.cos(th) * 0.05]); } }
  return pts;
}

test('merge: толстая шумная стена НЕ делится на слои', () => {
  const m = S.reconstruct(scene(), { voxel: 0.04, wallThreshold: 0.06 });
  assert.ok(m.ok, m.error || '');
  // 4 реальные стены, а не десятки параллельных финов
  assert.ok(m.walls.length <= 6, 'слишком много стен (слои?): ' + m.walls.length);
  const long = m.walls.filter(w => w.length > 8);
  assert.strictEqual(long.length, 2, 'должно быть ровно 2 длинные стены, а не ' + long.length);
  long.forEach(w => { assert.ok(w.thickness > 0.15 && w.thickness <= 0.6, 'толщина слитой стены: ' + w.thickness); });
});

test('openings: детектируется дверной проём', () => {
  const m = S.reconstruct(scene(), { voxel: 0.04, wallThreshold: 0.06 });
  assert.ok(m.stats.openingCount >= 1, 'проём не найден');
  const withOp = m.walls.find(w => (w.openings || []).length);
  assert.ok(withOp, 'нет стены с проёмом');
  const op = withOp.openings[0];
  assert.ok(op.width >= 0.6 && op.width <= 2.6, 'ширина проёма вне диапазона: ' + op.width);
});

test('openings: чистая комната без проёмов не плодит ложные двери', () => {
  // плотная сплошная стена — проёмов быть не должно
  const pts = []; const W = 6, D = 4, H = 3;
  for (let i = 0; i <= 120; i++) for (let k = 0; k <= 30; k++) { const x = (i / 120) * W, y = (k / 30) * H; pts.push([x, y, 0]); pts.push([x, y, D]); }
  for (let j = 0; j <= 40; j++) for (let k = 0; k <= 30; k++) { const z = (j / 40) * D, y = (k / 30) * H; pts.push([0, y, z]); pts.push([W, y, z]); }
  for (let i = 0; i <= 60; i++) for (let j = 0; j <= 40; j++) { const x = (i / 60) * W, z = (j / 40) * D; pts.push([x, 0, z]); pts.push([x, H, z]); }
  const m = S.reconstruct(pts, { voxel: 0.05, wallThreshold: 0.06 });
  assert.strictEqual(m.stats.openingCount, 0, 'ложные проёмы на сплошных стенах');
});

test('pipes: труба под потолком детектируется и экспортируется', () => {
  const m = S.reconstruct(scene(), { voxel: 0.04, wallThreshold: 0.06 });
  assert.ok(m.stats.pipeCount >= 1, 'труба не найдена');
  m.pipes.forEach(p => { assert.ok(p.radius > 0 && p.radius <= 0.2, 'радиус трубы вне диапазона'); assert.ok(p.length >= 0.9, 'короткая труба'); });
  const obj = S.toOBJ(m); assert.ok((obj.match(/\nv /g) || []).length > 0, 'OBJ пустой');
  const ifc = S.toIFC(m, { name: 't.ifc' });
  assert.ok(ifc.includes('IFCPIPESEGMENT'), 'нет IfcPipeSegment');
  assert.ok(ifc.includes('IFCCIRCLEPROFILEDEF'), 'нет круглого профиля трубы');
  assert.ok(ifc.trim().endsWith('END-ISO-10303-21;'), 'IFC не завершён');
});

test('pipes: чистый потолок без труб не даёт ложных труб', () => {
  const pts = []; const W = 6, D = 4, H = 3;
  for (let i = 0; i <= 120; i++) for (let k = 0; k <= 30; k++) { const x = (i / 120) * W, y = (k / 30) * H; pts.push([x, y, 0]); pts.push([x, y, D]); }
  for (let j = 0; j <= 40; j++) for (let k = 0; k <= 30; k++) { const z = (j / 40) * D, y = (k / 30) * H; pts.push([0, y, z]); pts.push([W, y, z]); }
  for (let i = 0; i <= 60; i++) for (let j = 0; j <= 40; j++) { const x = (i / 60) * W, z = (j / 40) * D; pts.push([x, 0, z]); pts.push([x, H, z]); }
  const m = S.reconstruct(pts, { voxel: 0.05, wallThreshold: 0.06 });
  assert.strictEqual(m.stats.pipeCount, 0, 'ложные трубы на пустом потолке');
});

test('детерминизм с деталями', () => {
  const a = S.reconstruct(scene(), { voxel: 0.04 }), b = S.reconstruct(scene(), { voxel: 0.04 });
  assert.strictEqual(a.stats.wallCount, b.stats.wallCount);
  assert.strictEqual(a.stats.openingCount, b.stats.openingCount);
  assert.strictEqual(a.stats.pipeCount, b.stats.pipeCount);
});

test('objects: внутренний объект (оборудование) детектируется и экспортируется', () => {
  // сплошная комната + отдельно стоящий объект в центре
  const pts = []; const W = 6, D = 4, H = 3;
  for (let i = 0; i <= 120; i++) for (let k = 0; k <= 30; k++) { const x = (i / 120) * W, y = (k / 30) * H; pts.push([x, y, 0]); pts.push([x, y, D]); }
  for (let j = 0; j <= 40; j++) for (let k = 0; k <= 30; k++) { const z = (j / 40) * D, y = (k / 30) * H; pts.push([0, y, z]); pts.push([W, y, z]); }
  for (let i = 0; i <= 60; i++) for (let j = 0; j <= 40; j++) { const x = (i / 60) * W, z = (j / 40) * D; pts.push([x, 0, z]); pts.push([x, H, z]); }
  // объект: коробка 0.6×0.6×0.9 в центре комнаты (низкая вертикальная протяжённость → не стена)
  for (let x = 2.7; x <= 3.3; x += 0.03) for (let z = 1.7; z <= 2.3; z += 0.03) for (let y = 0.02; y <= 0.9; y += 0.05) {
    if (x < 2.75 || x > 3.25 || z < 1.75 || z > 2.25 || y > 0.85 || y < 0.05) pts.push([x, y, z]);
  }
  const m = S.reconstruct(pts, { voxel: 0.04 });
  assert.ok(m.stats.objectCount >= 1, 'внутренний объект не найден');
  const ifc = S.toIFC(m, { name: 'o.ifc' });
  assert.ok(ifc.includes('IFCBUILDINGELEMENTPROXY'), 'нет IfcBuildingElementProxy для объекта');
  assert.ok(ifc.trim().endsWith('END-ISO-10303-21;'), 'IFC не завершён');
});

test('objects: пустая комната не плодит ложные объекты', () => {
  const pts = []; const W = 6, D = 4, H = 3;
  for (let i = 0; i <= 120; i++) for (let k = 0; k <= 30; k++) { const x = (i / 120) * W, y = (k / 30) * H; pts.push([x, y, 0]); pts.push([x, y, D]); }
  for (let j = 0; j <= 40; j++) for (let k = 0; k <= 30; k++) { const z = (j / 40) * D, y = (k / 30) * H; pts.push([0, y, z]); pts.push([W, y, z]); }
  for (let i = 0; i <= 60; i++) for (let j = 0; j <= 40; j++) { const x = (i / 60) * W, z = (j / 40) * D; pts.push([x, 0, z]); pts.push([x, H, z]); }
  const m = S.reconstruct(pts, { voxel: 0.05 });
  assert.strictEqual(m.stats.objectCount, 0, 'ложные объекты в пустой комнате');
});

test('версия движка 1231', () => {
  assert.strictEqual(S.version, '1231');
});
