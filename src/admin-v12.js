'use strict';
// Twelfth batch admin API. Each route answers through ctx.send and returns true; an
// unknown route returns false so admin.js goes on with its own.
const routes = [];
function route(kind, method, fn) { routes.push({ kind, method, fn }); }

// Maps and zones.
route('maps-open', 'GET', (game) => ({ maps: game.features.world.mapsView() }));
route('map-open', 'POST', async (game, ctx) => { const b = await ctx.readJson(ctx.req); return { done: [game.features.world.setMapOpen(ctx.id, !!b.open)] }; });
route('zones', 'GET', (game) => ({ zones: game.features.world.zonesView() }));
route('zone', 'POST', async (game, ctx) => { const b = await ctx.readJson(ctx.req); return { done: [game.features.world.setZoneOpen(ctx.id, !!b.open)], zones: game.features.world.zonesView() }; });

// Formula sets.
route('formulas', 'GET', (game) => game.features.formulas.view());
route('formula-active', 'POST', async (game, ctx) => ({ done: [game.features.formulas.setActive(String((await ctx.readJson(ctx.req)).id || ''))], view: game.features.formulas.view() }));
route('formula-test', 'POST', async (game, ctx) => ({ sample: game.features.formulas.test((await ctx.readJson(ctx.req)).set) }));
route('formula-save', 'POST', async (game, ctx) => { const b = await ctx.readJson(ctx.req); const r = game.features.formulas.save(b.id, b.set); return { done: ['已保存'], id: r.id, sample: r.sample, view: game.features.formulas.view() }; });
route('formula-delete', 'POST', async (game, ctx) => ({ done: [game.features.formulas.remove(ctx.id)], view: game.features.formulas.view() }));

// Drops per monster.
route('monster-drops', 'GET', (game, ctx) => game.features.balance.dropsView(ctx.id));
route('monster-drops', 'POST', async (game, ctx) => { const b = await ctx.readJson(ctx.req); return { done: game.features.balance.setDrops(ctx.id, b.reset ? null : b.drops), view: game.features.balance.dropsView(ctx.id) }; });

// Items (Q20, Q23).
route('item-admin', 'GET', (game, ctx) => (ctx.id ? game.features.itemAdmin.detail(ctx.id) : { items: game.features.itemAdmin.list(), meta: game.features.itemAdmin.meta() }));
route('item-admin', 'POST', async (game, ctx) => {
  const ia = game.features.itemAdmin; const b = await ctx.readJson(ctx.req, 256 * 1024);
  if (ctx.id === 'new') { const r = ia.create(b); return { done: [r.message], id: r.id, items: ia.list() }; }
  if (ctx.action === 'delete') return { done: [ia.remove(ctx.id)], items: ia.list() };
  if (ctx.action === 'disable') return { done: [ia.setDisabled(ctx.id, !!b.off)], items: ia.list() };
  if (ctx.action === 'icon') return { done: [ia.setIcon(ctx.id, b.png)] };
  return { done: [ia.save(ctx.id, b)], item: ia.detail(ctx.id), items: ia.list() };
});
route('profession-tags', 'POST', async (game, ctx) => { const b = await ctx.readJson(ctx.req); return { done: [game.features.itemAdmin.setProfessionTags(ctx.id, b.tags)], meta: game.features.itemAdmin.meta() }; });
route('item-icon', 'GET', (game, ctx) => {
  const png = game.features.itemAdmin.iconPng(ctx.id);
  if (!png) { ctx.res.writeHead(404); ctx.res.end(); return undefined; }
  ctx.res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); ctx.res.end(png); return undefined;
});

// Wedding and long-term team (婚礼与团队 tab).
route('social', 'GET', (game) => ({ couples: game.features.marriage.adminView(), teams: game.features.teams.adminView() }));
route('couple', 'POST', async (game, ctx) => {
  const b = await ctx.readJson(ctx.req);
  const m = game.features.marriage;
  const done = b.op === 'now' ? m.adminStartNow(ctx.id) : m.adminRemove(ctx.id);
  return { done: [done], couples: m.adminView() };
});
route('team', 'POST', async (game, ctx) => {
  const b = await ctx.readJson(ctx.req);
  return { done: [game.features.teams.adminAction(ctx.id, b)], teams: game.features.teams.adminView() };
});

