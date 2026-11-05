'use strict';
// Protocol test for snooker tables: practice and computer modes.
const assert = require('assert');
const { TestClient, OP } = require('./client');
const { MapRegistry } = require('../src/game/map');
const cfg = require('../src/config');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  const email = 'sn' + Date.now() + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' });
  await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123' }); const me = (await c.wait(OP.LOGIN_SUCCESS)).data;
  c.send(OP.CHARACTER_CREATE, { nickname: 'S' + String(Date.now()).slice(-6), appearance: { gender: 'man' } });
  await c.wait(OP.CHARACTER_CREATE_RESULT); const login = (await c.wait(OP.LOGIN_SUCCESS)).data; void me;
  const chat = (m) => c.send(OP.CHAT, { channel: 'world', message: m });
  const desk = new MapRegistry(cfg.dataDir).rawDoc('team_room').decor.find((d) => /btable_r/.test(d.path));
  const req = async (op, data) => { c.drain(); c.send(op, data); const m = await c.waitAny([OP.SNOOKER_STATE, OP.SNOOKER_ERROR], 5000); return { ok: m.opCode === OP.SNOOKER_STATE, d: m.data }; };
  const settle = async () => (await c.wait(OP.SNOOKER_STATE, (d) => d.phase !== 'moving', 30000)).data;

  chat('/go team_room'); await c.wait(OP.MAP_SWITCH_RESULT);
  let r = await req(OP.SNOOKER_JOIN, { tableNo: '1', mode: 'practice', clientSeq: 1 }); console.log('far join:', r.ok, r.d.message); assert(!r.ok);
  chat('/go team_room ' + desk.x + ' ' + (-desk.y - 40)); await c.wait(OP.MAP_SWITCH_RESULT);
  r = await req(OP.SNOOKER_JOIN, { tableNo: '9', mode: 'practice', clientSeq: 2 }); console.log('bad table:', r.ok, r.d.message); assert(!r.ok);
  r = await req(OP.SNOOKER_JOIN, { tableNo: '1', mode: 'practice', clientSeq: 3 });
  if (!r.d.balls) console.log('RAW', JSON.stringify(r.d));
  console.log('practice join', r.ok, r.d.phase, 'balls', r.d.balls.length, 'target', r.d.target, 'turn', r.d.turnPlayerId, r.d.message); assert(r.ok);
  const room = r.d.roomId; const myId = r.d.turnPlayerId; void login;
  r = await req(OP.SNOOKER_SHOOT, { roomId: room, aimX: 1, aimY: 0.02, power: 1, spinX: 0, spinY: 0, clientSeq: 4 });
  console.log('shot', r.ok, r.d.phase, 'duration', r.d.playback && r.d.playback.durationMs, 'events', r.d.events.map((e) => e.type).join(','));
  assert.strictEqual(r.d.phase, 'moving');
  const r2 = await req(OP.SNOOKER_SHOOT, { roomId: room, aimX: 1, aimY: 0, power: 0.5 }); console.log('shoot while moving:', r2.ok, r2.d.message); assert(!r2.ok);
  let st = await settle(); console.log('after break', st.phase, 'target', st.target, 'score', st.players[0].score, 'break', st.breakScore, '|', st.message);
  // Pot a red into the nearest pocket by aiming at a ghost ball.
  const cue = st.balls.find((b) => b.id === 'cue');
  r = await req(OP.SNOOKER_RESET, { roomId: room }); console.log('reset', r.ok, r.d.message, r.d.events.map((e) => e.type).join(','));
  // computer mode
  r = await req(OP.SNOOKER_JOIN, { tableNo: '1', mode: 'computer', clientSeq: 5 }); console.log('computer join', r.ok, r.d.players.map((p) => p.playerName).join(' vs ')); assert(r.ok);
  const room2 = r.d.roomId;
  r = await req(OP.SNOOKER_SHOOT, { roomId: room2, aimX: 0.995, aimY: 0.1, power: 0.9 }); assert(r.ok);
  st = await settle(); console.log('after my break', st.turnPlayerId, st.message, 'computerAim', !!st.computerAim);
  let computerShots = 0;
  for (let i = 0; i < 12 && st.phase !== 'finished'; i += 1) {
    if (st.turnPlayerId === myId) {
      const me2 = st.balls.find((b) => b.id === 'cue'); const t = st.balls.find((b) => !b.potted && (st.target === 'red' ? b.kind === 'red' : st.target === 'color' ? b.kind !== 'red' && b.kind !== 'cue' : b.kind === st.target));
      const dx = t.x - me2.x; const dy = t.y - me2.y; const l = Math.hypot(dx, dy);
      c.send(OP.SNOOKER_SHOOT, { roomId: room2, aimX: dx / l, aimY: dy / l, power: 0.5, spinX: 0, spinY: 0 });
      await c.wait(OP.SNOOKER_STATE, (d) => d.phase === 'moving', 5000);
    } else {
      assert(st.computerAim, 'computer aiming');
      await c.wait(OP.SNOOKER_STATE, (d) => d.phase === 'moving', 5000); computerShots += 1;
    }
    st = await settle();
    console.log('  turn', st.turnPlayerId === myId ? 'me' : st.turnPlayerId, 'target', st.target, 'scores', st.players.map((p) => p.score).join(':'), '|', st.message);
  }
  assert(computerShots > 0, 'computer played');
  void cue;
  c.send(OP.SNOOKER_LEAVE, { roomId: room2 }); await sleep(200);
  r = await req(OP.SNOOKER_SHOOT, { roomId: room2, aimX: 1, aimY: 0, power: 0.5 }); console.log('after leave:', r.ok, r.d.message); assert(!r.ok);
  console.log('SNOOKER OK'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
