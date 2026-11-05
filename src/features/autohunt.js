'use strict';
// Auto hunt (eighth batch, reworked in the eleventh). The client (patch 100) does the
// hunting itself: it walks to monsters anywhere on the map, attacks or casts the chosen
// skill, and picks up what the settings say. The server keeps the settings per
// character, tells the client where the button may show, and enforces the rules:
// - never on after a login, a reconnect or a restart (p.autoHunt lives on the Player);
// - getting on: off the 飞毯 first; the 飞毯 while hunting stops it (features/mounts.js);
// - no map changes while on (game/server.js), and a transfer by the server turns it off;
// - no gear changes, manual item use or other skills while on (items.js, skills.js);
// - a full or overweight bag no longer stops it;
// - auto potions: HP first, then MP (精力), one item per autoPotionIntervalSec, only
//   while it is on and the character is alive.
// Twelfth batch: pick-up defaults to everything; a client that has made no progress for
// autoHuntTeleportSec asks for autohunt_unstuck and is moved next to a live monster on the
// same map (hunting stays on); the two stuck times are admin settings sent in the state.
const cat = require('../game/catalog');
const C = require('../game/character');
const { SKILLS } = require('../game/skills-data');

const PICK_MODES = ['none', 'goldcard', 'all'];

function restoreOf(itemId) {
  const t = cat.getTemplate(itemId);
  const sum = (key) => ((t && t.bonusAttrs) || []).filter((a) => a.key === key).reduce((s, a) => s + (Number(a.value) || 0), 0);
  return { hp: sum('restoreHp'), mp: sum('restoreStamina') };
}

// A timed self buff (狂怒, 罡气): cast by the auto-buff list, not as the attack skill.
function isBuff(def) { return !!(def && def.kind === 'buff'); }

function pct(v, def) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : def;
}

class AutoHunt {
  register(server) {
    this.server = server;
    server.ext.on('autohunt', (p, d) => this.toggle(p, !!d.on));
    server.ext.on('autohunt_query', (p) => this.sendState(p, '', true));
    server.ext.on('autohunt_cfg', (p, d) => this.saveCfg(p, d.cfg || {}));
    server.ext.on('autohunt_unstuck', (p) => this.unstuck(p));
    server.events.on('playerMapChanging', (p) => {
      // Players cannot change maps while hunting, so this is the server moving them.
      if (p.autoHunt) { p.autoHunt = false; p.autoHuntOffReason = '你被传送到其他地图，自动打怪已停止。'; }
      setTimeout(() => {
        if (server.playersById.get(p.id) !== p) return;
        const why = p.autoHuntOffReason || '';
        p.autoHuntOffReason = null;
        if (why) server.ext.tell(p, why);
        this.sendState(p, why);
      }, 50);
    });
    server.events.on('playerEntered', (p) => this.sendState(p));
    this.lastSweep = 0;
    server.events.on('tick', (now) => { if (now - this.lastSweep >= 250) { this.lastSweep = now; this.sweep(now); } });
  }

  allowed(p) { return !!(p.scene && this.server.isAutoHuntMap(p.scene.map.id)); }

  // The character's settings, filled with defaults.
  cfg(p) {
    const c = this.server.config;
    const cur = p.ch.autoHuntCfg && typeof p.ch.autoHuntCfg === 'object' ? p.ch.autoHuntCfg : {};
    const out = {
      skill: typeof cur.skill === 'string' && !isBuff(SKILLS[cur.skill]) ? cur.skill : '',
      pick: PICK_MODES.includes(cur.pick) ? cur.pick : 'all',
      potOn: cur.potOn === undefined ? true : !!cur.potOn,
      hpOn: !!cur.hpOn, hpPct: pct(cur.hpPct, pct(c.autoPotionHpPercent, 50)), hpItem: Number(cur.hpItem) || 0,
      mpOn: !!cur.mpOn, mpPct: pct(cur.mpPct, pct(c.autoPotionMpPercent, 30)), mpItem: Number(cur.mpItem) || 0,
      // Fifteenth batch: self buffs re-cast as soon as they run out (and are off cooldown),
      // skipped while 精力 is under buffMpPct (0 = never skip); 治愈术 on oneself below healPct.
      buffs: Array.isArray(cur.buffs) ? cur.buffs.filter((id) => typeof id === 'string' && isBuff(SKILLS[id])).slice(0, 8) : [],
      buffMpPct: Number.isFinite(Number(cur.buffMpPct)) ? Math.min(100, Math.max(0, Math.round(Number(cur.buffMpPct)))) : 0,
      healOn: !!cur.healOn, healPct: pct(cur.healPct, 50),
    };
    p.ch.autoHuntCfg = out;
    return out;
  }

