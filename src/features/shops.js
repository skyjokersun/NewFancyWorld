'use strict';
// Merchants and their goods, editable on the /admin page. Each merchant is a map
// plus a shop kind ("hunt_in:arm" = the weapon seller in the hunters' village); the
// 乔乔 blind box seller is "qiaoqiao" everywhere. A custom goods list replaces the
// merchant's default one, and a custom price applies to an item at every merchant.
// A merchant's special list holds goods it always sells, to every profession and level.
// Saved in the 'shopConfig' bucket: { merchants: { id: [itemId] }, special: { id: [itemId] },
// prices: { itemId: price } }.
const cat = require('../game/catalog');
const { MATERIAL_SHOP } = require('./crafting/data');

// Equipment the arm shops do not sell by default (tenth batch): the angel series, the
// 175-200 level sets, 霹雳宝贝, rare rings, wedding / orchard / festival items and the
// sealed ones. A merchant's special list (admin page) still sells any of them.
const NOT_DEFAULT = new Set([
  1314, 1315, 1316, 1317, 1318, 1515, 1516, 1517, 1518, 1519, 1565, 1566, 1567, 1568, 1569,
  593, 1069, 1319, 3220, 1073, 1321, 802, 1070, 1320, 3345, 1071, 1186, 3321, 1322, 1188,
  607, 1072, 1187,
  1557, 1570, 1555, 1560,
  1312, 1313, 1546, 1547, 1548, 1549, 1550, 1551, 1552, 1553, 3451, 3452, 3453, 3454, 3455, 3456, 3457, 1185, 1493, 1068, 2608,
  602, 3444,
]);

function lowestFusionGrade(itemId) {
  const D = require('./crafting/data');
  const info = D.engravingInfo(itemId) || D.gemInfo(itemId);
  return !info || info.grade === 0;
}

const KIND_LABELS = { arm: '武器店', tools: '杂货店', qiaoqiao: '乔乔特购', smith: '工匠原料' };
const MAX_PRICE = 2000000000;
const MAX_ITEMS = 2000;   // the shop window pages through them, 63 a tab page

class Shops {
  register(server) { this.server = server; }

  config() {
    const b = this.server.store.bucket('shopConfig');
    if (!b.merchants || typeof b.merchants !== 'object') b.merchants = {};
    // Fourteenth batch (Sky, 2026-11-03): every merchant's goods list goes back to the
    // default rules once; prices and special lists stay (a special item the merchant no
    // longer sells is ignored).
    if (!b.resetV14) { b.merchants = {}; b.resetV14 = true; this.server.store.markDirty(); }
    if (!b.prices || typeof b.prices !== 'object') b.prices = {};
    if (!b.special || typeof b.special !== 'object') b.special = {};
    return b;
  }

