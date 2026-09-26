'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

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

test('self-hosted Windows GPU: production WebGL viewer uploads and draws a classified cloud', {
  skip: isWindowsGpuRunner ? false : 'requires the private self-hosted Windows GPU runner'
}, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bimtwin-webgl-gpu-'));
  const resultFile = path.join(tempDir, 'result.json');
  let stdout = '';
  let stderr = '';
  let child;

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

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 50000) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 50000) stderr += chunk.toString();
    });

    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stopProcessTree(child.pid, child);
        reject(new Error(`Electron WebGL smoke timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, 60000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });

    assert.equal(exit.code, 0, `Electron smoke process failed (${exit.signal}).\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.ok(fs.existsSync(resultFile), `GPU smoke result was not written.\nstdout:\n${stdout}\nstderr:\n${stderr}`);

    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.webgl2, true, JSON.stringify(result, null, 2));
    assert.equal(result.pointsUploaded, 1000000, JSON.stringify(result, null, 2));
    assert.equal(result.intensityBuffer, true, JSON.stringify(result, null, 2));
    assert.equal(result.classificationBuffer, true, JSON.stringify(result, null, 2));
    assert.equal(result.colorMode, 'classification', JSON.stringify(result, null, 2));
    assert.ok(result.changedPixels > 20, `Expected visible WebGL output; result: ${JSON.stringify(result)}`);
    assert.equal(result.glError, 0, `WebGL error ${result.glError}; result: ${JSON.stringify(result)}`);
    assert.equal(result.contextLost, false, JSON.stringify(result, null, 2));
    assert.equal(result.gpuStress && result.gpuStress.points, 1000000, JSON.stringify(result, null, 2));
    assert.ok(result.gpuStress.durationMs >= 8000, `GPU render load was too short: ${JSON.stringify(result.gpuStress)}`);
    assert.ok(result.gpuStress.renderFrames >= 30, `Too few production render frames: ${JSON.stringify(result.gpuStress)}`);

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

    console.log(`[BIMTWIN_GPU_WEBGL] ${JSON.stringify({
      renderer: result.renderer,
      vendor: result.vendor,
      activeAdapters: result.gpu && result.gpu.activeAdapters || [],
      pointsUploaded: result.pointsUploaded,
      gpuStress: result.gpuStress,
      nvidiaAdapterDetected: !!nvidiaAdapter || /nvidia/i.test(rendererEvidence),
      changedPixels: result.changedPixels,
      webgl2: webglStatus
    })}`);
  } finally {
    if (child && child.exitCode == null) stopProcessTree(child.pid, child);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});