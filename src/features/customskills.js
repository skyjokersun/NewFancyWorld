'use strict';
// Thirteenth batch (Q4/Q9): skills made on the admin page (新职业与上传 → 新技能).
// A skill works like the built-in ones (skills-data.js): one of the hit shapes the server
// resolves (kind), with its own name, icon, range, area, cost, cooldown, element and
// projectile (one of the client's or an uploaded ALE). Its damage follows the original
// Skill.tab: two formulas, 伤血 (the life part, against defence) and 伤甲 (what breaks the
// defence), with the variables attack, breakPower, slevel (skill level), LV (combat
// level) and % (so the original "attack+attack*(10+slevel)%" can be typed as it is).
// The client's complete-catalog patch draws any skill the server lists in params, so a
// new skill needs no client change: it shows in the skill panel, goes on the hotbar,
// and auto hunt can pick it.
// Owner: a combat profession, an admin-made profession (cp...), or monsters only. A
// player learns it from a skill book (sold with the other books) or at a combat level.
const cat = require('../game/catalog');
const F = require('../game/formulas');
const SD = require('../game/skills-data');

const KINDS = {
  point: ['落点范围', 'timed_point_bomb'], line: ['直线穿透', 'piercing_trail_bomb'], first: ['命中第一个', 'first_hit_projectile'],
  seek: ['追踪最近', 'first_hit_projectile'], volley: ['扇形多箭（各打第一个）', 'timed_point_bomb'], pellets: ['扇形穿透', 'timed_point_bomb'],
  burst: ['同点连发', 'timed_point_bomb'], nova: ['自身周围', 'radial_nova'],
};
const ELEMENTS = { '': '无', fire: '火', ice: '冰', thunder: '雷', poison: '毒' };
const BASES = ['warrior', 'archer', 'mage', 'gunner', 'child'];
const BOOK_ATLAS = { warrior: 311, archer: 302, mage: 325, gunner: 352, child: 325 };
const FIRST_BOOK_ID = 960000;
const VARS = { attack: '攻击（怪物用自己的攻击）', breakPower: '破坏', slevel: '技能等级', LV: '战斗等级（怪物用怪物等级）' };
const SAMPLE = { attack: 300, breakPower: 200, slevel: 10, LV: 30 };
const PROJECTILES = ['none', 'arrow', 'huojian', 'bingjian', 'mage_firebolt', 'huoqiu', 'bolt', 'bingbao', 'bullet', 'gunbullet', 'sanbullet', 'laser', 'waterbullet', 'ice_bullet', 'stone', 'guanghuan01', 'poison'];

// Skill formulas allow a postfix % (x% = x / 100), as in the original Skill.tab.
function compileSkill(src) {
  const text = String(src || '').trim().replace(/％/g, '%').replace(/(\d+(?:\.\d+)?|\))%/g, '$1/100');
  if (/%/.test(text)) throw new Error('% 只能跟在数字或右括号后面');
  return F.compile(text, VARS);
}
function check(src, what) {
  try { const v = compileSkill(src)(SAMPLE); if (!Number.isFinite(v)) throw new Error('样例算不出数'); return v; } catch (e) { throw new Error(what + '：' + e.message); }
}
function num(v, lo, hi, what, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(what + '要在 ' + lo + '–' + hi + ' 之间');
  return Math.round(n);
}

class CustomSkills {
  register(server) { this.server = server; }
  onStart() { this.apply(); }

  data() {
    const b = this.server.store.bucket('customSkills');
    if (!b.list) b.list = {};
    if (!b.nextId) b.nextId = 1;
    return b;
  }
  list() { return Object.values(this.data().list); }
  get(id) { return this.data().list[id] || null; }

