'use strict';
// UI test: profession skills in the real client (hotbar, tooltips, casting
// through the client's own cast path, server damage and remote visuals).
const { prepareAccount, openGame } = require('./session');
const { TestClient, OP } = require('../client');
const wsUrl = (process.env.QIYU_URL || 'http://127.0.0.1:8090/').replace(/^http/, 'ws').replace(/\/?$/, '/ws');
const prof = process.argv[2] || 'mage';
const BOOKS = { mage: [321, 322, 323, 324, 325, 326, 327], warrior: [311, 1801, 900101, 900102], archer: [301, 302, 303], gunner: [352, 353], child: [] };

(async () => {
  const acct = await prepareAccount({ level: 40, profession: prof === 'child' ? null : prof });
  // Learn the books through the protocol before the browser logs in.
  {
    const c = new TestClient(wsUrl); await c.open(); await c.wait(OP.CONNECT);
    c.send(OP.LOGIN, { username: acct.email, password: acct.password }); await c.wait(OP.LOGIN_SUCCESS);
    c.send(OP.CHAT, { channel: 'world', message: '/plevel 40' });
    for (const id of BOOKS[prof]) c.send(OP.CHAT, { channel: 'world', message: '/item ' + id });
    await new Promise((r) => setTimeout(r, 600));
    c.send(OP.ITEM_QUERY, {}); const slots = (await c.wait(OP.ITEM_STATE)).data.inventory.slots;
    for (const id of BOOKS[prof]) { const i = slots.findIndex((it) => it && it.itemId === id); if (i >= 0) c.send(OP.ITEM_USE, { fromIndex: i }); }
    await new Promise((r) => setTimeout(r, 600));
    c.close(); await new Promise((r) => setTimeout(r, 400));
  }
  const g = await openGame(acct);
  const ge = (fn, arg) => g.eval(fn, arg);
  try {
    for (let i = 0; i < 40 && !(await ge(() => !!globalThis.gameEntry.localPlayerParams)); i += 1) await g.wait(500);
    const skills = await ge(() => (globalThis.gameEntry.localPlayerParams.professionSkills || []).map((s) => s.id + ':' + s.level));
    console.log('learned', skills.join(' '));
    await g.chat('/go hunt_p_02'); await g.waitScene(); await g.wait(3000);
    const findMonster = () => ge(() => { const e = globalThis.gameEntry; const me = e.actorStates.get(e.localPlayerId); let best = null; for (const id of e.enemyActorIds || []) { const a = e.actorStates.get(id); if (!a || !a.node || (a.isDead && a.isDead())) continue; const d = Math.hypot(a.node.position.x - me.node.position.x, a.node.position.y - me.node.position.y); if (!best || d < best.d) best = { id, x: a.node.position.x, y: a.node.position.y, d }; } return best; });
    let m = await findMonster();
    console.log('monster', JSON.stringify(m));
    await g.chat('/go hunt_p_02 ' + Math.round(m.x - 220) + ' ' + Math.round(m.y)); await g.waitScene(); await g.wait(2500);
    await g.shot('c0-skills-' + prof + '-hotbar');
    await ge(() => { const e = globalThis.gameEntry; if (e.attributePanel && e.attributePanel.setVisible) e.attributePanel.setVisible(true); });
    await g.wait(800); await g.shot('c1-skills-' + prof + '-panel');
    await ge(() => { const e = globalThis.gameEntry; if (e.attributePanel && e.attributePanel.setVisible) e.attributePanel.setVisible(false); });
    const ids = await ge(() => (globalThis.gameEntry.localPlayerParams.professionSkills || []).map((s) => s.id));
    let n = 0;
    for (const id of ids) {
      m = await findMonster();
      if (!m) break;
      if (m.d > 320) { await g.chat('/go hunt_p_02 ' + Math.round(m.x - 200) + ' ' + Math.round(m.y)); await g.waitScene(); await g.wait(1500); m = await findMonster(); }
      await g.chat('/heal'); await g.wait(200);
      const r = await ge(([sid, mx, my]) => {
        const e = globalThis.gameEntry; e.setSelectedProfessionSkillId(sid);
        const cc0 = globalThis.cc; const pt = new cc0.Vec3(mx, my, 0);
        let ok;
        if (sid.indexOf('hunter_') === 0 && e.tryBeginHunterSkillCharge) {
          ok = e.withProfessionSkillAimOverride(pt, () => e.castProfessionSkillById(sid));
        } else ok = e.withProfessionSkillAimOverride(pt, () => e.tryCastSelectedProfessionSkill(pt));
        return { ok, stamina: e.localPlayerParams.combat.stamina };
      }, [id, m.x, m.y]);
      await g.wait(500);
      if (n < 4) await g.shot('c2-skills-' + prof + '-' + id);
      await g.wait(1200);
      const after = await ge((sid) => { const e = globalThis.gameEntry; const s = e.localPlayerParams.professionSkills.find((x) => x.id === sid); return { stamina: e.localPlayerParams.combat.stamina, exp: s && s.exp, buffs: (e.localPlayerParams.combat.activeBuffs || []).map((b) => b.name).join(',') }; }, id);
      console.log(' ', id.padEnd(22), 'cast', r.ok, 'stamina', r.stamina, '->', after.stamina, 'exp', after.exp, after.buffs);
      n += 1;
    }
    const errors = g.logs.filter((l) => /pageerror|\[error\]/.test(l)).slice(-8);
    console.log('client errors:', errors.length ? errors.join('\n') : 'none');
  } finally {
    g.dumpLogs('skills-' + prof); await g.close();
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
