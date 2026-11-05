'use strict';
const log = require('../util/log');

let nextSessionId = 1;

// One WebSocket connection. Packets are JSON envelopes {opCode, data}.
class Session {
  constructor(ws, req, server) {
    this.id = nextSessionId++;
    this.ws = ws;
    this.server = server;
    this.remote = (req && (req.headers['x-forwarded-for'] || req.socket.remoteAddress)) || '?';
    this.connectedAt = Date.now();
    this.lastSeenAt = Date.now();
    this.lastHeartbeatAt = 0;
    this.negotiated = false;
    this.account = null;      // account record after LOGIN
    this.player = null;       // runtime Player after entering the world
    this.moveServerSeq = 0;   // per-connection contiguous movement stream
    this.closed = false;
    this.rate = { windowStart: Date.now(), count: 0 };
  }

  send(opCode, data) {
    if (this.closed || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify({ opCode, data }));
      return true;
    } catch (e) {
      log.warn('send failed', this.id, e.message);
      return false;
    }
  }

  // Simple flood guard: more than 400 packets/second drops the connection.
  allowPacket() {
    const now = Date.now();
    if (now - this.rate.windowStart > 1000) { this.rate.windowStart = now; this.rate.count = 0; }
    this.rate.count += 1;
    return this.rate.count <= 400;
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    try { this.ws.close(code, reason); } catch (e) { /* ignore */ }
  }
}

module.exports = { Session };
