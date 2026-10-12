'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const { loadConfig } = require('./config');
const { resolvePlans } = require('./plans');
const { JsonStore } = require('./jsonstore');
const { TenantService, httpError } = require('./tenants');
const { UsageService } = require('./usage');
const { WebhookService } = require('./webhooks');
const { BillingService } = require('./billing');
const { RoomManager, PUBLIC_TENANT } = require('./rooms');
const { createLimiter } = require('./ratelimit');
const { attachWebSocket } = require('./ws');
const { hasTurn } = require('./ice');
const { safeEq } = require('./tenants');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;
const { buildHead, robotsTxt, sitemapXml, isNoindex } = require('./seo');
const PAGES = {
  '/': 'index.html', '/security': 'security.html', '/pricing': 'pricing.html', '/developers': 'developers.html',
  '/faq': 'faq.html', '/compare': 'compare.html',
  '/privacy': 'privacy.html', '/terms': 'terms.html', '/join': 'join.html', '/new': 'new.html',
  '/room': 'room.html', '/embed': 'room.html', '/dashboard': 'dashboard.html', '/admin': 'admin.html',
};

function createServer(options = {}) {
  const config = options.config || loadConfig();
  const plans = resolvePlans(config.plans);
  const store = new JsonStore(path.join(config.dataDir, 'binarybond.json'), {}, { persist: config.persist });
  const tenants = new TenantService(store, config, plans);
  const usage = new UsageService(store);
  const webhooks = options.webhooks || new WebhookService(config, options);
  const billing = new BillingService(config, tenants, options);
  const rooms = new RoomManager({ config, plans, tenants, usage, webhooks });
  const limiters = {
    ws: createLimiter({ capacity: config.limits.wsPerIpPerMin, perMinute: config.limits.wsPerIpPerMin }),
    join: createLimiter({ capacity: config.limits.joinsPerIpPerMin, perMinute: config.limits.joinsPerIpPerMin }),
    http: createLimiter({ capacity: config.limits.httpPerIpPerMin, perMinute: config.limits.httpPerIpPerMin }),
    auth: createLimiter({ capacity: 20, perMinute: 20 }),
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  const server = http.createServer(app);

  const clientIp = (req) => {
    if (config.trustProxy) {
      const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xf) return xf;
    }
    return req.socket.remoteAddress || 'unknown';
  };
  const baseUrl = (req) => config.publicUrl || `${req.protocol}://${req.get('host')}`;
  const isAllowedOrigin = (origin, host) => {
    if (!origin) return true;
    try {
      const o = new URL(origin);
      if (o.host === host) return true;
    } catch { return false; }
    return config.allowedOrigins.includes(origin);
  };

  // ---- security headers -----------------------------------------------------
  app.use((req, res, next) => {
    // Host is reflected into CSP, so only accept plain host[:port] characters.
    const rawHost = req.get('host') || '';
    const host = /^[A-Za-z0-9.\-[\]:]{1,255}$/.test(rawHost) ? rawHost : 'invalid.local';
    const isEmbed = req.path === '/embed' || req.path === '/embed.html';
    const ancestors = isEmbed ? ["'self'", ...tenants.allowedEmbedOrigins()].join(' ') : "'none'";
    res.set({
      'Content-Security-Policy': [
        "default-src 'self'", "script-src 'self'", "style-src 'self'",
        "img-src 'self' data: blob: https:", "media-src 'self' blob: mediastream:",
        `connect-src 'self' ws://${host} wss://${host}`, "font-src 'self'", "worker-src 'self'",
        "manifest-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'",
        `frame-ancestors ${ancestors}`,
      ].join('; '),
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': isEmbed
        ? 'camera=(self "*"), microphone=(self "*"), display-capture=(self "*"), fullscreen=(self "*"), geolocation=(), payment=(), usb=(), interest-cohort=()'
        : 'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self), geolocation=(), payment=(), usb=(), interest-cohort=()',
    });
    // The SDK is meant to be loaded by customer sites.
    if (req.path === '/sdk.js' || req.path === '/openapi.json') res.set({ 'Cross-Origin-Resource-Policy': 'cross-origin', 'Access-Control-Allow-Origin': '*' });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    if (!isEmbed) res.set('X-Frame-Options', 'DENY');
    next();
  });

  // Generic HTTP rate limit on API surfaces only (static assets are cheap and cached).
  app.use(['/api', '/v1', '/admin/api', '/billing'], (req, res, next) => {
    if (!limiters.http.take(clientIp(req))) return res.status(429).json({ error: 'rate limited' });
    next();
  });

  // ---- pages & static --------------------------------------------------------
  // Pages are assembled at serve time from shared partials (icon sprite, site
  // header and footer), so every page stays in sync without a build step.
  const pageCache = new Map();
  const read = (f) => fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8');
  const renderPage = (file, route, origin) => {
    const cacheKey = `${route}:${file}:${origin}`;
    if (process.env.NODE_ENV === 'production' && pageCache.has(cacheKey)) return pageCache.get(cacheKey);
    const header = read('partials/header.html').replace(`href="${route}"`, `href="${route}" aria-current="page"`);
    const raw = read(file);
    const html = raw
      .replace('<!--#seo-->', buildHead({ route, html: raw, origin, brand: config.brandName }))
      .replace('<!--#sprite-->', read('icons.svg'))
      .replace('<!--#header-->', header)
      .replace('<!--#footer-->', read('partials/footer.html'));
    pageCache.set(cacheKey, html);
    return html;
  };
  for (const [route, file] of Object.entries(PAGES)) {
    app.get(route, (req, res) => {
      if (isNoindex(route)) res.set('X-Robots-Tag', 'noindex, nofollow');
      res.set('Cache-Control', 'no-cache').type('html').send(renderPage(file, route, baseUrl(req)));
    });
  }
  app.get('/docs', (req, res) => res.redirect(301, '/developers'));
  app.get('/robots.txt', (req, res) => res.set('Cache-Control', 'public, max-age=3600').type('text/plain').send(robotsTxt(baseUrl(req))));
  app.get('/sitemap.xml', (req, res) => res.set('Cache-Control', 'public, max-age=3600').type('application/xml').send(sitemapXml(baseUrl(req), PUBLIC_DIR, PAGES)));
  app.get(['/package.json', '/partials/*', ...Object.values(PAGES).map(f => `/${f}`)], (req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html')));
  app.get('/sw.js', (req, res) => res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }).sendFile(path.join(PUBLIC_DIR, 'sw.js')));
  app.use(express.static(PUBLIC_DIR, {
    index: false, dotfiles: 'ignore', extensions: ['html'],
    // Code is revalidated on every load (cheap 304s via ETag) so a deploy never
    // leaves browsers running a mix of old and new ES modules.
    setHeaders: (res, p) => res.set('Cache-Control', /\.(svg|png|ico|woff2)$/.test(p) ? 'public, max-age=86400' : 'no-cache'),
  }));

  // Stripe needs the raw body for signature checks, so register before express.json().
  app.post('/billing/stripe-webhook', express.raw({ type: '*/*', limit: '256kb' }), (req, res) => {
    const raw = req.body.toString('utf8');
    if (!billing.verifySignature(raw, req.get('stripe-signature'))) return res.status(400).json({ error: 'bad signature' });
    let event;
    try { event = JSON.parse(raw); } catch { return res.status(400).json({ error: 'bad json' }); }
    res.json({ received: true, result: billing.handleEvent(event) });
  });

  app.use(express.json({ limit: '32kb' }));

  // ---- public API --------------------------------------------------------------
  app.get('/healthz', (req, res) => res.json({ ok: true, version: VERSION, uptimeSec: Math.round(process.uptime()) }));

  app.get('/api/config', (req, res) => {
    res.set('Cache-Control', 'no-store').json({
      name: config.brandName, version: VERSION, turn: hasTurn(config), stun: config.stunUrls,
      signup: config.openSignup, billing: billing.enabled,
      plans: Object.fromEntries(Object.entries(plans).map(([k, p]) => [k, {
        label: p.label, maxPeers: p.maxPeers, maxMinutes: p.maxMinutes, monthlyPeerMinutes: p.monthlyPeerMinutes,
        relay: p.relay, whitelabel: p.whitelabel,
      }])),
    });
  });

  app.get('/api/brand', (req, res) => {
    const v = tenants.verifyToken(String(req.query.token || ''));
    res.set('Cache-Control', 'no-store').json({ brand: v ? tenants.brandingFor(v.tenant) : null });
  });

  app.post('/api/signup', (req, res) => {
    if (!config.openSignup) throw httpError(403, 'self-serve signup is disabled');
    if (!limiters.auth.take('signup:' + clientIp(req))) throw httpError(429, 'too many signups');
    const { name, email } = req.body || {};
    if (typeof email !== 'string' || !/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) throw httpError(400, 'valid email required');
    const { tenant, apiKey } = tenants.create({ name, email, plan: 'free' });
    res.status(201).json({ tenant, apiKey });
  });

  // ---- tenant API (Bearer <api key>) -------------------------------------------
  const tenantAuth = (req, res, next) => {
    const key = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const t = tenants.authenticate(key);
    if (!t) {
      limiters.auth.take('key:' + clientIp(req), 2);
      return res.status(401).json({ error: 'invalid api key' });
    }
    req.tenant = t;
    next();
  };
  const v1 = express.Router();
  v1.use(tenantAuth);
  v1.get('/me', (req, res) => res.json({ tenant: tenants.publicView(req.tenant), monthPeerMinutes: usage.monthPeerMinutes(req.tenant.id) }));
  v1.patch('/me', (req, res) => res.json({ tenant: tenants.update(req.tenant.id, req.body || {}) }));
  v1.post('/me/rotate-key', (req, res) => res.json({ apiKey: tenants.rotateKey(req.tenant.id) }));
  v1.post('/sessions', (req, res) => {
    const b = req.body || {};
    const { token, expiresAt } = tenants.issueToken(req.tenant, {
      ttlSec: b.ttlSec, maxPeers: b.maxPeers, maxMinutes: b.maxMinutes, relay: b.relay, name: b.name, ref: b.ref,
    });
    const url = new URL('/embed', baseUrl(req));
    url.searchParams.set('token', token);
    res.status(201).json({ token, expiresAt, embedUrl: url.toString() });
  });
  v1.get('/usage', (req, res) => {
    const days = Math.max(1, Math.min(Number(req.query.days) || 30, 365));
    res.json({ days: usage.range(req.tenant.id, days), monthPeerMinutes: usage.monthPeerMinutes(req.tenant.id), limits: plans[req.tenant.plan] });
  });
  v1.get('/rooms', (req, res) => res.json({ rooms: rooms.activeForTenant(req.tenant.id) }));
  v1.post('/webhook/test', wrap(async (req, res) => {
    if (!req.tenant.webhook.url) throw httpError(400, 'set a webhook url first');
    const ok = await webhooks.deliver(req.tenant.webhook.url, req.tenant.webhook.secret, { type: 'ping', created: Date.now(), data: {} }, 1);
    res.json({ delivered: ok });
  }));
  v1.post('/billing/checkout', wrap(async (req, res) => res.json(await billing.checkout(req.tenant, String(req.body?.plan || ''), baseUrl(req)))));
  v1.post('/billing/portal', wrap(async (req, res) => res.json(await billing.portal(req.tenant, baseUrl(req)))));
  app.use('/v1', v1);

  // ---- admin API (Bearer <BB_ADMIN_TOKEN>) -----------------------------------
  const adminAuth = (req, res, next) => {
    if (!config.adminToken) return res.status(404).json({ error: 'admin disabled' });
    if (!limiters.auth.take('admin:' + clientIp(req))) return res.status(429).json({ error: 'rate limited' });
    const tok = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!safeEq(tok, config.adminToken)) return res.status(401).json({ error: 'unauthorized' });
    next();
  };
  const admin = express.Router();
  admin.use(adminAuth);
  admin.get('/overview', (req, res) => res.json({
    live: rooms.snapshot(), connections: wsLayer.connections(), version: VERSION,
    webhooks: { delivered: webhooks.delivered, failed: webhooks.failed },
    tenants: tenants.list().length, publicUsage: usage.range(PUBLIC_TENANT, 30), plans,
  }));
  admin.get('/tenants', (req, res) => res.json({
    tenants: tenants.list().map(t => ({ ...t, monthPeerMinutes: usage.monthPeerMinutes(t.id), activeRooms: rooms.activeForTenant(t.id).length })),
  }));
  admin.post('/tenants', (req, res) => res.status(201).json(tenants.create(req.body || {})));
  admin.patch('/tenants/:id', (req, res) => res.json({ tenant: tenants.update(req.params.id, req.body || {}, { admin: true }) }));
  admin.post('/tenants/:id/rotate-key', (req, res) => res.json({ apiKey: tenants.rotateKey(req.params.id) }));
  admin.delete('/tenants/:id', (req, res) => res.json({ deleted: tenants.remove(req.params.id) }));
  admin.get('/tenants/:id/usage', (req, res) => res.json({ days: usage.range(req.params.id, 30) }));
  app.use('/admin/api', admin);

  app.get('/metrics', (req, res) => {
    const tok = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!config.metricsToken || !safeEq(tok, config.metricsToken)) return res.status(401).end();
    const s = rooms.snapshot();
    res.type('text/plain').send([
      `binarybond_rooms ${s.rooms}`, `binarybond_peers ${s.peers}`, `binarybond_waiting ${s.waiting}`,
      `binarybond_ws_connections ${wsLayer.connections()}`, `binarybond_rooms_created_total ${s.roomsCreated}`,
      `binarybond_joins_total ${s.joins}`, `binarybond_denied_total ${s.denied}`,
      `binarybond_relayed_messages_total ${s.relayed}`, `binarybond_relayed_bytes_total ${s.relayedBytes}`,
      `binarybond_webhooks_delivered_total ${webhooks.delivered}`, `binarybond_webhooks_failed_total ${webhooks.failed}`, '',
    ].join('\n'));
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
  app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[http]', err.message);
    res.status(status).json({ error: status >= 500 ? 'internal error' : err.message });
  });

  const wsLayer = attachWebSocket(server, { rooms, config, clientIp, isAllowedOrigin, limiters });

  const pruneTimer = setInterval(() => usage.prune(), 24 * 3600 * 1000);
  pruneTimer.unref?.();

  return {
    app, server, config, rooms, tenants, usage, billing, webhooks, store,
    close() {
      clearInterval(pruneTimer);
      rooms.shutdown();
      wsLayer.close();
      Object.values(limiters).forEach(l => l.stop());
      store.flush();
      return new Promise(r => server.close(() => r()));
    },
  };
}

module.exports = { createServer };
