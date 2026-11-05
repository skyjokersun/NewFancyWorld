'use strict';
// Fifteenth batch: summon the 大地龙 (admin API) and look at it; then a 小红龙 transform.
// node test/ui/dragon15.js   (server on 8090, admin on 8091)
const fs = require('fs');
const { prepareAccount, openGame } = require('./session');
const ADMIN = 'http://localhost:' + (process.env.QIYU_ADMIN_PORT || 8091);
async function admin(path, body) {
  const pw = fs.readFileSync(__dirname + '/../../admin-password.txt', 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))[0].trim();
  const lg = await fetch(ADMIN + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
  const cookie = lg.headers.get('set-cookie').split(';')[0];
  const r = await fetch(ADMIN + '/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body || {}) });
  return r.json();
}
(async () => {
  const acct = await prepareAccount({ level: 150, profession: 'gunner', world: 'west' });
  await admin('b15/dismiss');
  const s = await admin('b15/summon');
  const d = ((s.view || s).dragonAlive || []).find((x) => x.world === 'green');
  console.log('summon', s.done, JSON.stringify(d));
  const g = await openGame(acct, { width: 1920, height: 1200 });
  await g.waitScene(); await g.wait(1000);
  await g.chat('/go dk2_05 ' + Math.round(d.x + 80) + ' ' + Math.round(d.y - 260));
  await g.waitScene(); await g.wait(2500);
  console.log(JSON.stringify(await g.eval((id) => { const ge = globalThis.gameEntry; const me = ge.actorStates.get(ge.localPlayerId); const e = ge.actorStates.get(id);
    return { me: me && [me.node.position.x, me.node.position.y], drag: e ? { pos: [e.node.position.x, e.node.position.y], active: e.node.active, hp: e.currentHp } : null, ids: [...(ge.enemyActorIds || [])].slice(0, 20) }; }, d.id)));
  await g.shot('15-dragon');
  await admin('b15/dismiss');
  await g.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
