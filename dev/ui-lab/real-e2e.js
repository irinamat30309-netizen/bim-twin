// Сквозной тест на РЕАЛЬНОМ облаке (не часть продукта): настоящие движения и клики мыши по холсту, подсказка захвата,
// результат в панели измерения, сверка со «своим размером». Эталон — из real-snap.js (LAB_GT).
//   LAB_CLOUD  — PLY;  LAB_GT — gt-targets.json;  LAB_OUT — JSON результатов;  LAB_PAIRS — пары через запятую;  LAB_TRIALS — повторов на пару (по умолчанию 3).
//   Запуск: sh run.sh real-e2e.js
const { launch, shot } = require('./lab');
const { plyBbox } = require('./ply-bbox');
const fs = require('fs');

const PAIRS = (process.env.LAB_PAIRS || 'door2_width_edges,door2_width_planes,door2_height,door1_width_edges,door1_width_planes,partition_thickness,room_height,wallR_opening_width').split(',');
const TRIALS = +(process.env.LAB_TRIALS || 3);
const OFFS = [[0, 0], [5, -4], [-6, 5], [3, 6], [-4, -5]];   // промах курсора, px (человек целится с точностью в несколько пикселей)
const SHOT_PAIRS = new Set((process.env.LAB_SHOTS || 'door2_width_edges,door2_width_planes,wallR_opening_width,room_height').split(','));
const mm = (x) => (x * 1000).toFixed(2).replace('.', ',');

