---
id: billing
layer: domain
status: active
version: 4
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
| `liveRate` is `null` until F-092-c: a gateway prices from its `staticRate`, or refuses | F-0607's last rung |
| Out of the gateway's range is **400** `billing.amountOutOfRange`; no usable rate, rate out of range, a provider failure, no merchant id, no driver are all **503** `billing.gatewayUnavailable` — the cause goes to the log only | the user's move is the same: another gateway |
| A quote reserves and writes nothing | F-092-i reserves, on the request that pays |
| Per user, per 900s: the list `DEPOSIT_GATEWAYS_RATE_LIMIT` (default 120), a quote `DEPOSIT_QUOTE_RATE_LIMIT` (default 60); **429** past it (F-092-r) | a quote at an automatic-fee gateway is a call to the bank |

**Not covered:** `amount` is base currency; the display-currency step the
F-092-i row names arrives with F-025.
