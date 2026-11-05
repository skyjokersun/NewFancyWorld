'use strict';
// Uploads (新职业与上传 tab).
// - Twelfth batch: old-client map packages are kept under var/uploads/map/ and checked
//   for the pieces the old client uses (not converted to web maps yet).
// - Thirteenth batch (Q1/Q2/Q12): model uploads become real game art.
//   monster    a zip of ALE files named after the action (stand, walk, fight, dead ...)
//   player     the same for a new profession; man/ and women/ folders, or one set for both
//   projectile one .ale (or a zip holding one)
//   The files are unpacked under var/uploads/assets/ at the path the web client asks for
//   (/cdn_dump/named/charactor/enemy/<model>/<action>.ale, charactor/man|women/<model>/...,
//   projectile/<model>.ale). A missing action is served from stand (then walk), and the
//   admin page lists which ones that applies to. Uploaded names start with u_ so they
//   never replace the client's own art.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ALE = require('../ale');
const SP = require('../sitepak');

const KINDS = { map: '地图包', monster: '怪物造型', player: '职业造型', projectile: '弹道' };
const MAX_BYTES = 200 * 1024 * 1024;
const ACTIONS = {
  monster: ['stand', 'walk', 'fight', 'dead', 'fight2', 'run', 'down'],
  player: ['stand', 'walk', 'run', 'fight', 'dead', 'down', 'lie', 'kiss', 'fight_bow', 'fight_near', 'fight2', 'fight_ball', 'fight_bop'],
};
const REQUIRED = { monster: ['stand', 'walk', 'fight', 'dead'], player: ['stand', 'walk', 'run', 'fight', 'dead', 'down', 'lie', 'kiss'] };
// Where a missing action is taken from, in order.
const FALLBACK = { fight2: ['fight'], fight_bow: ['fight'], fight_near: ['fight'], fight_ball: ['fight'], fight_bop: ['fight'], run: ['walk'], down: ['dead'], lie: ['dead', 'down'], kiss: ['stand'], dead: ['stand'] };
const GENDERS = ['man', 'women'];

