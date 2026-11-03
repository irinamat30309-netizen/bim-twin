#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const root = process.cwd();
const started = Date.now();

function run(label, command, args) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

function pythonCommand() {
  const requested = process.env.PYTHON;
  const candidates = requested
    ? [requested]
    : (process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']);
  for (const command of candidates) {
    const args = command === 'py' ? ['-3', '--version'] : ['--version'];
    const probe = spawnSync(command, args, { cwd: root, stdio: 'ignore', windowsHide: true });
    if (!probe.error && probe.status === 0) return { command, prefix: command === 'py' ? ['-3'] : [] };
  }
  throw new Error('Python 3 was not found for source syntax validation.');
}

try {
  run('JavaScript syntax', process.execPath, ['scripts/check-syntax.mjs']);
  const python = pythonCommand();
  run('Python syntax', python.command, [...python.prefix, 'scripts/check-python-syntax.py']);
  run('Regression suite', process.execPath, ['--test']);
  run('Project storage regression', process.execPath, ['db/_test.js']);
  run('Stage 9 synthetic performance smoke', process.execPath, ['scripts/benchmark-section-stage9.mjs']);
  run('Release manifest', process.execPath, ['scripts/release-manifest.cjs', '--check']);
  console.log(`\nFINAL QA PASSED in ${((Date.now() - started) / 1000).toFixed(1)} s`);
} catch (error) {
  console.error(`\nFINAL QA FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
}