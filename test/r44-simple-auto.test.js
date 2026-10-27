'use strict';
// Ревизия 44: простые окна (1–2 главных выбора, остальное — «Настроить», по умолчанию авто) и бережная очистка:
// редкие дальние стены, провода, шланги на полу остаются, туман и пыль уходят (проверено на облаке пользователя).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = require('../scan-refine-core.js');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

/** Сцена: плотный пол (1 см), редкая дальняя стена (8 см), редкий провод (3 см), туман в объёме. */
function scene() {
  const r = rng(44), P = [], tag = [];
  const add = (x, y, z, t) => { P.push(x, y, z); tag.push(t); };
  for (let x = 0; x < 4; x += 0.01) for (let y = 0; y < 4; y += 0.01) add(x, y, 0.002 * gauss(r), 0);
  for (let y = 0; y < 4; y += 0.08) for (let z = 0.1; z < 2.5; z += 0.08) add(6 + 0.004 * gauss(r), y + 0.01 * r(), z + 0.01 * r(), 1);
  for (let t = 0; t < 1; t += 0.03 / 5.7) add(0.3 + 3.4 * t + 0.002 * gauss(r), 0.3 + 3.4 * t + 0.002 * gauss(r), 2 + 0.5 * t, 2);
  for (let k = 0; k < 3000; k++) add(4 * r(), 4 * r(), 0.4 + 1.2 * r(), 3);
  return { X: new Float64Array(P), tag: new Uint8Array(tag), n: tag.length };
}
const kept = (S, alive, t) => { let a = 0, b = 0; for (let i = 0; i < S.n; i++) if (S.tag[i] === t) { a++; if (alive[i]) b++; } return b / a; };

test('очистка «сильно»: редкая стена и провод остаются, туман уходит', () => {
  const S = scene(), alive = new Uint8Array(S.n).fill(1);
  R.denoise(S.X, S.n, alive, 'strong');
  assert.ok(kept(S, alive, 0) > 0.99, 'пол');
  assert.ok(kept(S, alive, 1) > 0.95, 'редкая стена: ' + kept(S, alive, 1));
  assert.ok(kept(S, alive, 2) > 0.9, 'провод: ' + kept(S, alive, 2));
  assert.ok(kept(S, alive, 3) < 0.3, 'туман: ' + kept(S, alive, 3));
});

test('без защиты структур прежний порог съедал редкую стену (как на облаке пользователя)', () => {
  const S = scene(), alive = new Uint8Array(S.n).fill(1);
  R.lowDensity(S.X, S.n, alive, Object.assign({}, R.NOISE_LEVELS.strong, { globalFrac: 0.1, keepStruct: false }));
  assert.ok(kept(S, alive, 1) < 0.5, 'стена без защиты: ' + kept(S, alive, 1));
  const a2 = new Uint8Array(S.n).fill(1);
  R.lowDensity(S.X, S.n, a2, Object.assign({}, R.NOISE_LEVELS.strong, { globalFrac: 0.1 }));
  assert.ok(kept(S, a2, 1) > 0.95, 'стена с защитой: ' + kept(S, a2, 1));
  assert.ok(R.NOISE_LEVELS.strong.globalFrac <= 0.03 && R.NOISE_LEVELS.normal.globalFrac <= R.NOISE_LEVELS.strong.globalFrac);
});

