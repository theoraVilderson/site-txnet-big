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
| 2026-09-04 | Custom-domain verification depends on ArvanCloud CNAME + TXT. Is there an API contract for it yet? | no | ASSUMED(2026-09-04): manual until a worker is built | -> interfaces/ + operations/ |
