// Загрузка реального облака (LAB_CLOUD) в приложение стенда: время, число точек, снимок.
const { launch, shot } = require('./lab');
const path = require('path');
(async () => {
  const t0 = Date.now();
  const { browser, page, errs } = await launch({ w: 1440, h: 900, theme: 'dark', wait: 2500 });
  page.setDefaultTimeout(240000);
  const file = process.env.LAB_CLOUD;
  console.log('file', file);
  await page.setInputFiles('#modelInput', file);
  let info = null;
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(2000);
    info = await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; const b = v && v.base && v.base[0]; return b ? { count: b.count, n: b.pos && b.pos.length / 3, spacing: b._spacing, points: !!b.points, lod: !!b._lod, dec: v._decimatedFrom, bbox: v.bbox } : null; });
    if (info && info.count) break;
    if (i % 5 === 0) console.log('wait', i * 2, 's', JSON.stringify(info));
  }
  console.log('loaded in', Math.round((Date.now() - t0) / 1000), 's', JSON.stringify(info));
  await page.waitForTimeout(3000);
  await shot(page, 'real-loaded');
  const banner = await page.evaluate(() => (document.querySelector('.hud-readout, #status, .status') || {}).textContent);
  console.log('status:', String(banner).slice(0, 200));
  console.log('errors:', errs.length); errs.slice(0, 10).forEach((e) => console.log(e));
  await browser.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
