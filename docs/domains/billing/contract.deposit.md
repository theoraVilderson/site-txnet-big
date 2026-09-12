---
id: billing
layer: domain
status: active
version: 5
updated: 2026-09-12
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
| `GET /api/billing/deposit/gateways` | — | `[{id, source, displayName, providerName, category, minAmount, maxAmount}]` — platform gateways first, each table oldest first |
| `POST /api/billing/deposit/quote` | `{gatewayId, source?, amount, couponCodes?}` — `source` `tenant` (default) or `platform`, as the list answered it; `amount` a decimal string, ≤ 2 places, > 0; ≤ 10 codes of ≤ 64 chars | `{gatewayId, source, amount, coupons[{code, discount}], rejected[{code, reason, message}], discount, gap, fee, payable, credited, free, charge}` |

## Rules

| Rule | Why |
|---|---|
| Every number in a quote is `priceAtGateway`'s, and the panel does no arithmetic of its own | F-0612: legacy computed the price in `Deposit.tsx` and on the server, and the two drifted |
| Money is a base-currency decimal string (ADR-0019); `charge` is `{currency, decimals, amountMinor}` as the gateway will be asked, `amountMinor` a string, or `null` on the free path | JSON has no bigint and no exact decimal |
| A `tenant` gateway is the request tenant's own `tenant_gateway_config`, `isActive` **and** `verified`; a `platform` gateway is an active `payment_gateway`, offered **only** when the request tenant is `platform_owner`, which is offered both (D-25). Either needs a driver. Anything else — another tenant's, a reseller asking for a platform one, an id named with the wrong `source` — is **404** `billing.gatewayNotFound` | ADR-0006: no shared gateway for resellers (`deposit-gateways.int.spec.ts`) |
| Rows are read in a `tenantTransaction` with an explicit column list — never `merchantIdEncrypted` / `apiKeyEncrypted` / `payment_gateway.merchantId` | the strict RLS on `tenant_gateway_config` binds only there; `payment_gateway` has no policy, so the tenant type is the whole boundary; invariant 8 |
| Every gateway pays into its own account: its merchant id is the request tenant's vault `gateway_merchant_id` labelled `gateway:<source>:<gatewayId>` ("Payment providers" in `contract.md`) | D-26 |
| A gateway with no usable merchant id is **not listed** (`GatewayMerchant.configuredLabels`, one vault read, nothing decrypted), and a quote that would charge refuses it **503** — the manual-fee path asks `requireConfigured`, since it decrypts nothing of its own | F-092-u: offering it means the user picks it and the payment fails afterwards |
| A fully discounted top-up is quoted whatever the vault holds | nothing reaches the gateway on the free path |
| Coupons are validated in the same transaction as a wallet top-up. A rejected code is not an error: the quote goes on without it and `rejected[].message` is translated, one i18n key per `reason` | codes stack; a typo must not hide the rest of the breakdown |
| An automatic fee: the provider is asked for `feeQuoteAmountMinor`, its answer converted by `quotedFeeFromMinor` (rounded **up** to the cent). The vault and the provider are called after the transaction closes; the free path calls neither | no connection is held across a call to a bank |
| A `useLiveRate` gateway is priced at the rate the FX worker last published (`FxRateReader`, F-092-c); one that does not ask for a live rate is never read for, and prices from its `staticRate` | a quote is not the place to spend a Redis round trip proving a column's value |
| No readable rate is `liveRate: null` — the gateway's `staticRate`, or a refusal — and never an error of its own: Redis down, a value that no longer parses, no `currency` row and no snapshot ever written are all the same answer | a 500 on a quote where the user's move is the same as a 503's: another gateway |
| Out of the gateway's range is **400** `billing.amountOutOfRange`; no usable rate, rate out of range, a provider failure, no merchant id, no driver are all **503** `billing.gatewayUnavailable` — the cause goes to the log only | the user's move is the same: another gateway |
| A quote reserves and writes nothing | F-092-i reserves, on the request that pays |
| Per user, per 900s: the list `DEPOSIT_GATEWAYS_RATE_LIMIT` (default 120), a quote `DEPOSIT_QUOTE_RATE_LIMIT` (default 60); **429** past it (F-092-r) | a quote at an automatic-fee gateway is a call to the bank |

## The live rate (built — F-092-c)

`FxRateReader` in `billing-service/src/app/payment/pricing/`. The read side of
`currency`'s FX loop, and the last piece ADR-0019 wants before a rial gateway
can quote: the worker has published since F-0606-a and `priceAtGateway` has
recorded which snapshot priced a payment since F-0606-b, and what sat between
them was nobody reading the key.

| Rule | Why |
|---|---|
| Cache first, table second, and both: `fx:rate:{FX_QUOTE_CURRENCY_CODE}` (`UnscopedRedisKeys.fxRate`, C-03), then the newest `effectiveAt` for that code | the key is a cache of a `currency_exchange_rate` row, so a miss is a question for the table and never an answer (`currency/contract.fx-worker.md`) |
| An unreadable or unparseable cache value is a **miss**, logged, not an answer | otherwise a Redis outage silently drops every live-rate gateway to its `staticRate`, at whatever price that column happens to name |
| A rate with no snapshot id, or one that is not positive, is refused from either store — both halves or neither | ADR-0019's forbidden state, and `priceAtGateway` treats a snapshotless rate as a caller bug (`InvalidPricingInput`), which is a 500 |
| No tenant is bound for the table read, and none is needed | `currency_exchange_rate` has no `tenantId` and so no RLS policy: the rate is the platform's, and every tenant prices from the same one |
| It does not judge the rate's **age** | the staleness ladder is F-0607-a's, and reads the `effectiveAt` this leaves on the snapshot |

**Not covered:** `amount` is base currency; the display-currency step the
F-092-i row names arrives with F-025. The rate's age is unjudged until
F-0607-a, so a rate the ladder would call *degraded* is quoted as a normal one.
