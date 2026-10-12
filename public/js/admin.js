// Operator console: live health, tenants, plans and keys.

import { $, h, icon } from './util.js';
import { toast, applyTheme, confirmDialog, modal } from './ui.js';
import { api, barChart, fmtNum, fmtDate, revealSecret } from './console.js';

const KEY = 'bb:adminToken';
const root = $('#root');
let token = sessionStorage.getItem(KEY);
let timer = null;

applyTheme();
$('#signOut').addEventListener('click', () => { sessionStorage.removeItem(KEY); token = null; clearInterval(timer); toggleChrome(false); login(); });
$('#refresh').addEventListener('click', () => load());
if (token) load(); else login();

function toggleChrome(on) { $('#signOut').hidden = !on; $('#refresh').hidden = !on; }

function login() {
  const input = h('input.input.mono', { type: 'password', placeholder: 'BB_ADMIN_TOKEN', autocomplete: 'off', required: true, 'aria-label': 'Admin token' });
  root.replaceChildren(h('div.card.auth-card',
    h('h1', 'Operator console'),
    h('p.muted', 'Sign in with the BB_ADMIN_TOKEN configured on this server.'),
    h('form', { onsubmit: (e) => { e.preventDefault(); token = input.value.trim(); sessionStorage.setItem(KEY, token); load(); } },
      h('label.field', h('span.field-label', 'Admin token'), input),
      h('button.btn.btn-primary.btn-block', { type: 'submit' }, 'Sign in'))));
  input.focus();
}

async function load() {
  try {
    const [ov, t] = await Promise.all([api('/admin/api/overview', { token }), api('/admin/api/tenants', { token })]);
    toggleChrome(true);
    render(ov, t.tenants);
    clearInterval(timer);
    timer = setInterval(refreshLive, 10000);
  } catch (e) {
    if (e.status === 401 || e.status === 404) {
      toast(e.status === 404 ? 'The admin console is disabled on this server (set BB_ADMIN_TOKEN).' : 'Invalid admin token.', { type: 'error' });
      sessionStorage.removeItem(KEY);
      token = null;
      toggleChrome(false);
      login();
    } else toast(e.message, { type: 'error' });
  }
}

async function refreshLive() {
  if (document.hidden) return;
  try {
    const ov = await api('/admin/api/overview', { token });
    const live = $('#live');
    if (live) live.replaceWith(liveStats(ov));
  } catch { /* transient */ }
}

function liveStats(ov) {
  const s = ov.live;
  const tile = (label, value, sub) => h('div.card.span-3', h('div.stat', h('span.stat-label', label), h('span.stat-value', value), h('span.stat-sub', sub)));
  return h('section.cards#live',
    tile('Live rooms', fmtNum(s.rooms), `${fmtNum(s.waiting)} in waiting rooms`),
    tile('Participants', fmtNum(s.peers), `${fmtNum(ov.connections)} sockets open`),
    tile('Rooms created', fmtNum(s.roomsCreated), `${fmtNum(s.joins)} joins · ${fmtNum(s.denied)} denied`),
    tile('Signaling relayed', fmtNum(s.relayed), `${(s.relayedBytes / 1048576).toFixed(1)} MB opaque ciphertext`));
}

function render(ov, tenants) {
  root.replaceChildren(
    h('header.console-head', h('div', h('h1', 'Operations'), h('p.muted', `v${ov.version} · ${fmtNum(ov.tenants)} workspaces · webhooks ${fmtNum(ov.webhooks.delivered)} ok / ${fmtNum(ov.webhooks.failed)} failed`)),
      h('button.btn.btn-primary', { type: 'button', onclick: () => createTenant(ov.plans) }, icon('user-plus'), 'New workspace')),
    liveStats(ov),
    h('section.cards', { class: 'mt' },
      h('div.card', h('h2', icon('activity'), 'Public usage (no token)'), h('p.muted', 'Participant-minutes per day for anonymous rooms.'),
        barChart(ov.publicUsage, { labelOf: d => d.date, valueOf: d => d.peerSeconds / 60 })),
      h('div.card', h('h2', icon('people'), 'Workspaces'), tenantTable(tenants, ov.plans))));
}

