'use strict';

const DEFAULT_GPU_STRESS_MS = 10_000;
const MIN_GPU_STRESS_MS = 8_000;
const MAX_GPU_STRESS_MS = 600_000;

function getGpuStressMs(env = process.env) {
  const requested = Number(env && env.BIMTWIN_GPU_WEBGL_STRESS_MS);
  if (!Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_GPU_STRESS_MS;
  }

  return Math.max(MIN_GPU_STRESS_MS, Math.min(MAX_GPU_STRESS_MS, Math.floor(requested)));
}

module.exports = {
  DEFAULT_GPU_STRESS_MS,
  MIN_GPU_STRESS_MS,
  MAX_GPU_STRESS_MS,
  getGpuStressMs
};