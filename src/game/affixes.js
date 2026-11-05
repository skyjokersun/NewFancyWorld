'use strict';
// Item affix data.
// - The 吸取 gems (磁性玉 series): 磁性玉碎片 吸取生命 1% (窃取), 次磁性玉 吸取精力 2%
//   (狐妖), 磁性玉 吸取生命 4% (黑洞), as in the shipped catalog.
// - Legacy monster drops carry a prefix and a suffix id (e.g. 452 = 血蝠); the last digit
//   is the grade (1-3). Both take their values from the original item table (PREFIXES,
//   SUFFIXES below, affixVersion 5); a name not in the table keeps a hashed bonus.
// - The client colours an item name by ext.legacyPrefixId / smithPrefixItemId and
//   ext.legacySuffixId / smithAttributeItemId (white, purple with one affix, gold
//   with two); markAffixColour sets the smith ids for affixes added on the server.
const cat = require('./catalog');

const LABELS = {
  lifeStealPercent: ['吸取生命', '%'], staminaStealPercent: ['吸取精力', '%'],
  fireDamage: ['火伤害', ''], iceDamage: ['冰伤害', ''], thunderDamage: ['雷伤害', ''], poisonDamage: ['毒伤害', ''],
  fireDamagePercent: ['火伤害', '%'], iceDamagePercent: ['冰伤害', '%'], thunderDamagePercent: ['雷伤害', '%'],
  poisonDamagePercent: ['毒伤害', '%'],
  farSkillPercent: ['远程技能攻击', '%'], nearSkillPercent: ['近战技能攻击', '%'], gunSkillPercent: ['枪械技能攻击', '%'], magicSkillPercent: ['魔法技能攻击', '%'], damageReflectPercent: ['伤害反弹', '%'], hitPercent: ['命中率', '%'],
  agility: ['敏捷', ''], perception: ['感知', ''], attack: ['攻击', ''], breakPower: ['破坏力', ''], defense: ['防御', ''],
  maxHpPercent: ['生命上限', '%'], maxStaminaPercent: ['精力上限', '%'], professionSkillPercent: ['职业技能攻击', '%'],
  attackSpeedPercent: ['攻击速度', '%'],
  skill_ranged_weapon: ['远程武器', ''], skill_melee_weapon: ['近身武器', ''], skill_mechanics: ['器械操作', ''], skill_magic: ['魔力', ''], skill_judgement: ['判断力', ''],
  fireResist: ['火抗', ''], iceResist: ['冰抗', ''], thunderResist: ['雷抗', ''], poisonResist: ['毒抗', ''],
};
function attr(key, value) { const l = LABELS[key]; return { key, value, display: l[0] + '+' + value + l[1] }; }

// The 吸取 gems: 磁性玉碎片 吸血 1% (窃取), 次磁性玉 吸精 2% (狐妖), 磁性玉 吸血 4% (黑洞).
const STEAL_GEMS = { 1671: ['lifeStealPercent', 1], 1681: ['staminaStealPercent', 2], 1691: ['lifeStealPercent', 4] };
for (const [id, [key, v]] of Object.entries(STEAL_GEMS)) {
  const t = cat.getTemplate(Number(id));
  if (t) t.bonusAttrs = [attr(key, v)];
}
// 6: thirteenth batch, official tables and flat element attack.
// 7: fourteenth batch, the afar / anear / aoper / amagic / alook prefixes give combat skill points.
const AFFIX_VERSION = 7;

