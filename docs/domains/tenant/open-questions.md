---
id: tenant
layer: domain
updated: 2026-09-04
---

# Open questions — tenant

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | No service, controller, or worker implements any tenant behaviour. What is the build order relative to `billing` / `network`? | yes | ASSUMED(2026-09-04): tenant + identity harden first, then catalog/billing | -> ADR |
| 2026-09-04 | Where does credential encryption happen (KMS? app-level key? which cipher)? Schema only says "Encrypted". | yes (security) | ASSUMED(2026-09-04): app-level AES-GCM with a key from env/secret | -> ADR + security/threat-model.md |
| 2026-09-04 | `register.service.ts` looks up `Tenant.slug = 'platform_owner'`; the schema `slug` is free text. Is that slug a reserved constant? | no | ASSUMED(2026-09-04): yes, reserved | -> rules.md |
| 2026-09-04 | No seed existed for the `platform_owner` Tenant or its default roles, so every registration in a fresh DB failed `register.defaultRoleMissing`. Checked the actual DB constraints (`psql \d tenant.tenant`): `Tenant.ownerUserId` is a plain non-null `uuid` column with **no FK** to `identity.User` (unlike every other tenant-scoped table) — so there is no real circular-FK constraint, and bootstrap order is just "create Tenant, then create the owner User". Fixed by `prisma/seed.js` (Tenant `platform_owner` + roles `user`/`Support`/`Admin`/`SuperAdmin` + one owner `User`), wired to `prisma db seed`. Left open: was the missing `ownerUserId` relation intentional (schema-only domain, not finalized) or an authoring gap? | no | ASSUMED(2026-09-04): unenforced on purpose for now; add the relation when `tenant` moves past schema-only | -> ADR when `tenant` unit is implemented |
| 2026-09-04 | Custom-domain verification depends on ArvanCloud CNAME + TXT. Is there an API contract for it yet? | no | ASSUMED(2026-09-04): manual until a worker is built | -> interfaces/ + operations/ |
