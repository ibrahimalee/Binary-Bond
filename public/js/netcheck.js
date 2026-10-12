// Pre-call diagnostics: signaling reachability + latency, NAT traversal
// (which ICE candidate types this network can produce) and device status.
// Uses only the public STUN servers configured by the operator.

import { h, icon } from './util.js';

async function signalingRtt() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new Promise((resolve) => {
    let ws;
    const done = (v) => { try { ws?.close(); } catch { /* ignore */ } resolve(v); };
    const t = setTimeout(() => done(null), 5000);
    try { ws = new WebSocket(`${proto}//${location.host}/ws`); } catch { return done(null); }
    const samples = [];
    let sent = 0;
    const ping = () => { sent = performance.now(); ws.send(JSON.stringify({ t: 'ping' })); };
    ws.onopen = ping;
    ws.onmessage = (e) => {
      try { if (JSON.parse(e.data).t !== 'pong') return; } catch { return; }
      samples.push(performance.now() - sent);
      if (samples.length < 3) return ping();
      clearTimeout(t);
      done(Math.round(Math.min(...samples)));
    };
    ws.onerror = () => { clearTimeout(t); done(null); };
  });
}

async function gatherCandidates(stunUrls) {
  if (typeof RTCPeerConnection === 'undefined') return null;
  const pc = new RTCPeerConnection({ iceServers: stunUrls?.length ? [{ urls: stunUrls }] : [] });
  const types = new Set();
  let udp = false;
  pc.createDataChannel('probe');
  const finished = new Promise((resolve) => {
    const t = setTimeout(resolve, 4000);
    pc.onicecandidate = (e) => {
      if (!e.candidate) { clearTimeout(t); return resolve(); }
      const c = e.candidate;
      if (c.type) types.add(c.type);
      if ((c.protocol || '').toLowerCase() === 'udp') udp = true;
    };
  });
  await pc.setLocalDescription(await pc.createOffer());
  await finished;
  pc.close();
  return { types: [...types], udp };
}

export async function runNetworkCheck({ stun, media }) {
  const [rtt, ice] = await Promise.all([signalingRtt(), gatherCandidates(stun)]);
  const rows = [];
  rows.push(rtt == null
    ? { ok: false, title: 'Signaling server unreachable', sub: 'A firewall or proxy may be blocking WebSockets.' }
    : { ok: true, title: `Signaling server reachable · ${rtt} ms`, sub: rtt > 300 ? 'High latency: calls may take a moment to connect.' : 'Fast and healthy.' });
  if (!ice) rows.push({ ok: false, title: 'WebRTC unavailable', sub: 'This browser cannot make peer-to-peer connections.' });
  else if (ice.types.includes('srflx')) rows.push({ ok: true, title: 'Direct peer-to-peer supported', sub: 'Your network allows NAT traversal over UDP.' });
  else if (ice.udp) rows.push({ ok: null, title: 'Local network only', sub: 'Calls with people outside your network may need the relay (TURN).' });
  else rows.push({ ok: false, title: 'UDP appears blocked', sub: 'Media will need a TCP/TLS relay. Ask the operator to enable TURN over TLS.' });
  rows.push(media.rawAudio ? { ok: true, title: 'Microphone ready', sub: media.rawAudio.label || '' } : { ok: false, title: 'No microphone', sub: 'You can still listen, chat and share files.' });
  if (media.rawVideo) rows.push({ ok: true, title: 'Camera ready', sub: media.rawVideo.label || '' });
  else if (media.devices.videoin.length) rows.push({ ok: null, title: 'Camera off or blocked', sub: 'Turn it on in the preview, or allow access in your browser settings.' });
  else rows.push({ ok: false, title: 'No camera found', sub: 'Others will see your initials.' });
  return h('ul.check-list', rows.map(r => h(`li.${r.ok === true ? 'ok' : r.ok === false ? 'bad' : 'warn'}`,
    icon(r.ok === true ? 'check' : r.ok === false ? 'x' : 'alert'), h('div', h('strong', r.title), r.sub ? h('small', r.sub) : null))));
}