  // Merchants found on the maps: decor tagged shop/shop_red/teamshop whose extra is "label,kind".
  merchants() {
    if (this.list) return this.list;
    const byId = new Map();
    const add = (id, kind, map, label) => {
      if (!byId.has(id)) byId.set(id, { id, kind, maps: [], labels: [] });
      const m = byId.get(id);
      if (map && !m.maps.includes(map)) m.maps.push(map);
      if (label && !m.labels.includes(label)) m.labels.push(label);
    };
    add('qiaoqiao', 'qiaoqiao', null, '乔乔特购商店推销员');
    add('smith:tools', 'smith', 'smith', '工匠原料商（铁匠铺）');
    const maps = this.server.maps;
    for (const id of maps.ids()) {
      let doc; try { doc = maps.rawDoc(id); } catch (_) { continue; }
      for (const e of [].concat(doc.decor || [], doc.decorImgs || [])) {
        if (!e || !/^(shop|shop_red|teamshop)$/i.test(e.tag || '')) continue;
        const m = /^"?([^,"]+),\s*(arm|tools)\s*"?$/.exec(String(e.extra || '').trim());
        if (m) add(id + ':' + m[2], m[2], id, m[1]);
      }
      if (/^(square_in|sowntown_in)$/.test(id)) byId.get('qiaoqiao').maps.push(id);
    }
    this.list = Array.from(byId.values());
    return this.list;
  }

  merchant(id) { return this.merchants().find((m) => m.id === id) || null; }

  merchantId(p, kind) {
    if (kind === 'qiaoqiao') return 'qiaoqiao';
    return (p.scene ? p.scene.mapRef : '') + ':' + kind;
  }

  // Everything a merchant sells by default, before the per-player filtering.
  defaultItems(id) {
    const m = this.merchant(id);
    const kind = m ? m.kind : String(id).split(':').pop();
    if (kind === 'qiaoqiao') return Array.from(cat.blindBoxes.keys());
    if (kind === 'smith') return MATERIAL_SHOP.slice();
    const out = [];
    for (const s of cat.catalogs.shop) {
      if (!(s.buyPrice > 0)) continue;
      if (NOT_DEFAULT.has(s.itemId) || cat.BLOCKED_ITEMS.has(s.itemId)) continue;
      // Fourteenth batch: of the 印刻 and fusion gems only the lowest grade (the 7 宝石碎片
      // and the 8 残缺 印刻) is sold by default; the rest come from drops, events and
      // fusion. A merchant's goods list on the admin page can still add any of them.
      if (!lowestFusionGrade(s.itemId)) continue;
      if (kind === 'tools' ? s.tab === 'medicine' || s.tab === 'book' : ['weapon', 'armor', 'accessory', 'misc'].includes(s.tab)) out.push(s.itemId);
    }
    if (kind === 'tools') { out.push(cat.CUSTOM.FIREWORK); for (let id = 2623; id <= 2633; id += 1) out.push(id); }
    return out;
  }

  customItems(id) {
    const list = this.config().merchants[id];
    return Array.isArray(list) ? list.filter((itemId) => cat.getTemplate(itemId) && !cat.BLOCKED_ITEMS.has(itemId)) : null;
  }

  itemsFor(p, kind) { return this.customItems(this.merchantId(p, kind)); }

  itemsOf(id) { return this.customItems(id) || this.defaultItems(id); }

  // The merchant's special goods (always sold), limited to what it sells.
  specialOf(id) {
    const list = this.config().special[id];
    if (!Array.isArray(list) || !list.length) return new Set();
    const goods = new Set(this.itemsOf(id));
    return new Set(list.filter((itemId) => goods.has(itemId)));
  }

  specialFor(p, kind) { return this.specialOf(this.merchantId(p, kind)); }

  setSpecial(id, items) {
    if (!this.merchant(id)) throw new Error('没有这个商人');
    const goods = new Set(this.itemsOf(id));
    const clean = [];
    for (const raw of items || []) {
      const itemId = Number(raw);
      if (!goods.has(itemId)) throw new Error('特殊清单里的物品 ' + raw + ' 不在这个商人的商品里');
      if (!clean.includes(itemId)) clean.push(itemId);
    }
    const c = this.config();
    if (clean.length) c.special[id] = clean; else delete c.special[id];
    this.server.store.markDirty();
  }

  price(itemId) {
    const v = this.config().prices[itemId];
    if (Number.isInteger(v)) return v;
    const t = cat.getTemplate(itemId);
    return t ? t.buyPrice || 0 : 0;
  }

  prices() { return Object.assign({}, this.config().prices); }

  // items null restores the merchant's default goods.
  setItems(id, items) {
    if (!this.merchant(id)) throw new Error('没有这个商人');
    const c = this.config();
    if (items == null) { delete c.merchants[id]; this.pruneSpecial(id); this.server.store.markDirty(); return; }
    if (!Array.isArray(items) || !items.length) throw new Error('商人至少要卖一件物品');
    if (items.length > MAX_ITEMS) throw new Error('一个商人最多卖 ' + MAX_ITEMS + ' 件物品');
    const clean = [];
    for (const raw of items) {
      const itemId = Number(raw);
      if (!cat.getTemplate(itemId)) throw new Error('没有物品 ' + raw);
      if (!clean.includes(itemId)) clean.push(itemId);
    }
    const def = this.defaultItems(id);
    if (clean.length === def.length && clean.every((x, i) => x === def[i])) delete c.merchants[id];
    else c.merchants[id] = clean;
    this.pruneSpecial(id);
    this.server.store.markDirty();
  }

  // Drops special goods the merchant no longer sells.
  pruneSpecial(id) {
    const c = this.config(); const list = c.special[id];
    if (!Array.isArray(list)) return;
    const goods = new Set(this.itemsOf(id));
    const kept = list.filter((x) => goods.has(x));
    if (kept.length) c.special[id] = kept; else delete c.special[id];
  }

  // prices: { itemId: price | null } (null = back to the default price).
  setPrices(prices) {
    const c = this.config();
    const parsed = [];
    for (const [k, v] of Object.entries(prices || {})) {
      const itemId = Number(k); const t = cat.getTemplate(itemId);
      if (!t) throw new Error('没有物品 ' + k);
      if (v === null || v === '') { parsed.push([itemId, null]); continue; }
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > MAX_PRICE) throw new Error(t.name + '：价格须为 1 到 ' + MAX_PRICE + ' 之间的整数');
      parsed.push([itemId, n === (t.buyPrice || 0) ? null : n]);
    }
    for (const [itemId, n] of parsed) { if (n === null) delete c.prices[itemId]; else c.prices[itemId] = n; }
    if (parsed.length) this.server.store.markDirty();
    return parsed.length;
  }

  hasCustom() { const c = this.config(); return Object.keys(c.merchants).length + Object.keys(c.prices).length + Object.keys(c.special).length > 0; }

  reset() { const c = this.config(); c.merchants = {}; c.prices = {}; c.special = {}; this.server.store.markDirty(); }

  exportConfig() { return JSON.parse(JSON.stringify(this.config())); }

  // Replaces the whole configuration. Validates everything before changing anything.
  importConfig(data) {
    const merchants = data && data.merchants && typeof data.merchants === 'object' ? data.merchants : {};
    const prices = data && data.prices && typeof data.prices === 'object' ? data.prices : {};
    const special = data && data.special && typeof data.special === 'object' ? data.special : {};
    for (const [id, items] of Object.entries(merchants)) {
      if (!this.merchant(id)) throw new Error('导入文件里有未知的商人 ' + id);
      if (!Array.isArray(items) || !items.length || items.some((x) => !cat.getTemplate(Number(x)))) throw new Error('导入文件里商人 ' + id + ' 的商品无效');
    }
    for (const [k, v] of Object.entries(prices)) {
      if (!cat.getTemplate(Number(k)) || !Number.isInteger(v) || v < 1 || v > MAX_PRICE) throw new Error('导入文件里物品 ' + k + ' 的价格无效');
    }
    for (const [id, items] of Object.entries(special)) {
      if (!this.merchant(id) || !Array.isArray(items)) throw new Error('导入文件里商人 ' + id + ' 的特殊清单无效');
    }
    this.reset();
    for (const [id, items] of Object.entries(merchants)) this.setItems(id, items);
    this.setPrices(prices);
    for (const [id, items] of Object.entries(special)) {
      const goods = new Set(this.itemsOf(id));
      this.setSpecial(id, items.map(Number).filter((x) => goods.has(x)));
    }
  }

  // For the admin page.
  view() {
    const c = this.config();
    return {
      merchants: this.merchants().map((m) => ({
        id: m.id, kind: m.kind, kindLabel: KIND_LABELS[m.kind] || m.kind, maps: m.maps, labels: m.labels,
        custom: Array.isArray(c.merchants[m.id]), count: this.itemsOf(m.id).length, special: this.specialOf(m.id).size,
      })),
      prices: this.prices(),
    };
  }

  detail(id) {
    const m = this.merchant(id);
    if (!m) throw new Error('没有这个商人');
    const row = (itemId) => {
      const t = cat.getTemplate(itemId);
      return { itemId, name: t.name, tab: t.tab || (cat.blindBoxes.get(itemId) || {}).tab || 'misc', equipPos: t.equipPos || '', defaultPrice: t.buyPrice || 0, price: this.price(itemId), requirement: t.requirement || null };
    };
    const special = this.specialOf(id);
    return { id, custom: Array.isArray(this.config().merchants[id]), items: this.itemsOf(id).map((itemId) => Object.assign(row(itemId), { special: special.has(itemId) })), defaults: this.defaultItems(id) };
  }
}

module.exports = { Shops, NOT_DEFAULT };
