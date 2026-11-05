'use strict';
// Ore smelting furnace (炼矿熔炉): drop one ore stack in, heat it and tap the
// furnace while the melt is liquid (3500-4500℃) to get ingots.
const C = require('../../game/character');
const D = require('./data');
const U = require('./common');

const MAX_T = 5000;
const BAND_MIN = 3500;
const BAND_MAX = 4500;
const HEAT_RATE = 420;
const MAX_BATCH = 10;
const E = { NO_SESSION: 2, NOT_FURNACE: 3, NOT_HERE: 4, CLOSED: 5, STALE: 6, NOT_ORE: 8, PHASE: 9, EMPTY: 10, LEVEL: 11, BAG_FULL: 13 };

class Smelting {
  constructor(crafting) { this.crafting = crafting; this.server = crafting.server; this.furnaces = new Map(); }

  register() {
    const s = this.server; const op = s.op; const rp = (fn) => s.requirePlayer((p, d) => fn.call(this, p, d || {}));
    s.on(op.ORE_SMELTING_OPEN, rp(this.open));
    s.on(op.ORE_SMELTING_SELECT, rp(this.select));
    s.on(op.ORE_SMELTING_HEAT, rp(this.heat));
    s.on(op.ORE_SMELTING_FINISH, rp(this.finish));
    s.on(op.ORE_SMELTING_RENEW, rp(this.renew));
    s.on(op.ORE_SMELTING_CLOSE, rp(this.close));
    s.events.on('tick', (now) => this.tick(now));
  }

  err(p, code, message) { p.send(this.server.op.ORE_SMELTING_ERROR, { code, message, serverSeq: this.server.nextSeq() }); }

  furnaceIds(mapRef) {
    if (!this.furnaces.has(mapRef)) {
      const doc = this.server.maps.rawDoc(mapRef);
      const ids = new Set();
      for (const d of (doc && doc.decor) || []) {
        if (String(d.tag || '').toLowerCase() === 'furnace' && /tj_huolu\.ale$/i.test(d.path || '')) ids.add(Math.round(d.x) + ':' + Math.round(d.y));
      }
      this.furnaces.set(mapRef, ids);
    }
    return this.furnaces.get(mapRef);
  }

  session(p, d) {
    const s = p.interactions.smelt;
    if (!s || (d.sessionId && d.sessionId !== s.sessionId)) { this.err(p, E.NO_SESSION, '熔炉会话已结束，请重新使用熔炉。'); return null; }
    return s;
  }

  temperatureAt(s, now) { return Math.max(0, Math.min(MAX_T, s.temperature + s.rate * (now - s.at) / 1000)); }

  sendState(p, s, message = '') {
    const now = Date.now();
    s.temperature = this.temperatureAt(s, now); s.at = now;
    const sel = s.selected ? U.viewRef(p, s.selected) : null;
    if (s.selected && !sel) s.selected = null;
    p.send(this.server.op.ORE_SMELTING_STATE, {
      sessionId: s.sessionId, furnaceId: s.furnaceId, phase: s.phase, selected: sel,
      temperature: Math.round(s.temperature * 100) / 100, temperatureRate: s.rate, serverTime: now, message,
      serverSeq: this.server.nextSeq(),
    });
  }

  open(p, d) {
    if (!U.mapIs(p, 'smelt', 'smith')) return this.err(p, E.NOT_HERE, '这里没有炼矿熔炉。');
    const furnaceId = String(d.furnaceId || '');
    if (!this.furnaceIds(p.scene.mapRef).has(furnaceId)) return this.err(p, E.NOT_FURNACE, '找不到这个熔炉。');
    const s = { sessionId: U.newSessionId('smelt'), furnaceId, phase: 'idle', selected: null, temperature: 20, rate: 0, at: Date.now() };
    p.interactions.smelt = s;
    this.sendState(p, s, '请把一块矿石原料拖入熔炉。');
  }

  select(p, d) {
    const s = this.session(p, d); if (!s) return;
    if (s.phase !== 'idle') return this.err(p, E.PHASE, '熔炉正在工作，不能更换原料。');
    if (d.inventoryIndex == null) { s.selected = null; return this.sendState(p, s, '原料已取出。'); }
    const index = U.idx(d.inventoryIndex);
    const it = index == null ? null : p.ch.inventory[index];
    if (!it) return this.err(p, E.STALE, '背包物品已经变化。');
    const metal = D.ORE_BY_ID.get(it.itemId);
    if (!metal) return this.err(p, E.NOT_ORE, '熔炉里只能放入矿石。');
    const lvl = D.skillLevel(D.craftState(p.ch).smelting.exp);
    if (lvl < metal.level) return this.err(p, E.LEVEL, '提炼' + metal.name + '需要炼矿 ' + metal.level + ' 级。');
    s.selected = U.invRef(p, index);
    this.sendState(p, s, '放入了' + it.name + '，最多一次提炼 ' + MAX_BATCH + ' 块。');
  }

