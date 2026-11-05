'use strict';
// Runtime state of an in-world character bound to a session.
const C = require('./character');
const A = require('./affixes');
const cat = require('./catalog');
const { EQUIP_SLOTS } = cat;

class Player {
  constructor(session, ch, server) {
    this.session = session;
    this.ch = ch;
    this.server = server;
    this.id = ch.id;
    this.name = ch.name;
    this.scene = null;
    this.x = ch.x;
    this.y = ch.y;
    this.z = 0;
    this.path = [];          // remaining server-side waypoints [{x,y}]
    this.lastSeq = 0;        // last ACTION seq received (echoed for reconciliation)
    this.state = 'alive';
    this.tomb = null;
    this.diedAt = 0;
    this.ghostAt = 0;
    this.syncSeq = 0;
    this.dirty = true;
    this.paramsDirty = false;
    this.lastAttackAt = 0;
    this.lastHitAt = 0;
    this.regenAcc = 0;
    this.buffs = [];
    this.lollipopGlow = null;
    this.party = null;
    this.trade = null;
    this.stall = null;
    this.interactions = {};  // feature panels (bank/smith/...) keyed by name
    this.combatTargets = new Map();
    // Items saved before the affix rules changed get the current bonuses.
    for (const it of ch.inventory) A.migrateItem(it);
    for (const s of EQUIP_SLOTS) A.migrateItem(ch.equipment[s]);
    // Eleventh batch: sealed / level-gated equipment shows its current requirement.
    for (const it of ch.inventory) cat.refreshItem(it);
    for (const s of EQUIP_SLOTS) cat.refreshItem(ch.equipment[s]);
    // Core attributes are locked to the profession now: the old dragon redistribution goes.
    if (ch.cardPuzzle && ch.cardPuzzle.bonusCoreAttrs) delete ch.cardPuzzle.bonusCoreAttrs;
    this.recompute(true);
    if (ch.hp == null || ch.hp <= 0) ch.hp = this.stats.maxHp;
    if (ch.stamina == null) ch.stamina = this.stats.maxStamina;
  }

  recompute(silent = false) {
    const prevLevel = this.stats ? this.stats.combatLevel : null;
    this.lastLevelPoints = C.settleLevelPoints(this.ch);
    this.stats = C.computeStats(this.ch);
    this.ch.hp = Math.min(this.ch.hp == null ? this.stats.maxHp : this.ch.hp, this.stats.maxHp);
    this.ch.stamina = Math.min(this.ch.stamina == null ? this.stats.maxStamina : this.ch.stamina, this.stats.maxStamina);
    if (!silent) { this.paramsDirty = true; this.markDirty(); }
    return prevLevel;
  }

  get moveSpeed() { return this.stats.moveSpeed; }
  // The mount shown under the character (the client's originalFlight).
  get flight() {
    const mode = this.stats && this.stats.mount;
    if (!mode) return null;
    return { mode, mountedAt: (this.ch.mounts && this.ch.mounts.mountedAt) || Date.now(), expiresAt: C.mountExpiresAt(this.ch, mode) };
  }
  get alive() { return this.state === 'alive'; }

  markDirty() { this.dirty = true; this.syncSeq += 1; }

  params() {
    return C.buildParams(this.ch, this.stats, {
      teamName: this.party ? this.party.name : '',
      duty: this.party ? (this.party.leaderId === this.id ? '队长' : '队员') : '',
      activeBuffs: this.buffs.filter((b) => b.expiresAt > Date.now()).map((b) => ({ id: b.id, name: b.name, expiresAt: b.expiresAt })),
      cardPuzzle: this.server.features.cardPuzzle ? this.server.features.cardPuzzle.paramsFor(this) : undefined,
    });
  }

  // Snapshot as consumed by ActorSyncController.applyPlayerSync.
  sync() {
    const s = {
      playerId: this.id,
      playerName: this.name,
      professionName: C.PROFESSION_LABELS[this.ch.profession] || '',
      profession: this.ch.profession,
      combatLevel: this.stats.combatLevel,
      movementMode: this.ch.movementMode,
      moving: this.path.length > 0,
      state: this.state,
      x: round2(this.x), y: round2(this.y), z: 0,
      moveSpeed: this.moveSpeed,
      hp: Math.round(this.ch.hp), maxHp: this.stats.maxHp,
      stamina: Math.round(this.ch.stamina), maxStamina: this.stats.maxStamina,
      seq: this.lastSeq,
      timestamp: Date.now(),
      path: this.path.map((p) => [round2(p.x), round2(p.y)]),
      appearance: Object.assign({}, this.ch.appearance),
      alignment: this.ch.alignment || 0,
    };
    if (this.tomb && this.state !== 'alive') { s.tombstoneX = this.tomb.x; s.tombstoneY = this.tomb.y; s.tombstoneZ = 0; }
    if (this.lollipopGlow) s.originalLollipopGlow = { itemId: this.lollipopGlow };
    const flight = this.flight;
    if (flight) s.originalFlight = flight;
    return s;
  }

