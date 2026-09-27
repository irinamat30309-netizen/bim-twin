'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Stage 14 accepts CycloneDX and reports copyleft license expressions', async () => {
  const { parseCycloneDx, licenseReviewCandidates } = await import('../scripts/generate-sbom.mjs');
  const bom = parseCycloneDx(JSON.stringify({
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    components: [
      { name: 'mit-only', version: '1.0.0', licenses: [{ license: { id: 'MIT' } }] },
      { name: 'gpl-library', version: '2.0.0', licenses: [{ license: { id: 'GPL-3.0' } }] },
      { name: 'dual-license', version: '3.0.0', licenses: [{ expression: '(MIT OR GPL-3.0-or-later)' }] },
      { name: 'agpl-library', version: '4.0.0', licenses: [{ license: { id: 'AGPL-3.0' } }] }
    ]
  }));

  assert.equal(bom.specVersion, '1.5');
  assert.deepEqual(licenseReviewCandidates(bom).map(item => item.name), [
    'gpl-library',
    'dual-license',
    'agpl-library'
  ]);
});

test('Stage 14 rejects malformed and non-CycloneDX SBOM input', async () => {
  const { parseCycloneDx } = await import('../scripts/generate-sbom.mjs');
  assert.throws(() => parseCycloneDx('{'), /invalid JSON/);
  assert.throws(() => parseCycloneDx(JSON.stringify({ bomFormat: 'SPDX' })), /not a CycloneDX/);
});