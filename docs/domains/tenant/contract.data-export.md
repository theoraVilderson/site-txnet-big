---
id: tenant
layer: domain
status: active
version: 1
updated: 2026-10-22
---

# Contract — tenant / data export

A topic file of `contract.md` (§10). **A reseller can always take its data and
leave** (catalog §14.8, F-212-a): one archive of everything that is its own,
asked for at any moment, in any status. Code:
`txnet-backend/tenant-service/src/app/exports/`; the clock is worker-service's
`tenant_data_export_drain`. Deletion — §14.8's other half — is not built.

## The routes

| Route | Who | Answer |
|---|---|---|
| `GET /api/tenants/:id/data-exports` | the reseller's owner, or platform staff with `platform.tenant.manage` (the bare `ResellerAccess` door, invariant 21 — no member key opens it) | `{exports: [{id, status, createdAt, finishedAt, expiresAt, sizeBytes, rowCount}], nextAllowedAt}` — the newest 10; `nextAllowedAt` null when one may be asked for now |
| `POST /api/tenants/:id/data-exports` | same | **202** with the queued export |
| `POST /api/tenants/:id/data-exports/:exportId/link` | same | `{url, expiresAt}` — a signed path on the caller's Host, valid 5 minutes |
| `POST /api/internal/tenant/data-exports/drain` | service callers only | `{built, failed, expired}` — one tick |

`status`: `queued` → `building` → `ready` → `expired`, or `failed`. Refusals:
`not_allowed` 403, `reseller_not_found` 404 (staff only),
`export_too_soon` **429** with `nextAllowedAt`, `export_not_found` 404,
`export_not_ready` 409. The page hears `tenant.data_export.changed` on the
requester's `user:` channel, `{type, resellerId, exportId}`, when an export is
built, fails or expires (RT-1, C-14; the panel is F-212-c).

## Rules

| Rule | Why |
|---|---|
| 1. Every route is the `dataExport` capability, which **every** column of the status matrix opens, terminated and onboarding included; `ResellerAccess` admits a terminated reseller for it alone ([rules.md](rules.md)) | §14.8: "available in every state including `suspended`, never behind a paywall" |
| 2. At most one export per 24 h per tenant: the newest export that did not `fail` is the clock, read under a per-tenant advisory lock, so two clicks queue one | §14.8; a failed build is the platform's fault, not a use |
| 3. Asking is an audit row (`tenant_data_export_request`), and so is every link (`tenant_data_export_delivery`, with the archive's sha256), each in its own transaction with the act | §14.8: "the delivery itself is audited"; a signed URL carries no session to audit later |
| 4. The archive is built by the drain, one export a tick, inside **one REPEATABLE READ snapshot** in the tenant's scope, then stored as a **private** object at `exports/<id>.jsonl.gz`; only a signed URL serves it (object-storage rule 6) | a ledger row and the balance it moved agree; an archive of every customer is never public |
| 5. A build is leased 20 min and claimed by a guarded update; one whose lease ran out is taken again, and failed after 3 tries | safe twice (C-29); a crashed build does not wedge the queue |
| 6. A `ready` archive is deleted 7 days after it was built; the row stays `expired` | the URL is minted per download, so the file need not outlive its use |
| 7. **What is in it** is `EXPORT_TABLES` (`export-tables.ts`), one rule per table of the schema: the rows whose `tenantId` (the tenant row: its `id`) is the tenant; the rows reached through a parent that is (a wallet through its owner, a coupon's scope through its coupon); or none, for a named reason — `secret`, `platform`, `derived`, `operational`, `volume` | §14.8's contents — users, Grants, quotas, invoices, ledger rows, config metadata, support, pages, themes, domains, bot mappings, audit — and nothing that is not the tenant's |
| 8. **Never a credential.** `omit` drops a password hash, a 2FA secret, a refresh-token hash, a Grant's subscription token, a config's client id and lines, a panel's login, an old link's path, a gateway's sealed keys, a domain's TXT token; the vault's tables are left out whole | §14.8: config metadata, never secrets. `tenant-data-export.spec.ts` fails on a column named like one that is neither omitted nor declared harmless |
| 9. **Completeness**: `Record<Prisma.ModelName, ExportRule>` does not compile without a rule for a new table | §14.8: "fails if any of them is handled by neither export nor deletion" |
| 10. The reseller tree is the tenant row and its owner: no sub-reseller exists yet (F-901). Files (logos, attachments) travel as their `stored_object` rows, not their bytes | what the schema holds today |

## The archive

gzip JSONL, the format support's monthly archives use (F-033-n) — `zcat | jq`
reads it. Line 1 `{"export": {format: "txnet-tenant-export/1", exportId,
tenantId, createdAt, omittedColumns, skipped}}`; then one `{"table":
"<schema>.<table>", "row": {…}}` per row, as Postgres's `to_jsonb` writes it
(money as its exact decimal, C-02); last `{"end": {rows, tables}}` — a file
without it was cut short. A new shape is a new `format` number. Capped at
1 GiB by the storage policy; past it the export fails.

## Consumers

| unit | uses |
|---|---|
| panel-web | the three routes and the live event — «export my data» on the reseller page (F-212-c, not built) |
| automation | `tenant_data_export_drain` calls the internal route (`domains/automation/contract.jobs.md`) |
| object-storage | the archive, private, under the tenant's prefix ([contract.md](../../platform/object-storage/contract.md)) |
