# BinaryBond

Encrypted video meetings that run directly between devices. No accounts, no tracking, and nothing stored on the server. You can run it for yourself, or as a hosted service with API keys, embeddable calls, usage tracking and billing.

## How it works

When someone starts a meeting, their browser generates a random key and puts it after the `#` in the meeting link. Browsers never send that part of a URL to a server.

Each browser derives three values from the key:

- a meeting ID, which the server uses to route connections
- an access token, of which the server only keeps a hash
- an AES-256-GCM key, which never leaves the browser

The server relays a short, encrypted handshake. After that, audio, video, chat and files go straight between devices over WebRTC (DTLS-SRTP). Participants can compare a 20-digit safety number to confirm nobody is intercepting the connection.

## Features

**Meetings**
- Up to 8 people, with an adaptive grid, pinning, screen sharing (with audio) and picture-in-picture
- Waiting room, lock, remove participant, end for everyone, and scheduled auto-end
- Chat with disappearing and read-once messages, reactions, polls and a shared whiteboard
- File transfer up to 2 GB with integrity checks; photo location data is removed before sending
- Recording that starts only when every participant agrees, saved on the requester's device
- Captions transcribed on each speaker's own device (where the browser supports it)

**Privacy tools**
- Camera blur and pixelation, and a voice changer, applied before anything is sent
- Relay mode so other participants can't see your IP address
- `Shift` + `Esc` leaves the meeting and clears local data immediately
- No cookies, analytics or third-party scripts; strict Content Security Policy

**For developers and operators**
- Session API, embed SDK (`sdk.js`), signed webhooks and an OpenAPI spec at `/openapi.json`
- Plans, monthly quotas, usage charts and Stripe checkout
- Customer dashboard (`/dashboard`) and admin console (`/admin`)
- Prometheus metrics, rate limiting and a Docker setup with HTTPS and a TURN relay

## Pages

| Path | Purpose |
|---|---|
| `/` | Home page |
| `/security`, `/pricing`, `/developers` | Product information and API documentation |
| `/privacy`, `/terms` | Legal pages (the terms are a template to review with a lawyer) |
| `/new` | Creates a meeting key in the browser and opens the meeting |
| `/join` | Join with a link or a shared passphrase |
| `/room` | The meeting itself (lobby, call, end screen) |
| `/embed` | The meeting, for embedding in other sites through the SDK |
| `/dashboard`, `/admin` | Customer dashboard and operator console |

Pages are plain HTML. The server inserts the shared header, footer and icon set when it serves them (see `public/partials/`).

## Running locally

```bash
npm install
npm start
```

Then open http://localhost:3000. Browsers only allow camera and microphone access on `https://` or `localhost`, so use HTTPS when testing between devices.

- `npm run dev` restarts the server when files change
- `npm test` runs the test suite (Node's built-in test runner)
- Settings can go in a `.env` file; see `.env.example` for all of them

## Deploying

```bash
cp .env.example .env   # set DOMAIN, BB_SECRET, BB_ADMIN_TOKEN and BB_TURN_SECRET
docker compose up -d   # app, Caddy (automatic HTTPS) and coturn (TURN/STUN)
```

Open TCP 80 and 443, UDP 3478, TCP 5349 and UDP 49160 to 49999.

Before going live:

- Set `BB_SECRET` so session tokens survive restarts.
- Set a long, random `BB_ADMIN_TOKEN`. Without it, `/admin` and `/metrics` are disabled.
- Configure TURN. It enables relay mode and helps calls connect behind strict firewalls.
- Point `BB_STUN_URLS` at your own server so no third party sees participants' addresses.
- Set `BB_TRUST_PROXY` to the number of proxies in front of the app; rate limits depend on it.
- Keep `BB_DATA_DIR` on a persistent volume. It holds workspaces and usage totals.

Meetings are kept in memory, so a meeting has to stay on one server instance. To run several instances, route by the `s` query parameter on the WebSocket URL, for example with Caddy's `lb_policy query s`. Serverless platforms such as Vercel can't host the WebSocket server.

## Search engines

Public pages include canonical URLs, Open Graph and Twitter cards, and JSON-LD structured data (Organization, SoftwareApplication, FAQPage, BreadcrumbList). `/robots.txt` and `/sitemap.xml` are generated automatically. Set `PUBLIC_URL` to your real address (for example `https://meet.example.com`) so those links are correct. Meeting rooms, the dashboard and the admin console are marked `noindex`.

Titles and descriptions live in each page's own `<head>`; the FAQ structured data is read from the `<details>` blocks on the page, so editing the page updates both.

## Plans

Plan limits live in `server/plans.js` and can be overridden with `BB_PLANS`. Prices shown on `/pricing` are placeholders; edit `public/pricing.html` and set the matching Stripe price IDs (`STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`).

| Plan | People per meeting | Meeting length | Participant minutes per month |
|---|---|---|---|
| Personal (no account) | 4 | 1 hour | unlimited |
| Developer | 4 | 1 hour | 3,000 |
| Pro | 6 | 8 hours | 60,000 |
| Business | 8 | 24 hours | 500,000 |

## Project layout

```
server/
  index.js       startup, .env loading, graceful shutdown
  app.js         HTTP routes, security headers, page assembly, APIs, metrics
  rooms.js       meeting membership, host controls, limits and expiry
  ws.js          WebSocket transport, origin checks, rate limits
  tenants.js     workspaces, hashed API keys, session tokens
  usage.js       daily usage totals
  webhooks.js    signed webhook delivery with private-network blocking
  billing.js     Stripe checkout, portal and webhooks
  ice.js, stun.js  STUN/TURN configuration and a built-in STUN responder
public/
  *.html         pages; partials/ holds the shared header and footer
  css/           base, site (marketing), room (meeting), console (dashboard)
  js/app.js      meeting page
  js/crypto.js   key derivation, encryption, safety numbers
  js/mesh.js     peer connections
  js/media.js    devices, filters, voice changer
  js/chat.js, transfer.js, board.js, recorder.js, captions.js
  sdk.js         embed SDK
tests/           server, crypto and QR tests
```

## Security notes

- A compromised server could refuse service or see how many people met and when. It can't read or change meetings, messages, files or names, and can't join without the meeting key.
- Anyone with a meeting link can ask to join. Use the waiting room for sensitive meetings.
- Direct connections show your IP address to the other participants. Relay mode prevents this.

Please report security issues privately to the maintainer.

Built by Ibrahemeogoblin. MIT License. Home page photo by Vitaly Gariev on [Unsplash](https://unsplash.com/photos/UHfJI_lZoPo).
