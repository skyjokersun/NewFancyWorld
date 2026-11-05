'use strict';
// Wedding (twelfth batch), after the old client's service/marry scripts:
// - The 结婚登记人 (townhouse 丘比特办公室, also 红民村 daduibu) registers a couple: the
//   partner (online, other gender), the wedding date, the 爱的宣言 (1-60 characters) and
//   1-40 invitations each. When the partner agrees, each pays marryPoints (original 50)
//   and gets the ring (1312 男 / 1313 女) and the invitations (2606). More invitations
//   cost marryInvitePoints (original 1) each.
// - The wedding hall is temple_m_v, one copy per couple. The couple goes in from the
//   registrar; guests right-click an invitation (it is used up). From the wedding time
//   on, for marryWindowMin minutes, the ceremony starts by itself once both are inside:
//   the priest speaks, the vows are read, the couple kisses (the client's kiss
//   animation), then a server-wide announcement. Missed: change the date at the registrar.
// - Divorce: by agreement marryDivorcePoints (original 100), forced
//   marryForceDivorcePoints (original 200), both paid by the one who asks. Afterwards both
//   wait marryCooldownDays (ours, default 7) to register again.
// - 鞭炮 / 烟花 2623-2633 are sold for gold at the registrar and in the tool shops.
// Patch 104 is the client side (dialogs and forms).
const C = require('../game/character');
const cat = require('../game/catalog');

const RING_MAN = 1312, RING_WOMAN = 1313, INVITE = 2606;
const FIREWORKS = [2623, 2624, 2625, 2626, 2627, 2628, 2629, 2630, 2631, 2632, 2633];
const REGISTRARS = new Set(['townhouse', 'daduibu']);
const HALL = 'temple_m_v';
const HALL_SPAWN = { x: 1060, y: 900 };
const LEAVE_TO = { mapRef: 'temple_m', x: 850, y: 700 };
const ASK_MS = 120 * 1000;
const DAY = 864e5;
const STEP_MS = 4000;

function fmtTime(t) { return new Date(t).toLocaleString('zh-CN', { hour12: false, timeZone: process.env.TZ || 'Asia/Shanghai' }); }

class Marriage {
  register(server) {
    this.server = server;
    this.asks = new Map();       // toId -> { kind: 'propose' | 'divorce', fromId, ..., expiresAt }
    this.ceremonies = new Map(); // coupleId -> { step, next }
    const on = (k, fn) => server.ext.on(k, (p, d) => fn.call(this, p, d || {}));
    on('marry_query', (p) => this.sendState(p));
    on('marry_propose', this.propose);
    on('marry_answer', this.answer);
    on('marry_invites', this.buyInvites);
    on('marry_reschedule', this.reschedule);
    on('marry_cancel', this.cancel);
    on('marry_divorce', this.divorce);
    on('marry_enter', this.enterHall);
    on('marry_firework', this.buyFirework);
    on('wedding_leave', this.leaveHall);
    server.features.items.onUse(INVITE, (p, from, it) => this.useInvite(p, from, it));
    server.events.on('playerEntered', (p) => this.onEntered(p));
    this.lastTick = 0;
    server.events.on('tick', (now) => { if (now - this.lastTick >= 1000) { this.lastTick = now; this.tick(now); } });
  }

  cfg(key, def) { const v = Number(this.server.config[key]); return Number.isFinite(v) ? v : def; }
  data() {
    const b = this.server.store.bucket('marriage');
    if (!b.couples) b.couples = {};
    if (!b.cooldown) b.cooldown = {};
    if (!b.notes) b.notes = {};
    if (!b.nextId) b.nextId = 1;
    return b;
  }
  coupleOf(chId) {
    for (const c of Object.values(this.data().couples)) if (c.a.id === chId || c.b.id === chId) return c;
    return null;
  }
  other(c, chId) { return c.a.id === chId ? c.b : c.a; }
  points(p) { return this.server.features.bank.points(p); }
  pay(p, n) { p.session.account.servicePoints = this.points(p) - n; this.server.store.markDirty(); }
  tell(p, text) { this.server.ext.tell(p, text); }
  online(id) { return this.server.playersById.get(id) || null; }
  atRegistrar(p) { return p.scene && REGISTRARS.has(p.scene.mapRef); }
  gender(p) { return (p.ch.appearance && p.ch.appearance.gender) === 'man' ? 'man' : 'women'; }

