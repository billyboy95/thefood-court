# EASTC payments module

The food court is the first consumer. The same HTTP API can take a fee, a donation, or a wallet top-up for another EASTC entity. Money is a double-entry ledger in EASTC's own database. Every journal balances or it is rejected.

## Entities

| Id | Name |
| --- | --- |
| `holdings` | Holdings |
| `eastc-varsity` | EASTC Technocentric Varsity |
| `eastech-institute` | EASTECH Institute |
| `eastc-tech-school` | EASTC Technical School |
| `eastc-foundation` | EASTC Foundation |
| `food-court` | Food Court |

`GET /api/payments/v1/entities` lists them. A session can create a payment only for its active entity. The owner can switch entity with `POST /api/auth/entity` and then pay as that entity.

## Create a payment

`POST /api/payments/v1/intents`

```json
{
  "entity": "eastc-foundation",
  "purpose": "donation",
  "method": "yoco_card",
  "amountCents": 5000
}
```

Roles that can create one: cashier, supervisor, manager, finance, owner.

While Yoco is in test mode the response includes `checkoutUrl` on `/pay/test/:id`. That page signs a Standard Webhooks payload (`webhook-id`, `webhook-timestamp`, `webhook-signature`) with `YOCO_WEBHOOK_SECRET`. The server accepts the payment only when the signature and the amount match. The same check is on `POST /api/yoco/webhook` for a real Yoco call.

Food-court checkout uses this intent under the order. A wallet top-up uses it too. Failed payments do not post income.

## Ledger accounts

| Account | Meaning |
| --- | --- |
| `liability:wallet:{memberNumber}` | Member food wallet. Balance is credits minus debits. |
| `income:food:yoco` / `cash` / `wallet` / `softpos` | Food sales by method |
| `income:{purpose}` | Fees and donations for other entities |
| `asset:yoco_clearing` | Card money not yet in the bank |
| `asset:cash:{tillId}` | Cash in a till, including cash wallet top-ups |
| `asset:payroll_clearing` | Salary allocation waiting on payroll |
| `asset:inventory` | Stock received |
| `expense:cogs` | Cost of the food sold |
| `expense:operating:{category}` | Approved expenses |
| `liability:accounts_payable` | Supplier bills |

Wallet refunds credit the wallet. Card and cash refunds reverse the original income.

## Wallets

Any verified member can open a personal food wallet. Parents can still pay into a linked student wallet.

| Action | Method |
| --- | --- |
| Open or read | `GET /api/wallet` and `POST /api/payments/v1/wallets` |
| Yoco top-up | `POST /api/wallet/topup` |
| Cash at the till | `POST /api/pos/wallet-topup` |
| Daily allowance | `POST /api/wallet/daily-allowance` |
| Parent limits | `POST /api/wallet/limits` |
| History | included on `GET /api/wallet` |
| Tap token | `POST /api/wallet/tap-token` then `POST /api/pos/wallet-tap` |

The daily allowance, when turned on, caps a day at the monthly budget divided by the number of days in that month (rounded down to cents). The wallet screen shows what is left today. A monthly parent allowance and a daily or monthly spend limit can sit on top of that.

The tap token is a short-lived signed code (`fwt1`). The till can scan it as a QR or, on Android Chrome, read it with Web NFC. It charges the wallet once. It is not a bank card.

## Salary allocation

A staff member or educator chooses an amount in cents or a percent of their declared salary, picks a payday (1–28), and ticks consent. `POST /api/wallet/salary-allocation` stores that. `POST /api/wallet/salary-allocation/cancel` stops it.

On the payday, a placeholder adapter queues a payroll instruction. It does not call a payroll company. Finance, a manager, or the owner posts it with `POST /api/payroll/instructions/:id/apply`, which debits `asset:payroll_clearing` and credits the wallet.

## Card tap

A browser cannot read a contactless bank card. The POS method builds a Yoco SoftPOS deep link from `YOCO_SOFTPOS_LINK_TEMPLATE` and shows that the handoff is outside the browser. Staff record the Yoco reference with `POST /api/payments/v1/intents/:id/softpos-reference`. `GET /api/payments/v1/reconciliation` lists what is still open.

## Reports

`GET /api/reports/sales?range=day|week|month` splits Yoco, cash, wallet, and SoftPOS. Cashiers are limited to their own till. `GET /api/reports/sales.csv` is the same rows as CSV. `GET /api/reports/pnl` is sales minus cost of goods minus approved expenses, for manager, finance, and owner.
