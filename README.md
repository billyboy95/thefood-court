# The Food Court — pre-order

Pickup pre-order app for **The Food Court** on the EASTC Technocentric Varsity campus, 43 Maxwell Street, Kempton Park.

Students and staff browse the board, add items, pick a collection time, and show the confirmation screen at the counter. Pay on collection (cash or card). This is not a venue brochure.

Live site: [thefood-court.co.za](https://thefood-court.co.za/)

## Run locally

Need Node 18+. From the repo root:

```bash
npm test
npm start
```

Then open [http://localhost:5173](http://localhost:5173). `npm start` serves the static app with SPA fallback so `/cart`, `/checkout`, and `/order/:id` work.

You can also open `index.html` through any static file server. A module-capable server is required (do not use `file://`).

## What ships in the MVP

- Menu categories (breakfast, lunch pots, grill, sides, drinks)
- Item cards with ZAR prices from the published board
- Sticky cart, quantity steppers, cart page
- Checkout: name, South African phone number, pickup time, optional notes
- Confirmation ticket with order number (`FC-…`)
- Kitchen hours in `Africa/Johannesburg` (Mon–Fri 07:00–17:30, Sat 08:00–15:00, Sun closed)
- Pickup slots start 20 minutes from now, every 15 minutes, last slot 15 minutes before close
- Saturday-only brunch is disabled on other days

## Deploy to thefood-court.co.za

This repo is a **static GitHub Pages** site. Custom domain `thefood-court.co.za` is already set in [`CNAME`](./CNAME). [`.nojekyll`](./.nojekyll) keeps GitHub from running Jekyll so ES modules in `/js` are served as-is.

1. Merge to `main`.
2. In the GitHub repo: **Settings → Pages**.
3. Source: **Deploy from a branch**.
4. Branch: `main` / folder: `/ (root)`.
5. Save. HTTPS should stay on for `thefood-court.co.za`.
6. DNS: the domain must keep pointing at GitHub Pages (`192.168.2.2` A records or the `*.github.io` CNAME GitHub shows for this repo).

[`404.html`](./404.html) sends unknown paths back to the app so `/cart` and `/order/…` still work on Pages.

There is no build step. What you push is what goes live.

## Swap the mock kitchen for a real API

Orders are stored in **this browser** (`localStorage`) until a backend exists. The app already talks to an `OrderApi`:

| Method | Mock today | Live later |
| --- | --- | --- |
| `getMenu()` | [`js/data/menu.js`](js/data/menu.js) | `GET /menu` |
| `createOrder(input)` | [`js/api/mockBackend.js`](js/api/mockBackend.js) | `POST /orders` |
| `getOrder(id)` | `localStorage` | `GET /orders/:id` |

Point the app at a server by setting this in [`index.html`](index.html) **before** the module script:

```html
<script>window.FOODCOURT_API_URL = "https://api.thefood-court.co.za";</script>
```

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

The server should validate the menu, recompute totals in cents, and return an order object with `id`, `orderNumber`, `status`, `pickupTime`, `items`, and `totalCents`. HTTP client: [`js/api/httpBackend.js`](js/api/httpBackend.js).

Prices and copy live in [`js/data/menu.js`](js/data/menu.js). Update that file when the chalkboard changes.

## Brand

Navy `#0b1f3a` and gold `#e0b25a`, with the Food Court red mark. Pickup only — no delivery.
