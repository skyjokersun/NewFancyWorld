'use strict';
// Combat resolution: player attacks, monster attacks, death / ghost / revive,
// experience settlement and loot.
const C = require('./character');
const A = require('./affixes');
const { getTemplate, BLOCKED_ITEMS } = require('./catalog');
const { directionIndex } = require('./monster');

const DEF_K = 300;
const DEAD_TO_GHOST_MS = 2500;
const GHOST_AUTO_REVIVE_MS = 45000;
const VISUAL_PHASES = new Set(['release_start', 'charge_start', 'charge_update', 'cast_start', 'cancel']);

function rand(a, b) { return a + Math.random() * (b - a); }
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

const ELEMENTS = ['fire', 'ice', 'thunder', 'poison'];
function mitigate(raw, defense, breakPower) {
  const eff = Math.max(0, (defense || 0) - (breakPower || 0));
  return Math.max(1, Math.round(raw * DEF_K / (DEF_K + eff)));
}

class SceneCombat {
  constructor(combat, scene) {
    this.combat = combat;
    this.server = combat.server;
    this.scene = scene;
    this.impacts = [];   // {at, fn}
    this.projectileNo = 1;
  }

  schedule(delayMs, fn) {
    if (delayMs <= 5) { fn(); return; }
    this.impacts.push({ at: Date.now() + delayMs, fn });
  }

  tick(now) {
    if (this.impacts.length) {
      const due = []; const keep = [];
      for (const i of this.impacts) (i.at <= now ? due : keep).push(i);
      this.impacts = keep;
      for (const i of due) { try { i.fn(); } catch (e) { this.server.log.error('impact failed', e); } }
    }
    for (const p of this.scene.players.values()) this.tickPlayer(p, now);
  }

  tickPlayer(p, now) {
    if (p.state === 'dead' && now - p.diedAt >= DEAD_TO_GHOST_MS) {
      p.state = 'ghost'; p.ghostAt = now; p.tomb = { x: Math.round(p.x), y: Math.round(p.y) };
      p.markDirty();
      p.send(this.server.op.CHAT_MESSAGE, this.server.systemChat('你已化为鬼魂。回到墓碑旁或走到复活点即可复活。'));
    } else if (p.state === 'ghost') {
      this.checkGhostRevive(p);
    } else if (p.state === 'alive') {
      // Out-of-combat regeneration every second.
      p.regenAcc += 1;
      if (p.regenAcc >= 20) {
        p.regenAcc = 0;
        // Life comes back only after 6 s without being hit: 0.5% of the maximum a second,
        // plus 0.01 percentage points per 快速愈合 point, then x1.3 天使祝福 and x1.05 筋斗云.
        const idle = now - p.lastHitAt > 6000;
        const hpRate = 0.005 + (p.ch.combatSkills.quick_heal || 0) * 0.0001;
        const hpGain = idle ? Math.max(1, Math.round(p.stats.maxHp * hpRate * (p.stats.hpRegenFactor || 1))) : 0;
        const stGain = Math.max(1, Math.round(p.stats.maxStamina * (idle ? 0.03 : 0.01) * (p.stats.staminaRegenFactor || 1)));
        const before = [p.ch.hp, p.ch.stamina];
        p.ch.hp = Math.min(p.stats.maxHp, p.ch.hp + hpGain);
        p.ch.stamina = Math.min(p.stats.maxStamina, p.ch.stamina + stGain);
        if (before[0] !== p.ch.hp || before[1] !== p.ch.stamina) p.markDirty();
      }
    }
  }

  checkGhostRevive(p) {
    if (p.state !== 'ghost') return;
    const now = Date.now();
    // V15.2 (Q7): on the map of a living 大地龙 nobody revives there: back to town.
    const b15 = this.server.features.batch15;
    if (b15 && now - p.ghostAt > 3000 && b15.sendHome(p, this)) return;
    if (now - p.ghostAt < 1500) return;
    let ok = now - p.ghostAt > GHOST_AUTO_REVIVE_MS;
    if (!ok && p.tomb && dist(p.x, p.y, p.tomb.x, p.tomb.y) < 56 && now - p.ghostAt > 4000) ok = true;
    if (!ok) {
      for (const d of this.scene.map.decor) {
        if ((d.tag === 'resurge' || d.tag === 'resurge_d') && dist(p.x, p.y, d.x, d.y) < 140) { ok = true; break; }
      }
    }
    if (ok) this.revive(p);
  }

