// Local-only: forwards to the demo dashboard and injects a brand theme into its HTML.
const http = require('http'), fs = require('fs'), path = require('path');
const UP = 8791, PORT = 8792;
http.createServer((req, res) => {
  if (req.url.startsWith('/__theme.js')) { res.setHeader('content-type', 'text/javascript'); return res.end(fs.readFileSync(path.join(__dirname, 'theme.js'))); }
  const up = http.request({ host: '127.0.0.1', port: UP, path: req.url, method: req.method, headers: { ...req.headers, host: 'localhost:' + UP, 'accept-encoding': 'identity' } }, (r) => {
    const h = { ...r.headers };
    if (h.location) h.location = h.location.replace(':' + UP, ':' + PORT);
    const html = /text\/html/.test(h['content-type'] || '');
    if (!html) { res.writeHead(r.statusCode, h); return r.pipe(res); }
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => b += c); r.on('end', () => {
      b = b.replace('</title>', '</title><script src="/__theme.js"></script>');
      delete h['content-length']; delete h['content-security-policy'];
      res.writeHead(r.statusCode, h); res.end(b);
    });
  });
  up.on('error', (e) => { res.statusCode = 502; res.end(String(e)); });
  req.pipe(up);
}).listen(PORT, () => console.log('proxy on ' + PORT));
