'use strict';
// Protocol test for gardens: modern planting (newgarden) and legacy adoption
// (garden_0x), plus the map links into and out of the orchards.
const assert = require('assert');
const { TestClient, OP } = require('./client');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
const ACTION = 5800; const STATE = 5810; const ERROR = 5899;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  const email = 'gd' + Date.now() + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' });
  await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123' }); await c.wait(OP.LOGIN_SUCCESS);
  c.send(OP.CHARACTER_CREATE, { nickname: 'G' + String(Date.now()).slice(-6), appearance: { gender: 'man' } });
  await c.wait(OP.CHARACTER_CREATE_RESULT); await c.wait(OP.LOGIN_SUCCESS);
  const chat = (m) => c.send(OP.CHAT, { channel: 'world', message: m });
  chat('/gold 50000'); await sleep(200);
  const req = async (action, extra = {}) => {
    c.drain();
    c.send(ACTION, Object.assign({ action }, extra));
    const m = await c.waitAny([STATE, ERROR], 5000);
    return { ok: m.opCode === STATE, d: m.data };
  };

  // links: workaround_in -> newgarden_01 (teleport2 menu) and back via the exit
  chat('/go workaround_in'); await c.wait(OP.MAP_SWITCH_RESULT);
  c.send(OP.MAP_SWITCH, { mapRef: 'newgarden_01', clientSeq: 1, targetGx: 3, targetGy: 253 });
  let ms = (await c.wait(OP.MAP_SWITCH_RESULT)).data; console.log('enter newgarden', ms.success, ms.mapRef); assert(ms.success);

  let r = await req('snapshot');
  console.log('modern snapshot', r.ok, r.d.mode, 'plots', r.d.plots.length, 'seeds', r.d.seeds.map((s) => s.treeKey + (s.unlocked ? '+' : '-')).join(' '));
  r = await req('buy_seed', { treeKey: 'tianyu' }); console.log('buy as non-gardener:', r.ok, r.d.message); assert(!r.ok);
  chat('/prof gardener'); await sleep(200);
  r = await req('buy_seed', { treeKey: 'tianyu' }); console.log('buy seed:', r.ok, r.d.message); assert(r.ok);
  r = await req('buy_seed', { treeKey: 'caise' }); console.log('buy locked seed:', r.ok, r.d.message); assert(!r.ok);
  const pit = r.ok ? null : (await req('snapshot')).d.plots.find((x) => x.stage === 'empty');
  r = await req('plant', { sourceIndex: pit.sourceIndex, treeKey: 'tianyu' }); console.log('plant:', r.ok, r.d.message); assert(r.ok);
  let plot = r.d.plots.find((x) => x.sourceIndex === pit.sourceIndex); console.log('plot', plot.stage, plot.treeName, 'day', plot.growthDay, 'w/f/p', plot.water, plot.food, plot.pests, 'canCare', plot.canCare);
  r = await req('plant', { sourceIndex: pit.sourceIndex, treeKey: 'tianyu' }); console.log('plant occupied:', r.ok, r.d.message); assert(!r.ok);
  for (const care of ['water', 'fertilize', 'pesticide']) { r = await req('care', { sourceIndex: pit.sourceIndex, care }); console.log('care', care, r.ok, r.d.message); assert(r.ok); }
  r = await req('care', { sourceIndex: pit.sourceIndex, care: 'water' }); console.log('care cooldown:', r.ok, r.d.message); assert(!r.ok);
  r = await req('harvest', { sourceIndex: pit.sourceIndex }); console.log('harvest early:', r.ok, r.d.message); assert(!r.ok);
  chat('/garden 5'); await sleep(300);
  r = await req('snapshot'); plot = r.d.plots.find((x) => x.sourceIndex === pit.sourceIndex); console.log('after 5 days', plot.stage, 'day', plot.growthDay, 'life', plot.life, 'canHarvest', plot.canHarvest);
  assert.strictEqual(plot.stage, 'mature');
  r = await req('harvest', { sourceIndex: pit.sourceIndex }); console.log('harvest:', r.ok, r.d.message); assert(r.ok);
  c.send(OP.ITEM_QUERY, {}); const inv = (await c.wait(OP.ITEM_STATE)).data.inventory.slots;
  const fruit = inv.find((it) => it && it.itemId === 101); console.log('fruit in bag', fruit && fruit.name, fruit && fruit.count); assert(fruit);

  // exit back to workaround_in
  c.send(OP.MAP_SWITCH, { mapRef: 'workaround_in', clientSeq: 2, targetGx: 9, targetGy: 14 });
  ms = (await c.wait(OP.MAP_SWITCH_RESULT)).data; console.log('exit garden', ms.success, ms.mapRef, ms.message); assert(ms.success);
  r = await req('snapshot'); console.log('outside garden:', r.ok, r.d.message); assert(!r.ok);

  // legacy orchard
  c.send(OP.MAP_SWITCH, { mapRef: 'garden_01', clientSeq: 3, targetGx: 16, targetGy: 22 });
  ms = (await c.wait(OP.MAP_SWITCH_RESULT)).data; console.log('enter garden_01', ms.success); assert(ms.success);
  r = await req('snapshot'); console.log('legacy snapshot', r.d.mode, 'plots', r.d.plots.length, 'unowned', r.d.legacy.unownedTrees.length, 'max', r.d.maxTrees, 'card', r.d.workCardRemainingDays);
  const tree = r.d.legacy.unownedTrees[0];
  r = await req('adopt', { sourceIndex: tree.sourceIndex }); console.log('adopt w/o card:', r.ok, r.d.message); assert(!r.ok);
  r = await req('buy_work_card', { workCardDays: 30 }); console.log('buy card:', r.ok, r.d.message, r.d.workCardRemainingDays); assert(r.ok);
  r = await req('adopt', { sourceIndex: tree.sourceIndex }); console.log('adopt:', r.ok, r.d.message, 'own', r.d.legacy.ownTrees.length); assert(r.ok);
  const other = r.d.legacy.unownedTrees[0];
  r = await req('adopt', { sourceIndex: other.sourceIndex }); console.log('adopt beyond cap:', r.ok, r.d.message); assert(!r.ok);
  r = await req('care', { sourceIndex: tree.sourceIndex, care: 'water' }); console.log('care legacy', r.ok, r.d.message);
  chat('/garden 5'); await sleep(300);
  r = await req('harvest', { sourceIndex: tree.sourceIndex }); console.log('legacy harvest:', r.ok, r.d.message, 'lvl', r.d.legacy.level, 'exp', r.d.legacy.experience, 'incidents', r.d.legacy.incidents.length); assert(r.ok);
  r = await req('snapshot'); const mine = r.d.legacy.ownTrees[0];
  if (mine) { r = await req('release_tree', { targetMapRef: mine.mapRef, sourceIndex: mine.sourceIndex }); console.log('release:', r.ok, r.d.message); assert(r.ok); }
  c.send(OP.MAP_SWITCH, { mapRef: 'workaround_in', clientSeq: 4, targetGx: 9, targetGy: 71 });
  ms = (await c.wait(OP.MAP_SWITCH_RESULT)).data; console.log('exit legacy', ms.success); assert(ms.success);
  console.log('GARDEN OK'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
