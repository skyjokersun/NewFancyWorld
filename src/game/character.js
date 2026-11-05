'use strict';
// Character model: persistent record, derived combat stats and the `params`
// document the client renders in its attribute / inventory panels.
const { protocol, getTemplate, slotForTemplate, EQUIP_SLOTS, requirementOf } = require('./catalog');
const SKILL_DEFS = require('./skills-data');

const INV_COLS = 5;
const INV_ROWS = 8;
const INV_SIZE = INV_COLS * INV_ROWS;
const LEVEL_CAP = 999;
const SKILL_LEVEL_CAP = 200;
const COMBAT_SKILL_IDS = ['ranged_weapon', 'melee_weapon', 'mechanics', 'magic', 'quick_heal', 'judgement'];
const PROFESSION_LABELS = protocol.PROFESSION_LABELS;
const COMBAT_PROFESSIONS = new Set(['warrior', 'archer', 'mage', 'gunner']);
const WALK_SPEED = 120;
const RUN_SPEED = 190;
const OVERWEIGHT_SPEED_FACTOR = 0.5;

// Same per-level requirement the attribute panel uses for "remaining exp".
function levelUpRequirement(level) {
  const e = Math.trunc(level);
  if (!Number.isFinite(e) || e <= 1) return 0;
  if (e <= 652) return 50 * (e - 1);
  if (e === 653) return 65200;
  if (e <= 700) return 65300 + 100 * (e - 654);
  if (e <= 750) return 70050 + 150 * (e - 701);
  if (e <= 800) return 77600 + 200 * (e - 751);
  if (e <= 850) return 87650 + 250 * (e - 801);
  if (e <= 900) return 100200 + 300 * (e - 851);
  if (e <= 950) return 115250 + 350 * (e - 901);
  return 132800 + 400 * (e - 951);
}
const cumulative = [0, 0];
for (let l = 2; l <= LEVEL_CAP + 1; l += 1) cumulative[l] = cumulative[l - 1] + levelUpRequirement(l);
function cumulativeExpForLevel(level) { return cumulative[Math.max(1, Math.min(LEVEL_CAP + 1, Math.floor(level)))]; }
function levelForExp(exp) {
  let lo = 1, hi = LEVEL_CAP;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cumulative[mid] <= exp) lo = mid; else hi = mid - 1; }
  return lo;
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function normalizeGender(g) { return g === 'man' ? 'man' : 'women'; }

function normalizeAppearance(a, fallbackModel = 'baby_1') {
  const d = protocol.DEFAULT_PLAYER_APPEARANCE;
  const src = a || {};
  return {
    hairColor: clampInt(src.hairColor, 0, 15, d.hairColor),
    skinColor: clampInt(src.skinColor, 0, 7, d.skinColor),
    clothColor: clampInt(src.clothColor, 0, 15, d.clothColor),
    accessoryColor: clampInt(src.accessoryColor, 0, 15, d.accessoryColor),
    portraitId: clampInt(src.portraitId, 0, 63, d.portraitId),
    gender: normalizeGender(src.gender || d.gender),
    model: typeof src.model === 'string' && /^[a-z0-9_]{1,32}$/.test(src.model) ? src.model : fallbackModel,
  };
}

// Models each gender can wear (the client's PlayerModelCatalog). A model of the other
// gender makes the client load walk and fight sheets from different models.
const GENDER_MODELS = {
  man: ['baby_1', 'baby_shot', 'boy', 'boy_high', 'boy_shot', 'gardener', 'gent', 'magic', 'man', 'man_fat', 'man_hunt', 'man_strong', 'new_hunt', 'new_visualize01', 'new_visualize02', 'new_visualize03', 'new_visualize04', 'new_visualize05', 'new_visualize06', 'new_visualize07', 'new_visualize08', 'newmagic', 'newwarrior', 'togae', 'warrior', 'workman', 'workman_fat'],
  women: ['baby_1', 'baby_shot', 'gardener', 'girl', 'girl_fat', 'girl_high', 'girl_hunt', 'girl_shot', 'lady', 'magic', 'new_hunt', 'new_visualize01', 'new_visualize02', 'new_visualize03', 'new_visualize04', 'new_visualize05', 'new_visualize06', 'new_visualize07', 'new_visualize08', 'newmagic', 'newwarrior', 'togae', 'warrior', 'woman', 'woman_wonder', 'workman', 'workman_fat'],
};
// The model to wear for a profession and gender: the current one when it fits both,
// else the first of the profession's models that the gender has.
function modelFor(profession, gender, current) {
  const byProf = protocol.PROFESSION_MODEL_OPTIONS[profession] || [];
  const byGender = GENDER_MODELS[normalizeGender(gender)];
  const fits = (m) => (!byProf.length || byProf.includes(m)) && byGender.includes(m);
  if (current && fits(current)) return current;
  return byProf.find((m) => byGender.includes(m)) || byProf[0] || current;
}

