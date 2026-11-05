'use strict';
// Fifteenth batch (V15.1). Everything here is set on the admin page 屠龙与卡片 and kept in
// the 'batch15' bucket of var/state.json (in the settings export / import / reset).
//
// 1. Card drops (Q6): the wish cards (心型 3900-3915, 神龙 3920-3939, 天使 3940-3959) are in
//    no monster's table in the original; they came from 猎场, 果园 and 矿山. Default: as
//    before V15 (every monster of level 5 or more, 0.4% x the item drop rate, the three
//    altars alike); the admin page sets the chance, the minimum level, a multiplier per
//    kind of map (0 = none there), altar weights, a weight per card, whether the global
//    item drop rate applies, and extra chances on a 果园 harvest and a 矿山 dig.
// 2. Drop overview (Q7): every monster dropping an item, chances changed in one go.
// 3. 屠龙 (Q12-Q17), from the two official old clients: 100 x 黄色水晶碎片 2622 -> 光明大祭祀
//    米索莉 (decor sacrificemsl in 拼卡圣坛) fuses 黄色水晶 2621 (大地之心, kept, bound);
//    with 2621 she hands out one 封印的火枪 602 (bound; only such a gun is unsealed, for
//    gunners, any level) and sells 封印的魔法子弹 603-606 at the itemdata.tab price field.
//    Only the gun with a bullet hurts 大地龙: each normal shot uses one bullet (best first,
//    606 -> 603 as bullet.fcc checks them) and does attack x rand(0.9,1.1) x the bullet's
//    multiplier, ignoring the dragon's 2000 defence. The gun without a bullet does 1
//    (bare hands), and it does nothing to other monsters. Other weapons and skills do 0 to
//    大地龙. 2622 drops at shardPercent (1%) where a monster's drops were not edited.
// 4. 大地龙 801 (Q11, Q16): the original ani.tab stats, the web client's own
//    map/mapsource/ani/field/bossdragon.ale as its model (18 frames, one direction, served
//    as u_bossdragon for every action); it does not walk. Summoned on the admin page or
//    daily at a set time (server clock) on its map, one per world; drops 真龙鳞 2601 8.1%
//    and 5000 gold 2% (raw 810 and -5000,200 / 10000).
// 5. Green gifts (Q18, Q19), the 2005 愚人节 rule in sweetday/presentgiftcon_c.fcc: 10 of
//    one of 绿色蝶翅 / 蜥蜴尾刺 / 狐狸皮 / 龙骨 (2635-2638) are given to a player on the same
//    map; the receiver accepts (receivegiftdlg: "接收后会发生变异") and looks like a 蝴蝶精 /
//    蜥蜴 / 狐狸 / 小红龙 for transformMinutes (looks only; logging out or changing maps
//    does not end it). Event drops (off by default) put them on chosen monsters.
const cat = require('../game/catalog');
const C = require('../game/character');

const CARD_ALTARS = { heart: { name: '心型祭坛', start: 3900, n: 16 }, dragon: { name: '神龙祭坛', start: 3920, n: 20 }, angel: { name: '天使祭坛', start: 3940, n: 20 } };
const MAP_CATS = ['猎场', '林地猎场', '荒野猎场', '雪原', '矿洞', '城镇', '房间', '其他'];
const SHARD = 2622, CRYSTAL = 2621, GUN = 602, SCALE = 2601;
const PER_SHOT = { 603: 1, 604: 3, 605: 6, 606: 6 };
const BULLETS = [606, 605, 604, 603];   // best first, as act/fight/bullet.fcc checks them
const GREEN = { 2635: { name: '蝴蝶精', model: 'u_tf_butterfly', src: 'butterfly' }, 2636: { name: '蜥蜴', model: 'u_tf_lizard', src: 'lizard' },
  2637: { name: '狐狸', model: 'u_tf_fox', src: 'fox' }, 2638: { name: '小红龙', model: 'u_tf_dragon', src: 'dragon' } };
const GIFT_COUNT = 10;
const BOSS_ID = 'v15_dragon801';

const DEFAULTS = {
  cards: { on: true, chance: 0.4, minLevel: 5, useDropRate: true, cats: {}, altars: { heart: 1, dragon: 1, angel: 1 }, weights: {}, gardenChance: 0, mineChance: 0 },
  dragon: {
    shardPercent: 1, prices: { 603: 100, 604: 300, 605: 600, 606: 1200 }, mult: { 603: 3, 604: 5, 605: 8, 606: 12 },
    map: 'wl_d_01', x: 0, y: 0, dailyTime: '20:00', respawnHours: 0,
    // V15.2 (Q5-Q8, Q22-Q24): a random 焚骨沙漠 map, 60 minutes to kill it, 龙牙 for every
    // damager present, revive in town on its map, no bullet-only rule, gear drop off.
    maps: ['wl_d_01', 'wl_d_02', 'wl_d_03', 'wl_d_04', 'wl_d_05', 'wl_d_06'], timeLimitMin: 60, fangMode: 'all', reviveInTown: true, bulletOnly: false, gearDropPercent: 0,
    stats: { level: 150, hp: 100000, defense: 2000, breakPower: 280, damage: 600, attackRange: 400, detectionRange: 400, baseExp: 200, fireAttack: 400 },
    scalePercent: 8.1, goldPercent: 2, gold: 5000,
  },
  transform: { minutes: 60, eventOn: false, eventDrops: [], mode: 'gift', count: 10 },
};
for (const c of MAP_CATS) DEFAULTS.cards.cats[c] = 1;

