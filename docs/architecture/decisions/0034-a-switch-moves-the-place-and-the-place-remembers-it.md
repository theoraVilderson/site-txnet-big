---
id: adr-0034
status: accepted
updated: 2026-09-10
---

# ADR 0034 — a switch moves the place, and the place remembers it

- **Status:** accepted
- **Date:** 2026-09-10
- **Affects units:** identity, audit, auth-api, bot-app, panel-web
- **Amends:** [ADR-0014](0014-switching-accounts-in-the-bot-moves-the-session-not-the-link.md)
- **Builds on:** [ADR-0032](0032-a-session-carries-its-switch-scope-and-the-mini-app-inherits-the-chats.md), [ADR-0033](0033-signing-out-ends-the-place-not-the-token-that-asked.md)

## Context

Switch accounts in the bot and the Mini App stays on the old one; switch in the
Mini App and the chat stays on the old one. Observed directly: one scope
(`bot:telegram:1117815196`) holding a live chat session for account A and a
live Mini App session for account B.

`switchTo` revoked the caller's session and minted one for the target. That was
right when a place held one session. Since ADR-0032 a place holds two — the
chat's and the Mini App's, both under one `scopeKey` — and moving one says
nothing about the other.

**Revoking the sibling session is not the fix on its own**, and this is the
part that makes the problem an ADR rather than a patch. The surface that loses
its session signs itself back in implicitly: the Mini App against its
`initData`, the chat against its `LinkedBotAccount`. ADR-0014 decided —
correctly, and for reasons that still hold — that a switch **moves the session
and leaves the link alone**, because relaxing the link's uniqueness would turn
the phone→chat lookup on the OTP delivery path into one with several answers.
So the re-signed surface lands on the *linked* account: the one the user just
switched away from. It would not follow the switch; it would snap back, which
is a third state rather than a fix.

ADR-0014 recorded that as an accepted cost — "after `/logout`, the chat's
one-tap sign-in returns to the linked account, not the one the user last
switched to" — and rejected the remedy: a per-chat "acting as" pointer, on the
grounds that it would be *"a second identity concept, owned by `bot-app`, that
no other surface has"*.

That objection was right in September 6th's world and is not right now.
ADR-0015 and ADR-0032 made the **scope** a first-class thing that every surface
shares, and `LinkedAccountGroup` is already the per-scope set of accounts. A
pointer there is not a bot concept; it is the group's own answer to "which of
us is this place currently".

ADR-0014's revisit trigger names this: reopen if the post-sign-out tap turns
out to be a real cost. It did, on the first day the Mini App and the chat were
one place.

## Decision

**1. `LinkedAccountGroup` gains `actingAsUserId`.**

A group belongs to exactly one scope (that is its own stated invariant), so
this is the place's answer to "who am I here". Nullable: `null` means "never
switched", which is exactly ADR-0014's behaviour, so nothing is backfilled.

**2. A switch writes it, and sweeps the outgoing account's other sessions in
that scope.**

Both halves in `switchTo`, **after the replacement session is minted, and
best-effort**. The revoke is what makes the other surface ask again; the
pointer is what makes it come back as the right account instead of the linked
one.

The ordering is load-bearing and was learned the hard way on the day this
shipped. By the time these two run, the caller's old session is already revoked
and the only copy of its replacement is in the response on its way to a cookie
or the chat's Redis entry. Running them first — or letting them throw — returns
a 500, strands those tokens and signs the user out of **every** account with
nothing to come back to. A stale Prisma client did exactly that. So they run
last, inside a `try`, and a failure is logged rather than raised: the cost of
that failure is the other surface staying on the outgoing account, which is the
behaviour that predates this ADR.

**3. Only an *implicit* sign-in reads it.**

`/auth/bots/session` and `/auth/bots/webapp/session` — the two where the
messenger link is the credential (ADR-0012) and the caller names no account.
A password login names its account and is never redirected; a Mini App
signature says *which messenger account* is looking, not which platform account
to become.

Three conditions before a pointer is honoured, because each is a way it could
otherwise become an authentication of its own: the linked account must still
hold a group **in this scope**; the pointer must name someone still in that
same group here; and the target must pass every condition an ordinary bot
sign-in applies (active, phone-verified, on the role allow-list). Any of them
failing falls back to the linked account — never an error, because "this place
has not switched" and "sign in as the linked account" are one answer.

**The link is still not touched.** `LinkedBotAccount` stays one row per chat,
invariant #12 stands, and the OTP delivery lookup still has one answer. This
ADR sits on top of ADR-0014's decision rather than reversing it.

## Consequences

- **A switch in the Mini App is followed by the chat, and vice versa.** Which
  was the report.
- **Asymmetric cost, and it is worth naming.** The Mini App re-signs itself
  silently, so a switch made in the chat shows up there with no interaction. A
  switch made in the Mini App costs the chat one tap: its session is gone, so
  `/start` shows the guest menu and the one-tap sign-in then lands on the
  switched-to account. Signing back in automatically is not available — the bot
  cannot tell a session revoked by a switch from one revoked by a logout, and
  guessing would undo ADR-0033.
- **ADR-0014's accepted cost is closed.** After a logout, the next sign-in
  returns to the account the place was acting as, not to the linked one. The
  pointer deliberately survives a logout: it describes the place, not the
  session.
- **A stale pointer is inert.** `F-0208` removes a membership row and leaves
  the pointer; the membership check is what makes that safe. Nothing cleans it
  up, and nothing needs to.
- **The browser is unaffected in practice.** A `device:` scope's sign-ins are
  all explicit — a password or an OTP names the account — so nothing there
  reads the pointer, even though the column exists for every group.
- **Moving the place is best-effort; the switch itself is not.** They are not
  in one transaction, and making them one would mean threading a transaction
  through `switchSession`. The asymmetry is deliberate: a switch that half
  happened must always leave the caller holding a working session.
- **A place is now a stronger thing than it was.** Whoever can open the chat
  can reach whatever account that chat last switched to, until it is switched
  back or removed from the group. That is the same authority the chat already
  had over its group (a switch has never needed a credential, `F-0207`), now
  persisted rather than held in a session.

## Alternatives considered

- **Revoke the sibling session and stop there.** Cheap and no migration. The
  other surface signs itself back in as the *linked* account, so a switch turns
  into a flip to a third account. Worse than the bug.
- **Relax `LinkedBotAccount`'s uniqueness so a chat links to every member.**
  ADR-0014 already rejected this and the reason is unchanged: the OTP phone→chat
  lookup stops having one answer.
- **Put the pointer on the session.** It is a session that a switch replaces,
  so a pointer there would die with the thing it is meant to outlive.
- **Leave it.** Recorded as an option, because "each surface has its own
  session" is defensible. Rejected by the user: two surfaces the product calls
  one place must not disagree about who is signed in.
