// Tenant dashboard: usage, plan & billing, API keys, embed sessions,
// branding, webhooks and allowed embed domains.

import { $, h, icon, formatDuration } from './util.js';
import { toast, confirmDialog } from './ui.js';
import { api, barChart, fmtNum, fmtDate, codeBlock, revealSecret } from './console.js';

const KEY = 'bb:apiKey';
const root = $('#root');
let cfg = null;
let key = sessionStorage.getItem(KEY);
let me = null;

init();

async function init() {
  try { cfg = await api('/api/config'); } catch { cfg = { plans: {}, signup: false, billing: false }; }
  $('#signOut').addEventListener('click', signOut);
  const billing = new URLSearchParams(location.search).get('billing');
  if (billing === 'success') toast('Thanks! Your plan will update in a few seconds.', { type: 'success', timeout: 6000 });
  if (billing) history.replaceState(null, '', '/dashboard');
  if (key) load(); else renderLogin();
}

function signOut() {
  sessionStorage.removeItem(KEY);
  key = null;
  me = null;
  $('#signOut').hidden = true;
  renderLogin();
}

// ---- sign in / sign up ----------------------------------------------------------
function renderLogin() {
  const keyInput = h('input.input.mono', { type: 'password', placeholder: 'bb_live_…', autocomplete: 'off', required: true, 'aria-label': 'API key' });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      key = keyInput.value.trim();
      sessionStorage.setItem(KEY, key);
      await load();
    },
  }, h('label.field', h('span.field-label', 'API key'), keyInput), h('button.btn.btn-primary.btn-block', { type: 'submit' }, 'Open dashboard'));

  const card = h('div.card.auth-card',
    h('h1', 'Developer dashboard'),
    h('p.muted', 'Embed private, end-to-end encrypted calls in your product. Your key is kept only for this tab.'),
    form);

  if (cfg.signup) {
    const name = h('input.input', { placeholder: 'Acme Inc.', required: true, maxLength: 80 });
    const email = h('input.input', { type: 'email', placeholder: 'you@company.com', required: true });
    card.append(h('div.divider-text', 'or create a workspace'),
      h('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const r = await api('/api/signup', { method: 'POST', body: { name: name.value, email: email.value } });
            key = r.apiKey;
            sessionStorage.setItem(KEY, key);
            await load(r.apiKey);
          } catch (err) { toast(err.message, { type: 'error' }); }
        },
      }, h('div.form-grid', h('label.field', h('span.field-label', 'Workspace name'), name), h('label.field', h('span.field-label', 'Email'), email)),
      h('button.btn.btn-block', { type: 'submit' }, icon('sparkle'), 'Create free workspace')));
  } else {
    card.append(h('p.field-hint', icon('info'), 'Need a key? Ask the operator of this BinaryBond server.'));
  }
  root.replaceChildren(card);
  keyInput.focus();
}

// ---- main -------------------------------------------------------------------------
async function load(freshKey = null) {
  try {
    const [meRes, usage, rooms] = await Promise.all([
      api('/v1/me', { token: key }), api('/v1/usage?days=30', { token: key }), api('/v1/rooms', { token: key }),
    ]);
    me = meRes.tenant;
    $('#signOut').hidden = false;
    render(meRes, usage, rooms.rooms, freshKey);
  } catch (e) {
    if (e.status === 401) { toast('That API key is not valid.', { type: 'error' }); signOut(); } else toast(e.message, { type: 'error' });
  }
}