// Party HUD patch: an uploaded portrait (data URL, <= 64 KB after client-side
// compression). Kept off ch.appearance so it is not sent in every actor sync.
const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
function normalizeCustomAvatar(v) {
  return typeof v === 'string' && v.length <= 96 * 1024 && AVATAR_RE.test(v) ? v : null;
}
function appearanceWithAvatar(ch) {
  const a = Object.assign({}, ch.appearance);
  if (ch.customAvatar) a.customAvatar = ch.customAvatar;
  return a;
}

function newCharacter({ id, accountId, world, name, appearance, spawn, mapRef }) {
  return {
    id, accountId, world, name,
    createdAt: Date.now(),
    appearance: normalizeAppearance(appearance, 'baby_1'),
    profession: 'child',
    alignment: 0,
    reputation: 0,
    title: '',
    mapRef, x: spawn.x, y: spawn.y,
    gold: 500,
    combatExp: 0,
    professionExp: {},
    communityExp: 0,
    skillPoints: 0,
    spentSkillPoints: 0,
    combatSkills: Object.fromEntries(COMBAT_SKILL_IDS.map((s) => [s, 0])),
    professionSkills: {},
    hp: null, stamina: null,
    movementMode: 'walk',
    inventory: new Array(INV_SIZE).fill(null),
    equipment: Object.fromEntries(EQUIP_SLOTS.map((s) => [s, null])),
    itemSeq: 0,
    revision: 1,
    allowIncomingTrades: true,
    playSeconds: 0,
    cardPuzzle: null,
  };
}

// A locked combat level (ch.combatLevelLock) stays put while EXP keeps
// accumulating; the player raises it by hand with /levelup (features/levellock.js).
function combatLevel(ch) {
  const lvl = levelForExp(ch.combatExp || 0);
  return Number.isInteger(ch.combatLevelLock) ? Math.min(lvl, Math.max(1, ch.combatLevelLock)) : lvl;
}
// One skill point per combat level gained, however the level was reached
// (hunting, /levelup, /level, the admin page). levelPointsGranted is the level
// already paid for. Only GM tools lower a level; the points stay, and the
// paid-for mark follows the level down so levelling up again pays as usual.
// Characters from before this field get the points they are short credited once.
function levelSkillPoints(p2, rng = Math.random) {
  return rng() < p2 ? 3 : 2;
}
// Spent plus unspent combat skill points never go past this.
const SKILL_POINT_TOTAL_CAP = 1200;
function spentSkillPoints(ch) { return Object.values(ch.combatSkills || {}).reduce((n, v) => n + (Number(v) || 0), 0); }
function skillPointRoom(ch) { return Math.max(0, SKILL_POINT_TOTAL_CAP - spentSkillPoints(ch) - (ch.skillPoints || 0)); }
// Adds up to n points within the cap; returns how many were added.
function addSkillPoints(ch, n) {
  const add = Math.max(0, Math.min(n, skillPointRoom(ch)));
  ch.skillPoints = (ch.skillPoints || 0) + add;
  return add;
}
function settleLevelPoints(ch) {
  const earned = combatLevel(ch) - 1;
  if (!Number.isInteger(ch.levelPointsGranted)) {
    const spent = spentSkillPoints(ch);
    ch.levelPointsGranted = Math.max(0, Math.min(earned, (ch.skillPoints || 0) + spent));
  }
  if (earned < ch.levelPointsGranted) ch.levelPointsGranted = earned;
  if (earned <= ch.levelPointsGranted) return 0;
  const levels = earned - ch.levelPointsGranted;
  // Each level pays at least 2 points; 运气 x 3% (at most 60%) is the chance of a
  // third. 运气 8 averages about 2.24 a level. Nothing past the 1200 point cap.
  const p2 = Math.min(0.6, computeStats(ch).core.luck * 0.03);
  let n = 0;
  for (let i = 0; i < levels; i += 1) n += levelSkillPoints(p2);
  ch.levelPointsGranted = earned;
  return addSkillPoints(ch, n);
}
function professionLevel(ch, prof = ch.profession) { return levelForExp((ch.professionExp && ch.professionExp[prof]) || 0); }

function equipmentBonuses(ch) {
  const b = {};
  for (const slot of EQUIP_SLOTS) {
    const it = ch.equipment[slot];
    if (!it) continue;
    if (it.durability && !it.durability.infinite && it.durability.cur <= 0) continue;
    // Worn but no longer allowed (left on because the bag was full): no effect at all.
    if (!meetsRequirement(ch, it)) continue;
    for (const a of it.bonusAttrs || []) b[a.key] = (b[a.key] || 0) + (Number(a.value) || 0);
  }
  return b;
}

