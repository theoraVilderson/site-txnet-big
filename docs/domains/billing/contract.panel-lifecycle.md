---
id: billing
layer: domain
status: active
version: 48
updated: 2026-10-15
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
| `PATCH /api/billing/systems/panels/:id` | any of `name` (1–100), `region` (1–50), `ipAddress` (v4/v6 \| null), `apiBaseUrl` (URL ≤500, never null), `clientBaseUrl` (URL ≤500 \| null), `maxRequestsPerMinute` (1–6000), `ovpnProfile` (text ≤64 KiB \| null, rule 5a), `addressMayMove` (boolean, rule 5b); at least one; `.strict()` | `200 {id, reviewState, retest}` | 400; 403; 404 `not_found`; 409 `not_for_transport` / `not_for_driver` / `panel_retired` / `panel_already_registered` + `facts.panelId` when in scope (rule 2a) |
| `DELETE /api/billing/systems/panels/:id` | `?orphans=pause\|refund` (optional; rule 6a) | `200 {id, outcome: 'deleted' \| 'archived' \| 'removing', groups?}` | 400; 403; 404 `not_found`; 409 `panel_in_group` / `panel_has_configs` / `panel_retired` |
| `GET /api/billing/systems/panels/:id/remove-preview` | — | `{groups, liveConfigs, soleLineGrants}`, summed over its groups (rule 6a) | 400; 403; 404 `not_found` |
| `POST /api/billing/systems/panels/:id/restore` | — | `200 {id, reviewState: 'pending'}` | 400; 403; 404 `not_found`; 409 `panel_not_retired` / `panel_already_registered` |

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
   value sent again is not a change. `retest` says which happened. A
   refused duplicate's `duplicateOfPanelId` is cleared with it, and on
   restore (F-027-ce, `network/contract.registration.md` rule 8).
2a. **A new API address is one no other panel holds** (F-027-cd): 409
   `panel_already_registered` naming the holder if in scope, nothing written —
   contract.systems.md rule 4a. The panel's own address, re-spelled, is not
   a duplicate: the look-up leaves the panel out. A push panel's new IP is
   held the same way (F-027-ff, rule 4b there).
3. **Everything else leaves the verdict alone.** A name, region, budget or a
   push panel's IP (read by the allowlist within a minute) changes no answer
   the test gave.
4. **A push panel is never called.** It takes no `apiBaseUrl` and no
   `clientBaseUrl`, and cannot clear the IP its NAS is allowlisted by: 409
   `not_for_transport` (the CHECKs `panel_push_has_ip_address` and
   `panel_client_base_url_is_pull_only` hold the same).
5. **A test of the old address is discarded.** One still running when the
   edit lands writes nothing — neither its verdict nor its fault: the Go
   write is conditional on the addresses it tested as well as on `pending`
   (`network/contract.registration.md` rule 3, F-027-cc).

5a. **A router's `.ovpn` (F-307-d, user 2026-09-26).** Only a MikroTik User
   Manager panel takes `ovpnProfile`, else 409 `not_for_driver` (the CHECK
   `panel_ovpn_profile_is_user_manager` holds the same). Every buyer on the
   router downloads this one file, so it must name a `remote` and ask for
   `auth-user-pass`, and a `<key>` block or PEM private key is a 400. It is a
   file for buyers, not an address: no re-test. The panel list answers it back
   as `ovpnProfile` for the edit form.
5b. **The CDN opt-out (F-027-fa, ADR-0130 decision 4).** `addressMayMove`
   lets a panel behind a CDN be dialed wherever its name resolves, never
   halted `address_moved` (`network/contract.address.md` rule 7). A setting,
   not an address: no re-test. The panel list answers it back.

`panel-edit.spec.ts` pins rules 1–4, 5a, 5b and the scope.

## Deleting a panel — the rules (F-027-bz)

Decided with the user 2026-09-25, the catalog's rule for products (F-026-i).

6. **Refused while it serves.** A panel any group holds is 409
   `panel_in_group` — remove the member, or drain it (contract.panel-groups.md
   rules 23–24). One with a config not `retired` is 409 `panel_has_configs`.
6a. **Or deleted in one step** (F-027-eg, user 2026-10-06). With `?orphans`,
   a panel in groups has every membership evicted with that choice
   (contract.panel-groups.md rule 24e; a first evict's choice stands), is
   marked `removeRequestedAt`, and answers `removing`. The drain sweep
   archives it (`retiredAt`, the mark cleared) once it is in no group, no
   config on it is live, and no config still has a `remoteId` — its clients
   gone from the server, so no user keeps a line nobody watches — or an hour
   after the ask, for a dead panel that never confirms. Meanwhile it takes
   no new group (`panel_not_found`) and the list answers `removeRequestedAt`.
   `remove-preview` sums the evict preview over its groups.
7. **No history: deleted.** History is any row that names the panel: a
   config in any state, counter state, a seen or quarantined delta, a hold,
   a drift event, unattributed usage, a RADIUS session, or an HA partner. With
   none, the row goes (`panel_inbound` cascades); its login stays in the
   vault under an id nothing names, as after a failed registration.
8. **History: archived.** `retiredAt` is set by one `UPDATE` that holds rule 6
   itself, and the rows stay. A key the check missed makes the delete fail;
   that archives instead. What an archived panel is to `network-service` is
   network invariant 49. The list answers `retiredAt`; the page hides it
   behind a toggle.
9. **Archived is final until restored.** An edit is 409 `panel_retired`;
   so is a second delete. `restore` clears `retiredAt` and sends the panel
   back to `pending` with its last test cleared — it is tested before it is
   collected again. An archived push panel holds no IP, so restoring one
   whose IP a live push panel now holds is 409 `panel_already_registered`
   (F-027-ff).

`panel-retire.spec.ts` pins rules 6–9 and the scope; `group-drain.spec.ts` the archive of 6a.
