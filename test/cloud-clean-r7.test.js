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
  assert.match(V, /if \(o\._isPreview\) \{ gl\.disable\(gl\.DEPTH_TEST\); gl\.depthMask\(false\); \}/, 'красные точки предпросмотра рисуются поверх облака');
  assert.match(X, /opPeople: opPeople/); assert.match(X, /op: 'people'/);
  assert.match(W, /m\.op === 'people'/);
  assert.ok(fs.readFileSync(R('renderer', 'ui', 'commands.js'), 'utf8').includes("I('opPeople', 'user-round-x', 'Удалить людей'"));
});

// ---------- Удаление людей: форма, а не радиус ----------
test('people: на уличной сцене находит большинство людей (в т.ч. идущих), не трогает колонну, столбы, знак, ящики, деревья и машины', () => {
  const { S, pos, n } = scene(), r = CC.people(pos, n, { level: 'normal' });
  const tot = [0, 0, 0], got = [0, 0, 0]; for (let i = 0; i < n; i++) tot[S.lab[i]]++; for (const i of r.remove) got[S.lab[i]]++;
  assert.ok(r.found.length >= 7 && r.found.length <= 10, 'найдено объектов: ' + r.found.length);
  assert.ok(got[2] / tot[2] >= 0.9, 'удалено точек людей: ' + (got[2] / tot[2] * 100).toFixed(1) + ' %');
  assert.ok(got[0] / tot[0] <= 0.0002, 'задето полезных точек сцены: ' + got[0] + ' (' + (got[0] / tot[0] * 100).toFixed(4) + ' %)');
  const near = (x, y, rad) => { let k = 0; for (const i of r.remove) if (Math.hypot(pos[i * 3] - x, -pos[i * 3 + 2] - y) < rad && S.lab[i] === 0) k++; return k; };
  assert.equal(near(-9, -3, 0.6), 0, 'колонна ростом с человека остаётся');
  assert.equal(near(18, 8, 1.2), 0, 'стойка со знаком остаётся');
  assert.equal(near(3, -6, 1.5), 0, 'тумбы остаются');
  for (const f of r.found) assert.ok(f.h >= 1.3 && f.h <= 2.2 && f.w <= 1.2, 'размеры найденного: ' + JSON.stringify(f));
  assert.ok(r.stats.rejected.size > 100, 'большинство компонентов (стены, деревья, машины) отсеяно по размеру');
});

test('people: уровни — строгий находит не больше обычного, мягкий не меньше; сидящие включаются опцией', () => {
  const { pos, n } = scene(), c = {};
  for (const level of ['strict', 'normal', 'loose']) c[level] = CC.people(pos, n, { level }).found.length;
  assert.ok(c.strict <= c.normal && c.normal <= c.loose, JSON.stringify(c));
  const seated = CC.people(pos, n, { level: 'normal', sitting: true });
  assert.ok(seated.found.length >= c.normal);
});

function surf(out, f, count, rnd) { for (let i = 0; i < count; i++) out.push(f(rnd(), rnd())); }
function synthRoom(withHuman) {
  const P = []; let s = 99;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  surf(P, (a, b) => [a * 12, 0 + 0.002 * (b - 0.5), b * 12], 120000, rnd);                                      // пол 12×12 м
  const cyl = (cx, cz, r, y0, y1, k) => surf(P, (a, b) => [cx + r * Math.cos(a * 6.2832), y0 + (y1 - y0) * b, cz + r * Math.sin(a * 6.2832)], k, rnd);
  const sph = (cx, cy, cz, r, k) => surf(P, (a, b) => { const th = a * 6.2832, ph = Math.acos(1 - 2 * b); return [cx + r * Math.sin(ph) * Math.cos(th), cy + r * Math.cos(ph), cz + r * Math.sin(ph) * Math.sin(th)]; }, k, rnd);
  cyl(2, 2, 0.26, 0, 1.75, 9000);                                                                              // колонна ростом с человека
  cyl(10, 2, 0.05, 0, 2.2, 1500);                                                                              // тонкая стойка
  surf(P, (a, b) => [4 + a, 0.75 * b + 0.75 * (b > 0.5 ? 1 : 0), 8 + 0.9 * (b > 0.5 ? a : (a > 0.5 ? 1 : 0))], 8000, rnd);   // ящик ≈ 1×1,5×0,9 (грубо)
  if (withHuman) {
    const hx = 7, hz = 7;
    cyl(hx - 0.1, hz, 0.075, 0.05, 0.88, 1400); cyl(hx + 0.1, hz, 0.075, 0.05, 0.88, 1400);                      // ноги
    cyl(hx, hz, 0.17, 0.9, 1.4, 2400);                                                                         // торс
    cyl(hx - 0.24, hz, 0.045, 0.92, 1.32, 500); cyl(hx + 0.24, hz, 0.045, 0.92, 1.32, 500);                      // руки
    cyl(hx, hz, 0.05, 1.42, 1.5, 150); sph(hx, 1.62, hz, 0.105, 700);                                           // шея и голова
  }
  const pos = new Float32Array(P.length * 3); P.forEach((p, i) => { pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; });
  return { pos, n: P.length, humanFrom: P.length - (withHuman ? 1400 * 2 + 2400 + 1000 + 150 + 700 : 0) };
}
test('people: на сцене без людей (колонна, стойка, ящик) удалять нечего; один человек находится целиком вместе с «пеньками» стоп', () => {
  const a = synthRoom(false), ra = CC.people(a.pos, a.n, { level: 'normal' });
  assert.equal(ra.removed, 0, 'ложных срабатываний быть не должно: ' + JSON.stringify(ra.found));
  const b = synthRoom(true), rb = CC.people(b.pos, b.n, { level: 'normal' });
  assert.equal(rb.found.length, 1, 'найден один человек: ' + JSON.stringify(rb.found));
  const gone = new Set(rb.remove); let hum = 0; for (let i = b.humanFrom; i < b.n; i++) if (gone.has(i)) hum++;
  assert.ok(hum / (b.n - b.humanFrom) > 0.97, 'точек человека удалено ' + hum + ' из ' + (b.n - b.humanFrom));
  let outside = 0; for (const i of rb.remove) if (i < b.humanFrom) outside++;
  assert.ok(outside <= 30, 'снаружи удалено: ' + outside);
});

test('people: пустое, малое и нечисловое облако не ломают расчёт; прогресс монотонен', () => {
  assert.equal(CC.people(new Float32Array(0), 0, {}).removed, 0);
  assert.equal(CC.people(new Float32Array(30), 10, {}).removed, 0);
  const a = synthRoom(true), p = a.pos.slice(); p[5] = NaN; p[10] = Infinity;
  const seen = [], r = CC.people(p, a.n, { level: 'normal' }, { progress: (f) => seen.push(f) });
  assert.equal(r.found.length, 1);
  assert.ok(seen.length > 3 && seen[seen.length - 1] === 1 && seen.every((v, i) => !i || v >= seen[i - 1] - 1e-9));
});
