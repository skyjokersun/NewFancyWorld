'use strict';
// Legacy mining (mine_01..mine_03): smoking lodes appear around the mine
// hills. Craftsmen prospect a lode, build a well on it and then dig ore with
// the digger (dig -> save/drop, reset when jammed, teardown to leave).
const C = require('../../game/character');
const cat = require('../../game/catalog');
const D = require('./data');

const MAPS = new Set(['mine_01', 'mine_02', 'mine_03']);
const REACH = 220;
const PROSPECT_MS = 3000;
const DIG_MS = 1500;
const RESPAWN_MS = 90 * 1000;
const ACTIVE_SHARE = 0.5;

const R = { ORE: 1, NOTHING: 2, STONES: 3, JAMMED: 4, MONEY: 5, EXHAUSTED: 6, TOO_HEAVY: 7 };

class Mining {
  constructor(crafting) { this.crafting = crafting; this.server = crafting.server; this.mines = new Map(); }

  register() {
    const s = this.server;
    s.on(s.op.LEGACY_MINING_REQUEST, s.requirePlayer((p, d) => this.handle(p, d || {})));
    s.events.on('tick', (now) => this.tick(now));
    s.events.on('playerMapChanging', (p, from) => this.leave(p, from));
    s.events.on('playerLeaving', (p) => this.leave(p, p.scene));
  }

