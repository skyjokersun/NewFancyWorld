'use strict';
const cat = require('../game/catalog');
// Game balance the admin page can change (eighth batch):
// - each profession's core attribute spread (力量 敏捷 感知 聪明 运气), bucket 'attrSpreads';
// - monster stats by monster id, applied on every map that has that monster, bucket
//   'monsterConfig'.monsters;
// - which monsters a map holds, how many and how fast they come back, including
//   monsters taken from other maps, bucket 'monsterConfig'.maps.
// Every part has a one-click reset back to the shipped data.
const C = require('../game/character');
const log = require('../util/log');

// Monster fields the monster tab edits: [key, label, min, max].
const MONSTER_FIELDS = [
  ['level', '等级', 1, 999], ['maxHp', '生命', 1, 2000000000], ['damage', '攻击', 0, 100000000],
  ['defense', '防御', 0, 100000000], ['breakPower', '破坏', 0, 100000000], ['attackRange', '攻击距离', 40, 2000],
  ['detectionRange', '发现距离', 80, 3000], ['moveSpeed', '移动速度', 30, 1000], ['baseExp', '经验', 0, 100000000],
  ['fireResist', '火抗（%）', 0, 100], ['iceResist', '冰抗（%）', 0, 100], ['thunderResist', '雷抗（%）', 0, 100], ['poisonResist', '毒抗（%）', 0, 100],
  // Thirteenth batch: flat element attack (original ani.tab fire_ex ...), projectile and skill.
  ['fireAttack', '火攻击（固定值）', 0, 1000000], ['iceAttack', '冰攻击（固定值）', 0, 1000000], ['thunderAttack', '雷攻击（固定值）', 0, 1000000], ['poisonAttack', '毒攻击（固定值）', 0, 1000000],
  ['projectileSpeed', '弹道速度（0 = 默认）', 0, 20000], ['skillChance', '放技能的几率（%）', 0, 100],
];
// Text fields (thirteenth batch): [key, label, kind]. The admin page shows a list to pick from.
const MONSTER_TEXT_FIELDS = [['model', '造型', 'model'], ['projectile', '弹道', 'projectile'], ['skill', '技能', 'skill']];
const TEXT_KEYS = MONSTER_TEXT_FIELDS.map((f) => f[0]);

function intIn(v, lo, hi, what) {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < lo || n > hi) throw new Error(what + '必须是 ' + lo + '–' + hi + ' 之间的整数');
  return n;
}
const clone = (o) => JSON.parse(JSON.stringify(o));

class Balance {
  register(server) { this.server = server; }

  onStart() {
    const s = this.server;
    this.spreads = s.store.bucket('attrSpreads');
    this.cfg = s.store.bucket('monsterConfig');
    if (!this.cfg.monsters) this.cfg.monsters = {};
    if (!this.cfg.maps) this.cfg.maps = {};
    C.setAttrSpreads(this.spreads);
    // Maps read their monster list through here, so saved edits apply from the first spawn.
    s.maps.spawnOverlay = (id, ms) => this.effectiveSpawns(id, ms);
    for (const map of s.maps.maps.values()) map.monsterSpawns = this.effectiveSpawns(map.id, map.baseMonsterSpawns);
    s.maps.hunting = null;
    const n = Object.keys(this.cfg.monsters).length + Object.keys(this.cfg.maps).length;
    if (n) log.info('monster config: ' + n + ' saved edit(s) applied from the admin page');
  }

  // --- profession attribute spreads ---
  spreadView() {
    return Object.keys(C.ATTR_SPREAD).map((prof) => ({
      profession: prof, name: C.PROFESSION_LABELS[prof] || prof,
      values: C.CORE_KEYS.map((k) => C.attrSpread(prof)[k]), defaults: C.ATTR_SPREAD[prof].slice(),
      changed: !!this.spreads[prof],
    }));
  }

  // values: five numbers in the order 力量 敏捷 感知 聪明 运气, or null for the default.
  setSpread(prof, values) {
    if (!C.ATTR_SPREAD[prof]) throw new Error('没有这个职业：' + prof);
    const label = C.PROFESSION_LABELS[prof] || prof;
    if (values == null) delete this.spreads[prof];
    else {
      if (!Array.isArray(values) || values.length !== 5) throw new Error('请填写 5 项属性');
      // Original rule (com/wishdlgs.fcc): each 3-10, 34 at most.
      const v = values.map((x, i) => intIn(x, 3, 10, ['力量', '敏捷', '感知', '聪明', '运气'][i]));
      if (v.reduce((a, b) => a + b, 0) > 34) throw new Error('五项属性加起来最多 34 点（原版规则：每项 3–10）');
      if (v.join() === C.ATTR_SPREAD[prof].join()) delete this.spreads[prof]; else this.spreads[prof] = v;
    }
    this.applySpreads();
    return [label + '的默认属性 → ' + C.CORE_KEYS.map((k) => C.attrSpread(prof)[k]).join(' / ')];
  }

