'use strict';
// UI test: party HUD, sit/expression, trade panel and stall panel in the real
// client, with a second player driven through the protocol.
const { prepareAccount, openGame, wsUrl, OP } = require('./session');
const { TestClient } = require('../client');

async function protocolPlayer(world) {
  const c = new TestClient(wsUrl); await c.open(); await c.wait(OP.CONNECT);
  const email = 'uib' + Date.now() + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' });
  await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123', serverId: world }); await c.wait(OP.LOGIN_SUCCESS);
  c.name = 'V' + String(Date.now()).slice(-6);
  c.send(OP.CHARACTER_CREATE, { nickname: c.name, appearance: { gender: 'women', portraitId: 3 } });
  await c.wait(OP.CHARACTER_CREATE_RESULT);
  c.id = (await c.wait(OP.LOGIN_SUCCESS)).data.playerId;
  c.chat = (m) => c.send(OP.CHAT, { channel: 'world', message: m });
  c.act = (d) => c.send(OP.CHARACTER_INTERACTION, d);
  c.ev = (type, ms = 8000) => c.wait(OP.CHARACTER_INTERACTION_EVENT, (d) => d.type === type, ms).then((p) => p.data);
  setInterval(() => c.send(OP.HEARTBEAT, { clientTime: Date.now() }), 5000).unref();
  return c;
}

