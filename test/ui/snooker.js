'use strict';
// UI test: snooker table panel in the real client (practice + computer).
const { prepareAccount, openGame } = require('./session');
const { MapRegistry } = require('../../src/game/map');
const cfg = require('../../src/config');

(async () => {
  const acct = await prepareAccount({ level: 10 });
  const g = await openGame(acct);
  const ge = (fn, arg) => g.eval(fn, arg);
  const desk = new MapRegistry(cfg.dataDir).rawDoc('team_room').decor.find((d) => /btable_r/.test(d.path));
  const st = () => ge(() => { const s = globalThis.gameEntry.snookerTablePanel.state; return s && { phase: s.phase, target: s.target, turn: s.turnPlayerId, scores: s.players.map((p) => p.playerName + ':' + p.score).join(' '), msg: s.message }; });
  const waitPhase = async (ph, ms = 20000) => { for (let t = 0; t < ms; t += 250) { const s = await st(); if (s && s.phase === ph) return s; await g.wait(250); } return st(); };
  const shoot = (shot) => ge((x) => { const p = globalThis.gameEntry.snookerTablePanel; p.aim = { x: x.ax, y: x.ay }; p.cuePoint = { x: x.sx || 0, y: x.sy || 0 }; p.shotPower = x.power; p.ops.requestShoot(p.state.roomId, x.ax, x.ay, x.power, p.cuePoint.x, p.cuePoint.y); }, shot);
  try {
    await g.chat('/go team_room ' + desk.x + ' ' + (-desk.y - 40)); await g.waitScene(); await g.wait(2500);
    await g.shot('b0-snooker-room');
    await ge(() => globalThis.gameEntry.ensureSnookerPanelReady().then(() => globalThis.gameEntry.snookerTablePanel.openTable('1')));
    await g.wait(1500); await g.shot('b1-snooker-mode');
    await ge(() => globalThis.gameEntry.snookerTablePanel.chooseGameMode('practice'));
    await g.wait(1500); console.log('practice', JSON.stringify(await st()));
    // Real mouse input: aim at the rack apex, hold to charge, release to shoot.
    const scr = (x, y) => ({ x: 40 + x * 1.1765, y: 83 + y * 1.1765 });
    const apex = scr(767, 270);
    await g.page.mouse.move(apex.x - 30, apex.y - 60); await g.wait(200);
    await g.page.mouse.move(apex.x, apex.y, { steps: 5 }); await g.wait(400); await g.shot('b2-snooker-aim');
    await g.page.mouse.down(); await g.wait(900); await g.shot('b2b-snooker-charge');
    await g.page.mouse.up();
    await g.wait(700); await g.shot('b3-snooker-break');
    console.log('after break', JSON.stringify(await waitPhase('aiming')));
    await g.wait(500); await g.shot('b4-snooker-settled');
    const drift = await ge(() => { const p = globalThis.gameEntry.snookerTablePanel; let m = 0; for (const b of p.state.balls) { const d = p.displayBalls.get(b.id); if (d) m = Math.max(m, Math.hypot(d.x - b.x, d.y - b.y)); } return m; });
    console.log('display vs server drift px', drift);
    await ge(() => { const p = globalThis.gameEntry.snookerTablePanel; p.ops.requestReset(p.state.roomId); }); await g.wait(1000);
    await g.shot('b5-snooker-reset');
    // computer match
    await ge(() => { const p = globalThis.gameEntry.snookerTablePanel; p.ops.requestLeave(p.state.roomId); p.reset(false); p.openTable('1'); p.chooseGameMode('computer'); });
    await g.wait(1500);
    await shoot({ ax: 0.999, ay: 0.03, power: 0.85 });
    await waitPhase('moving', 4000);
    console.log('my break', JSON.stringify(await waitPhase('aiming')));
    await g.wait(700); await g.shot('b6-snooker-computer-aim');
    for (let i = 0; i < 6; i += 1) {
      const s = await st();
      if (s.phase === 'finished') break;
      if (s.turn === 'computer') { await waitPhase('moving', 6000); await g.wait(600); if (i < 2) await g.shot('b7-snooker-computer-shot' + i); await waitPhase('aiming'); } else {
        await ge(() => { const p = globalThis.gameEntry.snookerTablePanel; const cue = p.state.balls.find((b) => b.id === 'cue'); const t = p.state.balls.find((b) => !b.potted && b.kind === 'red') || p.state.balls.find((b) => !b.potted && b.kind !== 'cue'); const dx = t.x - cue.x; const dy = t.y - cue.y; const l = Math.hypot(dx, dy); p.ops.requestShoot(p.state.roomId, dx / l, dy / l, 0.5, 0, 0); });
        await waitPhase('moving', 4000); await waitPhase('aiming');
      }
      console.log('  ', JSON.stringify(await st()));
    }
    await g.shot('b8-snooker-score');
    await ge(() => { const p = globalThis.gameEntry.snookerTablePanel; p.ops.requestLeave(p.state.roomId); p.reset(false); });
    await g.wait(600); await g.shot('b9-snooker-left');
  } finally {
    g.dumpLogs('snooker'); await g.close();
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
