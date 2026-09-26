---
id: panel-web
layer: interface
status: active
version: 33
updated: 2026-09-26
---

# Contract — panel-web: the systems page (F-027-ad)

A topic file of [contract.md](contract.md) (§10). One page, `/systems`
(`PANEL_SYSTEMS`), under `(panel)/systems/`: `page.tsx` is a server shell,
`_components/SystemsView.tsx` the screen (register form, panel list with its
capability matrix, drift report, holds queue), and `_lib/systems.ts` its rules.
It is the panel end of billing's systems routes — the routes, the scope and
every write are [billing/contract.systems.md](../../domains/billing/contract.systems.md)'s
(F-027-ar/as/at), and the panel groups section (`PanelGroups.tsx`, rules
`_lib/panel-groups.ts`) is the panel end of billing rules 20–24 (F-027-bw).
The *why* is **ADR-0080**.

## Rules

1. **The platform owner's page.** The menu entry (top level, `systems`)
   `requires: ["panel.manage"]` and `tenantTypes: ["platform_owner"]`: billing
   refuses anyone else (`panelScopeOf`, 403 `not_platform_owner`), so a
   reseller holding the key does not see a page that could only refuse it.
2. **Nothing here is a verdict of its own.** Every figure is what
   `network-service` last wrote (ADR-0071). A registered panel reads `pending`
   until the next tick's connection test; a `connectionTestFault` is the test
   getting no answer, not a verdict, and the panel still reads `pending`
   (`verdictOf`). Staleness shows as a timestamp, never as a guess.
   **The answer arrives without a reload** (F-027-bs): `SystemsView`
   subscribes to `liveChannelOf(me)` — `tenant:<me.tenant.id>`, only when
   `me` holds `realtime.tenant.read` or `*`, since the gateway refuses anyone
   else — and on `network.panel.tested` (`isPanelTested`) re-reads
   `GET /systems/panels`. The event is a nudge, never rendered: the row shown
   is still billing's. Without the key the page reads on load, as before.
   **A burst is two reads, not twelve** (F-067-p, ADR-0084 decision 3): the
   re-read goes through `trailingThrottle(…, LIVE_REREAD_MS)` (`lib/realtime.ts`,
   2 s) — the first event reads at once, the rest of the window owes one read
   at its end, so the last event always causes one. Unmounting cancels it.
3. **Refused here, not at billing time.** A refused panel's matrix names the
   `required` rows it answered `no`, and an accepted one the `metered` rows
   that bar metered sale (`refusedBecause`). The question and the cost of a
   `no` are said in the reader's language by row key (`CAPABILITY_KEYS`);
   billing never sends question text (billing rule 7).
