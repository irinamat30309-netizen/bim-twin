// Обход всех вкладок ленты: снимок полосы (вкладки + лента), признаки прокрутки, отсутствующие иконки, ошибки.
// node tabs.js <ширина> <высота> <dark|light> [cloud]
const { launch, shot, openCloud } = require('./lab');
(async () => {
  const [,, w = '1440', h = '900', theme = 'dark', cloud = ''] = process.argv;
  const { browser, page, errs } = await launch({ w: +w, h: +h, theme });
  if (cloud) await openCloud(page);
  const ids = await page.evaluate(() => [...document.querySelectorAll('#lxTabs [data-tab]')].map((b) => b.dataset.tab));
  for (const id of ids) {
    await page.click(`#lxTabs [data-tab="${id}"]`);
    await page.waitForTimeout(450);
    const info = await page.evaluate(() => {
      const r = document.getElementById('lxRibbon'), p = r.querySelector('.lx-panel.active');
      return { prev: r.classList.contains('can-prev'), next: r.classList.contains('can-next'), sw: p ? p.scrollWidth : 0, cw: p ? p.clientWidth : 0, n: p ? p.querySelectorAll('.lx-rb').length : 0 };
    });
    await shot(page, `tab-${theme}-${w}-${id}`, { clip: { x: 0, y: 36, width: +w, height: 136 } });
    console.log(id.padEnd(9), JSON.stringify(info));
  }
  const missing = await page.evaluate(() => [...document.querySelectorAll('[data-icon-missing]')].map((n) => n.getAttribute('data-icon-missing')));
  console.log('missing icons:', missing.length, missing.slice(0, 10).join(','));
  console.log('errors:', errs.length); errs.slice(0, 20).forEach((e) => console.log(e));
  await browser.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