// Whether this character may wear the item (profession, profession level, combat level).
// Sealed items fit nobody; 'any' asks every profession for that profession level.
// Twelfth batch (Q23): equipment tags. An item's tags are its own list (admin page) or
// the professions its requirement names; a profession may wear the tags it lists
// (admin page) or, by default, its own id. One match is enough. Items without tags
// fit everyone. With no admin tags anywhere this gives exactly the old result.
let professionTags = {};
function setProfessionTags(o) { professionTags = o || {}; }
// Admin-made professions (features/professions.js): a character keeps its base
// profession for the client and carries ch.customProfession for tags and formulas.
let customProfessions = {};
function setCustomProfessions(o) { customProfessions = o || {}; }
function customProfessionOf(ch) {
  const c = ch && ch.customProfession && customProfessions[ch.customProfession];
  return c && c.base === ch.profession ? c : null;
}
// The model to wear: an admin-made profession's uploaded model (u_...), else as modelFor.
function modelForCharacter(ch) {
  // Fifteenth batch: a green-gift transform shows a monster's look until it runs out.
  if (ch.transform && ch.transform.model && ch.transform.until > Date.now()) return ch.transform.model;
  const c = customProfessionOf(ch);
  if (c && c.model) return c.model;
  return modelFor(ch.profession, ch.appearance.gender, ch.appearance.model);
}
function tagKey(ch) { const c = customProfessionOf(ch); return c ? c.id : ch.profession; }
function professionTagsOf(prof) { return Array.isArray(professionTags[prof]) && professionTags[prof].length ? professionTags[prof].slice() : [prof]; }
function meetsRequirement(ch, item) {
  const r = requirementOf(item);
  if (!r) return true;
  // Fifteenth batch: the 封印的火枪 handed out by 米索莉 is unsealed for gunners.
  if (r.sealed) return require('../features/batch15').Batch15.gunAllowed(ch, item);
  if (Number.isFinite(r.combatLevel) && combatLevel(ch) < r.combatLevel) return false;
  const tpl = getTemplate(item && item.itemId);
  const key = tagKey(ch);
  if ((tpl && Array.isArray(tpl.tags)) || professionTags[key]) {
    const tags = tpl && Array.isArray(tpl.tags) ? tpl.tags : ((r.professionLevels || []).map((e) => e && e.profession).filter((p) => p && p !== 'any'));
    const mineTags = professionTagsOf(key);
    if (tags.length && !tags.some((g) => mineTags.includes(g))) return false;
    let need = tpl && Number.isFinite(tpl.tagMinLevel) ? tpl.tagMinLevel : 0;
    if (!(tpl && Number.isFinite(tpl.tagMinLevel))) {
      for (const e of r.professionLevels || []) if (e && (e.profession === 'any' || mineTags.includes(e.profession) || e.profession === ch.profession)) need = Math.max(need, e.minLevel || 0);
    }
    return professionLevel(ch) >= need;
  }
  const all = (r.professionLevels || []).filter((e) => e && e.profession);
  const any = all.find((e) => e.profession === 'any');
  if (any && professionLevel(ch) < (any.minLevel || 0)) return false;
  const list = all.filter((e) => e.profession !== 'any');
  if (!list.length) return true;
  const mine = list.find((e) => e.profession === ch.profession);
  return !!mine && professionLevel(ch) >= (mine.minLevel || 0);
}

// After a job change (or a level set lower by hand): worn items the character no
// longer qualifies for go back to the bag. Returns { inv, equip, moved, stuck }.
function unequipUnfit(ch) {
  const out = { inv: [], equip: [], moved: [], stuck: [] };
  for (const slot of EQUIP_SLOTS) {
    const it = ch.equipment[slot];
    if (!it || meetsRequirement(ch, it)) continue;
    const free = ch.inventory.findIndex((x) => !x);
    if (free < 0) { out.stuck.push(it.name); continue; }
    ch.inventory[free] = it; ch.equipment[slot] = null;
    out.inv.push(free); out.equip.push(slot); out.moved.push(it.name);
  }
  return out;
}

function inventoryWeight(ch) {
  let w = 0;
  for (const it of ch.inventory) if (it) w += (it.weight || 0) * (it.count || 1);
  for (const slot of EQUIP_SLOTS) { const it = ch.equipment[slot]; if (it) w += it.weight || 0; }
  return w;
}

// Core attributes (力量 敏捷 感知 聪明 运气) are a fixed spread of 34 points that comes
// with the profession and changes only with a job change. Equipment still applies on
// top. The admin page can change each profession's spread (setAttrSpreads).
const CORE_KEYS = ['strength', 'agility', 'perception', 'intelligence', 'luck'];
const ATTR_SPREAD = {
  child: [7, 7, 7, 7, 6],
  warrior: [10, 10, 3, 3, 8],
  archer: [3, 10, 10, 3, 8],
  gunner: [8, 10, 3, 10, 3],
  mage: [3, 7, 10, 10, 4],   // twelfth batch: the original mage attack uses 聪明 x 感知
  craftsman: [10, 10, 3, 3, 8],
  gardener: [3, 3, 10, 10, 8],
};
const attrSpreadOverride = {};
// The formula set in use (game/formulas.js); null = the web rules below.
let formulaSet = null;
function setFormulaSet(set) { formulaSet = set || null; }
function setAttrSpreads(o) {
  for (const k of Object.keys(attrSpreadOverride)) delete attrSpreadOverride[k];
  Object.assign(attrSpreadOverride, o || {});
}
function attrSpread(profession) {
  const v = attrSpreadOverride[profession] || ATTR_SPREAD[profession] || ATTR_SPREAD.child;
  return Object.fromEntries(CORE_KEYS.map((k, i) => [k, v[i]]));
}

