// Private live captions. Each speaker's own browser transcribes their speech
// with ON-DEVICE recognition and sends the text over the encrypted data channel,
// only to participants who asked for captions. Cloud speech services are never
// used: if local recognition isn't available, the feature reports that instead.

import { h, icon, hueOf } from './util.js';

const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
const LINE_TTL = 7000;

export async function captionSupport(lang) {
  if (!SR || typeof SR.available !== 'function') return 'unsupported';
  try {
    const s = await SR.available({ langs: [lang], processLocally: true });
    if (s === 'available') return 'available';
    if (s === 'downloadable' || s === 'downloading') return 'downloadable';
  } catch { /* fall through */ }
  return 'unsupported';
}

export class Captions {
  constructor(app) {
    this.app = app;
    this.lang = navigator.language || 'en-US';
    this.wanted = false;            // I want to see captions
    this.requesters = new Set();    // peers who want to see mine
    this.status = null;             // 'available' | 'downloadable' | 'unsupported'
    this.rec = null;
    this.lines = new Map();         // speaker -> { el, timer }
    this.overlay = h('div.captions', { 'aria-live': 'polite', 'aria-label': 'Live captions' });
  }

  async probe() {
    if (this.status === null) this.status = await captionSupport(this.lang);
    return this.status;
  }

  async setWanted(on) {
    this.wanted = on;
    this.app.broadcast({ type: 'cc-want', on });
    this.overlay.hidden = !on;
    if (!on) { for (const l of this.lines.values()) clearTimeout(l.timer); this.lines.clear(); this.overlay.replaceChildren(); }
    await this.update();
  }

  // Ask once the user has interacted (installation may download a language pack).
  async install() {
    if (!SR?.install) return false;
    try { return Boolean(await SR.install({ langs: [this.lang], processLocally: true })); } catch { return false; }
  }

  handle(peer, m) {
    if (m.type === 'cc-want') {
      if (m.on) this.requesters.add(peer); else this.requesters.delete(peer);
      this.update();
    } else if (m.type === 'cc' && this.wanted && typeof m.text === 'string') {
      this.#show(peer, m.text.slice(0, 300), Boolean(m.final));
    }
  }

  peerOpened(peer) { if (this.wanted) peer.send({ type: 'cc-want', on: true }); }
  peerLeft(id) { this.requesters.delete(id); this.update(); }

  async update() {
    const should = (this.wanted || this.requesters.size > 0) && this.app.media.micOn && this.app.view === 'call';
    if (should && !this.rec) {
      if ((await this.probe()) !== 'available') return;
      this.#start();
    } else if (!should && this.rec) {
      this.#stop();
    }
  }

  #start() {
    const rec = new SR();
    try { rec.processLocally = true; } catch { return; }
    if (rec.processLocally !== true) return; // never allow a silent fallback to cloud recognition
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let text = '', final = false;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        final = e.results[i].isFinal;
      }
      text = text.trim();
      if (!text) return;
      for (const p of this.requesters) this.app.sendTo(p, { type: 'cc', text, final });
      if (this.wanted) this.#show('me', text, final);
    };
    rec.onend = () => { if (this.rec === rec) { this.rec = null; setTimeout(() => this.update(), 300); } };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'language-not-supported') { this.status = 'unsupported'; }
    };
    this.rec = rec;
    try { rec.start(); } catch { this.rec = null; }
  }

  #stop() {
    const rec = this.rec;
    this.rec = null;
    try { rec?.stop(); } catch { /* already stopped */ }
  }

  #show(speaker, text, final) {
    let line = this.lines.get(speaker);
    if (!line) {
      const who = h('b', speaker === 'me' ? 'You' : this.app.nameOf(speaker));
      who.style.color = `hsl(${hueOf(speaker)} 80% 75%)`;
      line = { el: h('div.cc-line', who, h('span')) };
      this.lines.set(speaker, line);
      this.overlay.append(line.el);
    }
    line.el.lastChild.textContent = text;
    line.el.classList.toggle('interim', !final);
    clearTimeout(line.timer);
    line.timer = setTimeout(() => { line.el.remove(); this.lines.delete(speaker); }, LINE_TTL);
  }

  reset() {
    this.#stop();
    this.wanted = false;
    this.requesters.clear();
    for (const l of this.lines.values()) clearTimeout(l.timer);
    this.lines.clear();
    this.overlay.replaceChildren();
    this.overlay.hidden = true;
  }

  static icon() { return icon('chat'); }
}
