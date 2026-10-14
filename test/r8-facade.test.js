'use strict';
// Ревизия 8: «Выровнять поверхности» для толстого слоя фасада (скан через стекло): режим «Фасад, стекло» (допуск ≥ 12 см, участки 0,6 м).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const CP = require('../renderer/cloud-process.js');

function rng(seed) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); }
// Стена 6 × 4 м, повёрнутая на 7°: слой σ = 1,2 см + 15 % «ореола» ±10 см (отражения, второй проход SLAM)
function glassWall(n, seed) {
  const r = rng(seed), pos = new Float32Array(n * 3), ang = 7 * Math.PI / 180, c = Math.cos(ang), s = Math.sin(ang);
  for (let i = 0; i < n; i++) {
    const u = r() * 6, h = r() * 4, d = r() < 0.15 ? (r() - 0.5) * 0.2 : gauss(r) * 0.012;
    pos[i * 3] = u * c - d * s; pos[i * 3 + 1] = h; pos[i * 3 + 2] = u * s + d * c;
  }
  return pos;
}
function share(pos, n, within) {
  const ang = 7 * Math.PI / 180, nx = -Math.sin(ang), nz = Math.cos(ang); let k = 0;
  for (let i = 0; i < n; i++) if (Math.abs(pos[i * 3] * nx + pos[i * 3 + 2] * nz) <= within) k++;
  return k / n;
}

test('фасад: режим «Фасад, стекло» укладывает толстый слой на плоскость заметно лучше обычных параметров', () => {
  const n = 400000, base = glassWall(n, 7);
  const before = share(base, n, 0.005);
  const a = new Float32Array(base); CP.run('flatten', a, { tol: 0.03, strength: 1, spacing: 0.01 });
  const b = new Float32Array(base); CP.run('flatten', b, { tol: 0.12, strength: 1, spacing: 0.01, cell: 0.6 });
  const sa = share(a, n, 0.005), sb = share(b, n, 0.005);
  assert.ok(sb > 0.9, 'режим фасада: ' + sb);
  assert.ok(sb > sa + 0.1, 'режим фасада ' + sb + ' против обычного ' + sa);
  assert.ok(sa >= before, 'обычный режим не ухудшает: ' + sa + ' vs ' + before);
});

test('фасад: диалог содержит выбор типа поверхности, режим передаёт допуск ≥ 12 см и участок 0,6 м', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'lixel-tools-ext.js'), 'utf8');
  assert.match(s, /Фасад, стекло \(толстый слой\)/);
  assert.match(s, /Math\.max\(v\.tol, 0\.12\)/);
  assert.match(s, /cell: facade \? 0\.6 : undefined/);
});
