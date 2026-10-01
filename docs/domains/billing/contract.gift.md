---
id: billing
layer: domain
status: active
version: 12
updated: 2026-09-28
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
| `POST /api/billing/gift/redeem` | `{code}` — 1..64 chars, trimmed | `{kind, code, credited, balance, currencyCode}` — `code` as stored, `credited` and `balance` decimal strings in `currencyCode`, the code's own, which the wallet's must match (F-116-h3) |

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
| The answer is `{kind: "free_grant", code, grant: {id, variantId, startsAt, endsAt, featureKeys}}` — **no token**: the link is `GET .../subscription-link`'s, as often as asked. A credit answers `{kind: "wallet_credit", code, credited, balance}` | the user's call, 2026-09-14; the token left the answer with F-114-e-c (ADR-0085) — one place hands out the link |
| A variant switched off after the coupon was made refuses the issue and rolls the use back (500) | an admin's broken coupon, never a user's mistake |
| A free-service code past the reseller's room on the platform's panels (F-019-o) rolls the use back: **409** `errors.billing.invoice.notAvailableNow`, `reason` `reseller_limit_reached`, no facts | a reseller could mint gift codes faster than any limit on sales; the user is told what a buyer is told |

## A Grant's subscription link, and resetting it (built — F-502-p, F-114-e-b, F-114-e-d)

`GrantTokenController` beside the box, over `SubscriptionLinkService`
(`subscription-link.service.ts`), which calls `GrantService.subscriptionTokenFor`
and `rotateToken` (`entitlement/contract.md`). Since ADR-0085 (D-43) the token is
kept sealed, so the link is answered as often as asked; "reset link" is for a
link that leaked, no longer how a lost key comes back.

| Route | Body | Answers `data` |
|---|---|---|
| `GET /api/billing/gift/grants/:id/subscription-link` | none | `{grantId, subscriptionUrl}` — `https://<subscription host>/sub/<token>` |
| `POST /api/billing/gift/grants/:id/rotate-token` ("reset link") | none | `{grantId, subscriptionUrl}` — the new link, never a bare key (F-114-e-c) |

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
| **The owner resets one Grant at most 3 times in any 24 hours** (F-114-e-d, `entitlement/link-reset.ts`): the fourth is **429**, `errors.billing.grant.linkResetLimited`, `reason: link_reset_limit`, `error.facts: {limit, nextAtMs}` — when the oldest of the three leaves the window, epoch ms. Counted from `grant_link_reset` under the Grant's row lock, after ownership, and written in the rotation's transaction; nothing rotates on a refusal. Staff and a reseller's admin (`reset`, not `resetOwn`) are not bounded and write no row | the bucket is per user and read as unlimited (480 a day, user 2026-09-30); every reset breaks the link in every app that holds it. Counted in the database, not Redis, so a stranger's request never spends a Grant's budget, and the answer can say when |
| Capability `subscriptionLink`, not `endUserDeposit` | neither moves money and both answer the `/sub` credential, so they are open exactly when `/sub` is: a suspended tenant's user until the grace ends, a terminated tenant's never |
| The Grant's **status is not a gate** | a link grants nothing on its own — `/sub` reads the Grant — so a dead Grant's link opens nothing rather than something it should not |

## A user's own Grants, listed (built — F-502-r)

`GrantListController` beside the other two, over `GrantService.listForUser`
(`entitlement/contract.md`). The reissue route above is reachable only from a
row, and until this list existed there was no row: a key lost after the modal
closed had no way back.

| Route | Query | Answers `data` |
|---|---|---|
| `GET /api/billing/gift/grants` | `page`, `pageSize` (≤ 100), `scope` (`current` default, `all`), `q` (≤ 100, trimmed; blank is none) | `{total, page, pageSize, hidden, rows[{id, label, status, startsAt, endsAt, featureKeys, variant{id, sku, nameKey} \| null, billingMode, consumedBytes, purchasedBytes, trafficUnlimited, trafficCapBytes, suspendedAt, purgeAt, lastTrafficAt}]}` |
| `PUT /api/billing/gift/grants/:grantId/label` | body: `{label: string \| null}` — trimmed, ≤ 40; empty or `null` is the catalog's name | `{grantId, label}` — the buyer's name for the service as saved, in one spelling (F-307-o); another user's or a missing Grant **404** `grant.notFound`; a longer one **400** `serviceLabelInvalid`. Bucket `CONFIG_ACTION`, as a config's name (F-307-x) |
| `POST /api/billing/gift/grants/by-lines` | body: `lines` (1–20, each trimmed, ≤ 4096), `page`, `pageSize`, `scope` as above | the same page, narrowed to the Grants holding a config any line is (F-307-p), or whose subscription link a line is (F-307-r) |

