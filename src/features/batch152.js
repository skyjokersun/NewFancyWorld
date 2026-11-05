'use strict';
// Fifteenth batch, update 2 (V15.2). Settings live in the 'batch152' bucket of
// var/state.json (in the settings export / import / reset); the admin page is 限时活动.
//
// 1. Beijing time (Q21): the server asks ntp.ntsc.ac.cn / ntp.aliyun.com / ntp.tencent.com
//    (NTP, UDP 123) at start and every 6 hours and keeps the offset to the PC clock.
//    Every schedule below reads clock.now() as UTC+8, whatever the PC's clock or zone.
// 2. Timed events (Q1, Q2, Q11, Q13-Q15, Q25, Q26): each event is off / always / date
//    ranges / weekly days and hours. A manual 开 / 关 lasts until the schedule next changes.
//    Start and end are announced to everyone.
//    - dragon (屠龙): shards, 米索莉 and 大地龙 only while it is on (features/batch15.js).
//    - transform (愚人节变身): event drops and the green materials only while it is on.
//    - nightfair (夜市): the fair's services and crickets only while it is on.
//    - doublemap: every hour on the hour one random hunting map (or one per level band)
//      gives x2 exp, item drops and gold; cards, shards and event drops are not doubled.
//    - freebless: 全服免费战神祝福, everyone blessed without paying service points.
//    - five small festivals: each character takes the gift once per opening.
// 3. Durability (Q19, Q20): a weapon loses 1 per 1000 attacks (misses too), each other
//    piece worn 1 per 1000 hits taken; a 大地龙 hit counts 10. At 0 the piece stays but is
//    broken: no bonus, cannot be worn, taken off into the bag (if there is room).
// 4. Element states (Q27-Q29, the original effect.fcc HitEXEffect): an ice hit slows (and
//    tints the target blue), 寒冰冲击波 freezes, a poison hit poisons (green) and takes
//    life every second. Monster element points and ice / poison magic count, and players'
//    ice / poison skills. Q31: equipment element points only add to skills of that element.
// 5. 美杜沙 (Q30) and the original 狐仙 (Q32): stats, magic, resists, drops and the four
//    colours (sPalette) of the original ani.tab rows 1501-1504 and 1511.
// 6. Cards go into the bag (Q16); the client's interaction notices can be hidden (Q17);
//    summoned monsters have their drops and stats on the admin 怪物 page.
const dgram = require('dgram');
const cat = require('../game/catalog');
const C = require('../game/character');
const log = require('../util/log');

const HOUR = 3600000;
const BJ = 8 * HOUR;
const NTP_SERVERS = ['ntp.ntsc.ac.cn', 'ntp.aliyun.com', 'ntp.tencent.com'];
const DAYS = ['日', '一', '二', '三', '四', '五', '六'];
const pad = (n) => String(n).padStart(2, '0');
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------- clock
function ntpQuery(host, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const sock = dgram.createSocket('udp4');
    const finish = (err, v) => { if (done) return; done = true; clearTimeout(timer); try { sock.close(); } catch (_) { /* closed */ } if (err) reject(err); else resolve(v); };
    const timer = setTimeout(() => finish(new Error('超时')), timeoutMs);
    const pkt = Buffer.alloc(48); pkt[0] = 0x1b;   // LI 0, version 3, client
    let t0 = 0;
    sock.on('error', (e) => finish(e));
    sock.on('message', (msg) => {
      const t3 = Date.now();
      if (msg.length < 48) return finish(new Error('回包太短'));
      const ts = (o) => (msg.readUInt32BE(o) - 2208988800) * 1000 + msg.readUInt32BE(o + 4) * 1000 / 0x100000000;
      const t1 = ts(32), t2 = ts(40);
      if (!(msg.readUInt32BE(40) > 0)) return finish(new Error('时间为空'));
      finish(null, Math.round(((t1 - t0) + (t2 - t3)) / 2));
    });
    t0 = Date.now();
    sock.send(pkt, 123, host, (e) => { if (e) finish(e); });
  });
}

class Clock {
  constructor() { this.offset = 0; this.synced = false; this.lastSyncAt = 0; this.lastTryAt = 0; this.source = ''; this.error = ''; this.busy = false; }
  now() { return Date.now() + this.offset; }
  parts(ms = this.now()) {
    const d = new Date(ms + BJ);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), dow: d.getUTCDay() };
  }
  hm(ms) { const b = this.parts(ms); return pad(b.h) + ':' + pad(b.mi); }
  text(ms) { const b = this.parts(ms); return b.y + '-' + pad(b.mo) + '-' + pad(b.d) + ' ' + pad(b.h) + ':' + pad(b.mi); }
  hourKey(ms) { const b = this.parts(ms); return b.y + '-' + pad(b.mo) + '-' + pad(b.d) + ' ' + pad(b.h); }
  // 'YYYY-MM-DD HH:MM' Beijing time -> epoch ms (NaN when malformed).
  parse(s) {
    const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})\s*$/.exec(String(s || ''));
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - BJ;
  }
  async sync() {
    if (this.busy) return;
    this.busy = true; this.lastTryAt = Date.now();
    const errs = [];
    try {
      for (const host of NTP_SERVERS) {
        try {
          const off = await ntpQuery(host);
          this.offset = off; this.synced = true; this.source = host; this.lastSyncAt = Date.now(); this.error = '';
          log.info('北京时间对时成功：' + host + '，本机时钟偏差 ' + Math.round(off / 1000) + ' 秒');
          return;
        } catch (e) { errs.push(host + '：' + e.message); }
      }
      this.synced = false;
      this.error = errs.join('；');
      log.warn('北京时间对时失败，暂用本机时钟：' + this.error);
    } finally { this.busy = false; }
  }
  view() {
    return { now: this.text(), seconds: this.parts().s, offsetSec: Math.round(this.offset / 1000), synced: this.synced, source: this.source,
      lastSync: this.lastSyncAt ? this.text(this.lastSyncAt + this.offset) : '', error: this.error, servers: NTP_SERVERS };
  }
}

