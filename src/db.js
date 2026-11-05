'use strict';
const fs = require('fs');
const path = require('path');
const log = require('./util/log');

// Small JSON document store. The whole state lives in memory and is flushed
// atomically (write temp file + rename) on an interval and at shutdown.
class Store {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, counters: {}, accounts: {}, characters: {}, kv: {} };
    this.dirty = false;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = Object.assign(this.data, parsed);
      log.info('state loaded', this.file, Object.keys(this.data.accounts).length, 'accounts');
    } catch (e) {
      if (e.code !== 'ENOENT') log.warn('state load failed, starting fresh', e.message);
    }
  }

  markDirty() { this.dirty = true; }

  save(force = false) {
    if (!this.dirty && !force) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  nextId(name) {
    const c = this.data.counters;
    c[name] = (c[name] || 0) + 1;
    this.dirty = true;
    return c[name];
  }

  // Generic keyed buckets for feature modules (bank, garden, townhouse...).
  bucket(name) {
    if (!this.data.kv[name]) this.data.kv[name] = {};
    return this.data.kv[name];
  }
}

module.exports = { Store };