  revive(p, full = false) {
    p.state = 'alive';
    p.tomb = null;
    p.ch.hp = full ? p.stats.maxHp : Math.max(1, Math.round(p.stats.maxHp * 0.5));
    p.ch.stamina = Math.max(p.ch.stamina, Math.round(p.stats.maxStamina * 0.5));
    p.markDirty();
    p.paramsDirty = true;
    p.send(this.server.op.CHAT_MESSAGE, this.server.systemChat('你复活了。'));
  }

  // ---------- player attacks ----------
  handlePlayerAttack(p, a) {
    const op = this.server.op;
    if (!p.alive) return;
    if (!this.scene.combatAllowed()) return;
    const phase = a.attackPhase || 'fire';
    // Monsters leave 飞毯 riders alone, so riders cannot fight either.
    if (p.stats.mount === 'carpet') {
      if (phase === 'fire' && Date.now() - (p.carpetNoticeAt || 0) > 3000) {
        p.carpetNoticeAt = Date.now();
        p.send(this.server.op.CHAT_MESSAGE, this.server.systemChat('骑着飞毯不能攻击，请先下飞毯。'));
      }
      return;
    }
    const prof = p.ch.profession;
    const cp = p.stats.combatProfile;
    if (Number.isFinite(a.x) && Number.isFinite(a.y) && dist(a.x, a.y, p.x, p.y) < 400 && p.path.length === 0) {
      // keep authoritative position close to where the attack was issued
      p.x = a.x; p.y = a.y;
    }
    const aimX = Number.isFinite(a.aimX) ? a.aimX : p.x;
    const aimY = Number.isFinite(a.aimY) ? a.aimY : p.y;
    const dir = directionIndex(aimX - p.x, aimY - p.y);
    const len = Math.hypot(aimX - p.x, aimY - p.y) || 1;
    const visual = {
      attackerId: p.id, phase, aimX, aimY, originX: p.x, originY: p.y, originZ: 0, direction: dir,
      durationMs: p.stats.attackIntervalMs, animationSpeedMultiplier: p.stats.attackSpeed,
      skillId: a.skillId || undefined, skillLevel: a.skillId ? this.server.features.skills.levelOf(p, a.skillId) : undefined,
      aimDirectionX: (aimX - p.x) / len, aimDirectionY: (aimY - p.y) / len,
      projectileKey: cp.projectileKey, projectileSpeed: cp.projectileSpeed,
      attackType: a.attackType || cp.normalAttackType, profession: prof, chargeRatio: a.chargeRatio, castSeq: a.castSeq,
    };
    if (phase !== 'fire') {
      if (!VISUAL_PHASES.has(phase)) return;
      this.scene.broadcast(op.ATTACK_ACTION, Object.assign(visual, { serverSeq: this.server.nextSeq() }), p);
      return;
    }
    if (p.path.length && Number.isFinite(a.x)) {
      // Client stops before attacking; drop the remainder of the hop chain.
      p.x = a.x; p.y = a.y; p.path = []; p.markDirty();
    }
    const now = Date.now();
    if (a.skillId) {
      this.server.features.skills.handleSkillFire(p, a, visual, this);
      return;
    }
    // Normal attacks follow the weapon's interval at this attack speed (the client plays
    // the whole swing in it); clicking faster does not attack faster. 10% slack for jitter.
    const minInterval = Math.max(120, Math.round(p.stats.attackIntervalMs * 0.9));
    if (now - p.lastAttackAt < minInterval) return;
    p.lastAttackAt = now;
    // V15.2 (Q19): every swing wears the weapon, hit or miss.
    if (this.server.features.batch152) this.server.features.batch152.onPlayerAttack(p);
    visual.projectileId = p.id + ':' + (this.projectileNo++);
    this.scene.broadcast(op.ATTACK_ACTION, Object.assign({}, visual, { serverSeq: this.server.nextSeq() }), p);

    let target = a.targetId ? this.scene.enemies.get(a.targetId) : null;
    // Slack for the target moving during the swing or the flight.
    const range = p.stats.attackRange + (cp.attackMode === 'ranged' ? 140 : 80);
    if (cp.attackMode === 'ranged') {
      // A shot hits the first monster on its flight line, whether the player
      // clicked a monster or the ground.
      const live = target && target.alive;
      const tx = live ? target.x : aimX; const ty = live ? target.y : aimY;
      const reach = Math.min(range, Math.max(60, dist(p.x, p.y, tx, ty) + 20));
      const first = this.firstAlong(p.x, p.y, tx, ty, reach, 30);
      if (first) target = first;
    }
    if (!target && !a.targetId) {
      target = this.enemyNear(aimX, aimY, 48);
      // A melee swing at the ground hits the first monster in front, up to the reach.
      if (!target && cp.attackMode !== 'ranged') target = this.firstAlong(p.x, p.y, aimX, aimY, p.stats.attackRange, 50);
    }
    if (!target || !target.alive) return;
    if (dist(p.x, p.y, target.x, target.y) > range) return;
    this.strikeEnemy(p, target, { percent: 100, attackType: visual.attackType, projectileKey: cp.projectileKey, projectileSpeed: cp.projectileSpeed, ranged: cp.attackMode === 'ranged', normal: true });
  }

