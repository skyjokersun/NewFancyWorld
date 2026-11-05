'use strict';
// V15.2: what the ice / poison status looks like on the local player (packets fed to the client).
const { prepareAccount, openGame } = require('./session');
(async () => {
  const acct = await prepareAccount({ level: 50, world: 'west' });
  const g = await openGame(acct, { width: 1280, height: 800 });
  await g.waitScene(); await g.wait(2000);
  const fire = (fx) => g.eval((a) => System.import('chunks:///_virtual/GameNetworkController.ts').then((m) => {
    const ge = globalThis.gameEntry; const gn = ge.gameNetworkController || ge.networkController;
    return m.GameNetworkController.prototype.handlePacket.call(gn || {}, { opCode: 7110, data: { kind: 'status_fx', id: ge.localPlayerId, fx: a, ms: 5000 } });
  }), fx);
  const me = await g.actorScreen(acct.playerId);
  const clip = { x: Math.max(0, me.x - 160), y: Math.max(0, me.y - 200), width: 320, height: 260 };
  await g.page.screenshot({ path: '/tmp/claude-0/shots/152fx-normal.png', clip });
  for (const fx of ['ice', 'poison']) {
    await fire(fx); await g.wait(350);
    await g.page.screenshot({ path: '/tmp/claude-0/shots/152fx-' + fx + '-hit.png', clip });
    await g.wait(1600);
    await g.page.screenshot({ path: '/tmp/claude-0/shots/152fx-' + fx + '.png', clip });
    await g.wait(5000);
  }
  await g.page.screenshot({ path: '/tmp/claude-0/shots/152fx-restored.png', clip });
  console.log('errors', JSON.stringify(g.logs.filter((l) => /pageerror|V15\.2|404/.test(l)).slice(0, 10)));
  await g.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
