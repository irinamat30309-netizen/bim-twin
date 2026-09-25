'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');
const FULL_ARRAY_WARNING = 'Операция требует полный массив точек и недоступна в «Поток LOD». Выключите «Поток LOD» и повторите.';

function loadExtension(filename, streamed) {
  const messages = [];
  const viewer = { octreeActive: () => streamed };
  const beginProgress = () => {
    const stop = () => {};
    stop.set = () => {};
    stop.text = () => {};
    return stop;
  };
  const window = {
    __pcTools: {
      viewer: () => viewer,
      getCloud: () => null,
      isOctreeStreamActive: () => streamed,
      toast: message => messages.push(String(message)),
      beginProgress
    },
    addEventListener() {}
  };
  const document = { readyState: 'loading', addEventListener() {} };
  const quietConsole = { log() {}, warn() {}, error() {} };
  vm.runInNewContext(fs.readFileSync(path.join(RENDERER, filename), 'utf8'), {
    window, document, console: quietConsole, setTimeout, setInterval, clearInterval,
    Promise, Map, Math, Number, String, Array, Object, Error, isFinite
  }, { filename });
  return { window, messages };
}

test('point-cloud tools reject full-array processing in streamed LOD mode', async () => {
  const { window, messages } = loadExtension('lixel-tools-ext.js', true);
  await window.__lxToolsExt.ops.opResample();
  assert.equal(messages.length, 1);
  assert.equal(messages[0], FULL_ARRAY_WARNING);
});

test('terrain/BIM sprint tools reject full-array processing in streamed LOD mode', async () => {
  const { window, messages } = loadExtension('lixel-sprints-ext.js', true);
  await window.__lxSprintsExt.ops.opDSM();
  assert.equal(messages.length, 1);
  assert.equal(messages[0], FULL_ARRAY_WARNING);
});

test('a missing ordinary cloud keeps the existing actionable prompt', async () => {
  for (const [filename, api, operation] of [
    ['lixel-tools-ext.js', '__lxToolsExt', 'opResample'],
    ['lixel-sprints-ext.js', '__lxSprintsExt', 'opDSM']
  ]) {
    const { window, messages } = loadExtension(filename, false);
    await window[api].ops[operation]();
    assert.deepEqual(messages, ['Сначала откройте облако точек']);
  }
});

test('built-in cloud-cleaning guards distinguish streamed LOD from an unopened cloud', () => {
  const app = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  assert.ok(html.includes('uncompressed LAS point formats 0–10') &&
    html.includes('scalar-property ASCII/binary LE/BE PLY') &&
    html.includes('при наличии исходника intensity/classification') &&
    html.includes('произвольные extra dimensions не сохраняются'));
  assert.match(app, /bim-octree-node-error/);
  assert.match(app, /Не удалось подгрузить часть облака/);
  assert.match(app, /octree node read failed/);
  assert.match(app, /function pointCloudArrayUnavailableMessage\(\)[\s\S]*?octreeActive/);
  assert.match(app, /isOctreeStreamActive:\s*\(\)\s*=>/);
  for (const operation of ['cleanIslandsInApp', 'cleanRadiusInApp', 'noiseFilterInApp', 'classifyInApp']) {
    const line = app.split('\n').find(value => value.includes(operation));
    assert.ok(line && line.includes('pointCloudArrayUnavailableMessage()'), operation);
  }
});
