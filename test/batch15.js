'use strict';
// Fifteenth batch: card drop settings, drop overview, 屠龙 (米索莉, gun, bullets, 大地龙),
// green gifts and transforms, auto-hunt buffs. node test/batch15.js [ws url] [admin port]
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

  // ---- card drops ----
  let v = await admin('GET', 'b15');
  assert.strictEqual(v.config.cards.chance, 0.4); assert.strictEqual(v.cardList.length, 56);
  const cards = JSON.parse(JSON.stringify(v.config.cards));
  cards.chance = 2; cards.cats['城镇'] = 0; cards.weights[3900] = 0.2; cards.mineChance = 1;
  console.log('cards:', (await admin('POST', 'b15/cards', cards)).done[0]);
  v = await admin('GET', 'b15');
  assert.strictEqual(v.config.cards.chance, 2); assert.strictEqual(v.config.cards.cats['城镇'], 0);
  assert.strictEqual(v.cardList.find((x) => x.itemId === 3900).weight, 0.2);
  let bad = null; try { await admin('POST', 'b15/cards', Object.assign({}, cards, { chance: 200 })); } catch (e) { bad = e.message; } assert(bad); console.log('bad chance:', bad);
  // Export carries it, reset removes it.
  const exp = JSON.parse((await new Promise((res) => http.get({ host: '127.0.0.1', port: adminPort, path: '/api/settings/export', headers: { Cookie: cookie } }, (r) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => res(Buffer.concat(c).toString())); }))));
  assert(exp.batch15 && exp.batch15.cards && exp.batch15.cards.chance === 2, 'export has batch15');
  await admin('POST', 'b15/cards', { reset: true });
  assert.strictEqual((await admin('GET', 'b15')).config.cards.chance, 0.4);

  // ---- drop overview ----
  const ov = await admin('GET', 'drop-overview?q=2622');
  const shard = ov.rows.find((r) => r.itemId === 2622);
  console.log('2622 dropped by', shard.monsters.length, 'monsters at', shard.monsters[0].chance + '%');
  assert(shard.monsters.length >= 10); assert.strictEqual(shard.monsters[0].chance, 1);
  const two = shard.monsters.slice(0, 2).map((m) => m.monsterId);
  const set = await admin('POST', 'drop-overview', { itemId: 2622, chance: 5, monsters: two, q: '2622' });
  console.log(set.done[0]);
  const after = set.rows.find((r) => r.itemId === 2622).monsters.filter((m) => two.includes(m.monsterId));
  assert(after.every((m) => m.chance === 5 && m.edited));
  for (const mid of two) await admin('POST', 'monster-drops/' + mid, { reset: true });
  const sp = await admin('GET', 'drop-overview?q=' + encodeURIComponent('红宝石碎片'));
  assert(sp.rows.length && sp.rows[0].monsters.some((m) => m.special), 'special drops listed');

  // ---- built-in models served ----
  for (const u of ['/cdn_dump/named/charactor/enemy/u_bossdragon/stand.ale', '/cdn_dump/named/charactor/enemy/u_bossdragon/fight.ale', '/cdn_dump/named/charactor/man/u_tf_dragon/stand.ale', '/cdn_dump/named/charactor/women/u_tf_fox/run.ale', '/cdn_dump/named/charactor/man/u_tf_butterfly/fight.ale']) {
    const r = await get(u); console.log(u, r.status, r.body.length, r.body.slice(0, 3).toString());
    assert.strictEqual(r.status, 200); assert(/^AL|^AE/.test(r.body.slice(0, 2).toString()));
  }
  const man = (await get('/asset-manifest.json')).body.toString();
  assert(man.includes('u_bossdragon/stand.ale') && man.includes('u_tf_lizard'), 'manifest lists built-ins');

  // ---- 米索莉: fuse, gun, bullets ----
  const g = await newChar('t15g');
  await g.chat('/prof gunner'); await g.chat('/level 150'); await g.chat('/plevel 30'); await g.chat('/gold 100000');
  await g.chat('/go pintu 2115 -2200');
  g.ext('msl_query'); let m = await g.st('msl'); console.log('msl:', JSON.stringify(m).slice(0, 160)); assert.strictEqual(m.shards, 0);
  g.ext('msl_fuse'); m = await g.st('msl'); console.log(' fuse w/o shards:', m.message); assert(!m.crystal);
  await g.chat('/item 2622 100');
  g.ext('msl_fuse'); m = await g.st('msl'); console.log(' fuse:', m.message); assert(m.crystal); assert.strictEqual(m.shards, 0);
  g.ext('msl_buy', { itemId: 606, count: 5 }); m = await g.st('msl'); console.log(' buy w/o gun:', m.message); assert(/没有封印的火枪/.test(m.message));
  g.ext('msl_gun'); m = await g.st('msl'); console.log(' gun:', m.message); assert(m.gun);
  g.ext('msl_gun'); m = await g.st('msl'); assert(/已经有/.test(m.message));
  g.ext('msl_buy', { itemId: 604, count: 4 }); m = await g.st('msl'); console.log(' buy:', m.message, 'gold', m.gold); assert.strictEqual(m.gold, 100000 - 1200);
  let s = await g.state();
  const gun = s.inventory.slots[at(s, 602)]; assert(gun.ext && gun.ext.bound && gun.ext.dragonGun, 'quest gun bound');
  assert(s.inventory.slots[at(s, 2621)].ext.bound, 'crystal bound'); assert.strictEqual(count(s, 604), 4);
  g.send(OP.ITEM_EQUIP, { fromIndex: at(s, 602), slot: 'weapon' }); await sleep(400);
  s = await g.state(); assert(s.equipment.weapon && s.equipment.weapon.itemId === 602, 'quest gun equips for a gunner');
  // A plain 602 (not from 米索莉) stays sealed.
  const w = await newChar('t15w');
  await w.chat('/prof gunner'); await w.chat('/level 60'); await w.chat('/item 602 1');
  let ws = await w.state(); w.send(OP.ITEM_EQUIP, { fromIndex: at(ws, 602), slot: 'weapon' }); await sleep(400);
  ws = await w.state(); assert(!ws.equipment.weapon || ws.equipment.weapon.itemId !== 602, 'plain 602 sealed'); console.log('plain 602 stays sealed');

  // ---- 大地龙 ----
  await admin('POST', 'b15/dismiss', {});
  const dc = JSON.parse(JSON.stringify((await admin('GET', 'b15')).config.dragon)); dc.stats.damage = 0; dc.stats.fireAttack = 0;
  await admin('POST', 'b15/dragon', dc);
  console.log('summon:', (await admin('POST', 'b15/summon', {})).done[0]);
  v = await admin('GET', 'b15');
  const dragon = v.dragonAlive.find((d) => d.world === 'green') || v.dragonAlive[0];
  console.log('dragon', JSON.stringify(dragon)); assert(dragon && dragon.maxHp === 100000);
  await g.chat('/go ' + dragon.map + ' ' + (dragon.x + 150) + ' ' + dragon.y); await sleep(500);
  g.send(OP.CHAT, { channel: 'world', message: '/where' });
  const wh = await g.wait(OP.CHAT_MESSAGE, (d) => new RegExp(dragon.map + ' \\(').test(d.message || ''), 3000).catch(() => null);
  console.log(' where:', wh && JSON.stringify(wh.data).slice(0, 200));
  // Other monsters come close and a shot hits the first one on its line: try until the
  // dragon is hit; a gun shot at anything else must do 0.
  const hit = async (c, who) => {
    for (let i = 0; i < 20; i++) {
      c.send(OP.CHAT, { channel: 'world', message: '/heal' });
      c.send(OP.ATTACK, { attackPhase: 'fire', targetId: dragon.id, aimX: dragon.x, aimY: dragon.y });
      const r = await c.wait(OP.ATTACK_RESULT, (d) => d.attackerId === c.me, 1500).then((x) => x.data).catch(() => null);
      if (process.env.DBG) console.log('   r', r && JSON.stringify(r).slice(0, 160));
      if (r && r.targetId !== dragon.id && c === g) assert.strictEqual(r.damage, 0, 'gun does nothing to other monsters');
      if (r && r.targetId === dragon.id) { console.log(' ', who, 'hit ->', r.damage, 'dragon hp', r.targetHp); return r; }
      // Something stands in the line of fire: shoot from another side.
      if (i % 3 === 2) { const o = [[150, 0], [-150, 0], [0, 150], [0, -150], [110, 110], [-110, -110]][(i / 3 | 0) % 6]; await c.chat('/go ' + dragon.map + ' ' + (dragon.x + o[0]) + ' ' + (dragon.y + o[1])); }
      await sleep(1000);
    }
    return null;
  };
  let r = await hit(g, 'gun+bullet'); assert(r && r.damage > 100, 'bullet shot hurts');
  s = await g.state(); assert.strictEqual(count(s, 604), 1, 'a 三发 shot uses 3 bullets');
  // Fewer than 3 left of the 三发 kind: no shot, 1 point.
  console.log(' bullets left', count(s, 604));
  await g.chat('/heal'); await sleep(1300); r = await hit(g, 'no bullet'); assert(r && r.damage >= 1 && r.damage < 100, 'no bullet = bare hands (V15.2 Q6)');
  // Another weapon: 0.
  const x = await newChar('t15x'); await x.chat('/level 60');
  await x.chat('/go ' + dragon.map + ' ' + (dragon.x + 60) + ' ' + dragon.y); await sleep(500);
  await sleep(300); r = await hit(x, 'bare hands'); assert(r && r.damage >= 0, 'other weapons hit as usual (V15.2 Q6)');
  console.log('dismiss:', (await admin('POST', 'b15/dismiss', {})).done[0]);
  await admin('POST', 'b15/dragon', { reset: true });

  // ---- green gift ----
  const a = await newChar('t15a'); const b = await newChar('t15b');
  await a.chat('/go square_in'); await b.chat('/go square_in'); await sleep(600);
  await a.chat('/item 2638 9');
  let as = await a.state(); a.send(OP.ITEM_USE, { fromIndex: at(as, 2638) });
  await sleep(500);
  await a.chat('/item 2638 1');
  as = await a.state(); a.send(OP.ITEM_USE, { fromIndex: at(as, 2638) });
  const pick = await a.st('gift_pick'); console.log('gift_pick players', JSON.stringify(pick.players));
  const tgt = pick.players.find((q) => q.id === b.me); assert(tgt, 'b listed');
  a.ext('gift_send', { itemId: 2638, to: b.me });
  const offer = await b.st('gift_offer'); console.log('offer', JSON.stringify(offer)); assert.strictEqual(offer.becomes, '小红龙');
  as = await a.state(); assert.strictEqual(count(as, 2638), 0);
  b.ext('gift_answer', { accept: true }); await sleep(600);
  const bs = await b.state();
  console.log('b model', bs.params && bs.params.appearance && bs.params.appearance.model);
  const sv = await admin('GET', 'accounts');
  // refuse path
  const c2 = await newChar('t15c'); await c2.chat('/go square_in'); await sleep(500);
  await a.chat('/item 2637 10'); as = await a.state(); a.send(OP.ITEM_USE, { fromIndex: at(as, 2637) }); await a.st('gift_pick');
  a.ext('gift_send', { itemId: 2637, to: c2.me }); await c2.st('gift_offer'); c2.ext('gift_answer', { accept: false }); await sleep(600);
  as = await a.state(); assert.strictEqual(count(as, 2637), 10, 'refused gift comes back'); console.log('refused gift returned');

  // ---- auto-hunt buffs ----
  const k = await newChar('t15k');
  await k.chat('/prof warrior'); await k.chat('/level 40'); await k.chat('/plevel 40'); await k.chat('/item 3501 1'); await k.chat('/item 900102 1');
  let ks = await k.state(); k.send(OP.ITEM_USE, { fromIndex: at(ks, 3501) }); await sleep(300);
  ks = await k.state(); if (at(ks, 900102) >= 0) { k.send(OP.ITEM_USE, { fromIndex: at(ks, 900102) }); await sleep(300); }
  await k.chat('/level 150'); await k.chat('/go dk1_01'); await sleep(600);
  k.ext('autohunt_query'); let ah = await k.st('autohunt', (d) => d.potions);
  console.log('buff skills', JSON.stringify(ah.buffSkills), 'attack skills', JSON.stringify(ah.skills.map((x) => x.id)));
  assert(ah.buffSkills.length, 'a buff learned'); const BUFF = ah.buffSkills[0].id; assert(!ah.skills.some((x) => x.id === BUFF), 'buffs not attack skills');
  k.ext('autohunt_cfg', { cfg: { buffs: [BUFF, 'nope'], buffMpPct: 20, healOn: true, healPct: 40 } });
  ah = await k.st('autohunt', (d) => d.potions); console.log('cfg', JSON.stringify(ah.cfg)); assert.deepStrictEqual(ah.cfg.buffs, [BUFF]); assert.strictEqual(ah.cfg.buffMpPct, 20);
  k.ext('autohunt', { on: true }); ah = await k.st('autohunt', (d) => d.on || d.reason); console.log('auto on', ah.on, ah.reason || ''); assert(ah.on, 'auto hunting');
  const before = (await k.state()).params; 
  k.send(OP.ATTACK, { attackPhase: 'fire', skillId: BUFF, aimX: 0, aimY: 0 });
  await sleep(500);
  const afterP = (await k.state()).params;
  const buffs = (afterP.combat && afterP.combat.activeBuffs) || [];
  console.log('active buffs', JSON.stringify(buffs)); assert(buffs.some((x) => x.id === BUFF), 'buff cast while hunting');
  k.send(OP.ATTACK, { attackPhase: 'fire', skillId: 'warrior_jianqi', aimX: 0, aimY: 0 });
  console.log('batch15 ok');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
