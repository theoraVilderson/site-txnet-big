---
id: auth-api
layer: interface
updated: 2026-09-05
---

# Open questions — auth-api

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | `/admin/*` (impersonation) is served by `auth-service` itself, not behind `forward-auth`. Is a separate admin-api surface planned? | no | ASSUMED(2026-09-04): stays in auth-service, guarded by `AuthGuard` + `PermissionsGuard` | -> new interface unit if it grows |
| 2026-09-04 | `/i18n/:lang/:ns` duplicates what `site-pwa` also exposes at `/api/i18n/*`. Two i18n read paths for the frontend — intended? | no | ASSUMED(2026-09-04): backend endpoint is for backend-scope consumers, frontend uses its own | -> platform/i18n contract |
| 2026-09-04 | `billing-service` will sit behind `forward-auth` with no documented API. Add a `billing-api` interface when it exists. | no | ASSUMED(2026-09-04): yes, later | -> new unit |
| 2026-09-05 | Build tooling (`webpack.config.js`, `txnet-backend/scripts/dev-serve.js`) isn't in this unit's `source:` — it's not business/HTTP logic, and `docs/operations/environments.md` now documents it instead (`dev-serve.js` is generic across Nx apps, not auth-service-specific). `tools/drift.py` will keep flagging both as orphans; that's expected. | no | ASSUMED(2026-09-05): operations docs, not a unit, is the right home | -> a build-tooling platform unit if this ever needs a `source:` |
| 2026-09-05 | `NoActiveSessionGuard` (409 on register/login while a live session exists) was built with no catalog id — `SURFACES.md` records its `spec ref` as `—` and there is no backlog row. Is it covered by an existing feature in §2.1 Registration and Login / §2.4 Sessions and Tokens, or is it a new capability? | resolved | RESOLVED(2026-09-05): not in the catalog — user confirmed. MODE: EXTEND added **F-0101** to §2.1 Registration and Login, backlog row `F-0101` (done), `SURFACES.md` spec ref filled | -> — |
| 2026-09-05 | **Drift, §0(1) vs §0(4).** `contract.md` said the `refresh_token` cookie was scoped `path=/api/auth`, and `panel-web/contract.md` said "scoped to `api.<domain>` (no `Domain` attribute)", while `auth.controller.ts` `cookieOptions()` sets `path: '/'` and `domain: .${DOMAIN_NAME}`. Which side is wrong? | resolved | RESOLVED(2026-09-05): the **code** is right — user chose `path: '/'` + `domain: .${DOMAIN_NAME}`. Both contracts rewritten to match, with the reason recorded: the cookie has to reach `panel.<domain>` for F-0101's server-side auth-screen check. Cookie stays httpOnly | -> an ADR only if the scope is ever narrowed |
| 2026-09-05 | `contract.md` claimed `/api` was "the ingress route, not a Nest global prefix", but `main.ts:51` sets `app.setGlobalPrefix('api')` and no Traefik router strips it. Should the prefix move to the ingress? | resolved | RESOLVED(2026-09-05): no — user confirmed `setGlobalPrefix('api')` stays. Only the false sentence in `contract.md` was corrected; no code or Traefik label changed. In-network callers must include `/api` (`panel-web`'s proxy does) | -> — |
