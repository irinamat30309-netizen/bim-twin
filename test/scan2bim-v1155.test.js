'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const S = require(path.join(R, 'scan2bim.js'));
const UI = fs.readFileSync(path.join(R, 'lixel-scan2bim-ui.js'), 'utf8');
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(R, 'app.js'), 'utf8');

// Синтетическая комната 6×4 м, высота 3 м (Y вверх). Точки на 4 стенах + пол + потолок.
function room(seed) {
  let s = (seed || 7) >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const jit = (a) => (rnd() - 0.5) * a;
  const W = 6, D = 4, H = 3, pts = [];
  for (let i = 0; i <= 60; i++) for (let k = 0; k <= 30; k++) {
    const x = (i / 60) * W, y = (k / 30) * H;
    pts.push([x + jit(0.01), y, 0 + jit(0.01)]);        // стена z=0
    pts.push([x + jit(0.01), y, D + jit(0.01)]);        // стена z=D
  }
  for (let j = 0; j <= 40; j++) for (let k = 0; k <= 30; k++) {
    const z = (j / 40) * D, y = (k / 30) * H;
    pts.push([0 + jit(0.01), y, z + jit(0.01)]);        // стена x=0
    pts.push([W + jit(0.01), y, z + jit(0.01)]);        // стена x=W
  }
  for (let i = 0; i <= 60; i++) for (let j = 0; j <= 40; j++) {
    const x = (i / 60) * W, z = (j / 40) * D;
    pts.push([x, 0 + jit(0.01), z]);                     // пол
    pts.push([x, H + jit(0.01), z]);                     // потолок
  }
  return pts;
}

test('reconstruct: находит уровни и высоту этажа', () => {
  const m = S.reconstruct(room(), { voxel: 0.05, wallThreshold: 0.06 });
  assert.ok(m.ok, 'реконструкция не удалась: ' + (m.error || ''));
  assert.ok(Math.abs(m.storey.height - 3) < 0.25, 'высота неверна: ' + m.storey.height);
  assert.ok(m.storey.floorY < 0.2 && m.storey.ceilY > 2.8, 'уровни пола/потолка неверны');
});

test('reconstruct: строит стены и плиты, площадь около 24 м²', () => {
  const m = S.reconstruct(room(), { voxel: 0.05, wallThreshold: 0.06 });
  assert.ok(m.walls.length >= 3, 'мало стен: ' + m.walls.length);
  assert.ok(m.slabs.length === 2, 'нет плит пола/потолка');
  assert.ok(m.stats.floorArea > 18 && m.stats.floorArea < 30, 'площадь пола неверна: ' + m.stats.floorArea);
  assert.ok(m.stats.totalWallLength > 12, 'суммарная длина стен мала');
  m.walls.forEach((w) => { assert.ok(w.thickness > 0 && w.thickness <= 0.6, 'толщина вне диапазона'); assert.ok(w.height > 0, 'нулевая высота'); });
});

test('reconstruct: детерминирован (одинаковый вход → одинаковый выход)', () => {
  const a = S.reconstruct(room(), { voxel: 0.05 }), b = S.reconstruct(room(), { voxel: 0.05 });
  assert.strictEqual(a.walls.length, b.walls.length, 'недетерминировано');
  assert.ok(Math.abs(a.stats.totalWallLength - b.stats.totalWallLength) < 1e-6, 'разные длины между запусками');
});

test('reconstruct: мало точек → ошибка', () => {
  const m = S.reconstruct([[0, 0, 0], [1, 1, 1]], {});
  assert.ok(!m.ok && m.error, 'должна быть ошибка');
});

test('voxelDownsample сокращает точки', () => {
  const dense = []; for (let i = 0; i < 1000; i++) dense.push([Math.random() * 0.05, Math.random() * 0.05, Math.random() * 0.05]);
  const out = S.voxelDownsample(dense, 0.1);
  assert.ok(out.length < dense.length, 'прореживание не сработало');
});

test('toIFC: валидный IFC4 STEP со стенами и плитами', () => {
  const m = S.reconstruct(room(), { voxel: 0.05, wallThreshold: 0.06 });
  const ifc = S.toIFC(m, { name: 'test.ifc' });
  assert.ok(ifc.includes('ISO-10303-21'), 'нет заголовка STEP');
  assert.ok(ifc.includes("FILE_SCHEMA(('IFC4'))"), 'не IFC4');
  assert.ok(ifc.includes('IFCPROJECT'), 'нет IFCPROJECT');
  assert.ok(ifc.includes('IFCBUILDINGSTOREY'), 'нет этажа');
  assert.ok(ifc.includes('IFCWALLSTANDARDCASE'), 'нет стен');
  assert.ok(ifc.includes('IFCSLAB'), 'нет плит');
  assert.ok(ifc.includes('IFCEXTRUDEDAREASOLID'), 'нет тел экструзии');
  assert.ok(ifc.includes('IFCRELCONTAINEDINSPATIALSTRUCTURE'), 'элементы не привязаны к этажу');
  assert.ok(ifc.trim().endsWith('END-ISO-10303-21;'), 'файл не завершён');
});

test('toOBJ / toDXF: генерируют геометрию', () => {
  const m = S.reconstruct(room(), { voxel: 0.05 });
  const obj = S.toOBJ(m);
  assert.ok(/\nv /.test('\n' + obj) && /\nf /.test('\n' + obj), 'OBJ без вершин/граней');
  const dxf = S.toDXF(m);
  assert.ok(dxf.includes('LINE') && dxf.includes('EOF'), 'DXF некорректен');
});

test('toIFC: GlobalId соответствует спецификации buildingSMART (IFC4)', () => {
  // Спека: "the first character must be either a 0, 1, 2, or 3" — раньше
  // это не проверялось, а младшие биты используемого LCG почти не менялись,
  // из-за чего >90% символов сгенерированных GUID вырождались в '0'.
  const m = S.reconstruct(room(), { voxel: 0.05 });
  const ifc = S.toIFC(m, { name: 'test.ifc' });
  const guids = [...ifc.matchAll(/'([0-9A-Za-z_$]{22})'/g)].map(x => x[1]);
  assert.ok(guids.length >= 5, 'слишком мало GUID найдено для проверки: ' + guids.length);
  for (const g of guids) {
    assert.ok('0123'.includes(g[0]), 'первый символ GUID не 0/1/2/3: ' + g);
    const zeros = (g.match(/0/g) || []).length;
    assert.ok(zeros <= 10, 'GUID вырожден (слишком много нулей): ' + g);
  }
  assert.strictEqual(new Set(guids).size, guids.length, 'есть повторяющиеся GUID в одном файле');
});

test('UI + регистрация v1155', () => {
  assert.ok(UI.includes('__lxScan2BIM'), 'нет публичного API UI');
  assert.ok(UI.includes('Scan2BIM.reconstruct'), 'UI не вызывает движок');
  assert.ok(UI.includes("id = 'lxScan2BimBtn'") || UI.includes('lxScan2BimBtn'), 'нет кнопки запуска');
  assert.ok(UI.includes('_setOverlay'), 'нет предпросмотра накладкой');
  assert.ok(UI.includes("exportModel('ifc')"), 'нет экспорта IFC');
  assert.ok(HTML.includes('scan2bim.js?v=1231'), 'движок не подключён или кеш-ключ устарел');
  assert.ok(HTML.includes('lixel-scan2bim-ui.js?v=1220'), 'UI не подключён');
  assert.ok(APP.includes('готова · v1160'), 'баннер не v1155');
});
