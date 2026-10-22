// Ревизия 14 (не часть продукта): ВСЕ точки на экране — в покое и при движении, на облаках 1 / 5 / 13 млн.
//   sh /data/ui-lab/run.sh dev/ui-lab/all-lab.js
const { launch } = require('./lab');
(async () => {
  const { browser, page, errs } = await launch({ w: 1000, h: 640, theme: 'dark', wait: 2000 });
  page.setDefaultTimeout(600000);
  for (const N of [1000000, 5000000, 13000000]) {
    const r = await page.evaluate((N) => {
      const v = window.__viewer || window.__lxViewer; let s = 7; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
      const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) { const a = rnd() * 6.283, h = rnd() * 6; pos[i * 3] = 8 * Math.cos(a); pos[i * 3 + 1] = h; pos[i * 3 + 2] = 8 * Math.sin(a); col[i * 3] = 0.3; col[i * 3 + 1] = 0.5; col[i * 3 + 2] = 0.9; }
      v.loadCloud({ pos, col, count: N, name: 'c' + N, meta: { total: N, format: 'las' } });
      v.target = [0, 3, 0]; v.dist = 30; v.render();
      const probe = () => { v._interacting = true; v._renderNow(); const d = v._probeDrawn; v._interacting = false; return d; };
      const o = { loaded: v.base[0].count, decimated: v._decimatedFrom, movePctDefault: v._octMovePct };
      v._perfProfile = 'balanced'; v._ptsPerMs = 1; v._interPts = 100000;     // «очень медленная видеокарта»: адаптивный срез сработал бы
      o.defaultMove = probe();
      v._octMovePct = 0; o.autoSlowGpu = probe(); v._octMovePct = 25; o.p25 = probe(); v.setOctreeMovePercent(100); o.back100 = probe();
      return o;
    }, N);
    console.log(N, JSON.stringify(r), r.loaded === N && r.defaultMove === N && r.back100 === N ? 'OK' : 'FAIL');
  }
  console.log('ошибки консоли:', errs.length, errs.slice(0, 3).join(' | '));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
