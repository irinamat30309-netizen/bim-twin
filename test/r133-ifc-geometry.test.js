'use strict';
// r133: 3D-геометрия при IFC-импорте для НАШИХ экспортов (SweptSolid: стены/плиты/помещения).
// Проверяем: разбор IfcExtrudedAreaSolid (IfcRectangleProfileDef + IfcArbitraryClosedProfileDef),
// IfcAxis2Placement3D/2D, цепочку IfcLocalPlacement, мировые координаты приложения
// (X — план X, Y — вверх, Z — план Z), цвета IfcStyledItem, лимиты и интерфейс приложения.
// Реальный файл py2-final-v5.ifc проверяется только если он есть (skip если нет).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const { parseIFC, GEOMETRY_LIMITS } = require(path.join(ROOT, 'db', 'ifcImport.js'));

const SYNTHETIC = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('synthetic-ifc-geometry.ifc','',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  '#1=IFCCARTESIANPOINT((0.,0.,0.));',
  '#2=IFCDIRECTION((0.,0.,1.));',
  '#3=IFCDIRECTION((1.,0.,0.));',
  '#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);',
  '#5=IFCLOCALPLACEMENT($,#4);',
  '#6=IFCGEOMETRICREPRESENTATIONCONTEXT($,\'Model\',3,1.E-5,#4,$);',
  // 2D-профиль: прямоугольник 4 × 0.2 в начале координат
  '#10=IFCCARTESIANPOINT((0.,0.));',
  '#11=IFCDIRECTION((1.,0.));',
  '#12=IFCAXIS2PLACEMENT2D(#10,#11);',
  '#13=IFCRECTANGLEPROFILEDEF(.AREA.,$,#12,4.,0.2);',
  '#14=IFCEXTRUDEDAREASOLID(#13,#4,#2,3.);',
  '#15=IFCSHAPEREPRESENTATION(#6,\'Body\',\'SweptSolid\',(#14));',
  '#16=IFCPRODUCTDEFINITIONSHAPE($,$,(#15));',
  // цепочка размещений: этаж + смещение (+10, +20, 0)
  '#20=IFCCARTESIANPOINT((10.,20.,0.));',
  '#21=IFCAXIS2PLACEMENT3D(#20,#2,#3);',
  '#22=IFCLOCALPLACEMENT(#5,#21);',
  '#23=IFCWALLSTANDARDCASE(\'0wall0000000000000001\',$,\'Стена 1\',$,$,#22,#16,$,$);',
  // плита: произвольный замкнутый профиль (IfcPolyline) 4 × 3, экструзия 0.1
  '#30=IFCCARTESIANPOINT((0.,0.));',
  '#31=IFCCARTESIANPOINT((4.,0.));',
  '#32=IFCCARTESIANPOINT((4.,-3.));',
  '#33=IFCCARTESIANPOINT((0.,-3.));',
  '#34=IFCPOLYLINE((#30,#31,#32,#33,#30));',
  '#35=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#34);',
  '#36=IFCEXTRUDEDAREASOLID(#35,#4,#2,0.1);',
  '#37=IFCSHAPEREPRESENTATION(#6,\'Body\',\'SweptSolid\',(#36));',
  '#38=IFCPRODUCTDEFINITIONSHAPE($,$,(#37));',
  '#39=IFCSLAB(\'0slab0000000000000001\',$,\'Пол\',$,$,#5,#38,$,.FLOOR.);',
  // помещение: прямоугольник 2 × 2, экструзия 2.7 от z=0.5
  '#40=IFCCARTESIANPOINT((0.,0.,0.5));',
  '#41=IFCAXIS2PLACEMENT3D(#40,#2,#3);',
  '#42=IFCRECTANGLEPROFILEDEF(.AREA.,$,#12,2.,2.);',
  '#43=IFCEXTRUDEDAREASOLID(#42,#41,#2,2.7);',
  '#44=IFCSHAPEREPRESENTATION(#6,\'Body\',\'SweptSolid\',(#43));',
  '#45=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));',
  '#46=IFCSPACE(\'0space000000000000001\',$,\'Помещение 1 — 4.0 м²\',$,$,#5,#45,$,.ELEMENT.,.INTERNAL.,$);',
  // цвет стены из облака (IfcStyledItem → IfcSurfaceStyle → Rendering → ColourRgb)
  '#50=IFCCOLOURRGB($,0.5,0.4,0.3);',
  '#51=IFCSURFACESTYLERENDERING(#50,0.2,$,$,$,$,$,$,.NOTDEFINED.);',
  '#52=IFCSURFACESTYLE(\'Wall brick\',.BOTH.,(#51));',
  '#53=IFCSTYLEDITEM(#14,(#52),$);',
  'ENDSEC;',
  'END-ISO-10303-21;',
].join('\n');

