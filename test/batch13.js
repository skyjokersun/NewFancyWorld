'use strict';
// Thirteenth batch: uploaded models (monster / player / projectile), new profession taken
// at the 转职神父, admin-made skill cast by a player and by a monster, monster fields,
// original-table affixes and the element formula.
// node test/batch13.js [ws url] [admin port] [fixture dir with mon.zip ply.zip arrow.ale]
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { TestClient, OP } = require('./client');
const url = process.argv[2] || 'ws://127.0.0.1:8090/ws';
const adminPort = Number(process.argv[3] || 8091);
const fixtures = process.argv[4] || process.env.T13 || '';
const gamePort = Number(/:(\d+)\//.exec(url)[1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';
function admin(method, p, body, raw) {
  return new Promise((res, rej) => {
    const data = raw || (body ? JSON.stringify(body) : null);
    const req = http.request({ host: '127.0.0.1', port: adminPort, path: '/api/' + p, method, headers: Object.assign({ 'Content-Type': raw ? 'application/octet-stream' : 'application/json', Cookie: cookie }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, (r) => {
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => {
        if (r.headers['set-cookie']) cookie = r.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
        const buf = Buffer.concat(chunks);
        if (/image\/png/.test(r.headers['content-type'] || '')) return res(buf);
        const j = JSON.parse(buf.toString('utf8') || '{}');
        if (r.statusCode >= 400) rej(new Error(p + ': ' + (j.error || r.statusCode))); else res(j);
      });
    });
    req.on('error', rej); if (data) req.write(data); req.end();
  });
}
function get(p) {
  return new Promise((res, rej) => http.get({ host: '127.0.0.1', port: gamePort, path: p }, (r) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(c) })); }).on('error', rej));
}
async function newChar(tag) {
  const c = new TestClient(url); await c.open(); await c.wait(OP.CONNECT);
  const email = tag + Date.now() + '@example.com';
  c.send(OP.ACCOUNT_EMAIL_CODE_REQUEST, { email, purpose: 'register' });
  const code = /(\d{6})/.exec((await c.wait(OP.ACCOUNT_EMAIL_CODE_RESULT)).data.message)[1];
  c.send(OP.ACCOUNT_REGISTER, { email, password: 'password123', code, purpose: 'register' }); await c.wait(OP.ACCOUNT_REGISTER_RESULT);
  c.send(OP.LOGIN, { username: email, password: 'password123' }); await c.wait(OP.LOGIN_SUCCESS);
  c.nick = tag + String(Date.now()).slice(-6);
  c.send(OP.CHARACTER_CREATE, { nickname: c.nick, appearance: { gender: 'man' } }); await c.wait(OP.CHARACTER_CREATE_RESULT);
  c.me = (await c.wait(OP.LOGIN_SUCCESS)).data.playerId;
  c.chat = (m) => c.send(OP.CHAT, { channel: 'world', message: m });
  c.state = async () => { c.send(OP.ITEM_QUERY, {}); return (await c.wait(OP.ITEM_STATE)).data; };
  c.ext = (kind, d) => c.send(7100, Object.assign({ kind }, d || {}));
  c.st = (kind, pred, ms) => c.wait(7110, (d) => d.kind === kind && (!pred || pred(d)), ms).then((m) => m.data);
  return c;
}

