'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startServer, client, roomCreds, api } = require('./helpers');
const { sign, isPrivateIp, WebhookService } = require('../server/webhooks');
const { buildResponse } = require('../server/stun');
const { iceServersFor } = require('../server/ice');

const ADMIN = 'admin-test-token';

test('tenant + session token + metering flow', async (t) => {
  const events = [];
  const webhooks = { delivered: 0, failed: 0, emit: (tenant, type, data) => { events.push({ type, data }); return Promise.resolve(true); } };
  const bb = await startServer({}, { webhooks });
  t.after(() => bb.close());

  assert.equal((await api(bb, 'GET', '/admin/api/tenants')).status, 401);
  const created = await api(bb, 'POST', '/admin/api/tenants', { token: ADMIN, body: { name: 'Acme', email: 'ops@acme.test', plan: 'pro' } });
  assert.equal(created.status, 201);
  const { apiKey, tenant } = created.json;
  assert.match(apiKey, /^bb_live_/);
  assert.equal(tenant.plan, 'pro');

  assert.equal((await api(bb, 'GET', '/v1/me', { token: 'bb_live_nope' })).status, 401);
  const me = await api(bb, 'GET', '/v1/me', { token: apiKey });
  assert.equal(me.json.tenant.id, tenant.id);
  assert.equal(me.json.tenant.keyHash, undefined, 'key hash must never be exposed');

  assert.equal((await api(bb, 'POST', '/v1/sessions', { token: apiKey, body: { ref: 'bad ref!' } })).status, 400);
  const s = await api(bb, 'POST', '/v1/sessions', { token: apiKey, body: { maxPeers: 3, ttlSec: 120, ref: 'meeting:42' } });
  assert.equal(s.status, 201);
  assert.match(s.json.embedUrl, /\/embed\?token=v1\./);

  // A room created with the token is billed to the tenant and gets token limits.
  const creds = roomCreds();
  const a = await client(bb);
  a.send({ t: 'join', ...creds, token: s.json.token });
  const j = await a.next('joined');
  assert.equal(j.maxPeers, 3);
  assert.equal(j.plan, 'pro');
  const rooms = await api(bb, 'GET', '/v1/rooms', { token: apiKey });
  assert.equal(rooms.json.rooms.length, 1);
  assert.equal(rooms.json.rooms[0].ref, 'meeting:42');
  await a.close();
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(events.map(e => e.type), ['room.created', 'participant.joined', 'participant.left', 'room.ended']);
  assert.ok(events.every(e => e.data.ref === 'meeting:42'), 'every webhook carries the customer ref');
  const usage = await api(bb, 'GET', '/v1/usage?days=7', { token: apiKey });
  assert.equal(usage.json.days.length, 7);
  assert.equal(usage.json.days.at(-1).rooms, 1);

  // Tampered tokens are refused.
  const bad = await client(bb);
  bad.send({ t: 'join', ...roomCreds(), token: s.json.token.slice(0, -2) + 'xx' });
  assert.equal((await bad.next('denied')).reason, 'token');
  await bad.close();

  // Key rotation invalidates the old key.
  const rot = await api(bb, 'POST', '/v1/me/rotate-key', { token: apiKey });
  assert.equal((await api(bb, 'GET', '/v1/me', { token: apiKey })).status, 401);
  assert.equal((await api(bb, 'GET', '/v1/me', { token: rot.json.apiKey })).status, 200);

  // Branding only applies on white-label plans.
  await api(bb, 'PATCH', '/v1/me', { token: rot.json.apiKey, body: { branding: { name: 'AcmeMeet', accent: '#ff0066', logoUrl: 'javascript:alert(1)' } } });
  const tok2 = (await api(bb, 'POST', '/v1/sessions', { token: rot.json.apiKey, body: {} })).json.token;
  assert.equal((await api(bb, 'GET', '/api/brand?token=' + encodeURIComponent(tok2))).json.brand, null);
  await api(bb, 'PATCH', `/admin/api/tenants/${tenant.id}`, { token: ADMIN, body: { plan: 'business' } });
  const brand = (await api(bb, 'GET', '/api/brand?token=' + encodeURIComponent(tok2))).json.brand;
  assert.deepEqual(brand, { name: 'AcmeMeet', accent: '#ff0066', logoUrl: '' });

  // Disabled tenants lose access.
  await api(bb, 'PATCH', `/admin/api/tenants/${tenant.id}`, { token: ADMIN, body: { disabled: true } });
  assert.equal((await api(bb, 'GET', '/v1/me', { token: rot.json.apiKey })).status, 401);
});

