'use strict';
// Twelfth batch (Q20, Q23): the admin 物品 page.
// - Any item: name, description, prices, weight, durability, attributes, level (职业等级),
//   tags and icon may be changed. The original values stay in the code; the changes are
//   kept in the store bucket itemAdmin.edits and laid over the templates at start.
// - New items get ids from 950000 and may be deleted; original items can only be
//   disabled (no longer sold or dropped; copies players hold stay).
// - Kinds of new item: 药品 (several effects: restoreHp / restoreStamina), 装备 (a slot),
//   宝石 (a suffix for fusion), 印刻 (a prefix for fusion), 材料, 其他.
// - Icons are 32x32 PNGs (the page shrinks the upload) kept in
//   site/custom_assets/item-icons-admin/<id>.png and drawn into the item icon sheet.
// - Tags (Q23): an item may carry several tags; a profession lists the tags it may wear;
//   one match is enough, and the level (职业等级) is its own field. Items without tags
//   keep their professions as tags, so wearing works exactly as before.
// - The client learns every new or changed item at page load (/api/extra-items, patch 26).
const fs = require('fs');
const path = require('path');
const cat = require('../game/catalog');
const C = require('../game/character');
const log = require('../util/log');

const FIRST_NEW_ID = 950000;
// The fusion prefix / suffix of a catalog 印刻 or gem (shown on the admin detail page).
function builtinAffix(itemId) {
  const D = require('./crafting/data');
  const e = D.engravingInfo(itemId);
  if (e) return { name: e.prefix, grade: e.grade };
  const g = D.gemInfo(itemId);
  return g ? { name: g.suffix, grade: g.grade } : null;
}
const KINDS = { medicine: '药品', equipment: '装备', gem: '宝石', engraving: '印刻', material: '材料', misc: '其他' };
const SLOT_POS = { weapon: 'weapon', helmet: 'helmet', shoulder: 'shoulder', armor: 'armor', knee: 'knee', boots: 'boots', necklace: 'necklace', gloves: 'gloves' };
const ATTR_LABELS = {
  attack: '攻击', breakPower: '破坏', defense: '防御', maxHp: '生命上限', maxStamina: '精力上限', moveSpeed: '移动速度',
  strength: '力量', agility: '敏捷', perception: '感知', intelligence: '聪明', luck: '运气',
  restoreHp: '恢复体力', restoreStamina: '恢复精力',
  fireResist: '火抗', iceResist: '冰抗', thunderResist: '雷抗', poisonResist: '毒抗',
  // Thirteenth batch: element attack is a flat value (original).
  fireDamage: '火伤害', iceDamage: '冰伤害', thunderDamage: '雷伤害', poisonDamage: '毒伤害',
  damageReflectPercent: '伤害反弹%', lifeStealPercent: '吸取生命%', staminaStealPercent: '吸取精力%', hitPercent: '命中率%',
  maxHpPercent: '生命上限%', maxStaminaPercent: '精力上限%', professionSkillPercent: '职业技能攻击%', attackSpeedPercent: '攻击速度%',
  farSkillPercent: '远程技能攻击%', nearSkillPercent: '近战技能攻击%', gunSkillPercent: '枪械技能攻击%', magicSkillPercent: '魔法技能攻击%',
  skill_ranged_weapon: '远程技能点', skill_melee_weapon: '近身技能点', skill_mechanics: '机械技能点', skill_magic: '魔法技能点', skill_judgement: '判断力技能点',
};
const EDIT_FIELDS = ['name', 'desc', 'buyPrice', 'sellPrice', 'weight', 'durability', 'bonusAttrs', 'requirement', 'tags', 'tab'];

function attrDisplay(key, value) {
  const l = ATTR_LABELS[key] || key;
  const pct = /%$/.test(l);
  return l.replace(/%$/, '') + '+' + value + (pct ? '%' : '');
}
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

class ItemAdmin {
  register(server) {
    this.server = server;
    this.originals = new Map();   // itemId -> the template's fields before any edit
  }

  onStart() {
    this.apply();
    // Items saved in bags keep their own copies: bring the edited fields up to date.
    this.server.events.on('playerEntered', (p) => this.refreshCharacter(p));
  }

  data() {
    const b = this.server.store.bucket('itemAdmin');
    b.edits = b.edits || {}; b.added = b.added || {}; b.disabled = b.disabled || {};
    if (!b.professionTags) b.professionTags = {};
    return b;
  }

