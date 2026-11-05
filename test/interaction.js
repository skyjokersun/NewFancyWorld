'use strict';
// Protocol test: party (/team), poses, expressions, inspect, hug, trade, stall.
const assert = require('assert');
const { TestClient, OP } = require('./client');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
const MAP = process.argv[3] || 'square_in';

async function player(tag) {
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  const email = tag + Date.now() + Math.floor(Math.random() * 1e4) + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' });
  await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123' }); await c.wait(OP.LOGIN_SUCCESS);
  c.name = tag + String(Date.now()).slice(-6);
  c.send(OP.CHARACTER_CREATE, { nickname: c.name, appearance: { gender: 'man', customAvatar: 'data:image/png;base64,iVBORw0KGgo=' } });
  await c.wait(OP.CHARACTER_CREATE_RESULT);
  c.id = (await c.wait(OP.LOGIN_SUCCESS)).data.playerId;
  await c.wait(OP.CHARACTER_INTERACTION_EVENT, (d) => d.type === 'snapshot');
  c.chat = (m) => c.send(OP.CHAT, { channel: 'world', message: m });
  c.act = (d) => c.send(OP.CHARACTER_INTERACTION, d);
  c.ev = (type, ms) => c.wait(OP.CHARACTER_INTERACTION_EVENT, (d) => d.type === type, ms).then((p) => p.data);
  c.party = (pred = () => true) => c.wait(OP.CHAT_MESSAGE, (d) => Object.prototype.hasOwnProperty.call(d, 'partyState') && pred(d.partyState)).then((p) => p.data.partyState);
  c.state = async () => { c.send(OP.ITEM_QUERY, {}); return (await c.wait(OP.ITEM_STATE)).data; };
  return c;
}