// The official old client's affix tables (research round 17: data/itemprefix 141 rows,
// itemsuffix 170 rows; data/original-tables.json). Thirteenth batch: they replace the
// earlier list typed from 奇域道具.txt, and an id in the table gives exactly its row.
// - Element attack (afire / apoison / abolt / aice) is a flat value, not a percent.
// - The suffix protection columns are stored swapped in the original; the Chinese
//   meaning wins (防烫 = fire, 防毒 = poison, 防电 = thunder, 防冻 = ice; 36 of 36 agree).
// - Profession skill prefixes: 远程 (archer), 近战 (warrior), 枪械 (gunner), 魔法 (mage).
const ORIGINAL = require('../../data/original-tables.json');
const OFFICIAL_PREFIX = ORIGINAL.prefixes;
// Fourteenth batch: in itemprefix.tab the columns afar, anear, aoper, amagic and alook are
// combat skill points (远程武器, 近身武器, 器械操作, 魔力, 判断力), not skill attack % and 感知
// as the thirteenth batch read them. They occur only in 造箭者 ... 全能 (FID 711-813).
const SKILL_POINT_KEYS = { farSkillPercent: 'skill_ranged_weapon', nearSkillPercent: 'skill_melee_weapon', gunSkillPercent: 'skill_mechanics', magicSkillPercent: 'skill_magic', perception: 'skill_judgement' };
const SKILL_POINT_PREFIXES = new Set();
for (const [id, r] of Object.entries(OFFICIAL_PREFIX)) {
  if (Number(id) < 711 || Number(id) > 813) continue;
  SKILL_POINT_PREFIXES.add(r.name);
  r.attrs = r.attrs.map(([k, v]) => [SKILL_POINT_KEYS[k] || k, v]);
}
function remapSkillPoints(part) {
  if (!part || !Array.isArray(part.attrs) || !SKILL_POINT_PREFIXES.has(String(part.name || '').replace(/的$/, ''))) return false;
  let changed = false;
  part.attrs = part.attrs.map((a) => {
    const k = SKILL_POINT_KEYS[a.key];
    if (!k) return a;
    changed = true;
    return attr(k, a.value);
  });
  return changed;
}
const OFFICIAL_SUFFIX = ORIGINAL.suffixes;
// name -> [[key, values by grade]] (grade = last digit of the id, rows sorted by id).
function byName(table) {
  const out = {};
  for (const id of Object.keys(table).sort((a, b) => Number(a) - Number(b))) {
    const r = table[id];
    const g = grade(id);
    const row = out[r.name] = out[r.name] || [];
    for (const [key, v] of r.attrs) {
      let e = row.find((x) => x[0] === key);
      if (!e) { e = [key, []]; row.push(e); }
      e[1][g - 1] = v;
    }
  }
  for (const row of Object.values(out)) for (const e of row) { for (let i = 0; i < e[1].length; i += 1) if (e[1][i] == null) e[1][i] = e[1][i - 1] || e[1].find((x) => x != null); }
  return out;
}
const PREFIXES = byName(OFFICIAL_PREFIX);
const SUFFIXES = byName(OFFICIAL_SUFFIX);
// Spellings seen on older drops.
PREFIXES.刚 = PREFIXES.钢; PREFIXES.狂暴 = PREFIXES.狂暴战士; PREFIXES.蜥蜴 = PREFIXES.晰蜴;

function grade(id) { const g = Number(id) % 10; return g >= 1 && g <= 3 ? g : 1; }
function tableAttrs(table, id, name, official) {
  const clean = String(name || '').replace(/的$/, '');
  const exact = official && official[String(Number(id))];
  if (exact && (!clean || exact.name === clean || table[clean] === table[exact.name])) return exact.attrs.map(([key, v]) => attr(key, v));
  const row = table[clean];
  if (!row) return null;
  const g = grade(id);
  return row.map(([key, values]) => attr(key, values[Math.min(g, values.length) - 1]));
}
function legacySuffixAttrs(id, name) { return tableAttrs(SUFFIXES, id, name, OFFICIAL_SUFFIX); }
function legacyPrefixAttrs(id, name) { return tableAttrs(PREFIXES, id, name, OFFICIAL_PREFIX); }

// A bonus for a legacy prefix or suffix whose name is not in the table.
function legacyHashAttrs(prefixId, suffixId) {
  const seed = (prefixId || 0) * 31 + (suffixId || 0);
  const keys = ['attack', 'defense', 'maxHp', 'breakPower', 'fireResist', 'iceResist'];
  const labels = { attack: '攻击', defense: '防御', maxHp: '最大生命', breakPower: '破防', fireResist: '火抗', iceResist: '冰抗' };
  const key = keys[seed % keys.length];
  const value = 3 + (seed % 17);
  return [{ key, value, display: labels[key] + '+' + value }];
}