  // ---------- applying ----------
  apply() {
    const b = this.data();
    // Back to the originals first, then the edits on top.
    for (const [id, orig] of this.originals) { const t = cat.templates.get(id); if (t) { for (const f of EDIT_FIELDS) { if (orig[f] === undefined) delete t[f]; else t[f] = clone(orig[f]); } delete t.adminEdited; } }
    for (const [id, tpl] of Object.entries(b.added)) cat.templates.set(Number(id), Object.assign({ source: 'admin' }, clone(tpl)));
    for (const [id, edit] of Object.entries(b.edits)) {
      const t = cat.templates.get(Number(id));
      if (!t) continue;
      if (!this.originals.has(t.itemId)) { const o = {}; for (const f of EDIT_FIELDS) o[f] = clone(t[f]); this.originals.set(t.itemId, o); }
      Object.assign(t, clone(edit), { adminEdited: true });
    }
    // Saved before the thirteenth batch: element percent keys become flat keys.
    const A = require('../game/affixes');
    for (const id of Object.keys(b.added).concat(Object.keys(b.edits))) { const t = cat.templates.get(Number(id)); if (t && A.flatElementItem(t)) t.flatElement = true; }
    cat.BLOCKED_ITEMS_ADMIN = new Set(Object.keys(b.disabled).map(Number));
    for (const id of Object.keys(b.disabled)) cat.BLOCKED_ITEMS.add(Number(id));
    C.setProfessionTags(b.professionTags);
    try { require('../admin').resetItemLists(); } catch (_) { /* admin not loaded */ }
    try { require('../virtual-assets').resetItemAtlas(); } catch (_) { /* no assets */ }
  }

  refreshItem(it) {
    if (!it) return false;
    const t = cat.templates.get(Number(it.itemId));
    if (!t || !(t.adminEdited || t.source === 'admin')) return false;
    const before = JSON.stringify(it);
    it.desc = t.desc || '';
    it.weight = t.weight || 0;
    it.sellPrice = t.sellPrice || 0;
    it.requirement = t.requirement ? clone(t.requirement) : undefined;
    if (t.durability && it.durability && !it.durability.infinite) { it.durability.max = t.durability.max; it.durability.cur = Math.min(it.durability.cur, it.durability.max); }
    if (cat.slotForTemplate(t)) {
      const D = require('./crafting/data');
      D.rebuildItem(it, D.normalizedAffix(it));
    } else {
      it.name = t.name;
      it.bonusAttrs = (t.bonusAttrs || []).map((a) => Object.assign({}, a));
    }
    return JSON.stringify(it) !== before;
  }
  refreshCharacter(p) {
    let n = 0;
    for (const it of p.ch.inventory) if (this.refreshItem(it)) n += 1;
    for (const s of cat.EQUIP_SLOTS) if (this.refreshItem(p.ch.equipment[s])) n += 1;
    if (n) { p.recompute(); p.paramsDirty = true; }
  }

