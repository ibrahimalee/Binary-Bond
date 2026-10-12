'use strict';
const path = require('path');

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const list = (v, d = []) => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : d);
const int = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

function loadConfig(env = process.env, overrides = {}) {
  const cfg = {
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    dataDir: env.BB_DATA_DIR || path.join(process.cwd(), 'data'),
    persist: !bool(env.BB_EPHEMERAL),
    secret: env.BB_SECRET || '',
    adminToken: env.BB_ADMIN_TOKEN || '',
    metricsToken: env.BB_METRICS_TOKEN || env.BB_ADMIN_TOKEN || '',
    trustProxy: env.BB_TRUST_PROXY ? (/^\d+$/.test(env.BB_TRUST_PROXY) ? Number(env.BB_TRUST_PROXY) : env.BB_TRUST_PROXY) : false,
    allowedOrigins: list(env.BB_ALLOWED_ORIGINS),
    embedOrigins: list(env.BB_EMBED_ORIGINS),
    stunUrls: list(env.BB_STUN_URLS, ['stun:stun.l.google.com:19302']),
    stunPort: int(env.BB_STUN_PORT, 0),
    turnUrls: list(env.BB_TURN_URLS),
    turnSecret: env.BB_TURN_SECRET || '',
    turnTtlSec: int(env.BB_TURN_TTL, 3600),
    openSignup: bool(env.BB_OPEN_SIGNUP),
    allowPrivateWebhooks: bool(env.BB_ALLOW_PRIVATE_WEBHOOKS),
    brandName: env.BB_BRAND_NAME || 'BinaryBond',
    plans: env.BB_PLANS ? safeJson(env.BB_PLANS, {}) : {},
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY || '',
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
      prices: { pro: env.STRIPE_PRICE_PRO || '', business: env.STRIPE_PRICE_BUSINESS || '' },
    },
    limits: {
      wsPerIpPerMin: int(env.BB_WS_PER_IP_PER_MIN, 60),
      joinsPerIpPerMin: int(env.BB_JOINS_PER_IP_PER_MIN, 30),
      httpPerIpPerMin: int(env.BB_HTTP_PER_IP_PER_MIN, 300),
      maxConnsPerIp: int(env.BB_MAX_CONNS_PER_IP, 40),
      maxRooms: int(env.BB_MAX_ROOMS, 20000),
    },
  };
  return deepMerge(cfg, overrides);
}

function safeJson(s, d) { try { return JSON.parse(s); } catch { return d; } }
function deepMerge(a, b) {
  for (const k of Object.keys(b || {})) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') deepMerge(a[k], b[k]);
    else a[k] = b[k];
  }
  return a;
}

module.exports = { loadConfig };