  // Stuck for autoHuntTeleportSec: next to a live monster of this map, on open ground.
  unstuck(p) {
    if (!p.autoHunt || !p.alive || !p.scene || !this.allowed(p)) return;
    const now = Date.now();
    const gap = Math.max(5, Number(this.server.config.autoHuntTeleportSec) || 30) * 1000;
    if (now - (p.lastUnstuckAt || 0) < gap) return;
    const sc = p.scene;
    const live = [...sc.enemies.values()].filter((m) => m.alive);
    if (!live.length) return;
    // Prefer one that is not right where the player already is.
    live.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
    const far = live.filter((m) => Math.hypot(m.x - p.x, m.y - p.y) > 200);
    const pool = far.length ? far : live;
    const m = pool[Math.floor(Math.random() * Math.min(5, pool.length))];
    const at = sc.nearbyWalkable(m, 120) || sc.map.nearestOpenPixel(m.x, m.y, 8) || null;
    if (!at) return;
    p.lastUnstuckAt = now;
    sc.placePlayer(p, at.x, at.y);
    p.paramsDirty = true;
    this.server.ext.send(p, 'autohunt_warp', { x: at.x, y: at.y });
    this.server.ext.tell(p, '自动打怪：卡住太久，已把你移到怪物附近，继续自动打怪。');
  }

  saveCfg(p, d) {
    const cur = this.cfg(p);
    if (typeof d.skill === 'string' && d.skill.length <= 64 && !isBuff(SKILLS[d.skill])) cur.skill = d.skill;
    if (PICK_MODES.includes(d.pick)) cur.pick = d.pick;
    if (d.potOn !== undefined) cur.potOn = !!d.potOn;
    for (const k of ['hp', 'mp']) {
      if (d[k + 'On'] !== undefined) cur[k + 'On'] = !!d[k + 'On'];
      if (d[k + 'Pct'] !== undefined) cur[k + 'Pct'] = pct(d[k + 'Pct'], cur[k + 'Pct']);
      if (d[k + 'Item'] !== undefined) {
        const id = Math.trunc(Number(d[k + 'Item'])) || 0;
        // Only a potion of that kind the bag holds right now can be chosen.
        if (!id || (restoreOf(id)[k] > 0 && p.inventory.some((it) => it && it.itemId === id))) cur[k + 'Item'] = id;
      }
    }
    if (Array.isArray(d.buffs)) cur.buffs = d.buffs.filter((id) => typeof id === 'string' && isBuff(SKILLS[id]) && p.ch.professionSkills[id]).slice(0, 8);
    if (d.buffMpPct !== undefined) { const n = Math.round(Number(d.buffMpPct)); if (n >= 0 && n <= 100) cur.buffMpPct = n; }
    if (d.healOn !== undefined) cur.healOn = !!d.healOn;
    if (d.healPct !== undefined) cur.healPct = pct(d.healPct, cur.healPct);
    p.potionOutNotice = {};
    this.server.store.markDirty();
    this.sendState(p, '', true);
  }

  // Potions in the bag, one row per item id.
  potions(p) {
    const rows = { hp: new Map(), mp: new Map() };
    for (const it of p.inventory) {
      if (!it) continue;
      const r = restoreOf(it.itemId);
      for (const k of ['hp', 'mp']) {
        if (!(r[k] > 0)) continue;
        const row = rows[k].get(it.itemId) || { itemId: it.itemId, name: it.name, count: 0, restore: r[k] };
        row.count += it.count || 1;
        rows[k].set(it.itemId, row);
      }
    }
    return { hp: [...rows.hp.values()], mp: [...rows.mp.values()] };
  }

  // Skills the auto hunt may cast: the chosen attack skill, the ticked buffs and, when on,
  // 治愈术 on oneself.
  mayCast(p, id) {
    const c = this.cfg(p);
    if (c.skill === id) return true;
    if (c.buffs.includes(id)) return true;
    return c.healOn && SKILLS[id] && SKILLS[id].kind === 'heal';
  }

