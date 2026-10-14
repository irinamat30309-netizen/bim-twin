// Лаборатория «Вид вблизи» (не часть продукта): размер точки и вид поверхности на разном удалении.
//   LAB_CLOUD=/data/work/outdoor-s.ply TAG=new sh /data/ui-lab/run.sh zoom-lab.js      (TAG=old + LAB_URL=http://127.0.0.1:8124/... — прежняя версия)
const { launch, openCloud, shot } = require('./lab');
const T = (s) => new Promise((r) => setTimeout(r, s));
const TAG = process.env.TAG || 'new';
(async () => {
  const { browser, page, errs } = await launch({ w: 1440, h: 900, theme: 'dark', wait: 2500 });
  page.setDefaultTimeout(120000);
  await openCloud(page); await page.waitForTimeout(+(process.env.SETTLE || 6000));
  const info = () => page.evaluate(() => {
    const v = window.__viewer || window.__lxViewer, o = v.base[0];
    return { n: o.count, spacing: o._spacing, ptMax: o._ptMax, fixed: v._cloudDisplay && v._cloudDisplay.pointSize, atten: v._attenuate, boost: v._densityBoost, dist: +v.dist.toFixed(2), field: v.getSpacingField ? v.getSpacingField() : null };
  });
  console.log(TAG, 'исходно', JSON.stringify(await info()));
  // виды в координатах окна (Y вверх): фасад здания (x=22), человек, земля; yaw/pitch подбираются под сцену mkoutdoor
  // виды в координатах окна (Y вверх; для mkoutdoor: окно = (x−3.86, z+3.89, 15.83−y)): обзор, фасад здания на трёх удалениях, человек
  const VIEWS = JSON.parse(process.env.VIEWS || '[{"n":"far","t":[0,6,10],"d":75,"yaw":-0.9,"pitch":0.45},{"n":"mid","t":[18.1,6,12.8],"d":28,"yaw":-1.57,"pitch":0.12},{"n":"near","t":[18.1,6,12.8],"d":8,"yaw":-1.57,"pitch":0.08},{"n":"close","t":[18.1,5,12.8],"d":2.4,"yaw":-1.57,"pitch":0.05},{"n":"person","t":[2.14,5.0,17.83],"d":4,"yaw":-0.5,"pitch":0.05}]');
  for (const V of VIEWS) {
    await page.evaluate((V) => { const v = window.__viewer || window.__lxViewer; v.target = V.t.slice(); v.dist = V.d; v.yaw = V.yaw; v.pitch = V.pitch; v.render(); }, V);
    await T(1200);
    console.log(TAG, V.n, JSON.stringify(await info()));
    await shot(page, 'zoom-' + TAG + '-' + V.n);
  }
  console.log('ошибки консоли:', errs.length, errs.slice(0, 4).join(' || '));
  await browser.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
