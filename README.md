# EASTC Food Court

One private food-court platform for EASTC. Students, educators, and other verified members order ahead. The same order is on the student phone, the kitchen screen, the till, and the WhatsApp outbox.

The live site [thefood-court.co.za](https://thefood-court.co.za/) is still the older static GitHub Pages app. **Do not merge this branch into `main` until a Node host is chosen.** This branch replaces `index.html` with the new app, which needs the server below. GitHub Pages cannot run it, and the campus domain must keep pointing at Pages until then.

## Run the test platform

Node 22 or newer.

```bash
npm install
npm test
npm start
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Phone-sized screens:

| Screen | URL |
| --- | --- |
| Members | `/` |
| POS | `/pos.html` |
| Kitchen | `/kitchen.html` |
| Demo logins | `/demo` |

`npm run test:e2e` runs the phone tests (Playwright, 390×844). Yoco stays in test mode. WhatsApp is the on-screen outbox until real tokens are set. Nothing in this demo charges a card or sends a message.

## Who can order

Ordering is closed to the public. A person needs a student number or a staff/educator number that is already on the EASTC registry (seeded, CSV import, or the CRM hook). One account per number. Parents do not order; they fund a linked student wallet.

## Demo logins

PIN is the last column. These are seeded test people, not the live campus register.

| Who | Sign in | PIN |
| --- | --- | --- |
| Thabo Mokoena, student, daily allowance on, parent-funded | `STU1001` | `1001` |
| Lerato Dlamini, student | `STU1002` | `1002` |
| Ayesha Khan, student | `STU1003` | `1003` |
| Johan Botha, on the registry, no account yet | `STU1004` | choose at signup |
| Naledi Khumalo, student | `STU1005` | `1005` |
| Thandi Nkosi, educator, 10% of R25,000 on payday 25, daily allowance R2,000 | `EDU2001` | `2001` |
| Mark Jacobs, educator, registry only | `EDU2002` | choose at signup |
| Kelebogile Mokoena, parent of STU1001 | `parent.stu1001` | `1010` |
| Billy, owner, all EASTC entities | `billy` | `0000` |
| Amahle, cashier, till-1 | `cashier1` | `1111` |
| Pieter, cashier, till-2 | `cashier2` | `2222` |
| Sipho, kitchen | `kitchen1` | `3333` |
| Nomsa, supervisor | `supervisor` | `4444` |
| Lindiwe, manager | `manager` | `5555` |
| Ravi, finance | `finance` | `6666` |

`STU9999` and `EDU9999` are not on the registry and cannot join.

## What the platform does

- Member PWA: menu, cart, checkout, wallet, collection code.
- Yoco test checkout. A verified webhook marks the order paid. A failed payment does not reach the kitchen.
- Pay cash at the counter: the order is unpaid until the till takes the cash on that same order. Cash is in the cash-up. Unpaid cash expires. The kitchen starts after cash unless a manager changes that setting.
- Kitchen screen: paid → preparing → ready → collected, with a rotating counter code.
- Collection once, only for that member's paid and ready order.
- EASTC Food Court POS (Powered by AI AutoTech). Yoco is only the card gateway. Walk-in cash, a Yoco test link, and a SoftPOS handoff. The browser does not read a bank card.
- Wallets for every verified member. Parents can still fund a student. Top up with Yoco test checkout or cash at the till. Optional daily allowance splits a monthly budget across the days of the month. Staff can record a payday amount or percent; that is a payroll instruction with consent and cancel, not a live payroll connection. Finance can apply the instruction in the demo so it posts to the wallet.
- Purchases, expenses (manager approval), stock, and a ledger P&L. Cashiers see their own till. Kitchen cannot refund. Manager and finance see the full figures.
- One sign-in for staff, with refresh sessions, remember-this-device, optional passkey, and owner entity switch. Other EASTC sites can use the OIDC-style issuer. See [docs/AUTH.md](docs/AUTH.md).
- The payments module is shared by Holdings, EASTC Technocentric Varsity, EASTECH Institute, EASTC Technical School, EASTC Foundation, and the Food Court. See [docs/PAYMENTS.md](docs/PAYMENTS.md).

## Placeholders Billy fills in the host environment

Do not commit real secrets. Test mode stays on until `YOCO_TEST_MODE=0` and `YOCO_SECRET_KEY` is a real key.

| Variable | Demo value |
| --- | --- |
| `YOCO_SECRET_KEY` | `sk_test_PLACEHOLDER` |
| `YOCO_PUBLIC_KEY` | `pk_test_PLACEHOLDER` |
| `YOCO_WEBHOOK_SECRET` | `whsec_PLACEHOLDER` |
| `YOCO_TEST_MODE` | on, unless set to `0` with a real secret |
| `WHATSAPP_PROVIDER` | `mock` |
| `WHATSAPP_CLOUD_TOKEN`, `WHATSAPP_CLOUD_PHONE_ID` | `PLACEHOLDER` |
| `BIRD_API_KEY`, `BIRD_CHANNEL_ID` | `PLACEHOLDER` |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` | `PLACEHOLDER` |
| `KITCHEN_WHATSAPP`, `TILL_WHATSAPP` | `PLACEHOLDER` |
| `QR_SECRET` | `PLACEHOLDER_QR_SECRET` |
| `YOCO_SOFTPOS_LINK_TEMPLATE` | `yoco://softpos?amount={amount}&reference={reference}` |
| `CRM_SYNC_URL` | `PLACEHOLDER` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | generated into the demo database when left as placeholders |
| `AUTH_COOKIE_DOMAIN`, `AUTH_ISSUER` | empty until a shared EASTC host exists |

Payroll is a placeholder adapter. It queues a deduction instruction. It does not call a payroll vendor.

## POPIA

Creating an account requires the on-screen notice. The demo stores the member number, name, phone, and orders in EASTC's own SQLite file so the kitchen can make the food and hand it to the right person. This seed data is not the live campus register.

## Legacy Pages app

`worker/` and `js/api/orderService.js` are the older pay-at-counter Worker. `npm test` still runs those tests. `npm run api:dev` still starts Wrangler for that Worker. The new platform does not use it.
