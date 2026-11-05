'use strict';
// Protocol test for the third bug batch: no fighting in towns, merchants' goods and
// prices from the admin page, automatic titles, fixed attribute spreads and the
// luck bonus on level-up skill points.
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
  const email = tag + Date.now() + Math.floor(Math.random() * 1e4) + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' }); await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123' }); await c.wait(OP.LOGIN_SUCCESS);
  c.name = tag + String(Date.now()).slice(-6);
  c.send(OP.CHARACTER_CREATE, { nickname: c.name, appearance: { gender: 'man' } });
  await c.wait(OP.CHARACTER_CREATE_RESULT);
  c.id = (await c.wait(OP.LOGIN_SUCCESS)).data.playerId;
  c.chat = (m) => c.send(OP.CHAT, { channel: 'world', message: m });
  c.inv = async () => { await sleep(200); c.send(OP.ITEM_QUERY, {}); return (await c.wait(OP.ITEM_STATE)).data; };
  c.go = async (map, x, y) => { c.drain(); c.chat('/go ' + map + (x != null ? ' ' + Math.round(x) + ' ' + Math.round(y) : '')); return (await c.wait(OP.MAP_SWITCH_RESULT, () => true, 6000)).data; };
  c.beat = setInterval(() => c.send(OP.HEARTBEAT, { clientTime: Date.now(), seq: 1 }), 2000);
  return c;
}
const selfIn = (c, mu) => (mu.players || []).find((p) => p.playerId === c.id);

(async () => {
  await api('settings/reset', {});
  const a = await player('TA'); const b = await player('TB');

  // 1. Towns are safe: an attack there is not even shown to others; in a hunting map it is.
  const maps = await (await fetch(http + '/api/combat-maps')).json();
  assert(maps.safeTowns && maps.huntingMaps.includes('hunt_p_01') && !maps.huntingMaps.includes('square_in') && !maps.huntingMaps.includes('hunt_b_in'));
  const attackSeen = async (map) => {
    const sa = await a.go(map); await b.go(map, selfIn(a, sa) ? selfIn(a, sa).x : undefined, selfIn(a, sa) ? selfIn(a, sa).y : undefined);
    await sleep(1200); b.drain(); // also clears the attack rate limit
    const me = selfIn(a, sa) || { x: 0, y: 0 };
    a.send(OP.ACTION, { action: { type: 'attack', attackPhase: 'fire', x: me.x, y: me.y, aimX: me.x + 80, aimY: me.y, seq: 50, timestamp: Date.now() } });
    try { await b.wait(OP.ATTACK_ACTION, (d) => d.attackerId === a.id, 1500); return true; } catch (_) { return false; }
  };
  assert.strictEqual(await attackSeen('square_in'), false, 'no attack in the town square');
  assert.strictEqual(await attackSeen('hunt_b_in'), false, 'no attack in a post station');
  assert.strictEqual(await attackSeen('hunt_p_01'), true, 'attacks in a hunting map');
  await api('settings', { values: { safeTowns: false } });
  assert.strictEqual(await attackSeen('square_in'), true, 'setting off: attacks in town again');
  await api('settings', { values: { safeTowns: true } });
  console.log('safe towns ok');

  // 2. Merchants: list, custom goods and prices, buying at the custom price, reset.
  const shops = await api('shops');
  const hunt = shops.merchants.find((m) => m.id === 'hunt_in:tools');
  assert(hunt && hunt.labels.includes('猎村杂货店'), 'hunters village general store listed');
  assert(shops.merchants.find((m) => m.id === 'qiaoqiao') && shops.merchants.find((m) => m.id === 'smith:tools'));
  const det = await api('shop/' + encodeURIComponent('hunt_in:tools'));
  const potion = det.items.find((x) => x.tab === 'medicine');
  await a.go('hunt_in');
  a.drain(); a.send(OP.SHOP_QUERY, { kind: 'tools' });
  let st = (await a.wait(OP.SHOP_STATE)).data;
  assert(st.tabs.medicine.includes(potion.itemId));
  await api('shop/' + encodeURIComponent('hunt_in:tools'), { items: [potion.itemId, 1155], prices: { [potion.itemId]: 7 } });
  a.drain(); a.send(OP.SHOP_QUERY, { kind: 'tools' });
  st = (await a.wait(OP.SHOP_STATE)).data;
  assert.deepStrictEqual(st.tabs.medicine, [potion.itemId]);
  assert.deepStrictEqual(st.tabs.armor, [1155], 'a hat added to the general store');
  assert.strictEqual(st.prices[potion.itemId], 7);
  a.chat('/gold 1000');
  let inv = await a.inv(); const gold0 = inv.params.profile.gold;
  a.send(OP.SHOP_BUY, { kind: 'tools', itemId: potion.itemId, count: 3 });
  inv = await a.inv();
  assert.strictEqual(inv.params.profile.gold, gold0 - 21, 'paid 3 x 7');
  // Another merchant: same custom price, default goods.
  await a.go('hunt_b_in');
  a.drain(); a.send(OP.SHOP_QUERY, { kind: 'tools' });
  st = (await a.wait(OP.SHOP_STATE)).data;
  assert(st.tabs.medicine.length > 1 && st.prices[potion.itemId] === 7);
  // Export carries the shops; reset restores everything.
  const exp = await (await fetch(http + '/admin/api/settings/export')).json();
  assert.deepStrictEqual(exp.shops.merchants['hunt_in:tools'], [potion.itemId, 1155]);
  const rr = await api('settings/reset', {});
  assert(rr.done.includes('商人商品和价格'));
  assert.strictEqual((await api('shops')).merchants.find((m) => m.id === 'hunt_in:tools').custom, false);
  await api('settings/import', exp);
  assert.strictEqual((await api('shops')).merchants.find((m) => m.id === 'hunt_in:tools').custom, true);
  await api('settings/reset', {});
  console.log('shops ok');

  // 3. Titles and fixed attributes.
  inv = await a.inv();
  assert.strictEqual(inv.params.profile.title, '1级的宝宝');
  const core1 = inv.params.combat.coreAttrs;
  a.chat('/level 40'); inv = await a.inv();
  const core40 = inv.params.combat.coreAttrs;
  assert.deepStrictEqual(core40, core1, 'attributes do not grow with level');
  assert.deepStrictEqual(core1, { strength: 7, agility: 7, perception: 7, intelligence: 7, luck: 6 });
  a.chat('/prof gunner'); a.chat('/plevel 12'); inv = await a.inv();
  const coreG = inv.params.combat.coreAttrs;
  assert.deepStrictEqual(coreG, { strength: 8, agility: 10, perception: 3, intelligence: 10, luck: 3 });   // eighth batch: gunner 8 10 3 10 3
  assert.strictEqual(inv.params.profile.title, '12级的枪手');
  a.chat('/prof craftsman'); a.chat('/craft fusion 90'); inv = await a.inv();
  assert.strictEqual(inv.params.profile.title, '物品加工宗师');
  console.log('titles and attributes ok', JSON.stringify(coreG));

  console.log('FIXES3 OK'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