| Rule | Why |
|---|---|
| Whose Grants is the gate's `X-User-Id`. There is no id in the query, so there is nothing here to authorise | the same shape as the financial page (`contract.history.md`); a user id a client could send is another user's list |
| The columns are selected explicitly and **neither the subscription key nor its hash is among them** | the hash sits in the same row (D-35). A `select` is what keeps it, and whatever the schema grows next, out of a response nobody re-read |
| **`current` leaves out `cancelled` and `exhausted`** (`SETTLED_GRANT_STATUSES`) and answers `hidden`, how many; `all` lists every Grant and `hidden` is 0 (F-502-t, user 2026-09-26) | those two never serve again and nothing the user does brings them back; `suspended` (a top-up revives it) and `expired` stay. The filter is here, not in the reader, so a page of 20 is never short — and `hidden` keeps an ended Grant's link one request away |
| **`q` keeps the Grants named like it — the service's own `label` (F-307-x) — or holding a live config named like it**, case aside: its buyer's `label`, else the tenant's template over its panel's region (ADR-0089). `hidden` then counts the ended Grants that match (F-307-m) | the page is billing's (rule 1 of `contract.my-services.md`), so a filter in the reader would come back short. A default name is one per region, evaluated once per region and matched as a region list, so the page stays one query. The ` 2` numbering and a panel's own name (a template that evaluates empty) are not matched. A product's name is catalog text in the reader's language, not a column, so it is not searched here. **One spelling** (F-307-o, `traffic/config-text.ts`): a label is saved, and `q` and a default name matched, with ي/ى as ی, ك as ک and Persian/Arabic digits Latin — so either keyboard finds either; the label stays one indexed `contains` |
| **`by-lines` keeps the Grants holding a live config of the caller that a pasted line is**, name aside (`traffic/config-identity.ts`): the uuid a `vless`/`trojan`/`vmess` line carries is `config.uuid`, case aside, matched in the query; any other line is compared with the config's current captured lines, `#name` left out of both. `hidden` as for `q`; a paste naming no config is an empty page (F-307-p). A line that is a subscription link (`http(s)://<any host>/sub/<token>`, `entitlement/grant.ts` `subscriptionTokenOf`) keeps the caller's Grant whose `subscriptionTokenHash` is that token's hash (F-307-r) | the name changes under the buyer (label, template, ` 2`) and the client does not. **A body, never a query string**: a line is a credential, and a URL lands in access logs and history — so it is a POST that reads and answers 200. **Its own bucket, `GRANTS_BY_LINES`, default 60 per 900s, per user** (user 2026-09-26): a paste reads every live config of the user, so it is tuned apart from the list, and pasting never spends the page's budget. Lines captured from a client the config no longer is are dead links and match nothing, as `/sub` serves nothing from them; so does a subscription link from before a reset. Any host, because a reseller serves `/sub` on its own domain |
| `nameKey` is the variant's own wording, else its product's (§4.3), and a Grant issued without a catalog item answers `variant: null`. The key is answered, not the translated text | the same key the catalog answers (`catalog-reads.ts`), so the panel resolves both through `locale-service` and neither holds a language |
| Ordered `startsAt` desc, then `id` desc. Absent paging is page 1 of 20 | two Grants issued in one transaction share an instant, and an unstable order repeats or skips one across pages |
| No domain error: a user with no Grants is an empty page, not a **404**. Only a malformed query (**400**) and the limiter (**429**) fail | the page exists before the first Grant does |
| Its own bucket, `GRANT_LIST`, default **120** per 900s; the `subscriptionLink` capability, as above | it reads no secret and destroys nothing, so it is no security control — but sharing `GRANT_ROTATE_TOKEN`'s five calls would spend a user's recovery budget on looking at the list that offers the recovery |
| Bytes are decimal strings. `purgeAt` is `suspendedAt` + `coalesce(grant.purgeAfterDays, tenant.purgeAfterDays)` days, and `null` when the Grant is not suspended or the window is `0` (F-027-ac) | a Grant's bytes pass 2^53; and it is the SQL `entitlement/purge.ts` runs, so the panel's countdown is the instant the hourly job acts after. The tenant is read only when a suspended row has no window of its own |
| `trafficUnlimited` is the Grant's flag (F-111-s). `trafficCapBytes` is a capped prepaid Grant's `quotas.traffic_bytes.limit` plus its unexpired `traffic_bytes` adjustments, floored at 0, from one `groupBy` per page read only when a row has a cap; `null` for metered, unlimited or no quota (F-111-t) | the same sum `/sub` answers as `total` (sub-api `contract.md`), so the panel and the app never show two caps for one Grant |
| `lastTrafficAt` is the Grant's `usagePushedAt`, or `null` (F-307-u) | metering writes it only for a charged, non-zero delta, at most every 30 s, so it is when traffic last moved to within one push; it is the panel's "in use" on first paint (panel-web `contract.service-pulse.md`) |

