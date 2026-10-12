'use strict';
const crypto = require('crypto');
const { safeEq, httpError } = require('./tenants');

// Stripe integration over plain HTTPS (no SDK). Enabled when STRIPE_SECRET_KEY is set.
class BillingService {
  constructor(config, tenants, { fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.tenants = tenants;
    this.fetch = fetchImpl;
  }

  get enabled() { return Boolean(this.config.stripe.secretKey); }

  async _stripe(path, params) {
    const body = new URLSearchParams(params).toString();
    const res = await this.fetch(`https://api.stripe.com/v1/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.stripe.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError(502, json?.error?.message || 'billing provider error');
    return json;
  }

  async checkout(tenant, plan, baseUrl) {
    if (!this.enabled) throw httpError(501, 'billing is not configured');
    const price = this.config.stripe.prices[plan];
    if (!price) throw httpError(400, 'plan is not purchasable');
    const params = {
      mode: 'subscription',
      'line_items[0][price]': price,
      'line_items[0][quantity]': '1',
      client_reference_id: tenant.id,
      'metadata[tenantId]': tenant.id,
      'metadata[plan]': plan,
      'subscription_data[metadata][tenantId]': tenant.id,
      'subscription_data[metadata][plan]': plan,
      success_url: `${baseUrl}/dashboard?billing=success`,
      cancel_url: `${baseUrl}/dashboard?billing=cancel`,
    };
    if (tenant.stripeCustomerId) params.customer = tenant.stripeCustomerId;
    else if (tenant.email) params.customer_email = tenant.email;
    const s = await this._stripe('checkout/sessions', params);
    return { url: s.url };
  }

  async portal(tenant, baseUrl) {
    if (!this.enabled) throw httpError(501, 'billing is not configured');
    if (!tenant.stripeCustomerId) throw httpError(400, 'no billing account yet');
    const s = await this._stripe('billing_portal/sessions', { customer: tenant.stripeCustomerId, return_url: `${baseUrl}/dashboard` });
    return { url: s.url };
  }

  verifySignature(raw, header, toleranceSec = 300) {
    const secret = this.config.stripe.webhookSecret;
    if (!secret || typeof header !== 'string') return false;
    const parts = Object.fromEntries(header.split(',').map(kv => kv.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v]));
    const sigs = header.split(',').filter(p => p.trim().startsWith('v1=')).map(p => p.trim().slice(3));
    const t = Number(parts.t);
    if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
    return sigs.some(s => safeEq(s, expected));
  }

  // Returns a short string describing what happened (for logs/tests).
  handleEvent(event) {
    const obj = event?.data?.object || {};
    const meta = obj.metadata || {};
    switch (event?.type) {
      case 'checkout.session.completed': {
        const tid = obj.client_reference_id || meta.tenantId;
        return this.tenants.setPlan(tid, meta.plan, obj.customer) ? `upgraded ${tid} to ${meta.plan}` : 'ignored';
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const tenant = this.tenants.get(meta.tenantId) || this.tenants.findByStripeCustomer(obj.customer);
        if (!tenant) return 'ignored';
        const active = event.type === 'customer.subscription.updated' && ['active', 'trialing', 'past_due'].includes(obj.status);
        const plan = active ? (meta.plan || tenant.plan) : 'free';
        this.tenants.setPlan(tenant.id, plan, obj.customer);
        return `set ${tenant.id} to ${plan}`;
      }
      default: return 'ignored';
    }
  }
}

module.exports = { BillingService };
