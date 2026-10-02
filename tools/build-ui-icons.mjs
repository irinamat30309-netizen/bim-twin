#!/usr/bin/env node
/* Генератор renderer/icons.js — единый набор линейных иконок интерфейса.
 *
 * Источник: Lucide (ISC, https://lucide.dev). В приложение попадают только те иконки, которые реально
 * используются (сканируются data-ico="…", ico:'…', ICON/ic/icon/hudBtn/miniBtn/mkBtn/setBtn('…') и реестр команд),
 * плюс небольшой список EXTRA. Несколько фирменных иконок (виды куба, дуга, полилиния, горизонтали)
 * нарисованы вручную в той же геометрии 24×24 / stroke 1.75.
 *
 * Использование:
 *   npm i --no-save lucide-static      # один раз, только для регенерации
 *   node tools/build-ui-icons.mjs [--lucide путь/к/lucide-static/icons] [--check]
 * --check ничего не пишет: завершает работу с ошибкой, если icons.js устарел или иконка не найдена.
 *   Без каталога Lucide --check проверяет только, что все используемые имена есть в icons.js (годится для CI).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const CHECK = process.argv.includes('--check');
const LUCIDE = arg('--lucide') || process.env.LUCIDE_DIR || path.join(ROOT, 'node_modules', 'lucide-static', 'icons');
const OUT = path.join(ROOT, 'renderer', 'icons.js');

/* Имена старого набора → Lucide (для вызовов window.ICON('cube') в app.js). */
const ALIASES = {
  cube: 'box', columns: 'columns-2', import: 'download', sliders: 'sliders-horizontal', walk: 'footprints',
  trash: 'trash-2', maximize: 'maximize', 'file-plus': 'file-up', home: 'house', 'layout-dashboard': 'layout-dashboard'
};

/* Нужны интерфейсу, но не всегда встречаются в разметке буквально. */
const EXTRA = [
  'x', 'check', 'plus', 'minus', 'square', 'search', 'chevron-down', 'chevron-up', 'chevron-right', 'chevron-left',
  'chevrons-up-down', 'panel-left', 'panel-right', 'panel-bottom', 'sun', 'moon', 'command', 'terminal', 'info',
  'circle-check', 'triangle-alert', 'circle-x', 'loader-circle', 'ellipsis', 'eye', 'eye-off', 'maximize', 'minimize',
  'zoom-in', 'zoom-out', 'footprints', 'house', 'download', 'file-up', 'file-down', 'file-text', 'external-link',
  'message-circle', 'refresh-cw', 'hard-drive', 'shield-check', 'sliders-horizontal', 'layout-dashboard', 'scissors',
  'user', 'users', 'pencil', 'trash-2', 'settings', 'folder-open', 'folder-plus', 'undo-2', 'redo-2', 'rotate-ccw',
  'clipboard-list', 'sparkles', 'gauge', 'copy', 'list', 'save', 'circle-play', 'orbit', 'box', 'layers', 'crosshair',
  'ruler', 'magnet', 'lasso-select', 'brush-cleaning', 'palette', 'pin', 'pin-off', 'chart-scatter', 'scan-line',
  'wand-sparkles', 'arrow-left', 'arrow-right', 'arrow-up', 'arrow-down', 'keyboard',
  'sliders-vertical', 'columns-2', 'map-pin', 'focus', 'mouse-pointer-2', 'inbox', 'files', 'clipboard-check', 'scan-search', 'external-link', 'wand-sparkles', 'refresh-cw', 'check-check', 'file-down', 'check'
];

/* Ручные иконки: внутренняя разметка svg (24×24, stroke currentColor, round). */
const HULL = 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z';
const EDGES = '<path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>';
const F = (d) => `<path d="${d}" fill="currentColor" fill-opacity=".32" stroke="none"/>`;
const CUSTOM = {
  'view-top': `${F('M12 2.4 20.7 7.2 12 12 3.3 7.2Z')}<path d="${HULL}"/>${EDGES}`,
  'view-front': `${F('M3.3 7.2 12 12v9.6l-8.5-4.9Z')}<path d="${HULL}"/>${EDGES}`,
  'view-side': `${F('M20.7 7.2 12 12v9.6l8.5-4.9Z')}<path d="${HULL}"/>${EDGES}`,
  'view-iso': `${F('M12 2.4 20.7 7.2v9.6L12 21.6l-8.7-4.8V7.2Z')}<path d="${HULL}"/>${EDGES}`,
  arc: '<path d="M4 19a15 15 0 0 1 15-15"/><circle cx="4" cy="19" r="1.6"/><circle cx="19" cy="4" r="1.6"/>',
  polyline: '<path d="m4.5 18 4.5-9.5 6 7 4.5-10.5"/><circle cx="4.5" cy="18" r="1.5"/><circle cx="9" cy="8.5" r="1.5"/><circle cx="15" cy="15.5" r="1.5"/><circle cx="19.5" cy="5" r="1.5"/>',
  diameter: '<circle cx="12" cy="12" r="8.5"/><path d="M6 18 18 6"/><path d="M6 14.5V18h3.5"/><path d="M14.5 6H18v3.5"/>',
  contour: '<path d="M3 20c1-8 5-13 9-13s8 5 9 13"/><path d="M7 20c.7-5 2.6-8 5-8s4.3 3 5 8"/><path d="M3 20h18"/>'
};

