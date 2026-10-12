// Collaborative whiteboard. Strokes travel over the encrypted data channels
// in normalized coordinates, so every screen size renders the same board.

import { h, icon, randomId } from './util.js';

export const COLORS = ['#f8fafc', '#a78bfa', '#22d3ee', '#4ade80', '#fbbf24', '#fb7185'];
const WIDTHS = [2, 5, 12];
const ASPECT = 16 / 9;
const MAX_STROKES = 3000;
const MAX_PTS = 4000;

const validPts = (p) => Array.isArray(p) && p.length <= MAX_PTS && p.length % 2 === 0 && p.every(n => typeof n === 'number' && n >= 0 && n <= 1);

export class Board {
  constructor(app) {
    this.app = app;
    this.strokes = [];     // { key, by, c, w, e, pts }
    this.byKey = new Map();
    this.color = COLORS[1];
    this.width = WIDTHS[1];
    this.erase = false;
    this.open = false;
    this.pending = null;
    this.#build();
  }

  #build() {
    this.canvas = h('canvas.board-canvas', { 'aria-label': 'Shared whiteboard' });
    this.ctx = this.canvas.getContext('2d');
    const swatches = COLORS.map(c => {
      const b = h('button.swatch', { type: 'button', 'aria-label': `Colour ${c}`, onclick: () => { this.color = c; this.erase = false; this.#syncTools(); } });
      b.style.background = c;
      b.dataset.c = c;
      return b;
    });
    const sizes = WIDTHS.map(w => h('button.size', { type: 'button', 'aria-label': `Brush ${w}`, dataset: { w: String(w) }, onclick: () => { this.width = w; this.#syncTools(); } }, h('i')));
    sizes.forEach((b, i) => { b.firstChild.style.width = b.firstChild.style.height = `${4 + i * 4}px`; });
    this.eraserBtn = h('button.icon-btn', { type: 'button', title: 'Eraser', 'aria-label': 'Eraser', onclick: () => { this.erase = !this.erase; this.#syncTools(); } }, icon('trash'));
    this.toolbar = h('div.board-tools', { role: 'toolbar', 'aria-label': 'Whiteboard tools' },
      ...swatches, h('span.board-sep'), ...sizes, h('span.board-sep'),
      h('button.icon-btn', { type: 'button', title: 'Undo my last stroke', 'aria-label': 'Undo', onclick: () => this.undo() }, icon('refresh', 'flip')),
      h('button.icon-btn', { type: 'button', title: 'Clear for everyone', 'aria-label': 'Clear board', onclick: () => this.clear(true) }, icon('x')),
      h('button.icon-btn', { type: 'button', title: 'Download PNG', 'aria-label': 'Download PNG', onclick: () => this.download() }, icon('download')),
      h('button.icon-btn', { type: 'button', title: 'Close whiteboard', 'aria-label': 'Close whiteboard', onclick: () => this.app.toggleBoard(false) }, icon('log-out')));
    this.el = h('div.tile.board', { dataset: { id: 'board' } }, this.canvas, this.toolbar, h('div.board-label', icon('pen'), 'Whiteboard · end-to-end encrypted'));
    this.#syncTools();

    this.canvas.addEventListener('pointerdown', (e) => this.#down(e));
    this.canvas.addEventListener('pointermove', (e) => this.#move(e));
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) this.canvas.addEventListener(ev, () => this.#up());
    new ResizeObserver(() => this.#resize()).observe(this.el);
  }

  #syncTools() {
    for (const b of this.toolbar.querySelectorAll('.swatch')) b.classList.toggle('active', !this.erase && b.dataset.c === this.color);
    for (const b of this.toolbar.querySelectorAll('.size')) b.classList.toggle('active', Number(b.dataset.w) === this.width);
    this.eraserBtn.classList.toggle('on', this.erase);
    this.canvas.style.cursor = this.erase ? 'cell' : 'crosshair';
  }

  // Board area: largest 16:9 rectangle that fits the tile.
  #area() {
    const W = this.canvas.width, H = this.canvas.height;
    let w = W, hgt = W / ASPECT;
    if (hgt > H) { hgt = H; w = H * ASPECT; }
    return { x: (W - w) / 2, y: (H - hgt) / 2, w, h: hgt };
  }

  #resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const r = this.el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.redraw();
  }

  #norm(e) {
    const r = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / r.width;
    const a = this.#area();
    const x = ((e.clientX - r.left) * dpr - a.x) / a.w;
    const y = ((e.clientY - r.top) * dpr - a.y) / a.h;
    return [Math.min(1, Math.max(0, +x.toFixed(4))), Math.min(1, Math.max(0, +y.toFixed(4)))];
  }

  #down(e) {
    if (e.button !== 0) return;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or already released */ }
    const s = { key: `me:${randomId(5)}`, id: null, by: 'me', c: this.color, w: this.width, e: this.erase, pts: this.#norm(e) };
    s.id = s.key.slice(3);
    this.#add(s);
    this.pending = { s, from: 0 };
    this.#drawStroke(s);
    this.flushTimer = setInterval(() => this.#flush(), 40);
  }

  #move(e) {
    const p = this.pending;
    if (!p) return;
    if (e.buttons === 0) return this.#up(); // release happened somewhere we did not see
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) p.s.pts.push(...this.#norm(ev));
    if (p.s.pts.length > MAX_PTS) return this.#up();
    this.#drawTail(p.s, Math.max(0, p.s.pts.length - events.length * 2 - 2));
  }

  #up() {
    if (!this.pending) return;
    this.#flush();
    clearInterval(this.flushTimer);
    this.pending = null;
  }

  #flush() {
    const p = this.pending;
    if (!p || p.from >= p.s.pts.length) return;
    // Overlap one point so segments join seamlessly on the other side.
    const start = Math.max(0, p.from - 2);
    this.app.broadcast({ type: 'wb-seg', id: p.s.id, c: p.s.c, w: p.s.w, e: p.s.e, pts: p.s.pts.slice(start), first: p.from === 0 });
    p.from = p.s.pts.length;
  }

  #add(s) {
    if (this.strokes.length >= MAX_STROKES) this.byKey.delete(this.strokes.shift().key);
    this.strokes.push(s);
    this.byKey.set(s.key, s);
  }

  // ---- remote ----------------------------------------------------------------
  handle(peer, m) {
    switch (m.type) {
      case 'wb-open':
        if (!this.open) this.app.toggleBoard(true, { remote: peer });
        break;
      case 'wb-seg': {
        if (typeof m.id !== 'string' || !validPts(m.pts) || !COLORS.includes(m.c) || !WIDTHS.includes(m.w)) return;
        const key = `${peer}:${m.id.slice(0, 16)}`;
        let s = this.byKey.get(key);
        if (!s) { s = { key, by: peer, c: m.c, w: m.w, e: Boolean(m.e), pts: [] }; this.#add(s); }
        const before = s.pts.length;
        const pts = m.first ? m.pts : m.pts.slice(2); // drop the overlap point
        if (s.pts.length + pts.length > MAX_PTS) return;
        s.pts.push(...pts);
        this.#drawTail(s, Math.max(0, before - 2));
        break;
      }
      case 'wb-undo': {
        const s = this.byKey.get(`${peer}:${String(m.id).slice(0, 16)}`);
        if (s) { this.strokes.splice(this.strokes.indexOf(s), 1); this.byKey.delete(s.key); this.redraw(); }
        break;
      }
      case 'wb-clear':
        this.clear(false);
        this.app.chat.system(`${this.app.nameOf(peer)} cleared the whiteboard`, 'pen');
        break;
      case 'wb-sync':
        if (!Array.isArray(m.strokes) || this.strokes.length) return;
        for (const s of m.strokes.slice(0, MAX_STROKES)) {
          if (!s || !validPts(s.pts) || !COLORS.includes(s.c) || !WIDTHS.includes(s.w)) continue;
          this.#add({ key: `sync:${randomId(5)}`, by: 'sync', c: s.c, w: s.w, e: Boolean(s.e), pts: s.pts });
        }
        this.redraw();
        break;
      default: break;
    }
  }

  // Bring a late joiner up to date, in chunks that fit a data channel message.
  syncTo(peer) {
    if (!this.strokes.length) return;
    let chunk = [], size = 0;
    const send = () => { if (chunk.length) peer.send({ type: 'wb-sync', strokes: chunk }); chunk = []; size = 0; };
    for (const s of this.strokes) {
      const item = { c: s.c, w: s.w, e: s.e, pts: s.pts };
      const len = s.pts.length * 7 + 40;
      if (size + len > 120000) send();
      chunk.push(item);
      size += len;
    }
    send();
    if (this.open) peer.send({ type: 'wb-open' });
  }

  undo() {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const s = this.strokes[i];
      if (s.by !== 'me') continue;
      this.strokes.splice(i, 1);
      this.byKey.delete(s.key);
      this.app.broadcast({ type: 'wb-undo', id: s.id });
      this.redraw();
      return;
    }
  }

  clear(broadcast) {
    this.strokes = [];
    this.byKey.clear();
    this.redraw();
    if (broadcast) this.app.broadcast({ type: 'wb-clear' });
  }

  download() {
    const out = document.createElement('canvas');
    out.width = 1920; out.height = 1080;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#0e1020';
    ctx.fillRect(0, 0, out.width, out.height);
    for (const s of this.strokes) this.#path(ctx, s, { x: 0, y: 0, w: out.width, h: out.height }, 0, true);
    out.toBlob((b) => {
      const a = h('a', { href: URL.createObjectURL(b), download: `whiteboard-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  }

  // ---- drawing ---------------------------------------------------------------
  redraw() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const a = this.#area();
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    ctx.fillRect(a.x, a.y, a.w, a.h);
    for (const s of this.strokes) this.#path(ctx, s, a, 0, false);
  }

  #drawStroke(s) { this.#path(this.ctx, s, this.#area(), 0, false); }
  #drawTail(s, from) { this.#path(this.ctx, s, this.#area(), from, false); }

  #path(ctx, s, a, from, flatEraser) {
    const p = s.pts;
    if (p.length < 2) return;
    ctx.save();
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, (s.e ? s.w * 3 : s.w) * (a.w / 1000));
    if (s.e) {
      if (flatEraser) { ctx.strokeStyle = '#0e1020'; } else { ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = '#000'; }
    } else ctx.strokeStyle = s.c;
    ctx.beginPath();
    const start = Math.max(0, from - (from % 2));
    ctx.moveTo(a.x + p[start] * a.w, a.y + p[start + 1] * a.h);
    if (p.length === 2) ctx.lineTo(a.x + p[0] * a.w + 0.01, a.y + p[1] * a.h);
    for (let i = start + 2; i < p.length; i += 2) ctx.lineTo(a.x + p[i] * a.w, a.y + p[i + 1] * a.h);
    ctx.stroke();
    ctx.restore();
  }
}
