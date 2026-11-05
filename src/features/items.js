'use strict';
// Inventory, equipment, ground items, consumables, shops, combat skill points
// and appearance / profession changes.
const C = require('../game/character');
const log = require('../util/log');
const FOX = require('../game/foxfairy');
const cat = require('../game/catalog');
const { cloneItem } = require('../game/player');
const { CLOUD_CAPSULE_ID } = require('./mounts');

const E = {
  BAD_REQUEST: 1, BAD_INDEX: 2, NO_ITEM: 3, STACK_OVERFLOW: 4, SLOT_MISMATCH: 5, BAG_FULL: 6, TARGET_OCCUPIED: 7,
  REVISION_CONFLICT: 8, REQUIREMENT_NOT_MET: 9, DROP_NOT_FOUND: 10, PICKUP_OUT_OF_RANGE: 11, WEIGHT_LIMIT: 12,
  NOT_ENOUGH_GOLD: 13, SHOP_ITEM_UNAVAILABLE: 14, INVALID_SKILL_TARGET: 15, NOT_ENOUGH_SKILL_POINTS: 16,
  ITEM_NOT_USABLE: 17, PICKUP_NOT_OWNER: 18, SKILL_LEVEL_CAP_REACHED: 19,
};
const PICKUP_RANGE_PX = 140;
const SPECIAL_OFFER_MS = 10 * 60 * 1000;
const SPECIAL_OFFERS = 5;   // random affix offers appended to the "other" tab
const FIREWORK_MS = 60 * 1000;
const RESET_EXP_POTION = 3473;
const LOLLIPOPS = new Set([90, 91, 92, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229]);
// 狐仙 LV1-4, all summoned with the red 狐狸皮 (2586): 100 / 200 / 300 / 400 furs.
const FOX_FUR = 2586;
const FOX_TIERS = [
  { tier: 1, level: 30, title: '狐仙LV1', hp: 30000, damage: 160, defense: 60, cost: 100 },
  { tier: 2, level: 60, title: '狐仙LV2', hp: 90000, damage: 380, defense: 150, cost: 200 },
  { tier: 3, level: 100, title: '狐仙LV3', hp: 200000, damage: 800, defense: 400, cost: 300 },
  { tier: 4, level: 150, title: '狐仙LV4', hp: 500000, damage: 1500, defense: 900, cost: 400 },
];
// The LV2-LV4 furs of earlier versions are gone: any left in bags or bank coffers are removed.
const OLD_FOX_FURS = new Set([900002, 900003, 900004]);

function idx(v) { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : -1; }

