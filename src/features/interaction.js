'use strict';
// Character interactions (CHARACTER_INTERACTION 5600 -> _EVENT 5610):
// poses, expressions, paired actions (hug/kiss/gift), inspect, player trade
// and stalls. Stalls follow the mobile-stall patch (75_mobile_stalls): a stall
// is a world object that stays where it was opened while its owner walks
// away; the owner pays 1% tax within 500 px of it and 20% otherwise.
const C = require('../game/character');
const { cloneItem } = require('../game/player');
const { hasLicense } = require('./townhouse');

const INTERACT_RANGE_PX = 480;
const REQUEST_TTL_MS = 20 * 1000;
const PERFORM_MS = 2600;
const EXPRESSION_MS = 6000;
const EXPRESSION_COUNT = 13;
const TRADE_MAX_SLOTS = 10;
const TRADE_RANGE_PX = 900;
const MAX_GOLD = 2e9;
const STALL_MAX_LISTINGS = 10;
const STALL_MANAGE_RADIUS = 150;
const STALL_TAX_RADIUS = 500;
const STALL_BUY_RANGE_PX = 400;
const STALL_MIN_GAP_PX = 60;
const STALL_MAX_PRICE = 9999999;
const POSES = new Set(['stand', 'sit', 'lie']);
const ACTIONS = new Set(['hug', 'kiss', 'trade', 'gift']);
const ACTION_LABELS = { hug: '拥抱', kiss: '亲吻', trade: '交易', gift: '礼物' };

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function int(v) { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : NaN; }

class Interaction {
  register(server) {
    this.server = server;
    this.stalls = server.store.bucket('stalls');   // ownerId -> stall
    this.requests = new Map();                     // requestId -> request
    this.trades = new Map();                       // sessionId -> trade
    this.nextNo = 1;
    server.on(server.op.CHARACTER_INTERACTION, server.requirePlayer((p, d) => this.handle(p, d || {})));
    server.events.on('playerEntered', (p) => this.onEntered(p));
    server.events.on('playerLeaving', (p) => this.onLeaving(p));
    server.events.on('playerMapChanging', (p) => this.onMapChanging(p));
    server.events.on('tick', (now) => this.tick(now));
  }

  // --- plumbing ---
  send(p, type, extra = {}) {
    p.send(this.server.op.CHARACTER_INTERACTION_EVENT, Object.assign({ type, serverSeq: this.server.nextSeq() }, extra));
  }

  fail(p, message) { this.send(p, 'error', { message }); }

  sceneBroadcast(scene, type, extra) { for (const q of scene.players.values()) this.send(q, type, extra); }

  rt(p) {
    if (!p.interact) p.interact = { pose: 'stand', expressionId: null, expressionUntil: 0 };
    return p.interact;
  }

  stallOf(ownerId) { return this.stalls[ownerId] || null; }

  stateOf(p) {
    const r = this.rt(p);
    const stall = this.stallOf(p.id);
    return {
      playerId: p.id,
      pose: r.pose,
      stallActive: !!stall,
      activeExpressionId: r.expressionId,
      stall: stall ? this.publicStall(stall) : null,
    };
  }

  broadcastState(p) { if (p.scene) this.sceneBroadcast(p.scene, 'state', this.stateOf(p)); }

  handle(p, d) {
    if (!p.scene) return undefined;
    switch (d.type) {
      case 'pose': return this.setPose(p, d.pose);
      case 'expression': return this.expression(p, d.expressionId);
      case 'target_request': return this.request(p, d);
      case 'target_response': return this.respond(p, d);
      case 'inspect': return this.inspect(p, d);
      case 'trade_preference': p.ch.allowIncomingTrades = d.allowIncomingTrades !== false; this.server.store.markDirty(); return undefined;
      case 'trade_offer': return this.tradeOffer(p, d);
      case 'trade_remove': return this.tradeRemove(p, d);
      case 'trade_gold': return this.tradeGold(p, d);
      case 'trade_confirm': return this.tradeConfirm(p, d);
      case 'trade_cancel': return this.tradeCancel(p, d);
      case 'stall': return this.toggleStall(p, d);
      case 'stall_open': return this.openStall(p, d);
      case 'stall_update': return this.updateStall(p, d);
      case 'stall_buy': return this.buyStall(p, d);
      default: return this.fail(p, '暂不支持该互动。');
    }
  }

