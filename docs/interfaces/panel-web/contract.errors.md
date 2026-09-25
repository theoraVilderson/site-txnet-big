---
id: panel-web
layer: interface
status: active
version: 30
updated: 2026-09-25
---

# Contract — panel-web: failures the user can read (F-063)

Split out of [contract.md](contract.md) (§10). `auth-api` translates before it
answers, so a failed call's `msg` and each `fieldErrors[].message` are sentences
in the user's language, not keys. Three rules follow.


- **The language on the wire is this panel's, not the browser's.** `auth-api`
  reads `Accept-Language`, which a browser fills with the *OS* language, so a
  Persian panel on an en-US machine got English errors. `LocaleProvider`
  mirrors the store's `lang` into `lib/api-language.ts`, beside where it
  already sets `document.documentElement.lang`.
- **One failure shape.** `request()` throws `ApiError` (`lib/api-error.ts`) and
  nothing else. The three answers carrying no translated text — `fetch` threw,
  a failure body with no envelope, one with no `msg` — are flagged
  `unreachable` and their `message` is a log line, never shown.
  `useApiErrorMessage()` is the only thing that chooses between the two.
- **A refusal with a `reason` and no `i18nKey` gets its own sentence here.**
  A service that names a machine-readable cause but no key (settlement's
  `SettlementRefused`, by design) reaches the panel with `message` already
  replaced by the generic `system.conflict` / `system.notFound`, so every one
  of its refusals reads the same. The page holding that surface keeps a
  `Record` over the service's union and picks the key from `ApiError.reason`
  before falling back to `useApiErrorMessage()` — `coupons/_lib/coupon-form.ts`
  `refusalKey`, `gateways/_lib/grants.ts` `grantRefusalKey` (F-096-f). A
  reason the service adds does not compile, and a test reads the service's own
  union for the case where both sides forgot.
- **A refusal's figures are `ApiError.facts`** — the envelope's `error.facts`,
  flat scalars beside a `reason` (shared-core `sanitizeError`). Read one only
  by the `reason` it came with: billing's `insufficient_balance` carries
  `missing` (`shop/_lib/shop.ts` `shortfallOf`, F-111-e). `{}` when none came.
- **A caught error is displayed, never only logged.** `useSubmitError` +
  `<FormError>` is that surface: `role="alert"`, cleared per attempt, field
  errors under the message, the `ref` shown so a user can quote it.

No message `auth-api` owns is copied here. The one string of the panel's own is
`common.errors.unreachable`, for when nothing came back to show.
