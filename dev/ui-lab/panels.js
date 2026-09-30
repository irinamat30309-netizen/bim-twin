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
    try { if (typeof window.__p === 'function') window.__p(); window.__p = null; } catch (e) {}
    try { const sc = document.getElementById('segScene'); if (sc && !sc.classList.contains('active')) sc.click(); } catch (e) {}   // имитация долгой операции из сценариев progress/askover не должна перекрывать следующие
    try { window.__lxModes && window.__lxModes.cancelAll && window.__lxModes.cancelAll(); } catch (e) {}
    document.querySelectorAll('.lx-modal-back').forEach((n) => n.remove());
    document.querySelectorAll('[data-close]').forEach((b) => { if (b.offsetParent) b.click(); });
  });
  await page.waitForTimeout(250);
}
// В узких окнах правая колонка — выдвижная панель: если переключателя «Сцена/Документы» не видно, открываем её кнопкой заголовка
async function showInspector(page) {
  const seen = () => page.evaluate(() => { const r = document.getElementById('segDocs').getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth + 1; });
  if (!(await seen())) { await page.click('#tbInspector'); await page.waitForTimeout(600); }
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
  async verifyins(page) {   // измерения внутри окна «Инспектор объекта»: тип объекта, автосохранение, статус сверки
    await scenarios.objwin(page);
    await page.click('#lxInsKinds [data-kind="стена"]'); await page.waitForTimeout(200);
    await page.click('#lxInsModes [data-mode="distance"]'); await page.waitForTimeout(300);
    const c = await page.locator('#lxInsCanvas').boundingBox();
    for (const [a, b, d, e] of [[0.3, 0.5, 0.7, 0.5], [0.4, 0.3, 0.4, 0.75]]) {
      await page.mouse.click(c.x + c.width * a, c.y + c.height * b); await page.waitForTimeout(400);
      await page.mouse.click(c.x + c.width * d, c.y + c.height * e); await page.waitForTimeout(700);
    }
    await page.waitForTimeout(1200);
  },
  async verify(page) {      // окно «Сверка с документацией» после измерений в инспекторе
    await scenarios.verifyins(page);
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    await page.evaluate(() => window.__lxVerify.open({})); await page.waitForTimeout(900);
    const first = page.locator('.vf-main').first();
    if (await first.count()) { await first.click(); await page.waitForTimeout(900); }
  },
  async verifyfill(page) {  // пять готовых измерений: показывает все статусы; сначала баннер про единицы
    await page.evaluate(() => {
      try { localStorage.removeItem('bim.docCheck.defaultUnits'); } catch (e) {}
      const dc = window.__lxDocCheck;
      dc.add({ mode: 'distance', d3: 6.02, horizontal: 6.02, vertical: 0.01, dx: 6.02, dy: 0, dz: 0.01 }, { objectType: 'стена', origin: 'inspector' });
      dc.add({ mode: 'distance', d3: 2.87, horizontal: 0.02, vertical: 2.87, dx: 0.02, dy: 0, dz: 2.87 }, { objectType: 'стена', origin: 'inspector' });
      dc.add({ mode: 'distance', d3: 4.21, horizontal: 4.21, vertical: 0, dx: 4.21, dy: 0, dz: 0 }, { objectType: 'воздуховод', origin: 'inspector' });
      dc.add({ mode: 'plane', length: 2.1, width: 0.905, rectArea: 1.9, kind: 'стена', dip: 89.6, rms: 0.002, inlierCount: 900, total: 1000 }, { objectType: 'дверь', origin: 'inspector' });
      dc.add({ mode: 'angle', deg: 91.4, lenA: 2.0, lenC: 3.1 }, { origin: 'inspector' });
    });
    await page.evaluate(() => window.__lxVerify.open({})); await page.waitForTimeout(900);
  },
  async verifyfilled(page) {
    await scenarios.verifyfill(page);
    await page.click('.vf-banner .btn.primary'); await page.waitForTimeout(2200);
  },
  async verifymanual(page) {  // «Свои размеры»: номинал и допуск вводит человек; сравнение замера с ним; проверки прямо в сценарии
    await scenarios.verifyfilled(page);
    const must = (ok, msg) => { if (!ok) throw new Error('verifymanual: ' + msg); };
    await page.click('#lxVfModal [data-tab="reqs"]'); await page.waitForTimeout(900);
    must(await page.locator('.vf-man').count() === 1, 'нет блока «Свои размеры»');
    // пустое название не принимается и возвращает фокус в поле названия
    await page.fill('[data-fk="man-0-value"]', '905');
    await page.click('#lxVfManAdd'); await page.waitForTimeout(500);
    must((await page.locator('.vf-man .vf-own-msg').first().textContent()).includes('название'), 'нет подсказки про название');
    must(await page.evaluate(() => document.activeElement && document.activeElement.dataset.fk === 'man-label'), 'фокус не вернулся в поле названия');
    // ввод с клавиатуры не теряет фокус при перерисовке окна (фоновые события обновляют таблицу)
    await page.fill('[data-fk="man-label"]', 'Дверной проём Д-1');
    await page.focus('[data-fk="man-0-tol"]'); await page.keyboard.type('10');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lx-measurements-changed'))); await page.waitForTimeout(300);
    must(await page.evaluate(() => document.activeElement && document.activeElement.dataset.fk === 'man-0-tol'), 'фокус потерян при перерисовке');
    must(await page.inputValue('[data-fk="man-0-tol"]') === '10', 'допуск потерян при перерисовке');
    await page.click('.vf-man .vf-own-acts button:not(.primary)'); await page.waitForTimeout(250);
    await page.fill('[data-fk="man-1-value"]', '2100'); await page.fill('[data-fk="man-1-tol"]', '10');
    await page.selectOption('[data-fk="man-1-dim"]', 'height');
    await page.click('#lxVfManAdd'); await page.waitForTimeout(1500);
    must(await page.locator('.vf-man-item').count() === 1, 'размер не попал в список «Ваши размеры»');
    must((await page.locator('.vf-man-item').first().textContent()).includes('905'), 'в списке нет номинала');
    await shot(page, 'p-' + THEME + '-' + W + '-verifymanual-list').catch(() => {});
    // вкладка измерений: у строки «плоскость/дверь» — сравнение со своим размером
    await page.click('#lxVfModal [data-tab="rows"]'); await page.waitForTimeout(700);
    const target = page.locator('.vf-main', { hasText: 'Плоскость' }).first();
    must(await target.count() === 1, 'не нашлась строка плоскости');
    await target.click(); await page.waitForTimeout(1000);
    must(await page.locator('.vf-cmp').count() === 1, 'нет блока «Сравнить со своим размером»');
    const idx = await page.evaluate(() => document.querySelector('.vf-cmp [data-fk$="-value"]').dataset.fk.replace(/^cmp-(\d+)-value$/, '$1'));
    await page.selectOption('[data-fk="cmp-' + idx + '-dim"]', 'width');
    await page.fill('[data-fk="cmp-' + idx + '-value"]', '905'); await page.fill('[data-fk="cmp-' + idx + '-tol"]', '10');
    const opts = await page.locator('[data-fk="cmp-' + idx + '-field"] option').allTextContents();
    console.log('     замеры для сравнения:', JSON.stringify(opts));
    await page.click('#lxVfCmpGo'); await page.waitForTimeout(1500);
    const msg = await page.locator('.vf-cmp .vf-own-msg').first().textContent();
    console.log('     итог сравнения:', msg);
    must(/В допуске|Отклонение|Допуск не указан/.test(msg), 'нет результата сравнения: ' + msg);
    // неподходящие единицы дают понятный отказ, а не молчание
    await page.fill('[data-fk="cmp-' + idx + '-value"]', '0'); await page.click('#lxVfCmpGo'); await page.waitForTimeout(700);
    const bad = await page.locator('.vf-cmp .vf-own-msg').first().textContent();
    must(/Проверьте числа/.test(bad), 'нет отказа при нулевом значении: ' + bad);
    await page.fill('[data-fk="cmp-' + idx + '-value"]', '905'); await page.click('#lxVfCmpGo'); await page.waitForTimeout(900);
    await page.waitForTimeout(400);
  },
  async verifyopen(page) {  // раскрытая строка с отклонением и вариантами
    await scenarios.verifyfilled(page);
    const row = page.locator('.vf-main.proposal, .vf-main.warn').first();
    if (await row.count()) await row.click();
    await page.waitForTimeout(1200);
  },
  async verifychip(page) {  // клик по статусу в инспекторе: сверка открывается поверх окна инспектора
    await scenarios.verifyins(page);
    await page.locator('#lxInsHist .vf-chip, #lxInsModal button.vf-chip').first().click(); await page.waitForTimeout(900);
  },
  async verifystack(page) { // статус-чип в инспекторе открывает сверку поверх окна; Esc закрывает сначала сверку, потом инспектор
    await scenarios.verifyins(page);
    await page.locator('#lxInsHist .vf-chip, #lxInsModal button.vf-chip').first().click(); await page.waitForTimeout(800);
    const st = () => page.evaluate(() => ({ vf: !document.getElementById('lxVfModal').hidden, ins: !document.getElementById('lxInsModal').hidden }));
    const a = await st(); if (!a.vf || !a.ins) throw new Error('Ожидалось: сверка и инспектор открыты, получено ' + JSON.stringify(a));
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    const b = await st(); if (b.vf || !b.ins) throw new Error('Esc должен закрыть только сверку, получено ' + JSON.stringify(b));
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    const c = await st(); if (c.vf || c.ins) throw new Error('Второй Esc должен закрыть инспектор, получено ' + JSON.stringify(c));
    await page.evaluate(() => window.__lxVerify.open({})); await page.waitForTimeout(700);
  },
  async verifyaccept(page) { // «Принять» в строке и массовое «Принять предложения»
    await scenarios.verifyfilled(page);
    const q = page.locator('.vf-quick');
    const n = await q.count();
    if (n) { await page.locator('#lxVfAcceptAll').click(); await page.waitForTimeout(600); }
  },
  async verifyall(page) {
    await scenarios.verifyins(page);
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    await page.evaluate(() => window.__lxVerify.open({})); await page.waitForTimeout(700);
  },
  async verifyreqs(page) {
    await page.evaluate(() => window.__lxVerify.open({ tab: 'reqs' })); await page.waitForTimeout(1500);
  },
  async verifyempty(page) {
    await page.evaluate(() => window.__lxVerify.open({})); await page.waitForTimeout(700);
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
  async docs(page) { await showInspector(page); await page.click('#segDocs'); await page.waitForTimeout(800); },   // правая колонка: вкладка «Документы»
  async room(page) { await page.evaluate(() => { const r = document.querySelectorAll('#tree .room')[1]; if (r) r.click(); }); await page.waitForTimeout(1000); },
  async roomdocs(page) { await scenarios.room(page); await showInspector(page); await page.click('#segDocs'); await page.waitForTimeout(900); },
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
