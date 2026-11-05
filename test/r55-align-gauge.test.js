'use strict';
// Ревизия 55: опора сведения проходов. По умолчанию закреплено начало съёмки — поздние проходы уезжают вместе
// с исправлением дрейфа, и облако в среднем смещается (на реальной съёмке до ~1 см). С gauge: 'median' опорой
// становится середина: типичная поверхность остаётся на месте, а проходы всё равно сводятся.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const PA = require('../pass-align-core');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// «комната» 10×8×3 м: пол и четыре стены; проход A — t 0…100 с, проход B — t 200…300 с, сдвинут на shift (дрейф)
function room(o) {
  o = Object.assign({ n: 240000, shift: [0.03, -0.02, 0.01], noise: 0.002, seed: 7 }, o || {});
  let seed = o.seed; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const P = new Float64Array(o.n * 3), T = new Float64Array(o.n), B = new Uint8Array(o.n);
  for (let i = 0; i < o.n; i++) {
    const s = rnd() * 22; let x, y, z;
    if (s < 8) { x = rnd() * 10; y = rnd() * 8; z = 0; }
    else if (s < 11) { x = 0; y = rnd() * 8; z = rnd() * 3; } else if (s < 14) { x = 10; y = rnd() * 8; z = rnd() * 3; }
    else if (s < 18) { x = rnd() * 10; y = 0; z = rnd() * 3; } else { x = rnd() * 10; y = 8; z = rnd() * 3; }
    const b = rnd() < 0.5; B[i] = b ? 1 : 0; T[i] = b ? 200 + rnd() * 100 : rnd() * 100;
    P[i * 3] = x + (b ? o.shift[0] : 0) + (rnd() - 0.5) * o.noise;
    P[i * 3 + 1] = y + (b ? o.shift[1] : 0) + (rnd() - 0.5) * o.noise;
    P[i * 3 + 2] = z + (b ? o.shift[2] : 0) + (rnd() - 0.5) * o.noise;
  }
  return { n: o.n, P, T, B };
}
function sampler(S) {
  const smp = new PA.Sampler(S.n, S.n, false);
  for (let i = 0; i < S.n; i++) smp.add(S.P[i * 3], S.P[i * 3 + 1], S.P[i * 3 + 2], S.T[i]);
  return smp;
}
const median = (a) => { const s = Array.from(a).sort((x, y) => x - y); return s[s.length >> 1]; };

test('r55: опора «середина» не уводит облако, а проходы всё равно сводятся', () => {
  const S = room(), smp = sampler(S);
  const def = PA.solve(smp, null, {});
  assert.ok(def.ok, 'сведение по умолчанию: ' + (def.reason || ''));
  const med = PA.solve(sampler(S), null, { gauge: 'median' });
  assert.ok(med.ok, 'сведение с опорой на середину: ' + (med.reason || ''));
  assert.strictEqual(med.stats.gauge, 'median');

  const SH = [0.03, -0.02, 0.01];
  const disp = (sol) => {
    const corr = PA.makeCorrector(sol, null), out = [0, 0, 0];
    const all = { dx: [], dy: [], dz: [] }, byPass = { A: [], B: [] };
    for (let i = 0; i < S.n; i += 17) {
      corr(S.P[i * 3], S.P[i * 3 + 1], S.P[i * 3 + 2], S.T[i], out);
      all.dx.push(out[0] - S.P[i * 3]); all.dy.push(out[1] - S.P[i * 3 + 1]); all.dz.push(out[2] - S.P[i * 3 + 2]);
      // остаток до истины: проход B был сдвинут на SH — после сведения он должен вернуться
      const tx = S.P[i * 3] - (S.B[i] ? SH[0] : 0), ty = S.P[i * 3 + 1] - (S.B[i] ? SH[1] : 0), tz = S.P[i * 3 + 2] - (S.B[i] ? SH[2] : 0);
      const d = Math.hypot(out[0] - tx, out[1] - ty, out[2] - tz);
      (S.B[i] ? byPass.B : byPass.A).push(d);
    }
    const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    return { m: [median(all.dx), median(all.dy), median(all.dz)], A: avg(byPass.A), B: avg(byPass.B) };
  };
  const d0 = disp(def), d1 = disp(med);
  assert.ok(d0.A < 0.004 && d0.B < 0.008, 'по умолчанию: ранний проход на месте (' + (d0.A * 1000).toFixed(1) + ' мм), поздний сведён (' + (d0.B * 1000).toFixed(1) + ' мм)');
  assert.ok(Math.hypot(...d1.m) < 0.001, 'с опорой на середину облако в среднем не уезжает: ' + (Math.hypot(...d1.m) * 1000).toFixed(2) + ' мм');
  assert.ok(med.stats.gaugeShift > 0.001, 'сдвиг, который пришлось скомпенсировать: ' + (med.stats.gaugeShift * 1000).toFixed(1) + ' мм');
  // сведение осталось рабочим: поздний проход по-прежнему близко к своему месту
  assert.ok(d1.B < 0.008, 'поздний проход сведён: остаток ' + (d1.B * 1000).toFixed(1) + ' мм');
  assert.ok(d1.A < 0.03, 'ранний проход сдвинулся вместе с опорой, но не больше полуширины дрейфа: ' + (d1.A * 1000).toFixed(1) + ' мм');
  assert.ok(med.stats.after.medRes <= med.stats.before.medRes, 'совпадение проходов не хуже: ' + (med.stats.before.medRes * 1000).toFixed(1) + ' → ' + (med.stats.after.medRes * 1000).toFixed(1) + ' мм');
});

test('r55: опора сведения видна в окне и доходит до обработки', () => {
  const ui = read('renderer/lixel-tools-ext.js');
  assert.match(ui, /key: 'alignGauge', label: 'Не уводить облако: опора — середина съёмки'/, 'галочка в окне');
  assert.match(ui, /alignGauge: values\.alignGauge \? 'median' : 'start'/, 'выбор окна уходит в обработку');
  assert.match(ui, /al\.gauge === 'median' \? 'проходы сведены \(опора — середина\)'/, 'итог различает опору');
  const m = read('main.js');
  assert.match(m, /alignOpt: a\.alignGauge === 'median' \? \{ gauge: 'median' \} : undefined/, 'main передаёт опору');
  assert.match(read('scan-refine-parallel.js'), /'alignOpt'/, 'пул плиток передаёт параметры сведения');
  assert.match(read('scan-refine-core.js'), /gauge: sol\.stats\.gauge, gaugeShift: sol\.stats\.gaugeShift/, 'итоги сведения содержат опору');
});

test('r55: выбор тона — «как в Lixel» или «как снято» — доходит до обработки', () => {
  const ui = read('renderer/lixel-tools-ext.js');
  assert.match(ui, /key: 'tone', label: 'Тон', type: 'select'/, 'выбор тона в окне');
  assert.match(ui, /tone: values\.tone === 'raw' \? 'raw' : 'lixel'/, 'выбор уходит в обработку');
  const m = read('main.js');
  assert.match(m, /colorBalanceOpt: a\.tone === 'raw' \? \{ brighten: false \} : undefined/, 'main выключает осветление');
  const CB = require('../color-balance-core');
  assert.ok(typeof CB.solve === 'function' && typeof CB.makeColorFix === 'function', 'кривая тона живёт в color-balance-core');
});
