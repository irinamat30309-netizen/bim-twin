'use strict';
// Ревизия 8: адаптивное число точек при движении камеры (webgl-viewer.js).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'webgl-viewer.js'), 'utf8');

function extract(name) {
  const i = src.indexOf('    ' + name + '(');
  assert.ok(i > 0, 'нет метода ' + name);
  const open = src.indexOf('{', src.indexOf(')', i));
  let d = 0, j = open;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) break; } }
  return src.slice(i, j + 1).trim();
}
function mk() {
  const body = extract('_adaptInter') + '\n' + extract('interactivePointBudget');
  const C = new Function('return class V { ' + body + ' }')();
  return new C();
}

test('адаптивные точки: медленная видеокарта снижает число точек, но не ниже 1,5 млн', () => {
  const v = mk(); v._perfProfile = 'balanced';
  for (let i = 0; i < 6; i++) v._adaptInter(60, v.interactivePointBudget(10e6), 10e6);   // 10 млн за 60 мс → ~170 тыс. точек/мс
  const b = v.interactivePointBudget(10e6);
  assert.ok(b < 4e6 && b >= 1.5e6, 'бюджет ' + b);
  for (let i = 0; i < 6; i++) v._adaptInter(500, v.interactivePointBudget(10e6), 10e6);  // совсем медленно
  assert.equal(v.interactivePointBudget(10e6), 1.5e6);
});

test('адаптивные точки: быстрая видеокарта возвращает всё облако', () => {
  const v = mk(); v._perfProfile = 'balanced'; v._interPts = 1.5e6;
  for (let i = 0; i < 40; i++) v._adaptInter(4, v.interactivePointBudget(5e6), 5e6);
  assert.equal(v.interactivePointBudget(5e6), 5e6);
});

test('адаптивные точки: до первого замера рисуется всё облако; профиль «Максимум» терпит больше', () => {
  const v = mk(); assert.equal(v.interactivePointBudget(7e6), 7e6);
  const a = mk(), b = mk(); a._perfProfile = 'max'; b._perfProfile = 'balanced';
  for (let i = 0; i < 8; i++) { a._adaptInter(40, a.interactivePointBudget(20e6), 20e6); b._adaptInter(40, b.interactivePointBudget(20e6), 20e6); }
  assert.ok(a.interactivePointBudget(20e6) > b.interactivePointBudget(20e6));
});

test('адаптивные точки: замер встроен в рендер, размер точки компенсируется, полное облако после остановки', () => {
  assert.match(src, /_renderNowInner\(\) \{/);
  assert.match(src, /gl\.finish\(\)/);
  assert.match(src, /compI = dcI < o\.count \? Math\.min\(3, Math\.sqrt\(o\.count \/ dcI\)\)/);
  assert.match(src, /this\.interactivePointBudget\(o\.count\)/);
  assert.match(src, /this\._interBudget = 128000000/);
});
