'use strict';
// In-memory token bucket. Keys (IPs) live only in RAM and are pruned when idle.
function createLimiter({ capacity, perMinute, now = Date.now }) {
  const refillPerMs = perMinute / 60000;
  const buckets = new Map();
  const sweep = setInterval(() => {
    const t = now();
    for (const [k, b] of buckets) if ((t - b.at) * refillPerMs + b.tokens >= capacity) buckets.delete(k);
  }, 60000);
  sweep.unref?.();
  return {
    take(key, cost = 1) {
      const t = now();
      let b = buckets.get(key);
      if (!b) { b = { tokens: capacity, at: t }; buckets.set(key, b); }
      b.tokens = Math.min(capacity, b.tokens + (t - b.at) * refillPerMs);
      b.at = t;
      if (b.tokens < cost) return false;
      b.tokens -= cost;
      return true;
    },
    size: () => buckets.size,
    stop: () => clearInterval(sweep),
  };
}
module.exports = { createLimiter };
