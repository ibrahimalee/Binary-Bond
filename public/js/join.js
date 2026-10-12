import { isSecret, secretFromPassphrase } from './crypto.js';

const $ = (s) => document.querySelector(s);

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    }
    for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab.dataset.tab;
    document.querySelector(`[data-panel="${tab.dataset.tab}"] input`)?.focus();
  });
}

function keyFrom(value) {
  const v = value.trim();
  try { return new URL(v).hash.slice(1); } catch { return v.replace(/^#/, ''); }
}

$('#linkForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const key = keyFrom($('#linkInput').value);
  if (!isSecret(key)) { $('#linkError').hidden = false; $('#linkInput').focus(); return; }
  sessionStorage.removeItem('bb:creator');
  location.href = `/room#${key}`;
});
$('#linkInput').addEventListener('input', () => { $('#linkError').hidden = true; });

$('#passForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#passBtn');
  btn.classList.add('loading');
  $('#passError').hidden = true;
  try {
    const key = await secretFromPassphrase($('#passRoom').value, $('#passPhrase').value);
    $('#passPhrase').value = '';
    sessionStorage.removeItem('bb:creator');
    location.href = `/room#${key}`;
  } catch (err) {
    $('#passError').textContent = err.message;
    $('#passError').hidden = false;
    btn.classList.remove('loading');
  }
});
