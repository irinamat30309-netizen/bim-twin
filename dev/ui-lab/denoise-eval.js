// Оценка подавления шума на синтетической уличной сцене (не часть продукта): сколько настоящего шума удалено и сколько полезных точек потеряно.
//   ANG=0.15 node denoise-eval.js
const CP = require('../../renderer/cloud-process.js'), CC = require('../../renderer/cloud-clean.js'), { generate, toViewer } = require('./mkoutdoor.js');
const S = generate({ ang: +(process.env.ANG || 0.15), seed: +(process.env.SEED || 7) }), pos = toViewer(S.pos), n = pos.length / 3;
const tot = [0, 0, 0]; for (let i = 0; i < n; i++) tot[S.lab[i]]++;
console.log('точек', n, '| сцена', tot[0], '| шум', tot[1], '| люди', tot[2]);
function report(name, ms, removedIdx) {
  const r = [0, 0, 0]; for (const i of removedIdx) r[S.lab[i]]++;
  console.log(name.padEnd(40), String(ms).padStart(6) + ' мс', '| шума удалено', (100 * r[1] / tot[1]).toFixed(1).padStart(5) + ' %', '| полезных потеряно', r[0], '(' + (100 * r[0] / tot[0]).toFixed(3) + ' %)', '| людей', r[2], '| всего удалено', removedIdx.length);
}
const est = CP.estimate(pos, n), d = CP.defaults(est);
{ const t = Date.now(), res = CP.denoise(pos, n, { radius: d.denoiseRadius, neighbors: d.denoiseNeighbors }); const keep = new Uint8Array(n); for (const i of res.keep) keep[i] = 1; const rm = []; for (let i = 0; i < n; i++) if (!keep[i]) rm.push(i); report('прежний (R=' + d.denoiseRadius + ' м, K=' + d.denoiseNeighbors + ')', Date.now() - t, rm); }
{ const t = Date.now(), res = CP.denoise(pos, n, { radius: 0.3, neighbors: 10 }); const keep = new Uint8Array(n); for (const i of res.keep) keep[i] = 1; const rm = []; for (let i = 0; i < n; i++) if (!keep[i]) rm.push(i); report('прежний (R=0,3 м, K=10)', Date.now() - t, rm); }
for (const level of ['soft', 'medium', 'strong']) { const t = Date.now(), res = CC.denoise(pos, n, { level }); report('умный: ' + level, Date.now() - t, res.remove); if (process.env.V) console.log('   ', JSON.stringify(res.stats)); }
