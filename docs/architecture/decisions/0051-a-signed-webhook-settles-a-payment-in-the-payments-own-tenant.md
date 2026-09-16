---
id: adr-0051
status: accepted
updated: 2026-09-16
---

# ADR 0051 — A signed webhook settles a payment in the payment's own tenant

- **Status:** accepted 2026-09-16 (row F-104-b)
- **Date:** 2026-09-16
- **Affects units:** billing

## Context

D-32 adds gateways (Stripe, NOWPayments, OxaPay, Airwallex) whose result does
not ride the payer's browser back. The provider's server posts it to ours, and
retries until it is answered. Until now `billing-service` had one public route,
the bank callback, whose tenant is the **Host** it arrived on (ADR-0020,
ADR-0025). A provider's server calls one URL per gateway and knows no panel
host, and a platform gateway serves the users of many tenants, so the Host is
not a claim this door can use.

## Decision (the user's calls, 2026-09-16, all as recommended)

1. **A second public door:** `POST /api/billing/deposit/webhook/:provider/:gatewayId`,
   routed without `my-auth`. `WebhookGatewayMiddleware` resolves the gateway
   row across tenants (`payment_gateway` or `tenant_gateway_config`, whichever
   holds the id, and its provider must be the path's) and opens the scope of the
   tenant that **owns** the gateway: for a platform gateway, the
   `platform_owner` tenant. That scope is where the signing secret lives and
   what the rate limiter counts under. An unknown gateway or a mismatched
   provider is a neutral **404**, as an unknown callback host is.
2. **Nothing changes before the signature is checked.** The driver's
   `verifyWebhook(rawBody, headers, secret)` checks it over the raw bytes
   (`NestFactory.create(..., { rawBody: true })`; JSON parsing still runs for
   every other route). A bad signature, or no secret configured, is **401** with
   nothing read beyond the gateway row.
3. **The tenant a payment settles in is the payment's.** The signed event names
   a tracking code. One read on the cross-tenant pool finds the row by
   `(gateway column, gatewayTrackingCode)`, unique per ADR-0028, and settlement
   runs inside `runWithTenant(payment.tenantId)` on the ordinary pool, through
   F-092-j's status-guarded `DepositSettlementService`. A granted gateway's
   payment therefore settles in the borrower, as F-096 needs.
4. **A signed event we cannot act on is 200 and a log line**: an unknown
   tracking code, an event type the driver ignores, a payment already settled.
   A non-2xx makes the provider retry for days. A lost event is F-092-l's sweep
   to find.
5. **A driver declares how it settles:** `return` (Zarinpal), `webhook`, or
   `in_chat` (F-104-k). A `webhook` driver's browser return never credits and
   never closes. It shows success when `inquire` says the money is there, and
   pending otherwise.
6. **The secret fails closed until F-104-c.** `WebhookSecretSource` answers
   `null` until F-104-c serves it from the vault, so the door refuses every
   call in the meantime rather than accepting one it cannot check.

## Consequences

- `CrossTenantPrismaService` has a second holder. `grep -rn CrossTenantPrismaService`
  is still the audit; both holders read only to find the tenant.
- Rate-limited per gateway id (`DEPOSIT_WEBHOOK`), the second public bucket
  whose subject is not a caller.
- Forecloses: settling a webhook in the Host's tenant, or in the tenant that
  owns the gateway rather than the one whose user paid.

## Alternatives considered

| Option | Why not |
|---|---|
| The tenant from the gateway's owner alone | a platform gateway serves many tenants' users, so those payments would never be found |
| A tenant id in the URL | a claim nothing proves. The payment row already says it |
| 4xx for an unknown event, so the provider retries | unrelated events (another product on the same Stripe account) would retry forever |
| Build F-104-c before this row | reorders the series, and a closed door is safe to ship |