test('шланг на полу остаётся, пыль над полом уходит', () => {
  const r = rng(7), P = [], tag = [];
  const add = (x, y, z, t) => { P.push(x, y, z); tag.push(t); };
  for (let x = 0; x < 3; x += 0.008) for (let y = 0; y < 3; y += 0.008) add(x, y, 0.0015 * gauss(r), 0);
  for (let t = 0; t < 1; t += 0.004 / 3) { const a = 2 * Math.PI * r(); add(0.2 + 2.6 * t + 0.012 * Math.cos(a), 1.5 + 0.012 * Math.sin(a) * 0.3, 0.025 + 0.012 * Math.abs(Math.sin(a)), 1); }
  for (let k = 0; k < 800; k++) add(3 * r(), 3 * r(), 0.02 + 0.05 * r(), 2);
  const S = { X: new Float64Array(P), tag: new Uint8Array(tag), n: tag.length }, L = R.NOISE_LEVELS.strong;
  const go = (ks) => { const a = new Uint8Array(S.n).fill(1); for (let p = 0; p < L.off.passes; p++) R.offSurface(S.X, S.n, a, Object.assign({}, L.off, { keepStruct: ks })); return a; };
  const alive = go(true), old = go(false);
  assert.ok(kept(S, alive, 0) > 0.99, 'пол');
  // прежде шланг на полу почти весь уходил как «пыль» (около 12 %), теперь — большая часть остаётся
  assert.ok(kept(S, alive, 1) > 0.7 && kept(S, alive, 1) > 3 * kept(S, old, 1), 'шланг: ' + kept(S, alive, 1) + ' (без защиты ' + kept(S, old, 1) + ')');
  assert.ok(kept(S, alive, 2) < 0.1, 'пыль: ' + kept(S, alive, 2));
});

test('простой вид окон: краткий текст, главные выборы, остальное — «Настроить»', () => {
  const kit = read('renderer/ui/kit.js');
  const m = /function shortText\(t, max\) \{[\s\S]*?\n  \}/.exec(kit); assert.ok(m, 'shortText');
  const shortText = new Function(m[0] + '; return shortText;')();
  assert.strictEqual(shortText('Коротко.', 120), 'Коротко.');
  assert.strictEqual(shortText('Первое предложение. ' + 'Второе очень длинное '.repeat(10), 120), 'Первое предложение.');
  assert.ok(shortText('слово '.repeat(60), 50).length <= 51);
  assert.ok(/o\.simple !== false/.test(kit) && /lx-more-btn/.test(kit) && /'Настроить'/.test(kit) && /lx-form-more/.test(kit));
  assert.ok(/\.lx-more-btn/.test(read('renderer/ui/components.css')));
  const ui = read('renderer/lixel-tools-ext.js');
  assert.ok(/key: 'level', main: true, label: 'Сила'/.test(ui), 'автоочистка: одна главная настройка');
  assert.ok(/ревизия 44: сразу полная очистка по файлу/.test(ui), 'большой скан — без вопроса о способе');
  assert.ok(/'Готово за ' \+/.test(ui), 'итог одной строкой');
});

test('«до мелочей»: редкая поверхность не считается одиночками, пыль перед стеной уходит', () => {
  global.window = global.window || global;
  const CC = require('../renderer/cloud-clean.js');
  const rnd = rng(9), P = [], tag = [];
  const add = (x, y, z, t) => { P.push(x, y, z); tag.push(t); };
  for (let i = 0; i < 150000; i++) { const u = rnd(), v = rnd(), f = Math.floor(rnd() * 3), e = (rnd() - 0.5) * 0.004;
    if (f === 0) add(u * 4, e, v * 4, 's'); else if (f === 1) add(e, v * 3, u * 4, 's'); else add(u * 4, v * 3, e, 's'); }
  for (let i = 0; i < 400; i++) add(0.07 + rnd() * 0.05, rnd() * 3, rnd() * 4, 'hair');
  // редкая дальняя панель (шаг 9 см — втрое реже среднего), как стрела экскаватора или дальняя стена на облаке пользователя
  for (let y = 0.5; y < 2.5; y += 0.09) for (let z = 0.5; z < 3.5; z += 0.09) add(3 + (rnd() - 0.5) * 0.004, y, z, 'panel');
  const pos = new Float32Array(P), r = CC.deepClean(pos, pos.length / 3, { people: false, flatten: false, micro: true });
  const by = {}; for (const i of r.remove) by[tag[i]] = (by[tag[i]] || 0) + 1;
  const np = tag.filter(t => t === 'panel').length;
  assert.ok((by.panel || 0) < np * 0.05, 'панель: ' + (by.panel || 0) + ' из ' + np);
  assert.ok((by.hair || 0) >= 360, 'пыль: ' + (by.hair || 0));
});
