// Обход всех кнопок ленты (не часть продукта): каждая команда открывается, затем Esc/«×» должны её закрыть; собираются ошибки консоли.
//   LAB_CLOUD=/data/work/r11/p2_s8.ply  sh /data/ui-lab/run.sh dev/ui-lab/bug-crawl.js
const { launch, openCloud } = require('./lab');
const T = (s) => new Promise((r) => setTimeout(r, s));
const SKIP = /^(Сохранить|Сохранить как|Новый проект|Резервная копия|Настройки|Пользователи|Синхронизация)/;   // меняют проект/файлы
(async () => {
  const { browser, page, errs } = await launch({ w: 1440, h: 900, theme: 'dark', wait: 2500 });
  page.setDefaultTimeout(60000);
  await openCloud(page); await page.waitForTimeout(2500);
  const OVERLAY = '.modal.open, .lx-modal-back, .lx-win-back, .lx-confirmbar, .lx-ask, .fpanel[data-esc], .lx-palette, #lxPalette, dialog[open]';
  const visibleOverlays = () => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 4 && r.height > 4 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0'; }).map((e) => (e.id ? '#' + e.id : '') + '.' + String(e.className).split(/\s+/).slice(0, 2).join('.')), OVERLAY);
  const tabs = await page.evaluate(() => [...document.querySelectorAll('#lxTabs [data-tab]')].map((b) => b.getAttribute('data-tab')));
  const bad = [], seen = [];
  page.on('crash', () => console.log('СТРАНИЦА УПАЛА после', seen[seen.length - 1])); page.on('close', () => console.log('СТРАНИЦА ЗАКРЫТА после', seen[seen.length - 1]));
  const only = process.env.CRAWL_TAB;
  for (const tab of tabs) {
    if (only && tab !== only) continue;
    await page.click(`#lxTabs [data-tab="${tab}"]`); await T(300);
    const names = await page.evaluate(() => [...document.querySelectorAll('#lxRibbon .lx-rb')].map((b, i) => ({ i, t: b.textContent.trim().replace(/\s+/g, ' ').slice(0, 40), dis: b.getAttribute('aria-disabled') === 'true' || b.disabled || !b.offsetParent, file: !!b.closest('label') || b.tagName === 'LABEL' })));
    for (const b of names) {
      if (b.dis || b.file || SKIP.test(b.t) || !b.t) continue;
      if (process.env.CRAWL_LOG) console.error('→', tab + '/' + b.t);
      const before = (await visibleOverlays()).length;
      const ok = await page.evaluate((i) => { const x = document.querySelectorAll('#lxRibbon .lx-rb')[i]; if (!x) return false; x.click(); return true; }, b.i);
      if (!ok) continue;
      await T(700);
      const opened = await visibleOverlays();
      seen.push(tab + '/' + b.t + ' → ' + (opened.length > before ? opened.join(',') : '—'));
      if (opened.length > before) {
        await page.keyboard.press('Escape'); await T(500);
        let left = await visibleOverlays();
        if (left.length > before) { await page.keyboard.press('Escape'); await T(400); left = await visibleOverlays(); }
        if (left.length > before) bad.push({ tab, cmd: b.t, stuck: left, how: 'Esc не закрывает' });
        // закрываем всё оставшееся «×» / отменой, чтобы не мешало следующим
        for (let k = 0; k < 3 && (await visibleOverlays()).length > before; k++) { await page.evaluate((sel) => { const m = [...document.querySelectorAll(sel)].pop(); const c = m && m.querySelector('.x,.icon-btn,.btn:not(.primary)'); if (c) c.click(); }, OVERLAY); await T(300); }
      } else { await page.keyboard.press('Escape'); await T(150); }
      // Esc и после команды без окна не должен оставлять режим «залипшим»
      await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; if (v && v.measuring && v.cancelMeasure) v.cancelMeasure(); });
    }
  }
  console.log('проверено кнопок:', seen.length); console.log(seen.join('\n'));
  console.log('НЕ ЗАКРЫВАЮТСЯ:', JSON.stringify(bad, null, 1));
  console.log('ошибки консоли:', JSON.stringify(errs.slice(0, 10)));
  await browser.close(); process.exit(0);
})().catch((e) => { console.error('СБОЙ', e); process.exit(1); });
