// Предпросмотр второй точки «Расстояния» = результат клика (не часть продукта). Повторяет цепочку наведения без мыши:
// привязка без роста → предпросмотр → привязка с ростом → предпросмотр → клик. Метка предпросмотра должна совпасть с числом в окне.
//   LAB_CLOUD=/data/work/audit.ply  sh /data/ui-lab/run.sh measure-preview.js
const { launch, openCloud } = require('./lab');
(async () => {
  const { browser, page, errs } = await launch({ w: 1280, h: 800, theme: 'dark', wait: 2500 });
  page.setDefaultTimeout(600000);
  await openCloud(page); await page.waitForTimeout(2000);
  const rows = await page.evaluate(() => {
    const V = window.__viewer || window.__lxViewer, bo = V.base[0], POS = bo.pos, NP = POS.length / 3, SH = [-77.5, -1.5, -2.5];
    V.target = [2.2 + SH[0], 1.3 + SH[1], 1.2 + SH[2]]; V.dist = 3.6; V.yaw = 0.75; V.pitch = 0.12; V.render();
    const near = (w) => { const t = [w[0] + SH[0], w[1] + SH[1], w[2] + SH[2]]; let b = -1, bd = 1e30; for (let i = 0; i < NP; i++) { const dx = POS[i * 3] - t[0], dy = POS[i * 3 + 1] - t[1], dz = POS[i * 3 + 2] - t[2], d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; b = i; } } return [POS[b * 3], POS[b * 3 + 1], POS[b * 3 + 2]]; };
    const R = 0.11, ph = (x, deg) => [x, 1.6 + R * Math.sin(deg * Math.PI / 180), 1.0 + R * Math.cos(deg * Math.PI / 180)];
    const cases = [
      ['пол → потолок', [2.0, 0, 2.2], [3.4, 2.8, 1.2], 2800],
      ['стена W → стена E', [0, 1.2, 1.5], [6, 1.9, 2.5], 6000],
      ['труба: верх → низ (Ø)', ph(1.6, 90), ph(2.6, -90), 220],
      ['труба: края ±75° (Ø)', ph(1.6, 75), ph(2.9, -75), 220],
      ['пол → низ трубы (⊥)', [3.0, 0, 2.0], ph(2.2, -90), 1490],
      ['низ трубы → пол (⊥)', ph(2.2, -90), [3.0, 0, 2.0], 1490],
      ['стена W → грань колонны', [0, 1.2, 1.5], [4.5, 1.1, 2.8], 4500],
      ['две кромки: пол–стена S → потолок–стена N', [3.0, 0, 0], [3.5, 2.8, 4], Math.hypot(2800, 4000)]
    ];
    const lab = () => (V._measLabels || []).map((l) => l.t).filter((t) => !/до пола|до потолка|^гор |^верт /.test(t));
    const out = [];
    for (const [name, a, b, truth] of cases) {
      V.setMeasure(true); V.setMeasureMode('distance'); V.measureSnap = true; V.smartMeasure = true; V._clearMeasure();
      V._measureClick(near(a));
      const raw = near(b);
      const s1 = V._precisionSnapAt(raw, { grow: false }); V._hoverSnap = s1 && s1.refined ? s1 : null; V._distancePreviewAt(raw, s1 ? s1.point : raw); const pre1 = lab();
      const s2 = V._precisionSnapAt(raw, { grow: true }); V._hoverSnap = s2 && s2.refined ? s2 : null; V._distancePreviewAt(raw, s2 ? s2.point : raw); const pre2 = lab();
      V._measureClick(raw);
      const r = V._measResult, fin = lab(), shown = r ? (r.perp != null ? r.perp : r.d3) * 1000 : NaN;
      out.push({ name, pre1, pre2, fin, shown: +shown.toFixed(1), kind: r && r.perpKind, truth: +truth.toFixed(0), d3: r && +(r.d3 * 1000).toFixed(1) });
    }
    return out;
  });
  const num = (t) => { const m = /([\d.,]+)\s*(мм|см|м)(?![а-я])/.exec(t || ''); if (!m) return NaN; const v = parseFloat(m[1].replace(',', '.')); return m[2] === 'мм' ? v : m[2] === 'см' ? v * 10 : v * 1000; };
  let bad = 0;
  for (const r of rows) {
    const p2 = r.pre2[0], d = num(p2) - r.shown, ok = Math.abs(d) < 1.5 && Math.abs(r.shown - r.truth) < 6;
    if (!ok) bad++;
    console.log(ok ? 'OK ' : 'ПЛОХО', r.name.padEnd(44), '| предпросмотр (после роста):', JSON.stringify(p2), '| без роста:', JSON.stringify(r.pre1[0]), '| после клика:', JSON.stringify(r.fin[0]), '| окно:', r.shown, r.kind || 'd3', '| эталон', r.truth, '| Δ предпросмотр−окно', isNaN(d) ? 'н/д' : d.toFixed(1), 'мм');
  }
  console.log('сценариев', rows.length, 'с отклонениями', bad, '| ошибки консоли:', errs.length, errs.slice(0, 3).join(' || '));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