  // --- lifecycle ---
  snapshot(p) {
    const sc = p.scene;
    if (!sc) return;
    const stalls = Object.values(this.stalls).filter((s) => s.world === sc.world && s.mapRef === sc.mapRef).map((s) => this.publicStall(s));
    const own = this.stallOf(p.id);
    this.send(p, 'snapshot', {
      mapRef: sc.mapRef,
      states: Array.from(sc.players.values()).map((q) => this.stateOf(q)),
      stalls,
      ownStall: own ? this.publicStall(own) : null,
    });
  }

  onEntered(p) { this.snapshot(p); }

  onLeaving(p) {
    this.closeTradeFor(p, '对方已经离线，交易取消。');
    for (const [id, r] of this.requests) if (r.fromId === p.id || r.toId === p.id) this.requests.delete(id);
  }

  onMapChanging(p) {
    this.closeTradeFor(p, '离开地图，交易取消。');
    const r = this.rt(p);
    r.pose = 'stand'; r.expressionId = null; r.expressionUntil = 0;
    // MAP_SWITCH_RESULT goes out right after this event; send our snapshot after it.
    setImmediate(() => { if (p.scene && this.server.playersById.get(p.id) === p) this.snapshot(p); });
  }

  tick(now) {
    if (this.lastTick && now - this.lastTick < 250) return;
    this.lastTick = now;
    if (!this.lastLicenseCheck || now - this.lastLicenseCheck > 5000) { this.lastLicenseCheck = now; this.closeExpiredStalls(now); }
    for (const [id, r] of this.requests) if (r.expiresAt < now) this.requests.delete(id);
    for (const p of this.server.playersById.values()) {
      const r = p.interact;
      if (!r || !p.scene) continue;
      if (r.expressionId !== null && r.expressionUntil < now) {
        r.expressionId = null;
        this.sceneBroadcast(p.scene, 'expression', { playerId: p.id, expressionId: null });
      }
      // Walking (or dying) stands the character up even if the client forgot to say so.
      if (r.pose !== 'stand' && (p.path.length > 0 || !p.alive)) { r.pose = 'stand'; this.broadcastState(p); }
    }
    for (const t of Array.from(this.trades.values())) {
      const [a, b] = [this.server.playersById.get(t.ids[0]), this.server.playersById.get(t.ids[1])];
      if (!a || !b || a.scene !== b.scene || dist(a, b) > TRADE_RANGE_PX) this.closeTrade(t, '双方距离太远，交易取消。');
    }
  }

  // Stalls close when the owner's license runs out (online or not).
  closeExpiredStalls(now) {
    for (const s of Object.values(this.stalls)) {
      const owner = this.server.playersById.get(s.ownerPlayerId);
      const ch = owner ? owner.ch : this.server.store.data.characters[s.ownerPlayerId];
      if (ch && hasLicense(ch, now)) continue;
      delete this.stalls[s.ownerPlayerId];
      this.stallChanged(s, true);
      if (owner) {
        this.broadcastState(owner);
        owner.send(this.server.op.CHAT_MESSAGE, this.server.systemChat('你的摆摊执照已过期，摊位已自动收摊。到市政厅续期后可以重新摆摊。'));
      }
    }
  }

  // --- pose / expression ---
  setPose(p, pose) {
    if (!POSES.has(pose)) return this.fail(p, '无效的动作。');
    if (pose !== 'stand' && !p.alive) return this.fail(p, '现在不能这样做。');
    const r = this.rt(p);
    if (pose !== 'stand') { p.path = []; p.markDirty(); }
    if (r.pose === pose) return undefined;
    r.pose = pose;
    this.broadcastState(p);
    return undefined;
  }

