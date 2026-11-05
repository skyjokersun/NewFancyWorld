'use strict';
// Server-authoritative monster AI.
//
// Movement is always along walkable paths produced by GameMap.findPath (the same
// supercover test the client's navigation patch uses), and every path change is
// broadcast once with the current position, the remaining waypoints and a server
// timestamp. The client extrapolates along that path, so a monster never needs to
// be snapped: what the client draws is what the server simulates.

let nextEnemyNo = 1;

const ATTACK_INTERVAL_MS = 1600;
const FIGHT_ACTION_MS = 800;
const REPATH_MS = 450;
const CORPSE_MS = 2500;

function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

function directionIndex(dx, dy) {
  // 8 directions, 0 = +x, counter-clockwise in world space (matches client calculateDirection).
  let deg = Math.atan2(dy, dx) * 180 / Math.PI;
  if (deg < 0) deg += 360;
  return Math.round(deg / 45) % 8;
}

class Monster {
  constructor(scene, spawn, def, home) {
    this.scene = scene;
    this.def = def;
    this.spawn = spawn;
    this.id = 'e' + scene.uid + '_' + (nextEnemyNo++);
    this.model = String(def.model || 'foxman').toLowerCase();
    this.role = 'enemy/' + this.model;
    this.level = def.level || 1;
    const cfg = scene.server.config;
    this.maxHp = Math.max(1, Math.round((def.maxHp || def.hp || 100) * (cfg.monsterHpRate || 1)));
    this.hp = this.maxHp;
    this.damage = Math.max(cfg.monsterDamageRate === 0 ? 0 : 1, Math.round((def.damage || 5) * (cfg.monsterDamageRate != null ? cfg.monsterDamageRate : 1)));
    this.defense = def.defense || 0;
    this.breakPower = def.breakPower || 0;
    // Element resists in percent (twelfth batch, admin 怪物 page).
    this.resists = { fire: def.fireResist || 0, ice: def.iceResist || 0, thunder: def.thunderResist || 0, poison: def.poisonResist || 0 };
    // Thirteenth batch: flat element attack (original ani.tab), cut by the player's resists.
    this.elements = { fire: def.fireAttack || 0, ice: def.iceAttack || 0, thunder: def.thunderAttack || 0, poison: def.poisonAttack || 0 };
    this.attackRange = Math.max(40, def.attackRange || 60);
    this.detectionRange = Math.max(80, def.detectionRange || 300);
    this.baseSpeed = Math.max(30, def.moveSpeed || 100);
    this.speed = this.baseSpeed;
    // Projectile: set on the admin page ('none' = hits up close whatever the reach), else
    // from the original attack kind; a monster reaching 160 px or more throws something.
    const OM = require('./original-monsters');
    const proj = String(def.projectile || '');
    this.ranged = proj === 'none' ? false : proj ? true : this.attackRange >= 160;
    this.projectileKey = proj && proj !== 'none' ? proj : (OM.PROJECTILE_BY_KIND[def.attackType2] || 'mage_firebolt');
    this.projectileSpeed = def.projectileSpeed || (proj ? 0 : OM.speedOfKind(def.attackType2)) || 650;
    this.projectileSpeed = Math.max(100, Math.min(5000, this.projectileSpeed));
    // An admin-made skill this monster sometimes uses instead of its plain attack.
    this.skillId = def.skill || null;
    this.skillChance = Number.isFinite(def.skillChance) ? def.skillChance : 25;
    this.homeX = home.x; this.homeY = home.y;
    this.x = home.x; this.y = home.y;
    this.path = [];
    this.direction = Math.floor(Math.random() * 8);
    this.state = 'idle';      // idle | wander | chase | attack | return | dead
    this.action = 'stand';
    this.actionUntil = 0;
    this.targetId = null;
    this.lastRepathAt = 0;
    this.nextWanderAt = Date.now() + 2000 + Math.random() * 6000;
    this.nextAttackAt = 0;
    this.attackSequence = 0;
    this.attackAimX = 0; this.attackAimY = 0;
    this.attackStartedAt = 0; this.attackDamageAt = 0;
    this.pendingHit = null;
    this.seq = 1;
    this.dirty = true;
    this.lastBroadcastAt = 0;
    this.deadAt = 0;
    this.threat = new Map();  // playerId -> damage dealt (exp share)
    this.summonedBy = null;
  }

  get alive() { return this.state !== 'dead'; }

  markDirty() { this.dirty = true; this.seq += 1; }

