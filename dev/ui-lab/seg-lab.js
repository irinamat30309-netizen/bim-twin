// Ревизия 15 (не часть продукта): облако в нескольких буферах видеопамяти — все точки рисуются, выбор точки (pick) даёт верные индексы,
// интенсивность грузится лениво, при нехватке видеопамяти рисуются поместившиеся сегменты и приходит сообщение.
//   sh /data/ui-lab/run.sh dev/ui-lab/seg-lab.js
const { launch } = require('./lab');
(async () => {
  const { browser, page, errs } = await launch({ w: 1000, h: 640, theme: 'dark', wait: 2000 });
  page.setDefaultTimeout(600000);
  const r = await page.evaluate(async () => {
    const v = window.__viewer || window.__lxViewer; const N = 10000000; let s = 7; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), inten = new Float32Array(N);
    for (let i = 0; i < N; i++) { const a = rnd() * 6.283, h = rnd() * 6; pos[i * 3] = 8 * Math.cos(a); pos[i * 3 + 1] = h; pos[i * 3 + 2] = 8 * Math.sin(a); col[i * 3] = 0.3; col[i * 3 + 1] = 0.5; col[i * 3 + 2] = 0.9; inten[i] = rnd(); }
    v._segPoints = 2500000;
    const out = {};
    window.__gs = null; window.addEventListener('bim-gpu-short', (e) => { window.__gs = e.detail; });
    v.loadCloud({ pos, col, intensity: inten, count: N, name: 'seg', meta: { total: N, format: 'las' } });
    const bo = v.base[0];
    out.segs = bo._segs ? bo._segs.map((x) => x.n) : null; out.count = bo.count; out.gpuCount = bo._gpuCount; out.decimated = v._decimatedFrom;
    v.target = [0, 3, 0]; v.dist = 30; v.render();
    const probe = () => { v._probeIdle = true; v._renderNow(); v._probeIdle = false; return v._probeDrawn; };
    v._probeDrawn = 0; v._probeTotal = 0; probe(); out.drawnIdle = v._probeDrawn;
    v._interacting = true; v._probeDrawn = 0; v._renderNow(); out.drawnMoving = v._probeDrawn; v._interacting = false;
    out.glErrAfterDraw = v.gl.getError();
    // pick: индекс → точка должны совпадать, индексы из разных сегментов
    const rect = v.canvas.getBoundingClientRect(), M = v._lastVP || v._vp();
    const used = new Set(); let ok = 0, bad = 0, tried = 0;
    for (let t = 0; t < 400 && used.size < 4; t++) {
      const i = Math.floor(rnd() * N), x = bo.pos[i * 3], y = bo.pos[i * 3 + 1], z = bo.pos[i * 3 + 2];
      const cx = M[0] * x + M[4] * y + M[8] * z + M[12], cy = M[1] * x + M[5] * y + M[9] * z + M[13], cw = M[3] * x + M[7] * y + M[11] * z + M[15];
      if (cw <= 0) continue; const nx = cx / cw, ny = cy / cw; if (Math.abs(nx) > 0.9 || Math.abs(ny) > 0.9) continue;
      const sx = rect.left + (nx * 0.5 + 0.5) * rect.width, sy = rect.top + (1 - (ny * 0.5 + 0.5)) * rect.height;
      const pk = v._pickGPU(sx, sy, 6); tried++;
      if (!pk) continue; const j = pk.index;
      if (bo.pos[j * 3] === pk.point[0] && bo.pos[j * 3 + 1] === pk.point[1] && bo.pos[j * 3 + 2] === pk.point[2]) ok++; else bad++;
      used.add(Math.floor(j / 2500000));
    }
    out.pick = { tried, ok, bad, segmentsHit: used.size };
    // лениво: интенсивность
    out.ibBefore = bo._segs.filter((x) => x.ib).length;
    v.setColorMode && v.setColorMode('intensity'); v.render(); v._renderNow();
    out.ibAfter = bo._segs.filter((x) => x.ib).length; out.glErrIntensity = v.gl.getError();
    // нехватка видеопамяти: третий сегмент «не влез»
    const gl = v.gl, realErr = gl.getError.bind(gl); let calls = 0, bufs = 0;
    const origBD = gl.bufferData.bind(gl); let seen = 0;
    gl.getError = () => { calls++; return calls === 4 ? gl.OUT_OF_MEMORY : realErr(); };   // 1-й вызов — сброс, затем по одному на сегмент: OOM на третьем
    v.setColorMode && v.setColorMode('rgb');
    window.__gs = null;
    v.loadCloud({ pos, col, count: N, name: 'seg2', meta: { total: N, format: 'las' } });
    gl.getError = realErr;
    const b2 = v.base[0]; out.short = { segs: b2._segs.length, gpuCount: b2._gpuCount, event: window.__gs };
    v._interacting = false; v.render(); v._sceneRev = (v._sceneRev | 0) + 1; v._probeDrawn = 0; v._interacting = true; v._renderNow(); v._interacting = false; out.shortDrawn = v._probeDrawn; out.shortFrameErr = v.gl.getError();
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
  console.log('ошибки консоли:', errs.length, errs.slice(0, 3).join(' | '));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
