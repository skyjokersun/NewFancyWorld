'use strict';
// Chat: world / team / private channels, plus developer commands (dev mode only)
// that make manual and automated UI testing practical.
const C = require('../game/character');

const MAX_LEN = 120;
const RATE_WINDOW_MS = 10000;
const RATE_MAX = 12;

class Chat {
  register(server) {
    this.server = server;
    this.commands = new Map();
    server.on(server.op.CHAT, server.requirePlayer((p, d) => this.handle(p, d)));
    if (server.config.devMode) this.registerDevCommands();
  }

  message(p, channel, text, extra = {}) {
    return Object.assign({
      channel, from: p.name, fromGender: p.ch.appearance && p.ch.appearance.gender,
      playerId: p.id, message: text, timestamp: Date.now(), serverSeq: this.server.nextSeq(),
    }, extra);
  }

  tell(p, text) { p.send(this.server.op.CHAT_MESSAGE, this.server.systemChat(text)); }

  handle(p, d) {
    let text = String(d.message == null ? (d.text || '') : d.message).replace(/[\u0000-\u001f]/g, ' ').trim();
    if (!text) return;
    if (text.startsWith('/') && this.runCommand(p, text)) return;
    if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN);
    const now = Date.now();
    p.chatTimes = (p.chatTimes || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (p.chatTimes.length >= RATE_MAX) { this.tell(p, '发言太快了，请稍后再试。'); return; }
    p.chatTimes.push(now);
    if (p.ch.mutedUntil && p.ch.mutedUntil > now) { this.tell(p, '你已被禁言。'); return; }
    const op = this.server.op;
    const channel = d.channel === 'private' || d.channel === 'team' ? d.channel : 'world';
    if (channel === 'private') {
      const to = String(d.to || '').trim();
      const target = this.server.findPlayerByName(to, p.ch.world);
      if (!target) { this.tell(p, '玩家 ' + to + ' 不在线。'); return; }
      const msg = this.message(p, 'private', text, { to: target.name, toGender: target.ch.appearance && target.ch.appearance.gender });
      target.send(op.CHAT_MESSAGE, msg);
      if (target !== p) p.send(op.CHAT_MESSAGE, msg);
      return;
    }
    if (channel === 'team') {
      const party = this.server.features.party;
      const members = party ? party.membersOf(p) : [];
      if (!members.length) { this.tell(p, '你还没有加入队伍。'); return; }
      const msg = this.message(p, 'team', text);
      for (const m of members) m.send(op.CHAT_MESSAGE, msg);
      return;
    }
    const msg = this.message(p, 'world', text);
    for (const q of this.server.playersById.values()) if (q.ch.world === p.ch.world) q.send(op.CHAT_MESSAGE, msg);
  }

  runCommand(p, text) {
    const [name, ...args] = text.slice(1).trim().split(/\s+/);
    const cmd = this.commands.get(String(name).toLowerCase());
    if (!cmd) return false;
    try {
      const out = cmd(p, args);
      if (out) this.tell(p, out);
    } catch (e) { this.tell(p, '指令失败：' + e.message); }
    return true;
  }

