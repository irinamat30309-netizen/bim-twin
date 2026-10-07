#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const excludedDirectories = new Set([
  '.git',
  'node_modules',
  'QA-artifacts',
  'qa-v1089',
  'qa-v1090',
  'coverage',
  'dist',
  'release',
  'vendor'
]);
const sourceExtensions = new Set(['.js', '.mjs', '.cjs']);
const sources = [];

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) visit(absolute);
    } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      sources.push(absolute);
    }
  }
}

visit(root);
sources.sort();

const failures = [];
for (const file of sources) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    failures.push({ file: path.relative(root, file), error: result.error?.message || result.stderr || result.stdout });
  }
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`SYNTAX ERROR: ${failure.file}\n${failure.error}`);
  }
  console.error(`${failures.length}/${sources.length} source files failed syntax check.`);
  process.exitCode = 1;
} else {
  console.log(`Syntax check passed for ${sources.length} JavaScript/MJS/CJS files.`);
}