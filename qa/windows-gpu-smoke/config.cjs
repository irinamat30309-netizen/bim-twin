'use strict';

const DEFAULT_GPU_STRESS_MS = 10_000;
const MIN_GPU_STRESS_MS = 8_000;
const MAX_GPU_STRESS_MS = 600_000;

function readPositiveInteger(env, name, fallback, minimum, maximum) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}; received ${raw}`);
  }
  return value;
}

// Backward-compatible forgiving accessor used by older automation. The full
// readGpuSmokeConfig contract below is intentionally strict and should be used
// by new runners so a typo cannot silently weaken a hardware test.
function getGpuStressMs(env = process.env) {
  const requested = Number(env && env.BIMTWIN_GPU_WEBGL_STRESS_MS);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_GPU_STRESS_MS;
  return Math.max(MIN_GPU_STRESS_MS, Math.min(MAX_GPU_STRESS_MS, Math.floor(requested)));
}

function readGpuSmokeConfig(env = process.env) {
  const rawExpectedLasPoints = env.BIMTWIN_GPU_LAS_EXPECTED_POINTS;
  return {
    stressMs: readPositiveInteger(env, 'BIMTWIN_GPU_WEBGL_STRESS_MS', 10000, 1000, 600000),
    monitorIntervalMs: readPositiveInteger(env, 'BIMTWIN_GPU_MONITOR_INTERVAL_MS', 10000, 1000, 60000),
    maximumTemperatureC: readPositiveInteger(env, 'BIMTWIN_GPU_MAX_TEMP_C', 82, 1, 120),
    expectedAdapter: env.BIMTWIN_GPU_EXPECTED_ADAPTER || 'RTX 5070',
    lasPath: String(env.BIMTWIN_GPU_LAS_PATH || '').trim(),
    expectedLasPoints: rawExpectedLasPoints == null || String(rawExpectedLasPoints).trim() === ''
      ? null
      : readPositiveInteger(env, 'BIMTWIN_GPU_LAS_EXPECTED_POINTS', null, 1, Number.MAX_SAFE_INTEGER),
    lasMaxPoints: readPositiveInteger(env, 'BIMTWIN_GPU_LAS_MAX_POINTS', 1000000, 200000, 1000000)
  };
}

module.exports = {
  DEFAULT_GPU_STRESS_MS,
  MIN_GPU_STRESS_MS,
  MAX_GPU_STRESS_MS,
  getGpuStressMs,
  readGpuSmokeConfig
};