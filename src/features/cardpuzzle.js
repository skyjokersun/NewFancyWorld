'use strict';
// Card puzzle altars (拼卡圣坛, map pintu). Players drop card items onto the
// three altars; when one is complete every contributor may make one wish.
// Protocol: CARD_PUZZLE_QUERY/PLACE/REMOVE/WISH -> _STATE/_EVENT/_WISH_RESULT/_ERROR.
const crypto = require('crypto');
const cat = require('../game/catalog');
const C = require('../game/character');
const { cloneItem } = require('../game/player');

const MAP = 'pintu';
// x, y: altar centre on the pintu map (the client's CARD_PUZZLE_CLIENT_ALTARS).
const ALTARS = {
  heart: { displayName: '心型祭坛', card: '心型卡片', itemIdStart: 3900, cols: 4, rows: 4, x: 2139, y: -575, wishes: ['heart_hp', 'heart_mp', 'heart_skill'] },
  dragon: { displayName: '神龙祭坛', card: '神龙卡片', itemIdStart: 3920, cols: 4, rows: 5, x: 3347, y: -1361, wishes: ['dragon_attributes', 'dragon_skills', 'dragon_gender'] },
  angel: { displayName: '天使祭坛', card: '天使卡片', itemIdStart: 3940, cols: 5, rows: 4, x: 900, y: -1326, wishes: ['angel_carpet', 'angel_hp_regen', 'angel_defense'] },
};
// Floor tiles are diamonds 240 x 120 on a 120 x 60 grid (the client's getFloorPiecePosition).
const STEP_X = 120; const STEP_Y = 60;
function slotCentre(a, slot) {
  const col = slot % a.cols; const row = Math.floor(slot / a.cols);
  return { x: a.x + (col - row) * STEP_X - (a.cols - a.rows) * STEP_Y, y: a.y + STEP_Y / 2 * (a.cols + a.rows - 2) - (col + row) * STEP_Y };
}
// Standing on the card's tile or one of the tiles next to it.
function nearSlot(a, slot, x, y) {
  const c = slotCentre(a, slot);
  return Math.abs(x - c.x) / STEP_X + Math.abs(y - c.y) / STEP_Y <= 2.2;
}
const WISH_LABELS = {
  heart_hp: '最大生命值永久增加 200', heart_mp: '最大魔法值永久增加 300', heart_skill: '自由技能点永久增加 12',
  dragon_attributes: '半个月内拥有筋斗云', dragon_skills: '重新分配人物技能点', dragon_gender: '改变人物性别',
  angel_carpet: '一个月内拥有飞毯移动效果', angel_hp_regen: '一个月内生命恢复速度增加 30%', angel_defense: '一个月内防御力增加 30%',
};
const PERMANENT = new Set(['heart_hp', 'heart_mp', 'heart_skill']);
const COMBAT_SKILL_NAMES = { ranged_weapon: '远程武器', melee_weapon: '近身武器', mechanics: '机械', magic: '魔法', quick_heal: '快速治疗', judgement: '判断力' };
const ROUND_MS = 30 * 60 * 1000;        // an altar must be finished within 30 minutes of its first card
const CELEBRATE_MS = 8000;
const WISH_TTL_MS = 3 * 864e5;
const BLESSING_MS = 30 * 864e5;
const CLOUD_WISH_MS = 15 * 864e5;
const DROP_CHANCE = 0.004;             // per monster kill, level >= 5

function altarForItem(itemId) {
  for (const [altar, a] of Object.entries(ALTARS)) {
    const slot = itemId - a.itemIdStart;
    if (slot >= 0 && slot < a.cols * a.rows) return { altar, slot, a };
  }
  return null;
}

function installCards() {
  for (const [altar, a] of Object.entries(ALTARS)) {
    for (let slot = 0; slot < a.cols * a.rows; slot += 1) {
      const itemId = a.itemIdStart + slot;
      if (cat.templates.get(itemId)) continue;
      cat.templates.set(itemId, {
        itemId, name: a.card + ' P' + String(slot + 1).padStart(2, '0'),
        desc: '拼卡圣坛' + a.displayName + '的第 ' + (slot + 1) + ' 块卡片。在圣坛地图右键使用即可放上祭坛。',
        equipPos: 'none', tab: 'tools', weight: 1, durability: { cur: 1, max: 1 }, bonusAttrs: [],
        buyPrice: 0, sellPrice: 50, source: 'card_puzzle', cardAltar: altar,
      });
    }
  }
}

