'use strict';
// UI test: bank panel flows in the real client (buttons are triggered through the
// panel's own button table, the same code path as a mouse click).
const { prepareAccount, openGame } = require('./session');
(async () => {
  const acct = await prepareAccount();
  const g = await openGame(acct);
  await g.chat('/go bank');
  await g.waitScene(); await g.wait(1000);
  const press = (id) => g.eval((bid) => {
    const bp = globalThis.gameEntry.bankPanel; const b = bp.buttons.find((x) => x.id === bid);
    if (!b) return 'missing ' + bid + ' have ' + bp.buttons.map((x) => x.id).join(',');
    if (b.disabled) return 'disabled ' + bid;
    b.action(); return 'ok ' + bid + ' -> ' + bp.mode;
  }, id);
  const status = () => g.eval(() => { const bp = globalThis.gameEntry.bankPanel; return { mode: bp.mode, msg: bp.message, err: bp.messageIsError, pending: bp.pending, state: bp.state && { points: bp.state.servicePoints, coffers: bp.state.coffers.length, active: !!bp.state.activeCoffer } }; });
  await g.eval(() => globalThis.gameEntry.ensureBankPanelReady().then(() => globalThis.gameEntry.bankPanel.open()));
  await g.wait(1500); await g.shot('20-bank-main'); console.log('main', JSON.stringify(await status()));
  console.log(await press('main_1')); await g.wait(500); await g.shot('21-bank-coffer-menu');
  console.log(await press('coffer_0')); await g.wait(500);
  await g.eval(() => { const bp = globalThis.gameEntry.bankPanel; if (bp.identityInput) bp.identityInput.string = '123456789'; });
  await g.shot('22-bank-terms');
  console.log(await press('agree')); await g.wait(1500); await g.shot('23-bank-apply'); console.log('apply', JSON.stringify(await status()));
  console.log(await press('manage')); await g.wait(2500); await g.shot('24-bank-swap'); console.log('swap', JSON.stringify(await status()));
  // move first bag item to the coffer through the panel's own move routine, then save
  const moved = await g.eval(() => {
    const bp = globalThis.gameEntry.bankPanel; const i = bp.draftInventory.findIndex(Boolean);
    if (i < 0) return 'no item';
    if (typeof bp.moveDraftItem === 'function') bp.moveDraftItem('inventory', i); else return 'no move fn: ' + Object.getOwnPropertyNames(Object.getPrototypeOf(bp)).filter((n) => /draft|move|slot/i.test(n)).join(',');
    return 'moved ' + i;
  });
  console.log(moved);
  await g.wait(800); await g.shot('25-bank-swap-moved');
  const ids = await g.eval(() => globalThis.gameEntry.bankPanel.buttons.map((b) => b.id).join(','));
  console.log('swap buttons', ids);
  await g.eval(() => { const bp = globalThis.gameEntry.bankPanel; if (bp.storedGoldInput) bp.storedGoldInput.string = '100'; });
  console.log(await press('keep')); await g.wait(1500);
  console.log('after keep', JSON.stringify(await status()));
  console.log('bag/gold', JSON.stringify(await g.eval(() => { const ge = globalThis.gameEntry; const bp = ge.bankPanel; return { gold: bp.state.pocketGold, stored: bp.state.activeCoffer && bp.state.activeCoffer.storedGold, cofferItems: bp.state.activeCoffer && bp.state.activeCoffer.slots.filter(Boolean).map((i) => i.name + 'x' + i.count), bagItems: bp.itemState.inventory.slots.filter(Boolean).map((i) => i.name + 'x' + i.count) }; })));
  await g.shot('26-bank-saved');
  g.dumpLogs('bank');
  await g.close();
})().catch((e) => { console.error(e); process.exit(1); });
