'use strict';
// Profession skill catalog. The client's native bundle knows seven skills;
// the complete-catalog patch renders any other entry from the fields sent in
// params.professionSkills, so every skill carries its presentation here too.
// Costs are paid from stamina (the client's "mana" check reads stamina).

const MAX_LEVEL = 41;
const lv = (l) => Math.max(1, Math.min(MAX_LEVEL, Math.trunc(l || 1)));

// kind: how the server resolves hits.
//   line     - piercing path from the caster towards the aim (width = radius)
//   point    - area at the aim point after the projectile flight
//   volley   - several points fanned around the aim direction
//   pellets  - several piercing paths fanned around the aim direction
//   burst    - several shots at the same point
//   first    - first enemy along the path (single target)
//   seek     - homing arrow: the enemy nearest the aim point inside the search radius
//   nova     - area around the caster
//   heal     - restores hp of the caster or a nearby player
//   buff     - timed self buff
//   charge   - dash to a monster, damage around it
//   orbit    - pellets orbiting the caster, each launched at a nearby monster
const SKILLS = {
  // Icons (fourteenth batch): the frame each skill has in the original skill.tab
  // (对应特技图片, e.g. magic_skill01.ale?f=2 = 小火球 = magic_skill01_r01_c00; frames
  // count row by row). 狂怒 and 超级乱射 have no original row and keep their old icon.
  warrior_jianqi: {
    name: '剑气', profession: 'warrior', kind: 'line', range: 420, radius: 46, attackType: 'piercing_trail_bomb', needsBlade: true,
    projectileKey: 'none', projectileSpeed: 900, cooldownMs: 900, iconPath: 'skills/skillbook_2_01_r00_c00/spriteFrame',
    damage: (l) => 130 + 3 * l, cost: (l) => 12 + Math.floor(l / 2),
    description: '向前挥出一道笔直剑气，沿路径穿透敌人并依次造成范围伤害。',
  },
  warrior_charge: {
    name: '冲锋', profession: 'warrior', kind: 'charge', targetMode: 'target', range: 600, minRange: 160, radius: 80,
    attackType: 'charge_dash', projectileKey: 'none', projectileSpeed: 1000, cooldownMs: 6000,
    iconPath: 'skills/skillbook_2_01_r00_c02/spriteFrame', damage: (l) => 120 + 3 * l, cost: (l) => 15 + Math.floor(l / 2),
    description: '选中怪物后高速冲锋到它身边，对落点周围的怪物造成伤害。',
  },
  warrior_rage: {
    name: '狂怒', profession: 'warrior', kind: 'buff', targetMode: 'self', attackType: 'self_buff', cooldownMs: 15000,
    buffDurationMs: 6000, iconPath: 'skills/skillbook_2_01_r00_c00/spriteFrame', attackPercent: (l) => 15 + l, cost: (l) => 20 + Math.floor(l / 2),
    description: '按下即放，6 秒内攻击力大幅提升。',
  },
  warrior_gangqi: {
    name: '罡气', profession: 'warrior', kind: 'buff', targetMode: 'self', attackType: 'self_buff', cooldownMs: 15000,
    buffDurationMs: 4000, iconPath: 'skills/skillbook_2_01_r00_c01/spriteFrame', defensePercent: (l) => 20 + l, cost: (l) => 20 + Math.floor(l / 2),
    description: '按下即放，4 秒内护体罡气减免受到的伤害。',
  },
  hunter_jinshot: {
    name: '劲射技', profession: 'archer', kind: 'point', range: 400, radius: 42, attackType: 'timed_point_bomb',
    projectileKey: 'huojian', projectileSpeed: 1250, cooldownMs: 900, iconPath: 'skills/bow_skill_r01_c01/spriteFrame', chargeBonus: 35,
    damage: (l) => 110 + l, cost: (l) => Math.floor(13 + 3 * lv(l) / 2), native: true,
    description: '按住技能键蓄力，松开后朝鼠标位置射出一支带火焰尾迹的高速劲箭。',
  },
  hunter_feihuang_arrow: {
    name: '飞蝗箭', profession: 'archer', kind: 'volley', range: 420, radius: 36, attackType: 'timed_point_bomb',
    projectileKey: 'arrow', projectileSpeed: 1000, cooldownMs: 1000, iconPath: 'skills/bow_skill_r00_c01/spriteFrame', chargeBonus: 35,
    damage: (l) => 90 + 2 * l, cost: (l) => 20 + 2 * lv(l), native: true,
    description: '按住技能键蓄力，松开后朝鼠标方向射出扇形箭雨。',
  },
  hunter_baibu: {
    name: '百步穿杨', profession: 'archer', kind: 'first', range: 600, radius: 22, attackType: 'first_hit_projectile',
    projectileKey: 'arrow', projectileSpeed: 1600, cooldownMs: 1200, iconPath: 'skills/bow_skill_r00_c00/spriteFrame', chargeBonus: 60,
    damage: (l) => 150 + 3 * l, cost: (l) => 18 + lv(l),
    description: '精确选点，蓄力后射出一支穿云箭，命中路径上第一个敌人。',
  },
  // 追魂箭 (eighth batch, Sky's design): the arrow seeks the enemy nearest the aim point;
  // the search radius and the damage grow with the level. No enemy there: it flies
  // to the aim point and misses (the stamina is still spent).
  hunter_zhuihun: {
    name: '追魂箭', profession: 'archer', kind: 'seek', range: 550, radius: 120, attackType: 'first_hit_projectile',
    projectileKey: 'arrow', projectileSpeed: 900, cooldownMs: 1200, iconPath: 'skills/bow_skill_r02_c02/spriteFrame',
    searchRadius: (l) => Math.round(120 + (lv(l) - 1) * 4.5),
    damage: (l) => 120 + 2 * l, cost: (l) => 16 + lv(l),
    description: '朝鼠标位置射出追魂箭，自动追向落点附近最近的敌人；技能等级越高，搜索范围越大。',
  },
  mage_ice_shockwave: {
    name: '寒冰冲击波', profession: 'mage', kind: 'line', range: 630, radius: 56, attackType: 'piercing_trail_bomb',
    projectileKey: 'bingbao', projectileSpeed: 320, cooldownMs: 600, iconPath: 'skills/magic_skill02_r00_c00/spriteFrame',
    damage: (l) => 150 + 2 * l, cost: (l) => 26 + Math.ceil(lv(l) / 2), native: true,
    description: '向前释放寒冰冲击波，沿冲击路径连续造成范围伤害。',
  },
  mage_fireball: {
    name: '大火球', profession: 'mage', kind: 'point', range: 630, radius: 100, attackType: 'timed_point_bomb',
    projectileKey: 'huoqiu', projectileSpeed: 720, cooldownMs: 600, iconPath: 'skills/magic_skill02_r01_c00/spriteFrame',
    damage: (l) => 150 + 2 * l, cost: (l) => 32 + lv(l), native: true,
    description: '凝聚火焰后射出火球，到达目标点时造成范围爆炸伤害。',
  },
  mage_ice_arrow: {
    name: '冰箭术', profession: 'mage', kind: 'first', range: 360, radius: 24, attackType: 'first_hit_projectile',
    projectileKey: 'bingjian', projectileSpeed: 1800, cooldownMs: 500, iconPath: 'skills/magic_skill01_r00_c00/spriteFrame',
    damage: (l) => 110 + 2 * l, cost: (l) => 8 + Math.floor(l / 2),
    description: '射出一支冰箭，命中路径上第一个敌人。',
  },
  mage_small_fireball: {
    name: '小火球术', profession: 'mage', kind: 'first', range: 360, radius: 24, attackType: 'first_hit_projectile',
    projectileKey: 'mage_firebolt', projectileSpeed: 1500, cooldownMs: 500, iconPath: 'skills/magic_skill01_r01_c00/spriteFrame',
    damage: (l) => 120 + 2 * l, cost: (l) => 10 + Math.floor(l / 2),
    description: '射出一枚小火球，命中路径上第一个敌人。',
  },
  mage_lightning_bolt: {
    name: '闪电术', profession: 'mage', kind: 'point', range: 400, radius: 40, attackType: 'timed_point_bomb',
    projectileKey: 'none', projectileSpeed: 0, impactDelayMs: 100, cooldownMs: 700, iconPath: 'skills/magic_skill01_r00_c01/spriteFrame',
    damage: (l) => 130 + 2 * l, cost: (l) => 12 + Math.floor(l / 2),
    description: '召唤闪电劈向目标地点。',
  },
  mage_heal: {
    name: '治愈术', profession: 'mage', kind: 'heal', targetMode: 'ally', range: 300, attackType: 'heal', cooldownMs: 2000,
    projectileKey: 'none', projectileSpeed: 0, iconPath: 'skills/magic_skill01_r01_c01/spriteFrame',
    heal: (l) => 30 + 8 * l, cost: (l) => 15 + Math.floor(l / 2),
    description: '为自己或附近受伤的玩家恢复生命。',
  },
  mage_lightning_star: {
    name: '雷星术', profession: 'mage', kind: 'nova', targetMode: 'self', range: 0, radius: 170, attackType: 'radial_nova',
    projectileKey: 'none', projectileSpeed: 0, impactDelayMs: 300, cooldownMs: 3000, iconPath: 'skills/magic_skill02_r02_c00/spriteFrame',
    damage: (l) => 140 + 3 * l, cost: (l) => 30 + lv(l),
    description: '以自身为中心降下雷星，对周围敌人造成雷系伤害。',
  },
  gunner_point_shot: {
    name: '点射', profession: 'gunner', kind: 'burst', range: 500, radius: 38, count: () => 3, intervalMs: 100, attackType: 'timed_point_bomb',
    projectileKey: 'gunbullet', projectileSpeed: 1800, cooldownMs: 700, iconPath: 'skills/gun_skill_r01_c00/spriteFrame',
    damage: (l) => 110 + l, cost: (l) => 10 + lv(l), native: true,
    description: '瞄准一个地点连续射出三发子弹，对该地点造成连续爆炸伤害。',
  },
  gunner_scatter_shot: {
    name: '霰射技', profession: 'gunner', kind: 'pellets', range: 400, radius: 24, spreadDeg: 60, attackType: 'timed_point_bomb',
    projectileKey: 'sanbullet', projectileSpeed: 1000, cooldownMs: 900, iconPath: 'skills/san_skill_r00_c00/spriteFrame',
    count: (l) => { const e = lv(l); return e >= 41 ? 13 : e >= 37 ? 11 : e >= 36 ? 10 : e >= 33 ? 9 : e >= 30 ? 8 : e >= 28 ? 7 : e >= 25 ? 6 : e >= 22 ? 5 : e >= 14 ? 4 : 3; },
    damage: (l) => 70 + l, cost: (l) => 20 + 2 * lv(l), native: true,
    description: '向前方扇形射出多发霰弹，对飞行路径上的敌人持续造成伤害。',
  },
  child_poison_cast: {
    name: '毒雾术', profession: 'child', kind: 'point', range: 420, radius: 100, lockOn: true, attackType: 'timed_point_bomb',
    projectileKey: 'poison', projectileSpeed: 3000, cooldownMs: 1500, iconPath: 'skills/drug_r00_c01/spriteFrame',
    damage: (l) => 100 + 2 * l, cost: (l) => 5 + Math.floor(l / 4), impactPhase: true,
    description: '宝宝天生的技能：朝目标吐出一大团毒雾，伤害范围内的所有敌人。瞄准怪物附近会自动对准它。',
  },
  child_super_scatter: {
    name: '超级乱射', profession: 'child', kind: 'orbit', targetMode: 'self', range: 320, radius: 20, count: () => 6, attackType: 'self_buff',
    projectileKey: 'stone', projectileSpeed: 900, cooldownMs: 8000, iconPath: 'skills/gun_skill_r01_c00/spriteFrame',
    damage: (l) => 60 + 2 * l, cost: (l) => 10 + Math.floor(l / 4), echoToCaster: true,
    description: '宝宝天生的技能：身边环绕石子，依次射向附近的怪物。',
  },
};
for (const [id, s] of Object.entries(SKILLS)) s.id = id;

