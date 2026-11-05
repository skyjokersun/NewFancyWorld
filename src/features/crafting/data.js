'use strict';
// Craftsman data: ore / ingot / bar templates, skill curves, forge recipes,
// fusion tiers and the affix bookkeeping shared by fusion and the mystic smith.
const cat = require('../../game/catalog');

const METALS = [
  { key: 'cu', name: '铜', ore: 2689, ingot: 2698, level: 1 },
  { key: 'sn', name: '锡', ore: 2690, ingot: 2699, level: 1 },
  { key: 'fe', name: '铁', ore: 2691, ingot: 2700, level: 1 },
  { key: 'al', name: '铝', ore: 2692, ingot: 2701, level: 20 },
  { key: 'w', name: '钨', ore: 2693, ingot: 2702, level: 20 },
  { key: 'mn', name: '锰', ore: 2694, ingot: 2703, level: 20 },
  { key: 'ag', name: '银', ore: 2695, ingot: 2704, level: 40 },
  { key: 'ti', name: '钛', ore: 2696, ingot: 2705, level: 40 },
  { key: 'xfe', name: '玄铁', ore: 2697, ingot: 2706, level: 40 },
];
const BARS = [
  { itemId: 2707, name: '青铜条', price: 300 },
  { itemId: 2708, name: '钢条', price: 600 },
  { itemId: 2709, name: '精钢条', price: 1200 },
  { itemId: 2710, name: '合金条', price: 2400 },
  { itemId: 2711, name: '秘银条', price: 5000 },
  { itemId: 2712, name: '复合金属条', price: 9000 },
  { itemId: 2713, name: '玄晶', price: 16000 },
];
const ORE_BY_ID = new Map(METALS.map((m) => [m.ore, m]));
const INGOT_BY_ID = new Map(METALS.map((m) => [m.ingot, m]));

function addMaterial(itemId, name, desc, price, weight) {
  if (cat.templates.has(itemId)) return;
  cat.templates.set(itemId, {
    itemId, name, desc, equipPos: 'none', tab: 'misc', buyPrice: price, sellPrice: Math.max(1, Math.floor(price / 2)),
    weight, durability: { cur: 1, max: 1 }, bonusAttrs: [], source: 'crafting',
  });
}
for (const m of METALS) {
  addMaterial(m.ore, m.name + '矿石', '从矿山开采的' + m.name + '矿石，可以在炼矿熔炉里提炼成' + m.name + '锭。', 20 + m.level * 4, 3);
  addMaterial(m.ingot, m.name + '锭', '提炼好的' + m.name + '锭，工匠打造装备的原料。', 60 + m.level * 10, 2);
}
for (const b of BARS) addMaterial(b.itemId, b.name, '工匠打造装备用的辅助原料。', b.price, 1);

// Craft skills: level L -> L+1 needs 20*L exp, capped at 100.
const SKILL_CAP = 100;
const skillTotals = [0, 0];
for (let l = 2; l <= SKILL_CAP; l += 1) skillTotals[l] = skillTotals[l - 1] + 20 * (l - 1);
function skillLevel(exp) {
  let l = 1;
  while (l < SKILL_CAP && skillTotals[l + 1] <= exp) l += 1;
  return l;
}
// The original client's craftsman titles (swork/smither/baseinfo.fcc), on the web version's level bands.
const TITLES = [[100, '大宗师'], [75, '宗师'], [50, '大师'], [35, '专家'], [20, '专业'], [10, '学徒'], [1, '门外汉']];
function skillTitle(level) { return TITLES.find(([l]) => level >= l)[1]; }

function craftState(ch) {
  ch.crafting = ch.crafting || {};
  for (const k of ['mining', 'smelting', 'forging', 'fusion', 'repair']) {
    ch.crafting[k] = ch.crafting[k] || { exp: 0, successes: 0, attempts: 0 };
  }
  ch.crafting.ores = ch.crafting.ores || {};
  return ch.crafting;
}

function skillSummary(rec) {
  const level = skillLevel(rec.exp);
  return {
    level, title: skillTitle(level), totalExp: rec.exp,
    nextLevelTotalExp: level >= SKILL_CAP ? null : skillTotals[level + 1],
    totalSuccesses: rec.successes, totalAttempts: rec.attempts,
  };
}

// Adds exp; returns progression messages for level-ups.
function gainSkill(ch, key, exp, label, success = true) {
  const rec = craftState(ch)[key];
  const before = skillLevel(rec.exp);
  rec.attempts += 1;
  if (success) { rec.successes += 1; rec.exp += exp; }
  const after = skillLevel(rec.exp);
  return after > before ? [label + '技能提升到 ' + after + ' 级（' + skillTitle(after) + '）！'] : [];
}

