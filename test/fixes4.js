'use strict';
// Protocol test for the fourth bug batch (gem values as corrected in the fifth): 吸取 gem bonuses and legacy suffixes, affix
// name colours, the admin item categories and stack counts, the skill point floor and
// cap, gear returned on a job change, overweight walking, the normal attack rate and
// merchants with more than 63 goods in a tab.
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
  c.inv = async () => { await sleep(250); c.send(OP.ITEM_QUERY, {}); return (await c.wait(OP.ITEM_STATE)).data; };
  c.go = async (map, x, y) => { c.drain(); c.chat('/go ' + map + (x != null ? ' ' + Math.round(x) + ' ' + Math.round(y) : '')); return (await c.wait(OP.MAP_SWITCH_RESULT, () => true, 6000)).data; };
  c.beat = setInterval(() => c.send(OP.HEARTBEAT, { clientTime: Date.now(), seq: 1 }), 2000);
  return c;
}
const items = (st) => st.inventory.slots.filter(Boolean);
const displays = (it) => (it.bonusAttrs || []).map((a) => a.display);

(async () => {
  const a = await player('FA');
  const cat = await api('items');
  const giveTo = (body) => api('character/' + a.id + '/items', body);

  // 1. The 吸取 gems: 磁性玉碎片 吸取生命 1%, 次磁性玉 吸取精力 2%, 磁性玉 吸取生命 4%.
  for (const [id, want] of [[1671, '吸取生命+1%'], [1681, '吸取精力+2%'], [1691, '吸取生命+4%']]) {
    const t = cat.items.find((x) => x.itemId === id);
    assert.deepStrictEqual(t.attrs, [want], t.name);
  }
  const aff = await api('affixes');
  const steal = aff.suffixes.find((x) => x.itemId === 1691);
  assert(steal && steal.attrs.join() === '吸取生命+4%', 'admin suffix list shows the gem bonus');
  console.log('steal gems ok');

  // 2. Item picker categories and setting a stack count.
  assert(cat.categories.includes('武器') && cat.categories.includes('药品') && cat.categories.includes('宝石与印刻'));
  assert.strictEqual(cat.items.find((x) => x.itemId === 3202).category, '武器');
  assert.strictEqual(cat.items.find((x) => x.itemId === 1691).category, '宝石与印刻');
  const med = cat.items.find((x) => x.category === '药品');
  await giveTo({ action: 'add', itemId: med.itemId, count: 5 });
  let st = await a.inv();
  let idx = st.inventory.slots.findIndex((x) => x && x.itemId === med.itemId);
  const r = await giveTo({ action: 'count', index: idx, count: 77 });
  assert(/→ 77/.test(r.done.join()), r.done.join());
  st = await a.inv();
  assert.strictEqual(st.inventory.slots[idx].count, 77);
  await assert.rejects(giveTo({ action: 'add', itemId: 3202, count: 1 }).then(() => a.inv()).then((s) => giveTo({ action: 'count', index: s.inventory.slots.findIndex((x) => x && x.itemId === 3202), count: 3 })), /装备不能叠加/);
  console.log('admin picker and count ok');

  // 3. Affixes added on the server mark the name colour; a suffix set by the admin too.
  st = await a.inv();
  idx = st.inventory.slots.findIndex((x) => x && x.itemId === 3202);
  await giveTo({ action: 'affix', index: idx, prefixItemId: 2305, suffixItemId: 1691 });
  st = await a.inv();
  const gun = st.inventory.slots[idx];
  assert(gun.ext.smithPrefixItemId > 0 && gun.ext.smithAttributeItemId > 0, 'two affixes: both colour ids set');
  assert(displays(gun).includes('吸取生命+4%') && !displays(gun).some((x) => /吸取精力/.test(x)), displays(gun).join());
  await giveTo({ action: 'affix', index: idx, prefixItemId: null, suffixItemId: null });
  st = await a.inv();
  assert(!st.inventory.slots[idx].ext.smithPrefixItemId && !st.inventory.slots[idx].ext.smithAttributeItemId, 'no affix: plain colour');
  console.log('affix colour ok');

  // 4. Job change: worn gunner gear goes back to the bag.
  a.chat('/prof gunner'); await sleep(300);
  st = await a.inv();
  idx = st.inventory.slots.findIndex((x) => x && x.itemId === 3202);
  a.send(OP.ITEM_EQUIP, { fromIndex: idx, slot: 'weapon', clientSeq: 1 });
  st = await a.inv();
  assert(st.equipment.weapon && st.equipment.weapon.itemId === 3202, 'gun equipped');
  a.drain();
  a.chat('/prof mage');
  const note = await a.wait(OP.CHAT_MESSAGE, (d) => /放回背包/.test(d.message || ''), 3000);
  console.log(note.data.message);
  st = await a.inv();
  assert(!st.equipment.weapon, 'gun taken off');
  assert(items(st).some((x) => x.itemId === 3202), 'gun in the bag');
  console.log('job change ok');

  // 5. Skill points: at least 2 a level, and never more than 1200 in total.
  a.chat('/level 101'); st = await a.inv();
  const pts = st.params.progression.skillPoints;
  assert(pts >= 200 && pts <= 300, '100 levels pay 200 to 300 points: ' + pts);
  const sp = await api('character/' + a.id, { skillPoints: 5000 });
  st = await a.inv();
  assert.strictEqual(st.params.progression.skillPoints, 1200, sp.done.join());
  a.chat('/level 300'); st = await a.inv();
  assert.strictEqual(st.params.progression.skillPoints, 1200, 'level-ups stop at the cap');
  console.log('skill points ok', pts);

  // 6. Over the weight limit the player walks at half speed and cannot run faster.
  st = await a.inv();
  const speed0 = st.params.combat.moveSpeed;
  const room = st.params.combat.maxWeight - st.params.combat.weight;
  await giveTo({ action: 'add', itemId: 105, count: Math.ceil(room / 25) + 2 });
  st = await a.inv();
  assert(st.params.combat.weight > st.params.combat.maxWeight);
  assert.strictEqual(st.params.combat.moveSpeed, 60, 'overweight speed ' + st.params.combat.moveSpeed + ' (was ' + speed0 + ')');
  idx = st.inventory.slots.findIndex((x) => x && x.itemId === 105);
  await giveTo({ action: 'remove', index: idx });
  st = await a.inv();
  assert.strictEqual(st.params.combat.moveSpeed, speed0, 'speed back after dropping the load');
  console.log('overweight ok', speed0, '→ 60');

  // 7. Normal attacks: clicking faster than the attack speed gives no extra attacks.
  const b = await player('FB');
  const sa = await a.go('hunt_p_01');
  const me = (sa.players || []).find((p) => p.playerId === a.id) || { x: 0, y: 0 };
  await b.go('hunt_p_01', me.x, me.y);
  await sleep(1500); b.drain();
  st = await a.inv();
  const interval = st.params.combat.attackIntervalMs;
  const t0 = Date.now();
  for (let i = 0; i < 12; i += 1) {
    a.send(OP.ACTION, { action: { type: 'attack', attackPhase: 'fire', x: me.x, y: me.y, aimX: me.x + 80, aimY: me.y, seq: 100 + i, timestamp: Date.now() } });
    await sleep(150);
  }
  await sleep(300);
  const span = Date.now() - t0;
  let seen = 0;
  try { for (;;) { await b.wait(OP.ATTACK_ACTION, (d) => d.attackerId === a.id && d.phase === 'fire', 200); seen += 1; } } catch (_) { /* no more */ }
  const most = Math.floor(span / (interval * 0.9)) + 1;
  console.log('12 clicks in', span, 'ms, attacks', seen, 'at most', most, 'interval', Math.round(interval));
  assert(seen >= 1 && seen <= most, 'attack rate follows attack speed');
  clearInterval(b.beat); b.close();

  // 8. A merchant with more than 63 goods in a tab: the whole list is sent.
  const stackables = cat.items.filter((x) => x.stackable && x.category !== '盲盒' && x.category !== '药品' && x.category !== '技能书').slice(0, 100).map((x) => x.itemId);
  await api('shop/hunt_in:tools', { items: stackables });
  await a.go('hunt_in'); a.drain();
  a.send(OP.SHOP_QUERY, { kind: 'tools' });
  const shop = (await a.wait(OP.SHOP_STATE)).data;
  console.log('misc tab', shop.tabs.misc.length);
  assert(shop.tabs.misc.length > 63, 'more than one page of goods');
  await api('shop/hunt_in:tools', { reset: true });
  console.log('shop pages ok');

  clearInterval(a.beat); a.close();
  console.log('FIXES4 OK'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
