'use strict';
// GameServer: sessions, accounts, worlds/scenes, the tick loop and packet routing.
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const log = require('../util/log');
const { Store } = require('../db');
const { MapRegistry } = require('./map');
const { Accounts } = require('./accounts');
const { Scene } = require('./scene');
const { Player } = require('./player');
const { Combat } = require('./combat');
const C = require('./character');
const catalog = require('./catalog');

// Parent area that a legacy ".." exit leads back to, keyed by target map.
// Scene world id for cross-world (shared) scenes.
const CROSS_WORLD = 'cross';
// Legacy qmap link names (GameMapRegistry on the client) -> map files.
const LEGACY_MAP_ALIASES = {
  card: 'pintu', shengtan: 'pintu', camel: 'camel_in', ferry: 'ferry_in', sowntown: 'sowntown_in', horse: 'horse_in',
  workaround: 'workaround_in', abattoir_in: 'team_in', square: 'square_in', teamfight_port: 'teamfight_port_d', smith_npc01: 'smith2',
  // 裕迦山: the official 北通道 link misspells 山涧密道.
  teamfihgt_c01: 'teamfight_c01',
};
// Malformed official extras carry a '- 1 , 0 ,' prefix before the quoted link (see patch 25).
const BAD_EXTRA_PREFIX = /^\s*-?\s*\d+\s*,\s*\d+\s*,\s*/;
// 自由角斗 1–6 室: six separate rooms built from the one room map abattoir_pka.
const ARENA_ROOMS = new Set(['pk_a1', 'pk_a2', 'pk_a3', 'pk_a4', 'pk_a5', 'pk_a6']);
const ARENA_ROOM_MAP = 'abattoir_pka';
const LEGACY_PARENT_MAPS = { workaround_in: /^(new)?garden_\d+$|^flowergarden_\d+$/ };

const opcodes = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'opcodes.json'), 'utf8'));

const NAME_RE = /^[A-Za-z0-9_.\-·㐀-䶿一-鿿豈-﫿]+$/;
function nameBytes(s) { let b = 0; for (const ch of s) b += ch.charCodeAt(0) <= 0x7f ? 1 : 2; return b; }

class GameServer {
  constructor(opts = {}) {
    this.config = Object.assign({}, config, opts);
    this.log = log;
    this.op = Object.assign({}, opcodes.OpCodes);
    this.gardenOp = opcodes.GARDEN_OP_CODES || { ACTION: 5800, STATE: 5810, ERROR: 5899 };
    this.events = new EventEmitter();
    this.events.setMaxListeners(50);
    this.store = new Store(this.config.stateFile);
    this.maps = new MapRegistry(this.config.dataDir);
    catalog.registerDropTemplates(this.maps);
    this.accounts = new Accounts(this.store, opts.mailer || null);
    this.combat = new Combat(this);
    this.sessions = new Set();
    this.scenes = new Map();          // key world|mapRef -> Scene
    this.playersById = new Map();     // characterId -> Player (online)
    this.handlers = new Map();
    this.features = {};
    this.serverSeq = 0;
    this.serviceStatus = { status: 'available', title: '', message: '', returnLabel: '返回', automaticReconnect: true };
    this.registerCore();
  }

  nextSeq() { this.serverSeq += 1; return this.serverSeq; }

  // Online detection summary for /api/online and admin tooling.
  onlineSummary() {
    const now = Date.now();
    const worlds = {};
    const players = [];
    for (const p of this.playersById.values()) {
      const w = worlds[p.ch.world] || (worlds[p.ch.world] = { online: 0, maps: {} });
      w.online += 1;
      const ref = p.scene ? p.scene.mapRef : '';
      w.maps[ref] = (w.maps[ref] || 0) + 1;
      players.push({
        name: p.name, world: p.ch.world, mapRef: ref, combatLevel: p.stats.combatLevel, profession: p.ch.profession,
        state: p.state, onlineSec: Math.round((now - (p.loginAt || now)) / 1000),
        crossScene: !!(p.scene && p.scene.world === CROSS_WORLD), lastSeenMsAgo: now - (p.session.lastSeenAt || now), latencyMs: p.session.latencyMs == null ? null : p.session.latencyMs,
      });
    }
    return { serverTime: now, status: this.serviceStatus.status, online: this.playersById.size, connections: this.sessions.size, worlds, players };
  }