// Original itemdata.tab rows the web client has no template for.
const TEMPLATES = {
  603: ['单发封印的魔法子弹', '击杀大地之龙的专用武器的弹药，对其他生物无效', 1],
  604: ['三发封印的魔法子弹', '击杀大地之龙的专用武器的弹药，对其他生物无效', 3],
  605: ['六发封印的魔法子弹', '击杀大地之龙的专用武器的弹药，对其他生物无效', 6],
  606: ['极品六发封印的魔法子弹', '击杀大地之龙的专用武器的弹药，对其他生物无效', 6],
  2621: ['黄色水晶', '黄色水晶（大地之心）。凭它向光明大祭祀米索莉领取封印的火枪、购买封印的魔法子弹。（任务物品，不能交易）', 1],
  2622: ['黄色水晶碎片', '黄色水晶碎片。集齐 100 片，到拼卡圣坛找光明大祭祀米索莉融合成大地之心。', 1],
  2635: ['绿色蝶翅', '2004年愚人节，神秘礼物。10 个一起送给同一张地图上的玩家，对方接收后会变成蝴蝶精。', 1],
  2636: ['绿色蜥蜴尾刺', '2004年愚人节，神秘礼物。10 个一起送给同一张地图上的玩家，对方接收后会变成蜥蜴。', 2],
  2637: ['绿色狐狸皮', '2004年愚人节，神秘礼物。10 个一起送给同一张地图上的玩家，对方接收后会变成狐狸。', 3],
  2638: ['绿色龙骨', '2004年愚人节，神秘礼物。10 个一起送给同一张地图上的玩家，对方接收后会变成小红龙。', 10],
  2601: ['真龙鳞', '大地之龙身上的鳞片，珍贵的魔法材料', 1],
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function num(v, min, max, what) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(what + '须在 ' + min + ' 到 ' + max + ' 之间');
  return n;
}
function merge(def, saved) {
  const out = clone(def);
  for (const [k, v] of Object.entries(saved || {})) {
    if (!(k in def)) continue;
    if (def[k] && typeof def[k] === 'object' && !Array.isArray(def[k])) out[k] = Object.assign({}, def[k], v || {});
    else out[k] = v;
  }
  return out;
}

class Batch15 {
  register(server) {
    this.server = server;
    this.gifts = new Map();   // receiver player id -> pending gift
    for (const [id, [name, desc, weight]] of Object.entries(TEMPLATES)) {
      const t = cat.getTemplate(Number(id));
      if (t) { t.desc = desc; continue; }
      cat.templates.set(Number(id), { itemId: Number(id), name, desc, equipPos: 'none', tab: 'misc', buyPrice: 0, sellPrice: id >= 603 && id <= 606 ? 0 : 5, weight, durability: { cur: 1, max: 1 }, bonusAttrs: [], source: 'batch15' });
    }
    const t602 = cat.getTemplate(GUN);
    if (t602) t602.desc = '击杀大地之龙的专用武器，要装上封印的魔法子弹才有威力，对其他生物无效。光明大祭祀米索莉发给持有大地之心的枪手，只有她发的枪才能装备。（任务物品，不能交易）';
    const ext = server.ext;
    ext.on('msl_query', (p) => this.mslState(p));
    ext.on('msl_fuse', (p) => this.mslFuse(p));
    ext.on('msl_gun', (p) => this.mslGun(p));
    ext.on('msl_buy', (p, d) => this.mslBuy(p, d));
    ext.on('gift_send', (p, d) => this.giftSend(p, d));
    ext.on('gift_answer', (p, d) => this.giftAnswer(p, d));
    server.events.on('tick', (now) => this.tick(now));
    server.events.on('playerEntered', (p) => this.onEnter(p));
    server.events.on('gardenHarvest', (p) => this.extraCard(p, 'gardenChance', '果园'));
    server.events.on('mineDig', (p) => this.extraCard(p, 'mineChance', '矿山'));
    this.lastMinute = '';
    this.lastExpiryCheck = 0;
  }

  onStart() {
    this.bucket = this.server.store.bucket('batch15');
    const items = this.server.features.items;
    if (items) for (const id of Object.keys(GREEN)) items.onUse(Number(id), (p, from, it) => this.greenUse(p, it));
  }