  // Admin view: the skills, the choices for each field and the variables.
  view() {
    const pf = this.server.features.professions;
    const owners = BASES.map((b) => [b, require('../game/character').PROFESSION_LABELS[b] || b])
      .concat(pf ? Object.values(pf.customMap()).map((c) => [c.id, c.name + '（新职业）']) : []).concat([['monster', '只给怪物用']]);
    const up = this.server.features.uploads;
    const icons = [...new Set(Object.values(SD.SKILLS).filter((s) => !s.customSkill).map((s) => s.iconPath).filter(Boolean))];
    return {
      list: this.list().map((s) => Object.assign({}, s, { ownerName: (owners.find((o) => o[0] === s.owner) || [0, s.owner])[1] })),
      kinds: Object.entries(KINDS).map(([k, v]) => [k, v[0]]), elements: Object.entries(ELEMENTS), owners,
      projectiles: PROJECTILES.map((k) => [k, k === 'none' ? '无弹道' : k]).concat(up ? up.projectiles().map((k) => [k, k + '（上传）']) : []),
      icons, vars: VARS, sample: SAMPLE,
    };
  }

  clean(b, old) {
    const o = old || {};
    const name = String(b.name == null ? o.name || '' : b.name).trim();
    if (!name || [...name].length > 8) throw new Error('技能名须为 1–8 个字');
    const owner = String(b.owner || o.owner || '');
    const pf = this.server.features.professions;
    if (!BASES.includes(owner) && owner !== 'monster' && !(pf && pf.customMap()[owner])) throw new Error('请选这个技能属于哪个职业');
    const kind = String(b.kind || o.kind || 'point');
    if (!KINDS[kind]) throw new Error('没有这种技能方式');
    const element = String(b.element == null ? o.element || '' : b.element);
    if (!(element in ELEMENTS)) throw new Error('元素不对');
    const projectileKey = String(b.projectileKey || o.projectileKey || 'none');
    const up = this.server.features.uploads;
    if (!PROJECTILES.includes(projectileKey) && !(up && up.projectiles().includes(projectileKey))) throw new Error('没有这个弹道');
    const hpFormula = String(b.hpFormula || o.hpFormula || 'attack').trim();
    const armorFormula = String(b.armorFormula || o.armorFormula || 'breakPower').trim();
    const mpFormula = String(b.mpFormula || o.mpFormula || '10+slevel').trim();
    check(hpFormula, '伤血公式'); check(armorFormula, '伤甲公式'); check(mpFormula, '耗精力公式');
    const learn = String(b.learn || o.learn || 'book');
    if (!['book', 'level'].includes(learn)) throw new Error('学法不对');
    let iconPath = String(b.iconPath || o.iconPath || 'skills/magic_skill02_r00_c00/spriteFrame');
    if (!/^[a-z0-9_/\-]+$/i.test(iconPath)) throw new Error('图标路径不对');
    return {
      name, owner, kind, element, projectileKey, hpFormula, armorFormula, mpFormula, learn, iconPath,
      description: String(b.description == null ? o.description || '' : b.description).trim().slice(0, 200),
      range: num(b.range, 0, 2000, '射程', o.range != null ? o.range : 400),
      radius: num(b.radius, 10, 800, '作用范围', o.radius != null ? o.radius : 60),
      count: num(b.count, 1, 30, '发数', o.count || 3),
      spreadDeg: num(b.spreadDeg, 0, 180, '扇形角度', o.spreadDeg != null ? o.spreadDeg : 60),
      projectileSpeed: num(b.projectileSpeed, 100, 5000, '弹道速度', o.projectileSpeed || 900),
      cooldownMs: num(b.cooldownMs, 0, 600000, '冷却（毫秒）', o.cooldownMs != null ? o.cooldownMs : 1000),
      level: num(b.level, 1, 1200, '学习等级', o.level || 10),
      price: num(b.price, 0, 2000000000, '技能书价格', o.price != null ? o.price : 5000),
    };
  }

