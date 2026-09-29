'use strict';
/* Единая система интерфейса (renderer/ui/*): структурные инварианты.
 * Тесты читают исходники как текст и реестр команд как модуль — DOM и браузер не нужны. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const R = path.join(ROOT, 'renderer');
const read = (p) => fs.readFileSync(path.join(R, p), 'utf8');
const HTML = read('index.html');
const CSS_ORDER = ['ui/fonts.css', 'ui/tokens.css', 'ui/base.css', 'ui/components.css', 'ui/shell.css', 'ui/panels.css', 'ui/tools.css', 'ui/viewers.css', 'ui/motion.css'];
const OLD_UI = ['lixel-ui', 'lixel-ribbon', 'lixel-shell', 'lixel-toolbar', 'lixel-tool-dock', 'ui-v1208', 'ui-v1213',
  'lixel-draw.css', 'lixel-workspace.css', 'lixel-cloud-ui.css', 'lixel-polish', 'lixel-menu-unify'];

test('index.html: стили системы подключены по порядку и файлы существуют', () => {
  let last = HTML.indexOf('styles.css');
  assert.ok(last >= 0, 'styles.css (контентные блоки) подключён');
  for (const css of CSS_ORDER) {
    const at = HTML.indexOf('href="' + css + '?v=');
    assert.ok(at > last, css + ' подключён после предыдущего');
    assert.ok(fs.existsSync(path.join(R, css)), css + ' существует');
    last = at;
  }
});

test('index.html: скрипты системы стоят в нужном порядке', () => {
  const at = (s) => { const i = HTML.indexOf('src="' + s); assert.ok(i >= 0, s + ' подключён'); return i; };
  assert.ok(at('icons.js?v=') < at('ui/commands.js?v='), 'иконки раньше реестра команд');
  assert.ok(at('ui/commands.js?v=') < at('ui/kit.js?v='), 'реестр раньше набора компонентов');
  assert.ok(at('ui/kit.js?v=') < at('ui/ribbon.js?v='), 'компоненты раньше ленты');
  assert.ok(at('ui/ribbon.js?v=') < at('app.js?v='), 'лента поднимается до app.js');
  assert.ok(at('app.js?v=') < at('ui/modes.js?v='), 'режимы — после app.js');
  assert.ok(at('ui/modes.js?v=') < at('ui/chrome.js?v='), 'chrome.js (оболочка, палитра, состояния) — последним');
  assert.equal(HTML.lastIndexOf('<script src='), HTML.indexOf('<script src="ui/chrome.js?v='), 'после chrome.js скриптов нет');
});

test('index.html: нет ссылок на удалённые файлы прежнего интерфейса', () => {
  for (const name of OLD_UI) assert.ok(!HTML.includes(name), 'index.html не должен ссылаться на ' + name);
  for (const name of OLD_UI.filter((n) => !n.includes('.css'))) {
    for (const ext of ['.js', '.css']) assert.ok(!fs.existsSync(path.join(R, name + ext)), name + ext + ' удалён');
  }
  for (const f of ['lixel-draw.css', 'lixel-workspace.css', 'lixel-cloud-ui.css', 'lixel-ui-refresh.css']) assert.ok(!fs.existsSync(path.join(R, f)), f + ' удалён');
});

test('index.html: идентификаторы уникальны, разметка без инлайн-стилей и обработчиков', () => {
  const ids = [...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(dup)], [], 'повторяющиеся id: ' + dup.join(', '));
  assert.ok(ids.length > 150, 'разметка не пуста');
  assert.equal((HTML.match(/\sstyle\s*=/g) || []).length, 0, 'inline style= запрещён (всё в ui/*.css)');
  assert.equal((HTML.match(/\son[a-z]+\s*=/gi) || []).length, 0, 'inline-обработчики запрещены');
});

test('index.html: у кнопок и полей есть доступное имя', () => {
  const bad = [];
  for (const m of HTML.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrs = m[1], text = m[2].replace(/<[^>]*>/g, '').trim();
    if (!text && !/aria-label=|title=|aria-labelledby=/.test(attrs)) bad.push(attrs.trim().slice(0, 80));
  }
  assert.deepEqual(bad, [], 'кнопки без имени: ' + bad.join(' | '));
  const inputs = [...HTML.matchAll(/<input\b([^>]*)>/g)].filter((m) => !/type="(hidden|file)"/.test(m[1]) && !/aria-label=|title=|aria-labelledby=|placeholder=/.test(m[1]) && !/\sid="[^"]+"/.test(m[1]));
  assert.equal(inputs.length, 0, 'поля без имени: ' + inputs.map((m) => m[1].slice(0, 60)).join(' | '));
});

test('index.html: CSP запрещает внешние источники и не разрешает inline-скрипты', () => {
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(HTML);
  assert.ok(csp, 'CSP задана');
  assert.match(csp[1], /default-src 'self'/);
  assert.match(csp[1], /script-src 'self' 'unsafe-eval'/);
  assert.doesNotMatch(csp[1], /script-src[^;]*'unsafe-inline'/, 'inline-скрипты запрещены');
  assert.doesNotMatch(csp[1], /https?:\/\/(?!127\.0\.0\.1|localhost)/, 'внешних источников нет');
  assert.match(csp[1], /font-src 'self' data:/, 'шрифт Inter вшит как data:-URI (ui/fonts.css)');
});

test('идентификаторы из кода интерфейса есть в разметке или создаются скриптами', () => {
  const ids = new Set([...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  // Необязательные элементы: код проверяет их наличие (if (el)) или создаёт сам.
  const OPTIONAL = new Set(['edAccum', 'edGrow', 'edGrowVal', 'edSubtract', 'mmListCount', 'vtXgrids', 'lxOrthoBtn', 'lxSnapBtn', 'lxTopBtn',
    'lxAddFloorTree', 'lxObjAxisName', 'lxS2BEditPanel', 'sec_preset_', 'tsSplat']);
  const files = fs.readdirSync(R).filter((f) => f.endsWith('.js') && f !== 'icons.js' && f !== 'startup.js')
    .concat(fs.readdirSync(path.join(R, 'ui')).filter((f) => f.endsWith('.js')).map((f) => 'ui/' + f));
  const pat = /(?:getElementById\(\s*|\$\(\s*|\$id\(\s*)['"]([A-Za-z][\w-]*)['"]|querySelector(?:All)?\(\s*['"]#([A-Za-z][\w-]*)['"]/g;
  const created = new Set();
  const used = new Map();
  for (const f of files) {
    const src = read(f);
    if (src.length > 3e6) continue;
    for (const m of src.matchAll(/\.id\s*=\s*['"]([\w-]+)['"]|\bid=\\?["']([\w-]+)\\?["']|\bid:\s*['"]([\w-]+)['"]|setAttribute\(\s*['"]id['"]\s*,\s*['"]([\w-]+)['"]/g)) created.add(m[1] || m[2] || m[3] || m[4]);
    for (const m of src.matchAll(pat)) { const id = m[1] || m[2]; if (!used.has(id)) used.set(id, f); }
  }
  const missing = [...used].filter(([id]) => !ids.has(id) && !created.has(id) && !OPTIONAL.has(id));
  assert.deepEqual(missing, [], 'в разметке нет элементов: ' + missing.map(([id, f]) => id + ' (' + f + ')').join(', '));
});

test('иконки: набор актуален, все используемые имена есть', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-ui-icons.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  const src = read('icons.js');
  assert.match(src, /data-icon-missing/, 'неизвестная иконка помечается data-icon-missing');
  assert.ok(fs.existsSync(path.join(R, 'ui', 'LICENSE-lucide.txt')), 'лицензия Lucide приложена');
});

test('шрифт: Inter вшит в ui/fonts.css, лицензия приложена', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'build-ui-fonts.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  assert.ok(!fs.existsSync(path.join(R, 'ui', 'fonts')), 'бинарных файлов шрифта в репозитории нет');
  assert.match(read('ui/tokens.css'), /--font:\s*"Inter Variable"/);
});

// ---- Токены и контраст --------------------------------------------------------------------------------
const TOKENS = read('ui/tokens.css');
function vars(marker) {
  const out = {};
  for (const m of TOKENS.matchAll(/(?:^|\n)([^{}/]+)\{([^}]*)\}/g)) {
    if (!m[1].includes(marker)) continue;
    for (const v of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[v[1]] = v[2].trim();
  }
  return out;
}
const rgb = (c) => { let m; if ((m = /^#([0-9a-f]{6})$/i.exec(c))) return [0, 2, 4].map((i) => parseInt(m[1].substr(i, 2), 16)); throw new Error('цвет ' + c); };
const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('токены: у тёмной и светлой темы одинаковый набор переменных', () => {
  const dark = vars('data-theme="dark"'), light = vars('data-theme="light"');
  assert.ok(Object.keys(dark).length >= 40, 'палитра описана');
  assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort());
  assert.match(TOKENS, /\.theme-dark\s*\{/, 'поддерево может принудительно получить тёмную палитру (3D-просмотры)');
  assert.match(read('index.html'), /<html lang="ru" data-theme="dark">/, 'тёмная тема по умолчанию');
});

test('токены: контраст текста не ниже WCAG AA в обеих темах', () => {
  for (const [name, t] of [['тёмная', vars('data-theme="dark"')], ['светлая', vars('data-theme="light"')]]) {
    for (const bg of ['--bg-0', '--bg-1', '--bg-2', '--bg-3']) {
      assert.ok(contrast(t['--txt'], t[bg]) >= 7, `${name}: --txt на ${bg}`);
      assert.ok(contrast(t['--txt-2'], t[bg]) >= 4.5, `${name}: --txt-2 на ${bg}`);
    }
    for (const bg of ['--bg-1', '--bg-2']) {
      assert.ok(contrast(t['--txt-3'], t[bg]) >= 4.5, `${name}: --txt-3 на ${bg}`);
      assert.ok(contrast(t['--accent'], t[bg]) >= 4.5, `${name}: --accent на ${bg}`);
    }
    assert.ok(contrast(t['--on-accent'], t['--accent-fill']) >= 4.5, `${name}: текст на акцентной кнопке`);
    for (const s of ['--ok', '--warn', '--err']) assert.ok(contrast(t[s], t['--bg-1']) >= 4.5, `${name}: ${s} на --bg-1`);
  }
});

test('движение: анимации отключаются при prefers-reduced-motion', () => {
  const motion = read('ui/motion.css');
  assert.match(motion, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(motion, /animation-duration:\s*\.0*1ms\s*!important/);
  assert.match(read('ui/ribbon.js'), /prefers-reduced-motion: reduce/, 'прокрутка ленты тоже уважает настройку');
});

test('интерфейс: в подписях нет эмодзи (значки — только из набора иконок)', () => {
  const PICTO = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B55}\uFE0F]/u;
  const files = ['index.html', 'convert-hub.js', 'lixel-scan2bim-ui.js', 'scan2bim-ai-client.js', 'lixel-object-extract.js', 'lixel-object-inspector.js',
    'meshviewer.js', 'splatviewer.js', 'multicloud.js', 'lcc2-loader.js', 'lixel-scene.js', 'lixel-cloud-ui.js', 'lixel-workspace.js', 'lixel-draw.js',
    'lixel-draw-ext.js', 'lixel-tools-ext.js', 'lixel-sprints-ext.js', 'lixel-smart-save.js']
    .concat(fs.readdirSync(path.join(R, 'ui')).filter((f) => f.endsWith('.js') || f.endsWith('.css')).map((f) => 'ui/' + f));
  const found = [];
  for (const f of files) { const m = PICTO.exec(read(f)); if (m) found.push(f + ': ' + m[0]); }
  assert.deepEqual(found, []);
});

test('пакет: ui/* входит в сборку и проверку синтаксиса', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('renderer/**'), 'renderer/** (включая ui/) упаковывается');
  assert.ok(pkg.build.files.includes('tools/**'));
  const syntax = fs.readFileSync(path.join(ROOT, 'scripts', 'check-syntax.mjs'), 'utf8');
  assert.doesNotMatch(syntax, /'(ui|renderer)'/, 'check-syntax.mjs обходит renderer/ui/ (не исключён)');
});
