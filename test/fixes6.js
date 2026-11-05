'use strict';
// Protocol test for the sixth bug batch: 吸取 / 反伤 really happen, the warrior's reach
// follows the weapon, mage level-10 skills, 狐仙 skills and drops, repair-only fusion,
// the admin job change model, and the editable login notice.
const assert = require('assert');
const { TestClient, OP } = require('./client');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
const http = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, body) => {
  const r = await fetch(http + '/admin/api/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};

async function player(tag, gender = 'man') {
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  c.email = tag + Date.now() + Math.floor(Math.random() * 1e4) + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email: c.email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email: c.email, password: 'password123', code, purpose: 'register' }); await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: c.email, password: 'password123' }); await c.wait(OP.LOGIN_SUCCESS);
  c.name = tag + String(Date.now()).slice(-6);
  c.send(OP.CHARACTER_CREATE, { nickname: c.name, appearance: { gender } });
  await c.wait(OP.CHARACTER_CREATE_RESULT);
  c.id = (await c.wait(OP.LOGIN_SUCCESS)).data.playerId;
  c.chat = (m) => c.send(OP.CHAT, { channel: 'world', message: m });
  c.inv = async () => { await sleep(250); c.send(OP.ITEM_QUERY, {}); return (await c.wait(OP.ITEM_STATE)).data; };
  c.go = async (map, x, y) => { c.drain(); c.chat('/go ' + map + (x != null ? ' ' + Math.round(x) + ' ' + Math.round(y) : '')); return (await c.wait(OP.MAP_SWITCH_RESULT, () => true, 6000)).data; };
  c.give = (body) => api('character/' + c.id + '/items', body);
  c.equip = async (itemId) => {
    const st = await c.inv(); const i = st.inventory.slots.findIndex((x) => x && x.itemId === itemId);
    c.send(OP.ITEM_EQUIP, { fromIndex: i }); return c.inv();
  };
  c.beat = setInterval(() => c.send(OP.HEARTBEAT, { clientTime: Date.now(), seq: 1 }), 2000);
  return c;
}

// Stands next to a live monster on the hunting maps and returns it.
async function nearMonster(c, gap = 60) {
  for (const ref of ['hunt_p_01', 'hunt_p_02', 'hunt_p_03', 'hunt_p_04', 'hunt_p_05']) {
    const snap = await c.go(ref);
    const m = (snap.enemies || []).find((e) => e.state !== 'dead' && e.hp > 0 && !/狐仙/.test(e.name || ''));
    if (m) { const at = await c.go(ref, m.x - gap, m.y); return { m, me: at.players.find((p) => p.playerId === c.id), ref }; }
  }
  throw new Error('no monster');
}
let seq = 1000;
function attack(c, me, m) {
  c.send(OP.ACTION, { action: { type: 'attack', attackPhase: 'fire', x: me.x, y: me.y, aimX: m.x, aimY: m.y, targetId: m.enemyId, seq: ++seq, timestamp: Date.now() } });
}