  resetSpreads() {
    for (const k of Object.keys(this.spreads)) delete this.spreads[k];
    this.applySpreads();
    return ['所有职业的默认属性已恢复'];
  }

  applySpreads() {
    C.setAttrSpreads(this.spreads);
    for (const p of this.server.playersById.values()) if (p.ch) { p.recompute(); p.paramsDirty = true; p.markDirty(); }
    this.server.store.markDirty();
  }

  // --- monsters and maps ---
  // Every monster in the shipped map data, with its stats (the same on every map) and maps.
  catalog() {
    if (this.monsterIndex) return this.monsterIndex;
    const idx = new Map();
    const maps = this.server.maps;
    for (const id of maps.ids()) {
      let ms;
      try { ms = maps.rawDoc(id).monsterSpawns; } catch (_) { continue; }
      if (!ms || !Array.isArray(ms.entries)) continue;
      for (const e of ms.entries) {
        if (!e || !e.monsterId) continue;
        let rec = idx.get(e.monsterId);
        if (!rec) { rec = { monsterId: e.monsterId, template: clone(e), maps: [] }; idx.set(e.monsterId, rec); }
        if (!rec.maps.includes(id)) rec.maps.push(id);
      }
    }
    // Thirteenth batch: original monsters no web map places, when the client has their model.
    const OM = require('../game/original-monsters');
    const known = new Set([...idx.values()].map((r) => Number(r.template.sourceId)).filter(Boolean));
    const models = new Set([...idx.values()].map((r) => String(r.template.model || '')));
    for (const t of OM.unplaced(known, models)) idx.set(t.monsterId, { monsterId: t.monsterId, template: t, maps: [], unplaced: true });
    // Twelfth batch: monsters made on the admin page (新职业与上传): a copy of an
    // existing monster with its own id, name and model; the 地图怪物 page puts them on maps.
    for (const c of Object.values((this.cfg && this.cfg.custom) || {})) idx.set(c.monsterId, { monsterId: c.monsterId, template: clone(c.template), maps: [], custom: true });
    this.monsterIndex = idx;
    return idx;
  }

  // Existing monster models plus uploaded ones (u_...).
  models() {
    const set = new Set();
    for (const r of this.catalog().values()) if (r.template.model && !String(r.template.model).startsWith('u_')) set.add(String(r.template.model));
    const up = this.server.features.uploads ? this.server.features.uploads.monsterModels() : [];
    return [...set].sort().concat(up.sort());
  }
  // Projectiles a monster can throw: the client's own and uploaded ones.
  projectileOptions() {
    const own = ['bingjian', 'mage_firebolt', 'huoqiu', 'bolt', 'arrow', 'bullet', 'gunbullet', 'laser', 'bingbao', 'huojian', 'sanbullet', 'waterbullet', 'ice_bullet', 'stone', 'guanghuan01'];
    const up = this.server.features.uploads ? this.server.features.uploads.projectiles() : [];
    return [['', '默认（照原版攻击方式）'], ['none', '无弹道（近身）']].concat(own.map((k) => [k, k]), up.map((k) => [k, k + '（上传）']));
  }
  fieldsView() {
    const sk = this.server.features.customSkills;
    const opts = {
      model: this.models().map((m) => [m, m]),
      projectile: this.projectileOptions(),
      skill: [['', '无']].concat(sk ? sk.list().map((x) => [x.id, x.name + '（' + x.id + '）']) : []),
    };
    return MONSTER_FIELDS.concat(MONSTER_TEXT_FIELDS.map(([k, label, kind]) => [k, label, null, null, { options: opts[kind] }]));
  }
  customMonsters() { return Object.values((this.cfg && this.cfg.custom) || {}).map((c) => ({ monsterId: c.monsterId, name: c.template.name, model: c.template.model, from: c.from, fromName: c.fromName })); }
  createMonster(b) {
    const src = this.catalog().get(String(b.from || ''));
    if (!src || src.custom) throw new Error('请选一个现有怪物做底子');
    const name = String(b.name || '').trim();
    if (!name || [...name].length > 12) throw new Error('怪物名须为 1–12 个字');
    const model = String(b.model || src.template.model || '').trim();
    if (!this.models().includes(model)) throw new Error('造型要选现有怪物的造型，或「新职业与上传」里上传的造型');
    this.cfg.custom = this.cfg.custom || {};
    this.cfg.customNext = (this.cfg.customNext || 0) + 1;
    const id = 'custom_' + this.cfg.customNext;
    const t = clone(src.template);
    Object.assign(t, { monsterId: id, name, model });
    delete t.count; delete t.stackCount;
    this.cfg.custom[id] = { monsterId: id, template: t, from: src.monsterId, fromName: src.template.name };
    this.monsterIndex = null;
    this.server.store.markDirty();
    return ['已新建怪物 ' + name + '（' + id + '，数值照 ' + src.template.name + '）。到「怪物」页改数值和掉落，到「地图怪物」页放到地图上。'];
  }
  removeMonster(id) {
    const c = this.cfg.custom && this.cfg.custom[id];
    if (!c) throw new Error('只能删除后台新建的怪物');
    delete this.cfg.custom[id];
    delete this.cfg.monsters[id];
    if (this.cfg.drops) delete this.cfg.drops[id];
    const touched = [];
    for (const [m, e] of Object.entries(this.cfg.maps)) { const n = e.entries.length; e.entries = e.entries.filter((x) => x.monsterId !== id); if (e.entries.length !== n) touched.push(m); }
    this.monsterIndex = null;
    this.rebuild(touched);
    this.server.store.markDirty();
    return ['已删除 ' + c.template.name];
  }

