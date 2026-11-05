'use strict';
// Gardens. Modern gardens (newgarden_01..03, 创造者果园) let gardeners buy seeds
// and plant them in tree pits; legacy gardens (garden_01..06, 怀旧果园) have
// fixed fruit trees anyone with a work card can adopt. Trees grow by "service
// minutes" (09:00-24:00, 900 per service day): mature after 5 days, harvestable
// for 2 more, while water / food / pests drive their life.
const C = require('../game/character');
const cat = require('../game/catalog');
const { skillLevel, skillTotals } = require('./crafting/data');

const DAY = 900;
const MATURE = 5 * DAY;
const MAX = 7 * DAY;
const CARE_COOLDOWN_MS = 10000;
const E = {
  BAD_REQUEST: 1, NOT_IN_GARDEN: 2, PLOT_NOT_FOUND: 3, NOT_GARDENER: 4, LEVEL_TOO_LOW: 5, CAPACITY_REACHED: 6, PLOT_OCCUPIED: 7,
  NOT_OWNER: 8, NO_SEED: 9, NOT_ENOUGH_GOLD: 10, BAG_FULL: 11, CARE_COOLDOWN: 12, NOT_MATURE: 13, WORK_CARD_REQUIRED: 14, HARVEST_EXPIRED: 15,
};

const MODERN_TREES = [
  { key: 'tianyu', name: '天玉果树', seed: 106, fruit: 101, price: 200, level: 1 },
  { key: 'manluo', name: '曼罗树', seed: 107, fruit: 102, price: 300, level: 10 },
  { key: 'binglian', name: '冰恋果树', seed: 108, fruit: 103, price: 400, level: 20 },
  { key: 'dingding', name: '丁丁树', seed: 109, fruit: 104, price: 500, level: 35 },
  { key: 'caise', name: '彩色玲珑树', seed: 110, fruit: 105, price: 700, level: 50 },
];
const LEGACY_TREES = {
  'shucaomei.ale': { key: 'strawberry', name: '树草莓', fruit: 78, fee: 40 },
  'qiyuguo_zhengchang.ale': { key: 'kiwi', name: '奇玉果树', fruit: 76, fee: 50 },
  'huolianguo.ale': { key: 'firelove', name: '火恋果树', fruit: 77, fee: 60 },
};
const WORK_CARDS = { 30: 300, 60: 600, 90: 900 };
const MODERN_TREE = new Map(MODERN_TREES.map((t) => [t.key, t]));
const LEGACY_BY_KEY = new Map(Object.values(LEGACY_TREES).map((t) => [t.key, t]));
const ZONE_NAMES = {
  garden_01: '开拓者果园一区', garden_02: '勤劳者果园一区', garden_03: '开拓者果园二区',
  garden_04: '勤劳者果园二区', garden_05: '开拓者果园三区', garden_06: '勤劳者果园三区',
};
const INCIDENTS = ['夜里刮了一阵大风，果树被吹断了几根枝条。', '一群乌鸦落在果树上啄食了嫩芽。', '突然下了一场冰雹，果树受了伤。', '野兔啃坏了果树的树皮。'];

for (const t of MODERN_TREES) {
  if (!cat.templates.has(t.seed)) {
    cat.templates.set(t.seed, {
      itemId: t.seed, name: t.name.replace(/树$/, '') + '种子', desc: '创造者果园的' + t.name + '种子，园丁可以把它种进树坑。',
      equipPos: 'none', tab: 'misc', buyPrice: t.price, sellPrice: Math.floor(t.price / 2), weight: 1, durability: { cur: 1, max: 1 }, bonusAttrs: [], source: 'garden',
    });
  }
}

function modeOf(mapRef) {
  if (/^newgarden_0[1-3]$/.test(mapRef)) return 'modern';
  if (/^garden_0[1-6]$/.test(mapRef)) return 'legacy';
  return null;
}

class Garden {
  register(server) {
    this.server = server;
    this.op = server.gardenOp;
    this.plotsByMap = new Map();
    this.gardens = server.store.bucket('gardens');
    server.on(this.op.ACTION, server.requirePlayer((p, d) => this.handle(p, d || {})));
  }

