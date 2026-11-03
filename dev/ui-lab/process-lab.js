// Лаборатория «Обработка облака» (не часть продукта): ленточные кнопки, диалоги, фоновый расчёт, отмена, Ctrl+Z.
//   LAB_CLOUD=/data/work/noisy-room.ply  sh /data/ui-lab/run.sh process-lab.js
const { launch, openCloud, shot } = require('./lab');
const T = (s) => new Promise((r) => setTimeout(r, s));
(async () => {
  const { browser, page, errs } = await launch({ w: 1440, h: 900, theme: 'dark', wait: 2500 });
  page.setDefaultTimeout(120000);
  await openCloud(page); await page.waitForTimeout(2500);
  const V = () => page.evaluate(() => { const v = window.__viewer || window.__lxViewer; return v.base[0].pos.length / 3; });
  // Толщина слоя — MAD·1,4826 вокруг медианы точек в узкой полосе у пика гистограммы: устойчива к кромкам и летящим точкам
  const thick = () => page.evaluate(() => {
    const v = window.__viewer || window.__lxViewer, P = v.base[0].pos, n = P.length / 3;
    function layer(lo, hi, axis, w) {
      const B = 0.002, m = Math.ceil((hi - lo) / B) + 1, h = new Int32Array(m);
      for (let i = 0; i < n; i++) { const x = P[i * 3 + axis]; if (x >= lo && x <= hi) h[Math.floor((x - lo) / B)]++; }
      let bi = 0; for (let k = 1; k < m; k++) if (h[k] > h[bi]) bi = k;
      const c = lo + (bi + 0.5) * B, vals = [];
      for (let i = 0; i < n; i++) { const x = P[i * 3 + axis]; if (Math.abs(x - c) <= w) vals.push(x); }
      vals.sort((p, q) => p - q); const med = vals[vals.length >> 1];
      const dev = vals.map((x) => Math.abs(x - med)).sort((p, q) => p - q);
      return { sd: dev[dev.length >> 1] * 1.4826 * 1000, k: vals.length };
    }
    let mn = 1e9, mx = -1e9, y0 = 1e9; for (let i = 0; i < n; i++) { const x = P[i * 3], y = P[i * 3 + 1]; if (x < mn) mn = x; if (x > mx) mx = x; if (y < y0) y0 = y; }
    return { n, wallX0: layer(mn, mn + 0.5, 0, 0.04), wallX1: layer(mx - 0.5, mx, 0, 0.07), floor: layer(y0, y0 + 0.4, 1, 0.04) };
  });
  const fmt = (t) => `n=${t.n} стена: ${t.wallX0.sd.toFixed(2)} мм, двойная стена: ${t.wallX1.sd.toFixed(2)} мм, пол: ${t.floor.sd.toFixed(2)} мм`;
  if (!process.env.CANCEL_ONLY) {
  console.log('исходно       ', fmt(await thick()));
  await page.click('#lxTabs [data-tab="cloud"]'); await page.waitForTimeout(500);
  await shot(page, 'proc-ribbon', { clip: { x: 0, y: 36, width: 1440, height: 136 } });
  }
  const btn = (name) => page.evaluate((name) => { const b = [...document.querySelectorAll('#lxRibbon .lx-rb')].find((x) => x.textContent.trim().startsWith(name)); if (!b) return false; b.click(); return true; }, name);
  const setField = (idx, val) => page.evaluate(([idx, val]) => { const c = document.querySelectorAll('.lx-ask .lx-form-row')[idx].querySelector('input,select'); if (c.type === 'checkbox') c.checked = !!val; else c.value = String(val); c.dispatchEvent(new Event('input', { bubbles: true })); c.dispatchEvent(new Event('change', { bubbles: true })); }, [idx, val]);
  const dlg = () => page.evaluate(() => { const d = document.querySelector('.lx-ask'); return d ? { title: d.querySelector('.modal-head span').textContent, rows: [...d.querySelectorAll('.lx-form-row')].map((r) => (r.hidden ? '[скрыто] ' : '') + r.querySelector('.lx-form-lbl').textContent + ' = ' + (r.querySelector('input,select').type === 'checkbox' ? r.querySelector('input').checked : r.querySelector('input,select').value)) } : null; });
  const apply = () => page.evaluate(() => { document.querySelector('.lx-ask .btn.primary').click(); });
  const toastTxt = () => page.evaluate(() => [...document.querySelectorAll('.lx-toast, #lxToasts *, .toast')].map((e) => e.textContent).filter(Boolean).slice(-3).join(' || '));
  async function waitDone() { for (let i = 0; i < 400; i++) { await T(250); const busy = await page.evaluate(() => document.documentElement.classList.contains('lx-operation-busy')); if (!busy && i > 2) break; } await T(600); }
  async function op(name, fields, label) {
    const before = await V();
    if (!await btn(name)) { console.log('НЕТ КНОПКИ', name); return; }
    await page.waitForSelector('.lx-ask', { timeout: 5000 });
    await T(200);
    const d0 = await dlg(); console.log('диалог:', JSON.stringify(d0));
    await shot(page, 'proc-dlg-' + label);
    for (const [i, v] of fields) { await setField(i, v); await T(50); }
    const d1 = fields.length ? await dlg() : null; if (d1) console.log('  ->', JSON.stringify(d1.rows));
    await apply(); const t0 = Date.now(); await waitDone();
    console.log(label.padEnd(14), ((Date.now() - t0) / 1000).toFixed(1) + ' с', fmt(await thick()), '| точек было', before);
    console.log('   тост:', (await toastTxt()).slice(0, 260));
  }
  const side = async (name) => { await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; v.yaw = 0; v.pitch = 0; v.render(); }); await T(500); await shot(page, name); };
  if (!process.env.CANCEL_ONLY) {
  await side('proc-0-raw');
  await op('Подавление шума', [], 'denoise');
  await op('Сглаживание', [], 'smooth');
  await side('proc-1-smooth');
  await op('Выровнять поверхности', [[0, 0.06]], 'flatten');
  await side('proc-2-flatten');
  await op('Ресэмплирование', [[0, 'random'], [1, 50]], 'resample50');
  await page.keyboard.press('Control+z'); await T(1500);
  console.log('после Ctrl+Z:', fmt(await thick()));
  await op('Ресэмплирование', [[0, 'voxel'], [2, 0.05]], 'voxel5cm');
  }
  // Отмена: тяжёлая операция (подавление шума малым радиусом) и Esc через 400 мс — облако не должно измениться
  {
    const before = await V();
    if (await btn('Подавление шума')) {
      await page.waitForSelector('.lx-ask'); await T(200);
      await setField(0, +(process.env.CANCEL_R || 0.012)); await setField(1, 30);
      await apply(); await T(400);
      const busy = await page.evaluate(() => document.documentElement.classList.contains('lx-operation-busy'));
      await page.keyboard.press('Escape');
      let freed = false; for (let i = 0; i < 40; i++) { await T(250); if (!await page.evaluate(() => document.documentElement.classList.contains('lx-operation-busy'))) { freed = true; break; } }
      console.log('отмена: операция шла к моменту Esc =', busy, '| интерфейс освобождён =', freed, '| точек до/после:', before, await V(), '| тост:', (await toastTxt()).slice(0, 160));
    }
  }
  console.log('ошибки консоли:', errs.length, errs.slice(0, 6).join(' || '));
  await browser.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