  enemyNear(x, y, radius) {
    let best = null; let bd = radius;
    for (const m of this.scene.enemies.values()) {
      if (!m.alive) continue;
      const d = dist(m.x, m.y, x, y);
      if (d <= bd) { bd = d; best = m; }
    }
    return best;
  }

  // First living monster within `radius` of the line from (x, y) towards
  // (tx, ty), up to `reach` pixels away.
  firstAlong(x, y, tx, ty, reach, radius) {
    const len = dist(x, y, tx, ty) || 1;
    const bx = x + (tx - x) / len * reach; const by = y + (ty - y) / len * reach;
    const dx = bx - x; const dy = by - y; const l2 = dx * dx + dy * dy || 1;
    let best = null; let bestAlong = Infinity;
    for (const m of this.scene.enemies.values()) {
      if (!m.alive) continue;
      const t = Math.max(0, Math.min(1, ((m.x - x) * dx + (m.y - y) * dy) / l2));
      if (dist(m.x, m.y, x + dx * t, y + dy * t) > radius) continue;
      const along = t * Math.sqrt(l2);
      if (along < bestAlong) { bestAlong = along; best = m; }
    }
    return best;
  }

  enemiesInRadius(x, y, radius) {
    const out = [];
    for (const m of this.scene.enemies.values()) if (m.alive && dist(m.x, m.y, x, y) <= radius) out.push(m);
    return out;
  }

  // Thirteenth batch (Q6/Q7): element attack is a flat value as in the original. Every
  // element value is cut by the defender's resist of that element (capped at the
  // 元素抗性上限 setting): element x (1 - resist%). The physical part still meets
  // defence. An element skill is all of its element: its damage plus the player's own
  // value of that element, cut by the resist, and no defence.
  // custom: {hp, armor} from an admin-made skill's 伤血 / 伤甲 formulas (absolute values).
  elementCut(resists, e) {
    const cap = Math.max(0, Math.min(100, Number(this.server.config.elementResistCap != null ? this.server.config.elementResistCap : 75)));
    return 1 - Math.min(cap, Math.max(0, Number((resists || {})[e]) || 0)) / 100;
  }
  rollPlayerDamage(p, target, percent, element, custom) {
    const s = p.stats;
    const mult = this.server.features.skills.attackMultiplier(p);
    let raw = (custom ? custom.hp : s.attack * percent / 100) * rand(0.9, 1.1) * mult;
    if (Math.random() < Math.min(0.5, s.core.luck * 0.002)) raw *= 1.5; // lucky critical
    const ex = s.extraAttrs;
    const res = target.resists || {};
    let extra = 0;
    // V15.2 (Q31): with elementOnlySkills on, equipment element points only add to a skill
    // of that element (normal attacks and other elements get none).
    const b152 = this.server.features.batch152;
    const onlySkills = b152 ? b152.stCfg().elementOnlySkills : false;
    if (!onlySkills) for (const e of ELEMENTS) if (e !== element) extra += (ex[e + 'Damage'] || 0) * this.elementCut(res, e);
    if (element) return Math.max(1, Math.round((raw + (ex[element + 'Damage'] || 0)) * this.elementCut(res, element) + extra));
    return mitigate(raw, target.defense, custom ? custom.armor : s.breakPower) + Math.round(extra);
  }