// Builds ext.affix for a legacy drop (d: the drop entry, or the item's own ext) and rebuilds the item.
function applyLegacyAffix(item, d) {
  const D = require('../features/crafting/data');
  const pid = Number(d.legacyPrefixId) || 0, sid = Number(d.legacySuffixId) || 0;
  const name = String(d.name || item.name || '');
  const pname = d.legacyPrefixName || (pid ? ((/^(.+?的)/.exec(name) || [])[1] || '') : '');
  const sname = d.legacySuffixName || (sid && name.lastIndexOf('·') >= 0 ? name.slice(name.lastIndexOf('·') + 1) : '');
  const suffixAttrs = sid ? legacySuffixAttrs(sid, sname) : null;
  const affix = { prefix: null, suffix: null };
  // Names in the original table give its values; an unknown name keeps the hashed bonus.
  if (pid) affix.prefix = { name: pname, attrs: legacyPrefixAttrs(pid, pname) || legacyHashAttrs(pid, sid) };
  if (sid) affix.suffix = { name: sname, attrs: suffixAttrs || (pid ? [] : legacyHashAttrs(pid, sid)) };
  item.ext = Object.assign({}, item.ext, { legacyPrefixId: pid || undefined, legacySuffixId: sid || undefined, affixVersion: AFFIX_VERSION });
  D.rebuildItem(item, affix);
  return item;
}

function markAffixColour(item) {
  const ext = item.ext || {};
  const a = ext.affix || {};
  if (a.prefix) ext.smithPrefixItemId = ext.fusedPrefixMaterialId || ext.legacyPrefixId || 1; else delete ext.smithPrefixItemId;
  if (a.suffix) ext.smithAttributeItemId = ext.fusedAttributeMaterialId || ext.legacySuffixId || 1; else delete ext.smithAttributeItemId;
  item.ext = ext;
}

// Weapon-shop special offers (twelfth batch, Q14): the same table as drops and fusion.
// Weapons draw from the attack / break / skill prefixes and the element, hit, steal and
// speed suffixes; armour and jewellery from the defence / HP / stamina / perception
// prefixes and the resist and reflect suffixes. The grade (1-3) follows the item level.
const WEAPON_KEYS = new Set(['attack', 'breakPower', 'professionSkillPercent', 'farSkillPercent', 'nearSkillPercent', 'gunSkillPercent', 'magicSkillPercent', 'skill_ranged_weapon', 'skill_melee_weapon', 'skill_mechanics', 'skill_magic', 'fireDamage', 'iceDamage', 'thunderDamage', 'poisonDamage', 'hitPercent', 'lifeStealPercent', 'staminaStealPercent', 'attackSpeedPercent']);
function pickRow(table, weapon) {
  // Not the aliases, not the 小酒窝 精英 set and nothing that lowers a value (沉睡 etc.).
  const names = Object.keys(table).filter((n) => !['精英', '刚', '狂暴', '蜥蜴'].includes(n) &&
    table[n].every(([k, vs]) => (WEAPON_KEYS.has(k) === weapon || /Resist$/.test(k) && !weapon) && vs.every((v) => v > 0)));
  return names[Math.floor(Math.random() * names.length)];
}
function randomShopAffix(item, isWeapon, itemLevel) {
  const D = require('../features/crafting/data');
  const g = itemLevel >= 45 ? 3 : itemLevel >= 20 ? 2 : 1;
  const id = 1000 + g;   // only the last digit (the grade) matters
  let wantP = Math.random() < 0.7, wantS = Math.random() < 0.6;
  if (!wantP && !wantS) { if (Math.random() < 0.5) wantP = true; else wantS = true; }
  const affix = { prefix: null, suffix: null };
  const pn = wantP && pickRow(PREFIXES, isWeapon);
  const sn = wantS && pickRow(SUFFIXES, isWeapon);
  if (pn) affix.prefix = { name: pn + '的', attrs: legacyPrefixAttrs(id, pn) };
  if (sn) affix.suffix = { name: sn, attrs: legacySuffixAttrs(id, sn) };
  item.ext = Object.assign({}, item.ext, { affixVersion: AFFIX_VERSION, shopAffix: true });
  D.rebuildItem(item, affix);
  return item;
}

