// Проверка точного захвата на РЕАЛЬНОМ облаке против эталона (не часть продукта).
//   LAB_CLOUD  — PLY-файл;  LAB_GT — JSON эталона {snaps:{id:{kind,ideal,gt,n,dir}}, pairs:[{name,a,b,kind,gt}]} в исходных координатах;
//   LAB_OUT    — куда записать результаты (JSON).  Запуск: sh run.sh real-snap.js
// Приложение при загрузке центрирует облако, поэтому сдвиг определяется по первым вершинам файла и точкам во viewer.
const { launch } = require('./lab');
const fs = require('fs');
const SZ = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, float: 4, int32: 4, uint32: 4, float32: 4, double: 8, float64: 8 };
// Габарит облака по файлу (как центрирует приложение): читаем вершины кусками, x/y/z — float32 в начале записи
function plyBbox(file) {
  const fd = fs.openSync(file, 'r'), head = Buffer.alloc(4096); fs.readSync(fd, head, 0, 4096, 0);
  const hs = head.toString('latin1'), he = hs.indexOf('end_header'), off = hs.indexOf('\n', he) + 1;
  let rec = 0, inV = false, ox = -1, nv = 0;
  for (const l of hs.slice(0, off).split(/\r?\n/)) {
    const t = l.trim().split(/\s+/);
    if (t[0] === 'element') { inV = t[1] === 'vertex'; if (inV) nv = +t[2]; } else if (inV && t[0] === 'property') { if (t[2] === 'x') ox = rec; rec += SZ[t[1]] || 4; }
  }
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], CH = 200000, buf = Buffer.alloc(CH * rec);
  for (let i = 0; i < nv; i += CH) {
    const k = Math.min(CH, nv - i); fs.readSync(fd, buf, 0, k * rec, off + i * rec);
    for (let j = 0; j < k; j++) for (let c = 0; c < 3; c++) { const v = buf.readFloatLE(j * rec + ox + 4 * c); if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; }
  }
  fs.closeSync(fd); return { mn, mx, nv };
}
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
  const res = await page.evaluate(({ GT, shift }) => {
    const v = window.__viewer || window.__lxViewer, PS = window.PrecisionSnap;
    v.setMeasure(true); v.setMeasureMode && v.setMeasureMode('distance');
    let t = performance.now(); const idx = v._psIndex(); const indexMs = v._psCache ? v._psCache.ms : performance.now() - t;
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const OFF = [[0, 0, 0], [0.02, 0.02, 0], [-0.02, 0.015, 0.01], [0.01, -0.03, -0.02], [-0.03, -0.01, 0.02], [0.025, 0, -0.025]];
    const near = (c) => { const j = idx.nearest(c[0], c[1], c[2], 0.15); return j < 0 ? null : [idx.pos[j * 3], idx.pos[j * 3 + 1], idx.pos[j * 3 + 2]]; };
    const toO = (p) => [p[0] - shift[0], p[1] - shift[1], p[2] - shift[2]];
    const R = { indexMs, n: idx.n, spacing: idx.spacing, snaps: {}, pairs: [] };
    for (const px of [16, 48]) {
      for (const id of Object.keys(GT.snaps)) {
        const g = GT.snaps[id], rows = [];
        OFF.forEach((o) => {
          const c = [g.ideal[0] + shift[0] + o[0], g.ideal[1] + shift[1] + o[1], g.ideal[2] + shift[2] + o[2]], seed = near(c); if (!seed) return;
          const a0 = v._precisionSnapAt(seed, { grow: false, px }), a1 = v._precisionSnapAt(seed, { grow: true, px });
          if (!a1) return;
          const d = sub(toO(a1.point), g.gt); let e;
          if (g.kind === 'plane') e = Math.abs(dot(d, g.n));
          else if (g.kind === 'edge') { const al = dot(d, g.dir); e = Math.hypot(d[0] - g.dir[0] * al, d[1] - g.dir[1] * al, d[2] - g.dir[2] * al); }
          else e = Math.hypot(d[0], d[1], d[2]);
          const d0 = a0 ? sub(toO(a0.point), g.gt) : null; let e0 = null;
          if (d0) { if (g.kind === 'plane') e0 = Math.abs(dot(d0, g.n)); else if (g.kind === 'edge') { const al = dot(d0, g.dir); e0 = Math.hypot(d0[0] - g.dir[0] * al, d0[1] - g.dir[1] * al, d0[2] - g.dir[2] * al); } else e0 = Math.hypot(d0[0], d0[1], d0[2]); }
          rows.push({ kind: a1.kind, kind0: a0 && a0.kind, err: e, err0: e0, ms: a1.ms, ms0: a0 && a0.ms, sigma: a1.sigma, count: a1.count, rms: a1.rms, quality: a1.quality, grown: a1.grown });
        });
        (R.snaps[px] = R.snaps[px] || {})[id] = { expect: g.kind, rows };
      }
      for (const pr of GT.pairs) {
        const ga = GT.snaps[pr.a], gb = GT.snaps[pr.b], rows = [];
        OFF.forEach((o, i) => {
          const oa = OFF[i], ob = OFF[(i + 3) % OFF.length];
          const ca = [ga.ideal[0] + shift[0] + oa[0], ga.ideal[1] + shift[1] + oa[1], ga.ideal[2] + shift[2] + oa[2]];
          const cb = [gb.ideal[0] + shift[0] + ob[0], gb.ideal[1] + shift[1] + ob[1], gb.ideal[2] + shift[2] + ob[2]];
          const sa = near(ca), sb = near(cb); if (!sa || !sb) return;
          const ra = v._precisionSnapAt(sa, { grow: true, px }), rb = v._precisionSnapAt(sb, { grow: true, px });
          const gp = PS.pairGap(ra, rb), raw = Math.hypot(sb[0] - sa[0], sb[1] - sa[1], sb[2] - sa[2]);
          rows.push({ value: gp ? gp.value : null, kind: gp ? gp.kind : null, unc: gp ? gp.uncertainty : null, raw, ka: ra.kind, kb: rb.kind });
        });
        (R.pairs[px] = R.pairs[px] || {})[pr.name] = { gt: pr.gt, rows };
      }
    }
    return R;
  }, { GT, shift });
  fs.writeFileSync(outFile, JSON.stringify({ loadSec, shift, res }, null, 1));
  // Сводка
  const mm = (x) => (x * 1000).toFixed(2).replace('.', ',');
  console.log('индекс: ' + Math.round(res.indexMs) + ' мс, точек ' + res.n + ', шаг облака ' + mm(res.spacing) + ' мм');
  for (const px of [16, 48]) {
    console.log('\n=== радиус захвата ' + px + ' px ===');
    for (const id of Object.keys(res.snaps[px])) {
      const s = res.snaps[px][id], r = s.rows; if (!r.length) { console.log(id.padEnd(12), 'нет точек'); continue; }
      const ok = r.filter((x) => x.kind === s.expect).length, es = r.map((x) => x.err), max = Math.max.apply(null, es), mean = es.reduce((a, b) => a + b, 0) / es.length;
      const ms = r.map((x) => x.ms).reduce((a, b) => a + b, 0) / r.length;
      console.log(id.padEnd(12), s.expect.padEnd(6), 'тип верный ' + ok + '/' + r.length, '| ошибка ср ' + mm(mean) + ' макс ' + mm(max) + ' мм | без роста ср ' + mm(r.filter((x) => x.err0 != null).reduce((a, x) => a + x.err0, 0) / Math.max(1, r.filter((x) => x.err0 != null).length)) + ' | σ ' + mm(r[0].sigma || 0) + ' мм, точек ' + r[0].count + ' | ' + Math.round(ms) + ' мс');
    }
    for (const name of Object.keys(res.pairs[px])) {
      const p = res.pairs[px][name], vs = p.rows.filter((x) => x.value != null);
      if (!vs.length) { console.log(name.padEnd(22), 'значение не получено', JSON.stringify(p.rows.map((x) => x.ka + '/' + x.kb))); continue; }
      const e = vs.map((x) => Math.abs(x.value - p.gt)), raw = p.rows.map((x) => Math.abs(x.raw - p.gt));
      console.log(name.padEnd(22), 'эталон ' + p.gt.toFixed(4) + ' м | получено ' + vs.map((x) => x.value.toFixed(4)).join(' ') + ' | ошибка ср ' + mm(e.reduce((a, b) => a + b, 0) / e.length) + ' макс ' + mm(Math.max.apply(null, e)) + ' мм | «грубо» по кликам ср ' + mm(raw.reduce((a, b) => a + b, 0) / raw.length) + ' мм');
    }
  }
  console.log('\nошибок консоли:', errs.length); errs.slice(0, 8).forEach((e) => console.log(e));
  await browser.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
