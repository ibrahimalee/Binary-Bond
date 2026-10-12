'use strict';
const crypto = require('crypto');
const { safeEq } = require('./tenants');
const { iceServersFor, hasTurn } = require('./ice');

// Zero-knowledge room broker.
//
// Clients derive (roomId, authKey, encKey) from a secret that lives only in the
// URL fragment. The server sees roomId and authKey, stores sha256(authKey), and
// relays end-to-end encrypted envelopes between members. It never sees encKey,
// SDP, ICE candidates, names, or chat.

const ROOM_ID = /^[A-Za-z0-9_-]{22,64}$/;
const AUTH = /^[A-Za-z0-9_-]{43,88}$/;
const CT = /^[A-Za-z0-9_-]{1,65536}$/;
const PEER = /^[a-f0-9]{16}$/;
const MAX_WAITING = 10;
const WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const PUBLIC_TENANT = '_public';

const hashAuth = (a) => crypto.createHash('sha256').update(a).digest();
const roomRef = (id) => crypto.createHash('sha256').update('ref:' + id).digest('hex').slice(0, 16);

class RoomManager {
  constructor({ config, plans, tenants = null, usage = null, webhooks = null, now = Date.now }) {
    this.config = config;
    this.plans = plans;
    this.tenants = tenants;
    this.usage = usage;
    this.webhooks = webhooks;
    this.now = now;
    this.rooms = new Map();
    this.stats = { roomsCreated: 0, joins: 0, denied: 0, relayed: 0, relayedBytes: 0 };
  }

  // ---- entry points (each receives a connection with .send(obj)) ----------

  handle(conn, msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return this._err(conn, 'bad-message');
    switch (msg.t) {
      case 'join': return this.join(conn, msg);
      case 'relay': return this.relay(conn, msg);
      case 'admit': return this.admit(conn, msg);
      case 'kick': return this.kick(conn, msg);
      case 'settings': return this.settings(conn, msg);
      case 'end': return this.endByHost(conn);
      case 'leave': return this.leave(conn);
      case 'ping': return conn.send({ t: 'pong', now: this.now() });
      default: return this._err(conn, 'unknown-type');
    }
  }

  join(conn, msg) {
    if (conn.roomId) return this._err(conn, 'already-joined');
    if (typeof msg.room !== 'string' || !ROOM_ID.test(msg.room) || typeof msg.auth !== 'string' || !AUTH.test(msg.auth)) {
      return this._deny(conn, 'invalid');
    }
    const hello = typeof msg.hello === 'string' && msg.hello.length <= 4096 && CT.test(msg.hello) ? msg.hello : '';

    let room = this.rooms.get(msg.room);
    if (room) {
      if (!safeEq(room.authHash.toString('hex'), hashAuth(msg.auth).toString('hex'))) return this._deny(conn, 'auth');
      if (room.locked) return this._deny(conn, 'locked');
      if (room.peers.size >= room.maxPeers) return this._deny(conn, 'full');
      const peer = this._newPeerId();
      if (room.wait && room.host) {
        if (room.waiting.size >= MAX_WAITING) return this._deny(conn, 'busy');
        const timer = setTimeout(() => this._rejectWaiting(room, peer, 'timeout'), WAIT_TIMEOUT_MS);
        timer.unref?.();
        room.waiting.set(peer, { conn, hello, timer, at: this.now() });
        conn.roomId = room.id; conn.peer = peer; conn.waiting = true;
        conn.send({ t: 'waiting', peer });
        this._sendToHost(room, { t: 'knock', peer, hello });
        return;
      }
      return this._admitInto(room, conn, peer, hello);
    }

    // Create a new room.
    if (this.rooms.size >= this.config.limits.maxRooms) return this._deny(conn, 'capacity');
    let tenant = null, claims = {};
    if (msg.token) {
      const v = this.tenants?.verifyToken(msg.token);
      if (!v) return this._deny(conn, 'token');
      tenant = v.tenant; claims = v.claims;
    }
    const planName = tenant ? tenant.plan : 'public';
    const plan = this.plans[planName] || this.plans.public;
    const tid = tenant ? tenant.id : PUBLIC_TENANT;
    if (tenant && plan.monthlyPeerMinutes > 0 && this.usage && this.usage.monthPeerMinutes(tid) >= plan.monthlyPeerMinutes) {
      return this._deny(conn, 'quota');
    }
    const opts = msg.opts && typeof msg.opts === 'object' ? msg.opts : {};
    const clampInt = (v, max) => (Number.isInteger(v) && v >= 2 ? Math.min(v, max) : max);
    const maxPeers = clampInt(claims.maxPeers ?? opts.maxPeers, plan.maxPeers);
    const maxMinutes = Math.max(1, Number.isInteger(claims.maxMinutes ?? opts.maxMinutes)
      ? Math.min(claims.maxMinutes ?? opts.maxMinutes, plan.maxMinutes) : plan.maxMinutes);
    const relay = Boolean((claims.relay || opts.relay) && plan.relay && hasTurn(this.config));

    const now = this.now();
    room = {
      id: msg.room, ref: roomRef(msg.room), authHash: hashAuth(msg.auth),
      peers: new Map(), waiting: new Map(), host: null,
      locked: false, wait: opts.wait === true, relay,
      tenantId: tid, plan: planName, maxPeers,
      createdAt: now, expiresAt: now + maxMinutes * 60000, peak: 0, timers: [],
    };
    this._schedule(room);
    this.rooms.set(room.id, room);
    this.stats.roomsCreated++;
    this.usage?.roomCreated(tid);
    if (tenant) this.webhooks?.emit(tenant, 'room.created', { room: room.ref, maxPeers, expiresAt: room.expiresAt });
    this._admitInto(room, conn, this._newPeerId(), hello);
  }