  // ---------- config ----------
  cfg() { return { cards: merge(DEFAULTS.cards, this.bucket.cards), dragon: merge(DEFAULTS.dragon, this.bucket.dragon), transform: merge(DEFAULTS.transform, this.bucket.transform) }; }
  view() {
    const c = this.cfg();
    const cards = [];
    for (const [key, a] of Object.entries(CARD_ALTARS)) for (let i = 0; i < a.n; i += 1) {
      const id = a.start + i;
      cards.push({ itemId: id, altar: key, name: a.name.replace('祭坛', '卡') + ' P' + String(i + 1).padStart(2, '0'), weight: c.cards.weights[id] == null ? 1 : c.cards.weights[id] });
    }
    return { config: c, defaults: clone(DEFAULTS), mapCats: MAP_CATS, altars: Object.fromEntries(Object.entries(CARD_ALTARS).map(([k, a]) => [k, a.name])), cardList: cards,
      dropRate: this.server.config.dropRate, maps: this.server.maps.ids(), dragonAlive: this.aliveDragons(),
      greens: Object.entries(GREEN).map(([id, g]) => ({ itemId: Number(id), name: TEMPLATES[id][0], becomes: g.name })) };
  }
  // part: 'cards' | 'dragon' | 'transform'; body: the whole part as on the page, or {reset:true}.
  save(part, body) {
    if (!DEFAULTS[part]) throw new Error('没有这一项：' + part);
    if (body && body.reset) { delete this.bucket[part]; this.server.store.markDirty(); return '已恢复默认'; }
    const v = this['check_' + part](body || {});
    this.bucket[part] = v;
    this.server.store.markDirty();
    return '已保存，立即生效';
  }
  check_cards(b) {
    const d = DEFAULTS.cards;
    const out = { on: !!b.on, chance: num(b.chance, 0, 100, '每只怪掉卡概率'), minLevel: Math.round(num(b.minLevel, 0, 1000, '怪物最低等级')), useDropRate: !!b.useDropRate,
      cats: {}, altars: {}, weights: {}, gardenChance: num(b.gardenChance, 0, 100, '果园收获掉卡概率'), mineChance: num(b.mineChance, 0, 100, '挖矿掉卡概率') };
    for (const k of MAP_CATS) out.cats[k] = num((b.cats || {})[k] == null ? d.cats[k] : b.cats[k], 0, 1000, k + '的倍率');
    for (const k of Object.keys(CARD_ALTARS)) out.altars[k] = num((b.altars || {})[k] == null ? 1 : b.altars[k], 0, 10000, CARD_ALTARS[k].name + '的权重');
    for (const [id, w] of Object.entries(b.weights || {})) {
      if (!this.altarOf(Number(id))) throw new Error('没有这张卡：' + id);
      const n = num(w, 0, 10000, '卡 ' + id + ' 的权重');
      if (n !== 1) out.weights[id] = n;
    }
    return out;
  }
  check_dragon(b) {
    const d = DEFAULTS.dragon;
    const out = { shardPercent: num(b.shardPercent, 0, 100, '碎片掉率'), prices: {}, mult: {}, map: String(b.map || d.map), x: Math.round(Number(b.x) || 0), y: Math.round(Number(b.y) || 0),
      dailyTime: String(b.dailyTime || '').trim(), respawnHours: num(b.respawnHours || 0, 0, 720, '自动重生小时数'), stats: {},
      scalePercent: num(b.scalePercent, 0, 100, '真龙鳞掉率'), goldPercent: num(b.goldPercent, 0, 100, '金币掉率'), gold: Math.round(num(b.gold, 0, 100000000, '金币数量')) };
    if (!this.server.maps.ids().includes(out.map)) throw new Error('没有这张地图：' + out.map);
    if (out.dailyTime && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(out.dailyTime)) throw new Error('每天刷新时间请写成 20:00 这样，留空 = 不定时');
    for (const id of [603, 604, 605, 606]) {
      out.prices[id] = Math.round(num((b.prices || {})[id], 0, 100000000, TEMPLATES[id][0] + '的价格'));
      out.mult[id] = num((b.mult || {})[id], 0, 1000, TEMPLATES[id][0] + '的倍率');
    }
    for (const k of Object.keys(d.stats)) out.stats[k] = Math.round(num((b.stats || {})[k] == null ? d.stats[k] : b.stats[k], 0, 100000000, '大地龙的 ' + k));
    const ids = this.server.maps.ids();
    out.maps = (Array.isArray(b.maps) ? b.maps : d.maps).map(String).filter((m) => ids.includes(m));
    if (!out.maps.length) throw new Error('大地龙至少要有一张可以出现的地图');
    out.timeLimitMin = Math.round(num(b.timeLimitMin == null ? d.timeLimitMin : b.timeLimitMin, 0, 100000, '屠龙时限（分钟）'));
    out.fangMode = b.fangMode === 'killer' ? 'killer' : 'all';
    out.reviveInTown = b.reviveInTown == null ? d.reviveInTown : !!b.reviveInTown;
    out.bulletOnly = !!b.bulletOnly;
    out.gearDropPercent = num(b.gearDropPercent || 0, 0, 100, '装备被打落的概率');
    if (out.stats.hp < 1) throw new Error('大地龙的生命至少 1');
    return out;
  }
  check_transform(b) {
    const out = { minutes: Math.round(num(b.minutes, 1, 100000, '变身分钟数')), eventOn: !!b.eventOn, eventDrops: [],
      mode: ['gift', 'self', 'both'].includes(b.mode) ? b.mode : 'gift', count: Math.round(num(b.count == null ? GIFT_COUNT : b.count, 1, 1000, '每次需要的个数')) };
    for (const e of (Array.isArray(b.eventDrops) ? b.eventDrops : []).slice(0, 40)) {
      const itemId = Number(e.itemId);
      if (!GREEN[itemId]) throw new Error('活动掉落只能是绿色蝶翅、蜥蜴尾刺、狐狸皮、龙骨');
      const monster = String(e.monster || '*').trim() || '*';
      out.eventDrops.push({ monster, itemId, chance: num(e.chance, 0, 100, '活动掉落概率'), minCount: Math.round(num(e.minCount || 1, 1, 100, '最少数量')), maxCount: Math.round(num(e.maxCount || e.minCount || 1, 1, 100, '最多数量')) });
    }
    return out;
  }
  exportConfig() { return clone(this.bucket); }
  importConfig(v) {
    const next = {};
    for (const part of Object.keys(DEFAULTS)) if (v && v[part]) next[part] = this['check_' + part](merge(DEFAULTS[part], v[part]));
    for (const k of Object.keys(this.bucket)) delete this.bucket[k];
    Object.assign(this.bucket, next);
    this.server.store.markDirty();
  }
  hasCustom() { return Object.keys(this.bucket).length > 0; }
  reset() { for (const k of Object.keys(this.bucket)) delete this.bucket[k]; this.server.store.markDirty(); }

