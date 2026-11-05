'use strict';
// UI check for the eighth batch: patch 100 loads, mount buttons, 战神 dialog,
// arena keeper and targets, auto hunt on a hunting map, dragon wish label.
const { prepareAccount, openGame } = require('./session');
(async () => {
  const acct = await prepareAccount({ level: 60, profession: 'archer' });
  const g = await openGame(acct);
  await g.wait(3000);
  const loaded = await g.eval(() => !!globalThis.__QIYU_BATCH8_API__);
  console.log('patch loaded', loaded);
  console.log('wish label', await g.eval(() => System.import('chunks:///_virtual/CardPuzzleCatalog.ts').then((m) => m.CARD_PUZZLE_WISH_LABELS.dragon_attributes)));
  // Mount buttons: give a capsule and use it through the protocol.
  await fetch('http://127.0.0.1:8090/admin/api/character/' + acct.playerId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cloudDays: 1 }) }).then((r) => r.json()).then((j) => console.log('admin', JSON.stringify(j.done)));
  await g.wait(1500);
  console.log('mounts', JSON.stringify(await g.eval(() => globalThis.__QIYU_BATCH8_API__.state.mounts)));
  await g.shot('b8-01-mount-owned');
  await g.eval(() => globalThis.__QIYU_BATCH8_API__.send('mount', { mount: 'cloud' }));
  await g.wait(1500);
  console.log('riding', await g.eval(() => globalThis.__QIYU_BATCH8_API__.state.mounts.riding), 'flight', JSON.stringify(await g.eval(() => { const ge = globalThis.gameEntry; const a = ge.actorStates.get(ge.localPlayerId); return a && (a.originalFlight || a.__qiyuFlight || null); })));
  await g.shot('b8-02-riding-cloud');
  // 战神 statue
  await g.chat('/go job_fight 1000 -420'); await g.waitScene(); await g.wait(2000);
  const statue = await g.eval(() => {
    const ge = globalThis.gameEntry; const ctl = ge.mapInteractiveController || Object.values(ge).find((v) => v && v.handleDecorClick && v.deps);
    if (!ctl) return 'no controller';
    return ctl.handleDecorClick({ tag: '战神', x: 1055, y: 372, extra: '- 1 , 100' });
  });
  await g.wait(800);
  console.log('statue click', statue, await g.eval(() => { const el = document.getElementById('qiyu-b8-panel'); return el && !el.hidden && el.textContent.slice(0, 120); }));
  await g.shot('b8-03-zhanshen');
  await g.eval(() => document.querySelector('#qiyu-b8-panel .b8-title button').click());
  // Arena room
  await g.chat('/go abattoir'); await g.waitScene(); await g.wait(1500);
  await g.eval(() => globalThis.gameEntry.requestMapSwitchWithLoading('pk_a1', '自由角斗1室'));
  await g.waitScene(); await g.wait(2500);
  console.log('arena map', await g.eval(() => globalThis.gameEntry.gameMapController.getCurrentMap().id));
  const keeper = await g.eval(() => {
    const ge = globalThis.gameEntry;
    const m = ge.gameMapController.getCurrentMap();
    const list = (m && m.decor && m.decor.addImgExs) || (m && m.doc && m.doc.decor && m.doc.decor.addImgExs) || null;
    return list ? JSON.stringify(list.filter((x) => x && x.tag === 'arena_target')) : 'decor list not found: ' + Object.keys(m || {}).join(',');
  });
  console.log('keeper decor', keeper);
  await g.shot('b8-04-arena-room');
  await g.eval(() => { const ge = globalThis.gameEntry; const ctl = ge.mapInteractiveController || Object.values(ge).find((v) => v && v.handleDecorClick && v.deps); ctl.handleDecorClick({ tag: 'arena_target', x: 540, y: 250, extra: '"靶子管理员"' }); });
  await g.wait(800);
  await g.eval(() => [...document.querySelectorAll('#qiyu-b8-panel button')].find((b) => b.textContent === '租借脆弱靶子').click());
  await g.wait(2000);
  console.log('targets', JSON.stringify(await g.eval(() => { const ge = globalThis.gameEntry; return [...ge.enemyActorIds].map((id) => { const a = ge.actorStates.get(id); return a && a.node ? [id, Math.round(a.node.position.x), Math.round(a.node.position.y)] : id; }); })));
  await g.shot('b8-05-arena-targets');
  await g.eval(() => document.querySelector('#qiyu-b8-panel .b8-title button').click());
  // Auto hunt in the arena: get off the cloud? (cloud stays), start, watch the targets break.
  console.log('hunt ui', await g.eval(() => { const el = document.getElementById('qiyu-b8-hunt'); return el && !el.hidden && el.textContent; }));
  await g.eval(() => document.querySelector('#qiyu-b8-hunt button').click());
  await g.wait(8000);
  console.log('hunt state', JSON.stringify(await g.eval(() => globalThis.__QIYU_BATCH8_API__.state.autohunt)), 'ai', await g.eval(() => globalThis.__QIYU_BATCH8_API__.ai.on));
  await g.shot('b8-06-autohunt-arena');
  // Hunting map
  await g.chat('/go hunt_p_02'); await g.waitScene(); await g.wait(2000);
  const exp0 = await g.eval(() => globalThis.gameEntry.localPlayerParams.progression.combatExp);
  await g.eval(() => { const b = document.querySelector('#qiyu-b8-hunt button'); if (!globalThis.__QIYU_BATCH8_API__.state.autohunt.on) b.click(); });
  await g.wait(25000);
  const exp1 = await g.eval(() => globalThis.gameEntry.localPlayerParams.progression.combatExp);
  console.log('hunt exp', exp0, '->', exp1, JSON.stringify(await g.eval(() => globalThis.__QIYU_BATCH8_API__.state.autohunt)));
  await g.shot('b8-07-autohunt-field');
  g.dumpLogs('b8');
  const errs = g.logs.filter((l) => /pageerror|\[error\]/.test(l));
  console.log('errors', errs.length, errs.slice(0, 8).join('\n'));
  await g.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