  send(op, data) { return this.session.send(op, data); }

  // --- inventory helpers ---
  get inventory() { return this.ch.inventory; }
  get equipment() { return this.ch.equipment; }

  itemState() {
    return {
      revision: this.ch.revision,
      serverSeq: this.server.nextSeq(),
      inventory: { cols: C.INV_COLS, rows: C.INV_ROWS, slots: this.ch.inventory.map(cloneItem) },
      equipment: Object.fromEntries(EQUIP_SLOTS.map((s) => [s, cloneItem(this.ch.equipment[s])])),
      params: this.params(),
    };
  }

  sendItemState() { this.paramsDirty = false; this.send(this.server.op.ITEM_STATE, this.itemState()); }

  // Emit an ITEM_DELTA for the given changes (inventory indexes / equip slots)
  // and always piggy-back fresh params.
  commitItems({ inv = [], equip = [], params = true, dropMessage } = {}) {
    this.ch.revision += 1;
    const changes = [];
    for (const i of new Set(inv)) changes.push({ type: 'set_inventory', index: i, item: cloneItem(this.ch.inventory[i]) });
    for (const s of new Set(equip)) changes.push({ type: 'set_equip', slot: s, item: cloneItem(this.ch.equipment[s]) });
    // Equipment changes the stats; any item change can change the weight and so the speed.
    const speed = this.stats.moveSpeed;
    if (equip.length || inv.length) this.recompute(true);
    if (this.stats.moveSpeed !== speed) this.markDirty();
    if (params) { changes.push({ type: 'set_params', params: this.params() }); this.paramsDirty = false; }
    const data = { revision: this.ch.revision, serverSeq: this.server.nextSeq(), changes };
    if (dropMessage) data.dropMessage = dropMessage;
    this.send(this.server.op.ITEM_DELTA, data);
    this.server.store.markDirty();
    if (equip.length) this.markDirty();
  }

  flushParams() {
    if (!this.paramsDirty) return;
    this.commitItems({});
  }

  findFreeSlot() { return this.ch.inventory.findIndex((s) => !s); }

  // Adds an item (stacking where possible). Returns changed indexes or null if no room.
  addItem(item) {
    const inv = this.ch.inventory;
    const changed = [];
    if (C.canStack(item, item)) {
      for (let i = 0; i < inv.length; i += 1) {
        if (inv[i] && C.canStack(inv[i], item)) { inv[i].count += item.count; changed.push(i); return changed; }
      }
    }
    const free = this.findFreeSlot();
    if (free < 0) return null;
    inv[free] = item; changed.push(free);
    return changed;
  }

  countItem(itemId) { return this.ch.inventory.reduce((n, it) => n + (it && it.itemId === itemId ? it.count : 0), 0); }

  removeItemCount(itemId, count) {
    const changed = [];
    for (let i = 0; i < this.ch.inventory.length && count > 0; i += 1) {
      const it = this.ch.inventory[i];
      if (!it || it.itemId !== itemId) continue;
      const take = Math.min(count, it.count);
      it.count -= take; count -= take;
      if (it.count <= 0) this.ch.inventory[i] = null;
      changed.push(i);
    }
    return count === 0 ? changed : null;
  }

  weight() { return C.inventoryWeight(this.ch); }

  // Whether taking `extra` more weight goes over the limit. The limit only
  // blocks when the weightLimit setting is on (admin page); off by default.
  overWeight(extra) {
    if (!this.server.config.weightLimit) return false;
    return this.weight() + extra > this.stats.maxWeight;
  }
}

function round2(v) { return Math.round(v * 100) / 100; }
function cloneItem(it) { return it ? JSON.parse(JSON.stringify(it)) : null; }

module.exports = { Player, cloneItem };