  view(p) {
    const c = this.coupleOf(p.id);
    const cd = this.data().cooldown[p.id] || 0;
    const fw = FIREWORKS.map((id) => { const t = cat.getTemplate(id); return t && { itemId: id, name: t.name, price: t.buyPrice || 0 }; }).filter(Boolean);
    return {
      points: this.points(p), gold: p.ch.gold,
      prices: { register: this.cfg('marryPoints', 50), invite: this.cfg('marryInvitePoints', 1), divorce: this.cfg('marryDivorcePoints', 100), force: this.cfg('marryForceDivorcePoints', 200) },
      windowMin: this.cfg('marryWindowMin', 40),
      cooldownUntil: cd > Date.now() ? cd : 0,
      couple: c && {
        status: c.status, partner: this.other(c, p.id).name, vow: c.vow, weddingAt: c.weddingAt, marriedAt: c.marriedAt || 0,
        weddingText: fmtTime(c.weddingAt), marriedText: c.marriedAt ? fmtTime(c.marriedAt) : '',
      },
      fireworks: fw,
    };
  }
  sendState(p, message, extra) { this.server.ext.send(p, 'marry', Object.assign(this.view(p), { message: message || '' }, extra || {})); }

  checkFree(p, who) {
    if (this.coupleOf(p.id)) return who + '已经有婚约了。';
    const cd = this.data().cooldown[p.id] || 0;
    if (cd > Date.now()) return who + '离婚未满等待期，' + fmtTime(cd) + ' 以后才能再登记。';
    return null;
  }

  // ---------- registration ----------
  propose(p, d) {
    if (!this.atRegistrar(p)) return this.sendState(p, '请到市政厅的结婚登记人那里办理。');
    const fail = (m) => this.sendState(p, m);
    const vow = String(d.vow || '').trim();
    const invites = Math.trunc(Number(d.invites));
    const at = Math.trunc(Number(d.weddingAt));
    const q = this.server.findPlayerByName(String(d.name || ''), p.ch.world);
    if (!q) return fail('找不到这位玩家，对方需要在线并且在同一个区。');
    if (q === p) return fail('不能和自己结婚。');
    if (this.gender(q) === this.gender(p)) return fail('结婚需要一男一女。');
    const busy = this.checkFree(p, '你') || this.checkFree(q, '对方');
    if (busy) return fail(busy);
    if (!vow) return fail('请写下爱的宣言。');
    if ([...vow].length > 60) return fail('爱的宣言不能超过 60 个字。');
    if (!(invites >= 1 && invites <= 40)) return fail('请柬每人 1 至 40 张。');
    if (!(at > Date.now() - 60e3 && at < Date.now() + 60 * DAY)) return fail('婚期要在今后 60 天以内。');
    const price = this.cfg('marryPoints', 50);
    if (this.points(p) < price) return fail('登记每人需要 ' + price + ' 服务点，你的服务点不够。');
    for (const [k, a] of this.asks) if (a.fromId === p.id) this.asks.delete(k);
    this.asks.set(q.id, { kind: 'propose', fromId: p.id, vow, invites, weddingAt: at, expiresAt: Date.now() + ASK_MS });
    this.server.ext.send(q, 'marry_ask', { ask: 'propose', from: p.name, vow, invites, weddingText: fmtTime(at), price, expiresAt: Date.now() + ASK_MS });
    return fail('已经把登记申请交给 ' + q.name + '，等待对方同意（2 分钟内有效）。');
  }

