// Проверка точного захвата на РЕАЛЬНОМ облаке против эталона (не часть продукта).
//   LAB_CLOUD  — PLY-файл;  LAB_GT — JSON эталона {snaps:{id:{kind,ideal,gt,n,dir}}, pairs:[{name,a,b,kind,gt}]} в исходных координатах;
//   LAB_OUT    — куда записать результаты (JSON).  Запуск: sh run.sh real-snap.js
// Приложение при загрузке центрирует облако, поэтому сдвиг определяется по первым вершинам файла и точкам во viewer.
const { launch } = require('./lab');
const { plyBbox } = require('./ply-bbox');
const fs = require('fs');
(async () => {
  const cloud = process.env.LAB_CLOUD, GT = JSON.parse(fs.readFileSync(process.env.LAB_GT, 'utf8'));
  const outFile = process.env.LAB_OUT || '/tmp/real-snap-results.json';
  const t0 = Date.now();
  const { browser, page, errs } = await launch({ w: 1440, h: 900, theme: 'dark', wait: 2500 });
  page.setDefaultTimeout(300000);
  await page.setInputFiles('#modelInput', cloud);
  let info = null;
  for (let i = 0; i < 150; i++) {
    await page.waitForTimeout(2000);
    info = await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; const b = v && v.base && v.base[0]; return b && b.pos ? { n: b.pos.length / 3, spacing: b._spacing } : null; });
    if (info && info.n > 1000) break;
  }
  const loadSec = Math.round((Date.now() - t0) / 1000);
  console.log('загрузка', loadSec, 'с; точек в просмотре', info.n, 'шаг', info.spacing);
  await page.waitForTimeout(2500);
  // сдвиг: viewer = исходные + shift, где shift = -(центр габарита файла)
  const bb = plyBbox(cloud), shift = [0, 1, 2].map((k) => -(bb.mn[k] + bb.mx[k]) / 2);
  console.log('точек в файле', bb.nv, '| сдвиг центрирования', shift.map((v) => v.toFixed(4)).join(', '));
  const OS = +(process.env.LAB_SPREAD || 0.55), PXS = (process.env.LAB_PX || '16,32').split(',').map(Number);
  const res = await page.evaluate(({ GT, shift, OS, PXS }) => {
    const v = window.__viewer || window.__lxViewer, PS = window.PrecisionSnap;
    v.setMeasure(true); v.setMeasureMode && v.setMeasureMode('distance');
    const idx = v._psIndex(), indexMs = v._psCache ? v._psCache.ms : 0;
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    // разброс кликов: как у человека, который целится курсором в ~1 см от нужной точки (OS — масштаб от ±3 см)
    const OFF = [[0, 0, 0], [0.02, 0.02, 0], [-0.02, 0.015, 0.01], [0.01, -0.03, -0.02], [-0.03, -0.01, 0.02], [0.025, 0, -0.025]].map((o) => o.map((x) => x * OS));
    const near = (c) => { const j = idx.nearest(c[0], c[1], c[2], 0.15); return j < 0 ? null : [idx.pos[j * 3], idx.pos[j * 3 + 1], idx.pos[j * 3 + 2]]; };
    const toO = (p) => [p[0] - shift[0], p[1] - shift[1], p[2] - shift[2]];
    const R = { indexMs, n: idx.n, spacing: idx.spacing, snaps: {}, pairs: {}, ids: Object.keys(GT.snaps) };
    // Камера как у пользователя при замере: 2 м до точки; радиус захвата в пикселях даёт метры через масштаб экрана
    const snapAt = (seed, opt) => { v.target = seed.slice(); v.dist = 2; v._ortho = false; return v._precisionSnapAt(seed, opt); };
    const errOf = (g, r) => {
      const gp = (r.contour && g.gtC) ? g.gtC : g.gt, d = sub(toO(r.point), gp);
      if (g.kind === 'plane') return Math.abs(dot(d, g.n));
      if (g.kind === 'edge') { const al = dot(d, g.dir); return Math.hypot(d[0] - g.dir[0] * al, d[1] - g.dir[1] * al, d[2] - g.dir[2] * al); }
      return Math.hypot(d[0], d[1], d[2]);
    };
    for (const px of PXS) {
      const cache = {};
      const get = (id, i) => {
        const key = id + '#' + i; if (key in cache) return cache[key];
        const g = GT.snaps[id], o = OFF[i % OFF.length], c = [g.ideal[0] + shift[0] + o[0], g.ideal[1] + shift[1] + o[1], g.ideal[2] + shift[2] + o[2]], seed = near(c);
        if (!seed) return (cache[key] = null);
        const a0 = snapAt(seed, { grow: false, px }), a1 = snapAt(seed, { grow: true, px });
        return (cache[key] = a1 ? { r: a1, r0: a0, seed } : null);
      };
      for (const id of R.ids) {
        const g = GT.snaps[id], rows = [];
        for (let i = 0; i < OFF.length; i++) {
          const q = get(id, i); if (!q) continue;
          const a1 = q.r, a0 = q.r0;
          rows.push({ kind: a1.kind, contour: !!a1.contour, kind0: a0 && a0.kind, err: errOf(g, a1), err0: a0 && a0.kind === g.kind ? errOf(g, a0) : null, ms: a1.ms, sigma: a1.sigma, count: a1.count, quality: a1.quality, grown: a1.grown });
        }
        (R.snaps[px] = R.snaps[px] || {})[id] = { expect: g.kind, rows };
      }
      for (const pr of GT.pairs) {
        const rows = [];
        for (let i = 0; i < OFF.length; i++) {
          const qa = get(pr.a, i), qb = get(pr.b, (i + 3) % OFF.length); if (!qa || !qb) continue;
          const ra = qa.r, rb = qb.r, gp = PS.pairGap(ra, rb), raw = Math.hypot(qb.seed[0] - qa.seed[0], qb.seed[1] - qa.seed[1], qb.seed[2] - qa.seed[2]);
          const eu = Math.hypot(rb.point[0] - ra.point[0], rb.point[1] - ra.point[1], rb.point[2] - ra.point[2]);
          rows.push({ value: gp ? gp.value : eu, how: gp ? gp.kind : 'точки', unc: gp ? gp.uncertainty : null, raw, ka: ra.kind, kb: rb.kind, ca: !!ra.contour, cb: !!rb.contour });
        }
        (R.pairs[px] = R.pairs[px] || {})[pr.name] = { gt: pr.gt, gtC: pr.gtC, rows };
      }
    }
    return R;
  }, { GT, shift, OS, PXS });
  fs.writeFileSync(outFile, JSON.stringify({ loadSec, shift, res }, null, 1));
  // Сводка
  const mm = (x) => (x * 1000).toFixed(2).replace('.', ',');
  console.log('индекс: ' + Math.round(res.indexMs) + ' мс, точек ' + res.n + ', шаг облака ' + mm(res.spacing) + ' мм, разброс кликов ×' + OS);
  for (const px of PXS) {
    console.log('\n=== радиус захвата ' + px + ' px ===');
    for (const id of res.ids) {
      const s = res.snaps[px][id], r = s.rows; if (!r.length) { console.log(id.padEnd(12), 'нет точек'); continue; }
      const good = r.filter((x) => x.kind === s.expect), es = good.map((x) => x.err), max = es.length ? Math.max.apply(null, es) : NaN, mean = es.length ? es.reduce((a, b) => a + b, 0) / es.length : NaN;
      const g0 = r.filter((x) => x.err0 != null), ms = r.reduce((a, x) => a + (x.ms || 0), 0) / r.length;
      console.log(id.padEnd(12), s.expect.padEnd(6), 'тип верный ' + good.length + '/' + r.length + (GT.snaps[id].contour ? ' (контур ' + r.filter((x) => x.contour).length + ')' : '') + ' | ошибка ср ' + mm(mean) + ' макс ' + mm(max) + ' мм | без роста ср ' + (g0.length ? mm(g0.reduce((a, x) => a + x.err0, 0) / g0.length) : '-') + ' | σ ' + mm(r[0].sigma || 0) + ' мм, точек ' + r[0].count + ' | ' + Math.round(ms) + ' мс | другие: ' + r.filter((x) => x.kind !== s.expect).map((x) => x.kind).join(','));
    }
    for (const name of Object.keys(res.pairs[px])) {
      const p = res.pairs[px][name], vs = p.rows; if (!vs.length) { console.log(name.padEnd(22), 'нет данных'); continue; }
      const gtOf = (x) => (p.gtC != null && x.ca && x.cb) ? p.gtC : (p.gtC != null && x.ca !== x.cb ? (p.gt + p.gtC) / 2 : p.gt);
      const e = vs.map((x) => Math.abs(x.value - gtOf(x))), raw = vs.map((x) => Math.abs(x.raw - gtOf(x)));
      console.log(name.padEnd(22), 'эталон ' + p.gt.toFixed(4) + ' м | ошибка ср ' + mm(e.reduce((a, b) => a + b, 0) / e.length) + ' макс ' + mm(Math.max.apply(null, e)) + ' мм | способ ' + Array.from(new Set(vs.map((x) => x.how))).join('/') + ' | «грубо» по кликам ср ' + mm(raw.reduce((a, b) => a + b, 0) / raw.length) + ' мм' + (vs[0].unc != null ? ' | заявленная погрешность ±' + mm(vs[0].unc) + ' мм' : ''));
    }
  }
  console.log('\nошибок консоли:', errs.length); errs.slice(0, 8).forEach((e) => console.log(e));
  await browser.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
