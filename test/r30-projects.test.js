'use strict';
// Ревизия 30: стартовый экран — свойства любого проекта (название, адрес, статус), копия структуры проекта, удаление; оба хранилища.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { JsonStore } = require('../db/jsonStore');
const { SqliteStore } = require('../db/sqliteStore');

class BetterSqliteCompat {
  constructor(file) { this.db = new DatabaseSync(file); }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  pragma(sql) { return this.db.prepare('PRAGMA ' + sql).all(); }
  transaction(fn) { return (...args) => { this.db.exec('BEGIN IMMEDIATE'); try { const r = fn(...args); this.db.exec('COMMIT'); return r; } catch (e) { try { this.db.exec('ROLLBACK'); } catch (_) {} throw e; } }; }
  close() { this.db.close(); }
}
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bim-r30-prj-'));

function scenario(store) {
  const first = store.listProjects().find(p => p.active);
  // структура активного проекта: этаж с помещением и элементом
  const floor = store.createFloor({ name: 'Этаж 2' });
  const room = store.createRoom(floor.id, { name: 'Склад', area_m2: 42.5 });
  store.createElement(room.id, { name: 'Стеллаж', type: 'оборудование' });
  const roomsBefore = store.listProjects().find(p => p.id === first.id).rooms;
  assert.ok(roomsBefore >= 1);
  const other = store.createProject({ name: 'Второй', address: '' });   // становится активным
  // свойства неактивного проекта
  const ed = store.editProject(first.id, { name: 'Склад №1', address: 'ул. Заводская, 3', status: 'archived' });
  assert.deepEqual([ed.name, ed.address, ed.status], ['Склад №1', 'ул. Заводская, 3', 'archived']);
  let list = store.listProjects();
  const f1 = list.find(p => p.id === first.id);
  assert.equal(f1.name, 'Склад №1'); assert.equal(f1.address, 'ул. Заводская, 3'); assert.equal(f1.status, 'archived'); assert.equal(f1.active, false);
  assert.equal(list.find(p => p.active).id, other.id, 'активный проект не сменился');
  // свойства активного проекта и неизвестный id
  assert.equal(store.editProject(other.id, { address: 'пр. Мира, 1' }).address, 'пр. Мира, 1');
  assert.equal(store.editProject('prj_нет', { name: 'x' }), null);
  // копия структуры неактивного проекта
  const dup = store.duplicateProject(first.id, {});
  assert.equal(dup.name, 'Склад №1 (копия)'); assert.equal(dup.address, 'ул. Заводская, 3'); assert.equal(dup.rooms, roomsBefore);
  list = store.listProjects();
  assert.equal(list.length, 3);
  assert.equal(list.find(p => p.id === dup.id).rooms, roomsBefore);
  assert.equal(list.find(p => p.active).id, other.id, 'копия не становится активной');
  assert.equal(store.duplicateProject(other.id, { name: 'Мой дубль' }).name, 'Мой дубль');
  assert.equal(store.duplicateProject('prj_нет', {}), null);
  // копия не зависит от исходного: удаление оригинала не трогает копию
  assert.deepEqual(store.deleteProject(first.id), { id: first.id });
  list = store.listProjects();
  assert.ok(!list.some(p => p.id === first.id));
  assert.equal(list.find(p => p.id === dup.id).rooms, roomsBefore);
  // в копии — те же помещения с новыми id
  store.switchProject(dup.id);
  const data = store.getData();
  const r = data.rooms.find(x => x.name === 'Склад');
  assert.ok(r && r.id !== room.id && Math.abs(r.area_m2 - 42.5) < 1e-9, 'помещение скопировано с новым id');
  assert.ok(data.floors.some(f => f.name === 'Этаж 2' && f.id !== floor.id), 'этаж скопирован с новым id');
  return list;
}

test('JSON-хранилище: свойства любого проекта, копия структуры, удаление', () => {
  const dir = tempDir();
  try { scenario(new JsonStore(dir)); const again = new JsonStore(dir); assert.equal(again.listProjects().length, 3, 'изменения сохранены на диск'); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SQLite-хранилище: свойства любого проекта, копия структуры (в транзакции), удаление', () => {
  const dir = tempDir();
  try {
    const s = new SqliteStore(dir, BetterSqliteCompat);
    scenario(s);
    const els = s.db.prepare('SELECT COUNT(*) c FROM elements e JOIN rooms r ON r.id = e.room_id JOIN floors f ON f.id = r.floor_id WHERE f.project_id = ?').get(s.listProjects().find(p => p.active).id).c;
    assert.ok(els >= 1, 'элементы скопированы');
    s.db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('IPC и preload: editProject / duplicateProject с проверкой полей; стартовый экран — меню карточки', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8'), pre = fs.readFileSync(path.join(root, 'preload.js'), 'utf8'), js = fs.readFileSync(path.join(root, 'renderer', 'startup.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('bim:editProject', \(_e, a\) => \{ a = vArgs\(a\); return store\.editProject\(vId\(a\.id\), vProjectCard\(a\.patch, false\)\); \}\);/);
  assert.match(main, /ipcMain\.handle\('bim:duplicateProject'/);
  assert.match(pre, /editProject: \(id, patch\) => inv\('bim:editProject', \{ id, patch: patch \|\| \{\} \}\)/);
  assert.match(pre, /duplicateProject: \(id, patch\) => inv\('bim:duplicateProject'/);
  // проверка полей карточки (функция из main.js без запуска Electron)
  const src = main.slice(main.indexOf('function vId('), main.indexOf('\n', main.indexOf('function vProjectCard(') + 1));
  const fnSrc = main.slice(main.indexOf('function vProjectCard('), main.indexOf('\n}\n', main.indexOf('function vProjectCard(')) + 2);
  const V = new Function(src.split('\n').filter(l => /^function v(Id|Str|Patch|Args)\(/.test(l)).join('\n') + '\n' + fnSrc + '\nreturn vProjectCard;')();
  assert.deepEqual(V({ name: '  Имя ', address: 'А', status: 'done', evil: 1 }, false), { name: 'Имя', address: 'А', status: 'done' });
  assert.throws(() => V({ name: '   ' }, false), /пустое название/);
  assert.deepEqual(V({ name: '' }, true), {});
  assert.throws(() => V({ name: 'x'.repeat(201) }, false), /слишком длинное/);
  assert.throws(() => V({ name: 5 }, false), /invalid string/);
  for (const k of ['renameProject', 'editProject', 'duplicateProject', 'deleteProject', 'projectMenu']) assert.match(js, new RegExp('function ' + k + '\\('));
  assert.match(js, /kit\.form\(/); assert.match(js, /danger: true, okLabel: 'Удалить'/);
  assert.match(js, /e\.key === 'F2'/); assert.match(js, /e\.key === 'Delete'/); assert.match(js, /'contextmenu'/);
});