  answer(p, d) {
    const a = this.asks.get(p.id);
    if (!a || a.expiresAt < Date.now()) { this.asks.delete(p.id); return this.tell(p, '这个请求已经过期了。'); }
    this.asks.delete(p.id);
    const from = this.online(a.fromId);
    if (!from) return this.tell(p, '对方已经离开了。');
    if (a.kind === 'divorce') return this.answerDivorce(from, p, !!d.accept);
    if (!d.accept) { this.tell(from, p.name + ' 婉拒了你的结婚登记。'); return this.tell(p, '你婉拒了 ' + from.name + ' 的结婚登记。'); }
    const busy = this.checkFree(from, '对方') || this.checkFree(p, '你');
    if (busy) return this.tell(p, busy);
    const price = this.cfg('marryPoints', 50);
    for (const x of [from, p]) if (this.points(x) < price) { this.tell(from, x.name + ' 的服务点不够 ' + price + ' 点，登记没有成功。'); return this.tell(p, x.name + ' 的服务点不够 ' + price + ' 点，登记没有成功。'); }
    const b = this.data();
    const man = this.gender(from) === 'man' ? from : p; const woman = man === from ? p : from;
    const c = { id: 'c' + b.nextId, world: p.ch.world, a: { id: man.id, name: man.name }, b: { id: woman.id, name: woman.name }, vow: a.vow, weddingAt: a.weddingAt, status: 'engaged', createdAt: Date.now() };
    // Rings and invitations first; nothing is charged when a bag is full.
    const given = [];
    for (const x of [from, p]) {
      const ring = this.give(x, this.gender(x) === 'man' ? RING_MAN : RING_WOMAN, 1);
      const inv = ring && this.giveInvites(x, a.invites, c);
      if (!ring || !inv) {
        if (ring) this.takeBack(x, ring);
        for (const g of given) this.takeBack(g[0], g[1]);
        const msg = x.name + ' 的背包满了，放不下婚戒和请柬，登记没有成功。';
        this.tell(from, msg); return this.tell(p, msg);
      }
      given.push([x, ring], [x, inv]);
    }
    for (const x of [from, p]) this.pay(x, price);
    b.nextId += 1;
    b.couples[c.id] = c;
    for (const [x, slots] of given) x.commitItems({ inv: slots });
    this.server.store.markDirty();
    const text = man.name + ' 与 ' + woman.name + ' 登记结婚，婚期 ' + fmtTime(c.weddingAt) + '。';
    for (const x of [from, p]) this.sendState(x, '登记成功！' + text + '婚戒和请柬已放进背包。');
    return undefined;
  }

  give(p, itemId, count) {
    const item = C.makeItem(p.ch, itemId, count);
    return item ? p.addItem(item) : null;
  }
  takeBack(p, slots) { if (Array.isArray(slots)) for (const i of slots) p.inventory[i] = null; }
  markInvite(it, c) {
    it.wedding = c.id;
    it.desc = c.a.name + ' 与 ' + c.b.name + ' 的结婚请柬，婚期 ' + fmtTime(c.weddingAt) + '。右键使用进入婚礼教堂（用掉一张）。';
  }
  // Invitations of one couple stack together; a new stack per couple.
  giveInvites(p, n, c) {
    const item = C.makeItem(p.ch, INVITE, n);
    if (!item) return null;
    if (c) this.markInvite(item, c);
    return p.addItem(item);
  }

  buyInvites(p, d) {
    const c = this.coupleOf(p.id);
    if (!c) return this.sendState(p, '只有登记过的新人才能买请柬。');
    const n = Math.trunc(Number(d.count));
    if (!(n >= 1 && n <= 100)) return this.sendState(p, '一次买 1 至 100 张。');
    const cost = n * this.cfg('marryInvitePoints', 1);
    if (this.points(p) < cost) return this.sendState(p, '服务点不够：' + n + ' 张请柬要 ' + cost + ' 点。');
    const slots = this.giveInvites(p, n, c);
    if (!slots) return this.sendState(p, '背包满了。');
    this.pay(p, cost);
    p.commitItems({ inv: slots });
    return this.sendState(p, '买了 ' + n + ' 张请柬，花了 ' + cost + ' 服务点。');
  }

