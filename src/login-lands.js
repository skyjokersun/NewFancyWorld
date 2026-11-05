'use strict';
// The login world map loads its six islands from /world/new2/in/img/map/root/
// land_NN.ale, which site.rar does not contain. Without them the client builds
// no island views and no region can be picked. This generates stand-ins in the
// AES container format the client parses (AleParser.parseAES): frame 0 is the
// normal island (transparent, the parchment background already shows the land)
// and frame 1 the hover overlay, a soft glow over the island's hit polygon.
const zlib = require('zlib');

// Hit polygons used by the client (30_runtime_patches.js, islandPolygons);
// origin at the island centre, y up.
const POLYGONS = {
  '01': [[-50, -20], [-20, -45], [40, -45], [60, -10], [55, 35], [10, 45], [-45, 30], [-60, 0]],
  '02': [[-55, -30], [0, -45], [55, -30], [60, 20], [20, 45], [-40, 40], [-60, 10]],
  '03': [[-65, -40], [0, -60], [65, -40], [70, 30], [20, 60], [-50, 50], [-70, 10]],
  '04': [[-70, -50], [0, -70], [70, -50], [75, 40], [20, 70], [-60, 60], [-75, 10]],
  '05': [[-60, -60], [0, -75], [60, -60], [65, 40], [10, 75], [-50, 65], [-65, 10]],
  '06': [[-55, -35], [0, -45], [55, -35], [60, 25], [15, 45], [-45, 35], [-60, 5]],
};
const SIZE = 160;

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function inside(x, y, pts) {
  let r = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const [xi, yi] = pts[i]; const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) r = !r;
  }
  return r;
}

function landAle(code) {
  const pts = POLYGONS[code];
  if (!pts) return null;
  const w = SIZE * 2; const h = SIZE;
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const lx = x + 0.5 - SIZE / 2; const ly = SIZE / 2 - (y + 0.5);
      if (!inside(lx, ly, pts)) continue;
      const i = (y * w + SIZE + x) * 4;
      rgba[i] = 255; rgba[i + 1] = 236; rgba[i + 2] = 160; rgba[i + 3] = 70;
    }
  }
  const image = png(w, h, rgba);
  const frames = 2;
  const head = Buffer.alloc(32 + 24 * frames);
  head.write('AEX', 0, 'ascii');            // bytes 4..11 are the key: all zero, so the image is stored as is
  head.writeUInt32LE(frames, 12); head.writeUInt32LE(image.length, 20);
  for (let f = 0; f < frames; f += 1) {
    const o = 32 + 24 * f;
    head.writeUInt32LE(SIZE, o); head.writeUInt32LE(SIZE, o + 4); head.writeInt32LE(f * SIZE, o + 8);
  }
  return Buffer.concat([head, image]);
}

const cache = new Map();
function loginLandAsset(pathname) {
  const m = /^\/world\/new2\/in\/img\/map\/root\/land_(\d\d)\.ale$/.exec(pathname);
  if (!m) return null;
  if (!cache.has(m[1])) cache.set(m[1], landAle(m[1]));
  return cache.get(m[1]);
}

module.exports = { loginLandAsset };
