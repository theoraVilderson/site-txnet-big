---
id: features-manifest
status: generated
---

# Feature catalog manifest — GENERATED, do not hand-edit

Rebuild: `python3 tools/features-scan.py`

- catalog files: 1
- addressable blocks: 9
- features: 4

**Never read the catalog directly.** `python3 tools/spec.py <F-id>` prints exactly the block you need.

## Blocks

| block | lines | features | D/C/INV | entities |
|---|---|---|---|---|
| `App-Features.md:22-31` Status vocabulary | 10 |  |  |  |
| `App-Features.md:32-40` Decisions | 9 |  | D-01 |  |
| `App-Features.md:41-49` Constraints | 9 |  | C-01 D-01 |  |
| `App-Features.md:50-61` Invariants | 12 |  | INV-01 |  |
| `App-Features.md:62-67` <Area name> | 6 |  |  |  |
| `App-Features.md:68-84` · 1.1 <Sub-area> | 17 | F-0101 F-0102 |  | ExampleEntity |
| `App-Features.md:85-92` · 1.2 <Another sub-area> | 8 | F-0103 |  |  |
| `App-Features.md:93-94` <Next area> | 2 |  |  |  |
| `App-Features.md:95-99` · 2.1 <Sub-area> | 5 | F-0201 |  |  |

## Feature index

| id | feature | status | block |
|---|---|---|---|
| F-0101 | _one capability, shippable in a single sitting_ | new | 1.1 <Sub-area> |
| F-0102 | _the next one_ | new | 1.1 <Sub-area> |
| F-0103 | _..._ | later | 1.2 <Another sub-area> |
| F-0201 | _..._ | new | 2.1 <Sub-area> |
