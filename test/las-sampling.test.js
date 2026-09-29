'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const core = require('../las-core');

test('keepSampledIndex: stride<=1 keeps everything', () => {
  for (let i = 0; i < 100; i++) assert.strictEqual(core.keepSampledIndex(i, 1), true);
});

test('keepSampledIndex: exactly one point kept per stride window', () => {
  const stride = 7;
  const total = 7000; // 1000 full windows
  for (let w = 0; w < 1000; w++) {
    let kept = 0;
    for (let gi = w * stride; gi < (w + 1) * stride; gi++) {
      if (core.keepSampledIndex(gi, stride)) kept++;
    }
    assert.strictEqual(kept, 1, 'window ' + w + ' kept ' + kept);
  }
  // overall count ~= total/stride
  let all = 0; for (let gi = 0; gi < total; gi++) if (core.keepSampledIndex(gi, stride)) all++;
  assert.strictEqual(all, 1000);
});

test('sampleOffset stays within [0, stride)', () => {
  for (const stride of [2, 3, 5, 13, 64, 257]) {
    for (let w = 0; w < 5000; w++) {
      const o = core.sampleOffset(w, stride);
      assert.ok(o >= 0 && o < stride, 'offset ' + o + ' out of range for stride ' + stride);
    }
  }
});

test('sampleOffset breaks periodicity (kept offsets are not all identical)', () => {
  // Regression guard for the SLAM scanline-striping bug: a uniform every-N
  // sampler would keep the SAME within-window offset for every window.
  const stride = 11;
  const offsets = new Set();
  for (let w = 0; w < 400; w++) offsets.add(core.sampleOffset(w, stride));
  assert.ok(offsets.size >= stride - 2, 'offsets not well distributed: ' + offsets.size);
});

test('sampleOffset is deterministic (Node == browser fallback)', () => {
  const stride = 9;
  for (let w = 0; w < 1000; w++) {
    let h = (w * 2654435761) >>> 0; h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
    const browser = (h >>> 0) % stride;
    assert.strictEqual(core.sampleOffset(w, stride), browser);
  }
});