// ---------------------------------------------------------------- events
// [key, name, default mode, start text, end text]
const EVENTS = [
  ['dragon', '屠龙', 'always', '【屠龙】活动开始了！邪恶的大地之龙正在苏醒，收集黄色水晶碎片，向光明大祭祀米索莉求助吧！', '【屠龙】活动结束了。'],
  ['transform', '愚人节变身', 'always', '【愚人节】活动开始了！把 10 个绿色材料送给朋友，看看他会变成什么吧！', '【愚人节】活动结束了。'],
  ['nightfair', '夜市', 'always', '【夜市】夜市开张了！', '【夜市】夜市打烊了。'],
  ['doublemap', '每小时双倍地图', 'off', '【双倍地图】活动开始了！每个整点抽一张地图，经验、掉落、金币翻倍。', '【双倍地图】活动结束了。'],
  ['freebless', '全服免费战神祝福', 'off', '【战神祝福】战神降下了祝福：活动期间人人打怪经验翻倍，不扣服务点！', '【战神祝福】全服免费战神祝福结束了。'],
  ['midautumn', '中秋：吴刚送月饼', 'off', '【中秋】吴刚给大家送月饼来啦！', '【中秋】中秋活动结束了。'],
  ['valentine', '情人节：巧克力', 'off', '【情人节】情人节快乐！每人可以领一份情人节礼物。', '【情人节】情人节活动结束了。'],
  ['anniversary', '周年庆：蛋糕和戒指', 'off', '【周年庆】奇域周年庆典开始了！每人可以领一份周年礼物。', '【周年庆】周年庆活动结束了。'],
  ['childrensday', '六一：棒棒糖', 'off', '【六一】儿童节快乐！每人可以领幻彩棒棒糖。', '【六一】儿童节活动结束了。'],
  ['newyear', '新春：爆竹', 'off', '【新春】新年好！每人可以领一份新春爆竹。', '【新春】新春活动结束了。'],
];
const EVENT_NAMES = Object.fromEntries(EVENTS.map((e) => [e[0], e[1]]));
// Festival gifts (Q26, defaults ours): [itemId, count] lists; 'oneOf' gives one of them.
const FESTIVALS = {
  midautumn: { title: '吴刚', text: '中秋佳节，月圆人圆。这是我在月宫做的祈福月饼，送给你！', items: [[100, 5]] },
  valentine: { title: '情人节', text: '情人节快乐！这盒情人节巧克力送给你，也可以转送给心上人。', items: [[84, 3]] },
  anniversary: { title: '周年庆典', text: '感谢你陪伴奇域又一年！送上周年蛋糕和纪念戒指。', items: [[79, 3], [1559, 1]] },
  childrensday: { title: '六一儿童节', text: '儿童节快乐！具有特殊魔力的幻彩棒棒糖送给你。', items: [[90, 3]], oneOf: [90, 91, 92] },
  newyear: { title: '新春', text: '新年好！放鞭炮，迎新春，祝你新的一年好运连连！', items: [[2623, 5]] },
};

const DEFAULTS = {
  events: Object.fromEntries(EVENTS.map(([k, , mode, s, e]) => [k, { mode, ranges: [], weekly: { days: [], start: '20:00', end: '22:00' }, startText: s, endText: e }])),
  double: { expMult: 2, dropMult: 2, goldMult: 2, byBand: false, bands: '1-40,41-80,81-999', pool: [] },
  wear: { on: true, hitsPerPoint: 1000, dragonMult: 10 },
  status: { on: true, iceSlowPct: 30, seconds: 5, freezeSec: 6, bossFreezeHalf: true, poisonSkillPct: 20, poisonSkillSec: 5, mistPct: 20, mistSec: 3,
    iceOdds: 100, poisonOdds: 100, poisonKillsPlayers: false, elementOnlySkills: true },
  notices: { shop: false, dialog: false, desk: false, npcTalk: false },
  festivals: Object.fromEntries(Object.entries(FESTIVALS).map(([k, f]) => [k, { text: f.text, items: f.items.map((x) => ({ itemId: x[0], count: x[1] })) }])),
  medusa: { on: true, skin: 80, tail: 80, petrifySec: 0 },
};
const NOTICE_LABELS = { shop: '打开商店时的“物品买卖：××”', dialog: '点 NPC 时的“对话交互：××”', desk: '点桌台时的“桌台交互：××”', npcTalk: '“与 [××] 对话”' };

// ---------------------------------------------------------------- original monsters
// 狐仙 (ani.tab 1501-1504) and 美杜沙 (1511). Drops: raw / 10000 as in the original table;
// 'p,item,s,chance' special drops carry the original prefix / suffix (affixes.js).
const T = require('../../data/original-tables.json');
const FOX_ROWS = [1501, 1502, 1503, 1504];
const FOX_PALETTE = ['ACGG', 'CDCC', 'HBHH', 'KAKK'];
const FOX_SPECIAL = ['441,2323,0,200?0,1685,153,300', '442,2323,0,500?0,1688,213,300', '443,2323,0,500?0,1687,273,300', '451,2323,0,300?0,1676,333,300'];
// Magic of each attack kind: element (隶属) and the web projectile drawn for it.
const MAGIC = {
  301: { element: 'ice', projectile: 'bingjian', name: '冰箭' }, 302: { element: 'fire', projectile: 'huoqiu', name: '火球' },
  303: { element: 'thunder', projectile: 'bolt', name: '闪电' }, 304: { element: 'fire', projectile: 'huoqiu', name: '鬼火' },
  305: { element: 'poison', projectile: 'poison', name: '毒雾', mist: true }, 306: { element: 'fire', name: '喷火术' }, 308: { element: 'fire', name: '火云' },
  311: { element: 'ice', name: '寒冰冲击波', freeze: true }, 315: { element: 'poison', projectile: 'poison', name: '石化', petrify: true },
  401: { element: 'poison', name: '毒雾', mist: true }, 603: { element: 'ice', name: '雪球' },
};
function specialDrops(raw) {
  const out = [];
  for (const part of String(raw || '').split('?')) {
    const [p, item, s, chance] = part.split(',').map(Number);
    if (!item || !cat.getTemplate(item)) continue;
    const t = cat.getTemplate(item);
    const pre = p && T.prefixes[p] ? T.prefixes[p].name : '';
    const suf = s && T.suffixes[s] ? T.suffixes[s].name : '';
    out.push({ type: 'item', itemId: item, chance: chance / 10000, minCount: 1, maxCount: 1, legacySpecialDrop: true, legacyPrefixId: p || 0, legacySuffixId: s || 0,
      legacyPrefixName: pre, legacySuffixName: suf, name: (pre ? pre + '的' : '') + t.name + (suf ? '·' + suf : '') });
  }
  return out;
}
function foxDef(tier) {
  const o = T.monsters[String(FOX_ROWS[tier - 1])];
  return {
    monsterId: 'summon_fox' + tier, sourceId: FOX_ROWS[tier - 1], name: '狐仙LV' + tier, model: 'fox3', level: o.level, hp: o.hp, maxHp: o.hp,
    defense: o.defense, breakPower: o.breakPower, damage: o.damage, attackRange: o.attackRange, detectionRange: o.detectionRange, moveSpeed: o.moveSpeed,
    baseExp: o.baseExp, attackType2: o.attackType2, sPalette: FOX_PALETTE[tier - 1],
    fireResist: o.fireResist, iceResist: o.iceResist, thunderResist: o.thunderResist, poisonResist: o.poisonResist,
    drops: [{ type: 'gold', chance: 0.18, minCount: 500, maxCount: 500 }, { type: 'item', itemId: 2622, chance: 0.001, minCount: 1, maxCount: 1 }].concat(specialDrops(FOX_SPECIAL[tier - 1])),
  };
}
function medusaDef() {
  const o = T.monsters['1511'];
  const lizardman = T.monsters['211'];
  return {
    monsterId: 'summon_medusa', sourceId: 1511, name: '美杜沙', model: 'lizardman', palette: Number(lizardman.palette), level: o.level, hp: o.hp, maxHp: o.hp,
    defense: o.defense, breakPower: o.breakPower, damage: 500, attackRange: o.attackRange, detectionRange: o.detectionRange, moveSpeed: o.moveSpeed,
    baseExp: o.baseExp, attackType2: 315, projectile: 'poison', projectileSpeed: 700,
    drops: [{ type: 'gold', chance: 0.08, minCount: 300, maxCount: 300 }].concat(specialDrops('0,1688,211,3')),
  };
}