  save(id, b) {
    const d = this.data();
    let s = id ? d.list[id] : null;
    if (id && !s) throw new Error('没有这个技能');
    const v = this.clean(b, s);
    if (!s) { s = { id: 'cs' + d.nextId++ }; d.list[s.id] = s; }
    if (b.icon) v.iconPath = this.server.features.uploads.saveSkillIcon(s.id, b.icon);
    Object.assign(s, v);
    if (s.learn === 'book' && s.owner !== 'monster' && !s.bookId) s.bookId = FIRST_BOOK_ID + Number(s.id.slice(2));
    this.server.store.markDirty();
    this.apply();
    return (id ? '已保存技能 ' : '已新建技能 ') + s.name + (s.bookId && s.learn === 'book' ? '（技能书 ' + s.bookId + '，在杂货店和书店卖）' : '');
  }

  remove(id) {
    const s = this.get(id);
    if (!s) throw new Error('没有这个技能');
    delete this.data().list[id];
    for (const ch of Object.values(this.server.store.data.characters || {})) if (ch.professionSkills) delete ch.professionSkills[id];
    for (const p of this.server.playersById.values()) if (p.ch.professionSkills) { delete p.ch.professionSkills[id]; p.paramsDirty = true; }
    const bal = this.server.features.balance;
    if (bal) for (const [mid, o] of Object.entries(bal.cfg.monsters)) if (o.skill === id) { delete o.skill; bal.rebuild(bal.catalog().get(mid) ? bal.catalog().get(mid).maps : []); }
    this.server.store.markDirty();
    this.apply();
    return '已删除技能 ' + s.name;
  }

  // Puts every admin-made skill into the skill table, books into the catalog.
  apply() {
    for (const [id, def] of Object.entries(SD.SKILLS)) if (def.customSkill) delete SD.SKILLS[id];
    for (const [k, v] of Object.entries(SD.LEVEL_SKILLS)) SD.LEVEL_SKILLS[k] = v.filter(([, id]) => !String(id).startsWith('cs'));
    for (const [itemId, b] of [...cat.skillBooks]) if (String(b.skillId).startsWith('cs')) cat.skillBooks.delete(itemId);
    const shop = cat.catalogs.shop;
    for (let i = shop.length - 1; i >= 0; i -= 1) if (shop[i].customSkillBook) shop.splice(i, 1);
    for (const t of [...cat.templates.values()]) if (t.customSkillBook) cat.templates.delete(t.itemId);
    const C = require('../game/character');
    const pf = this.server.features.professions;
    for (const s of this.list()) {
      const custom = pf && pf.customMap()[s.owner];
      const base = custom ? custom.base : s.owner;
      const hp = compileSkill(s.hpFormula), armor = compileSkill(s.armorFormula), mp = compileSkill(s.mpFormula);
      const def = {
        id: s.id, customSkill: true, name: s.name, profession: base, customProfession: custom ? s.owner : null, kind: s.kind,
        range: s.kind === 'nova' ? 0 : s.range, radius: s.radius, spreadDeg: s.spreadDeg, attackType: KINDS[s.kind][1],
        targetMode: s.kind === 'nova' ? 'self' : 'aim', projectileKey: s.projectileKey, projectileSpeed: s.projectileSpeed,
        cooldownMs: s.cooldownMs, iconPath: s.iconPath, element: s.element || null, intervalMs: 120,
        count: ['volley', 'pellets', 'burst'].includes(s.kind) ? () => s.count : undefined,
        searchRadius: s.kind === 'seek' ? () => s.radius : undefined,
        cost: (l) => Math.max(0, Math.round(mp({ attack: 0, breakPower: 0, slevel: l, LV: 1 }))),
        custom: (vars) => ({ hp: Math.max(0, hp(vars)), armor: Math.max(0, armor(vars)) }),
        description: s.description || s.name,
        levelText: (l) => '技能等级 ' + l + '\n伤血：' + s.hpFormula + '；伤甲：' + s.armorFormula + (s.element ? '；' + ELEMENTS[s.element] + '系' : '') +
          '\n消耗 ' + Math.max(0, Math.round(mp({ attack: 0, breakPower: 0, slevel: l, LV: 1 }))) + ' 点精力' + (s.range && s.kind !== 'nova' ? '，射程 ' + s.range + ' 像素' : '') + '，最高 ' + SD.MAX_LEVEL + ' 级',
        allowed: (ch) => s.owner !== 'monster' && ch.profession === base && (!custom || ch.customProfession === s.owner),
      };
      SD.SKILLS[s.id] = def;
      if (s.owner === 'monster') continue;
      if (s.learn === 'level') { SD.LEVEL_SKILLS[base] = (SD.LEVEL_SKILLS[base] || []).concat([[s.level, s.id]]); continue; }
      if (!s.bookId) continue;
      const atlasFrom = cat.getTemplate(BOOK_ATLAS[base] || 325);
      const t = {
        itemId: s.bookId, name: s.name + '秘籍', desc: '研读后习得技能「' + s.name + '」（' + (custom ? custom.name : C.PROFESSION_LABELS[base]) + '，' + s.level + ' 级）', equipPos: 'none', tab: 'book', weight: 3,
        buyPrice: s.price, sellPrice: Math.floor(s.price / 2), durability: { cur: 1, max: 1 }, bonusAttrs: [], source: 'skill_book', customSkillBook: true,
        requirement: { professionLevels: [{ profession: base, minLevel: s.level }] }, atlas: atlasFrom && atlasFrom.atlas ? Object.assign({}, atlasFrom.atlas) : undefined,
      };
      cat.templates.set(t.itemId, t);
      if (s.price > 0) shop.push(t);
      cat.skillBooks.set(t.itemId, { profession: base, skillId: s.id, customProfession: custom ? s.owner : null });
    }
    for (const p of this.server.playersById.values()) p.paramsDirty = true;
    try { require('../admin').resetItemLists(); } catch (_) { /* admin not loaded */ }
  }

