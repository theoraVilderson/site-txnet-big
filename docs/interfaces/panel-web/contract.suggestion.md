---
id: panel-web
layer: interface
status: active
version: 42
updated: 2026-10-02
---

# panel-web — the AI suggestion card on My services (F-038-h)

`services/_components/SuggestionCard.tsx`, at the top of `/services`, over
`lib/ai-api.ts` — ai-service's own routes on `/api/ai`, behind `my-auth`
([ai/contract.my-suggestion.md](../../domains/ai/contract.my-suggestion.md);
user, 2026-10-02: the card reads ai, not the inbox). ADR-0109 point 11. Its
own file: [contract.my-services.md](contract.my-services.md) is at its ceiling.

## Rules

1. **One card, labelled, with one call to action** (F-1507, F-1509). The
   label is `common.myServices.suggestion.label`; the call is a link to
   `panelShopVariantPath(variantId)` — the shop opened on that plan's
   checkout ([contract.shop.md](contract.shop.md) rule 12). Close (×) and
   "don't show this again" are controls, not calls to action. Its copy, in
   every language, passes shared-core `suggestionCopyVerdict`
   (`suggestion-copy.spec.ts` reads `common.json` too).
2. **The plan and its price are the shop's, read now** (`billingApi.shopOffers`),
   never the engine's: a plan the shop no longer offers shows no card, as the
   bot tells none (`plan_unavailable`). Names are the page's catalog texts
   (`useGrantsPage`'s `texts`), the sku when a name is missing.
3. **Words per type from an exhaustive `Record<SuggestionCardType, …>`**:
   `renew` names the plan and the days to its deadline (rounded up, at least
   1); `resize_up` / `resize_down` name the plan the service is on (`from`)
   and the one suggested. A type ai answers that is not in the record shows
   no card.
4. **Nothing shows unless everything was read.** A failed read of ai or the
   shop renders nothing — a pitch is never worth an error line, unlike the
   bell's rule 6 ([contract.notifications.md](contract.notifications.md)),
   whose rows are the user's mail.
5. **Close dismisses this suggestion; "don't show this again" opts out of its
   type** (F-1505). Either removes the card once the server answered; a
   refusal keeps it with one line (`suggestion.failed`). Neither names a
   user: the server takes the gate's.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| ai | `GET /api/ai/me/suggestion`, `POST …/:actionId/dismiss`, `POST …/:actionId/opt-out` | no card; the rest of `/services` works |
| billing | `GET /api/billing/offers` | no card |

## Proof

`services/suggestion-card.test.tsx`: one link and its path, today's price,
the days, no card on each of the four failures, close and opt-out, a refused
close; and `NOTICE_KINDS` equal to shared-core's `RETENTION_MUTABLE_KINDS`.
