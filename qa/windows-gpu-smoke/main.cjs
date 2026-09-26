'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const resultPath = process.env.BIMTWIN_WEBGL_SMOKE_RESULT;
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
  const timeoutMs = process.env.BIMTWIN_GPU_WEBGL_SAMPLE_FILE ? 300000 : 45000;
  timeout = setTimeout(() => fail('Timed out waiting for the WebGL smoke test.'), timeoutMs);

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