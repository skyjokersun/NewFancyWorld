'use strict';
// 狐仙, the beast summoned with red fox furs (item 2586): 100 / 200 / 300 / 400 for LV1-4.
// - Model fox3: the big fox of the original client (the 小酒窝 client summons it as 狐仙).
//   The web assets have no stand.ale for it; virtual-assets.js serves walk.ale there,
//   as that client does.
// - Its own attacks, chosen per swing:
//     狐火  a fireball (projectile huoqiu) from up to 380 px, 1.3x damage, every 4 s;
//     扑击  a lunge at a player up to 220 px away (the client's dash_to_target motion),
//           1.6x damage, every 7 s;
//     撕咬  the normal bite at close range.
// - Each summon also learns 1–2 profession skills at random (LV1 one, LV2 one or two,
//   LV3 and LV4 two), drawn from SKILL_POOL, using the visuals the client already has for
//   monster attacks. Skills that hit an area hurt every player in it.
// - Drops follow its level: gems and 印 of the matching grade (LV1 碎片 / 残缺,
//   LV2 次 / 模糊, LV3 full, LV4 高纯 / 极品), plus red furs (gold instead at LV4).
// - It is hostile to everyone (the summon prompt warns of that) and may be hunted by all.
// - Left alone for 10 minutes (no fight), it goes away, so a map does not keep it forever.

const FIRE = { reach: 380, mult: 1.3, cooldownMs: 4000, speed: 600 };
const POUNCE = { reach: 220, mult: 1.6, cooldownMs: 7000, speed: 900 };
const BITE_RANGE = 80;
const ATTACK_INTERVAL_MS = 1500;
const FIGHT_ACTION_MS = 800;
const LEAVE_AFTER_MS = 10 * 60 * 1000;
const GIVE_UP_MS = 5000;

// Profession skills a fox may learn. area: 'self' hits players around the fox, 'target'
// players around the aim point, 'cone' players in front within reach.
const SKILL_POOL = [
  { id: 'ice_shockwave', name: '寒冰冲击波', reach: 200, mult: 1.4, cooldownMs: 9000, area: 'self', radius: 230, delay: 650,
    combat: { mode: 'melee', specialMotion: 'radial_ice_shockwave' } },
  { id: 'ice_arrow', name: '冰箭术', reach: 420, mult: 1.2, cooldownMs: 3500, speed: 900,
    combat: { mode: 'ranged', projectileKey: 'bingjian' } },
  { id: 'hail', name: '冰雹术', reach: 400, mult: 1.3, cooldownMs: 7000, speed: 700, area: 'target', radius: 110,
    combat: { mode: 'ranged', projectileKey: 'bingbao' } },
  { id: 'poison', name: '毒术', reach: 360, mult: 1.15, cooldownMs: 5000, speed: 700,
    combat: { mode: 'ranged', projectileKey: 'poison' } },
  { id: 'scatter', name: '霰射', reach: 320, mult: 0.9, cooldownMs: 6000, speed: 1100, area: 'cone', halfAngle: 30,
    combat: { mode: 'ranged', projectileKey: 'sanbullet' } },
  { id: 'power_shot', name: '劲射', reach: 480, mult: 1.6, cooldownMs: 6000, speed: 1200,
    combat: { mode: 'ranged', projectileKey: 'arrow' } },
];

// Drops by fox level (1-4).
const GEMS = [
  [1665, 1666, 1667, 1668, 1670, 1671, 1673],
  [1675, 1676, 1677, 1678, 1680, 1681, 1683],
  [1685, 1686, 1687, 1688, 1690, 1691, 1693],
  [1695, 1696, 1697, 1698, 1704],
];
const SEALS = [2305, 2313, 2321, 2329].map((first) => Array.from({ length: 8 }, (_, i) => first + i));

function foxDrops(tier, fur) {
  const t = Math.max(1, Math.min(4, tier)) - 1;
  const drops = [
    { type: 'item', oneOf: GEMS[t], chance: 1, minCount: 1, maxCount: 2 },
    { type: 'item', oneOf: GEMS[t], chance: 0.5, minCount: 1, maxCount: 1 },
    { type: 'item', oneOf: SEALS[t], chance: 0.8, minCount: 1, maxCount: 1 },
    { type: 'item', oneOf: SEALS[t], chance: 0.3, minCount: 1, maxCount: 1 },
  ];
  // Now and then a gem one grade up.
  if (t < 3) drops.push({ type: 'item', oneOf: GEMS[t + 1], chance: 0.08, minCount: 1, maxCount: 1 });
  if (fur && t < 3) drops.push({ type: 'item', itemId: fur, chance: 0.5, minCount: 5, maxCount: 20 });
  else drops.push({ type: 'gold', chance: 1, minCount: 50000, maxCount: 100000 });
  return drops;
}

