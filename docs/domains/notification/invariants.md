---
id: notification
layer: domain
status: active
updated: 2026-09-28
---

# Invariants — notification

#1–#4 were extracted from schema comments. #1, #2 and #4 are enforced since
F-035-d, #3 since F-035-e for Telegram/Bale, F-035-f for SMS and F-035-h for
email. #5–#6 since F-035-a, #7–#8 since F-035-c, #9 since F-035-e, #10 since
F-035-f (email since F-035-h, a reseller's own SMS line since F-035-i-a), #11 since F-035-h,
#13 since F-313-d, #14 since F-601-a, #15 since F-601-m, #16 since F-601-p.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | A campaign with `tenantId` set only ever creates recipients whose user belongs to that tenant | `audienceWhere` in `campaign-fan-out.service.ts` (cross-tenant pool: no RLS behind it) | one tenant messages another's users |
| 2 | `sentCount` + `failedCount` reconcile with `notification_campaign_recipient` rows | `recordOutcome`: the counter moves in the transaction that moved its row | reports lie |
| 3 | Telegram/Bale drivers stay in `messenger`; email/SMS adapters live here (D-10) — this unit owns *state* | `campaign-delivery.service.ts` sends only through `BotClientRegistry` (ADR-0054) and `sms-line.ts` and `mail-line.ts`, whose drivers are `shared-core`'s, shared with OTP (F-035-f, F-035-h) | duplicated driver logic |
| 4 | A recipient row moves `queued -> sent \| failed` and is not re-queued silently; one delivery run at a time holds it | unique `(campaignId, userId)` + `skipDuplicates`; `recordOutcome`'s `where`; the delivery claim (`FOR UPDATE SKIP LOCKED` + `claimedUntil` lease) | double delivery |
| 5 | Every inbox read and write is filtered by the gate's `userId`, never an id from the request. `notification` has no `tenantId`, so no RLS stands behind this | `notification-inbox.service.ts` | a user reads or clears another's inbox |
| 6 | `readAt` is set only on rows still `null` | `markRead`'s `where` | "first seen" is rewritten |
| 7 | A caller who is not the platform owner reads, writes and lists only campaigns whose `tenantId` is the **actor's** — their session's tenant through the admin door, and the reseller `ResellerAccess` admitted through the reseller-named one (#13), which is what keeps this one rule true for both. Such a caller is served on the app pool only, so RLS stands behind the filter (ADR-0053) | `campaign-admin.service.ts` `access()`; RLS on `notification_campaign` | a reseller reads or edits another's, or the platform's, campaign |
| 8 | `filterCriteria` is written only through the strict `audienceFilterSchema`, and changes only while `status = draft` | `campaign-admin.schema.ts`; `update`'s `where` | an ignored key widens an audience; recipients chosen by a filter that no longer exists |
| 9 | A campaign message goes out only as the recipient's own tenant's primary bot, to a contact-verified chat that user linked in that same tenant — for a platform-wide campaign too | `campaign-delivery.service.ts` (`link.tenantId === user.tenantId`, `contactVerifiedAt` not null; cross-tenant pool, no RLS behind it) | one reseller's bot messages another's user, or a chat nobody proved |
| 10 | An SMS or email goes out only on a line of the campaign's own tenant, to a user of that tenant with a verified phone or address (D-38): the platform's line for the platform owner's campaign; a reseller's own SMS line (`own_credentials`, active) for its campaign (F-035-i-a). A platform-wide campaign has none; reseller email waits on F-112 | `platformOwnersOwn` and the own-line branch of `SmsLineResolver`/`MailLineResolver.lineFor`; `phoneVerifiedAt`/`emailVerifiedAt` in `campaign-delivery.service.ts`; `assertLine` in `campaign-admin.service.ts` | a reseller's campaign costs the platform, or a user is shown another tenant's number or domain |
| 11 | A recipient receives only a `published` text in their language, else the source; a text exists only while its source is unchanged — `messageBody`, `subject` or `sourceLang` changing deletes them all in that transaction | `textFor` + the `state: published` read in `campaign-delivery.service.ts`; `update` in `campaign-admin.service.ts`; texts written only through `CampaignAdminService.managed({ draft: true })` | an unreviewed machine translation, or a translation of an older message, reaches users |
| 12 | A campaign leaves `sending` for `stopped` only through `stopTenant` (the platform owner, F-018-x — the internal route left with F-018-w), and returns only through `resume`, never while its tenant is suspended or terminated; stopping touches no recipient row (F-018-q) | `stopTenant` and `resume`'s `where` + tenant check in `campaign-admin.service.ts` | a stop fails or loses who was never reached; a suspension's stop reopened beside it |
| 13 | A reseller-named campaign route acts only for the reseller its **path** names, admitted by `ResellerAccess` and run in that reseller's tenant scope; the caller's own session tenant is never the campaign's, and no query inside names a tenant by hand. The audience count uses `audienceWhere`, so the size a reseller confirms is the size the fan-out then writes | `reseller-campaign.service.ts` `run()` (the delegated actor) + `RESELLER_ACCESS_READER` on the app pool; `TENANT_SCOPED_MODELS` and RLS behind it | a reseller broadcasts to the platform's users — every tenant's — or confirms one audience and sends to another |
| 14 | A retention notice is told at most once per `(grantId, notice, period)`: the ledger row is claimed before anything is told, and only the event that wrote it claims it again | unique `(grantId, notice, period)` + `RetentionLedgerService.claim`'s `eventId` check; worker's `RetentionNoticeConsumer` claims first | a user is told the same threshold twice in a period, or a failed send is never retried; a usage event claiming a carried time row (F-601-f) holds it the same way |
| 15 | A user's notice settings — kinds and each Grant's level (F-601-o) — are read and written only through the gate's `userId`; a `cutoff` notice (ended, volume or wallet spent, purge soon) is always answered `now`; only an `important` notice is held for quiet hours (F-601-s); a muted notice still writes its ledger row; a held notice's bot message is told once, after `botAt` | `NotificationPreferencesService`, `GrantNoticeLevelService` (no `tenantId`, no RLS behind either); `RetentionLedgerService.claim` (`retentionKindOf`, `noticeClassOf`, the `botTemplate` check), `take`'s lease; worker's per-row `retention-held:bot` marker | a user silences "your service stopped", mutes another's notices, is told a past period after unmuting, or hears one notice twice on the bot |
| 16 | Grouping several Grants' notice into one message never touches the ledger: each Grant's row is claimed on its own, a combined message tells only claimed rows, and an urgent notice (a `RETENTION_NOTICES` row without `patient`) is never held for its siblings (F-601-p) | worker's `EventNoticeSender` hour lane (own burst key, own delay queue) and `RetentionNoticeConsumer` (`patient` on both rows of a combined notice); `RetentionHeldNoticeJob`'s per-row marker | a "once per period" notice is swallowed by a group, or "your service stopped" waits an hour |

## How to test

`notification-service/src/app/notifications/notification-inbox.spec.ts`
asserts #5 and #6 on the queries built;
`notification-service/src/app/campaigns/campaign-admin.spec.ts` asserts #7 and #8;
`notification-service/src/app/campaigns/campaign-fan-out.spec.ts` asserts #1, #2 and #4;
`notification-service/src/app/campaigns/campaign-delivery.spec.ts` asserts #9, #10 and the claim half of #4;
`notification-service/src/app/campaigns/campaign-texts.spec.ts` asserts #11;
`notification-service/src/app/campaigns/campaign-stop.spec.ts` asserts #12;
`notification-service/src/app/campaigns/sms-line.spec.ts` asserts #10 for a reseller's own line (F-035-i-a);
`notification-service/src/app/campaigns/reseller-campaign.spec.ts` asserts #13 (F-313-d);
`notification-service/src/app/notifications/notification-inbox.spec.ts` (`RetentionLedgerService.claim`) and
`worker-service/src/app/outbox/retention-notice.consumer.spec.ts` assert #14 (F-601-a).
`notification-service/src/app/notifications/notification-preferences.spec.ts` asserts #15 (F-601-m);
`notification-service/src/app/notifications/grant-notice-level.spec.ts` asserts it per Grant (F-601-o).
`worker-service/src/app/outbox/retention-grouping.spec.ts` and `retention-notice.consumer.spec.ts` assert #16 (F-601-p).
