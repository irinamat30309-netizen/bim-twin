'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { app, BrowserWindow, ipcMain } = require('electron');
const { readGpuSmokeConfig } = require('./config.cjs');
const { parseCloudFileAsync } = require(path.join(__dirname, '../../las-node.js'));
const Section = require(path.join(__dirname, '../../renderer/section.js'));

const resultPath = process.env.BIMTWIN_WEBGL_SMOKE_RESULT;
const gpuConfig = readGpuSmokeConfig(process.env);
const configuredStressMs = gpuConfig.stressMs;
const smokeTimeoutMs = Math.max(45000, configuredStressMs + 600000);
let finished = false;
let timeout;

function finish(result, exitCode) {
  if (finished) return;
  finished = true;
  if (timeout) clearTimeout(timeout);

  try {
    if (resultPath) {
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
    }
    console.log(`[BIMTWIN_GPU_WEBGL] ${JSON.stringify(result)}`);
  } catch (error) {
    console.error('[BIMTWIN_GPU_WEBGL] Could not write the smoke-test result:', error);
    exitCode = 1;
  }

  app.exit(exitCode);
}

function benchmarkLasSection(cloud) {
  const { pos, count } = cloud;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const yBins = new Uint32Array(256);

  for (let i = 0; i < count; i++) {
    const offset = i * 3;
    const x = pos[offset], y = pos[offset + 1], z = pos[offset + 2];
    if (![x, y, z].every(Number.isFinite)) throw new Error(`Non-finite LAS sample coordinate at point ${i}.`);
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }

  const verticalSpan = maxY - minY;
  if (verticalSpan > 0) {
    for (let i = 0; i < count; i++) {
      const y = pos[i * 3 + 1];
      const bin = Math.min(yBins.length - 1, Math.floor(((y - minY) / verticalSpan) * yBins.length));
      yBins[bin]++;
    }
  } else {
    yBins[0] = count;
  }

  let densestBin = 0;
  for (let i = 1; i < yBins.length; i++) {
    if (yBins[i] > yBins[densestBin]) densestBin = i;
  }
  const binWidth = verticalSpan > 0 ? verticalSpan / yBins.length : 0;
  const level = verticalSpan > 0
    ? minY + (densestBin + 0.5) * binWidth
    : minY;
  const thickness = Math.max(0.1, binWidth * 2);
  const planExtent = Math.max(maxX - minX, maxZ - minZ);
  const cell = Math.max(0.25, planExtent / 512);
  const phaseOrder = [];
  const lastFraction = new Map();
  const started = performance.now();
  const result = Section.sectionToPolylines(pos, count, {
    axis: 'y',
    level,
    thickness,
    cell,
    minArea: 0,
    simplify: cell / 2,
    compact: true,
    onProgress(update) {
      if (!lastFraction.has(update.phase)) phaseOrder.push(update.phase);
      const previous = lastFraction.get(update.phase);
      if (!Number.isFinite(update.fraction) || (previous != null && update.fraction < previous)) {
        throw new Error(`LAS section progress regressed during ${update.phase}.`);
      }
      lastFraction.set(update.phase, update.fraction);
    }
  });
  const elapsedMs = performance.now() - started;
  if (!result || !Array.isArray(result.loops) || !Number.isSafeInteger(result.sliced)) {
    throw new Error('The Stage 9 LAS section kernel returned an invalid result.');
  }

  return {
    axis: 'y',
    samplePoints: count,
    slicedPoints: result.sliced,
    loops: result.loops.length,
    closedLoops: result.loops.filter((loop) => loop && loop.closed).length,
    phases: phaseOrder,
    cellMeters: Number(cell.toFixed(4)),
    slabThicknessMeters: Number(thickness.toFixed(4)),
    elapsedMs: Number(elapsedMs.toFixed(2)),
    scope: '1M-bounded LAS sample; performance smoke only, not an independent accuracy oracle'
  };
}

