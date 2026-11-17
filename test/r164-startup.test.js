'use strict';
/*
 * r164 — старт ≤10 с: фоновые сервисы (ИИ-ассистент + Scan2BIM) вынесены с критического пути окна,
 * clearCache убран с создания окна, на стартовой странице kit грузится только по действию пользователя,
 * бенчмарк понимает быстрый авто-вход (startup → index без клика).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MAIN = read('main.js');
const PRELOAD = read('preload.js');
const STARTUP = read('renderer/startup.js');
const APP = read('renderer/app.js');
const BENCH = read('tools/scan2bim-py/bench-app-r145.js');

test('r164: ИИ/Scan2BIM стартуют фоново после рабочей области, а не в whenReady', () => {
  assert.match(MAIN, /function startBackgroundServices\(\)/);
  assert.match(MAIN, /ipcMain\.handle\('bim:startBackgroundServices'/);
  // в whenReady больше нет прямого aiMain.autoStart/s2b.start
  const when = MAIN.slice(MAIN.indexOf('app.whenReady()'), MAIN.indexOf('app.on(\'window-all-closed\''));
  assert.doesNotMatch(when, /aiMain\.autoStart\(/, 'aiMain.autoStart не должен блокировать первое окно');
  assert.doesNotMatch(when, /s2b\.start\(\);/, 'scan2bim.start не должен блокировать первое окно');
  // функция фоновых сервисов содержит оба запуска
  const bg = MAIN.slice(MAIN.indexOf('function startBackgroundServices'), MAIN.indexOf('app.whenReady()'));
  assert.match(bg, /aiMain\.autoStart\(/);
  assert.match(bg, /s2b\.start\(\)/);
  // clearCache убран с создания окна и перенесён в фоновые сервисы
  assert.doesNotMatch(MAIN.slice(MAIN.indexOf('function createWindow'), MAIN.indexOf('function startBackgroundServices')), /session\.clearCache\(\)/);
  assert.match(bg, /clearCache\(\)/);
});

test('r164: окно просит фоновый старт после bim-app-ready (preload + app.js)', () => {
  assert.match(PRELOAD, /startBackgroundServices: \(\) => inv\('bim:startBackgroundServices'\)/);
  assert.match(APP, /API\.startBackgroundServices/);
  assert.match(APP, /setTimeout\(function \(\) \{ try \{ if \(API && typeof API\.startBackgroundServices/, 'фоновый старт должен быть отложен');
});

test('r164: startup-UI грузится по первому действию, авто-вход не гоняется с CDP', () => {
  assert.match(STARTUP, /addEventListener\('pointerdown', kickLazy/);
  assert.match(STARTUP, /addEventListener\('keydown', kickLazy/);
  assert.match(STARTUP, /openSelected\(\); \}, 650\)/);
});

test('r164: бенчмарк понимает быстрый авто-вход startup → index', () => {
  assert.match(BENCH, /earlyNav/);
  assert.match(BENCH, /auto-nav/);
});