  baseStats(e) {
    const o = Object.fromEntries(MONSTER_FIELDS.map(([k]) => [k, k === 'maxHp' ? (e.maxHp || e.hp || 100) : (e[k] || 0)]));
    for (const k of TEXT_KEYS) o[k] = e[k] == null ? '' : String(e[k]);
    return o;
  }

  // The map's monster list as it plays: the saved map edit (or the shipped list) with the
  // saved monster stats laid over every entry.
  effectiveSpawns(id, base) {
    const edit = this.cfg && this.cfg.maps[id];
    let ms = base ? clone(base) : null;
    if (edit) {
      ms = ms || { respawnPolicy: { baseSeconds: 60 }, respawnSeconds: 60, entries: [] };
      const byId = new Map((ms.entries || []).map((e) => [e.monsterId, e]));
      ms.entries = edit.entries.map((x) => {
        const src = byId.get(x.monsterId) || (this.catalog().get(x.monsterId) || {}).template;
        if (!src) return null;
        const e = clone(src);
        e.count = x.count; e.stackSize = Math.max(1, Math.min(x.stackSize || e.stackSize || 1, x.count || 1));
        delete e.stackCount;
        return e;
      }).filter(Boolean);
      if (edit.respawnSeconds) {
        ms.respawnSeconds = edit.respawnSeconds;
        ms.respawnPolicy = Object.assign({}, ms.respawnPolicy, { baseSeconds: edit.respawnSeconds, minimumSeconds: Math.min(edit.respawnSeconds, (ms.respawnPolicy && ms.respawnPolicy.minimumSeconds) || 24) });
      }
    }
    if (ms && Array.isArray(ms.entries) && this.cfg) {
      for (const e of ms.entries) {
        const o = this.cfg.monsters[e.monsterId];
        if (!o) continue;
        Object.assign(e, o);
        if (o.maxHp) e.hp = o.maxHp;
      }
    }
    return ms;
  }

  monstersView() {
    return Array.from(this.catalog().values()).map((r) => ({
      monsterId: r.monsterId, name: r.template.name, model: r.template.model, maps: r.maps,
      categories: [...new Set(r.maps.map((m) => Balance.mapCategory(m)))],
      mapNames: r.maps.map((m) => (this.server.maps.nameOf && this.server.maps.nameOf(m)) || m),
      stats: Object.assign(this.baseStats(r.template), this.cfg.monsters[r.monsterId] || {}),
      defaults: this.baseStats(r.template), changed: !!this.cfg.monsters[r.monsterId], unplaced: !!r.unplaced,
    })).sort((a, b) => a.stats.level - b.stats.level || a.monsterId.localeCompare(b.monsterId));
  }

