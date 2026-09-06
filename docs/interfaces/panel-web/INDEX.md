---
id: panel-web
layer: interface
status: active
version: 4
keywords: [panel, site-pwa, user panel, captcha, bot check, forgot password, otp channel picker, bot link, telegram link, bale link, account switcher, switch account, multi account, add account, panel session]
source:
  - site-pwa/src/**
owns_tables: []
depends_on: [auth-api, i18n]
updated: 2026-09-06
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
| 2026-09-06 | Contract v3 -> **v4** (ADR-0015): the switcher's group is scoped to this browser via a server-minted httpOnly `device_id` cookie, and gains a remove control (F-0208). `credentials: "include"` is now load-bearing — it is how the scope reaches the server |
| 2026-09-06 | v4 (additive), F-0209: the panel knows who it is signed in as. `PanelSessionProvider` trades the refresh cookie for an access token **once** per page load (`authApi.ensureSession`; refresh rotates, so a second concurrent call signs the loser out) and reads `GET /auth/accounts`; no live session -> `replace` to the login screen. New: the nav's `AccountSwitcher`, `/accounts/add`, and a panel home that names the current account so a switch is visible. A switch ends in a full `window.location` navigation, not `router.push`. `src/proxy.ts` unchanged — a switch never visits an auth screen |
| 2026-09-05 | Forgot-password is now a real four-step flow (F-0202/0203/0204): the delivery method comes from `GET /auth/otp/channels` (`_hooks/useOtpChannels.ts` + `OtpChannelPicker`), an unlinked messenger inserts a "connect the bot" step that polls the link status (`_hooks/useBotLink.ts` + `BotLinkStep`), and a successful reset now lands on `PANEL_HOME` signed in, because `auth-api` v5 returns a session with the reset. Fix: the OTP input was 5 boxes against an API that has always required 6 digits — every code failed validation; both now read `OTP_LENGTH` from `lib/otp.ts`. |
| 2026-09-05 | F-0101 (panel half): a signed-in visitor is now redirected off the login/signup screens **server-side**, in `src/proxy.ts` (which stops being a no-op stub): no `refresh_token` cookie means straight through at no cost, a cookie means one server-to-server `POST /api/auth/refresh` at `AUTH_SERVICE_ORIGIN` before any HTML is sent — `ok` redirects to `PANEL_HOME`, anything else shows the form, and auth-service's `Set-Cookie` is forwarded either way so a dead token is cleared. Fails open to the form. Post-auth success also lands on `PANEL_HOME` (`/`, `lib/routes.ts`) — the old `router.push("/dashboard")` pointed at a route this app does not have. |
| 2026-09-05 | F-0201: added `useCaptcha()` hook; login/signup/forgot-password now get a server-issued token from `NatureCaptchaUI`'s slide and send it as `X-Captcha-Token` (auth-api v3 requires it). Also fixed `/api/auth/register`'s dedicated proxy to forward that header (it previously hard-coded only `content-type`). |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
