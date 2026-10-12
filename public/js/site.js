// Shared behaviour for marketing and content pages.

const header = document.getElementById('siteHeader');
const toggle = document.getElementById('navToggle');

toggle?.addEventListener('click', () => {
  const open = header.classList.toggle('open');
  toggle.setAttribute('aria-expanded', String(open));
});

// Invite links used to point at "/#<key>". Keep them working.
const key = location.hash.slice(1);
if (location.pathname === '/' && /^[A-Za-z0-9_-]{22,64}$/.test(key)) {
  location.replace(`/room#${key}`);
}

// Pricing page: fill in limits from the server so they always match reality.
const plansHost = document.getElementById('planLimits');
if (plansHost) {
  fetch('/api/config').then(r => r.json()).then(({ plans }) => {
    for (const el of plansHost.querySelectorAll('[data-plan]')) {
      const p = plans[el.dataset.plan];
      if (!p) continue;
      el.querySelector('[data-k="peers"]').textContent = `Up to ${p.maxPeers} people per meeting`;
      el.querySelector('[data-k="length"]').textContent = p.maxMinutes >= 60 ? `Meetings up to ${p.maxMinutes / 60} ${p.maxMinutes === 60 ? 'hour' : 'hours'}` : `Meetings up to ${p.maxMinutes} minutes`;
      const mins = el.querySelector('[data-k="minutes"]');
      if (mins) mins.textContent = p.monthlyPeerMinutes ? `${new Intl.NumberFormat().format(p.monthlyPeerMinutes)} participant minutes a month` : 'Unlimited participant minutes';
    }
  }).catch(() => {});
}

// Gentle reveal-on-scroll. Content stays fully visible without JavaScript or
// when the visitor prefers reduced motion.
if (!matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
  document.documentElement.classList.add('js');
  const targets = document.querySelectorAll('.feature-row, .photo-card, .mini, .card, .steps li, .plan, .fact, .section-head, .shot, .compare, .faq details, .code-sample');
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  targets.forEach((el, i) => { el.classList.add('reveal'); el.style.transitionDelay = `${(i % 4) * 60}ms`; io.observe(el); });
}
