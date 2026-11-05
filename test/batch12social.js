'use strict';
// Twelfth batch: wedding (register, rings, invitations, hall, ceremony, divorce) and
// long-term team (apply, approve, join, donate, coffer, board, leave).
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { TestClient, OP } = require('./client');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
const adminPort = Number(process.argv[3] || 8091);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
function admin(method, p, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: adminPort, path: '/api/' + p, method, headers: Object.assign({ 'Content-Type': 'application/json', Cookie: cookie }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, (r) => {
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => {
        if (r.headers['set-cookie']) cookie = r.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
        const j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (r.statusCode >= 400) rej(new Error(p + ': ' + (j.error || r.statusCode))); else res(j);
      });
    });
    req.on('error', rej); if (data) req.write(data); req.end();
  });
}
async function newPlayer(tag, gender) {
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  const email = tag + Date.now() + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' });
  await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123' });
  await c.wait(OP.LOGIN_SUCCESS);
  c.nick = tag.slice(0, 2) + String(Date.now()).slice(-7);
  c.send(OP.CHARACTER_CREATE, { nickname: c.nick, appearance: { gender } });
  await c.wait(OP.CHARACTER_CREATE_RESULT); await c.wait(OP.LOGIN_SUCCESS);
  c.chat = (m) => c.send(OP.CHAT, { channel: 'world', message: m });
  c.ext = (kind, d) => c.send(7100, Object.assign({ kind }, d || {}));
  c.st = (kind, pred, ms) => c.wait(7110, (d) => d.kind === kind && (!pred || pred(d)), ms).then((m) => m.data);
  c.bag = async () => { c.send(OP.ITEM_QUERY, {}); return (await c.wait(OP.ITEM_STATE)).data.inventory.slots; };
  return c;
}
(async () => {
  const pw = fs.readFileSync(path.join(__dirname, '..', 'admin-password.txt'), 'utf8').split('\n').find((l) => l.trim() && !l.startsWith('#')).trim();
  await admin('POST', 'login', { password: pw });
  const m = await newPlayer('gm', 'man'); const w = await newPlayer('gw', 'women'); const g = await newPlayer('gg', 'man');
  for (const c of [m, w]) { c.chat('/points 600'); c.chat('/go townhouse'); }
  await sleep(800);
  m.ext('marry_propose', { name: w.nick, weddingAt: Date.now() + 2000, vow: '执子之手，与子偕老', invites: 3 });
  console.log('propose:', (await m.st('marry')).message);
  const ask = await w.st('marry_ask'); console.log('ask:', ask.from, ask.vow);
  w.ext('marry_answer', { accept: true });
  const ok = await w.st('marry', (d) => d.couple); console.log('registered:', ok.message, 'points', ok.points);
  assert.strictEqual(ok.points, 550);
  const bag = await w.bag();
  assert(bag.some((it) => it && it.itemId === 1313), 'woman ring'); const inv = bag.find((it) => it && it.itemId === 2606);
  assert(inv && inv.count === 3, 'invitations'); console.log('invite desc:', inv.desc);
  // Give the guest an invitation by trade is long; use the admin bag? Simply buy more and check stacks.
  m.ext('marry_invites', { count: 2 }); console.log('buy invites:', (await m.st('marry', (d) => /请柬/.test(d.message))).message);
  await sleep(2200);
  // Enter the hall: man from registrar, woman by invitation.
  m.ext('marry_enter'); await m.wait(OP.MAP_SWITCH_RESULT, (d) => d.mapRef === 'temple_m_v');
  const wb = await w.bag(); w.send(OP.ITEM_USE, { fromIndex: wb.findIndex((it) => it && it.itemId === 2606) });
  await w.wait(OP.MAP_SWITCH_RESULT, (d) => d.mapRef === 'temple_m_v');
  console.log('both in hall');
  const kiss = await m.wait(OP.CHARACTER_INTERACTION_EVENT, (d) => d.type === 'perform' && d.action === 'kiss', 60000); console.log('kiss performed', !!kiss);
  await m.wait(OP.CHAT_MESSAGE, (d) => /婚讯/.test(d.message), 10000); console.log('announcement ok');
  const soc = await admin('GET', 'social'); const cp = soc.couples.find((c) => c.man === m.nick); console.log('admin couple:', cp.status); assert.strictEqual(cp.status, 'married');
  m.ext('wedding_leave'); await m.wait(OP.MAP_SWITCH_RESULT, (d) => d.mapRef === 'temple_m');
  m.chat('/go townhouse'); w.chat('/go townhouse'); await sleep(800);
  m.ext('marry_divorce', { force: false }); await w.st('marry_ask', (d) => d.ask === 'divorce'); w.ext('marry_answer', { accept: true });
  const dv = await m.st('marry', (d) => /离婚已办理/.test(d.message)); console.log('divorce:', dv.message, 'points', dv.points);
  m.ext('marry_propose', { name: w.nick, weddingAt: Date.now() + 60000, vow: 'x', invites: 1 });
  console.log('cooldown:', (await m.st('marry', (d) => /等待期/.test(d.message))).message);

  // Team.
  g.chat('/points 600'); g.chat('/gold 5000'); g.chat('/level 12'); g.chat('/go office_team'); await sleep(800);
  g.ext('team_apply', { name: '测试团' + String(Date.now()).slice(-4), purpose: '一起玩' });
  console.log('apply:', (await g.st('team', (d) => d.message)).message);
  let tv = await admin('GET', 'social'); const t = tv.teams.teams.find((x) => x.leaderName === g.nick); assert.strictEqual(t.status, 'pending');
  await admin('POST', 'team/' + t.id, { op: 'approve', building: 'team_r_f1', door: '飞麒社' });
  await g.wait(OP.CHAT_MESSAGE, (d) => /已经批准/.test(d.message)); console.log('approved');
  w.chat('/go office_team'); await sleep(600);
  w.ext('team_join', { id: t.id }); console.log('join:', (await w.st('team', (d) => d.message)).message);
  g.ext('team_member', { op: 'accept', id: w.chId || (await (async () => { g.ext('team_query'); const s = await g.st('team'); return s.mine.applicants[0].id; })()) });
  console.log('accept:', (await g.st('team', (d) => /加入/.test(d.message))).message);
  w.ext('team_donate', { points: 10 }); console.log('newbie donate:', (await w.st('team', (d) => d.message)).message);
  g.ext('team_donate', { points: 100 }); const dn = await g.st('team', (d) => /捐了/.test(d.message)); console.log('donate:', dn.mine.teamPoints, dn.mine.contribution);
  g.chat('/go team_r_f1'); await sleep(600);
  g.ext('team_door', { door: '飞麒社,troom_01/39' }); const door = await g.st('team', (d) => d.doorView); console.log('door list:', door.doorView.list.map((x) => x.name).join(','));
  g.ext('team_enter', { id: t.id }); await g.wait(OP.MAP_SWITCH_RESULT, (d) => d.mapRef === 'teamoffice');
  g.ext('team_coffer', { op: 'password', password: '123456' }); console.log((await g.st('team', (d) => /密码/.test(d.message))).message);
  g.ext('team_coffer', { op: 'deposit', gold: 2000 }); console.log((await g.st('team', (d) => /存入/.test(d.message))).message);
  g.ext('team_coffer', { op: 'withdraw', gold: 500, password: '111111' }); console.log((await g.st('team', (d) => /密码不对/.test(d.message))).message);
  g.ext('team_coffer', { op: 'withdraw', gold: 500, password: '123456' }); const wd = await g.st('team', (d) => /取出/.test(d.message)); console.log(wd.message, 'coffer', wd.mine.coffer);
  g.ext('team_post', { text: '今晚八点集合' }); const bp = await g.st('team', (d) => /留言已贴上/.test(d.message)); assert.strictEqual(bp.mine.posts.length, 1);
  g.ext('team_exit'); await g.wait(OP.MAP_SWITCH_RESULT, (d) => d.mapRef === 'team_r_f1'); console.log('left office');
  w.ext('team_leave'); console.log('leave:', (await w.st('team', (d) => /退出/.test(d.message))).message);
  await admin('POST', 'team/' + t.id, { op: 'disband' });
  console.log('batch12 social ok'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
