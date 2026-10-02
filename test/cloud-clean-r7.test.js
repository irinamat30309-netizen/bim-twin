'use strict';
// Ревизия 7: локальный шаг точек (размер точки вблизи) — модуль cloud-clean.js и его подключение в окне просмотра.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const CC = require('../renderer/cloud-clean.js');
const R = (...p) => path.join(__dirname, '..', ...p);

function twoDensity(N1, N2) {
  const N = N1 + N2, pos = new Float32Array(N * 3); let k = 0, s = 12345;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let i = 0; i < N1; i++) { pos[k++] = rnd() * 100; pos[k++] = 0; pos[k++] = rnd() * 100; }            // шаг ≈ 100/√N1 м
  for (let i = 0; i < N2; i++) { pos[k++] = rnd() * 10; pos[k++] = 0; pos[k++] = 200 + rnd() * 10; }       // плотный участок 10×10 м
  return pos;
}

test('spacingField: шаг в разреженной и плотной зонах определяется по месту (ошибка ≤ 30 %)', () => {
  const N1 = 400000, N2 = 400000, pos = twoDensity(N1, N2), r = CC.spacingField(pos, N1 + N2);
  assert.equal(r.codes.length, N1 + N2);
  const want1 = 100 / Math.sqrt(N1), want2 = 10 / Math.sqrt(N2);
  let a = 0, b = 0;
  for (let i = 0; i < N1; i++) a += CC.decodeSpacing(r.codes[i], r.sMin, r.sMax);
  for (let i = N1; i < N1 + N2; i++) b += CC.decodeSpacing(r.codes[i], r.sMin, r.sMax);
  a /= N1; b /= N2;
  assert.ok(Math.abs(a / want1 - 1) < 0.3, 'разреженная зона: ' + a + ' vs ' + want1);
  assert.ok(Math.abs(b / want2 - 1) < 0.3, 'плотная зона: ' + b + ' vs ' + want2);
  assert.ok(a / b > 8, 'разница плотностей должна сохраняться: ' + a / b);
});

test('spacingField: одиночные выбросы не получают огромный размер (≤ 4·s0), поверхность — свой шаг', () => {
  const { generate, toViewer } = require('../dev/ui-lab/mkoutdoor.js');
  const S = generate({ ang: 0.4 }), pos = toViewer(S.pos), n = pos.length / 3, r = CC.spacingField(pos, n);
  const iso = [];
  for (let i = 0; i < n; i++) if (S.lab[i] === 1) iso.push(CC.decodeSpacing(r.codes[i], r.sMin, r.sMax));
  iso.sort((x, y) => x - y);
  assert.ok(iso.length > 500, 'шум в сцене есть');
  assert.ok(r.sMax <= 16 * r.s0 * 1.001, 'абсолютный потолок 16·s0');
  const med = iso[iso.length >> 1];
  assert.ok(med < 0.12, 'медианный шаг шума мал: ' + med);
  let sceneMed = []; for (let i = 0; i < n; i += 7) if (S.lab[i] === 0) sceneMed.push(CC.decodeSpacing(r.codes[i], r.sMin, r.sMax));
  sceneMed.sort((x, y) => x - y);
  assert.ok(sceneMed[sceneMed.length >> 1] > 0.004 && sceneMed[sceneMed.length >> 1] < 0.2);
});

test('spacingGen: генератор отдаёт управление кусками и даёт тот же результат, что и spacingField', () => {
  const pos = twoDensity(300000, 100000), n = 400000;
  const g = CC.spacingGen(pos, n, {}); let yields = 0, r;
  do { r = g.next(); if (!r.done) yields++; } while (!r.done);
  assert.ok(yields >= 3, 'ожидалось несколько уступок управления: ' + yields);
  const full = CC.spacingField(pos, n);
  assert.deepEqual(Array.from(r.value.codes.subarray(0, 1000)), Array.from(full.codes.subarray(0, 1000)));
  assert.equal(r.value.sMin, full.sMin);
});

test('spacingField: нечисловые точки и малые облака не ломают расчёт', () => {
  const pos = new Float32Array(30000 * 3); for (let i = 0; i < pos.length; i++) pos[i] = (i * 7919 % 1000) / 100;
  pos[3] = NaN; pos[10] = Infinity;
  const r = CC.spacingField(pos, 30000); assert.equal(r.codes.length, 30000);
  assert.ok(r.sMax >= r.sMin && r.sMin > 0);
  const e = CC.spacingField(new Float32Array(3 * 5), 5); assert.equal(e.codes.length, 5);
});

test('окно просмотра: шейдер читает локальный шаг (aRad), потолок размера точки вблизи не зависит от числа точек', () => {
  const V = fs.readFileSync(R('renderer', 'webgl-viewer.js'), 'utf8'), H = fs.readFileSync(R('renderer', 'index.html'), 'utf8');
  assert.ok(V.includes('in float aRad;') && V.includes('exp2(aRad * uRadLog)'), 'атрибут aRad в вершинном шейдере');
  assert.ok(V.includes('const closeCap = Math.max(24, Math.round(vh * 0.05))'), 'потолок размера вблизи по высоте окна');
  assert.ok(V.includes('_startSpacingField(o)') && V.includes('_applySpacingField(o, f)'), 'фоновый расчёт и загрузка поля шага');
  assert.ok(V.includes('o._rad.codes.length === o.count'), 'поле шага используется только для того же числа точек');
  assert.ok(V.includes('this._denseFill ? 9.0 :'), 'прежние режимы (плотная заливка) сохранены');
  assert.ok(H.includes('cloud-clean.js?v=1170'), 'скрипт подключён в index.html');
  assert.ok(H.indexOf('cloud-process.js') < H.indexOf('cloud-clean.js'), 'cloud-clean грузится после cloud-process');
});