  setMonster(monsterId, stats) {
    const rec = this.catalog().get(monsterId);
    if (!rec) throw new Error('没有这个怪物：' + monsterId);
    if (stats == null) delete this.cfg.monsters[monsterId];
    else {
      const base = this.baseStats(rec.template);
      const o = {};
      for (const [k, label, lo, hi] of MONSTER_FIELDS) {
        if (stats[k] === undefined) continue;
        const v = intIn(stats[k], lo, hi, label);
        if (v !== base[k]) o[k] = v;
      }
      for (const f of this.fieldsView().filter((x) => x[4])) {
        const k = f[0];
        if (stats[k] === undefined) continue;
        const v = String(stats[k] || '');
        if (!f[4].options.some((x) => x[0] === v)) throw new Error(f[1] + '：没有「' + v + '」这一项');
        if (v !== base[k]) o[k] = v;
      }
      if (Object.keys(o).length) this.cfg.monsters[monsterId] = o; else delete this.cfg.monsters[monsterId];
    }
    this.rebuild(rec.maps.concat(Object.keys(this.cfg.maps).filter((m) => this.cfg.maps[m].entries.some((e) => e.monsterId === monsterId))));
    return [rec.template.name + (stats == null ? ' 已恢复默认' : ' 已保存，所有地图生效')];
  }

  // --- drops per monster (twelfth batch, Q22): every map; chance in percent on the page,
  // 0-1 in the data; the admin drop-rate multipliers still apply on top.
  dropsFor(monsterId) {
    const d = this.cfg && this.cfg.drops && this.cfg.drops[monsterId];
    return Array.isArray(d) ? d : null;
  }
  dropsView(monsterId) {
    const rec = this.catalog().get(monsterId);
    if (!rec) throw new Error('没有这个怪物：' + monsterId);
    const view = (list) => (list || []).map((d) => {
      const ids = Array.isArray(d.oneOf) && d.oneOf.length ? d.oneOf : [d.itemId];
      return { type: d.type === 'gold' ? 'gold' : 'item', itemId: d.type === 'gold' ? 0 : Number(ids[0]) || 0,
        name: d.type === 'gold' ? '金币' : (d.name || (cat.getTemplate(ids[0]) || {}).name || ''), special: !!d.legacySpecialDrop,
        chance: Math.round((Number(d.chance) || 0) * 100000) / 1000, minCount: d.minCount || 1, maxCount: d.maxCount || d.minCount || 1 };
    });
    return { monsterId, name: rec.template.name, defaults: view(rec.template.drops), custom: this.dropsFor(monsterId) ? view(this.dropsFor(monsterId)) : null,
      rates: { item: this.server.config.dropRate, gold: this.server.config.goldDropRate } };
  }
  setDrops(monsterId, list) {
    const rec = this.catalog().get(monsterId);
    if (!rec) throw new Error('没有这个怪物：' + monsterId);
    this.cfg.drops = this.cfg.drops || {};
    if (list == null) { delete this.cfg.drops[monsterId]; this.server.store.markDirty(); return [rec.template.name + ' 的掉落已恢复默认']; }
    if (!Array.isArray(list) || list.length > 40) throw new Error('掉落最多 40 项');
    const out = list.map((d, i) => {
      const what = '第 ' + (i + 1) + ' 项';
      const chance = Number(d.chance);
      if (!(chance >= 0 && chance <= 100)) throw new Error(what + '的概率须在 0–100% 之间');
      const minCount = intIn(d.minCount == null ? 1 : d.minCount, 1, 100000000, what + '的最少数量');
      const maxCount = intIn(d.maxCount == null ? minCount : d.maxCount, minCount, 100000000, what + '的最多数量');
      if (d.type === 'gold') return { type: 'gold', chance: chance / 100, minCount, maxCount };
      const t = cat.getTemplate(Number(d.itemId));
      if (!t) throw new Error(what + '：没有这个物品 ' + d.itemId);
      return { type: 'item', itemId: Number(d.itemId), name: t.name, chance: chance / 100, minCount, maxCount };
    });
    this.cfg.drops[monsterId] = out;
    this.server.store.markDirty();
    return [rec.template.name + ' 的掉落已保存（' + out.length + ' 项），所有地图生效'];
  }

