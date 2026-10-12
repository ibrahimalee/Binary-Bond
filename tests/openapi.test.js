'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Every route registered in server/app.js must appear in public/openapi.json, and the reverse.
const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/openapi.json'), 'utf8'));
const src = fs.readFileSync(path.join(__dirname, '../server/app.js'), 'utf8');

const prefixes = { app: '', v1: '/v1', admin: '/admin/api' };
const routes = [];
for (const m of src.matchAll(/\b(app|v1|admin)\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
  routes.push([m[2], prefixes[m[1]] + m[3]]);
}

// Pages and static files are not part of the API.
const skip = new Set(['/docs', '/robots.txt', '/sitemap.xml', '/sw.js']);
const norm = (r) => r.replace(/:(\w+)/g, '{$1}');

test('openapi.json documents every API route', () => {
  const missing = [];
  for (const [method, route] of routes) {
    if (skip.has(route)) continue;
    if (!spec.paths[norm(route)]?.[method]) missing.push(`${method.toUpperCase()} ${norm(route)}`);
  }
  assert.deepEqual(missing, []);
});

test('openapi.json lists no route the server lacks', () => {
  const have = new Set(routes.map(([m, r]) => `${m} ${norm(r)}`));
  const extra = [];
  for (const [p, ops] of Object.entries(spec.paths)) {
    for (const m of Object.keys(ops)) if (m !== 'parameters' && !have.has(`${m} ${p}`)) extra.push(`${m.toUpperCase()} ${p}`);
  }
  assert.deepEqual(extra, []);
});