  expression(p, id) {
    const n = id === null ? null : int(id);
    if (n !== null && !(n >= 0 && n < EXPRESSION_COUNT)) return this.fail(p, '无效的表情。');
    const r = this.rt(p);
    r.expressionId = n;
    r.expressionUntil = Date.now() + EXPRESSION_MS;
    this.sceneBroadcast(p.scene, 'expression', { playerId: p.id, expressionId: n });
    return undefined;
  }

  // --- paired actions ---
  target(p, id, range = INTERACT_RANGE_PX) {
    const q = p.scene.players.get(String(id || ''));
    if (!q || q === p) { this.fail(p, '找不到该玩家。'); return null; }
    if (!q.alive || !p.alive) { this.fail(p, '现在不能互动。'); return null; }
    if (dist(p, q) > range) { this.fail(p, '距离太远了，请靠近一些。'); return null; }
    return q;
  }

  request(p, d) {
    const action = String(d.action || '');
    if (!ACTIONS.has(action)) return this.fail(p, '无效的互动。');
    const q = this.target(p, d.targetPlayerId);
    if (!q) return undefined;
    if (action === 'trade') {
      if (q.ch.allowIncomingTrades === false) return this.fail(p, q.name + ' 拒绝接受交易。');
      if (this.tradeOf(p)) return this.fail(p, '你正在交易中。');
      if (this.tradeOf(q)) return this.fail(p, q.name + ' 正在和别人交易。');
    }
    for (const r of this.requests.values()) {
      if (r.fromId === p.id && r.toId === q.id && r.action === action) return this.fail(p, '已经发出邀请，请等待对方回应。');
    }
    const req = { id: 'req_' + (this.nextNo++), action, fromId: p.id, toId: q.id, expiresAt: Date.now() + REQUEST_TTL_MS };
    this.requests.set(req.id, req);
    this.send(q, 'request', { requestId: req.id, action, fromPlayerId: p.id, fromPlayerName: p.name, expiresAt: req.expiresAt });
    this.fail(p, '已向 ' + q.name + ' 发出' + ACTION_LABELS[action] + '邀请。');
    return undefined;
  }

  respond(p, d) {
    const req = this.requests.get(String(d.requestId || ''));
    if (!req || req.toId !== p.id) return undefined;
    this.requests.delete(req.id);
    const from = this.server.playersById.get(req.fromId);
    if (!from) return this.fail(p, '对方已经离开。');
    const accepted = d.accepted === true && req.expiresAt >= Date.now();
    const ev = { action: req.action, accepted, fromPlayerId: from.id, fromPlayerName: from.name, targetPlayerId: p.id, targetPlayerName: p.name };
    // The client shows targetPlayerName to the requester and fromPlayerName to the target.
    this.send(from, 'response', ev);
    this.send(p, 'response', ev);
    if (!accepted) return undefined;
    if (from.scene !== p.scene || dist(from, p) > INTERACT_RANGE_PX * 1.5) return this.fail(p, '距离太远了。');
    if (req.action === 'trade') return this.openTrade(from, p);
    for (const q of [from, p]) { this.rt(q).pose = 'stand'; q.path = []; q.markDirty(); }
    this.sceneBroadcast(p.scene, 'perform', { action: req.action, fromPlayerId: from.id, targetPlayerId: p.id, durationMs: PERFORM_MS });
    return undefined;
  }

