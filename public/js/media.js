// Local media: device selection, privacy filters applied *before* anything
// leaves the device (video blur/pixelate, voice disguise), screen share, and
// level metering.

import { Emitter, store } from './util.js';

let sharedCtx = null;
export function audioContext() {
  if (!sharedCtx) sharedCtx = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
  if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {});
  return sharedCtx;
}

export class LevelMeter {
  constructor(stream) {
    const ctx = audioContext();
    this.src = ctx.createMediaStreamSource(stream);
    this.an = ctx.createAnalyser();
    this.an.fftSize = 512;
    this.an.smoothingTimeConstant = 0.6;
    this.buf = new Uint8Array(this.an.fftSize);
    this.src.connect(this.an);
  }
  level() {
    this.an.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) { const x = (v - 128) / 128; sum += x * x; }
    return Math.min(1, Math.sqrt(sum / this.buf.length) * 3.2);
  }
  stop() { try { this.src.disconnect(); } catch { /* ignore */ } }
}

// ---- voice disguise -----------------------------------------------------------
// Delay-line pitch shifter (two crossfaded modulated delays) + optional ring mod.
function buildVoiceFx(ctx, input, preset) {
  const out = ctx.createGain();
  if (preset === 'off') { input.connect(out); return { out, stop() {} }; }
  const nodes = [];
  const factor = { deep: 0.72, high: 1.4, robot: 0.92 }[preset] ?? 1;
  const bufferTime = 0.1;
  const len = Math.floor(ctx.sampleRate * bufferTime);
  const ramp = ctx.createBuffer(1, len, ctx.sampleRate);
  const fade = ctx.createBuffer(1, len, ctx.sampleRate);
  const r = ramp.getChannelData(0), f = fade.getChannelData(0);
  const up = factor > 1;
  for (let i = 0; i < len; i++) { r[i] = up ? 1 - i / len : i / len; f[i] = Math.sin(Math.PI * i / len); }
  const depth = Math.abs(1 - factor) * bufferTime;
  const t0 = ctx.currentTime + 0.05;
  for (const offset of [0, bufferTime / 2]) {
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.005;
    const mod = ctx.createBufferSource(); mod.buffer = ramp; mod.loop = true;
    const modGain = ctx.createGain(); modGain.gain.value = depth;
    mod.connect(modGain).connect(delay.delayTime);
    const fadeSrc = ctx.createBufferSource(); fadeSrc.buffer = fade; fadeSrc.loop = true;
    const mix = ctx.createGain(); mix.gain.value = 0;
    fadeSrc.connect(mix.gain);
    input.connect(delay).connect(mix);
    mod.start(t0, offset); fadeSrc.start(t0, offset);
    nodes.push(mod, fadeSrc, delay, mix, modGain);
    if (preset === 'robot') {
      const ring = ctx.createGain(); ring.gain.value = 0;
      const osc = ctx.createOscillator(); osc.frequency.value = 55; osc.connect(ring.gain); osc.start();
      mix.connect(ring).connect(out);
      nodes.push(ring, osc);
    } else {
      mix.connect(out);
    }
  }
  return {
    out,
    stop() { for (const n of nodes) { try { n.stop?.(); } catch { /* not started */ } try { n.disconnect(); } catch { /* ignore */ } } },
  };
}

export class Media extends Emitter {
  constructor() {
    super();
    this.prefs = {
      audioIn: store.get('audioIn', ''), videoIn: store.get('videoIn', ''), audioOut: store.get('audioOut', ''),
      noiseSuppression: store.get('ns', true), echoCancellation: true, autoGainControl: store.get('agc', true),
      hd: store.get('hd', false), videoFx: 'none', voiceFx: 'off', mirror: store.get('mirror', true),
    };
    this.rawAudio = null;   // mic track straight from the device
    this.rawVideo = null;   // camera track straight from the device
    this.audioTrack = null; // what peers receive
    this.videoTrack = null;
    this.screenTrack = null;
    this.micOn = true;
    this.camOn = true;
    this.devices = { audioin: [], videoin: [], audioout: [] };
    this.meter = null;
    this.fx = { audio: null, video: null };
    navigator.mediaDevices?.addEventListener?.('devicechange', () => this.refreshDevices());
  }

  get localPreviewStream() {
    const s = new MediaStream();
    const v = this.screenTrack || this.videoTrack;
    if (v) s.addTrack(v);
    return s;
  }