// Thirteenth batch: element attack became a flat value; an old percent counts 1 for 1.
const FLAT_ELEMENT = { fireDamagePercent: 'fireDamage', iceDamagePercent: 'iceDamage', thunderDamagePercent: 'thunderDamage', poisonDamagePercent: 'poisonDamage' };
function flatElementAttrs(list) {
  let changed = false;
  for (const a of list || []) {
    const k = FLAT_ELEMENT[a.key];
    if (!k) continue;
    a.key = k; a.display = LABELS[k][0] + '+' + a.value; changed = true;
  }
  return changed;
}
function flatElementItem(item) {
  let changed = flatElementAttrs(item.bonusAttrs);
  const a = item.ext && item.ext.affix;
  if (a) for (const part of [a.prefix, a.suffix]) if (part && flatElementAttrs(part.attrs)) changed = true;
  return changed;
}
// Gem templates carry the flat key too.
for (const t of cat.templates.values()) if (flatElementAttrs(t.bonusAttrs)) t.flatElement = true;

// Brings an item saved before these rules up to date. Returns true when it changed.
function migrateItem(item) {
  if (!item || !item.itemId) return false;
  const ext = item.ext || {};
  if (ext.affixVersion >= AFFIX_VERSION) return false;
  const renamed = flatElementItem(item);
  const D = require('../features/crafting/data');
  if (!ext.affix && (ext.legacyPrefixId > 0 || ext.legacySuffixId > 0)) {
    applyLegacyAffix(item, ext);
    return true;
  }
  if (ext.affix && (ext.affix.prefix || ext.affix.suffix)) {
    const a = ext.affix;
    // Legacy prefixes and suffixes take the original table's values (version 5).
    if (a.prefix && ext.legacyPrefixId > 0 && !ext.fusedPrefixMaterialId) {
      const pa = legacyPrefixAttrs(ext.legacyPrefixId, a.prefix.name);
      if (pa) a.prefix.attrs = pa;
    }
    // Shop and fusion prefixes with no legacy id: just the new keys (version 7).
    if (a.prefix && !(ext.legacyPrefixId > 0)) remapSkillPoints(a.prefix);
    const gemId = ext.fusedAttributeMaterialId;
    const gem = gemId && cat.getTemplate(gemId);
    if (a.suffix && gem && D.gemInfo(gemId)) {
      if (STEAL_GEMS[gemId]) a.suffix.attrs = gem.bonusAttrs.map((x) => Object.assign({}, x));
      if (!ext.legacySuffixName) a.suffix.name = D.gemInfo(gemId).suffix;
    } else if (a.suffix && ext.legacySuffixId > 0 && !gemId) {
      const sa = legacySuffixAttrs(ext.legacySuffixId, a.suffix.name);
      if (sa) a.suffix.attrs = sa;
    }
    D.rebuildItem(item, { prefix: a.prefix || null, suffix: a.suffix || null });
    item.ext.affixVersion = AFFIX_VERSION;
    return true;
  }
  // A plain 吸取 gem: the catalog bonus. Other plain items are left alone so they still stack.
  if (STEAL_GEMS[item.itemId]) {
    const next = cat.getTemplate(item.itemId).bonusAttrs.map((x) => Object.assign({}, x));
    if (JSON.stringify(next) !== JSON.stringify(item.bonusAttrs || [])) { item.bonusAttrs = next; return true; }
  }
  return renamed;
}

module.exports = { OFFICIAL_PREFIX, OFFICIAL_SUFFIX, FLAT_ELEMENT, flatElementItem, randomShopAffix, AFFIX_VERSION, PREFIXES, SUFFIXES, legacyPrefixAttrs, legacySuffixAttrs, applyLegacyAffix, markAffixColour, migrateItem, STEAL_GEMS };