  inspect(p, d) {
    const q = p.scene.players.get(String(d.targetPlayerId || ''));
    if (!q) return this.fail(p, '找不到该玩家。');
    const params = q.params().profile;
    const ap = q.ch.appearance || {};
    this.send(p, 'inspect', {
      target: {
        playerId: q.id, playerName: q.name, gender: ap.gender, portraitId: ap.portraitId,
        customAvatar: q.ch.customAvatar || undefined,
        age: params.age, communityLevel: params.communityLevel, professionName: params.professionName,
        professionLevel: q.stats.professionLevel, combatLevel: q.stats.combatLevel,
        title: params.title, alignment: params.alignment, reputation: params.reputation,
        team: params.team, duty: params.duty,
      },
    });
    return undefined;
  }

  // --- trade ---
  tradeOf(p) { return p.tradeId ? this.trades.get(p.tradeId) || null : null; }

  openTrade(a, b) {
    if (this.tradeOf(a) || this.tradeOf(b)) return this.fail(b, '对方正在交易中。');
    const t = { id: 'trade_' + (this.nextNo++), ids: [a.id, b.id], offers: { [a.id]: [], [b.id]: [] }, gold: { [a.id]: 0, [b.id]: 0 }, confirmed: { [a.id]: false, [b.id]: false } };
    this.trades.set(t.id, t);
    a.tradeId = t.id; b.tradeId = t.id;
    this.sendTrade(t, '交易开始');
    return undefined;
  }

  other(t, id) { return t.ids[0] === id ? t.ids[1] : t.ids[0]; }

  findBySeq(ch, seqId) {
    const i = ch.inventory.findIndex((it) => it && it.seqId === seqId);
    return i < 0 ? null : { index: i, item: ch.inventory[i] };
  }

  // Offers are references into the bag; drop any whose item went away.
  liveOffers(t, id) {
    const p = this.server.playersById.get(id);
    if (!p) return [];
    t.offers[id] = t.offers[id].filter((o) => {
      const f = this.findBySeq(p.ch, o.itemSeqId);
      if (!f) return false;
      o.inventoryIndex = f.index;
      o.count = Math.min(o.count, f.item.count);
      return true;
    });
    return t.offers[id];
  }

  offerView(t, id) {
    const p = this.server.playersById.get(id);
    return this.liveOffers(t, id).map((o, index) => {
      const item = cloneItem(p.ch.inventory[o.inventoryIndex]);
      item.count = o.count;
      return { index, inventoryIndex: o.inventoryIndex, itemSeqId: o.itemSeqId, seqId: o.itemSeqId, count: o.count, item };
    });
  }

  sendTrade(t, message) {
    for (const id of t.ids) {
      const p = this.server.playersById.get(id);
      if (!p) continue;
      const o = this.other(t, id);
      this.send(p, 'trade_state', {
        trade: {
          sessionId: t.id,
          otherPlayerId: o,
          otherPlayerName: this.server.playersById.get(o) ? this.server.playersById.get(o).name : '',
          ownOffers: this.offerView(t, id),
          otherOffers: this.offerView(t, o),
          ownGold: t.gold[id], otherGold: t.gold[o],
          ownConfirmed: t.confirmed[id], otherConfirmed: t.confirmed[o],
        },
        message: message || undefined,
      });
    }
  }

  activeTrade(p, d) {
    const t = this.tradeOf(p);
    if (!t || (d.sessionId && d.sessionId !== t.id)) { this.send(p, 'trade_closed', { message: '交易已经结束。' }); return null; }
    return t;
  }

  unconfirm(t) { for (const id of t.ids) t.confirmed[id] = false; }

  tradeOffer(p, d) {
    const t = this.activeTrade(p, d);
    if (!t) return undefined;
    const idx = int(d.inventoryIndex);
    const it = p.ch.inventory[idx];
    if (!it || (d.itemSeqId && it.seqId !== d.itemSeqId)) return this.fail(p, '物品已经不在背包中。');
    if (it.bound || (it.ext && it.ext.bound)) return this.fail(p, '该物品不能交易。');
    const count = int(d.count);
    if (!(count >= 1 && count <= it.count)) return this.fail(p, '交易数量必须是 1 到 ' + it.count + ' 之间的整数。');
    const offers = this.liveOffers(t, p.id);
    const existing = offers.find((o) => o.itemSeqId === it.seqId);
    if (existing) existing.count = count;
    else {
      if (offers.length >= TRADE_MAX_SLOTS) return this.fail(p, '交易栏最多只能放入10种物品');
      offers.push({ inventoryIndex: idx, itemSeqId: it.seqId, count });
    }
    this.unconfirm(t);
    this.sendTrade(t);
    return undefined;
  }

