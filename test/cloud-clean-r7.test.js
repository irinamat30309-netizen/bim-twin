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

// ---------- Умное подавление шума: плотность места вместо одного радиуса на всю сцену ----------
const CPm = require('../renderer/cloud-process.js');
const OUT = require('../dev/ui-lab/mkoutdoor.js');
let sceneCache = null;
function scene() {
  if (!sceneCache) { const S = OUT.generate({ ang: 0.2, seed: 11 }), pos = OUT.toViewer(S.pos); sceneCache = { S, pos, n: pos.length / 3 }; }
  return sceneCache;
}
function score(res, S, n) {
  const tot = [0, 0, 0], got = [0, 0, 0];
  for (let i = 0; i < n; i++) tot[S.lab[i]]++;
  for (const i of res.remove) got[S.lab[i]]++;
  return { noise: got[1] / tot[1], lost: got[0] / tot[0], lostN: got[0], people: got[2] / tot[2] };
}

test('denoise: уровни по возрастанию удаляют не меньше шума; средний убирает ≥ 70 % мусора и теряет ≤ 0,02 % полезных точек', () => {
  const { S, pos, n } = scene(), r = {};
  for (const level of ['soft', 'medium', 'strong']) r[level] = score(CC.denoise(pos, n, { level }), S, n);
  assert.ok(r.soft.noise <= r.medium.noise + 1e-9 && r.medium.noise <= r.strong.noise + 1e-9, JSON.stringify(r));
  assert.ok(r.medium.noise >= 0.7, 'средний уровень убрал только ' + (r.medium.noise * 100).toFixed(1) + ' % шума');
  assert.ok(r.soft.lost <= 0.0002 && r.medium.lost <= 0.0002, 'потери полезных: ' + JSON.stringify(r));
  assert.ok(r.strong.lost <= 0.0005, 'потери полезных (сильно): ' + r.strong.lost);
  assert.ok(r.medium.people <= 0.01, 'люди — это поверхность сцены, а не шум: потеряно ' + (r.medium.people * 100).toFixed(2) + ' %');
});

test('denoise: прежний радиусный фильтр с параметрами по умолчанию терял десятки процентов полезных точек, умный — на два порядка меньше', () => {
  const { S, pos, n } = scene(), est = CPm.estimate(pos, n), d = CPm.defaults(est);
  const old = CPm.denoise(pos, n, { radius: d.denoiseRadius, neighbors: d.denoiseNeighbors }), keep = new Uint8Array(n);
  for (const i of old.keep) keep[i] = 1;
  let lostOld = 0, tot = 0; for (let i = 0; i < n; i++) if (S.lab[i] === 0) { tot++; if (!keep[i]) lostOld++; }
  const mine = score(CC.denoise(pos, n, { level: 'medium' }), S, n);
  assert.ok(lostOld / tot > 0.03, 'прежний фильтр на этой сцене должен терять заметную долю: ' + (lostOld / tot));
  assert.ok(mine.lost * 100 < lostOld / tot, 'умный должен терять в 100 раз меньше: ' + mine.lost + ' vs ' + lostOld / tot);
});

test('denoise: плотная поверхность без шума не теряет ни одной точки; малые облака и нечисловые точки обрабатываются', () => {
  const N = 150000, pos = new Float32Array(N * 3); let s = 777;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let i = 0; i < N; i++) { pos[i * 3] = rnd() * 20; pos[i * 3 + 1] = 0; pos[i * 3 + 2] = rnd() * 20; }
  for (const level of ['soft', 'medium', 'strong']) assert.equal(CC.denoise(pos, N, { level }).removed, 0, level + ': чистая плоскость должна остаться целой');
  assert.equal(CC.denoise(new Float32Array(0), 0, {}).removed, 0);
  assert.equal(CC.denoise(new Float32Array([1, 2, 3, 4, 5, 6]), 2, {}).removed, 0);
  const bad = pos.slice(0, 3000 * 3); bad[7 * 3 + 1] = NaN; bad[9 * 3] = Infinity;
  const r = CC.denoise(bad, 3000, { level: 'medium' });
  assert.ok(r.stats.invalid >= 2 && Array.from(r.remove).includes(7) && Array.from(r.remove).includes(9), 'нечисловые точки считаются мусором');
});