function render(meRes, usage, rooms, freshKey) {
  const plan = me.limits;
  const used = meRes.monthPeerMinutes;
  const quota = plan.monthlyPeerMinutes;
  const pct = quota ? Math.min(100, (used / quota) * 100) : 0;
  const days = usage.days;
  const totalRooms = days.reduce((s, d) => s + d.rooms, 0);
  const totalMin = days.reduce((s, d) => s + d.peerSeconds, 0) / 60;
  const peak = Math.max(0, ...days.map(d => d.peakPeers));

  const meter = h(`div.meter${pct > 85 ? '.warn' : ''}`, h('span'));
  requestAnimationFrame(() => { meter.firstChild.style.width = `${pct}%`; });

  root.replaceChildren(
    h('header.console-head',
      h('div', h('h1', me.name), h('p.muted', `Workspace ${me.id} · ${plan.label} plan · since ${fmtDate(me.createdAt)}`)),
      h('div.btn-row', h('a.btn.btn-ghost', { href: '/openapi.json', target: '_blank', rel: 'noopener' }, icon('code'), 'OpenAPI'), h('a.btn.btn-ghost', { href: '/docs' }, icon('note'), 'Docs'), h('a.btn.btn-primary', { href: '/', target: '_blank', rel: 'noopener' }, icon('sparkle'), 'Open app'))),
    freshKey ? revealSecret('Your API key', freshKey, 'Copy it now. It is shown only once, and we only store a hash of it.') : '',
    h('section.cards',
      stat('Live rooms', fmtNum(rooms.length), `${fmtNum(rooms.reduce((s, r) => s + r.peers, 0))} people connected`, 'span-3'),
      stat('Rooms (30d)', fmtNum(totalRooms), 'Created with your tokens', 'span-3'),
      stat('Participant minutes (30d)', fmtNum(totalMin), 'Summed across participants', 'span-3'),
      stat('Peak concurrency', fmtNum(peak), 'Largest single room, 30d', 'span-3'),

      h('div.card.span-8', usageChart(days)),
      h('div.card.span-4',
        h('h2', icon('chart'), 'This month'),
        h('p.muted', 'Participant-minutes counted against your plan.'),
        h('div.stat-value', quota ? `${fmtNum(used)} / ${fmtNum(quota)}` : fmtNum(used)),
        quota ? meter : null,
        h('p.stat-sub', quota ? `${Math.round(pct)}% used · resets on the 1st (UTC)` : 'Unlimited on this plan'),
        h('dl.kv',
          h('dt', 'Participants / room'), h('dd', String(plan.maxPeers)),
          h('dt', 'Max call length'), h('dd', formatDuration(plan.maxMinutes * 60)),
          h('dt', 'IP-hiding relay'), h('dd', plan.relay ? 'Included' : 'Not included'),
          h('dt', 'White-label'), h('dd', plan.whitelabel ? 'Included' : 'Not included'))),

      plansCard(),
      sessionCard(),
      keyCard(),
      brandingCard(),
      webhookCard(),
      domainsCard(),
      liveCard(rooms)));
}

function stat(label, value, sub, span) {
  return h(`div.card.${span}`, h('div.stat', h('span.stat-label', label), h('span.stat-value', value), h('span.stat-sub', sub)));
}

function usageChart(days) {
  const host = h('div');
  let metric = 'minutes';
  const seg = h('div.seg', ...[['minutes', 'Minutes'], ['rooms', 'Rooms'], ['peak', 'Peak']].map(([k, l]) =>
    h(`button${k === metric ? '.active' : ''}`, { type: 'button', onclick: (e) => { metric = k; [...seg.children].forEach(b => b.classList.toggle('active', b === e.currentTarget)); draw(); } }, l)));
  const draw = () => host.replaceChildren(barChart(days, {
    labelOf: (d) => d.date,
    valueOf: (d) => (metric === 'minutes' ? d.peerSeconds / 60 : metric === 'rooms' ? d.rooms : d.peakPeers),
  }));
  draw();
  const csv = h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: exportCsv }, icon('download'), 'CSV');
  return [h('div.card-head', h('div', h('h2', icon('activity'), 'Usage'), h('p.muted', 'Last 30 days. Only aggregate counters are kept: no room IDs, IPs or names.')), h('div.btn-row', seg, csv)), host];
}

async function exportCsv() {
  try {
    const { days } = await api('/v1/usage?days=365', { token: key });
    const rows = [['date', 'rooms', 'participant_minutes', 'peak_participants', 'joins'], ...days.map(d => [d.date, d.rooms, (d.peerSeconds / 60).toFixed(1), d.peakPeers, d.joins])];
    const a = h('a', { href: URL.createObjectURL(new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' })), download: `binarybond-usage-${me.id}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) { toast(e.message, { type: 'error' }); }
}

function plansCard() {
  const card = h('div.card', h('h2', icon('zap'), 'Plans'), h('p.muted', cfg.billing ? 'Upgrade or manage billing securely through Stripe.' : 'Plan changes are handled by the server operator.'));
  const grid = h('div.plan-grid');
  for (const [id, p] of Object.entries(cfg.plans || {})) {
    if (id === 'public') continue;
    const current = id === me.plan;
    grid.append(h(`div.plan${current ? '.current' : ''}`,
      h('h3', p.label, current ? h('span.tag', { class: 'tag-ok' }, ' Current') : null),
      h('ul',
        h('li', `${p.maxPeers} people per room`),
        h('li', `Calls up to ${p.maxMinutes >= 60 ? `${p.maxMinutes / 60} h` : `${p.maxMinutes} min`}`),
        h('li', p.monthlyPeerMinutes ? `${fmtNum(p.monthlyPeerMinutes)} participant-min / month` : 'Unlimited minutes'),
        p.relay ? h('li', 'IP-hiding TURN relay') : null,
        p.whitelabel ? h('li', 'White-label branding') : null),
      !current && cfg.billing && id !== 'free'
        ? h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => checkout(id) }, `Upgrade to ${p.label}`) : null));
  }
  card.append(grid);
  if (cfg.billing && me.plan !== 'free') {
    card.append(h('div.btn-row', { class: 'mt' }, h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: portal }, icon('settings'), 'Manage billing')));
  }
  return card;
}