// Hidden growth per combat level, weighted by profession. It used to raise the
// attributes themselves; now it goes straight into life, attack and the other
// derived values, so a character is as strong as before at every level.
const ATTR_GROWTH = {
  child: { strength: 1, agility: 1, perception: 1, intelligence: 1, luck: 1 },
  warrior: { strength: 3, agility: 1, perception: 0.5, intelligence: 0.2, luck: 0.3 },
  archer: { strength: 1, agility: 3, perception: 1, intelligence: 0.2, luck: 0.3 },
  mage: { strength: 0.3, agility: 0.7, perception: 1, intelligence: 3, luck: 0.5 },
  gunner: { strength: 1, agility: 2, perception: 2, intelligence: 0.3, luck: 0.4 },
  craftsman: { strength: 2, agility: 1, perception: 1, intelligence: 1, luck: 0.5 },
  gardener: { strength: 1, agility: 1, perception: 1, intelligence: 1.5, luck: 1 },
};

const WARRIOR_MELEE_RANGE = 120;
function warriorHoldsBow(ch) {
  const w = ch.equipment && ch.equipment.weapon;
  const t = w && getTemplate(w.itemId);
  return !!t && /弓/.test(t.name) && meetsRequirement(ch, w);
}

// Values the admin page can change (settings.js).
const tuning = {
  warriorRange: 0,
  attackSpeedCap: 1,   // highest speed agility can give (1 = agility does not speed attacks)
  cloudStatPercent: 5, cloudSpeed: 20, carpetSpeedPercent: 50,
  overweightSpeedPercent: 50,   // overweight walk speed, % of the normal walk
  hpGrowthMode: 0, hpLevel1: 100,   // base life rules, see naturalHp
};
function setTuning(t) { Object.assign(tuning, t); }

// Base life (fourteenth batch, admin setting 生命成长方式):
//  0 网页版: the old web rule in computeStats / the formula set (nothing here).
//  1 原版逐级: like 天使之城 (2004): every combat level up adds 3*力量 + 1.5*敏捷 of the
//    profession held at that moment (high) or 80% of it (low); 运气 sets the chance of
//    the high one. The gains are kept on the character (ch.hpGrowth), so a later job
//    change does not take them back.
//  2 按当前等级职业: the same numbers as an average (0.8 + 0.2 * high chance) for the
//    current profession, worked out again from the current level, so changing
//    profession changes the base life at once.
// 力量 / 敏捷 / 运气 are the profession's own five attributes (职业属性 page), without
// gear. Level 1 starts at the admin setting hpLevel1. The luck chance follows the
// published 天使之城 figures (运气 3 ~ 10%, 8 ~ 70%): 12% a point above 2, 2-95%.
function hpGrowthNumbers(profession) {
  const sp = attrSpread(profession);
  const high = 3 * sp.strength + 1.5 * sp.agility;
  const pHigh = Math.max(0.02, Math.min(0.95, 0.12 * (sp.luck - 2)));
  return { high, low: 0.8 * high, pHigh };
}
function averageHp(profession, lvl) {
  const n = hpGrowthNumbers(profession);
  return Math.round((Number(tuning.hpLevel1) || 100) + (lvl - 1) * n.high * (0.8 + 0.2 * n.pHigh));
}
function naturalHp(ch, lvl) {
  const mode = Number(tuning.hpGrowthMode) || 0;
  if (mode === 2) return averageHp(ch.profession, lvl);
  if (mode !== 1) return null;
  let g = ch.hpGrowth;
  // First time (or the level went down on the admin page): start from the average.
  if (!g || typeof g !== 'object' || !(g.level >= 1) || g.level > lvl || !Number.isFinite(g.hp)) {
    g = ch.hpGrowth = { level: lvl, hp: averageHp(ch.profession, lvl) };
  }
  while (g.level < lvl) {
    const n = hpGrowthNumbers(ch.profession);
    g.level += 1;
    g.hp += Math.round(Math.random() < n.pHigh ? n.high : n.low);
  }
  return g.hp;
}

// Normal attack rhythm and reach per weapon (sixth/seventh batch): the time from one
// normal attack to the next at attack speed 1 (the client plays the whole swing in
// that time, so there is no idle recovery), and how far it reaches.
const WEAPON_STYLE = {
  warrior_sword: { attackIntervalMs: 900, attackRange: WARRIOR_MELEE_RANGE },
  warrior_bow: { attackIntervalMs: 1100, attackRange: 400 },
  archer_bow: { attackIntervalMs: 1000, attackRange: 430 },
  mage_staff: { attackIntervalMs: 1100, attackRange: 380 },
  gunner_gun: { attackIntervalMs: 800, attackRange: 460 },
  child_stone: { attackIntervalMs: 1000 },
  default: { attackIntervalMs: 1000 },
};

