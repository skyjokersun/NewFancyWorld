'use strict';
// Craftsman professions: mining, ore smelting, forging, fusion, repair and the
// craftsman material shop in the smithy.
const cat = require('../../game/catalog');
const D = require('./data');
const { Mining } = require('./mining');
const { Smelting } = require('./smelting');
const { Forge } = require('./forge');
const { Fusion } = require('./fusion');
const { Mystic } = require('./mystic');


class Crafting {
  register(server) {
    this.server = server;
    server.op.LEGACY_MINING_REQUEST = server.op.LEGACY_MINING_REQUEST || 5500;
    server.op.LEGACY_MINING_STATE = server.op.LEGACY_MINING_STATE || 5510;
    this.parts = [new Mining(this), new Smelting(this), new Forge(this), new Fusion(this), new Mystic(this)];
    for (const part of this.parts) part.register();
    server.events.on('playerKilled', (p) => this.wear(p));
    // Fourteenth batch: "工作中" next to the name of anyone using a smithy bench (smelting,
    // forging, fusion / repair, the mystic NPC) or auto-repairing. Everyone in the same
    // scene is told when it changes, and a player arriving gets the current list.
    this.lastWorkSweep = 0;
    server.events.on('tick', (now) => { if (now - this.lastWorkSweep >= 500) { this.lastWorkSweep = now; this.workSweep(); } });
  }

  isWorking(p) {
    const it = p.interactions || {};
    // Only inside the smithy / smelting rooms, so a bench left open elsewhere does not count.
    if (!p.scene || !/^(smith|smith2|smelt)$/.test(p.scene.mapRef)) return false;
    return !!(p.autoRepair || it.fusion || it.forge || it.smelt || it.mystic);
  }
  workSweep() {
    const ext = this.server.ext;
    if (!ext) return;
    for (const p of this.server.playersById.values()) {
      if (!p.ch || !p.scene) continue;
      const w = this.isWorking(p);
      if (w !== !!p.workingShown) {
        p.workingShown = w;
        for (const o of p.scene.players.values()) ext.send(o, 'working', { playerId: p.id, on: w });
      }
      if (p.workingScene !== p.scene) {
        p.workingScene = p.scene;
        const ids = [...p.scene.players.values()].filter((o) => o !== p && o.workingShown).map((o) => o.id);
        ext.send(p, 'working_list', { playerIds: ids });
      }
    }
  }

  // The smithy's "购买工匠原料" opens the tools shop; serve the material catalog there.
  materialShop(p, kind) {
    if (kind !== 'tools' || !p.scene || p.scene.mapRef !== 'smith') return null;
    const shops = this.server.features.shops;
    const list = shops ? shops.itemsOf('smith:tools') : D.MATERIAL_SHOP;
    return {
      catalogId: 'craftsman_materials',
      tabs: { medicine: [], weapon: [], armor: [], accessory: [], book: [], misc: list.slice() },
      items: list.map((id) => {
        const t = cat.getTemplate(id);
        return { itemId: id, name: t.name, desc: t.desc || '', buyPrice: shops ? shops.price(id) : t.buyPrice, sellPrice: t.sellPrice, weight: t.weight || 0, bonusAttrs: t.bonusAttrs || [], equipPos: 'none', tab: 'misc' };
      }),
    };
  }

  // Dying wears every equipped piece by a tenth of its durability.
  wear(p) {
    const slots = [];
    for (const slot of cat.EQUIP_SLOTS) {
      const it = p.ch.equipment[slot];
      if (!it || !it.durability || it.durability.infinite || it.durability.cur <= 0) continue;
      it.durability.cur = Math.max(0, it.durability.cur - Math.max(1, Math.ceil(it.durability.max / 10)));
      slots.push(slot);
    }
    if (slots.length) p.commitItems({ equip: slots });
  }

  skillSummary(p) {
    const st = D.craftState(p.ch);
    return Object.fromEntries(Object.entries(st).filter(([k]) => k !== 'ores').map(([k, v]) => [k, D.skillSummary(v)]));
  }
}

module.exports = { Crafting };