  findPlayerByName(name, world) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    for (const p of this.playersById.values()) if (p.name.toLowerCase() === key && (!world || p.ch.world === world)) return p;
    return null;
  }

  on(op, fn) {
    if (!Number.isFinite(op)) throw new Error('bad opcode for handler');
    this.handlers.set(op, fn);
  }

  use(name, feature) {
    this.features[name] = feature;
    if (typeof feature.register === 'function') feature.register(this);
    return feature;
  }

  systemChat(text, extra = {}) {
    return Object.assign({ channel: 'system', from: '系统', message: text, timestamp: Date.now(), serverSeq: this.nextSeq() }, extra);
  }

  // ---------- connection lifecycle ----------
  attach(session) {
    this.sessions.add(session);
    log.debug('session open', session.id, session.remote);
  }

  detach(session) {
    if (!this.sessions.delete(session)) return;
    session.closed = true;
    if (session.player) this.leaveWorld(session.player, 'disconnect');
    log.debug('session closed', session.id);
  }

  async dispatch(session, raw) {
    session.lastSeenAt = Date.now();
    if (!session.allowPacket()) { session.close(4008, 'rate'); return; }
    let packet;
    try { packet = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); } catch (e) { return; }
    if (!packet || typeof packet !== 'object' || !Number.isFinite(packet.opCode)) return;
    const h = this.handlers.get(packet.opCode);
    if (!h) { log.debug('unhandled op', packet.opCode); return; }
    const data = packet.data && typeof packet.data === 'object' ? packet.data : {};
    try {
      await h(session, data, packet);
    } catch (e) {
      log.error('handler error op=' + packet.opCode, e && e.stack || e);
      session.send(this.op.ERROR, { code: 500, message: '服务器内部错误', opCode: packet.opCode });
    }
  }

  requirePlayer(fn) {
    return (session, data, packet) => {
      if (!session.player || !session.player.scene) return undefined;
      return fn(session.player, data, packet, session);
    };
  }

  registerCore() {
    const op = this.op;
    this.on(op.CONNECT, (s, d) => {
      s.negotiated = true;
      s.clientFeatures = Array.isArray(d.features) ? d.features : [];
      s.send(op.CONNECT, { protocolVersion: 1, codec: 'json', features: ['move-stream-seq-v1'], serverName: this.config.serverName, serverTime: Date.now() });
      s.send(op.SERVICE_STATUS, Object.assign({ serverTime: Date.now() }, this.serviceStatus));
    });
    this.on(op.HEARTBEAT, (s, d) => {
      s.lastHeartbeatAt = Date.now();
      if (Number.isFinite(d.latencyMs)) s.latencyMs = Math.round(d.latencyMs);
      s.send(op.TIME_SYNC, { clientSeq: d.seq, clientTime: d.clientTime, serverTime: Date.now(), serverSeq: this.serverSeq });
    });
    this.on(op.SERVICE_STATUS_REQUEST, (s) => s.send(op.SERVICE_STATUS, Object.assign({ serverTime: Date.now() }, this.serviceStatus)));
    this.on(op.DISCONNECT, (s) => s.close(1000, 'bye'));

    this.on(op.ACCOUNT_EMAIL_CODE_REQUEST, async (s, d) => {
      const purpose = d.purpose || 'register';
      const r = purpose === 'register' && !this.config.allowRegister ? { success: false, message: this.registerClosedText() } : await this.accounts.requestCode(d.email, purpose);
      s.send(op.ACCOUNT_EMAIL_CODE_RESULT, Object.assign({ requestId: d.requestId, purpose, email: this.accounts.normalizeEmail(d.email), retryAfterSec: 0 }, r));
    });
    this.on(op.ACCOUNT_REGISTER, (s, d) => {
      const purpose = d.purpose || 'register';
      const r = !this.config.allowRegister ? { success: false, message: this.registerClosedText() } : this.accounts.register(d.email, d.password, d.code);
      s.send(op.ACCOUNT_REGISTER_RESULT, Object.assign({ requestId: d.requestId, purpose, email: this.accounts.normalizeEmail(d.email) }, r));
    });
    this.on(op.LOGIN, (s, d) => this.handleLogin(s, d));
    this.on(op.CHARACTER_CREATE, (s, d) => this.handleCharacterCreate(s, d));
    this.on(op.LOGOUT, (s) => { if (s.player) this.leaveWorld(s.player, 'logout'); s.account = null; });

    this.on(op.ACTION, this.requirePlayer((p, d) => this.handleAction(p, d.action || d)));
    this.on(op.MOVE, this.requirePlayer((p, d) => this.handleAction(p, Object.assign({ type: 'move' }, d))));
    this.on(op.ATTACK, this.requirePlayer((p, d) => this.handleAction(p, Object.assign({ type: 'attack' }, d))));
    this.on(op.SYNC_REQUEST, this.requirePlayer((p, d, pk, s) => {
      s.send(op.SYNC_SNAPSHOT, p.scene.fullSnapshot(s));
    }));
    this.on(op.MAP_SWITCH, this.requirePlayer((p, d) => this.handleMapSwitch(p, d)));
    this.on(op.MOVEMENT_MODE_UPDATE, this.requirePlayer((p, d) => {
      const mode = d.mode === 'run' ? 'run' : 'walk';
      if (p.ch.movementMode === mode) return;
      p.ch.movementMode = mode;
      p.recompute();
      p.flushParams();
    }));
  }

  // ---------- login & character creation ----------
  registerClosedText() { return String(this.config.registerClosedText || '').trim() || '暂未开放注册，请联系管理员'; }

  handleLogin(s, d) {
    const op = this.op;
    if (s.player) return;
    if (this.serviceStatus.status !== 'available') {
      s.send(op.SERVICE_STATUS, this.serviceStatus);
      return;
    }
    const r = this.accounts.login(d.username, d.password);
    if (!r.ok) { s.send(op.LOGIN_FAILED, { success: false, message: r.message }); return; }
    const acc = r.account;
    // The shipped client sends no world id (every world shares one gateway), so fall
    // back to the world the account already plays in, then the default world.
    const owned = Object.keys(acc.characters || {}).find((w) => this.config.worlds.includes(w));
    let world = owned || this.config.defaultWorld;
    // Twelfth batch: the login screen sends the island (zone) picked; closed zones refuse.
    const zones = this.features.world;
    if (zones && typeof d.serverId === 'string' && d.serverId) {
      if (!zones.isZoneOpen(d.serverId)) { s.send(op.LOGIN_FAILED, { success: false, message: '该区暂未开放，请选择其他区。' }); return; }
      const w = zones.zoneWorld(d.serverId);
      if (this.config.worlds.includes(w)) world = w;
    }
    s.account = acc; s.world = world;
    const chId = acc.characters && acc.characters[world];
    const ch = chId ? this.store.data.characters[chId] : null;
    if (!ch) {
      s.send(op.LOGIN_SUCCESS, {
        success: true, requiresCharacterCreation: true, accountName: acc.email,
        suggestedCharacterName: acc.email.split('@')[0].replace(/[^A-Za-z0-9_]/g, '').slice(0, 12) || 'player',
        appearance: Object.assign({}, catalog.protocol.DEFAULT_PLAYER_APPEARANCE, { model: 'baby_1' }),
      });
      return;
    }
    this.enterWorld(s, ch);
  }

  handleCharacterCreate(s, d) {
    const op = this.op;
    if (!s.account || s.player) { s.send(op.CHARACTER_CREATE_RESULT, { success: false, message: '请先登录' }); return; }
    const world = s.world || this.config.defaultWorld;
    if (s.account.characters[world]) { s.send(op.CHARACTER_CREATE_RESULT, { success: false, message: '该区服已有角色' }); return; }
    const name = String(d.nickname || '').trim();
    if (!name || name.length > 12 || nameBytes(name) > 12 || !NAME_RE.test(name)) {
      s.send(op.CHARACTER_CREATE_RESULT, { success: false, message: '昵称仅支持中文、英文字母、数字及 _ . - ·，不超过12字节' });
      return;
    }
    const taken = Object.values(this.store.data.characters).some((c) => c.world === world && c.name.toLowerCase() === name.toLowerCase());
    if (taken) { s.send(op.CHARACTER_CREATE_RESULT, { success: false, message: '该昵称已被使用' }); return; }
    const map = this.maps.get(this.config.defaultMap);
    const spawn = map.spawnPoint();
    const id = 'p' + this.store.nextId('character');
    const appearance = C.normalizeAppearance(Object.assign({}, d.appearance, { model: 'baby_1' }), 'baby_1');
    const ch = C.newCharacter({ id, accountId: s.account.id, world, name, appearance, spawn, mapRef: map.id });
    const avatar = C.normalizeCustomAvatar(d.appearance && d.appearance.customAvatar);
    if (avatar) ch.customAvatar = avatar;
    if (this.config.startGold != null) ch.gold = this.config.startGold;
    // Starter kit.
    for (const [itemId, n] of [[70, 5], [71, 5]]) { const it = C.makeItem(ch, itemId, n); if (it) ch.inventory[ch.inventory.indexOf(null)] = it; }
    this.store.data.characters[id] = ch;
    s.account.characters[world] = id;
    this.store.markDirty();
    log.info('character created', id, name, world);
    s.send(op.CHARACTER_CREATE_RESULT, { success: true, message: '角色创建成功，正在进入游戏' });
    this.enterWorld(s, ch);
  }

  // ---------- worlds & scenes ----------
  isCrossWorldMap(mapId) {
    if (this.crossRe === undefined) this.crossRe = this.config.crossWorldMaps ? new RegExp(this.config.crossWorldMaps) : null;
    return !!(this.crossRe && this.crossRe.test(mapId));
  }

  // Maps that hold monsters (incl. ones added on the admin page): fox summons need one.
  isHuntingMap(mapRef) { return this.maps.huntingMaps().has(this.maps.normalize(mapRef)); }
  // Where the auto-hunt button shows: hunting maps, every 裕迦山 map and the arena rooms (target dummies).
  isAutoHuntMap(mapRef) {
    const id = this.maps.normalize(mapRef);
    return this.isHuntingMap(id) || /^teamfight_/.test(id) || id === ARENA_ROOM_MAP;
  }

  // instance: a separate copy of the map in the same world (the arena rooms pk_a1..6).
  getScene(world, mapRef, instance) {
    const map = this.maps.get(mapRef);
    if (!map) return null;
    if (this.isCrossWorldMap(map.id)) world = CROSS_WORLD;
    if (instance) world = world + '~' + instance;
    const key = world + '|' + map.id;
    let sc = this.scenes.get(key);
    if (!sc) { sc = new Scene(this, world, map); this.scenes.set(key, sc); log.info('scene up', key, sc.enemies.size, 'monsters'); }
    return sc;
  }

  sceneOccupancies(world) {
    const out = [];
    for (const sc of this.scenes.values()) if ((sc.world === world || sc.world === CROSS_WORLD) && sc.players.size) out.push({ mapRef: sc.mapRef, playerCount: sc.players.size });
    return out;
  }

  onOccupancyChanged(world) {
    this.occupancyDirty = this.occupancyDirty || new Set();
    if (world === CROSS_WORLD) for (const w of this.config.worlds) this.occupancyDirty.add(w);
    else this.occupancyDirty.add(world);
  }

  enterWorld(s, ch) {
    const op = this.op;
    const existing = this.playersById.get(ch.id);
    if (existing) {
      // Single session per character: the newest login wins.
      existing.send(op.CHAT_MESSAGE, this.systemChat('你的账号在其他地方登录。'));
      const old = existing.session;
      this.leaveWorld(existing, 'replaced');
      old.player = null; old.account = null;
      old.close(4001, 'replaced');
    }
    // Arena rooms are not kept over a logout: back to the arena hall.
    if (this.maps.normalize(ch.mapRef) === ARENA_ROOM_MAP) { ch.mapRef = 'abattoir'; ch.x = -1e6; ch.y = -1e6; }
    let scene = this.getScene(ch.world, ch.mapRef) || this.getScene(ch.world, this.config.defaultMap);
    let x = ch.x, y = ch.y;
    if (!scene.map.isWalkablePixel(x, y)) { const sp = scene.spawnPoint(); x = sp.x; y = sp.y; }
    // A model that does not fit the profession and gender (left by older job changes).
    if (ch.appearance) ch.appearance.model = C.modelForCharacter(ch);
    const p = new Player(s, ch, this);
    if (p.ch.hp <= 0) p.ch.hp = Math.round(p.stats.maxHp * 0.5);
    s.player = p;
    s.moveServerSeq = 0;
    this.playersById.set(ch.id, p);
    scene.addPlayer(p, x, y);
    p.loginAt = Date.now();
    s.send(op.LOGIN_SUCCESS, {
      success: true, requiresCharacterCreation: false,
      playerId: p.id, playerName: p.name, mapRef: scene.mapRef, x: p.x, y: p.y, z: 0,
      moveSpeed: p.moveSpeed, movementMode: ch.movementMode, appearance: Object.assign({}, ch.appearance),
      alignment: ch.alignment || 0, originalLollipopGlow: p.lollipopGlow ? { itemId: p.lollipopGlow } : undefined,
      players: Array.from(scene.players.values()).filter((q) => q !== p).map((q) => q.sync()),
      enemies: Array.from(scene.enemies.values()).map((m) => m.sync()),
      sceneOccupancies: this.sceneOccupancies(ch.world),
      serverTime: Date.now(),
    });
    s.send(op.GROUND_ITEM_STATE, scene.groundItemState());
    s.send(op.PLACEABLE_EFFECT_STATE, scene.placeableState());
    this.events.emit('playerEntered', p);
    log.info('enter world', ch.id, ch.name, ch.world, scene.mapRef, 'online=' + this.playersById.size);
  }

  leaveWorld(p, reason) {
    if (!this.playersById.has(p.id) || this.playersById.get(p.id) !== p) return;
    this.events.emit('playerLeaving', p, reason);
    if (p.scene) {
      p.ch.x = p.x; p.ch.y = p.y;
      if (p.state !== 'alive') { p.ch.hp = Math.max(1, Math.round(p.stats.maxHp * 0.3)); }
      p.scene.removePlayer(p);
    }
    p.ch.playSeconds = (p.ch.playSeconds || 0) + Math.round((Date.now() - (p.loginAt || Date.now())) / 1000);
    this.playersById.delete(p.id);
    p.session.player = null;
    this.store.markDirty();
    log.info('leave world', p.id, p.name, reason, 'online=' + this.playersById.size);
  }

  // Move a player to another map (same world unless `world` is given).
  transferPlayer(p, mapRef, opts = {}) {
    const op = this.op;
    const world = opts.world || p.ch.world;
    const target = this.getScene(world, mapRef, opts.instance);
    if (!target) return { success: false, message: '目标地图不存在' };
    const pt = opts.x != null && Number.isFinite(opts.x) ? (target.map.nearestWalkablePixel(opts.x, opts.y, 40) || target.gridPoint(opts.gx, opts.gy)) : target.gridPoint(opts.gx, opts.gy);
    const from = p.scene;
    if (from) from.removePlayer(p);
    for (const k of Object.keys(p.interactions)) delete p.interactions[k];
    this.events.emit('playerMapChanging', p, from, target);
    target.addPlayer(p, pt.x, pt.y);
    p.session.moveServerSeq = 0;
    const snap = target.fullSnapshot(p.session);
    p.send(op.MAP_SWITCH_RESULT, Object.assign(snap, {
      success: true, clientSeq: opts.clientSeq, mapRef: target.mapRef,
      groundItems: target.groundItemState().items, message: '',
    }));
    p.paramsDirty = true;
    if (target.world === CROSS_WORLD && (!from || from.world !== CROSS_WORLD)) {
      p.send(op.CHAT_MESSAGE, this.systemChat('你进入了跨服场景，这里会遇到其他区服的玩家。'));
    }
    return { success: true };
  }

  resolveMapRef(ref) {
    const id = this.maps.normalize(ref);
    if (this.maps.has(id)) return id;
    if (LEGACY_MAP_ALIASES[id] && this.maps.has(LEGACY_MAP_ALIASES[id])) return LEGACY_MAP_ALIASES[id];
    if (this.maps.has(id + '_in')) return id + '_in';
    return id;
  }

  findLink(fromMap, toRef) {
    const id = this.resolveMapRef(toRef);
    for (const c of fromMap.connections || []) for (const o of c.options || []) if (this.resolveMapRef(o.mapId) === id) return o;
    for (const b of Object.values(fromMap.behaviors || {})) if (b.teleport && this.maps.normalize(b.teleport.mapId) === id) return { mapId: b.teleport.mapId, targetGx: b.teleport.gx, targetGy: b.teleport.gy, minLevel: 0 };
    return this.findLegacyDecorLink(fromMap, id);
  }

  // Legacy decor links the qmap connections do not carry: teleport2 menus
  // ("title,map,label,cap,...") and "..,出口" exits back to the parent area.
  findLegacyDecorLink(fromMap, id) {
    const doc = fromMap.id ? this.maps.rawDoc(fromMap.id) : null;
    const from = this.maps.normalize(fromMap.id);
    for (const d of (doc && doc.decor) || []) {
      const parts = String(d.extra || '').replace(BAD_EXTRA_PREFIX, '').replace(/^"|"$/g, '').split(',').map((x) => x.trim());
      if (d.tag === 'teleport2') {
        for (let i = 1; i + 1 < parts.length; i += 3) {
          if (this.maps.normalize(parts[i]) === id) return { mapId: id, label: parts[i + 1], capacity: Number(parts[i + 2]) || 0, minLevel: 0 };
        }
      } else if (d.tag === 'trans' && parts[0] === '..' && LEGACY_PARENT_MAPS[id] && LEGACY_PARENT_MAPS[id].test(from)) {
        return { mapId: id, label: parts[1] || id, capacity: 0, minLevel: 0 };
      } else if (/^(trans|trans2|door|doorex|lockdoor|teamdoor)$/i.test(d.tag) && parts[0] && parts[0] !== '..' && this.resolveMapRef(parts[0]) === id) {
        return { mapId: id, label: parts[1] || id, capacity: Number(parts[2]) || 0, minLevel: 0 };
      }
    }
    return null;
  }

  handleMapSwitch(p, d) {
    const op = this.op;
    const ref = this.resolveMapRef(d.mapRef);
    const fail = (message) => p.send(op.MAP_SWITCH_RESULT, { success: false, clientSeq: d.clientSeq, mapRef: d.mapRef, message, dropMessage: message });
    const instance = ARENA_ROOMS.has(ref) ? ref : null;
    const mapRef = instance ? ARENA_ROOM_MAP : ref;
    if (!this.maps.has(mapRef)) return fail('目标地图不存在');
    if (p.state === 'dead') return fail('死亡状态无法切换地图');
    if (p.autoHunt) return fail('自动打怪中不能切换地图，请先关闭自动打怪。');
    const link = this.findLink(p.scene.map, ref);
    if (!link && !this.config.devMode) return fail('这里无法前往该地图');
    if (this.features.world && this.features.world.isMapClosed(mapRef)) return fail('该地图暂未开放');
    const lvl = p.stats.combatLevel;
    if (link && link.minLevel && lvl < link.minLevel) return fail('需要战斗等级 ' + link.minLevel + ' 级才能进入');
    if (link && link.maxLevel && lvl > link.maxLevel) return fail('战斗等级超过 ' + link.maxLevel + ' 级无法进入');
    if (link && link.capacity) {
      const sc = this.scenes.get((this.isCrossWorldMap(mapRef) ? CROSS_WORLD : p.ch.world) + (instance ? '~' + instance : '') + '|' + mapRef);
      if (sc && sc.players.size >= link.capacity) return fail('该场景人数已满');
    }
    const gx = Number.isFinite(d.targetGx) ? d.targetGx : (link ? link.targetGx : undefined);
    const gy = Number.isFinite(d.targetGy) ? d.targetGy : (link ? link.targetGy : undefined);
    // Old decor links carry no landing point: land by the door that leads back (the
    // 裕迦山 maps have walled-off parts, and their middle is not where the doors are).
    const back = Number.isFinite(gx) && Number.isFinite(gy) ? null : this.returnDoor(mapRef, p.scene.map.id);
    const r = this.transferPlayer(p, mapRef, back ? { x: back.x, y: back.y, clientSeq: d.clientSeq, instance } : { gx, gy, clientSeq: d.clientSeq, instance });
    if (r && !r.success) fail(r.message);
    return undefined;
  }

  // The walkable spot next to the decor in mapRef that links back to fromId, if any.
  returnDoor(mapRef, fromId) {
    const doc = this.maps.rawDoc(mapRef);
    const map = this.maps.get(mapRef);
    if (!doc || !map) return null;
    const from = this.maps.normalize(fromId);
    for (const dd of doc.decor || []) {
      const parts = String(dd.extra || '').replace(BAD_EXTRA_PREFIX, '').replace(/^"|"$/g, '').split(',').map((x) => x.trim());
      if (!parts[0] || parts[0] === '..' || !/door|trans/i.test(dd.tag || '')) continue;
      if (this.resolveMapRef(parts[0]) !== from) continue;
      const at = map.nearestOpenPixel(dd.x, -dd.y, 8);
      if (at) return at;
    }
    return null;
  }

  // ---------- actions ----------
  handleAction(p, a) {
    if (!a || typeof a !== 'object') return;
    const seq = Number(a.seq);
    if (Number.isFinite(seq) && seq > p.lastSeq) p.lastSeq = Math.trunc(seq);
    if (a.type === 'move') {
      if (p.state === 'dead') { p.markDirty(); return; }
      if (!p.scene.queueMove(p, Number(a.x), Number(a.y))) {
        // Reject: stop the player where the server has them.
        log.debug('move rejected', p.name, p.scene.mapRef, Math.round(a.x), Math.round(a.y), 'server at', Math.round(p.x), Math.round(p.y));
        p.scene.placePlayer(p, p.x, p.y);
      }
      return;
    }
    if (a.type === 'attack') { p.scene.combat.handlePlayerAttack(p, a); return; }
    if (a.type === 'stop') { p.path = []; p.markDirty(); }
  }

  // ---------- loop ----------
  start() {
    this.store.load();
    for (const f of Object.values(this.features)) if (f.onStart) f.onStart();
    this.lastTick = Date.now();
    this.tickTimer = setInterval(() => this.tick(), this.config.tickMs);
    this.saveTimer = setInterval(() => this.save(), this.config.saveIntervalMs);
    log.info('game server started', 'maps=' + this.maps.ids().length);
  }

  tick() {
    const now = Date.now();
    const dt = Math.min(250, now - this.lastTick);
    this.lastTick = now;
    for (const sc of this.scenes.values()) {
      if (!sc.players.size && !sc.respawnQueue.length && !sc.groundItems.size) continue;
      try { sc.tick(now, dt); } catch (e) { log.error('scene tick', sc.key(), e && e.stack || e); }
    }
    for (const p of this.playersById.values()) if (p.paramsDirty) p.flushParams();
    if (this.occupancyDirty) {
      for (const world of this.occupancyDirty) {
        const occ = this.sceneOccupancies(world);
        for (const p of this.playersById.values()) {
          if (p.ch.world !== world || !p.scene) continue;
          p.send(this.op.MOVE_UPDATE, { serverSeq: this.nextSeq(), moveServerSeq: ++p.session.moveServerSeq, timestamp: now, players: [], enemies: [], sceneOccupancies: occ, full: false });
        }
      }
      this.occupancyDirty = null;
    }
    this.events.emit('tick', now, dt);
    // Online detection: drop connections that stopped talking to us.
    if (!this.lastSweep || now - this.lastSweep > 2000) {
      this.lastSweep = now;
      for (const s of this.sessions) {
        const idle = now - s.lastSeenAt;
        if (idle > this.config.heartbeatTimeoutMs) { log.info('session timeout', s.id, idle); s.close(4000, 'timeout'); this.detach(s); }
      }
    }
  }

  save() {
    try { this.store.save(); } catch (e) { log.error('save failed', e); }
  }

  // Planned restart: clients show "服务器正在更新", keep credentials in memory and log
  // back in automatically once the new process answers SERVICE_STATUS available.
  // Pass { update: false } for a final shutdown (clients see 服务器已关闭).
  // Restart from the admin page (V10.4): announce, count down, then onRestart (set by
  // index.js: save, tell clients to wait and reconnect, exit with code 75 so start.bat or
  // Docker starts the server again). 0 seconds = at once.
  scheduleRestart(seconds) {
    const sec = Math.max(0, Math.min(3600, Math.round(Number(seconds) || 0)));
    if (this.restart) throw new Error('已经在倒计时重启了（还剩 ' + this.restartLeft() + ' 秒）');
    const tell = (text) => { const msg = this.systemChat('【公告】' + text); for (const p of this.playersById.values()) p.send(this.op.CHAT_MESSAGE, msg); };
    const fire = () => {
      this.restart = null;
      log.info('restarting (admin page)');
      if (this.onRestart) this.onRestart(); else { this.stop({ update: true }); setTimeout(() => process.exit(75), 300); }
    };
    if (!sec) { tell('服务器马上重启，完成后会自动重新连接。'); setTimeout(fire, 500); this.restart = { at: Date.now() + 500, timers: [] }; return 0; }
    const at = Date.now() + sec * 1000;
    const timers = [setTimeout(fire, sec * 1000)];
    tell('服务器将在 ' + sec + ' 秒后重启，重启完成后会自动重新连接。');
    for (const left of [10]) if (sec > left + 5) timers.push(setTimeout(() => tell('服务器将在 ' + left + ' 秒后重启。'), (sec - left) * 1000));
    this.restart = { at, timers };
    log.info('restart in', sec, 's (admin page)');
    return sec;
  }

  restartLeft() { return this.restart ? Math.max(0, Math.ceil((this.restart.at - Date.now()) / 1000)) : null; }

  cancelRestart() {
    if (!this.restart) return false;
    for (const t of this.restart.timers) clearTimeout(t);
    this.restart = null;
    const msg = this.systemChat('【公告】服务器重启已取消。');
    for (const p of this.playersById.values()) p.send(this.op.CHAT_MESSAGE, msg);
    log.info('restart cancelled (admin page)');
    return true;
  }

  stop({ update = true, message } = {}) {
    clearInterval(this.tickTimer); clearInterval(this.saveTimer);
    const status = update
      ? { status: 'maintenance', automaticReconnect: true, title: '服务器正在更新', message: message || '请稍候，更新完成后将自动重新连接。' }
      : { status: 'closed', automaticReconnect: false, title: '服务器已关闭', message: message || '服务器已经关闭，请稍后再试。' };
    this.serviceStatus = Object.assign({}, this.serviceStatus, status);
    for (const s of this.sessions) s.send(this.op.SERVICE_STATUS, Object.assign({ serverTime: Date.now() }, this.serviceStatus));
    for (const p of Array.from(this.playersById.values())) this.leaveWorld(p, 'shutdown');
    this.store.save(true);
    for (const s of Array.from(this.sessions)) s.close(update ? 1012 : 1001, update ? 'server_update' : 'server_closed');
  }
}

module.exports = { ARENA_ROOMS, ARENA_ROOM_MAP, GameServer };
