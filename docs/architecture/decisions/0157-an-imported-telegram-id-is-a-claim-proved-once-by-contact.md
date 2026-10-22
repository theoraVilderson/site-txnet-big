---
id: adr-0157
status: accepted
updated: 2026-10-22
---

# ADR 0157 — An imported Telegram id is a claim, proved once by the chat's contact card

- **Status:** accepted
- **Date:** 2026-10-22
- **Affects units:** identity, entitlement, network, billing

## Context
F-210: a reseller's old panel names each client's Telegram account (3x-ui's
`tgId`, a numeric Marzban note, a column of its balance file). Its customers
already use the reseller's bot, so the import should bring that link along.

But the bot signs a chat in only through a `linked_bot_account` with
`contactVerifiedAt` — the chat sent its own contact card (identity invariant
#12) — and only to a person with a verified phone. An imported person has
neither. The id is the reseller's data, often typed by hand: trusting it
outright would hand one customer's account to whichever chat a typo names,
and would put people with no phone into every path that assumes a bot user
has one.

## Decision
We will write the source's id as a **claim**: a `linked_bot_account` with
`claimedAt` set and `contactVerifiedAt` null, on the tenant's Telegram. A claim
carries nothing — no OTP, notice, campaign, sign-in or rollback hold — because
every reader already asks for `contactVerifiedAt`. The first time that chat
reaches the bot it is asked for its contact card, as today; when the card is
the sender's own (invariant #12) and its phone belongs to nobody in the tenant,
the claimed person takes that phone as verified, the link becomes proved, and
the chat is signed in. A claim never outranks a proof: a chat already linked
to someone else is reported (`taken`) and never moved, a person already
linked to another chat keeps it (`has_other`), and a proof for another person —
a contact whose phone is that person's, a registration, an OTP link — releases
the claim. A person who has a phone is never redeemed by a claim: the phone
already decides who they are. (User, 2026-10-22.)

## Consequences
- Positive: the customer taps one button; invariant #12 and the
  phone-verified gate stay whole; from that tap the person has a phone for
  OTP and recovery.
- Negative / accepted cost: a wrong id in the source lets the chat it names
  claim that person by sharing a phone nobody here holds. It is the
  reseller's own data and the reseller's own customers, as in its old bot.
- What this forecloses: signing a chat in by an imported id alone.

## Alternatives rejected
| Option | Why rejected |
|---|---|
| Trust the id outright (no card) | breaks invariant #12 and the phone gate; a typo signs a stranger in at once |
| Store it only, sign-in a later row | delivers nothing a customer sees until that row |

## Revisit trigger
A messenger whose sign-in carries no phone (a bot login widget), or a reseller
report of a claim taken by the wrong chat.
