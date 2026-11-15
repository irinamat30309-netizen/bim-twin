'use strict';
/* r132: исправления IFC-импорта, найденные e2e (phase4-edit-ui):
   1) IFCWALLSTANDARDCASE (так пишет наш экспортёр) должен распознаваться как стена;
   2) отчёт импорта не должен печатать «undefined» для created [{floor}/{room}]. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { parseIFC, mapIfcType } = require(path.join(ROOT, 'db/ifcImport.js'));

test('r132: IFCWALLSTANDARDCASE распознаётся как стена при импорте', () => {
  assert.strictEqual(mapIfcType('IFCWALLSTANDARDCASE'), 'стена', 'WALLSTANDARDCASE не маппится в стену');
  assert.strictEqual(mapIfcType('IFCWALL'), 'стена');
  assert.strictEqual(mapIfcType('IFCDOOR'), 'дверь');
  assert.strictEqual(mapIfcType('IFCWINDOW'), 'окно');
});

test('r132: парсер находит стены в IFC вида IFCWALLSTANDARDCASE', () => {
  const ifc = [
    "ISO-10303-21;",
    "HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('x.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;",
    "DATA;",
    "#1=IFCPROJECT('0GUID0000000000000001',$,'Проект',$,$,$,$,$,$);",
    "#2=IFCBUILDINGSTOREY('0GUID0000000000000002',$,'Storey',$,$,$,$,$,.ELEMENT.,0.182);",
    "#3=IFCWALLSTANDARDCASE('0GUID0000000000000003',$,'Стена 1',$,$,$,$,$,.SOLIDWALL.);",
    "#4=IFCDOOR('0GUID0000000000000004',$,'Дверь 1',$,$,$,$,$,$,1.0,2.0);",
    "#5=IFCSPACE('0GUID0000000000000005',$,'Помещение 1 — 30.9 м²',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);",
    "ENDSEC;",
    "END-ISO-10303-21;",
  ].join('\n');
  const r = parseIFC(ifc);
  const types = (r.elements || []).map(e => e.ifcType);
  assert.ok(types.includes('IFCWALLSTANDARDCASE'), 'стена не найдена: ' + JSON.stringify(types));
  assert.ok((r.elements || []).some(e => e.ifcType === 'IFCDOOR'), 'дверь не найдена');
  assert.ok((r.spaces || []).length >= 1, 'помещение не найдено');
});

test('r132: отчёт импорта IFC не печатает undefined', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
  assert.match(src, /x\.name \|\| \(x\.room \? 'Помещение: ' \+ x\.room : ''\)/, 'нет фолбэка room в отчёте');
  assert.match(src, /\|\| x\.floor/, 'нет фолбэка floor в отчёте');
  assert.ok(!/x\.name \+ \(x\.room \?/.test(src), 'старое склеивание имени осталось (даёт undefined)');
});
