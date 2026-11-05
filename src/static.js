'use strict';
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.wasm': 'application/wasm',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function createStaticHandler(root, fallback = null) {
  const absRoot = path.resolve(root);
  return function serveStatic(req, res) {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (_) { res.writeHead(400); return res.end(); }
    if (pathname === '/') pathname = '/index.html';
    const file = path.resolve(absRoot, '.' + pathname);
    if (!file.startsWith(absRoot + path.sep)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
      let pak = null;
      if (err || !st.isFile()) {
        // Twelfth batch: then site.pak.
        const sp = require('./sitepak').current();
        const rel = pathname.replace(/^\/+/, '');
        if (sp && sp.has(rel)) { pak = sp; st = sp.stat(rel); } else {
          if (fallback && fallback(req, res, pathname)) return;
          res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found');
        }
      }
      const ext = path.extname(file).toLowerCase();
      // Always revalidate: replaced frontend files must show up without the
      // player clearing the browser cache. Unchanged files cost only a 304.
      const etag = '"' + st.size.toString(36) + '-' + Math.floor(st.mtimeMs).toString(36) + '"';
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); return res.end(); }
      const headers = {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
        ETag: etag,
      };
      if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
      res.writeHead(200, headers);
      (pak ? pak.stream(pathname.replace(/^\/+/, '')) : fs.createReadStream(file)).pipe(res);
    });
  };
}

module.exports = { createStaticHandler };