  // Resolve one hit from a player on a monster. For lock-on projectiles the
  // client delays the damage text by the flight time itself, so the result is
  // sent at fire time while the authoritative HP change lands on impact.
  strikeEnemy(p, target, o) {
    const op = this.server.op;
    let damage = o.damage != null ? o.damage : this.rollPlayerDamage(p, target, o.percent || 100, o.element, o.custom);
    // Fifteenth batch: 封印的火枪 and 大地龙 (features/batch15.js).
    const b15 = this.server.features.batch15;
    if (b15 && o.damage == null) damage = b15.adjustDamage(p, target, damage, o);
    const hasProjectile = o.projectileKey && o.projectileKey !== 'none';
    const flight = hasProjectile ? Math.max(60, Math.round(dist(p.x, p.y, target.x, target.y) / Math.max(1, o.projectileSpeed || 900) * 1000)) : 0;
    const delayedByClient = o.attackType === 'ranged_lock_on' && hasProjectile;
    const steal = this.stealFor(p, damage);
    const result = () => Object.assign({
      attackerId: p.id, targetId: target.id, attackType: o.attackType, projectileKey: o.projectileKey || 'none',
      projectileSpeed: o.projectileSpeed || 0, direction: directionIndex(target.x - p.x, target.y - p.y),
      damage, targetHp: Math.max(0, Math.round(target.hp)), targetMaxHp: target.maxHp, serverSeq: this.server.nextSeq(),
    }, steal.effects.length ? { stealEffects: steal.effects, stealHp: steal.hp, stealStamina: steal.stamina } : {});
    const land = () => {
      if (!target.alive) return;
      target.hp -= damage;
      target.threat.set(p.id, (target.threat.get(p.id) || 0) + damage);
      target.aggro(p);
      this.applySteal(p, steal);
      if (target.hp <= 0) this.killEnemy(target, p);
      else {
        target.markDirty();
        // V15.2 (Q27-Q29): ice / poison skills slow, freeze or poison the monster.
        if (this.server.features.batch152) this.server.features.batch152.onPlayerStrike(p, target, damage, o);
      }
      if (!delayedByClient) this.scene.broadcast(op.ATTACK_RESULT, result());
    };
    if (delayedByClient) {
      const r = result(); r.targetHp = Math.max(0, Math.round(target.hp - damage));
      this.scene.broadcast(op.ATTACK_RESULT, r);
    }
    this.schedule(flight, land);
    return damage;
  }

  // 吸取生命 / 吸取精力: a share of the damage dealt, at least 1 point. The attack result
  // carries stealEffects (the client plays its hpgot / mpgot swirl) and the amounts.
  stealFor(p, damage) {
    const ex = p.stats.extraAttrs;
    const out = { effects: [], hp: 0, stamina: 0 };
    if (!(damage > 0)) return out;
    // Nothing happens (and no swirl shows) while life / stamina is already full.
    if (ex.lifeStealPercent > 0 && p.ch.hp < p.stats.maxHp) { out.hp = Math.max(1, Math.round(damage * ex.lifeStealPercent / 100)); out.effects.push('life'); }
    if (ex.staminaStealPercent > 0 && p.ch.stamina < p.stats.maxStamina) { out.stamina = Math.max(1, Math.round(damage * ex.staminaStealPercent / 100)); out.effects.push('stamina'); }
    return out;
  }

  applySteal(p, steal) {
    if (!steal.effects.length || !p.alive) return;
    if (steal.hp) p.ch.hp = Math.min(p.stats.maxHp, p.ch.hp + steal.hp);
    if (steal.stamina) p.ch.stamina = Math.min(p.stats.maxStamina, p.ch.stamina + steal.stamina);
    p.markDirty();
    p.paramsDirty = true;
  }

