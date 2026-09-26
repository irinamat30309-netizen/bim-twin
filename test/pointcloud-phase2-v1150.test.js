'use strict';
// Phase 2 (v1150) регресс: паритет риббонов LixelStudio.
// PCEdit: mergeClouds/smoothMLS/dominantPlane/levelCloud/closedVolume/compareVolumes.
// LxGeom2D: arc/segIntersect/extend/split/door/window/copy/ransac.
// Наличие новых модулей и регистрация скриптов + мост __pcTools.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', 'renderer');
const PCEdit = require(path.join(R, 'pointcloud-edit.js'));
const G = require(path.join(R, 'lixel-geom2d.js'));

function gridFloor(nx, nz, s, upAxis) {
  const n = nx * nz; const pos = new Float32Array(n * 3); let o = 0;
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    const a = i * s, b = k * s, h = 0.0001 * Math.sin(i + k);
    if (upAxis === 1) { pos[o++] = a; pos[o++] = h; pos[o++] = b; }
    else { pos[o++] = a; pos[o++] = b; pos[o++] = h; }
  }
  return { pos, col: null, count: n };
}
function solidBox(g, s) {
  const pos = new Float32Array(g * g * g * 3); let o = 0;
  for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) for (let k = 0; k < g; k++) { pos[o++] = i * s; pos[o++] = j * s; pos[o++] = k * s; }
  return { pos, count: g * g * g };
}

test('PCEdit экспортирует 6 новых функций риббонов', () => {
  ['mergeClouds', 'smoothMLS', 'dominantPlane', 'levelCloud', 'closedVolume', 'compareVolumes'].forEach(fn => {
    assert.strictEqual(typeof PCEdit[fn], 'function', fn + ' должен экспортироваться');
  });
});

test('mergeClouds объединяет точки двух облаков', () => {
  const a = solidBox(4, 0.1), b = solidBox(3, 0.1);
  const r = PCEdit.mergeClouds([a, b]);
  assert.strictEqual(r.count, a.count + b.count);
  assert.strictEqual(r.clouds, 2);
  assert.strictEqual(r.pos.length, r.count * 3);
});

test('smoothMLS смещает точки и сохраняет количество', () => {
  const c = gridFloor(20, 20, 0.05, 2);
  for (let i = 0; i < c.count; i++) c.pos[i * 3 + 2] += (Math.random() - 0.5) * 0.02;
  const r = PCEdit.smoothMLS(c, { strength: 0.7 });
  assert.strictEqual(r.count, c.count);
  assert.ok(r.moved >= 0 && r.moved <= r.count);
});

test('levelCloud выравнивает наклонённый пол — Z-up', () => {
  const c = gridFloor(30, 30, 0.05, 2); const ang = 9 * Math.PI / 180, cs = Math.cos(ang), sn = Math.sin(ang);
  for (let i = 0; i < c.count; i++) { const y = c.pos[i * 3 + 1], z = c.pos[i * 3 + 2]; c.pos[i * 3 + 1] = y * cs - z * sn; c.pos[i * 3 + 2] = y * sn + z * cs; }
  const r = PCEdit.levelCloud(c, { up: [0, 0, 1], orientation: 'floor' });
  assert.ok(r.applied, 'выравнивание применено');
  assert.ok(Math.abs(r.angleDeg - 9) < 1.5, 'угол ~9°, получено ' + r.angleDeg.toFixed(2));
});

test('levelCloud выравнивает наклонённый пол — Y-up (координаты вьюера)', () => {
  const c = gridFloor(30, 30, 0.05, 1); const ang = 7 * Math.PI / 180, cs = Math.cos(ang), sn = Math.sin(ang);
  for (let i = 0; i < c.count; i++) { const y = c.pos[i * 3 + 1], z = c.pos[i * 3 + 2]; c.pos[i * 3 + 1] = y * cs - z * sn; c.pos[i * 3 + 2] = y * sn + z * cs; }
  const r = PCEdit.levelCloud(c, { up: [0, 1, 0], orientation: 'floor' });
  assert.ok(r.applied, 'Y-up выравнивание применено');
  assert.ok(Math.abs(r.angleDeg - 7) < 1.5, 'Y-up угол ~7°, получено ' + r.angleDeg.toFixed(2));
});

test('closedVolume считает объём плотного куба (up=Y и up=Z совпадают)', () => {
  const b = solidBox(8, 0.1);
  const vy = PCEdit.closedVolume(b, { up: 1 }), vz = PCEdit.closedVolume(b, { up: 2 });
  assert.ok(vy.volume > 0 && vz.volume > 0);
  assert.ok(Math.abs(vy.volume - vz.volume) < 1e-6, 'объём не зависит от оси для куба');
});