  heat(p, d) {
    const s = this.session(p, d); if (!s) return;
    if (s.phase !== 'idle') return this.err(p, E.PHASE, '熔炉已经在加热了。');
    if (!s.selected || !U.resolveRef(p, s.selected)) return this.err(p, E.EMPTY, '没有物品或物品种数多余一种');
    s.temperature = this.temperatureAt(s, Date.now()); s.at = Date.now();
    s.phase = 'heating'; s.rate = HEAT_RATE;
    this.sendState(p, s, '开始加热，在矿石变成液态时出炉。');
  }

  fail(p, s, message) {
    s.phase = 'renewal'; s.temperature = this.temperatureAt(s, Date.now()); s.rate = 0; s.at = Date.now();
    D.gainSkill(p.ch, 'smelting', 0, '炼矿', false);
    p.send(this.server.op.ORE_SMELTING_RESULT, { sessionId: s.sessionId, success: false, message, serverSeq: this.server.nextSeq() });
    this.sendState(p, s, message);
  }

  finish(p, d) {
    const s = this.session(p, d); if (!s) return;
    if (s.phase !== 'heating') return this.err(p, E.PHASE, '熔炉还没有加热。');
    const t = this.temperatureAt(s, Date.now());
    const ore = U.resolveRef(p, s.selected);
    if (!ore) return this.err(p, E.STALE, '原料已经不在背包里。');
    if (t < BAND_MIN) return this.fail(p, s, '温度只有 ' + Math.round(t) + '℃，矿石还没有熔化，提炼失败。');
    if (t > BAND_MAX) return this.fail(p, s, '温度太高，矿石汽化了，提炼失败。');
    const metal = D.ORE_BY_ID.get(ore.itemId);
    const n = Math.min(MAX_BATCH, ore.count);
    const lvl = D.skillLevel(D.craftState(p.ch).smelting.exp);
    const rate = Math.min(0.98, 0.7 + lvl * 0.004 + (p.ch.profession === 'craftsman' ? 0.1 : 0));
    const room = ore.count <= n || p.findFreeSlot() >= 0 || p.ch.inventory.some((it) => it && it.itemId === metal.ingot);
    if (!room) return this.err(p, E.BAG_FULL, '背包已满，放不下提炼出的金属锭。');
    const made = Math.max(1, Math.min(n, Math.floor(n * rate + Math.random())));
    const changed = [U.consumeAt(p, s.selected.inventoryIndex, n)];
    if (made > 0) changed.push(...(p.addItem(C.makeItem(p.ch, metal.ingot, made)) || []));
    const messages = D.gainSkill(p.ch, 'smelting', made * 3 + 2, '炼矿');
    p.commitItems({ inv: changed });
    delete p.interactions.smelt;
    const message = '提炼成功！' + n + ' 块' + metal.name + '矿石炼出了 ' + made + ' 块' + metal.name + '锭。' + (messages.length ? messages.join(' ') : '');
    p.send(this.server.op.ORE_SMELTING_RESULT, { sessionId: s.sessionId, success: true, message, serverSeq: this.server.nextSeq() });
  }

  renew(p, d) {
    const s = this.session(p, d); if (!s) return;
    s.phase = 'idle'; s.temperature = 20; s.rate = 0; s.at = Date.now();
    this.sendState(p, s, '熔炉已经冷却，可以继续提炼。');
  }

  close(p, d) {
    const s = p.interactions.smelt;
    if (s && (!d.sessionId || d.sessionId === s.sessionId)) delete p.interactions.smelt;
  }

  tick(now) {
    if (this.lastTick && now - this.lastTick < 250) return;
    this.lastTick = now;
    for (const p of this.server.playersById.values()) {
      const s = p.interactions.smelt;
      if (s && s.phase === 'heating' && this.temperatureAt(s, now) >= MAX_T) this.fail(p, s, '温度太高，矿石汽化了，提炼失败。');
    }
  }
}

module.exports = { Smelting };
