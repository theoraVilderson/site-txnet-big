---
id: panel-web
layer: interface
status: active
version: 42
updated: 2026-10-08
---

# Contract — panel-web: the reseller on My services (F-502-v)

`/services` shows the reseller the caller holds as **its own section above the
Grants** — never a row of their list (user, 2026-10-08: a reseller bought with
no VPN service left My services empty). A reseller is not a Grant: it has no
configs, link or traffic, and billing's Grant list never answers one.

Pieces: `services/_components/ResellerSubscription.tsx` (the section, mounted
by `MyServicesView` before the search box), `_hooks/useOwnedReseller.ts` (the
read and its re-read) and `_lib/reseller-subscription.ts` (the state, tones).

## Rules

1. **One read, tenant's.** `GET /api/tenants/purchase/mine`
   ([tenant/contract.admin.md](../../domains/tenant/contract.admin.md)) — the
   reseller the caller holds live, `null` for none. Asked only of a platform
   user who is not its owner, the one caller who can hold one — the gate the
   sidebar's `useHoldsLiveReseller` uses; nobody else asks anything.
2. **Slug, package, period end, state, and a way in.** The slug (`dir="ltr"`;
   the route answers no display name), the package's name or "not on a
   package yet", `currentPeriodEnd` as a local date — "this period ends" while
   active, "the period ended" otherwise — a pill, one sentence for the state,
   and a link to the reseller's home in the panel
   (`myResellerConsolePath`, the reseller menu's first entry). Not the
   handoff to its own domain: that is the sidebar's (`contract.reseller-workspace.md`).
3. **The state is the tenant's answer, read at the period end**
   (`subscriptionState`). `suspended` is the tenant's status; a live reseller
   (`active` or `trial`) whose `currentPeriodEnd` has passed is **grace** — the
   renewal is owed and the sweep has not suspended it
   ([tenant/contract.billing.md](../../domains/tenant/contract.billing.md)
   "Subscription renewal"); otherwise **active**. `terminated` shows nothing,
   and the route never answers it. Grace says to top up the reseller's billing
   wallet before the grace runs out; it names no deadline, because the route
   answers no `graceUntil` and the panel does not guess one.
4. **Tones are theme tokens**: active green, grace gold (a tone, never a
   control — user, 2026-09-13), suspended the error tone.
5. **A failure costs this section only.** No answer, `null`, or a failed read
   draws nothing; the Grants, their empty state and their errors are the
   page's own ([contract.my-services.md](contract.my-services.md) rule 8). A
   failed re-read keeps the last answer.
6. **A renewal's notice re-reads it, never a clock** (C-14, ADR-0121).
   `useLiveReread` on the caller's `user:` channel for
   `notification.created`: a renewal's "payment due" and "suspended" are inbox
   rows for the owner ([automation/contract.outbox.md](../../domains/automation/contract.outbox.md)
   "The tenant consumers"), and the inbox row is live. A reconnect re-reads
   (`onMissed`).

## Proof

`services/reseller-subscription.test.tsx`: the state — suspended, grace past
the end (also for `trial`), active before it or with no period, nothing for
terminated; the section outside any list with slug, package, state and the
link's path; grace's and suspension's sentences; nothing for `null` or a
failed read; nothing asked of a reseller's user or the platform owner; and a
`notification.created` on `user:<id>` re-reading into the new state.
`services/search.test.tsx` mocks the section out.

## Not covered

A paid renewal writes no notice and no live push, so an open page shows the
new period on the next visit, a reconnect or a notice — a
`tenant.subscription.renewed` push would be tenant's and automation's row.
Renewing or changing the package from here is not offered:
`/resellers/buy` holds the reseller (F-019-l), and an upgrade is the reseller
workspace's (F-019-v10).
