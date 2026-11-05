'use strict';
// Minimal protocol client for tests.
const WebSocket = require('ws');
const { OpCodes: OP } = require('../data/opcodes.json');
const NAME = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k]));

class TestClient {
  constructor(url) { this.url = url; this.queue = []; this.waiters = []; this.log = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', () => { this.send(OP.CONNECT, { protocolVersion: 1, codecs: ['json'], features: [] }); res(); });
      this.ws.on('error', rej);
      this.ws.on('message', (m) => {
        const p = JSON.parse(m.toString());
        p.name = NAME[p.opCode];
        this.log.push(p);
        const i = this.waiters.findIndex((w) => w.pred(p));
        if (i >= 0) { const w = this.waiters.splice(i, 1)[0]; clearTimeout(w.t); w.res(p); } else this.queue.push(p);
      });
    });
  }
  send(op, data) { this.ws.send(JSON.stringify({ opCode: op, data })); }
  wait(op, pred = () => true, ms = 4000) {
    const match = (p) => p.opCode === op && pred(p.data);
    const i = this.queue.findIndex(match);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((res, rej) => {
      const w = { pred: match, res, t: setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); rej(new Error('timeout waiting ' + NAME[op])); }, ms) };
      this.waiters.push(w);
    });
  }
  // Resolves with the first packet whose opCode is in ops.
  waitAny(ops, ms = 4000) {
    const set = new Set(ops);
    const i = this.queue.findIndex((p) => set.has(p.opCode));
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((res, rej) => {
      const w = { pred: (p) => set.has(p.opCode), res, t: setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); rej(new Error('timeout waiting ' + ops.map((o) => NAME[o] || o).join('/'))); }, ms) };
      this.waiters.push(w);
    });
  }
  drain() { this.queue = []; }
  close() { this.ws.close(); }
}
module.exports = { TestClient, OP };
