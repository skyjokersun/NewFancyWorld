'use strict';
// UI test, thirteenth batch: an uploaded monster model with an uploaded projectile, a new
// profession with an uploaded player model taken at the 转职神父, and a new skill cast.
// T13=<dir with mon.zip ply2.zip arrow.ale> node test/ui/batch13.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const { prepareAccount, openGame, OP } = require('./session');
const fixtures = process.env.T13;
const adminPort = Number(process.env.ADMIN_PORT || 8091);
let cookie = '';
function admin(method, p, body, raw) {
  return new Promise((res, rej) => {
    const data = raw || (body ? JSON.stringify(body) : null);
    const req = http.request({ host: '127.0.0.1', port: adminPort, path: '/api/' + p, method, headers: Object.assign({ 'Content-Type': raw ? 'application/octet-stream' : 'application/json', Cookie: cookie }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, (r) => {
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => {
        if (r.headers['set-cookie']) cookie = r.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
        const j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (r.statusCode >= 400) rej(new Error(p + ': ' + (j.error || r.statusCode))); else res(j);
      });
    });
    req.on('error', rej); if (data) req.write(data); req.end();
  });
}

(async () => {
  const pw = fs.readFileSync(path.join(__dirname, '..', '..', 'admin-password.txt'), 'utf8').split('\n').find((l) => l.trim() && !l.startsWith('#')).trim();
  await admin('POST', 'login', { password: pw });
  for (const s of (await admin('GET', 'custom-skills')).list) if (s.name === '界面火雨') await admin('POST', 'custom-skill/' + s.id + '/delete', {});
  for (const c of (await admin('GET', 'professions')).list) if (c.name === '界面法剑') await admin('POST', 'profession/' + c.id + '/delete', {});
  await admin('POST', 'upload/monster?name=mon.zip&model=uileo', null, fs.readFileSync(path.join(fixtures, 'mon.zip')));
  await admin('POST', 'upload/player?name=ply2.zip&model=uimage', null, fs.readFileSync(path.join(fixtures, 'ply2.zip')));
  await admin('POST', 'upload/projectile?name=arrow.ale&model=uiarrow', null, fs.readFileSync(path.join(fixtures, 'arrow.ale')));
  const mv = await admin('GET', 'monsters');
  const bf = mv.monsters.find((m) => m.monsterId === 'original_101');
  console.log((await admin('POST', 'monster/original_101', { stats: Object.assign({}, bf.stats, { model: 'u_uileo', projectile: 'u_uiarrow', attackRange: 260, detectionRange: 600, damage: 3, fireAttack: 5 }) })).done);
  const sk = await admin('POST', 'custom-skill/new', { name: '界面火雨', owner: 'warrior', kind: 'volley', count: 5, spreadDeg: 50, element: 'fire', projectileKey: 'u_uiarrow', hpFormula: 'attack*120%', mpFormula: '2', learn: 'level', level: 1, range: 500 });
  const skill = sk.view.list.find((s) => s.name === '界面火雨'); console.log(sk.done[0]);
  const pv = await admin('GET', 'professions');
  const made = await admin('POST', 'profession/new', { name: '界面法剑', base: 'warrior', formulas: pv.original.warrior, model: 'u_uimage', jobLevel: 5, open: true });
  const cp = made.view.list.find((x) => x.name === '界面法剑'); console.log(made.done[0]);

  const acct = await prepareAccount({ profession: 'warrior', level: 10, world: process.env.WORLD || 'west' });
  const g = await openGame(acct);
  await g.chat('/go job_fight'); await g.waitScene(); await g.wait(1500);
  // Click the priest the way the map does (decor tag ftchgjob).
  const clicked = await g.eval(() => { const c = globalThis.gameEntry.mapInteractiveController; return c ? String(c.handleDecorClick({ tag: 'ftchgjob' })) : 'no controller'; });
  console.log('priest click:', clicked);
  await g.wait(1500); await g.shot('130-priest-list');
  await g.eval((id) => globalThis.__QIYU_BATCH8_API__.send('custom_job', { id }), cp.id);
  await g.wait(2500); await g.shot('131-job-changed');
  const look = await g.eval(() => { const ge = globalThis.gameEntry; const a = ge.actorStates.get(ge.localPlayerId); return a && a.animator ? { role: a.animator.role || a.animator.rolePath || a.role, model: a.appearance && a.appearance.model } : null; });
  console.log('local actor:', JSON.stringify(look));
  const skills = await g.eval(() => { const ge = globalThis.gameEntry; const p = ge.playerParams || ge.localParams || ge.params; return p && p.professionSkills ? p.professionSkills.map((s) => s.id + ':' + s.name) : 'n/a'; });
  console.log('skills:', JSON.stringify(skills));

  // The butterfly now looks like the uploaded lion and shoots the uploaded arrow.
  await g.chat('/go hunt_p_01'); await g.waitScene(); await g.wait(1500);
  const target = await g.eval(() => {
    const ge = globalThis.gameEntry; const me = ge.actorStates.get(ge.localPlayerId);
    for (const [id, a] of ge.actorStates) if (id !== ge.localPlayerId && a.node && /u_uileo/.test(JSON.stringify(a.roleName || a.role || (a.animator && (a.animator.role || a.animator.rolePath)) || ''))) return { id, x: a.node.position.x, y: a.node.position.y, me: me && { x: me.node.position.x, y: me.node.position.y } };
    return { roles: [...ge.actorStates.values()].slice(0, 6).map((a) => a.roleName || a.role || (a.animator && (a.animator.role || a.animator.rolePath))) };
  });
  console.log('lion:', JSON.stringify(target));
  await g.shot('132-hunt-map');
  await g.chat('/go hunt_p_01 ' + Math.round(target.x - 220) + ' ' + Math.round(-target.y)); await g.waitScene(); await g.wait(800);
  await g.chat('/heal');
  const lion = await g.actorScreen(target.id); console.log('lion on screen', JSON.stringify(lion));
  for (let i = 0; i < 6; i += 1) { await g.wait(450); await g.shot('133-lion-attack-' + i); }
  const sk2 = await g.eval(() => (globalThis.gameEntry.localPlayerParams.professionSkills || []).map((s) => s.id + ':' + s.name + ':' + s.projectileKey));
  console.log('skills:', JSON.stringify(sk2));
  // Cast the new skill at the lion, as the hotbar does.
  const cast = await g.eval(([sid, tid]) => { const ge = globalThis.gameEntry; const a = ge.actorStates.get(tid); const p = a.node.position; try { return String(ge.withProfessionSkillAimOverride(new cc.Vec3(p.x, p.y, p.z), () => ge.castProfessionSkillById(sid))); } catch (e) { return 'err ' + e.message; } }, [skill.id, target.id]);
  console.log('cast:', cast);
  for (let i = 0; i < 5; i += 1) { await g.wait(250); await g.shot('134-skill-' + i); }
  const hp = await g.eval((tid) => { const a = globalThis.gameEntry.actorStates.get(tid); return a && a.currentHp + '/' + a.maxHp; }, target.id); console.log('lion hp after skill', hp);
  g.dumpLogs('batch13');
  fs.writeFileSync(process.env.SHOT_DIR + '/b13.json', JSON.stringify({ skill: skill.id, cp: cp.id }));
  await g.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
