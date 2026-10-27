// Эталон пары В МЕСТАХ ЩЕЛЧКОВ (не часть продукта; данные скана в репозиторий не входят).
// Стены, откосы и перекрытия не идеальны: у откоса двери 2 наклон потолка 2,5°, то есть 4 мм на каждые 10 см вдоль него. Поэтому
// «ошибка против эталона в идеальной точке» смешивает ошибку захвата и то, что человек кликнул в другом месте. Здесь эталонные
// плоскости/линии берутся те же, но расстояние считается между щелчками так же, как это делает PrecisionSnap.pairGap:
// точки привязок проецируются на эталонные плоскости (или линии), дальше — по нормали (или по перпендикуляру к рёбрам).
//   node gt-eval.js results.json gt-targets.json   — таблица по сохранённому результату real-e2e.js
'use strict';
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function ref(g) { return g.contour && g.gtC ? { p: g.gtC, dir: g.dirC || g.dir, n: g.n } : { p: g.gt, dir: g.dir, n: g.n }; }

/* pr — пара из gt-targets.json, A/B — её привязки, qa/qb — точки привязок из просмотра, shift — сдвиг просмотра относительно исходных координат. */
function gtAt(pr, A, B, qa, qb, shift) {
  if (!qa || !qb) return null;
  const a = sub(qa, shift), b = sub(qb, shift), ra = ref(A), rb = ref(B);
  if (pr.kind === 'planes' && ra.n && rb.n) {
    const pa = sub(a, mul(ra.n, dot(ra.n, sub(a, ra.p)))), pb = sub(b, mul(rb.n, dot(rb.n, sub(b, rb.p))));
    const s = dot(ra.n, rb.n) >= 0 ? 1 : -1, nn = unit(add(ra.n, mul(rb.n, s)));
    return Math.abs(dot(nn, sub(pb, pa)));
  }
  if (pr.kind === 'edges' && ra.dir && rb.dir) {
    const la = (q, r) => add(r.p, mul(r.dir, dot(r.dir, sub(q, r.p))));
    const pa = la(a, ra), pb = la(b, rb), s = dot(ra.dir, rb.dir) >= 0 ? 1 : -1, uu = unit(add(ra.dir, mul(rb.dir, s))), dv = sub(pb, pa);
    const al = dot(dv, uu), pe = sub(dv, mul(uu, al));
    return Math.hypot(pe[0], pe[1], pe[2]);
  }
  return null;
}
module.exports = { gtAt };

if (require.main === module) {
  const fs = require('fs'), R = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), GT = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const mm = (x) => x == null ? '—' : (x * 1000).toFixed(2).replace('.', ',');
  console.log('пара'.padEnd(24), 'ошибка к эталону в идеальной точке (ср/макс) | в местах щелчков (ср/макс), мм | заявлено ±, мм');
  for (const name of Object.keys(R.pairs)) {
    const pr = GT.pairs.find((p) => p.name === name), A = GT.snaps[pr.a], B = GT.snaps[pr.b], rows = R.pairs[name].rows;
    const e1 = rows.filter((x) => x.err != null).map((x) => x.err);
    const e2 = rows.map((x) => { const q = x.snaps || []; const v = x.value, g = gtAt(pr, A, B, q[0] && q[0].point, q[1] && q[1].point, R.shift); return v != null && g != null ? Math.abs(v - g) : null; }).filter((x) => x != null);
    const sg = rows.map((x) => x.sigma).filter((x) => x != null);
    const st = (e) => e.length ? mm(e.reduce((s, x) => s + x, 0) / e.length) + ' / ' + mm(Math.max(...e)) : '—';
    console.log(name.padEnd(24), st(e1).padEnd(14), '|', st(e2).padEnd(14), '|', sg.length ? mm(sg.reduce((s, x) => s + x, 0) / sg.length) : '—');
  }
}
