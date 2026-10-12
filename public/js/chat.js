// Chat panel. Messages exist only in memory on participants' devices and are
// sent over the DTLS-encrypted data channel; nothing is ever relayed by or
// stored on the server.

import { h, icon, randomId, formatBytes, hueOf, initials } from './util.js';
import { sound, modal, toast } from './ui.js';

const QUICK = ['👍', '❤️', '😂', '😮', '🙏', '🔥'];
const BURN_REVEAL_MS = 10000;
const MAX_LEN = 4000;
const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,:;!?)\]]/g;
export const TTL_OPTIONS = [[0, 'Off'], [30, '30 seconds'], [300, '5 minutes'], [3600, '1 hour']];

export class Chat {
  constructor(app) {
    this.app = app;
    this.messages = new Map();
    this.ttl = 0;
    this.burnNext = false;
    this.typing = new Map();
    this.lastTypingSent = 0;
    this.#build();
  }

  #build() {
    this.list = h('div.chat-list', { role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages' });
    this.empty = h('div.chat-empty', icon('lock'), h('p', 'Messages are end-to-end encrypted and exist only on participants\' devices. Nothing is stored.'));
    this.list.append(this.empty);
    this.ttlSelect = h('select.select', { 'aria-label': 'Disappearing messages', onchange: () => this.setTtl(Number(this.ttlSelect.value), true) },
      TTL_OPTIONS.map(([v, l]) => h('option', { value: String(v) }, l)));
    this.typingEl = h('div.typing');
    this.input = h('textarea', {
      rows: 1, maxLength: MAX_LEN, placeholder: 'Message everyone…', 'aria-label': 'Message',
      oninput: () => { this.#autosize(); this.#sendTyping(); this.sendBtn.disabled = !this.input.value.trim(); },
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); } },
      onpaste: (e) => {
        const files = [...(e.clipboardData?.files || [])];
        if (files.length) { e.preventDefault(); this.app.shareFiles(files); }
      },
    });
    this.burnBtn = h('button.icon-btn', { type: 'button', title: 'Burn after reading', 'aria-pressed': 'false', onclick: () => this.toggleBurn() }, icon('flame'));
    this.fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { this.app.shareFiles([...this.fileInput.files]); this.fileInput.value = ''; } });
    this.sendBtn = h('button.send-btn', { type: 'button', 'aria-label': 'Send', disabled: true, onclick: () => this.send() }, icon('send'));
    this.el = h('div.side-body-inner.chat',
      h('div.chat-head', h('span', icon('timer'), ' Disappearing'), this.ttlSelect),
      this.list,
      this.typingEl,
      h('div.composer',
        h('button.icon-btn', { type: 'button', title: 'Share files', 'aria-label': 'Share files', onclick: () => this.fileInput.click() }, icon('clip')),
        h('button.icon-btn.hide-xs', { type: 'button', title: 'Create a poll', 'aria-label': 'Create a poll', onclick: () => this.pollDialog() }, icon('chart')),
        this.burnBtn, this.input, this.fileInput, this.sendBtn));
    this.el.style.display = 'flex';
    this.el.style.flexDirection = 'column';
    this.el.style.flex = '1';
    this.el.style.minHeight = '0';
  }

  #autosize() { this.input.style.height = 'auto'; this.input.style.height = `${Math.min(this.input.scrollHeight, 140)}px`; }

  #sendTyping() {
    const now = Date.now();
    if (now - this.lastTypingSent > 2500 && this.input.value.trim()) { this.lastTypingSent = now; this.app.broadcast({ type: 'typing' }); }
  }

  toggleBurn() {
    this.burnNext = !this.burnNext;
    this.burnBtn.classList.toggle('on', this.burnNext);
    this.burnBtn.setAttribute('aria-pressed', String(this.burnNext));
    this.input.placeholder = this.burnNext ? 'Burn-after-reading message…' : 'Message everyone…';
  }

  setTtl(ttl, local) {
    if (!TTL_OPTIONS.some(([v]) => v === ttl)) return;
    this.ttl = ttl;
    this.ttlSelect.value = String(ttl);
    if (local) {
      this.app.broadcast({ type: 'chat-ttl', ttl });
      this.system(ttl ? `You turned on disappearing messages (${TTL_OPTIONS.find(o => o[0] === ttl)[1]})` : 'You turned off disappearing messages', 'timer');
    }
  }

  focus() { setTimeout(() => this.input.focus(), 50); }

  send() {
    const text = this.input.value.trim().slice(0, MAX_LEN);
    if (!text) return;
    if (!this.app.peerCount()) { this.system('Nobody else is here yet. Messages are never stored, so this one would be lost.', 'info'); return; }
    const msg = { type: 'chat', id: randomId(8), text, ts: Date.now(), ttl: this.ttl, burn: this.burnNext };
    this.app.broadcast(msg);
    this.#add({ ...msg, from: 'me', name: 'You' });
    this.input.value = '';
    this.#autosize();
    this.sendBtn.disabled = true;
    if (this.burnNext) this.toggleBurn();
  }

  // ---- incoming --------------------------------------------------------------
  handle(peerId, m, name) {
    switch (m.type) {
      case 'chat': {
        if (typeof m.id !== 'string' || typeof m.text !== 'string' || this.messages.has(m.id)) return;
        this.typing.delete(peerId);
        this.#renderTyping();
        this.#add({ id: m.id.slice(0, 32), text: m.text.slice(0, MAX_LEN), ts: Date.now(), ttl: Number(m.ttl) || 0, burn: Boolean(m.burn), from: peerId, name });
        sound('message');
        this.app.onUnread();
        break;
      }
      case 'chat-react': {
        const msg = this.messages.get(m.id);
        if (!msg || !QUICK.includes(m.emoji)) return;
        const set = msg.reactions.get(m.emoji) || new Set();
        if (m.on) set.add(peerId); else set.delete(peerId);
        msg.reactions.set(m.emoji, set);
        this.#renderReactions(msg);
        break;
      }
      case 'chat-del': {
        const msg = this.messages.get(m.id);
        if (msg && msg.from === peerId) this.#markDeleted(msg);
        break;
      }
      case 'chat-burned': {
        const msg = this.messages.get(m.id);
        if (msg && msg.from === 'me') { msg.burnedBy = (msg.burnedBy || 0) + 1; msg.footNote.textContent = `🔥 Read & burned${msg.burnedBy > 1 ? ` ×${msg.burnedBy}` : ''}`; }
        break;
      }
      case 'chat-ttl': {
        this.setTtl(Number(m.ttl), false);
        this.system(m.ttl ? `${name} turned on disappearing messages (${TTL_OPTIONS.find(o => o[0] === Number(m.ttl))?.[1]})` : `${name} turned off disappearing messages`, 'timer');
        break;
      }
      case 'typing': {
        clearTimeout(this.typing.get(peerId));
        this.typing.set(peerId, setTimeout(() => { this.typing.delete(peerId); this.#renderTyping(); }, 4000));
        this.#renderTyping();
        break;
      }
      case 'poll': case 'poll-vote': case 'poll-close':
        this.#handlePoll(peerId, m);
        break;
      default: break;
    }
  }

  #renderTyping() {
    const names = [...this.typing.keys()].map(id => this.app.nameOf(id));
    this.typingEl.textContent = names.length === 0 ? '' : names.length === 1 ? `${names[0]} is typing…` : `${names.length} people are typing…`;
  }

  // ---- rendering ---------------------------------------------------------------
  #add(msg) {
    msg.reactions = new Map();
    this.messages.set(msg.id, msg);
    this.empty.remove();
    const mine = msg.from === 'me';
    const prev = this.list.lastElementChild;
    const cont = prev?.dataset.from === msg.from && prev.classList.contains('msg') && msg.ts - Number(prev.dataset.ts) < 120000;
    const bubble = h('div.bubble');
    msg.footNote = h('span');
    const el = h(`div.msg${mine ? '.mine' : ''}${cont ? '.cont' : ''}`, { dataset: { from: msg.from, ts: String(msg.ts), id: msg.id } },
      h('div.msg-meta', mine ? null : h('b', { style: undefined }, msg.name), h('time', new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))),
      bubble,
      h('div.msg-reacts'),
      h('div.msg-foot', msg.ttl ? [icon('timer'), h('span', fmtTtl(msg.ttl))] : null, msg.burn && mine ? [icon('flame'), msg.footNote] : null),
      this.#tools(msg));
    if (!mine) el.querySelector('.msg-meta b').style.color = `hsl(${hueOf(msg.from)} 75% 70%)`;
    msg.el = el;
    msg.bubble = bubble;
    if (msg.burn && !mine) {
      bubble.classList.add('burn');
      bubble.tabIndex = 0;
      bubble.setAttribute('role', 'button');
      bubble.append(icon('flame'), 'Tap to reveal · burns after 10s');
      const reveal = () => this.#revealBurn(msg);
      bubble.addEventListener('click', reveal, { once: true });
      bubble.addEventListener('keydown', (e) => { if (e.key === 'Enter') reveal(); });
    } else {
      renderRich(bubble, msg.text);
    }
    this.#append(el);
    if (msg.ttl) msg.expire = setTimeout(() => this.#remove(msg), msg.ttl * 1000);
  }

  #tools(msg) {
    const mine = msg.from === 'me';
    const tools = h('div.msg-tools');
    for (const e of QUICK.slice(0, 4)) tools.append(h('button', { type: 'button', title: `React ${e}`, onclick: () => this.#react(msg, e) }, e));
    if (mine) tools.append(h('button', { type: 'button', title: 'Unsend for everyone', onclick: () => { this.app.broadcast({ type: 'chat-del', id: msg.id }); this.#markDeleted(msg); } }, icon('trash')));
    else if (!msg.burn) tools.append(h('button', { type: 'button', title: 'Copy', onclick: () => navigator.clipboard.writeText(msg.text).catch(() => {}) }, icon('copy')));
    return tools;
  }

  #react(msg, emoji) {
    const set = msg.reactions.get(emoji) || new Set();
    const on = !set.has('me');
    if (on) set.add('me'); else set.delete('me');
    msg.reactions.set(emoji, set);
    this.app.broadcast({ type: 'chat-react', id: msg.id, emoji, on });
    this.#renderReactions(msg);
  }

  #renderReactions(msg) {
    const host = msg.el.querySelector('.msg-reacts');
    host.replaceChildren();
    for (const [emoji, set] of msg.reactions) {
      if (!set.size) continue;
      host.append(h(`button.msg-react${set.has('me') ? '.mine' : ''}`, { type: 'button', onclick: () => this.#react(msg, emoji) }, emoji, h('span', String(set.size))));
    }
  }

  #revealBurn(msg) {
    msg.bubble.classList.remove('burn');
    msg.bubble.replaceChildren();
    renderRich(msg.bubble, msg.text);
    let left = BURN_REVEAL_MS / 1000;
    const foot = msg.el.querySelector('.msg-foot');
    const counter = h('span', `🔥 ${left}s`);
    foot.append(counter);
    const iv = setInterval(() => { left--; counter.textContent = `🔥 ${left}s`; }, 1000);
    setTimeout(() => {
      clearInterval(iv);
      this.app.sendTo(msg.from, { type: 'chat-burned', id: msg.id });
      msg.text = '';
      msg.bubble.replaceChildren(icon('flame'), ' Burned');
      msg.bubble.classList.add('deleted');
      foot.replaceChildren();
    }, BURN_REVEAL_MS);
  }

  #markDeleted(msg) {
    msg.text = '';
    msg.bubble.className = 'bubble deleted';
    msg.bubble.replaceChildren(msg.from === 'me' ? 'You unsent a message' : 'Message unsent');
    msg.el.querySelector('.msg-tools')?.remove();
    msg.el.querySelector('.msg-reacts')?.replaceChildren();
  }

  #remove(msg) {
    clearTimeout(msg.expire);
    msg.el.animate?.([{ opacity: 1 }, { opacity: 0, transform: 'scale(.96)' }], { duration: 300 }).finished.then(() => msg.el.remove(), () => msg.el.remove());
    if (!msg.el.animate) msg.el.remove();
    if (msg.url) URL.revokeObjectURL(msg.url);
    this.messages.delete(msg.id);
  }

  #append(el) {
    const nearBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 120;
    this.list.append(el);
    if (nearBottom || el.classList.contains('mine')) this.list.scrollTop = this.list.scrollHeight;
  }

  system(text, ic = 'info') {
    this.empty.remove();
    this.#append(h('div.sys-msg', icon(ic), h('span', text)));
  }

  // ---- files --------------------------------------------------------------------
  fileOut({ id, name, size, stripped }) {
    const prog = h('span');
    const card = h('div.file-card', h('div.file-ic', icon('file')), h('div.file-name', name),
      h('div.file-sub', formatBytes(size), stripped ? h('span.ok', '· metadata removed') : null),
      h('div.progress', prog));
    const msg = { id: 'f' + id, from: 'me', ts: Date.now(), el: null, reactions: new Map(), progress: prog, status: card.querySelector('.file-sub') };
    msg.el = h('div.msg.mine', { dataset: { from: 'me', ts: String(msg.ts) } }, h('div.msg-meta', h('time', 'now')), card);
    this.messages.set(msg.id, msg);
    this.empty.remove();
    this.#append(msg.el);
  }

  fileIn({ peer, id, name, size, mime }, name2) {
    const accept = h('button.btn.btn-primary', { type: 'button' }, icon('download'), 'Accept');
    const decline = h('button.btn.btn-ghost', { type: 'button' }, 'Decline');
    const prog = h('span');
    const card = h('div.file-card', h('div.file-ic', icon('file')), h('div.file-name', name),
      h('div.file-sub', `${formatBytes(size)}${mime ? ' · ' + mime.split('/').pop() : ''}`),
      h('div.file-actions', accept, decline));
    const msg = { id: `f${peer}:${id}`, from: peer, ts: Date.now(), reactions: new Map(), card, progress: prog };
    msg.el = h('div.msg', { dataset: { from: peer, ts: String(msg.ts) } }, h('div.msg-meta', h('b', name2)), card);
    msg.el.querySelector('b').style.color = `hsl(${hueOf(peer)} 75% 70%)`;
    accept.onclick = () => { this.app.transfers.accept(peer, id); card.querySelector('.file-actions').replaceWith(h('div.progress', prog)); };
    decline.onclick = () => { this.app.transfers.decline(peer, id); card.querySelector('.file-actions').replaceWith(h('div.file-sub', 'Declined')); };
    this.messages.set(msg.id, msg);
    this.empty.remove();
    this.#append(msg.el);
    sound('message');
    this.app.onUnread();
  }

  fileProgress({ id, peer, dir, done, size }) {
    const msg = this.messages.get(dir === 'out' ? 'f' + id : `f${peer}:${id}`);
    if (msg?.progress) msg.progress.style.width = `${Math.round((done / size) * 100)}%`;
  }

  fileReceived({ peer, id, name, size, mime, blob, verified }) {
    const msg = this.messages.get(`f${peer}:${id}`);
    if (!msg) return;
    const url = URL.createObjectURL(blob);
    msg.url = url;
    const card = msg.card;
    card.querySelector('.progress')?.remove();
    const sub = card.querySelector('.file-sub');
    sub.replaceChildren(formatBytes(size), verified === true ? h('span.ok', '· ✓ verified') : verified === false ? h('span.bad', '· ✗ integrity check failed') : null);
    if (/^image\/(png|jpeg|gif|webp)$/.test(mime) && verified !== false) card.append(h('img.file-preview', { src: url, alt: name }));
    card.append(h('div.file-actions', h('a.btn.btn-primary', { href: url, download: name }, icon('download'), 'Save')));
  }

  fileDone(id) {
    const msg = this.messages.get('f' + id);
    if (msg?.status && !msg.status.querySelector('.sent')) msg.status.append(h('span.ok.sent', '· sent'));
  }

  // ---- polls ------------------------------------------------------------------------
  pollDialog() {
    const q = h('input.input', { maxLength: 200, placeholder: 'What should we decide?', required: true });
    const opts = h('div.poll-opts');
    const addOpt = (v = '') => {
      if (opts.childElementCount >= 6) return;
      const row = h('div.invite-row', h('input.input', { maxLength: 80, value: v, placeholder: `Option ${opts.childElementCount + 1}` }),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Remove option', onclick: () => { if (opts.childElementCount > 2) row.remove(); } }, icon('x')));
      opts.append(row);
    };
    addOpt(); addOpt();
    modal({
      title: 'Create a poll',
      body: h('div', h('label.field', h('span.field-label', 'Question'), q), h('span.field-label', 'Options'), opts,
        h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => addOpt() }, icon('user-plus'), 'Add option'),
        h('p.field-hint', icon('lock'), 'End-to-end encrypted. Results show counts only, never who voted for what.')),
      actions: [{
        label: 'Post poll', kind: 'btn-primary', run: () => {
          const options = [...opts.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
          if (!q.value.trim() || options.length < 2) { toast('Add a question and at least two options.', { type: 'warn' }); return true; }
          const poll = { type: 'poll', id: randomId(6), q: q.value.trim(), options };
          this.app.broadcast(poll);
          this.#addPoll({ ...poll, from: 'me' });
          return false;
        },
      }],
    });
    setTimeout(() => q.focus(), 50);
  }

  polls = new Map();
  pendingVotes = new Map();

  #addPoll({ id, q, options, from }) {
    if (this.polls.has(id)) return;
    const poll = { id, q, options, from, votes: new Map(), closed: false };
    poll.el = h('div.poll-card');
    this.polls.set(id, poll);
    this.empty.remove();
    const wrap = h(`div.msg${from === 'me' ? '.mine' : ''}`, { dataset: { from, ts: String(Date.now()) } },
      h('div.msg-meta', h('b', from === 'me' ? 'You' : this.app.nameOf(from)), h('span', 'started a poll')), poll.el);
    this.#append(wrap);
    for (const v of this.pendingVotes.get(id) || []) poll.votes.set(v.peer, v.idx);
    this.pendingVotes.delete(id);
    this.#renderPoll(poll);
  }

  #vote(poll, idx) {
    if (poll.closed) return;
    const next = poll.votes.get('me') === idx ? -1 : idx;
    if (next < 0) poll.votes.delete('me'); else poll.votes.set('me', next);
    this.app.broadcast({ type: 'poll-vote', id: poll.id, idx: next });
    this.#renderPoll(poll);
  }

  #renderPoll(poll) {
    const counts = poll.options.map(() => 0);
    for (const idx of poll.votes.values()) if (counts[idx] !== undefined) counts[idx]++;
    const total = counts.reduce((s, n) => s + n, 0);
    const mine = poll.votes.get('me');
    poll.el.replaceChildren(
      h('div.poll-q', icon('chart'), h('strong', poll.q)),
      ...poll.options.map((o, i) => {
        const pct = total ? Math.round((counts[i] / total) * 100) : 0;
        const btn = h(`button.poll-opt${mine === i ? '.voted' : ''}`, { type: 'button', disabled: poll.closed, onclick: () => this.#vote(poll, i), 'aria-pressed': String(mine === i) },
          h('span.poll-fill'), h('span.poll-label', o), h('span.poll-pct', `${pct}%`));
        btn.firstChild.style.width = `${pct}%`;
        return btn;
      }),
      h('div.poll-foot', h('span', `${total} vote${total === 1 ? '' : 's'}${poll.closed ? ' · closed' : ''}`),
        poll.from === 'me' && !poll.closed ? h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { poll.closed = true; this.app.broadcast({ type: 'poll-close', id: poll.id }); this.#renderPoll(poll); } }, 'Close poll') : null));
  }

  #handlePoll(peerId, m) {
    if (m.type === 'poll') {
      if (typeof m.id !== 'string' || typeof m.q !== 'string' || !Array.isArray(m.options)) return;
      const options = m.options.filter(o => typeof o === 'string').slice(0, 6).map(o => o.slice(0, 80));
      if (options.length < 2) return;
      this.#addPoll({ id: m.id.slice(0, 16), q: m.q.slice(0, 200), options, from: peerId });
      if (m.closed) { const p = this.polls.get(m.id); if (p) { p.closed = true; this.#renderPoll(p); } }
      sound('message');
      this.app.onUnread();
    } else if (m.type === 'poll-vote') {
      const idx = Number.isInteger(m.idx) ? m.idx : -1;
      const poll = this.polls.get(m.id);
      if (!poll) {
        const list = this.pendingVotes.get(m.id) || [];
        if (this.pendingVotes.size < 50 && list.length < 20) { list.push({ peer: peerId, idx }); this.pendingVotes.set(m.id, list); }
        return;
      }
      if (poll.closed) return;
      if (idx < 0 || idx >= poll.options.length) poll.votes.delete(peerId); else poll.votes.set(peerId, idx);
      this.#renderPoll(poll);
    } else if (m.type === 'poll-close') {
      const poll = this.polls.get(m.id);
      if (poll && poll.from === peerId) { poll.closed = true; this.#renderPoll(poll); }
    }
  }

  // New participants get polls we created, plus our own vote on every poll.
  syncPolls(peer) {
    for (const p of this.polls.values()) {
      if (p.from === 'me') peer.send({ type: 'poll', id: p.id, q: p.q, options: p.options, closed: p.closed });
    }
    for (const p of this.polls.values()) if (p.votes.has('me')) peer.send({ type: 'poll-vote', id: p.id, idx: p.votes.get('me') });
  }

  clear() {
    this.polls.clear();
    this.pendingVotes.clear();
    for (const m of this.messages.values()) { clearTimeout(m.expire); if (m.url) URL.revokeObjectURL(m.url); }
    this.messages.clear();
    this.list.replaceChildren(this.empty);
    for (const t of this.typing.values()) clearTimeout(t);
    this.typing.clear();
    this.typingEl.textContent = '';
    this.setTtl(0, false);
  }

  transcript() {
    return [...this.messages.values()].filter(m => m.text && !m.burn).map(m => `[${new Date(m.ts).toLocaleTimeString()}] ${m.from === 'me' ? 'You' : m.name}: ${m.text}`).join('\n');
  }
}

function fmtTtl(s) { return s >= 3600 ? `${s / 3600}h` : s >= 60 ? `${s / 60}m` : `${s}s`; }

// Safe rich text: links, `code`, **bold**. Built with DOM nodes, never innerHTML.
export function renderRich(parent, text) {
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    inline(parent, text.slice(last, m.index));
    parent.append(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer nofollow' }, m[0]));
    last = m.index + m[0].length;
  }
  inline(parent, text.slice(last));
}
function inline(parent, s) {
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    parent.append(s.slice(last, m.index));
    parent.append(m[1] !== undefined ? h('code', m[1]) : h('strong', m[2]));
    last = m.index + m[0].length;
  }
  parent.append(s.slice(last));
}

export function avatarEl(id, name) {
  const a = h('div.avatar', initials(name));
  a.style.setProperty('--h', hueOf(id));
  return a;
}
