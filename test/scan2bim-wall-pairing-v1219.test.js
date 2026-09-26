'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../renderer/scan2bim.js');

// A centred room is intentional: the previous wall-pairing heuristic compared
// absolute line offsets to the global origin, so opposite walls at +/-2 m were
// mistaken for two faces of one thin wall after a small scan tilt.
function room({ partition = false, tilt = 0, offset = [0, 0] } = {}) {
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const pts = [];
  const W = 6, D = 4, H = 3, step = 0.05;
  const a = tilt * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const add = (x, y, z) => {
    pts.push([x + offset[0], y * c - z * s, y * s + z * c + offset[1]]);
  };

  // Four exterior walls.
  for (let i = 0; i <= W / step; i++) for (let k = 0; k <= H / step; k++) {
    const x = -W / 2 + i * step, y = k * step;
    add(x, y, -D / 2);
    add(x, y, D / 2);
  }
  for (let j = 0; j <= D / step; j++) for (let k = 0; k <= H / step; k++) {
    const z = -D / 2 + j * step, y = k * step;
    add(-W / 2, y, z);
    add(W / 2, y, z);
  }

  // Optional internal partition with a 1.1 m × 2.1 m doorway.
  if (partition) {
    for (let i = 0; i <= W / step; i++) for (let k = 0; k <= H / step; k++) {
      const x = -W / 2 + i * step, y = k * step;
      if (x >= -0.55 && x <= 0.55 && y <= 2.1) continue;
      add(x, y, 0);
    }
  }

  // Floor and ceiling.
  for (let i = 0; i <= W / 0.1; i++) for (let j = 0; j <= D / 0.1; j++) {
    const x = -W / 2 + i * 0.1, z = -D / 2 + j * 0.1;
    add(x, 0, z);
    add(x, H, z);
  }

  // Deterministic outliers, so the regression also covers robust level finding.
  for (let i = 0; i < 300; i++) add(-5 + rnd() * 10, -1 + rnd() * 5, -4 + rnd() * 8);
  return pts;
}

function wallMid(w) {
  return [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
}

test('opposite symmetric walls are not merged into a phantom centre wall', () => {
  const flat = S.reconstruct(room());
  const tilted = S.reconstruct(room({ tilt: 2 }));
  const translated = S.reconstruct(room({ tilt: 2, offset: [13, -8] }));

  for (const [label, model] of [['flat', flat], ['tilted', tilted], ['translated', translated]]) {
    assert.equal(model.stats.wallCount, 4, `${label}: expected four perimeter walls, got ${model.stats.wallCount}`);
    const longWalls = model.walls.filter(w => w.length > 5.5);
    assert.equal(longWalls.length, 2, `${label}: should retain two opposite long walls`);
    assert.ok(longWalls.every(w => Math.abs(wallMid(w)[1] - (label === 'translated' ? -8 : 0)) > 1.4),
      `${label}: a phantom long wall was placed through the room centre`);
  }
  assert.ok(Math.abs(flat.stats.totalWallLength - tilted.stats.totalWallLength) < 0.3,
    'a 2° tilt must not remove an exterior wall');
});

test('door partition remains a fifth wall after a 2° tilt', () => {
  const flat = S.reconstruct(room({ partition: true }));
  const tilted = S.reconstruct(room({ partition: true, tilt: 2 }));

  assert.equal(flat.stats.wallCount, 5);
  assert.equal(tilted.stats.wallCount, 5);
  assert.equal(flat.stats.openingCount, 1);
  assert.equal(tilted.stats.openingCount, 1);
  assert.ok(Math.abs(flat.stats.floorArea - tilted.stats.floorArea) < 0.5);
  assert.ok(Math.abs(flat.stats.totalWallLength - tilted.stats.totalWallLength) < 0.3);
});