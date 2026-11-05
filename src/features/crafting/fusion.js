'use strict';
// Smith fusion (融合装备): put an equipment piece plus an engraving (prefix)
// and/or a gem (attribute) on the bunk, heat it to red-hot (600-900℃) and
// fuse. Also answers the info stage (融合/打造信息) query.
// Twelfth batch (Sky's flow):
// - 加温 starts the heating; the temperature then rises by itself (up to 1200℃).
// - 600-900℃: 完成 may be pressed. The odds come from the distance to 750℃
//   (fusionBestChance within fusionBestBand℃, falling linearly to fusionEdgeChance
//   at 600/900℃). Only the first 完成 of a round counts: the round ends at once,
//   the bunk is cleared ("等待材料") and the temperature is back to 20℃.
// - Above 900℃ 降温 may be pressed; below 600℃ / above 900℃ 完成 only gives the
//   original "火候不对" messages.
// - A success adds craftExpPerSuccess (1) proficiency to 物品加工 (fusion) or
//   装备修理 (repair); 战神的祝福 doubles it (craftBlessFactor). Failures add none.
// - 自动修理: a craftsman in the smithy picks one piece of equipment and the server
//   repairs it again and again (autoRepairIntervalSec, autoRepairChance).
const cat = require('../../game/catalog');
const D = require('./data');
const U = require('./common');

const AMBIENT = 20;
const MAX_T = 1200;
const RED_MIN = 600;
const RED_MAX = 900;
const HEAT_RATE = 110;
const COOL_RATE = -140;
const CENTER = 750;
const E = { NOT_HERE: 1, NO_SESSION: 2, BAD_SLOT: 3, STALE: 4, BAD_ITEM: 5, TEMPERATURE: 6, MISSING: 7, LEVEL: 8, STALE_BAG: 15 };
const MEANING = {
  1: '只能在铁匠铺的工作台融合', 2: '会话已结束', 3: '格子不对', 4: '背包物品已变化', 5: '物品不能放在这一格',
  6: '温度必须在红热范围（600-900℃）', 7: '缺少装备或融合原料', 8: '融合技能等级不足', 15: '背包数据已过期',
};

class Fusion {
  constructor(crafting) { this.crafting = crafting; this.server = crafting.server; }

  register() {
    const s = this.server; const op = s.op; const rp = (fn) => s.requirePlayer((p, d) => fn.call(this, p, d || {}));
    s.on(op.SMITH_FUSION_OPEN, rp(this.open));
    s.on(op.SMITH_FUSION_SELECT, rp(this.select));
    s.on(op.SMITH_FUSION_HEAT, rp((p, d) => this.setRate(p, d, HEAT_RATE)));
    s.on(op.SMITH_FUSION_COOL, rp((p, d) => this.setRate(p, d, COOL_RATE)));
    s.on(op.SMITH_FUSION_FINISH, rp(this.finish));
    s.on(op.SMITH_FUSION_CLOSE, rp(this.close));
    s.on(op.SMITH_FUSION_INFO_REQUEST, rp(this.info));
    // 自动修理 (twelfth batch, Q12).
    s.ext.on('auto_repair', (p, d) => (d.on ? this.autoStart(p) : this.autoStop(p, '自动修理已停止。')));
    s.events.on('playerMapChanging', (p) => { if (p.autoRepair) this.autoStop(p, '离开了铁匠铺，自动修理已停止。'); });
    s.events.on('playerLeaving', (p) => { p.autoRepair = null; });
    this.lastAuto = 0;
    s.events.on('tick', (now) => { if (now - this.lastAuto >= 500) { this.lastAuto = now; this.autoSweep(now); } });
  }