// ---------- equipment ----------
function itemLevel(t) {
  const req = (t && t.requirement && t.requirement.professionLevels) || [];
  return req.reduce((m, e) => Math.max(m, e.minLevel || 0), 0);
}
function isEquipment(item) { return !!cat.slotForTemplate(cat.getTemplate(item && item.itemId)); }

// Metal tier from equipment level (0..8) and forge skill level for a target.
function metalFor(level) { return METALS[Math.min(METALS.length - 1, Math.floor(level / 25))]; }
function forgeLevelFor(level) { return Math.max(1, Math.min(SKILL_CAP, Math.round(level / 2))); }

const RECIPES = [];
for (const t of cat.catalogs.shop) {
  const slot = cat.slotForTemplate(t);
  if (!slot || !(t.buyPrice > 0) || !(t.bonusAttrs || []).length) continue;
  const lvl = itemLevel(t);
  const metal = metalFor(lvl);
  const ingots = slot === 'weapon' ? 3 : slot === 'armor' ? 4 : 2;
  const materials = [{ itemId: metal.ingot, count: ingots + Math.floor(lvl / 60) }];
  const barIndex = Math.min(BARS.length - 1, Math.floor(lvl / 30));
  if (lvl >= 10) materials.push({ itemId: BARS[barIndex].itemId, count: 1 });
  if (lvl >= 60) materials.push({ itemId: metalFor(Math.max(0, lvl - 50)).ingot, count: 2 });
  RECIPES.push({ itemId: t.itemId, name: t.name, requiredLevel: forgeLevelFor(lvl), itemLevel: lvl, materials });
}
RECIPES.sort((a, b) => a.requiredLevel - b.requiredLevel || a.itemId - b.itemId);
const RECIPE_BY_ID = new Map(RECIPES.map((r) => [r.itemId, r]));

// ---------- fusion ----------
const ENGRAVING_TYPES = ['蛮族', '蛇纹', '勇者', '龟纹', '巨人', '贤者', '导师', '英雄'];
const GEM_TYPES = [
  { base: 0, suffix: '火焰' }, { base: 1, suffix: '寒冰' }, { base: 2, suffix: '雷电' }, { base: 3, suffix: '剧毒' },
  { base: 5, suffix: '反弹' }, { base: 6, suffix: '吸取' }, { base: 8, suffix: '精确' },
];
const GRADE_LEVELS = [1, 20, 50, 90];
function engravingInfo(itemId) {
  // Twelfth batch: engravings made on the admin page (template.affixItem).
  const at = cat.getTemplate(itemId);
  if (at && at.affixItem && at.affixItem.kind === 'prefix') return { grade: at.affixItem.grade || 0, type: at.affixItem.name, prefix: at.affixItem.name };
  if (itemId < 2305 || itemId > 2336) return null;
  const n = itemId - 2305;
  return { grade: Math.floor(n / 8), type: ENGRAVING_TYPES[n % 8], prefix: ENGRAVING_TYPES[n % 8] + '的' };
}
// The suffix a gem gives, named like the legacy drop suffixes of the original game
// (legacy suffix ids 11x 火 ... 45x 血蝠/吸血鬼, 48x 黑洞, 53x 稳定, 54x 精确).
const GEM_SUFFIX_NAMES = {
  1665: '火', 1675: '炎', 1685: '烈焰', 1695: '地狱火',
  1666: '冰', 1676: '冰雹', 1686: '寒冰', 1696: '冰川',
  1667: '雷', 1677: '雷暴', 1687: '狂雷', 1697: '狂雷',
  1668: '毒', 1678: '毒蛇', 1688: '蝎子', 1698: '毒妇',
  1670: '复仇', 1680: '镜', 1690: '镜',
  1671: '窃取', 1681: '狐妖', 1691: '黑洞',
  1673: '稳定', 1683: '精确', 1693: '精确',
  1704: '钻石',
};
// 小酒窝 fusion stones: 不灭龙魂之印 (life +70%) and 冰焰两仪石 (ice and fire damage +200%).
const SPECIAL_GEMS = { 3493: { grade: 3, suffix: '不灭龙魂' }, 3497: { grade: 3, suffix: '冰焰' } };
function gemInfo(itemId) {
  const at = cat.getTemplate(itemId);
  if (at && at.affixItem && at.affixItem.kind === 'suffix') return { grade: at.affixItem.grade || 0, suffix: at.affixItem.name };
  if (SPECIAL_GEMS[itemId]) return cat.getTemplate(itemId) ? Object.assign({}, SPECIAL_GEMS[itemId]) : null;
  if (itemId === 1704) return cat.getTemplate(itemId) ? { grade: 3, suffix: GEM_SUFFIX_NAMES[1704] } : null; // 高纯钻石
  if (itemId < 1665 || itemId > 1698) return null;
  const n = itemId - 1665;
  const grade = Math.floor(n / 10);
  const g = GEM_TYPES.find((x) => x.base === n % 10);
  return g && cat.getTemplate(itemId) ? { grade, suffix: GEM_SUFFIX_NAMES[itemId] || g.suffix } : null;
}

