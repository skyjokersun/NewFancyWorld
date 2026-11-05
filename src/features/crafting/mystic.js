'use strict';
// Mystic smith (神秘铁匠) NPC repair with price haggling and affix removal,
// plus the craftsman's own workbench repair in the smithy.
const cat = require('../../game/catalog');
const D = require('./data');
const U = require('./common');

const ARTISANS = new Set(['莫邪-4', '干将-6', '徐夫人-3', '干将-9', '莫邪-7', '干将-8', '徐夫人-9', '徐夫人-7', '欧冶子-5', '欧冶子-3']);
const WORKBENCH = 'craftsman_workbench';
const AFFIX_FEE = 20000;
const E = { NOT_HERE: 1, NO_SESSION: 2, BAD_ITEM: 3, NO_GOLD: 4, NOT_CRAFTSMAN: 5, NO_AFFIX: 6, FULL: 7 };

function successChance(offer, quote) {
  const r = Math.max(0.5, Math.min(1.5, offer / Math.max(1, quote)));
  return Math.max(0.35, Math.min(0.85, 0.6 + 0.5 * (r - 1)));
}

class Mystic {
  constructor(crafting) { this.crafting = crafting; this.server = crafting.server; }

  register() {
    const s = this.server; const op = s.op; const rp = (fn) => s.requirePlayer((p, d) => fn.call(this, p, d || {}));
    s.on(op.MYSTIC_SMITH_OPEN, rp(this.open));
    s.on(op.MYSTIC_SMITH_SELECT, rp(this.select));
    s.on(op.MYSTIC_SMITH_REPAIR, rp(this.repair));
    s.on(op.MYSTIC_SMITH_CLOSE, rp(this.close));
  }

  err(p, code, message) { p.send(this.server.op.MYSTIC_SMITH_ERROR, { code, message, serverSeq: this.server.nextSeq() }); }

  session(p, d) {
    const s = p.interactions.mystic;
    if (!s || (d.sessionId && d.sessionId !== s.sessionId)) { this.err(p, E.NO_SESSION, '修理会话已结束，请重新找工匠。'); return null; }
    return s;
  }

  quote(item, mode) {
    const dur = item.durability || { cur: 1, max: 1 };
    if (dur.infinite || dur.cur >= dur.max) return 0;
    const t = cat.getTemplate(item.itemId);
    const price = Math.max(20, (t && t.buyPrice) || item.sellPrice * 2 || 100);
    const lost = (dur.max - dur.cur) / Math.max(1, dur.max);
    const base = Math.max(1, Math.ceil(price * 0.4 * lost));
    return mode === 'workbench' ? Math.max(1, Math.ceil(base * 0.5)) : base;
  }

  selection(p, s) {
    const it = s.selected ? U.resolveRef(p, s.selected) : null;
    if (!it) { s.selected = null; return null; }
    const a = D.affixOf(it);
    const q = this.quote(it, s.mode);
    return {
      inventoryIndex: s.selected.inventoryIndex, item: U.cloneItem(it), quoteKb: q, repairable: q > 0,
      affixes: { prefix: { present: !!a.prefix, name: a.prefix ? a.prefix.name : '' }, suffix: { present: !!a.suffix, name: a.suffix ? a.suffix.name : '' } },
    };
  }

  sendState(p, s) {
    p.send(this.server.op.MYSTIC_SMITH_STATE, {
      sessionId: s.sessionId, mode: s.mode, artisan: s.artisan, selection: this.selection(p, s), serverSeq: this.server.nextSeq(),
    });
  }

  open(p, d) {
    const a = d.artisan || {};
    let s;
    if (a.id === WORKBENCH) {
      if (!U.mapIs(p, 'smith')) return this.err(p, E.NOT_HERE, '请到铁匠铺的工作台修理装备。');
      if (p.ch.profession !== 'craftsman') return this.err(p, E.NOT_CRAFTSMAN, '只有工匠才能在工作台修理装备。');
      const lvl = D.skillLevel(D.craftState(p.ch).repair.exp);
      s = { mode: 'workbench', artisan: { id: WORKBENCH, name: '工匠工作台', level: lvl } };
    } else {
      if (!U.mapIs(p, 'smith2', 'smith_npc01')) return this.err(p, E.NOT_HERE, '这里没有神秘工匠。');
      if (!ARTISANS.has(String(a.id))) return this.err(p, E.NOT_HERE, '找不到这位工匠。');
      const [name, level] = String(a.id).split('-');
      s = { mode: 'npc', artisan: { id: a.id, name, level: Number(level) } };
    }
    s.sessionId = U.newSessionId('mystic'); s.selected = null;
    p.interactions.mystic = s;
    this.sendState(p, s);
  }

