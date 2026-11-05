'use strict';
// Twelfth batch protocol test: version, auto hunt unstuck / potions at full HP, fusion
// odds and proficiency, auto repair, closed maps, zones, admin items, drops, formulas.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { TestClient, OP } = require('./client');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
const adminPort = Number(process.argv[3] || 8091);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
function admin(method, p, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: adminPort, path: '/api/' + p, method, headers: Object.assign({ 'Content-Type': 'application/json', Cookie: cookie }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, (r) => {
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => {
        if (r.headers['set-cookie']) cookie = r.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
        const txt = Buffer.concat(chunks).toString('utf8');
        let j; try { j = JSON.parse(txt); } catch (e) { j = { raw: txt }; }
        if (r.statusCode >= 400) rej(new Error(p + ': ' + (j.error || r.statusCode))); else res(j);
      });
    });
    req.on('error', rej); if (data) req.write(data); req.end();
  });
}

async function newPlayer(tag, serverId) {
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  const email = tag + Date.now() + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' });
  await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, Object.assign({ username: email, password: 'password123' }, serverId ? { serverId } : {}));
  await c.wait(OP.LOGIN_SUCCESS);
  c.send(OP.CHARACTER_CREATE, { nickname: tag.slice(0, 3) + String(Date.now()).slice(-7), appearance: { gender: 'man' } });
  await c.wait(OP.CHARACTER_CREATE_RESULT); await c.wait(OP.LOGIN_SUCCESS);
  c.email = email;
  c.chat = (m) => c.send(OP.CHAT, { channel: 'world', message: m });
  c.ext = (kind, d) => c.send(7100, Object.assign({ kind }, d || {}));
  c.state = async () => { c.send(OP.ITEM_QUERY, {}); return (await c.wait(OP.ITEM_STATE)).data; };
  return c;
}