  // Book rows for /api/extra-items (the client must know the item to show it).
  clientRows() {
    return [...cat.templates.values()].filter((t) => t.customSkillBook).map((t) => ({
      itemId: t.itemId, name: t.name, desc: t.desc, equipPos: 'none', tab: 'book', buyPrice: t.buyPrice, sellPrice: t.sellPrice, weight: t.weight,
      durability: t.durability, bonusAttrs: [], atlas: t.atlas, requirement: t.requirement,
    }));
  }

  // Damage values of a skill for a player.
  playerHit(p, def, level) {
    return def.custom({ attack: p.stats.attack, breakPower: p.stats.breakPower, slevel: level, LV: p.stats.combatLevel });
  }

  // A monster's skill: the extra fields of its pending hit and the projectile to show.
  monsterCast(m) {
    const def = SD.SKILLS[m.skillId];
    if (!def || !def.customSkill) return null;
    const lvl = Math.max(1, Math.min(SD.MAX_LEVEL, Math.round((m.level || 1) / 3)));
    const v = def.custom({ attack: m.damage, breakPower: m.breakPower, slevel: lvl, LV: m.level || 1 });
    const area = ['point', 'nova', 'burst', 'pellets', 'line'].includes(def.kind);
    return {
      projectileKey: def.projectileKey && def.projectileKey !== 'none' ? def.projectileKey : null,
      projectileSpeed: def.projectileSpeed,
      hit: { custom: v, element: def.element, radius: area ? def.radius : 0, reach: Math.max(m.attackRange, def.range || 0), ranged: !!(def.projectileKey && def.projectileKey !== 'none') },
    };
  }

  test(b) {
    const v = this.clean(b, null);
    const hp = compileSkill(v.hpFormula)(SAMPLE), armor = compileSkill(v.armorFormula)(SAMPLE), mp = compileSkill(v.mpFormula)(SAMPLE);
    return '样例（攻击 300、破坏 200、技能 10 级、战斗 30 级）：伤血 ' + Math.round(hp) + '，伤甲 ' + Math.round(armor) + '，耗精力 ' + Math.round(mp);
  }
}

module.exports = { CustomSkills, compileSkill, KINDS };
