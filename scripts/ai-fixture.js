'use strict';
// Ревизия 34: результат «Контроля геометрии» на синтетическом здании (пол, стены, дефекты, проёмы, балки и трубы) — для тестов
// и оценки ИИ-ассистента. Тяжёлые сетки (карты, развёртки) не сохраняются.  node scripts/ai-fixture.js [out.json]
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const G = require(path.join(ROOT, 'test', 'r27-synthetic.helper.js'));
const Seg = require(path.join(ROOT, 'cloud-segments.js'));
const JOB = require(path.join(ROOT, 'cloud-inspect-job.js'));
const MEPS = [
  { type: 'pipe', x0: 0.5, y0: 1.5, x1: 4.0, y1: 1.5, zc: 2.5, d: 0.11 },
  { type: 'pipe', x0: 0.5, y0: 3.0, x1: 4.0, y1: 3.0, zc: 2.45, d: 0.08 }, { type: 'pipe', x0: 0.5, y0: 3.1, x1: 4.0, y1: 3.1, zc: 2.45, d: 0.08 },
  { type: 'pipe', x0: 0.5, y0: 3.2, x1: 4.0, y1: 3.2, zc: 2.45, d: 0.08 },
  { type: 'box', x0: 4.5, y0: 0.2, x1: 4.5, y1: 5.8, w: 0.3, z0: 2.45, z1: 2.8 },
  { type: 'box', x0: 8.0, y0: 0.5, x1: 8.0, y1: 5.5, w: 0.5, z0: 2.3, z1: 2.6 },
  { type: 'box', x0: 6.5, y0: 1.2, x1: 9.5, y1: 1.2, w: 0.3, z0: 2.65, z1: 2.71 },
  { type: 'pipe', x0: 6.5, y0: 4.8, x1: 9.5, y1: 4.8, zc: 2.06, d: 0.1 }
];
function strip(res) {
  const r = JSON.parse(JSON.stringify(res, (k, v) => (k === 'maps' || k === 'grid' || k === 'worst' || k === 'ref' || k === 'heat' || k === 'fill' || k === 'prof' || k === 'cut' || k === 'plan' || k === 'cells' && Array.isArray(v)) ? undefined : (v instanceof Float32Array || v instanceof Float64Array || v instanceof Uint8Array) ? undefined : v));
  return r;
}
function build(out) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bim-ai-fx-'));
  const b = G.building({ step: 0.03, theta: 17, noise: 0.003, mep: MEPS, tilt: [3, 0], bump: { x: 3, y: 4, r: 0.35, h: 0.009 }, wallDip: { x: 0, y: 3, z: 1.4, r: 0.4, depth: 0.009 } });
  const file = path.join(TMP, 'demo.las'); G.writeLas(file, b.pts);
  const desc = Seg.openSegmentSource(file).desc;
  desc.cx = 500000 + b.tx; desc.cy = 4000000 + b.ty; desc.cz = 100;
  const opts = { h0: 1.15, h1: 1.25, maxPoints: 12e6, plan: {}, floor: 0, top: 2.7, mep: true, mepTop: 3.15, clear: 2.1, level: false };
  const r = JOB.run({ desc, opts }, () => {});
  if (!r.ok) throw new Error(r.message || 'inspect failed');
  const res = strip(r);
  Object.assign(res, { fileName: 'demo.las', cls: 'improved', storey: { name: 'Этаж 1', floor: 0, ceiling: 2.8 }, elapsed: 12 });
  fs.writeFileSync(out, JSON.stringify(res));
  fs.rmSync(TMP, { recursive: true, force: true });
  return res;
}
if (require.main === module) {
  const out = process.argv[2] || path.join(ROOT, 'test', 'fixtures', 'assistant-inspection.json');
  const t = Date.now(), res = build(out);
  console.log('saved', out, fs.statSync(out).size, 'bytes,', ((Date.now() - t) / 1000).toFixed(1), 's; walls', res.walls && res.walls.checked, 'bad', res.walls && res.walls.bad, 'mep', res.mep && res.mep.list.length);
}
module.exports = { build };
