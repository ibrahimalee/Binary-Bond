// People, Security and Settings panels for the call side drawer.

import { h, icon, store, formatDuration } from './util.js';
import { avatarEl } from './chat.js';
import { confirmDialog } from './ui.js';

const label = (text, sub) => h('span', h('strong', text), sub ? h('small', sub) : null);

function switchRow(title, sub, checked, onchange, disabled = false) {
  const input = h('input.switch', { type: 'checkbox', checked, disabled, onchange: (e) => onchange(e.target.checked) });
  return h('label.switch-row', label(title, sub), input);
}

function selectRow(title, sub, options, value, onchange) {
  const sel = h('select.select', { onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  return h('label.select-row', label(title, sub), sel);
}

// ---- People -------------------------------------------------------------------
export function peoplePanel(app) {
  const isHost = app.isHost();
  const root = h('div.side-scroll');

  if (isHost && app.knocks.size) {
    const sec = h('div.side-section', h('h4', `Waiting (${app.knocks.size})`));
    for (const [peer, k] of app.knocks) {
      sec.append(h('div.person', avatarEl(peer, k.name), h('div.person-name', h('strong', k.name), h('small', 'wants to join')),
        h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => app.admit(peer, true) }, 'Admit'),
        h('button.icon-btn.danger', { type: 'button', 'aria-label': 'Deny', onclick: () => app.admit(peer, false) }, icon('x'))));
    }
    root.append(sec);
  }

  // Raised hands, in the order they went up.
  const hands = [];
  if (app.hand) hands.push({ id: 'me', name: app.me.name + ' (you)', at: app.handAt || 0 });
  for (const [id, p] of app.peers) if (p.info.hand) hands.push({ id, name: p.info.name, at: p.handAt || 0 });
  if (hands.length) {
    hands.sort((a, b) => a.at - b.at);
    root.append(h('div.side-section', h('h4', `Raised hands (${hands.length})`),
      hands.map((x, i) => h('div.person', h('span.hand-n', String(i + 1)), avatarEl(x.id, x.name), h('div.person-name', h('strong', x.name), h('small', x.at ? `${formatDuration((Date.now() - x.at) / 1000)} ago` : '')), icon('hand')))));
  }

  const totalTalk = [...app.talk.values()].reduce((s, v) => s + v, 0) || 1;
  const list = h('div.side-section', h('h4', `In this meeting (${app.peerCount() + 1})`));
  const row = (id, info, me) => {
    const tags = [];
    if (id === app.room.host) tags.push(h('span.tag', 'Host'));
    if (me) tags.push(h('span.tag', 'You'));
    if (!me && app.peers.get(id)?.verified) tags.push(h('span.tag.tag-ok', 'Verified'));
    const icons = h('div.person-icons',
      info.hand ? icon('hand') : null,
      info.screen ? icon('screen') : null,
      icon(info.mic ? 'mic' : 'mic-off', info.mic ? '' : 'off'),
      icon(info.cam ? 'cam' : 'cam-off', info.cam ? '' : 'off'));
    const talked = app.talkTime(me ? 'me' : id);
    const bar = h('span.talk-bar', h('i'));
    bar.firstChild.style.width = `${Math.round((talked / totalTalk) * 100)}%`;
    const el = h('div.person', avatarEl(me ? 'me' : id, info.name),
      h('div.person-name', h('strong', info.name), h('small', tags, talked ? h('span.talk', { title: 'Speaking time (measured locally, never shared)' }, formatDuration(talked / 1000)) : null), talked ? bar : null), icons);
    if (!me) {
      el.append(h('button.icon-btn', {
        type: 'button', 'aria-label': `Options for ${info.name}`,
        onclick: (e) => app.personMenu(e.currentTarget, id),
      }, icon('more')));
    }
    return el;
  };
  list.append(row(app.me.peer, app.selfInfo(), true));
  for (const [id, p] of app.peers) list.append(row(id, p.info, false));
  root.append(list);

  if (isHost) {
    root.append(h('div.side-section', h('h4', 'Room controls'),
      switchRow('Lock room', 'No one new can join, even with the link', app.room.locked, (v) => app.sig.settings({ locked: v })),
      switchRow('Waiting room', 'Approve each person before they join', app.room.wait, (v) => app.sig.settings({ wait: v })),
      selectRow('End automatically', app.room.selfDestruct ? 'Scheduled. You can make it sooner, not later' : 'Close the meeting for everyone at a set time',
        [['', app.room.selfDestruct ? 'Scheduled' : 'Off'], ['300', 'In 5 minutes'], ['900', 'In 15 minutes'], ['1800', 'In 30 minutes'], ['3600', 'In 1 hour']], '',
        (v) => { if (v) app.sig.settings({ endInSec: Number(v) }); }),
      h('button.btn.btn-danger.btn-block', {
        type: 'button', onclick: async () => {
          if (await confirmDialog({ title: 'End the meeting for everyone?', message: 'Everyone will be disconnected and the meeting will close.', confirm: 'End meeting', danger: true })) app.endForAll();
        },
      }, icon('trash'), 'End meeting for everyone')));
  } else {
    root.append(h('p.muted', { class: 'field-hint' }, icon('info'), 'Only the host can admit people, lock the room or remove participants.'));
  }
  return root;
}