class CardPuzzle {
  register(server) {
    this.server = server;
    installCards();
    this.data = server.store.bucket('cardPuzzle');   // world -> {altars, completions}
    const op = server.op;
    server.on(op.CARD_PUZZLE_QUERY, server.requirePlayer((p) => this.sendState(p)));
    server.on(op.CARD_PUZZLE_PLACE, server.requirePlayer((p, d) => this.place(p, d || {})));
    server.on(op.CARD_PUZZLE_REMOVE, server.requirePlayer((p, d) => this.remove(p, d || {})));
    server.on(op.CARD_PUZZLE_WISH, server.requirePlayer((p, d) => this.wish(p, d || {})));
    server.events.on('playerMapChanging', (p, from, to) => {
      if (to && to.mapRef === MAP) setImmediate(() => { if (p.scene && p.scene.mapRef === MAP) this.sendState(p); });
    });
    server.events.on('playerEntered', (p) => this.onEntered(p));
    server.events.on('enemyKilled', (e) => this.maybeDrop(e.scene, e.monster, e.killer));
    server.events.on('tick', (now) => this.tick(now));
  }

  // --- state ---
  world(w) {
    if (!this.data[w]) {
      this.data[w] = { altars: {}, completions: {}, claimedPermanent: {} };
      for (const k of Object.keys(ALTARS)) this.data[w].altars[k] = { pieces: {}, phase: 'collecting', deadlineAt: null, celebrateUntil: 0 };
    }
    return this.data[w];
  }

  worldOf(p) { return p.scene ? p.scene.world : p.ch.world; }

  cp(ch) {
    if (!ch.cardPuzzle) ch.cardPuzzle = {};
    if (!Array.isArray(ch.cardPuzzle.claimedPermanentWishIds)) ch.cardPuzzle.claimedPermanentWishIds = [];
    return ch.cardPuzzle;
  }

  paramsFor(p) {
    const c = p.ch.cardPuzzle;
    if (!c) return undefined;
    return {
      claimedPermanentWishIds: (c.claimedPermanentWishIds || []).slice(),
      bonusMaxHp: c.bonusMaxHp || 0,
      bonusMaxStamina: c.bonusMaxStamina || 0,
      angelBlessing: c.angelBlessing && c.angelBlessing.expiresAt > Date.now()
        ? { wishId: c.angelBlessing.wishId, label: WISH_LABELS[c.angelBlessing.wishId], expiresAt: c.angelBlessing.expiresAt } : undefined,
    };
  }

  eligibility(p) {
    const w = this.world(this.worldOf(p));
    const now = Date.now();
    const c = Object.values(w.completions).filter((x) => x.expiresAt > now && x.players.includes(p.id) && !x.claimed.includes(p.id))
      .sort((a, b) => a.completedAt - b.completedAt)[0];
    if (!c) return null;
    const claimed = (w.claimedPermanent[p.id] || []);
    const out = {
      completionId: c.id, altar: c.altar, displayName: ALTARS[c.altar].displayName,
      options: ALTARS[c.altar].wishes.slice(),
      labels: Object.fromEntries(ALTARS[c.altar].wishes.map((id) => [id, WISH_LABELS[id]])),
      disabledWishIds: ALTARS[c.altar].wishes.filter((id) => PERMANENT.has(id) && claimed.includes(id)),
      expiresAt: c.expiresAt,
    };
    if (c.altar === 'dragon') {
      const levels = Object.fromEntries(C.COMBAT_SKILL_IDS.map((id) => [id, Math.max(1, p.ch.combatSkills[id] || 0)]));
      const spent = C.COMBAT_SKILL_IDS.reduce((n, id) => n + Math.max(0, (p.ch.combatSkills[id] || 0) - 1), 0);
      out.skillDraft = { budget: spent + (p.ch.skillPoints || 0), levels, names: Object.assign({}, COMBAT_SKILL_NAMES) };
    }
    return out;
  }

  altarView(w, altar) {
    const a = ALTARS[altar];
    const s = w.altars[altar];
    const v = {
      altar, displayName: a.displayName, cols: a.cols, rows: a.rows, phase: s.phase,
      pieces: Object.entries(s.pieces).map(([slot, pc]) => ({ slot: Number(slot), itemId: pc.itemId, ownerPlayerId: pc.ownerPlayerId, ownerName: pc.ownerName, placedAt: pc.placedAt })),
    };
    if (s.deadlineAt && s.phase !== 'celebrating') v.deadlineAt = s.deadlineAt;
    if (s.cooldownUntil > Date.now()) v.cooldownUntil = s.cooldownUntil;
    return v;
  }

