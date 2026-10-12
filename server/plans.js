'use strict';
// Plan limits. Override per-deployment with BB_PLANS='{"pro":{"maxPeers":4}}'.
const DEFAULT_PLANS = {
  // Anonymous / self-serve use with no API token.
  public:   { label: 'Public',   maxPeers: 4, maxMinutes: 60,   monthlyPeerMinutes: 0,      relay: true,  whitelabel: false, api: false },
  free:     { label: 'Free',     maxPeers: 4, maxMinutes: 60,   monthlyPeerMinutes: 3000,   relay: false, whitelabel: false, api: true },
  pro:      { label: 'Pro',      maxPeers: 6, maxMinutes: 480,  monthlyPeerMinutes: 60000,  relay: true,  whitelabel: false, api: true },
  business: { label: 'Business', maxPeers: 6, maxMinutes: 1440, monthlyPeerMinutes: 500000, relay: true,  whitelabel: true,  api: true },
};
const HARD_MAX_PEERS = 8; // full-mesh topology stops being reasonable beyond this

function resolvePlans(overrides = {}) {
  const plans = {};
  for (const [k, v] of Object.entries(DEFAULT_PLANS)) plans[k] = { ...v, ...(overrides[k] || {}) };
  for (const [k, v] of Object.entries(overrides)) if (!plans[k]) plans[k] = { ...DEFAULT_PLANS.free, label: k, ...v };
  for (const p of Object.values(plans)) p.maxPeers = Math.max(2, Math.min(p.maxPeers, HARD_MAX_PEERS));
  return plans;
}

module.exports = { resolvePlans, DEFAULT_PLANS, HARD_MAX_PEERS };