  reschedule(p, d) {
    const c = this.coupleOf(p.id);
    if (!c || c.status !== 'engaged') return this.sendState(p, '你没有待举行的婚礼。');
    if (!this.atRegistrar(p)) return this.sendState(p, '请到结婚登记人那里改婚期。');
    const at = Math.trunc(Number(d.weddingAt));
    if (!(at > Date.now() - 60e3 && at < Date.now() + 60 * DAY)) return this.sendState(p, '婚期要在今后 60 天以内。');
    c.weddingAt = at;
    this.server.store.markDirty();
    const msg = '婚期改为 ' + fmtTime(at) + '。';
    const q = this.online(this.other(c, p.id).id);
    if (q) this.sendState(q, p.name + ' 把' + msg);
    return this.sendState(p, msg);
  }

  cancel(p) {
    const c = this.coupleOf(p.id);
    if (!c || c.status !== 'engaged') return this.sendState(p, '你没有待举行的婚礼。');
    delete this.data().couples[c.id];
    this.ceremonies.delete(c.id);
    this.server.store.markDirty();
    this.notify(this.other(c, p.id).id, p.name + ' 取消了你们的婚约。');
    return this.sendState(p, '婚约已取消（登记的服务点不退）。');
  }

  // ---------- divorce ----------
  divorce(p, d) {
    const c = this.coupleOf(p.id);
    if (!c || c.status !== 'married') return this.sendState(p, '你还没有结婚。');
    if (!this.atRegistrar(p)) return this.sendState(p, '请到结婚登记人那里办理离婚。');
    const force = !!d.force;
    const cost = force ? this.cfg('marryForceDivorcePoints', 200) : this.cfg('marryDivorcePoints', 100);
    if (this.points(p) < cost) return this.sendState(p, (force ? '强制' : '协议') + '离婚需要 ' + cost + ' 服务点。');
    if (force) { this.pay(p, cost); return this.finishDivorce(c, p, '强制离婚'); }
    const q = this.online(this.other(c, p.id).id);
    if (!q) return this.sendState(p, '协议离婚需要对方在线同意；对方不在线时只能强制离婚。');
    this.asks.set(q.id, { kind: 'divorce', fromId: p.id, expiresAt: Date.now() + ASK_MS });
    this.server.ext.send(q, 'marry_ask', { ask: 'divorce', from: p.name, expiresAt: Date.now() + ASK_MS });
    return this.sendState(p, '已经向 ' + q.name + ' 提出协议离婚，等待对方同意。');
  }

  answerDivorce(from, p, ok) {
    const c = this.coupleOf(from.id);
    if (!c || this.other(c, from.id).id !== p.id) return undefined;
    if (!ok) { this.tell(from, p.name + ' 不同意离婚。'); return this.tell(p, '你拒绝了离婚。'); }
    const cost = this.cfg('marryDivorcePoints', 100);
    if (this.points(from) < cost) { this.tell(p, from.name + ' 的服务点不够，离婚没有办成。'); return this.tell(from, '服务点不够 ' + cost + ' 点。'); }
    this.pay(from, cost);
    return this.finishDivorce(c, from, '协议离婚');
  }

  finishDivorce(c, by, how) {
    const b = this.data();
    delete b.couples[c.id];
    const until = Date.now() + this.cfg('marryCooldownDays', 7) * DAY;
    b.cooldown[c.a.id] = until; b.cooldown[c.b.id] = until;
    this.server.store.markDirty();
    const other = this.other(c, by.id);
    this.notify(other.id, by.name + ' 与你' + how + '了。');
    return this.sendState(by, how + '已办理。' + (this.cfg('marryCooldownDays', 7) ? '两人 ' + this.cfg('marryCooldownDays', 7) + ' 天内不能再登记结婚。' : ''));
  }

