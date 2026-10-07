'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const LAS = require('../las-node');
let decoderAvailable = false;
try { require.resolve('@loaders.gl/las'); decoderAvailable = true; } catch (_) {}
const fixtures = path.join(__dirname, 'fixtures');
const fixturePresent = name => fs.existsSync(path.join(fixtures, name)) || fs.existsSync(path.join(fixtures, `${name}.b64`));
const missingFixtureReason = names => {
  if (!decoderAvailable) return 'optional LAZ decoder is not installed';
  const missing = names.find(name => !fixturePresent(name));
  return missing ? `optional LAZ fixture is not included: ${missing}` : false;
};

function fixtureBytes(name) {
  const rawPath = path.join(fixtures, name);
  if (fs.existsSync(rawPath)) return fs.readFileSync(rawPath);
  const encodedPath = `${rawPath}.b64`;
  if (!fs.existsSync(encodedPath)) return null;
  return Buffer.from(fs.readFileSync(encodedPath, 'ascii').trim(), 'base64');
}

async function withFixture(name, callback) {
  const rawPath = path.join(fixtures, name);
  if (fs.existsSync(rawPath)) return callback(rawPath);
  const bytes = fixtureBytes(name);
  if (!bytes) throw new Error(`LAZ fixture is missing: ${name}`);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-laz-fixture-'));
  const tempPath = path.join(tempDir, name);
  try {
    fs.writeFileSync(tempPath, bytes);
    return await callback(tempPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

for (const [name, version, pointFormat] of [
  ['laz12-sample.laz', '1.2', 3],
  ['laz14-sample.laz', '1.4', 8],
]) {
  test(`parseCloudFileAsync: decodes LAZ ${version}, point format ${pointFormat}, CRS and RGB`, {
    skip: missingFixtureReason([name])
  }, async () => {
    await withFixture(name, async file => {
      const r = await LAS.parseCloudFileAsync(file, { maxPoints: 200000 });
      assert.equal(r.ok, true, r.message);
      assert.equal(r.count, 4);
      assert.equal(r.meta.total, 4);
      assert.equal(r.meta.format, `LAZ ${version} fmt ${pointFormat}`);
      assert.equal(r.meta.pointsFormat, pointFormat);
      assert.match(r.meta.crsWkt, /EPSG.*32610/);
      assert.equal(r.meta.srcXform.axis, 'zup');
      assert.equal(r.intensity.length, 4);
      for (let i = 0; i < 4; i++) assert.ok(Math.abs(r.intensity[i] - [100, 200, 300, 400][i] / 65535) < 1e-8);
      assert.deepEqual(Array.from(r.classification), [2, 1, 2, 6]);
      assert.equal(r.col[0], 1); assert.equal(r.col[1], 0); assert.equal(r.col[2], 0);
      assert.equal(r.col[3], 0); assert.equal(r.col[4], 1); assert.equal(r.col[5], 0);
      const t = r.meta.srcXform.t;
      const firstWorld = [r.pos[0] + t[0], -r.pos[2] + t[1], r.pos[1] + t[2]];
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(Math.abs(firstWorld[axis] - [500000, 6000000, 100][axis]) <= 1e-6,
          `world coordinate ${axis}: ${firstWorld[axis]}`);
      }
    });
  });
}

test('parseCloudFile: sync entry gives a useful message for LAZ', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-sync-laz-'));
  const file = path.join(root, 'input.laz');
  try {
    fs.writeFileSync(file, 'placeholder; synchronous LAZ parsing is intentionally unsupported');
    const r = LAS.parseCloudFile(file);
    assert.equal(r.ok, false);
    assert.match(r.message, /parseCloudFileAsync/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('LAZ decimation respects the 200k point floor on a larger file', {
  skip: missingFixtureReason(['laz-decimation-200005.laz'])
}, async () => {
  await withFixture('laz-decimation-200005.laz', async file => {
    const r = await LAS.parseCloudFileAsync(file, { maxPoints: 200000 });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.meta.total, 200005);
    assert.equal(r.meta.decimation, 2);
    assert.equal(r.count, 100003);
    assert.ok(r.count <= 200000);
  });
});

test('LAZ regression fixtures remain compact', {
  skip: ['laz12-sample.laz', 'laz14-sample.laz', 'laz-decimation-200005.laz']
    .find(name => !fixturePresent(name)) ? 'optional LAZ fixtures are not included' : false
}, () => {
  assert.ok(fixtureBytes('laz12-sample.laz').length < 4096);
  assert.ok(fixtureBytes('laz14-sample.laz').length < 4096);
  assert.ok(fixtureBytes('laz-decimation-200005.laz').length < 100000);
});
