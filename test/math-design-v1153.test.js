'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', 'renderer');
const M = require(path.join(R, 'measure.js'));
const HTML = fs.readFileSync(path.join(R, 'index.html'), 'utf8');
// Интерфейс перерабатывался: лента — ui/ribbon.js + реестр ui/commands.js, стили — ui/shell.css и ui/tools.css.
const RIBBON = fs.readFileSync(path.join(R, 'ui', 'ribbon.js'), 'utf8');
const COMMANDS = fs.readFileSync(path.join(R, 'ui', 'commands.js'), 'utf8');
const SHELL = fs.readFileSync(path.join(R, 'ui', 'shell.css'), 'utf8');
const TOOLS = fs.readFileSync(path.join(R, 'ui', 'tools.css'), 'utf8');

function near(a, b, e) { return Math.abs(a - b) <= (e == null ? 1e-6 : e); }

// ---------- МАТЕМАТИКА (аддитивные улучшения) ----------

test('distance: добавлены уклон (slope) и grade, старые поля целы', () => {
  const d = M.distance([0, 0, 0], [3, 4, 0]); // горизонт=3, верт=4
  assert.ok(near(d.d3, 5), 'd3=' + d.d3);
  assert.ok(near(d.horizontal, 3), 'horizontal=' + d.horizontal);
  assert.ok(near(d.vertical, 4), 'vertical=' + d.vertical);
  assert.ok(near(d.slope, Math.atan2(4, 3) * 180 / Math.PI, 1e-4), 'slope=' + d.slope);
  assert.ok(near(d.grade, (4 / 3) * 100, 1e-4), 'grade=' + d.grade);
});

test('distance: вертикальный отрезок — grade = Infinity, slope = 90', () => {
  const d = M.distance([0, 0, 0], [0, 2, 0]);
  assert.strictEqual(d.grade, Infinity);
  assert.ok(near(d.slope, 90, 1e-6), 'slope=' + d.slope);
});

test('orientation: вертикальность/уровень для стены и пола', () => {
  const wall = M.orientation([1, 0, 0]);   // вертикальная
  assert.ok(near(wall.dip, 90, 1e-6), 'wall.dip=' + wall.dip);
  assert.ok(near(wall.verticality, 0, 1e-6), 'wall.verticality=' + wall.verticality);
  const floor = M.orientation([0, 1, 0]);   // горизонтальная
  assert.ok(near(floor.dip, 0, 1e-6), 'floor.dip=' + floor.dip);
  assert.ok(near(floor.levelness, 0, 1e-6), 'floor.levelness=' + floor.levelness);
  assert.ok(near(floor.slopePercent, 0, 1e-6), 'floor.slopePercent=' + floor.slopePercent);
});

test('planeExtents: гравитационные габариты стены 6×3 (ширина×высота)', () => {
  const pts = [];
  for (let y = 0; y <= 3; y++) for (let z = 0; z <= 6; z++) pts.push([5, y, z]);
  const pl = M.fitPlanePCA(pts);
  const ext = M.planeExtents(pts, pl);
  // старые поля сохранены
  assert.ok(near(ext.length, 6, 1e-4), 'length=' + ext.length);
  assert.ok(near(ext.width, 3, 1e-4), 'width=' + ext.width);
  // новые: hSpan (по горизонту) ≈ 6, vSpan (по вертикали) ≈ 3
  assert.ok(near(ext.hSpan, 6, 1e-4), 'hSpan=' + ext.hSpan);
  assert.ok(near(ext.vSpan, 3, 1e-4), 'vSpan=' + ext.vSpan);
  assert.strictEqual(ext.isWall, true);
  assert.strictEqual(ext.isFloor, false);
});

test('flatness: RMS и размах пик-впадина', () => {
  const plane = { normal: [0, 1, 0], d: 0 }; // y = 0
  const pts = [[0, 0.01, 0], [1, -0.02, 0], [2, 0.03, 1], [3, -0.01, 2]];
  const f = M.flatness(pts, plane);
  assert.strictEqual(f.count, 4);
  assert.ok(near(f.peak, 0.03, 1e-9), 'peak=' + f.peak);
  assert.ok(near(f.valley, -0.02, 1e-9), 'valley=' + f.valley);
  assert.ok(near(f.pv, 0.05, 1e-9), 'pv=' + f.pv);
  assert.ok(f.rms > 0, 'rms=' + f.rms);
});

test('ransacPlane: второй рефит и medianError (старый тест с выбросами не сломан)', () => {
  const pts = [];
  for (let x = 0; x <= 9; x++) for (let z = 0; z <= 9; z++) pts.push([x, 1 + (((x * 7 + z) % 5) - 2) * 0.002, z]);
  for (let i = 0; i < 20; i++) pts.push([i % 10, 5 + i, (i * 3) % 10]);
  const pl = M.ransacPlane(pts, { threshold: 0.05, iters: 400 });
  assert.ok(Math.abs(pl.normal[1]) > 0.99, 'normal.y=' + pl.normal[1]);
  assert.ok(pl.inlierCount >= 100, 'inliers=' + pl.inlierCount);
  assert.ok(pl.rms < 0.01, 'rms=' + pl.rms);
  assert.ok(typeof pl.medianError === 'number' && pl.medianError >= 0, 'medianError=' + pl.medianError);
});

// ---------- ДИЗАЙН (иконки / ровность / вмещаемость) ----------

test('index.html: подключены стили нового интерфейса + актуальные версии', () => {
  for (const css of ['fonts', 'tokens', 'base', 'components', 'shell', 'panels', 'tools', 'viewers', 'motion']) {
    assert.ok(HTML.includes('ui/' + css + '.css?v='), 'нет ui/' + css + '.css');
  }
  assert.ok(HTML.includes('measure.js?v=1156'), 'measure.js not current');
  assert.ok(HTML.includes('ui/ribbon.js?v='), 'ribbon js не подключён');
});

test('лента: иконка LCC2 + любые кнопки получают иконку из реестра', () => {
  assert.match(COMMANDS, /I\('tsSplatLcc2', 'folder-open', 'LCC2'/, 'нет иконки LCC2');
  // исходные кнопки «усыновляются» лентой (двигаются в ячейку, обработчики сохраняются), а не клонируются/заменяются
  assert.ok(RIBBON.includes('function adopt') && RIBBON.includes('function skin'), 'нет усыновления кнопок');
  assert.ok(!RIBBON.includes('cloneNode'), 'нельзя клонировать кнопки');
  assert.ok(!/\.replaceWith\(\s*skin|removeChild\(\s*node/.test(RIBBON), 'нельзя заменять узлы исходных кнопок');
});

test('стили: адаптивная лента и ровные панели', () => {
  assert.ok(SHELL.includes('scrollbar-width'), 'нет тонкого скролла ленты');
  assert.ok(SHELL.includes('.lx-rb'), 'нет правил кнопок ленты');
  assert.ok(SHELL.includes('@media (max-width: 1280px)'), 'нет адаптивности для узких экранов');
  assert.ok(/max-height:\s*calc\(100%/.test(TOOLS), 'панели могут выйти за экран');
  assert.ok(/@media \(max-width: 900px\)/.test(TOOLS), 'нет адаптивности для панелей инструментов');
});
