'use strict';
const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

class TenantService {
  constructor(store, config, plans) {
    this.store = store;
    this.config = config;
    this.plans = plans;
    const d = store.data;
    d.tenants ||= {};
    d.meta ||= {};
    if (!d.meta.secret) { d.meta.secret = crypto.randomBytes(32).toString('hex'); store.save(); }
    this.signingKey = config.secret || d.meta.secret;
  }

  // ---- lifecycle -----------------------------------------------------------
  create({ name, email = '', plan = 'free' }) {
    name = String(name || '').trim().slice(0, 80);
    if (!name) throw httpError(400, 'name is required');
    if (!this.plans[plan]) throw httpError(400, 'unknown plan');
    const id = 't_' + crypto.randomBytes(6).toString('hex');
    const apiKey = this._newKey();
    const tenant = {
      id, name, email: String(email).slice(0, 200), plan, createdAt: Date.now(), disabled: false,
      keyHash: sha256(apiKey), keyPrefix: apiKey.slice(0, 12),
      branding: { name: '', accent: '', logoUrl: '' },
      webhook: { url: '', secret: 'whsec_' + crypto.randomBytes(18).toString('base64url') },
      domains: [], stripeCustomerId: '',
    };
    this.store.data.tenants[id] = tenant;
    this.store.save();
    return { tenant: this.publicView(tenant), apiKey };
  }

  _newKey() { return 'bb_live_' + crypto.randomBytes(24).toString('base64url'); }

  authenticate(apiKey) {
    if (typeof apiKey !== 'string' || !apiKey.startsWith('bb_live_') || apiKey.length > 128) return null;
    const h = sha256(apiKey);
    for (const t of Object.values(this.store.data.tenants)) {
      if (safeEq(t.keyHash, h)) return t.disabled ? null : t;
    }
    return null;
  }

  get(id) { return this.store.data.tenants[id] || null; }
  list() { return Object.values(this.store.data.tenants).map(t => this.publicView(t)); }

  rotateKey(id) {
    const t = this._must(id);
    const apiKey = this._newKey();
    t.keyHash = sha256(apiKey);
    t.keyPrefix = apiKey.slice(0, 12);
    this.store.save();
    return apiKey;
  }

  update(id, patch, { admin = false } = {}) {
    const t = this._must(id);
    if (typeof patch.name === 'string' && patch.name.trim()) t.name = patch.name.trim().slice(0, 80);
    if (patch.branding && typeof patch.branding === 'object') {
      const b = patch.branding;
      if (typeof b.name === 'string') t.branding.name = b.name.trim().slice(0, 40);
      if (typeof b.accent === 'string') t.branding.accent = HEX_COLOR.test(b.accent) ? b.accent : '';
      if (typeof b.logoUrl === 'string') t.branding.logoUrl = /^https:\/\/[^\s"'<>]{1,300}$/.test(b.logoUrl) ? b.logoUrl : '';
    }
    if (patch.webhook && typeof patch.webhook.url === 'string') {
      const u = patch.webhook.url.trim();
      if (u && !/^https?:\/\/[^\s]{1,400}$/.test(u)) throw httpError(400, 'webhook url must be http(s)');
      t.webhook.url = u;
    }
    if (Array.isArray(patch.domains)) {
      t.domains = patch.domains.map(String).map(s => s.trim()).filter(s => /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(s)).slice(0, 20);
    }
    if (admin) {
      if (patch.plan !== undefined) { if (!this.plans[patch.plan]) throw httpError(400, 'unknown plan'); t.plan = patch.plan; }
      if (typeof patch.disabled === 'boolean') t.disabled = patch.disabled;
    }
    this.store.save();
    return this.publicView(t);
  }

  setPlan(id, plan, stripeCustomerId) {
    const t = this.get(id);
    if (!t || !this.plans[plan]) return false;
    t.plan = plan;
    if (stripeCustomerId) t.stripeCustomerId = stripeCustomerId;
    this.store.save();
    return true;
  }

  findByStripeCustomer(cid) {
    return Object.values(this.store.data.tenants).find(t => t.stripeCustomerId === cid) || null;
  }

  remove(id) { const ok = delete this.store.data.tenants[id]; this.store.save(); return ok; }

  _must(id) { const t = this.get(id); if (!t) throw httpError(404, 'tenant not found'); return t; }

  publicView(t) {
    return {
      id: t.id, name: t.name, email: t.email, plan: t.plan, createdAt: t.createdAt, disabled: t.disabled,
      keyPrefix: t.keyPrefix, branding: t.branding, domains: t.domains,
      webhook: { url: t.webhook.url, secret: t.webhook.secret },
      limits: this.plans[t.plan],
    };
  }

  brandingFor(t) {
    if (!t || !this.plans[t.plan]?.whitelabel) return null;
    return { name: t.branding.name || '', accent: t.branding.accent || '', logoUrl: t.branding.logoUrl || '' };
  }

  allowedEmbedOrigins() {
    const out = new Set(this.config.embedOrigins);
    for (const t of Object.values(this.store.data.tenants)) if (!t.disabled) t.domains.forEach(d => out.add(d));
    return [...out];
  }

  // ---- signed session tokens ----------------------------------------------
  // v1.<payload>.<sig>; payload = {tid, exp, maxPeers?, maxMinutes?, relay?}
  issueToken(tenant, opts = {}) {
    const ttl = Math.max(30, Math.min(Number(opts.ttlSec) || 900, 24 * 3600));
    const payload = { tid: tenant.id, exp: Math.floor(Date.now() / 1000) + ttl };
    if (opts.maxPeers) payload.maxPeers = Math.floor(opts.maxPeers);
    if (opts.maxMinutes) payload.maxMinutes = Math.floor(opts.maxMinutes);
    if (opts.relay) payload.relay = true;
    if (opts.name) payload.n = String(opts.name).slice(0, 60);
    if (opts.ref !== undefined) {
      if (typeof opts.ref !== 'string' || !/^[\w.:/-]{1,64}$/.test(opts.ref)) throw httpError(400, 'ref must be 1-64 chars of [A-Za-z0-9_.:/-]');
      payload.ref = opts.ref;
    }
    const body = b64u(JSON.stringify(payload));
    return { token: `v1.${body}.${this._sig(body)}`, expiresAt: payload.exp * 1000 };
  }

  verifyToken(token) {
    if (typeof token !== 'string' || token.length > 1024) return null;
    const [v, body, sig] = token.split('.');
    if (v !== 'v1' || !body || !sig || !safeEq(sig, this._sig(body))) return null;
    let p;
    try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    if (!p || typeof p.tid !== 'string' || !(p.exp * 1000 > Date.now())) return null;
    const tenant = this.get(p.tid);
    if (!tenant || tenant.disabled) return null;
    return { tenant, claims: p };
  }

  _sig(body) { return crypto.createHmac('sha256', this.signingKey).update(body).digest('base64url'); }
}

module.exports = { TenantService, httpError, sha256, safeEq };
