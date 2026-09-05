---
id: panel-web
layer: interface
status: active
version: 2
keywords: [panel, site-pwa, user panel, captcha, bot check]
source:
  - site-pwa/src/**
owns_tables: []
depends_on: [auth-api, i18n]
updated: 2026-09-05
---

# panel-web

**Responsibility (one sentence):** the Next.js user panel (`site-pwa`) served at
`panel.<domain>` — auth screens (login / signup / OTP / forgot-password),
locale + theme handling, and a thin server-side proxy to the backend API.
**Explicitly NOT responsible for:** any business rule, auth decisions (delegated
to `auth-api`), translation content (`i18n`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | changing routes / the API proxy / i18n endpoints |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-04 | Documented from existing site-pwa during onboarding |
| 2026-09-04 | Signup page + `auth-api.ts` follow the `auth-api` v2 breaking change: verify-phone step now keys off `phoneNumber` instead of `userId` (identity no longer returns a `userId` from register — see `domains/identity` changelog) |
| 2026-09-05 | F-0201: added `useCaptcha()` hook; login/signup/forgot-password now get a server-issued token from `NatureCaptchaUI`'s slide and send it as `X-Captcha-Token` (auth-api v3 requires it). Also fixed `/api/auth/register`'s dedicated proxy to forward that header (it previously hard-coded only `content-type`). |
| 2026-09-05 | Fixed `NatureCaptchaUI` snapping the thumb back to start as the slide finished. Root cause: `complete()` could fire twice for one gesture (pointermove crossing the threshold, then the pointerup behind it), and auth-api burns a challenge on first `/verify`, so the second was rejected -> `useCaptcha` caught it, re-requested a challenge, and the reset effect slammed the thumb to 0. The guard is now `completedRef` (a ref — `isVerified`/`pending` are state and do not update within the tick, which is why guarding on them did not hold). Also: the completion check now runs on release too, so a fast drag whose last move event lands under 95% still completes, and `draggingRef` stops a plain hover or the pointerleave that follows pointerup from triggering a verify. |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