function pickSkills(tier, random = Math.random) {
  const count = tier <= 1 ? 1 : tier === 2 ? 1 + (random() < 0.5 ? 1 : 0) : 2;
  const pool = SKILL_POOL.slice();
  const out = [];
  while (out.length < count && pool.length) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  return out;
}

function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

// V15.2 (Q32): opts.magic = the original attack kind (301 冰箭, 302 火球, 303 闪电, 305 毒雾).
// The fox then casts that magic (magic.tab range 400) in place of 狐火 and the random
// learned skills; 扑击 and the bite stay. The hit carries the magic's element, so ice slows
// and poison poisons (batch152 onMonsterHit).
const MAGIC_SHOT = { 301: ['冰箭', 'bingjian', 'ice'], 302: ['火球', 'huoqiu', 'fire'], 303: ['闪电', 'bolt', 'thunder'], 305: ['毒雾', 'poison', 'poison'] };
function originalMagic(kind) {
  const s = MAGIC_SHOT[kind];
  if (!s) return null;
  let range = 400;
  try { range = require('../../data/original-tables.json').magic[kind].range || 400; } catch (_) { /* default */ }
  return { id: 'magic', name: s[0], reach: range, mult: 1, cooldownMs: 3000, speed: 800, element: s[2], combat: { mode: 'ranged', projectileKey: s[1] } };
}

