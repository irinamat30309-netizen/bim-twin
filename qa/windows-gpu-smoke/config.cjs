'use strict';

function readPositiveInteger(env, name, fallback, minimum, maximum) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}; received ${raw}`);
  }
  return value;
}

function readGpuSmokeConfig(env = process.env) {
  return {
    stressMs: readPositiveInteger(env, 'BIMTWIN_GPU_WEBGL_STRESS_MS', 10000, 1000, 600000),
    monitorIntervalMs: readPositiveInteger(env, 'BIMTWIN_GPU_MONITOR_INTERVAL_MS', 10000, 1000, 60000),
    maximumTemperatureC: readPositiveInteger(env, 'BIMTWIN_GPU_MAX_TEMP_C', 82, 1, 120),
    expectedAdapter: env.BIMTWIN_GPU_EXPECTED_ADAPTER || 'RTX 5070'
  };
}

module.exports = { readGpuSmokeConfig };