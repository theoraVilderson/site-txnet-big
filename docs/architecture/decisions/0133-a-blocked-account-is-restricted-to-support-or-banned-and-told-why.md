---
id: adr-0133
status: active
updated: 2026-10-08
---

# ADR 0133 — a blocked account is either restricted to support or banned, and is told why

- **Status:** accepted (rows BAN-1-a..g)
- **Date:** 2026-10-08
- **Affects units:** identity, auth-api, forward-auth, panel-web, support, bot-app
- **Decision:** the user's, 2026-10-08 — every answer as recommended

## Context

The user (2026-10-08): "when a user is blocked there is no sign of it and no
way to learn why, or to talk to support so it does not become a problem; and
support must be able to block someone so that they can still message support,
or so that they are out for good — no sign-in, nothing."

What existed: a reseller's block (F-311-a) set `identity.user.status =
suspended` and revoked every session. Every sign-in path refused anything but
`active` with the same answer as a wrong password (`auth.invalidCredentials`,
`auth.invalidOtp`), so a blocked person could only conclude they had forgotten
their password. No reason was stored. `banned` was in the enum and nothing set
it. A support agent could not block anyone.

## Decision

1. **Two levels, one meaning each, platform-wide.**
   - `suspended` — **restricted.** The person signs in as before and sees one
     screen: that the account is restricted, the reason, and their own support
     conversations. Nothing else answers them. The reseller's existing block
     (F-311-a, F-311-c) *is* this level from now on.
   - `banned` — **banned.** No sign-in on any surface. The refusal says the
     account is banned and gives the reason.
2. **The reason is stored and shown verbatim.** `identity.user.statusReason`
   (written by staff, shown to the person) and `statusChangedAt`. Who did it
   stays in `admin_audit_log`, as for every staff act.
3. **A ban is only revealed after a proof.** `auth.accountBanned` is answered
   only once the password matched or the code verified — before that the
   answer is the ordinary `invalidCredentials` / `invalidOtp`, so a stranger
   trying numbers learns nothing (the existence oracle `completePasswordLogin`
   already guards). A login code *is* sent to a banned number for that reason.
4. **Restriction rides in the token and is enforced where tokens are
   checked.** An access token for a `suspended` user carries `restricted:
   true` and **no permissions** (its `permHash` stays the role's, so
   ADR-0043's staleness rule does not loop it). Then:
   - `auth-handler` admits a restricted token only on its allow-list —
     `/api/support/{categories,availability,conversations…}` and the realtime
     path. Everything else answers `403 auth.accountRestricted`
     (`reason: accountRestricted`).
   - `auth-service` is not behind the gate, so its `AuthGuard` applies the
     same rule: a restricted token reaches only handlers marked
     `@AllowRestricted()` — `me`, logout, the account switcher.
5. **Every status change revokes the person's sessions.** Restricting signs
   them out once and the next sign-in is restricted; lifting signs them out
   once and the next one is whole. One rule, instant in both directions, and
   no token outlives the decision.
6. **Two permission keys.** `restriction.assign` (catalog §3.2's own name,
   also planned by AC-1-e) restricts and lifts a restriction — granted to the
   `Support` template and `Admin`. `user.ban` bans and lifts a ban — `Admin`
   only; a tenant hands it to a senior agent by role. A ban closes the way
   back, so a new agent's mistake must not be able to make one.
7. **One route for staff.** `PUT /api/auth/users/:userId/status` `{status,
   reason}` in the caller's own tenant (RLS), asked of ADR-0103's authority
   rule so an agent cannot act on the owner or an admin, never on oneself.
   Lifting a ban needs `user.ban`; everything else about a restricted account
   needs `restriction.assign`.

## Consequences

- Positive: nobody is silently locked out; a restricted customer can still
  reach the tenant's support, which is the cheapest way to settle a dispute.
- Positive: the restriction is a server rule — a page that forgot to hide a
  button still gets `403`.
- Negative / accepted cost: a new user-facing route in auth-service must be
  marked `@AllowRestricted()` if a restricted person needs it. The default is
  refusal, so forgetting fails closed.
- Negative / accepted cost: the gate's allow-list names support-service paths;
  a renamed user route there must be renamed in the list too.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Keep the reseller's block as a full ban, add "restricted" for support only | two meanings for one word in code and in the panel; the reseller's customers would stay silently locked out |
| A Redis marker per restricted user, read by the gate | a cache that must be backfilled for every existing `suspended` user, and a missing key fails open |
| Hide the panel in the browser only | a page is not a boundary; every service would still answer |
| Say "banned" before the proof | a stranger could test any number and learn who is banned |
| One permission for both levels | any agent could close the way back for good |
