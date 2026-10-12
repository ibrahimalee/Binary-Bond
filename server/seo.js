'use strict';
const fs = require('fs');
const path = require('path');

// Pages search engines should index, with sitemap hints. Everything else
// (meeting rooms, dashboards, key creation) is kept out of search results.
const INDEXABLE = {
  '/': { priority: 1.0, changefreq: 'weekly' },
  '/security': { priority: 0.9, changefreq: 'monthly' },
  '/pricing': { priority: 0.8, changefreq: 'monthly' },
  '/developers': { priority: 0.8, changefreq: 'monthly' },
  '/faq': { priority: 0.7, changefreq: 'monthly' },
  '/compare': { priority: 0.7, changefreq: 'monthly' },
  '/join': { priority: 0.4, changefreq: 'yearly' },
  '/privacy': { priority: 0.5, changefreq: 'yearly' },
  '/terms': { priority: 0.3, changefreq: 'yearly' },
};
const NOINDEX = ['/new', '/room', '/embed', '/dashboard', '/admin'];

const OG_IMAGE = { path: '/img/og-image.jpg', width: 1200, height: 630, alt: 'A woman smiles while talking to a colleague on an encrypted BinaryBond video call' };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;

function field(html, re) { const m = html.match(re); return m ? stripTags(m[1]) : ''; }

// Builds the extra <head> markup for an indexable page from the page's own
// <title>, description and FAQ markup, so copy lives in one place.
function buildHead({ route, html, origin, brand = 'BinaryBond' }) {
  if (!INDEXABLE[route]) return '';
  const title = field(html, /<title>([\s\S]*?)<\/title>/);
  const description = field(html, /<meta name="description" content="([^"]*)"/);
  const url = origin + (route === '/' ? '/' : route);
  const image = origin + OG_IMAGE.path;
  const tags = [
    `<link rel="canonical" href="${esc(url)}">`,
    '<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">',
    `<meta property="og:type" content="${route === '/' ? 'website' : 'article'}">`,
    `<meta property="og:site_name" content="${esc(brand)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:image:width" content="${OG_IMAGE.width}">`,
    `<meta property="og:image:height" content="${OG_IMAGE.height}">`,
    `<meta property="og:image:alt" content="${esc(OG_IMAGE.alt)}">`,
    '<meta property="og:locale" content="en_US">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
    `<meta name="twitter:image:alt" content="${esc(OG_IMAGE.alt)}">`,
  ];

  const graph = [];
  if (route === '/') {
    graph.push(
      { '@context': 'https://schema.org', '@type': 'Organization', name: brand, url: origin + '/', logo: origin + '/icon.svg' },
      { '@context': 'https://schema.org', '@type': 'WebSite', name: brand, url: origin + '/', description },
      {
        '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: brand, applicationCategory: 'CommunicationApplication',
        operatingSystem: 'Any (web browser)', url: origin + '/', description, image,
        featureList: ['End-to-end encrypted video meetings', 'Peer-to-peer connections', 'No account required', 'Encrypted chat and file transfer', 'Waiting room and host controls', 'Self-hostable'],
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
    );
  } else {
    const crumbs = [{ name: 'Home', url: origin + '/' }, { name: title.split('|')[0].trim(), url }];
    graph.push({
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.url })),
    });
  }

  // FAQ pairs are read from <details><summary>Q</summary><p>A</p></details>.
  const faqs = [];
  for (const m of html.matchAll(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>\s*<\/details>/g)) {
    faqs.push({ '@type': 'Question', name: stripTags(m[1]), acceptedAnswer: { '@type': 'Answer', text: stripTags(m[2]) } });
  }
  if (faqs.length) graph.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqs });

  if (route === '/pricing') {
    graph.push({
      '@context': 'https://schema.org', '@type': 'Product', name: `${brand} plans`, description,
      brand: { '@type': 'Brand', name: brand }, image,
      offers: { '@type': 'AggregateOffer', priceCurrency: 'USD', lowPrice: '0', highPrice: '79', offerCount: 4 },
    });
  }
  return [...tags, ...graph.map(ld)].join('\n  ');
}

function robotsTxt(origin) {
  return [
    'User-agent: *',
    'Allow: /',
    ...[...NOINDEX, '/api/', '/v1/', '/billing/', '/admin/', '/metrics', '/ws'].map((p) => `Disallow: ${p}`),
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}

function sitemapXml(origin, publicDir, pages) {
  const urls = Object.entries(INDEXABLE).map(([route, meta]) => {
    let lastmod = '';
    try { lastmod = fs.statSync(path.join(publicDir, pages[route])).mtime.toISOString().slice(0, 10); } catch { /* page missing */ }
    return `  <url>\n    <loc>${esc(origin + (route === '/' ? '/' : route))}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}\n    <changefreq>${meta.changefreq}</changefreq>\n    <priority>${meta.priority.toFixed(1)}</priority>\n  </url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

const isNoindex = (route) => NOINDEX.includes(route);

module.exports = { buildHead, robotsTxt, sitemapXml, isNoindex, INDEXABLE, NOINDEX };
