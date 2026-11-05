'use strict';
// Protocol test: cross-world scenes and online detection (heartbeat timeout,
// single session per character, /api/online summary).
// Run the server with QIYU_HEARTBEAT_TIMEOUT_MS=3000 for the timeout part.
const assert = require('assert');
const http = require('http');
const { TestClient, OP } = require('./client');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
const httpBase = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));

async function newChar(tag, world) {
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  const email = tag + Date.now() + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' });
  await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123', serverId: world }); await c.wait(OP.LOGIN_SUCCESS);
  c.send(OP.CHARACTER_CREATE, { nickname: tag.toUpperCase() + String(Date.now()).slice(-6), appearance: { gender: 'man' } });
  await c.wait(OP.CHARACTER_CREATE_RESULT); const login = (await c.wait(OP.LOGIN_SUCCESS)).data;
  c.me = login.playerId; c.email = email;
  c.chat = (m) => c.send(OP.CHAT, { channel: 'world', message: m });
  c.beat = setInterval(() => c.send(OP.HEARTBEAT, { seq: 1, clientTime: Date.now() }), 1000);
  return c;
}

(async () => {
  const a = await newChar('xa', 'green');
  const b = await newChar('xb', 'west');
  // Normal scenes stay per world.
  a.chat('/go hunt_p_01'); await a.wait(OP.MAP_SWITCH_RESULT);
  b.chat('/go hunt_p_01'); const bh = (await b.wait(OP.MAP_SWITCH_RESULT)).data;
  const seesA = bh.players.some((p) => p.playerId === a.me);
  console.log('hunt_p_01 shared across worlds?', seesA); assert(!seesA);
  // PK arena is a cross-world scene.
  a.chat('/go pk_sj_r01'); await a.wait(OP.MAP_SWITCH_RESULT);
  a.drain();
  b.chat('/go pk_sj_r01'); const bp = (await b.wait(OP.MAP_SWITCH_RESULT)).data;
  console.log('pk_sj_r01: west player sees green player:', bp.players.some((p) => p.playerId === a.me));
  assert(bp.players.some((p) => p.playerId === a.me));
  const join = await a.wait(OP.PLAYER_JOIN, (d) => (d.player || d).playerId === b.me, 3000).catch(() => null);
  console.log('green player got PLAYER_JOIN for west player:', !!join); assert(join);
  const note = await b.wait(OP.CHAT_MESSAGE, (d) => /跨服/.test(d.message || d.text || ''), 2000).catch(() => null);
  console.log('cross notice:', note && (note.data.message || note.data.text));
  console.log('occupancy (west sees):', JSON.stringify(bp.sceneOccupancies));
  assert(bp.sceneOccupancies.some((o) => o.mapRef === 'pk_sj_r01' && o.playerCount === 2));
  let online = await getJson(httpBase + '/api/online');
  console.log('/api/online', online.online, 'online;', online.players.filter((p) => p.crossScene).map((p) => p.name + '@' + p.world).join(' '));

  // Single session per character: a second login replaces the first.
  const rejoin = b.wait(OP.PLAYER_JOIN, (d) => (d.player || d).playerId === a.me, 5000);
  const a2 = new TestClient(url); await a2.open(); await a2.wait(OP.CONNECT);
  a2.send(OP.LOGIN, { username: a.email, password: 'password123' }); const re = (await a2.wait(OP.LOGIN_SUCCESS)).data;
  console.log('relogin same character id:', re.playerId === a.me, 'map', re.mapRef);
  const kicked = await a.wait(OP.CHAT_MESSAGE, (d) => /其他地方登录/.test(d.message || d.text || ''), 2000).catch(() => null);
  console.log('old session told:', !!kicked); assert(kicked);
  clearInterval(a.beat);
  await rejoin; b.drain();

  // Online detection: a silent connection is dropped and others see it leave.
  const leave = b.wait(OP.PLAYER_LEAVE, (d) => (d.playerId || (d.player && d.player.playerId)) === a.me, 15000).then(() => true).catch(() => false);
  console.log('a2 goes silent (no heartbeats)...');
  const t0 = Date.now();
  const left = await leave;
  console.log('west player saw green player leave after', Math.round((Date.now() - t0) / 1000), 's:', left); assert(left);
  online = await getJson(httpBase + '/api/online');
  console.log('/api/online after timeout', online.online, 'online');
  clearInterval(b.beat); b.close();
  console.log('ONLINE OK'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