  // ---------- cards ----------
  altarOf(id) { for (const [k, a] of Object.entries(CARD_ALTARS)) if (id >= a.start && id < a.start + a.n) return k; return null; }
  pickCard(c) {
    const pool = [];
    for (const [k, a] of Object.entries(CARD_ALTARS)) {
      const aw = Number(c.altars[k]); if (!(aw > 0)) continue;
      let sum = 0; const ws = [];
      for (let i = 0; i < a.n; i += 1) { const w = c.weights[a.start + i] == null ? 1 : Number(c.weights[a.start + i]); ws.push(w); sum += w; }
      if (!(sum > 0)) continue;
      ws.forEach((w, i) => { if (w > 0) pool.push([a.start + i, aw / Object.keys(CARD_ALTARS).length * w / sum]); });
    }
    const total = pool.reduce((n, e) => n + e[1], 0);
    if (!(total > 0)) return 0;
    let r = Math.random() * total;
    for (const [id, w] of pool) { r -= w; if (r < 0) return id; }
    return pool[pool.length - 1][0];
  }
  // Called by cardpuzzle on every kill.
  cardDrop(scene, m, killer) {
    const c = this.cfg().cards;
    if (!c.on || !killer || !m || !scene || (m.level || 1) < c.minLevel) return;
    const Balance = this.server.features.balance && this.server.features.balance.constructor;
    const kind = Balance && Balance.mapCategory ? Balance.mapCategory(scene.map.id || scene.mapRef) : '其他';
    const mult = c.cats[kind] == null ? 1 : Number(c.cats[kind]);
    const chance = c.chance / 100 * mult * (c.useDropRate ? (this.server.config.dropRate || 1) : 1);
    if (!(chance > 0) || Math.random() >= chance) return;
    const id = this.pickCard(c);
    const item = id && C.makeItem(killer.ch, id, 1);
    if (!item) return;
    // V15.2 (Q16): straight into the killer's bag (left drop notice); on the ground if full.
    const b152 = this.server.features.batch152;
    if (b152) b152.giveCard(scene, m, killer, item);
    else scene.dropGroundItem(item, m.x, m.y, { ownerPlayerId: killer.id, ownerEnemyId: m.id });
  }
  // V15.2: whether a timed event (限时活动) is on; without the module, always.
  eventOn(key) { const b = this.server.features.batch152; return b ? b.isOn(key) : true; }
  extraCard(p, key, where) {
    const c = this.cfg().cards;
    const chance = Number(c[key]) / 100;
    if (!c.on || !(chance > 0) || Math.random() >= chance) return;
    const id = this.pickCard(c);
    const item = id && C.makeItem(p.ch, id, 1);
    if (!item) return;
    const changed = p.addItem(item);
    if (!changed) { this.server.ext.tell(p, '你在' + where + '找到了一张' + item.name + '，可惜背包满了。'); return; }
    p.commitItems({ inv: changed, dropMessage: '在' + where + '找到了：' + item.name });
  }

  // ---------- drop overview ----------
  dropOverview(q) {
    const bal = this.server.features.balance;
    const s = String(q || '').trim();
    const rows = new Map();
    for (const rec of bal.catalog().values()) {
      const custom = bal.dropsFor(rec.monsterId);
      const list = custom || rec.template.drops || [];
      for (const d of list) {
        if (d.type === 'gold') continue;
        const ids = Array.isArray(d.oneOf) && d.oneOf.length ? d.oneOf : [d.itemId];
        for (const id of ids) {
          const t = cat.getTemplate(Number(id));
          const name = (t && t.name) || d.name || ('物品' + id);
          if (s && !(String(id) === s || name.includes(s))) continue;
          const key = Number(id);
          if (!rows.has(key)) rows.set(key, { itemId: key, name, monsters: [] });
          let chance = (Number(d.chance) || 0) * 100;
          if (key === SHARD && !custom) chance = this.cfg().dragon.shardPercent;
          rows.get(key).monsters.push({ monsterId: rec.monsterId, name: rec.template.name, level: rec.template.level, maps: rec.maps.slice(0, 4), chance: Math.round(chance * 1000) / 1000, edited: !!custom, special: !!d.legacySpecialDrop, label: d.name || name });
        }
      }
    }
    return [...rows.values()].sort((a, b) => a.itemId - b.itemId).slice(0, s ? 200 : 60);
  }
  // Sets the chance (percent) of one item on the given monsters, keeping every other field
  // of the drop (affixes of special drops included).
  setDropChance(itemId, chance, monsterIds) {
    const bal = this.server.features.balance;
    const pct = num(chance, 0, 100, '概率');
    const done = [];
    for (const mid of monsterIds || []) {
      const rec = bal.catalog().get(mid);
      if (!rec) continue;
      const list = clone(bal.dropsFor(mid) || rec.template.drops || []);
      let hit = 0;
      for (const d of list) if (d.type !== 'gold' && Number(d.itemId) === Number(itemId)) { d.chance = pct / 100; hit += 1; }
      if (!hit) continue;
      bal.cfg.drops = bal.cfg.drops || {};
      bal.cfg.drops[mid] = list;
      done.push(rec.template.name);
    }
    this.server.store.markDirty();
    return done.length ? '已改 ' + done.length + ' 种怪物：' + done.join('、') : '没有怪物掉这件物品';
  }
  // combat.dropLoot: the drop list for a monster (shard chance and event drops applied).
  dropsFor(m, base, edited) {
    const c = this.cfg();
    let out = base;
    if (!edited && base.some((d) => Number(d.itemId) === SHARD)) out = base.map((d) => (Number(d.itemId) === SHARD ? Object.assign({}, d, { chance: c.dragon.shardPercent / 100 }) : d));
    // V15.2 (Q1): no shards while the 屠龙 event is off.
    if (!this.eventOn('dragon')) out = out.filter((d) => Number(d.itemId) !== SHARD);
    if (c.transform.eventOn && this.eventOn('transform') && c.transform.eventDrops.length && !m.def.v15Boss) {
      const key = String(m.def.monsterId || ''), name = String(m.def.name || '');
      const extra = c.transform.eventDrops.filter((e) => e.monster === '*' || e.monster === key || e.monster === name || e.monster === String(m.def.sourceId || ''))
        .map((e) => ({ type: 'item', itemId: e.itemId, chance: e.chance / 100, minCount: e.minCount, maxCount: e.maxCount, eventDrop: true }));
      if (extra.length) out = out.concat(extra);
    }
    return out;
  }

