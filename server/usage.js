'use strict';
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const EMPTY = () => ({ rooms: 0, peerSeconds: 0, peakPeers: 0, joins: 0 });

// Aggregate counters only: no room ids, IPs, or participants are ever stored.
class UsageService {
  constructor(store) {
    this.store = store;
    store.data.usage ||= {};
  }

  _bucket(tid, t = Date.now()) {
    const u = this.store.data.usage;
    const d = day(t);
    u[tid] ||= {};
    u[tid][d] ||= EMPTY();
    return u[tid][d];
  }

  roomCreated(tid) { this._bucket(tid).rooms++; this.store.save(); }

  peerJoined(tid, concurrent) {
    const b = this._bucket(tid);
    b.joins++;
    b.peakPeers = Math.max(b.peakPeers, concurrent);
    this.store.save();
  }

  addSeconds(tid, sec) {
    if (sec > 0) { this._bucket(tid).peerSeconds += Math.round(sec); this.store.save(); }
  }

  range(tid, days = 30) {
    const out = [];
    const u = this.store.data.usage[tid] || {};
    for (let i = days - 1; i >= 0; i--) {
      const d = day(Date.now() - i * 86400000);
      out.push({ date: d, ...(u[d] || EMPTY()) });
    }
    return out;
  }

  monthPeerMinutes(tid) {
    const prefix = day().slice(0, 7);
    const u = this.store.data.usage[tid] || {};
    let s = 0;
    for (const [d, v] of Object.entries(u)) if (d.startsWith(prefix)) s += v.peerSeconds;
    return Math.round(s / 60);
  }

  prune(keepDays = 400) {
    const cutoff = day(Date.now() - keepDays * 86400000);
    for (const days of Object.values(this.store.data.usage)) {
      for (const d of Object.keys(days)) if (d < cutoff) delete days[d];
    }
    this.store.save();
  }
}

module.exports = { UsageService };
