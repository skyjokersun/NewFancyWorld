'use strict';
// Reads the old client's ALE animation files far enough to check an upload and draw a
// preview of its first frame (thirteenth batch). Ported from the web client's AleParser:
// "ALE" magic, uint16 type at 4 (1 = 256-colour palette, 3 = true colour RGB565) and
// uint16 frame count at 10. A palette file keeps its palette at 12 (256 x uint32) and its
// first frame header ends at 1064; a true-colour frame has a 26-byte header.
const SHADOW = { r: 0, g: 0, b: 0, a: 128 };

function view(buf) { return new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
function typeOf(dv) {
  return dv.byteLength < 12 || dv.getUint8(0) !== 65 || dv.getUint8(1) !== 76 || dv.getUint8(2) !== 69 ? 0 : dv.getUint16(4, true);
}
function palette(dv) {
  const out = [];
  for (let i = 0; i < 256; i += 1) { const n = dv.getUint32(4 * i + 12, true); out.push({ r: (n >>> 16) & 255, g: (n >>> 8) & 255, b: n & 255, a: (n >>> 24) & 255 }); }
  return out;
}
function headers(dv) {
  const type = typeOf(dv);
  const out = [];
  const count = dv.getUint16(10, true);
  if (type === 3) {
    let n = 12;
    for (let i = 0; i < count && n + 26 <= dv.byteLength; i += 1) {
      const len = dv.getUint32(n, true);
      if (len < 26 || n + len > dv.byteLength) break;
      const w = dv.getUint32(n + 8, true); const h = dv.getUint32(n + 12, true); const extra = dv.getUint32(n + 4, true);
      if (!w || !h || w > 4096 || h > 4096 || 26 + extra > len) break;
      out.push({ width: w, height: h, offX: dv.getInt32(n + 16, true), offY: dv.getInt32(n + 20, true), headlong: 26 + extra, startOffset: n, framelong: len, type });
      n += len;
    }
    return out;
  }
  let a = 1064;
  for (let i = 0; i < count; i += 1) {
    if (a > dv.byteLength) break;
    const len = dv.getUint32(a - 28, true);
    out.push({ width: dv.getUint32(a - 20, true), height: dv.getUint32(a - 16, true), offX: dv.getInt32(a - 12, true), offY: dv.getInt32(a - 8, true), headlong: dv.getUint16(a - 24, true), startOffset: a, framelong: len, type: type || 1 });
    a += len;
    if (a > dv.byteLength) break;
  }
  return out;
}

function decodeType1(t, dv, pal, head) {
  const px = new Uint8Array(4 * t.width * t.height);
  let o = t.startOffset + head; const end = Math.min(dv.byteLength, t.startOffset + t.framelong);
  let rows = 0; let solid = 0;
  for (let l = 0; l < t.height && o + 2 <= end; l += 1) {
    const u = dv.getUint16(o, true); const c = o + 2; const stop = Math.min(end, c + u);
    let s = 0; let d = 2; let run = 0; let alpha = 255;
    for (let v = c; v < stop && s < t.width;) {
      const b = dv.getUint8(v); v += 1;
      switch (d) {
        case 0:
          d = 4; alpha = Math.min(8 * (b - 224), 255);
          if (b < 224 && b >= 192) { d = 3; alpha = Math.min(8 * (b - 192), 255); }
          if (b < 192 && b >= 160) {
            d = 2;
            for (let k = 0; k < b - 160 && s + k < t.width; k += 1) { const i = 4 * (l * t.width + s + k); px[i] = SHADOW.r; px[i + 1] = SHADOW.g; px[i + 2] = SHADOW.b; px[i + 3] = SHADOW.a; solid += 1; }
            s += b - 160;
          }
          if (b < 160) { d = 1; run = b; }
          if (b === 0) d = 0;
          break;
        case 1: { const e = pal[b] || { r: 0, g: 0, b: 0, a: 0 }; const i = 4 * (l * t.width + s); px[i] = e.r; px[i + 1] = e.g; px[i + 2] = e.b; px[i + 3] = e.a; if (e.a > 0) solid += 1; s += 1; run -= 1; if (run <= 0) d = 2; break; }
        case 2: d = 0; s += b; break;
        default: { const e = pal[b] || { r: 0, g: 0, b: 0, a: 0 }; const i = 4 * (l * t.width + s); px[i] = e.r; px[i + 1] = e.g; px[i + 2] = e.b; px[i + 3] = alpha; if (alpha > 0) solid += 1; s += 1; d = d === 3 ? 2 : 0; }
      }
    }
    const next = o + u + 4;
    if (next > end) break;
    o = next;
    if (dv.getInt8(o - 1) < 0) { if (o + 2 > end) break; const skip = dv.getInt16(o, true); o += 2; l += Math.max(0, skip - 1); }
    if (o >= end) break;
    rows += 1;
  }
  return { px, score: rows * 1e5 + solid };
}

function rgb565(v) { return [(255 * ((v >>> 11) & 31) / 31) | 0, (255 * ((v >>> 5) & 63) / 63) | 0, (255 * (v & 31) / 31) | 0]; }
function decodeType3(t, dv) {
  const px = new Uint8Array(4 * t.width * t.height);
  let a = t.startOffset + t.headlong; const end = Math.min(dv.byteLength, t.startOffset + t.framelong);
  for (let row = 0; a + 2 <= end && row < t.height;) {
    const h = dv.getInt16(a, true); a += 2;
    if (h < 0) { row += -h; continue; }
    if (a + 2 > end) break;
    const len = dv.getUint16(a, true); a += 2;
    if (a + len > end) break;
    const g = a + len; let l = a; let x = 0;
    for (let c = 0; c < h && l < g; c += 1) {
      let skip = 0;
      while (l < g) { const d = dv.getUint8(l++); if (!(d === 255 && l < g && dv.getUint8(l) === 0)) { skip += d; break; } l += 1; skip += 255; }
      x += skip;
      if (x >= t.width || l >= g) continue;
      let op = dv.getUint8(l++);
      if (op <= 127) {
        for (let v = 0; v < op && x < t.width && l + 2 <= g; v += 1) { const [r, gg, b] = rgb565(dv.getUint16(l, true)); l += 2; const i = 4 * (row * t.width + x); px[i] = r; px[i + 1] = gg; px[i + 2] = b; px[i + 3] = 255; x += 1; }
      } else if (op >= 160 && op <= 191) {
        for (let v = 0; v < (op & 31) && x < t.width; v += 1) { const i = 4 * (row * t.width + x); px[i + 3] = SHADOW.a; x += 1; }
      } else {
        while (x < t.width && op >= 192 && op <= 254 && l + 2 <= g) {
          const [r, gg, b] = rgb565(dv.getUint16(l, true)); l += 2;
          const i = 4 * (row * t.width + x); px[i] = r; px[i + 1] = gg; px[i + 2] = b; px[i + 3] = Math.min(((op & 31) << 3) | 7, 255); x += 1;
          if (op <= 223 || l >= g) break;
          op = dv.getUint8(l++);
        }
      }
    }
    a = g; row += 1;
  }
  return px;
}

// {ok, type, frames, width, height, reason} for one file.
function inspect(buf) {
  if (!buf || buf.length < 12) return { ok: false, reason: '文件太小' };
  if (buf[0] === 65 && buf[1] === 69 && buf[2] === 88) return { ok: true, type: 'AEX', frames: 0, width: 0, height: 0, note: 'AEX 加密动画，网页客户端能读，服务器不画预览' };
  const dv = view(buf);
  const type = typeOf(dv);
  if (type !== 1 && type !== 3) return { ok: false, reason: '不是 ALE 文件（开头不是 ALE，或类型不是 1/3）' };
  let hs = [];
  try { hs = headers(dv); } catch (_) { hs = []; }
  if (!hs.length) return { ok: false, reason: 'ALE 里读不出任何一帧' };
  return { ok: true, type: 'ALE' + type, frames: hs.length, width: Math.max(...hs.map((h) => h.width)), height: Math.max(...hs.map((h) => h.height)) };
}

// PNG of frame `index` (default the first), or null.
function framePng(buf, index = 0) {
  const { encodePng } = require('./item-atlas');
  const dv = view(buf);
  const type = typeOf(dv);
  if (type !== 1 && type !== 3) return null;
  const hs = headers(dv);
  const t = hs[Math.max(0, Math.min(hs.length - 1, index))];
  if (!t || !t.width || !t.height) return null;
  let px;
  if (type === 3) px = decodeType3(t, dv);
  else {
    const pal = palette(dv);
    const a = decodeType1(t, dv, pal, t.headlong);
    px = a.px;
    if (t.startOffset + t.headlong + 2 < Math.min(dv.byteLength, t.startOffset + t.framelong)) {
      const b = decodeType1(t, dv, pal, t.headlong + 2);
      if (b.score > a.score) px = b.px;
    }
  }
  for (let i = 0; i + 3 < px.length; i += 4) if (!px[i + 3]) { px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; }
  return encodePng(t.width, t.height, Buffer.from(px));
}

module.exports = { inspect, framePng };
