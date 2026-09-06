---
id: adr-0012
status: accepted
updated: 2026-09-06
---

# ADR 0012 — a contact-verified messenger link is an authentication factor

- **Status:** accepted
- **Date:** 2026-09-06
- **Affects units:** identity, auth-api, bot-app

## Context

`F-303` shipped login inside the bot by reusing the panel's flow: pick a
channel, receive a one-time code, type it back. On the channel screen the bot
offers the messenger the user is *already talking to* — "here, in this chat" —
and that option is what exposed the problem.

Ask what the code proves in that case. To deliver a code into a Telegram chat
at all, `identity` must already hold a `LinkedBotAccount` for that user with
`contactVerifiedAt` set. That row was created by a contact card the platform
itself issued, checked against `contact.user_id === message.from.id` plus a
phone match (invariant #12). At that moment the system knows who controls the
number. It then writes a six-digit code into the chat and waits for the same
person to copy it out of one message and into the next.

The code carries nothing. It is the same proof, re-delivered through a weaker
channel, in a loop that begins and ends in the same window.

Worse, the option's *name* is wrong in the case where a code would matter.
`telegram.sender.resolveChatId` sends to the chat linked to **the phone number
that was typed**, not to the chat that asked. Type someone else's number and
the code goes to them — correctly — while the button the user pressed said
"here, in this chat" and nothing ever arrives. One label, two opposite
behaviours.

A contact card is not a weaker proof than an SMS code, either. It is stronger:
it is the platform's own assertion about an account it authenticated, and it
cannot be obtained by swapping a SIM or intercepting SS7.

## Decision

**A `LinkedBotAccount` with `contactVerifiedAt` set is a credential, not a step
towards one.** `identity` exposes `POST /auth/bots/session` (service credential
only): a chat holding such a link is handed the ordinary token pair — same
session row, same rotation, same revocation as a password login.

Three consequences:

1. **A chat with no link may present a contact card with the request** and be
   linked on the spot. Every other link is anchored to a phone number typed
   beforehand; this one is not, because the card *carries* the number. The
   ownership proof is unchanged — the card must describe the person who sent
   it — only which end is known first: there a phone looking for its chat, here
   a chat presenting its phone.
2. **The bot's login opens with this path.** One tap, or one tap plus the
   contact card. The channel/OTP conversation stays exactly as it was and is
   what a chat falls back to, so nothing is lost for a user signing into an
   account this chat does not belong to.
3. **The "here, in this chat" label is deleted** — not reworded. Every channel
   is now named after itself, because the code goes to whichever chat owns the
   *typed* number, and that is only this chat by coincidence. The channel stays:
   a second account of your own, linked to another chat on this same platform,
   is a real destination. What disappears is the claim that the code is
   arriving in front of you.

### Scope — the part that is a trade, not a deduction

This factor signs in the **`user` role and nothing else**
(`BOT_SESSION_ROLES`). "Whoever holds this person's Telegram holds their
account" is the same bargain as "sign in with Google" and is an acceptable one
for a customer. It is not acceptable for Support, Admin, SuperAdmin, or the
reseller roles `tenant` will add — those can act on other people's money, and
they fall through to the ordinary paths.

It is an **allow-list**, so a role invented after this file was written is
refused until someone deliberately admits it. The opposite polarity would make
every future privileged role insecure by omission.

Sensitive operations are unaffected: a password reset still requires its own
proof, and `SensitiveActionGuard` still governs actions, independently of how a
session was created.

## Consequences

- Login in the bot goes from six exchanges to one or two, and the confusing
  option disappears rather than being explained.
- `identity` gains one route and one rule; the bot gains no rule at all
  (ADR-0009 holds: it still decides nothing).
- Register in the bot is **unchanged** by this ADR. No `user` row exists until
  the phone OTP is verified (invariant #11), so registration still needs its
  code. Only signing in does not.
- A user whose messenger account is taken over loses their panel account. That
  is the trade named above, bounded by the role allow-list.
- `auth.botFactorNotAllowed` is a new answer a privileged account can receive
  in the bot; it must not be phrased so as to confirm the account's role to an
  anonymous caller — it is only ever returned after the caller has proven they
  control the number.

## Alternatives rejected

- **Reword "here, in this chat".** Treats a modelling error as a copy problem.
  The round trip would remain, and so would the second behaviour hiding under
  the same button.
- **Let the bot skip the code itself.** Forbidden by ADR-0009 and wrong on the
  merits: the rule about what proves an identity belongs to `identity`, once.
- **Have `link/contact` return tokens.** Overloads a route whose job is
  linking, and would sign users in as a side effect of a panel-driven flow that
  is watching `link/status` for something else entirely.