  // 自动修理: a craftsman picks the equipment on the bunk (nothing else on it) and the
  // server repairs it every autoRepairIntervalSec at autoRepairChance percent, for free.
  // A failure still costs durability (never below 1). A full piece may be chosen.
  // It stops on leaving the smithy, going offline, closing the panel or moving the item.
  autoState(p, message) {
    const a = p.autoRepair;
    const it = a && U.resolveRef(p, a.ref);
    this.server.ext.send(p, 'auto_repair', { on: !!(a && it), name: it ? it.name : '', done: a ? a.done : 0, ok: a ? a.ok : 0,
      intervalSec: this.autoInterval() / 1000, nextInMs: a ? Math.max(0, a.next - Date.now()) : 0, chance: this.autoChance(), message: message || '' });
  }
  // Fourteenth batch: repair notices drop in the blue box on the left (the client's
  // MessageDropPanel, as in trading) instead of the chat window.
  drop(p, text) { if (text) this.server.ext.send(p, 'drop_msg', { text: String(text) }); }
  autoInterval() { return Math.max(1, Number(this.server.config.autoRepairIntervalSec) || 8) * 1000; }
  autoChance() { return Math.min(100, Math.max(0, Number(this.server.config.autoRepairChance) || 0)); }
  autoStart(p) {
    const say = (m) => { this.drop(p, m); this.autoState(p, m); };
    if (p.ch.profession !== 'craftsman') return say('只有工匠才能自动修理。');
    if (!U.mapIs(p, 'smith')) return say('请到铁匠铺的工作台自动修理。');
    const s = p.interactions.fusion;
    const equip = s && U.resolveRef(p, s.slots.equipment);
    if (!equip) return say('请先在上面方格放入要修理的装备。');
    if (s.slots.prefix || s.slots.attribute) return say('自动修理只能放一件装备，请先拿走印刻和宝石。');
    if (!equip.durability || equip.durability.infinite) return say(equip.name + '没有耐久度，不需要修理。');
    const need = this.requirement(equip), lvl = this.level(p);
    if (lvl < need) return say('融合技能需要 ' + need + ' 级，您现在是 ' + lvl + ' 级，不能修理这件物品。');
    p.autoRepair = { ref: Object.assign({}, s.slots.equipment), sessionId: s.sessionId, next: Date.now() + this.autoInterval(), done: 0, ok: 0 };
    say('开始自动修理' + equip.name + '：每 ' + this.autoInterval() / 1000 + ' 秒修一次，成功率 ' + this.autoChance() + '%。');
  }
  autoStop(p, why) {
    if (!p.autoRepair) return;
    p.autoRepair = null;
    if (why) this.drop(p, why);
    this.autoState(p, why);
  }
  autoSweep(now) {
    for (const p of this.server.playersById.values()) {
      const a = p.autoRepair;
      if (!a || now < a.next) continue;
      const s = p.interactions.fusion;
      if (!s || s.sessionId !== a.sessionId) { this.autoStop(p, '关闭了工作台，自动修理已停止。'); continue; }
      if (!U.mapIs(p, 'smith')) { this.autoStop(p, '离开了铁匠铺，自动修理已停止。'); continue; }
      const equip = U.resolveRef(p, a.ref);
      if (!equip) { this.autoStop(p, '装备被移走了，自动修理已停止。'); continue; }
      a.next = now + this.autoInterval();
      const success = Math.random() * 100 < this.autoChance();
      const r = this.repairItem(p, equip, success);
      a.done += 1; if (success) a.ok += 1;
      p.commitItems({ inv: [a.ref.inventoryIndex] });
      this.drop(p, '自动修理：' + r.message);
      for (const m of r.messages || []) this.drop(p, typeof m === 'string' ? m : (m && m.text) || '');
      this.autoState(p);
    }
  }

  err(p, code, message) { p.send(this.server.op.SMITH_FUSION_ERROR, { code, message, meaning: MEANING[code] || '', serverSeq: this.server.nextSeq() }); }
  // 融合修理 is one skill in the original; the higher of 物品加工 / 装备修理 counts.
  level(p) { const st = D.craftState(p.ch); return Math.max(D.skillLevel(st.fusion.exp), D.skillLevel(st.repair.exp)); }

  session(p, d) {
    const s = p.interactions.fusion;
    if (!s || (d.sessionId && d.sessionId !== s.sessionId)) { this.err(p, E.NO_SESSION, '融合会话已失效，请重新打开。'); return null; }
    return s;
  }

  temperatureAt(s, now) {
    const t = s.temperature + s.rate * (now - s.at) / 1000;
    return Math.max(AMBIENT, Math.min(MAX_T, t));
  }

  settle(s, now) {
    s.temperature = this.temperatureAt(s, now); s.at = now;
    if ((s.rate < 0 && s.temperature <= AMBIENT) || (s.rate > 0 && s.temperature >= MAX_T)) s.rate = 0;
  }

  sendState(p, s) {
    const now = Date.now();
    this.settle(s, now);
    // Let the client interpolate up to the bound where the rate stops.
    const view = (ref) => (ref ? U.viewRef(p, ref) : null);
    p.send(this.server.op.SMITH_FUSION_STATE, {
      sessionId: s.sessionId, phase: s.rate > 0 ? 'heating' : s.rate < 0 ? 'cooling' : (s.finished ? 'finished' : 'idle'),
      slots: { equipment: view(s.slots.equipment), prefix: view(s.slots.prefix), attribute: view(s.slots.attribute) },
      temperature: Math.round(s.temperature * 1000) / 1000, temperatureRate: s.rate, ambientTemperature: AMBIENT, maxTemperature: MAX_T,
      redHotMinTemperature: RED_MIN, redHotMaxTemperature: RED_MAX, serverTime: now, serverSeq: this.server.nextSeq(),
    });
  }