  // ---------- 米索莉 ----------
  hasGun(p) {
    if (p.countItem(GUN) > 0) return true;
    const w = p.ch.equipment && p.ch.equipment.weapon;
    return !!(w && w.itemId === GUN);
  }
  mslState(p, message) {
    const c = this.cfg().dragon;
    if (!this.eventOn('dragon')) message = '屠龙活动现在没有开启，请留意活动公告。';
    this.server.ext.send(p, 'msl', {
      message: message || '', closed: !this.eventOn('dragon'), shards: p.countItem(SHARD), crystal: p.countItem(CRYSTAL) > 0, gun: this.hasGun(p), gunner: p.ch.profession === 'gunner',
      bullets: [603, 604, 605, 606].map((id) => ({ itemId: id, name: TEMPLATES[id][0], price: c.prices[id], mult: c.mult[id], have: p.countItem(id) })),
      gold: p.ch.gold,
    });
  }
  mslFuse(p) {
    if (!this.eventOn('dragon')) return this.mslState(p);
    if (!this.near(p)) return this.mslState(p, '请走到光明大祭祀米索莉身边再说。');
    if (p.countItem(CRYSTAL) > 0) return this.mslState(p, '你已经有一颗大地之心了。');
    if (p.countItem(SHARD) < 100) return this.mslState(p, '要 100 片黄色水晶碎片才能融合大地之心，你只有 ' + p.countItem(SHARD) + ' 片。');
    const crystal = C.makeItem(p.ch, CRYSTAL, 1, { ext: { bound: true } });
    const removed = p.removeItemCount(SHARD, 100);
    const added = p.addItem(crystal);
    if (!added) { p.addItem(C.makeItem(p.ch, SHARD, 100)); return this.mslState(p, '背包满了，空出一格再来。'); }
    p.commitItems({ inv: removed.concat(added), dropMessage: '100 片黄色水晶碎片融合成了黄色水晶（大地之心）！' });
    this.server.store.markDirty();
    this.mslState(p, '光明照耀着你！100 片碎片已经融合成大地之心。凭它可以向我领取封印的火枪。');
  }
  mslGun(p) {
    if (!this.eventOn('dragon')) return this.mslState(p);
    if (!this.near(p)) return this.mslState(p, '请走到光明大祭祀米索莉身边再说。');
    if (p.countItem(CRYSTAL) < 1) return this.mslState(p, '没有黄色水晶（大地之心），不能领取封印的火枪。');
    if (this.hasGun(p)) return this.mslState(p, '你已经有一把封印的火枪了。');
    const gun = C.makeItem(p.ch, GUN, 1, { ext: { bound: true, dragonGun: p.ch.id } });
    const added = gun && p.addItem(gun);
    if (!added) return this.mslState(p, '背包满了，空出一格再来。');
    p.ch.dragonQuest = Object.assign({}, p.ch.dragonQuest, { gunAt: Date.now() });
    p.commitItems({ inv: added, dropMessage: '领到了封印的火枪！' });
    this.mslState(p, p.ch.profession === 'gunner' ? '这把封印的火枪交给你了。装上封印的魔法子弹，才能伤到邪恶的大地之龙。' : '这把封印的火枪交给你了。只有枪手才能使用它。');
  }
  mslBuy(p, d) {
    if (!this.eventOn('dragon')) return this.mslState(p);
    const c = this.cfg().dragon;
    const id = Number(d.itemId);
    const n = Math.max(1, Math.min(100, Math.trunc(Number(d.count)) || 1));
    if (!c.prices[id] && c.prices[id] !== 0) return this.mslState(p, '没有这种子弹。');
    if (!this.near(p)) return this.mslState(p, '请走到光明大祭祀米索莉身边再说。');
    if (p.countItem(CRYSTAL) < 1) return this.mslState(p, '没有黄色水晶（大地之心），不能购买封印的魔法子弹。');
    if (!this.hasGun(p)) return this.mslState(p, '没有封印的火枪，不能购买封印的魔法子弹。');
    const cost = c.prices[id] * n;
    if (p.ch.gold < cost) return this.mslState(p, '金币不够：' + n + ' 个要 ' + cost + ' 金币。');
    const added = p.addItem(C.makeItem(p.ch, id, n));
    if (!added) return this.mslState(p, '背包满了，空出一格再来。');
    p.ch.gold -= cost; p.paramsDirty = true;
    p.commitItems({ inv: added, dropMessage: '买了 ' + n + ' 个' + TEMPLATES[id][0] + '，花了 ' + cost + ' 金币' });
    this.mslState(p, '买好了。愿光明指引你的子弹！');
  }
  near(p) {
    const sc = p.scene;
    if (!sc || sc.mapRef !== 'pintu') return false;
    // 光明大祭祀米索莉 stands at decor (2115, 2279) of 拼卡圣坛 (pixel y is negative).
    return Math.hypot(p.x - 2115, p.y + 2279) < 900;
  }

