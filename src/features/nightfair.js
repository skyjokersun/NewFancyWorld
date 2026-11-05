'use strict';
// 夜市 (map fair), ninth batch. 小洁 (decor thingirl) sells 波波灯; 刘嫂 (decor fatwoman)
// swaps crickets for fireflies: gold 1, green 3, brown 5 per firefly (admin 夜市).
//
// Catching crickets (tenth batch):
// - The fair keeps cricketMax crickets (gold / green / brown by weight). Each one rests
//   1.5-4 s, then hops 40-120 px along an arc to a walkable spot. A caught one comes back
//   after cricketRespawnSec.
// - A player with a 波波灯 in the bag sees the crickets within cricketSeeRange (ext
//   crickets, sent as they change) and floats a lamp that everyone in the fair can see.
// - A click on a cricket within cricketCatchRange tries to catch it, at the kind's chance
//   (cricketCatchGold/Green/Brown, percent). A catch puts it in the bag and uses one lamp;
//   a miss costs nothing, and the cricket hops away twice.
// Patch 102 draws the crickets and the lamps.
const C = require('../game/character');
const KINDS = ['gold', 'green', 'brown'];
const HOP_MIN = 40, HOP_MAX = 120;
const SEND_MS = 300;

const GOLD = 2616, GREEN = 2617, BROWN = 2618, FIREFLY = 2619, LAMP = 2620;
const CRICKETS = { gold: [GOLD, 'fireflyGold', '金色蛐蛐'], green: [GREEN, 'fireflyGreen', '绿色蛐蛐'], brown: [BROWN, 'fireflyBrown', '褐色蛐蛐'] };

class NightFair {
  register(server) {
    this.server = server;
    server.ext.on('fair_query', (p) => this.sendState(p));
    server.ext.on('fair_exchange', (p, d) => this.exchange(p, String(d.cricket || ''), !!d.all));
    server.ext.on('fair_lamp', (p, d) => this.buyLamp(p, Math.max(1, Math.min(99, Math.trunc(Number(d.count) || 1)))));
    server.ext.on('cricket_catch', (p, d) => this.catchCricket(p, String(d.id || '')));
    this.lastTick = 0; this.lastSend = 0; this.nextNo = 1;
    server.events.on('tick', (now) => {
      if (!this.open()) return;
      if (now - this.lastTick >= 100) { this.lastTick = now; this.tickCrickets(now); }
      if (now - this.lastSend >= SEND_MS) { this.lastSend = now; this.sendCrickets(now); }
    });
  }

  // ---------- crickets ----------
  cfgNum(key, def) { const v = Number(this.server.config[key]); return Number.isFinite(v) ? v : def; }

  fairScenes() {
    const out = [];
    for (const sc of this.server.scenes.values()) if (sc.mapRef === 'fair') out.push(sc);
    return out;
  }

  pickKind() {
    const w = KINDS.map((k) => Math.max(0, this.cfgNum('cricketWeight' + k[0].toUpperCase() + k.slice(1), 0)));
    const total = w.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return 'brown';
    let r = Math.random() * total;
    for (let i = 0; i < KINDS.length; i++) { r -= w[i]; if (r < 0) return KINDS[i]; }
    return 'brown';
  }

  spawnCricket(sc, now) {
    const map = sc.map;
    const at = map.randomWalkablePixel();
    const c = { id: 'q' + sc.uid + '_' + (this.nextNo++), kind: this.pickKind(), x: at.x, y: at.y, hop: null, restUntil: now + 500 + Math.random() * 3000, flee: 0 };
    sc.crickets.list.set(c.id, c);
    sc.crickets.ver += 1;
  }

  // A hop of 40-120 px (away from `from` when fleeing) to walkable ground it can reach.
  startHop(sc, c, now, from) {
    const map = sc.map;
    const comp = map.componentAt(c.x, c.y);
    for (let i = 0; i < 12; i++) {
      let a = Math.random() * Math.PI * 2;
      if (from) a = Math.atan2(c.y - from.y, c.x - from.x) + (Math.random() - 0.5) * 1.6;
      const d = HOP_MIN + Math.random() * (HOP_MAX - HOP_MIN) * (from ? 1.3 : 1);
      const tx = c.x + Math.cos(a) * d, ty = c.y + Math.sin(a) * d * 0.7;
      if (!map.isWalkablePixel(tx, ty) || map.componentAt(tx, ty) !== comp || !map.segmentWalkable(c.x, c.y, tx, ty)) continue;
      c.hop = { fx: Math.round(c.x), fy: Math.round(c.y), tx: Math.round(tx), ty: Math.round(ty), at: now, dur: Math.round(320 + d * 2.5) };
      sc.crickets.ver += 1;
      return true;
    }
    c.restUntil = now + 1000;
    return false;
  }

