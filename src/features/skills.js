'use strict';
// Profession skills: learning from books, birth skills, and the authoritative
// resolution of every skill cast (stamina cost, cooldown, hit geometry,
// damage, buffs, healing and skill experience).
const cat = require('../game/catalog');
const C = require('../game/character');
const { SKILLS, BOOKS, BIRTH_SKILLS, LEVEL_SKILLS, MAX_LEVEL, skillNextExp, normalizeLevel } = require('../game/skills-data');

// Book templates the original catalog lacks, plus the price / level gates the
// client's complete-catalog patch shows for every open skill book.
const BOOK_GATES = {
  301: ['神射手传', 'archer', 10], 302: ['劲射密传', 'archer', 30], 303: ['飞蝗秘籍', 'archer', 10], 304: ['追魂箭宝典', 'archer', 60, 100000],
  311: ['剑气秘籍', 'warrior', 30], 1801: ['冲锋战技书', 'warrior', 10], 900101: ['狂怒战技书', 'warrior', 10], 900102: ['罡气战技书', 'warrior', 30],
  321: ['冰箭术', 'mage', 10], 322: ['小火球术', 'mage', 10], 323: ['闪电术', 'mage', 10], 324: ['治愈术', 'mage', 10],
  325: ['寒冰冲击波', 'mage', 30], 326: ['大火球', 'mage', 30], 327: ['雷星术', 'mage', 30],
  352: ['点射技', 'gunner', 30], 353: ['霰射技', 'gunner', 10],
};

function installBooks() {
  for (const [idStr, [name, profession, minLevel, fixedPrice]] of Object.entries(BOOK_GATES)) {
    const itemId = Number(idStr);
    const price = fixedPrice || (minLevel >= 30 ? 30000 : 5000);
    const old = cat.templates.get(itemId);
    const t = Object.assign({}, old || {
      itemId, name, desc: name + '，研读后习得对应职业技能', equipPos: 'none', tab: 'book', weight: 3,
      durability: { cur: 1, max: 1 }, bonusAttrs: [], source: 'skill_book',
    }, { tab: 'book', buyPrice: price, sellPrice: price / 2, requirement: { professionLevels: [{ profession, minLevel }] } });
    cat.templates.set(itemId, t);
    const shop = cat.catalogs.shop;
    const row = shop.find((s) => s.itemId === itemId);
    if (row) Object.assign(row, { buyPrice: price, sellPrice: price / 2, requirement: t.requirement });
    else shop.push(t);
    cat.skillBooks.set(itemId, { profession, skillId: BOOKS[itemId] });
  }
}

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
// Distance from point to segment, and the projection along it.
function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay; const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return { d: Math.hypot(px - (ax + dx * t), py - (ay + dy * t)), along: t * Math.sqrt(l2) };
}
function rotate(x, y, deg) { const r = deg * Math.PI / 180; const c = Math.cos(r); const s = Math.sin(r); return { x: x * c - y * s, y: x * s + y * c }; }
function feihuangCount(level, charge) {
  const l = normalizeLevel(level);
  const min = 3 + Math.floor((l - 1) / 10); const max = Math.min(21, 3 + Math.floor((l - 1) / 2));
  return min + Math.floor((max - min) * Math.max(0, Math.min(1, charge || 0)));
}

// The element of each element skill (fire / ice / thunder / poison).
const SKILL_ELEMENTS = {
  mage_ice_shockwave: 'ice', mage_ice_arrow: 'ice', mage_fireball: 'fire', mage_small_fireball: 'fire',
  mage_lightning_bolt: 'thunder', mage_lightning_star: 'thunder', child_poison_cast: 'poison',
};

class Skills {
  register(server) {
    this.server = server;
    installBooks();
    server.events.on('playerEntered', (p) => this.grantBirthSkills(p));
    server.events.on('levelChanged', (p) => this.grantBirthSkills(p));
  }

  levelOf(p, id) { const s = p.ch.professionSkills[id]; return s ? s.level || 1 : 1; }

