'use strict';
// Bank coffers (银行保险箱): 40-slot item + gold storage paid with service points.
// Terms shown by the client: 50 points to open, 10 points per month, items kept
// 3 months past expiry, cancel within 3 days when empty for a 5 point fee.
const crypto = require('crypto');
const { cloneItem } = require('../game/player');
const A = require('../game/affixes');

const SLOT_COUNT = 40;
const MAX_STORED_GOLD = 5e7;
const OPEN_FEE = 50;
const MONTH_FEE = 10;
const CANCEL_FEE = 5;
const MONTH_MS = 30 * 864e5;
const CANCEL_WINDOW_MS = 3 * 864e5;
const RETAIN_MS = 3 * MONTH_MS;
const MAX_COFFERS = 20;

function hashIdentity(v) { return v ? crypto.createHash('sha256').update('qiyu-bank:' + v).digest('hex') : ''; }

class Bank {
  register(server) {
    this.server = server;
    this.coffers = server.store.bucket('bankCoffers');
    server.on(server.op.BANK_SERVICE, server.requirePlayer((p, d) => this.handle(p, d || {})));
    server.events.on('playerMapChanging', (p) => { delete p.bankActiveCoffer; });
  }

  points(p) {
    const acc = p.session.account;
    if (acc.servicePoints == null) acc.servicePoints = this.server.config.startServicePoints;
    return acc.servicePoints;
  }

