---
id: entitlement
layer: domain
status: active
version: 39
updated: 2026-10-21
---

# Contract — entitlement / the old host pointed here, and a test of one old link (F-204-b)

A topic file of `contract.md` (§10), the import's last step (D-63). An
imported user's old link is kept by the commit
([contract.import.md](contract.import.md) rules 29-31) and answered by
`sub-service` on a `legacy_sub` host (sub-api F-203-b), once the reseller has
proved that host and pointed it here (tenant `contract.domains.md` rule 7).
These two routes tell the page which hosts that is, and test one from
outside. Code: `legacy-host.ts`, the probe `SubscriptionLinkProbe`
(`migration-seams.ts`).

## Rules

1. **The hosts are the tenant's, not a run's.** Every `legacy_sub_link` host
   of the reseller, with its count, most first, at most 20 — two imports of
   one old panel share a host, and the domain is the reseller's.
2. **Only a proved host is fetched.** The host must be the reseller's
   `legacy_sub` domain and `verified`, else `legacy_host_not_routed`, and
   nothing leaves. The host came from the source, which is adversarial input
   (catalog §16); and an unproved one may still be the old panel, answering
   "works" for a link this platform does not serve.
3. **The sample is a live Grant's link**: the oldest on that host whose Grant
   is not `cancelled` (sub-service answers that one 404 by rule), else
   `legacy_link_not_found`. Its label is the item's snapshot's, null once
   purged (rule 28 of the import).
4. **Fetched from outside, as the app would**: `https://<host><path>`, the
   decoded path escaped again, through network-service's
   `POST /api/internal/source/link` — its egress guard, no redirect followed,
   30 s (network `contract.source.md`). The fetch runs outside the
   transaction. Only the server count comes back; the body never does.
5. **What the fetch met is the answer, not an error.** A network refusal is
   `outcome: failed` with its reason (`source_unavailable`,
   `source_unreadable` — a 404 among them —, `source_redirected`, …);
   network not answering is `probe_unavailable`. The route itself refuses
   only for rules 2 and 3 and the door.
6. **The door is the import's**: `migration.manage`, `read` for both — the
   test changes nothing. The test spends the write bucket: each call is an
   outside fetch.

## Routes

Under `/api/billing/tenants/:tenantId/migration-runs`, `ResellerAccess` on
`migration.manage`.

| Route | Body | Answers |
|---|---|---|
| `GET /legacy-hosts` | — | `hosts[]`: `host`, `links` |
| `POST /legacy-hosts/test` | `host` (≤ 253, normalised as `normalizeHost`) | `host`, `label` or null, `outcome` `ok` + `servers`, or `failed` + `reason` |

| Refusal | Status | Meaning |
|---|---|---|
| `legacy_host_not_routed` | 409 | not the reseller's `legacy_sub` domain, or not `verified` (rule 2) |
| `legacy_link_not_found` | 404 | no live Grant's link on that host (rule 3) |