function bboxOf(objects) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const o of objects) {
    for (let i = 0; i < o.pos.length; i += 3) {
      for (let k = 0; k < 3; k++) { const v = o.pos[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
    }
  }
  return { mn, mx };
}

function near(a, b, tol, msg) {
  assert.ok(Math.abs(a - b) <= tol, (msg || '') + ': ' + a + ' != ' + b + ' ± ' + tol);
}

test('r133: синтетический IFC — прямоугольный профиль, экструзия и IfcLocalPlacement-цепочка', () => {
  const parsed = parseIFC(SYNTHETIC, { geometry: true });
  const g = parsed.geometry;
  assert.ok(g, 'геометрия не построена');
  assert.strictEqual(g.stats.objects, 3, 'объектов: ' + g.stats.objects);
  assert.strictEqual(g.stats.walls, 1);
  assert.strictEqual(g.stats.slabs, 1);
  assert.strictEqual(g.stats.spaces, 1);
  assert.strictEqual(g.stats.skipped, 0);
  const wall = g.objects.find(o => o.type === 'IFCWALLSTANDARDCASE');
  const slab = g.objects.find(o => o.type === 'IFCSLAB');
  const space = g.objects.find(o => o.type === 'IFCSPACE');
  assert.ok(wall && slab && space, 'не все элементы с геометрией');
  assert.strictEqual(wall.name, 'Стена 1');
  assert.strictEqual(wall.triangles, 12, 'коробка стены = 12 треугольников');
  assert.strictEqual(slab.triangles, 12, 'плита = 12 треугольников');
  // мировая цепочка: стена сдвинута на (+10, +20) в IFC X/Y → приложение (X, Z=-Y):
  // X 8..12, Y 0..3, Z -20.1..-19.9
  const wb = bboxOf([wall]);
  near(wb.mn[0], 8, 1e-6, 'стена X min (цепочка IfcLocalPlacement)');
  near(wb.mx[0], 12, 1e-6, 'стена X max');
  near(wb.mn[1], 0, 1e-6, 'стена Y min');
  near(wb.mx[1], 3, 1e-6, 'стена Y max (высота экструзии)');
  near(wb.mn[2], -20.1, 1e-6, 'стена Z min (IFC Y=20.1)');
  near(wb.mx[2], -19.9, 1e-6, 'стена Z max');
  // плита: профиль (0,0)…(4,-3), экструзия 0.1 → X 0..4, Y 0..0.1, Z 0..3
  const sb = bboxOf([slab]);
  near(sb.mn[0], 0, 1e-6); near(sb.mx[0], 4, 1e-6);
  near(sb.mn[1], 0, 1e-6); near(sb.mx[1], 0.1, 1e-6);
  near(sb.mn[2], 0, 1e-6); near(sb.mx[2], 3, 1e-6);
  // помещение: прямоугольник 2×2 от z=0.5 → X -1..1, Z -1..1, Y 0.5..3.2
  const pb = bboxOf([space]);
  near(pb.mn[0], -1, 1e-6); near(pb.mx[0], 1, 1e-6);
  near(pb.mn[1], 0.5, 1e-6); near(pb.mx[1], 3.2, 1e-6);
  near(pb.mn[2], -1, 1e-6); near(pb.mx[2], 1, 1e-6);
  // общий bbox
  near(g.bbox.mn[0], -1, 1e-6); near(g.bbox.mx[0], 12, 1e-6);
  near(g.bbox.mn[1], 0, 1e-6); near(g.bbox.mx[1], 3.2, 1e-6);
  near(g.bbox.mn[2], -20.1, 1e-6); near(g.bbox.mx[2], 3, 1e-6);
});

test('r133: цвет стены из IfcStyledItem (IfcSurfaceStyleRendering → IfcColourRgb)', () => {
  const g = parseIFC(SYNTHETIC, { geometry: true }).geometry;
  const wall = g.objects.find(o => o.type === 'IFCWALLSTANDARDCASE');
  assert.ok(wall.col, 'у стены нет цветов');
  near(wall.col[0], 0.5, 1e-6); near(wall.col[1], 0.4, 1e-6); near(wall.col[2], 0.3, 1e-6);
  const slab = g.objects.find(o => o.type === 'IFCSLAB');
  assert.strictEqual(slab.col, null, 'у плиты без стиля цвета быть не должно');
});

test('r133: семантика без opts.geometry не меняется', () => {
  const parsed = parseIFC(SYNTHETIC);
  assert.strictEqual(parsed.geometry, undefined, 'geometry не должна считаться по умолчанию');
  assert.strictEqual(parsed.spaces.length, 1);
  assert.ok(parsed.spaces[0].name.startsWith('Помещение 1'));
  assert.ok(parsed.elements.some(e => e.ifcType === 'IFCWALLSTANDARDCASE'));
});

test('r133: лимиты объектов/сущностей не дают построить лишнее', () => {
  const g = parseIFC(SYNTHETIC, { geometry: true, limits: { maxObjects: 1 } }).geometry;
  assert.strictEqual(g.stats.objects, 1);
  assert.ok(g.stats.skipped >= 2, 'пропущенные объекты не посчитаны: ' + g.stats.skipped);
  assert.strictEqual(g.stats.skippedReason, 'objects_limit');
  assert.ok(GEOMETRY_LIMITS.maxObjects >= 1000, 'дефолтные лимиты слишком малы');
});

test('r133: браузерная версия (renderer/ifc-import.js) строит ту же геометрию', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'ifc-import.js'), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox, { filename: 'renderer/ifc-import.js' });
  assert.ok(sandbox.window.IFCImport && typeof sandbox.window.IFCImport.parseIFC === 'function', 'window.IFCImport.parseIFC');
  const g = sandbox.window.IFCImport.parseIFC(SYNTHETIC, { geometry: true }).geometry;
  assert.strictEqual(g.stats.objects, 3);
  assert.strictEqual(g.stats.triangles, 36);
  near(g.bbox.mn[0], -1, 1e-6); near(g.bbox.mx[0], 12, 1e-6);
  near(g.bbox.mn[2], -20.1, 1e-6); near(g.bbox.mx[2], 3, 1e-6);
});