async function prepareLasInput() {
  if (!gpuConfig.lasPath) return { cloud: null, report: null };
  if (gpuConfig.expectedLasPoints == null) {
    throw new Error('BIMTWIN_GPU_LAS_EXPECTED_POINTS is required when BIMTWIN_GPU_LAS_PATH is set.');
  }

  const fileInfo = fs.statSync(gpuConfig.lasPath);
  if (!fileInfo.isFile() || fileInfo.size < 227) {
    throw new Error('Configured local LAS file is missing or too small to contain a header.');
  }

  let lastLoggedBucket = -1;
  const parseStarted = performance.now();
  const parsed = await parseCloudFileAsync(gpuConfig.lasPath, {
    maxPoints: gpuConfig.lasMaxPoints,
    onProgress(update) {
      if (!update || !Number.isFinite(update.fraction)) return;
      const bucket = Math.floor(Math.max(0, Math.min(1, update.fraction)) * 10);
      if (bucket > lastLoggedBucket) {
        lastLoggedBucket = bucket;
        console.log(`[BIMTWIN_GPU_LAS_PROGRESS] ${update.phase} ${Math.min(bucket * 10, 100)}%`);
      }
    }
  });
  const parseMs = performance.now() - parseStarted;
  if (!parsed || parsed.ok !== true) {
    throw new Error(`Local LAS import failed: ${parsed && parsed.message || 'unknown parser error'}`);
  }

  const totalPoints = Number(parsed.meta && parsed.meta.total);
  if (totalPoints !== gpuConfig.expectedLasPoints) {
    throw new Error(`LAS point count mismatch: expected ${gpuConfig.expectedLasPoints}, parsed ${totalPoints}.`);
  }
  if (!Number.isSafeInteger(parsed.count) || parsed.count < 1 || parsed.count > gpuConfig.lasMaxPoints) {
    throw new Error(`LAS parser returned an invalid bounded sample count: ${parsed.count}.`);
  }

  const sectionBenchmark = benchmarkLasSection(parsed);
  const cloud = {
    pos: parsed.pos,
    col: parsed.col || null,
    intensity: parsed.intensity || null,
    classification: parsed.classification || null,
    count: parsed.count,
    meta: {
      ...(parsed.meta || {}),
      name: 'private-local-las-qa-sample'
    }
  };
  const report = {
    fileName: path.basename(gpuConfig.lasPath),
    fileSizeBytes: fileInfo.size,
    totalPoints,
    sampledPoints: parsed.count,
    samplingStride: Math.max(1, Math.ceil(totalPoints / parsed.count)),
    format: parsed.meta && parsed.meta.format || 'LAS',
    hasRGB: !!parsed.meta?.colored,
    hasIntensity: !!parsed.intensity,
    hasClassification: !!parsed.classification,
    crsWktPresent: !!(parsed.meta && parsed.meta.crsWkt),
    sampledBoundsMeters: {
      width: Number(parsed.meta.w.toFixed(3)),
      height: Number(parsed.meta.h.toFixed(3)),
      depth: Number(parsed.meta.d.toFixed(3))
    },
    parseMs: Number(parseMs.toFixed(2)),
    sectionBenchmark
  };
  console.log(`[BIMTWIN_GPU_LAS] ${JSON.stringify(report)}`);
  return { cloud, report };
}

app.commandLine.appendSwitch('enable-webgl');
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 900,
    height: 680,
    show: true,
    title: 'BIM Twin WebGL hardware smoke test',
    backgroundColor: '#111318',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false
    }
  });

  const fail = (message) => finish({ ok: false, error: String(message) }, 1);
  timeout = setTimeout(
    () => fail(`Timed out waiting for LAS import and the ${configuredStressMs} ms WebGL smoke test.`),
    smokeTimeoutMs
  );

  ipcMain.once('bimtwin:webgl-smoke-ready', async (event) => {
    if (event.sender !== window.webContents) return;
    try {
      const { cloud, report } = await prepareLasInput();
      const payload = { cloud, lasInput: report };
      console.log(`[BIMTWIN_GPU_LAS] sending ${cloud ? cloud.count : 0} sampled points to the WebGL renderer.`);
      event.sender.send('bimtwin:webgl-smoke-cloud', payload);
    } catch (error) {
      fail(error && error.stack || error);
    }
  });
  ipcMain.on('bimtwin:webgl-smoke-progress', (event, message) => {
    if (event.sender === window.webContents) {
      console.log(`[BIMTWIN_GPU_WEBGL_PROGRESS] ${String(message || '').slice(0, 160)}`);
    }
  });

  ipcMain.once('bimtwin:webgl-smoke-result', async (_event, rendererResult) => {
    try {
      const gpuFeatureStatus = app.getGPUFeatureStatus();
      let gpuInfo = {};
      try {
        gpuInfo = await app.getGPUInfo('complete');
      } catch (error) {
        gpuInfo = { error: String(error && error.message || error) };
      }

      const devices = Array.isArray(gpuInfo.devices) ? gpuInfo.devices : [];
      const activeAdapters = devices
        .filter((device) => device && device.active)
        .map((device) => ({
          vendorId: device.vendorId,
          deviceId: device.deviceId,
          name: device.deviceString || device.driverVendor || ''
        }));

      const result = {
        ...rendererResult,
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        gpu: {
          featureStatus: gpuFeatureStatus,
          activeAdapters
        }
      };
      finish(result, result.ok ? 0 : 1);
    } catch (error) {
      fail(error && error.stack || error);
    }
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    fail(`Renderer process exited: ${JSON.stringify(details)}`);
  });
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    fail(`Could not load WebGL fixture (${code}): ${description} (${url})`);
  });
  window.loadFile(path.join(__dirname, 'index.html')).catch(fail);
}).catch((error) => {
  finish({ ok: false, error: error && error.stack || String(error) }, 1);
});