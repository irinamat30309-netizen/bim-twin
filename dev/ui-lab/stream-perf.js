// Потоковый режим на готовом дисковом индексе (ревизия 9; не часть продукта).
//   LAB_OCT=/путь/к/каталогу/индекса  sh /data/ui-lab/run.sh dev/ui-lab/stream-perf.js
// Индекс строится так: node octree-build-core (см. dev/ui-lab/README.md). Страница читает узлы через перехват запросов /__oct/<ключ>
// (как приложение читает их через IPC). Печатает: сколько точек выбрано/нарисовано, сколько узлов ждёт загрузки, время кадра на стороне JS,
// длинные задачи основного потока при вращении, и сохраняет снимок в покое.
const fs = require('fs'), path = require('path');
const { launch, openCloud, shot } = require('./lab');
const dir = process.env.LAB_OCT;
if (!dir) { console.error('укажите LAB_OCT=каталог индекса (index.json + nodes.bin)'); process.exit(2); }
const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
const byKey = new Map(index.nodes.map((n) => [n.key, n]));
const fd = fs.openSync(path.join(dir, 'nodes.bin'), 'r');
(async () => {
  const { browser, page, errs } = await launch({ w: +process.env.LAB_W || 1280, h: +process.env.LAB_H || 800, theme: 'dark', wait: 2500 });
  page.setDefaultTimeout(600000);
  let reads = 0, readBytes = 0;
  await page.route('**/__oct/**', (route) => {
    const key = decodeURIComponent(route.request().url().split('/__oct/')[1]);
    const n = byKey.get(key);
    if (!n) return route.fulfill({ status: 404, body: 'nf' });
    const buf = Buffer.alloc(n.byteLength); fs.readSync(fd, buf, 0, n.byteLength, n.offset); reads++; readBytes += n.byteLength;
    return route.fulfill({ status: 200, body: buf, contentType: 'application/octet-stream' });
  });
  await openCloud(page);
  await page.waitForTimeout(1500);
  await page.evaluate(([idx, cap]) => {
    const v = window.__viewer || window.__lxViewer;
    window.__lt = []; window.__js = [];
    try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push(e.duration))).observe({ entryTypes: ['longtask'] }); } catch (e) { }
    const od = v._drawOctree; v._drawOctree = function () { const t = performance.now(); const r = od.apply(this, arguments); window.__js.push(performance.now() - t); return r; };
    v.setOctreeStream({
      index: idx,
      fetchNode: (key) => fetch('/__oct/' + key).then((r) => r.arrayBuffer()).then((ab) => {
        const nd = idx.nodes.find((x) => x.key === key);
        return window.OctreeStore.decodeNodeGpu(new Uint8Array(ab), nd.count, idx);
      })
    });
    if (cap) v.setLodBudget(cap);
  }, [index, +process.env.LAB_CAP || 0]);
  const stats = () => page.evaluate(() => { const v = window.__viewer || window.__lxViewer; return v.getOctreeStats(); });
  const settleWait = async (min) => { const t = Date.now(); let st = null, first = null; for (let i = 0; i < 900; i++) { st = await stats(); if (st && st.drawn > 0 && first == null) first = Date.now() - t; if (st && st.missing === 0 && st.inflight === 0 && i > (min || 3)) break; await page.waitForTimeout(100); } return { st, first, ms: Date.now() - t }; };
  console.log('индекс: точек', index.pointCount, 'узлов', index.nodeCount);
  // Виды (координаты вьюера: Y вверх; для синтетического скана фасад у (-25, 0..45, -20), камера со стороны +Z)
  const views = process.env.LAB_VIEWS ? JSON.parse(process.env.LAB_VIEWS) : { overview: null, mid: { t: [-25, 12, -20], d: 90, yaw: 0.35, pitch: 0.25 }, near: { t: [-25, 8, -20], d: 14, yaw: 0.2, pitch: 0.12 }, close: { t: [-25, 6, -20], d: 3.5, yaw: 0.1, pitch: 0.05 } };
  for (const [name, c] of Object.entries(views)) {
    if (c) await page.evaluate((c) => { const v = window.__viewer || window.__lxViewer; v.target = c.t.slice(); v.dist = c.d; v.yaw = c.yaw; v.pitch = c.pitch; v.render(); }, c);
    const r0 = reads, b0 = readBytes;
    const w = await settleWait(5);
    console.log('вид ' + name + ': первые точки ' + w.first + ' мс, готово за ' + w.ms + ' мс, чтений ' + (reads - r0) + ' (' + ((readBytes - b0) / 1e6).toFixed(0) + ' МБ) | узлов ' + w.st.nodes + ', выбрано ' + (w.st.points / 1e6).toFixed(2) + ' млн, нарисовано ' + (w.st.drawn / 1e6).toFixed(2) + ' млн (' + (100 * w.st.drawn / w.st.total).toFixed(1) + ' % файла)');
    await shot(page, 'stream_' + name);
  }
  let st = await stats();
  const box = await page.evaluate(() => { const r = (window.__viewer || window.__lxViewer).canvas.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  await page.evaluate(() => { window.__lt.length = 0; window.__js.length = 0; });
  await page.mouse.move(cx, cy); await page.mouse.down();
  const mv = [];
  for (let i = 0; i < 60; i++) { await page.mouse.move(cx + 5 * i, cy + 2 * i); await page.waitForTimeout(30); if (i % 10 === 9) mv.push(await stats()); }
  await page.mouse.up(); await page.waitForTimeout(400);
  console.log('при вращении (каждые 10 кадров): точек выбрано/нарисовано/ждёт узлов:', mv.map((s) => s ? ((s.points / 1e6).toFixed(1) + '/' + (s.drawn / 1e6).toFixed(1) + '/' + s.missing) : '-').join('  '));
  for (let i = 0; i < 300; i++) { st = await stats(); if (st && st.missing === 0 && st.inflight === 0) break; await page.waitForTimeout(100); }
  const r = await page.evaluate(() => { const js = window.__js.slice().sort((a, b) => a - b), lt = window.__lt.slice().sort((a, b) => b - a); return { frames: js.length, jsMed: js[js.length >> 1], jsMax: js[js.length - 1], longN: lt.length, longMax: lt[0] || 0 }; });
  console.log('JS-часть кадра: медиана', r.jsMed.toFixed(2), 'мс, макс', r.jsMax.toFixed(1), 'мс (кадров', r.frames + '); длинных задач (>50 мс):', r.longN, 'макс', r.longMax.toFixed(0), 'мс');
  console.log('после вращения:', JSON.stringify(st));
  await shot(page, 'stream_after');
  console.log('ошибок консоли', errs.length, errs.slice(0, 3).join(' || '));
  await browser.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
