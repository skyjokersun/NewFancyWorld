'use strict';
// Hunting check: monster motion continuity, attack → damage → kill → EXP.
const { prepareAccount, openGame } = require('./session');
const prof = process.argv[2] || 'archer';
(async () => {
  const acct = await prepareAccount({ level: 15, profession: prof });
  const g = await openGame(acct);
  await g.chat('/go hunt_p_01');
  console.log('scene ready', await g.waitScene());
  await g.wait(1500);
  // Teleport next to the closest monster so it is on screen.
  const near = await g.eval(() => {
    const ge = globalThis.gameEntry; const me = ge.actorStates.get(ge.localPlayerId); let best = null, bd = 1e9;
    for (const id of ge.enemyActorIds) { const a = ge.actorStates.get(id); if (!a) continue; const d = Math.hypot(a.node.position.x - me.node.position.x, a.node.position.y - me.node.position.y); if (d < bd) { bd = d; best = a.node.position; } }
    return best && { x: Math.round(best.x), y: Math.round(best.y) };
  });
  if (near) { await g.chat('/go hunt_p_01 ' + (near.x + 160) + ' ' + (near.y - 60)); await g.waitScene(); await g.wait(1500); }
  await g.shot('10-hunt-' + prof);
  // 1) motion continuity: sample enemy positions every 100 ms for 8 s.
  const jumps = await g.eval(async () => {
    const ge = globalThis.gameEntry; const last = new Map(); const out = []; let samples = 0;
    for (let i = 0; i < 80; i += 1) {
      for (const id of ge.enemyActorIds) {
        const a = ge.actorStates.get(id); if (!a || !a.node) continue;
        const p = a.node.position; const prev = last.get(id);
        if (prev) { const d = Math.hypot(p.x - prev.x, p.y - prev.y); if (d > 45) out.push({ id, d: Math.round(d), t: i }); }
        last.set(id, { x: p.x, y: p.y }); samples += 1;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { enemies: last.size, samples, jumps: out.slice(0, 20), jumpCount: out.length };
  });
  console.log('motion', JSON.stringify(jumps));
  // 2) attack nearest enemy by clicking it.
  const before = await g.eval(() => JSON.stringify(globalThis.gameEntry.localPlayerParams.progression));
  // Lock the closest enemy the way a mouse click does (combat controller with the
  // enemy's map position), re-issuing after each shot, for ~40 s.
  const fight = await g.eval(async () => {
    const ge = globalThis.gameEntry; const me = ge.actorStates.get(ge.localPlayerId);
    const log = []; let kills = 0; let target = null;
    const last = new Map(); const jumps = [];
    const sampler = setInterval(() => {
      for (const id of ge.enemyActorIds) {
        const a = ge.actorStates.get(id); if (!a || !a.node || a.isDead()) { last.delete(id); continue; }
        const p = a.node.position; const prev = last.get(id);
        if (prev) { const d = Math.hypot(p.x - prev.x, p.y - prev.y); if (d > 40) jumps.push(id + ':' + Math.round(d)); }
        last.set(id, { x: p.x, y: p.y });
      }
    }, 100);
    for (let i = 0; i < 40; i += 1) {
      let t = target && ge.actorStates.get(target);
      if (!t || t.isDead()) {
        if (t) kills += 1;
        let bd = 1e9; target = null;
        for (const id of ge.enemyActorIds) { const a = ge.actorStates.get(id); if (!a || a.isDead()) continue; const d = Math.hypot(a.node.position.x - me.node.position.x, a.node.position.y - me.node.position.y); if (d < bd) { bd = d; target = id; } }
        if (!target) break;
        t = ge.actorStates.get(target);
        log.push('target ' + target + ' d=' + Math.round(bd));
      }
      ge.playerCombatActionController.handlePointerDown(t.node.position.clone(), {});
      await new Promise((r) => setTimeout(r, 1000));
    }
    clearInterval(sampler);
    return { kills, jumps: jumps.slice(0, 30), jumpCount: jumps.length, log: log.slice(0, 12), hp: ge.localPlayerParams.combat && ge.localPlayerParams.combat.hp };
  });
  console.log('fight', JSON.stringify(fight));
  await g.shot('11-hunt-fight-' + prof);
  const after = await g.eval(() => JSON.stringify(globalThis.gameEntry.localPlayerParams.progression));
  console.log('progression before', before, '\nafter', after);
  g.dumpLogs('hunt-' + prof);
  await g.close();
})().catch((e) => { console.error(e); process.exit(1); });