(async () => {
  // Pure checks first: element formula and official affix rows.
  const { SceneCombat: Combat } = require('../src/game/combat');
  const cut = (r, e) => Combat.prototype.elementCut.call({ server: { config: { elementResistCap: 75 } }, config: { elementResistCap: 75 } }, r, e);
  console.log('element cut 50% ->', cut({ fire: 50 }, 'fire'), ' 90% ->', cut({ fire: 90 }, 'fire')); assert.strictEqual(cut({ fire: 50 }, 'fire'), 0.5); assert.strictEqual(cut({ fire: 90 }, 'fire'), 0.25);
  const AF = require('../src/game/affixes');
  console.log('official prefixes', Object.keys(AF.OFFICIAL_PREFIX).length, 'suffixes', Object.keys(AF.OFFICIAL_SUFFIX).length);
  assert(Object.keys(AF.OFFICIAL_PREFIX).length > 100);

  const pw = fs.readFileSync(path.join(__dirname, '..', 'admin-password.txt'), 'utf8').split('\n').find((l) => l.trim() && !l.startsWith('#')).trim();
  await admin('POST', 'login', { password: pw });

  // Original monster data now filled in (resists / element attack / unplaced originals).
  const mv = await admin('GET', 'monsters');
  const keys = mv.fields.map((f) => f.key || f[0]);
  console.log('monster fields:', keys.join(','));
  for (const k of ['fireAttack', 'projectile', 'projectileSpeed', 'skill', 'model', 'attackRange']) assert(keys.includes(k), 'field ' + k);
  const unplaced = mv.monsters.filter((m) => m.unplaced);
  console.log('monsters', mv.monsters.length, 'unplaced originals', unplaced.length);
  console.log('  ', unplaced.map((m) => m.name + '/' + m.model).join(' ')); assert(unplaced.length > 0);
  const withRes = mv.monsters.filter((m) => m.stats && (m.stats.fireResist || m.stats.iceResist || m.stats.thunderResist || m.stats.poisonResist));
  console.log('monsters with resists', withRes.length); assert(withRes.length > 10);

  // Uploads.
  if (!fixtures) { console.log('no fixture dir: skipping uploads'); console.log('batch13 ok (partial)'); process.exit(0); }
  const mon = await admin('POST', 'upload/monster?name=mon.zip&model=testleo&label=' + encodeURIComponent('测试狮'), null, fs.readFileSync(path.join(fixtures, 'mon.zip')));
  console.log(mon.done[0], JSON.stringify(mon.upload.missing));
  assert.strictEqual(mon.upload.model, 'u_testleo');
  const ply = await admin('POST', 'upload/player?name=ply.zip&model=testman&label=' + encodeURIComponent('测试人'), null, fs.readFileSync(path.join(fixtures, 'ply.zip')));
  console.log(ply.done[0]);
  const prj = await admin('POST', 'upload/projectile?name=arrow.ale&model=testarrow', null, fs.readFileSync(path.join(fixtures, 'arrow.ale')));
  console.log(prj.done[0]);
  let bad = null; try { await admin('POST', 'upload/projectile?name=x.ale', null, Buffer.from('ALEnonsense-file')); } catch (e) { bad = e.message; } console.log('bad ale:', bad); assert(bad);

  // Served where the client looks, and listed in the manifest.
  const stand = await get('/cdn_dump/named/charactor/enemy/u_testleo/stand.ale');
  assert.strictEqual(stand.status, 200); assert(stand.body.equals(fs.readFileSync(path.join(fixtures, 'leo_stand.ale'))));
  const fb = await get('/cdn_dump/named/charactor/enemy/u_testleo/run.ale'); assert.strictEqual(fb.status, 200, 'run falls back to walk');
  const ps = await get('/cdn_dump/named/charactor/women/u_testman/stand.ale'); assert.strictEqual(ps.status, 200, 'shared set for women');
  const pj = await get('/cdn_dump/named/projectile/u_testarrow.ale'); assert.strictEqual(pj.status, 200);
  const man = JSON.parse((await get('/asset-manifest.json')).body.toString('utf8'));
  const manText = JSON.stringify(man);
  assert(manText.includes('charactor/enemy/u_testleo/stand.ale') && manText.includes('projectile/u_testarrow.ale'), 'manifest lists uploads');
  const png = await admin('GET', 'upload-preview/u_testleo?kind=monster&action=stand');
  assert(Buffer.isBuffer(png) && png.slice(1, 4).toString() === 'PNG'); console.log('preview png', png.length, 'bytes');

  // Monster uses the uploaded model and projectile.
  const target = mv.monsters.find((m) => !m.unplaced && m.stats.level <= 5 && (m.maps || []).length) || mv.monsters[0];
  const opts = (await admin('GET', 'monsters')).fields.find((f) => (f.key || f[0]) === 'projectile');
  assert(JSON.stringify(opts).includes('u_testarrow'), 'uploaded projectile offered');
  const sm = await admin('POST', 'monster/' + target.monsterId, { stats: Object.assign({}, target.stats, { model: 'u_testleo', projectile: 'u_testarrow', attackRange: 300, fireAttack: 25 }) });
  console.log('set monster:', JSON.stringify(sm.done));
  let inUse = null; try { await admin('POST', 'upload/monster/delete?item=u_testleo', {}); } catch (e) { inUse = e.message; } console.log('delete in use:', inUse); assert(inUse);

  // New skill.
  const sk = await admin('POST', 'custom-skill/new', { name: '测试火雨', owner: 'warrior', kind: 'point', element: 'fire', projectileKey: 'u_testarrow', hpFormula: 'attack*150%+slevel*10', armorFormula: 'breakPower', mpFormula: '5', learn: 'book', level: 1, price: 100, range: 500, radius: 120 });
  console.log(sk.done[0]);
  const skill = sk.view.list.find((s) => s.name === '测试火雨'); assert(skill && skill.bookId);
  const tr = await admin('POST', 'custom-skill/test', { name: '试', owner: 'warrior', hpFormula: 'attack*2', armorFormula: 'breakPower', mpFormula: '3' }); console.log(tr.done[0]);
  let fe = null; try { await admin('POST', 'custom-skill/test', { name: '坏', owner: 'warrior', hpFormula: 'attack*(' }); } catch (e) { fe = e.message; } assert(fe); console.log('bad formula:', fe);
  const extra = JSON.parse((await get('/api/extra-items')).body.toString('utf8'));
  assert(JSON.stringify(extra).includes(String(skill.bookId)), 'book in client item list');

  // New profession with the uploaded model, taken at the 转职神父.
  const pv = await admin('GET', 'professions');
  const made = await admin('POST', 'profession/new', { name: '测试骑士', base: 'warrior', formulas: pv.original.warrior, model: 'u_testman', jobLevel: 5, open: true });
  console.log(made.done[0]);
  const cp = made.view.list.find((x) => x.name === '测试骑士'); assert(cp && cp.model === 'u_testman');
  const c = await newChar('t13');
  c.chat('/prof warrior'); c.chat('/level 3'); await sleep(400);
  c.ext('custom_job', { id: cp.id }); console.log('away from priest:', (await c.st('custom_jobs', (d) => d.message)).message);
  c.drain(); c.chat('/go job_fight'); await c.wait(OP.MAP_SWITCH_RESULT);
  c.ext('custom_job_query'); const q = await c.st('custom_jobs', (d) => d.list);
  console.log('priest list:', q.list.map((x) => x.name + '/' + x.jobLevel).join(','), 'level', q.level);
  assert(q.list.some((x) => x.id === cp.id));
  c.ext('custom_job', { id: cp.id }); const low = (await c.st('custom_jobs', (d) => d.message)).message; console.log('too low:', low); assert(/5/.test(low));
  c.chat('/level 10'); await sleep(400);
  c.drain();
  c.ext('custom_job', { id: cp.id }); const okm = await c.st('custom_jobs', (d) => d.message); console.log('change:', okm.message); assert(okm.ok);
  const st = await c.state();
  console.log('model after change:', st.params.appearance && st.params.appearance.model, 'profession', st.params.profession);
  assert.strictEqual((st.params.appearance || {}).model, 'u_testman');

  // Learn and cast the new skill on a monster.
  c.chat('/item ' + skill.bookId); await sleep(400);
  let s2 = await c.state();
  const bi = s2.inventory.slots.findIndex((it) => it && it.itemId === skill.bookId); assert(bi >= 0, 'got book');
  c.send(OP.ITEM_USE, { fromIndex: bi }); await sleep(400);
  s2 = await c.state();
  const learned = s2.params.professionSkills.find((s) => s.id === skill.id); assert(learned, 'learned custom skill');
  console.log('learned:', learned.id, learned.name, 'cost', learned.mpCost, 'type', learned.attackType, 'proj', learned.projectileKey);
  let m = null; let ref = null;
  for (const r of ['hunt_p_01', 'hunt_p_02', 'hunt_p_03']) {
    c.drain(); c.chat('/go ' + r); const snap = (await c.wait(OP.MAP_SWITCH_RESULT)).data;
    m = (snap.enemies || []).find((e) => e.state !== 'dead' && e.hp > 0); if (m) { ref = r; break; }
  }
  c.chat('/go ' + ref + ' ' + Math.round(m.x - 150) + ' ' + Math.round(m.y)); const at = (await c.wait(OP.MAP_SWITCH_RESULT)).data;
  const me = at.players.find((p) => p.playerId === c.me);
  c.chat('/heal'); await sleep(200); c.drain();
  c.send(OP.ACTION, { action: { type: 'attack', attackPhase: 'fire', skillId: learned.id, x: me.x, y: me.y, seq: 50, timestamp: Date.now(), aimX: m.x, aimY: m.y, chargeRatio: 1, attackType: learned.attackType } });
  const r = await c.wait(OP.ATTACK_RESULT, (d) => d.attackerId === c.me, 4000).catch(() => null);
  console.log('custom skill hit:', r ? JSON.stringify({ dmg: r.data.damage, skill: r.data.skillId }) : 'NONE');
  assert(r, 'custom skill dealt damage');
  c.close();

  // Clean up.
  await admin('POST', 'monster/' + target.monsterId, { reset: true });
  await admin('POST', 'custom-skill/' + skill.id + '/delete', {});
  await admin('POST', 'profession/' + cp.id + '/delete', {});
  for (const [k, id] of [['monster', 'u_testleo'], ['player', 'u_testman'], ['projectile', 'u_testarrow']]) {
    const d = await admin('POST', 'upload/' + k + '/delete?item=' + id, {}); console.log(d.done[0]);
  }
  assert.strictEqual((await get('/cdn_dump/named/projectile/u_testarrow.ale')).status, 404);
  console.log('batch13 ok'); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