  grantBirthSkills(p) {
    const ids = BIRTH_SKILLS[p.ch.profession] || [];
    let added = false;
    for (const id of ids) if (!p.ch.professionSkills[id]) { p.ch.professionSkills[id] = { level: 1, exp: 0 }; added = true; }
    const lvl = C.combatLevel(p.ch);
    for (const [min, id] of LEVEL_SKILLS[p.ch.profession] || []) {
      if (lvl < min || p.ch.professionSkills[id]) continue;
      if (SKILLS[id] && SKILLS[id].allowed && !SKILLS[id].allowed(p.ch)) continue;
      p.ch.professionSkills[id] = { level: 1, exp: 0 }; added = true;
      if (SKILLS[id]) this.notify(p, '你学会了' + SKILLS[id].name + '。');
    }
    if (added) p.paramsDirty = true;
  }

  learn(p, skillId) {
    if (p.ch.professionSkills[skillId]) return false;
    p.ch.professionSkills[skillId] = { level: 1, exp: 0 };
    p.paramsDirty = true;
    return true;
  }

  notify(p, message) { p.send(this.server.op.CHAT_MESSAGE, this.server.systemChat(message)); }

  // Called by SceneCombat for an attack action carrying a skillId.
  handleSkillFire(p, a, visual, combat) {
    const id = String(a.skillId);
    const def = SKILLS[id];
    const state = p.ch.professionSkills[id];
    if (!def || !state) return;
    if (def.allowed ? !def.allowed(p.ch) : def.profession !== p.ch.profession) return;
    // Eleventh batch: while auto hunting only the skill chosen in its settings is cast.
    const ah = this.server.features.autoHunt;
    if (p.autoHunt && !(ah ? ah.mayCast(p, id) : (p.ch.autoHuntCfg || {}).skill === id)) { this.notify(p, '自动打怪中不能手动放技能，请先关闭自动打怪。'); return; }
    if (def.needsBlade && C.warriorHoldsBow(p.ch)) { this.notify(p, def.name + '要拿刀剑（或空手）才能施放，拿弓时不能用。'); return; }
    const level = normalizeLevel(state.level);
    const now = Date.now();
    p.skillCooldowns = p.skillCooldowns || {};
    // Allow a little network jitter against the client's own cooldown.
    if (now < (p.skillCooldowns[id] || 0) - 150) return;
    const cost = def.cost(level);
    if (p.ch.stamina < cost) { this.notify(p, '精力不足，无法施放' + def.name); p.paramsDirty = true; return; }
    p.ch.stamina -= cost;
    p.skillCooldowns[id] = now + (def.cooldownMs || 0);
    p.paramsDirty = true;
    p.markDirty();
    // V15.2 (Q19): a skill is an attack too and wears the weapon.
    if (this.server.features.batch152) this.server.features.batch152.onPlayerAttack(p);

    const charge = Math.max(0, Math.min(1, Number(a.chargeRatio) || 0));
    let ax = visual.aimX; let ay = visual.aimY;
    const dx = ax - p.x; const dy = ay - p.y; const len = Math.hypot(dx, dy);
    const ux = len > 0.001 ? dx / len : 1; const uy = len > 0.001 ? dy / len : 0;
    if (def.range && len > def.range + 40) { ax = p.x + ux * def.range; ay = p.y + uy * def.range; }
    const percent = def.damage ? def.damage(level) * (1 + (def.chargeBonus || 0) * charge / 100) : 0;
    // Thirteenth batch: admin-made skills give absolute 伤血 / 伤甲 values (customskills.js).
    const custom = def.customSkill ? this.server.features.customSkills.playerHit(p, def, level) : null;
    const ex = p.stats.extraAttrs;
    // Original prefixes (thirteenth batch): 近战 for warriors, 远程 for hunters, 枪械 for
    // gunners, 魔法 for mages (杀人者 / 造箭者 / 镖客 / 巫师 and their higher ranks).
    const own = { warrior: 'nearSkillPercent', archer: 'farSkillPercent', gunner: 'gunSkillPercent', mage: 'magicSkillPercent' }[p.ch.profession];
    const skillPct = 1 + ((ex.professionSkillPercent || 0) + (own ? ex[own] || 0 : 0)) / 100;
    // Twelfth batch: element skills meet the monster's resist of that element (combat.js).
    const hit = { percent: percent * skillPct, attackType: def.attackType, projectileKey: 'none', projectileSpeed: 0, element: SKILL_ELEMENTS[id] || def.element || null, skillId: id, skillLevel: level,
      custom: custom ? { hp: custom.hp * skillPct, armor: custom.armor } : undefined };
    const out = Object.assign({}, visual, {
      skillId: id, skillLevel: level, aimX: ax, aimY: ay, attackType: def.attackType,
      projectileKey: def.projectileKey || 'none', projectileSpeed: def.projectileSpeed || 0,
      impactDelayMs: def.impactDelayMs || 0, timestamp: now,
    });
    let hits = 0;
    const flight = (x, y) => (def.projectileSpeed ? Math.max(60, Math.round(dist(p.x, p.y, x, y) / def.projectileSpeed * 1000)) : 0) + (def.impactDelayMs || 0);
    // Area hits resolve at impact time against whoever stands there then.
    const areaAt = (x, y, radius, delay, after) => {
      combat.schedule(delay, () => {
        if (p.scene !== combat.scene) return;
        const list = combat.enemiesInRadius(x, y, radius);
        for (const m of list) combat.strikeEnemy(p, m, hit);
        if (list.length) this.gainExp(p, id, 1);
        if (after) after();
      });
    };
    switch (def.kind) {
      case 'line': {
        const bx = p.x + ux * def.range; const by = p.y + uy * def.range;
        const list = [];
        for (const m of combat.scene.enemies.values()) {
          if (!m.alive) continue;
          const s = segmentDistance(m.x, m.y, p.x, p.y, bx, by);
          if (s.d <= def.radius) list.push({ m, along: s.along });
        }
        for (const { m, along } of list) {
          combat.schedule(Math.round(along / Math.max(1, def.projectileSpeed) * 1000), () => { if (m.alive) combat.strikeEnemy(p, m, hit); });
          hits += 1;
        }
        out.aimX = bx; out.aimY = by;
        break;
      }
      case 'point': {
        if (def.lockOn) {
          // Aimed at or near a monster: centre the cloud on it.
          const t = (a.targetId && combat.scene.enemies.get(a.targetId)) || combat.enemyNear(ax, ay, def.radius + 60);
          if (t && t.alive && dist(p.x, p.y, t.x, t.y) <= def.range + 60) { ax = t.x; ay = t.y; out.aimX = ax; out.aimY = ay; out.targetId = t.id; }
        }
        areaAt(ax, ay, def.radius, flight(ax, ay), def.impactPhase
          ? () => combat.scene.broadcast(this.server.op.ATTACK_ACTION, Object.assign({}, out, { phase: 'impact', serverSeq: this.server.nextSeq() }))
          : null);
        break;
      }
      case 'burst': {
        const n = def.count(level);
        for (let i = 0; i < n; i += 1) areaAt(ax, ay, def.radius, flight(ax, ay) + i * def.intervalMs);
        out.pelletCount = n;
        break;
      }
      case 'volley': {
        // Every arrow flies the full range in its own direction of the fan and hits the
        // first enemy on its line (no pierce); the mouse only gives the direction.
        const n = def.customSkill ? def.count(level) : feihuangCount(level, charge);
        const spread = (n - 1) / 20 * 90;
        for (let i = 0; i < n; i += 1) {
          const deg = n === 1 ? 0 : -spread / 2 + spread * i / (n - 1);
          const v = rotate(ux, uy, deg);
          const bx = p.x + v.x * def.range; const by = p.y + v.y * def.range;
          let best = null;
          for (const m of combat.scene.enemies.values()) {
            if (!m.alive) continue;
            const s = segmentDistance(m.x, m.y, p.x, p.y, bx, by);
            if (s.d <= def.radius && (!best || s.along < best.along)) best = { m, along: s.along };
          }
          if (!best) continue;
          const m = best.m;
          combat.schedule(Math.round(best.along / def.projectileSpeed * 1000), () => { if (m.alive && p.scene === combat.scene) combat.strikeEnemy(p, m, hit); });
          hits += 1;
        }
        out.aimX = p.x + ux * def.range; out.aimY = p.y + uy * def.range;
        out.pelletCount = n; out.chargeRatio = charge;
        break;
      }
      case 'seek': {
        // The search centre is the aim point, kept within the cast distance.
        const r = def.searchRadius(level);
        let best = null;
        const t = a.targetId && combat.scene.enemies.get(a.targetId);
        if (t && t.alive && dist(ax, ay, t.x, t.y) <= r + 60) best = t;
        if (!best) for (const m of combat.scene.enemies.values()) {
          if (!m.alive) continue;
          const d = dist(ax, ay, m.x, m.y);
          if (d <= r && (!best || d < dist(ax, ay, best.x, best.y))) best = m;
        }
        if (best) {
          const m = best;
          combat.schedule(Math.round(dist(p.x, p.y, m.x, m.y) / def.projectileSpeed * 1000), () => { if (m.alive && p.scene === combat.scene) combat.strikeEnemy(p, m, hit); });
          hits += 1;
          out.aimX = m.x; out.aimY = m.y; out.targetId = m.id;
        }
        break;
      }
      case 'pellets': {
        const n = def.count(level);
        for (let i = 0; i < n; i += 1) {
          const deg = n === 1 ? 0 : -def.spreadDeg / 2 + def.spreadDeg * i / (n - 1);
          const v = rotate(ux, uy, deg);
          const bx = p.x + v.x * def.range; const by = p.y + v.y * def.range;
          for (const m of combat.scene.enemies.values()) {
            if (!m.alive) continue;
            const s = segmentDistance(m.x, m.y, p.x, p.y, bx, by);
            if (s.d <= def.radius) {
              combat.schedule(Math.round(s.along / def.projectileSpeed * 1000), () => { if (m.alive) combat.strikeEnemy(p, m, hit); });
              hits += 1;
            }
          }
        }
        out.pelletCount = n;
        break;
      }
      case 'first': {
        const bx = p.x + ux * def.range; const by = p.y + uy * def.range;
        let best = null;
        if (a.targetId) { const t = combat.scene.enemies.get(a.targetId); if (t && t.alive && dist(p.x, p.y, t.x, t.y) <= def.range + 60) best = { m: t, along: dist(p.x, p.y, t.x, t.y) }; }
        if (!best) {
          for (const m of combat.scene.enemies.values()) {
            if (!m.alive) continue;
            const s = segmentDistance(m.x, m.y, p.x, p.y, bx, by);
            if (s.d <= def.radius + 18 && (!best || s.along < best.along)) best = { m, along: s.along };
          }
        }
        if (best) {
          const m = best.m;
          combat.schedule(Math.round(best.along / def.projectileSpeed * 1000), () => { if (m.alive) combat.strikeEnemy(p, m, hit); });
          hits += 1;
          out.aimX = m.x; out.aimY = m.y; out.targetId = m.id;
        } else { out.aimX = bx; out.aimY = by; }
        break;
      }
      case 'nova': {
        areaAt(p.x, p.y, def.radius, def.impactDelayMs || 0);
        out.aimX = p.x; out.aimY = p.y;
        break;
      }
      case 'heal': {
        let target = p;
        if (a.targetId && a.targetId !== p.id) {
          const q = combat.scene.players.get(a.targetId);
          if (q && q.alive && dist(p.x, p.y, q.x, q.y) <= def.range + 60) target = q;
        }
        const amount = Math.round(def.heal(level) + p.stats.core.intelligence * 1.5);
        const before = target.ch.hp;
        target.ch.hp = Math.min(target.stats.maxHp, target.ch.hp + amount);
        target.paramsDirty = true; target.markDirty();
        if (target.ch.hp > before) hits += 1;
        this.notify(p, target === p ? '治愈术恢复了 ' + Math.round(target.ch.hp - before) + ' 点生命' : '为 ' + target.name + ' 恢复了 ' + Math.round(target.ch.hp - before) + ' 点生命');
        if (target !== p) this.notify(target, p.name + ' 为你恢复了 ' + Math.round(target.ch.hp - before) + ' 点生命');
        out.aimX = target.x; out.aimY = target.y; out.targetId = target.id;
        break;
      }
      case 'buff': {
        p.buffs = p.buffs.filter((b) => b.id !== id && b.expiresAt > now);
        p.buffs.push({
          id, name: def.name, expiresAt: now + def.buffDurationMs,
          attackPercent: def.attackPercent ? def.attackPercent(level) : 0, defensePercent: def.defensePercent ? def.defensePercent(level) : 0,
        });
        hits = 1;
        out.aimX = p.x; out.aimY = p.y;
        break;
      }
      case 'charge': {
        const t = a.targetId ? combat.scene.enemies.get(a.targetId) : combat.enemyNear(ax, ay, def.radius);
        if (!t || !t.alive || dist(p.x, p.y, t.x, t.y) > def.range + 80) { p.ch.stamina += cost; p.skillCooldowns[id] = 0; return; }
        const d = dist(p.x, p.y, t.x, t.y);
        const stop = Math.max(0, d - 40);
        const nx = p.x + (t.x - p.x) / (d || 1) * stop; const ny = p.y + (t.y - p.y) / (d || 1) * stop;
        const dest = combat.scene.map.nearestWalkablePixel ? combat.scene.map.nearestWalkablePixel(nx, ny) : { x: nx, y: ny };
        const delay = Math.round(stop / def.projectileSpeed * 1000);
        out.aimX = t.x; out.aimY = t.y; out.targetId = t.id;
        combat.schedule(delay, () => {
          if (!p.alive || p.scene !== combat.scene) return;
          if (dest) { p.path = []; p.x = dest.x; p.y = dest.y; p.markDirty(); }
          for (const m of combat.enemiesInRadius(t.x, t.y, def.radius)) combat.strikeEnemy(p, m, hit);
        });
        hits = 1;
        break;
      }
      case 'orbit': {
        const n = def.count(level);
        out.pelletCount = n;
        const targets = combat.enemiesInRadius(p.x, p.y, def.range).sort((m1, m2) => dist(p.x, p.y, m1.x, m1.y) - dist(p.x, p.y, m2.x, m2.y));
        for (let i = 0; i < n && targets.length; i += 1) {
          const m = targets[i % targets.length];
          const at = 600 + i * 350;
          combat.schedule(at, () => {
            if (!m.alive || !p.alive || p.scene !== combat.scene) return;
            combat.scene.broadcast(this.server.op.ATTACK_ACTION, Object.assign({}, out, { phase: 'orbit_launch', aimX: m.x, aimY: m.y, targetId: m.id, pelletIndex: i, serverSeq: this.server.nextSeq() }));
            combat.schedule(Math.round(dist(p.x, p.y, m.x, m.y) / def.projectileSpeed * 1000), () => { if (m.alive) combat.strikeEnemy(p, m, hit); });
          });
          hits += 1;
        }
        break;
      }
      default: break;
    }

    const packet = Object.assign(out, { serverSeq: this.server.nextSeq() });
    if (def.echoToCaster) combat.scene.broadcast(this.server.op.ATTACK_ACTION, packet);
    else combat.scene.broadcast(this.server.op.ATTACK_ACTION, packet, p);
    if (hits > 0) this.gainExp(p, id, 1);
  }

