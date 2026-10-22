# The Food Court — pre-order

Pickup pre-order app for **The Food Court** on the EASTC Technocentric Varsity campus, 43 Maxwell Street, Kempton Park.

Students browse the board, pay from a wallet, by card, or at the counter, and collect from a timed slot. Kitchen staff run the till, the 86 board, stock, and the day’s numbers from the same site.

Live site: [thefood-court.co.za](https://thefood-court.co.za/)

## Architecture

GitHub Pages stays the static host. Shared orders, wallets, stock, and schedules live in one Supabase project.

| Piece | What it is | Where it runs |
| --- | --- | --- |
| Student app, wallet, counter, kitchen | HTML / JS / CSS | GitHub Pages (`thefood-court.co.za`) |
| Database, Auth, Storage, RLS | Postgres | Supabase |
| API, WhatsApp, payments, cron jobs | Edge Functions | `api`, `automations`, `whatsapp-webhook`, `payments-webhook` |

Leave `SUPABASE_URL` and `SUPABASE_ANON_KEY` empty and the site runs entirely in this browser. That demo mode still exercises every screen, with seeded rows labelled **Sample demo data — not live sales**. Nothing on that device is visible to another phone.

The anon key is the only value that belongs in the static site. Service-role and provider secrets stay in Supabase function secrets. They are never written to git.

## Run locally

Need Node 18+. From the repo root:

```bash
npm test
npm start
```

Open [http://localhost:5173](http://localhost:5173). `npm start` serves the static app with SPA fallback. `/kitchen.html` is a real file — bookmark that on the till laptop or TV.

Demo sign-in (this browser only):

| Who | How |
| --- | --- |
| Students `20240001`, `20240002`, `20240003` | PIN `1234`. Email code `000000` (no email is sent). |
| Kitchen manager | PIN `1234` on `/kitchen`, reports, stock, and settings. |
| Chef upload | PIN `2468` on `/chef`. |

Lerato (`20240002`) is one stamp from a free meal and under the R50 low-balance line. Amahle (`20240003`) has an empty wallet. Salad box is already sold out.

WhatsApp, email, and card providers are no-ops until keys exist. Buttons still run, and the kitchen log shows the message that would have been sent.

## What ships

- Menu, cart, and checkout. Default payment is pay on collection, so an order with no method still has `payOnCollection: true`.
- Wallet: student number + PIN, or a 6-digit email code. Prepaid credit, ledger, purchase history. Balances cannot go negative. A kitchen cancel refunds a paid wallet order.
- Till: rotating `FC1.` QR, student number + PIN, Web NFC where Android Chrome exposes a card serial, or a Yoco card tap.
- Pickup slots, 8 orders each unless settings say otherwise. A full slot closes and the next free slot is named.
- Loyalty: the 10th meal makes one unit of the dearest line free, then stamps reset.
- Chef specials from an allowlisted WhatsApp photo (`Monday special: Burgers R55`) or `/chef`. If nothing arrives by 09:00 the printed menu special stays up. The board is never blank.
- Public `/counter` of orders marked Ready, updated with the kitchen board.
- `/kitchen/reports` for a manager: revenue by wallet, card, and cash, items, day and hour, specials, wallet liability, refunds, cost of sales, stock value, gross margin, CSV.
- `/kitchen/stock`: ingredients, suppliers, cost, recipes, goods received, waste, stock-take variance, reorder list. Sales deduct the recipe.
- `/kitchen/settings`: thresholds, times, and destination numbers. Provider keys are not on this page.
- Scheduled jobs (pg_cron calls the `automations` function): low balance and optional auto top-up, no-show reminder then refund or write-off, 07:00 chef nudge, 09:00 default-menu check, stock alerts, end-of-day WhatsApp, Monday CSV email, morning prep forecast, nightly payment reconciliation, and low ratings to the manager.

## Deploy the site (GitHub Pages)

This repo is a static GitHub Pages site. Custom domain `thefood-court.co.za` is already set in [`CNAME`](./CNAME). [`.nojekyll`](./.nojekyll) keeps GitHub from running Jekyll so ES modules in `/js` are served as-is.

1. Merge to `main`.
2. In the GitHub repo: **Settings → Pages**.
3. Source: **Deploy from a branch**.
4. Branch: `main` / folder: `/ (root)`.
5. Save. HTTPS should stay on for `thefood-court.co.za`.
6. DNS: the domain must keep pointing at GitHub Pages.

[`404.html`](./404.html) sends unknown paths back into the app so `/wallet`, `/counter`, and `/kitchen/stock` still work. There is no build step.

## Going live

Do this once. After it, only menu or code changes need a Pages deploy, and only function changes need `supabase functions deploy`.

### 1. Create the project

1. Create a Supabase project.
2. In **Database → Extensions**, enable **pg_cron** and **pg_net** before the migration. The schedules are skipped with a notice if either extension is missing; enable them and run the migration again.
3. Install the [Supabase CLI](https://supabase.com/docs/guides/cli) and link the project:

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
```

### 2. Run the migration

One file creates the tables, the wallet trigger, RLS, report views, starter menu and recipes, the public `specials` storage bucket, and the cron jobs:

```bash
npx supabase db push
```

That applies [`supabase/migrations/20261022120000_init.sql`](supabase/migrations/20261022120000_init.sql). It does not insert sample orders. Demo data exists only in the browser.

### 3. Set function secrets

Hosted functions already receive `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. Set the rest with `npx supabase secrets set NAME=value`. Blank names in [`.env.example`](.env.example) are the full list. A missing provider key makes that send a no-op; the order, stock movement, or job log is still saved.

| Secret | Required | Purpose |
| --- | --- | --- |
| `STAFF_PIN` | Yes, for the live till | Manager PIN. Opens reports, stock, and settings. |
| `STAFF_TILL_PIN` | No | Optional till-only PIN. Cannot open reports, stock, or settings. |
| `CHEF_PIN` | Yes, for `/chef` | Web upload fallback. |
| `YOCO_SECRET_KEY` | No | Card checkouts and refunds. Used before PayFast. |
| `YOCO_WEBHOOK_SECRET` | No | If set, Yoco webhooks must send it in `x-yoco-signature` or `webhook-signature`. |
| `PAYFAST_MERCHANT_ID` | No | Used only when Yoco is unset. |
| `PAYFAST_MERCHANT_KEY` | No | PayFast. |
| `PAYFAST_PASSPHRASE` | No | PayFast signature. |
| `PAYFAST_SANDBOX` | No | `1` sends the form to the PayFast sandbox. |
| `WHATSAPP_TOKEN` | No | Meta WhatsApp Cloud API. Preferred over Twilio. |
| `WHATSAPP_PHONE_NUMBER_ID` | No | Meta sender. |
| `WHATSAPP_VERIFY_TOKEN` | No | Meta webhook verify token. |
| `KITCHEN_WHATSAPP` | No | E.164 kitchen number. Overrides the settings page when set. |
| `MANAGER_WHATSAPP` | No | End-of-day summary, low ratings. Overrides settings. |
| `CHEF_WHATSAPP_ALLOWLIST` | No | Comma-separated chef numbers. Inbound specials are ignored if this is empty. |
| `TWILIO_ACCOUNT_SID` | No | Fallback WhatsApp when Meta is unset. |
| `TWILIO_AUTH_TOKEN` | No | Twilio. |
| `TWILIO_WHATSAPP_FROM` | No | Twilio sender, e.g. `whatsapp:+14155238886`. |
| `RESEND_API_KEY` | No | Sign-in codes and the Monday CSV. No-op if unset. |
| `EMAIL_FROM` | No | From address Resend has verified. |
| `MANAGER_EMAIL` | No | Overrides the settings page. |
| `REPORTS_EMAIL` | No | Monday CSV. Falls back to `MANAGER_EMAIL`. |
| `CRON_SECRET` | Yes, for schedules | Shared with `private.runtime_config`. |
| `APP_BASE_URL` | No | Defaults to `https://thefood-court.co.za`. Card success URLs use it. |

```bash
npx supabase secrets set \
  STAFF_PIN='choose-a-pin' \
  CHEF_PIN='choose-a-chef-pin' \
  CRON_SECRET='choose-a-long-random-string'
```

Add payment, WhatsApp, and email secrets the same way when you have them.

### 4. Deploy the functions

`verify_jwt` is off on all four. The functions check the staff PIN, the chef PIN, the cron secret, or the webhook themselves. Students use a Supabase session after PIN or email-code sign-in.

```bash
npx supabase functions deploy api
npx supabase functions deploy automations
npx supabase functions deploy whatsapp-webhook
npx supabase functions deploy payments-webhook
```

### 5. Point cron at the functions

In the SQL editor, after the functions are deployed:

```sql
insert into private.runtime_config (key, value) values
  ('functions_base_url', 'https://YOUR_PROJECT_REF.supabase.co/functions/v1'),
  ('cron_secret', 'the same string as CRON_SECRET')
on conflict (key) do update set value = excluded.value;
```

Until both values are set, each job inserts an `automation_runs` row with status `skipped` and does not call the network.

Schedules are UTC (SAST is UTC+2, no daylight saving):

| Job | UTC cron | SAST |
| --- | --- | --- |
| `low-balance` | `*/15 * * * *` | every 15 minutes |
| `no-show` | `*/10 * * * *` | every 10 minutes |
| `chef-nudge` | `0 5 * * *` | 07:00 |
| `special-deadline` | `0 7 * * *` | 09:00 |
| `stock` | `*/30 * * * *` | every 30 minutes |
| `eod` | `45 15 * * *` | 17:45 |
| `weekly-csv` | `30 5 * * 1` | Monday 07:30 |
| `forecast` | `0 4 * * 1-6` | 06:00, Monday–Saturday |
| `reconcile` | `30 20 * * *` | 22:30 |

A manager can also run any job from `/kitchen/settings`.

### 6. Webhooks

Meta WhatsApp callback:

`https://YOUR_PROJECT_REF.supabase.co/functions/v1/whatsapp-webhook`

Use the same verify token as `WHATSAPP_VERIFY_TOKEN`. Subscribe to messages. Only numbers in `CHEF_WHATSAPP_ALLOWLIST` (or the settings-page list, when the env var is empty) can publish a special. The photo is stored in the public `specials` bucket.

Yoco and PayFast notify:

`https://YOUR_PROJECT_REF.supabase.co/functions/v1/payments-webhook`

A successful payment credits a pending top-up or marks the order paid. The same provider reference is applied once.

### 7. Point the static site at Supabase

In [`js/config.js`](js/config.js):

```js
export const SUPABASE_URL = 'https://YOUR_PROJECT_REF.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
```

Commit that and let Pages update. Do not put the service role key, staff PINs, or provider secrets in this file or in `index.html`.

### Row level security

Clients using the anon key cannot write orders, wallets, stock, or settings. Mutations go through the Edge Functions with the service role.

- Anonymous and signed-in users can read the menu and published specials.
- Anonymous and signed-in users can read `counter_now` (order number, name, pickup label, ready orders only — no phone).
- A signed-in student can read their own profile, ledger, orders, and ratings.
- Report views (`v_revenue_orders`, `v_revenue_by_method`, `v_item_units`, `v_sales_by_dow`, `v_sales_by_hour`, `v_wallet_liability`, `v_special_performance`, `v_refunds`) are service-role only.
- `wallet_ledger_apply` rejects a debit that would make `balance_cents` negative.
- Execute on the write RPCs is revoked from `anon` and `authenticated`.

Recognised revenue matches the reports page: wallet and card count when paid; cash counts when the order is collected or marked paid; cancelled, no-show, refunded, and written-off orders are excluded.

### Provider behaviour

- WhatsApp uses Meta (`WHATSAPP_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`) first, then Twilio, then skips.
- Email uses Resend (`RESEND_API_KEY` + `EMAIL_FROM`) or skips. The sign-in code is not returned in the API response.
- Cards use Yoco, then PayFast. With neither configured, checkout is recorded as paid and `demo: true`, and no HTTP call is made.
- Destination numbers and emails in the environment override the same fields saved on the settings page.
- Nightly reconciliation lists Yoco checkouts when that key is set. PayFast has no list API in this adapter, so that job is skipped until Yoco is the provider. Mismatches are inserted into `reconciliation_flags` and shown on `/kitchen/reports`.

## Brand

Navy `#0b1f3a` and gold `#e0b25a`, with the Food Court red mark. Pickup only — no delivery. Tap targets are at least 44px.
