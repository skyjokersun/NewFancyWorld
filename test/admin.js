'use strict';
// Protocol test for the /admin GM tool: list accounts, edit an online character
// (level, profession, gold, lock) and check the game sees it at once.
const assert = require('assert');
const { TestClient, OP } = require('./client');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
const http = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, body) => {
  const r = await fetch(http + '/admin/api/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};

(async () => {
  const page = await fetch(http + '/admin'); assert.strictEqual(page.status, 200); assert((await page.text()).includes('奇域管理后台'));
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  const email = 'adm' + Date.now() + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' }); await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123' }); await c.wait(OP.LOGIN_SUCCESS);
  c.send(OP.CHARACTER_CREATE, { nickname: 'AD' + String(Date.now()).slice(-6), appearance: { gender: 'man' } });
  await c.wait(OP.CHARACTER_CREATE_RESULT); const me = (await c.wait(OP.LOGIN_SUCCESS)).data.playerId;
  c.beat = setInterval(() => c.send(OP.HEARTBEAT || 1, {}), 2000);

  const { accounts } = await api('accounts');
  const acc = accounts.find((a) => a.email === email); assert(acc, 'account listed');
  const ch = acc.characters[0]; assert.strictEqual(ch.id, me); assert(ch.online);
  console.log('listed', ch);

  c.drain();
  let r = await api('character/' + me, { combatLevel: 40, professionLevel: 12, gold: 123456, skillPoints: 9, profession: 'warrior' });
  console.log('edit', r.done.join(' | '));
  assert.strictEqual(r.character.combatLevel, 40); assert.strictEqual(r.character.gold, 123456); assert.strictEqual(r.character.profession, 'warrior');
  c.send(OP.ITEM_QUERY, {}); const st = (await c.wait(OP.ITEM_STATE)).data.params;
  console.log('in game', st.progression.combatLevel, st.progression.profession, st.progression.professionLevel, st.profile.gold, st.progression.skillPoints);
  assert.strictEqual(st.progression.combatLevel, 40); assert.strictEqual(st.profile.gold, 123456); assert.strictEqual(st.progression.profession, 'warrior'); assert.strictEqual(st.progression.skillPoints, 9);
  // profession changed in the same edit, so professionLevel applied to the new profession
  assert.strictEqual(st.progression.professionLevel, 12);

  // Items: give a weapon with chosen affixes, stackables, change affixes, remove.
  const { prefixes, suffixes } = await api('affixes');
  const pre = prefixes.find((a) => a.name === '蛮族的'); const suf = suffixes.find((a) => a.name === '火' && a.itemId === 1665);
  c.drain();
  r = await api('character/' + me + '/items', { action: 'add', itemId: 577, count: 1, prefixItemId: pre.itemId, suffixItemId: suf.itemId });
  console.log('give', r.done.join(' | '));
  const delta = (await c.wait(OP.ITEM_DELTA)).data.changes.find((x) => x.type === 'set_inventory');
  console.log('client got', delta.item.name, delta.item.bonusAttrs.map((a) => a.display).join(','));
  assert.strictEqual(delta.item.name, '蛮族的短弓·火');
  const bow = r.character.inventory.find((x) => x.name === '蛮族的短弓·火'); assert(bow);
  r = await api('character/' + me + '/items', { action: 'add', itemId: 72, count: 30 });
  const pots = r.character.inventory.find((x) => x.itemId === 72); assert.strictEqual(pots.count, 30);
  r = await api('character/' + me + '/items', { action: 'affix', index: bow.index, prefixItemId: null, suffixItemId: suffixes.find((a) => a.name === '寒冰').itemId });
  console.log('affix', r.done.join(''));
  assert(r.character.inventory.find((x) => x.index === bow.index).name === '短弓·寒冰');
  r = await api('character/' + me + '/items', { action: 'remove', index: pots.index, count: 5 });
  assert.strictEqual(r.character.inventory.find((x) => x.index === pots.index).count, 25);
  r = await api('character/' + me + '/items', { action: 'remove', index: bow.index });
  assert(!r.character.inventory.find((x) => x.index === bow.index));
  await assert.rejects(api('character/' + me + '/items', { action: 'affix', index: pots.index, prefixItemId: pre.itemId }), /只有装备/);
  console.log('items ok');

  r = await api('character/' + me, { combatLevelLock: true }); assert.strictEqual(r.character.combatLevelLock, 40);
  r = await api('character/' + me, { combatExp: 99999999 }); assert.strictEqual(r.character.combatLevel, 40, 'locked');
  r = await api('character/' + me, { combatLevelLock: false }); assert(r.character.combatLevel > 40, 'unlocked');
  console.log('lock ok, unlocked level', r.character.combatLevel);

  await assert.rejects(api('character/' + me, { combatLevel: -3 }), /战斗等级/);
  await assert.rejects(api('character/' + me, { name: 'x' }), /在线/);
  r = await api('character/' + me + '/kick', {}); assert.deepStrictEqual(r.done, ['已踢下线']);
  await sleep(300);
  r = await api('character/' + me, { name: 'AdminRenamed' + String(Date.now()).slice(-4) }); console.log('offline edit', r.done.join(' | '));
  r = await api('account/' + acc.id, { password: 'newpass456' }); assert.deepStrictEqual(r.done, ['密码已重置']);
  const c2 = new TestClient(url); await c2.open(); await c2.wait(OP.CONNECT);
  c2.send(OP.LOGIN, { username: email, password: 'newpass456' }); const lg = (await c2.wait(OP.LOGIN_SUCCESS)).data;
  assert.strictEqual(lg.playerId, me); console.log('login with new password ok');
  r = await api('account/' + acc.id, { banned: true }); assert.deepStrictEqual(r.done, ['已封禁']);
  await api('account/' + acc.id, { banned: false });
  // Delete the whole account while its character is online.
  const c4 = new TestClient(url); await c4.open(); await c4.wait(OP.CONNECT);
  c4.send(OP.LOGIN, { username: email, password: 'newpass456' }); await c4.wait(OP.LOGIN_SUCCESS);
  assert((await api('character/' + me)).online, 'online before delete');
  const closed = new Promise((resolve) => c4.ws.once('close', () => resolve(true)));
  r = await api('account/' + acc.id + '/delete', {}); console.log('delete', r.done.join(''));
  assert(await Promise.race([closed, sleep(2000).then(() => false)]), 'online session closed');
  const after = await api('accounts');
  assert(!after.accounts.some((a) => a.email === email), 'account gone');
  await assert.rejects(api('character/' + me), /没有这个角色/);
  const c3 = new TestClient(url); await c3.open(); await c3.wait(OP.CONNECT);
  c3.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const m = (await c3.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message; assert(/(\d{6})/.test(m), 'email can register again: ' + m);
  console.log('re-register allowed');
  console.log('ADMIN OK'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