// ---- Security ------------------------------------------------------------------
export function securityPanel(app) {
  const root = h('div.side-scroll');
  const relayAll = [...app.peers.values()].every(p => p.lastStats?.route === 'relay');
  root.append(h('div.sec-hero', icon('shield'), h('div', h('strong', 'End-to-end encrypted'), h('small', 'Media: DTLS-SRTP · Signaling: AES-256-GCM'))));

  const peersSec = h('div.side-section', h('h4', 'Connections'));
  if (!app.peers.size) peersSec.append(h('p.muted', 'Waiting for someone to join.'));
  for (const [id, p] of app.peers) {
    const s = p.lastStats || {};
    const route = s.route === 'relay' ? 'Through relay' : s.route === 'direct' ? 'Direct' : 'Connecting…';
    peersSec.append(h('div.peer-card',
      h('header', avatarEl(id, p.info.name), h('span', p.info.name), p.verified ? h('span.tag.tag-ok', 'Verified') : null,
        h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => app.showSafety(id) }, icon('key'), p.verified ? 'Re-check' : 'Verify')),
      h('dl.kv',
        h('dt', 'Route'), h('dd', route),
        h('dt', 'Candidates'), h('dd', s.localType ? `${s.localType} to ${s.remoteType}${s.protocol ? ` (${s.protocol})` : ''}` : 'n/a'),
        h('dt', 'Latency'), h('dd', s.rtt != null ? `${s.rtt} ms` : 'n/a'),
        h('dt', 'Down / Up'), h('dd', `${s.inKbps ?? 0} / ${s.outKbps ?? 0} kbps`),
        h('dt', 'Packet loss'), h('dd', `${s.loss ?? 0}%`),
        h('dt', 'Video'), h('dd', s.res ? `${s.res}, ${s.fps ?? '?'} fps, ${s.codec || ''}` : 'n/a'))));
  }
  root.append(peersSec);

  root.append(h('div.side-section', h('h4', 'IP address exposure'),
    h('ul.list-plain',
      h('li', icon(relayAll && app.peers.size ? 'check' : 'info', relayAll && app.peers.size ? 'yes' : 'no'),
        h('span', relayAll && app.peers.size
          ? 'Every connection is relayed: participants cannot see your IP address.'
          : 'In direct connections, people in this meeting can see your IP address. Turn on Hide my IP in Settings to use the relay instead.')))));

  root.append(h('div.side-section', h('h4', 'What the server can see'),
    h('ul.list-plain',
      h('li', icon('check', 'no'), h('span', 'An opaque room ID derived from your key')),
      h('li', icon('check', 'no'), h('span', 'How many people are connected, and when')),
      h('li', icon('x', 'yes'), h('span', 'Names, messages, files, audio or video')),
      h('li', icon('x', 'yes'), h('span', 'The room key or the invite link')))));

  root.append(h('div.side-section', h('h4', 'This room'),
    h('dl.kv',
      h('dt', 'Room ID'), h('dd', app.derived.roomId.slice(0, 12) + '…'),
      h('dt', 'Plan'), h('dd', app.room.plan || 'public'),
      h('dt', 'Capacity'), h('dd', `${app.peerCount() + 1} / ${app.room.maxPeers}`),
      h('dt', 'Closes'), h('dd', new Date(app.room.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })))));
  return root;
}

