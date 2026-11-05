'use strict';
// site.rar lacks the "shop" pack, so /cdn_dump/named/shop/item_atlas (the
// 512x832 icon sheet ShopCatalog crops every item icon from) is missing and
// shop/bag icons stay blank. The sheet is rebuilt here from the per-item
// 32x32 editor icons (editor-item-icons/<itemId>_<sheet>_<x>_<y>), placing each
// icon at the cell its item template names in `atlas`. Items with no editor icon
// fall back to custom_assets/item-icons/<itemId>.png in the frontend folder.
const zlib = require('zlib');
const cat = require('./game/catalog');
const log = require('./util/log');

// 32x32 PNGs named <itemId>.png, cut from the original Windows client's item art.
const EXTRA_ICON_DIR = 'custom_assets/item-icons/';
const ADMIN_ICON_DIR = 'custom_assets/item-icons-admin/';
// Editor icons that differ from the original itemdata.tab (img + pos); these use the
// cut-out in EXTRA_ICON_DIR instead. 3333 楦木杖: arm06.gif at 34,64, not the 法师袍 cell.
// (Checked 2026-11-03: the other 400 items match the original. 布鞋 / 裘皮靴 and the other
// arm03 / arm08 shoes, and 浪人斗篷 / 法师斗篷, share one picture in the original too.)
const WRONG_EDITOR_ICON = new Set([3333]);

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 8-bit RGBA, non-interlaced PNGs only (all editor icons are).
function decodePng(buf) {
  if (!buf || buf.readUInt32BE(12) !== 0x49484452) return null;
  const width = buf.readUInt32BE(16); const height = buf.readUInt32BE(20);
  if (buf[24] !== 8 || buf[25] !== 6 || buf[28] !== 0) return null;
  const idat = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o); const type = buf.toString('ascii', o + 4, o + 8);
    if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4; const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const f = raw[y * (stride + 1)]; const src = y * (stride + 1) + 1; const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= 4 ? out[dst + x - 4] : 0; const b = y ? out[dst - stride + x] : 0; const c = x >= 4 && y ? out[dst - stride + x - 4] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[dst + x] = v & 255;
    }
  }
  return { width, height, rgba: out };
}

function buildItemAtlas(named, readRel) {
  const icons = new Map();
  for (const url of Object.keys(named)) {
    const m = /^\/cdn_dump\/named\/editor-item-icons\/(\d+)_[^/]+\/spriteFrame\.png$/.exec(url);
    if (m) icons.set(Number(m[1]), url);
  }
  if (!icons.size) return null;
  let W = 0; let H = 0;
  for (const t of cat.templates.values()) if (t.atlas) { W = Math.max(W, t.atlas.x + t.atlas.w); H = Math.max(H, t.atlas.y + t.atlas.h); }
  if (!W || !H) return null;
  const rgba = Buffer.alloc(W * H * 4);
  let placed = 0;
  for (const t of cat.templates.values()) {
    if (!t.atlas) continue;
    // Items without an editor icon can use one taken from the original client.
    // Twelfth batch: an icon uploaded on the admin page wins.
    const buf = readRel(ADMIN_ICON_DIR + t.itemId + '.png') || (icons.has(t.itemId) && !WRONG_EDITOR_ICON.has(t.itemId) ? readRel(named[icons.get(t.itemId)]) : readRel(EXTRA_ICON_DIR + t.itemId + '.png'));
    const img = buf && decodePng(buf);
    if (!img) continue;
    const w = Math.min(t.atlas.w, img.width); const h = Math.min(t.atlas.h, img.height);
    for (let y = 0; y < h; y += 1) img.rgba.copy(rgba, ((t.atlas.y + y) * W + t.atlas.x) * 4, y * img.width * 4, (y * img.width + w) * 4);
    placed += 1;
  }
  log.info('item icon atlas rebuilt from editor icons:', placed + ' items');
  return encodePng(W, H, rgba);
}

module.exports = { buildItemAtlas, decodePng, encodePng, ADMIN_ICON_DIR };
