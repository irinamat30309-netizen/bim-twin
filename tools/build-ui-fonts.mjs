#!/usr/bin/env node
/* BIM Twin — сборка renderer/ui/fonts.css: шрифт Inter (variable, latin + cyrillic) как data: URI.
 *
 * Зачем: в репозитории нет бинарных файлов шрифтов — вся типографика лежит в одном текстовом CSS,
 * который одинаково собирается в ASAR, открывается по file:// и не требует отдельных запросов.
 * CSP приложения это разрешает (font-src 'self' data:).
 *
 *   node tools/build-ui-fonts.mjs --src <папка>   — собрать (в папке: inter-latin-wght-normal.woff2, inter-cyrillic-wght-normal.woff2;
 *                                                    их даёт npm-пакет @fontsource-variable/inter, каталог files/)
 *   node tools/build-ui-fonts.mjs --check         — проверить готовый renderer/ui/fonts.css
 * Лицензия шрифта (SIL OFL 1.1): renderer/ui/LICENSE-inter-OFL.txt
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'renderer', 'ui', 'fonts.css');
const FACES = [
  { file: 'inter-cyrillic-wght-normal.woff2', range: 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116' },
  { file: 'inter-latin-wght-normal.woff2', range: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD' }
];
const HEAD = '/* Inter Variable (SIL OFL 1.1, см. LICENSE-inter-OFL.txt): подмножества cyrillic и latin, вшиты как data: URI.\n * Файл создаёт tools/build-ui-fonts.mjs — вручную не править. */\n';

function build(srcDir) {
  let css = HEAD;
  for (const f of FACES) {
    const buf = fs.readFileSync(path.join(srcDir, f.file));
    if (buf.slice(0, 4).toString('latin1') !== 'wOF2') throw new Error(f.file + ': это не woff2');
    css += '@font-face {\n  font-family: "Inter Variable";\n  font-style: normal;\n  font-weight: 100 900;\n  font-display: swap;\n' +
      '  src: url(data:font/woff2;base64,' + buf.toString('base64') + ') format("woff2-variations");\n  unicode-range: ' + f.range + ';\n}\n';
  }
  fs.writeFileSync(OUT, css);
  console.log('fonts.css: ' + css.length + ' байт, начертаний: ' + FACES.length);
}

function check() {
  const problems = [];
  if (!fs.existsSync(OUT)) { console.error('нет renderer/ui/fonts.css'); process.exit(1); }
  const css = fs.readFileSync(OUT, 'utf8');
  const faces = css.match(/@font-face\s*\{[^}]*\}/g) || [];
  if (faces.length !== FACES.length) problems.push('ожидалось начертаний: ' + FACES.length + ', найдено: ' + faces.length);
  faces.forEach((b, i) => {
    const m = /url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/.exec(b);
    if (!m) { problems.push('начертание ' + (i + 1) + ': нет data-URI woff2'); return; }
    if (Buffer.from(m[1], 'base64').slice(0, 4).toString('latin1') !== 'wOF2') problems.push('начертание ' + (i + 1) + ': данные не woff2');
    if (!/unicode-range:/.test(b)) problems.push('начертание ' + (i + 1) + ': нет unicode-range');
  });
  if (!fs.existsSync(path.join(path.dirname(OUT), 'LICENSE-inter-OFL.txt'))) problems.push('нет LICENSE-inter-OFL.txt');
  if (problems.length) { console.error('fonts.css: ошибки\n - ' + problems.join('\n - ')); process.exit(1); }
  console.log('fonts.css OK (' + css.length + ' байт, ' + faces.length + ' начертания)');
}

const args = process.argv.slice(2);
if (args.includes('--check')) check();
else {
  const i = args.indexOf('--src');
  if (i < 0 || !args[i + 1]) { console.error('Использование: node tools/build-ui-fonts.mjs --src <папка с woff2> | --check'); process.exit(2); }
  build(path.resolve(args[i + 1]));
}