  // ---------- the gun ----------
  // A quest gun (handed out by 米索莉) is unsealed for gunners, at any level.
  static gunAllowed(ch, item) { return !!(item && Number(item.itemId) === GUN && item.ext && item.ext.dragonGun && ch && ch.profession === 'gunner'); }
  holdsGun(p) { const w = p.ch.equipment && p.ch.equipment.weapon; return !!(w && w.itemId === GUN); }
  // combat.strikeEnemy: the damage of a hit after the 屠龙 rules.
  adjustDamage(p, m, damage, o) {
    const gun = this.holdsGun(p);
    if (!m.v15Boss) return gun ? 0 : damage;
    const c0 = this.cfg().dragon;
    // V15.2 (Q6, the official rule): other weapons and skills hurt it as usual (its 2000
    // defence is high); the gun with a bullet uses the bullet multiplier, the gun without
    // one hits like bare hands. The old bullet-only rule stays as an admin switch.
    if (!c0.bulletOnly) {
      if (!gun || !o.normal) return damage;
      const bid = BULLETS.find((b) => p.countItem(b) >= (PER_SHOT[b] || 1));
      if (!bid) {
        this.hint(p, '没有封印的魔法子弹，火枪的威力和空手一样。');
        const w = p.ch.equipment.weapon;
        const wAtk = ((w && w.bonusAttrs) || []).filter((a) => a.key === 'attack').reduce((n, a) => n + (Number(a.value) || 0), 0);
        const bare = Math.max(1, p.stats.attack - wAtk) * (0.9 + Math.random() * 0.2);
        return Math.max(1, Math.round(bare * 300 / (300 + Math.max(0, (m.defense || 0) - (p.stats.breakPower || 0)))));
      }
      const used = p.removeItemCount(bid, PER_SHOT[bid] || 1);
      if (used) p.commitItems({ inv: used });
      return Math.max(1, Math.round(p.stats.attack * (0.9 + Math.random() * 0.2) * (Number(c0.mult[bid]) || 1)));
    }
    if (!gun || !o.normal) {
      this.hint(p, '只有装备封印的火枪、带着封印的魔法子弹普通攻击，才能伤到大地龙。');
      return 0;
    }
    const c = this.cfg().dragon;
    // 三发 / 六发 bullets go out 3 / 6 at a time: one shot uses that many (best kind first).
    const id = BULLETS.find((b) => p.countItem(b) >= (PER_SHOT[b] || 1));
    if (!id) { this.hint(p, '没有封印的魔法子弹（三发子弹一枪要 3 颗，六发要 6 颗），火枪的威力和空手一样。'); return 1; }
    const changed = p.removeItemCount(id, PER_SHOT[id] || 1);
    if (changed) p.commitItems({ inv: changed });
    return Math.max(1, Math.round(p.stats.attack * (0.9 + Math.random() * 0.2) * (Number(c.mult[id]) || 1)));
  }
  hint(p, text) {
    const now = Date.now();
    if (now - (p.v15HintAt || 0) < 4000) return;
    p.v15HintAt = now;
    this.server.ext.tell(p, text);
  }

