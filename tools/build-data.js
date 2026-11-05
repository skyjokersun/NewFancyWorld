'use strict';
// Builds server-side data files from the shipped frontend bundle and qmap documents.
// Usage: node tools/build-data.js <frontendRoot>
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { loadBundle } = require('./sysload');

const feRoot = path.resolve(process.argv[2] || '../fe');
const outDir = path.resolve(__dirname, '..', 'data');
fs.mkdirSync(path.join(outDir, 'maps'), { recursive: true });

// --- resource access (loose files or packs) ---
const catalogFile = fs.readdirSync(feRoot).find((f) => /^resource-catalog\..*\.json\.gz$/.test(f));
const catalog = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(feRoot, catalogFile))));
const packCache = new Map();
function readPack(name) {
  if (!packCache.has(name)) {
    const p = catalog.packs[name];
    const raw = fs.readFileSync(path.join(feRoot, p.file));
    packCache.set(name, p.codec === 'gzip' ? zlib.gunzipSync(raw) : raw);
  }
  return packCache.get(name);
}
function readAsset(rel) {
  const loose = path.join(feRoot, rel);
  if (fs.existsSync(loose)) return fs.readFileSync(loose);
  const e = catalog.files[rel];
  if (!e) throw new Error('missing asset ' + rel);
  return readPack(e.pack).subarray(e.offset, e.offset + e.bytes);
}

// --- bundle catalogs ---
const bundle = loadBundle(path.join(feRoot, 'qiyu_index_new.js'));
const protocol = bundle.load('protocol.ts');
const opcodes = {};
for (const [k, v] of Object.entries(protocol.OpCodes)) if (typeof v === 'number') opcodes[k] = v;
const garden = bundle.load('GardenProtocol.ts');
fs.writeFileSync(path.join(outDir, 'opcodes.json'), JSON.stringify({ OpCodes: opcodes, GARDEN_OP_CODES: garden.GARDEN_OP_CODES || null }, null, 1));

const shop = bundle.load('ShopCatalog.generated.ts').SHOP_CATALOG;
const consumables = bundle.load('OriginalConsumableCatalog.generated.ts').ORIGINAL_CONSUMABLE_ITEM_IDS;
const icons = bundle.load('EditorItemIconCatalog.generated.ts').EDITOR_ITEM_ICON_CATALOG;
const custom = bundle.load('CustomItemCatalog.ts');
const summons = bundle.load('OriginalMonsterSummonCatalog.generated.ts').ORIGINAL_MONSTER_SUMMON_PROMPTS;
const consumableCat = bundle.load('ConsumableItemCatalog.ts');
fs.writeFileSync(path.join(outDir, 'client-catalogs.json'), JSON.stringify({
  shop,
  consumableIds: Array.from(consumables || []),
  icons,
  customItemIds: custom.CUSTOM_ITEM_ID,
  qiaoqiaoBlindBoxes: custom.QIAOQIAO_BLIND_BOX_DEFS,
  fireflyItemId: consumableCat.FIREFLY_ITEM_ID,
  monsterSummons: summons instanceof Map ? Array.from(summons.entries()) : summons,
  protocol: {
    PROFESSION_LIST: protocol.PROFESSION_LIST, PROFESSION_LABELS: protocol.PROFESSION_LABELS,
    PROFESSION_MODEL_OPTIONS: protocol.PROFESSION_MODEL_OPTIONS, MODEL_BASE_ATTACK_RANGE: protocol.MODEL_BASE_ATTACK_RANGE,
    DEFAULT_PLAYER_APPEARANCE: protocol.DEFAULT_PLAYER_APPEARANCE,
  },
}, null, 0));

// --- maps ---
const idx = JSON.parse(readAsset('remote/maps/index.json'));
const mapIndex = {};
for (const [id, ent] of Object.entries(idx.maps)) {
  const buf = readAsset('remote/maps/' + ent.file);
  if (buf.subarray(0, 4).toString('latin1') !== 'QYMP') throw new Error('bad qmap ' + id);
  const doc = JSON.parse(zlib.gunzipSync(buf.subarray(16)));
  const m = doc.map || {};
  const width = Math.max(1, m.width | 0);
  const rawHeight = Math.max(1, (m.rawHeight || m.height) | 0);
  const height = Math.max(1, (m.runtimeHeight || m.renderHeight || Math.floor(rawHeight / 2)) | 0);
  const flags = (doc.indexData && doc.indexData.flags) || [];
  const walk = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i += 1) walk[i] = (i < flags.length && (flags[i] & 0xff) !== 0x40) ? 1 : 0;
  const inter = doc.interactives || {};
  const decorExs = ((doc.decor && doc.decor.addImgExs) || []).map((d, i) => ({ i, tag: d.tag || '', path: d.path || '', x: d.x, y: d.y, extra: d.extra || '' }));
  const decorImgs = ((doc.decor && doc.decor.addImgs) || []).map((d, i) => ({ i, tag: d.tag || '', path: d.path || '', x: d.x, y: d.y, extra: d.extra || '' }));
  const connections = [];
  const oc = (inter.originalConnections && inter.originalConnections.entries) || {};
  for (const [key, e] of Object.entries(oc)) {
    connections.push({ key, trigger: e.trigger || null, options: (e.options || []).map((o) => ({ mapId: o.mapId, label: o.label, targetGx: o.targetGx, targetGy: o.targetGy, capacity: o.capacity, minLevel: o.minLevel || 0, maxLevel: o.maxLevel || 0 })) });
  }
  const behaviors = {};
  for (const [key, b] of Object.entries(inter.decorBehaviors || {})) {
    if (!b || b.type === 'none') continue;
    behaviors[key] = { type: b.type, navipoint: b.navipoint || null, teleport: b.teleport || null, shop: b.shop || null, legacy: b.legacy || null };
  }
  const out = {
    id, width, height, worldWidthPx: (m.world && m.world.widthPx) || 0, worldHeightPx: (m.world && m.world.heightPx) || 0,
    walk: walk.toString('base64'), markers: doc.markers || {}, connections, behaviors,
    decor: decorExs.filter((d) => d.tag), decorImgs: decorImgs.filter((d) => d.tag),
    monsterSpawns: doc.monsterSpawns || null,
  };
  fs.writeFileSync(path.join(outDir, 'maps', id + '.json'), JSON.stringify(out));
  mapIndex[id] = { width, height, spawns: !!doc.monsterSpawns };
}
fs.writeFileSync(path.join(outDir, 'map-index.json'), JSON.stringify(mapIndex, null, 0));
console.log('opcodes', Object.keys(opcodes).length, 'shop', shop.length, 'maps', Object.keys(mapIndex).length);
