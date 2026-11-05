'use strict';
// UI test: modern (创造者果园) and legacy (怀旧果园) garden panels in the real
// client, opened through GardenSystem.handleDecorClick like a decor click.
const { prepareAccount, openGame } = require('./session');
const { MapRegistry } = require('../../src/game/map');
const cfg = require('../../src/config');
const maps = new MapRegistry(cfg.dataDir);
const decorOf = (mapRef, pred) => { const d = maps.rawDoc(mapRef).decor.find(pred); return d && { tag: d.tag, path: d.path, extra: d.extra, sourceIndex: d.i, x: d.x, y: d.y }; };

(async () => {
  const acct = await prepareAccount({ profession: 'gardener', level: 20 });
  const g = await openGame(acct);
  const ge = (fn, arg) => g.eval(fn, arg);
  const send = (a) => ge((x) => globalThis.gameEntry.gardenSystem.sendAction(x), a);
  const click = (d) => ge((x) => globalThis.gameEntry.ensureGardenReady().then(() => globalThis.gameEntry.gardenSystem.handleDecorClick(x)), d);
  const st = () => ge(() => { const s = globalThis.gameEntry.gardenSystem.state; return s && { mode: s.mode, owned: s.ownedTrees, max: s.maxTrees, msg: s.message, seeds: (s.seeds || []).map((x) => x.treeKey + ':' + x.ownedCount).join(' '), mine: s.plots.filter((p) => p.owned).map((p) => p.sourceIndex + ':' + p.stage + ':' + p.growthDay).join(' '), legacy: s.legacy && { lvl: s.legacy.level, own: s.legacy.ownTrees.length, unowned: s.legacy.unownedTrees.length } }; });
  try {
    await g.chat('/gold 50000'); await g.chat('/plevel 20');
    // entrance menu in workaround_in
    const gate = decorOf('workaround_in', (d) => /guoyuan_men/.test(d.path));
    await g.chat('/go workaround_in ' + Math.round(gate.x) + ' ' + Math.round(-gate.y + 60)); await g.waitScene(); await g.wait(2500);
    await click(gate); await g.wait(600);
    await ge(() => { const s = globalThis.gameEntry.gardenSystem; if (s.pendingEntrance) s.openEntrance(s.pendingEntrance.entrance); });
    await g.wait(2000); console.log('entrance visible', await ge(() => { const p = globalThis.gameEntry.gardenSystem.panel; return p.isVisible() + ' ' + (p.view && p.view.kind); })); await g.shot('90-garden-entrance');
    if (process.env.ONLY_ENTRANCE) { g.dumpLogs('garden'); await g.close(); process.exit(0); }
    console.log('entrance', await ge(() => { const p = globalThis.gameEntry.gardenSystem.panel; const e = p.view && p.view.entrance; if (!e) return 'no entrance view'; const opt = e.destinations[0]; p.ops.selectEntrance(e, opt); return e.title + ' -> ' + opt.mapRef; }));
    await g.waitScene(); await g.wait(3500);
    console.log('map', await ge(() => (globalThis.gameEntry.gameMapController.getCurrentMap() || {}).id));
    await g.shot('91-newgarden-arrive');
    const minder = decorOf('newgarden_01', (d) => d.tag === 'minder');
    await click(minder); await g.wait(1500); await g.shot('92-newgarden-service');
    await send({ action: 'buy_seed', treeKey: 'tianyu' }); await g.wait(800);
    await send({ action: 'buy_seed', treeKey: 'binglian' }); await g.wait(800);
    console.log('after buy', JSON.stringify(await st()));
    await g.shot('93-newgarden-bought');
    const pit = decorOf('newgarden_01', (d) => d.tag === 'fruittree' && d.i === 9);
    await g.chat('/go newgarden_01 ' + Math.round(pit.x) + ' ' + Math.round(-pit.y + 50)); await g.waitScene(); await g.wait(2500);
    await click(pit); await g.wait(1200); await g.shot('94-newgarden-pit');
    await send({ action: 'plant', sourceIndex: pit.sourceIndex, treeKey: 'tianyu' }); await g.wait(1200);
    await g.shot('95-newgarden-planted');
    await send({ action: 'care', sourceIndex: pit.sourceIndex, care: 'water' }); await g.wait(1000);
    await g.shot('96-newgarden-watered');
    await g.chat('/garden 3'); await g.wait(500); await send({ action: 'snapshot' }); await g.wait(1200);
    await g.shot('97-newgarden-day4');
    await g.chat('/garden 2'); await g.wait(500); await click(pit); await g.wait(1200);
    await g.shot('98-newgarden-mature');
    await send({ action: 'harvest', sourceIndex: pit.sourceIndex }); await g.wait(1200);
    console.log('after harvest', JSON.stringify(await st()));
    await g.shot('99-newgarden-harvest');
    await ge(() => globalThis.gameEntry.gardenSystem.panel.close());

    // legacy orchard
    await g.chat('/go garden_01'); await g.waitScene(); await g.wait(3500);
    const lminder = decorOf('garden_01', (d) => d.tag === 'minder');
    await g.chat('/go garden_01 ' + Math.round(lminder.x) + ' ' + Math.round(-lminder.y + 60)); await g.waitScene(); await g.wait(2500);
    await click(lminder); await g.wait(1500); await g.shot('a0-legacy-service');
    await send({ action: 'buy_work_card', workCardDays: 30 }); await g.wait(1000);
    await g.shot('a1-legacy-card');
    const tree = decorOf('garden_01', (d) => d.tag === 'fruittree');
    await g.chat('/go garden_01 ' + Math.round(tree.x) + ' ' + Math.round(-tree.y + 50)); await g.waitScene(); await g.wait(2500);
    await click(tree); await g.wait(1200); await g.shot('a2-legacy-tree');
    await send({ action: 'adopt', sourceIndex: tree.sourceIndex }); await g.wait(1200);
    await g.shot('a3-legacy-adopted');
    await g.chat('/garden 5'); await g.wait(500); await click(tree); await g.wait(1200);
    await send({ action: 'harvest', sourceIndex: tree.sourceIndex }); await g.wait(1200);
    console.log('legacy after harvest', JSON.stringify(await st()));
    await g.shot('a4-legacy-harvest');
    await click(lminder); await g.wait(1500); await g.shot('a5-legacy-service2');
  } finally {
    g.dumpLogs('garden'); await g.close();
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
