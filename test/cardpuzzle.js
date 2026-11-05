'use strict';
// Protocol test: card puzzle altars (place / remove / complete / wish) and legacy map links.
const assert = require('assert');
const { TestClient, OP } = require('./client');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';

async function player(tag) {
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  const email = tag + Date.now() + Math.floor(Math.random() * 1e4) + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' });
  await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123' }); await c.wait(OP.LOGIN_SUCCESS);
  c.name = tag + String(Date.now()).slice(-6);
  c.send(OP.CHARACTER_CREATE, { nickname: c.name, appearance: { gender: 'man' } });
  await c.wait(OP.CHARACTER_CREATE_RESULT);
  c.id = (await c.wait(OP.LOGIN_SUCCESS)).data.playerId;
  c.chat = (m) => c.send(OP.CHAT, { channel: 'world', message: m });
  c.inv = async () => { c.send(OP.ITEM_QUERY, {}); return (await c.wait(OP.ITEM_STATE)).data; };
  return c;
}

const http = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
const settings = (values) => fetch(http + '/admin/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });

(async () => {
  // The tile and cooldown rules are covered by test/fixes2.js; this test places cards from anywhere.
  await settings({ cardPuzzleNearSlot: false, cardPuzzleCooldownMin: 0 });
  const a = await player('K'); const b = await player('L');
  // Legacy link: square_in's malformed "../card,圣坛,300" portal leads to pintu.
  a.send(OP.MAP_SWITCH, { mapRef: 'card', clientSeq: 1 });
  const ms = (await a.wait(OP.MAP_SWITCH_RESULT)).data;
  assert(ms.success && ms.mapRef === 'pintu', 'card -> pintu'); console.log('map alias card -> pintu ok');
  let st = (await a.wait(OP.CARD_PUZZLE_STATE)).data;
  assert.strictEqual(st.altars.length, 3); console.log('state:', st.altars.map((x) => x.displayName + ' ' + x.pieces.length + '/' + x.cols * x.rows).join(', '));
  b.chat('/go pintu'); await b.wait(OP.MAP_SWITCH_RESULT); await b.wait(OP.CARD_PUZZLE_STATE);
  // A gets heart cards 1..12, B gets 13..16
  for (let i = 0; i < 12; i += 1) a.chat('/item ' + (3900 + i));
  for (let i = 12; i < 16; i += 1) b.chat('/item ' + (3900 + i));
  await new Promise((r) => setTimeout(r, 600));
  const placeAll = async (c) => {
    const inv = await c.inv();
    for (const [i, it] of inv.inventory.slots.entries()) if (it && it.itemId >= 3900 && it.itemId <= 3915) c.send(OP.CARD_PUZZLE_PLACE, { fromIndex: i, clientSeq: i });
  };
  await placeAll(a);
  await new Promise((r) => setTimeout(r, 500));
  // remove one of A's and put it back
  a.drain();
  a.send(OP.CARD_PUZZLE_REMOVE, { altar: 'heart', slot: 0 });
  st = (await a.wait(OP.CARD_PUZZLE_STATE)).data;
  assert.strictEqual(st.altars.find((x) => x.altar === 'heart').pieces.length, 11); console.log('remove ok, 11/16');
  b.send(OP.CARD_PUZZLE_REMOVE, { altar: 'heart', slot: 1 });
  console.log('remove others card:', (await b.wait(OP.CARD_PUZZLE_ERROR)).data.message);
  await placeAll(a); await new Promise((r) => setTimeout(r, 300));
  const hpBefore = (await a.inv()).params.combat.maxHp;
  a.drain();
  await placeAll(b);
  const ev = (await a.wait(OP.CARD_PUZZLE_EVENT, (d) => d.type === 'completed', 5000)).data;
  console.log('completed:', ev.message);
  st = (await a.wait(OP.CARD_PUZZLE_STATE, (d) => d.eligibility)).data;
  assert.strictEqual(st.eligibility.altar, 'heart'); assert.deepStrictEqual(st.eligibility.disabledWishIds, []);
  a.send(OP.CARD_PUZZLE_WISH, { completionId: st.eligibility.completionId, wishId: 'heart_hp', clientSeq: 99 });
  const wr = (await a.wait(OP.CARD_PUZZLE_WISH_RESULT)).data; assert(wr.success, wr.message); console.log('wish:', wr.message);
  const after = await a.inv();
  assert.strictEqual(after.params.combat.maxHp, hpBefore + 200); assert.deepStrictEqual(after.params.cardPuzzle.claimedPermanentWishIds, ['heart_hp']);
  a.send(OP.CARD_PUZZLE_WISH, { completionId: st.eligibility.completionId, wishId: 'heart_mp' });
  console.log('second wish:', (await a.wait(OP.CARD_PUZZLE_WISH_RESULT)).data.message);
  // B wishes for skill points
  const sb = (await b.wait(OP.CARD_PUZZLE_STATE, (d) => d.eligibility)).data;
  const sp0 = (await b.inv()).params.progression.skillPoints;
  b.send(OP.CARD_PUZZLE_WISH, { completionId: sb.eligibility.completionId, wishId: 'heart_skill' });
  assert((await b.wait(OP.CARD_PUZZLE_WISH_RESULT)).data.success);
  assert.strictEqual((await b.inv()).params.progression.skillPoints, sp0 + 12); console.log('heart_skill +12 ok');
  // celebration clears the altar after 8 s
  st = (await a.wait(OP.CARD_PUZZLE_STATE, (d) => d.altars.find((x) => x.altar === 'heart').pieces.length === 0 && d.altars.find((x) => x.altar === 'heart').phase === 'collecting', 12000)).data;
  console.log('altar reset ok');
  // dragon: attribute redistribution
  for (let i = 0; i < 20; i += 1) a.chat('/item ' + (3920 + i));
  await new Promise((r) => setTimeout(r, 600));
  a.drain();
  const inv = await a.inv();
  for (const [i, it] of inv.inventory.slots.entries()) if (it && it.itemId >= 3920 && it.itemId <= 3939) a.send(OP.CARD_PUZZLE_PLACE, { fromIndex: i });
  st = (await a.wait(OP.CARD_PUZZLE_STATE, (d) => d.eligibility && d.eligibility.altar === 'dragon', 6000)).data;
  assert(/筋斗云/.test(st.eligibility.wishes ? JSON.stringify(st.eligibility.wishes) : JSON.stringify(st.eligibility)), 'dragon wish label');
  a.send(OP.CARD_PUZZLE_WISH, { completionId: st.eligibility.completionId, wishId: 'dragon_attributes' });
  const dw = (await a.wait(OP.CARD_PUZZLE_WISH_RESULT)).data;
  assert(dw.success && /筋斗云/.test(dw.message), JSON.stringify(dw)); console.log('dragon cloud ok', dw.message);
  await settings({ cardPuzzleNearSlot: true, cardPuzzleCooldownMin: 10 });
  a.close(); b.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