async function checkout(plan) {
  try { const { url } = await api('/v1/billing/checkout', { method: 'POST', token: key, body: { plan } }); location.href = url; } catch (e) { toast(e.message, { type: 'error' }); }
}
async function portal() {
  try { const { url } = await api('/v1/billing/portal', { method: 'POST', token: key }); location.href = url; } catch (e) { toast(e.message, { type: 'error' }); }
}

function sessionCard() {
  const maxPeers = h('select.select', Array.from({ length: me.limits.maxPeers - 1 }, (_, i) => i + 2).map(n => h('option', { value: n, selected: n === me.limits.maxPeers }, String(n))));
  const ttl = h('select.select', [[300, '5 minutes'], [900, '15 minutes'], [3600, '1 hour'], [86400, '24 hours']].map(([v, l]) => h('option', { value: v, selected: v === 900 }, l)));
  const minutes = h('input.input', { type: 'number', min: 1, max: me.limits.maxMinutes, value: Math.min(60, me.limits.maxMinutes) });
  const relay = h('input.switch', { type: 'checkbox', disabled: !me.limits.relay });
  const out = h('div');
  return h('div.card.span-6',
    h('h2', icon('key'), 'Create an embed session'),
    h('p.muted', 'Your backend calls POST /v1/sessions to mint short-lived tokens. Try it here.'),
    h('div.form-grid',
      h('label.field', h('span.field-label', 'Max participants'), maxPeers),
      h('label.field', h('span.field-label', 'Token valid for'), ttl),
      h('label.field', h('span.field-label', 'Call length (minutes)'), minutes),
      h('label.switch-row', h('span', h('strong', 'Hide IPs (relay)'), h('small', me.limits.relay ? 'Force TURN for every participant' : 'Not on your plan')), relay)),
    h('button.btn.btn-primary', {
      type: 'button',
      onclick: async () => {
        try {
          const s = await api('/v1/sessions', { method: 'POST', token: key, body: { maxPeers: Number(maxPeers.value), ttlSec: Number(ttl.value), maxMinutes: Number(minutes.value), relay: relay.checked } });
          out.replaceChildren(
            h('p.field-hint', icon('check'), `Token expires ${new Date(s.expiresAt).toLocaleString()}`),
            codeBlock(s.embedUrl),
            h('p.muted', 'Drop-in embed:'),
            codeBlock(`<div id="call" style="height:600px"></div>\n<script src="${location.origin}/sdk.js"></script>\n<script>\n  BinaryBond.mount('#call', { token: '${s.token}' })\n    .on('joined', e => console.log('in call', e.participants));\n</script>`),
            h('div.btn-row', h('a.btn.btn-ghost.btn-sm', { href: s.embedUrl, target: '_blank', rel: 'noopener' }, icon('arrow'), 'Open embed')));
        } catch (e) { toast(e.message, { type: 'error' }); }
      },
    }, icon('sparkle'), 'Generate token'),
    out);
}

function keyCard() {
  const out = h('div');
  return h('div.card.span-6',
    h('h2', icon('key'), 'API key'),
    h('p.muted', 'Use it from your server only. Never ship it to browsers.'),
    h('div.keybox', h('input.input', { value: `${me.keyPrefix}••••••••••••••••••••`, readOnly: true, 'aria-label': 'API key prefix' })),
    h('div.btn-row', { class: 'mt' },
      h('button.btn.btn-ghost.btn-sm', {
        type: 'button',
        onclick: async () => {
          if (!await confirmDialog({ title: 'Rotate API key?', message: 'The current key stops working immediately. Update your servers right after.', confirm: 'Rotate key', danger: true })) return;
          try {
            const { apiKey } = await api('/v1/me/rotate-key', { method: 'POST', token: key });
            key = apiKey;
            sessionStorage.setItem(KEY, key);
            out.replaceChildren(revealSecret('New API key', apiKey, 'Shown once. The previous key no longer works.'));
          } catch (e) { toast(e.message, { type: 'error' }); }
        },
      }, icon('refresh'), 'Rotate key')),
    out,
    codeBlock(`curl -X POST ${location.origin}/v1/sessions \\\n  -H "Authorization: Bearer $BINARYBOND_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"maxPeers": 4, "ttlSec": 900}'`));
}

