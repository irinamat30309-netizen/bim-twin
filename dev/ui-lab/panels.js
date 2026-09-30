// Сценарии проверки панелей, меню и диалогов при открытом облаке точек. Снимки: shots/p-<тема>-<ширина>-<имя>.png
// node panels.js <ширина> <высота> <dark|light> [имя1,имя2,…]
const { launch, shot, openCloud, audit } = require('./lab');
const [,, W = '1440', H = '900', THEME = 'dark', ONLY = ''] = process.argv;
const only = ONLY ? ONLY.split(',') : null;

async function tabOf(page, id) {
  return page.evaluate((cid) => { const c = document.querySelector('#lxRibbon [data-cell="' + cid + '"]'); const p = c && c.closest('.lx-panel'); return p ? p.id.replace('lxPanel-', '') : null; }, id);
}
async function cmd(page, id, wait = 500) {
  const tab = await tabOf(page, id);
  if (!tab) throw new Error('нет команды ' + id);
  await page.click(`#lxTabs [data-tab="${tab}"]`); await page.waitForTimeout(250);
  const btn = page.locator(`#lxRibbon [data-cell="${id}"] button, #lxRibbon [data-cell="${id}"] label, #lxRibbon [data-cell="${id}"] .lx-rb`).first();
  await btn.click({ timeout: 12000 }); await page.waitForTimeout(wait);
}
async function reset(page) {
  await page.evaluate(() => { const c = document.getElementById('lxInsClose'); if (c && c.offsetParent) c.click(); }).catch(() => {});
  await page.waitForTimeout(200);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(120); }
  await page.evaluate(() => {
    try { window.__lxModes && window.__lxModes.cancelAll && window.__lxModes.cancelAll(); } catch (e) {}
    document.querySelectorAll('.lx-modal-back').forEach((n) => n.remove());
    document.querySelectorAll('[data-close]').forEach((b) => { if (b.offsetParent) b.click(); });
  });
  await page.waitForTimeout(250);
}
const scenarios = {
  async base(page) {},
  async quality(page) { await cmd(page, 'vtQuality'); },
  async edit(page) { await cmd(page, 'vtTools', 400); await page.locator('.lx-pop-item', { hasText: 'Ручное лассо' }).first().click({ timeout: 12000 }); await page.waitForTimeout(700); },
  async cleanmenu(page) { await cmd(page, 'vtTools'); },
  async geommenu(page) { await cmd(page, 'vtGeom'); },
  async section(page) { await cmd(page, 'btnSection', 900); },
  async measure(page) { await cmd(page, 'btnMeasure'); await cmd(page, 'mmDistance'); },
  async measureplane(page) { await cmd(page, 'btnMeasure'); await cmd(page, 'mmPlane'); },
  async measurelist(page) { await cmd(page, 'mmList'); },
  async measurelistfull(page) {
    await cmd(page, 'btnMeasure'); await cmd(page, 'mmDistance');
    const b = await page.locator('#viewer').boundingBox();
    for (const [a, c, d, e] of [[0.35, 0.6, 0.6, 0.62], [0.4, 0.45, 0.65, 0.5], [0.45, 0.7, 0.55, 0.3]]) {
      await page.mouse.click(b.x + b.width * a, b.y + b.height * c); await page.waitForTimeout(500);
      await page.mouse.click(b.x + b.width * d, b.y + b.height * e); await page.waitForTimeout(800);
      await page.click('#mmSave'); await page.waitForTimeout(500);
    }
    await cmd(page, 'mmList', 700);
  },
  async objinspect(page) { await cmd(page, 'lxObjInspectBtn', 900); },
  async objwin(page) {
    await cmd(page, 'lxObjInspectBtn', 700);
    const b = await page.locator('#viewer').boundingBox(), x1 = b.x + b.width * 0.3, y1 = b.y + b.height * 0.3, x2 = b.x + b.width * 0.7, y2 = b.y + b.height * 0.7;
    await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 6 }); await page.mouse.move(x2, y2, { steps: 6 }); await page.mouse.up();
    await page.waitForSelector('#lxInsModal:not([hidden])', { timeout: 20000 }); await page.waitForTimeout(2200);
  },
  async objwinmeasure(page) {
    await scenarios.objwin(page);
    await page.click('#lxInsModes [data-mode="distance"]'); await page.waitForTimeout(300);
    const c = await page.locator('#lxInsCanvas').boundingBox();
    await page.mouse.click(c.x + c.width * 0.35, c.y + c.height * 0.55); await page.waitForTimeout(500);
    await page.mouse.click(c.x + c.width * 0.65, c.y + c.height * 0.5); await page.waitForTimeout(900);
  },
  async objesc(page) {   // Esc должен закрывать окно «Инспектор объекта» (в подсказке кнопки написано «Закрыть · Esc»)
    await scenarios.objwin(page);
    await page.keyboard.press('Escape'); await page.waitForTimeout(500);
    const hidden = await page.evaluate(() => { const m = document.getElementById('lxInsModal'); return !m || m.hidden; });
    if (!hidden) throw new Error('Esc не закрыл окно «Инспектор объекта»');
  },
  async s2b(page) { await cmd(page, 'lxScan2BimBtn', 900); },
  async s2bai(page) { await cmd(page, 'lxScan2BimAiBtn', 900); },
  async flooradd(page) { await cmd(page, 'floorAdd', 700); },
  async convert(page) { await cmd(page, 'vtConvert', 900); },
  async settings(page) { await cmd(page, 'btnSettings', 800); },
  async newproject(page) { await cmd(page, 'btnNewProject', 800); },
  async compare(page) { await cmd(page, 'btnCompare', 800); },
  async drafts(page) { await cmd(page, 'drafts', 600); },
  async memory(page) { await cmd(page, 'vtMem', 600); },
  async draw(page) { await cmd(page, 'draw.pline', 700); },
  async palette(page) { await page.keyboard.press('Control+k'); await page.waitForTimeout(500); await page.keyboard.type('изме'); await page.waitForTimeout(400); },
  async console(page) { await page.click('#vtLog'); await page.waitForTimeout(500); },
  async progress(page) { await page.evaluate(() => { window.__p = window.__lxProgress.begin('Очистка облака…', { onCancel() {} }); window.__p.set && window.__p.set(0.42, 'Удаление выбросов…'); }); await page.waitForTimeout(1200); },
  async ask(page) { await page.evaluate(() => { window.__lxKit.ask({ title: 'Название этажа', message: 'Введите короткое название — оно появится в дереве сцены.', input: true, value: 'Этаж 1', okLabel: 'Сохранить' }); }); await page.waitForTimeout(500); },
  async askdanger(page) { await page.evaluate(() => { window.__lxKit.ask({ title: 'Удалить этаж?', message: 'Этаж «Подвал» будет удалён вместе с привязанными документами.', danger: true, okLabel: 'Удалить' }); }); await page.waitForTimeout(500); },
  async askmulti(page) { await page.evaluate(() => { window.__lxKit.ask({ title: 'Геопривязка по GCP', multiline: true, rows: 8, okLabel: 'Далее', placeholder: 'P1,0,0,0,100,200,10,1,control', message: 'Контрольные точки в формате CSV: name,srcX,srcY,srcZ,dstX,dstY,dstZ,weight,role. Координаты источника → целевые XYZ (Z вверх); минимум 3 неколлинеарных control.', hint: 'role=check — независимая проверка, в подгонке не участвует. weight — относительный вес (обычно 1/σ²).' }); }); await page.waitForTimeout(500); },
  async askover(page) { await page.evaluate(() => { window.__p = window.__lxProgress.begin('Геопривязка…', { onCancel() {} }); window.__p.set && window.__p.set(0.6, 'Взвешенное robust-решение…'); window.__lxKit.ask({ title: 'Большая ошибка GCP', danger: true, okLabel: 'Всё равно применить', message: 'Control RMS 0.0712 м, максимум control 0.1204 м. Проверьте единицы, точки и CRS. Применить преобразование?' }); }); await page.waitForTimeout(700); },
  async toasts(page) { await page.evaluate(() => { const k = window.__lxKit; k.toast('Облако загружено: 296 063 точек', { tone: 'ok' }); k.toast('Проверьте единицы измерения', { tone: 'warn' }); k.toast('Не удалось сохранить проект', { tone: 'err' }); k.toast('Обычное уведомление'); k.toast('Обычное уведомление'); }); await page.waitForTimeout(1400); },
  async more(page) { await page.evaluate(() => { const b = document.querySelector('[data-cell="more"] button, .lx-more'); if (b) b.click(); }); await page.waitForTimeout(400); },
  async tree(page) { await page.evaluate(() => { document.querySelectorAll('.lx-node .lx-cloud-eye').forEach(() => {}); }); },
  async drawer(page) { if ((await page.evaluate(() => innerWidth)) > 1100) { console.log('     (выдвижные панели включаются на ширине ≤1100 px — пропуск)'); return; } await page.click('#tbSide'); await page.waitForTimeout(600); },
  async inspectordrawer(page) { if ((await page.evaluate(() => innerWidth)) > 1100) return; await page.click('#tbInspector'); await page.waitForTimeout(600); }
};
(async () => {
  const { browser, page, errs } = await launch({ w: +W, h: +H, theme: THEME });
  await openCloud(page);
  for (const name of Object.keys(scenarios)) {
    if (only && !only.includes(name)) continue;
    try { await scenarios[name](page); await shot(page, `p-${THEME}-${W}-${name}`); const a = await audit(page); console.log('ok  ', name, a.length ? '\n     ! ' + a.join('\n     ! ') : ''); }
    catch (e) { console.log('FAIL', name, String(e.message).split('\n')[0].slice(0, 160)); try { await shot(page, `p-${THEME}-${W}-${name}-FAIL`); } catch (_) {} }
    await reset(page);
  }
  console.log('errors:', errs.length); errs.slice(0, 20).forEach((e) => console.log(e));
  await browser.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
