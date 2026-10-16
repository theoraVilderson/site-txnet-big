---
id: adr-0145
status: active
updated: 2026-10-16
---

# ADR 0145 — The holder of `*` signs in with two factors

- **Status:** accepted (built by SA-1-b)
- **Date:** 2026-10-14
- **Decision:** the user's (2026-10-14, the recommended option: password and code only)
- **Affects units:** identity, panel-web
- **Builds on:** ADR-0144 (two system roles), SA-1-a (few holders of `*`)

## Context

`*` is everything on the platform: whoever holds it is the platform. A second
step after the password exists (`requiresOtp`, `otp_login` token), but only
when `user.twoFactorEnabled`, and nothing ever sets it. Besides, a session is
minted by several doors that prove one factor: a code alone (`login/otp`),
the end of a password reset, a handoff from the platform to a reseller's
domain (ADR-0059), an account switch or a logout's fallback within a switch
group (F-0207, ADR-0035), and the messenger (ADR-0012). The messenger already
refuses every role but `user` (`BOT_SESSION_ROLES`).

## Decision

1. **A holder of `*` signs in only with the password and then a code.** The
   password step always asks the code for them, whatever `twoFactorEnabled`
   says; the code reaches their verified number as for anyone else. With no
   number to send it to, the sign-in is refused `auth.secondFactorUnavailable`
   (an operator adds one); it is never opened on the password alone.
2. **Every one-factor door refuses them**: a code alone answers
   `auth.ownerNeedsBothFactors` after the code is checked (so the answer tells
   nothing to someone without it); a handoff and an explicit switch into such
   an account answer the same; a logout or a leave never falls back onto one.
   The messenger keeps its own, wider refusal. A browser holding other
   accounts reaches them by the **two-factor switch** (2026-10-14, SA-1-c):
   their password, then a code, at the moment of the switch — never a click.
3. **A password reset ends signed out** for them: every session is revoked as
   for anyone, and no new one is opened; the panel goes to the sign-in page.
4. **One question, asked where a session is minted.** "Does this person hold
   `*`" is read from their whole answer (`AccessReader`), never from a role
   name, so it holds however `*` came to them.
5. Refreshing an existing session is not a sign-in and is unchanged; nor is
   impersonation, which never reaches a holder of `*` (AC-1-h).

6. **Amended 2026-10-16 (the user's, the recommended option).** (a) The code
   after the password goes by the channel the person picks — SMS, Telegram or
   Bale, whichever the deployment offers — exactly as on the phone login,
   including the bot-link step for a messenger not yet connected (SA-1-d).
   (b) Inside the Mini App, an account the messenger alone may not sign in
   (`BOT_SESSION_ROLES`) is asked its password, and the platform's signed
   `initData` is the second factor: possession of the contact-verified
   messenger account, the same thing a code sent to that messenger proves
   (SA-1-e). The chat route is unchanged: it carries no password.

## Consequences

- The platform's owner cannot be signed in by a stolen phone code, a stolen
  messenger account or a handoff link alone.
- Accepted cost: the owner does not enter the panel from the bot chat or a
  handoff (the Mini App asks the password, (6b)); they sign in on the panel with both factors. A holder with no
  phone number cannot sign in at all until one is added (on dev:
  `platform_owner` and `e2e_admin`).

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Let the messenger alone sign them in | a stolen messenger account would then be the whole platform; with the password beside it (6b) it is one of two |
| Turn `twoFactorEnabled` on for the holders | a flag can be turned off again, and it does not close the other doors |

## Revisit trigger

An authenticator app or a passkey as a factor: it would replace the SMS code here.