  // ---------- monster attacks ----------
  // hit: the monster's pending hit; a skill may give it a damage multiplier and its own reach.
  monsterHit(m, targetId, hit = {}) {
    const p = this.scene.players.get(targetId);
    if (!p || !p.alive || !m.alive) return;
    if (dist(m.x, m.y, p.x, p.y) > (hit.reach || m.attackRange) * 1.6 + 60) return; // dodged by moving away
    // Thirteenth batch: an admin-made monster skill with an area hits everyone around the target.
    if (hit.radius > 0) {
      const cx = p.x, cy = p.y;
      for (const q of [...this.scene.players.values()]) if (q.alive && dist(q.x, q.y, cx, cy) <= hit.radius) this.monsterHitOne(m, q, hit);
      return;
    }
    this.monsterHitOne(m, p, hit);
  }

  monsterHitOne(m, p, hit) {
    if (!p.alive || !m.alive) return;
    // Thirteenth batch: the monster's flat element attack (original ani.tab ice_ex / fire_ex /
    // bolt_ex / poison_ex) comes on top, each cut by the player's resist of that element.
    // A skill (hit.custom / hit.element) is all of its element, with no defence.
    let elem = 0;
    for (const e of ELEMENTS) if (m.elements && m.elements[e]) elem += m.elements[e] * this.elementCut(p.stats.magicResist, e);
    const k = (hit.mult || 1) * rand(0.85, 1.1);
    let base;
    if (hit.custom) {
      const hp = hit.custom.hp * rand(0.9, 1.1);
      const el = hit.element;
      const own = el ? (m.elements[el] || 0) * this.elementCut(p.stats.magicResist, el) : 0;
      base = el ? (hp + (m.elements[el] || 0)) * this.elementCut(p.stats.magicResist, el) + elem - own : mitigate(hp, p.stats.defense, hit.custom.armor) + elem;
    } else base = mitigate(m.damage * k, p.stats.defense, m.breakPower) + elem * k;
    const dmg = Math.max(1, Math.round(base * this.server.features.skills.damageTakenMultiplier(p)));
    p.ch.hp = Math.max(0, p.ch.hp - dmg);
    p.lastHitAt = Date.now();
    // At least 1 point, so weak hits are reflected too.
    const reflect = p.stats.extraAttrs.damageReflectPercent > 0 ? Math.max(1, Math.round(dmg * p.stats.extraAttrs.damageReflectPercent / 100)) : 0;
    const res = {
      attackerId: m.id, targetId: p.id, attackType: (hit.ranged != null ? hit.ranged : m.ranged) ? 'timed_point_bomb' : 'ranged_lock_on',
      projectileKey: 'none', projectileSpeed: 0, direction: m.direction, damage: dmg,
      targetHp: Math.round(p.ch.hp), targetMaxHp: p.stats.maxHp, serverSeq: this.server.nextSeq(),
    };
    if (reflect > 0) res.reflectEffect = { damage: reflect };
    this.scene.broadcast(this.server.op.ATTACK_RESULT, res);
    p.markDirty();
    p.paramsDirty = true;
    // V15.2: armour wear (Q19, a 大地龙 hit counts 10) and ice / poison states (Q29).
    const b152 = this.server.features.batch152;
    if (b152) { b152.onPlayerHit(p, m); if (p.ch.hp > 0) b152.onMonsterHit(m, p, dmg, hit); }
    if (reflect > 0 && m.alive) {
      // The reflected damage is a hit on the monster: its HP bar drops and the number shows.
      m.hp -= reflect;
      m.threat.set(p.id, (m.threat.get(p.id) || 0) + reflect);
      this.scene.broadcast(this.server.op.ATTACK_RESULT, {
        attackerId: p.id, targetId: m.id, attackType: 'ranged_lock_on', projectileKey: 'none', projectileSpeed: 0,
        direction: directionIndex(m.x - p.x, m.y - p.y), damage: reflect, targetHp: Math.max(0, Math.round(m.hp)),
        targetMaxHp: m.maxHp, reflected: true, serverSeq: this.server.nextSeq(),
      });
      if (m.hp <= 0) this.killEnemy(m, p); else m.markDirty();
    }
    if (p.ch.hp <= 0) this.killPlayer(p);
  }

  killPlayer(p) {
    p.state = 'dead';
    p.diedAt = Date.now();
    p.path = [];
    p.ch.hp = 0;
    p.markDirty();
    p.paramsDirty = true;
    for (const m of this.scene.enemies.values()) if (m.targetId === p.id) m.beginReturn();
    p.send(this.server.op.CHAT_MESSAGE, this.server.systemChat('你被击倒了。'));
    this.server.events.emit('playerKilled', p);
  }