(async () => {
  const pw = fs.readFileSync(path.join(__dirname, '..', 'admin-password.txt'), 'utf8').split('\n').find((l) => l.trim() && !l.startsWith('#')).trim();
  await admin('POST', 'login', { password: pw });

  const c = await newPlayer('b12');
  const ver = await c.wait(7110, (d) => d.kind === 'server_version');
  console.log('version', ver.data.patch);

  // Potions at full HP.
  c.chat('/item 72 3'); await sleep(300);
  let s = await c.state();
  const at = (st, id) => st.inventory.slots.findIndex((it) => it && it.itemId === id);
  c.queue.length = 0;
  c.send(OP.ITEM_USE, { fromIndex: at(s, 72) });
  await sleep(400);
  s = await c.state();
  const left = s.inventory.slots.filter((it) => it && it.itemId === 72).reduce((n, it) => n + it.count, 0);
  console.log('potion at full hp, left', left); assert.strictEqual(left, 2);

  // Fusion: repair with craft proficiency, and auto repair.
  c.chat('/level 12'); c.chat('/prof craftsman'); c.chat('/item 602 1'); await sleep(400);
  c.chat('/go smith'); await sleep(800);
  s = await c.state();
  c.send(OP.SMITH_FUSION_OPEN, {});
  let st = (await c.wait(OP.SMITH_FUSION_STATE)).data;
  c.send(OP.SMITH_FUSION_SELECT, { sessionId: st.sessionId, slot: 'equipment', inventoryIndex: at(s, 602) });
  st = (await c.wait(OP.SMITH_FUSION_STATE)).data;
  c.send(OP.SMITH_FUSION_COOL, { sessionId: st.sessionId });
  let err = (await c.wait(OP.SMITH_FUSION_ERROR)).data; console.log('cool at 20:', err.message);
  c.send(OP.SMITH_FUSION_FINISH, { sessionId: st.sessionId });
  err = (await c.wait(OP.SMITH_FUSION_ERROR)).data; console.log('finish cold:', err.message);
  assert(/火候不对/.test(err.message));
  c.queue.length = 0;
  c.ext('auto_repair', { on: true });
  let ar = (await c.wait(7110, (d) => d.kind === 'auto_repair')).data; console.log('auto repair:', ar.on, ar.message);
  assert.strictEqual(ar.on, true);
  ar = (await c.wait(7110, (d) => d.kind === 'auto_repair' && d.done >= 1, 12000)).data;
  console.log('auto repair round', ar.done, 'ok', ar.ok);
  c.ext('auto_repair', { on: false });
  ar = (await c.wait(7110, (d) => d.kind === 'auto_repair' && !d.on)).data; console.log('stopped:', ar.message);

  // Closed map.
  await admin('POST', 'map-open/square_in', { open: false });
  c.chat('/go square'); await sleep(800);
  c.send(OP.MAP_SWITCH, { mapRef: 'square_in', clientSeq: 5 });
  const sw = await c.wait(OP.MAP_SWITCH_RESULT, (d) => d.clientSeq === 5);
  console.log('closed map:', sw.data.success, sw.data.dropMessage);
  await admin('POST', 'map-open/square_in', { open: true });

  // Zones.
  const z = await admin('GET', 'zones');
  console.log('zones', z.zones.map((x) => x.name + (x.open ? '开' : '关')).join(' '));
  const c2 = new TestClient(url); await c2.open(); await c2.wait(OP.CONNECT);
  c2.send(OP.LOGIN, { username: c.email, password: 'password123', serverId: 'east' });
  const lf = await c2.waitAny([OP.LOGIN_FAILED, OP.LOGIN_SUCCESS]);
  console.log('closed zone login:', lf.name, lf.data.message); assert.strictEqual(lf.opCode, OP.LOGIN_FAILED);
  c2.close();

  // Admin items: a new potion with two effects.
  const ni = await admin('POST', 'item-admin/new', { kind: 'medicine', name: '测试双效药', desc: '回血又回精', buyPrice: 10, sellPrice: 5, weight: 1, bonusAttrs: [{ key: 'restoreHp', value: 50 }, { key: 'restoreStamina', value: 30 }] });
  console.log(ni.done[0]);
  const extra = await new Promise((res) => http.get('http://127.0.0.1:' + url.split(':')[2].split('/')[0] + '/api/extra-items', (r) => { const b = []; r.on('data', (x) => b.push(x)); r.on('end', () => res(JSON.parse(Buffer.concat(b)))); }));
  assert(extra.some((t) => t.itemId === ni.id), 'client gets the new item');
  c.chat('/item ' + ni.id + ' 2'); await sleep(300);
  s = await c.state(); assert(at(s, ni.id) >= 0, 'new item in bag');
  // Edit an original item.
  await admin('POST', 'item-admin/70', { name: '止血粉改', sellPrice: 9 });
  const det = await admin('GET', 'item-admin/70'); console.log('edited 70:', det.name, det.sellPrice);
  await admin('POST', 'item-admin/70/delete', {});
  await admin('POST', 'item-admin/' + ni.id + '/delete', {});

  // Drops and formulas.
  const mons = await admin('GET', 'monsters');
  const mid = mons.monsters[0].monsterId;
  const dv = await admin('POST', 'monster-drops/' + encodeURIComponent(mid), { drops: [{ type: 'gold', chance: 100, minCount: 5, maxCount: 9 }, { type: 'item', itemId: 70, chance: 50, minCount: 1, maxCount: 2 }] });
  console.log(dv.done[0]);
  await admin('POST', 'monster-drops/' + encodeURIComponent(mid), { reset: true });
  const fv = await admin('GET', 'formulas'); console.log('formula set in use:', fv.active);
  assert.strictEqual(fv.active, 'original');
  const t = await admin('POST', 'formula-test', { set: Object.assign({}, fv.sets[1].set, { name: '测试' }) });
  console.log('sample warrior', JSON.stringify(t.sample.warrior));
  let bad = null; try { await admin('POST', 'formula-test', { set: { name: 'x', overweightPercent: 90, groups: Object.assign({}, fv.sets[1].set.groups, { warrior: Object.assign({}, fv.sets[1].set.groups.warrior, { attack: 'S + process' }) }) } }); } catch (e) { bad = e.message; }
  console.log('bad formula:', bad); assert(bad);

  console.log('batch12 ok'); c.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