  stateFor(p) {
    const w = this.world(this.worldOf(p));
    return {
      serverSeq: this.server.nextSeq(), serverTime: Date.now(), mapRef: MAP,
      altars: Object.keys(ALTARS).map((k) => this.altarView(w, k)),
      eligibility: this.eligibility(p),
    };
  }

  sendState(p) { p.send(this.server.op.CARD_PUZZLE_STATE, this.stateFor(p)); }

  broadcast(world) {
    for (const p of this.server.playersById.values()) if (p.scene && p.scene.mapRef === MAP && p.scene.world === world) this.sendState(p);
  }

  event(world, type, altar, message, extra = {}) {
    const ev = Object.assign({ eventId: crypto.randomUUID(), type, altar, message, serverSeq: 0 }, extra);
    for (const p of this.server.playersById.values()) {
      if (p.scene && p.scene.mapRef === MAP && p.scene.world === world) p.send(this.server.op.CARD_PUZZLE_EVENT, Object.assign({}, ev, { serverSeq: this.server.nextSeq() }));
    }
  }

  error(p, message, d = {}) { p.send(this.server.op.CARD_PUZZLE_ERROR, { message, clientSeq: d.clientSeq, serverSeq: this.server.nextSeq() }); }

  // --- actions ---
  place(p, d) {
    if (!p.scene || p.scene.mapRef !== MAP) return this.error(p, '请到拼卡圣坛放置卡片。', d);
    if (!p.alive) return this.error(p, '鬼魂无法放置卡片。', d);
    const idx = Math.trunc(Number(d.fromIndex));
    const it = p.ch.inventory[idx];
    const info = it && altarForItem(it.itemId);
    if (!info) return this.error(p, '这不是拼图卡片。', d);
    const world = this.worldOf(p);
    const s = this.world(world).altars[info.altar];
    if (s.phase === 'celebrating') return this.error(p, info.a.displayName + '正在庆祝，请稍后再放。', d);
    const label = info.a.displayName + '的 P' + String(info.slot + 1).padStart(2, '0');
    if (s.pieces[info.slot]) return this.error(p, label + ' 已经有人放好了。', d);
    const cfg = this.server.config;
    const now = Date.now();
    if (s.cooldownUntil > now) {
      return this.error(p, info.a.displayName + '刚拼完，正在冷却，还要 ' + Math.ceil((s.cooldownUntil - now) / 60000) + ' 分钟才能再拼。', d);
    }
    if (cfg.cardPuzzleNearSlot && !nearSlot(info.a, info.slot, p.x, p.y)) {
      return this.error(p, '请走到' + info.a.displayName + '上 P' + String(info.slot + 1).padStart(2, '0') + ' 对应的格子再放这张卡片。', d);
    }
    it.count -= 1;
    if (it.count <= 0) p.ch.inventory[idx] = null;
    p.commitItems({ inv: [idx] });
    s.pieces[info.slot] = { itemId: it.itemId, ownerPlayerId: p.id, ownerName: p.name, placedAt: now, item: Object.assign(cloneItem(it), { count: 1 }) };
    if (!s.deadlineAt) s.deadlineAt = now + ROUND_MS;
    this.server.store.markDirty();
    const total = info.a.cols * info.a.rows;
    const n = Object.keys(s.pieces).length;
    if (n >= total) this.complete(world, info.altar);
    else {
      this.event(world, 'placed', info.altar, p.name + ' 在' + info.a.displayName + '放上了一块卡片（' + n + '/' + total + '）。');
      this.broadcast(world);
    }
    return undefined;
  }

  remove(p, d) {
    if (!p.scene || p.scene.mapRef !== MAP) return this.error(p, '请到拼卡圣坛操作。', d);
    const a = ALTARS[d.altar];
    if (!a) return this.error(p, '祭坛不存在。', d);
    const world = this.worldOf(p);
    const s = this.world(world).altars[d.altar];
    const slot = Math.trunc(Number(d.slot));
    const pc = s.pieces[slot];
    if (!pc) return this.error(p, '这里没有卡片。', d);
    if (s.phase === 'celebrating') return this.error(p, '拼卡已经完成，不能取回。', d);
    if (pc.ownerPlayerId !== p.id) return this.error(p, '这是 ' + pc.ownerName + ' 放的卡片，不能取回。', d);
    const item = this.cardItem(p.ch, pc);
    const changed = p.addItem(item);
    if (!changed) return this.error(p, '背包已满，无法取回卡片。', d);
    delete s.pieces[slot];
    if (!Object.keys(s.pieces).length) s.deadlineAt = null;
    p.commitItems({ inv: changed });
    this.server.store.markDirty();
    this.event(world, 'removed', d.altar, p.name + ' 从' + a.displayName + '取回了一块卡片。');
    this.broadcast(world);
    return undefined;
  }

