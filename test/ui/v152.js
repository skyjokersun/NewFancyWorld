'use strict';
// V15.2: centre notice, original 狐仙 colours, 美杜沙 poison tint, notice filter.
// node test/ui/v152.js   (server on 8090, admin on 8091)
const fs = require('fs');
const { prepareAccount, openGame } = require('./session');
const ADMIN = 'http://localhost:' + (process.env.QIYU_ADMIN_PORT || 8091);
let cookie = '';
async function admin(path, body) {
  if (!cookie) {
    const pw = fs.readFileSync(__dirname + '/../../admin-password.txt', 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))[0].trim();
    const lg = await fetch(ADMIN + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
    cookie = lg.headers.get('set-cookie').split(';')[0];
  }
  const r = await fetch(ADMIN + '/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body || {}) });
  return r.json();
}
(async () => {
  const acct = await prepareAccount({ level: 200, profession: 'warrior', world: 'west' });
  const g = await openGame(acct, { width: 1280, height: 800 });
  await g.waitScene(); await g.wait(1000);
  await g.chat('/go hunt_p_02 0 0'); await g.waitScene(); await g.wait(2000);
  // Centre notice: an event starting.
  await admin('b152/manual', { key: 'midautumn', on: true }); await g.wait(1500);
  await g.shot('152-centre-notice');
  await admin('b152/manual', { key: 'midautumn', on: null });
  await g.page.mouse.click(640, 478); await g.wait(500);
  // Fox LV2 (CDCC) and 美杜沙.
  await g.chat('/item 2586 200'); await g.chat('/item 2584 80'); await g.chat('/item 2585 80'); await g.wait(800);
  await g.eval(() => globalThis.__QIYU_BATCH8_API__.send('medusa_summon'));
  await g.wait(12000);
  const med = await g.eval(() => { const ge = globalThis.gameEntry; for (const [id, a] of ge.actorStates) if (a.__lastSnapshot ? 0 : 0) return id; return [...ge.actorStates.keys()]; });
  console.log('actors', JSON.stringify(med).slice(0, 300));
  // Poison tint: wait for a status on me.
  let tinted = null;
  for (let i = 0; i < 40 && !tinted; i++) {
    await g.chat('/heal'); await g.wait(700);
    tinted = await g.eval(() => { const ge = globalThis.gameEntry; const me = ge.actorStates.get(ge.localPlayerId); return me && me.__v152Tint ? JSON.stringify(me.animator._legacyMonsterStringPalette) : null; });
  }
  console.log('my tint', tinted);
  await g.shot('152-poison-tint');
  const me = await g.actorScreen(acct.playerId);
  if (me) await g.page.screenshot({ path: '/tmp/claude-0/shots/152-poison-tint-zoom.png', clip: { x: Math.max(0, me.x - 220), y: Math.max(0, me.y - 220), width: 440, height: 300 } });
  await g.wait(6000); if (me) await g.page.screenshot({ path: '/tmp/claude-0/shots/152-after-tint.png', clip: { x: Math.max(0, me.x - 220), y: Math.max(0, me.y - 220), width: 440, height: 300 } });
  g.dumpLogs('152');
  const errs = g.logs.filter((l) => /pageerror|V15\.2/.test(l));
  console.log('errors', JSON.stringify(errs.slice(0, 10)));
  await g.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
