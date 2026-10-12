// One RTCPeerConnection per remote participant (full mesh).
//
// The newcomer is the initiator for each pair and creates fixed audio/video
// transceivers; the other side adopts them from the first offer. After that
// both sides follow the "perfect negotiation" pattern for ICE restarts, so
// toggling camera, switching devices or screen sharing is a replaceTrack()
// with no renegotiation at all.

import { Emitter } from './util.js';
import { fingerprintsFromSdp, safetyCode } from './crypto.js';

export class Peer extends Emitter {
  constructor({ id, initiator, signaling, iceServers, forceRelay, tracks }) {
    super();
    this.id = id;
    this.initiator = initiator;
    this.polite = !initiator;
    this.signaling = signaling;
    this.tracks = tracks; // { audio, video } current local tracks (may be null)
    this.remoteStream = new MediaStream();
    this.info = { name: 'Guest', mic: true, cam: true, screen: false, hand: false };
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.ctl = null;
    this.file = null;
    this.lastBytes = null;
    this.closed = false;
    this.queue = Promise.resolve();
    this.pendingIce = [];

    this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: forceRelay ? 'relay' : 'all', bundlePolicy: 'max-bundle' });
    this.pc.ontrack = (e) => {
      if (!this.remoteStream.getTracks().includes(e.track)) this.remoteStream.addTrack(e.track);
      e.track.onunmute = () => this.emit('track', e.track);
      this.emit('track', e.track);
    };
    this.pc.onicecandidate = ({ candidate }) => { if (candidate) this.signaling.signal(this.id, { k: 'ice', c: candidate.toJSON() }); };
    this.pc.onnegotiationneeded = () => this.#negotiate();
    this.pc.onconnectionstatechange = () => this.#onState();

    if (initiator) {
      this.audioTx = this.pc.addTransceiver(tracks.audio || 'audio', { direction: 'sendrecv' });
      this.videoTx = this.pc.addTransceiver(tracks.video || 'video', { direction: 'sendrecv' });
      this.#openChannels();
    }
  }

  #openChannels() {
    if (this.ctl) return;
    // Pre-negotiated ids: both sides create identical channels, no ondatachannel races.
    this.ctl = this.pc.createDataChannel('ctl', { negotiated: true, id: 0, ordered: true });
    this.file = this.pc.createDataChannel('file', { negotiated: true, id: 1, ordered: true });
    this.file.binaryType = 'arraybuffer';
    this.file.bufferedAmountLowThreshold = 1 << 20;
    this.ctl.onopen = () => this.emit('open');
    this.ctl.onclose = () => this.emit('channel-closed');
    this.ctl.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m && typeof m.type === 'string') this.emit('ctl', m);
    };
    this.file.onmessage = (e) => this.emit('file-data', e.data);
  }

  async #negotiate() {
    if (this.closed) return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      await this.signaling.signal(this.id, { k: 'sdp', d: this.pc.localDescription.toJSON() });
    } catch (e) {
      console.warn('negotiation failed', e);
    } finally {
      this.makingOffer = false;
    }
  }

  // Signals are applied strictly one at a time: setRemoteDescription is async and
  // candidates must never race ahead of the description they belong to.
  handleSignal(msg) {
    this.queue = this.queue.then(() => this.#handle(msg));
    return this.queue;
  }

  async #handle(msg) {
    if (this.closed || !msg || typeof msg !== 'object') return;
    try {
      if (msg.k === 'sdp' && msg.d && typeof msg.d.sdp === 'string') {
        const desc = msg.d;
        const collision = desc.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await this.pc.setRemoteDescription(desc);
        for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
        if (desc.type === 'offer') {
          if (!this.audioTx) this.#adoptTransceivers();
          await this.pc.setLocalDescription();
          await this.signaling.signal(this.id, { k: 'sdp', d: this.pc.localDescription.toJSON() });
        }
        this.emit('described');
      } else if (msg.k === 'ice' && msg.c) {
        if (!this.pc.remoteDescription) { if (this.pendingIce.length < 200) this.pendingIce.push(msg.c); return; }
        try { await this.pc.addIceCandidate(msg.c); } catch (e) { if (!this.ignoreOffer) throw e; }
      }
    } catch (e) {
      console.warn('signal handling failed', e);
    }
  }

  #adoptTransceivers() {
    for (const tx of this.pc.getTransceivers()) {
      const kind = tx.receiver.track.kind;
      if (kind === 'audio' && !this.audioTx) this.audioTx = tx;
      else if (kind === 'video' && !this.videoTx) this.videoTx = tx;
      else continue;
      tx.direction = 'sendrecv';
      tx.sender.replaceTrack(this.tracks[kind] || null).catch(() => {});
    }
    this.#openChannels();
  }

  #restartTimer = null;
  #onState() {
    const s = this.pc.connectionState;
    this.emit('state', s);
    clearTimeout(this.#restartTimer);
    if (s === 'connected' && this.sendVideo === false) this.setSendVideo(false);
    if (s === 'failed') this.pc.restartIce();
    else if (s === 'disconnected') this.#restartTimer = setTimeout(() => { if (this.pc.connectionState === 'disconnected') this.pc.restartIce(); }, 4000);
  }

  setTrack(kind, track) {
    this.tracks[kind] = track;
    const tx = kind === 'audio' ? this.audioTx : this.videoTx;
    if (tx) return tx.sender.replaceTrack(track || null).catch(e => console.warn('replaceTrack', e));
  }

  async setMaxBitrate(kbps) {
    const sender = this.videoTx?.sender;
    if (!sender) return;
    const p = sender.getParameters();
    if (!p.encodings?.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = kbps * 1000;
    try { await sender.setParameters(p); } catch { /* not yet negotiated */ }
  }

  // Pauses/resumes our outgoing video to this one peer only (their data saver),
  // without touching what everyone else receives.
  async setSendVideo(on) {
    this.sendVideo = on;
    const sender = this.videoTx?.sender;
    if (!sender) return;
    const p = sender.getParameters();
    if (!p.encodings?.length) return;
    p.encodings[0].active = on;
    try { await sender.setParameters(p); } catch { /* not yet negotiated; applied on next call */ }
  }

  send(obj) {
    if (this.ctl?.readyState !== 'open') return false;
    try { this.ctl.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  get isOpen() { return this.ctl?.readyState === 'open'; }

  async safetyCode() {
    const l = this.pc.localDescription?.sdp, r = this.pc.remoteDescription?.sdp;
    if (!l || !r) return null;
    return safetyCode(fingerprintsFromSdp(l), fingerprintsFromSdp(r));
  }

  async stats() {
    const report = await this.pc.getStats();
    const out = { rtt: null, route: null, localType: null, remoteType: null, protocol: null, inKbps: 0, outKbps: 0, loss: 0, fps: null, res: null, codec: null, audioLevel: 0 };
    let pair = null, bytesIn = 0, bytesOut = 0, lost = 0, recv = 0;
    const byId = new Map();
    report.forEach(s => byId.set(s.id, s));
    report.forEach(s => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId);
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded' && !pair) pair = s;
      if (s.type === 'inbound-rtp') {
        bytesIn += s.bytesReceived || 0;
        lost += s.packetsLost || 0;
        recv += s.packetsReceived || 0;
        if (s.kind === 'video') {
          out.fps = s.framesPerSecond ?? out.fps;
          if (s.frameWidth) out.res = `${s.frameWidth}×${s.frameHeight}`;
          const c = byId.get(s.codecId);
          if (c) out.codec = c.mimeType.split('/')[1];
        }
        if (s.kind === 'audio' && typeof s.audioLevel === 'number') out.audioLevel = s.audioLevel;
      }
      if (s.type === 'outbound-rtp') bytesOut += s.bytesSent || 0;
    });
    if (pair) {
      out.rtt = pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null;
      const lc = byId.get(pair.localCandidateId), rc = byId.get(pair.remoteCandidateId);
      out.localType = lc?.candidateType || null;
      out.remoteType = rc?.candidateType || null;
      out.protocol = lc?.protocol || null;
      out.route = out.localType === 'relay' || out.remoteType === 'relay' ? 'relay' : 'direct';
    }
    const now = performance.now();
    if (this.lastBytes) {
      const dt = (now - this.lastBytes.t) / 1000;
      out.inKbps = Math.max(0, Math.round(((bytesIn - this.lastBytes.in) * 8) / 1000 / dt));
      out.outKbps = Math.max(0, Math.round(((bytesOut - this.lastBytes.out) * 8) / 1000 / dt));
    }
    this.lastBytes = { t: now, in: bytesIn, out: bytesOut };
    out.loss = recv + lost > 0 ? +(100 * lost / (recv + lost)).toFixed(1) : 0;
    out.quality = out.rtt == null ? 0 : out.loss > 8 || out.rtt > 600 ? 1 : out.loss > 3 || out.rtt > 300 ? 2 : 3;
    return out;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.#restartTimer);
    try { this.ctl?.close(); this.file?.close(); } catch { /* ignore */ }
    try { this.pc.close(); } catch { /* ignore */ }
    this.remoteStream.getTracks().forEach(t => t.stop());
    this.emit('closed');
  }
}