  open(p) {
    if (!U.mapIs(p, 'smith')) return this.err(p, E.NOT_HERE, '请到铁匠铺的工作台融合装备。');
    const s = { sessionId: U.newSessionId('fusion'), slots: { equipment: null, prefix: null, attribute: null }, temperature: AMBIENT, rate: 0, at: Date.now(), finished: false };
    p.interactions.fusion = s;
    this.sendState(p, s);
  }

  select(p, d) {
    const s = this.session(p, d); if (!s) return;
    const slot = d.slot;
    if (!['equipment', 'prefix', 'attribute'].includes(slot)) return this.err(p, E.BAD_SLOT, '没有这个融合格子。');
    if (d.inventoryIndex == null) { s.slots[slot] = null; return this.sendState(p, s); }
    const index = U.idx(d.inventoryIndex);
    const it = index == null ? null : p.ch.inventory[index];
    if (!it) return this.err(p, E.STALE, '背包物品已经变化。');
    if (slot === 'equipment' && !D.isEquipment(it)) return this.err(p, E.BAD_ITEM, '这里只能放入装备。');
    if (slot === 'prefix' && !D.engravingInfo(it.itemId)) return this.err(p, E.BAD_ITEM, '前缀格只能放入印刻。');
    if (slot === 'attribute' && !D.gemInfo(it.itemId)) return this.err(p, E.BAD_ITEM, '属性格只能放入宝石。');
    // Not enough fusion skill for this item: refuse it now rather than at the end.
    const items = { equipment: U.resolveRef(p, s.slots.equipment), prefix: U.resolveRef(p, s.slots.prefix), attribute: U.resolveRef(p, s.slots.attribute) };
    items[slot] = it;
    const need = this.needFor(items), lvl = this.level(p);
    if (lvl < need) return this.err(p, E.LEVEL, '融合技能需要 ' + need + ' 级，您现在是 ' + lvl + ' 级，不能' + (slot === 'equipment' && !items.prefix && !items.attribute ? '修理' : '融合') + '这件物品。');
    for (const k of Object.keys(s.slots)) if (s.slots[k] && s.slots[k].inventoryIndex === index) s.slots[k] = null;
    s.slots[slot] = U.invRef(p, index);
    s.finished = false;
    this.sendState(p, s);
  }

  setRate(p, d, rate) {
    const s = this.session(p, d); if (!s) return;
    const now = Date.now();
    this.settle(s, now);
    if (rate > 0) {
      const items = { equipment: U.resolveRef(p, s.slots.equipment), prefix: U.resolveRef(p, s.slots.prefix), attribute: U.resolveRef(p, s.slots.attribute) };
      if (!items.equipment) return this.err(p, E.MISSING, '请在上面方格放入待融合或修理的物品。');
      const need = this.needFor(items), lvl = this.level(p);
      if (lvl < need) return this.err(p, E.LEVEL, '融合技能需要 ' + need + ' 级，您现在是 ' + lvl + ' 级，不能开始。');
    } else if (Math.round(s.temperature) <= RED_MAX) {
      // 降温 only once it has gone past red-hot.
      return this.err(p, E.TEMPERATURE, '温度还没有超过 ' + RED_MAX + '℃，不需要降温。');
    }
    s.rate = rate;
    this.sendState(p, s);
  }

  requirement(item) { return D.FUSION_TIERS[D.fusionTierFor(D.itemLevel(cat.getTemplate(item.itemId)))]; }

  // The fusion level the placed items need ({equipment, prefix, attribute}, any may be null).
  needFor(items) {
    const needs = [0];
    if (items.equipment && D.isEquipment(items.equipment)) needs.push(this.requirement(items.equipment));
    const eInfo = items.prefix && D.engravingInfo(items.prefix.itemId);
    const gInfo = items.attribute && D.gemInfo(items.attribute.itemId);
    if (eInfo) needs.push(D.GRADE_LEVELS[eInfo.grade]);
    if (gInfo) needs.push(D.GRADE_LEVELS[gInfo.grade]);
    return Math.max(...needs);
  }