  originalCombat() {
    const c = { mode: this.ranged ? 'ranged' : 'melee', attackActionKey: 'fight', fightFrameDelayMs: 80 };
    // Ranged monsters throw their projectile (thirteenth batch: by original attack kind or
    // the admin's choice; before, all of them threw the mage's small fireball).
    if (this.ranged || this.castKey) { c.mode = 'ranged'; c.projectileKey = this.castKey || this.projectileKey; c.projectileSpeed = this.castSpeed || this.projectileSpeed; c.projectileRange = this.attackRange; }
    return c;
  }

  sync() {
    const now = Date.now();
    const s = {
      enemyId: this.id,
      role: this.role,
      name: this.def.name,
      palette: Number.isFinite(this.def.palette) ? this.def.palette : undefined,
      sPalette: this.def.sPalette || '',
      level: this.level,
      moving: this.path.length > 0 && this.alive,
      action: this.state === 'dead' ? 'dead' : (this.actionUntil > now ? 'fight' : (this.path.length ? 'walk' : 'stand')),
      x: r2(this.x), y: r2(this.y), z: 0,
      actionUntil: this.actionUntil > now ? this.actionUntil : 0,
      seq: this.seq,
      timestamp: now,
      direction: this.direction,
      moveSpeed: this.speed,
      hp: Math.max(0, Math.round(this.hp)),
      maxHp: this.maxHp,
      combatExp: this.def.baseExp || 0,
      professionExp: Math.ceil((this.def.baseExp || 0) / 2),
      attackSequence: this.attackSequence,
      attackTargetId: this.targetId || undefined,
      attackAimX: r2(this.attackAimX), attackAimY: r2(this.attackAimY),
      attackStartedAt: this.attackStartedAt, attackDamageAt: this.attackDamageAt,
      path: this.alive ? this.path.map((p) => [r2(p.x), r2(p.y)]) : [],
      originalCombat: this.originalCombat(),
    };
    return s;
  }

  setPath(points, speed = this.baseSpeed) {
    this.path = points || [];
    this.speed = speed;
    if (this.path.length) this.direction = directionIndex(this.path[0].x - this.x, this.path[0].y - this.y);
    this.markDirty();
  }

  stop() {
    if (!this.path.length) return;
    this.path = [];
    this.markDirty();
  }

  moveToward(tx, ty, speed) {
    const map = this.scene.map;
    const pts = map.findPath(this.x, this.y, tx, ty, 2500);
    if (!pts || !pts.length) return false;
    this.setPath(pts, speed);
    return true;
  }

  advance(dtMs) {
    if (!this.path.length) return;
    let budget = this.speed * dtMs / 1000;
    while (budget > 0 && this.path.length) {
      const p = this.path[0];
      const d = dist(this.x, this.y, p.x, p.y);
      if (d <= budget) {
        this.x = p.x; this.y = p.y; budget -= d; this.path.shift();
        if (this.path.length) this.direction = directionIndex(this.path[0].x - this.x, this.path[0].y - this.y);
        else this.markDirty();
      } else {
        this.x += (p.x - this.x) / d * budget; this.y += (p.y - this.y) / d * budget; budget = 0;
      }
    }
  }

  // Closest living, attackable player within range of a point.
  findTarget() {
    let best = null; let bd = Infinity;
    for (const p of this.scene.players.values()) {
      if (!p.alive || p.stats.mount === 'carpet') continue;
      const d = dist(this.x, this.y, p.x, p.y);
      if (d < this.detectionRange && d < bd) { bd = d; best = p; }
    }
    return best;
  }

  aggro(player) {
    if (!this.alive || !player || !player.alive) return;
    if (this.state === 'idle' || this.state === 'wander' || this.state === 'return') {
      this.targetId = player.id; this.state = 'chase'; this.lastRepathAt = 0;
    }
  }