  tradeRemove(p, d) {
    const t = this.activeTrade(p, d);
    if (!t) return undefined;
    const offers = this.liveOffers(t, p.id);
    const i = int(d.offerIndex);
    if (!(i >= 0 && i < offers.length)) return undefined;
    offers.splice(i, 1);
    this.unconfirm(t);
    this.sendTrade(t);
    return undefined;
  }

  tradeGold(p, d) {
    const t = this.activeTrade(p, d);
    if (!t) return undefined;
    const g = int(d.gold);
    if (!(g >= 0)) return this.fail(p, '请输入正确的金币数量。');
    if (g > p.ch.gold) return this.fail(p, '你没有那么多金币。');
    t.gold[p.id] = g;
    this.unconfirm(t);
    this.sendTrade(t);
    return undefined;
  }

  tradeCancel(p, d) {
    const t = this.tradeOf(p);
    if (!t || (d.sessionId && d.sessionId !== t.id)) return undefined;
    this.closeTrade(t, p.name + ' 取消了交易。');
    return undefined;
  }

  closeTradeFor(p, message) { const t = this.tradeOf(p); if (t) this.closeTrade(t, message); }

  closeTrade(t, message) {
    this.trades.delete(t.id);
    for (const id of t.ids) {
      const p = this.server.playersById.get(id);
      if (!p) continue;
      if (p.tradeId === t.id) p.tradeId = null;
      this.send(p, 'trade_closed', { message });
    }
  }

  tradeConfirm(p, d) {
    const t = this.activeTrade(p, d);
    if (!t) return undefined;
    t.confirmed[p.id] = true;
    if (!t.ids.every((id) => t.confirmed[id])) { this.sendTrade(t); return undefined; }
    const [a, b] = t.ids.map((id) => this.server.playersById.get(id));
    const problem = this.executeTrade(t, a, b);
    if (problem) { this.unconfirm(t); this.sendTrade(t, problem); return undefined; }
    this.closeTrade(t, '交易成功！');
    return undefined;
  }

  // Validate everything first, then move items and gold in one go.
  executeTrade(t, a, b) {
    if (!a || !b) return '对方已经离开。';
    const sides = [[a, b], [b, a]];
    for (const [p] of sides) {
      if (t.gold[p.id] > p.ch.gold) return p.name + ' 的金币不足。';
      for (const o of t.offers[p.id]) {
        const f = this.findBySeq(p.ch, o.itemSeqId);
        if (!f || f.item.count < o.count) return p.name + ' 的交易物品发生了变化，请重新确认。';
      }
    }
    for (const [p, q] of sides) {
      if (q.ch.gold - t.gold[q.id] + t.gold[p.id] > MAX_GOLD) return q.name + ' 携带的金币已达上限。';
      // Free slots the receiver will have once its own offers leave the bag.
      const leaving = t.offers[q.id].filter((o) => this.findBySeq(q.ch, o.itemSeqId).item.count === o.count).length;
      const free = q.ch.inventory.filter((s) => !s).length + leaving;
      const need = t.offers[p.id].filter((o) => {
        const it = this.findBySeq(p.ch, o.itemSeqId).item;
        return !q.ch.inventory.some((s) => s && C.canStack(s, it));
      }).length;
      if (need > free) return q.name + ' 的背包空间不足。';
      let w = 0;
      for (const o of t.offers[p.id]) w += (this.findBySeq(p.ch, o.itemSeqId).item.weight || 0) * o.count;
      for (const o of t.offers[q.id]) w -= (this.findBySeq(q.ch, o.itemSeqId).item.weight || 0) * o.count;
      if (w > 0 && q.overWeight(w)) return q.name + ' 的负重不足。';
    }
    // Take both sides' items out first so freed slots can be reused.
    const moving = new Map([[a.id, []], [b.id, []]]);
    const changed = new Map([[a.id, new Set()], [b.id, new Set()]]);
    for (const [p] of sides) {
      for (const o of t.offers[p.id]) {
        const f = this.findBySeq(p.ch, o.itemSeqId);
        moving.get(p.id).push(this.takeItem(p.ch, f.index, o.count));
        changed.get(p.id).add(f.index);
      }
    }
    for (const [p, q] of sides) {
      for (const it of moving.get(p.id)) {
        const idx = q.addItem(this.adopt(q.ch, it));
        for (const i of idx || []) changed.get(q.id).add(i);
      }
      q.ch.gold += t.gold[p.id];
      p.ch.gold -= t.gold[p.id];
    }
    for (const p of [a, b]) p.commitItems({ inv: Array.from(changed.get(p.id)) });
    this.server.store.markDirty();
    return null;
  }

