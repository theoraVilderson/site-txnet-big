---
id: panel-web
layer: interface
status: active
version: 29
updated: 2026-09-25
---

# Contract — panel-web: the "my services" page (F-502-s)

`/services` (`(panel)/services/`), the sidebar's `my-services` entry. One row
per Grant the caller holds, over `GET /api/billing/gift/grants`
([billing/contract.gift.md](../../domains/billing/contract.gift.md)), with
F-502-q's reissue button on each.

It exists because of the sentence
[contract.gift-code.md](contract.gift-code.md) used to end with: a free-service
key is shown once and billing keeps only its hash (D-35), so until this page
the reissue button was reachable only while the redemption modal was still up.
A key lost yesterday had no way back. This is that way back, and the later home
of the `/sub` link (F-113).

Its pieces: `_components/MyServicesView.tsx` (the page), `_components/ServiceRow.tsx`
(one Grant), `_components/GrantConfigs.tsx` (its configs, F-027-ac),
`_hooks/useGrantsPage.ts` (the two reads, and the re-read a purchase's end
asks for), `_lib/my-services.ts` (the status tones, the name rule and
`readGrantSettled`), `_lib/service-configs.ts` (verdicts, refusals, bytes,
the purge countdown).

## Rules

1. **Every Grant is listed and nothing is filtered here.** Billing answers the
   status and never narrows the list, because a key is lost from an expired
   Grant as easily as from a live one — so the dead statuses are exactly the
   rows a user arrives looking for. There is no status tab, no "active only"
   default, and the reissue button is on every row whatever its status; the
   route does not gate on status either (F-502-p). Paging is the only knob the
   list has.
2. **Every status billing can answer has a tone and a sentence**
   (`_lib/my-services.ts`). A status with no row renders as a blank pill next
   to a service someone is trying to understand, so the spec reads the union
   out of `entitlement.prisma` rather than restating it: a seventh status goes
   red here instead of shipping empty. The colours are theme tokens, never raw
   palette classes, and gold is a tone and never a control (user, 2026-09-13).
3. **The list carries no key, and the page never pretends otherwise.** Billing
   selects its columns explicitly so neither the subscription key nor its hash
   can leave in a list, so a row shows a key only as the answer to a press on
   that row. Nothing is cached across a reload: a page that remembered a minted
   key would be storing a credential billing itself does not keep.
4. **A reissue replaces what is on screen, and a refusal changes nothing** —
   rule 12 of [contract.gift-code.md](contract.gift-code.md), unchanged on this
   surface because it follows from the route and not from where the button is.
   The old key is dead inside billing's transaction, so leaving it up would
   offer a credential that opens nothing; a refusal minted nothing, so the key
   already shown is still the key and only billing's sentence is added,
   `role="alert"`, with its `ref` ([contract.errors.md](contract.errors.md)).
   The button is disabled while its ask is in flight and never retries for the
   user: the bucket is 5 per 900s and each call destroys a working key.
   "The previous key has stopped working" is shown only when there *was* a key
   on screen to replace — the first ask on a row replaces nothing the user
   could have.
5. **The key panel's sentences are the gift modal's keys**, not a second copy
   under `myServices`. "Shown only this once" and "the previous key has stopped
   working" are the same two facts about the same credential; a second set would
   be a second translation to keep in step, and the two surfaces would drift.
   What this page does own is its own chrome — title, empty state, periods,
   statuses (`common.myServices.*`).
6. **A name is a `nameKey` this page resolves, and a failure costs the names
   only.** The list answers the variant's key, not its text, so the published
   `catalog` namespace is read beside it — the same route and the same
   flattening the catalog page uses. A language with no catalog text answers
   404, which is `{}`: the rows then read by their SKU. There is no
   source-language fallback here, unlike `catalogText`, because the list
   answers no `sourceLang` and a SKU a user can quote to support beats a
   language they may not read. A Grant with no catalog item (`variant: null`)
   has neither and shows "unnamed service".
7. **The URL is the page.** `?page=` is read from and written to the query
   string, so a page of services survives a reload and can be sent to support;
   nothing is mirrored into a store beside it. Page 1 writes no parameter.
   `Pagination` owns no navigation ([contract.kit.md](contract.kit.md) rule 6).
8. **A failed read is not an empty list.** The rows are dropped on a failure
   and the page shows billing's sentence with a retry — showing the previous
   page's services under a failure would be a lie, and an empty state would
   tell a user with services that they have none. The empty state is for a
   `total` of zero, which the route answers rather than a 404: the page exists
   before the first Grant does.

9. **Consumed against purchased, and the purge clock** (F-027-ac). A metered
   Grant shows what the panels measured against what was bought; a prepaid one
   what it used alone. Bytes arrive as decimal strings and stay exact to the
   formatter. A suspended Grant with a `purgeAt` shows a days-and-hours
   countdown and says a top-up brings it back; past the instant it says the
   configs are being removed — the hourly job acts *after* it, never at it.
10. **Every verdict but `synced` is a button that says why.** Each
    `DriftState` has a label and — except `synced` — a sentence; the spec reads
    the enum out of `network.prisma`, so a new verdict is red there, not a
    blank pill. A ceiling the panel has not fully taken reads as queued.
11. **An action answers per config** (user, 2026-09-23). New key and delete, on
    one config or the ticked ones, in one request; delete asks first. The done
    count and each refused config — by the label it had when pressed, with its
    reason's sentence — are shown, then the list is read again. A 4xx is the
    request itself and changes nothing on screen. No new key is offered once a
    config's allowance is spent. Configs are read only when opened.
12. **Metering down is not service down.** While `collection-health` answers
    `unavailable` the page says the service is not cut off; a failed read of
    that flag shows nothing.

13. **A paid Grant reads "being prepared" until delivery ends, then turns
    live without a reload** (F-111-f). `pending` is a Grant paid for and not
    yet delivered, so its pill says "being prepared" and the row says there is
    nothing to do. `entitlement.grant.delivered` or `.refunded` on the buyer's
    `user:` channel ([automation/contract.outbox.md](../../domains/automation/contract.outbox.md),
    "A purchase's end, told") re-reads the page — only when it names a row
    shown as `pending`, and a payload with no `grantId` is ignored. The re-read
    is quiet: no skeleton, and a failure keeps billing's last answer, because
    the event is a hint and not the record (D-15). The row is never patched
    from the payload: delivery sets the period, and a refund ends in whatever
    status billing says (today `cancelled`). Only the latest read lands, so a
    quiet read of page 1 cannot overwrite page 2.

## Proof

`services/my-services.test.tsx` — the status union against
`entitlement.prisma`, and a row's reissue: the id alone, the replacement, a
refusal that changes nothing, and one ask at a time. F-027-ac: `DriftState` and
`ConfigStatus` against `network.prisma` and the refusals against billing's
tuple; usage, the countdown, the verdict button, the queued ceiling, a bulk
delete with one refusal, a declined confirm, and a spent allowance. F-111-f:
the "being prepared" line on a pending row only, and
`services/_hooks/useGrantsPage.test.ts` — a delivery and a refund each re-read
without a skeleton, an event for a row not shown pending (or with no
`grantId`) asks nothing, a failed re-read keeps the rows, and no socket still
reads the page.

## Not covered

The `/sub` link itself (F-113, F-027) — this page is where it will go, and
where a regenerated config's new credential will be read. Moving a config or
adding one from here is nobody's row. A purchase ending while the socket is down is
seen on the next read, not live — the socket is how the page hears sooner
(`contract.realtime.md`). Filtering
or searching the list is nobody's row; so is renewing a service from here, which
needs a checkout the panel does not have yet.
