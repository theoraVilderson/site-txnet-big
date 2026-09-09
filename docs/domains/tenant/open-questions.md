---
id: tenant
layer: domain
updated: 2026-09-09
---

# Open questions — tenant

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | No service, controller, or worker implements any tenant behaviour. What is the build order relative to `billing` / `network`? | yes | ASSUMED(2026-09-04): tenant + identity harden first, then catalog/billing | -> ADR |
| 2026-09-04 | Where does credential encryption happen (KMS? app-level key? which cipher)? Schema only says "Encrypted". | yes (security) | ASSUMED(2026-09-04): app-level AES-GCM with a key from env/secret | -> ADR + security/threat-model.md |
| 2026-09-04 | `register.service.ts` looks up `Tenant.slug = 'platform_owner'`; the schema `slug` is free text. Is that slug a reserved constant? | no | ASSUMED(2026-09-04): yes, reserved | -> rules.md |
| 2026-09-04 | No seed existed for the `platform_owner` Tenant or its default roles, so every registration in a fresh DB failed `register.defaultRoleMissing`. Checked the actual DB constraints (`psql \d tenant.tenant`): `Tenant.ownerUserId` is a plain non-null `uuid` column with **no FK** to `identity.User` (unlike every other tenant-scoped table) — so there is no real circular-FK constraint, and bootstrap order is just "create Tenant, then create the owner User". Fixed by `prisma/seed.js` (Tenant `platform_owner` + roles `user`/`Support`/`Admin`/`SuperAdmin` + one owner `User`), wired to `prisma db seed`. Left open: was the missing `ownerUserId` relation intentional (schema-only domain, not finalized) or an authoring gap? | no | ASSUMED(2026-09-04): unenforced on purpose for now; add the relation when `tenant` moves past schema-only | -> ADR when `tenant` unit is implemented |
| 2026-09-04 | Custom-domain verification depends on ArvanCloud CNAME + TXT. Is there an API contract for it yet? | no | ASSUMED(2026-09-04): manual until a worker is built | -> interfaces/ + operations/ |
| 2026-09-09 | Tenant resolution reads the host the **API** was called on. The panel calls the API cross-origin at `api.<domain>` (`site-pwa/src/lib/auth-api.ts`), so a reseller's own panel domain reaches auth-service as `Origin`, never as the host. Does a white-label tenant get a `tenant_domain` row for its API host, or should `Origin` be consulted after the host? | no | ASSUMED(2026-09-09): a row for the API host. Confirmed with the user 2026-09-09 — build ADR-0020 as written rather than widen it mid-item | -> an ADR-0020 amendment, when a reseller domain is actually provisioned (F-018) |
| 2026-09-09 | A `suspended` / `terminated` / soft-deleted Tenant still resolves — `TenantResolverService` filters on neither `status` nor `deletedAt`. What a request resolved to such a tenant may then do is a product rule with no home yet | no | ASSUMED(2026-09-09): resolution is not the place to enforce tenant lifecycle; it answers who, not whether | -> rules.md when tenant administration is built (F-018) |
