'use strict';
// r132: STEP-кодирование не-ASCII (\\X2\\…\\X0\\) и property sets PSet_BimTwin в IFC.
// Проверяем: (а) stepString экранирует кириллицу/апостроф/обратный слэш; (б) toIFC пишет
// только ASCII, имена читаются как ожидаемые escape-последовательности, а для стен/плит/
// помещений есть IfcPropertySet + IfcPropertySingleValue + IfcRelDefinesByProperties
// с типизированными значениями из модели.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const S = require(path.join(__dirname, '..', 'renderer', 'scan2bim.js'));

function sampleModel() {
  return {
    storey: { floorY: 0, ceilY: 3, height: 3 },
    walls: [
      { a: [0, 0], b: [4, 0], dir: [1, 0], thickness: 0.2, length: 4, base: 0, height: 3, material: 'inferred', inferred: true, openings: [], color: [0.4, 0.3, 0.2] },
      { a: [4, 0], b: [4, 3], dir: [0, 1], thickness: 0.147, length: 3, base: 0, height: 3, material: 'brick', inferred: false, openings: [], color: [0.6, 0.5, 0.4] },
    ],
    slabs: [
      { type: 'floor', level: 0, thickness: 0.1, polygon: [[0, 0], [4, 0], [4, 3], [0, 3]], color: [0.7, 0.7, 0.7] },
      { type: 'ceiling', level: 3, thickness: 0.1, polygon: [[0, 0], [4, 0], [4, 3], [0, 3]], color: [0.6, 0.6, 0.6] },
    ],
    rooms: [{ area: 12.5, color: [0.5, 0.5, 0.5], polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] }],
  };
}

test('r132: stepString кодирует не-ASCII как \\X2\\hhhh\\X0\\, апостроф удваивает, слэш удваивает', () => {
  // 'Стена ' + апостроф + 'А' + апостроф — эталон совпадает с renderer/scan2bim-export.js ifcStr
  assert.strictEqual(S.stepString("Стена 'А'"), "'\\X2\\042104420435043D0430\\X0\\ ''\\X2\\0410\\X0\\'''");
  assert.strictEqual(S.stepString('abc'), "'abc'", 'ASCII-строка не меняется');
  assert.strictEqual(S.stepString('a\\b'), "'a\\\\b'", 'обратный слэш удваивается');
  assert.strictEqual(S.stepString('м²'), "'\\X2\\043C00B2\\X0\\'", 'надстрочный ² кодируется');
  assert.strictEqual(S.stepString(null), '$', 'null — STEP-нулл');
  assert.strictEqual(S.stepString('a\r\nb'), "'a b'", 'переводы строк заменяются пробелом');
  assert.ok(!/[^\x00-\x7f]/.test(S.stepString('Стена')), 'в escape-строке нет сырого UTF-8');
});

test('r132: toIFC пишет только ASCII и кириллицу через \\X2\\', () => {
  const ifc = S.toIFC(sampleModel(), { name: 'Тест: здание' });
  assert.ok(/^[\x00-\x7f]*$/.test(ifc), 'в IFC не должно быть сырых не-ASCII символов');
  assert.ok(ifc.includes('\\X2\\042104420435043D0430\\X0\\'), 'имя «Стена» закодировано');
  assert.ok(ifc.includes('\\X2\\041F043E043C043504490435043D04380435\\X0\\'), 'имя «Помещение» закодировано');
  assert.ok(ifc.includes("'\\X2\\042104420435043D0430\\X0\\ 1 (\\X2\\0434043E044104420440043E0435043D0430\\X0\\)'"),
    'имя достроенной стены — «Стена 1 (достроена)» в \\X2\\');
  assert.ok(ifc.includes('\\X2\\041F043E043B\\X0\\'), 'имя плиты «Пол» закодировано');
});

test('r132: PSet_BimTwin присутствует для стен/плит/помещений (IfcPropertySet + single values + rels)', () => {
  const ifc = S.toIFC(sampleModel(), { name: 'props.ifc' });
  const count = (re) => (ifc.match(re) || []).length;
  const walls = count(/=IFCWALLSTANDARDCASE\(/g);
  const slabs = count(/=IFCSLAB\(/g);
  const spaces = count(/=IFCSPACE\(/g);
  assert.strictEqual(walls, 2);
  assert.strictEqual(slabs, 2);
  assert.strictEqual(spaces, 1);
  // по одному набору свойств на каждый продукт (стены+плиты+помещения)
  assert.strictEqual(count(/=IFCPROPERTYSET\(/g), walls + slabs + spaces, 'IfcPropertySet на каждый элемент');
  assert.strictEqual(count(/=IFCRELDEFINESBYPROPERTIES\(/g), walls + slabs + spaces, 'IfcRelDefinesByProperties на каждый pset');
  assert.ok(count(/=IFCPROPERTYSINGLEVALUE\(/g) >= 5 * walls + 2 * slabs + 2 * spaces, 'свойства элементов');
  // значение по умолчанию: материал/толщина/признак «достроена» для стены 1
  assert.ok(ifc.includes("IFCPROPERTYSINGLEVALUE('thickness',$,IFCLENGTHMEASURE(0.2),$)"), 'толщина стены');
  assert.ok(ifc.includes("IFCPROPERTYSINGLEVALUE('material',$,IFCLABEL('inferred'),$)"), 'материал inferred');
  assert.ok(ifc.includes("IFCPROPERTYSINGLEVALUE('inferred',$,IFCBOOLEAN(.T.),$)"), 'inferred=true');
  assert.ok(ifc.includes("IFCPROPERTYSINGLEVALUE('material',$,IFCLABEL('brick'),$)"), 'материал brick');
  assert.ok(ifc.includes("IFCPROPERTYSINGLEVALUE('inferred',$,IFCBOOLEAN(.F.),$)"), 'inferred=false');
  assert.ok(ifc.includes("IFCPROPERTYSINGLEVALUE('area',$,IFCAREAMEASURE(12.5),$)"), 'площадь помещения');
  assert.ok(ifc.includes("IFCPROPERTYSINGLEVALUE('thickness',$,IFCLENGTHMEASURE(0.1),$)"), 'толщина плиты');
  assert.ok(ifc.includes("IFCPROPERTYSINGLEVALUE('type',$,IFCLABEL('floor'),$)"), 'тип плиты');
});

test('r132: property sets ссылаются на элементы (каждый IfcRelDefinesByProperties)', () => {
  const ifc = S.toIFC(sampleModel(), { name: 'rels.ifc' });
  const ids = new Set([...ifc.matchAll(/^#(\d+)=/gm)].map(m => '#' + m[1]));
  const rels = [...ifc.matchAll(/^#(\d+)=IFCRELDEFINESBYPROPERTIES\(([^;]*)\);$/gm)];
  assert.strictEqual(rels.length, 5, '2 стены + 2 плиты + 1 помещение');
  for (const m of rels) {
    const body = m[2];
    const refs = [...body.matchAll(/#(\d+)/g)].map(x => '#' + x[1]);
    assert.ok(refs.length >= 2, 'в связи есть элемент и набор свойств');
    for (const r of refs) assert.ok(ids.has(r), 'ссылка ' + r + ' существует');
  }
});
