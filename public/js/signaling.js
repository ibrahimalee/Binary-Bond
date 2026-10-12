// Signaling client. Everything addressed to another peer is sealed with the
// room key before it touches the network, with "from|to" bound as AAD.

import { Emitter, sleep } from './util.js';
import { seal, open } from './crypto.js';

export class Signaling extends Emitter {
  constructor({ url, room, auth, key, token = null, opts = {}, hello = {} }) {
    super();
    Object.assign(this, { url, room, auth, key, token, opts, hello });
    this.ws = null;
    this.peer = null;
    this.closed = false;
    this.attempt = 0;
    this.joinedOnce = false;
  }

  async connect() {
    this.closed = false;
    const helloCt = await seal(this.key, this.hello, 'hello');
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      ws.onopen = () => {
        this.attempt = 0;
        const msg = { t: 'join', room: this.room, auth: this.auth, hello: helloCt };
        if (this.token) msg.token = this.token;
        if (!this.joinedOnce) msg.opts = this.opts;
        ws.send(JSON.stringify(msg));
      };
      ws.onmessage = async (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        await this.#dispatch(msg);
        if (msg.t === 'joined' || msg.t === 'waiting') settle(resolve, msg);
        if (msg.t === 'denied' || msg.t === 'ended') settle(reject, Object.assign(new Error(msg.reason), { reason: msg.reason }));
      };
      ws.onerror = () => settle(reject, Object.assign(new Error('network'), { reason: 'network' }));
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.emit('disconnected');
        settle(reject, Object.assign(new Error('network'), { reason: 'network' }));
        if (!this.closed && this.joinedOnce) this.#reconnect();
      };
    });
  }

  async #reconnect() {
    while (!this.closed) {
      const delay = Math.min(15000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() / 2);
      this.emit('reconnecting', { inMs: delay });
      await sleep(delay);
      if (this.closed) return;
      try { await this.connect(); this.emit('reconnected'); return; } catch (e) {
        if (['auth', 'locked', 'full', 'kicked', 'token', 'quota', 'invalid'].includes(e.reason)) { this.emit('denied', e.reason); return; }
      }
    }
  }

  async #dispatch(msg) {
    switch (msg.t) {
      case 'joined': {
        this.peer = msg.peer;
        this.joinedOnce = true;
        msg.peers = await Promise.all(msg.peers.map(async p => ({ ...p, hello: await this.#openHello(p.hello) })));
        msg.waiting = await Promise.all((msg.waiting || []).map(async p => ({ ...p, hello: await this.#openHello(p.hello) })));
        return this.emit('joined', msg);
      }
      case 'waiting': this.peer = msg.peer; return this.emit('waiting', msg);
      case 'peer-joined': return this.emit('peer-joined', { peer: msg.peer, hello: await this.#openHello(msg.hello) });
      case 'knock': return this.emit('knock', { peer: msg.peer, hello: await this.#openHello(msg.hello) });
      case 'relay': {
        try {
          const data = await open(this.key, msg.ct, `${msg.from}|${this.peer}`);
          this.emit('signal', msg.from, data);
        } catch {
          this.emit('tamper', msg.from); // failed authentication: not from a key holder, or altered in transit
        }
        return;
      }
      case 'denied': this.closed = true; return this.emit('denied', msg.reason);
      case 'ended': this.closed = true; return this.emit('ended', msg.reason);
      default: return this.emit(msg.t, msg);
    }
  }

  async #openHello(ct) {
    if (!ct) return {};
    try { return await open(this.key, ct, 'hello'); } catch { return { name: 'Unverified', unverified: true }; }
  }

  #send(obj) { if (this.ws?.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(obj)); return true; } return false; }

  async signal(to, data) {
    const ct = await seal(this.key, data, `${this.peer}|${to}`);
    return this.#send({ t: 'relay', to, ct });
  }

  admit(peer, ok) { this.#send({ t: 'admit', peer, ok }); }
  kick(peer) { this.#send({ t: 'kick', peer }); }
  settings(s) { this.#send({ t: 'settings', ...s }); }
  endForAll() { this.#send({ t: 'end' }); }

  close() {
    this.closed = true;
    this.#send({ t: 'leave' });
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
  }
}
