---
id: auth-api
layer: interface
updated: 2026-09-04
---

# Open questions — auth-api

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | `/admin/*` (impersonation) is served by `auth-service` itself, not behind `forward-auth`. Is a separate admin-api surface planned? | no | ASSUMED(2026-09-04): stays in auth-service, guarded by `AuthGuard` + `PermissionsGuard` | -> new interface unit if it grows |
| 2026-09-04 | `/i18n/:lang/:ns` duplicates what `site-pwa` also exposes at `/api/i18n/*`. Two i18n read paths for the frontend — intended? | no | ASSUMED(2026-09-04): backend endpoint is for backend-scope consumers, frontend uses its own | -> platform/i18n contract |
| 2026-09-04 | `billing-service` will sit behind `forward-auth` with no documented API. Add a `billing-api` interface when it exists. | no | ASSUMED(2026-09-04): yes, later | -> new unit |
