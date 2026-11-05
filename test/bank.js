'use strict';
// Protocol test: bank coffer apply / open / save / renew / close; townhouse donation.
const assert = require('assert');
const { TestClient, OP } = require('./client');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
(async () => {
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  const email = 'b' + Date.now() + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' });
  await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123' }); await c.wait(OP.LOGIN_SUCCESS);
  c.send(OP.CHARACTER_CREATE, { nickname: 'B' + String(Date.now()).slice(-6), appearance: { gender: 'man' } });
  await c.wait(OP.CHARACTER_CREATE_RESULT); await c.wait(OP.LOGIN_SUCCESS);
  c.send(OP.ITEM_QUERY, {}); const st = (await c.wait(OP.ITEM_STATE)).data;
  const bank = async (cmd) => { c.send(OP.BANK_SERVICE, cmd); return (await c.wait(OP.BANK_SERVICE_EVENT)).data; };
  let r = await bank({ type: 'query' }); assert.strictEqual(r.type, 'error'); console.log('outside bank:', r.message);
  c.send(OP.CHAT, { channel: 'world', message: '/go bank' }); await c.wait(OP.MAP_SWITCH_RESULT);
  r = await bank({ type: 'query' }); console.log('query', r.type, 'points', r.servicePoints, 'gold', r.pocketGold);
  r = await bank({ type: 'apply', identityNumber: '1234567890' }); console.log('apply', r.type, r.message); assert.strictEqual(r.action, 'apply');
  const num = r.assignedCofferNumber;
  r = await bank({ type: 'open', cofferNumber: num }); assert(r.activeCoffer); console.log('open slots', r.activeCoffer.slots.length);
  // move first inventory item into coffer slot 0 and store 100 gold
  const inv = st.inventory.slots.slice(); const cof = new Array(40).fill(null);
  const first = inv.findIndex(Boolean); cof[0] = inv[first]; inv[first] = null;
  r = await bank({ type: 'save', cofferNumber: num, bankRevision: r.bankRevision, itemRevision: r.itemRevision, inventorySlots: inv, cofferSlots: cof, pocketGold: r.pocketGold - 100, storedGold: 100 });
  console.log('save', r.type, r.message, 'pocket', r.pocketGold, 'stored', r.activeCoffer && r.activeCoffer.storedGold, 'slot0', r.activeCoffer && r.activeCoffer.slots[0] && r.activeCoffer.slots[0].name);
  assert.strictEqual(r.type, 'result');
  // forged duplicate must fail
  const dup = cof.slice(); dup[1] = cof[0];
  r = await bank({ type: 'save', cofferNumber: num, bankRevision: r.bankRevision, inventorySlots: inv, cofferSlots: dup, pocketGold: r.pocketGold, storedGold: 100 });
  console.log('dup save', r.type, r.message); assert.strictEqual(r.type, 'error');
  r = await bank({ type: 'renew', cofferNumbers: [num], months: 2 }); console.log('renew', r.type, r.message, 'points', r.servicePoints);
  r = await bank({ type: 'recover', identityNumber: '1234567890' }); console.log('recover1', r.action, r.recoveryQuestion);
  r = await bank({ type: 'close', cofferNumber: num }); console.log('close', r.type, r.message);
  c.send(OP.CHAT, { channel: 'world', message: '/go townhouse' }); await c.wait(OP.MAP_SWITCH_RESULT);
  c.send(OP.TOWNHOUSE_SERVICE, { type: 'donate', service: 'welfare', amount: 1000 });
  console.log('donate', (await c.wait(OP.TOWNHOUSE_SERVICE_EVENT)).data);
  c.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
