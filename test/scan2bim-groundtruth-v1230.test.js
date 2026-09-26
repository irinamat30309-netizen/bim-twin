'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../renderer/scan2bim.js');
const { parseCloudFile } = require('../las-node.js');
const ExportHub = require('../renderer/export-hub.js');

// Analytic 6 × 4 × 3 m interior. All generated geometry has known dimensions.
function analyticScene({ column = false, beam = false, cable = false, opening = false } = {}) {
  const pts = [], W = 6, D = 4, H = 3, step = 0.05;
  for (let i = 0; i <= W / step; i++) for (let k = 0; k <= H / step; k++) {
    const x = i * step, y = k * step;
    pts.push([x, y, 0], [x, y, D]);
  }
  for (let j = 0; j <= D / step; j++) for (let k = 0; k <= H / step; k++) {
    const z = j * step, y = k * step;
    if (!(opening && y < 2.1 && z >= 1 && z <= 1.9)) pts.push([0, y, z]);
    pts.push([W, y, z]);
  }
  for (let i = 0; i <= W / 0.1; i++) for (let j = 0; j <= D / 0.1; j++) {
    const x = i * 0.1, z = j * 0.1;
    pts.push([x, 0, z], [x, H, z]);
  }
  if (column) {
    // Ground truth: circular column, diameter 0.4 m, vertical extent 0.1–2.9 m.
    for (let y = 0.1; y <= H - 0.1; y += 0.04) for (let a = 0; a < 20; a++) {
      const t = a / 20 * Math.PI * 2;
      pts.push([1.5 + Math.cos(t) * 0.2, y, 1 + Math.sin(t) * 0.2]);
    }
  }
  if (beam) {
    // Ground truth: rectangular beam 4.8 m long, 0.3 m wide, 0.12 m high.
    for (let x = 0.6; x <= 5.4; x += 0.03) for (let zoff = -0.15; zoff <= 0.15; zoff += 0.03) {
      for (let y = 2.78; y <= 2.9; y += 0.04) pts.push([x, y, 2 + zoff]);
    }
  }
  if (cable) {
    // Ground truth: one vertical cable from ceiling to y=1.4 m, sampled every 0.08 m.
    for (let y = 1.4; y <= H; y += 0.08) pts.push([3.06, y, 2.1]);
  }
  return pts;
}

function reconstruct(points, opts = {}) {
  const model = S.reconstruct(points, { voxel: 0.04, ...opts });
  assert.equal(model.ok, true, model.error || 'Scan-to-BIM reconstruction failed');
  return model;
}

test('ground-truth room: floor area, height and column dimensions stay within tolerance', () => {
  const model = reconstruct(analyticScene({ column: true }));
  assert.equal(model.stats.wallCount, 4);
  assert.ok(Math.abs(model.stats.floorArea - 24) <= 0.5, `floor area=${model.stats.floorArea}`);
  assert.ok(Math.abs(model.storey.height - 3) <= 0.1, `height=${model.storey.height}`);
  const column = model.objects.find(item => item.kind === 'column');
  assert.ok(column, 'known column was not classified');
  assert.ok(Math.abs(column.cx - 1.5) <= 0.08, `column X=${column.cx}`);
  assert.ok(Math.abs(column.cz - 1) <= 0.08, `column Z=${column.cz}`);
  assert.ok(Math.abs(2 * column.hx - 0.4) <= 0.08, `column X width=${2 * column.hx}`);
  assert.ok(Math.abs(2 * column.hz - 0.4) <= 0.08, `column Z width=${2 * column.hz}`);
  assert.ok(2 * column.hy >= 2.5 && 2 * column.hy <= 2.9, `column height=${2 * column.hy}`);
});

