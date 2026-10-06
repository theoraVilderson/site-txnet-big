---
id: handoff
status: active           # empty | active
item: F-027-en           # the backlog id currently mid-flight
updated: 2026-10-06
---

# Handoff — the state a fresh session cannot recover on its own

Written when a session ends **mid-item**, and read as the first thing in the
next one. It is not a log: it is **overwritten every time**, and reset to
`status: empty` the moment the item flips to `done`. A handoff file that
outlives its item is worse than no handoff — the next session will trust it.

**Do not repeat anything that lives elsewhere.** The backlog says what the item
is. `MASTER_INDEX.md` says which unit owns it. `spec.py` says what it must do.
The code says what exists. This file holds only the four things that die with
the session:

1. what is half-written right now
2. the next concrete step
3. what was already tried and failed
4. what you and the agent decided out loud but never wrote down

If a session ended cleanly — item `done`, or never started — this file stays
`empty` and `/next` resumes with no help from it.

---

## Item

F-027-en (network). Bug reported 2026-10-06: an inbound edited on the panel
left every buyer's `/sub` on the old lines until each config was regenerated.
Root cause: `CapturedLinks.From` (`converge/links.go`) keys a capture by
`remoteId` + `uuid` only. An inbound edit moves neither. F-027-eo (user notice)
is the next row and depends on this one.

## Where it stands

A **first cut** is in the working tree, **uncommitted**. It is the
fingerprint + daily-refresh design (ADR-0123 as written). All its tests pass,
and it ran live on dev: 6 configs on panel `5922ac13…` (x_ui_alireza) were
refreshed, and only the 2 whose lines had really changed were announced.
The user then asked for the better design (table below), so the first cut is
**partly superseded**. It also has a **known bug**, which must be fixed first:

- **Bug:** a refresh that reads identical lines still writes `linksCapturedAt`
  (`recordSQL`, `CASE WHEN $8 THEN $12`). Billing's `drainConfigs`
  (`billing-service/src/app/traffic/group-drain.ts`, `replacementSince` =
  min `linksCapturedAt`) reads it as "since when the replacement line is
  served". So every daily refresh restarts a drain's `2 × subscriptionTtlSeconds`
  wait. Fix: `linksCapturedAt` moves only when lines or `linksUuid` change. Add a
  `linksCheckedAt` column for the refresh's age, and have
  `CapturedLinks.due` read age from it.

The dev DB **already has** migration `20261006000800_an_edited_inbound_refreshes_its_lines`
applied (`panel_inbound.fingerprint`, `config.linksInboundFingerprint`). A new
column means a new migration. Do not edit the applied one.

## Files touched, and their state

| file | state |
|---|---|
| `network-service/internal/driver/driver.go` | `Inbound.Fingerprint` added. Keep. |
| `network-service/internal/driver/xraylink.go` | `XrayFingerprint` (sha256 of listen, port, protocol, remark, stream, settings minus `clients`). Keep. |
| `network-service/internal/driver/{sanaee,xuialireza,threexui}/*.go` | `ListInbounds` fills `Fingerprint`; threexui's `inbound` struct gained Listen/Remark/Settings/StreamSettings. Keep. |
| `network-service/internal/converge/links.go` | `LinesRecapture` (24h), `InboundRefreshPerPass` (10), `AgedRefreshPerPass` (2), `refresh`/`due`, and the capped refresh in `capture`. Refresh age must move to `linksCheckedAt` (bug above). Built families should leave this path entirely (decision 1). |
| `network-service/internal/converge/postgres.go` | `desiredSQL` joins `panel_inbound pi` on `c."inboundRemoteId"`. `recordSQL` writes `linksInboundFingerprint` ($18) and announces only when lines or `linksUuid` changed. Still writes `linksCapturedAt` on every capture (the bug). |
| `network-service/internal/converge/inbounds.go` | upsert writes `fingerprint` ($9). Done. |
| `network-service/internal/converge/provision.go` | `DesiredConfig.InboundFingerprint`, `ProvisionReport.Refreshed`, `links_refreshed` in the converged log. Done. |
| `network-service/internal/db/schema.go` | both new columns in `RequiredColumns`. Add `linksCheckedAt` when it exists. |
| `network-service/internal/converge/{links,postgres}_test.go`, `driver/xraylink_test.go` | 5 new tests, all green. No test yet for the drain bug. |
| `txnet-backend/prisma/domains/network.prisma` | 2 fields added by hand (+8 lines). Do **not** run `prisma format` (dead ends). |
| `txnet-backend/prisma/domains/migrations/20261006000800_…/migration.sql` | applied on dev. Leave it alone. |
| `docs/architecture/decisions/0123-…md` | new ADR describing the first cut. Must be amended for decision 1 and the `linksCheckedAt` split. |
| `docs/domains/network/contract.links.md` | rule 6b added, rules 5/6/7/7a amended, v18. Rewrite 6b per decision 1. |
| `docs/domains/network/{contract.inbounds,data-model,INDEX}.md` | fingerprint column noted; migration added to `source:`. `data-model.md` is at 249/250 lines. |
| `docs/SURFACES.md` | Flows row `inbound-edit-stale-sub-lines` with the user's sentence. Done; `where.py --walk` resolves it. |
| `docs/BACKLOG.md` | rows F-027-en (doing) and F-027-eo (todo) added. |

