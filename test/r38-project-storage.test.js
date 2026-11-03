'use strict';
// Ревизия 38: проект на любом диске — папка проекта выбирается при создании, кэш и временные файлы не на диске C
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sp = require('../storage-paths');
const ui = require('../renderer/project-storage-ui.js');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('r38: корень служебных файлов — папка проекта → общая папка → userData', () => {
  const ud = path.resolve('/ud'), pd = path.resolve('/disk-d/Проекты/ЖК');
  const settings = { projectDirs: { prj_a: pd, prj_bad: 'relative/dir' }, cacheRoot: path.resolve('/cache') };
  assert.strictEqual(sp.workRoot({ settings, projectId: 'prj_a', userData: ud }).root, path.join(pd, sp.CACHE_DIR));
  assert.strictEqual(sp.workRoot({ settings, projectId: 'prj_a', userData: ud }).source, 'project');
  assert.strictEqual(sp.workRoot({ settings, projectId: 'prj_bad', userData: ud }).source, 'custom', 'относительный путь не принимается');
  assert.strictEqual(sp.workRoot({ settings: {}, projectId: 'prj_a', userData: ud }).root, ud);
  assert.strictEqual(sp.workDir('octrees', { settings, projectId: 'prj_a', userData: ud }), path.join(pd, sp.CACHE_DIR, 'octrees'));
  assert.throws(() => sp.workDir('../etc', { settings, userData: ud }));
  const roots = sp.allRoots({ settings, userData: ud });
  assert.deepStrictEqual(roots, [ud, path.resolve('/cache'), path.join(pd, sp.CACHE_DIR)]);
});

test('r38: диски и предложение места — несистемный диск с наибольшим свободным местом', () => {
  const GB = 1024 * 1024 * 1024;
  const disks = { 'C:\\': [8 * GB, 256 * GB], 'D:\\': [900 * GB, 2000 * GB], 'E:\\': [30 * GB, 64 * GB] };
  const fake = {
    existsSync: p => !!disks[p],
    statSync: p => { if (disks[p]) return {}; throw new Error('ENOENT'); },
    statfsSync: p => { const d = disks[p]; return { bavail: d[0] / 4096, bsize: 4096, blocks: d[1] / 4096 }; }
  };
  // на Linux пути вида C:\ не абсолютные — проверяем только перечисление и выбор
  const drives = sp.listDrives({ platform: 'win32', fs: fake, systemRoot: 'C:\\' });
  assert.deepStrictEqual(drives.map(d => d.path), ['C:\\', 'D:\\', 'E:\\']);
  assert.ok(drives[0].system && drives[0].low, 'C: системный и почти полный');
  assert.ok(!drives[1].system && !drives[1].low);
  const s = sp.suggestParent({ drives, documents: '/home/u/Documents' });
  assert.strictEqual(s.why, 'free');
  assert.ok(s.path.indexOf('D:\\') === 0 && s.path.indexOf(sp.DEFAULT_PARENT) > 0, s.path);
  // прежнее место, если там хватает места
  const last = path.resolve('/projects');
  assert.deepStrictEqual(sp.suggestParent({ drives, lastParent: last, lastSpace: { free: 100 * GB, low: false } }), { path: last, why: 'last' });
  assert.strictEqual(sp.suggestParent({ drives, lastParent: last, lastSpace: { free: GB, low: true } }).why, 'free', 'на полном диске прежнее место не предлагаем');
  // без других дисков — Документы
  assert.strictEqual(sp.suggestParent({ drives: [drives[0]], documents: path.resolve('/docs') }).why, 'documents');
});

test('r38: свободное место — по ближайшей существующей папке; безопасное имя папки', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r38-'));
  const x = sp.diskSpace(path.join(tmp, 'ещё', 'нет', 'папки'));
  if (typeof fs.statfsSync === 'function') { assert.ok(x && x.total > 0 && x.free >= 0); assert.strictEqual(typeof x.low, 'boolean'); }
  assert.strictEqual(sp.existingAncestor(path.join(tmp, 'a', 'b')), tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.strictEqual(sp.safeName('ЖК: «Север» / корпус?'), 'ЖК_ «Север» _ корпус_');
  assert.strictEqual(sp.safeName('CON'), 'CON_');
  assert.strictEqual(sp.safeName('  '), 'Проект');
  assert.strictEqual(sp.projectDirFor(path.resolve('/d'), 'А.'), path.join(path.resolve('/d'), 'А'));
  assert.ok(/ГБ$/.test(sp.fmtGB(25 * 1073741824)) && /ТБ$/.test(sp.fmtGB(2 * 1099511627776)));
});

