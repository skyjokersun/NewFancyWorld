'use strict';
// Mounts (eighth batch): 筋斗云 and 飞毯. Two buttons beside the EXP box (patch 100)
// show what the character has: grey = none, yellow = owned, blue = riding. Only one
// mount at a time, and its effects apply only while riding.
// - 筋斗云 (cloud): rented from the fairy next to 乔乔 in 波赛敦广场 (50 service points for
//   half a month), from the dragon altar wish (half a month) or item 2600 (1 hour). Time
//   runs offline too; renting again adds to what is left. While riding: move speed +20,
//   attack, break, defense, life, stamina and their regeneration +5%. No exp bonus since
//   the ninth batch (the 战神 statue gives 战神的祝福 for exp now). Monsters still attack
//   the rider.
// - 飞毯 (carpet): the angel altar's one-month blessing. While riding: move speed +50%,
//   monsters leave the rider alone, and the rider cannot attack.
// The numbers are server settings (坐骑 group on the admin page).
const C = require('../game/character');
const cat = require('../game/catalog');

const CLOUD_CAPSULE_ID = 2600;
const CAPSULE_MS = 60 * 60 * 1000;
const LABELS = { cloud: '筋斗云', carpet: '飞毯' };
const CLOUD_NPC_MAP = 'square_in';

// 筋斗云胶囊: the client knows item 2600 (icon editor-item-icons/2600_cloudy) but the
// shop catalog has no entry, so it gets one here. It is not sold or dropped anywhere;
// the admin page can give it.
if (!cat.templates.has(CLOUD_CAPSULE_ID)) {
  cat.templates.set(CLOUD_CAPSULE_ID, {
    itemId: CLOUD_CAPSULE_ID, name: '筋斗云胶囊', desc: '使用后获得 1 小时筋斗云。', equipPos: 'none', tab: 'misc',
    buyPrice: 0, sellPrice: 0, weight: 1, durability: { cur: 1, max: 1 }, bonusAttrs: [], source: 'mount',
  });
}

class Mounts {
  register(server) {
    this.server = server;
    server.ext.on('mount', (p, d) => this.ride(p, d.mount));
    server.ext.on('mount_query', (p) => this.sendState(p));
    server.ext.on('cloud_rent', (p) => this.rentCloud(p));
    server.events.on('playerEntered', (p) => this.sendState(p));
    this.lastSweep = 0;
    server.events.on('tick', (now) => { if (now - this.lastSweep >= 2000) { this.lastSweep = now; this.sweep(now); } });
  }

  mounts(ch) { if (!ch.mounts || typeof ch.mounts !== 'object') ch.mounts = {}; return ch.mounts; }

  state(p, now = Date.now()) {
    const ch = p.ch;
    const one = (kind) => ({ owned: C.ownsMount(ch, kind, now), expiresAt: C.ownsMount(ch, kind, now) ? C.mountExpiresAt(ch, kind) : 0 });
    const cfg = this.server.config;
    return { cloud: one('cloud'), carpet: one('carpet'), riding: C.ridingMount(ch, now), rentPoints: Math.max(0, Math.round(cfg.cloudRentPoints)), rentDays: cfg.cloudRentDays };
  }

  sendState(p) { this.server.ext.send(p, 'mounts', this.state(p)); }

  // Stats, speed and the mount under the character follow the change.
  apply(p) {
    p.recompute();
    p.markDirty();
    p.flushParams();
    this.sendState(p);
    this.server.store.markDirty();
  }

  // kind: 'cloud' | 'carpet' to get on (off the other one), anything else to get off.
  ride(p, kind) {
    const m = this.mounts(p.ch);
    if (kind === 'cloud' || kind === 'carpet') {
      if (!C.ownsMount(p.ch, kind)) { this.server.ext.tell(p, '你没有' + LABELS[kind] + '。'); this.sendState(p); return; }
      if (m.riding === kind) return this.sendState(p);
      // Eleventh batch: getting on the 飞毯 (no attacking) stops auto hunt first.
      if (kind === 'carpet' && p.autoHunt && this.server.features.autoHunt) this.server.features.autoHunt.stop(p, '骑上飞毯后不能打怪，自动打怪已停止。');
      m.riding = kind; m.mountedAt = Date.now();
    } else {
      if (!m.riding) return this.sendState(p);
      m.riding = null;
    }
    this.apply(p);
  }

  // Adds ms of 筋斗云 to what is left. Returns the new end time.
  grantCloud(p, ms) {
    const m = this.mounts(p.ch);
    const now = Date.now();
    m.cloudUntil = Math.max(now, m.cloudUntil || 0) + ms;
    this.apply(p);
    return m.cloudUntil;
  }

  useCapsule(p) {
    const until = this.grantCloud(p, CAPSULE_MS);
    return '获得 1 小时筋斗云，有效期至 ' + fmt(until) + '。';
  }

  // The fairy in 波赛敦广场: 50 service points (shared with the bank) for half a month.
  rentCloud(p) {
    const cfg = this.server.config;
    if (!p.scene || p.scene.mapRef !== CLOUD_NPC_MAP) return;
    const bank = this.server.features.bank;
    const cost = Math.max(0, Math.round(cfg.cloudRentPoints));
    const days = Math.max(1, Number(cfg.cloudRentDays) || 15);
    const have = bank.points(p);
    if (have < cost) {
      this.server.ext.send(p, 'cloud_result', { success: false, message: '服务点数不足：租用筋斗云需要 ' + cost + ' 点，你只有 ' + have + ' 点。' });
      return;
    }
    p.session.account.servicePoints = have - cost;
    const until = this.grantCloud(p, days * 864e5);
    this.server.ext.send(p, 'cloud_result', {
      success: true, servicePoints: p.session.account.servicePoints,
      message: '租用成功，花费 ' + cost + ' 点服务点。筋斗云有效期至 ' + fmt(until) + '，点下方「筋斗云」按钮即可骑乘。',
    });
  }

  // Mounts that ran out while riding: off they come.
  sweep(now) {
    for (const p of this.server.playersById.values()) {
      const m = p.ch.mounts;
      if (!m || !m.riding || C.ownsMount(p.ch, m.riding, now)) continue;
      const kind = m.riding;
      m.riding = null;
      this.server.ext.tell(p, '你的' + LABELS[kind] + '已经到期。');
      this.apply(p);
    }
  }
}

function fmt(t) { return new Date(t).toLocaleString('zh-CN', { hour12: false }); }

module.exports = { Mounts, CLOUD_CAPSULE_ID };
