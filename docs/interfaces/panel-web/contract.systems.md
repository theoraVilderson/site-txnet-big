---
id: panel-web
layer: interface
status: active
version: 32
updated: 2026-09-24
---

# Contract — panel-web: the systems page (F-027-ad)

A topic file of [contract.md](contract.md) (§10). One page, `/systems`
(`PANEL_SYSTEMS`), under `(panel)/systems/`: `page.tsx` is a server shell,
`_components/SystemsView.tsx` the screen (register form, panel list with its
capability matrix, drift report, holds queue), and `_lib/systems.ts` its rules.
It is the panel end of billing's systems routes — the routes, the scope and
every write are [billing/contract.systems.md](../../domains/billing/contract.systems.md)'s
(F-027-ar/as/at). The *why* is **ADR-0080**.

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
3. **Refused here, not at billing time.** A refused panel's matrix names the
   `required` rows it answered `no`, and an accepted one the `metered` rows
   that bar metered sale (`refusedBecause`). The question and the cost of a
   `no` are said in the reader's language by row key (`CAPABILITY_KEYS`);
   billing never sends question text (billing rule 7).
4. **The register wizard mirrors `registerPanelSchema`** (`validateRegister`):
   everything trimmed but the login, IPv4/IPv6, an http(s) `apiBaseUrl`
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

## Proof

`systems/register-wizard.test.ts` — rule 10: the steps, each blocking on its own fields, the family profiles (the ready set read out of `opener.go`), the composed login, the IP an address names.
`systems/systems.test.ts` — every set above against its declared home
(`network.prisma` enums, `contracts/network/capabilities.json` in order,
billing's `SystemsRejection` / `PanelScopeRejection` / `ResubmitRejection`),
`validateRegister`'s limits, `verdictOf` with and without a fault,
`refusedBecause`, `canResubmit`, `validateLogin`, `resubmitOutcome`, the
RADIUS secret's predicates and limits, the hold
and drift predicates, `validateNote`, the menu entry, every key in `en` and `fa`.
