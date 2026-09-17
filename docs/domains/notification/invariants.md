---
id: notification
layer: domain
status: active
updated: 2026-09-17
---

# Invariants — notification

#1–#4 were extracted from schema comments and stay unenforced until their rows
(F-035-d/e/f) send campaigns. #5–#6 are enforced since F-035-a, #7–#8 since F-035-c.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | A campaign with `tenantId` set only ever creates recipients whose user belongs to that tenant | planned — F-035-d | one tenant messages another's users |
| 2 | `sentCount` + `failedCount` reconcile with `notification_campaign_recipient` rows | planned — F-035-d | reports lie |
| 3 | Telegram/Bale drivers stay in `messenger`; email/SMS adapters live here (D-10) — this unit owns *state* | planned — F-035-e/f | duplicated driver logic |
| 4 | A recipient row moves `queued -> sent \| failed` and is not re-queued silently | planned — F-035-d | double delivery |
| 5 | Every inbox read and write is filtered by the gate's `userId`, never an id from the request. `notification` has no `tenantId`, so no RLS stands behind this | `notification-inbox.service.ts` | a user reads or clears another's inbox |
| 6 | `readAt` is set only on rows still `null` | `markRead`'s `where` | "first seen" is rewritten |
| 7 | A caller who is not the platform owner reads, writes and lists only campaigns whose `tenantId` is their own. Such a caller is served on the app pool only, so RLS stands behind the filter (ADR-0053) | `campaign-admin.service.ts` `access()`; RLS on `notification_campaign` | a reseller reads or edits another's, or the platform's, campaign |
| 8 | `filterCriteria` is written only through the strict `audienceFilterSchema`, and changes only while `status = draft` | `campaign-admin.schema.ts`; `update`'s `where` | an ignored key widens an audience; recipients chosen by a filter that no longer exists |

## How to test

`notification-service/src/app/notifications/notification-inbox.spec.ts`
asserts #5 and #6 on the queries built;
`notification-service/src/app/campaigns/campaign-admin.spec.ts` asserts #7 and #8.
