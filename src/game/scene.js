'use strict';
// A scene is one map instance inside one world. It owns the players standing in
// it, its monsters, ground items and placeable effects, and streams changes to
// its players as MOVE_UPDATE packets.
const { Monster, CORPSE_MS } = require('./monster');
const { gridToPixel } = require('./map');
const log = require('../util/log');

let sceneUid = 1;
const GROUND_ITEM_TTL_MS = 3 * 60 * 1000;
const OWNER_EXCLUSIVE_MS = 30 * 1000;
const ENEMY_REFRESH_MS = 1500;

class Scene {
  constructor(server, world, map) {
    this.server = server;
    this.world = world;
    this.map = map;
    this.mapRef = map.id;
    this.uid = sceneUid++;
    this.players = new Map();
    this.enemies = new Map();
    this.groundItems = new Map();
    this.placeables = new Map();
    this.removedPlayerIds = [];
    this.removedEnemyIds = [];
    this.attackEvents = [];
    this.respawnQueue = [];   // {at, spawn, def, home}
    this.nextDropNo = 1;
    this.lastFlushAt = 0;
    this.combat = server.combat.forScene(this);
    this.spawnInitialMonsters();
  }

  key() { return this.world + '|' + this.mapRef; }

  // Towns and post stations are safe zones unless a monster is around (one summoned there).
  combatAllowed() {
    if (!this.server.config.safeTowns) return true;
    if (this.server.maps.huntingMaps().has(this.mapRef)) return true;
    for (const m of this.enemies.values()) if (m.alive) return true;
    return false;
  }

  // --- monsters ---
  spawnInitialMonsters() {
    const ms = this.map.monsterSpawns;
    if (!ms || !Array.isArray(ms.entries)) return;
    for (const def of ms.entries) {
      const total = this.targetCount(def);
      const stackSize = Math.max(1, def.stackSize || 1);
      let made = 0;
      while (made < total) {
        const centre = this.map.randomWalkablePixel();
        if (!centre) break;
        for (let k = 0; k < stackSize && made < total; k += 1, made += 1) {
          const home = k === 0 ? centre : this.nearbyWalkable(centre, 70) || centre;
          this.addMonster(def, home, { def, centre });
        }
      }
    }
  }

  nearbyWalkable(p, radius) {
    for (let i = 0; i < 12; i += 1) {
      const a = Math.random() * Math.PI * 2; const r = Math.random() * radius;
      const x = p.x + Math.cos(a) * r; const y = p.y + Math.sin(a) * r * 0.6;
      if (this.map.isWalkablePixel(x, y) && this.map.segmentWalkable(p.x, p.y, x, y)) return { x, y };
    }
    return null;
  }

  addMonster(def, home, spawn) {
    const m = new Monster(this, spawn, def, home);
    this.enemies.set(m.id, m);
    return m;
  }

  // Monsters a spawn entry should keep alive: the map's count times the
  // server's monster count setting.
  targetCount(def) {
    const base = Math.max(0, Math.min(60, def.count || (def.stackCount || 1) * (def.stackSize || 1)));
    const rate = this.server.config.monsterCountRate == null ? 1 : this.server.config.monsterCountRate;
    return Math.max(0, Math.min(200, Math.round(base * rate)));
  }

  countFor(def) {
    let n = 0;
    for (const m of this.enemies.values()) if (m.def === def && !m.summonedBy && m.alive) n += 1;
    for (const r of this.respawnQueue) if (r.def === def) n += 1;
    return n;
  }

  // After the monster count setting changes: queue the missing monsters right
  // away, and drop queued respawns above the new count (live extras stay until killed).
  rebalanceMonsters() {
    const ms = this.map.monsterSpawns;
    if (!ms || !Array.isArray(ms.entries)) return;
    const now = Date.now();
    for (const def of ms.entries) {
      const target = this.targetCount(def);
      let have = this.countFor(def);
      if (have > target) {
        this.respawnQueue = this.respawnQueue.filter((r) => { if (r.def !== def || have <= target) return true; have -= 1; return false; });
      }
      const spawn = (this.respawnQueue.find((r) => r.def === def) || {}).spawn || ([...this.enemies.values()].find((m) => m.def === def) || {}).spawn || { def };
      for (; have < target; have += 1) this.respawnQueue.push({ at: now, def, spawn });
    }
  }

  respawnDelayMs() {
    const pol = (this.map.monsterSpawns && this.map.monsterSpawns.respawnPolicy) || {};
    const base = pol.baseSeconds || (this.map.monsterSpawns && this.map.monsterSpawns.respawnSeconds) || 60;
    const extra = Math.max(0, this.players.size - 1);
    const red = Math.min(pol.maximumReduction == null ? 0.6 : pol.maximumReduction, extra * (pol.reductionPerAdditionalPlayer == null ? 0.2 : pol.reductionPerAdditionalPlayer));
    const rate = this.server.config.respawnRate || 1;
    return Math.max(2000, Math.max((pol.minimumSeconds || 24) * 1000, base * (1 - red) * 1000) * rate);
  }

