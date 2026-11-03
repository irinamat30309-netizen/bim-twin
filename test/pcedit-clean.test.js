'use strict';
const test = require('node:test');
const assert = require('node:assert');
const PC = require('../renderer/pointcloud-edit.js');

// Детерминированный ГПСЧ для воспроизводимости.
let _seed = 12345;
function rnd() { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; }

// Плоская сетка в XZ с лёгким шумом (как у реального скана поверхности).
function gridXZ(nx, nz, step, y, jit) {
  jit = jit || 0;
  const pos = [];
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    pos.push(i * step + (rnd() - 0.5) * jit, y + (rnd() - 0.5) * jit, k * step + (rnd() - 0.5) * jit);
  }
  return pos;
}

test('cleanAuto: одним вызовом убирает шум+кластеры, сохраняет основную структуру', () => {
  _seed = 7;
  const step = 0.05;
  const floor = gridXZ(60, 60, step, 0, step * 0.12); // 3600 плотных точек в плоскости y=0
  const pos = floor.slice();
  // отсоединённый маленький кластер вдали (мусор)
  for (let i = 0; i < 40; i++) pos.push(10 + (i % 5) * step, 5, ((i / 5) | 0) * step);
  // разрозненный шум в воздухе
  for (let i = 0; i < 400; i++) pos.push(rnd() * 3, rnd() * 2.6 + 0.4, rnd() * 3);
  const cloud = { pos: new Float32Array(pos), col: null };
  const before = cloud.pos.length / 3;
  // voxel = step*3 — так же, как cleanAutoInApp передаёт spacing*3 в реальном приложении.
  const r = PC.cleanAuto(cloud, { voxel: step * 3 });
  assert.ok(r.removed > 0, 'должно что-то удалить');
  assert.strictEqual(r.removedPos.length / 3, r.removed, 'removedPos совпадает с removed');
  const after = r.pos.length / 3;
  assert.strictEqual(before - after, r.removed, 'баланс точек сходится');
  // плотный пол в основном сохранён (не выедаем поверхность)
  assert.ok(after >= 3600 * 0.85, 'плотный пол в основном сохранён, осталось ' + after);
  // шум и отсоединённый кластер убраны почти полностью
  assert.ok(r.removed >= 400, 'убрано не меньше шума+кластера: ' + r.removed);
  assert.ok(r.passes >= 1 && r.passes <= 5, 'разумное число проходов: ' + r.passes);
  assert.ok(r.breakdown && (r.breakdown.sor + r.breakdown.density + r.breakdown.clusters) === r.removed, 'разбивка сходится');
});

test('cleanAuto: цвета удалённых точек сохраняются корректно (для отмены)', () => {
  _seed = 99;
  const step = 0.05;
  const floor = gridXZ(40, 40, step, 0, step * 0.12);
  const pos = floor.slice();
  for (let i = 0; i < 200; i++) pos.push(rnd() * 3, rnd() * 3 + 1, rnd() * 3);
  const n = pos.length / 3;
  const col = new Uint8Array(n * 3); for (let i = 0; i < n * 3; i++) col[i] = (i * 37) & 255;
  const r = PC.cleanAuto({ pos: new Float32Array(pos), col }, { voxel: step * 3 });
  if (r.removed > 0) assert.strictEqual(r.removedCol.length, r.removedPos.length, 'цвет и позиции удалённых совпадают по длине');
});

