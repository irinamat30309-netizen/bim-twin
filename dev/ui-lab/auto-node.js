// Автозамер (renderer/auto-measure.js) на реальных выделениях — в Node, без браузера и без GPU.
// Выделения выгружает real-sel.js (настоящая рамка на настоящем облаке): LAB_SEL_DIR/<имя>.f32 — Float32 xyz в координатах просмотра.
// Сам скан и эталон в репозиторий не входят; ниже — только числа эталона (расстояния между гранями, измеренные независимо от алгоритма).
//   LAB_SEL_DIR=/путь/sel node dev/ui-lab/auto-node.js [имя1,имя2]      KIND=дверь — подсказка типа (как чип в окне)
const fs = require('fs');
const path = require('path');
const AM = require('../../renderer/auto-measure.js');

const DIR = process.env.LAB_SEL_DIR || '/tmp/sel';
const NAMES = process.argv[2] ? process.argv[2].split(',') : fs.readdirSync(DIR).filter((f) => f.endsWith('.f32')).map((f) => f.replace('.f32', '')).sort();
// Эталон: ширина/высота/глубина проёмов, расстояние между перегородками, высота помещения (метры). Для ширины дверей — два способа (плоскости / рёбра).
const GT = {
  door1: { width: [1.5099, 1.5113], height: [2.2006], depth: [0.2646] },
  door2: { width: [1.0116, 1.0100], height: [2.2080], depth: [0.26] },
  wallR: { width: [1.3042], height: [2.1826] },
  partition: { 'room-width': [6.38] }
};
const KIND = { door: 'дверь', wallR: 'проём', pipes: 'труба', tray: 'лоток', partition: 'стена' };
function gtFor(name) { const k = name.split('-')[0]; return GT[k] || null; }

function line(d) {
  return d.key.padEnd(13) + (d.dimension === 'slope' ? d.value.toFixed(3) + ' %' : d.value.toFixed(4) + ' м').padEnd(12) + ('±' + (d.sigma * (d.dimension === 'slope' ? 1 : 1000)).toFixed(2) + (d.dimension === 'slope' ? ' %' : ' мм')).padEnd(11) + d.level.padEnd(7) + d.method;
}
let worst = 0, covered = 0, compared = 0;
NAMES.forEach((nm) => {
  const f = path.join(DIR, nm + '.f32');
  if (!fs.existsSync(f)) { console.log('==', nm, ': нет файла'); return; }
  const buf = fs.readFileSync(f), pos = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const kind = process.env.KIND != null ? process.env.KIND : (KIND[nm.split('-')[0].replace(/\d+$/, '')] || '');
  const t0 = Date.now(), res = AM.analyze(pos, { kind: kind });
  console.log('==', nm, 'точек', pos.length / 3, 'тип', kind || '—', res.ok ? ('за ' + (Date.now() - t0) + ' мс, плоскостей ' + res.info.planes + ', труб ' + res.info.cylinders + ', дыр ' + res.info.holes) : 'ОШИБКА ' + res.error);
  if (!res.ok) return;
  const gt = gtFor(nm);
  res.objects.slice(0, 6).forEach((ob) => {
    console.log('  #' + ob.id, ob.title, '(ранг ' + ob.rank.toFixed(2) + ')');
    ob.dims.forEach((d) => {
      let cmp = '';
      const g = gt && gt[d.key];
      if (g && d.dimension !== 'slope') {
        const best = g.reduce((a, b) => (Math.abs(b - d.value) < Math.abs(a - d.value) ? b : a));
        const err = d.value - best; compared++; if (Math.abs(err) > worst) worst = Math.abs(err);
        if (Math.abs(err) <= Math.max(2 * d.sigma, 0.003)) covered++;
        cmp = '   эталон ' + best.toFixed(4) + ' → ' + (err >= 0 ? '+' : '') + (err * 1000).toFixed(1) + ' мм';
      }
      console.log('     ' + line(d) + cmp);
    });
  });
});
if (compared) console.log('\nСравнено с эталоном:', compared, '· в пределах max(2σ; 3 мм):', covered, '· наибольшее отклонение:', (worst * 1000).toFixed(1), 'мм');
