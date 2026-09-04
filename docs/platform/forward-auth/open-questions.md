---
id: forward-auth
layer: platform
updated: 2026-09-04
---

# Open questions — forward-auth

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | `permissions.yaml` roles (`admin` / `support` / `user`) are separate from the `identity.role` table AND from the impersonation rank map. Three sources of role truth. Reconcile? | no | ASSUMED(2026-09-04): the YAML is defence-in-depth only; the token's `permissions[]` is authoritative | -> ADR / rules |
| 2026-09-04 | Only `billing-service` is actually put behind `my-auth` in compose. Which routers should carry it as more services appear? | no | ASSUMED(2026-09-04): every non-public upstream except `auth-service` itself | -> operations |
| 2026-09-04 | The JWT parser is hand-rolled in Go with no `nbf`/`iss`/`aud` checks. Add them? | no | ASSUMED(2026-09-04): single internal issuer, not needed yet | -> ADR-0004 revisit |