## The next concrete step

1. Write a failing spec: a refresh that reads the same lines must leave
   `linksCapturedAt` unchanged. Then add `linksCheckedAt` (new migration, Prisma
   field, `RequiredColumns`), and make `due` age from it.
2. Decision 1: for Sanaee, Alireza and Marzban, build or compare lines from the
   pass's own bulk read. Sanaee/Alireza: `list()` already returns `inbounds/list`
   with `settings`/`streamSettings`. Marzban: `listUsers` returns `user.Links`.
   This means a driver capability that returns lines alongside `ListClients`
   (needs a §6.2b call-site listing first). Compare every pass, store and
   announce on change. No cap and no extra request for these families.
3. Families with a per-client sub-server fetch (3x-ui v3, Hiddify,
   Marzneshin) keep the fingerprint + capped daily path, and
   `InboundReadEvery` goes from 10 min to 2 min.
4. Amend ADR-0123 and `contract.links.md` rule 6b. Run the six checks, Go tests
   and the affected TS pair. Commit as `fix(network)` with `spec: F-027-en`.

## Dead ends — do not retry

| tried | why it failed |
|---|---|
| `npx prisma format --schema prisma/domains` | reformats every `*.prisma` file (unrelated alignment churn). Edit fields by hand and run `prisma validate` only. |
| `psql -c "UPDATE …; SELECT …"` in one `-c` | one implicit transaction: the failing SELECT rolled the UPDATE back silently. One statement per `-c`. |
| `go test ./...` for network-service as a whole | `internal/collect` `TestAWakeDuringATurnRunsOneMoreTurnAfterIt` flakes under parallel load; passes 5/5 alone. |
| `npm run test:affected` | `billing-service` `lottery-draw.spec.ts` "picks each ticket about equally often" hits the 5s timeout under load; passes alone via `npx nx test billing-service -- <file>` (bare `npx vitest run <file>` finds no tests). |
| a per-config `ClientLinks` refresh for x-ui built families | each call re-reads the whole inbound list (`mustFind` → `list`). That cost is what forced the 10/pass cap, and the user rejected it for decision 1. |

## Decided in conversation, not yet written down

| decision | where it must land |
|---|---|
| 1. Lines for Sanaee, Alireza and Marzban come from the minute bulk read (no extra request, no cap, ≤1 pass). Fingerprint + daily capped refresh stays only for 3x-ui v3, Hiddify, Marzneshin. Inventory read every 2 min. (user, 2026-10-06, the agent's recommendation) | amend ADR-0123; `contract.links.md` rule 6b; `contract.inbounds.md` rule 1 (10 min → 2 min) |
| 2. `linksCapturedAt` = since when these lines are served, moved only on a change; `linksCheckedAt` = last refresh | ADR-0123; `contract.links.md` rule 7; `data-model.md` (no room — move a line or trim) |
| 3. A buyer gets one bot + panel notice per Grant when a panel-side change replaced their lines ("update your subscription in your app"), never for their own regenerate (user, 2026-10-06) | row F-027-eo; `automation/contract.notices.md`; needs a cause on `network.grant.linksCaptured` |
| 4. Stage it: F-027-en (network) first in its own session and commit, then F-027-eo (user, 2026-10-06) | done: the backlog rows |
| 5. The fix is not committed yet; commit when F-027-en is `done` | the standing commit rule |