  // A message now, or at the next login.
  notify(chId, text) {
    const q = this.online(chId);
    if (q) { this.tell(q, text); this.sendState(q, text); return; }
    const n = this.data().notes; (n[chId] = n[chId] || []).push(text);
    this.server.store.markDirty();
  }
  onEntered(p) {
    const n = this.data().notes[p.id];
    if (n && n.length) { for (const t of n) this.tell(p, t); delete this.data().notes[p.id]; this.server.store.markDirty(); }
  }

  // ---------- the hall ----------
  hallOpen(c, now = Date.now()) { return now >= c.weddingAt - 30 * 60e3; }
  toHall(p, c) {
    if (p.scene && p.scene.mapRef === HALL && p.scene.world.endsWith('~w' + c.id)) return true;
    const r = this.server.transferPlayer(p, HALL, { x: HALL_SPAWN.x, y: HALL_SPAWN.y, instance: 'w' + c.id, world: c.world });
    return !r || r.success !== false;
  }

  enterHall(p) {
    const c = this.coupleOf(p.id);
    if (!c) return this.sendState(p, '你没有婚礼。');
    if (c.status === 'engaged' && !this.hallOpen(c)) return this.sendState(p, '婚礼教堂在婚期前 30 分钟开放（婚期 ' + fmtTime(c.weddingAt) + '）。');
    this.toHall(p, c);
    return undefined;
  }

  useInvite(p, from, it) {
    const c = it.wedding && this.data().couples[it.wedding];
    const items = this.server.features.items;
    if (!c) return items.err(p, 'use', 17, '这张请柬的婚礼已经取消了。');
    if (c.status === 'engaged' && !this.hallOpen(c)) return items.err(p, 'use', 17, '婚礼教堂在婚期前 30 分钟开放（婚期 ' + fmtTime(c.weddingAt) + '）。');
    if (c.status === 'married' && Date.now() > (c.marriedAt || 0) + 2 * 3600e3) return items.err(p, 'use', 17, '这场婚礼已经结束了。');
    if (c.world !== p.ch.world) return items.err(p, 'use', 17, '这场婚礼在别的区。');
    items.consume(p, from);
    p.commitItems({ inv: [from] });
    this.toHall(p, c);
    return undefined;
  }

  leaveHall(p) {
    if (!p.scene || p.scene.mapRef !== HALL) return;
    this.server.transferPlayer(p, LEAVE_TO.mapRef, { x: LEAVE_TO.x, y: LEAVE_TO.y, world: p.ch.world });
  }

  buyFirework(p, d) {
    const id = Math.trunc(Number(d.itemId));
    const n = Math.max(1, Math.min(99, Math.trunc(Number(d.count) || 1)));
    if (!FIREWORKS.includes(id)) return undefined;
    const t = cat.getTemplate(id);
    const cost = (t.buyPrice || 0) * n;
    if (p.ch.gold < cost) return this.sendState(p, '金币不够：' + n + ' 个' + t.name + '要 ' + cost + ' 金币。');
    const slots = this.give(p, id, n);
    if (!slots) return this.sendState(p, '背包满了。');
    p.ch.gold -= cost;
    p.paramsDirty = true; p.flushParams();
    p.commitItems({ inv: slots });
    this.server.store.markDirty();
    return this.sendState(p, '买了 ' + n + ' 个' + t.name + '，花了 ' + cost + ' 金币。');
  }

  // ---------- the ceremony ----------
  hallScene(c) { return this.server.scenes.get(c.world + '~w' + c.id + '|' + HALL) || null; }
  tick(now) {
    for (const c of Object.values(this.data().couples)) {
      if (c.status !== 'engaged') continue;
      const run = this.ceremonies.get(c.id);
      if (run) { if (now >= run.next) this.step(c, run, now); continue; }
      if (now < c.weddingAt || now > c.weddingAt + this.cfg('marryWindowMin', 40) * 60e3) continue;
      const sc = this.hallScene(c);
      if (!sc || !sc.players.has(c.a.id) || !sc.players.has(c.b.id)) continue;
      const r = { step: 0, next: now };
      this.ceremonies.set(c.id, r);
      this.step(c, r, now);
    }
  }