  // ---------- views ----------
  kindOf(t) {
    if (t.affixItem) return t.affixItem.kind === 'prefix' ? 'engraving' : 'gem';
    // The catalog's own 印刻 (2305-2336) and fusion gems (1665-1698, 1704, special stones)
    // carry no affixItem; without this they showed only under 其他, not 宝石 / 印刻.
    const D = require('./crafting/data');
    if (D.engravingInfo(t.itemId)) return 'engraving';
    if (D.gemInfo(t.itemId)) return 'gem';
    if (cat.slotForTemplate(t)) return 'equipment';
    if (t.tab === 'medicine' || (t.bonusAttrs || []).some((a) => a.key === 'restoreHp' || a.key === 'restoreStamina')) return 'medicine';
    return t.kind || 'misc';
  }
  row(t) {
    const b = this.data();
    let category = '其他';
    try { category = require('../admin').itemCategory(t); } catch (_) { /* */ }
    return {
      itemId: t.itemId, name: t.name, category, kind: this.kindOf(t), slot: cat.slotForTemplate(t) || null,
      added: t.source === 'admin', edited: !!b.edits[t.itemId], disabled: !!b.disabled[t.itemId],
      level: minLevelOf(t), tags: tagsOf(t), atlas: !!t.atlas,
    };
  }
  list() {
    return [...cat.templates.values()].filter((t) => t && t.name && t.itemId > 0).map((t) => this.row(t)).sort((a, b) => a.itemId - b.itemId);
  }
  detail(id) {
    const t = cat.templates.get(Number(id));
    if (!t) throw new Error('没有这个物品：' + id);
    return Object.assign(this.row(t), {
      desc: t.desc || '', buyPrice: t.buyPrice || 0, sellPrice: t.sellPrice || 0, weight: t.weight || 0,
      durability: t.durability ? t.durability.max : 1, equipPos: t.equipPos || 'none', tab: t.tab || 'misc',
      bonusAttrs: (t.bonusAttrs || []).map((a) => ({ key: a.key, value: a.value })),
      affixName: t.affixItem ? t.affixItem.name : (builtinAffix(t.itemId) || {}).name || '', affixGrade: t.affixItem ? t.affixItem.grade || 0 : (builtinAffix(t.itemId) || {}).grade || 0,
      original: this.originals.has(t.itemId) ? summary(this.originals.get(t.itemId)) : null,
      icon: '/api/item-icon/' + t.itemId,
    });
  }
  meta() {
    const profs = Object.keys(cat.protocol.PROFESSION_MODEL_OPTIONS || {}).concat(Object.keys(this.server.features.professions ? this.server.features.professions.customMap() : {}));
    return {
      kinds: KINDS, slots: Object.keys(SLOT_POS), attrs: ATTR_LABELS, firstNewId: FIRST_NEW_ID,
      professionTags: Object.fromEntries([...new Set(profs)].map((p) => [p, C.professionTagsOf(p)])),
      professionNames: Object.fromEntries([...new Set(profs)].map((p) => [p, C.PROFESSION_LABELS[p] || (this.server.features.professions && this.server.features.professions.nameOf(p)) || p])),
      allTags: [...new Set([...cat.templates.values()].flatMap((t) => tagsOf(t)))].sort(),
    };
  }

  // ---------- changes ----------
  clean(body, t, isNew) {
    const out = {};
    const name = String(body.name == null ? t.name : body.name).trim();
    if (!name || name.length > 24) throw new Error('名字须为 1–24 个字');
    out.name = name;
    out.desc = String(body.desc == null ? t.desc || '' : body.desc).slice(0, 200);
    const num = (v, lo, hi, what) => { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(what + '须在 ' + lo + '–' + hi + ' 之间'); return n; };
    out.buyPrice = num(body.buyPrice == null ? t.buyPrice || 0 : body.buyPrice, 0, 2e9, '买价');
    out.sellPrice = num(body.sellPrice == null ? t.sellPrice || 0 : body.sellPrice, 0, 2e9, '卖价');
    out.weight = num(body.weight == null ? t.weight || 0 : body.weight, 0, 100000, '重量');
    const dur = num(body.durability == null ? (t.durability ? t.durability.max : 1) : body.durability, 1, 100000, '耐久');
    out.durability = { cur: dur, max: dur };
    const attrs = Array.isArray(body.bonusAttrs) ? body.bonusAttrs : (t.bonusAttrs || []);
    if (attrs.length > 12) throw new Error('属性最多 12 条');
    out.bonusAttrs = attrs.filter((a) => a && a.key).map((a) => {
      if (!ATTR_LABELS[a.key]) throw new Error('没有这个属性：' + a.key);
      const v = Number(a.value);
      if (!Number.isFinite(v) || Math.abs(v) > 1e7) throw new Error(ATTR_LABELS[a.key] + ' 的数值不对');
      return { key: a.key, value: v, display: attrDisplay(a.key, v) };
    });
    const level = num(body.level == null ? minLevelOf(t) : body.level, 0, C.LEVEL_CAP, '等级要求');
    const tags = Array.isArray(body.tags) ? [...new Set(body.tags.map((x) => String(x).trim()).filter(Boolean))].slice(0, 12) : tagsOf(t);
    for (const g of tags) if (g.length > 12) throw new Error('标签最多 12 个字：' + g);
    out.tags = tags;
    // The level for each tag that is a profession, so the old requirement display still works.
    const profs = tags.filter((g) => C.PROFESSION_LABELS[g] || (this.server.features.professions && this.server.features.professions.nameOf(g)));
    const req = Object.assign({}, t.requirement || {});
    req.professionLevels = profs.length ? profs.map((p) => ({ profession: p, minLevel: level })) : (level ? [{ profession: 'any', minLevel: level }] : []);
    out.requirement = req;
    out.tagMinLevel = level;
    if (isNew) out.tab = t.tab;
    return out;
  }