// Zip entries {name, method, csize, size, offset}, from the central directory.
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const n = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < n && off + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20); const size = buf.readUInt32LE(off + 24);
    const len = buf.readUInt16LE(off + 28), extra = buf.readUInt16LE(off + 30), cmt = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const raw = buf.subarray(off + 46, off + 46 + len);
    let name = raw.toString('utf8');
    if (!(flags & 0x800)) { try { name = new TextDecoder('gbk').decode(raw); } catch (_) { /* keep utf8 */ } }
    out.push({ name: name.replace(/\\/g, '/'), method, csize, size, offset: local, encrypted: !!(flags & 1) });
    off += 46 + len + extra + cmt;
  }
  return out;
}
function zipNames(buf) { const e = zipEntries(buf); return e && e.map((x) => x.name); }
function zipRead(buf, e) {
  if (e.encrypted) throw new Error('zip 里的 ' + e.name + ' 有密码，请去掉密码再传');
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error('zip 损坏：' + e.name);
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const data = buf.subarray(start, start + e.csize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error('zip 里的 ' + e.name + ' 用了不支持的压缩方式（请用普通 zip）');
}

function checkMap(name, buf) {
  const files = name.toLowerCase().endsWith('.zip') ? zipNames(buf) : [name];
  if (!files) throw new Error('不是有效的 zip 文件');
  const has = (re) => files.some((f) => re.test(f.toLowerCase()));
  const found = [], missing = [];
  for (const [label, re] of [['地图脚本 map/*.fcc（或 .tdc）', /(^|\/)map\/[^/]+\.(fcc|tdc)$/], ['地图图块 wholemap/<地图>/sXXxYY', /wholemap\/[^/]+\/s\d+x\d+/], ['小地图 smap', /smap\//], ['遮挡 gmask', /gmask\.(gif|png)$/]]) (has(re) ? found : missing).push(label);
  return { files: files.length, found, missing };
}

function modelName(raw) {
  let m = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if (!m) throw new Error('请填造型名（英文字母、数字、下划线）');
  if (!m.startsWith('u_')) m = 'u_' + m;
  if (m.length > 24) throw new Error('造型名太长（最多 22 个字符）');
  return m;
}

// A map decoration animation (AEX) is drawn from its left edge; a monster stands on its
// centre. Shift every frame left by half the widest frame so the art sits on the monster's
// position (the frame headers, 24 bytes each from offset 32, are not encrypted).
function centreAex(buf) {
  if (buf.length < 32 || buf.toString('latin1', 0, 3) !== 'AEX') return buf;
  const out = Buffer.from(buf);
  const n = out.readUInt32LE(12);
  if (!(n > 0) || 32 + 24 * n > out.length) return buf;
  let maxW = 0;
  for (let g = 0; g < n; g += 1) maxW = Math.max(maxW, out.readUInt32LE(32 + 24 * g));
  const dx = Math.round(maxW / 2);
  for (let g = 0; g < n; g += 1) { const at = 32 + 24 * g + 16; out.writeInt32LE(out.readInt32LE(at) - dx, at); }
  return out;
}

class Uploads {
  register(server) {
    this.server = server;
    this.root = path.join(path.dirname(server.config.stateFile || path.join(__dirname, '..', '..', 'var', 'state.json')), 'uploads');
    this.assets = path.join(this.root, 'assets');
    this.urlCache = null;
  }
  onStart() { this.models(); }
  dir(kind) { return path.join(this.root, kind); }
  // Uploaded models: {monster: {name: {label, actions: {stand: info}, at}}, player: {name: {label, genders: {man: {...}, women: {...}}}}, projectile: {...}}
  models() {
    const b = this.server.store.bucket('uploadedModels');
    for (const k of ['monster', 'player', 'projectile']) if (!b[k]) b[k] = {};
    return b;
  }
  monsterModels() { return Object.keys(this.models().monster); }
  playerModels() { return Object.keys(this.models().player); }
  projectiles() { return Object.keys(this.models().projectile); }

  list() {
    const out = [];
    for (const kind of ['map', 'monster']) {
      let names = [];
      try { names = fs.readdirSync(this.dir(kind)).filter((f) => f.endsWith('.json')); } catch (_) { /* none yet */ }
      for (const f of names) { try { out.push(JSON.parse(fs.readFileSync(path.join(this.dir(kind), f), 'utf8'))); } catch (_) { /* skip */ } }
    }
    const m = this.models();
    for (const [kind, set] of Object.entries(m)) for (const [model, v] of Object.entries(set)) out.push(Object.assign({ kind, kindName: KINDS[kind], model, name: v.label || model }, v));
    return out.sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  save(kind, rawName, buf, opts = {}) {
    if (!KINDS[kind]) throw new Error('不支持的上传类型');
    if (!buf.length) throw new Error('文件是空的');
    const name = path.basename(String(rawName || 'upload')).replace(/[^\w.\-一-龥]/g, '_').slice(0, 80) || 'upload';
    if (kind === 'map') {
      const report = checkMap(name, buf);
      const id = Date.now().toString(36);
      fs.mkdirSync(this.dir(kind), { recursive: true });
      fs.writeFileSync(path.join(this.dir(kind), id + '_' + name), buf);
      const meta = { id, kind, kindName: KINDS[kind], name, bytes: buf.length, at: Date.now(), report };
      fs.writeFileSync(path.join(this.dir(kind), id + '.json'), JSON.stringify(meta));
      return meta;
    }
    const model = modelName(opts.model || name.replace(/\.(zip|ale|aex)$/i, ''));
    const label = String(opts.label || '').trim().slice(0, 20) || model;
    // Files by lower-case base name, and by gender folder for players.
    let files;
    if (/\.zip$/i.test(name)) {
      const entries = zipEntries(buf);
      if (!entries) throw new Error('不是有效的 zip 文件');
      files = entries.filter((e) => /\.(ale|aex)$/i.test(e.name) && e.size > 0).map((e) => ({ path: e.name.toLowerCase(), data: zipRead(buf, e) }));
    } else if (/\.(ale|aex)$/i.test(name)) files = [{ path: name.toLowerCase(), data: buf }];
    else throw new Error('请上传 zip（里面是 .ale 文件），或单个 .ale 文件');
    if (!files.length) throw new Error('里面没有 .ale 文件');
    const check = (data) => ALE.inspect(data);
    const m = this.models();
    if (kind === 'projectile') {
      if (files.length !== 1) throw new Error('弹道只要一个 .ale 文件，这个包里有 ' + files.length + ' 个');
      const info = check(files[0].data);
      if (!info.ok) throw new Error(files[0].path + '：' + info.reason);
      this.write('projectile/' + model + '.ale', files[0].data);
      m.projectile[model] = { label, at: Date.now(), bytes: buf.length, file: info };
    } else {
      const wanted = ACTIONS[kind];
      const pick = (list) => {
        const got = {};
        for (const f of list) {
          const base = path.basename(f.path).replace(/\.(ale|aex)$/, '');
          if (wanted.includes(base) && !got[base]) got[base] = f;
        }
        return got;
      };
      const sets = {};
      if (kind === 'player') {
        const byGender = { man: [], women: [] };
        const genderOf = (p) => (/(^|\/)(man|male|男)\//.test(p) ? 'man' : /(^|\/)(women|woman|female|女)\//.test(p) ? 'women' : null);
        const plain = [];
        for (const f of files) { const g = genderOf(f.path); if (g) byGender[g].push(f); else plain.push(f); }
        for (const g of GENDERS) sets[g] = pick(byGender[g].length ? byGender[g] : plain);
      } else sets.enemy = pick(files);
      const report = {};
      for (const [g, got] of Object.entries(sets)) {
        if (!got.stand && !got.walk) throw new Error((g === 'man' ? '男' : g === 'women' ? '女' : '') + '造型至少要有 stand.ale 或 walk.ale');
        const actions = {};
        for (const [act, f] of Object.entries(got)) {
          const info = check(f.data);
          if (!info.ok) throw new Error(f.path + '：' + info.reason);
          actions[act] = info;
        }
        report[g] = { actions, missing: REQUIRED[kind].filter((a) => !got[a]) };
      }
      // Replace the old files of this model.
      const dirs = kind === 'player' ? GENDERS.map((g) => 'charactor/' + g + '/' + model) : ['charactor/enemy/' + model];
      for (const d of dirs) fs.rmSync(path.join(this.assets, d), { recursive: true, force: true });
      for (const [g, got] of Object.entries(sets)) for (const [act, f] of Object.entries(got)) this.write('charactor/' + g + '/' + model + '/' + act + '.ale', f.data);
      const rec = { label, at: Date.now(), bytes: buf.length };
      if (kind === 'player') rec.genders = report; else Object.assign(rec, report.enemy);
      m[kind][model] = rec;
    }
    this.urlCache = null;
    this.server.store.markDirty();
    return Object.assign({ kind, kindName: KINDS[kind], model, name: label }, m[kind][model]);
  }
  write(rel, data) {
    const file = path.join(this.assets, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }

  remove(kind, id) {
    if (!KINDS[kind]) throw new Error('参数不对');
    if (kind === 'map' || (kind === 'monster' && /^[a-z0-9]+$/.test(id) && !id.startsWith('u_'))) {
      if (!/^[a-z0-9]+$/.test(id)) throw new Error('参数不对');
      for (const f of fs.readdirSync(this.dir(kind))) if (f === id + '.json' || f.startsWith(id + '_')) fs.unlinkSync(path.join(this.dir(kind), f));
      return '已删除';
    }
    const m = this.models();
    if (!m[kind][id]) throw new Error('没有这个造型');
    const users = this.usersOf(kind, id);
    if (users.length) throw new Error('还有 ' + users.join('、') + ' 在用这个造型，先给它们换掉再删');
    delete m[kind][id];
    const dirs = kind === 'player' ? GENDERS.map((g) => 'charactor/' + g + '/' + id) : kind === 'monster' ? ['charactor/enemy/' + id] : [];
    for (const d of dirs) fs.rmSync(path.join(this.assets, d), { recursive: true, force: true });
    if (kind === 'projectile') fs.rmSync(path.join(this.assets, 'projectile', id + '.ale'), { force: true });
    this.urlCache = null;
    this.server.store.markDirty();
    return '已删除造型 ' + id;
  }
  // Who uses an uploaded model (monsters, professions, skills), by name.
  usersOf(kind, id) {
    const f = this.server.features;
    const out = [];
    const over = (r) => (f.balance.cfg.monsters[r.monsterId] || {});
    if (kind === 'monster' && f.balance) for (const r of f.balance.catalog().values()) if ((over(r).model || r.template.model) === id) out.push(r.template.name);
    if (kind === 'player' && f.professions) for (const c of Object.values(f.professions.customMap())) if (c.model === id) out.push(c.name);
    if (kind === 'projectile') {
      if (f.balance) for (const r of f.balance.catalog().values()) if ((over(r).projectile || r.template.projectile) === id) out.push(r.template.name);
      if (f.customSkills) for (const s of f.customSkills.list()) if (s.projectileKey === id) out.push(s.name);
    }
    return out;
  }

  // ---------- serving ----------
  // The file for one named asset path (charactor/enemy/u_x/fight.ale), with fallbacks.
  fileFor(rel) {
    let m = /^charactor\/(enemy|man|women)\/(u_[a-z0-9_]+)\/([a-z0-9_]+)\.ale$/i.exec(rel);
    if (m) {
      const [, g, model, act] = m;
      const set = g === 'enemy' ? this.models().monster[model] : this.models().player[model];
      if (!set) return null;
      const dir = path.join(this.assets, 'charactor', g, model);
      for (const a of [act.toLowerCase()].concat(FALLBACK[act.toLowerCase()] || [], ['stand', 'walk'])) {
        const f = path.join(dir, a + '.ale');
        if (fs.existsSync(f)) return f;
      }
      return null;
    }
    m = /^projectile\/(u_[a-z0-9_]+)\.ale$/i.exec(rel);
    if (m && this.models().projectile[m[1]]) return path.join(this.assets, 'projectile', m[1] + '.ale');
    m = /^custom_assets\/skill-icons\/([a-z0-9_]+)\/spriteFrame\.png$/i.exec(rel);
    if (m) { const f = path.join(this.root, 'skill-icons', m[1] + '.png'); return fs.existsSync(f) ? f : null; }
    return null;
  }
  // Fifteenth batch: built-in models made from the client's own art (features/batch15.js):
  // u_bossdragon (大地龙) and the green-gift transform looks u_tf_*.
  builtinFor(rel) {
    const B = require('./batch15').BUILTIN_MODELS;
    const m = /^charactor\/(enemy|man|women)\/(u_[a-z0-9_]+)\/([a-z0-9_]+)\.ale$/i.exec(rel);
    if (!m) return null;
    const set = m[1] === 'enemy' ? B.monster : B.player;
    const src = set[m[2]];
    if (!src) return null;
    const VA = require('../virtual-assets');
    const act = m[3].toLowerCase();
    for (const a of [act].concat(FALLBACK[act] || [], ['stand', 'walk'])) {
      const url = src(a);
      const buf = VA.readAsset(url);
      if (buf) return /\/mapsource\//.test(url) ? centreAex(buf) : buf;
    }
    return null;
  }
  // Every URL the client may ask for, for the named-asset manifest.
  urls() {
    if (this.urlCache) return this.urlCache;
    const out = [];
    const B = require('./batch15').BUILTIN_MODELS;
    for (const model of Object.keys(B.monster)) for (const a of ACTIONS.monster) out.push('/cdn_dump/named/charactor/enemy/' + model + '/' + a + '.ale');
    for (const model of Object.keys(B.player)) for (const g of GENDERS) for (const a of ACTIONS.player) out.push('/cdn_dump/named/charactor/' + g + '/' + model + '/' + a + '.ale');
    const m = this.models();
    for (const model of Object.keys(m.monster)) for (const a of ACTIONS.monster) out.push('/cdn_dump/named/charactor/enemy/' + model + '/' + a + '.ale');
    for (const model of Object.keys(m.player)) for (const g of GENDERS) for (const a of ACTIONS.player) out.push('/cdn_dump/named/charactor/' + g + '/' + model + '/' + a + '.ale');
    for (const model of Object.keys(m.projectile)) out.push('/cdn_dump/named/projectile/' + model + '.ale');
    this.urlCache = out;
    return out;
  }
  // HTTP: uploaded art, skill icons and the merged asset manifest. true when answered.
  serve(req, res, root) {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (_) { return false; }
    if (pathname === '/asset-manifest.json') {
      const extra = this.urls();
      if (!extra.length) return false;
      let base = [];
      try { base = JSON.parse(SP.readSite(root, 'asset-manifest.json').toString('utf8')); } catch (_) { return false; }
      const body = Buffer.from(JSON.stringify(base.concat(extra.filter((u) => !base.includes(u)))));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    }
    let rel = null;
    if (pathname.startsWith('/cdn_dump/named/')) rel = pathname.slice('/cdn_dump/named/'.length);
    else if (pathname.startsWith('/custom_assets/skill-icons/')) rel = pathname.slice(1);
    if (!rel) return false;
    const builtin = this.builtinFor(rel);
    if (builtin) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': builtin.length, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : builtin);
      return true;
    }
    const file = this.fileFor(rel);
    if (!file) return false;
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': file.endsWith('.png') ? 'image/png' : 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
  // PNG of the first frame of an uploaded action (admin preview).
  preview(kind, model, action, gender) {
    const g = kind === 'player' ? (gender === 'women' ? 'women' : 'man') : 'enemy';
    const rel = kind === 'projectile' ? 'projectile/' + model + '.ale' : 'charactor/' + g + '/' + model + '/' + action + '.ale';
    const file = this.fileFor(rel);
    return file ? ALE.framePng(fs.readFileSync(file)) : null;
  }
  // Skill icons (any image, shrunk to 32x32 on the admin page).
  saveSkillIcon(id, png) {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(png || ''));
    if (!m) throw new Error('图标要 PNG');
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > 64 * 1024) throw new Error('图标太大');
    const file = path.join(this.root, 'skill-icons', id + '.png');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    return 'custom_assets/skill-icons/' + id + '/spriteFrame';
  }
}

module.exports = { Uploads, MAX_BYTES, zipNames, zipEntries, zipRead, checkMap, modelName, ACTIONS, KINDS };
