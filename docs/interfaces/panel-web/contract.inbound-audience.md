---
id: panel-web
layer: interface
status: active
version: 43
updated: 2026-10-17
---

# Contract — panel-web: who sells an inbound, its shares, and taking a group off it (F-027-eu)

A topic file of [contract.md](contract.md) beside
[contract.systems.md](contract.systems.md) (rule 12, the panel's inbounds),
which is at §10's ceiling. ADR-0127: an inbound is sold by **every group** of
its panel or by **the groups listed**; a listing may carry the group's share;
taking a group off an inbound its users are on is a job, never a side effect.
Code: `systems/_components/InboundAudience.tsx`, `InboundRelease.tsx`, rules
`systems/_lib/inbound-audience.ts`; billing's routes are
[contract.panel-groups.md](../../domains/billing/contract.panel-groups.md)
(audience `PUT`, share `PUT`, release, rules 24c, 24f, 24g).

## What the page reads

Billing's inbound read (`GET /systems/panels/:id/inbounds`) answers, per
inbound, `audience`, `listedTo` and **`sellers`** — every group in the owner's
scope selling it now, each with its `share`, `clients` (live configs of that
group's Grants there) and `releaseJobId` (a running release) — and the
panel's `members`. The page computes nothing from the database it was not
answered.

## Rules

1. **Every inbound says who sells it** (`soldBy`): "every group on this panel",
   the listed groups by name in the reader's language (`formatList`), or "no
   group". «چه گروه‌هایی می‌فروشند» opens the choice under that inbound, one at
   a time.
2. **The choice is every group or chosen groups** (`AudienceForm`). Each member
   group shows its users there; a group being taken off says so. Ticking none
   is allowed and warned: nobody new is placed there.
3. **A share is asked only of a group that lists it now and keeps it**
   (`validateAudience`): billing has no share on an every-group inbound
   (`listing_not_found`). Empty = none. Only what changed is sent — the
   audience `PUT` first, then each changed share; nothing changed is refused here.
4. **A group losing it with users there is not saved; it is released**
   (`losing`, from `sellers`). The save opens the release step instead —
   billing would refuse it (`inbound_has_configs`), and the panel's client
   keeps only scalar `facts`, so the groups and counts come from the page's
   own read. The step names each group and its users, and asks **move** (to
   the group's next placement; a user with nowhere to go keeps this one) or
   **empty** (their config there removed; a user left with nothing is paused —
   the default — or refunded, the evict's words), and a reason
   (`validateRelease`, billing's body). `requestId` is one per confirm.
5. **The job is shown live** (C-14): status, progress over the frozen total,
   done / refused / failed, and stop while it runs. It is re-read on
   `network.config_move_job.progress` for its own `jobId` on the tenant's
   channel (`RELEASE_EVENTS`, `useLiveReread`) — never polled. A release
   already running on an inbound is shown when it is opened. The listing
   changes only when the job ends; its end and a stop re-read the inbounds.
6. **The member sheet names a shared inbound** (`inboundChoices`): an inbound
   other groups list is offered, «مشترک با …» naming them; ticking it shares
   it. An every-group one is marked: ticking it makes it this group's alone.
   A member sells its listings **plus** the every-group inbounds (`sellsNobody`).

## Proof

`systems/inbound-audience.test.ts` — rules 1–6: `soldBy`, `losing` (narrowing,
widening), `validateAudience` (only changes, a share only for a listed seller,
the limits), `validateRelease` (reason, an empty's orphans), `runningRelease`
and `RELEASE_EVENTS` against `events.json`, the member sheet's `sharedWith`,
`everyGroup` and `sellsNobody`. `systems/systems.test.ts` holds the refusal
words to billing's `SystemsRejection`.