  select(p, d) {
    const s = this.session(p, d); if (!s) return;
    const index = U.idx(d.inventoryIndex);
    const it = index == null ? null : p.ch.inventory[index];
    if (!it || !D.isEquipment(it)) return this.err(p, E.BAD_ITEM, '请选择需要修理的装备。');
    s.selected = U.invRef(p, index);
    this.sendState(p, s);
  }

  result(p, s, message, chargedKb, outcome) {
    p.send(this.server.op.MYSTIC_SMITH_RESULT, { sessionId: s.sessionId, artisan: s.artisan, message, chargedKb, outcome, serverSeq: this.server.nextSeq() });
    this.sendState(p, s);
  }

  repair(p, d) {
    const s = this.session(p, d); if (!s) return;
    const it = s.selected ? U.resolveRef(p, s.selected) : null;
    if (!it) return this.err(p, E.BAD_ITEM, '请先选择需要修理的装备。');
    if (d.action === 'remove_prefix' || d.action === 'remove_suffix') return this.removeAffix(p, s, it, d.action === 'remove_prefix' ? 'prefix' : 'suffix');
    const quote = this.quote(it, s.mode);
    if (!quote) return this.err(p, E.FULL, '这件装备耐久是满的，不需要修理。');
    const dur = it.durability;
    if (s.mode === 'workbench') {
      if (!U.chargeGold(p, quote)) return this.err(p, E.NO_GOLD, '修理材料费需要 ' + quote + ' KB，您的钱不够。');
      const lvl = D.skillLevel(D.craftState(p.ch).repair.exp);
      const ok = Math.random() < Math.min(0.97, 0.75 + lvl * 0.003);
      let msg;
      if (ok) { dur.cur = dur.max; const m = D.gainSkill(p.ch, 'repair', 3 + Math.ceil(quote / 200), '修理'); msg = '修理完成，' + it.name + '恢复如新。' + m.join(' '); } else { dur.max = Math.max(1, dur.max - 1); dur.cur = dur.max; D.gainSkill(p.ch, 'repair', 0, '修理', false); msg = '修理时出了点差错，' + it.name + '的耐久上限降低了。'; }
      p.commitItems({ inv: [s.selected.inventoryIndex] });
      s.artisan.level = D.skillLevel(D.craftState(p.ch).repair.exp);
      return this.result(p, s, msg, quote, ok ? 'repaired' : 'damaged');
    }
    const offer = Math.max(1, Math.trunc(Number(d.offerKb) || quote));
    if (!U.chargeGold(p, offer)) return this.err(p, E.NO_GOLD, '您身上没有 ' + offer + ' KB。');
    const roll = Math.random();
    const chance = successChance(offer, quote);
    let outcome; let msg;
    if (roll < chance) { dur.cur = dur.max; outcome = 'repaired'; msg = '修好了，' + it.name + '又和新的一样！'; } else if (roll < chance + (1 - chance) * 0.75) {
      dur.max = Math.max(1, Math.floor(dur.max * 0.9)); dur.cur = dur.max; outcome = 'damaged'; msg = '手一抖……修是修好了，可耐久上限降低了。';
    } else {
      dur.max = Math.max(1, Math.floor(dur.max * 0.75)); dur.cur = Math.min(dur.cur, dur.max); outcome = 'broken'; msg = '糟糕，修坏了！' + it.name + '的耐久上限大幅降低。';
    }
    p.commitItems({ inv: [s.selected.inventoryIndex] });
    this.result(p, s, msg, offer, outcome);
  }

  removeAffix(p, s, it, part) {
    if (s.mode !== 'npc') return this.err(p, E.BAD_ITEM, '工作台不能去除词缀。');
    const affix = D.normalizedAffix(it);
    if (!affix[part]) return this.err(p, E.NO_AFFIX, part === 'prefix' ? '该装备没有前缀。' : '该装备没有后缀。');
    if (!U.chargeGold(p, AFFIX_FEE)) return this.err(p, E.NO_GOLD, '去除词缀需要 ' + AFFIX_FEE + ' 金币。');
    const name = affix[part].name;
    affix[part] = null;
    D.rebuildItem(it, affix);
    p.commitItems({ inv: [s.selected.inventoryIndex] });
    this.result(p, s, '已为您去除' + (part === 'prefix' ? '前缀' : '后缀') + '「' + name + '」，现在是' + it.name + '。', AFFIX_FEE, 'repaired');
  }

  close(p, d) {
    const s = p.interactions.mystic;
    if (s && (!d.sessionId || d.sessionId === s.sessionId)) delete p.interactions.mystic;
  }
}

module.exports = { Mystic, successChance };