(async () => {
  const acct = await prepareAccount();
  const g = await openGame(acct);
  const ge = (fn, arg) => g.eval(fn, arg);
  const b = await protocolPlayer(acct.world);
  const ctl = 'globalThis.gameEntry.characterInteractionController';
  const results = {};
  try {
    await g.chat('/go square_in'); await g.waitScene(); await g.wait(1500);
    b.chat('/go square_in'); await b.wait(OP.MAP_SWITCH_RESULT);
    await g.wait(2500);
    await ge(() => globalThis.gameEntry.ensureCharacterInteractionReady());

    // --- party: B invites, A clicks "accept" in the HUD ---
    b.chat('/team invite ' + acct.nickname);
    // Chat is delivered once the gameplay HUD has loaded (slow under swiftshader).
    for (let i = 0; i < 40 && !(await g.page.$('#qiyu-party-invite:not([hidden]) button')); i += 1) await g.wait(500);
    await g.shot('i1-party-invite');
    const acceptBtn = await g.page.$('#qiyu-party-invite:not([hidden]) button');
    results.partyInviteShown = !!acceptBtn;
    if (acceptBtn) await acceptBtn.click();
    await g.wait(1500);
    results.partyHud = await ge(() => { const el = document.querySelector('#qiyu-party-button'); return el && el.textContent; });
    results.partyMembers = await ge(() => Array.from(document.querySelectorAll('.qiyu-party-name')).map((e) => e.textContent));
    await g.shot('i2-party-joined');

    // --- sit + expression through the self context menu ---
    await ge((s) => { const c = eval(s); c.handleMenuSelection(globalThis.gameEntry.localPlayerId, 'sit'); }, ctl);
    const sitEv = await b.ev('state');
    results.sitBroadcast = sitEv.pose;
    await g.wait(800);
    results.localPose = await ge((s) => { const c = eval(s); const st = c.states.get(globalThis.gameEntry.localPlayerId); return st && st.pose; }, ctl);
    await ge(() => globalThis.gameEntry.gameSession.sendPacket({ opCode: 5600, data: { type: 'expression', expressionId: 2 } }));
    await g.wait(1200); await g.shot('i3-sit-expression');

    // --- inspect B ---
    await ge((x) => { const c = eval(x.s); c.handleMenuSelection(x.id, 'inspect'); }, { s: ctl, id: b.id });
    await g.wait(1200);
    results.inspectPanel = await ge((s) => { const c = eval(s); return c.panels.isVisible() && c.panels.panelKind; }, ctl);
    await g.shot('i4-inspect');
    await ge((s) => eval(s).panels.close(false), ctl);

    // --- trade: A asks, B accepts, A puts an item, B adds gold, both confirm ---
    await ge((x) => { const c = eval(x.s); c.handleMenuSelection(x.id, 'trade'); }, { s: ctl, id: b.id });
    const req = await b.ev('request');
    b.act({ type: 'target_response', requestId: req.requestId, accepted: true });
    const tb = (await b.ev('trade_state')).trade;
    await g.wait(1500);
    results.tradePanel = await ge((s) => eval(s).tradePanel.isVisible(), ctl);
    const offered = await ge((s) => {
      const tp = eval(s).tradePanel; const slots = tp.itemState.inventory.slots;
      const i = slots.findIndex((it) => it); tp.sendTradeOffer({ inventoryIndex: i, itemSeqId: slots[i].seqId, count: 1, maxCount: 1 });
      return slots[i].name;
    }, ctl);
    await b.ev('trade_state');
    b.act({ type: 'trade_gold', sessionId: tb.sessionId, gold: 77 });
    await b.ev('trade_state');
    b.act({ type: 'trade_confirm', sessionId: tb.sessionId });
    await g.wait(1500);
    results.tradeView = await ge((s) => { const t = eval(s).tradePanel.trade; return t && { own: t.ownOffers.map((o) => o.item.name + 'x' + o.count), otherGold: t.otherGold, otherConfirmed: t.otherConfirmed }; }, ctl);
    await g.shot('i5-trade-panel');
    const goldBefore = await ge(() => globalThis.gameEntry.characterInteractionController.tradePanel.itemState.params.profile.gold);
    await ge((s) => { const tp = eval(s).tradePanel; tp.ops.sendCommand({ type: 'trade_confirm', sessionId: tp.trade.sessionId }); }, ctl);
    await b.ev('trade_closed');
    await g.wait(1500);
    results.tradeClosed = await ge((s) => !eval(s).tradePanel.isVisible(), ctl);
    const goldAfter = await ge(() => globalThis.gameEntry.characterInteractionController.tradePanel.itemState.params.profile.gold);
    results.tradeGold = goldAfter - goldBefore;
    results.tradeItem = offered;
    await g.shot('i6-trade-done');

    // --- stall: license at the town hall, then open a stall from the self menu ---
    await g.chat('/gold 2000000'); await g.wait(400);
    await g.chat('/go townhouse'); await g.waitScene(); await g.wait(1000);
    await ge(() => globalThis.gameEntry.gameSession.sendPacket({ opCode: 5820, data: { type: 'business_apply', service: 'business' } }));
    await g.wait(1000);
    await g.chat('/go square_in'); await g.waitScene(); await g.wait(2500);
    b.chat('/go square_in'); await b.wait(OP.MAP_SWITCH_RESULT);
    await g.wait(1000); b.drain();
    await ge((s) => { const c = eval(s); c.handleMenuSelection(globalThis.gameEntry.localPlayerId, 'stall'); }, ctl);
    const bs = await b.ev('stall_state');
    await g.wait(2500);
    results.stallPanel = await ge((s) => { const c = eval(s); return c.stallPanel.isVisible() && c.stallPanel.editable; }, ctl);
    results.stallWorld = await ge((s) => { const c = eval(s); const r = c.stallWorld.runtimes.get(globalThis.gameEntry.localPlayerId); return !!(r && r.loaded); }, ctl);
    await g.shot('i7-stall-editor');
    // List the first bag item for 88 through the panel's own submit path.
    await ge((s) => {
      const p = eval(s).stallPanel; const slots = p.itemState.inventory.slots; const i = slots.findIndex((it) => it);
      p.selectionRow = 0; p.selectionInventoryIndex = i; p.selectionCountValue = '1'; p.selectionPriceValue = '88';
      p.listings = [p.makeDraftListing(i, slots[i])]; p.listings[0].unitPrice = 88; p.renderMain(); p.submitChanges();
    }, ctl);
    const listed = await b.wait(OP.CHARACTER_INTERACTION_EVENT, (d) => d.type === 'stall_state' && d.stall && d.stall.listings.length === 1).then((p) => p.data.stall);
    await g.wait(1200); await g.shot('i8-stall-listed');
    b.act({ type: 'stall_open', ownerPlayerId: acct.playerId });
    const detail = await b.ev('stall_detail');
    b.drain();
    b.act({ type: 'stall_buy', ownerPlayerId: acct.playerId, listingId: detail.stall.listings[0].listingId, count: 1 });
    results.stallBuy = (await b.ev('error')).message;
    await g.wait(1500); await g.shot('i9-stall-sold');
    results.stallAfter = await ge((s) => { const c = eval(s); return c.stallPanel.stall && c.stallPanel.stall.listings.length; }, ctl);
    results.stallListing = listed.listings[0].itemName + ' @' + listed.listings[0].unitPrice + ' at ' + bs.stall.stallX + ',' + bs.stall.stallY;
    // Walk away: the stall stays in the world.
    await ge((s) => eval(s).stallPanel.close(), ctl);
    await g.chat('/team leave'); await g.wait(800);
    results.partyAfterLeave = await ge(() => { const el = document.querySelector('#qiyu-party-button'); return el && el.textContent; });
    console.log(JSON.stringify(results, null, 1));
    const errors = g.logs.filter((l) => /pageerror|\[error\]/.test(l));
    console.log('page errors:', errors.length); errors.slice(0, 8).forEach((l) => console.log('  ', l.slice(0, 200)));
  } finally {
    g.dumpLogs('interaction'); await g.close(); b.close();
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