  save(id, body) {
    const b = this.data();
    const itemId = Number(id);
    const t = cat.templates.get(itemId);
    if (!t) throw new Error('没有这个物品：' + id);
    const out = this.clean(body, t, t.source === 'admin');
    if (t.source === 'admin') {
      const kind = this.kindOf(t);
      Object.assign(b.added[itemId], out);
      if (kind === 'gem' || kind === 'engraving') b.added[itemId].affixItem = this.affixFor(kind, body, out.name);
    } else b.edits[itemId] = out;
    this.server.store.markDirty();
    this.apply();
    this.refreshOnline();
    log.info('admin item saved', itemId, out.name);
    return '已保存 ' + out.name + '（' + itemId + '）。玩家重新进入游戏（刷新页面）后看到新的名字和图标';
  }
  affixFor(kind, body, name) {
    const nm = String(body.affixName || name).trim();
    if (!nm || nm.length > 8) throw new Error((kind === 'gem' ? '后缀' : '前缀') + '名须为 1–8 个字');
    const grade = Math.max(0, Math.min(3, Math.round(Number(body.affixGrade) || 0)));
    return { kind: kind === 'gem' ? 'suffix' : 'prefix', name: kind === 'engraving' && !/的$/.test(nm) ? nm + '的' : nm, grade };
  }

  create(body) {
    const b = this.data();
    const kind = String(body.kind || 'misc');
    if (!KINDS[kind]) throw new Error('没有这个种类');
    let id = FIRST_NEW_ID;
    while (cat.templates.has(id)) id += 1;
    const slot = kind === 'equipment' ? String(body.slot || '') : '';
    if (kind === 'equipment' && !SLOT_POS[slot]) throw new Error('请选择装备部位');
    const tab = kind === 'medicine' ? 'medicine' : kind === 'equipment' ? (slot === 'weapon' ? 'weapon' : slot === 'necklace' ? 'accessory' : 'armor') : 'misc';
    const base = { itemId: id, equipPos: kind === 'equipment' ? SLOT_POS[slot] : 'none', tab, kind, atlas: this.nextAtlas() };
    const out = this.clean(body, Object.assign({ name: '新物品' }, base), true);
    const tpl = Object.assign(base, out);
    if (kind === 'gem' || kind === 'engraving') tpl.affixItem = this.affixFor(kind, body, out.name);
    b.added[id] = tpl;
    this.server.store.markDirty();
    if (kind === 'medicine' || kind === 'gem' || kind === 'engraving' || kind === 'material' || kind === 'misc') cat.consumableIds.delete(id);
    this.apply();
    log.info('admin item created', id, tpl.name);
    return { id, message: '已新建 ' + tpl.name + '（' + id + '）' };
  }
  // New items take the cells after the shipped sheet, 16 a row.
  nextAtlas() {
    let H = 0;
    for (const t of cat.templates.values()) if (t.atlas && t.source !== 'admin') H = Math.max(H, t.atlas.y + t.atlas.h);
    const used = new Set(Object.values(this.data().added).map((t) => t.atlas && t.atlas.x + ',' + t.atlas.y));
    for (let k = 0; ; k += 1) {
      const a = { x: (k % 16) * 32, y: H + Math.floor(k / 16) * 32, w: 32, h: 32 };
      if (!used.has(a.x + ',' + a.y)) return a;
    }
  }

  remove(id) {
    const b = this.data();
    const itemId = Number(id);
    if (b.added[itemId]) {
      const name = b.added[itemId].name;
      delete b.added[itemId];
      cat.templates.delete(itemId);
      this.dropIcon(itemId);
      this.server.store.markDirty();
      this.apply();
      return '已删除 ' + name + '。玩家手里已有的这件物品会变成无效物品，请先确认没人持有';
    }
    if (b.edits[itemId]) { delete b.edits[itemId]; this.server.store.markDirty(); this.apply(); this.refreshOnline(); return '已恢复原版数值'; }
    throw new Error('原版物品不能删除，只能停用');
  }
  setDisabled(id, off) {
    const b = this.data();
    const itemId = Number(id);
    if (!cat.templates.has(itemId)) throw new Error('没有这个物品');
    if (off) { b.disabled[itemId] = true; cat.BLOCKED_ITEMS.add(itemId); } else { delete b.disabled[itemId]; cat.BLOCKED_ITEMS.delete(itemId); }
    this.server.store.markDirty();
    return off ? '已停用：商店不再出售，怪物不再掉落；玩家已有的不受影响' : '已重新启用';
  }

