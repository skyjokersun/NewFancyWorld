'use strict';
// Static game data: item templates (from the shipped shop catalog and map drop
// tables), equipment slot mapping and consumable effects.
const fs = require('fs');
const path = require('path');
const config = require('../config');

const catalogs = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'client-catalogs.json'), 'utf8'));
const protocol = catalogs.protocol;

// equipPos (catalog) -> equipment slot (protocol EquipSlot).
const EQUIP_POS_TO_SLOT = {
  weapon: 'weapon', helmet: 'helmet', bracelet: 'shoulder', armor: 'armor',
  pants: 'knee', shoes: 'boots', necklace: 'necklace', ring: 'gloves',
};
const EQUIP_SLOTS = ['weapon', 'helmet', 'shoulder', 'armor', 'knee', 'boots', 'necklace', 'gloves'];

const templates = new Map();
for (const s of catalogs.shop) templates.set(s.itemId, Object.assign({ source: 'shop' }, s));

// The original client's profession names (com/basedata.fcc): 战士 猎人 法师 枪手 工匠 园丁.
// The web client says 弓箭手 / 魔法师 in places; patch 88 renames them on screen, and
// the server uses the original words too (twelfth batch).
if (protocol.PROFESSION_LABELS) Object.assign(protocol.PROFESSION_LABELS, { archer: '猎人', mage: '法师', craftsman: '工匠', gardener: '园丁' });
function professionWording(v) { return typeof v === 'string' ? v.replace(/弓箭手/g, '猎人').replace(/魔法师/g, '法师') : v; }
for (const b of catalogs.qiaoqiaoBlindBoxes || []) b.name = professionWording(b.name);
for (const s of catalogs.shop) if ([301, 302, 303, 591, 592, 1164].includes(s.itemId)) s.desc = professionWording(s.desc);

const blindBoxes = new Map();
for (const b of catalogs.qiaoqiaoBlindBoxes || []) {
  blindBoxes.set(b.itemId, b);
  if (!templates.has(b.itemId)) {
    templates.set(b.itemId, {
      itemId: b.itemId, name: b.name, desc: b.desc, equipPos: 'none', tab: b.tab, buyPrice: b.buyPrice,
      sellPrice: Math.floor(b.buyPrice / 2), weight: 1, durability: { cur: 1, max: 1 }, bonusAttrs: [], source: 'blindbox',
      blindBoxPos: b.equipPos,
    });
  }
}

// Extra custom items the client knows by id.
const CUSTOM = {
  FIREWORK: 900001, FOX_FUR_LV1: 2586, FOX_FUR_LV2: 900002, FOX_FUR_LV3: 900003, FOX_FUR_LV4: 900004,
};
function addCustom(itemId, name, desc, extra = {}) {
  if (templates.has(itemId)) return;
  templates.set(itemId, Object.assign({
    itemId, name, desc, equipPos: 'none', tab: 'misc', buyPrice: 0, sellPrice: 1, weight: 1,
    durability: { cur: 1, max: 1 }, bonusAttrs: [], source: 'custom',
  }, extra));
}
addCustom(CUSTOM.FIREWORK, '烟花', '放置在地上可以燃放的烟花。', { buyPrice: 200, sellPrice: 100 });
// The red 狐狸皮 summons every 狐仙 level. The LV2-LV4 furs only stay known so old
// records still load; the item feature removes them from bags and coffers.
templates.delete(CUSTOM.FOX_FUR_LV1);
addCustom(CUSTOM.FOX_FUR_LV1, '狐狸皮', '狐狸的毛皮，柔软而滑顺。在猎场右键使用可召唤狐仙：LV1 需 100 张，LV2 需 200 张，LV3 需 300 张，LV4 需 400 张。', { sellPrice: 1 });
addCustom(CUSTOM.FOX_FUR_LV2, '狐仙皮毛LV2（已停用）', '已停用。');
addCustom(CUSTOM.FOX_FUR_LV3, '狐仙皮毛LV3（已停用）', '已停用。');
addCustom(CUSTOM.FOX_FUR_LV4, '狐仙皮毛LV4（已停用）', '已停用。');

// Items the web client lacks: the 39 小酒窝 V20.5 items and the night-market crickets,
// firefly and 波波灯 (ninth batch). Each has its own cell
// below the original icon sheet; item-atlas.js fills it from
// custom_assets/item-icons/<itemId>.png and patch 26 tells the client about them.
const extraItems = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'extra-items.json'), 'utf8')).items;
for (const t of extraItems) if (!templates.has(t.itemId)) templates.set(t.itemId, Object.assign({ source: 'xiaojiuwo' }, t));

