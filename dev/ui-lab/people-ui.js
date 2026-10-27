// Лаборатория «Удалить людей» в окне (не часть продукта): кнопка ленты, диалог, воркер, красный предпросмотр, подтверждение, Ctrl+Z.
//   LAB_CLOUD=/data/work/outdoor-s.ply  sh /data/ui-lab/run.sh people-ui.js
const { launch, openCloud, shot } = require('./lab');
const T = (s) => new Promise((r) => setTimeout(r, s));
(async () => {
  const { browser, page, errs } = await launch({ w: 1440, h: 900, theme: 'dark', wait: 2500 });
  page.setDefaultTimeout(180000);
  await openCloud(page); await page.waitForTimeout(3000);
  const N = () => page.evaluate(() => { const v = window.__viewer || window.__lxViewer; return v.base[0].pos.length / 3; });
  await page.click('#lxTabs [data-tab="cloud"]'); await page.waitForTimeout(500);
  await shot(page, 'pp-ribbon', { clip: { x: 0, y: 36, width: 1440, height: 136 } });
  const btn = (name) => page.evaluate((name) => { const b = [...document.querySelectorAll('#lxRibbon .lx-rb')].find((x) => x.textContent.trim().startsWith(name)); if (!b) return false; b.click(); return true; }, name);
  const bar = () => page.evaluate(() => { const b = document.querySelector('.lx-confirmbar'); return b ? { title: b.querySelector('b').textContent, text: b.querySelector('span').textContent } : null; });
  const toastTxt = () => page.evaluate(() => [...document.querySelectorAll('.lx-toast')].map((e) => e.textContent).filter(Boolean).slice(-2).join(' || '));
  async function waitBar(ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const b = await bar(); if (b) return b; if (/Людей не найдено/.test(await toastTxt())) return null; await T(250); } return null; }
  const n0 = await N(); console.log('точек', n0);
  await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; v.yaw = 0.6; v.pitch = 0.5; v.render(); });
  if (!await btn('Удалить людей')) throw new Error('нет кнопки');
  await page.waitForSelector('.lx-ask'); await T(300); await shot(page, 'pp-dialog');
  await page.evaluate(() => document.querySelector('.lx-ask .btn.primary').click());
  const t0 = Date.now(); const b = await waitBar(240000); console.log('предпросмотр через', ((Date.now() - t0) / 1000).toFixed(1), 'с', JSON.stringify(b));
  // приближаем камеру к найденной группе: центр красных маркеров
  const cam = await page.evaluate(() => {
    const v = window.__viewer || window.__lxViewer, o = v._prevObj; if (!o) return null; const P = o.pos, n = P.length / 3; let sx = 0, sy = 0, sz = 0; for (let i = 0; i < n; i++) { sx += P[i * 3]; sy += P[i * 3 + 1]; sz += P[i * 3 + 2]; }
    return { n, c: [sx / n, sy / n, sz / n] };
  });
  console.log('маркеров предпросмотра', cam && cam.n);
  await T(2200); await shot(page, 'pp-preview');
  await page.evaluate(() => {   // крупный план: медиана красных маркеров лежит в самой плотной группе (человек рядом со сканером)
    const v = window.__viewer || window.__lxViewer, P = v._prevObj.pos, n = P.length / 3, med = (a) => { const b = Array.from({ length: n }, (_, i) => P[i * 3 + a]).sort((p, q) => p - q); return b[n >> 1]; };
    v.target = [med(0), med(1), med(2)]; v.dist = 5; v.yaw = 0.7; v.pitch = 0.25; v.render();
  });
  await T(2500); await shot(page, 'pp-preview-close');
  await page.evaluate(() => document.querySelector('.lx-confirmbar .btn.primary').click());
  for (let i = 0; i < 200; i++) { await T(250); if (!(await page.evaluate(() => document.documentElement.classList.contains('lx-operation-busy'))) && i > 2) break; }
  await T(1500); const n1 = await N(); console.log('после применения: точек', n1, 'удалено', n0 - n1, '|', await toastTxt());
  await shot(page, 'pp-after');
  await page.keyboard.press('Control+z'); await T(2500); console.log('после Ctrl+Z: точек', await N());
  console.log('ошибки консоли:', JSON.stringify(errs.slice(0, 5)));
  await browser.close(); process.exit(0);
})().catch((e) => { console.error('СБОЙ', e); process.exit(1); });