  tick(now, dtMs) {
    if (this.state === 'dead') return;
    if (this.pendingHit && now >= this.pendingHit.at) {
      const h = this.pendingHit; this.pendingHit = null;
      this.scene.combat.monsterHit(this, h.targetId, h);
    }
    let target = this.targetId ? this.scene.players.get(this.targetId) : null;
    if (target && (!target.alive || target.stats.mount === 'carpet')) { target = null; this.targetId = null; }
    const leash = this.detectionRange * 2.5 + 300;

    switch (this.state) {
      case 'idle':
      case 'wander': {
        const t = this.findTarget();
        if (t) { this.targetId = t.id; this.state = 'chase'; this.lastRepathAt = 0; break; }
        if (!this.path.length && now >= this.nextWanderAt) {
          this.nextWanderAt = now + 4000 + Math.random() * 8000;
          const a = Math.random() * Math.PI * 2; const r = 60 + Math.random() * 180;
          const tx = this.homeX + Math.cos(a) * r; const ty = this.homeY + Math.sin(a) * r * 0.6;
          const map = this.scene.map;
          if (map.isWalkablePixel(tx, ty) && map.componentAt(tx, ty) === map.componentAt(this.x, this.y)) {
            if (this.moveToward(tx, ty, Math.round(this.baseSpeed * 0.5))) this.state = 'wander';
          }
        }
        if (this.state === 'wander' && !this.path.length) this.state = 'idle';
        break;
      }
      case 'chase': {
        if (!target || dist(target.x, target.y, this.homeX, this.homeY) > leash) { this.beginReturn(); break; }
        const d = dist(this.x, this.y, target.x, target.y);
        if (d <= this.attackRange && this.scene.map.segmentWalkable(this.x, this.y, target.x, target.y)) {
          this.stop();
          this.state = 'attack';
          break;
        }
        if (now - this.lastRepathAt >= REPATH_MS) {
          this.lastRepathAt = now;
          const goal = this.path.length ? this.path[this.path.length - 1] : null;
          if (!goal || dist(goal.x, goal.y, target.x, target.y) > Math.max(24, this.attackRange * 0.5)) {
            // Approach to a point at ~70% of attack range on the line to the target.
            const k = Math.max(0, d - this.attackRange * 0.7) / Math.max(1, d);
            let tx = this.x + (target.x - this.x) * k; let ty = this.y + (target.y - this.y) * k;
            if (!this.scene.map.isWalkablePixel(tx, ty)) { tx = target.x; ty = target.y; }
            if (!this.moveToward(tx, ty, this.baseSpeed)) { this.beginReturn(); }
          }
        }
        break;
      }
      case 'attack': {
        if (!target) { this.beginReturn(); break; }
        const d = dist(this.x, this.y, target.x, target.y);
        if (d > this.attackRange * 1.15) { this.state = 'chase'; this.lastRepathAt = 0; break; }
        if (now >= this.nextAttackAt) this.startAttack(target, now);
        break;
      }
      case 'return': {
        const t = this.findTarget();
        if (t && dist(t.x, t.y, this.homeX, this.homeY) < this.detectionRange) { this.targetId = t.id; this.state = 'chase'; break; }
        if (!this.path.length) {
          this.state = 'idle';
          if (this.hp < this.maxHp) { this.hp = this.maxHp; this.markDirty(); }
          this.threat.clear();
        }
        break;
      }
      default: break;
    }
    if (this.actionUntil <= now) this.advance(dtMs);
  }

  beginReturn() {
    this.targetId = null;
    this.state = 'return';
    if (!this.moveToward(this.homeX, this.homeY, this.baseSpeed)) { this.stop(); this.state = 'idle'; }
  }

  startAttack(target, now) {
    this.nextAttackAt = now + ATTACK_INTERVAL_MS;
    this.direction = directionIndex(target.x - this.x, target.y - this.y);
    this.attackSequence += 1;
    this.attackAimX = target.x; this.attackAimY = target.y;
    this.attackStartedAt = now;
    // Thirteenth batch: now and then an admin-made skill instead of the plain attack.
    const sk = this.skillId && Math.random() * 100 < this.skillChance && this.scene.server.features.customSkills
      ? this.scene.server.features.customSkills.monsterCast(this) : null;
    this.castKey = sk && sk.projectileKey ? sk.projectileKey : null;
    this.castSpeed = sk && sk.projectileSpeed ? sk.projectileSpeed : null;
    const speed = this.castSpeed || this.projectileSpeed;
    const travel = this.ranged || this.castKey ? Math.max(60, dist(this.x, this.y, target.x, target.y) / speed * 1000) : 0;
    this.attackDamageAt = now + 380 + travel;
    this.actionUntil = now + FIGHT_ACTION_MS;
    this.pendingHit = Object.assign({ at: this.attackDamageAt, targetId: target.id }, sk ? sk.hit : {});
    this.markDirty();
  }

  die(now) {
    this.state = 'dead';
    this.hp = 0;
    this.path = [];
    this.pendingHit = null;
    this.actionUntil = 0;
    this.deadAt = now;
    this.markDirty();
  }
}

function r2(v) { return Math.round(v * 100) / 100; }

module.exports = { Monster, CORPSE_MS, directionIndex };
