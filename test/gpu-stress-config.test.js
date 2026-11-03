'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_GPU_STRESS_MS,
  MIN_GPU_STRESS_MS,
  MAX_GPU_STRESS_MS,
  getGpuStressMs
} = require('../qa/windows-gpu-smoke/config.cjs');

test('GPU WebGL stress uses the default duration when not configured', () => {
  assert.equal(getGpuStressMs({}), DEFAULT_GPU_STRESS_MS);
});

test('GPU WebGL stress honors a valid configured duration', () => {
  assert.equal(getGpuStressMs({ BIMTWIN_GPU_WEBGL_STRESS_MS: '600000' }), 600000);
});

test('GPU WebGL stress clamps durations to its safe test range', () => {
  assert.equal(getGpuStressMs({ BIMTWIN_GPU_WEBGL_STRESS_MS: '1' }), MIN_GPU_STRESS_MS);
  assert.equal(getGpuStressMs({ BIMTWIN_GPU_WEBGL_STRESS_MS: '900000' }), MAX_GPU_STRESS_MS);
});

test('GPU WebGL stress ignores invalid duration values', () => {
  assert.equal(getGpuStressMs({ BIMTWIN_GPU_WEBGL_STRESS_MS: 'invalid' }), DEFAULT_GPU_STRESS_MS);
});