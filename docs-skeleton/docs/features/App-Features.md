---
id: app-features
status: active
version: 1
updated: YYYY-MM-DD
---

# <Product> — Feature Catalog

> One paragraph: what this product is, for whom, and the one thing that makes it
> different. Keep it under six lines.
>
> Assumption of this document: it describes the **target state**. What is
> actually built lives in `docs/BACKLOG.md`, never here.

This file is written to `docs/FEATURES-FORMAT.md`. Do not restructure it.
Validate every edit with `python3 tools/features-scan.py --check`.

**This file is a template.** Replace the example sections below with your real
catalog. Keep the shape exactly.

## Status vocabulary

| status | meaning |
|---|---|
| `core` | specified in an earlier version of this catalog, unchanged |
| `new` | added in this version |
| `changed` | a previous decision was reversed — cites a `C-nn` |
| `partial` | infrastructure exists, no surface for it yet |
| `later` | designed, schema reserved, deliberately not built now |

## Decisions

Top-level rules. Where anything below contradicts one of these, the decision
wins. Keep this list short — five to ten. If everything is a decision, nothing is.

| id | decision | why |
|---|---|---|
| D-01 | _example: the platform never holds an end user's money_ | _removes payment-facilitator obligations and a whole tier of legal exposure_ |

## Constraints

Conflicts that were found and resolved. Each row records what disagreed and what
was chosen, so nobody re-litigates it in six months.

| id | conflict | resolution |
|---|---|---|
| C-01 | _example: §2 gave every plan a subdomain, D-01 forbids it_ | _subdomains removed entirely; a verified custom domain is required on every plan_ |

## Invariants

Things that must never happen. These migrate verbatim into each unit's
`invariants.md`, where they outrank every contract. Worth more than the feature
rows — extract them explicitly.

| id | invariant | blast radius if broken |
|---|---|---|
| INV-01 | _example: ledger entries sum to zero per transaction, enforced by a DB trigger_ | _silent money loss, unrecoverable after the fact_ |

---

## Section 01 — <Area name>

One or two paragraphs on how this area works. Prose explains **how**; the table
declares **what gets built**. Both are required — a capability that appears only
in prose will never reach the backlog.

### 1.1 <Sub-area>

The addressable unit. `python3 tools/spec.py F-0101` prints this whole block, so
keep it under ~120 lines and under ~15 feature rows.

Owned state goes in a fenced block, one entity per line:

```
ExampleEntity(id, tenantId, status, createdAt)
    status: pending | active | retired
```

| id | feature | status | depends_on | note |
|---|---|---|---|---|
| F-0101 | _one capability, shippable in a single sitting_ | new | — | _why it exists; the sharp edge; INV-01_ |
| F-0102 | _the next one_ | new | F-0101 | _cites C-01_ |

### 1.2 <Another sub-area>

| id | feature | status | depends_on | note |
|---|---|---|---|---|
| F-0103 | _..._ | later | — | _schema reserved, not built now_ |

---

## Section 02 — <Next area>

### 2.1 <Sub-area>

| id | feature | status | depends_on | note |
|---|---|---|---|---|
| F-0201 | _..._ | new | F-0101 | _..._ |