  owned(p) {
    const now = Date.now();
    const out = [];
    for (const c of Object.values(this.coffers)) {
      if (c.ownerId !== p.id) continue;
      if (c.expiresAt + RETAIN_MS < now) { delete this.coffers[c.number]; this.server.store.markDirty(); continue; }
      out.push(c);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  state(p) {
    const now = Date.now();
    const active = p.bankActiveCoffer && this.coffers[p.bankActiveCoffer];
    if (active) for (const it of active.slots) A.migrateItem(it);
    return {
      bankRevision: p.ch.bankRevision || 0,
      itemRevision: p.ch.revision,
      pocketGold: p.ch.gold,
      servicePoints: this.points(p),
      coffers: this.owned(p).map((c) => ({ number: c.number, status: c.expiresAt > now ? 'active' : 'expired', expiresAt: c.expiresAt })),
      activeCoffer: active ? { number: active.number, slots: active.slots.map(cloneItem), storedGold: active.storedGold, expiresAt: active.expiresAt } : null,
    };
  }

  send(p, type, extra = {}) {
    p.send(this.server.op.BANK_SERVICE_EVENT, Object.assign({ type, serverSeq: this.server.nextSeq() }, this.state(p), extra));
  }

  fail(p, action, message) { this.send(p, 'error', { action, message }); }

  bump(p) { p.ch.bankRevision = (p.ch.bankRevision || 0) + 1; this.server.store.markDirty(); }

  handle(p, d) {
    if (!p.scene || p.scene.mapRef !== 'bank') return this.fail(p, d.type, '请到银行柜台办理业务。');
    switch (d.type) {
      case 'query': return this.send(p, 'state', { action: 'query' });
      case 'apply': return this.apply(p, d);
      case 'open': return this.open(p, d);
      case 'save': return this.save(p, d);
      case 'renew': return this.renew(p, d);
      case 'close': return this.close(p, d);
      case 'recover': return this.recover(p, d);
      default: return this.fail(p, d.type, '对不起，服务还没有开通！');
    }
  }

  newNumber() {
    for (;;) {
      const n = String(10000000 + crypto.randomInt(90000000));
      if (!this.coffers[n]) return n;
    }
  }

  apply(p, d) {
    const identity = String(d.identityNumber || '').trim();
    if (identity && !/^[0-9A-Za-z]{6,25}$/.test(identity)) return this.fail(p, 'apply', '身份证号码格式不正确。');
    if (this.owned(p).length >= MAX_COFFERS) return this.fail(p, 'apply', '您的保险箱数量已经达到上限。');
    const cost = OPEN_FEE + MONTH_FEE;
    if (this.points(p) < cost) return this.fail(p, 'apply', '您的服务点数不足，开户需要 ' + cost + ' 点（开户费 50 点 + 首月服务费 10 点）。');
    p.session.account.servicePoints -= cost;
    const now = Date.now();
    const number = this.newNumber();
    this.coffers[number] = {
      number, ownerId: p.id, identity: hashIdentity(identity), createdAt: now, expiresAt: now + MONTH_MS,
      renewed: false, monthsPaid: 1, slots: new Array(SLOT_COUNT).fill(null), storedGold: 0,
    };
    this.bump(p);
    this.send(p, 'result', { action: 'apply', assignedCofferNumber: number, message: '保险箱申请成功，号码 ' + number + '，有效期 30 天。' });
  }

  find(p, number) {
    const c = this.coffers[String(number || '').replace(/\D+/g, '')];
    return c && c.ownerId === p.id ? c : null;
  }

  open(p, d) {
    const c = this.find(p, d.cofferNumber);
    if (!c) return this.fail(p, 'open', '请正确输入保险箱号码！！');
    if (c.expiresAt <= Date.now()) return this.fail(p, 'open', '该保险箱已经过期，请先续费。');
    p.bankActiveCoffer = c.number;
    this.send(p, 'state', { action: 'open' });
  }

  // The client sends the full draft of both grids; accept it only if it is a
  // permutation of the items currently in the bag and the coffer.
  save(p, d) {
    const c = this.find(p, d.cofferNumber);
    if (!c || p.bankActiveCoffer !== c.number) return this.fail(p, 'save', '请先打开保险箱。');
    if (c.expiresAt <= Date.now()) return this.fail(p, 'save', '该保险箱已经过期，请先续费。');
    if (Number(d.bankRevision) !== (p.ch.bankRevision || 0)) return this.fail(p, 'save', '保险箱内容已经变化，请重新打开。');
    const inv = Array.isArray(d.inventorySlots) ? d.inventorySlots : null;
    const cof = Array.isArray(d.cofferSlots) ? d.cofferSlots : null;
    if (!inv || !cof || inv.length !== p.ch.inventory.length || cof.length !== SLOT_COUNT) return this.fail(p, 'save', '数据有误，请重新打开保险箱。');
    const pool = new Map();
    for (const it of p.ch.inventory.concat(c.slots)) if (it) pool.set(it.seqId, it);
    const used = new Set();
    const take = (slot) => {
      if (!slot) return null;
      const it = pool.get(slot.seqId);
      if (!it || used.has(it.seqId) || Number(slot.count) !== it.count) throw new Error('mismatch');
      used.add(it.seqId);
      return it;
    };
    let nextInv, nextCof;
    try { nextInv = inv.map(take); nextCof = cof.map(take); } catch (_) { return this.fail(p, 'save', '物品数据不一致，请重新打开保险箱。'); }
    if (used.size !== pool.size) return this.fail(p, 'save', '物品数据不一致，请重新打开保险箱。');
    for (const it of nextCof) if (it && it.bound) return this.fail(p, 'save', '绑定物品不能存入保险箱：' + it.name);
    const total = p.ch.gold + c.storedGold;
    const stored = Math.trunc(Number(d.storedGold));
    const pocket = Math.trunc(Number(d.pocketGold));
    if (!Number.isFinite(stored) || stored < 0 || stored > MAX_STORED_GOLD || stored > total || pocket !== total - stored) return this.fail(p, 'save', '金额有误。');
    const changedInv = [];
    nextInv.forEach((it, i) => { if (p.ch.inventory[i] !== it) changedInv.push(i); });
    p.ch.inventory = nextInv;
    c.slots = nextCof;
    c.storedGold = stored;
    p.ch.gold = pocket;
    this.bump(p);
    p.commitItems({ inv: changedInv });
    this.send(p, 'result', { action: 'save', message: '物品已经保管好了。' });
  }

  renew(p, d) {
    const months = Math.trunc(Number(d.months));
    if (!Number.isFinite(months) || months < 1 || months > 120) return this.fail(p, 'renew', '请输入正确的月数（1-120）。');
    const list = (Array.isArray(d.cofferNumbers) ? d.cofferNumbers : []).map((n) => this.find(p, n)).filter(Boolean);
    const now = Date.now();
    const targets = d.expiredOnly ? list.filter((c) => c.expiresAt <= now) : list;
    if (!targets.length) return this.fail(p, 'renew', '没有符合条件的保险箱。');
    const cost = targets.length * months * MONTH_FEE;
    if (this.points(p) < cost) return this.fail(p, 'renew', '服务点数不足，本次续费需要 ' + cost + ' 点。');
    p.session.account.servicePoints -= cost;
    for (const c of targets) {
      c.expiresAt = Math.max(c.expiresAt, now) + months * MONTH_MS;
      c.monthsPaid += months; c.renewed = true;
    }
    this.bump(p);
    this.send(p, 'result', { action: 'renew', message: '续费成功，共 ' + targets.length + ' 个保险箱，扣除 ' + cost + ' 点服务点数。' });
  }

  close(p, d) {
    const c = this.find(p, d.cofferNumber);
    if (!c) return this.fail(p, 'close', '请正确输入保险箱号码！！');
    if (c.slots.some(Boolean) || c.storedGold > 0) return this.fail(p, 'close', '保险箱内还有物品或金钱，不能注销。');
    const now = Date.now();
    if (c.renewed || now - c.createdAt > CANCEL_WINDOW_MS) return this.fail(p, 'close', '只有开户三天内且未续费的空保险箱可以注销。');
    const refund = OPEN_FEE - CANCEL_FEE + MONTH_FEE * Math.max(0, Math.floor((c.expiresAt - now) / MONTH_MS));
    p.session.account.servicePoints = this.points(p) + refund;
    delete this.coffers[c.number];
    if (p.bankActiveCoffer === c.number) delete p.bankActiveCoffer;
    this.bump(p);
    this.send(p, 'result', { action: 'close', message: '保险箱 ' + c.number + ' 已注销，退还 ' + refund + ' 点服务点数。' });
  }

  recover(p, d) {
    const identity = String(d.identityNumber || '').trim();
    if (!identity) return this.fail(p, 'recover', '请输入您的身份证号码。');
    const mine = this.owned(p).filter((c) => c.identity && c.identity === hashIdentity(identity));
    if (!mine.length) return this.fail(p, 'recover', '对不起，我们无法确认您的身份。');
    if (d.answer == null) {
      return this.send(p, 'result', { action: 'recover_challenge', recoveryQuestion: '您的角色名称是什么？', message: '请回答验证问题。' });
    }
    if (String(d.answer).trim().toLowerCase() !== p.name.toLowerCase()) return this.fail(p, 'recover', '答案不正确。');
    this.send(p, 'result', { action: 'recover', recoveredCofferNumbers: mine.map((c) => c.number), message: '已为您找到 ' + mine.length + ' 个保险箱。' });
  }
}

module.exports = { Bank };