function combatProfileFor(ch) {
  const p = combatProfileBase(ch);
  p.attackIntervalMs = (WEAPON_STYLE[p.styleId] || WEAPON_STYLE.default).attackIntervalMs;
  return p;
}
function combatProfileBase(ch) {
  const prof = ch.profession;
  const model = ch.appearance.model;
  const range = protocol.MODEL_BASE_ATTACK_RANGE[model] || 300;
  switch (prof) {
    case 'archer':
      return { styleId: 'archer_bow', styleName: '弓箭', attackMode: 'ranged', normalAttackType: 'ranged_lock_on', groundAttackType: 'timed_point_bomb', packetFrame: 6, projectileKey: 'arrow', projectileSpeed: 1100, attackRange: WEAPON_STYLE.archer_bow.attackRange };
    case 'mage':
      return { styleId: 'mage_staff', styleName: '法杖', attackMode: 'ranged', normalAttackType: 'ranged_lock_on', groundAttackType: 'timed_point_bomb', packetFrame: 6, projectileKey: 'bingjian', projectileSpeed: 900, attackRange: WEAPON_STYLE.mage_staff.attackRange };
    case 'gunner':
      return { styleId: 'gunner_gun', styleName: '枪械', attackMode: 'ranged', normalAttackType: 'ranged_lock_on', groundAttackType: 'first_hit_projectile', packetFrame: 5, projectileKey: 'bullet', projectileSpeed: 1500, attackRange: WEAPON_STYLE.gunner_gun.attackRange };
    case 'warrior': {
      // A warrior fights with what it holds: a bow shoots arrows from afar, a blade
      // (or bare hands, which count as a knife) strikes up close. The admin setting
      // warriorRange replaces the melee reach when not 0.
      if (warriorHoldsBow(ch)) return { styleId: 'warrior_bow', styleName: '弓箭', attackMode: 'ranged', normalAttackType: 'ranged_lock_on', groundAttackType: 'first_hit_projectile', packetFrame: 6, projectileKey: 'arrow', projectileSpeed: 1100, attackRange: WEAPON_STYLE.warrior_bow.attackRange };
      return { styleId: 'warrior_sword', styleName: '刀剑', attackMode: 'melee', normalAttackType: 'ranged_lock_on', groundAttackType: 'ranged_lock_on', packetFrame: 6, projectileKey: 'none', projectileSpeed: 900, attackRange: tuning.warriorRange > 0 ? tuning.warriorRange : WARRIOR_MELEE_RANGE };
    }
    case 'child':
      // Kids throw stones (the client has a dedicated launch offset and the "stone" projectile).
      return { styleId: 'child_stone', styleName: '石子', attackMode: 'ranged', normalAttackType: 'ranged_lock_on', groundAttackType: 'ranged_lock_on', packetFrame: 6, projectileKey: 'stone', projectileSpeed: 700, attackRange: range };
    default:
      return { styleId: 'default', styleName: 'default', attackMode: 'melee', normalAttackType: 'ranged_lock_on', groundAttackType: 'ranged_lock_on', packetFrame: 6, projectileKey: 'none', projectileSpeed: 900, attackRange: 110 };
  }
}

// Derived stats. Cached on the runtime player and recomputed on change.
// Bare attack and break power (the original game's formulas): profession level times
// a product of the locked core attributes. Craftsmen use the warrior's, gardeners and
// kids the kid's (which is the same).
function bareAttackBreak(prof, plvl, c) {
  const S = c.strength, A = c.agility, P = c.perception, I = c.intelligence;
  switch (prof) {
    case 'archer': return [plvl * (A * P * 0.1 + P), plvl * (A * P * 0.1 + A)];
    case 'gunner': return [plvl * (A * I * 0.1 + I), plvl * (A * I * 0.1 + A)];
    case 'mage': return [plvl * ((P * I * 0.1 + I) * 2), 0];
    default: return [plvl * (S * A * 0.1 + A), plvl * (S * A * 0.1 + S)];
  }
}

// The combat skill line that raises a character's damage, 2% a point.
function weaponSkillOf(prof, profile) {
  if (prof === 'mage') return 'magic';
  if (prof === 'gunner') return 'mechanics';
  return profile.attackMode === 'ranged' ? 'ranged_weapon' : 'melee_weapon';
}

// The mount a character is riding, if it still has it: 'cloud' (筋斗云, ch.mounts.cloudUntil)
// or 'carpet' (飞毯, the angel blessing).
function ownsMount(ch, kind, now = Date.now()) {
  if (kind === 'cloud') return !!(ch.mounts && ch.mounts.cloudUntil > now);
  if (kind === 'carpet') {
    const b = ch.cardPuzzle && ch.cardPuzzle.angelBlessing;
    return !!(b && b.wishId === 'angel_carpet' && b.expiresAt > now);
  }
  return false;
}
function mountExpiresAt(ch, kind) {
  if (kind === 'cloud') return (ch.mounts && ch.mounts.cloudUntil) || 0;
  const b = ch.cardPuzzle && ch.cardPuzzle.angelBlessing;
  return b && b.wishId === 'angel_carpet' ? b.expiresAt : 0;
}
function ridingMount(ch, now = Date.now()) {
  const r = ch.mounts && ch.mounts.riding;
  return r && ownsMount(ch, r, now) ? r : null;
}

