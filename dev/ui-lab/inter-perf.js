// Адаптивное число точек при движении камеры (ревизия 8; не часть продукта).
//   LAB_CLOUD=/путь/к/большому.ply  [LAB_FAKE_MS=60]  sh /data/ui-lab/run.sh inter-perf.js
// Крутит облако мышью и печатает, сколько точек рисуется за кадр во время движения и после остановки, и во что оценивает кадр видеокарта.
const { launch, openCloud } = require('./lab');
(async () => {
  const { browser, page, errs } = await launch({ w: 1280, h: 800, theme: 'dark', wait: 2500 });
  page.setDefaultTimeout(300000);
  await openCloud(page);
  await page.waitForTimeout(4000);
  const info = await page.evaluate(() => {
    const v = window.__viewer || window.__lxViewer, bo = v.base[0];
    const P = WebGL2RenderingContext.prototype, orig = P.drawArrays;
    window.__d = [];
    P.drawArrays = function (mode, first, count) { if (mode === this.POINTS && count >= 100000) window.__d.push({ n: count, i: !!v._interacting }); return orig.call(this, mode, first, count); };
    return { n: bo.count, shuffled: !!bo._shuffled, canvas: [v.canvas.width, v.canvas.height] };
  });
  if (process.env.LAB_FAKE_MS) await page.evaluate((f) => { const v = window.__viewer || window.__lxViewer, o = v._adaptInter; v._adaptInter = function (ms, d, t) { return o.call(this, f * d / 3000000, d, t); }; }, +process.env.LAB_FAKE_MS);   // имитация медленной видеокарты: LAB_FAKE_MS — мс на 3 млн точек
  console.log('точек', info.n, 'перемешано', info.shuffled, 'холст', info.canvas.join('x'));
  const box = await page.evaluate(() => { const r = (window.__viewer || window.__lxViewer).canvas.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  await page.mouse.move(cx, cy); await page.mouse.down();
  for (let i = 0; i < 40; i++) { await page.mouse.move(cx + 6 * i, cy + 2 * i); await page.waitForTimeout(30); }
  const during = await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; return { pts: Math.round(v._interPts || 0), ms: +(v._interMs || 0).toFixed(1), ppms: Math.round(v._ptsPerMs || 0) }; });
  await page.mouse.up(); await page.waitForTimeout(900);
  const log = await page.evaluate(() => window.__d);
  const mv = log.filter((x) => x.i).map((x) => x.n), st = log.filter((x) => !x.i).map((x) => x.n);
  console.log('кадров при движении', mv.length, '| точек за кадр: первый', mv[0], 'последний', mv[mv.length - 1], 'мин', Math.min(...mv), 'макс', Math.max(...mv));
  console.log('после остановки кадров', st.length, '| последний', st[st.length - 1], '(должно быть всё облако)');
  console.log('оценка бюджета:', JSON.stringify(during), '| ошибок консоли', errs.length);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
