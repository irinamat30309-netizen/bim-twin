// Ревизия 18 (не часть продукта): большое облако по сегментам — локальный размер точки (поле шага) считается в простое для каждого сегмента,
// зум колесом без предела (пролёт вперёд), без ошибок консоли. Снимки вблизи: с полем шага и без.
//   node dev/ui-lab/seg-sharp-lab.js
const { launch, shot } = require('./lab');
(async () => {
  const { browser, page, errs } = await launch({ w: 900, h: 600, theme: 'dark', wait: 2000 });
  page.setDefaultTimeout(600000);
  const r = await page.evaluate(async () => {
    const N = 1200000, SEG = 300000, CH = 30000, v = window.__viewer || window.__lxViewer, out = {};
    const hash = (i, k) => { let h = (Math.imul(i + 1, 2654435761) ^ Math.imul(k + 7, 40503)) >>> 0; h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
    // пол 20×10 м: левая половина плотная (шаг ~7 мм), правая редкая (~2 см); стена x = 0
    const pt = (i) => { const u = hash(i, 0), a = hash(i, 1), b = hash(i, 2); if (u < 0.8) return [a < 0.9 ? 10 * a / 0.9 : 10 + 10 * (a - 0.9) / 0.1, (hash(i, 3) - 0.5) * 0.002, 10 * b]; return [0, 3 * a, 10 * b]; };
    const seg = (k) => { const from = k * SEG, n = Math.min(SEG, N - from), pos = new Float32Array(n * 3), col = new Uint8Array(n * 3);
      for (let j = 0; j < n; j++) { const p = pt(from + j); pos.set(p, j * 3); const c = ((Math.floor(p[0] * 4) + Math.floor(p[2] * 4)) & 1) ? 200 : 90; col[j * 3] = c; col[j * 3 + 1] = c; col[j * 3 + 2] = 120; }
      const nc = Math.ceil(n / CH), B = new Float32Array(nc * 6);
      for (let c = 0; c < nc; c++) { const a = [1e30, 1e30, 1e30], b = [-1e30, -1e30, -1e30]; for (let j = c * CH; j < Math.min(n, (c + 1) * CH); j++) for (let t = 0; t < 3; t++) { const q = pos[j * 3 + t]; if (q < a[t]) a[t] = q; if (q > b[t]) b[t] = q; } for (let t = 0; t < 3; t++) { B[c * 6 + t] = a[t]; B[c * 6 + 3 + t] = b[t]; } }
      return { ok: true, pos, col, intensity: null, classification: null, count: n, chunkPoints: CH, chunkBoxes: B, from, bbox: { mn: [0, -0.01, 0], mx: [20, 3, 10] } }; };
    v.beginCloudStream({ total: N, bbox: { mn: [0, -0.01, 0], mx: [20, 3, 10] }, meta: { format: 'las', total: N, colored: true }, name: 'floor.las' }, { sourceName: '/x/floor.las', sampleTarget: 300000 });
    for (let k = 0; k < N / SEG; k++) { const q = v.addCloudStreamSegment(seg(k)); if (!q.ok) throw new Error('segment ' + k); }
    v.endCloudStream({ path: '/x/floor.las', name: 'floor.las' });
    const bo = v.base[0], t0 = performance.now();
    out.big = v.isBigCloud(); out.segs = bo._segs.length;
    while (!bo._radSegReady && performance.now() - t0 < 120000) await new Promise((res) => setTimeout(res, 200));
    out.readyMs = Math.round(performance.now() - t0); out.ready = !!bo._radSegReady; out.model = !!bo._radModel;
    out.rb = bo._segs.map((s) => !!s.rb); out.field = !!(v.getSpacingField && v.getSpacingField());
    return out;
  });
  console.log('seg', JSON.stringify(r));
  // зум: 120 делений колеса к центру экрана
  await page.evaluate(() => { const v = window.__viewer; v.target = [5, 0, 5]; v.dist = 12; v.yaw = 0.6; v.pitch = 0.6; v.render(); });
  const before = await page.evaluate(() => { const v = window.__viewer; return { dist: v.dist, t: v.target.slice(), min: v._zoomMinDist() }; });
  const cv = await page.$('canvas'); const bb = await cv.boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  for (let i = 0; i < 120; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(8); }
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => { const v = window.__viewer; return { dist: v.dist, t: v.target.slice() }; });
  const moved = Math.hypot(after.t[0] - before.t[0], after.t[1] - before.t[1], after.t[2] - before.t[2]);
  console.log('zoom', JSON.stringify({ before, after, moved: +moved.toFixed(3) }));
  // вблизи границы плотной и редкой частей
  for (const d of [0.6, 2.5]) for (const on of [true, false]) {
    await page.evaluate(([on, d]) => { const v = window.__viewer; v._radSegsOn = on; v.target = [10, 0, 5]; v.dist = d; v.yaw = 1.2 + (on ? 0 : 1e-4); v.pitch = 0.9; v.render(); }, [on, d]);
    await page.waitForTimeout(1200); await shot(page, 'seg-sharp-' + d + '-' + (on ? 'on' : 'off'));
  }
  console.log('errors', errs.length, errs.slice(0, 5).join('\n'));
  await browser.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
