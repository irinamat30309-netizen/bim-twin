// Обычный режим: ВСЕ точки облака целиком (ревизия 13; не часть продукта), цвет 3 байта, срез при движении.
//   sh /data/ui-lab/run.sh dev/ui-lab/regular-lab.js            (N=14000000 — число точек)
const fs = require('fs'), path = require('path');
const { launch } = require('./lab');
const N = +process.env.N || 14000000, OUT = process.env.SHOTS || '/data/work/r13/shots'; fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const { browser, page, errs } = await launch({ w: 1000, h: 640, theme: 'dark', wait: 2000 });
  page.setDefaultTimeout(600000);
  const r = await page.evaluate((N) => {
    const v = window.__viewer || window.__lxViewer; let s = 7; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { const a = rnd() * 6.283, h = rnd() * 6; pos[i * 3] = 8 * Math.cos(a) + (rnd() - .5) * .02; pos[i * 3 + 1] = h; pos[i * 3 + 2] = 8 * Math.sin(a) + (rnd() - .5) * .02; col[i * 3] = 0.3 + 0.6 * (h / 6); col[i * 3 + 1] = 0.5; col[i * 3 + 2] = 0.9 - 0.6 * (h / 6); }
    v._bigColorPoints = 1e12;              // сначала — прежний путь (цвет Float32)
    v.loadCloud({ pos, col, count: N, name: 'big', meta: { total: N, format: 'las' } });
    return { count: v.base[0].count, decimated: v._decimatedFrom, shuffled: !!v.base[0]._shuffled };
  }, N);
  console.log('загружено в обычном режиме:', JSON.stringify(r), '(из ' + N + ')');
  const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const snapMem = (name) => page.evaluate((name) => { window.__shots = window.__shots || {}; window.__shots[name] = (window.__viewer || window.__lxViewer).canvas.toDataURL('image/png'); }, name);
  const snap = async (name) => { await snapMem(name); const d = await page.evaluate(() => (window.__viewer || window.__lxViewer).canvas.toDataURL('image/png')); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(d.split(',')[1], 'base64')); };
  await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; v.target = [0, 3, 0]; v.dist = 30; v.yaw = 0.6; v.pitch = 0.25; v.render(); });
  await frame(); await frame(); await snap('f32');
  const colBytes = await page.evaluate((N) => {
    const v = window.__viewer || window.__lxViewer; v._bigColorPoints = 12000000;
    const pos = v.base[0].pos, col = v.base[0].col; v.loadCloud({ pos, col, count: N, name: 'big', meta: { total: N, format: 'las' }, spacing: v.base[0]._spacing }, { preserveView: true });
    v.target = [0, 3, 0]; v.dist = 30; v.yaw = 0.6; v.pitch = 0.25; v.render();
    return { count: v.base[0].count, decimated: v._decimatedFrom };
  }, N);
  await frame(); await frame(); await snap('u8');
  console.log('цвет 3 байта:', JSON.stringify(colBytes));
  const diff = await page.evaluate(async () => {
    const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.filter = 'blur(2px)'; x.drawImage(i, 0, 0); r(x.getImageData(0, 0, c.width, c.height).data); }; i.src = u; });
    const a = await load(window.__shots.f32), b = await load(window.__shots.u8); let sum = 0, lit = 0, mx = 0;
    for (let i = 0; i < a.length; i += 4) { const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); sum += d; if (d > mx) mx = d; if (a[i] + a[i + 1] + a[i + 2] > 60) lit++; }
    return { mean: sum / (a.length / 4), max: mx, litShare: lit / (a.length / 4) };
  });
  console.log('Float32-цвет против 3 байт (после размытия, из 765):', JSON.stringify(diff));
  const move = await page.evaluate(() => {
    const v = window.__viewer || window.__lxViewer, o = {}; const probe = () => { v._interacting = true; v._renderNow(); const d = v._probeDrawn; v._interacting = false; return d; };
    o.full = (v.render(), v._probeIdle, v.base[0].count);
    v._octMovePct = 0; v._interPts = 0; o.autoFirst = probe();
    for (let i = 0; i < 40; i++) probe(); o.autoAfter40 = probe();
    v._octMovePct = 75; o.p75 = probe(); v._octMovePct = 25; o.p25 = probe(); v._octMovePct = 0;
    return o;
  });
  console.log('при движении (рисуется точек):', JSON.stringify(move));
  console.log('ошибки консоли:', errs.length, errs.slice(0, 3).join(' | '));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
