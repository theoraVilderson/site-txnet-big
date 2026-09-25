---
id: billing
layer: domain
status: active
version: 45
updated: 2026-09-25
---

# Systems — a panel after registration

A topic file of `contract.md` (§10), beside [contract.systems.md](contract.systems.md):
what the platform owner does to a panel once it is registered. The door, the
scope and the rate limit are that file's ("Who may call", rule 20); the
service is `billing-service/src/app/systems/panel-lifecycle.ts`. Nothing here
calls `network-service` (ADR-0071): every route writes desired state, read on
its next tick.

## Routes

| Route | Body | Answers | Errors |
|---|---|---|---|
| `PATCH /api/billing/systems/panels/:id` | any of `name` (1–100), `region` (1–50), `ipAddress` (v4/v6 \| null), `apiBaseUrl` (URL ≤500, never null), `clientBaseUrl` (URL ≤500 \| null), `maxRequestsPerMinute` (1–6000); at least one; `.strict()` | `200 {id, reviewState, retest}` | 400; 403; 404 `not_found`; 409 `not_for_transport` |

`SYSTEMS_ADMIN_WRITE` (30 per user per 15 minutes), as every systems write.

## Editing a panel — the rules (F-027-by)

1. **Settings, not identity.** `transport`, `driverType`, `counterSemantics`
   and `role` are refused by the schema: a different family or transport is
   a different panel, registered as one. The verdict is the test's, and each
   secret has its own route (contract.systems.md rules 14–19).
2. **A changed address is a re-test.** When `apiBaseUrl` or `clientBaseUrl`
   differs from the stored value, the panel goes back to `pending` with
   `connectionTestedAt`, fault and detail cleared, in the same write — an
   accepted panel too, since its verdict was about the server it reached,
   and a refused one, since the new server has not been asked. Collection
   reads only an accepted panel (network invariant 44), so it pauses until the
   next tick's test (`network/contract.registration.md` rule 4). The same
   value sent again is not a change. `retest` says which happened.
3. **Everything else leaves the verdict alone.** A name, region, budget or a
   push panel's IP (read by the allowlist within a minute) changes no answer
   the test gave.
4. **A push panel is never called.** It takes no `apiBaseUrl` and no
   `clientBaseUrl`, and cannot clear the IP its NAS is allowlisted by: 409
   `not_for_transport` (the CHECKs `panel_push_has_ip_address` and
   `panel_client_base_url_is_pull_only` hold the same).
5. **Known window.** A test already running against the old address may
   still write its verdict after the edit; the Go write is conditional on
   `pending`, not on the address. Editing the address again re-tests.

`panel-edit.spec.ts` pins rules 1–4 and the scope.