  say(sc, text) { const m = this.server.systemChat('神父：' + text, { from: '神父' }); for (const q of sc.players.values()) q.send(this.server.op.CHAT_MESSAGE, m); }

  step(c, r, now) {
    const sc = this.hallScene(c);
    const man = c.a.name, woman = c.b.name;
    if (!sc || !sc.players.has(c.a.id) || !sc.players.has(c.b.id)) {
      this.ceremonies.delete(c.id);
      if (sc) this.say(sc, '新人离开了教堂，婚礼暂停。两位新人都回到教堂后会重新开始。');
      return;
    }
    const lines = [
      '亲爱的来宾们，今天我们聚集在这里，见证 ' + man + ' 与 ' + woman + ' 的婚礼。',
      man + '，你愿意娶 ' + woman + ' 为妻，无论顺境还是逆境、富有还是贫穷、健康还是疾病，都爱她、珍惜她，直到永远吗？',
      man + '：我愿意。',
      woman + '，你愿意嫁给 ' + man + '，无论顺境还是逆境、富有还是贫穷、健康还是疾病，都爱他、珍惜他，直到永远吗？',
      woman + '：我愿意。',
      '这是两位新人的爱的宣言：「' + c.vow + '」',
      '请两位新人交换戒指。',
      '现在，新郎可以亲吻新娘了。',
    ];
    if (r.step < lines.length) {
      this.say(sc, lines[r.step]);
      if (r.step === lines.length - 1) {
        const ia = this.server.features.interaction;
        const pa = this.online(c.a.id), pb = this.online(c.b.id);
        if (ia && pa && pb) {
          pa.path = []; pb.path = [];
          ia.sceneBroadcast(sc, 'perform', { action: 'kiss', fromPlayerId: pa.id, targetPlayerId: pb.id, durationMs: 3600 });
        }
      }
      r.step += 1; r.next = now + STEP_MS;
      return;
    }
    this.say(sc, '我宣布，' + man + ' 与 ' + woman + ' 正式结为夫妻！请大家为他们祝福！');
    c.status = 'married'; c.marriedAt = now;
    this.ceremonies.delete(c.id);
    this.server.store.markDirty();
    const msg = this.server.systemChat('【婚讯】恭喜 ' + man + ' 与 ' + woman + ' 喜结良缘！');
    for (const q of this.server.playersById.values()) q.send(this.server.op.CHAT_MESSAGE, msg);
    for (const id of [c.a.id, c.b.id]) { const q = this.online(id); if (q) this.sendState(q, '恭喜你们结为夫妻！'); }
  }

  // ---------- admin ----------
  adminView() {
    return Object.values(this.data().couples).map((c) => ({
      id: c.id, world: c.world, man: c.a.name, woman: c.b.name, status: c.status, vow: c.vow,
      weddingAt: c.weddingAt, weddingText: fmtTime(c.weddingAt), marriedText: c.marriedAt ? fmtTime(c.marriedAt) : '',
    })).sort((x, y) => y.weddingAt - x.weddingAt);
  }
  adminRemove(id) {
    const c = this.data().couples[id];
    if (!c) throw new Error('没有这对新人');
    delete this.data().couples[id];
    this.ceremonies.delete(id);
    this.server.store.markDirty();
    for (const x of [c.a, c.b]) this.notify(x.id, '管理员解除了 ' + c.a.name + ' 与 ' + c.b.name + ' 的' + (c.status === 'married' ? '婚姻' : '婚约') + '。');
    return '已解除 ' + c.a.name + ' 与 ' + c.b.name + ' 的' + (c.status === 'married' ? '婚姻' : '婚约') + '（不收服务点，没有再婚等待）';
  }
  adminStartNow(id) {
    const c = this.data().couples[id];
    if (!c || c.status !== 'engaged') throw new Error('只有待举行的婚礼能改');
    c.weddingAt = Date.now();
    this.server.store.markDirty();
    return '婚期已改为现在，两位新人进教堂就开始';
  }
}

module.exports = { Marriage, INVITE, FIREWORKS };
