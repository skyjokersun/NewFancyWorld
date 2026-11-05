'use strict';
// Thirteenth batch (Q8): the official old client's monster table (act/fight/resource/
// ani.tab, research round 9; data/original-tables.json). The web maps already carry the
// same base numbers for the 88 monsters they place (HP, defence, attack, break, speed,
// sight, reach, experience, level all match). What the web data lacked comes from here:
// - the four element resists (def_fire / def_ice / def_bolt / def_poison, percent);
// - the flat element attack (fire_ex / ice_ex / bolt_ex / poison_ex);
// - the attack kind (attackType2: 2 = melee, 30x = magic.tab, 767 = arrow, 32xx = bullet).
const T = require('../../data/original-tables.json');

const MONSTERS = T.monsters;
// Projectile the web client draws for an original attack kind. The kinds the web client
// has no matching projectile for keep the small fireball the web version used so far.
const PROJECTILE_BY_KIND = { 301: 'bingjian', 303: 'bolt', 767: 'arrow', 3206: 'bullet', 3209: 'laser' };
const ELEMENT_KEYS = [['fireResist', 'fireResist'], ['iceResist', 'iceResist'], ['thunderResist', 'thunderResist'], ['poisonResist', 'poisonResist'],
  ['fireAttack', 'fireAttack'], ['iceAttack', 'iceAttack'], ['thunderAttack', 'thunderAttack'], ['poisonAttack', 'poisonAttack']];

function speedOfKind(kind) {
  const r = T.magic[kind] || T.bullet[kind] || T.special[kind];
  return r && r.speed ? r.speed : 0;
}

// Fills the element fields of one spawn entry from its original row (fields already set win).
function fill(e) {
  const o = e && MONSTERS[String(e.sourceId)];
  if (!o) return e;
  for (const [k, src] of ELEMENT_KEYS) if (e[k] == null && o[src]) e[k] = o[src];
  if (e.attackType2 == null && o.attackType2) e.attackType2 = o.attackType2;
  return e;
}
function fillDoc(doc) {
  const ms = doc && doc.monsterSpawns;
  if (ms && Array.isArray(ms.entries)) for (const e of ms.entries) fill(e);
  return doc;
}

// Original monsters no web map places (fox, ghosts, silver snakes, the strengthened
// snakes ...), offered on the admin page when the web client has their model.
function unplaced(knownSourceIds, models) {
  const out = [];
  for (const [id, o] of Object.entries(MONSTERS)) {
    if (knownSourceIds.has(Number(id)) || !o.model || !models.has(o.model)) continue;
    out.push(fill({
      id: 'original_' + id, monsterId: 'original_' + id, sourceId: Number(id), name: o.name, model: o.model, level: o.level || 1,
      hp: o.hp, maxHp: o.hp, defense: o.defense, breakPower: o.breakPower, damage: o.damage, attackType: o.attackType,
      attackRange: o.attackRange, detectionRange: o.detectionRange, moveSpeed: o.moveSpeed, baseExp: o.baseExp,
      palette: o.palette === '' ? undefined : Number(o.palette), stackSize: 1, drops: [],
    }));
  }
  return out;
}

module.exports = { MONSTERS, PROJECTILE_BY_KIND, fill, fillDoc, unplaced, speedOfKind };