  // The odds at a temperature (Sky, twelfth batch): closer to 750℃ is better.
  chanceAt(temperature) {
    const c = this.server.config;
    const best = Math.min(1, Math.max(0, (Number(c.fusionBestChance) || 95) / 100));
    const edge = Math.min(best, Math.max(0, (Number(c.fusionEdgeChance) || 40) / 100));
    const band = Math.max(0, Number(c.fusionBestBand) || 25);
    const dev = Math.abs(temperature - CENTER);
    if (dev <= band) return best;
    const span = Math.max(1, (RED_MAX - RED_MIN) / 2 - band);
    return Math.max(edge, best - (best - edge) * (dev - band) / span);
  }

  // Proficiency for one success: craftExpPerSuccess, doubled by 战神的祝福.
  gain(p) {
    const c = this.server.config;
    const base = Math.max(0, Math.round(Number(c.craftExpPerSuccess) || 1));
    const bless = this.server.features.blessing;
    return bless && bless.isBlessed(p.ch) ? Math.round(base * (Number(c.craftBlessFactor) || 2)) : base;
  }

  // Ends the round: no heating or cooling, back to 20℃ and an empty bunk.
  endRound(s, now) {
    s.slots = { equipment: null, prefix: null, attribute: null };
    s.temperature = AMBIENT; s.rate = 0; s.at = now; s.finished = false;
  }

  finish(p, d) {
    const s = this.session(p, d); if (!s) return;
    const now = Date.now();
    // Nothing is heating any more (the round already ended): ignore repeated clicks.
    if (!s.slots.equipment) return this.err(p, E.MISSING, '请放入要融合或修理的装备。');
    const temperature = this.temperatureAt(s, now);
    const equip = U.resolveRef(p, s.slots.equipment);
    const prefix = U.resolveRef(p, s.slots.prefix);
    const attr = U.resolveRef(p, s.slots.attribute);
    if ((s.slots.equipment && !equip) || (s.slots.prefix && !prefix) || (s.slots.attribute && !attr)) return this.err(p, E.STALE, '融合材料已经不在背包里。');
    if (!equip) return this.err(p, E.MISSING, '请放入要融合或修理的装备。');
    if (Math.round(temperature) < RED_MIN) return this.err(p, E.TEMPERATURE, '火候不对，装备还没烧到红热。');
    if (Math.round(temperature) > RED_MAX) return this.err(p, E.TEMPERATURE, '火候不对，装备已经太烫了，无法操作。');
    const lvl = this.level(p);
    const need = this.needFor({ equipment: equip, prefix, attribute: attr });
    if (lvl < need) return this.err(p, E.LEVEL, '融合技能需要 ' + need + ' 级，您现在是 ' + lvl + ' 级。');
    const chance = this.chanceAt(temperature);
    const success = Math.random() < chance;
    const equipIndex = s.slots.equipment.inventoryIndex;
    if (!prefix && !attr) {
      const r = this.repairItem(p, equip, success);
      this.endRound(s, now);
      p.commitItems({ inv: [equipIndex] });
      p.send(this.server.op.SMITH_FUSION_RESULT, {
        sessionId: s.sessionId, success, message: r.message, temperature: Math.round(temperature), successChance: Math.round(chance * 100) / 100,
        fusionLevel: lvl, progressionMessages: r.messages, item: U.cloneItem(equip), repair: true, serverSeq: this.server.nextSeq(),
      });
      return this.sendState(p, s);
    }
    const eInfo = prefix && D.engravingInfo(prefix.itemId);
    const gInfo = attr && D.gemInfo(attr.itemId);
    const changed = [];
    if (prefix) changed.push(U.consumeAt(p, s.slots.prefix.inventoryIndex, 1));
    if (attr) changed.push(U.consumeAt(p, s.slots.attribute.inventoryIndex, 1));
    let messages = [];
    let message;
    if (success) {
      const affix = D.normalizedAffix(equip);
      const ext = Object.assign({}, equip.ext);
      if (prefix) {
        const name = (prefix.ext && prefix.ext.legacyPrefixName) || D.affixOf(prefix).prefix?.name || eInfo.prefix;
        affix.prefix = { name, attrs: (prefix.bonusAttrs || []).map((a) => Object.assign({}, a)) };
        ext.fusedPrefixMaterialId = prefix.itemId;
      }
      if (attr) {
        const name = (attr.ext && attr.ext.legacySuffixName) || gInfo.suffix;
        affix.suffix = { name, attrs: (attr.bonusAttrs || []).map((a) => Object.assign({}, a)) };
        ext.fusedAttributeMaterialId = attr.itemId;
      }
      equip.ext = ext;
      D.rebuildItem(equip, affix);
      changed.push(equipIndex);
      messages = D.gainSkill(p.ch, 'fusion', this.gain(p), '物品加工');
      message = '融合成功！' + equip.name + '诞生了。';
    } else {
      D.gainSkill(p.ch, 'fusion', 0, '物品加工', false);
      message = '融合失败，损失了附属物品。';
    }
    this.endRound(s, now);
    p.paramsDirty = true;
    p.commitItems({ inv: changed });
    p.send(this.server.op.SMITH_FUSION_RESULT, {
      sessionId: s.sessionId, success, message, temperature: Math.round(temperature), successChance: Math.round(chance * 100) / 100,
      fusionLevel: lvl, progressionMessages: messages, item: U.cloneItem(equip), serverSeq: this.server.nextSeq(),
    });
    this.sendState(p, s);
  }

