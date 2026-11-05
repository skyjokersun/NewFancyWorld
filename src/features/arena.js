'use strict';
// Arena target dummies (eighth batch). Each 自由角斗 room (pk_a1..6, separate copies of
// abattoir_pka) has a target keeper by the door (patch 25 adds the NPC, patch 100 the
// menu). One kind of target per room at a time:
// - 强壮靶子: one target in the middle with 5,000,000 life that heals 5,000,000 a second;
// - 脆弱靶子: three targets in a triangle with 1 life; a broken one vanishes at once
//   and a new one stands in the same spot a second later.
// Targets never move, fight back or take effects, give no exp and drop nothing; each
// rental picks random monster looks. Renting costs targetRentGold (admin, default 0).
// They are cleared on 归还靶子 or when the room has been empty for 30 seconds.
const ARENA_ROOM_MAP = 'abattoir_pka';

const STRONG_HP = 5000000;
const STRONG_REGEN = 5000000;
const FRAGILE_RESPAWN_MS = 1000;
const EMPTY_CLEAR_MS = 30000;
const CENTRE = { x: 900, y: -480 };
const TRIANGLE = [{ x: 900, y: -390 }, { x: 800, y: -550 }, { x: 1000, y: -550 }];
const LABELS = { strong: '强壮靶子', fragile: '脆弱靶子' };

class Arena {
  register(server) {
    this.server = server;
    server.ext.on('arena_rent', (p, d) => this.rent(p, d.target));
    server.ext.on('arena_return', (p) => this.giveBack(p));
    server.ext.on('arena_query', (p) => this.sendState(p));
    this.lastSweep = 0;
    server.events.on('tick', (now) => { if (now - this.lastSweep >= 2000) { this.lastSweep = now; this.sweep(now); } });
  }

  inRoom(p) { return !!(p.scene && p.scene.map.id === ARENA_ROOM_MAP); }

  sendState(p) {
    const a = p.scene && p.scene.arena;
    this.server.ext.send(p, 'arena', { inRoom: this.inRoom(p), target: a ? a.kind : null, fee: Math.max(0, Math.round(this.server.config.targetRentGold || 0)) });
  }

  models() {
    if (!this.modelList) {
      const set = new Set();
      for (const r of this.server.features.balance.catalog().values()) if (r.template.model) set.add(String(r.template.model).toLowerCase());
      set.delete('fox3');
      this.modelList = Array.from(set);
    }
    return this.modelList;
  }

  randomModel() { const l = this.models(); return l[Math.floor(Math.random() * l.length)] || 'foxman'; }

  rent(p, kind) {
    if (!this.inRoom(p)) return this.server.ext.tell(p, '只有在自由角斗室里才能租借靶子。');
    if (!LABELS[kind]) return;
    const sc = p.scene;
    if (sc.arena) {
      this.server.ext.tell(p, sc.arena.kind === kind ? '这个房间已经有' + LABELS[kind] + '了。' : '这个房间已经租了' + LABELS[sc.arena.kind] + '，请先归还靶子。');
      return this.sendState(p);
    }
    const fee = Math.max(0, Math.round(this.server.config.targetRentGold || 0));
    if (fee > 0) {
      if ((p.ch.gold || 0) < fee) return this.server.ext.tell(p, '金币不足：租借靶子需要 ' + fee + ' 金币。');
      p.ch.gold -= fee;
      p.paramsDirty = true;
      this.server.store.markDirty();
    }
    sc.arena = { kind, renter: p.id, targets: new Set(), emptySince: 0 };
    if (kind === 'strong') this.spawn(sc, CENTRE, 'strong');
    else for (const at of TRIANGLE) this.spawn(sc, at, 'fragile');
    this.server.ext.tell(p, '已租借' + LABELS[kind] + (fee > 0 ? '，花费 ' + fee + ' 金币。' : '。'));
    for (const q of sc.players.values()) this.sendState(q);
  }

  giveBack(p) {
    const sc = p.scene;
    if (!this.inRoom(p) || !sc.arena) return this.server.ext.tell(p, '这个房间没有租借的靶子。');
    this.clear(sc);
    this.server.ext.tell(p, '靶子已归还。');
  }

  clear(sc) {
    const a = sc.arena;
    if (!a) return;
    sc.arena = null;
    for (const m of a.targets) if (sc.enemies.delete(m.id)) sc.removedEnemyIds.push(m.id);
    for (const q of sc.players.values()) this.sendState(q);
  }

  spawn(sc, at, kind) {
    const a = sc.arena;
    if (!a) return null;
    const pos = sc.map.isWalkablePixel(at.x, at.y) ? at : (sc.map.nearestWalkablePixel(at.x, at.y, 120) || at);
    const strong = kind === 'strong';
    const def = {
      monsterId: 'arena_target_' + kind, name: LABELS[kind], model: this.randomModel(), level: 1,
      hp: strong ? STRONG_HP : 1, maxHp: strong ? STRONG_HP : 1, damage: 0, defense: 0, breakPower: 0,
      attackRange: 40, detectionRange: 80, moveSpeed: 30, baseExp: 0, drops: [],
    };
    const m = sc.addMonster(def, pos, { def, centre: pos });
    // The monster HP setting does not scale targets.
    m.maxHp = def.maxHp; m.hp = def.maxHp; m.damage = 0;
    m.isTarget = true; m.noReward = true; m.summonedBy = 'arena';
    m.aggro = () => {};
    let lastRegen = Date.now();
    m.tick = (now) => {
      if (!strong || !m.alive || now - lastRegen < 1000) return;
      lastRegen = now;
      if (m.hp < m.maxHp) { m.hp = Math.min(m.maxHp, m.hp + STRONG_REGEN); m.markDirty(); }
    };
    m.onKilled = () => {
      // The broken target vanishes at once; a new one stands there a second later.
      a.targets.delete(m);
      if (sc.enemies.delete(m.id)) sc.removedEnemyIds.push(m.id);
      setTimeout(() => { if (sc.arena === a) this.spawn(sc, pos, kind); }, strong ? 0 : FRAGILE_RESPAWN_MS);
    };
    a.targets.add(m);
    return m;
  }

  sweep(now) {
    for (const sc of this.server.scenes.values()) {
      const a = sc.arena;
      if (!a) continue;
      if (sc.players.size) { a.emptySince = 0; continue; }
      if (!a.emptySince) a.emptySince = now;
      else if (now - a.emptySince >= EMPTY_CLEAR_MS) this.clear(sc);
    }
  }
}

module.exports = { Arena };
