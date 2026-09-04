---
id: panel-web
layer: interface
updated: 2026-09-04
---

# Open questions — panel-web

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | `services/user-locale-mock.ts` mocks per-user saved locale. Real source is `identity.user.languagePreference` / a `governance` setting — wire which? | no | ASSUMED(2026-09-04): `identity.user.languagePreference` once an endpoint exists | -> auth-api / governance |
| 2026-09-04 | Access token kept in a module variable — lost on full reload; relies on silent `refresh`. Intended, or move to a more robust store? | no | ASSUMED(2026-09-04): intended; `refresh` on load restores it | -> rules doc |
| 2026-09-04 | Two i18n fetch paths exist (this app's `/api/i18n/*` and `auth-service` `/i18n/*`). Consolidate? | no | ASSUMED(2026-09-04): frontend uses its own, `scope=frontend` | -> platform/i18n |