  // Repair (only the equipment on the bunk). Success restores full durability, failure
  // costs a tenth of it (never below 1): "雪上加霜，物品耐久度反而下降了".
  repairItem(p, equip, success) {
    const dur = equip.durability;
    let message; let messages = [];
    if (success) {
      if (dur && !dur.infinite) dur.cur = dur.max;
      messages = D.gainSkill(p.ch, 'repair', this.gain(p), '装备修理');
      message = '修理成功！' + equip.name + '的耐久度已经恢复满了。';
    } else {
      D.gainSkill(p.ch, 'repair', 0, '装备修理', false);
      if (dur && !dur.infinite) dur.cur = Math.max(1, dur.cur - Math.max(1, Math.round(dur.max / 10)));
      message = '雪上加霜，' + equip.name + '的耐久度反而下降了。';
    }
    p.paramsDirty = true;
    return { message, messages };
  }

  close(p, d) {
    const s = p.interactions.fusion;
    if (s && (!d.sessionId || d.sessionId === s.sessionId)) {
      delete p.interactions.fusion;
      if (p.autoRepair) this.autoStop(p, '关闭了工作台，自动修理已停止。');
    }
  }

  info(p, d) {
    const st = D.craftState(p.ch);
    // Fourteenth batch: 融合 and 修理 keep separate records, but the board (公告牌) is one
    // skill like in the original: the higher record gives the level, title and exp, and
    // the success / attempt counts add both (repairs showed 0/0 before).
    const best = (st.repair.exp || 0) > (st.fusion.exp || 0) ? st.repair : st.fusion;
    const fusion = Object.assign(D.skillSummary(best), {
      totalSuccesses: (st.fusion.successes || 0) + (st.repair.successes || 0),
      totalAttempts: (st.fusion.attempts || 0) + (st.repair.attempts || 0),
    });
    const forging = D.skillSummary(st.forging);
    const tiers = D.FUSION_TIERS.map((req, i) => {
      const equipment = [];
      for (const t of cat.catalogs.shop) {
        if (!cat.slotForTemplate(t) || !(t.bonusAttrs || []).length) continue;
        if (D.fusionTierFor(D.itemLevel(t)) === i && equipment.length < 16) equipment.push({ name: t.name });
      }
      const grade = D.GRADE_LEVELS.filter((g) => g <= req).length - 1;
      const fresh = D.GRADE_LEVELS[grade] === req || i === 0;
      return {
        requiredLevel: req, unlocked: fusion.level >= req, equipment,
        prefixNames: fresh ? D.ENGRAVING_TYPES.map((t) => ['残缺的', '模糊的', '', '极品'][grade] + t + (['巨人', '贤者', '导师', '英雄', '勇者'].includes(t) ? '之印' : '印刻')) : [],
        attributeNames: fresh ? D.GEM_TYPES.map((g) => { const tpl = cat.getTemplate(1665 + grade * 10 + g.base); return tpl ? tpl.name : null; }).filter(Boolean) : [],
      };
    });
    const forgeTiers = [];
    for (const r of D.RECIPES) {
      let tier = forgeTiers.find((t) => t.requiredLevel === Math.max(1, Math.floor(r.requiredLevel / 10) * 10));
      if (!tier) { tier = { requiredLevel: Math.max(1, Math.floor(r.requiredLevel / 10) * 10), unlocked: false, recipes: [] }; forgeTiers.push(tier); }
      if (tier.recipes.length < 12) tier.recipes.push({ name: r.name, materials: r.materials.map((m) => ({ name: cat.getTemplate(m.itemId).name, count: m.count })) });
    }
    forgeTiers.sort((a, b) => a.requiredLevel - b.requiredLevel).forEach((t) => { t.unlocked = forging.level >= t.requiredLevel; });
    p.send(this.server.op.SMITH_FUSION_INFO, {
      requestId: d.requestId, profession: p.ch.profession, skill: fusion, tiers,
      forging: { skill: forging, tiers: forgeTiers }, serverSeq: this.server.nextSeq(),
    });
  }
}

module.exports = { Fusion };
