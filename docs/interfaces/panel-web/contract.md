---
id: panel-web
layer: interface
status: active
version: 10
updated: 2026-09-10
---

# Contract — panel-web

A browser-facing Next.js app. It has no outbound API of its own beyond a few
route handlers that serve i18n. Screens/components live under
`site-pwa/src/app`.

## TL;DR

The browser calls `auth-service` directly and cross-origin, at the public
`NEXT_PUBLIC_API_ORIGIN` (`https://api.<domain>`) — there is no auth proxy hop
through this app. This is deliberate: an earlier same-origin proxy
(`site-pwa/src/app/api/auth/[...path]/route.ts`) traded reliability
(server-to-server, private network only) for the browser's cookie never being
storable cross-origin without `credentials: "include"` on every call, which is
what the direct-call approach fixes; the accepted cost is the public
DNS+Traefik+TLS round trip on every auth call (~0.5-2s, previously the source
of an intermittent 502 — see `dev-docker/docker-compose.main.yml`, `site-pwa`
service comment). `auth-service`'s CORS (`main.ts`) allows
`FRONTEND_ORIGIN=https://panel.<domain>` with `credentials: true`. Server
components still read translations from `locale-service` via the shared Node
client (server-side only, `serverExternalPackages`). Access token is held in
memory client-side (`lib/auth-api.ts`); the refresh token is the httpOnly
cookie set by `auth-service` with `Domain=.<DOMAIN_NAME>` and `path=/`, so it is
sent to this app's server too — which is what lets `src/proxy.ts` answer "is this
visitor signed in?" without any client-side probe (see the auth-screen guard
below).

## Route handlers (server)

| Method + path | Behaviour |
|---|---|
| `GET /api/i18n/[lang]/[ns]` | serves a namespace tree from the in-process locale store (boots + Watch) |
| `GET /api/i18n/meta` | available locales + metadata |
| `GET /api/i18n/version` | current locale snapshot version (for client cache-busting) |

## Strings (F-052)

No module here spells a user-facing sentence: `useLocale().t(ns, key)` is the
only source, and a miss renders the raw key — visible, never one fixed
language. Helpers included — `util/helper.ts`'s `zodErrorToString` takes `t`
and resolves every issue message in the `validations` namespace, so a schema
reads `z.string().min(3, "fields.username.tooShort")`. A message that is not a
key survives unchanged, so an un-keyed schema still renders.

## Which language a visitor gets (F-068)

`getUserLocale()` (`services/locale.ts`) decides, and the order is fixed:

| # | Source | Why it ranks here |
|---|---|---|
| 1 | the signed-in account's saved language | the person said so, and said it durably |
| 2 | the `NEXT_LOCALE` cookie | the person said so on this device |
| 3 | `DEFAULT_LANGUAGE` (`DEFAULT_LOCALE` in `src/env.ts`) | the deployment says so |

**There is no fourth row, and `Accept-Language` is not one of them.** The
browser header is a guess about the visitor; `DEFAULT_LANGUAGE` is a statement
about the deployment, and a reseller selling in Persian is not overruled by a
browser that happens to be installed in English. This is the panel's half of the
rule `bot-app` already follows for `ChatLanguage` (F-046, ADR-0016), where the
messenger's language hint sits below `DEFAULT_LANGUAGE` for the same reason.

Rank 1 answers only for a visitor who is actually signed in. `getCurrentUserId()`
(`services/user-locale-mock.ts`) returns `null` until the real session exists —
it used to return a fixed id for everyone, with that id seeded to `en`, which
made rank 1 match every anonymous visitor and swallow the two rows beneath it.
A mock that claims a user is the one way this table can be correct and the
panel still wrong, so check it before re-reading anything below.


The panel still sends its resolved `lang` as `Accept-Language` to `auth-api`
(F-053, `contract.errors.md`) — that is this rule reaching the backend, not an
exception to it.

