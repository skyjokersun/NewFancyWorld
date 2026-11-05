'use strict';
// Serves frontend files that the shipped site does not contain as plain files:
// - the Cocos 'remote/resources' bundle manifest/script (the runtime patches resolve
//   unknown paths through /cdn_dump/named, so an empty bundle is enough);
// - /cdn_dump/named/* assets, taken from the foundation preload blob or, by name
//   matching (data/named-index.json), from the loose files and .qypack packs;
// - stand-ins for the login map islands (see login-lands.js) and the shop item
//   icon sheet (see item-atlas.js).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const log = require('./util/log');
const { loginLandAsset } = require('./login-lands');
const { buildItemAtlas } = require('./item-atlas');
const SP = require('./sitepak');

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' };

const BUNDLE_CONFIG = {
  importBase: 'import', nativeBase: 'native', name: 'resources', deps: [], uuids: [], paths: {}, scenes: {},
  packs: {}, versions: { import: [], native: [] }, redirect: [], debug: false, types: [], extensionMap: {}, hasPreloadScript: true, dependencyRelationships: {},
};
const BUNDLE_SCRIPT = `System.register("chunks:///_virtual/resources", [], function () { return { execute: function () {} }; });
(function (r) { r('virtual:///prerequisite-imports/resources', 'chunks:///_virtual/resources'); })(function (mid, cid) {
  System.register(mid, [cid], function (_export) { return { setters: [function (_m) { var o = {}; for (var k in _m) { if (k !== 'default' && k !== '__esModule') o[k] = _m[k]; } _export(o); }], execute: function () {} }; });
});
`;

// Directories the client lists with resources.loadDir(); the real bundle config
// is not in site.rar, so their sprites are registered here from the packs.
const LISTED_DIRS = ['navimap'];
const ITEM_ATLAS_URL = '/cdn_dump/named/shop/item_atlas/spriteFrame.png';

// Adds ImageAsset + SpriteFrame entries for the named sprites under LISTED_DIRS
// (named-index maps them to the bundle's native files, whose uuids and import
// versions come from the resource catalog).
function buildBundleConfig(catalog, named) {
  const config = JSON.parse(JSON.stringify(BUNDLE_CONFIG));
  if (!catalog) return config;
  const imports = new Map();
  for (const rel of Object.keys(catalog.files)) {
    const m = /^remote\/resources\/import\/[0-9a-f]{2}\/([0-9a-f-]{36}(?:@[0-9a-f]+)?)\.([0-9a-f]{5})\.json$/.exec(rel);
    if (m) imports.set(m[1], m[2]);
  }
  config.types = ['cc.ImageAsset', 'cc.SpriteFrame'];
  const add = (uuid) => { config.uuids.push(uuid); return config.uuids.length - 1; };
  for (const [url, rel] of Object.entries(named)) {
    const u = /^\/cdn_dump\/named\/(.+)\/spriteFrame\.(png|jpg)$/.exec(url);
    const n = /^remote\/resources\/native\/[0-9a-f]{2}\/([0-9a-f-]{36})\.([0-9a-f]{5})\.(png|jpg)$/.exec(rel || '');
    if (!u || !n || !LISTED_DIRS.some((d) => u[1].startsWith(d + '/'))) continue;
    const uuid = n[1]; const sub = uuid + '@f9941';
    if (!imports.has(uuid) || !imports.has(sub)) continue;
    const i = add(uuid); const j = add(sub);
    config.paths[i] = [u[1], 0];
    config.paths[j] = [u[1] + '/spriteFrame', 1, 1];
    config.versions.import.push(i, imports.get(uuid), j, imports.get(sub));
    config.versions.native.push(i, n[2]);
  }
  return config;
}

// The admin item page (twelfth batch) rebuilds the icon sheet after an icon or item change.
const atlasResetters = [];
function resetItemAtlas() { for (const f of atlasResetters) f(); }
// The admin page crops item icons out of the served sheet.
let lastLookup = null;
function readAsset(pathname) { return lastLookup ? lastLookup(pathname) : null; }

