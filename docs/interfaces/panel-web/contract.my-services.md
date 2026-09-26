---
id: panel-web
layer: interface
status: active
version: 32
updated: 2026-09-26
---

# Contract — panel-web: the "my services" page (F-502-s)

`/services` (`(panel)/services/`), the sidebar's `my-services` entry. One row
per Grant the caller holds, over `GET /api/billing/gift/grants`
([billing/contract.gift.md](../../domains/billing/contract.gift.md)), with
each Grant's subscription link on its row (F-114-e-c).

It was built as the way back to a key shown once (D-35, F-502-q). Since
ADR-0085 (D-43) billing keeps the token sealed, so this page is where a user
gets their `/sub` link — copied or as a QR, as often as asked — and the only
place a leaked one is reset. The panel never says "key".

Its pieces: `_components/MyServicesView.tsx` (the page), `_components/ServiceRow.tsx`
(one Grant), `ConfigLines.tsx` (its lines, F-307-c), `QrDialog.tsx`,
`GrantConfigs.tsx` (its configs' actions under "manage", F-027-ac),
`UsageBars.tsx`, `_hooks/useGrantConfigs.ts` and `useSubscriptionLink.ts`
(one read each, shared by the row),
`_hooks/useGrantsPage.ts` (the two reads, and the re-read a purchase's end
asks for), `_lib/my-services.ts` (the status tones, the name rule and
`readGrantSettled`), `_lib/service-configs.ts` (verdicts, refusals, bytes,
the purge countdown), `_lib/usage.ts` (bar shares, time left) and
`_lib/config-lines.ts` (a line's name, the WireGuard `.conf`).

## Rules

1. **Ended services are hidden by default, one tap away** (F-502-u, user
   2026-09-26). The page asks billing's `current` scope — `cancelled` and
   `exhausted` left out, `hidden` counted — and, when `hidden` > 0, one button
   asks `all`. `?all=1` sits in the URL beside `?page=` and a toggle goes back
   to page 1. Expired and suspended Grants are always in the default list.
   The filter is billing's, never this page's: a page filtered here comes back
   short. The link controls are on every row whatever its status.
2. **Every status billing can answer has a tone and a sentence**
   (`_lib/my-services.ts`). A status with no row renders as a blank pill next
   to a service someone is trying to understand, so the spec reads the union
   out of `entitlement.prisma` rather than restating it: a seventh status goes
   red here instead of shipping empty. The colours are theme tokens, never raw
   palette classes, and gold is a tone and never a control (user, 2026-09-13).
3. **The link is asked for, never carried or kept** (F-114-e-c). It sits
   folded under the configs (F-307-c) and unfolding reads nothing. The list
   answers no token; a row reads `GET .../subscription-link` the first time a
   copy or the QR needs it, once per row while the page is up, and nothing is
   stored across a reload — billing answers the same link every time. A
   clipboard that refuses shows the link to select by hand. The QR is drawn
   in the browser (`qrcode.react`), on white in both themes, so the link never
   leaves for a QR service.
4. **Reset asks first, replaces what is on screen, and a refusal changes
   nothing.** "Reset link" is for a leaked link: the confirmation says the
   current one stops working and must be added to the app again, and "cancel"
   is the focused answer. The new link replaces the old on screen — dead
   inside billing's transaction — with "the previous link no longer works". A
   refusal minted nothing, so the link on screen stays and only billing's
   sentence is added, `role="alert"`, with its `ref`
   ([contract.errors.md](contract.errors.md)). Disabled while in flight, never
   retried: the bucket is 5 per 900s and each call destroys a working link.
5. **A refusal to read is billing's sentence, and reset stays offered.**
   `link_not_kept` (a Grant from before the token was kept) tells the user to
   reset once; `no_subscription_domain` to contact support. The panel branches
   on neither: the sentence is the answer and the reset button is always there.
   The texts are `common.myServices.link.*`; the gift modal's key sentences
   are gone with the key.
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
   Grant shows what the panels measured against what was bought; a capped
   prepaid one against billing's `trafficCapBytes` — the limit plus unexpired
   adjustments, `/sub`'s `total`, so panel and app agree (F-111-t). Bytes
   arrive as decimal strings and stay exact to the formatter. A suspended Grant with a `purgeAt` shows a days-and-hours
   countdown and says a top-up brings it back; past the instant it says the
   configs are being removed — the hourly job acts *after* it, never at it.
9a. **Unlimited is said, never inferred from a 0** (F-111-s). A Grant billing
    answers with `trafficUnlimited` shows what it used and "unlimited
    traffic", and no bar: its `purchasedBytes` of 0 bounds nothing
    ([entitlement/invariants.md](../../domains/entitlement/invariants.md) 15).
    An `endsAt` of `null` reads "unlimited time" — 0 days sold is stored null.
10. **Every verdict but `synced` is a button that says why, and `synced`
    shows nothing** (user, 2026-09-26: a "synced" pill on every server taught
    a word and nothing else). Each `DriftState` has a label and — except
    `synced` — a sentence; the spec reads the enum out of `network.prisma`, so
    a new verdict is red there, not a blank pill. A ceiling the panel has not fully taken reads as queued.
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
    quiet read of page 1 cannot overwrite page 2. A delivery that ended while the socket
    was down went to nobody, so the same quiet read follows a reconnect
    (`onMissed`, [contract.realtime.md](contract.realtime.md)) while a row is
    still `pending`. **Nothing is asked on a clock** (F-111-l, user
    2026-09-26): a socket that is down reconnects on its own backoff, and
    until then the page shows billing's last answer.
13a. **A Grant's configs turn usable without a reload** (F-111-l). Their lines
    are captured a minute or two after delivery; `network.grant.linksCaptured`
    on the owner's channel names the Grant
    ([network/contract.links.md](../../domains/network/contract.links.md) 7a).
    The event reads no list: it bumps that row's `configsAsked`, and its config
    list re-reads if open — quietly, no skeleton, a failure keeps what is
    shown. A closed list reads nothing; opening reads anyway. A reconnect
    bumps every row's.

14. **A capability reads by its name, and by its key only where none is
    published** (F-114-f-c, ADR-0086). A Grant's `featureKeys` resolve against
    the `catalog` texts the page already reads, at
    `catalog.[t_<hex>.]capability.<key>.name`. The Grant answers no tenant, so
    the prefix is the one in its variant's `nameKey`: the product's tenant is
    the only tenant whose capabilities it may carry
    ([catalog/invariants.md](../../domains/catalog/invariants.md) 9), so another
    tenant's text under the same key is never read. The platform's is read
    beside it; no variant reads the platform's alone. No text in this language
    shows the key, `dir="ltr"`, as before — no second read, no source-language
    fallback (rule 6's reason). A named chip keeps the key as its `title`.

15. **A row reads like a subscription page** (F-307-c; user 2026-09-26:
    "take the idea from Marzban's"). One column: name and status; one usage
    bar with used-of-bought and days left, from the row, no read — a metered
    Grant against what it bought, a capped prepaid one against its cap
    (F-111-t), no bar for unlimited traffic; then the configs, every line a
    row with copy and QR icons and "copy all" (one line each); then the
    subscription link as one row, copy and QR. A QR is a dialog, never an
    inline block. **The configs are open from the start on the page's first
    three `active`/`pending` rows** and one tap on the rest: each open row is
    one `CONFIG_LIST` read and a page holds 20. **"Manage"**, folded at the
    card's foot, holds the 30 days, the configs' new link and delete, and
    reset — what can break a working setup, never above it. The row holds one
    config read and one link, so a reset replaces the link the row copies.
    The 30 days (billing's `GRANT_USAGE`) are read only under "manage": one
    bar per day, download under upload, scaled to the busiest day; a failed
    read costs the chart only. Every share
    is taken in `BigInt`, so a Grant with a byte left never draws full. SVG,
    no chart library, theme tokens; the time axis never mirrors in RTL.
16. **A line is copied or scanned on its own, and a file only where the
    protocol needs one.** Each captured line has copy and QR; nothing is read
    for it. A `wireguard://` line gets a `.conf`, built in the browser (the
    line holds the private key) and offered only when the line has a key, an
    endpoint with a port, a peer key and an address — a half file imports and
    never connects. No lines is two sentences: `linksCapturedAt` `null` is not
    captured yet, a time is a panel that gives none; both point at the link.
17. **A config is named by its buyer, and billing names the lines** (F-307-i,
    ADR-0089). A pencil on each config's first line edits its `label` in
    place (≤ 40, the region as placeholder, empty = the default); Enter
    saves through `billing-config-label`, Escape writes nothing, a refusal
    keeps what was typed with billing's sentence. A save re-reads the list:
    the lines arrive named, as `/sub` serves them, and are never renamed here.
18. **A service with many configs is searched, and a search hides nothing
    from an action by accident** (F-307-l; user 2026-09-26: "20 configs got
    hard"). From 6 configs, one box per row narrows both the lines and
    "manage" by name, label, protocol or region (ی/ي, ک/ك and ۲/2 alike);
    "copy all", "select all" and a bulk action reach only the configs shown.
    The list is the Grant's whole list, so this never shortens a page;
    finding a *service* by a config is billing's (F-307-m).

## Proof

`services/my-services.test.tsx` — the status union against
`entitlement.prisma`, and a row's link (F-114-e-c): nothing read until asked,
the copy of billing's link and one read per row, the QR, the hand-select
fallback, a refusal's sentence with reset still offered, and "key" nowhere;
reset: a declined confirmation, the replacement, a refusal that changes
nothing, and one ask at a time; copy and QR on the row, reset only under
"manage". F-027-ac: `DriftState` and
`ConfigStatus` against `network.prisma` and the refusals against billing's
tuple; usage, days left, the countdown, the verdict button and a healthy server's
silence, a server's name, the queued ceiling, a bulk
delete with one refusal, a declined confirm, and a spent allowance. F-111-f:
the "being prepared" line on a pending row only, and
`services/_hooks/useGrantsPage.test.ts` — a delivery and a refund each re-read
without a skeleton, an event for a row not shown pending (or with no
`grantId`) asks nothing, a failed re-read keeps the rows, a reconnect re-reads
only while a row is pending, no clock asks anything even with the socket
down, and no socket still reads the page; F-111-l: a capture bumps only a
shown row's configs, a reconnect bumps every row's, and `connection.test.tsx`
— an open list re-reads with no skeleton, keeps its rows on a failure, and a
closed one reads nothing;
F-111-s: an unlimited Grant's "unlimited traffic" and "unlimited time",
no "0 B" anywhere; F-111-t: a capped prepaid one against billing's cap,
with a bar, and one with no cap saying only what it used.
`lib/realtime.test.ts` — `onMissed` on a reconnect's accepted channels only.
F-114-f-c: `capabilityNames` — a tenant's own by its product's prefix, the
platform's, another tenant's same key never read — and a chip showing the
name, the key only where none was published.
F-307-c: `services/connection.test.tsx` — the `.conf` for a whole line and
none for a partial one, a line's name, shares exact past 2^53 and a bar
never full with bytes left, 30 bars read under "manage" only, an open row
offering no new link, delete or reset, per-line copy and a QR dialog, "copy
all", a closed row opening with one tap, the download on a whole WireGuard
line only, the two empty-lines sentences, and the link row unread until
asked. F-307-i: one rename per config, a save that re-reads and copies the
line billing named, an empty name clearing to the default, Escape writing
nothing, and a refusal keeping the field. F-307-l: the matcher's folding,
no box under 6 configs, the lines narrowed with a "none" sentence, and a
bulk delete reaching only the configs shown.

## Not covered

A regenerated config's new credential is delivered by the same link (F-113),
and reaches its card only after the next capture. A User Manager config's login and
its router's `.ovpn` (answered since F-307-d) are shown by F-307-e. Per-config bars and a window other than 30 days are nobody's row.
A server's own "new link" (F-027-ac) is a config credential, not the
subscription link, whose reset reads "make a new subscription link". Moving a config or
adding one from here is nobody's row. Filtering
or searching the list is nobody's row; so is renewing a service from here, which
needs a checkout the panel does not have yet.
