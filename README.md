# The Food Court — pre-order

Pickup pre-order app for **The Food Court** on the EASTC Technocentric Varsity campus, 43 Maxwell Street, Kempton Park.

Students and staff browse the board, add items, pick a collection time, and show the confirmation screen at the counter. Pay on collection (cash or card). This is not a venue brochure.

Live site: [thefood-court.co.za](https://thefood-court.co.za/)

Kitchen board (staff PIN): [thefood-court.co.za/kitchen.html](https://thefood-court.co.za/kitchen.html)

## Architecture

GitHub Pages is **static** — it cannot share orders between a student’s phone and the till. This repo therefore has two pieces:

| Piece | What it is | Where it runs |
| --- | --- | --- |
| Student app + kitchen screen | HTML / JS / CSS | GitHub Pages (`thefood-court.co.za`) |
| Shared orders API | Cloudflare Worker + KV | `thefood-court-api.<account>.workers.dev` (or a custom `api.` host) |

Until the Worker URL is set, `createOrder` still saves in **this browser’s `localStorage`** so local demo works. The till will not see those orders. Point both `index.html` / `kitchen.html` at the Worker by setting `FOODCOURT_API_URL` (see below).

Pay stays **at the counter**. There is no card capture in the app.

## Run locally

Need Node 18+. From the repo root:

```bash
npm test
npm start
```

Then open [http://localhost:5173](http://localhost:5173). `npm start` serves the static app with SPA fallback (`serve.json` keeps `.html` URLs). `/cart`, `/checkout`, `/order/:id`, and `/kitchen` load the app; `/kitchen.html` is a real file — bookmark that on the till laptop or TV.

Local demo PIN for `/kitchen.html` is **`1234`** (override with `window.FOODCOURT_STAFF_PIN`). WhatsApp is not sent from the browser.

To exercise the **shared** API on your machine:

```bash
cp .dev.vars.example .dev.vars   # edit PIN / WhatsApp if you want
npm run api:dev                  # Worker at http://localhost:8787
```

In `js/config.js` (or the `window.FOODCOURT_API_URL` script in `index.html` and `kitchen.html`) set:

```js
export const FOODCOURT_API_URL = "http://localhost:8787";
```

Then run `npm start` as well. Student checkout and the kitchen board share the local Worker KV.

You can also open `index.html` through any static file server. A module-capable server is required (do not use `file://`).

## What ships

- Menu categories (breakfast, lunch pots, grill, sides, drinks)
- Item cards with ZAR prices from the published board
- Sticky cart, quantity steppers, cart page
- Checkout: name, South African phone number, pickup time, optional notes
- Confirmation ticket with order number (`FC-…`)
- Kitchen hours in `Africa/Johannesburg` (Mon–Fri 07:00–17:30, Sat 08:00–15:00, Sun closed)
- Pickup slots start 20 minutes from now, every 15 minutes, last slot 15 minutes before close
- Saturday-only brunch is disabled on other days — **createOrder rejects it** even if the cart was stale
- Kitchen counter board at `/kitchen.html` (Received → Preparing → Ready → Collected, auto-refresh)
- WhatsApp ping to the kitchen phone on each new pre-order (Worker; fail-soft)

## Deploy to thefood-court.co.za (Pages)

This repo is a **static GitHub Pages** site. Custom domain `thefood-court.co.za` is already set in [`CNAME`](./CNAME). [`.nojekyll`](./.nojekyll) keeps GitHub from running Jekyll so ES modules in `/js` are served as-is.

1. Merge to `main`.
2. In the GitHub repo: **Settings → Pages**.
3. Source: **Deploy from a branch**.
4. Branch: `main` / folder: `/ (root)`.
5. Save. HTTPS should stay on for `thefood-court.co.za`.
6. DNS: the domain must keep pointing at GitHub Pages (`192.168.2.2` A records or the `*.github.io` CNAME GitHub shows for this repo).

[`404.html`](./404.html) sends unknown paths back to the app so `/cart` and `/order/…` still work on Pages. `/kitchen.html` is a real file (bookmark that on the till laptop/TV). `/kitchen` redirects there.

There is no build step. What you push is what goes live.

**After the Worker is deployed**, set the API URL in [`js/config.js`](js/config.js):

```js
export const FOODCOURT_API_URL = "https://thefood-court-api.<your-subdomain>.workers.dev";
```

Commit that change and let Pages update. Same value is used by the student app and the kitchen board.

## Deploy the orders API (Cloudflare Worker)

Free Cloudflare account is enough (Workers + KV).

1. Install nothing if you have Node — Wrangler runs via npx.
2. Login: `npx wrangler login`
3. Create KV:
   ```bash
   npx wrangler kv namespace create ORDERS
   npx wrangler kv namespace create ORDERS --preview
   ```
4. Paste the two ids into [`wrangler.toml`](wrangler.toml) (`id` and `preview_id`).
5. Put secrets (see table below):
   ```bash
   npx wrangler secret put STAFF_PIN
   npx wrangler secret put KITCHEN_WHATSAPP
   npx wrangler secret put CALLMEBOT_APIKEY
   ```
6. Deploy: `npm run api:deploy` (or `npx wrangler deploy`).
7. Copy the printed `*.workers.dev` URL into `js/config.js` as `FOODCOURT_API_URL` and deploy Pages.

Optional GitHub Action: [`.github/workflows/deploy-api.yml`](.github/workflows/deploy-api.yml) (`workflow_dispatch`). Add repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Menu prices live in [`js/data/menu.js`](js/data/menu.js). The Worker **bundles that file**, so after chalkboard changes redeploy **Pages and the Worker**.

### Environment / secrets

| Name | Where | Required | Purpose |
| --- | --- | --- | --- |
| `FOODCOURT_API_URL` | `js/config.js` or `window.FOODCOURT_API_URL` | For live kitchen | Worker origin, no trailing slash |
| `STAFF_PIN` | Worker secret (or `.dev.vars` locally) | Kitchen board | Till PIN. Local mock default is `1234` |
| `KITCHEN_WHATSAPP` | Worker secret | For WhatsApp | Kitchen phone in E.164 **without** spaces, e.g. `27821234567` or `+27821234567` |
| `CALLMEBOT_APIKEY` | Worker secret | For CallMeBot | API key from CallMeBot (recommended simple SA path) |
| `TWILIO_ACCOUNT_SID` | Worker secret | Twilio alt. | Twilio account |
| `TWILIO_AUTH_TOKEN` | Worker secret | Twilio alt. | Twilio token |
| `TWILIO_WHATSAPP_FROM` | Worker secret | Twilio alt. | e.g. `whatsapp:+14155238886` (sandbox or live sender) |

If WhatsApp is not configured, **the order still saves**. The kitchen board shows a banner. Never put secrets in the static Pages files.

### WhatsApp setup (CallMeBot — simple SA path)

This is the default provider when Twilio is not fully configured.

1. From the **kitchen phone**, WhatsApp the CallMeBot setup number (see [CallMeBot WhatsApp](https://www.callmebot.com/blog/free-api-whatsapp-messages/)) and wait for the API key.
2. Set `KITCHEN_WHATSAPP` to that phone in E.164 (`2782…`).
3. `npx wrangler secret put CALLMEBOT_APIKEY` with the key they sent you.
4. Place a test pre-order. The phone should get a short message: order `FC-…`, pickup time, items, name, phone.

### WhatsApp setup (Twilio — alternative)

If `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_WHATSAPP_FROM` are all set, the Worker uses Twilio instead of CallMeBot.

1. Create a Twilio account and enable WhatsApp (sandbox is enough to trial).
2. Join the sandbox from the kitchen phone.
3. Set `KITCHEN_WHATSAPP` to the kitchen number (`+2782…`).
4. Set `TWILIO_WHATSAPP_FROM` to the sandbox/live WhatsApp sender (`whatsapp:+14…`).
5. Store the three Twilio secrets with `wrangler secret put`.

### Kitchen board

- URL: `/kitchen.html` (also `/kitchen`).
- Designed for a laptop or TV at the till; filters stack on a phone.
- Open orders: number, name, phone, pickup time, items, notes, total.
- Buttons: **Start preparing** → **Mark ready** → **Collected**.
- Auto-refresh every 8 seconds. Optional beep on new orders (mute in the header).
- Lock when you leave the counter.

API shape used by [`js/api/httpBackend.js`](js/api/httpBackend.js):

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/menu` | public |
| `POST` | `/orders` | public (students) |
| `GET` | `/orders/:id` | public (confirmation UUID) |
| `POST` | `/kitchen/login` | PIN body or `X-Staff-Pin` |
| `GET` | `/kitchen/orders` | `X-Staff-Pin` |
| `PATCH` | `/kitchen/orders/:id` | `X-Staff-Pin` + `{ "status": "preparing" }` |

Expected JSON for `POST /orders`:

```json
{
  "customerName": "Thabo",
  "phone": "0821234567",
  "pickupTime": "2026-09-17T12:15:00.000Z",
  "notes": "No chilli",
  "items": [{ "itemId": "campus-burger", "qty": 1 }]
}
```

The server validates the menu (including day-gated items), recomputes totals in cents, and returns an order with `id`, `orderNumber`, `status`, `pickupTime`, `items`, `totalCents`, and `payOnCollection: true`.

## Brand

Navy `#0b1f3a` and gold `#e0b25a`, with the Food Court red mark. Pickup only — no delivery.
