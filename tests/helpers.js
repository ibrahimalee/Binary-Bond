'use strict';
const crypto = require('crypto');
const WebSocket = require('ws');
const { createServer } = require('../server/app');
const { loadConfig } = require('../server/config');

async function startServer(overrides = {}, options = {}) {
  const config = loadConfig({ BB_EPHEMERAL: '1', BB_ADMIN_TOKEN: 'admin-test-token', BB_STUN_URLS: 'stun:stun.example.test:3478' }, overrides);
  const bb = createServer({ config, ...options });
  await new Promise(r => bb.server.listen(0, '127.0.0.1', r));
  const { port } = bb.server.address();
  bb.url = `http://127.0.0.1:${port}`;
  bb.wsUrl = `ws://127.0.0.1:${port}/ws`;
  return bb;
}

// A WebSocket client that buffers messages so tests can await specific ones.
async function client(bb, headers = {}) {
  const ws = new WebSocket(bb.wsUrl, { headers });
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    const i = waiters.findIndex(w => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else inbox.push(m);
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return {
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    next(pred = () => true, ms = 2000) {
      if (typeof pred === 'string') { const t = pred; pred = (m) => m.t === t; }
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) { waiters.splice(j, 1); reject(new Error('timeout waiting for message')); } }, ms).unref();
      });
    },
    inbox,
    close: () => new Promise(r => { if (ws.readyState === WebSocket.CLOSED) return r(); ws.once('close', r); ws.close(); }),
  };
}

const roomCreds = () => ({
  room: crypto.randomBytes(16).toString('base64url'),
  auth: crypto.randomBytes(32).toString('base64url'),
});

async function api(bb, method, path, { body, token, headers = {} } = {}) {
  const res = await fetch(bb.url + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

module.exports = { startServer, client, roomCreds, api };
