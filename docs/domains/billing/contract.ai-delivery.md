---
id: billing
layer: domain
status: active
version: 2
updated: 2026-10-02
---

# Contract — billing / what an AI suggestion's delivery asks

A topic file of `contract.md` (§10). worker-service's `ai_suggestion_delivery`
(automation `contract.worker.md`) asks billing three things before it tells a
suggestion, each on the internal seam (`ServiceOnlyGuard`, else 404; not
rate-limited — the worker's five-minute tick). The engine reads billing only
through its reader role and never writes here (ai invariant 7): what a
suggestion names, prices or gives is billing's answer at delivery, never the
engine's guess. The order of the steps is notification `contract.retention.md`
"An AI suggestion".

| Ask | Route | Owned by |
|---|---|---|
| a service's names and a plan's offer now (F-038-g3) | `POST /api/internal/billing/entitlement/grants/names` | `entitlement/grant-names.ts` |
| an offer's personal coupon (F-038-f3) | `POST /api/internal/billing/coupons/ai-offer` | [contract.coupon.md](contract.coupon.md) "An AI offer's personal coupon" |
| another gateway for an unfinished payment (F-038-m) | `POST /api/internal/billing/deposit/other-gateway` | below |

## Another gateway (built — F-038-m)

`payment/deposit/other-gateway.ts` (`OtherGatewayService`), on
`DepositInternalController`. Proved by `deposit-quote.service.spec.ts`
"OtherGatewayService". Body `{ tenantId, userId, paymentId }`, strict.
Answers, in the usual envelope: `{ paid: true }`, `{ gateway: { displayName,
category } }`, or `{ gateway: null }`. The caller stops the suggestion on the
first and the last (`already_paid`, `no_other_gateway`).

| Rule | Why |
|---|---|
| The payment is read as the user's own, in its tenant; another user's id answers `{ gateway: null }` | a suggestion names only its subject's payment; a miss is not a reason to say anything |
| A `success` payment of the user started after it answers `paid` | the help is no longer owed; a payment's only time is its `createdAt` (payments run one at a time) |
| The list is the user's own top-up list, `listGateways()` — active, verified, in the tenant's currency, secrets set, a known provider; with no chat platform, so an in-chat gateway is left out | the message is read in the inbox too; one list, one rule — never a second copy of which gateway a user may use |
| Minus the gateway that failed (`gatewayId` or `tenantGatewayConfigId`), a `testing` one, and one whose `minAmount` / `maxAmount` refuse the amount tried — compared only when the gateway's currency is the payment's | naming the same gateway, or one that refuses the amount, is not help |
| The first left, in the list's order (the platform's, the tenant's own, then granted ones; each oldest first) | the tenant's configured order is its preference |
