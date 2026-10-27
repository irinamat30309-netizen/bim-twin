// Стенд интерфейса (не часть продукта): Playwright + Chromium, заглушка bimAPI (stub.js), сервер server.js.
// Переменные окружения: PLAYWRIGHT_MODULE (путь к модулю playwright), CHROMIUM_PATH (исполняемый файл), SHOTS (папка снимков), LAB_URL.
const fs = require('fs'), path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const makeStub = require('./stub');
const SHOTS = process.env.SHOTS || path.join(__dirname, 'shots');
const CLOUD = process.env.LAB_CLOUD || path.join(__dirname, 'room.ply');
fs.mkdirSync(SHOTS, { recursive: true });
exports.SHOTS = SHOTS;
exports.launch = async function launch({ w = 1440, h = 900, scale = 1, theme = 'dark', wait = 3000, url = process.env.LAB_URL || 'http://127.0.0.1:8123/renderer/index.html?fromStart=1', init = '' } = {}) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  });
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERR ' + String(e.stack || e.message).split('\n').slice(0, 3).join(' | ').replace(/http:\/\/127\.0\.0\.1:8123\/renderer\//g, '').slice(0, 320)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 240)); });
  page.on('requestfailed', (r) => errs.push('REQFAIL ' + r.url().slice(-80)));
  page.on('response', (r) => { if (r.status() >= 400) errs.push('HTTP' + r.status() + ' ' + r.url().slice(-90)); });
  await page.addInitScript(makeStub());
  await page.addInitScript("try{localStorage.setItem('bim.onboarded','1');}catch(e){}" + init);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(wait);
  if (theme === 'light') { await page.evaluate(() => window.__bimSetTheme && window.__bimSetTheme('light')); await page.waitForTimeout(500); }
  return { browser, page, errs };
};
exports.shot = (page, name, opts) => page.screenshot({ path: path.join(SHOTS, name + '.png'), ...(opts || {}) });
exports.openCloud = async (page) => { await page.setInputFiles('#modelInput', CLOUD); await page.waitForTimeout(3500); };

