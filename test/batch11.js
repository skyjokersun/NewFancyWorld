'use strict';
// Eleventh batch protocol test: child lock at 10, auto-hunt rules and auto potions,
// sealed / blocked equipment.
const assert = require('assert');
const { TestClient, OP } = require('./client');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  const email = 'b11' + Date.now() + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' });
  await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123' }); await c.wait(OP.LOGIN_SUCCESS);
  c.send(OP.CHARACTER_CREATE, { nickname: 'BX' + String(Date.now()).slice(-6), appearance: { gender: 'man' } });
  await c.wait(OP.CHARACTER_CREATE_RESULT); await c.wait(OP.LOGIN_SUCCESS);
  const chat = (m) => c.send(OP.CHAT, { channel: 'world', message: m });
  const ext = (kind, d) => c.send(7100, Object.assign({ kind }, d || {}));
  const state = async () => { c.send(OP.ITEM_QUERY, {}); return (await c.wait(OP.ITEM_STATE)).data; };
  const hunt = () => c.wait(7110, (d) => d.kind === 'autohunt');

  // Child lock at 10.
  chat('/exp 200000'); await sleep(500);
  let s = await state();
  console.log('child level', s.params.progression.combatLevel, 'locked', s.params.progression.combatLevelLocked);
  assert.strictEqual(s.params.progression.combatLevel, 10);
  assert.strictEqual(s.params.progression.combatLevelLocked, true);
  chat('/lock'); await sleep(300);
  s = await state();
  assert(s.params.progression.combatLevel > 10, 'unlock is the player choice');
  chat('/exp 200000'); await sleep(300);
  s = await state(); assert.strictEqual(s.params.progression.combatLevelLocked, false, 'no relock');

  // Blocked / sealed gear.
  chat('/item 784 1'); chat('/item 602 1'); chat('/item 72 5'); await sleep(400);
  s = await state();
  const at = (id) => s.inventory.slots.findIndex((it) => it && it.itemId === id);
  console.log('602 req', JSON.stringify(s.inventory.slots[at(602)].requirement), s.inventory.slots[at(602)].desc);
  c.queue.length = 0;
  c.send(OP.ITEM_EQUIP, { fromIndex: at(784), slot: 'weapon' });
  let err = await c.wait(OP.ITEM_OP_ERROR); console.log('784 child', err.data.code);
  c.send(OP.ITEM_EQUIP, { fromIndex: at(602), slot: 'weapon' });
  err = await c.wait(OP.ITEM_OP_ERROR); console.log('602', err.data.code);

  // Auto hunt.
  chat('/go hunt_p_01'); await sleep(800);
  c.queue.length = 0;
  ext('autohunt_cfg', { cfg: { hpOn: true, hpPct: 60, hpItem: 72, pick: 'all' } });
  let h = (await hunt()).data; console.log('cfg', JSON.stringify(h.cfg), 'potions', JSON.stringify(h.potions.hp.map((r) => r.name + r.count)));
  assert.strictEqual(h.cfg.hpItem, 72);
  ext('autohunt', { on: true }); h = (await hunt()).data; assert.strictEqual(h.on, true);
  c.queue.length = 0;
  c.send(OP.ITEM_USE, { fromIndex: at(72) });
  err = await c.wait(OP.ITEM_OP_ERROR); console.log('manual use:', err.data.message);
  c.send(OP.MAP_SWITCH, { mapRef: 'hunt_p_in', clientSeq: 9 });
  const sw = await c.wait(OP.MAP_SWITCH_RESULT); console.log('switch:', sw.data.success, sw.data.message);
  assert.strictEqual(sw.data.success, false);
  chat('/hurt 30'); await sleep(2500);
  s = await state();
  const pots = s.inventory.slots.filter((it) => it && it.itemId === 72).reduce((n, it) => n + it.count, 0);
  console.log('after hurt hp', s.params.stats ? s.params.stats.hp : '', 'potions left', pots);
  assert(pots < 5, 'auto potion used');
  c.queue.length = 0;
  chat('/go hunt_p_02'); h = (await hunt()).data; console.log('forced transfer ->', h.on, h.reason);
  assert.strictEqual(h.on, false);
  console.log('batch11 ok'); c.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