  cardItem(ch, pc) {
    const it = pc.item ? cloneItem(pc.item) : C.makeItem(ch, pc.itemId, 1);
    ch.itemSeq = (ch.itemSeq || 0) + 1;
    it.seqId = ch.id + ':' + ch.itemSeq;
    it.count = 1;
    return it;
  }

  complete(world, altar) {
    const w = this.world(world);
    const s = w.altars[altar];
    const now = Date.now();
    const players = Array.from(new Set(Object.values(s.pieces).map((pc) => pc.ownerPlayerId)));
    const id = 'cp_' + crypto.randomUUID();
    w.completions[id] = { id, altar, players, claimed: [], completedAt: now, expiresAt: now + WISH_TTL_MS };
    s.phase = 'celebrating';
    s.celebrateUntil = now + CELEBRATE_MS;
    s.deadlineAt = null;
    const cdMin = Number(this.server.config.cardPuzzleCooldownMin) || 0;
    s.cooldownUntil = cdMin > 0 ? s.celebrateUntil + cdMin * 60000 : 0;
    this.server.store.markDirty();
    const names = Array.from(new Set(Object.values(s.pieces).map((pc) => pc.ownerName))).join('、');
    this.event(world, 'completed', altar, ALTARS[altar].displayName + '拼接完成！拼接者：' + names + '。请点击祭坛实现愿望。', { completionId: id });
    for (const pid of players) {
      const q = this.server.playersById.get(pid);
      if (q && !(q.scene && q.scene.mapRef === MAP)) q.send(this.server.op.CHAT_MESSAGE, this.server.systemChat(ALTARS[altar].displayName + '拼接完成，回到拼卡圣坛点击祭坛即可实现愿望（3 天内有效）。'));
    }
    this.broadcast(world);
  }

  tick(now) {
    if (this.lastTick && now - this.lastTick < 1000) return;
    this.lastTick = now;
    for (const [world, w] of Object.entries(this.data)) {
      let changed = false;
      for (const [altar, s] of Object.entries(w.altars)) {
        if (s.phase === 'celebrating' && s.celebrateUntil <= now) {
          s.phase = 'collecting'; s.pieces = {}; s.celebrateUntil = 0; changed = true;
        } else if (s.phase === 'collecting' && s.deadlineAt && s.deadlineAt <= now) {
          this.returnPieces(s);
          s.deadlineAt = null; changed = true;
          this.event(world, 'expired', altar, ALTARS[altar].displayName + '未能在时限内拼完，卡片已退还给放置者。');
        }
      }
      for (const [id, c] of Object.entries(w.completions)) if (c.expiresAt <= now || c.claimed.length >= c.players.length) { delete w.completions[id]; changed = true; }
      if (changed) { this.server.store.markDirty(); this.broadcast(world); }
    }
  }

  // Unfinished altars hand cards back: into the bag, or held until next login.
  returnPieces(s) {
    for (const pc of Object.values(s.pieces)) {
      const q = this.server.playersById.get(pc.ownerPlayerId);
      const ch = q ? q.ch : this.server.store.data.characters[pc.ownerPlayerId];
      if (!ch) continue;
      const item = this.cardItem(ch, pc);
      if (q) {
        const changed = q.addItem(item);
        if (changed) { q.commitItems({ inv: changed }); continue; }
      }
      (ch.pendingCards = ch.pendingCards || []).push(item);
    }
    s.pieces = {};
  }

  onEntered(p) {
    const pending = p.ch.pendingCards;
    if (pending && pending.length) {
      const changed = [];
      while (pending.length) {
        const idx = p.addItem(pending[0]);
        if (!idx) break;
        changed.push(...idx); pending.shift();
      }
      if (changed.length) {
        p.commitItems({ inv: changed });
        p.send(this.server.op.CHAT_MESSAGE, this.server.systemChat('拼卡圣坛退还了你的卡片。'));
      }
    }
    if (p.scene && p.scene.mapRef === MAP) this.sendState(p);
  }

  maybeDrop(scene, m, killer) {
    // Fifteenth batch: the chances live on the admin page (features/batch15.js).
    if (this.server.features.batch15) return this.server.features.batch15.cardDrop(scene, m, killer);
    if (!killer || !m || !scene || (m.level || 1) < 5) return;
    if (Math.random() >= DROP_CHANCE * (this.server.config.dropRate || 1)) return;
    const altars = Object.values(ALTARS);
    const a = altars[Math.floor(Math.random() * altars.length)];
    const itemId = a.itemIdStart + Math.floor(Math.random() * a.cols * a.rows);
    const item = C.makeItem(killer.ch, itemId, 1);
    if (item) scene.dropGroundItem(item, m.x, m.y, { ownerPlayerId: killer.id, ownerEnemyId: m.id });
  }

