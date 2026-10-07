'use strict';
const test = require('node:test');
const assert = require('node:assert');
const RV = require('../renderer/realview.js');

test('suggestStations: grid within bbox at eye height', () => {
  const bbox = { mn: [0, 0, 0], mx: [20, 4, 20] };
  const st = RV.suggestStations(bbox, { spacing: 5, eyeHeight: 1.6 });
  assert.ok(st.length > 1, 'should produce a grid');
  for (const s of st) {
    assert.ok(s.pos[0] >= 0 && s.pos[0] <= 20);
    assert.ok(s.pos[2] >= 0 && s.pos[2] <= 20);
    assert.ok(Math.abs(s.pos[1] - 1.6) < 1e-6, 'eye height');
    assert.ok(s.id && s.name, 'has id/name');
  }
});

test('suggestStations: respects maxCount', () => {
  const st = RV.suggestStations({ mn: [0, 0, 0], mx: [100, 3, 100] }, { spacing: 1, maxCount: 10 });
  assert.ok(st.length <= 10);
});

test('suggestStations: always at least one station', () => {
  const st = RV.suggestStations({ mn: [0, 0, 0], mx: [0.1, 3, 0.1] }, { spacing: 5 });
  assert.strictEqual(st.length, 1);
});

test('nearest: finds closest station', () => {
  const st = [RV.makeStation([0, 1.6, 0], 'a', 'a'), RV.makeStation([10, 1.6, 10], 'b', 'b')];
  assert.strictEqual(RV.nearest(st, [9, 1.6, 9]).id, 'b');
  assert.strictEqual(RV.nearest(st, [1, 1.6, 1]).id, 'a');
  assert.strictEqual(RV.nearest([], [0, 0, 0]), null);
});

test('pickTeleport: chooses aligned nearest ahead', () => {
  const st = [
    RV.makeStation([0, 1.6, -5], 'ahead', 'ahead'),
    RV.makeStation([0, 1.6, 5], 'behind', 'behind'),
    RV.makeStation([5, 1.6, 0], 'side', 'side')
  ];
  const pick = RV.pickTeleport(st, [0, 1.6, 0], [0, 0, -1], {});
  assert.ok(pick && pick.id === 'ahead');
});

test('pickTeleport: returns null when nothing ahead', () => {
  const st = [RV.makeStation([0, 1.6, 5], 'behind', 'behind')];
  assert.strictEqual(RV.pickTeleport(st, [0, 1.6, 0], [0, 0, -1], {}), null);
});

test('serialize/deserialize roundtrip', () => {
  const st = [RV.makeStation([1, 2, 3], 'One', 's1')];
  st[0].panoUrl = 'p.jpg'; st[0].yaw = 1.2;
  const back = RV.deserialize(RV.serialize(st));
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0].id, 's1');
  assert.deepStrictEqual(back[0].pos, [1, 2, 3]);
  assert.strictEqual(back[0].panoUrl, 'p.jpg');
  assert.ok(Math.abs(back[0].yaw - 1.2) < 1e-9);
});
