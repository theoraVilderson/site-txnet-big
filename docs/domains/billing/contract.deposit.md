---
id: billing
layer: domain
status: active
version: 3
updated: 2026-09-11
---

# Contract — billing / deposit quote

A topic file of `contract.md` (§10): the top-up page's read side, the first
billing routes. Its consumer is the panel (F-093-e), which none of the other
sections has. F-092-i, starting a payment, belongs beside it.

## Routes (built — F-092-o)

`DepositController` + `DepositQuoteService` in `billing-service/src/app/payment/deposit/`.
Both routes sit behind the gate like every billing route ("Request edge" in
`contract.md`): the user and the tenant come from its headers, never from the body.

| Route | Body | Answers `data` |
|---|---|---|
| `GET /api/billing/deposit/gateways` | — | `[{id, displayName, providerName, category, minAmount, maxAmount}]`, oldest first |
| `POST /api/billing/deposit/quote` | `{gatewayId, amount, couponCodes?}` — `amount` a decimal string, ≤ 2 places, > 0; ≤ 10 codes of ≤ 64 chars | `{gatewayId, amount, coupons[{code, discount}], rejected[{code, reason, message}], discount, gap, fee, payable, credited, free, charge}` |

## Rules

| Rule | Why |
|---|---|
| Every number in a quote is `priceAtGateway`'s, and the panel does no arithmetic of its own | F-0612: legacy computed the price in `Deposit.tsx` and on the server, and the two drifted |
| Money is a base-currency decimal string (ADR-0019); `charge` is `{currency, decimals, amountMinor}` as the gateway will be asked, `amountMinor` a string, or `null` on the free path | JSON has no bigint and no exact decimal |
| A selectable gateway is the request tenant's own `tenant_gateway_config`, `isActive` **and** `verified`, whose provider has a driver. Anything else, another tenant's included, is **404** `billing.gatewayNotFound` | ADR-0006; a gateway awaiting its test transaction takes no money (`deposit-gateways.int.spec.ts`) |
| The row is read in a `tenantTransaction` with an explicit column list — never `merchantIdEncrypted` / `apiKeyEncrypted` | its strict RLS binds only there; invariant 8 |
| The platform brand's `payment_gateway` is **not** offered | its merchant id is not in the vault ("Payment providers" in `contract.md`) |
| Coupons are validated in the same transaction as a wallet top-up. A rejected code is not an error: the quote goes on without it and `rejected[].message` is translated, one i18n key per `reason` | codes stack; a typo must not hide the rest of the breakdown |
| An automatic fee: the provider is asked for `feeQuoteAmountMinor`, its answer converted by `quotedFeeFromMinor` (rounded **up** to the cent). The vault and the provider are called after the transaction closes; the free path calls neither | no connection is held across a call to a bank |
| `liveRate` is `null` until F-092-c: a gateway prices from its `staticRate`, or refuses | F-0607's last rung |
| Out of the gateway's range is **400** `billing.amountOutOfRange`; no usable rate, rate out of range, a provider failure, no merchant id, no driver are all **503** `billing.gatewayUnavailable` — the cause goes to the log only | the user's move is the same: another gateway |
| A quote reserves and writes nothing | F-092-i reserves, on the request that pays |

**Not covered:** no rate limit — `billing-service` has no Redis, and a quote at
an automatic-fee gateway is one provider call. `amount` is base currency; the
display-currency step the F-092-i row names arrives with F-025.
