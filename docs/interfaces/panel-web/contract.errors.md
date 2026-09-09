---
id: panel-web
layer: interface
status: active
version: 7
updated: 2026-09-08
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
- **A caught error is displayed, never only logged.** `useSubmitError` +
  `<FormError>` is that surface: `role="alert"`, cleared per attempt, field
  errors under the message, the `ref` shown so a user can quote it.

No message `auth-api` owns is copied here. The one string of the panel's own is
`common.errors.unreachable`, for when nothing came back to show.
