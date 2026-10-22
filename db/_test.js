// Standalone persistence test for JsonStore (no Electron).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { JsonStore } = require('./jsonStore');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-'));
console.log('tmp dir:', dir);

let s = new JsonStore(dir);
let d = s.getData();
console.log('seed rooms:', d.rooms.length, 'floors:', d.floors.length);
assert(d.rooms.length > 0, 'seed produced rooms');
assert(fs.existsSync(path.join(dir, 'store.json')), 'store.json created');

// derive ai_status present
const hasStatus = d.rooms.some(r => r.elements.some(e => e.ai_status && e.ai_status !== 'none'));
assert(hasStatus, 'ai_status derived from findings');

// CRUD
const f = s.createFloor({ name: 'ТЕСТ этаж', number: 99 });
const r = s.createRoom(f.id, { name: 'ТЕСТ комната', area_m2: 10 });
const e = s.createElement(r.id, { name: 'ТЕСТ элемент', type: 'труба' });
const doc = s.createDocument({ room_id: r.id, element_id: e.id, name: 'ТЕСТ.pdf', type: 'акт' });
s.updateElement(e.id, { name: 'ТЕСТ элемент 2' });
s.updateRoom(r.id, { area_m2: 22 });

// reload from disk -> persistence check
s = new JsonStore(dir);
d = s.getData();
const rr = d.rooms.find(x => x.id === r.id);
assert(rr, 'room persisted after reload');
assert.strictEqual(rr.area_m2, 22, 'room update persisted');
assert(rr.elements.find(x => x.id === e.id).name === 'ТЕСТ элемент 2', 'element update persisted');
assert(rr.documents.find(x => x.id === doc.id), 'document persisted');

// backup roundtrip
const backup = s.exportBackup();
s.deleteRoom(r.id);
assert(!s.getData().rooms.find(x => x.id === r.id), 'room deleted');
s.importBackup(backup);
assert(s.getData().rooms.find(x => x.id === r.id), 'room restored from backup');

// ---------- Phase D: projects / users / discussions / report / sync ----------
const report = require('../ai/report');

// D1 projects: create + switch preserves per-project rooms
s = new JsonStore(dir);
const baseRooms = s.getData().rooms.length;
const p2 = s.createProject({ name: 'Проект 2', address: 'ул. Тестовая 5' });
assert(p2 && p2.id, 'project created');
let projs = s.listProjects();
assert(projs.length >= 2, 'two projects listed');
assert(projs.find(x => x.id === p2.id && x.active), 'new project is active');
assert.strictEqual(s.getData().rooms.length, 0, 'new empty project has no rooms');
const firstProj = projs.find(x => !x.active);
s.switchProject(firstProj.id);
assert.strictEqual(s.getData().rooms.length, baseRooms, 'switching back restores original rooms');

// D2 users + assignment
const u1 = s.createUser({ name: 'Иван Петров', role: 'Инженер', email: 'ivan@example.com' });
const u2 = s.createUser({ name: 'Мария Сидорова', role: 'Администратор' });
assert(s.listUsers().length >= 2, 'users listed');
s.updateUser(u2.id, { role: 'Наблюдатель' });
assert.strictEqual(s.listUsers().find(x => x.id === u2.id).role, 'Наблюдатель', 'user updated');
const anyRoom = s.getData().rooms.find(r => (r.findings || []).length);
const anyFinding = anyRoom.findings[0];
s.assignFinding(anyFinding.id, { assignee: u1.id, due: '2026-09-01' });
const reFinding = s.getData().rooms.find(r => r.id === anyRoom.id).findings.find(f => f.id === anyFinding.id);
assert.strictEqual(reFinding.assignee, u1.id, 'finding assignee set');
assert.strictEqual(reFinding.due, '2026-09-01', 'finding due set');

// D3 discussions
const el = anyRoom.elements[0];
const disc = s.createDiscussion({ element_id: el.id, room_id: anyRoom.id, title: 'Проверить зазор', author: 'Иван' });
assert(disc && disc.id, 'discussion created');
s.addDiscussionComment(disc.id, { author: 'Мария', text: 'Согласна' });
let dlist = s.listDiscussions(el.id);
assert.strictEqual(dlist.length, 1, 'discussion listed by element');
assert.strictEqual(dlist[0].comments.length, 1, 'comment added');
s.setDiscussionStatus(disc.id, 'resolved');
assert.strictEqual(s.listDiscussions(el.id)[0].status, 'resolved', 'discussion resolved');

// deleteElement purges discussions
s.deleteElement(el.id);
assert.strictEqual(s.listDiscussions(el.id).length, 0, 'discussions purged with element');

// D4 report over live store data
const data = s.getData();
const csv = report.build(data, { type: 'project' }, 'csv', { title: 'Отчёт' });
assert(csv.content.charCodeAt(0) === 0xFEFF && csv.encoding === 'utf8', 'csv has BOM');
const pdf = report.build(data, { type: 'project' }, 'pdf', { title: 'Отчёт' });
assert(pdf.encoding === 'binary' && pdf.content.slice(0, 8).toString('latin1') === '%PDF-1.4', 'pdf built');

// D5 sync export -> import merge into a fresh store
const bundle = s.exportWorkspace();
assert(bundle && bundle.data, 'workspace exported');
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bim2-'));
const s2 = new JsonStore(dir2);
s2.importWorkspace(bundle, { merge: true });
assert(s2.listUsers().find(x => x.id === u1.id), 'users merged into 2nd store');
assert(s2.listProjects().length >= 2, 'projects merged into 2nd store');
// persistence of merged data across reload
const s2b = new JsonStore(dir2);
assert(s2b.listUsers().find(x => x.id === u1.id), 'merged users persisted');
fs.rmSync(dir2, { recursive: true, force: true });
console.log('ALL PHASE D TESTS PASSED');

fs.rmSync(dir, { recursive: true, force: true });
console.log('ALL PERSISTENCE TESTS PASSED');