  // Removes `count` from a bag slot and returns the removed stack.
  takeItem(ch, index, count) {
    const it = ch.inventory[index];
    if (count >= it.count) { ch.inventory[index] = null; return it; }
    it.count -= count;
    const part = cloneItem(it);
    part.count = count;
    return part;
  }

  // Give the item a seqId that is unique in the receiver's bag.
  adopt(ch, it) {
    if (!it.seqId || ch.inventory.some((s) => s && s.seqId === it.seqId) || !String(it.seqId).startsWith(ch.id + ':')) {
      ch.itemSeq = (ch.itemSeq || 0) + 1;
      it.seqId = ch.id + ':' + ch.itemSeq;
    }
    return it;
  }

  // --- stalls ---
  publicStall(s) {
    const owner = this.server.playersById.get(s.ownerPlayerId);
    const ch = owner ? owner.ch : this.server.store.data.characters[s.ownerPlayerId];
    return {
      ownerPlayerId: s.ownerPlayerId,
      ownerName: s.ownerName,
      name: s.name,
      mapRef: s.mapRef,
      stallX: s.stallX,
      stallY: s.stallY,
      direction: s.direction,
      managementRadius: STALL_MANAGE_RADIUS,
      taxRadius: STALL_TAX_RADIUS,
      ownerOnline: !!owner,
      openedAt: s.openedAt,
      listings: s.listings.map((l) => {
        const f = ch ? this.findBySeq(ch, l.itemSeqId) : null;
        const item = f ? cloneItem(f.item) : null;
        if (item) item.count = l.count;
        return {
          listingId: l.listingId, inventoryIndex: f ? f.index : l.inventoryIndex, itemSeqId: l.itemSeqId,
          itemId: l.itemId, itemName: l.itemName, count: l.count, item, unitPrice: l.unitPrice, description: l.description,
        };
      }),
    };
  }

  stallChanged(s, closed = false) {
    const ownerId = s.ownerPlayerId;
    const view = closed ? null : this.publicStall(s);
    for (const q of this.server.playersById.values()) {
      if (!q.scene) continue;
      const here = q.scene.world === s.world && q.scene.mapRef === s.mapRef;
      if (here || q.id === ownerId) this.send(q, 'stall_state', { ownerPlayerId: ownerId, stall: view });
      if (view && q.viewingStall === ownerId) {
        const editable = q.id === ownerId && this.nearOwnStall(q, s);
        this.send(q, 'stall_detail', { stall: view, editable, refresh: true });
      }
    }
    this.server.store.markDirty();
  }

  nearOwnStall(p, s) {
    return p.scene && p.scene.world === s.world && p.scene.mapRef === s.mapRef && Math.hypot(p.x - s.stallX, p.y - s.stallY) <= STALL_MANAGE_RADIUS + 10;
  }