// Extra items: the original itemdata.tab rows the web client lacks.
const TEMPLATES = {
  2602: ['大龙角', '大龙的角，带着强大的防魔属性', 18],
  2603: ['飞龙骨', '飞龙的骨骼，质地轻而坚韧，并带有魔法属性', 10],
  2634: ['龙牙', '邪恶地龙安塔瑞斯的牙齿，制作龙牙装备的必要道具', 1],
};

function num(v, min, max, what) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(what + '须在 ' + min + ' 到 ' + max + ' 之间');
  return n;
}
function hmOk(s) { return /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s || '').trim()); }
function hmMin(s) { const [h, m] = String(s).trim().split(':').map(Number); return h * 60 + m; }

class Batch152 {
  register(server) {
    this.server = server;
    this.clock = server.clock = new Clock();
    this.lastOn = {};
    this.lastTick = 0;
    this.lastStatus = 0;
    for (const [id, [name, desc, weight]] of Object.entries(TEMPLATES)) {
      if (cat.getTemplate(Number(id))) continue;
      cat.templates.set(Number(id), { itemId: Number(id), name, desc, equipPos: 'none', tab: 'misc', buyPrice: 0, sellPrice: 5, weight, durability: { cur: 1, max: 1 }, bonusAttrs: [], source: 'batch152' });
    }
    // Q9: 龙鳞战甲 as in the original goodsscheme.tab, at the 90 smithing tier.
    try {
      const D = require('./crafting/data');
      const r = D.RECIPE_BY_ID.get(1041);
      const mats = [[2712, 15], [2711, 5], [2601, 10], [2602, 10], [2603, 10]].map(([itemId, count]) => ({ itemId, count }));
      if (r) { r.materials = mats; r.requiredLevel = 90; }
      else { const nr = { itemId: 1041, name: '龙鳞战甲', requiredLevel: 90, itemLevel: 180, materials: mats }; D.RECIPES.push(nr); D.RECIPE_BY_ID.set(1041, nr); }
      D.RECIPES.sort((a, b) => a.requiredLevel - b.requiredLevel || a.itemId - b.itemId);
    } catch (e) { log.warn('龙鳞战甲配方没加上：' + e.message); }
    // Slowed players keep the slow through every stats recompute.
    const P = require('../game/player').Player;
    if (!P.prototype.v152Recompute) {
      const rc = P.prototype.recompute;
      P.prototype.v152Recompute = rc;
      P.prototype.recompute = function (silent) {
        const r = rc.call(this, silent);
        const sl = this.v152Slow;
        if (sl && sl.until > Date.now()) this.stats.moveSpeed = Math.max(1, Math.round(this.stats.moveSpeed * (1 - sl.pct / 100)));
        return r;
      };
    }
    const ext = server.ext;
    ext.on('fest_claim', (p, d) => this.festClaim(p, String(d.key || '')));
    ext.on('fest_query', (p) => this.festOffer(p, true));
    ext.on('medusa_summon', (p) => this.summonMedusa(p));
    ext.on('v152_query', (p) => this.sendClient(p));
    server.events.on('tick', (now) => this.tick(now));
    server.events.on('playerEntered', (p) => this.onEnter(p));
    server.events.on('playerMapChanging', (p, from, to) => this.onMapChange(p, from, to));
    this.clock.sync();
    this.syncTimer = setInterval(() => this.clock.sync(), 6 * HOUR);
    if (this.syncTimer.unref) this.syncTimer.unref();
  }

  onStart() {
    this.bucket = this.server.store.bucket('batch152');
    this.state = this.bucket.state || (this.bucket.state = { manual: {}, since: {}, double: null });
    for (const [k] of EVENTS) this.lastOn[k] = this.isOn(k);
    // Summoned monsters on the admin 怪物 page (stats and drops).
    const bal = this.server.features.balance;
    if (bal) {
      const orig = bal.catalog.bind(bal);
      const self = this;
      bal.catalog = function () {
        const fresh = !this.monsterIndex;
        const idx = orig();
        if (fresh || !idx.has('summon_medusa')) for (const d of self.summonDefs()) if (!idx.has(d.monsterId)) idx.set(d.monsterId, { monsterId: d.monsterId, template: clone(d), maps: [], summon: true });
        return idx;
      };
    }
  }

  summonDefs() {
    const out = [1, 2, 3, 4].map(foxDef).concat([medusaDef()]);
    const b15 = this.server.features.batch15;
    if (b15) out.push(b15.bossDef());
    return out;
  }
  // A summon's definition with the admin 怪物 page's stat edits laid over it.
  withEdits(def) {
    const bal = this.server.features.balance;
    const o = bal && bal.cfg && bal.cfg.monsters && bal.cfg.monsters[def.monsterId];
    if (!o) return def;
    const d = Object.assign({}, def, o);
    if (o.maxHp) d.hp = o.maxHp;
    return d;
  }

