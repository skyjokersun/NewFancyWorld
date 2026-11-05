'use strict';
// Protocol test for the fifth bug batch: the warrior's reach (and its admin setting),
// the summoned 狐仙 (model and attacks), and character export / import on the admin page.
const assert = require('assert');
const { TestClient, OP } = require('./client');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
const http = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, body) => {
  const r = await fetch(http + '/admin/api/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};

async function player(tag) {
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  c.email = tag + Date.now() + Math.floor(Math.random() * 1e4) + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email: c.email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email: c.email, password: 'password123', code, purpose: 'register' }); await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: c.email, password: 'password123' }); await c.wait(OP.LOGIN_SUCCESS);
  c.name = tag + String(Date.now()).slice(-6);
  c.send(OP.CHARACTER_CREATE, { nickname: c.name, appearance: { gender: 'man' } });
  await c.wait(OP.CHARACTER_CREATE_RESULT);
  c.id = (await c.wait(OP.LOGIN_SUCCESS)).data.playerId;
  c.chat = (m) => c.send(OP.CHAT, { channel: 'world', message: m });
  c.inv = async () => { await sleep(250); c.send(OP.ITEM_QUERY, {}); return (await c.wait(OP.ITEM_STATE)).data; };
  c.go = async (map, x, y) => { c.drain(); c.chat('/go ' + map + (x != null ? ' ' + Math.round(x) + ' ' + Math.round(y) : '')); return (await c.wait(OP.MAP_SWITCH_RESULT, () => true, 6000)).data; };
  c.beat = setInterval(() => c.send(OP.HEARTBEAT, { clientTime: Date.now(), seq: 1 }), 2000);
  return c;
}
const items = (st) => st.inventory.slots.filter(Boolean);

(async () => {
  await api('settings/reset', {});
  const a = await player('FW');

  // 1. Warrior reach: 120 px melee (sixth batch; was the model's 300); the admin setting replaces it.
  a.chat('/level 60'); a.chat('/prof warrior');
  let st = await a.inv();
  assert.strictEqual(st.params.combat.attackRange, 120, 'warrior reach ' + st.params.combat.attackRange);
  await api('settings', { values: { warriorRange: 180 } });
  st = await a.inv();
  assert.strictEqual(st.params.combat.attackRange, 180, 'admin reach ' + st.params.combat.attackRange);
  await api('settings', { values: { warriorRange: 0 } });
  st = await a.inv();
  assert.strictEqual(st.params.combat.attackRange, 120);
  console.log('warrior reach ok');

  // 2. 狐仙: model fox3, fireballs from afar, bites up close.
  a.chat('/level 200'); a.chat('/heal');
  const ms = await a.go('hunt_p_01');
  const me = (ms.players || []).find((p) => p.playerId === a.id);
  a.chat('/item 2586 100');
  st = await a.inv();
  const fur = st.inventory.slots.findIndex((x) => x && x.itemId === 2586);
  a.drain();
  a.send(OP.ITEM_USE, { fromIndex: fur, index: fur, summonRequestId: 'r1' });
  const delta = (await a.wait(OP.ITEM_DELTA, (d) => d.summonResult, 3000)).data;
  const foxId = delta.summonResult.enemyId;
  const role = await a.wait(OP.MOVE_UPDATE, (d) => (d.enemies || []).some((e) => e.enemyId === foxId && e.role), 3000);
  const fox0 = role.data.enemies.find((e) => e.enemyId === foxId);
  assert.strictEqual(fox0.role, 'enemy/fox3');
  const stand = await fetch(http + '/cdn_dump/named/charactor/enemy/fox3/stand.ale');
  assert.strictEqual(stand.status, 200, 'fox3 stand animation served');
  // Step 300 px away and wait for it to wake up (10 s after the summon).
  await a.go('hunt_p_01', fox0.x - 300, fox0.y);
  a.drain();
  const kinds = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && !(kinds.has('fire') && kinds.size >= 2)) {
    const mu = await a.wait(OP.MOVE_UPDATE, (d) => (d.enemies || []).some((e) => e.enemyId === foxId && e.attackSequence > 0), 30000).catch(() => null);
    if (!mu) break;
    const f = mu.data.enemies.find((e) => e.enemyId === foxId);
    const oc = f.originalCombat || {};
    // Sixth batch: learned skills show their own projectile or motion.
    kinds.add(oc.projectileKey === 'huoqiu' ? 'fire' : oc.specialMotion === 'dash_to_target' ? 'pounce' : (oc.projectileKey || oc.specialMotion || 'bite'));
  }
  console.log('fox attacks seen', Array.from(kinds).join(','));
  assert(kinds.has('fire'), 'the fox throws fireballs from afar');
  assert(kinds.size >= 2, 'and has another attack');
  console.log('fox ok', me && me.x);

  // 3. Character export and import.
  a.chat('/item 3202 1'); a.chat('/gold 123456');
  st = await a.inv();
  const exp = await (await fetch(http + '/admin/api/character/' + a.id + '/export')).json();
  assert.strictEqual(exp.format, 'qiyu-character');
  assert.strictEqual(exp.character.name, a.name);
  const bagA = items(st).map((x) => x.itemId + 'x' + (x.count || 1)).sort().join();
  // As a new character of another account.
  const b = await player('FY');
  const accB = (await api('accounts')).accounts.find((x) => x.email === b.email.toLowerCase());
  await assert.rejects(api('account/' + accB.id + '/import', { file: exp, world: 'green', name: 'X' + a.name.slice(1) }), /已经有角色/);
  const made = await api('account/' + accB.id + '/import', { file: exp, world: 'east', name: 'N' + a.name.slice(1) });
  const nc = await api('character/' + made.id);
  assert.strictEqual(nc.world, 'east'); assert.strictEqual(nc.profession, 'warrior');
  assert.strictEqual(nc.combatLevel, 200); assert.strictEqual(nc.gold, exp.character.gold);
  assert.strictEqual(nc.inventory.map((x) => x.itemId + 'x' + x.count).sort().join(), bagA);
  const accA = (await api('accounts')).accounts.find((x) => x.email === a.email.toLowerCase());
  await assert.rejects(api('account/' + accA.id + '/import', { file: exp, world: 'east', name: 'N' + a.name.slice(1) }), /已经有叫/);
  console.log('import as new ok', made.done.join(' '));
  // Overwriting B's own (online) character: it keeps its name and is kicked.
  const before = await api('character/' + b.id);
  const r = await api('character/' + b.id + '/import', exp);
  console.log(r.done.join(' '));
  assert.strictEqual(r.character.name, before.name);
  assert.strictEqual(r.character.combatLevel, 200);
  assert.strictEqual(r.character.online, false, 'kicked while importing');
  assert.strictEqual(r.character.inventory.map((x) => x.itemId + 'x' + x.count).sort().join(), bagA);
  await assert.rejects(api('character/' + b.id + '/import', { format: 'x' }), /文件格式不对/);
  console.log('import over ok');

  clearInterval(a.beat); a.close(); clearInterval(b.beat); b.close();
  console.log('FIXES5 OK'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