  toggleStall(p, d) {
    const s = this.stallOf(p.id);
    if (s) {
      if (!this.nearOwnStall(p, s)) return this.fail(p, '请回到自己的摊位附近 ' + STALL_MANAGE_RADIUS + ' 像素内，再收摊或修改商品');
      delete this.stalls[p.id];
      this.stallChanged(s, true);
      this.broadcastState(p);
      return this.fail(p, '已经收摊。');
    }
    if (!hasLicense(p.ch)) return this.fail(p, p.ch.businessLicense ? '摆摊执照已过期，请到市政厅续期。' : '请先到市政厅领取摆摊执照。');
    if (!p.alive) return this.fail(p, '现在不能摆摊。');
    if (this.tradeOf(p)) return this.fail(p, '交易中不能摆摊。');
    const sc = p.scene;
    for (const o of Object.values(this.stalls)) {
      if (o.world === sc.world && o.mapRef === sc.mapRef && Math.hypot(o.stallX - p.x, o.stallY - p.y) < STALL_MIN_GAP_PX) return this.fail(p, '这里离别人的摊位太近了，换个地方吧。');
    }
    const stall = {
      ownerPlayerId: p.id, ownerName: p.name, name: '个人商店', world: sc.world, mapRef: sc.mapRef,
      stallX: Math.round(p.x), stallY: Math.round(p.y), direction: ((int(d.direction) || 0) % 4 + 4) % 4,
      listings: [], openedAt: Date.now(),
    };
    this.stalls[p.id] = stall;
    p.path = []; p.markDirty();
    this.stallChanged(stall);
    this.broadcastState(p);
    p.viewingStall = p.id;
    this.send(p, 'stall_detail', { stall: this.publicStall(stall), editable: true });
    return undefined;
  }

  openStall(p, d) {
    const ownerId = String(d.ownerPlayerId || '');
    const s = this.stallOf(ownerId);
    if (!s) return this.fail(p, '这个摊位已经收摊了。');
    if (ownerId === p.id) {
      const editable = this.nearOwnStall(p, s);
      p.viewingStall = ownerId;
      return this.send(p, 'stall_detail', { stall: this.publicStall(s), editable });
    }
    if (!p.scene || p.scene.world !== s.world || p.scene.mapRef !== s.mapRef || Math.hypot(p.x - s.stallX, p.y - s.stallY) > STALL_BUY_RANGE_PX) {
      return this.fail(p, '离摊位太远了。');
    }
    p.viewingStall = ownerId;
    return this.send(p, 'stall_detail', { stall: this.publicStall(s), editable: false });
  }

  updateStall(p, d) {
    const s = this.stallOf(p.id);
    if (!s) return this.fail(p, '你还没有摆摊。');
    if (!this.nearOwnStall(p, s)) return this.fail(p, '请回到自己的摊位附近 ' + STALL_MANAGE_RADIUS + ' 像素内，再收摊或修改商品');
    const name = String(d.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20) || '个人商店';
    const src = Array.isArray(d.listings) ? d.listings : [];
    if (src.length > STALL_MAX_LISTINGS) return this.fail(p, '摊位最多摆放 ' + STALL_MAX_LISTINGS + ' 件商品。');
    const seen = new Set();
    const listings = [];
    for (const l of src) {
      const f = this.findBySeq(p.ch, String(l.itemSeqId || ''));
      if (!f) return this.fail(p, '物品已经不在背包中。');
      if (seen.has(f.item.seqId)) return this.fail(p, '同一件物品不能重复摆放。');
      if (f.item.bound || (f.item.ext && f.item.ext.bound)) return this.fail(p, f.item.name + ' 不能出售。');
      const count = int(l.count);
      if (!(count >= 1 && count <= f.item.count)) return this.fail(p, '摆摊数量必须是 1 到 ' + f.item.count + ' 之间的整数');
      const price = int(l.unitPrice);
      if (!(price >= 1 && price <= STALL_MAX_PRICE)) return this.fail(p, '单价必须是 1 到 ' + STALL_MAX_PRICE + ' 之间的整数。');
      seen.add(f.item.seqId);
      listings.push({
        listingId: f.index + ':' + f.item.seqId, inventoryIndex: f.index, itemSeqId: f.item.seqId, itemId: f.item.itemId,
        itemName: f.item.name || ('物品#' + f.item.itemId), count, unitPrice: price,
        description: String(l.description || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40),
      });
    }
    s.name = name;
    s.listings = listings;
    this.stallChanged(s);
    this.send(p, 'stall_detail', { stall: this.publicStall(s), editable: true });
    return this.fail(p, '摊位商品已更新。');
  }

