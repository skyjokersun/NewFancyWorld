'use strict';
// UI test: card puzzle altars in the real client (pintu map).
const { prepareAccount, openGame } = require('./session');

(async () => {
  const acct = await prepareAccount();
  const g = await openGame(acct);
  const ge = (fn, arg) => g.eval(fn, arg);
  const out = {};
  try {
    // Enter through the square's "圣坛" portal the way the client does (mapRef 'card').
    await g.chat('/go square_in 2760 -60'); await g.waitScene(); await g.wait(1500);
    await ge(() => globalThis.gameEntry.requestMapSwitchWithLoading('card', '圣坛'));
    await g.waitScene(); await g.wait(4000);
    out.map = await ge(() => globalThis.gameEntry.gameMapController.currentMap && globalThis.gameEntry.gameMapController.currentMap.id);
    for (let i = 0; i < 15; i += 1) await g.chat('/item ' + (3900 + i));
    await g.wait(1500);
    // Place cards through the client's own right-click path.
    const placed = await ge(() => {
      const e = globalThis.gameEntry; const slots = e.itemPanel.itemState ? e.itemPanel.itemState.inventory.slots : e.characterInteractionController.tradePanel.itemState.inventory.slots;
      let n = 0; slots.forEach((it, i) => { if (it && it.itemId >= 3900 && it.itemId <= 3915 && e.cardPuzzleSystem.tryPlaceCard(i, it.itemId)) n += 1; });
      return n;
    });
    out.placed = placed;
    await g.wait(2500);
    await g.chat('/go pintu 2139 -575'); await g.waitScene(); await g.wait(3000);
    out.state = await ge(() => { const s = globalThis.gameEntry.cardPuzzleSystem.state; return s && s.altars.map((a) => a.altar + ':' + a.pieces.length + ':' + a.phase); });
    out.pieceNodes = await ge(() => globalThis.gameEntry.cardPuzzleSystem.pieceNodes.size);
    await g.shot('c1-altar-15of16');
    await g.chat('/item 3915'); await g.wait(1200);
    await ge(() => { const e = globalThis.gameEntry; const slots = e.characterInteractionController.tradePanel.itemState.inventory.slots; const i = slots.findIndex((it) => it && it.itemId === 3915); e.cardPuzzleSystem.tryPlaceCard(i, 3915); });
    await g.wait(2500); await g.shot('c2-altar-complete');
    // The wish panel opens on its own 3.2 s after eligibility arrives.
    await g.wait(2500);
    out.wishPanel = await ge(() => globalThis.gameEntry.cardPuzzleSystem.wishPanel.isVisible());
    out.eligibility = await ge(() => { const s = globalThis.gameEntry.cardPuzzleSystem.state; return s && s.eligibility && s.eligibility.options; });
    await g.shot('c3-wish-panel');
    const hp0 = await ge(() => globalThis.gameEntry.localPlayerParams.combat.maxHp);
    await ge(() => { const w = globalThis.gameEntry.cardPuzzleSystem.wishPanel; w.chooseWish('heart_hp'); });
    await g.wait(2000);
    out.maxHpGain = (await ge(() => globalThis.gameEntry.localPlayerParams.combat.maxHp)) - hp0;
    out.wishPanelAfter = await ge(() => globalThis.gameEntry.cardPuzzleSystem.wishPanel.isVisible());
    await g.shot('c4-wish-done');
    await g.wait(8000);
    out.afterCelebrate = await ge(() => { const s = globalThis.gameEntry.cardPuzzleSystem.state; return s && s.altars.map((a) => a.altar + ':' + a.pieces.length + ':' + a.phase); });
    console.log(JSON.stringify(out, null, 1));
    const errs = g.logs.filter((l) => /pageerror|CardPuzzle/.test(l));
    console.log('card puzzle log lines:', errs.length); errs.slice(0, 6).forEach((l) => console.log('  ', l.slice(0, 200)));
  } finally {
    g.dumpLogs('cardpuzzle'); await g.close();
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