  // --- players ---
  addPlayer(player, x, y) {
    player.scene = this;
    player.x = x; player.y = y; player.path = [];
    player.ch.mapRef = this.mapRef; player.ch.x = x; player.ch.y = y;
    this.players.set(player.id, player);
    player.markDirty();
    const join = Object.assign(player.sync(), { serverSeq: this.server.nextSeq() });
    for (const p of this.players.values()) if (p !== player) p.send(this.server.op.PLAYER_JOIN, join);
    this.server.onOccupancyChanged(this.world);
  }

  removePlayer(player) {
    if (!this.players.delete(player.id)) return;
    for (const m of this.enemies.values()) if (m.targetId === player.id) m.targetId = null;
    const leave = { playerId: player.id, playerName: player.name, serverSeq: this.server.nextSeq() };
    for (const p of this.players.values()) p.send(this.server.op.PLAYER_LEAVE, leave);
    player.scene = null;
    this.server.onOccupancyChanged(this.world);
  }

  // Client hop: validate and append to the player's server path.
  // The client keeps exactly one hop in flight: it sends the next waypoint when
  // it reaches the previous one, and a new click re-routes at once. So each move
  // replaces whatever the server still had queued; appending made the server walk
  // the abandoned route first and trail the client by hundreds of pixels.
  queueMove(player, x, y) {
    const last = { x: player.x, y: player.y };
    const map = this.map;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const hop = Math.hypot(x - last.x, y - last.y);
    if (hop > 2400) return false;
    if (!map.isWalkablePixel(x, y)) {
      // The client's grid can disagree with ours on edge cells; trust short hops
      // (a rejection snaps the player back, which looks like a teleport).
      const n = map.nearestWalkablePixel(x, y, 1);
      if ((!n || Math.hypot(n.x - x, n.y - y) > 40) && hop > 160) return false;
    }
    if (hop < 0.5) { if (player.path.length) { player.path = []; player.markDirty(); } return true; }
    player.path = [{ x, y }];
    player.markDirty();
    return true;
  }

  // Place the player at an authoritative point and stop (used for corrections/teleports).
  placePlayer(player, x, y) {
    player.x = x; player.y = y; player.path = [];
    player.markDirty();
  }

  advancePlayers(dtMs) {
    for (const p of this.players.values()) {
      if (!p.path.length) continue;
      // Slightly faster than the client so the server never trails a hop chain.
      let budget = p.moveSpeed * 1.08 * dtMs / 1000;
      while (budget > 0 && p.path.length) {
        const t = p.path[0];
        const d = Math.hypot(t.x - p.x, t.y - p.y);
        if (d <= budget) { p.x = t.x; p.y = t.y; budget -= d; p.path.shift(); if (!p.path.length) p.markDirty(); }
        else { p.x += (t.x - p.x) / d * budget; p.y += (t.y - p.y) / d * budget; budget = 0; }
      }
      p.ch.x = p.x; p.ch.y = p.y;
      if (!p.alive) this.combat.checkGhostRevive(p);
    }
  }

  // --- ground items ---
  dropGroundItem(item, x, y, { source = 'monster', ownerPlayerId = null, ownerEnemyId = null } = {}) {
    const p = this.nearbyWalkable({ x, y }, 40) || { x, y };
    const dropId = 'd' + this.uid + '_' + (this.nextDropNo++);
    const now = Date.now();
    const g = {
      dropId, x: Math.round(p.x), y: Math.round(p.y), z: 0, item, source,
      ownerPlayerId: ownerPlayerId || undefined, ownerEnemyId: ownerEnemyId || undefined,
      ownerExclusiveUntil: ownerPlayerId && source === 'monster' ? now + OWNER_EXCLUSIVE_MS : undefined,
      originX: Math.round(x), originY: Math.round(y),
      expiresAt: now + GROUND_ITEM_TTL_MS, ts: now,
    };
    this.groundItems.set(dropId, g);
    this.broadcast(this.server.op.GROUND_ITEM_UPDATE, { serverSeq: this.server.nextSeq(), upserts: [publicGround(g)], removeIds: [] });
    return g;
  }

  removeGroundItem(dropId) {
    if (!this.groundItems.delete(dropId)) return;
    this.broadcast(this.server.op.GROUND_ITEM_UPDATE, { serverSeq: this.server.nextSeq(), upserts: [], removeIds: [dropId] });
  }

  groundItemState() {
    return { serverSeq: this.server.nextSeq(), items: Array.from(this.groundItems.values()).map(publicGround) };
  }

  // --- placeable effects (fireworks etc.) ---
  addPlaceable(effect) {
    this.placeables.set(effect.instanceId, effect);
    this.broadcast(this.server.op.PLACEABLE_EFFECT_UPDATE, { serverSeq: this.server.nextSeq(), upserts: [effect], removeIds: [] });
  }

