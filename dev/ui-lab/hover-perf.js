// Лаг при наведении курсора в режиме «Расстояние» (не часть продукта): сколько раз за кадр перерисовывается облако.
//   LAB_CLOUD — PLY (по умолчанию room.ply).  LAB_THR — порог «большого» вызова отрисовки точек (по умолчанию 100000).
//   Сравнивает два режима: «до» (кэш сцены и pick-кэш выключены) и «после» (включены). Запуск: sh /data/ui-lab/run.sh hover-perf.js
const { launch, openCloud, shot } = require('./lab');
(async () => {
  const { browser, page, errs } = await launch({ w: 1280, h: 800, theme: 'dark', wait: 2500 });
  page.setDefaultTimeout(300000);
  await openCloud(page);
  await page.waitForTimeout(2500);
  const THR = +(process.env.LAB_THR || 100000);
  const info = await page.evaluate((THR) => {
    const v = window.__viewer || window.__lxViewer, bo = v.base[0];
    const P = WebGL2RenderingContext.prototype, orig = P.drawArrays;
    window.__d = { calls: 0, big: 0, pts: 0 };
    P.drawArrays = function (mode, first, count) { window.__d.calls++; if (mode === this.POINTS && count >= THR) { window.__d.big++; window.__d.pts += count; } return orig.call(this, mode, first, count); };
    window.__lt = []; try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(Math.round(e.duration)))).observe({ entryTypes: ['longtask'] }); } catch (e) {}
    window.__t0 = performance.now();
    v.setMeasure(true); v.setMeasureMode('distance'); v.measureSnap = true; v.smartMeasure = true;
    return { n: bo.count, canvas: [v.canvas.width, v.canvas.height], pickReady: !!v._pickReady };
  }, THR);
  console.log('точек', info.n, 'холст', info.canvas.join('x'));
  let ready = null;
  for (let i = 0; i < 400 && !ready; i++) { await page.waitForTimeout(500); ready = await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; return v._psCache && v._psCache.index ? { ms: Math.round(v._psCache.ms), build: Math.round(v._psCache.buildMs || 0), spacing: v._psCache.index.spacing, local: !!v._psCache.index.local, lt: window.__lt.slice() } : null; }); }
  console.log('индекс привязки готов:', JSON.stringify(ready));
  const box = await page.evaluate(() => { const r = (window.__viewer || window.__lxViewer).canvas.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const run = async (label, before) => {
    await page.evaluate((before) => {
      const v = window.__viewer || window.__lxViewer;
      v.sceneCacheMinPoints = before ? 1e15 : 0; v.pickCacheOff = !!before;
      v._pickStat = { passes: 0, hits: 0 }; v._scStat = { full: 0, present: 0 };
      v.setMeasure(true); v.setMeasureMode('distance'); v._clearMeasure();
      v.render();
    }, before);
    await page.mouse.move(cx, cy); await page.waitForTimeout(1200);
    // первая точка (клик), затем 24 шага курсора по сцене
    await page.mouse.click(cx, cy); await page.waitForTimeout(900);
    await page.evaluate(() => { window.__d = { calls: 0, big: 0, pts: 0 }; const v = window.__viewer || window.__lxViewer; v._pickStat = { passes: 0, hits: 0 }; v._scStat = { full: 0, present: 0 }; });
    const t0 = Date.now(); const N = +(process.env.LAB_STEPS || 24), rows = [];
    for (let i = 0; i < N; i++) {
      const x = cx + 120 * Math.cos(i / 3.5), y = cy + 90 * Math.sin(i / 3.5);
      await page.mouse.move(x, y); await page.waitForTimeout(700);
    }
    const res = await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; return { d: window.__d, pick: v._pickStat, sc: v._scStat, psMs: v._psCache && v._psCache.ms, kind: v._hoverSnap && v._hoverSnap.kind }; });
    console.log(label.padEnd(8), 'шагов', N, '| больших draw-вызовов на шаг', (res.d.big / N).toFixed(2), '| точек за шаг', Math.round(res.d.pts / N), '| pick: проходов', res.pick && res.pick.passes, 'из кэша', res.pick && res.pick.hits, '| сцена: полных', res.sc && res.sc.full, 'present', res.sc && res.sc.present);
    await shot(page, 'hover-' + label);
    await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; v._clearMeasure(); });
    return res;
  };
  const a = await run('до', true);
  const b = await run('после', false);
  console.log('ошибки консоли:', errs.length, errs.slice(0, 5).join(' || '));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
