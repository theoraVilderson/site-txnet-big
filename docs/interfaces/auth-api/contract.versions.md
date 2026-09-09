---
id: auth-api
layer: interface
status: active
version: 11
updated: 2026-09-09
---

# auth-api — version history

What each version of [contract.md](contract.md) changed, which consumers it
affected, and why. Split out of `contract.md` at 250 lines (§10) — the current
shapes live there, and this file answers "when did that change, and what broke".

Newest first is *not* the order here: the sections are kept as they were
written, and `version` in the front matter above says where the contract is now.

## v6 — a service credential, and the webhook moves out

Additive for every existing client. New: `X-Service-Token` (see Conventions),
`POST /auth/bots/link/resolve` and `POST /auth/bots/link/contact`. Changed: on
the rate-limited routes the bucket is the **acting subject** — the chat for a
service call, the IP for everyone else (`common/security/service-caller.ts`).
Deprecated: this service's bot webhook, above.

The captcha waiver is the part to be careful with. `SERVICE_AUTH_TOKEN` is a
bearer secret for a *process*: leaking it buys an attacker the ability to call
`register` / `login/otp/request` / `password/forgot` without solving a slide,
and the per-chat + per-phone limits (and the OTP cooldown) are then the only
thing between them and OTP flooding. Rotate it like a database password, and
never set it in an environment that does not run `bot-service`.

## Breaking: v5 — `password/reset` returns a session

`POST /auth/password/reset` now answers with `{success:true, accessToken,
expiresIn}` and sets the `refresh_token` cookie, where it previously returned
`{success:true}` alone. The revocation is unchanged and still total — the
returned session is created after it. **Affected consumer:** `panel-web`,
updated in the same change. Additive for any client that ignores the new
fields.

## Breaking: v7 — the switch group is scoped to the surface (ADR-0015)

Every `/auth/accounts/*` route changes meaning: it now reads the group
belonging to the calling browser or chat instead of one global group per
person. A client that sends no `device_id` cookie (or a bot that omits
`x-bot-platform`) is refused rather than served a global group, so this is a
break, not an addition. Consumers from the reverse lookup: `panel-web` and
`bot-app` — both updated in the same change. `POST /auth/accounts/remove` is
new in the same version (F-0208).

No deprecation window: the old shape has no production client — there is no
production deployment and `prisma/migrations/` does not exist yet (D-5).

Additive since 2026-09-06: the five `/auth/accounts/*` routes (F-0205 through
F-0207 — the switch group). They take nothing away from any existing client;
`POST /auth/accounts/switch` is the only new route that sets the
`refresh_token` cookie, and it sets exactly the same cookie a login does
(`common/http/refresh-cookie.ts` is now the one definition, so a session minted
by a switch and one minted by a login cannot disagree about the cookie's
`domain` and leave two of them in the browser).

Additive since 2026-09-06: `GET /auth/session` (ADR-0013) — the read-only
"is this visitor signed in?" question. Nothing is taken away: `POST
/auth/refresh` keeps its meaning and its rotation. It exists because using
`refresh` as a probe revoked the session being asked about, and any caller that
dropped the rotated cookie silently signed the user out.

Additive since 2026-09-06: `POST /auth/bots/session` (ADR-0012) — signing in
as the messenger account itself. It takes nothing away: every OTP route keeps
its meaning, and a caller that does not use it sees no change.

## v9 — the Mini App signs itself in (`F-310`, ADR-0017)

Additive: `POST /auth/bots/webapp/session`. It introduces no new factor — it is
ADR-0012's credential presented by a browser instead of by `bot-service`, so
the role allow-list, the contact-verified requirement and every account
condition are the same rule, called from the same service.

Two things about it differ from its neighbours on that controller and are worth
reading before adding a third: it is **public**, because a webview can keep no
service token and the platform's signature is what authenticates it; and the
session it mints carries the **browser's** switch scope (`device_id`), not the
chat's, because the webview is the surface that will use it (ADR-0015). Its
rate-limit bucket is the IP for the same reason every public route's is — the
only chat id available before verification is one the caller chose.

Consumers from the reverse lookup: `panel-web` (calls it) and `bot-app` (offers
the button that opens the page). Both updated in the same change.

Also in v5, additive: `GET /auth/otp/channels`, `POST /auth/bots/link/status`,
`POST /auth/bots/:platform/webhook/:secret`, and the `linkRequired` variant of
the two OTP-request responses. A client that does not understand `linkRequired`
will show "code sent" for a code that is not coming, so treat adopting it as
required rather than optional for anything offering a messenger channel.

## Breaking: v3 — captcha now required on register/login/forgot

`register`, `login/password`, `login/otp/request` and `password/forgot` now
reject with `captcha.required` (400) if `X-Captcha-Token` is missing, expired,
or already spent. **Affected consumer:** `panel-web` — updated in the same
change (`lib/auth-api.ts` + the three auth pages now run `useCaptcha()` first).
Any other client of this API must adopt the challenge/verify flow before
calling these four routes.

## Breaking: v10 — `phoneNumber` is E.164, and every country is accepted

The canonical form of every `phoneNumber` field, in requests and responses,
is E.164 (`+989123456789`). It was the Iranian national `09xxxxxxxxx`, and a
non-Iranian number was rejected as an invalid *format*. Numbers from every
country the library knows are valid now; a number that cannot receive an SMS
is not. See ADR-0018 for why the stored form had to move at the same time as
the validator.

**Affected consumers:**

- **`panel-web`** — updated in the same change. Every phone input is now
  `PhoneField` (country selector + national number, submitting E.164), so the
  panel never shows or sends the old form.
- **`bot-app`** — reads and passes phone numbers through `auth-api` only, and
  the contact it reports is normalized by `auth-api` itself
  (`normalizeMessengerPhone`), so it needs no change. Its own `contract.md`
  says nothing about the format.
- **`forward-auth`** — does not see phone numbers at all (it validates JWT +
  session), so it is unaffected.

Input is unchanged for a user: any spelling still parses. What changed is what
comes back, and what a client should store or compare — a client that has
persisted `09…` values of its own must migrate them, exactly as
`20260908000100_phone_numbers_are_e164` does for this service.

## v11 — the internal bot-integration seam, and a webhook route removed

**Removed:** `POST /auth/bots/:platform/webhook/:secret`, deprecated since
2026-09-06 with nothing pointed at it. `bot-service` has owned the webhook
since ADR-0011, and F-066-i deleted the environment variable this route's
`:secret` was compared against, so it could no longer have answered.

**New:** seven routes under `/internal/bot-integrations/*`, all behind
`ServiceOnlyGuard` and all marked `@TenantAgnostic` — they exist so
`bot-service` can find out *which* tenant an inbound update belongs to, and a
route that answers that question cannot be required to have a tenant already.
No public client is affected: a caller without `SERVICE_AUTH_TOKEN` gets the
same 404 a nonexistent route gives.

Two of them return a plaintext credential, which is the part worth being
explicit about. F-323 says a bot token is never returned by any API; the reading
taken here is that F-323 governs the tenant and admin surfaces — the value must
never be readable by anyone who can see the panel — and that this seam is not
one of those. It is reachable only with `SERVICE_AUTH_TOKEN`, which already buys
its holder a captcha bypass and the rate-limit subject for every chat on the
platform, a strictly larger power than one tenant's bot token. Every call still
writes a vault audit row naming `bot-service` and the remote caller, so the
trail F-1215 exists for is unbroken. The alternative — routing every outbound
send through `auth-service` so no token ever crosses a process boundary — was
weighed and is a backlog row of its own, not a silent widening of this one.
