---
id: auth-api
layer: interface
status: active
version: 56
updated: 2026-10-26
---

# Contract — auth-api / a fresh install owner's first sign-in

A topic file of [contract.md](contract.md) (§10), opened because that file is
at its 250-line cap. The wire shapes of `/api/auth/owner-setup` (F-0102). Who
is asked and why is
[identity/contract.owner-setup.md](../../domains/identity/contract.owner-setup.md);
this file is shapes, codes and limits.

Field schema lives in code: `ownerSetupCodeSchema` and `ownerSetupSchema` in
`txnet-backend/auth-service/src/app/auth/owner-setup/owner-setup.schema.ts`
(username and code from `registerSchema` / `verifyPhoneSchema`, password from
`strongPasswordSchema`).

## Routes

Both are tenant capability `signIn`, refuse a live session like every login
route (F-0101), and are not captcha-gated: the `setupToken` a gated password
step answered is the proof.

| Method + path | Request | Response | Rate limit | Idempotency |
|---|---|---|---|---|
| POST `/auth/owner-setup/code` | `{setupToken, phoneNumber, channel?}`, strict | **202** `{phoneNumber, requiresPhoneVerification:true, deliveryId, channel, channelToken}` (`auth.ownerSetupCodeSent`), or the bot-link answer of `register` (`auth.botLinkRequired`). `auth.invalidSetupToken`: another step's token, an expired one, or setup already done. `auth.ownerSetupPhoneTaken`: another account of the tenant holds the number | `LOGIN_OTP_REQUEST` | repeatable — each send under the OTP service's own limits |
| POST `/auth/owner-setup` | `{setupToken, username, newPassword, phoneNumber, otpCode}`, strict | 200 tokens + refresh cookie (`auth.ownerSetupDone`), as `login/password`. `otp.invalid`; `password.containsProfileData` (checked before the code); `auth.ownerSetupTaken` (username or number held, the write lost a race); `auth.invalidSetupToken` | `LOGIN_OTP_VERIFY` | once — a second completion answers `auth.invalidSetupToken` and opens nothing |

The setup token is `purpose: owner_setup`, `OWNER_SETUP_TOKEN_TTL_SEC` (900s
default), with no `sessionId`: `forward-auth` and `AuthGuard` admit it nowhere.