  iconDir() { return path.join(this.server.config.webRoot, 'custom_assets', 'item-icons-admin'); }
  setIcon(id, dataUrl) {
    const itemId = Number(id);
    const t = cat.templates.get(itemId);
    if (!t) throw new Error('没有这个物品');
    if (!t.atlas) throw new Error('这件物品在图标表里没有格子，不能换图标');
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) throw new Error('图标须为 PNG');
    const buf = Buffer.from(m[1], 'base64');
    const img = require('../item-atlas').decodePng(buf);
    if (!img || img.width !== 32 || img.height !== 32) throw new Error('图标须为 32×32 的 PNG（页面会自动缩小，请用页面上传）');
    fs.mkdirSync(this.iconDir(), { recursive: true });
    fs.writeFileSync(path.join(this.iconDir(), itemId + '.png'), buf);
    require('../virtual-assets').resetItemAtlas();
    return '图标已更换（玩家刷新页面后看到）';
  }
  dropIcon(itemId) { try { fs.unlinkSync(path.join(this.iconDir(), itemId + '.png')); } catch (_) { /* none */ } require('../virtual-assets').resetItemAtlas(); }
  iconPng(id) {
    const itemId = Number(id);
    try { return fs.readFileSync(path.join(this.iconDir(), itemId + '.png')); } catch (_) { /* fall through */ }
    const extra = require('../sitepak').readSite(this.server.config.webRoot, 'custom_assets/item-icons/' + itemId + '.png');
    if (extra) return extra;
    // Otherwise crop the item's cell out of the icon sheet the game serves.
    try {
      const t = cat.templates.get(itemId);
      const va = require('../virtual-assets');
      const { decodePng, encodePng } = require('../item-atlas');
      const sheet = t && t.atlas && va.readAsset(va.ITEM_ATLAS_URL);
      const img = sheet && decodePng(sheet);
      if (!img) return null;
      const { x, y, w, h } = t.atlas;
      const out = Buffer.alloc(w * h * 4);
      for (let r = 0; r < h; r += 1) img.rgba.copy(out, r * w * 4, ((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4);
      return encodePng(w, h, out);
    } catch (_) { return null; }
  }

  setProfessionTags(prof, tags) {
    const b = this.data();
    const list = [...new Set((Array.isArray(tags) ? tags : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 30);
    if (!list.length) delete b.professionTags[prof]; else b.professionTags[prof] = list;
    this.server.store.markDirty();
    this.apply();
    this.refreshOnline();
    return (C.PROFESSION_LABELS[prof] || prof) + ' 可用标签：' + (C.professionTagsOf(prof).join('、') || '（默认）');
  }

  refreshOnline() {
    for (const p of this.server.playersById.values()) { this.refreshCharacter(p); p.recompute(); p.paramsDirty = true; p.markDirty(); }
  }

  // For /api/extra-items: new items and the changed fields of original items.
  clientRows() {
    const b = this.data();
    const rows = [];
    for (const t of Object.values(b.added)) rows.push(clientRow(t));
    for (const id of Object.keys(b.edits)) { const t = cat.templates.get(Number(id)); if (t) rows.push(Object.assign(clientRow(t), { override: true })); }
    // Gems whose element attack became flat (thirteenth batch): the client's own shop list says %.
    for (const t of cat.templates.values()) if (t.flatElement && !b.added[t.itemId] && !b.edits[t.itemId] && t.atlas) rows.push(Object.assign(clientRow(t), { override: true }));
    return rows;
  }
}

function clientRow(t) {
  return { itemId: t.itemId, name: t.name, desc: t.desc || '', equipPos: t.equipPos || 'none', tab: t.tab || 'misc', buyPrice: t.buyPrice || 0, sellPrice: t.sellPrice || 0,
    weight: t.weight || 0, durability: clone(t.durability || { cur: 1, max: 1 }), bonusAttrs: clone(t.bonusAttrs || []), atlas: clone(t.atlas), requirement: clone(t.requirement) };
}
function summary(o) { return { name: o.name, buyPrice: o.buyPrice, sellPrice: o.sellPrice, weight: o.weight }; }
function minLevelOf(t) {
  if (Number.isFinite(t.tagMinLevel)) return t.tagMinLevel;
  const e = t.requirement && (t.requirement.professionLevels || [])[0];
  return e ? e.minLevel || 0 : 0;
}
function tagsOf(t) {
  if (Array.isArray(t.tags)) return t.tags.slice();
  return ((t.requirement && t.requirement.professionLevels) || []).map((e) => e.profession).filter((p) => p && p !== 'any');
}

module.exports = { ItemAdmin, tagsOf, FIRST_NEW_ID };