  // ---------- time ----------
  serviceMinutesBetween(a, b) {
    if (!(b > a)) return 0;
    const off = this.server.config.gardenUtcOffsetMin * 60000;
    const la = a + off; const lb = b + off;
    let total = 0;
    let day = Math.floor(la / 864e5) * 864e5;
    for (let n = 0; day < lb && n < 400; n += 1, day += 864e5) {
      const s = Math.max(la, day + 9 * 3600e3); const e = Math.min(lb, day + 864e5);
      if (e > s) total += (e - s) / 60000;
    }
    return total * this.server.config.gardenTimeScale;
  }

  // ---------- plots ----------
  plotDefs(mapRef) {
    if (!this.plotsByMap.has(mapRef)) {
      const doc = this.server.maps.rawDoc(mapRef);
      const defs = [];
      for (const d of (doc && doc.decor) || []) {
        if (String(d.tag || '').toLowerCase() !== 'fruittree') continue;
        const file = String(d.path || '').split('/').pop().toLowerCase();
        defs.push({ sourceIndex: d.i, x: Math.round(d.x), y: Math.round(d.y), legacy: LEGACY_TREES[file] || null });
      }
      this.plotsByMap.set(mapRef, defs);
    }
    return this.plotsByMap.get(mapRef);
  }

  bucketFor(world, mapRef) {
    const k = world + '|' + mapRef;
    if (!this.gardens[k]) this.gardens[k] = {};
    return this.gardens[k];
  }

  gardenOf(ch) {
    ch.garden = ch.garden || { workCardExpiresAt: 0, legacyExp: 0, incidents: [] };
    return ch.garden;
  }

  // Applies growth and condition changes since the plot was last touched.
  advance(world, mapRef, plot, now) {
    if (!plot || !plot.ownerId || plot.withered) { if (plot) plot.lastAt = now; return; }
    let dm = this.serviceMinutesBetween(plot.lastAt, now);
    plot.lastAt = now;
    while (dm > 0 && !plot.withered) {
      const step = Math.min(10, dm); dm -= step;
      const dayBefore = Math.floor(plot.serviceMinutes / DAY);
      plot.serviceMinutes += step;
      const mature = plot.serviceMinutes >= MATURE;
      if (!mature) {
        plot.water = Math.max(0, plot.water - 0.045 * step);
        plot.food = Math.max(0, plot.food - 0.035 * step);
        plot.pests = Math.min(100, plot.pests + 0.03 * step);
      }
      const bad = (plot.water < 25) + (plot.food < 25) + (plot.pests > 70);
      plot.life = Math.max(0, Math.min(100, plot.life + (bad ? -0.03 * bad * step : 0.01 * step)));
      if (plot.legacy && Math.floor(plot.serviceMinutes / DAY) > dayBefore && !mature) this.incident(plot, mapRef);
      if (plot.life <= 0 || plot.serviceMinutes >= MAX) plot.withered = true;
    }
    void world;
  }

