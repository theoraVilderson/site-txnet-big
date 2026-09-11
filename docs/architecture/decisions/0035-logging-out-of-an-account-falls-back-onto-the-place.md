---
id: adr-0035
status: accepted
updated: 2026-09-10
---

# ADR 0035 — logging out of an account falls back onto the place

- **Status:** accepted
- **Date:** 2026-09-10
- **Affects units:** identity, auth-api, panel-web, bot-app
- **Amends:** [ADR-0033](0033-signing-out-ends-the-place-not-the-token-that-asked.md)
- **Builds on:** [ADR-0034](0034-a-switch-moves-the-place-and-the-place-remembers-it.md)

## Context

ADR-0033 made a logout end the *place* rather than the one token that asked,
which was right and is unchanged. It left one question unanswered: what happens
when the place holds **more than one account**?

It signed out of all of them. Sign in as your own account, add a second, sign
out of the first — and the second went with it, even though nothing about it
was being left. The user asked for the other reading: fall back onto the
account that is still there.

**The objection, raised and overruled.** A logout that leaves you signed in as
somebody else can be a security-shaped surprise: the reason people reach for
that button is often "I am handing this device over", and answering it by
staying signed in fails open. That objection is the reason `logout/all` exists
in this ADR — the intention is real, it just is not the same intention.

**Why the fallback itself grants nothing.** Being signed in as A already
carried the right to become B with no credential: that is what a switch group
*is* (`F-0207`, "no credential in the body — that is the point of the group").
So the fallback performs a switch the user could have performed by hand a
moment earlier. It moves no authority; it only decides where the place lands.

## Decision

**1. `POST /auth/logout` falls back onto the group.**

Revoke the outgoing account's sessions in this scope (ADR-0033, unchanged), then
— if this place holds another member — mint a session for that member, record
it as what the place is acting as (ADR-0034), and answer with `switchedTo` plus
that account's tokens. The refresh cookie is replaced rather than cleared.

**The fallback is the oldest remaining member.** Deterministic on purpose: a
group of three must not sign out into a different account depending on row
order, and in a bot chat the oldest member is normally the account the chat was
linked with — the place's home.

A member that would be refused a session anyway (deleted, suspended) is skipped,
not refused. Nobody left to land on is an ordinary full logout, and so is an
account that holds no group here.

**The fallback may never fail the logout.** The revoke has already happened by
then, so a failure to come back up as someone else is logged and answered as an
ordinary logout. "You are signed out" is true and complete on its own; a 500
would say nothing at all.

**2. `POST /auth/logout/all` is a separate route (`F-0211`).**

Signs out of every account this place holds and clears `actingAsUserId`, so the
next implicit sign-in does not come back up as whoever the place was last
acting as. It signs out; it does not un-prove — the membership rows stand, and
taking an account out of the place is still `F-0208`.

**3. Every surface places it deliberately.**

Never the button beside the ordinary sign-out. In `panel-web` it is the last
row of the account switcher, behind its own inline confirmation. In the bot it
is on the accounts screen, and the tap that opens the question is not the tap
that answers it — the confirming button carries its own action id, so a stale
tap on a previous screen can never be read as a yes.

## Consequences

- **"Log out" now means "log out of this account".** Which is what it says.
  Ending the place is `logout/all`, one deliberate step away.
- **The response shape of `/auth/logout` grew.** `{success:true}` still comes
  back; `switchedTo` and a token pair are added when a fallback happened. Both
  consumers read it: `panel-web` stays on the panel and reloads the group
  instead of routing to the login screen, `bot-app` keeps the handed-back
  refresh token instead of dropping its Redis entry. A consumer that ignores
  the new fields signs the user out locally while the server keeps the session
  — degraded, not broken, and both were updated in the same change.
- **In a chat this is less of a change than it looks.** ADR-0012 makes the
  messenger account itself a credential, so a chat was always one tap from
  signing back in and switching. The fallback removes a tap; it does not open
  a door.
- **In a browser it is a real change**, and the honest description of it is:
  after this, signing out of one account on a shared browser leaves the next
  account signed in. That is why the deliberate route exists, why the panel
  puts it behind a confirmation, and why the confirmation says what it does.
- **`logout/all` does not unlink the chat.** Whoever holds the Telegram account
  can still sign in again and reach the group. Closing *that* needs the link
  revoked as well, which is a bigger action than this one and is not built.

## Alternatives considered

- **Keep ADR-0033's behaviour.** Safer default, and the recommendation that was
  made. Overruled by the user, whose reading — "the second account was not the
  one I left" — is a coherent and common one.
- **Fall back onto the most recently used account.** Friendlier in a group of
  three, and it makes the destination depend on history the user cannot see.
  Oldest-member is explainable in one sentence.
- **One route with a flag** (`logout?all=true`). One button away from the wrong
  outcome, and a flag is exactly the thing a mis-tap sets. Two intentions, two
  routes.
- **Have `logout/all` also dissolve the group.** Tempting for the
  handing-the-device-over case, and wrong: it would silently discard proof the
  user spent OTPs on. `F-0208` removes a member because someone meant to.