test('denoise: одинокая пылинка над плотной поверхностью и островок из десятка точек удаляются, а тонкий провод и стена — нет', () => {
  const N = 200000, M = N + 1 + 12 + 2000, pos = new Float32Array(M * 3); let s = 4242, k = 0;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let i = 0; i < N; i++) { pos[k++] = rnd() * 8; pos[k++] = 0; pos[k++] = rnd() * 8; }            // пол 8×8 м: шаг ≈ 1,8 см
  pos[k++] = 4; pos[k++] = 0.3; pos[k++] = 4;                                                          // одиночная пылинка в 30 см над полом
  for (let i = 0; i < 12; i++) { pos[k++] = 2 + rnd() * 0.1; pos[k++] = 0.8 + rnd() * 0.1; pos[k++] = 2 + rnd() * 0.1; }   // облачко 12 точек в 80 см над полом
  for (let i = 0; i < 2000; i++) { pos[k++] = 7 + rnd() * 0.01; pos[k++] = 0.5 + i * 0.001; pos[k++] = 7 + rnd() * 0.01; }     // провод 2 м из 2000 точек
  const rem = new Set(CC.denoise(pos, M, { level: 'medium' }).remove);
  assert.ok(rem.has(N), 'пылинка удалена');
  let cloud = 0; for (let i = N + 1; i < N + 13; i++) if (rem.has(i)) cloud++;
  assert.ok(cloud >= 11, 'облачко из 12 точек удалено: ' + cloud + ' из 12');
  let wire = 0; for (let i = N + 13; i < M; i++) if (rem.has(i)) wire++;
  assert.equal(wire, 0, 'провод из 2000 точек не трогаем');
  let floor = 0; for (let i = 0; i < N; i++) if (rem.has(i)) floor++;
  assert.ok(floor <= 20, 'пол почти не потерял точек: ' + floor);
});

test('denoise: слэб core ограничивает результат своей частью (основа для пула воркеров), прогресс доходит до 1', () => {
  const { pos, n } = scene(), full = CC.denoise(pos, n, { level: 'medium' });
  let hi = -Infinity, lo = Infinity; for (let i = 0; i < n; i++) { const v = pos[i * 3]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const mid = (lo + hi) / 2, seen = []; 
  const part = CC.denoise(pos, n, { level: 'medium', core: { axis: 0, lo: -Infinity, hi: mid } }, { progress: f => seen.push(f) });
  for (const i of part.remove) assert.ok(pos[i * 3] < mid);
  const fs2 = new Set(full.remove); let same = 0; for (const i of part.remove) if (fs2.has(i)) same++;
  assert.equal(same, part.removed, 'слэб не удаляет того, что не удалил бы полный расчёт');
  assert.ok(seen.length > 3 && seen[seen.length - 1] === 1 && seen.every((v, i) => i === 0 || v >= seen[i - 1] - 1e-9), 'прогресс монотонен и завершается');
  assert.ok(part.removed < full.removed && part.removed > 0);
});

test('окно: умное подавление шума идёт в воркере, перед удалением есть красный предпросмотр и подтверждение, Esc отменяет', () => {
  const W = fs.readFileSync(R('renderer', 'cloud-process-worker.js'), 'utf8'), X = fs.readFileSync(R('renderer', 'lixel-tools-ext.js'), 'utf8'), V = fs.readFileSync(R('renderer', 'webgl-viewer.js'), 'utf8');
  assert.match(W, /importScripts\('cloud-process\.js\?v=1160', 'cloud-clean\.js\?v=1170'\)/);
  assert.match(W, /m\.op === 'denoise2'/);
  assert.match(W, /res\.remove && res\.remove\.buffer/, 'список удаляемых точек передаётся без копирования');
  assert.match(X, /opFor: function \(v\) \{ return v\.mode === 'smart' \? 'denoise2' : 'denoise'; \}/);
  assert.match(X, /review: function \(res, c, v\)/);
  assert.match(X, /previewRemoval\(c, removedIndices\(res, c\.count\)/);
  assert.match(X, /Облако изменилось, пока шёл просмотр/, 'нельзя применить результат к другому облаку');
  assert.match(X, /big \? 'warn' : ''/, 'при удалении > 5 % облака панель предупреждает');
  assert.match(X, /e\.key === 'Escape'/);
  assert.match(V, /previewPoints\(pos, opts\)/); assert.match(V, /clearPreview\(silent\)/);
  assert.equal((V.match(/\.concat\(this\._prevObj \? \[this\._prevObj\] : \[\]\)/g) || []).length, 2, 'предпросмотр рисуется в обоих списках отрисовки');
  assert.ok(fs.readFileSync(R('renderer', 'ui', 'tools.css'), 'utf8').includes('.lx-confirmbar'));
});
