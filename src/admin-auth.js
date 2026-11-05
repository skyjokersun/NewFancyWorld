'use strict';
// Password for the admin page (its own port). The password is the first non-comment line of a
// plain text file next to the server (admin-password.txt by default); edits to the
// file apply to the next login without a restart, and log everyone else out.
// A missing file is created with a random password, printed once in the log.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'qiyu_admin';
const SESSION_MS = 12 * 3600 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

class AdminAuth {
  constructor(file, log) {
    this.file = path.resolve(file);
    this.log = log;
    this.sessions = new Map();   // token -> { expiresAt, pw: sha of the password it was made with }
    this.fails = new Map();      // ip -> { count, until }
    this.ensureFile();
  }

  ensureFile() {
    if (fs.existsSync(this.file)) return;
    const pw = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, '# 奇域管理后台密码：把下面这一行改成你想要的密码，保存后下次登录就生效（不用重启服务端）。\n# 以 # 开头的行是说明，会被忽略。\n' + pw + '\n');
    if (this.log) this.log.info('已生成管理后台密码文件 ' + this.file + '，初始密码：' + pw);
  }

  password() {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (e) { this.ensureFile(); text = fs.readFileSync(this.file, 'utf8'); }
    const line = text.replace(/^﻿/, '').split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('#'));
    return line || '';
  }

  token(req) {
    const m = /(?:^|;\s*)qiyu_admin=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
    return m ? m[1] : '';
  }

  ok(req) {
    const t = this.token(req);
    const s = t && this.sessions.get(t);
    if (!s) return false;
    const pw = this.password();
    if (!pw || s.pw !== sha(pw) || s.expiresAt < Date.now()) { this.sessions.delete(t); return false; }
    return true;
  }

  // Returns { ok, cookie } or { ok:false, error }.
  login(ip, given) {
    const now = Date.now();
    const f = this.fails.get(ip);
    if (f && f.until > now) return { ok: false, error: '密码错误次数太多，请 ' + Math.ceil((f.until - now) / 60000) + ' 分钟后再试' };
    const pw = this.password();
    if (!pw) return { ok: false, error: '密码文件里没有密码：请打开 ' + this.file + ' 写一行密码' };
    const a = Buffer.from(sha(given || '')), b = Buffer.from(sha(pw));
    if (!crypto.timingSafeEqual(a, b)) {
      const n = (f && f.until <= now && f.count >= MAX_FAILS ? 0 : (f ? f.count : 0)) + 1;
      this.fails.set(ip, { count: n, until: n >= MAX_FAILS ? now + LOCK_MS : 0 });
      return { ok: false, error: n >= MAX_FAILS ? '密码错误次数太多，请 5 分钟后再试' : '密码不对' };
    }
    this.fails.delete(ip);
    for (const [t, s] of this.sessions) if (s.expiresAt < now) this.sessions.delete(t);
    const t = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(t, { expiresAt: now + SESSION_MS, pw: sha(pw) });
    return { ok: true, cookie: COOKIE + '=' + t + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + SESSION_MS / 1000 };
  }

  logout(req) {
    this.sessions.delete(this.token(req));
    return COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
  }
}

const LOGIN_PAGE = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>奇域管理后台 - 登录</title>' +
  '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#2b2116;font:15px "Microsoft YaHei",sans-serif;color:#3a2c17}' +
  'form{background:#f6e7c8;padding:26px 28px;border-radius:8px;width:300px;max-width:calc(100vw - 32px);box-shadow:0 8px 30px rgba(0,0,0,.4)}' +
  'h1{font-size:18px;margin:0 0 16px}input{width:100%;box-sizing:border-box;padding:8px 10px;font-size:15px;border:1px solid #b89a66;border-radius:5px}' +
  'button{margin-top:12px;width:100%;padding:8px;font-size:15px;background:#7a5a2a;color:#fff;border:0;border-radius:5px;cursor:pointer}#e{color:#b3261e;min-height:20px;margin-top:8px;font-size:13px}' +
  'p{font-size:12px;color:#7a6440;margin:12px 0 0}</style></head><body><form id="f"><h1>奇域管理后台</h1><input id="p" type="password" placeholder="管理员密码" autofocus autocomplete="current-password">' +
  '<button>登录</button><div id="e"></div><p>密码在服务端文件夹里的 admin-password.txt，可以用记事本修改。</p></form>' +
  '<script>document.getElementById("f").onsubmit=function(ev){ev.preventDefault();fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("p").value})})' +
  '.then(function(r){return r.json().then(function(j){if(r.ok)location.reload();else document.getElementById("e").textContent=j.error||"登录失败";});});};</script></body></html>';

module.exports = { AdminAuth, LOGIN_PAGE };