// New professions, new monsters and uploads (新职业与上传 tab).
route('professions', 'GET', (game) => game.features.professions.view());
route('profession', 'POST', async (game, ctx) => {
  const b = await ctx.readJson(ctx.req);
  const pf = game.features.professions;
  let done;
  if (ctx.action === 'delete') done = pf.remove(ctx.id);
  else if (ctx.action === 'assign') done = pf.assign(b.name, b.clear ? null : ctx.id);
  else done = pf.save(ctx.id === 'new' ? null : ctx.id, b);
  return { done: [done], view: pf.view() };
});
route('custom-monsters', 'GET', (game) => {
  const bal = game.features.balance;
  return { models: bal.models(), monsters: bal.monstersView().filter((m) => !String(m.monsterId).startsWith('custom_')).map((m) => ({ monsterId: m.monsterId, name: m.name, model: m.model, level: m.stats.level })), custom: bal.customMonsters() };
});
route('custom-monster', 'POST', async (game, ctx) => {
  const b = await ctx.readJson(ctx.req);
  const bal = game.features.balance;
  const done = ctx.action === 'delete' ? bal.removeMonster(ctx.id) : bal.createMonster(b);
  return { done, custom: bal.customMonsters() };
});
// Thirteenth batch: admin-made skills.
route('custom-skills', 'GET', (game) => game.features.customSkills.view());
route('custom-skill', 'POST', async (game, ctx) => {
  const b = await ctx.readJson(ctx.req, 256 * 1024);
  const cs = game.features.customSkills;
  if (ctx.id === 'test') return { done: [cs.test(b)] };
  const done = ctx.action === 'delete' ? cs.remove(ctx.id) : cs.save(ctx.id === 'new' ? null : ctx.id, b);
  return { done: [done], view: cs.view() };
});
route('uploads', 'GET', (game) => ({ uploads: game.features.uploads.list() }));
route('upload-preview', 'GET', (game, ctx) => {
  const q = ctx.url.searchParams;
  const png = game.features.uploads.preview(q.get('kind'), ctx.id, q.get('action') || 'stand', q.get('gender'));
  if (!png) { ctx.res.writeHead(404); ctx.res.end(); return undefined; }
  ctx.res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); ctx.res.end(png); return undefined;
});
route('upload', 'POST', (game, ctx) => {
  const U = require('./features/uploads');
  if (ctx.action === 'delete') return ctx.readJson(ctx.req).then(() => ({ done: [game.features.uploads.remove(ctx.id, ctx.url.searchParams.get('item') || '')], uploads: game.features.uploads.list() }));
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    ctx.req.on('data', (c) => { size += c.length; if (size > U.MAX_BYTES) { reject(new Error('文件太大（最多 200MB）')); ctx.req.destroy(); } else chunks.push(c); });
    ctx.req.on('end', () => {
      try {
        const q = ctx.url.searchParams;
        const meta = game.features.uploads.save(ctx.id, q.get('name'), Buffer.concat(chunks), { model: q.get('model'), label: q.get('label') });
        resolve({ done: ['已上传 ' + meta.name + (meta.model ? '（造型名 ' + meta.model + '）' : '')], upload: meta, uploads: game.features.uploads.list() });
      } catch (e) { reject(e); }
    });
    ctx.req.on('error', reject);
  });
});

// Fifteenth batch (屠龙与卡片 tab): card drops, the drop overview, 屠龙, 大地龙, green gifts.
route('b15', 'GET', (game) => game.features.batch15.view());
route('b15', 'POST', async (game, ctx) => {
  const b = await ctx.readJson(ctx.req, 256 * 1024);
  const f = game.features.batch15;
  if (ctx.id === 'summon') return { done: [f.summon()], view: f.view() };
  if (ctx.id === 'dismiss') return { done: [f.dismiss()], view: f.view() };
  return { done: [f.save(ctx.id, b)], view: f.view() };
});
// V15.2 (限时活动 tab): Beijing clock, event schedules, double map, wear, element states,
// client notices, 美杜沙, festival gifts. POST b152/<action> with { key, ... }.
route('b152', 'GET', (game) => game.features.batch152.view());
route('b152', 'POST', async (game, ctx) => {
  const b = await ctx.readJson(ctx.req, 256 * 1024);
  const f = game.features.batch152;
  let done;
  if (ctx.id === 'event') done = f.saveEvent(String(b.key || ''), b);
  else if (ctx.id === 'manual') done = f.setManual(String(b.key || ''), b.on == null ? null : !!b.on);
  else if (ctx.id === 'part') done = f.savePart(String(b.key || ''), b);
  else if (ctx.id === 'resync') { await f.clock.sync(); const c = f.clock.view(); done = c.synced ? '对时成功：' + c.source : '对时失败，暂用本机时钟：' + c.error; }
  else throw new Error('不认识的操作');
  return { done: [done], view: f.view() };
});
route('drop-overview', 'GET', (game, ctx) => ({ rows: game.features.batch15.dropOverview(ctx.url.searchParams.get('q') || '') }));
route('drop-overview', 'POST', async (game, ctx) => {
  const b = await ctx.readJson(ctx.req);
  const f = game.features.batch15;
  return { done: [f.setDropChance(b.itemId, b.chance, b.monsters)], rows: f.dropOverview(b.q || '') };
});

async function handle(game, ctx) {
  const r = routes.find((x) => x.kind === ctx.kind && x.method === ctx.req.method);
  if (!r) return false;
  const out = await r.fn(game, ctx);
  if (out !== undefined) ctx.send(200, out);
  return true;
}

module.exports = { handle, route };