  placeableState() {
    return { serverSeq: this.server.nextSeq(), items: Array.from(this.placeables.values()) };
  }

  // --- broadcast ---
  broadcast(op, data, except = null) {
    for (const p of this.players.values()) if (p !== except) p.send(op, data);
  }

  pushAttackEvent(ev) { this.attackEvents.push(ev); }

  fullSnapshot(forSession) {
    return {
      serverSeq: this.server.nextSeq(),
      moveServerSeq: forSession ? ++forSession.moveServerSeq : 0,
      timestamp: Date.now(),
      players: Array.from(this.players.values()).map((p) => p.sync()),
      enemies: Array.from(this.enemies.values()).map((m) => m.sync()),
      removedPlayerIds: [], removedEnemyIds: [],
      placeableEffects: Array.from(this.placeables.values()),
      sceneOccupancies: this.server.sceneOccupancies(this.world),
      full: true,
    };
  }

  tick(now, dtMs) {
    this.advancePlayers(dtMs);
    for (const m of this.enemies.values()) {
      if (m.state === 'dead') {
        if (now - m.deadAt >= CORPSE_MS) {
          this.enemies.delete(m.id);
          this.removedEnemyIds.push(m.id);
          if (!m.summonedBy && this.countFor(m.def) < this.targetCount(m.def)) this.respawnQueue.push({ at: m.deadAt + this.respawnDelayMs(), def: m.def, spawn: m.spawn });
        }
        continue;
      }
      if (this.players.size || m.state !== 'idle' || m.path.length) m.tick(now, dtMs);
    }
    if (this.respawnQueue.length) {
      const due = this.respawnQueue.filter((r) => r.at <= now);
      if (due.length) {
        this.respawnQueue = this.respawnQueue.filter((r) => r.at > now);
        for (const r of due) {
          const centre = r.spawn && r.spawn.centre && this.map.isWalkablePixel(r.spawn.centre.x, r.spawn.centre.y)
            ? (this.nearbyWalkable(r.spawn.centre, 90) || r.spawn.centre) : this.map.randomWalkablePixel();
          if (centre) this.addMonster(r.def, centre, r.spawn);
        }
      }
    }
    for (const [id, g] of this.groundItems) if (g.expiresAt <= now) this.removeGroundItem(id);
    for (const [id, e] of this.placeables) {
      if (e.expireAt && e.expireAt <= now) {
        this.placeables.delete(id);
        this.broadcast(this.server.op.PLACEABLE_EFFECT_UPDATE, { serverSeq: this.server.nextSeq(), upserts: [], removeIds: [id] });
      }
    }
    this.combat.tick(now);
    if (now - this.lastFlushAt >= this.server.config.syncIntervalMs) { this.lastFlushAt = now; this.flush(now); }
  }

  flush(now) {
    const players = [];
    for (const p of this.players.values()) {
      if (p.path.length && now - (p.lastBroadcastAt || 0) > ENEMY_REFRESH_MS) p.dirty = true;
      if (p.dirty) { p.dirty = false; p.lastBroadcastAt = now; players.push(p.sync()); }
    }
    const enemies = [];
    for (const m of this.enemies.values()) {
      if (m.path.length && now - m.lastBroadcastAt > ENEMY_REFRESH_MS) m.dirty = true;
      if (m.dirty) { m.dirty = false; m.lastBroadcastAt = now; enemies.push(m.sync()); }
    }
    if (!players.length && !enemies.length && !this.removedEnemyIds.length && !this.removedPlayerIds.length && !this.attackEvents.length) return;
    const base = {
      serverSeq: this.server.nextSeq(), timestamp: now, players, enemies,
      removedPlayerIds: this.removedPlayerIds, removedEnemyIds: this.removedEnemyIds,
      attackEvents: this.attackEvents, full: false,
    };
    this.removedPlayerIds = []; this.removedEnemyIds = []; this.attackEvents = [];
    for (const p of this.players.values()) {
      p.send(this.server.op.MOVE_UPDATE, Object.assign({}, base, { moveServerSeq: ++p.session.moveServerSeq }));
    }
  }

  spawnPoint() { return this.map.spawnPoint(); }
  gridPoint(gx, gy) {
    if (Number.isFinite(gx) && Number.isFinite(gy)) {
      const w = this.map.nearestWalkableGrid(Math.trunc(gx), Math.trunc(gy), 12);
      if (w) return gridToPixel(w.x, w.y);
    }
    return this.spawnPoint();
  }
}

function publicGround(g) {
  return {
    dropId: g.dropId, x: g.x, y: g.y, z: 0, item: g.item, source: g.source,
    ownerPlayerId: g.ownerPlayerId, ownerEnemyId: g.ownerEnemyId, ownerExclusiveUntil: g.ownerExclusiveUntil,
    originX: g.originX, originY: g.originY, ts: g.ts,
  };
}

module.exports = { Scene, publicGround };
void log;
