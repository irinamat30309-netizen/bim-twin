'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readGpuSmokeConfig } = require('../qa/windows-gpu-smoke/config.cjs');

const root = path.resolve(__dirname, '..');
const fixture = path.join(root, 'qa', 'windows-gpu-smoke');
const isWindowsGpuRunner = process.platform === 'win32' && (
  process.env.BIMTWIN_GPU_SMOKE === '1' ||
  (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'self-hosted')
);

function stopProcessTree(pid, child) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (_) {
    try { child.kill('SIGKILL'); } catch (_) {}
  }
}

function captureGpuTelemetry(expectedAdapter) {
  const output = execFileSync('nvidia-smi', [
    '--query-gpu=name,temperature.gpu,utilization.gpu,memory.used',
    '--format=csv,noheader,nounits'
  ], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true
  });
  const row = output.split(/\r?\n/).map((line) => line.trim())
    .find((line) => line.toLowerCase().includes(expectedAdapter.toLowerCase()));
  if (!row) throw new Error(`nvidia-smi did not report ${expectedAdapter}: ${output.trim()}`);

  const [name, temperatureText, utilizationText, memoryText] = row.split(',').map((part) => part.trim());
  const temperatureC = Number(temperatureText);
  const utilizationPercent = Number(utilizationText.replace(/%/g, ''));
  const memoryMiB = Number(memoryText.replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(temperatureC) || !Number.isFinite(utilizationPercent)) {
    throw new Error(`Invalid ${expectedAdapter} telemetry row: ${row}`);
  }
  return {
    name,
    temperatureC,
    utilizationPercent,
    memoryMiB: Number.isFinite(memoryMiB) ? memoryMiB : null
  };
}

function startGpuMonitor(child, expectedAdapter, intervalMs, maximumTemperatureC) {
  const samples = [];
  let failure = null;
  let busy = false;
  let timer;

  const sample = () => {
    if (busy || failure || child.exitCode != null) return;
    busy = true;
    try {
      const reading = captureGpuTelemetry(expectedAdapter);
      samples.push({ at: new Date().toISOString(), ...reading });
      if (reading.temperatureC >= maximumTemperatureC) {
        failure = new Error(
          `${expectedAdapter} reached ${reading.temperatureC} C (safety limit ${maximumTemperatureC} C); stopping the WebGL stress test.`
        );
        stopProcessTree(child.pid, child);
      }
    } catch (error) {
      failure = error;
      stopProcessTree(child.pid, child);
    } finally {
      busy = false;
    }
  };

  sample();
  timer = setInterval(sample, intervalMs);
  timer.unref();
  return {
    samples,
    get failure() { return failure; },
    stop() { if (timer) clearInterval(timer); }
  };
}

