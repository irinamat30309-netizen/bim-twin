'use strict';
// Ревизия 72: результаты обработки складываются в папку проекта, если она выбрана для проекта.
// Проверяем: (1) storage-paths отдаёт папку проекта по настройке projectDirs; (2) main.js использует её
// для сборки из .xbin, цвета по фото и чистовой обработки, а без папки — как раньше, рядом с исходником.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SP = require('../storage-paths');

test('r72: папка проекта известна storage-paths', () => {
  const ctx = { settings: { projectDirs: { prj_1: 'D:\\Проекты\\Дом' } }, projectId: 'prj_1', userData: 'C:\\Temp\\bim' };
  const w = SP.workRoot(ctx);
  assert.strictEqual(w.source, 'project');
  assert.strictEqual(w.projectDir, 'D:\\Проекты\\Дом');
  const none = SP.workRoot({ settings: {}, projectId: 'prj_2', userData: 'C:\\Temp\\bim' });
  assert.strictEqual(none.projectDir, null, 'без выбранной папки проекта её нет');
});

test('r72: main отдаёт результаты в папку проекта', () => {
  const m = read('main.js');
  assert.match(m, /function projectOutputDir\(projectId\)/, 'есть общий помощник');
  assert.match(m, /w\.source === 'project' \? w\.projectDir : null/, 'берём только выбранную папку проекта');
  assert.match(m, /const dir = projectOutputDir\(a\.projectId\) \|\| path\.dirname\(abs\), stem = path\.basename\(abs\)/, 'сборка из .xbin — в папку проекта');
  assert.match(m, /const outDir = projectOutputDir\(a\.projectId\) \|\| path\.dirname\(abs\);\s*\n\s*let target = null;/, 'цвет по фото — в папку проекта');
  assert.match(m, /const outDir = projectOutputDir\(a\.projectId\) \|\| path\.dirname\(abs\);\s*\n\s*const options = \{ title: 'Сохранить обработанное облако'/, 'чистовая — диалог открывается в папке проекта');
  assert.match(m, /inProjectFolder: !!projectOutputDir\(a\.projectId\)/, 'окно узнаёт, попал ли результат в папку проекта');
});
