'use strict';
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

// Signature header format mirrors common providers: t=<unix>,v1=<hex hmac of "t.body">
function sign(secret, body, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

class WebhookService {
  constructor(config, { fetchImpl = globalThis.fetch, lookup = dns.lookup } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.lookup = lookup;
    this.delivered = 0;
    this.failed = 0;
  }

  async assertSafeUrl(url) {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('unsupported protocol');
    if (this.config.allowPrivateWebhooks) return;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [{ address: host }] : await this.lookup(host, { all: true });
    if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('webhook target resolves to a private address');
  }

  // Fire-and-forget with retries; never throws into the caller.
  emit(tenant, type, data) {
    if (!tenant?.webhook?.url) return Promise.resolve(false);
    return this.deliver(tenant.webhook.url, tenant.webhook.secret, { type, created: Date.now(), data }).catch(() => false);
  }

  async deliver(url, secret, event, attempts = 3) {
    const body = JSON.stringify({ id: 'evt_' + crypto.randomBytes(8).toString('hex'), ...event });
    for (let i = 0; i < attempts; i++) {
      try {
        await this.assertSafeUrl(url);
        const res = await this.fetch(url, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json', 'user-agent': 'BinaryBond-Webhooks/1', 'x-binarybond-signature': sign(secret, body) },
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) { this.delivered++; return true; }
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
      } catch (e) {
        if (/private address|unsupported protocol/.test(e.message)) break;
      }
      await new Promise(r => setTimeout(r, 500 * 2 ** i).unref?.());
    }
    this.failed++;
    return false;
  }
}

module.exports = { WebhookService, sign, isPrivateIp };
