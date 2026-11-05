'use strict';
// Twelfth batch: admin-made profession, admin-made monster, uploads.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { TestClient, OP } = require('./client');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
const adminPort = Number(process.argv[3] || 8091);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
function admin(method, p, body, raw) {
  return new Promise((res, rej) => {
    const data = raw || (body ? JSON.stringify(body) : null);
    const req = http.request({ host: '127.0.0.1', port: adminPort, path: '/api/' + p, method, headers: Object.assign({ 'Content-Type': raw ? 'application/octet-stream' : 'application/json', Cookie: cookie }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, (r) => {
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => {
        if (r.headers['set-cookie']) cookie = r.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
        const j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (r.statusCode >= 400) rej(new Error(p + ': ' + (j.error || r.statusCode))); else res(j);
      });
    });
    req.on('error', rej); if (data) req.write(data); req.end();
  });
}
(async () => {
  const pw = fs.readFileSync(path.join(__dirname, '..', 'admin-password.txt'), 'utf8').split('\n').find((l) => l.trim() && !l.startsWith('#')).trim();
  await admin('POST', 'login', { password: pw });
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  const email = 'np' + Date.now() + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' }); await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123' }); await c.wait(OP.LOGIN_SUCCESS);
  const nick = 'np' + String(Date.now()).slice(-7);
  c.send(OP.CHARACTER_CREATE, { nickname: nick, appearance: { gender: 'man' } }); await c.wait(OP.CHARACTER_CREATE_RESULT); await c.wait(OP.LOGIN_SUCCESS);
  c.send(OP.CHAT, { channel: 'world', message: '/prof warrior' }); c.send(OP.CHAT, { channel: 'world', message: '/level 20' }); await sleep(500);
  const pv = await admin('GET', 'professions');
  const f = Object.assign({}, pv.original.warrior, { attack: '1234' });
  const made = await admin('POST', 'profession/new', { name: '狂战士', base: 'warrior', tags: ['warrior', 'archer'], formulas: f });
  console.log(made.done[0]); const cp = made.view.list.find((x) => x.name === '狂战士');
  let bad = null; try { await admin('POST', 'profession/new', { name: '坏', base: 'warrior', formulas: Object.assign({}, f, { attack: 'S+' }) }); } catch (e) { bad = e.message; } console.log('bad:', bad); assert(bad);
  c.queue.length = 0;
  const as = await admin('POST', 'profession/' + cp.id + '/assign', { name: nick }); console.log(as.done[0]);
  const lab = await c.wait(7110, (d) => d.kind === 'custom_profession'); console.log('client label:', lab.data.base, lab.data.label);
  const pr = await c.wait(OP.ITEM_DELTA, (d) => (d.changes || []).some((x) => x.type === 'set_params' && JSON.stringify(x.params).includes('1234')), 3000).catch(() => null);
  console.log('attack from own formula:', pr ? 'ok' : 'NOT SEEN'); assert(pr);
  await admin('POST', 'profession/' + cp.id + '/delete', {});
  const mm = await admin('GET', 'custom-monsters'); const base = mm.monsters[0];
  const nm = await admin('POST', 'custom-monster/new', { from: base.monsterId, name: '测试大狐', model: base.model }); console.log(nm.done[0]);
  const id = nm.custom[nm.custom.length - 1].monsterId;
  const mons = await admin('GET', 'monsters'); assert(mons.monsters.some((m) => m.monsterId === id), 'custom monster in monster list');
  await admin('POST', 'custom-monster/' + id + '/delete', {});
  // A fake zip with a stand.ale only.
  const zipLike = Buffer.from('not a zip');
  let ue = null; try { await admin('POST', 'upload/map?name=x.zip', null, zipLike); } catch (e) { ue = e.message; } console.log('bad zip:', ue);
  let pe = null; try { await admin('POST', 'upload/monster?name=stand.png', null, Buffer.from([137, 80, 78, 71])); } catch (e) { pe = e.message; } assert(pe, 'png refused'); console.log('png refused:', pe);
  console.log('batch12 new ok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