function scanNames() {
  const names = new Set(EXTRA);
  const cmds = require(path.join(ROOT, 'renderer', 'ui', 'commands.js'));
  cmds.all().forEach(({ item }) => item.ico && names.add(item.ico));
  cmds.TABS.forEach((t) => t.groups.forEach((g) => (g.items || []).forEach((i) => i.ico && names.add(i.ico))));
  ['building-2', 'file-down'].forEach((n) => names.add(n)); // динамические форматы экспорта
  const files = [];
  const walk = (dir, deep) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (deep && ['ui'].includes(e.name)) walk(p, false); continue; }
      if (/\.(html|js)$/.test(e.name) && e.name !== 'icons.js') files.push(p);
    }
  };
  walk(path.join(ROOT, 'renderer'), true);
  const re = /(?:data-ico=\\?["']|\bico:\s*["']|\b(?:ICON|ic|icon|ico|iconBtn|hudBtn|toolBtn|setBtn|MI|GI)\(\s*["']|\bminiBtn\(\s*["'](?!id["']|data-)|\bminiBtn\(\s*["'](?:id|data-[a-z]+)["']\s*,\s*[^,]+,\s*["']|\bmkBtn\(\s*["'][^"']*["']\s*,\s*["']|\bactBtn\(\s*(?:"[^"]*"|'[^']*')\s*,\s*["']|\bsetBtn\(\s*\w+\s*,\s*["'])([a-z0-9][a-z0-9-]*)["']/g;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (src.length > 3_000_000) continue;
    let m; while ((m = re.exec(src))) names.add(m[1]);
  }
  return [...names].map((n) => ALIASES[n] || n).sort();
}

function lucideInner(name) {
  const file = path.join(LUCIDE, name + '.svg');
  if (!fs.existsSync(file)) return null;
  const svg = fs.readFileSync(file, 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/\s*\n\s*/g, '').trim();
  return inner;
}

const names = scanNames();

/* Режим --check без каталога Lucide (например, в CI): сверяем только, что все используемые имена есть в icons.js. */
if (CHECK && !fs.existsSync(LUCIDE)) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const have = new Set([...cur.matchAll(/^ {4}"([a-z0-9-]+)":/gm)].map((m) => m[1]));
  const lack = names.filter((n) => !have.has(n));
  if (lack.length) {
    console.error('В renderer/icons.js нет иконок: ' + lack.join(', ') + '\nЗапустите: npm i --no-save lucide-static && node tools/build-ui-icons.mjs');
    process.exit(1);
  }
  console.log(`icons.js покрывает все ${names.length} используемых иконок (каталог Lucide не найден — побайтовая сверка пропущена)`);
  process.exit(0);
}
const paths = {}; const missing = [];
for (const n of names) {
  if (CUSTOM[n]) { paths[n] = CUSTOM[n]; continue; }
  const inner = lucideInner(n);
  if (inner == null) missing.push(n); else paths[n] = inner;
}
if (missing.length) {
  console.error('Нет в Lucide: ' + missing.join(', ') + `\n(каталог: ${LUCIDE})`);
  process.exit(1);
}

const body = Object.keys(paths).sort().map((n) => `    ${JSON.stringify(n)}: ${JSON.stringify(paths[n])}`).join(',\n');
const out = `/* GENERATED by tools/build-ui-icons.mjs — не редактируйте вручную.
 * Набор иконок: Lucide (ISC, лицензия — renderer/ui/LICENSE-lucide.txt) + несколько собственных в той же геометрии.
 * API: window.__lxIcons.{svg(name,size,cls), hydrate(root), has(name), names()}; совместимость: window.ICON(name,size). */
(function (root) {
  'use strict';
  var P = {
${body}
  };
  var A = ${JSON.stringify(ALIASES)};
  function resolve(name) { name = A[name] || name; return P[name] ? name : null; }
  function svg(name, size, cls) {
    var n = resolve(name), miss = n ? '' : ' data-icon-missing="' + String(name).replace(/[^a-z0-9-]/gi, '') + '"';
    n = n || 'square';
    return '<svg class="ic' + (cls ? ' ' + cls : '') + '" data-icon="' + n + '"' + miss + ' viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) +
      '" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + P[n] + '</svg>';
  }
  /* Элемент с data-ico: пустой — получает иконку; с подписью («Извлечь объект») — иконка встаёт слева, текст сохраняется. */
  function hydrate(scope) {
    var list = (scope || document).querySelectorAll('[data-ico]');
    for (var i = 0; i < list.length; i++) {
      var el = list[i], name = el.getAttribute('data-ico'), first = el.firstElementChild;
      var lit = !!first && first.nodeName.toLowerCase() === 'svg';
      if (lit && el.getAttribute('data-ico-done') === name) continue;
      var size = el.getAttribute('data-ico-size'), labeled = !!(el.textContent || '').trim();
      if (labeled) el.classList.add('ico-lead'); // подпись есть: иконка фиксированного размера слева, а не на всю ширину
      if (labeled && lit) first.outerHTML = svg(name, size || 16);
      else if (labeled) el.insertAdjacentHTML('afterbegin', svg(name, size || 16));
      else el.innerHTML = svg(name, size || 18);
      el.setAttribute('data-ico-done', name);
    }
  }
  root.__lxIcons = { svg: svg, hydrate: hydrate, has: function (n) { return !!resolve(n); }, names: function () { return Object.keys(P); } };
  root.ICON = function (name, size) { return svg(name, size, ''); };
})(typeof window !== 'undefined' ? window : globalThis);
`;

if (CHECK) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== out) { console.error('renderer/icons.js устарел: запустите node tools/build-ui-icons.mjs'); process.exit(1); }
  console.log(`icons.js актуален (${names.length} иконок)`);
} else {
  fs.writeFileSync(OUT, out);
  console.log(`renderer/icons.js: ${names.length} иконок, ${(out.length / 1024).toFixed(1)} КБ`);
}