test('monthly quota blocks new rooms once exhausted', async (t) => {
  const bb = await startServer({ plans: { free: { monthlyPeerMinutes: 1 } } });
  t.after(() => bb.close());
  const { apiKey, tenant } = (await api(bb, 'POST', '/admin/api/tenants', { token: ADMIN, body: { name: 'Tiny' } })).json;
  bb.usage.addSeconds(tenant.id, 120);
  const { token } = (await api(bb, 'POST', '/v1/sessions', { token: apiKey, body: {} })).json;
  const a = await client(bb);
  a.send({ t: 'join', ...roomCreds(), token });
  assert.equal((await a.next('denied')).reason, 'quota');
  await a.close();
});

test('signup is off by default and validated when on', async (t) => {
  const off = await startServer();
  assert.equal((await api(off, 'POST', '/api/signup', { body: { name: 'x', email: 'a@b.co' } })).status, 403);
  await off.close();
  const on = await startServer({ openSignup: true });
  t.after(() => on.close());
  assert.equal((await api(on, 'POST', '/api/signup', { body: { name: 'x', email: 'nope' } })).status, 400);
  const ok = await api(on, 'POST', '/api/signup', { body: { name: 'Startup', email: 'a@b.co' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.tenant.plan, 'free');
});

test('security headers and static file scoping', async (t) => {
  const bb = await startServer();
  t.after(() => bb.close());
  const home = await api(bb, 'GET', '/');
  assert.equal(home.status, 200);
  const csp = home.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(home.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(home.headers.get('x-powered-by'), null);
  assert.match((await api(bb, 'GET', '/embed')).headers.get('content-security-policy'), /frame-ancestors 'self'/);
  for (const p of ['/server/app.js', '/package.json', '/../server/app.js', '/data/binarybond.json']) {
    assert.equal((await api(bb, 'GET', p)).status, 404, p);
  }
  assert.equal((await api(bb, 'GET', '/healthz')).json.ok, true);
  const cfg = (await api(bb, 'GET', '/api/config')).json;
  assert.equal(cfg.plans.public.maxPeers, 4);
  assert.equal((await api(bb, 'GET', '/metrics')).status, 401);
  assert.match((await api(bb, 'GET', '/metrics', { token: ADMIN })).text, /binarybond_rooms 0/);
});

test('stripe webhook signature + plan changes', async (t) => {
  const bb = await startServer({ stripe: { webhookSecret: 'whsec_test' } });
  t.after(() => bb.close());
  const { tenant } = (await api(bb, 'POST', '/admin/api/tenants', { token: ADMIN, body: { name: 'Payer' } })).json;
  const send = (event, secret = 'whsec_test') => {
    const raw = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
    return fetch(bb.url + '/billing/stripe-webhook', { method: 'POST', headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' }, body: raw });
  };
  const completed = { type: 'checkout.session.completed', data: { object: { client_reference_id: tenant.id, customer: 'cus_1', metadata: { plan: 'pro' } } } };
  assert.equal((await send(completed, 'wrong')).status, 400);
  assert.equal((await send(completed)).status, 200);
  assert.equal(bb.tenants.get(tenant.id).plan, 'pro');
  await send({ type: 'customer.subscription.deleted', data: { object: { customer: 'cus_1', metadata: {} } } });
  assert.equal(bb.tenants.get(tenant.id).plan, 'free');
});

test('webhooks are signed and refuse private targets', async () => {
  const sig = sign('s3cret', '{"a":1}', 1700000000);
  assert.equal(sig, `t=1700000000,v1=${crypto.createHmac('sha256', 's3cret').update('1700000000.{"a":1}').digest('hex')}`);
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.ok(!isPrivateIp(ip), ip);

  let called = 0;
  const svc = new WebhookService({ allowPrivateWebhooks: false }, { fetchImpl: async () => { called++; return { ok: true }; }, lookup: async () => [{ address: '10.0.0.5' }] });
  assert.equal(await svc.deliver('https://internal.example', 's', { type: 'x' }), false);
  assert.equal(called, 0);

  let seen;
  const ok = new WebhookService({ allowPrivateWebhooks: false }, { fetchImpl: async (u, o) => { seen = o; return { ok: true }; }, lookup: async () => [{ address: '93.184.216.34' }] });
  assert.equal(await ok.deliver('https://hooks.example', 'secret', { type: 'room.ended' }), true);
  assert.match(seen.headers['x-binarybond-signature'], /^t=\d+,v1=[a-f0-9]{64}$/);
});

test('turn credentials follow the coturn REST scheme', () => {
  const cfg = { stunUrls: ['stun:a'], turnUrls: ['turn:t:3478'], turnSecret: 'k', turnTtlSec: 60 };
  const [stun, turn] = iceServersFor(cfg, 'peer1', 1_000_000);
  assert.deepEqual(stun, { urls: ['stun:a'] });
  assert.equal(turn.username, '1060:peer1');
  assert.equal(turn.credential, crypto.createHmac('sha1', 'k').update('1060:peer1').digest('base64'));
});

test('built-in STUN responder returns XOR-MAPPED-ADDRESS', () => {
  const req = Buffer.alloc(20);
  req.writeUInt16BE(0x0001, 0);
  req.writeUInt32BE(0x2112a442, 4);
  crypto.randomBytes(12).copy(req, 8);
  const res = buildResponse(req, '203.0.113.7', 54321);
  assert.equal(res.readUInt16BE(0), 0x0101);
  assert.ok(res.subarray(8, 20).equals(req.subarray(8, 20)));
  const port = res.readUInt16BE(26) ^ 0x2112;
  const ip = [0, 1, 2, 3].map(i => res[28 + i] ^ [0x21, 0x12, 0xa4, 0x42][i]).join('.');
  assert.equal(port, 54321);
  assert.equal(ip, '203.0.113.7');
  assert.equal(buildResponse(Buffer.alloc(10), '1.2.3.4', 1), null);
});

test('pages, sdk headers and CSP host hardening', async (t) => {
  const http = require('http');
  const bb = await startServer();
  t.after(() => bb.close());
  for (const p of ['/', '/dashboard', '/admin', '/docs', '/privacy', '/embed']) {
    const r = await api(bb, 'GET', p);
    assert.equal(r.status, 200, p);
    assert.match(r.text, /<symbol id="i-logo"/, `${p} should have the icon sprite inlined`);
    assert.doesNotMatch(r.text, /<!--#sprite-->/);
  }
  for (const p of ['/index.html', '/dashboard.html', '/icons.svg/../package.json']) assert.equal((await api(bb, 'GET', p)).status, 404, p);
  const sdk = await api(bb, 'GET', '/sdk.js');
  assert.equal(sdk.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal((await api(bb, 'GET', '/js/app.js')).headers.get('cache-control'), 'no-cache');

  const { port } = bb.server.address();
  const csp = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/', headers: { host: "evil.example;script-src_*" } }, (res) => { res.resume(); resolve(res.headers['content-security-policy']); }).on('error', reject);
  });
  assert.doesNotMatch(csp, /evil/);
  assert.match(csp, /connect-src 'self' ws:\/\/invalid\.local/);
});

test('quota.warning fires once at 80% and once at 100% per month', async (t) => {
  const events = [];
  const webhooks = { delivered: 0, failed: 0, emit: (tenant, type, data) => { events.push({ type, data }); return Promise.resolve(true); } };
  const bb = await startServer({ plans: { free: { monthlyPeerMinutes: 10 } } }, { webhooks });
  t.after(() => bb.close());
  const { apiKey, tenant } = (await api(bb, 'POST', '/admin/api/tenants', { token: ADMIN, body: { name: 'Q' } })).json;
  const quotaEvents = () => events.filter(e => e.type === 'quota.warning').map(e => e.data.percent);
  const call = async () => {
    const { token } = (await api(bb, 'POST', '/v1/sessions', { token: apiKey, body: {} })).json;
    const c = await client(bb);
    c.send({ t: 'join', ...roomCreds(), token });
    const j = await c.next(m => m.t === 'joined' || m.t === 'denied');
    await c.close();
    await new Promise(r => setTimeout(r, 30));
    return j.t;
  };
  bb.usage.addSeconds(tenant.id, 8.5 * 60);
  await call();
  assert.deepEqual(quotaEvents(), [80]);
  await call();
  assert.deepEqual(quotaEvents(), [80], 'no duplicate warning');
  bb.usage.addSeconds(tenant.id, 2 * 60);
  assert.equal(await call(), 'denied', 'over quota: new rooms refused');
  bb.rooms._checkQuota(tenant.id);
  assert.deepEqual(quotaEvents(), [80, 100]);
  assert.equal((await api(bb, 'GET', '/v1/me', { token: apiKey })).json.tenant.quotaAlerts, undefined, 'internal state not exposed');
});
