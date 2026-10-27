// Лаборатория «Умное подавление шума» в окне (не часть продукта): диалог, фоновый расчёт, красный предпросмотр, подтверждение, отмена, Ctrl+Z.
//   LAB_CLOUD=/data/work/outdoor-s.ply  sh /data/ui-lab/run.sh denoise-ui.js
const { launch, openCloud, shot } = require('./lab');
const T = (s) => new Promise((r) => setTimeout(r, s));
(async () => {
  const { browser, page, errs } = await launch({ w: 1440, h: 900, theme: 'dark', wait: 2500 });
  page.setDefaultTimeout(180000);
  await openCloud(page); await page.waitForTimeout(3000);
  const N = () => page.evaluate(() => { const v = window.__viewer || window.__lxViewer; return v.base[0].pos.length / 3; });
  await page.click('#lxTabs [data-tab="cloud"]'); await page.waitForTimeout(500);
  const btn = (name) => page.evaluate((name) => { const b = [...document.querySelectorAll('#lxRibbon .lx-rb')].find((x) => x.textContent.trim().startsWith(name)); if (!b) return false; b.click(); return true; }, name);
  const bar = () => page.evaluate(() => { const b = document.querySelector('.lx-confirmbar'); return b ? { title: b.querySelector('b').textContent, text: b.querySelector('span').textContent, tone: b.getAttribute('data-tone') } : null; });
  const toastTxt = () => page.evaluate(() => [...document.querySelectorAll('.lx-toast')].map((e) => e.textContent).filter(Boolean).slice(-2).join(' || '));
  async function waitBar(ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const b = await bar(); if (b) return b; await T(250); } return null; }
  async function start(fields) {
    if (!await btn('Подавление шума')) throw new Error('нет кнопки');
    await page.waitForSelector('.lx-ask'); await T(200);
    if (fields) await page.evaluate((f) => { const rows = document.querySelectorAll('.lx-ask .lx-form-row'); for (const [i, v] of f) { const c = rows[i].querySelector('input,select'); if (c.type === 'checkbox') c.checked = !!v; else c.value = v; c.dispatchEvent(new Event('input', { bubbles: true })); c.dispatchEvent(new Event('change', { bubbles: true })); } }, fields);
    await T(200); await shot(page, 'dn-dialog');
    await page.evaluate(() => document.querySelector('.lx-ask .btn.primary').click());
  }
  const n0 = await N(); console.log('точек', n0);
  await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; v.yaw = 0.6; v.pitch = 0.35; v.render(); });
  // 1) предпросмотр и отмена по Esc
  let t0 = Date.now(); await start(); let b = await waitBar(240000); console.log('предпросмотр через', ((Date.now() - t0) / 1000).toFixed(1), 'с', JSON.stringify(b));
  await T(2200); await shot(page, 'dn-preview');
  console.log('маркеров предпросмотра', await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; return v._prevObj ? v._prevObj.count || v._prevObj.pos.length / 3 : 0; }));
  await page.keyboard.press('Escape'); await T(600);
  console.log('после Esc: точек', await N(), 'панель', !!(await bar()), 'предпросмотр', await page.evaluate(() => !!(window.__viewer || window.__lxViewer)._prevObj), '|', await toastTxt());
  // 2) подтверждение
  t0 = Date.now(); await start(); b = await waitBar(240000); console.log('2-й расчёт', ((Date.now() - t0) / 1000).toFixed(1), 'с');
  await page.evaluate(() => document.querySelector('.lx-confirmbar .btn.primary').click());
  for (let i = 0; i < 200; i++) { await T(250); if (!(await page.evaluate(() => document.documentElement.classList.contains('lx-operation-busy'))) && i > 2) break; }
  await T(1500); const n1 = await N(); console.log('после применения: точек', n1, 'удалено', n0 - n1, ((n0 - n1) / n0 * 100).toFixed(2) + ' %', '|', await toastTxt());
  await shot(page, 'dn-after');
  await page.keyboard.press('Control+z'); await T(2500); console.log('после Ctrl+Z: точек', await N());
  // 3) классический режим + без предпросмотра
  await start([[0, 'radius'], [4, false]]); for (let i = 0; i < 200; i++) { await T(250); if (!(await page.evaluate(() => document.documentElement.classList.contains('lx-operation-busy'))) && i > 2) break; }
  await T(1500); console.log('радиусный режим: точек', await N(), '|', await toastTxt());
  await page.keyboard.press('Control+z'); await T(2500); console.log('после Ctrl+Z: точек', await N());
  console.log('ошибки консоли:', JSON.stringify(errs.slice(0, 5)));
  await browser.close(); process.exit(0);
})().catch((e) => { console.error('СБОЙ', e); process.exit(1); });