test('r38: форма «Новый проект» — итоговый путь, свободное место и предупреждение', () => {
  assert.strictEqual(ui.projectPath('D:\\BIM Twin Проекты', 'ЖК: Север'), 'D:\\BIM Twin Проекты\\ЖК_ Север');
  assert.strictEqual(ui.projectPath('D:\\Объекты\\ЖК', 'ЖК'), 'D:\\Объекты\\ЖК', 'папка уже называется как проект');
  assert.strictEqual(ui.safeName('A/B'), sp.safeName('A/B'), 'имя папки как в main');
  const GB = 1073741824;
  const ok = ui.describe('D:\\P', 'X', { free: 500 * GB, total: 1000 * GB, low: false, drive: 'D:\\' }, []);
  assert.ok(!ok.warn && /D:\\P\\X/.test(ok.text) && /свободно 500 ГБ на D:/.test(ok.text), ok.text);
  const low = ui.describe('C:\\P', 'X', { free: 5 * GB, total: 256 * GB, low: true, drive: 'C:\\' }, [{ path: 'D:\\', free: 800 * GB, system: false }]);
  assert.ok(low.warn && /Мало места/.test(low.text) && /свободнее D: \(800 ГБ\)/.test(low.text), low.text);
  assert.ok(ui.describe('', 'X').warn);
  assert.ok(/C: — свободно .*\(системный\)/.test(ui.drivesLine([{ path: 'C:\\', free: 5 * GB, system: true }])));
});

test('r38: main.js — кэши через workDir, выбор папки только диалогом, preload и подключение форм', () => {
  const m = read('main.js');
  for (const k of ['octrees', 'potree', 'splatcache', 'clean', 'cc-edit', 'geom']) {
    assert.ok(!m.includes("path.join(app.getPath('userData'), '" + k + "')"), 'userData/' + k + ' больше не зашит');
  }
  assert.ok(/function octreeBaseDir\(\) \{ return workDir\('octrees'\); \}/.test(m));
  assert.ok(/return path\.join\(workDir\('cloud-history'\), key\)/.test(m));
  assert.ok(/function currentAutosave\(\)/.test(m) && /workDir\('autosave-clouds', w\)/.test(m), 'черновики облаков в папке проекта');
  assert.ok(/scratchBaseDir: dir/.test(m), 'временные файлы разбора — в папку проекта');
  assert.ok(/octreeBases\(\)\.find/.test(m), 'чтение узлов octree разрешено из всех своих каталогов');
  assert.ok(/ipcMain\.handle\('bim:projectStorage'/.test(m));
  assert.ok(/allowedProjectParent\(String\(parentReq\)\)/.test(m) && /pickedParents\.add\(picked\)/.test(m), 'путь папки — только из диалога или предложенный');
  assert.ok(/for \(const k of \['projectDirs', 'lastProjectParent', 'cacheRoot'\]\) delete patch\[k\]/.test(m), 'setSettings не меняет пути хранения');
  assert.ok(/const own = storagePaths\.projectDirOf\(settings, project && project\.id\)/.test(m));
  assert.ok(/projectStorage: \(payload\) => inv\('bim:projectStorage'/.test(read('preload.js')));
  const kit = read('renderer/ui/kit.js');
  assert.ok(/f\.type === 'folder'/.test(kit) && /lx-folder-pick/.test(kit) && /typeof f\.hint === 'function'/.test(kit));
  assert.ok(read('renderer/startup.html').includes('project-storage-ui.js'));
  assert.ok(read('renderer/index.html').includes('project-storage-ui.js'));
  const st = read('renderer/startup.js');
  assert.ok(/ProjectStorageUI\.newProjectForm/.test(st) && /folderParent: v\.folderParent/.test(st) && /Папка проекта…/.test(st));
  assert.ok(/ProjectStorageUI\.newProjectForm\(\{ address: true \}\)/.test(read('renderer/app.js')));
  assert.ok(/storageLines\(f, stInfo\)/.test(read('renderer/project-workspace.js')));
});

test('r38: storage-paths.js попадает в установщик', () => {
  const files = require('../package.json').build.files;
  assert.ok(files.includes('storage-paths.js'));
});