test('self-hosted Windows GPU: production WebGL viewer uploads and draws a classified cloud', {
  skip: isWindowsGpuRunner ? false : 'requires the private self-hosted Windows GPU runner'
}, async (t) => {
  const gpuConfig = readGpuSmokeConfig(process.env);
  const gpuStressMs = gpuConfig.stressMs;
  const gpuMonitorIntervalMs = gpuConfig.monitorIntervalMs;
  const gpuMaximumTemperatureC = gpuConfig.maximumTemperatureC;
  const expectedAdapter = gpuConfig.expectedAdapter;
  const timeoutMs = Math.max(60000, gpuStressMs + 600000);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-webgl-gpu-'));
  const resultFile = path.join(tempDir, 'result.json');
  let stdout = '';
  let stderr = '';
  let child;
  let gpuMonitor;

  try {
    const electronPath = require('electron');
    assert.equal(typeof electronPath, 'string', 'Electron must be installed by npm ci');
    assert.ok(fs.existsSync(electronPath), `Electron executable not found: ${electronPath}`);

    child = spawn(electronPath, [fixture], {
      cwd: root,
      env: {
        ...process.env,
        BIMTWIN_WEBGL_SMOKE_RESULT: resultFile,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    gpuMonitor = startGpuMonitor(
      child,
      expectedAdapter,
      gpuMonitorIntervalMs,
      gpuMaximumTemperatureC
    );
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 50000) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 50000) stderr += chunk.toString();
    });

    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        gpuMonitor.stop();
        stopProcessTree(child.pid, child);
        reject(new Error(`Electron WebGL smoke timed out after ${timeoutMs} ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        gpuMonitor.stop();
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        gpuMonitor.stop();
        resolve({ code, signal });
      });
    });

    if (gpuMonitor.failure) throw gpuMonitor.failure;
    assert.equal(exit.code, 0, `Electron smoke process failed (${exit.signal}).\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.ok(fs.existsSync(resultFile), `GPU smoke result was not written.\nstdout:\n${stdout}\nstderr:\n${stderr}`);

    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.webgl2, true, JSON.stringify(result, null, 2));
    assert.equal(result.syntheticCapabilities && result.syntheticCapabilities.pointsUploaded, 1000000, JSON.stringify(result, null, 2));
    assert.equal(result.pointsUploaded, result.gpuStress && result.gpuStress.points, JSON.stringify(result, null, 2));
    assert.equal(result.intensityBuffer, true, JSON.stringify(result, null, 2));
    assert.equal(result.classificationBuffer, true, JSON.stringify(result, null, 2));
    assert.equal(result.syntheticCapabilities && result.syntheticCapabilities.colorMode, 'classification', JSON.stringify(result, null, 2));
    assert.ok(result.changedPixels > 20, `Expected visible WebGL output; result: ${JSON.stringify(result)}`);
    assert.equal(result.glError, 0, `WebGL error ${result.glError}; result: ${JSON.stringify(result)}`);
    assert.equal(result.contextLost, false, JSON.stringify(result, null, 2));
    assert.ok(Number.isSafeInteger(result.gpuStress && result.gpuStress.points) && result.gpuStress.points > 0);
    assert.ok(
      result.gpuStress.durationMs >= Math.max(8000, gpuStressMs - 1000),
      `GPU render load was shorter than configured (${gpuStressMs} ms): ${JSON.stringify(result.gpuStress)}`
    );
    assert.ok(
      result.gpuStress.renderFrames >= Math.max(30, Math.floor((gpuStressMs / 1000) * 10)),
      `Too few production render frames for ${gpuStressMs} ms: ${JSON.stringify(result.gpuStress)}`
    );
    if (gpuConfig.lasPath) {
      assert.equal(result.gpuStress.source, 'user-las', JSON.stringify(result.gpuStress, null, 2));
      assert.ok(result.lasInput, 'The configured local LAS file was not imported.');
      assert.equal(result.lasInput.totalPoints, gpuConfig.expectedLasPoints, JSON.stringify(result.lasInput, null, 2));
      assert.equal(result.lasInput.sampledPoints, result.gpuStress.points, JSON.stringify(result.lasInput, null, 2));
      assert.ok(result.lasInput.sampledPoints <= gpuConfig.lasMaxPoints, JSON.stringify(result.lasInput, null, 2));
      assert.ok(Number.isFinite(result.lasInput.parseMs) && result.lasInput.parseMs > 0, JSON.stringify(result.lasInput, null, 2));
      assert.ok(result.lasInput.sectionBenchmark, JSON.stringify(result.lasInput, null, 2));
      assert.equal(result.lasInput.sectionBenchmark.samplePoints, result.lasInput.sampledPoints);
      assert.ok(result.lasInput.sectionBenchmark.slicedPoints <= result.lasInput.sampledPoints);
      assert.ok(Number.isFinite(result.lasInput.sectionBenchmark.elapsedMs));
      assert.ok(Array.isArray(result.lasInput.sectionBenchmark.phases));
    } else {
      assert.equal(result.gpuStress.source, 'synthetic', JSON.stringify(result.gpuStress, null, 2));
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

    const maximumUtilizationPercent = Math.max(
      0,
      ...gpuMonitor.samples.map((sample) => sample.utilizationPercent)
    );
    const maximumTemperatureC = Math.max(
      0,
      ...gpuMonitor.samples.map((sample) => sample.temperatureC)
    );
    const maximumMemoryMiB = Math.max(
      0,
      ...gpuMonitor.samples.map((sample) => sample.memoryMiB || 0)
    );
    if (gpuStressMs >= 60000) {
      assert.ok(gpuMonitor.samples.length >= 2, `Insufficient RTX telemetry samples: ${JSON.stringify(gpuMonitor.samples)}`);
      assert.ok(
        maximumUtilizationPercent > 0,
        `RTX telemetry showed no GPU utilization during the ${gpuStressMs} ms render stress. Samples: ${JSON.stringify(gpuMonitor.samples)}`
      );
    }

    t.diagnostic(`[BIMTWIN_GPU_WEBGL] ${JSON.stringify({
      renderer: result.renderer,
      vendor: result.vendor,
      activeAdapters: result.gpu && result.gpu.activeAdapters || [],
      pointsUploaded: result.pointsUploaded,
      gpuStress: result.gpuStress,
      gpuTelemetry: {
        sampleCount: gpuMonitor.samples.length,
        maximumTemperatureC,
        maximumUtilizationPercent,
        maximumMemoryMiB,
        maximumAllowedTemperatureC: gpuMaximumTemperatureC,
        sampleIntervalMs: gpuMonitorIntervalMs
      },
      nvidiaAdapterDetected: !!nvidiaAdapter || /nvidia/i.test(rendererEvidence),
      changedPixels: result.changedPixels,
      webgl2: webglStatus
    })}`);
  } finally {
    if (child && child.exitCode == null) stopProcessTree(child.pid, child);
    if (gpuMonitor) gpuMonitor.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});