// ---- Settings ------------------------------------------------------------------
export function settingsPanel(app, { inCall = true } = {}) {
  const m = app.media;
  const root = h('div.side-scroll');
  const devs = m.devices;
  const opt = (list) => list.length ? list.map(d => [d.id, d.label]) : [['', 'Default']];

  root.append(h('div.side-section', h('h4', 'Devices'),
    selectRow('Microphone', null, opt(devs.audioin), m.prefs.audioIn, (v) => m.switchDevice('audioin', v)),
    selectRow('Camera', null, opt(devs.videoin), m.prefs.videoIn, (v) => m.switchDevice('videoin', v)),
    'setSinkId' in HTMLMediaElement.prototype && devs.audioout.length
      ? selectRow('Speaker', null, opt(devs.audioout), m.prefs.audioOut, (v) => m.switchDevice('audioout', v)) : null));

  root.append(h('div.side-section', h('h4', 'Privacy filters'),
    selectRow('Camera filter', 'Applied on your device before it is sent', [['none', 'Natural'], ['blur', 'Blur'], ['pixelate', 'Pixelate']], m.prefs.videoFx, (v) => app.setVideoFx(v)),
    selectRow('Voice', 'Changed on your device before it is sent', [['off', 'Natural'], ['deep', 'Deep'], ['high', 'High'], ['robot', 'Robot']], m.prefs.voiceFx, (v) => app.setVoiceFx(v)),
    switchRow('Hide when inactive', 'Cover the meeting when you switch to another window', store.get('shield', false), (v) => { store.set('shield', v); }),
    switchRow('Pause camera in background', 'Turn your camera off when you switch tabs', store.get('bgPause', false), (v) => store.set('bgPause', v)),
    switchRow('Hide invite link', 'Keep the room key out of your address bar', store.get('hideLink', true), (v) => { store.set('hideLink', v); app.syncAddressBar(); }),
    app.cfg?.turn ? switchRow('Hide my IP', 'Relay media via TURN (applies on next join)', store.get('relay', false), (v) => store.set('relay', v)) : null));

  root.append(h('div.side-section', h('h4', 'Audio & video'),
    switchRow('Noise suppression', null, m.prefs.noiseSuppression, (v) => m.setPref('noiseSuppression', v)),
    switchRow('Automatic gain', null, m.prefs.autoGainControl, (v) => m.setPref('autoGainControl', v)),
    switchRow('HD video', 'Uses more bandwidth', m.prefs.hd, (v) => m.setPref('hd', v)),
    inCall ? switchRow('Data saver', 'Ask others to pause their video to you', store.get('dataSaver', false), (v) => app.setDataSaver(v)) : null,
    switchRow('Mirror my video', 'Only affects your own preview', m.prefs.mirror, (v) => { m.setPref('mirror', v); app.refreshSelfTile(); }),
    inCall ? switchRow('Push to talk', 'Hold Space to speak while muted', store.get('ptt', false), (v) => store.set('ptt', v)) : null));

  root.append(h('div.side-section', h('h4', 'Interface'),
    switchRow('Sounds', 'Join, leave and message chimes', store.get('sounds', true), (v) => store.set('sounds', v)),
    'Notification' in window ? switchRow('Desktop notifications', 'When the tab is hidden. Never includes message text', store.get('notify', false) && Notification.permission === 'granted', async (v) => { const ok = await app.enableNotifications(v); if (ok !== v) app.refreshSettings?.(); }) : null));
  return root;
}
