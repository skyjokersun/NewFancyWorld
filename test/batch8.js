'use strict';
// Protocol test for the eighth batch: original attack formulas, mounts, 战神 rental,
// regen, 追魂箭 / 飞蝗, fox summon in towns, arena rooms and target dummies.
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
const EXT = { ACTION: 7100, STATE: 7110 };
const ext = (c, kind, d = {}) => c.send(EXT.ACTION, Object.assign({ kind }, d));
const extWait = (c, kind, pred = () => true, ms = 4000) => c.wait(EXT.STATE, (d) => d.kind === kind && pred(d), ms);

(async () => {
  await api('settings/reset', {});
  const a = await player('BA');

  // 1. Gunner: locked 8/10/3/10/3 and the original formula, mechanics adds 2% a point.
  a.chat('/level 80'); a.chat('/prof gunner'); a.chat('/plevel 50');
  let st = await a.inv();
  const core = st.params.combat.coreAttrs;
  assert.deepStrictEqual([core.strength, core.agility, core.perception, core.intelligence, core.luck], [8, 10, 3, 10, 3], JSON.stringify(core));
  const bare = 50 * (10 * 10 * 0.1 + 10);
  assert.strictEqual(st.params.combat.attack, bare, 'gunner attack ' + st.params.combat.attack);
  assert.strictEqual(st.params.combat.breakPower, bare, 'gunner break ' + st.params.combat.breakPower);
  console.log('gunner formula ok', st.params.combat.attack, st.params.combat.breakPower);

  // 2. Mounts: none owned at first; capsule 2600 gives an hour of cloud.
  ext(a, 'mount_query');
  let ms = (await extWait(a, 'mounts')).data;
  assert(!ms.cloud.owned && !ms.carpet.owned && !ms.riding, JSON.stringify(ms));
  ext(a, 'mount', { mount: 'cloud' });
  assert(!(await extWait(a, 'mounts')).data.riding);
  await a.give({ action: 'add', itemId: 2600, count: 1 });
  st = await a.inv();
  a.drain(); a.send(OP.ITEM_USE, { fromIndex: st.inventory.slots.findIndex((x) => x && x.itemId === 2600) });
  ms = (await extWait(a, 'mounts', (d) => d.cloud.owned)).data;
  assert(ms.cloud.expiresAt - Date.now() > 3500e3, 'capsule hour');
  const before = (await a.inv()).params;
  ext(a, 'mount', { mount: 'cloud' });
  ms = (await extWait(a, 'mounts', (d) => d.riding === 'cloud')).data;
  const after = (await a.inv()).params;
  assert.strictEqual(after.combat.attack, Math.round(before.combat.attack * 1.05), 'cloud attack ' + before.combat.attack + ' -> ' + after.combat.attack);
  assert.strictEqual(after.combat.moveSpeed || after.moveSpeed, (before.combat.moveSpeed || before.moveSpeed) + 20, 'cloud speed');
  console.log('cloud ok', before.combat.attack, '->', after.combat.attack);
  ext(a, 'mount', { mount: 'carpet' });
  ms = (await extWait(a, 'mounts')).data; assert.strictEqual(ms.riding, 'cloud', 'carpet not owned');
  ext(a, 'mount', { mount: 'off' });
  ms = (await extWait(a, 'mounts', (d) => !d.riding)).data;
  assert.strictEqual((await a.inv()).params.combat.attack, before.combat.attack);
  console.log('dismount ok');

  // 3. 战神 statue rental: 50 points for 15 days, only in 战斗行会.
  await a.go('job_fight');
  ext(a, 'zhanshen_rent');
  const rr = (await extWait(a, 'zhanshen_result')).data;
  assert(rr.success, JSON.stringify(rr));
  ms = (await extWait(a, 'mounts')).data;
  assert(ms.cloud.expiresAt - Date.now() > 15 * 864e5, 'rent adds to the hour left');
  console.log('zhanshen ok', rr.message);

  // 4. 追魂箭: book 304 sold in the general store for 100000, archer level 60.
  const b = await player('BB');
  b.chat('/level 80'); b.chat('/prof archer'); b.chat('/plevel 60');
  await b.give({ action: 'add', itemId: 304, count: 1 });
  st = await b.inv();
  b.drain(); b.send(OP.ITEM_USE, { fromIndex: st.inventory.slots.findIndex((x) => x && x.itemId === 304) });
  await sleep(400);
  st = await b.inv();
  const zh = st.params.professionSkills.find((x) => x.id === 'hunter_zhuihun');
  assert(zh && zh.range === 550 && zh.aoeRadius === 120, JSON.stringify(zh));
  const { m, me } = await nearMonster(b, 300);
  // Aim 100 px beside the monster: the arrow still finds it.
  b.drain();
  b.send(OP.ACTION, { action: { type: 'attack', attackPhase: 'fire', skillId: 'hunter_zhuihun', x: me.x, y: me.y, aimX: m.x, aimY: m.y - 100, seq: ++seq, timestamp: Date.now(), attackType: 'first_hit_projectile' } });
  const hitR = (await b.wait(OP.ATTACK_RESULT, (d) => d.attackerId === b.id, 4000)).data;
  assert(hitR.damage > 0, 'zhuihun hits');
  console.log('zhuihun ok', hitR.damage);
  // Far from any monster: no hit.
  await sleep(1300);
  b.drain();
  b.send(OP.ACTION, { action: { type: 'attack', attackPhase: 'fire', skillId: 'hunter_zhuihun', x: me.x, y: me.y, aimX: me.x - 500, aimY: me.y, seq: ++seq, timestamp: Date.now(), attackType: 'first_hit_projectile' } });
  const miss = await b.wait(OP.ATTACK_RESULT, (d) => d.attackerId === b.id, 1500).catch(() => null);
  assert(!miss || miss.data.targetId !== m.enemyId || Math.hypot(m.x - (me.x - 500), m.y - me.y) < 170, 'zhuihun miss');
  console.log('zhuihun miss ok');
  // Shop: the general store lists 304 at 100000.
  const shops = await api('shops');
  const tools = shops.merchants ? shops.merchants.find((x) => x.kind === 'tools') : null;
  if (tools) { const d = await api('shop/' + encodeURIComponent(tools.id)); assert((d.items || []).some((x) => (x.itemId || x) === 304), 'store sells 304'); }
  console.log('book shop ok');

  // 5. No fox summons in towns.
  await b.go('square_in');
  b.chat('/item 2586 100');
  st = await b.inv();
  const fur = st.inventory.slots.findIndex((x) => x && x.itemId === 2586);
  b.drain(); b.send(OP.ITEM_USE, { fromIndex: fur, index: fur, summonRequestId: 'r1' });
  const fe = (await b.wait(OP.ITEM_OP_ERROR)).data;
  assert(/城镇/.test(fe.message), JSON.stringify(fe)); console.log('fox town ok', fe.message);

  // 6. Arena rooms: separate copies, inclusive level edges, target dummies.
  const c = await player('BC');
  c.chat('/level 50');
  await c.go('abattoir');
  const sw = async (ref) => { c.drain(); c.send(OP.MAP_SWITCH, { mapRef: ref, clientSeq: ++seq }); return (await c.wait(OP.MAP_SWITCH_RESULT, () => true, 6000)).data; };
  let r6 = await sw('pk_a6'); assert(!r6.success, 'level 50 not in 6室');
  let r3 = await sw('pk_a3'); assert(r3.success, 'level 50 in 3室 ' + r3.message);
  await c.go('abattoir');
  let r4 = await sw('pk_a4'); assert(r4.success, 'level 50 in 4室 ' + r4.message);
  console.log('arena level edges ok', r4.mapRef);
  ext(c, 'arena_rent', { target: 'strong' });
  let ar = (await extWait(c, 'arena', (d) => d.target === 'strong')).data;
  const mv = (await c.wait(OP.MOVE_UPDATE, (d) => (d.enemies || []).some((e) => e.name === '强壮靶子'), 3000)).data;
  const dummy = mv.enemies.find((e) => e.name === '强壮靶子');
  assert.strictEqual(dummy.maxHp, 5000000);
  const meC = (await c.go('abattoir_pka', dummy.x - 80, dummy.y)).players.find((x) => x.playerId === c.id);
  void meC; void ar;
  console.log('strong target ok', dummy.role);
  ext(c, 'arena_rent', { target: 'fragile' });
  await sleep(300);
  ext(c, 'arena_return');
  await extWait(c, 'arena', (d) => !d.target);
  await sleep(300); c.drain();
  ext(c, 'arena_rent', { target: 'fragile' });
  await extWait(c, 'arena', (d) => d.target === 'fragile');
  const mv2 = (await c.wait(OP.MOVE_UPDATE, (d) => (d.enemies || []).filter((e) => e.name === '脆弱靶子').length >= 3, 3000)).data;
  const frag = mv2.enemies.filter((e) => e.name === '脆弱靶子');
  console.log('fragile targets ok', frag.length, frag.map((e) => e.role).join(' '));
  const f0 = frag[0];
  const atF = (await c.go('abattoir_pka', f0.x - 60, f0.y)).players.find((x) => x.playerId === c.id);
  const exp0 = (await c.inv()).params.progression.combatExp;
  c.drain(); attack(c, atF, f0);
  const gone = (await c.wait(OP.MOVE_UPDATE, (d) => (d.removedEnemyIds || []).includes(f0.enemyId), 3000).catch((e) => { console.log('LOG', JSON.stringify(c.log.slice(-15).map((q) => [q.name, q.data && (q.data.removedEnemyIds || q.data.message || q.data.attackerId)]))); throw e; })).data;
  void gone; console.log('fragile broken');
  const back = (await c.wait(OP.MOVE_UPDATE, (d) => (d.enemies || []).some((e) => e.name === '脆弱靶子' && e.enemyId !== f0.enemyId && Math.hypot(e.x - f0.x, e.y - f0.y) < 5), 3000)).data;
  void back;
  assert.strictEqual((await c.inv()).params.progression.combatExp, exp0, 'no exp from targets');
  console.log('fragile break + respawn ok');
  // 7. Auto hunt: allowed on hunting maps and arena rooms, not in towns; a full bag stops it.
  ext(c, 'autohunt', { on: true });
  let ah = (await extWait(c, 'autohunt')).data; assert(ah.on && ah.allowed, JSON.stringify(ah));
  await c.go('square_in');
  ah = (await extWait(c, 'autohunt', (d) => !d.allowed)).data; assert(!ah.on);
  await c.go('hunt_p_01');
  ext(c, 'autohunt', { on: true });
  await extWait(c, 'autohunt', (d) => d.on);

  st = await c.inv();
  const free = st.inventory.slots.filter((x) => !x).length;
  for (let i = 0; i < free; i += 1) c.chat('/item 577');
  await sleep(1500); st = await c.inv(); console.log('free now', st.inventory.slots.filter((x) => !x).length, st.inventory.slots.length, free);
  const stopped = (await extWait(c, 'autohunt', (d) => !d.on && d.reason, 5000)).data;
  assert(/背包已满/.test(stopped.reason), JSON.stringify(stopped));
  console.log('autohunt ok', stopped.reason);
  a.close(); b.close(); c.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
