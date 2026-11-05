'use strict';
// Combat level lock: /lock freezes the combat level where it is (EXP keeps
// accumulating), /levelup then raises it one level at a time by hand.
// Profession levels are not affected.
const C = require('../game/character');

class LevelLock {
  register(server) {
    this.server = server;
    const chat = server.features.chat;
    for (const name of ['lock', '锁级', '锁定']) chat.commands.set(name, (p, args) => this.toggle(p, args));
    // V15.2: '/levelup 10' (Shift-click) or '/levelup 25' (Ctrl-click) raises several levels.
    for (const name of ['levelup', '升级']) chat.commands.set(name, (p, [n]) => this.levelUps(p, Math.max(1, Math.min(25, Math.trunc(Number(n)) || 1))));
  }

  toggle(p, [arg]) {
    const ch = p.ch;
    const want = arg === 'on' || arg === '开' ? true : arg === 'off' || arg === '关' ? false : !Number.isInteger(ch.combatLevelLock);
    if (want) {
      ch.combatLevelLock = C.combatLevel(ch);
      p.levelLockNoticeSent = false;
      this.changed(p);
      return '战斗等级已锁定在 ' + ch.combatLevelLock + ' 级。打怪的经验照常累积，输入 /levelup 手动升级，再输入 /lock 解除锁定。';
    }
    const before = C.combatLevel(ch);
    ch.combatLevelLock = null;
    const after = C.combatLevel(ch);
    this.applyGain(p, before, after);
    this.changed(p);
    return '已解除战斗等级锁定' + (after > before ? '，等级提升到 ' + after + ' 级。' : '。');
  }

  levelUps(p, n) {
    if (n <= 1) return this.levelUp(p);
    const ch = p.ch;
    if (!Number.isInteger(ch.combatLevelLock)) return this.levelUp(p);
    const before = C.combatLevel(ch);
    const target = Math.min(before + n, C.levelForExp(ch.combatExp || 0));
    if (target <= before) return this.levelUp(p);
    ch.combatLevelLock = target;
    p.levelLockNoticeSent = false;
    const gained = this.applyGain(p, before, target);
    this.changed(p);
    return '战斗等级提升到 ' + target + ' 级（升了 ' + (target - before) + ' 级' + (target - before < n ? '，经验只够这么多' : '') + '）' + (gained ? '，获得 ' + gained + ' 点技能点' : '') + '。等级仍然锁定。';
  }

  levelUp(p) {
    const ch = p.ch;
    if (!Number.isInteger(ch.combatLevelLock)) return '战斗等级没有锁定，会自动升级。输入 /lock 可以锁定。';
    const before = C.combatLevel(ch);
    if (C.levelForExp(ch.combatExp || 0) <= before) {
      const need = C.cumulativeExpForLevel(before + 1) - (ch.combatExp || 0);
      return '经验不够，升到 ' + (before + 1) + ' 级还需要 ' + Math.max(0, need) + ' 点经验。';
    }
    ch.combatLevelLock = before + 1;
    p.levelLockNoticeSent = false;
    const gained = this.applyGain(p, before, before + 1);
    this.changed(p);
    return '战斗等级提升到 ' + (before + 1) + ' 级' + (gained ? '，获得 ' + gained + ' 点技能点' : '') + '。等级仍然锁定。';
  }

  applyGain(p, before, after) {
    if (after <= before) return 0;
    const gained = C.settleLevelPoints(p.ch);
    p.recompute(true);
    p.ch.hp = p.stats.maxHp; p.ch.stamina = p.stats.maxStamina;
    return gained;
  }

  changed(p) {
    p.recompute(true);
    p.paramsDirty = true;   // recompute(true) is silent; the client needs the new level and EXP now
    p.flushParams();
    p.markDirty();
    this.server.store.markDirty();
  }
}

module.exports = { LevelLock };
