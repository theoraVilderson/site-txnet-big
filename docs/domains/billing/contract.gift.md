---
id: billing
layer: domain
status: active
version: 7
updated: 2026-09-25
---

# Contract — billing / gift code

A topic file of `contract.md` (§10): the one route that reads a coupon and
moves money in the same breath. Its consumer is the panel's gift modal
(F-093-g). The discount engine's two sections in `contract.md` are its mirror,
not its caller — neither calls the other.

## Route (built — F-092-m)

`GiftController` + `GiftRedemptionService` in `billing-service/src/app/payment/gift/`,
over `billing.redeem_gift_coupon` (migration `20260912000000_gift_code_redemption`).
Behind the gate like every billing route ("Request edge" in `contract.md`): the
user and the tenant come from its headers, never from the body.

| Route | Body | Answers `data` |
|---|---|---|
| `POST /api/billing/gift/redeem` | `{code}` — 1..64 chars, trimmed | `{code, credited, balance}` — `code` as stored, `credited` and `balance` base-currency decimal strings |

## Rules

| Rule | Why |
|---|---|
| A gift code **is** a coupon: `discountType = wallet_credit`, credited at its `discountValue`. There is no gift table | D-21 |
| The redemption row and the wallet credit are one Postgres transaction. The row is written `confirmed` at once — a gift holds nothing, because it waits for no payment | invariants 1-3, 11; legacy credited with a computed `$inc` after four separate steps |
| The credit goes through `WalletLedgerService.credit` with `reasonType = coupon_redemption` and `referenceId` = the **`coupon_redemption` row's id**, never the coupon's | a coupon may be redeemed again; a redemption row never is (invariant 11) |
| The code is trimmed, upper-cased and matched as the top-up box matches its codes (`normalizeCouponCodes`) | one code must not be two codes depending on which box it was typed into |
| Gates, under a `FOR UPDATE` on the coupon row and in this order: inactive / unknown / soft-deleted / another tenant's / a platform coupon not serving this tenant / targeted at someone else -> `not_found`; a discount coupon -> `not_a_gift_code`; `expiresAt` -> `expired`; `perUserUsageLimit` (`0` = unlimited) counted over live redemptions -> `per_user_limit_reached`; `usedCount + reservedCount` vs `totalUsageLimit` -> `capacity_reached` | the lock, and its order, are `reserve_coupon`'s — the last slot cannot be decided by a count read a moment ago (ADR-0040) |
| A refusal is **409**, one `i18nKey` per reason under `errors.billing.gift.*`, plus the machine-readable `reason`. It writes nothing | the request was well-formed; the code simply is not redeemable |
| A discount coupon typed here answers `not_a_gift_code`, and a gift code typed into the top-up box answers `not_a_discount` | each box names the other, so the panel can say where the code belongs |
| A coupon whose `discountValue` is not `> 0` in cents **raises**, and reaches the client as a 500 | an admin's broken row, never a user's mistake — telling the user their code is invalid would hide it |
| Per user, per 900s: `GIFT_REDEEM_RATE_LIMIT`, default **10**; **429** past it | a gift code is a bearer secret worth money and this route is the only thing that says whether one exists — an unlimited version is a code-guessing oracle |

## Free-service codes (built — F-502-l-b, D-35)

Migration `20260915000200_gift_redeems_free_grant`; `GiftRedemptionService` with
`GrantService` (ADR-0049). Proved by `gift-redemption.int.spec.ts`.

| Rule | Why |
|---|---|
| A `free_grant` code is redeemed in the same box, under the same gates and row lock; the redemption is `confirmed` at 0 and `usedCount` moves | D-35: one box for every code that is not a discount |
| The function answers the coupon's `grantVariantId`; the service issues the Grant in the same transaction — `source = coupon`, `sourceReferenceId` = the redemption row — so a use and its Grant commit together | one cause, one Grant (entitlement invariant 7) |
| No wallet is opened or credited | a free service gives no money |
| The answer is `{kind: "free_grant", code, grant: {id, variantId, startsAt, endsAt, featureKeys}, subscriptionKey}`; the key is shown this once and only its hash is stored. A credit answers `{kind: "wallet_credit", code, credited, balance}` | the user's call, 2026-09-14 |
| A variant switched off after the coupon was made refuses the issue and rolls the use back (500) | an admin's broken coupon, never a user's mistake |

