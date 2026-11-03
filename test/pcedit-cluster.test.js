'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../renderer/pointcloud-edit.js');

// Строим синтетическую сцену: ПЕРЕДНЯЯ плоскость (4x4, z≈0, ближе к камере)
// и ФОНОВАЯ стена (4x4, z≈-2, дальше) прямо позади, те же экранные xy.
// clusterFront должен оставить только переднюю поверхность и отбросить фон.
function buildScene() {
  const pos = [];
  const depth = [];
  const front = [];
  const back = [];
  let n = 0;
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
    const x = a * 0.2, y = b * 0.2;
    // передняя точка (2 слоя очень близко, чтобы связность внутри объекта была надёжной)
    for (const zf of [0.0, 0.05]) {
      pos.push(x, y, zf); depth.push(10 - zf); front.push(n); n++;
    }
    // фоновая точка (пространственный зазор 2 м)
    for (const zb of [-2.0, -1.95]) {
      pos.push(x, y, zb); depth.push(10 - zb); back.push(n); n++;
    }
  }
  return { pos: new Float32Array(pos), depth: new Float32Array(depth), front, back, count: n };
}

test('clusterFront: отбрасывает оторванный фон, оставляет передний кластер', () => {
  const s = buildScene();
  const all = [];
  for (let i = 0; i < s.count; i++) all.push(i);
  const kept = E.clusterFront(s.pos, all, { depth: s.depth, voxel: 0.3, band: 0.5 });
  const keptSet = new Set(kept);
  // все передние — на месте
  for (const i of s.front) assert.ok(keptSet.has(i), 'передняя точка ' + i + ' должна остаться');
  // ни одной фоновой
  for (const i of s.back) assert.ok(!keptSet.has(i), 'фоновая точка ' + i + ' должна быть отброшена');
  assert.strictEqual(kept.length, s.front.length);
});

test('clusterFront: единый связный кластер сохраняется целиком', () => {
  const s = buildScene();
  // только передние точки — один объект, ничего убирать не нужно
  const kept = E.clusterFront(s.pos, s.front.slice(), { depth: s.depth, voxel: 0.3, band: 0.5 });
  assert.strictEqual(kept.length, s.front.length);
});

test('clusterFront: короткая выборка (< minCount) возвращается как есть', () => {
  const s = buildScene();
  const few = s.front.slice(0, 5);
  const kept = E.clusterFront(s.pos, few, { depth: s.depth, voxel: 0.3, band: 0.5 });
  assert.deepStrictEqual(kept, few);
});

test('clusterFront: без глубины оставляет крупнейший связный кластер', () => {
  const s = buildScene();
  // сделаем фон крупнее переднего, но без depth → останется крупнейший (фон)
  const all = [];
  for (let i = 0; i < s.count; i++) all.push(i);
  const kept = E.clusterFront(s.pos, all, { voxel: 0.3 });
  // ровно один из двух равных по размеру кластеров (front/back по 32) — длина 32
  assert.strictEqual(kept.length, 32);
});

test('cleanClusters: removes small detached blob, keeps main structure', () => {
  // \u0413\u043b\u0430\u0432\u043d\u044b\u0439 \u043a\u043b\u0430\u0441\u0442\u0435\u0440: \u043f\u043b\u043e\u0442\u043d\u0430\u044f \u0441\u0435\u0442\u043a\u0430 10x10 \u0443 \u043d\u0430\u0447\u0430\u043b\u0430 (100 \u0442\u043e\u0447\u0435\u043a).
  const pts = [];
  for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) pts.push(x * 0.1, y * 0.1, 0);
  // \u041e\u0442\u0441\u043e\u0435\u0434\u0438\u043d\u0451\u043d\u043d\u044b\u0439 \u043c\u0430\u043b\u0435\u043d\u044c\u043a\u0438\u0439 \u0431\u043b\u043e\u0431 \u0434\u0430\u043b\u0435\u043a\u043e (3 \u0442\u043e\u0447\u043a\u0438).
  pts.push(100, 100, 100, 100.02, 100, 100, 100, 100.02, 100);
  const pos = new Float32Array(pts);
  const r = E.cleanClusters({ pos, col: null }, { voxel: 0.15, minClusterPts: 10 });
  assert.strictEqual(r.removed, 3);
  assert.strictEqual(r.pos.length / 3, 100);
  assert.strictEqual(r.removedPos.length / 3, 3);
});

test('cleanClusters: no-op when everything is connected', () => {
  const pts = [];
  for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) pts.push(x * 0.1, y * 0.1, 0);
  const pos = new Float32Array(pts);
  const r = E.cleanClusters({ pos, col: null }, { voxel: 0.15, minClusterPts: 10 });
  assert.strictEqual(r.removed, 0);
});