  // ---------- 大地龙 ----------
  bossDef() {
    const c = this.cfg().dragon;
    const s = c.stats;
    const drops = [];
    if (c.scalePercent > 0) drops.push({ type: 'item', itemId: SCALE, chance: c.scalePercent / 100, minCount: 1, maxCount: 1 });
    if (c.goldPercent > 0 && c.gold > 0) drops.push({ type: 'gold', chance: c.goldPercent / 100, minCount: c.gold, maxCount: c.gold });
    return { monsterId: BOSS_ID, sourceId: 801, name: '大地龙', model: 'u_bossdragon', level: s.level, hp: s.hp, maxHp: s.hp, defense: s.defense, breakPower: s.breakPower,
      damage: s.damage, attackRange: s.attackRange, detectionRange: s.detectionRange, moveSpeed: 30, baseExp: s.baseExp, fireAttack: s.fireAttack, attackType2: 306,
      projectile: 'huoqiu', drops, v15Boss: true };
  }
  aliveDragons() {
    const out = [];
    for (const sc of this.server.scenes.values()) for (const m of sc.enemies.values()) if (m.v15Boss && m.alive) out.push({ id: m.id, world: sc.world, map: sc.mapRef, x: Math.round(m.x), y: Math.round(m.y), hp: Math.round(m.hp), maxHp: m.maxHp });
    return out;
  }
  spawnPoint(sc) {
    const c = this.cfg().dragon;
    const map = sc.map;
    if (c.x || c.y) { const p = map.nearestOpenPixel(c.x, c.y, 20); if (p) return p; }
    const cx = map.width * 24, cy = -map.height * 12;   // the middle of the map (64x24 tiles)
    return map.nearestOpenPixel(cx, cy, 40) || map.nearestWalkablePixel(cx, cy, 80);
  }
  // V15.2 (Q5): one 大地龙 per world on a random map of the list (焚骨沙漠 1-6 by default);
  // everyone sees a centre notice (like a level-up), and it has timeLimitMin to be killed.
  summon(worlds) {
    const c = this.cfg().dragon;
    const list = worlds && worlds.length ? worlds : this.server.config.worlds;
    const maps = (c.maps && c.maps.length ? c.maps : [c.map]).filter((m) => this.server.maps.ids().includes(m));
    const done = [];
    for (const w of list) {
      if (this.aliveDragons().some((d) => d.world === w)) continue;
      const mapRef = maps[Math.floor(Math.random() * maps.length)];
      const sc = mapRef && this.server.getScene(w, mapRef);
      if (!sc) continue;
      const at = this.spawnPoint(sc);
      if (!at) continue;
      const b152 = this.server.features.batch152;
      const def = b152 ? b152.withEdits(this.bossDef()) : this.bossDef();
      const m = sc.addMonster(def, at, null);
      m.v15Boss = true;
      m.summonedBy = 'v15';
      m.v15SpawnAt = Date.now();
      m.moveToward = () => false;   // it does not walk
      m.markDirty();
      done.push({ world: w, map: mapRef });
    }
    for (const d of done) {
      const name = this.server.maps.nameOf(d.map) || d.map;
      for (const p of this.server.playersById.values()) {
        if (p.ch.world !== d.world) continue;
        const text = '大地震动……邪恶的大地之龙出现在' + name + '！';
        this.server.ext.tell(p, '【屠龙】' + text + '勇士们，带上封印的火枪和魔法子弹！' + (c.timeLimitMin > 0 ? '（' + c.timeLimitMin + ' 分钟内必须打倒它）' : ''));
        this.server.ext.send(p, 'centre_notice', { text });
      }
    }
    return done.length ? '大地龙已出现：' + done.map((d) => d.world + ' / ' + (this.server.maps.nameOf(d.map) || d.map)).join('，') : '没有召唤：各世界都已经有一只活着的大地龙';
  }
  dismiss() {
    let n = 0;
    for (const sc of this.server.scenes.values()) for (const m of [...sc.enemies.values()]) if (m.v15Boss) { sc.enemies.delete(m.id); sc.removedEnemyIds.push(m.id); n += 1; }
    return '已收回 ' + n + ' 只大地龙';
  }
  tick(now) {
    if (!this.bucket) return;
    const c = this.cfg().dragon;
    const clock = this.server.clock;
    // V15.2 (Q21): the daily time is Beijing time from the network clock.
    const hm = clock ? clock.hm() : String(new Date(now).getHours()).padStart(2, '0') + ':' + String(new Date(now).getMinutes()).padStart(2, '0');
    if (hm !== this.lastMinute) {
      this.lastMinute = hm;
      const want = c.dailyTime && c.dailyTime.padStart(5, '0');
      if (want && hm === want && this.eventOn('dragon')) this.summon();
      if (c.respawnHours > 0 && this.eventOn('dragon')) {
        const st = this.bucket.state || (this.bucket.state = {});
        if (!this.aliveDragons().length && now - (st.lastKillAt || 0) >= c.respawnHours * 3600000 && st.lastKillAt) { st.lastKillAt = 0; this.summon(); }
      }
    }
    if (now - this.lastExpiryCheck > 5000) {
      this.lastExpiryCheck = now;
      for (const p of this.server.playersById.values()) if (p.ch.transform && p.ch.transform.until <= now) this.endTransform(p);
      for (const [rid, g] of this.gifts) if (now > g.until) this.refundGift(rid, '对方没有回应，礼物退回给你了。');
      // V15.2 (Q23): not killed in time -> it leaves.
      if (c.timeLimitMin > 0) {
        for (const sc of this.server.scenes.values()) for (const m of [...sc.enemies.values()]) {
          if (!m.v15Boss || !m.alive || !m.v15SpawnAt || now - m.v15SpawnAt < c.timeLimitMin * 60000) continue;
          sc.enemies.delete(m.id); sc.removedEnemyIds.push(m.id);
          for (const p of this.server.playersById.values()) if (p.ch.world === sc.world) { this.server.ext.tell(p, '【屠龙】时间到，屠龙失败！！！大地之龙离开了。'); this.server.ext.send(p, 'centre_notice', { text: '时间到，屠龙失败！！！' }); }
        }
      }
    }
  }
  // V15.2 (Q22, Q24): the notice names the last hitter; 龙牙 2634 to every damager still on
  // the map (or only the killer).
  onKill(m, killer, scene) {
    if (!m.v15Boss) return;
    const st = this.bucket.state || (this.bucket.state = {});
    st.lastKillAt = Date.now();
    this.server.store.markDirty();
    const c = this.cfg().dragon;
    const who = killer ? (killer.name || killer.ch.name) : '';
    const text = '大地之龙被 ' + who + ' 击败！';
    const world = scene ? scene.world : (killer && killer.ch.world);
    for (const p of this.server.playersById.values()) {
      if (world && p.ch.world !== world) continue;
      this.server.ext.tell(p, '【屠龙】' + text);
      this.server.ext.send(p, 'centre_notice', { text });
    }
    const got = c.fangMode === 'killer' ? [killer] : [...m.threat.keys()].map((id) => scene && scene.players.get(id));
    for (const p of got) {
      if (!p || !p.ch) continue;
      const it = C.makeItem(p.ch, 2634, 1);
      const idx = it && p.addItem(it);
      if (idx) p.commitItems({ inv: idx, dropMessage: '获得了：龙牙' });
      else if (it && scene) scene.dropGroundItem(it, p.x, p.y, { ownerPlayerId: p.id });
      this.server.ext.tell(p, '您获得龙牙一个!!!');
    }
  }
  // V15.2 (Q7): a ghost on the map of a living 大地龙 goes back to town and revives there.
  sendHome(p, combat) {
    const c = this.cfg().dragon;
    const sc = combat.scene;
    if (!c.reviveInTown || ![...sc.enemies.values()].some((m) => m.v15Boss && m.alive)) return false;
    const town = this.townFor(sc.mapRef);
    if (!town) return false;
    const r = this.server.transferPlayer(p, town, {});
    if (!r.success) return false;
    p.scene.combat.revive(p);
    this.server.ext.tell(p, '大地之龙的威压下无法原地复活，你被送回了' + (this.server.maps.nameOf(town) || '城里') + '。');
    return true;
  }
  // The nearest town (a map without monsters that has a revive point) by map links.
  townFor(mapRef) {
    this.towns = this.towns || {};
    if (this.towns[mapRef] !== undefined) return this.towns[mapRef];
    const maps = this.server.maps;
    const seen = new Set([mapRef]);
    let q = [mapRef], found = null, fallback = null;
    for (let depth = 0; depth < 12 && q.length && !found; depth += 1) {
      const next = [];
      for (const id of q) {
        let doc; try { doc = maps.rawDoc(id); } catch (_) { continue; }
        for (const cn of doc.connections || []) for (const o of cn.options || []) {
          const to = maps.normalize(o.mapId);
          if (!to || seen.has(to) || !maps.has(to)) continue;
          seen.add(to); next.push(to);
          if (maps.huntingMaps().has(to)) continue;
          let d2; try { d2 = maps.rawDoc(to); } catch (_) { continue; }
          const decor = (d2.decor || d2.decors || []);
          if (!found && JSON.stringify(decor).includes('resurge')) found = to;
          if (!fallback) fallback = to;
        }
      }
      q = next;
    }
    this.towns[mapRef] = found || fallback;
    return this.towns[mapRef];
  }

