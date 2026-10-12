'use strict';
const fs = require('fs');
const path = require('path');

// Tiny durable JSON document with debounced atomic writes (tmp file + rename).
class JsonStore {
  constructor(file, defaults, { persist = true, debounceMs = 250 } = {}) {
    this.file = file;
    this.persist = persist;
    this.debounceMs = debounceMs;
    this.timer = null;
    this.data = defaults;
    if (persist) {
      try { this.data = { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) {
        if (e.code !== 'ENOENT') console.error(`[store] could not read ${file}: ${e.message}`);
      }
    }
  }
  save() {
    if (!this.persist || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.debounceMs);
    this.timer.unref?.();
  }
  flush() {
    if (!this.persist) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error(`[store] write failed for ${this.file}: ${e.message}`); }
  }
}
module.exports = { JsonStore };
