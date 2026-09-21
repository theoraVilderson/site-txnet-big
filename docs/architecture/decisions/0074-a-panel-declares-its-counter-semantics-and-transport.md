---
id: adr-0074
status: active
updated: 2026-09-21
---

# ADR 0074 — a panel declares its counter semantics and transport

- **Status:** accepted
- **Date:** 2026-09-21
- **Affects units:** network, billing

## Context

We sell over six unrelated families of management system. They disagree about
the two things that matter most to a usage pipeline.

**How usage is counted.** The Xray panels keep a **cumulative** per-client
counter that rises and occasionally resets. Anything speaking RADIUS reports
**sessions** with their own ids and high-water marks. A few Xray statistics
configurations are **zeroed by the act of reading them**. The delta arithmetic
is different for each, and getting it wrong is not a visible failure — it is a
wrong number that looks plausible.

**Who starts the conversation.** We poll the Xray panels and Mikrotik over
HTTP. IBSng, Cloudius and Mikrotik UserManager push RADIUS accounting packets
at us instead.

Without a declaration, each family becomes its own pipeline, and the parts that
must be identical — deduplication, the plausibility cap, hold handling, the
ceiling — get six implementations that drift.

The differences are not cosmetic. Session counters are **structurally immune to
the backup-restore catastrophe**: restored sessions carry ids we have already
closed, so they are not re-counted, where a cumulative counter reads a restore
as thousands of simultaneous resets. And RADIUS carries a trap of its own —
`Acct-Input-Octets` is 32 bits and wraps at 4 GB, with the high bits in
`Acct-Input-Gigawords`, so a NAS that omits Gigawords loses every 4 GB in
silence.

## Decision

Every panel **declares** `counterSemantics` (`cumulative | session |
reset_on_read`) and `transport` (`pull | push`), plus a `capabilities`
document answering a fixed acceptance questionnaire. These are stored on the
`Panel` row and **change system behaviour**, not just documentation.

One normaliser turns all three counter types and both transports into **one
delta stream**. Past that point nothing — deduplication, plausibility, holds,
quarantine, the cursor, the ceiling — knows which family a byte came from.

Three rules ride on the declaration:

- **A counter going backward is a reset, never negative usage.** A negative
  delta is never published, stored or deducted.
- **`reset_on_read` may not be chosen when an alternative exists.** If the
  publish after the read fails, those bytes are gone permanently; a source
  restricted to it is marked low-trust and its loss window is bounded to one
  interval.
- **A declared incapacity holds bytes rather than guessing at them.** A NAS
  without Gigawords holds sessions past 4 GB. A session with no `Stop` closes at
  its last observed figure and is never extrapolated past it.

The questionnaire is answered by a **connection test at registration**, not by
hand, and a panel that fails a load-bearing row is refused there — before it
has users on it, rather than at billing time.

## Consequences

- Positive: six families become one pipeline with three small arithmetic
  variants. The expensive shared logic is written and proved once.
- Positive: the acceptance questionnaire turns "this panel is a bad fit" from a
  discovery into a registration-time refusal.
- Positive: the declaration makes a real procurement fact legible — session
  panels survive a backup restore and cumulative panels do not, which belongs in
  the decision of what to run.
- Negative / accepted cost: a wrong declaration is a **silent** wrong number,
  not a crash. This is why the fake driver and the conformance suite come before
  any real driver: every declaration is exercised against a source that can
  reset, stall, wrap at 32 bits, omit Gigawords and drop a `Stop`.
- Negative / accepted cost: `capabilities` is a JSON document, so its shape is
  not enforced by the database. It is validated on write and versioned.
- What this forecloses: a driver quietly special-casing itself downstream of the
  normaliser. Anything a family needs is a declared capability or it does not
  exist.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Infer the semantics from observed behaviour | the inference is only available after a reset has been seen, which is after the first wrong charge. A counter that has not moved backward yet is indistinguishable from one that never will |
| One driver interface, cumulative only, RADIUS adapted to look cumulative | it throws away the one property that makes session counters better — restored sessions are re-counted again, which is the single most expensive failure in the whole area |
| A separate pipeline per family | six implementations of deduplication, the plausibility cap, holds and the ceiling. They would drift, and the drift would show up as money |
| Capabilities as documentation only | a capability that does not change behaviour is a comment. The Gigawords row has to be able to hold bytes, not just warn |

## Revisit trigger

A family arriving that fits none of the three counter types or neither
transport — a push feed that is neither RADIUS nor a session model, or a panel
exposing only aggregate usage with no per-client figure. The latter is already
refused at registration; if it becomes commercially necessary, the refusal is
the decision to reopen.