**Not covered:** searching by product name, or any scope but these two; a pasted `/sub` link (a Grant's token, not a config line). Its consumer since
2026-09-20 is the panel's "my services" page (F-502-s,
`panel-web/contract.my-services.md`), which asks `current` and offers `all`
(F-502-u) and puts each Grant's link and its reset on the row.

## A Grant's configs, and what a user may do to them (built — F-027-ac)

`traffic/user-configs.controller.ts` over `UserConfigsService`, which calls
`ConfigActionsService` (network `contract.provisioning.md`) — every action is
still a desired-state write, and nothing here calls a panel.

| Route | In | Answers `data` |
|---|---|---|
| `GET /api/billing/traffic/grants/:grantId/configs` | the Grant id | `{grantId, rows[{id, protocol, status, region, allocatedCeilingBytes, appliedCeilingBytes, driftState, enforcementState, regenerateUsedCount, maxRegenerateCount, lastReconciledAt, label, lines[], linksCapturedAt, login, ovpnProfile}], regenerate}` — `regenerate` (F-118-r) is the Grant's locked `vpn.config.regenerate` terms `{unitSize, unitPrice, currencyCode, mode, includedQuantity, afterIncluded, used}` (`used` = the meter's `consumed`), or `null` when it was sold without one; the owner route of `contract.reseller-grants.md` does not answer it |
| `POST /api/billing/traffic/configs/actions` | `{action: regenerate, configIds[1..50]}` — `retire` is `400` like any unknown action (F-027-ac1) | `{action, results[{configId, ok: true} \| {configId, ok: false, reason}]}` — always **200** |
| `PUT /api/billing/traffic/configs/:configId/label` | `{label: string \| null}` — trimmed, ≤ 40; empty or `null` is the default | `{configId, label}` — the label as saved, in one spelling (F-307-o); another user's, retired or missing config **404** `configNotFound` (F-307-g) |

