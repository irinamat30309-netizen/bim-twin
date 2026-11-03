'use strict';
// Юнит-тесты хранилища JsonStore (без нативных модулей, только встроенные Node).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../db/jsonStore');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bim-test-')); }

test('seed создаёт помещения и store.json', () => {
  const dir = tmp();
  try {
    const s = new JsonStore(dir);
    const d = s.getData();
    assert.ok(d.rooms.length > 0, 'есть помещения');
    assert.ok(fs.existsSync(path.join(dir, 'store.json')), 'store.json создан');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CRUD и персистентность после перезагрузки', () => {
  const dir = tmp();
  try {
    let s = new JsonStore(dir);
    const f = s.createFloor({ name: 'ТЕСТ этаж', number: 99 });
    const r = s.createRoom(f.id, { name: 'ТЕСТ комната', area_m2: 10 });
    const e = s.createElement(r.id, { name: 'ТЕСТ элемент', type: 'труба' });
    s.updateRoom(r.id, { area_m2: 22 });
    s.updateElement(e.id, { name: 'ТЕСТ элемент 2' });

    s = new JsonStore(dir); // перезагрузка с диска
    const rr = s.getData().rooms.find(x => x.id === r.id);
    assert.ok(rr, 'комната сохранилась');
    assert.strictEqual(rr.area_m2, 22, 'обновление комнаты сохранено');
    assert.strictEqual(rr.elements.find(x => x.id === e.id).name, 'ТЕСТ элемент 2', 'элемент обновлён');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('backup roundtrip восстанавливает удалённое', () => {
  const dir = tmp();
  try {
    const s = new JsonStore(dir);
    const f = s.createFloor({ name: 'F' });
    const r = s.createRoom(f.id, { name: 'R' });
    const backup = s.exportBackup();
    s.deleteRoom(r.id);
    assert.ok(!s.getData().rooms.find(x => x.id === r.id), 'удалено');
    s.importBackup(backup);
    assert.ok(s.getData().rooms.find(x => x.id === r.id), 'восстановлено из бэкапа');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('projects: новый проект пуст, переключение возвращает комнаты', () => {
  const dir = tmp();
  try {
    const s = new JsonStore(dir);
    const baseRooms = s.getData().rooms.length;
    const p2 = s.createProject({ name: 'Проект 2' });
    assert.ok(p2 && p2.id, 'проект создан');
    assert.strictEqual(s.getData().rooms.length, 0, 'новый проект пуст');
    const first = s.listProjects().find(x => !x.active);
    s.switchProject(first.id);
    assert.strictEqual(s.getData().rooms.length, baseRooms, 'комнаты вернулись');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