  relay(conn, msg) {
    const room = this._memberRoom(conn);
    if (!room) return this._err(conn, 'not-joined');
    if (typeof msg.ct !== 'string' || !CT.test(msg.ct)) return this._err(conn, 'bad-ciphertext');
    const target = room.peers.get(msg.to);
    if (!target || msg.to === conn.peer) return this._err(conn, 'no-such-peer');
    this.stats.relayed++;
    this.stats.relayedBytes += msg.ct.length;
    target.conn.send({ t: 'relay', from: conn.peer, ct: msg.ct });
  }

  admit(conn, msg) {
    const room = this._hostRoom(conn);
    if (!room) return this._err(conn, 'not-host');
    const w = room.waiting.get(msg.peer);
    if (!w) return this._err(conn, 'no-such-peer');
    if (msg.ok !== true) return this._rejectWaiting(room, msg.peer, 'rejected');
    if (room.peers.size >= room.maxPeers) return this._rejectWaiting(room, msg.peer, 'full');
    clearTimeout(w.timer);
    room.waiting.delete(msg.peer);
    w.conn.waiting = false;
    this._admitInto(room, w.conn, msg.peer, w.hello);
  }

  kick(conn, msg) {
    const room = this._hostRoom(conn);
    if (!room) return this._err(conn, 'not-host');
    const target = room.peers.get(msg.peer);
    if (!target || msg.peer === conn.peer) return this._err(conn, 'no-such-peer');
    target.conn.send({ t: 'denied', reason: 'kicked' });
    this._removePeer(room, msg.peer);
  }

  settings(conn, msg) {
    const room = this._hostRoom(conn);
    if (!room) return this._err(conn, 'not-host');
    if (typeof msg.locked === 'boolean') room.locked = msg.locked;
    // Self-destruct: the host may bring the end time forward, never extend it.
    if (Number.isInteger(msg.endInSec) && msg.endInSec >= 30) {
      const at = this.now() + msg.endInSec * 1000;
      if (at < room.expiresAt) { room.expiresAt = at; room.selfDestruct = true; this._schedule(room); }
    }
    if (typeof msg.wait === 'boolean') {
      room.wait = msg.wait;
      if (!room.wait) for (const peer of [...room.waiting.keys()]) this.admit(conn, { peer, ok: true });
    }
    this._broadcast(room, { t: 'settings', locked: room.locked, wait: room.wait, expiresAt: room.expiresAt, selfDestruct: Boolean(room.selfDestruct) });
  }

  endByHost(conn) {
    const room = this._hostRoom(conn);
    if (!room) return this._err(conn, 'not-host');
    this._destroy(room, 'host-ended');
  }

  leave(conn) {
    const room = conn.roomId && this.rooms.get(conn.roomId);
    if (!room) { this._clear(conn); return; }
    if (conn.waiting) {
      const w = room.waiting.get(conn.peer);
      if (w) { clearTimeout(w.timer); room.waiting.delete(conn.peer); this._sendToHost(room, { t: 'knock-cancel', peer: conn.peer }); }
      this._clear(conn);
      return;
    }
    this._removePeer(room, conn.peer);
  }

  snapshot() {
    let peers = 0, waiting = 0;
    for (const r of this.rooms.values()) { peers += r.peers.size; waiting += r.waiting.size; }
    return { rooms: this.rooms.size, peers, waiting, ...this.stats };
  }

  activeForTenant(tid) {
    const out = [];
    for (const r of this.rooms.values()) {
      if (r.tenantId === tid) out.push({ room: r.ref, peers: r.peers.size, createdAt: r.createdAt, expiresAt: r.expiresAt });
    }
    return out;
  }

  shutdown() { for (const r of [...this.rooms.values()]) this._destroy(r, 'server-shutdown'); }

  // ---- internals -----------------------------------------------------------