  // ---------- green gifts and transforms ----------
  giftCount() { return Math.max(1, Math.round(Number(this.cfg().transform.count) || GIFT_COUNT)); }
  greenUse(p, it) {
    const g = GREEN[it.itemId];
    const t = this.cfg().transform;
    // V15.2 (Q2-Q4): only while the 愚人节 event is on; gift / self / both; count set.
    if (!this.eventOn('transform')) { this.server.ext.tell(p, '愚人节活动未开启，现在不能变身。'); return undefined; }
    const need = this.giftCount();
    const have = p.countItem(it.itemId);
    if (have < need) { this.server.ext.tell(p, '变身物品不能少于 ' + need + ' 个！'); return undefined; }
    if (t.mode === 'self') return this.selfTransform(p, it.itemId);
    const sc = p.scene;
    const others = sc ? [...sc.players.values()].filter((q) => q !== p && q.alive) : [];
    others.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
    this.server.ext.send(p, 'gift_pick', { itemId: it.itemId, itemName: TEMPLATES[it.itemId][0], becomes: g.name, count: need, self: t.mode === 'both',
      players: others.slice(0, 8).map((q) => ({ id: q.id, name: q.name || q.ch.name })) });
    return undefined;
  }
  // Mode 'self' / 'both': use the materials on yourself.
  selfTransform(p, id) {
    const info = GREEN[id];
    const need = this.giftCount();
    const removed = p.removeItemCount(id, need);
    if (!removed) { this.server.ext.tell(p, '变身物品不能少于 ' + need + ' 个！'); return undefined; }
    p.commitItems({ inv: removed });
    const minutes = this.cfg().transform.minutes;
    p.ch.transform = { model: info.model, name: info.name, until: Date.now() + minutes * 60000 };
    this.applyModel(p);
    this.server.ext.tell(p, '你用掉了 ' + need + ' 个' + TEMPLATES[id][0] + '，身体发生了变异……你变成了' + info.name + '！（' + minutes + ' 分钟）');
    return undefined;
  }
  giftSend(p, d) {
    const id = Number(d.itemId);
    const g = GREEN[id];
    if (!g) return;
    if (!this.eventOn('transform')) return this.server.ext.tell(p, '愚人节活动未开启，现在不能变身。');
    const mode = this.cfg().transform.mode;
    if (d.self) { if (mode === 'gift') return this.server.ext.tell(p, '这件礼物只能送给别人。'); return this.selfTransform(p, id); }
    if (mode === 'self') return this.server.ext.tell(p, '现在只能自己使用变身物品。');
    const q = this.server.playersById.get(String(d.to));
    if (!q || !q.alive || q.scene !== p.scene || q === p) return this.server.ext.tell(p, '对方不在这张地图上了。');
    if (this.gifts.has(q.id)) return this.server.ext.tell(p, (q.name || q.ch.name) + ' 正在考虑另一份礼物，请稍后再送。');
    const need = this.giftCount();
    const removed = p.removeItemCount(id, need);
    if (!removed) return this.server.ext.tell(p, '变身物品不能少于 ' + need + ' 个！');
    p.commitItems({ inv: removed });
    this.gifts.set(q.id, { from: p.id, fromName: p.name || p.ch.name, itemId: id, count: need, until: Date.now() + 60000 });
    this.server.ext.send(q, 'gift_offer', { from: p.name || p.ch.name, itemName: TEMPLATES[id][0], count: need, becomes: g.name, minutes: this.cfg().transform.minutes });
    this.server.ext.tell(p, '礼物已经送出，等待 ' + (q.name || q.ch.name) + ' 接收。');
  }
  refundGift(rid, why) {
    const g = this.gifts.get(rid);
    if (!g) return;
    this.gifts.delete(rid);
    const from = this.server.playersById.get(g.from);
    if (!from) return;   // the giver logged out: the gift is gone, as an item in the post would be
    const added = from.addItem(C.makeItem(from.ch, g.itemId, g.count || GIFT_COUNT));
    if (added) from.commitItems({ inv: added });
    this.server.ext.tell(from, why + (added ? '' : '（背包满了，礼物没能退回）'));
  }
  giftAnswer(p, d) {
    const g = this.gifts.get(p.id);
    if (!g) return;
    if (!d.accept) return this.refundGift(p.id, (p.name || p.ch.name) + ' 拒绝了你的礼物，礼物退回给你了。');
    if (!this.eventOn('transform')) return this.refundGift(p.id, '愚人节活动已经结束，礼物退回给你了。');
    this.gifts.delete(p.id);
    const info = GREEN[g.itemId];
    const minutes = this.cfg().transform.minutes;
    p.ch.transform = { model: info.model, name: info.name, until: Date.now() + minutes * 60000 };
    this.applyModel(p);
    this.server.ext.tell(p, '你收下了 ' + g.fromName + ' 送的' + TEMPLATES[g.itemId][0] + '，身体发生了变异……你变成了' + info.name + '！（' + minutes + ' 分钟）');
    const from = this.server.playersById.get(g.from);
    if (from) this.server.ext.tell(from, (p.name || p.ch.name) + ' 收下了你的礼物，变成了' + info.name + '！');
  }
  endTransform(p) {
    delete p.ch.transform;
    this.applyModel(p);
    this.server.ext.tell(p, '变身的效果消失了，你恢复了原来的样子。');
  }
  applyModel(p) {
    p.ch.appearance = Object.assign({}, p.ch.appearance, { model: C.modelForCharacter(p.ch) });
    p.recompute(true); p.paramsDirty = true; p.markDirty(); p.flushParams();
    if (this.server.features.professions) this.server.features.professions.push(p);
    this.server.store.markDirty();
  }
  onEnter(p) {
    if (p.ch.transform && p.ch.transform.until <= Date.now()) { delete p.ch.transform; p.ch.appearance = Object.assign({}, p.ch.appearance, { model: C.modelForCharacter(p.ch) }); }
  }
}

// Built-in models (no upload needed): 大地龙 from the client's own field animation, and the
// transform looks for players from the client's monster art.
const BUILTIN_MODELS = {
  monster: { u_bossdragon: () => '/cdn_dump/named/map/map/mapsource/ani/field/bossdragon.ale' },
  player: Object.fromEntries(Object.values(GREEN).map((g) => [g.model, (act) => '/cdn_dump/named/charactor/enemy/' + g.src + '/' + act + '.ale'])),
};

module.exports = { Batch15, BUILTIN_MODELS, GREEN, TEMPLATES, DEFAULTS };
