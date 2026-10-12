// BinaryBond client entry point.

import { $, $$, h, icon, store, formatDuration, sleep } from './util.js';
import { newSecret, isSecret, deriveRoom, secretFromPassphrase } from './crypto.js';
import { Signaling } from './signaling.js';
import { Peer } from './mesh.js';
import { Media, LevelMeter, audioContext } from './media.js';
import { Transfers, stripMetadata } from './transfer.js';
import { Chat, avatarEl } from './chat.js';
import { peoplePanel, securityPanel, settingsPanel } from './panels.js';
import { toast, modal, confirmDialog, popover, sound, applyTheme, copyText } from './ui.js';
import { qrSvg } from './qr.js';
import { Board } from './board.js';
import { Recorder } from './recorder.js';
import { Captions } from './captions.js';
import { runNetworkCheck } from './netcheck.js';

const REACTIONS = ['👍', '👏', '😂', '❤️', '🎉', '😮', '🤔', '👋'];
const DENY_TEXT = {
  auth: 'That link is not valid for this room.', locked: 'This room is locked by the host.', full: 'This room is full.',
  kicked: 'You were removed from the call by the host.', rejected: 'The host declined your request to join.',
  timeout: 'Nobody let you in. Try again later.', token: 'This session token is invalid or has expired.',
  quota: 'This workspace has used its monthly minutes.', capacity: 'The server is at capacity. Please try again shortly.',
  'rate-limited': 'Too many attempts. Wait a minute and try again.', busy: 'The waiting room is full right now.',
  invalid: 'That room link is not valid.', network: 'Could not reach the server. Check your connection.',
};
const END_TEXT = {
  'host-ended': 'The host ended the call for everyone.', expired: 'This room reached its time limit and was closed.',
  'server-shutdown': 'The server restarted. You can rejoin in a moment.',
  'self-destruct': 'The room self-destructed on schedule. Nothing from it remains on the server.',
};
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, '').trim().slice(0, 40) || 'Guest';

class App {
  constructor() {
    this.media = new Media();
    this.peers = new Map();
    this.tiles = new Map();
    this.meters = new Map();
    this.knocks = new Map();
    this.view = 'home';
    this.unread = 0;
    this.layout = 'auto';
    this.pinned = null;
    this.hand = false;
    this.side = null;
    this.room = {};
    this.me = { peer: null, name: store.get('name', '') };
    this.loops = [];
    this.selfCorner = store.get('selfCorner', 'br');
    this.isEmbed = location.pathname === '/embed';
    this.token = new URLSearchParams(location.search).get('token');
    this.transfers = new Transfers((id) => this.peers.get(id));
    this.chat = new Chat(this);
    this.board = new Board(this);
    this.recorder = new Recorder(this);
    this.captions = new Captions(this);
    this.talk = new Map(); // id -> ms spoken this call (local only, never sent)
  }

  // ===========================================================================
  // boot
  // ===========================================================================
  async init() {
    applyTheme();
    this.#wireHome();
    this.#wireLobby();
    this.#wireCall();
    this.#wireMedia();
    this.#wireTransfers();
    this.#wireGlobal();
    try { this.cfg = await (await fetch('/api/config', { cache: 'no-store' })).json(); } catch { this.cfg = null; }
    this.#applyConfig();
    if (this.isEmbed) await this.#applyEmbed();
    window.addEventListener('hashchange', () => this.route());
    this.route();
    if ('serviceWorker' in navigator && !this.isEmbed) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  route() {
    const fromHash = location.hash.slice(1);
    const saved = sessionStorage.getItem('bb:session');
    if (this.view !== 'home') return;
    if (isSecret(fromHash)) this.openLobby(fromHash, false);
    else if (isSecret(saved)) this.openLobby(saved, sessionStorage.getItem('bb:creator') === '1');
  }

  showView(name) {
    this.view = name;
    $('#app').dataset.view = name;
    for (const s of $$('.view')) s.hidden = s.dataset.view !== name;
    document.body.dataset.view = name;
    window.scrollTo(0, 0);
  }

  #applyConfig() {
    const plan = this.cfg?.plans?.public || { maxPeers: 4 };
    const sel = $('#optMax');
    sel.replaceChildren(...Array.from({ length: plan.maxPeers - 1 }, (_, i) => i + 2).map(n => h('option', { value: String(n), selected: n === plan.maxPeers }, n === 2 ? '2 (one-to-one)' : String(n))));
    $('#optRelayRow').hidden = !this.cfg?.turn;
  }

