---
id: identity
layer: domain
updated: 2026-09-06
---

# Business rules — identity

Internal logic. Outside consumers read contract.md.

## Session state machine

`created` -> `active` -> `revoked`. Revoke reasons: `user_logout`,
`password_change`, `admin_ban`, `expired`, `impersonation_ended`. `refresh`
performs `revoke(old, user_logout)` + `create(new)` atomically (token rotation).

## Rules
| # | Rule | Trigger | Exception |
|---|---|---|---|
| 1 | OTP channel resolution: explicit request channel -> user `preferredOtpChannel` (only if still available) -> the first available channel in `OTP_ALLOWED_CHANNELS` order | any OTP issue | an explicitly named channel is never swapped: if it is off, the request is refused (`otp.channelNotAllowed` / `otp.channelNotConfigured`) rather than silently redirected. No channel available at all -> `otp.noChannelAvailable` |
| 2 | `bale` / `telegram` need a `linked_bot_account` whose `contactVerifiedAt` is set; without one the answer is a bot deep link (`auth.botLinkRequired`), not a code and not another channel | OTP issue on those channels | the link is offered for any phone number, account or not — branching on existence would make it an enumeration oracle |
| 9 | A shared contact links the chat only if `contact.user_id === message.from.id` **and** its phone (normalized) equals the number the link was issued for | bot webhook, contact message | mismatch replies in-chat and marks the link `failed`; the token stays usable so the user can retry |
| 10 | After a successful link the pending record's `purpose` decides what happens next: `login` / `password_reset` send the code immediately from the bot; `account_link` sends nothing | bot webhook, link completed | an OTP cooldown at that moment leaves the link intact and sends no code — the user re-requests from the site |
| 3 | Identifier type: parses as a real, SMS-reachable number in any country -> phone (normalized to E.164, ADR-0018), else username | password login | input with any non-dial character is a username, or the library would read `09121234567abc` as a phone |
| 4 | Strong password must not contain username / full name / phone fragments | register, reset | `password.containsProfileData` |
| 5 | Default tenant/role on register: `Tenant.slug = 'platform_owner'`, `Role.name = 'user'` | register | `register.defaultRoleMissing` if seed absent |
| 8 | Duplicate username/phone at register is checked live against `user` (best-effort, since no row is reserved yet) and answered with `register.duplicateUser`; the Postgres unique constraint is the final guard when verify-phone promotes the pending record | register, verify phone (register) | a same-second race can still surface `register.duplicateUser` at verify time instead of register time. Unlike rule 2, this branch **does** reveal whether a phone is registered — an accepted trade-off, see "Register reveals that a phone is already taken" below |
| 6 | Impersonation session lifetime is 30 min and cannot perform `SensitiveActionGuard` actions | impersonated request | — |
| 7 | Access-token `permissions[]` is a snapshot from `role_permission` at sign time | token issue | stale until token expires |
| 11 | Failed password logins are counted 10 per 900s in a bucket keyed on the normalized identifier (`login-failures:<username\|E.164>`), reset on a correct password | password login | the counter is consumed before the password is checked, so the 11th attempt in a window is locked even if its password is right |
| 13 | A `linked_bot_account` with `contactVerifiedAt` set authenticates its user directly: `bots/session` issues the ordinary token pair, no OTP (ADR-0012). Allowed for the `user` role only (`BOT_SESSION_ROLES`) | bot sign-in | an **allow-list**: Support/Admin/SuperAdmin and any role added later are refused with `auth.botFactorNotAllowed` until deliberately admitted. Account conditions answer exactly as password login does — deleted/inactive -> `auth.invalidCredentials`, unverified phone -> `auth.phoneVerificationRequired` |
| 14 | A contact card sent *with* a `bots/session` request links the chat on the spot: same proof as rule 9 (`contact.user_id === message.from.id`), but the account is found **by the card's own phone number** rather than one typed beforehand | bot sign-in, no link yet | this is the only link not anchored to a phone the caller named first — the card carries a number the platform vouches for. No account on that number -> `otp.botLink.noAccount`, which reveals nothing: the sender has just proven the number is theirs |
| 12 | Order of answers on password login: account missing/deleted/inactive -> `auth.invalidCredentials`; lock -> `auth.temporarilyLocked`; wrong password -> `auth.invalidCredentials`; only then unverified phone -> `auth.phoneVerificationRequired` | password login | the unverified-phone key is deliberately last: answered earlier it tells an anonymous caller the account exists (invariant #6) |

## Edge cases decided
| Case | Decision | Date |
|---|---|---|
| OTP verify with both `phoneNumber` and `otpToken` | reject (schema `.refine`) | 2026-09-04 (observed) |
| Refresh token missing on logout | return `{success:true}` (idempotent) | 2026-09-04 (observed) |
| Login OTP request for unknown/inactive phone | still return `{accepted:true}`, send nothing | 2026-09-04 (observed) |
| Two link requests for the same (platform, phone) inside the TTL | hand back the same token and deep link; a second link would orphan the one already open in the messenger | 2026-09-05 (decided) |
| Bot webhook called with a wrong/absent secret | 404, identical to an unknown route — a URL that answers differently can be probed | 2026-09-05 (decided) |
| A chat that asks for its code *in the messenger it is already talking to* | superseded by ADR-0012 — the code was re-delivering a proof already held, and the option's label lied whenever the typed phone belonged to a different chat. `bots/session` signs the chat in instead; the bot no longer offers it. The mechanism (`link/resolve` + `link/contact` in place) stays for the panel-driven flow | 2026-09-06 (decided), revised 2026-09-06 (ADR-0012) |
| Bot-originated auth calls and the slide captcha | waived for a caller proving `SERVICE_AUTH_TOKEN`, because a chat cannot drag a slider. The per-chat rate-limit bucket and the OTP cooldown carry that load instead (ADR-0011) | 2026-09-06 (decided, owner) |
| A verified contact whose phone has no account | reply "no account is registered with this number" and link nothing; the sender has already proven the number is theirs, so this reveals nothing new to them | 2026-09-05 (decided) |
| Register re-submitted for a phone with a still-pending (unverified) registration | overwrite the pending Redis record + issue a fresh OTP; the previous attempt's data/OTP become invalid | 2026-09-04 (decided) |
| Register reveals that a phone is already taken (`register.duplicateUser`), while login OTP deliberately does not (rule 2) | keep it. `POST /auth/register` is behind `@RequireCaptcha()` and 10/hour/IP, so this is a one-number-at-a-time lookup, not bulk enumeration, and telling a returning user "you already have an account" is worth more than closing it. Do **not** "fix" this to match rule 2 without the owner's call — the uniform-response version needs a notification to the real owner, equal argon2 timing on both branches, and a per-phone rate limit, or it trades an oracle for an OTP-spam vector | 2026-09-05 (decided, owner) |
| Pending registration's Redis key expires (600s) before verify-phone | `register.pending.expired`; user must register again from step 1 | 2026-09-04 (decided) |
| A real but phone-unverified account tries to log in | answer `auth.invalidCredentials` until the password is proven, then `auth.phoneVerificationRequired`. The account still cannot log in (invariant #6); moving the key behind the password check costs a returning user nothing and closes an oracle that needed no credentials at all | 2026-09-05 (decided) |
| The impersonated session's row vs. its audit row | one transaction, on the caller's `tx` (`SessionService.createSession({ tx })`). The Redis liveness marker is written afterwards via the returned `activateCache`, never before the commit — invariant #8 says Postgres is the record, so a marker for an uncommitted row must not exist | 2026-09-05 (decided) |
| Ending an impersonation | the Postgres revocation rides in the same transaction as the audit row; afterwards only `SessionStore.drop` runs. Going back through `SessionService.revokeSession` would rewrite `revokedAt` a second time, outside that transaction | 2026-09-05 (decided) |
