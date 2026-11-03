// Оценка удаления людей на синтетической уличной сцене (не часть продукта): сколько точек людей удалено и сколько полезных точек задето.
//   ANG=0.2 node people-eval.js
const CC = require('../../renderer/cloud-clean.js'), { generate, toViewer } = require('./mkoutdoor.js');
const S = generate({ ang: +(process.env.ANG || 0.2), seed: +(process.env.SEED || 11) }), pos = toViewer(S.pos), n = pos.length / 3;
const tot = [0, 0, 0]; for (let i = 0; i < n; i++) tot[S.lab[i]]++;
console.log('точек', n, '| сцена', tot[0], '| шум', tot[1], '| люди', tot[2], '| людей в сцене', S.people.length);
const levels = (process.env.LEVELS || 'strict,normal,loose').split(',');
for (const level of levels) {
  const t = Date.now(), r = CC.people(pos, n, { level, sitting: !!process.env.SIT }), ms = Date.now() - t;
  const c = [0, 0, 0]; for (const i of r.remove) c[S.lab[i]]++;
  // по каждому человеку: сколько его точек удалено (точки людей — метка 2, привязка к человеку по ближайшему центру XY)
  const per = S.people.map(() => ({ tot: 0, got: 0 })), gone = new Uint8Array(n); for (const i of r.remove) gone[i] = 1;
  for (let i = 0; i < n; i++) if (S.lab[i] === 2) {
    let bj = 0, bd = 1e9; S.people.forEach((p, j) => { const d = Math.hypot(S.pos[i * 3] - p.x, S.pos[i * 3 + 1] - p.y); if (d < bd) { bd = d; bj = j; } });
    per[bj].tot++; if (gone[i]) per[bj].got++;
  }
  console.log(level.padEnd(7), ms + ' мс', '| найдено объектов', r.found.length, '| точек людей удалено', c[2], 'из', tot[2], '(' + (100 * c[2] / tot[2]).toFixed(1) + ' %)', '| сцены задето', c[0], '(' + (100 * c[0] / tot[0]).toFixed(4) + ' %)', '| шума', c[1], '|', JSON.stringify(r.stats.rejected), 'кандидатов', r.stats.candidates);
  console.log('   по людям:', per.map((p, j) => (S.people[j].walk ? 'ш' : '') + (p.tot ? Math.round(100 * p.got / p.tot) + '%/' + p.tot : '—')).join(' '));
  if (process.env.V) console.log('   найдено:', r.found.map((f) => `(${f.cx.toFixed(1)},${(-f.cz).toFixed(1)} h${f.h.toFixed(2)} w${f.w.toFixed(2)} n${f.points})`).join(' '));
}
console.log('люди (x,y):', S.people.map((p) => `(${p.x},${p.y})`).join(' '));
