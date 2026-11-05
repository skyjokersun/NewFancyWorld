'use strict';
// Protocol test for the server settings on /admin: live changes, monster count,
// new-character gold, export/import, reset to defaults and the announcement.
const assert = require('assert');
const { TestClient, OP } = require('./client');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
const http = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
const api = async (path, body) => {
  const r = await fetch(http + '/admin/api/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status }); return j;
};
const value = (view, key) => { for (const g of view.groups) for (const it of g.items) if (it.key === key) return it; return null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPlayer() {
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  const email = 'set' + Date.now() + Math.floor(Math.random() * 1000) + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' }); await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123' }); await c.wait(OP.LOGIN_SUCCESS);
  c.send(OP.CHARACTER_CREATE, { nickname: 'ST' + String(Date.now()).slice(-6), appearance: { gender: 'man' } });
  await c.wait(OP.CHARACTER_CREATE_RESULT); await c.wait(OP.LOGIN_SUCCESS);
  c.send(OP.ITEM_QUERY, {}); c.gold = (await c.wait(OP.ITEM_STATE)).data.params.profile.gold;
  return c;
}
async function enemiesOn(c, mapRef) {
  c.drain();
  c.send(OP.MAP_SWITCH, { mapRef: 'square_in', clientSeq: 1 }); await c.wait(OP.MAP_SWITCH_RESULT);
  c.send(OP.MAP_SWITCH, { mapRef, clientSeq: 2 });
  return (await c.wait(OP.MAP_SWITCH_RESULT)).data.enemies || [];
}

(async () => {
  let view = await api('settings');
  console.log('groups', view.groups.map((g) => g.title + ':' + g.items.length).join(' '));
  if (process.argv[3] === 'persist') {
    // Second run after a restart: the values saved by the first run must still be there.
    assert.strictEqual(value(view, 'dropRate').value, 7); assert.strictEqual(value(view, 'startGold').value, 777);
    console.log('persisted after restart: dropRate', value(view, 'dropRate').value, 'startGold', value(view, 'startGold').value);
    const r = await api('settings/reset', {});
    console.log('reset', r.done.join('、'));
    assert(!value(r.settings, 'dropRate').changed);
    process.exit(0);
  }
  const before = await api('settings/reset', {}); view = before.settings;
  const def = Object.fromEntries(view.groups.flatMap((g) => g.items.map((it) => [it.key, it.default])));

  const c = await newPlayer();
  assert.strictEqual(c.gold, def.startGold); console.log('new character gold (default)', c.gold);
  c.beat = setInterval(() => c.send(OP.HEARTBEAT, { clientTime: Date.now(), seq: 1 }), 2000);

  // Validation: out of range and unknown keys are refused and nothing is applied.
  await assert.rejects(api('settings', { values: { dropRate: -1 } }), /之间/);
  await assert.rejects(api('settings', { values: { startGold: 5, nope: 1 } }), /未知/);
  assert.strictEqual(value(await api('settings'), 'startGold').value, def.startGold);

  // Monster count: double it on hunt_p_01, the map fills up without waiting for kills.
  const base = (await enemiesOn(c, 'hunt_p_01')).length;
  let r = await api('settings', { values: { monsterCountRate: 2, monsterHpRate: 3 } });
  console.log('set', r.done.join('、'));
  await sleep(300);
  const doubled = await enemiesOn(c, 'hunt_p_01');
  console.log('hunt_p_01 monsters', base, '->', doubled.length);
  assert(doubled.length >= base * 2 - 2 && doubled.length > base, 'monsters doubled');
  const hps = doubled.map((e) => e.maxHp || (e.stats && e.stats.maxHp)).filter(Boolean);
  console.log('max hp seen', Math.min(...hps), '..', Math.max(...hps));
  r = await api('settings', { values: { monsterCountRate: 0.5 } });
  await sleep(300);
  console.log('after 0.5 (live extras stay until killed):', (await enemiesOn(c, 'hunt_p_01')).length);

  // New character gold, drop rate, server name.
  r = await api('settings', { values: { startGold: 777, dropRate: 7, heartbeatTimeoutMs: 45, serverName: '测试服' } });
  console.log('set', r.done.join('、'));
  assert.strictEqual(value(r.settings, 'heartbeatTimeoutMs').value, 45);
  const c2 = await newPlayer(); console.log('new character gold', c2.gold); assert.strictEqual(c2.gold, 777); c2.close();

  // Export, reset, import back.
  const ex = await (await fetch(http + '/admin/api/settings/export')).json();
  assert.strictEqual(ex.format, 'qiyu-server-settings'); assert.strictEqual(ex.values.dropRate, 7); assert.strictEqual(ex.values.heartbeatTimeoutMs, 45);
  r = await api('settings/reset', {}); console.log('reset', r.done.join('、'));
  assert.strictEqual(value(r.settings, 'dropRate').value, def.dropRate); assert.strictEqual(value(r.settings, 'serverName').value, def.serverName);
  ex.values.someFutureKey = 1;
  r = await api('settings/import', ex); console.log('import', r.done.join('、'), 'skipped', r.skipped);
  assert.strictEqual(value(r.settings, 'dropRate').value, 7); assert.strictEqual(value(r.settings, 'monsterHpRate').value, 3);
  assert.deepStrictEqual(r.skipped, ['someFutureKey']);
  await assert.rejects(api('settings/import', { hello: 1 }), /values/);

  // Announcement reaches the online player.
  c.drain();
  r = await api('announce', { text: '测试公告' }); console.log(r.done[0]);
  const chat = await c.wait(OP.CHAT_MESSAGE, (d) => JSON.stringify(d).includes('测试公告'));
  console.log('player got', JSON.stringify(chat.data).slice(0, 160));
  clearInterval(c.beat); c.close();
  console.log('OK (left dropRate=7, startGold=777 saved for the restart check)');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
