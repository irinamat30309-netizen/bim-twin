'use strict';
/*
 * r169: структурированный контекст приложения для ИИ (renderer/ai-context.js).
 * Проверяем: облако (имя/точки/bbox/CRS), выделение (точки/bbox/объём/доминирующий класс),
 * элемент из инспектора/auto-measure, контроль геометрии (стены/пол/дефекты/проверки),
 * модель/проект/документы/измерения, промпт-блок с запретом выдумывать, отсутствие данных — честно null.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'renderer', 'ai-context.js'));

function posGrid(n) {
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { p[i * 3] = (i % 10) * 0.1; p[i * 3 + 1] = Math.floor(i / 100) * 0.1; p[i * 3 + 2] = (i % 7) * 0.1; }
  return p;
}
function fakeEnv(opts) {
  opts = opts || {};
  const pos = posGrid(300);
  const sel = new Set(opts.sel || [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const labels = new Uint8Array(300); for (let i = 0; i < 300; i++) labels[i] = i < 10 ? 6 : 2;
  const viewer = {
    bbox: { mn: [-1, 0, -2], mx: [3, 2.8, 2] },
    base: [{ pos, col: null, _spacing: 0.01 }],
    _cloudRecord: { sourceName: 'D:/scan/room.las', sourceCount: 300, loadedCount: 300 },
    _srcCrs: 'PROJCS["WGS 84 / UTM zone 36N",AUTHORITY["EPSG","32636"]]',
    _cloudColorMode: 'classification',
    _classificationLabels: labels,
    _sel: sel,
    selectionCount: () => sel.size,
    getEditedCloud: () => null
  };
  const res = {
    ok: true,
    walls: [{ ok: true, rms: 2.1 }, { ok: false, rms: 6.4 }, { okPlumb: false, okRail: true }],
    floor: { FF: 12.345, FL: 12.3, mmPerM: 1.2, area: 32.5 },
    defects: [{ depth: 4.2 }, { depth: 1.1 }],
    openings: [{ kind: 'door' }, { kind: 'window' }],
    rooms: [{ area: 18.2 }, { area: 14.3 }],
    mep: { pipes: 4, beams: 2, ducts: 1 },
    class: 'improved'
  };
  const autoMain = { title: 'Стена', family: 'wall', role: 'wall', score: 0.91, center: [1, 1.5, 0], dims: [{ key: 'length', label: 'Длина', value: 5, unit: 'м', text: '5,00 м' }, { key: 'height', label: 'Высота', value: 3, unit: 'м', text: '3,00 м' }, { key: 'thickness', label: 'Толщина', value: 0.2, unit: 'м', text: '200 мм' }] };
  const autoRes = { ok: true, objects: [autoMain, { title: 'Пол', family: 'floor' }], main: autoMain, info: { spacing: 0.01 }, rejected: [] };
  const model = { ok: true, storeys: [{ name: 'Этаж 1', height: 3 }], walls: [{ length: 5, openings: [{ kind: 'door' }, { kind: 'window' }] }, { length: 3, openings: [{ kind: 'door' }] }], slabs: [{}], rooms: [{ area: 18.2 }], pipes: [1, 2], beams: [1], objects: [{}, {}] };
  const env = {
    __pcTools: { viewer: () => viewer, getCloud: () => ({ pos, col: null, classification: labels, count: 300 }), getSourceCrs: () => viewer._srcCrs },
    __bimCurrentCloudPath: 'D:/scan/room.las',
    __viewer: viewer,
    __lxScan2BIM: { state: { model } },
    __lxObjectInspector: { state: { auto: { res: autoRes, busy: false } } },
    CloudInspectUI: { current: () => ({ fileName: 'room.las', project: 'Тест-проект', res, cmp: { walls: 3, matched: 2, mismatch: 1 }, dxfName: 'plan.dxf' }) },
    BimProjectState: { ready: Promise.resolve(), snapshot: () => ({ metadata: { projectName: 'Тест-проект' }, measurements: [{ label: 'Толщина стены', value: 0.2, unit: 'м' }, { label: 'Площадь пола', value: 32.5, unit: 'м²' }], documents: [{ name: 'ТЗ.pdf', status: 'ok' }, { name: 'СП 70.pdf', status: 'ok' }] }), projectId: 'prj-test', revision: 7 },
    __bimProjectName: 'Тест-проект',
    AutoMeasure: { analyze: (p, n) => { assert.ok(n > 0, 'analyze получил точки'); return autoRes; } }
  };
  return { env, viewer, sel, pos };
}

test('r169 контекст: облако/выделение/элемент/инспекция/модель/проект — собираются из состояния', () => {
  const { env } = fakeEnv();
  const pack = C.build(env);
  assert.equal(pack.schema, 'ai-context/1');
  assert.equal(pack.cloud.open, true);
  assert.equal(pack.cloud.name, 'room.las');
  assert.equal(pack.cloud.points, 300);
  assert.deepEqual(pack.cloud.bbox.size, [4, 2.8, 4]);
  assert.match(pack.cloud.crs, /32636/);
  assert.equal(pack.cloud.hasClassification, true);
  assert.equal(pack.selection.active, true);
  assert.equal(pack.selection.count, 10);
  assert.ok(pack.selection.bbox && pack.selection.bbox.size[0] >= 0);
  assert.ok(pack.selection.volume >= 0);
  assert.equal(pack.selection.dominantClass.code, 6);
  assert.equal(pack.selection.dominantClass.type, 'wall');
  assert.ok(pack.element, 'элемент из инспектора есть');
  assert.equal(pack.element.type, 'wall');
  assert.equal(pack.element.source, 'inspector-auto-measure');
  assert.ok(pack.element.dims.some((d) => d.key === 'thickness' && d.value === 0.2));
  assert.equal(pack.inspection.available, true);
  assert.equal(pack.inspection.summary.walls, 3);
  assert.equal(pack.inspection.summary.wallsOutOfTolerance, 2);
  assert.equal(pack.inspection.summary.defects, 2);
  assert.equal(pack.inspection.summary.rooms, 2);
  assert.equal(pack.inspection.summary.roomsArea, 32.5);
  assert.equal(pack.inspection.dxfName, 'plan.dxf');
  assert.ok(pack.checks.length >= 3, 'проверки собраны');
  assert.equal(pack.model.open, true);
  assert.equal(pack.model.walls, 2);
  assert.equal(pack.model.openings, 3);
  assert.equal(pack.model.rooms, 1);
  assert.equal(pack.project.name, 'Тест-проект');
  assert.equal(pack.project.revision, 7);
  assert.deepEqual(pack.documents.projectDocs.map((d) => d.name), ['ТЗ.pdf', 'СП 70.pdf']);
  assert.equal(pack.measurements.length, 2);
  assert.equal(pack.capabilities.cloud, true);
  assert.equal(pack.capabilities.element, true);
  assert.equal(pack.capabilities.model, true);
});

test('r169 контекст: промпт-блок содержит факты и правило «не выдумывай», компактный JSON — без лишнего', () => {
  const { env } = fakeEnv();
  const pack = C.build(env);
  const block = C.toPromptBlock(pack);
  assert.match(block, /СЕЙЧАС В ПРИЛОЖЕНИИ/);
  assert.match(block, /room\.las/);
  assert.match(block, /300/);
  assert.match(block, /габариты/);
  assert.match(block, /распознанный элемент: Стена/);
  assert.match(block, /толщина|Толщина/);
  assert.match(block, /контроль геометрии/);
  assert.match(block, /BIM-модель/);
  assert.match(block, /Тест-проект/);
  assert.match(block, /не выдумывай|не подменяй отсутствующие факты/i);
  const comp = C.compact(pack);
  assert.equal(comp.schema, 'ai-context/1');
  assert.equal(comp.cloud.points, 300);
  assert.equal(comp.element.type, 'wall');
  assert.ok(JSON.stringify(comp).length < 2000, 'компактный контекст не раздувает запрос');
});

test('r169 контекст: классификация выделения через AutoMeasure (результат классификатора phase4)', () => {
  const { env } = fakeEnv();
  const el = C.analyzeSelection(env);
  assert.ok(el);
  assert.equal(el.type, 'wall');
  assert.equal(el.source, 'auto-measure-selection');
  assert.equal(el.selectionCount, 10);
  assert.equal(el.dims.length, 3);
  assert.equal(el.confidence, 0.91);
  // если AutoMeasure нет — fallback на метки классов облака
  const env2 = fakeEnv(); delete env2.env.AutoMeasure;
  const el2 = C.analyzeSelection(env2.env);
  assert.ok(el2);
  assert.equal(el2.source, 'cloud-classifier');
  assert.match(el2.title, /стены|крыша/i);
});

test('r169 контекст: без данных — честные null/пусто, никаких выдуманных цифр', () => {
  const pack = C.build({});
  assert.equal(pack.cloud.open, false);
  assert.equal(pack.selection.active, false);
  assert.equal(pack.element, null);
  assert.equal(pack.inspection.available, false);
  assert.equal(pack.model.open, false);
  assert.equal(pack.project.name, null);
  assert.deepEqual(pack.measurements, []);
  assert.deepEqual(pack.documents.projectDocs, []);
  const block = C.toPromptBlock(pack);
  assert.match(block, /облако: не открыто/);
  assert.match(block, /не выдумывай|не подменяй/i);
  assert.doesNotMatch(block, /\d+ точек/, 'нет выдуманного количества точек');
});

test('r169 контекст: элемент из ElementIdentify и нормализация размеров', () => {
  const el = C.elementFromIdentify({ ok: true, kind: 'wall', title: 'Стена', dims: [{ key: 'thickness', label: 'Толщина', value: 0.2, unit: 'м', text: '200 мм' }, { key: 'openings', label: 'Проёмы', value: { list: [1] }, text: '1' }], checks: [{ label: 'СП 70', ok: true }], queries: ['толщина стены'] });
  assert.equal(el.type, 'wall');
  assert.equal(el.dims[0].value, 0.2);
  assert.equal(el.checks[0].ok, true);
  assert.equal(el.source, 'element-identify');
  const el2 = C.elementFromAuto({ ok: true, main: { title: 'Труба', family: 'pipe', dims: [{ key: 'diameter', label: 'Диаметр', value: 0.108, unit: 'м', text: 'Ø108 мм' }] } });
  assert.equal(el2.type, 'pipe');
  assert.equal(el2.dims[0].text, 'Ø108 мм');
  // ElementIdentify с generic kind='object', но осмысленным title — тип уточняется по названию
  const el3 = C.elementFromIdentify({ ok: true, kind: 'object', title: 'Стена · 2,27 м × 1,48 м', dims: [] });
  assert.equal(el3.type, 'wall');
});
