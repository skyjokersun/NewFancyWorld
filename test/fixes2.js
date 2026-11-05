'use strict';
// Protocol test for the second bug batch: movement re-routing, ranged shots
// hitting the first monster on their line, the wider poison cloud, skill points
// after a GM lowered the level, the weight limit setting, card puzzle tile and
// cooldown rules, the dragon attribute cap and blind boxes.
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
  c.inv = async () => { await sleep(150); c.send(OP.ITEM_QUERY, {}); return (await c.wait(OP.ITEM_STATE)).data; };
  c.go = async (map, x, y) => { c.drain(); c.chat('/go ' + map + (x != null ? ' ' + Math.round(x) + ' ' + Math.round(y) : '')); return (await c.wait(OP.MAP_SWITCH_RESULT, () => true, 6000)).data; };
  c.beat = setInterval(() => c.send(OP.HEARTBEAT, { clientTime: Date.now(), seq: 1 }), 2000);
  return c;
}
const selfIn = (c, mu) => (mu.players || []).find((p) => p.playerId === c.id);

(async () => {
  await api('settings/reset', {});
  const c = await player('FX');

  // 1. A new move replaces the old route instead of queueing behind it.
  await c.go('square_in', 2700, -1150);
  c.send(OP.ACTION, { action: { type: 'move', x: 3100, y: -1150, z: 0, seq: 5, timestamp: Date.now() } });
  await sleep(200);
  c.drain();
  c.send(OP.ACTION, { action: { type: 'move', x: 2500, y: -1150, z: 0, seq: 6, timestamp: Date.now() } });
  const mu = (await c.wait(OP.MOVE_UPDATE, (d) => { const s = selfIn(c, d); return s && s.seq === 6; })).data;
  const me = selfIn(c, mu);
  console.log('re-route: path', JSON.stringify(me.path));
  assert.deepStrictEqual(me.path, [[2500, -1150]]);

  // 2. Ranged normal attack on the ground hits the first monster on the line.
  c.chat('/level 30');
  let ms = await c.go('hunt_p_01');
  const lone = (ms.enemies || []).find((m) => (ms.enemies || []).every((o) => o === m || Math.hypot(o.x - m.x, o.y - m.y) > 260));
  assert(lone, 'a monster standing alone');
  // Stand ~150 px from it on a walkable spot.
  let m = lone; let meNow = null;
  for (const [ox, oy] of [[-150, 0], [150, 0], [0, -150], [0, 150], [-110, -110], [110, 110], [-110, 110], [110, -110]]) {
    ms = await c.go('hunt_p_01', lone.x + ox, lone.y + oy);
    meNow = selfIn(c, ms); m = (ms.enemies || []).find((e) => e.enemyId === lone.enemyId) || lone;
    if (Math.hypot(meNow.x - m.x, meNow.y - m.y) < 230) break;
  }
  const mid = m.enemyId;
  const d0 = Math.hypot(m.x - meNow.x, m.y - meNow.y); const ux = (m.x - meNow.x) / d0; const uy = (m.y - meNow.y) / d0;
  console.log('monster', mid, 'at', Math.round(d0), 'px');
  c.drain();
  // Aim at the ground 120 px past the monster: the stone flies through it.
  c.send(OP.ACTION, { action: { type: 'attack', attackPhase: 'fire', attackType: 'ranged_lock_on', x: meNow.x, y: meNow.y, aimX: m.x + ux * 120, aimY: m.y + uy * 120, seq: 7, timestamp: Date.now() } });
  const hit = (await c.wait(OP.ATTACK_RESULT, (d) => d.attackerId === c.id, 3000)).data;
  console.log('ground shot hit', hit.targetId, 'damage', hit.damage);
  assert.strictEqual(hit.targetId, mid);

  // 3. Poison cloud aimed next to a monster locks onto it.
  await sleep(1600);
  c.chat('/heal'); await sleep(200);
  c.drain();
  c.send(OP.ACTION, { action: { type: 'attack', attackPhase: 'fire', attackType: 'timed_point_bomb', skillId: 'child_poison_cast', x: meNow.x, y: meNow.y, aimX: m.x - uy * 90, aimY: m.y + ux * 90, seq: 8, timestamp: Date.now() } });
  const ph = (await c.wait(OP.ATTACK_RESULT, (d) => d.attackerId === c.id, 3000)).data;
  console.log('poison hit', ph.targetId, 'damage', ph.damage, ph.attackType);
  assert.strictEqual(ph.attackType, 'timed_point_bomb');

  // 4. Skill points: GM lowers the level, levelling up again pays.
  let st = await c.inv(); const sp30 = st.params.progression.skillPoints;
  c.chat('/level 20'); c.chat('/level 25');
  st = await c.inv();
  console.log('skill points at 30:', sp30, 'after /level 20 then 25:', st.params.progression.skillPoints);
  // 5 levels at 1 to 3 points each (luck).
  const d = st.params.progression.skillPoints - sp30;
  assert(d >= 5 && d <= 15, '5 levels paid ' + d);

  // 5. Weight: off by default, the admin setting turns the limit on.
  c.chat('/item 72 300'); await sleep(300);
  st = await c.inv(); console.log('weight', st.params.combat.weight, '/', st.params.combat.maxWeight);
  assert(st.params.combat.weight > st.params.combat.maxWeight);
  c.drain(); c.send(OP.SHOP_BUY, { kind: 'tools', itemId: 72, count: 1 });
  const buy = await c.waitAny([OP.ITEM_DELTA, OP.ITEM_OP_ERROR]); assert.strictEqual(buy.opCode, OP.ITEM_DELTA); console.log('overweight buy allowed');
  await api('settings', { values: { weightLimit: true } });
  c.drain(); c.send(OP.SHOP_BUY, { kind: 'tools', itemId: 72, count: 1 });
  const buy2 = await c.waitAny([OP.ITEM_DELTA, OP.ITEM_OP_ERROR]); assert.strictEqual(buy2.opCode, OP.ITEM_OP_ERROR); console.log('weight limit on: buy refused, code', buy2.data.code);
  await api('settings', { values: { weightLimit: false } });

  // 6. Blind boxes: one box of a stack opens one; the admin list decides the contents.
  const boxes = (await api('blindboxes')).boxes; const box = boxes.find((b) => b.itemId === 900010);
  console.log('box', box.name, 'default pool', box.pool.length);
  c.chat('/item 900010 3'); await sleep(300);
  st = await c.inv(); let bi = st.inventory.slots.findIndex((it) => it && it.itemId === 900010);
  c.drain(); c.send(OP.ITEM_USE, { fromIndex: bi }); await c.wait(OP.ITEM_DELTA);
  st = await c.inv();
  assert.strictEqual(st.inventory.slots[bi].count, 2); console.log('opened one of 3, left', st.inventory.slots[bi].count);
  await api('blindbox/900010', { pool: [{ itemId: 577, weight: 5 }] });
  c.drain(); c.send(OP.ITEM_USE, { fromIndex: bi });
  const d1 = (await c.wait(OP.ITEM_DELTA)).data; console.log('custom pool gave', d1.dropMessage);
  assert(/短弓/.test(d1.dropMessage));
  await assert.rejects(api('blindbox/900010', { pool: [] }), /至少/);
  const ex = await (await fetch(http + '/admin/api/settings/export')).json();
  assert.deepStrictEqual(ex.blindBoxPools['900010'], [{ itemId: 577, weight: 5 }]);
  let r = await api('blindbox/900010', { reset: true }); assert(!r.boxes.find((b) => b.itemId === 900010).custom);
  r = await api('settings/import', ex); assert(r.done.includes('盲盒内容')); assert((await api('blindboxes')).boxes.find((b) => b.itemId === 900010).custom);
  r = await api('settings/reset', {}); assert(r.done.includes('盲盒内容')); console.log('blind box export/import/reset ok');

  // 7. Card puzzle: stand on the card's tile; cooldown after completion; dragon cap.
  await api('settings', { values: { cardPuzzleCooldownMin: 1 } });
  await c.go('pintu');
  for (let i = 0; i < 20; i += 1) c.chat('/item ' + (3920 + i));
  await sleep(600);
  st = await c.inv();
  const cards = st.inventory.slots.map((it, i) => [it, i]).filter(([it]) => it && it.itemId >= 3920 && it.itemId <= 3939);
  c.drain(); c.send(OP.CARD_PUZZLE_PLACE, { fromIndex: cards[0][1] });
  const far = (await c.wait(OP.CARD_PUZZLE_ERROR)).data.message; console.log('far away:', far); assert(/走到.*格子/.test(far));
  const { slotCentre, ALTARS } = require('../src/features/cardpuzzle');
  let state;
  for (const [it, i] of cards) {
    const pos = slotCentre(ALTARS.dragon, it.itemId - 3920);
    await c.go('pintu', pos.x + 20, pos.y);
    c.drain(); c.send(OP.CARD_PUZZLE_PLACE, { fromIndex: i });
    state = await c.waitAny([OP.CARD_PUZZLE_STATE, OP.CARD_PUZZLE_ERROR]);
    assert.notStrictEqual(state.opCode, OP.CARD_PUZZLE_ERROR, state.data.message);
  }
  st = (await c.wait(OP.CARD_PUZZLE_STATE, (d) => d.eligibility && d.eligibility.altar === 'dragon', 6000)).data;
  // Eighth batch: the dragon wish grants 筋斗云 for half a month instead of an attribute redraw.
  c.drain(); c.send(OP.CARD_PUZZLE_WISH, { completionId: st.eligibility.completionId, wishId: 'dragon_attributes' });
  const w2 = (await c.wait(OP.CARD_PUZZLE_WISH_RESULT)).data; assert(w2.success && /筋斗云/.test(w2.message), w2.message); console.log('dragon wish:', w2.message);
  await sleep(9000);   // celebration ends, cooldown starts
  c.chat('/item 3920'); await sleep(400); st = await c.inv();
  const ci = st.inventory.slots.findIndex((it) => it && it.itemId === 3920);
  const pos0 = slotCentre(ALTARS.dragon, 0); await c.go('pintu', pos0.x, pos0.y);
  c.drain(); c.send(OP.CARD_PUZZLE_PLACE, { fromIndex: ci });
  const cd = (await c.wait(OP.CARD_PUZZLE_ERROR)).data.message; console.log('cooldown:', cd); assert(/冷却/.test(cd));

  await api('settings/reset', {});
  clearInterval(c.beat); c.close();
  console.log('FIXES2 OK'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
