// Накопительный кадр потока (ревизия 12; не часть продукта): сравнение с прямой отрисовкой, малая видеопамять, цена перерисовки в покое.
//   LAB_OCT=/путь/к/индексу  sh /data/ui-lab/run.sh dev/ui-lab/accum-lab.js
const fs = require('fs'), path = require('path');
const { launch, openCloud } = require('./lab');
const dir = process.env.LAB_OCT;
if (!dir) { console.error('укажите LAB_OCT=каталог индекса (index.json + nodes.bin)'); process.exit(2); }
const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
const byKey = new Map(index.nodes.map((n) => [n.key, n]));
const fd = fs.openSync(path.join(dir, 'nodes.bin'), 'r');
const OUT = process.env.SHOTS || '/data/work/r12/shots'; fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const { browser, page, errs } = await launch({ w: 1100, h: 700, theme: 'dark', wait: 2500 });
  page.setDefaultTimeout(600000);
  await page.route('**/__oct/**', (route) => {
    const key = decodeURIComponent(route.request().url().split('/__oct/')[1]); const n = byKey.get(key);
    if (!n) return route.fulfill({ status: 404, body: 'nf' });
    const buf = Buffer.alloc(n.byteLength); fs.readSync(fd, buf, 0, n.byteLength, n.offset);
    return route.fulfill({ status: 200, body: buf, contentType: 'application/octet-stream' });
  });
  await openCloud(page); await page.waitForTimeout(1000);
  await page.evaluate((idx) => {
    const v = window.__viewer || window.__lxViewer; window.__fetches = 0;
    v.setOctreeStream({ index: idx, fetchNode: (key) => { window.__fetches++; return fetch('/__oct/' + key).then((r) => r.arrayBuffer()).then((ab) => window.OctreeStore.decodeNodeGpu(new Uint8Array(ab), idx.nodes.find((x) => x.key === key).count, idx, true)); } });
  }, index);
  const V = (f, a) => page.evaluate(f, a);
  const frame = () => V(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const settle = async () => { const t = Date.now(); for (let i = 0; i < 2400; i++) { const a = await V(() => { const v = window.__viewer || window.__lxViewer; return v.getOctreeAccum(); }); if (a.active && a.remaining === 0) return { ms: Date.now() - t, a }; await page.waitForTimeout(50); } return { ms: -1, a: null }; };
  const settleOld = async () => { const t = Date.now(); let last = -1, same = 0; for (let i = 0; i < 2400; i++) { const s = await V(() => { const v = window.__viewer || window.__lxViewer; return v.getOctreeStats(); }); if (s && s.missing === 0 && s.inflight === 0 && s.drawn > 0) { if (s.drawn === last) { if (++same > 6) return { ms: Date.now() - t, s }; } else { same = 0; last = s.drawn; } } await page.waitForTimeout(60); } return { ms: -1, s: null }; };
  const snap = async (name) => { const d = await V(() => (window.__viewer || window.__lxViewer).canvas.toDataURL('image/png')); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(d.split(',')[1], 'base64')); };
  const views = { overview: null, mid: { t: [25, 20, 6], d: 40, yaw: 0.5, pitch: 0.3 }, near: { t: [0, 20, 6], d: 6, yaw: 0.9, pitch: 0.1 } };
  for (const [name, c] of Object.entries(views)) {
    if (c) await V((c) => { const v = window.__viewer || window.__lxViewer; v.target = c.t.slice(); v.dist = c.d; v.yaw = c.yaw; v.pitch = c.pitch; v.render(); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }, c);
    const f0 = await V(() => window.__fetches);
    const a = await settle(); await snap(name + '_acc');
    const f1 = await V(() => window.__fetches);
    console.log('вид ' + name + ': накопление ' + a.ms + ' мс, нарисовано ' + (a.a && a.a.drawnPoints) + ' из ' + (a.a && a.a.totalPoints) + ' (узлов ' + (a.a && a.a.nodes) + ', кадров ' + (a.a && a.a.frames) + '), чтений узлов ' + (f1 - f0));
    // старый путь для сравнения
    await V(() => (window.__viewer || window.__lxViewer).setOctreeAccum(false)); await frame();
    const o = await settleOld(); await snap(name + '_old');
    console.log('   прямая отрисовка: нарисовано ' + (o.s && o.s.drawn) + ' из ' + (o.s && o.s.points) + ', ' + o.ms + ' мс');
    await V(() => (window.__viewer || window.__lxViewer).setOctreeAccum(true)); await frame();
    await settle();
  }
  // малая видеопамять: предел 12 МБ (≈1,2 млн точек) — накопление всё равно рисует все точки в кадре
  await V(() => { const v = window.__viewer || window.__lxViewer; v.setOctreeAccum(true); v._octVramBytes = 12 * 1048576; v._octAcc = null; v.target = [25, 20, 6]; v.dist = 70; v.yaw = 0.4; v.pitch = 0.3; v.render(); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
  const lo = await settle(); await snap('lowvram_acc');
  const res = await V(() => (window.__viewer || window.__lxViewer)._octResPoints);
  console.log('малая видеопамять (12 МБ): нарисовано ' + (lo.a && lo.a.drawnPoints) + ' из ' + (lo.a && lo.a.totalPoints) + ', в видеопамяти осталось точек ' + res + ', ' + lo.ms + ' мс');
  await V(() => { const v = window.__viewer || window.__lxViewer; v.setOctreeAccum(false); });
  const lo2 = await settleOld(); await snap('lowvram_old');
  console.log('   то же без накопления (как раньше): нарисовано ' + (lo2.s && lo2.s.drawn) + ' из ' + (lo2.s && lo2.s.points));
  // цена перерисовки в покое (наведение/измерение): накопленная картинка vs полная отрисовка
  await V(() => { const v = window.__viewer || window.__lxViewer; v._octVramBytes = 0; v.setOctreeAccum(true); v.render(); });
  await settle();
  const cost = await V(async () => {
    const v = window.__viewer || window.__lxViewer, gl = v.gl; const t = (n) => { const t0 = performance.now(); for (let i = 0; i < n; i++) { v._renderNow(); } gl.finish(); return (performance.now() - t0) / n; };
    const acc = t(30); v.setOctreeAccum(false); const old = t(10); v.setOctreeAccum(true); return { acc, old };
  });
  console.log('перерисовка в покое (мс/кадр): накопленная ' + cost.acc.toFixed(1) + ', полная ' + cost.old.toFixed(1));
  console.log('ошибки консоли:', errs.length, errs.slice(0, 3).join(' | '));
  await browser.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
