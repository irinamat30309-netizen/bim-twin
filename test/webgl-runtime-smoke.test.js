'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createGpuLasSample } = require('../qa/windows-gpu-smoke/las-sample.cjs');

const root = path.resolve(__dirname, '..');
const fixture = path.join(root, 'qa', 'windows-gpu-smoke');
const GPU_STRESS_MS = readBoundedInteger('BIMTWIN_GPU_WEBGL_STRESS_MS', 10000, 8000, 600000);
const isWindowsGpuRunner = process.platform === 'win32' && (
  process.env.BIMTWIN_GPU_SMOKE === '1' ||
  (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'self-hosted')
);

function readBoundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}; received ${raw}`);
  }
  return value;
}

function readNvidiaSmiTelemetry() {
  const output = execFileSync('nvidia-smi', [
    '--query-gpu=name,temperature.gpu,utilization.gpu,memory.used',
    '--format=csv,noheader,nounits'
  ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const devices = output.split(/\r?\n/).map((line) => {
    const [name, temperature, utilization, memory] = line.split(',').map((part) => part.trim());
    return {
      name,
      temperatureC: Number(temperature),
      utilizationPct: Number(utilization),
      memoryUsedMiB: Number(memory)
    };
  }).filter((device) => device.name);

  const expectedAdapter = String(process.env.BIMTWIN_GPU_EXPECTED_ADAPTER || '').trim().toLowerCase();
  const device = expectedAdapter
    ? devices.find((candidate) => candidate.name.toLowerCase().includes(expectedAdapter))
    : devices[0];
  assert.ok(device, `nvidia-smi did not report the expected GPU (${expectedAdapter || 'any NVIDIA GPU'}): ${output}`);
  assert.ok(Number.isFinite(device.temperatureC), `Could not read GPU temperature: ${output}`);
  assert.ok(Number.isFinite(device.utilizationPct), `Could not read GPU utilization: ${output}`);
  assert.ok(Number.isFinite(device.memoryUsedMiB), `Could not read GPU memory use: ${output}`);
  return device;
}

function stopProcessTree(pid, child) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (_) {
    try { child.kill('SIGKILL'); } catch (_) {}
  }
}

test('self-hosted Windows GPU: production WebGL viewer draws a synthetic or real LAS cloud', {
  skip: isWindowsGpuRunner ? false : 'requires the private self-hosted Windows GPU runner',
  timeout: Math.max(
    process.env.BIMTWIN_GPU_LAS_PATH ? 30 * 60 * 1000 : 3 * 60 * 1000,
    GPU_STRESS_MS + 3 * 60 * 1000
  )
}, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-webgl-gpu-'));
  const resultFile = path.join(tempDir, 'result.json');
  let stdout = '';
  let stderr = '';
  let child;
  let gpuMonitorTimer = null;
  let gpuMonitorError = null;
  let lasSample = null;
  let lasParseDurationMs = 0;
  const maxGpuTempC = process.env.BIMTWIN_GPU_MAX_TEMP_C == null
    ? 0
    : Number(process.env.BIMTWIN_GPU_MAX_TEMP_C);
  const gpuMonitorIntervalMs = readBoundedInteger(
    'BIMTWIN_GPU_MONITOR_INTERVAL_MS',
    10000,
    1000,
    60000
  );
  assert.ok(
    maxGpuTempC === 0 || (Number.isFinite(maxGpuTempC) && maxGpuTempC >= 40 && maxGpuTempC <= 100),
    `BIMTWIN_GPU_MAX_TEMP_C must be 0 or between 40 and 100; received ${process.env.BIMTWIN_GPU_MAX_TEMP_C}`
  );
  const gpuTelemetry = [];
  const recordGpuTelemetry = (stage) => {
    const sample = readNvidiaSmiTelemetry();
    const record = {
      stage,
      name: sample.name,
      temperatureC: sample.temperatureC,
      utilizationPct: sample.utilizationPct,
      memoryUsedMiB: sample.memoryUsedMiB
    };
    gpuTelemetry.push(record);
    console.log(`[BIMTWIN_GPU_TELEMETRY] ${JSON.stringify(record)}`);
    if (maxGpuTempC > 0 && sample.temperatureC >= maxGpuTempC) {
      throw new Error(
        `GPU safety stop: ${sample.name} reached ${sample.temperatureC}°C ` +
        `(configured limit ${maxGpuTempC}°C).`
      );
    }
  };

  try {
    const electronPath = require('electron');
    assert.equal(typeof electronPath, 'string', 'Electron must be installed by npm ci');
    assert.ok(fs.existsSync(electronPath), `Electron executable not found: ${electronPath}`);

    const childEnv = {
      ...process.env,
      BIMTWIN_WEBGL_SMOKE_RESULT: resultFile,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    };
    const lasPath = String(process.env.BIMTWIN_GPU_LAS_PATH || '').trim();
    if (lasPath) {
      const parseStarted = Date.now();
      let lastPhase = '';
      let lastProgress = -1;
      lasSample = createGpuLasSample(lasPath, tempDir, {
        maxPoints: Number(process.env.BIMTWIN_GPU_LAS_MAX_POINTS || 1000000),
        onProgress: (progress) => {
          const event = progress && typeof progress === 'object' ? progress : {};
          const phase = String(event.phase || 'parse');
          const fraction = Number(event.fraction);
          if (phase !== lastPhase || (Number.isFinite(fraction) && fraction - lastProgress >= 0.1) ||
              (Number.isFinite(fraction) && fraction >= 0.99)) {
            const percent = Number.isFinite(fraction) ? ` ${Math.round(fraction * 100)}%` : '';
            const pointProgress = Number.isFinite(event.pointsRead) && Number.isFinite(event.pointsTotal)
              ? ` points=${event.pointsRead}/${event.pointsTotal}`
              : '';
            console.log(`[BIMTWIN_GPU_LAS_PARSE] ${phase}${percent}${pointProgress}`);
            lastPhase = phase;
            lastProgress = Number.isFinite(fraction) ? fraction : lastProgress;
          }
        }
      });
      lasParseDurationMs = Date.now() - parseStarted;
      const expectedTotalPoints = Number(process.env.BIMTWIN_GPU_LAS_EXPECTED_POINTS || 0);
      if (expectedTotalPoints > 0) {
        assert.equal(
          lasSample.metadata.totalPoints,
          expectedTotalPoints,
          'The local LAS point count did not match the expected source scan.'
        );
      }
      childEnv.BIMTWIN_GPU_WEBGL_SAMPLE_FILE = lasSample.samplePath;
      childEnv.BIMTWIN_GPU_WEBGL_SAMPLE_META_FILE = lasSample.metadataPath;
      console.log(`[BIMTWIN_GPU_LAS_PARSE] ${JSON.stringify({
        format: lasSample.metadata.format,
        fileBytes: lasSample.metadata.fileBytes,
        totalPoints: lasSample.metadata.totalPoints,
        samplePoints: lasSample.metadata.samplePoints,
        parseDurationMs: lasParseDurationMs
      })}`);
    }

    if (maxGpuTempC > 0) recordGpuTelemetry('before');

    child = spawn(electronPath, [fixture], {
      cwd: root,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 50000) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 50000) stderr += chunk.toString();
    });

    if (maxGpuTempC > 0) {
      gpuMonitorTimer = setInterval(() => {
        if (!child || child.exitCode != null || gpuMonitorError) return;
        try {
          recordGpuTelemetry('during');
        } catch (error) {
          gpuMonitorError = error;
          stopProcessTree(child.pid, child);
        }
      }, gpuMonitorIntervalMs);
    }

    const exit = await new Promise((resolve, reject) => {
      const childTimeoutMs = Math.max(lasSample ? 300000 : 60000, GPU_STRESS_MS + 180000);
      const clearGpuMonitor = () => {
        if (gpuMonitorTimer) {
          clearInterval(gpuMonitorTimer);
          gpuMonitorTimer = null;
        }
      };
      const timer = setTimeout(() => {
        stopProcessTree(child.pid, child);
        reject(new Error(`Electron WebGL smoke timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, childTimeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        clearGpuMonitor();
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        clearGpuMonitor();
        resolve({ code, signal });
      });
    });

    if (gpuMonitorError) {
      throw new Error(`${gpuMonitorError.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    assert.equal(exit.code, 0, `Electron smoke process failed (${exit.signal}).\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    if (maxGpuTempC > 0) recordGpuTelemetry('after');
    assert.ok(fs.existsSync(resultFile), `GPU smoke result was not written.\nstdout:\n${stdout}\nstderr:\n${stderr}`);

    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.webgl2, true, JSON.stringify(result, null, 2));
    const expectedSamplePoints = lasSample ? lasSample.metadata.samplePoints : 1000000;
    assert.equal(result.source, lasSample ? 'las' : 'synthetic', JSON.stringify(result, null, 2));
    assert.equal(result.pointsUploaded, expectedSamplePoints, JSON.stringify(result, null, 2));
    if (lasSample) {
      assert.equal(result.las && result.las.format, lasSample.metadata.format, JSON.stringify(result, null, 2));
      assert.equal(result.las && result.las.fileBytes, lasSample.metadata.fileBytes, JSON.stringify(result, null, 2));
      assert.equal(result.las && result.las.totalPoints, lasSample.metadata.totalPoints, JSON.stringify(result, null, 2));
      assert.equal(result.las && result.las.samplePoints, lasSample.metadata.samplePoints, JSON.stringify(result, null, 2));
      assert.equal(result.las && result.las.hasColor, lasSample.metadata.hasColor, JSON.stringify(result, null, 2));
      assert.equal(result.las && result.las.hasIntensity, lasSample.metadata.hasIntensity, JSON.stringify(result, null, 2));
      assert.equal(result.las && result.las.hasClassification, lasSample.metadata.hasClassification, JSON.stringify(result, null, 2));
    }
    assert.equal(result.intensityBuffer, true, JSON.stringify(result, null, 2));
    assert.equal(result.classificationBuffer, true, JSON.stringify(result, null, 2));
    assert.equal(result.colorMode, 'classification', JSON.stringify(result, null, 2));
    assert.ok(result.changedPixels > 20, `Expected visible WebGL output; result: ${JSON.stringify(result)}`);
    assert.equal(result.glError, 0, `WebGL error ${result.glError}; result: ${JSON.stringify(result)}`);
    assert.equal(result.contextLost, false, JSON.stringify(result, null, 2));
    assert.equal(result.gpuStress && result.gpuStress.points, expectedSamplePoints, JSON.stringify(result, null, 2));
    const requiredStressDurationMs = GPU_STRESS_MS >= 60000 ? GPU_STRESS_MS - 1000 : 8000;
    assert.ok(
      result.gpuStress.durationMs >= requiredStressDurationMs,
      `GPU render load was too short; requested=${GPU_STRESS_MS}ms result=${JSON.stringify(result.gpuStress)}`
    );
    assert.ok(result.gpuStress.renderFrames >= 30, `Too few production render frames: ${JSON.stringify(result.gpuStress)}`);
    if (GPU_STRESS_MS >= 60000) {
      assert.ok(
        Number.isFinite(result.gpuStress.averageFps) && result.gpuStress.averageFps >= 20,
        `Production WebGL performance dropped below 20 FPS: ${JSON.stringify(result.gpuStress)}`
      );
      if (maxGpuTempC > 0) {
        const minimumTelemetrySamples = Math.max(2, Math.floor(GPU_STRESS_MS / (gpuMonitorIntervalMs * 2)));
        assert.ok(
          gpuTelemetry.length >= minimumTelemetrySamples,
          `Too few GPU thermal-safety samples (${gpuTelemetry.length}; expected at least ${minimumTelemetrySamples}).`
        );
        const duringSamples = gpuTelemetry.filter((sample) => sample.stage === 'during');
        assert.ok(
          duringSamples.some((sample) => sample.utilizationPct > 0),
          `nvidia-smi never reported nonzero RTX 5070 utilization during the soak test: ${JSON.stringify(duringSamples)}`
        );
      }
    }

    const gpuFeatures = result.gpu && result.gpu.featureStatus || {};
    const webglStatus = String(gpuFeatures.webgl2 || gpuFeatures.webgl || '');
    assert.match(webglStatus, /enabled/i, `WebGL GPU feature is not enabled: ${JSON.stringify(gpuFeatures)}`);

    const rendererEvidence = [
      result.renderer,
      result.vendor,
      ...(result.gpu && result.gpu.activeAdapters || []).map((adapter) => adapter.name)
    ].join(' ');
    assert.ok(rendererEvidence.trim(), `No GPU renderer information was reported: ${JSON.stringify(result)}`);
    assert.doesNotMatch(
      rendererEvidence,
      /swiftshader|llvmpipe|software rasterizer|microsoft basic render driver|\bwarp\b/i,
      `WebGL fell back to a software renderer: ${rendererEvidence}`
    );
    const isNvidiaVendor = (vendorId) => {
      const value = String(vendorId == null ? '' : vendorId).trim().toLowerCase();
      const numeric = /^0x[0-9a-f]+$/i.test(value)
        ? Number.parseInt(value.slice(2), 16)
        : (/^\d+$/.test(value) ? Number(value) : NaN);
      return numeric === 0x10de;
    };
    const nvidiaAdapter = (result.gpu && result.gpu.activeAdapters || [])
      .find((adapter) => isNvidiaVendor(adapter.vendorId) || /nvidia/i.test(adapter.name || ''));
    assert.ok(nvidiaAdapter || /nvidia/i.test(rendererEvidence),
      `The NVIDIA adapter is not active: ${JSON.stringify(result.gpu && result.gpu.activeAdapters || [])}; renderer=${rendererEvidence}`);
    const expectedAdapter = String(process.env.BIMTWIN_GPU_EXPECTED_ADAPTER || '').trim();
    if (expectedAdapter) {
      const escapedAdapter = expectedAdapter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(
        rendererEvidence,
        new RegExp(escapedAdapter, 'i'),
        `The expected GPU model was not reported by WebGL: ${rendererEvidence}`
      );
    }

    const gpuTelemetrySummary = gpuTelemetry.length
      ? {
        samples: gpuTelemetry.length,
        peakTemperatureC: Math.max(...gpuTelemetry.map((sample) => sample.temperatureC)),
        peakUtilizationPct: Math.max(...gpuTelemetry.map((sample) => sample.utilizationPct)),
        averageUtilizationPct: Math.round(
          gpuTelemetry.reduce((sum, sample) => sum + sample.utilizationPct, 0) / gpuTelemetry.length * 10
        ) / 10,
        temperatureLimitC: maxGpuTempC || null
      }
      : null;
    console.log(`[BIMTWIN_GPU_WEBGL] ${JSON.stringify({
      source: result.source,
      las: result.las,
      lasParseDurationMs,
      renderer: result.renderer,
      vendor: result.vendor,
      activeAdapters: result.gpu && result.gpu.activeAdapters || [],
      pointsUploaded: result.pointsUploaded,
      gpuStress: result.gpuStress,
      gpuTelemetry: gpuTelemetrySummary,
      nvidiaAdapterDetected: !!nvidiaAdapter || /nvidia/i.test(rendererEvidence),
      changedPixels: result.changedPixels,
      webgl2: webglStatus
    })}`);
  } finally {
    if (gpuMonitorTimer) clearInterval(gpuMonitorTimer);
    if (child && child.exitCode == null) stopProcessTree(child.pid, child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});