// Лаборатория «Обработка облака» (не часть продукта): ленточные кнопки, диалоги, фоновый расчёт, отмена, Ctrl+Z.
//   LAB_CLOUD=/data/work/noisy-room.ply  sh /data/ui-lab/run.sh process-lab.js
const { launch, openCloud, shot } = require('./lab');
const T = (s) => new Promise((r) => setTimeout(r, s));
(async () => {
  const { browser, page, errs } = await launch({ w: 1440, h: 900, theme: 'dark', wait: 2500 });
  page.setDefaultTimeout(120000);
  await openCloud(page); await page.waitForTimeout(2500);
  const V = () => page.evaluate(() => { const v = window.__viewer || window.__lxViewer; return v.base[0].pos.length / 3; });
  const thick = () => page.evaluate(() => {
    const v = window.__viewer || window.__lxViewer, P = v.base[0].pos, n = P.length / 3;
    function peak(lo, hi, axis) { const B = 0.002, m = Math.ceil((hi - lo) / B) + 1, h = new Int32Array(m); for (let i = 0; i < n; i++) { const x = P[i * 3 + axis]; if (x >= lo && x <= hi) h[Math.floor((x - lo) / B)]++; } let b = 0; for (let i = 1; i < m; i++) if (h[i] > h[b]) b = i; return lo + b * B; }
    function sd(c, w, axis) { let s = 0, q = 0, k = 0; for (let i = 0; i < n; i++) { const x = P[i * 3 + axis]; if (Math.abs(x - c) <= w) { s += x; q += x * x; k++; } } const m = s / k; return { sd: Math.sqrt(Math.max(0, q / k - m * m)) * 1000, k }; }
    let mn = 1e9, mx = -1e9; for (let i = 0; i < n; i++) { const x = P[i * 3]; if (x < mn) mn = x; if (x > mx) mx = x; }
    const a = peak(mn, mn + 0.5, 0), b = peak(mx - 0.5, mx, 0), fl = (() => { let y0 = 1e9; for (let i = 0; i < n; i++) if (P[i * 3 + 1] < y0) y0 = P[i * 3 + 1]; return peak(y0, y0 + 0.4, 1); })();
    return { n, wallX0: sd(a, 0.04, 0), wallX1: sd(b, 0.07, 0), floor: sd(fl, 0.04, 1) };
  });
  const fmt = (t) => `n=${t.n} стена: ${t.wallX0.sd.toFixed(2)} мм, двойная стена: ${t.wallX1.sd.toFixed(2)} мм, пол: ${t.floor.sd.toFixed(2)} мм`;
  console.log('исходно       ', fmt(await thick()));
  await page.click('#lxTabs [data-tab="cloud"]'); await page.waitForTimeout(500);
  await shot(page, 'proc-ribbon', { clip: { x: 0, y: 36, width: 1440, height: 136 } });
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
  console.log('ошибки консоли:', errs.length, errs.slice(0, 6).join(' || '));
  await browser.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
