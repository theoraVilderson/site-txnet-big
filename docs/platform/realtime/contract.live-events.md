---
id: realtime
layer: platform
status: active
version: 2
updated: 2026-10-06
---

# Contract — live events: which event reaches which page

The catalog ADR-0121 asks for: every event a page re-reads on, who produces
it, on which channel, and which screen listens. A §10 split from
`contract.md`; the transport is [contract.fanout.md](contract.fanout.md) and
who may hear a channel is [contract.channels.md](contract.channels.md).

**A new live event is a row here first**, in the same item that builds it.
The `RT-1` rows below are written so that an implementing session has nothing
left to decide; a fact that turns out wrong is said in one line and the row
corrected, per "Decide once".

## How every event is built (all RT-1 rows)

1. **Declare the type** in `contracts/realtime/events.json`, then
   `python3 tools/wire-gen.py` (C-08). The same string is the
   `OutboxEventType` in `shared-core/src/lib/automation/routing-keys.ts`;
   `routing-keys.contract.spec.ts` holds the two together.
2. **Write the outbox row in the producer's own transaction**
   (`tx.outboxEvent.create({ data: { aggregate, aggregateId, type, payload } })`,
   ADR-0021), with `tenantId` (or `userId`) in the payload. Never publish from
   the producer directly, except the two direct publishers named below.
3. **Route it** with a `LIVE_PUSH_FIELDS` row (`worker-service/src/app/outbox/live-push.consumer.ts`)
   and its queue binding in `broker.service.ts`. Nobody is told by inbox or
   bot: these are page refreshes, not notices (ADR-0084).
4. **Body = `type` + ids.** The page re-reads its own API (ADR-0121 point 3).
5. **The page listens with `useLiveReread`** (RT-1-a) and still reads on mount.
6. **Tests, one spec per side:** the producer's existing spec gains "writes
   the outbox row in the same transaction"; the page's test gains "re-reads on
   the event, ignores other types". No e2e.
7. **Leave the C-14 `except`** for the page's file, in `docs/CONVENTIONS.md`.

## Existing events