test('beam-only structural scene must not produce automatic pipe or cable candidates', () => {
  const model = reconstruct(analyticScene({ column: true, beam: true }));
  assert.equal(model.stats.beamCount, 1);
  assert.ok(Math.abs(model.beams[0].length - 4.8) <= 0.2, `beam length=${model.beams[0].length}`);
  assert.ok(Math.abs(model.beams[0].width - 0.3) <= 0.08, `beam width=${model.beams[0].width}`);
  assert.equal(model.stats.pipeSuppressedByBeamCount, 2, 'beam-edge pipe candidates should be counted as suppressed');
  assert.equal(model.stats.pipeCount, 0, `false pipes: ${JSON.stringify(model.pipes)}`);
  assert.equal(model.stats.cableCount, 0, `false cables: ${JSON.stringify(model.cables)}`);
});

test('real ceiling cable remains detectable after false-positive suppression', () => {
  const model = reconstruct(analyticScene({ cable: true }));
  assert.equal(model.stats.cableCount, 1, `cables=${JSON.stringify(model.cables)}`);
  const cable = model.cables[0];
  assert.ok(Math.abs(cable.x - 3.06) <= 0.12, `cable X=${cable.x}`);
  assert.ok(Math.abs(cable.z - 2.1) <= 0.12, `cable Z=${cable.z}`);
  assert.ok(cable.drop >= 1.3 && cable.drop <= 1.7, `cable drop=${cable.drop}`);
});

test('synthetic LAS and PLY room fixtures preserve parsing and geometric ground truth', () => {
  const points = analyticScene({ column: true, opening: true });
  const count = points.length;
  const viewerPos = Float64Array.from(points.flat());
  const lasPos = new Float64Array(viewerPos.length);
  for (let i = 0; i < count; i++) {
    const offset = i * 3;
    // Convert the viewer's Y-up coordinates to LAS world X/Y/Z (Z-up).
    lasPos[offset] = viewerPos[offset];
    lasPos[offset + 1] = -viewerPos[offset + 2];
    lasPos[offset + 2] = viewerPos[offset + 1];
  }

  const fixtures = [
    {
      ext: 'las',
      axis: 'zup',
      bytes: ExportHub.exportLAS({
        pos: lasPos, count, meta: { srcXform: { axis: 'zup', t: [0, 0, 0] }, units: 'm' }
      })
    },
    {
      ext: 'ply',
      axis: 'yup',
      bytes: ExportHub.exportPLY({
        pos: viewerPos, count, meta: { srcXform: { axis: 'yup', t: [0, 0, 0] }, units: 'm' }
      })
    }
  ];
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-room-roundtrip-'));
  try {
    for (const fixture of fixtures) {
      const file = path.join(fixtureDir, `room.${fixture.ext}`);
      fs.writeFileSync(file, fixture.bytes);
      const parsed = parseCloudFile(file, { maxPoints: 100_000 });
      assert.equal(parsed.ok, true, `${fixture.ext}: ${parsed.message || 'fixture parse failed'}`);
      assert.equal(parsed.count, count, `${fixture.ext}: point count`);
      assert.equal(parsed.meta.srcXform.axis, fixture.axis, `${fixture.ext}: source axis`);
      const model = reconstruct(parsed.pos, {
        voxel: 0.03, wallThreshold: 0.05, minWallLen: 0.4,
        defaultThickness: 0.15, snapAngles: true, closeCorners: true
      });
      assert.equal(model.stats.wallCount, 4, `${fixture.ext}: wall count`);
      assert.equal(model.stats.openingCount, 1, `${fixture.ext}: opening count`);
      assert.ok(Math.abs(model.storey.height - 3) <= 0.15, `${fixture.ext}: height=${model.storey.height}`);
      assert.ok(Math.abs(model.stats.floorArea - 24) <= 0.5, `${fixture.ext}: floor area=${model.stats.floorArea}`);
      assert.equal(model.stats.columnCount, 1, `${fixture.ext}: column count`);
      assert.equal(model.stats.pipeCount, 0, `${fixture.ext}: false pipes: ${JSON.stringify(model.pipes)}`);
      assert.equal(model.stats.cableCount, 0, `${fixture.ext}: false cables: ${JSON.stringify(model.cables)}`);
      assert.equal(model.stats.beamCount, 0, `${fixture.ext}: false beams: ${JSON.stringify(model.beams)}`);
    }
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
