'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readGpuSmokeConfig } = require('../qa/windows-gpu-smoke/config.cjs');

test('GPU smoke config accepts the requested 10-minute RTX telemetry settings', () => {
  assert.deepEqual(readGpuSmokeConfig({
    BIMTWIN_GPU_WEBGL_STRESS_MS: '600000',
    BIMTWIN_GPU_MONITOR_INTERVAL_MS: '10000',
    BIMTWIN_GPU_MAX_TEMP_C: '82',
    BIMTWIN_GPU_EXPECTED_ADAPTER: 'RTX 5070'
  }), {
    stressMs: 600000,
    monitorIntervalMs: 10000,
    maximumTemperatureC: 82,
    expectedAdapter: 'RTX 5070'
  });
});

test('GPU smoke config has a short safe default outside the private runner', () => {
  assert.deepEqual(readGpuSmokeConfig({}), {
    stressMs: 10000,
    monitorIntervalMs: 10000,
    maximumTemperatureC: 82,
    expectedAdapter: 'RTX 5070'
  });
});

test('GPU smoke config rejects out-of-range stress and temperature settings', () => {
  assert.throws(
    () => readGpuSmokeConfig({ BIMTWIN_GPU_WEBGL_STRESS_MS: '600001' }),
    /BIMTWIN_GPU_WEBGL_STRESS_MS must be an integer from 1000 to 600000/
  );
  assert.throws(
    () => readGpuSmokeConfig({ BIMTWIN_GPU_MAX_TEMP_C: '0' }),
    /BIMTWIN_GPU_MAX_TEMP_C must be an integer from 1 to 120/
  );
});