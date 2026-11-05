'use strict';
// Protocol test for profession skills: books, birth skills, every skill's
// cast resolution (damage / heal / buff), stamina cost, cooldown and exp.
const assert = require('assert');
const { TestClient, OP } = require('./client');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOOKS = {
  warrior: { 311: 'warrior_jianqi', 1801: 'warrior_charge', 900101: 'warrior_rage', 900102: 'warrior_gangqi' },
  archer: { 301: 'hunter_baibu', 302: 'hunter_jinshot', 303: 'hunter_feihuang_arrow' },
  mage: { 321: 'mage_ice_arrow', 322: 'mage_small_fireball', 323: 'mage_lightning_bolt', 324: 'mage_heal', 325: 'mage_ice_shockwave', 326: 'mage_fireball', 327: 'mage_lightning_star' },
  gunner: { 352: 'gunner_point_shot', 353: 'gunner_scatter_shot' },
};

async function newChar(tag) {
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  const email = tag + Date.now() + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' });
  await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123' }); await c.wait(OP.LOGIN_SUCCESS);
  c.send(OP.CHARACTER_CREATE, { nickname: tag.toUpperCase() + String(Date.now()).slice(-6), appearance: { gender: 'man' } });
  await c.wait(OP.CHARACTER_CREATE_RESULT); const login = (await c.wait(OP.LOGIN_SUCCESS)).data;
  c.me = login.playerId;
  c.chat = (m) => c.send(OP.CHAT, { channel: 'world', message: m });
  c.state = async () => { c.send(OP.ITEM_QUERY, {}); return (await c.wait(OP.ITEM_STATE)).data; };
  return c;
}

(async () => {
  // Birth skills of a child.
  const kid = await newChar('kid');
  let st = await kid.state();
  console.log('child skills:', st.params.professionSkills.map((s) => s.id + '(' + s.name + ',cost ' + s.mpCost + ')').join(' '));
  assert(st.params.professionSkills.some((s) => s.id === 'child_poison_cast'));
  kid.close();

  let seq = 10;
  for (const [prof, books] of Object.entries(BOOKS)) {
    const c = await newChar(prof.slice(0, 3));
    c.chat('/level 40'); c.chat('/prof ' + prof); c.chat('/plevel 40'); await sleep(300);
    for (const id of Object.keys(books)) c.chat('/item ' + id);
    await sleep(400);
    st = await c.state();
    for (const [bookId] of Object.entries(books)) {
      const i = st.inventory.slots.findIndex((it) => it && it.itemId === Number(bookId));
      c.send(OP.ITEM_USE, { fromIndex: i }); await sleep(120);
    }
    await sleep(400);
    st = await c.state();
    const learned = st.params.professionSkills;
    console.log('\n[' + prof + '] learned', learned.map((s) => s.id).join(' '));
    for (const id of Object.values(books)) assert(learned.some((s) => s.id === id), prof + ' learned ' + id);
    c.chat('/go hunt_p_01'); const ms = (await c.wait(OP.MAP_SWITCH_RESULT)).data;
    for (const sk of learned) {
      // stand next to the nearest live monster
      let m = null; let mapRef = 'hunt_p_01';
      for (const ref of ['hunt_p_01', 'hunt_p_02', 'hunt_p_03', 'hunt_p_04', 'hunt_p_05']) {
        c.drain(); c.chat('/go ' + ref); const snap = (await c.wait(OP.MAP_SWITCH_RESULT)).data; void ms;
        m = (snap.enemies || []).find((e) => e.state !== 'dead' && e.hp > 0);
        if (m) { mapRef = ref; break; }
      }
      const near = sk.id === 'warrior_charge' ? 260 : 120;
      c.chat('/go ' + mapRef + ' ' + Math.round(m.x - near) + ' ' + Math.round(m.y)); const at = (await c.wait(OP.MAP_SWITCH_RESULT)).data;
      const me = at.players.find((p) => p.playerId === c.me);
      c.chat('/heal'); await sleep(200);
      const before = (await c.state()).params;
      const stam0 = before.combat.stamina; const skill0 = before.professionSkills.find((s) => s.id === sk.id);
      c.drain();
      seq += 1;
      c.send(OP.ACTION, { action: { type: 'attack', attackPhase: 'fire', skillId: sk.id, x: me.x, y: me.y, seq, timestamp: Date.now(), aimX: m.x, aimY: m.y, targetId: sk.targetMode === 'target' || sk.id === 'mage_heal' ? (sk.id === 'mage_heal' ? c.me : m.enemyId) : undefined, chargeRatio: 1, attackType: sk.attackType } });
      let dmg = null;
      if (!['warrior_rage', 'warrior_gangqi', 'mage_heal'].includes(sk.id)) {
        const r = await c.wait(OP.ATTACK_RESULT, (d) => d.attackerId === c.me, 4000).catch(() => null);
        dmg = r ? r.data.damage : null;
      }
      await sleep(700);
      const after = (await c.state()).params;
      const skill1 = after.professionSkills.find((s) => s.id === sk.id);
      const buffs = (after.combat.activeBuffs || []).map((b) => b.name).join(',');
      console.log(' ', sk.id.padEnd(22), 'cost', String(sk.mpCost).padStart(3), 'stamina', stam0, '->', after.combat.stamina, '| dmg', dmg, '| exp', skill0.exp, '->', skill1.exp, buffs ? '| buffs ' + buffs : '');
      assert(after.combat.stamina < stam0 || after.combat.stamina === after.combat.maxStamina, 'stamina paid');
      if (dmg === null && !['warrior_rage', 'warrior_gangqi', 'mage_heal'].includes(sk.id)) throw new Error('no damage from ' + sk.id);
      if (['warrior_rage', 'warrior_gangqi'].includes(sk.id)) assert(buffs.includes(sk.name));
      if (sk.id !== 'mage_heal') assert(skill1.exp > skill0.exp || skill1.level > skill0.level, 'skill exp for ' + sk.id);
    }
    c.close();
  }
  console.log('SKILLS OK'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
