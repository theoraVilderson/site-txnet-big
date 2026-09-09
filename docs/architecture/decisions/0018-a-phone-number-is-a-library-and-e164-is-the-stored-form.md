---
id: adr-0018
status: accepted
updated: 2026-09-08
---

# ADR 0018 — a phone number is a library, and E.164 is the stored form

- **Status:** accepted
- **Date:** 2026-09-08
- **Affects units:** identity, auth-api, panel-web, bot-app, redis-keyspace

## Context

Phone handling was one regex, `^(?:\+98|0098|0)9\d{9}$`, and two functions
named after one country. Everything downstream inherited that shape: the
canonical stored form was the Iranian national `09xxxxxxxxx`, the
phone-vs-username decision was "does it match the Iranian regex", and the
messenger contact check had a second, independently written copy of the same
rule.

This is a white-label reseller platform. A reseller outside Iran could not
have signed a single user up, and nothing in the code said so out loud — a
non-Iranian number was reported to the user as an invalid *format*.

Two things force the stored form to change at the same time as the validator,
rather than after it:

- `user.phoneNumber` is `@unique` across the whole table. National formats
  collide between countries — Germany's `015112345678` and a national number
  elsewhere with the same digits are one row. Two different real people would
  be conflated, or the second refused, and neither failure is visible as a
  phone problem.
- The number is a **component of six Redis keys** (`otp:code:*`, `otp:lock:*`,
  `otp:cooldown:*`, `register:pending:*`, `botlink:phone:*`,
  `botlink:proven:*`). A key built from an ambiguous form is an OTP delivered
  against the wrong account's rate limit.

## Decision

**Validation and normalization are `libphonenumber-js`, over every country it
knows.** No regex, no per-country branch, one module:
`auth-service/src/app/common/validation/phone.schema.ts`.

**The canonical stored form is E.164** — `+989123456789`. It is what
`user.phoneNumber`, `otp_code.phoneNumber` and
`linked_bot_account.phoneNumber` hold, what every Redis key component is built
from, and what `phoneSchema` returns from the wire.

**A number must be able to receive an OTP.** `MOBILE` and
`FIXED_LINE_OR_MOBILE` are accepted; a number the plan classifies as a fixed
line is refused, because an SMS code cannot reach it. `FIXED_LINE_OR_MOBILE`
is accepted rather than refused because several numbering plans do not
separate the two at all, and refusing those would lock out whole regions.

**The default region comes from the deployment's language.**
`DEFAULT_PHONE_COUNTRY` wins if set; otherwise `DEFAULT_LANGUAGE` is mapped
through a small explicit table (`fa` → `IR`, `en` → `US`). A language is not a
country, so an unmapped language yields **no** default region and a number then
has to carry its own `+`. Guessing a region from an unmapped language is how a
German user's number silently becomes an Iranian one.

**`SUPPORTED_PHONE_COUNTRIES` is optional and empty by default**, meaning every
country. It exists so a deployment can narrow, never so it has to widen.

## Consequences

- **The keyspace is abandoned at cutover.** `REDIS_KEYSPACE_VERSION` goes
  `v1` → `v2` (ADR-0005, C-03). In-flight OTPs, pending registrations and
  bot-link tokens keyed by `09…` become unreachable — they would otherwise be
  live keys nobody can address. Every session is logged out by the same bump.
  This is the announced consequence of the cutover, not a side effect.
- **A data migration rewrites the two phone columns.** `prisma/migrations/`
  starts here (this answers the identity half of `D-5`; the partitioning and
  RLS SQL of F-041 remains open). Existing `09…` rows become `+98…`.
- **`detectIdentifierType` widens.** Anything the library parses into a real,
  reachable number is a phone; everything else is a username. Input containing
  characters that are not dial characters is rejected before the library sees
  it — the library will happily read `09121234567abc` as a number by
  discarding the tail, which for an identifier field would turn a username
  into someone else's phone number.
- **The password-profile rule expands.** "Your password must not contain your
  phone number" is a substring check, and a user types the national form while
  the platform stores E.164. It now checks every spelling of the number
  (`phoneVariants`), or it would hold for one form and silently not for the
  others.
- **The panel picks a country like Telegram does.** The phone field is a
  country selector plus a national number, preselected from the deployment
  language, and it submits E.164. A user never has to know what the server
  considers canonical.

## Alternatives considered

**A hand-written country descriptor table** (the original plan for F-056: one
row per country, IR the only entry). Rejected on the user's decision to
support every country: a table is a promise to maintain the numbering plans of
the world by hand, and the first wrong row is a real person who cannot sign up
and a support ticket nobody can reproduce. The library is 200 countries of
that work, already done and versioned.

**Keeping the national form and adding a country column.** Two columns that
must agree, a compound unique constraint, and every Redis key needing both
parts. E.164 is exactly that pair, in one string, in a form the rest of the
world already agreed on.

**Validating loosely and storing whatever arrived.** Cheapest, and it moves the
collision from signup — where it is one clear error message — to the OTP
keyspace, where it is an intermittent delivery bug against another account's
rate limit.
