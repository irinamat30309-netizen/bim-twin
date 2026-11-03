import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SBOM_ARGS = ['sbom', '--package-lock-only', '--sbom-format=cyclonedx'];

export function parseCycloneDx(stdout) {
  let bom;
  try {
    bom = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm sbom returned invalid JSON: ${error.message}`);
  }
  if (!bom || bom.bomFormat !== 'CycloneDX' || !Array.isArray(bom.components)) {
    throw new Error('npm sbom output is not a CycloneDX document with components.');
  }
  return bom;
}

export function licenseReviewCandidates(bom) {
  if (!bom || !Array.isArray(bom.components)) {
    throw new TypeError('SBOM components must be an array.');
  }
  return bom.components.filter(component => {
    const licenseText = (component.licenses || []).flatMap(entry => [
      entry.expression,
      entry.license && entry.license.id,
      entry.license && entry.license.name
    ]).filter(Boolean).join(' ');
    return /(?:AGPL|LGPL|GPL|SSPL)(?:[-\s(]|$)/i.test(licenseText);
  }).map(component => ({
    name: component.name || '(unnamed)',
    version: component.version || '',
    licenses: (component.licenses || []).map(entry =>
      entry.expression || (entry.license && (entry.license.id || entry.license.name)) || ''
    ).filter(Boolean)
  }));
}

function runNpmSbom() {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const args = npmExecPath ? [npmExecPath, ...SBOM_ARGS] : SBOM_ARGS;
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: !npmExecPath && process.platform === 'win32'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm sbom failed with exit code ${result.status}: ${(result.stderr || '').trim()}`);
  }
  return parseCycloneDx(result.stdout);
}

function main() {
  const outputPath = path.resolve(process.argv[2] || 'dist/bim-twin-dependency-sbom.cdx.json');
  const bom = runNpmSbom();
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(bom, null, 2)}\n`, 'utf8');

  const candidates = licenseReviewCandidates(bom);
  console.log(`CycloneDX SBOM written: ${outputPath} (${bom.components.length} components).`);
  if (candidates.length) {
    console.warn('License review required for copyleft or dual-license expressions:');
    for (const item of candidates) {
      console.warn(`- ${item.name}${item.version ? `@${item.version}` : ''}: ${item.licenses.join(', ')}`);
    }
  }
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  try {
    main();
  } catch (error) {
    console.error(`SBOM generation failed: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}