(async () => {
  const cloud = process.env.LAB_CLOUD, GT = JSON.parse(fs.readFileSync(process.env.LAB_GT, 'utf8'));
  const outFile = process.env.LAB_OUT || '/tmp/real-e2e-results.json';
  const t0 = Date.now();
  const { browser, page, errs } = await launch({ w: 1440, h: 900, theme: 'dark', wait: 2500 });
  page.setDefaultTimeout(300000);
  await page.setInputFiles('#modelInput', cloud);
  let info = null;
  for (let i = 0; i < 150; i++) {
    await page.waitForTimeout(2000);
    info = await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; const b = v && v.base && v.base[0]; return b && b.pos ? { n: b.pos.length / 3 } : null; });
    if (info && info.n > 1000) break;
  }
  const loadSec = Math.round((Date.now() - t0) / 1000);
  console.log('загрузка', loadSec, 'с; точек в просмотре', info.n);
  await page.waitForTimeout(3000);
  const bb = plyBbox(cloud), shift = [0, 1, 2].map((k) => -(bb.mn[k] + bb.mx[k]) / 2);

  // Включаем измерение так же, как человек: кнопка «Измерения» → «Расстояние»; привязка должна быть включена сама
  const st0 = await page.evaluate(() => {
    const v = window.__viewer || window.__lxViewer;
    document.getElementById('btnMeasure').click();
    const b = document.querySelector('[data-mm="distance"]'); if (b) b.click();
    return { measuring: !!v.measuring, snap: !!v.measureSnap, mode: v.measureMode };
  });
  console.log('режим измерения:', JSON.stringify(st0));
  await page.waitForTimeout(800);

  // Помощники в странице: подбор точки обзора без перекрытий и перевод точки мира в пиксели
  await page.evaluate(() => {
    const v = window.__viewer || window.__lxViewer, idx = v._psIndex();
    const blocked = (A, B, gap) => {
      const L = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]), n = Math.max(6, Math.ceil(L / 0.05));
      for (let i = 1; i < n; i++) { const t = i / n; if (t * L > L - gap) break; if (idx.nearest(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t, 0.03) >= 0) return true; }
      return false;
    };
    window.__e2e = {
      pose(P, want) {
        const n = want.n, vert = n && Math.abs(n[1]) > 0.7, nh = n && Math.hypot(n[0], n[2]) > 0.7 ? [n[0], n[2]] : null;
        const pitches = vert ? (n[1] > 0 ? [0.85, 0.6] : [-0.75, -0.5]) : [0.12, 0.3], dists = want.dists || [1.8, 1.3, 0.9];
        for (const pitch of pitches) for (const dist of dists) {
          const vis = [], cp = Math.cos(pitch), sp = Math.sin(pitch);
          for (let k = 0; k < 24; k++) {
            const yaw = k * Math.PI / 12, eye = [P[0] + dist * cp * Math.sin(yaw), P[1] + dist * sp, P[2] + dist * cp * Math.cos(yaw)];
            vis.push(idx.nearest(eye[0], eye[1], eye[2], 0.12) < 0 && !blocked(eye, P, 0.12));
          }
          if (!vis.some(Boolean)) continue;
          let yawK = -1;
          if (nh) { let bestC = -1; for (let k = 0; k < 24; k++) if (vis[k]) { const yaw = k * Math.PI / 12, c = Math.abs(nh[0] * Math.sin(yaw) + nh[1] * Math.cos(yaw)) / Math.hypot(nh[0], nh[1]); if (c > bestC) { bestC = c; yawK = k; } } }
          else if (vis.every(Boolean)) yawK = 1;
          else { let best = null; for (let k = 0; k < 24; k++) if (vis[k] && !vis[(k + 23) % 24]) { let len = 0; while (vis[(k + len) % 24] && len < 24) len++; if (!best || len > best.len) best = { start: k, len }; } yawK = Math.round(best.start + (best.len - 1) / 2) % 24; }
          return { yaw: yawK * Math.PI / 12, pitch, dist };
        }
        return null;
      },
      setPose(P, p) { v.target = P.slice(); v.dist = p.dist; v.yaw = p.yaw; v.pitch = p.pitch; v._ortho = false; v._lastVP = null; v.render(); },
      screen(P) { v._lastVP = null; v.render(); return v.worldToScreen(P); }
    };
  });

  const out = { loadSec, shift, pairs: {} };
  const toV = (p) => [p[0] + shift[0], p[1] + shift[1], p[2] + shift[2]];
  for (const name of PAIRS) {
    const pr = GT.pairs.find((p) => p.name === name); if (!pr) { console.log('нет пары', name); continue; }
    const A = GT.snaps[pr.a], B = GT.snaps[pr.b], rows = [];
    const frontal = pr.kind === 'edges';
    for (let t = 0; t < TRIALS; t++) {
      await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; v.setMeasureMode('distance'); });
      const picks = [];
      for (let k = 0; k < 2; k++) {
        const g = k ? B : A, P = toV(g.ideal), o = OFFS[(t + k * 2) % OFFS.length];
        let pose = null;
        if (frontal) { const M = [0, 1, 2].map((c) => (toV(A.ideal)[c] + toV(B.ideal)[c]) / 2), span = Math.hypot(...[0, 1, 2].map((c) => A.ideal[c] - B.ideal[c])); pose = await page.evaluate(({ M, span }) => window.__e2e.pose(M, { n: null, dists: [Math.max(2.4, span * 1.8), Math.max(1.8, span * 1.4)] }), { M, span }); if (pose) pose.center = M; }
        if (!pose) pose = await page.evaluate(({ P, n }) => window.__e2e.pose(P, { n }), { P, n: g.kind === 'edge' ? null : g.n });
        if (!pose) { picks.push({ fail: 'нет точки обзора без перекрытий' }); continue; }
        const scr = await page.evaluate(({ P, pose }) => { window.__e2e.setPose(pose.center || P, pose); return window.__e2e.screen(P); }, { P, pose });
        await page.waitForTimeout(450);
        const x = scr.x + o[0], y = scr.y + o[1];
        const top = await page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? (e.id || e.tagName) : null; }, { x, y });
        await page.mouse.move(x - 7, y - 5); await page.waitForTimeout(120); await page.mouse.move(x, y, { steps: 3 });
        await page.waitForFunction(() => { const v = window.__viewer || window.__lxViewer; return v._hoverSnap && v._hoverSnap.grown; }, null, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(150);
        const tip = await page.evaluate(() => { const e = document.querySelector('.meas-snap-tip'); return e && !e.hidden ? { text: e.innerText.replace(/\s*\n\s*/g, ' | '), cls: e.className } : null; });
        if (t === 0 && SHOT_PAIRS.has(name)) await shot(page, 'e2e-' + name + '-tip' + (k + 1));
        await page.mouse.click(x, y); await page.waitForTimeout(500);
        picks.push({ x: Math.round(x), y: Math.round(y), top, tip, pose: { dist: pose.dist, yaw: +pose.yaw.toFixed(2), pitch: pose.pitch } });
      }
      await page.waitForTimeout(400);
      const res = await page.evaluate(() => {
        const v = window.__viewer || window.__lxViewer, m = v._measResult, ro = document.getElementById('measureReadout');
        return { res: m ? { perp: m.perp, perpKind: m.perpKind, perpSigma: m.perpSigma, sigma: m.sigma, d3: m.d3, along: m.along, snap: m.snap, a: m.a, b: m.b, snaps: (v._measSnaps || []).map((q) => q ? { kind: q.kind, point: q.point, contour: !!q.contour, cored: !!q.cored, weak: !!q.weak, count: q.count, quality: q.quality, sigma: q.sigma, seed: q.seed, sparse: !!q.sparse, snapDist: q.snapDist, radius: q.radius } : null) } : null, readout: ro ? ro.innerText.replace(/\s*\n\s*/g, ' | ') : '' };
      });
      if (t === 0 && SHOT_PAIRS.has(name)) await shot(page, 'e2e-' + name);
      const r = res.res, val = r && r.perp != null ? r.perp : r ? r.d3 : null;
      const both = r && r.snap && r.snap.a && r.snap.b, cA = !!(A.contour), cB = !!(B.contour);
      const gtV = pr.gtC != null && cA && cB ? pr.gtC : pr.gt;
      const pe = [A, B].map((g, k) => {
        const q = r && r.snaps && r.snaps[k]; if (!q || !q.point) return null;
        const d = [0, 1, 2].map((c) => q.point[c] - shift[c] - ((g.contour && g.gtC) ? g.gtC[c] : g.gt[c]));
        const dot = (u, w) => u[0] * w[0] + u[1] * w[1] + u[2] * w[2];
        if (g.kind === 'plane') return Math.abs(dot(d, g.n));
        if (g.kind === 'edge') { const al = dot(d, g.dir); return Math.hypot(d[0] - g.dir[0] * al, d[1] - g.dir[1] * al, d[2] - g.dir[2] * al); }
        return Math.hypot(d[0], d[1], d[2]);
      });
      rows.push({ trial: t, pointErr: pe, snaps: r && r.snaps, value: val, how: r ? (r.perp != null ? r.perpKind : 'точки') : null, sigma: r && r.perp != null ? r.perpSigma : null, ka: both ? r.snap.a.kind : null, kb: both ? r.snap.b.kind : null, err: val != null ? Math.abs(val - gtV) : null, gt: gtV, readout: res.readout, picks });
    }
    out.pairs[name] = { gt: pr.gt, gtC: pr.gtC, rows };
    const es = rows.filter((x) => x.err != null).map((x) => x.err);
    console.log(name.padEnd(22), 'эталон', pr.gt.toFixed(4), 'м | ошибка ср', es.length ? mm(es.reduce((a, b) => a + b, 0) / es.length) : '—', 'макс', es.length ? mm(Math.max(...es)) : '—', 'мм | способ', Array.from(new Set(rows.map((x) => x.how))).join('/'), '| типы', Array.from(new Set(rows.map((x) => x.ka + '+' + x.kb))).join(' '), '| заявл. ±', Array.from(new Set(rows.filter((x) => x.sigma != null).map((x) => mm(x.sigma)))).join(' '), 'мм');
    rows.forEach((x) => console.log('    точки: ошибка каждой привязки', (x.pointErr || []).map((e) => e == null ? '—' : mm(e)).join(' / '), 'мм; типы', (x.snaps || []).map((q) => q ? q.kind + (q.contour ? '*' : '') + (q.cored ? 'c' : '') + (q.weak ? 'w' : '') + (q.sparse ? 's' : '') + ' n=' + q.count + ' ±' + mm(q.sigma || 0) : '—').join(' / ')));
    rows.slice(0, 1).forEach((x) => console.log('    панель:', x.readout.slice(0, 200), '| подсказки:', x.picks.map((p) => p.tip ? p.tip.text : p.fail || '—').join(' // ').slice(0, 260)));
  }

  // Сверка со «своим размером» по реальному измерению: сохраняем последнее измерение двери 2 и сравниваем с 1010 ±10 и с 1010 ±1
  const DEMO = process.env.LAB_DEMO || 'door2_width_planes';
  if (DEMO && out.pairs[DEMO]) {
    const pr = GT.pairs.find((p) => p.name === DEMO), A = GT.snaps[pr.a], B = GT.snaps[pr.b];
    await page.evaluate(() => { const v = window.__viewer || window.__lxViewer; v.setMeasureMode('distance'); });
    for (let k = 0; k < 2; k++) {
      const g = k ? B : A, P = toV(g.ideal);
      const pose = await page.evaluate(({ P, n }) => window.__e2e.pose(P, { n }), { P, n: g.n });
      const scr = await page.evaluate(({ P, pose }) => { window.__e2e.setPose(P, pose); return window.__e2e.screen(P); }, { P, pose });
      await page.waitForTimeout(450); await page.mouse.move(scr.x, scr.y, { steps: 3 });
      await page.waitForFunction(() => { const v = window.__viewer || window.__lxViewer; return v._hoverSnap && v._hoverSnap.grown; }, null, { timeout: 5000 }).catch(() => {});
      await page.mouse.click(scr.x, scr.y); await page.waitForTimeout(500);
    }
    await page.evaluate(() => { const b = document.getElementById('mmSave'); if (b) b.click(); });
    await page.waitForTimeout(800);
    await page.evaluate(() => window.__lxVerify.open({})); await page.waitForTimeout(900);
    const ub = page.locator('.vf-banner .btn.primary'); if (await ub.count()) { await ub.first().click(); await page.waitForTimeout(1500); }
    const nRows = await page.evaluate(() => window.__lxDocCheck.rows().length), idx = nRows - 1;
    await page.evaluate((i) => window.__lxVerify.open({ focus: i }), idx); await page.waitForTimeout(1500);
    const f0 = await page.evaluate((i) => window.__lxDocCheck.fields(i).map((f) => f.key + ':' + f.text), idx);
    console.log('строка', idx, 'поля для сравнения:', JSON.stringify(f0));
    const run = async (val, tol) => {
      await page.selectOption('[data-fk="cmp-' + idx + '-dim"]', 'width');
      await page.fill('[data-fk="cmp-' + idx + '-value"]', val); await page.fill('[data-fk="cmp-' + idx + '-tol"]', tol);
      await page.click('#lxVfCmpGo'); await page.waitForTimeout(1500);
      return (await page.locator('.vf-cmp .vf-own-msg').first().textContent()) || '';
    };
    const m1 = await run('1010', '10'); console.log('сравнение 1010 ±10:', m1);
    const m2 = await run('1010', '1'); console.log('сравнение 1010 ±1:', m2);
    await page.evaluate(() => { const b = document.querySelector('.vf-cmp'); if (b) b.scrollIntoView({ block: 'center' }); }); await page.waitForTimeout(400);
    await shot(page, 'e2e-verify-compare');
    out.demo = { pair: DEMO, fields: f0, cmp10: m1, cmp1: m2 };
  }
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  console.log('\nошибок консоли:', errs.length); errs.slice(0, 8).forEach((e) => console.log(e));
  await browser.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
