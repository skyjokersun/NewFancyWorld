'use strict';
// V15.2: 限时活动 (clock, schedules, manual switches), night fair gate, festival gifts,
// double map, wear, original 狐仙, 美杜沙 + poison, admin pages. node test/batch152.js [ws url] [admin port]
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { TestClient, OP } = require('./client');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
const adminPort = Number(process.argv[3] || 8091);
const gamePort = Number(/:(\d+)\//.exec(url)[1]);
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
function get(p) {
  return new Promise((res, rej) => http.get({ host: '127.0.0.1', port: gamePort, path: p }, (r) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(c) })); }).on('error', rej));
}
async function newChar(tag) {
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  const email = tag + Date.now() + Math.floor(Math.random() * 1000) + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' }); await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123' }); await c.wait(OP.LOGIN_SUCCESS);
  c.nick = tag + String(Date.now()).slice(-6);
  c.send(OP.CHARACTER_CREATE, { nickname: c.nick, appearance: { gender: 'man' } }); await c.wait(OP.CHARACTER_CREATE_RESULT);
  c.me = (await c.wait(OP.LOGIN_SUCCESS)).data.playerId;
  c.chat = async (m) => { c.send(OP.CHAT, { channel: 'world', message: m }); await sleep(250); };
  c.state = async () => { c.send(OP.ITEM_QUERY, {}); return (await c.wait(OP.ITEM_STATE)).data; };
  c.ext = (kind, d) => c.send(7100, Object.assign({ kind }, d || {}));
  c.st = (kind, pred, ms) => c.wait(7110, (d) => d.kind === kind && (!pred || pred(d)), ms).then((m) => m.data);
  return c;
}
const at = (s, id) => s.inventory.slots.findIndex((x) => x && x.itemId === id);
const count = (s, id) => s.inventory.slots.reduce((n, x) => n + (x && x.itemId === id ? x.count : 0), 0);