| Rule | Why |
|---|---|
| A user may **regenerate**, nothing else. Enable/disable stay an operator's switch; a move needs a panel list users do not have (user, 2026-09-23); **no retire** (F-027-ac1, user 2026-09-30) — a reseller's admin retires ([contract.reseller-grants.md](contract.reseller-grants.md)) | `ConfigActionsService.disable` already refuses a user; a move is its own row when a user-facing panel list exists |
| **A bulk action is one transaction per config**, in the order named, ids deduplicated; every config's outcome is answered (user, 2026-09-23) | one refused config — at its regenerate limit, retired meanwhile — must not stop the others, and the page must not have to guess which one it was. A second regenerate of one id would spend another of three |
| `reason` is `CONFIG_ACTION_REJECTIONS` (`config-actions.ts`, C-09) or `failed` for a throw that was not a refusal — logged, and still an outcome | the configs before it are committed and must be reported |
| Whose configs is the gate's `X-User-Id`. Another user's Grant is the same **404** as a missing one; another user's config is `config_not_found` | neither route is a way to ask whether an id exists |
| Retired configs are not listed, and the list **never answers the bare `uuid`** — columns are selected, and `uuid` is read only to judge the lines | retired is what an admin or a drain took away; the owner needs the lines, not the key inside them |
| `lines` are the config's captured link lines, answered to the owner only while `linksUuid` = `uuid` (F-307-a, user 2026-09-26); otherwise `[]` with `linksCapturedAt` `null`. `[]` with a time is a panel that gives none | they are the lines `/sub` already hands the same user (F-113), and `/sub`'s own rule (network `contract.links.md`): lines from the client before a regenerate are dead links until the next capture |
| **Lines are named as `/sub` names them** (F-307-g, ADR-0089): the buyer's `label`, else the reseller's `lineNameTemplate` (tenant `contract.branding.md` rule 7, read by the Grant's tenant; F-307-j), else the platform's `{region}`; a name given earlier in the Grant gets ` 2`, ` 3`. Numbered over this whole list, dead lines excluded; `traffic/line-names.ts`, held to `contracts/network/line-names.json`. A label is display only — no desired state, no panel call | a copied line and an imported `/sub` must show one name; the client's panel name is a matching key (F-027-aa) |
| `login` `{username, password}` only for a config on a **MikroTik User Manager** router, and only while `linksUuid` = `uuid` (the capture confirmed that login); `null` otherwise. `ovpnProfile` is the router's `.ovpn` (`network.panel.ovpnProfile`) for such a config whose protocol is `openvpn`, `null` when none was uploaded (F-307-d, user 2026-09-26) | the one exception to "never the `uuid`": User Manager names the user after it and makes it the password (network `contract.drivers.md`), and a PPP/OpenVPN login has no line to carry it. The file is the router's, the same for every buyer: server and CA, no key |
| Buckets `CONFIG_LIST` (**180**/900s) and `CONFIG_ACTION` (**30**/900s, per request, a label write included); capability `subscriptionLink` | looking must not spend the budget for acting; these are the configs `/sub` serves |

**Not covered:** a regenerate's new lines reach this answer only after the next
capture — the answer to the action itself carries none; move and provision from the panel are nobody's row.
Its consumer is `panel-web/contract.my-services.md`.

## A Grant's daily usage (built — F-307-b)

`GET /api/billing/traffic/grants/:grantId/usage`, on the same controller, over
`traffic/grant-usage.ts`. Answers `data` `{grantId, from, to, days[{date, uploadBytes, downloadBytes}]}`.

| Rule | Why |
|---|---|
| `traffic_daily_aggregate` is read **only by `configId`**, for the configs of a Grant whose `userId` is the gate's `X-User-Id`; another user's Grant is the same **404** as a missing one, and no aggregate is read for it | the table has no `tenantId` and no policy (network `data-model.md`): this check is the only fence |
| Every config of the Grant counts, **retired included** | their bytes were spent against this Grant; the chart must not shrink when a config is retired |
| Exactly 30 UTC days, today included, oldest first; a day with no row is `"0"`. Bytes are decimal strings | the chart never fills gaps; a day's sum can pass 2^53 |
| Today is what the last rollup saw, not the live counter | the rollup re-rolls today on every run (network `contract.rollup.md`) |
| Bucket `GRANT_USAGE` (**180**/900s, per user); capability `subscriptionLink` | read on every expand beside the config list; sharing `CONFIG_LIST` would halve it |

**Not covered:** per-config breakdown and a window other than 30 days are nobody's row. Its consumer is F-307-c.

## A metered Grant's billing period (built — F-118-ai)

`GET /api/billing/traffic/grants/:grantId/period`, on the same controller, over
`traffic/grant-period.ts`. Answers `data` `{grantId, current, previous, currencyCode, coversBytes}`,
each period `{from, to, consumedBytes, spent}`. User, 2026-09-30: the bag read as a limit and a lifetime total only grows.

| Rule | Why |
|---|---|
| The period is the Grant's month: from the latest anniversary of `startsAt` to the next, the day clamped (`periodBounds`, the monthly cap's clamp). `previous` is the one before; `null` in the first | one month per service, the one its bill turns on and a `monthly` spending cap's (F-118-ak) |
| Current `consumedBytes` = the live `grant.consumedBytes` less `traffic_daily_aggregate` before the period's UTC day; `previous` = the aggregate between its two turns. The turning day counts in the new period. Read through the owned Grant's configs, as the 30-day chart | the rollup runs nightly: a sum of the period's own days would miss today until tomorrow night |
| `spent` = this Grant's `traffic_consumption` + `usage_charge` debits less `traffic_refund` + `usage_refund` credits in the period, in the wallet's currency, never below 0; no wallet is `"0.00"` | the ledger is the only money truth (C-02); a prepaid block is counted when bought |
| `coversBytes` = the bag left + whole units at the meter's rate of `within(free balance + its prepaid reserve)`; the bag alone with no wallet; `null` when the rate's currency is not the wallet's. An estimate: siblings' shares (F-118-ag) and the wholesale leg are not taken off | "enough for about N GB" is what a pay-as-you-go user plans by |
| Another user's Grant **404** as missing; not metered, or unlimited, **409** `errors.billing.grant.notMetered`. Bucket `GRANT_USAGE`, `subscriptionLink` | read once per metered card; a package plan has no period of this kind |

**A reseller's admin on one of its users' services** (F-311: the reads, config
actions, freeze, days, traffic, reset) is [contract.reseller-grants.md](contract.reseller-grants.md).