  // --- wishes ---
  wish(p, d) {
    const fail = (message) => p.send(this.server.op.CARD_PUZZLE_WISH_RESULT, { success: false, message, completionId: d.completionId, clientSeq: d.clientSeq, serverSeq: this.server.nextSeq() });
    const w = this.world(this.worldOf(p));
    const c = w.completions[String(d.completionId || '')];
    if (!c || c.expiresAt <= Date.now() || !c.players.includes(p.id)) return fail('这个愿望已经失效了。');
    if (c.claimed.includes(p.id)) return fail('你已经实现过这次的愿望了。');
    const wishId = String(d.wishId || '');
    if (!ALTARS[c.altar].wishes.includes(wishId)) return fail('无效的愿望。');
    const cp = this.cp(p.ch);
    const claimed = w.claimedPermanent[p.id] || (w.claimedPermanent[p.id] = []);
    if (PERMANENT.has(wishId) && claimed.includes(wishId)) return fail('这个永久愿望在本世界只能实现一次。');
    let message = '愿望实现：' + WISH_LABELS[wishId] + '。';
    switch (wishId) {
      case 'heart_hp': cp.bonusMaxHp = (cp.bonusMaxHp || 0) + 200; break;
      case 'heart_mp': cp.bonusMaxStamina = (cp.bonusMaxStamina || 0) + 300; break;
      case 'heart_skill': { const n = C.addSkillPoints(p.ch, 12); if (n < 12) message += '技能点总数最多 ' + C.SKILL_POINT_TOTAL_CAP + ' 点，这次加了 ' + n + ' 点。'; break; }
      // The old attribute redistribution: core attributes are locked now, so this
      // wish gives 筋斗云 for half a month instead (added to any time left).
      case 'dragon_attributes': {
        const until = this.server.features.mounts.grantCloud(p, CLOUD_WISH_MS);
        message = '愿望实现：获得筋斗云半个月，有效期至 ' + new Date(until).toLocaleString('zh-CN', { hour12: false }) + '。';
        break;
      }
      case 'dragon_skills': {
        const want = d.skillLevels || {};
        const cur = p.ch.combatSkills;
        const budget = C.COMBAT_SKILL_IDS.reduce((n, id) => n + Math.max(0, (cur[id] || 0) - 1), 0) + (p.ch.skillPoints || 0);
        const next = {};
        let cost = 0;
        for (const id of C.COMBAT_SKILL_IDS) {
          const v = want[id] == null ? Math.max(1, cur[id] || 0) : Math.trunc(Number(want[id]));
          if (!(v >= 1 && v <= C.SKILL_LEVEL_CAP)) return fail('技能等级必须在 1 到 ' + C.SKILL_LEVEL_CAP + ' 之间。');
          next[id] = v === 1 && !(cur[id] > 0) ? 0 : v;
          cost += Math.max(0, v - 1);
        }
        if (cost > budget) return fail('技能点不够分配，最多 ' + budget + ' 点。');
        p.ch.combatSkills = next;
        p.ch.skillPoints = budget - cost;
        break;
      }
      case 'dragon_gender': {
        const g = p.ch.appearance.gender === 'man' ? 'women' : 'man';
        p.ch.appearance.gender = g;
        message = '愿望实现：你的性别变成了' + (g === 'man' ? '男' : '女') + '性。';
        break;
      }
      default: {   // angel blessings replace each other
        const expiresAt = Date.now() + BLESSING_MS;
        cp.angelBlessing = { wishId, grantedAt: Date.now(), expiresAt };
        message += '有效期至 ' + new Date(expiresAt).toLocaleDateString('zh-CN') + '。';
      }
    }
    if (PERMANENT.has(wishId)) { claimed.push(wishId); cp.claimedPermanentWishIds = Array.from(new Set(cp.claimedPermanentWishIds.concat(wishId))); }
    c.claimed.push(p.id);
    p.recompute(true);
    p.markDirty();
    p.commitItems({});
    this.server.store.markDirty();
    p.send(this.server.op.CARD_PUZZLE_WISH_RESULT, { success: true, message, wishId, completionId: c.id, clientSeq: d.clientSeq, serverSeq: this.server.nextSeq() });
    if (p.scene && p.scene.mapRef === MAP) this.sendState(p);
    return undefined;
  }
}

module.exports = { CardPuzzle, ALTARS, altarForItem, slotCentre };