  async #applyEmbed() {
    document.body.classList.add('embed');
    if (!this.token) return;
    try {
      const { brand } = await (await fetch(`/api/brand?token=${encodeURIComponent(this.token)}`)).json();
      if (!brand) return;
      if (brand.accent) { document.documentElement.style.setProperty('--accent', brand.accent); document.documentElement.style.setProperty('--accent-2', brand.accent); }
      if (brand.name) { $$('.brand-name').forEach(e => { e.textContent = brand.name; }); document.title = brand.name; }
      if (brand.logoUrl) $$('.brand-mark').forEach(e => e.replaceWith(h('img.brand-logo', { src: brand.logoUrl, alt: '' })));
    } catch { /* fall back to default branding */ }
  }

  postParent(type, data = {}) {
    if (this.isEmbed && window.parent !== window) window.parent.postMessage({ source: 'binarybond', type, ...data }, '*');
  }

  // ===========================================================================
  // home
  // ===========================================================================
  #wireHome() {
    for (const tab of $$('#startCard .tab')) {
      tab.addEventListener('click', () => {
        for (const t of $$('#startCard .tab')) { t.classList.toggle('active', t === tab); t.setAttribute('aria-selected', String(t === tab)); }
        for (const p of $$('#startCard .tab-panel')) p.hidden = p.dataset.panel !== tab.dataset.tab;
        $(`#startCard [data-panel="${tab.dataset.tab}"] input`)?.focus();
      });
    }
    $('#newRoomBtn').addEventListener('click', () => this.openLobby(newSecret(), true));
    $('#joinLinkForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('#joinLinkInput').value.trim();
      let secret = v.replace(/^#/, '');
      try { secret = new URL(v).hash.slice(1); } catch { /* raw key */ }
      if (!isSecret(secret)) return toast('That doesn\'t look like a BinaryBond link or room key.', { type: 'warn' });
      this.openLobby(secret, false);
    });
    $('#passForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#passBtn');
      btn.classList.add('loading');
      try {
        const secret = await secretFromPassphrase($('#passRoom').value, $('#passPhrase').value);
        $('#passPhrase').value = '';
        this.openLobby(secret, false);
      } catch (err) { toast(err.message, { type: 'warn' }); } finally { btn.classList.remove('loading'); }
    });
    $('#themeBtn').addEventListener('click', () => {
      const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
      applyTheme(dark ? 'light' : 'dark');
      this.#syncThemeIcon();
    });
    this.#syncThemeIcon();
  }

  #syncThemeIcon() {
    const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
    $('#themeBtn').replaceChildren(icon(dark ? 'sun' : 'moon'));
  }

  inviteLink() { return `${location.origin}${this.isEmbed ? '/embed' : '/'}#${this.secret}`; }

  syncAddressBar() {
    if (!this.secret || this.view === 'home' || this.view === 'ended') return;
    const base = location.pathname + location.search;
    history.replaceState(null, '', store.get('hideLink', true) ? base : `${base}#${this.secret}`);
  }

  // ===========================================================================
  // lobby
  // ===========================================================================
  async openLobby(secret, creator) {
    try { this.derived = await deriveRoom(secret); } catch { return toast(DENY_TEXT.invalid, { type: 'error' }); }
    this.secret = secret;
    this.creator = creator;
    sessionStorage.setItem('bb:session', secret);
    sessionStorage.setItem('bb:creator', creator ? '1' : '0');
    this.showView('lobby');
    this.syncAddressBar();
    $('#lobbyTitle').textContent = creator ? 'Your private room is ready' : 'Ready to join?';
    $('#lobbySub').textContent = creator ? 'Check your camera and mic, then invite people with the link below.' : 'Your camera and mic stay on this device until you join.';
    $('#joinBtn').textContent = creator ? 'Start call' : 'Join now';
    $('#lobbyInvite').hidden = false;
    $('#lobbyLink').value = this.inviteLink();
    $('#nameInput').value = this.me.name;
    this.#updateLobbyAvatar();
    if (!this.media.rawAudio && !this.media.rawVideo) {
      $('#previewStatus').textContent = 'Requesting camera & microphone…';
      const r = await this.media.start();
      $('#previewStatus').textContent = r.audio || r.video ? '' : r.error === 'NotAllowedError'
        ? 'Camera and mic are blocked. You can still join to chat and share files.'
        : 'No camera or microphone found. You can still chat and share files.';
    }
    this.#refreshLobby();
    this.#startLobbyMeter();
    setTimeout(() => $('#nameInput').focus(), 100);
  }

  #wireLobby() {
    $('#lobbyBack').addEventListener('click', () => this.goHome());
    $('#lobbyMic').addEventListener('click', () => { this.media.setMic(!this.media.micOn); this.#refreshLobby(); });
    $('#lobbyCam').addEventListener('click', async () => { await this.media.setCam(!this.media.camOn); this.#refreshLobby(); });
    $('#lobbySettings').addEventListener('click', () => modal({ title: 'Devices & filters', body: settingsPanel(this, { inCall: false }), wide: true }));
    $('#nameInput').addEventListener('input', () => this.#updateLobbyAvatar());
    $('#nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.join(); });
    $('#joinBtn').addEventListener('click', () => this.join());
    $('#lobbyCopy').addEventListener('click', () => copyText(this.inviteLink(), 'Invite link copied'));
    $('#lobbyQr').addEventListener('click', () => this.inviteModal());
    $('#netCheckBtn').addEventListener('click', async () => {
      const body = h('div.check-wait', h('span.spinner'), 'Testing signaling, NAT traversal and devices…');
      const dlg = modal({ title: 'Connection check', body });
      const result = await runNetworkCheck({ stun: this.cfg?.stun, media: this.media });
      body.replaceWith(result);
      void dlg;
    });
    for (const c of $$('[data-vfx]')) c.addEventListener('click', () => this.setVideoFx(c.dataset.vfx));
    for (const c of $$('[data-afx]')) c.addEventListener('click', () => this.setVoiceFx(c.dataset.afx));
    $('#cancelWaitBtn').addEventListener('click', () => { this.teardown(); this.showView('lobby'); this.#refreshLobby(); });
  }

  #updateLobbyAvatar() {
    $('#previewAvatar').replaceChildren(avatarEl('me', $('#nameInput').value || 'You'));
  }

  #refreshLobby() {
    const m = this.media;
    const v = $('#previewVideo');
    const stream = m.localPreviewStream;
    v.srcObject = stream.getVideoTracks().length ? stream : null;
    $('#previewFrame').classList.toggle('mirror', m.prefs.mirror);
    $('#previewAvatar').hidden = Boolean(stream.getVideoTracks().length);
    const mic = $('#lobbyMic'), cam = $('#lobbyCam');
    mic.classList.toggle('off', !m.micOn);
    mic.replaceChildren(icon(m.micOn ? 'mic' : 'mic-off'));
    mic.disabled = !m.rawAudio;
    cam.classList.toggle('off', !m.camOn);
    cam.replaceChildren(icon(m.camOn ? 'cam' : 'cam-off'));
    for (const c of $$('[data-vfx]')) c.classList.toggle('active', c.dataset.vfx === m.prefs.videoFx);
    for (const c of $$('[data-afx]')) c.classList.toggle('active', c.dataset.afx === m.prefs.voiceFx);
  }

  #startLobbyMeter() {
    clearInterval(this.lobbyMeter);
    this.lobbyMeter = setInterval(() => {
      if (this.view !== 'lobby') return clearInterval(this.lobbyMeter);
      $('#previewMeter').style.height = `${Math.round((this.media.micOn ? this.media.level() : 0) * 100)}%`;
    }, 80);
  }

  async setVideoFx(v) {
    await this.media.setPref('videoFx', v);
    if (v !== 'none') toast(v === 'blur' ? 'Your video is blurred before it leaves this device.' : 'Your video is pixelated before it leaves this device.', { type: 'success', timeout: 2600 });
    this.#refreshLobby();
    this.refreshSelfTile();
  }

  async setVoiceFx(v) {
    audioContext();
    await this.media.setPref('voiceFx', v);
    this.#refreshLobby();
  }

  goHome() {
    this.teardown();
    this.media.stop();
    sessionStorage.removeItem('bb:session');
    sessionStorage.removeItem('bb:creator');
    history.replaceState(null, '', location.pathname + location.search);
    this.secret = null;
    this.showView('home');
  }

  // ===========================================================================
  // joining
  // ===========================================================================
  async join() {
    const btn = $('#joinBtn');
    if (btn.classList.contains('loading')) return;
    this.me.name = cleanName($('#nameInput').value || 'Anonymous');
    store.set('name', $('#nameInput').value.trim());
    audioContext();
    btn.classList.add('loading');
    const opts = this.creator ? {
      wait: $('#optWait').checked, maxPeers: Number($('#optMax').value) || undefined, relay: $('#optRelay').checked,
    } : {};
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.sig = new Signaling({
      url: `${proto}//${location.host}/ws?s=${this.derived.roomId.slice(0, 8)}`, room: this.derived.roomId, auth: this.derived.auth, key: this.derived.key,
      token: this.token, opts, hello: { name: this.me.name },
    });
    this.#wireSignaling(this.sig);
    try {
      await this.sig.connect();
    } catch (e) {
      if (!['kicked', 'rejected', 'timeout'].includes(e.reason) && this.view !== 'ended') toast(DENY_TEXT[e.reason] || 'Could not join the room.', { type: 'error', timeout: 6000 });
      this.sig?.close();
      this.sig = null;
    } finally {
      btn.classList.remove('loading');
    }
  }

  #wireSignaling(sig) {
    sig.on('joined', (m) => this.#onJoined(m));
    sig.on('waiting', () => { this.showView('waiting'); this.postParent('waiting'); });
    sig.on('peer-joined', ({ peer, hello }) => {
      this.addPeer(peer, hello, false);
      sound('join');
      this.chat.system(`${this.nameOf(peer)} joined`, 'user-plus');
    });
    sig.on('peer-left', ({ peer }) => this.removePeer(peer, true));
    sig.on('host', ({ peer }) => {
      this.room.host = peer;
      if (peer === this.me.peer) toast('You are now the host of this room.', { type: 'info' });
      this.#refreshPeopleUi();
    });
    sig.on('knock', ({ peer, hello }) => {
      this.knocks.set(peer, { name: cleanName(hello?.name) });
      sound('knock');
      this.notify('Someone is waiting to join', `${cleanName(hello?.name)} is in the waiting room.`);
      this.#refreshPeopleUi();
    });
    sig.on('knock-cancel', ({ peer }) => { this.knocks.delete(peer); this.#refreshPeopleUi(); });
    sig.on('settings', (m) => {
      const lockedChanged = m.locked !== this.room.locked;
      this.room.locked = m.locked;
      this.room.wait = m.wait;
      if (m.selfDestruct && !this.room.selfDestruct) {
        const at = new Date(m.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        this.chat.system(`This room will self-destruct at ${at}`, 'flame');
        toast(`Self-destruct armed: the room ends for everyone at ${at}.`, { type: 'warn', timeout: 6000 });
      }
      if (m.expiresAt) this.room.expiresAt = m.expiresAt;
      this.room.selfDestruct = Boolean(m.selfDestruct);
      $('#lockPill').hidden = !m.locked;
      if (lockedChanged) this.chat.system(m.locked ? 'The room is now locked' : 'The room is unlocked', m.locked ? 'lock' : 'unlock');
      this.#refreshPeopleUi();
    });
    sig.on('expiring', (m) => toast(`This room closes in ${Math.round((m.at - Date.now()) / 60000)} minutes.`, { type: 'warn', timeout: 8000 }));
    sig.on('signal', (from, data) => this.peers.get(from)?.handleSignal(data));
    sig.on('tamper', () => { if (!this.tamperWarned) { this.tamperWarned = true; toast('A signaling message failed authentication and was dropped.', { type: 'error', timeout: 8000 }); } });
    sig.on('denied', (reason) => {
      if (this.view === 'call' || this.view === 'waiting') this.#ended(DENY_TEXT[reason] || 'You were disconnected.', reason === 'kicked' ? 'Removed from the call' : 'Couldn\'t join');
    });
    sig.on('ended', (reason) => this.#ended(this.endedByMe ? 'You ended the call for everyone.' : END_TEXT[reason] || 'The call has ended.', 'Call ended'));
    sig.on('disconnected', () => { if (this.view === 'call') $('#netPill').hidden = false; });
    sig.on('reconnected', () => { $('#netPill').hidden = true; });
  }

  #onJoined(m) {
    const rejoin = this.view === 'call';
    if (rejoin) for (const id of [...this.peers.keys()]) this.removePeer(id, false);
    this.me.peer = m.peer;
    this.room = { host: m.host, locked: m.locked, wait: m.wait, maxPeers: m.maxPeers, expiresAt: m.expiresAt, relay: m.relay, plan: m.plan, selfDestruct: m.selfDestruct };
    this.ice = m.ice;
    this.forceRelay = Boolean(m.relay || (store.get('relay', false) && this.cfg?.turn));
    for (const k of m.waiting || []) this.knocks.set(k.peer, { name: cleanName(k.hello?.name) });
    if (!rejoin) {
      this.showView('call');
      this.syncAddressBar();
      this.joinedAt = Date.now();
      this.peakPeers = 0;
      this.#createTile('me', true);
      this.#startLoops();
      this.chat.system(m.peers.length ? 'You joined the call' : 'You\'re the first one here. Share the invite link to bring others in.', 'shield');
      if (!m.peers.length && !this.isEmbed) setTimeout(() => { if (!this.peers.size && this.view === 'call') this.inviteModal(); }, 600);
    }
    $('#lockPill').hidden = !m.locked;
    for (const p of m.peers) this.addPeer(p.peer, p.hello, true);
    this.#renderKnocks();
    this.#refreshDock();
    this.#layout();
    this.postParent('joined', { participants: this.peers.size + 1 });
  }

  addPeer(id, hello, initiator) {
    if (this.peers.has(id)) return;
    const peer = new Peer({
      id, initiator, signaling: this.sig, iceServers: this.ice, forceRelay: this.forceRelay,
      tracks: { audio: this.media.audioTrack, video: this.media.screenTrack || this.media.videoTrack },
    });
    peer.info.name = cleanName(hello?.name);
    peer.on('open', () => {
      peer.send(this.stateMsg());
      if (this.chat.ttl) peer.send({ type: 'chat-ttl', ttl: this.chat.ttl });
      if (store.get('dataSaver', false)) peer.send({ type: 'video-pref', on: false });
      this.board.syncTo(peer);
      this.captions.peerOpened(peer);
      if (this.recorder.recording) { peer.send({ type: 'rec-state', on: true }); this.recorder.peerJoined(id); }
      this.chat.syncPolls(peer);
      this.#updateTile(id);
    });
    peer.on('ctl', (msg) => this.#onCtl(id, msg));
    peer.on('file-data', (d) => this.transfers.handleData(id, d));
    peer.on('track', () => this.#attachRemote(id));
    peer.on('state', () => this.#updateTile(id));
    this.peers.set(id, peer);
    this.#createTile(id, false);
    this.#attachRemote(id);
    this.#afterPeersChanged();
  }

  removePeer(id, announce) {
    const p = this.peers.get(id);
    if (!p) return;
    const name = p.info.name;
    p.close();
    this.peers.delete(id);
    this.meters.get(id)?.stop();
    this.meters.delete(id);
    this.tiles.get(id)?.el.remove();
    this.tiles.delete(id);
    this.transfers.peerGone(id);
    this.recorder.peerLeft(id);
    this.captions.peerLeft(id);
    if (this.recorder.remote.delete(id)) this.onRecordingChanged();
    if (this.pinned === id) this.pinned = null;
    if (announce) { sound('leave'); this.chat.system(`${name} left`, 'log-out'); }
    this.#afterPeersChanged();
  }

  #afterPeersChanged() {
    this.peakPeers = Math.max(this.peakPeers || 0, this.peers.size);
    this.#layout();
    this.#refreshPeopleUi();
    const n = this.peers.size;
    const kbps = n <= 1 ? 2500 : n === 2 ? 1400 : n <= 4 ? 900 : 600;
    for (const p of this.peers.values()) p.setMaxBitrate(kbps);
    this.postParent('participants', { participants: n + 1 });
  }

  peerCount() { return this.peers.size; }
  isHost() { return this.room.host && this.room.host === this.me.peer; }
  nameOf(id) { return id === 'me' || id === this.me.peer ? this.me.name : this.peers.get(id)?.info.name || 'Someone'; }

  selfInfo() {
    return { name: this.me.name, mic: this.media.micOn, cam: Boolean(this.media.videoTrack), screen: Boolean(this.media.screenTrack), hand: this.hand };
  }
  stateMsg() { return { type: 'state', ...this.selfInfo() }; }

  broadcast(obj) { for (const p of this.peers.values()) p.send(obj); }
  sendTo(id, obj) { this.peers.get(id)?.send(obj); }
  broadcastState() { this.broadcast(this.stateMsg()); }

  #onCtl(id, m) {
    const p = this.peers.get(id);
    if (!p) return;
    switch (m.type) {
      case 'state': {
        const wasHand = p.info.hand;
        p.info = { name: cleanName(m.name), mic: Boolean(m.mic), cam: Boolean(m.cam), screen: Boolean(m.screen), hand: Boolean(m.hand) };
        if (p.info.hand && !wasHand) { p.handAt = Date.now(); sound('hand'); toast(`${p.info.name} raised their hand ✋`, { timeout: 3500 }); this.notify('Hand raised', `${p.info.name} raised their hand.`); }
        if (p.info.screen && !this.pinned && this.layout === 'auto') this.pinned = id;
        if (!p.info.screen && this.pinned === id && this.autoPinned) this.pinned = null;
        this.autoPinned = p.info.screen;
        this.#updateTile(id);
        this.#layout();
        this.#refreshPeopleUi();
        break;
      }
      case 'chat': case 'chat-react': case 'chat-del': case 'chat-burned': case 'chat-ttl': case 'typing':
      case 'poll': case 'poll-vote': case 'poll-close':
        this.chat.handle(id, m, p.info.name);
        if (m.type === 'chat' && document.hidden) this.notify('New encrypted message', `From ${p.info.name}`);
        break;
      case 'wb-open': case 'wb-seg': case 'wb-undo': case 'wb-clear': case 'wb-sync':
        this.board.handle(id, m);
        break;
      case 'rec-request':
        this.#consentPrompt(id, m.id);
        break;
      case 'rec-consent':
        this.recorder.handleConsent(id, m);
        break;
      case 'rec-state':
        if (m.on) this.recorder.remote.set(id, Date.now()); else this.recorder.remote.delete(id);
        this.chat.system(m.on ? `${p.info.name} started recording (everyone agreed)` : `${p.info.name} stopped recording`, 'activity');
        this.onRecordingChanged();
        break;
      case 'cc-want': case 'cc':
        this.captions.handle(id, m);
        break;
      case 'video-pref':
        p.setSendVideo(m.on !== false);
        break;
      case 'file-offer': case 'file-accept': case 'file-decline': case 'file-cancel':
        this.transfers.handleCtl(id, m);
        break;
      case 'reaction':
        if (REACTIONS.includes(m.emoji)) this.#flyReaction(m.emoji, p.info.name);
        break;
      case 'mute-request':
        if (id === this.room.host && this.media.micOn) { this.toggleMic(false); toast(`${p.info.name} (host) muted you.`, { timeout: 5000 }); }
        break;
      default: break;
    }
  }

  // ===========================================================================
  // tiles & layout
  // ===========================================================================
  #createTile(id, self) {
    const video = h('video', { autoplay: true, playsInline: true, muted: self });
    video.disablePictureInPicture = self;
    const nameSpan = h('span');
    const micSlot = h('span.mic-slot');
    const flags = h('div.tile-flags');
    const status = self ? null : h('div.tile-status', 'Connecting…');
    const actions = h('div.tile-actions',
      h('button', { type: 'button', title: 'Pin', 'aria-label': 'Pin', onclick: () => this.togglePin(id) }, icon('pin')),
      self ? null : h('button', { type: 'button', title: 'Picture in picture', 'aria-label': 'Picture in picture', onclick: () => this.pip(id) }, icon('pip')),
      h('button', { type: 'button', title: 'Fullscreen', 'aria-label': 'Fullscreen', onclick: () => el.requestFullscreen?.().catch(() => {}) }, icon('maximize')));
    const el = h(`div.tile${self ? '.self' : ''}`, { dataset: { id }, tabIndex: 0 },
      video, h('div.tile-avatar'), status,
      h('div.tile-bar', h('div.tile-name', micSlot, nameSpan)), flags, actions);
    if (self) this.#makeDraggable(el);
    el.addEventListener('dblclick', () => this.togglePin(id));
    this.tiles.set(id, { el, video, nameSpan, micSlot, flags, status, avatarHost: el.querySelector('.tile-avatar') });
    $('#grid').append(el);
    if (self) this.refreshSelfTile(); else this.#updateTile(id);
  }

  refreshSelfTile() {
    const t = this.tiles.get('me');
    if (!t) return;
    const stream = this.media.localPreviewStream;
    const hasVideo = stream.getVideoTracks().length > 0;
    t.video.srcObject = hasVideo ? stream : null;
    t.el.classList.toggle('mirror', this.media.prefs.mirror && !this.media.screenTrack);
    t.el.classList.toggle('screen', Boolean(this.media.screenTrack));
    this.#paintTile(t, { id: 'me', ...this.selfInfo(), name: `${this.me.name} (you)`, hasVideo });
  }

  #attachRemote(id) {
    const t = this.tiles.get(id), p = this.peers.get(id);
    if (!t || !p) return;
    if (t.video.srcObject !== p.remoteStream) t.video.srcObject = p.remoteStream;
    t.video.play().catch(() => {});
    if (this.media.prefs.audioOut && t.video.setSinkId) t.video.setSinkId(this.media.prefs.audioOut).catch(() => {});
    if (!this.meters.has(id) && p.remoteStream.getAudioTracks().length) {
      try { this.meters.set(id, new LevelMeter(p.remoteStream)); } catch { /* audio context unavailable */ }
    }
    this.#updateTile(id);
  }

  #updateTile(id) {
    if (id === 'me') return this.refreshSelfTile();
    const t = this.tiles.get(id), p = this.peers.get(id);
    if (!t || !p) return;
    const vt = p.remoteStream.getVideoTracks()[0];
    const hasVideo = Boolean(vt && !vt.muted && p.info.cam !== false);
    t.el.classList.toggle('screen', p.info.screen);
    const st = p.pc.connectionState;
    if (t.status) {
      t.status.hidden = st === 'connected';
      t.status.textContent = st === 'failed' ? 'Connection lost — retrying…' : st === 'disconnected' ? 'Reconnecting…' : 'Connecting…';
    }
    this.#paintTile(t, { id, ...p.info, hasVideo, verified: p.verified, quality: p.lastStats?.quality });
  }

  #paintTile(t, info) {
    t.el.classList.toggle('no-video', !info.hasVideo);
    t.nameSpan.textContent = info.name;
    t.micSlot.replaceChildren(icon(info.mic ? 'mic' : 'mic-off', info.mic ? '' : 'off'));
    if (info.verified) t.micSlot.append(icon('shield', 'verified'));
    if (!t.avatarHost.firstChild || t.avatarHost.dataset.name !== info.name) {
      t.avatarHost.dataset.name = info.name;
      t.avatarHost.replaceChildren(avatarEl(info.id, info.name.replace(/ \(you\)$/, '')));
    }
    const flags = [];
    if (info.hand) flags.push(h('span.tile-flag.hand', { title: 'Hand raised' }, icon('hand')));
    if (info.screen) flags.push(h('span.tile-flag', { title: 'Sharing screen' }, icon('screen')));
    if (info.quality) flags.push(h('span.tile-flag', { title: 'Connection quality' }, h(`span.q-bars.q-${info.quality}`, h('i'), h('i'), h('i'))));
    t.flags.replaceChildren(...flags);
  }

  togglePin(id) {
    this.pinned = this.pinned === id ? null : id;
    this.autoPinned = false;
    this.#layout();
  }

  #layout() {
    const grid = $('#grid');
    if (!grid) return;
    const ids = [...this.tiles.keys()];
    const n = ids.length;
    grid.classList.remove('duo', 'spotlight', 'solo');
    for (const t of this.tiles.values()) { t.el.classList.remove('pinned'); t.el.style.order = ''; }
    const self = this.tiles.get('me');
    if (self) for (const p of ['left', 'right', 'top', 'bottom']) self.el.style[p] = '';
    if (this.pinned && this.tiles.has(this.pinned) && n > 1) {
      grid.classList.add('spotlight');
      this.tiles.get(this.pinned).el.classList.add('pinned');
      grid.style.setProperty('--cols', String(Math.max(1, n - 1)));
      return;
    }
    if (n === 1) { grid.classList.add('solo'); grid.style.setProperty('--cols', '1'); grid.style.setProperty('--rows', '1'); return; }
    if (n === 2 && this.layout === 'auto') {
      grid.classList.add('duo');
      this.#placeSelf();
      return;
    }
    const W = grid.clientWidth || innerWidth, H = grid.clientHeight || innerHeight;
    let best = { cols: 1, size: 0 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const w = (W - (cols - 1) * 10) / cols, hh = (H - (rows - 1) * 10) / rows;
      const size = Math.min(w, hh * 16 / 9);
      if (size > best.size) best = { cols, size };
    }
    grid.style.setProperty('--cols', String(best.cols));
    grid.style.setProperty('--rows', String(Math.ceil(n / best.cols)));
    if (self) self.el.style.order = '99';
  }

  #placeSelf() {
    const el = this.tiles.get('me')?.el;
    if (!el) return;
    const c = this.selfCorner;
    el.style.left = c.endsWith('l') ? '16px' : 'auto';
    el.style.right = c.endsWith('r') ? '16px' : 'auto';
    el.style.top = c.startsWith('t') ? '16px' : 'auto';
    el.style.bottom = c.startsWith('b') ? '16px' : 'auto';
  }

  #makeDraggable(el) {
    let start = null;
    el.addEventListener('pointerdown', (e) => {
      if (!$('#grid').classList.contains('duo') || e.target.closest('button')) return;
      const r = el.getBoundingClientRect(), g = $('#grid').getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left - g.left, top: r.top - g.top, g };
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
    });
    el.addEventListener('pointermove', (e) => {
      if (!start) return;
      el.style.right = el.style.bottom = 'auto';
      el.style.left = `${start.left + e.clientX - start.x}px`;
      el.style.top = `${start.top + e.clientY - start.y}px`;
    });
    const end = () => {
      if (!start) return;
      const r = el.getBoundingClientRect(), g = start.g;
      const cx = r.left + r.width / 2 - g.left, cy = r.top + r.height / 2 - g.top;
      this.selfCorner = `${cy < g.height / 2 ? 't' : 'b'}${cx < g.width / 2 ? 'l' : 'r'}`;
      store.set('selfCorner', this.selfCorner);
      start = null;
      el.classList.remove('dragging');
      this.#placeSelf();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  async pip(id) {
    const v = this.tiles.get(id)?.video;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch { toast('Picture-in-picture is not available for this tile.', { type: 'warn' }); }
  }

  // ===========================================================================
  // call controls
  // ===========================================================================
  #wireCall() {
    $('#micBtn').addEventListener('click', () => this.toggleMic());
    $('#camBtn').addEventListener('click', () => this.toggleCam());
    $('#screenBtn').addEventListener('click', () => this.toggleScreen());
    $('#handBtn').addEventListener('click', () => this.toggleHand());
    $('#chatBtn').addEventListener('click', () => this.toggleSide('chat'));
    $('#peopleBtn').addEventListener('click', () => this.toggleSide('people'));
    $('#secureBtn').addEventListener('click', () => this.openSide('security'));
    $('#closeSide').addEventListener('click', () => this.closeSide());
    $('#inviteBtn').addEventListener('click', () => this.inviteModal());
    $('#layoutBtn').addEventListener('click', () => {
      this.layout = this.layout === 'auto' ? 'grid' : 'auto';
      this.pinned = null;
      this.#layout();
      toast(this.layout === 'grid' ? 'Grid layout' : 'Auto layout', { timeout: 1400 });
    });
    for (const t of $$('#sidepanel .tab')) t.addEventListener('click', () => this.openSide(t.dataset.side));
    $('#reactBtn').addEventListener('click', (e) => {
      const row = h('div.emoji-row', REACTIONS.map(emo => h('button', { type: 'button', 'aria-label': `React ${emo}`, onclick: () => { close(); this.react(emo); } }, emo)));
      const close = popover(e.currentTarget, [{ custom: row }]);
    });
    $('#moreBtn').addEventListener('click', (e) => this.#moreMenu(e.currentTarget));
    $('#leaveBtn').addEventListener('click', (e) => {
      if (this.isHost() && this.peers.size) {
        popover(e.currentTarget, [
          { label: 'Leave call', icon: 'log-out', run: () => this.leave() },
          { label: 'End call for everyone', icon: 'trash', danger: true, run: () => this.endForAll() },
        ], { align: 'end' });
      } else this.leave();
    });
    $('#rejoinBtn').addEventListener('click', () => { if (this.secret) this.openLobby(this.secret, false); else this.goHome(); });
    $('#homeBtn').addEventListener('click', () => this.goHome());

    const stage = $('#stage');
    let dragDepth = 0;
    stage.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#dropHint').hidden = false; } });
    stage.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').hidden = true; } });
    stage.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
    stage.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      $('#dropHint').hidden = true;
      if (e.dataTransfer?.files?.length) this.shareFiles([...e.dataTransfer.files]);
    });
    new ResizeObserver(() => this.#layout()).observe(stage);
    stage.append(this.captions.overlay);
    this.captions.overlay.hidden = true;
    setInterval(() => { if (this.recorder.recording) this.onRecordingChanged(); }, 1000);
  }

  toggleMic(force) {
    const on = this.media.setMic(force ?? !this.media.micOn);
    if (!this.media.rawAudio && force === undefined) toast('No microphone is available.', { type: 'warn' });
    this.#afterSelfChange();
    return on;
  }

  async toggleCam() {
    await this.media.setCam(!this.media.camOn);
    this.#afterSelfChange();
  }

  async toggleScreen() {
    if (this.media.screenTrack) { this.media.stopScreen(); return; }
    try {
      await this.media.startScreen();
      toast('You are sharing your screen. Make sure nothing private is visible.', { type: 'info', timeout: 5000 });
    } catch (e) {
      if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast(e.message || 'Screen sharing failed.', { type: 'error' });
    }
  }

  toggleHand() {
    this.hand = !this.hand;
    this.handAt = this.hand ? Date.now() : null;
    this.#afterSelfChange();
  }

  react(emoji) {
    this.broadcast({ type: 'reaction', emoji });
    this.#flyReaction(emoji, 'You');
  }

  #flyReaction(emoji, name) {
    const layer = $('#reactionsLayer');
    const el = h('div.flying', emoji, h('small', name));
    el.style.left = `${10 + Math.random() * 75}%`;
    el.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 120)}px`);
    layer.append(el);
    setTimeout(() => el.remove(), 3300);
  }

  #afterSelfChange() {
    this.captions.update();
    this.#refreshDock();
    this.refreshSelfTile();
    this.broadcastState();
    this.#refreshPeopleUi();
    this.#refreshLobby();
  }

  #refreshDock() {
    const m = this.media;
    const mic = $('#micBtn'), cam = $('#camBtn'), scr = $('#screenBtn'), hand = $('#handBtn');
    mic.classList.toggle('off', !m.micOn);
    mic.replaceChildren(icon(m.micOn ? 'mic' : 'mic-off'), h('span.lvl'));
    mic.setAttribute('aria-label', m.micOn ? 'Mute microphone' : 'Unmute microphone');
    mic.setAttribute('aria-pressed', String(!m.micOn));
    cam.classList.toggle('off', !m.camOn);
    cam.replaceChildren(icon(m.camOn ? 'cam' : 'cam-off'));
    cam.setAttribute('aria-label', m.camOn ? 'Turn camera off' : 'Turn camera on');
    scr.classList.toggle('on', Boolean(m.screenTrack));
    scr.replaceChildren(icon(m.screenTrack ? 'screen-off' : 'screen'));
    scr.setAttribute('aria-label', m.screenTrack ? 'Stop sharing' : 'Share screen');
    hand.classList.toggle('on', this.hand);
    hand.setAttribute('aria-pressed', String(this.hand));
    $('#peopleBadge').textContent = this.peers.size ? String(this.peers.size + 1) : '';
    $('#mutedHint').hidden = true;
  }

  #moreMenu(anchor) {
    popover(anchor, [
      { label: 'Settings', icon: 'settings', run: () => this.openSide('settings') },
      { label: 'Security & verification', icon: 'shield', run: () => this.openSide('security') },
      { label: 'Invite people', icon: 'user-plus', run: () => this.inviteModal() },
      '-',
      { label: 'Share screen', icon: 'screen', run: () => this.toggleScreen(), hint: 'S' },
      { label: this.board.open ? 'Hide whiteboard' : 'Whiteboard', icon: 'pen', run: () => this.toggleBoard(!this.board.open), hint: 'W' },
      { label: 'Create a poll', icon: 'chart', run: () => { this.openSide('chat'); this.chat.pollDialog(); } },
      { label: this.captions.wanted ? 'Turn off captions' : 'Live captions (on-device)', icon: 'chat', run: () => this.toggleCaptions() },
      { label: this.recorder.recording ? `Stop recording (${this.recorder.elapsed()})` : 'Record with everyone\'s consent', icon: 'activity', run: () => this.toggleRecording(), danger: this.recorder.recording },
      { label: this.hand ? 'Lower hand' : 'Raise hand', icon: 'hand', run: () => this.toggleHand(), hint: 'H' },
      { label: 'Picture in picture', icon: 'pip', run: () => this.pip(this.pinned || [...this.peers.keys()][0] || 'me'), disabled: !document.pictureInPictureEnabled },
      { label: 'Fullscreen', icon: 'maximize', run: () => this.#fullscreen(), hint: 'F' },
      { label: 'Save chat transcript', icon: 'download', run: () => this.#saveTranscript() },
      { label: 'Keyboard shortcuts', icon: 'keyboard', run: () => this.shortcutsModal(), hint: '?' },
      '-',
      { label: 'Panic wipe', icon: 'panic', danger: true, run: () => this.panic(), hint: '⇧Esc' },
    ], { align: 'end' });
  }

  #fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  #saveTranscript() {
    const text = this.chat.transcript();
    if (!text) return toast('There are no saved-able messages (burn-after-reading notes are excluded).', { type: 'info' });
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: `binarybond-chat-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ===========================================================================
  // side panel
  // ===========================================================================
  toggleSide(tab) { if (this.side === tab) this.closeSide(); else this.openSide(tab); }

  openSide(tab) {
    this.side = tab;
    $('#sidepanel').hidden = false;
    for (const t of $$('#sidepanel .tab')) t.classList.toggle('active', t.dataset.side === tab);
    $('#chatBtn').classList.toggle('on', tab === 'chat');
    $('#peopleBtn').classList.toggle('on', tab === 'people');
    this.#renderSide();
    if (tab === 'chat') { this.unread = 0; this.#renderUnread(); this.chat.focus(); this.chat.list.scrollTop = this.chat.list.scrollHeight; }
    this.#layout();
  }

  closeSide() {
    this.side = null;
    $('#sidepanel').hidden = true;
    $('#chatBtn').classList.remove('on');
    $('#peopleBtn').classList.remove('on');
    this.#layout();
  }

  #renderSide() {
    const body = $('#sideBody');
    if (this.side === 'chat') { if (body.firstChild !== this.chat.el) body.replaceChildren(this.chat.el); return; }
    const scroll = body.querySelector('.side-scroll')?.scrollTop || 0;
    const panel = this.side === 'people' ? peoplePanel(this) : this.side === 'security' ? securityPanel(this) : settingsPanel(this);
    body.replaceChildren(panel);
    panel.scrollTop = scroll;
  }

  #refreshPeopleUi() {
    if (this.side === 'people') this.#renderSide();
    $('#peopleBadge').textContent = this.peers.size ? String(this.peers.size + 1) : '';
    this.#renderKnocks();
  }

  onUnread() {
    if (this.side === 'chat' && !document.hidden) return;
    this.unread++;
    this.#renderUnread();
  }

  #renderUnread() {
    $('#chatBadge').hidden = !this.unread;
    $('#chatBadge').textContent = this.unread > 9 ? '9+' : String(this.unread || '');
    document.title = this.unread ? `(${this.unread}) BinaryBond` : 'BinaryBond';
  }

  // ===========================================================================
  // host tools
  // ===========================================================================
  #renderKnocks() {
    const host = $('#knocks');
    if (!host) return;
    host.replaceChildren();
    if (!this.isHost()) return;
    for (const [peer, k] of this.knocks) {
      host.append(h('div.knock', avatarEl(peer, k.name),
        h('div.knock-text', h('strong', k.name), h('span.muted', 'wants to join')),
        h('button.btn.btn-ghost', { type: 'button', onclick: () => this.admit(peer, false) }, 'Deny'),
        h('button.btn.btn-primary', { type: 'button', onclick: () => this.admit(peer, true) }, 'Admit')));
    }
  }

  admit(peer, ok) {
    this.sig?.admit(peer, ok);
    this.knocks.delete(peer);
    this.#refreshPeopleUi();
  }

  personMenu(anchor, id) {
    const p = this.peers.get(id);
    if (!p) return;
    const items = [
      { label: p.verified ? 'Safety number (verified)' : 'Verify safety number', icon: 'key', run: () => this.showSafety(id) },
      { label: this.pinned === id ? 'Unpin' : 'Pin to stage', icon: 'pin', run: () => this.togglePin(id) },
    ];
    if (this.isHost()) {
      items.push('-',
        { label: 'Ask to mute', icon: 'mic-off', run: () => { p.send({ type: 'mute-request' }); toast(`Asked ${p.info.name} to mute.`, { timeout: 2000 }); }, disabled: !p.info.mic },
        { label: 'Remove from call', icon: 'user-x', danger: true, run: async () => {
          if (await confirmDialog({ title: `Remove ${p.info.name}?`, message: 'They will be disconnected immediately. Lock the room to stop them rejoining with the link.', confirm: 'Remove', danger: true })) this.sig.kick(id);
        } });
    }
    popover(anchor, items, { align: 'end' });
  }

  async showSafety(id) {
    const p = this.peers.get(id);
    if (!p) return;
    const code = await p.safetyCode();
    if (!code) return toast('Still connecting. Try again in a moment.', { type: 'info' });
    modal({
      title: `Verify ${p.info.name}`,
      body: h('div.sas',
        h('p.muted', 'Compare these with what ', h('strong', p.info.name), ' sees, over the call or in person. If they match, your connection is end-to-end encrypted with no one in the middle.'),
        h('div.sas-emoji', code.emoji.map(e => h('span', e))),
        h('div.sas-digits', code.digits)),
      actions: [
        { label: 'They don\'t match', kind: 'btn-ghost', run: () => { p.verified = false; this.#updateTile(id); toast('Do not share anything sensitive. Leave and start a new room over a trusted channel.', { type: 'error', timeout: 9000 }); } },
        { label: 'They match', kind: 'btn-primary', icon: 'check', run: () => { p.verified = true; this.#updateTile(id); this.#refreshPeopleUi(); if (this.side === 'security') this.#renderSide(); toast(`${p.info.name} is verified.`, { type: 'success' }); } },
      ],
    });
  }

  endForAll() {
    this.endedByMe = true;
    this.sig?.endForAll();
  }

  inviteModal() {
    const link = this.inviteLink();
    let qr;
    try { qr = h('div.qr-box', qrSvg(link)); } catch { qr = null; }
    modal({
      title: 'Invite people',
      body: h('div',
        qr,
        h('div.invite-row', h('input.input.mono', { value: link, readOnly: true, 'aria-label': 'Invite link', onfocus: (e) => e.target.select() }),
          h('button.icon-btn', { type: 'button', 'aria-label': 'Copy link', onclick: () => copyText(link, 'Invite link copied') }, icon('copy'))),
        h('p.field-hint', icon('lock'), 'The key after # never reaches our server. Share it only with people you trust, through a private channel.'),
        this.room.wait ? h('p.field-hint', icon('user-plus'), 'Waiting room is on: you approve each person.') : null),
      actions: [
        navigator.share ? { label: 'Share…', icon: 'share', run: () => { navigator.share({ title: 'Join my private BinaryBond call', url: link }).catch(() => {}); return true; } } : null,
        { label: 'Copy link', kind: 'btn-primary', icon: 'copy', run: () => { copyText(link, 'Invite link copied'); } },
      ].filter(Boolean),
    });
  }

  shortcutsModal() {
    const rows = [['Mute / unmute', ['M']], ['Camera on / off', ['V']], ['Share screen', ['S']], ['Raise hand', ['H']], ['Chat', ['C']], ['People', ['P']], ['Fullscreen', ['F']], ['Whiteboard', ['W']], ['Push to talk (when enabled)', ['Space']], ['Panic wipe', ['Shift', 'Esc']], ['This help', ['?']]];
    modal({ title: 'Keyboard shortcuts', body: h('dl.shortcuts', rows.flatMap(([l, keys]) => [h('dt', l), h('dd', keys.map(k => h('kbd', k)))])) });
  }

  // ===========================================================================
  // files
  // ===========================================================================
  #wireTransfers() {
    const t = this.transfers;
    t.on('offer', (o) => { this.chat.fileIn(o, this.nameOf(o.peer)); if (this.side !== 'chat') toast(`${this.nameOf(o.peer)} wants to send you "${o.name}"`, { action: { label: 'View', run: () => this.openSide('chat') } }); });
    t.on('progress', (p) => this.chat.fileProgress(p));
    t.on('received', (r) => this.chat.fileReceived(r));
    t.on('sent', ({ id }) => this.chat.fileDone(id));
    t.on('declined', ({ peer }) => this.chat.system(`${this.nameOf(peer)} declined a file`, 'x'));
    t.on('cancelled', ({ peer }) => this.chat.system(`A transfer from ${this.nameOf(peer)} was cancelled`, 'x'));
  }

  async shareFiles(files) {
    if (!this.peers.size) return toast('Nobody else is in the call yet.', { type: 'info' });
    this.openSide('chat');
    for (const f of files.slice(0, 10)) {
      try {
        const { file, stripped } = await stripMetadata(f);
        const id = await this.transfers.offer(file, [...this.peers.keys()]);
        this.chat.fileOut({ id, name: file.name, size: file.size, stripped });
      } catch (e) { toast(e.message, { type: 'error' }); }
    }
  }

  // ===========================================================================
  // media & loops
  // ===========================================================================
  #wireMedia() {
    const m = this.media;
    m.on('track', (kind, track) => { for (const p of this.peers.values()) p.setTrack(kind, track); });
    m.on('preview', () => { this.refreshSelfTile(); if (this.view === 'lobby') this.#refreshLobby(); });
    m.on('state', () => { if (this.view === 'call') { this.#refreshDock(); this.broadcastState(); this.refreshSelfTile(); } });
    m.on('error', (msg) => toast(msg, { type: 'error' }));
    m.on('sink', (id) => { for (const t of this.tiles.values()) t.video?.setSinkId?.(id).catch(() => {}); });
  }

  #startLoops() {
    this.#stopLoops();
    let mutedTalk = 0, lastHint = 0;
    this.loops.push(setInterval(() => {
      const lvl = this.media.level();
      const on = this.media.micOn;
      const ring = $('#micBtn .lvl');
      if (ring) ring.style.opacity = on ? String(Math.min(1, lvl * 1.6)) : '0';
      const meTalking = on && lvl > 0.12;
      this.tiles.get('me')?.el.classList.toggle('speaking', meTalking);
      if (meTalking) this.talk.set('me', (this.talk.get('me') || 0) + 100);
      if (!on && lvl > 0.22 && this.media.rawAudio) {
        mutedTalk += 100;
        if (mutedTalk > 700 && Date.now() - lastHint > 20000) {
          lastHint = Date.now();
          $('#mutedHint').hidden = false;
          setTimeout(() => { $('#mutedHint').hidden = true; }, 3500);
        }
      } else mutedTalk = 0;
      for (const [id, meter] of this.meters) {
        const p = this.peers.get(id);
        const talking = Boolean(p?.info.mic) && meter.level() > 0.08;
        this.tiles.get(id)?.el.classList.toggle('speaking', talking);
        if (talking) this.talk.set(id, (this.talk.get(id) || 0) + 100);
      }
    }, 100));
    this.loops.push(setInterval(async () => {
      for (const [id, p] of this.peers) {
        try { p.lastStats = await p.stats(); } catch { continue; }
        p.poorCount = p.lastStats.quality === 1 ? (p.poorCount || 0) + 1 : 0;
        if (p.poorCount === 4 && !store.get('dataSaver', false) && !this.suggestedSaver) {
          this.suggestedSaver = true;
          toast('Your connection looks weak. Data saver pauses incoming video to keep audio clear.', { type: 'warn', timeout: 10000, action: { label: 'Turn on', run: () => this.setDataSaver(true) } });
        }
        this.#updateTile(id);
      }
      // Live panels refresh unless the user is interacting with them.
      if ((this.side === 'security' || this.side === 'people') && !$('#sideBody').contains(document.activeElement)) this.#renderSide();
    }, 2000));
    this.loops.push(setInterval(() => {
      $('#callTimer').textContent = formatDuration((Date.now() - this.joinedAt) / 1000);
      const left = (this.room.expiresAt - Date.now()) / 1000;
      const pill = $('#expiryPill');
      const show = left < 600 || this.room.selfDestruct;
      pill.hidden = !show;
      if (show) pill.querySelector('span').textContent = this.room.selfDestruct ? `Self-destructs in ${formatDuration(left)}` : `${formatDuration(left)} left`;
    }, 1000));
  }

  #stopLoops() { this.loops.forEach(clearInterval); this.loops = []; }

  // ===========================================================================
  // whiteboard, data saver, notifications
  // ===========================================================================
  toggleBoard(on, { remote = null, silent = false } = {}) {
    if (on === this.board.open) return;
    this.board.open = on;
    if (on) {
      this.tiles.set('board', { el: this.board.el, board: true });
      $('#grid').prepend(this.board.el);
      this.pinned = 'board';
      if (remote) toast(`${this.nameOf(remote)} opened the whiteboard`, { timeout: 3000 });
      else this.broadcast({ type: 'wb-open' });
    } else {
      this.tiles.delete('board');
      this.board.el.remove();
      if (this.pinned === 'board') this.pinned = null;
      if (!silent && this.view === 'call') toast('Whiteboard hidden. Drawings are kept until the call ends.', { timeout: 2500 });
    }
    this.#layout();
  }

  setDataSaver(on) {
    store.set('dataSaver', on);
    this.broadcast({ type: 'video-pref', on: !on });
    toast(on ? 'Data saver on: others pause their video to you.' : 'Data saver off.', { type: 'success', timeout: 2500 });
    if (this.side === 'settings') this.#renderSide();
  }

  talkTime(id) { return this.talk.get(id) || 0; }

  async toggleCaptions() {
    if (this.captions.wanted) { await this.captions.setWanted(false); return; }
    let status = await this.captions.probe();
    if (status === 'downloadable') {
      toast('Downloading the on-device speech model…', { timeout: 3000 });
      status = (await this.captions.install()) ? 'available' : 'unsupported';
      this.captions.status = status;
    }
    await this.captions.setWanted(true);
    toast(status === 'available'
      ? 'Live captions on. Speech is transcribed on each speaker\'s own device, never in the cloud.'
      : 'Captions on. Your browser can\'t transcribe privately, so only captions from others will appear.', { timeout: 5000 });
  }

  async toggleRecording() {
    if (this.recorder.recording) { this.recorder.stop(); toast('Recording saved to your device.', { type: 'success' }); return; }
    const ok = await confirmDialog({ title: 'Record this call?', message: 'Everyone in the call will be asked for consent. Recording starts only if all of them agree, and the file is created and saved only on this device.', confirm: 'Ask for consent' });
    if (!ok) return;
    toast('Waiting for everyone to agree…', { timeout: 4000 });
    try {
      const r = await this.recorder.request();
      if (r && !r.granted) this.onRecordingDenied(r);
      else if (this.recorder.recording) toast('Recording started. Everyone can see the REC indicator.', { type: 'success' });
    } catch (e) { toast(e.message, { type: 'error' }); }
  }

  onRecordingDenied(r) {
    const names = (r.who || []).map(id => this.nameOf(id)).join(', ');
    toast(r.reason === 'timeout' ? `No answer from ${names || 'a participant'}: not recording.` : `${names || 'Someone'} declined: not recording.`, { type: 'warn', timeout: 6000 });
  }

  onRecordingChanged() {
    const pill = $('#recPill');
    if (!pill) return;
    const others = [...this.recorder.remote.keys()].map(id => this.nameOf(id));
    const mine = this.recorder.recording;
    pill.hidden = !mine && !others.length;
    pill.querySelector('span').textContent = mine ? `REC ${this.recorder.elapsed()}` : `REC · ${others.join(', ')}`;
  }

  #consentPrompt(peer, reqId) {
    const name = this.nameOf(peer);
    sound('knock');
    let answered = false;
    const answer = (ok) => { if (answered) return; answered = true; clearTimeout(timer); this.sendTo(peer, { type: 'rec-consent', id: reqId, ok }); };
    const dlg = modal({
      title: 'Allow recording?',
      body: h('div', h('p', h('strong', name), ' wants to record this call, including your audio and video.'),
        h('ul.list-plain', h('li', icon('check', 'yes'), 'The recording is made and saved only on their device'),
          h('li', icon('check', 'yes'), 'Nothing is uploaded to any server'),
          h('li', icon('info', 'no'), 'You\'ll see a REC indicator for as long as it runs'))),
      actions: [
        { label: 'Decline', kind: 'btn-ghost', run: () => answer(false) },
        { label: 'Allow', kind: 'btn-primary', run: () => answer(true) },
      ],
      onClose: () => answer(false),
    });
    const timer = setTimeout(() => { answer(false); dlg.close(); }, 28000);
  }

  refreshSettings() { if (this.side === 'settings') this.#renderSide(); }

  async enableNotifications(on) {
    if (on && 'Notification' in window && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission().catch(() => 'denied');
      if (p !== 'granted') { toast('Notifications were blocked by the browser.', { type: 'warn' }); store.set('notify', false); return false; }
    }
    store.set('notify', on);
    return on;
  }

  // Only generic text: message contents are never put in OS notifications.
  notify(title, body) {
    if (!document.hidden || !store.get('notify', false) || !('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, { body, icon: '/icon.svg', tag: 'binarybond' });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* notifications unavailable */ }
  }

  // ===========================================================================
  // leaving
  // ===========================================================================
  leave() {
    this.#ended('Nothing from this call was stored. Messages and files existed only on your devices.', 'You left the call');
  }

  #ended(sub, title) {
    const duration = this.joinedAt ? formatDuration((Date.now() - this.joinedAt) / 1000) : null;
    const peak = this.peakPeers || 0;
    this.teardown();
    this.media.stop();
    $('#endedTitle').textContent = title;
    $('#endedSub').textContent = sub;
    $('#endedStats').textContent = duration ? `Duration ${duration}${peak ? ` · ${peak + 1} participants` : ''}` : '';
    this.showView('ended');
    history.replaceState(null, '', location.pathname + location.search);
    this.postParent('left');
  }

  teardown() {
    this.#stopLoops();
    const sig = this.sig;
    this.sig = null;
    sig?.close();
    for (const id of [...this.peers.keys()]) this.removePeer(id, false);
    for (const t of this.tiles.values()) t.el.remove();
    this.tiles.clear();
    this.knocks.clear();
    this.chat.clear();
    this.recorder.stop();
    this.recorder.remote.clear();
    this.onRecordingChanged();
    this.captions.reset();
    this.toggleBoard(false, { silent: true });
    this.board.clear(false);
    this.talk.clear();
    this.suggestedSaver = false;
    this.handAt = null;
    this.closeSide();
    this.pinned = null;
    this.hand = false;
    this.unread = 0;
    this.#renderUnread();
    this.joinedAt = null;
    this.endedByMe = false;
    this.tamperWarned = false;
    $('#knocks').replaceChildren();
    $('#netPill').hidden = true;
    $('#expiryPill').hidden = true;
    $('#privacyShield').hidden = true;
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  }

  // Instantly destroys everything: connections, devices, local storage, DOM, history entry.
  panic() {
    try { this.sig?.close(); } catch { /* ignore */ }
    for (const p of this.peers.values()) { try { p.close(); } catch { /* ignore */ } }
    try { this.media.stop(); } catch { /* ignore */ }
    store.wipe();
    try { caches?.keys().then(keys => keys.forEach(k => caches.delete(k))); } catch { /* ignore */ }
    document.body.replaceChildren();
    document.title = 'New Tab';
    history.replaceState(null, '', '/');
    location.replace('about:blank');
  }

  // ===========================================================================
  // global behaviour
  // ===========================================================================
  #wireGlobal() {
    let pttActive = false;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && e.shiftKey) { e.preventDefault(); this.panic(); return; }
      if (this.view !== 'call') return;
      const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
      if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
      if (e.code === 'Space' && store.get('ptt', false) && !this.media.micOn && !e.repeat) {
        e.preventDefault(); pttActive = true; this.toggleMic(true); return;
      }
      const k = e.key.toLowerCase();
      const map = { m: () => this.toggleMic(), v: () => this.toggleCam(), s: () => this.toggleScreen(), h: () => this.toggleHand(), c: () => this.toggleSide('chat'), p: () => this.toggleSide('people'), f: () => this.#fullscreen(), w: () => this.toggleBoard(!this.board.open), '?': () => this.shortcutsModal() };
      if (map[k] && !e.repeat) { e.preventDefault(); map[k](); }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && pttActive) { pttActive = false; this.toggleMic(false); }
    });

    const shield = $('#privacyShield');
    window.addEventListener('blur', () => { if (this.view === 'call' && store.get('shield', false)) shield.hidden = false; });
    window.addEventListener('focus', () => { shield.hidden = true; });
    shield.addEventListener('click', () => { shield.hidden = true; });
    document.addEventListener('visibilitychange', async () => {
      if (this.view !== 'call') return;
      if (document.hidden && store.get('bgPause', false) && this.media.camOn) {
        await this.media.setCam(false);
        this.camPausedByBg = true;
        this.#afterSelfChange();
      } else if (!document.hidden && this.camPausedByBg) {
        this.camPausedByBg = false;
        toast('Your camera was paused while you were away.', { action: { label: 'Turn on', run: () => this.toggleCam() }, timeout: 8000 });
      }
      if (!document.hidden && this.side === 'chat') { this.unread = 0; this.#renderUnread(); }
    });
    window.addEventListener('beforeunload', () => { this.sig?.close(); });
    window.addEventListener('pagehide', () => { this.sig?.close(); });
  }
}

const app = new App();
if (store.get('debug', false)) window.binarybond = app; // opt-in: localStorage['bb:debug'] = 'true'
window.addEventListener('DOMContentLoaded', () => app.init());
export default app;