  buyStall(p, d) {
    const ownerId = String(d.ownerPlayerId || '');
    const s = this.stallOf(ownerId);
    if (!s) return this.fail(p, '这个摊位已经收摊了。');
    if (ownerId === p.id) return this.fail(p, '不能购买自己摊位上的商品。');
    if (!p.scene || p.scene.world !== s.world || p.scene.mapRef !== s.mapRef || Math.hypot(p.x - s.stallX, p.y - s.stallY) > STALL_BUY_RANGE_PX) {
      return this.fail(p, '离摊位太远了。');
    }
    const listing = s.listings.find((l) => l.listingId === d.listingId);
    if (!listing) return this.fail(p, '该商品已经售出或下架。');
    const owner = this.server.playersById.get(ownerId);
    const ownerCh = owner ? owner.ch : this.server.store.data.characters[ownerId];
    const f = ownerCh ? this.findBySeq(ownerCh, listing.itemSeqId) : null;
    if (!f) {
      s.listings = s.listings.filter((l) => l !== listing);
      this.stallChanged(s);
      return this.fail(p, '该商品已经下架。');
    }
    const count = Math.min(Math.max(1, int(d.count) || 1), listing.count, f.item.count);
    const price = listing.unitPrice * count;
    if (p.ch.gold < price) return this.fail(p, '金币不足，需要 ' + price + ' 金币。');
    if (p.overWeight((f.item.weight || 0) * count)) return this.fail(p, '负重不足。');
    if (p.findFreeSlot() < 0 && !p.ch.inventory.some((it) => it && C.canStack(it, f.item))) return this.fail(p, '背包已满。');
    const it = this.takeItem(ownerCh, f.index, count);
    const changed = p.addItem(this.adopt(p.ch, it));
    const near = owner && owner.scene && owner.scene.world === s.world && owner.scene.mapRef === s.mapRef &&
      Math.hypot(owner.x - s.stallX, owner.y - s.stallY) <= STALL_TAX_RADIUS;
    const rate = near ? 1 : 20;
    const tax = Math.ceil(price * rate / 100);
    p.ch.gold -= price;
    ownerCh.gold = Math.min(MAX_GOLD, (ownerCh.gold || 0) + price - tax);
    listing.count -= count;
    if (listing.count <= 0 || !ownerCh.inventory[f.index]) s.listings = s.listings.filter((l) => l !== listing);
    p.commitItems({ inv: changed });
    if (owner) {
      owner.commitItems({ inv: [f.index] });
      owner.send(this.server.op.CHAT_MESSAGE, this.server.systemChat('你的摊位卖出了 ' + it.name + ' ×' + count + '，收入 ' + (price - tax) + ' 金币（税率 ' + rate + '%，税 ' + tax + '）。'));
    } else {
      ownerCh.revision = (ownerCh.revision || 0) + 1;
    }
    this.stallChanged(s);
    this.fail(p, '购买成功：' + it.name + ' ×' + count + '，花费 ' + price + ' 金币。');
    return undefined;
  }
}

module.exports = { Interaction };