## A Grant's subscription link, and resetting it (built — F-502-p, F-114-e-b)

`GrantTokenController` beside the box, over `SubscriptionLinkService`
(`subscription-link.service.ts`), which calls `GrantService.subscriptionTokenFor`
and `rotateToken` (`entitlement/contract.md`). Since ADR-0085 (D-43) the token is
kept sealed, so the link is answered as often as asked; "reset link" is for a
link that leaked, no longer how a lost key comes back.

| Route | Body | Answers `data` |
|---|---|---|
| `GET /api/billing/gift/grants/:id/subscription-link` | none | `{grantId, subscriptionUrl}` — `https://<subscription host>/sub/<token>` |
| `POST /api/billing/gift/grants/:id/rotate-token` ("reset link") | none | `{grantId, subscriptionUrl, subscriptionKey}` — the new link; `subscriptionKey` is its last segment, kept only until the panel stops showing a key (F-114-e-c) |

| Rule | Why |
|---|---|
| The owner is the gate's user. There is no body, so there is no field that could name another one | the only thing these routes protect |
| Another user's Grant, and one that does not exist, are one answer: **404**, `errors.billing.grant.notFound`, `reason: grant_not_found` — decided before any domain is read | told apart, or answered with a domain refusal, the route says whether a Grant id exists |
| The host is one of the tenant's `purpose = subscription` domains that `/sub` routes (a `subdomain`, or a `verified` custom domain — `sub-api/contract.md` "Who is answered"): a custom domain first, then a subdomain, each alphabetically, never a CNAME target (`subscriptionHostOf`). A reseller's platform subdomain **is** an answer | a link on any other host is a 404 to the user's app, which may drop it; one host, so two answers never name two links. ADR-0063's closed door is the panel's, not `/sub`'s |
| No such domain: **409**, `errors.billing.grant.noSubscriptionDomain`, `reason: no_subscription_domain` | the tenant's setup, not the user's mistake — the panel says to contact support |
| No sealed token (a Grant from before F-114-e-a, or issued with no KEK): **409**, `errors.billing.grant.linkNotKept`, `reason: link_not_kept`. When both apply, the domain is named | the panel offers "reset link", which keeps one from then on (ADR-0085 point 4) |
| A reset finds the host **before** it rotates, in the rotation's transaction; with none it refuses and the old link keeps working | rotating first would destroy a working link and answer nothing |
| The rotation is one transaction and the old token stops working in it | there is no window in which both links open, and none in which neither does |
| Buckets: `SUBSCRIPTION_LINK`, default **60** per 900s, for reading; `GRANT_ROTATE_TOKEN`, default **5**, for a reset; **429** past either | each reset destroys a working link, so it stays a security limit; copying the link must never spend the budget for revoking a leaked one |
| Capability `subscriptionLink`, not `endUserDeposit` | neither moves money and both answer the `/sub` credential, so they are open exactly when `/sub` is: a suspended tenant's user until the grace ends, a terminated tenant's never |
| The Grant's **status is not a gate** | a link grants nothing on its own — `/sub` reads the Grant — so a dead Grant's link opens nothing rather than something it should not |

## A user's own Grants, listed (built — F-502-r)

`GrantListController` beside the other two, over `GrantService.listForUser`
(`entitlement/contract.md`). The reissue route above is reachable only from a
row, and until this list existed there was no row: a key lost after the modal
closed had no way back.

| Route | Query | Answers `data` |
|---|---|---|
| `GET /api/billing/gift/grants` | `page`, `pageSize` (≤ 100) | `{total, page, pageSize, rows[{id, status, startsAt, endsAt, featureKeys, variant{id, sku, nameKey} \| null, billingMode, consumedBytes, purchasedBytes, suspendedAt, purgeAt}]}` |

