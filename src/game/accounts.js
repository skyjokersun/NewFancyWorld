'use strict';
// Accounts: e-mail verification codes, registration and password login.
const crypto = require('crypto');
const config = require('../config');
const log = require('../util/log');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_SEC = 60;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const h = crypto.scryptSync(password, rec.salt, 32);
  const expected = Buffer.from(rec.hash, 'hex');
  return expected.length === h.length && crypto.timingSafeEqual(h, expected);
}

function validPassword(p) {
  if (typeof p !== 'string') return false;
  const n = Array.from(p).length;
  return n >= 8 && n <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(p);
}

class Accounts {
  constructor(store, mailer) {
    this.store = store;
    this.mailer = mailer;
    this.codes = new Map(); // email -> {code, expiresAt, sentAt, attempts}
  }

  normalizeEmail(e) { return String(e || '').trim().toLowerCase(); }
  find(email) { return this.store.data.accounts[this.normalizeEmail(email)] || null; }

  async requestCode(rawEmail, purpose) {
    const email = this.normalizeEmail(rawEmail);
    if (!EMAIL_RE.test(email)) return { success: false, message: '邮箱地址格式不正确' };
    if (purpose === 'register' && this.find(email)) return { success: false, message: '该邮箱已注册，请直接登录' };
    const now = Date.now();
    const prev = this.codes.get(email);
    if (prev && now - prev.sentAt < RESEND_SEC * 1000) {
      const retryAfterSec = Math.ceil((RESEND_SEC * 1000 - (now - prev.sentAt)) / 1000);
      return { success: false, message: '验证码发送过于频繁，请稍后再试', retryAfterSec };
    }
    const code = config.devEmailCode && /^\d{6}$/.test(config.devEmailCode)
      ? config.devEmailCode : String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    this.codes.set(email, { code, purpose, sentAt: now, expiresAt: now + CODE_TTL_MS, attempts: 0 });
    let delivered = false;
    try {
      delivered = this.mailer ? await this.mailer.send(email, '奇域注册验证码', '您的验证码是 ' + code + '，10 分钟内有效。') : false;
    } catch (e) {
      log.warn('mail delivery failed', email, e.message);
    }
    log.info('email code', email, config.devMode ? code : '(hidden)', delivered ? 'mailed' : 'not mailed');
    if (!delivered && !config.devMode && process.env.QIYU_ALLOW_REGISTER_WITHOUT_MAIL !== '1') {
      this.codes.delete(email);
      return { success: false, message: '验证码邮件发送失败，请稍后重试' };
    }
    const message = delivered ? '验证码已发送到 ' + email : '验证码：' + code + '（本地服务未配置发信，邮箱所有权未验证）';
    return { success: true, message, retryAfterSec: RESEND_SEC };
  }

  register(rawEmail, password, code) {
    const email = this.normalizeEmail(rawEmail);
    if (!EMAIL_RE.test(email)) return { success: false, message: '邮箱地址格式不正确' };
    if (!validPassword(password)) return { success: false, message: '密码须为8–128个字符，不能包含控制字符' };
    if (this.find(email)) return { success: false, message: '该邮箱已注册，请直接登录' };
    const rec = this.codes.get(email);
    if (!rec || Date.now() > rec.expiresAt) return { success: false, message: '验证码已过期，请重新获取' };
    rec.attempts += 1;
    if (rec.attempts > 8) { this.codes.delete(email); return { success: false, message: '验证码错误次数过多，请重新获取' }; }
    if (String(code || '').trim() !== rec.code) return { success: false, message: '验证码不正确' };
    this.codes.delete(email);
    const id = 'a' + this.store.nextId('account');
    this.store.data.accounts[email] = {
      id, email, password: hashPassword(password), createdAt: Date.now(), characters: {}, banned: false,
    };
    this.store.markDirty();
    log.info('account registered', email, id);
    return { success: true, message: '注册成功', email };
  }

  // The admin page makes an account without the e-mail code.
  create(rawEmail, password) {
    const email = this.normalizeEmail(rawEmail);
    if (!EMAIL_RE.test(email)) return { success: false, message: '邮箱地址格式不正确' };
    if (!validPassword(password)) return { success: false, message: '密码须为8–128个字符，不能包含控制字符' };
    if (this.find(email)) return { success: false, message: '该邮箱已注册' };
    const id = 'a' + this.store.nextId('account');
    this.store.data.accounts[email] = {
      id, email, password: hashPassword(password), createdAt: Date.now(), characters: {}, banned: false,
    };
    this.store.markDirty();
    log.info('account created on the admin page', email, id);
    return { success: true, message: '已创建账号 ' + email, email, id };
  }

  login(rawEmail, password) {
    const acc = this.find(rawEmail);
    if (!acc || !verifyPassword(String(password || ''), acc.password)) return { ok: false, message: '账号或密码错误' };
    if (acc.banned) return { ok: false, message: '账号已被封禁' };
    acc.lastLoginAt = Date.now();
    this.store.markDirty();
    return { ok: true, account: acc };
  }
}

module.exports = { Accounts, hashPassword, verifyPassword, validPassword, EMAIL_RE };
