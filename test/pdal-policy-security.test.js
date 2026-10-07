'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  inspectPdalPipeline,
  bindPdalFile,
  assertPdalFilesBound
} = require('../security/pdal-policy');

test('PDAL policy replaces every claimed reader and writer path', () => {
  const policy = inspectPdalPipeline({
    pipeline: [
      { type: 'readers.las', filename: '../../secret.las' },
      { type: 'filters.range', limits: 'Classification[2:2]' },
      { type: 'writers.ply', filename: 'result.ply' }
    ]
  });
  assert.equal(policy.pipeline.pipeline[0].filename, '');
  assert.equal(policy.pipeline.pipeline[2].filename, '');
  assert.deepEqual(policy.files.map(item => item.kind), ['input', 'output']);

  const input = path.resolve('/tmp', 'selected.las');
  const output = path.resolve('/tmp', 'selected.ply');
  bindPdalFile(policy, 'stage-0', input);
  bindPdalFile(policy, 'stage-2', output);
  assert.equal(assertPdalFilesBound(policy).pipeline[0].filename, input);
  assert.equal(assertPdalFilesBound(policy).pipeline[2].filename, output);
});

test('PDAL policy denies executable, remote and connection stages', () => {
  assert.throws(
    () => inspectPdalPipeline([{ type: 'filters.python', script: 'import os' }]),
    /pdal_filter_not_allowed/
  );
  assert.throws(
    () => inspectPdalPipeline([{ type: 'readers.ept', filename: 'https://example.invalid/ept.json' }]),
    /pdal_reader_not_allowed/
  );
  assert.throws(
    () => inspectPdalPipeline([
      { type: 'readers.las', filename: 'input.las' },
      { type: 'filters.overlay', datasource: '/etc/passwd' }
    ]),
    /pdal_external_resource_not_allowed/
  );
});

test('PDAL policy rejects implicit path stages and unbound pipelines', () => {
  assert.throws(
    () => inspectPdalPipeline(['input.las', { type: 'filters.stats' }]),
    /pdal_explicit_stage_required/
  );
  const policy = inspectPdalPipeline([
    { type: 'readers.las', filename: 'input.las' },
    { type: 'filters.stats' }
  ]);
  assert.throws(() => assertPdalFilesBound(policy), /pdal_unbound_file_slot/);
});

test('PDAL policy accepts computation-only safe options', () => {
  const policy = inspectPdalPipeline([
    { type: 'readers.las', filename: 'input.las' },
    { type: 'filters.reprojection', in_srs: 'EPSG:32636', out_srs: 'EPSG:4326' },
    { type: 'filters.expression', expression: 'Classification == 2' },
    { type: 'writers.null' }
  ]);
  assert.equal(policy.files.length, 1);
});

test('desktop PDAL bridge reads an authorized pipeline file instead of renderer paths', () => {
  const root = path.resolve(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  assert.match(main, /resolveAuthorizedFile\(event, String\(a\.pipelinePath \|\| ''\), new Set\(\['\.json'\]\)\)/);
  assert.match(renderer, /API\.pdalRun\(\{ pipelinePath: f\.path \}\)/);
  assert.doesNotMatch(renderer, /JSON\.parse\(await f\.text\(\)\)/);
});