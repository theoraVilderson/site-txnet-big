---
id: support
layer: domain
status: draft
updated: 2026-09-04
---

# Invariants — support

**DRAFT** — extracted from schema comments; none are enforced in code yet.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | `chat_message` is append-only and monthly-partitioned; a partition is archived to object storage before it is dropped | planned service layer / schema | see contract | 
| 2 | `senderType` (`user` / `admin`) is set on every message and never changed | planned service layer / schema | see contract | 
| 3 | A closed ticket keeps its full message history (no cascade delete) | planned service layer / schema | see contract | 

## How to test

To be written when a service exists.