// Derived stats. Cached on the runtime player and recomputed on change.
function computeStats(ch) {
  const lvl = combatLevel(ch);
  const plvl = professionLevel(ch);
  const g = ATTR_GROWTH[ch.profession] || ATTR_GROWTH.child;
  const eq = equipmentBonuses(ch);
  const spread = attrSpread(ch.profession);
  const core = {}; const eff = {};
  for (const k of CORE_KEYS) {
    core[k] = Math.max(0, spread[k] + (eq[k] || 0));
    eff[k] = core[k] + Math.floor((lvl - 1) * g[k] + plvl * 0.5);
  }
  const skills = ch.combatSkills || {};
  const prof = ch.profession;
  const profile = combatProfileFor(ch);
  const cpd = ch.cardPuzzle || {};
  const blessing = cpd.angelBlessing && cpd.angelBlessing.expiresAt > Date.now() ? cpd.angelBlessing.wishId : null;
  const mount = ridingMount(ch);
  // Riding 筋斗云: attack, break, defense, life, stamina and their regeneration +5%
  // (admin cloudStatPercent), on top of everything else.
  const cloud = mount === 'cloud' ? 1 + (tuning.cloudStatPercent || 0) / 100 : 1;
  let maxHp = 100 + (lvl - 1) * 18 + eff.strength * 3 + (eq.maxHp || 0) + (cpd.bonusMaxHp || 0);
  maxHp = Math.round(maxHp * (1 + (eq.maxHpPercent || 0) / 100) * cloud);
  let maxStamina = 60 + (lvl - 1) * 6 + eff.intelligence * 2 + (eq.maxStamina || 0) + (cpd.bonusMaxStamina || 0);
  maxStamina = Math.round(maxStamina * (1 + (eq.maxStaminaPercent || 0) / 100) * cloud);
  const [bareAttack, bareBreak] = bareAttackBreak(prof, plvl, core);
  // Gear like 苍穹战甲 (远程+45) adds points to a combat skill: bonus key skill_<id>.
  const weaponSkillId = weaponSkillOf(prof, profile);
  const weaponSkill = (skills[weaponSkillId] || 0) + (eq['skill_' + weaponSkillId] || 0);
  let attack = Math.round((bareAttack + (eq.attack || 0)) * (1 + weaponSkill * 0.02) * cloud);
  let breakPower = Math.round((bareBreak + (eq.breakPower || 0)) * cloud);
  let defense = Math.round((lvl * 1.2 + eff.agility * 0.5 + (eq.defense || 0)) * (blessing === 'angel_defense' ? 1.3 : 1) * cloud);
  let maxWeight = 100 + eff.strength * 3 + lvl * 2;
  let overLine = maxWeight;
  // Twelfth batch: an admin formula set (原版 or a custom one) replaces the web rules.
  const fset = formulaSet;
  let fv = null;
  if (fset) {
    const F = require('./formulas');
    const weapon = ch.equipment && ch.equipment.weapon;
    const WT = weapon ? F.weaponType(weapon.itemId) : -1;
    const sk = WT >= 0 ? F.WEAPON_SKILL[WT] : null;
    const K = sk ? (skills[sk] || 0) + (eq['skill_' + sk] || 0) : 0;
    const vars = {
      S: core.strength, A: core.agility, P: core.perception, I: core.intelligence, U: core.luck, LV: lvl, J: plvl,
      EA: eq.attack || 0, EB: eq.breakPower || 0, ED: eq.defense || 0, EHP: (eq.maxHp || 0) + (cpd.bonusMaxHp || 0), EMP: (eq.maxStamina || 0) + (cpd.bonusMaxStamina || 0),
      HPP: eq.maxHpPercent || 0, MPP: eq.maxStaminaPercent || 0, ASP: eq.attackSpeedPercent || 0,
      K, WT, WM: WT < 0 ? 1 : WT === 4 ? (50 + K) / 25 : (50 + K) / 50, CAP: Math.max(1, Number(tuning.attackSpeedCap) || 1),
    };
    const cp = customProfessionOf(ch);
    fv = cp && cp.formulas ? F.evaluate({ groups: { other: cp.formulas } }, 'custom', vars) : F.evaluate(fset, prof, vars);
    maxWeight = Math.max(1, Math.round(fv.maxWeight));
    overLine = maxWeight * (Number(fset.overweightPercent) || 100) / 100;
  }
  const baseSpeed = ch.movementMode === 'run' ? RUN_SPEED : WALK_SPEED;
  // Over the weight limit the character cannot run and walks slower (overweightSpeedPercent).
  const overWeight = inventoryWeight(ch) > overLine;
  let moveSpeed = overWeight ? Math.max(1, Math.round(WALK_SPEED * (Number.isFinite(tuning.overweightSpeedPercent) ? tuning.overweightSpeedPercent / 100 : OVERWEIGHT_SPEED_FACTOR)))
    : Math.max(40, Math.round(baseSpeed + (eq.moveSpeed || 0)));
  if (mount === 'cloud') moveSpeed += tuning.cloudSpeed || 0;
  else if (mount === 'carpet') moveSpeed = Math.round(moveSpeed * (1 + (tuning.carpetSpeedPercent || 0) / 100));
  // 敏捷 / 迅捷 / 精英 affixes: attack speed +N%.
  // Agility speeds attacks up to tuning.attackSpeedCap; the equipment's attack speed % comes on top.
  const agiSpeed = Math.min(Math.max(1, Number(tuning.attackSpeedCap) || 1), 1 + eff.agility * 0.002);
  let attackSpeed = Math.round(agiSpeed * (1 + (eq.attackSpeedPercent || 0) / 100) * 100) / 100;
  if (fv) {
    maxHp = Math.max(1, Math.round(fv.maxHp * cloud));
    maxStamina = Math.max(0, Math.round(fv.maxStamina * cloud));
    attack = Math.max(0, Math.round(fv.attack * cloud));
    breakPower = Math.max(0, Math.round(fv.breakPower * cloud));
    defense = Math.max(0, Math.round(fv.defense * (blessing === 'angel_defense' ? 1.3 : 1) * cloud));
    attackSpeed = Math.max(0.3, Math.round(fv.attackSpeed * 100) / 100);
  }
  // Fourteenth batch: 原版逐级 / 按当前等级职业 base life replace the web base (and the
  // formula set's maxHp); gear life, card bonus, life % and 筋斗云 still apply.
  const nat = naturalHp(ch, lvl);
  if (nat != null) maxHp = Math.max(1, Math.round((nat + (eq.maxHp || 0) + (cpd.bonusMaxHp || 0)) * (1 + (eq.maxHpPercent || 0) / 100) * cloud));
  return {
    combatLevel: lvl, professionLevel: plvl, core, eq, blessing, mount, hpRegenFactor: (blessing === 'angel_hp_regen' ? 1.3 : 1) * cloud, staminaRegenFactor: cloud, maxHp, maxStamina, attack, breakPower, defense,
    maxWeight, overWeight, moveSpeed, attackSpeed, attackRange: profile.attackRange, combatProfile: profile,
    attackIntervalMs: Math.round(profile.attackIntervalMs / Math.max(0.3, attackSpeed)),
    magicResist: { fire: eq.fireResist || 0, ice: eq.iceResist || 0, thunder: eq.thunderResist || 0, poison: eq.poisonResist || 0 },
    extraAttrs: {
      // Thirteenth batch: flat element attack (original); an unmigrated percent counts 1 for 1.
      fireDamage: (eq.fireDamage || 0) + (eq.fireDamagePercent || 0), iceDamage: (eq.iceDamage || 0) + (eq.iceDamagePercent || 0),
      thunderDamage: (eq.thunderDamage || 0) + (eq.thunderDamagePercent || 0), poisonDamage: (eq.poisonDamage || 0) + (eq.poisonDamagePercent || 0),
      gunSkillPercent: eq.gunSkillPercent || 0, magicSkillPercent: eq.magicSkillPercent || 0,
      damageReflectPercent: eq.damageReflectPercent || 0, lifeStealPercent: eq.lifeStealPercent || 0,
      staminaStealPercent: eq.staminaStealPercent || 0, hitPercent: eq.hitPercent || 0,
      farSkillPercent: eq.farSkillPercent || 0, nearSkillPercent: eq.nearSkillPercent || 0,
      professionSkillPercent: eq.professionSkillPercent || 0,
    },
  };
}