  tickCrickets(now) {
    for (const sc of this.fairScenes()) {
      if (!sc.crickets) sc.crickets = { list: new Map(), ver: 1, respawns: [] };
      const st = sc.crickets;
      const max = Math.max(0, Math.round(this.cfgNum('cricketMax', 20)));
      // Respawns that are due, then top up (also after the admin raises the number).
      st.respawns = st.respawns.filter((t) => t > now);
      while (st.list.size + st.respawns.length < max) this.spawnCricket(sc, now);
      while (st.list.size > max) { st.list.delete(st.list.keys().next().value); st.ver += 1; }
      for (const c of st.list.values()) {
        if (c.hop && now >= c.hop.at + c.hop.dur) {
          c.x = c.hop.tx; c.y = c.hop.ty; c.hop = null; st.ver += 1;
          c.restUntil = c.flee > 0 ? now + 80 : now + 1500 + Math.random() * 2500;
        }
        if (!c.hop && now >= c.restUntil) {
          const from = c.flee > 0 ? c.fleeFrom : null;
          if (c.flee > 0) c.flee -= 1;
          this.startHop(sc, c, now, from);
        }
      }
    }
  }

  lampCount(p) { return p.countItem(LAMP); }

  sendCrickets(now) {
    const seeRange = Math.max(50, this.cfgNum('cricketSeeRange', 450));
    for (const sc of this.fairScenes()) {
      const st = sc.crickets;
      if (!st) continue;
      const lampIds = [];
      for (const q of sc.players.values()) if (this.lampCount(q) > 0) lampIds.push(q.id);
      for (const p of sc.players.values()) {
        const lamps = this.lampCount(p);
        const moved = !p.cricketAt || Math.hypot(p.x - p.cricketAt.x, p.y - p.cricketAt.y) > 40;
        const key = st.ver + '|' + lamps + '|' + lampIds.join(',');
        if (p.cricketKey === key && !(lamps > 0 && moved)) continue;
        p.cricketKey = key; p.cricketAt = { x: p.x, y: p.y };
        const list = [];
        // Sent a little past the lamp's reach, so a cricket hopping in is drawn at once.
        if (lamps > 0) {
          for (const c of st.list.values()) {
            if (Math.hypot(c.x - p.x, c.y - p.y) > seeRange + 150) continue;
            const e = { id: c.id, k: c.kind, x: Math.round(c.x), y: Math.round(c.y) };
            if (c.hop) e.h = [c.hop.fx, c.hop.fy, c.hop.tx, c.hop.ty, now - c.hop.at, c.hop.dur];
            list.push(e);
          }
        }
        this.server.ext.send(p, 'crickets', { lamps, lampIds, list, see: seeRange, reach: Math.max(20, this.cfgNum('cricketCatchRange', 200)) });
      }
    }
  }

  catchCricket(p, id) {
    if (!this.atFair(p) || !p.alive || !this.open()) return;
    const now = Date.now();
    if (p.cricketTryAt && now - p.cricketTryAt < 350) return;
    p.cricketTryAt = now;
    const st = p.scene.crickets;
    const c = st && st.list.get(id);
    const reply = (ok, message, extra) => this.server.ext.send(p, 'cricket_result', Object.assign({ ok, id, message }, extra || {}));
    if (!c) return reply(false, '它已经不见了。');
    if (this.lampCount(p) <= 0) return reply(false, '没有波波灯，黑漆漆的什么也看不见。小洁那里有卖。');
    // Where it is right now (mid-hop counts where it is in the air).
    let cx = c.x, cy = c.y;
    if (c.hop) { const t = Math.min(1, (now - c.hop.at) / c.hop.dur); cx = c.hop.fx + (c.hop.tx - c.hop.fx) * t; cy = c.hop.fy + (c.hop.ty - c.hop.fy) * t; }
    const reach = Math.max(20, this.cfgNum('cricketCatchRange', 200));
    if (Math.hypot(cx - p.x, cy - p.y) > reach + 30) return reply(false, '离得太远了，走近一点再捉（' + reach + ' 以内）。');
    const [itemId, , name] = CRICKETS[c.kind];
    const chance = Math.max(0, Math.min(100, this.cfgNum('cricketCatch' + c.kind[0].toUpperCase() + c.kind.slice(1), 0))) / 100;
    if (Math.random() >= chance) {
      // Missed: it jumps away twice, away from the player.
      c.flee = 2; c.fleeFrom = { x: p.x, y: p.y };
      if (!c.hop) { c.flee -= 1; this.startHop(p.scene, c, now, c.fleeFrom); }
      return reply(false, '没捉到，' + name + '跳走了！');
    }
    const added = this.give(p, itemId, 1);
    if (!added) return reply(false, '背包满了，放不下蛐蛐。');
    const removed = p.removeItemCount(LAMP, 1) || [];
    p.commitItems({ inv: Array.from(new Set(added.concat(removed))) });
    st.list.delete(c.id); st.ver += 1;
    st.respawns.push(now + Math.max(1, this.cfgNum('cricketRespawnSec', 30)) * 1000);
    this.server.store.markDirty();
    const left = this.lampCount(p);
    reply(true, '捉到了一只' + name + '！用掉一个波波灯，还剩 ' + left + ' 个。', { color: c.kind });
  }

