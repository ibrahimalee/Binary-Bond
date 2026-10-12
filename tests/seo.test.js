'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, api } = require('./helpers');
const { INDEXABLE, NOINDEX } = require('../server/seo');

test('robots.txt and sitemap.xml reflect indexable pages', async (t) => {
  const bb = await startServer({ publicUrl: 'https://meet.example.com' });
  t.after(() => bb.close());

  const robots = await api(bb, 'GET', '/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('content-type'), /text\/plain/);
  assert.match(robots.text, /Sitemap: https:\/\/meet\.example\.com\/sitemap\.xml/);
  for (const p of ['/room', '/dashboard', '/admin', '/api/', '/v1/']) assert.match(robots.text, new RegExp(`Disallow: ${p}`));

  const map = await api(bb, 'GET', '/sitemap.xml');
  assert.match(map.headers.get('content-type'), /xml/);
  for (const route of Object.keys(INDEXABLE)) assert.ok(map.text.includes(`<loc>https://meet.example.com${route === '/' ? '/' : route}</loc>`), route);
  for (const route of NOINDEX) assert.ok(!map.text.includes(`meet.example.com${route}<`), `${route} must not be listed`);
  assert.match(map.text, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
});

test('indexable pages carry canonical, social cards and structured data', async (t) => {
  const bb = await startServer({ publicUrl: 'https://meet.example.com' });
  t.after(() => bb.close());

  for (const route of Object.keys(INDEXABLE)) {
    const r = await api(bb, 'GET', route);
    assert.equal(r.status, 200, route);
    const url = `https://meet.example.com${route === '/' ? '/' : route}`;
    assert.ok(r.text.includes(`<link rel="canonical" href="${url}">`), `${route} canonical`);
    assert.match(r.text, /<meta property="og:title" content="[^"]{10,}"/, `${route} og:title`);
    assert.match(r.text, /<meta property="og:image" content="https:\/\/meet\.example\.com\/img\/og-image\.jpg"/, `${route} og:image`);
    assert.match(r.text, /<meta name="twitter:card" content="summary_large_image"/);
    assert.equal((r.text.match(/<h1[ >]/g) || []).length, 1, `${route} should have exactly one h1`);
    assert.doesNotMatch(r.text, /<!--#seo-->/);
    const title = r.text.match(/<title>([^<]*)<\/title>/)[1];
    assert.ok(title.length <= 70, `${route} title too long (${title.length})`);
    const desc = r.text.match(/<meta name="description" content="([^"]*)"/)[1];
    assert.ok(desc.length >= 80 && desc.length <= 170, `${route} description length ${desc.length}`);
    for (const m of r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) JSON.parse(m[1]);
  }

  const home = (await api(bb, 'GET', '/')).text;
  assert.match(home, /"@type":"SoftwareApplication"/);
  assert.match(home, /"@type":"FAQPage"/);
  assert.match(home, /<link rel="preload" as="image" href="\/img\/hero-call\.jpg"/);
  const faq = (await api(bb, 'GET', '/faq')).text;
  assert.ok((faq.match(/"@type":"Question"/g) || []).length >= 10, 'FAQ questions in structured data');
  assert.match((await api(bb, 'GET', '/pricing')).text, /"@type":"AggregateOffer"/);
  assert.match((await api(bb, 'GET', '/security')).text, /"@type":"BreadcrumbList"/);
});

test('private pages are kept out of search results', async (t) => {
  const bb = await startServer();
  t.after(() => bb.close());
  for (const route of NOINDEX) {
    const r = await api(bb, 'GET', route);
    assert.match(r.headers.get('x-robots-tag') || '', /noindex/, `${route} header`);
    assert.doesNotMatch(r.text, /rel="canonical"/, `${route} must not be canonical`);
  }
  const miss = await api(bb, 'GET', '/definitely-not-a-page');
  assert.equal(miss.status, 404);
  assert.match(miss.text, /name="robots" content="noindex"/);
});