  async refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return this.devices;
    const list = await navigator.mediaDevices.enumerateDevices();
    const pick = (kind) => list.filter(d => d.kind === kind).map((d, i) => ({ id: d.deviceId, label: d.label || `${kind === 'audioinput' ? 'Microphone' : kind === 'videoinput' ? 'Camera' : 'Speaker'} ${i + 1}` }));
    this.devices = { audioin: pick('audioinput'), videoin: pick('videoinput'), audioout: pick('audiooutput') };
    this.emit('devices', this.devices);
    return this.devices;
  }

  #audioConstraints() {
    const p = this.prefs;
    return { deviceId: p.audioIn ? { exact: p.audioIn } : undefined, noiseSuppression: p.noiseSuppression, echoCancellation: p.echoCancellation, autoGainControl: p.autoGainControl };
  }

  #videoConstraints() {
    const p = this.prefs;
    return { deviceId: p.videoIn ? { exact: p.videoIn } : undefined, width: { ideal: p.hd ? 1280 : 960 }, height: { ideal: p.hd ? 720 : 540 }, frameRate: { ideal: 30, max: 30 } };
  }

  // Requests whatever is available; failing devices degrade gracefully.
  async start({ audio = true, video = true } = {}) {
    const result = { audio: false, video: false, error: null };
    if (!navigator.mediaDevices?.getUserMedia) { result.error = 'unsupported'; return result; }
    if (audio) {
      try { this.rawAudio = (await navigator.mediaDevices.getUserMedia({ audio: this.#audioConstraints() })).getAudioTracks()[0]; result.audio = true; } catch (e) {
        if (this.prefs.audioIn) { this.prefs.audioIn = ''; return this.start({ audio, video }); }
        result.error = e.name;
      }
    }
    if (video) {
      try { this.rawVideo = (await navigator.mediaDevices.getUserMedia({ video: this.#videoConstraints() })).getVideoTracks()[0]; result.video = true; } catch (e) {
        if (this.prefs.videoIn) { this.prefs.videoIn = ''; this.rawAudio?.stop(); return this.start({ audio, video }); }
        result.error ||= e.name;
      }
    }
    this.micOn = Boolean(this.rawAudio);
    this.camOn = Boolean(this.rawVideo);
    await this.#rebuildAudio();
    await this.#rebuildVideo();
    await this.refreshDevices();
    return result;
  }

  async #rebuildAudio() {
    this.fx.audio?.stop();
    this.fx.audio = null;
    this.meter?.stop();
    this.meter = null;
    let track = this.rawAudio;
    if (track) {
      this.meter = new LevelMeter(new MediaStream([track]));
      if (this.prefs.voiceFx !== 'off') {
        const ctx = audioContext();
        const src = ctx.createMediaStreamSource(new MediaStream([track]));
        const fx = buildVoiceFx(ctx, src, this.prefs.voiceFx);
        const dest = ctx.createMediaStreamDestination();
        fx.out.connect(dest);
        track = dest.stream.getAudioTracks()[0];
        this.fx.audio = { stop: () => { fx.stop(); try { src.disconnect(); } catch { /* ignore */ } track.stop(); } };
      } else {
        // Send a clone so muting never silences the local meter (used for the
        // "you're muted" hint); nothing reaches peers while the clone is disabled.
        const clone = track.clone();
        this.fx.audio = { stop: () => clone.stop() };
        track = clone;
      }
      track.enabled = this.micOn;
    }
    this.audioTrack = track;
    this.emit('track', 'audio', track);
  }

  async #rebuildVideo() {
    this.fx.video?.stop();
    this.fx.video = null;
    let track = this.camOn ? this.rawVideo : null;
    if (track && this.prefs.videoFx !== 'none') {
      const fx = filterVideo(track, this.prefs.videoFx);
      this.fx.video = fx;
      track = fx.track;
    }
    this.videoTrack = track;
    if (!this.screenTrack) this.emit('track', 'video', track);
    this.emit('preview');
  }

  setMic(on) {
    this.micOn = on && Boolean(this.rawAudio);
    if (this.audioTrack) this.audioTrack.enabled = this.micOn;
    this.emit('state');
    return this.micOn;
  }

  // Turning the camera off releases the device entirely (the hardware light goes out).
  async setCam(on) {
    if (on && !this.rawVideo) {
      try { this.rawVideo = (await navigator.mediaDevices.getUserMedia({ video: this.#videoConstraints() })).getVideoTracks()[0]; } catch (e) {
        this.emit('error', e.name === 'NotAllowedError' ? 'Camera permission was denied.' : 'Could not start the camera.');
        return false;
      }
    } else if (!on && this.rawVideo) {
      this.rawVideo.stop();
      this.rawVideo = null;
    }
    this.camOn = Boolean(this.rawVideo);
    await this.#rebuildVideo();
    this.emit('state');
    return this.camOn;
  }

  async switchDevice(kind, deviceId) {
    if (kind === 'audioout') { this.prefs.audioOut = deviceId; store.set('audioOut', deviceId); this.emit('sink', deviceId); return; }
    if (kind === 'audioin') {
      this.prefs.audioIn = deviceId; store.set('audioIn', deviceId);
      const old = this.rawAudio;
      try { this.rawAudio = (await navigator.mediaDevices.getUserMedia({ audio: this.#audioConstraints() })).getAudioTracks()[0]; } catch { this.emit('error', 'Could not open that microphone.'); return; }
      old?.stop();
      await this.#rebuildAudio();
    } else {
      this.prefs.videoIn = deviceId; store.set('videoIn', deviceId);
      if (!this.camOn) return;
      this.rawVideo?.stop();
      this.rawVideo = null;
      await this.setCam(true);
    }
  }

  async setPref(key, value) {
    this.prefs[key] = value;
    const persisted = { noiseSuppression: 'ns', autoGainControl: 'agc', hd: 'hd', mirror: 'mirror' };
    if (persisted[key]) store.set(persisted[key], value);
    if (key === 'voiceFx') await this.#rebuildAudio();
    else if (key === 'videoFx') await this.#rebuildVideo();
    else if (key === 'noiseSuppression' || key === 'autoGainControl') {
      await this.rawAudio?.applyConstraints(this.#audioConstraints()).catch(() => {});
    } else if (key === 'hd' && this.rawVideo) {
      await this.rawVideo.applyConstraints(this.#videoConstraints()).catch(() => {});
    }
    this.emit('state');
  }

  async startScreen() {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen sharing is not supported on this device.');
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
    const track = s.getVideoTracks()[0];
    track.contentHint = 'detail';
    track.onended = () => this.stopScreen();
    this.screenTrack = track;
    this.emit('track', 'video', track);
    this.emit('preview');
    this.emit('state');
  }

  stopScreen() {
    if (!this.screenTrack) return;
    this.screenTrack.onended = null;
    this.screenTrack.stop();
    this.screenTrack = null;
    this.emit('track', 'video', this.videoTrack);
    this.emit('preview');
    this.emit('state');
  }

  level() { return this.meter ? this.meter.level() : 0; }

  stop() {
    this.fx.audio?.stop();
    this.fx.video?.stop();
    this.meter?.stop();
    for (const t of [this.rawAudio, this.rawVideo, this.screenTrack, this.audioTrack, this.videoTrack]) t?.stop();
    this.rawAudio = this.rawVideo = this.screenTrack = this.audioTrack = this.videoTrack = null;
  }
}

// Canvas pipeline for privacy filters. Peers only ever receive the filtered frames.
function filterVideo(track, mode) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  video.play().catch(() => {});
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const small = document.createElement('canvas');
  const sctx = small.getContext('2d');
  const out = canvas.captureStream(30).getVideoTracks()[0];
  let running = true;
  const supportsFilter = 'filter' in ctx;

  const draw = () => {
    if (!running) return;
    const w = video.videoWidth, h = video.videoHeight;
    if (w && h) {
      if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
      if (mode === 'blur' && supportsFilter) {
        ctx.filter = `blur(${Math.round(w / 40)}px)`;
        ctx.drawImage(video, 0, 0, w, h);
        ctx.filter = 'none';
      } else {
        const block = mode === 'blur' ? 24 : 14;
        small.width = Math.max(1, Math.round(w / block));
        small.height = Math.max(1, Math.round(h / block));
        sctx.drawImage(video, 0, 0, small.width, small.height);
        ctx.imageSmoothingEnabled = mode === 'blur';
        ctx.drawImage(small, 0, 0, w, h);
      }
    }
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(draw); else setTimeout(draw, 33);
  };
  draw();
  return {
    track: out,
    stop() { running = false; out.stop(); video.srcObject = null; },
  };
}
