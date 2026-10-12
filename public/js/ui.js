// UI primitives: toasts, modal dialogs, popover menus, synthesized sounds.

import { h, icon, $, store } from './util.js';
import { audioContext } from './media.js';

// ---- toasts --------------------------------------------------------------------
export function toast(message, { type = 'info', timeout = 4200, action = null } = {}) {
  let host = $('#toasts');
  if (!host) { host = h('div#toasts.toasts', { 'aria-live': 'polite', role: 'status' }); document.body.append(host); }
  const iconName = { info: 'info', success: 'check', warn: 'alert', error: 'alert' }[type] || 'info';
  const el = h(`div.toast.toast-${type}`, icon(iconName), h('span.toast-msg', message));
  if (action) el.append(h('button.toast-action', { type: 'button', onclick: () => { action.run(); dismiss(); } }, action.label));
  el.append(h('button.toast-close', { type: 'button', 'aria-label': 'Dismiss', onclick: () => dismiss() }, icon('x')));
  host.append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  let t = timeout ? setTimeout(dismiss, timeout) : null;
  el.addEventListener('mouseenter', () => clearTimeout(t));
  el.addEventListener('mouseleave', () => { if (timeout) t = setTimeout(dismiss, 1800); });
  function dismiss() { clearTimeout(t); el.classList.remove('in'); el.classList.add('out'); setTimeout(() => el.remove(), 260); }
  return dismiss;
}

// ---- modal ---------------------------------------------------------------------
export function modal({ title, body, actions = [], wide = false, onClose = null, className = '' }) {
  const dlg = h(`dialog.modal${wide ? '.modal-wide' : ''}`, { class: className, 'aria-labelledby': 'modal-title' });
  const close = () => { dlg.classList.add('closing'); setTimeout(() => { dlg.close(); dlg.remove(); onClose?.(); }, 160); };
  const head = h('header.modal-head', h('h2#modal-title', title), h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: close }, icon('x')));
  const foot = actions.length ? h('footer.modal-foot', actions.map(a => h(`button.btn.${a.kind || 'btn-ghost'}`, {
    type: 'button', onclick: async () => { const keep = await a.run?.(); if (keep !== true) close(); },
  }, a.icon ? icon(a.icon) : null, a.label))) : null;
  dlg.append(head, h('div.modal-body', body), foot);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  document.body.append(dlg);
  dlg.showModal();
  return { el: dlg, close };
}

export function confirmDialog({ title, message, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    modal({
      title, body: h('p.muted', message),
      actions: [
        { label: 'Cancel', kind: 'btn-ghost' },
        { label: confirm, kind: danger ? 'btn-danger' : 'btn-primary', run: () => { result = true; } },
      ],
      onClose: () => resolve(result),
    });
  });
}

// ---- popover menu ----------------------------------------------------------------
export function popover(anchor, items, { align = 'center' } = {}) {
  document.querySelectorAll('.popover').forEach(p => p.remove());
  const menu = h('div.popover', { role: 'menu' });
  for (const it of items) {
    if (it === '-') { menu.append(h('div.popover-sep')); continue; }
    if (it.custom) { menu.append(it.custom); continue; }
    menu.append(h(`button.popover-item${it.danger ? '.danger' : ''}${it.active ? '.active' : ''}`, {
      type: 'button', role: 'menuitem', disabled: it.disabled,
      onclick: () => { close(); it.run(); },
    }, it.icon ? icon(it.icon) : null, h('span', it.label), it.hint ? h('kbd', it.hint) : null));
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  let left = align === 'end' ? r.right - m.width : r.left + r.width / 2 - m.width / 2;
  left = Math.max(8, Math.min(left, innerWidth - m.width - 8));
  let top = r.top - m.height - 10;
  if (top < 8) top = r.bottom + 10;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  requestAnimationFrame(() => menu.classList.add('in'));
  const onDoc = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus(); } };
  setTimeout(() => { document.addEventListener('pointerdown', onDoc); document.addEventListener('keydown', onKey, true); });
  menu.querySelector('button')?.focus({ preventScroll: true });
  function close() { document.removeEventListener('pointerdown', onDoc); document.removeEventListener('keydown', onKey, true); menu.remove(); }
  return close;
}

// ---- sounds (synthesized, no files) -----------------------------------------------
const TONES = {
  join: [[660, 0.0, 0.09], [880, 0.09, 0.14]],
  leave: [[660, 0.0, 0.09], [440, 0.09, 0.16]],
  message: [[1046, 0.0, 0.07]],
  knock: [[523, 0.0, 0.1], [523, 0.16, 0.1], [784, 0.32, 0.16]],
  hand: [[784, 0.0, 0.08], [988, 0.08, 0.12]],
};
export function sound(name) {
  if (!store.get('sounds', true)) return;
  const tones = TONES[name];
  if (!tones) return;
  try {
    const ctx = audioContext();
    const t0 = ctx.currentTime + 0.01;
    for (const [freq, start, dur] of tones) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, t0 + start);
      g.gain.linearRampToValueAtTime(0.08, t0 + start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + start);
      o.stop(t0 + start + dur + 0.02);
    }
  } catch { /* audio unavailable */ }
}

// ---- theme ---------------------------------------------------------------------------
export function applyTheme(theme = store.get('theme', 'system')) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme; else root.dataset.theme = theme;
  store.set('theme', theme);
}

export function copyText(text, label = 'Copied to clipboard') {
  return navigator.clipboard.writeText(text).then(() => toast(label, { type: 'success', timeout: 2000 }), () => toast('Copy failed — select and copy manually', { type: 'warn' }));
}