| Rule | Why |
|---|---|
| Whose Grants is the gate's `X-User-Id`. There is no id in the query, so there is nothing here to authorise | the same shape as the financial page (`contract.history.md`); a user id a client could send is another user's list |
| The columns are selected explicitly and **neither the subscription key nor its hash is among them** | the hash sits in the same row (D-35). A `select` is what keeps it, and whatever the schema grows next, out of a response nobody re-read |
| **Every Grant, whatever its status** — the status is answered, never a filter | a key is lost from an expired Grant as easily as a live one, and hiding it would hide exactly the row the user came for. What to do with a dead one is the panel's (F-502-s) |
| `nameKey` is the variant's own wording, else its product's (§4.3), and a Grant issued without a catalog item answers `variant: null`. The key is answered, not the translated text | the same key the catalog answers (`catalog-reads.ts`), so the panel resolves both through `locale-service` and neither holds a language |
| Ordered `startsAt` desc, then `id` desc. Absent paging is page 1 of 20 | two Grants issued in one transaction share an instant, and an unstable order repeats or skips one across pages |
| No domain error: a user with no Grants is an empty page, not a **404**. Only a malformed query (**400**) and the limiter (**429**) fail | the page exists before the first Grant does |
| Its own bucket, `GRANT_LIST`, default **120** per 900s; the `subscriptionLink` capability, as above | it reads no secret and destroys nothing, so it is no security control — but sharing `GRANT_ROTATE_TOKEN`'s five calls would spend a user's recovery budget on looking at the list that offers the recovery |
| Bytes are decimal strings. `purgeAt` is `suspendedAt` + `coalesce(grant.purgeAfterDays, tenant.purgeAfterDays)` days, and `null` when the Grant is not suspended or the window is `0` (F-027-ac) | a Grant's bytes pass 2^53; and it is the SQL `entitlement/purge.ts` runs, so the panel's countdown is the instant the hourly job acts after. The tenant is read only when a suspended row has no window of its own |

**Not covered:** the panel's copy-link, QR and reset button (F-114-e-c); the
reissue button of F-502-q is what F-114-e-c replaces. Its consumer since
2026-09-20 is the panel's "my services" page (F-502-s,
`panel-web/contract.my-services.md`), which lists every status this answers and
puts the reissue button on each row. Filtering or searching the list is nobody's
row yet: paging is the only knob.

## A Grant's configs, and what a user may do to them (built — F-027-ac)

`traffic/user-configs.controller.ts` over `UserConfigsService`, which calls
`ConfigActionsService` (network `contract.provisioning.md`) — every action is
still a desired-state write, and nothing here calls a panel.

| Route | In | Answers `data` |
|---|---|---|
| `GET /api/billing/traffic/grants/:grantId/configs` | the Grant id | `{grantId, rows[{id, protocol, status, region, allocatedCeilingBytes, appliedCeilingBytes, driftState, enforcementState, regenerateUsedCount, maxRegenerateCount, lastReconciledAt}]}` |
| `POST /api/billing/traffic/configs/actions` | `{action: regenerate \| retire, configIds[1..50]}` | `{action, results[{configId, ok: true} \| {configId, ok: false, reason}]}` — always **200** |

| Rule | Why |
|---|---|
| A user may **regenerate** and **retire**, nothing else (user, 2026-09-23). Enable/disable stay an operator's switch; a move needs a panel list users do not have | `ConfigActionsService.disable` already refuses a user; a move is its own row when a user-facing panel list exists |
| **A bulk action is one transaction per config**, in the order named, ids deduplicated; every config's outcome is answered (user, 2026-09-23) | one refused config — at its regenerate limit, retired meanwhile — must not stop the others, and the page must not have to guess which one it was. A second regenerate of one id would spend another of three |
| `reason` is `CONFIG_ACTION_REJECTIONS` (`config-actions.ts`, C-09) or `failed` for a throw that was not a refusal — logged, and still an outcome | the configs before it are committed and must be reported |
| Whose configs is the gate's `X-User-Id`. Another user's Grant is the same **404** as a missing one; another user's config is `config_not_found` | neither route is a way to ask whether an id exists |
| Retired configs are not listed, and the list **never answers `uuid`** — columns are selected | retired is what the user deleted; the `uuid` is the credential, `/sub`'s to hand out (F-113) |
| Buckets `CONFIG_LIST` (**180**/900s) and `CONFIG_ACTION` (**30**/900s, per request); capability `subscriptionLink` | looking must not spend the budget for acting; these are the configs `/sub` serves |

**Not covered:** the new credential a regenerate mints is delivered by `/sub`
(F-113), not by this answer; move and provision from the panel are nobody's row.
Its consumer is `panel-web/contract.my-services.md`.
