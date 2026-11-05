'use strict';
// Protocol test: every way of gaining combat levels pays 1 skill point per level,
// including levelling up again after a GM lowered the level. Luck makes it 1 to 3
// points a level, so each step checks the points gained against that range.
const assert = require('assert');
const { TestClient, OP } = require('./client');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
const http = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  const email = 'sp' + Date.now() + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' }); await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123' }); await c.wait(OP.LOGIN_SUCCESS);
  c.send(OP.CHARACTER_CREATE, { nickname: 'SP' + String(Date.now()).slice(-6), appearance: { gender: 'man' } });
  await c.wait(OP.CHARACTER_CREATE_RESULT); const me = (await c.wait(OP.LOGIN_SUCCESS)).data.playerId;
  const chat = (m) => c.send(OP.CHAT, { channel: 'world', message: m });
  const prog = async () => { await sleep(300); c.send(OP.ITEM_QUERY, {}); const p = (await c.wait(OP.ITEM_STATE)).data.params.progression; return [p.combatLevel, p.skillPoints]; };
  const admin = async (body) => (await (await fetch(http + '/admin/api/character/' + me, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json());

  let last = 0; let paidLevels = 0;
  // points gained since the last check: `levels` new levels pay 1 to 3 each
  const gained = (s, levels) => {
    const d = s[1] - last; last = s[1]; paidLevels += levels;
    assert(d >= levels * 2 && d <= levels * 3, levels + ' levels paid ' + d + ' points');
  };
  let s = await prog(); console.log('start', s); assert.deepStrictEqual(s, [1, 0]);
  chat('/exp 3000'); s = await prog(); console.log('exp', s); gained(s, s[0] - 1);
  let lv = s[0];
  chat('/level 15'); s = await prog(); console.log('/level 15', s); assert.strictEqual(s[0], 15); gained(s, 15 - lv);
  chat('/lock'); chat('/exp 100000'); s = await prog(); assert.strictEqual(s[0], 15); assert.strictEqual(s[1], last);
  chat('/levelup'); s = await prog(); console.log('/levelup', s); assert.strictEqual(s[0], 16); gained(s, 1);
  chat('/lock'); s = await prog(); console.log('unlock', s); gained(s, s[0] - 16); lv = s[0];
  let r = await admin({ combatLevel: 80 }); console.log('admin 80', r.done.join(' | ')); s = await prog(); assert.strictEqual(s[0], 80); gained(s, 80 - lv);
  // Lowering keeps the points; levelling up again pays as usual.
  await admin({ combatLevel: 70 }); s = await prog(); assert.deepStrictEqual(s, [70, last]);
  await admin({ combatLevel: 75 }); s = await prog(); console.log('down 70, up 75', s); gained(s, 5);
  chat('/level 10'); s = await prog(); assert.deepStrictEqual(s, [10, last]);
  chat('/exp 3000'); s = await prog(); console.log('/level 10 then hunt exp', s); assert(s[0] > 10); gained(s, s[0] - 10);
  console.log('levels paid', paidLevels, 'points', last, 'average', (last / paidLevels).toFixed(2));
  console.log('SKILLPOINTS OK'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