test('compareVolumes: поднятый пол даёт положительную насыпь', () => {
  const a = gridFloor(30, 30, 0.1, 1);
  const b = gridFloor(30, 30, 0.1, 1);
  for (let i = 0; i < b.count; i++) b.pos[i * 3 + 1] += 0.5; // подняли на 0.5 м
  const r = PCEdit.compareVolumes(a, b, { up: 1 });
  assert.ok(r.fill > 0, 'насыпь > 0');
  assert.ok(r.net > 0, 'баланс > 0');
});

test('LxGeom2D экспортирует все функции черчения', () => {
  ['arcFrom3Points', 'segIntersect', 'extendSegment', 'splitPolyline', 'copyEntity', 'doorSymbol', 'windowSymbol', 'polygonArea', 'ransacLines'].forEach(fn => {
    assert.strictEqual(typeof G[fn], 'function', fn + ' должен экспортироваться');
  });
});

test('arcFrom3Points строит дугу единичного радиуса', () => {
  const arc = G.arcFrom3Points([0, 1], [1, 0], [0, -1], { segments: 32 });
  assert.ok(arc && Math.abs(arc.radius - 1) < 1e-6, 'R=1');
  assert.ok(Math.abs(arc.center[0]) < 1e-6 && Math.abs(arc.center[1]) < 1e-6, 'центр в (0,0)');
  assert.strictEqual(arc.points.length, 33);
});

test('arcFrom3Points возвращает null для коллинеарных точек', () => {
  assert.strictEqual(G.arcFrom3Points([0, 0], [1, 0], [2, 0], {}), null);
});

test('segIntersect находит пересечение и уважает infinite', () => {
  assert.deepStrictEqual(G.segIntersect([0, 0], [2, 0], [1, -1], [1, 1], {}), [1, 0]);
  assert.strictEqual(G.segIntersect([0, 0], [1, 0], [2, -1], [2, 1], { infinite: false }), null);
  assert.deepStrictEqual(G.segIntersect([0, 0], [1, 0], [2, -1], [2, 1], { infinite: true }), [2, 0]);
});

test('splitPolyline делит на две части по индексу', () => {
  const parts = G.splitPolyline([[0, 0], [1, 0], [2, 0], [3, 0]], 2);
  assert.strictEqual(parts[0].length, 3);
  assert.strictEqual(parts[1].length, 2);
});

test('doorSymbol/windowSymbol возвращают геометрию проёма', () => {
  const d = G.doorSymbol([0, 0], [1, 0], { hinge: 'start', swing: 'ccw', segments: 16 });
  assert.ok(Math.abs(d.width - 1) < 1e-9);
  assert.ok(Array.isArray(d.swing) && d.swing.length >= 2, 'дуга открывания есть');
  const w = G.windowSymbol([0, 0], [2, 0], {});
  assert.ok(w.thickness > 0 && Array.isArray(w.side1) && Array.isArray(w.side2));
});

test('ransacLines находит две прямые стены', () => {
  const pts = [];
  for (let i = 0; i <= 40; i++) pts.push([i * 0.1, 0]);
  for (let i = 0; i <= 40; i++) pts.push([i * 0.1, 3]);
  const lines = G.ransacLines(pts, { tol: 0.05, minInliers: 10, iters: 400, maxLines: 6, seed: 1 });
  assert.ok(lines.length >= 2, 'найдено ≥2 прямых, получено ' + lines.length);
});

test('index.html регистрирует новые скрипты v1150', () => {
  const html = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
  assert.ok(/lixel-geom2d\.js\?v=1150/.test(html), 'lixel-geom2d подключён');
  assert.ok(/lixel-tools-ext\.js\?v=1152/.test(html), 'lixel-tools-ext подключён');
  assert.ok(/lixel-draw-ext\.js\?v=1150/.test(html), 'lixel-draw-ext подключён');
  assert.ok(/app\.js\?v=1249/.test(html), 'app.js cache-bust bumped after cloud-import/UI changes');
  assert.ok(/pointcloud-edit\.js\?v=1150/.test(html), 'pointcloud-edit.js обновлён до 1150');
});

test('app.js содержит мост __pcTools и баннер v1150', () => {
  const src = fs.readFileSync(path.join(R, 'app.js'), 'utf8');
  assert.ok(/window\.__pcTools\s*=/.test(src), 'мост __pcTools есть');
  assert.ok(/lx-pctools-ready/.test(src), 'событие lx-pctools-ready диспатчится');
  assert.ok(/v1150/.test(src), 'баннер v1150');
});

test('lixel-tools-ext.js и lixel-draw-ext.js валидны и содержат API', () => {
  const te = fs.readFileSync(path.join(R, 'lixel-tools-ext.js'), 'utf8');
  assert.ok(/window\.__lxToolsExt/.test(te), '__lxToolsExt экспорт');
  assert.ok(/opClosedVolume|opVolume|opMesh/.test(te), 'операции приложения');
  const de = fs.readFileSync(path.join(R, 'lixel-draw-ext.js'), 'utf8');
  assert.ok(/window\.__lxDrawExt/.test(de), '__lxDrawExt экспорт');
  assert.ok(/doAIExtract/.test(de), 'AI-извлечение есть');
});