  // Learned self buffs, and whether a heal is known.
  buffSkills(p) {
    return Object.keys(p.ch.professionSkills || {}).filter((id) => isBuff(SKILLS[id]) && SKILLS[id].profession === p.ch.profession)
      .map((id) => ({ id, name: SKILLS[id].name }));
  }
  healSkill(p) {
    return Object.keys(p.ch.professionSkills || {}).find((id) => SKILLS[id] && SKILLS[id].kind === 'heal' && SKILLS[id].profession === p.ch.profession) || '';
  }

  // Learned attack skills, and whether the weapon in hand allows each one.
  skills(p) {
    const out = [];
    for (const id of Object.keys(p.ch.professionSkills || {})) {
      const def = SKILLS[id];
      if (!def || (def.allowed ? !def.allowed(p.ch) : def.profession !== p.ch.profession) || def.targetMode === 'ally' || def.kind === 'heal' || isBuff(def)) continue;
      const ok = !(def.needsBlade && C.warriorHoldsBow(p.ch));
      out.push({ id, name: def.name, ok, why: ok ? '' : '要拿刀剑（或空手）' });
    }
    return out;
  }

  sendState(p, reason, withPotions) {
    const c = this.server.config;
    const d = { on: !!p.autoHunt, allowed: this.allowed(p), reason: reason || '', cfg: this.cfg(p),
      stuckSec: Math.max(3, Number(c.autoHuntStuckSec) || 10), teleportSec: Math.max(5, Number(c.autoHuntTeleportSec) || 30) };
    if (withPotions) { d.potions = this.potions(p); d.skills = this.skills(p); d.buffSkills = this.buffSkills(p); d.healSkill = this.healSkill(p); }
    this.server.ext.send(p, 'autohunt', d);
  }

  toggle(p, on) {
    if (on && !this.allowed(p)) { p.autoHunt = false; return this.sendState(p, '这里没有怪物，不能自动打怪。'); }
    // Riders of the 飞毯 cannot attack: off it comes first (the 筋斗云 stays).
    if (on && p.stats.mount === 'carpet' && this.server.features.mounts) {
      this.server.features.mounts.ride(p, 'off');
      if (p.stats.mount === 'carpet') return this.sendState(p, '没能下飞毯，自动打怪没有开始。');
      this.server.ext.tell(p, '自动打怪：已自动下飞毯。');
    }
    p.autoHunt = on;
    p.potionOutNotice = {};
    this.sendState(p);
  }

  stop(p, why) {
    p.autoHunt = false;
    if (why) this.server.ext.tell(p, why);
    this.sendState(p, why);
  }

  sweep(now) {
    const items = this.server.features.items;
    const gap = Math.max(1, Number(this.server.config.autoPotionIntervalSec) || 1) * 1000;
    for (const p of this.server.playersById.values()) {
      if (!p.autoHunt || !p.alive || !items) continue;
      if (now - (p.lastAutoPotionAt || 0) < gap) continue;
      const c = this.cfg(p);
      if (!c.potOn) continue;
      const want = [];
      if (c.hpOn && p.ch.hp * 100 < p.stats.maxHp * c.hpPct) want.push(['hp', c.hpItem]);
      if (c.mpOn && p.ch.stamina * 100 < p.stats.maxStamina * c.mpPct) want.push(['mp', c.mpItem]);
      for (const [kind, itemId] of want) {
        const at = itemId ? p.inventory.findIndex((it) => it && it.itemId === itemId) : -1;
        p.potionOutNotice = p.potionOutNotice || {};
        if (at < 0) {
          if (!p.potionOutNotice[kind]) {
            p.potionOutNotice[kind] = true;
            this.server.ext.tell(p, '自动吃药：背包里没有选定的' + (kind === 'hp' ? '回血' : '回精力') + '药了，继续自动打怪。');
          }
          continue;
        }
        p.potionOutNotice[kind] = false;
        p.autoPotionUse = true;
        try { items.use(p, { fromIndex: at }); } finally { p.autoPotionUse = false; }
        p.lastAutoPotionAt = now;
        break;   // one item at a time; the next round looks again
      }
    }
  }
}

module.exports = { AutoHunt };