// Eleventh batch equipment rules. These templates' requirements replace whatever an
// item carries (reqOverride), so items made before V11 follow them too.
// - 784 大砍刀: warriors only; not sold or dropped for now (BLOCKED_ITEMS).
// - 602 封印的火枪, 3444 封印纹章: sealed, nobody can wear them (3444 keeps its level 60).
// - Ten pieces get their original level back, as a profession level for every profession.
const BLOCKED_ITEMS = new Set([784]);
const SEALED_TEXT = '（封印中，暂不可装备）';
const ANY_LEVEL = { 1515: 40, 1516: 60, 1517: 80, 1518: 100, 1519: 120, 1572: 10, 1571: 50, 1569: 80, 1560: 100, 1570: 130 };
function overrideRequirement(itemId, requirement, desc) {
  const t = templates.get(itemId);
  if (!t) return;
  t.requirement = requirement;
  t.reqOverride = true;
  if (desc && !String(t.desc || '').includes(desc)) t.desc = (t.desc || '') + desc;
}
overrideRequirement(784, { professionLevels: [{ profession: 'warrior', minLevel: 1 }] });
overrideRequirement(602, { sealed: true }, SEALED_TEXT);
overrideRequirement(3444, { sealed: true, professionLevels: [{ profession: 'any', minLevel: 60 }] }, SEALED_TEXT);
for (const [id, lvl] of Object.entries(ANY_LEVEL)) overrideRequirement(Number(id), { professionLevels: [{ profession: 'any', minLevel: lvl }] });

// The requirement that applies to an item: the template's when it overrides, else the item's own.
function requirementOf(item) {
  const t = item && templates.get(Number(item.itemId));
  return t && t.reqOverride ? t.requirement : item && item.requirement;
}
// Brings an item made earlier up to its template's overridden requirement and text.
function refreshItem(it) {
  const t = it && templates.get(Number(it.itemId));
  if (!t || !t.reqOverride) return false;
  const want = JSON.stringify(t.requirement);
  const desc = t.requirement.sealed ? t.desc : it.desc;
  if (JSON.stringify(it.requirement || null) === want && it.desc === desc) return false;
  it.requirement = JSON.parse(want);
  it.desc = desc;
  return true;
}

// Monster drop items not sold anywhere: register a material template from the drop entry.
function registerDropTemplates(mapRegistry) {
  for (const id of mapRegistry.ids()) {
    const doc = mapRegistry.rawDoc(id);
    const entries = (doc && doc.monsterSpawns && doc.monsterSpawns.entries) || [];
    for (const e of entries) {
      for (const d of e.drops || []) {
        if (d.type !== 'item' || !d.itemId || templates.has(d.itemId)) continue;
        const baseName = String(d.name || '').split('·')[0];
        templates.set(d.itemId, {
          itemId: d.itemId, name: baseName || ('物品' + d.itemId), desc: baseName, equipPos: 'none', tab: 'misc',
          buyPrice: 0, sellPrice: 5, weight: 1, durability: { cur: 1, max: 1 }, bonusAttrs: [], source: 'drop',
        });
      }
    }
  }
}

const consumableIds = new Set(catalogs.consumableIds || []);
const skillBooks = new Map([
  [302, { profession: 'archer', skillId: 'hunter_jinshot' }],
  [303, { profession: 'archer', skillId: 'hunter_feihuang_arrow' }],
  [352, { profession: 'gunner', skillId: 'gunner_point_shot' }],
  [353, { profession: 'gunner', skillId: 'gunner_scatter_shot' }],
  [325, { profession: 'mage', skillId: 'mage_ice_shockwave' }],
  [326, { profession: 'mage', skillId: 'mage_fireball' }],
  [311, { profession: 'warrior', skillId: 'warrior_jianqi' }],
  // 小酒窝 books (tenth batch): 罡气心法, 冲击心法 and 狂怒秘籍 teach the existing skills.
  [312, { profession: 'warrior', skillId: 'warrior_gangqi' }],
  [313, { profession: 'warrior', skillId: 'warrior_charge' }],
  [3501, { profession: 'warrior', skillId: 'warrior_rage' }],
]);

function getTemplate(itemId) { return templates.get(Number(itemId)) || null; }
function slotForTemplate(t) { return t ? (EQUIP_POS_TO_SLOT[t.equipPos] || null) : null; }
function isStackable(t) {
  if (!t) return false;
  if (slotForTemplate(t)) return false;
  return true;
}

module.exports = {
  catalogs, protocol, templates, extraItems, blindBoxes, consumableIds, skillBooks, CUSTOM,
  EQUIP_POS_TO_SLOT, EQUIP_SLOTS, getTemplate, slotForTemplate, isStackable, registerDropTemplates,
  BLOCKED_ITEMS, requirementOf, refreshItem,
};