4. **The register wizard mirrors `registerPanelSchema`** (`validateRegister`):
   everything trimmed but the login, IPv4/IPv6 asked and sent only for `push`
   (F-027-br: nothing reads a pull panel's), an http(s) `apiBaseUrl`
   required for `pull`, a budget of 1–6000 or blank (billing's default 60).
   The login is a password input, sent once; the answer's `configured` is all
   the page says about it. A push panel also asks for its RADIUS secret
   (F-027-az), required there and never sent for a pull panel, even if it
   was typed before the transport changed.
5. **The request budget is shown with its trade-off**: lower is gentler on the
   owner's server and less likely to get us banned, but a pass waits for its
   slots, so usage and ceilings land later ([network contract.budget.md](../../domains/network/contract.budget.md)).
   `blockedSince` shows beside it as an error tone.
6. **Drift: acknowledge once.** `haltsCollection` is the collector's own test
   (halted and unacknowledged); acknowledge is offered only while
   `acknowledgedAt` is null, with an optional note, and re-reads the drift list
   *and* the panels, since the halt ends on the next pass. A 409 re-reads too.
   A `foreign_claim` names the other panel when billing does (`foreignPanel`,
   F-027-cf) and, while it halts, says to put the address right first.
7. **Holds: release or write off, only while `pending`** (`canResolveHold`).
   A release answers `202` and the hold stays `pending` until the meter bills
   it — the row says "queued", never "released". A write-off requires a note
   (1–1000, `validateNote`) and uses error tones. Every action re-reads the
   list; nothing is patched in from an answer.
8. **A new login, on every panel but a refused one** (F-027-av → billing
   F-027-au). `canResubmit` hides it on a refused panel (billing answers 409
   `panel_refused`); `validateLogin` mirrors the schema (1–4096, untrimmed),
   in a password input cleared on success. `resubmitOutcome` says what the
   answer means — re-tested on the next pass, cooling off after
   `rate_limited`, or rotated under a live panel — and the list is re-read.
   A push panel also offers a new **RADIUS secret** (F-027-az,
   `canResubmitRadiusSecret`: push and not refused, `validateRadiusSecret`).
   It re-tests nothing, so it says only that the NAS is checked against the
   new secret within a minute. A push panel with none stored shows
   `radiusSecretMissing` as an error pill: its NAS is off the allowlist.
9. **One sentence per value the backend can write.** Review state, panel
   state, connection-test fault, hold reason and state, drift event type and
   refusal are each a `Record` over the union. Theme tokens only, never gold.
10. **Registering is a five-step wizard** (F-027-bq, `RegisterWizard.tsx`,
   rules `_lib/register-wizard.ts`): family → details → connection → login →
   review, as the gateway wizard (F-102-e). A step blocks only on its own
   fields; `validateRegister` still decides the body. Picking a family fills
   its transport and counting (`DRIVER_PROFILES`, from the network driver
   contracts; editable under "advanced") and clears a client address the family
   has no use for, since a hidden field is never sent. A family is offered as
   ready only if `internal/opener` has a case for it; any other registers and
   says it stays `pending`. **The login is asked in its parts** — username and
   password, or Hiddify's API key — and composed as the Opener splits it
   (`composeLogin`); a username with `:` is refused here, since the Opener
   would test it as someone else. `role` reads as primary / standby, an HA
   pair's (network `contract.groups.md` rule 6), never as on / off.

11. **Panel groups: where a VPN variant's Grants are placed** (F-027-bx,
   network `contract.groups.md`). A group lists its members with their
   panel's review and state, and says how many fulfilment can place on —
   `memberPlaceable` is groups rule 8's own test (not `drain`, accepted,
   `healthy`) — against `minHealthyPanels`; a group short of it is an error
   tone, since a Grant sold there never activates. The form mirrors
   `createPanelGroupSchema` (`validateGroup`): the lifetime is asked in whole
   minutes (1–10080) and sent in seconds; `strategy` is never offered or sent
   (billing rule 21), and **`priority` / `weight` are not asked** — `mirror`
   reads neither, and they open with the strategy that does. An edit sends
   only the fields that differ from the group, so a value set outside the
   schema is never re-sent untouched, and one that changes nothing is refused
   here. The add picker offers registered panels the group does not hold,
   never a refused one (`addablePanels`). **Drain, not remove, is the answer
   to a member in use:** both are offered only on a member not already
   draining (`canDrain`, `canRemove`); a remove answered 409
   `member_has_configs` says so. Drain asks once, states the least wait
   (`DRAIN_TTL_MULTIPLE × subscriptionTtlSeconds`, the sweep's constant,
   `waitOf` rounding up), and a draining member reads "no sooner than"
   `drainEarliestAt` — never "at", since a Grant whose replacement is served
   later waits longer. Every write re-reads the groups; a refusal does too.
   The page's live re-read (rule 2) re-reads the groups with the panels.
   A group names no protocol: its panels' picked inbounds do (rule 12).
12. **A panel's inbounds: which ones a buyer is placed on** (F-114-b,
   `PanelInbounds.tsx`, billing rule 25, network `contract.inbounds.md`).
   "Inbounds" on a pull panel's row (a push panel is never called, so has
   none) opens what the last read found, when, and the panel's users. The
   admin ticks inbounds, picks `all` or `spread` (each said in a sentence),
   and sets the panel's and each inbound's user cap, empty = none. Only a
   sellable inbound can be ticked — a gone one, or one of a protocol we do
   not sell, is marked and never sent (`sellable`, `inboundNote`); a
   disabled one keeps its tick and is marked. A panel with no live, sellable
   tick is an error tone: it places nobody (`nothingPicked`). The save sends
   only what differs from the read (`validateInbounds`), so a pick made
   elsewhere is not overwritten, and nothing changed is refused here. "Read
   again" is `refresh`, answered in a sentence: the list is re-read within a
   minute. The placement and cap are **the panel's defaults**, each beside the
   layer in force — this panel or the platform (`LAYER_KEYS`, F-027-ci) — and
   an inbound a group has taken names it (`assignedTo`): only it sells there.

