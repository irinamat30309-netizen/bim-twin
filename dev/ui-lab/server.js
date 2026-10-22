// Статический сервер стенда интерфейса (не часть продукта): отдаёт корень репозитория на http://127.0.0.1:8123.
const http = require('http'), fs = require('fs'), path = require('path');
const root = process.env.ROOT || path.resolve(__dirname, '..', '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(root, p);
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(process.env.PORT || 8123, '127.0.0.1', () => console.log('ui-lab server up: http://127.0.0.1:' + (process.env.PORT || 8123)));
