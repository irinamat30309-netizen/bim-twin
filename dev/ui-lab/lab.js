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
