'use strict';
// Twelfth batch: map and zone (区服) switches from the admin page, and the patch label
// for the in-game settings dialog.
// - A closed map keeps whoever is inside; nobody can walk in. The refusal is shown with
//   the big text in the middle of the screen (MAP_SWITCH_RESULT dropMessage).
// - Zones are the six islands of the login screen. Characters are kept per zone (one
//   account may have a character in each). A closed zone cannot be logged into; players
//   already online stay. The island 西部圣域 (west) keeps the characters made before this
//   batch, which the server stored under the default world id, so the two ids are swapped
//   for it (zoneWorld).
const { PATCH } = require('../version');

const ISLANDS = [
  { id: 'adventure', name: '冒险世界' }, { id: 'west', name: '西部圣域' }, { id: 'green', name: '绿色世界' },
  { id: 'east', name: '东海风云' }, { id: 'south', name: '碧海南天' }, { id: 'angel', name: '天使之城' },
];

class World {
  register(server) {
    this.server = server;
    server.events.on('playerEntered', (p) => server.ext.send(p, 'server_version', { patch: PATCH }));
    server.ext.on('server_version', (p) => server.ext.send(p, 'server_version', { patch: PATCH }));
  }

  closedMaps() { return this.server.store.bucket('closedMaps'); }
  zoneState() { return this.server.store.bucket('zones'); }

  isMapClosed(mapRef) { return !!this.closedMaps()[String(mapRef || '').toLowerCase()]; }
  setMapOpen(mapRef, open) {
    const id = String(mapRef || '').toLowerCase();
    if (!this.server.maps.has(id)) throw new Error('没有这张地图：' + mapRef);
    if (open) delete this.closedMaps()[id]; else this.closedMaps()[id] = true;
    this.server.store.markDirty();
    return (open ? '已开放 ' : '已关闭 ') + id;
  }

  // Island id -> the world id the characters are stored under.
  zoneWorld(island) {
    const def = this.server.config.defaultWorld;
    if (island === 'west') return def;
    if (island === def) return 'west';
    return island;
  }
  worldZone(world) {
    const def = this.server.config.defaultWorld;
    if (world === def) return 'west';
    if (world === 'west') return def;
    return world;
  }
  // Only 西部圣域 is open until the admin opens another.
  isZoneOpen(island) {
    const st = this.zoneState();
    return st[island] === undefined ? island === 'west' : !!st[island];
  }
  setZoneOpen(island, open) {
    if (!ISLANDS.some((z) => z.id === island)) throw new Error('没有这个区：' + island);
    this.zoneState()[island] = !!open;
    this.server.store.markDirty();
    return (open ? '已开放 ' : '已关闭 ') + ISLANDS.find((z) => z.id === island).name;
  }
  zonesView() {
    const counts = {};
    for (const ch of Object.values(this.server.store.data.characters)) counts[ch.world] = (counts[ch.world] || 0) + 1;
    const online = {};
    for (const p of this.server.playersById.values()) online[p.ch.world] = (online[p.ch.world] || 0) + 1;
    return ISLANDS.map((z) => {
      const w = this.zoneWorld(z.id);
      return { id: z.id, name: z.name, world: w, open: this.isZoneOpen(z.id), characters: counts[w] || 0, online: online[w] || 0 };
    });
  }
  zoneName(world) { const z = ISLANDS.find((i) => i.id === this.worldZone(world)); return z ? z.name : world; }

  mapsView() {
    const maps = this.server.maps;
    return maps.ids().sort().map((id) => ({ mapId: id, name: (maps.nameOf && maps.nameOf(id)) || '', open: !this.isMapClosed(id) }));
  }
}

module.exports = { World, ISLANDS };