// Shown as 称号: "12级的枪手"; a craftsman is named after the best craft skill,
// e.g. "物品加工宗师". A title set by hand (ch.title) wins.
const CRAFT_TITLE_NAMES = [['fusion', '物品加工'], ['forging', '装备打造'], ['smelting', '矿石冶炼'], ['mining', '矿石开采'], ['repair', '装备修理']];
function autoTitle(ch, professionLevel) {
  if (ch.profession === 'craftsman') {
    const D = require('../features/crafting/data');
    const st = D.craftState(ch);
    let best = null;
    for (const [key, name] of CRAFT_TITLE_NAMES) {
      const level = D.skillLevel(st[key].exp);
      if (!best || level > best.level) best = { level, name };
    }
    return best.level > 1 ? best.name + D.skillTitle(best.level) : '工匠' + D.skillTitle(1);
  }
  return professionLevel + '级的' + (PROFESSION_LABELS[ch.profession] || ch.profession);
}

function buildParams(ch, stats, runtime = {}) {
  const lvl = stats.combatLevel;
  const plvl = stats.professionLevel;
  const pexp = (ch.professionExp && ch.professionExp[ch.profession]) || 0;
  const communityLevel = levelForExp(ch.communityExp || 0);
  const ageDays = Math.floor((Date.now() - (ch.createdAt || Date.now())) / 86400000);
  return {
    profile: {
      nickname: ch.name,
      age: ageDays,
      communityLevel,
      profession: ch.profession,
      professionName: PROFESSION_LABELS[ch.profession] || ch.profession,
      title: ch.title || autoTitle(ch, plvl),
      alignment: ch.alignment || 0,
      reputation: ch.reputation || 0,
      team: runtime.teamName || '',
      duty: runtime.duty || '',
      gold: ch.gold,
      movementMode: ch.movementMode,
      playerId: ch.id,
    },
    progression: {
      communityExp: ch.communityExp || 0,
      nextCommunityLevelExp: levelUpRequirement(communityLevel + 1),
      combatLevel: lvl,
      combatExp: ch.combatExp || 0,
      nextCombatLevelExp: lvl >= LEVEL_CAP ? 0 : levelUpRequirement(lvl + 1),
      combatLevelLocked: Number.isInteger(ch.combatLevelLock),
      combatExpInLevel: Math.max(0, (ch.combatExp || 0) - cumulativeExpForLevel(lvl)),
      professionExpInLevel: Math.max(0, pexp - cumulativeExpForLevel(plvl)),
      profession: ch.profession,
      professionLevel: plvl,
      professionExp: pexp,
      nextProfessionLevelExp: plvl >= LEVEL_CAP ? 0 : levelUpRequirement(plvl + 1),
      professionName: PROFESSION_LABELS[ch.profession] || ch.profession,
      skillPoints: ch.skillPoints || 0,
    },
    combat: {
      hp: Math.max(0, Math.round(ch.hp)),
      maxHp: stats.maxHp,
      stamina: Math.max(0, Math.round(ch.stamina)),
      maxStamina: stats.maxStamina,
      weight: inventoryWeight(ch),
      maxWeight: stats.maxWeight,
      attack: stats.attack,
      breakPower: stats.breakPower,
      defense: stats.defense,
      moveSpeed: stats.moveSpeed,
      attackRange: stats.attackRange,
      attackSpeed: stats.attackSpeed,
      attackIntervalMs: stats.attackIntervalMs,
      magicResist: stats.magicResist,
      coreAttrs: stats.core,
      extraAttrs: stats.extraAttrs,
      activeBuffs: runtime.activeBuffs || [],
    },
    combatProfile: stats.combatProfile,
    combatSkills: COMBAT_SKILL_IDS.map((id) => ({ id, level: (ch.combatSkills && ch.combatSkills[id]) || 0 })),
    professionSkills: Object.entries(ch.professionSkills || {})
      .filter(([id]) => !SKILL_DEFS.SKILLS[id] || (SKILL_DEFS.SKILLS[id].allowed ? SKILL_DEFS.SKILLS[id].allowed(ch) : SKILL_DEFS.SKILLS[id].profession === ch.profession))
      .map(([id, s]) => SKILL_DEFS.describe(id, s)),
    appearance: appearanceWithAvatar(ch),
    cardPuzzle: runtime.cardPuzzle || undefined,
  };
}