  // ---------- death, exp and loot ----------
  killEnemy(m, killer) {
    if (!m.alive) return;
    const now = Date.now();
    m.die(now);
    // Arena targets give nothing: no exp, no loot, no cards.
    if (m.noReward) { if (m.onKilled) m.onKilled(m, killer); return; }
    this.server.events.emit('enemyKilled', { scene: this.scene, monster: m, killer });
    if (m.v15Boss && this.server.features.batch15) this.server.features.batch15.onKill(m, killer, this.scene);
    const total = Array.from(m.threat.values()).reduce((a, b) => a + b, 0) || 1;
    const shares = m.threat.size ? Array.from(m.threat.entries()) : [[killer.id, 1]];
    // V15.2: the hourly double map multiplies exp, drops and gold there.
    const dbl = this.server.features.batch152 ? this.server.features.batch152.mapMult(this.scene.mapRef) : null;
    const rate = this.server.config.expRate * (dbl ? dbl.exp : 1);
    for (const [pid, dmg] of shares) {
      const p = this.scene.players.get(pid);
      if (!p) continue;
      const share = m.threat.size ? dmg / total : 1;
      const plvl = p.stats.combatLevel;
      const levelFactor = Math.max(0.2, Math.min(2, 1 + (m.level - plvl) * 0.05));
      const base = (m.def.baseExp || 1) + (m.def.extraExp || 0);
      const exp = Math.max(1, Math.round(base * levelFactor * share * rate));
      const members = this.server.features.party ? this.server.features.party.nearbyMembers(p, this.scene) : [p];
      const each = Math.max(1, Math.round(exp / members.length * (members.length > 1 ? 1.2 : 1)));
      const blessing = this.server.features.blessing;
      const blessFactor = Number(this.server.config.blessExpFactor) || 2;
      for (const q of members) {
        // 战神的祝福: no level decay, double exp (the level factor is fixed at blessExpFactor).
        const got = blessing && blessing.isBlessed(q.ch) ? Math.max(1, Math.round(each * blessFactor / levelFactor)) : each;
        this.combat.grantExp(q, { combat: got, profession: Math.ceil(got / 2), community: 0 }, m);
      }
    }
    this.dropLoot(m, killer);
  }

  dropLoot(m, killer) {
    const cfg = this.server.config;
    const bal = this.server.features.balance;
    const edited = bal && m.def.monsterId && bal.dropsFor(m.def.monsterId);
    let drops = edited || m.def.drops || [];
    // Fifteenth batch: the 黄色水晶碎片 chance and the 愚人节 event drops.
    if (this.server.features.batch15) drops = this.server.features.batch15.dropsFor(m, drops, !!edited);
    // A few monsters (e.g. 黄蝴蝶精) have no gold entry at all; give them a small one.
    if (!drops.some((d) => d.type === 'gold')) {
      const lvl = Math.max(1, m.def.level || 1);
      drops = drops.concat({ type: 'gold', chance: 0.05, minCount: lvl * 5, maxCount: lvl * 10 });
    }
    // V15.2 (Q14): the double map does not double cards (not here), 黄色水晶碎片, event drops
    // or the original special drops.
    const dbl = this.server.features.batch152 ? this.server.features.batch152.mapMult(this.scene.mapRef) : null;
    for (const d of drops) {
      let rate = d.type === 'gold' ? cfg.goldDropRate : cfg.dropRate;
      if (dbl && !d.eventDrop && !d.legacySpecialDrop && Number(d.itemId) !== 2622) rate *= d.type === 'gold' ? dbl.gold : dbl.drop;
      if (Math.random() >= Math.min(1, (d.chance || 0) * rate)) continue;
      const count = Math.max(1, Math.round(rand(d.minCount || 1, (d.maxCount || d.minCount || 1) + 0.999) - 0.5));
      if (d.type === 'gold') {
        const gold = Math.max(1, Math.round(count * (cfg.goldAmountRate || 1)));
        this.scene.dropGroundItem(this.combat.goldItem(gold), m.x, m.y, { ownerPlayerId: killer.id, ownerEnemyId: m.id });
      } else {
        // oneOf: one item picked at random from the list.
        const itemId = Array.isArray(d.oneOf) && d.oneOf.length ? d.oneOf[Math.floor(Math.random() * d.oneOf.length)] : d.itemId;
        if (!itemId || !getTemplate(itemId) || BLOCKED_ITEMS.has(Number(itemId))) continue;
        const item = C.makeItem(killer.ch, itemId, count);
        if (!item) continue;
        if (d.name && d.legacySpecialDrop) { item.name = d.name; item.ext = Object.assign({}, item.ext, { legacyPrefixId: d.legacyPrefixId, legacySuffixId: d.legacySuffixId }); A.applyLegacyAffix(item, d); }
        this.scene.dropGroundItem(item, m.x, m.y, { ownerPlayerId: killer.id, ownerEnemyId: m.id });
      }
    }
  }
}

