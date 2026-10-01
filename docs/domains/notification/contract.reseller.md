---
id: notification
layer: domain
status: active
version: 7
updated: 2026-09-20
---

# Contract — notification / a reseller's own campaigns

A topic file of [contract.md](contract.md), opened because that file is at its
250-line cap. The reseller-named campaign surface (F-313-d, spec F-313):
`/api/notifications/tenants/:tenantId/campaigns…`, where a reseller drafts,
sizes and starts a broadcast to **its own** users.

It is the data half of the bot's bulk-send flow (F-313-b) and of a reseller
panel page after it, built once for both — the shape F-066-w3 and F-066-w4
established, and the one F-311 was split into.

Code: `notification-service/src/app/campaigns/reseller-campaign.{controller,service,schema}.ts`;
tests `reseller-campaign.spec.ts`.

## Why it is a second door and not a wider first one

`/api/notifications/campaigns` (F-035-c) scopes a campaign to the **caller's**
tenant, with any other tenant the platform owner's alone. A reseller's owner
signs in to the platform owner's tenant (ADR-0059 (6), F-061-i), so their
session never names the reseller whose campaign this is:

| through the admin door | what happens | why it is wrong |
|---|---|---|
| `tenantId` = the reseller's | `403 not_platform_owner` | the owner is not platform staff and never will be |
| `tenantId` absent | a campaign for the **platform owner's** tenant | its audience is every tenant's users, sent under a reseller's name |

Widening that rule would mean teaching `campaign-admin.service.ts` a second
notion of who a caller is. `ResellerAccess` (F-066-w1, tenant invariant 21) is
that notion, already written and already the door on every other
reseller-named surface — F-311-a (its users), F-311-b (its revenue), F-311-e
(whether a chat may see any of it). This file is that door on campaigns.

## Provides

All under `/api/notifications/tenants/:tenantId/campaigns`. Envelope, errors
and 429 as every service (F-094). `:tenantId` is the reseller, always.

| Operation | Route | Input | Output | Capability |
|---|---|---|---|---|
| list its campaigns | `GET` | `page`, `pageSize` ≤100, `status?` | `{ items[], page, pageSize, total }`, newest first | `read` |
| size a segment | `POST audience/count` | `{ audience }` | `{ count }`, 200 | `read` |
| draft one | `POST` | `{ channel, messageBody, subject?, sourceLang?, audience }` | the campaign, 201 | `staffWrite` |
| read one | `GET :id` | — | the campaign | `read` |
| start the send | `POST :id/send` | — | the campaign, `status: sending`, 200 | `staffWrite` |

- **Every shape is `.strict()` and none carries a `tenantId`.** The path has
  already answered that question; a body free to answer it again is two answers
  that can disagree, and the disagreement is a reseller broadcasting to the
  platform's users.
- **No permission guard.** `campaign.manage` is the platform staff's door, and
  a reseller's owner holds no operator permission — they are the platform's
  customer. `ResellerAccess` is the whole admission, applied in the service
  together with the scope the work then runs in, as billing's F-311-b is.
- Rate limits, per caller, 15 min: `RESELLER_CAMPAIGN_READ` (300),
  `RESELLER_CAMPAIGN_WRITE` (60). The read budget carries the audience count,
  which is the expensive one; the write budget matches the admin surface's.
- Refusals carry `{ reason }`, from either door, for the caller to translate.
  `not_allowed` 403, `reseller_not_found` 404, `reseller_suspended` 403,
  `reseller_terminated` 409, then the campaign reasons — `campaign_not_found`
  404, `campaign_not_draft` 409, `sms_not_available` 409.

## It delegates; it does not re-decide

Inside `ResellerAccess.run` the service calls `CampaignAdminService` with an
actor whose `tenantId` is the **admitted reseller**. Everything that follows is
therefore the rule already written and tested for F-035-c/d: draft-only writes
in the write's own `where`, whether an SMS line exists (F-035-i-a), the
`campaign_send` audit row, and which pool serves the caller — a reseller is not
the platform owner, so it is the app pool, where RLS stands behind the scope.

`notificationCampaign` and `user` are both in `TENANT_SCOPED_MODELS`, so inside
that scope **no query here names a tenant**. A filter written by hand is a
filter that can be written wrong, and the mistake this surface exists to
prevent is one reseller reaching another's users.

The delegated actor is the one thing that matters and the one thing the spec
mutation-checks: written as the session's tenant instead of the reseller's,
three of its six cases turn red.

## The count

`POST audience/count` answers how many users a segment reaches before anything
is drafted — F-313-b's *see the count*, and the reason a reseller can confirm a
broadcast rather than discover its size afterwards.

The `where` is **`audienceWhere`** — the fan-out's own function (F-035-d), not
a second query that agrees with it today. So the number a reseller confirms is
the number of recipient rows that will be written, with one difference, which
is why a screen calls it an estimate: `sendStartedAt` is *now* here and the
send's own start there, so users who sign up between the two moments are
counted by the send and not by the count.

A new audience key therefore lands in three places — the schema, the fan-out
and nothing else, because this route reuses both.

## Sends per day (F-019-t4, F-019-v4, ADR-0107)

| Rule | Why |
|---|---|
| A reseller's `send` is one unit of its `campaign_sends_daily_max` quota: `ResellerQuota.consume(tx, {tenantId, meter: 'campaign_sends_daily_max', qty: 1, sourceRef: 'campaign_send:<id>'})` in the flip's transaction, before the flip (`billing/contract.reseller-quota.md`) | the platform's bots and lines carry every send; one engine counts every quota (ADR-0107 point 4) |
| Counted per **fixed day** from 00:00 on the platform's clock, not the last 24 hours. Past what is included, `overage` charges the reseller's billing wallet and the send goes; `stop` refuses it | ADR-0107 point 7 and Consequences |
| A refusal is **409** with `ResellerQuotaExhausted.refusal`: a `stop` is `reseller_limit_reached`, `facts {key, limit, used}` (what the panel already names); an overage not paid is `reseller_quota_exhausted`, `facts {meter, stoppedBy, included, used}`. Nothing is flipped, nothing charged | the reseller learns whether to wait, top up, or raise its cap |
| The platform owner's pool consumes nothing; a tenant that is not a reseller is exempt; `resume` is not a new send and a stop gives nothing back | ADR-0106 point 4; a stopped send was already counted |

## Not here

Editing a draft (`PATCH`), the per-language texts (F-035-h) and `resume`
(F-018-q) have no reseller-named route. The flow this was built for drafts and
sends in one pass, and a route nobody calls is a surface to keep correct for
nothing; each is additive when a row needs it. Stopping a reseller's sends
stays the platform owner's alone (F-018-x, ADR-0058 (5)) — a reseller does not
stop its own campaign, and that is a decision, not an omission.
