'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const manager = fs.readFileSync(path.join(root, 'scan2bim-server.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'renderer', 'scan2bim-ai-client.js'), 'utf8');
const fastapi = fs.readFileSync(path.join(root, 'scan2bim-ai-server', 'server.py'), 'utf8');
const lite = fs.readFileSync(path.join(root, 'scan2bim-ai-server', 'server_lite.py'), 'utf8');

test('Scan2BIM sidecars receive an ephemeral token and bind locally', () => {
  assert.match(manager, /crypto\.randomBytes\(32\)\.toString\('hex'\)/);
  assert.match(manager, /BIMTWIN_S2B_TOKEN:\s*AUTH_TOKEN/);
  assert.match(manager, /HOST:\s*'127\.0\.0\.1'/);
  assert.match(manager, /authToken:\s*authToken/);
});

test('renderer authenticates every Scan2BIM HTTP request', () => {
  assert.match(client, /headers\.set\('X-BIMTwin-Token', token\)/);
  assert.equal((client.match(/\bfetch\(/g) || []).length, 1, 'only the authenticated wrapper may call native fetch');
  assert.match(client, /return fetch\(url, opts\)/);
});

test('both Python servers reject unauthenticated and oversized requests', () => {
  for (const source of [fastapi, lite]) {
    assert.match(source, /BIMTWIN_S2B_TOKEN/);
    assert.match(source, /X-BIMTwin-Token|x-bimtwin-token/i);
    assert.match(source, /MAX_UPLOAD_BYTES/);
    assert.doesNotMatch(source, /Access-Control-Allow-Origin['"],\s*['"]\*/);
  }
  assert.match(fastapi, /allow_origins=\['null'\]/);
  assert.match(lite, /Access-Control-Allow-Origin', 'null'/);
});

test('FastAPI sidecar cleans partial output families after failed generation', () => {
  assert.match(fastapi, /def _generated_paths\(tmp_path\):/);
  assert.match(fastapi, /generated = _generated_paths\(tmp_path\)/);
  assert.match(fastapi, /except Exception:\s+_cleanup\(generated\)\s+raise/s);
  assert.match(fastapi, /background=BackgroundTask\(_cleanup, generated\)/);
});