| type | channel | producer | page |
|---|---|---|---|
| `billing.payment.confirmed` / `reversed` | `user:` | billing → payment consumers | PaymentCreditedToast, wallet |
| `billing.wallet.changed` | `user:` | billing → live-push | useWalletBalance |
| `notification.created` | `user:` | notification → consumer | useNotifications, useMenuBadges |
| `entitlement.grant.delivered` / `refunded`, `network.grant.linksCaptured`, `entitlement.grant.usage` | `user:` | billing, network → live-push | useGrantsPage |
| `entitlement.grant.freeze_changed` | `user:` | billing (the user's own freeze, F-0401-c) → live-push | My services (F-0401-e, `readFreezeChanged`) |
| `identity.access.changed` | `user:` | identity (role set, role keys edited), tenant (seat removed) → live-push | AC-1-r (`useAccessLive`: refresh once, re-read `me`) |
| `network.panel.tested` | `tenant:` | network → panel-tested consumer | SystemsView |
| `network.panel.state_changed` | `tenant:` | network → panel-tested consumer (F-027-el) | SystemsView (F-027-em) |
| `network.panel.drift_raised` | `tenant:` | network → panel-tested consumer (F-027-fg) | SystemsView (F-027-fh) |
| OTP delivery state | `otp:<channelId>` | auth-service, direct (`OtpDeliveryStore.publish`) | useOtpDelivery |
| `support.message` / `read` / `typing` / `status` | `support:<id>` | support-service, direct (`SupportRealtime`) | thread views |
| `billing.payment.open_changed` | `tenant:` | billing (`announceOpenPayment`, RT-1-j) → live-push | ManualPaymentsView, ManualPaymentsWidget, useMenuBadges |
| `support.inbox.changed` | `tenant:` | support-service, direct (`SupportRealtime.tenant`, RT-1-g) | SupportInboxView |
| `billing.analytics.refreshed` | `tenant:` | billing (`AnalyticsRollupService`, a pass that changed a row, F-1001-a) → live-push; body `{type, from, to}` | `/analytics` (F-1001-d, `useAnalyticsRead`; the session's tenant only) |
| `billing.analytics.report` | `user:` | billing (`AnalyticsReportSender`, a scheduled report sent, F-1006-a) → live-push; body `{type, scheduleId}` | `/analytics?tab=reports` (F-1006-b), the person's own schedules |
| `billing.analytics.reseller_refreshed` | `user:` + `tenant:` | billing (the same pass, for a reseller with an owner, F-1001-p) → live-push; body `{type, resellerId, from, to}`; payload `tenantId` = the platform's, `userId` = the owner | the workspace twins `/reseller/analytics`, `/my-resellers/:id/analytics`, filtered by `resellerId` (`analyticsLiveOf`) |

## Planned — the RT-1 rows

**RT-1-a — `useLiveReread`** (`site-pwa/src/hooks/useLiveReread.ts`) — built
2026-10-07. `useLiveReread(channel: string | null, types: readonly string[] |
'any', reread: (cause: 'event' | 'missed') => void)`. Reads the client from
`usePanelRealtime()`; no subscription while either is null. Keeps `reread`
and `types` in refs, so callers need not memoize and nothing resubscribes. On
a message whose `payload.type` is in `types` (`'any'`: every message), and on
`onMissed`, it re-reads throttled to `LIVE_REREAD_MS`; a window that held an
event reads as `'event'`. Cleanup drops the owed read and unsubscribes.
On it: SystemsView, useWalletBalance (`'any'`), useNotifications (only an
`'event'` read can toast) and useMenuBadges, which keeps its 60 s poll until
RT-1-j. **useGrantsPage is not moved**: it renders usage from the payload
(F-307-t), which this hook never hands over — the same exclusion as
PaymentCreditedToast, support threads and OTP.

**RT-1-b — the tenant audience, and someone to hear it** — built 2026-10-07.
`LIVE_PUSH_FIELDS` rows are `{ audience: 'user' | 'tenant', fields }`;
`liveChannel` names `user:<payload.userId>` or `tenant:<payload.tenantId>`
and throws on a missing id, never falling back to the other. Existing rows
are `audience: 'user'`. `realtime.tenant.read` is held by `Admin` and
`Support` (`permissions.yaml` — Admin's line already existed, but no database
role held it — `seed.js`, migration `20261007000300`). It joins the set a
tenant-made role may grant (F-018-n2): hearing your own tenant's refreshes is
not a power.

**RT-1-c — payment pending.** No new type: PaymentPendingView re-reads on
`billing.payment.confirmed` / `reversed` on `user:`, matching `paymentId`.
It also re-reads when the tab becomes visible: a pending payment that closes
without credit (expiry, rejection) has no event, and inventing one only for
this page buys a few seconds on a page that says "your money is safe".
`setInterval` goes.

**RT-1-d — bulk-by-filter progress.** Type `billing.grant_bulk.progressed`,
`tenant:`, body `{type, jobId}`. Written by `GrantBulkJobService`
(`billing-service/src/app/payment/gift/grant-bulk-job.ts`) in `drainJob`'s
transaction after each batch, in the one that sets `done`, and in `cancel`.
BulkByFilter re-reads its job list; `JOB_POLL_MS` goes from `grant-bulk.ts`.

**RT-1-e — reseller domain status** — producer built 2026-10-07 with
EDGE-1-e. Type `tenant.domain.changed`, body `{type, domainId}`, written by
`TenantDomainService` in the transaction of every change of the view's
`status` or of the edge step (a check asked for, the sweep, the edge pass).
**Corrected:** on `user:<reseller owner>` *and* `tenant:<platform owner>`, not
the reseller's `tenant:` — the page is on the platform's panel, where the owner
is a platform user and staff are the platform's; the reseller's channel
reaches nobody looking at it. Payload `{tenantId, userId, resellerId,
domainId}`. ResellerDomainsView re-reads on both (EDGE-1-f, built); the button stays.
The setup wizard and the workspace's setup row re-read the onboarding
checklist on the same two (UX-2-c, UX-2-e).

**F-019-c1 — a reseller's paid renewal.** Type `tenant.subscription.renewed`,
`user:<reseller owner>`, body `{type}`; payload `{tenantId, userId}`. Written
by `TenantRenewalService` in a paid renewal's transaction only — an unpaid one
is already a notice, whose inbox row is live. My services' reseller section
re-reads on it (`contract.reseller-subscription.md`).

**F-019-c2 — a reseller's status.** Type `tenant.status.changed`, same
channel, body and payload. Written by `applyTenantStatus` and
`makeSuspensionManual` in every status change's transaction — by hand, a
grace, a purchase, a renewal. The same section re-reads on it.

**F-019-c3 — a grace extended.** Type `tenant.subscription.grace_extended`,
same channel, body and payload. Written by `grantGrace` in its transaction,
status changed or not; the section's deadline moved. Also written by a
`renewalGraceDays` edit, once per reseller in grace whose deadline it moved
(F-019-c4).

**RT-1-f — panel drain and removal.** Type `network.panel.drained`,
`tenant:`, body `{type, panelId, groupId}`. Written by `GroupDrainService.drainDue`
(`billing-service/src/app/traffic/group-drain.ts`) when a pass retired at
least one config or removed the member, in that write's transaction; the
tenant is the member's. No Go change. SystemsView adds the type to the
`useLiveReread` it got in RT-1-a.

**RT-1-g — support inbox** — built 2026-10-15. Type `support.inbox.changed`,
`tenant:`, body `{type, conversationId}`, published directly by
`SupportRealtime.tenant` (logged and swallowed). **Corrected:** after every
write but a read, typing or an internal note — open, a user's message (assigned
or not: `pending` is tenant-wide), a reply, assign, prioritize, resolve, close,
the idle sweep, reopen. A direct type is `DirectRealtimeEventType`
(`routing-keys.ts`), never an `OutboxEventType`; `events.json` holds both.
SupportInboxView re-reads on `tenantChannelOf(me)`; its 60 s poll is gone.

**RT-1-h — bot linking before sign-in.** No new channel family: reuse `otp:`.
`BotLinkService.startLink` calls `OtpDeliveryStore.mintHandles()` and returns
`channel` + `channelToken` beside `linkToken`. `completeLink` and `fail`
publish `{state, otpSent, failureKey?}` on that channel through the store.
useBotLink subscribes on the anonymous socket the way useOtpDelivery does and
calls `botLinkStatus` once per event, on `onMissed`, and on mount; the 2.5 s
poll goes. `contract.channels.md` needs no new rule.

**RT-1-i — delete `useLocaleVersion`.** Nothing imports it (2026-10-06). The
file goes, and its C-14 `except` entry with it. A new-version banner, if ever
wanted, is a new row with a broadcast decision of its own.

**RT-1-j — manual payments, and the badges stop polling** — built 2026-10-15.
**Corrected (user, 2026-10-15):** the list is every open payment, not only
verifying ones, and the platform owner lists every tenant's — so the type is
`billing.payment.open_changed`, written by every write that adds, moves or
closes an open payment (the list in billing `contract.verify.md`), one row per
tenant: the payment's and the platform owner's. `tenant:`, body `{type,
paymentId}`. ManualPaymentsView and ManualPaymentsWidget re-read; useMenuBadges
listens to it and `support.inbox.changed` on `tenant:`, `notification.created`
on `user:`, and re-reads on tab visible; its 60 s poll is gone.

**RT-1-k — the `members:` channel** (user, 2026-10-06) — built 2026-10-16. A change that
reaches a whole tenant, staff or not, reaches **that tenant's own users
only**, in one publish. The platform's users include its resellers' accounts
on the platform domain; a reseller's own users are a different tenant and do
not hear it. `members:<tenantId>`: a signed-in connection whose
`identity.tenantId` equals the id — no permission, because the body is
`type` + ids and says nothing a member could not read. Anonymous is refused.
Add `members` to `RealtimeChannelFamily` (`shared-core/src/lib/realtime/fanout.ts`),
a case in `channelRefusal` (`gateway-service/src/app/realtime/channel.ts`)
and a row in [contract.channels.md](contract.channels.md). Live push gains
`audience: 'members'` on RT-1-b's shape, channel `members:<payload.tenantId>`.
`channel.spec.ts`: a member hears it, another tenant's member and an
anonymous connection are refused.

**RT-1-l — the operating currency changed.** Type `tenant.currency.changed`,
`members:`, body `{type, tenantId}`. Written in `OperatingCurrencyService.set`
(`tenant-service/src/app/currency/operating-currency.service.ts`) inside the
`$transaction` callback, after `convertOperatingCurrency`, and only when it
returned a `changeId` (a retry that converted nothing writes nothing), with
`aggregate: 'tenant.currency'`, `aggregateId` = the target tenant. Its spec
gains "writes the row in the same transaction" and "a retry writes none".

**RT-1-m — the panel re-reads every money surface.** One listener, not one
per page: `useLiveReread(members:<session tenantId>, ['tenant.currency.changed'], …)`
in `(panel)/template.tsx`, whose reread bumps a `key` on `{children}`. The
page remounts and re-reads on mount (C-14 already makes every page do so),
which covers wallet, buy, gateways, catalog, packages, deposit, coupons and
the currency cards without touching them. `useWalletBalance` (top bar, outside
`children`) adds the type to its own subscription. **A page with unsaved
edits is not remounted:** a form calls `useHoldsUnsavedEdits(dirty)`
(`(panel)/_hooks/`, a counter in the same template); while it is above zero
the remount waits and a kit banner says the currency changed with a reload
button. GatewayForm, ProductWizard and the PackagesView editor register.
Spec: template test — remounts on the type, ignores others, waits while a
form holds edits.
