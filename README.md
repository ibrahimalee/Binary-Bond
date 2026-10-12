# BinaryBond

**Private calls that leave no trace.** End-to-end encrypted, peer-to-peer video, voice, chat and file sharing, with no accounts, cookies or analytics, and nothing stored. Self-host it for yourself, or run it as a multi-tenant SaaS with API keys, embeds, usage metering, webhooks and Stripe billing.

```
browser A ──(sealed SDP/ICE)──► server ──(sealed SDP/ICE)──► browser B
    │                         (sees only noise)                  │
    └───────────── DTLS-SRTP / DTLS-SCTP, direct P2P ────────────┘
```

## Why it's different

| | |
|---|---|
| **Zero-knowledge rooms** | The 128-bit room key lives only in the invite link's `#fragment`, which browsers never send to servers. HKDF derives a public room ID, a membership token (the server stores only its SHA-256) and an AES-256-GCM key that never leaves the browser. |
| **Sealed signaling** | SDP and ICE are encrypted with `from\|to` bound as associated data, so the server can't read, forge or re-route them, and can't swap DTLS fingerprints to sit in the middle. |
| **Safety numbers** | Six emoji plus 12 digits derived from both DTLS fingerprints. Compare them out loud to prove there's no man-in-the-middle. |
| **Passphrase rooms** | Meet with just a room name and a shared passphrase (PBKDF2, 600k iterations). No link ever has to be sent. |
| **Voice disguise & video privacy filters** | Pitch-shift (deep/high/robot) and blur/pixelate are applied on-device before anything is transmitted. |
| **Clean file drops** | P2P transfers up to 2 GB with explicit accept, SHA-256 verification, and automatic EXIF/GPS stripping for photos. |
| **Disappearing chat** | Per-room timers, burn-after-reading notes, unsend for everyone, reactions, typing indicators. |
| **Panic wipe** | <kbd>Shift</kbd>+<kbd>Esc</kbd> kills every connection, stops devices, erases local storage and navigates to a blank page. |
| **Shoulder-surf shield** | Optional blur when the window loses focus, camera auto-pause in background tabs, invite link hidden from the address bar. |
| **Host controls** | Waiting room with knock/admit, lock, remove, ask-to-mute, end-for-everyone, automatic host hand-over. |
| **Transparency panel** | Shows live route (direct vs relay), candidate types, RTT, bitrate, loss and codec, plus exactly what the server can and can't see. |
| **No third parties** | No CDNs, fonts or trackers. There's a built-in STUN responder, and the QR encoder runs locally, so invite links are never sent to a QR service. |

Also: full-mesh group calls (up to 8), adaptive layouts with a draggable self-view, spotlight/pin, screen share, PiP, reactions, raise hand, push-to-talk, a muted-while-talking hint, keyboard shortcuts, dark/light themes, an installable PWA, and a responsive design down to small phones.

## Quick start

```bash
npm install
npm start            # http://localhost:3000
```

Or run `start.bat` (Windows) or `./start.sh` (macOS/Linux). Browsers only allow camera and mic on `https://` or `localhost`, so use HTTPS when testing across devices.

Development: `npm run dev` (auto-restart), `npm test` (node:test, no extra deps).

## Production

```bash
cp .env.example .env     # set DOMAIN, BB_SECRET, BB_ADMIN_TOKEN, BB_TURN_SECRET
docker compose up -d     # app + Caddy (auto HTTPS) + coturn (TURN/STUN)
```

Open UDP 3478, TCP 5349, UDP 49160-49999 and TCP 80/443 on the host.

**Checklist**
- `BB_SECRET` is set, so session tokens survive restarts and replicas share them.
- `BB_ADMIN_TOKEN` is long and random. `/admin` and `/metrics` are disabled without it.
- TURN is configured: it makes "Hide my IP" available and rescues calls behind strict NATs.
- `BB_STUN_URLS` points at your own server, so no third party sees participants' IPs.
- `BB_TRUST_PROXY` matches the number of proxies in front of the app (the rate limits depend on it).
- `/data` is on a persistent volume (workspaces and usage aggregates).

> **Scaling:** rooms live in process memory. Clients connect to `/ws?s=<shard>` (a prefix of the room ID), so you can run several instances and pin each room to one of them with a query-hash load-balancing policy, e.g. in Caddy: `reverse_proxy app1:3000 app2:3000 { lb_policy query s }`. Workspaces live in `BB_DATA_DIR`, so keep the control plane (dashboard/admin/API) on one instance or a shared volume. Serverless platforms such as Vercel can't host the WebSocket signaling server.

## SaaS mode

| Surface | What it does |
|---|---|
| `/dashboard` | Self-serve signup (`BB_OPEN_SIGNUP=1`), usage charts, quota meter, plans and billing, embed session generator, API key rotation, white-label branding, webhooks, allowed embed origins. |
| `/admin` | Operator console: live health, public usage, workspaces, plan changes, disable, rotate, delete. |
| `/docs` | Developer documentation: REST API, SDK, events, webhooks, security model. |
| `/sdk.js` | `BinaryBond.mount('#el', { token })` iframe embed with events. |
| `/metrics` | Prometheus text format (Bearer `BB_METRICS_TOKEN`). |

**Plans** (`server/plans.js`, overridable via `BB_PLANS`):

| Plan | People/room | Call length | Participant-min/mo | IP relay | White-label |
|---|---|---|---|---|---|
| Public (no token) | 4 | 1 h | ∞ | ✓ | |
| Free | 4 | 1 h | 3,000 | | |
| Pro | 6 | 8 h | 60,000 | ✓ | |
| Business | 6 | 24 h | 500,000 | ✓ | ✓ |

**Billing:** set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_PRO` / `STRIPE_PRICE_BUSINESS`, then point a Stripe webhook at `/billing/stripe-webhook` (events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`).

**What's stored:** workspaces (name, email, SHA-256 of the API key, plan, branding, webhook URL and secret, domains) and daily aggregate counters. No room IDs, IPs, names or content.

## Architecture

```
server/
  index.js      entry: .env, listen, STUN, graceful shutdown
  app.js        HTTP: security headers/CSP, pages, public + tenant + admin APIs, metrics
  rooms.js      zero-knowledge room broker (membership, host powers, limits, expiry)
  ws.js         WebSocket transport: origin checks, per-IP caps, rate limits, heartbeats
  tenants.js    workspaces, hashed API keys, signed session tokens
  usage.js      aggregate metering        webhooks.js  signed delivery + SSRF guard
  billing.js    Stripe (no SDK)           ice.js       STUN/TURN (coturn REST creds)
  stun.js       RFC 5389 binding responder   ratelimit.js  token buckets
public/
  js/crypto.js  HKDF/AES-GCM/PBKDF2, safety numbers   js/signaling.js  sealed relay client
  js/mesh.js    perfect-negotiation peer connections   js/media.js      devices, filters, voice FX
  js/transfer.js  P2P files                             js/chat.js       ephemeral chat
  js/app.js     UI orchestration    js/qr.js  local QR encoder    sdk.js  embed SDK
```

## Security

Report vulnerabilities privately to the maintainer. Threat-model highlights:
- A malicious server can deny service, or count participants and timing. It can't read or alter calls, messages, files or names, and can't impersonate participants without the room key.
- Anyone holding the invite link can request to join. Use the waiting room and lock, and verify safety numbers for sensitive calls.
- Direct P2P reveals IP addresses to the other participants. Use relay mode to prevent it.

Built by **Ibrahemeogoblin** · MIT License