function brandingCard() {
  const b = me.branding;
  const name = h('input.input', { value: b.name, maxLength: 40, placeholder: 'Your product name' });
  const accent = h('input.color-input', { type: 'color', value: b.accent || '#8b5cf6', 'aria-label': 'Accent colour' });
  const logo = h('input.input', { value: b.logoUrl, placeholder: 'https://cdn.example.com/logo.svg' });
  const previewName = h('strong', b.name || 'BinaryBond');
  const previewBtn = h('span.btn.btn-sm', 'Join call');
  const paint = () => { previewName.textContent = name.value || 'BinaryBond'; previewBtn.style.background = accent.value; previewBtn.style.color = '#fff'; };
  name.addEventListener('input', paint);
  accent.addEventListener('input', paint);
  paint();
  return h('div.card.span-6',
    h('h2', icon('sparkle'), 'White-label branding'),
    h('p.muted', me.limits.whitelabel ? 'Shown inside embedded calls created with your tokens.' : 'Available on the Business plan. You can prepare it now.'),
    h('label.field', h('span.field-label', 'Display name'), name),
    h('div.form-grid', h('label.field', h('span.field-label', 'Accent'), accent), h('label.field', h('span.field-label', 'Logo URL (https)'), logo)),
    h('div.brand-preview', previewName, previewBtn),
    h('div.btn-row', { class: 'mt' }, h('button.btn.btn-primary.btn-sm', {
      type: 'button',
      onclick: () => save({ branding: { name: name.value, accent: accent.value, logoUrl: logo.value } }, 'Branding saved'),
    }, 'Save branding')));
}

function webhookCard() {
  const url = h('input.input', { value: me.webhook.url, placeholder: 'https://api.example.com/hooks/binarybond' });
  const secret = h('input.input.mono', { value: me.webhook.secret, readOnly: true, type: 'password', 'aria-label': 'Signing secret' });
  return h('div.card.span-6',
    h('h2', icon('zap'), 'Webhooks'),
    h('p.muted', 'room.created, room.ended, participant.joined, participant.left. Payloads contain counts only.'),
    h('label.field', h('span.field-label', 'Endpoint URL'), url),
    h('label.field', h('span.field-label', 'Signing secret'), h('div.keybox', secret,
      h('button.icon-btn', { type: 'button', 'aria-label': 'Reveal', onclick: () => { secret.type = secret.type === 'password' ? 'text' : 'password'; } }, icon('eye')),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Copy', onclick: () => navigator.clipboard.writeText(me.webhook.secret).then(() => toast('Copied', { type: 'success', timeout: 1500 })) }, icon('copy')))),
    h('div.btn-row', { class: 'mt' },
      h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => save({ webhook: { url: url.value } }, 'Webhook saved') }, 'Save'),
      h('button.btn.btn-ghost.btn-sm', {
        type: 'button',
        onclick: async () => {
          try { const r = await api('/v1/webhook/test', { method: 'POST', token: key }); toast(r.delivered ? 'Test event delivered (2xx)' : 'Delivery failed: check the URL and that it returns 2xx', { type: r.delivered ? 'success' : 'warn' }); } catch (e) { toast(e.message, { type: 'error' }); }
        },
      }, 'Send test event')),
    h('p.field-hint', icon('shield'), 'Verify X-BinaryBond-Signature: HMAC-SHA256 of "t.body" with this secret.'));
}

function domainsCard() {
  const ta = h('textarea.textarea.mono', { rows: 4, placeholder: 'https://app.example.com\nhttps://staging.example.com' });
  ta.value = me.domains.join('\n');
  return h('div.card.span-6',
    h('h2', icon('globe'), 'Allowed embed origins'),
    h('p.muted', 'Only these sites may frame /embed (Content-Security-Policy frame-ancestors). One origin per line.'),
    ta,
    h('div.btn-row', { class: 'mt' }, h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => save({ domains: ta.value.split(/\s+/).filter(Boolean) }, 'Allowed origins saved') }, 'Save origins')));
}

function liveCard(rooms) {
  const body = rooms.length
    ? h('div.table-wrap', h('table.table', h('thead', h('tr', h('th', 'Room ref'), h('th', 'People'), h('th', 'Started'), h('th', 'Closes'))),
      h('tbody', rooms.map(r => h('tr', h('td.mono', r.room), h('td', String(r.peers)), h('td', new Date(r.createdAt).toLocaleTimeString()), h('td', new Date(r.expiresAt).toLocaleTimeString()))))))
    : h('p.muted', 'No live rooms right now.');
  return h('div.card', h('div.card-head', h('div', h('h2', icon('people'), 'Live rooms'), h('p.muted', 'Room refs are one-way hashes; they cannot be used to join.')),
    h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => load() }, icon('refresh'), 'Refresh')), body);
}

async function save(patch, msg) {
  try {
    const r = await api('/v1/me', { method: 'PATCH', token: key, body: patch });
    me = r.tenant;
    toast(msg, { type: 'success' });
  } catch (e) { toast(e.message, { type: 'error' }); }
}