const skillNextExp = SKILL_DEFS.skillNextExp;

// --- item instances ---
function makeItem(ch, itemId, count = 1, overrides = {}) {
  const t = getTemplate(itemId);
  if (!t) return null;
  ch.itemSeq = (ch.itemSeq || 0) + 1;
  const dur = t.durability ? { cur: t.durability.cur, max: t.durability.max } : { cur: 1, max: 1 };
  return Object.assign({
    seqId: ch.id + ':' + ch.itemSeq,
    itemId: t.itemId,
    name: t.name,
    desc: t.desc || '',
    weight: t.weight || 0,
    requirement: t.requirement ? JSON.parse(JSON.stringify(t.requirement)) : undefined,
    bonusAttrs: (t.bonusAttrs || []).map((a) => Object.assign({}, a)),
    sellPrice: t.sellPrice || 0,
    count: Math.max(1, count | 0),
    durability: dur,
  }, overrides);
}

function canStack(a, b) {
  if (!a || !b) return false;
  if (a.itemId !== b.itemId) return false;
  const t = getTemplate(a.itemId);
  if (!t || slotForTemplate(t)) return false;
  if (a.name !== b.name) return false;
  if ((a.wedding || null) !== (b.wedding || null)) return false; // invitations of different weddings
  return true;
}

module.exports = {
  autoTitle,
  INV_COLS, INV_ROWS, INV_SIZE, LEVEL_CAP, SKILL_LEVEL_CAP, COMBAT_SKILL_IDS, PROFESSION_LABELS, COMBAT_PROFESSIONS,
  levelUpRequirement, cumulativeExpForLevel, levelForExp, normalizeAppearance, modelFor, newCharacter, combatLevel, professionLevel, settleLevelPoints,
  SKILL_POINT_TOTAL_CAP, spentSkillPoints, skillPointRoom, addSkillPoints, meetsRequirement, unequipUnfit,
  setTuning, setFormulaSet, naturalHp, averageHp, hpGrowthNumbers, setProfessionTags, professionTagsOf, setCustomProfessions, customProfessionOf, modelForCharacter, setAttrSpreads, attrSpread, ATTR_SPREAD, CORE_KEYS, ownsMount, mountExpiresAt, ridingMount, weaponSkillOf, warriorHoldsBow, WARRIOR_MELEE_RANGE, computeStats, buildParams, makeItem, normalizeCustomAvatar, appearanceWithAvatar, canStack, inventoryWeight, skillNextExp, combatProfileFor, WALK_SPEED, RUN_SPEED,
};