const FUSION_TIERS = [1, 10, 20, 35, 50, 70, 90];
function fusionTierFor(level) {
  let tier = 0;
  for (let i = 0; i < FUSION_TIERS.length; i += 1) if (forgeLevelFor(level) >= FUSION_TIERS[i]) tier = i;
  return tier;
}

// Affix bookkeeping: ext.affix = {prefix:{name, attrs}, suffix:{name, attrs}}.
function baseName(item) {
  const t = cat.getTemplate(item.itemId);
  return t ? t.name : item.name;
}
function affixOf(item) {
  const ext = item.ext || {};
  const a = ext.affix || {};
  const out = { prefix: a.prefix || null, suffix: a.suffix || null };
  if (!out.prefix && ext.legacyPrefixId > 0) {
    const m = /^(.+?的)/.exec(item.name);
    out.prefix = { name: m ? m[1] : '', attrs: null, legacy: true };
  }
  if (!out.suffix && ext.legacySuffixId > 0) {
    const i = item.name.lastIndexOf('·');
    out.suffix = { name: i >= 0 ? item.name.slice(i + 1) : '', attrs: null, legacy: true };
  }
  return out;
}
function rebuildItem(item, affix) {
  const t = cat.getTemplate(item.itemId);
  const attrs = (t ? t.bonusAttrs : []).map((a) => Object.assign({}, a));
  for (const part of [affix.prefix, affix.suffix]) {
    for (const a of (part && part.attrs) || []) {
      const cur = attrs.find((x) => x.key === a.key);
      if (cur) { cur.value += a.value; cur.display = displayFor(cur.key, cur.value, cur.display); } else attrs.push(Object.assign({}, a));
    }
  }
  item.bonusAttrs = attrs;
  item.name = (affix.prefix ? affix.prefix.name : '') + baseName(item) + (affix.suffix && affix.suffix.name ? '·' + affix.suffix.name : '');
  const ext = Object.assign({}, item.ext);
  ext.affix = { prefix: affix.prefix, suffix: affix.suffix };
  if (!affix.prefix) { delete ext.legacyPrefixId; delete ext.fusedPrefixMaterialId; }
  if (!affix.suffix) { delete ext.legacySuffixId; delete ext.fusedAttributeMaterialId; }
  item.ext = ext;
  require('../../game/affixes').markAffixColour(item);
  return item;
}
function displayFor(key, value, sample) {
  const label = String(sample || '').replace(/[+\-]?\d+(\.\d+)?%?$/, '');
  const pct = /%$/.test(String(sample || ''));
  return label + '+' + value + (pct ? '%' : '');
}
// Legacy drop affixes added their bonus straight into bonusAttrs; recover it
// as the difference to the template so removing the affix removes the bonus.
function legacyAffixAttrs(item) {
  const t = cat.getTemplate(item.itemId);
  const base = new Map(((t && t.bonusAttrs) || []).map((a) => [a.key, a.value]));
  return (item.bonusAttrs || []).filter((a) => a.value !== (base.get(a.key) || 0))
    .map((a) => ({ key: a.key, value: a.value - (base.get(a.key) || 0), display: a.display }));
}

// Affix with attrs filled in for legacy parts (their shared bonus goes to the first one).
function normalizedAffix(item) {
  const a = affixOf(item);
  const legacy = [a.prefix, a.suffix].filter((x) => x && x.legacy);
  if (legacy.length) {
    const diff = legacyAffixAttrs(item);
    legacy.forEach((x, i) => { x.attrs = i === 0 ? diff : []; delete x.legacy; });
  }
  return a;
}

// The smithy material seller's default goods.
const MATERIAL_SHOP = [2698, 2699, 2700, 2707, 2708, 2709, 2305, 2306, 2308, 1665, 1666, 1667, 1668];

module.exports = {
  MATERIAL_SHOP, METALS, BARS, ORE_BY_ID, INGOT_BY_ID, SKILL_CAP, skillLevel, skillTitle, skillTotals, craftState, skillSummary, gainSkill,
  itemLevel, isEquipment, RECIPES, RECIPE_BY_ID, forgeLevelFor, ENGRAVING_TYPES, GEM_TYPES, GEM_SUFFIX_NAMES, GRADE_LEVELS, engravingInfo, gemInfo,
  FUSION_TIERS, fusionTierFor, affixOf, normalizedAffix, rebuildItem, legacyAffixAttrs, baseName,
};