(async () => {
  const [a, b, c] = [await player('A'), await player('B'), await player('C')];
  for (const p of [a, b, c]) { p.chat('/go ' + MAP); await p.wait(OP.MAP_SWITCH_RESULT); }
  await new Promise((r) => setTimeout(r, 300));
  for (const p of [a, b, c]) p.drain();

  // --- party ---
  a.chat('/team invite ' + b.name);
  const inv = await b.wait(OP.CHAT_MESSAGE, (d) => d.channel === 'party_invite' && d.partyInvite);
  assert.strictEqual(inv.data.partyInvite.inviterName, a.name);
  b.chat('/team accept ' + a.name);
  const ps = await a.party((s) => s && s.members.length === 2);
  const psb = await b.party((s) => s && s.members.length === 2);
  assert(ps.members.find((m) => m.playerName === a.name).leader);
  assert.strictEqual(psb.partyId, ps.partyId);
  assert(ps.members[0].appearance.customAvatar, 'custom avatar kept');
  console.log('party ok:', ps.name, ps.members.map((m) => m.playerName + (m.leader ? '*' : '')).join(','));
  b.send(OP.CHAT, { channel: 'team', message: 'hi team' });
  const tm = await a.wait(OP.CHAT_MESSAGE, (d) => d.channel === 'team' && d.message === 'hi team');
  console.log('team chat ok from', tm.data.from);
  a.send(OP.ITEM_QUERY, {});
  const prm = (await a.wait(OP.ITEM_STATE)).data.params.profile;
  assert(prm.team && prm.duty === '队长'); console.log('params team:', prm.team, prm.duty);
  b.chat('/team leave');
  assert.strictEqual(await a.party(), null); assert.strictEqual(await b.party(), null);
  console.log('leave -> disbanded ok');

  // --- pose / expression / inspect ---
  a.act({ type: 'pose', pose: 'sit' });
  let e = await b.ev('state'); assert.strictEqual(e.pose, 'sit'); assert.strictEqual(e.playerId, a.id);
  a.act({ type: 'expression', expressionId: 3 });
  e = await c.ev('expression'); assert.strictEqual(e.expressionId, 3);
  b.act({ type: 'inspect', targetPlayerId: a.id });
  e = await b.ev('inspect'); assert.strictEqual(e.target.playerName, a.name);
  console.log('pose/expression/inspect ok:', e.target.professionName, 'age', e.target.age);

  // --- hug ---
  a.act({ type: 'target_request', action: 'hug', targetPlayerId: b.id });
  let req = await b.ev('request'); assert.strictEqual(req.fromPlayerName, a.name);
  b.act({ type: 'target_response', requestId: req.requestId, accepted: true });
  e = await c.ev('perform'); assert.strictEqual(e.fromPlayerId, a.id);
  console.log('hug perform ok');

  // --- trade ---
  const sa = await a.state(); const sb = await b.state();
  const goldA = sa.params.profile.gold; const goldB = sb.params.profile.gold;
  const idx = sa.inventory.slots.findIndex((it) => it && it.count >= 3);
  const it = sa.inventory.slots[idx];
  a.act({ type: 'target_request', action: 'trade', targetPlayerId: b.id });
  req = await b.ev('request');
  b.act({ type: 'target_response', requestId: req.requestId, accepted: true });
  let ta = (await a.ev('trade_state')).trade; await b.ev('trade_state');
  a.act({ type: 'trade_offer', sessionId: ta.sessionId, inventoryIndex: idx, itemSeqId: it.seqId, count: 2 });
  ta = (await a.ev('trade_state')).trade; let tb = (await b.ev('trade_state')).trade;
  assert.strictEqual(tb.otherOffers[0].count, 2); assert.strictEqual(tb.otherOffers[0].item.name, it.name);
  b.act({ type: 'trade_gold', sessionId: ta.sessionId, gold: 100 });
  await a.ev('trade_state'); await b.ev('trade_state');
  b.act({ type: 'trade_confirm', sessionId: ta.sessionId });
  tb = (await a.ev('trade_state')).trade; assert(tb.otherConfirmed); await b.ev('trade_state');
  a.act({ type: 'trade_confirm', sessionId: ta.sessionId });
  e = await a.ev('trade_closed'); await b.ev('trade_closed');
  const sa2 = await a.state(); const sb2 = await b.state();
  assert.strictEqual(sa2.params.profile.gold, goldA + 100);
  assert.strictEqual(sb2.params.profile.gold, goldB - 100);
  assert.strictEqual(sa2.inventory.slots[idx].count, it.count - 2);
  const got = sb2.inventory.slots.filter((x) => x && x.itemId === it.itemId).reduce((n, x) => n + x.count, 0);
  assert.strictEqual(got, it.count + 2);
  console.log('trade ok:', e.message, it.name, 'x2 for 100 gold');

  // --- stall ---
  a.drain();
  a.act({ type: 'stall', direction: 1 });
  e = await a.ev('error'); assert(/执照/.test(e.message)); console.log('no license:', e.message);
  a.chat('/gold 2500000'); await a.wait(OP.CHAT_MESSAGE, () => true).catch(() => {});
  a.chat('/go townhouse'); await a.wait(OP.MAP_SWITCH_RESULT);
  a.send(OP.TOWNHOUSE_SERVICE, { type: 'business_apply', service: 'business' });
  let lic = (await a.wait(OP.TOWNHOUSE_SERVICE_EVENT)).data;
  console.log('license:', lic.message); assert(lic.businessLicense && lic.gold === 1500000);
  const exp1 = lic.businessLicenseExpiresAt;
  assert(Math.abs(exp1 - Date.now() - 15 * 864e5) < 60000, '15 days');
  a.send(OP.TOWNHOUSE_SERVICE, { type: 'business_apply', service: 'business' });
  lic = (await a.wait(OP.TOWNHOUSE_SERVICE_EVENT)).data;
  console.log('renew:', lic.message); assert(Math.abs(lic.businessLicenseExpiresAt - exp1 - 15 * 864e5) < 1000 && lic.gold === 500000);
  a.send(OP.TOWNHOUSE_SERVICE, { type: 'business_apply', service: 'business' });
  lic = (await a.wait(OP.TOWNHOUSE_SERVICE_EVENT)).data; assert.strictEqual(lic.type, 'error'); console.log('not enough gold:', lic.message);
  a.chat('/go ' + MAP); await a.wait(OP.MAP_SWITCH_RESULT);
  await new Promise((r) => setTimeout(r, 300)); a.drain(); c.drain();
  a.act({ type: 'stall', direction: 1 });
  const st = await a.ev('stall_detail'); assert(st.editable);
  const cs = await c.ev('stall_state'); assert.strictEqual(cs.ownerPlayerId, a.id);
  const sa3 = await a.state();
  const sidx = sa3.inventory.slots.findIndex((x) => x && x.count >= 1);
  const sit = sa3.inventory.slots[sidx];
  a.act({ type: 'stall_update', name: '测试小店', listings: [{ inventoryIndex: sidx, itemSeqId: sit.seqId, count: 1, unitPrice: 50, description: '便宜卖' }] });
  const up = await a.ev('stall_detail'); assert.strictEqual(up.stall.listings.length, 1); assert.strictEqual(up.stall.name, '测试小店');
  c.drain();
  c.act({ type: 'stall_open', ownerPlayerId: a.id });
  const cd = await c.ev('stall_detail'); assert(!cd.editable); assert.strictEqual(cd.stall.listings[0].unitPrice, 50);
  const sc0 = await c.state(); const goldC = sc0.params.profile.gold; const goldA2 = sa3.params.profile.gold;
  c.drain();
  c.act({ type: 'stall_buy', ownerPlayerId: a.id, listingId: cd.stall.listings[0].listingId, count: 1 });
  e = await c.ev('error'); console.log('buy:', e.message);
  const sc1 = await c.state(); const sa4 = await a.state();
  assert.strictEqual(sc1.params.profile.gold, goldC - 50);
  assert.strictEqual(sa4.params.profile.gold, goldA2 + 49);  // 1% tax near the stall
  console.log('stall ok: buyer -50, seller +49');
  a.act({ type: 'stall' });
  await c.wait(OP.CHARACTER_INTERACTION_EVENT, (d) => d.type === 'stall_state' && d.stall === null);
  console.log('stall closed ok');
  // An expired license closes the stall automatically and blocks reopening.
  a.drain(); a.act({ type: 'stall', direction: 0 }); await a.ev('stall_detail');
  a.chat('/license 0');
  await c.wait(OP.CHARACTER_INTERACTION_EVENT, (d) => d.type === 'stall_state' && d.stall === null, 12000);
  console.log('expired license -> stall auto closed');
  a.drain(); a.act({ type: 'stall', direction: 0 });
  e = await a.ev('error'); assert(/过期/.test(e.message)); console.log('reopen:', e.message);
  for (const p of [a, b, c]) p.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