class Items {
  // Runs once var/state.json is loaded: the old LV2-LV4 fox furs are destroyed (bags and
  // bank coffers) and the red furs get the new name and description.
  onStart() {
    const store = this.server.store;
    const fur = cat.getTemplate(FOX_FUR);
    let removed = 0;
    const fix = (list) => {
      if (!Array.isArray(list)) return;
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        if (!it) continue;
        if (OLD_FOX_FURS.has(it.itemId)) { removed += it.count || 1; list[i] = null; }
        else if (it.itemId === FOX_FUR && it.name !== fur.name) { it.name = fur.name; it.desc = fur.desc; }
      }
    };
    for (const ch of Object.values(store.data.characters || {})) fix(ch.inventory);
    for (const c of Object.values(store.bucket('bankCoffers'))) fix(c && c.slots);
    if (removed) { store.markDirty(); log.info('removed ' + removed + ' old LV2-LV4 fox furs'); }
  }

  register(server) {
    this.server = server;
    const op = server.op;
    const rp = (fn) => server.requirePlayer(fn);
    server.on(op.ITEM_QUERY, rp((p) => p.sendItemState()));
    // Eleventh batch: gear that no longer fits comes off at login, or once the bag has room.
    server.events.on('playerEntered', (p) => { if (this.hasUnfitGear(p)) this.returnUnfitGear(p, ''); });
    this.lastUnfitSweep = 0;
    server.events.on('tick', (now) => { if (now - this.lastUnfitSweep >= 2000) { this.lastUnfitSweep = now; this.sweepUnfit(); } });
    server.on(op.ITEM_MOVE, rp((p, d) => this.move(p, d)));
    server.on(op.ITEM_EQUIP, rp((p, d) => this.equip(p, idx(d.fromIndex), d.slot, 'equip')));
    server.on(op.ITEM_EQUIP_QUICK, rp((p, d) => this.equipQuick(p, d)));
    server.on(op.ITEM_UNEQUIP, rp((p, d) => this.unequip(p, d)));
    server.on(op.ITEM_DROP, rp((p, d) => this.drop(p, d)));
    server.on(op.ITEM_PICKUP, rp((p, d) => this.pickup(p, d)));
    server.on(op.ITEM_USE, rp((p, d) => this.use(p, d)));
    server.on(op.SHOP_QUERY, rp((p, d) => this.shopQuery(p, d.kind)));
    server.on(op.SHOP_BUY, rp((p, d) => this.shopBuy(p, d)));
    server.on(op.SHOP_SELL, rp((p, d) => this.shopSell(p, d)));
    server.on(op.COMBAT_SKILL_UPGRADE, rp((p, d) => this.skillUpgrade(p, d)));
    server.on(op.PLAYER_APPEARANCE_UPDATE, rp((p, d) => this.appearance(p, d)));
  }

  err(p, opName, code, message) {
    p.send(this.server.op.ITEM_OP_ERROR, { op: opName, code, message: message || '', serverSeq: this.server.nextSeq() });
  }

  meetsRequirement(p, item) { return C.meetsRequirement(p.ch, item); }

  // Eleventh batch: while auto hunting, gear and manual item use are locked (the
  // auto-potion of features/autohunt.js sets p.autoPotionUse for its own use).
  autoLocked(p, opName, what) {
    if (!p.autoHunt || p.autoPotionUse) return false;
    this.err(p, opName, E.ITEM_NOT_USABLE, '自动打怪中不能' + what + '，请先关闭自动打怪。');
    return true;
  }

  move(p, d) {
    const from = idx(d.fromIndex), to = idx(d.toIndex);
    const inv = p.inventory;
    if (from < 0 || from >= inv.length || to < 0 || to >= inv.length) return this.err(p, 'move', E.BAD_INDEX);
    if (!inv[from]) return this.err(p, 'move', E.NO_ITEM);
    if (from === to) return undefined;
    if (inv[to] && C.canStack(inv[from], inv[to])) { inv[to].count += inv[from].count; inv[from] = null; }
    else { const t = inv[to]; inv[to] = inv[from]; inv[from] = t; }
    p.commitItems({ inv: [from, to], params: false });
    return undefined;
  }

  equip(p, from, slot, opName) {
    if (this.autoLocked(p, opName, '更换装备')) return undefined;
    const inv = p.inventory;
    if (from < 0 || from >= inv.length) return this.err(p, opName, E.BAD_INDEX);
    const it = inv[from];
    if (!it) return this.err(p, opName, E.NO_ITEM);
    const t = cat.getTemplate(it.itemId);
    const want = cat.slotForTemplate(t);
    if (!want || (slot && slot !== want)) return this.err(p, opName, E.SLOT_MISMATCH);
    if (!this.meetsRequirement(p, it)) return this.err(p, opName, E.REQUIREMENT_NOT_MET);
    // V15.2 (Q20): a broken piece cannot be worn until it is repaired.
    const broken = this.server.features.batch152 && this.server.features.batch152.brokenText(it);
    if (broken) return this.err(p, opName, E.REQUIREMENT_NOT_MET, broken);
    const prev = p.equipment[want];
    p.equipment[want] = it;
    inv[from] = prev || null;
    p.commitItems({ inv: [from], equip: [want] });
    return undefined;
  }

  equipQuick(p, d) {
    const from = idx(d.fromIndex);
    const it = p.inventory[from];
    if (!it) return this.err(p, 'equip_quick', E.NO_ITEM);
    const t = cat.getTemplate(it.itemId);
    if (!cat.slotForTemplate(t)) {
      // Not equipment: right-click falls back to use.
      return this.use(p, d);
    }
    return this.equip(p, from, null, 'equip_quick');
  }

  unequip(p, d) {
    if (this.autoLocked(p, 'unequip', '卸下装备')) return undefined;
    const slot = String(d.slot || '');
    if (!cat.EQUIP_SLOTS.includes(slot)) return this.err(p, 'unequip', E.BAD_REQUEST);
    const it = p.equipment[slot];
    if (!it) return this.err(p, 'unequip', E.NO_ITEM);
    let to = idx(d.toIndex);
    if (to < 0 || to >= p.inventory.length || p.inventory[to]) to = p.findFreeSlot();
    if (to < 0) return this.err(p, 'unequip', E.BAG_FULL);
    p.inventory[to] = it;
    p.equipment[slot] = null;
    p.commitItems({ inv: [to], equip: [slot] });
    return undefined;
  }

  drop(p, d) {
    const sc = p.scene;
    if (d.fromKind === 'gold') {
      const amount = Math.trunc(Number(d.amount));
      if (!(amount > 0)) return this.err(p, 'drop', E.BAD_REQUEST);
      if (p.ch.gold < amount) return this.err(p, 'drop', E.NOT_ENOUGH_GOLD);
      p.ch.gold -= amount;
      sc.dropGroundItem(this.server.combat.goldItem(amount), p.x, p.y, { source: 'player_drop', ownerPlayerId: p.id });
      p.commitItems({});
      return undefined;
    }
    if (d.fromKind === 'equip') {
      if (this.autoLocked(p, 'drop', '卸下装备')) return undefined;
      const slot = String(d.fromSlot || '');
      const it = p.equipment[slot];
      if (!it) return this.err(p, 'drop', E.NO_ITEM);
      p.equipment[slot] = null;
      sc.dropGroundItem(it, p.x, p.y, { source: 'player_drop', ownerPlayerId: p.id });
      p.commitItems({ equip: [slot] });
      return undefined;
    }
    const from = idx(d.fromIndex);
    const it = p.inventory[from];
    if (!it) return this.err(p, 'drop', E.NO_ITEM);
    let count = d.count == null ? it.count : Math.trunc(Number(d.count));
    if (!(count > 0)) return this.err(p, 'drop', E.BAD_REQUEST);
    count = Math.min(count, it.count);
    let dropped;
    if (count >= it.count) { dropped = it; p.inventory[from] = null; }
    else { it.count -= count; dropped = Object.assign(cloneItem(it), { count, seqId: it.seqId + ':s' + Date.now() }); }
    sc.dropGroundItem(dropped, p.x, p.y, { source: 'player_drop', ownerPlayerId: p.id });
    p.commitItems({ inv: [from] });
    return undefined;
  }

  pickup(p, d) {
    const sc = p.scene;
    const g = sc.groundItems.get(String(d.dropId || ''));
    if (!g) return this.err(p, 'pickup', E.DROP_NOT_FOUND);
    if (!p.alive) return this.err(p, 'pickup', E.BAD_REQUEST, '鬼魂无法拾取');
    if (Math.hypot(g.x - p.x, g.y - p.y) > PICKUP_RANGE_PX) return this.err(p, 'pickup', E.PICKUP_OUT_OF_RANGE, '距离太远');
    if (g.ownerExclusiveUntil && Date.now() < g.ownerExclusiveUntil && g.ownerPlayerId && g.ownerPlayerId !== p.id) {
      const party = this.server.features.party;
      if (!party || !party.sameParty(p.id, g.ownerPlayerId)) return this.err(p, 'pickup', E.PICKUP_NOT_OWNER, '这是别人的战利品');
    }
    const it = g.item;
    if (it.ext && it.ext.pickupType === 'gold') {
      p.ch.gold += it.ext.gold || it.count || 0;
      sc.removeGroundItem(g.dropId);
      p.commitItems({});
      return undefined;
    }
    if (p.overWeight((it.weight || 0) * (it.count || 1))) return this.err(p, 'pickup', E.WEIGHT_LIMIT);
    const changed = p.addItem(it);
    if (!changed) return this.err(p, 'pickup', E.BAG_FULL);
    sc.removeGroundItem(g.dropId);
    p.commitItems({ inv: changed });
    return undefined;
  }

  onUse(itemId, fn) { if (!this.useHooks) this.useHooks = new Map(); this.useHooks.set(itemId, fn); }

  consume(p, from, n = 1) {
    const it = p.inventory[from];
    it.count -= n;
    if (it.count <= 0) p.inventory[from] = null;
  }

  use(p, d) {
    const from = idx(d.fromIndex);
    const it = p.inventory[from];
    const op = this.server.op;
    if (!it) return this.err(p, 'use', E.NO_ITEM);
    if (this.autoLocked(p, 'use', '手动使用物品')) return undefined;
    if (!p.alive) return this.err(p, 'use', E.ITEM_NOT_USABLE, '鬼魂无法使用物品');
    const id = it.itemId;
    // Twelfth batch: other features handle their own items (wedding invitation 2606).
    const hook = this.useHooks && this.useHooks.get(id);
    if (hook) return hook(p, from, it);
    // Fox fur: summon a fox apparition (LV1-4 take 100-400 furs).
    if (id === FOX_FUR) return this.summonFox(p, from, d);
    if (cat.blindBoxes.has(id)) return this.openBlindBox(p, from);
    const book = cat.skillBooks.get(id);
    if (book) {
      if (p.ch.profession !== book.profession || (book.customProfession && p.ch.customProfession !== book.customProfession)) return this.err(p, 'use', E.REQUIREMENT_NOT_MET, '职业不符，无法学习');
      if (p.ch.professionSkills[book.skillId]) return this.err(p, 'use', E.ITEM_NOT_USABLE, '已经学会该技能');
      if (!this.meetsRequirement(p, cat.getTemplate(id))) return this.err(p, 'use', E.REQUIREMENT_NOT_MET, '职业等级不足，无法学习');
      this.server.features.skills.learn(p, book.skillId);
      this.consume(p, from);
      p.commitItems({ inv: [from], dropMessage: '学会技能：' + it.name });
      return undefined;
    }
    // 2623-2633: the original 鞭炮 / 烟花 (twelfth batch) burn like the 烟花 above.
    if (id === cat.CUSTOM.FIREWORK || (id >= 2623 && id <= 2633)) {
      this.consume(p, from);
      const now = Date.now();
      p.scene.addPlaceable({
        instanceId: 'fw' + now.toString(36) + Math.random().toString(36).slice(2, 6), effectType: 'firework',
        itemId: id, x: Math.round(p.x), y: Math.round(p.y), z: 0, seed: Math.floor(Math.random() * 100000),
        placedAt: now, expireAt: now + FIREWORK_MS, ownerPlayerId: p.id,
      });
      p.commitItems({ inv: [from] });
      return undefined;
    }
    // 一日丧命散.含笑半步颠 (小酒窝): combat exp earned in this level back to 0; the level stays.
    if (id === RESET_EXP_POTION) {
      const lvl = C.combatLevel(p.ch);
      const start = C.cumulativeExpForLevel(lvl);
      const lost = Math.max(0, (p.ch.combatExp || 0) - start);
      this.consume(p, from);
      p.ch.combatExp = start;
      p.recompute(true);
      p.markDirty();
      this.server.store.markDirty();
      p.commitItems({ inv: [from], dropMessage: '本级战斗经验已清零（失去 ' + lost + ' 点），战斗等级仍是 ' + lvl + ' 级。' });
      return undefined;
    }
    // 筋斗云胶囊: 1 hour of 筋斗云 (features/mounts.js).
    if (id === CLOUD_CAPSULE_ID) {
      this.consume(p, from);
      const msg = this.server.features.mounts.useCapsule(p);
      p.commitItems({ inv: [from], dropMessage: msg });
      return undefined;
    }
    const t = cat.getTemplate(id);
    const restoreHp = (t && t.bonusAttrs || []).filter((a) => a.key === 'restoreHp').reduce((s, a) => s + a.value, 0);
    const restoreSt = (t && t.bonusAttrs || []).filter((a) => a.key === 'restoreStamina').reduce((s, a) => s + a.value, 0);
    if (id === cat.catalogs.fireflyItemId || (!restoreHp && !restoreSt && id === 2619)) {
      this.consume(p, from);
      p.scene.broadcast(op.ITEM_USE_EFFECT, { playerId: p.id, itemId: id, serverSeq: this.server.nextSeq() });
      p.commitItems({ inv: [from] });
      return undefined;
    }
    if (restoreHp || restoreSt || cat.consumableIds.has(id)) {
      p.ch.hp = Math.min(p.stats.maxHp, p.ch.hp + restoreHp);
      p.ch.stamina = Math.min(p.stats.maxStamina, p.ch.stamina + restoreSt);
      if (LOLLIPOPS.has(id)) p.lollipopGlow = id;
      this.consume(p, from);
      p.markDirty();
      p.scene.broadcast(op.ITEM_USE_EFFECT, { playerId: p.id, itemId: id, serverSeq: this.server.nextSeq() });
      p.commitItems({ inv: [from] });
      return undefined;
    }
    return this.err(p, 'use', E.ITEM_NOT_USABLE);
  }

  // Blind box contents: the admin page's list (store bucket blindBoxPools,
  // box id -> [{itemId, weight}]) or, by default, every shop item of the box's
  // slot and profession with weight 1.
  defaultBlindBoxPool(box) {
    const prof = /^(弓箭手|猎人)/.test(box.name) ? 'archer' : /^(魔法师|法师)/.test(box.name) ? 'mage' : box.name.startsWith('枪手') ? 'gunner'
      : box.name.startsWith('小孩') ? 'child' : box.name.startsWith('战士') ? 'warrior' : null;
    const positions = box.equipPos === 'bracelet' && !prof ? ['bracelet', 'necklace', 'ring'] : [box.equipPos];
    return cat.catalogs.shop.filter((s) => positions.includes(s.equipPos) && !cat.BLOCKED_ITEMS.has(s.itemId) &&
      (!prof || !s.requirement || (s.requirement.professionLevels || []).some((e) => e.profession === prof)))
      .map((s) => ({ itemId: s.itemId, weight: 1 }));
  }

  blindBoxPool(boxId) {
    const custom = this.server.store.bucket('blindBoxPools')[boxId];
    if (Array.isArray(custom)) return { custom: true, pool: custom.filter((e) => cat.getTemplate(e.itemId) && e.weight > 0 && !cat.BLOCKED_ITEMS.has(e.itemId)) };
    return { custom: false, pool: this.defaultBlindBoxPool(cat.blindBoxes.get(Number(boxId))) };
  }

  // pool null restores the default list.
  setBlindBoxPool(boxId, pool) {
    const box = cat.blindBoxes.get(Number(boxId));
    if (!box) throw new Error('没有这个盲盒');
    const pools = this.server.store.bucket('blindBoxPools');
    if (pool == null) delete pools[box.itemId];
    else {
      if (!Array.isArray(pool) || !pool.length) throw new Error('盲盒里至少要有一件物品');
      const seen = new Set(); const clean = [];
      for (const e of pool) {
        const itemId = Number(e && e.itemId); const weight = Number(e && e.weight);
        if (!cat.getTemplate(itemId)) throw new Error('没有物品 ' + (e && e.itemId));
        if (cat.blindBoxes.has(itemId)) throw new Error('盲盒里不能放盲盒');
        if (!(weight > 0 && weight <= 100000)) throw new Error(cat.getTemplate(itemId).name + ' 的权重须在 0–100000 之间且大于 0');
        if (seen.has(itemId)) continue;
        seen.add(itemId); clean.push({ itemId, weight });
      }
      pools[box.itemId] = clean;
    }
    this.server.store.markDirty();
  }

  openBlindBox(p, from) {
    const stack = p.inventory[from];
    const box = cat.blindBoxes.get(stack.itemId);
    const { pool } = this.blindBoxPool(box.itemId);
    if (!pool.length) return this.err(p, 'use', E.ITEM_NOT_USABLE, '这个盲盒是空的');
    // Opening one box of a stack needs a free slot for what comes out.
    const to = stack.count > 1 ? p.findFreeSlot() : from;
    if (to < 0) return this.err(p, 'use', E.BAG_FULL, '背包已满，先空出一格再开盲盒');
    let r = Math.random() * pool.reduce((n, e) => n + e.weight, 0);
    let pick = pool[pool.length - 1];
    for (const e of pool) { r -= e.weight; if (r < 0) { pick = e; break; } }
    const item = C.makeItem(p.ch, pick.itemId, 1);
    if (!item) return this.err(p, 'use', E.ITEM_NOT_USABLE);
    const roll = Math.random();
    const boost = roll < 0.05 ? 12 : roll < 0.15 ? 6 : roll < 0.35 ? 3 : 0;
    if (boost) {
      item.bonusAttrs = item.bonusAttrs.map((a) => {
        const v = Math.max(1, Math.round(a.value * (1 + boost / 100)));
        return Object.assign({}, a, { value: v, display: a.display.replace(/[+-]?\d+(\.\d+)?/, '+' + v) });
      });
      item.name = item.name + '（强化' + boost + '%）';
    }
    if (to === from) p.inventory[from] = item;
    else { stack.count -= 1; p.inventory[to] = item; }
    p.commitItems({ inv: [from, to], dropMessage: '盲盒开出了：' + item.name });
    return undefined;
  }

  summonFox(p, from, d) {
    const id = FOX_FUR;
    const def = FOX_TIERS[Math.max(1, Math.min(4, Math.trunc(Number(d.summonTier)) || 1)) - 1];
    if (p.countItem(id) < def.cost) return this.err(p, 'use', E.ITEM_NOT_USABLE, '召唤' + def.title + '需要' + def.cost + '张狐狸皮，你只有' + p.countItem(id) + '张');
    const sc = p.scene;
    // Towns, post stations and other maps without wild monsters keep their spawn table empty.
    if (!this.server.isHuntingMap(sc.mapRef)) return this.err(p, 'use', E.ITEM_NOT_USABLE, '城镇里不能召唤狐仙，请到猎场召唤');
    const changed = p.removeItemCount(id, def.cost);
    const now = Date.now();
    // V15.2 (Q32): the original 狐仙 1501-1504 (stats, magic, resists, drops, colours),
    // with the admin 怪物 page's edits laid over it; older servers keep the batch 6 fox.
    const b152 = this.server.features.batch152;
    let mdef;
    if (b152) mdef = b152.withEdits(require('./batch152').foxDef(def.tier));
    else mdef = { name: def.title, model: 'fox3', level: def.level, hp: def.hp, maxHp: def.hp, damage: def.damage, defense: def.defense,
      breakPower: Math.round(def.damage / 4), attackRange: 70, detectionRange: 350, moveSpeed: 140, baseExp: def.level * 20, drops: FOX.foxDrops(def.tier, FOX_FUR) };
    const m = sc.addMonster(mdef, { x: p.x + 60, y: p.y }, null);
    FOX.makeFoxFairy(m, def.tier, b152 ? [] : undefined, b152 ? { magic: mdef.attackType2 } : {});
    m.summonedBy = p.id;
    m.summonAppearAt = now + 5000; m.summonSolidAt = now + 10000;
    m.state = 'idle'; m.nextWanderAt = m.summonSolidAt + 1000;
    const origSync = m.sync.bind(m);
    m.sync = () => Object.assign(origSync(), { summonAppearAt: m.summonAppearAt, summonSolidAt: m.summonSolidAt, summonerId: p.id });
    const origTick = m.tick.bind(m);
    m.tick = (t, dt) => { if (t >= m.summonSolidAt) origTick(t, dt); };
    m.markDirty();
    p.ch.revision += 1;
    p.send(this.server.op.ITEM_DELTA, {
      revision: p.ch.revision, serverSeq: this.server.nextSeq(),
      changes: changed.map((i) => ({ type: 'set_inventory', index: i, item: cloneItem(p.inventory[i]) })).concat([{ type: 'set_params', params: p.params() }]),
      dropMessage: def.title + '即将出现……' + (m.foxMagic ? '它会放' + m.foxMagic.name + '。' : '它习得了' + m.foxSkills.map((k) => k.name).join('、') + '。'),
      summonResult: { requestId: d.summonRequestId, itemId: id, enemyId: m.id, appearAt: m.summonAppearAt, solidAt: m.summonSolidAt },
    });
    return undefined;
  }

  // ---------- shops ----------
  shopTabs(p, kind) {
    const crafted = this.server.features.crafting && this.server.features.crafting.materialShop(p, kind);
    if (crafted) return crafted.tabs;
    const tabs = { medicine: [], weapon: [], armor: [], accessory: [], book: [], misc: [] };
    const prof = p.ch.profession;
    const fits = (s) => this.shopFits(p, s);
    // The merchant's goods (admin page list or default), then what this player may see.
    // Its special list is sold to everyone.
    const shops = this.server.features.shops;
    const list = shops.itemsFor(p, kind) || shops.defaultItems(kind);
    const special = shops.specialFor(p, kind);
    for (const id of list) {
      const box = cat.blindBoxes.get(id);
      const t = cat.getTemplate(id);
      if (!t) continue;
      const tab = tabs[box ? box.tab : t.tab] ? (box ? box.tab : t.tab) : 'misc';
      if (kind !== 'qiaoqiao' && !special.has(id)) {
        if ((tab === 'weapon' || tab === 'armor' || tab === 'accessory') && !fits(t)) continue;
        if (tab === 'book') { const b = cat.skillBooks.get(id); if (b && (b.profession !== prof || (b.customProfession && b.customProfession !== p.ch.customProfession))) continue; if (!this.levelFits(p, t)) continue; }
      }
      tabs[tab].push(id);
    }
    // The shop window pages through 63 items a tab (frontend patch 97), so every item is sent.
    return tabs;
  }

  // Equipment this player's profession can use, at most shopLevelAhead levels above their
  // profession level (tenth batch).
  shopFits(p, t) {
    const prof = p.ch.profession;
    const req = (t.requirement && t.requirement.professionLevels) || [];
    if (req.length && !req.some((e) => e.profession === prof || e.profession === 'any')) return false;
    return this.levelFits(p, t);
  }

  levelFits(p, t) {
    const cfg = this.server.config;
    if (cfg.shopLevelFilter === false) return true;
    const prof = p.ch.profession;
    const e = ((t.requirement && t.requirement.professionLevels) || []).find((x) => x.profession === prof) ||
      ((t.requirement && t.requirement.professionLevels) || []).find((x) => x.profession === 'any');
    if (!e || !e.minLevel) return true;
    const ahead = Math.max(0, Math.round(Number(cfg.shopLevelAhead) || 0));
    return e.minLevel <= C.professionLevel(p.ch) + ahead;
  }

  specialOffers(p) {
    const now = Date.now();
    const st = p.interactions.specialShop;
    const plvl = C.professionLevel(p.ch);
    if (st && st.refreshAt > now && st.profession === p.ch.profession && st.level === plvl) return st;
    const prof = p.ch.profession;
    const { NOT_DEFAULT } = require('./shops');
    const pool = cat.catalogs.shop.filter((s) => cat.EQUIP_POS_TO_SLOT[s.equipPos] && s.buyPrice > 0 && !NOT_DEFAULT.has(s.itemId) && !cat.BLOCKED_ITEMS.has(s.itemId) &&
      (!s.requirement || (s.requirement.professionLevels || []).some((e) => e.profession === prof)) && this.levelFits(p, s));
    const offers = [];
    for (let i = 0; i < SPECIAL_OFFERS && pool.length; i += 1) {
      const t = pool[Math.floor(Math.random() * pool.length)];
      const item = C.makeItem(p.ch, t.itemId, 1);
      // Twelfth batch: a real prefix and/or suffix from the item table, coloured like drops.
      require('../game/affixes').randomShopAffix(item, cat.EQUIP_POS_TO_SLOT[t.equipPos] === 'weapon', require('./crafting/data').itemLevel(t));
      const unitPrice = Math.max(10, (t.sellPrice || Math.floor(t.buyPrice / 2)) * 10);
      offers.push({ offerId: 'o' + now.toString(36) + i, type: 'affix', unitPrice, item });
    }
    const state = { profession: prof, level: plvl, refreshAt: now + SPECIAL_OFFER_MS, offers };
    p.interactions.specialShop = state;
    return state;
  }

  shopState(p, kind) {
    const k = kind === 'tools' || kind === 'qiaoqiao' ? kind : 'arm';
    const s = { kind: k, profession: p.ch.profession, tabs: this.shopTabs(p, k), prices: this.server.features.shops.prices(), serverSeq: this.server.nextSeq() };
    if (k === 'arm') { const sp = this.specialOffers(p); s.specialOffers = sp.offers; s.specialRefreshAt = sp.refreshAt; }
    const crafted = this.server.features.crafting && this.server.features.crafting.materialShop(p, k);
    if (crafted) { s.catalogId = crafted.catalogId; s.items = crafted.items; }
    return s;
  }

  shopQuery(p, kind) { p.send(this.server.op.SHOP_STATE, this.shopState(p, kind)); }

  shopBuy(p, d) {
    const count = Math.max(1, Math.min(999, Math.trunc(Number(d.count) || 1)));
    const kind = d.kind === 'tools' || d.kind === 'qiaoqiao' ? d.kind : 'arm';
    let item; let price;
    if (d.offerId) {
      const sp = p.interactions.specialShop;
      const offer = sp && sp.offers.find((o) => o.offerId === d.offerId);
      if (!offer) return this.err(p, 'shop_buy', E.SHOP_ITEM_UNAVAILABLE, '该商品已下架');
      item = cloneItem(offer.item); item.seqId = p.id + ':' + (++p.ch.itemSeq); price = offer.unitPrice;
      if (p.ch.gold < price) return this.err(p, 'shop_buy', E.NOT_ENOUGH_GOLD);
      const changed = p.addItem(item);
      if (!changed) return this.err(p, 'shop_buy', E.BAG_FULL);
      sp.offers = sp.offers.filter((o) => o !== offer);
      p.ch.gold -= price;
      p.commitItems({ inv: changed });
      this.shopQuery(p, kind);
      return undefined;
    }
    const itemId = Math.trunc(Number(d.itemId));
    const tabs = this.shopTabs(p, kind);
    if (!Object.values(tabs).some((l) => l.includes(itemId))) return this.err(p, 'shop_buy', E.SHOP_ITEM_UNAVAILABLE);
    const t = cat.getTemplate(itemId);
    if (!t) return this.err(p, 'shop_buy', E.SHOP_ITEM_UNAVAILABLE);
    const n = cat.slotForTemplate(t) ? 1 : count;
    price = this.server.features.shops.price(itemId) * n;
    if (p.ch.gold < price) return this.err(p, 'shop_buy', E.NOT_ENOUGH_GOLD);
    if (p.overWeight((t.weight || 0) * n)) return this.err(p, 'shop_buy', E.WEIGHT_LIMIT);
    item = C.makeItem(p.ch, itemId, n);
    const changed = p.addItem(item);
    if (!changed) return this.err(p, 'shop_buy', E.BAG_FULL);
    p.ch.gold -= price;
    p.commitItems({ inv: changed });
    return undefined;
  }

  shopSell(p, d) {
    const from = idx(d.fromIndex);
    const it = p.inventory[from];
    if (!it) return this.err(p, 'shop_sell', E.NO_ITEM);
    const count = Math.max(1, Math.min(it.count, Math.trunc(Number(d.count) || it.count)));
    const unit = it.sellPrice || 0;
    p.ch.gold += unit * count;
    this.consume(p, from, count);
    p.commitItems({ inv: [from] });
    return undefined;
  }

  // ---------- combat skills ----------
  skillUpgrade(p, d) {
    const id = String(d.skillId || '');
    if (!C.COMBAT_SKILL_IDS.includes(id)) return this.err(p, 'skill_upgrade', E.INVALID_SKILL_TARGET);
    if ((p.ch.skillPoints || 0) <= 0) return this.err(p, 'skill_upgrade', E.NOT_ENOUGH_SKILL_POINTS);
    const cur = p.ch.combatSkills[id] || 0;
    if (cur >= C.SKILL_LEVEL_CAP) return this.err(p, 'skill_upgrade', E.SKILL_LEVEL_CAP_REACHED);
    // V15.2: Shift-click adds 10 points, Ctrl-click 25 (d.count, frontend patch 107), as far
    // as the points and the level cap allow.
    const n = Math.min(Math.max(1, Math.min(25, Math.trunc(Number(d.count)) || 1)), p.ch.skillPoints, C.SKILL_LEVEL_CAP - cur);
    p.ch.combatSkills[id] = cur + n;
    p.ch.skillPoints -= n;
    p.recompute(true);
    p.commitItems({});
    return undefined;
  }

  // ---------- appearance / profession ----------
  appearance(p, d) {
    const prof = typeof d.profession === 'string' ? d.profession : null;
    const a = C.normalizeAppearance(Object.assign({}, p.ch.appearance, d, { portraitId: d.portraitId == null ? p.ch.appearance.portraitId : d.portraitId }), p.ch.appearance.model);
    const targetProf = prof || this.professionForModel(a.model, p.ch.profession);
    if (targetProf !== p.ch.profession) {
      // Twelfth batch: 工匠 and 园丁 need combat level 10 too (going back to 宝宝 does not).
      if (targetProf !== 'child' && p.stats.combatLevel < 10) {
        return this.err(p, 'appearance', E.REQUIREMENT_NOT_MET, '战斗等级达到10级才能转职');
      }
      const opts = cat.protocol.PROFESSION_MODEL_OPTIONS[targetProf];
      if (!opts) return this.err(p, 'appearance', E.BAD_REQUEST);
      // Gear the new profession cannot wear goes to the bag: refuse when it would not fit.
      const after = Object.assign({}, p.ch, { profession: targetProf, professionExp: Object.assign({ [targetProf]: 0 }, p.ch.professionExp) });
      const unfit = cat.EQUIP_SLOTS.filter((s) => p.ch.equipment[s] && C.meetsRequirement(p.ch, p.ch.equipment[s]) && !C.meetsRequirement(after, p.ch.equipment[s])).length;
      if (unfit > p.inventory.filter((x) => !x).length) {
        return this.err(p, 'appearance', E.BAG_FULL, '转职后有 ' + unfit + ' 件装备不能再穿，背包放不下。请先空出背包格子再转职。');
      }
      a.model = C.modelFor(targetProf, a.gender, a.model);
      p.ch.profession = targetProf;
      // Thirteenth batch: a job change at the 转职神父 ends an admin-made profession.
      delete p.ch.customProfession;
      p.ch.professionExp = p.ch.professionExp || {};
      p.ch.professionExp[targetProf] = p.ch.professionExp[targetProf] || 0;
    } else {
      const opts = cat.protocol.PROFESSION_MODEL_OPTIONS[p.ch.profession] || [];
      if (opts.length && !opts.includes(a.model)) a.model = p.ch.appearance.model;
      const cp = C.customProfessionOf(p.ch);
      if (cp && cp.model) a.model = cp.model;
    }
    p.ch.appearance = a;
    // Fifteenth batch: a green-gift transform keeps its look until it runs out.
    if (p.ch.transform && p.ch.transform.until > Date.now()) p.ch.appearance.model = C.modelForCharacter(p.ch);
    p.recompute(true);
    p.markDirty();
    this.returnUnfitGear(p);
    p.commitItems({});
    return undefined;
  }

  // Worn items the player no longer qualifies for (after a job change, or rules changed
  // since the save) go back to the bag. With a full bag they stay worn but do nothing
  // (character.js skips them), and the sweep below takes them off once there is room.
  returnUnfitGear(p, why = '转职后') {
    const u = C.unequipUnfit(p.ch);
    if (u.moved.length) {
      p.recompute(true);
      p.commitItems({ inv: u.inv, equip: u.equip });
      p.send(this.server.op.CHAT_MESSAGE, this.server.systemChat(why + '不能再穿戴的装备已放回背包：' + u.moved.join('、') + '。'));
    }
    if (u.stuck.length) {
      const names = u.stuck.join('、');
      if (p.unfitNotice !== names) p.send(this.server.op.CHAT_MESSAGE, this.server.systemChat('背包满了，这些装备暂时卸不下，属性不生效，空出背包后会自动卸下：' + names + '。'));
      p.unfitNotice = names;
    } else p.unfitNotice = null;
    return u;
  }

  hasUnfitGear(p) { return cat.EQUIP_SLOTS.some((s) => p.ch.equipment[s] && !C.meetsRequirement(p.ch, p.ch.equipment[s])); }

  sweepUnfit() {
    for (const p of this.server.playersById.values()) {
      if (p.ch && this.hasUnfitGear(p) && p.inventory.some((x) => !x)) this.returnUnfitGear(p, '');
    }
  }

  professionForModel(model, current) {
    const opts = cat.protocol.PROFESSION_MODEL_OPTIONS;
    if ((opts[current] || []).includes(model)) return current;
    for (const [prof, list] of Object.entries(opts)) if (list.includes(model)) return prof;
    return current;
  }
}

module.exports = { Items, ItemError: E };
