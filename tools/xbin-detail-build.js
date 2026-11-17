// node tools/xbin-detail-build.js <scan.xbin> <poses.csv> <out.las> [json-opts|@file]
// r172: сборка приоритетного облака в detail-режиме — без edge-фильтра, без sky/balance, step 1 (полная плотность).
// Отличия от обычной сборки: не режутся точки на кромках/тонких структурах (остекление, рельсы, ограждения),
// поэтому визуально и метрически сохраняется максимум деталей. Цвет — как обычно, кнопкой «Цвет по фото» в приложении
// (или recolor-cli), т.к. для цвета нужны фото/позы проекта.
const fs = require('node:fs');
const path = require('node:path');
const XL = require('../xbin-lidar');

const [xbin, posesPath, outLas, optArg] = process.argv.slice(2);
if (!xbin || !posesPath || !outLas) {
  console.error('нужно: xbin-detail-build.js <scan.xbin> <poses.csv> <out.las> [json-opts|@file]');
  process.exit(2);
}
let opt = {};
if (optArg) opt = optArg[0] === '@' ? JSON.parse(fs.readFileSync(optArg.slice(1), 'utf8')) : JSON.parse(optArg);
opt.detail = true;
const poses = fs.readFileSync(posesPath, 'utf8');
const t0 = Date.now();
let last = 0;
const r = XL.build(xbin, poses, outLas, opt, (f, label) => {
  const n = Date.now(); if (n - last < 1000 && f < 1) return; last = n;
  process.stderr.write(`${label || 'Сборка'} ${Math.round(f * 100)}%\n`);
});
console.log(JSON.stringify({ ok: true, out: path.resolve(outLas), points: r.points, step: r.step, seconds: r.seconds,
  edge: r.edge, self: r.self, sky: r.sky, detail: true, ms: Date.now() - t0, rssMB: Math.round(process.memoryUsage().rss / 1048576) }));