// Books that teach skills (item id -> skill), including the books the
// complete-catalog patch adds to the shop.
const BOOKS = {
  301: 'hunter_baibu', 302: 'hunter_jinshot', 303: 'hunter_feihuang_arrow', 304: 'hunter_zhuihun',
  311: 'warrior_jianqi', 1801: 'warrior_charge', 900101: 'warrior_rage', 900102: 'warrior_gangqi',
  321: 'mage_ice_arrow', 322: 'mage_small_fireball', 323: 'mage_lightning_bolt', 324: 'mage_heal',
  325: 'mage_ice_shockwave', 326: 'mage_fireball', 327: 'mage_lightning_star',
  352: 'gunner_point_shot', 353: 'gunner_scatter_shot',
};
const BIRTH_SKILLS = { child: ['child_poison_cast', 'child_super_scatter'] };
// Skills a profession learns by itself once the character reaches a combat level.
const LEVEL_SKILLS = { mage: [[10, 'mage_lightning_bolt'], [10, 'mage_heal']] };

function skillNextExp(level) { return 20 + level * 15; }

function levelDescription(s, l) {
  if (s.levelText) return s.levelText(l);
  const parts = ['技能等级 ' + l];
  if (s.damage) parts.push('造成普通攻击 ' + s.damage(l) + '% 的伤害' + (s.count ? '，共 ' + s.count(l) + ' 发' : ''));
  if (s.searchRadius) parts.push('落点周围 ' + s.searchRadius(l) + ' 像素内自动追踪最近的敌人');
  if (s.heal) parts.push('恢复 ' + s.heal(l) + ' 点生命');
  if (s.attackPercent) parts.push('攻击力提高 ' + s.attackPercent(l) + '%，持续 ' + s.buffDurationMs / 1000 + ' 秒');
  if (s.defensePercent) parts.push('受到伤害减少 ' + s.defensePercent(l) + '%，持续 ' + s.buffDurationMs / 1000 + ' 秒');
  parts.push('消耗 ' + s.cost(l) + ' 点精力' + (s.range ? '，射程 ' + s.range + ' 像素' : '') + '，最高 ' + MAX_LEVEL + ' 级');
  return parts.join('\n');
}

// The params entry for one learned skill.
function describe(id, state) {
  const s = SKILLS[id];
  const level = lv(state && state.level);
  const exp = (state && state.exp) || 0;
  const out = { id, level, exp, nextLevelExp: level >= MAX_LEVEL ? 0 : skillNextExp(level) };
  if (!s) return out;
  return Object.assign(out, {
    name: s.name, profession: s.profession, description: s.description, levelDescription: levelDescription(s, level),
    iconPath: s.iconPath, mpCost: s.cost(level), range: s.range || 0, minRange: s.minRange || 0, targetMode: s.targetMode || 'aim',
    attackType: s.attackType, projectileKey: s.projectileKey || 'none', projectileSpeed: s.projectileSpeed || 0,
    aoeRadius: s.searchRadius ? s.searchRadius(level) : s.radius || 0, impactDelayMs: s.impactDelayMs || 0, pelletCount: s.count ? s.count(level) : 0,
    cooldownMs: s.cooldownMs || 0, buffDurationMs: s.buffDurationMs || 0, maxLevel: MAX_LEVEL,
  });
}

module.exports = { SKILLS, BOOKS, BIRTH_SKILLS, LEVEL_SKILLS, MAX_LEVEL, describe, skillNextExp, normalizeLevel: lv };
