'use strict';
// Protocol test for the craftsman chain: mining -> smelting -> forging ->
// fusion -> mystic smith / workbench repair, plus the material shop.
const assert = require('assert');
const { TestClient, OP } = require('./client');
const { targetAt, DURATION_MS } = require('../src/features/crafting/forge');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
const MINING_REQ = 5500; const MINING_STATE = 5510;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  const email = 'cr' + Date.now() + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' });
  await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123' }); await c.wait(OP.LOGIN_SUCCESS);
  c.send(OP.CHARACTER_CREATE, { nickname: 'C' + String(Date.now()).slice(-6), appearance: { gender: 'man' } });
  await c.wait(OP.CHARACTER_CREATE_RESULT); await c.wait(OP.LOGIN_SUCCESS);
  const chat = (m) => c.send(OP.CHAT, { channel: 'world', message: m });
  chat('/level 30'); chat('/prof craftsman'); chat('/gold 100000');
  await sleep(300);
  let inv = null;
  const items = async () => { c.send(OP.ITEM_QUERY, {}); inv = (await c.wait(OP.ITEM_STATE)).data.inventory.slots; return inv; };
  const find = (id) => inv.findIndex((it) => it && it.itemId === id);

  // ---- mining ----
  chat('/go mine_01'); await c.wait(OP.MAP_SWITCH_RESULT);
  let rid = 1;
  const mine = async (action, lodeId, kind = null) => {
    c.send(MINING_REQ, { action, lodeId, requestId: ++rid });
    return (await c.wait(MINING_STATE, (m) => !kind || m.kind === kind, 8000)).data;
  };
  let snap = await mine('sync', null, 'snapshot');
  const lode = snap.lodes.find((l) => l.active);
  console.log('lodes', snap.lodes.filter((l) => l.active).length, 'first', lode.id, lode.x, lode.y);
  chat('/go mine_01 ' + lode.x + ' ' + lode.y); await c.wait(OP.MAP_SWITCH_RESULT);
  let r = await mine('prospect', lode.id, 'result');
  console.log('prospect', r.ok, r.message);
  for (let i = 0; i < 6 && !r.ok; i += 1) { r = await mine('prospect', lode.id, 'result'); console.log('prospect again', r.ok, r.message); }
  r = await mine('build', lode.id, 'result'); console.log('build', r.ok, r.message); assert(r.ok, 'build');
  let ores = 0;
  for (let i = 0; i < 40 && ores < 3; i += 1) {
    r = await mine('dig', lode.id, 'result');
    if (r.resultCode === 1) { const s = await mine('save', lode.id, 'result'); ores += s.ok ? 1 : 0; } else if (r.resultCode === 4) await mine('reset', lode.id, 'result');
    else if (r.resultCode === 6) break;
  }
  console.log('ores mined', ores); assert(ores > 0);
  r = await mine('teardown', lode.id, 'result'); console.log('teardown', r.ok);
  const info = await mine('info', null, 'info'); console.log('mining info', info.mining.level, info.mining.title, info.ores.map((o) => o.name + o.level).join(' '));

  // ---- smelting ----
  chat('/item 2689 6'); chat('/go smelt'); await c.wait(OP.MAP_SWITCH_RESULT);
  await sleep(200); await items();
  c.send(OP.ORE_SMELTING_OPEN, { furnaceId: 'bad' }); console.log('bad furnace:', (await c.wait(OP.ORE_SMELTING_ERROR)).data.message);
  const { MapRegistry } = require('../src/game/map'); const cfg = require('../src/config');
  const doc = new MapRegistry(cfg.dataDir).rawDoc('smelt');
  const furnace = doc.decor.find((d) => d.tag === 'furnace');
  c.send(OP.ORE_SMELTING_OPEN, { furnaceId: Math.round(furnace.x) + ':' + Math.round(furnace.y) });
  let sm = (await c.wait(OP.ORE_SMELTING_STATE)).data;
  c.send(OP.ORE_SMELTING_SELECT, { sessionId: sm.sessionId, inventoryIndex: find(2689) }); sm = (await c.wait(OP.ORE_SMELTING_STATE)).data;
  c.send(OP.ORE_SMELTING_HEAT, { sessionId: sm.sessionId }); sm = (await c.wait(OP.ORE_SMELTING_STATE)).data;
  c.send(OP.ORE_SMELTING_FINISH, { sessionId: sm.sessionId }); r = (await c.wait(OP.ORE_SMELTING_RESULT)).data; console.log('early finish', r.success, r.message);
  c.send(OP.ORE_SMELTING_RENEW, { sessionId: sm.sessionId }); sm = (await c.wait(OP.ORE_SMELTING_STATE, (m) => m.phase === 'idle')).data;
  c.send(OP.ORE_SMELTING_HEAT, { sessionId: sm.sessionId }); sm = (await c.wait(OP.ORE_SMELTING_STATE, (m) => m.phase === 'heating')).data;
  await sleep((4000 - sm.temperature) / sm.temperatureRate * 1000);
  c.send(OP.ORE_SMELTING_FINISH, { sessionId: sm.sessionId }); r = (await c.wait(OP.ORE_SMELTING_RESULT)).data; console.log('smelt', r.success, r.message);
  assert(r.success);

  // ---- forge ----
  chat('/item 2698 10'); chat('/item 2707 2'); chat('/go smith'); await c.wait(OP.MAP_SWITCH_RESULT);
  await sleep(200); await items();
  c.send(OP.SMITH_FORGE_OPEN, { interaction: 'smith_bunk' });
  let fs = (await c.wait(OP.SMITH_FORGE_STATE)).data;
  const recipe = fs.recipes.find((x) => x.unlocked && x.materials.every((m) => [2698, 2707].includes(m.itemId)));
  console.log('recipes', fs.recipes.length, 'pick', recipe.name, JSON.stringify(recipe.materials));
  c.send(OP.SMITH_FORGE_SELECT, { sessionId: fs.sessionId, recipeId: recipe.itemId }); fs = (await c.wait(OP.SMITH_FORGE_STATE)).data;
  console.log('placed', fs.placedMaterials.slice(0, 3).map((m) => m.item && m.item.name + 'x' + m.item.count).join(','));
  // Play the four stages with a simple bang-bang controller on the shared model.
  let seq = 0; let heating = true;
  c.send(OP.SMITH_FORGE_INPUT, { sessionId: fs.sessionId, inputSeq: ++seq, heating: true });
  fs = (await c.wait(OP.SMITH_FORGE_STATE, (m) => m.gameStartedAt != null)).data;
  const model = { targets: fs.temperatureTargets, drifts: fs.temperatureDrifts, phases: fs.temperaturePhases };
  const t0 = Date.now(); let temp = fs.temperature; let last = t0;
  while (Date.now() - t0 < DURATION_MS + 100) {
    await sleep(40);
    const now = Date.now();
    temp = Math.max(20, Math.min(5000, temp + (heating ? 1150 : -820) * (now - last) / 1000)); last = now;
    const want = temp < targetAt(model, now - t0 + 60);
    if (want !== heating) { heating = want; c.send(OP.SMITH_FORGE_INPUT, { sessionId: fs.sessionId, inputSeq: ++seq, heating }); }
  }
  c.send(OP.SMITH_FORGE_FINISH, { sessionId: fs.sessionId });
  r = (await c.wait(OP.SMITH_FORGE_RESULT)).data; console.log('forge', r.success, r.message, r.progressionMessages.join(' '));
  c.send(OP.SMITH_FORGE_CLOSE, { sessionId: fs.sessionId });

  // ---- fusion ----
  chat('/item 2305 1'); chat('/item 1665 1'); await sleep(200); await items();
  const equipIdx = inv.findIndex((it) => it && it.itemId === recipe.itemId) >= 0 ? inv.findIndex((it) => it && it.itemId === recipe.itemId) : inv.findIndex((it) => it && it.durability && it.durability.max > 1);
  c.send(OP.SMITH_FUSION_OPEN, { interaction: 'smith_bunk' }); let fu = (await c.wait(OP.SMITH_FUSION_STATE)).data;
  for (const [slot, i] of [['equipment', equipIdx], ['prefix', find(2305)], ['attribute', find(1665)]]) {
    c.send(OP.SMITH_FUSION_SELECT, { sessionId: fu.sessionId, slot, inventoryIndex: i }); fu = (await c.wait(OP.SMITH_FUSION_STATE)).data;
  }
  c.send(OP.SMITH_FUSION_HEAT, { sessionId: fu.sessionId }); fu = (await c.wait(OP.SMITH_FUSION_STATE)).data;
  await sleep((750 - fu.temperature) / fu.temperatureRate * 1000);
  c.send(OP.SMITH_FUSION_FINISH, { sessionId: fu.sessionId });
  const fr = await c.wait(OP.SMITH_FUSION_RESULT, () => true, 4000).catch(async () => (await c.wait(OP.SMITH_FUSION_ERROR)));
  console.log('fusion', JSON.stringify({ success: fr.data.success, message: fr.data.message, chance: fr.data.successChance, item: fr.data.item && fr.data.item.name }));
  c.send(OP.SMITH_FUSION_INFO_REQUEST, { interaction: 'smith_info_stage', requestId: 9 });
  const fi = (await c.wait(OP.SMITH_FUSION_INFO)).data; console.log('info tiers', fi.tiers.length, fi.forging.tiers.length, fi.skill.level, fi.forging.skill.totalExp);

  // ---- workbench repair ----
  chat('/wear 3'); await sleep(200); await items();
  const worn = inv.findIndex((it) => it && it.durability && it.durability.cur < it.durability.max);
  c.send(OP.MYSTIC_SMITH_OPEN, { artisan: { id: 'craftsman_workbench', name: '工匠工作台' } }); let ms = (await c.wait(OP.MYSTIC_SMITH_STATE)).data;
  c.send(OP.MYSTIC_SMITH_SELECT, { sessionId: ms.sessionId, inventoryIndex: worn }); ms = (await c.wait(OP.MYSTIC_SMITH_STATE)).data;
  console.log('workbench quote', ms.selection.quoteKb, ms.selection.item.durability);
  c.send(OP.MYSTIC_SMITH_REPAIR, { sessionId: ms.sessionId, offerKb: ms.selection.quoteKb }); r = (await c.wait(OP.MYSTIC_SMITH_RESULT)).data; console.log('repair', r.outcome, r.message);

  // ---- material shop ----
  c.send(OP.SHOP_QUERY, { kind: 'tools' }); const shop = (await c.wait(OP.SHOP_STATE)).data;
  console.log('shop', shop.catalogId, shop.tabs.misc.length, shop.items.length); assert.strictEqual(shop.catalogId, 'craftsman_materials');
  c.send(OP.SHOP_BUY, { kind: 'tools', itemId: 2707, count: 2 }); await sleep(300);

  // ---- mystic NPC affix removal ----
  chat('/go smith2'); await c.wait(OP.MAP_SWITCH_RESULT); await sleep(200); await items();
  const affixed = inv.findIndex((it) => it && it.ext && it.ext.affix && (it.ext.affix.prefix || it.ext.affix.suffix));
  c.drain(); c.send(OP.MYSTIC_SMITH_OPEN, { artisan: { id: '莫邪-4', name: '莫邪', level: 4 } }); ms = (await c.wait(OP.MYSTIC_SMITH_STATE, (m) => m.mode === 'npc')).data;
  if (affixed >= 0) {
    c.send(OP.MYSTIC_SMITH_SELECT, { sessionId: ms.sessionId, inventoryIndex: affixed }); ms = (await c.wait(OP.MYSTIC_SMITH_STATE, (m) => !!m.selection)).data;
    console.log('affixes', JSON.stringify(ms.selection.affixes));
    const part = ms.selection.affixes.prefix.present ? 'remove_prefix' : 'remove_suffix';
    c.send(OP.MYSTIC_SMITH_REPAIR, { sessionId: ms.sessionId, action: part }); r = (await c.wait(OP.MYSTIC_SMITH_RESULT)).data; console.log('strip', r.message);
  } else console.log('no affixed item (fusion failed), skip strip');
  c.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
