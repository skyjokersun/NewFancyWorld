'use strict';
// site.pak (twelfth batch, Q28): the whole frontend in one file, so copying, unzipping
// and virus scanners deal with one file instead of about 11,000.
// Layout: "QYPAK1\n", 4-byte length (LE), the JSON index {files: {rel: [offset, size, mtimeMs]}},
// then the file bytes. tools/pack-site.js writes it.
// Loose files in the site folder win over the pack, so patches/, index.html and
// custom_assets/ can still be replaced one file at a time.
const fs = require('fs');
const path = require('path');

const MAGIC = Buffer.from('QYPAK1\n');

class SitePak {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(MAGIC.length + 4);
    fs.readSync(this.fd, head, 0, head.length, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(file + ' 不是 site.pak 文件');
    const len = head.readUInt32LE(MAGIC.length);
    const idx = Buffer.alloc(len);
    fs.readSync(this.fd, idx, 0, len, head.length);
    this.index = JSON.parse(idx.toString('utf8')).files;
    this.base = head.length + len;
  }
  has(rel) { return Object.prototype.hasOwnProperty.call(this.index, rel); }
  stat(rel) { const e = this.index[rel]; return e ? { size: e[1], mtimeMs: e[2] } : null; }
  read(rel) {
    const e = this.index[rel];
    if (!e) return null;
    const buf = Buffer.alloc(e[1]);
    fs.readSync(this.fd, buf, 0, e[1], this.base + e[0]);
    return buf;
  }
  stream(rel) { const e = this.index[rel]; return fs.createReadStream(this.file, { fd: this.fd, autoClose: false, start: this.base + e[0], end: this.base + e[0] + e[1] - 1 }); }
  names() { return Object.keys(this.index); }
}

let pak = null;
function open(file) {
  pak = null;
  if (file && fs.existsSync(file)) pak = new SitePak(file);
  return pak;
}
function current() { return pak; }
// A frontend file by its path inside the site folder: the loose file first, then the pack.
function readSite(root, rel) {
  try { return fs.readFileSync(path.join(root, rel)); } catch (_) { return pak ? pak.read(rel.split(path.sep).join('/')) : null; }
}
function listSite(root) {
  let loose = [];
  try { loose = fs.readdirSync(root); } catch (_) { /* no folder */ }
  return pak ? [...new Set(loose.concat(pak.names().filter((n) => !n.includes('/'))))] : loose;
}

module.exports = { SitePak, MAGIC, open, current, readSite, listSite };