function makeFoxFairy(m, tier = 1, skills = pickSkills(tier), opts = {}) {
  const { directionIndex } = require('./monster');
  m.model = 'fox3';
  m.role = 'enemy/fox3';
  m.foxTier = tier;
  m.fireReadyAt = 0;
  m.pounceReadyAt = 0;
  m.foxSkills = skills.map((s) => Object.assign({ readyAt: 0 }, s));
  m.foxMagic = opts.magic ? originalMagic(opts.magic) : null;
  if (m.foxMagic) m.foxMagic.readyAt = 0;
  m.combatNow = { mode: 'melee', attackActionKey: 'fight', fightFrameDelayMs: 80 };
  m.originalCombat = () => m.combatNow;

  // Every attack the fox has, best first: its learned skills, then 狐火 and 扑击.
  const attacks = () => m.foxMagic ? m.foxSkills.concat([m.foxMagic]) : m.foxSkills.concat([
    Object.assign({ id: 'fire', name: '狐火', readyAt: m.fireReadyAt, combat: { mode: 'ranged', projectileKey: 'huoqiu', fightSoundKey: 'fire' } }, FIRE),
  ]);
  const ready = (now) => attacks().filter((a) => now >= a.readyAt);

  // Aggro (tenth batch): it chases anyone within its detection range, and whoever hits it.
  // It gives up on a target that is out of range and has not hit it for GIVE_UP_MS, and
  // then stays where it is (no walk home, no healing); it wanders around that spot.
  m.detectionRange = Math.max(80, Number(m.scene.server.config.foxDetectRange) || 500);
  m.hitAt = new Map();
  m.aggro = (player) => {
    if (!m.alive || !player || !player.alive) return;
    m.hitAt.set(player.id, Date.now());
    const cur = m.targetId ? m.scene.players.get(m.targetId) : null;
    if (!cur || !cur.alive || dist(m.x, m.y, cur.x, cur.y) > m.detectionRange) {
      m.targetId = player.id; m.state = 'chase'; m.lastRepathAt = 0;
    }
  };
  m.beginReturn = () => {
    m.targetId = null;
    m.state = 'idle';
    m.stop();
    m.homeX = m.x; m.homeY = m.y;
    m.nextWanderAt = Date.now() + 3000 + Math.random() * 4000;
  };

  const tick = m.tick.bind(m);
  m.lastFightAt = Date.now();
  m.lastHp = m.hp;
  m.tick = (now, dt) => {
    if (m.targetId || m.hp !== m.lastHp) { m.lastFightAt = now; m.lastHp = m.hp; }
    if (m.alive && (m.state === 'chase' || m.state === 'attack') && m.targetId) {
      const t = m.scene.players.get(m.targetId);
      if (t && dist(m.x, m.y, t.x, t.y) > m.detectionRange && now - (m.hitAt.get(t.id) || 0) > GIVE_UP_MS) m.beginReturn();
      // Ordinary monsters measure their leash from home; the fox's home moves with it.
      else { m.homeX = m.x; m.homeY = m.y; }
    }
    if (now - m.lastFightAt > LEAVE_AFTER_MS && m.alive) {
      m.scene.enemies.delete(m.id);
      m.scene.removedEnemyIds.push(m.id);
      return undefined;
    }
    // Area hits land on every player inside the area.
    if (m.pendingHit && m.pendingHit.area && now >= m.pendingHit.at) {
      const h = m.pendingHit; m.pendingHit = null;
      if (m.alive) for (const p of hitPlayers(m, h)) m.scene.combat.monsterHit(m, p.id, { mult: h.mult, reach: 1e6, ranged: h.ranged });
    }
    // The approach distance follows the longest attack that is ready; a learned skill that
    // is ready comes first, so a short one (寒冰冲击波) still gets used.
    const learned = m.foxSkills.filter((a) => now >= a.readyAt).map((a) => a.reach);
    const reaches = ready(now).map((a) => a.reach);
    if (now >= m.pounceReadyAt) reaches.push(POUNCE.reach);
    m.attackRange = learned.length ? Math.max(...learned) : reaches.length ? Math.max(...reaches) : BITE_RANGE;
    return tick(now, dt);
  };

  m.startAttack = (target, now) => {
    const d = dist(m.x, m.y, target.x, target.y);
    const base = { attackActionKey: 'fight', fightFrameDelayMs: 80 };
    let hit;
    const skill = d > BITE_RANGE * 0.6 ? ready(now).find((a) => d <= a.reach) : null;
    if (skill) {
      if (skill.id === 'fire') m.fireReadyAt = now + skill.cooldownMs;
      else if (skill.id === 'magic') m.foxMagic.readyAt = now + skill.cooldownMs;
      else m.foxSkills.find((s) => s.id === skill.id).readyAt = now + skill.cooldownMs;
      const ranged = skill.combat.mode === 'ranged';
      m.combatNow = Object.assign({}, base, skill.combat, ranged ? { projectileSpeed: skill.speed, projectileRange: skill.reach } : {});
      const travel = ranged ? Math.max(60, d / skill.speed * 1000) : (skill.delay || 0);
      hit = { mult: skill.mult, reach: skill.reach, ranged, travel, skill: skill.id === 'magic' ? undefined : skill.id };
      if (skill.area) Object.assign(hit, { area: skill.area, radius: skill.radius, halfAngle: skill.halfAngle, cx: m.x, cy: m.y, ax: target.x, ay: target.y });
    } else if (now >= m.pounceReadyAt && d > BITE_RANGE * 0.6 && d <= POUNCE.reach) {
      m.pounceReadyAt = now + POUNCE.cooldownMs;
      m.combatNow = Object.assign({}, base, { mode: 'melee', specialMotion: 'dash_to_target', projectileSpeed: POUNCE.speed, projectileRange: d });
      hit = { mult: POUNCE.mult, reach: POUNCE.reach, ranged: false, travel: 0 };
    } else {
      m.combatNow = Object.assign({}, base, { mode: 'melee' });
      hit = { mult: 1, reach: BITE_RANGE, ranged: false, travel: 0 };
    }
    m.nextAttackAt = now + ATTACK_INTERVAL_MS;
    m.direction = directionIndex(target.x - m.x, target.y - m.y);
    m.attackSequence += 1;
    m.attackAimX = target.x; m.attackAimY = target.y;
    m.attackStartedAt = now;
    m.attackDamageAt = now + 380 + hit.travel;
    m.actionUntil = now + FIGHT_ACTION_MS;
    m.pendingHit = Object.assign({ at: m.attackDamageAt, targetId: target.id }, hit);
    m.markDirty();
  };
  return m;
}

// Players an area hit catches.
function hitPlayers(m, h) {
  const out = [];
  for (const p of m.scene.players.values()) {
    if (!p.alive || p.stats.mount === 'carpet') continue;
    if (h.area === 'self' && dist(h.cx, h.cy, p.x, p.y) <= h.radius) out.push(p);
    else if (h.area === 'target' && dist(h.ax, h.ay, p.x, p.y) <= h.radius) out.push(p);
    else if (h.area === 'cone') {
      const d = dist(h.cx, h.cy, p.x, p.y);
      if (d > h.reach + 40) continue;
      const aim = Math.atan2(h.ay - h.cy, h.ax - h.cx), dir = Math.atan2(p.y - h.cy, p.x - h.cx);
      let diff = Math.abs(aim - dir) * 180 / Math.PI; if (diff > 180) diff = 360 - diff;
      if (d < 40 || diff <= h.halfAngle) out.push(p);
    }
  }
  return out;
}

module.exports = { originalMagic, makeFoxFairy, foxDrops, pickSkills, hitPlayers, SKILL_POOL, GEMS, SEALS, FIRE, POUNCE, BITE_RANGE };
