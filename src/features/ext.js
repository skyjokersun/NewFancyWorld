'use strict';
// A small channel for this server's own panels (mount buttons, auto hunt, arena
// targets, the 战神 statue): the client sends EXT_ACTION {kind, ...} and gets
// EXT_STATE {kind, ...} back. Patch 100 is the client side.
const EXT_OP = { ACTION: 7100, STATE: 7110 };

class Ext {
  register(server) {
    this.server = server;
    this.handlers = new Map();
    server.ext = this;
    server.on(EXT_OP.ACTION, server.requirePlayer((p, d) => {
      const fn = this.handlers.get(String(d.kind || ''));
      if (fn) fn(p, d);
    }));
  }

  on(kind, fn) { this.handlers.set(kind, fn); }

  send(p, kind, data) { p.send(EXT_OP.STATE, Object.assign({ kind }, data, { serverSeq: this.server.nextSeq() })); }

  tell(p, text) { p.send(this.server.op.CHAT_MESSAGE, this.server.systemChat(text)); }
}

module.exports = { Ext, EXT_OP };
