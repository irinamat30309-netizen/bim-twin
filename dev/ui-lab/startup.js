// Стартовый экран (renderer/startup.html): варианты списка проектов, загрузка, ошибка, настройки, диалог «Новый проект».
// node startup.js <ширина> <высота> <dark|light> [сценарии через запятую]
const { launch, shot, audit } = require('./lab');
const URL = 'http://127.0.0.1:8123/renderer/startup.html';
const MANY = [
  { id: 'p1', name: 'ЖК «Северный», корпус А', address: 'Москва, ул. Ленина, 12', status: 'проект', rooms: 5, active: true },
  { id: 'p2', name: 'Складской комплекс «Восток-3» — очередь 2, секции А–Г (реконструкция)', address: 'Московская область, г. Подольск, промзона «Южные Врата», участок 44/2', status: 'обследование', rooms: 0 },
  { id: 'p3', name: 'БЦ «Мост»', address: '', status: 'проект', rooms: 21 },
  { id: 'p4', name: 'Школа №1', address: 'Казань, ул. Баумана', status: 'проект', rooms: 1 },
  { id: 'p5', name: 'Цех сборки', address: 'Тольятти', status: 'проект', rooms: 2 },
  { id: 'p6', name: 'Паркинг на Набережной', address: 'Сочи', status: 'проект', rooms: 3 }
];
const api = (body) => `window.addEventListener('DOMContentLoaded',()=>{});(function(){const a=window.bimAPI;${body}})();`;
const list = (v) => api(`a.listProjects=()=>new Promise(r=>setTimeout(()=>r(${JSON.stringify(v)}),30));`);
const scenarios = {
  one: { init: '' },
  many: { init: list(MANY), async act(page) { await page.hover('.st-card:nth-child(3)'); await page.waitForTimeout(250); } },
  pick: { init: list(MANY), async act(page) { await page.click('.st-card:nth-child(4)'); await page.waitForTimeout(400); } },
  search: { init: list(MANY), async act(page) { await page.fill('#search', 'моск'); await page.waitForTimeout(300); } },
  nomatch: { init: list(MANY), async act(page) { await page.fill('#search', 'zzz'); await page.waitForTimeout(300); } },
  empty: { init: list([]) },
  error: { init: api(`a.listProjects=()=>Promise.reject(new Error('база данных недоступна'));`) },
  loading: { init: api(`a.listProjects=()=>new Promise(()=>{});`), wait: 500 },
  settings: {
    init: api(`a.getVersion=()=>'1.2.0-rc.3';a.getPaths=()=>({userData:'C:\\\\Users\\\\Ирина\\\\AppData\\\\Roaming\\\\bim-twin',mode:'sqlite'});a.openPath=()=>{};`),
    async act(page) { await page.click('#navSettings'); await page.waitForTimeout(500); }
  },
  newdlg: { init: list(MANY), async act(page) { await page.click('#newProject'); await page.waitForTimeout(400); await page.click('.lx-ask .btn.primary'); await page.waitForTimeout(300); } },
  opening: {
    init: list(MANY) + api(`a.switchProject=()=>new Promise(r=>setTimeout(r,60000));`),
    async act(page) { await page.click('#openProject'); await page.waitForTimeout(400); }
  }
};
(async () => {
  const [,, w = '1440', h = '900', theme = 'dark', only = ''] = process.argv;
  const names = (only ? only.split(',') : Object.keys(scenarios)).filter((n) => scenarios[n]);
  for (const name of names) {
    const sc = scenarios[name];
    const light = theme === 'light' ? "try{localStorage.setItem('bim.start.theme','light');}catch(e){}" : "try{localStorage.setItem('bim.start.theme','dark');}catch(e){}";
    let ctx;
    try {
      ctx = await launch({ w: +w, h: +h, theme: 'dark', url: URL, wait: sc.wait || 900, init: light + (sc.init || '') });
      const { page, errs, browser } = ctx;
      if (sc.act) await sc.act(page);
      await shot(page, `st-${theme}-${w}-${name}`);
      const issues = await audit(page);
      console.log('ok  ', name, issues.length ? '' : '');
      issues.forEach((i) => console.log('     !', i));
      errs.forEach((e) => console.log('     ERR', e));
      await browser.close();
    } catch (e) { console.log('FAIL', name, String(e.message || e).split('\n')[0]); if (ctx && ctx.browser) await ctx.browser.close(); }
  }
  process.exit(0);
})();