`DEFAULT_LOCALE` is read from the environment, not written in the source. It
takes `NEXT_PUBLIC_DEFAULT_LANGUAGE` first, then `DEFAULT_LANGUAGE`, then `fa`.
Both names carry the same value, set once as `DEFAULT_LANGUAGE` in `.env` and
mapped to both in `docker-compose.main.yml`; the `NEXT_PUBLIC_` one exists
because `src/env.ts` is reachable from a `"use client"` component
(`PhoneField` -> `lib/phone`, which opens the country picker on the region the
deployment's language implies) and Next inlines only `NEXT_PUBLIC_` variables
into the browser bundle. Setting only the bare name leaves the client half on
`fa` while the server half is correct.

## Screens

`/(auth)/auth/*` — login, register, forgot-password. `/` — the panel home (which
account this browser is, plus the group). `/accounts/add` — adding an account
to the switch group, its two tabs being the two proofs `auth-api` accepts.

The account-creation screen is `/auth/register`. It was `/auth/signup` until
2026-09-07, and it is the only place the platform ever called it that —
`auth-api` serves `POST /auth/register`, the bot runs `RegisterFlow`, coinsite
routes `/(Auth)/register`. `src/proxy.ts` answers the old path with a **308** to
the new one, preserving the path suffix and the query string, because links to
it exist outside this repo. Both paths are written once, as `AUTH_LOGIN` /
`AUTH_REGISTER` in `src/lib/routes.ts`.

### The phone field (ADR-0018)

Every screen that asks for a phone number renders `PhoneField`, never a plain
input: a country selector plus the national number, submitting **E.164** —
which is what `auth-api` takes and stores. Countries come from
`libphonenumber-js` (all of them), are named through `Intl.DisplayNames` in
the panel's active language and flagged from the ISO code, so no country list
or flag asset is shipped or translated by hand.

The picker opens on the country the **deployment's** default language implies
(`fa` → `IR`, `en` → `US`), not the browser's, so a Persian install does not
make its users find Iran in a list of two hundred — while a reseller anywhere
else is still one selection away.
`NEXT_PUBLIC_DEFAULT_PHONE_COUNTRY` overrides that per install.

## Client API surface

`lib/auth-api.ts` `authApi.*` — `loginPassword`, `otpChannels`,
`requestLoginOtp`, `verifyLoginOtp`, `register`, `verifyPhone`, `forgot`,
`verifyForgot`, `reset`, `botLinkStatus`, `refresh`, `ensureSession`, `logout`,
`captchaChallenge`, `captchaVerify`, `listAccounts`, `addAccountOtpRequest`,
`addAccountOtpVerify`, `addAccountPassword`, `switchAccount`. All call
`${NEXT_PUBLIC_API_ORIGIN}/api/*` (cross-origin) with `credentials: "include"`;
on success the access token is stored in a module variable.

`loginPassword`, `requestLoginOtp`, `register` and `forgot` each take a
trailing `captchaToken`, sent as `X-Captcha-Token` — see auth-api's F-0201.
The `useCaptcha()` hook (`_hooks/useCaptcha.ts`) drives the
`NatureCaptchaUI` widget on the login/register/forgot-password screens: it
requests a challenge on mount, exchanges a completed slide for a pass via
`captchaVerify`, and re-requests a challenge when that pass's 120s TTL
elapses or a gated call is rejected.

## Failures the user can read (F-063)

`auth-api` answers already translated. What this panel sends, throws and shows:
[contract.errors.md](contract.errors.md).

## OTP delivery method and messenger linking (F-0202, F-0203)

Which delivery methods exist is the **server's** answer, not this app's:
`useOtpChannels()` calls `GET /auth/otp/channels` and `OtpChannelPicker`
renders exactly what comes back (nothing, when there is only one). Never
hard-code sms/telegram/bale — a deployment can run with SMS switched off.

`requestLoginOtp` and `forgot` can answer `linkRequired: true` with a bot deep
link instead of sending a code. That is not an error: the chosen messenger is
not connected to the account yet. The screen shows `BotLinkStep`, the user
shares their contact with the bot, and `useBotLink()` polls
`POST /auth/bots/link/status` every 2.5s until `state: "linked"` — at which
point the code has already been sent *by the bot*, and the flow continues on
the code step. A client that treats `linkRequired` as "code sent" leaves the
user waiting for a code that will never arrive.

One-time codes are `OTP_LENGTH` (6) digits — `lib/otp.ts`. The API validates
that exact length, so the input must not use another.

## The panel's own session, and the account switcher (F-0206…F-0209)

The access token lives in a module variable, so a page load starts with none —
but the httpOnly refresh cookie is still there. `PanelSessionProvider`
(`app/(panel)/_context/PanelSessionContext.tsx`) sits in the `(panel)` layout
and turns one into the other, then reads `GET /auth/accounts`.

`authApi.ensureSession()` does that **once per page load**, and the "once"
is load-bearing: `refresh` rotates the token, so two concurrent calls race and
the loser is handed a token that no longer resolves to a session. React Strict
Mode alone produces that pair. A single cached promise is the whole mechanism.

No live session sends the visitor to `AUTH_LOGIN`. That is the mirror of the
auth-screen guard below: one keeps a signed-in visitor off the login screen,
the other keeps a signed-out one off the panel.

A switch (`authApi.switchAccount`) ends in a **full** `window.location`
navigation, never `router.push`. Everything this app has already fetched
belongs to the account being left, and the session it was fetched with is
revoked server-side by that same call — throwing the page away is the only
honest way to change who the tab is. `src/proxy.ts` needed no change for any of
this: a switch never visits an auth screen, so it was never an F-0101
collision.

Phone numbers arrive already masked from `GET /auth/accounts`; this app never
receives the full number of a group member and must not try to render one.

### The group belongs to this browser (ADR-0015)

The set the switcher shows is **this browser's**, not the user's everywhere:
the server partitions it by a `device_id` httpOnly cookie it mints itself. Three
things follow for this app:

- **It never sees or sends the scope.** The cookie is httpOnly and rides along
  because every call sets `credentials: "include"` (`lib/auth-api.ts`). Dropping
  that would send account calls with no scope at all, and every one would be
  refused — so it is not a detail to tidy away.
- **A different browser, or a cleared cookie, is a different place** and starts
  with an empty group. That is the intended reading, not a bug to report: the
  accounts are untouched and the set is rebuilt one click at a time.
- **Removing an account (`F-0208`) removes it here only.** The switcher's remove
  control asks inline before acting; removing the *current* account revokes this
  browser's own session, so that path does a full `window.location` reload
  rather than `reload()`ing the group — the token this tab holds is already
  dead. Removing anyone else leaves the session alone and just re-reads.

## The same panel, inside a messenger (F-310, ADR-0017)

The Mini App **is** this app — no separate build, route or layout — and the
whole per-platform surface is `lib/mini-app.ts`. `PanelSessionProvider` trades
the host's signed `initData` for the ordinary session, but only after the
refresh cookie has failed. The behaviour, the two refusals and why `initData`
is passed verbatim are in [contract.mini-app.md](contract.mini-app.md).

## Auth-screen session guard (F-0101)

A signed-in visitor is never shown the login or register screen; the check runs
server-side in `src/proxy.ts` before the screen renders. The whole rule — what
is asked, why it is not `/auth/refresh`, how it fails, and how the panel names
its tenant on the internal hop — is in
[contract.session-guard.md](contract.session-guard.md). It moved out of this
file at 250 lines (§10).

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| auth-api | every auth action, direct cross-origin call, incl. the captcha challenge/verify pair | auth screens error; SSR pages still render |
| i18n | translations (server-side gRPC client, `scope=frontend`) | boot blocks then fails fast (SSR i18n unavailable) |

## Config

`NEXT_PUBLIC_API_ORIGIN`, `AUTH_SERVICE_ORIGIN` (server-side only, see the
auth-screen guard below), `LOCALE_SERVICE_ADDR`, `LOCALE_SCOPE=frontend`,
`DEFAULT_LANGUAGE` + `NEXT_PUBLIC_DEFAULT_LANGUAGE` (both from the one `.env`
value; `DEFAULT_LOCALE` in `src/env.ts` reads them — see the language section
above), `NEXT_PUBLIC_DEFAULT_PHONE_COUNTRY` (optional, see the
phone field above), cookies `NEXT_LOCALE` / `NEXT_THEME`. Themes:
`light` / `dark` / `ocean`.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `src/app/api/auth/[...path]/route.ts`, `src/app/api/auth/register/route.ts` (same-origin proxy) | 2026-09-05 | removed | direct cross-origin call to `auth-service`, see TL;DR above |
| 5-digit OTP input | 2026-09-05 | removed | `OTP_LENGTH` (6) from `lib/otp.ts` — the API always required 6 |
| forgot-password ending on `/auth/login` | 2026-09-05 | removed | `auth-api` v5 returns a session with the reset, so the flow ends on `PANEL_HOME` |