function createVirtualAssets(feRoot, dataDir) {
  const root = path.resolve(feRoot);
  // Loose file or site.pak (twelfth batch).
  const mustRead = (rel) => { const b = SP.readSite(root, rel); if (!b) throw new Error('missing ' + rel); return b; };
  const preload = new Map();
  let preloadBuf = null;
  try {
    const manifest = JSON.parse(mustRead('preload/manifest.json').toString('utf8'));
    preloadBuf = zlib.gunzipSync(mustRead(manifest.url.replace(/^\/+/, '')));
    const len = preloadBuf.readUInt32LE(4);
    const base = 8 + len;
    for (const [url, off, bytes] of JSON.parse(preloadBuf.subarray(8, base).toString('utf8'))) preload.set(url, [base + off, bytes]);
  } catch (e) { log.warn('preload index unavailable（前端 preload 文件夹缺少 manifest.json 或 foundation.*.bin.gz，部分图片和声音会缺失）:', e.message); }

  let named = {};
  try { named = JSON.parse(fs.readFileSync(path.join(dataDir, 'named-index.json'), 'utf8')); } catch (e) { log.warn('named index unavailable:', e.message); }
  // fox3 (狐仙) has no standing animation; like the 小酒窝 client, stand with the walk frames.
  const FOX3 = '/cdn_dump/named/charactor/enemy/fox3/';
  if (!named[FOX3 + 'stand.ale'] && named[FOX3 + 'walk.ale']) named[FOX3 + 'stand.ale'] = named[FOX3 + 'walk.ale'];

  let catalog = null;
  const packCache = new Map();
  try {
    const file = SP.listSite(root).find((f) => /^resource-catalog\..*\.json\.gz$/.test(f));
    if (!file) throw new Error('no resource-catalog.*.json.gz in ' + root);
    catalog = JSON.parse(zlib.gunzipSync(mustRead(file)));
  } catch (e) { log.warn('resource catalog unavailable:', e.message); }

  const bundleConfig = buildBundleConfig(catalog, named);
  const bundleConfigJson = Buffer.from(JSON.stringify(bundleConfig));

  function fromPack(rel) {
    const e = catalog && catalog.files[rel];
    if (!e) return null;
    if (!packCache.has(e.pack)) {
      const p = catalog.packs[e.pack];
      let buf = null;
      try { const raw = mustRead(p.file); buf = p.codec === 'gzip' ? zlib.gunzipSync(raw) : raw; } catch (_) { buf = null; }
      packCache.set(e.pack, buf);
    }
    const buf = packCache.get(e.pack);
    return buf ? buf.subarray(e.offset, e.offset + e.bytes) : null;
  }
  function readRel(rel) {
    return SP.readSite(root, rel) || fromPack(rel);
  }

  let itemAtlas;  // built on first request
  atlasResetters.push(() => { itemAtlas = undefined; });
  const misses = new Set();
  function lookup(pathname) {
    if (/^\/(assets|remote)\/resources\/config\.[0-9a-f]+\.json$/.test(pathname)) return bundleConfigJson;
    // Texture2D sub-assets of registered images are not in the packs (the build
    // inlined them into the missing config); a default texture over the image is enough.
    const tex = /^\/(?:assets|remote)\/resources\/import\/[0-9a-f]{2}\/([0-9a-f-]{36})@6c48a(?:\.[0-9a-f]{5})?\.json$/.exec(pathname);
    if (tex && bundleConfig.uuids.includes(tex[1])) return Buffer.from(JSON.stringify({ __type__: 'cc.Texture2D', content: { base: '2,2,33071,33071,0,0', mipmaps: [tex[1]] } }));
    if (/^\/(assets|remote)\/resources\/(import|native)\//.test(pathname)) return fromPack('remote/' + pathname.replace(/^\/(assets|remote)\//, ''));
    if (/^\/(assets|remote)\/resources\/index\.[0-9a-f]+\.js$/.test(pathname)) return Buffer.from(BUNDLE_SCRIPT);
    const land = loginLandAsset(pathname);
    if (land) return land;
    if (!pathname.startsWith('/cdn_dump/named/')) return null;
    if (pathname === ITEM_ATLAS_URL) {
      if (itemAtlas === undefined) { try { itemAtlas = buildItemAtlas(named, readRel); } catch (e) { log.warn('item atlas build failed:', e.message); itemAtlas = null; } }
      if (itemAtlas) return itemAtlas;
    }
    const hit = preload.get(pathname);
    if (hit && preloadBuf) return preloadBuf.subarray(hit[0], hit[0] + hit[1]);
    if (named[pathname]) return readRel(named[pathname]);
    return null;
  }

  lastLookup = lookup;
  return function handle(req, res, pathname) {
    const body = lookup(pathname);
    if (!body) {
      if (pathname.startsWith('/cdn_dump/') && !misses.has(pathname)) { misses.add(pathname); log.debug('missing asset', pathname); }
      return false;
    }
    // Generated files change between server versions, so the browser must revalidate.
    const etag = '"' + crypto.createHash('md5').update(body).digest('base64url') + '"';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); res.end(); return true; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(pathname).toLowerCase()] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-cache', ETag: etag });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}

module.exports = { createVirtualAssets, resetItemAtlas, readAsset, ITEM_ATLAS_URL };
