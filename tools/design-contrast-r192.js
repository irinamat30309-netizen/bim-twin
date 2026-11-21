'use strict';
/* r192: программная проверка контраста пар токенов (WCAG AA: 4.5 текст, 3 UI/large). */
const fs = require('fs');
const path = require('path');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'ui', 'tokens.css'), 'utf8');

function block(sel) {
  const lines = CSS.split('\n'); const idx = lines.findIndex((l) => l.trim().startsWith(sel));
  if (idx < 0) return {}; let body = '';
  for (let i = idx; i < lines.length; i++) { body += lines[i] + '\n'; if (lines[i].includes('}')) break; }
  const out = {};
  for (const x of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[x[1]] = x[2].trim();
  return out;
}
function rgb(v) {
  v = String(v).trim();
  let m = /^#([0-9a-f]{6})$/i.exec(v); if (m) { const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v); if (m) return [+m[1], +m[2], +m[3]];
  throw new Error('cannot parse color ' + v);
}
function lum(c) {
  const f = c.map((x) => { const s = x / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
}
function ratio(a, b) { const A = lum(rgb(a)), B = lum(rgb(b)); return (Math.max(A, B) + 0.05) / (Math.min(A, B) + 0.05); }

const themes = { dark: block(':root,'), light: block('html[data-theme="light"]') };
const pairs = [
  ['txt', 'bg-1'], ['txt', 'bg-2'], ['txt', 'bg-3'],
  ['txt-2', 'bg-1'], ['txt-2', 'bg-2'], ['txt-2', 'bg-3'],
  ['txt-3', 'bg-1'], ['txt-3', 'bg-2'],
  ['on-accent', 'accent'], ['on-accent', 'accent-fill'],
  ['ok', 'bg-1'], ['warn', 'bg-1'], ['err', 'bg-1']
];
const results = [];
let fail = 0;
for (const [name, t] of Object.entries(themes)) {
  for (const [fg, bg] of pairs) {
    const need = (fg === 'on-accent' || fg === 'txt' || fg === 'txt-2' || fg === 'txt-3' || fg === 'ok' || fg === 'warn' || fg === 'err') ? 4.5 : 3;
    if (!t[fg] || !t[bg]) continue;
    const r = ratio(t[fg], t[bg]);
    const ok = r >= need;
    if (!ok) fail++;
    results.push({ theme: name, pair: fg + '/' + bg, ratio: +r.toFixed(2), need, ok });
  }
  const ring = ratio(t['accent'], t['bg-1']);
  const okRing = ring >= 3;
  if (!okRing) fail++;
  results.push({ theme: name, pair: 'accent/bg-1 (focus ring)', ratio: +ring.toFixed(2), need: 3, ok: okRing });
}
for (const r of results) console.log(`${r.theme.padEnd(5)} ${r.pair.padEnd(30)} ${String(r.ratio).padStart(6)}  need ${r.need}  ${r.ok ? 'PASS' : 'FAIL'}`);
console.log(fail ? `CONTRAST FAIL: ${fail}` : 'CONTRAST PASS: all pairs meet AA');
process.exit(fail ? 1 : 0);