  _schedule(room) {
    room.timers.forEach(clearTimeout);
    const ttl = Math.max(0, room.expiresAt - this.now());
    room.timers = [setTimeout(() => this._destroy(room, room.selfDestruct ? 'self-destruct' : 'expired'), ttl)];
    if (ttl > 5 * 60000) room.timers.push(setTimeout(() => this._broadcast(room, { t: 'expiring', at: room.expiresAt }), ttl - 5 * 60000));
    room.timers.forEach(t => t.unref?.());
  }


  _admitInto(room, conn, peer, hello) {
    const existing = [...room.peers.keys()];
    room.peers.set(peer, { conn, joinedAt: this.now(), hello });
    if (!room.host) room.host = peer;
    conn.roomId = room.id; conn.peer = peer; conn.waiting = false;
    room.peak = Math.max(room.peak, room.peers.size);
    this.stats.joins++;
    this.usage?.peerJoined(room.tenantId, room.peers.size);
    conn.send({
      t: 'joined', peer, host: room.host,
      peers: existing.map(p => ({ peer: p, hello: room.peers.get(p).hello })),
      ice: iceServersFor(this.config, peer, this.now()),
      relay: room.relay, maxPeers: room.maxPeers, expiresAt: room.expiresAt,
      locked: room.locked, wait: room.wait, plan: room.plan, selfDestruct: Boolean(room.selfDestruct),
      waiting: room.host === peer ? [...room.waiting].map(([p, w]) => ({ peer: p, hello: w.hello })) : [],
    });
    for (const [p, m] of room.peers) if (p !== peer) m.conn.send({ t: 'peer-joined', peer, hello });
    this._tenantEvent(room, 'participant.joined', { peers: room.peers.size });
  }

  _removePeer(room, peer) {
    const m = room.peers.get(peer);
    if (!m) return;
    room.peers.delete(peer);
    this.usage?.addSeconds(room.tenantId, (this.now() - m.joinedAt) / 1000);
    this._clear(m.conn);
    this._tenantEvent(room, 'participant.left', { peers: room.peers.size });
    if (room.peers.size === 0) return this._destroy(room, 'empty');
    this._broadcast(room, { t: 'peer-left', peer });
    if (room.host === peer) {
      room.host = room.peers.keys().next().value; // longest-present member
      this._broadcast(room, { t: 'host', peer: room.host });
      for (const [p, w] of room.waiting) this._sendToHost(room, { t: 'knock', peer: p, hello: w.hello });
    }
  }

  _rejectWaiting(room, peer, reason) {
    const w = room.waiting.get(peer);
    if (!w) return;
    clearTimeout(w.timer);
    room.waiting.delete(peer);
    w.conn.send({ t: 'denied', reason });
    this._clear(w.conn);
    if (reason === 'timeout') this._sendToHost(room, { t: 'knock-cancel', peer });
  }

  _destroy(room, reason) {
    if (this.rooms.get(room.id) !== room) return;
    this.rooms.delete(room.id);
    room.timers.forEach(clearTimeout);
    for (const [, m] of room.peers) {
      this.usage?.addSeconds(room.tenantId, (this.now() - m.joinedAt) / 1000);
      if (reason !== 'empty') m.conn.send({ t: 'ended', reason });
      this._clear(m.conn);
    }
    for (const [, w] of room.waiting) { clearTimeout(w.timer); w.conn.send({ t: 'ended', reason }); this._clear(w.conn); }
    this._tenantEvent(room, 'room.ended', {
      reason, peakPeers: room.peak, durationSec: Math.round((this.now() - room.createdAt) / 1000),
    });
  }

  _tenantEvent(room, type, data) {
    if (room.tenantId === PUBLIC_TENANT || !this.webhooks || !this.tenants) return;
    const tenant = this.tenants.get(room.tenantId);
    if (tenant) this.webhooks.emit(tenant, type, { room: room.ref, ...data });
  }

  _memberRoom(conn) {
    if (!conn.roomId || conn.waiting) return null;
    const room = this.rooms.get(conn.roomId);
    return room && room.peers.get(conn.peer)?.conn === conn ? room : null;
  }

  _hostRoom(conn) {
    const room = this._memberRoom(conn);
    return room && room.host === conn.peer ? room : null;
  }

  _sendToHost(room, msg) { room.peers.get(room.host)?.conn.send(msg); }
  _broadcast(room, msg) { for (const [, m] of room.peers) m.conn.send(msg); }
  _clear(conn) { conn.roomId = null; conn.peer = null; conn.waiting = false; }
  _newPeerId() { return crypto.randomBytes(8).toString('hex'); }
  _err(conn, code) { conn.send({ t: 'error', code }); }
  _deny(conn, reason) { this.stats.denied++; conn.send({ t: 'denied', reason }); }
}

module.exports = { RoomManager, PUBLIC_TENANT, PEER };