  rate(key) { return Math.max(1, Math.round(Number(this.server.config[key]) || 1)); }

  state(p) {
    const cfg = this.server.config;
    return {
      lampPrice: Math.max(0, Math.round(Number(cfg.lampPrice) || 0)), gold: p.ch.gold,
      crickets: Object.fromEntries(Object.entries(CRICKETS).map(([k, [id, key, name]]) => [k, { name, have: p.countItem(id), per: this.rate(key) }])),
    };
  }

  sendState(p, message) { this.server.ext.send(p, 'fair', Object.assign(this.state(p), { message: message || '' })); }

  // V15.2: the night fair follows the 限时活动 schedule (batch152 'nightfair').
  open() { const b = this.server.features && this.server.features.batch152; return !b || b.isOn('nightfair'); }
  closed(p) { if (this.open()) return false; this.sendState(p, '夜市还没开张，请留意限时活动公告。'); return true; }

  atFair(p) { return p.scene && p.scene.mapRef === 'fair'; }

  give(p, itemId, count) {
    const item = C.makeItem(p.ch, itemId, count);
    return item ? p.addItem(item) : null;
  }

  exchange(p, kind, all) {
    if (!this.atFair(p) || this.closed(p)) return;
    if (kind === 'all') {
      const got = [];
      for (const k of Object.keys(CRICKETS)) {
        const [id, key, name] = CRICKETS[k]; const per = this.rate(key); const n = Math.floor(p.countItem(id) / per);
        if (n && this.swap(p, id, n, per)) got.push(n * per + ' 只' + name);
      }
      return this.sendState(p, got.length ? '用 ' + got.join('、') + ' 换到了萤火虫。' : '没有够数的蛐蛐可换，或者背包满了。');
    }
    const c = CRICKETS[kind];
    if (!c) return;
    const [id, key, name] = c;
    const per = this.rate(key);
    const have = p.countItem(id);
    const n = all ? Math.floor(have / per) : (have >= per ? 1 : 0);
    if (!n) return this.sendState(p, name + '不够：' + per + ' 只换 1 只萤火虫，你有 ' + have + ' 只。');
    if (!this.swap(p, id, n, per)) return this.sendState(p, '背包满了，放不下萤火虫。');
    this.sendState(p, '用 ' + n * per + ' 只' + name + '换到了 ' + n + ' 只萤火虫。');
  }

  // n fireflies for n * per crickets of item id; false (nothing changed) when the bag is full.
  swap(p, id, n, per) {
    const removed = p.removeItemCount(id, n * per);
    const added = this.give(p, FIREFLY, n);
    if (!added) {
      this.give(p, id, n * per);
      p.commitItems({ inv: removed || [] });
      return false;
    }
    p.commitItems({ inv: Array.from(new Set((removed || []).concat(added))) });
    this.server.store.markDirty();
    return true;
  }

  buyLamp(p, count) {
    if (!this.atFair(p) || this.closed(p)) return;
    const price = this.state(p).lampPrice * count;
    if (p.ch.gold < price) return this.sendState(p, '金币不够：' + count + ' 个波波灯要 ' + price + ' 金币。');
    const added = this.give(p, LAMP, count);
    if (!added) return this.sendState(p, '背包满了。');
    p.ch.gold -= price;
    p.commitItems({ inv: added });
    this.server.store.markDirty();
    this.sendState(p, '买到了 ' + count + ' 个波波灯，花了 ' + price + ' 金币。');
  }
}

module.exports = { NightFair, GOLD, GREEN, BROWN, FIREFLY, LAMP };