  // ------------------------------------------------------------ config
  cfg() {
    const b = this.bucket || {};
    const out = {};
    for (const k of Object.keys(DEFAULTS)) {
      if (k === 'events' || k === 'festivals') {
        out[k] = {};
        for (const [ek, ev] of Object.entries(DEFAULTS[k])) out[k][ek] = Object.assign(clone(ev), (b[k] || {})[ek] || {});
      } else out[k] = Object.assign(clone(DEFAULTS[k]), b[k] || {});
    }
    return out;
  }
  ev(key) { return this.cfg().events[key]; }

  // Whether the schedule alone has the event on at ms.
  scheduled(key, ms) {
    const e = this.ev(key);
    if (!e) return false;
    if (e.mode === 'always') return true;
    if (e.mode === 'ranges') return (e.ranges || []).some((r) => { const a = this.clock.parse(r.from), z = this.clock.parse(r.to); return ms >= a && ms < z; });
    if (e.mode === 'weekly') {
      const w = e.weekly || {}; const days = w.days || [];
      if (!days.length || !hmOk(w.start) || !hmOk(w.end)) return false;
      const b = this.clock.parts(ms); const t = b.h * 60 + b.mi;
      const s = hmMin(w.start), z = hmMin(w.end);
      if (z > s) return days.includes(b.dow) && t >= s && t < z;
      return (days.includes(b.dow) && t >= s) || (days.includes((b.dow + 6) % 7) && t < z);
    }
    return false;
  }
  isOn(key, ms = this.clock.now()) {
    const sch = this.scheduled(key, ms);
    const m = this.state && this.state.manual[key];
    if (m && m.sched === sch) return m.on;
    return sch;
  }
  // When the event next changes from its present state (scan by the minute, up to 15 days).
  nextChange(key) {
    const now = this.clock.now();
    const cur = this.isOn(key, now);
    const e = this.ev(key);
    if (e.mode === 'always' || e.mode === 'off') {
      const m = this.state.manual[key];
      return m && m.sched !== undefined && m.on !== m.sched ? '（手动' + (m.on ? '开启' : '关闭') + '，排期是一直' + (m.sched ? '开' : '关') + '）' : '';
    }
    const start = Math.ceil(now / 60000) * 60000;
    for (let t = start, i = 0; i < 15 * 1440; i += 1, t += 60000) if (this.isOn(key, t) !== cur) return this.clock.text(t);
    return '';
  }
  setManual(key, on) {
    if (!EVENT_NAMES[key]) throw new Error('没有这个活动：' + key);
    const sch = this.scheduled(key, this.clock.now());
    if (on === null) delete this.state.manual[key];
    else this.state.manual[key] = { on: !!on, sched: sch };
    this.server.store.markDirty();
    this.tick(Date.now(), true);
    return EVENT_NAMES[key] + (on === null ? ' 已按排期' : on ? ' 已立即开启' : ' 已立即关闭') + '（持续到下一个排期点）';
  }
  saveEvent(key, body) {
    if (!EVENT_NAMES[key]) throw new Error('没有这个活动：' + key);
    if (body && body.reset) { if (this.bucket.events) delete this.bucket.events[key]; this.server.store.markDirty(); return EVENT_NAMES[key] + ' 已恢复默认'; }
    const mode = String(body.mode || 'off');
    if (!['off', 'always', 'ranges', 'weekly'].includes(mode)) throw new Error('开放方式不对');
    const ranges = [];
    for (const r of Array.isArray(body.ranges) ? body.ranges.slice(0, 50) : []) {
      const a = this.clock.parse(r.from), z = this.clock.parse(r.to);
      if (!Number.isFinite(a) || !Number.isFinite(z)) throw new Error('时段要写成 2026-12-24 20:00 这样');
      if (z <= a) throw new Error('时段的结束要晚于开始：' + r.from + ' → ' + r.to);
      ranges.push({ from: String(r.from).trim(), to: String(r.to).trim() });
    }
    const w = body.weekly || {};
    const days = [...new Set((Array.isArray(w.days) ? w.days : []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
    const start = String(w.start || '20:00').trim(), end = String(w.end || '22:00').trim();
    if (!hmOk(start) || !hmOk(end)) throw new Error('每周固定的时间要写成 20:00 这样');
    if (mode === 'ranges' && !ranges.length) throw new Error('“指定时段”至少要有一段');
    if (mode === 'weekly' && !days.length) throw new Error('“每周固定”至少要选一天');
    const def = DEFAULTS.events[key];
    const out = { mode, ranges, weekly: { days, start, end }, startText: String(body.startText == null ? def.startText : body.startText).slice(0, 200), endText: String(body.endText == null ? def.endText : body.endText).slice(0, 200) };
    this.bucket.events = this.bucket.events || {};
    this.bucket.events[key] = out;
    this.server.store.markDirty();
    this.tick(Date.now(), true);
    return EVENT_NAMES[key] + ' 已保存，立即生效';
  }
  // part: double | wear | status | notices | medusa | festival:<key>
  savePart(part, body) {
    if (part.startsWith('festival:')) {
      const key = part.slice(9);
      if (!FESTIVALS[key]) throw new Error('没有这个节日活动');
      this.bucket.festivals = this.bucket.festivals || {};
      if (body.reset) { delete this.bucket.festivals[key]; this.server.store.markDirty(); return '已恢复默认'; }
      const items = [];
      for (const it of (Array.isArray(body.items) ? body.items : []).slice(0, 10)) {
        const id = Math.trunc(Number(it.itemId)); const n = Math.trunc(num(it.count, 1, 9999, '数量'));
        if (!cat.getTemplate(id)) throw new Error('没有这个物品：' + id);
        items.push({ itemId: id, count: n });
      }
      if (!items.length) throw new Error('至少要有一件奖品');
      this.bucket.festivals[key] = { text: String(body.text || FESTIVALS[key].text).slice(0, 300), items };
      this.server.store.markDirty();
      return '已保存';
    }
    if (!DEFAULTS[part] || part === 'events' || part === 'festivals') throw new Error('没有这一项：' + part);
    if (body && body.reset) { delete this.bucket[part]; this.server.store.markDirty(); this.afterSave(part); return '已恢复默认'; }
    const d = DEFAULTS[part];
    const out = {};
    for (const [k, def] of Object.entries(d)) {
      const v = body[k];
      if (typeof def === 'boolean') out[k] = v == null ? def : !!v;
      else if (typeof def === 'number') out[k] = v == null || v === '' ? def : num(v, 0, 1e9, k);
      else if (Array.isArray(def)) out[k] = Array.isArray(v) ? v.map(String).filter((m) => this.server.maps.ids().includes(m)) : def;
      else out[k] = v == null ? def : String(v);
    }
    if (part === 'wear' && out.hitsPerPoint < 1) throw new Error('每多少次扣 1 点至少是 1');
    if (part === 'double') this.parseBands(out.bands);
    if (part === 'status') for (const k of ['iceSlowPct', 'iceOdds', 'poisonOdds', 'poisonSkillPct', 'mistPct']) if (out[k] > 100) throw new Error(k + ' 不能超过 100');
    this.bucket[part] = out;
    this.server.store.markDirty();
    this.afterSave(part);
    return '已保存，立即生效';
  }
  afterSave(part) {
    if (part === 'notices' || part === 'medusa') for (const p of this.server.playersById.values()) this.sendClient(p);
  }
  parseBands(s) {
    const out = [];
    for (const part of String(s || '').split(/[,，\s]+/).filter(Boolean)) {
      const m = /^(\d+)-(\d+)$/.exec(part);
      if (!m || +m[2] < +m[1]) throw new Error('等级段要写成 1-40,41-80,81-999 这样');
      out.push([+m[1], +m[2]]);
    }
    return out;
  }
  exportConfig() { const o = clone(this.bucket); delete o.state; return o; }
  importConfig(v) {
    const state = this.bucket.state;
    for (const k of Object.keys(this.bucket)) delete this.bucket[k];
    for (const k of Object.keys(DEFAULTS)) if (v && v[k]) this.bucket[k] = clone(v[k]);
    this.bucket.state = state;
    this.server.store.markDirty();
  }
  hasCustom() { return Object.keys(this.bucket).some((k) => k !== 'state'); }
  reset() { for (const k of Object.keys(this.bucket)) if (k !== 'state') delete this.bucket[k]; this.state.manual = {}; this.server.store.markDirty(); }

  view() {
    const c = this.cfg();
    return {
      clock: this.clock.view(), days: DAYS,
      events: EVENTS.map(([k, name]) => ({ key: k, name, config: c.events[k], on: this.isOn(k), scheduled: this.scheduled(k, this.clock.now()), manual: this.state.manual[k] || null, next: this.nextChange(k), festival: !!FESTIVALS[k] })),
      double: c.double, doubleNow: this.state.double, wear: c.wear, status: c.status, notices: c.notices, noticeLabels: NOTICE_LABELS, medusa: c.medusa,
      festivals: Object.fromEntries(Object.keys(FESTIVALS).map((k) => [k, { text: c.festivals[k].text, items: c.festivals[k].items.map((x) => ({ itemId: x.itemId, count: x.count, name: (cat.getTemplate(x.itemId) || {}).name || '?' })) }])),
      huntingMaps: [...this.server.maps.huntingMaps()].sort().map((id) => ({ id, name: this.server.maps.nameOf(id) || id })),
      defaults: clone(DEFAULTS),
    };
  }

  // ------------------------------------------------------------ tick
  tick(now, force) {
    if (!this.bucket) return;
    if (!force && now - this.lastTick < 1000) { this.tickStates(now); return; }
    this.lastTick = now;
    for (const [k, name] of EVENTS) {
      const on = this.isOn(k);
      if (this.lastOn[k] === on) continue;
      this.lastOn[k] = on;
      const e = this.ev(k);
      if (on) this.state.since[k] = Date.now();
      this.server.store.markDirty();
      const text = on ? e.startText : e.endText;
      if (text) this.broadcast(text, true);
      log.info('限时活动「' + name + '」' + (on ? '开启' : '结束'));
      this.onEventChange(k, on);
    }
    // Drop a manual switch once the schedule has moved on.
    for (const [k, m] of Object.entries(this.state.manual)) if (m.sched !== this.scheduled(k, this.clock.now())) { delete this.state.manual[k]; this.server.store.markDirty(); }
    if (this.isOn('doublemap')) {
      const hk = this.clock.hourKey();
      if (!this.state.double || this.state.double.hour !== hk) this.pickDouble(hk);
    } else if (this.state.double) { this.state.double = null; this.server.store.markDirty(); this.pushDouble(); }
    this.tickStates(now);
  }
  onEventChange(k, on) {
    const b15 = this.server.features.batch15;
    if (k === 'dragon' && !on && b15) b15.dismiss();
    if (k === 'freebless' && this.server.features.blessing) for (const p of this.server.playersById.values()) { p.blessIdsSent = ''; this.server.features.blessing.sendState(p); }
    if (FESTIVALS[k] && on) for (const p of this.server.playersById.values()) this.festOffer(p);
    for (const p of this.server.playersById.values()) this.sendClient(p);
  }
  broadcast(text, centre) {
    for (const p of this.server.playersById.values()) {
      this.server.ext.tell(p, text);
      if (centre) this.server.ext.send(p, 'centre_notice', { text });
    }
  }
  centre(text) { for (const p of this.server.playersById.values()) this.server.ext.send(p, 'centre_notice', { text }); }

  onEnter(p) {
    this.sendClient(p);
    setTimeout(() => { if (p.session && p.scene) this.festOffer(p); }, 2500);
    if (p.scene) this.doubleNotice(p, p.scene.mapRef);
  }
  onMapChange(p, from, to) { if (to) setTimeout(() => this.doubleNotice(p, to.mapRef), 300); }

  // What the client patch needs: notice switches, the double maps, events on.
  sendClient(p) {
    const c = this.cfg();
    this.server.ext.send(p, 'v152', { notices: c.notices, double: this.doubleView(), events: Object.fromEntries(EVENTS.map(([k]) => [k, this.isOn(k)])),
      medusa: { on: !!c.medusa.on, skin: c.medusa.skin, tail: c.medusa.tail } });
  }

  // ------------------------------------------------------------ double map
  doubleView() {
    const d = this.state && this.state.double;
    if (!d) return null;
    const c = this.cfg().double;
    return { hour: d.hour, maps: d.maps, exp: c.expMult, drop: c.dropMult, gold: c.goldMult };
  }
  mapLevel(id) {
    try {
      const ms = this.server.maps.rawDoc(id).monsterSpawns;
      const lv = (ms && ms.entries || []).map((e) => Number(e.level) || 1);
      return lv.length ? Math.round(lv.reduce((a, b) => a + b, 0) / lv.length) : 1;
    } catch (_) { return 1; }
  }
  pickDouble(hour) {
    const c = this.cfg().double;
    const prev = new Set(((this.state.double && this.state.double.maps) || []).map((m) => m.id));
    const dragonMaps = new Set(this.server.features.batch15 ? this.server.features.batch15.aliveDragons().map((d) => d.map) : []);
    let pool = (c.pool && c.pool.length ? c.pool : [...this.server.maps.huntingMaps()]).filter((id) => this.server.maps.huntingMaps().has(id) && !dragonMaps.has(id));
    if (pool.some((id) => !prev.has(id))) pool = pool.filter((id) => !prev.has(id));
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    const maps = [];
    if (c.byBand) {
      for (const [lo, hi] of this.parseBands(c.bands)) {
        const inBand = pool.filter((id) => { const l = this.mapLevel(id); return l >= lo && l <= hi; });
        if (inBand.length) { const id = pick(inBand); maps.push({ id, name: this.server.maps.nameOf(id) || id, band: lo + '-' + hi }); }
      }
    } else if (pool.length) { const id = pick(pool); maps.push({ id, name: this.server.maps.nameOf(id) || id }); }
    this.state.double = { hour, maps };
    this.server.store.markDirty();
    if (maps.length) this.broadcast('【双倍地图】本小时双倍地图：' + maps.map((m) => m.name + (m.band ? '（' + m.band + ' 级）' : '')).join('、') + '。经验 ×' + c.expMult + '，掉落 ×' + c.dropMult + '，金币 ×' + c.goldMult + '！');
    this.pushDouble();
  }
  pushDouble() { for (const p of this.server.playersById.values()) this.sendClient(p); }
  doubleOf(mapRef) {
    const d = this.state && this.state.double;
    if (!d || !this.isOn('doublemap')) return null;
    return d.maps.find((m) => m.id === mapRef) || null;
  }
  doubleNotice(p, mapRef) {
    const m = this.doubleOf(mapRef);
    if (!m) return;
    const c = this.cfg().double;
    this.server.ext.tell(p, '你进入了本小时的双倍地图「' + m.name + '」：经验 ×' + c.expMult + '，掉落 ×' + c.dropMult + '，金币 ×' + c.goldMult + '。');
  }
  // combat.js: multipliers on this map now.
  mapMult(mapRef) {
    if (!this.doubleOf(mapRef)) return null;
    const c = this.cfg().double;
    return { exp: c.expMult, drop: c.dropMult, gold: c.goldMult };
  }

  // ------------------------------------------------------------ festivals
  festOffer(p, asked) {
    const c = this.cfg();
    let any = false;
    for (const key of Object.keys(FESTIVALS)) {
      if (!this.isOn(key)) continue;
      any = true;
      const since = this.state.since[key] || 0;
      const got = p.ch.v152Fest && p.ch.v152Fest[key] === since;
      if (got && !asked) continue;
      const f = c.festivals[key];
      this.server.ext.send(p, 'fest_offer', { key, title: FESTIVALS[key].title, text: f.text, got: !!got,
        items: (FESTIVALS[key].oneOf ? [{ name: FESTIVALS[key].oneOf.map((id) => (cat.getTemplate(id) || {}).name).filter(Boolean)[0] + '（随机一种）', count: f.items[0].count }] : f.items.map((x) => ({ name: (cat.getTemplate(x.itemId) || {}).name || '?', count: x.count }))) });
    }
    if (asked && !any) this.server.ext.tell(p, '现在没有可以领奖的节日活动。');
  }
  festClaim(p, key) {
    if (!FESTIVALS[key] || !this.isOn(key)) return this.server.ext.tell(p, '这个活动现在没有开启。');
    const since = this.state.since[key] || 0;
    p.ch.v152Fest = p.ch.v152Fest || {};
    if (p.ch.v152Fest[key] === since) return this.server.ext.tell(p, '这次活动的礼物你已经领过了。');
    const f = this.cfg().festivals[key];
    const list = f.items.map((x, i) => [i === 0 && FESTIVALS[key].oneOf ? FESTIVALS[key].oneOf[Math.floor(Math.random() * FESTIVALS[key].oneOf.length)] : x.itemId, x.count]);
    const free = p.ch.inventory.filter((s) => !s).length;
    if (free < list.length) return this.server.ext.tell(p, '背包需要 ' + list.length + ' 个空格才能领取，请先整理背包。');
    const changed = [];
    const names = [];
    for (const [id, n] of list) {
      const it = C.makeItem(p.ch, id, n);
      const idx = it && p.addItem(it);
      if (idx) { changed.push(...idx); names.push(it.name + ' ×' + n); }
    }
    p.ch.v152Fest[key] = since;
    p.commitItems({ inv: changed, dropMessage: '获得了：' + names.join('、') });
    this.server.store.markDirty();
    this.server.ext.tell(p, '【' + FESTIVALS[key].title + '】你领到了 ' + names.join('、') + '。');
  }

  // ------------------------------------------------------------ cards into the bag (Q16)
  giveCard(scene, m, killer, item) {
    const idx = killer.addItem(item);
    if (idx) { killer.commitItems({ inv: idx, dropMessage: '获得了：' + item.name }); return; }
    scene.dropGroundItem(item, m.x, m.y, { ownerPlayerId: killer.id, ownerEnemyId: m.id });
    this.server.ext.tell(killer, '背包已满，' + item.name + '掉在地上了。');
  }

  // ------------------------------------------------------------ durability (Q19, Q20)
  // One count on `slots`; at hitsPerPoint counts the piece loses 1. Returns changed slots.
  wearCount(p, slots, n) {
    const c = this.cfg().wear;
    if (!c.on) return;
    const per = Math.max(1, Math.round(c.hitsPerPoint));
    const changed = [];
    for (const s of slots) {
      const it = p.ch.equipment[s];
      if (!it || !it.durability || it.durability.infinite || !(it.durability.max > 1) || it.durability.cur <= 0) continue;
      it.ext = it.ext || {};
      it.ext.wearHits = (Number(it.ext.wearHits) || 0) + n;
      if (it.ext.wearHits < per) continue;
      const lose = Math.floor(it.ext.wearHits / per);
      it.ext.wearHits -= lose * per;
      it.durability.cur = Math.max(0, it.durability.cur - lose);
      changed.push(s);
    }
    if (!changed.length) return;
    const broken = changed.filter((s) => p.ch.equipment[s] && p.ch.equipment[s].durability.cur <= 0);
    const inv = [];
    for (const s of broken) {
      const it = p.ch.equipment[s];
      const free = p.findFreeSlot();
      if (free < 0) { this.server.ext.tell(p, it.name + '损坏了，背包已满，仍穿在身上，但属性已经失效。请修理。'); continue; }
      p.ch.inventory[free] = it; p.ch.equipment[s] = null; inv.push(free);
      this.server.ext.tell(p, it.name + '损坏了，已经自动卸下放回背包。请到铁匠那里修理。');
    }
    p.commitItems({ equip: changed, inv });
  }
  onPlayerAttack(p) { this.wearCount(p, ['weapon'], 1); }
  onPlayerHit(p, m) {
    const c = this.cfg().wear;
    const slots = cat.EQUIP_SLOTS.filter((s) => s !== 'weapon');
    this.wearCount(p, slots, m && m.v15Boss ? Math.max(1, Math.round(c.dragonMult)) : 1);
    // Q8: a 大地龙 hit may knock a worn piece off (off by default).
    const b15 = this.server.features.batch15;
    const pct = b15 && m && m.v15Boss ? Number(b15.cfg().dragon.gearDropPercent) || 0 : 0;
    if (pct > 0 && Math.random() * 100 < pct) {
      const worn = cat.EQUIP_SLOTS.filter((s) => p.ch.equipment[s]);
      if (worn.length) {
        const s = worn[Math.floor(Math.random() * worn.length)];
        const it = p.ch.equipment[s];
        p.ch.equipment[s] = null;
        p.scene.dropGroundItem(it, p.x, p.y, { source: 'player_drop', ownerPlayerId: p.id });
        p.commitItems({ equip: [s] });
        this.server.ext.tell(p, '大地龙的重击把你的' + it.name + '打落在地上了！');
      }
    }
  }
  // items.equip: broken pieces cannot be worn.
  brokenText(it) { return it && it.durability && !it.durability.infinite && it.durability.max > 1 && it.durability.cur <= 0 ? it.name + '已损坏，修理后才能穿戴。' : ''; }

  // ------------------------------------------------------------ element states
  stCfg() { return this.cfg().status; }
  // Monster -> player (combat.monsterHitOne), after the damage of the hit.
  onMonsterHit(m, p, dmg, hit) {
    const c = this.stCfg();
    if (!c.on || !p.alive) return;
    const kind = MAGIC[m.def.attackType2];
    const magicHit = kind && (m.ranged || hit.ranged) && !hit.skill;
    const fx = [];
    // Ice: the monster's ice points, or its ice magic (冰箭 as level 1: 3.5 s).
    if ((m.elements.ice > 0 || (magicHit && kind.element === 'ice')) && Math.random() * 100 < c.iceOdds) {
      const sec = magicHit && m.def.attackType2 === 301 ? 3.5 : c.seconds;
      this.slowPlayer(p, c.iceSlowPct, sec * 1000);
      fx.push('ice');
    }
    if (Math.random() * 100 < c.poisonOdds) {
      let per = 0, sec = 0;
      if (magicHit && kind.element === 'poison') {
        if (kind.mist) { per = dmg * c.mistPct / 100; sec = c.mistSec; } else { per = dmg * c.poisonSkillPct / 100; sec = c.poisonSkillSec; }
      } else if (m.elements.poison > 0) {
        per = m.elements.poison * (1 - Math.min(75, Number(p.stats.magicResist && p.stats.magicResist.poison) || 0) / 100);
        sec = c.seconds;
      }
      if (per > 0 && sec > 0) { this.poison(p, m, Math.max(1, Math.round(per)), sec * 1000, false); fx.push('poison'); }
      if (magicHit && kind.petrify && this.cfg().medusa.petrifySec > 0) { this.slowPlayer(p, 100, this.cfg().medusa.petrifySec * 1000); }
    }
    for (const f of fx) this.showStatus(p.scene, p.id, f, f === 'ice' ? (p.v152Slow ? p.v152Slow.until - Date.now() : 5000) : p.v152Poison ? p.v152Poison.until - Date.now() : 5000);
  }
  // Player -> monster (combat.strikeEnemy), on impact.
  onPlayerStrike(p, m, damage, o) {
    const c = this.stCfg();
    if (!c.on || !m.alive || !o || !o.element || !o.skillId) return;
    const lvl = Number(o.skillLevel) || 1;
    if (o.element === 'ice') {
      if (Math.random() * 100 >= c.iceOdds) return;
      if (o.skillId === 'mage_ice_shockwave') {
        let ms = c.freezeSec * 1000;
        if (c.bossFreezeHalf && (m.v15Boss || m.foxTier || m.def.sourceId === 1511 || (m.level || 1) >= 200)) ms /= 2;
        this.freezeMonster(m, ms);
        this.showStatus(m.scene, m.id, 'freeze', ms);
      } else {
        const ms = (o.skillId === 'mage_ice_arrow' ? 3 + lvl / 2 : c.seconds) * 1000;
        this.slowMonster(m, c.iceSlowPct, ms);
        this.showStatus(m.scene, m.id, 'ice', ms);
      }
    } else if (o.element === 'poison') {
      if (Math.random() * 100 >= c.poisonOdds) return;
      const sec = o.skillId === 'child_poison_cast' ? c.poisonSkillSec : c.seconds;
      this.poison(m, p, Math.max(1, Math.round(damage * c.poisonSkillPct / 100)), sec * 1000, true);
      this.showStatus(m.scene, m.id, 'poison', sec * 1000);
    }
  }
  showStatus(scene, id, kind, ms) {
    if (!scene) return;
    for (const q of scene.players.values()) this.server.ext.send(q, 'status_fx', { id, fx: kind, ms: Math.max(300, Math.round(ms)) });
  }
  slowPlayer(p, pct, ms) {
    const until = Date.now() + ms;
    p.v152Slow = { pct: Math.min(100, pct), until: Math.max(until, p.v152Slow ? p.v152Slow.until : 0) };
    this.applyPlayerSpeed(p);
  }
  // Player.recompute (patched in register) applies the slow to stats.moveSpeed.
  applyPlayerSpeed(p) {
    const before = p.stats.moveSpeed;
    p.recompute(true);
    if (p.stats.moveSpeed !== before) { p.markDirty(); p.paramsDirty = true; }
  }
  slowMonster(m, pct, ms) {
    this.hookMonster(m);
    m.v152Slow = { pct, until: Math.max(Date.now() + ms, m.v152Slow ? m.v152Slow.until : 0) };
    if (m.path.length) { m.speed = Math.max(10, Math.round(m.baseSpeed * (1 - pct / 100))); m.markDirty(); }
  }
  freezeMonster(m, ms) {
    this.hookMonster(m);
    m.v152Freeze = Math.max(Date.now() + ms, m.v152Freeze || 0);
    m.pendingHit = null;
    m.stop();
    m.actionUntil = 0;
    m.markDirty();
  }
  hookMonster(m) {
    if (m.v152Hooked) return;
    m.v152Hooked = true;
    const setPath = m.setPath.bind(m);
    m.setPath = (pts, speed = m.baseSpeed) => {
      const s = m.v152Slow && m.v152Slow.until > Date.now() ? Math.max(10, Math.round(speed * (1 - m.v152Slow.pct / 100))) : speed;
      return setPath(pts, s);
    };
    const tick = m.tick.bind(m);
    m.tick = (now, dt) => {
      if (m.v152Freeze && m.v152Freeze > now && m.alive) return undefined;
      return tick(now, dt);
    };
  }
  // A poison on a player or a monster: `per` life every second for ms. A new poison
  // replaces the old (no stacking).
  poison(target, source, per, ms, onMonster) {
    target.v152Poison = { per, until: Date.now() + ms, next: Date.now() + 1000, sourceId: source && source.id, onMonster };
  }
  tickStates(now) {
    if (now - this.lastStatus < 200) return;
    this.lastStatus = now;
    const op = this.server.op;
    for (const sc of this.server.scenes.values()) {
      for (const p of sc.players.values()) {
        if (p.v152Slow && p.v152Slow.until <= now) { p.v152Slow = null; this.applyPlayerSpeed(p); }
        const ps = p.v152Poison;
        if (!ps) continue;
        if (!p.alive || ps.until <= now - 50) { p.v152Poison = null; continue; }
        if (now < ps.next) continue;
        ps.next += 1000;
        const floor = this.stCfg().poisonKillsPlayers ? 0 : 1;
        const dmg = Math.min(ps.per, Math.max(0, p.ch.hp - floor));
        if (dmg <= 0) continue;
        p.ch.hp -= dmg; p.markDirty(); p.paramsDirty = true;
        sc.broadcast(op.ATTACK_RESULT, { attackerId: ps.sourceId || p.id, targetId: p.id, attackType: 'timed_point_bomb', projectileKey: 'none', projectileSpeed: 0, direction: 0,
          damage: dmg, targetHp: Math.round(p.ch.hp), targetMaxHp: p.stats.maxHp, poisonTick: true, serverSeq: this.server.nextSeq() });
        if (p.ch.hp <= 0) sc.combat.killPlayer(p);
      }
      for (const m of sc.enemies.values()) {
        if (m.v152Slow && m.v152Slow.until <= now) { m.v152Slow = null; if (m.path.length) { m.speed = m.baseSpeed; m.markDirty(); } }
        if (m.v152Freeze && m.v152Freeze <= now) { m.v152Freeze = 0; m.markDirty(); }
        const ps = m.v152Poison;
        if (!ps) continue;
        if (!m.alive || ps.until <= now - 50) { m.v152Poison = null; continue; }
        if (now < ps.next) continue;
        ps.next += 1000;
        const dmg = Math.min(ps.per, Math.max(1, Math.round(m.hp)));
        m.hp -= dmg;
        const killer = sc.players.get(ps.sourceId);
        if (killer) m.threat.set(killer.id, (m.threat.get(killer.id) || 0) + dmg);
        sc.broadcast(op.ATTACK_RESULT, { attackerId: ps.sourceId || m.id, targetId: m.id, attackType: 'ranged_lock_on', projectileKey: 'none', projectileSpeed: 0, direction: 0,
          damage: dmg, targetHp: Math.max(0, Math.round(m.hp)), targetMaxHp: m.maxHp, poisonTick: true, serverSeq: this.server.nextSeq() });
        if (m.hp <= 0) {
          if (killer) sc.combat.killEnemy(m, killer); else { m.hp = 1; m.markDirty(); }
        } else m.markDirty();
      }
    }
  }

  // ------------------------------------------------------------ 美杜沙 (Q30)
  summonMedusa(p) {
    const c = this.cfg().medusa;
    if (!c.on) return this.server.ext.tell(p, '现在不能召唤美杜沙。');
    const sc = p.scene;
    if (!sc || !this.server.isHuntingMap(sc.mapRef)) return this.server.ext.tell(p, '城镇里不能召唤，请到猎场召唤美杜沙。');
    if (p.countItem(2584) < c.skin || p.countItem(2585) < c.tail) return this.server.ext.tell(p, '[美杜沙]需要' + c.skin + '个蜥蜴皮和' + c.tail + '个蜥蜴尾刺才能召唤！');
    const a = p.removeItemCount(2584, c.skin);
    const b = p.removeItemCount(2585, c.tail);
    p.commitItems({ inv: (a || []).concat(b || []), dropMessage: '美杜沙即将出现……' });
    const def = this.withEdits(medusaDef());
    const now = Date.now();
    const at = sc.map.nearestWalkablePixel(p.x + 200 - Math.random() * 400, p.y + 150 - Math.random() * 300, 40) || { x: p.x + 60, y: p.y };
    const m = sc.addMonster(def, at, null);
    m.summonedBy = p.id;
    m.summonAppearAt = now + 5000; m.summonSolidAt = now + 10000;
    m.state = 'idle'; m.nextWanderAt = m.summonSolidAt + 1000;
    const origSync = m.sync.bind(m);
    m.sync = () => Object.assign(origSync(), { summonAppearAt: m.summonAppearAt, summonSolidAt: m.summonSolidAt, summonerId: p.id });
    const origTick = m.tick.bind(m);
    let lastFight = now;
    m.tick = (t, dt) => {
      if (t < m.summonSolidAt) return undefined;
      if (m.targetId || m.hp < m.maxHp) lastFight = t;
      if (t - lastFight > 10 * 60000 && m.alive) { sc.enemies.delete(m.id); sc.removedEnemyIds.push(m.id); return undefined; }
      return origTick(t, dt);
    };
    m.markDirty();
    for (const q of sc.players.values()) this.server.ext.tell(q, (p.name || p.ch.name) + ' 召唤了美杜沙！它的魔法会让人中毒，小心！');
    return undefined;
  }
}

module.exports = { Batch152, Clock, DEFAULTS, EVENTS, FESTIVALS, MAGIC, foxDef, medusaDef, specialDrops, FOX_PALETTE };