/* Автопроверка вёрстки текущего экрана: иконки-заглушки, обрезанный текст, выход за окно, наложение плавающих блоков, кнопки без имени. */
exports.audit = (page) => page.evaluate(() => {
  const out = [];
  const vis = (e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.01; };
  // Видимая часть блока: обрезаем по предкам со скрытым/прокручиваемым переполнением (иначе длинный список «перекрывает» HUD, хотя визуально он обрезан)
  const visRect = (e) => {
    const r = e.getBoundingClientRect(); let l = r.left, t = r.top, rt = r.right, b = r.bottom;
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p); if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const q = p.getBoundingClientRect();
      if (cs.overflowX !== 'visible') { l = Math.max(l, q.left); rt = Math.min(rt, q.right); }
      if (cs.overflowY !== 'visible') { t = Math.max(t, q.top); b = Math.min(b, q.bottom); }
    }
    return { left: l, top: t, right: rt, bottom: b };
  };
  const nm = (e) => (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '') || e.tagName.toLowerCase();
  document.querySelectorAll('svg[data-icon-missing]').forEach((s) => out.push('MISSING-ICON ' + s.getAttribute('data-icon-missing') + ' in ' + nm(s.parentElement)));
  document.querySelectorAll('body *').forEach((e) => {
    if (!vis(e)) return;
    const cs = getComputedStyle(e);
    if (cs.textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 1 && !e.closest('[data-tip],[title]')) out.push('CLIPPED-TEXT ' + nm(e) + ' "' + e.textContent.trim().slice(0, 36) + '"');
  });
  // Содержимое, которое не помещается в контейнер с overflow:hidden (например, кнопка «закрыть» за краем панели)
  document.querySelectorAll('.fpanel,.hud,.stage-side,.lx-pop,.modal-card,.lx-win,.lx-toast').forEach((c) => {
    if (!vis(c)) return; const cr = c.getBoundingClientRect(); const cs = getComputedStyle(c);
    const clip = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
    c.querySelectorAll('button,input,select,textarea,[role="button"],a[href]').forEach((b) => {
      if (!vis(b)) return; const r = b.getBoundingClientRect();
      for (let p = b.parentElement; p && p !== c; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return; }
      const own = cr;
      if ((clip || c.classList.contains('fpanel') || c.classList.contains('hud')) && (r.right > own.right + 1 || r.left < own.left - 1)) out.push('CLIPPED-CONTROL ' + nm(b) + ' в ' + nm(c) + ' [' + Math.round(r.left) + '…' + Math.round(r.right) + ' из ' + Math.round(own.left) + '…' + Math.round(own.right) + ']');
    });
  });
  // Содержимое боковых колонок не должно выходить за их край (рамка поля, обрезанная краем колонки, — типичный «кривой» дефект)
  document.querySelectorAll('.sidebar,.inspector').forEach((c) => {
    if (!vis(c)) return; const cr = c.getBoundingClientRect();
    c.querySelectorAll('*').forEach((e) => {
      if (!vis(e)) return; const r = e.getBoundingClientRect(); if (r.width < 1) return;
      for (let p = e.parentElement; p && p !== c; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' && p.scrollWidth > p.clientWidth + 1) return; }
      if (r.right > cr.right + 1 || r.left < cr.left - 1) out.push('SIDE-OVERFLOW ' + nm(e) + ' в ' + nm(c) + ' [' + Math.round(r.left) + '…' + Math.round(r.right) + ' из ' + Math.round(cr.left) + '…' + Math.round(cr.right) + ']');
    });
  });
  document.querySelectorAll('.fpanel,.hud,.hud-readout,.lx-pop,.modal-card,.lx-win,.lx-tip').forEach((e) => {
    if (!vis(e)) return; const r = visRect(e);
    if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) out.push('OFFSCREEN ' + nm(e) + ' [' + [r.left, r.top, r.right, r.bottom].map(Math.round) + ']');
  });
  const fl = [...document.querySelectorAll('.fpanel,.hud,.hud-readout,.nav-rail,.viewcube,.ttitle,.elbar,.lx-toast')].filter(vis);
  for (let i = 0; i < fl.length; i++) for (let j = i + 1; j < fl.length; j++) {
    const a = fl[i], b = fl[j]; if (a.contains(b) || b.contains(a)) continue;
    const p = visRect(a), q = visRect(b);
    const w = Math.min(p.right, q.right) - Math.max(p.left, q.left), h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
    if (w > 2 && h > 2) out.push('OVERLAP ' + nm(a) + ' × ' + nm(b) + ' (' + Math.round(w) + '×' + Math.round(h) + ')');
  }
  // Неоформленные системные элементы: у кнопки 2px outset, у поля inset — значит, стиль дизайн-системы не применился
  document.querySelectorAll('button, input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="color"]), select, textarea').forEach((b) => {
    if (!vis(b)) return; const st = getComputedStyle(b).borderTopStyle;
    if (st === 'outset' || st === 'inset' || st === 'groove' || st === 'ridge') out.push('DEFAULT-STYLE ' + nm(b) + ' "' + (b.textContent || b.value || b.getAttribute('aria-label') || '').trim().slice(0, 24) + '"');
  });
  document.querySelectorAll('button, [role="button"]').forEach((b) => {
    if (!vis(b)) return;
    const t = (b.getAttribute('aria-label') || b.textContent || b.getAttribute('data-tip') || b.getAttribute('title') || '').trim();
    if (!t) out.push('NO-NAME ' + nm(b));
  });
  // WCAG 2.2 (2.5.8, «размер цели»): цель указателя не меньше 24×24 px, иначе круг 24 px вокруг неё не должен задевать соседние цели
  const tg = [...document.querySelectorAll('button, [role="button"], [role="tab"], [role="menuitem"], a[href], select, summary, input:not([type="hidden"]):not([type="file"])')].filter((e) => !(e instanceof SVGElement) && vis(e) && !e.disabled);   // SVG-узлы — это ручки 3D-гизмо, а не элементы интерфейса
  const rc = tg.map((e) => e.getBoundingClientRect());
  const layer = (x) => x.closest('.lx-pop,.lx-win,.modal-card,.lx-toast,.lx-palette,.lx-progress-card') || document.body;
  tg.forEach((e, i) => {
    const r = rc[i]; if (r.width >= 24 && r.height >= 24) return;
    if (e.matches('input[type="checkbox"],input[type="radio"],input[type="range"]') && e.closest('label')) return;   // целью служит вся подпись
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    const top = document.elementFromPoint(cx, cy); if (!top || !(e.contains(top) || top.contains(e))) return;   // закрыто меню/окном — не цель
    for (let j = 0; j < tg.length; j++) {
      if (j === i || tg[j].contains(e) || e.contains(tg[j])) continue;
      if (layer(tg[j]) !== layer(e)) continue;   // меню, окно и тост лежат поверх страницы — это другой слой
      const o = rc[j], dx = Math.max(o.left - cx, 0, cx - o.right), dy = Math.max(o.top - cy, 0, cy - o.bottom);
      if (dx * dx + dy * dy < 144) { out.push('SMALL-TARGET ' + nm(e) + ' ' + Math.round(r.width) + '×' + Math.round(r.height) + ' рядом с ' + nm(tg[j])); return; }
    }
  });
  // Страница не должна ни прокручиваться, ни иметь запас для прокрутки (иначе фокус/scrollIntoView сдвигают весь интерфейс вбок)
  const se = document.scrollingElement || document.documentElement;
  if (se.scrollLeft > 0 || se.scrollTop > 0) out.push('PAGE-SCROLLED x=' + se.scrollLeft + ' y=' + se.scrollTop);
  if (se.scrollWidth > innerWidth + 1 || se.scrollHeight > innerHeight + 1) out.push('PAGE-OVERFLOW ' + se.scrollWidth + '×' + se.scrollHeight);
  return [...new Set(out)];
});