  // Admin list filters (ninth batch): a map's kind from its id.
  static mapCategory(id) {
    if (/^(mine|smelt)/.test(id)) return '矿洞';
    if (/^(abattoir|job_fight|team_pk|teamfight|pk_|snow_ctf|snow_tdm)/.test(id)) return '竞技场';
    if (/^snow/.test(id)) return '雪原';
    if (/^dk\d/.test(id)) return '林地猎场';
    if (/^wl_/.test(id)) return '荒野猎场';
    if (/^(hunt_|huangyezhuizong)/.test(id)) return '猎场';
    if (/(^home|^litterhome|^townhouse|_room|^room|^po_|^po16|^c_gb_r|^team_r_|^garden_|^newgarden_)/.test(id)) return '房间';
    if (/(_in\d?$|^square|^fair|^bank|^shop|^red_|^smith|^bar_|^park|^temple|^newpark|^garden$|^newgarden$|^flowergarden|^beautyparlor|^furnitureshop|^ferry|^coop|^daduibu|^office|^teamoffice|^grubgoldman|^wkchajob|^1_1)/.test(id)) return '城镇';
    return '其他';
  }

  mapsView() {
    const maps = this.server.maps;
    return maps.ids().map((id) => {
      const base = maps.rawDoc(id).monsterSpawns;
      const ms = this.effectiveSpawns(id, base);
      return {
        mapId: id, name: maps.nameOf ? maps.nameOf(id) : '', category: Balance.mapCategory(id), changed: !!this.cfg.maps[id],
        respawnSeconds: (ms && (ms.respawnPolicy && ms.respawnPolicy.baseSeconds || ms.respawnSeconds)) || 60,
        entries: ms && Array.isArray(ms.entries) ? ms.entries.map((e) => ({ monsterId: e.monsterId, name: e.name, level: e.level, count: e.count || (e.stackCount || 1) * (e.stackSize || 1), stackSize: e.stackSize || 1 })) : [],
      };
    });
  }

  // body: { entries: [{monsterId, count, stackSize}], respawnSeconds } or null for the default.
  setMap(mapId, body) {
    const maps = this.server.maps;
    const id = maps.normalize(mapId);
    if (!maps.has(id)) throw new Error('没有这张地图：' + mapId);
    if (body == null) delete this.cfg.maps[id];
    else {
      if (!Array.isArray(body.entries)) throw new Error('怪物列表格式不对');
      const seen = new Set();
      const entries = body.entries.map((x) => {
        const rec = this.catalog().get(x && x.monsterId);
        if (!rec) throw new Error('没有这个怪物：' + (x && x.monsterId));
        if (seen.has(x.monsterId)) throw new Error(rec.template.name + ' 重复了');
        seen.add(x.monsterId);
        return { monsterId: x.monsterId, count: intIn(x.count, 0, 200, rec.template.name + '的数量'), stackSize: intIn(x.stackSize == null ? 1 : x.stackSize, 1, 50, rec.template.name + '的每群数量') };
      });
      this.cfg.maps[id] = { entries, respawnSeconds: body.respawnSeconds == null || body.respawnSeconds === '' ? 0 : intIn(body.respawnSeconds, 2, 86400, '刷新时间') };
    }
    this.rebuild([id]);
    return [id + (body == null ? ' 的怪物已恢复默认' : ' 的怪物已保存')];
  }

  resetMonsters() {
    const touched = Object.keys(this.cfg.maps);
    for (const k of Object.keys(this.cfg.monsters)) for (const m of (this.catalog().get(k) || { maps: [] }).maps) touched.push(m);
    this.cfg.monsters = {}; this.cfg.maps = {};
    this.rebuild(touched);
    return ['所有怪物和地图怪物设置已恢复默认'];
  }

  // Loaded maps take the new list; their scenes drop the old monsters (not summons or
  // target dummies) and spawn the new ones at once.
  rebuild(mapIds) {
    const s = this.server;
    const ids = new Set(mapIds);
    s.maps.hunting = null;
    for (const id of ids) {
      const map = s.maps.maps.get(id);
      if (!map) continue;
      map.monsterSpawns = this.effectiveSpawns(id, map.baseMonsterSpawns);
    }
    for (const sc of s.scenes.values()) {
      if (!ids.has(sc.map.id)) continue;
      for (const m of [...sc.enemies.values()]) {
        if (m.summonedBy || m.isTarget) continue;
        sc.enemies.delete(m.id); sc.removedEnemyIds.push(m.id);
      }
      sc.respawnQueue = [];
      sc.spawnInitialMonsters();
    }
    s.store.markDirty();
  }
}

module.exports = { Balance, MONSTER_FIELDS, MONSTER_TEXT_FIELDS };