  // ---------- lode state per scene ----------
  mine(scene) {
    let m = this.mines.get(scene.key());
    if (m) return m;
    const doc = this.server.maps.rawDoc(scene.mapRef);
    const zones = [];
    for (const d of (doc && doc.decor) || []) {
      if (d.tag !== 'mineHill') continue;
      const [size, ores] = String(d.extra || '').replace(/"/g, '').split(';');
      const [w, h] = String(size || '600,550').split(',').map(Number);
      const oreIds = String(ores || '').split(',').map(Number).filter((id) => D.ORE_BY_ID.has(id));
      if (oreIds.length) zones.push({ x: d.x, y: d.y, w: w || 600, h: h || 550, oreIds });
    }
    m = { scene, zones, lodes: zones.map((z, i) => ({ id: null, zoneIndex: i, generation: 0, active: false, respawnAt: 0 })) };
    m.lodes.forEach((l) => { if (Math.random() < ACTIVE_SHARE) this.spawn(m, l); else l.respawnAt = Date.now() + Math.random() * RESPAWN_MS; });
    this.mines.set(scene.key(), m);
    return m;
  }

  spawn(m, l) {
    const z = m.zones[l.zoneIndex];
    const map = m.scene.map;
    // A walkable spot around the hill (decor y is image space, world y is negative).
    let pos = null;
    for (let i = 0; i < 80 && !pos; i += 1) {
      const x = z.x + Math.random() * z.w;
      const y = -(z.y + z.h * (0.55 + Math.random() * 0.55));
      if (map.isWalkablePixel(x, y)) pos = { x, y };
    }
    pos = pos || map.nearestWalkablePixel(z.x + z.w / 2, -(z.y + z.h), 20);
    if (!pos) return;
    const oreId = z.oreIds[Math.floor(Math.random() * z.oreIds.length)];
    const metal = D.ORE_BY_ID.get(oreId);
    l.generation += 1;
    Object.assign(l, {
      id: 'lode-' + l.zoneIndex + '-' + l.generation, active: true, x: Math.round(pos.x), y: Math.round(pos.y),
      oreId, metal, grade: metal.level === 1 ? 1 : metal.level + Math.floor(Math.random() * 6),
      remaining: 20 + Math.floor(Math.random() * 30), discoveredBy: new Set(), well: null, prospecting: null,
    });
  }

  retire(m, l) {
    if (l.well) this.dropWell(l);
    l.active = false; l.respawnAt = Date.now() + RESPAWN_MS;
    this.broadcast(m);
  }

  dropWell(l) { l.well = null; }

  snapshotFor(p, m) {
    return {
      kind: 'snapshot', mapRef: m.scene.mapRef, serverSeq: this.server.nextSeq(),
      lodes: m.lodes.filter((l) => l.id).map((l) => {
        const known = l.discoveredBy && (l.discoveredBy.has(p.id) || (l.well && l.well.ownerId === p.id));
        const own = !!(l.well && l.well.ownerId === p.id);
        return {
          id: l.id, zoneIndex: l.zoneIndex, x: l.x, y: l.y, z: 0, generation: l.generation, active: l.active,
          discovered: !!known, prospecting: !!(l.prospecting && l.prospecting.playerId === p.id),
          grade: known || l.well ? l.grade : 0, oreName: known || l.well ? l.metal.name : '', remaining: known || l.well ? l.remaining : 0,
          well: l.well ? { owned: own, ownerName: l.well.ownerName } : null,
          digging: own && !!l.well.digUntil, pendingOre: own && !!l.well.pendingOre, jammed: own && !!l.well.jammed,
        };
      }),
    };
  }

  send(p, data) { p.send(this.server.op.LEGACY_MINING_STATE, data); }
  broadcast(m) { for (const p of m.scene.players.values()) this.send(p, this.snapshotFor(p, m)); }

  result(p, d, action, ok, extra = {}) {
    this.send(p, Object.assign({ kind: 'result', action, ok, resultCode: 0, message: '', lodeId: d.lodeId || null, requestId: d.requestId, progressMessages: [], serverSeq: this.server.nextSeq() }, extra));
  }

  miningLevel(p) { return D.skillLevel(D.craftState(p.ch).mining.exp); }

  // ---------- requests ----------
  handle(p, d) {
    if (!p.scene || !MAPS.has(p.scene.mapRef)) return this.result(p, d, d.action, false, { message: '这里不是矿山。' });
    if (d.action === 'info') return this.info(p, d);
    const m = this.mine(p.scene);
    if (d.action === 'sync') return this.send(p, this.snapshotFor(p, m));
    const l = m.lodes.find((x) => x.id === d.lodeId && x.active);
    if (!l) return this.result(p, d, d.action, false, { message: '这处矿脉已经消失了。' });
    const near = Math.hypot(p.x - l.x, p.y - l.y) <= REACH;
    const own = !!(l.well && l.well.ownerId === p.id);
    const craftsman = p.ch.profession === 'craftsman';
    switch (d.action) {
      case 'prospect':
        if (!craftsman) return this.result(p, d, 'prospect', false, { message: '只有工匠才能勘探这种矿石' });
        if (!near) return this.result(p, d, 'prospect', false, { message: '离矿脉太远了，走近一点再勘探。' });
        if (m.lodes.some((x) => x.prospecting && x.prospecting.playerId === p.id)) return this.result(p, d, 'prospect', false, { message: '正在勘探中……' });
        l.prospecting = { playerId: p.id, until: Date.now() + PROSPECT_MS, requestId: d.requestId };
        return this.send(p, this.snapshotFor(p, m));
      case 'build': {
        if (!craftsman) return this.result(p, d, 'build', false, { message: '只有工匠才能勘探这种矿石' });
        if (!near) return this.result(p, d, 'build', false, { message: '离矿脉太远了。' });
        if (!l.discoveredBy.has(p.id)) return this.result(p, d, 'build', false, { message: '请先勘探这处矿脉。' });
        if (l.well) return this.result(p, d, 'build', false, { message: '这里已经有人架设了矿井。' });
        if (m.lodes.some((x) => x.well && x.well.ownerId === p.id)) return this.result(p, d, 'build', false, { message: '您已经架设了一口矿井。' });
        if (this.miningLevel(p) < l.grade) return this.result(p, d, 'build', false, { message: '您的开采等级不够，需要 ' + l.grade + ' 级。' });
        l.well = { ownerId: p.id, ownerName: p.name, digUntil: 0, pendingOre: false, jammed: false };
        p.path = []; p.markDirty();
        this.result(p, d, 'build', true, { message: '矿井架设好了，可以开始挖掘。' });
        return this.broadcast(m);
      }
      case 'dig':
        if (!own) return this.result(p, d, 'dig', false, { message: '这不是您的矿井。' });
        if (l.well.digUntil || l.well.pendingOre || l.well.jammed) return this.result(p, d, 'dig', false, { message: '挖掘机还没有复位。' });
        l.well.digUntil = Date.now() + DIG_MS; l.well.digRequest = d.requestId;
        return this.send(p, this.snapshotFor(p, m));
      case 'save': return this.save(p, d, m, l, own);
      case 'drop':
        if (!own || !l.well.pendingOre) return this.result(p, d, 'drop', false, { message: '没有可以丢弃的矿石。' });
        l.well.pendingOre = false;
        this.result(p, d, 'drop', true, { message: '' });
        return this.send(p, this.snapshotFor(p, m));
      case 'reset':
        if (!own || !l.well.jammed) return this.result(p, d, 'reset', false, { message: '挖掘机没有被卡住。' });
        l.well.jammed = false;
        this.result(p, d, 'reset', true, { message: '' });
        return this.send(p, this.snapshotFor(p, m));
      case 'teardown':
        if (!own) return this.result(p, d, 'teardown', false, { message: '这不是您的矿井。' });
        this.dropWell(l);
        this.result(p, d, 'teardown', true, { message: '矿井已经拆除。' });
        return this.broadcast(m);
      default:
        return this.result(p, d, d.action, false, { message: '未知的开采操作。' });
    }
  }

  save(p, d, m, l, own) {
    if (!own || !l.well.pendingOre) return this.result(p, d, 'save', false, { message: '没有挖到矿石。' });
    l.well.pendingOre = false;
    const t = cat.getTemplate(l.oreId);
    if (p.overWeight(t.weight || 0)) {
      this.result(p, d, 'save', false, { resultCode: R.TOO_HEAVY, message: '您再也扛不动更多的东西了！挖得的矿石丢弃。' });
      return this.send(p, this.snapshotFor(p, m));
    }
    const changed = p.addItem(C.makeItem(p.ch, l.oreId, 1));
    if (!changed) {
      this.result(p, d, 'save', false, { resultCode: R.TOO_HEAVY, message: '背包已满，挖得的矿石丢弃。' });
      return this.send(p, this.snapshotFor(p, m));
    }
    const st = D.craftState(p.ch);
    const ore = st.ores[l.oreId] = st.ores[l.oreId] || { exp: 0 };
    const before = D.skillLevel(ore.exp);
    ore.exp += 6;
    const msgs = D.gainSkill(p.ch, 'mining', 5, '开采');
    if (D.skillLevel(ore.exp) > before) msgs.push(l.metal.name + '矿熟练度提升到 ' + D.skillLevel(ore.exp) + ' 级。');
    p.commitItems({ inv: changed });
    this.result(p, d, 'save', true, { resultCode: R.ORE, oreName: l.metal.name, message: '', progressMessages: ['获得' + l.metal.name + '矿石一块。'].concat(msgs) });
    this.send(p, this.snapshotFor(p, m));
  }

  digOutcome(p, l) {
    const ore = (D.craftState(p.ch).ores[l.oreId] || { exp: 0 });
    const skill = this.miningLevel(p) + D.skillLevel(ore.exp);
    const r = Math.random();
    const pOre = Math.min(0.75, 0.42 + skill * 0.004);
    if (r < pOre) return R.ORE;
    if (r < pOre + 0.04) return R.MONEY;
    if (r < pOre + 0.12) return R.JAMMED;
    if (r < pOre + 0.3) return R.STONES;
    return R.NOTHING;
  }

  finishDig(p, m, l) {
    const w = l.well;
    const requestId = w.digRequest;
    w.digUntil = 0;
    const d = { lodeId: l.id, requestId };
    if (l.remaining <= 0) {
      this.result(p, d, 'dig', true, { resultCode: R.EXHAUSTED, message: '这里只剩下泥土和岩石了，还不换个地方？' });
      return this.retire(m, l);
    }
    const code = this.digOutcome(p, l);
    const extra = { resultCode: code, oreName: l.metal.name };
    if (code === R.ORE) { w.pendingOre = true; l.remaining -= 1; extra.message = '挖到' + l.metal.name + '矿石一块！'; }
    if (code === R.JAMMED) { w.jammed = true; extra.message = '不好，挖掘机被卡住了！'; }
    if (code === R.STONES) extra.message = '只挖到了几块没用的石头。';
    if (code === R.NOTHING) extra.message = '很不幸！什么也没挖到。';
    if (code === R.MONEY) {
      const v = 50 + Math.floor(Math.random() * 450);
      p.ch.gold += v; p.paramsDirty = true; extra.value = v; extra.message = '挖到了古人埋藏的钱财，数量：' + v + '。';
    }
    D.gainSkill(p.ch, 'mining', code === R.ORE ? 2 : 0, '开采', code === R.ORE);
    if (code === R.ORE) this.server.events.emit('mineDig', p);
    this.result(p, d, 'dig', true, extra);
    this.send(p, this.snapshotFor(p, m));
  }

  finishProspect(p, m, l) {
    const { requestId } = l.prospecting;
    l.prospecting = null;
    const d = { lodeId: l.id, requestId };
    const skill = this.miningLevel(p);
    if (Math.random() < Math.min(0.95, 0.8 + skill * 0.005 - (l.grade > skill ? 0.2 : 0))) {
      l.discoveredBy.add(p.id);
      const msgs = D.gainSkill(p.ch, 'mining', 3, '开采');
      this.result(p, d, 'prospect', true, { message: '勘探成功！这是一处' + l.metal.name + '矿，最低开采等级 ' + l.grade + ' 级，藏矿量 ' + l.remaining + '。', oreName: l.metal.name, progressMessages: msgs });
    } else {
      this.result(p, d, 'prospect', false, { message: '勘探失败，没有找到矿脉的走向。' });
    }
    this.send(p, this.snapshotFor(p, m));
  }

  tick(now) {
    if (this.lastTick && now - this.lastTick < 200) return;
    this.lastTick = now;
    for (const m of this.mines.values()) {
      let changed = false;
      for (const l of m.lodes) {
        if (!l.active) {
          if (l.respawnAt && now >= l.respawnAt && m.scene.players.size) {
            if (m.lodes.filter((x) => x.active).length < Math.ceil(m.zones.length * ACTIVE_SHARE)) { this.spawn(m, l); changed = true; } else l.respawnAt = now + RESPAWN_MS * Math.random();
          }
          continue;
        }
        if (l.prospecting && now >= l.prospecting.until) {
          const p = m.scene.players.get(l.prospecting.playerId);
          if (p) this.finishProspect(p, m, l); else l.prospecting = null;
        }
        if (l.well && l.well.digUntil && now >= l.well.digUntil) {
          const p = m.scene.players.get(l.well.ownerId);
          if (p) this.finishDig(p, m, l); else this.dropWell(l);
        }
      }
      if (changed) this.broadcast(m);
    }
  }

  leave(p, scene) {
    if (!scene || !MAPS.has(scene.mapRef)) return;
    const m = this.mines.get(scene.key());
    if (!m) return;
    let changed = false;
    for (const l of m.lodes) {
      if (l.well && l.well.ownerId === p.id) { this.dropWell(l); changed = true; }
      if (l.prospecting && l.prospecting.playerId === p.id) l.prospecting = null;
    }
    if (changed) setImmediate(() => this.broadcast(m));
  }

  info(p, d) {
    const st = D.craftState(p.ch);
    const mining = D.skillSummary(st.mining);
    const ores = D.METALS.map((metal) => {
      const exp = (st.ores[metal.ore] || { exp: 0 }).exp;
      const lvl = D.skillLevel(exp);
      return {
        name: metal.name + '矿', unlocked: mining.level >= metal.level, level: lvl, totalExp: exp,
        nextLevelTotalExp: lvl >= D.SKILL_CAP ? null : D.skillTotals[lvl + 1], title: D.skillTitle(lvl), requiredMiningLevel: metal.level,
      };
    });
    const certified = ores.filter((o) => o.level >= 50).length;
    this.send(p, {
      kind: 'info', requestId: d.requestId, serverSeq: this.server.nextSeq(),
      mining: Object.assign(mining, { certificationCompleted: certified, certificationRequired: ores.length }), ores,
    });
  }
}

module.exports = { Mining, MAPS };
