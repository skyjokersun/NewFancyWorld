'use strict';
// Fifteenth batch: auto hunt with a warrior using 冲锋 plus an auto buff (罡气), and a
// mage with 治愈术 on. Counts skill packets, refused-charge notices and kills.
// node test/ui/hunt15.js [warrior|mage] [seconds] [ref]   (ref: run the V14.1 patch for comparison)
const { prepareAccount, openGame } = require('./session');
const prof = process.argv[2] || 'warrior';
const secs = Number(process.argv[3] || 60);
(async () => {
  const acct = await prepareAccount({ level: 150, profession: prof, world: 'west' });
  // Learn the skills over the protocol before the browser logs in.
  const { TestClient, OP } = require('../client');
  const c = new TestClient(require('./session').wsUrl); await c.open(); await c.wait(OP.CONNECT);
  c.send(OP.LOGIN, { username: acct.email, password: acct.password, serverId: 'west' }); await c.wait(OP.LOGIN_SUCCESS);
  const say = async (m) => { c.send(OP.CHAT, { channel: 'world', message: m }); await new Promise((r) => setTimeout(r, 250)); };
  await say('/plevel 100');
  const books = prof === 'warrior' ? [1801, 900102, 311] : [321, 324];
  for (const b of books) await say('/item ' + b + ' 1');
  for (const b of books) {
    c.send(OP.ITEM_QUERY, {}); const st = (await c.wait(OP.ITEM_STATE)).data;
    const i = st.inventory.slots.findIndex((x) => x && x.itemId === b);
    if (i >= 0) { c.send(OP.ITEM_USE, { fromIndex: i }); await new Promise((r) => setTimeout(r, 300)); }
  }
  if (prof === 'warrior') {
    await say('/item 795 1');
    c.send(OP.ITEM_QUERY, {}); const st = (await c.wait(OP.ITEM_STATE)).data;
    const i = st.inventory.slots.findIndex((x) => x && x.itemId === 795);
    c.send(OP.ITEM_EQUIP, { fromIndex: i, slot: 'weapon' }); await new Promise((r) => setTimeout(r, 400));
  }
  c.close(); await new Promise((r) => setTimeout(r, 500));
  const g = await openGame(acct);
  await g.chat('/go dk1_01');
  console.log('scene ready', await g.waitScene());
  await g.wait(2000);
  const learned = await g.eval(() => (globalThis.gameEntry.localPlayerParams.professionSkills || []).map((s) => s.id));
  console.log('learned', learned.join(','));
  const api = await g.eval(() => !!globalThis.__QIYU_BATCH8_API__);
  const cfg = prof === 'warrior' ? { skill: 'warrior_charge', buffs: ['warrior_gangqi'], buffMpPct: 0, pick: 'none', potOn: false }
    : { skill: 'mage_ice_arrow', buffs: [], healOn: true, healPct: 90, pick: 'none', potOn: false };
  await g.eval((c) => {
    const ge = globalThis.gameEntry;
    const st = globalThis.__qiyu15 = { packets: {}, msgs: [], start: Date.now() };
    const orig = ge.sendProfessionSkillAttackPacket;
    ge.sendProfessionSkillAttackPacket = function (actor, id) { st.packets[id] = (st.packets[id] || 0) + 1; return orig.apply(this, arguments); };
    const show = ge.messageDropPanel && ge.messageDropPanel.show;
    if (show) ge.messageDropPanel.show = function (t) { st.msgs.push(String(t)); return show.apply(this, arguments); };
    st.exp0 = JSON.stringify(ge.localPlayerParams.progression);
    globalThis.__QIYU_BATCH8_API__.send('autohunt_cfg', { cfg: c });
  }, cfg);
  await g.wait(1000);
  await g.eval(() => globalThis.__QIYU_BATCH8_API__.setHunt(true));
  if (prof === 'mage') await g.chat('/hurt 50');
  await g.wait(3000);
  await g.shot('15-hunt-' + prof + '-a');
  const samples = [];
  for (let t = 0; t < secs; t += 10) {
    for (let k = 0; k < 4; k++) { await g.wait(2500); if (prof === 'warrior') await g.chat('/heal'); }
    const s = await g.eval(() => { const ge = globalThis.gameEntry; const st = globalThis.__qiyu15; const c = ge.localPlayerParams.combat;
      return { packets: st.packets, msgs: st.msgs.length, lastMsg: st.msgs.slice(-3), hp: c.hp + '/' + c.maxHp, sta: c.stamina + '/' + c.maxStamina, buffs: (c.activeBuffs || []).map((b) => b.id), on: globalThis.__QIYU_BATCH8_API__.state.autohunt.on, ah: JSON.stringify((globalThis.__QIYU_BATCH8_API__.state.autohunt.skills || []).filter((x) => /charge|ice/.test(x.id))), ai: { tinfo: (() => { const a = globalThis.__QIYU_BATCH8_API__.ai; const me = ge.actorStates.get(ge.localPlayerId); let o = null; try { { const e = ge.actorStates.get(a.target); if (e) o = { hp: e.currentHp, ex: Math.round(e.node.position.x), ey: Math.round(e.node.position.y) }; } } catch (e) { o = String(e); } return { o, me: me ? [Math.round(me.node.position.x), Math.round(me.node.position.y)] : null, keys: Object.keys(ge).filter((k) => /enemy/i.test(k)).slice(0, 12) }; })(), t: globalThis.__QIYU_BATCH8_API__.ai.target, cl: globalThis.__QIYU_BATCH8_API__.ai.closing, mute: globalThis.__QIYU_BATCH8_API__.ai.skillMuteUntil - Date.now() } }; });
    samples.push(s); console.log(t + 10 + 's', JSON.stringify(s));
  }
  await g.shot('15-hunt-' + prof + '-b');
  const end = await g.eval(() => ({ exp0: globalThis.__qiyu15.exp0, exp1: JSON.stringify(globalThis.gameEntry.localPlayerParams.progression) }));
  console.log('progression before', end.exp0); console.log('progression after ', end.exp1);
  g.dumpLogs('15-hunt-' + prof);
  await g.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
