'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../db/jsonStore');
const Presets = require('../db/sectionPresets');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bim-section-presets-'));
}

function draft(name, patch) {
  return Object.assign({
    name,
    source: {
      name: 'room.las',
      pointCount: 205526,
      bounds: { min: [-5, 0, -2], max: [5, 3, 2] },
      srcXform: { axis: 'zup', t: [500000, 6000000, 117] },
      crsCode: 'EPSG:32637'
    },
    params: {
      axis: 'y', level: 1.2, thickness: 0.2, cell: 0.1, minArea: 0.02,
      azimuthDeg: 0, originX: 0, originZ: 0, offset: 0
    }
  }, patch || {});
}

test('section-preset contracts validate units, finite values and supported limits', () => {
  const clean = Presets.normalizeDraft(draft('Этаж 2 — план'));
  assert.equal(clean.name, 'Этаж 2 — план');
  assert.equal(clean.params.axis, 'y');
  assert.equal(clean.params.level, 1.2);
  assert.equal(clean.source.srcXform.axis, 'zup');
  assert.throws(() => Presets.normalizeDraft(draft(' ', {})), /required/i);
  assert.throws(() => Presets.normalizeDraft(draft('Плохое', { params: { axis: 'diagonal' } })), /axis/i);
  assert.throws(() => Presets.normalizeDraft(draft('Плохое', { params: {
    axis: 'y', level: Infinity, thickness: 0.2, cell: 0.1, minArea: 0
  } })), /range|finite/i);
  assert.throws(() => Presets.normalizeDraft(draft('Плохое', { params: {
    axis: 'y', level: 1, thickness: 0, cell: 0.1, minArea: 0
  } })), /range/i);
  assert.throws(() => Presets.normalizeDraft(draft('Плохое', { source: {
    bounds: { min: [1, 0, 0], max: [0, 1, 1] }
  } })), /inverted/i);
  assert.equal(Presets.nameKey('  ФАСАД  '), Presets.nameKey('фасад'));
});

test('project section presets CRUD is isolated, restart-safe and upserts names without duplicate records', () => {
  const dir = tempDir();
  try {
    let store = new JsonStore(dir);
    const projectA = store.getData().project.id;
    const first = store.saveSectionPreset(draft('Фасад Север'));
    assert.equal(first.ok, true);
    assert.equal(first.replaced, false);
    assert.equal(store.listSectionPresets().length, 1);

    const updated = store.saveSectionPreset(draft('  фасад север  ', {
      params: { axis: 'z', level: 2.1, thickness: 0.25, cell: 0.05, minArea: 0.01 }
    }));
    assert.equal(updated.replaced, true);
    assert.equal(updated.preset.id, first.preset.id);
    assert.equal(store.listSectionPresets().length, 1);
    assert.equal(store.listSectionPresets()[0].params.axis, 'z');
    assert.equal(store.listSectionPresets()[0].params.level, 2.1);

    const projectB = store.createProject({ name: 'Изолированный проект сечений' }).id;
    assert.deepEqual(store.listSectionPresets(), []);
    const onlyB = store.saveSectionPreset(draft('Этаж 1 — план'));
    assert.equal(store.listSectionPresets()[0].id, onlyB.preset.id);
    store.switchProject(projectA);
    assert.equal(store.listSectionPresets().length, 1);
    assert.equal(store.listSectionPresets()[0].id, first.preset.id);
    store.switchProject(projectB);
    assert.equal(store.listSectionPresets()[0].id, onlyB.preset.id);

    store = new JsonStore(dir);
    assert.equal(store.getData().project.id, projectB);
    assert.equal(store.listSectionPresets()[0].id, onlyB.preset.id);
    assert.deepEqual(store.deleteSectionPreset(onlyB.preset.id), { id: onlyB.preset.id, deleted: true });
    assert.deepEqual(store.deleteSectionPreset(onlyB.preset.id), { id: onlyB.preset.id, deleted: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('section presets travel with active and archived projects through backup and workspace merge', () => {
  const sourceDir = tempDir();
  const backupDir = tempDir();
  const mergeDir = tempDir();
  try {
    const source = new JsonStore(sourceDir);
    const projectA = source.getData().project.id;
    const presetA = source.saveSectionPreset(draft('План А'));
    const projectB = source.createProject({ name: 'Проект B' }).id;
    const presetB = source.saveSectionPreset(draft('Разрез Б', {
      params: { axis: 'profile', level: null, thickness: 0.3, cell: 0.08, minArea: 0, azimuthDeg: 45, originX: 4, originZ: 8, offset: 0.1 }
    }));

    const restored = new JsonStore(backupDir);
    restored.importBackup(source.exportBackup());
    assert.equal(restored.getData().project.id, projectB);
    assert.equal(restored.listSectionPresets()[0].id, presetB.preset.id);
    restored.switchProject(projectA);
    assert.equal(restored.listSectionPresets()[0].id, presetA.preset.id);

    const merged = new JsonStore(mergeDir);
    merged.importWorkspace(source.exportWorkspace(), { merge: true });
    merged.switchProject(projectA);
    assert.equal(merged.listSectionPresets()[0].name, 'План А');
    merged.switchProject(projectB);
    assert.equal(merged.listSectionPresets()[0].params.axis, 'profile');
    assert.equal(merged.listSectionPresets()[0].params.azimuthDeg, 45);
  } finally {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.rmSync(mergeDir, { recursive: true, force: true });
  }
});

test('section preset limits and invalid writes fail without corrupting the saved list', () => {
  const dir = tempDir();
  try {
    const store = new JsonStore(dir);
    assert.throws(() => store.saveSectionPreset(draft('bad', { params: {
      axis: 'x', level: 0, thickness: 0.2, cell: NaN, minArea: 0
    } })));
    assert.deepEqual(store.listSectionPresets(), []);
    for (let i = 0; i < Presets.MAX_SECTION_PRESETS; i++) {
      store.saveSectionPreset(draft('Набор ' + i));
    }
    assert.equal(store.listSectionPresets().length, Presets.MAX_SECTION_PRESETS);
    assert.throws(() => store.saveSectionPreset(draft('Набор сверх лимита')), /лимит/i);
    assert.equal(store.listSectionPresets().length, Presets.MAX_SECTION_PRESETS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('section preset main-process endpoints are explicitly exposed through IPC preload', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const schema = fs.readFileSync(path.join(root, 'db/schema.sql'), 'utf8');
  const sqlite = fs.readFileSync(path.join(root, 'db/sqliteStore.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');
  const workspace = fs.readFileSync(path.join(root, 'renderer/lixel-workspace.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
  assert.match(main, /bim:listSectionPresets/);
  assert.match(main, /bim:saveSectionPreset/);
  assert.match(main, /bim:deleteSectionPreset/);
  assert.match(preload, /listSectionPresets:\s*\(\)\s*=>/);
  assert.match(preload, /saveSectionPreset:\s*\(preset\)\s*=>/);
  assert.match(preload, /deleteSectionPreset:\s*\(id\)\s*=>/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS section_presets/);
  assert.match(sqlite, /_listSectionPresetsForProject/);
  assert.match(sqlite, /sectionPresets:\s*this\._listSectionPresetsForProject/);
  assert.match(app, /bim-project-changed/);
  assert.match(app, /if \(!current && activeTab !== 'dash'\)/);
  assert.match(workspace, /lxSectionPresetSelect/);
  assert.match(workspace, /контрольная выборка точек/);
  assert.match(html, /app\.js\?v=1249/);
  assert.match(html, /lixel-workspace\.js\?v=1232/);
});