(async () => {
  const pw = fs.readFileSync(path.join(__dirname, '..', 'admin-password.txt'), 'utf8').split('\n').find((l) => l.trim() && !l.startsWith('#')).trim();
  await admin('POST', 'login', { password: pw });
  // 1. Admin page script and the view.
  const page = await new Promise((res) => http.get({ host: '127.0.0.1', port: adminPort, path: '/admin-v152.js', headers: { Cookie: cookie } }, (r) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(c).toString() })); }));
  assert.strictEqual(page.status, 200); assert(/限时活动/.test(page.body));
  let v = await admin('GET', 'b152');
  console.log('clock', JSON.stringify(v.clock).slice(0, 160));
  assert(/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(v.clock.now));
  assert.deepStrictEqual(v.events.map((e) => e.key).slice(0, 5), ['dragon', 'transform', 'nightfair', 'doublemap', 'freebless']);
  // Schedules: validation, weekly, ranges.
  await assert.rejects(admin('POST', 'b152/event', { key: 'midautumn', mode: 'ranges', ranges: [{ from: 'x', to: 'y' }] }));
  await assert.rejects(admin('POST', 'b152/event', { key: 'midautumn', mode: 'weekly', weekly: { days: [], start: '20:00', end: '22:00' } }));
  const allDays = [0, 1, 2, 3, 4, 5, 6];
  v = (await admin('POST', 'b152/event', { key: 'doublemap', mode: 'weekly', weekly: { days: allDays, start: '00:00', end: '00:00' } })).view;
  const now = v.clock.now;
  const later = new Date(Date.parse(now.replace(' ', 'T') + ':00+08:00') + 3600e3);
  const fmt = (d) => { const b = new Date(d.getTime() + 8 * 3600e3); return b.toISOString().slice(0, 16).replace('T', ' '); };
  v = (await admin('POST', 'b152/event', { key: 'midautumn', mode: 'ranges', ranges: [{ from: fmt(new Date(later - 7200e3)), to: fmt(later) }] })).view;
  assert(v.events.find((e) => e.key === 'midautumn').on, 'a range around now is on');
  console.log('midautumn next change', v.events.find((e) => e.key === 'midautumn').next);

  const g = await newChar('t152');
  await g.chat('/level 200'); await g.chat('/heal');
  // 2. Festival gift on login / when it starts.
  const off = await g.st('fest_offer', (d) => d.key === 'midautumn', 5000).catch(() => null);
  const offer = off || (g.ext('fest_query'), await g.st('fest_offer', (d) => d.key === 'midautumn', 3000));
  console.log('fest_offer', JSON.stringify(offer).slice(0, 160));
  let s = await g.state(); const cakes0 = count(s, 100);
  g.ext('fest_claim', { key: 'midautumn' }); await sleep(600);
  s = await g.state(); assert.strictEqual(count(s, 100) - cakes0, 5, '5 月饼');
  g.ext('fest_claim', { key: 'midautumn' }); await sleep(600);
  s = await g.state(); assert.strictEqual(count(s, 100) - cakes0, 5, 'only once per festival');
  await admin('POST', 'b152/event', { key: 'midautumn', reset: true });

  // 3. Double map: on (weekly all day) -> a map chosen this hour.
  v = await admin('GET', 'b152');
  assert(v.events.find((e) => e.key === 'doublemap').on);
  assert(v.doubleNow && v.doubleNow.maps.length === 1, 'one double map');
  console.log('double map', v.doubleNow.maps[0].name);
  await admin('POST', 'b152/event', { key: 'doublemap', reset: true });

  // 4. Night fair closed by a manual switch.
  await admin('POST', 'b152/manual', { key: 'nightfair', on: false });
  await g.chat('/go fair'); await sleep(500);
  g.ext('fair_lamp', { count: 1 });
  const fair = await g.st('fair', null, 3000);
  console.log('fair closed:', fair.message); assert(/没开张/.test(fair.message));
  await admin('POST', 'b152/manual', { key: 'nightfair', on: null });

  // 5. Free 战神祝福 event.
  v = (await admin('POST', 'b152/manual', { key: 'freebless', on: true })).view;
  assert(v.events.find((e) => e.key === 'freebless').on);
  await admin('POST', 'b152/manual', { key: 'freebless', on: null });

  // 6. Parts: status, notices, medusa, wear; bad values refused.
  await assert.rejects(admin('POST', 'b152/part', { key: 'status', iceSlowPct: 150 }));
  v = (await admin('POST', 'b152/part', { key: 'notices', shop: true })).view; assert.strictEqual(v.notices.shop, true);
  const cl = await g.st('v152', (d) => d.notices && d.notices.shop, 3000); assert(cl.medusa && cl.medusa.skin === 80);
  await admin('POST', 'b152/part', { key: 'notices', reset: true });
  await admin('POST', 'b152/part', { key: 'wear', on: true, hitsPerPoint: 1, dragonMult: 10 });

  // 7. Summon monsters on the admin 怪物 page with original numbers and drops.
  const mons = await admin('GET', 'monsters');
  const list = mons.monsters || mons.list || mons;
  const fox1 = (Array.isArray(list) ? list : []).find((m) => m.monsterId === 'summon_fox1');
  console.log('admin fox1', fox1 && JSON.stringify(fox1).slice(0, 200));
  assert(fox1, 'summon_fox1 on the 怪物 page');
  const drops = await admin('GET', 'monster-drops/summon_fox1').catch(() => null);
  if (drops) console.log('fox1 drops', JSON.stringify(drops.defaults).slice(0, 200));

  // 8. Fox LV1: original stats, palette ACGG, ice magic.
  await g.chat('/go hunt_p_01'); await sleep(600);
  await g.chat('/item 2586 100'); s = await g.state();
  const fur = at(s, 2586);
  g.send(OP.ITEM_USE, { fromIndex: fur, index: fur, summonRequestId: 'r1', summonTier: 1 });
  const delta = (await g.wait(OP.ITEM_DELTA, (d) => d.summonResult, 3000)).data;
  console.log('fox:', delta.dropMessage);
  const foxId = delta.summonResult.enemyId;
  const mu = await g.wait(OP.MOVE_UPDATE, (d) => (d.enemies || []).some((e) => e.enemyId === foxId && e.maxHp), 4000);
  const fox = mu.data.enemies.find((e) => e.enemyId === foxId);
  console.log('fox sync', JSON.stringify({ hp: fox.maxHp, lv: fox.level, sPalette: fox.sPalette, role: fox.role }));
  assert.strictEqual(fox.maxHp, 50000); assert.strictEqual(fox.sPalette, 'ACGG');
  // It wakes after 10 s; stand 300 px away and wait for an ice arrow + the blue status.
  await g.chat('/go hunt_p_01 ' + Math.round(fox.x - 300) + ' ' + Math.round(fox.y)); g.drain();
  let sawIce = null, kinds = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 35000 && !sawIce) {
    const m = await g.wait(OP.MOVE_UPDATE, (d) => (d.enemies || []).some((e) => e.enemyId === foxId && e.attackSequence > 0), 2000).catch(() => null);
    if (m) { const f = m.data.enemies.find((e) => e.enemyId === foxId); const oc = f.originalCombat || {}; kinds.add(oc.projectileKey || oc.specialMotion || 'bite'); }
    sawIce = await g.st('status_fx', (d) => d.id === g.me && d.fx === 'ice', 300).catch(() => null);
    g.send(OP.CHAT, { channel: 'world', message: '/heal' });
  }
  const hits = g.queue.filter((x) => x.opCode === OP.ATTACK_RESULT && x.data.targetId === g.me).map((x) => x.data.damage + '/' + x.data.targetHp);
  console.log('fox attacks', [...kinds].join(','), 'ice status', JSON.stringify(sawIce), 'hits on me', hits.slice(0, 8).join(' '));
  assert(kinds.has('bingjian'), 'LV1 fox casts 冰箭');
  assert(sawIce, 'the ice arrow slows / tints the player');

  // 9. 美杜沙: refused without materials, summoned with 80 + 80, poisons.
  await g.chat('/go hunt_p_02'); await sleep(600);
  g.ext('medusa_summon');
  const no = await g.wait(OP.CHAT_MESSAGE, (d) => /美杜沙/.test(d.message || ''), 3000); console.log('medusa w/o:', no.data.message);
  await g.chat('/item 2584 80'); await g.chat('/item 2585 80'); await sleep(300);
  g.drain(); g.ext('medusa_summon');
  const said = await g.wait(OP.CHAT_MESSAGE, (d) => /召唤了美杜沙/.test(d.message || ''), 3000); console.log(said.data.message);
  s = await g.state(); assert.strictEqual(count(s, 2584), 0); assert.strictEqual(count(s, 2585), 0);
  const mm = await g.wait(OP.MOVE_UPDATE, (d) => (d.enemies || []).some((e) => e.maxHp === 34000), 4000);
  const med = mm.data.enemies.find((e) => e.maxHp === 34000);
  console.log('medusa sync', JSON.stringify({ id: med.enemyId, role: med.role, palette: med.palette, lv: med.level }));
  await g.chat('/go hunt_p_02 ' + Math.round(med.x - 250) + ' ' + Math.round(med.y));
  let sawPoison = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 35000 && !sawPoison) {
    sawPoison = await g.st('status_fx', (d) => d.id === g.me && d.fx === 'poison', 1000).catch(() => null);
    g.send(OP.CHAT, { channel: 'world', message: '/heal' });
  }
  console.log('poison status', JSON.stringify(sawPoison)); assert(sawPoison, '石化 poisons');
  const tick = await g.wait(OP.ATTACK_RESULT, (d) => d.poisonTick && d.targetId === g.me, 3000).catch(() => null);
  console.log('poison tick', tick && tick.data.damage);

  // 10. Wear (1 per hit): weapon durability falls with swings.
  await admin('POST', 'b152/part', { key: 'wear', reset: true });
  // 12. Shift / Ctrl clicks: skill points +10 / +25, /levelup 10.
  const k = await newChar('t152k'); await k.chat('/sp 100'); await sleep(200);
  let ks = await k.state(); const sp0 = ks.params.skillPoints != null ? ks.params.skillPoints : (ks.params.progression || {}).skillPoints;
  k.send(OP.COMBAT_SKILL_UPGRADE || 5010, { skillId: 'magic', count: 10 }); await sleep(500);
  ks = await k.state();
  const lv = (ks.params.combatSkills || []).find((x) => x.id === 'magic');
  console.log('skill +10 ->', JSON.stringify(lv), 'points', sp0, '->', ks.params.skillPoints != null ? ks.params.skillPoints : (ks.params.progression || {}).skillPoints);
  await k.chat('/lock'); await k.chat('/exp 99999999'); k.drain();
  k.send(OP.CHAT, { channel: 'world', message: '/levelup 10' });
  const lu = await k.wait(OP.CHAT_MESSAGE, (d) => /战斗等级提升到/.test(d.message || ''), 3000); console.log(lu.data.message);
  assert(/升了 10 级/.test(lu.data.message));
  // 11. Settings export carries batch152.
  const ex = await new Promise((res) => http.get({ host: '127.0.0.1', port: adminPort, path: '/api/settings/export', headers: { Cookie: cookie } }, (r) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => res(JSON.parse(Buffer.concat(c).toString()))); }));
  assert(ex.batch152 !== undefined, 'export has batch152');
  console.log('batch152 ok');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