  gainExp(p, id, n) {
    const s = p.ch.professionSkills[id];
    if (!s) return;
    // Arena target dummies teach nothing.
    if (p.scene && p.scene.map.id === 'abattoir_pka') return;
    s.level = normalizeLevel(s.level);
    if (s.level >= MAX_LEVEL) return;
    s.exp = (s.exp || 0) + n;
    let up = false;
    while (s.level < MAX_LEVEL && s.exp >= skillNextExp(s.level)) { s.exp -= skillNextExp(s.level); s.level += 1; up = true; }
    if (s.level >= MAX_LEVEL) s.exp = 0;
    p.paramsDirty = true;
    if (up) this.notify(p, SKILLS[id].name + ' 提升到 ' + s.level + ' 级！');
  }

  // Combat hooks for active buffs.
  attackMultiplier(p) {
    const now = Date.now(); let pct = 0;
    for (const b of p.buffs) if (b.expiresAt > now && b.attackPercent) pct += b.attackPercent;
    return 1 + pct / 100;
  }

  damageTakenMultiplier(p) {
    const now = Date.now(); let pct = 0;
    for (const b of p.buffs) if (b.expiresAt > now && b.defensePercent) pct += b.defensePercent;
    return Math.max(0.2, 1 - pct / 100);
  }
}

module.exports = { Skills, feihuangCount };
