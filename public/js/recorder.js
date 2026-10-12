// Consent-gated local recording. Nothing is recorded unless every participant
// agrees; the composite is produced and saved only on the requester's device.

import { h, randomId, formatDuration } from './util.js';
import { audioContext } from './media.js';

const CONSENT_TIMEOUT_MS = 30000;

export class Recorder {
  constructor(app) {
    this.app = app;
    this.active = null;    // { id, recorder, chunks, canvas, raf, startedAt, sources }
    this.pending = null;   // { id, waiting:Set, resolve }
    this.remote = new Map(); // peerId -> recording by that peer (for the indicator)
  }

  get recording() { return Boolean(this.active); }

  // ---- requester ---------------------------------------------------------------
  async request() {
    if (this.active || this.pending) return;
    if (typeof MediaRecorder === 'undefined') throw new Error('Recording is not supported in this browser.');
    const peers = [...this.app.peers.keys()];
    const id = randomId(6);
    const ok = await this.#askConsent(id, peers);
    if (!ok.granted) return ok;
    this.#start(id);
    return ok;
  }

  #askConsent(id, peers) {
    if (!peers.length) return Promise.resolve({ granted: true });
    return new Promise((resolve) => {
      const waiting = new Set(peers);
      const timer = setTimeout(() => finish({ granted: false, reason: 'timeout', who: [...waiting] }), CONSENT_TIMEOUT_MS);
      const finish = (r) => { clearTimeout(timer); this.pending = null; resolve(r); };
      this.pending = { id, waiting, finish };
      for (const p of peers) this.app.sendTo(p, { type: 'rec-request', id });
    });
  }

  // A participant joined mid-recording: they must consent too, or it stops.
  async peerJoined(peerId) {
    if (!this.active) return;
    const r = await this.#askConsent(this.active.id, [peerId]);
    if (!r.granted && this.active) {
      this.stop();
      this.app.onRecordingDenied(r);
    } else if (this.active) {
      // Their audio track may still be negotiating; give it a moment.
      setTimeout(() => this.active?.addAudio(this.app.peers.get(peerId)?.remoteStream.getAudioTracks()[0]), 1500);
    }
  }

  handleConsent(peerId, m) {
    const p = this.pending;
    if (!p || m.id !== p.id || !p.waiting.has(peerId)) return;
    if (m.ok !== true) return p.finish({ granted: false, reason: 'declined', who: [peerId] });
    p.waiting.delete(peerId);
    if (!p.waiting.size) p.finish({ granted: true });
  }

  peerLeft(peerId) {
    const p = this.pending;
    if (p?.waiting.delete(peerId) && !p.waiting.size) p.finish({ granted: true });
    this.remote.delete(peerId);
  }

  #start(id) {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d', { alpha: false });
    const actx = audioContext();
    const dest = actx.createMediaStreamDestination();
    const sources = [];
    const addAudio = (track) => {
      if (!track) return;
      try { const s = actx.createMediaStreamSource(new MediaStream([track])); s.connect(dest); sources.push(s); } catch { /* ended track */ }
    };
    addAudio(this.app.media.audioTrack);
    for (const p of this.app.peers.values()) addAudio(p.remoteStream.getAudioTracks()[0]);

    const stream = new MediaStream([...canvas.captureStream(25).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    const recorder = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 2_500_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => this.#save(chunks, recorder.mimeType || mime || 'video/webm');
    recorder.start(1000);

    const draw = () => {
      if (!this.active) return;
      this.#compose(ctx, canvas);
      this.active.raf = setTimeout(draw, 40);
    };
    this.active = { id, recorder, chunks, canvas, sources, addAudio, startedAt: Date.now(), raf: null };
    draw();
    this.app.broadcast({ type: 'rec-state', on: true, id });
    this.app.onRecordingChanged();
  }

  // Lays out every visible tile into the recording canvas.
  #compose(ctx, canvas) {
    const tiles = [...this.app.tiles.entries()];
    ctx.fillStyle = '#07080f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const n = Math.max(1, tiles.length);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const gap = 8;
    const w = (canvas.width - gap * (cols + 1)) / cols;
    const hh = (canvas.height - gap * (rows + 1)) / rows;
    tiles.forEach(([id, t], i) => {
      const x = gap + (i % cols) * (w + gap), y = gap + Math.floor(i / cols) * (hh + gap);
      ctx.fillStyle = '#121527';
      ctx.fillRect(x, y, w, hh);
      const src = t.board ? t.el.querySelector('canvas') : t.video;
      const vw = src?.videoWidth || src?.width, vh = src?.videoHeight || src?.height;
      if (src && vw && vh && !t.el.classList.contains('no-video')) {
        const scale = Math.min(w / vw, hh / vh);
        const dw = vw * scale, dh = vh * scale;
        try { ctx.drawImage(src, x + (w - dw) / 2, y + (hh - dh) / 2, dw, dh); } catch { /* frame not ready */ }
      } else {
        ctx.fillStyle = '#8b5cf6';
        ctx.beginPath();
        ctx.arc(x + w / 2, y + hh / 2, Math.min(w, hh) * 0.16, 0, Math.PI * 2);
        ctx.fill();
      }
      const name = id === 'board' ? 'Whiteboard' : this.app.nameOf(id === 'me' ? 'me' : id);
      ctx.font = '600 18px system-ui, sans-serif';
      const tw = ctx.measureText(name).width;
      ctx.fillStyle = 'rgba(8,9,18,.7)';
      ctx.fillRect(x + 10, y + hh - 40, tw + 20, 30);
      ctx.fillStyle = '#fff';
      ctx.fillText(name, x + 20, y + hh - 19);
    });
    ctx.fillStyle = '#f43f5e';
    ctx.beginPath();
    ctx.arc(canvas.width - 30, 26, 8, 0, Math.PI * 2);
    ctx.fill();
  }

  stop() {
    const a = this.active;
    if (!a) return;
    this.active = null;
    clearTimeout(a.raf);
    try { a.recorder.stop(); } catch { /* already stopped */ }
    a.recorder.stream.getTracks().forEach(t => t.stop());
    a.sources.forEach(s => { try { s.disconnect(); } catch { /* ignore */ } });
    this.app.broadcast({ type: 'rec-state', on: false, id: a.id });
    this.app.onRecordingChanged();
  }

  #save(chunks, type) {
    if (!chunks.length) return;
    const blob = new Blob(chunks, { type });
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const a = h('a', { href: URL.createObjectURL(blob), download: `binarybond-recording-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${ext}` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  elapsed() { return this.active ? formatDuration((Date.now() - this.active.startedAt) / 1000) : ''; }
}
