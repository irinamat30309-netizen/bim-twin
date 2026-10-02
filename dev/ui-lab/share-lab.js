// Лаборатория «Доля точек файла» (не часть продукта): выбор в Настройках и в «Вид облака», перечитывание облака, передача кусками.
// В стенде нет Electron, поэтому main-сторона имитируется: parseCloud отдаёт `chunked`, readCloudChunk — куски из массивов страницы.
//   LAB_CLOUD=/data/work/noisy-room.ply  sh /data/ui-lab/run.sh share-lab.js
const { launch, openCloud, shot } = require('./lab');
const cloud = require('../../las-node');
const T = (s) => new Promise((r) => setTimeout(r, s));
const FILE = process.env.LAB_CLOUD || '/data/work/noisy-room.ply';
const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
(async () => {
  const variants = {};
  for (const [pct, share] of [[100, 1], [25, 0.25]]) {
    const r = cloud.parseCloudFile(FILE, { maxPoints: 200000000, pointShare: share });
    variants[pct] = { n: r.pos.length / 3, total: r.meta.total, pos: b64(r.pos), col: r.col ? b64(r.col) : null };
    console.log('вариант', pct + ' %', 'точек', variants[pct].n, 'из', r.meta.total);
  }
  const { browser, page, errs } = await launch({ w: 1440, h: 900, theme: 'dark', wait: 2500 });
  page.setDefaultTimeout(60000);
  await page.evaluate((variants) => {
    const dec = (s) => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Float32Array(u.buffer); };
    const data = {};
    for (const k in variants) data[k] = { n: variants[k].n, total: variants[k].total, pos: dec(variants[k].pos), col: variants[k].col ? dec(variants[k].col) : null };
    window.__labSettings = {}; window.__labLog = [];
    let live = null;
    window.__bimOverrides = {
      getSettings: () => Object.assign({}, window.__labSettings),
      setSettings: (patch) => { Object.assign(window.__labSettings, patch); window.__labLog.push('setSettings ' + JSON.stringify(patch)); return Object.assign({}, window.__labSettings); },
      parseCloud: async (p) => {
        const pct = String(window.__labSettings.pointShare || 100); const d = data[pct] || data[100];
        window.__labLog.push('parseCloud share=' + pct + ' n=' + d.n);
        live = { d };
        await new Promise((r) => setTimeout(r, 150));
        return { ok: true, kind: 'points', count: d.n, meta: { total: d.total, points: d.n, format: 'PLY' }, pointShare: pct === '100' ? undefined : Number(pct) / 100,
          chunked: { token: 'tok', count: d.n, chunkPoints: 20000, fields: { pos: { type: 'Float32Array', per: 3 }, col: { type: 'Float32Array', per: 3 } } } };
      },
      readCloudChunk: async (q) => { await new Promise((r) => setTimeout(r, 120)); return { ok: true, pos: live.d.pos.slice(q.from * 3, (q.from + q.count) * 3), col: live.d.col.slice(q.from * 3, (q.from + q.count) * 3) }; },
      releaseCloud: () => { window.__labLog.push('release'); live = null; return true; }
    };
    window.__labPath = 'C:\\scans\\room.ply';
  }, variants);
  await openCloud(page); await page.waitForTimeout(3000);
  const cnt = () => page.evaluate(() => { const v = window.__viewer || window.__lxViewer; const r = v._cloudRecord || {}; return { base: v.base[0].pos.length / 3, source: r.sourceCount, loaded: r.loadedCount }; });
  const log = () => page.evaluate(() => window.__labLog.slice());
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.lx-toast, .toast, #lxToasts *')].map((e) => e.textContent).filter(Boolean).slice(-3).join(' || '));
  console.log('1. открыт файл (100 %):', JSON.stringify(await cnt()), '| журнал:', JSON.stringify(await log()));
  await page.evaluate(() => document.getElementById('btnSettings').click()); await page.waitForSelector('.settings-body'); await T(400);
  const sec = await page.evaluate(() => { const h = [...document.querySelectorAll('.set-h')].map((e) => e.textContent); const row = [...document.querySelectorAll('.set-row')].find((r) => /Доля точек файла/.test(r.textContent)); return { sections: h, options: row ? [...row.querySelectorAll('option')].map((o) => o.textContent + (o.selected ? ' [выбрано]' : '')) : null }; });
  console.log('2. настройки:', JSON.stringify(sec));
  await page.evaluate(() => { const s = [...document.querySelectorAll('.set-sec')].find((x) => /Облака точек/.test(x.textContent)); if (s) s.scrollIntoView({ block: 'center' }); });
  await T(300); await shot(page, 'share-1-settings');
  await page.evaluate(() => { const row = [...document.querySelectorAll('.set-row')].find((r) => /Доля точек файла/.test(r.textContent)); const sel = row.querySelector('select'); sel.value = '25'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.evaluate(() => { [...document.querySelectorAll('.set-actions .btn.primary')].pop().click(); });
  let sawTransfer = false;
  for (let i = 0; i < 60; i++) { await T(80); const t = await page.evaluate(() => { const e = document.querySelector('.lx-progress'); return e ? e.textContent : ''; }); if (/Передаю облако в окно/.test(t)) { sawTransfer = true; await shot(page, 'share-2-transfer'); break; } }
  await T(3500);
  console.log('3. после «25 %»: окно прогресса «Передаю облако в окно» показано:', sawTransfer, '|', JSON.stringify(await cnt()));
  console.log('   журнал:', JSON.stringify(await log()));
  console.log('   тосты:', await toasts());
  await page.evaluate(() => { const r = document.querySelector('#lxCloudEntry'); if (r) r.click(); }); await T(600);
  console.log('4. панель облака:', JSON.stringify(await page.evaluate(() => ({ total: (document.getElementById('cpTotal') || {}).textContent, loaded: (document.getElementById('cpLoaded') || {}).textContent, note: (document.getElementById('cpShareNote') || {}).textContent, hidden: (document.getElementById('cpShareNote') || {}).hidden }))));
  await shot(page, 'share-3-panel');
  console.log('5. «Вид облака» → «Доля точек»:', await page.evaluate(() => { const s = document.getElementById('qShare'); return s ? s.value + ' (' + s.options.length + ' пунктов)' : 'нет'; }));
  await page.evaluate(() => { const s = document.getElementById('qShare'); s.value = '100'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await T(3500);
  console.log('   после «100 %» в панели:', JSON.stringify(await cnt()), '| журнал:', JSON.stringify((await log()).slice(-4)));
  await page.evaluate(() => { const r = document.querySelector('#lxCloudEntry'); if (r) r.click(); }); await T(500);
  console.log('   панель облака:', JSON.stringify(await page.evaluate(() => ({ loaded: (document.getElementById('cpLoaded') || {}).textContent, hidden: (document.getElementById('cpShareNote') || {}).hidden }))));
  console.log('ошибки консоли:', errs.length, errs.slice(0, 6).join(' || '));
  await browser.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
