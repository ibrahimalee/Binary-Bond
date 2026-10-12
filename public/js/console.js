// Helpers shared by the dashboard and admin console.

import { h, icon } from './util.js';
import { toast } from './ui.js';

export async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error(json?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

export const fmtNum = (n) => new Intl.NumberFormat().format(Math.round(n || 0));
export const fmtDate = (t) => new Date(t).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

// Accessible SVG bar chart built with DOM APIs (CSP-safe).
export function barChart(points, { valueOf = (p) => p.value, labelOf = (p) => p.label, format = fmtNum, height = 200 } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const W = 720, H = height, padL = 36, padB = 22, padT = 10;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('preserveAspectRatio', 'none');
  const max = Math.max(4, ...points.map(valueOf));
  const nice = niceMax(max);
  const el = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const defs = el('defs', {});
  const grad = el('linearGradient', { id: 'chartGrad', x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.append(el('stop', { offset: '0', 'stop-color': '#8b5cf6' }), el('stop', { offset: '1', 'stop-color': '#22d3ee' }));
  defs.append(grad);
  svg.append(defs);
  for (let i = 0; i <= 4; i++) {
    const y = padT + (H - padT - padB) * (1 - i / 4);
    svg.append(el('line', { x1: padL, x2: W, y1: y, y2: y, class: 'grid-line' }));
    const t = el('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end', class: 'axis' });
    t.textContent = compact(nice * i / 4);
    svg.append(t);
  }
  const bw = (W - padL) / points.length;
  let tip = null;
  points.forEach((p, i) => {
    const v = valueOf(p);
    const bh = Math.max(v > 0 ? 2 : 0, (H - padT - padB) * (v / nice));
    const r = el('rect', { x: padL + i * bw + bw * 0.18, y: H - padB - bh, width: bw * 0.64, height: bh, rx: Math.min(4, bw * 0.2), class: 'bar' });
    const title = el('title', {});
    title.textContent = `${labelOf(p)}: ${format(v)}`;
    r.append(title);
    r.addEventListener('pointerenter', (e) => {
      tip = h('div.chart-tip', `${labelOf(p)} · ${format(v)}`);
      document.body.append(tip);
      move(e);
    });
    r.addEventListener('pointermove', move);
    r.addEventListener('pointerleave', () => { tip?.remove(); tip = null; });
    svg.append(r);
    if (points.length <= 14 || i % Math.ceil(points.length / 10) === 0) {
      const t = el('text', { x: padL + i * bw + bw / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis' });
      t.textContent = labelOf(p).slice(5);
      svg.append(t);
    }
  });
  function move(e) { if (tip) { tip.style.left = `${e.clientX + 12}px`; tip.style.top = `${e.clientY - 34}px`; } }
  return svg;
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  // Multiples that divide evenly into four gridlines, so ticks stay whole numbers.
  for (const m of [1, 2, 4, 8, 10]) if (m * p >= v) return Math.max(4, m * p);
  return 10 * p;
}
const compact = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : `${+n.toFixed(n < 10 ? 1 : 0)}`);

export function codeBlock(text) {
  const pre = h('pre.code', h('code', text));
  pre.append(h('button.icon-btn.copy-code', { type: 'button', 'aria-label': 'Copy', onclick: () => navigator.clipboard.writeText(text).then(() => toast('Copied', { type: 'success', timeout: 1500 })) }, icon('copy')));
  return pre;
}

export function revealSecret(label, value, note) {
  return h('div.secret-reveal', h('strong', label), h('code', value), note ? h('span.muted', note) : null,
    h('div', h('button.btn.btn-sm', { type: 'button', onclick: () => navigator.clipboard.writeText(value).then(() => toast('Copied', { type: 'success', timeout: 1500 })) }, icon('copy'), 'Copy')));
}