test('r133: интеграция в app.js — меш передаётся в 3D-вьюер и выключается', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  assert.ok(src.includes('parseIfcGeometryFromFile'), 'нет разбора геометрии при импорте');
  assert.ok(src.includes('ifcGeometryToPly'), 'нет конвертации меша для вьюера');
  assert.ok(src.includes('showIfcGeometry3D'), 'нет показа геометрии');
  assert.ok(src.includes('hideIfcGeometry3D'), 'нет выключения геометрии');
  assert.ok(/id="ifcGeomToggle"/.test(src), 'нет переключателя показа геометрии');
  assert.ok(src.includes('window.MeshViewer'), 'геометрия не передаётся в вьюер мешей');
});

// ---------- реальный файл: py2-final-v5.ifc (skip если нет) ----------
const V5_IFC = 'D:/BIM-TWIN-TEST/interior/py2-final-v5.ifc';
const V5_JSON = 'D:/BIM-TWIN-TEST/interior/py2-final-v5.json';
const CLOUD_BIN = 'D:/BIM-TWIN-TEST/interior/koridor-local-rgb.bin';
const hasReal = fs.existsSync(V5_IFC) && fs.existsSync(V5_JSON);

test('r133: py2-final-v5.ifc — 100 стен / 2 плиты / 9 помещений с геометрией', { skip: !hasReal ? 'нет py2-final-v5.ifc' : false }, () => {
  const parsed = parseIFC(fs.readFileSync(V5_IFC, 'utf8'), { geometry: true });
  const g = parsed.geometry;
  assert.strictEqual(g.stats.objects, 111, 'объектов: ' + g.stats.objects);
  assert.strictEqual(g.stats.walls, 100);
  assert.strictEqual(g.stats.slabs, 2);
  assert.strictEqual(g.stats.spaces, 9);
  assert.ok(g.stats.triangles > 3000, 'треугольников: ' + g.stats.triangles);
  assert.strictEqual(g.stats.skipped, 0);
  // меш — треугольники с нормалями/цветами
  const wall = g.objects[0];
  assert.strictEqual(wall.pos.length, wall.triangles * 9);
  assert.strictEqual(wall.nor.length, wall.pos.length);
  assert.ok(wall.col, 'у наших стен должны быть цвета из облака');

  // bbox геометрии = bbox модели из JSON (стены + плиты + помещения), допуск 5 см
  const model = JSON.parse(fs.readFileSync(V5_JSON, 'utf8'));
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const upd = (v) => { for (let k = 0; k < 3; k++) { if (v[k] < mn[k]) mn[k] = v[k]; if (v[k] > mx[k]) mx[k] = v[k]; } };
  for (const w of model.walls) {
    const nx = -w.dir[1], nz = w.dir[0], t = w.thickness;
    for (const p of [w.a, w.b]) for (const s of [-t / 2, t / 2]) { upd([p[0] + nx * s, w.base, p[1] + nz * s]); upd([p[0] + nx * s, w.base + w.height, p[1] + nz * s]); }
  }
  for (const s of model.slabs) {
    const z0 = s.type === 'ceiling' ? s.level : s.level - s.thickness;
    for (const p of s.polygon) { upd([p[0], z0, p[1]]); upd([p[0], z0 + s.thickness, p[1]]); }
  }
  for (const r of model.rooms || []) {
    const z0 = (model.storey && model.storey.floorY) || 0, h = (model.storey && model.storey.height) || 3;
    for (const p of r.polygon) { upd([p[0], z0, p[1]]); upd([p[0], z0 + h, p[1]]); }
  }
  for (let k = 0; k < 3; k++) {
    near(g.bbox.mn[k], mn[k], 0.05, 'bbox min[' + k + ']');
    near(g.bbox.mx[k], mx[k], 0.05, 'bbox max[' + k + ']');
  }

  // высота геометрии стен против облака (floorY/ceilY из ruler-обмера) — допуск 5 см
  const wallsOnly = g.objects.filter(o => o.type === 'IFCWALLSTANDARDCASE' || o.type === 'IFCSPACE');
  const wb = bboxOf(wallsOnly);
  const RULER_V5 = 'D:/BIM-TWIN-TEST/interior/ruler-py2-final-v5.json';
  if (fs.existsSync(RULER_V5)) {
    const ruler = JSON.parse(fs.readFileSync(RULER_V5, 'utf8'));
    const cloud = ruler.cloud || {};
    near(wb.mn[1], cloud.floorY, 0.05, 'низ геометрии vs floorY облака');
    near(wb.mx[1], cloud.ceilY, 0.05, 'верх геометрии vs ceilY облака');
  }
  if (fs.existsSync(CLOUD_BIN)) {
    const buf = fs.readFileSync(CLOUD_BIN);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i + 5 < buf.length / 4; i += 6) {
      const x = buf.readFloatLE(i * 4), z = buf.readFloatLE((i + 2) * 4);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    // облако обрезано до ±6/±9 м: габарит чуть меньше модели, поэтому сравниваем центр плана (±5 см)
    near((g.bbox.mn[0] + g.bbox.mx[0]) / 2, (minX + maxX) / 2, 0.05, 'центр X vs облако');
    near((g.bbox.mn[2] + g.bbox.mx[2]) / 2, (minZ + maxZ) / 2, 0.05, 'центр Z vs облако');
  }
});
