'use strict';
// Helpers shared by the craftsman panels.
const crypto = require('crypto');
const { cloneItem } = require('../../game/player');

function newSessionId(prefix) { return prefix + '-' + crypto.randomBytes(6).toString('hex'); }

function idx(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function mapIs(p, ...refs) { return !!(p.scene && refs.includes(p.scene.mapRef)); }

// Reference to an inventory stack that is still the same stack when we use it.
function invRef(p, index) {
  const it = index == null ? null : p.ch.inventory[index];
  return it ? { inventoryIndex: index, seqId: it.seqId } : null;
}
function resolveRef(p, ref) {
  if (!ref) return null;
  const it = p.ch.inventory[ref.inventoryIndex];
  return it && it.seqId === ref.seqId ? it : null;
}
function viewRef(p, ref, count) {
  const it = resolveRef(p, ref);
  if (!it) return null;
  const item = cloneItem(it);
  if (count != null) item.count = count;
  return { inventoryIndex: ref.inventoryIndex, item };
}

// Takes `count` from one stack; returns the touched index.
function consumeAt(p, index, count = 1) {
  const it = p.ch.inventory[index];
  if (!it) return null;
  it.count -= count;
  if (it.count <= 0) p.ch.inventory[index] = null;
  return index;
}

function chargeGold(p, amount) {
  if (p.ch.gold < amount) return false;
  p.ch.gold -= amount;
  p.paramsDirty = true;
  return true;
}

module.exports = { newSessionId, idx, mapIs, invRef, resolveRef, viewRef, consumeAt, chargeGold, cloneItem };