function tenantTable(tenants, plans) {
  if (!tenants.length) return h('p.muted', 'No workspaces yet. Create one to issue an API key.');
  return h('div.table-wrap', h('table.table',
    h('thead', h('tr', h('th', 'Workspace'), h('th', 'Plan'), h('th', 'This month'), h('th', 'Live'), h('th', 'Created'), h('th', ''))),
    h('tbody', tenants.map(t => {
      const plan = h('select.select', { 'aria-label': 'Plan', onchange: (e) => patch(t.id, { plan: e.target.value }, 'Plan updated') },
        Object.entries(plans).filter(([k]) => k !== 'public').map(([k, p]) => h('option', { value: k, selected: k === t.plan }, p.label)));
      const quota = t.limits?.monthlyPeerMinutes;
      return h('tr',
        h('td', h('div', h('span', { class: `status-dot${t.disabled ? ' off' : ''}` }), h('strong', t.name)), h('small.muted', `${t.id}${t.email ? ` · ${t.email}` : ''}`)),
        h('td', plan),
        h('td', `${fmtNum(t.monthPeerMinutes)}${quota ? ` / ${fmtNum(quota)}` : ''} min`),
        h('td', String(t.activeRooms)),
        h('td', fmtDate(t.createdAt)),
        h('td', h('div.actions',
          h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => patch(t.id, { disabled: !t.disabled }, t.disabled ? 'Workspace enabled' : 'Workspace disabled') }, t.disabled ? 'Enable' : 'Disable'),
          h('button.icon-btn', { type: 'button', title: 'Rotate API key', 'aria-label': 'Rotate API key', onclick: () => rotate(t) }, icon('key')),
          h('button.icon-btn.danger', { type: 'button', title: 'Delete', 'aria-label': 'Delete workspace', onclick: () => remove(t) }, icon('trash')))));
    }))));
}

async function patch(id, body, msg) {
  try { await api(`/admin/api/tenants/${id}`, { method: 'PATCH', token, body }); toast(msg, { type: 'success' }); load(); } catch (e) { toast(e.message, { type: 'error' }); }
}

async function rotate(t) {
  if (!await confirmDialog({ title: `Rotate key for ${t.name}?`, message: 'Their current key stops working immediately.', confirm: 'Rotate', danger: true })) return;
  try {
    const { apiKey } = await api(`/admin/api/tenants/${t.id}/rotate-key`, { method: 'POST', token });
    modal({ title: 'New API key', body: revealSecret(t.name, apiKey, 'Send it to the customer over a secure channel. It will not be shown again.') });
  } catch (e) { toast(e.message, { type: 'error' }); }
}

async function remove(t) {
  if (!await confirmDialog({ title: `Delete ${t.name}?`, message: 'The workspace and its key are removed permanently. Usage history is kept as anonymous aggregates.', confirm: 'Delete', danger: true })) return;
  try { await api(`/admin/api/tenants/${t.id}`, { method: 'DELETE', token }); toast('Workspace deleted', { type: 'success' }); load(); } catch (e) { toast(e.message, { type: 'error' }); }
}

function createTenant(plans) {
  const name = h('input.input', { required: true, maxLength: 80, placeholder: 'Acme Inc.' });
  const email = h('input.input', { type: 'email', placeholder: 'billing@acme.com' });
  const plan = h('select.select', Object.entries(plans).filter(([k]) => k !== 'public').map(([k, p]) => h('option', { value: k }, p.label)));
  const out = h('div');
  modal({
    title: 'New workspace',
    body: h('div', h('label.field', h('span.field-label', 'Name'), name), h('label.field', h('span.field-label', 'Contact email'), email), h('label.field', h('span.field-label', 'Plan'), plan), out),
    actions: [{
      label: 'Create', kind: 'btn-primary', run: async () => {
        if (out.childElementCount) return false;
        try {
          const r = await api('/admin/api/tenants', { method: 'POST', token, body: { name: name.value, email: email.value, plan: plan.value } });
          out.replaceChildren(revealSecret('API key', r.apiKey, 'Copy it now: it is shown only once.'));
          load();
        } catch (e) { toast(e.message, { type: 'error' }); }
        return true;
      },
    }],
  });
  setTimeout(() => name.focus(), 50);
}