(async () => {
  await api('settings/reset', {});
  const a = await player('SA');

  // 1. Warrior reach: bare hands and blades 120 px melee; a bow shoots from 400 and no 剑气.
  a.chat('/level 80'); a.chat('/prof warrior');
  let st = await a.inv();
  assert.strictEqual(st.params.combat.attackRange, 120, 'bare-handed reach ' + st.params.combat.attackRange);
  await a.give({ action: 'add', itemId: 577, count: 1 });
  st = await a.equip(577);
  assert.strictEqual(st.params.combat.attackRange, 400, 'bow reach ' + st.params.combat.attackRange);
  a.chat('/plevel 30'); a.chat('/item 311 1'); st = await a.inv();
  a.send(OP.ITEM_USE, { fromIndex: st.inventory.slots.findIndex((x) => x && x.itemId === 311) }); await sleep(300);
  st = await a.inv();
  assert(st.params.professionSkills.some((s) => s.id === 'warrior_jianqi'), 'learned 剑气');
  await a.go('hunt_p_01'); a.drain();
  a.send(OP.ACTION, { action: { type: 'attack', attackPhase: 'fire', skillId: 'warrior_jianqi', x: 0, y: 0, aimX: 100, aimY: 0, seq: ++seq, timestamp: Date.now() } });
  const refuse = await a.wait(OP.CHAT_MESSAGE, (d) => /剑气要拿刀剑/.test(JSON.stringify(d)), 3000);
  assert(refuse, '剑气 refused with a bow');
  await a.give({ action: 'add', itemId: 785, count: 1, suffixItemId: 1691 });
  st = await a.equip(785);
  assert.strictEqual(st.params.combat.attackRange, 120, 'blade reach ' + st.params.combat.attackRange);
  console.log('warrior reach ok');

  // 2. 吸取生命 (blade with 黑洞 4%): the result carries the swirl and the amount. At full
  //    life nothing is drawn, so first check that, then hurt the fighter.
  a.chat('/heal');
  const { m, me } = await nearMonster(a);
  a.drain();
  {
    attack(a, me, m);
    const r = await a.wait(OP.ATTACK_RESULT, (d) => d.attackerId === a.id && d.targetId === m.enemyId, 2500).catch(() => null);
    assert(!(r && r.data.stealEffects), 'no life steal at full life');
    await sleep(1200);
  }
  console.log('no steal at full life ok');
  // That hit may have killed it: take another monster.
  const next = await nearMonster(a);
  a.chat('/hurt 30'); await sleep(300); a.drain();
  let steal = null;
  for (let i = 0; i < 6 && !steal; i += 1) {
    attack(a, next.me, next.m);
    const r = await a.wait(OP.ATTACK_RESULT, (d) => d.attackerId === a.id && d.targetId === next.m.enemyId, 2500).catch(() => null);
    if (r && r.data.stealEffects) steal = r.data;
    await sleep(1200);
  }
  assert(steal, 'life steal shows up in the attack result');
  assert.deepStrictEqual(steal.stealEffects, ['life']);
  assert(steal.stealHp >= 1, 'stealHp ' + steal.stealHp);
  console.log('life steal ok', steal.damage, '+' + steal.stealHp);

  // 3. 反伤 (armor with 镜): the monster loses HP when it hits. A weak fighter, so the
  //    monster lives long enough to hit back.
  await a.go('square_in');
  const d = await player('SD');
  await d.give({ action: 'add', itemId: 1026, count: 1, suffixItemId: 1690 });
  await d.equip(1026);
  const near = await nearMonster(d, 50);
  d.drain();
  attack(d, near.me, near.m);
  const dst = await d.inv();
  if (process.env.DBG) { console.log('armor', JSON.stringify(dst.equipment && dst.equipment.armor || dst.params.combat.extraAttrs)); d.on && 0; }
  const back = await d.wait(OP.ATTACK_RESULT, (x) => { if (process.env.DBG) console.log('AR', JSON.stringify(x).slice(0, 200)); return x.attackerId === d.id && x.reflected; }, 15000).catch(() => null);
  assert(back, 'reflected damage hits the monster');
  assert(back.data.damage > 0 && Number.isFinite(back.data.targetHp));
  clearInterval(d.beat); d.close();
  console.log('reflect ok', back.data.damage, 'monster hp', back.data.targetHp);

  // 4. Mages learn 闪电术 and 治愈术 at combat level 10.
  const b = await player('SB');
  b.chat('/prof mage'); b.chat('/level 9'); await sleep(300);
  st = await b.inv();
  assert(!st.params.professionSkills.some((s) => s.id === 'mage_lightning_bolt'));
  b.chat('/level 10'); await sleep(300);
  // A level reached by playing goes through the same path as a new login.
  b.close(); clearInterval(b.beat);
  const b2 = new TestClient(url); await b2.open(); await b2.wait(OP.CONNECT);
  b2.send(OP.LOGIN, { username: b.email, password: 'password123' }); await b2.wait(OP.LOGIN_SUCCESS);
  await sleep(400); b2.send(OP.ITEM_QUERY, {}); st = (await b2.wait(OP.ITEM_STATE)).data;
  const ids = st.params.professionSkills.map((s) => s.id);
  assert(ids.includes('mage_lightning_bolt') && ids.includes('mage_heal'), 'mage skills ' + ids.join());
  b2.close();
  console.log('mage skills ok', ids.join(','));

  // 5. Admin job change picks a model that fits the gender.
  const w = await player('SW', 'women');
  w.chat('/level 20'); await sleep(200);
  let r = await api('character/' + w.id, { profession: 'mage' });
  assert.strictEqual(r.character.appearance.model, 'magic', 'women mage model');
  r = await api('character/' + w.id, { profession: 'gunner' });
  const wm = (await api('character/' + w.id)).appearance.model;
  assert(['girl_high', 'girl_fat', 'lady', 'girl_shot', 'new_visualize06', 'new_visualize07'].includes(wm), 'women gunner model ' + wm);
  clearInterval(w.beat); w.close();
  console.log('admin model ok', wm);

  // 6. Login notice: editable, empty turns it off.
  await api('settings', { values: { loginNotice: '测试公告123' } });
  const n = new TestClient(url); await n.open(); await n.wait(OP.CONNECT);
  n.send(OP.LOGIN, { username: a.email, password: 'password123' }); await n.wait(OP.LOGIN_SUCCESS);
  await n.wait(OP.CHAT_MESSAGE, (d) => JSON.stringify(d).includes('测试公告123'), 4000);
  n.close();
  await api('settings', { values: { loginNotice: '' } });
  console.log('login notice ok');

  // 7. Fusion with only the equipment repairs it.
  const c = await player('SC');
  c.chat('/level 30'); await c.go('smith');
  await c.give({ action: 'add', itemId: 1473, count: 1 });
  st = await c.inv();
  const shoe = st.inventory.slots.findIndex((x) => x && x.itemId === 1473);
  c.send(OP.SMITH_FUSION_OPEN, { interaction: 'smith_bunk' }); let fu = (await c.wait(OP.SMITH_FUSION_STATE)).data;
  c.send(OP.SMITH_FUSION_SELECT, { sessionId: fu.sessionId, slot: 'equipment', inventoryIndex: shoe }); fu = (await c.wait(OP.SMITH_FUSION_STATE)).data;
  c.send(OP.SMITH_FUSION_SELECT, { sessionId: fu.sessionId, slot: 'attribute', inventoryIndex: -1 });
  c.chat('/item 1704 1'); st = await c.inv();
  fu = (await c.wait(OP.SMITH_FUSION_STATE, () => true, 2000).catch(() => ({ data: fu }))).data;
  c.send(OP.SMITH_FUSION_HEAT, { sessionId: fu.sessionId }); fu = (await c.wait(OP.SMITH_FUSION_STATE)).data;
  await sleep((750 - fu.temperature) / fu.temperatureRate * 1000);
  c.send(OP.SMITH_FUSION_FINISH, { sessionId: fu.sessionId });
  const fr = (await c.wait(OP.SMITH_FUSION_RESULT, () => true, 4000)).data;
  assert.strictEqual(fr.repair, true, 'a repair result');
  console.log('repair ok', fr.success, fr.message);
  // 高纯钻石 goes into the attribute slot.
  st = await c.inv(); c.drain();
  c.send(OP.SMITH_FUSION_OPEN, { interaction: 'smith_bunk' }); fu = (await c.wait(OP.SMITH_FUSION_STATE)).data;
  const di = st.inventory.slots.findIndex((x) => x && x.itemId === 1704);
  c.drain();
  // A level-1 craftsman may not even place it (高纯 needs fusion level 90).
  c.send(OP.SMITH_FUSION_SELECT, { sessionId: fu.sessionId, slot: 'attribute', inventoryIndex: di });
  const low = (await c.wait(OP.SMITH_FUSION_ERROR, () => true, 3000)).data;
  assert(/需要 90 级/.test(low.message), 'refused below the level: ' + JSON.stringify(low));
  console.log('fusion level gate ok', low.message);
  c.chat('/craft fusion 90'); await sleep(300); c.drain();
  c.send(OP.SMITH_FUSION_SELECT, { sessionId: fu.sessionId, slot: 'attribute', inventoryIndex: di });
  const fe = await Promise.race([c.wait(OP.SMITH_FUSION_STATE, (x) => x.slots && x.slots.attribute, 3000), c.wait(OP.SMITH_FUSION_ERROR, () => true, 3000)]).catch((e) => ({ data: { error: String(e) } }));
  fu = fe.data;
  assert(fu.slots && fu.slots.attribute && fu.slots.attribute.item.itemId === 1704, '高纯钻石 in the attribute slot ' + di + ' ' + JSON.stringify(fu).slice(0, 300));
  clearInterval(c.beat); c.close();
  console.log('diamond slot ok');

  // 8. 狐仙: learned skills and level drops.
  const FOX = require('../src/game/foxfairy');
  for (let t = 1; t <= 4; t += 1) {
    const sk = FOX.pickSkills(t);
    assert(sk.length >= 1 && sk.length <= 2 && (t === 1 ? sk.length === 1 : true) && (t >= 3 ? sk.length === 2 : true));
    const d = FOX.foxDrops(t, t < 4 ? 1 : null);
    assert(d[0].oneOf.every((id) => FOX.GEMS[t - 1].includes(id)) && d[2].oneOf.every((id) => FOX.SEALS[t - 1].includes(id)));
  }
  const f = await player('SF');
  f.chat('/level 200'); f.chat('/heal');
  const ms = await f.go('hunt_p_01');
  const meF = (ms.players || []).find((p) => p.playerId === f.id);
  f.chat('/item 900002 100');
  st = await f.inv();
  const fur = st.inventory.slots.findIndex((x) => x && x.itemId === 900002);
  f.drain();
  f.send(OP.ITEM_USE, { fromIndex: fur, index: fur, summonRequestId: 'r6' });
  const delta = (await f.wait(OP.ITEM_DELTA, (x) => x.summonResult, 3000)).data;
  assert(/习得了/.test(delta.dropMessage), delta.dropMessage);
  const foxId = delta.summonResult.enemyId;
  const role = await f.wait(OP.MOVE_UPDATE, (x) => (x.enemies || []).some((e) => e.enemyId === foxId && e.role), 3000);
  const fox0 = role.data.enemies.find((e) => e.enemyId === foxId);
  await f.go('hunt_p_01', fox0.x - 250, fox0.y);
  f.drain();
  const kinds = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && kinds.size < 3) {
    const mu = await f.wait(OP.MOVE_UPDATE, (x) => (x.enemies || []).some((e) => e.enemyId === foxId && e.attackSequence > 0), 30000).catch(() => null);
    if (!mu) break;
    const oc = mu.data.enemies.find((e) => e.enemyId === foxId).originalCombat || {};
    kinds.add(oc.projectileKey || oc.specialMotion || 'bite');
  }
  console.log('fox', delta.dropMessage, 'attacks seen', Array.from(kinds).join(','), meF && meF.x);
  assert(Array.from(kinds).some((k) => !['huoqiu', 'dash_to_target', 'bite'].includes(k)), 'the fox uses a learned skill');
  clearInterval(f.beat); f.close();

  clearInterval(a.beat); a.close();
  console.log('FIXES6 OK'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
