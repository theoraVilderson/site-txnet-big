---
id: i18n
layer: platform
updated: 2026-09-04
---

# Open questions — i18n

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | `client.go` / `client.ts` headers still say "NOT a shared package — every service vendors a copy", contradicting the README + actual wiring (`go.work` / tarball). Fix the comments. | no | ASSUMED(2026-09-04): README is authoritative; comments are stale | -> edit the client files |
| 2026-09-04 | `locale-service` has no auth and is on the private network only. If a future consumer is outside that network, what protects it? | no | ASSUMED(2026-09-04): stays private-network only | -> security/threat-model.md |
| 2026-09-04 | `codegen/{ts,go}` (typed keys from a reference language) — is it part of any build, or optional/manual? | closed | **Closed 2026-09-11 by F-080** — it reads `locales/` from disk, its output is committed, and CI gates freshness (ADR-0036, `contract.md` "Generated key constants") | -> done |
