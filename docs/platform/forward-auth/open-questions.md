---
id: forward-auth
layer: platform
updated: 2026-09-11
---

# Open questions — forward-auth

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | `permissions.yaml` roles (`admin` / `support` / `user`) are separate from the `identity.role` table AND from the impersonation rank map. Three sources of role truth. Reconcile? | no | ASSUMED(2026-09-04): the YAML is defence-in-depth only; the token's `permissions[]` is authoritative | -> ADR / rules |
| 2026-09-04 | Only `billing-service` is actually put behind `my-auth` in compose. Which routers should carry it as more services appear? | no | ASSUMED(2026-09-04): every non-public upstream except `auth-service` itself | -> operations |
| 2026-09-04 | The JWT parser is hand-rolled in Go with no `nbf`/`iss`/`aud` checks. Add them? | no | ASSUMED(2026-09-04): single internal issuer, not needed yet | -> ADR-0004 revisit |
| 2026-09-11 | `site-pwa` spells `x-captcha-token` and the forwarded-host pair by hand and cannot import `shared-core` — it is not in the Nx workspace. C-04's check therefore skips it. Vendor a tarball as it already does for `@txnet/locale-client`, or leave it in review? | no | ASSUMED(2026-09-11): review, for now. Three literals in one app is below the cost of a second published artifact, and the panel is the one consumer a rename would break loudly rather than silently | -> ADR-0036 revisit, or a row of its own |
| 2026-09-11 | **The policy engine keys on `roleId`, but the token carries a UUID and `permissions.yaml` is keyed by role *name*.** `Engine.Check` looks `claims.RoleID` up in the file's role map; `TokenService` sets `roleId: user.roleId`, the database foreign key. An unknown role returns `ok=false`, so **every authenticated request through `my-auth` is answered 403**. Verified live 2026-09-11 against the running gateway: a token with a UUID `roleId` gets 403, the same token with `roleId: "admin"` gets 200. Nobody has hit it because `billing-service`, a scaffold, is the only router carrying `my-auth`. The moment a real service is put behind it, every request fails. Three possible fixes and they are not equivalent: put the role **name** in the token beside the id, key the YAML by role id, or drop the YAML defence-in-depth. | resolved 2026-09-11 | — | -> ADR-0037, F-090. The token carries `roleName` and the engine keys on it; the file is keyed by the seeded names |
| 2026-09-11 | `prisma/seed.js` creates `user`, `Support`, `Admin`, `SuperAdmin`; `permissions.yaml` declares `admin`, `support`, `user`. The casing disagrees for two of the three, and the seed has a fourth role the policy file has never heard of. Harmless only while the row above makes the lookup miss anyway. | resolved 2026-09-11 | — | -> ADR-0037, F-090. The file now uses the seed's spelling, `SuperAdmin` included, and `tools/contracts.py` checks every seeded role |
