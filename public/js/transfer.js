// Peer-to-peer file transfer over the DTLS-encrypted "file" data channel.
// Files never touch a server. Receivers must accept each offer, every file is
// integrity-checked with SHA-256, and photos can be stripped of EXIF/GPS
// metadata before they leave the device.

import { Emitter, randomId } from './util.js';
import { sha256Hex } from './crypto.js';

const CHUNK = 64 * 1024;
const HIGH_WATER = 8 * 1024 * 1024;
export const MAX_FILE = 2 * 1024 * 1024 * 1024;
const HASH_LIMIT = 512 * 1024 * 1024;

export async function stripMetadata(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || typeof createImageBitmap !== 'function') return { file, stripped: false };
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
    const blob = await new Promise(r => canvas.toBlob(r, file.type, 0.92));
    if (!blob) return { file, stripped: false };
    return { file: new File([blob], file.name, { type: file.type, lastModified: Date.now() }), stripped: true };
  } catch {
    return { file, stripped: false };
  }
}

export class Transfers extends Emitter {
  constructor(getPeer) {
    super();
    this.getPeer = getPeer;
    this.outgoing = new Map(); // id -> { file, hash, targets:Set }
    this.incoming = new Map(); // `${peer}:${id}` -> { meta, chunks, received, accepted }
    this.queues = new Map();   // peer -> Promise chain (one transfer per channel at a time)
  }

  async offer(file, peerIds) {
    if (file.size > MAX_FILE) throw new Error('Files up to 2 GB are supported.');
    const id = randomId(6);
    const hash = file.size <= HASH_LIMIT ? await sha256Hex(await file.arrayBuffer()) : null;
    this.outgoing.set(id, { file, hash, targets: new Set(peerIds) });
    for (const p of peerIds) this.getPeer(p)?.send({ type: 'file-offer', id, name: file.name.slice(0, 200), size: file.size, mime: file.type.slice(0, 100) });
    this.emit('offered', { id, name: file.name, size: file.size, peers: peerIds });
    return id;
  }

  handleCtl(peer, m) {
    if (m.type === 'file-offer') {
      if (typeof m.id !== 'string' || typeof m.name !== 'string' || !Number.isFinite(m.size) || m.size < 0 || m.size > MAX_FILE) return;
      const key = `${peer}:${m.id}`;
      this.incoming.set(key, { meta: { id: m.id, name: m.name, size: m.size, mime: m.mime || '' }, chunks: [], received: 0, accepted: false });
      this.emit('offer', { peer, id: m.id, name: m.name, size: m.size, mime: m.mime || '' });
    } else if (m.type === 'file-accept') {
      const out = this.outgoing.get(m.id);
      if (out?.targets.has(peer)) this.#enqueue(peer, () => this.#send(peer, m.id, out));
    } else if (m.type === 'file-decline') {
      this.emit('declined', { peer, id: m.id });
    } else if (m.type === 'file-cancel') {
      this.incoming.delete(`${peer}:${m.id}`);
      this.emit('cancelled', { peer, id: m.id });
    }
  }

  accept(peer, id) {
    const t = this.incoming.get(`${peer}:${id}`);
    if (!t) return;
    t.accepted = true;
    this.getPeer(peer)?.send({ type: 'file-accept', id });
  }

  decline(peer, id) {
    this.incoming.delete(`${peer}:${id}`);
    this.getPeer(peer)?.send({ type: 'file-decline', id });
  }

  #enqueue(peer, job) {
    const prev = this.queues.get(peer) || Promise.resolve();
    const next = prev.then(job, job).catch(e => console.warn('transfer failed', e));
    this.queues.set(peer, next);
    return next;
  }

  async #send(peer, id, out) {
    const p = this.getPeer(peer);
    const ch = p?.file;
    if (!ch || ch.readyState !== 'open') throw new Error('channel closed');
    const { file, hash } = out;
    ch.send(JSON.stringify({ type: 'begin', id, size: file.size, sha256: hash }));
    let sent = 0;
    let lastEmit = 0;
    for (let off = 0; off < file.size; off += CHUNK) {
      if (ch.readyState !== 'open') throw new Error('channel closed');
      if (ch.bufferedAmount > HIGH_WATER) {
        await new Promise(res => { ch.addEventListener('bufferedamountlow', res, { once: true }); });
      }
      const buf = await file.slice(off, off + CHUNK).arrayBuffer();
      ch.send(buf);
      sent += buf.byteLength;
      const now = performance.now();
      if (now - lastEmit > 120) { lastEmit = now; this.emit('progress', { id, peer, dir: 'out', done: sent, size: file.size }); }
    }
    ch.send(JSON.stringify({ type: 'end', id }));
    this.emit('progress', { id, peer, dir: 'out', done: file.size, size: file.size });
    this.emit('sent', { id, peer });
  }

  #active = new Map(); // peer -> key of transfer currently streaming in

  async handleData(peer, data) {
    if (typeof data === 'string') {
      let m;
      try { m = JSON.parse(data); } catch { return; }
      const key = `${peer}:${m.id}`;
      const t = this.incoming.get(key);
      if (!t || !t.accepted) return;
      if (m.type === 'begin') {
        t.expectedHash = typeof m.sha256 === 'string' ? m.sha256 : null;
        this.#active.set(peer, key);
      } else if (m.type === 'end') {
        this.#active.delete(peer);
        this.incoming.delete(key);
        const blob = new Blob(t.chunks, { type: t.meta.mime || 'application/octet-stream' });
        t.chunks = [];
        let verified = null;
        if (t.expectedHash) verified = (await sha256Hex(await blob.arrayBuffer())) === t.expectedHash;
        if (blob.size !== t.meta.size) verified = false;
        this.emit('received', { peer, id: m.id, name: t.meta.name, size: blob.size, mime: t.meta.mime, blob, verified });
      }
      return;
    }
    const key = this.#active.get(peer);
    const t = key && this.incoming.get(key);
    if (!t) return;
    t.chunks.push(data);
    t.received += data.byteLength;
    if (t.received > t.meta.size) { // sender lied about the size: abort
      this.incoming.delete(key);
      this.#active.delete(peer);
      this.emit('cancelled', { peer, id: t.meta.id });
      return;
    }
    const now = performance.now();
    if (!t.lastEmit || now - t.lastEmit > 120 || t.received === t.meta.size) {
      t.lastEmit = now;
      this.emit('progress', { id: t.meta.id, peer, dir: 'in', done: t.received, size: t.meta.size });
    }
  }

  peerGone(peer) {
    for (const key of [...this.incoming.keys()]) if (key.startsWith(peer + ':')) this.incoming.delete(key);
    this.#active.delete(peer);
    this.queues.delete(peer);
  }
}