test('cleanAuto: повторная обработка одного входа даёт идентичный бинарный результат', () => {
  const pos = [], colors = [];
  for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) {
    pos.push(x * 0.05, 0.001 * ((x + z) % 3), z * 0.05);
    colors.push((x * 7) & 255, (z * 11) & 255, ((x + z) * 13) & 255);
  }
  for (let i = 0; i < 80; i++) {
    pos.push(5 + i * 0.17, 1 + (i % 7) * 0.31, -4 - i * 0.11);
    colors.push((i * 3) & 255, (i * 5) & 255, (i * 9) & 255);
  }
  const input = { pos: new Float32Array(pos), col: new Uint8Array(colors) };
  const a = PC.cleanAuto(input, { voxel: 0.15 });
  const b = PC.cleanAuto(input, { voxel: 0.15 });
  assert.deepStrictEqual(a.pos, b.pos);
  assert.deepStrictEqual(a.col, b.col);
  assert.deepStrictEqual(a.removedPos, b.removedPos);
  assert.deepStrictEqual(a.removedCol, b.removedCol);
  assert.deepStrictEqual(a.breakdown, b.breakdown);
});

test('fillPlaneHoles: латает прямоугольную дыру на плоскости', () => {
  const step = 0.05;
  const N = 40;
  const pos = [];
  // дыра совпадает со следом удалённого человека (17..23), вокруг — целый пол
  for (let i = 0; i < N; i++) for (let k = 0; k < N; k++) {
    if (i >= 17 && i < 23 && k >= 17 && k < 23) continue; // дыра 6x6 в центре
    pos.push(i * step, 0, k * step);
  }
  const cloud = { pos: new Float32Array(pos), col: null };
  const planes = [{ normal: [0, 1, 0], d: 0, tol: step * 2, axis: 'floor/ceiling', count: pos.length / 3 }];
  // «человек» — колонна точек над дырой (силуэт проецируется на пол)
  const rem = [];
  for (let h = 0; h < 24; h++) for (let i = 17; i < 23; i++) for (let k = 17; k < 23; k++) rem.push(i * step, 0.02 + h * step, k * step);
  const removedPos = new Float32Array(rem);
  const r = PC.fillPlaneHoles(cloud, planes, removedPos, { step });
  assert.ok(r.added > 0, 'должны добавиться точки-заплатки, добавлено ' + r.added);
  for (let i = 0; i < r.added; i++) assert.ok(Math.abs(r.addedPos[i * 3 + 1]) < 1e-4, 'заплатка лежит на плоскости y≈0');
  for (let i = 0; i < r.added; i++) {
    const x = r.addedPos[i * 3], z = r.addedPos[i * 3 + 2];
    assert.ok(x >= 15 * step - 1e-6 && x <= 24 * step + 1e-6, 'x в области дыры: ' + x);
    assert.ok(z >= 15 * step - 1e-6 && z <= 24 * step + 1e-6, 'z в области дыры: ' + z);
  }
});

test('fillPlaneHoles: без плоскостей ничего не добавляет', () => {
  const r = PC.fillPlaneHoles({ pos: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), col: null }, [], new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), {});
  assert.strictEqual(r.added, 0);
});

test('protectPlanes: стена сохраняется, к удалению остаются только точки человека', () => {
  const step = 0.05; const N = 40;
  // стена в плоскости x=0 (normal [1,0,0], d=0)
  const pos = [];
  for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) pos.push(0, j * step, k * step);
  // человек перед стеной (x > tol, dx=3..8 → x=0.15..0.4, tol=0.1)
  const person = [];
  for (let j = 16; j < 24; j++) for (let k = 16; k < 24; k++) for (let dx = 3; dx <= 8; dx++) person.push(dx * step, j * step, k * step);
  const personCount = person.length / 3; // 8*8*6 = 384
  const planes = [{ normal: [1, 0, 0], d: 0, tol: step * 2, axis: 'wall', count: pos.length / 3 }];
  const allPos = new Float32Array(pos.concat(person));
  const sel = []; for (let i = 0; i < allPos.length / 3; i++) sel.push(i); // выбрали всё в контуре (насквозь)
  const kept = PC.protectPlanes(sel, allPos, planes, step * 2); // индексы к удалению после защиты
  assert.strictEqual(kept.length, personCount, 'к удалению — ровно точки человека: ' + kept.length);
  for (const idx of kept) assert.ok(allPos[idx * 3] > step * 0.5, 'удаляемые точки — вне плоскости стены');
});