13. **A panel is edited in one sheet** (F-027-cb -> billing F-027-by,
   `PanelEditSheet.tsx`, rules `_lib/panel-lifecycle.ts`). "Edit" on the card
   opens name and region, addresses, request budget and login, grouped; a
   push panel is asked only its NAS IP (billing `not_for_transport`).
   `validatePanelEdit` mirrors `updatePanelSchema` and sends **only what
   differs** — an untouched form is refused here — and a changed API or link
   address is warned about before the save (`addressChanged`): it re-tests
   the panel and pauses its collection. A typed login goes to rule 8's route
   after the settings; blank keeps the stored one. The card keeps edit,
   inbounds and capabilities in view; a new login, a RADIUS secret and delete
   sit behind "more" (`ActionsMenu`).
14. **Delete says what it will do** (F-027-cb -> billing F-027-bz). The
   sheet says a panel with no history is deleted and one with history
   archived; a panel a group holds gets no button — the groups are named
   (`groupsHolding`) — and billing's other refusals are said by key. The
   outcome (`DELETE_OUTCOME_KEYS`) and a restore's sentence are the list's,
   since the card moves. Archived panels are hidden behind a toggle with
   their count (`visiblePanels`), read as archived with when, and offer only
   restore; the add-member picker never offers one (`addablePanels`).
15. **A group is created, edited and deleted in a sheet** (F-027-cb ->
   billing F-027-ca). The card names members, variants and refresh as pills;
   delete is offered with its blocker said first (`groupDeleteBlock`:
   members, then variants), and the button only on an empty, unsold group.
16. **How one group sells on one panel** (F-027-ci -> billing rules 24b–24c,
   `_lib/member-settings.ts`). Every member shows its placement, cap and
   inbounds **with the layer each comes from** — member, panel, platform —
   so an admin changes the right one. "Selling settings" reads the panel's
   inbounds and offers the member's own placement and cap, **empty =
   inherit** (null), with the inherited value and its layer shown; there is
   no "no cap" for a member, which cannot lift a capped panel (network rule
   4a). `priority` / `weight` stay unasked (rule 11). The save sends only what
   differs (`validateMember`). Below it, the membership's inbounds: none
   ticked sells the panel's pool; ticking takes an inbound out of it. One
   another group holds is shown with that group and never offered, a gone one
   only while held (to let it go), and one not on sale or disabled on the
   panel is marked as taking nobody (`inboundChoices`). The save is the whole
   set (`validateMemberInbounds`); a membership whose set — or pool — has
   nothing live says it places nobody (`sellsNobody`). Both re-read.
17. **A refusal names its holder** (F-027-ci). Billing sends the holder of
   `panel_already_registered`, `inbound_assigned_elsewhere` and
   `inbound_has_configs` as `facts` ids only; `refusalSentence` names it from
   the panels and groups the page read (`HolderNamesContext`), so a holder
   outside the reader's scope (billing F-027-cj) or none sent reads as the
   plain sentence. A refused duplicate's card names `review.duplicateOf`.
## Proof

`systems/register-wizard.test.ts` — rule 10: the steps, each blocking on its own fields, the family profiles (the ready set read out of `opener.go`), the composed login, the IP an address names.
`systems/systems.test.ts` — every set above against its declared home
(`network.prisma` enums, `contracts/network/capabilities.json` in order,
billing's `SystemsRejection` / `PanelScopeRejection` / `ResubmitRejection`),
`validateRegister`'s limits, `verdictOf` with and without a fault,
`liveChannelOf` and `isPanelTested` (rule 2),
`refusedBecause`, `canResubmit`, `validateLogin`, `resubmitOutcome`, the
RADIUS secret's predicates and limits, the hold
and drift predicates, `validateNote`, the menu entry, every key in `en` and `fa`.
`systems/member-settings.test.ts` — rules 16–17: `LAYER_KEYS` against billing's `SellingLayer`, `validateMember` (inherit as null, only what changed), `inboundChoices`, `validateMemberInbounds`, `sellsNobody`, `refusalSentence` named and plain.
`systems/panel-lifecycle.test.ts` — rules 13–15: only what changed is sent, the untouched form refused, the address warning, a push panel's fields, `groupsHolding`, both delete outcomes, `groupDeleteBlock`, `visiblePanels`.
`systems/panel-groups.test.ts` — rule 11: `ConfigProtocol` and `PanelGroupMemberRole` read out of `network.prisma`; rule 12: `InboundPlacement` and the two inbound refusals from their homes, `validateInbounds` (only what changed, caps, never an unsellable tick), `inboundNote`, `nothingPicked`; the drain multiple out of `group-drain.ts`, `validateGroup` (create, limits, an edit sending only what changed), `memberPlaceable`, `groupHealth`, `addablePanels`, `canDrain` / `canRemove`, `drainEarliestAt`, `waitOf`.
