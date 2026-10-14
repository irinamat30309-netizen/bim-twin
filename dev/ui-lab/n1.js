// Смоук: открыть приложение, сделать снимок, вывести ошибки консоли. node n1.js <имя> <ширина> <высота> <dark|light>
const { launch, shot } = require('./lab');
(async () => {
  const [,, name = 'n1', w = '1440', h = '900', theme = 'dark'] = process.argv;
  const { browser, page, errs } = await launch({ w: +w, h: +h, theme });
  await shot(page, name);
  console.log('errors:', errs.length); errs.slice(0, 20).forEach((e) => console.log(e));
  await browser.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
