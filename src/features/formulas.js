'use strict';
// Twelfth batch: which character formula set is in use, and the custom sets
// (game/formulas.js). Kept in the store bucket formulaSets:
// { active: 'web' | 'original' | <custom id>, custom: { id: set } }.
// Sky (Q29): every original formula is switched on now, so a server without a saved
// choice uses 原版.
const F = require('../game/formulas');
const C = require('../game/character');
const log = require('../util/log');

class Formulas {
  register(server) {
    this.server = server;
    C.setFormulaSet(F.ORIGINAL);   // until the saved choice is loaded (onStart)
  }
  onStart() { this.apply(true); }

  bucket() {
    const b = this.server.store.bucket('formulaSets');
    if (!b.custom) b.custom = {};
    if (!b.active) b.active = 'original';
    return b;
  }
  setById(id) {
    if (id === 'original') return F.ORIGINAL;
    if (id === 'web') return null;
    return this.bucket().custom[id] || null;
  }
  apply(recompute) {
    const b = this.bucket();
    if (b.active !== 'web' && b.active !== 'original' && !b.custom[b.active]) b.active = 'original';
    C.setFormulaSet(this.setById(b.active));
    if (recompute) for (const p of this.server.playersById.values()) if (p.ch) { p.recompute(); p.paramsDirty = true; p.markDirty(); }
  }

  view() {
    const b = this.bucket();
    const sets = [
      { id: 'web', name: '网页版（原有规则）', builtin: true, set: null },
      { id: 'original', name: '原版', builtin: true, set: F.ORIGINAL },
    ].concat(Object.entries(b.custom).map(([id, set]) => ({ id, name: set.name, builtin: false, set })));
    return { active: b.active, sets, vars: F.VARS, keys: F.KEYS, keyNames: F.KEY_NAMES, groups: F.GROUPS, groupNames: F.GROUP_NAMES, sample: F.SAMPLE, sources: F.ORIGINAL.sources };
  }
  setActive(id) {
    const b = this.bucket();
    if (id !== 'web' && id !== 'original' && !b.custom[id]) throw new Error('没有这套公式');
    b.active = id;
    this.server.store.markDirty();
    this.apply(true);
    log.info('formula set ->', id);
    return '现在使用：' + (id === 'web' ? '网页版' : id === 'original' ? '原版' : b.custom[id].name) + '（在线玩家已重新计算）';
  }
  test(set) { return F.validateSet(set); }
  save(id, set) {
    const sample = F.validateSet(set);
    const b = this.bucket();
    const key = id && b.custom[id] ? id : 'c' + Date.now().toString(36);
    const clean = { name: String(set.name).trim(), overweightPercent: Number(set.overweightPercent), groups: {} };
    for (const g of F.GROUPS) { clean.groups[g] = {}; for (const k of F.KEYS) clean.groups[g][k] = String(set.groups[g][k]); }
    b.custom[key] = clean;
    this.server.store.markDirty();
    if (b.active === key) this.apply(true);
    return { id: key, sample };
  }
  remove(id) {
    const b = this.bucket();
    if (!b.custom[id]) throw new Error('只能删除自定义的公式套');
    const name = b.custom[id].name;
    delete b.custom[id];
    if (b.active === id) b.active = 'original';
    this.server.store.markDirty();
    this.apply(true);
    return '已删除 ' + name;
  }
}

module.exports = { Formulas };