  incident(plot, mapRef) {
    const n = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i += 1) {
      const hit = 8 + Math.floor(Math.random() * 15);
      plot.life = Math.max(0, plot.life - hit);
      const owner = this.findCharacter(plot.ownerId);
      if (owner) {
        const g = this.gardenOf(owner);
        g.incidents.unshift({ occurredAt: Date.now(), treeName: plot.treeName + '（' + (ZONE_NAMES[mapRef] || mapRef) + '）', message: INCIDENTS[Math.floor(Math.random() * INCIDENTS.length)] + '生命减少' + hit + '。' });
        g.incidents.length = Math.min(g.incidents.length, 20);
      }
    }
  }

  findCharacter(id) {
    const live = this.server.playersById.get(id);
    if (live) return live.ch;
    return this.server.store.data.characters[id] || null;
  }

  stageOf(plot) {
    if (!plot || !plot.ownerId) return 'empty';
    if (plot.withered) return 'withered';
    return plot.serviceMinutes >= MATURE ? 'mature' : 'growing';
  }

  viewPlot(p, def, plot, mode) {
    const stage = this.stageOf(plot);
    const owner = !!(plot && plot.ownerId === p.id);
    const legacy = mode === 'legacy';
    const tree = plot && plot.ownerId ? (legacy ? LEGACY_BY_KEY.get(plot.treeKey) : MODERN_TREE.get(plot.treeKey)) : (legacy ? def.legacy : null);
    const cardOk = !legacy || this.gardenOf(p.ch).workCardExpiresAt > Date.now();
    return {
      sourceIndex: def.sourceIndex, mode, x: def.x, y: def.y,
      treeKey: tree ? tree.key : '', treeName: tree ? tree.name : '树坑', stage,
      growthDay: plot && plot.ownerId ? Math.min(5, Math.floor(plot.serviceMinutes / DAY) + 1) : 0,
      ownerName: plot && plot.ownerId ? plot.ownerName : '', owned: owner,
      serviceMinutes: plot && plot.ownerId ? Math.floor(plot.serviceMinutes) : 0, matureServiceMinutes: MATURE, maxServiceMinutes: MAX,
      life: plot && plot.ownerId ? Math.round(plot.life) : 0, water: plot && plot.ownerId ? Math.round(plot.water) : 0,
      food: plot && plot.ownerId ? Math.round(plot.food) : 0, pests: plot && plot.ownerId ? Math.round(plot.pests) : 0,
      canCare: owner && stage === 'growing' && cardOk, canHarvest: owner && stage === 'mature',
    };
  }

  // Trees a player owns across all gardens of one mode in their world.
  ownedTrees(p, mode) {
    const out = [];
    for (const [k, plots] of Object.entries(this.gardens)) {
      const [world, mapRef] = k.split('|');
      if (world !== p.ch.world || modeOf(mapRef) !== mode) continue;
      for (const [idx, plot] of Object.entries(plots)) if (plot && plot.ownerId === p.id) out.push({ mapRef, sourceIndex: Number(idx), plot });
    }
    return out;
  }

  gardenerLevel(p) { return C.professionLevel(p.ch, 'gardener'); }
  maxModern(level) { return Math.min(5, 2 + Math.floor(level / 20)); }
  legacyLevel(p) { return skillLevel(this.gardenOf(p.ch).legacyExp); }
  maxLegacy(level) { return Math.min(6, 1 + Math.floor(level / 3)); }
  rankName(level) { return level >= 50 ? '园艺大师' : level >= 35 ? '高级园丁' : level >= 20 ? '中级园丁' : level >= 10 ? '初级园丁' : '见习园丁'; }

  state(p, extra = {}) {
    const mapRef = p.scene.mapRef; const mode = modeOf(mapRef); const world = p.ch.world;
    const now = Date.now();
    const plots = this.bucketFor(world, mapRef);
    const views = this.plotDefs(mapRef).map((def) => {
      const plot = plots[def.sourceIndex];
      this.advance(world, mapRef, plot, now);
      return this.viewPlot(p, def, plot, mode);
    });
    const g = this.gardenOf(p.ch);
    const card = g.workCardExpiresAt > now ? Math.ceil((g.workCardExpiresAt - now) / 864e5) : 0;
    const level = this.gardenerLevel(p);
    const st = {
      mapRef, mode, serverTime: now, serverSeq: this.server.nextSeq(), message: '', profession: p.ch.profession,
      professionLevel: level, rankName: this.rankName(level), workCardRemainingDays: card, workCardExpiresAt: g.workCardExpiresAt || 0,
      plots: views,
    };
    if (mode === 'modern') {
      st.ownedTrees = this.ownedTrees(p, 'modern').length;
      st.maxTrees = this.maxModern(level);
      st.seeds = MODERN_TREES.map((t) => ({
        treeKey: t.key, treeName: t.name, price: t.price, requiredLevel: t.level, unlocked: p.ch.profession === 'gardener' && level >= t.level, ownedCount: p.countItem(t.seed),
      }));
    } else {
      const lvl = this.legacyLevel(p);
      const own = this.ownedTrees(p, 'legacy');
      st.ownedTrees = own.length; st.maxTrees = this.maxLegacy(lvl); st.seeds = [];
      const defs = (ref) => this.plotDefs(ref);
      st.legacy = {
        level: lvl, experience: g.legacyExp, nextLevelExperience: skillTotals[Math.min(skillTotals.length - 1, lvl + 1)] || g.legacyExp,
        remainingTrees: Math.max(0, st.maxTrees - own.length),
        ownTrees: own.map((o) => {
          this.advance(world, o.mapRef, o.plot, now);
          const def = defs(o.mapRef).find((d) => d.sourceIndex === o.sourceIndex) || { x: 0, y: 0 };
          return { mapRef: o.mapRef, sourceIndex: o.sourceIndex, treeKey: o.plot.treeKey, treeName: o.plot.treeName, growthDay: Math.min(5, Math.floor(o.plot.serviceMinutes / DAY) + 1), life: Math.round(o.plot.life), stage: this.stageOf(o.plot), x: def.x, y: def.y };
        }),
        unownedTrees: this.plotDefs(mapRef).filter((d) => d.legacy && !(plots[d.sourceIndex] && plots[d.sourceIndex].ownerId))
          .map((d) => ({ mapRef, sourceIndex: d.sourceIndex, treeKey: d.legacy.key, treeName: d.legacy.name, x: d.x, y: d.y })),
        incidents: g.incidents.slice(0, 8),
      };
    }
    return Object.assign(st, extra);
  }

  send(p, extra) { p.send(this.op.STATE, this.state(p, extra)); }
  err(p, code, message) { p.send(this.op.ERROR, { code, message, serverSeq: this.server.nextSeq() }); }
  broadcast(scene, except) { for (const q of scene.players.values()) if (q !== except) this.send(q); }

  // ---------- actions ----------
  handle(p, d) {
    if (!p.scene) return;
    const mapRef = p.scene.mapRef; const mode = modeOf(mapRef);
    if (!mode && !(d.action === 'release_tree' && modeOf(String(d.targetMapRef || '')))) return this.err(p, E.NOT_IN_GARDEN, '请先进入果园。');
    switch (d.action) {
      case 'snapshot': return this.send(p);
      case 'inspect': {
        const def = this.plotDefs(mapRef).find((x) => x.sourceIndex === Number(d.sourceIndex));
        if (!def) return this.err(p, E.PLOT_NOT_FOUND, '找不到这块果园地。');
        return this.send(p, { focusSourceIndex: def.sourceIndex });
      }
      case 'buy_seed': return this.buySeed(p, d, mode);
      case 'plant': return this.plant(p, d, mode);
      case 'care': return this.care(p, d);
      case 'harvest': return this.harvest(p, d, mode);
      case 'adopt': return this.adopt(p, d, mode);
      case 'buy_work_card': return this.buyCard(p, d);
      case 'release_tree': return this.release(p, d);
      default: return this.err(p, E.BAD_REQUEST, '果园管理员听不懂你的要求。');
    }
  }

  target(p, d) {
    const def = this.plotDefs(p.scene.mapRef).find((x) => x.sourceIndex === Number(d.sourceIndex));
    if (!def) { this.err(p, E.PLOT_NOT_FOUND, '找不到这块果园地。'); return null; }
    const plots = this.bucketFor(p.ch.world, p.scene.mapRef);
    const plot = plots[def.sourceIndex] || null;
    this.advance(p.ch.world, p.scene.mapRef, plot, Date.now());
    return { def, plots, plot };
  }

  buySeed(p, d, mode) {
    if (mode !== 'modern') return this.err(p, E.BAD_REQUEST, '怀旧果园不出售种子。');
    const t = MODERN_TREE.get(String(d.treeKey));
    if (!t) return this.err(p, E.BAD_REQUEST, '没有这种树种。');
    if (p.ch.profession !== 'gardener') return this.err(p, E.NOT_GARDENER, '只有园丁才能购买果树种子。');
    if (this.gardenerLevel(p) < t.level) return this.err(p, E.LEVEL_TOO_LOW, t.name + '需要园丁 ' + t.level + ' 级。');
    if (p.ch.gold < t.price) return this.err(p, E.NOT_ENOUGH_GOLD, '金币不足，' + t.name + '种子需要 ' + t.price + ' 金币。');
    const changed = p.addItem(C.makeItem(p.ch, t.seed, 1));
    if (!changed) return this.err(p, E.BAG_FULL, '背包已满。');
    p.ch.gold -= t.price;
    p.commitItems({ inv: changed });
    this.send(p, { message: '购买了一颗' + t.name + '种子，到地图上点击空树坑种下吧。' });
  }

  plant(p, d, mode) {
    if (mode !== 'modern') return this.err(p, E.BAD_REQUEST, '这里的果树需要认养。');
    const tgt = this.target(p, d); if (!tgt) return;
    const t = MODERN_TREE.get(String(d.treeKey));
    if (!t) return this.err(p, E.BAD_REQUEST, '没有这种树种。');
    if (p.ch.profession !== 'gardener') return this.err(p, E.NOT_GARDENER, '创造者果园只向园丁开放种植。');
    const level = this.gardenerLevel(p);
    if (level < t.level) return this.err(p, E.LEVEL_TOO_LOW, t.name + '需要园丁 ' + t.level + ' 级。');
    if (tgt.plot && tgt.plot.ownerId) return this.err(p, E.PLOT_OCCUPIED, '这个树坑已经种了果树。');
    if (this.ownedTrees(p, 'modern').length >= this.maxModern(level)) return this.err(p, E.CAPACITY_REACHED, '您照料的果树已达上限。');
    const changed = p.removeItemCount(t.seed, 1);
    if (!changed) return this.err(p, E.NO_SEED, '背包里没有' + t.name + '种子。');
    tgt.plots[tgt.def.sourceIndex] = this.newTree(p, t, false);
    p.commitItems({ inv: changed });
    this.server.store.markDirty();
    this.send(p, { focusSourceIndex: tgt.def.sourceIndex, message: t.name + '种下了，记得按时浇水、施肥、除虫。' });
    this.broadcast(p.scene, p);
  }

  newTree(p, t, legacy) {
    return {
      treeKey: t.key, treeName: t.name, ownerId: p.id, ownerName: p.name, plantedAt: Date.now(), lastAt: Date.now(), lastCareAt: 0,
      serviceMinutes: 0, life: 80, water: 60, food: 60, pests: 10, withered: false, legacy,
    };
  }

  care(p, d) {
    const tgt = this.target(p, d); if (!tgt) return;
    const plot = tgt.plot;
    if (!plot || plot.ownerId !== p.id) return this.err(p, E.NOT_OWNER, '您不是这棵树的主人！');
    const mode = modeOf(p.scene.mapRef);
    if (mode === 'legacy' && !(this.gardenOf(p.ch).workCardExpiresAt > Date.now())) return this.err(p, E.WORK_CARD_REQUIRED, '工作卡已到期，续卡后才能继续照料。');
    const stage = this.stageOf(plot);
    if (stage === 'withered') return this.err(p, E.HARVEST_EXPIRED, '果树已经枯萎了。');
    if (stage === 'mature') return this.err(p, E.BAD_REQUEST, '果实已经成熟，快去采收吧。');
    const now = Date.now();
    if (!['water', 'fertilize', 'pesticide'].includes(d.care)) return this.err(p, E.BAD_REQUEST, '不知道要怎样照料。');
    plot.careAt = plot.careAt || {};
    const last = plot.careAt[d.care] || 0;
    if (now - last < CARE_COOLDOWN_MS) return this.err(p, E.CARE_COOLDOWN, '操作太频繁了，请 ' + Math.ceil((CARE_COOLDOWN_MS - (now - last)) / 1000) + ' 秒后再来。');
    plot.careAt[d.care] = now;
    let message;
    if (d.care === 'water') { plot.water = Math.min(100, plot.water + 35); message = '浇了水，水分恢复到 ' + Math.round(plot.water) + '。'; } else if (d.care === 'fertilize') { plot.food = Math.min(100, plot.food + 35); message = '施了肥，肥力恢复到 ' + Math.round(plot.food) + '。'; } else if (d.care === 'pesticide') { plot.pests = Math.max(0, plot.pests - 40); message = '喷了药，虫害降到 ' + Math.round(plot.pests) + '。'; } else return this.err(p, E.BAD_REQUEST, '不知道要怎样照料。');
    plot.lastCareAt = now;
    if (mode === 'legacy') this.gardenOf(p.ch).legacyExp += 2;
    else if (p.ch.profession === 'gardener') this.server.combat.grantExp(p, { profession: 2 }, 'garden_care');
    this.server.store.markDirty();
    this.send(p, { focusSourceIndex: tgt.def.sourceIndex, message });
    this.broadcast(p.scene, p);
  }

  harvest(p, d, mode) {
    const tgt = this.target(p, d); if (!tgt) return;
    const plot = tgt.plot;
    if (!plot || plot.ownerId !== p.id) return this.err(p, E.NOT_OWNER, '您不是这棵树的主人！');
    const stage = this.stageOf(plot);
    if (stage === 'withered') return this.err(p, E.HARVEST_EXPIRED, '错过了采收期，果树已经枯萎。');
    if (stage !== 'mature') return this.err(p, E.NOT_MATURE, '果实还没有成熟。');
    const tree = mode === 'legacy' ? LEGACY_BY_KEY.get(plot.treeKey) : MODERN_TREE.get(plot.treeKey);
    const count = 1 + Math.floor(plot.life / 25);
    const changed = p.addItem(C.makeItem(p.ch, tree.fruit, count));
    if (!changed) return this.err(p, E.BAG_FULL, '背包已满，腾出空位再来采收。');
    delete tgt.plots[tgt.def.sourceIndex];
    p.commitItems({ inv: changed });
    this.server.events.emit('gardenHarvest', p);
    let extra = '';
    if (mode === 'legacy') { const before = this.legacyLevel(p); this.gardenOf(p.ch).legacyExp += 20; if (this.legacyLevel(p) > before) extra = ' 种植等级提升到 ' + this.legacyLevel(p) + ' 级！'; } else if (p.ch.profession === 'gardener') this.server.combat.grantExp(p, { profession: 30 + tree.level * 5 }, 'garden_harvest');
    this.server.store.markDirty();
    this.send(p, { message: '采收了 ' + count + ' 个' + cat.getTemplate(tree.fruit).name + '！' + extra });
    this.broadcast(p.scene, p);
  }

  adopt(p, d, mode) {
    if (mode !== 'legacy') return this.err(p, E.BAD_REQUEST, '创造者果园需要自己播种。');
    const tgt = this.target(p, d); if (!tgt) return;
    if (!tgt.def.legacy) return this.err(p, E.PLOT_NOT_FOUND, '这里没有可以认养的果树。');
    if (tgt.plot && tgt.plot.ownerId) return this.err(p, E.PLOT_OCCUPIED, '这棵果树已经有主人了。');
    if (!(this.gardenOf(p.ch).workCardExpiresAt > Date.now())) return this.err(p, E.WORK_CARD_REQUIRED, '去果农老人那申请工作证吧！');
    if (this.ownedTrees(p, 'legacy').length >= this.maxLegacy(this.legacyLevel(p))) return this.err(p, E.CAPACITY_REACHED, '等级不够，您已不能再领养了！');
    const fee = tgt.def.legacy.fee;
    if (p.ch.gold < fee) return this.err(p, E.NOT_ENOUGH_GOLD, '认养费需要 ' + fee + ' 金币。');
    p.ch.gold -= fee; p.paramsDirty = true; p.flushParams();
    tgt.plots[tgt.def.sourceIndex] = this.newTree(p, tgt.def.legacy, true);
    this.server.store.markDirty();
    this.send(p, { focusSourceIndex: tgt.def.sourceIndex, message: '领养成功，开始培育' + tgt.def.legacy.name + '吧！' });
    this.broadcast(p.scene, p);
  }

  buyCard(p, d) {
    const days = Number(d.workCardDays);
    const price = WORK_CARDS[days];
    if (!price) return this.err(p, E.BAD_REQUEST, '没有这种工作卡。');
    if (p.ch.gold < price) return this.err(p, E.NOT_ENOUGH_GOLD, '金币不足，' + days + '天工作卡需要 ' + price + ' 金币。');
    p.ch.gold -= price; p.paramsDirty = true; p.flushParams();
    const g = this.gardenOf(p.ch);
    g.workCardExpiresAt = Math.max(Date.now(), g.workCardExpiresAt || 0) + days * 864e5;
    this.server.store.markDirty();
    this.send(p, { message: '购买了' + days + '天果园工作卡，有效期至 ' + new Date(g.workCardExpiresAt).toLocaleDateString('zh-CN') + '。' });
  }

  release(p, d) {
    const mapRef = String(d.targetMapRef || p.scene.mapRef);
    if (modeOf(mapRef) !== 'legacy') return this.err(p, E.BAD_REQUEST, '只能退还怀旧果园的果树。');
    const plots = this.bucketFor(p.ch.world, mapRef);
    const plot = plots[Number(d.sourceIndex)];
    if (!plot || plot.ownerId !== p.id) return this.err(p, E.NOT_OWNER, '这不是您的果树。');
    delete plots[Number(d.sourceIndex)];
    this.server.store.markDirty();
    if (modeOf(p.scene.mapRef)) this.send(p, { message: '已经退还了' + plot.treeName + '。' });
    const sc = this.server.scenes.get(p.ch.world + '|' + mapRef);
    if (sc) this.broadcast(sc, p);
  }

  // Dev helper: grow every tree the player owns by n service minutes.
  grow(p, minutes) {
    let n = 0;
    for (const mode of ['modern', 'legacy']) {
      for (const o of this.ownedTrees(p, mode)) {
        const t = o.plot; t.serviceMinutes = Math.min(MAX - 1, t.serviceMinutes + minutes); n += 1;
      }
    }
    this.server.store.markDirty();
    if (p.scene && modeOf(p.scene.mapRef)) this.send(p, { message: '果树长大了。' });
    return n;
  }
}

module.exports = { Garden, modeOf, MODERN_TREES, LEGACY_TREES };