class Combat {
  constructor(server) { this.server = server; }
  forScene(scene) { return new SceneCombat(this, scene); }

  goldItem(amount) {
    return {
      seqId: 'gold:' + Date.now() + ':' + Math.random().toString(36).slice(2, 7), itemId: 0, name: amount + '金币', desc: '金币',
      weight: 0, bonusAttrs: [], sellPrice: 0, count: amount, durability: { cur: 1, max: 1, infinite: true },
      ext: { pickupType: 'gold', gold: amount, groundIcon: amount >= 1000 ? 'money_large' : 'money_small' },
    };
  }

  // Exp settlement: cumulative exp, level ups, skill points, params push.
  grantExp(p, { combat = 0, profession = 0, community = 0 }, source) {
    const ch = p.ch;
    const beforeLvl = C.combatLevel(ch);
    const beforeProf = C.professionLevel(ch);
    const cap = C.cumulativeExpForLevel(C.LEVEL_CAP);
    ch.combatExp = Math.min(cap, (ch.combatExp || 0) + combat);
    // Eleventh batch: a child reaching combat level 10 gets the level lock at 10, once, at
    // that moment. Whether to unlock later is the player's choice alone.
    let childLocked = false;
    if (ch.profession === 'child' && !Number.isInteger(ch.combatLevelLock) && beforeLvl < 10 && C.levelForExp(ch.combatExp) >= 10) {
      ch.combatLevelLock = 10;
      p.levelLockNoticeSent = true;
      childLocked = true;
    }
    if (profession > 0) {
      ch.professionExp = ch.professionExp || {};
      ch.professionExp[ch.profession] = Math.min(cap, (ch.professionExp[ch.profession] || 0) + profession);
    }
    if (community > 0) ch.communityExp = (ch.communityExp || 0) + community;
    const afterLvl = C.combatLevel(ch);
    const afterProf = C.professionLevel(ch);
    const gained = C.settleLevelPoints(ch);
    p.recompute(true);
    if (afterLvl > beforeLvl) {
      ch.hp = p.stats.maxHp; ch.stamina = p.stats.maxStamina;
      p.send(this.server.op.CHAT_MESSAGE, this.server.systemChat('恭喜！战斗等级提升到 ' + afterLvl + ' 级' + (gained ? '，获得 ' + gained + ' 点技能点。' : '。')));
    }
    if (Number.isInteger(ch.combatLevelLock) && C.levelForExp(ch.combatExp) > afterLvl && !p.levelLockNoticeSent) {
      p.levelLockNoticeSent = true;
      p.send(this.server.op.CHAT_MESSAGE, this.server.systemChat('战斗等级已锁定在 ' + afterLvl + ' 级，经验已够升级。输入 /levelup 手动升级，输入 /lock 解除锁定。'));
    }
    if (childLocked) p.send(this.server.op.CHAT_MESSAGE, this.server.systemChat('宝宝战斗等级到了 10 级，已自动锁定等级，以后的经验照常累积。想继续升级可以在人物属性里点「升级」，或点「解锁」取消锁定。'));
    if (afterLvl > beforeLvl) this.server.events.emit('levelChanged', p);
    if (afterProf > beforeProf) {
      p.send(this.server.op.CHAT_MESSAGE, this.server.systemChat('职业等级提升到 ' + afterProf + ' 级。'));
    }
    p.commitItems({});
    p.markDirty();
    this.server.store.markDirty();
    void source;
  }
}

module.exports = { Combat, SceneCombat, mitigate, VISUAL_PHASES };
