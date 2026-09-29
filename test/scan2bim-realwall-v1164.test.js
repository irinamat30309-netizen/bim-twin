'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const S = require(path.join(__dirname, '..', 'renderer', 'scan2bim.js'));

// Регрессия v1164 (по реальному скану _1.ply): длинный узкий зал, где ДАЛЬНЯЯ (западная) стена
// недосканирована (редкие точки), а внутри есть более плотная ложная плоскость. Раньше стена
// «уезжала» внутрь и получалась диагональ. Теперь: выравнивание по сетке + притяжка к контуру.
// Конвенция: Y — вверх, план = (X, Z). Зал W(=X)=3, L(=Z)=27, H=4.
function sceneLongHall() {
  let s = 7 >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const jit = a => (rnd() - 0.5) * a;
  const pts = []; const W = 3, L = 27, H = 4;
  // ВОСТОЧНАЯ стена x=0 — плотная
  for (let j = 0; j <= 540; j++) for (let k = 0; k <= 40; k++) { const z = (j / 540) * L, y = (k / 40) * H; pts.push([0, y, z]); }
  // ЗАПАДНАЯ стена x=W — РЕДКАЯ (недосканирована): низкий шаг
  for (let j = 0; j <= 60; j++) for (let k = 0; k <= 8; k++) { const z = (j / 60) * L, y = (k / 8) * H; pts.push([W + jit(0.01), y, z]); }
  // ЛОЖНАЯ плотная плоскость внутри при x=W-1.2
  for (let j = 0; j <= 540; j++) for (let k = 0; k <= 40; k++) { const z = (j / 540) * L, y = (k / 40) * H; pts.push([W - 1.2 + jit(0.01), y, z]); }
  // торцы z=0 и z=L
  for (let i = 0; i <= 60; i++) for (let k = 0; k <= 40; k++) { const x = (i / 60) * W, y = (k / 40) * H; pts.push([x, y, 0]); pts.push([x, y, L]); }
  // пол и потолок
  for (let i = 0; i <= 60; i++) for (let j = 0; j <= 540; j++) { const x = (i / 60) * W, z = (j / 540) * L; pts.push([x, 0, z]); pts.push([x, H, z]); }
  return pts;
}

test('v1164: высота и площадь длинного зала верны', () => {
  const m = S.reconstruct(sceneLongHall(), {});
  assert.ok(m.ok, 'реконструкция провалилась');
  assert.ok(Math.abs(m.storey.height - 4) < 0.25, 'высота ~4м, получено ' + m.storey.height);
  assert.ok(Math.abs(m.stats.floorArea - 81) < 12, 'площадь ~81м², получено ' + m.stats.floorArea);
});

test('v1164: западная (недосканированная) стена стоит на границе, а не внутри', () => {
  const m = S.reconstruct(sceneLongHall(), {});
  // ищем длинную стену вдоль Z с midX около 3.0 (истинная западная граница)
  const long = (m.walls || []).filter(w => w.length > 10);
  const midX = long.map(w => (w.a[0] + w.b[0]) / 2);
  const hasWest = midX.some(x => Math.abs(x - 3.0) < 0.4);
  const hasEast = midX.some(x => Math.abs(x - 0.0) < 0.4);
  assert.ok(hasEast, 'нет восточной длинной стены (x~0): ' + JSON.stringify(midX.map(v => +v.toFixed(2))));
  assert.ok(hasWest, 'западная длинная стена не на границе x~3, midX=' + JSON.stringify(midX.map(v => +v.toFixed(2))));
});

test('v1164: все стены выровнены к сетке (0/90°)', () => {
  const m = S.reconstruct(sceneLongHall(), {});
  for (const w of (m.walls || [])) {
    const a = ((w.angleDeg % 180) + 180) % 180; // 0..180
    const d0 = Math.min(a, 180 - a);      // близость к 0/180
    const d90 = Math.abs(a - 90);          // близость к 90
    assert.ok(Math.min(d0, d90) < 8, 'стена не по сетке, угол=' + w.angleDeg.toFixed(1));
  }
});
