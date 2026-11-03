// Несколько облаков в проекте (не часть продукта): второе облако добавляется к первому, оба на экране (r11).
// В стенде нет Electron: parseCloud имитируется (облака читаются в Node и отдаются страницей целиком).
//   LAB_CLOUDS=a.ply,b.ply  sh /data/ui-lab/run.sh dev/ui-lab/multi-load.js
const { launch, shot } = require('./lab');
const cloud = require('../../las-node');
const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
(async () => {
  const files = process.env.LAB_CLOUDS.split(',');
  const data = {}; for (const f of files) { const r = cloud.parseCloudFile(f, { maxPoints: 200000000 }); data[f] = { n: r.pos.length / 3, pos: b64(r.pos), col: r.col ? b64(r.col) : null, meta: r.meta }; }
  const { browser, page, errs } = await launch({ w: 1440, h: 900, theme: 'dark', wait: 2500 });
  page.setDefaultTimeout(120000);
  await page.evaluate((data) => {
    const dec = (s) => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Float32Array(u.buffer); };
    window.__bimOverrides = { parseCloud: async (p) => { const d = data[p]; return { ok: true, kind: 'points', count: d.n, pos: dec(d.pos), col: d.col ? dec(d.col) : null, meta: Object.assign({ points: d.n, total: d.n }, d.meta) }; } };
  }, data);
  const state = () => page.evaluate(() => { const v = window.__viewer || window.__lxViewer; const cc = v.base[0].col; return { colType: cc && cc.constructor.name + ':' + Array.from(cc.slice(3000, 3006)).map((x) => +x.toFixed(2)).join(','), base: (v.base || []).map((b) => b.pos ? b.pos.length / 3 : b.count), real: (() => { const a = v.base[0].pos; let mx = -1e9; for (let i = 0; i < a.length; i += 3) if (a[i] > mx) mx = a[i]; return 'maxX=' + mx.toFixed(1); })(), bbox: v.bbox.mn.map((x) => +x.toFixed(1)).join(',') + ' → ' + v.bbox.mx.map((x) => +x.toFixed(1)).join(',') }; });
  for (const f of files) {
    await page.evaluate((p) => { window.__labPath = p; }, f);
    await page.setInputFiles('#modelInput', f); await page.waitForTimeout(5000);
    for (let k = 0; k < 3; k++) { const dlg = await page.$('.lx-ask'); if (!dlg) break; console.log('диалог:', (await dlg.innerText()).replace(/\s+/g, ' ').slice(0, 200)); await page.click('.lx-ask .form-actions .btn:last-child'); await page.waitForTimeout(1500); }
    await page.waitForTimeout(8000);
    console.log(f.split('/').pop(), JSON.stringify(await state())); await shot(page, 'multi-load-' + files.indexOf(f));
  }
  await shot(page, 'multi-load');
  console.log('ошибки консоли:', errs.slice(0, 5));
  await browser.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
