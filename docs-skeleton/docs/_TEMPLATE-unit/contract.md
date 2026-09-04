---
id: <same-id>
status: draft
version: 1
updated: YYYY-MM-DD
---

# <Unit> — contract

What the outside world may rely on. Max 250 lines; past that, split the unit.

Changing anything here is governed by §8 of `00-PROTOCOL.md`: additive and
optional is a patch; removing, renaming, or changing the meaning of anything is
**breaking** and requires a version bump plus the consumer list, said out loud
before you apply it.

## Responsibility
One paragraph. What this owns, and explicitly what it does not.

## API
| operation | input | output | errors |
|---|---|---|---|

## Events published
| event | payload | when |
|---|---|---|

## What this unit does NOT do
The most useful section in the file. List the things people will assume it does.
