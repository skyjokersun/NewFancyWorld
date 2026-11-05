'use strict';
// Entry point: HTTP static hosting for the frontend + WebSocket game endpoint.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const config = require('./config');
const log = require('./util/log');
const { createStaticHandler } = require('./static');
const { createVirtualAssets } = require('./virtual-assets');
const { checkSite } = require('./site-check');
const { createAdminHandler } = require('./admin');
const { AdminAuth } = require('./admin-auth');
const { Session } = require('./net/session');
const { GameServer } = require('./game/server');
const { loadFeatures } = require('./features');

function createGame(opts = {}) {
  const game = new GameServer(opts);
  loadFeatures(game);
  return game;
}

function clientLogHandler(req, res) {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size < 64 * 1024) chunks.push(c); });
  req.on('end', () => {
    try {
      fs.mkdirSync(path.dirname(config.clientLogFile), { recursive: true });
      fs.appendFile(config.clientLogFile, new Date().toISOString() + ' ' + Buffer.concat(chunks).toString('utf8').replace(/\n/g, ' ') + '\n', () => {});
    } catch (e) { /* ignore */ }
    res.writeHead(204); res.end();
  });
}

function listen(game, port, { serveStatic = true, serveWs = true } = {}) {
  if (serveStatic) {
    try { if (require('./sitepak').open(config.sitePak)) log.info('frontend pack:', config.sitePak); } catch (e) { log.error('site.pak 打不开：' + e.message); }
    if (config.webRootFound) { log.info('frontend:', config.webRoot); checkSite(config.webRoot, path.join(__dirname, '..', 'data'), log); }
    else {
      log.error('前端目录没找到：在这些位置都没有 index.html：' + config.webRootCandidates.join(' ; '));
      log.error('请把 site.rar 解压到 qiyu-server 旁边的 fe 文件夹（fe 里直接是 index.html、preload、packs），或设置 QIYU_WEB_ROOT 指向解压目录。');
    }
  }
  const statics = createStaticHandler(config.webRoot, serveStatic ? createVirtualAssets(config.webRoot, path.join(__dirname, '..', 'data')) : null);
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/client-log') && req.method === 'POST') return clientLogHandler(req, res);
    if (url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, online: game.playersById.size, sessions: game.sessions.size, scenes: game.scenes.size }));
    }
    if (url.split('?')[0] === '/api/combat-maps') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify({ safeTowns: !!game.config.safeTowns, huntingMaps: [...game.maps.huntingMaps(), 'abattoir_pka'], autoHuntMaps: game.maps.ids().filter((id) => game.isAutoHuntMap(id)) }));
    }
    if (url.split('?')[0] === '/api/extra-items') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      const admin = (game.features.itemAdmin ? game.features.itemAdmin.clientRows() : []).concat(game.features.customSkills ? game.features.customSkills.clientRows() : []);
      const known = new Set(admin.map((t) => t.itemId));
      return res.end(JSON.stringify(require('./game/catalog').extraItems.filter((t) => !known.has(t.itemId)).map((t) => Object.assign({}, t, { source: undefined })).concat(admin)));
    }
    if (url.split('?')[0] === '/api/register-status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      const zones = game.features.world ? game.features.world.zonesView().map((z) => ({ serverId: z.id, label: z.name, open: z.open })) : [];
      return res.end(JSON.stringify({ allowRegister: !!game.config.allowRegister, text: game.registerClosedText(), zones }));
    }
    if (url === '/api/online') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(game.onlineSummary ? game.onlineSummary() : {}));
    }
    if (!serveStatic) { res.writeHead(404); return res.end(); }
    // Thirteenth batch: uploaded monster / profession / projectile art and skill icons.
    if (game.features.uploads && game.features.uploads.serve(req, res, config.webRoot)) return undefined;
    return statics(req, res);
  });
  if (serveWs) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20, perMessageDeflate: false });
    const pinger = setInterval(() => { for (const ws of wss.clients) { try { ws.ping(); } catch (e) { /* closing */ } } }, 10000);
    pinger.unref();
    server.on('close', () => clearInterval(pinger));
    server.on('upgrade', (req, socket, head) => {
      const p = (req.url || '').split('?')[0];
      if (p !== '/ws' && !(p === '/' && !serveStatic)) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const s = new Session(ws, req, game);
        game.attach(s);
        ws.on('message', (data) => game.dispatch(s, data));
        // A browser answers pings by itself even when the game tab is in the background
        // (its own heartbeat timer is slowed down there), so a pong also counts as alive.
        ws.on('pong', () => { s.lastSeenAt = Date.now(); });
        ws.on('close', () => game.detach(s));
        ws.on('error', () => game.detach(s));
      });
    });
  }
  server.listen(port, config.host, () => {
    log.info('listening on', config.host + ':' + port, serveWs ? '(ws)' : '', serveStatic ? '(static)' : '', '补丁号 ' + require('./version').PATCH);
  });
  return server;
}

// The GM page on its own port, behind the password in config.adminPasswordFile.
function listenAdmin(game, port = config.adminPort, auth = new AdminAuth(config.adminPasswordFile, log)) {
  const admin = createAdminHandler(game, auth);
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    // Old /admin links (bookmarks from before V10.2) go to the same place without it.
    if (url === '/admin' || url.startsWith('/admin/') || url.startsWith('/admin?')) {
      res.writeHead(301, { Location: url.slice(6) || '/' }); return res.end();
    }
    if (url === '/' || url.startsWith('/?') || url.startsWith('/api/') || url.startsWith('/admin-v12.js') || url.startsWith('/admin-v15.js') || url.startsWith('/admin-v152.js')) return admin(req, res);
    res.writeHead(302, { Location: '/' }); res.end();
  });
  server.listen(port, config.adminHost, () => {
    log.info('管理后台：http://localhost:' + port + '/ （密码在 ' + auth.file + '）');
  });
  return server;
}

function main() {
  const game = createGame();
  game.start();
  const servers = [listen(game, config.port), listenAdmin(game)];
  if (config.legacyPagePort) servers.push(listen(game, config.legacyPagePort, { serveWs: false }));
  if (config.legacyWsPort) servers.push(listen(game, config.legacyWsPort, { serveStatic: false }));
  // SIGTERM/SIGINT = planned update (clients wait and reconnect); SIGUSR2 = final close.
  const shutdown = (update = true, code = 0, message) => {
    log.info('shutting down', update ? '(update)' : '(closed)');
    try { game.stop({ update, message }); } catch (e) { log.error(e); }
    for (const s of servers) s.close();
    setTimeout(() => process.exit(code), 300);
  };
  // Restart button on the admin page: exit code 75 makes start.bat start it again;
  // Docker (restart: unless-stopped) starts it again by itself.
  game.onRestart = () => shutdown(true, 75, '服务器正在重启，请稍候，完成后将自动重新连接。');
  process.on('SIGINT', () => shutdown(true));
  process.on('SIGTERM', () => shutdown(true));
  process.on('SIGUSR2', () => shutdown(false));
}

if (require.main === module) main();

module.exports = { createGame, listen, listenAdmin };
