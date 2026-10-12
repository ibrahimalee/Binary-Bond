// Docs/privacy pages: theme + live plan table.
import { h, $ } from './util.js';
import { applyTheme } from './ui.js';

applyTheme();

const host = $('#plansTable');
if (host) {
  fetch('/api/config').then(r => r.json()).then(({ plans }) => {
    const rows = Object.entries(plans).map(([id, p]) => h('tr',
      h('td', h('strong', p.label), id === 'public' ? h('small.muted', ' (no token)') : null),
      h('td', String(p.maxPeers)),
      h('td', p.maxMinutes >= 60 ? `${p.maxMinutes / 60} h` : `${p.maxMinutes} min`),
      h('td', p.monthlyPeerMinutes ? new Intl.NumberFormat().format(p.monthlyPeerMinutes) : '∞'),
      h('td', p.relay ? '✓' : '—'),
      h('td', p.whitelabel ? '✓' : '—')));
    host.replaceChildren(h('table',
      h('thead', h('tr', h('th', 'Plan'), h('th', 'People / room'), h('th', 'Call length'), h('th', 'Participant-min / month'), h('th', 'IP relay'), h('th', 'White-label'))),
      h('tbody', rows)));
  }).catch(() => host.replaceChildren(h('p.muted', 'Plans are configured by the server operator.')));
}
