'use strict';
// Protocol test for the combat level lock: /lock freezes combat level while
// profession level keeps rising; /levelup raises it by hand.
const assert = require('assert');
const { TestClient, OP } = require('./client');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  const email = 'lock' + Date.now() + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' });
  await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123' }); await c.wait(OP.LOGIN_SUCCESS);
  c.send(OP.CHARACTER_CREATE, { nickname: 'LK' + String(Date.now()).slice(-6), appearance: { gender: 'man' } });
  await c.wait(OP.CHARACTER_CREATE_RESULT); await c.wait(OP.LOGIN_SUCCESS);
  const chat = (m) => c.send(OP.CHAT, { channel: 'world', message: m });
  const params = async () => { c.send(OP.ITEM_QUERY, {}); return (await c.wait(OP.ITEM_STATE)).data.params; };
  const lv = (p) => [p.progression.combatLevel, p.progression.professionLevel];
  let p = await params(); console.log('start', lv(p));
  const [c0, p0] = lv(p);
  chat('/lock'); await sleep(200);
  chat('/exp 20000'); await sleep(400);
  p = await params(); console.log('locked + exp', lv(p));
  assert.strictEqual(lv(p)[0], c0, 'combat level frozen');
  assert(lv(p)[1] > p0, 'profession still levels');
  c.queue.length = 0;
  chat('/levelup');
  // The new level is pushed at once, so the panel and the bottom box update without a query.
  const pushed = await c.wait(OP.ITEM_DELTA, (d) => (d.changes || []).some((x) => x.type === 'set_params' && x.params.progression.combatLevel === c0 + 1));
  assert(pushed, 'levelup pushes params');
  p = await params(); console.log('levelup', lv(p), 'in level', p.progression.combatExpInLevel + '/' + p.progression.nextCombatLevelExp, 'locked', p.progression.combatLevelLocked);
  assert.strictEqual(lv(p)[0], c0 + 1);
  assert.strictEqual(p.progression.combatLevelLocked, true);
  assert(p.progression.combatExpInLevel > p.progression.nextCombatLevelExp, 'locked EXP passes the requirement');
  chat('/lock'); await sleep(300);
  p = await params(); console.log('unlocked', lv(p));
  assert(lv(p)[0] > c0 + 1, 'unlock applies gained levels');
  console.log('levellock ok'); c.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