  registerDevCommands() {
    const s = this.server;
    const cmd = (n, fn) => this.commands.set(n, fn);
    cmd('help', () => '开发指令：/go 地图 [x y]、/level 等级、/prof 职业、/plevel 职业等级、/gold 数量、/points 服务点、/item 物品ID [数量]、/heal、/hurt 百分比、/sp 技能点、/exp 经验、/where、/craft 技能 等级、/wear 点数、/garden 天数、/license 天数');
    cmd('where', (p) => p.scene.mapRef + ' (' + Math.round(p.x) + ',' + Math.round(p.y) + ')');
    cmd('go', (p, [ref, x, y]) => {
      const opts = x != null ? { x: Number(x), y: Number(y) } : {};
      const ok = s.transferPlayer(p, ref, opts);
      return ok ? null : '无法前往 ' + ref;
    });
    cmd('level', (p, [lv]) => {
      const L = Math.max(1, Math.min(200, Number(lv) | 0));
      p.ch.combatExp = C.cumulativeExpForLevel(L);
      p.recompute(); p.ch.hp = p.stats.maxHp; p.ch.stamina = p.stats.maxStamina; p.flushParams();
      return '战斗等级设为 ' + L + (p.lastLevelPoints ? '，获得 ' + p.lastLevelPoints + ' 点技能点' : '');
    });
    cmd('plevel', (p, [lv]) => {
      const L = Math.max(1, Math.min(200, Number(lv) | 0));
      p.ch.professionExp = Object.assign({}, p.ch.professionExp, { [p.ch.profession]: C.cumulativeExpForLevel(L) });
      p.recompute(); p.flushParams();
      return '职业等级设为 ' + L;
    });
    cmd('prof', (p, [prof]) => {
      const models = require('../game/catalog').protocol.PROFESSION_MODEL_OPTIONS;
      if (!models[prof]) return '职业：' + Object.keys(models).join(' ');
      p.ch.profession = prof;
      p.ch.professionExp = Object.assign({ [prof]: 0 }, p.ch.professionExp);
      p.ch.appearance = Object.assign({}, p.ch.appearance, { model: C.modelFor(prof, p.ch.appearance.gender, p.ch.appearance.model) });
      p.recompute(); p.markDirty();
      if (this.server.features.items) this.server.features.items.returnUnfitGear(p);
      p.flushParams();
      return '职业设为 ' + prof;
    });
    cmd('gold', (p, [n]) => { p.ch.gold = Math.max(0, Number(n) | 0); p.paramsDirty = true; p.flushParams(); return '金钱 ' + p.ch.gold; });
    cmd('points', (p, [n]) => { p.session.account.servicePoints = Math.max(0, Number(n) | 0); s.store.markDirty(); return '服务点 ' + p.session.account.servicePoints; });
    cmd('license', (p, [n]) => {
      const days = Number(n);
      if (!Number.isFinite(days)) return '用法：/license 天数（0 或负数表示让执照立即过期）';
      p.ch.businessLicense = { issuedAt: Date.now(), expiresAt: Date.now() + days * 864e5 };
      return days > 0 ? '摆摊执照有效期设为 ' + days + ' 天' : '摆摊执照已设为过期';
    });
    cmd('sp', (p, [n]) => { p.ch.skillPoints = Math.min(Math.max(0, Number(n) | 0), Math.max(0, C.SKILL_POINT_TOTAL_CAP - C.spentSkillPoints(p.ch))); p.paramsDirty = true; p.flushParams(); return '技能点 ' + p.ch.skillPoints; });
    cmd('exp', (p, [n]) => { const v = Math.max(0, Number(n) | 0); s.combat.grantExp(p, { combat: v, profession: v }); return null; });
    // /hurt [percent]: life and stamina down to that share of the maximum (default 50).
    cmd('hurt', (p, [n]) => {
      const share = Math.max(1, Math.min(100, Number(n) || 50)) / 100;
      p.ch.hp = Math.max(1, Math.floor(p.stats.maxHp * share)); p.ch.stamina = Math.floor(p.stats.maxStamina * share);
      p.paramsDirty = true; p.flushParams(); return '生命和精力降到 ' + Math.round(share * 100) + '%';
    });
    cmd('heal', (p) => { p.ch.hp = p.stats.maxHp; p.ch.stamina = p.stats.maxStamina; p.paramsDirty = true; p.flushParams(); return '已恢复'; });
    cmd('craft', (p, [key, lv]) => {
      const D = require('./crafting/data');
      const st = D.craftState(p.ch);
      if (!st[key] || key === 'ores') return '技能：mining smelting forging fusion repair';
      const L = Math.max(1, Math.min(D.SKILL_CAP, Number(lv) | 0));
      st[key].exp = D.skillTotals[L];
      s.store.markDirty();
      return key + ' 技能设为 ' + L + ' 级';
    });
    cmd('wear', (p, [n]) => {
      const slots = [];
      for (const [slot, it] of Object.entries(p.ch.equipment)) if (it && it.durability && !it.durability.infinite) { it.durability.cur = Math.max(0, it.durability.cur - (Number(n) | 0 || 1)); slots.push(slot); }
      for (let i = 0; i < p.ch.inventory.length; i += 1) { const it = p.ch.inventory[i]; if (it && it.durability && it.durability.max > 1 && !it.durability.infinite) { it.durability.cur = Math.max(0, it.durability.cur - (Number(n) | 0 || 1)); slots.push(i); } }
      p.commitItems({ inv: slots.filter((x) => typeof x === 'number'), equip: slots.filter((x) => typeof x === 'string') });
      return '装备耐久已降低';
    });
    cmd('garden', (p, [m]) => {
      const g = this.server.features.garden;
      if (!g) return '园艺未启用';
      const days = Number(m) || 1;
      return '已让 ' + g.grow(p, Math.round(days * 900)) + ' 棵果树生长 ' + days + ' 天';
    });
    cmd('item', (p, [id, n]) => {
      const tpl = require('../game/catalog').getTemplate(Number(id));
      if (!tpl) return '没有该物品';
      const changed = p.addItem(C.makeItem(p.ch, Number(id), Math.max(1, Number(n) | 0 || 1)));
      if (!changed) return '背包已满';
      p.commitItems({ inv: changed });
      return '已获得 ' + tpl.name;
    });
  }
}

module.exports = { Chat };
