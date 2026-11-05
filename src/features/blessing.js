'use strict';
// 战神的祝福 (ninth batch), given by the 战神 statue in 战斗行会 (job_fight).
// While it is on, exp from monsters the character kills has no level decay and is
// doubled: the level factor is fixed at blessExpFactor (2) instead of
// 1 + (monster level - combat level) x 5%, clamped to 0.2-2.
// It costs blessPointsPerHour (2) service points per hour spent online: the first
// hour is paid when it is switched on, the next one when that hour is used up.
// Offline time does not count. Stopping it at the statue keeps the unused part of
// the paid hour for the next time. When the points run out, the blessing stops.
// Tenth batch: everyone in the scene sees a turning hexagram under a blessed player's
// feet (ext bless_ids, the blessed players of the scene), and the original rising light
// when it is switched on (ext bless_open). Patch 102 draws them.
const HOUR_MS = 3600 * 1000;

class Blessing {
  register(server) {
    this.server = server;
    server.ext.on('zhanshen_query', (p) => this.sendState(p));
    server.ext.on('zhanshen_bless', (p, d) => this.toggle(p, !!d.on));
    server.events.on('playerEntered', (p) => { this.rec(p.ch).lastAt = Date.now(); this.sendState(p); });
    this.lastSweep = 0;
    this.lastIds = 0;
    server.events.on('tick', (now) => {
      if (now - this.lastSweep >= 5000) { this.lastSweep = now; this.sweep(now); }
      if (now - this.lastIds >= 1000) { this.lastIds = now; this.sendIds(); }
    });
  }

  rec(ch) { if (!ch.zhanshenBlessing || typeof ch.zhanshenBlessing !== 'object') ch.zhanshenBlessing = { active: false, creditMs: 0 }; return ch.zhanshenBlessing; }

  // V15.2 (Q25): during the 全服免费战神祝福 event everyone is blessed, free of charge.
  freeEvent() { const b = this.server.features.batch152; return !!(b && b.isOn('freebless')); }
  isBlessed(ch) { return !!(ch && ((ch.zhanshenBlessing && ch.zhanshenBlessing.active) || this.freeEvent())); }

  cost() { return Math.max(0, Math.round(Number(this.server.config.blessPointsPerHour) || 0)); }

  state(p) {
    const b = this.rec(p.ch);
    return {
      active: !!b.active, creditMs: Math.max(0, Math.round(b.creditMs || 0)), servicePoints: this.server.features.bank.points(p),
      pointsPerHour: this.cost(), expFactor: Number(this.server.config.blessExpFactor) || 2,
    };
  }

  sendState(p, message) { this.server.ext.send(p, 'zhanshen', Object.assign(this.state(p), { message: message || '' })); }

  // Counts online time since the last call against the paid hour; pays the next hour
  // when this one is used up, or ends the blessing when the points do not reach.
  touch(p, now) {
    const b = this.rec(p.ch);
    const last = b.lastAt && b.lastAt > 0 ? b.lastAt : now;
    b.lastAt = now;
    if (!b.active) return;
    if (this.freeEvent()) return;   // the paid hour does not run down during the free event
    b.creditMs = (b.creditMs || 0) - Math.max(0, Math.min(now - last, 60000));
    while (b.active && b.creditMs <= 0) {
      if (!this.pay(p)) {
        b.active = false; b.creditMs = 0;
        this.server.ext.tell(p, '服务点数不足，战神的祝福已经结束。');
        this.sendState(p);
      }
    }
  }

  pay(p) {
    const cost = this.cost();
    const bank = this.server.features.bank;
    if (bank.points(p) < cost) return false;
    p.session.account.servicePoints -= cost;
    this.rec(p.ch).creditMs += HOUR_MS;
    this.server.store.markDirty();
    if (this.rec(p.ch).active) this.sendState(p);
    return true;
  }

  toggle(p, on) {
    if (!p.scene || p.scene.mapRef !== 'job_fight') return;
    const b = this.rec(p.ch);
    this.touch(p, Date.now());
    if (!on) {
      if (b.active) { b.active = false; this.server.store.markDirty(); }
      return this.sendState(p, '战神的祝福已停止。本小时剩下的 ' + Math.ceil(Math.max(0, b.creditMs) / 60000) + ' 分钟会留到下次使用。');
    }
    if (b.active) return this.sendState(p, '你已经拥有战神的祝福。');
    if (b.creditMs <= 0 && !this.pay(p)) {
      return this.sendState(p, '服务点数不足：战神的祝福每小时需要 ' + this.cost() + ' 点，你只有 ' + this.server.features.bank.points(p) + ' 点。');
    }
    b.active = true;
    b.lastAt = Date.now();
    this.server.store.markDirty();
    for (const q of p.scene.players.values()) this.server.ext.send(q, 'bless_open', { playerId: p.id });
    this.sendIds();
    this.sendState(p, '战神赐予你祝福！打怪经验不再因等级衰减，并且翻倍。');
  }

  // Tells each player which players of their scene are blessed, when that changes.
  sendIds() {
    for (const p of this.server.playersById.values()) {
      if (!p.scene) continue;
      const ids = [];
      for (const q of p.scene.players.values()) if (this.isBlessed(q.ch)) ids.push(q.id);
      const key = p.scene.mapRef + '|' + ids.sort().join(',');
      if (p.blessIdsSent === key) continue;
      p.blessIdsSent = key;
      this.server.ext.send(p, 'bless_ids', { ids });
    }
  }

  sweep(now) {
    for (const p of this.server.playersById.values()) if (p.ch.zhanshenBlessing) this.touch(p, now);
  }
}

module.exports = { Blessing };
